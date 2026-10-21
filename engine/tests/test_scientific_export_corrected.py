"""An actual calibrated correction stays pending and exports its exact child data."""

from __future__ import annotations

import csv
import hashlib
import json

import numpy as np
import pytest
import test_research_editing as editing

from loci_engine.research_data_export import export_data_package, plan_export
from loci_engine.research_groups import dispatch_group
from loci_engine.research_project import canonical_json


@pytest.fixture
def scene(tmp_path):
    yield from editing.scene.__wrapped__(tmp_path)


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _labels_sha(labels):
    """Independent implementation of the documented canonical uint32 value hash."""
    header = json.dumps(
        {"dtype": "<u4", "shape": list(labels.shape)}, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(
        b"loci-label-array-v1\0" + header + b"\0" + labels.astype("<u4").tobytes(order="C")
    ).hexdigest()


def _rows(directory, name):
    with (directory / name).open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def test_actual_corrected_child_package_preserves_pending_review_audit_and_parent(scene, tmp_path):
    workbench, source_file, parent = scene
    project = workbench.project
    expected_parent = np.zeros((5, 20, 22), np.uint32)
    expected_parent[1:4, 3:7, 3:7] = 1
    expected_parent[1:4, 11:15, 12:16] = 2
    np.testing.assert_array_equal(project.load_array(parent["arrays"]["labels"]), expected_parent)
    parent_binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    gate = {
        "kind": "rectangle",
        "x_metric": "measure",
        "y_metric": "voxel_count",
        "x_transform": "linear",
        "y_transform": "linear",
        "bounds": [24, 24, 48, 48],
    }
    evaluated = dispatch_group(
        project, "population_gate_evaluate", {**parent_binding, "gate": gate}
    )
    parent_group = dispatch_group(
        project,
        "population_group_save",
        {
            **parent_binding,
            "gate": gate,
            "name": "Reviewed parent objects",
            "membership_sha256": evaluated["membership_sha256"],
        },
    )
    project.review(parent["id"], parent["revision_hash"], "reviewed")
    parent_record = canonical_json(project.result(parent["id"]))
    parent_history = canonical_json(project.review_history(parent["id"]))
    source_hash = _sha(source_file)
    parent_artifact_hashes = {
        descriptor["sha256"]: _sha(project.arrays / (descriptor["sha256"] + ".npy"))
        for descriptor in parent["arrays"].values()
    }

    info = workbench.execute("correction_info", parent_binding)
    corrected = workbench.execute(
        "correct_result",
        {
            **parent_binding,
            "operations": [
                {"op": "delete", "label": 1, "expected_input_sha256": info["label_sha256"]}
            ],
        },
    )
    child = project.result(corrected["result"]["id"])
    expected_child = expected_parent.copy()
    expected_child[expected_child == 1] = 0
    actual_child = project.load_array(child["arrays"]["labels"])
    np.testing.assert_array_equal(actual_child, expected_child)
    assert np.count_nonzero(expected_parent != actual_child) == 48
    assert child["id"] != parent["id"] and child["revision_hash"] != parent["revision_hash"]
    assert child["parent_id"] == parent["id"]
    assert project.review_state(child["id"]) is None
    assert project.review_history(child["id"]) == []
    correction = child["provenance"]["correction"]
    assert correction["parent_id"] == parent["id"]
    assert correction["parent_revision_hash"] == parent["revision_hash"]
    assert correction["input_labels_sha256"] == _labels_sha(expected_parent)
    assert correction["output_labels_sha256"] == _labels_sha(expected_child)
    assert correction["operations"] == [
        {
            "op": "delete",
            "label": 1,
            "input_labels_sha256": _labels_sha(expected_parent),
            "output_labels_sha256": _labels_sha(expected_child),
            "changed_voxels": 48,
        }
    ]

    binding = {
        "source_id": child["source_id"],
        "source_sha256": child["source_sha256"],
        "result_id": child["id"],
        "revision_hash": child["revision_hash"],
        "group_ids": [],
        "subset": "all",
    }
    with pytest.raises(ValueError, match="Review this exact result revision"):
        plan_export(project, {"purpose": "reviewed", "bindings": [binding]})
    planned = plan_export(project, {"purpose": "provisional", "bindings": [binding]})
    assert planned["plan"]["total_count"] == planned["plan"]["selected_count"] == 1
    assert planned["plan"]["results"][0]["review_status"] == "pending"
    assert planned["plan"]["group_count"] == planned["plan"]["membership_count"] == 0
    directory = tmp_path / "corrected-data"
    receipt = export_data_package(project, planned["plan_json"], directory)
    assert receipt["purpose"] == "provisional" and receipt["selected_count"] == 1

    (result_row,) = _rows(directory, "results.csv")
    assert result_row["result_id"] == child["id"]
    assert result_row["revision_hash"] == child["revision_hash"]
    assert result_row["parent_id"] == parent["id"]
    assert result_row["total_count"] == result_row["selected_count"] == "1"
    assert result_row["review_disposition"] == result_row["review_json"] == r"\N"
    (object_row,) = _rows(directory, "objects.csv")
    assert object_row["label"] == "2" and object_row["voxel_count"] == "48"
    assert float(object_row["measure"]) == 24.0 and object_row["measure_unit"] == "um^3"
    assert object_row["index_axes"] == "ZYX"
    assert [float(object_row[f"centroid_index_{axis}"]) for axis in "zyx"] == [2, 12.5, 13.5]
    assert [float(object_row[f"centroid_world_{axis}"]) for axis in "xyz"] == [6.75, 6.25, 4]
    metrics = {row["metric_id"]: row for row in _rows(directory, "measurements.csv")}
    for channel, mean, total in (("1: DNA", 100, 4800), ("2: Marker", 77, 3696)):
        for statistic, expected in (("mean", mean), ("sum", total)):
            metric = metrics[f"intensity:{channel.encode().hex()}:{statistic}"]
            assert metric["label"] == "2" and metric["status"] == "value"
            assert float(metric["value"]) == expected
    assert metrics["nearest_centroid_distance"]["status"] == "null"
    assert metrics["nearest_centroid_distance"]["value"] == r"\N"
    exact_records = [
        json.loads(line) for line in (directory / "object-records.jsonl").read_text().splitlines()
    ]
    assert exact_records == [
        {
            "result_id": child["id"],
            "revision_hash": child["revision_hash"],
            "object": child["provenance"]["measurements"][0],
        }
    ]
    assert _rows(directory, "groups.csv") == _rows(directory, "memberships.csv") == []
    provenance = json.loads((directory / "provenance.json").read_text())["results"][0]
    assert provenance["parent_id"] == parent["id"]
    assert provenance["revision_hash"] == child["revision_hash"]
    assert provenance["review"] is None and provenance["review_history"] == []
    assert provenance["scientific_provenance"]["correction"] == correction
    assert provenance["references"] == [
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "source_sha256": parent["source_sha256"],
        }
    ]
    assert provenance["arrays"]["labels"] == child["arrays"]["labels"]
    manifest = json.loads((directory / "manifest.json").read_text())
    assert _sha(directory / "manifest.json") == receipt["manifest_sha256"]
    for artifact in manifest["files"]:
        assert _sha(directory / artifact["name"]) == artifact["sha256"]
        assert (directory / artifact["name"]).stat().st_size == artifact["size_bytes"]

    assert canonical_json(project.result(parent["id"])) == parent_record
    assert canonical_json(project.review_history(parent["id"])) == parent_history
    assert project.review_state(parent["id"])["disposition"] == "reviewed"
    assert project.review_state(child["id"]) is None
    assert project.review_history(child["id"]) == []
    assert project.documents("population_group") == [parent_group]
    assert _sha(source_file) == source_hash == parent["source_sha256"]
    for artifact_hash, original_digest in parent_artifact_hashes.items():
        assert _sha(project.arrays / (artifact_hash + ".npy")) == original_digest
    np.testing.assert_array_equal(project.load_array(parent["arrays"]["labels"]), expected_parent)
