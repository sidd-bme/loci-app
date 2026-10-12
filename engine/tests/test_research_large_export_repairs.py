"""Regression cases for large export cancellation and interrupted publication."""

from __future__ import annotations

import pytest
from test_research_large import _fixture, _published

import loci_engine.research_large_export as large_export
from loci_engine.native_image import NativeImageSession
from loci_engine.research_jobs import reconcile_jobs, submit_job


def _reviewed(tmp_path):
    workbench, _, _, request, _, _ = _fixture(tmp_path)
    _, _, result = _published(workbench, request)
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    return workbench, result


def test_type_error_during_grid_write_is_not_retried_without_cancellation(tmp_path, monkeypatch):
    workbench, result = _reviewed(tmp_path)
    calls = 0

    def fail(_project, _grid, _path, _geometry, check=None):
        nonlocal calls
        calls += 1
        assert check is not None
        raise TypeError("synthetic encoder failure")

    monkeypatch.setattr(large_export, "_write_grid", fail)
    destination = tmp_path / "target"
    with pytest.raises(TypeError, match="synthetic encoder failure"):
        large_export.export_large_result(
            workbench.project,
            result["id"],
            result["revision_hash"],
            destination,
            check=lambda: None,
        )
    assert calls == 1
    assert not destination.exists()
    assert not list(tmp_path.glob(".loci-export-*"))
    workbench.close()


def test_native_strict_verification_reaches_cancellation_callback(tmp_path):
    workbench, source_path, _, _, _, _ = _fixture(tmp_path)
    with (
        NativeImageSession(source_path) as session,
        pytest.raises(ValueError, match="synthetic cancellation"),
    ):
        session.verify_strict(
            check=lambda: (_ for _ in ()).throw(ValueError("synthetic cancellation"))
        )
    workbench.close()


def test_table_copy_and_file_hash_check_between_chunks(tmp_path):
    source = tmp_path / "source.sqlite3"
    source.write_bytes(b"x" * (3 * 1024 * 1024))
    copied = tmp_path / "copied.sqlite3"
    calls = 0

    def stop_after_first_chunk():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ValueError("synthetic cancellation")

    with pytest.raises(ValueError, match="synthetic cancellation"):
        large_export._copy_checked(source, copied, stop_after_first_chunk)
    assert calls == 2
    assert copied.stat().st_size == 1024 * 1024
    calls = 0
    with pytest.raises(ValueError, match="synthetic cancellation"):
        large_export._checked_hash(source, stop_after_first_chunk)
    assert calls == 2


def test_cancel_during_effective_label_hash_leaves_no_publication(tmp_path, monkeypatch):
    workbench, result = _reviewed(tmp_path)
    original = large_export.label_value_hash
    calls = 0

    def hash_with_cancel(project, descriptor, check=None):
        nonlocal calls
        assert check is not None

        def cancel():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ValueError("synthetic cancellation")

        return original(project, descriptor, check=cancel)

    monkeypatch.setattr(large_export, "label_value_hash", hash_with_cancel)
    destination = tmp_path / "cancelled"
    with pytest.raises(ValueError, match="synthetic cancellation"):
        large_export.export_large_result(
            workbench.project,
            result["id"],
            result["revision_hash"],
            destination,
            check=lambda: None,
        )
    assert calls >= 1
    assert not destination.exists()
    workbench.close()


def test_export_grant_rejects_destination_inside_study(tmp_path):
    workbench, result = _reviewed(tmp_path)
    destination = workbench.project.root / "exported-result"
    with pytest.raises(ValueError, match="inside the project root"):
        large_export.create_export_grant(
            workbench.project, result["id"], result["revision_hash"], str(destination)
        )
    with pytest.raises(ValueError, match="cannot overwrite existing work"):
        large_export.export_large_result(
            workbench.project, result["id"], result["revision_hash"], destination
        )
    assert not destination.exists()
    workbench.close()


def test_interrupted_job_rejects_unrelated_and_tampered_bundles(tmp_path, monkeypatch):
    workbench, result = _reviewed(tmp_path)
    destination = tmp_path / "published"
    grant = large_export.create_export_grant(
        workbench.project, result["id"], result["revision_hash"], str(destination)
    )
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "grant_id": grant["grant_id"],
    }
    job = submit_job(workbench, request, "interrupted-export", operation="large_result_export")
    workbench.project.update_job(job["id"], expected_state="queued", state="running")
    monkeypatch.setattr("loci_engine.research_jobs.process_alive", lambda _pid: False)

    destination.mkdir()
    (destination / "manifest.json").write_text('{"result_id":"other"}')
    reconcile_jobs(workbench.project)
    interrupted = workbench.project.job(job["id"])
    assert interrupted["state"] == "interrupted"
    assert "completeness is not verified" in interrupted["error"]
    workbench.close()


def test_interrupted_postrename_bundle_remains_unverified(tmp_path, monkeypatch):
    workbench, result = _reviewed(tmp_path)
    destination = tmp_path / "published"
    grant = large_export.create_export_grant(
        workbench.project, result["id"], result["revision_hash"], str(destination)
    )
    large_export.export_large_result(
        workbench.project, result["id"], result["revision_hash"], destination
    )
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "grant_id": grant["grant_id"],
    }
    job = submit_job(workbench, request, "postrename-export", operation="large_result_export")
    workbench.project.update_job(job["id"], expected_state="queued", state="running")
    monkeypatch.setattr("loci_engine.research_jobs.process_alive", lambda _pid: False)
    reconcile_jobs(workbench.project)
    assert "completeness is not verified" in workbench.project.job(job["id"])["error"]
    workbench.close()
