import csv
import hashlib
import io
import json

import numpy as np
import pytest
import test_research_jobs as jobs
import tifffile

from loci_engine.research_export import export_research_result
from loci_engine.research_rpc import dispatch_research
from loci_engine.study_analysis import measurements_csv


@pytest.fixture
def task(tmp_path):
    return jobs.task.__wrapped__(tmp_path)


def reviewed(task):
    workbench, request = task
    result = workbench.run_recipe(request)["result"]
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    return workbench, result


def test_export_preserves_values_hashes_provenance_and_never_overwrites(task, tmp_path):
    workbench, result = reviewed(task)
    target = tmp_path / "export"
    receipt = export_research_result(
        workbench.project, result["id"], result["revision_hash"], target
    )
    manifest = json.loads((target / "manifest.json").read_text())
    assert (
        hashlib.sha256((target / "manifest.json").read_bytes()).hexdigest()
        == receipt["manifest_sha256"]
    )
    for entry in manifest["files"]:
        assert hashlib.sha256((target / entry["name"]).read_bytes()).hexdigest() == entry["sha256"]
    internal = workbench.project.result(result["id"])
    for name in ("image", "labels"):
        assert np.array_equal(
            tifffile.imread(target / f"{name}.ome.tif"),
            workbench.project.load_array(internal["arrays"][name]),
        )
    record = (target / "result.json").read_text()
    assert str(tmp_path) not in record
    assert json.loads(record)["result"]["revision_hash"] == result["revision_hash"]
    assert json.loads((target / "loci-export.json").read_text())["bundle_kind"] == "loci-export"
    with pytest.raises(ValueError, match="absent"):
        export_research_result(workbench.project, result["id"], result["revision_hash"], target)


def test_batch_export_plan_requires_exact_review_and_returns_only_portable_metadata(task):
    workbench, result = reviewed(task)
    stored_result = workbench.project.result(result["id"])
    source = workbench.project.source(result["source_id"])
    plan = dispatch_research(
        "research_batch_export_plan",
        {
            "project": str(workbench.project.root),
            "bindings": [
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                }
            ],
        },
    )
    assert plan["items"] == [
        {
            "source_id": source["id"],
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "source_relative_path": source["name"],
            "export_basename": "source_loci",
            "object_count": len(stored_result["provenance"]["measurements"]),
        }
    ]
    assert str(workbench.project.root.parent) not in json.dumps(plan)
    workbench.project.review(result["id"], result["revision_hash"], "excluded")
    with pytest.raises(ValueError, match="explicitly reviewed"):
        dispatch_research(
            "research_batch_export_plan",
            {
                "project": str(workbench.project.root),
                "bindings": [
                    {
                        "source_id": source["id"],
                        "source_sha256": source["sha256"],
                        "result_id": result["id"],
                        "revision_hash": result["revision_hash"],
                    }
                ],
            },
        )


@pytest.mark.parametrize(
    ("source_relative_path", "expected_basename"),
    [
        ("=résumé sample 01.tif", "resume_sample_01_loci"),
        (f"{'x' * 100}.tif", f"{'x' * 75}_loci"),
        ("brain scan.nii.gz", "brain_scan_loci"),
    ],
)
def test_batch_export_plan_name_is_the_real_export_target(
    tmp_path, source_relative_path, expected_basename
):
    source_file = tmp_path / "source.tif"
    image = np.zeros((32, 32), np.uint16)
    image[2:6, 5:9] = 100
    tifffile.imwrite(source_file, image)
    workbench = jobs.Workbench(jobs.ResearchProject.create(tmp_path / "study", "Study"))
    source = workbench.import_native(
        str(source_file), relative_path=source_relative_path
    )
    result = workbench.run_recipe(
        {
            "source_id": source["id"],
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        }
    )["result"]
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    binding = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
    }

    plan = dispatch_research(
        "research_batch_export_plan",
        {"project": str(workbench.project.root), "bindings": [binding]},
    )
    assert plan["items"][0]["export_basename"] == expected_basename
    assert len(expected_basename) <= 80
    target = tmp_path / "published" / expected_basename
    target.parent.mkdir()
    receipt = export_research_result(
        workbench.project, result["id"], result["revision_hash"], target
    )
    assert receipt["export_name"] == expected_basename
    assert target.is_dir()


