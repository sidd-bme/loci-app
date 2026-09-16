import asyncio
import json
import os
import sys
import tempfile
import time

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from test_agent_policy import make_study, specification

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_mcp import JobSupervisor, PolicyAgent


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
    assert controlled.cancel_job(unowned["id"])["job"]["cancel_requested"] is True
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
        parameters = StdioServerParameters(
            command=sys.executable,
            args=[
                "-m",
                "loci_engine.research_cli",
                "mcp",
                "--policy",
                str(path),
            ],
        )
        async with (
            stdio_client(parameters, errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            assert names == {
                "catalog",
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
