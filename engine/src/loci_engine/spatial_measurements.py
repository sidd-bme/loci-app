"""Bounded distances to declared boundary pixel centers on a physical YX grid.

These are discrete spatial measurements, not an anatomical boundary detector or
a thickness estimate. Label centroids are measured directly against the boundary
centers; compartment area is assigned using distances at compartment pixel centers.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from numbers import Real
from typing import Any

import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

from .quantitative import (
    DEFAULT_WORKING_BYTES,
    MAX_OBJECTS,
    MAX_WORKING_BYTES,
    Geometry,
    integer,
    validate_array,
)


def _checked_edges(band_edges: Sequence[float]) -> np.ndarray:
    if not isinstance(band_edges, (list, tuple, np.ndarray)):
        raise ValueError("band_edges must be a sequence of 2 to 33 physical distances")
    if isinstance(band_edges, np.ndarray) and band_edges.ndim != 1:
        raise ValueError("band_edges must be one dimensional")
    if not 2 <= len(band_edges) <= 33:
        raise ValueError("Choose between 1 and 32 distance bands")
    values = []
    for value in band_edges:
        if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
            raise ValueError("Band edges must be finite nonnegative numbers")
        number = float(value)
        if not math.isfinite(number) or number < 0:
            raise ValueError("Band edges must be finite nonnegative numbers")
        if values and number <= values[-1]:
            raise ValueError("Band edges must be strictly increasing")
        values.append(number)
    return np.array(values, dtype=np.float64)


def estimated_working_bytes(pixel_count: int) -> int:
    """Conservative kernel workspace including bounded Python object rows."""
    return pixel_count * 192 + min(pixel_count, MAX_OBJECTS) * 1024 + 4096


def measure_distance_bands(
    labels: np.ndarray,
    compartment_mask: np.ndarray,
    boundary_mask: np.ndarray,
    geometry: Geometry,
    band_edges: Sequence[float],
    *,
    exclude_crop_border: bool = True,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], np.ndarray]:
    """Return object rows, compartment band summaries, and uint32 band labels.

    ``band_index`` is zero based for counted objects and None for excluded ones.
    Band labels are index + 1, with zero outside the compartment or supplied
    half-open intervals [lower, upper). Distances have ``geometry.unit`` units;
    area and density have squared units and objects per squared unit. An object
    comprises all pixels with its sparse nonzero label. Any labeled crop-edge
    pixel excludes that object when ``exclude_crop_border`` is enabled.

    Centroid compartment membership uses floor(coordinate + 0.5), choosing the
    increasing array index at exact half-pixel ties. An excluded object's direct
    boundary distance is retained, together with every applicable exclusion.
    """
    integer(working_bytes, "working_bytes", 1024, MAX_WORKING_BYTES)
    if not isinstance(exclude_crop_border, bool):
        raise ValueError("exclude_crop_border must be an explicit boolean")
    if not isinstance(geometry, Geometry) or geometry.axes != "YX":
        raise ValueError("Distance bands require an explicit physical YX geometry")
    if geometry.unit == "pixel":
        raise ValueError("Distance bands require physical calibration, not pixel units")
    if not isinstance(labels, np.ndarray) or labels.ndim != 2:
        raise ValueError("Labels must be a nonempty YX NumPy array")
    for mask, name in ((compartment_mask, "compartment"), (boundary_mask, "boundary")):
        if not isinstance(mask, np.ndarray) or mask.dtype != np.bool_ or mask.shape != labels.shape:
            raise ValueError(f"The {name} mask must be boolean on the exact label YX grid")
    edges = _checked_edges(band_edges)
    # Includes EDT work arrays, compact inverse labels, coordinate/tree storage,
    # and conservative Python row overhead. Check before pixel-sized allocations,
    # including validate_array's finite-value checks and unique-label discovery.
    estimated_bytes = estimated_working_bytes(labels.size)
    if estimated_bytes > working_bytes:
        raise ValueError("Distance bands exceed the working-memory budget; choose a crop")
    array = validate_array(
        labels,
        geometry=geometry,
        labels=True,
        working_bytes=working_bytes,
        bytes_per_voxel=192,
    )
    if int(array.max()) > np.iinfo(np.uint32).max:
        raise ValueError("Label IDs must fit uint32 without remapping")
    if not boundary_mask.any():
        raise ValueError("The declared boundary must contain at least one pixel center")
    with np.errstate(over="ignore", invalid="ignore"):
        spacing = geometry.orthogonal_spacing()
    pixel_area = math.prod(spacing)
    if (
        not all(math.isfinite(step) and step > 0 for step in spacing)
        or not math.isfinite(pixel_area)
        or pixel_area <= 0
    ):
        raise ValueError("Physical grid spacing and pixel area must be finite and positive")

    ids, inverse, counts = np.unique(array, return_inverse=True, return_counts=True)
    object_indices = np.flatnonzero(ids != 0)
    if len(object_indices) > MAX_OBJECTS:
        raise ValueError("Distance bands support at most 100000 objects")
    inverse = inverse.reshape(array.shape)
    band_count = len(edges) - 1
    pixel_distances = ndi.distance_transform_edt(~boundary_mask, sampling=spacing)
    if not np.isfinite(pixel_distances).all():
        raise ValueError("Physical boundary distances exceed the finite numerical range")
    pixel_bands = np.searchsorted(edges, pixel_distances, side="right") - 1
    included = compartment_mask & (pixel_bands >= 0) & (pixel_bands < band_count)
    band_labels = np.zeros(array.shape, dtype=np.uint32)
    band_labels[included] = (pixel_bands[included] + 1).astype(np.uint32)
    pixel_counts = np.bincount(band_labels.ravel(), minlength=band_count + 1)[1:]
    del pixel_distances, pixel_bands, included

    rows: list[dict[str, Any]] = []
    object_counts = [0] * band_count
    if len(object_indices):
        flat_inverse = inverse.ravel()
        sum_y = np.bincount(
            flat_inverse,
            weights=np.repeat(np.arange(array.shape[0], dtype=np.float64), array.shape[1]),
            minlength=len(ids),
        )
        sum_x = np.bincount(
            flat_inverse,
            weights=np.tile(np.arange(array.shape[1], dtype=np.float64), array.shape[0]),
            minlength=len(ids),
        )
        centers = np.column_stack((sum_y[object_indices], sum_x[object_indices]))
        centers /= counts[object_indices, None]
        boundary_centers = np.column_stack(np.nonzero(boundary_mask)).astype(np.float64)
        boundary_centers *= spacing
        distances = cKDTree(boundary_centers).query(centers * spacing, k=1, workers=1)[0]
        if not np.isfinite(distances).all():
            raise ValueError("Physical centroid distances exceed the finite numerical range")
        center_pixels = np.floor(centers + 0.5).astype(np.int64)
        membership = compartment_mask[center_pixels[:, 0], center_pixels[:, 1]]
        at_crop_border = np.zeros(len(ids), dtype=bool)
        if exclude_crop_border:
            border_indices = np.concatenate(
                (inverse[0], inverse[-1], inverse[:, 0], inverse[:, -1])
            )
            at_crop_border[border_indices] = True
        for position, compact_index in enumerate(object_indices):
            distance = float(distances[position])
            candidate = int(np.searchsorted(edges, distance, side="right")) - 1
            exclusions = []
            if not membership[position]:
                exclusions.append("outside_compartment")
            if at_crop_border[compact_index]:
                exclusions.append("crop_border")
            if not 0 <= candidate < band_count:
                exclusions.append("outside_bands")
            band_index = None if exclusions else candidate
            if band_index is not None:
                object_counts[band_index] += 1
            rows.append(
                {
                    "label": int(ids[compact_index]),
                    "distance": distance,
                    "band_index": band_index,
                    "exclusions": exclusions,
                }
            )

    bands = []
    for index in range(band_count):
        pixels = int(pixel_counts[index])
        area = pixels * pixel_area
        if not math.isfinite(area):
            raise ValueError("Compartment band area exceeds the finite numerical range")
        density = object_counts[index] / area if area > 0 else None
        if density is not None and not math.isfinite(density):
            raise ValueError("Compartment band density exceeds the finite numerical range")
        bands.append(
            {
                "lower": float(edges[index]),
                "upper": float(edges[index + 1]),
                "pixel_count": pixels,
                "area": area,
                "object_count": object_counts[index],
                "density": density,
            }
        )
    return rows, bands, band_labels
