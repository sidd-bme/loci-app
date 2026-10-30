"""Actual MCP morphology jobs and delegated-source/publication boundaries."""

import asyncio
import tempfile
import time

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_actions import actions_agent
from test_research_mcp import stdio_parameters

from loci_engine import research_morphometrics as morphology
from loci_engine.agent_actions import authorize_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_study import authorize_result
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent


def request(parent):
    return {
        "result_id": parent["id"],
        "revision_hash": parent["revision_hash"],
        "working_bytes": 64 * 1024**2,
    }


def test_denied_shape_source_scope_precedes_all_pixel_validation(tmp_path, monkeypatch):
    _, wb, parent, path, _, spec, _ = actions_agent(tmp_path)
    output = morphology.execute_morphometrics(wb, request(parent))
    spec["sources"][0]["crop"]["width"] = 16
    write_policy(path, wb.project, spec)
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Ungrantable pixels read"))
    monkeypatch.setattr(
        wb.project,
        "validate_result_arrays",
        lambda *_: pytest.fail("Pixels validated before all source grants"),
    )
    with pytest.raises(PermissionError, match="exceed the grant"):
        authorize_result(load_policy(path), wb, output["result"]["id"])


@pytest.mark.parametrize("change", ["action", "channel", "crop", "runtime", "revision", "extra"])
def test_ungranted_or_stale_morphology_never_submits_native_job(tmp_path, change):
    _, wb, parent, path, _, spec, _ = actions_agent(tmp_path)
    body = request(parent)
    if change == "action":
        spec["actions"].remove("morphometrics_run")
    elif change == "channel":
        spec["sources"][0]["c"] = [1]
        spec["sources"][0]["measurement_channels"] = [1]
    elif change == "crop":
        spec["sources"][0]["crop"]["width"] = 16
    elif change == "runtime":
        spec["runtimes"][0]["numpy"] = "unapproved"
    elif change == "revision":
        body["revision_hash"] = "f" * 64
    else:
        body["code"] = "arbitrary execution refused"
    write_policy(path, wb.project, spec)
    with pytest.raises((ValueError, PermissionError)):
        PolicyAgent(load_policy(path)).submit_action("morphometrics_run", body, "denied-shape")
    assert wb.project.list_jobs() == []


def test_actual_stdio_morphology_owned_job_views_population_and_idempotent_replay(tmp_path):
    _, wb, parent, path, _, _, _ = actions_agent(tmp_path)
    original = wb.project.result(parent["id"])

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, arguments):
                output = await session.call_tool(name, arguments)
                assert not output.is_error, output
                return output

            guide = (
                await call("action_guide", {"operation": "morphometrics_run"})
            ).structured_content
            assert guide["actions"][0]["execution"] == "durable-task"
            assert (
                await call(
                    "validate_action",
                    {"operation": "morphometrics_run", "request": request(parent)},
                )
            ).structured_content["authorized"]
            arguments = {
                "operation": "morphometrics_run",
                "request": request(parent),
                "request_key": "agent-exact-shape",
            }
            job = (await call("submit_action", arguments)).structured_content["job"]
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                job = (await call("job_status", {"job_id": job["id"]})).structured_content["job"]
                if job["state"] not in {"queued", "running"} and not job["owned_worker_active"]:
                    break
                await asyncio.sleep(0.05)
            assert job["state"] == "succeeded" and not job["owned_worker_active"], job
            assert (await call("submit_action", arguments)).structured_content["job"]["id"] == job[
                "id"
            ]
            result = (await call("result", {"result_id": job["result_ids"][0]})).structured_content
            summary = result["result"]
            assert summary["kind"] == morphology.KIND and summary["parent_id"] == parent["id"]
            assert (
                result["provenance"]["morphometrics"]["input"]["revision_hash"]
                == parent["revision_hash"]
            )
            assert result["provenance"]["job_id"] == job["id"]
            assert result["measurements"][0]["morphometrics"]["surface_area"] > 0
            for identity in (parent["id"], summary["id"]):
                viewed = await call("result_view", {"result_id": identity})
                assert any(content.type == "image" for content in viewed.content)
            bound = {"result_id": summary["id"], "revision_hash": summary["revision_hash"]}
            population = (
                await call(
                    "inspect_action",
                    {
                        "operation": "population_query",
                        "request": {
                            **bound,
                            "x_metric": "morphometrics:surface_area",
                            "y_metric": "morphometrics:sphericity",
                        },
                    },
                )
            ).structured_content
            assert population["total_count"] == 1
            assert population["rows"][0]["values"]["morphometrics:sphericity"] > 0
            located = (
                await call(
                    "inspect_action",
                    {
                        "operation": "population_locate",
                        "request": {**bound, "label": population["rows"][0]["label"]},
                    },
                )
            ).structured_content
            assert len(located["point_index"]) == 3
            return summary

    with tempfile.TemporaryFile(mode="w+") as errlog:
        summary = asyncio.run(exercise(errlog))
    jobs = wb.project.list_jobs()
    assert len(jobs) == 1 and jobs[0]["owner"]["policy_sha256"] == load_policy(path).content_sha256
    result = wb.project.result(summary["id"])
    assert result["arrays"] == original["arrays"]
    assert wb.project.review_state(result["id"]) is None
    assert {
        k: v for k, v in result["provenance"]["measurements"][0].items() if k != "morphometrics"
    } == original["provenance"]["measurements"][0]


def test_revoked_policy_at_publication_leaves_no_morphology_result(tmp_path):
    agent, wb, parent, path, _, _, _ = actions_agent(tmp_path)
    body = authorize_action(agent, wb, "morphometrics_run", request(parent))
    job = submit_job(wb, body, "revoke-shape", "morphometrics_run", owner=agent.job_owner)
    before = wb.project.list_results()

    def revoke():
        path.unlink()
        agent.policy.recheck()

    with pytest.raises(ValueError, match="accessible plain file"):
        run_job(wb, job["id"], publication_guard=revoke)
    assert wb.project.list_results() == before
    assert wb.project.job(job["id"])["result_ids"] == []


@pytest.mark.parametrize("disclosure", ["geometry", "measurements", "agent_metadata"])
def test_partial_provenance_does_not_leak_combined_shape_snapshot(tmp_path, disclosure):
    _, wb, parent, path, _, spec, _ = actions_agent(tmp_path)
    result = wb.execute("morphometrics_run", request(parent))["result"]
    spec["actions"] = []
    # This fixture is a partial result reader, without delegated study/review
    # operations that correctly require explicit agent_metadata disclosure.
    spec["operations"] = ["result"]
    spec["disclosures"].remove(disclosure)
    write_policy(path, wb.project, spec)
    output = PolicyAgent(load_policy(path)).result(result["id"])
    assert not {"morphometrics", "accepted_request", "parent_result"} & set(output["provenance"])
    if disclosure == "measurements":
        assert "measurements" not in output
    elif disclosure == "geometry":
        assert "geometry" not in output["result"]


def test_recursive_parent_channels_are_rechecked_on_read_of_derivative(tmp_path):
    _, wb, parent, path, _, spec, _ = actions_agent(tmp_path)
    result = wb.execute("morphometrics_run", request(parent))["result"]
    spec["sources"][0]["c"] = [1]
    spec["sources"][0]["measurement_channels"] = [1]
    write_policy(path, wb.project, spec)
    with pytest.raises(PermissionError):
        PolicyAgent(load_policy(path)).result(result["id"])
