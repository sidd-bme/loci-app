"""Fail-closed publication of a renderer-staged volume figure bundle."""

from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path
from typing import Any

from .export import _fsync_directory, _rename_noreplace

MAX_PNG_BYTES = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_FILE_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_BINARY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_DIR_FD_AVAILABLE = (
    os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.listdir in os.supports_fd
)


def _identity(value: object, label: str) -> tuple[int, int]:
    if not isinstance(value, dict) or set(value) != {"device", "inode"}:
        raise ValueError(f"{label} identity is invalid.")
    parts: list[int] = []
    for key in ("device", "inode"):
        item = value[key]
        if not isinstance(item, str) or not item.isascii() or not item.isdigit() or len(item) > 32:
            raise ValueError(f"{label} identity is invalid.")
        parts.append(int(item))
    return parts[0], parts[1]


def _matches_identity(value: os.stat_result, identity: tuple[int, int]) -> bool:
    return value.st_dev == identity[0] and value.st_ino == identity[1]


def _artifacts(value: object) -> dict[str, tuple[str, int]]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError("Volume figure artifacts are invalid.")
    result: dict[str, tuple[str, int]] = {}
    limits = {"image.png": MAX_PNG_BYTES, "manifest.json": MAX_MANIFEST_BYTES}
    for item in value:
        if not isinstance(item, dict) or set(item) != {"name", "sha256", "size_bytes"}:
            raise ValueError("Volume figure artifact metadata is invalid.")
        name, digest, size = item["name"], item["sha256"], item["size_bytes"]
        if not isinstance(name, str) or name not in limits or name in result:
            raise ValueError("Volume figure artifact names are invalid.")
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise ValueError("Volume figure artifact hash is invalid.")
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= limits[name]:
            raise ValueError("Volume figure artifact size is invalid.")
        result[name] = (digest, size)
    if set(result) != set(limits):
        raise ValueError("Volume figure artifacts are incomplete.")
    return result


def _verify_file(
    stage_fd: int | None,
    stage: str,
    name: str,
    expected_hash: str,
    expected_size: int,
) -> None:
    path = name if stage_fd is not None else os.path.join(stage, name)
    before = os.lstat(path) if stage_fd is None else None
    if before is not None and (
        not stat.S_ISREG(before.st_mode) or os.path.islink(path) or before.st_nlink != 1
    ):
        raise ValueError(f"Staged {name} is unsafe or has changed.")
    open_options = {"dir_fd": stage_fd} if stage_fd is not None else {}
    descriptor = os.open(path, _FILE_FLAGS, **open_options)
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_nlink != 1
            or details.st_size != expected_size
            or (before is not None and not os.path.samestat(before, details))
        ):
            raise ValueError(f"Staged {name} is unsafe or has changed.")
        digest = hashlib.sha256()
        remaining = expected_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError(f"Staged {name} is truncated.")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1) or digest.hexdigest() != expected_hash:
            raise ValueError(f"Staged {name} has changed.")
        if before is not None and not os.path.samestat(before, os.lstat(path)):
            raise ValueError(f"Staged {name} changed during verification.")
    finally:
        os.close(descriptor)


def publish_volume_figure(params: dict[str, Any]) -> dict[str, Any]:
    """Verify exactly two staged artifacts and atomically publish the directory."""

    accepted = {
        "parent",
        "staging",
        "destination",
        "parent_identity",
        "staging_identity",
        "artifacts",
    }
    if set(params) != accepted:
        raise ValueError("Volume figure publication parameters are invalid.")
    parent, staging, destination = (params[key] for key in ("parent", "staging", "destination"))
    if any(not isinstance(value, str) or "\x00" in value or not os.path.isabs(value)
           for value in (parent, staging, destination)):
        raise ValueError("Volume figure publication paths are invalid.")
    canonical_parent = os.path.realpath(parent)
    if os.path.normcase(os.path.normpath(parent)) != os.path.normcase(canonical_parent):
        raise ValueError("Volume figure parent must be canonical.")
    if os.path.dirname(staging) != parent or os.path.dirname(destination) != parent:
        raise ValueError("Volume figure staging and destination must share their parent.")
    stage_name, destination_name = os.path.basename(staging), os.path.basename(destination)
    if (not stage_name.startswith(".loci-volume-figure-") or
            not destination_name.lower().endswith(".loci-figure") or
            stage_name in {"", ".", ".."} or destination_name in {"", ".", ".."}):
        raise ValueError("Volume figure publication names are invalid.")

    parent_identity = _identity(params["parent_identity"], "Parent")
    staging_identity = _identity(params["staging_identity"], "Staging")
    artifacts = _artifacts(params["artifacts"])
    if not _DIR_FD_AVAILABLE:
        parent_stat = os.lstat(parent)
        stage_stat = os.lstat(staging)
        if (not stat.S_ISDIR(parent_stat.st_mode) or os.path.islink(parent) or
                not _matches_identity(parent_stat, parent_identity)):
            raise ValueError("Volume figure parent identity changed.")
        if (not stat.S_ISDIR(stage_stat.st_mode) or os.path.islink(staging) or
                not _matches_identity(stage_stat, staging_identity) or
                stage_stat.st_dev != parent_stat.st_dev):
            raise ValueError("Volume figure staging identity changed.")
        if set(os.listdir(staging)) != set(artifacts):
            raise ValueError("The staged volume figure must contain exactly two artifacts.")
        for name, (digest, size) in artifacts.items():
            _verify_file(None, staging, name, digest, size)
        if not _matches_identity(os.lstat(staging), staging_identity):
            raise ValueError("Volume figure staging changed before publication.")
        final_parent = os.lstat(parent)
        if (not _matches_identity(final_parent, parent_identity) or
                os.path.realpath(parent) != canonical_parent):
            raise ValueError("Volume figure parent changed before publication.")
        try:
            os.lstat(destination)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(
                "A file or folder already exists at the volume figure destination."
            )
        _rename_noreplace(staging, destination)
        _fsync_directory(Path(parent))
        return {"published": True}

    parent_fd = os.open(parent, _DIRECTORY_FLAGS)
    try:
        parent_stat = os.fstat(parent_fd)
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or not _matches_identity(parent_stat, parent_identity)
        ):
            raise ValueError("Volume figure parent identity changed.")
        stage_fd = os.open(stage_name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        try:
            stage_stat = os.fstat(stage_fd)
            if (not stat.S_ISDIR(stage_stat.st_mode) or
                    not _matches_identity(stage_stat, staging_identity) or
                    stage_stat.st_dev != parent_stat.st_dev):
                raise ValueError("Volume figure staging identity changed.")
            if set(os.listdir(stage_fd)) != set(artifacts):
                raise ValueError("The staged volume figure must contain exactly two artifacts.")
            for name, (digest, size) in artifacts.items():
                _verify_file(stage_fd, staging, name, digest, size)
            current_stage = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
            if not _matches_identity(current_stage, staging_identity):
                raise ValueError("Volume figure staging changed before publication.")
            try:
                os.stat(destination_name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError(
                    "A file or folder already exists at the volume figure destination."
                )
            _rename_noreplace(
                stage_name,
                destination_name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
        finally:
            os.close(stage_fd)
        _fsync_directory(Path(parent))
    finally:
        os.close(parent_fd)
    return {"published": True}
