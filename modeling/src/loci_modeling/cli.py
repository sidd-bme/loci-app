"""Command-line entry points for manifest validation and native-model training."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import replace
from pathlib import Path
from typing import Any

from .contracts import DatasetManifest, ModelConfig, PostprocessConfig, TrainingConfig
from .data import resolve_samples
from .training import run_training


def _add_source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--raw-root", type=Path, required=True)
    parser.add_argument("--mask-root", type=Path, required=True)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def build_parser() -> argparse.ArgumentParser:
    training_defaults = TrainingConfig()
    model_defaults = ModelConfig()
    postprocess_defaults = PostprocessConfig()
    parser = argparse.ArgumentParser(
        prog="loci-modeling",
        description="Rights-clean developer pipeline for Loci-native segmentation weights.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    validate = subcommands.add_parser(
        "validate-manifest",
        help="Validate rights, splits, paths, and all active source hashes.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    _add_source_arguments(validate)

    train = subcommands.add_parser(
        "train",
        help="Train a new residual U-Net from random initialization.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    _add_source_arguments(train)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--profile-id", required=True)
    train.add_argument("--profile-version", default="0.1.0")
    train.add_argument("--display-name", required=True)
    train.add_argument("--run-id")
    train.add_argument(
        "--code-revision",
        default=os.environ.get("LOCI_CODE_REVISION", "uncommitted-development"),
    )
    train.add_argument("--device", choices=("auto", "cpu", "cuda", "mps"), default="auto")
    train.add_argument("--seed", type=int, default=training_defaults.seed)
    train.add_argument("--epochs", type=int, default=training_defaults.epochs)
    train.add_argument("--steps-per-epoch", type=int, default=training_defaults.steps_per_epoch)
    train.add_argument("--validation-steps", type=int, default=training_defaults.validation_steps)
    train.add_argument("--batch-size", type=int, default=training_defaults.batch_size)
    train.add_argument("--patch-size", type=int, default=training_defaults.patch_size)
    train.add_argument(
        "--cell-patch-probability",
        type=float,
        default=training_defaults.cell_patch_probability,
    )
    train.add_argument(
        "--patches-per-source-block",
        type=int,
        default=training_defaults.patches_per_source_block,
    )
    train.add_argument("--learning-rate", type=float, default=training_defaults.learning_rate)
    train.add_argument("--weight-decay", type=float, default=training_defaults.weight_decay)
    train.add_argument(
        "--gradient-clip-norm", type=float, default=training_defaults.gradient_clip_norm
    )
    train.add_argument("--num-workers", type=int, default=training_defaults.num_workers)
    train.add_argument("--checkpoint-every", type=int, default=training_defaults.checkpoint_every)
    train.add_argument("--no-amp", action="store_true")
    train.add_argument("--base-channels", type=int, default=model_defaults.base_channels)
    train.add_argument("--depth", type=int, default=model_defaults.depth)
    train.add_argument("--dropout", type=float, default=model_defaults.dropout)
    train.add_argument(
        "--foreground-threshold", type=float, default=postprocess_defaults.foreground_threshold
    )
    train.add_argument(
        "--boundary-threshold", type=float, default=postprocess_defaults.boundary_threshold
    )
    train.add_argument("--min-area-px", type=int, default=postprocess_defaults.min_area_px)
    train.add_argument(
        "--offset-scale-px", type=float, default=postprocess_defaults.offset_scale_px
    )
    train.add_argument(
        "--vote-smoothing-px", type=float, default=postprocess_defaults.vote_smoothing_px
    )
    train.add_argument(
        "--seed-min-distance-px", type=int, default=postprocess_defaults.seed_min_distance_px
    )
    train.add_argument(
        "--minimum-seed-votes", type=int, default=postprocess_defaults.minimum_seed_votes
    )
    train.add_argument("--exclude-border", action="store_true")
    train.add_argument(
        "--skip-onnx-export",
        action="store_true",
        help="Developer smoke-test only; release runs should export and verify ONNX.",
    )
    train.add_argument("--no-onnx-runtime-check", action="store_true")
    train.add_argument(
        "--evaluate-test",
        action="store_true",
        help="Explicitly release and evaluate the locked test split after validation selection.",
    )
    return parser


def _validate_command(args: argparse.Namespace) -> dict[str, object]:
    manifest = DatasetManifest.load(args.manifest)
    split_counts: dict[str, int] = {}
    for split in ("train", "validation", "test"):
        split_counts[split] = len(
            resolve_samples(
                manifest,
                args.raw_root,
                args.mask_root,
                split,
                verify_integrity=True,
            )
        )
    return {
        "status": "valid",
        "schema_version": manifest.schema_version,
        "dataset_id": manifest.dataset_id,
        "manifest_sha256": manifest.manifest_sha256,
        "reference_kind": manifest.reference_kind,
        "rights_id": manifest.rights.record_id,
        "split_counts": split_counts,
        "quarantine_count": manifest.quarantine_count,
        "note": "Quarantined sources were validated as metadata but were not resolved or opened.",
    }


def _train_command(args: argparse.Namespace) -> dict[str, Any]:
    model_config = replace(
        ModelConfig(),
        base_channels=args.base_channels,
        depth=args.depth,
        dropout=args.dropout,
    )
    training_config = replace(
        TrainingConfig(),
        seed=args.seed,
        epochs=args.epochs,
        steps_per_epoch=args.steps_per_epoch,
        validation_steps=args.validation_steps,
        batch_size=args.batch_size,
        patch_size=args.patch_size,
        cell_patch_probability=args.cell_patch_probability,
        patches_per_source_block=args.patches_per_source_block,
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        gradient_clip_norm=args.gradient_clip_norm,
        num_workers=args.num_workers,
        checkpoint_every=args.checkpoint_every,
        use_amp=not args.no_amp,
    )
    postprocess_config = replace(
        PostprocessConfig(),
        foreground_threshold=args.foreground_threshold,
        boundary_threshold=args.boundary_threshold,
        min_area_px=args.min_area_px,
        offset_scale_px=args.offset_scale_px,
        vote_smoothing_px=args.vote_smoothing_px,
        seed_min_distance_px=args.seed_min_distance_px,
        minimum_seed_votes=args.minimum_seed_votes,
        exclude_border=args.exclude_border,
    )
    return run_training(
        manifest_path=args.manifest,
        raw_root=args.raw_root,
        mask_root=args.mask_root,
        output_dir=args.output_dir,
        profile_id=args.profile_id,
        profile_version=args.profile_version,
        display_name=args.display_name,
        model_config=model_config,
        training_config=training_config,
        postprocess_config=postprocess_config,
        requested_device=args.device,
        run_id=args.run_id,
        code_revision=args.code_revision,
        export_model=not args.skip_onnx_export,
        verify_onnx_runtime=not args.no_onnx_runtime_check,
        evaluate_test=args.evaluate_test,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = (
            _validate_command(args) if args.command == "validate-manifest" else _train_command(args)
        )
    except (OSError, RuntimeError, ValueError) as exc:
        parser.exit(2, f"error: {exc}\n")
    print(json.dumps(_jsonable(result), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
