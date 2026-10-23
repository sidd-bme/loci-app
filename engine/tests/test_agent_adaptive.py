"""The adaptive MCP binding must retain native numerics and grant boundaries."""

import asyncio
import copy
import json
import tempfile
import time

import numpy as np
import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_actions import actions_agent
from test_agent_review import decision
from test_research_mcp import stdio_parameters

from loci_engine.agent_actions import authorize_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.models import SegmentationSettings
from loci_engine.profiles import DEFAULT_PROFILE_ID
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent


def adaptive_request(result):
    return {
        "source_id": result["source_id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 32,
            "height": 32,
            "t": 0,
            "c": 0,
            "z": 1,
            "level": 0,
        },
        "profile_id": DEFAULT_PROFILE_ID,
        "settings": SegmentationSettings(
            image_mode="fluorescence",
            polarity="bright",
            expected_diameter_px=8,
            min_area_px=4,
            smoothing_px=0,
            exclude_border=False,
        ).to_dict(),
        "measurement_channels": [0],
        "working_bytes": 64 * 1024**2,
    }


@pytest.mark.parametrize(
    "attack",
    ["time", "channel", "measurement", "crop", "z-range", "settings", "profile", "runtime"],
)
def test_adaptive_action_rejects_ungranted_or_unverifiable_input_before_submission(
    tmp_path, attack
):
    agent, workbench, result, path, _, spec, _ = actions_agent(tmp_path)
    request = adaptive_request(result)
    if attack == "time":
        request["selection"]["t"] = 1
    elif attack == "channel":
        request["selection"]["c"] = 1
    elif attack == "measurement":
        request["measurement_channels"] = [1]
    elif attack == "crop":
        spec["sources"][0]["crop"]["width"] = 31
    elif attack == "z-range":
        request["selection"]["z_stop"] = 2
    elif attack == "settings":
        request["settings"]["split_touching"] = "false"
    elif attack == "profile":
        request["profile_id"] = "cellpose-sam"
    elif attack == "runtime":
        spec["runtimes"][0]["numpy"] = "unapproved-version"
    if attack in {"crop", "runtime"}:
        write_policy(path, workbench.project, spec)
        agent = PolicyAgent(load_policy(path))
    with pytest.raises((PermissionError, ValueError, TypeError)):
        agent.submit_action("classical_run", request, "invalid-adaptive")
    assert workbench.project.list_jobs() == []
    assert len(workbench.project.list_results()) == 1


def test_adaptive_actual_stdio_matches_native_then_corrects_reviews_and_exports(tmp_path):
    _, workbench, parent, path, _, _, root = actions_agent(tmp_path)
    request = adaptive_request(parent)
    original_request = copy.deepcopy(request)
    expected = workbench.execute("classical_run", request)["result"]
    expected_record = workbench.project.result(expected["id"])

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

            guide = await call("action_guide", {"operation": "classical_run"})
            assert guide["actions"][0]["execution"] == "durable-task"
            checked = await call(
                "validate_action", {"operation": "classical_run", "request": request}
            )
            assert checked["authorized"] and checked["request"] == original_request

            async def submit(operation, payload, key):
                arguments = {"operation": operation, "request": payload, "request_key": key}
                submitted = (await call("submit_action", arguments))["job"]
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    job = (await call("job_status", {"job_id": submitted["id"]}))["job"]
                    if job["state"] not in {"queued", "running"} and not job["owned_worker_active"]:
                        break
                    await asyncio.sleep(0.05)
                assert job["state"] == "succeeded", job
                retry = (await call("submit_action", arguments))["job"]
                assert retry["id"] == job["id"]
                return (await call("result", {"result_id": job["result_ids"][0]}))["result"]

            actual = await submit("classical_run", request, "adaptive-native-parity")
            record = workbench.project.result(actual["id"])
            for name in ("labels", "image"):
                np.testing.assert_array_equal(
                    workbench.project.load_array(record["arrays"][name]),
                    workbench.project.load_array(expected_record["arrays"][name]),
                )
            assert (
                record["provenance"]["measurements"]
                == expected_record["provenance"]["measurements"]
            )
            assert (
                record["provenance"]["accepted_request"]
                == expected_record["provenance"]["accepted_request"]
            )
            assert len(record["provenance"]["measurements"]) == 1
            assert (
                record["provenance"]["measurements"][0]["intensity"]["source_channel_0"]["mean"]
                == 100
            )
            info = await call(
                "inspect_action",
                {
                    "operation": "correction_info",
                    "request": {
                        "result_id": actual["id"],
                        "revision_hash": actual["revision_hash"],
                    },
                },
            )
            correction = {
                "result_id": actual["id"],
                "revision_hash": actual["revision_hash"],
                "operations": [
                    {"op": "delete", "label": 1, "expected_input_sha256": info["label_sha256"]}
                ],
                "working_bytes": request["working_bytes"],
            }
            stale = await session.call_tool(
                "submit_action",
                {
                    "operation": "correct_result",
                    "request": {**correction, "revision_hash": "f" * 64},
                    "request_key": "stale-adaptive",
                },
            )
            assert stale.is_error
            corrected = await submit("correct_result", correction, "correct-adaptive")
            child = workbench.project.result(corrected["id"])
            assert child["parent_id"] == actual["id"] and child["provenance"]["measurements"] == []
            assert workbench.project.review_state(child["id"]) is None
            reviewed = await call(
                "review_result",
                {"request": decision(corrected, coverage="Entire synthetic XY label plane")},
            )
            assert reviewed["review"]["actor"] == "agent"
            await call(
                "export_result",
                {
                    "result_id": corrected["id"],
                    "revision_hash": corrected["revision_hash"],
                    "filename": "adaptive-reviewed",
                },
            )
            return actual, corrected

    with tempfile.TemporaryFile(mode="w+") as errlog:
        actual, corrected = asyncio.run(exercise(errlog))
    exported = json.loads((root / "adaptive-reviewed" / "result.json").read_text())
    assert exported["result"]["id"] == corrected["id"]
    assert exported["review"]["actor_id"] == "declared-test-client"
    assert len(workbench.project.list_jobs()) == 2
    assert workbench.project.result(actual["id"])["revision_hash"] == actual["revision_hash"]


def test_adaptive_revocation_at_publication_does_not_publish_result(tmp_path):
    agent, workbench, parent, path, *_ = actions_agent(tmp_path)
    request = authorize_action(agent, workbench, "classical_run", adaptive_request(parent))
    job = submit_job(workbench, request, "revoked-adaptive", "classical_run")

    def revoke():
        path.unlink()
        agent.policy.recheck()

    with pytest.raises(ValueError, match="Policy must be an accessible plain file"):
        run_job(workbench, job["id"], publication_guard=revoke)
    assert workbench.project.job(job["id"])["state"] == "failed"
    assert [item["id"] for item in workbench.project.list_results()] == [parent["id"]]
