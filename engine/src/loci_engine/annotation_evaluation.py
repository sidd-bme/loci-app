"""Bounded descriptive agreement of two YX label grids, never annotation truth.

Positive values are caller-declared instances, including disconnected pixels of
one ID. Foreground-region mode deliberately discards instance identity. Inputs
are never modified; undefined denominators produce null and a reason.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.optimize import linear_sum_assignment

from .quantitative import MAX_WORKING_BYTES, integer

SCHEMA = "loci.annotation-agreement-kernel/v1"
MAX_INSTANCES = 10_000
MAX_PAIR_CELLS = 4_000_000
MAX_THRESHOLDS = 8
RULES = {
    "axes": "YX; identical grid, no resampling or registration",
    "background": "zero",
    "instances": "Each unique positive uint32 value is one instance, even if disconnected",
    "region": "All positive values form one foreground region",
    "matching": "Maximum eligible cardinality then maximum summed IoU; threshold inclusive",
    "ties": "Equal optimal assignments are not scientific distinctions; sorted input label IDs",
    "undefined": "Zero denominator is null with an explicit reason, never perfect agreement",
    "coverage": "Complete declared comparison crop; no inference about unannotated outside pixels",
    "interpretation": "Technical annotation agreement, not biological ground truth or validation",
}


def validate_settings(semantics, iou_thresholds):
    if semantics not in {"instances", "foreground-region"}:
        raise ValueError("Choose explicit instances or foreground-region semantics")
    if not isinstance(iou_thresholds, list):
        raise ValueError("IoU thresholds must be an explicit list")
    if semantics == "foreground-region":
        if iou_thresholds:
            raise ValueError("Foreground-region agreement requires an empty IoU threshold list")
        return
    if (
        not 1 <= len(iou_thresholds) <= MAX_THRESHOLDS
        or any(
            type(v) not in (int, float) or not math.isfinite(v) or not 0 < v <= 1
            for v in iou_thresholds
        )
        or any(a >= b for a, b in zip(iou_thresholds, iou_thresholds[1:], strict=False))
    ):
        raise ValueError("Choose 1-8 finite strictly increasing IoU thresholds in (0,1]")


def estimated_working_bytes(pixels, reference_count=0, prediction_count=0, thresholds=0):
    """Conservative simultaneous scan, dense matching and Python report allowance."""
    integer(pixels, "agreement pixels", 1, 2**31 - 1)
    for count in (reference_count, prediction_count):
        integer(count, "agreement instances", 0, MAX_INSTANCES)
    integer(thresholds, "agreement thresholds", 0, MAX_THRESHOLDS)
    cells = (reference_count + 1) * (prediction_count + 1)
    if thresholds and cells > MAX_PAIR_CELLS:
        raise ValueError("Pairwise instance matrix exceeds the bounded agreement allowance")
    return (
        pixels * (96 if thresholds else 32)
        + (cells * 128 if thresholds else 0)
        + (reference_count + prediction_count) * max(1, thresholds) * 2048
        + 65536
    )


def _labels(value, working_bytes):
    if not isinstance(value, np.ndarray) or value.ndim != 2 or any(n < 1 for n in value.shape):
        raise ValueError("Annotation agreement requires nonempty scalar YX arrays")
    if value.dtype != np.uint32:
        raise ValueError("Annotation agreement requires exact uint32 labels; IDs are unchanged")
    if value.size * 32 + 65536 > working_bytes:
        raise ValueError("Agreement scan exceeds the working-memory budget")
    return value


def compare_labels(reference, prediction, *, semantics, iou_thresholds, working_bytes, check=None):
    """Return canonical finite descriptive metrics and original-ID match tables."""
    validate_settings(semantics, iou_thresholds)
    integer(working_bytes, "agreement working_bytes", 1024**2, MAX_WORKING_BYTES)
    if check:
        check()
    reference, prediction = _labels(reference, working_bytes), _labels(prediction, working_bytes)
    if reference.shape != prediction.shape:
        raise ValueError("Reference and prediction YX shapes differ")
    if estimated_working_bytes(reference.size, thresholds=len(iou_thresholds)) > working_bytes:
        raise ValueError("Agreement scan exceeds the working-memory budget")
    ref_foreground, pred_foreground = reference > 0, prediction > 0
    intersection = int(np.count_nonzero(ref_foreground & pred_foreground))
    ref_pixels, pred_pixels = int(ref_foreground.sum()), int(pred_foreground.sum())
    union = ref_pixels + pred_pixels - intersection
    reasons = {}
    if not union:
        reasons.update(iou="empty-foreground-union", dice="empty-foreground-union")
    region = {
        "reference_pixels": ref_pixels,
        "prediction_pixels": pred_pixels,
        "intersection_pixels": intersection,
        "union_pixels": union,
        "iou": intersection / union if union else None,
        "dice": 2 * intersection / (ref_pixels + pred_pixels) if union else None,
        "undefined_reasons": reasons,
    }
    output = {"schema": SCHEMA, "semantics": semantics, "region": region, "instances": None}
    if semantics == "foreground-region":
        if check:
            check()
        return output
    del ref_foreground, pred_foreground
    if check:
        check()
    reference_ids, ref = np.unique(reference, return_inverse=True)
    prediction_ids, pred = np.unique(prediction, return_inverse=True)
    nr, npred = int(np.count_nonzero(reference_ids)), int(np.count_nonzero(prediction_ids))
    required = estimated_working_bytes(reference.size, nr, npred, len(iou_thresholds))
    if required > working_bytes:
        raise ValueError("Instance matching exceeds aggregate working-memory budget")
    intersections = np.bincount(
        ref.ravel() * len(prediction_ids) + pred.ravel(),
        minlength=len(reference_ids) * len(prediction_ids),
    ).reshape(len(reference_ids), len(prediction_ids))
    ref_areas, pred_areas = intersections.sum(axis=1), intersections.sum(axis=0)
    keep_r, keep_p = reference_ids != 0, prediction_ids != 0
    overlaps = intersections[np.ix_(keep_r, keep_p)]
    ref_ids, pred_ids = reference_ids[keep_r], prediction_ids[keep_p]
    unions = ref_areas[keep_r, None] + pred_areas[None, keep_p] - overlaps
    iou = np.divide(
        overlaps, unions, out=np.zeros_like(overlaps, dtype=np.float64), where=unions > 0
    )
    scores = []
    for threshold in iou_thresholds:
        if check:
            check()
        eligible = iou >= threshold
        # One additional eligible edge outweighs every possible summed-IoU gain.
        weight = eligible * (min(nr, npred) + 1 + iou)
        rows, columns = linear_sum_assignment(weight, maximize=True)
        accepted = eligible[rows, columns]
        rows, columns = rows[accepted], columns[accepted]
        tp = int(len(rows))
        fp, fn = npred - tp, nr - tp
        matches = [
            {
                "reference_label": int(ref_ids[r]),
                "prediction_label": int(pred_ids[c]),
                "intersection_pixels": int(overlaps[r, c]),
                "union_pixels": int(unions[r, c]),
                "iou": float(iou[r, c]),
            }
            for r, c in zip(rows, columns, strict=True)
        ]
        matched_r, matched_p = set(rows.tolist()), set(columns.tolist())
        undefined = {}
        if not npred:
            undefined["precision"] = "no-predicted-instances"
        if not nr:
            undefined["recall"] = "no-reference-instances"
        if not nr + npred:
            undefined.update(
                f1="no-reference-or-predicted-instances", mean_matched_iou="no-matches"
            )
        elif not tp:
            undefined["mean_matched_iou"] = "no-matches"
        iou_sum = math.fsum(row["iou"] for row in matches)
        scores.append(
            {
                "iou_threshold": threshold,
                "true_positive": tp,
                "false_positive": fp,
                "false_negative": fn,
                "precision": tp / npred if npred else None,
                "recall": tp / nr if nr else None,
                "f1": 2 * tp / (nr + npred) if nr + npred else None,
                "matched_iou_sum": iou_sum,
                "mean_matched_iou": iou_sum / tp if tp else None,
                "undefined_reasons": undefined,
                "matches": matches,
                "unmatched_reference": [
                    int(v) for i, v in enumerate(ref_ids) if i not in matched_r
                ],
                "unmatched_prediction": [
                    int(v) for i, v in enumerate(pred_ids) if i not in matched_p
                ],
            }
        )
    output["instances"] = {
        "reference_count": nr,
        "prediction_count": npred,
        "count_error_signed": npred - nr,
        "count_error_absolute": abs(npred - nr),
        "count_error_relative": abs(npred - nr) / nr if nr else None,
        "undefined_reasons": {} if nr else {"count_error_relative": "no-reference-instances"},
        "split_reference_any_overlap": int(((overlaps > 0).sum(axis=1) > 1).sum()),
        "merge_prediction_any_overlap": int(((overlaps > 0).sum(axis=0) > 1).sum()),
        "scores": scores,
    }
    if check:
        check()
    return output
