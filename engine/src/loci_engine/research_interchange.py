"""Path-redacted recipe and study interchange.

Study archives contain canonical JSON records and content-addressed NPY arrays.
They never contain raw sources, source locators, managed model packages, remote
credentials, executable payloads, SQLite files, or pickle data.  Import rebuilds
the database instead of trusting an archived database.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import stat
import struct
import tempfile
import zipfile
from contextlib import suppress
from dataclasses import asdict
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import TYPE_CHECKING, Any

import numpy as np

from .export import _fsync_directory, _rename_noreplace
from .research_project import (
    ARRAY_NAME_PATTERN,
    DEFAULT_DISK_BUDGET,
    MAX_ARTIFACT_BYTES,
    MAX_JSON_BYTES,
    SHA_PATTERN,
    ResearchProject,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
    timestamp,
)
from .working_result import _sha256_file_stable

if TYPE_CHECKING:
    from .workbench import Workbench

RECIPE_SCHEMA = "loci.recipe-interchange/v1"
PROJECT_SCHEMA = "loci.study-interchange/v1"
MAX_ARCHIVE_MEMBERS = 4096
MAX_ARCHIVE_BYTES = 32 * 1024**3
_RECORD_KINDS = frozenset(
    {
        "sample",
        "recipe",
        "display",
        "channels",
        "annotations",
        "tracks",
        "selection",
        "policy",
        "model",
        "model_preview",
        "comparison",
        "workspace",
    }
)
_MEMBER_PATTERN = re.compile(
    r"^(?:sources|results|jobs|reviews)/[a-f0-9]{32}\.json$"
    r"|^documents/[a-z][a-z0-9_-]{0,31}/[a-f0-9]{32}\.json$"
    r"|^artifacts/[a-f0-9]{64}\.npy$"
)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _is_absolute_text(value: str) -> bool:
    return Path(value).is_absolute() or PureWindowsPath(value).is_absolute()


def _reject_absolute_strings(value: Any, location: str) -> None:
    if isinstance(value, str):
        if _is_absolute_text(value):
            raise ValueError(f"{location} contains an absolute path that cannot be interchanged")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _reject_absolute_strings(item, f"{location}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            _reject_absolute_strings(item, f"{location}.{key}")


def _atomic_write(destination: str | Path, encoded: bytes) -> tuple[Path, str]:
    target = Path(destination).expanduser()
    if not target.is_absolute():
        raise ValueError("Interchange destination must be absolute")
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    if target.exists() or target.is_symlink():
        raise ValueError("Interchange destination must be absent")
    parent_identity = (parent.stat().st_dev, parent.stat().st_ino)
    descriptor, temporary = tempfile.mkstemp(prefix=".loci-interchange-", dir=parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        current = parent.stat()
        if (current.st_dev, current.st_ino) != parent_identity:
            raise ValueError("Interchange destination directory changed before publication")
        _rename_noreplace(temporary_path, target)
        _fsync_directory(parent)
    finally:
        with suppress(FileNotFoundError):
            temporary_path.unlink()
    return target, _sha256_bytes(encoded)


def _source_binding(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "source_kind": source.get("source_kind", "native"),
        "name": source["name"],
    }


def _portable_recipe(validated: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    recipe = {key: value for key, value in validated["recipe"].items() if key != "references"}
    bindings = {"primary": validated["source_id"]}
    portable_references = {}
    for role, reference in validated["recipe"].get("references", {}).items():
        bindings[role] = reference["source_id"]
        portable_references[role] = {
            "binding": role,
            "selection": reference["selection"],
        }
    if portable_references:
        recipe["references"] = portable_references
    template = {"selection": validated["selection"], "recipe": recipe}
    return template, bindings


def export_recipe(
    workbench: Workbench,
    recipe_id: str,
    source_id: str,
    destination: str | Path,
) -> dict[str, Any]:
    """Export one saved recipe as a source-role template, without source paths."""

    recipe_id = checked_id(recipe_id)
    documents = [item for item in workbench.project.documents("recipe") if item["id"] == recipe_id]
    if len(documents) != 1:
        raise ValueError("Saved recipe is not part of this study")
    document = documents[0]
    data = document.get("data")
    if not isinstance(data, dict):
        raise ValueError("Saved recipe record is invalid")
    allowed = {"name", "recipe", "selection", "recipe_sha256", "interchange"}
    if set(data) - allowed or "name" not in data or "recipe" not in data:
        raise ValueError("Saved recipe record contains unsupported fields")
    checked_text(data["name"], "Recipe name")
    validated = workbench.validate_recipe(
        {
            "source_id": checked_id(source_id),
            "selection": data.get("selection"),
            "recipe": data["recipe"],
        }
    )
    if data.get("recipe_sha256") not in {None, validated["recipe_sha256"]}:
        raise ValueError("Saved recipe digest is stale for its validated settings")
    template, role_ids = _portable_recipe(validated)
    bindings = {
        role: _source_binding(workbench.project.source(bound_id, verify=True))
        for role, bound_id in role_ids.items()
    }
    template_sha256 = _sha256_bytes(canonical_json(template).encode())
    package = {
        "schema": RECIPE_SCHEMA,
        "name": data["name"],
        "recipe_id": recipe_id,
        "recipe_revision": document["revision"],
        "template": template,
        "template_sha256": template_sha256,
        "original_bindings": bindings,
        "source_reuse": "explicit-role-remap-and-revalidation-required",
    }
    _reject_absolute_strings(package, "recipe package")
    encoded = (canonical_json(package) + "\n").encode()
    target, digest = _atomic_write(destination, encoded)
    return {
        "schema": RECIPE_SCHEMA,
        "export_name": target.name,
        "package_sha256": digest,
        "template_sha256": template_sha256,
        "roles": sorted(bindings),
    }


def _read_json_file(path: str | Path, maximum: int, expected_sha256: str | None) -> dict[str, Any]:
    source = Path(path).expanduser()
    if not source.is_absolute() or source.is_symlink() or not source.is_file():
        raise ValueError("Interchange input must be an explicitly selected plain file")
    try:
        digest, size = _sha256_file_stable(source, reject_symlink=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Interchange JSON is not a stable plain file") from exc
    if size > maximum:
        raise ValueError("Interchange JSON exceeds its byte bound")
    if expected_sha256 is not None and digest != expected_sha256:
        raise ValueError("Interchange JSON failed its expected SHA-256")
    before = source.lstat()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            or opened.st_size != size
        ):
            raise ValueError("Interchange JSON changed before it could be read")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            encoded = stream.read(maximum + 1)
        after = os.fstat(descriptor)
        if (
            len(encoded) != size
            or len(encoded) > maximum
            or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            or _sha256_bytes(encoded) != digest
        ):
            raise ValueError("Interchange JSON changed while it was read")
    finally:
        os.close(descriptor)
    try:
        stable_after = _sha256_file_stable(source, reject_symlink=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Interchange JSON changed after it was read") from exc
    if stable_after != (digest, size):
        raise ValueError("Interchange JSON changed after it was read")
    try:
        return parse_json(encoded.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError("Interchange JSON is not valid UTF-8") from exc


def import_recipe(
    workbench: Workbench,
    package_path: str | Path,
    bindings: dict[str, str],
    *,
    recipe_id: str | None = None,
    expected_revision: int = 0,
    expected_package_sha256: str | None = None,
    require_exact_sources: bool = False,
) -> dict[str, Any]:
    """Bind a recipe template to explicit local source roles and revalidate it."""

    package = _read_json_file(package_path, MAX_JSON_BYTES, expected_package_sha256)
    required = {
        "schema",
        "name",
        "recipe_id",
        "recipe_revision",
        "template",
        "template_sha256",
        "original_bindings",
        "source_reuse",
    }
    if (
        not isinstance(package, dict)
        or set(package) != required
        or package["schema"] != RECIPE_SCHEMA
    ):
        raise ValueError("Recipe interchange schema or fields are unsupported")
    _reject_absolute_strings(package, "recipe package")
    checked_text(package["name"], "Recipe name")
    if (
        checked_id(package["recipe_id"]) != package["recipe_id"]
        or isinstance(package["recipe_revision"], bool)
        or not isinstance(package["recipe_revision"], int)
        or package["recipe_revision"] < 1
        or package["source_reuse"] != "explicit-role-remap-and-revalidation-required"
    ):
        raise ValueError("Recipe interchange identity or revision is invalid")
    original = package["original_bindings"]
    if not isinstance(bindings, dict):
        raise ValueError("Recipe source bindings must be an object")
    if not isinstance(original, dict) or "primary" not in original:
        raise ValueError("Recipe template requires an explicit primary source binding")
    if set(bindings) != set(original):
        raise ValueError("Map every declared recipe source role exactly once")
    template = package["template"]
    if (
        not isinstance(template, dict)
        or set(template) != {"selection", "recipe"}
        or _sha256_bytes(canonical_json(template).encode()) != package["template_sha256"]
    ):
        raise ValueError("Recipe template failed its canonical digest")
    local_sources: dict[str, dict[str, Any]] = {}
    for role, source_id in bindings.items():
        if not isinstance(role, str) or role not in {"primary", "flatfield", "darkfield"}:
            raise ValueError("Recipe source role is unsupported")
        original_binding = original[role]
        if not isinstance(original_binding, dict) or set(original_binding) != {
            "source_id",
            "source_sha256",
            "source_kind",
            "name",
        }:
            raise ValueError("Original recipe source binding is invalid")
        checked_id(original_binding["source_id"])
        if (
            not isinstance(original_binding["source_sha256"], str)
            or not SHA_PATTERN.fullmatch(original_binding["source_sha256"])
            or original_binding["source_kind"]
            not in {"native", "whole_slide", "ome_zarr", "medical"}
        ):
            raise ValueError("Original recipe source identity is invalid")
        checked_text(original_binding["name"], "Original source name")
        local = workbench.project.source(checked_id(source_id), verify=True)
        if require_exact_sources and (
            local["sha256"] != original_binding["source_sha256"]
            or local.get("source_kind", "native") != original_binding["source_kind"]
        ):
            raise ValueError("Exact recipe restoration requires the original source identity")
        local_sources[role] = local
    portable_recipe = template["recipe"]
    if not isinstance(portable_recipe, dict):
        raise ValueError("Recipe template settings are invalid")
    recipe = {key: value for key, value in portable_recipe.items() if key != "references"}
    portable_references = portable_recipe.get("references", {})
    if not isinstance(portable_references, dict):
        raise ValueError("Recipe template references are invalid")
    if portable_references:
        references = {}
        for role, reference in portable_references.items():
            if (
                role not in {"flatfield", "darkfield"}
                or not isinstance(reference, dict)
                or set(reference) != {"binding", "selection"}
                or reference["binding"] != role
                or role not in local_sources
            ):
                raise ValueError("Recipe reference role or fields are invalid")
            references[role] = {
                "source_id": local_sources[role]["id"],
                "selection": reference["selection"],
            }
        recipe["references"] = references
    validated = workbench.validate_recipe(
        {
            "source_id": local_sources["primary"]["id"],
            "selection": template["selection"],
            "recipe": recipe,
        }
    )
    normalized_template, normalized_ids = _portable_recipe(validated)
    if normalized_template != template or set(normalized_ids) != set(local_sources):
        raise ValueError("Recipe settings or source roles changed during revalidation")
    document_id = checked_id(recipe_id or package["recipe_id"])
    imported_bindings = {
        role: _source_binding(local_sources[role]) for role in sorted(local_sources)
    }
    document = workbench.project.put_document(
        "recipe",
        document_id,
        {
            "name": package["name"],
            "selection": validated["selection"],
            "recipe": validated["recipe"],
            "recipe_sha256": validated["recipe_sha256"],
            "interchange": {
                "schema": RECIPE_SCHEMA,
                "template_sha256": package["template_sha256"],
                "original_bindings": original,
                "imported_bindings": imported_bindings,
                "exact_source_restore": require_exact_sources,
            },
        },
        expected_revision=expected_revision,
    )
    return {
        "recipe": document,
        "template_sha256": package["template_sha256"],
        "recipe_sha256": validated["recipe_sha256"],
        "bindings": imported_bindings,
    }


def _path_redacted_source(record: dict[str, Any]) -> dict[str, Any]:
    public = ResearchProject.public_source(record)
    kind = public.get("source_kind", "native")
    hint: dict[str, Any] = {}
    if kind == "ome_zarr":
        locator = record.get("private_zarr_selection", {})
        hint = {
            "image_group": locator.get("image_group", ""),
            "multiscale_index": locator.get("multiscale_index"),
        }
    elif kind == "medical":
        selection = record.get("private_medical_selection")
        hint = {"selection_kind": "series" if isinstance(selection, list) else "file"}
        if isinstance(selection, list):
            hint["file_count"] = len(selection)
    public["locator_state"] = "relink-required"
    public["relink_hint"] = hint
    return public


def _path_redacted_document(envelope: dict[str, Any]) -> dict[str, Any]:
    output = {**envelope}
    data = envelope.get("data")
    if envelope.get("kind") == "model":
        if not isinstance(data, dict):
            raise ValueError("Managed model document is invalid")
        output["data"] = {
            key: value for key, value in data.items() if not key.startswith("private_")
        }
        output["data"]["interchange_state"] = "model-package-not-included"
        output["data"]["recovery"] = "reimport-the-exact-declared-package-before-use"
    elif envelope.get("kind") == "policy":
        if not isinstance(data, dict):
            raise ValueError("Remote policy document is invalid")
        output["data"] = {
            key: value for key, value in data.items() if not key.startswith("private_")
        }
        output["data"]["interchange_state"] = "remote-credentials-and-locators-not-included"
        if data.get("schema") == "loci.remote-run-state/v1":
            output["data"]["interchange"] = {
                "historical": True,
                "original_state": data.get("state"),
                "original_remote_state": data.get("remote_state"),
                "historical_remote_job_id": data.get("remote_job_id"),
            }
            output["data"].update(
                state="interrupted",
                remote_job_id=None,
                remote_state="not-connected-after-interchange",
                cancel_requested=True,
            )
    return output


def _historical_job(record: dict[str, Any]) -> dict[str, Any]:
    output = {key: value for key, value in record.items() if key != "pid"}
    original_state = output.get("state")
    if original_state in {"queued", "running"}:
        stopped_at = (
            output.get("finished_at") or output.get("updated_at") or output.get("created_at")
        )
        output.update(
            state="interrupted",
            cancel_requested=True,
            error="Imported historical job was not resumed",
            finished_at=stopped_at,
            updated_at=stopped_at,
        )
    output["interchange"] = {
        "historical": True,
        "original_state": original_state,
        "external_process_identity_included": False,
    }
    return output


def _database_snapshot(project: ResearchProject) -> dict[str, Any]:
    with project.connection() as connection:
        sources = [
            parse_json(row[0])
            for row in connection.execute("SELECT record FROM sources ORDER BY id")
        ]
        documents = [
            parse_json(row[0])
            for row in connection.execute("SELECT record FROM documents ORDER BY kind,id")
        ]
        results = [
            parse_json(row[0])
            for row in connection.execute("SELECT record FROM results ORDER BY id")
        ]
        jobs = [
            parse_json(row[0]) for row in connection.execute("SELECT record FROM jobs ORDER BY id")
        ]
        reviews = [
            parse_json(row[0])
            for row in connection.execute(
                "SELECT value FROM metadata WHERE key LIKE 'review:%' ORDER BY key"
            )
        ]
        metadata = parse_json(
            connection.execute("SELECT value FROM metadata WHERE key='project'").fetchone()[0]
        )
    return {
        "project": metadata,
        "sources": sources,
        "documents": documents,
        "results": results,
        "jobs": jobs,
        "reviews": reviews,
    }


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o600) << 16
    return info


def _archive_records(project: ResearchProject, snapshot: dict[str, Any]) -> dict[str, bytes]:
    records: dict[str, bytes] = {}
    for source in snapshot["sources"]:
        source = _path_redacted_source(source)
        records[f"sources/{source['id']}.json"] = canonical_json(source).encode()
    for envelope in snapshot["documents"]:
        if envelope["kind"] == "workspace":
            from .research_workspace_records import validate_visibility

            if envelope["id"] != snapshot["project"]["project_id"]:
                raise ValueError("Workspace visibility belongs to a different study")
            validate_visibility(
                envelope["data"],
                {item["id"]: item for item in snapshot["sources"]},
                {item["id"]: item for item in snapshot["results"]},
            )
        envelope = _path_redacted_document(envelope)
        records[f"documents/{envelope['kind']}/{envelope['id']}.json"] = canonical_json(
            envelope
        ).encode()
    for result in snapshot["results"]:
        records[f"results/{result['id']}.json"] = canonical_json(result).encode()
    for job in snapshot["jobs"]:
        job = _historical_job(job)
        records[f"jobs/{job['id']}.json"] = canonical_json(job).encode()
    for review in snapshot["reviews"]:
        records[f"reviews/{review['result_id']}.json"] = canonical_json(review).encode()
    for name, encoded in records.items():
        _reject_absolute_strings(parse_json(encoded.decode()), name)
    return records


def export_project(project: ResearchProject, destination: str | Path) -> dict[str, Any]:
    """Publish a deterministic, path-redacted study archive at an absent path."""

    if not isinstance(project, ResearchProject):
        raise ValueError("Project export requires an open ResearchProject")
    target = Path(destination).expanduser()
    if not target.is_absolute():
        raise ValueError("Study interchange destination must be absolute")
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    if target.exists() or target.is_symlink():
        raise ValueError("Study interchange destination must be absent")
    if target == project.root or project.root.is_relative_to(target):
        raise ValueError("Study interchange cannot replace its source study")
    parent_identity = (parent.stat().st_dev, parent.stat().st_ino)
    snapshot = _database_snapshot(project)
    for source in snapshot["sources"]:
        if source.get("locator_state") != "relink-required":
            project.source(source["id"], verify=True)
    records = _archive_records(project, snapshot)
    artifacts: dict[str, Path] = {}
    for result in snapshot["results"]:
        project.result(result["id"])
        for descriptor in result.get("arrays", {}).values():
            project.load_array(descriptor)
            artifacts[descriptor["sha256"]] = project.arrays / (descriptor["sha256"] + ".npy")
    for review in snapshot["reviews"]:
        project.review_state(review["result_id"])
    if len(records) + len(artifacts) + 1 > MAX_ARCHIVE_MEMBERS:
        raise ValueError("Study interchange exceeds its member-count bound")
    total = sum(len(value) for value in records.values()) + sum(
        path.stat().st_size for path in artifacts.values()
    )
    if total > MAX_ARCHIVE_BYTES:
        raise ValueError("Study interchange exceeds its expanded byte bound")
    members = [
        {
            "path": name,
            "sha256": _sha256_bytes(encoded),
            "size_bytes": len(encoded),
            "media_type": "application/json",
        }
        for name, encoded in records.items()
    ]
    for digest, path in artifacts.items():
        actual, size = _sha256_file_stable(path, reject_symlink=True)
        if actual != digest:
            raise ValueError("A study artifact changed during interchange export")
        members.append(
            {
                "path": f"artifacts/{digest}.npy",
                "sha256": digest,
                "size_bytes": size,
                "media_type": "application/x-npy",
            }
        )
    members.sort(key=lambda item: item["path"])
    manifest = {
        "schema": PROJECT_SCHEMA,
        "project": snapshot["project"],
        "members": members,
        "raw_sources_included": False,
        "source_locators_included": False,
        "managed_model_packages_included": False,
        "active_external_process_identities_included": False,
        "historical_remote_job_identity_evidence": "retained-but-non-resumable",
    }
    _reject_absolute_strings(manifest, "study manifest")
    manifest_bytes = canonical_json(manifest).encode()
    descriptor, temporary = tempfile.mkstemp(prefix=".loci-study-export-", dir=parent)
    os.close(descriptor)
    temporary_path = Path(temporary)
    try:
        with zipfile.ZipFile(
            temporary_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True
        ) as archive:
            for member in members:
                name = member["path"]
                if name in records:
                    archive.writestr(_zip_info(name), records[name])
                else:
                    source_path = artifacts[Path(name).stem]
                    with (
                        archive.open(
                            _zip_info(name),
                            "w",
                            force_zip64=member["size_bytes"] >= zipfile.ZIP64_LIMIT,
                        ) as output,
                        source_path.open("rb") as source,
                    ):
                        shutil.copyfileobj(source, output, 1024 * 1024)
            archive.writestr(_zip_info("manifest.json"), manifest_bytes)
        # Windows rejects fsync on a read-only CRT descriptor.
        with temporary_path.open("rb+") as stream:
            os.fsync(stream.fileno())
        if _database_snapshot(project) != snapshot:
            raise ValueError("Study records changed during interchange export")
        for digest, path in artifacts.items():
            if _sha256_file_stable(path, reject_symlink=True)[0] != digest:
                raise ValueError("A study artifact changed before interchange publication")
        for source in snapshot["sources"]:
            if source.get("locator_state") != "relink-required":
                project.source(source["id"], verify=True)
        current = parent.stat()
        if (current.st_dev, current.st_ino) != parent_identity:
            raise ValueError("Study interchange directory changed before publication")
        _rename_noreplace(temporary_path, target)
        _fsync_directory(parent)
    finally:
        with suppress(FileNotFoundError):
            temporary_path.unlink()
    digest, size = _sha256_file_stable(target, reject_symlink=True)
    return {
        "schema": PROJECT_SCHEMA,
        "export_name": target.name,
        "archive_sha256": digest,
        "archive_bytes": size,
        "member_count": len(members) + 1,
        "raw_sources_included": False,
    }


def _validate_member(info: zipfile.ZipInfo) -> None:
    mode = info.external_attr >> 16
    path = PurePosixPath(info.filename)
    if (
        info.filename == ""
        or info.is_dir()
        or path.is_absolute()
        or str(path) != info.filename
        or any(part in {"", ".", ".."} for part in path.parts)
        or info.compress_type != zipfile.ZIP_STORED
        or info.compress_size != info.file_size
        or info.flag_bits != 0
        or info.create_system != 3
        or not stat.S_ISREG(mode)
        or stat.S_IMODE(mode) != 0o600
        or info.date_time != (1980, 1, 1, 0, 0, 0)
        or not _valid_zip_extra(info.extra)
        or info.comment
    ):
        raise ValueError("Study archive contains an unsafe or non-canonical member")
    if info.filename != "manifest.json" and not _MEMBER_PATTERN.fullmatch(info.filename):
        raise ValueError("Study archive contains an unsupported member path")


def _valid_zip_extra(encoded: bytes) -> bool:
    """Allow only the standard ZIP64 sizes/offset metadata needed by large studies."""

    offset = 0
    seen_zip64 = False
    while offset < len(encoded):
        if len(encoded) - offset < 4:
            return False
        identifier, size = struct.unpack_from("<HH", encoded, offset)
        offset += 4
        if offset + size > len(encoded) or identifier != 0x0001 or seen_zip64:
            return False
        if size not in {8, 16, 24, 28}:
            return False
        seen_zip64 = True
        offset += size
    return offset == len(encoded)


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo, maximum: int) -> bytes:
    if info.file_size < 0 or info.file_size > maximum:
        raise ValueError("Study archive member exceeds its byte bound")
    with archive.open(info, "r") as stream:
        encoded = stream.read(maximum + 1)
    if len(encoded) != info.file_size or len(encoded) > maximum:
        raise ValueError("Study archive member size changed while reading")
    return encoded


def _valid_descriptor(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"sha256", "bytes", "shape", "dtype"}:
        raise ValueError("Result array artifact descriptor is invalid")
    digest = value["sha256"]
    if not isinstance(digest, str) or not SHA_PATTERN.fullmatch(digest):
        raise ValueError("Result array artifact identity is invalid")
    if (
        isinstance(value["bytes"], bool)
        or not isinstance(value["bytes"], int)
        or not 1 <= value["bytes"] <= MAX_ARTIFACT_BYTES + 4096
        or not isinstance(value["shape"], list)
        or not 1 <= len(value["shape"]) <= 5
        or any(
            isinstance(item, bool) or not isinstance(item, int) or item <= 0
            for item in value["shape"]
        )
        or not isinstance(value["dtype"], str)
    ):
        raise ValueError("Result array artifact geometry or size is invalid")
    return value


def _validate_source(record: Any, expected_id: str) -> dict[str, Any]:
    if not isinstance(record, dict) or record.get("id") != expected_id:
        raise ValueError("Interchanged source identity is invalid")
    checked_id(record["id"])
    checked_text(record.get("name"), "Source name")
    if not isinstance(record.get("sha256"), str) or not SHA_PATTERN.fullmatch(record["sha256"]):
        raise ValueError("Interchanged source fingerprint is invalid")
    if (
        isinstance(record.get("size_bytes"), bool)
        or not isinstance(record.get("size_bytes"), int)
        or record["size_bytes"] < 0
    ):
        raise ValueError("Interchanged source size is invalid")
    if record.get("source_kind", "native") not in {"native", "whole_slide", "ome_zarr", "medical"}:
        raise ValueError("Interchanged source kind is invalid")
    if record.get("locator_state") != "relink-required" or not isinstance(
        record.get("relink_hint"), dict
    ):
        raise ValueError("Interchanged source must explicitly require relinking")
    if not isinstance(record.get("metadata"), dict):
        raise ValueError("Interchanged source metadata is invalid")
    if "derivation" in record:
        from .research_vendor import validate_derivation

        validate_derivation(record["derivation"], record["sha256"])
    metadata_identity = record["metadata"].get("sha256")
    if metadata_identity is not None and metadata_identity != record["sha256"]:
        raise ValueError("Interchanged source metadata fingerprint is inconsistent")
    if any(key.startswith("private_") for key in record):
        raise ValueError("Interchanged source contains a private locator")
    _reject_absolute_strings(record, "source record")
    return record


def _validate_document(record: Any, kind: str, expected_id: str) -> dict[str, Any]:
    if (
        kind not in _RECORD_KINDS
        or not isinstance(record, dict)
        or record.get("kind") != kind
        or record.get("id") != expected_id
        or isinstance(record.get("revision"), bool)
        or not isinstance(record.get("revision"), int)
        or record["revision"] < 1
        or not isinstance(record.get("data"), dict)
    ):
        raise ValueError("Interchanged document envelope is invalid")
    _reject_absolute_strings(record, "document record")
    if kind == "model" and record["data"].get("interchange_state") != "model-package-not-included":
        raise ValueError("Interchanged managed model must declare its unavailable package")
    if kind == "policy" and record["data"].get("interchange_state") != (
        "remote-credentials-and-locators-not-included"
    ):
        raise ValueError("Interchanged remote policy must declare unavailable credentials")
    return record


def _validate_result(record: Any, expected_id: str) -> dict[str, Any]:
    if (
        not isinstance(record, dict)
        or record.get("id") != expected_id
        or record.get("schema") != "loci.research-result/v1"
        or not isinstance(record.get("arrays"), dict)
        or not 1 <= len(record["arrays"]) <= 16
        or not isinstance(record.get("provenance"), dict)
    ):
        raise ValueError("Interchanged result record is invalid")
    checked_id(record.get("source_id"))
    if record.get("parent_id") is not None:
        checked_id(record["parent_id"])
    if not isinstance(record.get("source_sha256"), str) or not SHA_PATTERN.fullmatch(
        record["source_sha256"]
    ):
        raise ValueError("Interchanged result source fingerprint is invalid")
    for name, descriptor in record["arrays"].items():
        if not isinstance(name, str) or not ARRAY_NAME_PATTERN.fullmatch(name):
            raise ValueError("Interchanged result artifact name is invalid")
        _valid_descriptor(descriptor)
    unhashed = {key: value for key, value in record.items() if key != "revision_hash"}
    if _sha256_bytes(canonical_json(unhashed).encode()) != record.get("revision_hash"):
        raise ValueError("Interchanged result revision hash is invalid")
    _reject_absolute_strings(record, "result record")
    return record


def _validate_job(record: Any, expected_id: str, result_ids: set[str]) -> dict[str, Any]:
    if not isinstance(record, dict) or record.get("id") != expected_id or "pid" in record:
        raise ValueError("Interchanged job identity or process state is invalid")
    checked_id(record["id"])
    checked_text(record.get("operation"), "Job operation", 64)
    checked_text(record.get("request_key"), "Submission key", 160)
    fingerprint = _sha256_bytes(
        canonical_json(
            {"operation": record["operation"], "request": record.get("request")}
        ).encode()
    )
    if record.get("request_hash") != fingerprint:
        raise ValueError("Interchanged job request fingerprint is invalid")
    if record.get("state") not in {"succeeded", "failed", "cancelled", "interrupted"}:
        raise ValueError("Interchanged jobs must be terminal historical records")
    if not isinstance(record.get("result_ids"), list) or any(
        item not in result_ids for item in record["result_ids"]
    ):
        raise ValueError("Interchanged job result binding is invalid")
    if record.get("interchange", {}).get("historical") is not True:
        raise ValueError("Interchanged job must be marked historical")
    _reject_absolute_strings(record, "job record")
    return record


def _validate_result_crossrefs(
    result: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> None:
    from .research_vendor import verify_result_derivation

    provenance = result["provenance"]
    verify_result_derivation(sources[result["source_id"]], provenance)
    references = provenance.get("references", {})
    if not isinstance(references, dict) or len(references) > 1000:
        raise ValueError("Result source references are invalid")
    for reference in references.values():
        if not isinstance(reference, dict):
            raise ValueError("Result source reference is invalid")
        source_id = reference.get("source_id")
        source = sources.get(source_id)
        if source is None or reference.get("source_sha256") != source["sha256"]:
            raise ValueError("Result source reference is missing or fingerprint-mismatched")

    result_bindings: list[Any] = []
    temporal = provenance.get("temporal_inputs", [])
    if not isinstance(temporal, list) or len(temporal) > 1000:
        raise ValueError("Result temporal bindings are invalid")
    result_bindings.extend(temporal)
    association = provenance.get("association_inputs", {})
    if not isinstance(association, dict) or len(association) > 32:
        raise ValueError("Result association bindings are invalid")
    result_bindings.extend(association.values())
    result_bindings.extend(
        provenance[key]
        for key in ("parent_result", "fixed_result", "moving_result")
        if key in provenance
    )
    for binding in result_bindings:
        if not isinstance(binding, dict):
            raise ValueError("Result revision binding is invalid")
        if binding.get("missing_reason"):
            continue
        bound = results.get(binding.get("result_id"))
        if (
            bound is None
            or binding.get("revision_hash") != bound["revision_hash"]
            or binding.get("source_id") not in {None, bound["source_id"]}
            or binding.get("source_sha256") not in {None, bound["source_sha256"]}
        ):
            raise ValueError("Result revision reference is missing or stale")

    annotations = provenance.get("annotations", [])
    if not isinstance(annotations, list) or len(annotations) > 1000:
        raise ValueError("Result annotations are invalid")
    if annotations:
        from .research_annotations import roi_from_geojson

        for annotation in annotations:
            if not isinstance(annotation, dict) or not isinstance(annotation.get("geojson"), dict):
                raise ValueError("Result annotation record is invalid")
            roi = roi_from_geojson(annotation["geojson"])
            parent = results.get(annotation.get("parent_result_id"))
            if (
                annotation.get("id") != roi.annotation_id
                or parent is None
                or parent["revision_hash"] != roi.result_sha256
                or parent["source_sha256"] != roi.source_sha256
                or result["source_sha256"] != roi.source_sha256
                or canonical_json(roi.geometry.to_dict())
                != canonical_json(provenance.get("geometry"))
            ):
                raise ValueError("Result annotation lost its source, revision, or geometry binding")


def _validate_document_crossrefs(
    document: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> None:
    kind = document["kind"]
    data = document["data"]
    if kind == "workspace":
        from .research_workspace_records import validate_visibility

        validate_visibility(data, sources, results)
    if kind == "display" and data.get("schema") == "loci.source-view/v1":
        from .source_view_state import validate_view_data

        source = sources.get(document["id"])
        if source is None:
            raise ValueError("Saved view source is missing")
        validate_view_data(data, source)
    if kind == "annotations" and data.get("schema") == "loci.source-annotations/v1":
        from .source_annotations import validate_annotation_data

        source = sources.get(document["id"])
        if source is None:
            raise ValueError("Raw annotation source is missing")
        validate_annotation_data(data, source)
    if kind in {"sample", "display", "channels", "selection"} and document["id"] not in sources:
        raise ValueError("Source-scoped document has no matching source")
    if kind == "channels":
        source = sources[document["id"]]
        if data.get("source_sha256") != source["sha256"]:
            raise ValueError("Channel document source fingerprint is stale")
    if kind == "selection":
        selected = results.get(data.get("result_id"))
        if (
            selected is None
            or selected["source_id"] != document["id"]
            or selected["revision_hash"] != data.get("revision_hash")
        ):
            raise ValueError("Selection document result revision is stale")
    if kind == "recipe":
        recipe = data.get("recipe")
        if not isinstance(recipe, dict):
            raise ValueError("Recipe document settings are invalid")
        recipe_sha256 = data.get("recipe_sha256")
        if recipe_sha256 is not None and recipe_sha256 != _sha256_bytes(
            canonical_json(recipe).encode()
        ):
            raise ValueError("Recipe document settings digest is stale")
        references = recipe.get("references", {})
        if not isinstance(references, dict) or any(
            not isinstance(reference, dict) or reference.get("source_id") not in sources
            for reference in references.values()
        ):
            raise ValueError("Recipe document source reference is missing")
    if kind == "comparison":
        _validate_comparison_document(document, results)


def _validate_comparison_document(
    document: dict[str, Any], results: dict[str, dict[str, Any]]
) -> None:
    from .study_analysis import compare_runs, summarize_measurements, validate_sample_metadata

    data = document["data"]
    if set(data) != {"request", "receipt"}:
        raise ValueError("Study comparison document fields are invalid")
    request = data["request"]
    receipt = data["receipt"]
    if (
        not isinstance(request, dict)
        or set(request) != {"left_result_ids", "right_result_ids", "value"}
        or request["value"] != "measure"
        or not isinstance(receipt, dict)
    ):
        raise ValueError("Study comparison request or receipt is invalid")
    if (
        set(receipt)
        != {
            "schema",
            "value",
            "unit",
            "method",
            "run_scope",
            "independent_n_basis",
            "left",
            "right",
            "comparisons",
            "p_values",
            "interpretation",
            "receipt_sha256",
        }
        or receipt.get("schema") != "loci.study-run-comparison/v1"
    ):
        raise ValueError("Study comparison receipt fields are invalid")

    records_by_side: dict[str, list[dict[str, Any]]] = {}
    scopes_by_side: dict[str, dict[str, Any]] = {}
    samples_by_side: dict[str, dict[str, Any]] = {}
    for side, request_key in (("left", "left_result_ids"), ("right", "right_result_ids")):
        result_ids = request[request_key]
        group = receipt.get(side)
        bindings = group.get("bindings") if isinstance(group, dict) else None
        if (
            not isinstance(result_ids, list)
            or not 1 <= len(result_ids) <= 10_000
            or any(not isinstance(result_id, str) for result_id in result_ids)
            or len(set(result_ids)) != len(result_ids)
            or not isinstance(group, dict)
            or set(group) != {"bindings", "summaries", "replicates", "record_audit"}
            or not isinstance(bindings, list)
            or len(bindings) != len(result_ids)
        ):
            raise ValueError("Study comparison result bindings are invalid")
        records = []
        scopes = {}
        samples = {}
        for result_id, binding in zip(result_ids, bindings, strict=True):
            result = results.get(result_id)
            if not isinstance(binding, dict) or result is None:
                raise ValueError("Study comparison result binding is missing")
            provenance = result["provenance"]
            scope = {
                "selection": provenance.get("selection"),
                "geometry": provenance["geometry"],
            }
            review = binding.get("review")
            sample_document = binding.get("sample_document")
            if (
                set(binding)
                != {
                    "result_id",
                    "revision_hash",
                    "source_id",
                    "source_sha256",
                    "review",
                    "sample_document",
                    "scope",
                }
                or binding.get("result_id") != result_id
                or binding.get("revision_hash") != result["revision_hash"]
                or binding.get("source_id") != result["source_id"]
                or binding.get("source_sha256") != result["source_sha256"]
                or binding.get("scope") != scope
                or not isinstance(review, dict)
                or set(review)
                != {"result_id", "revision_hash", "disposition", "reviewed_at", "actor"}
                or review.get("result_id") != result_id
                or review.get("revision_hash") != result["revision_hash"]
                or review.get("disposition") not in {"reviewed", "excluded"}
                or review.get("actor") != "human"
                or not isinstance(review.get("reviewed_at"), str)
                or not review["reviewed_at"]
                or not isinstance(sample_document, dict)
                or set(sample_document) != {"revision", "data"}
                or isinstance(sample_document.get("revision"), bool)
                or not isinstance(sample_document.get("revision"), int)
                or sample_document["revision"] < 1
            ):
                raise ValueError("Study comparison result binding is stale or invalid")
            checked_text(review["reviewed_at"], "Comparison review time", 128)
            metadata = validate_sample_metadata(sample_document.get("data")).to_dict()
            source_id = result["source_id"]
            if source_id in scopes:
                raise ValueError("Study comparison contains a duplicate source")
            scopes[source_id] = scope
            samples[source_id] = sample_document
            records.append(
                {
                    "source_id": source_id,
                    "result_id": result_id,
                    "revision_hash": result["revision_hash"],
                    "review": review,
                    "metadata": metadata,
                    "objects": provenance.get("measurements", []),
                    "method": provenance.get("recipe_sha256")
                    or _sha256_bytes(canonical_json(provenance.get("recipe")).encode()),
                    "run_scope": canonical_json(
                        {
                            "axes": provenance["geometry"]["axes"],
                            "measurement_basis": provenance.get("measurement_basis"),
                        }
                    ),
                    "excluded": review["disposition"] == "excluded",
                }
            )
        records_by_side[side] = records
        scopes_by_side[side] = scopes
        samples_by_side[side] = samples

    if set(request["left_result_ids"]) & set(request["right_result_ids"]):
        raise ValueError("Study comparison groups overlap")
    if scopes_by_side["left"] != scopes_by_side["right"]:
        raise ValueError("Study comparison source scope bindings are incompatible")
    if samples_by_side["left"] != samples_by_side["right"]:
        raise ValueError("Study comparison source sample metadata bindings are incompatible")
    left_summary = summarize_measurements(records_by_side["left"], value=request["value"])
    right_summary = summarize_measurements(records_by_side["right"], value=request["value"])
    comparison = compare_runs(
        records_by_side["left"], records_by_side["right"], value=request["value"]
    )
    expected_receipt = {
        "schema": "loci.study-run-comparison/v1",
        "value": comparison["value"],
        "unit": comparison["unit"],
        "method": left_summary["method"],
        "run_scope": left_summary["run_scope"],
        "independent_n_basis": left_summary["independent_n_basis"],
        "left": {
            "bindings": receipt["left"]["bindings"],
            "summaries": left_summary["summaries"],
            "replicates": left_summary["replicates"],
            "record_audit": left_summary["record_audit"],
        },
        "right": {
            "bindings": receipt["right"]["bindings"],
            "summaries": right_summary["summaries"],
            "replicates": right_summary["replicates"],
            "record_audit": right_summary["record_audit"],
        },
        "comparisons": comparison["comparisons"],
        "p_values": comparison["p_values"],
        "interpretation": comparison["interpretation"],
    }
    expected_receipt["receipt_sha256"] = _sha256_bytes(canonical_json(expected_receipt).encode())
    if receipt != expected_receipt:
        raise ValueError("Study comparison receipt is not reproducible from its exact bindings")
    if document["id"] != expected_receipt["receipt_sha256"][:32]:
        raise ValueError("Study comparison document identity is invalid")


def _load_npy_file(path: Path, descriptor: dict[str, Any]) -> None:
    array = np.load(path, allow_pickle=False, mmap_mode="r", max_header_size=16384)
    if (
        array.dtype.kind not in "buif"
        or array.nbytes > MAX_ARTIFACT_BYTES
        or list(array.shape) != descriptor["shape"]
        or str(array.dtype) != descriptor["dtype"]
        or not np.isfinite(array).all()
    ):
        raise ValueError("Interchanged NPY artifact violates its numerical contract")


def import_project(
    archive_path: str | Path,
    destination: str | Path,
    *,
    expected_archive_sha256: str | None = None,
) -> ResearchProject:
    """Verify a study archive, rebuild SQLite, and publish an absent directory."""

    archive_path = Path(archive_path).expanduser()
    if not archive_path.is_absolute() or archive_path.is_symlink() or not archive_path.is_file():
        raise ValueError("Study archive must be an explicitly selected plain file")
    archive_digest, archive_size = _sha256_file_stable(archive_path, reject_symlink=True)
    if archive_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Study archive exceeds its byte bound")
    if expected_archive_sha256 is not None and archive_digest != expected_archive_sha256:
        raise ValueError("Study archive failed its expected SHA-256")
    target = Path(destination).expanduser()
    if not target.is_absolute():
        raise ValueError("Imported study destination must be absolute")
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    if target.exists() or target.is_symlink():
        raise ValueError("Imported study destination must be absent")
    parent_identity = (parent.stat().st_dev, parent.stat().st_ino)
    wrapper = Path(tempfile.mkdtemp(prefix=".loci-study-import-", dir=parent))
    stage = wrapper / "study.loci-study"
    try:
        with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
            if archive.comment:
                raise ValueError("Study archive comment is unsupported")
            infos = archive.infolist()
            if not 2 <= len(infos) <= MAX_ARCHIVE_MEMBERS:
                raise ValueError("Study archive member count is invalid")
            for info in infos:
                _validate_member(info)
            names = [info.filename for info in infos]
            if (
                len(set(names)) != len(names)
                or names[-1] != "manifest.json"
                or names[:-1] != sorted(names[:-1])
            ):
                raise ValueError("Study archive members are duplicate or non-canonical")
            by_name = {info.filename: info for info in infos}
            manifest = parse_json(
                _read_member(archive, by_name["manifest.json"], MAX_JSON_BYTES).decode("utf-8")
            )
            if not isinstance(manifest, dict) or set(manifest) != {
                "schema",
                "project",
                "members",
                "raw_sources_included",
                "source_locators_included",
                "managed_model_packages_included",
                "active_external_process_identities_included",
                "historical_remote_job_identity_evidence",
            }:
                raise ValueError("Study interchange manifest fields are unsupported")
            if (
                manifest["schema"] != PROJECT_SCHEMA
                or manifest["raw_sources_included"] is not False
                or manifest["source_locators_included"] is not False
                or manifest["managed_model_packages_included"] is not False
                or manifest["active_external_process_identities_included"] is not False
                or manifest["historical_remote_job_identity_evidence"]
                != "retained-but-non-resumable"
            ):
                raise ValueError("Study interchange manifest violates the portable profile")
            _reject_absolute_strings(manifest, "study manifest")
            project_meta = manifest["project"]
            if (
                not isinstance(project_meta, dict)
                or project_meta.get("schema") != "loci.study/v1"
                or not isinstance(project_meta.get("project_id"), str)
            ):
                raise ValueError("Study project metadata is invalid")
            checked_id(project_meta["project_id"])
            checked_text(project_meta.get("title"), "Study title")
            disk_budget = project_meta.get("disk_budget_bytes", DEFAULT_DISK_BUDGET)
            if (
                isinstance(disk_budget, bool)
                or not isinstance(disk_budget, int)
                or not 1024**2 <= disk_budget <= MAX_ARCHIVE_BYTES
            ):
                raise ValueError("Study disk budget is invalid")
            members = manifest["members"]
            if not isinstance(members, list) or len(members) != len(names) - 1:
                raise ValueError("Study member manifest length is invalid")
            member_paths: list[str] = []
            expected_total = 0
            for member in members:
                if not isinstance(member, dict) or set(member) != {
                    "path",
                    "sha256",
                    "size_bytes",
                    "media_type",
                }:
                    raise ValueError("Study member manifest entry is invalid")
                name = member["path"]
                if not isinstance(name, str) or not _MEMBER_PATTERN.fullmatch(name):
                    raise ValueError("Study member manifest path is invalid")
                if not isinstance(member["sha256"], str) or not SHA_PATTERN.fullmatch(
                    member["sha256"]
                ):
                    raise ValueError("Study member manifest hash is invalid")
                if (
                    isinstance(member["size_bytes"], bool)
                    or not isinstance(member["size_bytes"], int)
                    or not 1 <= member["size_bytes"] <= MAX_ARTIFACT_BYTES + 4096
                    or member["media_type"] not in {"application/json", "application/x-npy"}
                ):
                    raise ValueError("Study member manifest size or media type is invalid")
                member_paths.append(name)
                expected_total += member["size_bytes"]
            if member_paths != sorted(set(member_paths)) or member_paths != names[:-1]:
                raise ValueError("Study ZIP members disagree with its manifest")
            if expected_total > min(
                MAX_ARCHIVE_BYTES,
                project_meta.get("disk_budget_bytes", DEFAULT_DISK_BUDGET) + 512 * 1024**2,
            ):
                raise ValueError("Study archive expands beyond its declared project budget")
            sources: list[dict[str, Any]] = []
            documents: list[dict[str, Any]] = []
            results: list[dict[str, Any]] = []
            jobs_raw: list[tuple[dict[str, Any], str]] = []
            reviews: list[dict[str, Any]] = []
            artifact_members: dict[str, tuple[zipfile.ZipInfo, dict[str, Any]]] = {}
            for member in members:
                info = by_name[member["path"]]
                if info.file_size != member["size_bytes"]:
                    raise ValueError("Study archive member size disagrees with its manifest")
                if member["media_type"] == "application/json":
                    encoded = _read_member(archive, info, MAX_JSON_BYTES)
                    if _sha256_bytes(encoded) != member["sha256"]:
                        raise ValueError("Study archive JSON member failed its manifest hash")
                    record = parse_json(encoded.decode("utf-8"))
                    parts = PurePosixPath(member["path"]).parts
                    expected_id = Path(parts[-1]).stem
                    if parts[0] == "sources":
                        sources.append(_validate_source(record, expected_id))
                    elif parts[0] == "documents":
                        documents.append(_validate_document(record, parts[1], expected_id))
                    elif parts[0] == "results":
                        results.append(_validate_result(record, expected_id))
                    elif parts[0] == "jobs":
                        jobs_raw.append((record, expected_id))
                    elif parts[0] == "reviews":
                        reviews.append(record)
                else:
                    if not member["path"].startswith("artifacts/"):
                        raise ValueError("NPY member escaped the artifact namespace")
                    artifact_members[Path(member["path"]).stem] = (info, member)
            source_by_id = {item["id"]: item for item in sources}
            result_by_id = {item["id"]: item for item in results}
            if len(source_by_id) != len(sources) or len(result_by_id) != len(results):
                raise ValueError("Study records contain duplicate identities")
            referenced_artifacts: dict[str, dict[str, Any]] = {}
            for result in results:
                source = source_by_id.get(result["source_id"])
                if source is None or source["sha256"] != result["source_sha256"]:
                    raise ValueError("Result source binding is missing or mismatched")
                if result["parent_id"] is not None:
                    parent_result = result_by_id.get(result["parent_id"])
                    if parent_result is None or parent_result["source_id"] != result["source_id"]:
                        raise ValueError("Result parent binding is missing or mismatched")
                for descriptor in result["arrays"].values():
                    old = referenced_artifacts.setdefault(descriptor["sha256"], descriptor)
                    if old != descriptor:
                        raise ValueError("One artifact hash has conflicting descriptors")
            for result in results:
                _validate_result_crossrefs(result, source_by_id, result_by_id)
            for document in documents:
                if document["kind"] == "workspace" and document["id"] != project_meta["project_id"]:
                    raise ValueError("Workspace visibility belongs to a different study")
                _validate_document_crossrefs(document, source_by_id, result_by_id)
            if set(artifact_members) != set(referenced_artifacts):
                raise ValueError("Study artifact members do not exactly match result records")
            result_ids = set(result_by_id)
            jobs = [
                _validate_job(record, expected_id, result_ids) for record, expected_id in jobs_raw
            ]
            review_by_result = {}
            for review in reviews:
                if (
                    not isinstance(review, dict)
                    or set(review)
                    != {
                        "result_id",
                        "revision_hash",
                        "disposition",
                        "reviewed_at",
                        "actor",
                    }
                    or review.get("result_id") not in result_by_id
                    or review.get("revision_hash")
                    != result_by_id[review["result_id"]]["revision_hash"]
                    or review.get("disposition") not in {"reviewed", "excluded", "pending"}
                    or review.get("actor") != "human"
                    or review["result_id"] in review_by_result
                ):
                    raise ValueError("Interchanged review is stale or invalid")
                review_by_result[review["result_id"]] = review
            project = ResearchProject.create(stage, project_meta["title"])
            for digest, (info, member) in artifact_members.items():
                output = project.arrays / (digest + ".npy")
                hasher = hashlib.sha256()
                written = 0
                with archive.open(info, "r") as source, output.open("xb") as target_stream:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        written += len(chunk)
                        if written > member["size_bytes"]:
                            raise ValueError("Study artifact expanded beyond its manifest size")
                        hasher.update(chunk)
                        target_stream.write(chunk)
                    target_stream.flush()
                    os.fsync(target_stream.fileno())
                if written != member["size_bytes"] or hasher.hexdigest() != digest:
                    raise ValueError("Study artifact failed its manifest hash")
                _load_npy_file(output, referenced_artifacts[digest])
            _fsync_directory(project.arrays)
            with project.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                for table in ("sources", "documents", "results", "jobs", "metadata"):
                    connection.execute(f"DELETE FROM {table}")
                connection.execute(
                    "INSERT INTO metadata VALUES('project',?)", (canonical_json(project_meta),)
                )
                for source in sources:
                    connection.execute(
                        "INSERT INTO sources VALUES(?,?)", (source["id"], canonical_json(source))
                    )
                for document in documents:
                    connection.execute(
                        "INSERT INTO documents VALUES(?,?,?,?)",
                        (
                            document["kind"],
                            document["id"],
                            document["revision"],
                            canonical_json(document),
                        ),
                    )
                for result in results:
                    connection.execute(
                        "INSERT INTO results VALUES(?,?)", (result["id"], canonical_json(result))
                    )
                for job in jobs:
                    connection.execute(
                        "INSERT INTO jobs VALUES(?,?,?,?)",
                        (
                            job["id"],
                            job["request_key"],
                            job["request_hash"],
                            canonical_json(job),
                        ),
                    )
                for review in reviews:
                    connection.execute(
                        "INSERT INTO metadata VALUES(?,?)",
                        ("review:" + review["result_id"], canonical_json(review)),
                    )
            project = ResearchProject(stage)
            for result in results:
                checked = project.result(result["id"])
                for descriptor in checked["arrays"].values():
                    project.load_array(descriptor)
            for review in reviews:
                project.review_state(review["result_id"])
        if _sha256_file_stable(archive_path, reject_symlink=True)[0] != archive_digest:
            raise ValueError("Study archive changed during import")
        current = parent.stat()
        if (current.st_dev, current.st_ino) != parent_identity:
            raise ValueError("Imported study destination directory changed")
        _fsync_directory(stage)
        _rename_noreplace(stage, target)
        _fsync_directory(parent)
        return ResearchProject(target)
    except (KeyError, UnicodeDecodeError, sqlite3.Error, zipfile.BadZipFile) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError("Study archive is malformed or unreadable") from exc
    finally:
        if wrapper.exists() and not wrapper.is_symlink():
            shutil.rmtree(wrapper)


def relink_interchanged_source(
    project: ResearchProject,
    source_id: str,
    candidate: str | Path | list[str],
) -> dict[str, Any]:
    """Relink a path-free imported source to exact local bytes."""

    source = project.source(checked_id(source_id))
    if source.get("locator_state") != "relink-required":
        raise ValueError("Source is not awaiting interchange relinking")
    kind = source.get("source_kind", "native")
    hint = source.get("relink_hint", {})
    if kind in {"native", "whole_slide"}:
        if isinstance(candidate, list):
            raise ValueError("Plain-file relinking requires one selected file")
        path = Path(candidate)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise ValueError("Relink requires an explicitly selected plain file")
        path = path.resolve(strict=True)
        if path.is_relative_to(project.root):
            raise ValueError("Raw sources must remain outside the derived study")
        actual, size = _sha256_file_stable(path, reject_symlink=True)
        if kind == "whole_slide":
            from .slide_adapter import SlideAdapter

            session = SlideAdapter(str(path), expected_sha256=source["sha256"])
            try:
                actual_metadata = session.public_metadata()
            finally:
                session.close()
        else:
            from .native_image import NativeImageSession

            session = NativeImageSession(path, expected_sha256=source["sha256"])
            try:
                actual_metadata = asdict(session.metadata)
            finally:
                session.close()
        private = {"private_path": str(path)}
    elif kind == "ome_zarr":
        if isinstance(candidate, list):
            raise ValueError("OME-Zarr relinking requires one selected directory")
        path = Path(candidate)
        if not path.is_absolute() or path.is_symlink() or not path.is_dir():
            raise ValueError("OME-Zarr relinking requires an explicitly selected directory")
        path = path.resolve(strict=True)
        if path.is_relative_to(project.root) or project.root.is_relative_to(path):
            raise ValueError("OME-Zarr and derived study directories must remain independent")
        from .zarr_adapter import ZarrAdapter

        session = ZarrAdapter(
            str(path),
            image_group=hint.get("image_group", ""),
            multiscale_index=hint.get("multiscale_index"),
            expected_sha256=source["sha256"],
        )
        try:
            receipt = session.verify_strict()
            actual_metadata = session.public_metadata()
        finally:
            session.close()
        actual, size = receipt.content_manifest_sha256, receipt.source_size_bytes
        private = {
            "private_zarr_selection": {
                "path": str(path.resolve(strict=True)),
                "image_group": hint.get("image_group", ""),
                "multiscale_index": hint.get("multiscale_index"),
            }
        }
    elif kind == "medical":
        from .medical_image import inspect_medical

        selected = candidate if isinstance(candidate, list) else str(candidate)
        paths = candidate if isinstance(candidate, list) else [str(candidate)]
        if not paths or any(
            not Path(item).is_absolute() or Path(item).is_symlink() or not Path(item).is_file()
            for item in paths
        ):
            raise ValueError("Medical relinking requires explicit plain local files")
        resolved_paths = [Path(item).resolve(strict=True) for item in paths]
        if any(path.is_relative_to(project.root) for path in resolved_paths):
            raise ValueError("Raw medical sources must remain outside the derived study")
        inspection = inspect_medical(selected)
        actual, size = inspection.source_identity.removeprefix("sha256:"), inspection.encoded_bytes
        actual_metadata = inspection.to_dict()
        private = {
            "private_medical_selection": [str(path) for path in resolved_paths]
            if isinstance(candidate, list)
            else str(Path(candidate).resolve(strict=True))
        }
    else:
        raise ValueError("Imported source kind is unsupported")
    if actual != source["sha256"] or size != source["size_bytes"]:
        raise ValueError("Relink rejected: selected bytes do not exactly match the source")
    if canonical_json(actual_metadata) != canonical_json(source.get("metadata")):
        raise ValueError(
            "Relink rejected: inspected shape, calibration, or metadata differs from the study"
        )
    source.pop("locator_state", None)
    source.pop("relink_hint", None)
    source.update(private, relinked_at=timestamp())
    with project.connection() as connection:
        connection.execute(
            "UPDATE sources SET record=? WHERE id=?", (canonical_json(source), source["id"])
        )
    return project.public_source(source)
