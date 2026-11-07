"""Bounded local GUI handshake for policy-owned volume controls and native images.

The mailbox carries data, never executable dispatch or native source paths to a
renderer. Only a live registered GUI can acknowledge a rendered scene.
"""

from __future__ import annotations

import copy
import hashlib
import time
import uuid

from .quantitative import integer
from .research_project import canonical_json, parse_json, timestamp
from .volume_view_state import (
    PATCH_GROUPS,
    digest,
    exact,
    read_volume_view,
    validate_live_result_grid,
    validate_volume_state,
)

PRESENCE_TTL_SECONDS = 10
REQUEST_TTL_SECONDS = 30
MAX_REQUESTS = 32
MAX_HISTORY = 128
MAX_CAPTURE_PNG_BYTES = 8 * 1024**2
LIVE_KEYS = {"view_id", "renderer_generation", "live_epoch", "revision", "display_revision"}
PRESENCE_KEYS = LIVE_KEYS | {"source_id", "source_sha256", "busy", "available"}
TERMINAL = {"complete", "failed", "cancelled"}


def validate_live(value):
    exact(value, LIVE_KEYS, "live volume token")
    if (
        not isinstance(value["view_id"], str)
        or not 1 <= len(value["view_id"]) <= 128
        or any(
            c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_:"
            for c in value["view_id"]
        )
    ):
        raise ValueError("Invalid live view identity")
    for key in LIVE_KEYS - {"view_id"}:
        integer(value[key], key, 0, 2**53 - 1)
    return value


def _document(project, kind, identity):
    values = project.documents(kind, document_id=identity)
    return values[0] if values else None


def presence(project, source_id):
    document = _document(project, "volume_view_presence", source_id)
    if not document or time.time() - document["data"]["heartbeat"] > PRESENCE_TTL_SECONDS:
        return None
    data = document["data"]
    return copy.deepcopy({key: data[key] for key in PRESENCE_KEYS})


def live_token(value):
    return {key: value[key] for key in LIVE_KEYS}


def _current(project, source_id, expected, *, ready=True):
    validate_live(expected)
    current = presence(project, source_id)
    if current is None or not current["available"]:
        raise ValueError("VIEW_UNAVAILABLE: no live GUI volume view")
    if live_token(current) != expected:
        raise ValueError("VIEW_STALE: human or renderer state changed")
    if ready and current["busy"]:
        raise ValueError("VIEW_BUSY: finish the current human interaction")
    saved = read_volume_view(project, source_id)
    if (
        saved["revision"] != expected["revision"]
        or saved["display_revision"] != expected["display_revision"]
    ):
        raise ValueError("VIEW_STALE: saved view or display changed")
    return current


def publish_presence(project, request):
    exact(request, PRESENCE_KEYS, "volume presence")
    validate_live(live_token(request))
    saved = read_volume_view(project, request["source_id"])
    if request["source_sha256"] != saved["source_sha256"]:
        raise ValueError("Presence source identity changed")
    if type(request["busy"]) is not bool or type(request["available"]) is not bool:
        raise ValueError("Presence readiness must be boolean")
    if request["available"] and (
        request["revision"] != saved["revision"]
        or request["display_revision"] != saved["display_revision"]
    ):
        raise ValueError("Presence does not describe the current saved state")
    previous = _document(project, "volume_view_presence", request["source_id"])
    if previous:
        old = previous["data"]
        if (
            old["view_id"] == request["view_id"]
            and old["renderer_generation"] == request["renderer_generation"]
            and request["live_epoch"] < old["live_epoch"]
        ):
            raise ValueError("Live epoch cannot move backwards")
    project.put_document(
        "volume_view_presence",
        request["source_id"],
        {**request, "heartbeat": time.time()},
        expected_revision=previous["revision"] if previous else 0,
    )
    return presence(project, request["source_id"])


