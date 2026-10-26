"""Interactive MCP session presence, permission modes, approval lifecycle, and capability map.

Session state, human approval records, and activity events are stored per study in
``study.sqlite3`` (under ``metadata`` keys prefixed with ``agent-policy:``,
``agent-session:``, ``agent-approval:``, and ``agent-event:``). Raw filesystem
paths and OS process IDs remain private to the engine and are never included in
renderer-safe or MCP-visible snapshots.
"""

from __future__ import annotations

import hashlib
import os
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .quantitative import exact_keys
from .research_action_registry import ACTION_NAMES, READ_ACTIONS, TASK_ACTIONS
from .research_jobs import cancel_job
from .research_operations import OPERATION_CATALOG
from .research_project import (
    SHA_PATTERN,
    ResearchProject,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
    timestamp,
)
from .resource_limits import process_alive

if TYPE_CHECKING:
    from .agent_policy import AgentPolicy
    from .workbench import Workbench

SESSION_SNAPSHOT_SCHEMA = "loci.agent-sessions/v1"
CAPABILITY_MAP_SCHEMA = "loci.agent-capability-map/v1"

PERMISSION_MODES = frozenset({"inspect_only", "ask_approval", "full_access"})
SESSION_STATES = frozenset(
    {
        "connected_idle",
        "executing",
        "awaiting_approval",
        "paused",
        "interrupted",
        "disconnected",
        "failed",
    }
)
LIVE_SESSION_STATES = frozenset({"connected_idle", "executing", "awaiting_approval", "paused"})
APPROVAL_STATES = frozenset(
    {"pending", "approved", "consumed", "denied", "cancelled", "expired", "stale"}
)

READ_ONLY_TOOLS = frozenset(
    {
        "catalog",
        "recipe_guide",
        "action_guide",
        "analysis_context",
        "inspect_source",
        "validate_recipe",
        "job_status",
        "result",
        "result_view",
        "source_image",
        "source_display",
        "review_history",
        "study_results",
        "validate_action",
        "inspect_action",
        "remote_status",
    }
)
APPROVAL_GATED_TOOLS = frozenset(
    {
        "preview_recipe",
        "submit_recipe",
        "cancel_job",
        "submit_action",
        "set_source_display",
        "export_vision_handoff",
        "review_result",
        "export_result",
        "remote_submit",
        "remote_cancel",
        "remote_retrieve",
        "remote_attach",
    }
)

DEFAULT_HEARTBEAT_TTL_SECONDS = 30.0
DEFAULT_APPROVAL_TTL_SECONDS = 900.0
DEFAULT_APPROVAL_WAIT_SECONDS = 30.0
MAX_EVENTS = 120

_DIRECT_MCP_MAPPING: dict[str, tuple[str, str]] = {
    "inspect": ("inspect_source", "Direct source metadata and calibration inspection"),
    "validate_recipe": (
        "validate_recipe",
        "Normalize and preflight a processing/segmentation recipe",
    ),
    "preview_recipe": ("preview_recipe", "Run a bounded non-adopted recipe preview"),
    "run_recipe": ("submit_recipe", "Submit a durable recipe execution job"),
    "result": ("result", "Read quantitative measurements and provenance for a result"),
    "result_view": ("result_view", "Render a 2D plane and label overlay for a result"),
    "review_history": ("review_history", "Inspect revision-bound review decision history"),
    "action_guide": ("action_guide", "Discover shared research action schemas and contracts"),
    "view": ("source_image", "Render a bounded source crop and channel composite image"),
    "channel_metadata": ("inspect_source", "Disclosed when source_names is granted"),
    "recipe_preflight": ("validate_recipe", "Resource estimate returned by validate_recipe"),
}

# These tools are registered only when the policy includes an exact remote grant.
# A run must already have been staged by a human; the tools cannot stage sources
# or administer SSH profiles.
_GRANTED_MCP_MAPPING: dict[str, tuple[str, str]] = {
    f"remote_{operation}": (
        f"remote_{operation}",
        "Requires an exact human-prestaged remote_grants entry with "
        f"'{operation}' in its operations, pinned request/profile/source identities "
        "and resource limits. Does not grant staging or SSH profile administration.",
    )
    for operation in ("submit", "status", "cancel", "retrieve", "attach")
}

_GUI_ONLY_REASONS: dict[str, str] = {
    "field_assay_preview": (
        "The field-assay preview contract has no registered MCP tool or delegated action. "
        "A recipe preview does not produce its field metrics and effective-mask receipt."
    ),
    "field_assay_run": (
        "Reviewed field-assay adoption has no registered MCP tool or delegated action. "
        "submit_recipe does not adopt the field-assay receipt and signed integral."
    ),
    "scientific_data_export": (
        "Planned scientific CSV package export through a private destination grant has no "
        "registered MCP action. export_result provides a separate result export contract."
    ),
    **{
        name: (
            "Saved source-bound exploration records and exact comparison/adoption receipts "
            "have no registered MCP tool or delegated action. Recipe tools do not expose "
            "the saved exploration contract."
        )
        for name in (
            "exploration_list",
            "exploration_get",
            "exploration_preview",
            "exploration_compare",
            "exploration_run",
        )
    },
    "labels_import": (
        "Requires a human-selected local TIFF path grant via the native OS file picker."
    ),
    "roi_import": ("Requires a human-selected GeoJSON/ImageJ file via the native OS file picker."),
    "model_list": (
        "Managed ONNX/Cellpose model provisioning is human-administered in the desktop workbench."
    ),
    "model_preview": "Model qualification requires human visual inspection before adoption.",
    "model_run": "Requires an exact human-qualified model preview receipt.",
    "cellpose_run": (
        "Provisioned Cellpose runtime execution is configured in the desktop segmentation panel."
    ),
    "sample_sheet_template": (
        "Study replicate metadata authoring is managed in the desktop study table."
    ),
    "sample_sheet_preview": (
        "Study replicate CSV validation is managed in the desktop study table."
    ),
    "sample_sheet_apply": (
        "Study replicate metadata assignment is human-authored in the desktop workbench."
    ),
    "study_summary": (
        "Cross-replicate statistical summaries are reviewed in the desktop study panel."
    ),
    "study_compare": (
        "Pooled biological-replicate comparisons require human-authored sample declarations."
    ),
    "study_correction_effect": (
        "Paired correction-effect reports are authored in the desktop study panel."
    ),
    "intensity_catalog": (
        "Saved compartment intensity comparisons are authored in the desktop study panel."
    ),
    "intensity_preview": (
        "Saved compartment intensity comparisons are authored in the desktop study panel."
    ),
    "intensity_save": (
        "Saved compartment intensity comparisons are authored in the desktop study panel."
    ),
    "intensity_get": (
        "Saved compartment intensity comparisons are authored in the desktop study panel."
    ),
    "intensity_list": (
        "Saved compartment intensity comparisons are authored in the desktop study panel."
    ),
    "intensity_export": (
        "Requires a human-selected destination folder via the native OS file picker."
    ),
    "remote_analysis_plan": (
        "Direct SSH remote compute staging is human-authorized; "
        "use remote_* tools for prestaged grants."
    ),
    "remote_analysis_start": (
        "Direct SSH remote compute staging is human-authorized; "
        "use remote_* tools for prestaged grants."
    ),
    "remote_analysis_advance": (
        "Direct SSH remote compute staging is human-authorized; "
        "use remote_* tools for prestaged grants."
    ),
    "remote_analysis_cancel": (
        "Direct SSH remote compute staging is human-authorized; "
        "use remote_* tools for prestaged grants."
    ),
    "workflow_validate": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_save": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_list": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_get": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_preflight": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_preview": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_run": "Visual node workflows are authored in the desktop workflow builder.",
    "workflow_status": "Visual node workflows are authored in the desktop workflow builder.",
}


