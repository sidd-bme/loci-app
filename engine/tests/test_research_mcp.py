import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from test_agent_policy import make_study, specification

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_mcp import JobSupervisor, PolicyAgent


def stdio_parameters(path):
    executable = os.environ.get("LOCI_TEST_ENGINE_EXECUTABLE")
    return StdioServerParameters(
        command=executable or sys.executable,
        args=(["--cli"] if executable else ["-m", "loci_engine.research_cli"])
        + ["mcp", "--policy", str(path)],
        env=None
        if executable
        else {"PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
    )


def make_context_agent(tmp_path, *, disclosures=None, multiple=False):
    import shutil

    workbench, source, request = make_study(tmp_path)
    root = tmp_path / "exports"
    root.mkdir()
    spec = specification(
        workbench,
        source,
        request,
        root,
        disclosures=["agent_metadata"] if disclosures is None else disclosures,
    )
    spec["operations"].append("analysis_context")
    if multiple:
        second_path = tmp_path / "second-synthetic.tif"
        shutil.copyfile(tmp_path / "synthetic.tif", second_path)
        second = workbench.import_native(str(second_path), name="second granted name")
        spec["sources"].append(
            {**spec["sources"][0], "id": second["id"], "sha256": second["sha256"]}
        )
        proposed = {
            **request,
            "recipe": {
                **request["recipe"],
                "segmentation": {"method": "components", "threshold": 75},
            },
        }
        spec["recipes"].append(
            {
                "sha256": workbench.validate_recipe(proposed)["recipe_sha256"],
                "preview": False,
                "run": True,
            }
        )
        hidden_path = tmp_path / "ungranted-synthetic.tif"
        shutil.copyfile(tmp_path / "synthetic.tif", hidden_path)
        workbench.import_native(str(hidden_path), name="ungranted secret name")
    path = tmp_path / "context-policy.json"
    write_policy(path, workbench.project, spec)
    return PolicyAgent(load_policy(path)), workbench, path


def test_context_requires_both_new_operation_and_metadata_disclosure(tmp_path):
    old, _, _, _, _, _ = make_agent(tmp_path, disclosures=["agent_metadata"])
    with pytest.raises(PermissionError, match="operation"):
        old.analysis_context()
    other = tmp_path / "other"
    other.mkdir()
    no_metadata, _, _ = make_context_agent(other, disclosures=["geometry", "source_names"])
    with pytest.raises(PermissionError, match="agent_metadata"):
        no_metadata.analysis_context()


@pytest.mark.parametrize(
    "disclosures",
    [
        ["agent_metadata"],
        ["agent_metadata", "geometry"],
        ["agent_metadata", "source_names"],
        ["agent_metadata", "geometry", "source_names"],
    ],
)
def test_context_pages_only_pinned_grants_and_filters_independent_disclosures(
    tmp_path, disclosures, monkeypatch
):
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    agent, _, _ = make_context_agent(tmp_path, disclosures=disclosures, multiple=True)

    def forbidden(*args, **kwargs):
        raise AssertionError("Context must not enumerate study content")

    monkeypatch.setattr(ResearchProject, "list_sources", forbidden)
    monkeypatch.setattr(ResearchProject, "list_jobs", forbidden)
    monkeypatch.setattr(Workbench, "snapshot", forbidden)
    first = agent.analysis_context(limit=1)
    second = agent.analysis_context(offset=first["pagination"]["next_offset"], limit=1)
    assert first["pagination"]["source_grants_count"] == 2
    assert first["pagination"]["recipe_grants_count"] == 2
    assert second["pagination"]["next_offset"] is None
    assert len(first["source_grants"]) == len(first["recipe_grants"]) == 1
    assert len(second["source_grants"]) == len(second["recipe_grants"]) == 1
    assert {item["source_id"] for item in first["source_grants"] + second["source_grants"]} == set(
        agent.policy.sources
    )
    for item in first["source_grants"] + second["source_grants"]:
        assert ("name" in item) == ("source_names" in disclosures)
        assert ("permitted_scope" in item) == ("geometry" in disclosures)
    assert first["policy"]["limits"]["concurrency"] == 1
    encoded = json.dumps([first, second])
    assert "ungranted secret name" not in encoded
    assert str(tmp_path) not in encoded
    assert agent.analysis_context(offset=100)["source_grants"] == []


@pytest.mark.parametrize(
    "arguments",
    [
        {"offset": True},
        {"offset": -1},
        {"offset": "0"},
        {"offset": 0.5},
        {"limit": False},
        {"limit": 0},
        {"limit": 51},
        {"limit": 1.5},
    ],
)
def test_context_rejects_invalid_pagination(tmp_path, arguments):
    agent, _, _ = make_context_agent(tmp_path)
    with pytest.raises(ValueError):
        agent.analysis_context(**arguments)


def test_context_source_mutation_and_mid_read_revocation_prevent_response(tmp_path, monkeypatch):
    from loci_engine.agent_policy import AgentPolicy

    agent, _, path = make_context_agent(tmp_path)
    original = AgentPolicy.source_grant

    def revoke_after_source(*args):
        grant = original(*args)
        path.unlink()
        return grant

    with monkeypatch.context() as patch:
        patch.setattr(AgentPolicy, "source_grant", revoke_after_source)
        with pytest.raises((PermissionError, ValueError)):
            agent.analysis_context()
    other = tmp_path / "mutated"
    other.mkdir()
    mutated, _, _ = make_context_agent(other)
    with (other / "synthetic.tif").open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(ValueError, match="changed"):
        mutated.analysis_context()


def test_context_and_guide_resources_use_same_permissions_and_sanitized_errors(
    tmp_path, monkeypatch
):
    from mcp.server.mcpserver.exceptions import ResourceError

    from loci_engine.research_mcp import build_server
    from loci_engine.research_project import ResearchProject

    agent, _, path = make_context_agent(tmp_path)
    server = build_server(path)

    async def exercise():
        resources = await server.list_resources()
        assert {str(item.uri) for item in resources} == {"loci://context", "loci://guides/recipes"}
        resource = list(await server.read_resource("loci://context"))[0]
        assert json.loads(resource.content) == agent.analysis_context()
        tools = {item.name: item for item in await server.list_tools()}
        assert all(item.description and item.annotations is not None for item in tools.values())
        for name in ("analysis_context", "recipe_guide"):
            assert tools[name].annotations.read_only_hint is True
            assert tools[name].annotations.open_world_hint is False
        assert tools["preview_recipe"].annotations.read_only_hint is False
        assert tools["preview_recipe"].annotations.idempotent_hint is False
        assert tools["job_status"].annotations.read_only_hint is False
        assert tools["submit_recipe"].annotations.idempotent_hint is True
        assert tools["cancel_job"].annotations.destructive_hint is True
        assert tools["export_result"].annotations.read_only_hint is False
        assert tools["export_result"].annotations.destructive_hint is False

        def private_failure(*args, **kwargs):
            raise ValueError(str(tmp_path / "private-source-name"))

        monkeypatch.setattr(ResearchProject, "source", private_failure)
        with pytest.raises(ResourceError) as error:
            await server.read_resource("loci://context")
        assert str(tmp_path) not in str(error.value)
        assert "failed validation" in str(error.value)

    asyncio.run(exercise())


def test_actual_stdio_sdk_context_pagination_resources_and_revocation(tmp_path):
    from mcp.shared.exceptions import MCPError

    agent, _, path = make_context_agent(tmp_path, multiple=True)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            first = await session.call_tool("analysis_context", {"limit": 1})
            assert not first.is_error
            assert first.structured_content == agent.analysis_context(limit=1)
            second = await session.call_tool("analysis_context", {"offset": 1, "limit": 1})
            assert not second.is_error
            assert second.structured_content["pagination"]["next_offset"] is None
            resource = await session.read_resource("loci://context")
            assert json.loads(resource.contents[0].text) == agent.analysis_context()
            for arguments in ({"limit": True}, {"offset": "0"}, {"unexpected": 0}):
                invalid = await session.call_tool("analysis_context", arguments)
                assert invalid.is_error
            invalid_guide = await session.call_tool("recipe_guide", {"project": str(tmp_path)})
            assert invalid_guide.is_error
            path.unlink()
            denied = await session.call_tool("analysis_context")
            assert denied.is_error
            with pytest.raises(MCPError) as error:
                await session.read_resource("loci://context")
            assert str(tmp_path) not in str(error.value)
            assert str(error.value) == (
                "The research operation failed validation or execution. "
                "Inspect the source and settings in Loci."
            )
            denied_guide = await session.call_tool("recipe_guide")
            assert denied_guide.is_error

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
        errlog.seek(0)
        assert str(tmp_path) not in errlog.read()


def make_agent(tmp_path, *, disclosures=None):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    path = tmp_path / "agent-policy.json"
    write_policy(
        path,
        workbench.project,
        specification(workbench, source, request, export_root, disclosures=disclosures),
    )
    return PolicyAgent(load_policy(path)), workbench, source, request, path, export_root


def test_unapproved_threshold_can_validate_but_cannot_execute_or_encode_output(tmp_path):
    agent, workbench, _, request, _, _ = make_agent(tmp_path, disclosures=["previews"])
    proposal = json.loads(json.dumps(request))
    proposal["recipe"]["segmentation"]["threshold"] = 51
    validation = agent.validate_recipe(proposal)
    assert validation["valid"] is True
    assert validation["approved"] == {"preview": False, "run": False}
    with pytest.raises(PermissionError, match="exact approved"):
        agent.preview_recipe(proposal)
    assert workbench.project.list_results() == []


def test_agent_reference_images_are_rejected_before_validation(tmp_path):
    agent, workbench, _, request, _, _ = make_agent(tmp_path)
    proposal = json.loads(json.dumps(request))
    proposal["recipe"]["references"] = {
        "flatfield": {"source_id": request["source_id"], "selection": {"t": 0}}
    }
    with pytest.raises(PermissionError, match="reference sources"):
        agent.validate_recipe(proposal)
    assert workbench.project.list_results() == []


def test_default_disclosure_hides_names_geometry_measurements_previews_and_provenance(tmp_path):
    agent, workbench, _, request, _, _ = make_agent(tmp_path)
    result = workbench.run_recipe(request)["result"]
    exposed = agent.result(result["id"])
    encoded = json.dumps(exposed)
    assert set(exposed) == {"result"}
    assert set(exposed["result"]) == {"id", "revision_hash", "kind", "review"}
    for forbidden in (
        "untrusted source name",
        "geometry",
        "selection",
        "measurements",
        "provenance",
        "source_id",
        "sha256",
    ):
        assert forbidden not in encoded
    with pytest.raises(PermissionError, match="previews disclosure"):
        agent.preview_recipe(request)
    with pytest.raises(PermissionError, match="previews disclosure"):
        agent.result_view(result["id"])


def test_provenance_does_not_bypass_channel_name_or_agent_metadata_disclosure(tmp_path):
    agent, workbench, source, request, _, _ = make_agent(tmp_path, disclosures=["provenance"])
    result = workbench.run_recipe(request)["result"]
    value = agent.result(result["id"])
    assert "channel_metadata" not in value["provenance"]
    assert "geometry" not in value["provenance"]
    assert "selection" not in value["provenance"]
    assert source["id"] not in json.dumps(value)
    assert source["sha256"] not in json.dumps(value)
    with_names = agent._provenance(
        {
            "job_id": "private-job",
            "channel_metadata": {"source_id": "private-source", "source_sha256": "private-hash"},
        }
    )
    assert "job_id" not in with_names


def test_crop_channel_and_project_isolation_are_checked_before_execution(tmp_path):
    agent, workbench, _, request, _, _ = make_agent(tmp_path, disclosures=["previews"])
    outside = json.loads(json.dumps(request))
    outside["selection"].update(t=1)
    with pytest.raises(PermissionError, match="axes"):
        agent.validate_recipe(outside)

    other_root = tmp_path / "other"
    other_root.mkdir()
    other, other_source, other_request = make_study(other_root)
    with pytest.raises(PermissionError, match="outside the pinned policy"):
        agent.validate_recipe(other_request)
    assert workbench.project.list_results() == []
    assert other.project.list_results() == []
    assert other_source["id"] != request["source_id"]


def test_policy_revocation_and_source_mutation_fail_before_tool_work(tmp_path):
    agent, workbench, _, request, path, _ = make_agent(tmp_path)
    source_path = tmp_path / "synthetic.tif"
    source_path.write_bytes(source_path.read_bytes() + b"changed")
    with pytest.raises((ValueError, RuntimeError), match="fingerprint|changed"):
        agent.validate_recipe(request)
    assert workbench.project.list_results() == []

    # Restore a fresh fixture so this assertion isolates policy revocation.
    other_root = tmp_path / "revoked"
    other_root.mkdir()
    revoked, _, _, _, revoked_path, _ = make_agent(other_root)
    revoked_path.write_bytes(revoked_path.read_bytes() + b" ")
    with pytest.raises(PermissionError, match="changed or replaced"):
        revoked.catalog()
    assert path != revoked_path


def test_export_requires_real_review_exact_revision_and_policy_filename(tmp_path):
    disclosures = ["geometry", "source_names", "previews", "measurements", "provenance"]
    agent, workbench, _, request, _, export_root = make_agent(tmp_path, disclosures=disclosures)
    result = workbench.run_recipe(request)["result"]
    with pytest.raises(ValueError, match="Review"):
        agent.export_result(result["id"], result["revision_hash"], "approved-result")
    with pytest.raises(PermissionError, match="destination"):
        agent.export_result(result["id"], result["revision_hash"], "covert-name")
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    with pytest.raises(PermissionError, match="exact authorized"):
        agent.export_result(result["id"], "0" * 64, "approved-result")
    receipt = agent.export_result(result["id"], result["revision_hash"], "approved-result")
    assert receipt["export_name"] == "approved-result"
    assert (export_root / "approved-result" / "manifest.json").is_file()
    assert not list(export_root.glob(".loci-agent-stage-*"))


def test_retry_key_returns_same_durable_job_and_fixed_child_command(tmp_path):
    agent, workbench, _, request, _, _ = make_agent(tmp_path)
    submitted = agent.submit_recipe(request, "same-request")
    repeated = agent.submit_recipe(request, "same-request")
    assert repeated["job"]["id"] == submitted["job"]["id"]
    job_id = submitted["job"]["id"]
    deadline = time.monotonic() + 20
    state = "queued"
    while state in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.05)
        state = agent.job_status(job_id)["job"]["state"]
    assert state == "succeeded"
    assert len(workbench.project.list_results()) == 1


