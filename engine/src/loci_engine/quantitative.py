"""Bounded, deterministic scalar image operations with explicit physical geometry.

Arrays are YX or ZYX, never RGB samples disguised as biological channels. Display
mapping is deliberately absent. Every operation creates derived values; callers
own immutable source identity, persisted recipes and revision-bound review.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.filters import threshold_otsu
from skimage.morphology import h_maxima
from skimage.segmentation import watershed

DEFAULT_WORKING_BYTES = 512 * 1024 * 1024
MAX_OBJECTS = 100_000


def finite_number(value: Any, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or not low <= result <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return result


def integer(value: Any, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer between {low} and {high}")
    return value


def exact_keys(values: Any, accepted: set[str], name: str) -> dict[str, Any]:
    if not isinstance(values, dict) or set(values) - accepted:
        raise ValueError(f"Invalid or unknown {name} fields")
    return values


@dataclass(frozen=True)
class Geometry:
    """A voxel-center affine from XYZ voxel indices to declared world coordinates.

    Spatial arrays use YX/ZYX. The columns of the affine are X, Y, Z directions.
    Units are explicit; 'pixel' is uncalibrated. Oblique orthogonal grids are
    supported. Sheared grids need resampling before Euclidean morphology.
    """

    axes: str
    affine: tuple[tuple[float, ...], ...]
    unit: str = "pixel"
    frame: str = "image"

    def __post_init__(self) -> None:
        if self.axes not in {"YX", "ZYX"}:
            raise ValueError("Scalar spatial axes must be YX or ZYX")
        matrix = np.asarray(self.affine, dtype=np.float64)
        if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
            raise ValueError("Geometry requires a finite 4 x 4 affine")
        if not np.array_equal(matrix[3], [0, 0, 0, 1]):
            raise ValueError("Geometry affine last row must be [0, 0, 0, 1]")
        if abs(np.linalg.det(matrix[:3, :3])) < 1e-15:
            raise ValueError("Geometry affine must be invertible")
        if self.unit not in {"pixel", "um", "mm", "nm", "m"}:
            raise ValueError("Geometry units must be pixel, nm, um, mm or m")
        if self.frame not in {"image", "RAS", "LPS"}:
            raise ValueError("Geometry frame must be image, RAS or LPS")

    @classmethod
    def diagonal(cls, spacing: tuple[float, ...], unit: str = "pixel") -> Geometry:
        if len(spacing) not in {2, 3}:
            raise ValueError("Spacing must follow YX or ZYX")
        values = [finite_number(v, "spacing", 1e-9, 1e9) for v in spacing]
        matrix = np.eye(4)
        for axis, value in enumerate(reversed(values)):
            matrix[axis, axis] = value
        return cls("YX" if len(values) == 2 else "ZYX", tuple(map(tuple, matrix)), unit)

    @property
    def spacing(self) -> tuple[float, ...]:
        lengths = np.linalg.norm(np.asarray(self.affine)[:3, :3], axis=0)
        return tuple(float(v) for v in lengths[: len(self.axes)][::-1])

    def orthogonal_spacing(self) -> tuple[float, ...]:
        basis = np.asarray(self.affine)[:3, :3]
        directions = basis / np.linalg.norm(basis, axis=0)
        if not np.allclose(directions.T @ directions, np.eye(3), atol=1e-7, rtol=0):
            raise ValueError("This operation requires an orthogonal grid; resample shear first")
        return self.spacing

    def world(self, coordinates: np.ndarray) -> np.ndarray:
        points = np.asarray(coordinates, dtype=np.float64)
        if points.ndim != 2 or points.shape[1] != len(self.axes):
            raise ValueError("Coordinates must follow the declared spatial axes")
        xyz = np.zeros((len(points), 4), dtype=np.float64)
        xyz[:, : len(self.axes)] = points[:, ::-1]
        xyz[:, 3] = 1
        return (xyz @ np.asarray(self.affine).T)[:, :3]

    def cropped(self, start: tuple[int, ...]) -> Geometry:
        matrix = np.array(self.affine)
        matrix[:3, 3] = self.world(np.array([start]))[0]
        return Geometry(self.axes, tuple(map(tuple, matrix)), self.unit, self.frame)

    def to_dict(self) -> dict[str, Any]:
        return {"axes": self.axes, "affine": self.affine, "unit": self.unit, "frame": self.frame}


def validate_array(
    image: np.ndarray,
    *,
    geometry: Geometry | None = None,
    labels: bool = False,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    bytes_per_voxel: int = 64,
) -> np.ndarray:
    array = np.asarray(image)
    integer(working_bytes, "working_bytes", 1024, 8 * 1024**3)
    if array.ndim not in {2, 3} or any(n < 1 for n in array.shape):
        raise ValueError("Expected a nonempty scalar YX or ZYX array")
    if geometry is not None and array.ndim != len(geometry.axes):
        raise ValueError("Array and declared geometry axes disagree")
    if array.dtype.kind not in "buif" or array.dtype.itemsize > 8:
        raise ValueError("Only real boolean/integer/float scalar arrays are supported")
    if array.size * max(bytes_per_voxel, array.dtype.itemsize) > working_bytes:
        raise ValueError("Selection exceeds the operation working-memory budget; choose a crop")
    if not np.isfinite(array).all():
        raise ValueError("Non-finite image values are unsupported; choose an explicit valid crop")
    if labels and (array.dtype.kind not in "ui" or np.any(array < 0)):
        raise ValueError("Labels must be non-negative integers; zero is background")
    if (
        not labels
        and array.dtype.kind in "ui"
        and (int(array.min()) < -(2**53) or int(array.max()) > 2**53)
    ):
        raise ValueError("Integer intensities above 2^53 cannot be represented exactly as float64")
    if not labels and np.any(np.abs(array.astype(np.float64)) > 1e30):
        raise ValueError("Intensity magnitude exceeds the quantitative range of 1e30")
    return array


def _footprint(radius: float, spacing: tuple[float, ...]) -> np.ndarray:
    extents = [int(math.ceil(radius / step)) for step in spacing]
    if math.prod(2 * e + 1 for e in extents) > 1_000_000:
        raise ValueError("Morphology footprint is too large; reduce physical radius")
    grid = np.ogrid[tuple(slice(-e, e + 1) for e in extents)]
    distance = sum((values * step) ** 2 for values, step in zip(grid, spacing, strict=True))
    return np.asarray(distance <= radius**2)


def process_scalar(
    image: np.ndarray,
    geometry: Geometry,
    steps: list[dict[str, Any]],
    *,
    flatfield: np.ndarray | None = None,
    darkfield: np.ndarray | None = None,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """Execute an explicit float64 recipe, preserving raw array and value scale."""
    raw = validate_array(image, geometry=geometry, working_bytes=working_bytes)
    if not isinstance(steps, list) or len(steps) > 32:
        raise ValueError("A recipe must contain at most 32 processing steps")
    spacing = geometry.orthogonal_spacing()
    result = raw.astype(np.float64, copy=True)
    records: list[dict[str, Any]] = []
    for step in steps:
        exact_keys(step, {"op", "sigma", "radius", "value", "clip_negative"}, "processing")
        op = step.get("op")
        record: dict[str, Any] = {"op": op, "input_basis": "preceding-derived-or-raw"}
        allowed = {
            "gaussian": {"op", "sigma"},
            "subtract_background": {"op", "sigma", "clip_negative"},
            "subtract_constant": {"op", "value", "clip_negative"},
            "median": {"op", "radius"},
            "opening": {"op", "radius"},
            "closing": {"op", "radius"},
            "flatfield": {"op", "clip_negative"},
        }
        if op not in allowed:
            raise ValueError(f"Unknown scalar processing operation: {op}")
        exact_keys(step, allowed[op], str(op))
        if "clip_negative" in step and not isinstance(step["clip_negative"], bool):
            raise ValueError("clip_negative must be an explicit boolean")
        if op in {"gaussian", "subtract_background"}:
            sigma = finite_number(step.get("sigma"), "sigma", 0, 1e6)
            pixels = tuple(sigma / s for s in spacing)
            if max(pixels) > 256:
                raise ValueError("Gaussian sigma exceeds 256 voxels; choose a smaller scale")
            smooth = ndi.gaussian_filter(result, pixels, mode="reflect", truncate=4.0)
            result = smooth if op == "gaussian" else result - smooth
            record.update(sigma=sigma, sigma_voxels=pixels, unit=geometry.unit, boundary="reflect")
        elif op in {"median", "opening", "closing"}:
            radius = finite_number(step.get("radius"), "radius", 0, 1e6)
            footprint = _footprint(radius, spacing)
            operation = {
                "median": ndi.median_filter,
                "opening": ndi.grey_opening,
                "closing": ndi.grey_closing,
            }[op]
            result = operation(result, footprint=footprint, mode="reflect")
            record.update(radius=radius, unit=geometry.unit, boundary="reflect")
        elif op == "subtract_constant":
            value = finite_number(step.get("value"), "value", -1e15, 1e15)
            result -= value
            record["value"] = value
        elif op == "flatfield":
            if flatfield is None:
                raise ValueError("Flat-field correction requires a declared reference image")
            flat = validate_array(flatfield, geometry=geometry, working_bytes=working_bytes)
            dark = 0.0
            if darkfield is not None:
                dark = validate_array(darkfield, geometry=geometry, working_bytes=working_bytes)
                if dark.shape != raw.shape:
                    raise ValueError("Dark-field reference shape must match the selected image")
            if flat.shape != raw.shape:
                raise ValueError("Flat-field reference shape must match the selected image")
            illumination = flat.astype(np.float64) - dark
            if np.any(illumination <= 0):
                raise ValueError("Flat minus dark reference must be positive at every voxel")
            scale = float(np.mean(illumination))
            result = (result - dark) * scale / illumination
            record.update(formula="(image-dark)*mean(flat-dark)/(flat-dark)", scale=scale)
        if step.get("clip_negative", False):
            result = np.maximum(result, 0)
        if "clip_negative" in allowed[op]:
            record["clip_negative"] = step.get("clip_negative", False)
        if not np.isfinite(result).all():
            raise ValueError("Processing produced non-finite values; result was rejected")
        records.append(record)
    return result, records


def segment_scalar(
    image: np.ndarray,
    geometry: Geometry,
    settings: dict[str, Any],
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Threshold/components or distance watershed, in true 2D or true 3D."""
    raw = validate_array(image, geometry=geometry, working_bytes=working_bytes, bytes_per_voxel=96)
    exact_keys(
        settings,
        {"method", "threshold", "polarity", "min_size", "split_height", "exclude_border"},
        "segmentation",
    )
    method = settings.get("method", "components")
    if method not in {"components", "watershed"}:
        raise ValueError("Segmentation method must be components or watershed")
    polarity = settings.get("polarity", "bright")
    if polarity not in {"bright", "dark"}:
        raise ValueError("Polarity must be explicitly bright or dark")
    threshold = settings.get("threshold", "otsu")
    if threshold == "otsu":
        threshold = float(threshold_otsu(raw))
        threshold_method = "otsu-on-selected-scalar-array"
    else:
        threshold = finite_number(threshold, "threshold", -1e30, 1e30)
        threshold_method = "user-defined"
    mask = raw > threshold if polarity == "bright" else raw < threshold
    spacing = geometry.orthogonal_spacing()
    voxel_measure = float(np.prod(spacing))
    min_size = finite_number(settings.get("min_size", 0), "min_size", 0, 1e20)
    border = settings.get("exclude_border", False)
    if not isinstance(border, bool):
        raise ValueError("exclude_border must be boolean")
    connectivity = ndi.generate_binary_structure(raw.ndim, 1)
    if method == "watershed" and mask.any():
        height = finite_number(
            settings.get("split_height", min(spacing)),
            "split_height",
            1e-9,
            1e9,
        )
        # Padding gives an actual exterior background even when foreground fills
        # the crop, avoiding EDT's implicit asymmetric off-array convention.
        padded = np.pad(mask, 1, mode="constant")
        distances = ndi.distance_transform_edt(padded, sampling=spacing)
        distances = distances[tuple(slice(1, -1) for _ in mask.shape)]
        peaks = h_maxima(distances, height) & mask
        markers, _ = ndi.label(peaks, structure=connectivity)
        components, count = ndi.label(mask, structure=connectivity)
        # A component smaller than the requested height still needs one seed.
        next_id = int(markers.max()) + 1
        if count > MAX_OBJECTS:
            raise ValueError("Too many foreground components; choose a smaller crop")
        for component, region in enumerate(ndi.find_objects(components), 1):
            component_mask = components[region] == component
            local_markers = markers[region]
            if not np.any(local_markers[component_mask]):
                index = np.unravel_index(
                    np.argmax(np.where(component_mask, distances[region], -1)),
                    component_mask.shape,
                )
                local_markers[index] = next_id
                next_id += 1
        labels = watershed(-distances, markers, mask=mask, connectivity=connectivity)
    else:
        labels, _ = ndi.label(mask, structure=connectivity)
        height = None
    ids, counts = np.unique(labels, return_counts=True)
    removed = set(int(v) for v in ids[counts * voxel_measure < min_size])
    if border:
        for axis in range(labels.ndim):
            removed.update(int(v) for v in np.unique(np.take(labels, [0, -1], axis=axis)))
    if removed:
        labels[np.isin(labels, list(removed))] = 0
    labels = _compact_labels(labels)
    return labels, {
        "method": method,
        "dimensions": raw.ndim,
        "threshold": threshold,
        "threshold_method": threshold_method,
        "polarity": polarity,
        "connectivity": 1,
        "min_size": min_size,
        "size_unit": f"{geometry.unit}^{raw.ndim}",
        "split_height": height,
        "distance_unit": geometry.unit,
        "exclude_border": border,
        "count": int(labels.max()),
        "scientific_validation": "unvalidated-research-method",
    }


