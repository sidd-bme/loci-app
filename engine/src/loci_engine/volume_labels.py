"""Exact bounded categorical volumes for linked native 3D/MPR inspection.

These are retained label values, not interpolated intensity or a new result.
The renderer may produce a bounded surface, but identity/picking use this grid.
"""

from __future__ import annotations

import base64
import hashlib
import math
from typing import TYPE_CHECKING, Any

import numpy as np

from .quantitative import Geometry, exact_keys, integer
from .research_annotations import label_array_sha256
from .research_project import canonical_json, checked_id
from .viewer_volume import _decompose_geometry

if TYPE_CHECKING:
    from .workbench import Workbench

MAX_LABEL_BYTES = 32 * 1024**2


def _retained_result(workbench: Workbench, result_id: str) -> dict[str, Any]:
    try:
        return workbench.project.result(result_id, verify_scientific_arrays=False)
    except (KeyError, TypeError, AttributeError) as exc:
        # Some older result-extension validators assume complete containers.
        # Malformed retained metadata is an unsupported payload, never a grid
        # to repair or an excuse to bypass its revision/extension validation.
        raise ValueError("Retained result metadata is incompatible with volume labels") from exc


def validate_volume_label_grid(
    workbench: Workbench, source: dict[str, Any], result: dict[str, Any]
) -> tuple[dict[str, Any], Geometry]:
    """Verify a bounded retained grid against its available scalar raw source.

    The caller must validate the retained result revision and, when applicable,
    the requested time/label identity. This validates metadata and source bytes,
    without decoding label pixels. It is suitable for scene writes; do not use
    it to read retained scene state when the original source is unavailable.
    """
    try:
        return _validate_volume_label_grid(workbench, source, result)
    except OSError as exc:
        raise ValueError("The linked raw source is unavailable for grid verification") from exc


def _validate_volume_label_grid(
    workbench: Workbench, source: dict[str, Any], result: dict[str, Any]
) -> tuple[dict[str, Any], Geometry]:
    from .workbench import geometry_from_dict

    if source.get("source_kind") not in {"native", "ome_zarr", "medical"}:
        raise ValueError("Volume labels require a scalar native, OME-Zarr or medical source")
    provenance = result.get("provenance", {})
    if not isinstance(provenance, dict):
        raise ValueError("Volume labels require explicit result provenance")
    selection = provenance.get("selection")
    if (
        result["source_id"] != source["id"]
        or result["source_sha256"] != source["sha256"]
        or not isinstance(selection, dict)
    ):
        raise ValueError("Volume labels require the exact source, time and result revision")
    arrays = result.get("arrays")
    descriptor = arrays.get("labels") if isinstance(arrays, dict) else None
    if not isinstance(descriptor, dict) or result.get("schema") != "loci.research-result/v1":
        raise ValueError("Select a retained dense 3D label result")
    shape = descriptor.get("shape")
    if (
        not isinstance(shape, list)
        or len(shape) != 3
        or any(type(length) is not int or length < 1 for length in shape)
        or shape[0] < 2
        or math.prod(shape) * 4 > MAX_LABEL_BYTES
    ):
        raise ValueError("The exact label grid must have depth and fit the 32 MiB viewer bound")
    if descriptor.get("dtype") != "uint32":
        raise ValueError("Label inspection requires an exact uint32 ZYX array")
    if not {"x", "y", "width", "height", "z", "z_stop", "t", "c", "level"} <= selection.keys():
        raise ValueError("Linked volume labels require a complete explicit native Z range and grid")
    verified = workbench.project.source(source["id"], verify=True)
    if any(
        canonical_json(verified.get(key)) != canonical_json(source.get(key))
        for key in ("sha256", "source_kind", "metadata")
    ):
        raise ValueError("Volume label source bindings changed before grid validation")
    resolved = workbench.selection(source["id"], selection)
    if resolved["level"] != 0:
        raise ValueError("Linked volume labels require a native level-zero result grid")
    expected_shape = [resolved["z_stop"] - resolved["z"], resolved["height"], resolved["width"]]
    if shape != expected_shape:
        raise ValueError("The result label grid disagrees with its source selection")
    if not isinstance(provenance.get("geometry"), dict):
        raise ValueError("Linked volume labels require explicit ZYX geometry")
    geometry = geometry_from_dict(provenance["geometry"])
    if geometry.axes != "ZYX":
        raise ValueError("Linked volume labels require explicit ZYX geometry")
    session = workbench._session(source["id"])
    if session.metadata.dimensions.s != 1:
        raise ValueError("RGB samples cannot supply a scalar linked volume source")
    expected = workbench._native_geometry(session, resolved, True)
    if (
        geometry.unit != expected.unit
        or geometry.frame != expected.frame
        or not np.allclose(geometry.affine, expected.affine, rtol=0, atol=1e-9)
    ):
        raise ValueError("The result label calibration does not match its raw source grid")
    dimensions = tuple(reversed(shape))
    _decompose_geometry(geometry, dimensions, dimensions)
    return resolved, geometry


