"""Exact-result import of Loci-authored polygon annotations.

The renderer may pass bounded annotation bytes, never filesystem paths.  GeoJSON
and ImageJ ROI decoding remain in :mod:`research_annotations`; this module binds
decoded polygons to an immutable result and publishes one unreviewed child.
"""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from .quantitative import exact_keys, integer
from .research_annotations import (
    PolygonROI,
    measure_polygon_roi,
    roi_from_geojson,
    roi_from_imagej,
    roi_to_geojson,
)
from .research_editing import _bound_result, _raw_channels
from .research_project import MAX_JSON_BYTES, canonical_json, parse_json

if TYPE_CHECKING:
    from .workbench import Workbench

MAX_ANNOTATIONS = 1000
MAX_IMAGEJ_BYTES = 16 * 1024 * 1024


def _decode_geojson(payload: Any) -> tuple[list[PolygonROI], bytes]:
    if not isinstance(payload, str):
        raise ValueError("GeoJSON annotation payload must be UTF-8 text")
    encoded = payload.encode("utf-8")
    if not encoded or len(encoded) > MAX_JSON_BYTES:
        raise ValueError("GeoJSON annotation payload exceeds its byte bound")
    value = parse_json(payload)
    if isinstance(value, dict) and value.get("type") == "FeatureCollection":
        exact_keys(value, {"type", "features"}, "annotation FeatureCollection")
        features = value.get("features")
        if not isinstance(features, list) or not 1 <= len(features) <= MAX_ANNOTATIONS:
            raise ValueError("Choose a FeatureCollection containing 1-1000 polygon ROIs")
    else:
        features = [value]
    return [roi_from_geojson(feature) for feature in features], encoded


def _decode_imagej(payload: Any, parent: dict[str, Any]) -> tuple[list[PolygonROI], bytes]:
    if not isinstance(payload, str) or not payload:
        raise ValueError("ImageJ ROI annotation payload must be base64 text")
    if len(payload) > (MAX_IMAGEJ_BYTES * 4 // 3) + 8:
        raise ValueError("ImageJ ROI annotation payload exceeds its byte bound")
    try:
        encoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("ImageJ ROI annotation payload is not canonical base64") from exc
    if not encoded or len(encoded) > MAX_IMAGEJ_BYTES:
        raise ValueError("ImageJ ROI annotation payload exceeds its byte bound")
    roi = roi_from_imagej(
        encoded,
        expected_source_sha256=parent["source_sha256"],
        expected_result_sha256=parent["revision_hash"],
    )
    return [roi], encoded


def import_annotations(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Measure imported annotations and publish an immutable child revision."""

    exact_keys(
        request,
        {
            "result_id",
            "revision_hash",
            "format",
            "payload",
            "measurement_channels",
            "working_bytes",
        },
        "annotation import",
    )
    parent = _bound_result(workbench, request)
    working_bytes = integer(
        request.get("working_bytes", 512 * 1024**2),
        "working-memory budget",
        1024**2,
        8 * 1024**3,
    )
    if sum(item["bytes"] for item in parent["arrays"].values()) > working_bytes // 2:
        raise ValueError("Result arrays exceed the bounded annotation working-memory budget")
    format_name = request.get("format")
    if format_name == "geojson":
        rois, encoded = _decode_geojson(request.get("payload"))
    elif format_name == "imagej":
        rois, encoded = _decode_imagej(request.get("payload"), parent)
    else:
        raise ValueError("Annotation format must be geojson or imagej")

    arrays = {
        key: workbench.project.load_array(descriptor)
        for key, descriptor in parent["arrays"].items()
    }
    provenance = copy.deepcopy(parent["provenance"])
    provenance.pop("job_id", None)
    expected_geometry = canonical_json(provenance["geometry"])
    existing = provenance.setdefault("annotations", [])
    if not isinstance(existing, list) or len(existing) + len(rois) > MAX_ANNOTATIONS:
        raise ValueError("Imported annotations exceed the 1000 annotation result limit")
    ids = {item.get("id") for item in existing if isinstance(item, dict)}
    imported_ids: set[str] = set()
    channels = request.get(
        "measurement_channels",
        [0] if provenance.get("derived_measurement_arrays") else [provenance["selection"]["c"]],
    )
    values = _raw_channels(workbench, parent, channels, working_bytes)
    if not values:
        raise ValueError("Annotation intensity analysis requires explicit source channels")
    payload_sha256 = hashlib.sha256(encoded).hexdigest()
    for roi in rois:
        if (
            roi.source_sha256 != parent["source_sha256"]
            or roi.result_sha256 != parent["revision_hash"]
            or list(roi.image_shape) != list(arrays["image"].shape)
            or canonical_json(roi.geometry.to_dict()) != expected_geometry
        ):
            raise ValueError("Imported annotation is not bound to the selected exact result grid")
        if roi.annotation_id in ids or roi.annotation_id in imported_ids:
            raise ValueError("Imported annotation identifiers must be unique in this result")
        imported_ids.add(roi.annotation_id)
        measured = {
            name: measure_polygon_roi(
                image,
                roi,
                source_sha256=parent["source_sha256"],
                result_sha256=parent["revision_hash"],
                working_bytes=working_bytes,
            )
            for name, image in values.items()
        }
        if provenance.get("derived_measurement_arrays") or provenance.get("stain_separation"):
            for measurement in measured.values():
                measurement["derived_intensity"] = measurement.pop("raw_intensity")
        existing.append(
            {
                "id": roi.annotation_id,
                "geojson": roi_to_geojson(roi),
                "measurements": measured,
                "basis": "REGISTERED-DERIVED scalar values"
                if provenance.get("derived_measurement_arrays")
                else "declared-stain-coordinate-values"
                if provenance.get("stain_separation")
                else "raw-source-channel-values",
                "parent_result_id": parent["id"],
                "interchange": {
                    "schema": "loci.annotation-import/v1",
                    "format": format_name,
                    "payload_sha256": payload_sha256,
                },
            }
        )

    def guard() -> None:
        if publication_guard is not None:
            publication_guard()
        _bound_result(
            workbench,
            {"result_id": parent["id"], "revision_hash": parent["revision_hash"]},
        )
        for descriptor in parent["arrays"].values():
            workbench.project.load_array(descriptor)

    result = workbench.project.save_result(
        source_id=parent["source_id"],
        kind="annotated-result",
        arrays=arrays,
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=guard,
    )
    from .workbench import result_summary

    return {
        "result": result_summary(result),
        "annotations": existing,
        "imported_annotation_ids": sorted(imported_ids),
        "payload_sha256": payload_sha256,
    }
