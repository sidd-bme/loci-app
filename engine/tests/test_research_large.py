"""Synthetic native-reader integration for the explicit large-result workflow."""

from __future__ import annotations

import csv
import hashlib
import json
import math

import numpy as np
import pytest
import tifffile

import loci_engine.research_large_export as large_export
from loci_engine.native_image import NativeSourceChangedError
from loci_engine.research_annotations import label_array_sha256
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject
from loci_engine.research_session import clone_study
from loci_engine.research_tiled_store import object_rows, read_region
from loci_engine.workbench import Workbench

ATOL = 1e-9  # Declared physical-coordinate and distance tolerance in micrometres.
SELECTION = {"x": 11, "y": 13, "width": 530, "height": 530, "t": 1, "c": 1, "z": 1, "level": 0}


def _fixture(tmp_path, *, schema_version=2, calibrated=True, concave=False):
    tmp_path.mkdir(parents=True, exist_ok=True)
    project = ResearchProject.create(
        tmp_path / f"study-v{schema_version}.loci-study",
        "Synthetic large study",
        schema_version=schema_version,
    )
    workbench = Workbench(project)
    stack = np.full((2, 2, 2, 560, 568), 100, dtype=np.uint16)
    stack[0, 0, 0] = 300  # Distinct nonselected C/Z/T plane.
    selected = stack[1, 1, 1]
    y0, x0 = SELECTION["y"], SELECTION["x"]
    if concave:
        # A U crossing both 512-pixel seams; its measured centroid is in the void.
        selected[y0 + 400 : y0 + 520, x0 + 500 : x0 + 504] = 1000
        selected[y0 + 400 : y0 + 520, x0 + 522 : x0 + 526] = 1000
        selected[y0 + 516 : y0 + 520, x0 + 500 : x0 + 526] = 1000
    else:
        selected[y0 : y0 + 1, x0 + 20 : x0 + 24] = 1300  # Outer crop border: excluded.
        selected[y0 + 100 : y0 + 104, x0 + 506 : x0 + 516] = 1000  # Vertical core seam.
        selected[y0 + 506 : y0 + 516, x0 + 100 : x0 + 104] = 1100  # Horizontal seam.
        selected[y0 + 509 : y0 + 515, x0 + 509 : x0 + 515] = 1200  # Four-core corner.
    path = tmp_path / "synthetic-tiled.ome.tif"
    metadata = {"axes": "TCZYX", "Channel": {"Name": ["Reference", "Marker"]}}
    if calibrated:
        metadata.update(
            {
                "PhysicalSizeX": 0.5,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeY": 0.75,
                "PhysicalSizeYUnit": "µm",
                "PhysicalSizeZ": 2.0,
                "PhysicalSizeZUnit": "µm",
            }
        )
    tifffile.imwrite(path, stack, ome=True, tile=(64, 64), compression="deflate", metadata=metadata)
    source = workbench.import_native(str(path))
    request = {
        "source_id": source["id"],
        "selection": dict(SELECTION),
        "segmentation": {
            "method": "components",
            "threshold": 500,
            "polarity": "bright",
            "min_size": 1.0,
            "exclude_border": True,
        },
        "working_bytes": 256 * 1024**2,
    }
    expected = np.zeros((530, 530), dtype=np.uint32)
    if concave:
        expected[400:520, 500:504] = 1
        expected[400:520, 522:526] = 1
        expected[516:520, 500:526] = 1
    else:
        expected[100:104, 506:516] = 1
        expected[506:516, 100:104] = 2
        expected[509:515, 509:515] = 3
    return workbench, path, source, request, expected, selected.copy()


def _published(workbench, request):
    plan = workbench.execute("large_components_preflight", request)
    assert plan["shape"] == [530, 530]
    assert plan["selection"] == SELECTION
    assert plan["decoded_labels_bytes"] == 530 * 530 * 4
    saved = workbench.execute("large_components_run", request)
    result = workbench.project.result(saved["result"]["id"])
    return plan, saved, result