class AgentSessionApprovalError(PermissionError):
    """Permission error with a path-free message safe to disclose to the MCP client."""

    def __init__(self, public_message: str) -> None:
        super().__init__(public_message)
        self.public_message = public_message


def _sha256_text(value: Any, label: str = "SHA-256") -> str:
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError(f"Invalid {label}")
    return value


def _policy_key(policy_sha256: str) -> str:
    return f"agent-policy:{_sha256_text(policy_sha256, 'policy_sha256')}"


def _session_key(session_id: str) -> str:
    return f"agent-session:{checked_id(session_id)}"


def _approval_key(approval_id: str) -> str:
    return f"agent-approval:{checked_id(approval_id)}"


def _event_key(event_id: str) -> str:
    return f"agent-event:{event_id}"


def _parse_iso(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    except ValueError:
        return None


def capability_map() -> dict[str, Any]:
    """Return the truthful workbench-to-MCP capability map."""
    entries: list[dict[str, Any]] = []
    for name in sorted(OPERATION_CATALOG):
        info = OPERATION_CATALOG[name]
        mutates = bool(info["mutates"])
        summary = str(info["summary"])
        if name in _DIRECT_MCP_MAPPING or name in _GRANTED_MCP_MAPPING:
            mapping = _GRANTED_MCP_MAPPING if name in _GRANTED_MCP_MAPPING else _DIRECT_MCP_MAPPING
            mcp_tool, note = mapping[name]
            entries.append(
                {
                    "operation": name,
                    "summary": summary,
                    "mutates": mutates,
                    "status": "supported_with_grant"
                    if name in _GRANTED_MCP_MAPPING
                    else "supported_via_mcp",
                    "mcp_tool": mcp_tool,
                    "grant_requirement": note,
                    "reason": None,
                }
            )
        elif name in ACTION_NAMES:
            is_read = name in READ_ACTIONS
            mcp_tool = "inspect_action" if is_read else "submit_action"
            entries.append(
                {
                    "operation": name,
                    "summary": summary,
                    "mutates": mutates,
                    "status": "supported_with_grant",
                    "mcp_tool": mcp_tool,
                    "grant_requirement": (
                        f"Requires delegated study access with '{name}' in policy.actions "
                        f"(validate with validate_action, run with {mcp_tool})."
                    ),
                    "reason": None,
                }
            )
        else:
            reason = _GUI_ONLY_REASONS.get(
                name,
                "Interactive desktop viewport or human-authored study administration surface.",
            )
            entries.append(
                {
                    "operation": name,
                    "summary": summary,
                    "mutates": mutates,
                    "status": "gui_only_gap",
                    "mcp_tool": None,
                    "grant_requirement": None,
                    "reason": reason,
                }
            )

    for mcp_only_name, summary, mutates, grant_note in (
        (
            "source_display",
            "Read granted channel display settings and saved view revision",
            False,
            "Requires source_display operation, a vision-capable policy, and geometry, "
            "provenance and agent_metadata disclosures. Only granted channels are returned.",
        ),
        (
            "set_source_display",
            "Update granted channel display settings at an exact saved revision",
            True,
            "Requires set_source_display operation, a vision-capable policy, and geometry, "
            "provenance and agent_metadata disclosures. Source fingerprint, view revision "
            "and granted channels must match; session permission mode also applies.",
        ),
        (
            "analysis_context",
            "Read bounded pages of permitted source handles, recipe hashes, and limits",
            False,
            "Requires analysis_context operation and agent_metadata disclosure.",
        ),
        (
            "study_results",
            "Discover accessible result revisions across granted study sources",
            False,
            "Requires delegated study access and agent_metadata disclosure.",
        ),
        (
            "review_result",
            "Record an explicitly delegated agent review decision (actor='agent')",
            True,
            "Requires delegated study access with allow_review=True; never creates human review.",
        ),
        (
            "export_result",
            "Atomically export a reviewed result revision to an authorized filename",
            True,
            "Requires export_result operation, all result disclosures, and a pinned export root.",
        ),
        (
            "export_vision_handoff",
            "Write a provisional .loci-vision visualization handoff bundle",
            True,
            "Requires export_vision_handoff operation and an authorized .loci-vision filename.",
        ),
    ):
        entries.append(
            {
                "operation": mcp_only_name,
                "summary": summary,
                "mutates": mutates,
                "status": "supported_with_grant",
                "mcp_tool": mcp_only_name,
                "grant_requirement": grant_note,
                "reason": None,
            }
        )

    entries.sort(key=lambda item: item["operation"])
    counts = {
        "supported_via_mcp": sum(item["status"] == "supported_via_mcp" for item in entries),
        "supported_with_grant": sum(item["status"] == "supported_with_grant" for item in entries),
        "gui_only_gap": sum(item["status"] == "gui_only_gap" for item in entries),
        "total": len(entries),
    }
    return {
        "schema": CAPABILITY_MAP_SCHEMA,
        "counts": counts,
        "entries": entries,
    }


def infer_permission_mode(policy: AgentPolicy) -> str:
    explicit = getattr(policy, "permission_mode", None)
    if explicit in PERMISSION_MODES:
        return str(explicit)
    if policy.operations & APPROVAL_GATED_TOOLS or policy.actions & TASK_ACTIONS:
        return "full_access"
    return "inspect_only"


def _append_event(
    connection: Any,
    *,
    kind: str,
    summary: str,
    policy_sha256: str | None = None,
    session_id: str | None = None,
    approval_id: str | None = None,
    operation: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    now = timestamp()
    event_id = f"{int(time.time() * 1_000_000):016d}-{uuid.uuid4().hex[:8]}"
    record = {
        "id": event_id,
        "timestamp": now,
        "kind": kind,
        "summary": checked_text(summary, "Event summary", 512),
        "policy_sha256": policy_sha256,
        "session_id": session_id,
        "approval_id": approval_id,
        "operation": operation,
        "actor": actor,
    }
    connection.execute(
        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
        (_event_key(event_id), canonical_json(record)),
    )
    rows = connection.execute(
        "SELECT key FROM metadata WHERE key LIKE 'agent-event:%' ORDER BY key DESC"
    ).fetchall()
    for (old_key,) in rows[MAX_EVENTS:]:
        connection.execute("DELETE FROM metadata WHERE key=?", (old_key,))
    return record


def is_policy_registered(project: ResearchProject, policy_sha256: str) -> bool:
    with project.connection() as connection:
        row = connection.execute(
            "SELECT 1 FROM metadata WHERE key=?",
            (_policy_key(policy_sha256),),
        ).fetchone()
    return row is not None


def register_policy(
    project: ResearchProject,
    policy: AgentPolicy,
    *,
    permission_mode: str | None = None,
    bundle_name: str | None = None,
) -> dict[str, Any]:
    mode = permission_mode if permission_mode is not None else infer_permission_mode(policy)
    if mode not in PERMISSION_MODES:
        raise ValueError("Choose inspect_only, ask_approval or full_access permission mode")
    safe_bundle = checked_text(
        bundle_name or policy.path.parent.name or policy.path.name or "agent-access",
        "Bundle name",
        128,
    )
    client_id = (
        policy.delegation["client_id"]
        if isinstance(policy.delegation, dict)
        and isinstance(policy.delegation.get("client_id"), str)
        else "local-mcp-client"
    )
    now = timestamp()
    record = {
        "policy_sha256": policy.content_sha256,
        "project_id": policy.project_id,
        "schema": policy.schema,
        "bundle_name": safe_bundle,
        "private_policy_path": str(policy.path),
        "client_id": client_id,
        "identity_assurance": "declared",
        "permission_mode": mode,
        "initial_permission_mode": mode,
        "operations": sorted(policy.operations),
        "actions": sorted(policy.actions),
        "disclosures": sorted(policy.disclosures),
        "source_ids": sorted(policy.sources),
        "has_export_grant": policy.export_root is not None,
        "allow_agent_review": "review_result" in policy.operations,
        "paused": False,
        "revoked": False,
        "revoke_reason": None,
        "state": "configuration_ready",
        "created_at": now,
        "updated_at": now,
    }
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (_policy_key(policy.content_sha256), canonical_json(record)),
        )
        _append_event(
            connection,
            kind="access_bundle_created",
            summary=(
                f"Access bundle '{safe_bundle}' ready ({mode.replace('_', ' ')}); "
                "no client connected."
            ),
            policy_sha256=policy.content_sha256,
            actor="human",
        )
    return _public_policy(record)


def ensure_policy_registered(project: ResearchProject, policy: AgentPolicy) -> dict[str, Any]:
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_policy_key(policy.content_sha256),),
        ).fetchone()
    if row is not None:
        return parse_json(row[0])
    register_policy(project, policy)
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_policy_key(policy.content_sha256),),
        ).fetchone()
    return parse_json(row[0])


