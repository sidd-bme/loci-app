from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image

import loci_engine.training_manifest as manifest_module
from loci_engine.training_manifest import (
    PairingError,
    RightsDeclaration,
    SplitRule,
    TrainingManifestError,
    build_training_manifest,
    dry_run_summary,
    write_training_manifest,
)

RIGHTS = RightsDeclaration(
    source_images_for_commercial_training="cleared",
    segmentation_labels_for_commercial_training="cleared",
    derived_weights_for_redistribution="cleared",
    basis="user-attestation",
)
PROVENANCE = "historical-cellpose-pseudo-label"
FIXTURE_SPLIT_RULES = (
    SplitRule(name="training-batch", split="train", source_prefixes=("training_set",)),
    SplitRule(
        name="validation-batch",
        split="validation",
        source_prefixes=("validation_set",),
    ),
    SplitRule(
        name="test-batches",
        split="test",
        source_prefixes=("test_set_a", "test_set_b"),
    ),
    SplitRule(
        name="competing-labels",
        split="quarantine",
        source_prefixes=("challenge_set",),
    ),
)


def _write_source(path: Path, *, size: tuple[int, int] = (200, 100)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = size
    array = np.zeros((height, width, 3), dtype=np.uint8)
    array[..., 0] = 75
    array[..., 1] = 120
    array[..., 2] = 165
    if path.suffix.casefold() in {".tif", ".tiff"}:
        tifffile.imwrite(path, array, photometric="rgb")
    else:
        Image.fromarray(array).save(path)


def _write_mask(
    path: Path,
    *,
    size: tuple[int, int] = (200, 100),
    instances: int = 2,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = size
    labels = np.zeros((height, width), dtype=np.uint16)
    for index in range(instances):
        x0 = 2 + index * 12
        labels[2:10, x0 : x0 + 8] = index + 1
    tifffile.imwrite(path, labels, photometric="minisblack", metadata={"axes": "YX"})


def _build(raw_root: Path, segmented_root: Path) -> dict[str, object]:
    return build_training_manifest(
        raw_root,
        segmented_root,
        rights=RIGHTS,
        provenance_label=PROVENANCE,
        split_rules=FIXTURE_SPLIT_RULES,
    )


def test_builds_deterministic_contextual_manifest_with_variants_and_diagnostics(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "raw"
    segmented = tmp_path / "segmented"

    _write_source(raw / "training_set" / "batch-a" / "train.jpg")
    _write_mask(segmented / "training_set_segmented" / "batch-a" / "train_mask.tif")

    _write_source(raw / "validation_set" / "validation.tif")
    _write_mask(segmented / "validation_set_segmented" / "validation_mask.tif")

    _write_source(raw / "test_set_a" / "sample_a.jpg")
    _write_mask(
        segmented / "test_set_a_segmented" / "masks" / "sample_a_cp_masks.tif",
        size=(100, 50),
        instances=3,
    )
    _write_source(raw / "test_set_b" / "sample_b.jpg")
    _write_mask(
        segmented / "test_set_b_segmented" / "masks" / "sample_b_cp_masks.tif",
        size=(100, 50),
    )

    _write_source(raw / "challenge_set" / "batch-c" / "image_01.tif")
    _write_mask(
        segmented / "challenge_set_segmented" / "batch-c" / "masks" / "image_01_cp_masks.tif",
        size=(100, 50),
    )
    _write_mask(
        segmented
        / "challenge_set_segmented_tuned"
        / "batch-c"
        / "masks"
        / "image_01_cp_masks.tif",
        size=(160, 80),
        instances=4,
    )

    _write_source(raw / "unpaired.png")
    _write_source(raw / "test_set_a" / "diagnostic_flows.tif")
    _write_mask(segmented / "ignored" / "orphan_flows_cp_masks.tif")
    _write_mask(segmented / "ignored" / "orphan_dP_cp_masks.tif")

    manifest = _build(raw, segmented)
    repeated = _build(raw, segmented)

    assert manifest == repeated
    assert manifest["schema_version"] == "1.0"
    assert manifest["dataset"]["rights"] == {
        "basis": "user-attestation",
        "commercial_training_eligible": True,
        "derived_weights_for_redistribution": "cleared",
        "redistributable_weights_eligible": True,
        "segmentation_labels_for_commercial_training": "cleared",
        "source_images_for_commercial_training": "cleared",
    }
    assert manifest["summary"] == {
        "flagged_sources": 1,
        "labels": 6,
        "labels_discovered": 6,
        "paired_sources": 5,
        "raw_diagnostics_excluded": 1,
        "raw_eligible_sources": 6,
        "raw_supported_files": 7,
        "sources_with_multiple_labels": 1,
        "split_source_counts": {
            "quarantine": 1,
            "test": 2,
            "train": 1,
            "validation": 1,
        },
        "unpaired_eligible_sources": 1,
    }

    sources = {source["relative_path"]: source for source in manifest["sources"]}
    resized = sources["test_set_a/sample_a.jpg"]
    assert resized["split"] == "test"
    assert resized["acquisition_group"] == "test_set_a"
    assert resized["labels"][0]["relative_path"] == (
        "test_set_a_segmented/masks/sample_a_cp_masks.tif"
    )
    assert resized["labels"][0]["transform_type"] == "aspect_preserving_resize"
    assert resized["labels"][0]["instance_count"] == 3

    second_tree = sources["test_set_b/sample_b.jpg"]
    assert second_tree["split"] == "test"
    assert second_tree["labels"][0]["kind"] == "cp_masks"

    challenge = sources["challenge_set/batch-c/image_01.tif"]
    assert challenge["split"] == "quarantine"
    assert challenge["qc_flags"] == ["competing_label_variants"]
    assert {label["variant"] for label in challenge["labels"]} == {"default", "tuned"}
    assert len({label["label_id"] for label in challenge["labels"]}) == 2
    assert all(
        label["transform_type"] == "aspect_preserving_resize"
        for label in challenge["labels"]
    )

    assert sources["training_set/batch-a/train.jpg"]["split"] == "train"
    assert sources["validation_set/validation.tif"]["split"] == "validation"
    assert len({source["source_id"] for source in manifest["sources"]}) == 5

    encoded = json.dumps(manifest, sort_keys=True)
    assert str(raw.resolve()) not in encoded
    assert str(segmented.resolve()) not in encoded
    assert "diagnostic_flows.tif" not in encoded
    assert "orphan_flows_cp_masks.tif" not in encoded
    assert "orphan_dP_cp_masks.tif" not in encoded

    assert dry_run_summary(
        raw,
        segmented,
        rights=RIGHTS,
        provenance_label=PROVENANCE,
        split_rules=FIXTURE_SPLIT_RULES,
    ) == manifest["summary"]


def test_zero_instance_mask_is_flagged_and_quarantined(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    segmented = tmp_path / "segmented"
    source = raw / "training_set" / "batch-zero" / "empty.jpg"
    label = (
        segmented
        / "training_set_segmented"
        / "batch-zero"
        / "empty_mask.tif"
    )
    _write_source(source)
    _write_mask(label, instances=0)

    manifest = _build(raw, segmented)
    record = manifest["sources"][0]

    assert record["split"] == "quarantine"
    assert record["qc_flags"] == ["zero_instance_mask"]
    assert record["labels"][0]["instance_count"] == 0
    assert record["labels"][0]["qc_flags"] == ["zero_instance_mask"]


def test_missing_contextual_source_fails_closed(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    segmented = tmp_path / "segmented"
    raw.mkdir()
    _write_mask(segmented / "batch_segmented" / "missing_mask.tif")

    with pytest.raises(PairingError, match="No contextual raw source"):
        _build(raw, segmented)


def test_multiple_supported_extensions_for_one_context_are_ambiguous(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    segmented = tmp_path / "segmented"
    _write_source(raw / "batch" / "sample.jpg")
    _write_source(raw / "batch" / "sample.png")
    _write_mask(segmented / "batch_segmented" / "sample_mask.tif")

    with pytest.raises(PairingError, match="ambiguous raw sources"):
        _build(raw, segmented)


def test_atomic_write_publishes_only_relative_json(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    segmented = tmp_path / "segmented"
    _write_source(raw / "batch" / "sample.jpg")
    _write_mask(segmented / "batch_segmented" / "sample_mask.tif")
    manifest = _build(raw, segmented)
    destination = tmp_path / "training-manifest.json"

    assert write_training_manifest(manifest, destination) == destination.resolve()
    assert json.loads(destination.read_text(encoding="utf-8")) == manifest
    assert not list(tmp_path.glob(".training-manifest.json.*.tmp"))
    encoded = destination.read_text(encoding="utf-8")
    assert str(raw.resolve()) not in encoded
    assert str(segmented.resolve()) not in encoded


def test_failed_atomic_replace_preserves_existing_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "training-manifest.json"
    destination.write_text('{"existing":true}\n', encoding="utf-8")
    manifest = {
        "schema_version": "1.0",
        "dataset": {"provenance_label": PROVENANCE},
        "sources": [],
    }

    def fail_replace(_source: Path, _destination: Path) -> None:
        raise OSError("simulated atomic publication failure")

    monkeypatch.setattr(manifest_module.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated atomic publication failure"):
        write_training_manifest(manifest, destination)

    assert destination.read_text(encoding="utf-8") == '{"existing":true}\n'
    assert not list(tmp_path.glob(".training-manifest.json.*.tmp"))


def test_writer_rejects_absolute_path_leakage(tmp_path: Path) -> None:
    manifest = {
        "schema_version": "1.0",
        "sources": [{"relative_path": str(tmp_path.resolve())}],
    }

    with pytest.raises(TrainingManifestError, match="absolute path"):
        write_training_manifest(copy.deepcopy(manifest), tmp_path / "manifest.json")
