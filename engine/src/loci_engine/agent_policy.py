"""Fail-closed authorization for the local stdio research-agent boundary.

Policies are human-created local files.  An MCP process pins one exact file,
content hash, project identity, and export-directory identity at startup.  It
then rechecks those identities before every tool call; replacing or editing a
policy revokes that running process instead of silently widening its grants.
"""

from __future__ import annotations

import hashlib
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .export import _fsync_directory
from .research_project import ResearchProject, canonical_json, checked_id, parse_json

POLICY_SCHEMA = "loci.agent-policy/v1"
MAX_POLICY_BYTES = 1024 * 1024
DISCLOSURES = frozenset(
    {"geometry", "source_names", "previews", "measurements", "provenance", "agent_metadata"}
)
OPERATIONS = frozenset(
    {
        "inspect_source",
        "validate_recipe",
        "preview_recipe",
        "submit_recipe",
        "job_status",
        "cancel_job",
        "result",
        "result_view",
        "export_result",
    }
)
_TOP_LEVEL_KEYS = {
    "schema",
    "project",
    "sources",
    "recipes",
    "operations",
    "model_packages",
    "runtimes",
    "export",
    "limits",
    "disclosures",
}
_RUNTIME_KEYS = {
    "engine",
    "numpy",
    "scipy",
    "scikit_image",
    "backend",
    "resolved_device",
}


def _exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} must contain exactly: {', '.join(sorted(expected))}")
    return value


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be an integer from {minimum} to {maximum}")
    return value


