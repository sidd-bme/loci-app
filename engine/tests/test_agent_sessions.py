from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import time

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_actions import actions_agent
from test_agent_review import decision
from test_research_agent_setup import access_request
from test_research_mcp import stdio_parameters

from loci_engine.agent_policy import SESSION_POLICY_SCHEMA, load_policy, write_policy
from loci_engine.agent_sessions import (
    AgentSessionApprovalError,
    capability_map,
    control_agent_session,
    reconcile_agent_sessions,
    register_policy,
    start_session,
)
from loci_engine.research_action_registry import ACTION_NAMES
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_operations import OPERATION_CATALOG
from loci_engine.workbench import Workbench


def session_fixture(tmp_path, *, permission_mode="full_access"):
    _, workbench, result, path, request, spec, root = actions_agent(tmp_path)
    spec["operations"] = sorted(
        set(spec["operations"])
        | {
            "inspect_source",
            "analysis_context",
            "source_display",
            "set_source_display",
        }
    )
    spec["permission_mode"] = permission_mode
    write_policy(path, workbench.project, spec)
    policy = load_policy(path)
    register_policy(workbench.project, policy, bundle_name="session-test-bundle")
    return policy, workbench, result, path, request, spec, root


def test_renderer_wire_fixture_matches_live_session_snapshot(tmp_path):
    from pathlib import Path

    policy, workbench, result, _, _, _, _ = session_fixture(
        tmp_path, permission_mode="ask_approval"
    )
    session = start_session(workbench.project, policy)
    agent = PolicyAgent(policy, session_id=session["session_id"], approval_wait_seconds=0)
    with pytest.raises(AgentSessionApprovalError):
        agent.review_result(decision(result))
    actual = workbench.snapshot()["agent_sessions"]
    fixture_path = (
        Path(__file__).parents[2] / "desktop/src/renderer/__fixtures__/agent-sessions-snapshot.json"
    )
    fixture = json.loads(fixture_path.read_text())
    assert set(actual) == set(fixture)
    for section in ("policies", "sessions", "approvals", "events"):
        assert set(actual[section][0]) - {"targets"} == set(fixture[section][0]), section
    assert set(actual["capability_map"]) == set(fixture["capability_map"])
    assert set(actual["capability_map"]["counts"]) == set(fixture["capability_map"]["counts"])
    assert set(actual["capability_map"]["entries"][0]) == set(
        fixture["capability_map"]["entries"][0]
    )
    assert actual["status"] == fixture["status"] == "awaiting_approval"
    assert actual["connected_count"] == fixture["connected_count"] == 1
    assert actual["approvals"][0]["state"] == fixture["approvals"][0]["state"] == "pending"


def test_configuration_ready_does_not_claim_connected_client(tmp_path):
    _, workbench, _, _, request, _, root = actions_agent(tmp_path)
    bundle_req = access_request(request, permission_mode="ask_approval")
    created = create_agent_access(workbench, bundle_req, root / "bundle-ready")
    assert created["permission_mode"] == "ask_approval"

    snap = workbench.snapshot()
    sessions_snap = snap["agent_sessions"]
    assert sessions_snap["status"] == "configuration_ready"
    assert sessions_snap["connected_count"] == 0
    assert sessions_snap["pending_approval_count"] == 0
    assert len(sessions_snap["policies"]) == 1
    assert sessions_snap["policies"][0]["state"] == "configuration_ready"
    assert sessions_snap["policies"][0]["permission_mode"] == "ask_approval"
    assert sessions_snap["sessions"] == []
    assert str(tmp_path) not in json.dumps(snap)