def authorize_record(project, record):
    """Reload the pinned authority at every native publication/delivery boundary."""
    from .agent_policy import load_policy
    from .agent_sessions import (
        DEFAULT_HEARTBEAT_TTL_SECONDS,
        _parse_iso,
        _session_key,
        effective_permission_mode,
        require_session_authority,
    )

    policy = load_policy(record["policy_path"])
    if (
        policy.content_sha256 != record["owner"]["policy_sha256"]
        or policy.project_id != project.meta["project_id"]
        or policy.project_path != project.root
        or list(policy.file_identity) != record["policy_file_identity"]
        or list(policy.project_directory_identity) != record["project_directory_identity"]
    ):
        raise PermissionError("Volume request policy changed")
    require_session_authority(project, policy.content_sha256, record["owner"]["session_id"])
    if record["owner"]["session_id"] is not None:
        with project.connection() as connection:
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                (_session_key(record["owner"]["session_id"]),),
            ).fetchone()
        session = parse_json(row[0]) if row else {}
        heartbeat = _parse_iso(session.get("last_heartbeat_at"))
        if heartbeat is None or time.time() - heartbeat.timestamp() > DEFAULT_HEARTBEAT_TTL_SECONDS:
            raise PermissionError("Volume request agent session expired")
    policy.require_operation("set_volume_view" if record["kind"] == "set" else "volume_view_image")
    if record["kind"] == "set" and (
        effective_permission_mode(project, policy) == "inspect_only"
        or effective_permission_mode(project, policy) != record["authorized_mode"]
    ):
        raise PermissionError("Volume request permission mode changed")
    from .agent_volume_view import authorize_scene

    authorize_scene(policy, project, record["source_id"], record["proposed_state"], record["kind"])
    return policy


def enqueue(agent, project, kind, request, *, authorized_mode):
    current = read_volume_view(project, request["source_id"])
    expected = request["expected_live"]
    _current(project, request["source_id"], expected)
    if current["state"] is None:
        raise ValueError("VIEW_UNAVAILABLE: the GUI has not saved a volume scene")
    state = copy.deepcopy(current["state"])
    if kind == "set":
        patch = request["patch"]
        if not isinstance(patch, dict) or not patch or not set(patch) <= PATCH_GROUPS:
            raise ValueError("Volume patch requires explicit supported scene groups")
        state.update(copy.deepcopy(patch))
        validate_volume_state(project, project.source(current["source_id"]), state)
    documents = project.documents("volume_view_request")
    now = time.time()
    pending = [
        d for d in documents if d["data"]["status"] not in TERMINAL and d["data"]["deadline"] >= now
    ]
    if len(pending) >= MAX_REQUESTS:
        raise ValueError("Volume GUI request capacity reached")
    # Keep a bounded latest receipt per request; prune only terminal/expired mailbox
    # entries, never scientific records or the saved presentation.
    if len(documents) >= MAX_HISTORY:
        removable = sorted(
            (d for d in documents if d not in pending), key=lambda d: d["updated_at"]
        )
        with project.connection() as connection:
            for document in removable[: len(documents) - MAX_HISTORY + 1]:
                connection.execute(
                    "DELETE FROM documents WHERE kind='volume_view_request' AND id=?",
                    (document["id"],),
                )
    identity = uuid.uuid4().hex
    record = {
        "schema": "loci.volume-view-request/v1",
        "request_id": identity,
        "source_id": current["source_id"],
        "source_sha256": current["source_sha256"],
        "owner": agent.job_owner,
        "policy_file_identity": list(agent.policy.file_identity),
        "project_directory_identity": list(agent.policy.project_directory_identity),
        "policy_path": str(agent.policy.path),
        "kind": kind,
        "status": "queued",
        "deadline": now + REQUEST_TTL_SECONDS,
        "expected_live": copy.deepcopy(expected),
        "proposed_state": state,
        "panes": request.get("panes", []),
        "max_size": request.get("max_size", 1024),
        "response": None,
        "authorized_mode": authorized_mode,
    }

    def guard():
        agent._recheck_session()
        _current(project, current["source_id"], expected)
        if kind == "set":
            from .agent_sessions import effective_permission_mode

            if effective_permission_mode(project, agent.policy) != authorized_mode:
                raise PermissionError("Volume request permission mode changed")
        active = [
            d
            for d in project.documents("volume_view_request")
            if d["data"]["status"] not in TERMINAL
            and d["data"]["deadline"] >= time.time()
            and d["id"] != identity
        ]
        if len(active) >= MAX_REQUESTS:
            raise ValueError("Volume GUI request capacity reached")

    project.put_document(
        "volume_view_request", identity, record, expected_revision=0, publication_guard=guard
    )
    return {"request_id": identity, "status": "queued", "kind": kind}


