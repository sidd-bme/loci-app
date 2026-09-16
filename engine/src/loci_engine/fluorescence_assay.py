"""Shared numerical computation for fluorescence field assays.

This module provides the shared numerical calculations and segmentation logic for
both the Loci engine workbench operations and the standalone CLI helper scripts.
All calculations operate on raw unsigned integer arrays and preserve numerical
invariants (e.g. signed negative integrals without clamping, undefined ratios on
zero counts, and explicit saturation metrics).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.feature import peak_local_max
from skimage.segmentation import watershed


class AssayError(ValueError):
    """Expected input or configuration failure; publication must stop."""


REQUIRED_CONFIG = (
    "nuclear_threshold",
    "gaussian_sigma_px",
    "min_nucleus_area_px",
    "max_nucleus_area_px",
    "watershed_min_distance_px",
    "signal_channel_label",
    "endpoint_status",
)

REVIEW_CONFIRMATIONS = (
    "channel_identity_confirmed",
    "acquisition_comparable",
    "focus_reviewed",
    "nuclei_reviewed",
    "background_reviewed",
)


def _finite_number(value: Any, name: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AssayError(f"{name} must be a finite number")
    result = float(value)
    if not np.isfinite(result) or (minimum is not None and result < minimum):
        suffix = f" >= {minimum}" if minimum is not None else ""
        raise AssayError(f"{name} must be finite{suffix}")
    return result


def validate_assay_config(value: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize field assay configuration parameters."""
    if not isinstance(value, dict):
        raise AssayError("config must be a JSON object")
    missing = [key for key in REQUIRED_CONFIG if key not in value]
    if missing:
        raise AssayError(f"config missing required keys: {', '.join(missing)}")
    result = dict(value)
    for key in ("nuclear_threshold", "gaussian_sigma_px"):
        result[key] = _finite_number(result[key], key, minimum=0)
    for key in (
        "min_nucleus_area_px",
        "max_nucleus_area_px",
        "watershed_min_distance_px",
    ):
        number = _finite_number(result[key], key, minimum=1)
        if not number.is_integer():
            raise AssayError(f"{key} must be an integer")
        result[key] = int(number)
    if result["min_nucleus_area_px"] > result["max_nucleus_area_px"]:
        raise AssayError("min_nucleus_area_px cannot exceed max_nucleus_area_px")
    if (
        not isinstance(result["signal_channel_label"], str)
        or not result["signal_channel_label"].strip()
    ):
        raise AssayError("signal_channel_label must be a non-empty string")
    if result["endpoint_status"] not in ("exploratory", "reviewed"):
        raise AssayError("endpoint_status must be exploratory or reviewed")
    if result["endpoint_status"] == "reviewed" and any(
        result.get(key) is not True for key in REVIEW_CONFIRMATIONS
    ):
        raise AssayError(
            "reviewed endpoint requires every review confirmation to be true"
        )
    if "signal_threshold_adu" in result and result["signal_threshold_adu"] is not None:
        result["signal_threshold_adu"] = _finite_number(
            result["signal_threshold_adu"], "signal_threshold_adu", minimum=0
        )
    else:
        result["signal_threshold_adu"] = None
    boundary = result.get("boundary_exclusion_px", 0)
    boundary = _finite_number(boundary, "boundary_exclusion_px", minimum=0)
    if not boundary.is_integer():
        raise AssayError("boundary_exclusion_px must be an integer")
    result["boundary_exclusion_px"] = int(boundary)
    if not isinstance(result.get("allow_boundary_exclusions", False), bool):
        raise AssayError("allow_boundary_exclusions must be boolean")
    result["allow_boundary_exclusions"] = result.get("allow_boundary_exclusions", False)
    if not isinstance(result.get("saturation_reviewed", False), bool):
        raise AssayError("saturation_reviewed must be boolean")
    result["saturation_reviewed"] = result.get("saturation_reviewed", False)
    return result


