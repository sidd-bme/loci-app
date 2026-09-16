import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.research_export import export_research_result
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def setup(tmp_path, *, dtype=np.uint8, samples=3):
    maximum = np.iinfo(dtype).max
    image = np.zeros((24, 32, samples), dtype)
    image[3:7, 4:9, 0] = maximum
    image[14:18, 20:25, 1] = maximum
    if samples == 4:
        image[..., 3] = maximum
    path = tmp_path / "colour.ome.tif"
    tifffile.imwrite(
        path,
        image,
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
    wb = Workbench(ResearchProject.create(tmp_path / "rgb.loci-study", "RGB"))
    source = wb.import_native(str(path))
    request = {
        "source_id": source["id"],
        "recipe": {
            "input_transform": "rgb_intensity",
            "measurement_channels": [],
            "segmentation": {"method": "components", "threshold": 0.2},
        },
    }
    return wb, path, image, request


@pytest.mark.parametrize("dtype", [np.uint8, np.uint16])
def test_explicit_rgb_conversion_matches_independent_primary_patches_and_preserves_source(
    tmp_path, dtype
):
    wb, path, image, request = setup(tmp_path, dtype=dtype)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    preview = wb.execute("preview_recipe", request)
    assert preview["object_count"] == 2
    assert wb.project.list_results() == []
    result = wb.execute("run_recipe", request)["result"]
    saved = wb.project.result(result["id"])
    expected = np.zeros(image.shape[:2], dtype=np.float64)
    expected[3:7, 4:9] = 0.2125
    expected[14:18, 20:25] = 0.7154
    np.testing.assert_allclose(
        wb.project.load_array(saved["arrays"]["rgb_intensity"]), expected, rtol=0, atol=1e-15
    )
    np.testing.assert_array_equal(
        wb.project.load_array(saved["arrays"]["labels"]) > 0, expected > 0.2
    )
    assert [row["measure"] for row in saved["provenance"]["measurements"]] == [20, 20]
    assert [
        row["intensity"]["RGB-DERIVED:rgb_intensity"]["mean"]
        for row in saved["provenance"]["measurements"]
    ] == pytest.approx([0.2125, 0.7154])
    assert (
        saved["provenance"]["input_transform"]["input"]
        == "source-device RGB samples; display ICC excluded"
    )
    assert saved["provenance"]["recipe"]["input_transform"] == "rgb_intensity"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest


def test_rgb_result_correction_roi_review_export_and_reopen_retains_derived_meaning(tmp_path):
    wb, _, _, request = setup(tmp_path)
    result = wb.execute("run_recipe", request)["result"]
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    info = wb.execute("correction_info", binding)
    assert info["measurement_channels"][0]["name"] == "RGB-DERIVED:rgb_intensity"
    child = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {"op": "delete", "label": 2, "expected_input_sha256": info["label_sha256"]},
            ],
        },
    )["result"]
    corrected = wb.project.result(child["id"])
    assert len(corrected["provenance"]["measurements"]) == 1
    assert corrected["provenance"]["measurements"][0]["intensity"]["RGB-DERIVED:rgb_intensity"][
        "mean"
    ] == pytest.approx(0.2125)
    roi = wb.execute(
        "roi_add",
        {
            "result_id": child["id"],
            "revision_hash": child["revision_hash"],
            "measurement_channels": [0],
            "roi": {
                "annotation_id": "red-patch",
                "plane": "XY",
                "index": 0,
                "points": [{"u": 4, "v": 3}, {"u": 8, "v": 3}, {"u": 8, "v": 6}, {"u": 4, "v": 6}],
            },
        },
    )["result"]
    record = wb.project.result(roi["id"])
    annotation = record["provenance"]["annotations"][0]
    assert annotation["basis"] == "RGB-DERIVED scalar values"
    assert "derived_intensity" in annotation["measurements"]["RGB-DERIVED:rgb_intensity"]
    wb.project.review(roi["id"], roi["revision_hash"], "reviewed")
    export_research_result(wb.project, roi["id"], roi["revision_hash"], tmp_path / "export")
    reopened = Workbench(ResearchProject(wb.project.root))
    assert reopened.project.result(roi["id"])["revision_hash"] == roi["revision_hash"]


@pytest.mark.parametrize(
    "change,reason",
    [
        ({"measurement_channels": [0]}, "derived"),
        ({"input_transform": "guess"}, "supported"),
        ({"input_transform": {}}, "supported"),
        (
            {
                "gates": [
                    {
                        "name": "positive",
                        "channel": "red",
                        "statistic": "mean",
                        "threshold": 0.2,
                        "control": "fixture",
                    }
                ]
            },
            "marker gates",
        ),
    ],
)
def test_rgb_recipe_rejects_ambiguous_or_biological_channel_claims(tmp_path, change, reason):
    wb, _, _, request = setup(tmp_path)
    request["recipe"].update(change)
    with pytest.raises(ValueError, match=reason):
        wb.execute("run_recipe", request)
    assert wb.project.list_results() == []


def test_rgb_conversion_requires_explicit_choice_and_opaque_alpha(tmp_path):
    wb, path, image, request = setup(tmp_path, samples=4)
    no_conversion = {
        "source_id": request["source_id"],
        "recipe": {"segmentation": {"method": "components", "threshold": 0.2}},
    }
    with pytest.raises(ValueError, match="RGB samples"):
        wb.execute("run_recipe", no_conversion)
    assert wb.execute("preview_recipe", request)["object_count"] == 2
    image[1, 1, 3] = 0
    other = tmp_path / "transparent.tif"
    tifffile.imwrite(other, image, photometric="rgb")
    source = wb.import_native(str(other))
    with pytest.raises(ValueError, match="opaque"):
        wb.execute("run_recipe", {**request, "source_id": source["id"]})
    assert wb.project.list_results() == []


def test_rgb_conversion_never_interprets_three_scalar_planes_as_colour(tmp_path):
    wb, _, _, request = setup(tmp_path)
    path = tmp_path / "scientific.ome.tif"
    tifffile.imwrite(path, np.ones((3, 24, 32), np.uint16), ome=True, metadata={"axes": "CYX"})
    scalar = wb.import_native(str(path))
    with pytest.raises(ValueError, match="interleaved"):
        wb.execute("run_recipe", {**request, "source_id": scalar["id"]})