def request_document(project, identity):
    from .research_project import checked_id

    document = _document(project, "volume_view_request", checked_id(identity))
    if not document:
        raise ValueError("Unknown or expired volume request")
    return document


def _put(connection, kind, identity, data, revision):
    envelope = {
        "id": identity,
        "kind": kind,
        "revision": revision + 1,
        "updated_at": timestamp(),
        "data": data,
    }
    connection.execute(
        "INSERT OR REPLACE INTO documents VALUES(?,?,?,?)",
        (kind, identity, revision + 1, canonical_json(envelope)),
    )


def _locked_document(connection, kind, identity):
    row = connection.execute(
        "SELECT record FROM documents WHERE kind=? AND id=?", (kind, identity)
    ).fetchone()
    return parse_json(row[0]) if row else None


def _guard_request(project, document, supplied_live, statuses):
    record = document["data"]
    if record["status"] not in statuses or record["deadline"] < time.time():
        raise ValueError("Volume request expired or is no longer pending")
    expected = record.get("applied_live", record["expected_live"])
    if supplied_live != expected:
        raise ValueError("VIEW_STALE: response token differs from the request")
    _current(project, record["source_id"], expected)
    authorize_record(project, record)
    return record


def apply_request(project, request):
    exact(request, {"request_id", "live_token"}, "apply volume request")
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        document = _locked_document(connection, "volume_view_request", request["request_id"])
        if document is None:
            raise ValueError("Unknown volume request")
        record = _guard_request(project, document, request["live_token"], {"queued"})
        if record["kind"] != "set":
            raise ValueError("Only a state request can be applied")
        saved = read_volume_view(project, record["source_id"])
        source = project.source(record["source_id"])
        validate_volume_state(project, source, record["proposed_state"])
        validate_live_result_grid(project, source, record["proposed_state"])
        next_data = {
            key: saved[key] for key in ("schema", "source_id", "source_sha256", "geometry_sha256")
        }
        next_data["state"] = record["proposed_state"]
        _put(connection, "volume_view", record["source_id"], next_data, saved["revision"])
        record["status"] = "applying"
        record["applied_live"] = {**record["expected_live"], "revision": saved["revision"] + 1}
        registered = _locked_document(connection, "volume_view_presence", record["source_id"])
        registered["data"]["revision"] = saved["revision"] + 1
        _put(
            connection,
            "volume_view_presence",
            record["source_id"],
            registered["data"],
            registered["revision"],
        )
        _put(connection, "volume_view_request", record["request_id"], record, document["revision"])
    return {
        "request_id": record["request_id"],
        "status": "applying",
        "live_token": record["applied_live"],
        "view": read_volume_view(project, record["source_id"]),
    }


