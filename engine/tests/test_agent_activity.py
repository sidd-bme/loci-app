from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import shutil
import tempfile
from types import SimpleNamespace

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_sessions import session_fixture
from test_research_mcp import stdio_parameters
from test_research_workflow import definition

from loci_engine.agent_activity import collect_targets, targets_stale
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_sessions import (
    AgentSessionApprovalError,
    agent_sessions_snapshot,
    check_or_await_approval,
    control_agent_session,
    record_agent_activity,
    register_policy,
    start_session,
)
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import ResearchProject, canonical_json


def test_actual_stdio_call_records_one_inspection_and_failed_call_without_private_payload(tmp_path):
    policy, wb, result, path, request, _, _ = session_fixture(tmp_path)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as client,
        ):
            await client.initialize()
            response = await client.call_tool("inspect_source", {"source_id": request["source_id"]})
            assert not response.is_error
            response = await client.call_tool("result", {"result_id": result["id"]})
            assert not response.is_error
            response = await client.call_tool(
                "inspect_source", {"source_id": "/private/secret.tif"}
            )
            assert response.is_error
            snap = wb.snapshot()["agent_sessions"]
            calls = [e for e in snap["events"] if e["kind"] == "operation_inspected"]
            assert len(calls) == 2
            source_event = next(e for e in calls if e["operation"] == "inspect_source")
            assert source_event["targets"] == [
                {
                    "kind": "source",
                    "id": request["source_id"],
                    "sha256": policy.sources[request["source_id"]].sha256,
                }
            ]
            result_event = next(e for e in calls if e["operation"] == "result")
            assert any(
                t["kind"] == "result" and t["revision_hash"] == result["revision_hash"]
                for t in result_event["targets"]
            )
            failed = [e for e in snap["events"] if e["kind"] == "operation_failed"]
            assert len(failed) == 1 and not failed[0].get("targets")
            assert "/private/secret" not in json.dumps(snap)
            assert str(tmp_path) not in json.dumps(snap)

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))


def test_preview_submission_and_durable_completion_are_distinct_recovered_once(tmp_path):
    policy, wb, _, _, request, _, _ = session_fixture(tmp_path)
    session = start_session(wb.project, policy)
    agent = PolicyAgent(policy, session_id=session["session_id"])
    job = submit_job(wb, request, "activity-preview", "preview_recipe", owner=agent.job_owner)
    record_agent_activity(
        agent,
        "submit_recipe",
        {"request": request},
        {"structuredContent": {"job": {"id": job["id"]}}},
    )
    first = agent_sessions_snapshot(wb.project)
    submitted = next(e for e in first["events"] if e["kind"] == "operation_submitted")
    assert {"kind": "job", "id": job["id"]} in submitted["targets"]
    assert not any(e["kind"] == "operation_completed" for e in first["events"])
    results_before = wb.project.list_results()
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    reopened = ResearchProject(wb.project.root)
    recovered = agent_sessions_snapshot(reopened)
    completed = [e for e in recovered["events"] if e["kind"] == "operation_completed"]
    assert len(completed) == 1
    assert {"kind": "job", "id": job["id"]} in completed[0]["targets"]
    assert not any(t["kind"] == "result" for t in completed[0]["targets"])
    again = agent_sessions_snapshot(reopened)
    assert [e for e in again["events"] if e["kind"] == "operation_completed"] == completed
    assert wb.project.list_results() == results_before


def test_published_result_completion_uses_exact_revision_not_return_code(tmp_path):
    policy, wb, _, _, request, _, _ = session_fixture(tmp_path)
    session = start_session(wb.project, policy)
    owner = {"policy_sha256": policy.content_sha256, "session_id": session["session_id"]}
    job = submit_job(wb, request, "activity-result", owner=owner)
    output = run_job(wb, job["id"])
    snap = agent_sessions_snapshot(wb.project)
    event = next(e for e in snap["events"] if e["kind"] == "operation_completed")
    exact = next(t for t in event["targets"] if t["kind"] == "result")
    assert exact["id"] == output["result"]["id"]
    assert exact["revision_hash"] == output["result"]["revision_hash"]


