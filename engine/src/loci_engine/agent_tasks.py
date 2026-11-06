"""Durable agent-authored plans and assessments, without execution or review authority."""

from __future__ import annotations

import copy
import hashlib
import re
import uuid
from typing import Annotated, Any, Literal

from pydantic import Field

from .agent_activity import SELECTION_KEYS, collect_targets
from .agent_policy import DISCLOSURES
from .agent_sessions import (
    check_or_await_approval,
    reconcile_agent_sessions,
    require_session_authority,
)
from .research_project import (
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
    timestamp,
)

MAX_TASKS = 100
MAX_STEPS = 20
MAX_ASSESSMENTS = 10
MAX_TARGETS = 32
MAX_PAYLOAD_BYTES = 256 * 1024
MAX_RECORD_BYTES = 1024 * 1024
STEP_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
TASK_STATES = {"active", "awaiting_review", "complete", "cancelled"}
STEP_STATES = {"planned", "in_progress", "complete", "blocked"}
READ_TOOL = "agent_task_read"
WRITE_TOOL = "agent_task_write"
TaskReadOperation = Literal["list", "get"]
TaskWriteOperation = Literal["publish_plan", "publish_assessment", "resume"]


class TaskRevisionConflict(ValueError):
    """A fixed, path-free optimistic-concurrency message safe for the MCP boundary."""

    public_message = "The task revision changed. Read the latest plan before editing."

    def __init__(self):
        super().__init__(self.public_message)


def _object(properties, required=None):
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties if required is None else required),
    }


_ID = {"type": "string", "pattern": "^[a-f0-9]{32}$"}
_SHA = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
_TARGET_SCHEMA = {
    "oneOf": [
        _object(
            {
                "kind": {"const": "source"},
                "id": _ID,
                "sha256": _SHA,
                "selection": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        k: {"type": "integer", "minimum": 0} for k in sorted(SELECTION_KEYS)
                    },
                },
            },
            ["kind", "id", "sha256"],
        ),
        _object(
            {
                "kind": {"const": "result"},
                "id": _ID,
                "revision_hash": _SHA,
                "source_id": _ID,
                "source_sha256": _SHA,
            }
        ),
        _object({"kind": {"const": "job"}, "id": _ID, "sha256": _SHA}),
    ]
}
_TARGETS = {"type": "array", "maxItems": MAX_TARGETS, "items": _TARGET_SCHEMA}
_STEP = _object(
    {
        "id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
        "title": {"type": "string", "minLength": 1, "maxLength": 240},
        "state": {"enum": sorted(STEP_STATES)},
        "note": {"type": "string", "maxLength": 2000},
        "targets": _TARGETS,
    }
)
_BASE = {"task_id": _ID, "expected_revision": {"type": "integer", "minimum": 0}}
READ_REQUEST_SCHEMAS = {"list": _object({}), "get": _object({"task_id": _ID})}
WRITE_REQUEST_SCHEMAS = {
    "publish_plan": _object(
        {
            **_BASE,
            "goal": {"type": "string", "minLength": 1, "maxLength": 2000},
            "steps": {"type": "array", "maxItems": MAX_STEPS, "items": _STEP},
            "state": {"enum": sorted(TASK_STATES - {"cancelled"})},
            "targets": _TARGETS,
        }
    ),
    "publish_assessment": _object(
        {
            **_BASE,
            "summary": {"type": "string", "minLength": 1, "maxLength": 2000},
            **{
                k: {
                    "type": "array",
                    "maxItems": 20,
                    "items": {"type": "string", "minLength": 1, "maxLength": 2000},
                }
                for k in ("observations", "limitations")
            },
            "targets": _TARGETS,
        }
    ),
    "resume": _object(_BASE),
}
TASK_READ_REQUEST_SCHEMA = {"anyOf": list(READ_REQUEST_SCHEMAS.values())}
TASK_WRITE_REQUEST_SCHEMA = {"anyOf": list(WRITE_REQUEST_SCHEMAS.values())}
TaskReadRequest = Annotated[dict[str, Any], Field(json_schema_extra=TASK_READ_REQUEST_SCHEMA)]
TaskWriteRequest = Annotated[dict[str, Any], Field(json_schema_extra=TASK_WRITE_REQUEST_SCHEMA)]


def _exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"{label} requires exact fields")


def _sha(value):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Invalid evidence SHA-256")
    return value


