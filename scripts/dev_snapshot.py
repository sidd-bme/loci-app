#!/usr/bin/env python3
"""Read-only checkout and optional macOS app identity for agent handoffs.

This is an observation, not a test receipt, lock, or atomic working-tree snapshot.
No fetch, build, installation, source-content capture, or status-file write occurs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def git(repo: Path, *args: str, optional: bool = False) -> str | None:
    result = subprocess.run(
        [
            "git",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-C",
            str(repo),
            *args,
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        if optional:
            return None
        raise ValueError(result.stderr.decode("utf-8", "replace").strip())
    return result.stdout.decode("utf-8", "surrogateescape")


def changes(raw: str) -> list[dict[str, str]]:
    entries = iter(raw.rstrip("\0").split("\0") if raw else [])
    result = []
    for entry in entries:
        record = {"index": entry[0], "worktree": entry[1], "path": entry[3:]}
        if "R" in entry[:2] or "C" in entry[:2]:
            record["original_path"] = next(entries)
        result.append(record)
    return result


def artifact_hash(path: Path, app: Path) -> str:
    if path.is_symlink() or not path.resolve().is_relative_to(app):
        raise ValueError(f"Artifact must be a contained regular file: {path}")
    before = path.stat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"Artifact is not a regular file: {path}")
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise ValueError(f"Artifact changed during hashing: {path}")
    return digest.hexdigest()


def snapshot(repo: Path, app: Path | None = None) -> dict:
    root = Path(git(repo, "rev-parse", "--show-toplevel").strip())
    head = git(root, "rev-parse", "HEAD").strip()
    raw = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD", optional=True)
    upstream = git(
        root, "rev-parse", "--symbolic-full-name", "@{upstream}", optional=True
    )
    remote_state = None
    if upstream:
        upstream = upstream.strip()
        upstream_head = git(root, "rev-parse", upstream).strip()
        ahead, behind = map(
            int,
            git(
                root, "rev-list", "--left-right", "--count", f"{head}...{upstream_head}"
            ).split(),
        )
        remote_state = {
            "ref": upstream,
            "commit": upstream_head,
            "ahead": ahead,
            "behind": behind,
            "basis": "local tracking ref only; no network fetch performed",
        }
    result = {
        "schema": "loci.development-observation/v1",
        "observed_at_utc": datetime.now(timezone.utc).isoformat(),
        "repository": str(root),
        "branch": branch.strip() if branch else None,
        "head": head,
        "committed_tree": git(root, "rev-parse", "HEAD^{tree}").strip(),
        "upstream": remote_state,
        "changes": changes(raw),
        "ignored_files_included": False,
        "worktrees_porcelain": git(root, "worktree", "list", "--porcelain"),
        "app": None,
        "limits": [
            "Not a validation receipt or editor lock",
            "Dirty source contents are not captured",
            "Concurrent edits may escape detection; coordinate one writer",
            "No remote freshness assertion",
        ],
    }
    if app is not None:
        if not app.is_absolute():
            raise ValueError(
                "--app must be an absolute path to the selected macOS .app"
            )
        app = app.resolve(strict=True)
        if not app.is_dir() or app.suffix != ".app":
            raise ValueError("--app must select a macOS .app directory")
        paths = {
            "executable": "Contents/MacOS/Loci",
            "app_asar": "Contents/Resources/app.asar",
            "worker": "Contents/Resources/loci-engine/loci-engine",
        }
        result["app"] = {
            "path": str(app),
            "sha256": {
                name: artifact_hash(app / relative, app)
                for name, relative in paths.items()
            },
            "qualification": "Not assessed; compare these hashes with recorded build/test receipts",
        }
    if head != git(root, "rev-parse", "HEAD").strip() or raw != git(
        root, "status", "--porcelain=v1", "-z", "--untracked-files=all"
    ):
        raise ValueError(
            "Checkout changed during observation; coordinate writers and retry"
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument(
        "--app", type=Path, help="Optional absolute macOS app path; never launches it"
    )
    args = parser.parse_args()
    try:
        print(json.dumps(snapshot(args.repo, args.app), indent=2, ensure_ascii=True))
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"Snapshot failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
