"""Verify and atomically attach untrusted remote result archives to a local study.

The archive and every nested scientific identity are treated as untrusted. Remote
project, source, task, and result identities are retained as provenance; only an
explicit exact-hash source mapping is rebased onto local study identities.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import math
import re
import sqlite3
import stat
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
from skimage.filters import threshold_otsu

from .models import ENGINE_VERSION
from .quantitative import (
    DEFAULT_WORKING_BYTES,
    apply_marker_gates,
    measure_objects,
    process_scalar,
)
from .remote_compute import (
    MAX_MANIFEST_BYTES,
    MAX_STAGE_FILE_BYTES,
    OutputEntry,
    RemoteCellposeTask,
    RemoteRecipeTask,
    RemoteSource,
    RemoteTask,
    RemoteWorkerRequest,
    ResourceRequest,
    VerifiedOutputManifest,
)
from .research_project import (
    ARRAY_NAME_PATTERN,
    MAX_ARTIFACT_BYTES,
    ResearchProject,
    canonical_json,
    checked_id,
    parse_json,
    timestamp,
)
from .workbench import Workbench, geometry_from_dict, runtime_record
from .working_result import _sha256_file_stable

MAX_ARCHIVE_MEMBERS = 50_001
MAX_TASKS = 10_000
MAX_RESULT_JSON_BYTES = MAX_MANIFEST_BYTES * 4
MAX_JSON_DEPTH = 24
MAX_JSON_LIST = 100_000
MAX_JSON_OBJECT = 1_000
_HEX32 = re.compile(r"^[a-f0-9]{32}$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_REMOTE_ABSOLUTE = re.compile(r"^/[A-Za-z0-9._/-]+$")
_REQUEST_KEYS = {
    "schema",
    "request_key",
    "project_id",
    "output_root",
    "resources",
    "sources",
    "tasks",
}
_RESOURCE_KEYS = {"cpus", "memory_mb", "wall_minutes", "gpus"}
_SOURCE_KEYS = {"source_id", "path", "sha256", "size_bytes"}
_SOURCE_OPTIONAL_KEYS = {"permitted_root"}
_TASK_BASE_KEYS = {"task_id", "operation", "source_id", "selection"}
_ARCHIVE_KEYS = {
    "schema",
    "request_key",
    "request_sha256",
    "project_id",
    "review_state",
    "task_results",
    "members",
}
_ARCHIVE_TASK_KEYS = {"task_id", "path", "schema", "review_state"}
_MEMBER_KEYS = {"path", "sha256", "size_bytes", "media_type"}
_TASK_RESULT_KEYS = {
    "schema",
    "request_key",
    "request_sha256",
    "project_id",
    "task_id",
    "operation",
    "source",
    "result",
    "review",
}
_PUBLISHED_RESULT_KEYS = {
    "schema",
    "id",
    "source_id",
    "source_sha256",
    "kind",
    "parent_id",
    "created_at",
    "engine_version",
    "revision_hash",
    "record_sha256",
    "arrays",
    "provenance",
}
_REMOTE_ARRAY_KEYS = {
    "sha256",
    "size_bytes",
    "shape",
    "dtype",
    "path",
    "geometry",
    "geometry_sha256",
}
_PROVENANCE_KEYS = {
    "geometry",
    "selection",
    "recipe",
    "recipe_sha256",
    "processing",
    "segmentation",
    "measurements",
    "measurement_basis",
    "runtime",
    "estimated_working_bytes",
    "channel_metadata",
}
_CELLPOSE_PROVENANCE_KEYS = {
    "geometry",
    "selection",
    "cellpose",
    "segmentation",
    "measurements",
    "measurement_basis",
    "channel_metadata",
    "runtime",
    "estimated_working_bytes",
    "rights",
}
_RUNTIME_KEYS = set(runtime_record())
_CELLPOSE_RUNTIME_KEYS = {
    "engine",
    "cellpose",
    "python_version",
    "torch_version",
    "cuda_runtime",
    "cudnn_version",
}
_RECEIPT_KEYS = {
    "schema",
    "attachment_key",
    "request_key",
    "request_sha256",
    "remote_project_id",
    "archive_sha256",
    "local_project_id",
    "source_mapping",
    "task_results",
    "attached_at",
    "remote_review_state",
    "local_review_receipts_created",
    "local_job_id",
}
_RECEIPT_TASK_KEYS = {
    "remote_task_id",
    "remote_result_id",
    "remote_revision_hash",
    "local_result_id",
    "local_revision_hash",
}


class RemoteResultsError(RuntimeError):
    """Raised when a remote result attachment cannot be fully verified."""


@dataclass(frozen=True, slots=True)
class _RequestContract:
    request_key: str
    request_sha256: str
    project_id: str
    resources: ResourceRequest
    sources: tuple[RemoteSource, ...]
    tasks: tuple[RemoteTask, ...]


@dataclass(frozen=True, slots=True)
class _Member:
    path: str
    sha256: str
    size_bytes: int
    media_type: str


@dataclass(frozen=True, slots=True)
class _VerifiedTask:
    request: RemoteTask
    record: dict[str, Any]
    arrays: dict[str, dict[str, Any]]
    expected_shape: tuple[int, ...]
    local_source_id: str


def _exact(value: object, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise RemoteResultsError(f"{name} has unexpected fields")
    return value


def _hex(value: object, length: int, name: str) -> str:
    pattern = _HEX32 if length == 32 else _HEX64
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise RemoteResultsError(f"{name} is not a lowercase hexadecimal identity")
    return value


def _integer(value: object, low: int, high: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise RemoteResultsError(f"{name} is outside its integer bound")
    return value


def _validate_json_value(value: Any, name: str, *, depth: int = 0) -> None:
    if depth > MAX_JSON_DEPTH:
        raise RemoteResultsError(f"{name} is nested too deeply")
    if value is None or isinstance(value, (str, bool, int)):
        if isinstance(value, str) and (
            len(value) > 16_384 or any(ord(character) < 32 for character in value)
        ):
            raise RemoteResultsError(f"{name} contains invalid text")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise RemoteResultsError(f"{name} contains a non-finite number")
        return
    if isinstance(value, list):
        if len(value) > MAX_JSON_LIST:
            raise RemoteResultsError(f"{name} contains an oversized list")
        for item in value:
            _validate_json_value(item, name, depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > MAX_JSON_OBJECT:
            raise RemoteResultsError(f"{name} contains an oversized object")
        for key, item in value.items():
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 256
                or any(ord(character) < 32 for character in key)
            ):
                raise RemoteResultsError(f"{name} contains an invalid key")
            _validate_json_value(item, name, depth=depth + 1)
        return
    raise RemoteResultsError(f"{name} contains a non-JSON value")


def _parse_json(encoded: bytes, name: str, maximum: int) -> Any:
    if not isinstance(encoded, bytes) or len(encoded) > maximum:
        raise RemoteResultsError(f"{name} exceeds its byte bound")

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, item in items:
            if key in output:
                raise RemoteResultsError(f"{name} contains duplicate JSON keys")
            output[key] = item
        return output

    def reject_constant(_value: str) -> None:
        raise RemoteResultsError(f"{name} contains a non-finite number")

    try:
        value = json.loads(
            encoded.decode("utf-8"), object_pairs_hook=pairs, parse_constant=reject_constant
        )
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        if isinstance(exc, RemoteResultsError):
            raise
        raise RemoteResultsError(f"{name} is not valid UTF-8 JSON") from exc
    _validate_json_value(value, name)
    try:
        canonical = json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    except (TypeError, ValueError) as exc:
        raise RemoteResultsError(f"{name} is not canonical JSON") from exc
    if canonical != encoded:
        raise RemoteResultsError(f"{name} is not canonical JSON")
    return value


def _safe_remote_absolute(value: object) -> str:
    if not isinstance(value, str) or not _REMOTE_ABSOLUTE.fullmatch(value):
        raise RemoteResultsError("Remote output_root is not a bounded absolute path")
    path = PurePosixPath(value)
    if str(path) != value or any(part in {"", ".", ".."} for part in path.parts[1:]):
        raise RemoteResultsError("Remote output_root is not canonical")
    return value


def _validate_typed_request(value: RemoteWorkerRequest, request_sha256: str) -> _RequestContract:
    if not isinstance(value, RemoteWorkerRequest):
        raise RemoteResultsError("request must be canonical bytes or RemoteWorkerRequest")
    _hex(value.request_key, 32, "Remote request key")
    _hex(value.project_id, 32, "Remote project identity")
    if not isinstance(value.resources, ResourceRequest):
        raise RemoteResultsError("Remote request resources are invalid")
    try:
        value.resources.validate()
    except ValueError as exc:
        raise RemoteResultsError("Remote request resources are invalid") from exc
    if not 1 <= len(value.sources) <= MAX_TASKS or not 1 <= len(value.tasks) <= MAX_TASKS:
        raise RemoteResultsError("Remote request source/task counts are invalid")
    source_ids: set[str] = set()
    source_paths: set[str] = set()
    for source in value.sources:
        if not isinstance(source, RemoteSource):
            raise RemoteResultsError("Remote request source is not typed")
        try:
            source.validate()
        except ValueError as exc:
            raise RemoteResultsError("Remote request source is invalid") from exc
        if source.source_id in source_ids or source.relative_path in source_paths:
            raise RemoteResultsError("Remote request contains duplicate source identities")
        source_ids.add(source.source_id)
        source_paths.add(source.relative_path)
    task_ids: set[str] = set()
    for task in value.tasks:
        if not isinstance(task, (RemoteRecipeTask, RemoteCellposeTask)):
            raise RemoteResultsError("Remote request task is not typed")
        try:
            task.validate()
        except ValueError as exc:
            raise RemoteResultsError("Remote request task is invalid") from exc
        if task.task_id in task_ids or task.source_id not in source_ids:
            raise RemoteResultsError("Remote request task identity/source binding is invalid")
        working_bytes = (
            task.recipe["working_bytes"]
            if isinstance(task, RemoteRecipeTask)
            else task.cellpose["working_bytes"]
        )
        if working_bytes > value.resources.memory_mb * 1024 * 1024:
            raise RemoteResultsError("Remote task exceeds its allocated memory")
        task_ids.add(task.task_id)
    cuda_tasks = [
        task
        for task in value.tasks
        if isinstance(task, RemoteCellposeTask) and task.cellpose["requested_device"] == "cuda"
    ]
    if cuda_tasks and value.resources.gpus < 1:
        raise RemoteResultsError("A CUDA Cellpose task is missing its requested GPU")
    if value.resources.gpus and not cuda_tasks:
        raise RemoteResultsError("Remote GPU resources are not bound to a CUDA Cellpose task")
    return _RequestContract(
        value.request_key,
        _hex(request_sha256, 64, "Remote request SHA-256"),
        value.project_id,
        value.resources,
        tuple(value.sources),
        tuple(value.tasks),
    )


def _request_from_bytes(encoded: bytes, expected_sha256: str) -> _RequestContract:
    document = _exact(
        _parse_json(encoded, "Remote request", MAX_MANIFEST_BYTES),
        _REQUEST_KEYS,
        "Remote request",
    )
    actual = hashlib.sha256(encoded).hexdigest()
    if not hmac.compare_digest(actual, expected_sha256):
        raise RemoteResultsError("Remote request bytes disagree with the outer request SHA-256")
    schema = document["schema"]
    if schema not in {"loci.remote-worker-request/v1", "loci.remote-worker-request/v2"}:
        raise RemoteResultsError("Remote request schema is unsupported")
    _safe_remote_absolute(document["output_root"])
    resources_value = _exact(document["resources"], _RESOURCE_KEYS, "Remote resources")
    try:
        resources = ResourceRequest(**resources_value)
    except TypeError as exc:
        raise RemoteResultsError("Remote resources are invalid") from exc
    raw_sources = document["sources"]
    raw_tasks = document["tasks"]
    if not isinstance(raw_sources, list) or not isinstance(raw_tasks, list):
        raise RemoteResultsError("Remote request sources and tasks must be arrays")
    sources: list[RemoteSource] = []
    for raw_source in raw_sources:
        if (
            not isinstance(raw_source, dict)
            or not set(raw_source) >= _SOURCE_KEYS
            or set(raw_source) - (_SOURCE_KEYS | _SOURCE_OPTIONAL_KEYS)
        ):
            raise RemoteResultsError("Remote source has unexpected fields")
        source = raw_source
        try:
            sources.append(
                RemoteSource(
                    source["source_id"],
                    source["path"],
                    source["sha256"],
                    source["size_bytes"],
                    permitted_root=source.get("permitted_root"),
                )
            )
        except (KeyError, TypeError) as exc:
            raise RemoteResultsError("Remote source is invalid") from exc
    tasks: list[RemoteTask] = []
    for raw_task in raw_tasks:
        if not isinstance(raw_task, dict) or not set(raw_task) >= _TASK_BASE_KEYS:
            raise RemoteResultsError("Remote task has unexpected fields")
        task = raw_task
        try:
            if task.get("operation") == "run_recipe":
                if set(task) - (_TASK_BASE_KEYS | {"recipe", "channel_declarations"}) or (
                    "recipe" not in task
                ):
                    raise RemoteResultsError("Remote recipe task has unexpected fields")
                parsed: RemoteTask = RemoteRecipeTask(
                    task["task_id"],
                    task["source_id"],
                    task["selection"],
                    task["recipe"],
                    operation=task["operation"],
                    channel_declarations=task.get("channel_declarations"),
                )
            elif task.get("operation") == "run_cellpose":
                if schema != "loci.remote-worker-request/v2":
                    raise RemoteResultsError("Cellpose tasks require remote request schema v2")
                if set(task) - (_TASK_BASE_KEYS | {"cellpose", "channel_declarations"}) or (
                    "cellpose" not in task
                ):
                    raise RemoteResultsError("Remote Cellpose task has unexpected fields")
                parsed = RemoteCellposeTask(
                    task["task_id"],
                    task["source_id"],
                    task["selection"],
                    task["cellpose"],
                    operation=task["operation"],
                    channel_declarations=task.get("channel_declarations"),
                )
            else:
                raise RemoteResultsError("Remote task operation is unsupported")
            tasks.append(parsed)
        except (KeyError, TypeError) as exc:
            raise RemoteResultsError("Remote task is invalid") from exc
    typed = RemoteWorkerRequest(
        document["request_key"],
        document["project_id"],
        resources,
        tuple(sources),
        tuple(tasks),
    )
    if (schema == "loci.remote-worker-request/v2") != any(
        isinstance(task, RemoteCellposeTask) for task in tasks
    ):
        raise RemoteResultsError("Remote request schema does not match its task operations")
    return _validate_typed_request(typed, actual)


def _validated_outer(manifest: VerifiedOutputManifest, expected_archive_sha256: str) -> OutputEntry:
    if not isinstance(manifest, VerifiedOutputManifest):
        raise RemoteResultsError("outer_manifest must be a verified output manifest")
    _hex(manifest.request_key, 32, "Outer request key")
    _hex(manifest.request_sha256, 64, "Outer request SHA-256")
    expected = _hex(expected_archive_sha256, 64, "Expected archive SHA-256")
    if not isinstance(manifest.entries, tuple) or len(manifest.entries) != 1:
        raise RemoteResultsError("Outer manifest must contain exactly results.zip")
    entry = manifest.entries[0]
    if not isinstance(entry, OutputEntry) or (
        entry.relative_path != "results.zip"
        or entry.media_type != "application/zip"
        or entry.sha256 != expected
    ):
        raise RemoteResultsError("Outer manifest results.zip identity is invalid")
    _integer(entry.size_bytes, 1, MAX_STAGE_FILE_BYTES, "Outer archive size")
    return entry


def _archive_digest(path: Path, expected: OutputEntry) -> str:
    if not path.is_absolute():
        raise RemoteResultsError("Retrieved archive path must be absolute")
    try:
        digest, size = _sha256_file_stable(path, reject_symlink=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RemoteResultsError("Retrieved archive is not a stable plain file") from exc
    if size != expected.size_bytes or not hmac.compare_digest(digest, expected.sha256):
        raise RemoteResultsError("Retrieved archive failed its outer hash or size check")
    return digest


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo, maximum: int) -> bytes:
    if info.file_size > maximum:
        raise RemoteResultsError(f"Archive member {info.filename!r} exceeds its byte bound")
    with archive.open(info, "r") as stream:
        encoded = stream.read(maximum + 1)
    if len(encoded) != info.file_size or len(encoded) > maximum:
        raise RemoteResultsError(f"Archive member {info.filename!r} has an invalid size")
    return encoded


def _member_path(value: object, *, task_id: str | None = None) -> str:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise RemoteResultsError("Archive member path is invalid")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or str(path) != value
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise RemoteResultsError("Archive member path is unsafe or non-canonical")
    if task_id is not None and (
        len(path.parts) < 3 or path.parts[0] != "results" or path.parts[1] != task_id
    ):
        raise RemoteResultsError("Archive member escaped its declared task namespace")
    return value


def _validate_zip_info(info: zipfile.ZipInfo) -> None:
    mode = info.external_attr >> 16
    if (
        info.filename == ""
        or info.is_dir()
        or info.compress_type != zipfile.ZIP_STORED
        or info.compress_size != info.file_size
        or info.flag_bits != 0
        or info.create_system != 3
        or not stat.S_ISREG(mode)
        or stat.S_IMODE(mode) != 0o600
        or info.date_time != (1980, 1, 1, 0, 0, 0)
        or info.extra
        or info.comment
    ):
        raise RemoteResultsError("Archive contains a non-canonical or unsafe member")
    _member_path(info.filename)


def _parse_archive_record(encoded: bytes, contract: _RequestContract) -> dict[str, Any]:
    record = _exact(
        _parse_json(encoded, "Remote archive metadata", MAX_RESULT_JSON_BYTES),
        _ARCHIVE_KEYS,
        "Remote archive metadata",
    )
    if (
        record["schema"] != "loci.remote-results-archive/v1"
        or record["request_key"] != contract.request_key
        or record["request_sha256"] != contract.request_sha256
        or record["project_id"] != contract.project_id
        or record["review_state"] != "unreviewed"
    ):
        raise RemoteResultsError("Remote archive is not bound to the requested unreviewed run")
    return record


def _manifest_members(value: Any) -> list[_Member]:
    if not isinstance(value, list) or not 2 <= len(value) <= MAX_ARCHIVE_MEMBERS - 1:
        raise RemoteResultsError("Remote archive member manifest has an invalid length")
    members: list[_Member] = []
    paths: set[str] = set()
    total = 0
    for item in value:
        item = _exact(item, _MEMBER_KEYS, "Remote archive member")
        path = _member_path(item["path"])
        digest = _hex(item["sha256"], 64, "Remote member SHA-256")
        size = _integer(item["size_bytes"], 1, MAX_STAGE_FILE_BYTES, "Remote member size")
        media = item["media_type"]
        if media not in {"application/json", "application/x-npy"}:
            raise RemoteResultsError("Remote archive member media type is unsupported")
        if path in paths:
            raise RemoteResultsError("Remote archive manifest contains duplicate paths")
        paths.add(path)
        total += size
        if total > MAX_STAGE_FILE_BYTES:
            raise RemoteResultsError("Remote archive expands beyond its global byte bound")
        members.append(_Member(path, digest, size, media))
    if [member.path for member in members] != sorted(paths):
        raise RemoteResultsError("Remote archive member manifest is not canonically ordered")
    return members


def _task_index(value: Any, contract: _RequestContract) -> dict[str, str]:
    if not isinstance(value, list) or len(value) != len(contract.tasks):
        raise RemoteResultsError("Remote archive task result count disagrees with the request")
    index: dict[str, str] = {}
    for position, item in enumerate(value):
        item = _exact(item, _ARCHIVE_TASK_KEYS, "Remote archive task result")
        task = contract.tasks[position]
        expected_path = f"results/{task.task_id}/result.json"
        if item != {
            "task_id": task.task_id,
            "path": expected_path,
            "schema": "loci.remote-task-result/v1",
            "review_state": "unreviewed",
        }:
            raise RemoteResultsError("Remote archive task order or identity is invalid")
        index[task.task_id] = expected_path
    return index


def _validate_local_sources(
    project: ResearchProject,
    contract: _RequestContract,
    mapping: dict[str, str],
) -> dict[str, dict[str, Any]]:
    if not isinstance(mapping, dict) or set(mapping) != {
        source.source_id for source in contract.sources
    }:
        raise RemoteResultsError("Local source mapping must cover the exact remote source set")
    records: dict[str, dict[str, Any]] = {}
    for remote in contract.sources:
        try:
            local_id = checked_id(mapping[remote.source_id])
            local = project.source(local_id, verify=True)
        except (KeyError, OSError, RuntimeError, ValueError) as exc:
            raise RemoteResultsError(
                "A mapped local source is invalid, changed, or unavailable"
            ) from exc
        if local["sha256"] != remote.sha256 or local["size_bytes"] != remote.size_bytes:
            raise RemoteResultsError("A mapped local source differs from the remote source bytes")
        if local.get("source_kind") not in {"native", "whole_slide"} or "private_path" not in local:
            raise RemoteResultsError("Remote result mapping requires a plain native local source")
        records[remote.source_id] = local
    return records


def _validate_runtime(value: Any, engine_version: object) -> None:
    runtime = _exact(value, _RUNTIME_KEYS, "Remote runtime provenance")
    current = runtime_record()
    if (
        engine_version != ENGINE_VERSION
        or runtime != current
        or runtime["engine"] != engine_version
    ):
        raise RemoteResultsError(
            "Remote engine/runtime identity differs from this attachment runtime"
        )


def _validate_cellpose_runtime(
    value: Any,
    task: RemoteCellposeTask,
    engine_version: object,
) -> None:
    runtime = _exact(value, _CELLPOSE_RUNTIME_KEYS, "Remote Cellpose runtime provenance")
    engine = _exact(runtime["engine"], _RUNTIME_KEYS, "Remote engine runtime provenance")
    if engine.get("engine") != engine_version or engine_version != ENGINE_VERSION:
        raise RemoteResultsError("Remote Cellpose engine identity is incompatible")
    cellpose = runtime["cellpose"]
    cellpose_keys = {
        "package",
        "model",
        "profile_id",
        "preprocessing_mode",
        "requested_device",
        "resolved_device",
        "fallback_reason",
        "memory_preflight",
        "inference_scale",
    }
    cellpose = _exact(cellpose, cellpose_keys, "Remote Cellpose inference provenance")
    expected = task.cellpose
    if (
        cellpose["package"] != {"name": "cellpose", "version": expected["package_version"]}
        or cellpose["model"]
        != {"artifact_id": expected["artifact_id"], "sha256": expected["model_sha256"]}
        or cellpose["profile_id"] != expected["profile_id"]
        or cellpose["requested_device"] != expected["requested_device"]
        or cellpose["resolved_device"] not in {"cpu", "cuda"}
        or cellpose["preprocessing_mode"]
        not in {"huggingface-space-uint8", "dynamic-range-preserving"}
        or not isinstance(cellpose["memory_preflight"], dict)
        or isinstance(cellpose["inference_scale"], bool)
        or not isinstance(cellpose["inference_scale"], (int, float))
        or not math.isfinite(float(cellpose["inference_scale"]))
        or not 0 < float(cellpose["inference_scale"]) <= 1
    ):
        raise RemoteResultsError("Remote Cellpose runtime disagrees with its pinned task identity")
    resolved = cellpose["resolved_device"]
    fallback = cellpose["fallback_reason"]
    if fallback is not None and (
        not isinstance(fallback, str) or not fallback or len(fallback) > 4096
    ):
        raise RemoteResultsError("Remote Cellpose fallback provenance is invalid")
    if expected["requested_device"] == "cpu" and (resolved != "cpu" or fallback is not None):
        raise RemoteResultsError("A CPU Cellpose request reported an unexpected device fallback")
    if expected["requested_device"] == "cuda":
        if resolved == "cpu" and fallback is None:
            raise RemoteResultsError("A CUDA Cellpose request omitted its CPU fallback reason")
        if not expected["allow_cpu_fallback"] and (resolved != "cuda" or fallback is not None):
            raise RemoteResultsError("Cellpose used a fallback that the request did not authorize")
    for name in ("python_version", "torch_version"):
        if not isinstance(runtime[name], str) or not runtime[name] or len(runtime[name]) > 256:
            raise RemoteResultsError(f"Remote Cellpose {name} is invalid")
    if runtime["cuda_runtime"] is not None and not isinstance(runtime["cuda_runtime"], str):
        raise RemoteResultsError("Remote Cellpose CUDA runtime identity is invalid")
    if runtime["cudnn_version"] is not None and (
        isinstance(runtime["cudnn_version"], bool)
        or not isinstance(runtime["cudnn_version"], int)
        or runtime["cudnn_version"] < 0
    ):
        raise RemoteResultsError("Remote Cellpose cuDNN identity is invalid")
    if resolved == "cuda" and runtime["cuda_runtime"] is None:
        raise RemoteResultsError("CUDA Cellpose execution omitted its CUDA runtime identity")
    _validate_json_value(runtime, "Remote Cellpose runtime provenance")


def _utc_timestamp(value: object) -> str:
    if not isinstance(value, str) or len(value) > 64:
        raise RemoteResultsError("Remote result timestamp is invalid")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise RemoteResultsError("Remote result timestamp is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
        raise RemoteResultsError("Remote result timestamp is not explicit UTC")
    return value


def _remote_original_result(result: dict[str, Any]) -> dict[str, Any]:
    arrays = {
        name: {
            "sha256": descriptor["sha256"],
            "bytes": descriptor["size_bytes"],
            "shape": descriptor["shape"],
            "dtype": descriptor["dtype"],
        }
        for name, descriptor in result["arrays"].items()
    }
    return {
        "id": result["id"],
        "schema": result["schema"],
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "kind": result["kind"],
        "parent_id": result["parent_id"],
        "created_at": result["created_at"],
        "engine_version": result["engine_version"],
        "arrays": arrays,
        "provenance": result["provenance"],
        "revision_hash": result["revision_hash"],
    }


def _validate_array_descriptor(
    name: str,
    value: Any,
    task_id: str,
    geometry: dict[str, Any],
    shape: tuple[int, ...],
) -> dict[str, Any]:
    if not ARRAY_NAME_PATTERN.fullmatch(name):
        raise RemoteResultsError("Remote array name is invalid")
    descriptor = _exact(value, _REMOTE_ARRAY_KEYS, "Remote array descriptor")
    path = _member_path(descriptor["path"], task_id=task_id)
    if path != f"results/{task_id}/arrays/{name}.npy":
        raise RemoteResultsError("Remote array path is not canonical for its task and name")
    _hex(descriptor["sha256"], 64, "Remote array SHA-256")
    _integer(descriptor["size_bytes"], 1, MAX_ARTIFACT_BYTES + 4096, "Remote array size")
    if descriptor["shape"] != list(shape):
        raise RemoteResultsError("Remote array shape disagrees with the selected local grid")
    dtype = descriptor["dtype"]
    try:
        parsed_dtype = np.dtype(dtype)
    except (TypeError, ValueError) as exc:
        raise RemoteResultsError("Remote array dtype is invalid") from exc
    expected_dtype = "uint32" if name == "labels" else "float64"
    if (
        not isinstance(dtype, str)
        or str(parsed_dtype) != dtype
        or parsed_dtype.kind not in "buif"
        or dtype != expected_dtype
    ):
        raise RemoteResultsError("Remote array dtype is unsupported")
    if (
        descriptor["geometry"] != geometry
        or descriptor["geometry_sha256"]
        != hashlib.sha256(canonical_json(geometry).encode()).hexdigest()
    ):
        raise RemoteResultsError("Remote array geometry identity is invalid")
    return descriptor


def _validate_task_record(
    record: Any,
    task: RemoteTask,
    contract: _RequestContract,
    source: RemoteSource,
    local_source: dict[str, Any],
    workbench: Workbench,
) -> _VerifiedTask:
    record = _exact(record, _TASK_RESULT_KEYS, "Remote task result")
    if (
        record["schema"] != "loci.remote-task-result/v1"
        or record["request_key"] != contract.request_key
        or record["request_sha256"] != contract.request_sha256
        or record["project_id"] != contract.project_id
        or record["task_id"] != task.task_id
        or record["operation"] != task.operation
        or record["source"]
        != {
            "source_id": source.source_id,
            "sha256": source.sha256,
            "size_bytes": source.size_bytes,
        }
        or record["review"] != {"state": "unreviewed", "receipt": None}
    ):
        raise RemoteResultsError("Remote task result is not bound to its request and source")

    result = _exact(record["result"], _PUBLISHED_RESULT_KEYS, "Published remote result")
    if (
        result["schema"] != "loci.research-result/v1"
        or result["source_sha256"] != source.sha256
        or result["parent_id"] is not None
    ):
        raise RemoteResultsError("Published remote result identity is unsupported")
    _hex(result["id"], 32, "Remote result identity")
    _hex(result["source_id"], 32, "Remote internal source identity")
    _hex(result["revision_hash"], 64, "Remote result revision")
    _hex(result["record_sha256"], 64, "Remote result record SHA-256")
    _utc_timestamp(result["created_at"])

    try:
        if isinstance(task, RemoteRecipeTask):
            validated = workbench.validate_recipe(
                {
                    "source_id": local_source["id"],
                    "selection": task.selection,
                    "recipe": task.recipe,
                }
            )
            working_bytes = task.recipe["working_bytes"]
            local_array, local_geometry, selected = workbench.load_scalar(
                local_source["id"],
                validated["selection"],
                working_bytes=working_bytes,
            )
        else:
            validated = None
            working_bytes = task.cellpose["working_bytes"]
            source_working_bytes = min(working_bytes, DEFAULT_WORKING_BYTES)
            selected = workbench.selection(local_source["id"], task.selection)
            local_array, local_geometry, selected = workbench.load_scalar(
                local_source["id"],
                selected,
                working_bytes=source_working_bytes,
                allow_rgb=True,
            )
    except (OSError, RuntimeError, ValueError) as exc:
        raise RemoteResultsError(
            "Remote task cannot be resolved on the mapped local source"
        ) from exc
    del local_array
    # JSON normalization makes tuple-backed affine rows comparable with the
    # canonical list representation carried by the remote publication.
    geometry = parse_json(canonical_json(local_geometry.to_dict()))
    shape = (
        (selected["z_stop"] - selected["z"], selected["height"], selected["width"])
        if "z_stop" in selected
        else (selected["height"], selected["width"])
    )
    provenance_keys = (
        _PROVENANCE_KEYS if isinstance(task, RemoteRecipeTask) else _CELLPOSE_PROVENANCE_KEYS
    )
    provenance = _exact(result["provenance"], provenance_keys, "Remote result provenance")
    from .research_channels import channel_metadata

    expected_metadata = channel_metadata(workbench.project, local_source["id"])
    declared = provenance["channel_metadata"]
    if not isinstance(declared, dict) or set(declared) != set(expected_metadata):
        raise RemoteResultsError("Remote channel declarations are incomplete")
    default_channels = [
        {"index": index, "name": name, "marker": "", "fluorophore": "", "declaration": ""}
        for index, name in enumerate(expected_metadata["original_names"])
    ]
    if (
        declared["source_id"] != result["source_id"]
        or declared["source_sha256"] != source.sha256
        or declared["original_names"] != expected_metadata["original_names"]
        or declared["channels"]
        != (
            task.channel_declarations if task.channel_declarations is not None else default_channels
        )
        or declared["basis"] != expected_metadata["basis"]
        or isinstance(declared["revision"], bool)
        or not isinstance(declared["revision"], int)
        or declared["revision"] < 0
    ):
        raise RemoteResultsError(
            "Remote channel declarations disagree with the request or acquisition"
        )

    if isinstance(task, RemoteRecipeTask):
        if validated is None:
            raise RemoteResultsError("Remote recipe validation state is unavailable")
        _validate_runtime(provenance["runtime"], result["engine_version"])
        probe = np.ones((3,) * len(shape), dtype=np.float64)
        try:
            _, expected_processing = process_scalar(
                probe,
                local_geometry,
                validated["recipe"]["steps"],
                working_bytes=validated["recipe"]["working_bytes"],
            )
        except (TypeError, ValueError) as exc:
            raise RemoteResultsError(
                "Remote processing provenance cannot be reconstructed"
            ) from exc
        if (
            provenance["geometry"] != geometry
            or provenance["selection"] != selected
            or provenance["recipe"] != validated["recipe"]
            or provenance["recipe_sha256"] != validated["recipe_sha256"]
            or provenance["estimated_working_bytes"] != validated["estimated_working_bytes"]
            or provenance["measurement_basis"] != "raw-selected-channel-values-on-result-grid"
            or not _values_match(provenance["processing"], expected_processing)
            or not isinstance(provenance["measurements"], list)
            or (
                provenance["segmentation"] is not None
                and not isinstance(provenance["segmentation"], dict)
            )
        ):
            raise RemoteResultsError(
                "Remote provenance disagrees with the local source grid or recipe"
            )
        expected_names = {"image", "labels"} if validated["recipe"]["segmentation"] else {"image"}
        expected_kind = "segmentation" if "labels" in expected_names else "processed"
    else:
        _validate_cellpose_runtime(provenance["runtime"], task, result["engine_version"])
        expected_rights = {
            "basis": task.cellpose["rights_basis"],
            "model_redistribution": "not-included-in-publication",
            "validation": "operator-declared; not independently verified by Loci",
        }
        if (
            provenance["geometry"] != geometry
            or provenance["selection"] != selected
            or provenance["cellpose"] != task.cellpose
            or provenance["estimated_working_bytes"] != working_bytes
            or provenance["measurement_basis"] != "raw-selected-channel-values-on-result-grid"
            or provenance["rights"] != expected_rights
            or not isinstance(provenance["measurements"], list)
            or not isinstance(provenance["segmentation"], dict)
        ):
            raise RemoteResultsError(
                "Remote Cellpose provenance disagrees with its exact request or local grid"
            )
        expected_names = {"image", "labels"}
        expected_kind = "cellpose-segmentation"
    arrays_value = result["arrays"]
    if not isinstance(arrays_value, dict) or set(arrays_value) != expected_names:
        raise RemoteResultsError("Remote result arrays disagree with the requested operation")
    arrays = {
        name: _validate_array_descriptor(name, descriptor, task.task_id, geometry, shape)
        for name, descriptor in arrays_value.items()
    }
    if result["kind"] != expected_kind:
        raise RemoteResultsError("Remote result kind disagrees with its arrays")
    original = _remote_original_result(result)
    unhashed = {key: value for key, value in original.items() if key != "revision_hash"}
    revision = hashlib.sha256(canonical_json(unhashed).encode()).hexdigest()
    record_sha = hashlib.sha256(canonical_json(original).encode()).hexdigest()
    if not hmac.compare_digest(revision, result["revision_hash"]) or not hmac.compare_digest(
        record_sha, result["record_sha256"]
    ):
        raise RemoteResultsError("Published remote result failed its nested record hashes")
    return _VerifiedTask(task, result, arrays, shape, local_source["id"])


def _load_array(encoded: bytes, descriptor: dict[str, Any]) -> np.ndarray:
    if (
        hashlib.sha256(encoded).hexdigest() != descriptor["sha256"]
        or len(encoded) != descriptor["size_bytes"]
    ):
        raise RemoteResultsError("Remote NPY bytes disagree with their descriptor")
    stream = io.BytesIO(encoded)
    try:
        version = np.lib.format.read_magic(stream)
        if version == (1, 0):
            shape, fortran_order, dtype = np.lib.format.read_array_header_1_0(
                stream, max_header_size=16_384
            )
        elif version == (2, 0):
            shape, fortran_order, dtype = np.lib.format.read_array_header_2_0(
                stream, max_header_size=16_384
            )
        else:
            raise RemoteResultsError("Remote NPY version is unsupported")
    except RemoteResultsError:
        raise
    except (EOFError, OSError, TypeError, ValueError) as exc:
        raise RemoteResultsError("Remote NPY header is invalid") from exc
    if (
        not isinstance(shape, tuple)
        or not 1 <= len(shape) <= 5
        or any(isinstance(item, bool) or not isinstance(item, int) or item < 1 for item in shape)
        or not isinstance(fortran_order, bool)
        or dtype.hasobject
        or dtype.kind not in "buif"
        or list(shape) != descriptor["shape"]
        or str(dtype) != descriptor["dtype"]
    ):
        raise RemoteResultsError("Remote NPY header disagrees with its bounded descriptor")
    elements = 1
    for dimension in shape:
        elements *= dimension
        if elements > MAX_ARTIFACT_BYTES:
            raise RemoteResultsError("Remote NPY header declares an oversized array")
    payload_bytes = elements * dtype.itemsize
    if payload_bytes > MAX_ARTIFACT_BYTES or len(encoded) - stream.tell() != payload_bytes:
        raise RemoteResultsError("Remote NPY payload length disagrees with its header")
    stream.seek(0)
    try:
        array = np.load(stream, allow_pickle=False, max_header_size=16_384)
    except (OSError, TypeError, ValueError) as exc:
        raise RemoteResultsError("Remote array is not a safe NPY artifact") from exc
    if (
        not isinstance(array, np.ndarray)
        or array.dtype.kind not in "buif"
        or list(array.shape) != descriptor["shape"]
        or str(array.dtype) != descriptor["dtype"]
        or array.nbytes > MAX_ARTIFACT_BYTES
        or not np.isfinite(array).all()
        or stream.tell() != len(encoded)
    ):
        raise RemoteResultsError("Remote array violates its numeric, shape, or dtype contract")
    return array


def _values_match(expected: Any, actual: Any) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, int) or isinstance(actual, int):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, float) or isinstance(actual, float):
        return (
            isinstance(expected, (int, float))
            and isinstance(actual, (int, float))
            and math.isclose(float(expected), float(actual), rel_tol=1e-12, abs_tol=1e-12)
        )
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(
            _values_match(left, right) for left, right in zip(expected, actual, strict=True)
        )
    if isinstance(expected, dict) and isinstance(actual, dict):
        return set(expected) == set(actual) and all(
            _values_match(expected[key], actual[key]) for key in expected
        )
    return type(expected) is type(actual) and expected == actual


def _validate_measurements(
    checked: _VerifiedTask,
    arrays: dict[str, np.ndarray],
    workbench: Workbench,
    local_source: dict[str, Any],
) -> None:
    provenance = checked.record["provenance"]
    declared = provenance["measurements"]
    segmentation = provenance["segmentation"]
    labels = arrays.get("labels")
    if labels is None:
        if declared or segmentation is not None:
            raise RemoteResultsError("Unsegmented remote result contains object measurements")
        return
    if segmentation is None:
        raise RemoteResultsError("Remote labels are missing segmentation provenance")
    positive_ids = np.unique(labels)
    positive_ids = positive_ids[positive_ids != 0]
    if not np.array_equal(positive_ids, np.arange(1, len(positive_ids) + 1)):
        raise RemoteResultsError("Remote labels disagree with segmentation provenance")
    geometry = geometry_from_dict(provenance["geometry"])
    if isinstance(checked.request, RemoteRecipeTask):
        segmentation_keys = {
            "method",
            "dimensions",
            "threshold",
            "threshold_method",
            "polarity",
            "connectivity",
            "min_size",
            "size_unit",
            "split_height",
            "distance_unit",
            "exclude_border",
            "count",
            "scientific_validation",
        }
        if not isinstance(segmentation, dict) or set(segmentation) != segmentation_keys:
            raise RemoteResultsError("Remote segmentation provenance schema is invalid")
        settings = checked.request.recipe["segmentation"]
        threshold_setting = settings.get("threshold", "otsu")
        expected_threshold = (
            float(threshold_otsu(arrays["image"]))
            if threshold_setting == "otsu"
            else float(threshold_setting)
        )
        expected_threshold_method = (
            "otsu-on-selected-scalar-array" if threshold_setting == "otsu" else "user-defined"
        )
        spacing = geometry.orthogonal_spacing()
        expected_split = (
            float(settings.get("split_height", min(spacing)))
            if settings.get("method", "components") == "watershed"
            else None
        )
        expected_segmentation = {
            "method": settings.get("method", "components"),
            "dimensions": labels.ndim,
            "threshold": expected_threshold,
            "threshold_method": expected_threshold_method,
            "polarity": settings.get("polarity", "bright"),
            "connectivity": 1,
            "min_size": float(settings.get("min_size", 0)),
            "size_unit": f"{geometry.unit}^{labels.ndim}",
            "split_height": expected_split,
            "distance_unit": geometry.unit,
            "exclude_border": settings.get("exclude_border", False),
            "count": len(positive_ids),
            "scientific_validation": "unvalidated-research-method",
        }
        measurement_channels = checked.request.recipe["measurement_channels"]
        gates = checked.request.recipe["gates"]
        working_bytes = checked.request.recipe["working_bytes"]
    else:
        expected_segmentation = {
            "method": "cellpose",
            "dimensions": 2,
            "count": len(positive_ids),
            "scientific_validation": "unvalidated-research-method",
        }
        measurement_channels = checked.request.cellpose["measurement_channels"]
        gates = checked.request.cellpose["gates"]
        working_bytes = checked.request.cellpose["working_bytes"]
    source_working_bytes = min(working_bytes, DEFAULT_WORKING_BYTES)
    if not _values_match(segmentation, expected_segmentation):
        raise RemoteResultsError("Remote segmentation provenance disagrees with its recipe")
    channels: dict[str, np.ndarray] = {}
    names = [item["name"] for item in provenance["channel_metadata"]["channels"]]
    for channel in measurement_channels:
        try:
            raw, raw_geometry, selected = workbench.load_scalar(
                checked.local_source_id,
                {**checked.request.selection, "c": channel},
                strict=False,
                working_bytes=source_working_bytes,
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise RemoteResultsError("A measurement channel cannot be verified locally") from exc
        if raw_geometry != geometry or selected != {**checked.request.selection, "c": channel}:
            raise RemoteResultsError(
                "A measurement channel disagrees with the selected result grid"
            )
        try:
            name = names[channel]
        except (IndexError, TypeError) as exc:
            raise RemoteResultsError("Local source channel metadata is inconsistent") from exc
        channels[f"{channel + 1}: {name}"] = raw
    try:
        recomputed = apply_marker_gates(
            measure_objects(
                labels,
                geometry,
                channels,
                working_bytes=working_bytes,
            ),
            gates,
        )
    except (IndexError, TypeError, ValueError) as exc:
        raise RemoteResultsError(
            "Remote measurements cannot be independently reconstructed"
        ) from exc
    if not _values_match(declared, recomputed):
        raise RemoteResultsError("Remote measurements disagree with labels and local raw channels")


def _existing_receipt(
    project: ResearchProject, contract: _RequestContract
) -> dict[str, Any] | None:
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", ("remote-attachment:" + contract.request_key,)
        ).fetchone()
    if row is None:
        return None
    try:
        receipt = _exact(parse_json(row[0]), _RECEIPT_KEYS, "Stored remote attachment receipt")
    except (TypeError, ValueError) as exc:
        raise RemoteResultsError("Stored remote attachment receipt is corrupt") from exc
    if (
        receipt["schema"] != "loci.remote-results-attachment/v1"
        or receipt["request_key"] != contract.request_key
        or receipt["remote_project_id"] != contract.project_id
        or receipt["local_project_id"] != project.meta["project_id"]
        or receipt["remote_review_state"] != "unreviewed"
        or receipt["local_review_receipts_created"] is not False
        or not isinstance(receipt["task_results"], list)
    ):
        raise RemoteResultsError("Stored remote attachment receipt has an invalid identity")
    return receipt


def _same_attachment(
    receipt: dict[str, Any],
    contract: _RequestContract,
    digest: str,
    source_mapping: dict[str, str],
    local_job_id: str | None,
) -> bool:
    return (
        receipt.get("request_key") == contract.request_key
        and receipt.get("request_sha256") == contract.request_sha256
        and receipt.get("remote_project_id") == contract.project_id
        and receipt.get("archive_sha256") == digest
        and receipt.get("source_mapping") == source_mapping
        and receipt.get("local_job_id") == local_job_id
    )


def _validate_attached_results(
    project: ResearchProject,
    receipt: dict[str, Any],
    contract: _RequestContract,
) -> None:
    tasks = receipt["task_results"]
    if not isinstance(tasks, list) or len(tasks) != len(contract.tasks):
        raise RemoteResultsError("Stored attachment receipt has an invalid task set")
    for task, item in zip(contract.tasks, tasks, strict=True):
        item = _exact(item, _RECEIPT_TASK_KEYS, "Stored attachment task receipt")
        if item["remote_task_id"] != task.task_id:
            raise RemoteResultsError("Stored attachment receipt task identity is invalid")
        try:
            result = project.result(item["local_result_id"])
            if result["revision_hash"] != item["local_revision_hash"]:
                raise RemoteResultsError("Stored attached result revision is mismatched")
            provenance = result["provenance"]["remote_attachment"]
            if (
                provenance["request_key"] != contract.request_key
                or provenance["request_sha256"] != contract.request_sha256
                or provenance["archive_sha256"] != receipt["archive_sha256"]
                or provenance["remote_task_id"] != task.task_id
                or provenance["remote_result_id"] != item["remote_result_id"]
                or provenance["remote_result_revision_hash"] != item["remote_revision_hash"]
                or result["source_id"] != receipt["source_mapping"][task.source_id]
            ):
                raise RemoteResultsError("Stored attached result provenance is mismatched")
            for artifact in result["arrays"].values():
                project.load_array(artifact)
        except RemoteResultsError:
            raise
        except (KeyError, OSError, RuntimeError, TypeError, ValueError) as exc:
            raise RemoteResultsError("Stored attached result or array failed verification") from exc


def attach_remote_results(
    project: ResearchProject,
    request: bytes,
    archive_path: str | Path,
    *,
    expected_archive_sha256: str,
    outer_manifest: VerifiedOutputManifest,
    local_source_mapping: dict[str, str],
    local_job_id: str | None = None,
) -> dict[str, Any]:
    """Verify and atomically attach one retrieved ``results.zip`` publication.

    Remote result ids are retained only in provenance. New local result ids and
    revision hashes bind the imported arrays to explicitly mapped local sources.
    """

    if not isinstance(project, ResearchProject):
        raise RemoteResultsError("project must be an open ResearchProject")
    entry = _validated_outer(outer_manifest, expected_archive_sha256)
    if not isinstance(request, bytes):
        raise RemoteResultsError("Attachment requires the exact original canonical request bytes")
    contract = _request_from_bytes(request, outer_manifest.request_sha256)
    if (
        outer_manifest.request_key != contract.request_key
        or outer_manifest.request_sha256 != contract.request_sha256
    ):
        raise RemoteResultsError("Outer manifest is not bound to the supplied request")
    local_sources = _validate_local_sources(project, contract, local_source_mapping)
    archive = Path(archive_path)
    digest = _archive_digest(archive, entry)
    existing = _existing_receipt(project, contract)
    if existing is not None:
        if _same_attachment(existing, contract, digest, local_source_mapping, local_job_id):
            _validate_attached_results(project, existing, contract)
            return existing
        raise RemoteResultsError("This remote request key was already attached with other inputs")

    source_by_id = {source.source_id: source for source in contract.sources}
    task_by_id = {task.task_id: task for task in contract.tasks}
    workbench = Workbench(project)
    verified: list[_VerifiedTask] = []
    artifacts: dict[str, dict[str, dict[str, Any]]] = {}
    try:
        try:
            with zipfile.ZipFile(archive, "r", allowZip64=True) as zipped:
                if zipped.comment:
                    raise RemoteResultsError("Remote archive comment is not canonical")
                infos = zipped.infolist()
                if not 3 <= len(infos) <= MAX_ARCHIVE_MEMBERS:
                    raise RemoteResultsError("Remote archive member count is invalid")
                for info in infos:
                    _validate_zip_info(info)
                names = [info.filename for info in infos]
                if (
                    len(set(names)) != len(names)
                    or names[-1] != "archive.json"
                    or names[:-1] != sorted(names[:-1])
                ):
                    raise RemoteResultsError(
                        "Remote archive has duplicate or non-canonical members"
                    )
                by_name = {info.filename: info for info in infos}
                archive_record = _parse_archive_record(
                    _read_member(zipped, by_name["archive.json"], MAX_RESULT_JSON_BYTES), contract
                )
                members = _manifest_members(archive_record["members"])
                task_paths = _task_index(archive_record["task_results"], contract)
                if names[:-1] != [member.path for member in members]:
                    raise RemoteResultsError("Remote ZIP members disagree with archive.json")
                member_by_path = {member.path: member for member in members}
                for member in members:
                    info = by_name[member.path]
                    if info.file_size != member.size_bytes:
                        raise RemoteResultsError("Remote member size disagrees with archive.json")
                    encoded = _read_member(zipped, info, member.size_bytes)
                    if hashlib.sha256(encoded).hexdigest() != member.sha256:
                        raise RemoteResultsError("Remote member failed its archive.json hash")
                for task_id, result_path in task_paths.items():
                    task = task_by_id[task_id]
                    record_member = member_by_path.get(result_path)
                    if record_member is None or record_member.media_type != "application/json":
                        raise RemoteResultsError("Remote task JSON member is missing or mistyped")
                    record = _parse_json(
                        _read_member(zipped, by_name[result_path], MAX_RESULT_JSON_BYTES),
                        "Remote task result",
                        MAX_RESULT_JSON_BYTES,
                    )
                    checked = _validate_task_record(
                        record,
                        task,
                        contract,
                        source_by_id[task.source_id],
                        local_sources[task.source_id],
                        workbench,
                    )
                    task_arrays: dict[str, np.ndarray] = {}
                    for name, descriptor in checked.arrays.items():
                        member = member_by_path.get(descriptor["path"])
                        if (
                            member is None
                            or member.media_type != "application/x-npy"
                            or member.sha256 != descriptor["sha256"]
                            or member.size_bytes != descriptor["size_bytes"]
                        ):
                            raise RemoteResultsError(
                                "Remote array descriptor disagrees with archive.json"
                            )
                        task_arrays[name] = _load_array(
                            _read_member(zipped, by_name[member.path], member.size_bytes),
                            descriptor,
                        )
                    _validate_measurements(
                        checked,
                        task_arrays,
                        workbench,
                        local_sources[task.source_id],
                    )
                    task_artifacts: dict[str, dict[str, Any]] = {}
                    for name, array in task_arrays.items():
                        try:
                            task_artifacts[name] = project.store_array(array)
                        except (OSError, RuntimeError, ValueError) as exc:
                            raise RemoteResultsError(
                                "Remote array could not be staged in the local study"
                            ) from exc
                    del task_arrays
                    verified.append(checked)
                    artifacts[task_id] = task_artifacts
                expected_paths = set(task_paths.values()) | {
                    descriptor["path"] for item in verified for descriptor in item.arrays.values()
                }
                if set(member_by_path) != expected_paths:
                    raise RemoteResultsError("Remote archive contains unexpected published members")
        except (KeyError, OSError, zipfile.BadZipFile) as exc:
            if isinstance(exc, RemoteResultsError):
                raise
            raise RemoteResultsError("Remote result archive is malformed or unreadable") from exc
    finally:
        workbench.close()

    _archive_digest(archive, entry)
    for remote_id, local in local_sources.items():
        try:
            current = project.source(local["id"], verify=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise RemoteResultsError("A mapped local source changed before publication") from exc
        if current["sha256"] != source_by_id[remote_id].sha256:
            raise RemoteResultsError("A mapped local source changed before publication")

    now = timestamp()
    result_records: list[dict[str, Any]] = []
    task_receipts: list[dict[str, Any]] = []
    for item in verified:
        remote = item.record
        provenance = {
            **remote["provenance"],
            "remote_attachment": {
                "schema": "loci.remote-result-provenance/v1",
                "request_key": contract.request_key,
                "request_sha256": contract.request_sha256,
                "remote_project_id": contract.project_id,
                "remote_task_id": item.request.task_id,
                "remote_result_id": remote["id"],
                "remote_result_revision_hash": remote["revision_hash"],
                "remote_result_record_sha256": remote["record_sha256"],
                "archive_sha256": digest,
                "remote_source_id": item.request.source_id,
                "remote_internal_source_id": remote["source_id"],
                "review_state": "unreviewed",
            },
        }
        record = {
            "id": uuid.uuid4().hex,
            "schema": "loci.research-result/v1",
            "source_id": item.local_source_id,
            "source_sha256": local_sources[item.request.source_id]["sha256"],
            "kind": remote["kind"],
            "parent_id": None,
            "created_at": now,
            "engine_version": ENGINE_VERSION,
            "arrays": artifacts[item.request.task_id],
            "provenance": provenance,
        }
        record["revision_hash"] = hashlib.sha256(canonical_json(record).encode()).hexdigest()
        result_records.append(record)
        task_receipts.append(
            {
                "remote_task_id": item.request.task_id,
                "remote_result_id": remote["id"],
                "remote_revision_hash": remote["revision_hash"],
                "local_result_id": record["id"],
                "local_revision_hash": record["revision_hash"],
            }
        )
    attachment_key = hashlib.sha256(
        canonical_json(
            {
                "request_key": contract.request_key,
                "request_sha256": contract.request_sha256,
                "archive_sha256": digest,
                "source_mapping": local_source_mapping,
            }
        ).encode()
    ).hexdigest()
    receipt = {
        "schema": "loci.remote-results-attachment/v1",
        "attachment_key": attachment_key,
        "request_key": contract.request_key,
        "request_sha256": contract.request_sha256,
        "remote_project_id": contract.project_id,
        "archive_sha256": digest,
        "local_project_id": project.meta["project_id"],
        "source_mapping": dict(sorted(local_source_mapping.items())),
        "task_results": task_receipts,
        "attached_at": now,
        "remote_review_state": "unreviewed",
        "local_review_receipts_created": False,
        "local_job_id": local_job_id,
    }
    try:
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            # Recheck every external scientific input and every staged array
            # while the one publication transaction is holding its write lock.
            archive_digest, archive_size = _sha256_file_stable(archive, reject_symlink=True)
            if archive_digest != entry.sha256 or archive_size != entry.size_bytes:
                raise RemoteResultsError("Remote archive changed at final publication")
            for remote_id, local in local_sources.items():
                source_digest, source_size = _sha256_file_stable(
                    Path(local["private_path"]), reject_symlink=True
                )
                remote_source = source_by_id[remote_id]
                if source_digest != remote_source.sha256 or source_size != remote_source.size_bytes:
                    raise RemoteResultsError("A mapped local source changed at publication")
            for result_record in result_records:
                for artifact in result_record["arrays"].values():
                    artifact_path = project.arrays / f"{artifact['sha256']}.npy"
                    artifact_digest, artifact_size = _sha256_file_stable(
                        artifact_path, reject_symlink=True
                    )
                    if artifact_digest != artifact["sha256"] or artifact_size != artifact["bytes"]:
                        raise RemoteResultsError("A staged local array changed at publication")
            prior = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                ("remote-attachment:" + contract.request_key,),
            ).fetchone()
            if prior is not None:
                parsed = parse_json(prior[0])
                if isinstance(parsed, dict) and _same_attachment(
                    parsed, contract, digest, local_source_mapping, local_job_id
                ):
                    raise RemoteResultsError(
                        "This remote request was concurrently attached; retry to verify it"
                    )
                raise RemoteResultsError("This remote request was concurrently attached")
            if local_job_id is not None:
                row = connection.execute(
                    "SELECT record FROM jobs WHERE id=?", (checked_id(local_job_id),)
                ).fetchone()
                if row is None:
                    raise RemoteResultsError("Local publication job is not part of this study")
                job = parse_json(row[0])
                if job["state"] != "running" or job["cancel_requested"]:
                    raise RemoteResultsError("Local publication job was cancelled or stopped")
                job.update(
                    state="succeeded",
                    progress=1.0,
                    result_ids=[record["id"] for record in result_records],
                    finished_at=now,
                    updated_at=now,
                )
                connection.execute(
                    "UPDATE jobs SET record=? WHERE id=?", (canonical_json(job), local_job_id)
                )
            for record in result_records:
                connection.execute(
                    "INSERT INTO results VALUES(?,?)", (record["id"], canonical_json(record))
                )
            connection.execute(
                "INSERT INTO metadata VALUES(?,?)",
                ("remote-attachment:" + contract.request_key, canonical_json(receipt)),
            )
    except RemoteResultsError:
        raise
    except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
        raise RemoteResultsError("Remote results could not be atomically published") from exc
    return receipt
