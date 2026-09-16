"""Strict SSH adapters for manifested Loci research work.

The public API exposes fixed lifecycle operations, never a generic remote-shell
method.  OpenSSH remains the transport authority and uses the user's explicit
known-hosts file with strict host-key checking.  Scheduler and remote helper
commands are constructed only from validated typed values.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol, TypeAlias

MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_MANIFEST_BYTES = MAX_COMMAND_OUTPUT_BYTES
MAX_STAGE_FILE_BYTES = 512 * 1024 * 1024 * 1024

_ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_HOST_LOOKUP = re.compile(r"^(?:[A-Za-z0-9._-]+|\[[A-Za-z0-9:._-]+\]:[1-9][0-9]{0,4})$")
_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_REQUEST_KEY = re.compile(r"^[a-f0-9]{32}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_HOST_FINGERPRINT = re.compile(r"^SHA256:[A-Za-z0-9+/]{20,100}={0,2}$")
_JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,127}$")
_MEDIA_TYPE = re.compile(r"^[a-z][a-z0-9.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$")
_REMOTE_PATH = re.compile(r"^/[A-Za-z0-9._/-]+$")
_RELATIVE_PATH = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")

Scheduler = Literal["direct", "pbs", "pbspro", "slurm"]
JobState = Literal["reserved", "submitted", "queued", "running", "finished", "failed", "unknown"]


class RemoteComputeError(RuntimeError):
    """Raised when a remote operation fails or returns untrusted data."""


@dataclass(frozen=True, slots=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class CommandRunner(Protocol):
    def run(
        self,
        arguments: Sequence[str],
        *,
        input_bytes: bytes | None = None,
        timeout_seconds: int = 30,
        output_limit: int = MAX_COMMAND_OUTPUT_BYTES,
    ) -> CommandResult: ...


class SubprocessRunner:
    """Run argument vectors without a local shell and with bounded captured output."""

    def run(
        self,
        arguments: Sequence[str],
        *,
        input_bytes: bytes | None = None,
        timeout_seconds: int = 30,
        output_limit: int = MAX_COMMAND_OUTPUT_BYTES,
    ) -> CommandResult:
        if not arguments:
            raise RemoteComputeError("A command argument vector cannot be empty.")
        if not 1 <= output_limit <= MAX_COMMAND_OUTPUT_BYTES:
            raise RemoteComputeError("Command output limit is outside the supported range.")
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                completed = subprocess.run(
                    list(arguments),
                    input=input_bytes,
                    stdout=stdout,
                    stderr=stderr,
                    check=False,
                    timeout=timeout_seconds,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise RemoteComputeError(f"Command transport failed: {arguments[0]}") from exc
            stdout.seek(0)
            stderr.seek(0)
            out = stdout.read(output_limit + 1)
            err = stderr.read(output_limit + 1)
        if len(out) > output_limit or len(err) > output_limit:
            raise RemoteComputeError("A command returned more output than its bounded limit.")
        return CommandResult(
            completed.returncode,
            out.decode("utf-8", errors="replace"),
            err.decode("utf-8", errors="replace"),
        )


def _plain_absolute_path(value: str | Path, name: str) -> str:
    text = str(value)
    if not _REMOTE_PATH.fullmatch(text):
        raise ValueError(f"{name} must be a conservative absolute POSIX path")
    path = PurePosixPath(text)
    if (
        str(path) != text
        or any(part in {"", ".", ".."} for part in path.parts[1:])
        or len(path.parts) < 4
    ):
        raise ValueError(f"{name} must identify a specific directory below a user root")
    return str(path)


def _relative_path(value: str, name: str) -> str:
    if not _RELATIVE_PATH.fullmatch(value):
        raise ValueError(f"{name} must be a conservative relative path")
    path = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"{name} cannot contain empty, current, or parent components")
    return str(path)


def _sha(value: str, name: str) -> str:
    if not _SHA256.fullmatch(value):
        raise ValueError(f"{name} must be a lowercase SHA-256")
    return value


def _token(value: str, name: str) -> str:
    if not _TOKEN.fullmatch(value):
        raise ValueError(f"{name} contains unsupported characters")
    return value


@dataclass(frozen=True, slots=True)
class ConnectionProfile:
    alias: str
    known_host: str
    known_hosts_file: Path
    host_key_sha256: str
    runtime_python: str
    remote_project_root: str
    remote_output_root: str
    scheduler: Scheduler
    scheduler_bin_dir: str | None = None
    identity_file: Path | None = None
    queue: str | None = None
    account: str | None = None
    pbs_gpu_resource: str | None = None
    allow_direct_compute: bool = False
    remote_input_roots: tuple[str, ...] = ()
    connect_timeout_seconds: int = 10

    def validate(self) -> None:
        if not _ALIAS.fullmatch(self.alias):
            raise ValueError("SSH alias contains unsupported characters")
        if not _HOST_LOOKUP.fullmatch(self.known_host):
            raise ValueError("known_host must be an exact known_hosts lookup name")
        if not self.known_hosts_file.is_absolute() or not self.known_hosts_file.is_file():
            raise ValueError("known_hosts_file must be an existing absolute plain file")
        if self.known_hosts_file.is_symlink():
            raise ValueError("known_hosts_file cannot be a symlink")
        if not _HOST_FINGERPRINT.fullmatch(self.host_key_sha256):
            raise ValueError("host_key_sha256 must be an OpenSSH SHA256 fingerprint")
        _plain_absolute_path(self.runtime_python, "runtime_python")
        project = _plain_absolute_path(self.remote_project_root, "remote_project_root")
        output = _plain_absolute_path(self.remote_output_root, "remote_output_root")
        if (
            project == output
            or PurePosixPath(project).is_relative_to(PurePosixPath(output))
            or (PurePosixPath(output).is_relative_to(PurePosixPath(project)))
        ):
            raise ValueError("Remote project and output roots must be separate trees")
        if self.scheduler not in {"direct", "pbs", "pbspro", "slurm"}:
            raise ValueError("Unsupported remote scheduler")
        if self.scheduler_bin_dir is not None:
            _plain_absolute_path(self.scheduler_bin_dir, "scheduler_bin_dir")
        if self.identity_file is not None and (
            not self.identity_file.is_absolute() or not self.identity_file.is_file()
        ):
            raise ValueError("identity_file must be an existing absolute file")
        for value, name in ((self.queue, "queue"), (self.account, "account")):
            if value is not None:
                _token(value, name)
        if self.pbs_gpu_resource is not None:
            _token(self.pbs_gpu_resource, "pbs_gpu_resource")
        if not isinstance(self.allow_direct_compute, bool):
            raise ValueError("allow_direct_compute must be boolean")
        if self.scheduler != "direct" and self.allow_direct_compute:
            raise ValueError("allow_direct_compute is valid only for a direct profile")
        if self.scheduler == "direct" and any(
            value is not None
            for value in (self.scheduler_bin_dir, self.queue, self.account, self.pbs_gpu_resource)
        ):
            raise ValueError("A direct profile cannot declare batch-scheduler fields")
        if (
            not isinstance(self.remote_input_roots, tuple)
            or len(self.remote_input_roots) > 16
            or any(not isinstance(value, str) for value in self.remote_input_roots)
        ):
            raise ValueError("remote_input_roots must be a tuple of at most 16 paths")
        resolved_inputs = [
            _plain_absolute_path(value, "remote_input_root")
            for value in self.remote_input_roots
        ]
        if len(set(resolved_inputs)) != len(resolved_inputs):
            raise ValueError("remote_input_roots must be unique")
        for index, remote_input in enumerate(resolved_inputs):
            input_path = PurePosixPath(remote_input)
            for other in map(PurePosixPath, resolved_inputs[index + 1 :]):
                if input_path.is_relative_to(other) or other.is_relative_to(input_path):
                    raise ValueError("Remote input roots must be separate trees")
            for managed in (PurePosixPath(project), PurePosixPath(output)):
                if input_path == managed or input_path.is_relative_to(
                    managed
                ) or managed.is_relative_to(input_path):
                    raise ValueError("Remote input roots must be separate from managed run roots")
        if not 1 <= self.connect_timeout_seconds <= 60:
            raise ValueError("connect_timeout_seconds must be between 1 and 60")

    def binary(self, name: str) -> str:
        _token(name, "scheduler command")
        return f"{self.scheduler_bin_dir}/{name}" if self.scheduler_bin_dir else name

    def run_root(self, request_key: str) -> str:
        if not _REQUEST_KEY.fullmatch(request_key):
            raise ValueError("request_key must contain 32 lowercase hexadecimal characters")
        return f"{self.remote_project_root}/.loci-runs/{request_key}"

    def output_root(self, request_key: str) -> str:
        if not _REQUEST_KEY.fullmatch(request_key):
            raise ValueError("request_key must contain 32 lowercase hexadecimal characters")
        return f"{self.remote_output_root}/.loci-runs/{request_key}"

    def cleanup_receipt_path(self, request_key: str) -> str:
        if not _REQUEST_KEY.fullmatch(request_key):
            raise ValueError("request_key must contain 32 lowercase hexadecimal characters")
        return f"{self.remote_project_root}/.loci-cleanups/{request_key}.json"


@dataclass(frozen=True, slots=True)
class ResourceRequest:
    cpus: int = 1
    memory_mb: int = 4096
    wall_minutes: int = 30
    gpus: int = 0

    def validate(self) -> None:
        for name, value, lower, upper in (
            ("cpus", self.cpus, 1, 256),
            ("memory_mb", self.memory_mb, 256, 2_097_152),
            ("wall_minutes", self.wall_minutes, 1, 7 * 24 * 60),
            ("gpus", self.gpus, 0, 16),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
                raise ValueError(f"{name} must be an integer between {lower} and {upper}")

    @property
    def walltime(self) -> str:
        hours, minutes = divmod(self.wall_minutes, 60)
        return f"{hours:02d}:{minutes:02d}:00"


@dataclass(frozen=True, slots=True)
class RemoteRequest:
    request_key: str
    request_sha256: str
    project_id: str
    resources: ResourceRequest

    def validate(self) -> None:
        if not _REQUEST_KEY.fullmatch(self.request_key):
            raise ValueError("request_key must contain 32 lowercase hexadecimal characters")
        _sha(self.request_sha256, "request_sha256")
        if not _REQUEST_KEY.fullmatch(self.project_id):
            raise ValueError("project_id must contain 32 lowercase hexadecimal characters")
        self.resources.validate()


@dataclass(frozen=True, slots=True)
class StageEntry:
    local_path: Path
    remote_relative_path: str
    sha256: str
    size_bytes: int

    def validate(self) -> None:
        _relative_path(self.remote_relative_path, "remote_relative_path")
        _sha(self.sha256, "staged file SHA-256")
        if (
            not self.local_path.is_absolute()
            or self.local_path.is_symlink()
            or (not self.local_path.is_file())
        ):
            raise ValueError("Staged input must be an absolute plain local file")
        if not 0 <= self.size_bytes <= MAX_STAGE_FILE_BYTES:
            raise ValueError("Staged file size is outside the supported range")


@dataclass(frozen=True, slots=True)
class StagingManifest:
    request_key: str
    request_sha256: str
    entries: tuple[StageEntry, ...]

    def validate(self) -> None:
        if not _REQUEST_KEY.fullmatch(self.request_key):
            raise ValueError("Invalid staging request key")
        _sha(self.request_sha256, "request_sha256")
        names: set[str] = set()
        for entry in self.entries:
            entry.validate()
            if entry.remote_relative_path in names:
                raise ValueError("Staging manifest contains duplicate destination paths")
            names.add(entry.remote_relative_path)

    def encoded(self) -> bytes:
        self.validate()
        document = {
            "schema": "loci.remote-staging/v1",
            "request_key": self.request_key,
            "request_sha256": self.request_sha256,
            "entries": [
                {
                    "path": entry.remote_relative_path,
                    "sha256": entry.sha256,
                    "size_bytes": entry.size_bytes,
                }
                for entry in self.entries
            ],
        }
        encoded = json.dumps(
            document, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
        if len(encoded) > MAX_MANIFEST_BYTES:
            raise ValueError("Staging manifest exceeds the supported size")
        return encoded


@dataclass(frozen=True, slots=True)
class RemoteSource:
    source_id: str
    relative_path: str
    sha256: str
    size_bytes: int
    permitted_root: str | None = None

    def validate(self) -> None:
        if not _REQUEST_KEY.fullmatch(self.source_id):
            raise ValueError("Remote source_id must contain 32 lowercase hexadecimal characters")
        _relative_path(self.relative_path, "remote source path")
        if self.permitted_root is not None:
            _plain_absolute_path(self.permitted_root, "remote source permitted_root")
        _sha(self.sha256, "remote source SHA-256")
        if (
            isinstance(self.size_bytes, bool)
            or not isinstance(self.size_bytes, int)
            or not 0 <= self.size_bytes <= MAX_STAGE_FILE_BYTES
        ):
            raise ValueError("Remote source size is outside the supported range")

    @property
    def location_key(self) -> tuple[str | None, str]:
        return self.permitted_root, self.relative_path


@dataclass(frozen=True, slots=True)
class RemoteRecipeTask:
    task_id: str
    source_id: str
    selection: dict[str, Any]
    recipe: dict[str, Any]
    operation: Literal["run_recipe"] = "run_recipe"
    channel_declarations: list[dict[str, Any]] | None = None

    def validate(self) -> None:
        if not _REQUEST_KEY.fullmatch(self.task_id):
            raise ValueError("Remote task_id must contain 32 lowercase hexadecimal characters")
        if not _REQUEST_KEY.fullmatch(self.source_id):
            raise ValueError("Remote task source_id is invalid")
        if self.operation != "run_recipe":
            raise ValueError("The remote worker accepts only the run_recipe operation")
        required = {"x", "y", "width", "height", "t", "c", "z", "level"}
        allowed = required | {"z_stop"}
        if (
            not isinstance(self.selection, dict)
            or not required <= set(self.selection)
            or (set(self.selection) - allowed)
        ):
            raise ValueError("Remote task selection fields are incomplete or unsupported")
        for name in required:
            value = self.selection[name]
            minimum = 1 if name in {"width", "height"} else 0
            if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
                raise ValueError(f"Remote selection {name} is invalid")
        z_stop = self.selection.get("z_stop")
        if z_stop is not None and (
            isinstance(z_stop, bool) or not isinstance(z_stop, int) or z_stop <= self.selection["z"]
        ):
            raise ValueError("Remote selection z_stop must be greater than z")
        recipe_fields = {
            "steps",
            "segmentation",
            "measurement_channels",
            "gates",
            "working_bytes",
        }
        if not isinstance(self.recipe, dict) or set(self.recipe) != recipe_fields:
            raise ValueError("Remote recipe must use the shared run_recipe fields")
        working = self.recipe["working_bytes"]
        if (
            isinstance(working, bool)
            or not isinstance(working, int)
            or not 1 <= working <= 2 * 1024**3
        ):
            raise ValueError("Remote recipe working_bytes is outside the supported range")
        if not isinstance(self.recipe["steps"], list) or len(self.recipe["steps"]) > 100:
            raise ValueError("Remote recipe steps must be a bounded list")
        segmentation = self.recipe["segmentation"]
        if not isinstance(segmentation, dict) or segmentation.get("method") not in {
            "components",
            "watershed",
        }:
            raise ValueError("Remote segmentation method is unsupported")
        channels = self.recipe["measurement_channels"]
        if (
            not isinstance(channels, list)
            or len(channels) > 256
            or any(
                isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in channels
            )
        ):
            raise ValueError("Remote measurement_channels are invalid")
        _validate_json_value(self.recipe, "remote recipe")
        if self.channel_declarations is not None:
            from .research_channels import validate_declarations

            validate_declarations(self.channel_declarations, len(self.channel_declarations))


REMOTE_CELLPOSE_RIGHTS_BASES = frozenset(
    {"noncommercial-research", "written-commercial-clearance"}
)


@dataclass(frozen=True, slots=True)
class RemoteCellposeTask:
    """Path-free, exact-identity Cellpose task for a provisioned remote runtime."""

    task_id: str
    source_id: str
    selection: dict[str, Any]
    cellpose: dict[str, Any]
    operation: Literal["run_cellpose"] = "run_cellpose"
    channel_declarations: list[dict[str, Any]] | None = None

    def validate(self) -> None:
        if not _REQUEST_KEY.fullmatch(self.task_id):
            raise ValueError("Remote task_id must contain 32 lowercase hexadecimal characters")
        if not _REQUEST_KEY.fullmatch(self.source_id):
            raise ValueError("Remote task source_id is invalid")
        if self.operation != "run_cellpose":
            raise ValueError("A remote Cellpose task requires the run_cellpose operation")
        required_selection = {"x", "y", "width", "height", "t", "c", "z", "level"}
        if not isinstance(self.selection, dict) or set(self.selection) != required_selection:
            raise ValueError("Remote Cellpose selection must identify exactly one 2D plane")
        for name in required_selection:
            value = self.selection[name]
            minimum = 1 if name in {"width", "height"} else 0
            if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
                raise ValueError(f"Remote selection {name} is invalid")

        fields = {
            "profile_id",
            "package_version",
            "artifact_id",
            "model_sha256",
            "model_size_bytes",
            "requested_device",
            "allow_cpu_fallback",
            "rights_basis",
            "settings",
            "measurement_channels",
            "gates",
            "working_bytes",
        }
        if not isinstance(self.cellpose, dict) or set(self.cellpose) != fields:
            raise ValueError("Remote Cellpose task has incomplete or unsupported fields")
        from dataclasses import asdict

        from .cellpose_backend import CELLPOSE_PACKAGE_VERSION, resolve_cellpose_model_spec
        from .models import CellposeSettings

        try:
            spec = resolve_cellpose_model_spec(self.cellpose["profile_id"])
        except (TypeError, ValueError) as exc:
            raise ValueError("Remote Cellpose profile is unsupported") from exc
        if (
            self.cellpose["package_version"] != CELLPOSE_PACKAGE_VERSION
            or self.cellpose["artifact_id"] != spec.artifact_id
            or self.cellpose["model_sha256"] != spec.sha256
            or self.cellpose["model_size_bytes"] != spec.size_bytes
        ):
            raise ValueError("Remote Cellpose runtime/model identity is not the pinned profile")
        requested_device = self.cellpose["requested_device"]
        if requested_device not in {"cpu", "cuda"}:
            raise ValueError("Remote Cellpose requested_device must be cpu or cuda")
        if not isinstance(self.cellpose["allow_cpu_fallback"], bool):
            raise ValueError("Remote Cellpose allow_cpu_fallback must be boolean")
        if self.cellpose["rights_basis"] not in REMOTE_CELLPOSE_RIGHTS_BASES:
            raise ValueError("Remote Cellpose rights_basis is unsupported")
        settings_value = self.cellpose["settings"]
        if not isinstance(settings_value, dict) or set(settings_value) != set(
            asdict(CellposeSettings())
        ):
            raise ValueError("Remote Cellpose settings must use the exact pinned settings schema")
        try:
            settings = CellposeSettings(**settings_value)
            settings.validate()
        except (TypeError, ValueError) as exc:
            raise ValueError("Remote Cellpose settings are invalid") from exc
        if settings.device != requested_device:
            raise ValueError("Remote Cellpose settings.device must match requested_device")
        working = self.cellpose["working_bytes"]
        if (
            isinstance(working, bool)
            or not isinstance(working, int)
            or not 1 <= working <= 2 * 1024**3
        ):
            raise ValueError("Remote Cellpose working_bytes is outside the supported range")
        channels = self.cellpose["measurement_channels"]
        if (
            not isinstance(channels, list)
            or len(channels) > 256
            or any(
                isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in channels
            )
        ):
            raise ValueError("Remote Cellpose measurement_channels are invalid")
        if not isinstance(self.cellpose["gates"], list) or len(self.cellpose["gates"]) > 256:
            raise ValueError("Remote Cellpose gates must be a bounded list")
        _validate_json_value(self.cellpose, "remote Cellpose task")
        if self.channel_declarations is not None:
            from .research_channels import validate_declarations

            validate_declarations(self.channel_declarations, len(self.channel_declarations))


RemoteTask: TypeAlias = RemoteRecipeTask | RemoteCellposeTask


@dataclass(frozen=True, slots=True)
class RemoteWorkerRequest:
    """Exact canonical request consumed by ``research_cli remote-worker``."""

    request_key: str
    project_id: str
    resources: ResourceRequest
    sources: tuple[RemoteSource, ...]
    tasks: tuple[RemoteTask, ...]

    def encode(self, profile: ConnectionProfile) -> tuple[RemoteRequest, bytes]:
        if not _REQUEST_KEY.fullmatch(self.request_key):
            raise ValueError("Worker request_key must contain 32 lowercase hexadecimal characters")
        if not _REQUEST_KEY.fullmatch(self.project_id):
            raise ValueError("Worker project_id must contain 32 lowercase hexadecimal characters")
        self.resources.validate()
        if not self.sources or len(self.sources) > 10_000:
            raise ValueError("A remote worker request requires a bounded non-empty source list")
        if not self.tasks or len(self.tasks) > 10_000:
            raise ValueError("A remote worker request requires a bounded non-empty task list")
        source_ids: set[str] = set()
        source_paths: set[tuple[str | None, str]] = set()
        for source in self.sources:
            source.validate()
            if source.source_id in source_ids or source.location_key in source_paths:
                raise ValueError("Remote worker sources contain a duplicate identity or path")
            source_ids.add(source.source_id)
            source_paths.add(source.location_key)
        task_ids: set[str] = set()
        for task in self.tasks:
            task.validate()
            if task.task_id in task_ids:
                raise ValueError("Remote worker tasks contain duplicate identities")
            if task.source_id not in source_ids:
                raise ValueError("Remote worker task references an undeclared source")
            task_ids.add(task.task_id)
        cuda_tasks = [
            task
            for task in self.tasks
            if isinstance(task, RemoteCellposeTask)
            and task.cellpose["requested_device"] == "cuda"
        ]
        if cuda_tasks and self.resources.gpus < 1:
            raise ValueError("A CUDA Cellpose task requires at least one requested GPU")
        if self.resources.gpus and not cuda_tasks:
            raise ValueError("GPU resources require at least one CUDA Cellpose task")
        schema = (
            "loci.remote-worker-request/v2"
            if any(isinstance(task, RemoteCellposeTask) for task in self.tasks)
            else "loci.remote-worker-request/v1"
        )
        document = {
            "schema": schema,
            "request_key": self.request_key,
            "project_id": self.project_id,
            "output_root": profile.output_root(self.request_key),
            "resources": {
                "cpus": self.resources.cpus,
                "memory_mb": self.resources.memory_mb,
                "wall_minutes": self.resources.wall_minutes,
                "gpus": self.resources.gpus,
            },
            "sources": [
                {
                    "source_id": source.source_id,
                    "path": source.relative_path,
                    "sha256": source.sha256,
                    "size_bytes": source.size_bytes,
                    **(
                        {"permitted_root": source.permitted_root}
                        if source.permitted_root is not None
                        else {}
                    ),
                }
                for source in self.sources
            ],
            "tasks": [
                {
                    "task_id": task.task_id,
                    "operation": task.operation,
                    "source_id": task.source_id,
                    "selection": task.selection,
                    **(
                        {"recipe": task.recipe}
                        if isinstance(task, RemoteRecipeTask)
                        else {"cellpose": task.cellpose}
                    ),
                    **(
                        {"channel_declarations": task.channel_declarations}
                        if task.channel_declarations is not None
                        else {}
                    ),
                }
                for task in self.tasks
            ],
        }
        encoded = json.dumps(
            document, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
        if len(encoded) > MAX_MANIFEST_BYTES:
            raise ValueError("Remote worker request exceeds the supported size")
        request = RemoteRequest(
            self.request_key,
            hashlib.sha256(encoded).hexdigest(),
            self.project_id,
            self.resources,
        )
        return request, encoded


@dataclass(frozen=True, slots=True)
class ConnectionReceipt:
    alias: str
    host_key_sha256: str
    operating_system: str
    runtime_version: str
    scheduler: Scheduler
    scheduler_version: str | None


@dataclass(frozen=True, slots=True)
class RemoteJobIdentity:
    request_key: str
    request_sha256: str
    scheduler: Scheduler
    remote_job_id: str | None
    state: JobState


@dataclass(frozen=True, slots=True)
class RemoteJobStatus:
    identity: RemoteJobIdentity
    state: JobState
    detail: str


@dataclass(frozen=True, slots=True)
class RemoteCleanupReceipt:
    request_key: str
    request_sha256: str
    scheduler: Scheduler
    remote_job_id: str
    owned_run_roots: int
    state: Literal["cleaned"]


@dataclass(frozen=True, slots=True)
class OutputEntry:
    relative_path: str
    sha256: str
    size_bytes: int
    media_type: str


@dataclass(frozen=True, slots=True)
class VerifiedOutputManifest:
    request_key: str
    request_sha256: str
    entries: tuple[OutputEntry, ...]


def _hash_file(path: Path) -> tuple[str, int]:
    try:
        before_path = path.lstat()
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as exc:
        raise RemoteComputeError("A staged source is no longer a plain file") from exc
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or (before.st_dev, before.st_ino) != (before_path.st_dev, before_path.st_ino)
            or before.st_size > MAX_STAGE_FILE_BYTES
        ):
            raise RemoteComputeError("A staged source is no longer a supported plain file")
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            after = os.fstat(stream.fileno())
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    try:
        after_path = path.lstat()
    except OSError as exc:
        raise RemoteComputeError("A staged source changed while it was hashed") from exc
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    path_identity = (after_path.st_dev, after_path.st_ino)
    if identity_before != identity_after or path_identity != (after.st_dev, after.st_ino):
        raise RemoteComputeError("A staged source changed while it was hashed")
    return digest.hexdigest(), int(after.st_size)


def _validate_json_value(value: Any, name: str, *, depth: int = 0) -> None:
    if depth > 24:
        raise ValueError(f"{name} is nested too deeply")
    if value is None or isinstance(value, (str, bool, int)):
        if isinstance(value, str) and (
            len(value) > 16_384 or any(ord(character) < 32 for character in value)
        ):
            raise ValueError(f"{name} contains invalid text")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{name} contains a non-finite number")
        return
    if isinstance(value, list):
        if len(value) > 10_000:
            raise ValueError(f"{name} contains an oversized list")
        for item in value:
            _validate_json_value(item, name, depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 1_000:
            raise ValueError(f"{name} contains an oversized object")
        for key, item in value.items():
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 256
                or any(ord(character) < 32 for character in key)
            ):
                raise ValueError(f"{name} contains an invalid key")
            _validate_json_value(item, name, depth=depth + 1)
        return
    raise ValueError(f"{name} contains a non-JSON value")


def _parse_json(
    text: str,
    *,
    maximum: int = MAX_MANIFEST_BYTES,
    name: str = "Remote JSON",
) -> Any:
    if len(text.encode()) > maximum:
        raise RemoteComputeError(f"{name} exceeds the supported size")

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise RemoteComputeError("Remote JSON contains duplicate keys")
            result[key] = value
        return result

    def reject_constant(_value: str) -> None:
        raise RemoteComputeError("Remote JSON contains a non-finite number")

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=reject_constant)
    except (TypeError, ValueError) as exc:
        if isinstance(exc, RemoteComputeError):
            raise
        raise RemoteComputeError("Remote JSON is malformed") from exc


_SETUP_SCRIPT = r"""
import os,stat,sys
project_root,*roots=sys.argv[1:]
for root in (project_root,*roots):
 s=os.lstat(root)
 if not stat.S_ISDIR(s.st_mode): raise SystemExit(40)
 runs=os.path.join(root,'.loci-runs')
 try: os.mkdir(runs,0o700)
 except FileExistsError:
  if not stat.S_ISDIR(os.lstat(runs).st_mode): raise SystemExit(41)