def _sha256(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _text(value: Any, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{label} must be non-empty text of at most {maximum} characters")
    if any(ord(character) < 32 for character in value):
        raise ValueError(f"{label} contains control characters")
    return value


def _unique_integers(value: Any, label: str, maximum: int = 1_000_000) -> tuple[int, ...]:
    if not isinstance(value, list) or not value or len(value) > 4096:
        raise ValueError(f"{label} must be a non-empty bounded integer list")
    checked = tuple(_integer(item, label, 0, maximum) for item in value)
    if tuple(sorted(set(checked))) != checked:
        raise ValueError(f"{label} must be sorted and contain no duplicates")
    return checked


def _plain_directory(value: Any, label: str) -> tuple[Path, tuple[int, int]]:
    path = Path(_text(value, label, 4096)).expanduser()
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise ValueError(f"{label} must be an existing absolute plain directory")
    path = path.resolve(strict=True)
    details = path.stat()
    if not stat.S_ISDIR(details.st_mode):
        raise ValueError(f"{label} must be a plain directory")
    return path, (details.st_dev, details.st_ino)


def _read_plain_policy(path: Path) -> tuple[bytes, tuple[int, int]]:
    if not path.is_absolute():
        raise ValueError("Policy path must be absolute")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ValueError("Policy must be an accessible plain file") from exc
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError("Policy must be one plain, non-linked file")
        if os.name == "posix" and stat.S_IMODE(before.st_mode) != 0o600:
            raise ValueError("Policy file permissions must be 0600")
        if hasattr(os, "getuid") and before.st_uid != os.getuid():
            raise ValueError("Policy file must be owned by the current user")
        if before.st_size > MAX_POLICY_BYTES:
            raise ValueError("Policy exceeds the 1 MiB limit")
        chunks: list[bytes] = []
        remaining = MAX_POLICY_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        if len(data) > MAX_POLICY_BYTES or (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("Policy changed while it was being read")
        current = path.lstat()
        if (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino):
            raise ValueError("Policy path changed while it was being read")
        return data, (after.st_dev, after.st_ino)
    finally:
        os.close(descriptor)


@dataclass(frozen=True)
class SourceGrant:
    source_id: str
    sha256: str
    crop: tuple[int, int, int, int]
    t: tuple[int, ...]
    c: tuple[int, ...]
    z: tuple[int, ...]
    level: tuple[int, ...]
    measurement_channels: tuple[int, ...]

    def allows(self, selection: dict[str, Any], measurements: list[int]) -> bool:
        x, y, width, height = self.crop
        selected_x = selection.get("x")
        selected_y = selection.get("y")
        selected_width = selection.get("width")
        selected_height = selection.get("height")
        if not all(
            isinstance(item, int) and not isinstance(item, bool)
            for item in (selected_x, selected_y, selected_width, selected_height)
        ):
            return False
        if (
            selected_x < x
            or selected_y < y
            or selected_width < 1
            or selected_height < 1
            or selected_x + selected_width > x + width
            or selected_y + selected_height > y + height
        ):
            return False
        if selection.get("t") not in self.t or selection.get("c") not in self.c:
            return False
        if selection.get("level") not in self.level or selection.get("z") not in self.z:
            return False
        z_stop = selection.get("z_stop")
        if z_stop is not None:
            if not isinstance(z_stop, int) or isinstance(z_stop, bool):
                return False
            if z_stop <= selection["z"] or any(
                plane not in self.z for plane in range(selection["z"], z_stop)
            ):
                return False
        return all(channel in self.measurement_channels for channel in measurements)


@dataclass(frozen=True)
class RecipeGrant:
    sha256: str
    preview: bool
    run: bool


@dataclass(frozen=True)
class AgentPolicy:
    path: Path
    content_sha256: str
    file_identity: tuple[int, int]
    project_path: Path
    project_directory_identity: tuple[int, int]
    project_id: str
    sources: dict[str, SourceGrant]
    recipes: dict[str, RecipeGrant]
    operations: frozenset[str]
    model_packages: tuple[tuple[str, str], ...]
    runtimes: tuple[dict[str, str], ...]
    export_root: Path | None
    export_root_identity: tuple[int, int] | None
    export_filenames: frozenset[str]
    cpu_seconds: int
    memory_bytes: int
    concurrency: int
    disclosures: frozenset[str]

    def recheck(self) -> None:
        encoded, identity = _read_plain_policy(self.path)
        if (
            identity != self.file_identity
            or hashlib.sha256(encoded).hexdigest() != self.content_sha256
        ):
            raise PermissionError("The pinned policy was changed or replaced; restart is required")
        current_project = self.project_path.lstat()
        if (
            not stat.S_ISDIR(current_project.st_mode)
            or (current_project.st_dev, current_project.st_ino) != self.project_directory_identity
        ):
            raise PermissionError("The authorized project directory changed")
        project = ResearchProject(self.project_path)
        if project.meta["project_id"] != self.project_id:
            raise PermissionError("The policy project identity no longer matches")
        if self.export_root is not None:
            current = self.export_root.lstat()
            if (
                self.export_root.is_symlink()
                or not stat.S_ISDIR(current.st_mode)
                or (current.st_dev, current.st_ino) != self.export_root_identity
            ):
                raise PermissionError("The authorized export root changed")

    def require_operation(self, operation: str) -> None:
        if operation not in self.operations:
            raise PermissionError("The pinned policy does not allow this operation")

    def require_disclosure(self, category: str) -> None:
        if category not in self.disclosures:
            raise PermissionError(f"The pinned policy does not allow {category} disclosure")

    def require_runtime(self, runtime: dict[str, Any]) -> None:
        identity = {key: runtime.get(key) for key in _RUNTIME_KEYS}
        if identity not in self.runtimes:
            raise PermissionError("The active analysis runtime is outside the pinned policy")

    def require_model(self, model: dict[str, Any] | None) -> None:
        if model is None:
            return
        if not isinstance(model, dict):
            raise PermissionError("The result model identity is outside the pinned policy")
        package_id = model.get("package_id", model.get("id", model.get("artifact_id")))
        identity = (package_id, model.get("sha256"))
        if identity not in self.model_packages:
            raise PermissionError("The result model identity is outside the pinned policy")

    def source_grant(self, project: ResearchProject, source_id: str) -> SourceGrant:
        grant = self.sources.get(checked_id(source_id))
        if grant is None:
            raise PermissionError("The source identity is outside the pinned policy")
        source = project.source(source_id, verify=True)
        if source["sha256"] != grant.sha256:
            raise PermissionError("The source identity is outside the pinned policy")
        return grant


def _validated_document(
    document: Any,
) -> tuple[
    dict[str, SourceGrant],
    dict[str, RecipeGrant],
    Path,
    tuple[int, int],
    Path | None,
    tuple[int, int] | None,
    frozenset[str],
]:
    root = _exact_keys(document, _TOP_LEVEL_KEYS, "policy")
    if root["schema"] != POLICY_SCHEMA:
        raise ValueError("Unsupported policy schema")
    project_value = _exact_keys(root["project"], {"path", "id"}, "policy project")
    project_path, project_identity = _plain_directory(project_value["path"], "project path")
    project_id = checked_id(project_value["id"])
    project = ResearchProject(project_path)
    if project.meta["project_id"] != project_id:
        raise ValueError("Policy project identity does not match the selected study")

    if not isinstance(root["sources"], list) or not root["sources"]:
        raise ValueError("Policy requires at least one explicit source grant")
    sources: dict[str, SourceGrant] = {}
    for item in root["sources"]:
        value = _exact_keys(
            item,
            {"id", "sha256", "crop", "t", "c", "z", "level", "measurement_channels"},
            "source grant",
        )
        source_id = checked_id(value["id"])
        crop_value = _exact_keys(value["crop"], {"x", "y", "width", "height"}, "source crop")
        crop = (
            _integer(crop_value["x"], "crop x", 0, 2**31 - 1),
            _integer(crop_value["y"], "crop y", 0, 2**31 - 1),
            _integer(crop_value["width"], "crop width", 1, 2**31 - 1),
            _integer(crop_value["height"], "crop height", 1, 2**31 - 1),
        )
        if source_id in sources:
            raise ValueError("Policy source grants must be unique")
        source = project.source(source_id)
        digest = _sha256(value["sha256"], "source SHA-256")
        if source["sha256"] != digest:
            raise ValueError("Policy source fingerprint does not match the study")
        sources[source_id] = SourceGrant(
            source_id,
            digest,
            crop,
            _unique_integers(value["t"], "allowed T indices"),
            _unique_integers(value["c"], "allowed C indices"),
            _unique_integers(value["z"], "allowed Z indices"),
            _unique_integers(value["level"], "allowed pyramid levels"),
            _unique_integers(value["measurement_channels"], "allowed measurement channels"),
        )

    if not isinstance(root["recipes"], list) or len(root["recipes"]) > 4096:
        raise ValueError("Policy recipes must be a bounded list")
    recipes: dict[str, RecipeGrant] = {}
    for item in root["recipes"]:
        value = _exact_keys(item, {"sha256", "preview", "run"}, "recipe grant")
        digest = _sha256(value["sha256"], "recipe SHA-256")
        if not isinstance(value["preview"], bool) or not isinstance(value["run"], bool):
            raise ValueError("Recipe preview and run grants must be boolean")
        if digest in recipes:
            raise ValueError("Policy recipe grants must be unique")
        recipes[digest] = RecipeGrant(digest, value["preview"], value["run"])

    if not isinstance(root["operations"], list) or len(set(root["operations"])) != len(
        root["operations"]
    ):
        raise ValueError("Policy operations must be a unique list")
    operations = frozenset(root["operations"])
    if not operations <= OPERATIONS:
        raise ValueError("Policy contains an unsupported agent operation")

    if not isinstance(root["model_packages"], list) or len(root["model_packages"]) > 256:
        raise ValueError("Model package scope must be a bounded list")
    packages: list[tuple[str, str]] = []
    for item in root["model_packages"]:
        value = _exact_keys(item, {"id", "sha256"}, "model package identity")
        packages.append(
            (
                _text(value["id"], "model package identity"),
                _sha256(value["sha256"], "model SHA-256"),
            )
        )
    if len(set(packages)) != len(packages) or len({item[0] for item in packages}) != len(packages):
        raise ValueError("Model package identities must be unique")

    if not isinstance(root["runtimes"], list) or len(root["runtimes"]) > 64:
        raise ValueError("Runtime scope must be a bounded list")
    runtimes: list[dict[str, str]] = []
    for item in root["runtimes"]:
        value = _exact_keys(item, _RUNTIME_KEYS, "runtime identity")
        runtimes.append({key: _text(value[key], f"runtime {key}") for key in _RUNTIME_KEYS})
    if len({canonical_json(value) for value in runtimes}) != len(runtimes):
        raise ValueError("Runtime identities must be unique")

    export_value = root["export"]
    export_root: Path | None = None
    export_identity: tuple[int, int] | None = None
    if export_value is not None:
        value = _exact_keys(export_value, {"root", "filenames"}, "export grant")
        export_root, export_identity = _plain_directory(value["root"], "export root")
        if not isinstance(value["filenames"], list) or not value["filenames"]:
            raise ValueError("Export grant requires explicit filenames")
        checked_names = []
        for filename in value["filenames"]:
            checked = _text(filename, "export filename", 80)
            if Path(checked).name != checked or checked in {".", ".."}:
                raise ValueError("Export filenames must be single safe path components")
            checked_names.append(checked)
        if len(set(checked_names)) != len(checked_names):
            raise ValueError("Export filenames must be unique")

    limits = _exact_keys(root["limits"], {"cpu_seconds", "memory_bytes", "concurrency"}, "limits")
    _integer(limits["cpu_seconds"], "CPU seconds", 1, 86_400)
    _integer(limits["memory_bytes"], "memory bytes", 64 * 1024**2, 8 * 1024**3)
    _integer(limits["concurrency"], "concurrency", 1, 64)

    if not isinstance(root["disclosures"], list) or len(set(root["disclosures"])) != len(
        root["disclosures"]
    ):
        raise ValueError("Policy disclosures must be a unique list")
    disclosures = frozenset(root["disclosures"])
    if not disclosures <= DISCLOSURES:
        raise ValueError("Policy contains an unsupported disclosure category")
    return (
        sources,
        recipes,
        project_path,
        project_identity,
        export_root,
        export_identity,
        disclosures,
    )


def load_policy(path: str | Path) -> AgentPolicy:
    policy_path = Path(path).expanduser()
    if not policy_path.is_absolute():
        raise ValueError("Policy path must be absolute")
    encoded, identity = _read_plain_policy(policy_path)
    try:
        document = parse_json(encoded.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("Policy must be strict UTF-8 JSON") from exc
    (
        sources,
        recipes,
        project_path,
        project_identity,
        export_root,
        export_root_identity,
        disclosures,
    ) = _validated_document(document)
    project_value = document["project"]
    limits = document["limits"]
    return AgentPolicy(
        path=policy_path,
        content_sha256=hashlib.sha256(encoded).hexdigest(),
        file_identity=identity,
        project_path=project_path,
        project_directory_identity=project_identity,
        project_id=project_value["id"],
        sources=sources,
        recipes=recipes,
        operations=frozenset(document["operations"]),
        model_packages=tuple(
            (value["id"], value["sha256"]) for value in document["model_packages"]
        ),
        runtimes=tuple(document["runtimes"]),
        export_root=export_root,
        export_root_identity=export_root_identity,
        export_filenames=frozenset(
            [] if document["export"] is None else document["export"]["filenames"]
        ),
        cpu_seconds=limits["cpu_seconds"],
        memory_bytes=limits["memory_bytes"],
        concurrency=limits["concurrency"],
        disclosures=disclosures,
    )


def write_policy(
    path: str | Path, project: str | Path | ResearchProject, specification: dict[str, Any]
) -> dict[str, Any]:
    """Atomically write a human-supplied policy specification as a private file."""
    study = project if isinstance(project, ResearchProject) else ResearchProject(project)
    expected = _TOP_LEVEL_KEYS - {"schema", "project"}
    _exact_keys(specification, expected, "policy specification")
    document = {
        "schema": POLICY_SCHEMA,
        "project": {"path": str(study.root), "id": study.meta["project_id"]},
        **specification,
    }
    _validated_document(document)
    encoded = (canonical_json(document) + "\n").encode("utf-8")
    destination = Path(path).expanduser()
    if not destination.is_absolute():
        raise ValueError("Policy destination must be absolute")
    parent = destination.parent.resolve(strict=True)
    target = parent / destination.name
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("Policy destination must be absent or a plain file")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".loci-policy-", dir=parent)
    temporary = Path(temporary_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        else:
            # Windows has no descriptor chmod; mkstemp created this owned path
            # exclusively, so apply its closest supported permission mode.
            os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        _fsync_directory(parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary.exists():
            temporary.unlink()
    loaded = load_policy(target)
    return {
        "schema": POLICY_SCHEMA,
        "policy_sha256": loaded.content_sha256,
        "project_id": loaded.project_id,
    }