def test_approval_binds_secondary_source_and_multiple_results_and_rechecks_disk(tmp_path):
    policy, wb, result, _, request, _, _ = session_fixture(tmp_path, permission_mode="ask_approval")
    source_path = tmp_path / "secondary.tif"
    shutil.copyfile(tmp_path / "synthetic.tif", source_path)
    secondary = wb.import_native(str(source_path))
    other = wb.run_recipe({**request, "source_id": secondary["id"]})["result"]
    session = start_session(wb.project, policy)
    agent = PolicyAgent(policy, session_id=session["session_id"], approval_wait_seconds=0)
    payload = {
        "operation": "track_link",
        "request": {
            "frames": [
                {"result_id": result["id"], "revision_hash": result["revision_hash"]},
                {"result_id": other["id"], "revision_hash": other["revision_hash"]},
            ]
        },
    }
    with pytest.raises(AgentSessionApprovalError):
        check_or_await_approval(agent, wb, "submit_action", payload)
    approval = wb.snapshot()["agent_sessions"]["approvals"][0]
    assert {t["id"] for t in approval["targets"] if t["kind"] == "result"} == {
        result["id"],
        other["id"],
    }
    control_agent_session(wb, {"action": "approve_request", "approval_id": approval["id"]})
    # Metadata remains unchanged while the actual secondary source bytes change.
    source_path.write_bytes(source_path.read_bytes() + b"changed")
    # Refresh uses metadata only; full bytes are checked at the consumption boundary.
    assert wb.snapshot()["agent_sessions"]["approvals"][0]["state"] == "approved"
    with pytest.raises(AgentSessionApprovalError, match="changed before execution"):
        check_or_await_approval(agent, wb, "submit_action", payload)
    snap = wb.snapshot()["agent_sessions"]
    assert snap["approvals"][0]["state"] == "stale"
    assert wb.project.source(secondary["id"])["sha256"] == secondary["sha256"]
    assert str(tmp_path) not in json.dumps(snap)


def test_workflow_revision_dependency_and_explicit_source_selection(tmp_path):
    _, wb, _, _, request, _, _ = session_fixture(tmp_path)
    doc = wb.execute(
        "workflow_save",
        {"workflow_id": "a" * 32, "expected_revision": 0, "definition": definition()},
    )["workflow"]
    selection = {"x": 1, "y": 2, "width": 10, "height": 12, "c": 0, "z": 1, "t": 0, "level": 0}
    targets = collect_targets(
        wb.project,
        {
            "workflow_id": doc["id"],
            "workflow_revision": 1,
            "definition_sha256": doc["data"]["definition_sha256"],
            "source_id": request["source_id"],
            "selection": selection,
            "notes": "/private/note",
            "id": "b" * 32,
        },
    )
    assert next(t for t in targets if t["kind"] == "source")["selection"] == selection
    assert not targets_stale(wb.project, targets)
    updated = definition()
    updated["name"] = "Revised"
    wb.execute(
        "workflow_save", {"workflow_id": doc["id"], "expected_revision": 1, "definition": updated}
    )
    assert targets_stale(wb.project, targets)
    assert "/private/note" not in canonical_json(targets)


def test_activity_ignores_unregistered_operation_and_raw_failed_target(tmp_path):
    policy, wb, *_ = session_fixture(tmp_path)
    session = start_session(wb.project, policy)
    agent = SimpleNamespace(policy=policy, session_id=session["session_id"])
    record_agent_activity(agent, "/private/operation", {}, {}, failed=True)
    record_agent_activity(
        agent, "inspect_source", {"source_id": "/private/source"}, {}, failed=True
    )
    assert "/private/" not in canonical_json(agent_sessions_snapshot(wb.project))


