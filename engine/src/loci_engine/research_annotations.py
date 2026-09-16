"""Bounded label correction and geometry-bound annotation interchange.

Spatial arrays are scalar YX or ZYX arrays.  Polygon and brush coordinates use
plane-local U,V voxel-center coordinates; integer coordinates address voxel
centers.  No operation mutates its input or compacts pre-existing label IDs.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import math
import re
from dataclasses import dataclass
from types import ModuleType
from typing import Any, Literal

import numpy as np
from scipy import ndimage as ndi
from skimage.draw import polygon2mask
from skimage.segmentation import watershed

from .quantitative import DEFAULT_WORKING_BYTES, Geometry, validate_array

MAX_OPERATIONS = 64
MAX_POLYGON_POINTS = 4096
MAX_STROKE_POINTS = 1024
MAX_SEEDS = 32
MAX_BRUSH_RADIUS_VOXELS = 512
MAX_IMAGEJ_BYTES = 4 * 1024 * 1024
MAX_LABEL_ID = int(np.iinfo(np.uint32).max)
IMAGEJ_FLOAT32_ATOL = 1e-4

_SHA256 = re.compile(r"[0-9a-f]{64}")
_ANNOTATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_PLANES = {"XY", "XZ", "YZ"}
_COORDINATE_REFERENCE = {
    "type": "image-voxel",
    "origin": "zero-based",
    "sample_location": "voxel-center-at-integer-coordinate",
    "axis_order": "XYZ",
    "geographical": False,
}
_RASTER_RULE = "voxel center is included when inside or on polygon boundary"
_ROI_PROPERTY_KEYS = {
    "schema_version",
    "annotation_id",
    "source_sha256",
    "result_sha256",
    "source_t",
    "source_c",
    "image_shape",
    "array_axes",
    "affine_xyz_to_world",
    "distance_unit",
    "world_frame",
    "geometry_sha256",
    "plane",
    "plane_axes_uv",
    "plane_index",
    "slab_start",
    "slab_stop_exclusive",
    "coordinate_reference",
    "raster_rule",
    "polygon_uv",
    "world_polygon_xyz",
}


class AnnotationError(ValueError):
    """Raised when a correction or annotation request is invalid."""


class AnnotationDependencyError(AnnotationError):
    """Raised when an explicitly requested interchange dependency is absent."""


@dataclass(frozen=True, slots=True)
class PolygonROI:
    annotation_id: str
    image_shape: tuple[int, ...]
    geometry: Geometry
    source_sha256: str
    result_sha256: str | None
    source_t: int
    source_c: int
    plane: Literal["XY", "XZ", "YZ"]
    plane_index: int
    slab_start: int
    slab_stop_exclusive: int
    points_uv: tuple[tuple[float, float], ...]
    coordinate_convention: Literal["zero-based-voxel-center"] = "zero-based-voxel-center"

    def __post_init__(self) -> None:
        if not isinstance(self.geometry, Geometry):
            raise AnnotationError("geometry must be a validated quantitative.Geometry.")
        if not isinstance(self.annotation_id, str) or not _ANNOTATION_ID.fullmatch(
            self.annotation_id
        ):
            raise AnnotationError(
                "annotation_id must use 1 to 128 ASCII letters, digits, '.', '_' or '-'."
            )
        _hash_value(self.source_sha256, "source_sha256")
        if self.result_sha256 is not None:
            _hash_value(self.result_sha256, "result_sha256")
        for value, name in (
            (self.source_t, "source_t"),
            (self.source_c, "source_c"),
            (self.plane_index, "plane_index"),
            (self.slab_start, "slab_start"),
            (self.slab_stop_exclusive, "slab_stop_exclusive"),
        ):
            _integer(value, name, 0, 2**31 - 1)
        if self.coordinate_convention != "zero-based-voxel-center":
            raise AnnotationError("Unsupported ROI coordinate convention.")
        shape = _shape(self.image_shape, self.geometry)
        plane = _plane_spec(shape, self.geometry, self.plane, self.plane_index)
        if not (
            0 <= self.slab_start < self.slab_stop_exclusive <= plane.normal_size
            and self.slab_start <= self.plane_index < self.slab_stop_exclusive
        ):
            raise AnnotationError(
                "The ROI slab must be nonempty, contained, and include plane_index."
            )
        points = _points(
            self.points_uv,
            plane.width,
            plane.height,
            minimum=3,
            maximum=MAX_POLYGON_POINTS,
            boundary_half_voxel=True,
            name="ROI polygon",
        )
        if points != self.points_uv:
            raise AnnotationError("ROI points must be canonical immutable float tuples.")


@dataclass(frozen=True, slots=True)
class _PlaneSpec:
    plane: Literal["XY", "XZ", "YZ"]
    index: int
    width: int
    height: int
    normal_size: int
    u_axis: Literal["X", "Y"]
    v_axis: Literal["Y", "Z"]
    normal_axis: Literal["X", "Y", "Z"]
    u_spacing: float
    v_spacing: float


def _load_roifile() -> ModuleType:
    try:
        return importlib.import_module("roifile")
    except ImportError as exc:
        raise AnnotationDependencyError(
            "ImageJ ROI interchange requires the pinned roifile runtime."
        ) from exc


def _exact_keys(value: object, expected: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise AnnotationError(f"{name} must contain exactly: {', '.join(sorted(expected))}.")
    return value


def _hash_value(value: object, name: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise AnnotationError(f"{name} must be 64 lowercase hexadecimal characters.")
    return value


def _integer(value: object, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise AnnotationError(f"{name} must be an integer from {low} through {high}.")
    return value


def _finite(value: object, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AnnotationError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or not low <= result <= high:
        raise AnnotationError(f"{name} must be a finite number from {low} through {high}.")
    return result


def _label_id(value: object, name: str = "label") -> int:
    return _integer(value, name, 1, MAX_LABEL_ID)


def _shape(value: object, geometry: Geometry) -> tuple[int, ...]:
    if not isinstance(value, tuple) or len(value) != len(geometry.axes):
        raise AnnotationError("image_shape must be a tuple matching geometry axes.")
    return tuple(_integer(item, "image_shape value", 1, 2**31 - 1) for item in value)


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise AnnotationError("Annotation metadata is not finite canonical JSON.") from exc


def geometry_sha256(geometry: Geometry) -> str:
    """Return the canonical hash of axes, XYZ-world affine, unit, and frame."""

    if not isinstance(geometry, Geometry):
        raise AnnotationError("geometry must be a validated quantitative.Geometry.")
    canonical = {
        "axes": geometry.axes,
        "affine": [[float(value) for value in row] for row in geometry.affine],
        "unit": geometry.unit,
        "frame": geometry.frame,
    }
    return hashlib.sha256(_canonical_json(canonical).encode()).hexdigest()


def _canonical_array_bytes(array: np.ndarray) -> memoryview:
    little = array.astype(array.dtype.newbyteorder("<"), copy=False)
    contiguous = np.ascontiguousarray(little)
    return memoryview(contiguous).cast("B")


def label_array_sha256(labels: np.ndarray) -> str:
    """Hash uint32 label values with their canonical dtype, shape, and axes-neutral layout."""

    array = np.asarray(labels)
    if array.dtype != np.dtype(np.uint32) or array.ndim not in {2, 3}:
        raise AnnotationError("Labels must be a uint32 YX or ZYX array.")
    if any(length < 1 for length in array.shape):
        raise AnnotationError("Labels must be nonempty.")
    digest = hashlib.sha256()
    digest.update(b"loci-label-array-v1\0")
    digest.update(_canonical_json({"dtype": "<u4", "shape": list(array.shape)}).encode())
    digest.update(b"\0")
    digest.update(_canonical_array_bytes(array))
    return digest.hexdigest()


def _scalar_array_sha256(array: np.ndarray) -> str:
    digest = hashlib.sha256()
    digest.update(b"loci-scalar-array-v1\0")
    digest.update(_canonical_json({"dtype": array.dtype.str, "shape": list(array.shape)}).encode())
    digest.update(b"\0")
    digest.update(_canonical_array_bytes(array))
    return digest.hexdigest()


def _plane_spec(
    shape: tuple[int, ...], geometry: Geometry, plane_value: object, index_value: object
) -> _PlaneSpec:
    if plane_value not in _PLANES:
        raise AnnotationError("plane must be XY, XZ, or YZ.")
    plane = plane_value
    spacing = geometry.orthogonal_spacing()
    if geometry.axes == "YX":
        if plane != "XY":
            raise AnnotationError("A YX image supports only the XY plane.")
        index = _integer(index_value, "plane index", 0, 0)
        return _PlaneSpec("XY", index, shape[1], shape[0], 1, "X", "Y", "Z", spacing[1], spacing[0])
    z_size, y_size, x_size = shape
    z_spacing, y_spacing, x_spacing = spacing
    if plane == "XY":
        index = _integer(index_value, "plane index", 0, z_size - 1)
        return _PlaneSpec(plane, index, x_size, y_size, z_size, "X", "Y", "Z", x_spacing, y_spacing)
    if plane == "XZ":
        index = _integer(index_value, "plane index", 0, y_size - 1)
        return _PlaneSpec(plane, index, x_size, z_size, y_size, "X", "Z", "Y", x_spacing, z_spacing)
    index = _integer(index_value, "plane index", 0, x_size - 1)
    return _PlaneSpec("YZ", index, y_size, z_size, x_size, "Y", "Z", "X", y_spacing, z_spacing)


def _plane_view(array: np.ndarray, plane: _PlaneSpec) -> np.ndarray:
    if array.ndim == 2:
        return array
    if plane.plane == "XY":
        return array[plane.index, :, :]
    if plane.plane == "XZ":
        return array[:, plane.index, :]
    return array[:, :, plane.index]


def _point_pair(value: object, index: int, name: str) -> tuple[float, float]:
    point = _exact_keys(value, {"u", "v"}, f"{name}[{index}]")
    return (
        _finite(point["u"], f"{name}[{index}].u", -1e15, 1e15),
        _finite(point["v"], f"{name}[{index}].v", -1e15, 1e15),
    )


def _orientation(
    start: tuple[float, float], end: tuple[float, float], point: tuple[float, float]
) -> float:
    return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0])


def _on_segment(
    start: tuple[float, float], point: tuple[float, float], end: tuple[float, float]
) -> bool:
    epsilon = 1e-9
    return (
        min(start[0], end[0]) - epsilon <= point[0] <= max(start[0], end[0]) + epsilon
        and min(start[1], end[1]) - epsilon <= point[1] <= max(start[1], end[1]) + epsilon
    )


def _segments_intersect(
    first_start: tuple[float, float],
    first_end: tuple[float, float],
    second_start: tuple[float, float],
    second_end: tuple[float, float],
) -> bool:
    values = (
        _orientation(first_start, first_end, second_start),
        _orientation(first_start, first_end, second_end),
        _orientation(second_start, second_end, first_start),
        _orientation(second_start, second_end, first_end),
    )
    epsilon = 1e-9
    if (
        (values[0] > epsilon and values[1] < -epsilon)
        or (values[0] < -epsilon and values[1] > epsilon)
    ) and (
        (values[2] > epsilon and values[3] < -epsilon)
        or (values[2] < -epsilon and values[3] > epsilon)
    ):
        return True
    return any(
        abs(value) <= epsilon and _on_segment(start, point, end)
        for value, start, point, end in (
            (values[0], first_start, second_start, first_end),
            (values[1], first_start, second_end, first_end),
            (values[2], second_start, first_start, second_end),
            (values[3], second_start, first_end, second_end),
        )
    )


def _simple_polygon(points: tuple[tuple[float, float], ...]) -> bool:
    count = len(points)
    for first in range(count):
        first_end = (first + 1) % count
        for second in range(first + 1, count):
            second_end = (second + 1) % count
            if first == second or first_end == second or second_end == first:
                continue
            if _segments_intersect(
                points[first], points[first_end], points[second], points[second_end]
            ):
                return False
    return True


def _points(
    value: object,
    width: int,
    height: int,
    *,
    minimum: int,
    maximum: int,
    boundary_half_voxel: bool,
    name: str,
) -> tuple[tuple[float, float], ...]:
    if not isinstance(value, (list, tuple)) or not minimum <= len(value) <= maximum:
        raise AnnotationError(f"{name} requires {minimum} through {maximum} points.")
    points: list[tuple[float, float]] = []
    for index, raw in enumerate(value):
        if isinstance(raw, dict):
            point = _point_pair(raw, index, name)
        elif (
            isinstance(raw, tuple)
            and len(raw) == 2
            and all(isinstance(item, float) for item in raw)
        ):
            point = raw
        else:
            raise AnnotationError(f"{name}[{index}] must contain exactly numeric u and v.")
        low = -0.5 if boundary_half_voxel else 0.0
        high_u = width - 0.5 if boundary_half_voxel else width - 1.0
        high_v = height - 0.5 if boundary_half_voxel else height - 1.0
        if not low <= point[0] <= high_u or not low <= point[1] <= high_v:
            raise AnnotationError(f"{name}[{index}] lies outside the selected image plane.")
        if not points or point != points[-1]:
            points.append(point)
    if len(points) > minimum and points[0] == points[-1]:
        points.pop()
    output = tuple(points)
    if len(output) < minimum or len(set(output)) < minimum:
        raise AnnotationError(f"{name} requires {minimum} distinct points.")
    if minimum >= 3:
        if not _simple_polygon(output):
            raise AnnotationError(f"{name} cannot self-intersect.")
        twice_area = abs(
            sum(
                u * output[(index + 1) % len(output)][1] - output[(index + 1) % len(output)][0] * v
                for index, (u, v) in enumerate(output)
            )
        )
        if twice_area <= 1e-9:
            raise AnnotationError(f"{name} must enclose non-zero area.")
    return output


def _operation_points(
    value: object, plane: _PlaneSpec, *, polygon: bool
) -> tuple[tuple[float, float], ...]:
    return _points(
        value,
        plane.width,
        plane.height,
        minimum=3 if polygon else 1,
        maximum=MAX_POLYGON_POINTS if polygon else MAX_STROKE_POINTS,
        boundary_half_voxel=False,
        name="polygon points" if polygon else "brush points",
    )


def _polygon_mask(points: tuple[tuple[float, float], ...], plane: _PlaneSpec) -> np.ndarray:
    vertices_vu = np.asarray([(v, u) for u, v in points], dtype=np.float64)
    mask = polygon2mask((plane.height, plane.width), vertices_vu)
    if not mask.any():
        raise AnnotationError("The polygon does not contain any voxel centers.")
    structure = ndi.generate_binary_structure(2, 2)
    if ndi.label(mask, structure=structure)[1] != 1:
        raise AnnotationError("The polygon must rasterize to one connected region.")
    return mask


def _brush_mask(
    points: tuple[tuple[float, float], ...], plane: _PlaneSpec, radius: float, working_bytes: int
) -> np.ndarray:
    maximum_voxel_radius = max(radius / plane.u_spacing, radius / plane.v_spacing)
    if maximum_voxel_radius > MAX_BRUSH_RADIUS_VOXELS:
        raise AnnotationError("The physical brush radius exceeds 512 voxels on this plane.")
    mask = np.zeros((plane.height, plane.width), dtype=bool)
    segments = list(zip(points, points[1:], strict=False)) or [(points[0], points[0])]
    evaluated = 0
    for (start_u, start_v), (end_u, end_v) in segments:
        u0 = max(0, int(math.floor(min(start_u, end_u) - radius / plane.u_spacing)))
        u1 = min(
            plane.width,
            int(math.ceil(max(start_u, end_u) + radius / plane.u_spacing)) + 1,
        )
        v0 = max(0, int(math.floor(min(start_v, end_v) - radius / plane.v_spacing)))
        v1 = min(
            plane.height,
            int(math.ceil(max(start_v, end_v) + radius / plane.v_spacing)) + 1,
        )
        evaluated += (u1 - u0) * (v1 - v0)
        if evaluated * 40 > working_bytes:
            raise AnnotationError(
                "The brush path exceeds the bounded rasterization budget; shorten the stroke."
            )
        vv, uu = np.mgrid[v0:v1, u0:u1]
        px = (uu - start_u) * plane.u_spacing
        py = (vv - start_v) * plane.v_spacing
        dx = (end_u - start_u) * plane.u_spacing
        dy = (end_v - start_v) * plane.v_spacing
        length_squared = dx * dx + dy * dy
        if length_squared == 0:
            distance_squared = px * px + py * py
        else:
            fraction = np.clip((px * dx + py * dy) / length_squared, 0.0, 1.0)
            distance_squared = (px - fraction * dx) ** 2 + (py - fraction * dy) ** 2
        mask[v0:v1, u0:u1] |= distance_squared <= radius * radius * (1 + 1e-12)
    if not mask.any():
        raise AnnotationError("The brush does not cover any voxel centers.")
    return mask


def _unused_label_ids(labels: np.ndarray, count: int) -> tuple[int, ...]:
    used = {int(value) for value in np.unique(labels) if value != 0}
    output: list[int] = []
    candidate = 1
    while len(output) < count and candidate <= MAX_LABEL_ID:
        if candidate not in used:
            output.append(candidate)
        candidate += 1
    if len(output) != count:
        raise AnnotationError("No unused uint32 label IDs remain for this split.")
    return tuple(output)


def _seed_2d(value: object, plane: _PlaneSpec) -> tuple[int, int]:
    seed = _exact_keys(value, {"u", "v"}, "2D watershed seed")
    u = _integer(seed["u"], "seed u", 0, plane.width - 1)
    v = _integer(seed["v"], "seed v", 0, plane.height - 1)
    return v, u


def _seed_3d(value: object, shape: tuple[int, ...]) -> tuple[int, int, int]:
    seed = _exact_keys(value, {"x", "y", "z"}, "3D watershed seed")
    return (
        _integer(seed["z"], "seed z", 0, shape[0] - 1),
        _integer(seed["y"], "seed y", 0, shape[1] - 1),
        _integer(seed["x"], "seed x", 0, shape[2] - 1),
    )


def _watershed_split(
    corrected: np.ndarray,
    geometry: Geometry,
    operation: dict[str, Any],
) -> tuple[int, dict[str, Any]]:
    mode = operation["mode"]
    if mode not in {"2D", "3D"}:
        raise AnnotationError("watershed_split mode must be 2D or 3D.")
    target = _label_id(operation["label"])
    raw_seeds = operation["seeds"]
    if not isinstance(raw_seeds, list) or not 2 <= len(raw_seeds) <= MAX_SEEDS:
        raise AnnotationError("watershed_split requires 2 through 32 explicit seeds.")
    if mode == "3D":
        if corrected.ndim != 3 or set(operation) != {
            "op",
            "expected_input_sha256",
            "label",
            "mode",
            "seeds",
        }:
            raise AnnotationError(
                "A 3D watershed_split requires exactly label, mode, seeds, and identity."
            )
        target_view = corrected == target
        seeds = tuple(_seed_3d(seed, corrected.shape) for seed in raw_seeds)
        sampling = geometry.orthogonal_spacing()
        plane_record: dict[str, Any] = {}
    else:
        if set(operation) != {
            "op",
            "expected_input_sha256",
            "label",
            "mode",
            "seeds",
            "plane",
            "index",
        }:
            raise AnnotationError(
                "A 2D watershed_split requires exactly plane, index, label, seeds, and identity."
            )
        plane = _plane_spec(corrected.shape, geometry, operation["plane"], operation["index"])
        label_view = _plane_view(corrected, plane)
        target_view = label_view == target
        seeds = tuple(_seed_2d(seed, plane) for seed in raw_seeds)
        sampling = (plane.v_spacing, plane.u_spacing)
        plane_record = {
            "plane": plane.plane,
            "index": plane.index,
            "plane_axes_uv": [plane.u_axis, plane.v_axis],
        }
    if len(set(seeds)) != len(seeds):
        raise AnnotationError("Watershed seeds must be distinct voxel centers.")
    if not target_view.any():
        raise AnnotationError("The watershed target label is absent from the selected scope.")
    if any(not bool(target_view[seed]) for seed in seeds):
        raise AnnotationError("Every watershed seed must lie inside the target label.")
    connectivity = ndi.generate_binary_structure(target_view.ndim, 1)
    if ndi.label(target_view, structure=connectivity)[1] != 1:
        raise AnnotationError("The watershed target must be one connected object in its scope.")
    if np.count_nonzero(target_view) < len(seeds):
        raise AnnotationError("The watershed target has fewer voxels than seeds.")
    padded = np.pad(target_view, 1, mode="constant")
    distances = ndi.distance_transform_edt(padded, sampling=sampling)
    distances = distances[tuple(slice(1, -1) for _ in target_view.shape)]
    markers = np.zeros(target_view.shape, dtype=np.int32)
    for marker, seed in enumerate(seeds, 1):
        markers[seed] = marker
    basins = watershed(
        -distances,
        markers,
        mask=target_view,
        connectivity=connectivity,
    )
    if np.any(basins[target_view] == 0) or any(
        not np.any(basins == marker) for marker in range(1, len(seeds) + 1)
    ):
        raise AnnotationError("The seeded watershed did not produce one nonempty basin per seed.")
    allocated = _unused_label_ids(corrected, len(seeds) - 1)
    destination = corrected if mode == "3D" else _plane_view(corrected, plane)
    destination[target_view] = target
    for marker, new_label in enumerate(allocated, 2):
        destination[basins == marker] = new_label
    changed = int(sum(np.count_nonzero(basins == marker) for marker in range(2, len(seeds) + 1)))
    if changed == 0:
        raise AnnotationError("The watershed split is a no-op.")
    seed_records: list[dict[str, int]]
    if mode == "3D":
        seed_records = [{"z": int(seed[0]), "y": int(seed[1]), "x": int(seed[2])} for seed in seeds]
    else:
        seed_records = [{"u": int(seed[1]), "v": int(seed[0])} for seed in seeds]
    return changed, {
        "op": "watershed_split",
        "mode": mode,
        "label": target,
        "seeds": seed_records,
        "allocated_labels": list(allocated),
        "distance_unit": geometry.unit,
        "connectivity": "face",
        **plane_record,
    }


def correct_labels(
    labels: np.ndarray,
    geometry: Geometry,
    operations: list[dict[str, Any]],
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Apply explicit corrections to a derived uint32 copy and return its audit record."""

    raw = validate_array(
        labels,
        geometry=geometry,
        labels=True,
        working_bytes=working_bytes,
        bytes_per_voxel=96,
    )
    if raw.dtype != np.dtype(np.uint32):
        raise AnnotationError("Correction labels must use uint32 without narrowing or relabeling.")
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_OPERATIONS:
        raise AnnotationError("operations must contain 1 through 64 correction objects.")
    corrected = np.array(raw, dtype=np.uint32, order="C", copy=True)
    input_hash = label_array_sha256(corrected)
    current_hash = input_hash
    records: list[dict[str, Any]] = []
    for operation_index, raw_operation in enumerate(operations):
        if not isinstance(raw_operation, dict) or not isinstance(raw_operation.get("op"), str):
            raise AnnotationError(f"operations[{operation_index}] must be an operation object.")
        operation = raw_operation
        expected = _hash_value(
            operation.get("expected_input_sha256"),
            f"operations[{operation_index}].expected_input_sha256",
        )
        if expected != current_hash:
            raise AnnotationError(
                f"operations[{operation_index}] is stale for the current label array."
            )
        op = operation["op"]
        normalized: dict[str, Any]
        if op == "brush":
            _exact_keys(
                operation,
                {
                    "op",
                    "expected_input_sha256",
                    "mode",
                    "plane",
                    "index",
                    "points",
                    "radius",
                    "label",
                },
                "brush operation",
            )
            mode = operation["mode"]
            if mode not in {"paint", "erase"}:
                raise AnnotationError("brush mode must be paint or erase.")
            plane = _plane_spec(corrected.shape, geometry, operation["plane"], operation["index"])
            points = _operation_points(operation["points"], plane, polygon=False)
            radius = _finite(operation["radius"], "brush radius", 1e-12, 1e12)
            label = _label_id(operation["label"])
            view = _plane_view(corrected, plane)
            mask = _brush_mask(points, plane, radius, working_bytes)
            collisions = {int(value) for value in np.unique(view[mask]) if value not in {0, label}}
            if collisions:
                raise AnnotationError(
                    "The brush touches unrelated labels; resolve the collision explicitly."
                )
            if mode == "paint":
                changed = int(np.count_nonzero(mask & (view == 0)))
                if changed == 0:
                    raise AnnotationError("The paint brush is a no-op.")
                view[mask] = label
            else:
                changed = int(np.count_nonzero(mask & (view == label)))
                if changed == 0:
                    raise AnnotationError("The erase brush does not touch its target label.")
                view[mask & (view == label)] = 0
            normalized = {
                "op": "brush",
                "mode": mode,
                "plane": plane.plane,
                "index": plane.index,
                "plane_axes_uv": [plane.u_axis, plane.v_axis],
                "points_uv": [[u, v] for u, v in points],
                "radius": radius,
                "radius_unit": geometry.unit,
                "label": label,
            }
        elif op in {"polygon_add", "polygon_replace"}:
            _exact_keys(
                operation,
                {"op", "expected_input_sha256", "plane", "index", "points", "label"},
                f"{op} operation",
            )
            plane = _plane_spec(corrected.shape, geometry, operation["plane"], operation["index"])
            points = _operation_points(operation["points"], plane, polygon=True)
            label = _label_id(operation["label"])
            view = _plane_view(corrected, plane)
            mask = _polygon_mask(points, plane)
            overlaps = {int(value) for value in np.unique(view[mask]) if value != 0}
            if op == "polygon_add":
                if np.any(corrected == label):
                    raise AnnotationError(
                        "polygon_add requires an unused label ID; use brush to extend a label."
                    )
                if overlaps:
                    raise AnnotationError("The added polygon would overwrite an unrelated label.")
                changed = int(np.count_nonzero(mask))
                view[mask] = label
            else:
                target = view == label
                if not target.any():
                    raise AnnotationError(
                        "The replacement label is absent from the selected plane."
                    )
                if ndi.label(target, structure=ndi.generate_binary_structure(2, 2))[1] != 1:
                    raise AnnotationError(
                        "The selected label has multiple plane components; boundary replacement "
                        "is ambiguous."
                    )
                if label not in overlaps:
                    raise AnnotationError(
                        "The replacement polygon must overlap the selected label."
                    )
                if overlaps != {label}:
                    raise AnnotationError(
                        "The replacement polygon would overwrite an unrelated label."
                    )
                changed = int(np.count_nonzero(target ^ mask))
                if changed == 0:
                    raise AnnotationError("The replacement polygon is a no-op.")
                view[target] = 0
                view[mask] = label
            normalized = {
                "op": op,
                "plane": plane.plane,
                "index": plane.index,
                "plane_axes_uv": [plane.u_axis, plane.v_axis],
                "points_uv": [[u, v] for u, v in points],
                "label": label,
            }
        elif op == "merge":
            _exact_keys(
                operation,
                {"op", "expected_input_sha256", "source_labels", "target_label"},
                "merge operation",
            )
            raw_sources = operation["source_labels"]
            if not isinstance(raw_sources, list) or not 2 <= len(raw_sources) <= MAX_SEEDS:
                raise AnnotationError("merge source_labels must contain 2 through 32 IDs.")
            sources = tuple(_label_id(value, "source label") for value in raw_sources)
            if len(set(sources)) != len(sources):
                raise AnnotationError("merge source_labels must be distinct.")
            target = _label_id(operation["target_label"], "target_label")
            if target not in sources:
                raise AnnotationError("merge target_label must be one of source_labels.")
            absent = [value for value in sources if not np.any(corrected == value)]
            if absent:
                raise AnnotationError("Every merge source label must exist.")
            selection = np.isin(corrected, [value for value in sources if value != target])
            changed = int(np.count_nonzero(selection))
            if changed == 0:
                raise AnnotationError("The merge is a no-op.")
            corrected[selection] = target
            normalized = {
                "op": "merge",
                "source_labels": list(sources),
                "target_label": target,
            }
        elif op == "delete":
            _exact_keys(
                operation,
                {"op", "expected_input_sha256", "label"},
                "delete operation",
            )
            label = _label_id(operation["label"])
            selection = corrected == label
            changed = int(np.count_nonzero(selection))
            if changed == 0:
                raise AnnotationError("The deleted label is absent.")
            corrected[selection] = 0
            normalized = {"op": "delete", "label": label}
        elif op == "watershed_split":
            changed, normalized = _watershed_split(corrected, geometry, operation)
        else:
            raise AnnotationError(f"Unknown correction operation: {op}.")
        output_hash = label_array_sha256(corrected)
        if output_hash == current_hash or changed <= 0:
            raise AnnotationError(f"operations[{operation_index}] did not change any labels.")
        records.append(
            {
                **normalized,
                "input_labels_sha256": current_hash,
                "output_labels_sha256": output_hash,
                "changed_voxels": changed,
            }
        )
        current_hash = output_hash
    corrected.setflags(write=False)
    geometry_hash = geometry_sha256(geometry)
    return corrected, {
        "schema_version": "1.0",
        "input_labels_sha256": input_hash,
        "output_labels_sha256": current_hash,
        "dtype": "uint32",
        "shape": list(corrected.shape),
        "array_axes": geometry.axes,
        "geometry": geometry.to_dict(),
        "geometry_sha256": geometry_hash,
        "coordinate_convention": "zero-based-voxel-center; array YX or ZYX; world XYZ",
        "operation_count": len(records),
        "operations": records,
        "input_mutation": "none-derived-copy",
        "scientific_validation": "unvalidated-research-annotation",
    }