def test_real_mcp_stdio_session_presence_heartbeat_and_clean_disconnect(tmp_path):
    policy, workbench, _, path, request, _, _ = session_fixture(
        tmp_path, permission_mode="full_access"
    )
    assert policy.schema == SESSION_POLICY_SCHEMA
    assert workbench.snapshot()["agent_sessions"]["status"] == "configuration_ready"

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            live = workbench.snapshot()["agent_sessions"]
            assert live["status"] == "connected_idle"
            assert live["connected_count"] == 1
            assert len(live["sessions"]) == 1
            active_session = live["sessions"][0]
            assert active_session["state"] == "connected_idle"
            assert active_session["policy_sha256"] == policy.content_sha256
            assert active_session["identity_assurance"] == "declared"
            assert "private_pid" not in active_session

            inspected = await session.call_tool(
                "inspect_source", {"source_id": request["source_id"]}
            )
            assert not inspected.is_error
            after_call = workbench.snapshot()["agent_sessions"]["sessions"][0]
            assert after_call["tool_calls_count"] >= 1
            assert after_call["last_operation"] == "inspect_source"
            assert after_call["state"] == "connected_idle"

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))

    after_close = workbench.snapshot()["agent_sessions"]
    assert after_close["status"] == "disconnected"
    assert after_close["connected_count"] == 0
    assert after_close["sessions"][0]["state"] == "disconnected"


def test_abrupt_process_loss_and_heartbeat_ttl_transition_to_interrupted(tmp_path):
    policy, workbench, result, _, _, _, _ = session_fixture(
        tmp_path, permission_mode="ask_approval"
    )

    # Start a session bound to a non-existent PID and create a pending approval.
    started = start_session(workbench.project, policy, client_id="abrupt-client", pid=999_999_991)
    agent = PolicyAgent(policy, session_id=started["session_id"], approval_wait_seconds=0.0)
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.review_result(decision(result))

    reconcile_agent_sessions(workbench.project, heartbeat_ttl_seconds=1.0)
    snap = workbench.snapshot()["agent_sessions"]
    assert snap["status"] == "interrupted"
    assert snap["connected_count"] == 0
    assert snap["sessions"][0]["state"] == "interrupted"
    assert snap["approvals"][0]["state"] == "cancelled"


def test_permission_modes_and_live_mode_switch(tmp_path):
    policy, workbench, result, _, request, _, _ = session_fixture(
        tmp_path, permission_mode="inspect_only"
    )
    started = start_session(workbench.project, policy, client_id="mode-client")
    agent = PolicyAgent(policy, session_id=started["session_id"], approval_wait_seconds=0.05)

    # Read-only operations succeed in inspect_only mode.
    assert agent.inspect_source(request["source_id"])["verified"] is True
    assert agent.validate_recipe(request)["valid"] is True

    # Mutating operations are blocked in inspect_only mode.
    with pytest.raises(AgentSessionApprovalError, match="Inspect-only mode"):
        agent.review_result(decision(result))

    # Switch live mode to ask_approval via desktop control boundary.
    control_agent_session(
        workbench,
        {
            "action": "set_permission_mode",
            "policy_sha256": policy.content_sha256,
            "permission_mode": "ask_approval",
        },
    )
    assert agent.analysis_context()["policy"]["permission_mode"] == "ask_approval"
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.review_result(decision(result))
    snap = workbench.snapshot()["agent_sessions"]
    assert snap["status"] == "awaiting_approval"
    assert snap["pending_approval_count"] == 1

    # Switch live mode to full_access and execute without blocking.
    control_agent_session(
        workbench,
        {
            "action": "set_permission_mode",
            "policy_sha256": policy.content_sha256,
            "permission_mode": "full_access",
        },
    )
    reviewed = agent.review_result(decision(result))
    assert reviewed["review"]["actor"] == "agent"
    assert reviewed["review"]["disposition"] == "reviewed"