def effective_permission_mode(project: ResearchProject, policy: AgentPolicy) -> str:
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_policy_key(policy.content_sha256),),
        ).fetchone()
    if row is not None:
        record = parse_json(row[0])
        mode = record.get("permission_mode")
        if mode in PERMISSION_MODES:
            return str(mode)
    return infer_permission_mode(policy)


def start_session(
    project: ResearchProject,
    policy: AgentPolicy,
    *,
    client_id: str | None = None,
    client_version: str | None = None,
    pid: int | None = None,
) -> dict[str, Any]:
    policy.recheck()
    policy_record = ensure_policy_registered(project, policy)
    if policy_record.get("revoked"):
        raise AgentSessionApprovalError("This agent access policy was revoked by the user in Loci.")
    session_id = uuid.uuid4().hex
    now = timestamp()
    declared_client = checked_text(
        client_id
        or (
            policy.delegation["client_id"]
            if isinstance(policy.delegation, dict) and policy.delegation.get("client_id")
            else policy_record.get("client_id") or "mcp-stdio-client"
        ),
        "Client identity",
        128,
    )
    initial_state = "paused" if policy_record.get("paused") else "connected_idle"
    record = {
        "session_id": session_id,
        "project_id": policy.project_id,
        "policy_sha256": policy.content_sha256,
        "bundle_name": policy_record.get("bundle_name", "agent-access"),
        "client_id": declared_client,
        "client_version": checked_text(client_version, "Client version", 64)
        if client_version
        else None,
        "identity_assurance": "declared",
        "permission_mode": policy_record.get("permission_mode", infer_permission_mode(policy)),
        "state": initial_state,
        "private_pid": os.getpid() if pid is None else int(pid),
        "started_at": now,
        "last_heartbeat_at": now,
        "updated_at": now,
        "ended_at": None,
        "current_operation": None,
        "current_target": None,
        "active_job_id": None,
        "active_approval_id": None,
        "tool_calls_count": 0,
        "last_operation": None,
        "last_error": None,
        "disconnect_reason": None,
    }
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (_session_key(session_id), canonical_json(record)),
        )
        _append_event(
            connection,
            kind="session_connected",
            summary=f"MCP client '{declared_client}' connected over stdio.",
            policy_sha256=policy.content_sha256,
            session_id=session_id,
            actor="agent",
        )
    return _public_session(record)


def update_session_client_info(
    project: ResearchProject,
    session_id: str,
    *,
    client_name: str | None = None,
    client_version: str | None = None,
) -> None:
    if not client_name and not client_version:
        return
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_session_key(session_id),),
        ).fetchone()
        if row is None:
            return
        record = parse_json(row[0])
        if client_name:
            record["client_id"] = checked_text(client_name, "Client name", 128)
        if client_version:
            record["client_version"] = checked_text(client_version, "Client version", 64)
        record["last_heartbeat_at"] = timestamp()
        record["updated_at"] = record["last_heartbeat_at"]
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (_session_key(session_id), canonical_json(record)),
        )


def heartbeat_session(
    project: ResearchProject,
    session_id: str,
    *,
    state: str | None = None,
    current_operation: str | None | object = ...,
    current_target: dict[str, Any] | None | object = ...,
    active_job_id: str | None | object = ...,
    active_approval_id: str | None | object = ...,
    increment_calls: bool = False,
    last_operation: str | None | object = ...,
    last_error: str | None | object = ...,
) -> dict[str, Any] | None:
    now = timestamp()
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_session_key(session_id),),
        ).fetchone()
        if row is None:
            return None
        record = parse_json(row[0])
        if record["state"] in {"disconnected", "interrupted", "failed"}:
            return _public_session(record)
        policy_row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_policy_key(record["policy_sha256"]),),
        ).fetchone()
        if policy_row is not None:
            policy_record = parse_json(policy_row[0])
            record["permission_mode"] = policy_record.get(
                "permission_mode", record["permission_mode"]
            )
            if policy_record.get("revoked"):
                record["state"] = "disconnected"
                record["ended_at"] = now
                record["current_operation"] = None
                record["active_approval_id"] = None
                record["disconnect_reason"] = (
                    policy_record.get("revoke_reason") or "Policy revoked by user"
                )
                connection.execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                    (_session_key(session_id), canonical_json(record)),
                )
                return _public_session(record)
            if policy_record.get("paused") and state in {None, "connected_idle"}:
                state = "paused"
            elif not policy_record.get("paused") and record["state"] == "paused" and state is None:
                state = "connected_idle"
        if state is not None:
            if state not in SESSION_STATES:
                raise ValueError("Invalid agent session state")
            record["state"] = state
        if current_operation is not ...:
            record["current_operation"] = current_operation
        if current_target is not ...:
            record["current_target"] = current_target
        if active_job_id is not ...:
            record["active_job_id"] = active_job_id
        if active_approval_id is not ...:
            record["active_approval_id"] = active_approval_id
        if increment_calls:
            record["tool_calls_count"] = int(record.get("tool_calls_count", 0)) + 1
        if last_operation is not ...:
            record["last_operation"] = last_operation
        if last_error is not ...:
            record["last_error"] = last_error
        record["last_heartbeat_at"] = now
        record["updated_at"] = now
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (_session_key(session_id), canonical_json(record)),
        )
    return _public_session(record)


def finish_session(
    project: ResearchProject,
    session_id: str,
    *,
    reason: str | None = None,
    failed: bool = False,
) -> dict[str, Any] | None:
    now = timestamp()
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?",
            (_session_key(session_id),),
        ).fetchone()
        if row is None:
            return None
        record = parse_json(row[0])
        if record["state"] not in {"disconnected", "interrupted", "failed"}:
            record["state"] = "failed" if failed else "disconnected"
            record["ended_at"] = now
            record["updated_at"] = now
            record["current_operation"] = None
            record["active_approval_id"] = None
            record["disconnect_reason"] = reason or (
                "MCP server exited with an error" if failed else "MCP client disconnected"
            )
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (_session_key(session_id), canonical_json(record)),
            )
            _cancel_session_approvals(
                connection, session_id=session_id, reason="Session disconnected before decision"
            )
            _append_event(
                connection,
                kind="session_failed" if failed else "session_disconnected",
                summary=(
                    f"Session '{record['client_id']}' {record['state']}: "
                    f"{record['disconnect_reason']}."
                ),
                policy_sha256=record["policy_sha256"],
                session_id=session_id,
                actor="agent",
            )
    for job in project.list_jobs():
        if job.get("owner") == {
            "policy_sha256": record["policy_sha256"],
            "session_id": session_id,
        } and job.get("state") in {"queued", "running"}:
            cancel_job(project, job["id"])
    return _public_session(record)


