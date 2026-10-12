import base64
import hashlib
import io
from unittest.mock import MagicMock

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine.native_image import (
    MAX_NATIVE_READ_BUDGET_BYTES,
    NativeImageSession,
    NativeSourceChangedError,
)
from loci_engine.quantitative import DEFAULT_WORKING_BYTES, MAX_WORKING_BYTES, validate_array
from loci_engine.research_jobs import submit_job
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def workbench_env(tmp_path):
    project_dir = tmp_path / "study.loci-study"
    project = ResearchProject.create(project_dir, "Recipe Resource Test")
    wb = Workbench(project)

    # Standard small 64x64 uint16 test image
    image_path = tmp_path / "test-image.tif"
    data = np.zeros((64, 64), dtype=np.uint16)
    data[10:20, 10:20] = 100
    tifffile.imwrite(image_path, data)
    source = wb.import_native(str(image_path))

    return wb, source, tmp_path


def test_constants_and_validate_array_limits():
    assert DEFAULT_WORKING_BYTES == 512 * 1024 * 1024
    assert MAX_WORKING_BYTES == 8 * 1024**3
    assert MAX_WORKING_BYTES == 8589934592

    tiny = np.ones((4, 4), dtype=np.uint8)
    # validate_array accepts up to MAX_WORKING_BYTES
    validate_array(tiny, working_bytes=MAX_WORKING_BYTES)
    validate_array(tiny, working_bytes=1024)

    with pytest.raises(ValueError, match="working_bytes"):
        validate_array(tiny, working_bytes=1023)

    with pytest.raises(ValueError, match="working_bytes"):
        validate_array(tiny, working_bytes=MAX_WORKING_BYTES + 1)


def test_invalid_watershed_scale_is_rejected_before_recipe_job_submission(workbench_env):
    wb, source, _ = workbench_env
    request = {
        "source_id": source["id"],
        "selection": {},
        "recipe": {
            "steps": [],
            "segmentation": {"method": "watershed", "threshold": 50, "split_height": -1},
            "measurement_channels": [0],
        },
    }
    for operation in ("recipe_preflight", "validate_recipe"):
        with pytest.raises(ValueError, match="split_height"):
            wb.execute(operation, request)
    with pytest.raises(ValueError, match="split_height"):
        submit_job(wb, request, "invalid-watershed-scale")
    assert wb.project.list_jobs() == []
    assert wb.project.list_results() == []


def test_recipe_preflight_below_equal_above_estimate(workbench_env):
    wb, source, _ = workbench_env
    # 20x20 crop -> 400 voxels * (96 + 8*1) = 400 * 104 = 41600 bytes
    selection = {"x": 0, "y": 0, "width": 20, "height": 20, "z": 0, "t": 0, "c": 0, "level": 0}
    expected_estimated_bytes = 20 * 20 * 104
    assert expected_estimated_bytes == 41600

    base_recipe = {
        "steps": [],
        "segmentation": {"method": "components", "threshold": 50, "min_size": 0},
        "measurement_channels": [0],
    }

    # 1. Below estimate
    req_below = {
        "source_id": source["id"],
        "selection": selection,
        "recipe": {**base_recipe, "working_bytes": expected_estimated_bytes - 1},
    }
    preflight_below = wb.execute("recipe_preflight", req_below)
    assert preflight_below["within_budget"] is False
    assert preflight_below["estimated_working_bytes"] == expected_estimated_bytes
    assert preflight_below["working_bytes"] == expected_estimated_bytes - 1
    assert preflight_below["maximum_working_bytes"] == 8589934592
    assert preflight_below["estimate_basis"] == "loci.recipe-working-bytes/v1"
    assert preflight_below["resolved_device"] == "cpu"
    assert preflight_below["scientific_validation"] == "unvalidated-research-method"
    assert preflight_below["source_sha256"] == source["sha256"]

    # validate_recipe, preview_recipe, run_recipe, submit_job must reject insufficient budget
    with pytest.raises(ValueError, match="working-memory"):
        wb.execute("validate_recipe", req_below)
    with pytest.raises(ValueError, match="working-memory"):
        wb.execute("preview_recipe", req_below)
    with pytest.raises(ValueError, match="working-memory"):
        wb.execute("run_recipe", req_below)
    with pytest.raises(ValueError, match="working-memory"):
        submit_job(wb, req_below, "client-rejected")

    # 2. Equal to estimate
    req_equal = {
        "source_id": source["id"],
        "selection": selection,
        "recipe": {**base_recipe, "working_bytes": expected_estimated_bytes},
    }
    preflight_equal = wb.execute("recipe_preflight", req_equal)
    assert preflight_equal["within_budget"] is True
    assert preflight_equal["estimated_working_bytes"] == expected_estimated_bytes
    assert preflight_equal["working_bytes"] == expected_estimated_bytes

    validation_equal = wb.execute("validate_recipe", req_equal)
    # Parity check for in-budget request
    assert preflight_equal["recipe"] == validation_equal["recipe"]
    assert preflight_equal["recipe_sha256"] == validation_equal["recipe_sha256"]
    assert preflight_equal["estimated_working_bytes"] == validation_equal["estimated_working_bytes"]

    # 3. Above estimate
    req_above = {
        "source_id": source["id"],
        "selection": selection,
        "recipe": {**base_recipe, "working_bytes": expected_estimated_bytes + 1000},
    }
    preflight_above = wb.execute("recipe_preflight", req_above)
    assert preflight_above["within_budget"] is True
    assert preflight_above["working_bytes"] == expected_estimated_bytes + 1000


