"""Schema validation must not substitute unit pixels for source calibration."""

import hashlib

import numpy as np
import pytest
import SimpleITK as sitk
import tifffile
from scipy import ndimage as ndi

from loci_engine.quantitative import Geometry, process_scalar, validate_processing_steps
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_workflow import validate_definition
from loci_engine.workbench import Workbench


def _source(tmp_path, spacing):
    image = np.arange(72, dtype=np.uint16).reshape(8, 9)
    if spacing is not None and len(spacing) == 3:
        image = np.stack([image, image + 72, image + 144])
    metadata = {"axes": "ZYX" if image.ndim == 3 else "YX"}
    if spacing is not None:
        for axis, value in zip(metadata["axes"], spacing, strict=True):
            metadata[f"PhysicalSize{axis}"] = value
            metadata[f"PhysicalSize{axis}Unit"] = "µm"
    path = tmp_path / "calibrated.ome.tif"
    tifffile.imwrite(path, image, ome=True, metadata=metadata)
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Calibration"))
    source = wb.import_native(str(path))
    selection = {"z": 0, "z_stop": 3} if image.ndim == 3 else {}
    return wb, source, image, selection, path


def _definition(step):
    nodes = [
        {"id": "source", "type": "source", "settings": {}},
        {"id": "process", "type": "process", "settings": step},
        {"id": "segment", "type": "segment", "settings": {"threshold": 10000}},
        {"id": "measure", "type": "measure", "settings": {"measurement_channels": [0]}},
        {"id": "review", "type": "review", "settings": {}},
        {"id": "export", "type": "export", "settings": {}},
    ]
    return {
        "schema": "loci.workflow/v1",
        "name": "Physical preprocessing",
        "nodes": nodes,
        "edges": [
            {"from": left["id"], "to": right["id"]}
            for left, right in zip(nodes, nodes[1:], strict=False)
        ],
    }


