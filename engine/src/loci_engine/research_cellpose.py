"""Project-scoped local Cellpose execution with exact source and runtime provenance."""

from __future__ import annotations

import platform
from dataclasses import fields
from typing import TYPE_CHECKING, Any

import numpy as np

from .models import CellposeSettings
from .profiles import resolve_profile
from .quantitative import DEFAULT_WORKING_BYTES, integer, measure_objects
from .workbench import result_summary, runtime_record

if TYPE_CHECKING:
    from .workbench import Workbench


_REQUEST_KEYS = {
    "source_id",
    "selection",
    "profile_id",
    "settings",
    "measurement_channels",
    "working_bytes",
}
_SELECTION_KEYS = {"x", "y", "width", "height", "t", "c", "z", "level"}


def _settings(value: object) -> CellposeSettings:
    expected = {field.name for field in fields(CellposeSettings)}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("Cellpose settings must contain every declared profile setting exactly")
    settings = CellposeSettings(**value)
    settings.validate()
    return settings


def _measurement_channels(value: object, count: int) -> list[int]:
    if (
        not isinstance(value, list)
        or len(value) > 32
        or any(isinstance(channel, bool) or not isinstance(channel, int) for channel in value)
        or any(channel < 0 or channel >= count for channel in value)
        or len(set(value)) != len(value)
    ):
        raise ValueError("Choose up to 32 unique available raw measurement channels")
    return list(value)


