import copy
import csv
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import measure_objects
from loci_engine.research_cli import execute, parser
from loci_engine.research_correction_effect import export_effect, validate_document
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_rpc import dispatch_research
from loci_engine.workbench import Workbench


def _scene(tmp_path):
    return Workbench(ResearchProject.create(tmp_path / "effects.loci-study", "Effects"))


def _parent(wb, tmp_path, index, labels, replicate="R1", physical=False):
    file = tmp_path / f"source-{index}.ome.tif"
    metadata = {"axes": "YX" if labels.ndim == 2 else "ZYX"}
    if physical:
        metadata.update(
            {
                "PhysicalSizeX": 0.5,
                "PhysicalSizeY": 0.5,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeYUnit": "µm",
            }
        )
        if labels.ndim == 3:
            metadata.update({"PhysicalSizeZ": 2, "PhysicalSizeZUnit": "µm"})
    tifffile.imwrite(
        file,
        np.full(labels.shape, index + 10, np.uint16),
        ome=True,
        metadata=metadata,
        photometric="minisblack",
    )
    source = wb.import_native(str(file))
    selection_request = {} if labels.ndim == 2 else {"z": 0, "z_stop": labels.shape[0]}
    image, geometry, selection = wb.load_scalar(source["id"], selection_request)
    result = wb.project.save_result(
        source_id=source["id"],
        kind="segmented",
        arrays={"image": image, "labels": labels},
        provenance={
            "geometry": geometry.to_dict(),
            "selection": selection,
            "recipe": {"segmentation": {"method": "components", "threshold": 5}},
            "measurement_basis": "raw-selected-channel-values-on-result-grid",
            "measurements": measure_objects(labels, geometry),
        },
    )
    wb.execute(
        "sample",
        {
            "id": source["id"],
            "data": {
                "study": "Effects",
                "sample": f"field-{index}",
                "condition": "control",
                "biological_replicate": replicate,
            },
        },
    )
    return result


def _labels(width=2, second=None):
    values = np.zeros((20, 22), np.uint32)
    values[2:4, 2 : 2 + width] = 7
    if second is not None:
        values[10:12, 3 : 3 + second] = 100000
    return values


def _correct(wb, parent, operation):
    info = wb.execute(
        "correction_info", {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    )
    operations = [{**operation, "expected_input_sha256": info["label_sha256"]}]
    response = wb.execute(
        "correct_result",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "operations": operations,
        },
    )
    return wb.project.result(response["result"]["id"])


def _request(before, after):
    return {
        "before_result_ids": [r["id"] for r in before],
        "after_result_ids": [r["id"] for r in after],
        "value": "measure",
    }


def _calculate(wb, before, after):
    return wb.execute("study_correction_effect", _request(before, after))


def _review(wb, results, disposition="reviewed"):
    for result in results:
        wb.project.review(result["id"], result["revision_hash"], disposition)


def _cohort(wb, tmp_path):
    parents = [
        _parent(wb, tmp_path, index, _labels(width), replicate)
        for index, (width, replicate) in enumerate(((2, "R1"), (4, "R1"), (3, "R2"), (8, "R2")))
    ]
    child = _correct(
        wb,
        parents[0],
        {
            "op": "polygon_replace",
            "plane": "XY",
            "index": 0,
            "label": 7,
            "points": [{"u": 2, "v": 2}, {"u": 6, "v": 2}, {"u": 6, "v": 3}, {"u": 2, "v": 3}],
        },
    )
    return parents, [child, *parents[1:]]


def _document(wb):
    return wb.project.documents("comparison")[-1]


def _reidentify(document):
    receipt = document["data"]["receipt"]
    receipt["receipt_sha256"] = hashlib.sha256(
        canonical_json({k: v for k, v in receipt.items() if k != "receipt_sha256"}).encode()
    ).hexdigest()
    document["id"] = receipt["receipt_sha256"][:32]