def _save(wb, source, selection, step):
    doc = wb.execute(
        "workflow_save",
        {"workflow_id": "a" * 32, "expected_revision": 0, "definition": _definition(step)},
    )["workflow"]
    return {
        "workflow_id": doc["id"],
        "workflow_revision": doc["revision"],
        "definition_sha256": doc["data"]["definition_sha256"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": selection,
    }


@pytest.mark.parametrize("op", ["gaussian", "subtract_background"])
@pytest.mark.parametrize("spacing", [(4.0, 2.0), (6.0, 4.0, 2.0)])
def test_coarse_physical_sigma_preflight_preview_run_and_workflow_parity(tmp_path, op, spacing):
    wb, source, image, selection, path = _source(tmp_path, spacing)
    step = {"op": op, "sigma": 300.0}
    request = {"source_id": source["id"], "selection": selection, "recipe": {"steps": [step]}}
    preflight = wb.recipe_preflight(request)
    assert preflight["within_budget"] is True
    assert preflight["recipe"]["steps"] == [step]
    assert (
        preflight["recipe_sha256"]
        == hashlib.sha256(canonical_json(preflight["recipe"]).encode()).hexdigest()
    )
    preview = wb.run_recipe(request, preview=True)
    assert wb.project.list_results() == []
    saved = wb.run_recipe(request)
    result = wb.project.result(saved["result"]["id"])
    pixels = tuple(300.0 / value for value in spacing)
    smooth = ndi.gaussian_filter(image.astype(float), pixels, mode="reflect", truncate=4.0)
    expected = smooth if op == "gaussian" else image.astype(float) - smooth
    np.testing.assert_allclose(wb.project.load_array(result["arrays"]["image"]), expected)
    records = result["provenance"]["processing"]
    assert records[0]["sigma_voxels"] == list(pixels)
    assert records[0]["unit"] == "um"
    assert canonical_json(records) == canonical_json(preview["provenance"]["processing"])
    assert result["provenance"]["recipe_sha256"] == preflight["recipe_sha256"]

    binding = _save(wb, source, selection, step)
    prepared = wb.execute("workflow_preflight", binding)
    workflow_preview = wb.execute("workflow_preview", {**binding, "target_node_id": "measure"})
    job = submit_job(wb, binding, "calibration", "workflow_run")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    workflow_result = wb.project.result(output["result"]["id"])
    np.testing.assert_allclose(wb.project.load_array(workflow_result["arrays"]["image"]), expected)
    assert workflow_result["provenance"]["processing"] == records
    assert canonical_json(workflow_preview["provenance"]["processing"]) == canonical_json(records)
    assert workflow_result["provenance"]["recipe_sha256"] == prepared["recipe_sha256"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source["sha256"]


@pytest.mark.parametrize("op", ["gaussian", "subtract_background", "median", "opening", "closing"])
@pytest.mark.parametrize("spacing", [(4.0, 1.0), (1.0, 4.0, 2.0)])
def test_fine_axis_rejects_source_bound_recipe_and_workflow_before_decode(
    tmp_path, monkeypatch, op, spacing
):
    wb, source, _, selection, _ = _source(tmp_path, spacing)
    gaussian = op in {"gaussian", "subtract_background"}
    step = {"op": op, "sigma" if gaussian else "radius": 300.0 if gaussian else 1000.0}
    error = "256 voxels" if gaussian else "footprint is too large"
    binding = _save(wb, source, selection, step)
    request = {"source_id": source["id"], "selection": selection, "recipe": {"steps": [step]}}

    def forbidden_decode(*args, **kwargs):
        pytest.fail("Invalid source-resolved scale must be rejected before decode")

    monkeypatch.setattr(wb, "load_scalar", forbidden_decode)
    for operation in ("recipe_preflight", "validate_recipe", "preview_recipe", "run_recipe"):
        with pytest.raises(ValueError, match=error):
            wb.execute(operation, request)
    for operation in ("workflow_preflight", "workflow_preview"):
        with pytest.raises(ValueError, match=error):
            wb.execute(operation, binding)
    with pytest.raises(ValueError, match=error):
        submit_job(wb, binding, "invalid-calibration", "workflow_run")
    with pytest.raises(ValueError, match=error):
        process_scalar(np.ones((2,) * len(spacing)), Geometry.diagonal(spacing, "um"), [step])
    assert wb.project.list_jobs() == []
    assert wb.project.list_results() == []


@pytest.mark.parametrize("op", ["gaussian", "subtract_background"])
def test_uncalibrated_pixel_mode_preserves_exact_256_voxel_bound(tmp_path, op):
    wb, source, image, selection, _ = _source(tmp_path, None)
    request = {
        "source_id": source["id"],
        "selection": selection,
        "recipe": {"steps": [{"op": op, "sigma": 256}]},
    }
    wb.validate_recipe(request)
    preview = wb.run_recipe(request, preview=True)
    record = preview["provenance"]["processing"][0]
    assert record["unit"] == "pixel"
    assert record["sigma_voxels"] == (256, 256)
    request["recipe"]["steps"][0]["sigma"] = np.nextafter(256.0, np.inf)
    with pytest.raises(ValueError, match="256 voxels"):
        wb.recipe_preflight(request)
    with pytest.raises(ValueError, match="256 voxels"):
        process_scalar(image, Geometry.diagonal((1, 1)), request["recipe"]["steps"])


@pytest.mark.parametrize("op", ["median", "opening", "closing"])
@pytest.mark.parametrize("spacing", [(1000.0, 500.0), (2000.0, 1000.0, 500.0)])
def test_physical_morphology_uses_selected_grid_for_footprint_and_workflow(tmp_path, op, spacing):
    wb, source, image, selection, _ = _source(tmp_path, spacing)
    step = {"op": op, "radius": 1000.0}
    request = {"source_id": source["id"], "selection": selection, "recipe": {"steps": [step]}}
    wb.validate_recipe(request)
    saved = wb.run_recipe(request)
    result = wb.project.result(saved["result"]["id"])
    extents = [int(np.ceil(1000 / value)) for value in spacing]
    grids = np.meshgrid(*(np.arange(-extent, extent + 1) for extent in extents), indexing="ij")
    footprint = sum((grid * value) ** 2 for grid, value in zip(grids, spacing, strict=True)) <= 1e6
    operation = {
        "median": ndi.median_filter,
        "opening": ndi.grey_opening,
        "closing": ndi.grey_closing,
    }
    expected = operation[op](image.astype(float), footprint=footprint, mode="reflect")
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["image"]), expected)
    binding = _save(wb, source, selection, step)
    wb.execute("workflow_preflight", binding)
    preview = wb.execute("workflow_preview", {**binding, "target_node_id": "measure"})
    assert preview["provenance"]["processing"] == result["provenance"]["processing"]
    with pytest.raises(ValueError, match="footprint is too large"):
        validate_processing_steps([step], geometry=Geometry.diagonal((1,) * len(spacing)))