def test_batch_export_plan_rejects_names_with_the_same_sanitized_target(tmp_path):
    workbench = jobs.Workbench(jobs.ResearchProject.create(tmp_path / "study", "Study"))
    bindings = []
    for index, relative_path in enumerate(("set/café.tif", "set/cafe.tif")):
        source_file = tmp_path / f"source-{index}.tif"
        image = np.zeros((32, 32), np.uint16)
        image[2:6, 5:9] = 100 + index
        tifffile.imwrite(source_file, image)
        source = workbench.import_native(str(source_file), relative_path=relative_path)
        result = workbench.run_recipe(
            {
                "source_id": source["id"],
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 50}
                },
            }
        )["result"]
        workbench.project.review(result["id"], result["revision_hash"], "reviewed")
        bindings.append(
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
            }
        )

    with pytest.raises(ValueError, match="conflicting mirrored export targets"):
        dispatch_research(
            "research_batch_export_plan",
            {"project": str(workbench.project.root), "bindings": bindings},
        )


def test_export_rejects_stale_review_source_and_artifact(task, tmp_path):
    workbench, result = reviewed(task)
    target = tmp_path / "export"
    with pytest.raises(ValueError, match="stale"):
        export_research_result(workbench.project, result["id"], "0" * 64, target)
    workbench.project.review(result["id"], result["revision_hash"], "excluded")
    with pytest.raises(ValueError, match="Review"):
        export_research_result(workbench.project, result["id"], result["revision_hash"], target)
    assert not target.exists()
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    source = tmp_path / "source.tif"
    source.write_bytes(source.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="changed"):
        export_research_result(workbench.project, result["id"], result["revision_hash"], target)
    assert not target.exists()


def test_export_failure_during_roundtrip_never_publishes(task, tmp_path, monkeypatch):
    workbench, result = reviewed(task)
    target = tmp_path / "export"
    monkeypatch.setattr(tifffile, "imread", lambda _: np.zeros((1, 1)))
    with pytest.raises(ValueError, match="round-trip"):
        export_research_result(workbench.project, result["id"], result["revision_hash"], target)
    assert not target.exists()
    assert not list(tmp_path.glob(".loci-export-*"))


def test_formula_text_and_headers_are_escaped_numeric_values_remain_numeric():
    output = list(csv.reader(io.StringIO(measurements_csv([{"=bad": "@evil", "value": -3.5}]))))
    assert output == [["'=bad", "value"], ["'@evil", "-3.5"]]


def test_reviewed_roi_exports_geojson_imagej_and_raw_measurements(task, tmp_path):
    from loci_engine.research_annotations import roi_from_geojson, roi_from_imagej

    wb, parent = reviewed(task)
    output = wb.execute(
        "roi_add",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "roi": {
                "annotation_id": "measured-region",
                "plane": "XY",
                "index": 0,
                "points": [{"u": u, "v": v} for u, v in [(2, 2), (6, 2), (6, 6), (2, 6)]],
            },
            "measurement_channels": [0],
        },
    )
    result = output["result"]
    destination = tmp_path / "roi-export"
    with pytest.raises(ValueError, match="Review"):
        export_research_result(wb.project, result["id"], result["revision_hash"], destination)
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    export_research_result(wb.project, result["id"], result["revision_hash"], destination)
    collection = json.loads((destination / "annotations.geojson").read_text())
    roi = roi_from_geojson(collection["features"][0])
    restored = roi_from_imagej((destination / "annotation-measured-region.roi").read_bytes())
    assert restored == roi
    assert roi.result_sha256 == parent["revision_hash"]
    assert (destination / "roi-measurements.csv").read_text().count("measured-region") == 1
    assert '"annotations":[' in (destination / "methods.md").read_text()
    assert wb.project.review_state(parent["id"])["disposition"] == "reviewed"
