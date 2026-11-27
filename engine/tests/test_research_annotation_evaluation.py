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


def test_locate_returns_exact_crop_and_calibrated_coordinates_cold(scene, monkeypatch):
    wb, source, parent, reference, request = scene
    # Add a concave/U-shaped unmatched prediction object and an unmatched frozen reference
    # so locate verifies both owned-pixel selection and measurements-free frozen references.
    pred_labels = wb.project.load_array(parent["arrays"]["labels"]).copy()
    pred_labels[0:3, 4] = 900
    pred_labels[0, 5] = 900
    pred_labels[2, 5] = 900
    pred_with_concave = wb.project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": wb.project.load_array(parent["arrays"]["image"]), "labels": pred_labels},
        provenance=parent["provenance"],
    )
    ref_labels = np.zeros_like(pred_labels)
    ref_labels[:2, :2] = 29
    ref_labels[3:5, 0:2] = 31
    ref_with_unmatched = wb.project.save_result(
        source_id=source["id"],
        kind="external-labels",
        arrays={"image": wb.project.load_array(parent["arrays"]["image"]), "labels": ref_labels},
        provenance=reference["provenance"],
    )
    agreement_req = {
        **request,
        "result_id": pred_with_concave["id"],
        "revision_hash": pred_with_concave["revision_hash"],
        "reference": _binding(ref_with_unmatched),
    }
    agreement = wb.project.result(execute_annotation_evaluation(wb, agreement_req)["result"]["id"])
    # Cold/offline guarantee: locate must not decode the original source image.
    monkeypatch.setattr(wb, "_session", lambda *_: pytest.fail("locate decoded source image"))

    # Large uint32 prediction label at [0:2, 0:2] with crop origin (x=2, y=1) and 2x3 µm spacing.
    located_large = report_get(
        wb,
        {
            **_binding(agreement),
            "table": "locate",
            "role": "prediction",
            "label": 4_000_000_000,
        },
    )
    assert located_large["table"] == "locate"
    assert located_large["role"] == "prediction"
    assert located_large["label"] == 4_000_000_000
    assert located_large["target"] == {
        **_binding(pred_with_concave),
        "labels_sha256": pred_with_concave["arrays"]["labels"]["sha256"],
    }
    assert located_large["point_index"] == [0, 0]
    assert located_large["centroid_index"] == [0.5, 0.5]
    assert located_large["bbox_start"] == [0, 0]
    assert located_large["bbox_stop_exclusive"] == [2, 2]
    assert located_large["pixel_count"] == 4
    assert located_large["source_point_xy"] == [2, 1]
    assert located_large["source_centroid_xy"] == [2.5, 1.5]
    assert located_large["distance_unit"] == "um"
    assert located_large["world_point_xyz"] == [4.0, 3.0, 5.0]
    assert located_large["selection"] == agreement["provenance"]["selection"]

    # Concave unmatched prediction label: centroid (1.0, 4.4) is owned at (1, 4),
    # not at background pixel (1, 5).
    located_concave = report_get(
        wb,
        {**_binding(agreement), "table": "locate", "role": "prediction", "label": 900},
    )
    assert located_concave["point_index"] == [1, 4]
    assert pred_labels[tuple(located_concave["point_index"])] == 900
    assert located_concave["source_point_xy"] == [6, 2]
    assert located_concave["pixel_count"] == 5

    # Unmatched reference label on crop offset.
    located_ref = report_get(
        wb,
        {**_binding(agreement), "table": "locate", "role": "reference", "label": 31},
    )
    assert located_ref["role"] == "reference"
    assert located_ref["target"] == {
        **_binding(ref_with_unmatched),
        "labels_sha256": ref_with_unmatched["arrays"]["labels"]["sha256"],
    }
    assert located_ref["point_index"] == [3, 0]
    assert located_ref["source_point_xy"] == [2, 4]
    assert located_ref["world_point_xyz"] == [4.0, 12.0, 5.0]
    assert located_ref["pixel_count"] == 4


