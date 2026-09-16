from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import pytest

from scripts.dev_snapshot import changes, snapshot


def command(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


@pytest.fixture
def repo(tmp_path):
    command(tmp_path, "init", "-b", "main")
    command(tmp_path, "config", "user.email", "fixture@example.invalid")
    command(tmp_path, "config", "user.name", "Fixture")
    (tmp_path / "tracked.txt").write_text("original\n")
    (tmp_path / ".gitignore").write_text("private/\n")
    command(tmp_path, "add", "tracked.txt", ".gitignore")
    command(tmp_path, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture")
    return tmp_path


def test_clean_dirty_staged_untracked_and_ignored_are_distinct(repo):
    first = snapshot(repo)
    assert first["changes"] == []
    assert first["upstream"] is None
    (repo / "tracked.txt").write_text("staged\n")
    command(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("unstaged\n")
    (repo / "new file.txt").write_text("new\n")
    (repo / "private").mkdir()
    (repo / "private" / "ignored.txt").write_text("not captured")
    before = command(repo, "diff", "--cached")
    observed = snapshot(repo)
    assert observed["head"] == first["head"]
    assert observed["changes"] == [
        {"index": "M", "worktree": "M", "path": "tracked.txt"},
        {"index": "?", "worktree": "?", "path": "new file.txt"},
    ]
    assert command(repo, "diff", "--cached") == before
    assert (repo / "tracked.txt").read_text() == "unstaged\n"


def test_rename_and_unusual_names_are_preserved():
    assert changes("R  new name\n.txt\0old name.txt\0?? other.txt\0") == [
        {
            "index": "R",
            "worktree": " ",
            "path": "new name\n.txt",
            "original_path": "old name.txt",
        },
        {"index": "?", "worktree": "?", "path": "other.txt"},
    ]


def test_detached_head_is_explicit(repo):
    command(repo, "checkout", "--detach")
    assert snapshot(repo)["branch"] is None


def test_upstream_is_local_observation_not_remote_validation(repo):
    command(repo, "branch", "baseline")
    command(repo, "branch", "--set-upstream-to=baseline")
    result = snapshot(repo)["upstream"]
    assert result["ahead"] == result["behind"] == 0
    assert "no network fetch" in result["basis"]


def test_app_hashes_do_not_imply_qualification(repo, tmp_path):
    app = tmp_path / "Loci.app"
    files = [
        "Contents/MacOS/Loci",
        "Contents/Resources/app.asar",
        "Contents/Resources/loci-engine/loci-engine",
    ]
    for relative in files:
        target = app / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fixture")
    result = snapshot(repo, app)["app"]
    assert set(result["sha256"].values()) == {hashlib.sha256(b"fixture").hexdigest()}
    assert result["qualification"].startswith("Not assessed")
    (app / files[0]).unlink()
    (app / files[0]).symlink_to(repo / "tracked.txt")
    with pytest.raises(ValueError, match="contained regular"):
        snapshot(repo, app)


def test_missing_or_relative_app_fails(repo):
    with pytest.raises(ValueError, match="absolute"):
        snapshot(repo, Path("Loci.app"))
    with pytest.raises(FileNotFoundError):
        snapshot(repo, repo / "absent.app")
