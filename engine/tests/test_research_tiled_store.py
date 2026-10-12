"""Synthetic, source-free contracts for immutable tiled research results."""

import hashlib
import sqlite3

import numpy as np
import pytest

from loci_engine.research_annotations import label_array_sha256
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_tiled_store import (
    ObjectTableWriter,
    TiledArrayWriter,
    iter_object_rows,
    iter_tiles,
    label_value_hash,
    object_row,
    object_rows,
    read_region,
    validate_grid,
    validate_object_table,
)


def _row(label=1):
    return {
        "label": label,
        "voxel_count": 1,
        "measure": 1.0,
        "measure_kind": "area",
        "measure_unit": "um^2",
        "centroid_index": [1.0, 1.0],
        "index_axes": "YX",
        "centroid_world_xyz": [1.0, 1.0, 0.0],
        "world_frame": "stage",
        "distance_unit": "um",
        "bbox_start": [1, 1],
        "bbox_stop_exclusive": [2, 2],
        "principal_rms_radii": [0.0, 0.0, 0.0],
        "touches_crop_border": False,
        "intensity": {
            "raw": {"mean": 10.0, "sum": 10.0, "min": 10.0, "max": 10.0, "std_population": 0.0}
        },
        "nearest_centroid_distance": None,
    }


def _grid(project, values, core=2):
    writer = TiledArrayWriter(project, values.shape, values.dtype, core)
    for y in range(0, values.shape[0], core):
        for x in range(0, values.shape[1], core):
            writer.write(y, x, values[y : y + core, x : x + core])
    return writer.finish()


def _source(project, tmp_path):
    path = tmp_path / "source.tif"
    path.write_bytes(b"synthetic immutable source")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return project.register_source(path, digest, {"axes": "YX", "dtype": "uint16"})


def _provenance():
    return {
        "geometry": {"axes": "YX"},
        "selection": {"channel": 0, "z": 0, "t": 0},
        "recipe": {"op": "threshold", "threshold": 5},
        "runtime": {"engine": "synthetic"},
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
    }


def test_grid_roundtrip_global_label_hash_and_ragged_cores(tmp_path):
    project = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    labels = np.arange(35, dtype=np.uint32).reshape(5, 7)
    descriptor = _grid(project, labels, core=2)
    assert [tile["y"] for tile in descriptor["tiles"][:4]] == [0, 0, 0, 0]
    assert read_region(project, descriptor, 1, 1, 3, 5).tolist() == labels[1:4, 1:6].tolist()
    assert label_value_hash(project, descriptor) == label_array_sha256(labels)
    assert [(y, x) for y, x, _ in iter_tiles(project, descriptor)] == [
        (y, x) for y in (0, 2, 4) for x in (0, 2, 4, 6)
    ]
    validate_grid(project, descriptor, verify=True)
    with pytest.raises(ValueError, match="outside the YX grid"):
        read_region(project, descriptor, 0, 0, 1, 0)


def test_grid_rejects_missing_duplicate_shifted_dtype_and_corrupt_shard(tmp_path):
    project = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    descriptor = _grid(project, np.ones((3, 3), dtype=np.uint32), core=2)
    for mutate in (
        lambda value: value["tiles"].pop(),
        lambda value: value["tiles"][1].update(x=0),
        lambda value: value["tiles"][1]["artifact"].update(dtype="uint16"),
    ):
        altered = {
            **descriptor,
            "tiles": [{**tile, "artifact": dict(tile["artifact"])} for tile in descriptor["tiles"]],
        }
        mutate(altered)
        with pytest.raises(ValueError):
            validate_grid(project, altered)
    first = descriptor["tiles"][0]["artifact"]
    (project.arrays / (first["sha256"] + ".npy")).write_bytes(b"tampered")
    with pytest.raises(ValueError):
        read_region(project, descriptor, 0, 0, 1, 1)


def test_writer_rejects_duplicate_missing_and_wrong_core(tmp_path):
    project = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    writer = TiledArrayWriter(project, (3, 3), "uint32", 2)
    writer.write(0, 0, np.ones((2, 2), dtype=np.uint32))
    with pytest.raises(ValueError, match="Duplicate"):
        writer.write(0, 0, np.ones((2, 2), dtype=np.uint32))
    with pytest.raises(ValueError, match="shape or dtype"):
        writer.write(2, 2, np.ones((2, 2), dtype=np.uint32))
    with pytest.raises(ValueError, match="missing"):
        writer.finish()


