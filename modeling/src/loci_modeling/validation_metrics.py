"""Locked instance-segmentation metrics for biological validation reports.

Unlike :mod:`loci_modeling.metrics`, which measures agreement with historical
pseudo-labels, this module is for researcher-adjudicated validation sets. It
does not load data, tune thresholds, or interpret model output as cell viability.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Literal

import numpy as np

VALIDATION_METRICS_SCHEMA = "loci.validation-metrics/v1"
CULTURED_CELL_PROTOCOL_ID = "cultured-cell-counting-v1"
IOU_THRESHOLDS = (0.50, 0.75)


@dataclass(frozen=True, slots=True)
class GateDefinition:
    """A frozen release gate tied to one aggregate metric identifier."""

    metric_id: str
    operator: Literal["<=", ">="]
    threshold: float


FROZEN_CULTURED_CELL_GATES: tuple[GateDefinition, ...] = (
    GateDefinition(
        "median-per-image-absolute-percentage-count-error-percent",
        "<=",
        5.0,
    ),
    GateDefinition(
        "p90-per-image-absolute-percentage-count-error-percent",
        "<=",
        15.0,
    ),
    GateDefinition("absolute-aggregate-count-bias-percent", "<=", 3.0),
    GateDefinition("instance-f1-at-iou-0.50", ">=", 0.85),
    GateDefinition("instance-ap-at-iou-0.50", ">=", 0.75),
    GateDefinition(
        "maximum-stratum-median-absolute-percentage-count-error-percent",
        "<=",
        10.0,
    ),
)


def _validated_gate_configuration(
    gates: Sequence[GateDefinition],
) -> tuple[GateDefinition, ...]:
    if not gates:
        raise ValueError("at least one frozen validation gate is required")
    validated: list[GateDefinition] = []
    seen_metric_ids: set[str] = set()
    for index, gate in enumerate(gates):
        if not isinstance(gate, GateDefinition):
            raise TypeError(f"validation gate {index} must be a GateDefinition")
        metric_id = gate.metric_id
        if (
            not isinstance(metric_id, str)
            or not metric_id
            or len(metric_id) > 160
            or metric_id != metric_id.strip()
            or any(ord(character) < 32 for character in metric_id)
        ):
            raise ValueError(f"validation gate {index} has an invalid metric identifier")
        if metric_id in seen_metric_ids:
            raise ValueError("validation gate metric identifiers must be unique")
        if gate.operator not in {"<=", ">="}:
            raise ValueError(f"validation gate {metric_id} has an unsupported operator")
        if (
            isinstance(gate.threshold, bool)
            or not isinstance(gate.threshold, (int, float))
            or not math.isfinite(float(gate.threshold))
        ):
            raise ValueError(f"validation gate {metric_id} must have a finite threshold")
        threshold = float(gate.threshold)
        if threshold == 0:
            threshold = 0.0
        validated.append(GateDefinition(metric_id, gate.operator, threshold))
        seen_metric_ids.add(metric_id)
    return tuple(validated)


def gate_configuration_sha256(
    gates: Sequence[GateDefinition] = FROZEN_CULTURED_CELL_GATES,
) -> str:
    """Return the stable digest of ordered gate identifiers, operators, and thresholds."""

    validated_gates = _validated_gate_configuration(gates)
    payload = {
        "protocol_id": CULTURED_CELL_PROTOCOL_ID,
        "gates": [asdict(gate) for gate in validated_gates],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _sequential_labels(labels: np.ndarray, *, name: str) -> np.ndarray:
    source = np.asarray(labels)
    if source.ndim != 2 or not np.issubdtype(source.dtype, np.integer):
        raise ValueError(f"{name} labels must be a 2D integer array")
    if np.any(source < 0):
        raise ValueError(f"{name} labels must be non-negative")
    result = np.zeros(source.shape, dtype=np.int32)
    for new_id, old_id in enumerate(np.unique(source[source > 0]), start=1):
        result[source == old_id] = new_id
    return result


def _iou_matrix(reference: np.ndarray, prediction: np.ndarray) -> np.ndarray:
    reference_count = int(reference.max())
    prediction_count = int(prediction.max())
    if reference_count == 0 or prediction_count == 0:
        return np.zeros((reference_count, prediction_count), dtype=np.float64)

    pair_index = reference.astype(np.int64) * (prediction_count + 1) + prediction
    contingency = np.bincount(
        pair_index.ravel(),
        minlength=(reference_count + 1) * (prediction_count + 1),
    ).reshape(reference_count + 1, prediction_count + 1)
    intersections = contingency[1:, 1:].astype(np.float64)
    reference_area = contingency[1:, :].sum(axis=1, keepdims=True)
    prediction_area = contingency[:, 1:].sum(axis=0, keepdims=True)
    unions = reference_area + prediction_area - intersections
    return np.divide(intersections, unions, out=np.zeros_like(intersections), where=unions > 0)


def _maximum_cardinality_matches(ious: np.ndarray, threshold: float) -> int:
    """Count deterministic one-to-one matches at ``threshold``.

    Candidate predictions are visited by descending IoU and then label index.
    The augmenting-path matcher maximizes the number of qualifying pairs, rather
    than maximizing total IoU and only then applying the threshold.
    """

    reference_count, prediction_count = ious.shape
    if reference_count == 0 or prediction_count == 0:
        return 0
    candidates = [
        sorted(
            (
                prediction_index
                for prediction_index in range(prediction_count)
                if ious[reference_index, prediction_index] >= threshold
            ),
            key=lambda prediction_index: (
                -ious[reference_index, prediction_index],
                prediction_index,
            ),
        )
        for reference_index in range(reference_count)
    ]
    reference_for_prediction = [-1] * prediction_count

    def augment(reference_index: int, visited_predictions: list[bool]) -> bool:
        for prediction_index in candidates[reference_index]:
            if visited_predictions[prediction_index]:
                continue
            visited_predictions[prediction_index] = True
            previous_reference = reference_for_prediction[prediction_index]
            if previous_reference == -1 or augment(previous_reference, visited_predictions):
                reference_for_prediction[prediction_index] = reference_index
                return True
        return False

    matches = 0
    for reference_index in range(reference_count):
        if augment(reference_index, [False] * prediction_count):
            matches += 1
    return matches


def _threshold_metrics(
    ious: np.ndarray,
    *,
    reference_count: int,
    prediction_count: int,
    threshold: float,
) -> dict[str, float | int]:
    true_positive = _maximum_cardinality_matches(ious, threshold)
    false_positive = prediction_count - true_positive
    false_negative = reference_count - true_positive
    f1_denominator = 2 * true_positive + false_positive + false_negative
    ap_denominator = true_positive + false_positive + false_negative
    f1 = 1.0 if f1_denominator == 0 else 2 * true_positive / f1_denominator
    average_precision = 1.0 if ap_denominator == 0 else true_positive / ap_denominator
    suffix = f"{threshold:.2f}"
    return {
        f"true-positive-instances-at-iou-{suffix}": true_positive,
        f"false-positive-instances-at-iou-{suffix}": false_positive,
        f"false-negative-instances-at-iou-{suffix}": false_negative,
        f"instance-f1-at-iou-{suffix}": float(f1),
        f"instance-ap-at-iou-{suffix}": float(average_precision),
    }


def instance_validation_metrics(
    reference: np.ndarray,
    prediction: np.ndarray,
    *,
    strata: Mapping[str, str],
) -> dict[str, object]:
    """Evaluate one image using deterministic one-to-one instance matching.

    ``strata`` must be declared before final-test evaluation, for example
    ``{"acquisition-group": "day-2", "density-quartile": "q4"}``.
    """

    if reference.shape != prediction.shape:
        raise ValueError("reference and prediction shapes must match")
    if not strata:
        raise ValueError("at least one validation stratum must be declared")
    normalized_strata: dict[str, str] = {}
    for dimension, name in sorted(strata.items()):
        if not isinstance(dimension, str) or not dimension.strip():
            raise ValueError("stratum dimensions must be non-empty strings")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("stratum names must be non-empty strings")
        normalized_strata[dimension] = name

    truth = _sequential_labels(reference, name="reference")
    predicted = _sequential_labels(prediction, name="prediction")
    reference_count = int(truth.max())
    prediction_count = int(predicted.max())
    count_error = prediction_count - reference_count
    absolute_percentage_error = (
        None if reference_count == 0 else 100.0 * abs(count_error) / reference_count
    )
    metrics: dict[str, object] = {
        "reference-count": reference_count,
        "predicted-count": prediction_count,
        "count-error": count_error,
        "absolute-percentage-count-error-percent": absolute_percentage_error,
        "strata": normalized_strata,
    }
    ious = _iou_matrix(truth, predicted)
    for threshold in IOU_THRESHOLDS:
        metrics.update(
            _threshold_metrics(
                ious,
                reference_count=reference_count,
                prediction_count=prediction_count,
                threshold=threshold,
            )
        )
    return metrics


def _pooled_instance_metrics(
    rows: Sequence[Mapping[str, object]],
    threshold: float,
) -> tuple[float, float]:
    suffix = f"{threshold:.2f}"
    true_positive = sum(int(row[f"true-positive-instances-at-iou-{suffix}"]) for row in rows)
    false_positive = sum(int(row[f"false-positive-instances-at-iou-{suffix}"]) for row in rows)
    false_negative = sum(int(row[f"false-negative-instances-at-iou-{suffix}"]) for row in rows)
    f1_denominator = 2 * true_positive + false_positive + false_negative
    ap_denominator = true_positive + false_positive + false_negative
    f1 = 1.0 if f1_denominator == 0 else 2 * true_positive / f1_denominator
    average_precision = 1.0 if ap_denominator == 0 else true_positive / ap_denominator
    return float(f1), float(average_precision)


def _summarize_rows(rows: Sequence[Mapping[str, object]]) -> dict[str, float | int | None]:
    if not rows:
        raise ValueError("at least one validation row is required")
    reference_total = sum(int(row["reference-count"]) for row in rows)
    prediction_total = sum(int(row["predicted-count"]) for row in rows)
    aggregate_bias = (
        None
        if reference_total == 0
        else 100.0 * (prediction_total - reference_total) / reference_total
    )
    percentage_errors = np.asarray(
        [
            float(row["absolute-percentage-count-error-percent"])
            for row in rows
            if row["absolute-percentage-count-error-percent"] is not None
        ],
        dtype=np.float64,
    )
    metrics: dict[str, float | int | None] = {
        "reference-instance-count": reference_total,
        "predicted-instance-count": prediction_total,
        "aggregate-count-bias-percent": aggregate_bias,
        "absolute-aggregate-count-bias-percent": (
            None if aggregate_bias is None else abs(aggregate_bias)
        ),
        "median-per-image-absolute-percentage-count-error-percent": (
            None if not len(percentage_errors) else float(np.median(percentage_errors))
        ),
        "p90-per-image-absolute-percentage-count-error-percent": (
            None if not len(percentage_errors) else float(np.percentile(percentage_errors, 90))
        ),
        "percentage-metric-image-count": int(len(percentage_errors)),
        "zero-reference-image-count": len(rows) - int(len(percentage_errors)),
    }
    for threshold in IOU_THRESHOLDS:
        f1, average_precision = _pooled_instance_metrics(rows, threshold)
        suffix = f"{threshold:.2f}"
        metrics[f"instance-f1-at-iou-{suffix}"] = f1
        metrics[f"instance-ap-at-iou-{suffix}"] = average_precision
    return metrics


def _stratified_summaries(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    grouped: dict[tuple[str, str], list[Mapping[str, object]]] = defaultdict(list)
    dimensions: set[str] | None = None
    for row in rows:
        strata = row.get("strata")
        if not isinstance(strata, Mapping) or not strata:
            raise ValueError("every validation row must contain declared strata")
        row_dimensions = {str(dimension) for dimension in strata}
        if dimensions is None:
            dimensions = row_dimensions
        elif row_dimensions != dimensions:
            raise ValueError("every validation row must declare the same stratum dimensions")
        for dimension, name in strata.items():
            if not isinstance(dimension, str) or not dimension.strip():
                raise ValueError("stratum dimensions must be non-empty strings")
            if not isinstance(name, str) or not name.strip():
                raise ValueError("stratum names must be non-empty strings")
            grouped[(dimension, name)].append(row)
    return [
        {
            "dimension": dimension,
            "name": name,
            "sample_count": len(group_rows),
            "metrics": _summarize_rows(group_rows),
        }
        for (dimension, name), group_rows in sorted(grouped.items())
    ]


def _evaluate_gates(
    metrics: Mapping[str, float | int | None],
    gates: Sequence[GateDefinition],
) -> list[dict[str, object]]:
    outcomes: list[dict[str, object]] = []
    for gate in gates:
        value = metrics.get(gate.metric_id)
        evaluated = isinstance(value, (int, float)) and not isinstance(value, bool)
        passed = bool(
            evaluated
            and (value <= gate.threshold if gate.operator == "<=" else value >= gate.threshold)
        )
        outcomes.append(
            {
                "metric_id": gate.metric_id,
                "operator": gate.operator,
                "threshold": gate.threshold,
                "value": value,
                "evaluated": evaluated,
                "passed": passed,
            }
        )
    return outcomes


def aggregate_validation_metrics(
    rows: Sequence[Mapping[str, object]],
    *,
    gates: Sequence[GateDefinition] = FROZEN_CULTURED_CELL_GATES,
) -> dict[str, object]:
    """Aggregate a locked test set with pooled instance and stratified metrics.

    Count bias is computed from total predicted and reference instances. This is
    deliberately not the macro mean of signed per-image percentage errors.
    """

    if not rows:
        raise ValueError("at least one validation row is required")
    validated_gates = _validated_gate_configuration(gates)

    metrics = _summarize_rows(rows)
    strata = _stratified_summaries(rows)
    stratum_medians = [
        summary["metrics"]["median-per-image-absolute-percentage-count-error-percent"]
        for summary in strata
    ]
    metrics["maximum-stratum-median-absolute-percentage-count-error-percent"] = (
        None
        if any(value is None for value in stratum_medians)
        else max(float(value) for value in stratum_medians)
    )

    return {
        "schema_version": VALIDATION_METRICS_SCHEMA,
        "protocol_id": CULTURED_CELL_PROTOCOL_ID,
        "gate_configuration_sha256": gate_configuration_sha256(validated_gates),
        "image_count": len(rows),
        "metrics": metrics,
        "gates": _evaluate_gates(metrics, validated_gates),
        "strata": strata,
    }