def test_locate_returns_actual_member_when_centroid_is_outside_concave_object(tmp_path):
    workbench, _, _, request, expected, _ = _fixture(tmp_path, concave=True)
    _, _, result = _published(workbench, request)
    assert result["object_count"] == 1
    row = object_rows(workbench.project, result["object_table"])[0]
    centroid = tuple(math.floor(value) for value in row["centroid_index"])
    assert expected[centroid] == 0  # Independent U-shape oracle.
    lookup = {"result_id": result["id"], "revision_hash": result["revision_hash"], "label": 1}
    located = workbench.execute("large_result_locate", lookup)
    assert located == {**lookup, "point_index": [400, 500]}
    y, x = located["point_index"]
    assert expected[y, x] == 1
    assert (
        workbench.execute(
            "large_result_pick",
            {"result_id": result["id"], "revision_hash": result["revision_hash"], "u": x, "v": y},
        )["label"]
        == 1
    )
    with pytest.raises(ValueError, match="exact large result revision"):
        workbench.execute("large_result_locate", {**lookup, "revision_hash": "0" * 64})
    with pytest.raises(ValueError, match="does not belong"):
        workbench.execute("large_result_locate", {**lookup, "label": 2})


def test_native_calibrated_result_pick_delete_review_export_and_cold_reopen(tmp_path):
    workbench, path, source, request, expected, selected = _fixture(tmp_path)
    original_source_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    plan, saved, parent = _published(workbench, request)
    assert plan["dtype"] == "uint16" and plan["geometry"]["unit"] == "um"
    assert parent["schema"] == "loci.research-result/v2"
    assert parent["source_sha256"] == original_source_sha
    assert parent["object_count"] == 3
    assert parent["provenance"]["selection"] == SELECTION
    labels = read_region(workbench.project, parent["arrays"]["labels"], 0, 0, 530, 530)
    raw = read_region(workbench.project, parent["arrays"]["image"], 0, 0, 530, 530)
    np.testing.assert_array_equal(labels, expected)
    np.testing.assert_array_equal(raw, selected[13:543, 11:541])
    assert parent["label_sha256"] == label_array_sha256(expected)
    rows = object_rows(workbench.project, parent["object_table"], limit=1)
    assert len(rows) == 1 and rows[0]["label"] == 1
    rows = object_rows(workbench.project, parent["object_table"], limit=200)
    assert [row["label"] for row in rows] == [1, 2, 3]
    assert [row["voxel_count"] for row in rows] == [40, 40, 36]
    assert [row["measure"] for row in rows] == pytest.approx([15, 15, 13.5], abs=ATOL)
    assert [row["intensity"]["2: Marker"]["sum"] for row in rows] == [40000, 44000, 43200]
    assert rows[0]["centroid_index"] == pytest.approx([101.5, 510.5], abs=ATOL)
    assert rows[0]["centroid_world_xyz"] == pytest.approx([260.75, 85.875, 2.0], abs=ATOL)
    assert rows[2]["centroid_world_xyz"] == pytest.approx([261.25, 393.375, 2.0], abs=ATOL)
    assert rows[2]["nearest_centroid_distance"] == pytest.approx(math.hypot(205.0, 0.75), abs=ATOL)
    page = workbench.execute("result", {"result_id": parent["id"], "offset": 1, "limit": 1})
    assert page["total_rows"] == 3 and [row["label"] for row in page["measurements"]] == [2]
    assert "measurements" not in page["provenance"]
    assert (
        workbench.execute(
            "large_result_pick",
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "u": 511,
                "v": 511,
            },
        )["label"]
        == 3
    )
    view = workbench.execute(
        "large_result_view",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "region": {"x": 505, "y": 98, "width": 15, "height": 8},
            "max_edge": 64,
        },
    )
    assert view["image_shape"] == [8, 15]
    assert view["step"] == 1 and view["image"].startswith("data:image/png;base64,")

    child_summary = workbench.execute(
        "large_result_delete",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "label": 2,
        },
    )["result"]
    child = workbench.project.result(child_summary["id"])
    assert child["parent_id"] == parent["id"]
    corrected = expected.copy()
    corrected[corrected == 2] = 0
    np.testing.assert_array_equal(
        read_region(workbench.project, child["arrays"]["labels"], 0, 0, 530, 530), corrected
    )
    assert child["label_sha256"] == label_array_sha256(corrected)
    survivors = object_rows(workbench.project, child["object_table"])
    assert [row["label"] for row in survivors] == [1, 3]
    assert survivors[1]["nearest_centroid_distance"] == pytest.approx(
        math.hypot(307.5, 0.5), abs=ATOL
    )
    assert (
        workbench.execute(
            "large_result_pick",
            {
                "result_id": child["id"],
                "revision_hash": child["revision_hash"],
                "u": 101,
                "v": 510,
            },
        )["label"]
        == 0
    )
    assert (
        workbench.execute(
            "large_result_pick",
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "u": 101,
                "v": 510,
            },
        )["label"]
        == 2
    )
    with pytest.raises(ValueError, match="exact large result revision"):
        workbench.execute(
            "large_result_pick",
            {
                "result_id": child["id"],
                "revision_hash": parent["revision_hash"],
                "u": 511,
                "v": 511,
            },
        )
    with pytest.raises(ValueError, match="Review this exact"):
        export_research_result(
            workbench.project, child["id"], child["revision_hash"], tmp_path / "unreviewed"
        )
    assert not (tmp_path / "unreviewed").exists()
    with pytest.raises(ValueError, match="pooled study comparisons"):
        workbench.execute("study_summary", {"result_ids": [child["id"]]})
    portable = tmp_path / "unsupported-portable.zip"
    with pytest.raises(ValueError, match="portable study ZIP interchange is not yet supported"):
        export_project(workbench.project, portable)
    assert not portable.exists()
    review = workbench.project.review(child["id"], child["revision_hash"], "reviewed")
    existing = tmp_path / "existing-export"
    existing.mkdir()
    (existing / "sentinel.txt").write_text("keep")
    with pytest.raises(ValueError, match="absent"):
        export_research_result(workbench.project, child["id"], child["revision_hash"], existing)
    assert (existing / "sentinel.txt").read_text() == "keep"
    stale = tmp_path / "stale-export"
    with pytest.raises(ValueError, match="stale"):
        export_research_result(workbench.project, child["id"], parent["revision_hash"], stale)
    assert not stale.exists()
    target = tmp_path / "reviewed-export"
    receipt = export_research_result(workbench.project, child["id"], child["revision_hash"], target)
    assert receipt["result_id"] == child["id"]
    np.testing.assert_array_equal(tifffile.imread(target / "labels.ome.tif"), corrected)
    np.testing.assert_array_equal(tifffile.imread(target / "image.ome.tif"), raw)
    exported = json.loads((target / "result.json").read_text())
    assert exported["review"] == review
    assert exported["result"]["revision_hash"] == child["revision_hash"]
    ancestor = exported["correction_ancestors"][0]
    assert ancestor["result_id"] == parent["id"]
    assert json.loads((target / ancestor["file"]).read_text()) == parent
    with (target / "objects.csv").open(newline="", encoding="utf-8") as stream:
        assert [int(row["label"]) for row in csv.DictReader(stream)] == [1, 3]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original_source_sha

    workbench.close()
    copied = clone_study(workbench.project, tmp_path / "cold-copy.loci-study")
    reopened = ResearchProject(copied.root)
    assert reopened.result(child["id"]) == child
    assert reopened.result(parent["id"]) == parent
    assert reopened.review_state(child["id"]) == review
    assert object_rows(reopened, child["object_table"]) == survivors
    np.testing.assert_array_equal(
        read_region(reopened, child["arrays"]["labels"], 0, 0, 530, 530), corrected
    )


