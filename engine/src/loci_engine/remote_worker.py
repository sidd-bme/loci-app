"""Fail-closed execution of canonical, staged remote research requests.

The scheduler-facing entry point accepts one request file. It exposes no generic
operation or command execution and publishes only hash-bound derived artifacts.
Source paths remain private to the worker-side study.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import secrets
import shutil
import stat
import tempfile
import zipfile
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np

from .export import _fsync_directory
from .remote_compute import (
    MAX_MANIFEST_BYTES,
    MAX_OUTPUT_MANIFEST_BYTES,
    MAX_STAGE_FILE_BYTES,
    RemoteCellposeTask,
    RemoteRecipeTask,
    RemoteSource,
    RemoteTask,
    ResourceRequest,
)
from .research_project import ResearchProject, canonical_json
from .workbench import Workbench
from .working_result import _sha256_file_stable

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
_RUN_MARKER_KEYS = {"schema", "request_key", "request_sha256"}
_HEX32 = frozenset("0123456789abcdef")


class RemoteWorkerError(RuntimeError):
    """Raised when a staged request or derived publication is unverifiable."""


@dataclass(frozen=True, slots=True)
class _ValidatedRequest:
    document: dict[str, Any]
    encoded: bytes
    request_sha256: str
    staging_root: Path
    output_root: Path
    resources: ResourceRequest
    sources: tuple[RemoteSource, ...]
    tasks: tuple[RemoteTask, ...]


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise RemoteWorkerError("Remote request JSON contains duplicate keys")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise RemoteWorkerError("Remote request JSON contains a non-finite number")


def _parse_json(encoded: bytes, name: str, *, maximum: int = MAX_MANIFEST_BYTES) -> Any:
    if len(encoded) > maximum:
        raise RemoteWorkerError(f"{name} exceeds the supported size")
    try:
        text = encoded.decode("utf-8")
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RemoteWorkerError(f"{name} is not valid UTF-8 JSON") from exc


def _read_stable(path: Path, *, maximum: int, name: str) -> bytes:
    try:
        before_path = path.lstat()
        if not stat.S_ISREG(before_path.st_mode) or before_path.st_size > maximum:
            raise RemoteWorkerError(f"{name} must be a bounded plain file")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise RemoteWorkerError(f"{name} could not be opened as a plain file") from exc
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before_path.st_dev, before_path.st_ino):
            raise RemoteWorkerError(f"{name} changed before it could be read")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            encoded = stream.read(maximum + 1)
        after_open = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        after_path = path.lstat()
    except OSError as exc:
        raise RemoteWorkerError(f"{name} changed while it was read") from exc
    before = (
        before_path.st_dev,
        before_path.st_ino,
        before_path.st_size,
        before_path.st_mtime_ns,
    )
    after = (
        after_path.st_dev,
        after_path.st_ino,
        after_path.st_size,
        after_path.st_mtime_ns,
    )
    opened_after = (
        after_open.st_dev,
        after_open.st_ino,
        after_open.st_size,
        after_open.st_mtime_ns,
    )
    if len(encoded) > maximum or before != after or before != opened_after:
        raise RemoteWorkerError(f"{name} changed while it was read")
    return encoded


def _plain_directory(path: Path, name: str) -> Path:
    if not path.is_absolute():
        raise RemoteWorkerError(f"{name} must be absolute")
    try:
        identity = path.lstat()
    except OSError as exc:
        raise RemoteWorkerError(f"{name} is unavailable") from exc
    if not stat.S_ISDIR(identity.st_mode):
        raise RemoteWorkerError(f"{name} must be a plain directory")
    resolved = path.resolve(strict=True)
    if resolved != path:
        raise RemoteWorkerError(f"{name} cannot contain linked path components")
    return resolved


def _load_marker(root: Path) -> dict[str, str]:
    marker = _parse_json(
        _read_stable(root / ".loci-owned.json", maximum=4096, name="Loci ownership marker"),
        "Loci ownership marker",
    )
    if (
        not isinstance(marker, dict)
        or set(marker) != _RUN_MARKER_KEYS
        or marker.get("schema") != "loci.remote-run/v1"
        or not _is_hex(marker.get("request_key"), 32)
        or not _is_hex(marker.get("request_sha256"), 64)
    ):
        raise RemoteWorkerError("Loci ownership marker is invalid")
    return marker


def _is_hex(value: Any, length: int) -> bool:
    return isinstance(value, str) and len(value) == length and set(value) <= _HEX32


def _relative_source(root: Path, relative: str) -> Path:
    try:
        normalized = str(PurePosixPath(relative))
    except TypeError as exc:
        raise RemoteWorkerError("Remote source path is invalid") from exc
    if normalized != relative or PurePosixPath(relative).is_absolute():
        raise RemoteWorkerError("Remote source path is not canonical and relative")
    current = root
    parts = PurePosixPath(relative).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise RemoteWorkerError("Remote source path contains an unsafe component")
    for index, part in enumerate(parts):
        current = current / part
        try:
            value = current.lstat()
        except OSError as exc:
            raise RemoteWorkerError("A declared remote source is unavailable") from exc
        if index < len(parts) - 1:
            if not stat.S_ISDIR(value.st_mode):
                raise RemoteWorkerError("Remote source parent must be a plain directory")
        elif not stat.S_ISREG(value.st_mode):
            raise RemoteWorkerError("Remote source must be a plain file")
    if not current.resolve(strict=True).is_relative_to(root):
        raise RemoteWorkerError("Remote source escaped its staging root")
    return current


def _validated_contract(
    document: Any,
) -> tuple[ResourceRequest, tuple[RemoteSource, ...], tuple[RemoteTask, ...]]:
    if not isinstance(document, dict) or set(document) != _REQUEST_KEYS:
        raise RemoteWorkerError("Remote worker request has unexpected fields")
    schema = document.get("schema")
    if schema not in {"loci.remote-worker-request/v1", "loci.remote-worker-request/v2"}:
        raise RemoteWorkerError("Remote worker request schema is unsupported")
    if not _is_hex(document.get("request_key"), 32):
        raise RemoteWorkerError("Remote worker request key is invalid")
    if not _is_hex(document.get("project_id"), 32):
        raise RemoteWorkerError("Remote worker project identity is invalid")
    raw_resources = document.get("resources")
    if not isinstance(raw_resources, dict) or set(raw_resources) != _RESOURCE_KEYS:
        raise RemoteWorkerError("Remote worker resources have unexpected fields")
    try:
        resources = ResourceRequest(**raw_resources)
        resources.validate()
    except (TypeError, ValueError) as exc:
        raise RemoteWorkerError("Remote worker resources are invalid") from exc
    raw_sources = document.get("sources")
    if not isinstance(raw_sources, list) or not 1 <= len(raw_sources) <= 10_000:
        raise RemoteWorkerError("Remote worker sources must be a bounded non-empty list")
    sources: list[RemoteSource] = []
    source_ids: set[str] = set()
    source_paths: set[tuple[str | None, str]] = set()
    for item in raw_sources:
        if (
            not isinstance(item, dict)
            or not set(item) >= _SOURCE_KEYS
            or set(item) - (_SOURCE_KEYS | _SOURCE_OPTIONAL_KEYS)
        ):
            raise RemoteWorkerError("Remote worker source has unexpected fields")
        try:
            source = RemoteSource(
                item["source_id"],
                item["path"],
                item["sha256"],
                item["size_bytes"],
                permitted_root=item.get("permitted_root"),
            )
            source.validate()
        except (TypeError, ValueError) as exc:
            raise RemoteWorkerError("Remote worker source is invalid") from exc
        if source.source_id in source_ids or source.location_key in source_paths:
            raise RemoteWorkerError("Remote worker sources contain a duplicate identity or path")
        source_ids.add(source.source_id)
        source_paths.add(source.location_key)
        sources.append(source)
    raw_tasks = document.get("tasks")
    if not isinstance(raw_tasks, list) or not 1 <= len(raw_tasks) <= 10_000:
        raise RemoteWorkerError("Remote worker tasks must be a bounded non-empty list")
    tasks: list[RemoteTask] = []
    task_ids: set[str] = set()
    for item in raw_tasks:
        if not isinstance(item, dict) or not set(item) >= _TASK_BASE_KEYS:
            raise RemoteWorkerError("Remote worker task has unexpected fields")
        try:
            if item.get("operation") == "run_recipe":
                if set(item) - (_TASK_BASE_KEYS | {"recipe", "channel_declarations"}) or (
                    "recipe" not in item
                ):
                    raise RemoteWorkerError("Remote recipe task has unexpected fields")
                task: RemoteTask = RemoteRecipeTask(
                    item["task_id"],
                    item["source_id"],
                    item["selection"],
                    item["recipe"],
                    operation=item["operation"],
                    channel_declarations=item.get("channel_declarations"),
                )
            elif item.get("operation") == "run_cellpose":
                if schema != "loci.remote-worker-request/v2":
                    raise RemoteWorkerError("Cellpose tasks require worker request schema v2")
                if set(item) - (_TASK_BASE_KEYS | {"cellpose", "channel_declarations"}) or (
                    "cellpose" not in item
                ):
                    raise RemoteWorkerError("Remote Cellpose task has unexpected fields")
                task = RemoteCellposeTask(
                    item["task_id"],
                    item["source_id"],
                    item["selection"],
                    item["cellpose"],
                    operation=item["operation"],
                    channel_declarations=item.get("channel_declarations"),
                )
            else:
                raise RemoteWorkerError("Remote worker task operation is unsupported")
            task.validate()
        except (TypeError, ValueError) as exc:
            raise RemoteWorkerError("Remote worker task is invalid") from exc
        if task.task_id in task_ids or task.source_id not in source_ids:
            raise RemoteWorkerError("Remote worker task identity or source binding is invalid")
        working_bytes = (
            task.recipe["working_bytes"]
            if isinstance(task, RemoteRecipeTask)
            else task.cellpose["working_bytes"]
        )
        if working_bytes > resources.memory_mb * 1024 * 1024:
            raise RemoteWorkerError("Remote task working budget exceeds its allocated memory")
        task_ids.add(task.task_id)
        tasks.append(task)
    cuda_tasks = [
        task
        for task in tasks
        if isinstance(task, RemoteCellposeTask) and task.cellpose["requested_device"] == "cuda"
    ]
    if cuda_tasks and resources.gpus < 1:
        raise RemoteWorkerError("A CUDA Cellpose task requires a requested GPU")
    if resources.gpus and not cuda_tasks:
        raise RemoteWorkerError("GPU resources require at least one CUDA Cellpose task")
    has_cellpose = any(isinstance(task, RemoteCellposeTask) for task in tasks)
    if (schema == "loci.remote-worker-request/v2") != has_cellpose:
        raise RemoteWorkerError("Worker request schema does not match its task operations")
    return resources, tuple(sources), tuple(tasks)


def _load_request(path: Path) -> _ValidatedRequest:
    if not path.is_absolute() or path.name != "request.json":
        raise RemoteWorkerError("Remote worker requires an absolute request.json path")
    staging_root = _plain_directory(path.parent, "Remote staging root")
    if staging_root.name == "" or staging_root.parent.name != ".loci-runs":
        raise RemoteWorkerError("Remote staging root is outside the Loci run namespace")
    marker = _load_marker(staging_root)
    if marker["request_key"] != staging_root.name:
        raise RemoteWorkerError("Remote staging directory and marker identity disagree")
    encoded = _read_stable(path, maximum=MAX_MANIFEST_BYTES, name="Remote request")
    document = _parse_json(encoded, "Remote request")
    if not isinstance(document, dict):
        raise RemoteWorkerError("Remote request must be a JSON object")
    try:
        canonical = json.dumps(
            document, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    except (TypeError, ValueError) as exc:
        raise RemoteWorkerError("Remote request is not canonical JSON") from exc
    if canonical != encoded:
        raise RemoteWorkerError("Remote request bytes are not canonical JSON")
    request_sha256 = hashlib.sha256(encoded).hexdigest()
    if marker["request_sha256"] != request_sha256:
        raise RemoteWorkerError("Remote request does not match its reserved SHA-256")
    resources, sources, tasks = _validated_contract(document)
    if document["request_key"] != marker["request_key"]:
        raise RemoteWorkerError("Remote request and reservation key disagree")
    raw_output = document["output_root"]
    if not isinstance(raw_output, str) or not (
        raw_output.startswith("/") or (os.name == "nt" and Path(raw_output).is_absolute())
    ):
        raise RemoteWorkerError("Remote output root must be an absolute path")
    output_root = _plain_directory(Path(raw_output), "Remote output root")
    if output_root == staging_root or output_root.parent.name != ".loci-runs":
        raise RemoteWorkerError("Remote output root is outside a separate Loci run namespace")
    output_marker = _load_marker(output_root)
    if output_marker != marker or output_root.name != marker["request_key"]:
        raise RemoteWorkerError("Remote output reservation does not match the request")
    return _ValidatedRequest(
        document,
        encoded,
        request_sha256,
        staging_root,
        output_root,
        resources,
        sources,
        tasks,
    )


def _verify_sources(request: _ValidatedRequest) -> dict[str, Path]:
    resolved: dict[str, Path] = {}
    for source in request.sources:
        root = request.staging_root
        if source.permitted_root is not None:
            root = _plain_directory(Path(source.permitted_root), "Permitted remote input root")
            for managed in (request.staging_root, request.output_root):
                if root == managed or root.is_relative_to(managed) or managed.is_relative_to(root):
                    raise RemoteWorkerError(
                        "A permitted remote input root overlaps a managed run root"
                    )
        path = _relative_source(root, source.relative_path)
        try:
            digest, size = _sha256_file_stable(path, reject_symlink=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise RemoteWorkerError("A remote source could not be verified") from exc
        if digest != source.sha256 or size != source.size_bytes:
            raise RemoteWorkerError("A remote source failed SHA-256 or size verification")
        resolved[source.source_id] = path
    return resolved


def _write_file(path: Path, encoded: bytes) -> tuple[str, int]:
    if path.exists() or path.is_symlink():
        raise RemoteWorkerError("A derived publication target already exists")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    return hashlib.sha256(encoded).hexdigest(), len(encoded)


def _publish_file_noreplace(source: Path, destination: Path) -> None:
    """Publish one staged file atomically with NFS-compatible hard-link exclusion."""

    if source.parent != destination.parent or not stat.S_ISREG(source.lstat().st_mode):
        raise RemoteWorkerError("Atomic file publication requires one plain-file directory")
    try:
        os.link(source, destination, follow_symlinks=False)
        os.unlink(source)
    except OSError as exc:
        raise RemoteWorkerError("Atomic no-replace file publication failed") from exc
    descriptor = os.open(
        destination,
        os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RemoteWorkerError("Published output is no longer a plain file")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _fsync_directory(destination.parent)


def _copy_array(source: Path, destination: Path, expected: dict[str, Any]) -> dict[str, Any]:
    try:
        digest, size = _sha256_file_stable(source, reject_symlink=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RemoteWorkerError("A study array could not be verified before export") from exc
    if digest != expected.get("sha256") or size != expected.get("bytes"):
        raise RemoteWorkerError("A study array disagrees with its immutable descriptor")
    with source.open("rb") as incoming:
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
                outgoing.flush()
                os.fsync(outgoing.fileno())
        finally:
            os.close(descriptor)
    copied_digest, copied_size = _sha256_file_stable(destination, reject_symlink=True)
    if copied_digest != digest or copied_size != size:
        raise RemoteWorkerError("A copied study array failed publication verification")
    try:
        array = np.load(destination, allow_pickle=False, mmap_mode="r", max_header_size=16_384)
        if list(array.shape) != expected.get("shape") or str(array.dtype) != expected.get("dtype"):
            raise RemoteWorkerError("An exported array header disagrees with its descriptor")
    except (OSError, TypeError, ValueError) as exc:
        if isinstance(exc, RemoteWorkerError):
            raise
        raise RemoteWorkerError("An exported array is not a safe NPY artifact") from exc
    return {
        "sha256": copied_digest,
        "size_bytes": copied_size,
        "shape": expected["shape"],
        "dtype": expected["dtype"],
    }


def _task_record(
    request: _ValidatedRequest,
    task: RemoteTask,
    declared_source: RemoteSource,
    project: ResearchProject,
    result_id: str,
    publication_root: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    result = project.result(result_id)
    if project.review_state(result_id) is not None:
        raise RemoteWorkerError("Remote execution cannot publish a human review receipt")
    geometry = result["provenance"].get("geometry")
    if not isinstance(geometry, dict):
        raise RemoteWorkerError("Remote result is missing explicit geometry")
    geometry_sha256 = hashlib.sha256(canonical_json(geometry).encode()).hexdigest()
    relative_task = PurePosixPath("results", task.task_id)
    task_root = publication_root.joinpath(*relative_task.parts)
    arrays_root = task_root / "arrays"
    arrays_root.mkdir(parents=True, mode=0o700)
    arrays: dict[str, Any] = {}
    manifest_entries: list[dict[str, Any]] = []
    for name, descriptor in sorted(result["arrays"].items()):
        relative = relative_task / "arrays" / f"{name}.npy"
        copied = _copy_array(
            project.arrays / f"{descriptor['sha256']}.npy",
            publication_root.joinpath(*relative.parts),
            descriptor,
        )
        arrays[name] = {
            **copied,
            "path": str(relative),
            "geometry": geometry,
            "geometry_sha256": geometry_sha256,
        }
        manifest_entries.append(
            {
                "path": str(relative),
                "sha256": copied["sha256"],
                "size_bytes": copied["size_bytes"],
                "media_type": "application/x-npy",
            }
        )
    record = {
        "schema": "loci.remote-task-result/v1",
        "request_key": request.document["request_key"],
        "request_sha256": request.request_sha256,
        "project_id": request.document["project_id"],
        "task_id": task.task_id,
        "operation": task.operation,
        "source": {
            "source_id": declared_source.source_id,
            "sha256": declared_source.sha256,
            "size_bytes": declared_source.size_bytes,
        },
        "result": {
            "schema": result["schema"],
            "id": result["id"],
            "source_id": result["source_id"],
            "source_sha256": result["source_sha256"],
            "kind": result["kind"],
            "parent_id": result["parent_id"],
            "created_at": result["created_at"],
            "engine_version": result["engine_version"],
            "revision_hash": result["revision_hash"],
            "record_sha256": hashlib.sha256(canonical_json(result).encode()).hexdigest(),
            "arrays": arrays,
            "provenance": result["provenance"],
        },
        "review": {"state": "unreviewed", "receipt": None},
    }
    encoded = canonical_json(record).encode()
    relative_record = relative_task / "result.json"
    digest, size = _write_file(publication_root.joinpath(*relative_record.parts), encoded)
    manifest_entries.append(
        {
            "path": str(relative_record),
            "sha256": digest,
            "size_bytes": size,
            "media_type": "application/json",
        }
    )
    return record, manifest_entries


def _verify_publication(publication_root: Path, entries: list[dict[str, Any]]) -> None:
    for entry in entries:
        relative = entry["path"]
        path = _relative_source(publication_root, relative)
        digest, size = _sha256_file_stable(path, reject_symlink=True)
        if digest != entry["sha256"] or size != entry["size_bytes"]:
            raise RemoteWorkerError("A derived output changed before manifest publication")
        if entry["media_type"] == "application/json":
            record = _parse_json(
                _read_stable(path, maximum=MAX_MANIFEST_BYTES * 4, name="Task result record"),
                "Task result record",
                maximum=MAX_MANIFEST_BYTES * 4,
            )
            arrays = record.get("result", {}).get("arrays", {}) if isinstance(record, dict) else {}
            for descriptor in arrays.values():
                geometry = descriptor.get("geometry") if isinstance(descriptor, dict) else None
                if not isinstance(geometry, dict) or hashlib.sha256(
                    canonical_json(geometry).encode()
                ).hexdigest() != descriptor.get("geometry_sha256"):
                    raise RemoteWorkerError("An exported array geometry hash is invalid")


def _archive_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o600) << 16
    return info


def _archive_record(request: _ValidatedRequest, entries: list[dict[str, Any]]) -> dict[str, Any]:
    task_records = [
        {
            "task_id": PurePosixPath(entry["path"]).parts[1],
            "path": entry["path"],
            "schema": "loci.remote-task-result/v1",
            "review_state": "unreviewed",
        }
        for entry in entries
        if entry["media_type"] == "application/json"
    ]
    return {
        "schema": "loci.remote-results-archive/v1",
        "request_key": request.document["request_key"],
        "request_sha256": request.request_sha256,
        "project_id": request.document["project_id"],
        "review_state": "unreviewed",
        "task_results": task_records,
        "members": sorted(entries, key=lambda item: item["path"]),
    }


def _write_archive(
    destination: Path,
    publication_root: Path,
    request: _ValidatedRequest,
    entries: list[dict[str, Any]],
) -> tuple[str, int, dict[str, Any]]:
    if len(entries) > 50_000:
        raise RemoteWorkerError("Remote result archive has too many members")
    archive_record = _archive_record(request, entries)
    archive_record_bytes = canonical_json(archive_record).encode()
    descriptor = os.open(
        destination,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w+b", closefd=False) as stream:
            with zipfile.ZipFile(
                stream, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True
            ) as archive:
                for entry in sorted(entries, key=lambda item: item["path"]):
                    source = _relative_source(publication_root, entry["path"])
                    info = _archive_info(entry["path"])
                    with (
                        source.open("rb") as incoming,
                        archive.open(
                            info, mode="w", force_zip64=entry["size_bytes"] >= zipfile.ZIP64_LIMIT
                        ) as member,
                    ):
                        shutil.copyfileobj(incoming, member, length=1024 * 1024)
                archive.writestr(_archive_info("archive.json"), archive_record_bytes)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    digest, size = _sha256_file_stable(destination, reject_symlink=True)
    if size > MAX_STAGE_FILE_BYTES:
        raise RemoteWorkerError("Remote result archive exceeds the supported size")
    _verify_archive(destination, archive_record)
    return digest, size, archive_record


def _verify_archive(path: Path, expected_record: dict[str, Any]) -> None:
    expected_entries = {entry["path"]: entry for entry in expected_record["members"]}
    expected_names = {*expected_entries, "archive.json"}
    try:
        with zipfile.ZipFile(path, mode="r") as archive:
            infos = archive.infolist()
            if len(infos) != len(expected_names) or {info.filename for info in infos} != (
                expected_names
            ):
                raise RemoteWorkerError("Remote result archive members are incomplete")
            if len({info.filename for info in infos}) != len(infos):
                raise RemoteWorkerError("Remote result archive contains duplicate members")
            for info in infos:
                if (
                    info.is_dir()
                    or info.compress_type != zipfile.ZIP_STORED
                    or info.flag_bits & 0x1
                    or not stat.S_ISREG(info.external_attr >> 16)
                ):
                    raise RemoteWorkerError("Remote result archive member type is unsafe")
                with archive.open(info, mode="r") as member:
                    digest = hashlib.sha256()
                    size = 0
                    for block in iter(lambda: member.read(1024 * 1024), b""):
                        digest.update(block)
                        size += len(block)
                if info.filename == "archive.json":
                    if size > MAX_MANIFEST_BYTES * 4:
                        raise RemoteWorkerError("Remote archive metadata exceeds its bound")
                    with archive.open(info, mode="r") as member:
                        encoded_record = member.read(MAX_MANIFEST_BYTES * 4 + 1)
                    record = _parse_json(
                        encoded_record,
                        "Remote archive metadata",
                        maximum=MAX_MANIFEST_BYTES * 4,
                    )
                    if (
                        record != expected_record
                        or canonical_json(record).encode() != encoded_record
                    ):
                        raise RemoteWorkerError("Remote archive metadata identity is invalid")
                else:
                    expected = expected_entries[info.filename]
                    if (
                        size != expected["size_bytes"]
                        or info.file_size != expected["size_bytes"]
                        or info.compress_size != expected["size_bytes"]
                        or digest.hexdigest() != expected["sha256"]
                    ):
                        raise RemoteWorkerError("Remote archive member identity is invalid")
    except (OSError, zipfile.BadZipFile) as exc:
        raise RemoteWorkerError("Remote result archive is unreadable") from exc


def _tree_size_plain(root: Path) -> int:
    total = 0
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in directories:
            if (current_path / name).is_symlink():
                raise RemoteWorkerError("Remote scratch contains a linked directory")
        for name in files:
            path = current_path / name
            value = path.lstat()
            if not stat.S_ISREG(value.st_mode):
                raise RemoteWorkerError("Remote scratch contains a special file")
            total += value.st_size
    return total


def _reverify_request(original: _ValidatedRequest, request_path: Path) -> None:
    current = _load_request(request_path)
    if current.encoded != original.encoded or current.request_sha256 != original.request_sha256:
        raise RemoteWorkerError("Remote request changed before publication")


def _cellpose_result(
    workbench: Workbench,
    task: RemoteCellposeTask,
    registered_source_id: str,
) -> str:
    """Run one exact, preprovisioned Cellpose task and publish no fallback by surprise."""

    from .cellpose_backend import (
        CELLPOSE_PACKAGE_VERSION,
        get_cellpose_status,
        resolve_cellpose_model_spec,
        segment_cellpose,
    )
    from .models import CellposeSettings
    from .quantitative import DEFAULT_WORKING_BYTES, apply_marker_gates, measure_objects
    from .workbench import runtime_record

    cellpose = task.cellpose
    source_working_bytes = min(cellpose["working_bytes"], DEFAULT_WORKING_BYTES)
    settings = CellposeSettings(**cellpose["settings"])
    settings.validate()
    status = get_cellpose_status(cellpose["profile_id"])
    spec = resolve_cellpose_model_spec(cellpose["profile_id"])
    if (
        not status.ready
        or status.installed_version != CELLPOSE_PACKAGE_VERSION
        or not status.model_verified
        or status.model_spec != spec
        or cellpose["package_version"] != CELLPOSE_PACKAGE_VERSION
        or cellpose["artifact_id"] != spec.artifact_id
        or cellpose["model_sha256"] != spec.sha256
        or cellpose["model_size_bytes"] != spec.size_bytes
    ):
        raise RemoteWorkerError(
            "The provisioned Cellpose runtime or checkpoint differs from the exact task identity"
        )
    try:
        image, geometry, selected = workbench.load_scalar(
            registered_source_id,
            task.selection,
            working_bytes=source_working_bytes,
            allow_rgb=True,
        )
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise RemoteWorkerError("Remote Cellpose selection could not be loaded") from exc
    if image.ndim not in {2, 3} or (image.ndim == 3 and image.shape[-1] not in {1, 3, 4}):
        raise RemoteWorkerError("Remote Cellpose requires one 2D scalar or interleaved RGB plane")
    try:
        inference = segment_cellpose(image, settings, cellpose["profile_id"])
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise RemoteWorkerError("Remote Cellpose inference failed") from exc
    inference_runtime = inference.runtime
    if (
        inference_runtime.get("package")
        != {"name": "cellpose", "version": cellpose["package_version"]}
        or inference_runtime.get("model")
        != {"artifact_id": cellpose["artifact_id"], "sha256": cellpose["model_sha256"]}
        or inference_runtime.get("profile_id") != cellpose["profile_id"]
        or inference_runtime.get("requested_device") != cellpose["requested_device"]
    ):
        raise RemoteWorkerError("Cellpose inference runtime disagrees with its exact request")
    resolved_device = inference_runtime.get("resolved_device")
    fallback_reason = inference_runtime.get("fallback_reason")
    if resolved_device not in {"cpu", "cuda"}:
        raise RemoteWorkerError("Cellpose resolved to an unsupported remote device")
    if not cellpose["allow_cpu_fallback"] and (
        resolved_device != cellpose["requested_device"] or fallback_reason is not None
    ):
        raise RemoteWorkerError("Cellpose used a CPU fallback that this task did not authorize")

    labels = np.asarray(inference.output.labels, dtype=np.uint32)
    normalized = np.asarray(inference.output.normalized, dtype=np.float64)
    positive_ids = np.unique(labels)
    positive_ids = positive_ids[positive_ids != 0]
    if (
        labels.ndim != 2
        or normalized.shape != labels.shape
        or not np.isfinite(normalized).all()
        or not np.array_equal(positive_ids, np.arange(1, len(positive_ids) + 1))
        or int(inference.output.count) != len(positive_ids)
    ):
        raise RemoteWorkerError("Cellpose output does not match the selected 2D source grid")
    declarations = workbench.channel_metadata(registered_source_id)
    channels: dict[str, np.ndarray] = {}
    names = [item["name"] for item in declarations["channels"]]
    for channel in cellpose["measurement_channels"]:
        try:
            raw, raw_geometry, raw_selection = workbench.load_scalar(
                registered_source_id,
                {**selected, "c": channel},
                strict=False,
                working_bytes=source_working_bytes,
            )
            name = names[channel]
        except (IndexError, OSError, RuntimeError, TypeError, ValueError) as exc:
            raise RemoteWorkerError(
                "A requested Cellpose measurement channel is unavailable or ambiguous"
            ) from exc
        if raw.ndim != 2 or raw.shape != labels.shape or raw_geometry != geometry:
            raise RemoteWorkerError("A Cellpose measurement channel disagrees with the label grid")
        if raw_selection != {**selected, "c": channel}:
            raise RemoteWorkerError("A Cellpose measurement selection was not resolved exactly")
        channels[f"{channel + 1}: {name}"] = raw
    try:
        measurements = apply_marker_gates(
            measure_objects(
                labels,
                geometry,
                channels,
                working_bytes=cellpose["working_bytes"],
            ),
            cellpose["gates"],
        )
    except (IndexError, TypeError, ValueError) as exc:
        raise RemoteWorkerError("Cellpose measurements could not be constructed") from exc

    try:
        import torch

        torch_version = str(torch.__version__)
        cuda_runtime = str(torch.version.cuda) if torch.version.cuda is not None else None
        cudnn_version = torch.backends.cudnn.version()
    except (AttributeError, ImportError, RuntimeError) as exc:
        raise RemoteWorkerError("The exact Cellpose Torch runtime identity is unavailable") from exc
    segmentation = {
        "method": "cellpose",
        "dimensions": 2,
        "count": int(inference.output.count),
        "scientific_validation": "unvalidated-research-method",
    }
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selected,
        "cellpose": cellpose,
        "segmentation": segmentation,
        "measurements": measurements,
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "channel_metadata": declarations,
        "runtime": {
            "engine": runtime_record(),
            "cellpose": inference_runtime,
            "python_version": platform.python_version(),
            "torch_version": torch_version,
            "cuda_runtime": cuda_runtime,
            "cudnn_version": cudnn_version,
        },
        "estimated_working_bytes": cellpose["working_bytes"],
        "rights": {
            "basis": cellpose["rights_basis"],
            "model_redistribution": "not-included-in-publication",
            "validation": "operator-declared; not independently verified by Loci",
        },
    }
    result = workbench.project.save_result(
        source_id=registered_source_id,
        kind="cellpose-segmentation",
        arrays={"image": normalized, "labels": labels},
        provenance=provenance,
    )
    return result["id"]


def _task_working_bytes(task: RemoteTask) -> int:
    return (
        task.recipe["working_bytes"]
        if isinstance(task, RemoteRecipeTask)
        else task.cellpose["working_bytes"]
    )


def run_manifest(path: str | Path) -> dict[str, Any]:
    """Execute one canonical, marker-bound request and atomically publish its manifest."""

    request_path = Path(path)
    request = _load_request(request_path)
    source_paths = _verify_sources(request)
    final_archive = request.output_root / "results.zip"
    final_manifest = request.output_root / "output-manifest.json"
    for target in (final_archive, final_manifest):
        if target.exists() or target.is_symlink():
            raise RemoteWorkerError("Remote output publication already exists")
    scratch_parent = None if os.name == "nt" else "/tmp"
    scratch_root = Path(
        tempfile.mkdtemp(prefix="loci-remote-worker-", dir=scratch_parent)
    ).resolve(strict=True)
    study_path = scratch_root / ".loci-study"
    publication_root = scratch_root / "publication"
    publication_root.mkdir(mode=0o700)
    project: ResearchProject | None = None
    workbench: Workbench | None = None
    entries: list[dict[str, Any]] = []
    source_by_id = {source.source_id: source for source in request.sources}
    registered: dict[str, str] = {}
    temporary_archive: Path | None = None
    temporary_manifest: Path | None = None
    try:
        project = ResearchProject.create(
            study_path,
            f"Remote {request.document['project_id']} request {request.document['request_key']}",
        )
        workbench = Workbench(project)
        for source in request.sources:
            receipt = workbench.import_native(
                str(source_paths[source.source_id]), name=source.source_id
            )
            if receipt["sha256"] != source.sha256 or receipt["size_bytes"] != source.size_bytes:
                raise RemoteWorkerError("Workbench import changed the declared source identity")
            registered[source.source_id] = receipt["id"]
        for task in request.tasks:
            if task.channel_declarations is not None:
                declared = workbench.channel_metadata(registered[task.source_id])
                if declared["channels"] != task.channel_declarations:
                    workbench.execute(
                        "channels",
                        {
                            "source_id": registered[task.source_id],
                            "channels": task.channel_declarations,
                            "expected_revision": declared["revision"],
                        },
                    )
            if isinstance(task, RemoteRecipeTask):
                executed = workbench.execute(
                    "run_recipe",
                    {
                        "source_id": registered[task.source_id],
                        "selection": task.selection,
                        "recipe": task.recipe,
                    },
                )
                result_id = executed.get("result", {}).get("id")
            else:
                result_id = _cellpose_result(workbench, task, registered[task.source_id])
            if not _is_hex(result_id, 32):
                raise RemoteWorkerError("Workbench returned an invalid result identity")
            _, task_entries = _task_record(
                request,
                task,
                source_by_id[task.source_id],
                project,
                result_id,
                publication_root,
            )
            entries.extend(task_entries)
        workbench.close()
        workbench = None
        _verify_sources(request)
        _reverify_request(request, request_path)
        _verify_publication(publication_root, entries)
        scratch_limit = sum(_task_working_bytes(task) for task in request.tasks)
        if _tree_size_plain(scratch_root) > scratch_limit + MAX_MANIFEST_BYTES * 4:
            raise RemoteWorkerError("Remote scratch artifacts exceed declared task budgets")
        temporary_archive = request.output_root / f".results-{secrets.token_hex(16)}.zip"
        archive_sha256, archive_size, _ = _write_archive(
            temporary_archive, publication_root, request, entries
        )
        _reverify_request(request, request_path)
        _verify_sources(request)
        _publish_file_noreplace(temporary_archive, final_archive)
        published_sha256, published_size = _sha256_file_stable(final_archive, reject_symlink=True)
        if published_sha256 != archive_sha256 or published_size != archive_size:
            raise RemoteWorkerError("Published remote result archive changed")
        manifest = {
            "schema": "loci.remote-output/v1",
            "request_key": request.document["request_key"],
            "request_sha256": request.request_sha256,
            "outputs": [
                {
                    "path": "results.zip",
                    "sha256": archive_sha256,
                    "size_bytes": archive_size,
                    "media_type": "application/zip",
                }
            ],
        }
        encoded_manifest = json.dumps(
            manifest, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
        if len(encoded_manifest) > MAX_OUTPUT_MANIFEST_BYTES:
            raise RemoteWorkerError("Remote output manifest exceeds the supported size")
        temporary_manifest = request.output_root / f".output-manifest-{secrets.token_hex(16)}.json"
        _write_file(temporary_manifest, encoded_manifest)
        _reverify_request(request, request_path)
        current_archive_sha256, current_archive_size = _sha256_file_stable(
            final_archive, reject_symlink=True
        )
        if current_archive_sha256 != archive_sha256 or current_archive_size != archive_size:
            raise RemoteWorkerError("Remote result archive changed before manifest publication")
        _publish_file_noreplace(temporary_manifest, final_manifest)
        _fsync_directory(request.output_root)
        return manifest
    finally:
        if workbench is not None:
            workbench.close()
        for temporary in (temporary_archive, temporary_manifest):
            if temporary is not None:
                with suppress(FileNotFoundError):
                    temporary.unlink()
        with suppress(OSError):
            shutil.rmtree(scratch_root)
