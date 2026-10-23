"""Pure V1/V2 metric summaries; no images, files, Loci imports or packet mutation.

Inputs are existing oracle records: source_key and instance_metrics with counts,
signed/absolute/ordinary relative errors, and scores at IoU 0.50 and 0.75. Other
oracle/export metadata is not assessed here. This is never a workflow validator.
"""

# Invalid scientific metric documents consistently raise ValueError, like the oracle.
# ruff: noqa: TRY004

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from statistics import median

THRESHOLDS = (0.5, 0.75)
MINIMUM_MEDIAN_F1 = 0.85
MAXIMUM_MEDIAN_COUNT_LOSS = 0.10


def _integer(value, name, *, signed=False):
    if type(value) is not int or (not signed and value < 0):
        raise ValueError(f"{name} must be an integer" + ("" if signed else " >= 0"))
    return value


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError(f"{name} must be a finite number")
    return value


def _consistent(value, expected, name):
    if expected is None:
        if value is not None:
            raise ValueError(f"{name} must remain undefined (None)")
    elif _number(value, name) != expected:
        raise ValueError(f"{name} disagrees with supplied integer counts")
    return expected


def _keys(values, name):
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        raise ValueError(f"{name} must be a sequence")
    keys = list(values)
    if not keys or any(not isinstance(k, str) or not k.strip() for k in keys):
        raise ValueError(f"{name} must contain nonempty string keys")
    if len(set(keys)) != len(keys):
        raise ValueError(f"{name} contains duplicate keys")
    return keys


def _encoded_loss(value):
    if value is None:
        return {"status": "positive-infinity", "value": None}
    return {"status": "finite", "value": value}


def _ordinary_median(values):
    return (
        _extended_median(values)["value"]
        if all(v is not None for v in values)
        else None
    )


def _extended_median(values):
    # None is the explicit +infinity sentinel, ordered after every finite value.
    ordered = sorted(values, key=lambda v: (v is None, v if v is not None else 0))
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return _encoded_loss(ordered[middle])
    a, b = ordered[middle - 1 : middle + 1]
    return _encoded_loss(None if a is None or b is None else a / 2 + b / 2)


def _field(record):
    if not isinstance(record, Mapping) or not isinstance(
        record.get("instance_metrics"), Mapping
    ):
        raise ValueError("Each field needs source_key and instance_metrics")
    try:
        m = record["instance_metrics"]
        g = _integer(m["truth_count"], "truth_count")
        p = _integer(m["predicted_count"], "predicted_count")
        signed = _integer(m["count_error_signed"], "count_error_signed", signed=True)
        absolute = _integer(m["count_error_absolute"], "count_error_absolute")
        if signed != p - g or absolute != abs(p - g):
            raise ValueError("Signed/absolute count error disagrees with counts")
        try:
            relative = abs(p - g) / g if g else None
        except OverflowError as exc:
            raise ValueError(
                "Positive-reference relative error must be finite"
            ) from exc
        if relative is not None:
            _number(relative, "derived relative error")
        _consistent(m["count_error_relative"], relative, "count_error_relative")
        scores = m["scores"]
        if (
            not isinstance(scores, Sequence)
            or isinstance(scores, (str, bytes))
            or len(scores) != 2
        ):
            raise ValueError("Exactly two IoU scores are required")
        by_threshold = {}
        for score in scores:
            if not isinstance(score, Mapping):
                raise ValueError("IoU score must be a mapping")
            threshold = _number(score["iou_threshold"], "iou_threshold")
            if threshold not in THRESHOLDS or threshold in by_threshold:
                raise ValueError("IoU thresholds must be uniquely 0.50 and 0.75")
            tp = _integer(score["true_positive"], "true_positive")
            fp = _integer(score["false_positive"], "false_positive")
            fn = _integer(score["false_negative"], "false_negative")
            if tp + fp != p or tp + fn != g:
                raise ValueError("TP/FP/FN disagree with reference/predicted counts")
            denominator = 2 * tp + fp + fn
            f1 = 2 * tp / denominator if denominator else None
            _consistent(score["f1"], f1, "f1")
            by_threshold[threshold] = {
                "iou_threshold": threshold,
                "true_positive": tp,
                "false_positive": fp,
                "false_negative": fn,
                "ordinary_f1": f1,
                "qualification_f1": 1.0 if g == p == 0 else f1,
            }
        if by_threshold[0.75]["true_positive"] > by_threshold[0.5]["true_positive"]:
            raise ValueError("TP cannot increase at the stricter IoU threshold")
    except KeyError as exc:
        raise ValueError(f"Missing metric key: {exc.args[0]}") from exc
    loss = relative if g else (0.0 if p == 0 else None)
    return {
        "source_key": record["source_key"],
        "truth_count": g,
        "predicted_count": p,
        "count_error_signed": signed,
        "count_error_absolute": absolute,
        "ordinary_relative_count_error": relative,
        "extended_relative_count_loss": _encoded_loss(loss),
        "scores": [by_threshold[t] for t in THRESHOLDS],
    }