def test_v1_study_projection_and_uncalibrated_sources_are_rejected(tmp_path):
    old, _, _, request, _, _ = _fixture(tmp_path, schema_version=1)
    with pytest.raises(ValueError, match="new study"):
        old.execute("large_components_preflight", request)
    assert old.project.list_results() == []
    old.close()

    modern, _, _, request, _, _ = _fixture(tmp_path / "modern")
    projection = {**request, "selection": {**request["selection"], "z_stop": 2}}
    with pytest.raises(ValueError, match="one native-resolution C/Z/T plane"):
        modern.execute("large_components_preflight", projection)
    assert modern.project.list_results() == []
    modern.close()

    uncalibrated, _, _, request, _, _ = _fixture(tmp_path / "uncalibrated", calibrated=False)
    with pytest.raises(ValueError, match="physical XY calibration"):
        uncalibrated.execute("large_components_preflight", request)
    assert uncalibrated.project.list_results() == []
    uncalibrated.close()


def test_rgb_and_mutated_source_fail_closed(tmp_path):
    rgb_project = ResearchProject.create(tmp_path / "rgb.loci-study", "RGB", schema_version=2)
    rgb_workbench = Workbench(rgb_project)
    rgb = np.zeros((32, 48, 3), dtype=np.uint8)
    rgb[..., 0] = 200
    rgb_path = tmp_path / "rgb.ome.tif"
    tifffile.imwrite(
        rgb_path,
        rgb,
        ome=True,
        tile=(16, 16),
        photometric="rgb",
        metadata={"axes": "YXS", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.75},
    )
    rgb_source = rgb_workbench.import_native(str(rgb_path))
    rgb_request = {
        "source_id": rgb_source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 32,
            "height": 32,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "segmentation": {"threshold": 100, "polarity": "bright"},
    }
    with pytest.raises(ValueError, match="calibrated scalar tiled OME-TIFF"):
        rgb_workbench.execute("large_components_preflight", rgb_request)
    rgb_workbench.close()

    workbench, path, _, request, _, _ = _fixture(tmp_path / "mutated")
    path.write_bytes(path.read_bytes() + b"changed synthetic source")
    with pytest.raises(NativeSourceChangedError):
        workbench.execute("large_components_run", request)
    assert workbench.project.list_results() == []
    workbench.close()