@pytest.mark.parametrize(
    "step",
    [
        {"op": "gaussian", "sigma": 1e6},
        {"op": "subtract_background", "sigma": 1e6, "clip_negative": False},
        {"op": "median", "radius": 1e6},
        {"op": "opening", "radius": 1e6},
        {"op": "closing", "radius": 1e6},
    ],
)
def test_workflow_save_validates_schema_without_a_source_or_pixel_execution(
    tmp_path, monkeypatch, step
):
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Schema only"))

    def forbidden_filter(*args, **kwargs):
        pytest.fail("Schema-only validation must not execute a spatial processing filter")

    for name in ("gaussian_filter", "median_filter", "grey_opening", "grey_closing"):
        monkeypatch.setattr(ndi, name, forbidden_filter)
    doc = wb.execute(
        "workflow_save",
        {"workflow_id": "a" * 32, "expected_revision": 0, "definition": _definition(step)},
    )["workflow"]
    assert doc["data"]["definition"]["nodes"][1]["settings"] == step
    assert wb.execute("workflow_get", {"workflow_id": doc["id"]})["workflow"] == doc
    assert wb.project.list_sources() == []


@pytest.mark.parametrize(
    "op,field",
    [
        ("gaussian", "sigma"),
        ("subtract_background", "sigma"),
        ("median", "radius"),
        ("opening", "radius"),
        ("closing", "radius"),
    ],
)
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1, 1e6 + 1, True, "300"])
def test_processing_schema_rejects_nonfinite_extreme_or_wrong_type_settings(op, field, value):
    step = {"op": op, field: value}
    with pytest.raises(ValueError, match=field):
        validate_processing_steps([step])
    with pytest.raises(ValueError, match=field):
        validate_definition(_definition(step))


@pytest.mark.parametrize(
    "steps",
    [
        None,
        [{}],
        [{"op": []}],
        [{"op": "gaussian", "sigma": 2, "radius": 1}],
        [{"op": "subtract_background", "sigma": 2, "clip_negative": 1}],
        [{"op": "subtract_constant", "value": float("inf")}],
        [{"op": "flatfield", "sigma": 1}],
        [{"op": "flatfield"}] * 33,
    ],
)
def test_processing_schema_rejects_unknown_fields_and_controls(steps):
    with pytest.raises(ValueError):
        validate_processing_steps(steps)