def _targets(value):
    if not isinstance(value, list) or len(value) > MAX_TARGETS:
        raise ValueError("Task targets exceed the bounded list")
    seen = set()
    for target in value:
        if not isinstance(target, dict):
            raise ValueError("Task target must be a native identity")
        kind = target.get("kind")
        if kind == "source":
            keys = {"kind", "id", "sha256"}
            if "selection" in target:
                keys.add("selection")
                selection = target["selection"]
                if (
                    not isinstance(selection, dict)
                    or not selection
                    or not set(selection) <= SELECTION_KEYS
                    or any(type(v) is not int or v < 0 for v in selection.values())
                ):
                    raise ValueError("Invalid bounded source selection")
            _exact(target, keys, "Source target")
            _sha(target["sha256"])
        elif kind == "result":
            _exact(
                target,
                {"kind", "id", "revision_hash", "source_id", "source_sha256"},
                "Result target",
            )
            checked_id(target["source_id"])
            _sha(target["revision_hash"])
            _sha(target["source_sha256"])
        elif kind == "job":
            _exact(target, {"kind", "id", "sha256"}, "Job target")
            _sha(target["sha256"])
        else:
            raise ValueError("Task evidence supports only source, result or job identities")
        checked_id(target["id"])
        key = canonical_json(target)
        if key in seen:
            raise ValueError("Duplicate task target")
        seen.add(key)
    return copy.deepcopy(value)


def _steps(value, *, human=False):
    if not isinstance(value, list) or len(value) > MAX_STEPS:
        raise ValueError("A task permits at most 20 steps")
    seen = set()
    for step in value:
        _exact(
            step,
            {"id", "title"} if human else {"id", "title", "state", "note", "targets"},
            "Task step",
        )
        if not isinstance(step["id"], str) or not STEP_ID.fullmatch(step["id"]):
            raise ValueError("Invalid bounded step identity")
        if step["id"] in seen:
            raise ValueError("Duplicate step identity")
        seen.add(step["id"])
        checked_text(step["title"], "Step title", 240)
        if not human:
            if not isinstance(step["state"], str) or step["state"] not in STEP_STATES:
                raise ValueError("Invalid authored step state")
            checked_text(step["note"], "Step note", 2000, empty=True)
            _targets(step["targets"])
    return copy.deepcopy(value)


def _all_targets(record):
    return [
        *record["targets"],
        *(t for s in record["steps"] for t in s["targets"]),
        *(t for a in record["assessments"] for t in a["targets"]),
    ]


def validate_task_record(record, *, public=False):
    """Validate exact bounded persisted/exported metadata without resolving pixels or paths."""
    required = {
        "id",
        "revision",
        "policy_sha256",
        "session_id",
        "client_id",
        "created_at",
        "updated_at",
        "updated_by",
        "goal",
        "steps",
        "state",
        "targets",
        "assessments",
    }
    if not isinstance(record, dict):
        raise ValueError("Task record must be an object")
    if public:
        required.add("stale")
    optional = set() if public else {"history"}
    if not required <= set(record) or not set(record) <= required | optional:
        raise ValueError("Task record requires exact bounded metadata fields")
    if len(canonical_json(record).encode()) > MAX_RECORD_BYTES:
        raise ValueError("Task record exceeds the metadata byte bound")
    checked_id(record["id"])
    checked_id(record["session_id"])
    _sha(record["policy_sha256"])
    if type(record["revision"]) is not int or not 1 <= record["revision"] < 2**53:
        raise ValueError("Invalid task revision")
    checked_text(record["client_id"], "Task client identity", 128)
    for key in ("created_at", "updated_at"):
        checked_text(record[key], "Task timestamp", 64)
    if record["updated_by"] not in ("agent", "human"):
        raise ValueError("Invalid task attribution")
    checked_text(record["goal"], "Task goal", 2000)
    if not isinstance(record["state"], str) or record["state"] not in TASK_STATES:
        raise ValueError("Invalid authored task state")
    _steps(record["steps"])
    _targets(record["targets"])
    if not isinstance(record["assessments"], list) or len(record["assessments"]) > MAX_ASSESSMENTS:
        raise ValueError("Task assessment history exceeds the bound")
    seen = set()
    for assessment in record["assessments"]:
        keys = {
            "id",
            "summary",
            "observations",
            "limitations",
            "targets",
            "created_at",
            "session_id",
            "client_id",
        }
        if public:
            keys.add("stale")
        _exact(assessment, keys, "Task assessment")
        checked_id(assessment["id"])
        if assessment["id"] in seen:
            raise ValueError("Duplicate assessment identity")
        seen.add(assessment["id"])
        checked_id(assessment["session_id"])
        checked_text(assessment["client_id"], "Assessment client identity", 128)
        checked_text(assessment["created_at"], "Assessment timestamp", 64)
        checked_text(assessment["summary"], "Assessment summary", 2000)
        for key in ("observations", "limitations"):
            if not isinstance(assessment[key], list) or len(assessment[key]) > 20:
                raise ValueError("Assessment text list exceeds the bound")
            for text in assessment[key]:
                checked_text(text, "Assessment text", 2000)
        _targets(assessment["targets"])
        if public and type(assessment["stale"]) is not bool:
            raise ValueError("Invalid assessment stale flag")
    if "stale" in record and type(record["stale"]) is not bool:
        raise ValueError("Invalid task stale flag")
    if "history" in record:
        history = record["history"]
        if not isinstance(history, list) or len(history) > 100:
            raise ValueError("Task attribution history exceeds the bound")
        previous = 0
        for entry in history:
            _exact(
                entry,
                {"revision", "updated_at", "updated_by", "session_id", "client_id"},
                "Task attribution",
            )
            if (
                type(entry["revision"]) is not int
                or not previous < entry["revision"] <= record["revision"]
            ):
                raise ValueError("Invalid task attribution revision")
            previous = entry["revision"]
            checked_id(entry["session_id"])
            checked_text(entry["updated_at"], "Task attribution timestamp", 64)
            checked_text(entry["client_id"], "Task attribution client", 128)
            if entry["updated_by"] not in ("human", "agent"):
                raise ValueError("Invalid task attribution actor")
    return copy.deepcopy(record)


