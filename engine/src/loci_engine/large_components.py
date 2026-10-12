"""Deterministic bounded YX components and measurements over regional readers."""

from __future__ import annotations

import math
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

from .quantitative import Geometry, finite_number

DEFAULT_WORKING_BYTES = 256 * 1024**2
MAX_PROVISIONAL = 1_000_000
MAX_OBJECTS = 100_000
MAX_CORES = 16_384
MAX_EDGE = 65_536
MAX_CORE = 512
_CONNECTIVITY = ndi.generate_binary_structure(2, 1)


def _checked_grid(
    shape: tuple[int, int] | list[int], geometry: Geometry, tile_size: int, working_bytes: int
) -> tuple[int, int]:
    if (
        not isinstance(shape, (tuple, list))
        or len(shape) != 2
        or any(type(value) is not int or not 1 <= value <= MAX_EDGE for value in shape)
    ):
        raise ValueError("Large components require a bounded nonempty YX grid")
    height, width = shape
    if height * width >= 2**32:
        raise ValueError("Large grid must contain fewer than 2^32 pixels")
    if type(tile_size) is not int or not 1 <= tile_size <= MAX_CORE:
        raise ValueError("Tile size must be between 1 and 512")
    if math.ceil(height / tile_size) * math.ceil(width / tile_size) > MAX_CORES:
        raise ValueError("Large grid exceeds the 16384-core envelope")
    if type(working_bytes) is not int or not 1024 <= working_bytes <= 8 * 1024**3:
        raise ValueError("Working byte budget must be between 1024 bytes and 8 GiB")
    if not isinstance(geometry, Geometry) or geometry.axes != "YX":
        raise ValueError("Large components require validated YX geometry")
    geometry.orthogonal_spacing()
    return height, width


def _core_positions(height: int, width: int, tile_size: int):
    for y in range(0, height, tile_size):
        for x in range(0, width, tile_size):
            yield y, x, min(tile_size, height - y), min(tile_size, width - x)


def _checked_array(
    value: Any, shape: tuple[int, int], dtypes: tuple[np.dtype, ...], name: str
) -> np.ndarray:
    array = np.asarray(value)
    if array.shape != shape or array.dtype not in dtypes:
        raise ValueError(f"{name} region has wrong YX shape or dtype")
    return array


def _roots(parent: np.ndarray, labels: np.ndarray) -> np.ndarray:
    output = labels.copy()
    for index in range(len(output)):
        value = int(output[index])
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = int(parent[value])
        output[index] = value
    return output


def _union(parent: np.ndarray, left: int, right: int) -> None:
    while parent[left] != left:
        parent[left] = parent[parent[left]]
        left = int(parent[left])
    while parent[right] != right:
        parent[right] = parent[parent[right]]
        right = int(parent[right])
    if left != right:
        # Root choice is irrelevant to scientific identity; first global pixel
        # determines the final label after all seams are reconciled.
        parent[max(left, right)] = min(left, right)


