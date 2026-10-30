"""PolicyAgent graph adapter boundaries over native jobs, without a second scheduler."""

from dataclasses import replace
from uuid import uuid4

import pytest
from test_agent_actions import actions_agent
from test_research_workflow_graph import definition

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_workflow_graph import (
    CONTROL_TOOL,
    GRAPH_CONTROL_REQUEST_SCHEMA,
    GRAPH_INSPECT_REQUEST_SCHEMA,
    INSPECT_TOOL,
    workflow_graph_control,
    workflow_graph_inspect,
)
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import canonical_json


class NativeSupervisor:
    def __init__(self, agent, *, execute=False):
        self.agent = agent
        self.execute = execute
        self.submissions = []
        self.cancellations = []

    def start(self, workbench, request, key, operation="run_recipe"):
        job = submit_job(workbench, request, key, operation=operation, owner=self.agent.job_owner)
        self.submissions.append((operation, job["id"], key))
        if self.execute:
            run_job(workbench, job["id"])
        return workbench.project.job(job["id"])

    def cancel(self, project, job_id):
        self.cancellations.append(job_id)
        return cancel_job(project, job_id)


@pytest.fixture
def graph_agent(tmp_path):
    agent, workbench, result, path, _, spec, _ = actions_agent(tmp_path)
    spec["operations"] = sorted(set(spec["operations"]) | {CONTROL_TOOL, INSPECT_TOOL})
    write_policy(path, workbench.project, spec)
    agent = PolicyAgent(load_policy(path))
    supervisor = NativeSupervisor(agent)
    agent.supervisor = supervisor
    graph = definition()
    graph["nodes"][1]["settings"]["recipe"]["segmentation"]["threshold"] = 150
    selected = {"x": 0, "y": 0, "width": 32, "height": 32, "z": 1, "t": 0, "c": 0, "level": 0}
    saved = workflow_graph_control(
        agent,
        "workflow_graph_save",
        {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": graph},
    )["workflow"]
    binding = {
        "workflow_id": saved["id"],
        "workflow_revision": saved["revision"],
        "definition_sha256": saved["data"]["definition_sha256"],
        "bindings": {
            "image": {
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "selection": selected,
            }
        },
    }
    plan = workflow_graph_inspect(agent, "workflow_graph_preflight", binding)["plan"]
    start = {**binding, "plan_sha256": plan["plan_sha256"], "request_key": "agent-native-graph"}
    return agent, workbench, start, supervisor, path, spec


def test_agent_control_uses_its_existing_owned_native_jobs_and_no_parent_job(graph_agent):
    agent, wb, request, supervisor, *_ = graph_agent
    supervisor.execute = True
    run = workflow_graph_control(agent, "workflow_graph_start", request)["run"]
    for _ in range(3):
        run = workflow_graph_control(agent, "workflow_graph_advance", {"run_id": run["id"]})["run"]
    status = workflow_graph_inspect(agent, "workflow_graph_status", {"run_id": run["id"]})
    assert status["state"] == "succeeded"
    assert len(supervisor.submissions) == len(wb.project.list_jobs()) == 3
    assert all(
        job["owner"] == agent.job_owner and job["id"] != run["id"] for job in wb.project.list_jobs()
    )
    assert len(status["partial_results"]) == 3
    assert all(
        wb.project.review_state(item["result_id"]) is None for item in status["partial_results"]
    )
    assert workflow_graph_control(agent, "workflow_graph_start", request)["run"]["id"] == run["id"]


@pytest.mark.parametrize(
    "mutation",
    [
        "leaf_grant",
        "submit_tool",
        "memory",
        "runtime",
        "source",
        "channel",
        "revision",
        "disclosure",
    ],
)
def test_graph_control_does_not_infer_native_grants_or_widen_scope(graph_agent, mutation):
    agent, wb, request, supervisor, *_ = graph_agent
    if mutation == "leaf_grant":
        agent.policy = replace(agent.policy, actions=agent.policy.actions - {"run_recipe"})
    elif mutation == "submit_tool":
        agent.policy = replace(
            agent.policy, operations=agent.policy.operations - {"submit_recipe", "submit_action"}
        )
    elif mutation == "memory":
        agent.policy = replace(agent.policy, memory_bytes=1024**2)
    elif mutation == "runtime":
        agent.policy = replace(agent.policy, runtimes=[])
    elif mutation == "source":
        request["bindings"]["image"]["source_id"] = "0" * 32
    elif mutation == "channel":
        request["bindings"]["image"]["selection"]["c"] = 1
    elif mutation == "revision":
        request["bindings"]["image"]["source_sha256"] = "0" * 64
    else:
        agent.policy = replace(agent.policy, disclosures=agent.policy.disclosures - {"provenance"})
    with pytest.raises((PermissionError, ValueError)):
        workflow_graph_control(agent, "workflow_graph_start", request)
    assert not supervisor.submissions and not wb.project.list_jobs()
    assert not wb.project.documents("workflow_run")


def test_control_and_inspection_need_their_own_explicit_policy_operations(graph_agent):
    agent, wb, request, supervisor, *_ = graph_agent
    agent.policy = replace(
        agent.policy, operations=agent.policy.operations - {CONTROL_TOOL, INSPECT_TOOL}
    )
    with pytest.raises(PermissionError, match="operation"):
        workflow_graph_control(agent, "workflow_graph_start", request)
    with pytest.raises(PermissionError, match="operation"):
        workflow_graph_inspect(agent, "workflow_graph_get", {"workflow_id": request["workflow_id"]})
    assert not supervisor.submissions and not wb.project.list_jobs()


def test_status_and_cancel_do_not_allow_other_run_owners(graph_agent):
    agent, wb, request, supervisor, *_ = graph_agent
    run = workflow_graph_control(agent, "workflow_graph_start", request)["run"]
    from loci_engine.agent_sessions import start_session

    session = start_session(wb.project, agent.policy, client_id="second-valid-client")
    agent.session_id = session["session_id"]
    with pytest.raises(PermissionError, match="another policy or session"):
        workflow_graph_inspect(agent, "workflow_graph_status", {"run_id": run["id"]})
    with pytest.raises(PermissionError, match="another policy or session"):
        workflow_graph_control(agent, "workflow_graph_cancel", {"run_id": run["id"]})
    assert not supervisor.cancellations and not wb.project.list_jobs()


def test_policy_revocation_after_start_blocks_resume_before_submission(graph_agent):
    agent, wb, request, supervisor, path, _ = graph_agent
    run = workflow_graph_control(agent, "workflow_graph_start", request)["run"]
    path.unlink()
    with pytest.raises(ValueError, match="plain file"):
        workflow_graph_control(agent, "workflow_graph_advance", {"run_id": run["id"]})
    assert not supervisor.submissions and not wb.project.list_jobs()


def test_cancel_targets_only_exact_owned_native_children(graph_agent):
    agent, wb, request, supervisor, *_ = graph_agent
    run = workflow_graph_control(agent, "workflow_graph_start", request)["run"]
    run = workflow_graph_control(agent, "workflow_graph_advance", {"run_id": run["id"]})["run"]
    status = workflow_graph_control(agent, "workflow_graph_cancel", {"run_id": run["id"]})
    job = wb.project.list_jobs()[0]
    assert status["state"] == "cancelled"
    assert supervisor.cancellations == [job["id"]]
    assert job["state"] == "cancelled" and job["owner"] == agent.job_owner


def test_read_schema_is_separate_and_unknown_arguments_fail_before_control(graph_agent):
    agent, wb, request, supervisor, *_ = graph_agent
    assert GRAPH_CONTROL_REQUEST_SCHEMA["anyOf"] and GRAPH_INSPECT_REQUEST_SCHEMA["anyOf"]
    bad = {**request, "run_shell": "arbitrary"}
    with pytest.raises(ValueError):
        workflow_graph_control(agent, "workflow_graph_start", bad)
    with pytest.raises(ValueError, match="inspection or control"):
        workflow_graph_control(agent, "workflow_graph_status", {"run_id": "0" * 32})
    with pytest.raises(ValueError, match="inspection or control"):
        workflow_graph_inspect(agent, "workflow_graph_start", request)
    assert not wb.project.list_jobs() and not supervisor.submissions


def test_recursive_external_result_revision_is_authorized_before_preflight(graph_agent):
    agent, wb, request, supervisor, *_ = graph_agent
    result = wb.project.list_results()[0]
    graph = definition()
    graph["inputs"] = {"cells": "label-result", "nuclei": "label-result"}
    graph["nodes"] = [graph["nodes"][-1]]
    graph["nodes"][0]["inputs"] = {role: {"input": role} for role in ("cells", "nuclei")}
    saved = workflow_graph_control(
        agent,
        "workflow_graph_save",
        {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": graph},
    )["workflow"]
    body = {
        "workflow_id": saved["id"],
        "workflow_revision": saved["revision"],
        "definition_sha256": saved["data"]["definition_sha256"],
        "bindings": {
            role: {"result_id": result["id"], "revision_hash": "0" * 64}
            for role in ("cells", "nuclei")
        },
    }
    with pytest.raises(PermissionError, match="revision"):
        workflow_graph_inspect(agent, "workflow_graph_preflight", body)
    assert not supervisor.submissions


def test_list_filters_definitions_with_ungranted_native_operations(graph_agent):
    agent, _, request, _, *_ = graph_agent
    agent.policy = replace(agent.policy, actions=agent.policy.actions - {"associate_results"})
    result = workflow_graph_inspect(agent, "workflow_graph_list", {})
    assert result == {"workflows": []}
    assert request["workflow_id"] not in canonical_json(result)


def test_real_stdio_graph_schemas_strict_arguments_and_owned_native_pipeline(graph_agent):
    import asyncio
    import tempfile
    import time

    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client
    from test_research_mcp import stdio_parameters

    _, wb, request, _, path, _ = graph_agent

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            assert tools[INSPECT_TOOL].annotations.read_only_hint is True
            assert tools[CONTROL_TOOL].annotations.read_only_hint is False
            control_schema = tools[CONTROL_TOOL].input_schema
            inspect_schema = tools[INSPECT_TOOL].input_schema
            assert "workflow_graph_start" in control_schema["properties"]["operation"]["enum"]
            assert "workflow_graph_status" in inspect_schema["properties"]["operation"]["enum"]
            assert control_schema["properties"]["request"]["anyOf"]
            bad = await session.call_tool(
                CONTROL_TOOL,
                {"operation": "workflow_graph_start", "request": request, "actor": "human"},
            )
            assert bad.is_error
            started = await session.call_tool(
                CONTROL_TOOL, {"operation": "workflow_graph_start", "request": request}
            )
            assert not started.is_error, started
            run_id = started.structured_content["run"]["id"]
            deadline = time.monotonic() + 25
            completed_children = set()
            while time.monotonic() < deadline:
                advanced = await session.call_tool(
                    CONTROL_TOOL,
                    {"operation": "workflow_graph_advance", "request": {"run_id": run_id}},
                )
                assert not advanced.is_error, advanced
                # Result publication can precede worker exit. Follow the actual
                # concurrency contract before dispatching another native node.
                for node in advanced.structured_content["run"]["data"]["nodes"].values():
                    intent = node.get("intent")
                    if not intent or intent["job_id"] in completed_children:
                        continue
                    child_id = intent["job_id"]
                    while time.monotonic() < deadline:
                        child = await session.call_tool("job_status", {"job_id": child_id})
                        assert not child.is_error, child
                        job = child.structured_content["job"]
                        if job["state"] in {"succeeded", "failed", "cancelled", "interrupted"}:
                            assert job["state"] == "succeeded", job
                            if job["owned_worker_active"] is False:
                                completed_children.add(child_id)
                                break
                        await asyncio.sleep(0.05)
                    else:
                        raise AssertionError("Owned graph child did not finish and exit")
                state = await session.call_tool(
                    INSPECT_TOOL,
                    {"operation": "workflow_graph_status", "request": {"run_id": run_id}},
                )
                assert not state.is_error, state
                if state.structured_content["state"] in {"succeeded", "failed", "cancelled"}:
                    assert state.structured_content["state"] == "succeeded", state
                    assert len(state.structured_content["partial_results"]) == 3
                    assert len(completed_children) == 3
                    return run_id
                await asyncio.sleep(0.05)
            raise AssertionError("Bounded native graph pipeline did not complete")

    with tempfile.TemporaryFile(mode="w+") as errlog:
        run_id = asyncio.run(exercise(errlog))
    jobs = wb.project.list_jobs()
    assert len(jobs) == 3 and all(job["owner"]["session_id"] is not None for job in jobs)
    assert all(job["id"] != run_id for job in jobs)


def test_inspect_only_session_reads_graph_metadata_and_blocks_control(graph_agent):
    from loci_engine.agent_sessions import start_session

    agent, wb, request, supervisor, path, spec = graph_agent
    spec["permission_mode"] = "inspect_only"
    write_policy(path, wb.project, spec)
    policy = load_policy(path)
    session = start_session(wb.project, policy, client_id="inspect-graph-client")
    agent = PolicyAgent(policy, session_id=session["session_id"], approval_wait_seconds=0.01)
    readable = workflow_graph_inspect(
        agent, "workflow_graph_get", {"workflow_id": request["workflow_id"]}
    )
    assert readable["workflow"]["id"] == request["workflow_id"]
    with pytest.raises(PermissionError, match="Inspect-only"):
        workflow_graph_control(agent, "workflow_graph_start", request)
    assert not wb.project.list_jobs() and not wb.project.documents("workflow_run")
    assert not supervisor.submissions