cleanups=os.path.join(project_root,'.loci-cleanups')
try: os.mkdir(cleanups,0o700)
except FileExistsError:
 if not stat.S_ISDIR(os.lstat(cleanups).st_mode): raise SystemExit(41)
print('READY')
""".strip()

_RESERVE_SCRIPT = r"""
import json,os,stat,sys
key,request_sha,project_root,output_root=sys.argv[1:]
marker={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
payload=json.dumps(marker,sort_keys=True,separators=(',',':')).encode()
for base in (project_root,output_root):
 if not stat.S_ISDIR(os.lstat(base).st_mode): raise SystemExit(40)
 runs=os.path.join(base,'.loci-runs')
 if not stat.S_ISDIR(os.lstat(runs).st_mode): raise SystemExit(41)
 root=os.path.join(runs,key); created=False
 try: os.mkdir(root,0o700); created=True
 except FileExistsError:
  if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
 mark=os.path.join(root,'.loci-owned.json')
 if created:
  fd=os.open(mark,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f: f.write(payload); f.flush(); os.fsync(f.fileno())
 else:
  ms=os.lstat(mark)
  if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(43)
  fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
  if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
   os.close(fd); raise SystemExit(43)
  with os.fdopen(fd,'rb') as f: existing=f.read(4097)
  if existing!=payload: raise SystemExit(43)
print('RESERVED')
""".strip()

_RECEIVE_SCRIPT = r"""
import hashlib,json,os,stat,sys
root,relative,expected,size_text,temp,key,request_sha=sys.argv[1:]
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(43)
fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
 os.close(fd); raise SystemExit(43)
with os.fdopen(fd) as f: marker=json.load(f)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
if marker!=owned: raise SystemExit(43)
size=int(size_text); base=os.path.realpath(root); source=os.path.join(root,temp)
s=os.lstat(source)
if not stat.S_ISREG(s.st_mode) or s.st_size!=size: raise SystemExit(44)
h=hashlib.sha256()
with open(source,'rb') as f:
 for block in iter(lambda:f.read(1048576),b''): h.update(block)
if h.hexdigest()!=expected: raise SystemExit(45)
parts=relative.split('/'); parent=root
for part in parts[:-1]:
 parent=os.path.join(parent,part)
 try: os.mkdir(parent,0o700)
 except FileExistsError:
  if not stat.S_ISDIR(os.lstat(parent).st_mode): raise SystemExit(46)
destination=os.path.join(root,*parts)
destination_parent=os.path.realpath(os.path.dirname(destination))
if os.path.commonpath((base,destination_parent))!=base: raise SystemExit(47)
try: ds=os.lstat(destination)
except FileNotFoundError: pass
else:
 if not stat.S_ISREG(ds.st_mode) or ds.st_size!=size: raise SystemExit(48)
 dh=hashlib.sha256()
 with open(destination,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''): dh.update(block)
 if dh.hexdigest()!=expected: raise SystemExit(48)
 os.unlink(source); print('EXISTING'); raise SystemExit(0)
os.rename(source,destination); print('STAGED')
""".strip()

_STDIN_FILE_SCRIPT = r"""
import hashlib,json,os,stat,sys
root,name,expected,key,request_sha=sys.argv[1:]
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(43)
fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
 os.close(fd); raise SystemExit(43)
with os.fdopen(fd) as f: marker=json.load(f)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
if marker!=owned: raise SystemExit(43)
data=sys.stdin.buffer.read(4194305)
if len(data)>4194304 or hashlib.sha256(data).hexdigest()!=expected: raise SystemExit(49)
path=os.path.join(root,name)
try: fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError:
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode): raise SystemExit(48)
 with open(path,'rb') as f: existing=f.read(4194305)
 if existing!=data: raise SystemExit(48)
 print('EXISTING'); raise SystemExit(0)
with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
print('STAGED')
""".strip()

_RUNTIME_SETUP_SCRIPT = r"""
import os,stat,sys
base,key=sys.argv[1:]
if not stat.S_ISDIR(os.lstat(base).st_mode): raise SystemExit(40)
cache=os.path.join(base,'.loci-runtime')
try: os.mkdir(cache,0o700)
except FileExistsError:
 if not stat.S_ISDIR(os.lstat(cache).st_mode): raise SystemExit(41)
root=os.path.join(cache,key); created=False
try: os.mkdir(root,0o700); created=True
except FileExistsError:
 if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
mark=os.path.join(root,'.loci-runtime-owned')
if created:
 fd=os.open(mark,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f: f.write(key+'\n'); f.flush(); os.fsync(f.fileno())
else:
 s=os.lstat(mark)
 if not stat.S_ISREG(s.st_mode) or s.st_size>65: raise SystemExit(43)
 fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
 if (fs.st_dev,fs.st_ino)!=(s.st_dev,s.st_ino): os.close(fd); raise SystemExit(43)
 with os.fdopen(fd) as f: value=f.read(66)
 if value!=key+'\n': raise SystemExit(43)
print('READY')
""".strip()

_RUNTIME_RECEIVE_SCRIPT = r"""
import hashlib,os,stat,sys
root,expected,size_text=sys.argv[1:]; name=expected+'.whl'; temp='.'+name
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(40)
source=os.path.join(root,temp); destination=os.path.join(root,name); size=int(size_text)
s=os.lstat(source)
if not stat.S_ISREG(s.st_mode) or s.st_size!=size: raise SystemExit(44)
h=hashlib.sha256()
with open(source,'rb') as f:
 for block in iter(lambda:f.read(1048576),b''): h.update(block)
if h.hexdigest()!=expected: raise SystemExit(45)
try: ds=os.lstat(destination)
except FileNotFoundError: os.rename(source,destination); print('STAGED')
else:
 if not stat.S_ISREG(ds.st_mode) or ds.st_size!=size: raise SystemExit(48)
 dh=hashlib.sha256()
 with open(destination,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''): dh.update(block)
 if dh.hexdigest()!=expected: raise SystemExit(48)
 os.unlink(source); print('EXISTING')
""".strip()

_SUBMIT_SCRIPT = r"""
import json,os,re,stat,subprocess,sys,tempfile
root,log_root,key,request_sha,scheduler=sys.argv[1:6]; command=sys.argv[6:]
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
for candidate in (root,log_root):
 if not stat.S_ISDIR(os.lstat(candidate).st_mode): raise SystemExit(51)
 mark=os.path.join(candidate,'.loci-owned.json'); ms=os.lstat(mark)
 if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(51)
 fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
 if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
  os.close(fd); raise SystemExit(51)
 with os.fdopen(fd) as f: marker=json.load(f)
 if marker!=owned: raise SystemExit(51)
state_path=os.path.join(root,'submit.json')
reservation={'schema':'loci.remote-submit/v1','request_key':key,'request_sha256':request_sha,'scheduler':scheduler,'state':'submitting','remote_job_id':None}
try:
 fd=os.open(state_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:
  json.dump(reservation,f,sort_keys=True,separators=(',',':'))
  f.flush(); os.fsync(f.fileno())
except FileExistsError:
 s=os.lstat(state_path)
 if not stat.S_ISREG(s.st_mode) or s.st_size>8192: raise SystemExit(55)
 with open(state_path) as f: print(f.read(8193)); raise SystemExit(0)
try:
 if scheduler=='direct':
  out=open(os.path.join(log_root,'stdout.log'),'ab',buffering=0)
  err=open(os.path.join(log_root,'stderr.log'),'ab',buffering=0)
  process=subprocess.Popen(
   command,cwd=root,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True
  )
  job_id=str(process.pid)
 else:
  result=subprocess.run(command,cwd=root,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=120,check=False)
  if result.returncode: raise RuntimeError(result.stderr[:1000])
  job_id=result.stdout.strip().split(';',1)[0]
  if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,127}',job_id):
   raise RuntimeError('invalid job id')
 reservation.update(state='submitted',remote_job_id=job_id)
 fd,temp=tempfile.mkstemp(prefix='.submit-',dir=root)
 with os.fdopen(fd,'w') as f:
  json.dump(reservation,f,sort_keys=True,separators=(',',':'))
  f.flush(); os.fsync(f.fileno())
 os.replace(temp,state_path); print(json.dumps(reservation,sort_keys=True,separators=(',',':')))
except Exception as e:
 reservation.update(state='failed',error=str(e)[:1000])
 fd,temp=tempfile.mkstemp(prefix='.submit-',dir=root)
 with os.fdopen(fd,'w') as f:
  json.dump(reservation,f,sort_keys=True,separators=(',',':'))
  f.flush(); os.fsync(f.fileno())
 os.replace(temp,state_path)
 raise
""".strip()

_CLEANUP_SCRIPT = r"""
import json,os,shutil,stat,sys,tempfile
key,request_sha,scheduler,job_id,receipt_path,*roots=sys.argv[1:]
if len(roots)!=2: raise SystemExit(49)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
base=os.path.dirname(receipt_path)
if os.path.basename(receipt_path)!=key+'.json': raise SystemExit(49)
bs=os.lstat(base)
if not stat.S_ISDIR(bs.st_mode): raise SystemExit(49)
common=os.path.commonpath((os.path.realpath(base),os.path.realpath(receipt_path)))
if common!=os.path.realpath(base): raise SystemExit(49)
def read_receipt():
 try: rs=os.lstat(receipt_path)
 except FileNotFoundError: return None
 if not stat.S_ISREG(rs.st_mode) or rs.st_size>8192: raise SystemExit(52)
 fd=os.open(receipt_path,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
 if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(rs.st_dev,rs.st_ino):
  os.close(fd); raise SystemExit(52)
 with os.fdopen(fd) as f: return json.load(f)
def validate_root(root,allow_absent):
 try: s=os.lstat(root)
 except FileNotFoundError:
  if allow_absent: return False
  raise SystemExit(50)
 if not stat.S_ISDIR(s.st_mode): raise SystemExit(50)
 mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
 if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(51)
 fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
 if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
  os.close(fd); raise SystemExit(51)
 with os.fdopen(fd) as f: marker=json.load(f)
 if marker!=owned: raise SystemExit(51)
 return True
def validate_submission(root):
 path=os.path.join(root,'submit.json'); s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_size>8192: raise SystemExit(54)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
 if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(s.st_dev,s.st_ino):
  os.close(fd); raise SystemExit(54)
 with os.fdopen(fd) as f: submit=json.load(f)
 if (submit.get('schema')!='loci.remote-submit/v1'
     or submit.get('request_key')!=key or submit.get('request_sha256')!=request_sha
     or submit.get('scheduler')!=scheduler or str(submit.get('remote_job_id'))!=job_id
     or submit.get('state')!='submitted'):
  raise SystemExit(54)
def write_receipt(record):
 fd,temp=tempfile.mkstemp(prefix='.cleanup-',dir=base)
 try:
  with os.fdopen(fd,'w') as f:
   json.dump(record,f,sort_keys=True,separators=(',',':'))
   f.flush(); os.fsync(f.fileno())
  os.replace(temp,receipt_path)
 finally:
  try: os.unlink(temp)
  except FileNotFoundError: pass
expected={'schema':'loci.remote-cleanup/v1','request_key':key,'request_sha256':request_sha,'scheduler':scheduler,'remote_job_id':job_id,'owned_run_roots':2}
current=read_receipt()
if current is None:
 for root in roots: validate_root(root,False)
 validate_submission(roots[0])
 preparing={**expected,'state':'cleaning'}
 fd=os.open(receipt_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:
  json.dump(preparing,f,sort_keys=True,separators=(',',':'))
  f.flush(); os.fsync(f.fileno())
 current=preparing
elif ({k:current.get(k) for k in expected}!=expected
      or current.get('state') not in {'cleaning','cleaned'}):
 raise SystemExit(52)
if current['state']=='cleaned':
 for root in roots:
  try: os.lstat(root)
  except FileNotFoundError: pass
  else: raise SystemExit(53)
 print(json.dumps(current,sort_keys=True,separators=(',',':'))); raise SystemExit(0)
present=[validate_root(root,True) for root in roots]
for root,exists in zip(roots,present):
 if exists: shutil.rmtree(root)
completed={**expected,'state':'cleaned'}
write_receipt(completed)
print(json.dumps(completed,sort_keys=True,separators=(',',':')))
""".strip()

_VERIFY_OUTPUT_SCRIPT = r"""
import hashlib,json,os,stat,sys
root,relative,expected,size_text,key,request_sha=sys.argv[1:]; size=int(size_text)
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(50)
mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(51)
fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
 os.close(fd); raise SystemExit(51)
with os.fdopen(fd) as f: marker=json.load(f)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
if marker!=owned: raise SystemExit(51)
current=root
parts=relative.split('/')
for index,part in enumerate(parts):
 current=os.path.join(current,part); s=os.lstat(current)
 if index<len(parts)-1 and not stat.S_ISDIR(s.st_mode): raise SystemExit(52)
if not stat.S_ISREG(s.st_mode) or s.st_size!=size: raise SystemExit(53)
h=hashlib.sha256()
with open(current,'rb') as f:
 for block in iter(lambda:f.read(1048576),b''): h.update(block)
if h.hexdigest()!=expected: raise SystemExit(54)
print('VERIFIED')
""".strip()

_READ_OWNED_FILE_SCRIPT = r"""
import json,os,stat,sys
root,name,key,request_sha,limit_text=sys.argv[1:]; limit=int(limit_text)
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(51)
fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
 os.close(fd); raise SystemExit(51)
with os.fdopen(fd) as f: marker=json.load(f)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
if marker!=owned: raise SystemExit(51)
path=os.path.join(root,name); s=os.lstat(path)
if not stat.S_ISREG(s.st_mode) or s.st_size>limit: raise SystemExit(55)
with open(path,'rb') as f: sys.stdout.buffer.write(f.read(limit+1))
""".strip()

_ASSERT_JOB_SCRIPT = r"""
import json,os,stat,sys
root,key,request_sha,scheduler,job_id,require_live=sys.argv[1:]
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(51)
fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
 os.close(fd); raise SystemExit(51)
with os.fdopen(fd) as f: marker=json.load(f)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
if marker!=owned: raise SystemExit(51)
path=os.path.join(root,'submit.json'); s=os.lstat(path)
if not stat.S_ISREG(s.st_mode) or s.st_size>8192: raise SystemExit(55)
with open(path) as f: submit=json.load(f)
if submit.get('request_key')!=key or submit.get('request_sha256')!=request_sha: raise SystemExit(56)
if submit.get('scheduler')!=scheduler: raise SystemExit(56)
if str(submit.get('remote_job_id'))!=job_id: raise SystemExit(56)
if scheduler=='direct':
 try:
  path='/proc/'+job_id+'/cmdline'; s=os.lstat(path)
  if not stat.S_ISREG(s.st_mode): raise SystemExit(56)
  with open(path,'rb') as f: command=f.read(65537)
 except FileNotFoundError:
  if require_live=='1': raise SystemExit(57)
 else:
  tokens=command.rstrip(b'\0').split(b'\0')
  expected=os.path.join(root,'request.json').encode()
  if len(command)>65536 or b'remote-worker' not in tokens or expected not in tokens:
   raise SystemExit(56)
print('BOUND')
""".strip()

_TAIL_OWNED_FILE_SCRIPT = r"""
import json,os,stat,sys
root,name,key,request_sha,limit_text=sys.argv[1:]; limit=int(limit_text)
if not stat.S_ISDIR(os.lstat(root).st_mode): raise SystemExit(42)
mark=os.path.join(root,'.loci-owned.json'); ms=os.lstat(mark)
if not stat.S_ISREG(ms.st_mode) or ms.st_size>4096: raise SystemExit(51)
fd=os.open(mark,os.O_RDONLY|os.O_NOFOLLOW); fs=os.fstat(fd)
if not stat.S_ISREG(fs.st_mode) or (fs.st_dev,fs.st_ino)!=(ms.st_dev,ms.st_ino):
 os.close(fd); raise SystemExit(51)
with os.fdopen(fd) as f: marker=json.load(f)
owned={'schema':'loci.remote-run/v1','request_key':key,'request_sha256':request_sha}
if marker!=owned: raise SystemExit(51)
path=os.path.join(root,name); s=os.lstat(path)
if not stat.S_ISREG(s.st_mode): raise SystemExit(55)
with open(path,'rb') as f:
 f.seek(max(0,s.st_size-limit)); sys.stdout.buffer.write(f.read(limit))
""".strip()


class RemoteComputeClient:
    """Fixed remote-compute lifecycle for one validated connection profile."""

    def __init__(self, profile: ConnectionProfile, runner: CommandRunner | None = None) -> None:
        profile.validate()
        self.profile = profile
        self.runner = runner or SubprocessRunner()
        self._connection_receipt: ConnectionReceipt | None = None

    def _require_tested_connection(self) -> None:
        if self._connection_receipt is None:
            raise RemoteComputeError(
                "Run test_connection successfully before remote setup, transfer, or execution"
            )

    def _ssh_prefix(self) -> list[str]:
        profile = self.profile
        arguments = [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={profile.known_hosts_file}",
            "-o",
            f"ConnectTimeout={profile.connect_timeout_seconds}",
        ]
        if profile.identity_file is not None:
            arguments.extend(("-o", "IdentitiesOnly=yes", "-i", str(profile.identity_file)))
        arguments.extend(("--", profile.alias))
        return arguments

    def _scp_prefix(self) -> list[str]:
        profile = self.profile
        arguments = [
            "scp",
            "-p",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={profile.known_hosts_file}",
            "-o",
            f"ConnectTimeout={profile.connect_timeout_seconds}",
        ]
        if profile.identity_file is not None:
            arguments.extend(("-o", "IdentitiesOnly=yes", "-i", str(profile.identity_file)))
        arguments.append("--")
        return arguments

    def _ssh(
        self,
        command: Sequence[str],
        *,
        input_bytes: bytes | None = None,
        timeout: int = 30,
        output_limit: int = MAX_COMMAND_OUTPUT_BYTES,
        check: bool = True,
    ) -> CommandResult:
        if not command:
            raise RemoteComputeError("Remote command cannot be empty")
        remote = shlex.join(list(command))
        if len(remote.encode()) > 64 * 1024:
            raise RemoteComputeError("Remote command exceeds the supported size")
        result = self.runner.run(
            [*self._ssh_prefix(), remote],
            input_bytes=input_bytes,
            timeout_seconds=timeout,
            output_limit=output_limit,
        )
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic"
            raise RemoteComputeError(
                f"Remote command failed ({result.returncode}): {detail[:1000]}"
            )
        return result

    def verify_host_identity(self) -> str:
        config = self.runner.run(
            ["ssh", "-G", "--", self.profile.alias],
            output_limit=64 * 1024,
        )
        if config.returncode != 0:
            raise RemoteComputeError("OpenSSH could not resolve the configured alias")
        values: dict[str, str] = {}
        for line in config.stdout.splitlines():
            key, separator, value = line.partition(" ")
            if separator and key in {"hostname", "port", "hostkeyalias"}:
                values[key] = value.strip()
        hostname = values.get("hostname", "")
        port = values.get("port", "22")
        host_key_alias = values.get("hostkeyalias", "")
        if not hostname or not port.isdecimal() or not 1 <= int(port) <= 65_535:
            raise RemoteComputeError("OpenSSH returned an invalid alias destination")
        lookup = host_key_alias if host_key_alias.lower() not in {"", "none"} else hostname
        if port != "22" and not host_key_alias:
            lookup = f"[{hostname}]:{port}"
        if lookup != self.profile.known_host:
            raise RemoteComputeError(
                "The SSH alias destination does not match the pinned known_host"
            )
        result = self.runner.run(
            [
                "ssh-keygen",
                "-F",
                self.profile.known_host,
                "-f",
                str(self.profile.known_hosts_file),
                "-l",
                "-E",
                "sha256",
            ],
            output_limit=64 * 1024,
        )
        if result.returncode != 0:
            raise RemoteComputeError("The configured host is absent from the selected known_hosts")
        fingerprints = set(re.findall(r"SHA256:[A-Za-z0-9+/]+={0,2}", result.stdout))
        if self.profile.host_key_sha256 not in fingerprints:
            raise RemoteComputeError("The configured host-key fingerprint is not in known_hosts")
        return self.profile.host_key_sha256

    def discover(self) -> ConnectionReceipt:
        fingerprint = self.verify_host_identity()
        operating_system = self._ssh(("uname", "-s"), output_limit=4096).stdout.strip()
        if operating_system != "Linux":
            raise RemoteComputeError("The remote worker currently requires Linux")
        runtime = self._ssh((self.profile.runtime_python, "--version"), output_limit=4096)
        runtime_version = (runtime.stdout or runtime.stderr).strip()
        scheduler_version: str | None = None
        if self.profile.scheduler in {"pbs", "pbspro"}:
            result = self._ssh(
                (self.profile.binary("qstat"), "--version"),
                output_limit=4096,
                check=False,
            )
            scheduler_version = (result.stdout or result.stderr).strip()
            if result.returncode != 0 or not scheduler_version:
                raise RemoteComputeError("PBS qstat readiness probe failed")
        elif self.profile.scheduler == "slurm":
            result = self._ssh((self.profile.binary("sinfo"), "--version"), output_limit=4096)
            scheduler_version = (result.stdout or result.stderr).strip()
        self._ssh(("test", "-d", self.profile.remote_project_root), output_limit=1024)
        self._ssh(("test", "-d", self.profile.remote_output_root), output_limit=1024)
        for remote_input_root in self.profile.remote_input_roots:
            self._ssh(("test", "-d", remote_input_root), output_limit=1024)
        receipt = ConnectionReceipt(
            self.profile.alias,
            fingerprint,
            operating_system,
            runtime_version,
            self.profile.scheduler,
            scheduler_version,
        )
        self._connection_receipt = receipt
        return receipt

    def test_connection(self) -> ConnectionReceipt:
        """Verify the pinned host, Linux runtime, scheduler, and approved roots."""

        return self.discover()

    def setup_roots(self) -> None:
        """Create only Loci's private namespace below two approved existing roots."""

        self._require_tested_connection()
        self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _SETUP_SCRIPT,
                self.profile.remote_project_root,
                self.profile.remote_output_root,
            )
        )

    def test_runtime(self) -> str:
        """Require the configured runtime to expose the fixed remote-worker contract."""

        self._require_tested_connection()
        result = self._ssh(
            (
                self.profile.runtime_python,
                "-m",
                "loci_engine.research_cli",
                "remote-worker",
                "--help",
            ),
            output_limit=64 * 1024,
        )
        return result.stdout.strip()

    def provision_runtime(self, wheel: Path, expected_sha256: str) -> str:
        """Install one pre-hashed local wheel into a hash-addressed remote venv.

        This method never contacts a package index.  The configured Python must
        already include ``venv`` and ``pip`` support.
        """

        self._require_tested_connection()
        _sha(expected_sha256, "wheel SHA-256")
        if not wheel.is_absolute() or wheel.is_symlink() or not wheel.is_file():
            raise ValueError("Runtime wheel must be an absolute plain local file")
        actual, size = _hash_file(wheel)
        if not hmac.compare_digest(actual, expected_sha256):
            raise RemoteComputeError("Runtime wheel does not match its declared SHA-256")
        runtime_root = f"{self.profile.remote_project_root}/.loci-runtime/{expected_sha256}"
        self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _RUNTIME_SETUP_SCRIPT,
                self.profile.remote_project_root,
                expected_sha256,
            )
        )
        incoming = f"{self.profile.remote_project_root}/.loci-runtime/.{expected_sha256}.whl"
        transfer = self.runner.run(
            [*self._scp_prefix(), str(wheel), f"{self.profile.alias}:{incoming}"],
            timeout_seconds=600,
        )
        if transfer.returncode:
            raise RemoteComputeError("Secure copy failed while staging the runtime wheel")
        self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _RUNTIME_RECEIVE_SCRIPT,
                f"{self.profile.remote_project_root}/.loci-runtime",
                expected_sha256,
                str(size),
            ),
            timeout=600,
        )
        self._ssh((self.profile.runtime_python, "-m", "venv", runtime_root), timeout=600)
        runtime = f"{runtime_root}/bin/python"
        self._ssh(
            (
                runtime,
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                f"{self.profile.remote_project_root}/.loci-runtime/{expected_sha256}.whl",
            ),
            timeout=600,
        )
        self._ssh((runtime, "-m", "loci_engine.research_cli", "remote-worker", "--help"))
        return runtime

    def reserve(self, request: RemoteRequest) -> RemoteJobIdentity:
        self._require_tested_connection()
        request.validate()
        self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _RESERVE_SCRIPT,
                request.request_key,
                request.request_sha256,
                self.profile.remote_project_root,
                self.profile.remote_output_root,
            )
        )
        return RemoteJobIdentity(
            request.request_key,
            request.request_sha256,
            self.profile.scheduler,
            None,
            "reserved",
        )

    def stage(self, manifest: StagingManifest) -> str:
        self._require_tested_connection()
        manifest.validate()
        run_root = self.profile.run_root(manifest.request_key)
        for entry in manifest.entries:
            actual, size = _hash_file(entry.local_path)
            if not hmac.compare_digest(actual, entry.sha256) or size != entry.size_bytes:
                raise RemoteComputeError("A staged input does not match its manifest identity")
            temp_name = f".incoming-{entry.sha256}"
            transfer = self.runner.run(
                [
                    *self._scp_prefix(),
                    str(entry.local_path),
                    f"{self.profile.alias}:{run_root}/{temp_name}",
                ],
                timeout_seconds=3600,
            )
            if transfer.returncode:
                raise RemoteComputeError("Secure copy failed while staging an input")
            self._ssh(
                (
                    self.profile.runtime_python,
                    "-c",
                    _RECEIVE_SCRIPT,
                    run_root,
                    entry.remote_relative_path,
                    entry.sha256,
                    str(entry.size_bytes),
                    temp_name,
                    manifest.request_key,
                    manifest.request_sha256,
                ),
                timeout=600,
            )
        encoded = manifest.encoded()
        manifest_sha = hashlib.sha256(encoded).hexdigest()
        self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _STDIN_FILE_SCRIPT,
                run_root,
                "staging-manifest.json",
                manifest_sha,
                manifest.request_key,
                manifest.request_sha256,
            ),
            input_bytes=encoded,
        )
        return manifest_sha

    def build_script(self, request: RemoteRequest, runtime_python: str | None = None) -> bytes:
        request.validate()
        runtime = _plain_absolute_path(
            runtime_python or self.profile.runtime_python, "remote worker runtime"
        )
        run_root = self.profile.run_root(request.request_key)
        request_path = f"{run_root}/request.json"
        output = f"{self.profile.output_root(request.request_key)}/stdout.log"
        error = f"{self.profile.output_root(request.request_key)}/stderr.log"
        worker = shlex.join(
            (runtime, "-m", "loci_engine.research_cli", "remote-worker", "--request", request_path)
        )
        lines = ["#!/bin/sh"]
        if self.profile.scheduler in {"pbs", "pbspro"}:
            lines.extend(
                (
                    f"#PBS -N loci_{request.request_key[:12]}",
                    f"#PBS -o {output}",
                    f"#PBS -e {error}",
                )
            )
            if self.profile.queue:
                lines.append(f"#PBS -q {self.profile.queue}")
            if self.profile.account:
                lines.append(f"#PBS -A {self.profile.account}")
            lines.append(f"#PBS -l walltime={request.resources.walltime}")
            if self.profile.scheduler == "pbspro":
                select = (
                    f"select=1:ncpus={request.resources.cpus}:mem={request.resources.memory_mb}mb"
                )
                if request.resources.gpus:
                    select += f":ngpus={request.resources.gpus}"
                lines.append(f"#PBS -l {select}")
            else:
                lines.extend(
                    (
                        f"#PBS -l nodes=1:ppn={request.resources.cpus}",
                        f"#PBS -l mem={request.resources.memory_mb}mb",
                    )
                )
                if request.resources.gpus:
                    if not self.profile.pbs_gpu_resource:
                        raise ValueError(
                            "Classic PBS GPU requests require a validated site resource name"
                        )
                    lines.append(
                        f"#PBS -l {self.profile.pbs_gpu_resource}={request.resources.gpus}"
                    )
        elif self.profile.scheduler == "slurm":
            lines.extend(
                (
                    f"#SBATCH --job-name=loci_{request.request_key[:12]}",
                    f"#SBATCH --output={output}",
                    f"#SBATCH --error={error}",
                    f"#SBATCH --cpus-per-task={request.resources.cpus}",
                    f"#SBATCH --mem={request.resources.memory_mb}M",
                    f"#SBATCH --time={request.resources.walltime}",
                )
            )
            if request.resources.gpus:
                lines.append(f"#SBATCH --gpus={request.resources.gpus}")
            if self.profile.queue:
                lines.append(f"#SBATCH --partition={self.profile.queue}")
            if self.profile.account:
                lines.append(f"#SBATCH --account={self.profile.account}")
        lines.extend(("set -eu", "umask 077", f"exec {worker}"))
        return ("\n".join(lines) + "\n").encode()

    def stage_request_and_script(
        self, request: RemoteRequest, request_document: bytes, runtime_python: str | None = None
    ) -> tuple[str, str]:
        self._require_tested_connection()
        request.validate()
        if len(request_document) > MAX_MANIFEST_BYTES:
            raise ValueError("Remote request document exceeds the supported size")
        if not hmac.compare_digest(
            hashlib.sha256(request_document).hexdigest(), request.request_sha256
        ):
            raise ValueError("Remote request document does not match request_sha256")
        run_root = self.profile.run_root(request.request_key)
        script = self.build_script(request, runtime_python)
        for name, payload in (("request.json", request_document), ("job.sh", script)):
            digest = hashlib.sha256(payload).hexdigest()
            self._ssh(
                (
                    self.profile.runtime_python,
                    "-c",
                    _STDIN_FILE_SCRIPT,
                    run_root,
                    name,
                    digest,
                    request.request_key,
                    request.request_sha256,
                ),
                input_bytes=payload,
            )
        return request.request_sha256, hashlib.sha256(script).hexdigest()

    def _submission_command(self, request: RemoteRequest, runtime_python: str | None) -> list[str]:
        run_root = self.profile.run_root(request.request_key)
        script = f"{run_root}/job.sh"
        if self.profile.scheduler in {"pbs", "pbspro"}:
            return [self.profile.binary("qsub"), script]
        if self.profile.scheduler == "slurm":
            return [self.profile.binary("sbatch"), "--parsable", script]
        if not self.profile.allow_direct_compute:
            raise RemoteComputeError(
                "Direct remote compute requires an explicitly approved non-login-node profile"
            )
        runtime = _plain_absolute_path(
            runtime_python or self.profile.runtime_python, "remote worker runtime"
        )
        return [
            runtime,
            "-m",
            "loci_engine.research_cli",
            "remote-worker",
            "--request",
            f"{run_root}/request.json",
        ]

    def submit(
        self, request: RemoteRequest, *, runtime_python: str | None = None
    ) -> RemoteJobIdentity:
        self._require_tested_connection()
        request.validate()
        run_root = self.profile.run_root(request.request_key)
        command = self._submission_command(request, runtime_python)
        result = self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _SUBMIT_SCRIPT,
                run_root,
                self.profile.output_root(request.request_key),
                request.request_key,
                request.request_sha256,
                self.profile.scheduler,
                *command,
            ),
            timeout=180,
            output_limit=64 * 1024,
        )
        return self._parse_job_identity(result.stdout, request)

    def _parse_job_identity(self, text: str, request: RemoteRequest) -> RemoteJobIdentity:
        record = _parse_json(text.strip())
        if not isinstance(record, dict) or record.get("schema") != "loci.remote-submit/v1":
            raise RemoteComputeError("Remote submission state has an invalid schema")
        if (
            record.get("request_key") != request.request_key
            or record.get("request_sha256") != request.request_sha256
        ):
            raise RemoteComputeError("Remote submission state belongs to another request")
        if record.get("scheduler") != self.profile.scheduler:
            raise RemoteComputeError("Remote submission scheduler identity changed")
        state = record.get("state")
        if state == "submitting":
            return RemoteJobIdentity(
                request.request_key, request.request_sha256, self.profile.scheduler, None, "unknown"
            )
        if state == "failed":
            raise RemoteComputeError("The reserved remote submission failed")
        job_id = record.get("remote_job_id")
        if state != "submitted" or not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            raise RemoteComputeError("Remote submission state contains an invalid job identity")
        return RemoteJobIdentity(
            request.request_key, request.request_sha256, self.profile.scheduler, job_id, "submitted"
        )

    def reconnect(self, request: RemoteRequest) -> RemoteJobIdentity:
        self._require_tested_connection()
        request.validate()
        run_root = self.profile.run_root(request.request_key)
        result = self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _READ_OWNED_FILE_SCRIPT,
                run_root,
                "submit.json",
                request.request_key,
                request.request_sha256,
                str(64 * 1024),
            ),
            output_limit=64 * 1024,
        )
        return self._parse_job_identity(result.stdout, request)

    def status(self, identity: RemoteJobIdentity) -> RemoteJobStatus:
        self._require_tested_connection()
        self._validate_identity(identity, require_job=True)
        self._assert_remote_job(identity)
        assert identity.remote_job_id is not None
        if identity.scheduler in {"pbs", "pbspro"}:
            flag = "-fx" if identity.scheduler == "pbspro" else "-f"
            result = self._ssh(
                (self.profile.binary("qstat"), flag, identity.remote_job_id),
                output_limit=256 * 1024,
                check=False,
            )
            detail = (result.stdout or result.stderr).strip()
            match = re.search(r"\bjob_state\s*=\s*([A-Z])\b", detail)
            mapping: dict[str, JobState] = {
                "Q": "queued",
                "H": "queued",
                "R": "running",
                "E": "running",
                "F": "finished",
                "C": "finished",
            }
            state = mapping.get(match.group(1), "unknown") if match else "unknown"
        elif identity.scheduler == "slurm":
            result = self._ssh(
                (
                    self.profile.binary("squeue"),
                    "--noheader",
                    "--jobs",
                    identity.remote_job_id,
                    "--format=%T",
                ),
                output_limit=64 * 1024,
                check=False,
            )
            detail = (result.stdout or result.stderr).strip()
            if not detail:
                result = self._ssh(
                    (
                        self.profile.binary("sacct"),
                        "--noheader",
                        "--parsable2",
                        "--jobs",
                        identity.remote_job_id,
                        "--format=State",
                    ),
                    output_limit=64 * 1024,
                    check=False,
                )
                detail = (result.stdout or result.stderr).strip()
            token = detail.splitlines()[0].strip().upper() if detail else ""
            token = token.split("|", 1)[0].split("+", 1)[0]
            if token in {"PENDING", "CONFIGURING"}:
                state = "queued"
            elif token in {"RUNNING", "COMPLETING"}:
                state = "running"
            elif token in {"COMPLETED"}:
                state = "finished"
            elif token in {"FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY"}:
                state = "failed"
            else:
                state = "unknown"
        else:
            result = self._ssh(("ps", "-p", identity.remote_job_id, "-o", "stat="), check=False)
            detail = (result.stdout or result.stderr).strip()
            if result.returncode == 0 and detail:
                state = "running"
            else:
                manifest_result = self._ssh(
                    (
                        self.profile.runtime_python,
                        "-c",
                        _READ_OWNED_FILE_SCRIPT,
                        self.profile.output_root(identity.request_key),
                        "output-manifest.json",
                        identity.request_key,
                        identity.request_sha256,
                        str(MAX_OUTPUT_MANIFEST_BYTES),
                    ),
                    output_limit=MAX_OUTPUT_MANIFEST_BYTES,
                    check=False,
                )
                if manifest_result.returncode == 0:
                    verify_output_manifest(manifest_result.stdout, identity)
                    state = "finished"
                    detail = "Direct process exited and its output manifest is verified"
                else:
                    error_result = self._ssh(
                        (
                            self.profile.runtime_python,
                            "-c",
                            _TAIL_OWNED_FILE_SCRIPT,
                            self.profile.output_root(identity.request_key),
                            "stderr.log",
                            identity.request_key,
                            identity.request_sha256,
                            str(64 * 1024),
                        ),
                        output_limit=64 * 1024,
                        check=False,
                    )
                    state = "failed"
                    detail = error_result.stdout.strip() or (
                        "Direct process exited without a verified output manifest"
                    )
        return RemoteJobStatus(identity, state, detail[:MAX_COMMAND_OUTPUT_BYTES])

    def logs(
        self, identity: RemoteJobIdentity, *, stderr: bool = False, limit: int = 64 * 1024
    ) -> str:
        self._require_tested_connection()
        self._validate_identity(identity, require_job=False)
        if identity.remote_job_id is not None:
            self._assert_remote_job(identity)
        if not 1 <= limit <= MAX_LOG_BYTES:
            raise ValueError("Remote log limit must be between 1 byte and 1 MiB")
        name = "stderr.log" if stderr else "stdout.log"
        result = self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _TAIL_OWNED_FILE_SCRIPT,
                self.profile.output_root(identity.request_key),
                name,
                identity.request_key,
                identity.request_sha256,
                str(limit),
            ),
            output_limit=limit,
            check=False,
        )
        if result.returncode not in {0, 1}:
            raise RemoteComputeError("Remote bounded log read failed")
        return result.stdout

    def cancel(self, identity: RemoteJobIdentity) -> None:
        self._require_tested_connection()
        self._validate_identity(identity, require_job=True)
        self._assert_remote_job(identity, require_live_process=True)
        assert identity.remote_job_id is not None
        if identity.scheduler in {"pbs", "pbspro"}:
            command = (self.profile.binary("qdel"), identity.remote_job_id)
        elif identity.scheduler == "slurm":
            command = (self.profile.binary("scancel"), identity.remote_job_id)
        else:
            command = ("kill", "-TERM", identity.remote_job_id)
        self._ssh(command, output_limit=64 * 1024)

    def _validate_identity(self, identity: RemoteJobIdentity, *, require_job: bool) -> None:
        if not _REQUEST_KEY.fullmatch(identity.request_key):
            raise ValueError("Remote identity has an invalid request key")
        _sha(identity.request_sha256, "remote identity request SHA-256")
        if identity.scheduler != self.profile.scheduler:
            raise ValueError("Remote identity belongs to another scheduler profile")
        if require_job and (
            identity.remote_job_id is None or not _JOB_ID.fullmatch(identity.remote_job_id)
        ):
            raise ValueError("Remote identity does not contain a valid job id")

    def _assert_remote_job(
        self, identity: RemoteJobIdentity, *, require_live_process: bool = False
    ) -> None:
        assert identity.remote_job_id is not None
        self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _ASSERT_JOB_SCRIPT,
                self.profile.run_root(identity.request_key),
                identity.request_key,
                identity.request_sha256,
                identity.scheduler,
                identity.remote_job_id,
                "1" if require_live_process else "0",
            ),
            output_limit=4096,
        )

    def fetch_output_manifest(self, identity: RemoteJobIdentity) -> VerifiedOutputManifest:
        self._require_tested_connection()
        self._validate_identity(identity, require_job=False)
        output_root = self.profile.output_root(identity.request_key)
        result = self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _READ_OWNED_FILE_SCRIPT,
                output_root,
                "output-manifest.json",
                identity.request_key,
                identity.request_sha256,
                str(MAX_OUTPUT_MANIFEST_BYTES),
            ),
            output_limit=MAX_OUTPUT_MANIFEST_BYTES,
        )
        return verify_output_manifest(result.stdout, identity)

    def retrieve_outputs(self, identity: RemoteJobIdentity, destination: Path) -> tuple[Path, ...]:
        """Retrieve verified plain outputs into one absent local directory."""

        manifest = self.fetch_output_manifest(identity)
        if not destination.is_absolute() or destination.exists() or destination.is_symlink():
            raise ValueError("Output destination must be an absent absolute path")
        parent = destination.parent.resolve(strict=True)
        destination = parent / destination.name
        destination.mkdir(mode=0o700)
        created: list[Path] = []
        try:
            remote_root = self.profile.output_root(identity.request_key)
            for index, entry in enumerate(manifest.entries):
                verify_command = (
                    self.profile.runtime_python,
                    "-c",
                    _VERIFY_OUTPUT_SCRIPT,
                    remote_root,
                    entry.relative_path,
                    entry.sha256,
                    str(entry.size_bytes),
                    identity.request_key,
                    identity.request_sha256,
                )
                self._ssh(verify_command, timeout=600)
                incoming = destination / f".incoming-{index}"
                transfer = self.runner.run(
                    [
                        *self._scp_prefix(),
                        f"{self.profile.alias}:{remote_root}/{entry.relative_path}",
                        str(incoming),
                    ],
                    timeout_seconds=3600,
                )
                if transfer.returncode:
                    raise RemoteComputeError("Secure copy failed while retrieving an output")
                actual, size = _hash_file(incoming)
                if not hmac.compare_digest(actual, entry.sha256) or size != entry.size_bytes:
                    raise RemoteComputeError("A retrieved output failed hash or size verification")
                self._ssh(verify_command, timeout=600)
                target = destination.joinpath(*PurePosixPath(entry.relative_path).parts)
                current = destination
                for component in PurePosixPath(entry.relative_path).parts[:-1]:
                    current = current / component
                    if current.exists():
                        if current.is_symlink() or not current.is_dir():
                            raise RemoteComputeError("A local output parent was replaced or linked")
                    else:
                        current.mkdir(mode=0o700)
                if target.exists() or target.is_symlink():
                    raise RemoteComputeError("A local output target already exists")
                os.replace(incoming, target)
                created.append(target)
            return tuple(created)
        except BaseException:
            shutil.rmtree(destination)
            raise

    def cleanup(self, identity: RemoteJobIdentity) -> RemoteCleanupReceipt:
        """Delete only two exact run roots carrying matching Loci ownership markers."""

        self._require_tested_connection()
        self._validate_identity(identity, require_job=True)
        assert identity.remote_job_id is not None
        run_root = self.profile.run_root(identity.request_key)
        output_root = self.profile.output_root(identity.request_key)
        result = self._ssh(
            (
                self.profile.runtime_python,
                "-c",
                _CLEANUP_SCRIPT,
                identity.request_key,
                identity.request_sha256,
                identity.scheduler,
                identity.remote_job_id,
                self.profile.cleanup_receipt_path(identity.request_key),
                run_root,
                output_root,
            ),
            timeout=600,
            output_limit=8192,
        )
        record = _parse_json(result.stdout.strip())
        expected = {
            "schema": "loci.remote-cleanup/v1",
            "request_key": identity.request_key,
            "request_sha256": identity.request_sha256,
            "scheduler": identity.scheduler,
            "remote_job_id": identity.remote_job_id,
            "owned_run_roots": 2,
            "state": "cleaned",
        }
        if not isinstance(record, dict) or record != expected:
            raise RemoteComputeError("Remote cleanup returned an invalid ownership receipt")
        return RemoteCleanupReceipt(
            identity.request_key,
            identity.request_sha256,
            identity.scheduler,
            identity.remote_job_id,
            2,
            "cleaned",
        )


