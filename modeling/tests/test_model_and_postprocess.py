from __future__ import annotations

import numpy as np
import pytest
import torch
from skimage.segmentation import find_boundaries

from loci_modeling.contracts import ModelConfig, PostprocessConfig
from loci_modeling.data import make_targets
from loci_modeling.losses import LociInstanceLoss
from loci_modeling.metrics import (
    aggregate_agreement,
    aggregate_agreement_by_group,
    agreement_metrics,
)
from loci_modeling.model import LociResidualUNet
from loci_modeling.postprocess import logits_to_instances


def test_four_head_model_and_instance_loss_backward() -> None:
    torch.manual_seed(17)
    model = LociResidualUNet(
        ModelConfig(base_channels=8, depth=2, group_norm_groups=4, dropout=0.0)
    )
    inputs = torch.rand(2, 1, 32, 32)
    mask = np.zeros((32, 32), dtype=np.int32)
    mask[4:14, 5:15] = 1
    mask[18:29, 17:28] = 2
    target = (
        torch.from_numpy(make_targets(mask, offset_scale_px=16.0)).unsqueeze(0).repeat(2, 1, 1, 1)
    )

    prediction = model(inputs)
    loss, components = LociInstanceLoss()(prediction, target)
    loss.backward()

    assert prediction.shape == (2, 4, 32, 32)
    assert tuple(model.output_channels) == (
        "foreground_logit",
        "boundary_logit",
        "offset_x",
        "offset_y",
    )
    assert torch.isfinite(loss)
    assert set(components) == {
        "loss",
        "foreground_bce",
        "foreground_dice",
        "boundary_bce",
        "boundary_dice",
        "offset_huber",
    }
    gradient_total = sum(
        float(parameter.grad.abs().sum())
        for parameter in model.parameters()
        if parameter.grad is not None
    )
    assert gradient_total > 0


def _two_cell_reference(size: int = 64) -> tuple[np.ndarray, list[tuple[int, int]]]:
    y, x = np.mgrid[:size, :size]
    centers = [(18, 18), (45, 44)]
    labels = np.zeros((size, size), dtype=np.int32)
    for label_id, (center_y, center_x) in enumerate(centers, start=1):
        labels[(y - center_y) ** 2 + (x - center_x) ** 2 <= 7**2] = label_id
    return labels, centers


def _perfect_logits(labels: np.ndarray, centers: list[tuple[int, int]], scale: float) -> np.ndarray:
    logits = np.full((4, *labels.shape), -10.0, dtype=np.float32)
    foreground = labels > 0
    boundary = find_boundaries(labels, connectivity=2, mode="thick")
    logits[0, foreground] = 10.0
    logits[1, boundary] = 10.0
    logits[1, ~boundary] = -10.0
    for label_id, (center_y, center_x) in enumerate(centers, start=1):
        ys, xs = np.nonzero(labels == label_id)
        normalized_x = np.clip((center_x - xs) / scale, -0.98, 0.98)
        normalized_y = np.clip((center_y - ys) / scale, -0.98, 0.98)
        logits[2, ys, xs] = np.arctanh(normalized_x)
        logits[3, ys, xs] = np.arctanh(normalized_y)
    return logits


def test_postprocess_and_pseudo_label_agreement_are_explicit() -> None:
    reference, centers = _two_cell_reference()
    config = PostprocessConfig(
        foreground_threshold=0.5,
        boundary_threshold=0.5,
        min_area_px=20,
        offset_scale_px=16.0,
        vote_smoothing_px=1.0,
        seed_min_distance_px=6,
        minimum_seed_votes=2,
        exclude_border=False,
    )
    prediction, diagnostics = logits_to_instances(
        _perfect_logits(reference, centers, config.offset_scale_px),
        config,
    )
    metrics = agreement_metrics(reference, prediction)
    missed_metrics = agreement_metrics(reference, np.zeros_like(reference))
    aggregate = aggregate_agreement([metrics])
    grouped = aggregate_agreement_by_group([{**metrics, "group": "acquisition-a"}])

    assert int(prediction.max()) == 2
    assert metrics["reference_count"] == 2
    assert metrics["predicted_count"] == 2
    assert metrics["pixel_dice"] == pytest.approx(1.0)
    assert metrics["instance_ap_at_iou_0_50"] == pytest.approx(1.0)
    assert metrics["instance_f1_at_iou_0_50"] == pytest.approx(1.0)
    assert metrics["instance_ap_at_iou_0_75"] == pytest.approx(1.0)
    assert metrics["instance_f1_at_iou_0_75"] == pytest.approx(1.0)
    assert missed_metrics["absolute_percentage_count_error"] == pytest.approx(100.0)
    assert aggregate["scope"] == "pseudo_label_agreement"
    assert aggregate["image_count"] == 1
    assert aggregate["metrics"]["p90_absolute_percentage_count_error"] == 0.0
    assert grouped[0]["acquisition_group"] == "acquisition-a"
    assert grouped[0]["summary"]["image_count"] == 1
    assert set(diagnostics) == {
        "foreground_probability",
        "boundary_probability",
        "offset_x",
        "offset_y",
        "center_votes",
    }


def test_count_bias_is_macro_signed_percent_with_distinct_raw_instance_bias() -> None:
    overcount = agreement_metrics(
        np.array([[1, 0], [0, 0]], dtype=np.int32),
        np.array([[1, 0], [0, 2]], dtype=np.int32),
    )
    reference = np.arange(1, 11, dtype=np.int32).reshape(2, 5)
    undercount = agreement_metrics(reference, np.where(reference <= 8, reference, 0))

    aggregate = aggregate_agreement([overcount, undercount])
    grouped = aggregate_agreement_by_group(
        [
            {**overcount, "group": "acquisition-a"},
            {**undercount, "group": "acquisition-a"},
        ]
    )

    assert overcount["signed_percentage_count_error_percent"] == pytest.approx(100.0)
    assert undercount["signed_percentage_count_error_percent"] == pytest.approx(-20.0)
    assert aggregate["metrics"]["count_bias_percent"] == pytest.approx(40.0)
    assert aggregate["metrics"]["count_bias_instances"] == pytest.approx(-0.5)
    assert "count_bias" not in aggregate["metrics"]
    assert grouped[0]["summary"]["metrics"]["count_bias_percent"] == pytest.approx(40.0)


def test_zero_reference_images_are_reported_but_excluded_from_percentage_metrics() -> None:
    empty_reference = np.zeros((3, 3), dtype=np.int32)
    false_positive = np.zeros_like(empty_reference)
    false_positive[1, 1] = 1
    zero_row = agreement_metrics(empty_reference, false_positive)
    defined_row = agreement_metrics(
        np.array([[1, 0], [0, 0]], dtype=np.int32),
        np.array([[1, 0], [0, 2]], dtype=np.int32),
    )

    aggregate = aggregate_agreement([zero_row, defined_row])

    assert zero_row["signed_percentage_count_error_percent"] is None
    assert zero_row["absolute_percentage_count_error_percent"] is None
    assert aggregate["metrics"]["percentage_metric_image_count"] == 1
    assert aggregate["metrics"]["zero_reference_image_count"] == 1
    assert aggregate["metrics"]["count_bias_percent"] == pytest.approx(100.0)
    assert aggregate["metrics"]["p90_absolute_percentage_count_error_percent"] == pytest.approx(
        100.0
    )