def test_ask_approval_single_use_consumption_denial_stale_and_live_wait(tmp_path):
    policy, workbench, result, _, request, _, root = session_fixture(
        tmp_path, permission_mode="ask_approval"
    )
    started = start_session(workbench.project, policy, client_id="approval-client")
    agent = PolicyAgent(policy, session_id=started["session_id"], approval_wait_seconds=0.05)

    # 1. Request approval for review_result -> pending
    rev_req = decision(result)
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.review_result(rev_req)
    approvals = workbench.snapshot()["agent_sessions"]["approvals"]
    assert len(approvals) == 1
    approval_id = approvals[0]["id"]
    assert approvals[0]["state"] == "pending"
    assert approvals[0]["result_id"] == result["id"]
    assert approvals[0]["revision_hash"] == result["revision_hash"]

    # 2. Human denies the request -> denied
    control_agent_session(
        workbench,
        {
            "action": "deny_request",
            "approval_id": approval_id,
            "reason": "Inspect channel calibration before reviewing",
        },
    )
    assert workbench.snapshot()["agent_sessions"]["approvals"][0]["state"] == "denied"

    # 3. Stale target detection on set_source_display when display revision changes
    display = agent.source_display(request["source_id"])
    channels_patch = [
        {
            **display["channels"][0],
            "high": float(display["channels"][0]["high"]) * 0.9,
        }
    ]
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.set_source_display(
            request["source_id"],
            display["source_sha256"],
            display["revision"],
            channels_patch,
        )
    disp_approval = workbench.snapshot()["agent_sessions"]["approvals"][0]
    assert disp_approval["state"] == "pending"
    assert disp_approval["display_revision"] == display["revision"]

    # Human changes the display state in the workbench before approving -> request becomes stale!
    _, _, full_state = agent._display_state(workbench, request["source_id"])
    workbench.execute(
        "save_source_view",
        {
            "source_id": request["source_id"],
            "source_sha256": display["source_sha256"],
            "expected_revision": display["revision"],
            "state": full_state,
        },
    )
    snap_after_edit = workbench.snapshot()["agent_sessions"]
    stale_rec = next(a for a in snap_after_edit["approvals"] if a["id"] == disp_approval["id"])
    assert stale_rec["state"] == "stale"

    # 4. Live waiting during tool call + single-use consumption + scientific review separation
    live_agent = PolicyAgent(policy, session_id=started["session_id"], approval_wait_seconds=2.5)

    def approve_shortly():
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            pending = [
                a
                for a in workbench.snapshot()["agent_sessions"]["approvals"]
                if a["state"] == "pending" and a["operation"] == "review_result"
            ]
            if pending:
                control_agent_session(
                    workbench,
                    {
                        "action": "approve_request",
                        "approval_id": pending[0]["id"],
                        "reason": "Approved execution of agent review",
                    },
                )
                return
            time.sleep(0.04)

    helper = threading.Thread(target=approve_shortly, daemon=True)
    helper.start()
    review_out = live_agent.review_result(rev_req)
    helper.join(timeout=2.0)

    # Human approved execution, but the scientific review record itself is still actor="agent".
    assert review_out["review"]["actor"] == "agent"
    assert workbench.project.review_state(result["id"])["actor"] == "agent"

    # Approval was atomically consumed and cannot be replayed.
    consumed = [
        a
        for a in workbench.snapshot()["agent_sessions"]["approvals"]
        if a["operation"] == "review_result" and a["state"] == "consumed"
    ]
    assert len(consumed) == 1

    # Export still requires its own approval in ask_approval mode.
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.export_result(result["id"], result["revision_hash"], "approved-export")
    exp_approval = next(
        a
        for a in workbench.snapshot()["agent_sessions"]["approvals"]
        if a["operation"] == "export_result" and a["state"] == "pending"
    )
    control_agent_session(
        workbench,
        {
            "action": "approve_request",
            "approval_id": exp_approval["id"],
            "reason": "Allow export to approved-export",
        },
    )
    exported = agent.export_result(result["id"], result["revision_hash"], "approved-export")
    assert exported["export_name"] == "approved-export"
    assert (root / "approved-export/result.json").is_file()

    # Attempting a second export without a new approval fails (single-use consumption).
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.export_result(result["id"], result["revision_hash"], "second-export")


def test_session_pause_resume_and_policy_revocation(tmp_path):
    policy, workbench, _, path, request, _, _ = session_fixture(
        tmp_path, permission_mode="full_access"
    )
    started = start_session(workbench.project, policy, client_id="control-client")
    agent = PolicyAgent(policy, session_id=started["session_id"], approval_wait_seconds=0.05)

    control_agent_session(
        workbench,
        {"action": "pause_session", "policy_sha256": policy.content_sha256},
    )
    assert workbench.snapshot()["agent_sessions"]["status"] == "paused"
    with pytest.raises(AgentSessionApprovalError, match="paused by the user"):
        agent.inspect_source(request["source_id"])

    control_agent_session(
        workbench,
        {"action": "resume_session", "policy_sha256": policy.content_sha256},
    )
    assert workbench.snapshot()["agent_sessions"]["status"] == "connected_idle"
    assert agent.inspect_source(request["source_id"])["verified"] is True

    control_agent_session(
        workbench,
        {"action": "revoke_policy", "policy_sha256": policy.content_sha256},
    )
    assert not path.exists()
    assert workbench.snapshot()["agent_sessions"]["status"] == "disconnected"
    with pytest.raises((PermissionError, ValueError, OSError)):
        agent.inspect_source(request["source_id"])


