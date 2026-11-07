"""Source-bound reversible 3D presentation; never an analysis or pixel artifact."""

from __future__ import annotations

import copy
import hashlib
from collections.abc import Callable
from typing import Any

import numpy as np

from .quantitative import finite_number, integer
from .research_project import SHA_PATTERN, ResearchProject, canonical_json, checked_id

SCHEMA = "loci.volume-view/v1"
MAX_STATE_BYTES = 64 * 1024
STATE_KEYS = {
    "t",
    "channels",
    "result",
    "selected_object",
    "representation",
    "camera",
    "crosshair_source_xyz",
    "clipping",
    "refinement",
    "layout",
    "labels",
}
PATCH_GROUPS = frozenset(STATE_KEYS)


def exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{label} requires exactly {', '.join(sorted(keys))}")
    return value


def digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError(f"{label} requires a SHA-256 identity")
    return value


def source_dimensions(source: dict[str, Any]) -> dict[str, int]:
    metadata = source["metadata"]
    shape = metadata.get("shape", [])
    dimensions = metadata.get("dimensions") or {
        "x": shape[-1],
        "y": shape[-2],
        "z": shape[0] if len(shape) == 3 else 1,
        "t": 1,
        "c": 1,
    }
    return {axis: integer(dimensions[axis], axis, 1, 2**31 - 1) for axis in "xyztc"}


def volume_geometry_binding(source: dict[str, Any]) -> str:
    """Hash registered geometry, independent of display sampling and source availability."""
    metadata = source["metadata"]
    record = {
        "source_sha256": source["sha256"],
        "dimensions": source_dimensions(source),
        "geometry": metadata.get("geometry"),
        "physical_calibration": metadata.get("physical_calibration"),
        "selected_series": metadata.get("selected_series", 0),
        "levels": metadata.get("levels"),
    }
    return hashlib.sha256(canonical_json(record).encode()).hexdigest()


def _vector(value: Any, length: int, label: str) -> np.ndarray:
    if not isinstance(value, list) or len(value) != length:
        raise ValueError(f"{label} requires {length} finite coordinates")
    return np.array([finite_number(v, label, -1e30, 1e30) for v in value])


def validate_result_binding(project, source, binding, t, selected=None):
    if binding is None:
        if selected is not None:
            raise ValueError("Selected object requires an exact result")
        return None
    exact(binding, {"result_id", "revision_hash", "label_sha256"}, "volume result")
    result = project.result(checked_id(binding["result_id"]), verify_scientific_arrays=False)
    if (
        result["revision_hash"] != digest(binding["revision_hash"], "result revision")
        or result["source_id"] != source["id"]
        or result["source_sha256"] != source["sha256"]
        or result["provenance"]["selection"].get("t", 0) != t
    ):
        raise ValueError("Volume result lost its exact source, time or revision binding")
    artifact = result.get("arrays", {}).get("labels")
    if artifact is None or result.get("schema") != "loci.research-result/v1":
        raise ValueError("Volume labels require a retained dense label result")
    if artifact.get("bytes", 2**53) > 32 * 1024**2 + 4096:
        raise ValueError("Volume labels exceed the bounded GUI grid size")
    _, _, _, labels = project._open_array_artifact(artifact)
    if labels.ndim != 3 or labels.dtype != np.dtype("uint32"):
        raise ValueError("Volume labels require a three-dimensional uint32 grid")
    # Match research_annotations.label_array_sha256 without an unbounded array copy.
    stream = hashlib.sha256()
    stream.update(b"loci-label-array-v1\0")
    stream.update(canonical_json({"dtype": "<u4", "shape": list(labels.shape)}).encode())
    stream.update(b"\0")
    found = selected is None
    if selected is not None:
        exact(
            selected, {"result_id", "revision_hash", "label_sha256", "label_id"}, "selected object"
        )
        if any(selected[k] != binding[k] for k in binding):
            raise ValueError("Selected object lost its exact result binding")
        integer(selected["label_id"], "selected label", 1, 2**32 - 1)
    flat = labels.reshape(-1)
    for offset in range(0, flat.size, 262144):
        chunk = flat[offset : offset + 262144]
        stream.update(chunk.astype("<u4", copy=False).tobytes())
        if selected is not None and np.any(chunk == selected["label_id"]):
            found = True
    if stream.hexdigest() != digest(binding["label_sha256"], "label array") or not found:
        raise ValueError("Volume label hash or selected object no longer matches")
    return result


