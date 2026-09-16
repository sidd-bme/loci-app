from __future__ import annotations

import numpy as np
import pytest

import loci_modeling.data as data_module
from loci_modeling.contracts import DatasetManifest
from loci_modeling.data import (
    CellAwarePatchDataset,
    _apply_spatial_transform,
    _crop_targets_with_padding,
    make_targets,
    preprocess_image_and_mask,
    resolve_samples,
)


def test_complete_coverage_sampling_visits_every_validation_source_deterministically(
    dataset_builder,
) -> None:
    dataset_builder.add_active("train-001", split="train")
    for index in range(7):
        dataset_builder.add_active(f"validation-{index:03d}", split="validation")
    manifest = DatasetManifest.load(dataset_builder.write())
    resolved = resolve_samples(
        manifest,
        dataset_builder.raw_root,
        dataset_builder.mask_root,
        "validation",
    )
    options = {
        "patch_size": 16,
        "length": 11,
        "seed": 41,
        "offset_scale_px": 16.0,
        "augment": False,
        "sampling_strategy": "complete_coverage",
    }
    first = CellAwarePatchDataset(resolved, **options)
    second = CellAwarePatchDataset(resolved, **options)

    assert first.selected_sample_ids() == second.selected_sample_ids()
    assert set(first.selected_sample_ids()) == {sample.record.sample_id for sample in resolved}
    with pytest.raises(ValueError, match="cover every source"):
        CellAwarePatchDataset(resolved, **{**options, "length": len(resolved) - 1})


def test_max_edge_preprocessing_downsamples_image_and_mask_without_changing_ids() -> None:
    height, width = 600, 1200
    image = np.linspace(0, 65535, height * width, dtype=np.float32).reshape(height, width)
    mask = np.zeros((height, width), dtype=np.uint16)
    mask[80:260, 120:360] = 1
    mask[310:560, 700:1080] = 2

    normalized, downsampled_mask = preprocess_image_and_mask(
        image,
        mask,
        instance_count=2,
    )

    assert normalized.shape == (500, 1000)
    assert downsampled_mask.shape == (500, 1000)
    assert np.array_equal(np.unique(downsampled_mask), np.array([0, 1, 2]))
    assert np.isfinite(normalized).all()

    small_image, small_mask = preprocess_image_and_mask(
        image[:200, :300],
        mask[:200, :300],
        instance_count=1,
    )
    assert small_image.shape == (200, 300)
    assert small_mask.shape == (200, 300)


def test_max_edge_preprocessing_fails_if_nearest_resize_drops_an_instance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image = np.linspace(0, 1, 1001 * 1001, dtype=np.float32).reshape(1001, 1001)
    mask = np.zeros((1001, 1001), dtype=np.uint16)
    mask[100:300, 100:300] = 1
    real_resize = data_module.resize

    def drop_mask(array, output_shape, **kwargs):
        if kwargs.get("order") == 0:
            return np.zeros(output_shape, dtype=np.int32)
        return real_resize(array, output_shape, **kwargs)

    monkeypatch.setattr(data_module, "resize", drop_mask)
    with pytest.raises(ValueError, match="instance IDs/count changed"):
        preprocess_image_and_mask(image, mask, instance_count=1)


def test_patch_targets_crop_full_instance_centroids_and_boundaries_without_recomputing() -> None:
    mask = np.zeros((40, 40), dtype=np.int32)
    mask[5:35, 5:35] = 1
    full_targets = make_targets(mask, offset_scale_px=32.0)
    cropped = _crop_targets_with_padding(full_targets, center_y=10, center_x=10, size=16)
    mask_crop = mask[2:18, 2:18]
    recomputed_fragment_targets = make_targets(mask_crop, offset_scale_px=32.0)

    # Local (6,6) is global (8,8): its target must still point to the full
    # instance centroid at (19.5,19.5), not the visible fragment centroid.
    assert cropped[2, 6, 6] == pytest.approx((19.5 - 8) / 32.0)
    assert cropped[3, 6, 6] == pytest.approx((19.5 - 8) / 32.0)
    assert cropped[2, 6, 6] != pytest.approx(recomputed_fragment_targets[2, 6, 6])
    assert np.array_equal(cropped[1], full_targets[1, 2:18, 2:18])


def test_spatial_augmentation_rotates_and_flips_offset_vectors_with_targets() -> None:
    image = np.arange(12, dtype=np.float32).reshape(3, 4)
    mask = np.ones((3, 4), dtype=np.int32)
    targets = np.zeros((4, 3, 4), dtype=np.float32)
    targets[0] = 1.0
    targets[1, 0, 0] = 1.0
    targets[2] = 0.25
    targets[3] = -0.5

    transformed_image, transformed_mask, transformed_targets = _apply_spatial_transform(
        image,
        mask,
        targets,
        rotations=1,
        flip_y=True,
        flip_x=True,
    )

    assert transformed_image.shape == (4, 3)
    assert transformed_mask.shape == (4, 3)
    assert np.all(transformed_targets[2] == pytest.approx(0.5))
    assert np.all(transformed_targets[3] == pytest.approx(0.25))
    expected_boundary = np.flip(np.flip(np.rot90(targets[1], 1), axis=0), axis=1)
    assert np.array_equal(transformed_targets[1], expected_boundary)