def _cancel_session_approvals(
    connection: Any,
    *,
    session_id: str | None = None,
    policy_sha256: str | None = None,
    reason: str,
    new_state: str = "cancelled",
) -> None:
    now = timestamp()
    rows = connection.execute(
        "SELECT key, value FROM metadata WHERE key LIKE 'agent-approval:%'"
    ).fetchall()
    for key, raw in rows:
        approval = parse_json(raw)
        if approval.get("state") not in {"pending", "approved"}:
            continue
        if session_id is not None and approval.get("session_id") != session_id:
            continue
        if policy_sha256 is not None and approval.get("policy_sha256") != policy_sha256:
            continue
        approval["state"] = new_state
        approval["updated_at"] = now
        approval["decided_at"] = now
        approval["decision_reason"] = reason
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (key, canonical_json(approval)),
        )


def _target_is_stale(project: ResearchProject, approval: dict[str, Any]) -> bool:
    source_id = approval.get("source_id")
    expected_source_sha = approval.get("source_sha256")
    if isinstance(source_id, str) and isinstance(expected_source_sha, str):
        try:
            current_source = project.source(source_id)
        except Exception:
            return True
        if current_source.get("sha256") != expected_source_sha:
            return True
    result_id = approval.get("result_id")
    expected_revision = approval.get("revision_hash")
    if isinstance(result_id, str) and isinstance(expected_revision, str):
        try:
            current_result = project.result(result_id)
        except Exception:
            return True
        if current_result.get("revision_hash") != expected_revision:
            return True
    display_revision = approval.get("display_revision")
    if isinstance(source_id, str) and isinstance(display_revision, int):
        docs = project.documents("display", document_id=source_id)
        current_rev = docs[0]["revision"] if docs else 0
        if current_rev != display_revision:
            return True
    return False


def reconcile_agent_sessions(
    project: ResearchProject,
    *,
    heartbeat_ttl_seconds: float = DEFAULT_HEARTBEAT_TTL_SECONDS,
) -> None:
    """Reconcile live sessions, policy files, and pending approvals fail-closed."""
    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    with project.connection() as connection:
        policy_rows = connection.execute(
            "SELECT key, value FROM metadata WHERE key LIKE 'agent-policy:%'"
        ).fetchall()
        session_rows = connection.execute(
            "SELECT key, value FROM metadata WHERE key LIKE 'agent-session:%'"
        ).fetchall()
        approval_rows = connection.execute(
            "SELECT key, value FROM metadata WHERE key LIKE 'agent-approval:%'"
        ).fetchall()

    if not policy_rows and not session_rows and not approval_rows:
        return

    policy_updates: list[tuple[str, dict[str, Any], str | None]] = []
    policies_by_sha: dict[str, dict[str, Any]] = {}
    for key, raw in policy_rows:
        record = parse_json(raw)
        sha = record["policy_sha256"]
        private_path = record.get("private_policy_path")
        if not record.get("revoked") and isinstance(private_path, str):
            path = Path(private_path)
            file_ok = False
            try:
                if path.is_file() and not path.is_symlink():
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    file_ok = digest == sha
            except OSError:
                file_ok = False
            if not file_ok:
                record["revoked"] = True
                record["revoke_reason"] = "Policy file was removed or modified on disk"
                record["state"] = "disconnected"
                record["updated_at"] = now
                policy_updates.append(
                    (
                        key,
                        record,
                        f"Policy '{record.get('bundle_name', sha[:8])}' revoked "
                        "because its policy file was removed or modified.",
                    )
                )
        policies_by_sha[sha] = record

    session_updates: list[tuple[str, dict[str, Any], str | None]] = []
    for key, raw in session_rows:
        record = parse_json(raw)
        if record.get("state") not in LIVE_SESSION_STATES:
            continue
        policy_rec = policies_by_sha.get(record["policy_sha256"])
        if policy_rec is not None and policy_rec.get("revoked"):
            record["state"] = "disconnected"
            record["ended_at"] = now
            record["updated_at"] = now
            record["current_operation"] = None
            record["active_approval_id"] = None
            record["disconnect_reason"] = policy_rec.get("revoke_reason") or "Policy was revoked"
            session_updates.append(
                (
                    key,
                    record,
                    f"Session '{record['client_id']}' disconnected after policy revocation.",
                )
            )
            continue

        pid = record.get("private_pid")
        alive = isinstance(pid, int) and pid > 0 and process_alive(pid)
        last_hb = _parse_iso(record.get("last_heartbeat_at"))
        expired_hb = last_hb is not None and (now_dt - last_hb).total_seconds() > max(
            1.0, float(heartbeat_ttl_seconds)
        )
        if not alive or expired_hb:
            reason = (
                "MCP server process is no longer running"
                if not alive
                else "MCP session heartbeat timed out"
            )
            record["state"] = "interrupted"
            record["ended_at"] = now
            record["updated_at"] = now
            record["current_operation"] = None
            record["active_approval_id"] = None
            record["disconnect_reason"] = reason
            session_updates.append(
                (
                    key,
                    record,
                    f"Session '{record['client_id']}' interrupted ({reason}).",
                )
            )

    approval_updates: list[tuple[str, dict[str, Any], str | None]] = []
    for key, raw in approval_rows:
        approval = parse_json(raw)
        if approval.get("state") not in {"pending", "approved"}:
            continue
        expires_at = _parse_iso(approval.get("expires_at"))
        action_label = approval.get("action_name") or approval.get("operation")
        if expires_at is not None and now_dt >= expires_at:
            approval["state"] = "expired"
            approval["updated_at"] = now
            approval["decided_at"] = now
            approval["decision_reason"] = "Approval request expired before execution"
            approval_updates.append(
                (
                    key,
                    approval,
                    f"Approval for '{action_label}' expired.",
                )
            )
            continue
        if _target_is_stale(project, approval):
            approval["state"] = "stale"
            approval["updated_at"] = now
            approval["decided_at"] = now
            approval["decision_reason"] = "Bound source or result revision changed"
            approval_updates.append(
                (
                    key,
                    approval,
                    f"Approval for '{action_label}' marked stale after target revision change.",
                )
            )

    if not policy_updates and not session_updates and not approval_updates:
        return

    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        for key, record, summary in policy_updates:
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (key, canonical_json(record)),
            )
            _cancel_session_approvals(
                connection,
                policy_sha256=record["policy_sha256"],
                reason="Policy was revoked",
            )
            if summary:
                _append_event(
                    connection,
                    kind="policy_revoked",
                    summary=summary,
                    policy_sha256=record["policy_sha256"],
                )
        for key, record, summary in session_updates:
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (key, canonical_json(record)),
            )
            _cancel_session_approvals(
                connection,
                session_id=record["session_id"],
                reason=record.get("disconnect_reason") or "Session interrupted",
            )
            if summary:
                _append_event(
                    connection,
                    kind="session_interrupted"
                    if record["state"] == "interrupted"
                    else "session_disconnected",
                    summary=summary,
                    policy_sha256=record["policy_sha256"],
                    session_id=record["session_id"],
                )
        for key, approval, summary in approval_updates:
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (key, canonical_json(approval)),
            )
            if summary:
                _append_event(
                    connection,
                    kind=f"approval_{approval['state']}",
                    summary=summary,
                    policy_sha256=approval.get("policy_sha256"),
                    session_id=approval.get("session_id"),
                    approval_id=approval["id"],
                    operation=approval.get("operation"),
                )


