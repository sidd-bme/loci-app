"""Bounded display meshes on an explicit world grid; never analysis measurements."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np
import skimage
from skimage.measure import marching_cubes

from .quantitative import Geometry, exact_keys, finite_number, integer, validate_array
from .research_project import checked_id

if TYPE_CHECKING:
    from .workbench import Workbench

MAX_FACES = 20_000


def surface_mesh(
    array: np.ndarray,
    geometry: Geometry,
    *,
    isovalue: float | None,
    max_edge: int = 80,
    working_bytes: int = 512 * 1024**2,
) -> dict[str, Any]:
    values = validate_array(array, geometry=geometry, working_bytes=working_bytes)
    if values.ndim != 3 or min(values.shape) < 2:
        raise ValueError("A surface needs a true volume with at least two samples on every axis")
    max_edge = integer(max_edge, "surface display edge", 8, 96)
    strides = tuple(max(1, math.ceil(size / max_edge)) for size in values.shape)
    small = np.ascontiguousarray(
        values[tuple(slice(None, None, step) for step in strides)], dtype=np.float32
    )
    if min(small.shape) < 2 or small.size * 256 > working_bytes:
        raise ValueError("Surface display exceeds its bounded grid or memory budget")
    low, high = float(small.min()), float(small.max())
    if not low < high:
        raise ValueError("The sampled display volume is constant and has no isosurface")
    policy = (
        "selected-display-volume-mid-range" if isovalue is None else "user-defined-display-level"
    )
    level = (
        (low + high) / 2
        if isovalue is None
        else finite_number(isovalue, "display isovalue", -1e30, 1e30)
    )
    if not low < level < high:
        raise ValueError(f"Display isovalue must lie strictly between {low:g} and {high:g}")
    vertices = faces = None
    step_size = 1
    for step_size in (1, 2, 4, 8):
        try:
            vertices, faces, _, _ = marching_cubes(
                small,
                level=level,
                step_size=step_size,
                allow_degenerate=False,
                method="lewiner",
                gradient_direction="descent",
            )
        except RuntimeError as exc:
            raise ValueError(
                "No surface remains at this display resolution; choose another crop or level"
            ) from exc
        if len(faces) <= MAX_FACES:
            break
    if vertices is None or faces is None or not len(faces) or len(faces) > MAX_FACES:
        raise ValueError("Surface is too complex; reduce the crop or choose a coarser display grid")
    vertices_index = vertices.astype(np.float64) * np.asarray(strides)
    world = geometry.world(vertices_index)
    # ZYX-to-XYZ is a reflection. Reverse winding when the full transform flips it.
    if np.linalg.det(np.asarray(geometry.affine)[:3, :3]) > 0:
        faces = faces[:, ::-1]
    corners_index = (
        np.asarray(np.meshgrid(*[(0, n - 1) for n in values.shape], indexing="ij")).reshape(3, -1).T
    )
    corners_world = geometry.world(corners_index)
    return {
        "schema": "loci.surface-display/v1",
        "vertices_world_xyz": world.tolist(),
        "faces": faces.tolist(),
        "world_bounds": [corners_world.min(axis=0).tolist(), corners_world.max(axis=0).tolist()],
        "geometry": geometry.to_dict(),
        "source_shape": list(values.shape),
        "display_shape": list(small.shape),
        "strides_zyx": list(strides),
        "marching_step": step_size,
        "isovalue": level,
        "display_range": [low, high],
        "threshold_policy": policy,
        "runtime": {
            "scikit_image": skimage.__version__,
            "backend": "scikit-image-Lewiner-marching-cubes-cpu",
        },
        "purpose": (
            "display-only isosurface; nearest subsampling and float32 display values; "
            "not quantitative surface area or a new segmentation"
        ),
        "face_limit": MAX_FACES,
    }


def execute_surface(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    from .workbench import geometry_from_dict

    exact_keys(
        request,
        {
            "source_id",
            "selection",
            "result_id",
            "revision_hash",
            "mode",
            "label",
            "isovalue",
            "max_edge",
            "working_bytes",
        },
        "surface view",
    )
    working_bytes = integer(
        request.get("working_bytes", 512 * 1024**2), "surface working bytes", 1024**2, 512 * 1024**2
    )
    mode = request.get("mode", "intensity")
    if mode not in {"intensity", "labels"}:
        raise ValueError("Choose an intensity or label surface")
    if "result_id" in request:
        if "source_id" in request or "selection" in request:
            raise ValueError("Choose an exact result or an explicit source scope for the surface")
        result = workbench.project.result(checked_id(request["result_id"]))
        if result["revision_hash"] != request.get("revision_hash"):
            raise ValueError("Surface view requires the exact result revision")
        name = "labels" if mode == "labels" else "image"
        if name not in result["arrays"]:
            raise ValueError("The selected result has no label array")
        descriptor = result["arrays"][name]
        if math.prod(descriptor["shape"]) * 64 > working_bytes:
            raise ValueError("Surface input exceeds its declared working-memory budget")
        values = workbench.project.load_array(descriptor)
        geometry = geometry_from_dict(result["provenance"]["geometry"])
        source_id = result["source_id"]
        binding = {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "array_sha256": descriptor["sha256"],
        }
    else:
        if "revision_hash" in request or mode != "intensity":
            raise ValueError("Label surfaces require an exact segmented result")
        source_id = checked_id(request.get("source_id"))
        values, geometry, selection = workbench.load_scalar(
            source_id, request.get("selection", {}), working_bytes=working_bytes
        )
        binding = {"source_id": source_id, "selection": selection}
    workbench.project.source(source_id, verify=True)
    if mode == "labels":
        if "isovalue" in request:
            raise ValueError("Label surfaces have a fixed display level of 0.5")
        validate_array(values, labels=True, geometry=geometry, working_bytes=working_bytes)
        label = request.get("label")
        if label is not None:
            label = integer(label, "display label", 1, 2**32 - 1)
            if not np.any(values == label):
                raise ValueError("The selected display label is absent")
        values = np.asarray(values > 0 if label is None else values == label, dtype=np.uint8)
        isovalue = 0.5
    else:
        if "label" in request:
            raise ValueError("A label filter requires label surface mode")
        isovalue = (
            finite_number(request["isovalue"], "display isovalue", -1e30, 1e30)
            if "isovalue" in request
            else None
        )
    mesh = surface_mesh(
        values,
        geometry,
        isovalue=isovalue,
        max_edge=request.get("max_edge", 80),
        working_bytes=working_bytes,
    )
    source = workbench.project.source(source_id, verify=True)
    return {
        **mesh,
        "binding": binding,
        "source_sha256": source["sha256"],
        "mode": mode,
        "label": request.get("label") if mode == "labels" else None,
        "adopted": False,
    }