def _target_stale(project, target):
    try:
        if target["kind"] == "source":
            return project.source(target["id"])["sha256"] != target["sha256"]
        if target["kind"] == "result":
            result = project.result(target["id"], verify_scientific_arrays=False)
            return (
                result["revision_hash"] != target["revision_hash"]
                or result["source_id"] != target["source_id"]
                or result["source_sha256"] != target["source_sha256"]
                or project.source(result["source_id"])["sha256"] != target["source_sha256"]
            )
        job = project.job(target["id"])
        request_hash = hashlib.sha256(
            canonical_json({"operation": job["operation"], "request": job["request"]}).encode()
        ).hexdigest()
        return job["request_hash"] != target["sha256"] or request_hash != job["request_hash"]
    except (ValueError, OSError, KeyError, TypeError):
        return True


def _public(project, record):
    value = validate_task_record(record)
    value.pop("history", None)
    for assessment in value["assessments"]:
        assessment["stale"] = any(_target_stale(project, t) for t in assessment["targets"])
    value["stale"] = any(_target_stale(project, t) for t in _all_targets(record))
    return value


def _load(connection, identity):
    row = connection.execute(
        "SELECT value FROM metadata WHERE key=?", (f"agent-task:{checked_id(identity)}",)
    ).fetchone()
    if row is None:
        raise ValueError("Agent task does not exist in this study")
    return validate_task_record(parse_json(row[0]))


def task_snapshot(project):
    """Bounded metadata-only native snapshot; never decode source or retained arrays."""
    with project.connection() as connection:
        rows = connection.execute(
            "SELECT value FROM metadata WHERE key LIKE 'agent-task:%' ORDER BY rowid DESC LIMIT ?",
            (MAX_TASKS,),
        ).fetchall()
    return [_public(project, parse_json(row[0])) for row in rows]


def _guard(agent, operation):
    agent._recheck_session()
    agent.policy.require_operation(operation)
    for disclosure in DISCLOSURES:
        agent.policy.require_disclosure(disclosure)
    if (
        agent.policy.delegation is None
        or agent.policy.delegation["result_scope"] != "granted-sources"
    ):
        raise PermissionError("Plans and assessments require source-scoped delegation")


def _scope(agent, wb, target):
    """Authorize metadata identity using existing exact source/result disclosure grants."""
    if target["kind"] == "source":
        grant = agent.policy.source_grant(wb.project, target["id"])
        if "selection" in target:
            selection = target["selection"]
            # Target selections must be complete, explicit granted native selections.
            if not {"x", "y", "width", "height", "c", "z", "t", "level"} <= set(
                selection
            ) or not grant.allows(selection, []):
                raise PermissionError("Task source selection exceeds the grant")
            agent.policy.require_disclosure("geometry")
    elif target["kind"] == "result":
        for disclosure in ("provenance", "measurements", "geometry"):
            agent.policy.require_disclosure(disclosure)
        record = agent._authorize_result(wb, target["id"], verify_scientific_arrays=False)
        if record["source_id"] != target["source_id"]:
            raise PermissionError("Task result source is mismatched")
    else:
        job = wb.project.job(target["id"])
        if job.get("owner", {}).get("policy_sha256") != agent.policy.content_sha256:
            raise PermissionError("Task job evidence belongs to another policy")
        dependencies = collect_targets(wb.project, job.get("request", {}))
        dependencies.extend(collect_targets(wb.project, {"result_ids": job.get("result_ids", [])}))
        dependencies = [d for d in dependencies if d["kind"] in {"source", "result"}]
        if not dependencies:
            raise PermissionError("Task job has no source-scoped evidence")
        for dependency in dependencies:
            _scope(agent, wb, dependency)