def test_capability_map_and_end_to_end_microscopy_journey_over_mcp_stdio(tmp_path):
    cap_map = capability_map()
    assert cap_map["counts"]["supported_via_mcp"] > 0
    assert cap_map["counts"]["supported_with_grant"] > 0
    assert cap_map["counts"]["gui_only_gap"] > 0
    mapped_ops = {entry["operation"] for entry in cap_map["entries"]}
    assert set(OPERATION_CATALOG) <= mapped_ops
    assert all(
        any(
            e["operation"] == act and e["status"] in {"supported_via_mcp", "supported_with_grant"}
            for e in cap_map["entries"]
        )
        for act in ACTION_NAMES
    )

    _, workbench, _, path, request, _, root = session_fixture(
        tmp_path, permission_mode="full_access"
    )

    async def journey(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            tools = {tool.name for tool in (await session.list_tools()).tools}
            assert "research_agent_session_control" not in tools
            assert {
                "inspect_source",
                "validate_recipe",
                "submit_recipe",
                "job_status",
                "result",
                "result_view",
                "inspect_action",
                "submit_action",
                "review_result",
                "export_result",
            } <= tools

            # 1. Inspect source
            src_res = await session.call_tool("inspect_source", {"source_id": request["source_id"]})
            assert not src_res.is_error
            assert src_res.structured_content["verified"] is True

            # 2. Validate recipe
            val_res = await session.call_tool("validate_recipe", {"request": request})
            assert not val_res.is_error
            assert val_res.structured_content["approved"]["run"] is True

            # 3. Submit segmentation recipe and wait for completion
            sub_res = await session.call_tool(
                "submit_recipe", {"request": request, "request_key": "journey-seg-1"}
            )
            assert not sub_res.is_error
            seg_job_id = sub_res.structured_content["job"]["id"]
            while True:
                st_res = await session.call_tool("job_status", {"job_id": seg_job_id})
                assert not st_res.is_error
                job_info = st_res.structured_content["job"]
                if (
                    job_info["state"] not in {"queued", "running"}
                    and not job_info["owned_worker_active"]
                ):
                    break
                await asyncio.sleep(0.05)
            assert job_info["state"] == "succeeded"
            seg_result_id = job_info["result_ids"][0]

            # 4. Inspect result & result_view
            res_out = await session.call_tool("result", {"result_id": seg_result_id})
            assert not res_out.is_error
            seg_summary = res_out.structured_content["result"]
            assert res_out.structured_content["total_rows"] == 1
            view_out = await session.call_tool("result_view", {"result_id": seg_result_id})
            assert not view_out.is_error

            # 5. Inspect correction info and submit label correction
            corr_info_out = await session.call_tool(
                "inspect_action",
                {
                    "operation": "correction_info",
                    "request": {
                        "result_id": seg_result_id,
                        "revision_hash": seg_summary["revision_hash"],
                    },
                },
            )
            assert not corr_info_out.is_error
            corr_info = corr_info_out.structured_content
            corr_req = {
                "result_id": seg_result_id,
                "revision_hash": seg_summary["revision_hash"],
                "operations": [
                    {
                        "op": "delete",
                        "label": corr_info["label_ids"][0],
                        "expected_input_sha256": corr_info["label_sha256"],
                    }
                ],
                "working_bytes": 64 * 1024**2,
            }
            corr_sub = await session.call_tool(
                "submit_action",
                {
                    "operation": "correct_result",
                    "request": corr_req,
                    "request_key": "journey-corr-1",
                },
            )
            assert not corr_sub.is_error
            corr_job_id = corr_sub.structured_content["job"]["id"]
            while True:
                st_res = await session.call_tool("job_status", {"job_id": corr_job_id})
                assert not st_res.is_error
                job_info = st_res.structured_content["job"]
                if (
                    job_info["state"] not in {"queued", "running"}
                    and not job_info["owned_worker_active"]
                ):
                    break
                await asyncio.sleep(0.05)
            assert job_info["state"] == "succeeded"
            child_id = job_info["result_ids"][0]

            # 6. Inspect corrected child result
            child_res = await session.call_tool("result", {"result_id": child_id})
            assert not child_res.is_error
            child_summary = child_res.structured_content["result"]
            assert child_summary["parent_id"] == seg_result_id
            assert child_res.structured_content["total_rows"] == 0

            # 7. Delegated agent review of corrected child result
            child_record = workbench.project.result(child_id)
            rev_out = await session.call_tool(
                "review_result",
                {
                    "request": decision(
                        child_record,
                        coverage="Inspected full plane before and after deleting label 1",
                    )
                },
            )
            assert not rev_out.is_error
            assert rev_out.structured_content["review"]["actor"] == "agent"

            # 8. Export reviewed result
            exp_out = await session.call_tool(
                "export_result",
                {
                    "result_id": child_id,
                    "revision_hash": child_summary["revision_hash"],
                    "filename": "journey-export",
                },
            )
            assert not exp_out.is_error
            assert (root / "journey-export/result.json").is_file()

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(journey(errlog))


def _approval_records(project):
    from loci_engine.research_project import parse_json

    with project.connection() as conn:
        return [
            parse_json(row[0])
            for row in conn.execute(
                "SELECT value FROM metadata WHERE key LIKE 'agent-approval:%' ORDER BY rowid"
            )
        ]


def _expire_approved(project, approval_id):
    from loci_engine.research_project import canonical_json, parse_json

    with project.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        key = "agent-approval:" + approval_id
        record = parse_json(
            conn.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0]
        )
        record.update(state="approved", expires_at="2000-01-01T00:00:00+00:00")
        conn.execute("UPDATE metadata SET value=? WHERE key=?", (canonical_json(record), key))