def test_locate_works_for_frozen_annotation_reference_without_measurements(scene, monkeypatch):
    wb, source, parent, _, request = scene
    state = _add(wb, source, [(2, 1), (4, 1), (4, 3), (2, 3)])
    frozen_req = {
        **_binding(parent),
        "source_annotations_revision": state["revision"],
        "annotation_ids": [state["annotations"][0]["id"]],
        "semantics": "instances",
        "coverage_declaration": "Technical frozen reference for cold locate",
        "working_bytes": 32 * 1024**2,
    }
    frozen_ref = wb.project.result(execute_annotation_reference(wb, frozen_req)["result"]["id"])
    assert frozen_ref["provenance"]["measurements"] == []
    agreement = wb.project.result(
        execute_annotation_evaluation(wb, {**request, "reference": _binding(frozen_ref)})["result"][
            "id"
        ]
    )
    monkeypatch.setattr(wb, "_session", lambda *_: pytest.fail("locate decoded source image"))
    located = report_get(
        wb,
        {**_binding(agreement), "table": "locate", "role": "reference", "label": 1},
    )
    assert located["target"]["result_id"] == frozen_ref["id"]
    assert located["target"]["revision_hash"] == frozen_ref["revision_hash"]
    assert located["point_index"] == [0, 0]
    assert located["source_point_xy"] == [2, 1]
    assert located["pixel_count"] == 4


def test_locate_refuses_stale_missing_mismatched_and_region_queries(scene):
    wb, _, parent, reference, request = scene
    agreement = wb.project.result(execute_annotation_evaluation(wb, request)["result"]["id"])

    # Missing label on prediction or reference
    with pytest.raises(ValueError, match="does not belong"):
        report_get(
            wb, {**_binding(agreement), "table": "locate", "role": "prediction", "label": 999}
        )
    with pytest.raises(ValueError, match="does not belong"):
        report_get(
            wb, {**_binding(agreement), "table": "locate", "role": "reference", "label": 7}
        )
    # Invalid role / label / extra keys
    with pytest.raises(ValueError, match="prediction or reference"):
        report_get(wb, {**_binding(agreement), "table": "locate", "role": "other", "label": 7})
    with pytest.raises(ValueError, match="object label"):
        report_get(wb, {**_binding(agreement), "table": "locate", "role": "prediction", "label": 0})
    with pytest.raises(ValueError, match="only role and label"):
        report_get(
            wb,
            {
                **_binding(agreement),
                "table": "locate",
                "role": "prediction",
                "label": 7,
                "limit": 1,
            },
        )
    with pytest.raises(ValueError, match="object location parameters"):
        report_get(
            wb,
            {**_binding(agreement), "table": "matches", "role": "prediction"},
        )
    # Wrong agreement revision
    with pytest.raises(ValueError, match="exact saved annotation-agreement revision"):
        report_get(
            wb,
            {
                "result_id": agreement["id"],
                "revision_hash": "0" * 64,
                "table": "locate",
                "role": "prediction",
                "label": 7,
            },
        )
    # Foreground-region agreement cannot locate instances
    region_agreement = wb.project.result(
        execute_annotation_evaluation(
            wb, {**request, "semantics": "foreground-region", "iou_thresholds": []}
        )["result"]["id"]
    )
    with pytest.raises(ValueError, match="instance annotation agreement"):
        report_get(
            wb,
            {**_binding(region_agreement), "table": "locate", "role": "prediction", "label": 1},
        )
    # Mismatched parent revision in project store must fail closed
    tampered_parent = copy.deepcopy(parent)
    tampered_parent["created_at"] = "2099-01-01T00:00:00Z"
    _rehash(tampered_parent)
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?",
            (canonical_json(tampered_parent), parent["id"]),
        )
    with pytest.raises(ValueError, match="parent|revision|missing"):
        report_get(
            wb, {**_binding(agreement), "table": "locate", "role": "prediction", "label": 7}
        )


def _model_result(wb, source, selection, geometry, labels, *, source_channel=0, channels=None):
    """Build an immutable model-segmentation record matching model_run's exact 7-key selection."""
    model_selection = {k: v for k, v in selection.items() if k != "c"}
    declared = channels or [{"name": "nuclei", "source_index": 0}]
    mapping = [
        {
            "model_input_index": i,
            "model_channel": item["name"],
            "package_source_slot": item["source_index"],
            "source_channel": source_channel if i == 0 else i,
        }
        for i, item in enumerate(declared)
    ]
    image = np.where(labels > 0, np.float32(0.9), np.float32(0.1)).astype(np.float32)
    return wb.project.save_result(
        source_id=source["id"],
        kind="model-segmentation",
        arrays={"image": image, "labels": labels},
        provenance={
            "geometry": geometry.to_dict(),
            "selection": model_selection,
            "model": {
                "id": "synthetic-onnx-nuclei",
                "version": "1.0.0",
                "input": {
                    "axes": "BCYX",
                    "dtype": "float32",
                    "shape": [1, len(declared), labels.shape[0], labels.shape[1]],
                    "channels": declared,
                },
            },
            "channel_mapping": mapping,
            "runtime": runtime_record(),
            "measurement_channels": [source_channel],
            "measurements": [],
        },
    )


