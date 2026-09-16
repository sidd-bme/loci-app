from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

import loci_engine.profiles as profile_module
from loci_engine.models import SegmentationSettings
from loci_engine.profiles import (
    CELLPOSE_PROFILE_ID,
    CELLPOSE_WEBSITE_PROFILE_ID,
    CLASSICAL_PROFILE,
    CLASSICAL_SETTINGS_CONTRACT,
    AvailabilitySummary,
    FailureMode,
    ModelArtifact,
    PreprocessingContract,
    RightsLineage,
    SegmentationProfile,
    ValidationSummary,
    profile_from_manifest,
)
from loci_engine.results import RESULT_CACHE
from loci_engine.worker import handle_request


def _synthetic_cells() -> np.ndarray:
    image = Image.new("L", (240, 180), color=18)
    draw = ImageDraw.Draw(image)
    for bounds in ((24, 24, 66, 66), (96, 30, 142, 76), (162, 96, 208, 142)):
        draw.ellipse(bounds, fill=235)
    return np.asarray(image)


def _unavailable_onnx_profile() -> SegmentationProfile:
    return SegmentationProfile(
        id="loci-native-preview",
        name="Loci Native Preview",
        version="0.1.0-alpha.1",
        status="unavailable",
        availability=AvailabilitySummary(
            code="not-installed",
            summary="The preview model is not installed.",
        ),
        backend_kind="onnx",
        model=ModelArtifact(
            format="onnx",
            artifact_id="loci-native-preview-v1",
            sha256="a" * 64,
        ),
        preprocessing=PreprocessingContract(
            channel_conversion="grayscale-luminance",
            intensity_normalization="per-image-percentile-1-99",
            resize_policy="downsample-only",
            max_edge_px=1000,
            output_grid="source-resolution",
        ),
        rights=RightsLineage(
            code_license="Apache-2.0",
            model_license="unknown",
            redistribution="unknown",
            commercial_use="unknown",
            training_data_lineage="Candidate profile with lineage review pending.",
        ),
        recommended_settings=SegmentationSettings(),
        settings_contract=CLASSICAL_SETTINGS_CONTRACT,
        validation=ValidationSummary(
            status="unvalidated",
            summary="Placeholder used to verify readiness gates.",
            failure_modes=(
                FailureMode(code="not-validated", summary="Accuracy has not been validated."),
            ),
        ),
    )


@pytest.fixture(autouse=True)
def _clear_result_cache() -> None:
    RESULT_CACHE.clear()
    yield
    RESULT_CACHE.clear()


def test_builtin_profile_is_immutable_path_free_json_and_round_trips() -> None:
    manifest = CLASSICAL_PROFILE.to_dict()

    assert json.loads(json.dumps(manifest)) == manifest
    assert profile_from_manifest(manifest) == CLASSICAL_PROFILE
    assert manifest["model"] == {
        "format": "builtin-algorithm",
        "artifact_id": None,
        "sha256": None,
    }
    assert manifest["preprocessing"] == {
        "channel_conversion": "grayscale-luminance",
        "intensity_normalization": "per-image-percentile-1-99",
        "resize_policy": "none",
        "max_edge_px": None,
        "output_grid": "source-resolution",
    }
    assert manifest["rights"]["training_data_lineage"]
    assert manifest["validation"]["failure_modes"]
    with pytest.raises(FrozenInstanceError):
        CLASSICAL_PROFILE.id = "changed"  # type: ignore[misc]