def test_disconnect_rejects_direct_calls_and_never_revives_old_session(tmp_path):
    policy, wb, result, _, _, _, _ = session_fixture(tmp_path)
    old = start_session(wb.project, policy)["session_id"]
    agent = PolicyAgent(policy, session_id=old)
    control_agent_session(wb, {"action": "disconnect_session", "session_id": old})
    with pytest.raises(AgentSessionApprovalError, match="disconnected"):
        agent.review_result(decision(result))
    assert wb.project.review_state(result["id"]) is None
    new = start_session(wb.project, policy)["session_id"]
    assert new != old
    PolicyAgent(policy, session_id=new).review_result(decision(result))
    with pytest.raises(AgentSessionApprovalError, match="disconnected"):
        agent.review_history(result["id"])
    old_record = next(
        s for s in wb.snapshot()["agent_sessions"]["sessions"] if s["session_id"] == old
    )
    assert old_record["state"] == "disconnected"


def test_disconnect_after_admission_blocks_direct_review_publication(tmp_path, monkeypatch):
    import loci_engine.research_mcp as mcp

    policy, wb, result, _, _, _, _ = session_fixture(tmp_path)
    session_id = start_session(wb.project, policy)["session_id"]
    agent = PolicyAgent(policy, session_id=session_id)
    original = mcp.check_or_await_approval

    def disconnect_after_approval(*args, **kwargs):
        value = original(*args, **kwargs)
        control_agent_session(wb, {"action": "disconnect_session", "session_id": session_id})
        return value

    monkeypatch.setattr(mcp, "check_or_await_approval", disconnect_after_approval)
    with pytest.raises(AgentSessionApprovalError, match="disconnected"):
        agent.review_result(decision(result))
    assert wb.project.review_state(result["id"]) is None


@pytest.mark.parametrize("waiting", [False, True])
def test_expired_approval_never_consumed_without_snapshot(tmp_path, monkeypatch, waiting):
    import loci_engine.agent_sessions as sessions

    policy, wb, result, _, _, _, _ = session_fixture(tmp_path, permission_mode="ask_approval")
    session_id = start_session(wb.project, policy)["session_id"]
    agent = PolicyAgent(policy, session_id=session_id, approval_wait_seconds=0)
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.review_result(decision(result))
    approval_id = _approval_records(wb.project)[0]["id"]
    if waiting:
        agent.approval_wait_seconds = 1

        def expire_on_wait(_seconds):
            _expire_approved(wb.project, approval_id)

        monkeypatch.setattr(sessions.time, "sleep", expire_on_wait)
    else:
        _expire_approved(wb.project, approval_id)
    with pytest.raises(AgentSessionApprovalError, match="expired|requires human approval"):
        agent.review_result(decision(result))
    records = _approval_records(wb.project)
    assert next(a for a in records if a["id"] == approval_id)["state"] == "expired"
    assert not any(a["state"] == "consumed" for a in records)
    assert wb.project.review_state(result["id"]) is None