def test_single_channel_model_without_c_compares_in_both_role_orders_and_roundtrips_cold(
    tmp_path, monkeypatch
):
    from loci_engine.research_interchange import export_project, import_project
    from loci_engine.workbench import result_summary

    path = tmp_path / "two-channel-model.ome.tif"
    raw = np.zeros((1, 2, 1, 8, 10), dtype=np.uint16)
    raw[0, 0, 0, 1:6, 2:8] = 500
    raw[0, 1, 0, 1:6, 2:8] = 100
    tifffile.imwrite(
        path,
        raw,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 2.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 3.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "model-cmp.loci-study", "Model comparison"))
    try:
        source = wb.import_native(str(path))
        image, geometry, selection = wb.load_scalar(
            source["id"],
            {"x": 2, "y": 1, "width": 6, "height": 5, "z": 0, "t": 0, "c": 0, "level": 0},
        )
        classical_labels = np.zeros(image.shape, np.uint32)
        classical_labels[0:2, 0:2] = 5
        classical_labels[3:5, 3:5] = 9
        classical = wb.project.save_result(
            source_id=source["id"],
            kind="adaptive-segmentation",
            arrays={"image": image, "labels": classical_labels},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": selection,
                "runtime": runtime_record(),
                "measurement_channels": [0],
                "measurements": [],
            },
        )
        model_labels = np.zeros(image.shape, np.uint32)
        model_labels[0:2, 0:2] = 101
        model_labels[3:5, 0:2] = 202
        model_res = _model_result(wb, source, selection, geometry, model_labels, source_channel=0)
        original_model_json = canonical_json(model_res)
        archived_selection = {key: value for key, value in selection.items() if key != "c"}
        assert model_res["provenance"]["selection"] == archived_selection
        assert len(archived_selection) == 7
        summary = result_summary(model_res)
        assert summary["channel_mapping"] == model_res["provenance"]["channel_mapping"]
        assert "c" not in summary["selection"]

        # Both role orders must succeed without mutating the prior immutable model result.
        for pred, ref, unmatched_pred_label, unmatched_ref_label in (
            (model_res, classical, 202, 9),
            (classical, model_res, 9, 202),
        ):
            out = execute_annotation_evaluation(
                wb,
                {
                    **_binding(pred),
                    "reference": _binding(ref),
                    "semantics": "instances",
                    "iou_thresholds": [0.5],
                    "reference_declaration": (
                        "Classical vs ONNX prediction disagreement; neither is ground truth."
                    ),
                    "working_bytes": 32 * 1024**2,
                },
            )
            agreement = wb.project.result(out["result"]["id"])
            assert agreement["provenance"]["selection"] == selection
            assert canonical_json(wb.project.result(model_res["id"])) == original_model_json

            # Cold locate works on both roles without decoding the source image.
            monkeypatch.setattr(
                wb, "_session", lambda *_: pytest.fail("cold locate decoded source")
            )
            loc_pred = report_get(
                wb,
                {
                    **_binding(agreement),
                    "table": "locate",
                    "role": "prediction",
                    "label": unmatched_pred_label,
                },
            )
            loc_ref = report_get(
                wb,
                {
                    **_binding(agreement),
                    "table": "locate",
                    "role": "reference",
                    "label": unmatched_ref_label,
                },
            )
            assert loc_pred["target"]["result_id"] == pred["id"]
            assert loc_ref["target"]["result_id"] == ref["id"]
            assert loc_pred["selection"] == selection
            monkeypatch.undo()

        # Portable archive round-trip preserves immutable model record and validates cold.
        archive = tmp_path / "model-cmp.loci.zip"
        export_project(wb.project, archive)
        restored = import_project(archive, tmp_path / "restored.loci-study")
        assert canonical_json(restored.result(model_res["id"])) == original_model_json
        for row in restored.list_results():
            if row["kind"] == "annotation-agreement":
                validate_project_arrays(restored, restored.result(row["id"]))
    finally:
        wb.close()


