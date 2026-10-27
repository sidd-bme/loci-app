import asyncio
import json
import tempfile
import time

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_actions import actions_agent
from test_agent_adaptive import adaptive_request
from test_agent_review import decision
from test_research_mcp import stdio_parameters

from loci_engine.agent_actions import authorize_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent


def prepare(tmp_path):
    _, wb, result, path, _, spec, root = actions_agent(tmp_path)
    spec["sources"][0]["c"] = [0, 1]
    spec["sources"][0]["measurement_channels"] = [0, 1]
    write_policy(path, wb.project, spec)
    return wb, result, path, spec, root


def ring_request(result):
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "signal_channel": 1,
        "radius_px": 5,
        "working_bytes": 64 * 1024**2,
        "control": "Synthetic two-channel native parity",
    }


@pytest.mark.parametrize(
    "scope", ["action", "input-channel", "measurement-channel", "runtime", "revision"]
)
def test_perinuclear_mcp_rejects_every_ungranted_input_before_job_submission(tmp_path, scope):
    wb, volume, path, spec, _ = prepare(tmp_path)
    parent = wb.execute("classical_run", adaptive_request(volume))["result"]
    request = ring_request(parent)
    if scope == "action":
        spec["actions"].remove("perinuclear_run")
    elif scope == "input-channel":
        spec["sources"][0]["c"] = [0]
    elif scope == "measurement-channel":
        spec["sources"][0]["measurement_channels"] = [0]
    elif scope == "runtime":
        spec["runtimes"][0]["numpy"] = "unapproved"
    else:
        request["revision_hash"] = "f" * 64
    write_policy(path, wb.project, spec)
    with pytest.raises((ValueError, PermissionError)):
        PolicyAgent(load_policy(path)).submit_action("perinuclear_run", request, "ungranted-ring")
    assert wb.project.list_jobs() == []


def test_actual_stdio_adaptive_and_ring_execution_review_export_preserve_proxy_endpoint(tmp_path):
    wb, volume, path, _, root = prepare(tmp_path)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, arguments):
                output = await session.call_tool(name, arguments)
                assert not output.is_error, output
                return output.structured_content

            async def submit(operation, request, key):
                arguments = {"operation": operation, "request": request, "request_key": key}
                job = (await call("submit_action", arguments))["job"]
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    job = (await call("job_status", {"job_id": job["id"]}))["job"]
                    if job["state"] not in {"queued", "running"} and not job["owned_worker_active"]:
                        break
                    await asyncio.sleep(0.05)
                assert job["state"] == "succeeded", job
                assert (await call("submit_action", arguments))["job"]["id"] == job["id"]
                return await call("result", {"result_id": job["result_ids"][0]})

            guide = await call("action_guide", {"operation": "perinuclear_run"})
            assert guide["actions"][0]["execution"] == "durable-task"
            parent = (await submit("classical_run", adaptive_request(volume), "native-dna"))[
                "result"
            ]
            request = ring_request(parent)
            assert (
                await call("validate_action", {"operation": "perinuclear_run", "request": request})
            )["authorized"]
            output = await submit("perinuclear_run", request, "raw-ring")
            result = output["result"]
            assert output["provenance"]["perinuclear"]["summary"] == {
                "object_count": 1,
                "eligible_count": 1,
                "excluded_count": 0,
                "excluded_by_reason": {
                    "boundary-touching-nucleus": 0,
                    "empty-ring": 0,
                    "zero-mean-ring": 0,
                },
                "endpoint_defined": True,
                "median_ratio": 1,
                "mean_ratio": 1,
            }
            row = output["measurements"][0]
            analysis = output["provenance"]["nucleus_analysis"]["provenance"]
            assert analysis["profile"]["id"] == "loci-classical"
            assert analysis["runtime"]["backend"] == "numpy-scipy-cpu"
            assert row["intensity"]["source_channel_1"]["mean"] == 20
            assert row["perinuclear_ring"]["mean"] == 20
            for field in ("nuclei", "rings", "ambiguous"):
                qc = await call("result_view", {"result_id": result["id"], "label_field": field})
                assert qc["label_field"] == field and qc["revision_hash"] == result["revision_hash"]
            for arguments in (
                {"result_id": result["id"], "label_field": "image"},
                {"result_id": result["id"], "label_field": "rings", "path": "/ungranted"},
                {"result_id": parent["id"], "label_field": "rings"},
            ):
                assert (await session.call_tool("result_view", arguments)).is_error
            reviewed = await call(
                "review_result",
                {"request": decision(result, coverage="Full synthetic native XY grid")},
            )
            assert reviewed["review"]["actor"] == "agent"
            await call(
                "export_result",
                {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "filename": "raw-ring-proxy",
                },
            )
            return result, output

    with tempfile.TemporaryFile(mode="w+") as errlog:
        result, output = asyncio.run(exercise(errlog))
    exported = json.loads((root / "raw-ring-proxy" / "result.json").read_text())
    assert exported["result"]["id"] == result["id"]
    assert exported["result"]["provenance"]["perinuclear"] == output["provenance"]["perinuclear"]
    assert exported["review"]["actor_id"] == "declared-test-client"
    assert len(wb.project.list_jobs()) == 2


def test_perinuclear_policy_revocation_at_publication_publishes_no_result(tmp_path):
    wb, volume, path, _, _ = prepare(tmp_path)
    parent = wb.execute("classical_run", adaptive_request(volume))["result"]
    agent = PolicyAgent(load_policy(path))
    request = authorize_action(agent, wb, "perinuclear_run", ring_request(parent))
    job = submit_job(wb, request, "revoke-ring", "perinuclear_run")
    before = len(wb.project.list_results())

    def revoke():
        path.unlink()
        agent.policy.recheck()

    with pytest.raises(ValueError, match="Policy must be an accessible plain file"):
        run_job(wb, job["id"], publication_guard=revoke)
    assert wb.project.job(job["id"])["state"] == "failed"
    assert len(wb.project.list_results()) == before


def test_partial_reader_does_not_receive_hidden_counts_or_input_channel_snapshots(tmp_path):
    wb, volume, path, spec, _ = prepare(tmp_path)
    parent = wb.execute("classical_run", adaptive_request(volume))["result"]
    result = wb.execute("perinuclear_run", ring_request(parent))["result"]
    spec["actions"] = []
    spec["disclosures"] = ["provenance", "agent_metadata"]
    write_policy(path, wb.project, spec)
    output = PolicyAgent(load_policy(path)).result(result["id"])
    assert "measurements" not in output and "geometry" not in output["result"]
    for key in ("perinuclear", "nucleus_analysis", "parent_result", "channel_metadata"):
        assert key not in output["provenance"]