def _extract_binding(
    workbench: Workbench,
    operation: str,
    request_payload: dict[str, Any],
) -> dict[str, Any]:
    """Extract renderer-safe target bindings and current revisions for an operation."""
    action_name = operation
    inner = request_payload
    if operation in {"submit_action", "validate_action", "inspect_action"} and isinstance(
        request_payload.get("operation"), str
    ):
        action_name = str(request_payload["operation"])
        if isinstance(request_payload.get("request"), dict):
            inner = request_payload["request"]

    source_id: str | None = None
    source_sha256: str | None = None
    result_id: str | None = None
    revision_hash: str | None = None
    display_revision: int | None = None
    destination_name: str | None = None
    params_summary: dict[str, Any] = {}

    if isinstance(inner.get("source_id"), str):
        source_id = inner["source_id"]
    if isinstance(inner.get("result_id"), str):
        result_id = inner["result_id"]
    if isinstance(inner.get("revision_hash"), str):
        revision_hash = inner["revision_hash"]
    if isinstance(request_payload.get("filename"), str):
        destination_name = Path(request_payload["filename"]).name
    elif isinstance(inner.get("filename"), str):
        destination_name = Path(inner["filename"]).name

    if operation == "set_source_display":
        if isinstance(inner.get("expected_revision"), int) and not isinstance(
            inner.get("expected_revision"), bool
        ):
            display_revision = int(inner["expected_revision"])
        if isinstance(inner.get("channels"), list):
            params_summary["channels"] = [
                item.get("channel") for item in inner["channels"] if isinstance(item, dict)
            ]

    if result_id is not None:
        try:
            result_rec = workbench.project.result(result_id)
            if revision_hash is None:
                revision_hash = result_rec["revision_hash"]
            if source_id is None:
                source_id = result_rec["source_id"]
        except Exception:
            pass

    if source_id is not None:
        try:
            source_rec = workbench.project.source(source_id)
            source_sha256 = source_rec["sha256"]
        except Exception:
            pass

    if isinstance(inner.get("selection"), dict):
        sel = inner["selection"]
        params_summary["selection"] = {
            k: sel[k]
            for k in ("x", "y", "width", "height", "c", "z", "z_stop", "t", "level")
            if k in sel
        }
    if isinstance(inner.get("recipe"), dict):
        seg = inner["recipe"].get("segmentation")
        if isinstance(seg, dict):
            params_summary["segmentation"] = {
                k: seg[k] for k in ("method", "threshold", "min_size") if k in seg
            }
    if action_name == "correct_result" and isinstance(inner.get("operations"), list):
        params_summary["edit_count"] = len(inner["operations"])
        params_summary["edit_ops"] = [
            op.get("op") for op in inner["operations"][:5] if isinstance(op, dict)
        ]
    if operation == "review_result":
        req = inner.get("request") if isinstance(inner.get("request"), dict) else inner
        if isinstance(req.get("result_id"), str) and result_id is None:
            result_id = req["result_id"]
            try:
                result_rec = workbench.project.result(result_id)
                source_id = result_rec["source_id"]
                source_sha256 = result_rec["source_sha256"]
            except Exception:
                pass
        if isinstance(req.get("revision_hash"), str) and revision_hash is None:
            revision_hash = req["revision_hash"]
        if isinstance(req.get("disposition"), str):
            params_summary["disposition"] = req["disposition"]
    if destination_name:
        params_summary["destination_name"] = destination_name

    category = "execution"
    if action_name in {"correct_result", "correct_tracks", "roi_add", "large_result_delete"}:
        category = "correction"
    elif operation == "set_source_display":
        category = "display"
    elif operation == "review_result":
        category = "review"
    elif operation in {"export_result", "export_vision_handoff"}:
        category = "export"

    target_parts = []
    if source_id:
        target_parts.append(f"source {source_id[:8]}")
    if result_id:
        target_parts.append(f"result {result_id[:8]}@{revision_hash[:8] if revision_hash else '?'}")
    if destination_name:
        target_parts.append(f"file '{destination_name}'")
    target_desc = ", ".join(target_parts) if target_parts else "study scope"
    summary = f"{action_name} on {target_desc}"

    return {
        "operation": operation,
        "action_name": action_name,
        "category": category,
        "summary": summary,
        "source_id": source_id,
        "source_sha256": source_sha256,
        "result_id": result_id,
        "revision_hash": revision_hash,
        "display_revision": display_revision,
        "destination_name": destination_name,
        "parameters_summary": params_summary,
    }


def require_session_authority(
    project: ResearchProject,
    policy_sha256: str,
    session_id: str | None,
    *,
    connection: Any = None,
    allow_paused: bool = False,
) -> None:
    """Check durable authority without consuming another execution approval."""
    if connection is None:
        with project.connection() as conn:
            require_session_authority(
                project, policy_sha256, session_id, connection=conn, allow_paused=allow_paused
            )
        return
    row = connection.execute(
        "SELECT value FROM metadata WHERE key=?", (_policy_key(policy_sha256),)
    ).fetchone()
    if row is not None:
        policy = parse_json(row[0])
        if policy.get("revoked") or (policy.get("paused") and not allow_paused):
            raise AgentSessionApprovalError("The agent policy was revoked or paused by the user.")
    if session_id is not None:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", (_session_key(session_id),)
        ).fetchone()
        session = parse_json(row[0]) if row else None
        if (
            session is None
            or session.get("policy_sha256") != policy_sha256
            or session.get("state") not in LIVE_SESSION_STATES
        ):
            raise AgentSessionApprovalError(
                "The agent session is disconnected or interrupted; reconnect."
            )
        if session.get("state") == "paused" and not allow_paused:
            raise AgentSessionApprovalError("The agent session is paused by the user.")


def _expire_approval(connection: Any, key: str, record: dict[str, Any]) -> bool:
    expiry = _parse_iso(record.get("expires_at"))
    if record.get("state") in {"pending", "approved"} and (
        expiry is None or expiry <= datetime.now(UTC)
    ):
        record["state"] = "expired"
        record["updated_at"] = timestamp()
        record["decision_reason"] = "Approval expired before execution"
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)", (key, canonical_json(record))
        )
        return True
    return False