def test_real_onnx_model_run_compares_with_classical_offline(tmp_path, monkeypatch):
    pytest.importorskip("onnxruntime")
    pytest.importorskip("onnx")
    from test_model_packages import _native_package
    from test_research_models import _request as model_request
    from test_research_models import _source as model_source

    from loci_engine.research_models import execute_model, import_model

    wb = Workbench(ResearchProject.create(tmp_path / "onnx-real.loci-study", "Real ONNX"))
    try:
        _src_path, source = model_source(wb, tmp_path, scale=0.5)
        package_dir, *_ = _native_package(tmp_path / "pkg")
        imported = import_model(wb, package_dir)
        request = model_request(imported["model_id"], source["id"])
        preview = execute_model(wb, "model_preview", request)
        assert preview["preview"]["source"]["selection"] == request["selection"]
        run_out = execute_model(
            wb,
            "model_run",
            {
                "preview_id": preview["preview"]["id"],
                "preview_sha256": preview["preview"]["preview_sha256"],
            },
        )
        onnx_result = wb.project.result(run_out["result"]["id"])
        assert onnx_result["kind"] == "model-segmentation"
        selection = {**request["selection"], "c": request["channel_mapping"][0]["source_channel"]}
        assert onnx_result["provenance"]["selection"] == selection
        assert run_out["result"]["selection"] == selection
        onnx_before = canonical_json(onnx_result)

        classical_out = wb.run_recipe(
            {
                "source_id": source["id"],
                "selection": selection,
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 0.4},
                    "measurement_channels": [0],
                },
            }
        )
        classical = wb.project.result(classical_out["result"]["id"])
        agreement_out = execute_annotation_evaluation(
            wb,
            {
                **_binding(onnx_result),
                "reference": _binding(classical),
                "semantics": "instances",
                "iou_thresholds": [0.5],
                "reference_declaration": (
                    "Real ONNX model_run vs classical components disagreement."
                ),
                "working_bytes": 32 * 1024**2,
            },
        )
        agreement = wb.project.result(agreement_out["result"]["id"])
        assert agreement["provenance"]["selection"] == selection
        assert canonical_json(wb.project.result(onnx_result["id"])) == onnx_before

        monkeypatch.setattr(wb, "_session", lambda *_: pytest.fail("cold locate decoded source"))
        matches = report_get(
            wb, {**_binding(agreement), "table": "matches", "threshold_index": 0, "offset": 0}
        )
        assert matches["total"] >= 1
        pair = matches["rows"][0]
        located = report_get(
            wb,
            {
                **_binding(agreement),
                "table": "locate",
                "role": "prediction",
                "label": pair["prediction_label"],
            },
        )
        assert located["target"]["result_id"] == onnx_result["id"]
        assert located["target"]["revision_hash"] == onnx_result["revision_hash"]
    finally:
        wb.close()