def _record_scope(agent, wb, record):
    if record["policy_sha256"] != agent.policy.content_sha256:
        raise PermissionError("Task belongs to another exact policy")
    for target in _all_targets(record):
        _scope(agent, wb, target)


def _current_targets(record):
    return [*record["targets"], *(t for s in record["steps"] for t in s["targets"])]


def task_read(agent, operation, request):
    if operation not in READ_REQUEST_SCHEMAS:
        raise ValueError("Unknown agent task read operation")
    _exact(request, READ_REQUEST_SCHEMAS[operation]["properties"], "Task read")
    _guard(agent, READ_TOOL)
    wb = agent._workbench(READ_TOOL)
    try:
        if operation == "get":
            with wb.project.connection() as connection:
                record = _load(connection, request["task_id"])
            _record_scope(agent, wb, record)
            response = {"task": _public(wb.project, record)}
        else:
            records = []
            for record in task_snapshot(wb.project):
                try:
                    _record_scope(agent, wb, record)
                except PermissionError:
                    continue
                records.append(record)
            response = {"tasks": records}
        _guard(agent, READ_TOOL)
        return response
    finally:
        wb.close()


def _revision(request):
    value = request["expected_revision"]
    if type(value) is not int or value < 0 or value >= 2**53 - 1:
        raise ValueError("Task expected revision must be an exact nonnegative integer")
    return value


def _save(connection, record, actor):
    record["revision"] += 1
    record["updated_at"] = timestamp()
    record["updated_by"] = actor
    history = record.setdefault("history", [])
    history.append(
        {
            "revision": record["revision"],
            "updated_at": record["updated_at"],
            "updated_by": actor,
            "session_id": record["session_id"],
            "client_id": record["client_id"],
        }
    )
    # Attribution is bounded without dropping assessments or rewriting their provenance.
    record["history"] = history[-100:]
    validate_task_record(record)
    connection.execute(
        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
        (f"agent-task:{record['id']}", canonical_json(record)),
    )