class FakeProcess:
    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.pid = 424242
        self.returncode = None
        self.terminated = False
        self.terminate_calls = 0

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.terminate_calls += 1
        self.returncode = -15


class ExitedProcess(FakeProcess):
    def __init__(self, command, **kwargs):
        super().__init__(command, **kwargs)
        self.returncode = 1


def test_terminal_job_reports_owned_worker_cleanup_and_preserves_capacity(tmp_path, monkeypatch):
    from loci_engine.research_jobs import run_job

    agent, workbench, _, request, _, _ = make_agent(tmp_path)
    job = workbench.project.submit(
        "run_recipe", request, "completed-with-live-worker", owner=agent.job_owner
    )
    run_job(workbench, job["id"])
    process = FakeProcess([])
    agent.supervisor._children[job["id"]] = process
    monkeypatch.setattr(agent.supervisor, "_preview", lambda *_: {"preview": "permitted"})

    status = agent.job_status(job["id"])["job"]
    assert status["state"] == "succeeded"
    assert status["owned_worker_active"] is True
    assert "pid" not in status and str(process.pid) not in json.dumps(status)
    with pytest.raises(PermissionError, match="concurrency"):
        agent.supervisor.preview(workbench, request)
    assert agent.policy.concurrency == 1

    process.returncode = 0
    settled = agent.job_status(job["id"])["job"]
    assert settled["state"] == "succeeded"
    assert settled["result_ids"] == status["result_ids"]
    assert settled["owned_worker_active"] is False
    assert agent.supervisor.preview(workbench, request) == {"preview": "permitted"}


