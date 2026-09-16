from __future__ import annotations

from dataclasses import FrozenInstanceError

import numpy as np
import pytest

from loci_modeling.validation_metrics import (
    FROZEN_CULTURED_CELL_GATES,
    GateDefinition,
    aggregate_validation_metrics,
    gate_configuration_sha256,
    instance_validation_metrics,
)


def _labels(count: int, *, width: int = 12) -> np.ndarray:
    labels = np.zeros((1, width), dtype=np.int32)
    if count:
        labels[0, :count] = np.arange(1, count + 1, dtype=np.int32)
    return labels


def _row(
    reference_count: int,
    prediction_count: int,
    *,
    acquisition_group: str,
    density_quartile: str,
) -> dict[str, object]:
    return instance_validation_metrics(
        _labels(reference_count),
        _labels(prediction_count),
        strata={
            "acquisition-group": acquisition_group,
            "density-quartile": density_quartile,
        },
    )


def test_one_to_one_instance_metrics_are_exact_at_iou_50_and_75() -> None:
    reference = np.asarray(
        [
            [1, 1, 0, 2, 2],
            [1, 1, 0, 2, 2],
        ],
        dtype=np.int32,
    )
    perfect = instance_validation_metrics(
        reference,
        reference.copy(),
        strata={"acquisition-group": "day-1"},
    )
    missed = instance_validation_metrics(
        reference,
        np.where(reference == 2, 0, reference),
        strata={"acquisition-group": "day-1"},
    )

    assert perfect["instance-f1-at-iou-0.50"] == pytest.approx(1.0)
    assert perfect["instance-ap-at-iou-0.50"] == pytest.approx(1.0)
    assert perfect["instance-f1-at-iou-0.75"] == pytest.approx(1.0)
    assert perfect["instance-ap-at-iou-0.75"] == pytest.approx(1.0)
    assert missed["true-positive-instances-at-iou-0.50"] == 1
    assert missed["false-positive-instances-at-iou-0.50"] == 0
    assert missed["false-negative-instances-at-iou-0.50"] == 1
    assert missed["instance-f1-at-iou-0.50"] == pytest.approx(2 / 3)
    assert missed["instance-ap-at-iou-0.50"] == pytest.approx(1 / 2)


def test_split_prediction_is_deterministically_matched_only_once() -> None:
    reference = np.ones((2, 4), dtype=np.int32)
    prediction = np.asarray(
        [
            [1, 1, 2, 2],
            [1, 1, 2, 2],
        ],
        dtype=np.int32,
    )
    results = [
        instance_validation_metrics(
            reference,
            prediction,
            strata={"acquisition-group": "day-1"},
        )
        for _ in range(5)
    ]

    assert all(result == results[0] for result in results[1:])
    assert results[0]["true-positive-instances-at-iou-0.50"] == 1
    assert results[0]["false-positive-instances-at-iou-0.50"] == 1
    assert results[0]["false-negative-instances-at-iou-0.50"] == 0
    assert results[0]["instance-f1-at-iou-0.50"] == pytest.approx(2 / 3)
    assert results[0]["instance-ap-at-iou-0.50"] == pytest.approx(1 / 2)
    assert results[0]["true-positive-instances-at-iou-0.75"] == 0


def test_aggregate_bias_uses_pooled_counts_not_macro_signed_percentages() -> None:
    overcount = _row(1, 2, acquisition_group="day-a", density_quartile="q1")
    undercount = _row(10, 8, acquisition_group="day-b", density_quartile="q4")
    report = aggregate_validation_metrics([overcount, undercount])
    metrics = report["metrics"]

    assert metrics["aggregate-count-bias-percent"] == pytest.approx(-100 / 11)
    assert metrics["absolute-aggregate-count-bias-percent"] == pytest.approx(100 / 11)
    assert metrics["median-per-image-absolute-percentage-count-error-percent"] == pytest.approx(
        60.0
    )
    assert metrics["p90-per-image-absolute-percentage-count-error-percent"] == pytest.approx(92.0)
    assert metrics["instance-f1-at-iou-0.50"] == pytest.approx(18 / 21)
    assert metrics["instance-ap-at-iou-0.50"] == pytest.approx(9 / 12)
    assert metrics[
        "maximum-stratum-median-absolute-percentage-count-error-percent"
    ] == pytest.approx(100.0)
    assert len(report["strata"]) == 4

    gates = {gate["metric_id"]: gate for gate in report["gates"]}
    assert gates["instance-f1-at-iou-0.50"]["passed"] is True
    assert gates["instance-ap-at-iou-0.50"]["passed"] is True
    assert gates["absolute-aggregate-count-bias-percent"]["passed"] is False
    assert (
        gates["maximum-stratum-median-absolute-percentage-count-error-percent"]["passed"] is False
    )


