"""Atomic local Save as; source locators remain private and originals are not copied."""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import stat
import tempfile
from contextlib import closing
from pathlib import Path

from .export import _fsync_directory, _rename_noreplace
from .research_project import ResearchProject, canonical_json, parse_json

CHUNK_BYTES = 1024 * 1024
MAX_FILES = 100_000


def _plain_entry_identity(value: os.stat_result) -> tuple[int, int, int]:
    return value.st_dev, value.st_ino, value.st_mode


def _plain_file_identity(value: os.stat_result) -> tuple[int, int, int, int, int, int]:
    """Return fields stable across an unchanged Windows file handle."""

    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        0 if os.name == "nt" else value.st_ctime_ns,
    )


def _plain_directory_snapshot(
    source: Path,
) -> tuple[
    tuple[int, int, int], list[tuple[Path, os.stat_result]], dict[str, tuple[int, int, int]]
]:
    status = source.lstat()
    if not stat.S_ISDIR(status.st_mode):
        raise ValueError("Study data directories must be plain and unlinked")
    entries = [(item, item.lstat()) for item in sorted(source.iterdir())]
    identities = {item.name: _plain_entry_identity(value) for item, value in entries}
    return _plain_entry_identity(status), entries, identities


def clone_study(project: ResearchProject, destination: str | Path) -> ResearchProject:
    requested = Path(destination).expanduser()
    if not requested.is_absolute() or not requested.name.lower().endswith(".loci-study"):
        raise ValueError("Choose an absolute .loci-study destination")
    parent = requested.parent.resolve(strict=True)
    target = parent / requested.name
    if target.exists() or target.is_symlink() or target.is_relative_to(project.root):
        raise ValueError("Choose an absent destination outside the current study")
    project._check_layout()
    budget = int(project.meta["disk_budget_bytes"])
    files = 0
    copied = 0
    staging = Path(tempfile.mkdtemp(prefix=".loci-save-", dir=parent))
    staging_identity = ResearchProject._directory_identity(staging)
    model_packages: list[tuple[Path, dict]] = []

    def copy_tree(source: Path, output: Path) -> None:
        nonlocal files, copied
        before, entries, before_entries = _plain_directory_snapshot(source)
        output.mkdir(mode=0o700)
        for item, status in entries:
            files += 1
            if files > MAX_FILES:
                raise ValueError("Study entry count exceeds the bounded Save as budget")
            if stat.S_ISDIR(status.st_mode):
                if _plain_entry_identity(item.lstat()) != _plain_entry_identity(status):
                    raise ValueError("Study data changed during Save as")
                copy_tree(item, output / item.name)
                continue
            if not stat.S_ISREG(status.st_mode):
                raise ValueError("Study data contains a linked or non-plain entry")
            copied += status.st_size
            if files > MAX_FILES or copied > budget:
                raise ValueError("Study exceeds the bounded Save as budget")
            descriptor = os.open(item, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            digest = hashlib.sha256()
            with (
                os.fdopen(descriptor, "rb") as incoming,
                (output / item.name).open("xb") as outgoing,
            ):
                actual = os.fstat(incoming.fileno())
                if (actual.st_dev, actual.st_ino) != (status.st_dev, status.st_ino):
                    raise ValueError("Study data changed during Save as")
                while block := incoming.read(CHUNK_BYTES):
                    digest.update(block)
                    outgoing.write(block)
                    if incoming.tell() > status.st_size:
                        raise ValueError("Study data grew during Save as")
                outgoing.flush()
                os.fsync(outgoing.fileno())
                after = os.fstat(incoming.fileno())
            os.chmod(output / item.name, 0o600)
            if _plain_file_identity(after) != _plain_file_identity(status) or _plain_file_identity(
                item.lstat()
            ) != _plain_file_identity(status):
                raise ValueError("Study data changed during Save as")
            if item.parent == project.arrays and digest.hexdigest() != item.stem:
                raise ValueError("Study artifact failed its content identity")
        _fsync_directory(output)
        after, _, after_entries = _plain_directory_snapshot(source)
        if after != before or after_entries != before_entries:
            raise ValueError("Study data directory changed during Save as")

    try:
        # Hold the writer reservation through publication. SQLite backup uses a
        # separate read connection; it snapshots a database with no active writer.
        with project.connection() as guard:
            guard.execute("BEGIN IMMEDIATE")
            jobs = [parse_json(row[0]) for row in guard.execute("SELECT record FROM jobs")]
            if any(job.get("state") in {"queued", "running", "cancelling"} for job in jobs):
                raise ValueError("Wait for or cancel active jobs before Save as")
            with (
                closing(sqlite3.connect(project.database)) as reader,
                closing(sqlite3.connect(staging / "study.sqlite3")) as writer,
            ):
                reader.backup(writer)
                # Only managed model package roots relocate. External source
                # locators, provenance, identities and revisions stay exact.
                for row in writer.execute(
                    "SELECT id,record FROM documents WHERE kind='model'"
                ).fetchall():
                    document = parse_json(row[1])
                    path = document["data"].get("private_path")
                    if path is None:
                        continue
                    original = Path(path)
                    if (
                        not original.is_absolute()
                        or ".." in original.parts
                        or original.is_symlink()
                        or not original.is_dir()
                        or original.resolve(strict=True) != original
                        or original.parent != project.root / "models"
                    ):
                        raise ValueError("Managed model locator escaped its study")
                    from .research_models import _managed_package
                    from .workbench import Workbench

                    _, package = _managed_package(Workbench(project), row[0])
                    model_packages.append(
                        (original.relative_to(project.root), package.public_record())
                    )
                    document["data"]["private_path"] = str(
                        target / original.relative_to(project.root)
                    )
                    writer.execute(
                        "UPDATE documents SET record=? WHERE kind='model' AND id=?",
                        (canonical_json(document), row[0]),
                    )
                writer.commit()
            copy_tree(project.arrays, staging / "artifacts")
            if (project.root / "models").exists() or (project.root / "models").is_symlink():
                copy_tree(project.root / "models", staging / "models")
            if model_packages:
                from .research_models import inspect_model_package

                for relative, expected in model_packages:
                    if inspect_model_package(staging / relative).public_record() != expected:
                        raise ValueError("Saved model package identity changed")
            clone = ResearchProject(staging)
            for result in clone.list_results():
                for artifact in result["arrays"].values():
                    clone.verify_array(artifact)
            project._check_layout()
            os.chmod(clone.database, 0o600)
            # Windows rejects fsync on a read-only CRT descriptor.
            with clone.database.open("rb+") as stream:
                os.fsync(stream.fileno())
            _fsync_directory(staging)
            if ResearchProject._directory_identity(staging) != staging_identity:
                raise ValueError("Save as staging directory identity changed")
            _rename_noreplace(staging, target)
            _fsync_directory(parent)
        return ResearchProject(target)
    except BaseException:
        # Exclusively created staging tree; never target or original sources.
        if staging.exists() and ResearchProject._directory_identity(staging) == staging_identity:
            shutil.rmtree(staging)
        raise