def test_mcp_workflow_export_records_only_verified_native_receipt(tmp_path):
    policy, wb, _, _, request, _, root = session_fixture(tmp_path)
    doc = wb.execute(
        "workflow_save",
        {"workflow_id": "c" * 32, "expected_revision": 0, "definition": definition()},
    )["workflow"]
    binding = {
        "workflow_id": doc["id"],
        "workflow_revision": 1,
        "definition_sha256": doc["data"]["definition_sha256"],
        "source_id": request["source_id"],
        "source_sha256": policy.sources[request["source_id"]].sha256,
        "selection": {"z": 1},
    }
    job = submit_job(wb, binding, "activity-workflow", "workflow_run")
    output = run_job(wb, job["id"])
    result = output["result"]
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    agent = PolicyAgent(policy)
    receipt = agent.export_result(result["id"], result["revision_hash"], "workflow-export")
    assert receipt["workflow_run_id"] == job["id"]
    status = wb.execute("workflow_status", {"run_id": job["id"]})
    assert status["state"] == "exported" and status["export_count"] == 1
    assert status["exports"][0]["data"]["receipt"] == {
        k: v for k, v in receipt.items() if k != "workflow_run_id"
    }
    # A correction retains historical workflow settings but is a distinct
    # revision, not the exact original workflow run's export.
    correction = wb.execute(
        "correction_info", {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    )
    child = wb.execute(
        "correct_result",
        {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "operations": [
                {
                    "op": "delete",
                    "label": correction["label_ids"][0],
                    "expected_input_sha256": correction["label_sha256"],
                }
            ],
        },
    )["result"]
    wb.project.review(child["id"], child["revision_hash"], "reviewed")
    child_receipt = agent.export_result(
        child["id"], child["revision_hash"], "corrected-workflow-export"
    )
    assert child_receipt["result_id"] == child["id"]
    assert "workflow_run_id" not in child_receipt
    assert len(wb.project.documents("workflow_export")) == 1
    assert (root / child_receipt["export_name"] / "manifest.json").is_file()

    from loci_engine.research_workflow import record_verified_export

    manifest = root / receipt["export_name"] / "manifest.json"
    manifest.write_text("{}")
    with pytest.raises(ValueError, match="manifest"):
        record_verified_export(wb, status["run"], receipt, manifest.parent)
    assert len(wb.project.documents("workflow_export")) == 1


def test_successful_source_image_records_explicit_plane_region_only(tmp_path):
    _, wb, _, path, request, spec, _ = session_fixture(tmp_path)
    spec["operations"].append("source_image")
    write_policy(path, wb.project, spec)
    policy = load_policy(path)
    register_policy(wb.project, policy)
    selection = {"x": 2, "y": 3, "width": 16, "height": 12, "c": 0, "z": 1, "t": 0, "level": 0}
    view = {
        "source_id": request["source_id"],
        "selection": selection,
        "projection": "plane",
        "max_size": 64,
        "channels": [
            {
                "channel": 0,
                "low": 0,
                "high": 100,
                "gamma": 1,
                "color": "#ffffff",
                "opacity": 1,
                "visible": True,
            }
        ],
    }

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as client,
        ):
            await client.initialize()
            rendered = await client.call_tool("source_image", {"request": view})
            assert not rendered.is_error, rendered
            events = wb.snapshot()["agent_sessions"]["events"]
            viewed = [
                e
                for e in events
                if e["kind"] == "operation_inspected" and e["operation"] == "source_image"
            ]
            assert len(viewed) == 1
            assert (
                next(t for t in viewed[0]["targets"] if t["kind"] == "source")["selection"]
                == selection
            )
            assert "projection" not in canonical_json(viewed[0])
            assert "image/png" not in canonical_json(viewed[0])

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))


@pytest.mark.parametrize("mode", ["inspect_only", "ask_approval"])
@pytest.mark.parametrize(
    "action", ["workflow_preview", "exploration_preview", "exploration_compare"]
)
def test_new_preview_tasks_cannot_bypass_consequential_approval(
    tmp_path, monkeypatch, mode, action
):
    policy, wb, _, _, request, _, _ = session_fixture(tmp_path, permission_mode=mode)
    session = start_session(wb.project, policy)
    agent = PolicyAgent(policy, session_id=session["session_id"], approval_wait_seconds=0)
    selection = {"x": 0, "y": 0, "width": 32, "height": 32, "t": 0, "c": 0, "z": 1, "level": 0}
    source = {
        "source_id": request["source_id"],
        "source_sha256": policy.sources[request["source_id"]].sha256,
    }
    if action == "workflow_preview":
        doc = wb.execute(
            "workflow_save",
            {"workflow_id": "d" * 32, "expected_revision": 0, "definition": definition()},
        )["workflow"]
        proposed = {
            **source,
            "selection": selection,
            "workflow_id": doc["id"],
            "workflow_revision": 1,
            "definition_sha256": doc["data"]["definition_sha256"],
            "target_node_id": "segment",
        }
    elif action == "exploration_preview":
        proposed = {**source, "selection": selection, "threshold": 50, "min_size": 0}
    else:
        proposed = {
            **source,
            "regions": [selection],
            "configurations": [{"threshold": 50, "min_size": 0}],
        }
    started = []
    monkeypatch.setattr(agent.supervisor, "start", lambda *args, **kwargs: started.append(True))
    with pytest.raises(AgentSessionApprovalError):
        agent.submit_action(action, proposed, "must-not-execute")
    assert started == [] and wb.project.list_jobs() == []
    snap = wb.snapshot()["agent_sessions"]
    if mode == "ask_approval":
        approval = snap["approvals"][0]
        assert approval["state"] == "pending" and approval["action_name"] == action
        assert any(
            t["kind"] == "source" and t["id"] == source["source_id"] for t in approval["targets"]
        )
        if action == "workflow_preview":
            assert any(t["kind"] == "workflow" and t["revision"] == 1 for t in approval["targets"])
    else:
        assert snap["approvals"] == []


