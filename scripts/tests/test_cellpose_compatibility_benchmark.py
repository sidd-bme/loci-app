from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

from scripts import cellpose_compatibility_benchmark as benchmark


def _identity(path: Path) -> benchmark.FileIdentity:
    payload = path.read_bytes()
    return benchmark.FileIdentity(
        path=path.resolve(),
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )


def _arguments(
    tmp_path: Path,
    *,
    profile: str = "test-profile",
    images: list[Path] | None = None,
    checkpoint: Path | None = None,
    output: Path | None = None,
    overwrite: bool = False,
) -> argparse.Namespace:
    checkpoint = checkpoint or tmp_path / "checkpoint"
    if not checkpoint.exists():
        checkpoint.write_bytes(b"checkpoint")
    images = images or [tmp_path / "image.png"]
    for image in images:
        if not image.exists():
            image.write_bytes(b"image")
    return argparse.Namespace(
        image=[os.fspath(path) for path in images],
        profile=profile,
        checkpoint=os.fspath(checkpoint),
        settings_json=None,
        device="cpu",
        warm_runs=2,
        timeout_seconds=30.0,
        engine_python=sys.executable,
        output=os.fspath(output or tmp_path / "report.json"),
        overwrite=overwrite,
    )


def _config(
    tmp_path: Path,
) -> tuple[benchmark.BenchmarkConfig, benchmark.CheckpointSpec]:
    checkpoint_path = tmp_path / "cpsam"
    source_path = tmp_path / "cells.png"
    checkpoint_path.write_bytes(b"checkpoint")
    source_path.write_bytes(b"source")
    checkpoint = _identity(checkpoint_path)
    source = _identity(source_path)
    spec = benchmark.CheckpointSpec(
        profile_id="cellpose-sam",
        artifact_id="cpsam",
        size_bytes=checkpoint.size_bytes,
        sha256=checkpoint.sha256,
    )
    return (
        benchmark.BenchmarkConfig(
            engine_python=Path(sys.executable).resolve(),
            profile_id=spec.profile_id,
            checkpoint=checkpoint,
            sources=(source,),
            settings=dict(benchmark.DEFAULT_SETTINGS),
            settings_file=None,
            warm_runs=1,
            timeout_seconds=30,
            output_path=tmp_path / "report.json",
            overwrite=False,
        ),
        spec,
    )


def _segment_result(
    config: benchmark.BenchmarkConfig,
    spec: benchmark.CheckpointSpec,
) -> dict[str, object]:
    source = config.sources[0]
    return {
        "result_id": "result-1",
        "source": {
            "path": os.fspath(source.path),
            "name": source.path.name,
            "width": 80,
            "height": 60,
            "channels": 3,
            "dtype": "uint8",
            "format": "PNG",
            "page_count": 1,
            "sha256": source.sha256,
        },
        "profile": {
            "id": spec.profile_id,
            "name": "Cellpose",
            "version": benchmark.CELLPOSE_VERSION,
            "backend_kind": "cellpose",
            "model": {
                "format": "cellpose-native",
                "artifact_id": spec.artifact_id,
                "sha256": spec.sha256,
            },
            "preprocessing": {"output_grid": "source-resolution"},
        },
        "runtime": {
            "package": {"name": "cellpose", "version": benchmark.CELLPOSE_VERSION},
            "model": {"artifact_id": spec.artifact_id, "sha256": spec.sha256},
            "profile_id": spec.profile_id,
            "preprocessing_mode": "huggingface-space-uint8",
            "requested_device": "auto",
            "resolved_device": "cpu",
            "fallback_reason": None,
            "inference_scale": 1.0,
        },
        "settings": dict(config.settings),
        "metrics": {"count": 12, "confluence_percent": 15.5},
        "cell_count": 12,
        "quality": {
            "status": "nominal",
            "scope": "structural_sanity_only",
            "flags": [],
        },
    }


