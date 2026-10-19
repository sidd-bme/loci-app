import errno
import hashlib
import os

import numpy as np
import pytest

from loci_engine import research_session
from loci_engine.research_project import ResearchProject
from loci_engine.research_session import clone_study


def populated(tmp_path):
    source = tmp_path / "image.tif"
    source.write_bytes(b"unchanged original")
    project = ResearchProject.create(tmp_path / "managed.loci-study", "Untitled images")
    record = project.register_source(source, hashlib.sha256(source.read_bytes()).hexdigest(), {})
    result = project.save_result(
        source_id=record["id"],
        kind="segmentation",
        arrays={"labels": np.arange(16, dtype=np.uint32).reshape(4, 4)},
        provenance={"fixture": True},
    )
    project.review(result["id"], result["revision_hash"], "reviewed")
    project.put_document("annotations", record["id"], {"points": [[2, 3]]}, expected_revision=0)
    return source, project, result


def test_save_as_reopens_exact_results_annotations_and_original_locator(tmp_path):
    source, original, result = populated(tmp_path)
    saved = clone_study(original, tmp_path / "named.loci-study")
    assert saved.meta == original.meta
    assert saved.result(result["id"]) == original.result(result["id"])
    assert saved.documents("annotations") == original.documents("annotations")
    assert saved.review_state(result["id"]) == original.review_state(result["id"])
    assert saved.source(result["source_id"])["private_path"] == str(source)
    assert not (saved.root / source.name).exists()
    assert source.read_bytes() == b"unchanged original"
    np.testing.assert_array_equal(
        saved.load_array(result["arrays"]["labels"]), np.arange(16).reshape(4, 4)
    )
    with pytest.raises(ValueError, match="absent"):
        clone_study(original, saved.root)


@pytest.mark.parametrize("damage", ["linked", "corrupt"])
def test_save_as_fails_atomically_on_unverifiable_artifacts(tmp_path, damage):
    source, project, result = populated(tmp_path)
    artifact = project.arrays / (result["arrays"]["labels"]["sha256"] + ".npy")
    if damage == "linked":
        artifact.unlink()
        artifact.symlink_to(source)
    else:
        artifact.write_bytes(b"corrupted")
    destination = tmp_path / "rejected.loci-study"
    with pytest.raises(ValueError):
        clone_study(project, destination)
    assert not destination.exists()
    assert not list(tmp_path.glob(".loci-save-*"))
    assert source.read_bytes() == b"unchanged original"


def test_save_as_excludes_disposable_cache_and_ownership_marker(tmp_path):
    _, project, _ = populated(tmp_path)
    (project.root / "viewer-cache").mkdir()
    (project.root / "viewer-cache" / "partial").write_bytes(b"disposable")
    (project.root / ".managed-session.json").write_text("ownership")
    saved = clone_study(project, tmp_path / "saved.loci-study")
    assert sorted(item.name for item in saved.root.iterdir()) == ["artifacts", "study.sqlite3"]


def test_save_as_allows_directory_timestamp_churn(tmp_path, monkeypatch):
    _, project, result = populated(tmp_path)
    real_fsync_directory = research_session._fsync_directory

    def touch_source_directory(output):
        real_fsync_directory(output)
        if output.name == "artifacts":
            status = project.arrays.stat()
            os.utime(
                project.arrays,
                ns=(status.st_atime_ns + 1_000_000_000, status.st_mtime_ns + 1_000_000_000),
            )

    monkeypatch.setattr(research_session, "_fsync_directory", touch_source_directory)
    saved = clone_study(project, tmp_path / "timestamp-churn.loci-study")
    np.testing.assert_array_equal(
        saved.load_array(result["arrays"]["labels"]), np.arange(16).reshape(4, 4)
    )


def test_save_as_rejects_directory_entry_churn(tmp_path, monkeypatch):
    _, project, _ = populated(tmp_path)
    real_fsync_directory = research_session._fsync_directory

    def add_source_entry(output):
        real_fsync_directory(output)
        if output.name == "artifacts":
            (project.arrays / "late-entry.npy").write_bytes(b"changed during copy")

    monkeypatch.setattr(research_session, "_fsync_directory", add_source_entry)
    destination = tmp_path / "entry-churn.loci-study"
    with pytest.raises(ValueError, match="directory changed"):
        clone_study(project, destination)
    assert not destination.exists()
    assert not list(tmp_path.glob(".loci-save-*"))


def test_save_as_reports_unsupported_publication_and_cleans_disappearing_sidecars(
    tmp_path, monkeypatch
):
    _, project, _ = populated(tmp_path)
    real_unlink = os.unlink
    vanished = []

    def unsupported_publish(staging, target):
        (staging / "._study.sqlite3").write_bytes(b"synthetic AppleDouble sidecar")
        raise OSError(errno.ENOTSUP, "Operation not supported", str(target))

    def unlink_with_sidecar_race(path, *args, **kwargs):
        if os.path.basename(path) == "._study.sqlite3":
            real_unlink(path, *args, **kwargs)
            vanished.append(os.path.basename(path))
            # A sidecar listed by rmtree can disappear with its paired entry.
            # The second unlink reproduces that missing-entry result.
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(research_session, "_rename_noreplace", unsupported_publish)
    monkeypatch.setattr(os, "unlink", unlink_with_sidecar_race)
    destination = tmp_path / "unsupported.loci-study"
    with pytest.raises(ValueError, match="destination drive.*atomic study saving") as failure:
        clone_study(project, destination)
    assert failure.value.__cause__.errno == errno.ENOTSUP
    assert "APFS" in str(failure.value)
    assert vanished == ["._study.sqlite3"]
    assert not destination.exists()
    assert not list(tmp_path.glob(".loci-save-*"))


def test_save_as_preserves_primary_error_when_staging_cleanup_fails(tmp_path, monkeypatch):
    _, project, _ = populated(tmp_path)
    primary = OSError(errno.EIO, "synthetic publication failure")

    def failed_publish(staging, target):
        raise primary

    def failed_cleanup(staging, **kwargs):
        raise PermissionError("synthetic cleanup failure")

    monkeypatch.setattr(research_session, "_rename_noreplace", failed_publish)
    monkeypatch.setattr(research_session.shutil, "rmtree", failed_cleanup)
    destination = tmp_path / "failed.loci-study"
    with pytest.raises(OSError) as failure:
        clone_study(project, destination)
    assert failure.value is primary
    assert any("synthetic cleanup failure" in note for note in failure.value.__notes__)
    assert not destination.exists()
    assert len(list(tmp_path.glob(".loci-save-*"))) == 1


@pytest.mark.skipif(os.name == "nt", reason="Symlink creation requires Windows privileges")
def test_save_as_cleanup_does_not_follow_replaced_staging_symlink(tmp_path, monkeypatch):
    _, project, _ = populated(tmp_path)
    foreign = tmp_path / "unowned"
    foreign.mkdir()
    marker = foreign / "preserve"
    marker.write_bytes(b"unrelated work")
    primary = OSError(errno.EIO, "synthetic publication failure")
    replaced = []

    def replace_staging(staging, target):
        research_session.shutil.rmtree(staging)
        staging.symlink_to(foreign, target_is_directory=True)
        replaced.append(staging)
        raise primary

    monkeypatch.setattr(research_session, "_rename_noreplace", replace_staging)
    with pytest.raises(OSError) as failure:
        clone_study(project, tmp_path / "replaced.loci-study")
    assert failure.value is primary
    assert any("replaced or linked" in note for note in failure.value.__notes__)
    assert replaced[0].is_symlink()
    assert marker.read_bytes() == b"unrelated work"