def test_full_access_transition_cancels_obsolete_pending_prompt(tmp_path):
    policy, wb, result, _, _, _, _ = session_fixture(tmp_path, permission_mode="ask_approval")
    agent = PolicyAgent(policy, approval_wait_seconds=0)
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.review_result(decision(result))
    control_agent_session(
        wb,
        {
            "action": "set_permission_mode",
            "policy_sha256": policy.content_sha256,
            "permission_mode": "full_access",
        },
    )
    agent.review_result(decision(result))
    assert wb.snapshot()["agent_sessions"]["pending_approval_count"] == 0
    assert _approval_records(wb.project)[0]["state"] == "cancelled"


def test_job_ownership_scopes_stop_disconnect_revoke_and_idempotency(tmp_path):
    import os

    from loci_engine.research_jobs import submit_job

    policy, wb, _, _, request, spec, _ = session_fixture(tmp_path)
    second_path = tmp_path / "second-policy.json"
    spec["delegation"] = {**spec["delegation"], "client_id": "other-agent"}
    write_policy(second_path, wb.project, spec)
    other_policy = load_policy(second_path)
    register_policy(wb.project, other_policy)
    sid = start_session(wb.project, policy)["session_id"]
    sid2 = start_session(wb.project, policy)["session_id"]
    owner = {"policy_sha256": policy.content_sha256, "session_id": sid}
    owner2 = {"policy_sha256": policy.content_sha256, "session_id": sid2}
    other_owner = {"policy_sha256": other_policy.content_sha256, "session_id": None}
    human = submit_job(wb, request, "human")
    owned = submit_job(wb, request, "owned", owner=owner)
    sibling = submit_job(wb, request, "sibling", owner=owner2)
    other = submit_job(wb, request, "other", owner=other_owner)
    wb.project.update_job(other["id"], expected_state="queued", state="running", pid=os.getpid())
    for wrong in (None, owner2, other_owner):
        with pytest.raises(PermissionError, match="different owner"):
            submit_job(wb, request, "owned", owner=wrong)
    assert submit_job(wb, request, "owned", owner=owner)["id"] == owned["id"]
    for job in (human, sibling, other):
        with pytest.raises(PermissionError, match="owned by"):
            control_agent_session(
                wb, {"action": "stop_job", "job_id": job["id"], "session_id": sid}
            )
    agent = PolicyAgent(policy, session_id=sid)
    with pytest.raises(PermissionError, match="different policy or session"):
        agent.cancel_job(human["id"])
    control_agent_session(wb, {"action": "disconnect_session", "session_id": sid})
    assert wb.project.job(owned["id"])["state"] == "cancelled"
    assert wb.project.job(sibling["id"])["state"] == "queued"
    control_agent_session(wb, {"action": "revoke_policy", "policy_sha256": policy.content_sha256})
    assert wb.project.job(sibling["id"])["state"] == "cancelled"
    assert wb.project.job(human["id"])["state"] == "queued"
    assert wb.project.job(other["id"])["state"] == "running"
    assert wb.project.job(other["id"])["cancel_requested"] is False


def test_owned_job_disconnect_at_publication_preserves_results(tmp_path, monkeypatch):
    from loci_engine.agent_sessions import finish_session
    from loci_engine.research_jobs import run_job, submit_job

    policy, wb, _, _, request, _, _ = session_fixture(tmp_path)
    sid = start_session(wb.project, policy)["session_id"]
    owner = {"policy_sha256": policy.content_sha256, "session_id": sid}
    job = submit_job(wb, request, "late-disconnect", owner=owner)
    before = wb.project.list_results()
    original = wb.project.save_result

    def disconnect_before_publication(*args, **kwargs):
        finish_session(wb.project, sid)
        return original(*args, **kwargs)

    monkeypatch.setattr(wb.project, "save_result", disconnect_before_publication)
    with pytest.raises(AgentSessionApprovalError, match="disconnected"):
        run_job(wb, job["id"])
    assert wb.project.job(job["id"])["state"] == "cancelled"
    assert wb.project.list_results() == before