def _ready_status(spec: benchmark.CheckpointSpec) -> dict[str, object]:
    return {
        "profile_id": spec.profile_id,
        "ready": True,
        "code": "ready",
        "package": {
            "required_version": benchmark.CELLPOSE_VERSION,
            "installed_version": benchmark.CELLPOSE_VERSION,
            "exact": True,
        },
        "model": {
            "artifact_id": spec.artifact_id,
            "expected_sha256": spec.sha256,
            "expected_size_bytes": spec.size_bytes,
            "managed_path": "/ephemeral/model",
            "present": True,
            "verified": True,
        },
        "devices": {"cpu": True, "mps": False, "cuda": False},
    }


def test_validate_arguments_accepts_only_matching_explicit_inputs(
    tmp_path: Path,
) -> None:
    arguments = _arguments(tmp_path)
    checkpoint = Path(arguments.checkpoint)
    checkpoint_identity = _identity(checkpoint)
    spec = benchmark.CheckpointSpec(
        profile_id=arguments.profile,
        artifact_id="test-checkpoint",
        size_bytes=checkpoint_identity.size_bytes,
        sha256=checkpoint_identity.sha256,
    )
    identities = {
        checkpoint.resolve(): checkpoint_identity,
        Path(arguments.image[0]).resolve(): _identity(Path(arguments.image[0])),
    }

    config = benchmark.validate_arguments(
        arguments,
        specs={spec.profile_id: spec},
        fingerprinter=lambda path: identities[path.resolve()],
    )

    assert config.profile_id == spec.profile_id
    assert config.checkpoint == checkpoint_identity
    assert config.settings["max_edge_px"] == 1000
    assert config.settings["niter"] == 250
    assert config.settings["flow_threshold"] == 0.4
    assert config.settings["cellprob_threshold"] == 0.0
    assert config.settings["device"] == "cpu"


def test_validate_arguments_preserves_virtual_environment_interpreter_symlink(
    tmp_path: Path,
) -> None:
    arguments = _arguments(tmp_path)
    engine_link = tmp_path / "venv-python"
    engine_link.symlink_to(sys.executable)
    arguments.engine_python = os.fspath(engine_link)
    checkpoint = _identity(Path(arguments.checkpoint))
    spec = benchmark.CheckpointSpec(
        profile_id=arguments.profile,
        artifact_id="checkpoint",
        size_bytes=checkpoint.size_bytes,
        sha256=checkpoint.sha256,
    )

    config = benchmark.validate_arguments(arguments, specs={spec.profile_id: spec})

    assert config.engine_python == engine_link


def test_validate_arguments_rejects_profile_checkpoint_mismatch(tmp_path: Path) -> None:
    arguments = _arguments(tmp_path)
    actual = _identity(Path(arguments.checkpoint))
    spec = benchmark.CheckpointSpec(
        profile_id=arguments.profile,
        artifact_id="different-checkpoint",
        size_bytes=actual.size_bytes,
        sha256="0" * 64,
    )

    with pytest.raises(benchmark.HarnessError, match="does not match"):
        benchmark.validate_arguments(
            arguments,
            specs={spec.profile_id: spec},
            fingerprinter=lambda path: _identity(path),
        )


def test_validate_arguments_rejects_relative_and_duplicate_images(
    tmp_path: Path,
) -> None:
    arguments = _arguments(tmp_path)
    arguments.image = ["relative.png"]
    actual = _identity(Path(arguments.checkpoint))
    spec = benchmark.CheckpointSpec(
        profile_id=arguments.profile,
        artifact_id="checkpoint",
        size_bytes=actual.size_bytes,
        sha256=actual.sha256,
    )
    with pytest.raises(benchmark.HarnessError, match="absolute path"):
        benchmark.validate_arguments(arguments, specs={spec.profile_id: spec})

    image = tmp_path / "same.png"
    image.write_bytes(b"same")
    arguments = _arguments(tmp_path, images=[image, image])
    with pytest.raises(benchmark.HarnessError, match="Duplicate image"):
        benchmark.validate_arguments(arguments, specs={spec.profile_id: spec})


