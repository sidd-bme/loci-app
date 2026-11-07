"""Explicit policy-scoped access to the human GUI's saved 3D scene."""

from __future__ import annotations

import copy
import time

from .quantitative import integer
from .volume_view_state import exact, read_volume_view, source_dimensions


def authorize_scene(policy, project, source_id, state, kind):
    grants = policy.volume_views
    permission = {"read": "read", "set": "write", "image": "image"}[kind]
    if grants is None or not grants[permission]:
        raise PermissionError("The pinned policy does not grant this volume view access")
    for category in ("geometry", "provenance", "agent_metadata"):
        policy.require_disclosure(category)
    if kind == "image":
        policy.require_disclosure("previews")
    grant = policy.source_grant(project, source_id)
    source = project.source(source_id)
    dimensions = source_dimensions(source)
    # Whole context remains present even when Focus, clipping or zoom hides it.
    # Authorization follows every payload input, never apparent screen visibility.
    channels = state["channels"] if state else list(grant.c)
    t = state["t"] if state else (grant.t[0] if grant.t else 0)
    selection = {
        "x": 0,
        "y": 0,
        "width": dimensions["x"],
        "height": dimensions["y"],
        "z": 0,
        "z_stop": dimensions["z"],
        "t": t,
        "level": 0,
    }
    if not channels or any(
        not grant.allows({**selection, "c": channel}, []) for channel in channels
    ):
        raise PermissionError("Whole volume context or a displayed channel exceeds policy")
    if state and state["result"]:
        result = project.result(state["result"]["result_id"], verify_scientific_arrays=False)
        if (
            result["revision_hash"] != state["result"]["revision_hash"]
            or result["source_id"] != source_id
            or result["source_sha256"] != source["sha256"]
        ):
            raise PermissionError("Volume result revision is outside the source grant")
    return grant


def volume_view(agent, source_id):
    workbench = agent._workbench("volume_view")
    try:
        from .volume_view_mailbox import presence

        value = read_volume_view(workbench.project, source_id)
        authorize_scene(agent.policy, workbench.project, source_id, value["state"], "read")
        agent._recheck_session()
        return {**value, "live": presence(workbench.project, source_id), "display_only": True}
    finally:
        workbench.close()


def submit(agent, kind, request):
    operation = "set_volume_view" if kind == "set" else "volume_view_image"
    workbench = agent._workbench(operation)
    try:
        from .agent_sessions import check_or_await_approval, effective_permission_mode
        from .volume_view_mailbox import enqueue, validate_live

        fields = {"source_id", "source_sha256", "expected_live"} | (
            {"patch"} if kind == "set" else {"panes", "max_size"}
        )
        exact(request, fields, operation)
        value = read_volume_view(workbench.project, request["source_id"])
        if request["source_sha256"] != value["source_sha256"]:
            raise ValueError("Volume source fingerprint changed")
        validate_live(request["expected_live"])
        state = copy.deepcopy(value["state"])
        if state is None:
            raise ValueError("VIEW_UNAVAILABLE: no saved GUI volume scene")
        # Check the observed scene as well as the proposed one: a patch cannot
        # gain authority by hiding an ungranted input from its final state.
        authorize_scene(agent.policy, workbench.project, request["source_id"], state, kind)
        if kind == "set":
            patch = request["patch"]
            if (
                not isinstance(patch, dict)
                or not patch
                or not set(patch) <= set(agent.policy.volume_views["fields"])
            ):
                raise PermissionError("Volume patch exceeds explicitly granted scene fields")
            state.update(copy.deepcopy(patch))
            if state["camera"] is None:
                raise ValueError("A rendered scene write requires an exact resolved camera")
            authorize_scene(agent.policy, workbench.project, request["source_id"], state, kind)
        else:
            panes = request["panes"]
            if (
                not isinstance(panes, list)
                or not 1 <= len(panes) <= 4
                or any(not isinstance(p, str) for p in panes)
                or len(set(panes)) != len(panes)
                or not set(panes) <= {"volume", "axial", "coronal", "sagittal"}
            ):
                raise ValueError("Choose 1-4 distinct actual GUI panes")
            integer(request["max_size"], "capture maximum size", 64, 2048)
        mode = effective_permission_mode(workbench.project, agent.policy)
        check_or_await_approval(agent, workbench, operation, request)
        if mode != effective_permission_mode(workbench.project, agent.policy):
            raise PermissionError("Volume request permission mode changed; retry explicitly")
        agent._recheck_session()
        return enqueue(agent, workbench.project, kind, request, authorized_mode=mode)
    finally:
        workbench.close()


def request_status(agent, request_id, *, cancel=False):
    operation = "cancel_volume_view_request" if cancel else "volume_view_request_status"
    workbench = agent._workbench(operation)
    try:
        from .volume_view_mailbox import TERMINAL, authorize_record, request_document

        document = request_document(workbench.project, request_id)
        record = document["data"]
        if record["owner"] != agent.job_owner:
            raise PermissionError("Volume request belongs to another policy or session")
        if cancel:
            if record["status"] not in TERMINAL:
                committed = record["status"] == "applying"
                record["status"] = "cancelled"
                record["response"] = {
                    "reason": "cancelled",
                    "scene_committed": committed,
                    "revision": record.get("applied_live", record["expected_live"])["revision"],
                }
                workbench.project.put_document(
                    "volume_view_request",
                    request_id,
                    record,
                    expected_revision=document["revision"],
                    publication_guard=agent._recheck_session,
                )
        else:
            authorize_record(workbench.project, record)
        agent._recheck_session()
        if record["status"] not in TERMINAL and record["deadline"] < time.time():
            return {
                "request_id": request_id,
                "kind": record["kind"],
                "status": "failed",
                "response": {"reason": "expired"},
            }
        return {
            "request_id": request_id,
            "kind": record["kind"],
            "status": record["status"],
            "response": copy.deepcopy(record["response"]),
        }
    finally:
        workbench.close()
