import numpy as np
import pytest

from loci_engine.annotation_evaluation import compare_labels, estimated_working_bytes


def compare(reference, prediction, semantics="instances", thresholds=None, **kwargs):
    return compare_labels(
        reference,
        prediction,
        semantics=semantics,
        iou_thresholds=([0.5, 0.75] if semantics == "instances" else [])
        if thresholds is None
        else thresholds,
        working_bytes=64 * 1024**2,
        **kwargs,
    )


def test_sparse_ids_are_instances_even_when_disconnected_and_inputs_remain_immutable():
    reference = np.array([[4_000_000_000, 0, 7], [0, 0, 7], [4_000_000_000, 0, 0]], np.uint32)
    prediction = np.where(reference == 7, 91, np.where(reference != 0, 23, 0)).astype(np.uint32)
    before = reference.copy(), prediction.copy()
    measured = compare(reference, prediction)
    assert measured["instances"]["reference_count"] == 2
    assert measured["instances"]["prediction_count"] == 2
    assert measured["instances"]["scores"][0]["f1"] == 1
    assert measured["instances"]["scores"][0]["matches"] == [
        {
            "reference_label": 7,
            "prediction_label": 91,
            "intersection_pixels": 2,
            "union_pixels": 2,
            "iou": 1.0,
        },
        {
            "reference_label": 4_000_000_000,
            "prediction_label": 23,
            "intersection_pixels": 2,
            "union_pixels": 2,
            "iou": 1.0,
        },
    ]
    assert all(np.array_equal(a, b) for a, b in zip(before, (reference, prediction), strict=True))


def test_threshold_inclusive_merge_split_and_region_semantics_are_distinct():
    reference = np.array([[1, 1, 0, 2, 2], [1, 1, 0, 2, 2]], np.uint32)
    merged = (reference > 0).astype(np.uint32)
    measured = compare(reference, merged)
    assert measured["instances"]["scores"][0]["true_positive"] == 1
    assert measured["instances"]["scores"][1]["true_positive"] == 0
    assert measured["instances"]["merge_prediction_any_overlap"] == 1
    assert measured["instances"]["count_error_signed"] == -1
    assert compare(merged, reference)["instances"]["split_reference_any_overlap"] == 1
    region = compare(reference, merged, "foreground-region")
    assert region["instances"] is None
    assert region["region"]["iou"] == region["region"]["dice"] == 1


def test_cardinality_is_maximized_before_summed_iou():
    # Overlap table [[70,10],[10,0]]: a plain max-IoU assignment loses a valid match.
    reference = np.array([1] * 80 + [2] * 10, np.uint32).reshape(9, 10)
    prediction = np.array([1] * 70 + [2] * 10 + [1] * 10, np.uint32).reshape(9, 10)
    score = compare(reference, prediction, thresholds=[0.1])["instances"]["scores"][0]
    assert score["true_positive"] == 2
    assert score["matched_iou_sum"] == 0.25


@pytest.mark.parametrize(
    "reference_nonempty,prediction_nonempty", [(False, False), (False, True), (True, False)]
)
def test_empty_denominators_are_explicitly_undefined(reference_nonempty, prediction_nonempty):
    reference = np.full((2, 3), int(reference_nonempty), np.uint32)
    prediction = np.full((2, 3), int(prediction_nonempty), np.uint32)
    metrics = compare(reference, prediction)
    score = metrics["instances"]["scores"][0]
    if not reference_nonempty:
        assert metrics["instances"]["count_error_relative"] is None
        assert (
            metrics["instances"]["undefined_reasons"]["count_error_relative"]
            == "no-reference-instances"
        )
        assert score["recall"] is None
    if not prediction_nonempty:
        assert score["precision"] is None
    if not reference_nonempty and not prediction_nonempty:
        assert score["f1"] is None
        assert metrics["region"]["iou"] is metrics["region"]["dice"] is None
        assert metrics["region"]["undefined_reasons"]["iou"] == "empty-foreground-union"
    else:
        assert score["f1"] == 0
        assert metrics["region"]["iou"] == 0


def test_region_arithmetic_is_exact_and_disjoint_ids_do_not_imply_disjoint_pixels():
    reference = np.array([[9, 9, 0], [0, 9, 0]], np.uint32)
    prediction = np.array([[4, 0, 4], [0, 4, 0]], np.uint32)
    region = compare(reference, prediction, "foreground-region")["region"]
    assert region == {
        "reference_pixels": 3,
        "prediction_pixels": 3,
        "intersection_pixels": 2,
        "union_pixels": 4,
        "iou": 0.5,
        "dice": 2 / 3,
        "undefined_reasons": {},
    }


@pytest.mark.parametrize("dtype", [np.int32, np.float32, np.uint16, bool])
def test_noncanonical_labels_are_refused(dtype):
    with pytest.raises(ValueError, match="uint32"):
        compare(np.zeros((2, 3), dtype), np.zeros((2, 3), np.uint32))


@pytest.mark.parametrize(
    "semantics,thresholds",
    [
        ("auto", [0.5]),
        ("foreground-region", [0.5]),
        ("instances", []),
        ("instances", [0]),
        ("instances", [0.5, 0.5]),
        ("instances", [True]),
        ("instances", [float("nan")]),
    ],
)
def test_semantics_and_thresholds_are_explicit(semantics, thresholds):
    with pytest.raises(ValueError):
        compare(np.zeros((2, 3), np.uint32), np.zeros((2, 3), np.uint32), semantics, thresholds)


def test_mismatched_grids_resources_and_cancellation_fail_without_mutation():
    reference = np.zeros((2, 3), np.uint32)
    with pytest.raises(ValueError, match="shapes"):
        compare(reference, reference.T)
    with pytest.raises(ValueError, match="Pairwise"):
        estimated_working_bytes(100, 3000, 3000, 1)
    many = np.arange(4096, dtype=np.uint32).reshape(64, 64)
    with pytest.raises(ValueError, match="Pairwise|memory"):
        compare(many, many)

    def stop():
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        compare(reference, reference, check=stop)
    assert not reference.any()
