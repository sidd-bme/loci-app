from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from loci_modeling.contracts import DatasetManifest
from loci_modeling.data import CellAwarePatchDataset, ensure_output_isolated, resolve_samples


def test_grouped_manifest_quarantine_is_indexed_but_never_opened(dataset_builder) -> None:
    active = dataset_builder.add_active("train-001")
    quarantine = dataset_builder.add_quarantine()
    # Active-content deduplication must not promote quarantined files into the data path.
    quarantine["sha256"] = active["sha256"]
    quarantine["labels"][0]["sha256"] = active["labels"][0]["sha256"]
    manifest = DatasetManifest.load(dataset_builder.write())

    assert manifest.source_count == 2
    assert manifest.quarantine_count == 1
    assert manifest.adjudication_record_id is None
    assert "adjudication_record_id" not in manifest.reference_lineage()
    assert [sample.sample_id for sample in manifest.samples] == ["train-001"]
    resolved = resolve_samples(
        manifest,
        dataset_builder.raw_root,
        dataset_builder.mask_root,
        "train",
    )
    assert len(resolved) == 1
    assert not (dataset_builder.raw_root / "quarantine/quarantine-missing.npy").exists()
    assert not (dataset_builder.mask_root / "quarantine/quarantine-missing_mask.npy").exists()


def test_manifest_rejects_lexical_path_traversal(dataset_builder) -> None:
    source = dataset_builder.add_active("train-001")
    source["relative_path"] = "../outside.npy"

    with pytest.raises(ValueError, match="traversal"):
        DatasetManifest.load(dataset_builder.write())


def test_resolution_rejects_symlink_escape(dataset_builder, tmp_path: Path) -> None:
    source = dataset_builder.add_active("train-001")
    outside = tmp_path / "outside.npy"
    np.save(outside, np.arange(64 * 64, dtype=np.uint16).reshape(64, 64))
    link = dataset_builder.raw_root / "images/escape.npy"
    link.symlink_to(outside)
    source["relative_path"] = "images/escape.npy"
    manifest = DatasetManifest.load(dataset_builder.write())

    with pytest.raises(ValueError, match="escapes its declared root"):
        resolve_samples(
            manifest,
            dataset_builder.raw_root,
            dataset_builder.mask_root,
            "train",
        )


@pytest.mark.parametrize("hash_target", ["raw", "mask"])
def test_resolution_rejects_hash_mismatch(dataset_builder, hash_target: str) -> None:
    source = dataset_builder.add_active("train-001")
    if hash_target == "raw":
        source["sha256"] = "0" * 64
    else:
        source["labels"][0]["sha256"] = "0" * 64
    manifest = DatasetManifest.load(dataset_builder.write())

    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        resolve_samples(
            manifest,
            dataset_builder.raw_root,
            dataset_builder.mask_root,
            "train",
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_images_for_commercial_training", "unclear"),
        ("segmentation_labels_for_commercial_training", "prohibited"),
        ("derived_weights_for_redistribution", "unknown"),
        ("commercial_training_eligible", False),
        ("redistributable_weights_eligible", False),
    ],
)
def test_manifest_fails_closed_on_uncleared_rights(dataset_builder, field: str, value) -> None:
    dataset_builder.add_active("train-001")
    dataset_builder.payload["dataset"]["rights"][field] = value

    with pytest.raises(ValueError, match="rights"):
        DatasetManifest.load(dataset_builder.write())


def test_manifest_rejects_acquisition_group_leakage(dataset_builder) -> None:
    dataset_builder.add_active("train-001", split="train", group="same-acquisition")
    dataset_builder.add_active("validation-001", split="validation", group="same-acquisition")

    with pytest.raises(ValueError, match="cross active splits"):
        DatasetManifest.load(dataset_builder.write())


@pytest.mark.parametrize(
    ("duplicate_field", "message"),
    [
        ("raw", "duplicate active raw SHA-256"),
        ("mask", "duplicate active mask SHA-256"),
    ],
)
def test_manifest_rejects_duplicate_active_content_hashes_across_splits(
    dataset_builder,
    duplicate_field: str,
    message: str,
) -> None:
    first = dataset_builder.add_active("train-001", split="train")
    second = dataset_builder.add_active("validation-001", split="validation")
    if duplicate_field == "raw":
        second["sha256"] = first["sha256"]
    else:
        second["labels"][0]["sha256"] = first["labels"][0]["sha256"]

    with pytest.raises(ValueError, match=message):
        DatasetManifest.load(dataset_builder.write())