def test_equal_image_then_equal_replicate_weights_independent_oracle(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    original = {r["id"]: copy.deepcopy(r) for r in before}
    original_files = {
        p: hashlib.sha256(p.read_bytes()).hexdigest() for p in tmp_path.glob("source-*.ome.tif")
    }
    result = _calculate(wb, before, after)
    assert result["schema"] == "loci.study-correction-effect/v1"
    assert result["unit"] == "pixel^2"
    assert result["p_values"] is None
    assert result["conditions"] == [
        {
            "study": "Effects",
            "condition": "control",
            "biological_n": 2,
            "image_pair_count": 4,
            "omitted_image_pair_count": 0,
            "before_mean": 8.5,
            "after_mean": 10.0,
            "mean_difference": 1.5,
        }
    ]
    assert [r["mean_difference"] for r in result["replicates"]] == [3, 0]
    edited = next(row for row in result["images"] if row["correction"])
    assert edited["before_mean"] == 4 and edited["after_mean"] == 10
    assert edited["before_count"] == edited["after_count"] == 1
    assert edited["count_difference"] == 0
    assert edited["correction"]["changed_retained_label_ids"] == [7]
    assert edited["correction"]["changed_voxel_count"] == 6
    assert edited["needs_review"] and edited["eligible"]
    assert all(
        canonical_json(wb.project.result(key)) == canonical_json(record)
        for key, record in original.items()
    )
    assert all(
        hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in original_files.items()
    )
    persisted = _document(wb)
    assert wb.snapshot()["comparisons"] == [persisted]
    assert _calculate(wb, before, after)["receipt_sha256"] == result["receipt_sha256"]
    wb.close()
    reopened = Workbench(ResearchProject(tmp_path / "effects.loci-study"))
    assert reopened.snapshot()["comparisons"] == [persisted]
    reopened.close()


@pytest.mark.parametrize("op", ["delete", "merge", "watershed_split", "brush"])
def test_real_correction_audit_and_membership(tmp_path, op):
    wb = _scene(tmp_path)
    parent = _parent(wb, tmp_path, 0, _labels(3, second=2))
    operations = {
        "delete": {"op": op, "label": 7},
        "merge": {"op": op, "source_labels": [7, 100000], "target_label": 7},
        "watershed_split": {
            "op": op,
            "mode": "2D",
            "plane": "XY",
            "index": 0,
            "label": 7,
            "seeds": [{"u": 2, "v": 2}, {"u": 4, "v": 3}],
        },
        "brush": {
            "op": op,
            "mode": "paint",
            "plane": "XY",
            "index": 0,
            "label": 7,
            "points": [{"u": 5, "v": 2}],
            "radius": 0.1,
        },
    }
    child = _correct(wb, parent, operations[op])
    row = _calculate(wb, [parent], [child])["images"][0]
    audit = row["correction"]
    assert audit["operations"] == child["provenance"]["correction"]["operations"]
    assert audit["changed_voxel_count"] > 0
    assert row["mean_difference"] == row["after_mean"] - row["before_mean"]
    if op == "delete":
        assert audit["removed_label_ids"] == [7]
        assert row["count_difference"] == -1
    elif op == "merge":
        assert audit["removed_label_ids"] == [100000]
        assert audit["changed_retained_label_ids"] == [7]
    elif op == "watershed_split":
        assert audit["added_label_ids"] == [1]
        assert audit["changed_retained_label_ids"] == [7]
    else:
        assert row["count_difference"] == 0
        assert audit["changed_retained_label_ids"] == [7]
    wb.close()


def test_asymmetric_exclusions_empty_and_unassigned_are_paired_omissions(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _review(wb, [after[0]], "excluded")
    empty_parent = _parent(wb, tmp_path, 10, _labels(1), "R3", physical=False)
    empty_child = _correct(wb, empty_parent, {"op": "delete", "label": 7})
    unassigned = _parent(wb, tmp_path, 11, _labels(2), None)
    result = _calculate(wb, [*before, empty_parent, unassigned], [*after, empty_child, unassigned])
    assert result["conditions"][0]["mean_difference"] == 0
    assert result["conditions"][0]["biological_n"] == 2
    assert result["conditions"][0]["image_pair_count"] == 3
    assert result["conditions"][0]["omitted_image_pair_count"] == 3
    rows = {row["source_id"]: row for row in result["images"]}
    excluded = rows[before[0]["source_id"]]
    assert not excluded["eligible"] and excluded["omission_reasons"] == ["after excluded"]
    empty = rows[empty_parent["source_id"]]
    assert empty["after_count"] == 0 and empty["after_mean"] is None
    assert empty["mean_difference"] is None and empty["omission_reasons"] == [
        "after empty population"
    ]
    assert rows[unassigned["source_id"]]["omission_reasons"] == ["biological replicate unassigned"]
    assert (
        next(r for r in result["replicates"] if r["biological_replicate"] == "R3")["before_mean"]
        is None
    )
    wb.close()


def test_empty_calibrated_population_keeps_geometry_unit(tmp_path):
    wb = _scene(tmp_path)
    parent = _parent(wb, tmp_path, 0, _labels(2), physical=True)
    child = _correct(wb, parent, {"op": "delete", "label": 7})
    result = _calculate(wb, [parent], [child])
    assert result["unit"] == "um^2"
    assert result["images"][0]["before_mean"] == 1
    assert result["images"][0]["after_mean"] is None
    assert result["conditions"][0]["biological_n"] == 0
    assert result["conditions"][0]["before_mean"] is None
    wb.close()


def test_unequal_object_and_field_counts_do_not_change_equal_replicate_effect(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    peer = _parent(wb, tmp_path, 10, _labels(1, second=1), "R2")
    result = _calculate(wb, [*before, peer], [*after, peer])
    # R1 image means 4,8 -> 10,8 give 3. R2 has three unchanged
    # fields, one with two objects, so its change is zero. Each replicate
    # contributes one half, independent of image and object counts.
    assert result["conditions"][0]["before_mean"] == 7
    assert result["conditions"][0]["after_mean"] == 8.5
    assert result["conditions"][0]["mean_difference"] == 1.5
    assert [r["image_pair_count"] for r in result["replicates"]] == [2, 3]
    wb.close()


def test_vertex_boundary_audit_replays_exact_membership(tmp_path):
    wb = _scene(tmp_path)
    labels = np.zeros((32, 36), np.uint32)
    labels[5:27, 6:30] = 7
    labels[12:20, 14:22] = 0
    parent = _parent(wb, tmp_path, 0, labels)
    info = wb.execute(
        "correction_info",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "plane": "XY",
            "index": 0,
            "label": 7,
        },
    )
    source = info["boundary"]["vertices_uv"]
    edited = copy.deepcopy(source)
    position = min(range(len(source)), key=lambda i: source[i]["u"] + source[i]["v"])
    edited[position]["u"] -= 1
    edited[position]["v"] -= 1
    child = _correct(
        wb,
        parent,
        {
            "op": "move_boundary_vertex",
            "plane": "XY",
            "index": 0,
            "label": 7,
            "source_vertices": source,
            "vertices": edited,
        },
    )
    receipt = _calculate(wb, [parent], [child])
    row = receipt["images"][0]
    assert row["correction"]["operations"][0]["op"] == "move_boundary_vertex"
    assert row["count_difference"] == 0
    assert row["correction"]["changed_retained_label_ids"] == [7]
    assert row["mean_difference"] > 0
    assert not wb.project.load_array(child["arrays"]["labels"])[12:20, 14:22].any()
    wb.close()


def test_3d_calibrated_volume_effect_retains_sparse_ids(tmp_path):
    wb = _scene(tmp_path)
    labels = np.zeros((4, 12, 14), np.uint32)
    labels[1:3, 2:4, 2:4] = 7
    labels[1:3, 7:10, 7:10] = 100000
    parent = _parent(wb, tmp_path, 0, labels, physical=True)
    child = _correct(
        wb,
        parent,
        {
            "op": "merge",
            "source_labels": [7, 100000],
            "target_label": 100000,
        },
    )
    result = _calculate(wb, [parent], [child])
    assert result["unit"] == "um^3"
    row = result["images"][0]
    # Calibrated voxel volume = .5*.5*2 = .5 um^3;
    # parent volumes 4,9 -> merged volume13.
    assert row["before_mean"] == 6.5 and row["after_mean"] == 13
    assert row["mean_difference"] == 6.5
    assert row["correction"]["changed_retained_label_ids"] == [100000]
    wb.close()


def test_portable_historical_snapshot_replays_without_raw_sources(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _review(wb, before + after)
    calculated = _calculate(wb, before, after)
    document = _document(wb)
    source_id = before[1]["source_id"]
    sample = next(s for s in wb.project.documents("sample") if s["id"] == source_id)
    wb.execute(
        "sample",
        {
            "id": source_id,
            "data": {**sample["data"], "biological_replicate": "R2"},
            "expected_revision": sample["revision"],
        },
    )
    _review(wb, [after[0]], "pending")
    archive = tmp_path / "portable.zip"
    export_project(wb.project, archive)
    wb.close()
    for source in tmp_path.glob("source-*.ome.tif"):
        source.unlink()
    imported = Workbench(import_project(archive, tmp_path / "imported.loci-study"))
    assert imported.project.documents("comparison") == [document]
    results = {r["id"]: r for r in imported.project.list_results()}
    receipt = validate_document(document, results, imported.project.load_array)
    assert receipt["receipt_sha256"] == calculated["receipt_sha256"]
    assert receipt["conditions"][0]["mean_difference"] == 1.5
    with pytest.raises(ValueError, match="stale"):
        export_effect(imported.project, receipt["receipt_sha256"], tmp_path / "stale")
    imported.close()


@pytest.mark.parametrize("attack", ["mean", "count", "audit", "ids", "binding", "runtime"])
def test_forged_receipt_rehashed_still_fails_reconstruction(tmp_path, attack):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _calculate(wb, before, after)
    forged = copy.deepcopy(_document(wb))
    receipt = forged["data"]["receipt"]
    if attack == "mean":
        receipt["conditions"][0]["mean_difference"] = 999
    elif attack == "count":
        receipt["images"][0]["before_count"] += 1
    elif attack == "audit":
        next(r for r in receipt["images"] if r["correction"])["correction"][
            "changed_voxel_count"
        ] += 1
    elif attack == "ids":
        next(r for r in receipt["images"] if r["correction"])["correction"][
            "changed_retained_label_ids"
        ] = []
    elif attack == "binding":
        receipt["before_bindings"][0]["arrays"]["labels"]["sha256"] = "a" * 64
    else:
        receipt["runtime"]["scientific_validation"] = "validated"
    _reidentify(forged)
    results = {r["id"]: r for r in before + after}
    with pytest.raises(ValueError):
        validate_document(forged, results, wb.project.load_array)
    wb.close()


@pytest.mark.parametrize(
    "attack",
    [
        "count_bool",
        "count_float",
        "mean_int",
        "descriptor_bytes",
        "descriptor_shape",
        "scope_affine",
    ],
)
def test_original_hash_cannot_hide_python_equal_scalar_substitution(tmp_path, attack):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _calculate(wb, before, after)
    original = _document(wb)
    forged = copy.deepcopy(original)
    receipt = forged["data"]["receipt"]
    binding = receipt["before_bindings"][0]
    if attack == "count_bool":
        receipt["images"][0]["before_count"] = True
    elif attack == "count_float":
        receipt["images"][0]["before_count"] = float(receipt["images"][0]["before_count"])
    elif attack == "mean_int":
        receipt["images"][0]["before_mean"] = int(receipt["images"][0]["before_mean"])
    elif attack == "descriptor_bytes":
        binding["arrays"]["labels"]["bytes"] = float(binding["arrays"]["labels"]["bytes"])
    elif attack == "descriptor_shape":
        binding["arrays"]["labels"]["shape"][0] = float(binding["arrays"]["labels"]["shape"][0])
    else:
        binding["scope"]["geometry"]["affine"][0][0] = int(
            binding["scope"]["geometry"]["affine"][0][0]
        )
    # This is exactly the unsafe equivalence the receipt boundary must reject.
    assert receipt == original["data"]["receipt"]
    assert canonical_json(receipt) != canonical_json(original["data"]["receipt"])
    assert receipt["receipt_sha256"] == original["data"]["receipt"]["receipt_sha256"]
    results = {result["id"]: result for result in before + after}
    with pytest.raises(ValueError, match="forged|arithmetic"):
        validate_document(forged, results, wb.project.load_array)
    wb.close()


def test_original_hash_scalar_forgery_fails_portable_import(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _calculate(wb, before, after)
    forged = copy.deepcopy(_document(wb))
    forged["data"]["receipt"]["images"][0]["before_count"] = True
    wb.project.put_document("comparison", forged["id"], forged["data"], expected_revision=1)
    archive = tmp_path / "forged-scalar.zip"
    export_project(wb.project, archive)
    target = tmp_path / "forged-scalar-import.loci-study"
    with pytest.raises(ValueError, match="arithmetic"):
        import_project(archive, target)
    assert not target.exists()
    wb.close()


def test_current_export_rejects_python_equal_descriptor_binding(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _review(wb, before + after)
    result = _calculate(wb, before, after)
    forged = copy.deepcopy(_document(wb))
    labels = forged["data"]["receipt"]["before_bindings"][0]["arrays"]["labels"]
    labels["bytes"] = float(labels["bytes"])
    wb.project.put_document("comparison", forged["id"], forged["data"], expected_revision=1)
    target = tmp_path / "forged-descriptor-export"
    with pytest.raises(ValueError, match="stale"):
        export_effect(wb.project, result["receipt_sha256"], target)
    assert not target.exists()
    wb.close()


def test_import_rejects_forged_arithmetic_even_with_valid_archive_and_receipt_hashes(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _calculate(wb, before, after)
    forged = copy.deepcopy(_document(wb))
    forged["data"]["receipt"]["conditions"][0]["mean_difference"] = 999
    _reidentify(forged)
    wb.project.put_document("comparison", forged["id"], forged["data"], expected_revision=0)
    archive = tmp_path / "forged-portable.zip"
    export_project(wb.project, archive)
    target = tmp_path / "forged-import.loci-study"
    with pytest.raises(ValueError, match="arithmetic"):
        import_project(archive, target)
    assert not target.exists()
    wb.close()


def test_export_review_staleness_signed_csv_atomic_manifest_and_cli_rpc(tmp_path):
    wb = _scene(tmp_path)
    parent = _parent(wb, tmp_path, 0, _labels(3, second=2))
    child = _correct(wb, parent, {"op": "delete", "label": 7})
    pending = _calculate(wb, [parent], [child])
    target = tmp_path / "report"
    with pytest.raises(ValueError, match="Review"):
        export_effect(wb.project, pending["receipt_sha256"], target)
    assert not target.exists()
    _review(wb, [parent, child])
    with pytest.raises(ValueError, match="stale"):
        export_effect(wb.project, pending["receipt_sha256"], target)
    result = _calculate(wb, [parent], [child])
    exported = dispatch_research(
        "research_export_correction_effect",
        {
            "project": str(wb.project.root),
            "receipt_sha256": result["receipt_sha256"],
            "destination": str(target),
        },
    )
    receipt = json.loads((target / "receipt.json").read_text())
    assert receipt == {k: v for k, v in result.items() if k != "comparison_document"}
    manifest_bytes = (target / "manifest.json").read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == exported["manifest_sha256"]
    manifest = json.loads(manifest_bytes)
    assert set(exported["files"]) == {
        "receipt.json",
        "image-pairs.csv",
        "biological-replicates.csv",
        "conditions.csv",
        "methods.txt",
        "manifest.json",
    }
    for entry in manifest["files"]:
        content = (target / entry["name"]).read_bytes()
        assert len(content) == entry["size_bytes"]
        assert hashlib.sha256(content).hexdigest() == entry["sha256"]
    with (target / "image-pairs.csv").open() as stream:
        row = list(csv.DictReader(stream))[0]
    assert float(row["mean_difference"]) == -1
    assert int(row["count_difference"]) == -1
    assert "Signed differences are after minus before" in (target / "methods.txt").read_text()
    assert "object area or volume from recorded geometry" in (target / "methods.txt").read_text()
    assert str(tmp_path) not in (target / "receipt.json").read_text()
    original = {p.name: p.read_bytes() for p in target.iterdir()}
    with pytest.raises(ValueError, match="absent"):
        export_effect(wb.project, result["receipt_sha256"], target)
    assert {p.name: p.read_bytes() for p in target.iterdir()} == original
    args = parser().parse_args(
        [
            "export-correction-effect",
            "--project",
            str(wb.project.root),
            "--receipt-sha256",
            result["receipt_sha256"],
            "--destination",
            str(tmp_path / "cli-report"),
        ]
    )
    assert execute(args)["receipt_sha256"] == result["receipt_sha256"]
    wb.close()


def test_metadata_recalculation_preserves_arrays_and_export_rechecks_publication(
    tmp_path, monkeypatch
):
    import loci_engine.research_correction_effect as effects

    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    _review(wb, before + after)
    original = _calculate(wb, before, after)
    arrays = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in wb.project.arrays.iterdir()
    }
    sample = next(s for s in wb.project.documents("sample") if s["id"] == before[1]["source_id"])
    wb.execute(
        "sample",
        {
            "id": sample["id"],
            "data": {**sample["data"], "biological_replicate": "R2"},
            "expected_revision": sample["revision"],
        },
    )
    new = _calculate(wb, before, after)
    assert new["receipt_sha256"] != original["receipt_sha256"]
    assert {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in wb.project.arrays.iterdir()
    } == arrays
    with pytest.raises(ValueError, match="stale"):
        export_effect(wb.project, original["receipt_sha256"], tmp_path / "stale")
    real_hash = effects._sha256_file_stable
    mutated = False

    def race(path, **kwargs):
        nonlocal mutated
        if Path(path).name == "conditions.csv" and not mutated:
            mutated = True
            _review(wb, [after[0]], "pending")
        return real_hash(path, **kwargs)

    monkeypatch.setattr(effects, "_sha256_file_stable", race)
    with pytest.raises(ValueError, match="stale"):
        export_effect(wb.project, new["receipt_sha256"], tmp_path / "race")
    assert not (tmp_path / "race").exists()
    assert not list(tmp_path.glob(".loci-correction-effect-*"))
    wb.close()


def test_reject_unrelated_duplicate_missing_metadata_and_incompatible_units(tmp_path):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    with pytest.raises(ValueError, match="real direct"):
        _calculate(wb, before, before)
    with pytest.raises(ValueError, match="unique"):
        _calculate(wb, [before[0], before[0]], [after[0], after[0]])
    with pytest.raises(ValueError, match="same exact source"):
        _calculate(wb, before[:1], after[1:2])
    rerun = wb.project.save_result(
        source_id=before[0]["source_id"],
        kind="segmented",
        arrays={k: wb.project.load_array(v) for k, v in before[0]["arrays"].items()},
        provenance=before[0]["provenance"],
    )
    with pytest.raises(ValueError, match="direct corrected"):
        _calculate(wb, [before[0]], [rerun])
    with pytest.raises(ValueError, match="one result per source"):
        _calculate(wb, [before[0], rerun], [after[0], rerun])
    physical = _parent(wb, tmp_path, 20, _labels(2), physical=True)
    with pytest.raises(ValueError, match="dimensions and units"):
        _calculate(wb, [before[0], physical], [after[0], physical])
    with wb.project.connection() as connection:
        connection.execute(
            "DELETE FROM documents WHERE kind='sample' AND id=?", (before[0]["source_id"],)
        )
    with pytest.raises(ValueError, match="Assign study/sample"):
        _calculate(wb, [before[0]], [after[0]])
    wb.close()


@pytest.mark.parametrize(
    "attack", ["parent", "parent_hash", "audit", "count", "measure", "dtype", "budget"]
)
def test_result_and_array_contract_rejections(tmp_path, monkeypatch, attack):
    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    altered = copy.deepcopy(after[0])
    if attack == "parent":
        altered["parent_id"] = None
    elif attack == "parent_hash":
        altered["provenance"]["correction"]["parent_revision_hash"] = "a" * 64
    elif attack == "audit":
        altered["provenance"]["correction"]["operations"][0]["label"] = 100
    elif attack == "count":
        altered["provenance"]["measurements"][0]["voxel_count"] += 1
    elif attack == "measure":
        altered["provenance"]["measurements"][0]["measure"] = float("inf")
    elif attack == "dtype":
        labels = wb.project.load_array(altered["arrays"]["labels"]).astype(np.uint16)
        altered["arrays"]["labels"] = wb.project.store_array(labels)
    else:
        altered["arrays"]["labels"]["shape"] = [100000, 100000]
        altered["arrays"]["image"]["shape"] = [100000, 100000]
    # Pure reconstruction also validates imported (already hashed) result records.
    from loci_engine.research_correction_effect import _binding, build_receipt
    from loci_engine.workbench import runtime_record

    samples = {s["id"]: s for s in wb.project.documents("sample")}
    left = [_binding(before[0], samples[before[0]["source_id"]], None)]
    right = [_binding(altered, samples[altered["source_id"]], None)]
    real_loader = wb.project.load_array
    loader = real_loader
    if attack == "budget":

        def bounded_loader(descriptor):
            assert descriptor["shape"] != [100000, 100000], "oversized array allocated"
            return real_loader(descriptor)

        loader = bounded_loader
    with pytest.raises(ValueError):
        build_receipt(
            _request([before[0]], [altered]),
            {before[0]["id"]: before[0], altered["id"]: altered},
            left,
            right,
            loader,
            runtime_record(),
        )
    wb.close()


@pytest.mark.parametrize("limit", ["MAX_JSON_BYTES", "MAX_OBJECTS"])
def test_cohort_budget_rejects_before_array_allocation(tmp_path, monkeypatch, limit):
    import loci_engine.research_correction_effect as effects

    wb = _scene(tmp_path)
    before, after = _cohort(wb, tmp_path)
    monkeypatch.setattr(effects, limit, 1)

    def no_load(descriptor):
        pytest.fail("Cohort bounds must reject before allocating any array")

    monkeypatch.setattr(wb.project, "load_array", no_load)
    with pytest.raises(ValueError, match="bounded record/object budget"):
        _calculate(wb, before, after)
    wb.close()
