import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def scene(tmp_path):
    file = tmp_path / "raw.ome.tif"
    image = np.zeros((2, 5, 20, 22), np.uint16)
    image[0, 1:4, 3:7, 3:7] = 100
    image[0, 1:4, 11:15, 12:16] = 100
    image[1] = 77
    tifffile.imwrite(
        file,
        image,
        ome=True,
        metadata={
            "axes": "CZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.5,
            "PhysicalSizeZ": 2,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["DNA", "Marker"]},
        },
        photometric="minisblack",
    )
    wb = Workbench(ResearchProject.create(tmp_path / "test.loci-study", "Study"))
    source = wb.import_native(str(file))
    output = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"z": 0, "z_stop": 5},
            "recipe": {
                "segmentation": {"method": "components", "threshold": 50},
                "measurement_channels": [0, 1],
            },
        },
    )
    parent = wb.project.result(output["result"]["id"])
    yield wb, file, parent
    wb.close()


def test_correction_remeasures_raw_3d_and_preserves_reviewed_parent(scene):
    wb, file, parent = scene
    wb.project.review(parent["id"], parent["revision_hash"], "reviewed")
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    output = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "merge",
                    "expected_input_sha256": info["label_sha256"],
                    "source_labels": [1, 2],
                    "target_label": 2,
                }
            ],
        },
    )
    child = wb.project.result(output["result"]["id"])
    assert child["parent_id"] == parent["id"]
    assert wb.project.review_state(child["id"]) is None
    assert wb.project.review_state(parent["id"])["disposition"] == "reviewed"
    (row,) = child["provenance"]["measurements"]
    assert row["label"] == 2
    assert row["measure"] == 48
    assert row["intensity"]["2: Marker"]["mean"] == 77
    assert len(parent["provenance"]["measurements"]) == 2
    assert hashlib.sha256(file.read_bytes()).hexdigest() == parent["source_sha256"]
    # Undo/redo selects immutable revisions and autosaves the exact cursor.
    selected = wb.execute("select_result", binding)
    redo = wb.execute(
        "select_result",
        {
            "result_id": child["id"],
            "revision_hash": child["revision_hash"],
            "expected_revision": selected["selection"]["revision"],
        },
    )
    reopened = ResearchProject(wb.project.root)
    assert reopened.documents("selection")[0] == redo["selection"]
    np.testing.assert_array_equal(
        reopened.load_array(parent["arrays"]["labels"]),
        wb.project.load_array(parent["arrays"]["labels"]),
    )


def test_stale_correction_or_changed_source_never_publishes(scene):
    wb, file, parent = scene
    before = len(wb.project.list_results())
    with pytest.raises(ValueError, match="exact"):
        wb.execute(
            "correct_result",
            {"result_id": parent["id"], "revision_hash": "a" * 64, "operations": []},
        )
    with pytest.raises(ValueError, match="stale"):
        wb.execute(
            "correct_result",
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "operations": [{"op": "delete", "label": 1, "expected_input_sha256": "b" * 64}],
            },
        )
    with file.open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises((ValueError, RuntimeError), match="changed"):
        wb.execute(
            "correction_info", {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
        )
    assert len(wb.project.list_results()) == before


def test_revision_bound_vertex_preview_commits_one_local_child_and_selects_undo_redo(scene):
    wb, _, parent = scene
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    before_results = len(wb.project.list_results())
    info = wb.execute("correction_info", {**binding, "label": 1, "plane": "XY", "index": 2})
    boundary = info["boundary"]
    assert len(wb.project.list_results()) == before_results
    assert boundary["label"] == 1
    assert boundary["plane_axes_uv"] == ["X", "Y"]
    assert boundary["distance_unit"] == "um"
    source_vertices = boundary["vertices_uv"]
    vertices = [dict(point) for point in source_vertices]
    moved_index = min(
        range(len(vertices)),
        key=lambda item: float(vertices[item]["u"]) + float(vertices[item]["v"]),
    )
    vertices[moved_index] = {
        "u": max(0.0, float(vertices[moved_index]["u"]) - 1.0),
        "v": max(0.0, float(vertices[moved_index]["v"]) - 1.0),
    }
    original = wb.project.load_array(parent["arrays"]["labels"]).copy()

    output = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "move_boundary_vertex",
                    "expected_input_sha256": info["label_sha256"],
                    "plane": "XY",
                    "index": 2,
                    "label": 1,
                    "source_vertices": source_vertices,
                    "vertices": vertices,
                }
            ],
        },
    )

    child = wb.project.result(output["result"]["id"])
    corrected = wb.project.load_array(child["arrays"]["labels"])
    np.testing.assert_array_equal(wb.project.load_array(parent["arrays"]["labels"]), original)
    assert child["parent_id"] == parent["id"]
    assert child["provenance"]["correction"]["operations"][0]["op"] == "move_boundary_vertex"
    assert child["provenance"]["correction"]["operations"][0]["moved_vertex_index"] == moved_index
    assert np.count_nonzero(corrected != original) > 0
    assert len(wb.project.list_results()) == before_results + 1
    parent_cursor = wb.execute("select_result", binding)
    child_cursor = wb.execute(
        "select_result",
        {
            "result_id": child["id"],
            "revision_hash": child["revision_hash"],
            "expected_revision": parent_cursor["selection"]["revision"],
        },
    )
    assert child_cursor["selection"]["data"]["result_id"] == child["id"]
    restored_parent = wb.execute(
        "select_result",
        {
            **binding,
            "expected_revision": child_cursor["selection"]["revision"],
        },
    )
    assert restored_parent["selection"]["data"]["result_id"] == parent["id"]