def create_polygon_roi(
    *,
    annotation_id: str,
    image_shape: tuple[int, ...],
    geometry: Geometry,
    source_sha256: str,
    result_sha256: str | None,
    source_t: int,
    source_c: int,
    plane: Literal["XY", "XZ", "YZ"],
    plane_index: int,
    points: object,
    slab_start: int | None = None,
    slab_stop_exclusive: int | None = None,
) -> PolygonROI:
    """Create a validated polygon anchored to an image/result and plane or slab."""

    shape = _shape(image_shape, geometry)
    plane_spec = _plane_spec(shape, geometry, plane, plane_index)
    points_uv = _points(
        points,
        plane_spec.width,
        plane_spec.height,
        minimum=3,
        maximum=MAX_POLYGON_POINTS,
        boundary_half_voxel=True,
        name="ROI polygon",
    )
    start = plane_index if slab_start is None else slab_start
    stop = plane_index + 1 if slab_stop_exclusive is None else slab_stop_exclusive
    return PolygonROI(
        annotation_id=annotation_id,
        image_shape=shape,
        geometry=geometry,
        source_sha256=source_sha256,
        result_sha256=result_sha256,
        source_t=source_t,
        source_c=source_c,
        plane=plane,
        plane_index=plane_index,
        slab_start=start,
        slab_stop_exclusive=stop,
        points_uv=points_uv,
    )