def complete_request(project, request):
    exact(request, {"request_id", "live_token", "capture"}, "complete volume request")
    document = request_document(project, request["request_id"])
    record = _guard_request(project, document, request["live_token"], {"queued", "applying"})
    if record["kind"] == "image":
        capture = exact(request["capture"], {"image", "rendering"}, "GUI volume capture")
        from .agent_vision import validate_png

        encoded = validate_png(capture["image"])
        if len(encoded) > MAX_CAPTURE_PNG_BYTES:
            raise ValueError("GUI capture exceeds the bounded mailbox image size")
        rendering = exact(
            capture["rendering"],
            {
                "kind",
                "source_id",
                "source_sha256",
                "geometry_sha256",
                "live_token",
                "panes",
                "width",
                "height",
                "manifest",
            },
            "GUI capture receipt",
        )
        integer(rendering["width"], "capture width", 1, 2048)
        integer(rendering["height"], "capture height", 1, 2048)
        if len(canonical_json(rendering).encode()) > 256 * 1024:
            raise ValueError("GUI capture receipt exceeds its bound")
        saved = read_volume_view(project, record["source_id"])
        if (
            rendering["kind"] != "gui-rendered-scene"
            or rendering["source_id"] != record["source_id"]
            or rendering["source_sha256"] != record["source_sha256"]
            or rendering["geometry_sha256"] != saved["geometry_sha256"]
            or rendering["live_token"] != request["live_token"]
            or rendering["panes"] != record["panes"]
        ):
            raise ValueError("GUI capture lost its exact scene binding")
        import io

        from PIL import Image

        with Image.open(io.BytesIO(encoded)) as image:
            if (
                image.size != (rendering["width"], rendering["height"])
                or max(image.size) > record["max_size"]
            ):
                raise ValueError("GUI capture dimensions disagree with its request")
        # The manifest is a data receipt, never a command or a source locator.
        _reject_paths(rendering["manifest"])
        validate_capture_manifest(project, saved, rendering)
        response = {
            "image": capture["image"],
            "rendering": {
                **rendering,
                "png_sha256": hashlib.sha256(encoded).hexdigest(),
                "display_only": True,
            },
        }
    else:
        if record["status"] != "applying" or request["capture"] is not None:
            raise ValueError("State application needs a renderer acknowledgement without an image")
        response = {"view": read_volume_view(project, record["source_id"]), "rendered": True}
    record["status"] = "complete"
    record["response"] = response

    def guard():
        _current(project, record["source_id"], request["live_token"])
        authorize_record(project, record)

    project.put_document(
        "volume_view_request",
        record["request_id"],
        record,
        expected_revision=document["revision"],
        publication_guard=guard,
    )
    return {"request_id": record["request_id"], "status": "complete"}


def validate_capture_manifest(project, saved, rendering):
    manifest = exact(
        rendering["manifest"],
        {
            "schema",
            "source_id",
            "source_sha256",
            "state",
            "display_channels",
            "raw_payloads",
            "labels",
            "panes",
            "composition",
            "image_size",
        },
        "scene capture manifest",
    )
    if (
        manifest["schema"] != "loci.volume-scene-capture/v1"
        or manifest["source_id"] != saved["source_id"]
        or manifest["source_sha256"] != saved["source_sha256"]
        or manifest["state"] != saved["state"]
        or manifest["panes"] != rendering["panes"]
        or manifest["composition"] != "gui-pane-contact-sheet"
        or manifest["image_size"] != [rendering["width"], rendering["height"]]
    ):
        raise ValueError("Scene capture manifest disagrees with its exact saved view")
    if saved["state"]["camera"] is None:
        raise ValueError("Scene capture requires a saved exact GUI camera")
    validate_volume_state(project, project.source(saved["source_id"]), manifest["state"])
    payloads = exact(
        manifest["raw_payloads"],
        {"context_data_sha256", "focus_data_sha256"},
        "scene payload hashes",
    )
    digest(payloads["context_data_sha256"], "context payload")
    if payloads["focus_data_sha256"] is not None:
        digest(payloads["focus_data_sha256"], "focus payload")
    if (
        saved["state"]["representation"]["extent"] == "focus"
        and payloads["focus_data_sha256"] is None
    ):
        raise ValueError("Focus capture lost its verified focus payload")
    from .source_view_state import SCHEMA, execute_view_state, validate_view_data
    from .workbench import Workbench

    display = execute_view_state(
        Workbench(project), "source_view", {"source_id": saved["source_id"]}
    )
    if display["state"] is None or display["revision"] != saved["display_revision"]:
        raise ValueError("Save exact source display settings before GUI capture")
    by_channel = {entry["channel"]: entry for entry in display["state"]["channels"]}
    channels = [by_channel.get(index) for index in saved["state"]["channels"]]
    supplied = manifest["display_channels"]
    if not isinstance(supplied, list) or len(supplied) != len(channels):
        raise ValueError("Scene capture transfers disagree with the saved source display")
    resolved = copy.deepcopy(display["state"])
    resolved["channels"] = supplied
    resolved["rgb_mapping"] = None
    validate_view_data(
        {
            "schema": SCHEMA,
            "source_id": saved["source_id"],
            "source_sha256": saved["source_sha256"],
            "state": resolved,
        },
        project.source(saved["source_id"]),
    )

    # JSON/JavaScript represents 30.0 as 30, and color hex case has no display
    # meaning. Validate first, then compare actual values without lossy rounding.
    def normalized(entries):
        return [
            {**entry, "color": entry["color"].lower(), "opacity": entry.get("opacity", 1)}
            for entry in entries
        ]

    if (
        None in channels
        or any(not isinstance(entry, dict) for entry in supplied)
        or normalized(supplied) != normalized(channels)
    ):
        raise ValueError("Scene capture transfers disagree with the saved source display")
    labels = manifest["labels"]
    if not saved["state"]["labels"]["visible"]:
        if labels is not None:
            raise ValueError("Hidden labels cannot be claimed in a scene capture")
    else:
        exact(
            labels,
            {"binding", "data_sha256", "rendering", "mpr_interpolation", "stride"},
            "scene label receipt",
        )
        if (
            labels["binding"] != saved["state"]["result"]
            or labels["rendering"] != "nearest-sampled-voxel-boundaries"
            or labels["mpr_interpolation"] != "nearest-native"
        ):
            raise ValueError("Scene labels lost their result or rendering binding")
        digest(labels["data_sha256"], "label payload")
        if not isinstance(labels["stride"], list) or len(labels["stride"]) != 3:
            raise ValueError("Scene labels require explicit XYZ sampling stride")
        for value in labels["stride"]:
            integer(value, "label stride", 1, 2**31 - 1)