def validate_volume_state(project: ResearchProject, source, state):
    exact(state, STATE_KEYS, "volume state")
    if len(canonical_json(state).encode()) > MAX_STATE_BYTES:
        raise ValueError("Volume state exceeds its bounded document size")
    dimensions = source_dimensions(source)
    if dimensions["z"] < 2 or source["metadata"].get("sample_semantics") in {"RGB", "RGBA"}:
        raise ValueError("Volume presentation requires a scalar source with depth")
    integer(state["t"], "volume time", 0, dimensions["t"] - 1)
    channels = state["channels"]
    if not isinstance(channels, list) or not 1 <= len(channels) <= 4:
        raise ValueError("Volume presentation requires 1-4 explicit channels")
    for channel in channels:
        integer(channel, "volume channel", 0, dimensions["c"] - 1)
    if len(set(channels)) != len(channels):
        raise ValueError("Volume channels must be unique")
    representation = exact(
        state["representation"], {"mode", "extent", "render_mode", "quality"}, "representation"
    )
    if (
        representation["mode"] not in {"volume", "mpr"}
        or representation["extent"] not in {"context", "focus"}
        or representation["render_mode"]
        not in {"blend", "normal_shading", "mip", "average", "minip"}
    ):
        raise ValueError("Unsupported volume representation")
    integer(representation["quality"], "volume quality", 1, 100)
    crosshair = state["crosshair_source_xyz"]
    if not isinstance(crosshair, list) or len(crosshair) != 3:
        raise ValueError("Crosshair requires level-zero source XYZ indices")
    for axis, value in zip("xyz", crosshair, strict=True):
        integer(value, "crosshair " + axis, 0, dimensions[axis] - 1)
    camera = state["camera"]
    if camera is not None:
        exact(
            camera,
            {
                "projection",
                "position_xyz",
                "focal_point_xyz",
                "view_up_xyz",
                "clipping_range",
                "view_angle_degrees",
                "parallel_scale",
                "frame",
                "unit",
            },
            "camera",
        )
        if camera["projection"] not in {"parallel", "perspective"}:
            raise ValueError("Unsupported camera projection")
        position = _vector(camera["position_xyz"], 3, "camera position")
        focal = _vector(camera["focal_point_xyz"], 3, "camera focal point")
        up = _vector(camera["view_up_xyz"], 3, "camera up")
        if (
            np.linalg.norm(position - focal) <= 1e-12
            or np.linalg.norm(np.cross(position - focal, up)) <= 1e-12
        ):
            raise ValueError("Camera direction and up must be nondegenerate")
        near, far = _vector(camera["clipping_range"], 2, "clipping range")
        if near <= 0 or far <= near:
            raise ValueError("Camera clipping range must be positive and ordered")
        finite_number(camera["view_angle_degrees"], "view angle", 0.01, 179)
        if camera["parallel_scale"] is not None:
            finite_number(camera["parallel_scale"], "parallel scale", 1e-12, 1e30)
        if camera["projection"] == "parallel" and camera["parallel_scale"] is None:
            raise ValueError("Parallel camera requires its scale")
        metadata = source["metadata"]
        geometry = metadata.get("geometry") or {}
        if source.get("source_kind") in {"native", "ome_zarr"}:
            # Use the same pure geometry oracle as the native renderer. Stored
            # calibration may spell micrometres as µm while camera coordinates
            # use canonical um. Reading a retained scene must need no source I/O.
            from .native_image import (
                NativeDimensions,
                NativeLevel,
                PhysicalCalibration,
                native_geometry,
            )

            saved = metadata["levels"][0]
            calibration = saved["calibration"]
            level = NativeLevel(
                index=saved["index"],
                dimensions=NativeDimensions(**saved["dimensions"]),
                calibration=PhysicalCalibration(**calibration) if calibration is not None else None,
                origin_xyz=saved.get("origin_xyz"),
            )
            geometry = native_geometry((level,), {}, True).to_dict()
        unit = geometry.get("unit", "pixel")
        if camera["frame"] != geometry.get("frame", "image") or camera["unit"] != unit:
            raise ValueError("Camera frame and unit disagree with registered source geometry")
    clipping = exact(state["clipping"], {"enabled", "axis", "position_percent"}, "clipping")
    if type(clipping["enabled"]) is not bool or clipping["axis"] not in {"x", "y", "z"}:
        raise ValueError("Unsupported clipping plane")
    finite_number(clipping["position_percent"], "clip position", 0, 100)
    refinement = exact(
        state["refinement"], {"target_long_axis", "focus_region_xyzxyz"}, "refinement"
    )
    integer(refinement["target_long_axis"], "volume target", 16, 256)
    focus = refinement["focus_region_xyzxyz"]
    if focus is not None:
        if not isinstance(focus, list) or len(focus) != 6:
            raise ValueError("Focus requires inclusive x0,x1,y0,y1,z0,z1 source indices")
        for axis, low, high in zip("xyz", focus[::2], focus[1::2], strict=True):
            integer(low, "focus lower bound", 0, dimensions[axis] - 1)
            integer(
                high, "focus upper bound", low + (1 if axis == "z" else 0), dimensions[axis] - 1
            )
    if representation["extent"] == "focus" and focus is None:
        raise ValueError("Focus presentation requires an explicit focus region")
    layout = exact(
        state["layout"], {"mode", "expanded_pane", "pane_order", "col_split", "row_split"}, "layout"
    )
    panes = {"axial", "coronal", "sagittal", "volume"}
    if layout["mode"] not in {"four", "single"} or layout["expanded_pane"] not in panes | {None}:
        raise ValueError("Unsupported volume pane layout")
    if (
        not isinstance(layout["pane_order"], list)
        or len(layout["pane_order"]) != 4
        or set(layout["pane_order"]) != panes
    ):
        raise ValueError("Pane order requires each pane exactly once")
    for key in ("col_split", "row_split"):
        finite_number(layout[key], key, 10, 90)
    labels = exact(state["labels"], {"visible", "opacity", "selected_only"}, "labels")
    if type(labels["visible"]) is not bool or type(labels["selected_only"]) is not bool:
        raise ValueError("Label presentation flags must be boolean")
    finite_number(labels["opacity"], "label opacity", 0, 1)
    validate_result_binding(project, source, state["result"], state["t"], state["selected_object"])
    if labels["visible"] and state["result"] is None:
        raise ValueError("Visible labels require an exact retained result")
    return state


