"""Explicit pseudo-label agreement metrics; these are not accuracy claims."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence

import numpy as np
from scipy.optimize import linear_sum_assignment

IOU_THRESHOLDS = (0.50, 0.75)


def _sequential(labels: np.ndarray) -> np.ndarray:
    source = np.asarray(labels)
    if source.ndim != 2 or not np.issubdtype(source.dtype, np.integer):
        raise ValueError("instance labels must be a 2D integer array")
    result = np.zeros(source.shape, dtype=np.int32)
    for new_id, old_id in enumerate(np.unique(source[source > 0]), start=1):
        result[source == old_id] = new_id
    return result


def _iou_matrix(reference: np.ndarray, prediction: np.ndarray) -> np.ndarray:
    truth = _sequential(reference)
    predicted = _sequential(prediction)
    true_count = int(truth.max())
    predicted_count = int(predicted.max())
    if true_count == 0 or predicted_count == 0:
        return np.zeros((true_count, predicted_count), dtype=np.float64)
    pair_index = truth.astype(np.int64) * (predicted_count + 1) + predicted
    contingency = np.bincount(
        pair_index.ravel(),
        minlength=(true_count + 1) * (predicted_count + 1),
    ).reshape(true_count + 1, predicted_count + 1)
    intersections = contingency[1:, 1:].astype(np.float64)
    truth_area = contingency[1:, :].sum(axis=1, keepdims=True)
    predicted_area = contingency[:, 1:].sum(axis=0, keepdims=True)
    unions = truth_area + predicted_area - intersections
    return np.divide(intersections, unions, out=np.zeros_like(intersections), where=unions > 0)


def _threshold_suffix(threshold: float) -> str:
    return f"at_iou_{threshold:.2f}".replace(".", "_")


def _instance_metrics_at_threshold(
    *,
    matched_ious: np.ndarray,
    truth_count: int,
    predicted_count: int,
    threshold: float,
) -> dict[str, float | int]:
    suffix = _threshold_suffix(threshold)
    true_positive = int(np.count_nonzero(matched_ious >= threshold))
    false_positive = predicted_count - true_positive
    false_negative = truth_count - true_positive
    ap_denominator = true_positive + false_positive + false_negative
    instance_ap = 1.0 if ap_denominator == 0 else true_positive / ap_denominator
    precision_denominator = true_positive + false_positive
    recall_denominator = true_positive + false_negative
    precision = 1.0 if precision_denominator == 0 else true_positive / precision_denominator
    recall = 1.0 if recall_denominator == 0 else true_positive / recall_denominator
    f1 = 0.0 if precision + recall == 0 else 2.0 * precision * recall / (precision + recall)
    passing_ious = matched_ious[matched_ious >= threshold]
    mean_matched_iou = (
        float(passing_ious.mean())
        if len(passing_ious)
        else (1.0 if truth_count == predicted_count == 0 else 0.0)
    )
    return {
        f"true_positive_instances_{suffix}": true_positive,
        f"false_positive_instances_{suffix}": false_positive,
        f"false_negative_instances_{suffix}": false_negative,
        f"instance_precision_{suffix}": float(precision),
        f"instance_recall_{suffix}": float(recall),
        f"instance_f1_{suffix}": float(f1),
        f"instance_ap_{suffix}": float(instance_ap),
        f"mean_matched_iou_{suffix}": mean_matched_iou,
    }


def agreement_metrics(
    reference: np.ndarray,
    prediction: np.ndarray,
    *,
    iou_thresholds: tuple[float, ...] = IOU_THRESHOLDS,
) -> dict[str, float | int | None]:
    if reference.shape != prediction.shape:
        raise ValueError("reference and prediction shapes must match")
    if not iou_thresholds or any(not 0 < value <= 1 for value in iou_thresholds):
        raise ValueError("iou_thresholds must contain values in (0, 1]")
    if len(set(iou_thresholds)) != len(iou_thresholds):
        raise ValueError("iou_thresholds must not contain duplicates")
    truth = _sequential(reference)
    predicted = _sequential(prediction)
    truth_foreground = truth > 0
    predicted_foreground = predicted > 0
    intersection = int(np.logical_and(truth_foreground, predicted_foreground).sum())
    foreground_sum = int(truth_foreground.sum() + predicted_foreground.sum())
    union = int(np.logical_or(truth_foreground, predicted_foreground).sum())
    pixel_dice = 1.0 if foreground_sum == 0 else 2.0 * intersection / foreground_sum
    pixel_iou = 1.0 if union == 0 else intersection / union

    truth_count = int(truth.max())
    predicted_count = int(predicted.max())
    ious = _iou_matrix(truth, predicted)
    if ious.size:
        rows, columns = linear_sum_assignment(-ious)
        matched_ious = ious[rows, columns]
    else:
        matched_ious = np.zeros(0, dtype=np.float64)
    count_error = predicted_count - truth_count
    percentage_metrics_defined = truth_count > 0
    signed_percentage_error = (
        100.0 * count_error / truth_count if percentage_metrics_defined else None
    )
    absolute_percentage_error = (
        100.0 * abs(count_error) / truth_count if percentage_metrics_defined else None
    )
    metrics: dict[str, float | int | None] = {
        "reference_count": truth_count,
        "predicted_count": predicted_count,
        "count_error": count_error,
        "absolute_count_error": abs(count_error),
        "signed_percentage_count_error_percent": signed_percentage_error,
        "absolute_percentage_count_error": absolute_percentage_error,
        "absolute_percentage_count_error_percent": absolute_percentage_error,
        "pixel_dice": float(pixel_dice),
        "pixel_iou": float(pixel_iou),
    }
    for threshold in iou_thresholds:
        metrics.update(
            _instance_metrics_at_threshold(
                matched_ious=matched_ious,
                truth_count=truth_count,
                predicted_count=predicted_count,
                threshold=threshold,
            )
        )
    return metrics


def aggregate_agreement(
    rows: Sequence[dict[str, float | int | None]],
    *,
    prefix: str = "pseudo_label_agreement",
) -> dict[str, object]:
    if not rows:
        return {"scope": prefix, "image_count": 0, "metrics": {}}
    numeric_keys = [
        "count_error",
        "absolute_count_error",
        "pixel_dice",
        "pixel_iou",
    ]
    for threshold in IOU_THRESHOLDS:
        suffix = _threshold_suffix(threshold)
        numeric_keys.extend(
            [
                f"instance_precision_{suffix}",
                f"instance_recall_{suffix}",
                f"instance_f1_{suffix}",
                f"instance_ap_{suffix}",
                f"mean_matched_iou_{suffix}",
            ]
        )
    metrics: dict[str, float | int | None] = {}
    for key in numeric_keys:
        values = np.asarray([float(row[key]) for row in rows], dtype=np.float64)
        metrics[f"mean_{key}"] = float(values.mean())
        metrics[f"median_{key}"] = float(np.median(values))
    percentage_rows = [row for row in rows if int(row["reference_count"] or 0) > 0]
    for key in (
        "signed_percentage_count_error_percent",
        "absolute_percentage_count_error",
        "absolute_percentage_count_error_percent",
    ):
        values = np.asarray([float(row[key]) for row in percentage_rows], dtype=np.float64)
        metrics[f"mean_{key}"] = float(values.mean()) if len(values) else None
        metrics[f"median_{key}"] = float(np.median(values)) if len(values) else None
    percentage_errors = np.asarray(
        [float(row["absolute_percentage_count_error"]) for row in percentage_rows],
        dtype=np.float64,
    )
    p90_percentage_error = (
        float(np.percentile(percentage_errors, 90)) if len(percentage_errors) else None
    )
    metrics["p90_absolute_percentage_count_error"] = p90_percentage_error
    metrics["p90_absolute_percentage_count_error_percent"] = p90_percentage_error
    metrics["percentage_metric_image_count"] = len(percentage_rows)
    metrics["zero_reference_image_count"] = len(rows) - len(percentage_rows)
    metrics["count_mae"] = metrics["mean_absolute_count_error"]
    # This is a macro average of the signed percentage error computed per image,
    # matching the per-image evaluation protocol rather than pooling cell totals.
    metrics["count_bias_percent"] = metrics["mean_signed_percentage_count_error_percent"]
    metrics["count_bias_instances"] = metrics["mean_count_error"]
    return {"scope": prefix, "image_count": len(rows), "metrics": metrics}


def aggregate_agreement_by_group(
    rows: Sequence[dict[str, float | int | str | None]],
    *,
    prefix: str = "pseudo_label_agreement",
) -> list[dict[str, object]]:
    grouped: dict[str, list[dict[str, float | int | None]]] = defaultdict(list)
    for row in rows:
        group = row.get("group")
        if not isinstance(group, str) or not group:
            raise ValueError("every agreement row must contain a non-empty group")
        grouped[group].append(
            {
                key: value
                for key, value in row.items()
                if value is None or isinstance(value, (int, float))
            }
        )
    return [
        {
            "acquisition_group": group,
            "summary": aggregate_agreement(group_rows, prefix=prefix),
        }
        for group, group_rows in sorted(grouped.items())
    ]
