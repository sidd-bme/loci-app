from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from loci_engine.models import SegmentationSettings
from loci_engine.profiles import CLASSICAL_PROFILE, DEFAULT_PROFILE_ID
from loci_engine.quantitative import DEFAULT_WORKING_BYTES
from loci_engine.research_project import ResearchProject
from loci_engine.segment import segment_image
from loci_engine.workbench import Workbench, geometry_from_dict


def _thirty_six_object_phantom() -> np.ndarray:
    image = Image.new("L", (1536, 1536), color=225)
    draw = ImageDraw.Draw(image)
    for row in range(6):
        for column in range(6):
            center_x = 128 + 256 * column
            center_y = 128 + 256 * row
            draw.ellipse(
                (center_x - 44, center_y - 44, center_x + 44, center_y + 44),
                fill=55,
            )
    return np.asarray(image)


def _selection(width: int, height: int) -> dict[str, int]:
    return {
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
        "t": 0,
        "c": 0,
        "z": 0,
        "level": 0,
    }


def _request(
    source_id: str,
    width: int,
    height: int,
    *,
    settings: SegmentationSettings | None = None,
    measurement_channels: list[int] | None = None,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> dict[str, object]:
    configured = settings or SegmentationSettings()
    return {
        "source_id": source_id,
        "selection": _selection(width, height),
        "profile_id": DEFAULT_PROFILE_ID,
        "settings": configured.to_dict(),
        "measurement_channels": [0] if measurement_channels is None else measurement_channels,
        "working_bytes": working_bytes,
    }


def test_adaptive_adapter_matches_unchanged_baseline_labels_and_raw_measurements(tmp_path):
    image = _thirty_six_object_phantom()
    path = tmp_path / "thirty-six.png"
    Image.fromarray(image).save(path)
    project = ResearchProject.create(tmp_path / "adaptive.loci-study", "Adaptive parity")
    workbench = Workbench(project)
    source = workbench.import_native(str(path))
    settings = SegmentationSettings()
    expected = segment_image(image, settings)
    assert expected.count == 36

    response = workbench.execute(
        "classical_run",
        _request(source["id"], image.shape[1], image.shape[0], settings=settings),
    )
    result = project.result(response["result"]["id"])
    labels = project.load_array(result["arrays"]["labels"])
    normalized = project.load_array(result["arrays"]["image"])

    np.testing.assert_array_equal(labels, expected.labels.astype(np.uint32))
    np.testing.assert_array_equal(normalized, expected.normalized)
    assert result["kind"] == "adaptive-segmentation"
    assert result["provenance"]["segmentation"] == {
        "method": "loci-adaptive-watershed",
        "dimensions": 2,
        "count": 36,
        "resolved_polarity": expected.resolved_polarity,
        "threshold": expected.threshold,
        "confluence_percent": expected.confluence_percent,
        "scientific_validation": "unvalidated-research-method",
    }
    assert result["provenance"]["baseline_pixel_measurements"] == expected.measurements
    assert result["provenance"]["profile"] == CLASSICAL_PROFILE.provenance_dict()
    assert result["provenance"]["accepted_request"]["settings"] == settings.to_dict()
    assert result["provenance"]["accepted_request"]["input_mapping"] == {
        "mode": "source-channel",
        "channel": 0,
    }
    assert result["provenance"]["measurement_basis"] == (
        "raw-selected-channel-values-on-result-grid"
    )
    assert response["measurements"] == result["provenance"]["measurements"]
    assert len(response["measurements"]) == 36
    geometry = geometry_from_dict(result["provenance"]["geometry"])
    for row in response["measurements"]:
        raw = row["intensity"]["source_channel_0"]
        assert raw["mean"] == raw["min"] == raw["max"] == 55
        assert raw["sum"] == 55 * row["voxel_count"]
        expected_world = geometry.world(np.asarray([row["centroid_index"]]))[0]
        np.testing.assert_array_equal(row["centroid_world_xyz"], expected_world)
    workbench.close()


def test_adaptive_adapter_requires_exact_profile_settings_selection_and_budget(tmp_path):
    image = np.full((96, 96), 225, dtype=np.uint8)
    image[28:68, 28:68] = 55
    path = tmp_path / "small.png"
    Image.fromarray(image).save(path)
    project = ResearchProject.create(tmp_path / "strict.loci-study", "Strict adapter")
    workbench = Workbench(project)
    source = workbench.import_native(str(path))
    request = _request(source["id"], 96, 96, measurement_channels=[])

    with pytest.raises(ValueError, match="exact project-scoped request"):
        workbench.execute("classical_run", {**request, "unexpected": True})
    with pytest.raises(ValueError, match="built-in Loci Adaptive Watershed profile"):
        workbench.execute("classical_run", {**request, "profile_id": "cellpose-sam"})
    with pytest.raises(ValueError, match="fully resolved 2D source plane"):
        workbench.execute(
            "classical_run", {**request, "selection": {**request["selection"], "z_stop": 1}}
        )
    with pytest.raises(ValueError, match="settings"):
        workbench.execute(
            "classical_run", {**request, "settings": {**request["settings"], "unknown": 1}}
        )
    with pytest.raises(ValueError, match="aggregate working-memory budget"):
        workbench.execute("classical_run", {**request, "working_bytes": 1024**2})
    assert project.list_results() == []
    workbench.close()


def test_adaptive_rgb_mapping_is_explicit_and_raw_component_measurement_is_refused(tmp_path):
    scalar = np.full((96, 96), 225, dtype=np.uint8)
    scalar[24:72, 24:72] = 55
    rgb = np.stack([scalar, scalar, scalar], axis=-1)
    path = tmp_path / "rgb.png"
    Image.fromarray(rgb).save(path)
    project = ResearchProject.create(tmp_path / "rgb.loci-study", "RGB adapter")
    workbench = Workbench(project)
    source = workbench.import_native(str(path))
    request = _request(source["id"], 96, 96, measurement_channels=[])
    expected = segment_image(rgb, SegmentationSettings())

    response = workbench.execute("classical_run", request)
    result = project.result(response["result"]["id"])
    np.testing.assert_array_equal(
        project.load_array(result["arrays"]["labels"]), expected.labels.astype(np.uint32)
    )
    assert result["provenance"]["accepted_request"]["input_mapping"] == {
        "mode": "rgb-derived-grayscale-luminance"
    }
    assert result["provenance"]["measurement_channels"] == []
    with pytest.raises(ValueError, match="RGB samples cannot be measured as biological channels"):
        workbench.execute("classical_run", {**request, "measurement_channels": [0]})
    workbench.close()