@pytest.mark.parametrize(
    "case",
    [
        "multi-channel",
        "missing-mapping",
        "missing-model-contract",
        "name-mismatch",
        "shape-mismatch",
        "channel-mismatch",
        "out-of-range",
        "non-model-missing-c",
        "contradictory-c",
    ],
)
def test_model_without_c_refuses_ambiguous_missing_mismatched_and_out_of_range_channels(
    tmp_path, case
):
    path = tmp_path / "neg-two-channel.ome.tif"
    tifffile.imwrite(
        path,
        np.ones((1, 2, 1, 8, 10), dtype=np.uint16),
        ome=True,
        metadata={"axes": "TCZYX", "PhysicalSizeX": 1.0, "PhysicalSizeY": 1.0},
    )
    wb = Workbench(ResearchProject.create(tmp_path / f"neg-{case}.loci-study", "Negatives"))
    try:
        source = wb.import_native(str(path))
        image, geometry, selection = wb.load_scalar(
            source["id"],
            {"x": 1, "y": 1, "width": 6, "height": 5, "z": 0, "t": 0, "c": 0, "level": 0},
        )
        labels = np.zeros(image.shape, np.uint32)
        labels[:2, :2] = 1
        classical = wb.project.save_result(
            source_id=source["id"],
            kind="adaptive-segmentation",
            arrays={"image": image, "labels": labels},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": selection,
                "runtime": runtime_record(),
                "measurement_channels": [0],
                "measurements": [],
            },
        )
        if case == "multi-channel":
            bad = _model_result(
                wb,
                source,
                selection,
                geometry,
                labels,
                source_channel=0,
                channels=[{"name": "nuc", "source_index": 0}, {"name": "cyto", "source_index": 1}],
            )
        elif case == "channel-mismatch":
            bad = _model_result(wb, source, selection, geometry, labels, source_channel=1)
        elif case == "out-of-range":
            bad = _model_result(wb, source, selection, geometry, labels, source_channel=2)
        elif case == "non-model-missing-c":
            bad = wb.project.save_result(
                source_id=source["id"],
                kind="segmentation",
                arrays={"image": image, "labels": labels},
                provenance={
                    "geometry": geometry.to_dict(),
                    "selection": {k: v for k, v in selection.items() if k != "c"},
                    "runtime": runtime_record(),
                    "measurement_channels": [0],
                    "measurements": [],
                },
            )
        else:
            bad = _model_result(wb, source, selection, geometry, labels, source_channel=0)
            mutated = copy.deepcopy(bad)
            if case == "missing-mapping":
                mutated["provenance"].pop("channel_mapping")
            elif case == "missing-model-contract":
                mutated["provenance"].pop("model")
            elif case == "name-mismatch":
                mutated["provenance"]["channel_mapping"][0]["model_channel"] = "other"
            elif case == "shape-mismatch":
                mutated["provenance"]["model"]["input"]["shape"] = [1, 2, 5, 6]
            elif case == "contradictory-c":
                mutated["provenance"]["selection"]["c"] = 1
            _rehash(mutated)
            with wb.project.connection() as connection:
                connection.execute(
                    "UPDATE results SET record=? WHERE id=?", (canonical_json(mutated), bad["id"])
                )
            bad = mutated

        before = len(wb.project.list_results())
        with pytest.raises(ValueError):
            execute_annotation_evaluation(
                wb,
                {
                    **_binding(bad),
                    "reference": _binding(classical),
                    "semantics": "instances",
                    "iou_thresholds": [0.5],
                    "reference_declaration": "Negative channel derivation fixture",
                    "working_bytes": 32 * 1024**2,
                },
            )
        assert len(wb.project.list_results()) == before
    finally:
        wb.close()


def test_locate_rejects_stale_revision_and_tiny_budget_before_decode(scene, monkeypatch):
    wb, _, _, _, request = scene
    agreement = execute_annotation_evaluation(wb, request)["result"]
    locate = {**_binding(agreement), "table": "locate", "role": "reference", "label": 13}

    def unexpected_decode(*args, **kwargs):
        pytest.fail("Refused locate decoded retained arrays")

    monkeypatch.setattr(wb.project, "load_array", unexpected_decode)
    with pytest.raises(ValueError, match="exact saved annotation-agreement revision"):
        report_get(wb, {**locate, "revision_hash": "0" * 64})
    with pytest.raises(ValueError, match="budget before decode"):
        report_get(wb, locate, working_bytes=1024**2)


