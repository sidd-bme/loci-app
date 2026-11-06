import copy
import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.research_annotation_evaluation import (
    execute_annotation_evaluation,
    execute_annotation_reference,
    project_parents,
    public_summary,
    reference_candidates,
    report_get,
    validate_arrays,
    validate_parents,
    validate_project_arrays,
    validate_reference_request,
    validate_request,
    validate_source,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.source_annotations import execute_annotations
from loci_engine.workbench import Workbench, runtime_record


@pytest.fixture
def scene(tmp_path):
    path = tmp_path / "reference-technical.ome.tif"
    raw = np.arange(2 * 2 * 8 * 10, dtype=np.uint16).reshape(2, 2, 8, 10)
    tifffile.imwrite(
        path,
        raw,
        ome=True,
        metadata={
            "axes": "TZYX",
            "PhysicalSizeX": 2.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 3.0,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 5.0,
            "PhysicalSizeZUnit": "µm",
        },
    )
    wb = Workbench(
        ResearchProject.create(tmp_path / "agreement.loci-study", "Technical annotation agreement")
    )
    source = wb.import_native(str(path))
    image, geometry, selection = wb.load_scalar(
        source["id"],
        {
            "x": 2,
            "y": 1,
            "width": 6,
            "height": 5,
            "z": 1,
            "t": 1,
            "c": 0,
            "level": 0,
        },
    )
    labels = np.zeros(image.shape, np.uint32)
    labels[:2, :2] = 4_000_000_000
    labels[3:5, 3:5] = 7
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "runtime": runtime_record(),
        "measurement_channels": [0],
        "measurements": [],
    }
    parent = wb.project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        provenance=provenance,
    )
    reference_labels = np.where(labels == 7, 13, np.where(labels != 0, 29, 0)).astype(np.uint32)
    reference = wb.project.save_result(
        source_id=source["id"],
        kind="external-labels",
        arrays={"image": image, "labels": reference_labels},
        provenance=provenance,
    )
    request = {
        "result_id": parent["id"],
        "revision_hash": parent["revision_hash"],
        "reference": {"result_id": reference["id"], "revision_hash": reference["revision_hash"]},
        "semantics": "instances",
        "iou_thresholds": [0.5, 0.75],
        "reference_declaration": (
            "Synthetic independently declared technical reference, complete comparison crop"
        ),
        "working_bytes": 32 * 1024**2,
    }
    yield wb, source, parent, reference, request
    wb.close()


def _binding(record):
    return {"result_id": record["id"], "revision_hash": record["revision_hash"]}


def _rehash(record):
    record["revision_hash"] = hashlib.sha256(
        canonical_json({k: v for k, v in record.items() if k != "revision_hash"}).encode()
    ).hexdigest()
    return record


def _add(wb, source, points, *, z=1, t=1, kind="polygon"):
    state = execute_annotations(wb, "source_annotations", {"source_id": source["id"]})
    return execute_annotations(
        wb,
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": state["revision"],
            "action": "add",
            "annotation": {
                "kind": kind,
                "points": [{"x": x, "y": y} for x, y in points],
                "label": "Technical fixture",
                "color": "#abcdef",
                "z": z,
                "t": t,
            },
        },
    )


def test_immutable_agreement_retains_exact_inputs_and_bounded_tables(scene):
    wb, source, parent, reference, request = scene
    output = execute_annotation_evaluation(wb, request)
    result = wb.project.result(output["result"]["id"])
    assert result["parent_id"] == parent["id"]
    assert result["arrays"]["labels"] == parent["arrays"]["labels"]
    assert result["arrays"]["reference_labels"] == reference["arrays"]["labels"]
    validate_parents(result, {r["id"]: r for r in (parent, reference)})
    assert output["annotation_evaluation"]["metrics"]["instances"]["scores"][0]["f1"] == 1
    assert (
        "matches"
        not in public_summary(result)["annotation_evaluation"]["metrics"]["instances"]["scores"][0]
    )
    report = report_get(wb, {**_binding(result), "table": "matches", "limit": 1})
    assert report["total"] == 2 and len(report["rows"]) == 1
    assert report["rows"][0]["reference_label"] == 13
    assert canonical_json(project_parents(wb.project, result)[reference["id"]]) == canonical_json(
        reference
    )
    assert wb.project.source(source["id"])["sha256"] == parent["source_sha256"]