def test_durable_cancel_before_publication_has_no_result(tmp_path):
    workbench, _, _, request, _, _ = _fixture(tmp_path)
    job = submit_job(workbench, request, "cancel-large-once", operation="large_components_run")
    calls = 0

    def guard():
        nonlocal calls
        calls += 1
        if calls == 15:
            cancel_job(workbench.project, job["id"])

    with pytest.raises(ValueError, match="cancelled"):
        run_job(workbench, job["id"], publication_guard=guard)
    current = workbench.project.job(job["id"])
    assert current["state"] == "cancelled" and current["cancel_requested"]
    assert current["result_ids"] == []
    assert workbench.project.list_results() == []
    assert not list(workbench.project.root.glob(".large-components-*"))
    workbench.close()


def test_v2_study_with_ordinary_v1_recipe_result_remains_portable(tmp_path):
    project = ResearchProject.create(
        tmp_path / "ordinary-v2.loci-study", "Ordinary", schema_version=2
    )
    workbench = Workbench(project)
    image = np.zeros((32, 48), dtype=np.uint16)
    image[8:12, 15:21] = 100
    path = tmp_path / "ordinary.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        tile=(16, 16),
        metadata={"axes": "YX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.75},
    )
    source = workbench.import_native(str(path))
    saved = workbench.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"x": 0, "y": 0, "width": 48, "height": 32, "z": 0, "level": 0},
            "recipe": {"steps": [], "segmentation": {"method": "components", "threshold": 50}},
        },
    )
    result = project.result(saved["result"]["id"])
    assert project.meta["schema"] == "loci.study/v2"
    assert result["schema"] == "loci.research-result/v1"
    reviewed = project.review(result["id"], result["revision_hash"], "reviewed")
    archive = tmp_path / "portable-ordinary.zip"
    export_project(project, archive)
    imported = import_project(archive, tmp_path / "imported-ordinary.loci-study")
    assert imported.meta["schema"] == "loci.study/v2"
    assert imported.result(result["id"]) == result
    assert imported.review_state(result["id"]) == reviewed
    np.testing.assert_array_equal(
        imported.load_array(result["arrays"]["labels"]),
        project.load_array(result["arrays"]["labels"]),
    )
    workbench.close()


def test_interrupted_streamed_export_publishes_no_partial_target(tmp_path, monkeypatch):
    workbench, _, _, request, _, _ = _fixture(tmp_path)
    _, _, result = _published(workbench, request)
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    original = large_export._write_grid
    writes = 0

    def interrupt_after_first_grid(project, grid, path, geometry, check=None):
        nonlocal writes
        original(project, grid, path, geometry, check=check)
        writes += 1
        if writes == 1:
            raise RuntimeError("synthetic export interruption")

    monkeypatch.setattr(large_export, "_write_grid", interrupt_after_first_grid)
    destination = tmp_path / "interrupted-export"
    with pytest.raises(RuntimeError, match="synthetic export interruption"):
        export_research_result(
            workbench.project, result["id"], result["revision_hash"], destination
        )
    assert writes == 1
    assert not destination.exists()
    assert not list(tmp_path.glob(".loci-export-*"))
    assert workbench.project.result(result["id"]) == result
    workbench.close()