def _full_coordinates(roi: PolygonROI, *, close: bool = False) -> np.ndarray:
    points = (*roi.points_uv, roi.points_uv[0]) if close else roi.points_uv
    output: list[tuple[float, ...]] = []
    for u, v in points:
        if roi.geometry.axes == "YX":
            output.append((v, u))
        elif roi.plane == "XY":
            output.append((float(roi.plane_index), v, u))
        elif roi.plane == "XZ":
            output.append((v, float(roi.plane_index), u))
        else:
            output.append((v, u, float(roi.plane_index)))
    return np.asarray(output, dtype=np.float64)


def _polygon_index_area(points: tuple[tuple[float, float], ...]) -> float:
    return (
        abs(
            sum(
                u * points[(index + 1) % len(points)][1] - points[(index + 1) % len(points)][0] * v
                for index, (u, v) in enumerate(points)
            )
        )
        / 2
    )


def _plane_area_scale(roi: PolygonROI) -> float:
    basis = np.asarray(roi.geometry.affine, dtype=np.float64)[:3, :3]
    columns = {"X": basis[:, 0], "Y": basis[:, 1], "Z": basis[:, 2]}
    plane = _plane_spec(roi.image_shape, roi.geometry, roi.plane, roi.plane_index)
    return float(np.linalg.norm(np.cross(columns[plane.u_axis], columns[plane.v_axis])))


