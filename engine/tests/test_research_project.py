import hashlib
import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest

import loci_engine.research_project as project_module
from loci_engine.research_project import (
    ARRAY_VERIFY_CHUNK_BYTES,
    ResearchProject,
    parse_json,
)


@pytest.fixture
def study(tmp_path):
    return ResearchProject.create(tmp_path / "experiment.loci-study", "Reference study")


def test_create_closes_database_before_fsync(tmp_path, monkeypatch):
    real_connect = sqlite3.connect
    connection_closed = False

    class TrackingConnection:
        def __init__(self, *args, **kwargs):
            self.connection = real_connect(*args, **kwargs)

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def close(self):
            nonlocal connection_closed
            self.connection.close()
            connection_closed = True

        def __getattr__(self, name):
            return getattr(self.connection, name)

    real_fsync = project_module.os.fsync

    def assert_closed_before_fsync(descriptor):
        assert connection_closed
        real_fsync(descriptor)

    monkeypatch.setattr(project_module.sqlite3, "connect", TrackingConnection)
    monkeypatch.setattr(project_module.os, "fsync", assert_closed_before_fsync)

    project = ResearchProject.create(tmp_path / "created.loci-study", "Created")

    assert project.database.is_file()


def register(study, tmp_path):
    source = tmp_path / "source.tif"
    source.write_bytes(b"immutable source fixture")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return source, study.register_source(source, digest, {"axes": "YX", "dtype": "uint16"})


def result(study, source_id, parent_id=None):
    return study.save_result(
        source_id=source_id,
        kind="segmentation",
        parent_id=parent_id,
        arrays={"labels": np.ones((4, 4), dtype=np.uint32)},
        provenance={"method": "components", "threshold": 42},
    )


def install_npy(study: ResearchProject, path: Path, *, shape: list[int], dtype: str) -> dict:
    payload = path.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    (study.arrays / f"{digest}.npy").write_bytes(payload)
    return {"sha256": digest, "bytes": len(payload), "shape": shape, "dtype": dtype}


def test_create_reopen_and_no_overwrite(study):
    reopened = ResearchProject(study.root)
    assert reopened.summary()["project_id"] == study.meta["project_id"]
    assert reopened.summary()["title"] == "Reference study"
    assert reopened.summary()["counts"] == {"sources": 0, "results": 0, "jobs": 0}
    with pytest.raises(ValueError, match="never overwritten"):
        ResearchProject.create(study.root, "Overwrite")


def test_native_sources_are_private_deduplicated_and_immutable(study, tmp_path):
    file, source = register(study, tmp_path)
    assert "private_path" not in source
    assert str(tmp_path) not in json.dumps(study.list_sources())
    same = study.register_source(file, source["sha256"], {"different": "ignored"})
    assert same == source
    assert study.source(source["id"], verify=True)["private_path"] == str(file)
    file.write_bytes(b"different bytes")
    with pytest.raises(ValueError, match="changed"):
        study.source(source["id"], verify=True)
    assert study.list_sources()[0]["sha256"] == source["sha256"]


def test_source_registration_detects_inspection_drift(study, tmp_path):
    file = tmp_path / "drift.tif"
    file.write_bytes(b"bytes")
    with pytest.raises(ValueError, match="changed after inspection"):
        study.register_source(file, "0" * 64, {})
    assert study.list_sources() == []


def test_relink_requires_exact_bytes_and_preserves_source_identity(study, tmp_path):
    original, source = register(study, tmp_path)
    replacement = tmp_path / "renamed.tif"
    replacement.write_bytes(original.read_bytes())
    original.unlink()
    relinked = study.relink(source["id"], replacement)
    assert relinked["id"] == source["id"]
    assert relinked["sha256"] == source["sha256"]
    replacement.write_bytes(b"other image")
    with pytest.raises(ValueError, match="exactly match"):
        study.relink(source["id"], replacement)


