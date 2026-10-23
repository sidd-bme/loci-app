"""V2 empty-set definitions and exact-cohort guards; synthetic numbers only."""

from __future__ import annotations

import copy
import importlib.util
import json
import math
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "fluorescence_summary",
    Path(__file__).parents[1] / "qa/real_fluorescence_summary.py",
)
summary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary)


def field(key="field", *, g=5, p=5, tp50=None, tp75=None):
    tp50 = min(g, p) if tp50 is None else tp50
    tp75 = tp50 if tp75 is None else tp75
    scores = []
    for threshold, tp in [(0.5, tp50), (0.75, tp75)]:
        fp, fn = p - tp, g - tp
        scores.append(
            {
                "iou_threshold": threshold,
                "true_positive": tp,
                "false_positive": fp,
                "false_negative": fn,
                "f1": 2 * tp / (2 * tp + fp + fn) if g + p else None,
            }
        )
    return {
        "source_key": key,
        "instance_metrics": {
            "truth_count": g,
            "predicted_count": p,
            "count_error_signed": p - g,
            "count_error_absolute": abs(p - g),
            "count_error_relative": abs(p - g) / g if g else None,
            "scores": scores,
        },
    }


def one(record):
    return summary.summarize_fields([record], [record["source_key"]])


def test_both_empty_preserves_ordinary_undefined_and_adds_perfect_convention():
    result = one(field(g=0, p=0))
    f = result["fields"][0]
    assert f["ordinary_relative_count_error"] is None
    assert f["extended_relative_count_loss"] == {"status": "finite", "value": 0}
    assert all(
        s["ordinary_f1"] is None and s["qualification_f1"] == 1 for s in f["scores"]
    )
    assert result["v1"]["status"] == "unestablished"
    assert not result["v1"]["metric_targets_met"]
    assert result["v2"]["metric_targets_met"]
    assert result["counts"]["both_zero_fields"] == ["field"]


def test_empty_reference_false_positives_are_infinite_and_f1_zero():
    result = one(field(g=0, p=3))
    f = result["fields"][0]
    assert f["ordinary_relative_count_error"] is None
    assert f["extended_relative_count_loss"] == {
        "status": "positive-infinity",
        "value": None,
    }
    assert (
        result["v2"]["median_extended_relative_count_loss"]
        == f["extended_relative_count_loss"]
    )
    assert all(s["ordinary_f1"] == s["qualification_f1"] == 0 for s in f["scores"])
    assert result["counts"]["zero_reference_false_positive_fields"] == ["field"]
    assert result["counts"]["scores"] == [
        {
            "iou_threshold": t,
            "true_positive": 0,
            "false_positive": 3,
            "false_negative": 0,
        }
        for t in (0.5, 0.75)
    ]
    assert not result["v2"]["metric_targets_met"]


def test_positive_reference_empty_prediction_is_finite_loss_one():
    result = one(field(g=4, p=0))
    assert result["fields"][0]["extended_relative_count_loss"] == {
        "status": "finite",
        "value": 1,
    }
    assert result["v1"]["median_ordinary_relative_count_error"] == 1
    assert result["counts"]["scores"][0]["false_negative"] == 4
    assert result["v1"]["status"] == "metric-targets-not-met"
    assert not result["v2"]["metric_targets_met"]


def test_positive_metrics_and_records_are_unchanged_and_input_is_not_mutated():
    record = field(g=5, p=6, tp50=4, tp75=3)
    before = copy.deepcopy(record)
    result = one(record)
    assert record == before
    f = result["fields"][0]
    assert (
        f["ordinary_relative_count_error"]
        == f["extended_relative_count_loss"]["value"]
        == 0.2
    )
    for index, score in enumerate(f["scores"]):
        assert (
            score["ordinary_f1"]
            == score["qualification_f1"]
            == record["instance_metrics"]["scores"][index]["f1"]
        )
    assert result["v1"]["median_ordinary_f1"] == result["v2"]["median_qualification_f1"]
    f["scores"][0]["true_positive"] = 999
    assert record == before