def test_zero_reference_images_are_excluded_from_ape_but_not_pooled_bias() -> None:
    empty_reference = _row(0, 2, acquisition_group="day-a", density_quartile="q0")
    defined = _row(1, 1, acquisition_group="day-b", density_quartile="q1")
    report = aggregate_validation_metrics([empty_reference, defined])
    metrics = report["metrics"]

    assert empty_reference["absolute-percentage-count-error-percent"] is None
    assert metrics["percentage-metric-image-count"] == 1
    assert metrics["zero-reference-image-count"] == 1
    assert metrics["aggregate-count-bias-percent"] == pytest.approx(200.0)
    assert metrics["median-per-image-absolute-percentage-count-error-percent"] == pytest.approx(0.0)
    assert metrics["maximum-stratum-median-absolute-percentage-count-error-percent"] is None
    stratum_gate = next(
        gate
        for gate in report["gates"]
        if gate["metric_id"] == "maximum-stratum-median-absolute-percentage-count-error-percent"
    )
    assert stratum_gate["evaluated"] is False
    assert stratum_gate["passed"] is False


def test_perfect_locked_set_passes_frozen_gates_and_reports_strata() -> None:
    rows = [
        _row(2, 2, acquisition_group="day-a", density_quartile="q1"),
        _row(4, 4, acquisition_group="day-b", density_quartile="q4"),
    ]
    report = aggregate_validation_metrics(rows)

    assert report["schema_version"] == "loci.validation-metrics/v1"
    assert report["protocol_id"] == "cultured-cell-counting-v1"
    assert report["gate_configuration_sha256"] == gate_configuration_sha256()
    assert all(gate["passed"] is True for gate in report["gates"])
    assert {(stratum["dimension"], stratum["name"]) for stratum in report["strata"]} == {
        ("acquisition-group", "day-a"),
        ("acquisition-group", "day-b"),
        ("density-quartile", "q1"),
        ("density-quartile", "q4"),
    }


def test_gate_configuration_is_immutable_and_digest_changes_with_threshold() -> None:
    digest = gate_configuration_sha256()
    assert len(digest) == 64
    assert digest == gate_configuration_sha256()
    altered = (*FROZEN_CULTURED_CELL_GATES[:-1], GateDefinition("new-metric", ">=", 1.0))
    assert gate_configuration_sha256(altered) != digest
    with pytest.raises(FrozenInstanceError):
        FROZEN_CULTURED_CELL_GATES[0].threshold = 6.0  # type: ignore[misc]


@pytest.mark.parametrize(
    ("gate", "message"),
    [
        (
            GateDefinition(
                "instance-f1-at-iou-0.50",
                "==",  # type: ignore[arg-type]
                0.85,
            ),
            "unsupported operator",
        ),
        (
            GateDefinition(
                "instance-f1-at-iou-0.50",
                ">=",
                float("nan"),
            ),
            "finite threshold",
        ),
        (
            GateDefinition(
                " instance-f1-at-iou-0.50",
                ">=",
                0.85,
            ),
            "invalid metric identifier",
        ),
    ],
)
def test_malformed_custom_gate_configuration_fails_closed(
    gate: GateDefinition,
    message: str,
) -> None:
    rows = [_row(2, 2, acquisition_group="day-a", density_quartile="q1")]

    with pytest.raises(ValueError, match=message):
        gate_configuration_sha256((gate,))
    with pytest.raises(ValueError, match=message):
        aggregate_validation_metrics(rows, gates=(gate,))


def test_duplicate_custom_gate_identifiers_are_rejected_by_digest_and_report() -> None:
    duplicate = (
        GateDefinition("instance-f1-at-iou-0.50", ">=", 0.85),
        GateDefinition("instance-f1-at-iou-0.50", ">=", 0.90),
    )
    rows = [_row(2, 2, acquisition_group="day-a", density_quartile="q1")]

    with pytest.raises(ValueError, match="must be unique"):
        gate_configuration_sha256(duplicate)
    with pytest.raises(ValueError, match="must be unique"):
        aggregate_validation_metrics(rows, gates=duplicate)


def test_invalid_labels_and_inconsistent_strata_fail_closed() -> None:
    with pytest.raises(ValueError, match="shapes must match"):
        instance_validation_metrics(
            np.zeros((2, 2), dtype=np.int32),
            np.zeros((3, 2), dtype=np.int32),
            strata={"acquisition-group": "day-a"},
        )
    with pytest.raises(ValueError, match="non-negative"):
        instance_validation_metrics(
            np.asarray([[-1]], dtype=np.int32),
            np.zeros((1, 1), dtype=np.int32),
            strata={"acquisition-group": "day-a"},
        )
    with pytest.raises(ValueError, match="at least one validation stratum"):
        instance_validation_metrics(
            np.zeros((1, 1), dtype=np.int32),
            np.zeros((1, 1), dtype=np.int32),
            strata={},
        )

    first = _row(1, 1, acquisition_group="day-a", density_quartile="q1")
    second = instance_validation_metrics(
        _labels(1),
        _labels(1),
        strata={"acquisition-group": "day-b"},
    )
    with pytest.raises(ValueError, match="same stratum dimensions"):
        aggregate_validation_metrics([first, second])