@pytest.mark.parametrize("adjudication_record_id", [None, "", "   ", "../review-record"])
def test_adjudicated_manifest_requires_explicit_record_id(
    dataset_builder,
    adjudication_record_id: str | None,
) -> None:
    dataset_builder.add_active("train-001")
    dataset = dataset_builder.payload["dataset"]
    dataset["reference_kind"] = "adjudicated"
    if adjudication_record_id is not None:
        dataset["adjudication_record_id"] = adjudication_record_id

    with pytest.raises(ValueError, match="dataset.adjudication_record_id"):
        DatasetManifest.load(dataset_builder.write())


def test_pseudo_label_manifest_rejects_adjudication_record_id(dataset_builder) -> None:
    dataset_builder.add_active("train-001")
    dataset_builder.payload["dataset"]["adjudication_record_id"] = "adjudication-001"

    with pytest.raises(ValueError, match="must be absent"):
        DatasetManifest.load(dataset_builder.write())


def test_adjudication_record_is_exposed_in_exportable_reference_lineage(dataset_builder) -> None:
    dataset_builder.add_active("train-001")
    dataset = dataset_builder.payload["dataset"]
    dataset["reference_kind"] = "adjudicated"
    dataset["adjudication_record_id"] = "adjudication-001"

    manifest = DatasetManifest.load(dataset_builder.write())

    assert manifest.adjudication_record_id == "adjudication-001"
    assert manifest.reference_lineage()["adjudication_record_id"] == "adjudication-001"
    assert manifest.relative_snapshot()["dataset"]["adjudication_record_id"] == ("adjudication-001")


@pytest.mark.parametrize("source_name", ["raw_root", "mask_root"])
def test_output_directory_must_not_overlap_source_roots(dataset_builder, source_name: str) -> None:
    source_root = getattr(dataset_builder, source_name)

    with pytest.raises(ValueError, match="output_dir"):
        ensure_output_isolated(
            source_root / "training-output",
            dataset_builder.raw_root,
            dataset_builder.mask_root,
        )

    accepted = ensure_output_isolated(
        dataset_builder.root / "training-output",
        dataset_builder.raw_root,
        dataset_builder.mask_root,
    )
    assert accepted == dataset_builder.root / "training-output"


def test_aspect_preserving_resize_aligns_raw_to_mask_grid(dataset_builder) -> None:
    raw = np.arange(48 * 64, dtype=np.uint16).reshape(48, 64)
    mask = np.zeros((24, 32), dtype=np.uint16)
    mask[3:10, 4:12] = 1
    mask[13:22, 19:29] = 2
    dataset_builder.add_active(
        "train-resized",
        raw=raw,
        mask=mask,
        transform_type="aspect_preserving_resize",
    )
    manifest = DatasetManifest.load(dataset_builder.write())
    resolved = resolve_samples(
        manifest,
        dataset_builder.raw_root,
        dataset_builder.mask_root,
        "train",
    )
    patches = CellAwarePatchDataset(
        resolved,
        patch_size=16,
        length=1,
        seed=7,
        offset_scale_px=16.0,
        cell_patch_probability=1.0,
        augment=False,
    )

    image, targets = patches[0]
    assert image.shape == (1, 16, 16)
    assert targets.shape == (4, 16, 16)
    assert torch.isfinite(image).all()
    assert targets[0].sum() > 0


def test_patch_sampling_is_deterministic_by_seed_epoch_and_index(dataset_builder) -> None:
    dataset_builder.add_active("train-001")
    manifest = DatasetManifest.load(dataset_builder.write())
    resolved = resolve_samples(
        manifest,
        dataset_builder.raw_root,
        dataset_builder.mask_root,
        "train",
    )
    options = {
        "patch_size": 32,
        "length": 8,
        "seed": 20260829,
        "offset_scale_px": 32.0,
        "cell_patch_probability": 0.8,
        "augment": True,
    }
    first = CellAwarePatchDataset(resolved, **options)
    second = CellAwarePatchDataset(resolved, **options)

    first_image, first_target = first[3]
    second_image, second_target = second[3]
    assert torch.equal(first_image, second_image)
    assert torch.equal(first_target, second_target)

    first.set_epoch(1)
    next_image, next_target = first[3]
    assert not (torch.equal(first_image, next_image) and torch.equal(first_target, next_target))