def load_config(path_or_dict: Path | str | dict[str, Any]) -> dict[str, Any]:
    """Load configuration from a file path or dict."""
    if isinstance(path_or_dict, dict):
        return validate_assay_config(path_or_dict)
    path = Path(path_or_dict)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AssayError(f"cannot read config JSON: {exc}") from exc
    return validate_assay_config(value)


def segment_nuclei(
    dapi: np.ndarray, focus: np.ndarray, config: dict[str, Any]
) -> tuple[np.ndarray, list[dict[str, Any]], list[str], np.ndarray]:
    """Segment nuclei on raw DAPI inside the focus mask using watershed.

    Returns:
        (accepted_labels, nuclei_rows, warnings, rejected_mask)
    """
    if dapi.ndim != 2:
        raise AssayError(f"dapi must be exactly 2-D, got shape {dapi.shape}")
    if focus.shape != dapi.shape:
        raise AssayError(f"focus mask shape {focus.shape} does not match dapi shape {dapi.shape}")

    sigma = config["gaussian_sigma_px"]
    smoothed = (
        ndimage.gaussian_filter(dapi.astype(np.float64), sigma=sigma) if sigma else dapi
    )
    binary = smoothed >= config["nuclear_threshold"]
    distance = ndimage.distance_transform_edt(binary)
    coordinates = peak_local_max(
        distance,
        min_distance=config["watershed_min_distance_px"],
        labels=binary,
        exclude_border=False,
    )
    markers = np.zeros(binary.shape, dtype=np.uint32)
    for marker_id, (row, column) in enumerate(coordinates, start=1):
        markers[row, column] = marker_id
    watershed_labels = (
        watershed(-distance, markers, mask=binary) if coordinates.size else markers
    )
    accepted = np.zeros(binary.shape, dtype=np.uint32)
    rows: list[dict[str, Any]] = []
    rejected = np.zeros(binary.shape, dtype=bool)
    warnings: list[str] = []
    for label_id, slc in enumerate(ndimage.find_objects(watershed_labels), start=1):
        if slc is None:
            continue
        local_labels = watershed_labels[slc]
        region = local_labels == label_id
        area = int(region.sum())
        row_indices, column_indices = np.nonzero(region)
        focus_local = focus[slc]
        focus_overlap = bool(np.any(region & focus_local))
        touches_edge = bool(
            slc[0].start == 0
            or slc[1].start == 0
            or slc[0].stop == dapi.shape[0]
            or slc[1].stop == dapi.shape[1]
        )
        focus_partial = bool(focus_overlap and np.any(region & ~focus_local))
        if not focus_overlap:
            qc_status = "outside_focus"
        elif touches_edge:
            qc_status = "image_edge_rejected"
        elif focus_partial:
            qc_status = "focus_partial_rejected"
        elif (
            area < config["min_nucleus_area_px"] or area > config["max_nucleus_area_px"]
        ):
            qc_status = "area_rejected"
        else:
            qc_status = "accepted"
            accepted[slc][region] = label_id
        if qc_status not in ("accepted", "outside_focus"):
            rejected[slc][region] = True
        rows.append(
            {
                "label_id": int(label_id),
                "centroid_y_px": float(row_indices.mean() + slc[0].start),
                "centroid_x_px": float(column_indices.mean() + slc[1].start),
                "area_px": area,
                "qc_status": qc_status,
            }
        )
    boundary_rejections = [
        row
        for row in rows
        if row["qc_status"] in ("image_edge_rejected", "focus_partial_rejected")
    ]
    if boundary_rejections and not config["allow_boundary_exclusions"]:
        raise AssayError(
            "nuclei touch the image edge or focus boundary; set allow_boundary_exclusions true "
            "only for an exploratory run with explicit human region-count review"
        )
    if boundary_rejections:
        warnings.append(
            "Boundary exclusions were applied; the field integral is an approximate proxy and "
            "requires human-accepted-region counts."
        )
    field_rejections = [
        row
        for row in rows
        if row["qc_status"]
        in ("image_edge_rejected", "focus_partial_rejected", "area_rejected")
    ]
    if field_rejections:
        warnings.append(
            "Rejected or partial nuclei were excluded geometrically; this does not remove "
            "whole-cell signal, so the field endpoint is an approximate proxy requiring "
            "human-accepted-region counts."
        )
        if config["endpoint_status"] == "reviewed":
            raise AssayError(
                "rejected or partial nuclei affecting the field require "
                "exploratory-only endpoint labelling"
            )
    return accepted, rows, warnings, rejected


