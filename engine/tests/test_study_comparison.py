import copy
import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.research_interchange import (
    _validate_comparison_document,
    export_project,
    import_project,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


def _prepare_runs(tmp_path):
    workbench = Workbench(
        ResearchProject.create(tmp_path / "comparison.loci-study", "Comparison study")
    )
    recipe = {"segmentation": {"method": "components", "threshold": 50}}
    left, right = [], []
    sources = []
    for index, (replicate, width) in enumerate((("animal-1", 2), ("animal-2", 4))):
        values = np.zeros((8, 8), dtype=np.uint8)
        values[2:4, 2 : 2 + width] = 100
        path = tmp_path / f"replicate-{index + 1}.tif"
        tifffile.imwrite(path, values)
        source = workbench.import_native(str(path))
        sources.append(source)
        workbench.execute(
            "sample",
            {
                "id": source["id"],
                "data": {
                    "study": "Comparison study",
                    "sample": f"section-{index + 1}",
                    "condition": "control",
                    "biological_replicate": replicate,
                    "plate": "plate-1",
                    "well": f"A{index + 1}",
                },
            },
        )
        left.append(
            workbench.execute("run_recipe", {"source_id": source["id"], "recipe": recipe})["result"]
        )
        right.append(
            workbench.execute("run_recipe", {"source_id": source["id"], "recipe": recipe})["result"]
        )
    return workbench, sources, left, right, recipe


def _request(left, right):
    return {
        "left_result_ids": [result["id"] for result in left],
        "right_result_ids": [result["id"] for result in right],
        "value": "measure",
    }


def test_study_comparison_is_review_bound_exclusion_aware_and_reopenable(tmp_path):
    workbench, sources, left, right, _ = _prepare_runs(tmp_path)
    request = _request(left, right)
    with pytest.raises(ValueError, match="reviewed or explicitly excluded"):
        workbench.execute("study_compare", request)

    for result in left:
        workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    workbench.project.review(right[0]["id"], right[0]["revision_hash"], "excluded")
    workbench.project.review(right[1]["id"], right[1]["revision_hash"], "reviewed")

    receipt = workbench.execute("study_compare", request)
    assert receipt["schema"] == "loci.study-run-comparison/v1"
    assert receipt["p_values"] is None
    assert receipt["independent_n_basis"].startswith("biological replicate means")
    assert receipt["left"]["summaries"] == [
        {
            "condition": "control",
            "mean": 6.0,
            "sd": pytest.approx(2.8284271247461903),
            "n_biological_replicates": 2,
            "n_objects": 2,
            "n_images": 2,
            "unassigned_images": 0,
            "unassigned_objects": 0,
        }
    ]
    assert receipt["right"]["summaries"][0]["mean"] == 8.0
    assert receipt["right"]["summaries"][0]["n_biological_replicates"] == 1
    assert receipt["comparisons"] == [
        {
            "condition": "control",
            "left_mean": 6.0,
            "right_mean": 8.0,
            "difference": 2.0,
            "left_n_biological_replicates": 2,
            "right_n_biological_replicates": 1,
        }
    ]
    assert receipt["right"]["record_audit"][0]["excluded"] is True
    assert [binding["result_id"] for binding in receipt["left"]["bindings"]] == [
        result["id"] for result in left
    ]
    assert [binding["revision_hash"] for binding in receipt["right"]["bindings"]] == [
        result["revision_hash"] for result in right
    ]
    assert [binding["source_sha256"] for binding in receipt["left"]["bindings"]] == [
        source["sha256"] for source in sources
    ]
    assert receipt["left"]["bindings"][0]["sample_document"] == {
        "revision": 1,
        "data": {
            "study": "Comparison study",
            "sample": "section-1",
            "condition": "control",
            "biological_replicate": "animal-1",
            "plate": "plate-1",
            "well": "A1",
        },
    }
    left_provenance = workbench.project.result(left[0]["id"])["provenance"]
    assert receipt["left"]["bindings"][0]["scope"] == {
        "selection": left_provenance["selection"],
        "geometry": left_provenance["geometry"],
    }
    assert len(receipt["receipt_sha256"]) == 64
    comparison_document = workbench.project.documents("comparison")
    assert len(comparison_document) == 1
    assert receipt["comparison_document"] == {
        "id": comparison_document[0]["id"],
        "revision": 1,
    }
    assert comparison_document[0]["data"]["receipt"] == {
        key: value for key, value in receipt.items() if key != "comparison_document"
    }
    assert workbench.snapshot()["comparisons"] == comparison_document

    reopened = Workbench(ResearchProject(workbench.project.root))
    assert reopened.execute("study_compare", request) == receipt
    assert reopened.project.documents("comparison") == comparison_document

    archive = tmp_path / "comparison-portable.zip"
    export_project(workbench.project, archive)
    imported = Workbench(import_project(archive, tmp_path / "comparison-imported.loci-study"))
    assert imported.project.documents("comparison") == comparison_document
    assert imported.snapshot()["comparisons"] == comparison_document
    assert imported.execute("study_compare", request) == receipt


def test_study_comparison_rejects_overlap_source_mismatch_and_method_mismatch(tmp_path):
    workbench, _, left, right, _ = _prepare_runs(tmp_path)
    for result in [*left, *right]:
        workbench.project.review(result["id"], result["revision_hash"], "reviewed")

    with pytest.raises(ValueError, match="only the calibrated measure metric"):
        workbench.execute(
            "study_summary",
            {"result_ids": [left[0]["id"]], "value": "voxel_count"},
        )
    with pytest.raises(ValueError, match="only the calibrated measure metric"):
        workbench.execute(
            "study_compare",
            {
                "left_result_ids": [left[0]["id"]],
                "right_result_ids": [right[0]["id"]],
                "value": "0.mean",
            },
        )

    with pytest.raises(ValueError, match="distinct result revisions"):
        workbench.execute(
            "study_compare",
            {
                "left_result_ids": [left[0]["id"]],
                "right_result_ids": [left[0]["id"]],
            },
        )

    with pytest.raises(ValueError, match="same exact source set"):
        workbench.execute(
            "study_compare",
            {
                "left_result_ids": [left[0]["id"]],
                "right_result_ids": [right[1]["id"]],
            },
        )

    alternate = workbench.execute(
        "run_recipe",
        {
            "source_id": left[0]["source_id"],
            "recipe": {"segmentation": {"method": "components", "threshold": 60}},
        },
    )["result"]
    workbench.project.review(alternate["id"], alternate["revision_hash"], "reviewed")
    with pytest.raises(ValueError, match="methods"):
        workbench.execute(
            "study_compare",
            {
                "left_result_ids": [left[0]["id"]],
                "right_result_ids": [alternate["id"]],
            },
        )

    cropped = workbench.execute(
        "run_recipe",
        {
            "source_id": left[0]["source_id"],
            "selection": {"x": 0, "y": 0, "width": 4, "height": 8},
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        },
    )["result"]
    workbench.project.review(cropped["id"], cropped["revision_hash"], "reviewed")
    with pytest.raises(ValueError, match="per-source selection and geometry"):
        workbench.execute(
            "study_compare",
            {
                "left_result_ids": [left[0]["id"]],
                "right_result_ids": [cropped["id"]],
            },
        )


@pytest.mark.parametrize("attack", ["numeric", "binding-field", "sample-mismatch"])
def test_portable_comparison_validation_recomputes_exact_receipt(tmp_path, attack):
    workbench, _, left, right, _ = _prepare_runs(tmp_path)
    for result in [*left, *right]:
        workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    workbench.execute("study_compare", _request(left, right))
    forged = copy.deepcopy(workbench.project.documents("comparison")[0])
    if attack == "numeric":
        forged["data"]["receipt"]["comparisons"][0]["difference"] = 999.0
    elif attack == "binding-field":
        forged["data"]["receipt"]["left"]["bindings"][0]["private_path"] = "/tmp/input"
    else:
        forged["data"]["receipt"]["right"]["bindings"][0]["sample_document"]["data"][
            "biological_replicate"
        ] = "animal-x"
        forged["data"]["receipt"]["right"]["replicates"][0][
            "biological_replicate"
        ] = "animal-x"
    unhashed = {
        key: value
        for key, value in forged["data"]["receipt"].items()
        if key != "receipt_sha256"
    }
    digest = hashlib.sha256(canonical_json(unhashed).encode()).hexdigest()
    forged["data"]["receipt"]["receipt_sha256"] = digest
    forged["id"] = digest[:32]
    results = {
        result["id"]: workbench.project.result(result["id"])
        for result in [*left, *right]
    }
    with pytest.raises(ValueError, match="reproducible|stale or invalid|sample metadata"):
        _validate_comparison_document(forged, results)
