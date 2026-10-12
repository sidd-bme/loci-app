from __future__ import annotations

import hashlib
import os

import pytest

from loci_engine import statistics_figure_publication as publication


def setup(tmp_path):
    staging = tmp_path / ".loci-statistics-figure-stage"
    staging.mkdir()
    artifacts = []
    for name in ("figure.png", "figure.svg", "manifest.json"):
        data = name.encode()
        (staging / name).write_bytes(data)
        artifacts.append(
            {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}
        )
    parent_stat, stage_stat = tmp_path.stat(), staging.stat()
    destination = tmp_path / "Statistics.loci-figure"
    return (
        {
            "parent": str(tmp_path),
            "staging": str(staging),
            "destination": str(destination),
            "parent_identity": {
                "device": str(parent_stat.st_dev),
                "inode": str(parent_stat.st_ino),
            },
            "staging_identity": {"device": str(stage_stat.st_dev), "inode": str(stage_stat.st_ino)},
            "artifacts": artifacts,
        },
        staging,
        destination,
    )


def test_exact_three_atomic_artifacts_and_final_reverification(tmp_path):
    request, stage, destination = setup(tmp_path)
    calls = []
    assert publication.publish_statistics_figure(request, lambda: calls.append("reverified")) == {
        "published": True
    }
    assert calls == ["reverified"] and not stage.exists()
    assert sorted(path.name for path in destination.iterdir()) == [
        "figure.png",
        "figure.svg",
        "manifest.json",
    ]


@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
def test_artifact_links_never_publish(tmp_path, kind):
    request, stage, destination = setup(tmp_path)
    target = tmp_path / "outside.png"
    target.write_bytes((stage / "figure.png").read_bytes())
    (stage / "figure.png").unlink()
    if kind == "symlink":
        (stage / "figure.png").symlink_to(target)
    else:
        os.link(target, stage / "figure.png")
    with pytest.raises((ValueError, OSError)):
        publication.publish_statistics_figure(request, lambda: None)
    assert not destination.exists()
    assert target.read_bytes() == b"figure.png"


@pytest.mark.parametrize("extra", [True, False])
def test_extra_or_changed_artifact_rejected(tmp_path, extra):
    request, stage, destination = setup(tmp_path)
    (stage / ("extra" if extra else "figure.svg")).write_bytes(b"bad")
    with pytest.raises(ValueError):
        publication.publish_statistics_figure(request, lambda: None)
    assert not destination.exists()


@pytest.mark.parametrize("kind", ["directory", "symlink"])
def test_no_replace_even_when_destination_races_native_rename(tmp_path, monkeypatch, kind):
    request, stage, destination = setup(tmp_path)
    original = publication._rename_noreplace
    target = tmp_path / "outside"
    target.mkdir()

    def race(source, dest, **kwargs):
        if kind == "directory":
            destination.mkdir()
        else:
            destination.symlink_to(target)
        return original(source, dest, **kwargs)

    monkeypatch.setattr(publication, "_rename_noreplace", race)
    with pytest.raises(FileExistsError):
        publication.publish_statistics_figure(request, lambda: None)
    assert stage.exists()
    assert destination.is_dir() if kind == "directory" else destination.is_symlink()


@pytest.mark.parametrize("mutation", ["artifact", "extra", "staging", "parent"])
def test_mutations_during_final_source_check_are_rejected(tmp_path, mutation):
    parent = tmp_path / "parent"
    parent.mkdir()
    request, stage, destination = setup(parent)
    preserved = tmp_path / "preserved"

    def race():
        if mutation == "artifact":
            (stage / "figure.svg").write_bytes(b"mutated")
        elif mutation == "extra":
            (stage / "unknown").write_bytes(b"extra")
        elif mutation == "staging":
            stage.rename(preserved)
            stage.mkdir()
        else:
            parent.rename(preserved)
            parent.mkdir()

    with pytest.raises((ValueError, FileNotFoundError)):
        publication.publish_statistics_figure(request, race)
    assert not destination.exists()
    if mutation in ("staging", "parent"):
        assert preserved.is_dir()


def test_reverification_error_prevents_publication(tmp_path):
    request, stage, destination = setup(tmp_path)

    def refused():
        raise ValueError("stale canonical source/result")

    with pytest.raises(ValueError, match="stale canonical"):
        publication.publish_statistics_figure(request, refused)
    assert stage.exists() and not destination.exists()


def test_stage_symlink_and_parent_identity_rejected(tmp_path):
    request, stage, destination = setup(tmp_path)
    moved = tmp_path / "moved"
    stage.rename(moved)
    stage.symlink_to(moved)
    with pytest.raises((ValueError, OSError)):
        publication.publish_statistics_figure(request, lambda: None)
    assert not destination.exists()


def test_fallback_publication_rejects_final_parent_and_file_mutation(tmp_path, monkeypatch):
    monkeypatch.setattr(publication, "_DIR_FD_AVAILABLE", False)
    request, stage, destination = setup(tmp_path)

    def race():
        (stage / "figure.svg").write_bytes(b"changed")

    with pytest.raises(ValueError):
        publication.publish_statistics_figure(request, race)
    assert not destination.exists()
