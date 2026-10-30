"""Existing tracking MCP read action exposes paged exact metrics under all frame grants."""

import asyncio
import tempfile

import pytest
import test_research_temporal_metrics as fixtures
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_policy import runtime_identity, specification
from test_agent_review import DISCLOSURES
from test_research_mcp import stdio_parameters

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_mcp import PolicyAgent


@pytest.fixture
def scene(tmp_path):
    yield from fixtures.scene.__wrapped__(tmp_path)


def policy_for(tmp_path, wb, originals):
    source = wb.project.source(originals[0]["source_id"])
    root = tmp_path / "agent-exports"
    root.mkdir()
    recipe = {
        "source_id": source["id"],
        "selection": {},
        "recipe": {
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0],
        },
    }
    spec = specification(wb, source, recipe, root, disclosures=list(DISCLOSURES), recipes=False)
    spec["sources"][0].update(
        crop={"x": 0, "y": 0, "width": 10, "height": 8}, t=[0, 1, 2], c=[0], z=list(range(7))
    )
    spec.update(
        actions=["tracking_result"],
        remote_grants=[],
        experimental_recipes=[],
        delegation={
            "id": "d" * 32,
            "client_id": "trajectory-fixture",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
    )
    spec["operations"] += ["validate_action", "inspect_action"]
    spec["runtimes"] = [runtime_identity()]
    spec["limits"]["memory_bytes"] = 512 * 1024**2
    path = tmp_path / "trajectory-policy.json"
    write_policy(path, wb.project, spec)
    return path, spec


def test_temporal_page_requires_every_observed_timepoint_source_grant(scene, tmp_path, monkeypatch):
    wb, originals, request, _ = scene()
    result = fixtures.publish(wb, request)
    path, spec = policy_for(tmp_path, wb, originals)
    spec["sources"][0]["t"] = [0, 1]
    write_policy(path, wb.project, spec)
    agent = PolicyAgent(load_policy(path))
    monkeypatch.setattr(
        type(wb.project), "load_array", lambda *_: pytest.fail("Decoded ungranted frame")
    )
    with pytest.raises(PermissionError):
        agent.validate_action(
            "tracking_result",
            {**fixtures.bound(result), "table": "intervals", "offset": 0, "limit": 1},
        )


def test_actual_stdio_tracking_summary_and_xyz_pages_are_bound_and_read_only(scene, tmp_path):
    wb, originals, request, _ = scene()
    result = fixtures.publish(wb, request)
    path, _ = policy_for(tmp_path, wb, originals)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def read_action(request):
                response = await session.call_tool(
                    "inspect_action", {"operation": "tracking_result", "request": request}
                )
                assert not response.is_error, response
                return response.structured_content

            bound = fixtures.bound(result)
            summary = (await read_action(bound))["trajectory_metrics"]
            assert summary["units"]["velocity"] == "um/s" and summary["storage"] == "persisted"
            assert summary["track_count"] == 1 and summary["interval_count"] == 2
            first = await read_action({**bound, "table": "intervals", "offset": 0, "limit": 1})
            assert first["summary"]["graph_sha256"] == summary["graph_sha256"]
            assert first["rows"][0]["velocity_xyz"] == [1.5, 2, 0] and first["next_offset"] == 1
            last = await read_action({**bound, "table": "intervals", "offset": 1, "limit": 1})
            assert last["rows"][0]["velocity_xyz"] == [0, 0, 2] and last["next_offset"] is None
            track = (await read_action({**bound, "table": "tracks", "offset": 0, "limit": 1}))[
                "rows"
            ][0]
            assert track["mean_speed"] == 17 / 8 and track["directionality_ratio"] == 13 / 17
            denied = await session.call_tool(
                "inspect_action",
                {
                    "operation": "tracking_result",
                    "request": {**bound, "table": "tracks", "revision_hash": "f" * 64},
                },
            )
            assert denied.is_error

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
    assert wb.project.result(result["id"]) == result
    assert wb.project.list_jobs() == []