def _compact_labels(labels: np.ndarray) -> np.ndarray:
    ids = np.unique(labels)
    positive = ids[ids != 0]
    if len(positive) > MAX_OBJECTS:
        raise ValueError("Too many objects; choose a smaller region or revise the recipe")
    # Searchsorted scales with object count, not the largest external label ID.
    output = np.searchsorted(positive, labels).astype(np.uint32) + 1
    output[labels == 0] = 0
    return output


def measure_objects(
    labels: np.ndarray,
    geometry: Geometry,
    channels: dict[str, np.ndarray] | None = None,
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> list[dict[str, Any]]:
    labels = validate_array(labels, geometry=geometry, labels=True, working_bytes=working_bytes)
    channels = channels or {}
    if len(channels) > 32 or any(not isinstance(name, str) or not name for name in channels):
        raise ValueError("Use at most 32 named measurement channels")
    for name, channel in channels.items():
        validate_array(channel, geometry=geometry, working_bytes=working_bytes)
        if channel.shape != labels.shape:
            raise ValueError(f"Measurement channel shape disagrees with labels: {name}")
    ids = np.unique(labels)
    ids = ids[ids != 0]
    if len(ids) > MAX_OBJECTS:
        raise ValueError("Too many objects for this bounded measurement operation")
    # Compress solely for bounding-box lookup; retain original IDs (including
    # uint32 labels above 65535) in every public measurement row.
    compact = _compact_labels(labels)
    slices = ndi.find_objects(compact)
    basis = np.asarray(geometry.affine)[:3, : len(geometry.axes)]
    element_measure = float(np.sqrt(np.linalg.det(basis.T @ basis)))
    rows: list[dict[str, Any]] = []
    for index, (original_id, region) in enumerate(zip(ids, slices, strict=True), 1):
        local = compact[region] == index
        start = np.array([s.start for s in region])
        coordinates = np.argwhere(local) + start
        world = geometry.world(coordinates)
        center = coordinates.mean(axis=0)
        covariance = np.cov(world, rowvar=False, bias=True) if len(world) > 1 else np.zeros((3, 3))
        eigenvalues = np.maximum(np.linalg.eigvalsh(covariance), 0)
        row: dict[str, Any] = {
            "label": int(original_id),
            "voxel_count": int(len(coordinates)),
            "measure": float(len(coordinates) * element_measure),
            "measure_kind": "area" if labels.ndim == 2 else "volume",
            "measure_unit": f"{geometry.unit}^{labels.ndim}",
            "centroid_index": center.tolist(),
            "index_axes": geometry.axes,
            "centroid_world_xyz": world.mean(axis=0).tolist(),
            "world_frame": geometry.frame,
            "distance_unit": geometry.unit,
            "bbox_start": start.tolist(),
            "bbox_stop_exclusive": [s.stop for s in region],
            "principal_rms_radii": np.sqrt(eigenvalues[::-1]).tolist(),
            "touches_crop_border": any(
                s.start == 0 or s.stop == length
                for s, length in zip(region, labels.shape, strict=True)
            ),
            "intensity": {},
        }
        for name, values in channels.items():
            selected = values[region][local].astype(np.float64)
            row["intensity"][name] = {
                "mean": float(selected.mean()),
                "sum": float(selected.sum()),
                "min": float(selected.min()),
                "max": float(selected.max()),
                "std_population": float(selected.std()),
            }
        rows.append(row)
    if rows:
        centers = np.array([row["centroid_world_xyz"] for row in rows])
        distances = cKDTree(centers).query(centers, k=2)[0][:, 1] if len(rows) > 1 else [None]
        for row, distance in zip(rows, distances, strict=True):
            row["nearest_centroid_distance"] = None if distance is None else float(distance)
    return rows


def colocalisation(
    first: np.ndarray,
    second: np.ndarray,
    *,
    threshold_first: float,
    threshold_second: float,
    roi: np.ndarray | None = None,
) -> dict[str, Any]:
    """Descriptive Pearson r and thresholded Manders fractions, no pixel p-values."""
    first = validate_array(first)
    second = validate_array(second)
    if first.shape != second.shape:
        raise ValueError("Colocalisation channels must share exactly the same grid")
    a_threshold = finite_number(threshold_first, "threshold_first", 0, 1e30)
    b_threshold = finite_number(threshold_second, "threshold_second", 0, 1e30)
    if roi is not None:
        if roi.dtype != bool or roi.shape != first.shape:
            raise ValueError("Colocalisation ROI must be a boolean mask on the same grid")
        a, b = first[roi], second[roi]
    else:
        a, b = first.ravel(), second.ravel()
    if len(a) < 2 or np.any(a < 0) or np.any(b < 0):
        raise ValueError("Colocalisation requires at least two non-negative intensity pairs")
    a, b = a.astype(np.float64), b.astype(np.float64)
    a_mask, b_mask = a > a_threshold, b > b_threshold
    a_sum, b_sum = float(a[a_mask].sum()), float(b[b_mask].sum())
    a_delta, b_delta = a - a.mean(), b - b.mean()
    denominator = float(np.linalg.norm(a_delta) * np.linalg.norm(b_delta))
    return {
        "pearson_r": float(np.dot(a_delta, b_delta) / denominator) if denominator else None,
        "manders_first": float(a[a_mask & b_mask].sum() / a_sum) if a_sum else None,
        "manders_second": float(b[a_mask & b_mask].sum() / b_sum) if b_sum else None,
        "threshold_first": a_threshold,
        "threshold_second": b_threshold,
        "voxel_pairs": int(len(a)),
        "formula": "sum(A where A>ta and B>tb)/sum(A where A>ta); symmetric for B",
        "basis": "selected-unregistered-intensities",
        "assumptions": "registered channels, declared controls, non-negative intensities",
        "interpretation": (
            "descriptive spatial association; not molecular interaction or independent n"
        ),
    }


def associate_labels(nuclei: np.ndarray, cells: np.ndarray) -> list[dict[str, Any]]:
    """Largest observed overlap, with ambiguity and outside fraction retained."""
    nuclei = validate_array(nuclei, labels=True)
    cells = validate_array(cells, labels=True)
    if nuclei.shape != cells.shape:
        raise ValueError("Nucleus and cell labels must share exactly the same grid")
    ids = np.unique(nuclei)
    if len(ids) > MAX_OBJECTS + 1:
        raise ValueError("Too many nuclei for this bounded association")
    rows = []
    for label in ids[ids != 0]:
        values = cells[nuclei == label]
        candidates, counts = np.unique(values[values != 0], return_counts=True)
        if len(candidates):
            best = int(np.argmax(counts))
            cell = int(candidates[best])
            overlap = float(counts[best] / len(values))
        else:
            cell, overlap = None, 0.0
        rows.append(
            {
                "nucleus_label": int(label),
                "cell_label": cell,
                "overlap_fraction": overlap,
                "outside_fraction": float(np.count_nonzero(values == 0) / len(values)),
                "ambiguous": len(candidates) > 1,
                "candidate_cells": [int(v) for v in candidates],
                "rule": "largest-overlap; equal overlap resolves to lowest label ID",
            }
        )
    return rows


def apply_marker_gates(
    rows: list[dict[str, Any]],
    gates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Declared measurement rules; no inferred phenotype or diagnostic class."""
    if not isinstance(gates, list) or len(gates) > 64:
        raise ValueError("Use at most 64 marker gates")
    names: set[str] = set()
    for gate in gates:
        exact_keys(gate, {"name", "channel", "statistic", "threshold", "control"}, "marker gate")
        if any(
            not isinstance(gate.get(key), str) or not gate[key].strip()
            for key in ("name", "channel", "control")
        ):
            raise ValueError("Each gate requires a name, channel and control/assumption statement")
        if gate["name"] in names or gate.get("statistic", "mean") not in {"mean", "sum", "max"}:
            raise ValueError("Gate names must be unique and statistics mean, sum or max")
        names.add(gate["name"])
        finite_number(gate.get("threshold"), "gate threshold", -1e30, 1e30)
    output = []
    for row in rows:
        decisions = {}
        for gate in gates:
            try:
                value = row["intensity"][gate["channel"]][gate.get("statistic", "mean")]
            except KeyError as exc:
                raise ValueError("Gate references an unavailable channel measurement") from exc
            decisions[gate["name"]] = value > gate["threshold"]
        output.append({**row, "marker_gates": decisions})
    return output
