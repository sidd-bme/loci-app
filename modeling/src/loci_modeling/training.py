"""Reproducible random-initialization training and held-out evaluation."""

from __future__ import annotations

import os
import platform
import random
import tempfile
from contextlib import nullcontext
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np
import torch
from torch import nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from torch.utils.data import DataLoader

from .contracts import DatasetManifest, ModelConfig, PostprocessConfig, TrainingConfig
from .data import (
    CellAwarePatchDataset,
    ResolvedSample,
    ensure_output_isolated,
    load_pair,
    resolve_samples,
    sha256_file,
)
from .export import atomic_write_json, export_bundle, validate_profile_identity
from .inference import predict_logits_tiled
from .losses import LociInstanceLoss
from .metrics import aggregate_agreement, aggregate_agreement_by_group, agreement_metrics
from .model import LociResidualUNet
from .postprocess import logits_to_instances
from .preprocessing import DEFAULT_PREPROCESSING_CONFIG, PreprocessingConfig

SplitName = Literal["train", "validation", "test"]


def configure_reproducibility(seed: int) -> None:
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True


def select_device(requested: str = "auto") -> torch.device:
    allowed = {"auto", "cpu", "cuda", "mps"}
    if requested not in allowed:
        raise ValueError(f"device must be one of {sorted(allowed)}")
    if requested == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")
    if requested == "mps" and not (
        hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    ):
        raise RuntimeError("MPS was requested but is not available")
    return torch.device(requested)


def _loader(
    dataset: CellAwarePatchDataset,
    config: TrainingConfig,
    *,
    device: torch.device,
    seed: int,
) -> DataLoader[tuple[torch.Tensor, torch.Tensor]]:
    generator = torch.Generator()
    generator.manual_seed(seed)
    return DataLoader(
        dataset,
        batch_size=config.batch_size,
        shuffle=False,
        num_workers=config.num_workers,
        pin_memory=device.type == "cuda",
        drop_last=True,
        generator=generator,
        # Workers are recreated each epoch so they receive dataset.set_epoch().
        persistent_workers=False,
    )


def _mean_components(totals: dict[str, float], batches: int) -> dict[str, float]:
    if batches < 1:
        raise ValueError("a training or validation epoch produced no batches")
    return {name: value / batches for name, value in sorted(totals.items())}


def _accumulate(totals: dict[str, float], components: dict[str, torch.Tensor]) -> None:
    for name, value in components.items():
        totals[name] = totals.get(name, 0.0) + float(value.cpu())


def _autocast_context(device: torch.device, enabled: bool):
    if not enabled:
        return nullcontext()
    return torch.autocast(device_type=device.type, dtype=torch.float16)


def _train_epoch(
    model: nn.Module,
    loader: DataLoader[tuple[torch.Tensor, torch.Tensor]],
    loss_function: LociInstanceLoss,
    optimizer: AdamW,
    scaler: torch.cuda.amp.GradScaler,
    *,
    device: torch.device,
    gradient_clip_norm: float,
    amp_enabled: bool,
) -> dict[str, float]:
    model.train()
    totals: dict[str, float] = {}
    batch_count = 0
    for images, targets in loader:
        images = images.to(device=device, non_blocking=True)
        targets = targets.to(device=device, non_blocking=True)
        optimizer.zero_grad(set_to_none=True)
        with _autocast_context(device, amp_enabled):
            predictions = model(images)
            loss, components = loss_function(predictions, targets)
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), gradient_clip_norm)
        scaler.step(optimizer)
        scaler.update()
        _accumulate(totals, components)
        batch_count += 1
    return _mean_components(totals, batch_count)


@torch.inference_mode()
def _validate_epoch(
    model: nn.Module,
    loader: DataLoader[tuple[torch.Tensor, torch.Tensor]],
    loss_function: LociInstanceLoss,
    *,
    device: torch.device,
    amp_enabled: bool,
) -> dict[str, float]:
    model.eval()
    totals: dict[str, float] = {}
    batch_count = 0
    for images, targets in loader:
        images = images.to(device=device, non_blocking=True)
        targets = targets.to(device=device, non_blocking=True)
        with _autocast_context(device, amp_enabled):
            predictions = model(images)
            _, components = loss_function(predictions, targets)
        _accumulate(totals, components)
        batch_count += 1
    return _mean_components(totals, batch_count)


