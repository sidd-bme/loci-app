"""Study authorization for the installed scalar-plane Cellpose-SAM v2 workflow."""

from __future__ import annotations

import hashlib

import numpy as np

from .agent_policy import SourceGrant
from .profiles import CELLPOSE_PROFILE_ID
from .quantitative import exact_keys, integer
from .research_cellpose import _measurement_channels, _settings

CELLPOSE_ACTIONS = frozenset({"cellpose_model_status", "cellpose_preview", "cellpose_adopt"})


def require_scalar_plane(source, selection):
    metadata = source["metadata"]
    if (
        source.get("source_kind") not in {"native", "whole_slide", "ome_zarr"}
        or type(selection.get("level")) is not int
        or selection["level"] != 0
        or "z_stop" in selection
        or metadata.get("sample_semantics") in {"RGB", "RGBA"}
        or metadata.get("rgb") is True
        or metadata.get("rgb_samples")
        or metadata.get("is_rgb")
        or "S" in metadata.get("axes", "")
        or metadata.get("dimensions", {}).get("s", 1) > 1
    ):
        raise ValueError("Cellpose model access requires one level-zero scalar source plane")


def validate_model_scope(project, scope, sources):
    from .agent_actions import _schema_check
    from .research_action_registry import REQUESTS

    exact_keys(scope, {"source_id", "selection", "measurement_channels"}, "Cellpose source scope")
    source_id = scope.get("source_id")
    if not isinstance(source_id, str) or source_id not in sources:
        raise ValueError("Cellpose scope must bind a granted study source")
    selection = scope.get("selection")
    _schema_check(selection, REQUESTS["cellpose_preview"]["properties"]["selection"])
    if not sources[source_id].allows(selection, []):
        raise ValueError("Cellpose inference selection exceeds its source grant")
    source = project.source(source_id)
    require_scalar_plane(source, selection)
    count = len(source["metadata"].get("channel_names") or ["Intensity"])
    _measurement_channels(scope.get("measurement_channels"), count)


def require_model_scope(policy, source_id, selection, channels):
    scope = policy.cellpose_scope
    if scope is None or scope["source_id"] != source_id:
        raise PermissionError("Cellpose requires the explicitly selected study source")
    plane = scope["selection"]
    if (
        not isinstance(selection, dict)
        or set(selection) != set(plane)
        or any(type(value) is not int for value in selection.values())
        or not isinstance(channels, list)
        or any(type(channel) is not int for channel in channels)
        or len(set(channels)) != len(channels)
    ):
        raise PermissionError("Cellpose requires one resolved plane and distinct raw channels")
    grant = SourceGrant(
        source_id,
        policy.sources[source_id].sha256,
        tuple(plane[k] for k in ("x", "y", "width", "height")),
        (plane["t"],),
        (plane["c"],),
        (plane["z"],),
        (plane["level"],),
        tuple(scope["measurement_channels"]),
    )
    if not grant.allows(selection, channels):
        raise PermissionError(
            "Cellpose inference selection or measurement channels exceed its grant"
        )


def require_installed_pins(policy):
    from .research_cellpose import installed_cellpose_pins

    package, runtime = installed_cellpose_pins()
    policy.require_model(package)
    policy.require_runtime(runtime)
    return package, runtime


