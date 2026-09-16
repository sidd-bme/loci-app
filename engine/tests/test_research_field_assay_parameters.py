"""Wrapper-level regression tests for field assay parameter resolution."""

from __future__ import annotations

import numpy as np
import pytest
import tifffile
from skimage import filters

import loci_engine.research_field_assay as field_assay_wrapper
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def _workbench_with_field(tmp_path) -> tuple[Workbench, dict]:
    data = np.zeros((2, 24, 24), dtype=np.uint16)
    data[0, 4:8, 4:8] = 200
    data[1, :, :] = 5
    path = tmp_path / "field.tif"
    tifffile.imwrite(path, data, metadata={"axes": "CYX"})
    workbench = Workbench(ResearchProject.create(tmp_path / "parameters.loci-study", "Parameters"))
    return workbench, workbench.import_native(str(path))


def _request(source: dict) -> dict:
    return {
        "source_id": source["id"],
        "nuclei_channel": 0,
        "signal_channel": 1,
        "focus_all": True,
        "background_value": 5.0,
        "segmentation_method": "manual",
        "threshold_manual": 100,
    }


def test_explicit_zero_sigma_is_executed_and_saved(tmp_path):
    workbench, source = _workbench_with_field(tmp_path)

    response = workbench.execute(
        "field_assay_run",
        {
            **_request(source),
            "gaussian_sigma_px": 0,
            "config": {"gaussian_sigma_px": 0},
        },
    )

    saved = workbench.project.result(response["result"]["id"])
    assert saved["provenance"]["config"]["gaussian_sigma_px"] == 0.0
    assert saved["provenance"]["config"]["nuclear_threshold"] == 100.0


def test_omitted_sigma_uses_validated_default(tmp_path):
    workbench, source = _workbench_with_field(tmp_path)

    preview = workbench.execute("field_assay_preview", _request(source))

    assert preview["config"]["gaussian_sigma_px"] == 1.0
    assert preview["computed_threshold"] == preview["config"]["nuclear_threshold"]


def test_omitted_manual_threshold_is_rejected(tmp_path):
    workbench, source = _workbench_with_field(tmp_path)
    request = _request(source)
    request.pop("threshold_manual")

    with pytest.raises(ValueError, match="fixed nuclear_threshold is required"):
        workbench.execute("field_assay_preview", request)


@pytest.mark.parametrize(
    ("method", "threshold_function"),
    [("otsu", filters.threshold_otsu), ("yen", filters.threshold_yen)],
)
def test_automatic_threshold_uses_unsmoothed_focus_pixels_and_one_resolved_config(
    tmp_path, monkeypatch, method, threshold_function
):
    workbench, source = _workbench_with_field(tmp_path)
    nuclei = np.zeros((24, 24), dtype=np.uint16)
    nuclei[4:8, 4:8] = 200
    expected_threshold = float(threshold_function(nuclei.astype(np.float64)))
    executed_configs: list[dict] = []
    real_compute = field_assay_wrapper.compute_field_quantification

    def record_config(*args, **kwargs):
        executed_configs.append(dict(kwargs["config"]))
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(field_assay_wrapper, "compute_field_quantification", record_config)
    request = {
        **_request(source),
        "segmentation_method": method,
        "gaussian_sigma_px": 0,
        "manual_count": 1,
        "config": {
            "segmentation_method": method,
            "gaussian_sigma_px": 0,
        },
    }
    request.pop("threshold_manual")

    preview = workbench.execute("field_assay_preview", request)
    run = workbench.execute("field_assay_run", request)
    saved_config = workbench.project.result(run["result"]["id"])["provenance"]["config"]

    assert preview["computed_threshold"] == expected_threshold
    assert preview["config"]["nuclear_threshold"] == expected_threshold
    assert preview["config"]["gaussian_sigma_px"] == 0.0
    assert preview["config"] == saved_config
    for executed_config in executed_configs:
        assert executed_config["segmentation_method"] == method
        assert executed_config["nuclear_threshold"] == expected_threshold
        assert executed_config["gaussian_sigma_px"] == 0.0
    assert saved_config["nuclear_threshold"] == expected_threshold
    assert saved_config["gaussian_sigma_px"] == 0.0


@pytest.mark.parametrize(
    "extra",
    [
        {"gaussian_sigma_px": 0, "config": {"gaussian_sigma_px": 1}},
        {"threshold_manual": 100, "config": {"nuclear_threshold": 101}},
        {
            "segmentation_method": "manual",
            "config": {"segmentation_method": "otsu"},
        },
    ],
)
def test_conflicting_top_level_and_nested_parameters_are_rejected(tmp_path, extra):
    workbench, source = _workbench_with_field(tmp_path)

    with pytest.raises(ValueError, match="Conflicting field assay parameter"):
        workbench.execute("field_assay_preview", {**_request(source), **extra})


@pytest.mark.parametrize(
    ("method", "function_name"),
    [("otsu", "threshold_otsu"), ("yen", "threshold_yen")],
)
def test_automatic_threshold_failure_stops_without_fallback(
    tmp_path, monkeypatch, method, function_name
):
    workbench, source = _workbench_with_field(tmp_path)

    def fail_threshold(_pixels):
        raise RuntimeError("synthetic threshold failure")

    monkeypatch.setattr(filters, function_name, fail_threshold)
    request = _request(source)
    request.pop("threshold_manual")
    request["segmentation_method"] = method

    with pytest.raises(
        ValueError,
        match=rf"{method.title()} threshold calculation failed.*synthetic threshold failure",
    ):
        workbench.execute("field_assay_run", request)
    assert workbench.project.list_results() == []


@pytest.mark.parametrize(
    "fixed_threshold",
    [
        {"threshold_manual": 100},
        {"nuclear_threshold": 100},
        {"config": {"nuclear_threshold": 100}},
    ],
)
def test_fixed_threshold_is_rejected_for_automatic_segmentation(tmp_path, fixed_threshold):
    workbench, source = _workbench_with_field(tmp_path)
    request = _request(source)
    request.pop("threshold_manual")
    request.update(fixed_threshold)
    request["segmentation_method"] = "otsu"

    with pytest.raises(ValueError, match="Fixed nuclear_threshold must be omitted"):
        workbench.execute("field_assay_preview", request)