def test_mcp_action_registry_locate_authorizes_both_parents_and_enforces_memory_budget(
    tmp_path, monkeypatch
):
    from test_research_agent_setup import access_request

    from loci_engine.agent_actions import inspect_action
    from loci_engine.agent_policy import DISCLOSURES, load_policy
    from loci_engine.research_action_registry import REQUESTS
    from loci_engine.research_agent_setup import create_agent_access
    from loci_engine.research_mcp import PolicyAgent

    operation = "annotation_evaluation_get"
    schema = REQUESTS[operation]["properties"]
    assert "locate" in schema["table"]["enum"]
    assert schema["role"]["enum"] == ["prediction", "reference"]
    assert "label" in schema

    # 770² pixels fit the grant recipe estimate, while replay exceeds 64 MiB.
    # Independent measurement channels let us withhold either parent's grant.
    path = tmp_path / "locate.ome.tif"
    raw = np.zeros((3, 772, 773), dtype=np.uint16)
    raw[0, 4:6, 5:7] = 500
    raw[0, 10:12, 14:16] = 250
    raw[1:] = 100
    tifffile.imwrite(path, raw, ome=True, metadata={"axes": "CYX"})
    wb = Workbench(ResearchProject.create(tmp_path / "locate.loci-study", "Locate grants"))
    try:
        source = wb.import_native(str(path))
        selection = {
            "x": 2,
            "y": 1,
            "width": 770,
            "height": 770,
            "z": 0,
            "t": 0,
            "c": 0,
            "level": 0,
        }
        mib = 1024**2

        def recipe_request(threshold, channels):
            return {
                "source_id": source["id"],
                "selection": selection,
                "recipe": {
                    "segmentation": {"method": "components", "threshold": threshold},
                    "measurement_channels": channels,
                    "working_bytes": 64 * mib,
                },
            }

        prediction = wb.run_recipe(recipe_request(400, [1]))["result"]
        reference = wb.run_recipe(recipe_request(200, [2]))["result"]
        agreement = execute_annotation_evaluation(
            wb,
            {
                **_binding(prediction),
                "reference": _binding(reference),
                "semantics": "instances",
                "iou_thresholds": [0.5],
                "reference_declaration": "Synthetic single-plane predictions for scoped locate",
                "working_bytes": 128 * mib,
            },
        )["result"]

        def scoped_agent(name, channels, memory_mib=512):
            destination = tmp_path / name
            create_agent_access(
                wb,
                access_request(
                    recipe_request(200, channels),
                    allow_run=False,
                    disclosures=sorted(DISCLOSURES),
                    limits={"cpu_seconds": 60, "memory_bytes": memory_mib * mib, "concurrency": 1},
                    delegation={
                        "client_id": "codex",
                        "expires_at": None,
                        "result_scope": "granted-sources",
                        "allow_review": False,
                    },
                    actions=[operation],
                ),
                destination,
            )
            return PolicyAgent(load_policy(destination / "agent-policy.json"))

        agent = scoped_agent("both-parents", [1, 2])
        prediction_only = scoped_agent("prediction-only", [1])
        reference_only = scoped_agent("reference-only", [2])
        tight = scoped_agent("minimum-budget", [1, 2], 64)

        loc_pred = {**_binding(agreement), "table": "locate", "role": "prediction", "label": 1}
        loc_ref = {**loc_pred, "role": "reference", "label": 2}

        def unexpected_source(*args, **kwargs):
            pytest.fail("Saved result locate decoded the raw source")

        monkeypatch.setattr(wb, "_session", unexpected_source)
        for query, parent, point in (
            (loc_pred, prediction, [5, 4]),
            (loc_ref, reference, [14, 10]),
        ):
            located = inspect_action(agent, wb, operation, query)
            assert agent.inspect_action(operation, query) == located
            assert located["target"] == {
                **_binding(parent),
                "labels_sha256": parent["arrays"]["labels"]["sha256"],
            }
            assert located["role"] == query["role"]
            assert located["label"] == query["label"]
            assert located["source_point_xy"] == point
            assert located["pixel_count"] == 4

        with pytest.raises(ValueError, match="does not belong"):
            inspect_action(agent, wb, operation, {**loc_pred, "label": 2})

        def unexpected_array(*args, **kwargs):
            pytest.fail("Refused MCP locate decoded retained arrays")

        monkeypatch.setattr(wb.project, "load_array", unexpected_array)
        with pytest.raises(ValueError, match="role and label"):
            inspect_action(agent, wb, operation, {**_binding(agreement), "table": "locate"})
        with pytest.raises(ValueError, match="only role and label"):
            inspect_action(agent, wb, operation, {**loc_pred, "limit": 10})
        with pytest.raises(PermissionError, match="revision changed"):
            inspect_action(agent, wb, operation, {**loc_pred, "revision_hash": "0" * 64})
        with pytest.raises(PermissionError, match="memory budget"):
            inspect_action(tight, wb, operation, loc_pred)
        with pytest.raises(PermissionError, match="measurement channels exceed the grant"):
            inspect_action(prediction_only, wb, operation, loc_pred)
        with pytest.raises(PermissionError, match="measurement channels exceed the grant"):
            inspect_action(reference_only, wb, operation, loc_ref)
    finally:
        wb.close()