def evaluate_manual_count_points(
    points: list[dict[str, Any] | tuple[float, float]], focus: np.ndarray
) -> tuple[int, list[dict[str, Any]]]:
    """Validate manual point markers against the focus mask.

    Only points located within the focus mask are included in the reviewed count.
    """
    height, width = focus.shape
    valid_points: list[dict[str, Any]] = []
    for idx, pt in enumerate(points, start=1):
        if isinstance(pt, dict):
            x = float(pt.get("x", 0))
            y = float(pt.get("y", 0))
            pid = str(pt.get("id", f"pt-{idx}"))
        else:
            y, x = float(pt[0]), float(pt[1])
            pid = f"pt-{idx}"
        px = int(round(x))
        py = int(round(y))
        inside_image = 0 <= py < height and 0 <= px < width
        inside_focus = bool(inside_image and focus[py, px])
        valid_points.append(
            {
                "id": pid,
                "x": x,
                "y": y,
                "inside_focus": inside_focus,
            }
        )
    accepted_count = sum(1 for p in valid_points if p["inside_focus"])
    return accepted_count, valid_points


def compute_field_quantification(
    nuclei: np.ndarray,
    signal: np.ndarray,
    focus: np.ndarray,
    background_mask: np.ndarray | None,
    background_value: float | None,
    config: dict[str, Any],
    *,
    manual_count: int | None = None,
    manual_points: list[dict[str, Any] | tuple[float, float]] | None = None,
) -> dict[str, Any]:
    """Compute exact continuous background-corrected field fluorescence integral.

    Guarantees:
    - No clamping of negative totals.
    - Preserves unsigned integer pixel identity and saturations.
    - Zero count results in undefined ratio, failing closed in reviewed mode.
    - Rejects background overlapping focus or empty background mask.
    """
    if nuclei.ndim != 2:
        raise AssayError(f"nuclei must be exactly 2-D, got shape {nuclei.shape}")
    if signal.ndim != 2 or signal.shape != nuclei.shape:
        raise AssayError(
            f"signal shape {signal.shape} does not match nuclei shape {nuclei.shape}"
        )
    if not np.issubdtype(nuclei.dtype, np.unsignedinteger):
        raise AssayError("nuclei must use an unsigned integer dtype")
    if not np.issubdtype(signal.dtype, np.unsignedinteger):
        raise AssayError("signal must use an unsigned integer dtype")
    if not np.isfinite(nuclei).all():
        raise AssayError("nuclei contains non-finite values")
    if not np.isfinite(signal).all():
        raise AssayError("signal contains non-finite values")
    if focus.shape != nuclei.shape:
        raise AssayError(f"focus shape {focus.shape} does not match image {nuclei.shape}")
    if not np.any(focus):
        raise AssayError("focus mask must contain at least one pixel")

    if (background_mask is None) == (background_value is None):
        raise AssayError(
            "provide exactly one of background_mask or background_value"
        )

    resolved_config = dict(config)
    bg_estimator = str(resolved_config.get("background_estimator", "median")).lower()
    bg_mask = np.zeros(nuclei.shape, dtype=bool)
    if background_mask is not None:
        bg_mask = background_mask.astype(bool)
        if bg_mask.shape != nuclei.shape:
            raise AssayError("background mask must match the image shape")
        if np.any(bg_mask & focus):
            raise AssayError("background mask must be disjoint from focus mask")
        if not np.any(bg_mask):
            raise AssayError("background mask must contain at least one pixel")
        if bg_estimator == "mean":
            bg = float(np.mean(signal[bg_mask]))
            bg_mode = "mean_background_mask"
        else:
            bg = float(np.median(signal[bg_mask]))
            bg_mode = "median_background_mask"
    else:
        bg = _finite_number(background_value, "background value", minimum=0)
        bg_mode = "explicit_scalar"

    is_manual = manual_points is not None or manual_count is not None

    if is_manual:
        # In manual count mode, the human count is authoritative and the fluorescence
        # numerator is strictly the prespecified reviewed focus ROI.
        effective = focus.copy()
        signal_values = signal[effective].astype(np.float64)
        raw_signal_sum = float(signal_values.sum())
        integrated = float(raw_signal_sum - signal_values.size * bg)

        # Run automated segmentation for visualization only, without letting rejections
        # modify the numerator or raise boundary rejections.
        algo_config = {
            **resolved_config,
            "allow_boundary_exclusions": True,
            "endpoint_status": "exploratory",
        }
        accepted_labels, nuclei_rows, _, rejected = segment_nuclei(
            nuclei, focus, algo_config
        )
        algo_count = sum(row["qc_status"] == "accepted" for row in nuclei_rows)

        if manual_points is not None:
            count_mode = "manual_points"
            reviewed_count, manual_points_data = evaluate_manual_count_points(
                manual_points, focus
            )
        else:
            if manual_count < 0:
                raise AssayError("manual count cannot be negative")
            count_mode = "manual_override"
            reviewed_count = int(manual_count)
            manual_points_data = None

        warnings = [
            f"Manual nucleus count ({reviewed_count}) used; "
            "fluorescence integral measured over prespecified focus ROI."
        ]
    else:
        accepted_labels, nuclei_rows, warnings, rejected = segment_nuclei(
            nuclei, focus, resolved_config
        )

        radius = resolved_config["boundary_exclusion_px"]
        exclusion = (
            rejected.copy()
            if radius == 0
            else ndimage.binary_dilation(rejected, iterations=radius)
        )
        if np.any((accepted_labels > 0) & exclusion):
            raise AssayError(
                "boundary exclusion would clip an accepted nucleus; "
                "reduce boundary_exclusion_px or review the masks"
            )

        effective = focus & ~exclusion
        if not np.any(effective):
            raise AssayError("effective measurement mask is empty")

        signal_values = signal[effective].astype(np.float64)
        raw_signal_sum = float(signal_values.sum())
        integrated = float(raw_signal_sum - signal_values.size * bg)

        algo_count = sum(row["qc_status"] == "accepted" for row in nuclei_rows)
        count_mode = "algorithmic"
        reviewed_count = algo_count
        manual_points_data = None

    threshold = resolved_config.get("signal_threshold_adu")
    fraction_positive: float | str = ""
    if threshold is not None:
        fraction_positive = float(
            np.count_nonzero(signal_values > threshold) / signal_values.size
        )

    nuclei_saturated = int(
        np.count_nonzero(nuclei[focus] == np.iinfo(nuclei.dtype).max)
    )
    signal_saturated = int(
        np.count_nonzero(signal[focus] == np.iinfo(signal.dtype).max)
    )
    background_saturated = (
        int(np.count_nonzero(signal[bg_mask] == np.iinfo(signal.dtype).max))
        if background_mask is not None
        else 0
    )

    if nuclei_saturated or signal_saturated or background_saturated:
        warnings.append(
            "Saturated pixels were detected in measured masks; "
            "interpret the field endpoint with review."
        )
        if (
            resolved_config["endpoint_status"] == "reviewed"
            and not resolved_config["saturation_reviewed"]
        ):
            raise AssayError(
                "reviewed endpoint cannot include saturated pixels without "
                "saturation_reviewed true"
            )

    if not reviewed_count:
        warnings.append(
            "No nuclei were accepted; the field ratio is undefined and requires human review."
        )
        if resolved_config["endpoint_status"] == "reviewed":
            raise AssayError("reviewed endpoint cannot have an undefined field ratio")

    if resolved_config.get("endpoint_status") == "reviewed":
        if background_mask is None and bg == 0.0:
            raise AssayError(
                "reviewed endpoint cannot use zero background without "
                "cell-free background measurement"
            )
        if focus.all():
            raise AssayError(
                "reviewed endpoint requires a human-approved focus ROI, not whole-field measurement"
            )

    resolved_config["resolved_background"] = bg_mode
    resolved_config["resolved_background_value_adu"] = bg
    resolved_config["resolved_effective_pixels"] = int(signal_values.size)
    resolved_config["resolved_accepted_nuclei"] = reviewed_count
    resolved_config["algorithmic_accepted_nuclei"] = algo_count
    resolved_config["count_mode"] = count_mode

    field_ratio = (
        float(integrated / reviewed_count) if reviewed_count > 0 else ""
    )

    human_accepted_required = bool(
        count_mode != "algorithmic"
        or any(
            row["qc_status"]
            in ("image_edge_rejected", "focus_partial_rejected", "area_rejected")
            for row in nuclei_rows
        )
    )

    summary = {
        "signal_channel_label": resolved_config["signal_channel_label"],
        "nuclear_threshold_adu": resolved_config["nuclear_threshold"],
        "endpoint_status": "exploratory"
        if warnings and resolved_config["endpoint_status"] != "reviewed"
        else resolved_config["endpoint_status"],
        "background_value_adu": bg,
        "focus_pixels": int(focus.sum()),
        "effective_measurement_pixels": int(signal_values.size),
        "candidate_nuclei_count": len(nuclei_rows),
        "accepted_nuclei_count": algo_count,
        "reviewed_nuclei_count": reviewed_count,
        "count_mode": count_mode,
        "raw_signal_sum_adu": raw_signal_sum,
        "integrated_signal_minus_background_adu": integrated,
        "mean_signal_minus_background_adu": float(integrated / signal_values.size),
        "field_ratio_integrated_signal_per_accepted_nucleus_adu": field_ratio,
        "fraction_positive": fraction_positive,
        "nuclei_saturated_pixels": nuclei_saturated,
        "signal_saturated_pixels": signal_saturated,
        "background_saturated_pixels": background_saturated,
        "human_accepted_region_counts_required": human_accepted_required,
    }

    return {
        "accepted_labels": accepted_labels,
        "nuclei_rows": nuclei_rows,
        "warnings": warnings,
        "rejected": rejected,
        "effective_mask": effective,
        "background_mask": bg_mask,
        "focus_mask": focus,
        "summary": summary,
        "config": resolved_config,
        "manual_points": manual_points_data,
    }


