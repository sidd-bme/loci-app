"""Physical lattice-union boundaries and voxel-center moment shape descriptors.

A positive sparse label denotes one object, even if disconnected. In YX, each
pixel is the full affine parallelogram centered on its sample; in ZYX each voxel
is the full affine parallelepiped. Exposed edges/faces, including holes/cavities
and crop-exterior faces, determine exact union perimeter/surface. A contact
between different positive labels contributes once to EACH label's boundary.
This is neither a marching-cubes mesh nor a smooth-boundary perimeter estimator.

New eccentricity/elongation use equally weighted physical SAMPLE CENTERS:
    eccentricity = sqrt(1 - lambda_min / lambda_max)
    elongation = sqrt(lambda_max) / sqrt(lambda_min)  (major/minor, >= 1)
No within-pixel covariance term is added. Existing principal_rms_radii fields
are neither read nor changed. A single sample has zero moments: both ratios are
null. Collinear centers have eccentricity 1 and null elongation. These ratios
are defined only in 2D here. Empty foreground produces no rows.

Circularity = 4*pi*A/P^2; sphericity = (36*pi)^(1/3)*V^(2/3)/S. A square pixel
therefore has circularity pi/4, and a cubic voxel has sphericity (pi/6)^(1/3),
not 1. They describe the declared digital union, not a fitted disk or sphere.

Formula references (the boundary estimator is explicitly our lattice contract):
https://imagej.net/ij/plugins/circularity.html
https://scikit-image.org/docs/stable/api/skimage.measure.html#skimage.measure.regionprops

Checks run between fixed-size scans/face/moment blocks and object rows. NumPy's
bounded unique-label sort is checked before/after but cannot be interrupted
inside its C implementation. No inputs, writeability flags or geometry change.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

import numpy as np

from .quantitative import DEFAULT_WORKING_BYTES, MAX_OBJECTS, MAX_WORKING_BYTES, Geometry, integer

SCHEMA = "loci.morphometrics/v1"
CHUNK_PIXELS = 65_536
MAX_BASIS_CONDITION = 1e12
RULES = {
    "object": "All samples with the same positive uint32-range label; no connected relabeling",
    "boundary": "Exact exposed faces of the full affine pixel/voxel union, including holes",
    "contacts": "Different-label contact contributes once to each object's boundary",
    "crop": "Exterior is background; truncation is flagged, never filled or extrapolated",
    "moments": "Population central covariance of equal-weight physical sample centers",
    "moment_origin": "Centered array coordinates transformed by affine basis; translation cancels",
    "pixel_extent_moments": "No within-pixel/voxel covariance term; existing RMS radii unchanged",
    "circularity": "4*pi*pixel_union_area / exposed_edge_perimeter^2; 2D only",
    "eccentricity": "sqrt(1-lambda_min/lambda_max) from physical center covariance; 2D only",
    "elongation": "sqrt(lambda_max)/sqrt(lambda_min), major/minor >=1; 2D only",
    "sphericity": "(36*pi)^(1/3)*voxel_union_volume^(2/3)/exposed_face_surface; 3D only",
    "roundoff": "Eigenvalues in [-128*eps*largest_eigenvalue,0) are bounded roundoff to zero",
    "degeneracy": "Single centers and collinear centers are identified by exact integer-index rank",
    "interpretation": "Digital geometric descriptors; no biological identity or accuracy claim",
}


def estimated_working_bytes(voxel_count: int, object_count: int = 0) -> int:
    """Conservative peak: input/copies/sort/inverse/face/moment blocks and Python rows.

    Before label discovery object_count=0 bounds the array workspace. After the
    bounded sort, the actual positive object count must also fit before rows,
    face accumulators or moments are allocated.
    """
    return voxel_count * 160 + object_count * 4096 + 65_536


def _positive(value: float, name: str) -> float:
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} exceeds the finite positive numerical range")
    return float(value)


def _lattice(geometry: Geometry):
    dimension = len(geometry.axes)
    xyz = np.asarray(geometry.affine, dtype=np.float64)[:3, :dimension]
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        condition = float(np.linalg.cond(xyz))
    if not math.isfinite(condition) or condition > MAX_BASIS_CONDITION:
        raise ValueError("Morphometrics affine basis is ill-conditioned")
    columns = [xyz[:, axis] for axis in range(dimension)]
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        if dimension == 2:
            element = math.hypot(*np.cross(*columns))
            # Array Y faces span the physical X basis, and vice versa.
            weights = [math.hypot(*columns[0]), math.hypot(*columns[1])]
        else:
            face_xyz = [
                math.hypot(*np.cross(columns[(axis + 1) % 3], columns[(axis + 2) % 3]))
                for axis in range(3)
            ]
            element = abs(float(np.dot(columns[0], np.cross(columns[1], columns[2]))))
            weights = face_xyz[::-1]
    element = _positive(element, "Physical pixel/voxel measure")
    weights = [_positive(weight, "Physical boundary face measure") for weight in weights]
    # QR expresses the physical covariance in an orthonormal intrinsic plane or
    # full volume. Reverse XYZ columns to match the actual array YX/ZYX order.
    _, intrinsic = np.linalg.qr(xyz[:, ::-1], mode="reduced")
    if not np.isfinite(intrinsic).all():
        raise ValueError("Physical affine basis exceeds the moment numerical range")
    return element, weights, intrinsic


def measure_morphometrics(
    labels: np.ndarray,
    geometry: Geometry,
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    check: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Return detached metric rows with explicit units, rules and undefined reasons.

    Labels must be integer YX/ZYX arrays in uint32 range. Rotations, reflections
    and shear are supported; a basis condition number >1e12 is refused. The
    memory allowance includes input bytes and conservative output-row overhead.
    check may raise to cancel; an interrupted call returns no partial report.
    """
    integer(working_bytes, "working_bytes", 1024, MAX_WORKING_BYTES)
    if check is not None and not callable(check):
        raise ValueError("Morphometrics check must be a callable")

    def guard():
        if check is not None:
            check()

    guard()
    if not isinstance(geometry, Geometry):
        raise ValueError("Morphometrics requires explicit physical geometry")
    if not isinstance(labels, np.ndarray) or labels.ndim not in {2, 3}:
        raise ValueError("Morphometrics requires an integer YX or ZYX array")
    if labels.ndim != len(geometry.axes) or any(size < 1 for size in labels.shape):
        raise ValueError("Morphometrics array shape and declared axes disagree")
    if labels.dtype.kind not in "ui" or labels.dtype.itemsize > 8:
        raise ValueError("Morphometrics labels must be nonnegative integers")
    if estimated_working_bytes(labels.size) > working_bytes:
        raise ValueError("Morphometrics array workspace exceeds working-memory budget")
    element, weights, intrinsic = _lattice(geometry)
    flat = labels.ravel(order="C")
    for start in range(0, flat.size, CHUNK_PIXELS):
        guard()
        block = flat[start : start + CHUNK_PIXELS]
        if int(block.min()) < 0 or int(block.max()) > 0xFFFFFFFF:
            raise ValueError("Morphometrics label IDs must fit uint32 without remapping")
    guard()
    ids, first, inverse, counts = np.unique(
        flat, return_index=True, return_inverse=True, return_counts=True
    )
    guard()
    positive = np.flatnonzero(ids != 0)
    if len(positive) > MAX_OBJECTS:
        raise ValueError("Morphometrics supports at most 100000 objects")
    estimated = estimated_working_bytes(labels.size, len(positive))
    if estimated > working_bytes:
        raise ValueError("Morphometrics object rows exceed working-memory budget")
    dimension, groups = labels.ndim, len(ids)
    compact = inverse.reshape(labels.shape)
    exposed = np.zeros((dimension, groups), dtype=np.int64)
    border = np.zeros(groups, dtype=bool)

    def accumulate(values, axis, *, crop=False):
        values = values.ravel(order="C")
        for start in range(0, values.size, CHUNK_PIXELS):
            guard()
            histogram = np.bincount(values[start : start + CHUNK_PIXELS], minlength=groups)
            exposed[axis] += histogram
            if crop:
                border[:] |= histogram > 0

    for axis in range(dimension):
        guard()
        ends = [slice(None)] * dimension
        ends[axis] = 0
        accumulate(compact[tuple(ends)], axis, crop=True)
        ends[axis] = -1
        accumulate(compact[tuple(ends)], axis, crop=True)
        before, after = [slice(None)] * dimension, [slice(None)] * dimension
        before[axis], after[axis] = slice(None, -1), slice(1, None)
        left = compact[tuple(before)].ravel(order="C")
        right = compact[tuple(after)].ravel(order="C")
        for start in range(0, left.size, CHUNK_PIXELS):
            guard()
            a, b = left[start : start + CHUNK_PIXELS], right[start : start + CHUNK_PIXELS]
            changed = a != b
            exposed[axis] += np.bincount(a[changed], minlength=groups)
            exposed[axis] += np.bincount(b[changed], minlength=groups)
        del left, right

    sums = np.zeros((dimension, groups), dtype=np.float64)
    covariances = np.zeros((dimension, dimension, groups), dtype=np.float64)
    strides = [math.prod(labels.shape[axis + 1 :]) for axis in range(dimension)]

    def coordinates(start, stop):
        linear = np.arange(start, stop, dtype=np.int64)
        return np.array(
            [
                (linear // stride) % extent
                for stride, extent in zip(strides, labels.shape, strict=True)
            ],
            dtype=np.float64,
        )

    # Exact rank in integer index coordinates avoids turning roundoff-positive
    # minor physical eigenvalues into spurious finite elongations for lines.
    # For YX, cross-product terms are bounded by the selected pixel count.
    collinear = np.ones(groups, dtype=bool)
    if dimension == 2:
        second = np.full(groups, flat.size, dtype=np.int64)
        for start in range(0, flat.size, CHUNK_PIXELS):
            guard()
            stop = min(start + CHUNK_PIXELS, flat.size)
            positions = np.arange(start, stop, dtype=np.int64)
            group = inverse[start:stop]
            later = positions != first[group]
            np.minimum.at(second, group[later], positions[later])
        anchor = np.array([first // labels.shape[1], first % labels.shape[1]])
        second[counts == 1] = first[counts == 1]
        direction = np.array([second // labels.shape[1], second % labels.shape[1]]) - anchor
        for start in range(0, flat.size, CHUNK_PIXELS):
            guard()
            stop = min(start + CHUNK_PIXELS, flat.size)
            positions = np.arange(start, stop, dtype=np.int64)
            group = inverse[start:stop]
            offset_y = positions // labels.shape[1] - anchor[0, group]
            offset_x = positions % labels.shape[1] - anchor[1, group]
            cross = offset_y * direction[1, group] - offset_x * direction[0, group]
            collinear[group[cross != 0]] = False
        del second, anchor, direction

    for start in range(0, flat.size, CHUNK_PIXELS):
        guard()
        stop = min(start + CHUNK_PIXELS, flat.size)
        coords, group = coordinates(start, stop), inverse[start:stop]
        for axis in range(dimension):
            sums[axis] += np.bincount(group, weights=coords[axis], minlength=groups)
    means = sums / counts
    del sums
    for start in range(0, flat.size, CHUNK_PIXELS):
        guard()
        stop = min(start + CHUNK_PIXELS, flat.size)
        group = inverse[start:stop]
        centered = coordinates(start, stop) - means[:, group]
        for a in range(dimension):
            for b in range(a, dimension):
                covariances[a, b] += np.bincount(
                    group, weights=centered[a] * centered[b], minlength=groups
                )
    del means
    for a in range(dimension):
        for b in range(a, dimension):
            covariances[a, b] /= counts
            covariances[b, a] = covariances[a, b]
    rows = []
    for group in positive:
        guard()
        count = int(counts[group])
        measure = _positive(count * element, "Object area/volume")
        boundary = _positive(
            math.fsum(int(exposed[axis, group]) * weights[axis] for axis in range(dimension)),
            "Object perimeter/surface",
        )
        with np.errstate(over="ignore", invalid="ignore", under="ignore"):
            covariance = intrinsic @ covariances[:, :, group] @ intrinsic.T
        if not np.isfinite(covariance).all():
            raise ValueError("Physical center covariance exceeds the finite numerical range")
        eigenvalues = np.linalg.eigvalsh(covariance)[::-1]
        tolerance = 128 * np.finfo(np.float64).eps * max(0.0, float(eigenvalues[0]))
        if not np.isfinite(eigenvalues).all() or float(eigenvalues[-1]) < -tolerance:
            raise ValueError("Physical center covariance is not positive semidefinite")
        eigenvalues[eigenvalues < 0] = 0  # Only the documented bounded roundoff above.
        if dimension == 2:
            if count == 1:
                eigenvalues[:] = 0
            elif collinear[group]:
                if eigenvalues[0] <= 0:
                    raise ValueError("Nonzero center moment is numerically unresolved")
                eigenvalues[1] = 0
            elif eigenvalues[-1] <= 0:
                raise ValueError("Nondegenerate center covariance is numerically unresolved")
        row = {
            "label": int(ids[group]),
            "voxel_count": count,
            "pixel_union_area": measure if dimension == 2 else None,
            "voxel_union_volume": measure if dimension == 3 else None,
            "perimeter": boundary if dimension == 2 else None,
            "surface_area": boundary if dimension == 3 else None,
            "circularity": None,
            "eccentricity": None,
            "elongation": None,
            "sphericity": None,
            "center_covariance_eigenvalues": eigenvalues.tolist(),
            "exposed_face_counts": exposed[:, group].tolist(),
            "touches_crop_border": bool(border[group]),
            "undefined_reasons": {},
        }
        reasons = row["undefined_reasons"]
        if dimension == 2:
            row["circularity"] = _positive(
                4 * math.pi * (math.sqrt(measure) / boundary) ** 2, "Circularity"
            )
            reasons.update(
                surface_area="requires-3d",
                voxel_union_volume="requires-3d",
                sphericity="requires-3d",
            )
            major, minor = (float(value) for value in eigenvalues)
            if major == 0:
                reasons.update(
                    eccentricity="zero-major-center-moment", elongation="zero-major-center-moment"
                )
            else:
                ratio = math.sqrt(minor) / math.sqrt(major)
                row["eccentricity"] = math.sqrt(1 - ratio * ratio)
                if minor == 0:
                    reasons["elongation"] = "zero-minor-center-moment"
                else:
                    row["elongation"] = _positive(math.sqrt(major) / math.sqrt(minor), "Elongation")
        else:
            row["sphericity"] = _positive(
                (36 * math.pi) ** (1 / 3) * (math.cbrt(measure) / math.sqrt(boundary)) ** 2,
                "Sphericity",
            )
            reasons.update(
                pixel_union_area="requires-2d",
                perimeter="requires-2d",
                circularity="requires-2d",
                eccentricity="requires-2d",
                elongation="requires-2d",
            )
        if any(
            row[key] is not None and not 0 <= row[key] <= 1
            for key in ("circularity", "eccentricity", "sphericity")
        ):
            raise ValueError("A normalized morphology ratio is outside its geometric range")
        rows.append(row)
    guard()
    return {
        "schema": SCHEMA,
        "geometry": {
            "axes": geometry.axes,
            "affine": [list(row) for row in geometry.affine],
            "unit": geometry.unit,
            "frame": geometry.frame,
        },
        "rules": dict(RULES),
        "units": {
            "pixel_union_area": f"{geometry.unit}^2",
            "voxel_union_volume": f"{geometry.unit}^3",
            "perimeter": geometry.unit,
            "surface_area": f"{geometry.unit}^2",
            "circularity": "1",
            "eccentricity": "1",
            "elongation": "1",
            "sphericity": "1",
            "center_covariance_eigenvalues": f"{geometry.unit}^2",
        },
        "index_axes": geometry.axes,
        "object_count": len(rows),
        "rows": rows,
        "resource_estimate": {
            "estimated_working_bytes": estimated,
            "working_bytes": working_bytes,
            "scan_chunk_pixels": CHUNK_PIXELS,
            "basis_condition_maximum": MAX_BASIS_CONDITION,
        },
    }