@pytest.mark.parametrize(
    "field", ["source_id", "source_sha256", "geometry", "x", "z", "t", "c", "level"]
)
def test_equal_size_misaligned_inputs_are_refused_before_publication(scene, field):
    wb, source, parent, reference, request = scene
    changed = copy.deepcopy(reference)
    if field in {"source_id", "source_sha256"}:
        changed[field] = "f" * len(changed[field])
    elif field == "geometry":
        changed["provenance"]["geometry"]["unit"] = "mm"
    else:
        changed["provenance"]["selection"][field] += 1
    _rehash(changed)
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(changed), reference["id"])
        )
    request["reference"]["revision_hash"] = changed["revision_hash"]
    before = len(wb.project.list_results())
    with pytest.raises(ValueError):
        execute_annotation_evaluation(wb, request)
    assert len(wb.project.list_results()) == before


def test_stale_reference_and_memory_refused_without_new_result(scene):
    wb, _, _, _, request = scene
    bad = copy.deepcopy(request)
    bad["reference"]["revision_hash"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        validate_request(wb, bad)
    bad = copy.deepcopy(request)
    bad["working_bytes"] = 1024**2
    with pytest.raises(ValueError, match="memory"):
        validate_request(wb, bad)
    assert len(wb.project.list_results()) == 2


def test_cold_validation_uses_only_saved_arrays_and_rejects_rehashed_false_metrics(
    scene, monkeypatch
):
    wb, _, _, _, request = scene
    result = wb.project.result(execute_annotation_evaluation(wb, request)["result"]["id"])
    wb.close()
    reopened = Workbench(ResearchProject(wb.project.root))
    monkeypatch.setattr(
        reopened, "_session", lambda *_: pytest.fail("cold validation decoded source")
    )
    validate_project_arrays(reopened.project, result)
    altered = copy.deepcopy(result)
    altered["provenance"]["annotation_evaluation"]["metrics"]["region"]["iou"] = 0.2
    _rehash(altered)
    arrays = {name: reopened.project.load_array(d) for name, d in result["arrays"].items()}
    with pytest.raises(ValueError, match="endpoints"):
        validate_arrays(altered, arrays)
    arrays["reference_labels"] = np.zeros_like(arrays["reference_labels"])
    with pytest.raises(ValueError, match="array hash"):
        validate_arrays(result, arrays)


def test_cancellation_during_publication_does_not_publish(scene, monkeypatch):
    wb, _, _, _, request = scene
    original = wb.project.save_result

    def stage_then_cancel(**kwargs):
        def cancelled():
            raise RuntimeError("cancelled at atomic publication")

        kwargs["publication_guard"] = cancelled
        return original(**kwargs)

    monkeypatch.setattr(wb.project, "save_result", stage_then_cancel)
    with pytest.raises(RuntimeError, match="atomic publication"):
        execute_annotation_evaluation(wb, request)
    assert len(wb.project.list_results()) == 2


def test_freeze_edges_to_centers_snapshot_survives_later_annotation_edits(scene, monkeypatch):
    wb, source, parent, _, _ = scene
    state = _add(wb, source, [(2, 1), (4, 1), (4, 3), (2, 3)], kind="rectangle")
    selected = state["annotations"][0]["id"]
    # Other planes, unsupported lines, and shapes outside this crop stay undisclosed.
    _add(wb, source, [(2, 1), (4, 1), (4, 3), (2, 3)], z=0)
    _add(wb, source, [(2, 1), (4, 3)], kind="line")
    state = _add(wb, source, [(0, 0), (1, 0), (1, 1), (0, 1)])
    candidates = reference_candidates(wb, _binding(parent))
    assert [a["id"] for a in candidates["candidates"]] == [selected]
    freeze = {
        **_binding(parent),
        "source_annotations_revision": state["revision"],
        "annotation_ids": [selected],
        "semantics": "instances",
        "coverage_declaration": (
            "One synthetic square; comparison crop includes explicit background"
        ),
        "working_bytes": 32 * 1024**2,
    }
    reference = wb.project.result(execute_annotation_reference(wb, freeze)["result"]["id"])
    labels = wb.project.load_array(reference["arrays"]["labels"])
    expected = np.zeros((5, 6), np.uint32)
    expected[:2, :2] = 1
    assert np.array_equal(labels, expected)
    _add(wb, source, [(5, 4), (6, 4), (6, 5), (5, 5)])
    with pytest.raises(ValueError, match="changed"):
        validate_reference_request(wb, freeze)
    monkeypatch.setattr(wb, "_session", lambda *_: pytest.fail("frozen reference decoded source"))
    validate_project_arrays(wb.project, reference)
    assert "annotation_snapshot" not in public_summary(reference)["annotation_reference"]


def test_instance_polygon_overlap_refused_and_region_union_allowed(scene):
    wb, source, parent, _, _ = scene
    _add(wb, source, [(2, 1), (5, 1), (5, 4), (2, 4)])
    state = _add(wb, source, [(3, 2), (6, 2), (6, 5), (3, 5)])
    freeze = {
        **_binding(parent),
        "source_annotations_revision": state["revision"],
        "annotation_ids": [a["id"] for a in state["annotations"]],
        "semantics": "instances",
        "coverage_declaration": "Explicit overlapping technical polygons",
        "working_bytes": 32 * 1024**2,
    }
    with pytest.raises(ValueError, match="overlap"):
        execute_annotation_reference(wb, freeze)
    assert len(wb.project.list_results()) == 2
    freeze["semantics"] = "foreground-region"
    result = wb.project.result(execute_annotation_reference(wb, freeze)["result"]["id"])
    assert set(np.unique(wb.project.load_array(result["arrays"]["labels"]))) == {0, 1}
    validate_project_arrays(wb.project, result)


def test_exact_review_export_and_portable_restore_preserve_agreement(scene, tmp_path):
    import json

    from loci_engine.research_export import export_research_result
    from loci_engine.research_interchange import export_project, import_project

    wb, _, parent, reference, request = scene
    result = wb.project.result(execute_annotation_evaluation(wb, request)["result"]["id"])
    with pytest.raises(ValueError, match="Review"):
        export_research_result(
            wb.project, result["id"], result["revision_hash"], tmp_path / "unreviewed"
        )
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "reviewed-export"
    export_research_result(wb.project, result["id"], result["revision_hash"], destination)
    exported = json.loads((destination / "annotation-evaluation.json").read_text())
    assert exported == result["provenance"]["annotation_evaluation"]
    exported_reference = np.load(destination / "reference_labels.npy", allow_pickle=False)
    assert np.array_equal(exported_reference, wb.project.load_array(reference["arrays"]["labels"]))
    archive = tmp_path / "agreement.loci.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "restored.loci-study")
    actual = restored.result(result["id"])
    assert canonical_json(actual) == canonical_json(result)
    assert restored.result(parent["id"])["revision_hash"] == parent["revision_hash"]
    assert restored.result(reference["id"])["revision_hash"] == reference["revision_hash"]
    validate_project_arrays(restored, actual)


def test_uncalibrated_multiz_reference_preserves_distinct_raw_and_planar_frames(tmp_path):
    path = tmp_path / "uncalibrated-multiz.tif"
    tifffile.imwrite(path, np.ones((2, 8, 10), np.uint16), metadata={"axes": "ZYX"})
    wb = Workbench(ResearchProject.create(tmp_path / "pixel-reference.loci-study", "Pixel frames"))
    try:
        source = wb.import_native(str(path))
        image, geometry, selection = wb.load_scalar(
            source["id"],
            {
                "x": 2,
                "y": 1,
                "width": 6,
                "height": 5,
                "z": 1,
                "t": 0,
                "c": 0,
                "level": 0,
            },
        )
        assert geometry.unit == "pixel" and geometry.affine[2][3] == 0
        parent = wb.project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": image, "labels": np.zeros(image.shape, np.uint32)},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": selection,
                "runtime": runtime_record(),
                "measurement_channels": [0],
                "measurements": [],
            },
        )
        state = _add(wb, source, [(2, 1), (4, 1), (4, 3), (2, 3)], z=1, t=0)
        assert all(point[2] == 1 for point in state["annotations"][0]["world_xyz"])
        request = {
            **_binding(parent),
            "source_annotations_revision": state["revision"],
            "annotation_ids": [state["annotations"][0]["id"]],
            "semantics": "instances",
            "coverage_declaration": "Technical complete crop",
            "working_bytes": 32 * 1024**2,
        }
        reference = wb.project.result(execute_annotation_reference(wb, request)["result"]["id"])
        receipt = reference["provenance"]["annotation_reference"]
        assert receipt["annotation_snapshot"] == state["annotations"]
        assert receipt["source_geometry"]["axes"] == "ZYX"
        assert receipt["source_planar_geometry"]["axes"] == "YX"
        assert receipt["source_planar_geometry"]["affine"][2][3] == 0
        validate_source(reference, source)
        validate_project_arrays(wb.project, reference)
        # A self-consistent altered plane receipt cannot redefine native geometry.
        forged = copy.deepcopy(reference)
        forged["provenance"]["annotation_reference"]["source_planar_geometry"]["affine"][2][3] = 1
        _rehash(forged)
        with pytest.raises(ValueError, match="registered native geometry"):
            validate_source(forged, source)
    finally:
        wb.close()
