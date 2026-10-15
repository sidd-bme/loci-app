"""Explicit cell partitions measured on immutable raw acquisition channels.

Association tie-breaking is deliberately irrelevant: every positive nuclear voxel
inside a cell belongs to its nuclear intersection. No biological identity is inferred.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .quantitative import Geometry, measure_objects, validate_array

COMPARTMENTS = ("cell", "nuclear", "cytoplasm")
CONSERVATION_RTOL = 1e-12


def compartment_rows(
    cells: np.ndarray, nuclei: np.ndarray, geometry: Geometry, *, working_bytes: int
) -> list[dict[str, Any]]:
    validate_array(cells, geometry=geometry, labels=True, working_bytes=working_bytes)
    validate_array(nuclei, geometry=geometry, labels=True, working_bytes=working_bytes)
    if cells.shape != nuclei.shape:
        raise ValueError("Compartment label grids must match exactly")
    rows = measure_objects(cells, geometry, working_bytes=working_bytes)
    basis = np.asarray(geometry.affine)[:3, : len(geometry.axes)]
    element_measure = float(np.sqrt(np.linalg.det(basis.T @ basis)))
    if not math.isfinite(element_measure) or element_measure <= 0:
        raise ValueError("Compartment geometry requires finite positive element measure")
    for row in rows:
        region = tuple(
            slice(a, b) for a, b in zip(row["bbox_start"], row["bbox_stop_exclusive"], strict=True)
        )
        whole = cells[region] == row["label"]
        nuclear_count = int(np.count_nonzero(whole & (nuclei[region] > 0)))
        counts = (row["voxel_count"], nuclear_count, row["voxel_count"] - nuclear_count)
        row["compartments"] = {
            name: {
                "voxel_count": count,
                "measure": float(count * element_measure),
                "measure_kind": row["measure_kind"],
                "measure_unit": row["measure_unit"],
                "intensity": {},
            }
            for name, count in zip(COMPARTMENTS, counts, strict=True)
        }
        if not math.isclose(
            row["compartments"]["cell"]["measure"],
            row["compartments"]["nuclear"]["measure"] + row["compartments"]["cytoplasm"]["measure"],
            rel_tol=CONSERVATION_RTOL,
            abs_tol=0,
        ):
            raise ValueError("Compartment physical measures do not conserve the cell whole")
    return rows


def measure_compartment_channel(
    rows: list[dict[str, Any]],
    cells: np.ndarray,
    nuclei: np.ndarray,
    raw: np.ndarray,
    geometry: Geometry,
    channel_name: str,
    *,
    working_bytes: int,
) -> None:
    """Consume one channel at a time; retain only bounded descriptive records."""
    validate_array(raw, geometry=geometry, working_bytes=working_bytes)
    if raw.shape != cells.shape:
        raise ValueError("Raw compartment measurement channel must share the exact label grid")
    for row in rows:
        region = tuple(
            slice(a, b) for a, b in zip(row["bbox_start"], row["bbox_stop_exclusive"], strict=True)
        )
        whole = cells[region] == row["label"]
        sums = []
        absolute_sum = 0.0
        for name in COMPARTMENTS:
            mask = (
                whole
                if name == "cell"
                else whole & ((nuclei[region] > 0) if name == "nuclear" else (nuclei[region] == 0))
            )
            values = raw[region][mask].astype(np.float64)
            count = int(values.size)
            total = math.fsum(values)
            if count != row["compartments"][name]["voxel_count"]:
                raise ValueError("Compartment intensity counts disagree with the label partition")
            statistics = {
                "count": count,
                "sum": total,
                "mean": total / count if count else None,
                "min": float(values.min()) if count else None,
                "max": float(values.max()) if count else None,
                "std_population": float(values.std(ddof=0)) if count else None,
            }
            if any(value is not None and not math.isfinite(value) for value in statistics.values()):
                raise ValueError("Compartment statistics contain non-finite values")
            row["compartments"][name]["intensity"][channel_name] = statistics
            sums.append(total)
            if name == "cell":
                absolute_sum = math.fsum(abs(value) for value in values)
        if not math.isclose(
            sums[0],
            math.fsum(sums[1:]),
            rel_tol=CONSERVATION_RTOL,
            abs_tol=8 * np.finfo(np.float64).eps * absolute_sum,
        ):
            raise ValueError("Compartment raw intensity sums do not conserve the cell whole")