def check_or_await_approval(
    agent: Any,
    workbench: Workbench,
    operation: str,
    request_payload: dict[str, Any],
) -> dict[str, Any] | None:
    """Enforce session pause/revocation, permission_mode, and single-use human approvals."""
    project = workbench.project
    policy: AgentPolicy = agent.policy
    session_id: str | None = getattr(agent, "session_id", None)
    wait_seconds = float(getattr(agent, "approval_wait_seconds", DEFAULT_APPROVAL_WAIT_SECONDS))

    tracked = (
        session_id is not None
        or getattr(policy, "permission_mode", None) is not None
        or is_policy_registered(project, policy.content_sha256)
    )
    if not tracked:
        return None

    policy_record = ensure_policy_registered(project, policy)
    require_session_authority(project, policy.content_sha256, session_id)
    if policy_record.get("revoked"):
        raise AgentSessionApprovalError(
            "The active Loci agent policy was revoked by the user; reconnect with a new bundle."
        )
    if policy_record.get("paused"):
        if session_id is not None:
            heartbeat_session(project, session_id, state="paused", current_operation=None)
        raise AgentSessionApprovalError(
            "The Loci agent session is currently paused by the user. "
            "Resume the session in Loci before running operations."
        )

    mode = policy_record.get("permission_mode") or infer_permission_mode(policy)
    binding = _extract_binding(workbench, operation, request_payload)
    target_info = {
        k: binding[k]
        for k in ("action_name", "source_id", "result_id", "revision_hash", "destination_name")
        if binding.get(k) is not None
    }

    if session_id is not None:
        heartbeat_session(
            project,
            session_id,
            state="executing",
            current_operation=binding["action_name"],
            current_target=target_info,
            active_approval_id=None,
            last_operation=binding["action_name"],
        )

    if operation in READ_ONLY_TOOLS:
        return None

    if mode == "inspect_only":
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            require_session_authority(
                project, policy.content_sha256, session_id, connection=connection
            )
            _append_event(
                connection,
                kind="operation_blocked",
                summary=(
                    f"Blocked '{binding['action_name']}' because session is in Inspect-only mode."
                ),
                policy_sha256=policy.content_sha256,
                session_id=session_id,
                operation=operation,
                actor="agent",
            )
        if session_id is not None:
            heartbeat_session(project, session_id, state="connected_idle", current_operation=None)
        raise AgentSessionApprovalError(
            "Operation blocked: the active Loci session is in Inspect-only mode. "
            "Switch the session mode to Ask for approval or Full access in Loci to allow changes."
        )

    if mode == "full_access":
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            require_session_authority(
                project, policy.content_sha256, session_id, connection=connection
            )
            _append_event(
                connection,
                kind="operation_started",
                summary=f"Executing '{binding['summary']}' in Full access mode.",
                policy_sha256=policy.content_sha256,
                session_id=session_id,
                operation=operation,
                actor="agent",
            )
        return None

    # Mode is ask_approval: compute canonical request hash including target revisions.
    request_hash = hashlib.sha256(
        canonical_json(
            {
                "policy_sha256": policy.content_sha256,
                "operation": operation,
                "request": request_payload,
            }
        ).encode("utf-8")
    ).hexdigest()

    approval_id: str | None = None
    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    expires_at = (now_dt + timedelta(seconds=DEFAULT_APPROVAL_TTL_SECONDS)).isoformat()
    client_id = policy_record.get("client_id", "local-mcp-client")

    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        require_session_authority(project, policy.content_sha256, session_id, connection=connection)
        rows = connection.execute(
            "SELECT key, value FROM metadata WHERE key LIKE 'agent-approval:%' ORDER BY rowid DESC"
        ).fetchall()
        for key, raw in rows:
            existing = parse_json(raw)
            if (
                existing.get("policy_sha256") != policy.content_sha256
                or existing.get("operation") != operation
                or existing.get("request_hash") != request_hash
                or existing.get("session_id") != session_id
            ):
                continue
            if _expire_approval(connection, key, existing):
                continue
            if existing.get("state") == "approved":
                if _target_is_stale(project, existing):
                    existing["state"] = "stale"
                    existing["updated_at"] = now
                    existing["decision_reason"] = "Target revision changed before consumption"
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (key, canonical_json(existing)),
                    )
                    raise AgentSessionApprovalError(
                        "The approved source or result revision changed before execution; "
                        "request approval again."
                    )
                if _expire_approval(connection, key, existing):
                    continue
                existing["state"] = "consumed"
                existing["consumed_at"] = now
                existing["updated_at"] = now
                connection.execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                    (key, canonical_json(existing)),
                )
                _append_event(
                    connection,
                    kind="approval_consumed",
                    summary=f"Consumed single-use approval for '{binding['summary']}'.",
                    policy_sha256=policy.content_sha256,
                    session_id=session_id,
                    approval_id=existing["id"],
                    operation=operation,
                    actor="agent",
                )
                return _public_approval(existing)
            if existing.get("state") == "pending":
                if _target_is_stale(project, existing):
                    existing["state"] = "stale"
                    existing["updated_at"] = now
                    existing["decision_reason"] = "Target revision changed while pending"
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (key, canonical_json(existing)),
                    )
                    continue
                approval_id = existing["id"]
                if session_id is not None and existing.get("session_id") != session_id:
                    existing["session_id"] = session_id
                    existing["updated_at"] = now
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (key, canonical_json(existing)),
                    )
                break

        if approval_id is None:
            approval_id = uuid.uuid4().hex
            approval_record = {
                "id": approval_id,
                "project_id": policy.project_id,
                "policy_sha256": policy.content_sha256,
                "session_id": session_id,
                "client_id": client_id,
                "operation": operation,
                "action_name": binding["action_name"],
                "category": binding["category"],
                "summary": binding["summary"],
                "request_hash": request_hash,
                "source_id": binding["source_id"],
                "source_sha256": binding["source_sha256"],
                "result_id": binding["result_id"],
                "revision_hash": binding["revision_hash"],
                "display_revision": binding["display_revision"],
                "destination_name": binding["destination_name"],
                "parameters_summary": binding["parameters_summary"],
                "state": "pending",
                "created_at": now,
                "updated_at": now,
                "expires_at": expires_at,
                "decided_at": None,
                "consumed_at": None,
                "decision_reason": None,
                "decided_by": None,
            }
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (_approval_key(approval_id), canonical_json(approval_record)),
            )
            _append_event(
                connection,
                kind="approval_requested",
                summary=f"Agent requested approval for '{binding['summary']}'.",
                policy_sha256=policy.content_sha256,
                session_id=session_id,
                approval_id=approval_id,
                operation=operation,
                actor="agent",
            )

    if session_id is not None:
        heartbeat_session(
            project,
            session_id,
            state="awaiting_approval",
            current_operation=binding["action_name"],
            current_target=target_info,
            active_approval_id=approval_id,
        )

    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        policy.recheck()
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            require_session_authority(
                project, policy.content_sha256, session_id, connection=connection
            )
            pol_row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_policy_key(policy.content_sha256),),
            ).fetchone()
            app_row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_approval_key(approval_id),),
            ).fetchone()
            if pol_row is None or app_row is None:
                raise AgentSessionApprovalError("Approval record is no longer available.")
            pol_rec = parse_json(pol_row[0])
            app_rec = parse_json(app_row[0])
            _expire_approval(connection, _approval_key(approval_id), app_rec)

            if pol_rec.get("revoked"):
                raise AgentSessionApprovalError(
                    "The agent policy was revoked while awaiting approval."
                )
            if pol_rec.get("paused"):
                raise AgentSessionApprovalError(
                    "The agent session was paused while awaiting approval."
                )

            live_mode = pol_rec.get("permission_mode", mode)
            if live_mode == "inspect_only":
                app_rec["state"] = "denied"
                app_rec["updated_at"] = timestamp()
                app_rec["decided_at"] = app_rec["updated_at"]
                app_rec["decision_reason"] = "Session switched to Inspect-only mode"
                connection.execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                    (_approval_key(approval_id), canonical_json(app_rec)),
                )
                raise AgentSessionApprovalError(
                    "Operation blocked: the session was switched to Inspect-only mode."
                )

            if _target_is_stale(project, app_rec):
                app_rec["state"] = "stale"
                app_rec["updated_at"] = timestamp()
                app_rec["decided_at"] = app_rec["updated_at"]
                app_rec["decision_reason"] = "Bound source or result revision changed while waiting"
                connection.execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                    (_approval_key(approval_id), canonical_json(app_rec)),
                )
                raise AgentSessionApprovalError(
                    "The bound source or result revision changed while awaiting approval; "
                    "inspect the updated state and request approval again."
                )

            if live_mode == "full_access" and (
                app_rec["state"] == "pending"
                or (
                    app_rec["state"] == "cancelled"
                    and app_rec.get("decision_reason") == "Policy switched to Full access mode"
                )
            ):
                app_rec["state"] = "consumed"
                app_rec["updated_at"] = timestamp()
                app_rec["decided_at"] = app_rec["updated_at"]
                app_rec["consumed_at"] = app_rec["updated_at"]
                app_rec["decided_by"] = "human-mode-switch"
                app_rec["decision_reason"] = "Session switched to Full access mode"
                connection.execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                    (_approval_key(approval_id), canonical_json(app_rec)),
                )
                consumed_rec = app_rec
            else:
                consumed_rec = None
                state = app_rec["state"]
                if state == "approved" and _expire_approval(
                    connection, _approval_key(approval_id), app_rec
                ):
                    state = "expired"
                if state == "approved":
                    app_rec["state"] = "consumed"
                    app_rec["consumed_at"] = timestamp()
                    app_rec["updated_at"] = app_rec["consumed_at"]
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (_approval_key(approval_id), canonical_json(app_rec)),
                    )
                    _append_event(
                        connection,
                        kind="approval_consumed",
                        summary=f"Approved request '{binding['summary']}' consumed for execution.",
                        policy_sha256=policy.content_sha256,
                        session_id=session_id,
                        approval_id=approval_id,
                        operation=operation,
                        actor="agent",
                    )
                    consumed_rec = app_rec

        if consumed_rec is not None:
            if session_id is not None:
                heartbeat_session(
                    project,
                    session_id,
                    state="executing",
                    active_approval_id=None,
                )
            return _public_approval(consumed_rec)
        if state == "denied":
            if session_id is not None:
                heartbeat_session(
                    project,
                    session_id,
                    state="connected_idle",
                    current_operation=None,
                    active_approval_id=None,
                )
            raise AgentSessionApprovalError("Operation denied by the user in Loci.")
        if state in {"cancelled", "expired", "stale"}:
            if session_id is not None:
                heartbeat_session(
                    project,
                    session_id,
                    state="connected_idle",
                    current_operation=None,
                    active_approval_id=None,
                )
            raise AgentSessionApprovalError(
                f"Approval request is {state}; inspect current study state before retrying."
            )

        if time.monotonic() >= deadline:
            raise AgentSessionApprovalError(
                "Operation requires human approval in Loci "
                "(request is pending in the Agent Session panel; approve it in Loci and retry)."
            )
        if session_id is not None:
            heartbeat_session(
                project,
                session_id,
                state="awaiting_approval",
                current_operation=binding["action_name"],
                current_target=target_info,
                active_approval_id=approval_id,
            )
        time.sleep(0.05)