def verify_output_manifest(text: str, identity: RemoteJobIdentity) -> VerifiedOutputManifest:
    """Validate an untrusted remote output manifest without touching output files."""

    record = _parse_json(
        text,
        maximum=MAX_OUTPUT_MANIFEST_BYTES,
        name="Output manifest",
    )
    if not isinstance(record, dict) or set(record) != {
        "schema",
        "request_key",
        "request_sha256",
        "outputs",
    }:
        raise RemoteComputeError("Output manifest has unexpected fields")
    if record["schema"] != "loci.remote-output/v1":
        raise RemoteComputeError("Output manifest has an unsupported schema")
    if record["request_key"] != identity.request_key or record["request_sha256"] != (
        identity.request_sha256
    ):
        raise RemoteComputeError("Output manifest is not bound to this remote request")
    outputs = record["outputs"]
    if not isinstance(outputs, list) or len(outputs) > 10_000:
        raise RemoteComputeError("Output manifest has an invalid output list")
    entries: list[OutputEntry] = []
    paths: set[str] = set()
    for item in outputs:
        if not isinstance(item, dict) or set(item) != {
            "path",
            "sha256",
            "size_bytes",
            "media_type",
        }:
            raise RemoteComputeError("Output manifest entry has unexpected fields")
        try:
            relative = _relative_path(item["path"], "output path")
            digest = _sha(item["sha256"], "output SHA-256")
            media_type_value = item["media_type"]
            if not isinstance(media_type_value, str) or not _MEDIA_TYPE.fullmatch(media_type_value):
                raise ValueError("output media type is invalid")
            media_type = media_type_value
        except (TypeError, ValueError) as exc:
            raise RemoteComputeError("Output manifest entry is invalid") from exc
        size = item["size_bytes"]
        if (
            isinstance(size, bool)
            or not isinstance(size, int)
            or not 0 <= size <= MAX_STAGE_FILE_BYTES
        ):
            raise RemoteComputeError("Output manifest entry size is invalid")
        if relative in paths:
            raise RemoteComputeError("Output manifest contains duplicate paths")
        paths.add(relative)
        entries.append(OutputEntry(relative, digest, size, media_type))
    return VerifiedOutputManifest(identity.request_key, identity.request_sha256, tuple(entries))
