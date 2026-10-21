"""Export settings from executed supported methods, with private text excluded."""

import json

import numpy as np
import pytest
import tifffile

from loci_engine.research_data_export import _safe, export_data_package, plan_export
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.mark.parametrize("method", ["tissue", "stain", "rgb", "puncta"])
def test_executed_method_settings_survive_scientific_export(tmp_path, method):
    rgb = np.full((32, 48, 3), 255, np.uint8)
    rgb[4:12, 5:15] = 64
    rgb[20:24, 30:34] = 64
    image = tmp_path / "authored.tif"
    raw = np.zeros((32, 48), np.uint8)
    raw[10, 10] = 200
    tifffile.imwrite(
        image,
        raw if method == "puncta" else rgb,
        photometric="minisblack" if method == "puncta" else "rgb",
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Synthetic methods"))
    try:
        source = wb.import_native(str(image))
        operation, request, field = {
            "tissue": (
                "tissue_run",
                {
                    "settings": {
                        "closing_radius_pixels": 2,
                        "minimum_component_pixels": 20,
                        "control": "/private/free-form-control",
                    }
                },
                "tissue_mask",
            ),
            "stain": (
                "histology_run",
                {
                    "basis": "H&E",
                    "component": 0,
                    "segmentation": {"method": "components", "threshold": 0.01},
                },
                "stain_separation",
            ),
            "rgb": (
                "run_recipe",
                {
                    "recipe": {
                        "input_transform": "rgb_intensity",
                        "measurement_channels": [],
                        "segmentation": {"method": "components", "threshold": 0.2},
                    }
                },
                "input_transform",
            ),
            "puncta": (
                "puncta_run",
                {
                    "sigma": 1.0,
                    "response_threshold": 0.0,
                    "raw_threshold": 50.0,
                    "minimum_distance": 2.1,
                    "aperture_radius": 1.0,
                    "exclude_border": True,
                    "control": "/private/free-form-control",
                },
                "puncta",
            ),
        }[method]
        result = wb.project.result(
            wb.execute(operation, {"source_id": source["id"], **request})["result"]["id"]
        )
        binding = {key: result[key] for key in ("source_id", "source_sha256", "revision_hash")}
        binding.update(result_id=result["id"], subset="all", group_ids=[])
        plan = plan_export(wb.project, {"purpose": "provisional", "bindings": [binding]})
        destination = tmp_path / "package"
        export_data_package(wb.project, plan["plan_json"], destination)
        text = (destination / "provenance.json").read_text()
        exported = json.loads(text)["results"][0]["scientific_provenance"]
        stored = result["provenance"][field]
        expected = {
            k: v
            for k, v in stored.items()
            if k
            not in {
                "control",
                "response_formula",
                "candidate_rule",
                "suppression_rule",
                "region_rule",
                "limits",
                "interpretation",
            }
        }
        assert exported[field] == expected
        assert "/private/free-form-control" not in text
        assert str(tmp_path) not in text
        if method == "tissue":
            assert exported[field]["closing_radius_pixels"] == 2
            assert exported[field]["minimum_component_pixels"] == 20
        if method == "rgb":
            assert exported["recipe"]["input_transform"] == "rgb_intensity"
    finally:
        wb.close()


@pytest.mark.parametrize(
    "record",
    [
        {"tissue_mask": {"closing_radius_pixels": True}},
        {"tissue_mask": {"closing_radius_pixels": 65}},
        {"tissue_mask": {"minimum_component_pixels": -1}},
        {"stain_separation": {"matrix": [[float("nan")]]}},
        {"input_transform": {"coefficients_rgb": [1, 2, 3, 4]}},
        {"puncta": {"sigma": "/private/metadata"}},
    ],
)
def test_method_setting_projection_rejects_invalid_known_types(record):
    with pytest.raises(ValueError, match="scientific method setting"):
        _safe(record)


def test_method_projection_never_copies_unknown_trees_or_free_text():
    assert _safe(
        {
            "tissue_mask": {
                "control": "patient note",
                "private_path": "/private/data",
                "extension": {"threshold": 3},
            }
        }
    ) == {"tissue_mask": {}}