def test_documents_use_optimistic_revision_and_no_lost_updates(study):
    document_id = "a" * 32
    first = study.put_document("sample", document_id, {"condition": "control"}, expected_revision=0)
    assert first["revision"] == 1
    with pytest.raises(ValueError, match="changed"):
        study.put_document("sample", document_id, {"condition": "overwritten"}, expected_revision=0)
    second = study.put_document(
        "sample", document_id, {"condition": "treated"}, expected_revision=1
    )
    assert second["revision"] == 2
    assert ResearchProject(study.root).documents("sample") == [second]


def test_artifact_deduplication_and_numerical_roundtrip(study):
    array = np.arange(72, dtype=np.uint32).reshape(3, 4, 6) + 100_000
    descriptor = study.store_array(array)
    assert study.store_array(array) == descriptor
    restored = ResearchProject(study.root).load_array(descriptor)
    np.testing.assert_array_equal(restored, array)
    assert restored.dtype == np.uint32
    assert restored.flags.writeable is False
    assert len(list(study.arrays.glob("*.npy"))) == 1
    assert list(study.arrays.glob(".array-*")) == []


def test_verify_array_streams_finite_checks_without_materializing(
    study: ResearchProject, monkeypatch: pytest.MonkeyPatch
) -> None:
    count = ARRAY_VERIFY_CHUNK_BYTES // np.dtype(np.float32).itemsize * 3 + 17
    descriptor = study.store_array(np.arange(count, dtype=np.float32))
    checked_chunks: list[int] = []
    real_isfinite = np.isfinite

    def bounded_isfinite(value):
        checked_chunks.append(value.nbytes)
        assert value.nbytes <= ARRAY_VERIFY_CHUNK_BYTES
        return real_isfinite(value)

    def forbidden_materialization(*_args, **_kwargs):
        raise AssertionError("verify_array must not call np.array")

    monkeypatch.setattr(project_module.np, "isfinite", bounded_isfinite)
    monkeypatch.setattr(project_module.np, "array", forbidden_materialization)

    assert study.verify_array(descriptor) is None
    assert len(checked_chunks) >= 4
    assert max(checked_chunks) <= ARRAY_VERIFY_CHUNK_BYTES


def test_verify_array_rejects_descriptor_hash_and_after_check_tampering(
    study: ResearchProject, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = study.store_array(np.arange(64, dtype=np.uint16))
    with pytest.raises(ValueError, match="descriptor"):
        study.verify_array({**descriptor, "shape": [True]})
    with pytest.raises(ValueError, match="identity"):
        study.verify_array({**descriptor, "sha256": "../escape"})

    corrupted = study.store_array(np.arange(65, dtype=np.uint16))
    corrupted_target = study.arrays / f"{corrupted['sha256']}.npy"
    corrupted_target.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="hash/size"):
        study.verify_array(corrupted)

    target = study.arrays / f"{descriptor['sha256']}.npy"
    original_finite = ResearchProject._array_is_finite_bounded

    def mutate_after_finite(array):
        finite = original_finite(array)
        with target.open("ab") as stream:
            stream.write(b"changed-after-first-hash")
        return finite

    monkeypatch.setattr(
        ResearchProject,
        "_array_is_finite_bounded",
        staticmethod(mutate_after_finite),
    )
    with pytest.raises(ValueError, match="changed"):
        study.verify_array(descriptor)


def test_verify_array_rejects_nonfinite_object_and_oversized_headers(
    study: ResearchProject, tmp_path: Path
) -> None:
    nonfinite_file = tmp_path / "nonfinite.npy"
    np.save(nonfinite_file, np.array([1.0, np.nan], dtype=np.float32), allow_pickle=False)
    nonfinite = install_npy(study, nonfinite_file, shape=[2], dtype="float32")
    with pytest.raises(ValueError, match="invalid numerical"):
        study.verify_array(nonfinite)

    object_file = tmp_path / "object.npy"
    np.save(object_file, np.array([{"unsafe": True}], dtype=object), allow_pickle=True)
    object_artifact = install_npy(study, object_file, shape=[1], dtype="object")
    with pytest.raises(ValueError, match="object|objects"):
        study.verify_array(object_artifact)

    large_header_file = tmp_path / "large-header.npy"
    structured = np.dtype([(f"field_{index:04d}", "u1") for index in range(1500)])
    np.save(large_header_file, np.zeros(1, dtype=structured), allow_pickle=False)
    assert large_header_file.stat().st_size > 16_384
    large_header = install_npy(study, large_header_file, shape=[1], dtype="uint8")
    with pytest.raises(ValueError, match="Header.*large|large.*header"):
        study.verify_array(large_header)