def generate_qc_overlay(
    nuclei: np.ndarray,
    focus: np.ndarray,
    accepted_labels: np.ndarray,
    rejected: np.ndarray,
) -> Image.Image:
    """Generate an RGB QC overlay visualization showing segmentation and focus."""
    norm = nuclei.astype(np.float64)
    p1, p99 = np.percentile(norm, (1, 99))
    norm = (
        np.clip((norm - p1) / (p99 - p1) * 255, 0, 255)
        if p99 > p1
        else np.zeros_like(norm)
    )
    base = Image.fromarray(norm.astype(np.uint8)).convert("RGB")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Shaded rejected nuclei in magenta
    for y, x in zip(*np.nonzero(rejected), strict=False):
        draw.point((x, y), fill=(255, 0, 128, 120))

    # Focus perimeter in cyan
    focus_edge = focus ^ ndimage.binary_erosion(focus)
    for y, x in zip(*np.nonzero(focus_edge), strict=False):
        draw.point((x, y), fill=(0, 220, 255, 255))

    # Accepted outlines in yellow
    accepted_edge = (accepted_labels > 0) ^ ndimage.binary_erosion(accepted_labels > 0)
    for y, x in zip(*np.nonzero(accepted_edge), strict=False):
        draw.point((x, y), fill=(255, 220, 0, 255))

    base.paste(overlay, (0, 0), overlay)
    return base
