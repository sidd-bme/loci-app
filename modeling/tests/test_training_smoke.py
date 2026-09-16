from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

import loci_modeling.training as training_module
from loci_modeling.cli import build_parser
from loci_modeling.contracts import ModelConfig, PostprocessConfig, TrainingConfig
from loci_modeling.training import run_training


def test_test_evaluation_is_an_explicit_release_gate() -> None:
    assert inspect.signature(run_training).parameters["evaluate_test"].default is False
    parser = build_parser()
    base = [
        "train",
        "--manifest",
        "manifest.json",
        "--raw-root",
        "raw",
        "--mask-root",
        "masks",
        "--output-dir",
        "output",
        "--profile-id",
        "loci-native",
        "--display-name",
        "Loci Native",
    ]
    assert parser.parse_args(base).evaluate_test is False
    assert parser.parse_args([*base, "--evaluate-test"]).evaluate_test is True


def test_invalid_profile_identity_fails_before_manifest_or_source_access(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="profile_id"):
        run_training(
            manifest_path=tmp_path / "missing-manifest.json",
            raw_root=tmp_path / "missing-raw",
            mask_root=tmp_path / "missing-mask",
            output_dir=tmp_path / "output",
            profile_id="../invalid",
            profile_version="0.1.0",
            display_name="Invalid",
            model_config=ModelConfig(base_channels=8, depth=2),
            training_config=TrainingConfig(epochs=1, steps_per_epoch=1),
            postprocess_config=PostprocessConfig(),
        )


def test_default_training_does_not_resolve_or_evaluate_test_split(
    dataset_builder,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_builder.add_active("train-001", split="train")
    dataset_builder.add_active("validation-001", split="validation")
    dataset_builder.add_active("test-001", split="test")
    manifest_path = dataset_builder.write()
    resolved_splits: list[str] = []
    real_resolve = training_module.resolve_samples

    def recording_resolve(manifest, raw_root, mask_root, split, **kwargs):
        resolved_splits.append(split)
        return real_resolve(manifest, raw_root, mask_root, split, **kwargs)

    monkeypatch.setattr(training_module, "resolve_samples", recording_resolve)
    output = dataset_builder.root / "default-locked-test-run"
    result = run_training(
        manifest_path=manifest_path,
        raw_root=dataset_builder.raw_root,
        mask_root=dataset_builder.mask_root,
        output_dir=output,
        profile_id="loci-native-locked-test",
        profile_version="0.1.0",
        display_name="Loci Native Locked Test",
        model_config=ModelConfig(base_channels=8, depth=2, dropout=0.0),
        training_config=TrainingConfig(
            epochs=1,
            steps_per_epoch=1,
            validation_steps=1,
            batch_size=1,
            patch_size=16,
            checkpoint_every=1,
            use_amp=False,
        ),
        postprocess_config=PostprocessConfig(
            min_area_px=4,
            offset_scale_px=16.0,
            seed_min_distance_px=3,
            minimum_seed_votes=1,
        ),
        requested_device="cpu",
        run_id="default-locked-test-run",
        export_model=False,
    )

    assert resolved_splits == ["train", "validation"]
    assert set(result["agreement"]) == {"validation"}
    assert not (output / "test-agreement.json").exists()


def test_end_to_end_training_selects_on_validation_then_reports_test(
    dataset_builder,
) -> None:
    dataset_builder.add_active("train-001", split="train", group="train-acquisition")
    dataset_builder.add_active("validation-001", split="validation", group="validation-acquisition")
    dataset_builder.add_active("test-001", split="test", group="test-acquisition")
    manifest_path = dataset_builder.write()
    output = dataset_builder.root / "training-run"

    result = run_training(
        manifest_path=manifest_path,
        raw_root=dataset_builder.raw_root,
        mask_root=dataset_builder.mask_root,
        output_dir=output,
        profile_id="loci-native-smoke",
        profile_version="0.1.0",
        display_name="Loci Native Smoke",
        model_config=ModelConfig(
            base_channels=8,
            depth=2,
            group_norm_groups=4,
            dropout=0.0,
        ),
        training_config=TrainingConfig(
            seed=19,
            epochs=1,
            steps_per_epoch=1,
            validation_steps=1,
            batch_size=1,
            patch_size=16,
            checkpoint_every=1,
            patches_per_source_block=1,
            use_amp=False,
        ),
        postprocess_config=PostprocessConfig(
            min_area_px=4,
            offset_scale_px=16.0,
            seed_min_distance_px=3,
            minimum_seed_votes=1,
        ),
        requested_device="cpu",
        run_id="synthetic-smoke-run",
        code_revision="synthetic-test-revision",
        export_model=False,
        evaluate_test=True,
    )

    assert Path(result["best_checkpoint"]).is_file()
    assert set(result["agreement"]) == {"validation", "test"}
    validation_report = json.loads(
        (output / "validation-agreement.json").read_text(encoding="utf-8")
    )
    test_report = json.loads((output / "test-agreement.json").read_text(encoding="utf-8"))
    assert validation_report["acquisition_groups"][0]["acquisition_group"] == (
        "validation-acquisition"
    )
    assert test_report["acquisition_groups"][0]["acquisition_group"] == "test-acquisition"
    assert "mean_instance_ap_at_iou_0_50" in test_report["summary"]["metrics"]
    assert "mean_instance_f1_at_iou_0_75" in test_report["summary"]["metrics"]
    assert "p90_absolute_percentage_count_error" in test_report["summary"]["metrics"]
    run_config_text = (output / "run-config.json").read_text(encoding="utf-8")
    assert str(dataset_builder.raw_root) not in run_config_text
    assert str(dataset_builder.mask_root) not in run_config_text