@pytest.mark.parametrize(
    "steps", [[], [{"op": "gaussian", "sigma": 1}], [{"op": "opening", "radius": 1}]]
)
def test_source_bound_preflight_retains_nonorthogonal_rejection(tmp_path, monkeypatch, steps):
    wb, source, _, selection, _ = _source(tmp_path, (2.0, 2.0))
    shear = Geometry("YX", ((2, 1, 0, 0), (0, 2, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)), "um")
    monkeypatch.setattr(wb, "_native_geometry", lambda *args: shear)
    request = {"source_id": source["id"], "selection": selection, "recipe": {"steps": steps}}
    with pytest.raises(ValueError, match="orthogonal"):
        wb.recipe_preflight(request)
    with pytest.raises(ValueError, match="orthogonal"):
        process_scalar(np.ones((2, 2)), shear, steps)


def test_source_bound_preflight_does_not_execute_processing_filters(tmp_path, monkeypatch):
    wb, source, _, selection, _ = _source(tmp_path, (4.0, 2.0))

    def forbidden_filter(*args, **kwargs):
        pytest.fail("Preflight must validate physical scale without executing image filters")

    for name in ("gaussian_filter", "median_filter", "grey_opening", "grey_closing"):
        monkeypatch.setattr(ndi, name, forbidden_filter)
    steps = [
        {"op": "gaussian", "sigma": 300},
        {"op": "subtract_background", "sigma": 300},
        {"op": "median", "radius": 2},
        {"op": "opening", "radius": 2},
        {"op": "closing", "radius": 2},
        {"op": "subtract_constant", "value": 1},
    ]
    wb.validate_recipe(
        {"source_id": source["id"], "selection": selection, "recipe": {"steps": steps}}
    )
    assert wb.project.list_results() == []


def test_preflight_uses_selected_pyramid_level_scale(tmp_path):
    path = tmp_path / "pyramid.tf8"
    image = np.arange(32 * 32, dtype=np.uint16).reshape(32, 32)
    with tifffile.TiffWriter(path, bigtiff=True) as tif:
        tif.write(
            image,
            subifds=1,
            resolution=(20000, 10000),
            resolutionunit="CENTIMETER",
            metadata={"axes": "YX"},
        )
        tif.write(
            image[::2, ::2], subfiletype=1, resolution=(10000, 5000), resolutionunit="CENTIMETER"
        )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Pyramid"))
    source = wb.import_native(str(path))
    request = {
        "source_id": source["id"],
        "selection": {"level": 0},
        "recipe": {"steps": [{"op": "gaussian", "sigma": 200}]},
    }
    with pytest.raises(ValueError, match="256 voxels"):
        wb.recipe_preflight(request)
    request["selection"] = {"level": 1}
    wb.validate_recipe(request)
    preview = wb.run_recipe(request, preview=True)
    assert preview["provenance"]["processing"][0]["sigma_voxels"] == (100, 200)
    assert preview["provenance"]["geometry"]["unit"] == "um"


@pytest.mark.parametrize("volume", [False, True])
def test_medical_preflight_matches_oblique_source_grid_and_plane_axes(tmp_path, volume):
    image = np.arange(3 * 8 * 9, dtype=np.uint16).reshape(3, 8, 9)
    medical = sitk.GetImageFromArray(image)
    medical.SetSpacing((2.0, 4.0, 6.0))
    medical.SetDirection((0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0))
    path = tmp_path / "synthetic.nii"
    sitk.WriteImage(medical, str(path), False)
    project = ResearchProject.create(tmp_path / "study", "Medical calibration")
    wb = Workbench(project)
    source = project.register_medical_source(path)
    selection = {"z": 0, "z_stop": 3} if volume else {"z": 1}
    request = {
        "source_id": source["id"],
        "selection": selection,
        "recipe": {"steps": [{"op": "gaussian", "sigma": 300.0}]},
    }
    wb.validate_recipe(request)
    preview = wb.run_recipe(request, preview=True)
    assert preview["provenance"]["processing"][0]["sigma_voxels"] == (
        (50, 75, 150) if volume else (75, 150)
    )
    assert preview["provenance"]["geometry"]["axes"] == ("ZYX" if volume else "YX")
    assert preview["provenance"]["geometry"]["unit"] == "mm"