@pytest.mark.parametrize("preview_case", ["exploration_preview", "exploration_compare"])
def test_actual_mcp_retrieves_owned_persisted_preview_and_links_job(tmp_path, preview_case):
    policy, wb, _, path, request, _, _ = session_fixture(tmp_path)
    selection = {"x": 0, "y": 0, "width": 32, "height": 32, "t": 0, "c": 0, "z": 1, "level": 0}
    proposed = {
        "source_id": request["source_id"],
        "source_sha256": policy.sources[request["source_id"]].sha256,
        "selection": selection,
        "threshold": 50,
        "min_size": 0,
    }

    if preview_case == "exploration_compare":
        proposed = {
            "source_id": proposed["source_id"],
            "source_sha256": proposed["source_sha256"],
            "regions": [selection],
            "configurations": [{"threshold": 40, "min_size": 0}, {"threshold": 60, "min_size": 0}],
        }

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as client,
        ):
            await client.initialize()
            session = wb.snapshot()["agent_sessions"]["sessions"][0]
            job = submit_job(
                wb,
                proposed,
                "stored-agent-preview",
                preview_case,
                owner={"policy_sha256": policy.content_sha256, "session_id": session["session_id"]},
            )
            run_job(wb, job["id"])
            from loci_engine.research_task_preview import get_preview

            before = get_preview(wb.project, job["id"])
            before_json = canonical_json(before)
            response = await client.call_tool(
                "inspect_action",
                {"operation": "task_preview_get", "request": {"job_id": job["id"]}},
            )
            assert not response.is_error, response
            decoded = json.loads(
                next(block.text for block in response.content if block.type == "text")
            )
            assert decoded["preview"]["job_id"] == job["id"]
            assert decoded["preview"]["adopted"] is False
            assert decoded["preview"]["output_sha256"] == before["preview"]["output_sha256"]
            assert canonical_json(get_preview(wb.project, job["id"])) == before_json
            images = [item for item in response.content if item.type == "image"]
            expected_paths = (
                ["/preview/output/image", "/preview/output/label_image"]
                if preview_case == "exploration_preview"
                else [
                    f"/preview/output/cells/{i}/{key}"
                    for i in range(2)
                    for key in ("image", "label_image")
                ]
            )
            assert len(images) == len(expected_paths)
            transport = decoded["image_transport"]
            assert (
                transport["output_sha256_scope"]
                == "original-canonical-output-including-image-data-urls"
            )
            assert [item["json_pointer"] for item in transport["images"]] == expected_paths
            for position, mapping in enumerate(transport["images"], 1):
                block = response.content[mapping["content_index"]]
                assert mapping["content_index"] == position and block.type == "image"
                assert mapping["sha256"] == hashlib.sha256(base64.b64decode(block.data)).hexdigest()
            assert "data:image/png" not in canonical_json(decoded)
            events = wb.snapshot()["agent_sessions"]["events"]
            event = next(
                e
                for e in events
                if e["operation"] == "task_preview_get" and e["kind"] == "operation_inspected"
            )
            assert {"kind": "job", "id": job["id"]} in event["targets"]
            assert len(wb.project.list_jobs()) == 1
            foreign = start_session(wb.project, policy, client_id="other-session")
            outsider = PolicyAgent(policy, session_id=foreign["session_id"])
            with pytest.raises(PermissionError, match="different policy or session"):
                outsider.inspect_action("task_preview_get", {"job_id": job["id"]})
            # A hash-consistent invalid image must still fail the actual image transport boundary.
            altered = copy.deepcopy(before["preview"])
            container = (
                altered["output"]
                if preview_case == "exploration_preview"
                else altered["output"]["cells"][0]
            )
            container["image"] = "data:image/png;base64,bm90LXBuZw=="
            altered["output_sha256"] = hashlib.sha256(
                canonical_json(altered["output"]).encode()
            ).hexdigest()
            with wb.project.connection() as connection:
                connection.execute(
                    "UPDATE metadata SET value=? WHERE key=?",
                    (canonical_json(altered), "task-preview:" + job["id"]),
                )
            invalid = await client.call_tool(
                "inspect_action",
                {"operation": "task_preview_get", "request": {"job_id": job["id"]}},
            )
            assert invalid.is_error and not any(item.type == "image" for item in invalid.content)
            assert str(tmp_path) not in str(invalid)

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
