"""Deterministic, local vertex edits for revision-bound research labels."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import ndimage as ndi
from skimage import measure
from skimage.draw import polygon2mask

from .quantitative import DEFAULT_WORKING_BYTES, Geometry, validate_array
from .research_annotations import AnnotationError, geometry_sha256, label_array_sha256

MAX_EDITABLE_BOUNDARY_VERTICES = 96
MAX_LABEL_ID = int(np.iinfo(np.uint32).max)
_PLANES = {"XY", "XZ", "YZ"}


def _integer(value: object, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise AnnotationError(f"{name} must be an integer from {low} through {high}.")
    return value


def _plane(
    labels: np.ndarray, geometry: Geometry, plane: object, index: object
) -> tuple[np.ndarray, str, int, int, int, tuple[str, str]]:
    if plane not in _PLANES:
        raise AnnotationError("plane must be XY, XZ, or YZ.")
    if labels.ndim == 2:
        if plane != "XY":
            raise AnnotationError("A YX label array supports only the XY plane.")
        selected = _integer(index, "plane index", 0, 0)
        return labels, "XY", selected, labels.shape[1], labels.shape[0], ("X", "Y")
    z_size, y_size, x_size = labels.shape
    if plane == "XY":
        selected = _integer(index, "plane index", 0, z_size - 1)
        return labels[selected], "XY", selected, x_size, y_size, ("X", "Y")
    if plane == "XZ":
        selected = _integer(index, "plane index", 0, y_size - 1)
        return labels[:, selected, :], "XZ", selected, x_size, z_size, ("X", "Z")
    selected = _integer(index, "plane index", 0, x_size - 1)
    return labels[:, :, selected], "YZ", selected, y_size, z_size, ("Y", "Z")


def _coordinates(points: list[tuple[float, float]], plane: str, index: int) -> np.ndarray:
    if plane == "XY":
        return np.asarray([[index, v, u] for u, v in points], dtype=np.float64)
    if plane == "XZ":
        return np.asarray([[v, index, u] for u, v in points], dtype=np.float64)
    return np.asarray([[v, u, index] for u, v in points], dtype=np.float64)


def _world(
    geometry: Geometry, points: list[tuple[float, float]], plane: str, index: int
) -> list[list[float]]:
    coordinates = _coordinates(points, plane, index)
    if geometry.axes == "YX":
        coordinates = coordinates[:, 1:]
    return [[float(value) for value in row] for row in geometry.world(coordinates)]


def _editable_polygon(mask: np.ndarray) -> tuple[list[tuple[float, float]], bool]:
    padded = np.pad(mask, 1, mode="constant", constant_values=False)
    contours = measure.find_contours(padded.astype(np.uint8), 0.5, fully_connected="high")
    if not contours:
        raise AnnotationError("The selected label has no editable outer boundary.")
    contour = max(contours, key=lambda item: (item.shape[0], float(item[:, 0].max()))) - 1
    tolerance = 0.35
    simplified = measure.approximate_polygon(contour, tolerance=tolerance)
    while len(simplified) - 1 > MAX_EDITABLE_BOUNDARY_VERTICES:
        tolerance *= 1.35
        simplified = measure.approximate_polygon(contour, tolerance=tolerance)
    height, width = mask.shape
    points: list[tuple[float, float]] = []
    for row, column in simplified:
        point = (
            min(width - 1.0, max(0.0, float(column))),
            min(height - 1.0, max(0.0, float(row))),
        )
        if not points or point != points[-1]:
            points.append(point)
    if len(points) >= 2 and points[0] == points[-1]:
        points.pop()
    if not 3 <= len(points) <= MAX_EDITABLE_BOUNDARY_VERTICES or len(set(points)) < 3:
        raise AnnotationError("The selected label has no bounded editable outer boundary.")
    return points, len(contour) - 1 > len(points)


def editable_instance_boundary(
    labels: np.ndarray,
    geometry: Geometry,
    *,
    plane: object,
    index: object,
    label: object,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> dict[str, Any]:
    """Return one exact label's bounded outer polygon in plane and world coordinates."""

    array = validate_array(
        labels,
        geometry=geometry,
        labels=True,
        working_bytes=working_bytes,
        bytes_per_voxel=32,
    )
    if array.dtype != np.dtype(np.uint32):
        raise AnnotationError("Boundary labels must use uint32 without narrowing or relabeling.")
    target = _integer(label, "label", 1, MAX_LABEL_ID)
    view, selected_plane, selected_index, _width, _height, axes = _plane(
        array, geometry, plane, index
    )
    mask = view == target
    if not mask.any():
        raise AnnotationError("The selected label is absent from the selected plane.")
    if ndi.label(mask, structure=ndi.generate_binary_structure(2, 2))[1] != 1:
        raise AnnotationError(
            "The selected label has multiple plane components; vertex editing is ambiguous."
        )
    points, simplified = _editable_polygon(mask)
    return {
        "label": target,
        "plane": selected_plane,
        "index": selected_index,
        "plane_axes_uv": list(axes),
        "vertices_uv": [{"u": u, "v": v} for u, v in points],
        "world_vertices_xyz": _world(geometry, points, selected_plane, selected_index),
        "geometry_sha256": geometry_sha256(geometry),
        "distance_unit": geometry.unit,
        "world_frame": geometry.frame,
        "coordinate_convention": "zero-based voxel-center UV; world XYZ",
        "simplified": simplified,
    }