def _validated_labels(inference: Any, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    labels = np.asarray(inference.output.labels)
    normalized = np.asarray(inference.output.normalized, dtype=np.float64)
    if (
        labels.ndim != 2
        or labels.shape != shape
        or normalized.shape != shape
        or not np.issubdtype(labels.dtype, np.integer)
        or not np.isfinite(normalized).all()
        or np.any(normalized < 0)
        or np.any(normalized > 1)
        or labels.size == 0
        or int(labels.min()) < 0
        or int(labels.max()) > np.iinfo(np.uint32).max
    ):
        raise ValueError("Cellpose output does not match the selected 2D source grid")
    labels = labels.astype(np.uint32, copy=True)
    positive_ids = np.unique(labels)
    positive_ids = positive_ids[positive_ids != 0]
    if (
        not np.array_equal(positive_ids, np.arange(1, len(positive_ids) + 1))
        or int(inference.output.count) != len(positive_ids)
    ):
        raise ValueError("Cellpose output labels or object count are inconsistent")
    return labels, normalized


def execute_cellpose(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Any = None,
) -> dict[str, Any]:
    """Run one explicitly selected 2D plane with an already provisioned profile."""

    if not isinstance(request, dict) or set(request) != _REQUEST_KEYS:
        raise ValueError("Cellpose run requires one exact project-scoped request")
    source_id = request["source_id"]
    selection_value = request["selection"]
    if not isinstance(selection_value, dict) or set(selection_value) != _SELECTION_KEYS:
        raise ValueError("Cellpose requires one fully resolved 2D source selection")
    working_bytes = integer(
        request["working_bytes"], "working_bytes", 1024**2, DEFAULT_WORKING_BYTES
    )
    settings = _settings(request["settings"])
    profile = resolve_profile(request["profile_id"], require_ready=True)
    if profile.backend_kind != "cellpose" or not isinstance(
        profile.recommended_settings, CellposeSettings
    ):
        raise ValueError("The selected profile is not a supported Cellpose profile")

    declarations = workbench.channel_metadata(source_id)
    channels = declarations["channels"]
    measurement_channels = _measurement_channels(request["measurement_channels"], len(channels))
    image, geometry, selection = workbench.load_scalar(
        source_id,
        selection_value,
        working_bytes=working_bytes,
        allow_rgb=True,
    )
    is_rgb = image.ndim == 3 and image.shape[-1] in {3, 4}
    if image.ndim != 2 and not is_rgb:
        raise ValueError("Cellpose requires one 2D scalar or interleaved RGB plane")
    if is_rgb and (selection["c"] != 0 or measurement_channels):
        raise ValueError(
            "RGB samples are one interleaved image and cannot be treated as biological channels"
        )

    selected_pixels = int(image.shape[0] * image.shape[1])
    # Retained inputs include the inference plane, normalized and label grids,
    # measurement workspaces, and every requested raw channel. This check is
    # deliberately performed before model execution so individually bounded
    # channel reads cannot accumulate beyond the caller's aggregate budget.
    aggregate_required_bytes = int(image.nbytes) + selected_pixels * (
        160 + 8 * len(measurement_channels)
    )
    if aggregate_required_bytes > working_bytes:
        raise ValueError(
            "Cellpose source and raw measurement channels exceed the aggregate "
            "working-memory budget; choose a smaller crop or fewer channels"
        )

    from .cellpose_backend import segment_cellpose

    inference = segment_cellpose(image, settings, profile.id)
    inference_runtime = inference.runtime
    expected_model = profile.model.to_dict()
    if (
        inference_runtime.get("profile_id") != profile.id
        or inference_runtime.get("model")
        != {
            "artifact_id": expected_model["artifact_id"],
            "sha256": expected_model["sha256"],
        }
        or inference_runtime.get("requested_device") != settings.device
    ):
        raise ValueError("Cellpose runtime identity disagrees with the accepted request")
    labels, normalized = _validated_labels(inference, tuple(image.shape[:2]))

    raw_channels: dict[str, np.ndarray] = {}
    for channel in measurement_channels:
        raw, raw_geometry, raw_selection = workbench.load_scalar(
            source_id,
            {**selection, "c": channel},
            strict=False,
            working_bytes=working_bytes,
        )
        if raw.ndim != 2 or raw.shape != labels.shape or raw_geometry != geometry:
            raise ValueError("A raw measurement channel disagrees with the Cellpose label grid")
        if raw_selection != {**selection, "c": channel}:
            raise ValueError("A Cellpose measurement selection was not resolved exactly")
        raw_channels[f"source_channel_{channel}"] = raw
    measurements = measure_objects(
        labels,
        geometry,
        raw_channels,
        working_bytes=working_bytes,
    )

    accepted_request = {
        "source_id": source_id,
        "selection": selection,
        "input_mapping": (
            {"mode": "interleaved-rgb-samples"}
            if is_rgb
            else {"mode": "source-channel", "channel": selection["c"]}
        ),
        "profile_id": profile.id,
        "settings": settings.to_dict(),
        "measurement_channels": measurement_channels,
        "working_bytes": working_bytes,
    }
    engine_runtime = runtime_record()
    runtime: dict[str, Any] = {
        "engine": engine_runtime,
        "cellpose": inference_runtime,
        "python_version": platform.python_version(),
    }
    try:
        import torch

        runtime.update(
            torch_version=str(torch.__version__),
            cuda_runtime=(str(torch.version.cuda) if torch.version.cuda is not None else None),
            cudnn_version=torch.backends.cudnn.version(),
        )
    except (AttributeError, ImportError, RuntimeError):
        # Successful inference already records the verified Cellpose package,
        # checkpoint and resolved device. Optional accelerator diagnostics do
        # not change or invalidate those exact execution facts.
        runtime.update(torch_version=None, cuda_runtime=None, cudnn_version=None)
    segmentation = {
        "method": "cellpose",
        "dimensions": 2,
        "count": int(inference.output.count),
        "scientific_validation": "unvalidated-research-method",
    }
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "accepted_request": accepted_request,
        "profile": profile.provenance_dict(),
        "settings": settings.to_dict(),
        "segmentation": segmentation,
        "measurements": measurements,
        "measurement_channels": measurement_channels,
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "channel_metadata": declarations,
        "runtime": runtime,
        "resource_guard": {
            "working_memory_limit_bytes": working_bytes,
            "aggregate_required_bytes": aggregate_required_bytes,
            "aggregate_estimate_policy": (
                "input-bytes-plus-160B-per-source-pixel-plus-8B-per-raw-channel-pixel/v1"
            ),
            "selected_source_pixels": selected_pixels,
            "cellpose_memory_preflight": inference_runtime.get("memory_preflight"),
        },
        "model": {
            "profile": profile.provenance_dict(),
            "rights": profile.rights.to_dict(),
            "validation": profile.validation.to_dict(),
        },
    }
    if job_id is not None:
        provenance["job_id"] = job_id
    result = workbench.project.save_result(
        source_id=source_id,
        kind="cellpose-segmentation",
        arrays={"image": normalized, "labels": labels},
        provenance=provenance,
        job_id=job_id,
        publication_guard=publication_guard,
    )
    return {
        "result": result_summary(result),
        "measurements": measurements[:1000],
        "accepted_request": accepted_request,
        "profile": profile.to_dict(),
    }