def test_recipe_preflight_nonmutating_and_no_source_decoding(workbench_env, monkeypatch):
    wb, source, _ = workbench_env
    initial_results = wb.project.list_results()
    assert initial_results == []

    # Sentinel on read_region to prove no pixel decoding happens
    sentinel = MagicMock(
        side_effect=AssertionError("read_region must not be called during preflight")
    )
    monkeypatch.setattr(NativeImageSession, "read_region", sentinel)

    req = {
        "source_id": source["id"],
        "selection": {"x": 0, "y": 0, "width": 30, "height": 30},
        "recipe": {
            "steps": [],
            "segmentation": {"method": "components", "threshold": 50},
            "working_bytes": 1024 * 1024,
        },
    }
    res = wb.execute("recipe_preflight", req)
    assert res["within_budget"] is True
    assert sentinel.call_count == 0
    assert wb.project.list_results() == []


def test_recipe_preflight_validates_malformed_requests(workbench_env):
    wb, source, _ = workbench_env
    valid_selection = {"x": 0, "y": 0, "width": 10, "height": 10}

    # Unknown source ID
    with pytest.raises(ValueError, match="Source is not registered"):
        wb.execute("recipe_preflight", {
            "source_id": "0" * 32,
            "selection": valid_selection,
            "recipe": {},
        })

    # Malformed budget types and ranges
    for bad_budget in (1023, MAX_WORKING_BYTES + 1, True, False, 1024.0, "1024", float("nan")):
        with pytest.raises(ValueError, match="working_bytes"):
            wb.execute("recipe_preflight", {
                "source_id": source["id"],
                "selection": valid_selection,
                "recipe": {"working_bytes": bad_budget},
            })

    # Unknown recipe field
    with pytest.raises(ValueError, match="Invalid or unknown recipe fields"):
        wb.execute("recipe_preflight", {
            "source_id": source["id"],
            "selection": valid_selection,
            "recipe": {"unsupported_field": True},
        })

    # Invalid segmentation method
    with pytest.raises(ValueError, match="components or watershed"):
        wb.execute("recipe_preflight", {
            "source_id": source["id"],
            "selection": valid_selection,
            "recipe": {"segmentation": {"method": "unsupported_method"}},
        })

    # Invalid measurement channels
    with pytest.raises(ValueError, match="Measurement channels"):
        wb.execute("recipe_preflight", {
            "source_id": source["id"],
            "selection": valid_selection,
            "recipe": {"measurement_channels": list(range(33))},
        })
    with pytest.raises(ValueError, match="c must be an integer between"):
        wb.execute("recipe_preflight", {
            "source_id": source["id"],
            "selection": valid_selection,
            "recipe": {"measurement_channels": [99]},
        })

    # Marker gates without segmentation
    valid_gate = {
        "name": "g1",
        "channel": "1: C1",
        "statistic": "mean",
        "threshold": 10.0,
        "control": "isotype negative control",
    }
    with pytest.raises(ValueError, match="Marker gates require object segmentation"):
        wb.execute("recipe_preflight", {
            "source_id": source["id"],
            "selection": valid_selection,
            "recipe": {"gates": [valid_gate]},
        })