def _points(
    value: object, *, name: str, count: int, width: int, height: int
) -> list[tuple[float, float]]:
    if not isinstance(value, list) or len(value) != count:
        raise AnnotationError(f"{name} must contain the exact {count} editable vertices.")
    output: list[tuple[float, float]] = []
    for point_index, raw in enumerate(value):
        if not isinstance(raw, dict) or set(raw) != {"u", "v"}:
            raise AnnotationError(f"{name}[{point_index}] must contain exactly u and v.")
        coordinates: list[float] = []
        for axis, maximum in (("u", width - 1.0), ("v", height - 1.0)):
            item = raw[axis]
            if isinstance(item, bool) or not isinstance(item, (int, float)):
                raise AnnotationError(f"{name}[{point_index}].{axis} must be finite.")
            number = float(item)
            if not math.isfinite(number) or not 0 <= number <= maximum:
                raise AnnotationError(
                    f"{name}[{point_index}].{axis} lies outside the selected image plane."
                )
            coordinates.append(number)
        point = (coordinates[0], coordinates[1])
        if output and point == output[-1]:
            raise AnnotationError(f"{name} cannot contain adjacent duplicate vertices.")
        output.append(point)
    if len(set(output)) < 3:
        raise AnnotationError(f"{name} must contain at least three distinct vertices.")
    if not _simple_polygon(output):
        raise AnnotationError(f"{name} cannot self-intersect.")
    twice_area = abs(
        sum(
            u * output[(point_index + 1) % len(output)][1]
            - output[(point_index + 1) % len(output)][0] * v
            for point_index, (u, v) in enumerate(output)
        )
    )
    if twice_area <= 1e-9:
        raise AnnotationError(f"{name} must enclose non-zero area.")
    return output


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


def _simple_polygon(points: list[tuple[float, float]]) -> bool:
    count = len(points)
    for first in range(count):
        first_end = (first + 1) % count
        for second in range(first + 1, count):
            second_end = (second + 1) % count
            if first == second or first_end == second or second_end == first:
                continue
            values = (
                _orientation(points[first], points[first_end], points[second]),
                _orientation(points[first], points[first_end], points[second_end]),
                _orientation(points[second], points[second_end], points[first]),
                _orientation(points[second], points[second_end], points[first_end]),
            )
            epsilon = 1e-9
            crosses = (
                (values[0] > epsilon and values[1] < -epsilon)
                or (values[0] < -epsilon and values[1] > epsilon)
            ) and (
                (values[2] > epsilon and values[3] < -epsilon)
                or (values[2] < -epsilon and values[3] > epsilon)
            )
            touches = any(
                abs(value) <= epsilon and _on_segment(start, point, end)
                for value, start, point, end in (
                    (values[0], points[first], points[second], points[first_end]),
                    (values[1], points[first], points[second_end], points[first_end]),
                    (values[2], points[second], points[first], points[second_end]),
                    (values[3], points[second], points[first_end], points[second_end]),
                )
            )
            if crosses or touches:
                return False
    return True


def _polygon_mask(points: list[tuple[float, float]], shape: tuple[int, int]) -> np.ndarray:
    vertices = np.asarray([[v, u] for u, v in points], dtype=np.float64)
    return polygon2mask(shape, vertices)