def test_artifact_tampering_shape_and_type_rejected(study):
    descriptor = study.store_array(np.zeros((4, 4), dtype=np.uint16))
    with pytest.raises(ValueError, match="disagrees"):
        study.load_array({**descriptor, "shape": [2, 8]})
    with pytest.raises(ValueError, match="identity"):
        study.load_array({**descriptor, "sha256": "../escape"})
    target = study.arrays / (descriptor["sha256"] + ".npy")
    target.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="hash/size"):
        study.load_array(descriptor)


def test_result_review_is_exact_revision_bound_across_correction(study, tmp_path):
    _, source = register(study, tmp_path)
    first = result(study, source["id"])
    review = study.review(first["id"], first["revision_hash"], "reviewed")
    second = result(study, source["id"], first["id"])
    reopened = ResearchProject(study.root)
    assert reopened.review_state(first["id"]) == review
    assert reopened.review_state(second["id"]) is None
    assert reopened.result(first["id"])["provenance"]["threshold"] == 42
    assert second["parent_id"] == first["id"]
    with pytest.raises(ValueError, match="exact selected"):
        study.review(second["id"], first["revision_hash"], "reviewed")


def test_result_record_tampering_is_detected(study, tmp_path):
    _, source = register(study, tmp_path)
    saved = result(study, source["id"])
    changed = {**saved, "provenance": {"threshold": 999}}
    with sqlite3.connect(study.database) as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (json.dumps(changed), saved["id"])
        )
    with pytest.raises(ValueError, match="integrity"):
        study.result(saved["id"])


def test_repeated_submissions_are_idempotent_and_parameter_bound(study):
    job = study.submit("segment", {"threshold": 12}, "same-user-intent")
    assert study.submit("segment", {"threshold": 12}, "same-user-intent") == job
    with pytest.raises(ValueError, match="different parameters"):
        study.submit("segment", {"threshold": 13}, "same-user-intent")
    assert len(study.list_jobs()) == 1
    running = study.update_job(job["id"], expected_state="queued", state="running", progress=1)
    assert running["state"] == "running"
    with pytest.raises(ValueError, match="state changed"):
        study.update_job(job["id"], expected_state="queued", state="running")
    done = study.update_job(job["id"], expected_state="running", state="succeeded", progress=1.0)
    assert ResearchProject(study.root).job(job["id"]) == done
    with pytest.raises(ValueError, match="terminal"):
        study.update_job(job["id"], expected_state="succeeded", state="running")


def test_unsupported_schema_is_never_silently_upgraded(study):
    with sqlite3.connect(study.database) as connection:
        connection.execute("PRAGMA user_version=99")
    before = study.database.read_bytes()
    with pytest.raises(ValueError, match="Unsupported study schema"):
        ResearchProject(study.root)
    assert study.database.read_bytes() == before


def test_linked_database_artifact_directory_and_source_are_rejected(study, tmp_path):
    actual = tmp_path / "actual.sqlite3"
    study.database.rename(actual)
    study.database.symlink_to(actual)
    with pytest.raises(ValueError, match="plain file"):
        ResearchProject(study.root)
    study.database.unlink()
    actual.rename(study.database)
    old_arrays = tmp_path / "old-artifacts"
    study.arrays.rename(old_arrays)
    study.arrays.symlink_to(old_arrays, target_is_directory=True)
    with pytest.raises(ValueError, match="linked"):
        study.store_array(np.ones((4, 4)))


@pytest.mark.parametrize("value", ['{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'])
def test_ambiguous_or_nonfinite_json_rejected(value):
    with pytest.raises(ValueError):
        parse_json(value)