def test_cancel_signals_only_the_owned_process_with_matching_durable_pid(tmp_path):
    agent, workbench, _, request, path, _ = make_agent(tmp_path)
    process = None

    def spawn(command, **kwargs):
        nonlocal process
        process = FakeProcess(command, **kwargs)
        return process

    supervisor = JobSupervisor(load_policy(path), popen=spawn)
    controlled = PolicyAgent(supervisor.policy, supervisor)
    submitted = controlled.submit_recipe(request, "cancel-owned")
    job_id = submitted["job"]["id"]
    assert process is not None
    assert process.command == [
        sys.executable,
        "-m",
        "loci_engine.research_cli",
        "run",
        "--project",
        str(workbench.project.root),
        "--job",
        job_id,
        "--cpu-seconds",
        "60",
        "--memory-bytes",
        str(8 * 1024**3),
        "--max-concurrency",
        "1",
        "--policy",
        str(path),
        "--policy-sha256",
        supervisor.policy.content_sha256,
    ]
    workbench.project.update_job(job_id, expected_state="queued", state="running", pid=process.pid)
    cancelled = controlled.cancel_job(job_id)["job"]
    assert cancelled["cancel_requested"] is True
    assert process.terminated is True
    assert process.terminate_calls == 1

    unowned = workbench.project.submit("run_recipe", request, "unowned")
    workbench.project.update_job(
        unowned["id"], expected_state="queued", state="running", pid=os.getpid()
    )
    with pytest.raises(PermissionError, match="different policy or session"):
        controlled.cancel_job(unowned["id"])
    assert workbench.project.job(unowned["id"])["cancel_requested"] is False
    assert process.terminated is True
    assert process.terminate_calls == 1


