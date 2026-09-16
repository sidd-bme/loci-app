"""Atomic ONNX export and path-free deployment-profile publication."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

import torch
from torch import nn

from .contracts import DatasetManifest, ModelConfig, PostprocessConfig, TrainingConfig
from .data import sha256_file
from .model import LociResidualUNet, parameter_count
from .postprocess import logits_to_instances
from .preprocessing import DEFAULT_PREPROCESSING_CONFIG, PreprocessingConfig

_PROFILE_ID = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_ONNX_PARITY_RTOL = 5e-4
_ONNX_PARITY_ATOL = 5e-5


def atomic_write_json(path: Path, value: object) -> None:
    """Write one durable JSON document without exposing a partial destination."""

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def export_onnx(
    model: nn.Module,
    destination: Path,
    *,
    example_size: int,
    postprocess_config: PostprocessConfig,
    opset: int = 17,
    verify_runtime: bool = True,
    parity_rtol: float = _ONNX_PARITY_RTOL,
    parity_atol: float = _ONNX_PARITY_ATOL,
) -> str:
    """Export dynamic-spatial ONNX, validate it, and return its SHA-256.

    Runtime verification compares eager PyTorch and ONNX Runtime outputs for
    two deterministic, finite, non-square inputs.  The shapes independently
    vary height and width from the square tracing input, so a successful check
    exercises the declared dynamic spatial axes rather than only replaying the
    trace shape.  The default tolerances are intentionally tight enough for
    float32 inference while allowing normal backend accumulation differences.
    """

    if example_size < 16:
        raise ValueError("example_size must be at least 16")
    postprocess_config.validate()
    for name, value in {"parity_rtol": parity_rtol, "parity_atol": parity_atol}.items():
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"{name} must be finite and non-negative")
    try:
        import onnx
    except ImportError as exc:  # pragma: no cover - exercised without export extra
        raise RuntimeError("ONNX export requires the 'export' dependency group") from exc

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    was_training = model.training
    model.eval()
    example = torch.zeros((1, 1, example_size, example_size), dtype=torch.float32)
    try:
        torch.onnx.export(
            model.to(device="cpu", dtype=torch.float32),
            example,
            temporary,
            export_params=True,
            opset_version=opset,
            do_constant_folding=True,
            input_names=["image"],
            output_names=["heads"],
            dynamic_axes={
                "image": {0: "batch", 2: "height", 3: "width"},
                "heads": {0: "batch", 2: "height", 3: "width"},
            },
        )
        graph = onnx.load(str(temporary))
        onnx.checker.check_model(graph)
        if verify_runtime:
            try:
                import numpy as np
                import onnxruntime as ort
            except ImportError as exc:  # pragma: no cover - dependency guard
                raise RuntimeError(
                    "ONNX verification requires onnxruntime from the 'export' dependency group"
                ) from exc
            session = ort.InferenceSession(str(temporary), providers=["CPUExecutionProvider"])
            parity_shapes = (
                (example_size, example_size + 1),
                (example_size + 1, example_size),
            )
            for height, width in parity_shapes:
                # A ramp over the normalized input range is deterministic and
                # avoids the weak all-zero smoke test that can hide bad weights,
                # constants, or unsupported operator translations.
                parity_input = torch.linspace(
                    0.0,
                    1.0,
                    steps=height * width,
                    dtype=torch.float32,
                ).reshape(1, 1, height, width)
                with torch.inference_mode():
                    expected = model(parity_input).detach().cpu().numpy()
                result = session.run(None, {"image": parity_input.numpy()})[0]
                expected_shape = (1, 4, height, width)
                if expected.shape != expected_shape:
                    raise RuntimeError(
                        "PyTorch returned unexpected shape during ONNX parity verification: "
                        f"{expected.shape}, expected {expected_shape}"
                    )
                if result.shape != expected_shape:
                    raise RuntimeError(
                        "ONNX Runtime returned unexpected dynamic shape "
                        f"{result.shape}, expected {expected_shape}"
                    )
                if not np.isfinite(expected).all():
                    raise RuntimeError(
                        "PyTorch returned non-finite output during ONNX verification"
                    )
                if not np.isfinite(result).all():
                    raise RuntimeError("ONNX Runtime returned non-finite output")
                try:
                    np.testing.assert_allclose(
                        result,
                        expected,
                        rtol=parity_rtol,
                        atol=parity_atol,
                    )
                except AssertionError as exc:
                    absolute_error = np.abs(result - expected)
                    relative_scale = np.maximum(np.abs(expected), parity_atol)
                    max_absolute_error = float(absolute_error.max(initial=0.0))
                    max_relative_error = float(
                        np.divide(
                            absolute_error,
                            relative_scale,
                            out=np.zeros_like(absolute_error),
                            where=relative_scale > 0,
                        ).max(initial=0.0)
                    )
                    raise RuntimeError(
                        "ONNX numerical parity failed for input "
                        f"{height}x{width}: max_abs={max_absolute_error:.6g}, "
                        f"max_rel={max_relative_error:.6g}, "
                        f"rtol={parity_rtol:g}, atol={parity_atol:g}"
                    ) from exc
                expected_instances, _ = logits_to_instances(expected, postprocess_config)
                runtime_instances, _ = logits_to_instances(result, postprocess_config)
                expected_count = int(expected_instances.max(initial=0))
                runtime_count = int(runtime_instances.max(initial=0))
                if runtime_count != expected_count:
                    raise RuntimeError(
                        "ONNX instance-count parity failed for input "
                        f"{height}x{width}: PyTorch count={expected_count}, "
                        f"ONNX Runtime count={runtime_count}"
                    )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
        model.train(was_training)
    return sha256_file(destination)


def validate_profile_identity(profile_id: str, version: str, display_name: str) -> None:
    """Validate publishable profile identity fields before training starts."""

    if (
        not isinstance(profile_id, str)
        or len(profile_id) > 80
        or not _PROFILE_ID.fullmatch(profile_id)
    ):
        raise ValueError("profile_id must be a lowercase path-free identifier")
    if not isinstance(version, str) or len(version) > 80 or not _SEMVER.fullmatch(version):
        raise ValueError("profile version must use semantic versioning")
    if (
        not isinstance(display_name, str)
        or not display_name.strip()
        or display_name != display_name.strip()
        or len(display_name) > 120
        or any(ord(character) < 32 for character in display_name)
    ):
        raise ValueError("display_name must be non-empty and have no outer whitespace")


def build_engine_profile(
    *,
    profile_id: str,
    profile_version: str,
    display_name: str,
    model_sha256: str,
    artifact_id: str,
    manifest: DatasetManifest,
    postprocess: PostprocessConfig,
    validation_available: bool,
    preprocessing_config: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
) -> dict[str, object]:
    """Build the strict engine profile contract without importing the engine."""

    validate_profile_identity(profile_id, profile_version, display_name)
    preprocessing_config.validate()
    if not re.fullmatch(r"[0-9a-f]{64}", model_sha256):
        raise ValueError("model_sha256 must be a lowercase SHA-256")
    if not _PROFILE_ID.fullmatch(artifact_id):
        raise ValueError("artifact_id must be a lowercase path-free identifier")
    reference_word = "pseudo-label" if manifest.reference_kind == "pseudo_label" else "reference"
    validation_status = "limited" if validation_available else "unvalidated"
    validation_summary = (
        f"Developer model measured against held-out {reference_word} masks; biological accuracy "
        "and cross-lab generalization remain unverified."
        if validation_available
        else "Developer model has not completed held-out agreement evaluation."
    )
    reference_lineage = (
        f" Adjudicated reference record {manifest.adjudication_record_id}."
        if manifest.adjudication_record_id is not None
        else " Historical segmentation masks are explicitly treated as pseudo-labels."
    )
    reference_failure_mode = (
        {
            "code": "adjudicated-reference-scope",
            "summary": (
                "Adjudication improves reference quality but does not establish cross-lab "
                "generalization."
            ),
        }
        if manifest.adjudication_record_id is not None
        else {
            "code": "pseudo-label-reference",
            "summary": "Agreement to historical masks is not independent biological truth.",
        }
    )
    return {
        "schema_version": "1.1",
        "id": profile_id,
        "name": display_name,
        "version": profile_version,
        # The shipped engine deliberately has no native ONNX backend yet.
        "status": "unavailable",
        "backend_kind": "onnx",
        "model": {
            "format": "onnx",
            "artifact_id": artifact_id,
            "sha256": model_sha256,
        },
        "preprocessing": {
            "channel_conversion": preprocessing_config.channel_conversion,
            "intensity_normalization": preprocessing_config.intensity_normalization,
            "resize_policy": preprocessing_config.resize_policy,
            "max_edge_px": preprocessing_config.max_edge_px,
            "output_grid": preprocessing_config.output_grid,
        },
        "rights": {
            "code_license": "LicenseRef-Loci-Proprietary",
            "model_license": "LicenseRef-Loci-Weights",
            "redistribution": "permitted",
            "commercial_use": "permitted",
            "training_data_lineage": (
                "Random initialization trained only on rights-cleared source images and "
                f"segmentation labels under rights record {manifest.rights.record_id}."
                f"{reference_lineage}"
            ),
        },
        "recommended_settings": {
            "image_mode": "brightfield",
            "polarity": "auto",
            # Pixel units refer to the max-edge-1000 working grid. The current
            # rights-cleared corpus audit places typical cells near 12-13 px.
            "expected_diameter_px": 13.0,
            "min_area_px": postprocess.min_area_px,
            "sensitivity": 0.0,
            "smoothing_px": postprocess.vote_smoothing_px,
            "split_touching": True,
            "exclude_border": postprocess.exclude_border,
        },
        "validation": {
            "status": validation_status,
            "summary": validation_summary,
            "failure_modes": [
                reference_failure_mode,
                {
                    "code": "domain-shift",
                    "summary": (
                        "Performance can degrade for unseen optics, cell types, or confluence."
                    ),
                },
                {
                    "code": "viability-not-measured",
                    "summary": "Unstained morphology alone does not establish cell viability.",
                },
            ],
        },
    }


def export_bundle(
    *,
    model: LociResidualUNet,
    output_dir: Path,
    manifest: DatasetManifest,
    model_config: ModelConfig,
    training_config: TrainingConfig,
    postprocess_config: PostprocessConfig,
    profile_id: str,
    profile_version: str,
    display_name: str,
    run_id: str,
    checkpoint_sha256: str,
    code_revision: str,
    agreement_summary: dict[str, Any] | None,
    preprocessing_config: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
    verify_runtime: bool = True,
) -> dict[str, Path | str]:
    """Export model, detailed lineage metadata, and the strict engine profile."""

    validate_profile_identity(profile_id, profile_version, display_name)
    preprocessing_config.validate()
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "model.onnx"
    model_sha256 = export_onnx(
        model,
        model_path,
        example_size=training_config.patch_size,
        postprocess_config=postprocess_config,
        verify_runtime=verify_runtime,
    )
    artifact_id = f"{profile_id}-weights-{model_sha256[:12]}"
    profile = build_engine_profile(
        profile_id=profile_id,
        profile_version=profile_version,
        display_name=display_name,
        model_sha256=model_sha256,
        artifact_id=artifact_id,
        manifest=manifest,
        postprocess=postprocess_config,
        validation_available=agreement_summary is not None,
        preprocessing_config=preprocessing_config,
    )
    metadata: dict[str, Any] = {
        "schema_version": "1.0",
        "artifact": {
            "id": artifact_id,
            "filename": model_path.name,
            "format": "onnx",
            "opset": 17,
            "sha256": model_sha256,
            "input": {"name": "image", "layout": "NCHW", "channels": 1},
            "output": {
                "name": "heads",
                "layout": "NCHW",
                "channels": ["foreground_logit", "boundary_logit", "offset_x", "offset_y"],
            },
        },
        "architecture": {
            "name": "loci-residual-unet",
            "parameter_count": parameter_count(model),
            "configuration": asdict(model_config),
            "initialization": "random-kaiming-normal",
            "pretrained_weights": False,
        },
        "preprocessing": {
            **asdict(preprocessing_config),
            "coordinate_policy": (
                "downsample-image-and-instance-mask-together-before-target-generation; "
                "restore-predictions-to-source-resolution-output-grid"
            ),
            "manifest_alignment_policy": (
                "align-decoded-image-to-declared-label-grid-before-common-downsampling; "
                "never-interpolate-the-manifest-label-during-alignment"
            ),
        },
        "inference": {
            "tile_size": training_config.patch_size,
            "tile_overlap": training_config.patch_size // 4,
            "postprocess": asdict(postprocess_config),
            "counting_policy": "retain-border-instances-and-count-each-postprocessed-instance",
        },
        "lineage": {
            "run_id": run_id,
            "code_revision": code_revision,
            "checkpoint_sha256": checkpoint_sha256,
            **manifest.reference_lineage(),
            "rights": {
                "commercial_training_eligible": True,
                "redistributable_weights_eligible": True,
                "source_images_for_commercial_training": "cleared",
                "segmentation_labels_for_commercial_training": "cleared",
                "derived_weights_for_redistribution": "cleared",
            },
            "active_source_count": len(manifest.samples),
            "quarantine_source_count": manifest.quarantine_count,
            "split_counts": {
                split: len(manifest.split(split)) for split in ("train", "validation", "test")
            },
        },
        "training": asdict(training_config),
        "agreement": agreement_summary,
        "limitations": [
            "Historical segmentation masks are pseudo-labels unless explicitly adjudicated.",
            "No viability claim can be inferred from morphology alone.",
            "External laboratory and cell-type performance requires prospective validation.",
        ],
    }
    profile_path = output_dir / "profile.json"
    metadata_path = output_dir / "model-metadata.json"
    atomic_write_json(profile_path, profile)
    atomic_write_json(metadata_path, metadata)
    return {
        "model": model_path,
        "model_sha256": model_sha256,
        "profile": profile_path,
        "metadata": metadata_path,
    }
