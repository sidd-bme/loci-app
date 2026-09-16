from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from loci_engine import volume_figure_publication as publication
from loci_engine.worker import dispatch


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _request(tmp_path: Path) -> tuple[dict[str, object], Path, Path]:
    staging = tmp_path / ".loci-volume-figure-stage"
    staging.mkdir()
    image = staging / "image.png"
    manifest = staging / "manifest.json"
    image.write_bytes(b"png")
    manifest.write_bytes(b"{}\n")
    parent_stat = tmp_path.stat()
    stage_stat = staging.stat()
    destination = tmp_path / "Figure.loci-figure"
    return (
        {
            "parent": str(tmp_path),
            "staging": str(staging),
            "destination": str(destination),
            "parent_identity": {
                "device": str(parent_stat.st_dev),
                "inode": str(parent_stat.st_ino),
            },
            "staging_identity": {
                "device": str(stage_stat.st_dev),
                "inode": str(stage_stat.st_ino),
            },
            "artifacts": [
                {"name": "image.png", "sha256": _sha256(image), "size_bytes": 3},
                {"name": "manifest.json", "sha256": _sha256(manifest), "size_bytes": 3},
            ],
        },
        staging,
        destination,
    )


def test_worker_publishes_verified_bundle(tmp_path: Path) -> None:
    request, staging, destination = _request(tmp_path)

    assert dispatch("publish_volume_figure", request) == {"published": True}
    assert not staging.exists()
    assert sorted(item.name for item in destination.iterdir()) == ["image.png", "manifest.json"]


def test_rejects_extra_or_changed_staged_artifacts(tmp_path: Path) -> None:
    request, staging, destination = _request(tmp_path)
    (staging / "extra.txt").write_text("unexpected")

    with pytest.raises(ValueError, match="exactly two"):
        publication.publish_volume_figure(request)
    assert staging.is_dir()
    assert not destination.exists()

    (staging / "extra.txt").unlink()
    (staging / "image.png").write_bytes(b"bad")
    with pytest.raises(ValueError, match="has changed"):
        publication.publish_volume_figure(request)


def test_native_publish_refuses_raced_empty_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, staging, destination = _request(tmp_path)
    original = publication._rename_noreplace

    def race(source: str, target: str, **kwargs: object) -> None:
        destination.mkdir()
        original(source, target, **kwargs)

    monkeypatch.setattr(publication, "_rename_noreplace", race)
    with pytest.raises(FileExistsError):
        publication.publish_volume_figure(request)
    assert staging.is_dir()
    assert destination.is_dir()


def test_native_publish_refuses_raced_symlink_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, staging, destination = _request(tmp_path)
    redirect = tmp_path / "redirect"
    redirect.mkdir()
    original = publication._rename_noreplace

    def race(source: str, target: str, **kwargs: object) -> None:
        os.symlink(redirect, destination)
        original(source, target, **kwargs)

    monkeypatch.setattr(publication, "_rename_noreplace", race)
    with pytest.raises(FileExistsError):
        publication.publish_volume_figure(request)
    assert staging.is_dir()
    assert destination.is_symlink()
