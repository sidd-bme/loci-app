import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.research_export import export_research_result
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def tissue(tmp_path):
    rgb = np.full((32, 48, 3), 255, np.uint8)
    rgb[4:12, 5:15] = 64
    rgb[20:24, 30:34] = 64
    path = tmp_path / "declared-brightfield.ome.tif"
    tifffile.imwrite(
        path,
        rgb,
        photometric="rgb",
        ome=True,
        metadata={
            "axes": "YXS",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "tissue.loci-study", "Tissue"))
    source = wb.import_native(str(path))
    request = {
        "source_id": source["id"],
        "selection": {"level": 0},
        "settings": {"control": "Two known rectangular technical patches"},
    }
    return wb, request, rgb, path


def test_mask_preview_run_correction_roi_export_and_reopen(tissue, tmp_path):
    wb, request, rgb, path = tissue
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    preview = wb.execute("tissue_preview", request)
    assert preview["adopted"] is False
    assert preview["region_count"] == 2
    assert wb.project.list_results() == []
    assert preview["provenance"]["tissue_mask"]["initial_mask_pixel_count"] == 96
    assert [row["measure"] for row in preview["measurements"]] == [80, 16]
    assert [
        row["intensity"]["TISSUE-DERIVED:image"]["mean"] for row in preview["measurements"]
    ] == pytest.approx([64 / 255, 64 / 255])
    job = submit_job(wb, request, "tissue-example", operation="tissue_run")
    output = run_job(wb, job["id"])
    result = output["result"]
    saved = wb.project.result(result["id"])
    assert saved["provenance"]["geometry"]["unit"] == "um"
    labels = wb.project.load_array(saved["arrays"]["labels"])
    assert labels.dtype == np.uint32
    np.testing.assert_array_equal(labels > 0, np.any(rgb < 200, axis=-1))
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    info = wb.execute("correction_info", binding)
    assert info["measurement_channels"][0]["name"] == "TISSUE-DERIVED:image"
    corrected = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {"op": "delete", "label": 2, "expected_input_sha256": info["label_sha256"]}
            ],
        },
    )["result"]
    correction = wb.project.result(corrected["id"])
    assert len(correction["provenance"]["measurements"]) == 1
    assert correction["provenance"]["tissue_mask_status"].startswith("initial-mask-statistics")
    assert correction["provenance"]["tissue_mask"]["initial_mask_pixel_count"] == 96
    roi_result = wb.execute(
        "roi_add",
        {
            "result_id": corrected["id"],
            "revision_hash": corrected["revision_hash"],
            "measurement_channels": [0],
            "roi": {
                "annotation_id": "tissue-region",
                "plane": "XY",
                "index": 0,
                "points": [
                    {"u": 5, "v": 4},
                    {"u": 14, "v": 4},
                    {"u": 14, "v": 11},
                    {"u": 5, "v": 11},
                ],
            },
        },
    )["result"]
    record = wb.project.result(roi_result["id"])
    annotation = record["provenance"]["annotations"][0]
    assert annotation["basis"] == "TISSUE-DERIVED scalar values"
    measurement = annotation["measurements"]["TISSUE-DERIVED:image"]
    assert "raw_intensity" not in measurement
    assert measurement["derived_intensity"]["mean"] == pytest.approx(64 / 255)
    wb.project.review(roi_result["id"], roi_result["revision_hash"], "reviewed")
    destination = tmp_path / "reviewed-export"
    export_research_result(wb.project, roi_result["id"], roi_result["revision_hash"], destination)
    assert "otsu-dark-luminance" in (destination / "methods.md").read_text()
    restored = Workbench(ResearchProject(wb.project.root))
    assert restored.project.result(roi_result["id"])["revision_hash"] == roi_result["revision_hash"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original


def test_tissue_filter_control_and_memory_before_decode(tissue, monkeypatch):
    wb, request, _, _ = tissue
    request["settings"]["minimum_component_pixels"] = 20
    preview = wb.execute("tissue_preview", request)
    assert preview["region_count"] == 1
    assert preview["provenance"]["tissue_mask"]["initial_mask_pixel_count"] == 80
    with pytest.raises(ValueError, match="control"):
        wb.execute("tissue_preview", {**request, "settings": {}})
    with pytest.raises(ValueError, match="one explicitly selected"):
        wb.execute("tissue_preview", {**request, "selection": {"z": 0, "z_stop": 1}})
    monkeypatch.setattr(wb, "selection", lambda *args: {"width": 1024, "height": 1024})
    monkeypatch.setattr(
        wb, "load_scalar", lambda *args, **kwargs: pytest.fail("Decoded over budget")
    )
    with pytest.raises(ValueError, match="before decode"):
        wb.execute("tissue_preview", {**request, "working_bytes": 1024**2})


def test_declared_stain_rule_recomputed_from_source_after_correction(tissue, monkeypatch):
    from skimage.color import hed_from_rgb, separate_stains

    wb, tissue_request, rgb, _ = tissue
    value = float(separate_stains(rgb, hed_from_rgb)[4, 5, 0])
    assert value > 0
    rule = {
        "name": "declared-high-coordinate",
        "channel": "hematoxylin-basis",
        "statistic": "mean",
        "threshold": 0.99 * value,
        "control": "Technical rectangular patches; no biological class claim",
    }
    request = {
        "source_id": tissue_request["source_id"],
        "basis": "H&E",
        "component": 0,
        "segmentation": {"method": "components", "threshold": value / 2},
        "gates": [rule],
    }
    output = wb.execute("histology_run", request)
    assert len(output["measurements"]) == 2
    assert all(row["marker_gates"][rule["name"]] for row in output["measurements"])
    result = output["result"]
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    info = wb.execute("correction_info", binding)
    corrected = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "brush",
                    "mode": "paint",
                    "plane": "XY",
                    "index": 0,
                    "label": 1,
                    "points": [{"u": 15, "v": 4}],
                    "radius": 0.1,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        },
    )["result"]
    child = wb.project.result(corrected["id"])
    first = child["provenance"]["measurements"][0]
    assert first["voxel_count"] == 81
    assert first["intensity"]["hematoxylin-basis"]["mean"] == pytest.approx(80 * value / 81)
    assert first["marker_gates"][rule["name"]] is False
    assert child["provenance"]["recipe"]["gates"] == [rule]
    with pytest.raises(ValueError, match="declared stain basis"):
        wb.execute("histology_preview", {**request, "gates": [{**rule, "channel": "DAB-basis"}]})
    monkeypatch.setattr(wb, "selection", lambda *args: {"width": 1024, "height": 1024})
    monkeypatch.setattr(
        wb, "load_scalar", lambda *args, **kwargs: pytest.fail("Decoded over budget")
    )
    with pytest.raises(ValueError, match="before decode"):
        wb.execute("histology_preview", {**request, "working_bytes": 1024**2})
