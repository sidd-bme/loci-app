import asyncio
import copy
import json
import tempfile
import time

import numpy as np
import pytest
import tifffile
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_review import DISCLOSURES, decision, setup
from test_research_agent_setup import access_request
from test_research_mcp import stdio_parameters

from loci_engine.agent_actions import authorize_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_action_registry import ACTION_NAMES, READ_ACTIONS, TASK_ACTIONS
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_operations import TASK_OPERATIONS


def actions_agent(tmp_path, actions=None):
    _, workbench, result, path, request, spec, root = setup(tmp_path, scope="granted-sources")
    spec["actions"] = sorted(ACTION_NAMES if actions is None else actions)
    spec["operations"] += ["validate_action", "inspect_action", "submit_action", "study_results"]
    spec["export"]["filename_mode"] = "directory"
    write_policy(path, workbench.project, spec)
    return PolicyAgent(load_policy(path)), workbench, result, path, request, spec, root


def wait_job(agent, job_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        job = agent.job_status(job_id)["job"]
        if job["state"] not in {"queued", "running"}:
            return job
        time.sleep(0.05)
    raise AssertionError("The bounded fixture job did not finish")


def deletion(agent, result):
    info = agent.inspect_action(
        "correction_info", {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    )
    assert info["label_ids"] == [1]
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "operations": [{"op": "delete", "label": 1, "expected_input_sha256": info["label_sha256"]}],
        "working_bytes": 64 * 1024**2,
    }


def test_shared_action_registry_uses_native_task_authority(tmp_path):
    agent, workbench, *_ = actions_agent(tmp_path)
    assert TASK_ACTIONS <= TASK_OPERATIONS
    assert not TASK_ACTIONS & READ_ACTIONS
    guide = agent.action_guide()
    assert {item["operation"] for item in guide["actions"]} == ACTION_NAMES
    assert workbench.execute("action_guide", {}) == guide
    operations = workbench.snapshot()["operations"]
    assert all(operations[name]["agent_execution"] == "task" for name in TASK_ACTIONS)
    assert all(operations[name]["agent_execution"] == "read" for name in READ_ACTIONS)


def test_bounded_native_correction_review_and_directory_export_end_to_end(tmp_path):
    agent, workbench, result, _, _, _, root = actions_agent(tmp_path)
    parent = workbench.project.result(result["id"])
    before = workbench.project.load_array(parent["arrays"]["labels"]).copy()
    agent.review_result(decision(result))
    request = deletion(agent, result)
    assert agent.validate_action("correct_result", request)["authorized"] is True
    submitted = agent.submit_action("correct_result", request, "delete-one")["job"]
    job = wait_job(agent, submitted["id"])
    assert job["state"] == "succeeded", job
    child = workbench.project.result(job["result_ids"][0])
    assert child["parent_id"] == result["id"] and child["provenance"]["measurements"] == []
    assert workbench.project.review_state(child["id"]) is None
    np.testing.assert_array_equal(workbench.project.load_array(parent["arrays"]["labels"]), before)
    assert child["provenance"]["correction"]["operations"][0]["changed_voxels"] == 128
    assert agent.submit_action("correct_result", request, "delete-one")["job"]["id"] == job["id"]
    assert len(workbench.project.list_results()) == 2
    agent.review_result(decision(child, coverage="Entire synthetic label grid after deletion"))
    agent.export_result(child["id"], child["revision_hash"], "new-correction-export")
    exported = json.loads((root / "new-correction-export/result.json").read_text())
    assert exported["review"]["actor"] == "agent"
    assert exported["result"]["parent_id"] == parent["id"]
    with pytest.raises((ValueError, FileExistsError)):
        agent.export_result(child["id"], child["revision_hash"], "new-correction-export")


def test_recipe_exploration_and_discovery_stay_within_sources_and_channels(tmp_path):
    agent, workbench, result, _, request, *_ = actions_agent(tmp_path)
    changed = copy.deepcopy(request)
    changed["recipe"]["segmentation"]["threshold"] = 75
    validated = agent.validate_action("run_recipe", changed)
    assert validated["authorized"] is True
    assert agent.validate_recipe(changed)["approved"]["run"] is True
    outside = copy.deepcopy(changed)
    outside["selection"]["t"] = 1
    with pytest.raises(PermissionError, match="selection"):
        agent.submit_action("run_recipe", outside, "outside-grant")
    workbench.run_recipe(outside)
    listed = agent.study_results(limit=1)
    assert [row["id"] for row in listed["results"]] == [result["id"]]
    assert listed["total_results"] == 1 and listed["next_offset"] is None
    outside["selection"]["t"] = 0
    outside["recipe"]["measurement_channels"] = [1]
    with pytest.raises(PermissionError, match="channels"):
        agent.validate_action("run_recipe", outside)


@pytest.mark.parametrize("attack", ["operation", "revision", "budget", "extra", "disclosure"])
def test_invalid_action_never_submits_a_job(tmp_path, attack):
    agent, workbench, result, path, _, spec, _ = actions_agent(tmp_path)
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "operations": [],
    }
    operation = "correct_result"
    if attack == "operation":
        operation = "labels_import"
    elif attack == "revision":
        request["revision_hash"] = "f" * 64
    elif attack == "budget":
        request["working_bytes"] = agent.policy.memory_bytes + 1
    elif attack == "extra":
        request["actor"] = "human"
    else:
        spec["disclosures"] = [item for item in spec["disclosures"] if item != "measurements"]
        with pytest.raises(ValueError, match="all response disclosures"):
            write_policy(path, workbench.project, spec)
        return
    with pytest.raises((ValueError, PermissionError)):
        agent.submit_action(operation, request, "invalid")
    assert workbench.project.list_jobs() == []