def test_immutable_object_table_pages_ids_and_forged_schema(tmp_path):
    project = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    with ObjectTableWriter(project) as writer:
        writer.append(_row(1))
        writer.append(_row(7))
        with pytest.raises(ValueError, match="Duplicate"):
            writer.append(_row(1))
        descriptor = writer.finalize()
    assert descriptor["count"] == 2
    assert [row["label"] for row in object_rows(project, descriptor, limit=1)] == [1]
    assert [row["label"] for row in iter_object_rows(project, descriptor)] == [1, 7]
    assert object_row(project, descriptor, 7)["label"] == 7
    assert object_row(project, descriptor, 2) is None
    validate_object_table(project, descriptor)
    with pytest.raises(ValueError):
        object_rows(project, descriptor, limit=1001)
    forged = project.arrays / "forged.sqlite3"
    with sqlite3.connect(forged) as connection:
        connection.execute("CREATE TABLE objects(label INTEGER PRIMARY KEY,record TEXT NOT NULL)")
        connection.execute("CREATE VIEW extra AS SELECT * FROM objects")
    payload = forged.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    forged.rename(project.arrays / (digest + ".sqlite3"))
    with pytest.raises(ValueError, match="schema"):
        validate_object_table(
            project,
            {"schema": "loci.object-table/v1", "sha256": digest, "bytes": len(payload), "count": 0},
        )
    with pytest.raises(ValueError, match="count"):
        validate_object_table(project, {**descriptor, "count": 1})
    table_path = project.arrays / (descriptor["sha256"] + ".sqlite3")
    (project.arrays / (table_path.name + "-wal")).write_bytes(b"mutable sidecar")
    with pytest.raises(ValueError, match="sidecar"):
        object_row(project, descriptor, 1)


def test_table_cancel_cleanup_and_invalid_row(tmp_path):
    project = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    writer = ObjectTableWriter(project)
    temporary = writer._temporary
    with pytest.raises(ValueError):
        writer.append({**_row(), "label": 0})
    writer.close()
    assert not temporary.exists()


def test_table_rejects_hash_consistent_wrong_row_identity(tmp_path):
    project = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    forged = project.arrays / "wrong-label.sqlite3"
    with sqlite3.connect(forged) as connection:
        connection.execute("CREATE TABLE objects(label INTEGER PRIMARY KEY,record TEXT NOT NULL)")
        connection.execute("INSERT INTO objects VALUES(?,?)", (2, canonical_json(_row(1))))
    payload = forged.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    forged.rename(project.arrays / (digest + ".sqlite3"))
    descriptor = {
        "schema": "loci.object-table/v1",
        "sha256": digest,
        "bytes": len(payload),
        "count": 1,
    }
    with pytest.raises(ValueError, match="identity"):
        validate_object_table(project, descriptor)
    with pytest.raises(ValueError, match="invalid"):
        object_row(project, descriptor, 2)


def test_v2_result_publication_and_study_version_gate(tmp_path):
    v1 = ResearchProject.create(tmp_path / "old.loci-study", "Old")
    v2 = ResearchProject.create(tmp_path / "new.loci-study", "New", schema_version=2)
    source = _source(v2, tmp_path)
    labels = np.zeros((3, 3), dtype=np.uint32)
    labels[1, 1] = 1
    arrays = {
        "image": _grid(v2, np.full((3, 3), 10, dtype=np.uint16), 2),
        "labels": _grid(v2, labels, 2),
    }
    with ObjectTableWriter(v2) as writer:
        writer.append(_row())
        table = writer.finalize()
    arguments = {
        "source_id": source["id"],
        "kind": "segmentation",
        "arrays": arrays,
        "provenance": _provenance(),
        "object_table": table,
        "label_sha256": label_array_sha256(labels),
    }
    with pytest.raises(ValueError, match="new v2"):
        v1.save_tiled_result(**arguments)
    with pytest.raises(ValueError, match="provenance"):
        v2.save_tiled_result(**{**arguments, "provenance": {}})
    with pytest.raises(ValueError, match="Canonical label values"):
        v2.save_tiled_result(**{**arguments, "label_sha256": "0" * 64})
    job = v2.submit("analyze", {"source_id": source["id"]}, "one")
    v2.update_job(job["id"], expected_state="queued", state="running")
    with pytest.raises(ValueError, match="cancel"):
        v2.save_tiled_result(
            **arguments,
            job_id=job["id"],
            publication_guard=lambda: (_ for _ in ()).throw(ValueError("cancelled")),
        )
    assert v2.list_results() == []
    assert v2.job(job["id"])["state"] == "running"
    result = v2.save_tiled_result(**arguments, job_id=job["id"])
    assert ResearchProject(v2.root).result(result["id"])["revision_hash"] == result["revision_hash"]
    assert v2.job(job["id"])["state"] == "succeeded"
    with v2.connection() as connection:
        fake = {**result, "schema": "loci.research-result/v3"}
        fake["revision_hash"] = hashlib.sha256(
            canonical_json(
                {key: value for key, value in fake.items() if key != "revision_hash"}
            ).encode()
        ).hexdigest()
        connection.execute(
            "UPDATE results SET record=? WHERE id=?",
            (canonical_json(fake), result["id"]),
        )
    with pytest.raises(ValueError, match="Unsupported research result schema"):
        v2.result(result["id"])