def volume_labels(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    """Return verified path-redacted label bytes or a path-redacted I/O error."""
    try:
        return _volume_labels(workbench, request)
    except OSError as exc:
        raise ValueError(
            "The linked source or label artifact is unavailable for verification"
        ) from exc


def _volume_labels(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    keys = {"source_id", "result_id", "revision_hash", "t"}
    exact_keys(request, keys, "volume labels")
    if set(request) != keys:
        raise ValueError("Volume labels require explicit source, result revision and time")
    source = workbench.project.source(checked_id(request["source_id"]))
    if source.get("source_kind") not in {"native", "ome_zarr", "medical"}:
        raise ValueError("Volume labels require a scalar native, OME-Zarr or medical source")
    # Admit the exact label grid before reading any potentially larger scientific
    # arrays. Displaying retained categorical values does not remeasure a result.
    result = _retained_result(workbench, checked_id(request["result_id"]))
    t = integer(request["t"], "label time", 0, 2**31 - 1)
    if result["revision_hash"] != request["revision_hash"]:
        raise ValueError("Volume labels require the exact result revision")
    resolved, geometry = validate_volume_label_grid(workbench, source, result)
    if resolved["t"] != t:
        raise ValueError("Volume labels require the exact source time")
    descriptor = result["arrays"]["labels"]
    shape = descriptor["shape"]
    dimensions = tuple(reversed(shape))
    # Refuse unrepresentable geometry before allocating/encoding label values.
    origin, spacing, direction, affine = _decompose_geometry(geometry, dimensions, dimensions)
    # load_array verifies both the artifact's NPY descriptor/hash and a stable
    # post-copy fingerprint; never return bytes from a mutable artifact mmap.
    labels = workbench.project.load_array(descriptor)
    if labels.dtype != np.dtype("uint32") or list(labels.shape) != shape:
        raise ValueError("Label inspection requires an exact uint32 ZYX array")
    data = labels.astype("<u4", copy=False).tobytes(order="C")
    numerical_hash = label_array_sha256(labels)
    current_source = workbench.project.source(source["id"], verify=True)
    if any(
        canonical_json(current_source.get(key)) != canonical_json(source.get(key))
        for key in ("sha256", "source_kind", "metadata")
    ):
        raise ValueError("Volume label source bindings changed during payload preparation")
    if _retained_result(workbench, result["id"]) != result:
        raise ValueError("Volume label result revision changed during payload preparation")
    return {
        "schema": "loci.volume-labels/v1",
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "t": t,
        "result": {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "label_sha256": numerical_hash,
        },
        "dimensions_xyz": list(dimensions),
        "source_offset_xyz": [resolved[k] for k in "xyz"],
        "origin_xyz": origin,
        "spacing_xyz": spacing,
        "direction_3x3": direction,
        "affine_4x4": affine,
        "unit": geometry.unit,
        "frame": geometry.frame,
        "scalar_type": "uint32",
        "interpolation": "nearest",
        "sampling": "exact-native-grid",
        "data_base64": base64.b64encode(data).decode("ascii"),
        "data_sha256": hashlib.sha256(data).hexdigest(),
        "byte_length": len(data),
    }