def _roi_mask(roi: PolygonROI) -> np.ndarray:
    plane = _plane_spec(roi.image_shape, roi.geometry, roi.plane, roi.plane_index)
    return _polygon_mask(roi.points_uv, plane)


def measure_polygon_roi(
    image: np.ndarray,
    roi: PolygonROI,
    *,
    source_sha256: str,
    result_sha256: str | None,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> dict[str, Any]:
    """Return raw descriptive intensities and calibrated planar/slab geometry."""

    if not isinstance(roi, PolygonROI):
        raise AnnotationError("roi must be a validated PolygonROI.")
    if _hash_value(source_sha256, "source_sha256") != roi.source_sha256:
        raise AnnotationError("The ROI is anchored to a different source identity.")
    if result_sha256 is not None:
        _hash_value(result_sha256, "result_sha256")
    if result_sha256 != roi.result_sha256:
        raise AnnotationError("The ROI is anchored to a different result identity.")
    raw = validate_array(
        image,
        geometry=roi.geometry,
        working_bytes=working_bytes,
        bytes_per_voxel=72,
    )
    if raw.shape != roi.image_shape:
        raise AnnotationError("The ROI image shape differs from its anchored image shape.")
    mask = _roi_mask(roi)
    start, stop = roi.slab_start, roi.slab_stop_exclusive
    if raw.ndim == 2:
        selected = raw[mask]
    elif roi.plane == "XY":
        selected = raw[start:stop, :, :][:, mask]
    elif roi.plane == "XZ":
        selected = raw[:, start:stop, :].transpose(1, 0, 2)[:, mask]
    else:
        selected = raw[:, :, start:stop].transpose(2, 0, 1)[:, mask]
    values = selected.astype(np.float64, copy=False).reshape(-1)
    if values.size == 0:
        raise AnnotationError("The ROI does not sample any voxel centers.")
    index_area = _polygon_index_area(roi.points_uv)
    area_scale = _plane_area_scale(roi)
    polygon_area = index_area * area_scale
    basis = np.asarray(roi.geometry.affine, dtype=np.float64)[:3, :3]
    element_measure = area_scale if raw.ndim == 2 else abs(float(np.linalg.det(basis)))
    slab_planes = stop - start
    geometric_measure = (
        polygon_area
        if slab_planes == 1
        else index_area * abs(float(np.linalg.det(basis))) * slab_planes
    )
    measure_kind = "area" if slab_planes == 1 else "slab-volume"
    geometric_measure_unit = f"{roi.geometry.unit}^{2 if measure_kind == 'area' else 3}"
    sampled_measure_kind = "area" if raw.ndim == 2 else "voxel-volume"
    sampled_measure_unit = f"{roi.geometry.unit}^{2 if raw.ndim == 2 else 3}"
    world = roi.geometry.world(_full_coordinates(roi))
    plane = _plane_spec(roi.image_shape, roi.geometry, roi.plane, roi.plane_index)
    return {
        "schema_version": "1.0",
        "annotation_id": roi.annotation_id,
        "source_sha256": roi.source_sha256,
        "result_sha256": roi.result_sha256,
        "input_array_sha256": _scalar_array_sha256(raw),
        "geometry_sha256": geometry_sha256(roi.geometry),
        "plane": roi.plane,
        "plane_axes_uv": [plane.u_axis, plane.v_axis],
        "plane_index": roi.plane_index,
        "slab_start": start,
        "slab_stop_exclusive": stop,
        "coordinate_convention": roi.coordinate_convention,
        "polygon_uv": [[u, v] for u, v in roi.points_uv],
        "world_polygon_xyz": world.tolist(),
        "world_frame": roi.geometry.frame,
        "polygon_area_index_squared": index_area,
        "polygon_area": polygon_area,
        "geometric_measure": geometric_measure,
        "sampled_measure": float(values.size * element_measure),
        "measure_kind": measure_kind,
        "measure_unit": geometric_measure_unit,
        "geometric_measure_unit": geometric_measure_unit,
        "sampled_measure_kind": sampled_measure_kind,
        "sampled_measure_unit": sampled_measure_unit,
        "calibration_status": (
            "uncalibrated-pixel" if roi.geometry.unit == "pixel" else "declared-geometry"
        ),
        "sampled_voxel_count": int(values.size),
        "raw_intensity": {
            "dtype": raw.dtype.str,
            "basis": "unmodified-selected-scalar-values",
            "mean": float(values.mean()),
            "sum": float(values.sum()),
            "min": float(values.min()),
            "max": float(values.max()),
            "std_population": float(values.std()),
        },
        "scientific_interpretation": "descriptive-geometry-and-raw-intensity-only",
    }


def _roi_properties(roi: PolygonROI) -> dict[str, Any]:
    plane = _plane_spec(roi.image_shape, roi.geometry, roi.plane, roi.plane_index)
    world_ring = roi.geometry.world(_full_coordinates(roi, close=True)).tolist()
    return {
        "schema_version": "1.0",
        "annotation_id": roi.annotation_id,
        "source_sha256": roi.source_sha256,
        "result_sha256": roi.result_sha256,
        "source_t": roi.source_t,
        "source_c": roi.source_c,
        "image_shape": list(roi.image_shape),
        "array_axes": roi.geometry.axes,
        "affine_xyz_to_world": [list(row) for row in roi.geometry.affine],
        "distance_unit": roi.geometry.unit,
        "world_frame": roi.geometry.frame,
        "geometry_sha256": geometry_sha256(roi.geometry),
        "plane": roi.plane,
        "plane_axes_uv": [plane.u_axis, plane.v_axis],
        "plane_index": roi.plane_index,
        "slab_start": roi.slab_start,
        "slab_stop_exclusive": roi.slab_stop_exclusive,
        "coordinate_reference": dict(_COORDINATE_REFERENCE),
        "raster_rule": _RASTER_RULE,
        "polygon_uv": [[u, v] for u, v in roi.points_uv],
        "world_polygon_xyz": world_ring,
    }


def roi_to_geojson(roi: PolygonROI) -> dict[str, Any]:
    """Export one non-geographical GeoJSON Feature in image-voxel XYZ coordinates."""

    if not isinstance(roi, PolygonROI):
        raise AnnotationError("roi must be a validated PolygonROI.")
    full = _full_coordinates(roi, close=True)
    if roi.geometry.axes == "YX":
        coordinates = [[float(point[1]), float(point[0]), 0.0] for point in full]
    else:
        coordinates = [[float(point[2]), float(point[1]), float(point[0])] for point in full]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [coordinates]},
        "properties": _roi_properties(roi),
    }