def test_revocation_at_correction_publication_keeps_original_and_no_child(tmp_path):
    agent, workbench, result, path, *_ = actions_agent(tmp_path)
    request = deletion(agent, result)
    normalized = authorize_action(agent, workbench, "correct_result", request, mode="task")
    job = submit_job(workbench, normalized, "revoked-correction", "correct_result")

    def revoke():
        if path.exists():
            path.unlink()
        agent.policy.recheck()

    with pytest.raises(ValueError, match="Policy must be an accessible plain file"):
        run_job(workbench, job["id"], publication_guard=revoke)
    assert workbench.project.job(job["id"])["state"] == "failed"
    assert [item["id"] for item in workbench.project.list_results()] == [result["id"]]


def test_whole_study_grant_pins_only_the_explicit_source_snapshot(tmp_path):
    _, workbench, result, _, request, *_ = actions_agent(tmp_path)
    image = tmp_path / "second.tif"
    tifffile.imwrite(image, np.ones((6, 7), np.uint16))
    second = workbench.import_native(str(image))
    first = workbench.project.source(result["source_id"])
    bindings = [{"id": item["id"], "sha256": item["sha256"]} for item in (first, second)]
    directory = tmp_path / "whole-study"
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            disclosures=DISCLOSURES,
            delegation={
                "client_id": "codex",
                "expires_at": None,
                "result_scope": "granted-sources",
                "allow_review": True,
            },
            actions=sorted(ACTION_NAMES),
            source_scope={"mode": "study-sources", "sources": bindings},
        ),
        directory,
    )
    policy = load_policy(directory / "agent-policy.json")
    assert receipt["sources"] == bindings
    assert set(policy.sources) == {first["id"], second["id"]}
    assert policy.sources[first["id"]].t == (0, 1)
    assert policy.sources[first["id"]].c == (0, 1)
    assert policy.sources[second["id"]].crop == (0, 0, 7, 6)
    tifffile.imwrite(tmp_path / "later.tif", np.ones((4, 5), np.uint16))
    later = workbench.import_native(str(tmp_path / "later.tif"))
    with pytest.raises(PermissionError, match="source identity"):
        PolicyAgent(policy).inspect_source(later["id"])


@pytest.mark.parametrize(
    "name", ["../escape", "nested/name", "nested\\name", ".", "..", "bad\nname", "x" * 81]
)
def test_directory_export_scope_still_rejects_unsafe_names(tmp_path, name):
    agent, _, result, *_ = actions_agent(tmp_path)
    with pytest.raises(PermissionError, match="destination"):
        agent.export_result(result["id"], result["revision_hash"], name)


def test_real_stdio_exposes_native_actions_with_strict_outer_arguments(tmp_path):
    _, _, result, path, *_ = actions_agent(tmp_path)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            assert tools["inspect_action"].annotations.read_only_hint is True
            assert tools["submit_action"].annotations.read_only_hint is False
            bad = await session.call_tool(
                "inspect_action", {"operation": "correction_info", "request": {}, "actor": "human"}
            )
            assert bad.is_error
            bad_page = await session.call_tool("study_results", {"limit": "1"})
            assert bad_page.is_error
            info = await session.call_tool(
                "inspect_action",
                {
                    "operation": "correction_info",
                    "request": {
                        "result_id": result["id"],
                        "revision_hash": result["revision_hash"],
                    },
                },
            )
            assert not info.is_error, info
            assert info.structured_content["label_ids"] == [1]

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))


def test_capacity_refusal_has_retry_guidance_without_disclosing_private_error(
    tmp_path, monkeypatch
):
    from loci_engine.research_mcp import AgentCapacityError, build_server

    _, _, _, path, *_ = actions_agent(tmp_path)

    def busy(*args, **kwargs):
        raise AgentCapacityError(str(tmp_path / "private-source"))

    monkeypatch.setattr(PolicyAgent, "inspect_action", busy)
    server = build_server(path)

    async def exercise():
        from mcp.server.mcpserver.exceptions import ToolError

        with pytest.raises(ToolError) as error:
            await server.call_tool(
                "inspect_action", {"operation": "population_locate", "request": {}}
            )
        text = str(error.value)
        assert "concurrency allowance" in text
        assert "Wait for it to finish" in text
        assert str(tmp_path) not in text
        tools = {item.name: item for item in await server.list_tools()}
        assert tools["result_view"].input_schema["properties"]["axis"]["enum"] == ["x", "y", "z"]

    asyncio.run(exercise())


def test_inspection_capacity_remains_fail_closed_before_worker_start(tmp_path):
    from loci_engine.research_mcp import AgentCapacityError

    agent, workbench, result, *_ = actions_agent(tmp_path)
    agent.supervisor._preview_count = agent.policy.concurrency
    with pytest.raises(AgentCapacityError):
        agent.supervisor.vision(
            workbench,
            {
                "operation": "population_locate",
                "request": {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "label": 1,
                },
            },
            "inspect_action",
        )
    assert agent.supervisor._preview_count == agent.policy.concurrency