@pytest.mark.parametrize(
    "infinite_fields, median_status, v2_met",
    [(23, "finite", True), (24, "positive-infinity", False)],
)
def test_all47_median_boundary_and_background_counterexample(
    infinite_fields, median_status, v2_met
):
    fields = [
        field(str(i), g=0, p=1) if i < infinite_fields else field(str(i), g=1, p=1)
        for i in range(47)
    ]
    result = summary.summarize_qualification(fields, [str(i) for i in range(47)])
    assert result["field_count"] == len(result["fields"]) == 47
    assert result["v2"]["median_order_statistic"] == 24
    assert result["v2"]["median_extended_relative_count_loss"] == {
        "status": median_status,
        "value": 0 if median_status == "finite" else None,
    }
    assert result["v2"]["metric_targets_met"] is v2_met
    assert len(result["v2"]["positive_infinity_loss_fields"]) == infinite_fields
    assert result["v1"]["status"] == "unestablished"
    assert result["v1"]["median_ordinary_relative_count_error"] is None
    assert result["counts"]["scores"][0]["false_positive"] == infinite_fields
    assert result["counts"]["scores"][0]["true_positive"] == 47 - infinite_fields
    encoded = json.dumps(result, allow_nan=False)
    assert "Infinity" not in encoded and "NaN" not in encoded
    assert json.loads(encoded) == result


def test_exact47_both_empty_fields_qualify_only_v2_metric_convention():
    fields = [field(str(i), g=0, p=0) for i in range(47)]
    result = summary.summarize_qualification(fields, [str(i) for i in range(47)])
    assert result["v1"]["status"] == "unestablished"
    assert len(result["v1"]["undefined_f1_fields"]) == 47
    assert result["v2"]["metric_targets_met"]
    assert "only" in result["scope"]


def test_gate_thresholds_are_inclusive_and_f1_075_is_reported_separately():
    # F1 .85 at .50, F1 .84 at .75; only .50 is the primary F1 gate.
    record = field(g=200, p=200, tp50=170, tp75=168)
    assert one(record)["v2"]["metric_targets_met"]
    count_boundary = field(g=10, p=11)
    assert one(count_boundary)["v1"]["metric_targets_met"]
    assert one(count_boundary)["v2"]["metric_targets_met"]
    assert not one(field(g=10, p=12))["v2"]["metric_targets_met"]
    assert not one(field(g=200, p=200, tp50=169))["v2"]["metric_targets_met"]


def test_positive_v1_and_v2_summary_match_without_undefined_fields():
    result = summary.summarize_fields(
        [field("b", g=10, p=11), field("a", g=10, p=9)], ["a", "b"]
    )
    assert [f["source_key"] for f in result["fields"]] == ["a", "b"]
    assert result["v1"]["status"] == "metric-targets-met"
    assert (
        result["v1"]["median_ordinary_relative_count_error"]
        == result["v2"]["median_extended_relative_count_loss"]["value"]
    )
    assert (
        result["counts"]["reference_total"] == result["counts"]["predicted_total"] == 20
    )


def test_even_cohort_infinity_is_not_dropped_and_large_finite_median_does_not_overflow():
    result = summary.summarize_fields([field("a", g=0, p=1), field("b")], ["a", "b"])
    assert (
        result["v2"]["median_extended_relative_count_loss"]["status"]
        == "positive-infinity"
    )
    result = summary.summarize_fields(
        [field("a", g=1, p=10**308), field("b", g=1, p=10**308)], ["a", "b"]
    )
    assert math.isfinite(result["v1"]["median_ordinary_relative_count_error"])
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize(
    "key,value",
    [
        ("truth_count", -1),
        ("truth_count", 5.0),
        ("truth_count", True),
        ("predicted_count", -1),
        ("predicted_count", math.inf),
        ("predicted_count", math.nan),
        ("predicted_count", "5"),
        ("count_error_signed", 1),
        ("count_error_absolute", -1),
        ("count_error_absolute", 1),
        ("count_error_relative", None),
        ("count_error_relative", -0.1),
        ("count_error_relative", 0.1),
        ("count_error_relative", math.nan),
        ("count_error_relative", math.inf),
        ("count_error_relative", True),
    ],
)
def test_reject_invalid_counts_and_ordinary_relative_errors(key, value):
    record = field()
    record["instance_metrics"][key] = value
    with pytest.raises(ValueError):
        one(record)