def test_owned_child_failure_before_claim_is_durable_not_left_queued(tmp_path):
    _, workbench, _, request, path, _ = make_agent(tmp_path)
    supervisor = JobSupervisor(load_policy(path), popen=ExitedProcess)
    controlled = PolicyAgent(supervisor.policy, supervisor)
    job_id = controlled.submit_recipe(request, "limit-failure")["job"]["id"]
    deadline = time.monotonic() + 2
    state = "queued"
    while state == "queued" and time.monotonic() < deadline:
        time.sleep(0.01)
        state = workbench.project.job(job_id)["state"]
    assert state == "failed"
    assert "before claiming" in workbench.project.job(job_id)["error"]


def test_policy_revocation_cancels_and_signals_matching_owned_child(tmp_path):
    _, workbench, _, request, path, _ = make_agent(tmp_path)
    process = None

    def spawn(command, **kwargs):
        nonlocal process
        process = FakeProcess(command, **kwargs)
        return process

    supervisor = JobSupervisor(load_policy(path), popen=spawn)
    controlled = PolicyAgent(supervisor.policy, supervisor)
    job_id = controlled.submit_recipe(request, "revoke-running")["job"]["id"]
    assert process is not None
    workbench.project.update_job(job_id, expected_state="queued", state="running", pid=process.pid)
    path.write_bytes(path.read_bytes() + b" ")
    deadline = time.monotonic() + 2
    while not process.terminated and time.monotonic() < deadline:
        time.sleep(0.01)
    assert process.terminated is True
    deadline = time.monotonic() + 2
    while workbench.project.job(job_id)["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert workbench.project.job(job_id)["state"] == "cancelled"
    assert workbench.project.list_results() == []


def test_actual_python_sdk_client_uses_stdio_and_sees_only_static_catalog(tmp_path):
    agent, _, _, request, path, _ = make_agent(tmp_path)
    del agent
    outside = json.loads(json.dumps(request))
    outside["selection"]["t"] = 1

    async def exercise(errlog):
        parameters = stdio_parameters(path)
        async with (
            stdio_client(parameters, errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            assert names == {
                "catalog",
                "recipe_guide",
                "analysis_context",
                "inspect_source",
                "validate_recipe",
                "preview_recipe",
                "submit_recipe",
                "job_status",
                "cancel_job",
                "result",
                "result_view",
                "export_result",
            }
            catalog = await session.call_tool("catalog")
            assert catalog.is_error is not True
            encoded = json.dumps(catalog.model_dump(by_alias=True))
            assert "untrusted source name" not in encoded
            guide = await session.call_tool("recipe_guide")
            assert guide.is_error is not True
            assert guide.structured_content["schema"] == "loci.recipe-guide/v1"
            resources = await session.list_resources()
            assert {str(item.uri) for item in resources.resources} == {
                "loci://guides/recipes",
                "loci://context",
            }
            guide_resource = await session.read_resource("loci://guides/recipes")
            assert json.loads(guide_resource.contents[0].text) == guide.structured_content
            denied_context = await session.call_tool("analysis_context")
            assert denied_context.is_error is True
            assert request["source_id"] not in json.dumps(denied_context.model_dump(by_alias=True))
            from mcp.shared.exceptions import MCPError

            with pytest.raises(MCPError, match="not authorized"):
                await session.read_resource("loci://context")
            validation = await session.call_tool("validate_recipe", {"request": request})
            assert validation.is_error is not True
            assert validation.structured_content["valid"] is True
            denied = await session.call_tool("preview_recipe", {"request": outside})
            assert denied.is_error is True
            assert denied.content[0].text == (
                "Error executing tool preview_recipe: The operation, source scope, "
                "disclosure or resource limit is not authorized by the active policy."
            )

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
        errlog.seek(0)
        diagnostics = errlog.read()
    assert "Traceback" not in diagnostics
    assert str(tmp_path) not in diagnostics
    assert "synthetic.tif" not in diagnostics
    assert "agent-policy.json" not in diagnostics


def test_actual_bounded_preview_matches_manual_values_without_adoption(tmp_path):
    agent, workbench, _, request, _, _ = make_agent(
        tmp_path, disclosures=["previews", "measurements"]
    )
    manual = workbench.run_recipe(request, preview=True)
    response = agent.preview_recipe(request)
    assert response["image"] == manual["image"]
    assert response["object_count"] == manual["object_count"]
    assert response["measurements"][0]["measure"] == manual["measurements"][0]["measure"]
    assert "centroid_world_xyz" not in response["measurements"][0]
    assert all(name.startswith("channel_") for name in response["measurements"][0]["intensity"])
    assert workbench.project.list_results() == []
    jobs = workbench.project.list_jobs()
    assert len(jobs) == 1
    assert jobs[0]["operation"] == "preview_recipe" and jobs[0]["state"] == "succeeded"


def test_frozen_research_child_uses_cli_entry(monkeypatch):
    from loci_engine.research_process import research_command

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert research_command(["discover"]) == [sys.executable, "--cli", "discover"]