def control_agent_session(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    """Human-only desktop control boundary for agent sessions, modes, and approvals."""
    if not isinstance(request, dict) or "action" not in request:
        raise ValueError("Agent session control requires an action")
    action = request["action"]
    project = workbench.project
    reconcile_agent_sessions(project)
    now = timestamp()

    if action in {"approve_request", "deny_request"}:
        exact_keys(request, {"action", "approval_id", "reason"}, "agent approval decision")
        approval_id = checked_id(request.get("approval_id"))
        reason = checked_text(
            request.get("reason")
            or (
                "Approved by user in Loci"
                if action == "approve_request"
                else "Denied by user in Loci"
            ),
            "Approval decision reason",
            512,
        )
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_approval_key(approval_id),),
            ).fetchone()
            if row is None:
                raise ValueError("Approval request is not part of this study")
            approval = parse_json(row[0])
            if approval["state"] not in (
                {"pending"} if action == "approve_request" else {"pending", "approved"}
            ):
                raise ValueError(f"Approval request is already {approval['state']}")
            if action == "approve_request" and _target_is_stale(project, approval):
                approval["state"] = "stale"
                approval["updated_at"] = now
                approval["decided_at"] = now
                approval["decision_reason"] = (
                    "Bound source or result revision changed before approval"
                )
                connection.execute(
                    "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                    (_approval_key(approval_id), canonical_json(approval)),
                )
                raise ValueError(
                    "The target source or result revision changed since this request was created; "
                    "the agent must request approval for the new revision."
                )
            approval["state"] = "approved" if action == "approve_request" else "denied"
            approval["updated_at"] = now
            approval["decided_at"] = now
            approval["decided_by"] = "human"
            approval["decision_reason"] = reason
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (_approval_key(approval_id), canonical_json(approval)),
            )
            verb = "approved" if action == "approve_request" else "denied"
            _append_event(
                connection,
                kind="approval_approved" if action == "approve_request" else "approval_denied",
                summary=f"User {verb} '{approval['summary']}'.",
                policy_sha256=approval["policy_sha256"],
                session_id=approval.get("session_id"),
                approval_id=approval_id,
                operation=approval.get("operation"),
                actor="human",
            )
        return workbench.snapshot()

    if action == "set_permission_mode":
        exact_keys(
            request, {"action", "policy_sha256", "permission_mode"}, "permission mode update"
        )
        policy_sha = _sha256_text(request.get("policy_sha256"), "policy_sha256")
        mode = request.get("permission_mode")
        if mode not in PERMISSION_MODES:
            raise ValueError("Choose inspect_only, ask_approval or full_access permission mode")
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_policy_key(policy_sha),),
            ).fetchone()
            if row is None:
                raise ValueError("Policy is not registered in this study")
            policy_rec = parse_json(row[0])
            if policy_rec.get("revoked"):
                raise ValueError("Cannot change mode on a revoked policy")
            policy_rec["permission_mode"] = mode
            policy_rec["updated_at"] = now
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (_policy_key(policy_sha), canonical_json(policy_rec)),
            )
            session_rows = connection.execute(
                "SELECT key, value FROM metadata WHERE key LIKE 'agent-session:%'"
            ).fetchall()
            for s_key, s_raw in session_rows:
                s_rec = parse_json(s_raw)
                if s_rec.get("policy_sha256") == policy_sha:
                    s_rec["permission_mode"] = mode
                    s_rec["updated_at"] = now
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (s_key, canonical_json(s_rec)),
                    )
            if mode == "full_access":
                _cancel_session_approvals(
                    connection,
                    policy_sha256=policy_sha,
                    reason="Policy switched to Full access mode",
                )
            if mode == "inspect_only":
                _cancel_session_approvals(
                    connection,
                    policy_sha256=policy_sha,
                    reason="Policy switched to Inspect-only mode",
                    new_state="denied",
                )
            _append_event(
                connection,
                kind="permission_mode_changed",
                summary=f"Changed permission mode to '{mode.replace('_', ' ')}'.",
                policy_sha256=policy_sha,
                actor="human",
            )
        return workbench.snapshot()

    if action in {"pause_session", "resume_session"}:
        exact_keys(request, {"action", "policy_sha256"}, "session pause control")
        policy_sha = _sha256_text(request.get("policy_sha256"), "policy_sha256")
        paused = action == "pause_session"
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_policy_key(policy_sha),),
            ).fetchone()
            if row is None:
                raise ValueError("Policy is not registered in this study")
            policy_rec = parse_json(row[0])
            if policy_rec.get("revoked"):
                raise ValueError("Cannot pause or resume a revoked policy")
            policy_rec["paused"] = paused
            policy_rec["updated_at"] = now
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (_policy_key(policy_sha), canonical_json(policy_rec)),
            )
            session_rows = connection.execute(
                "SELECT key, value FROM metadata WHERE key LIKE 'agent-session:%'"
            ).fetchall()
            for s_key, s_raw in session_rows:
                s_rec = parse_json(s_raw)
                if (
                    s_rec.get("policy_sha256") == policy_sha
                    and s_rec.get("state") in LIVE_SESSION_STATES
                ):
                    s_rec["state"] = "paused" if paused else "connected_idle"
                    s_rec["updated_at"] = now
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (s_key, canonical_json(s_rec)),
                    )
            _append_event(
                connection,
                kind="session_paused" if paused else "session_resumed",
                summary=f"User {'paused' if paused else 'resumed'} agent activity.",
                policy_sha256=policy_sha,
                actor="human",
            )
        return workbench.snapshot()

    if action == "stop_job":
        exact_keys(request, {"action", "job_id", "session_id"}, "stop agent job")
        job_id = checked_id(request.get("job_id"))
        session_id = checked_id(request.get("session_id"))
        owner = project.job(job_id).get("owner")
        if not isinstance(owner, dict) or owner.get("session_id") != session_id:
            raise PermissionError("Stop requires a job owned by the selected agent session")
        require_session_authority(project, **owner, allow_paused=True)
        cancel_job(project, job_id)
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _append_event(
                connection,
                kind="job_stopped",
                summary=f"User requested cancellation of job {job_id[:8]}.",
                actor="human",
            )
        return workbench.snapshot()

    if action == "disconnect_session":
        exact_keys(request, {"action", "session_id"}, "disconnect session")
        session_id = checked_id(request.get("session_id"))
        finish_session(project, session_id, reason="Disconnected by user in Loci")
        return workbench.snapshot()

    if action == "revoke_policy":
        exact_keys(request, {"action", "policy_sha256"}, "revoke policy")
        policy_sha = _sha256_text(request.get("policy_sha256"), "policy_sha256")
        private_path: str | None = None
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_policy_key(policy_sha),),
            ).fetchone()
            if row is None:
                raise ValueError("Policy is not registered in this study")
            policy_rec = parse_json(row[0])
            private_path = policy_rec.get("private_policy_path")
            policy_rec["revoked"] = True
            policy_rec["paused"] = False
            policy_rec["revoke_reason"] = "Revoked by user in Loci"
            policy_rec["state"] = "disconnected"
            policy_rec["updated_at"] = now
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                (_policy_key(policy_sha), canonical_json(policy_rec)),
            )
            session_rows = connection.execute(
                "SELECT key, value FROM metadata WHERE key LIKE 'agent-session:%'"
            ).fetchall()
            for s_key, s_raw in session_rows:
                s_rec = parse_json(s_raw)
                if (
                    s_rec.get("policy_sha256") == policy_sha
                    and s_rec.get("state") in LIVE_SESSION_STATES
                ):
                    s_rec["state"] = "disconnected"
                    s_rec["ended_at"] = now
                    s_rec["updated_at"] = now
                    s_rec["current_operation"] = None
                    s_rec["active_approval_id"] = None
                    s_rec["disconnect_reason"] = "Policy revoked by user in Loci"
                    connection.execute(
                        "INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (s_key, canonical_json(s_rec)),
                    )
            _cancel_session_approvals(
                connection,
                policy_sha256=policy_sha,
                reason="Policy revoked by user in Loci",
            )
            bundle_label = policy_rec.get("bundle_name", policy_sha[:8])
            _append_event(
                connection,
                kind="policy_revoked",
                summary=f"User revoked access bundle '{bundle_label}'.",
                policy_sha256=policy_sha,
                actor="human",
            )
        if isinstance(private_path, str):
            try:
                path = Path(private_path)
                if (
                    path.is_file()
                    and not path.is_symlink()
                    and hashlib.sha256(path.read_bytes()).hexdigest() == policy_sha
                ):
                    path.unlink()
            except OSError:
                pass
        for job in project.list_jobs():
            if job.get("owner", {}).get("policy_sha256") == policy_sha and job.get("state") in {
                "queued",
                "running",
            }:
                cancel_job(project, job["id"])
        return workbench.snapshot()

    raise ValueError(f"Unsupported agent session control action: {action}")