def test_manifest_rejects_paths_non_finite_values_and_executable_formats() -> None:
    with_path = CLASSICAL_PROFILE.to_dict()
    with_path["model"]["path"] = "/tmp/model.onnx"
    with pytest.raises(ValueError, match="path-free"):
        profile_from_manifest(with_path)

    relative_path = CLASSICAL_PROFILE.to_dict()
    relative_path["rights"]["training_data_lineage"] = "models/custom/model.onnx"
    with pytest.raises(ValueError, match="filesystem path"):
        profile_from_manifest(relative_path)

    non_finite = CLASSICAL_PROFILE.to_dict()
    non_finite["recommended_settings"]["sensitivity"] = float("nan")
    with pytest.raises(ValueError, match="non-finite"):
        profile_from_manifest(non_finite)

    invalid_type = CLASSICAL_PROFILE.to_dict()
    invalid_type["recommended_settings"]["min_area_px"] = True
    with pytest.raises(TypeError, match="must be an integer"):
        profile_from_manifest(invalid_type)

    invalid_resize = CLASSICAL_PROFILE.to_dict()
    invalid_resize["preprocessing"]["resize_policy"] = "downsample-only"
    with pytest.raises(ValueError, match="requires max_edge_px"):
        profile_from_manifest(invalid_resize)

    executable = CLASSICAL_PROFILE.to_dict()
    executable["model"]["format"] = "pickle"
    with pytest.raises(ValueError, match="Unsupported model format"):
        profile_from_manifest(executable)


def test_worker_lists_and_inspects_profiles() -> None:
    listed = handle_request({"id": "profiles", "method": "list_profiles", "params": {}})
    inspected = handle_request(
        {
            "id": "profile",
            "method": "inspect_profile",
            "params": {"profile_id": "loci-classical"},
        }
    )

    listed_profiles = listed["result"]["profiles"]
    assert listed_profiles[0] == CLASSICAL_PROFILE.to_dict()
    assert [profile["id"] for profile in listed_profiles] == [
        "loci-classical",
        CELLPOSE_WEBSITE_PROFILE_ID,
        CELLPOSE_PROFILE_ID,
    ]
    assert listed_profiles[1]["name"] == "Cellpose-SAM · Website compatible"
    assert listed_profiles[1]["model"]["artifact_id"] == "cpsam"
    assert "Recommended for parity" in listed_profiles[1]["validation"]["summary"]
    assert listed_profiles[1]["version"] == "4.2.1.1"
    assert listed_profiles[1]["backend_kind"] == "cellpose"
    assert listed_profiles[1]["availability"]["code"]
    assert listed_profiles[1]["settings_contract"]
    assert listed_profiles[2]["name"] == "Cellpose-SAM v2"
    assert listed_profiles[2]["model"]["artifact_id"] == "cpsam_v2"
    assert inspected["result"] == CLASSICAL_PROFILE.to_dict()


def test_segment_defaults_to_classical_and_explicit_selection_is_compatible(
    tmp_path: Path,
) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(path)
    base_params = {
        "path": str(path),
        "settings": {
            "image_mode": "fluorescence",
            "expected_diameter_px": 42,
            "min_area_px": 180,
        },
    }

    default_result = handle_request({"id": "default", "method": "segment", "params": base_params})[
        "result"
    ]
    explicit_result = handle_request(
        {
            "id": "explicit",
            "method": "segment",
            "params": {**base_params, "profile_id": "loci-classical"},
        }
    )["result"]

    assert default_result["engine"] == {"id": "loci-classical", "version": "0.1.0"}
    assert default_result["profile"] == CLASSICAL_PROFILE.provenance_dict()
    assert explicit_result["profile"] == default_result["profile"]
    assert explicit_result["metrics"] == default_result["metrics"]
    assert explicit_result["measurements"] == default_result["measurements"]


def test_segment_rejects_unknown_and_non_ready_profiles_before_reading_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unknown = handle_request(
        {
            "id": "unknown",
            "method": "segment",
            "params": {"path": "/source-must-not-be-read.png", "profile_id": "missing"},
        }
    )
    assert unknown["error"] == {
        "type": "ValueError",
        "message": "Unknown segmentation profile: missing",
    }

    unavailable = _unavailable_onnx_profile()
    monkeypatch.setattr(profile_module, "_PROFILE_INDEX", {unavailable.id: unavailable})
    non_ready = handle_request(
        {
            "id": "non-ready",
            "method": "segment",
            "params": {
                "path": "/source-must-not-be-read.png",
                "profile_id": unavailable.id,
            },
        }
    )
    assert non_ready["error"]["type"] == "RuntimeError"
    assert "is not ready" in non_ready["error"]["message"]
