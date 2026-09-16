"""The established adaptive 2D baseline on an explicit study source grid."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np

from .models import SegmentationSettings
from .profiles import DEFAULT_PROFILE_ID, resolve_profile
from .quantitative import DEFAULT_WORKING_BYTES, integer, measure_objects
from .research_cellpose import _measurement_channels
from .segment import segment_image
from .workbench import result_summary, runtime_record
from .working_result import _settings_from_record

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


def execute_adaptive(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Any = None,
) -> dict[str, Any]:
    if not isinstance(request, dict) or set(request) != _REQUEST_KEYS:
        raise ValueError("Adaptive segmentation requires one exact project-scoped request")
    if request["profile_id"] != DEFAULT_PROFILE_ID:
        raise ValueError("Choose the built-in Loci Adaptive Watershed profile")
    profile = resolve_profile(DEFAULT_PROFILE_ID, require_ready=True)
    settings = _settings_from_record(
        {"kind": "SegmentationSettings", "values": request["settings"]}, backend_kind="classical"
    )
    if not isinstance(settings, SegmentationSettings) or profile.backend_kind != "classical":
        raise ValueError("Adaptive segmentation requires the built-in classical profile")
    if not isinstance(request["selection"], dict) or set(request["selection"]) != _SELECTION_KEYS:
        raise ValueError("Adaptive segmentation requires one fully resolved 2D source plane")
    working_bytes = integer(
        request["working_bytes"], "working_bytes", 1024**2, DEFAULT_WORKING_BYTES
    )
    source_id = request["source_id"]
    declarations = workbench.channel_metadata(source_id)
    measurement_channels = _measurement_channels(
        request["measurement_channels"], len(declarations["channels"])
    )
    image, geometry, selection = workbench.load_scalar(
        source_id, request["selection"], working_bytes=working_bytes, allow_rgb=True
    )
    rgb = image.ndim == 3 and image.shape[-1] in {3, 4}
    if image.ndim != 2 and not rgb:
        raise ValueError("Adaptive segmentation requires one scalar or interleaved RGB plane")
    if rgb and (selection["c"] != 0 or measurement_channels):
        raise ValueError("RGB samples cannot be measured as biological channels")
    pixels = image.shape[0] * image.shape[1]
    required = int(image.nbytes) + pixels * (160 + 8 * len(measurement_channels))
    if required > working_bytes:
        raise ValueError(
            "Adaptive segmentation exceeds the aggregate working-memory budget; "
            "choose a smaller analysis region"
        )
    # This is the existing algorithm, including its independent precision and
    # source-pixel resource guards. No image-first-specific fitting is introduced.
    output = segment_image(image, settings)
    labels = np.asarray(output.labels)
    normalized = np.asarray(output.normalized)
    if (
        labels.shape != image.shape[:2]
        or normalized.shape != labels.shape
        or labels.dtype.kind not in "iu"
        or not np.isfinite(normalized).all()
        or int(labels.min()) < 0
        or int(labels.max()) > np.iinfo(np.uint32).max
        or np.any(normalized < 0)
        or np.any(normalized > 1)
    ):
        raise ValueError("Adaptive output does not match the selected source grid")
    labels = labels.astype(np.uint32, copy=True)
    positive_ids = np.unique(labels[labels > 0])
    if output.count != len(positive_ids) or not np.array_equal(
        positive_ids, np.arange(1, output.count + 1)
    ):
        raise ValueError("Adaptive labels and object count disagree")
    raw_channels = {}
    for channel in measurement_channels:
        raw, raw_geometry, raw_selection = workbench.load_scalar(
            source_id, {**selection, "c": channel}, strict=False, working_bytes=working_bytes
        )
        if (
            raw.ndim != 2
            or raw.shape != labels.shape
            or raw_geometry != geometry
            or raw_selection != {**selection, "c": channel}
        ):
            raise ValueError("A raw measurement channel disagrees with the adaptive label grid")
        raw_channels[f"source_channel_{channel}"] = raw
    measurements = measure_objects(labels, geometry, raw_channels, working_bytes=working_bytes)
    accepted = {
        **request,
        "selection": selection,
        "settings": settings.to_dict(),
        "input_mapping": {"mode": "rgb-derived-grayscale-luminance"}
        if rgb
        else {"mode": "source-channel", "channel": selection["c"]},
    }
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "accepted_request": accepted,
        "profile": profile.provenance_dict(),
        "settings": settings.to_dict(),
        "segmentation": {
            "method": "loci-adaptive-watershed",
            "dimensions": 2,
            "count": output.count,
            "resolved_polarity": output.resolved_polarity,
            "threshold": output.threshold,
            "confluence_percent": output.confluence_percent,
            "scientific_validation": "unvalidated-research-method",
        },
        "measurements": measurements,
        "measurement_channels": measurement_channels,
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "baseline_pixel_measurements": output.measurements,
        "baseline_pixel_measurement_basis": "legacy-adaptive-normalized-analysis-plane",
        "channel_metadata": declarations,
        "runtime": runtime_record(),
        "resource_guard": {
            "working_memory_limit_bytes": working_bytes,
            "aggregate_required_bytes": required,
            "aggregate_estimate_policy": (
                "input-bytes-plus-160B-per-pixel-plus-8B-per-raw-channel-pixel/v1"
            ),
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
        kind="adaptive-segmentation",
        arrays={"image": normalized, "labels": labels},
        provenance=provenance,
        job_id=job_id,
        publication_guard=publication_guard,
    )
    return {
        "result": result_summary(result),
        "measurements": measurements[:1000],
        "accepted_request": accepted,
        "profile": profile.to_dict(),
    }