def test_snapshot_results_come_only_from_completed_owned_jobs(tmp_path):
    from loci_engine.research_jobs import run_job, submit_job

    policy, wb, existing, _, request, _, _ = session_fixture(tmp_path)
    sid = start_session(wb.project, policy)["session_id"]
    agent = PolicyAgent(policy, session_id=sid)
    agent.result(existing["id"])
    assert wb.snapshot()["agent_sessions"]["sessions"][0]["recent_result_ids"] == []
    job = submit_job(wb, request, "owned-result", owner=agent.job_owner)
    completed = run_job(wb, job["id"])["job"]
    snap = wb.snapshot()["agent_sessions"]["sessions"][0]
    assert completed["state"] == "succeeded"
    assert snap["owned_job_ids"] == [job["id"]]
    assert snap["recent_result_ids"] == completed["result_ids"]
    assert existing["id"] not in snap["recent_result_ids"]


def test_real_stdio_uninitialized_transport_and_disconnected_tool_rejection(tmp_path):
    from mcp.types import Implementation

    policy, wb, result, path, _, _, _ = session_fixture(tmp_path)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(
                *streams, client_info=Implementation(name="Actual test client", version="1.2")
            ) as session,
        ):
            # Ping completes through the running transport without initialization.
            await session.send_ping()
            assert wb.snapshot()["agent_sessions"]["connected_count"] == 0
            await session.initialize()
            live = wb.snapshot()["agent_sessions"]
            assert live["connected_count"] == 1
            assert live["sessions"][0]["client_id"] == "Actual test client"
            assert live["sessions"][0]["client_version"] == "1.2"
            sid = live["sessions"][0]["session_id"]
            control_agent_session(wb, {"action": "disconnect_session", "session_id": sid})
            response = await session.call_tool("review_result", {"request": decision(result)})
            assert response.is_error
            assert wb.project.review_state(result["id"]) is None

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))


def test_stop_owned_job_remains_available_while_paused(tmp_path):
    from loci_engine.research_jobs import submit_job

    policy, wb, _, _, request, _, _ = session_fixture(tmp_path)
    sid = start_session(wb.project, policy)["session_id"]
    job = submit_job(
        wb,
        request,
        "stop-paused",
        owner={
            "policy_sha256": policy.content_sha256,
            "session_id": sid,
        },
    )
    control_agent_session(wb, {"action": "pause_session", "policy_sha256": policy.content_sha256})
    control_agent_session(wb, {"action": "stop_job", "job_id": job["id"], "session_id": sid})
    assert wb.project.job(job["id"])["state"] == "cancelled"


def test_disconnect_during_export_staging_blocks_destination(tmp_path, monkeypatch):
    import loci_engine.research_export as exports

    policy, wb, result, _, _, _, root = session_fixture(tmp_path)
    sid = start_session(wb.project, policy)["session_id"]
    agent = PolicyAgent(policy, session_id=sid)
    agent.review_result(decision(result))
    original = exports.export_research_result

    def disconnect_after_staging(*args, **kwargs):
        output = original(*args, **kwargs)
        control_agent_session(wb, {"action": "disconnect_session", "session_id": sid})
        return output

    monkeypatch.setattr(exports, "export_research_result", disconnect_after_staging)
    with pytest.raises(AgentSessionApprovalError, match="disconnected"):
        agent.export_result(result["id"], result["revision_hash"], "late-export")
    assert not (root / "late-export").exists()
    assert list(root.iterdir()) == []


def test_portable_owned_job_is_historical_and_cannot_restore_live_authority(tmp_path):
    from loci_engine.agent_sessions import require_session_authority
    from loci_engine.research_interchange import export_project, import_project
    from loci_engine.research_jobs import run_job, submit_job

    policy, wb, _, _, request, _, _ = session_fixture(tmp_path)
    sid = start_session(wb.project, policy)["session_id"]
    owner = {"policy_sha256": policy.content_sha256, "session_id": sid}
    job = submit_job(wb, request, "portable-owned", owner=owner)
    run_job(wb, job["id"])
    archive = tmp_path / "owned.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "restored")
    assert restored.job(job["id"])["owner"] == owner
    assert restored.job(job["id"])["interchange"]["historical"] is True
    assert Workbench(restored).snapshot()["agent_sessions"]["connected_count"] == 0
    with pytest.raises(AgentSessionApprovalError, match="disconnected"):
        require_session_authority(restored, **owner)