def _public_policy(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if not key.startswith("private_")}


def _public_session(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if not key.startswith("private_")}


def _public_approval(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if not key.startswith("private_")}


def agent_sessions_snapshot(project: ResearchProject) -> dict[str, Any]:
    """Return the renderer-safe snapshot of agent policies, live sessions, approvals, and events."""
    reconcile_agent_sessions(project)
    with project.connection() as connection:
        policies = [
            _public_policy(parse_json(row[0]))
            for row in connection.execute(
                "SELECT value FROM metadata WHERE key LIKE 'agent-policy:%' ORDER BY rowid DESC"
            )
        ]
        sessions = [
            _public_session(parse_json(row[0]))
            for row in connection.execute(
                "SELECT value FROM metadata WHERE key LIKE 'agent-session:%' ORDER BY rowid DESC"
            )
        ]
        approvals = [
            _public_approval(parse_json(row[0]))
            for row in connection.execute(
                "SELECT value FROM metadata WHERE key LIKE 'agent-approval:%' ORDER BY rowid DESC"
            )
        ]
        events = [
            parse_json(row[0])
            for row in connection.execute(
                "SELECT value FROM metadata WHERE key LIKE 'agent-event:%' "
                "ORDER BY key DESC LIMIT 50"
            )
        ]

    jobs = project.list_jobs()
    for session in sessions:
        owned = [
            job
            for job in jobs
            if job.get("owner")
            == {"policy_sha256": session["policy_sha256"], "session_id": session["session_id"]}
        ]
        session["owned_job_ids"] = [job["id"] for job in owned]
        session["recent_result_ids"] = list(
            dict.fromkeys(
                result_id
                for job in sorted(owned, key=lambda item: item.get("finished_at") or "")
                if job["state"] == "succeeded"
                for result_id in job.get("result_ids", [])
            )
        )

    live_sessions = [s for s in sessions if s.get("state") in LIVE_SESSION_STATES]
    pending_approvals = [a for a in approvals if a.get("state") == "pending"]
    active_policies = [p for p in policies if not p.get("revoked")]

    sessions_by_policy: dict[str, list[dict[str, Any]]] = {}
    for session in sessions:
        sessions_by_policy.setdefault(session["policy_sha256"], []).append(session)

    for policy in policies:
        sha = policy["policy_sha256"]
        pol_sessions = sessions_by_policy.get(sha, [])
        pol_live = [s for s in pol_sessions if s.get("state") in LIVE_SESSION_STATES]
        if policy.get("revoked"):
            policy["state"] = "disconnected"
        elif pol_live:
            policy["state"] = pol_live[0]["state"]
        elif pol_sessions:
            policy["state"] = pol_sessions[0]["state"]
        else:
            policy["state"] = "configuration_ready"

    # Determine aggregate status truthfully: configuration_ready is never a connected client.
    if any(s.get("state") == "awaiting_approval" for s in live_sessions) or pending_approvals:
        status = "awaiting_approval"
    elif any(s.get("state") == "executing" for s in live_sessions):
        status = "executing"
    elif any(s.get("state") == "paused" for s in live_sessions) or (
        not live_sessions and any(p.get("paused") for p in active_policies)
    ):
        status = "paused"
    elif any(s.get("state") == "connected_idle" for s in live_sessions):
        status = "connected_idle"
    elif any(s.get("state") == "interrupted" for s in sessions):
        status = "interrupted"
    elif any(s.get("state") == "failed" for s in sessions):
        status = "failed"
    elif active_policies and not sessions:
        status = "configuration_ready"
    elif sessions:
        status = "disconnected"
    else:
        status = "none"

    return {
        "schema": SESSION_SNAPSHOT_SCHEMA,
        "status": status,
        "connected_count": len(live_sessions),
        "pending_approval_count": len(pending_approvals),
        "policies": policies,
        "sessions": sessions,
        "approvals": approvals,
        "events": events,
        "capability_map": capability_map(),
    }