def atomic_torch_save(value: object, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        torch.save(value, temporary)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _checkpoint_state(
    *,
    epoch: int,
    model: LociResidualUNet,
    optimizer: AdamW,
    scheduler: CosineAnnealingLR,
    best_validation_loss: float,
    manifest: DatasetManifest,
    model_config: ModelConfig,
    training_config: TrainingConfig,
    postprocess_config: PostprocessConfig,
    preprocessing_config: PreprocessingConfig,
    run_id: str,
) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "epoch": epoch,
        "run_id": run_id,
        "manifest_sha256": manifest.manifest_sha256,
        "dataset_id": manifest.dataset_id,
        "rights_id": manifest.rights.record_id,
        "random_initialization": True,
        "pretrained_weights": False,
        "best_validation_loss": best_validation_loss,
        "model_config": asdict(model_config),
        "training_config": asdict(training_config),
        "postprocess_config": asdict(postprocess_config),
        "preprocessing_config": asdict(preprocessing_config),
        "model_state_dict": model.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
        "scheduler_state_dict": scheduler.state_dict(),
    }


@torch.inference_mode()
def evaluate_split(
    model: LociResidualUNet,
    samples: tuple[ResolvedSample, ...],
    *,
    split: SplitName,
    device: torch.device,
    tile_size: int,
    postprocess_config: PostprocessConfig,
    reference_kind: str,
    batch_size: int,
    preprocessing_config: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for sample in samples:
        image, reference = load_pair(sample, preprocessing_config)
        logits = predict_logits_tiled(
            model,
            image,
            device=device,
            tile_size=tile_size,
            overlap=tile_size // 4,
            batch_size=batch_size,
        )
        prediction, _ = logits_to_instances(logits, postprocess_config)
        metrics = agreement_metrics(reference, prediction)
        rows.append(
            {
                "sample_id": sample.record.sample_id,
                "label_id": sample.record.label_id,
                "source": sample.record.raw,
                "label": sample.record.mask,
                "group": sample.record.group,
                **metrics,
            }
        )
    scope = (
        "pseudo_label_agreement"
        if reference_kind == "pseudo_label"
        else "adjudicated_reference_agreement"
    )
    return {
        "schema_version": "1.0",
        "split": split,
        "reference_kind": reference_kind,
        "summary": aggregate_agreement(rows, prefix=scope),
        "acquisition_groups": aggregate_agreement_by_group(rows, prefix=scope),
        "images": rows,
    }


def _validate_run_id(run_id: str) -> str:
    if not run_id or len(run_id) > 120 or any(character in run_id for character in "/\\"):
        raise ValueError("run_id must be a non-empty path-free identifier")
    return run_id


def default_run_id(manifest: DatasetManifest, seed: int) -> str:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"native-{timestamp}-{manifest.manifest_sha256[:8]}-s{seed}"


def run_training(
    *,
    manifest_path: str | Path,
    raw_root: str | Path,
    mask_root: str | Path,
    output_dir: str | Path,
    profile_id: str,
    profile_version: str,
    display_name: str,
    model_config: ModelConfig,
    training_config: TrainingConfig,
    postprocess_config: PostprocessConfig,
    requested_device: str = "auto",
    run_id: str | None = None,
    code_revision: str = "uncommitted-development",
    export_model: bool = True,
    verify_onnx_runtime: bool = True,
    evaluate_test: bool = False,
    preprocessing_config: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
) -> dict[str, Any]:
    """Run one isolated training job; source roots are only ever read."""

    validate_profile_identity(profile_id, profile_version, display_name)
    model_config.validate()
    training_config.validate(model_config)
    postprocess_config.validate()
    preprocessing_config.validate()
    manifest = DatasetManifest.load(manifest_path)
    output = ensure_output_isolated(output_dir, raw_root, mask_root)
    if output.exists() and any(output.iterdir()):
        raise FileExistsError("output_dir must be absent or empty for a new training run")

    # Resolve and hash-check training/validation before creating artifacts. The
    # locked test split is not touched unless this run explicitly releases it.
    resolved = {
        split: resolve_samples(manifest, raw_root, mask_root, split, verify_integrity=True)
        for split in ("train", "validation")
    }
    if not resolved["validation"]:
        raise ValueError("a held-out validation split is required")
    if evaluate_test:
        resolved["test"] = resolve_samples(
            manifest, raw_root, mask_root, "test", verify_integrity=True
        )
        if not resolved["test"]:
            raise ValueError("test evaluation was requested but the test split is empty")

    selected_run_id = _validate_run_id(run_id or default_run_id(manifest, training_config.seed))
    configure_reproducibility(training_config.seed)
    device = select_device(requested_device)
    amp_enabled = bool(training_config.use_amp and device.type == "cuda")
    output.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    requested_validation_patches = training_config.validation_steps * training_config.batch_size
    effective_validation_patches = max(
        requested_validation_patches,
        len(resolved["validation"]),
    )
    remainder = effective_validation_patches % training_config.batch_size
    if remainder:
        effective_validation_patches += training_config.batch_size - remainder

    run_configuration = {
        "schema_version": "1.0",
        "run_id": selected_run_id,
        "code_revision": code_revision,
        "manifest_sha256": manifest.manifest_sha256,
        "dataset_id": manifest.dataset_id,
        "rights_id": manifest.rights.record_id,
        "device": device.type,
        "amp_enabled": amp_enabled,
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
        "model": asdict(model_config),
        "training": asdict(training_config),
        "postprocess": asdict(postprocess_config),
        "preprocessing": asdict(preprocessing_config),
        "split_counts": {
            split: len(manifest.split(split)) for split in ("train", "validation", "test")
        },
        "test_split_released": evaluate_test,
        "effective_validation_patches": effective_validation_patches,
        "effective_validation_steps": (effective_validation_patches // training_config.batch_size),
        "quarantine_count": manifest.quarantine_count,
        "random_initialization": True,
        "pretrained_weights": False,
    }
    atomic_write_json(output / "run-config.json", run_configuration)
    atomic_write_json(output / "manifest-snapshot.json", manifest.relative_snapshot())

    train_dataset = CellAwarePatchDataset(
        resolved["train"],
        patch_size=training_config.patch_size,
        length=training_config.steps_per_epoch * training_config.batch_size,
        seed=training_config.seed,
        offset_scale_px=postprocess_config.offset_scale_px,
        cell_patch_probability=training_config.cell_patch_probability,
        patches_per_source_block=training_config.patches_per_source_block,
        augment=True,
        preprocessing=preprocessing_config,
    )
    validation_dataset = CellAwarePatchDataset(
        resolved["validation"],
        patch_size=training_config.patch_size,
        length=effective_validation_patches,
        seed=training_config.seed + 1,
        offset_scale_px=postprocess_config.offset_scale_px,
        cell_patch_probability=training_config.cell_patch_probability,
        patches_per_source_block=training_config.patches_per_source_block,
        augment=False,
        sampling_strategy="complete_coverage",
        preprocessing=preprocessing_config,
    )
    covered_validation_sources = set(validation_dataset.selected_sample_ids())
    expected_validation_sources = {sample.record.sample_id for sample in resolved["validation"]}
    if covered_validation_sources != expected_validation_sources:
        raise RuntimeError("deterministic validation patches do not cover every source")
    train_loader = _loader(train_dataset, training_config, device=device, seed=training_config.seed)
    validation_loader = _loader(
        validation_dataset, training_config, device=device, seed=training_config.seed + 1
    )

    model = LociResidualUNet(model_config).to(device)
    loss_function = LociInstanceLoss().to(device)
    optimizer = AdamW(
        model.parameters(),
        lr=training_config.learning_rate,
        weight_decay=training_config.weight_decay,
    )
    scheduler = CosineAnnealingLR(optimizer, T_max=training_config.epochs)
    scaler = torch.cuda.amp.GradScaler(enabled=amp_enabled)
    history: list[dict[str, Any]] = []
    best_validation_loss = float("inf")
    best_checkpoint = checkpoint_dir / "best.pt"

    for epoch_index in range(training_config.epochs):
        epoch = epoch_index + 1
        train_dataset.set_epoch(epoch_index)
        validation_dataset.set_epoch(0)
        train_metrics = _train_epoch(
            model,
            train_loader,
            loss_function,
            optimizer,
            scaler,
            device=device,
            gradient_clip_norm=training_config.gradient_clip_norm,
            amp_enabled=amp_enabled,
        )
        validation_metrics = _validate_epoch(
            model,
            validation_loader,
            loss_function,
            device=device,
            amp_enabled=amp_enabled,
        )
        scheduler.step()
        record = {
            "epoch": epoch,
            "learning_rate": float(optimizer.param_groups[0]["lr"]),
            "train": train_metrics,
            "validation": validation_metrics,
        }
        history.append(record)
        validation_loss = validation_metrics["loss"]
        improved = validation_loss < best_validation_loss
        if improved:
            best_validation_loss = validation_loss
        state = _checkpoint_state(
            epoch=epoch,
            model=model,
            optimizer=optimizer,
            scheduler=scheduler,
            best_validation_loss=best_validation_loss,
            manifest=manifest,
            model_config=model_config,
            training_config=training_config,
            postprocess_config=postprocess_config,
            preprocessing_config=preprocessing_config,
            run_id=selected_run_id,
        )
        if improved:
            atomic_torch_save(state, best_checkpoint)
        if epoch % training_config.checkpoint_every == 0 or epoch == training_config.epochs:
            atomic_torch_save(state, checkpoint_dir / f"epoch-{epoch:04d}.pt")
        atomic_write_json(output / "history.json", history)
        print(
            f"epoch={epoch}/{training_config.epochs} "
            f"train_loss={train_metrics['loss']:.6f} "
            f"validation_loss={validation_loss:.6f}",
            flush=True,
        )

    checkpoint = torch.load(best_checkpoint, map_location=device)
    if checkpoint.get("manifest_sha256") != manifest.manifest_sha256:
        raise RuntimeError("best checkpoint lineage does not match the active manifest")
    model.load_state_dict(checkpoint["model_state_dict"])
    checkpoint_sha256 = sha256_file(best_checkpoint)
    agreement_reports: dict[str, Any] = {}
    evaluation_splits = ["validation"] + (["test"] if evaluate_test else [])
    for split in evaluation_splits:
        report = evaluate_split(
            model,
            resolved[split],
            split=split,
            device=device,
            tile_size=training_config.patch_size,
            postprocess_config=postprocess_config,
            reference_kind=manifest.reference_kind,
            batch_size=training_config.batch_size,
            preprocessing_config=preprocessing_config,
        )
        agreement_reports[split] = report["summary"]
        atomic_write_json(output / f"{split}-agreement.json", report)

    exports: dict[str, Path | str] | None = None
    if export_model:
        exports = export_bundle(
            model=model,
            output_dir=output / "export",
            manifest=manifest,
            model_config=model_config,
            training_config=training_config,
            postprocess_config=postprocess_config,
            preprocessing_config=preprocessing_config,
            profile_id=profile_id,
            profile_version=profile_version,
            display_name=display_name,
            run_id=selected_run_id,
            checkpoint_sha256=checkpoint_sha256,
            code_revision=code_revision,
            agreement_summary=agreement_reports.get("validation"),
            verify_runtime=verify_onnx_runtime,
        )
    result = {
        "run_id": selected_run_id,
        "best_checkpoint": best_checkpoint,
        "best_checkpoint_sha256": checkpoint_sha256,
        "best_validation_loss": best_validation_loss,
        "agreement": agreement_reports,
        "exports": exports,
    }
    return result