@pytest.mark.parametrize(
    "key,value",
    [
        ("true_positive", -1),
        ("true_positive", 6),
        ("false_positive", 1),
        ("false_negative", 1),
        ("false_negative", False),
        ("true_positive", 5.0),
        ("f1", None),
        ("f1", -0.1),
        ("f1", 1.01),
        ("f1", 0.9),
        ("f1", math.nan),
        ("f1", math.inf),
        ("f1", True),
        ("iou_threshold", math.nan),
        ("iou_threshold", 0.6),
    ],
)
def test_reject_invalid_matching_counts_and_f1(key, value):
    record = field()
    record["instance_metrics"]["scores"][0][key] = value
    with pytest.raises(ValueError):
        one(record)


@pytest.mark.parametrize(
    "record, key",
    [(field(), "truth_count"), (field(), "count_error_relative"), (field(), "scores")],
)
def test_reject_missing_required_metrics(record, key):
    record = copy.deepcopy(record)
    del record["instance_metrics"][key]
    with pytest.raises(ValueError, match="Missing metric key"):
        one(record)


def test_reject_missing_or_duplicate_thresholds_and_increasing_matches():
    for scores in (
        [],
        field()["instance_metrics"]["scores"][:1],
        [field()["instance_metrics"]["scores"][0]] * 2,
        None,
    ):
        record = field()
        record["instance_metrics"]["scores"] = scores
        with pytest.raises(ValueError):
            one(record)
    with pytest.raises(ValueError, match="stricter"):
        one(field(g=2, p=2, tp50=0, tp75=1))
    record = field()
    del record["instance_metrics"]["scores"][0]["f1"]
    with pytest.raises(ValueError, match="Missing metric key"):
        one(record)


@pytest.mark.parametrize(
    "g,p,key,value",
    [
        (0, 0, "count_error_relative", 0),
        (0, 1, "count_error_relative", 0),
        (0, 0, "f1", 1),
        (0, 1, "f1", None),
    ],
)
def test_reject_ordinary_zero_denominator_imputation(g, p, key, value):
    record = field(g=g, p=p)
    if key == "f1":
        record["instance_metrics"]["scores"][0][key] = value
    else:
        record["instance_metrics"][key] = value
    with pytest.raises(ValueError):
        one(record)


@pytest.mark.parametrize(
    "fields,keys",
    [
        ([], []),
        ([field()], []),
        ([field()], ["other"]),
        ([field()], ["field", "missing"]),
        ([field(), field()], ["field"]),
        ([field()], ["field", "field"]),
        ([field()], "field"),
        ([field("")], [""]),
        ([field(" ")], [" "]),
        ([field(1)], [1]),
        ([{}], ["field"]),
        ([None], ["field"]),
        (None, ["field"]),
        ({"field": field()}, ["field"]),
    ],
)
def test_reject_incomplete_duplicate_or_malformed_cohort(fields, keys):
    with pytest.raises(ValueError):
        summary.summarize_fields(fields, keys)


@pytest.mark.parametrize("count", [1, 46, 48])
def test_qualification_requires_exact47(count):
    fields = [field(str(i)) for i in range(count)]
    with pytest.raises(ValueError, match="47"):
        summary.summarize_qualification(fields, [str(i) for i in range(count)])