def test_capability_map_targets_registered_tools_and_delegated_actions(tmp_path, monkeypatch):
    from test_agent_remote import fixture as remote_fixture

    from loci_engine.research_action_registry import READ_ACTIONS, REQUESTS, TASK_ACTIONS
    from loci_engine.research_mcp import build_server

    local_root = tmp_path / "local"
    local_root.mkdir()
    _, _, _, local_path, _, _, _ = session_fixture(local_root)
    remote_root = tmp_path / "remote"
    remote_root.mkdir()
    _, _, _, _, _, remote_path, _, _ = remote_fixture(remote_root, monkeypatch)

    async def registered_tools(path):
        return {tool.name for tool in await build_server(path).list_tools()}

    local_tools = asyncio.run(registered_tools(local_path))
    remote_tools = asyncio.run(registered_tools(remote_path))
    entries = {entry["operation"]: entry for entry in capability_map()["entries"]}
    supported = {
        name: entry for name, entry in entries.items() if entry["status"] != "gui_only_gap"
    }
    assert {entry["mcp_tool"] for entry in supported.values()} <= local_tools | remote_tools
    for operation, entry in supported.items():
        if entry["mcp_tool"] in {"inspect_action", "submit_action"}:
            assert operation in REQUESTS
            assert operation in (
                READ_ACTIONS if entry["mcp_tool"] == "inspect_action" else TASK_ACTIONS
            )
            assert operation in entry["grant_requirement"]

    for operation in ("submit", "status", "cancel", "retrieve", "attach"):
        name = f"remote_{operation}"
        entry = entries[name]
        assert name not in local_tools
        assert name in remote_tools
        assert entry["mcp_tool"] == name
        assert entry["status"] == "supported_with_grant"
        assert "human-prestaged" in entry["grant_requirement"]
        assert "remote_grants" in entry["grant_requirement"]
        assert f"'{operation}'" in entry["grant_requirement"]

    # Shared aliases remain advertised, but human session controls never become
    # executable through a delegated action or direct tool.
    assert entries["classical_run"]["mcp_tool"] == "submit_action"
    assert entries["describe_result"]["mcp_tool"] == "inspect_action"
    assert entries["run_recipe"]["mcp_tool"] == "submit_recipe"
    for operation in ("source_display", "set_source_display"):
        assert entries[operation]["mcp_tool"] == operation
        assert operation in local_tools
        assert "granted channels" in entries[operation]["grant_requirement"]
    assert entries["channel_metadata"]["mcp_tool"] == "inspect_source"
    assert "source_names" in entries["channel_metadata"]["grant_requirement"]
    assert "research_agent_session_control" not in local_tools | remote_tools | set(REQUESTS)
    assert not any("session_control" in name for name in supported)


def test_capability_map_distinguishes_unexposed_workbench_contracts():
    from loci_engine.research_action_registry import REQUESTS

    entries = {entry["operation"]: entry for entry in capability_map()["entries"]}
    for name in (
        "field_assay_preview",
        "field_assay_run",
        "scientific_data_export",
    ):
        entry = entries[name]
        assert name not in REQUESTS
        assert entry["status"] == "gui_only_gap"
        assert entry["mcp_tool"] is None
        assert entry["grant_requirement"] is None
        assert "no registered MCP" in entry["reason"]

    for name in ("remote_stage", "remote_profile_save", "remote_remove_owned"):
        assert entries[name]["status"] == "gui_only_gap"

    for name in (
        "exploration_list",
        "exploration_get",
        "exploration_preview",
        "exploration_compare",
        "exploration_run",
        "workflow_preview",
        "workflow_run",
        "task_preview_get",
    ):
        assert name in REQUESTS
        assert entries[name]["status"] == "supported_with_grant"
        assert entries[name]["mcp_tool"] == (
            "inspect_action"
            if name in {"exploration_list", "exploration_get", "task_preview_get"}
            else "submit_action"
        )