def _geometry_from_properties(properties: dict[str, Any], name: str) -> Geometry:
    affine = properties["affine_xyz_to_world"]
    if (
        not isinstance(affine, list)
        or len(affine) != 4
        or any(not isinstance(row, list) or len(row) != 4 for row in affine)
    ):
        raise AnnotationError(f"{name} affine_xyz_to_world must be a 4 x 4 matrix.")
    matrix = tuple(
        tuple(
            _finite(value, f"affine_xyz_to_world[{row}][{column}]", -1e15, 1e15)
            for column, value in enumerate(values)
        )
        for row, values in enumerate(affine)
    )
    try:
        return Geometry(
            properties["array_axes"],
            matrix,
            properties["distance_unit"],
            properties["world_frame"],
        )
    except (TypeError, ValueError) as exc:
        raise AnnotationError(f"{name} geometry metadata are invalid.") from exc


def _validated_roi_properties(value: object, name: str) -> tuple[dict[str, Any], Geometry]:
    properties = _exact_keys(value, _ROI_PROPERTY_KEYS, name)
    if properties["schema_version"] != "1.0":
        raise AnnotationError(f"Unsupported {name} schema_version.")
    reference = _exact_keys(
        properties["coordinate_reference"],
        set(_COORDINATE_REFERENCE),
        f"{name} coordinate_reference",
    )
    if reference != _COORDINATE_REFERENCE:
        raise AnnotationError(f"{name} coordinates are not the supported image-voxel profile.")
    if properties["raster_rule"] != _RASTER_RULE:
        raise AnnotationError(f"{name} has an unsupported polygon raster rule.")
    geometry = _geometry_from_properties(properties, name)
    if geometry_sha256(geometry) != properties["geometry_sha256"]:
        raise AnnotationError(f"{name} geometry does not match its geometry_sha256.")
    return properties, geometry


