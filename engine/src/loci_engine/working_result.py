"""Atomic, app-private working-result packs for crash-safe analysis recovery.

The pack is a single ZIP-compatible file containing canonical JSON plus compressed
``.npy`` arrays.  It never uses pickle or executable model serialization.  Every
array is independently hashed in the manifest, while the publication receipt also
records a digest of the complete immutable pack.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import math
import os
import re
import stat
import tempfile
import zipfile
from contextlib import suppress
from dataclasses import fields
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from .models import (
    ENGINE_VERSION,
    AnalysisSettings,
    CellposeSettings,
    SegmentationSettings,
    SourceMetadata,
)
from .profiles import profile_from_manifest, resolve_profile
from .results import (
    MAX_CORRECTION_EVENTS,
    MAX_CORRECTION_OPERATIONS,
    MAX_POLYGON_POINTS,
    CachedAnalysis,
    CorrectionEvent,
    CorrectionOperation,
    ResultCache,
)
from .segment import SegmentationOutput, rebuild_output_from_labels

WORKING_RESULT_SCHEMA_VERSION = "1.0"
WORKING_RESULT_EXTENSION = ".loci-result"
WORKING_RESULT_MEDIA_TYPE = "application/vnd.loci.working-result+zip"

_MANIFEST_ENTRY = "manifest.json"
_ARRAY_ARTIFACTS = {
    "current-labels": ("current-labels.npy", "application/x-npy"),
    "base-labels": ("base-labels.npy", "application/x-npy"),
    "normalized-display": ("normalized-display.npy", "application/x-npy"),
}
_EXPECTED_ENTRIES = {_MANIFEST_ENTRY, *(entry for entry, _ in _ARRAY_ARTIFACTS.values())}
_CORRECTION_KINDS = {
    "delete_instance",
    "add_polygon",
    "split_instance",
    "merge_instances",
    "replace_instance_boundary",
    "paint_stroke",
    "erase_stroke",
    "move_boundary_vertex",
}
_CORRECTION_ACTIONS = {"apply", "undo", "redo"}
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

_MAX_PACK_BYTES = 1024 * 1024 * 1024
_MAX_MANIFEST_BYTES = 32 * 1024 * 1024
_MAX_ARRAY_BYTES = 256 * 1024 * 1024
_MAX_TOTAL_UNCOMPRESSED_BYTES = 800 * 1024 * 1024
_MAX_JSON_DEPTH = 32
_MAX_JSON_NODES = 1_000_000
_MAX_MEMORY_BYTES = 2**53 - 1
_CELLPOSE_MEMORY_ESTIMATE_POLICY = (
    "cellpose-checkpoint-x2-plus-batch-32MiB-plane-64B-reserve-256MiB/v1"
)
_LEGACY_NORMALIZED_UPPER_BOUND = np.nextafter(
    np.float32(1.0),
    np.float32(np.inf),
)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_stream(stream: Any) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def _sha256_file_stable(path: Path, *, reject_symlink: bool) -> tuple[str, int]:
    before = path.lstat()
    if reject_symlink and stat.S_ISLNK(before.st_mode):
        raise ValueError(f"'{path.name}' must be a regular file, not a symbolic link")
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"'{path.name}' must be a regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if reject_symlink:
        flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError(f"'{path.name}' changed before it could be verified")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            digest, size = _sha256_stream(stream)
    finally:
        os.close(descriptor)
    after = path.lstat()
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ):
        raise RuntimeError(f"'{path.name}' changed while it was being verified")
    return digest, size


def _private_directory(value: object) -> Path:
    if not isinstance(value, str) or not value:
        raise TypeError("directory must be a non-empty string")
    directory = Path(value).expanduser()
    if not directory.is_absolute():
        raise ValueError("directory must be absolute")
    try:
        directory_stat = directory.lstat()
    except OSError as exc:
        raise ValueError("The working-result directory is not accessible") from exc
    if stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
        raise ValueError("The working-result directory must be a real directory, not a link")
    if hasattr(os, "getuid") and directory_stat.st_uid != os.getuid():
        raise ValueError("The working-result directory must be owned by the current user")
    if os.name != "nt" and stat.S_IMODE(directory_stat.st_mode) & 0o077:
        raise ValueError("The working-result directory must be private to the current user")
    return directory


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _npy_bytes(array: np.ndarray) -> bytes:
    stream = io.BytesIO()
    np.lib.format.write_array(stream, np.asarray(array), allow_pickle=False)
    return stream.getvalue()


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | 0o600) << 16
    return info


def _operation_record(operation: CorrectionOperation) -> dict[str, object]:
    return {
        "operation_id": operation.operation_id,
        "kind": operation.kind,
        "created_at": operation.created_at,
        "x": operation.x,
        "y": operation.y,
        "other_x": operation.other_x,
        "other_y": operation.other_y,
        "points": [[x, y] for x, y in operation.points],
        "brush_radius_px": operation.brush_radius_px,
        "target_cell_id": operation.target_cell_id,
        "other_target_cell_id": operation.other_target_cell_id,
        "affected_area_px": operation.affected_area_px,
        "resulting_cell_count": operation.resulting_cell_count,
    }


def _event_record(event: CorrectionEvent) -> dict[str, object]:
    return {
        "revision": event.revision,
        "action": event.action,
        "occurred_at": event.occurred_at,
        "operation": _operation_record(event.operation),
        "discarded_redo_count": event.discarded_redo_count,
    }


def _source_record(source: SourceMetadata) -> dict[str, object]:
    record = source.to_dict()
    record.pop("path", None)
    return record


def _artifact_record(artifact_id: str, payload: bytes) -> dict[str, object]:
    entry, media_type = _ARRAY_ARTIFACTS[artifact_id]
    return {
        "entry": entry,
        "media_type": media_type,
        "size_bytes": len(payload),
        "sha256": _sha256_bytes(payload),
    }


def _pack_manifest(result: CachedAnalysis, payloads: dict[str, bytes]) -> dict[str, object]:
    base_output = result.base_output or result.output
    return {
        "schema_version": WORKING_RESULT_SCHEMA_VERSION,
        "engine_version": ENGINE_VERSION,
        "result_id": result.result_id,
        "analysis_created_at": result.created_at,
        "source": _source_record(result.source),
        "settings": {
            "kind": type(result.settings).__name__,
            "values": result.settings.to_dict(),
        },
        "profile": result.profile.to_dict(),
        "runtime": result.runtime,
        "output": {
            "resolved_polarity": result.output.resolved_polarity,
            "threshold": result.output.threshold,
        },
        "state": {
            "base_output_present": result.base_output is not None,
            "applied_corrections": [
                _operation_record(operation) for operation in result.applied_corrections
            ],
            "redo_corrections": [
                _operation_record(operation) for operation in result.redo_corrections
            ],
            "correction_events": [_event_record(event) for event in result.correction_events],
            "correction_revision": result.correction_revision,
            "correction_event_count": result.correction_event_count,
        },
        "artifacts": {
            artifact_id: _artifact_record(artifact_id, payloads[artifact_id])
            for artifact_id in _ARRAY_ARTIFACTS
        },
        "base_metrics": {
            "count": base_output.count,
            "confluence_percent": base_output.confluence_percent,
        },
    }


def publish_working_result(result: CachedAnalysis, directory: object) -> dict[str, object]:
    """Atomically publish an immutable, no-overwrite working-result pack."""

    if not isinstance(result, CachedAnalysis):
        raise TypeError("result must be a CachedAnalysis")
    if not _TOKEN_PATTERN.fullmatch(result.result_id):
        raise ValueError("result_id cannot be used as a working-result identity")
    destination_directory = _private_directory(directory)
    base_output = result.base_output or result.output
    normalized = np.asarray(result.output.normalized, dtype=np.float32)
    if normalized.shape != result.output.labels.shape:
        raise ValueError("The normalized display array must match the result label grid")
    if not np.all(np.isfinite(normalized)) or np.any(normalized < 0) or np.any(normalized > 1):
        raise ValueError("The normalized display array must contain finite values from 0 to 1")
    payloads = {
        "current-labels": _npy_bytes(np.asarray(result.output.labels, dtype=np.int32)),
        "base-labels": _npy_bytes(np.asarray(base_output.labels, dtype=np.int32)),
        "normalized-display": _npy_bytes(normalized),
    }
    for artifact_id, payload in payloads.items():
        if len(payload) > _MAX_ARRAY_BYTES:
            raise ValueError(f"Working-result artifact '{artifact_id}' exceeds its size bound")
    manifest = _pack_manifest(result, payloads)
    manifest_payload = _canonical_json(manifest)
    if len(manifest_payload) > _MAX_MANIFEST_BYTES:
        raise ValueError("The working-result manifest exceeds its size bound")

    basename = f"working-{result.result_id}-r{result.correction_revision}{WORKING_RESULT_EXTENSION}"
    destination = destination_directory / basename
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".loci-working-",
            suffix=".tmp",
            dir=destination_directory,
        )
        temporary_path = Path(temporary_name)
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        else:
            # The path was created exclusively by mkstemp and remains open.
            os.chmod(temporary_path, 0o600)
        with os.fdopen(descriptor, "w+b") as stream:
            with zipfile.ZipFile(
                stream,
                mode="w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=6,
                allowZip64=True,
            ) as archive:
                archive.writestr(_zip_info(_MANIFEST_ENTRY), manifest_payload)
                for artifact_id, (entry, _) in _ARRAY_ARTIFACTS.items():
                    archive.writestr(_zip_info(entry), payloads[artifact_id])
            stream.flush()
            os.fsync(stream.fileno())
        temporary_stat = temporary_path.lstat()
        if not stat.S_ISREG(temporary_stat.st_mode) or temporary_stat.st_size > _MAX_PACK_BYTES:
            raise ValueError("The generated working-result pack exceeds its size bound")
        # A same-directory hard link publishes the complete inode atomically and
        # fails if the deterministic destination already exists.
        os.link(temporary_path, destination, follow_symlinks=False)
        with suppress(OSError):
            directory_descriptor = os.open(destination_directory, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        temporary_path.unlink()
        temporary_path = None
    except FileExistsError as exc:
        raise FileExistsError(f"Working-result pack already exists: {basename}") from exc
    finally:
        if temporary_path is not None:
            with suppress(OSError):
                temporary_path.unlink()

    pack_sha256, pack_size = _sha256_file_stable(destination, reject_symlink=True)
    return {
        "schema_version": WORKING_RESULT_SCHEMA_VERSION,
        "pack": {
            "basename": basename,
            "media_type": WORKING_RESULT_MEDIA_TYPE,
            "size_bytes": pack_size,
            "sha256": pack_sha256,
        },
        "artifacts": [
            {"artifact_id": artifact_id, **manifest["artifacts"][artifact_id]}
            for artifact_id in _ARRAY_ARTIFACTS
        ],
    }


def _require_exact_dict(value: object, expected: set[str], location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{location} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        details: list[str] = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if unknown:
            details.append(f"unknown: {', '.join(unknown)}")
        raise ValueError(f"{location} has invalid fields ({'; '.join(details)})")
    return value


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def _invalid_json_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number is not allowed: {value}")


def _validate_json_tree(value: object) -> None:
    nodes = 0
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > _MAX_JSON_NODES:
            raise ValueError("The working-result manifest contains too many JSON values")
        if depth > _MAX_JSON_DEPTH:
            raise ValueError("The working-result manifest is nested too deeply")
        if item is None or isinstance(item, (str, bool, int)):
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("The working-result manifest contains a non-finite number")
            continue
        if isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
            continue
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item):
                raise TypeError("Working-result JSON object keys must be strings")
            stack.extend((child, depth + 1) for child in item.values())
            continue
        raise TypeError(f"Unsupported JSON value type: {type(item).__name__}")


def _parse_manifest(payload: bytes) -> dict[str, Any]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("The working-result manifest is not valid UTF-8") from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_invalid_json_constant,
        )
    except json.JSONDecodeError as exc:
        raise ValueError("The working-result manifest is not valid JSON") from exc
    _validate_json_tree(value)
    return _require_exact_dict(
        value,
        {
            "schema_version",
            "engine_version",
            "result_id",
            "analysis_created_at",
            "source",
            "settings",
            "profile",
            "runtime",
            "output",
            "state",
            "artifacts",
            "base_metrics",
        },
        "manifest",
    )


def _validate_timestamp(value: object, location: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 80:
        raise TypeError(f"{location} must be a bounded timestamp string")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{location} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{location} must include a timezone")
    return value


def _bounded_text(value: object, location: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise TypeError(f"{location} must be a non-empty bounded string")
    if any(ord(character) < 32 for character in value):
        raise ValueError(f"{location} must not contain control characters")
    return value


def _integer(
    value: object,
    location: str,
    *,
    minimum: int = 0,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{location} must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        upper = f" and at most {maximum}" if maximum is not None else ""
        raise ValueError(f"{location} must be at least {minimum}{upper}")
    return value


def _number(value: object, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{location} must be a finite number")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ValueError(f"{location} must be a finite number")
    return numeric


def _source_from_record(
    value: object,
    *,
    source_path: Path,
    expected_sha256: str,
) -> SourceMetadata:
    record = _require_exact_dict(
        value,
        {
            "name",
            "width",
            "height",
            "channels",
            "dtype",
            "format",
            "page_count",
            "sha256",
            "color_model",
            "access_mode",
            "view_only_reason",
            "source_details",
        },
        "source",
    )
    stored_sha256 = record["sha256"]
    if not isinstance(stored_sha256, str) or not _SHA256_PATTERN.fullmatch(stored_sha256):
        raise ValueError("source.sha256 must be a lowercase SHA-256 digest")
    if not hmac.compare_digest(stored_sha256, expected_sha256):
        raise ValueError("The working result belongs to a different source fingerprint")
    _bounded_text(record["name"], "source.name", maximum=1024)
    width = _integer(record["width"], "source.width", minimum=1, maximum=1_000_000)
    height = _integer(record["height"], "source.height", minimum=1, maximum=1_000_000)
    channels = _integer(record["channels"], "source.channels", minimum=1, maximum=65_536)
    page_count = _integer(record["page_count"], "source.page_count", minimum=1)
    color_model = record["color_model"]
    if color_model not in {"intensity", "interleaved-rgb", "channel-composite"}:
        raise ValueError("source.color_model is unsupported")
    access_mode = record["access_mode"]
    if access_mode not in {"full", "overview"}:
        raise ValueError("source.access_mode is unsupported")
    view_only_reason = record["view_only_reason"]
    if view_only_reason is not None and not isinstance(view_only_reason, str):
        raise TypeError("source.view_only_reason must be a string or null")
    if isinstance(view_only_reason, str) and len(view_only_reason) > 16_384:
        raise ValueError("source.view_only_reason exceeds its text bound")
    source_details = record["source_details"]
    if source_details is not None and not isinstance(source_details, dict):
        raise TypeError("source.source_details must be an object or null")
    return SourceMetadata(
        path=os.fspath(source_path),
        name=source_path.name,
        width=width,
        height=height,
        channels=channels,
        dtype=_bounded_text(record["dtype"], "source.dtype", maximum=120),
        format=_bounded_text(record["format"], "source.format", maximum=120),
        page_count=page_count,
        sha256=stored_sha256,
        color_model=color_model,
        access_mode=access_mode,
        view_only_reason=view_only_reason,
        source_details=source_details,
    )


def _settings_from_record(value: object, *, backend_kind: str) -> AnalysisSettings:
    record = _require_exact_dict(value, {"kind", "values"}, "settings")
    settings_type = CellposeSettings if backend_kind == "cellpose" else SegmentationSettings
    if record["kind"] != settings_type.__name__:
        raise ValueError("The working-result settings type does not match its profile")
    values = _require_exact_dict(
        record["values"],
        {field.name for field in fields(settings_type)},
        "settings.values",
    )
    defaults = settings_type()
    for field in fields(settings_type):
        candidate = values[field.name]
        default = getattr(defaults, field.name)
        if isinstance(default, bool):
            if not isinstance(candidate, bool):
                raise TypeError(f"settings.values.{field.name} must be a boolean")
        elif isinstance(default, int):
            if isinstance(candidate, bool) or not isinstance(candidate, int):
                raise TypeError(f"settings.values.{field.name} must be an integer")
        elif isinstance(default, float):
            _number(candidate, f"settings.values.{field.name}")
        elif isinstance(default, str) and not isinstance(candidate, str):
            raise TypeError(f"settings.values.{field.name} must be a string")
    settings = settings_type(**values)
    settings.validate()
    return settings


def _memory_observation_from_record(value: object, *, location: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError(f"{location} must be an object")
    device = value.get("device")
    if device not in {"mps", "cuda"}:
        raise ValueError(f"{location}.device is unsupported")
    available = value.get("available")
    if not isinstance(available, bool):
        raise TypeError(f"{location}.available must be a boolean")
    if not available:
        _require_exact_dict(value, {"device", "available"}, location)
        return value

    basis = value.get("basis")
    available_bytes = value.get("available_bytes")
    if basis == "memory-query-unavailable":
        _require_exact_dict(
            value,
            {"device", "available", "available_bytes", "basis"},
            location,
        )
        if available_bytes is not None:
            raise ValueError(
                f"{location}.available_bytes must be null when the memory query failed"
            )
        return value

    available_bytes = _integer(
        available_bytes,
        f"{location}.available_bytes",
        maximum=_MAX_MEMORY_BYTES,
    )
    if device == "cuda":
        _require_exact_dict(
            value,
            {"device", "available", "available_bytes", "total_bytes", "basis"},
            location,
        )
        if basis != "cuda-mem-get-info":
            raise ValueError(f"{location}.basis is unsupported for CUDA")
        total_bytes = _integer(
            value["total_bytes"],
            f"{location}.total_bytes",
            minimum=1,
            maximum=_MAX_MEMORY_BYTES,
        )
        if available_bytes > total_bytes:
            raise ValueError(f"{location} reports more available than total CUDA memory")
        return value

    _require_exact_dict(
        value,
        {
            "device",
            "available",
            "available_bytes",
            "recommended_bytes",
            "driver_allocated_bytes",
            "host_available_bytes",
            "basis",
        },
        location,
    )
    if basis != "minimum-of-metal-working-set-headroom-and-reclaimable-host-memory":
        raise ValueError(f"{location}.basis is unsupported for MPS")
    recommended_bytes = _integer(
        value["recommended_bytes"],
        f"{location}.recommended_bytes",
        minimum=1,
        maximum=_MAX_MEMORY_BYTES,
    )
    allocated_bytes = _integer(
        value["driver_allocated_bytes"],
        f"{location}.driver_allocated_bytes",
        maximum=_MAX_MEMORY_BYTES,
    )
    host_bytes = _integer(
        value["host_available_bytes"],
        f"{location}.host_available_bytes",
        maximum=_MAX_MEMORY_BYTES,
    )
    expected_available = min(max(0, recommended_bytes - allocated_bytes), host_bytes)
    if available_bytes != expected_available:
        raise ValueError(f"{location}.available_bytes is inconsistent with its MPS inputs")
    return value


def _memory_preflight_from_record(
    value: object,
    *,
    requested_device: str,
    resolved_device: str,
    fallback_reason: object,
) -> dict[str, object]:
    record = _require_exact_dict(
        value,
        {"required_bytes", "observations", "reservation", "estimate_policy"},
        "runtime.memory_preflight",
    )
    required_bytes = _integer(
        record["required_bytes"],
        "runtime.memory_preflight.required_bytes",
        minimum=1,
        maximum=_MAX_MEMORY_BYTES,
    )
    if record["reservation"] is not False:
        raise ValueError("runtime.memory_preflight.reservation must be false")
    if record["estimate_policy"] != _CELLPOSE_MEMORY_ESTIMATE_POLICY:
        raise ValueError("runtime.memory_preflight.estimate_policy is unsupported")
    raw_observations = record["observations"]
    if not isinstance(raw_observations, list) or len(raw_observations) > 2:
        raise TypeError("runtime.memory_preflight.observations must be a bounded array")
    observations = [
        _memory_observation_from_record(
            observation,
            location=f"runtime.memory_preflight.observations[{index}]",
        )
        for index, observation in enumerate(raw_observations)
    ]
    observed_devices = [observation["device"] for observation in observations]
    expected_sequences = {
        "cpu": [[]],
        "mps": [["mps"]],
        "cuda": [["cuda"]],
        "auto": [["mps"], ["mps", "cuda"]],
    }
    if observed_devices not in expected_sequences[requested_device]:
        raise ValueError("runtime.memory_preflight observations do not match the requested device")

    selected_device = "cpu"
    if observations:
        final = observations[-1]
        final_available = final.get("available_bytes")
        if (
            final["available"] is True
            and isinstance(final_available, int)
            and not isinstance(final_available, bool)
            and final_available >= required_bytes
        ):
            selected_device = str(final["device"])
    for observation in observations[:-1]:
        available_bytes = observation.get("available_bytes")
        if (
            observation["available"] is True
            and isinstance(available_bytes, int)
            and not isinstance(available_bytes, bool)
            and available_bytes >= required_bytes
        ):
            raise ValueError("runtime.memory_preflight continued after selecting an accelerator")
    if requested_device == "auto" and len(observations) == 1 and selected_device == "cpu":
        raise ValueError("runtime.memory_preflight omitted the CUDA observation after MPS fallback")
    if resolved_device == selected_device:
        if resolved_device != "cpu" and fallback_reason is not None:
            raise ValueError(
                "runtime.fallback_reason must be null when memory preflight selected the device"
            )
    elif resolved_device == "cpu" and selected_device in {"mps", "cuda"}:
        expected_prefix = f"{selected_device.upper()} inference failed with "
        if not (
            isinstance(fallback_reason, str)
            and fallback_reason.startswith(expected_prefix)
            and fallback_reason.endswith("; Loci retried on CPU.")
        ):
            raise ValueError("runtime.fallback_reason does not record the accelerator-to-CPU retry")
    else:
        raise ValueError("runtime.resolved_device is inconsistent with its memory preflight")

    if selected_device == "cpu":
        any_available = any(observation["available"] is True for observation in observations)
        fallback_expected = requested_device not in {"auto", "cpu"} or any_available
        if fallback_expected != (fallback_reason is not None):
            raise ValueError(
                "runtime.fallback_reason is inconsistent with the memory preflight fallback"
            )
    return record


def _runtime_from_record(value: object, *, profile: Any) -> dict[str, object] | None:
    if profile.backend_kind != "cellpose":
        if value is not None:
            raise ValueError("A non-Cellpose result must not declare a model runtime")
        return None
    legacy_fields = {
        "package",
        "model",
        "profile_id",
        "preprocessing_mode",
        "requested_device",
        "resolved_device",
        "fallback_reason",
        "inference_scale",
    }
    if isinstance(value, dict) and set(value) == legacy_fields:
        record = value
        legacy_runtime = True
        memory_preflight = None
    else:
        record = _require_exact_dict(value, legacy_fields | {"memory_preflight"}, "runtime")
        legacy_runtime = False
        memory_preflight = record["memory_preflight"]
    package = _require_exact_dict(record["package"], {"name", "version"}, "runtime.package")
    model = _require_exact_dict(record["model"], {"artifact_id", "sha256"}, "runtime.model")
    if package["name"] != "cellpose" or package["version"] != profile.version:
        raise ValueError("The working-result runtime package does not match its profile")
    if (
        model["artifact_id"] != profile.model.artifact_id
        or model["sha256"] != profile.model.sha256
        or record["profile_id"] != profile.id
    ):
        raise ValueError("The working-result runtime model does not match its profile")
    if record["preprocessing_mode"] not in {
        "huggingface-space-uint8",
        "dynamic-range-preserving",
    }:
        raise ValueError("runtime.preprocessing_mode is unsupported")
    if record["requested_device"] not in {"auto", "cpu", "mps", "cuda"}:
        raise ValueError("runtime.requested_device is unsupported")
    if record["resolved_device"] not in {"cpu", "mps", "cuda"}:
        raise ValueError("runtime.resolved_device is unsupported")
    fallback_reason = record["fallback_reason"]
    if fallback_reason is not None:
        fallback_reason = _bounded_text(
            fallback_reason,
            "runtime.fallback_reason",
        )
    inference_scale = _number(record["inference_scale"], "runtime.inference_scale")
    if not 0 < inference_scale <= 1:
        raise ValueError("runtime.inference_scale must be greater than 0 and at most 1")
    if not legacy_runtime:
        _memory_preflight_from_record(
            memory_preflight,
            requested_device=record["requested_device"],
            resolved_device=record["resolved_device"],
            fallback_reason=fallback_reason,
        )
    return record


def _optional_coordinate(value: object, location: str, *, maximum: int) -> int | None:
    if value is None:
        return None
    return _integer(value, location, minimum=0, maximum=maximum - 1)


def _optional_cell_id(value: object, location: str, *, maximum: int) -> int | None:
    if value is None:
        return None
    return _integer(value, location, minimum=1, maximum=maximum)


def _operation_from_record(
    value: object,
    *,
    shape: tuple[int, int],
    location: str,
    geometry_validator: ResultCache,
) -> CorrectionOperation:
    operation_fields = {
        "operation_id",
        "kind",
        "created_at",
        "x",
        "y",
        "other_x",
        "other_y",
        "points",
        "target_cell_id",
        "other_target_cell_id",
        "affected_area_px",
        "resulting_cell_count",
    }
    # Packs written before brush editing existed omit only this nullable field.
    # Continue accepting them while keeping all unknown fields fail-closed.
    if isinstance(value, dict) and "brush_radius_px" not in value:
        record = _require_exact_dict(value, operation_fields, location)
        record = {**record, "brush_radius_px": None}
    else:
        record = _require_exact_dict(
            value,
            {*operation_fields, "brush_radius_px"},
            location,
        )
    operation_id = record["operation_id"]
    if not isinstance(operation_id, str) or not _TOKEN_PATTERN.fullmatch(operation_id):
        raise ValueError(f"{location}.operation_id is invalid")
    kind = record["kind"]
    if not isinstance(kind, str) or kind not in _CORRECTION_KINDS:
        raise ValueError(f"{location}.kind is unsupported")
    height, width = shape
    x = _optional_coordinate(record["x"], f"{location}.x", maximum=width)
    y = _optional_coordinate(record["y"], f"{location}.y", maximum=height)
    other_x = _optional_coordinate(record["other_x"], f"{location}.other_x", maximum=width)
    other_y = _optional_coordinate(record["other_y"], f"{location}.other_y", maximum=height)
    target_cell_id = _optional_cell_id(
        record["target_cell_id"],
        f"{location}.target_cell_id",
        maximum=height * width,
    )
    other_target_cell_id = _optional_cell_id(
        record["other_target_cell_id"],
        f"{location}.other_target_cell_id",
        maximum=height * width,
    )
    raw_points = record["points"]
    if not isinstance(raw_points, list) or len(raw_points) > MAX_POLYGON_POINTS:
        raise ValueError(f"{location}.points exceeds its correction geometry bound")
    point_objects: list[dict[str, float]] = []
    for index, raw_point in enumerate(raw_points):
        if not isinstance(raw_point, list) or len(raw_point) != 2:
            raise TypeError(f"{location}.points[{index}] must be an x/y pair")
        point_objects.append(
            {
                "x": _number(raw_point[0], f"{location}.points[{index}][0]"),
                "y": _number(raw_point[1], f"{location}.points[{index}][1]"),
            }
        )

    coordinate_kinds = {
        "delete_instance",
        "split_instance",
        "replace_instance_boundary",
        "move_boundary_vertex",
    }
    point_kinds = {
        "add_polygon",
        "split_instance",
        "replace_instance_boundary",
        "move_boundary_vertex",
        "paint_stroke",
        "erase_stroke",
    }
    if kind in coordinate_kinds:
        if x is None or y is None or target_cell_id is None:
            raise ValueError(f"{location} is missing its target selection")
    elif kind not in {"merge_instances", "paint_stroke"} and (
        x is not None or y is not None or target_cell_id is not None
    ):
        raise ValueError(f"{location} has an unexpected target selection")
    if kind == "merge_instances":
        if (
            x is None
            or y is None
            or other_x is None
            or other_y is None
            or target_cell_id is None
            or other_target_cell_id is None
        ):
            raise ValueError(f"{location} is missing one merge selection")
    elif other_x is not None or other_y is not None or other_target_cell_id is not None:
        raise ValueError(f"{location} has an unexpected second selection")

    brush_radius = record["brush_radius_px"]
    if kind in {"paint_stroke", "erase_stroke"}:
        brush_radius = geometry_validator._brush_radius(brush_radius)
        if x is not None or y is not None:
            raise ValueError(f"{location} has an unexpected point selection")
        if kind == "paint_stroke" and target_cell_id is None:
            raise ValueError(f"{location} is missing its paint target identity")
        if kind == "erase_stroke" and target_cell_id is not None:
            raise ValueError(f"{location} has an unexpected paint target identity")
    elif brush_radius is not None:
        raise ValueError(f"{location} has an unexpected brush radius")

    if kind in point_kinds:
        if kind in {"paint_stroke", "erase_stroke"}:
            points = geometry_validator._stroke(
                point_objects,
                width=width,
                height=height,
            )
        elif kind == "split_instance":
            points = geometry_validator._polyline(
                point_objects,
                width=width,
                height=height,
            )
        else:
            points = geometry_validator._polygon(
                point_objects,
                width=width,
                height=height,
            )
    else:
        if raw_points:
            raise ValueError(f"{location} must not contain correction points")
        points = ()

    return CorrectionOperation(
        operation_id=operation_id,
        kind=kind,
        created_at=_validate_timestamp(record["created_at"], f"{location}.created_at"),
        x=x,
        y=y,
        other_x=other_x,
        other_y=other_y,
        points=points,
        brush_radius_px=brush_radius,
        target_cell_id=target_cell_id,
        other_target_cell_id=other_target_cell_id,
        affected_area_px=_integer(
            record["affected_area_px"],
            f"{location}.affected_area_px",
            maximum=height * width,
        ),
        resulting_cell_count=_integer(
            record["resulting_cell_count"],
            f"{location}.resulting_cell_count",
            maximum=height * width,
        ),
    )


def _event_from_record(
    value: object,
    *,
    shape: tuple[int, int],
    location: str,
    geometry_validator: ResultCache,
) -> CorrectionEvent:
    record = _require_exact_dict(
        value,
        {"revision", "action", "occurred_at", "operation", "discarded_redo_count"},
        location,
    )
    action = record["action"]
    if not isinstance(action, str) or action not in _CORRECTION_ACTIONS:
        raise ValueError(f"{location}.action is unsupported")
    return CorrectionEvent(
        revision=_integer(record["revision"], f"{location}.revision", minimum=1),
        action=action,
        occurred_at=_validate_timestamp(record["occurred_at"], f"{location}.occurred_at"),
        operation=_operation_from_record(
            record["operation"],
            shape=shape,
            location=f"{location}.operation",
            geometry_validator=geometry_validator,
        ),
        discarded_redo_count=_integer(
            record["discarded_redo_count"],
            f"{location}.discarded_redo_count",
            maximum=MAX_CORRECTION_OPERATIONS,
        ),
    )


def _read_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo, maximum: int) -> bytes:
    if info.is_dir() or info.file_size < 0 or info.file_size > maximum:
        raise ValueError(f"Working-result entry '{info.filename}' exceeds its size bound")
    mode = (info.external_attr >> 16) & 0o170000
    if mode == stat.S_IFLNK:
        raise ValueError(f"Working-result entry '{info.filename}' must not be a symbolic link")
    with archive.open(info, "r") as stream:
        payload = stream.read(maximum + 1)
    if len(payload) != info.file_size or len(payload) > maximum:
        raise ValueError(f"Working-result entry '{info.filename}' changed while reading")
    return payload


def _artifact_payloads(
    archive: zipfile.ZipFile,
    manifest: dict[str, Any],
    infos: dict[str, zipfile.ZipInfo],
) -> dict[str, bytes]:
    artifacts = _require_exact_dict(
        manifest["artifacts"],
        set(_ARRAY_ARTIFACTS),
        "artifacts",
    )
    payloads: dict[str, bytes] = {}
    for artifact_id, (expected_entry, expected_media_type) in _ARRAY_ARTIFACTS.items():
        record = _require_exact_dict(
            artifacts[artifact_id],
            {"entry", "media_type", "size_bytes", "sha256"},
            f"artifacts.{artifact_id}",
        )
        if record["entry"] != expected_entry or record["media_type"] != expected_media_type:
            raise ValueError(f"Artifact '{artifact_id}' has an unsupported identity")
        expected_size = _integer(
            record["size_bytes"],
            f"artifacts.{artifact_id}.size_bytes",
            minimum=1,
            maximum=_MAX_ARRAY_BYTES,
        )
        expected_hash = record["sha256"]
        if not isinstance(expected_hash, str) or not _SHA256_PATTERN.fullmatch(expected_hash):
            raise ValueError(f"artifacts.{artifact_id}.sha256 is invalid")
        info = infos[expected_entry]
        if info.file_size != expected_size:
            raise ValueError(f"Artifact '{artifact_id}' size does not match its manifest")
        payload = _read_entry(archive, info, _MAX_ARRAY_BYTES)
        if not hmac.compare_digest(_sha256_bytes(payload), expected_hash):
            raise ValueError(f"Artifact '{artifact_id}' failed SHA-256 verification")
        payloads[artifact_id] = payload
    return payloads


def _load_array(
    payload: bytes,
    *,
    artifact_id: str,
    expected_dtype: np.dtype[Any],
) -> np.ndarray:
    try:
        candidate = np.load(io.BytesIO(payload), allow_pickle=False, max_header_size=16 * 1024)
    except Exception as exc:
        raise ValueError(f"Artifact '{artifact_id}' is not a safe NumPy array") from exc
    if not isinstance(candidate, np.ndarray) or candidate.dtype != expected_dtype:
        raise ValueError(f"Artifact '{artifact_id}' has an unsupported dtype")
    if candidate.ndim != 2 or candidate.size == 0:
        raise ValueError(f"Artifact '{artifact_id}' must be a non-empty 2D array")
    return candidate


def _validate_operation_targets(labels: np.ndarray, operation: CorrectionOperation) -> None:
    if operation.kind in {"add_polygon", "erase_stroke"}:
        return
    if operation.kind == "paint_stroke":
        assert operation.brush_radius_px is not None
        stroke = ResultCache._stroke_mask(
            operation.points,
            labels.shape,
            operation.brush_radius_px,
        )
        overlaps = {int(value) for value in np.unique(labels[stroke]) if int(value) != 0}
        expected_target = next(iter(overlaps), int(labels.max(initial=0)) + 1)
        if len(overlaps) > 1 or expected_target != operation.target_cell_id:
            raise ValueError("A paint target identity does not match its replay state")
        return
    assert operation.x is not None and operation.y is not None
    target = int(labels[operation.y, operation.x])
    if target != operation.target_cell_id:
        raise ValueError("A correction target identity does not match its replay state")
    if operation.kind == "merge_instances":
        assert operation.other_x is not None and operation.other_y is not None
        other = int(labels[operation.other_y, operation.other_x])
        if other != operation.other_target_cell_id:
            raise ValueError("A merge target identity does not match its replay state")


def _replay_operations(
    base_output: SegmentationOutput,
    operations: tuple[CorrectionOperation, ...],
) -> SegmentationOutput:
    prefix: tuple[CorrectionOperation, ...] = ()
    current = base_output
    for operation in operations:
        _validate_operation_targets(current.labels, operation)
        prefix = (*prefix, operation)
        try:
            current = ResultCache._rebuild(base_output, prefix)
        except (AssertionError, RuntimeError, TypeError, ValueError) as exc:
            raise ValueError("The correction history cannot be replayed safely") from exc
        if current.count != operation.resulting_cell_count:
            raise ValueError("A correction result count does not match its replayed output")
    return current


def _state_from_record(
    value: object,
    *,
    shape: tuple[int, int],
    base_output: SegmentationOutput,
    current_labels: np.ndarray,
) -> tuple[
    bool,
    tuple[CorrectionOperation, ...],
    tuple[CorrectionOperation, ...],
    tuple[CorrectionEvent, ...],
    int,
    int,
]:
    record = _require_exact_dict(
        value,
        {
            "base_output_present",
            "applied_corrections",
            "redo_corrections",
            "correction_events",
            "correction_revision",
            "correction_event_count",
        },
        "state",
    )
    base_present = record["base_output_present"]
    if not isinstance(base_present, bool):
        raise TypeError("state.base_output_present must be a boolean")
    raw_applied = record["applied_corrections"]
    raw_redo = record["redo_corrections"]
    raw_events = record["correction_events"]
    if not isinstance(raw_applied, list) or not isinstance(raw_redo, list):
        raise TypeError("Correction stacks must be arrays")
    if len(raw_applied) + len(raw_redo) > MAX_CORRECTION_OPERATIONS:
        raise ValueError("The working result exceeds its correction history bound")
    if not isinstance(raw_events, list) or len(raw_events) > MAX_CORRECTION_EVENTS:
        raise ValueError("The working result exceeds its correction event bound")
    geometry_validator = ResultCache(max_entries=1, max_bytes=1)
    applied = tuple(
        _operation_from_record(
            item,
            shape=shape,
            location=f"state.applied_corrections[{index}]",
            geometry_validator=geometry_validator,
        )
        for index, item in enumerate(raw_applied)
    )
    redo = tuple(
        _operation_from_record(
            item,
            shape=shape,
            location=f"state.redo_corrections[{index}]",
            geometry_validator=geometry_validator,
        )
        for index, item in enumerate(raw_redo)
    )
    events = tuple(
        _event_from_record(
            item,
            shape=shape,
            location=f"state.correction_events[{index}]",
            geometry_validator=geometry_validator,
        )
        for index, item in enumerate(raw_events)
    )
    stack_operation_ids = [operation.operation_id for operation in (*applied, *redo)]
    if len(set(stack_operation_ids)) != len(stack_operation_ids):
        raise ValueError("Correction stacks contain a duplicate operation identity")
    revision = _integer(record["correction_revision"], "state.correction_revision")
    event_count = _integer(record["correction_event_count"], "state.correction_event_count")
    if revision != event_count:
        raise ValueError("Correction revision and event count must match")
    if events:
        expected_revisions = tuple(range(event_count - len(events) + 1, event_count + 1))
        if tuple(event.revision for event in events) != expected_revisions:
            raise ValueError("Correction events are not the bounded trailing revision sequence")
    elif event_count:
        raise ValueError("A non-zero correction revision must retain bounded event history")
    if base_present and not event_count:
        raise ValueError("A result with a correction base must retain correction history")
    if not base_present and (applied or redo or events or revision or event_count):
        raise ValueError("A result without a base output cannot contain correction history")
    if event_count == len(events):
        replayed_applied: list[CorrectionOperation] = []
        replayed_redo: list[CorrectionOperation] = []
        for event in events:
            if event.action == "apply":
                if event.discarded_redo_count != len(replayed_redo):
                    raise ValueError("An apply event has an invalid discarded-redo count")
                replayed_applied.append(event.operation)
                replayed_redo.clear()
            elif event.action == "undo":
                if (
                    event.discarded_redo_count
                    or not replayed_applied
                    or replayed_applied[-1] != event.operation
                ):
                    raise ValueError("An undo event does not match correction stack history")
                replayed_redo.append(replayed_applied.pop())
            else:
                if (
                    event.discarded_redo_count
                    or not replayed_redo
                    or replayed_redo[-1] != event.operation
                ):
                    raise ValueError("A redo event does not match correction stack history")
                replayed_applied.append(replayed_redo.pop())
        if tuple(replayed_applied) != applied or tuple(replayed_redo) != redo:
            raise ValueError("Correction event history does not reproduce its saved stacks")

    replayed = _replay_operations(base_output, applied) if applied else base_output
    if not np.array_equal(replayed.labels, current_labels):
        raise ValueError("Current labels do not match the replayed correction history")
    if redo:
        _replay_operations(base_output, (*applied, *reversed(redo)))
    return base_present, applied, redo, events, revision, event_count


def _validated_source_path(value: object, expected_sha256: object) -> tuple[Path, str]:
    if not isinstance(value, str) or not value:
        raise TypeError("source_path must be a non-empty string")
    source_path = Path(value).expanduser()
    if not source_path.is_absolute():
        raise ValueError("source_path must be absolute")
    if not isinstance(expected_sha256, str) or not re.fullmatch(
        r"[0-9a-fA-F]{64}", expected_sha256
    ):
        raise ValueError("expected_sha256 must be a 64-character hexadecimal digest")
    normalized_hash = expected_sha256.lower()
    actual_hash, _ = _sha256_file_stable(source_path, reject_symlink=True)
    if not hmac.compare_digest(actual_hash, normalized_hash):
        raise ValueError("The trusted source file does not match expected_sha256")
    return source_path, normalized_hash


def restore_working_result(
    pack_path_value: object,
    source_path_value: object,
    expected_sha256: object,
    *,
    cache: ResultCache | None,
    require_installed_profile: bool = True,
) -> tuple[CachedAnalysis, list[str], dict[str, object]]:
    """Verify a pack completely, optionally inserting its original result identity."""

    if not require_installed_profile and cache is not None:
        raise ValueError("An archived profile cannot be restored into an executable result cache")

    if not isinstance(pack_path_value, str) or not pack_path_value:
        raise TypeError("pack_path must be a non-empty string")
    pack_path = Path(pack_path_value).expanduser()
    if not pack_path.is_absolute():
        raise ValueError("pack_path must be absolute")
    _private_directory(os.fspath(pack_path.parent))
    source_path, expected_source_hash = _validated_source_path(
        source_path_value,
        expected_sha256,
    )

    before = pack_path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError("The working-result pack must be a regular file, not a link")
    if before.st_size <= 0 or before.st_size > _MAX_PACK_BYTES:
        raise ValueError("The working-result pack exceeds its size bound")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(pack_path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError("The working-result pack changed before verification")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            pack_sha256, pack_size = _sha256_stream(stream)
            stream.seek(0)
            try:
                with zipfile.ZipFile(stream, "r") as archive:
                    info_list = archive.infolist()
                    if len(info_list) != len(_EXPECTED_ENTRIES):
                        raise ValueError("The working-result pack has unexpected entries")
                    names = [info.filename for info in info_list]
                    if len(set(names)) != len(names) or set(names) != _EXPECTED_ENTRIES:
                        raise ValueError("The working-result pack has duplicate or unknown entries")
                    if sum(info.file_size for info in info_list) > _MAX_TOTAL_UNCOMPRESSED_BYTES:
                        raise ValueError("The working-result pack exceeds its expanded size bound")
                    infos = {info.filename: info for info in info_list}
                    manifest_payload = _read_entry(
                        archive,
                        infos[_MANIFEST_ENTRY],
                        _MAX_MANIFEST_BYTES,
                    )
                    manifest = _parse_manifest(manifest_payload)
                    payloads = _artifact_payloads(archive, manifest, infos)
            except (zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
                raise ValueError("The working-result pack is not a valid bounded archive") from exc
    finally:
        os.close(descriptor)
    after = pack_path.lstat()
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ):
        raise RuntimeError("The working-result pack changed during verification")

    if manifest["schema_version"] != WORKING_RESULT_SCHEMA_VERSION:
        raise ValueError("Unsupported working-result schema version")
    if manifest["engine_version"] != ENGINE_VERSION:
        raise ValueError("The working-result engine version is not supported")
    result_id = manifest["result_id"]
    if not isinstance(result_id, str) or not _TOKEN_PATTERN.fullmatch(result_id):
        raise ValueError("The working-result result_id is invalid")
    analysis_created_at = _validate_timestamp(
        manifest["analysis_created_at"],
        "analysis_created_at",
    )

    stored_profile = profile_from_manifest(manifest["profile"])
    current_profile = stored_profile
    if require_installed_profile:
        current_profile = resolve_profile(stored_profile.id, require_ready=True)
        if current_profile.provenance_dict() != stored_profile.provenance_dict():
            raise ValueError("The installed profile does not match the working-result profile")
    settings = _settings_from_record(
        manifest["settings"],
        backend_kind=current_profile.backend_kind,
    )
    runtime = _runtime_from_record(manifest["runtime"], profile=current_profile)

    source = _source_from_record(
        manifest["source"],
        source_path=source_path,
        expected_sha256=expected_source_hash,
    )
    current_labels = _load_array(
        payloads["current-labels"],
        artifact_id="current-labels",
        expected_dtype=np.dtype(np.int32),
    )
    base_labels = _load_array(
        payloads["base-labels"],
        artifact_id="base-labels",
        expected_dtype=np.dtype(np.int32),
    )
    normalized = _load_array(
        payloads["normalized-display"],
        artifact_id="normalized-display",
        expected_dtype=np.dtype(np.float32),
    )
    expected_shape = (source.height, source.width)
    if current_labels.shape != expected_shape or base_labels.shape != expected_shape:
        raise ValueError("Working-result labels do not match the declared source grid")
    if normalized.shape != expected_shape:
        raise ValueError("The normalized display array does not match the source grid")
    if np.any(current_labels < 0) or np.any(base_labels < 0):
        raise ValueError("Working-result labels cannot contain negative instance IDs")
    if (
        not np.all(np.isfinite(normalized))
        or np.any(normalized < 0)
        or np.any(normalized > _LEGACY_NORMALIZED_UPPER_BOUND)
    ):
        raise ValueError("The normalized display array must contain finite values from 0 to 1")
    if np.any(normalized > 1):
        # Older packs can contain exactly one float32 ULP above 1.0 because the
        # former producer mixed float32 pixels with float64 percentile bounds.
        # The artifact has already passed its exact hash check. Normalize only
        # that known display-only endpoint while keeping every larger excursion
        # fail-closed.
        normalized = normalized.copy()
        np.minimum(normalized, np.float32(1.0), out=normalized)

    output_record = _require_exact_dict(
        manifest["output"],
        {"resolved_polarity", "threshold"},
        "output",
    )
    resolved_polarity = _bounded_text(
        output_record["resolved_polarity"],
        "output.resolved_polarity",
        maximum=120,
    )
    threshold = _number(output_record["threshold"], "output.threshold")
    prototype = SegmentationOutput(
        labels=np.zeros(expected_shape, dtype=np.int32),
        normalized=normalized,
        count=0,
        confluence_percent=0.0,
        measurements=[],
        resolved_polarity=resolved_polarity,
        threshold=threshold,
    )
    base_output = rebuild_output_from_labels(prototype, base_labels)
    current_output = rebuild_output_from_labels(prototype, current_labels)
    base_metrics = _require_exact_dict(
        manifest["base_metrics"],
        {"count", "confluence_percent"},
        "base_metrics",
    )
    if (
        _integer(base_metrics["count"], "base_metrics.count") != base_output.count
        or _number(base_metrics["confluence_percent"], "base_metrics.confluence_percent")
        != base_output.confluence_percent
    ):
        raise ValueError("Base metrics do not match the verified base labels")

    base_present, applied, redo, events, revision, event_count = _state_from_record(
        manifest["state"],
        shape=expected_shape,
        base_output=base_output,
        current_labels=current_labels,
    )
    restored = CachedAnalysis(
        result_id=result_id,
        created_at=analysis_created_at,
        source=source,
        settings=settings,
        output=current_output,
        profile=current_profile,
        runtime=runtime,
        base_output=base_output if base_present else None,
        applied_corrections=applied,
        redo_corrections=redo,
        correction_events=events,
        correction_revision=revision,
        correction_event_count=event_count,
    )
    source_hash_after_validation, _ = _sha256_file_stable(source_path, reject_symlink=True)
    if not hmac.compare_digest(source_hash_after_validation, expected_source_hash):
        raise RuntimeError("The trusted source changed while the working result was restored")
    if cache is None:
        published, evicted_result_ids = restored, []
    else:
        published, evicted_result_ids = cache.restore(restored)
    return (
        published,
        evicted_result_ids,
        {
            "basename": pack_path.name,
            "media_type": WORKING_RESULT_MEDIA_TYPE,
            "size_bytes": pack_size,
            "sha256": pack_sha256,
        },
    )