def read_volume_view(project, source_id):
    source = project.source(checked_id(source_id))
    documents = project.documents("volume_view", document_id=source["id"])
    document = documents[0] if documents else None
    binding = volume_geometry_binding(source)
    if document:
        data = exact(
            document["data"],
            {"schema", "source_id", "source_sha256", "geometry_sha256", "state"},
            "volume view",
        )
        if (
            data["schema"] != SCHEMA
            or data["source_id"] != source["id"]
            or data["source_sha256"] != source["sha256"]
            or data["geometry_sha256"] != binding
        ):
            raise ValueError("Saved volume view lost its scientific binding")
        validate_volume_state(project, source, data["state"])
    display = project.documents("display", document_id=source["id"])
    return {
        "schema": SCHEMA,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "geometry_sha256": binding,
        "revision": document["revision"] if document else 0,
        "display_revision": display[0]["revision"] if display else 0,
        "state": copy.deepcopy(document["data"]["state"]) if document else None,
    }


def save_volume_view(project, request, *, publication_guard: Callable[[], None] | None = None):
    exact(
        request,
        {"source_id", "source_sha256", "expected_revision", "expected_display_revision", "state"},
        "save volume view",
    )
    source = project.source(checked_id(request["source_id"]))
    validate_volume_state(project, source, request["state"])
    validate_live_result_grid(project, source, request["state"])
    current = read_volume_view(project, source["id"])
    revision = integer(request["expected_revision"], "volume revision", 0, 2**53 - 1)
    display_revision = integer(
        request["expected_display_revision"], "display revision", 0, 2**53 - 1
    )
    if request["source_sha256"] != source["sha256"]:
        raise ValueError("Volume source binding changed")

    def guard():
        display = project.documents("display", document_id=source["id"])
        if (display[0]["revision"] if display else 0) != display_revision:
            raise ValueError("Source display changed; reload before editing volume")
        if publication_guard:
            publication_guard()

    project.put_document(
        "volume_view",
        source["id"],
        {
            "schema": SCHEMA,
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "geometry_sha256": current["geometry_sha256"],
            "state": copy.deepcopy(request["state"]),
        },
        expected_revision=revision,
        publication_guard=guard,
    )
    return read_volume_view(project, source["id"])


def validate_live_result_grid(project, source, state):
    """Writes share the real viewer geometry oracle; retained reads need no source bytes."""
    if state["result"] is None:
        return
    from .volume_labels import validate_volume_label_grid
    from .workbench import Workbench

    result = project.result(state["result"]["result_id"], verify_scientific_arrays=False)
    workbench = Workbench(project)
    try:
        validate_volume_label_grid(workbench, source, result)
    finally:
        workbench.close()


def execute_volume_view(workbench, operation, request):
    if operation == "volume_view":
        exact(request, {"source_id"}, "volume view")
        return read_volume_view(workbench.project, request["source_id"])
    return save_volume_view(workbench.project, request)