def _property_image_shape(
    properties: dict[str, Any], geometry: Geometry, name: str
) -> tuple[int, ...]:
    raw_shape = properties["image_shape"]
    if not isinstance(raw_shape, list):
        raise AnnotationError(f"{name} image_shape must be a JSON array.")
    return _shape(tuple(raw_shape), geometry)


def _property_coordinate_array(
    value: object,
    *,
    dimensions: int,
    maximum: int,
    name: str,
) -> np.ndarray:
    if not isinstance(value, list) or not 1 <= len(value) <= maximum:
        raise AnnotationError(f"{name} must contain 1 through {maximum} coordinates.")
    rows: list[list[float]] = []
    for row_index, raw_row in enumerate(value):
        if not isinstance(raw_row, list) or len(raw_row) != dimensions:
            raise AnnotationError(f"{name}[{row_index}] must contain {dimensions} numbers.")
        rows.append(
            [
                _finite(item, f"{name}[{row_index}][{column}]", -1e15, 1e15)
                for column, item in enumerate(raw_row)
            ]
        )
    return np.asarray(rows, dtype=np.float64)


def roi_from_geojson(value: object) -> PolygonROI:
    """Import the strict Loci image-coordinate GeoJSON profile."""

    feature = _exact_keys(value, {"type", "geometry", "properties"}, "GeoJSON feature")
    if feature["type"] != "Feature":
        raise AnnotationError("GeoJSON type must be Feature.")
    geometry_value = _exact_keys(feature["geometry"], {"type", "coordinates"}, "GeoJSON geometry")
    if geometry_value["type"] != "Polygon":
        raise AnnotationError("GeoJSON geometry must be Polygon.")
    properties, geometry = _validated_roi_properties(feature["properties"], "GeoJSON properties")
    raw_coordinates = geometry_value["coordinates"]
    if (
        not isinstance(raw_coordinates, list)
        or len(raw_coordinates) != 1
        or not isinstance(raw_coordinates[0], list)
        or len(raw_coordinates[0]) < 4
        or len(raw_coordinates[0]) > MAX_POLYGON_POINTS + 1
    ):
        raise AnnotationError(
            "GeoJSON Polygon must contain one closed exterior ring of 3 through 4096 vertices."
        )
    ring: list[tuple[float, float, float]] = []
    for index, point in enumerate(raw_coordinates[0]):
        if not isinstance(point, list) or len(point) != 3:
            raise AnnotationError(f"GeoJSON coordinate {index} must be image XYZ.")
        ring.append(
            tuple(_finite(item, f"GeoJSON coordinate {index}", -1e15, 1e15) for item in point)  # type: ignore[arg-type]
        )
    if ring[0] != ring[-1]:
        raise AnnotationError("GeoJSON polygon ring must be explicitly closed.")
    plane = properties["plane"]
    plane_index = properties["plane_index"]
    points_uv: list[dict[str, float]] = []
    for x, y, z in ring[:-1]:
        if geometry.axes == "YX":
            if z != 0:
                raise AnnotationError("YX GeoJSON must use Z=0.")
            u, v = x, y
        elif plane == "XY":
            if z != plane_index:
                raise AnnotationError("GeoJSON polygon leaves its declared XY plane.")
            u, v = x, y
        elif plane == "XZ":
            if y != plane_index:
                raise AnnotationError("GeoJSON polygon leaves its declared XZ plane.")
            u, v = x, z
        elif plane == "YZ":
            if x != plane_index:
                raise AnnotationError("GeoJSON polygon leaves its declared YZ plane.")
            u, v = y, z
        else:
            raise AnnotationError("GeoJSON plane must be XY, XZ, or YZ.")
        points_uv.append({"u": u, "v": v})
    roi = create_polygon_roi(
        annotation_id=properties["annotation_id"],
        image_shape=_property_image_shape(properties, geometry, "GeoJSON properties"),
        geometry=geometry,
        source_sha256=properties["source_sha256"],
        result_sha256=properties["result_sha256"],
        source_t=properties["source_t"],
        source_c=properties["source_c"],
        plane=plane,
        plane_index=plane_index,
        slab_start=properties["slab_start"],
        slab_stop_exclusive=properties["slab_stop_exclusive"],
        points=points_uv,
    )
    plane_spec = _plane_spec(roi.image_shape, roi.geometry, roi.plane, roi.plane_index)
    if properties["plane_axes_uv"] != [plane_spec.u_axis, plane_spec.v_axis]:
        raise AnnotationError("GeoJSON plane_axes_uv disagrees with its declared plane.")
    declared_uv = _property_coordinate_array(
        properties["polygon_uv"],
        dimensions=2,
        maximum=MAX_POLYGON_POINTS,
        name="GeoJSON polygon_uv",
    )
    expected_uv = np.asarray(roi.points_uv, dtype=np.float64)
    if (
        declared_uv.shape != expected_uv.shape
        or not np.isfinite(declared_uv).all()
        or not np.array_equal(declared_uv, expected_uv)
    ):
        raise AnnotationError("GeoJSON polygon_uv disagrees with its geometry coordinates.")
    expected_world = roi.geometry.world(_full_coordinates(roi, close=True))
    declared_world = _property_coordinate_array(
        properties["world_polygon_xyz"],
        dimensions=3,
        maximum=MAX_POLYGON_POINTS + 1,
        name="GeoJSON world_polygon_xyz",
    )
    if (
        declared_world.shape != expected_world.shape
        or not np.isfinite(declared_world).all()
        or not np.allclose(declared_world, expected_world, rtol=1e-12, atol=1e-9)
    ):
        raise AnnotationError("GeoJSON world coordinates disagree with the voxel affine.")
    return roi