def test_numerical_acceptance_whole_image_3000x3000(tmp_path):
    """Numerical acceptance B: 3000x3000 uint16 tiled OME-TIFF whole-image recipe."""
    project_dir = tmp_path / "large-study.loci-study"
    project = ResearchProject.create(project_dir, "Large Image Test")
    wb = Workbench(project)

    # Generate 3000 x 3000 uint16 tiled OME-TIFF
    edge = 3000
    data = np.zeros((edge, edge), dtype=np.uint16)
    # Component 1: height 16, width 20 -> 320 pixels, value 100
    data[100:116, 200:220] = 100
    # Component 2: height 25, width 40 -> 1000 pixels, value 200
    data[400:425, 500:540] = 200

    tiff_path = tmp_path / "synthetic-3000.ome.tif"
    tifffile.imwrite(
        tiff_path,
        data,
        tile=(256, 256),
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.75,
            "PhysicalSizeYUnit": "µm",
        },
    )

    source_bytes = tiff_path.read_bytes()
    expected_source_sha256 = hashlib.sha256(source_bytes).hexdigest()

    source = wb.import_native(str(tiff_path))
    assert source["sha256"] == expected_source_sha256

    # 1 GiB budget
    budget = 1024**3
    req = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": edge,
            "height": edge,
            "z": 0,
            "t": 0,
            "c": 0,
            "level": 0,
        },
        "recipe": {
            "steps": [],
            "segmentation": {
                "method": "components",
                "threshold": 50,
                "min_size": 0,
                "exclude_border": False,
            },
            "measurement_channels": [0],
            "working_bytes": budget,
        },
    }

    # Preflight check
    preflight = wb.execute("recipe_preflight", req)
    assert preflight["within_budget"] is True
    assert preflight["estimated_working_bytes"] == 3000 * 3000 * 104  # 936,000,000 bytes
    assert preflight["working_bytes"] == 1073741824

    # Run whole image recipe
    output = wb.execute("run_recipe", req)
    result = output["result"]
    assert result["object_count"] == 2

    measurements = output["measurements"]
    assert len(measurements) == 2

    # Sort components by voxel count
    c1, c2 = sorted(measurements, key=lambda m: m["voxel_count"])

    # Independent expected values:
    # Component 1: 320 pixels, area = 320 * (0.5 * 0.75) = 120 um^2, mean intensity = 100
    assert c1["voxel_count"] == 320
    assert pytest.approx(c1["measure"], rel=1e-5) == 120.0
    channel_name = list(c1["intensity"].keys())[0]
    assert pytest.approx(c1["intensity"][channel_name]["mean"], rel=1e-5) == 100.0

    # Component 2: 1000 pixels, area = 1000 * (0.5 * 0.75) = 375 um^2, mean intensity = 200
    assert c2["voxel_count"] == 1000
    assert pytest.approx(c2["measure"], rel=1e-5) == 375.0
    assert pytest.approx(c2["intensity"][channel_name]["mean"], rel=1e-5) == 200.0

    # Source bytes and hash must remain completely unchanged
    assert tiff_path.read_bytes() == source_bytes
    assert hashlib.sha256(tiff_path.read_bytes()).hexdigest() == expected_source_sha256

    # Verify survival across study reopen
    reopened = Workbench(ResearchProject(wb.project.root))
    restored = reopened.execute("result", {"result_id": result["id"]})
    assert restored["result"]["object_count"] == 2
    assert restored["provenance"]["recipe"]["working_bytes"] == budget
    assert restored["provenance"]["recipe_sha256"] == preflight["recipe_sha256"]
    assert restored["provenance"]["selection"] == preflight["selection"]

    # Review must work too: do not reapply the old 512 MiB display default.
    view = reopened.execute("result_view", {"result_id": result["id"]})
    pixels = np.array(Image.open(io.BytesIO(base64.b64decode(view["image"].split(",")[1]))))
    assert pixels.shape == (3000, 3000, 3)
    # Explicitly evaluated 60% linear grayscale + 40% deterministic label tint.
    assert pixels[105, 210].tolist() == [116, 128, 144]
    assert pixels[405, 505].tolist() == [219, 243, 186]
    assert pixels[0, 0].tolist() == [0, 0, 0]
    assert view["revision_hash"] == result["revision_hash"]
    assert view["shape"] == [3000, 3000]
    preview = wb.execute("preview_recipe", req)
    preview_pixels = np.array(Image.open(io.BytesIO(
        base64.b64decode(preview["image"].split(",")[1])
    )))
    assert preview_pixels.shape == (3000, 3000, 3)
    assert preview_pixels[105, 210].tolist() == [128, 128, 128]
    assert len(wb.project.list_results()) == 1