def test_roi_child_binds_geometry_and_raw_channels(scene):
    wb, _, parent = scene
    output = wb.execute(
        "roi_add",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "measurement_channels": [1],
            "roi": {
                "annotation_id": "region-1",
                "plane": "XY",
                "index": 2,
                "points": [
                    {"u": 2.5, "v": 2.5},
                    {"u": 6.5, "v": 2.5},
                    {"u": 6.5, "v": 6.5},
                    {"u": 2.5, "v": 6.5},
                ],
                "slab_start": 1,
                "slab_stop_exclusive": 4,
            },
        },
    )
    child = wb.project.result(output["result"]["id"])
    (annotation,) = child["provenance"]["annotations"]
    measurement = annotation["measurements"]["2: Marker"]
    assert measurement["raw_intensity"]["mean"] == 77
    assert measurement["sampled_voxel_count"] == 48
    assert measurement["geometric_measure"] == 24
    assert annotation["parent_result_id"] == parent["id"]
    assert wb.project.review_state(child["id"]) is None


def test_durable_correction_deduplicates_and_cancellation_blocks_publication(scene, monkeypatch):
    from loci_engine.research_jobs import cancel_job, run_job, submit_job

    wb, _, parent = scene
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    request = {
        **binding,
        "operations": [{"op": "delete", "label": 1, "expected_input_sha256": info["label_sha256"]}],
    }
    job = submit_job(wb, request, "one-correction", "correct_result")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert submit_job(wb, request, "one-correction", "correct_result")["id"] == job["id"]
    assert run_job(wb, job["id"])["job"]["result_ids"] == [output["result"]["id"]]
    before = len(wb.project.list_results())
    next_job = submit_job(wb, request, "cancel-correction", "correct_result")
    store = wb.project.store_array

    def cancelled(array):
        value = store(array)
        cancel_job(wb.project, next_job["id"])
        return value

    monkeypatch.setattr(wb.project, "store_array", cancelled)
    with pytest.raises(ValueError, match="cancelled"):
        run_job(wb, next_job["id"])
    assert wb.project.job(next_job["id"])["state"] == "cancelled"
    assert len(wb.project.list_results()) == before


def test_roi_on_image_only_and_declared_stain_results_has_explicit_intensity_basis(tmp_path):
    from PIL import Image
    from skimage.color import hdx_from_rgb, separate_stains

    wb = Workbench(ResearchProject.create(tmp_path / "roi.loci-study", "ROI"))
    gray = np.full((12, 14), 37, np.uint8)
    file = tmp_path / "gray.tif"
    tifffile.imwrite(file, gray)
    source = wb.import_native(str(file))
    parent = wb.execute("run_recipe", {"source_id": source["id"], "recipe": {"steps": []}})[
        "result"
    ]
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    assert info["label_sha256"] is None and info["label_ids"] == []
    assert info["shape"] == [12, 14]
    roi = {
        "annotation_id": "region-1",
        "plane": "XY",
        "index": 0,
        "points": [
            {"u": 1.5, "v": 1.5},
            {"u": 6.5, "v": 1.5},
            {"u": 6.5, "v": 6.5},
            {"u": 1.5, "v": 6.5},
        ],
    }
    annotated = wb.execute("roi_add", {**binding, "roi": roi, "measurement_channels": [0]})
    record = annotated["annotations"][0]
    assert record["basis"] == "raw-source-channel-values"
    assert next(iter(record["measurements"].values()))["raw_intensity"]["mean"] == 37
    rgb = np.full((12, 14, 3), [100, 70, 35], np.uint8)
    file = tmp_path / "stain.png"
    Image.fromarray(rgb).save(file)
    source = wb.import_native(str(file))
    parent = wb.execute(
        "histology_run", {"source_id": source["id"], "basis": "H-DAB", "component": 1}
    )["result"]
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    assert [channel["name"] for channel in info["measurement_channels"]] == [
        "hematoxylin-basis",
        "DAB-basis",
    ]
    annotated = wb.execute("roi_add", {**binding, "roi": roi, "measurement_channels": [1]})
    record = annotated["annotations"][0]
    assert record["basis"] == "declared-stain-coordinate-values"
    measurement = record["measurements"]["DAB-basis"]
    assert "raw_intensity" not in measurement
    assert measurement["derived_intensity"]["mean"] == pytest.approx(
        separate_stains(rgb, hdx_from_rgb)[0, 0, 1]
    )
    assert measurement["sampled_voxel_count"] == 25