def move_boundary_vertex(
    labels: np.ndarray,
    geometry: Geometry,
    operation: dict[str, Any],
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Move exactly one canonical outer handle and change only its local polygon delta."""

    expected_keys = {
        "op",
        "expected_input_sha256",
        "plane",
        "index",
        "label",
        "source_vertices",
        "vertices",
    }
    if not isinstance(operation, dict) or set(operation) != expected_keys:
        raise AnnotationError(
            "move_boundary_vertex must contain exactly op, expected_input_sha256, plane, "
            "index, label, source_vertices, and vertices."
        )
    if operation["op"] != "move_boundary_vertex":
        raise AnnotationError("Expected a move_boundary_vertex correction.")
    array = validate_array(
        labels,
        geometry=geometry,
        labels=True,
        working_bytes=working_bytes,
        bytes_per_voxel=96,
    )
    if array.dtype != np.dtype(np.uint32):
        raise AnnotationError("Correction labels must use uint32 without narrowing or relabeling.")
    input_hash = label_array_sha256(array)
    if operation["expected_input_sha256"] != input_hash:
        raise AnnotationError("move_boundary_vertex is stale for the current label array.")
    boundary = editable_instance_boundary(
        array,
        geometry,
        plane=operation["plane"],
        index=operation["index"],
        label=operation["label"],
        working_bytes=working_bytes,
    )
    view, plane, index, width, height, axes = _plane(
        array, geometry, operation["plane"], operation["index"]
    )
    canonical = [(point["u"], point["v"]) for point in boundary["vertices_uv"]]
    source = _points(
        operation["source_vertices"],
        name="source_vertices",
        count=len(canonical),
        width=width,
        height=height,
    )
    if source != canonical:
        raise AnnotationError("source_vertices do not match the current exact label boundary.")
    edited = _points(
        operation["vertices"],
        name="vertices",
        count=len(canonical),
        width=width,
        height=height,
    )
    changed_indices = [
        position
        for position, pair in enumerate(zip(source, edited, strict=True))
        if pair[0] != pair[1]
    ]
    if len(changed_indices) != 1:
        raise AnnotationError(
            "Move exactly one vertex from the editable boundary returned by Loci."
        )
    source_mask = _polygon_mask(source, view.shape)
    edited_mask = _polygon_mask(edited, view.shape)
    delta = source_mask ^ edited_mask
    target = boundary["label"]
    additions = delta & edited_mask
    collisions = {int(value) for value in np.unique(view[additions]) if value not in {0, target}}
    if collisions:
        raise AnnotationError("The moved boundary would overwrite an unrelated label.")
    corrected = np.array(array, dtype=np.uint32, order="C", copy=True)
    corrected_view, *_ = _plane(corrected, geometry, plane, index)
    removals = delta & source_mask & (corrected_view == target)
    corrected_view[removals] = 0
    corrected_view[additions] = target
    changed = int(np.count_nonzero(view != corrected_view))
    if changed == 0:
        raise AnnotationError("The moved boundary vertex is a no-op at label resolution.")
    remaining = corrected_view == target
    if (
        not remaining.any()
        or ndi.label(remaining, structure=ndi.generate_binary_structure(2, 2))[1] != 1
    ):
        raise AnnotationError("The moved boundary must leave the selected plane label connected.")
    changed_index = changed_indices[0]
    source_world = _world(geometry, [source[changed_index]], plane, index)[0]
    edited_world = _world(geometry, [edited[changed_index]], plane, index)[0]
    output_hash = label_array_sha256(corrected)
    corrected.setflags(write=False)
    record = {
        "op": "move_boundary_vertex",
        "plane": plane,
        "index": index,
        "plane_axes_uv": list(axes),
        "label": target,
        "source_vertices_uv": [[u, v] for u, v in source],
        "vertices_uv": [[u, v] for u, v in edited],
        "moved_vertex_index": changed_index,
        "source_vertex_uv": list(source[changed_index]),
        "destination_vertex_uv": list(edited[changed_index]),
        "source_vertex_world_xyz": source_world,
        "destination_vertex_world_xyz": edited_world,
        "distance_unit": geometry.unit,
        "world_frame": geometry.frame,
        "input_labels_sha256": input_hash,
        "output_labels_sha256": output_hash,
        "changed_voxels": changed,
        "local_delta_voxels": int(np.count_nonzero(delta)),
    }
    return corrected, {
        "schema_version": "1.0",
        "input_labels_sha256": input_hash,
        "output_labels_sha256": output_hash,
        "dtype": "uint32",
        "shape": list(corrected.shape),
        "array_axes": geometry.axes,
        "geometry": geometry.to_dict(),
        "geometry_sha256": geometry_sha256(geometry),
        "coordinate_convention": "zero-based-voxel-center; array YX or ZYX; world XYZ",
        "operation_count": 1,
        "operations": [record],
        "input_mutation": "none-derived-copy",
        "scientific_validation": "unvalidated-research-annotation",
    }
