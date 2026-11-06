"""Task metadata never grants scientific execution or human-review authority."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier
from uuid import uuid4

import pytest
from test_agent_actions import actions_agent

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_sessions import finish_session, start_session
from loci_engine.agent_tasks import (
    control_task,
    task_read,
    task_snapshot,
    task_write,
    validate_task_record,
)
from loci_engine.research_jobs import submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import ResearchProject, canonical_json, parse_json


@pytest.fixture
def tasks(tmp_path):
    _, wb, result, path, recipe, spec, _ = actions_agent(tmp_path)
    spec["operations"] = sorted(set(spec["operations"]) | {"agent_task_read", "agent_task_write"})
    write_policy(path, wb.project, spec)
    policy = load_policy(path)
    session = start_session(wb.project, policy, client_id="external-test-client")
    agent = PolicyAgent(policy, session_id=session["session_id"])
    target = {
        "kind": "result",
        "id": result["id"],
        "revision_hash": result["revision_hash"],
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
    }
    request = {
        "task_id": uuid4().hex,
        "expected_revision": 0,
        "goal": "Assess retained objects",
        "steps": [
            {
                "id": "measure",
                "title": "Inspect measurements",
                "state": "complete",
                "note": "Reported by the agent",
                "targets": [target],
            }
        ],
        "state": "awaiting_review",
        "targets": [target],
    }
    return agent, wb, result, request, recipe, path


def publish(tasks):
    agent, _, _, request, *_ = tasks
    return task_write(agent, "publish_plan", request)["task"]


def assessment(task, **changes):
    return {
        "task_id": task["id"],
        "expected_revision": task["revision"],
        "summary": "An observation, not a review decision",
        "observations": ["One label retained"],
        "limitations": ["Synthetic fixture only"],
        "targets": task["targets"],
        **changes,
    }


def update_metadata(project, key, **changes):
    with project.connection() as connection:
        value = parse_json(
            connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0]
        )
        value.update(changes)
        connection.execute("UPDATE metadata SET value=? WHERE key=?", (canonical_json(value), key))


def test_persistent_plan_assessments_attribution_and_no_execution_or_review(tasks):
    agent, wb, result, request, *_ = tasks
    task = publish(tasks)
    assert task["revision"] == 1 and task["updated_by"] == "agent"
    assert task["client_id"] == "external-test-client" and task["stale"] is False
    task = task_write(agent, "publish_assessment", assessment(task))["task"]
    assert task["revision"] == 2 and len(task["assessments"]) == 1
    assert task["assessments"][0]["session_id"] == agent.session_id
    assert task_read(agent, "list", {}) == {"tasks": [task]}
    reopened = ResearchProject(wb.project.root)
    assert task_snapshot(reopened) == [task]
    assert wb.project.list_jobs() == []
    assert wb.project.review_state(result["id"]) is None
    request.update(expected_revision=2, goal="Updated objective")
    updated = task_write(agent, "publish_plan", request)["task"]
    assert updated["assessments"] == task["assessments"]


def test_exact_revision_protects_human_edits_and_agent_edits(tasks):
    agent, wb, _, request, *_ = tasks
    task = publish(tasks)
    edit = {
        "action": "edit_task",
        "task_id": task["id"],
        "expected_revision": 1,
        "goal": "Human goal",
        "steps": [{"id": "measure", "title": "Human title"}],
    }
    control_task(wb, edit)
    changed = task_snapshot(wb.project)[0]
    assert changed["revision"] == 2 and changed["updated_by"] == "human"
    assert changed["steps"] == [
        {"id": "measure", "title": "Human title", "state": "planned", "note": "", "targets": []}
    ]
    with pytest.raises(ValueError, match="revision changed"):
        control_task(wb, edit)
    request["expected_revision"] = 1
    with pytest.raises(ValueError, match="revision changed"):
        task_write(agent, "publish_plan", request)
    task_write(agent, "publish_assessment", assessment(changed))
    edit["expected_revision"] = 2
    with pytest.raises(ValueError, match="revision changed"):
        control_task(wb, edit)
    assert task_snapshot(wb.project)[0]["goal"] == "Human goal"


def test_human_reorder_retains_unchanged_step_reports_and_new_steps_are_planned(tasks):
    _, wb, _, *_ = tasks
    task = publish(tasks)
    control_task(
        wb,
        {
            "action": "edit_task",
            "task_id": task["id"],
            "expected_revision": 1,
            "goal": task["goal"],
            "steps": [
                {"id": "new", "title": "New step"},
                {"id": "measure", "title": "Inspect measurements"},
            ],
        },
    )
    changed = task_snapshot(wb.project)[0]
    assert changed["steps"][1] == task["steps"][0]
    assert changed["steps"][0]["state"] == "planned"


def test_human_edit_reopens_completed_plan_without_approving_results(tasks):
    agent, wb, result, request, *_ = tasks
    request["state"] = "complete"
    task = task_write(agent, "publish_plan", request)["task"]
    control_task(
        wb,
        {
            "action": "edit_task",
            "task_id": task["id"],
            "expected_revision": 1,
            "goal": "Inspect an additional region",
            "steps": [{"id": "inspect", "title": "Inspect region"}],
        },
    )
    updated = task_snapshot(wb.project)[0]
    assert updated["state"] == "active" and updated["steps"][0]["state"] == "planned"
    assert wb.project.review_state(result["id"]) is None and wb.project.list_jobs() == []


@pytest.mark.parametrize(
    "disclosure",
    ["geometry", "source_names", "previews", "measurements", "provenance", "agent_metadata"],
)
def test_hand_authored_task_policy_cannot_bypass_disclosure_contract(tasks, disclosure):
    agent, *_ = tasks
    agent.policy = replace(agent.policy, disclosures=agent.policy.disclosures - {disclosure})
    with pytest.raises(PermissionError):
        task_read(agent, "list", {})


def test_resume_reconciles_dead_host_without_desktop_snapshot(tasks):
    agent, wb, *_ = tasks
    task = publish(tasks)
    old_session = agent.session_id
    update_metadata(wb.project, f"agent-session:{old_session}", private_pid=2_000_000_000)
    fresh = start_session(wb.project, agent.policy, client_id="replacement-host")
    replacement = PolicyAgent(agent.policy, session_id=fresh["session_id"])
    retained = task_read(replacement, "get", {"task_id": task["id"]})["task"]
    resumed = task_write(
        replacement, "resume", {"task_id": task["id"], "expected_revision": retained["revision"]}
    )["task"]
    assert resumed["session_id"] == fresh["session_id"] and resumed["revision"] == 2
    with wb.project.connection() as connection:
        old = parse_json(
            connection.execute(
                "SELECT value FROM metadata WHERE key=?", (f"agent-session:{old_session}",)
            ).fetchone()[0]
        )
    assert old["state"] == "interrupted" and "no longer running" in old["disconnect_reason"]
    assert wb.project.list_jobs() == []


@pytest.mark.parametrize("operation", ["publish_plan", "publish_assessment", "resume"])
def test_human_cancellation_is_final_for_agent(tasks, operation):
    agent, wb, _, request, *_ = tasks
    task = publish(tasks)
    control_task(wb, {"action": "cancel_task", "task_id": task["id"], "expected_revision": 1})
    request["expected_revision"] = 2
    payload = (
        assessment({**task, "revision": 2})
        if operation == "publish_assessment"
        else {"task_id": task["id"], "expected_revision": 2}
        if operation == "resume"
        else request
    )
    with pytest.raises(PermissionError, match="cancelled"):
        task_write(agent, operation, payload)
    assert task_snapshot(wb.project)[0]["state"] == "cancelled"


@pytest.mark.parametrize(
    "attack", ["revision", "source_hash", "result_source", "source_grant", "selection"]
)
def test_evidence_requires_exact_current_native_identity_and_grants(tasks, attack):
    agent, wb, _, request, *_ = tasks
    target = request["targets"][0]
    if attack == "revision":
        target["revision_hash"] = "f" * 64
    elif attack == "source_hash":
        target["source_sha256"] = "f" * 64
    elif attack == "result_source":
        target["source_id"] = "f" * 32
    elif attack == "source_grant":
        agent.policy = replace(agent.policy, sources={})
    else:
        request["targets"] = [
            {
                "kind": "source",
                "id": target["source_id"],
                "sha256": target["source_sha256"],
                "selection": {
                    "x": 999,
                    "y": 0,
                    "width": 32,
                    "height": 32,
                    "c": 0,
                    "z": 1,
                    "t": 0,
                    "level": 0,
                },
            }
        ]
    with pytest.raises((PermissionError, ValueError)):
        task_write(agent, "publish_plan", request)
    assert task_snapshot(wb.project) == []


@pytest.mark.parametrize(
    "attack", ["paused", "revoked", "dead_session", "tool", "disclosure", "no_session"]
)
def test_policy_and_live_session_checked_for_reads_and_writes(tasks, attack):
    agent, wb, *_ = tasks
    task = publish(tasks)
    if attack in {"paused", "revoked"}:
        update_metadata(wb.project, f"agent-policy:{agent.policy.content_sha256}", **{attack: True})
    elif attack == "dead_session":
        finish_session(wb.project, agent.session_id, reason="disconnected")
    elif attack == "tool":
        agent.policy = replace(agent.policy, operations=())
    elif attack == "disclosure":
        agent.policy = replace(agent.policy, disclosures=frozenset())
    else:
        agent.session_id = None
    with pytest.raises(PermissionError):
        task_write(agent, "publish_assessment", assessment(task))
    if attack != "no_session":
        with pytest.raises(PermissionError):
            task_read(agent, "get", {"task_id": task["id"]})


def test_recheck_within_transaction_refuses_pause_without_metadata_publication(tasks, monkeypatch):
    agent, wb, _, request, *_ = tasks
    original = agent._workbench

    def paused(operation):
        result = original(operation)
        update_metadata(wb.project, f"agent-policy:{agent.policy.content_sha256}", paused=True)
        return result

    monkeypatch.setattr(agent, "_workbench", paused)
    with pytest.raises(PermissionError):
        task_write(agent, "publish_plan", request)
    assert task_snapshot(wb.project) == []


def test_history_stays_stale_but_current_plan_can_be_repaired(tasks):
    agent, wb, result, request, *_ = tasks
    task = publish(tasks)
    task = task_write(agent, "publish_assessment", assessment(task))["task"]
    # Simulate retained metadata revision drift; snapshot must never decode arrays.
    with wb.project.connection() as connection:
        row = connection.execute(
            "SELECT record FROM results WHERE id=?", (result["id"],)
        ).fetchone()
        record = parse_json(row[0])
        record["created_at"] = "2026-11-06T00:00:00+00:00"
        record["revision_hash"] = hashlib.sha256(
            canonical_json({k: v for k, v in record.items() if k != "revision_hash"}).encode()
        ).hexdigest()
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(record), result["id"])
        )
    stale = task_snapshot(wb.project)[0]
    assert stale["stale"] is True and stale["assessments"][0]["stale"] is True
    assert stale["assessments"][0]["targets"] == task["assessments"][0]["targets"]
    with pytest.raises((ValueError, PermissionError)):
        task_write(agent, "publish_assessment", assessment(stale))
    request["expected_revision"] = 2
    request["targets"][0]["revision_hash"] = record["revision_hash"]
    request["steps"][0]["targets"][0]["revision_hash"] = record["revision_hash"]
    repaired = task_write(agent, "publish_plan", request)["task"]
    assert repaired["revision"] == 3 and repaired["stale"] is True
    assert repaired["assessments"][0] == stale["assessments"][0]
    added = task_write(agent, "publish_assessment", assessment(repaired))["task"]
    assert added["assessments"][0]["stale"] is True
    assert added["assessments"][1]["stale"] is False


@pytest.mark.parametrize(
    "previous_state",
    [
        "connected_idle",
        "paused",
        "executing",
        "awaiting_approval",
        "disconnected",
        "interrupted",
        "failed",
    ],
)
def test_resume_only_stopped_other_session_and_never_transfers_jobs(tasks, previous_state):
    agent, wb, _, _, recipe, _ = tasks
    task = publish(tasks)
    task = task_write(agent, "publish_assessment", assessment(task))["task"]
    job = submit_job(wb, recipe, "original-agent-job", owner=agent.job_owner)
    next_session = start_session(wb.project, agent.policy, client_id="continuing-client")
    next_agent = PolicyAgent(agent.policy, session_id=next_session["session_id"])
    update_metadata(wb.project, f"agent-session:{agent.session_id}", state=previous_state)
    request = {"task_id": task["id"], "expected_revision": 2}
    if previous_state in {"disconnected", "interrupted", "failed"}:
        resumed = task_write(next_agent, "resume", request)["task"]
        assert resumed["session_id"] == next_agent.session_id and resumed["revision"] == 3
        assert resumed["assessments"][0]["session_id"] == agent.session_id
        assert wb.project.job(job["id"])["owner"] == agent.job_owner
    else:
        with pytest.raises(PermissionError, match="stopped"):
            task_write(next_agent, "resume", request)
        assert task_snapshot(wb.project)[0]["session_id"] == agent.session_id


def test_job_targets_bind_exact_request_and_stay_current_as_job_progresses(tasks):
    agent, wb, _, request, recipe, _ = tasks
    job = submit_job(wb, recipe, "task-job-evidence", owner=agent.job_owner)
    target = {
        "kind": "job",
        "id": job["id"],
        "sha256": job["request_hash"],
    }
    request["targets"] = [target]
    task = publish(tasks)
    assert task["targets"] == [target]
    wb.project.update_job(job["id"], expected_state="queued", state="cancelled")
    assert task_snapshot(wb.project)[0]["stale"] is False
    task_write(agent, "publish_assessment", assessment(task))
    assert wb.project.job(job["id"])["state"] == "cancelled"


def test_job_evidence_rejects_wrong_hash_and_corrupted_native_intent(tasks):
    agent, wb, _, request, recipe, _ = tasks
    job = submit_job(wb, recipe, "task-wrong-job-digest", owner=agent.job_owner)
    request["targets"] = [{"kind": "job", "id": job["id"], "sha256": "f" * 64}]
    with pytest.raises(ValueError, match="stale"):
        task_write(agent, "publish_plan", request)
    request["targets"][0]["sha256"] = job["request_hash"]
    task = publish(tasks)
    with wb.project.connection() as connection:
        job["request"]["selection"]["x"] += 1
        connection.execute("UPDATE jobs SET record=? WHERE id=?", (canonical_json(job), job["id"]))
    assert task_snapshot(wb.project)[0]["stale"] is True
    with pytest.raises((ValueError, PermissionError)):
        task_write(agent, "publish_assessment", assessment(task))


@pytest.mark.parametrize(
    "attack",
    [
        "human",
        "review",
        "job_state",
        "path",
        "steps",
        "targets",
        "step_extra",
        "huge",
        "float_revision",
        "duplicate",
        "unknown_target",
    ],
)
def test_strict_bounded_payload_cannot_claim_authority(tasks, attack):
    agent, wb, _, request, *_ = tasks
    if attack in {"human", "review", "job_state", "path"}:
        request[
            {
                "human": "updated_by",
                "review": "review_state",
                "job_state": "job_state",
                "path": "path",
            }[attack]
        ] = "human"
    elif attack == "steps":
        request["steps"] *= 21
    elif attack == "targets":
        request["targets"] *= 33
    elif attack == "step_extra":
        request["steps"][0]["reviewed"] = True
    elif attack == "huge":
        request["goal"] = "a" * 2001
    elif attack == "float_revision":
        request["expected_revision"] = 0.0
    elif attack == "duplicate":
        request["steps"] *= 2
    else:
        request["targets"] = [{"kind": "approval", "id": uuid4().hex}]
    with pytest.raises(ValueError):
        task_write(agent, "publish_plan", request)
    assert task_snapshot(wb.project) == []


def test_assessment_bounds_and_strict_schema(tasks):
    agent, wb, *_ = tasks
    task = publish(tasks)
    with pytest.raises(ValueError):
        task_write(agent, "publish_assessment", assessment(task, actor="human"))
    for _ in range(10):
        task = task_write(agent, "publish_assessment", assessment(task))["task"]
    with pytest.raises(ValueError, match="history bound"):
        task_write(agent, "publish_assessment", assessment(task))
    assert len(task_snapshot(wb.project)[0]["assessments"]) == 10


def test_different_policy_and_session_cannot_update_tasks(tasks):
    agent, wb, _, request, *_ = tasks
    task = publish(tasks)
    second = start_session(wb.project, agent.policy)
    another = PolicyAgent(agent.policy, session_id=second["session_id"])
    with pytest.raises(PermissionError, match="Resume"):
        task_write(another, "publish_assessment", assessment(task))
    other_policy = replace(agent.policy, content_sha256="f" * 64)
    other = PolicyAgent(other_policy)
    with pytest.raises(PermissionError, match="policy"):
        task_read(other, "get", {"task_id": request["task_id"]})
    with pytest.raises(PermissionError, match="policy"):
        task_read(other, "list", {})


def test_snapshot_is_metadata_only_and_structured_targets_are_path_free(tasks, monkeypatch):
    _, wb, *_ = tasks
    task = publish(tasks)

    def no_decode(*args, **kwargs):
        raise AssertionError("Task snapshot must not decode pixels")

    monkeypatch.setattr(wb.project, "load_array", no_decode)
    assert task_snapshot(wb.project) == [task]
    assert "path" not in canonical_json(task["targets"])


def test_concurrent_human_and_agent_edit_same_revision_publish_exactly_once(tasks):
    agent, wb, _, request, *_ = tasks
    task = publish(tasks)
    barrier = Barrier(2)
    request["expected_revision"] = 1
    request["goal"] = "Concurrent agent goal"

    def mutate(actor):
        barrier.wait(timeout=10)
        try:
            if actor == "human":
                control_task(
                    wb,
                    {
                        "action": "edit_task",
                        "task_id": task["id"],
                        "expected_revision": 1,
                        "goal": "Concurrent human goal",
                        "steps": [{"id": "measure", "title": "Inspect measurements"}],
                    },
                )
            else:
                task_write(agent, "publish_plan", request)
        except ValueError as error:
            assert "revision changed" in str(error)
            return "conflict"
        return actor

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(mutate, ["human", "agent"]))
    assert results.count("conflict") == 1
    winner = next(value for value in results if value != "conflict")
    final = task_snapshot(wb.project)[0]
    assert final["revision"] == 2 and final["updated_by"] == winner
    assert final["goal"] == f"Concurrent {winner} goal"


@pytest.mark.parametrize(
    "attack", ["extra_path", "bad_step", "bad_target", "bad_assessment", "revision"]
)
def test_persisted_task_metadata_fails_closed_on_malformed_records(tasks, attack):
    agent, wb, *_ = tasks
    task = publish(tasks)
    key = f"agent-task:{task['id']}"
    with wb.project.connection() as connection:
        record = parse_json(
            connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0]
        )
        if attack == "extra_path":
            record["private_path"] = "/protected/path"
        elif attack == "bad_step":
            record["steps"][0]["actor"] = "human"
        elif attack == "bad_target":
            record["targets"][0]["kind"] = "approval"
        elif attack == "bad_assessment":
            record["assessments"] = [{}]
        else:
            record["revision"] = True
        connection.execute("UPDATE metadata SET value=? WHERE key=?", (canonical_json(record), key))
    with pytest.raises(ValueError):
        task_snapshot(wb.project)
    with pytest.raises(ValueError):
        task_read(agent, "get", {"task_id": task["id"]})


def test_public_validation_rejects_hidden_fields(tasks):
    task = publish(tasks)
    assert validate_task_record(task, public=True) == task
    task["history"] = []
    with pytest.raises(ValueError):
        validate_task_record(task, public=True)