def summarize_fields(fields, expected_source_keys):
    """Describe an exact explicit cohort without reading data or qualifying a run.

    Uses Python/JSON scalar inputs; bool counts and nonfinite numbers are invalid.
    Supplied ordinary relative errors/F1 must equal their integer-count formula.
    Output is JSON-safe with allow_nan=False, including extended infinite losses.
    """
    expected = _keys(expected_source_keys, "Expected cohort")
    if not isinstance(fields, Sequence) or isinstance(fields, (str, bytes)):
        raise ValueError("Fields must be a sequence")
    if any(not isinstance(f, Mapping) or "source_key" not in f for f in fields):
        raise ValueError("Each field requires source_key")
    actual = _keys([f["source_key"] for f in fields], "Fields")
    if set(actual) != set(expected):
        raise ValueError("Fields do not exactly match the expected cohort")
    by_key = {f["source_key"]: f for f in fields}
    checked = [_field(by_key[key]) for key in expected]
    relative = [f["ordinary_relative_count_error"] for f in checked]
    losses = [f["extended_relative_count_loss"]["value"] for f in checked]
    ordinary_f1 = [
        _ordinary_median([f["scores"][i]["ordinary_f1"] for f in checked])
        for i in range(2)
    ]
    qualification_f1 = [
        median(f["scores"][i]["qualification_f1"] for f in checked) for i in range(2)
    ]
    ordinary_count = _ordinary_median(relative)
    extended_count = _extended_median(losses)
    ordinary_defined = ordinary_count is not None and all(
        v is not None for v in ordinary_f1
    )
    v1_met = (
        ordinary_defined
        and ordinary_f1[0] >= MINIMUM_MEDIAN_F1
        and ordinary_count <= MAXIMUM_MEDIAN_COUNT_LOSS
    )
    v2_met = (
        qualification_f1[0] >= MINIMUM_MEDIAN_F1
        and extended_count["status"] == "finite"
        and extended_count["value"] <= MAXIMUM_MEDIAN_COUNT_LOSS
    )
    return {
        "schema": "loci.real-fluorescence.metric-summary/v2",
        "scope": "descriptive exact-cohort metric summary; not whole-workflow qualification",
        "field_count": len(checked),
        "expected_source_keys": expected,
        "thresholds": {
            "median_f1_IoU_0_50_minimum": MINIMUM_MEDIAN_F1,
            "median_count_loss_maximum": MAXIMUM_MEDIAN_COUNT_LOSS,
        },
        "v1": {
            "status": "unestablished"
            if not ordinary_defined
            else "metric-targets-met"
            if v1_met
            else "metric-targets-not-met",
            "metric_targets_met": v1_met,
            "median_ordinary_relative_count_error": ordinary_count,
            "median_ordinary_f1": [
                {"iou_threshold": t, "value": ordinary_f1[i]}
                for i, t in enumerate(THRESHOLDS)
            ],
            "undefined_relative_error_fields": [
                f["source_key"]
                for f in checked
                if f["ordinary_relative_count_error"] is None
            ],
            "undefined_f1_fields": [
                f["source_key"]
                for f in checked
                if any(s["ordinary_f1"] is None for s in f["scores"])
            ],
        },
        "v2": {
            "status": "metric-targets-met" if v2_met else "metric-targets-not-met",
            "metric_targets_met": v2_met,
            "median_extended_relative_count_loss": extended_count,
            "median_qualification_f1": [
                {"iou_threshold": t, "value": qualification_f1[i]}
                for i, t in enumerate(THRESHOLDS)
            ],
            "positive_infinity_loss_fields": [
                f["source_key"]
                for f in checked
                if f["extended_relative_count_loss"]["status"] == "positive-infinity"
            ],
        },
        "counts": {
            "reference_total": sum(f["truth_count"] for f in checked),
            "predicted_total": sum(f["predicted_count"] for f in checked),
            "zero_reference_fields": [
                f["source_key"] for f in checked if f["truth_count"] == 0
            ],
            "both_zero_fields": [
                f["source_key"]
                for f in checked
                if f["truth_count"] == f["predicted_count"] == 0
            ],
            "zero_reference_false_positive_fields": [
                f["source_key"]
                for f in checked
                if f["truth_count"] == 0 and f["predicted_count"] > 0
            ],
            "scores": [
                {
                    "iou_threshold": t,
                    **{
                        key: sum(f["scores"][i][key] for f in checked)
                        for key in ("true_positive", "false_positive", "false_negative")
                    },
                }
                for i, t in enumerate(THRESHOLDS)
            ],
        },
        "fields": checked,
    }


def summarize_qualification(fields, expected_source_keys):
    """Apply the V2 numerical summary contract to exactly 47 supplied field keys.

    The caller must independently verify sealed membership, frozen identities,
    native numerical exports and both real execution journeys. No packet is read
    or changed, and this result alone cannot establish workflow qualification.
    """
    expected = _keys(expected_source_keys, "Qualification cohort")
    if len(expected) != 47:
        raise ValueError("Qualification summary requires all 47 expected fields")
    result = summarize_fields(fields, expected)
    result["scope"] = (
        "47-field qualification metric summary only; independent workflow gates still required"
    )
    result["v2"]["median_order_statistic"] = 24
    return result