def test_reader_budget_propagation_spy(workbench_env, monkeypatch):
    """Acceptance check C: verify load_scalar propagates
    min(MAX_NATIVE_READ_BUDGET_BYTES, working_bytes).
    """
    wb, source, _ = workbench_env

    recorded_budgets = []
    original_read_region = NativeImageSession.read_region

    def spy_read_region(self, native_selection):
        recorded_budgets.append(native_selection.budget_bytes)
        return original_read_region(self, native_selection)

    monkeypatch.setattr(NativeImageSession, "read_region", spy_read_region)

    small_selection = {"x": 0, "y": 0, "width": 8, "height": 8}

    # 1. 128 MiB budget (< 512 MiB native ceiling)
    budget_128m = 128 * 1024 * 1024
    wb.load_scalar(source["id"], small_selection, working_bytes=budget_128m)
    assert recorded_budgets[-1] == budget_128m

    # 2. 1 GiB budget (> 512 MiB native ceiling) -> must cap at MAX_NATIVE_READ_BUDGET_BYTES
    budget_1g = 1024**3
    wb.load_scalar(source["id"], small_selection, working_bytes=budget_1g)
    assert recorded_budgets[-1] == MAX_NATIVE_READ_BUDGET_BYTES
    assert recorded_budgets[-1] == 512 * 1024 * 1024

    # 3. 8 GiB maximum budget -> must cap at MAX_NATIVE_READ_BUDGET_BYTES
    wb.load_scalar(source["id"], small_selection, working_bytes=MAX_WORKING_BYTES)
    assert recorded_budgets[-1] == MAX_NATIVE_READ_BUDGET_BYTES


def test_recipe_working_bytes_omitted_defaults_to_512mib(workbench_env):
    wb, source, _ = workbench_env
    selection = {"x": 0, "y": 0, "width": 10, "height": 10}
    # Recipe without explicit working_bytes defaults to DEFAULT_WORKING_BYTES
    req = {
        "source_id": source["id"],
        "selection": selection,
        "recipe": {
            "steps": [],
            "segmentation": {"method": "components", "threshold": 10},
        },
    }
    validated = wb.execute("validate_recipe", req)
    assert validated["recipe"]["working_bytes"] == DEFAULT_WORKING_BYTES

    preflight = wb.execute("recipe_preflight", req)
    assert preflight["working_bytes"] == DEFAULT_WORKING_BYTES
    assert preflight["recipe"]["working_bytes"] == DEFAULT_WORKING_BYTES
    assert preflight["recipe_sha256"] == validated["recipe_sha256"]


def test_larger_budget_does_not_bypass_source_identity(workbench_env):
    wb, source, root = workbench_env
    request = {
        "source_id": source["id"],
        "selection": {"x": 0, "y": 0, "width": 20, "height": 20},
        "recipe": {"working_bytes": 1024**3},
    }
    wb.execute("recipe_preflight", request)
    path = root / "test-image.tif"
    data = bytearray(path.read_bytes())
    data[-1] ^= 1
    path.write_bytes(data)
    with pytest.raises(NativeSourceChangedError, match="identity.*changed"):
        wb.execute("run_recipe", request)
    assert wb.project.list_results() == []


def test_insufficient_allowance_never_decodes(workbench_env, monkeypatch):
    wb, source, _ = workbench_env
    sentinel = MagicMock(side_effect=AssertionError("must refuse before decoding"))
    monkeypatch.setattr(NativeImageSession, "read_region", sentinel)
    request = {
        "source_id": source["id"],
        "selection": {"x": 0, "y": 0, "width": 20, "height": 20},
        "recipe": {"working_bytes": 41599},
    }
    assert wb.execute("recipe_preflight", request)["within_budget"] is False
    for operation in ("validate_recipe", "preview_recipe", "run_recipe"):
        with pytest.raises(ValueError, match="larger explicit allowance"):
            wb.execute(operation, request)
    with pytest.raises(ValueError, match="larger explicit allowance"):
        submit_job(wb, request, "client-rejected")
    assert sentinel.call_count == 0
    assert wb.project.list_results() == []