def test_fingerprint_rejects_symbolic_links(tmp_path: Path) -> None:
    target = tmp_path / "target.png"
    link = tmp_path / "link.png"
    target.write_bytes(b"pixels")
    link.symlink_to(target)

    with pytest.raises(benchmark.HarnessError, match="symbolic link"):
        benchmark.fingerprint_file(link, label="Image")


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"unknown": 1}, "Unknown Cellpose settings"),
        ({"flow_threshold": float("nan")}, "finite number"),
        ({"max_edge_px": True}, "must be an integer"),
        ({"percentile_low": 99, "percentile_high": 1}, "must be less"),
        ({"device": "metal"}, "Unsupported device"),
    ],
)
def test_validate_settings_fails_closed(
    overrides: dict[str, object], message: str
) -> None:
    with pytest.raises(benchmark.HarnessError, match=message):
        benchmark.validate_settings(overrides, device=None)


def test_validate_status_strips_ephemeral_managed_path(tmp_path: Path) -> None:
    _, spec = _config(tmp_path)
    validated = benchmark.validate_status(_ready_status(spec), spec)

    assert validated["ready"] is True
    assert "managed_path" not in validated["model"]


def test_build_run_record_rejects_source_model_and_settings_drift(
    tmp_path: Path,
) -> None:
    config, spec = _config(tmp_path)
    result = _segment_result(config, spec)
    record = benchmark.build_run_record(
        result,
        source=config.sources[0],
        spec=spec,
        settings=config.settings,
        elapsed_seconds=1.23456789,
    )
    assert record["worker_round_trip_seconds"] == 1.234568
    assert record["count"] == 12
    assert record["structural_scope"] == "structural_sanity_only"

    result["runtime"]["model"]["sha256"] = "0" * 64
    with pytest.raises(benchmark.HarnessError, match="runtime model SHA-256 mismatch"):
        benchmark.build_run_record(
            result,
            source=config.sources[0],
            spec=spec,
            settings=config.settings,
            elapsed_seconds=1,
        )


def test_build_report_is_deterministic_and_preserves_claim_boundary(
    tmp_path: Path,
) -> None:
    config, spec = _config(tmp_path)
    status = benchmark.validate_status(_ready_status(spec), spec)
    run = benchmark.build_run_record(
        _segment_result(config, spec),
        source=config.sources[0],
        spec=spec,
        settings=config.settings,
        elapsed_seconds=2.5,
    )
    source_result = {
        "authorized_path": os.fspath(config.sources[0].path),
        "size_bytes": config.sources[0].size_bytes,
        "sha256": config.sources[0].sha256,
        "verified_status": status,
        "cold": run,
        "warm": [run],
        "repeat_consistency": {
            "count_identical": True,
            "structural_status_identical": True,
        },
    }
    report = benchmark.build_report(
        config,
        spec=spec,
        health={"status": "ready", "engine_version": "0.1.0"},
        provision_status=status,
        provisioning_seconds=3.25,
        source_results=[source_result],
        created_at="2026-09-01T00:00:00.000+00:00",
        host={"platform": "test", "machine": "test", "python_version": "3.12"},
    )

    assert report["schema"] == benchmark.REPORT_SCHEMA
    assert report["profile"]["profile_id"] == "cellpose-sam"
    assert report["sources"][0]["cold"]["count"] == 12
    assert "no biological performance claim" in report["claim_boundary"]
    assert "accuracy" not in report["claim_boundary"].lower()
    assert json.loads(json.dumps(report, allow_nan=False)) == report


def test_atomic_write_never_exposes_partial_or_implicit_overwrite(
    tmp_path: Path,
) -> None:
    output = tmp_path / "report.json"
    benchmark.atomic_write_json(output, {"version": 1}, overwrite=False)
    assert json.loads(output.read_text()) == {"version": 1}

    with pytest.raises(benchmark.HarnessError, match="appeared during publication"):
        benchmark.atomic_write_json(output, {"version": 2}, overwrite=False)
    assert json.loads(output.read_text()) == {"version": 1}

    benchmark.atomic_write_json(output, {"version": 2}, overwrite=True)
    assert json.loads(output.read_text()) == {"version": 2}