def _imagej_payload(roi: PolygonROI, tolerance: float) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "annotation": _roi_properties(roi),
        "imagej_coordinate_conversion": "imagej-area-edge=loci-voxel-center+0.5",
        "float32_absolute_tolerance": tolerance,
    }


def roi_to_imagej(roi: PolygonROI, *, float32_atol: float = IMAGEJ_FLOAT32_ATOL) -> bytes:
    """Export an exactly bounded single-plane XY polygon to ImageJ ROI bytes."""

    if not isinstance(roi, PolygonROI):
        raise AnnotationError("roi must be a validated PolygonROI.")
    tolerance = _finite(float32_atol, "float32_atol", 0, 0.5)
    if (
        roi.plane != "XY"
        or roi.slab_start != roi.plane_index
        or roi.slab_stop_exclusive != roi.plane_index + 1
    ):
        raise AnnotationError("ImageJ ROI export supports only one explicitly indexed XY plane.")
    imagej_points = np.asarray(roi.points_uv, dtype=np.float64) + 0.5
    float_points = imagej_points.astype(np.float32)
    if not np.allclose(float_points.astype(np.float64), imagej_points, rtol=0, atol=tolerance):
        raise AnnotationError(
            "ImageJ float32 coordinates cannot represent this polygon within float32_atol."
        )
    roifile = _load_roifile()
    imagej = roifile.ImagejRoi.frompoints(
        float_points,
        name=roi.annotation_id,
        c=roi.source_c,
        z=roi.plane_index,
        t=roi.source_t,
    )
    imagej.roitype = roifile.ROI_TYPE.POLYGON
    payload = _canonical_json(_imagej_payload(roi, tolerance)).encode()
    encoded_payload = base64.urlsafe_b64encode(payload).decode("ascii")
    imagej.properties = {
        "loci_coordinate_origin": "zero-based-voxel-center",
        "loci_payload_base64url": encoded_payload,
        "loci_schema": "1.0",
    }
    try:
        encoded = imagej.tobytes()
    except Exception as exc:
        raise AnnotationError("The polygon cannot be encoded as an ImageJ ROI.") from exc
    if len(encoded) > MAX_IMAGEJ_BYTES:
        raise AnnotationError("The encoded ImageJ ROI exceeds the 4 MiB limit.")
    return encoded