def task_write(agent, operation, request):
    if operation not in WRITE_REQUEST_SCHEMAS:
        raise ValueError("Unknown agent task write operation")
    _exact(request, WRITE_REQUEST_SCHEMAS[operation]["properties"], "Task write")
    if len(canonical_json(request).encode()) > MAX_PAYLOAD_BYTES:
        raise ValueError("Task payload exceeds the byte bound")
    identity = checked_id(request["task_id"])
    expected = _revision(request)
    _guard(agent, WRITE_TOOL)
    if agent.session_id is None:
        raise PermissionError("Task writes require a live registered session")
    if operation == "publish_plan":
        checked_text(request["goal"], "Task goal", 2000)
        _steps(request["steps"])
        _targets(request["targets"])
        if not isinstance(request["state"], str) or request["state"] not in TASK_STATES - {
            "cancelled"
        }:
            raise ValueError("Invalid agent-authored task state")
    elif operation == "publish_assessment":
        checked_text(request["summary"], "Assessment summary", 2000)
        _targets(request["targets"])
        for key in ("observations", "limitations"):
            if not isinstance(request[key], list) or len(request[key]) > 20:
                raise ValueError("Assessment text list exceeds the bound")
            for text in request[key]:
                checked_text(text, "Assessment text", 2000)
    wb = agent._workbench(WRITE_TOOL)
    try:
        if operation == "resume":
            # Abrupt host loss may leave persisted presence marked live. Use the
            # same PID/heartbeat reconciliation as the desktop before taking the
            # transaction; a GUI snapshot must not be required for recovery.
            reconcile_agent_sessions(wb.project)
        check_or_await_approval(agent, wb, WRITE_TOOL, {"operation": operation, **request})
        with wb.project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            require_session_authority(
                wb.project, agent.policy.content_sha256, agent.session_id, connection=connection
            )
            session = parse_json(
                connection.execute(
                    "SELECT value FROM metadata WHERE key=?", (f"agent-session:{agent.session_id}",)
                ).fetchone()[0]
            )
            if expected == 0 and operation == "publish_plan":
                if connection.execute(
                    "SELECT 1 FROM metadata WHERE key=?", (f"agent-task:{identity}",)
                ).fetchone():
                    raise TaskRevisionConflict()
                count = connection.execute(
                    "SELECT COUNT(*) FROM metadata WHERE key LIKE 'agent-task:%'"
                ).fetchone()[0]
                if count >= MAX_TASKS:
                    raise ValueError("Study task bound reached")
                record = {
                    "id": identity,
                    "revision": 0,
                    "policy_sha256": agent.policy.content_sha256,
                    "session_id": agent.session_id,
                    "client_id": session["client_id"],
                    "created_at": timestamp(),
                    "assessments": [],
                    "goal": "",
                    "steps": [],
                    "targets": [],
                    "state": "active",
                }
            else:
                record = _load(connection, identity)
                if record["revision"] != expected:
                    raise TaskRevisionConflict()
                if record["policy_sha256"] != agent.policy.content_sha256:
                    raise PermissionError("Task belongs to another exact policy")
                if record["state"] == "cancelled":
                    raise PermissionError("Human-cancelled task cannot be changed by an agent")
                if operation != "resume" and record["session_id"] != agent.session_id:
                    raise PermissionError("Resume the task before changing session ownership")
            if operation == "resume":
                if record["session_id"] == agent.session_id:
                    raise ValueError("Task already belongs to the current session")
                row = connection.execute(
                    "SELECT value FROM metadata WHERE key=?",
                    (f"agent-session:{record['session_id']}",),
                ).fetchone()
                old = parse_json(row[0]) if row else None
                if (
                    old is None
                    or old.get("policy_sha256") != agent.policy.content_sha256
                    or old.get("state") not in {"stopped", "disconnected", "interrupted", "failed"}
                ):
                    raise PermissionError("Task continuation requires a stopped previous session")
                # Never transfer jobs, approvals, execution, or review state.
                record["session_id"] = agent.session_id
                record["client_id"] = session["client_id"]
            elif operation == "publish_plan":
                for key in ("goal", "steps", "state", "targets"):
                    record[key] = copy.deepcopy(request[key])
            else:
                if len(record["assessments"]) >= MAX_ASSESSMENTS:
                    raise ValueError("Task assessment history bound reached")
                record["assessments"].append(
                    {
                        "id": uuid.uuid4().hex,
                        "created_at": timestamp(),
                        "session_id": agent.session_id,
                        "client_id": session["client_id"],
                        **{
                            k: copy.deepcopy(request[k])
                            for k in ("summary", "observations", "limitations", "targets")
                        },
                    }
                )
            # Historical assessments remain immutable and may be stale. Validate current
            # plan evidence and newly supplied assessment evidence, allowing repair of a
            # plan while retaining the original assessment provenance for inspection.
            targets = _current_targets(record)
            if operation == "publish_assessment":
                targets += record["assessments"][-1]["targets"]
            for target in targets:
                _scope(agent, wb, target)
            if any(_target_stale(wb.project, t) for t in targets):
                raise ValueError("Task evidence is stale; refresh current bindings before editing")
            _guard(agent, WRITE_TOOL)
            require_session_authority(
                wb.project, agent.policy.content_sha256, agent.session_id, connection=connection
            )
            _save(connection, record, "agent")
        return {"task": _public(wb.project, record)}
    finally:
        wb.close()


def control_task(workbench, request):
    """Native human-only command. Agents cannot select attribution or call this adapter."""
    action = request.get("action") if isinstance(request, dict) else None
    if action not in {"edit_task", "cancel_task"}:
        raise ValueError("Unknown human task control")
    keys = {"action", "task_id", "expected_revision"}
    if action == "edit_task":
        keys |= {"goal", "steps"}
    _exact(request, keys, "Human task control")
    expected = _revision(request)
    if action == "edit_task":
        checked_text(request["goal"], "Task goal", 2000)
        _steps(request["steps"], human=True)
    with workbench.project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        record = _load(connection, request["task_id"])
        if record["revision"] != expected:
            raise TaskRevisionConflict()
        if action == "cancel_task":
            record["state"] = "cancelled"
        else:
            previous = {s["id"]: s for s in record["steps"]}
            if record["state"] != "cancelled" and (
                request["goal"] != record["goal"]
                or request["steps"]
                != [{"id": step["id"], "title": step["title"]} for step in record["steps"]]
            ):
                record["state"] = "active"
            record["goal"] = request["goal"]
            record["steps"] = [
                copy.deepcopy(previous[s["id"]])
                if s["id"] in previous and s["title"] == previous[s["id"]]["title"]
                else {**s, "state": "planned", "note": "", "targets": []}
                for s in request["steps"]
            ]
        _save(connection, record, "human")
    return workbench.snapshot()