def authorize_cellpose(agent, workbench, operation, request):
    from .agent_actions import _schema_check, source_scope
    from .research_action_registry import REQUESTS

    policy = agent.policy
    if (
        policy.cellpose_scope is None
        or (policy.delegation or {}).get("result_scope") != "granted-sources"
    ):
        raise PermissionError("Cellpose actions require delegated study source access")
    if operation == "cellpose_model_status":
        from .cellpose_backend import CELLPOSE_SAM_V2_SPEC

        policy.require_model(
            {"id": CELLPOSE_SAM_V2_SPEC.artifact_id, "sha256": CELLPOSE_SAM_V2_SPEC.sha256}
        )

        return
    if operation == "cellpose_adopt":
        from .research_cellpose import cellpose_preview_request

        if not agent.session_id:
            raise PermissionError("Cellpose adoption requires a registered session")
        try:
            job = workbench.project.job(request["preview_id"])
        except ValueError:
            raise PermissionError("Select a Cellpose preview produced in this session") from None
        if (
            job.get("owner") != agent.job_owner
            or job.get("operation") != "cellpose_preview"
            or job.get("state") != "succeeded"
        ):
            raise PermissionError("Select a completed Cellpose preview produced in this session")
        request = cellpose_preview_request(
            workbench, request["preview_id"], request["preview_sha256"]
        )
        if job["request"]["task_request"] != request:
            raise PermissionError("Cellpose preview receipt differs from the owned job request")
    _schema_check(request, REQUESTS["cellpose_preview"])
    settings = _settings(request["settings"])
    if request["profile_id"] != CELLPOSE_PROFILE_ID or settings.device != "cpu":
        raise PermissionError("Choose the pinned Cellpose-SAM v2 CPU profile")
    source_id, selection = request["source_id"], request["selection"]
    require_model_scope(policy, source_id, selection, request["measurement_channels"])
    source_scope(policy, workbench, source_id, selection, [])
    source = workbench.project.source(source_id)
    require_scalar_plane(source, selection)
    channels = _measurement_channels(
        request["measurement_channels"], len(workbench.channel_metadata(source_id)["channels"])
    )
    from .research_cellpose import CELLPOSE_MIN_POLICY_MEMORY_BYTES, estimate_cellpose_memory_bytes

    budget = integer(
        request["working_bytes"], "Cellpose working bytes", 1024**2, policy.memory_bytes
    )
    metadata = source["metadata"]
    types = metadata.get("channel_dtypes")
    dtype = types[selection["c"]] if types else metadata.get("dtype")
    if not isinstance(dtype, str):
        raise ValueError("Cellpose source channel has no verified scalar type")
    estimate = estimate_cellpose_memory_bytes(
        selection["width"], selection["height"], np.dtype(dtype).itemsize, len(channels), settings
    )
    # Native select_device skips the accelerator capacity probe on explicit CPU.
    # The array working set and the disposable process memory limit are separate.
    if (
        policy.memory_bytes < CELLPOSE_MIN_POLICY_MEMORY_BYTES
        or estimate["required_working_bytes"] > budget
    ):
        raise PermissionError("Cellpose execution exceeds the granted memory budget")
    require_installed_pins(policy)


def require_retained_pins(policy, record):
    from .research_cellpose import cellpose_result_pins

    if (policy.delegation or {}).get("result_scope") != "granted-sources":
        raise PermissionError("Cellpose results require delegated study source access")
    package, runtime = cellpose_result_pins(record)
    policy.require_model(package)
    policy.require_runtime(runtime)
    provenance = record["provenance"]
    source_id = record["source_id"]
    selection = provenance.get("selection")
    channels = provenance.get("measurement_channels")
    require_model_scope(policy, source_id, selection, channels)
    accepted = provenance.get("accepted_request")
    if (
        not isinstance(accepted, dict)
        or accepted.get("source_id") != source_id
        or accepted.get("profile_id") != CELLPOSE_PROFILE_ID
        or accepted.get("selection") != selection
        or accepted.get("measurement_channels") != channels
        or accepted.get("input_mapping") != {"mode": "source-channel", "channel": selection["c"]}
    ):
        raise PermissionError("Retained Cellpose input differs from the selected scalar plane")
    # ROI measurements have an independent general source grant. The model's
    # scoped raw-channel list applies only to the segmentation and its correction.
    roi_keys = {
        f"source_channel_{channel}" for channel in policy.sources[source_id].measurement_channels
    }
    for annotation in provenance.get("annotations", []):
        if (
            not isinstance(annotation, dict)
            or annotation.get("basis") != "raw-source-channel-values"
            or not isinstance(annotation.get("measurements"), dict)
            or not annotation["measurements"].keys() <= roi_keys
        ):
            raise PermissionError(
                "Cellpose result ROI measurement channels exceed the source grant"
            )


def verify_task_preview(workbench, job_id, retained):
    from .agent_vision import validate_png
    from .research_cellpose import verify_cellpose_review_installation

    document = retained["output"]["preview"]
    source = document["source"]
    if (
        document.get("id") != job_id
        or document.get("preview_job_id") != job_id
        or source.get("id") != retained.get("source_id")
        or source.get("sha256") != retained.get("source_sha256")
    ):
        raise ValueError("Retained Cellpose preview differs from the selected job or source")
    verify_cellpose_review_installation(workbench, document)
    png_bytes = validate_png(retained["output"]["overlay_png"])
    if hashlib.sha256(png_bytes).hexdigest() != source["display"]["png_sha256"]:
        raise ValueError("Retained Cellpose overlay differs from the inspected preview receipt")