def stream_components(
    read_region: Callable[[int, int, int, int], np.ndarray],
    write_labels: Callable[[int, int, np.ndarray], None],
    shape: tuple[int, int] | list[int],
    geometry: Geometry,
    segmentation: dict[str, Any],
    *,
    work_dir: str | Path,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    tile_size: int = MAX_CORE,
    check: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Label native uint8/16 regions with global four-connected identity.

    Temporary global provisional cores are private to one owned directory and
    removed on success or failure. No full-grid array or mapping is created.
    """
    height, width = _checked_grid(shape, geometry, tile_size, working_bytes)
    if not isinstance(segmentation, dict) or set(segmentation) - {
        "method",
        "threshold",
        "polarity",
        "min_size",
        "exclude_border",
    }:
        raise ValueError("Unsupported large segmentation fields")
    if segmentation.get("method", "components") != "components":
        raise ValueError("Large route supports connected components only")
    threshold = finite_number(segmentation.get("threshold"), "threshold", -1e30, 1e30)
    polarity = segmentation.get("polarity", "bright")
    if polarity not in {"bright", "dark"}:
        raise ValueError("Large route requires bright or dark polarity")
    min_size = finite_number(segmentation.get("min_size", 0), "min_size", 0, 1e20)
    exclude_border = segmentation.get("exclude_border", False)
    if type(exclude_border) is not bool:
        raise ValueError("exclude_border must be boolean")
    spacing = geometry.orthogonal_spacing()
    pixel_area = float(spacing[0] * spacing[1])
    directory = Path(work_dir)
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise ValueError("Working directory must be an existing plain absolute directory")
    if check:
        check()
    # Fixed-capacity numeric state, separately bounding provisional and final IDs.
    capacity = min(MAX_PROVISIONAL, height * width)
    core_pixels = min(tile_size, height) * min(tile_size, width)
    if capacity * 64 + core_pixels * 96 > working_bytes:
        raise ValueError("Provisional components exceed the numerical working-memory budget")
    parent = np.arange(capacity + 1, dtype=np.uint32)
    sizes = np.zeros(capacity + 1, dtype=np.uint64)
    first = np.full(capacity + 1, np.iinfo(np.uint64).max, dtype=np.uint64)
    border = np.zeros(capacity + 1, dtype=np.bool_)
    columns = math.ceil(width / tile_size)
    above: list[np.ndarray | None] = [None] * columns
    next_id = 1
    with tempfile.TemporaryDirectory(prefix=".components-", dir=directory) as owned:
        temporary = Path(owned)
        paths: list[tuple[int, int, Path]] = []
        for y in range(0, height, tile_size):
            left_edge: np.ndarray | None = None
            for column, x in enumerate(range(0, width, tile_size)):
                if check:
                    check()
                core_shape = (min(tile_size, height - y), min(tile_size, width - x))
                raw = _checked_array(
                    read_region(y, x, *core_shape),
                    core_shape,
                    (np.dtype("uint8"), np.dtype("uint16")),
                    "Raw source",
                )
                mask = raw > threshold if polarity == "bright" else raw < threshold
                local, count = ndi.label(mask, structure=_CONNECTIVITY)
                if next_id + count - 1 > capacity:
                    raise ValueError(
                        "Too many provisional components; reduce fragmentation or scope"
                    )
                if count:
                    active, indexes, counts = np.unique(
                        local.ravel(), return_index=True, return_counts=True
                    )
                    foreground = active != 0
                    active, indexes, counts = (
                        active[foreground],
                        indexes[foreground],
                        counts[foreground],
                    )
                    if len(active) != count or not np.array_equal(active, np.arange(1, count + 1)):
                        raise ValueError("Local component identities are incomplete")
                    identifiers = next_id + active - 1
                    sizes[identifiers] = counts.astype(np.uint64)
                    first[identifiers] = (
                        (y + indexes // core_shape[1]).astype(np.uint64) * width
                        + x
                        + indexes % core_shape[1]
                    )
                    provisional = local.astype(np.uint32, copy=False)
                    provisional[provisional > 0] += np.uint32(next_id - 1)
                    next_id += count
                else:
                    provisional = local.astype(np.uint32, copy=False)
                if y == 0:
                    border[provisional[0]] = True
                if y + core_shape[0] == height:
                    border[provisional[-1]] = True
                if x == 0:
                    border[provisional[:, 0]] = True
                if x + core_shape[1] == width:
                    border[provisional[:, -1]] = True
                if left_edge is not None:
                    for a, b in zip(left_edge, provisional[:, 0], strict=True):
                        if a and b:
                            _union(parent, int(a), int(b))
                if above[column] is not None:
                    for a, b in zip(above[column], provisional[0], strict=True):
                        if a and b:
                            _union(parent, int(a), int(b))
                left_edge = provisional[:, -1].copy()
                above[column] = provisional[-1].copy()
                path = temporary / f"{y:05d}-{x:05d}.npy"
                np.save(path, provisional, allow_pickle=False)
                paths.append((y, x, path))
        if check:
            check()
        identities = np.arange(1, next_id, dtype=np.uint32)
        root = _roots(parent, identities)
        root_sizes = np.zeros(next_id, dtype=np.uint64)
        root_first = np.full(next_id, np.iinfo(np.uint64).max, dtype=np.uint64)
        root_border = np.zeros(next_id, dtype=np.bool_)
        np.add.at(root_sizes, root, sizes[1:next_id])
        np.minimum.at(root_first, root, first[1:next_id])
        np.logical_or.at(root_border, root, border[1:next_id])
        root_ids = np.flatnonzero(root_sizes[1:]) + 1
        eligible = root_sizes[root_ids] * pixel_area >= min_size
        if exclude_border:
            eligible &= ~root_border[root_ids]
        kept = root_ids[eligible]
        kept = kept[np.argsort(root_first[kept], kind="stable")]
        if len(kept) > MAX_OBJECTS:
            raise ValueError("Too many final objects; reduce fragmentation or scope")
        final_for_root = np.zeros(next_id, dtype=np.uint32)
        final_for_root[kept] = np.arange(1, len(kept) + 1, dtype=np.uint32)
        final_for_provisional = np.zeros(next_id, dtype=np.uint32)
        final_for_provisional[1:] = final_for_root[root]
        for y, x, path in paths:
            if check:
                check()
            provisional = np.load(path, allow_pickle=False, max_header_size=16384)
            expected_shape = (min(tile_size, height - y), min(tile_size, width - x))
            if (
                provisional.dtype != np.uint32
                or provisional.shape != expected_shape
                or (provisional.size and int(provisional.max()) >= next_id)
            ):
                raise ValueError("Temporary component core is invalid")
            final = final_for_provisional[provisional]
            write_labels(y, x, final)
        if check:
            check()
    return {
        "method": "components",
        "dimensions": 2,
        "threshold": threshold,
        "threshold_method": "user-defined",
        "polarity": polarity,
        "connectivity": 1,
        "min_size": min_size,
        "size_unit": f"{geometry.unit}^2",
        "split_height": None,
        "distance_unit": geometry.unit,
        "exclude_border": exclude_border,
        "count": int(len(kept)),
        "provisional_count": int(next_id - 1),
        "tile_size": tile_size,
        "scientific_validation": "unvalidated-research-method",
    }


def _combine(
    count: np.ndarray,
    mean: np.ndarray,
    m2: np.ndarray,
    slot: int,
    values: np.ndarray,
) -> None:
    number = len(values)
    incoming_mean = float(values.mean(dtype=np.float64))
    incoming_m2 = float(np.square(values.astype(np.float64) - incoming_mean).sum())
    old = int(count[slot])
    if not old:
        count[slot], mean[slot], m2[slot] = number, incoming_mean, incoming_m2
    else:
        total = old + number
        delta = incoming_mean - mean[slot]
        m2[slot] += incoming_m2 + delta * delta * old * number / total
        mean[slot] += delta * number / total
        count[slot] = total


def measure_tiled(
    read_labels: Callable[[int, int, int, int], np.ndarray],
    read_image: Callable[[int, int, int, int], np.ndarray],
    shape: tuple[int, int] | list[int],
    geometry: Geometry,
    channel_name: str,
    write_row: Callable[[dict[str, Any]], None],
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    tile_size: int = MAX_CORE,
    check: Callable[[], None] | None = None,
) -> int:
    """Stream canonical quantitative rows for sparse uint32 result labels."""
    height, width = _checked_grid(shape, geometry, tile_size, working_bytes)
    if not isinstance(channel_name, str) or not channel_name or len(channel_name) > 256:
        raise ValueError("Measurement channel name is invalid")
    if check:
        check()
    ids: set[int] = set()
    for y, x, h, w in _core_positions(height, width, tile_size):
        if check:
            check()
        labels = _checked_array(read_labels(y, x, h, w), (h, w), (np.dtype("uint32"),), "Label")
        ids.update(int(value) for value in np.unique(labels) if value)
        if len(ids) > MAX_OBJECTS:
            raise ValueError("Too many objects for bounded tiled measurement")
    ordered = np.array(sorted(ids), dtype=np.uint32)
    objects = len(ordered)
    if not objects:
        return 0
    core_pixels = min(tile_size, height) * min(tile_size, width)
    if objects * 256 + core_pixels * 128 > working_bytes:
        raise ValueError("Object measurements exceed the numerical working-memory budget")
    # Compact slots, independent of sparse uint32 label magnitude.
    count = np.zeros(objects, dtype=np.uint64)
    sum_raw = np.zeros(objects, dtype=np.uint64)
    mean_y = np.zeros(objects, dtype=np.float64)
    mean_x = np.zeros(objects, dtype=np.float64)
    m2_y = np.zeros(objects, dtype=np.float64)
    m2_x = np.zeros(objects, dtype=np.float64)
    cross_yx = np.zeros(objects, dtype=np.float64)
    mean_intensity = np.zeros(objects, dtype=np.float64)
    m2_intensity = np.zeros(objects, dtype=np.float64)
    min_intensity = np.full(objects, np.iinfo(np.uint16).max, dtype=np.uint16)
    max_intensity = np.zeros(objects, dtype=np.uint16)
    top = np.full(objects, height, dtype=np.uint32)
    left = np.full(objects, width, dtype=np.uint32)
    bottom = np.zeros(objects, dtype=np.uint32)
    right = np.zeros(objects, dtype=np.uint32)
    for y, x, h, w in _core_positions(height, width, tile_size):
        if check:
            check()
        labels = _checked_array(read_labels(y, x, h, w), (h, w), (np.dtype("uint32"),), "Label")
        image = _checked_array(
            read_image(y, x, h, w), (h, w), (np.dtype("uint8"), np.dtype("uint16")), "Raw image"
        )
        flat = labels.ravel()
        pixels = np.flatnonzero(flat)
        if not len(pixels):
            continue
        active = flat[pixels]
        slots = np.searchsorted(ordered, active)
        if np.any(slots >= objects) or not np.array_equal(ordered[slots], active):
            raise ValueError("Label identity changed between measurement passes")
        permutation = np.argsort(slots, kind="stable")
        sorted_slots = slots[permutation]
        sorted_pixels = pixels[permutation]
        breaks = np.r_[0, np.flatnonzero(np.diff(sorted_slots)) + 1, len(sorted_slots)]
        for start, stop in zip(breaks[:-1], breaks[1:], strict=True):
            slot = int(sorted_slots[start])
            positions = sorted_pixels[start:stop]
            ys = (positions // w + y).astype(np.float64)
            xs = (positions % w + x).astype(np.float64)
            raw = image.ravel()[positions]
            number = len(positions)
            old = int(count[slot])
            group_y, group_x = float(ys.mean()), float(xs.mean())
            dy, dx = ys - group_y, xs - group_x
            group_m2_y = float(np.dot(dy, dy))
            group_m2_x = float(np.dot(dx, dx))
            group_cross = float(np.dot(dy, dx))
            _combine(count, mean_intensity, m2_intensity, slot, raw)
            if not old:
                mean_y[slot], mean_x[slot] = group_y, group_x
                m2_y[slot], m2_x[slot] = group_m2_y, group_m2_x
                cross_yx[slot] = group_cross
            else:
                total = old + number
                delta_y, delta_x = group_y - mean_y[slot], group_x - mean_x[slot]
                factor = old * number / total
                m2_y[slot] += group_m2_y + delta_y * delta_y * factor
                m2_x[slot] += group_m2_x + delta_x * delta_x * factor
                cross_yx[slot] += group_cross + delta_y * delta_x * factor
                mean_y[slot] += delta_y * number / total
                mean_x[slot] += delta_x * number / total
            sum_raw[slot] += raw.sum(dtype=np.uint64)
            min_intensity[slot] = min(int(min_intensity[slot]), int(raw.min()))
            max_intensity[slot] = max(int(max_intensity[slot]), int(raw.max()))
            top[slot] = min(int(top[slot]), int(ys.min()))
            left[slot] = min(int(left[slot]), int(xs.min()))
            bottom[slot] = max(int(bottom[slot]), int(ys.max()) + 1)
            right[slot] = max(int(right[slot]), int(xs.max()) + 1)
    if np.any(count == 0):
        raise ValueError("Label identity disappeared between measurement passes")
    matrix = np.asarray(geometry.affine, dtype=np.float64)
    basis = matrix[:3, [1, 0]]
    pixel_measure = float(np.sqrt(np.linalg.det(basis.T @ basis)))
    centers_index = np.column_stack((mean_y, mean_x))
    centers_world = geometry.world(centers_index)
    distances = cKDTree(centers_world).query(centers_world, k=2)[0][:, 1] if objects > 1 else [None]
    for slot, label in enumerate(ordered):
        if check and slot % 200 == 0:
            check()
        n = int(count[slot])
        covariance = np.array([[m2_y[slot], cross_yx[slot]], [cross_yx[slot], m2_x[slot]]]) / n
        world_covariance = basis @ covariance @ basis.T
        eigenvalues = np.maximum(np.linalg.eigvalsh(world_covariance), 0)
        row = {
            "label": int(label),
            "voxel_count": n,
            "measure": float(n * pixel_measure),
            "measure_kind": "area",
            "measure_unit": f"{geometry.unit}^2",
            "centroid_index": [float(mean_y[slot]), float(mean_x[slot])],
            "index_axes": "YX",
            "centroid_world_xyz": centers_world[slot].tolist(),
            "world_frame": geometry.frame,
            "distance_unit": geometry.unit,
            "bbox_start": [int(top[slot]), int(left[slot])],
            "bbox_stop_exclusive": [int(bottom[slot]), int(right[slot])],
            "principal_rms_radii": np.sqrt(eigenvalues[::-1]).tolist(),
            "touches_crop_border": bool(
                top[slot] == 0 or left[slot] == 0 or bottom[slot] == height or right[slot] == width
            ),
            "intensity": {
                channel_name: {
                    "mean": float(sum_raw[slot] / n),
                    "sum": float(sum_raw[slot]),
                    "min": float(min_intensity[slot]),
                    "max": float(max_intensity[slot]),
                    "std_population": float(math.sqrt(max(0.0, m2_intensity[slot] / n))),
                }
            },
            "nearest_centroid_distance": None if objects == 1 else float(distances[slot]),
        }
        write_row(row)
    if check:
        check()
    return objects