def roi_from_imagej(
    data: bytes,
    *,
    expected_source_sha256: str | None = None,
    expected_result_sha256: str | None = None,
    float32_atol: float = IMAGEJ_FLOAT32_ATOL,
) -> PolygonROI:
    """Import a Loci-authored ImageJ polygon and verify its embedded geometry anchor."""

    if not isinstance(data, bytes) or not 64 <= len(data) <= MAX_IMAGEJ_BYTES:
        raise AnnotationError("ImageJ ROI data must contain 64 bytes through 4 MiB.")
    tolerance = _finite(float32_atol, "float32_atol", 0, 0.5)
    roifile = _load_roifile()
    try:
        imagej = roifile.ImagejRoi.frombytes(data)
        coordinates = np.asarray(imagej.coordinates(), dtype=np.float64)
        properties = imagej.properties
    except Exception as exc:
        raise AnnotationError("ImageJ ROI bytes are malformed or unsupported.") from exc
    if (
        imagej.roitype != roifile.ROI_TYPE.POLYGON
        or coordinates.ndim != 2
        or coordinates.shape[1] != 2
    ):
        raise AnnotationError("Only ImageJ polygon ROI records are supported.")
    if not isinstance(properties, dict) or set(properties) != {
        "loci_coordinate_origin",
        "loci_payload_base64url",
        "loci_schema",
    }:
        raise AnnotationError("ImageJ ROI lacks the exact Loci coordinate and geometry anchor.")
    if (
        properties["loci_coordinate_origin"] != "zero-based-voxel-center"
        or str(properties["loci_schema"]) != "1.0"
    ):
        raise AnnotationError("ImageJ ROI has an unsupported Loci coordinate convention.")
    encoded_payload = properties["loci_payload_base64url"]
    if not isinstance(encoded_payload, str) or len(encoded_payload) > MAX_IMAGEJ_BYTES:
        raise AnnotationError("ImageJ ROI embedded Loci payload is malformed.")
    try:
        raw_payload = base64.b64decode(encoded_payload, altchars=b"-_", validate=True)
        payload = json.loads(raw_payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AnnotationError("ImageJ ROI embedded Loci payload is invalid.") from exc
    envelope = _exact_keys(
        payload,
        {
            "schema_version",
            "annotation",
            "imagej_coordinate_conversion",
            "float32_absolute_tolerance",
        },
        "ImageJ Loci payload",
    )
    if (
        envelope["schema_version"] != "1.0"
        or envelope["imagej_coordinate_conversion"] != "imagej-area-edge=loci-voxel-center+0.5"
    ):
        raise AnnotationError("ImageJ ROI embedded Loci payload has an unsupported schema.")
    stored_tolerance = _finite(
        envelope["float32_absolute_tolerance"], "stored float32 tolerance", 0, 0.5
    )
    if stored_tolerance > tolerance:
        raise AnnotationError("ImageJ ROI was exported with a looser float32 tolerance.")
    annotation, geometry = _validated_roi_properties(
        envelope["annotation"], "ImageJ annotation payload"
    )
    if annotation["plane"] != "XY":
        raise AnnotationError("ImageJ ROI payload does not describe an XY polygon.")
    if (
        imagej.c_position != annotation["source_c"] + 1
        or imagej.z_position != annotation["plane_index"] + 1
        or imagej.t_position != annotation["source_t"] + 1
    ):
        raise AnnotationError("ImageJ C/Z/T positions disagree with the embedded source indices.")
    if imagej.name != annotation["annotation_id"]:
        raise AnnotationError("ImageJ ROI name disagrees with the embedded annotation ID.")
    points = coordinates - 0.5
    declared_points = _property_coordinate_array(
        annotation["polygon_uv"],
        dimensions=2,
        maximum=MAX_POLYGON_POINTS,
        name="ImageJ ROI embedded polygon_uv",
    )
    if (
        declared_points.shape != points.shape
        or not np.isfinite(declared_points).all()
        or not np.allclose(points, declared_points, rtol=0, atol=tolerance)
    ):
        raise AnnotationError(
            "ImageJ ROI coordinates disagree with the embedded exact polygon vertices."
        )
    roi = create_polygon_roi(
        annotation_id=annotation["annotation_id"],
        image_shape=_property_image_shape(annotation, geometry, "ImageJ annotation payload"),
        geometry=geometry,
        source_sha256=annotation["source_sha256"],
        result_sha256=annotation["result_sha256"],
        source_t=annotation["source_t"],
        source_c=annotation["source_c"],
        plane="XY",
        plane_index=annotation["plane_index"],
        slab_start=annotation["slab_start"],
        slab_stop_exclusive=annotation["slab_stop_exclusive"],
        points=[{"u": float(point[0]), "v": float(point[1])} for point in declared_points],
    )
    if (
        expected_source_sha256 is not None
        and _hash_value(expected_source_sha256, "expected_source_sha256") != roi.source_sha256
    ):
        raise AnnotationError("ImageJ ROI is anchored to a different source identity.")
    if (
        expected_result_sha256 is not None
        and _hash_value(expected_result_sha256, "expected_result_sha256") != roi.result_sha256
    ):
        raise AnnotationError("ImageJ ROI is anchored to a different result identity.")
    plane = _plane_spec(roi.image_shape, roi.geometry, roi.plane, roi.plane_index)
    if annotation["plane_axes_uv"] != [plane.u_axis, plane.v_axis]:
        raise AnnotationError("ImageJ ROI plane axes disagree with its payload.")
    expected_world = roi.geometry.world(_full_coordinates(roi, close=True))
    declared_world = _property_coordinate_array(
        annotation["world_polygon_xyz"],
        dimensions=3,
        maximum=MAX_POLYGON_POINTS + 1,
        name="ImageJ ROI embedded world_polygon_xyz",
    )
    if (
        declared_world.shape != expected_world.shape
        or not np.isfinite(declared_world).all()
        or not np.allclose(declared_world, expected_world, rtol=1e-7, atol=tolerance)
    ):
        raise AnnotationError("ImageJ ROI world coordinates disagree after float32 roundtrip.")
    return roi