def _reject_paths(value, depth=0):
    if depth > 16:
        raise ValueError("Capture receipt exceeds nesting bound")
    if isinstance(value, dict):
        for key, item in value.items():
            if any(term in key.lower() for term in ("path", "locator", "directory")):
                raise ValueError("Capture receipt must not contain native locations")
            _reject_paths(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _reject_paths(item, depth + 1)
    elif isinstance(value, str) and (value.startswith(("/", "file:", "\\")) or ":\\" in value):
        raise ValueError("Capture receipt must not contain native locations")


def fail_request(project, request):
    exact(request, {"request_id", "reason"}, "fail volume request")
    if request["reason"] not in {"unavailable", "stale", "busy", "capture-failed", "cancelled"}:
        raise ValueError("Unsupported volume request failure")
    document = request_document(project, request["request_id"])
    record = document["data"]
    if record["status"] in TERMINAL:
        return {"request_id": record["request_id"], "status": record["status"]}
    record["status"] = "failed"
    record["response"] = {"reason": request["reason"]}
    project.put_document(
        "volume_view_request", record["request_id"], record, expected_revision=document["revision"]
    )
    return {"request_id": record["request_id"], "status": "failed"}


def execute_native(workbench, operation, request):
    project = workbench.project
    if operation == "volume_view_presence":
        return publish_presence(project, request)
    if operation == "volume_view_request_apply":
        return apply_request(project, request)
    if operation == "volume_view_request_complete":
        return complete_request(project, request)
    if operation == "volume_view_request_fail":
        return fail_request(project, request)
    exact(request, set(), "pending volume requests")
    output = []
    for document in project.documents("volume_view_request"):
        record = document["data"]
        if record["status"] not in {"queued", "applying"} or record["deadline"] < time.time():
            continue
        try:
            _guard_request(
                project,
                document,
                record.get("applied_live", record["expected_live"]),
                {"queued", "applying"},
            )
        except (ValueError, PermissionError):
            continue
        output.append(
            {
                key: copy.deepcopy(record[key])
                for key in (
                    "request_id",
                    "source_id",
                    "source_sha256",
                    "kind",
                    "status",
                    "expected_live",
                    "proposed_state",
                    "panes",
                    "max_size",
                )
            }
        )
        if "applied_live" in record:
            output[-1]["applied_live"] = record["applied_live"]
        if len(output) >= MAX_REQUESTS:
            break
    return {"requests": output}
