"""Study-scoped Cellpose permissions on generated, multichannel microscopy fixtures."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import sys
import tempfile
import tomllib
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from test_agent_policy import make_study
from test_research_agent_setup import interactive_request, nuclei_access_request
from test_research_cellpose import _request

from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.agent_cellpose import CELLPOSE_ACTIONS, require_retained_pins, require_scalar_plane
from loci_engine.agent_policy import _RUNTIME_KEYS, load_policy, write_policy
from loci_engine.cellpose_backend import CELLPOSE_MODEL_SHA256
from loci_engine.research_action_registry import READ_ACTIONS, REQUESTS, TASK_ACTIONS
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_mcp import PolicyAgent
from loci_engine.workbench import runtime_record


def grant_request(request, **updates):
    return nuclei_access_request(
        request,
        allow_nuclei_model=False,
        **{
            "allow_cellpose_model": True,
            "cellpose_measurement_channels": [0, 1],
            "permission_mode": "full_access",
            **updates,
        },
    )


@pytest.fixture
def pins(monkeypatch):
    from loci_engine import research_cellpose as native

    runtime = {key: runtime_record()[key] for key in _RUNTIME_KEYS}
    runtime.update(backend="cellpose-cpu:test", resolved_device="cpu")
    identities = ({"id": "cpsam_v2", "sha256": CELLPOSE_MODEL_SHA256}, runtime)
    monkeypatch.setattr(native, "installed_cellpose_pins", lambda: identities)
    return identities


def test_selected_measurement_grant_is_not_an_inference_grant(tmp_path, pins, monkeypatch):
    wb, source, recipe = make_study(tmp_path)
    bundle = tmp_path / "bundle"
    grant = grant_request(
        recipe, interactive=interactive_request(allow_image=True, channels=[0, 1])
    )
    receipt = create_agent_access(wb, grant, bundle)
    policy = load_policy(bundle / receipt["policy_filename"])
    agent = PolicyAgent(policy)
    scope = policy.sources[source["id"]]
    assert scope.c == (0, 1) and scope.measurement_channels == (0,)
    assert receipt["cellpose_model_sha256"] == CELLPOSE_MODEL_SHA256
    assert set(policy.actions) == CELLPOSE_ACTIONS | {"task_preview_get"}
    assert policy.model_packages == ((pins[0]["id"], CELLPOSE_MODEL_SHA256),)
    assert pins[1] in policy.runtimes
    assert "cellpose_run" not in REQUESTS
    assert "cellpose_model_status" in READ_ACTIONS
    assert {"cellpose_preview", "cellpose_adopt"} <= TASK_ACTIONS

    def unexpected_decode(*args, **kwargs):
        pytest.fail("Cellpose policy preflight decoded source pixels")

    monkeypatch.setattr(wb, "load_scalar", unexpected_decode)
    req = _request(source["id"])
    req["working_bytes"] = 4 * 1024**3
    assert authorize_action(agent, wb, "cellpose_preview", req, mode="task") == req
    assert (
        receipt["cellpose_scope"]
        == policy.cellpose_scope
        == agent.analysis_context()["cellpose_scope"]
    )
    status = inspect_action(agent, wb, "cellpose_model_status", {})
    assert status["profile_id"] == req["profile_id"]
    assert status["recommended_settings"]["device"] == "cpu"
    assert str(tmp_path) not in str(status)
    for selection in ({"c": 1}, {"t": 1}, {"z": 1}, {"x": 31}, {"level": 1}, {"z_stop": 2}):
        changed = {**req, "selection": {**req["selection"], **selection}}
        with pytest.raises((ValueError, PermissionError)):
            authorize_action(agent, wb, "cellpose_preview", changed)
    for update in (
        {"measurement_channels": [True]},
        {"measurement_channels": [0, 0]},
        {"measurement_channels": [2]},
        {"profile_id": "cellpose-sam"},
        {"settings": {**req["settings"], "device": "auto"}},
        {"settings": {**req["settings"], "path": "/tmp/forbidden"}},
    ):
        with pytest.raises((ValueError, PermissionError)):
            authorize_action(agent, wb, "cellpose_preview", {**req, **update})
    limited = tmp_path / "limited"
    create_agent_access(wb, {**grant, "cellpose_measurement_channels": []}, limited)
    reader = PolicyAgent(load_policy(limited / "agent-policy.json"))
    with pytest.raises(PermissionError, match="measurement channels"):
        authorize_action(reader, wb, "cellpose_preview", req)
    assert wb.project.list_jobs() == []


def test_cellpose_setup_requires_boolean_and_explicit_grant(tmp_path):
    wb, _, recipe = make_study(tmp_path)
    default = grant_request(recipe)
    del default["allow_cellpose_model"], default["cellpose_measurement_channels"]
    bundle = tmp_path / "full-access"
    receipt = create_agent_access(wb, default, bundle)
    assert "cellpose_model_sha256" not in receipt
    policy = load_policy(bundle / "agent-policy.json")
    assert not (set(policy.actions) & CELLPOSE_ACTIONS)
    assert not policy.model_packages
    for update in (
        {"allow_cellpose_model": 1},
        {"cellpose_measurement_channels": [1]},
        *({"actions": [action]} for action in sorted(CELLPOSE_ACTIONS)),
    ):
        with pytest.raises(ValueError, match="Cellpose"):
            create_agent_access(wb, {**default, **update}, tmp_path / "denied")
        assert not (tmp_path / "denied").exists()


def test_model_plane_requires_level_zero_and_scalar_samples(tmp_path):
    _, source, _ = make_study(tmp_path)
    selection = _request(source["id"])["selection"]
    for source_kind in ("native", "ome_zarr", "whole_slide"):
        candidate = {**source, "source_kind": source_kind}
        require_scalar_plane(candidate, selection)
        with pytest.raises(ValueError, match="level-zero scalar"):
            require_scalar_plane(candidate, {**selection, "level": 1})
        for rgb in ({"sample_semantics": "RGB"}, {"axes": "YXS"}, {"dimensions": {"s": 4}}):
            with pytest.raises(ValueError, match="level-zero scalar"):
                require_scalar_plane(
                    {**candidate, "metadata": {**source["metadata"], **rgb}}, selection
                )


def test_cellpose_setup_rechecks_runtime_at_publication(tmp_path, pins, monkeypatch):
    from loci_engine import research_cellpose as native

    wb, _, recipe = make_study(tmp_path)
    first, changed = pins, copy.deepcopy(pins)
    changed[1]["backend"] = "other-runtime"
    snapshots = iter((first, changed))
    monkeypatch.setattr(native, "installed_cellpose_pins", lambda: next(snapshots))
    with pytest.raises(ValueError, match="runtime changed"):
        create_agent_access(wb, grant_request(recipe), tmp_path / "bundle")
    assert not (tmp_path / "bundle").exists()


def test_installed_identities_must_continue_to_match_the_grant(tmp_path, pins, monkeypatch):
    from loci_engine import research_cellpose as native

    wb, source, recipe = make_study(tmp_path)
    bundle = tmp_path / "bundle"
    create_agent_access(wb, grant_request(recipe), bundle)
    agent = PolicyAgent(load_policy(bundle / "agent-policy.json"))
    req = {**_request(source["id"]), "working_bytes": 4 * 1024**3}
    for changed in (
        ({**pins[0], "sha256": "0" * 64}, pins[1]),
        (pins[0], {**pins[1], "backend": "other-runtime"}),
    ):
        monkeypatch.setattr(native, "installed_cellpose_pins", lambda snapshot=changed: snapshot)
        with pytest.raises(PermissionError, match="outside the pinned policy"):
            agent.validate_action("cellpose_preview", req)
    assert not wb.project.list_jobs()


def test_cpu_working_set_does_not_reserve_accelerator_capacity(tmp_path, pins):
    from loci_engine.research_cellpose import estimate_cellpose_memory_bytes

    wb, source, recipe = make_study(tmp_path)
    # Preflight must honor the actual 2 GiB policy and 32 MiB array allowance.
    # The native accelerator-only capacity estimate for this crop is larger.
    recipe = {**recipe, "recipe": {**recipe["recipe"], "working_bytes": 32 * 1024**2}}
    limits = {"cpu_seconds": 60, "memory_bytes": 2 * 1024**3, "concurrency": 1}
    bundle = tmp_path / "bundle"
    create_agent_access(wb, grant_request(recipe, limits=limits), bundle)
    req = _request(source["id"])
    estimate = estimate_cellpose_memory_bytes(14, 12, 2, 2, req["settings"])
    assert estimate["required_working_bytes"] <= req["working_bytes"] < limits["memory_bytes"]
    assert limits["memory_bytes"] < estimate["accelerator_preflight_bytes"]
    agent = PolicyAgent(load_policy(bundle / "agent-policy.json"))
    assert agent.validate_action("cellpose_preview", req)["authorized"]


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS has separate RSS and peak-RSS guards")
def test_owned_darwin_worker_stops_before_publication_on_memory_breach(tmp_path, monkeypatch, pins):
    import resource

    from loci_engine import research_cli, research_mcp, resource_limits
    from loci_engine.research_jobs import submit_job

    wb, source, recipe = make_study(tmp_path)
    bundle = tmp_path / "bundle"
    create_agent_access(wb, grant_request(recipe), bundle)
    agent = PolicyAgent(load_policy(bundle / "agent-policy.json"))
    job = submit_job(
        wb, _request(source["id"]), "memory", "cellpose_preview", owner=agent.job_owner
    )
    # Run the production CLI guard in the test interpreter with a reported peak just
    # over the policy. Do not apply a kernel limit to the pytest process itself.
    monkeypatch.setattr(resource_limits, "apply_process_limits", lambda *_: None)
    monkeypatch.setattr(
        resource, "getrusage", lambda _: SimpleNamespace(ru_maxrss=agent.policy.memory_bytes + 1)
    )
    cmd = agent.supervisor._command(wb.project, job["id"])
    with pytest.raises(PermissionError, match="granted process memory"):
        research_cli.execute(research_cli.parser().parse_args(cmd[cmd.index("run") :]))
    assert not wb.project.documents("model_preview") and not wb.project.list_results()
    # The independent supervisor also detects a live worker that exceeds the limit
    # while still loading native libraries and before claiming its queued job.
    process = Mock(pid=12345)
    process.poll.side_effect = [None, None, -9]
    agent.supervisor._children[job["id"]] = process
    usage = SimpleNamespace(
        returncode=0, stdout=str(agent.policy.memory_bytes // 1024 + 1).encode()
    )
    monkeypatch.setattr(research_mcp.subprocess, "run", lambda *args, **kwargs: usage)
    agent.supervisor._watch(job["id"], process, observe_cellpose_memory=True)
    process.kill.assert_called_once_with()
    stopped = wb.project.job(job["id"])
    assert stopped["state"] == "failed" and "granted process memory" in stopped["error"]
    assert not agent.supervisor.owned_worker_active(job["id"])


def test_generated_mcp_server_discloses_unavailable_profile_and_refuses_execution(
    tmp_path, monkeypatch, pins
):
    wb, source, recipe = make_study(tmp_path)
    model_home = tmp_path / "absent-model-store"
    monkeypatch.setenv("LOCI_MODEL_HOME", str(model_home))
    bundle = tmp_path / "bundle"
    receipt = create_agent_access(wb, grant_request(recipe, client="codex"), bundle)
    config = tomllib.loads((bundle / receipt["codex_config_filename"]).read_text())
    (server,) = config["mcp_servers"].values()
    parameters = StdioServerParameters(**server)
    req = {**_request(source["id"]), "working_bytes": 4 * 1024**3}

    async def exercise(errlog):
        async with (
            stdio_client(parameters, errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            tools = {tool.name for tool in (await session.list_tools()).tools}
            assert {"action_guide", "inspect_action", "submit_action"} <= tools
            assert {"research_agent_session_control", "control_agent_session"}.isdisjoint(tools)
            context = await session.call_tool("analysis_context", {})
            assert context.structured_content["cellpose_scope"] == receipt["cellpose_scope"]
            guide = await session.call_tool("action_guide", {"operation": "cellpose_adopt"})
            action = guide.structured_content["actions"][0]
            assert "single-use-human-visual-review-approval" in action["permissions"]
            status = await session.call_tool(
                "inspect_action", {"operation": "cellpose_model_status", "request": {}}
            )
            assert not status.is_error, status.content
            assert status.structured_content["ready"] is False
            assert status.structured_content["runtime"] is None
            assert str(tmp_path) not in str(status.content)
            denied = await session.call_tool(
                "submit_action",
                {"operation": "cellpose_preview", "request": req, "request_key": "missing-store"},
            )
            assert denied.is_error and str(tmp_path) not in str(denied.content)

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
    assert not wb.project.list_jobs() and not wb.project.list_results()
    assert not model_home.exists()


@pytest.mark.parametrize("client", ["codex", "antigravity"])
def test_workspace_pins_trusted_model_home_and_hashes_config_bytes(
    tmp_path, monkeypatch, pins, client
):
    wb, _, recipe = make_study(tmp_path)
    model_home = tmp_path / "private model home"
    monkeypatch.setenv("LOCI_MODEL_HOME", str(model_home))
    bundle = tmp_path / "bundle"
    receipt = create_agent_access(wb, grant_request(recipe, client=client), bundle)
    assert str(model_home) not in json.dumps(receipt)
    workspace = (bundle / receipt[f"{client}_config_filename"]).read_bytes()
    assert hashlib.sha256(workspace).hexdigest() == receipt["workspace_config_sha256"]
    manual = json.loads((bundle / "mcp-config.json").read_text())["mcpServers"]["loci-research"]
    plugin = json.loads((bundle / "plugin/mcp.json").read_text())["mcpServers"]["loci-research"]
    codex = tomllib.loads((bundle / "codex-config.toml").read_text())["mcp_servers"][
        "loci-research"
    ]
    config = (
        tomllib.loads(workspace.decode())["mcp_servers"]
        if client == "codex"
        else json.loads(workspace)["mcpServers"]
    )
    for server in (manual, plugin, codex, *config.values()):
        assert server["env"]["LOCI_MODEL_HOME"] == str(model_home)
    assert "cellpose_adopt" in (bundle / "README.txt").read_text()
    assert "cellpose_model_status" in (bundle / "plugin/skills/loci-analysis/SKILL.md").read_text()
    with pytest.raises(ValueError):
        create_agent_access(
            wb, grant_request(recipe, LOCI_MODEL_HOME="/injected"), tmp_path / "bad"
        )


def test_whole_source_grant_keeps_cellpose_bound_to_selected_plane_and_list(tmp_path, pins):
    wb, source, recipe = make_study(tmp_path)
    bundle = tmp_path / "bundle"
    scope = {"mode": "study-sources", "sources": [{"id": source["id"], "sha256": source["sha256"]}]}
    receipt = create_agent_access(
        wb, grant_request(recipe, cellpose_measurement_channels=[1], source_scope=scope), bundle
    )
    agent = PolicyAgent(load_policy(bundle / "agent-policy.json"))
    request = _request(source["id"], measurement_channels=[1])
    request["working_bytes"] = 4 * 1024**3
    assert agent.policy.sources[source["id"]].measurement_channels == (0, 1)
    assert receipt["cellpose_scope"]["measurement_channels"] == [1]
    assert agent.validate_action("cellpose_preview", request)["authorized"]
    for changes in (
        {"measurement_channels": [0]},
        {"selection": {**request["selection"], "c": 1}},
        {"selection": {**request["selection"], "z": 2}},
    ):
        with pytest.raises(PermissionError):
            agent.validate_action("cellpose_preview", {**request, **changes})


def test_adoption_binds_native_inspection_to_preview_session_and_submission(tmp_path, monkeypatch):
    """Run native preview/adopt/correction on deterministic fixture inference."""
    from test_agent_nuclei_model import _inprocess_popen
    from test_research_cellpose import _inference

    from loci_engine import cellpose_backend as backend
    from loci_engine import research_cellpose as native
    from loci_engine.agent_sessions import (
        AgentSessionApprovalError,
        agent_sessions_snapshot,
        control_agent_session,
        start_session,
    )
    from loci_engine.research_jobs import submit_job
    from loci_engine.research_mcp import JobSupervisor
    from loci_engine.research_project import canonical_json

    def fixture_status(spec, **kwargs):
        return backend.CellposeBackendStatus(
            model_spec=spec,
            ready=True,
            code="ready",
            summary="Test fixture",
            installed_version=backend.CELLPOSE_PACKAGE_VERSION,
            model_path=tmp_path / "private",
            model_present=True,
            model_verified=True,
            devices={"cpu": True},
        )

    def infer(image, settings, model, **kwargs):
        inference = _inference(image)
        inference.runtime["model"] = {"artifact_id": "cpsam_v2", "sha256": CELLPOSE_MODEL_SHA256}
        return inference

    monkeypatch.setattr(backend, "get_cellpose_status", fixture_status)
    monkeypatch.setattr(backend, "segment_cellpose", infer)
    monkeypatch.setattr(native, "get_cellpose_status", fixture_status)
    monkeypatch.setattr(
        native, "_import_runtime", lambda: (None, SimpleNamespace(__version__="2.9"))
    )
    wb, source, recipe = make_study(tmp_path)
    bundle = tmp_path / "bundle"
    grant = grant_request(
        recipe, actions=["correct_result", "correction_info"], cellpose_measurement_channels=[1]
    )
    create_agent_access(wb, grant, bundle)
    policy = load_policy(bundle / "agent-policy.json")
    session = start_session(wb.project, policy)["session_id"]
    supervisor = JobSupervisor(policy, popen=_inprocess_popen(wb))
    agent = PolicyAgent(policy, supervisor, session_id=session, approval_wait_seconds=0)
    req = _request(source["id"], measurement_channels=[1])
    req["working_bytes"] = 4 * 1024**3
    preview_job = agent.submit_action("cellpose_preview", req, "preview-1")["job"]
    jid = preview_job["id"]
    retained = inspect_action(agent, wb, "task_preview_get", {"job_id": jid})["preview"]
    dto = retained["output"]["preview"]
    assert dto["preview_job_id"] == dto["id"] == jid
    assert retained["adopted"] is False and not wb.project.list_results()
    token = {"preview_id": jid, "preview_sha256": dto["preview_sha256"]}
    other_request = {**req, "selection": {**req["selection"], "width": 13}}
    other_jid = agent.submit_action("cellpose_preview", other_request, "preview-2")["job"]["id"]
    other_record = inspect_action(agent, wb, "task_preview_get", {"job_id": other_jid})["preview"]
    assert other_record["output"]["preview"]["preview_sha256"] != token["preview_sha256"]
    assert other_record["output"]["overlay_png"] != retained["output"]["overlay_png"]
    with pytest.raises(ValueError, match="exact persisted preview"):
        agent.validate_action("cellpose_adopt", {**token, "preview_id": other_jid})
    no_session = PolicyAgent(policy)
    with pytest.raises(PermissionError, match="registered session"):
        no_session.validate_action("cellpose_adopt", token)
    other = PolicyAgent(policy, session_id=start_session(wb.project, policy)["session_id"])
    with pytest.raises(PermissionError, match="produced in this session"):
        other.validate_action("cellpose_adopt", token)
    with pytest.raises(AgentSessionApprovalError, match="human approval"):
        agent.submit_action("cellpose_adopt", token, "adopt-1")
    approval = next(
        a for a in agent_sessions_snapshot(wb.project)["approvals"] if a["state"] == "pending"
    )
    assert approval["parameters_summary"]["preview_job_id"] == jid
    assert approval["parameters_summary"]["package_sha256"] == CELLPOSE_MODEL_SHA256
    decide = {"action": "approve_request", "approval_id": approval["id"]}
    with pytest.raises(ValueError, match="inspected_preview"):
        control_agent_session(wb, decide)
    with pytest.raises(ValueError, match="Inspected preview job"):
        control_agent_session(
            wb, {**decide, "inspected_preview": {**token, "preview_job_id": "0" * 32}}
        )
    # Even a correctly checksummed display cache from another authorized job
    # cannot stand in for the job selected by the host or the researcher.
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE metadata SET value=? WHERE key=?",
            (
                canonical_json(
                    {
                        **retained,
                        "output": other_record["output"],
                        "output_sha256": other_record["output_sha256"],
                    }
                ),
                "task-preview:" + jid,
            ),
        )
    with pytest.raises(ValueError, match="selected job"):
        inspect_action(agent, wb, "task_preview_get", {"job_id": jid})
    with pytest.raises(ValueError, match="Retained model preview"):
        control_agent_session(wb, {**decide, "inspected_preview": {**token, "preview_job_id": jid}})
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE metadata SET value=? WHERE key=?",
            (canonical_json(retained), "task-preview:" + jid),
        )
    control_agent_session(wb, {**decide, "inspected_preview": {**token, "preview_job_id": jid}})
    with pytest.raises(AgentSessionApprovalError, match="human approval"):
        agent.submit_action("cellpose_adopt", token, "different-key")
    forged = submit_job(wb, token, "unapproved-worker", "cellpose_adopt", owner=agent.job_owner)
    with pytest.raises(PermissionError, match="consumed single-use"):
        agent._authorize_job(wb, forged["id"])
    job = agent.submit_action("cellpose_adopt", token, "adopt-1")["job"]
    assert agent.submit_action("cellpose_adopt", token, "adopt-1")["job"]["id"] == job["id"]
    (adopted_id,) = agent.job_status(job["id"])["job"]["result_ids"]
    parent = agent.result(adopted_id)
    assert parent["provenance"]["cellpose_preview"]["sha256"] == token["preview_sha256"]
    assert (
        parent["provenance"]["cellpose_preview"]["raw_channel_sha256s"]
        == dto["source"]["raw_channel_sha256s"]
    )
    assert parent["measurements"][0]["intensity"]["source_channel_1"]["mean"] == 20
    record = wb.project.result(adopted_id)
    annotated = copy.deepcopy(record)
    annotated["provenance"]["annotations"] = [
        {"basis": "raw-source-channel-values", "measurements": {"source_channel_1": {}}}
    ]
    with pytest.raises(PermissionError, match="ROI measurement channels"):
        require_retained_pins(policy, annotated)
    binding = {"result_id": adopted_id, "revision_hash": parent["result"]["revision_hash"]}
    info = inspect_action(agent, wb, "correction_info", binding)
    corrected = agent.submit_action(
        "correct_result",
        {
            **binding,
            "operations": [
                {"op": "delete", "label": 1, "expected_input_sha256": info["label_sha256"]}
            ],
        },
        "delete-one",
    )["job"]
    (child_id,) = agent.job_status(corrected["id"])["job"]["result_ids"]
    child = agent.result(child_id)
    assert child["result"]["parent_id"] == adopted_id and child["result"]["review"] is None
    assert child["provenance"]["cellpose_preview"] == parent["provenance"]["cellpose_preview"]
    assert [row["intensity"]["source_channel_1"]["mean"] for row in child["measurements"]] == [20]
    reduced = json.loads((bundle / "agent-policy.json").read_text())
    del reduced["schema"], reduced["project"]
    reduced.update(
        actions=[],
        operations=["result"],
        disclosures=["agent_metadata", "measurements", "provenance"],
    )
    path = tmp_path / "read-result.json"
    write_policy(path, wb.project, reduced)
    reader = PolicyAgent(load_policy(path))
    for identity in (adopted_id, child_id):
        result = reader.result(identity)
        assert result["provenance"]["measurement_channels"] == [1]
        assert "channel_metadata" not in result["provenance"]
        for row in result["measurements"]:
            assert list(row["intensity"]) == ["source_channel_1"]
            assert row["intensity"]["source_channel_1"]["mean"] == 20
    narrow = tmp_path / "narrow"
    create_agent_access(wb, {**grant, "cellpose_measurement_channels": [0]}, narrow)
    limited = PolicyAgent(load_policy(narrow / "agent-policy.json"))
    for identity in (adopted_id, child_id):
        with pytest.raises(PermissionError, match="measurement channels"):
            limited.result(identity)
