"""Reproducible, fail-closed Cellpose compatibility and timing harness.

This developer tool talks to ``loci_engine.worker`` over the same JSON-lines
protocol as the desktop application. It never imports Cellpose or implements a
second inference path. Checkpoints and source images must be named explicitly;
the harness does not discover files or download models.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import queue
import stat
import subprocess
import sys
import tempfile
import threading
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from types import MappingProxyType
from typing import Any, Self

REPORT_SCHEMA = "loci.cellpose-compatibility-benchmark/v1"
CELLPOSE_VERSION = "4.2.1.1"
HASH_CHUNK_BYTES = 8 * 1024 * 1024
SUPPORTED_IMAGE_SUFFIXES = frozenset({".jpeg", ".jpg", ".png", ".tif", ".tiff"})
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ENGINE_ROOT = REPOSITORY_ROOT / "engine"
DEFAULT_ENGINE_PYTHON = ENGINE_ROOT / ".venv" / "bin" / "python"


class HarnessError(RuntimeError):
    """A bounded, actionable failure that must stop report publication."""


@dataclass(frozen=True, slots=True)
class CheckpointSpec:
    profile_id: str
    artifact_id: str
    size_bytes: int
    sha256: str


CHECKPOINT_SPECS: Mapping[str, CheckpointSpec] = MappingProxyType(
    {
        "cellpose-sam": CheckpointSpec(
            profile_id="cellpose-sam",
            artifact_id="cpsam",
            size_bytes=1_233_587_898,
            sha256="e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2",
        ),
        "cellpose-sam-v2": CheckpointSpec(
            profile_id="cellpose-sam-v2",
            artifact_id="cpsam_v2",
            size_bytes=1_233_586_851,
            sha256="0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667",
        ),
    }
)

DEFAULT_SETTINGS: Mapping[str, object] = MappingProxyType(
    {
        "max_edge_px": 1000,
        "diameter_px": 0.0,
        "flow_threshold": 0.4,
        "cellprob_threshold": 0.0,
        "min_size_px": 15,
        "max_size_fraction": 0.4,
        "niter": 250,
        "batch_size": 8,
        "resample": True,
        "augment": False,
        "tile_overlap": 0.1,
        "normalize": True,
        "percentile_low": 1.0,
        "percentile_high": 99.0,
        "tile_norm_blocksize": 0,
        "sharpen_radius": 0.0,
        "smooth_radius": 0.0,
        "invert": False,
        "device": "auto",
    }
)


@dataclass(frozen=True, slots=True)
class FileIdentity:
    path: Path
    size_bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class BenchmarkConfig:
    engine_python: Path
    profile_id: str
    checkpoint: FileIdentity
    sources: tuple[FileIdentity, ...]
    settings: dict[str, object]
    settings_file: FileIdentity | None
    warm_runs: int
    timeout_seconds: float
    output_path: Path
    overwrite: bool


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run exact-checkpoint Cellpose compatibility and cold/warm timing checks through "
            "the Loci engine worker."
        )
    )
    parser.add_argument(
        "--image",
        action="append",
        required=True,
        metavar="ABSOLUTE_PATH",
        help="Explicitly authorized still image. Repeat for additional images; folders are not scanned.",
    )
    parser.add_argument("--profile", required=True, choices=tuple(CHECKPOINT_SPECS))
    parser.add_argument(
        "--checkpoint",
        required=True,
        metavar="ABSOLUTE_PATH",
        help="Official checkpoint matching --profile; exact size and SHA-256 are required.",
    )
    parser.add_argument(
        "--settings-json",
        metavar="ABSOLUTE_PATH",
        help="Optional JSON object overriding the frozen website-compatible settings.",
    )
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"))
    parser.add_argument("--warm-runs", type=int, default=1, metavar="N")
    parser.add_argument(
        "--timeout-seconds", type=float, default=900.0, metavar="SECONDS"
    )
    parser.add_argument(
        "--engine-python",
        default=os.fspath(DEFAULT_ENGINE_PYTHON),
        metavar="ABSOLUTE_PATH",
        help="Python interpreter containing the installed loci_engine worker.",
    )
    parser.add_argument("--output", required=True, metavar="ABSOLUTE_PATH")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Explicitly replace an existing regular JSON report.",
    )
    return parser


def _absolute_path(value: str, *, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise HarnessError(f"{label} must be an absolute path: {value}")
    return path


def _regular_file(
    path: Path, *, label: str, reject_symlink: bool = True
) -> os.stat_result:
    try:
        file_stat = path.lstat()
    except OSError as exc:
        raise HarnessError(f"{label} is not readable: {path}") from exc
    if reject_symlink and stat.S_ISLNK(file_stat.st_mode):
        raise HarnessError(
            f"{label} must be a regular file, not a symbolic link: {path}"
        )
    if stat.S_ISLNK(file_stat.st_mode):
        try:
            file_stat = path.stat()
        except OSError as exc:
            raise HarnessError(
                f"{label} symbolic-link target is not readable: {path}"
            ) from exc
    if not stat.S_ISREG(file_stat.st_mode):
        raise HarnessError(f"{label} must be a regular file: {path}")
    return file_stat


def fingerprint_file(path: Path, *, label: str) -> FileIdentity:
    """Hash one stable regular file through a no-follow descriptor."""

    before = _regular_file(path, label=label)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise HarnessError(f"{label} could not be opened safely: {path}") from exc
    digest = hashlib.sha256()
    try:
        opened_before = os.fstat(descriptor)
        if not stat.S_ISREG(opened_before.st_mode):
            raise HarnessError(f"{label} must remain a regular file: {path}")
        if (opened_before.st_dev, opened_before.st_ino) != (
            before.st_dev,
            before.st_ino,
        ):
            raise HarnessError(f"{label} changed while it was being opened: {path}")
        while chunk := os.read(descriptor, HASH_CHUNK_BYTES):
            digest.update(chunk)
        opened_after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    after = _regular_file(path, label=label)
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_opened_after = (
        opened_after.st_dev,
        opened_after.st_ino,
        opened_after.st_size,
        opened_after.st_mtime_ns,
    )
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_before != identity_opened_after or identity_before != identity_after:
        raise HarnessError(f"{label} changed while SHA-256 was being computed: {path}")
    return FileIdentity(
        path=path.resolve(), size_bytes=int(after.st_size), sha256=digest.hexdigest()
    )


def _read_settings_file(path: Path) -> tuple[dict[str, object], FileIdentity]:
    identity = fingerprint_file(path, label="Settings JSON")
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise HarnessError(f"Settings JSON is not readable UTF-8: {path}") from exc
    if fingerprint_file(path, label="Settings JSON") != identity:
        raise HarnessError(f"Settings JSON changed while it was being read: {path}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HarnessError(
            f"Settings JSON is invalid at line {exc.lineno}, column {exc.colno}."
        ) from exc
    if not isinstance(value, dict):
        raise HarnessError("Settings JSON must contain one object.")
    return value, identity


def validate_settings(
    overrides: Mapping[str, object], *, device: str | None
) -> dict[str, object]:
    unknown = set(overrides) - set(DEFAULT_SETTINGS)
    if unknown:
        raise HarnessError(f"Unknown Cellpose settings: {', '.join(sorted(unknown))}")
    settings = dict(DEFAULT_SETTINGS)
    settings.update(overrides)
    if device is not None:
        settings["device"] = device

    for name in (
        "max_edge_px",
        "min_size_px",
        "niter",
        "batch_size",
        "tile_norm_blocksize",
    ):
        value = settings[name]
        if isinstance(value, bool) or not isinstance(value, int):
            raise HarnessError(f"{name} must be an integer")
    for name in (
        "diameter_px",
        "flow_threshold",
        "cellprob_threshold",
        "max_size_fraction",
        "tile_overlap",
        "percentile_low",
        "percentile_high",
        "sharpen_radius",
        "smooth_radius",
    ):
        value = settings[name]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise HarnessError(f"{name} must be a finite number")
    for name in ("resample", "augment", "normalize", "invert"):
        if not isinstance(settings[name], bool):
            raise HarnessError(f"{name} must be a boolean")

    ranges: tuple[tuple[str, float, float], ...] = (
        ("max_edge_px", 64, 10_000),
        ("diameter_px", 0, 10_000),
        ("flow_threshold", 0, 3),
        ("cellprob_threshold", -10, 10),
        ("min_size_px", 0, 10_000_000),
        ("max_size_fraction", math.nextafter(0.0, 1.0), 1),
        ("niter", 1, 10_000),
        ("batch_size", 1, 256),
        ("tile_overlap", 0.05, 0.5),
        ("percentile_low", 0, 100),
        ("percentile_high", 0, 100),
        ("tile_norm_blocksize", 0, 10_000),
        ("sharpen_radius", 0, 10_000),
        ("smooth_radius", 0, 10_000),
    )
    for name, minimum, maximum in ranges:
        value = float(settings[name])
        if not minimum <= value <= maximum:
            raise HarnessError(f"{name} must be between {minimum:g} and {maximum:g}")
    if not float(settings["percentile_low"]) < float(settings["percentile_high"]):
        raise HarnessError("percentile_low must be less than percentile_high")
    if settings["device"] not in {"auto", "cpu", "mps", "cuda"}:
        raise HarnessError(f"Unsupported device: {settings['device']}")
    return settings


def validate_arguments(
    arguments: argparse.Namespace,
    *,
    specs: Mapping[str, CheckpointSpec] = CHECKPOINT_SPECS,
    fingerprinter: Callable[[Path], FileIdentity] | None = None,
) -> BenchmarkConfig:
    """Validate all explicit inputs before starting or provisioning a worker."""

    if arguments.profile not in specs:
        raise HarnessError(f"Unknown Cellpose profile: {arguments.profile}")
    if isinstance(arguments.warm_runs, bool) or not 1 <= arguments.warm_runs <= 10:
        raise HarnessError("--warm-runs must be between 1 and 10")
    if (
        not math.isfinite(arguments.timeout_seconds)
        or not 1 <= arguments.timeout_seconds <= 7200
    ):
        raise HarnessError("--timeout-seconds must be between 1 and 7200")

    engine_python = _absolute_path(arguments.engine_python, label="Engine Python")
    _regular_file(engine_python, label="Engine Python", reject_symlink=False)
    # Preserve a virtual-environment interpreter symlink. Resolving it to the
    # base interpreter would discard the venv's import path and make the
    # installed loci_engine module disappear.
    if not os.access(engine_python, os.X_OK):
        raise HarnessError(f"Engine Python is not executable: {engine_python}")

    def identify(path: Path, label: str) -> FileIdentity:
        if fingerprinter is None:
            return fingerprint_file(path, label=label)
        return fingerprinter(path)

    checkpoint_path = _absolute_path(arguments.checkpoint, label="Checkpoint")
    checkpoint = identify(checkpoint_path, "Checkpoint")
    spec = specs[arguments.profile]
    if checkpoint.size_bytes != spec.size_bytes or checkpoint.sha256 != spec.sha256:
        raise HarnessError(
            f"Checkpoint does not match {arguments.profile}/{spec.artifact_id}; expected "
            f"{spec.size_bytes} bytes and SHA-256 {spec.sha256}."
        )

    if not arguments.image or len(arguments.image) > 256:
        raise HarnessError("Provide between 1 and 256 explicit --image paths.")
    sources: list[FileIdentity] = []
    seen_paths: set[Path] = set()
    for index, raw_path in enumerate(arguments.image, start=1):
        path = _absolute_path(raw_path, label=f"Image {index}")
        if path.suffix.lower() not in SUPPORTED_IMAGE_SUFFIXES:
            raise HarnessError(
                f"Image {index} is not a supported 2D still type (TIFF, PNG, or JPEG): {path}"
            )
        identity = identify(path, f"Image {index}")
        if identity.path in seen_paths:
            raise HarnessError(f"Duplicate image path: {identity.path}")
        if identity.path == checkpoint.path:
            raise HarnessError("A checkpoint cannot also be used as an image.")
        seen_paths.add(identity.path)
        sources.append(identity)

    settings_file: FileIdentity | None = None
    overrides: dict[str, object] = {}
    if arguments.settings_json:
        settings_path = _absolute_path(arguments.settings_json, label="Settings JSON")
        overrides, settings_file = _read_settings_file(settings_path)
    settings = validate_settings(overrides, device=arguments.device)

    output_path = _absolute_path(arguments.output, label="Output report")
    if output_path.suffix.lower() != ".json":
        raise HarnessError("Output report must use a .json filename.")
    if not output_path.parent.is_dir():
        raise HarnessError(
            f"Output report directory does not exist: {output_path.parent}"
        )
    if output_path.is_symlink():
        raise HarnessError(f"Output report must not be a symbolic link: {output_path}")
    resolved_output = output_path.parent.resolve() / output_path.name
    protected_paths = {checkpoint.path, *(source.path for source in sources)}
    if resolved_output in protected_paths:
        raise HarnessError("Output report must not replace an input file.")
    if resolved_output.exists():
        _regular_file(resolved_output, label="Existing output report")
        if not arguments.overwrite:
            raise HarnessError(
                "Output report already exists; pass --overwrite to replace it."
            )

    return BenchmarkConfig(
        engine_python=engine_python,
        profile_id=arguments.profile,
        checkpoint=checkpoint,
        sources=tuple(sources),
        settings=settings,
        settings_file=settings_file,
        warm_runs=arguments.warm_runs,
        timeout_seconds=float(arguments.timeout_seconds),
        output_path=resolved_output,
        overwrite=bool(arguments.overwrite),
    )


class WorkerClient:
    """One sequential JSON-lines session with bounded response waits."""

    def __init__(
        self, engine_python: Path, model_home: Path, timeout_seconds: float
    ) -> None:
        environment = os.environ.copy()
        environment["LOCI_MODEL_HOME"] = os.fspath(model_home)
        environment.setdefault("HF_HUB_OFFLINE", "1")
        environment.setdefault("TRANSFORMERS_OFFLINE", "1")
        self._timeout_seconds = timeout_seconds
        self._responses: queue.Queue[str | None] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=80)
        self._request_number = 0
        try:
            self._process = subprocess.Popen(
                [os.fspath(engine_python), "-m", "loci_engine.worker"],
                cwd=ENGINE_ROOT,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as exc:
            raise HarnessError(
                f"Could not start the Loci engine worker: {exc}"
            ) from exc
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self._process.stdout is not None
        try:
            for line in self._process.stdout:
                self._responses.put(line)
        finally:
            self._responses.put(None)

    def _read_stderr(self) -> None:
        assert self._process.stderr is not None
        for line in self._process.stderr:
            self._stderr.append(line.rstrip())

    def request(self, method: str, params: Mapping[str, object]) -> dict[str, Any]:
        if self._process.poll() is not None:
            raise HarnessError(
                self._exit_message("Loci engine exited before a request.")
            )
        self._request_number += 1
        request_id = f"benchmark-{self._request_number}"
        payload = {"id": request_id, "method": method, "params": dict(params)}
        try:
            line = json.dumps(payload, separators=(",", ":"), allow_nan=False)
            assert self._process.stdin is not None
            self._process.stdin.write(line + "\n")
            self._process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise HarnessError(
                self._exit_message(f"Could not send worker method {method}.")
            ) from exc
        try:
            response_line = self._responses.get(timeout=self._timeout_seconds)
        except queue.Empty as exc:
            raise HarnessError(
                f"Loci engine method {method} exceeded {self._timeout_seconds:g} seconds."
            ) from exc
        if response_line is None:
            raise HarnessError(
                self._exit_message(f"Loci engine stopped during method {method}.")
            )
        try:
            response = json.loads(response_line)
        except json.JSONDecodeError as exc:
            raise HarnessError(
                f"Loci engine returned invalid JSON for method {method}."
            ) from exc
        if not isinstance(response, dict) or response.get("id") != request_id:
            raise HarnessError(
                f"Loci engine returned an out-of-sequence response for {method}."
            )
        error = response.get("error")
        if error is not None:
            if not isinstance(error, dict):
                raise HarnessError(
                    f"Loci engine method {method} failed without a structured error."
                )
            raise HarnessError(
                f"Loci engine method {method} failed "
                f"({error.get('type', 'Error')}): {error.get('message', 'No message')}"
            )
        result = response.get("result")
        if not isinstance(result, dict):
            raise HarnessError(
                f"Loci engine method {method} returned no result object."
            )
        return result

    def _exit_message(self, prefix: str) -> str:
        detail = "\n".join(self._stderr).strip()
        return f"{prefix}{f' Worker stderr:\n{detail}' if detail else ''}"

    def close(self) -> None:
        if self._process.stdin is not None and not self._process.stdin.closed:
            try:
                self._process.stdin.close()
            except OSError:
                pass
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=5)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _require_equal(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise HarnessError(
            f"Worker {label} mismatch: expected {expected!r}, received {actual!r}."
        )


def validate_status(
    status: Mapping[str, object], spec: CheckpointSpec
) -> dict[str, object]:
    _require_equal(status.get("profile_id"), spec.profile_id, "status profile")
    _require_equal(status.get("ready"), True, "readiness")
    _require_equal(status.get("code"), "ready", "readiness code")
    package = status.get("package")
    model = status.get("model")
    if not isinstance(package, dict) or not isinstance(model, dict):
        raise HarnessError("Worker status omitted package or model provenance.")
    _require_equal(
        package.get("required_version"), CELLPOSE_VERSION, "required runtime"
    )
    _require_equal(
        package.get("installed_version"), CELLPOSE_VERSION, "installed runtime"
    )
    _require_equal(package.get("exact"), True, "runtime pin")
    _require_equal(model.get("artifact_id"), spec.artifact_id, "artifact")
    _require_equal(model.get("expected_sha256"), spec.sha256, "checkpoint SHA-256")
    _require_equal(model.get("expected_size_bytes"), spec.size_bytes, "checkpoint size")
    _require_equal(model.get("present"), True, "checkpoint presence")
    _require_equal(model.get("verified"), True, "checkpoint verification")
    devices = status.get("devices")
    if not isinstance(devices, dict):
        raise HarnessError("Worker status omitted device capability provenance.")
    return {
        "ready": True,
        "code": "ready",
        "package": dict(package),
        "model": {key: value for key, value in model.items() if key != "managed_path"},
        "devices": dict(devices),
    }


def build_run_record(
    result: Mapping[str, object],
    *,
    source: FileIdentity,
    spec: CheckpointSpec,
    settings: Mapping[str, object],
    elapsed_seconds: float,
) -> dict[str, object]:
    """Extract and validate the bounded provenance needed from one segment result."""

    if not math.isfinite(elapsed_seconds) or elapsed_seconds < 0:
        raise HarnessError("Run timing must be a finite, non-negative number.")
    result_source = result.get("source")
    profile = result.get("profile")
    runtime = result.get("runtime")
    quality = result.get("quality")
    metrics = result.get("metrics")
    result_settings = result.get("settings")
    if not all(
        isinstance(value, dict)
        for value in (result_source, profile, runtime, quality, metrics)
    ):
        raise HarnessError("Worker segment result omitted required provenance objects.")
    if not isinstance(result_settings, dict):
        raise HarnessError("Worker segment result omitted exact settings.")

    assert isinstance(result_source, dict)
    assert isinstance(profile, dict)
    assert isinstance(runtime, dict)
    assert isinstance(quality, dict)
    assert isinstance(metrics, dict)
    _require_equal(result_source.get("sha256"), source.sha256, "source SHA-256")
    _require_equal(
        Path(str(result_source.get("path"))).resolve(), source.path, "source path"
    )
    _require_equal(profile.get("id"), spec.profile_id, "result profile")
    profile_model = profile.get("model")
    runtime_model = runtime.get("model")
    runtime_package = runtime.get("package")
    if not all(
        isinstance(value, dict)
        for value in (profile_model, runtime_model, runtime_package)
    ):
        raise HarnessError("Worker segment result omitted model or runtime identity.")
    assert isinstance(profile_model, dict)
    assert isinstance(runtime_model, dict)
    assert isinstance(runtime_package, dict)
    for model_identity, label in (
        (profile_model, "profile model"),
        (runtime_model, "runtime model"),
    ):
        _require_equal(
            model_identity.get("artifact_id"), spec.artifact_id, f"{label} artifact"
        )
        _require_equal(model_identity.get("sha256"), spec.sha256, f"{label} SHA-256")
    _require_equal(runtime.get("profile_id"), spec.profile_id, "runtime profile")
    _require_equal(runtime_package.get("name"), "cellpose", "runtime package name")
    _require_equal(
        runtime_package.get("version"), CELLPOSE_VERSION, "runtime package version"
    )
    _require_equal(result_settings, dict(settings), "resolved settings")
    _require_equal(
        runtime.get("requested_device"), settings["device"], "requested device"
    )

    count = result.get("cell_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise HarnessError("Worker cell_count must be a non-negative integer.")
    _require_equal(metrics.get("count"), count, "count provenance")
    status = quality.get("status")
    scope = quality.get("scope")
    flags = quality.get("flags")
    if status not in {"nominal", "warning", "invalid"}:
        raise HarnessError(
            f"Worker returned unsupported structural status: {status!r}."
        )
    _require_equal(scope, "structural_sanity_only", "quality scope")
    if not isinstance(flags, list) or not all(isinstance(flag, dict) for flag in flags):
        raise HarnessError("Worker structural flags must be an array of objects.")
    resolved_device = runtime.get("resolved_device")
    if resolved_device not in {"cpu", "mps", "cuda"}:
        raise HarnessError(
            f"Worker returned unsupported resolved device: {resolved_device!r}."
        )

    return {
        "worker_round_trip_seconds": round(elapsed_seconds, 6),
        "count": count,
        "structural_status": status,
        "structural_scope": scope,
        "structural_flags": flags,
        "source_metadata": {
            key: result_source.get(key)
            for key in (
                "name",
                "width",
                "height",
                "channels",
                "dtype",
                "format",
                "page_count",
            )
        },
        "profile": dict(profile),
        "runtime": dict(runtime),
    }


def _timed_segment(
    worker: WorkerClient,
    config: BenchmarkConfig,
    source: FileIdentity,
    spec: CheckpointSpec,
) -> dict[str, object]:
    started = perf_counter()
    result = worker.request(
        "segment",
        {
            "path": os.fspath(source.path),
            "expected_sha256": source.sha256,
            "profile_id": config.profile_id,
            "settings": config.settings,
        },
    )
    elapsed = perf_counter() - started
    record = build_run_record(
        result,
        source=source,
        spec=spec,
        settings=config.settings,
        elapsed_seconds=elapsed,
    )
    result_id = result.get("result_id")
    if not isinstance(result_id, str) or not result_id:
        raise HarnessError("Worker segment result omitted result_id.")
    discard = worker.request("discard_result", {"result_id": result_id})
    _require_equal(discard.get("result_id"), result_id, "discard result id")
    _require_equal(discard.get("discarded"), True, "result discard")
    return record


def build_report(
    config: BenchmarkConfig,
    *,
    spec: CheckpointSpec,
    health: Mapping[str, object],
    provision_status: Mapping[str, object],
    provisioning_seconds: float,
    source_results: Sequence[Mapping[str, object]],
    created_at: str | None = None,
    host: Mapping[str, object] | None = None,
) -> dict[str, object]:
    if health.get("status") != "ready" or not isinstance(
        health.get("engine_version"), str
    ):
        raise HarnessError("Worker health provenance is invalid.")
    if len(source_results) != len(config.sources):
        raise HarnessError(
            "Report source-result count does not match requested sources."
        )
    if not math.isfinite(provisioning_seconds) or provisioning_seconds < 0:
        raise HarnessError("Provisioning timing must be finite and non-negative.")
    if created_at is None:
        created_at = datetime.now(UTC).isoformat(timespec="milliseconds")
    if host is None:
        host = {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python_version": platform.python_version(),
        }
    return {
        "schema": REPORT_SCHEMA,
        "created_at": created_at,
        "claim_boundary": (
            "Technical compatibility record only. Counts are unadjudicated model outputs and "
            "structural checks detect only predefined mask failure shapes; no reference "
            "annotations are used and no biological performance claim is made."
        ),
        "engine": {
            "worker_interface": "python -m loci_engine.worker (JSON lines)",
            "engine_version": health["engine_version"],
            "python": os.fspath(config.engine_python),
        },
        "host": dict(host),
        "profile": {
            "profile_id": spec.profile_id,
            "artifact_id": spec.artifact_id,
            "runtime_package": {"name": "cellpose", "version": CELLPOSE_VERSION},
        },
        "checkpoint": {
            "authorized_path": os.fspath(config.checkpoint.path),
            "artifact_id": spec.artifact_id,
            "size_bytes": config.checkpoint.size_bytes,
            "sha256": config.checkpoint.sha256,
        },
        "settings": dict(config.settings),
        "settings_source": (
            {
                "kind": "explicit-json",
                "path": os.fspath(config.settings_file.path),
                "size_bytes": config.settings_file.size_bytes,
                "sha256": config.settings_file.sha256,
            }
            if config.settings_file is not None
            else {"kind": "frozen-website-compatible-defaults-with-cli-device"}
        ),
        "provisioning": {
            "isolated_temporary_model_home": True,
            "worker_round_trip_seconds": round(provisioning_seconds, 6),
            "verified_status": dict(provision_status),
        },
        "phase_semantics": {
            "cold": (
                "First segment request for an image in a fresh worker after status checks; "
                "the Cellpose model cache is empty."
            ),
            "warm": (
                "Repeated segment request for the same image, settings, profile, and checkpoint "
                "in that same worker."
            ),
            "timing_scope": "End-to-end JSON-lines segment request and response.",
        },
        "sources": [dict(result) for result in source_results],
    }


def run_benchmark(config: BenchmarkConfig) -> dict[str, object]:
    spec = CHECKPOINT_SPECS[config.profile_id]
    with tempfile.TemporaryDirectory(prefix="loci-cellpose-benchmark-") as temporary:
        model_home = Path(temporary) / "models"
        with WorkerClient(
            config.engine_python, model_home, config.timeout_seconds
        ) as worker:
            health = worker.request("health", {})
            started = perf_counter()
            imported = worker.request(
                "import_cellpose_model",
                {
                    "path": os.fspath(config.checkpoint.path),
                    "profile_id": config.profile_id,
                },
            )
            provisioning_seconds = perf_counter() - started
            provision_status = validate_status(imported, spec)

        source_results: list[dict[str, object]] = []
        for source in config.sources:
            with WorkerClient(
                config.engine_python, model_home, config.timeout_seconds
            ) as worker:
                source_health = worker.request("health", {})
                _require_equal(
                    source_health.get("engine_version"),
                    health.get("engine_version"),
                    "engine version across workers",
                )
                live_status = validate_status(
                    worker.request(
                        "cellpose_status", {"profile_id": config.profile_id}
                    ),
                    spec,
                )
                cold = _timed_segment(worker, config, source, spec)
                warm = [
                    _timed_segment(worker, config, source, spec)
                    for _ in range(config.warm_runs)
                ]
            current = fingerprint_file(source.path, label=f"Image {source.path.name}")
            if current != source:
                raise HarnessError(
                    f"Source changed before report publication: {source.path}"
                )
            counts = [cold["count"], *(record["count"] for record in warm)]
            structural_statuses = [
                cold["structural_status"],
                *(record["structural_status"] for record in warm),
            ]
            source_results.append(
                {
                    "authorized_path": os.fspath(source.path),
                    "size_bytes": source.size_bytes,
                    "sha256": source.sha256,
                    "verified_status": live_status,
                    "cold": cold,
                    "warm": warm,
                    "repeat_consistency": {
                        "count_identical": len(set(counts)) == 1,
                        "structural_status_identical": len(set(structural_statuses))
                        == 1,
                    },
                }
            )

        current_checkpoint = fingerprint_file(
            config.checkpoint.path, label="Checkpoint"
        )
        if current_checkpoint != config.checkpoint:
            raise HarnessError("Checkpoint changed before report publication.")
        if config.settings_file is not None:
            current_settings = fingerprint_file(
                config.settings_file.path, label="Settings JSON"
            )
            if current_settings != config.settings_file:
                raise HarnessError("Settings JSON changed before report publication.")
        return build_report(
            config,
            spec=spec,
            health=health,
            provision_status=provision_status,
            provisioning_seconds=provisioning_seconds,
            source_results=source_results,
        )


def atomic_write_json(
    path: Path, report: Mapping[str, object], *, overwrite: bool
) -> None:
    """Publish complete JSON in one filesystem operation; never expose a partial report."""

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as stream:
            temporary_path = Path(stream.name)
            json.dump(report, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary_path.chmod(0o600)
        try:
            if overwrite:
                if path.is_symlink():
                    raise HarnessError(
                        f"Refusing to overwrite a symbolic-link report: {path}"
                    )
                if path.exists():
                    _regular_file(path, label="Existing output report")
                os.replace(temporary_path, path)
                temporary_path = None
            else:
                os.link(temporary_path, path)
                temporary_path.unlink()
                temporary_path = None
        except FileExistsError as exc:
            raise HarnessError(
                "Output report appeared during publication; nothing was replaced."
            ) from exc
        except OSError as exc:
            raise HarnessError(
                f"Could not publish output report atomically: {path}"
            ) from exc
        try:
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            pass
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        config = validate_arguments(arguments)
        report = run_benchmark(config)
        atomic_write_json(config.output_path, report, overwrite=config.overwrite)
    except HarnessError as exc:
        print(f"Action needed: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Benchmark cancelled; no report was published.", file=sys.stderr)
        return 130
    print(f"Wrote compatibility report: {config.output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
