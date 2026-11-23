"""Stream file bytes with the stable descriptor checks used by research artifacts."""

from __future__ import annotations

import hashlib
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any


def _sha256_stream(stream: Any, check: Callable[[], None] | None = None) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        if check is not None:
            check()
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def _sha256_file_stable(
    path: Path, *, reject_symlink: bool, check: Callable[[], None] | None = None
) -> tuple[str, int]:
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
            digest, size = _sha256_stream(stream, check=check)
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
