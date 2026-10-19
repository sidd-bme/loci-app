"""Independent synthetic oracles for bounded crop-local classical exploration."""

import base64
import copy
import hashlib
import io

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine.native_image import NativeSourceChangedError
from loci_engine.research_exploration import (
    BOUNDARY_POLICY,
    dispatch_exploration,
    validate_exploration_document,
    validate_exploration_receipt,
)
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


@pytest.fixture
def workbench(tmp_path):
    active = Workbench(ResearchProject.create(tmp_path / "exploration.loci-study", "Exploration"))
    yield active
    active.close()


def import_image(workbench, tmp_path, array=None, *, calibrated=False):
    if array is None:
        array = np.zeros((24, 32), dtype=np.uint16)
        array[2:4, 3:6] = 100  # Six samples, including the strict threshold endpoint.
        array[10:13, 15:19] = 200  # Twelve samples.
    path = tmp_path / "fixture.ome.tif"
    metadata = {"axes": "TCZYX" if array.ndim == 5 else "YX"}
    if calibrated:
        metadata.update(
            PhysicalSizeX=0.5, PhysicalSizeXUnit="µm", PhysicalSizeY=0.25, PhysicalSizeYUnit="µm"
        )
    tifffile.imwrite(path, array, ome=True, metadata=metadata)
    source = workbench.import_native(str(path))
    selection = {
        "x": 0,
        "y": 0,
        "width": array.shape[-1],
        "height": array.shape[-2],
        "c": 0,
        "z": 0,
        "t": 0,
        "level": 0,
    }
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": selection,
        "threshold": 50,
    }
    return path, source, request


def preview(workbench, request, **kwargs):
    return dispatch_exploration(workbench, "exploration_preview", request, **kwargs)


def reseal(value):
    value["receipt_sha256"] = hashlib.sha256(
        canonical_json(
            {key: item for key, item in value.items() if key != "receipt_sha256"}
        ).encode()
    ).hexdigest()
    return value


def pixels(uri):
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))))


def test_preview_independent_areas_units_overlay_and_no_saved_workflow(workbench, tmp_path):
    path, source, request = import_image(workbench, tmp_path, calibrated=True)
    original = path.read_bytes()
    response = preview(workbench, request)
    assert response["object_count"] == 2
    assert response["size_summary"] == pytest.approx(
        {
            "count": 2,
            "measure_kind": "area",
            "measure_unit": "um^2",
            "total": 18 * 0.125,
            "min": 6 * 0.125,
            "max": 12 * 0.125,
            "mean": 9 * 0.125,
            "median": 9 * 0.125,
            "border_object_count": 0,
        },
        rel=1e-12,
        abs=1e-12,
    )
    image, overlay = pixels(response["image"]), pixels(response["label_image"])
    assert image.shape == overlay.shape == (24, 32, 3)
    assert np.array_equal(image[0, 0], overlay[0, 0])
    assert not np.array_equal(image[2, 3], overlay[2, 3])
    receipt = validate_exploration_receipt(response["receipt"])
    assert receipt["source_id"] == source["id"]
    assert receipt["source_sha256"] == hashlib.sha256(original).hexdigest()
    assert receipt["selection"] == request["selection"]
    assert receipt["min_size_unit"] == "um^2"
    assert receipt["boundary_policy"] == BOUNDARY_POLICY
    assert receipt["effective_recipe"]["segmentation"] == {
        "method": "components",
        "threshold": 50.0,
        "min_size": 0.0,
        "polarity": "bright",
        "exclude_border": False,
    }
    assert path.read_bytes() == original
    assert workbench.project.list_results() == []
    for kind in ("workflow", "recipe", "exploration"):
        assert workbench.project.documents(kind) == []


def test_preview_supports_repeated_calibrated_equal_areas(workbench, tmp_path):
    array = np.zeros((24, 32), dtype=np.uint16)
    for y, x in [(2, 3), (10, 15), (18, 25)]:
        array[y : y + 2, x : x + 3] = 100
    source_path = tmp_path / "repeated-calibrated-areas.ome.tif"
    tifffile.imwrite(
        source_path,
        array,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.25,
            "PhysicalSizeYUnit": "µm",
        },
    )
    source = workbench.import_native(str(source_path))
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": dict(x=0, y=0, width=32, height=24, c=0, z=0, t=0, level=0),
        "threshold": 50,
    }
    response = preview(workbench, request)
    assert response["object_count"] == 3
    summary = response["size_summary"]
    assert summary["count"] == 3
    assert summary["measure_unit"] == "um^2"
    assert summary["min"] == summary["max"] == pytest.approx(0.75)
    assert summary["mean"] == pytest.approx(0.75)
    receipt = validate_exploration_receipt(response["receipt"])
    assert receipt["object_count"] == 3


@pytest.mark.parametrize("bad_mean", [0.5, 0.74, 1.51, 2.0, 100.0])
def test_exploration_size_summary_strictly_rejects_genuinely_inconsistent_mean(
    workbench, tmp_path, bad_mean
):
    _, _, request = import_image(workbench, tmp_path, calibrated=True)
    response = preview(workbench, request)
    receipt = copy.deepcopy(response["receipt"])
    receipt["size_summary"]["mean"] = bad_mean
    receipt["receipt_sha256"] = hashlib.sha256(
        canonical_json({k: v for k, v in receipt.items() if k != "receipt_sha256"}).encode()
    ).hexdigest()
    with pytest.raises(ValueError, match="Exploration mean size is outside its range"):
        validate_exploration_receipt(receipt)


@pytest.mark.parametrize("area", [1e-18, 1e-13, 1.0, 1e13])
@pytest.mark.parametrize("mean_factor", [0.0, 0.5, 2.0])
def test_mean_boundary_tolerance_has_no_absolute_area_floor(
    workbench, tmp_path, area, mean_factor
):
    _, _, request = import_image(workbench, tmp_path, calibrated=True)
    receipt = copy.deepcopy(preview(workbench, request)["receipt"])
    summary = receipt["size_summary"]
    summary.update(min=area, median=area, max=area, total=2 * area, mean=area)
    validate_exploration_receipt(reseal(receipt))
    # A one-ULP reduction discrepancy remains valid at every scale.
    summary["mean"] = float(np.nextafter(area, np.inf))
    validate_exploration_receipt(reseal(receipt))
    summary["mean"] = area * mean_factor
    with pytest.raises(ValueError, match="Exploration mean size is outside its range"):
        validate_exploration_receipt(reseal(receipt))


def test_preview_uses_all_objects_beyond_returned_measurement_limit(workbench, tmp_path):
    array = np.zeros((100, 100), dtype=np.uint16)
    array[:70:2, :70:2] = 100  # 1,225 independent four-connected one-pixel objects.
    array[90:95, 90:95] = 100  # One 25-pixel object after the first 1,000 rows.
    _, _, request = import_image(workbench, tmp_path, array)
    response = preview(workbench, request)
    assert response["object_count"] == 1226
    summary = response["size_summary"]
    assert summary["total"] == 1250
    assert summary["mean"] == pytest.approx(1250 / 1226)
    assert summary["median"] == summary["min"] == 1
    assert summary["max"] == 25
    assert summary["measure_unit"] == "pixel^2"


def test_crop_local_boundary_retains_clipped_objects_and_exact_context(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    request["selection"].update(x=4, y=0, width=16, height=16)
    response = preview(workbench, request)
    assert response["object_count"] == 2
    assert response["size_summary"]["total"] == 4 + 12
    assert response["size_summary"]["min"] == 4
    assert response["size_summary"]["border_object_count"] == 1
    assert response["receipt"]["boundary_policy"]["halo_pixels"] == 0
    assert response["receipt"]["boundary_policy"]["full_image_equivalence"] is False
    assert response["receipt"]["geometry"]["affine"][0][3] == 4


def test_strict_threshold_and_minimum_physical_size(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path, calibrated=True)
    response = preview(workbench, {**request, "threshold": 100})
    assert response["object_count"] == 1
    assert response["size_summary"]["total"] == pytest.approx(1.5, rel=1e-12)
    assert preview(workbench, {**request, "min_size": 0.751})["object_count"] == 1
    assert preview(workbench, {**request, "min_size": 0.75})["object_count"] == 2


def test_zero_objects_has_defined_units_and_no_fabricated_mean(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    response = preview(workbench, {**request, "threshold": 1000})
    assert response["object_count"] == 0
    assert response["size_summary"] == {
        "count": 0,
        "measure_kind": "area",
        "measure_unit": "pixel^2",
        "total": 0.0,
        "mean": None,
        "median": None,
        "min": None,
        "max": None,
        "border_object_count": 0,
    }
    assert response["image"] == response["label_image"]


def test_display_changes_do_not_change_raw_preview_or_numbers(workbench, tmp_path):
    _, source, request = import_image(workbench, tmp_path)
    first = preview(workbench, request)
    workbench.project.put_document(
        "display",
        source["id"],
        {
            "channels": [{"channel": 0, "low": 0, "high": 10000, "gamma": 4, "color": "#ff0000"}],
        },
        expected_revision=0,
    )
    workbench.view(
        {
            "source_id": source["id"],
            "selection": request["selection"],
            "channels": [{"channel": 0, "low": 0, "high": 10000, "gamma": 4}],
        }
    )
    assert preview(workbench, request) == first


@pytest.mark.parametrize(
    "change",
    [
        {"threshold": float("nan")},
        {"threshold": "otsu"},
        {"threshold": True},
        {"min_size": -1},
        {"min_size": float("inf")},
        {"method": "watershed"},
        {"source_sha256": "0" * 64},
        {"source_sha256": "invalid"},
        {"display": {}},
    ],
)
def test_preview_rejects_invalid_or_unbound_settings(workbench, tmp_path, change):
    _, _, request = import_image(workbench, tmp_path)
    with pytest.raises(ValueError):
        preview(workbench, {**request, **change})
    assert workbench.project.list_results() == []


@pytest.mark.parametrize(
    "change",
    [
        {"width": 513},
        {"height": 513},
        {"width": 0},
        {"x": -1},
        {"x": 31, "width": 2},
        {"z_stop": 1},
        {"level": 1},
        {"c": 1},
        {"t": 1},
        {"z": 1},
        {"width": True},
    ],
)
def test_preview_rejects_invalid_or_excess_selection(workbench, tmp_path, change):
    _, _, request = import_image(workbench, tmp_path)
    with pytest.raises(ValueError):
        preview(workbench, {**request, "selection": {**request["selection"], **change}})


def test_preview_requires_all_selection_coordinates(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    for key in request["selection"]:
        selection = {field: value for field, value in request["selection"].items() if field != key}
        with pytest.raises(ValueError, match="Complete explicit"):
            preview(workbench, {**request, "selection": selection})


def test_explicit_c_z_t_plane_is_replayed_exactly(workbench, tmp_path):
    array = np.zeros((2, 2, 2, 24, 32), dtype=np.uint16)
    array[1, 1, 1, 5:8, 8:12] = 200
    _, _, request = import_image(workbench, tmp_path, array)
    assert preview(workbench, request)["object_count"] == 0
    request["selection"].update(c=1, z=1, t=1)
    response = preview(workbench, request)
    assert response["object_count"] == 1
    assert response["size_summary"]["total"] == 12
    assert response["receipt"]["selection"] == request["selection"]


def test_rgb_is_rejected_without_inferred_channels(workbench, tmp_path):
    path = tmp_path / "rgb.png"
    Image.fromarray(np.zeros((12, 12, 3), dtype=np.uint8)).save(path)
    source = workbench.import_native(str(path))
    with pytest.raises(ValueError, match="RGB"):
        preview(
            workbench,
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "selection": {
                    "x": 0,
                    "y": 0,
                    "width": 12,
                    "height": 12,
                    "c": 0,
                    "z": 0,
                    "t": 0,
                    "level": 0,
                },
                "threshold": 50,
            },
        )


def test_source_drift_before_and_after_execution_is_rejected(workbench, tmp_path, monkeypatch):
    path, _, request = import_image(workbench, tmp_path)
    original = workbench.run_recipe

    def changing(*args, **kwargs):
        response = original(*args, **kwargs)
        path.write_bytes(path.read_bytes() + b"drift")
        return response

    monkeypatch.setattr(workbench, "run_recipe", changing)
    with pytest.raises(NativeSourceChangedError, match="changed|identity|match"):
        preview(workbench, request)
    assert workbench.project.list_results() == []
    with pytest.raises(NativeSourceChangedError, match="changed|identity|match"):
        preview(workbench, request)


def test_adoption_replays_exact_parameters_and_embeds_receipt(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path, calibrated=True)
    response = preview(workbench, {**request, "threshold": 120, "min_size": 1})
    receipt = response["receipt"]
    adopted = dispatch_exploration(workbench, "exploration_run", {"receipt": receipt})
    result = workbench.project.result(adopted["result"]["id"])
    assert result["provenance"]["exploration"] == receipt
    assert result["provenance"]["recipe"] == receipt["effective_recipe"]
    assert result["provenance"]["selection"] == request["selection"]
    labels = workbench.project.load_array(result["arrays"]["labels"])
    assert np.count_nonzero(labels) == 12
    assert len(result["provenance"]["measurements"]) == 1
    assert result["provenance"]["measurements"][0]["measure"] == pytest.approx(1.5, rel=1e-12)
    assert workbench.project.documents("workflow") == []


def test_adoption_rejects_tamper_even_with_resealed_hash(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, request)["receipt"]
    invalid = copy.deepcopy(receipt)
    invalid["object_count"] = 3
    with pytest.raises(ValueError):
        dispatch_exploration(workbench, "exploration_run", {"receipt": invalid})
    invalid = copy.deepcopy(receipt)
    invalid["content_hashes"]["measurements_sha256"] = "0" * 64
    reseal(invalid)
    with pytest.raises(ValueError, match="preview changed"):
        dispatch_exploration(workbench, "exploration_run", {"receipt": invalid})
    assert workbench.project.list_results() == []


@pytest.mark.parametrize("field", ["runtime", "geometry", "boundary_policy", "min_size_unit"])
def test_adoption_rejects_changed_execution_context(workbench, tmp_path, field):
    _, _, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, request)["receipt"]
    if field == "runtime":
        receipt[field]["engine"] = "different-engine-version"
    elif field == "geometry":
        receipt[field]["affine"][0][3] += 1
    elif field == "min_size_unit":
        receipt[field] = "um^2"
    else:
        receipt[field]["halo_pixels"] = 1
    reseal(receipt)
    with pytest.raises(ValueError):
        dispatch_exploration(workbench, "exploration_run", {"receipt": receipt})
    assert workbench.project.list_results() == []


def test_maximum_edge_is_supported_without_implicit_full_image_execution(workbench, tmp_path):
    array = np.zeros((513, 513), dtype=np.uint16)
    array[511:513, 511:513] = 100
    _, _, request = import_image(workbench, tmp_path, array)
    request["selection"].update(width=512, height=512)
    response = preview(workbench, request)
    assert response["object_count"] == 1
    assert response["size_summary"]["total"] == 1
    assert response["size_summary"]["border_object_count"] == 1
    assert pixels(response["image"]).shape == (512, 512, 3)


def test_adoption_cancellation_at_publication_does_not_publish(workbench, tmp_path, monkeypatch):
    _, _, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, request)["receipt"]
    original = workbench.project.save_result
    cancelled = False

    def cancel_before_publication(**kwargs):
        nonlocal cancelled
        cancelled = True
        return original(**kwargs)

    def guard():
        if cancelled:
            raise ValueError("Cancelled before publication")

    monkeypatch.setattr(workbench.project, "save_result", cancel_before_publication)
    with pytest.raises(ValueError, match="Cancelled"):
        dispatch_exploration(
            workbench, "exploration_run", {"receipt": receipt}, publication_guard=guard
        )
    assert workbench.project.list_results() == []


def comparison_request(request):
    selection = request["selection"]
    return {
        "source_id": request["source_id"],
        "source_sha256": request["source_sha256"],
        "regions": [
            selection,
            {**selection, "x": 2, "width": 30},
            {**selection, "y": 1, "height": 23},
        ],
        "configurations": [{"threshold": 50}, {"threshold": 100}, {"threshold": 250}],
    }


def test_comparison_complete_nine_cells_and_durable_compact_receipt(workbench, tmp_path):
    _, source, request = import_image(workbench, tmp_path)
    response = dispatch_exploration(workbench, "exploration_compare", comparison_request(request))
    assert len(response["cells"]) == 9
    assert [cell["object_count"] for cell in response["cells"]] == [2, 1, 0] * 3
    documents = workbench.project.documents("exploration")
    assert documents == [response["comparison"]]
    assert response["receipt"] == documents[0]["data"]
    assert "data:image" not in canonical_json(documents)
    validate_exploration_document(documents[0], [source], [])
    assert workbench.project.list_results() == []
    assert workbench.project.documents("workflow") == []
    # A cell can be adopted without adopting the other parameter choices.
    cell = response["cells"][1]
    adopted = dispatch_exploration(workbench, "exploration_run", {"receipt": cell["receipt"]})
    assert adopted["result"]["object_count"] == 1


@pytest.mark.parametrize(
    "change",
    [
        {"regions": []},
        {"configurations": []},
        {"configurations": [{"threshold": 1}] * 4},
        {"configurations": [{"threshold": 1}] * 2},
    ],
)
def test_comparison_rejects_invalid_matrix_before_any_execution(
    workbench, tmp_path, monkeypatch, change
):
    _, _, request = import_image(workbench, tmp_path)
    calls = []
    monkeypatch.setattr(workbench, "run_recipe", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(ValueError):
        dispatch_exploration(
            workbench, "exploration_compare", {**comparison_request(request), **change}
        )
    assert calls == []
    assert workbench.project.documents("exploration") == []


def test_comparison_requires_shared_plane_and_validates_last_roi_first(
    workbench, tmp_path, monkeypatch
):
    _, _, request = import_image(workbench, tmp_path)
    calls = []
    monkeypatch.setattr(workbench, "run_recipe", lambda *args, **kwargs: calls.append(args))
    for change in ({"c": 1}, {"z": 1}, {"t": 1}, {"level": 1}, {"width": 513}, {"x": 32}):
        matrix = comparison_request(request)
        matrix["regions"][-1].update(change)
        with pytest.raises(ValueError):
            dispatch_exploration(workbench, "exploration_compare", matrix)
    assert calls == []


def test_comparison_cancellation_between_cells_publishes_nothing(workbench, tmp_path, monkeypatch):
    _, _, request = import_image(workbench, tmp_path)
    original = workbench.run_recipe
    calls = 0

    def run(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    def guard():
        if calls == 1:
            raise ValueError("Cancelled comparison")

    monkeypatch.setattr(workbench, "run_recipe", run)
    with pytest.raises(ValueError, match="Cancelled"):
        dispatch_exploration(
            workbench, "exploration_compare", comparison_request(request), publication_guard=guard
        )
    assert calls == 1
    assert workbench.project.documents("exploration") == []
    assert workbench.project.list_results() == []


def test_portable_comparison_refuses_resealed_cell_binding_and_source_tamper(workbench, tmp_path):
    _, source, request = import_image(workbench, tmp_path)
    document = dispatch_exploration(workbench, "exploration_compare", comparison_request(request))[
        "comparison"
    ]
    invalid = copy.deepcopy(document)
    invalid["data"]["cells"][0]["receipt"]["selection"]["x"] = 1
    reseal(invalid["data"]["cells"][0]["receipt"])
    reseal(invalid["data"])
    with pytest.raises(ValueError, match="binding disagrees"):
        validate_exploration_document(invalid, [source], [])
    invalid = copy.deepcopy(document)
    invalid["data"]["source_sha256"] = "0" * 64
    reseal(invalid["data"])
    with pytest.raises(ValueError, match="source binding"):
        validate_exploration_document(invalid, [source], [])


def test_durable_adoption_job_binds_source_and_publishes_exact_selected_receipt(
    workbench, tmp_path
):
    _, source, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, {**request, "threshold": 100})["receipt"]
    job = submit_job(workbench, {"receipt": receipt}, "adopt-selected", "exploration_run")
    assert workbench.project.job(job["id"])["request"]["source_id"] == source["id"]
    output = run_job(workbench, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert output["job"]["result_ids"] == [output["result"]["id"]]
    result = workbench.project.result(output["result"]["id"])
    assert result["source_id"] == source["id"]
    assert result["source_sha256"] == source["sha256"]
    assert result["provenance"]["exploration"] == receipt
    assert result["provenance"]["job_id"] == job["id"]


def test_durable_compare_completes_without_publishing_result(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    job = submit_job(workbench, comparison_request(request), "matrix", "exploration_compare")
    output = run_job(workbench, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert len(output["cells"]) == 9
    assert len(workbench.project.documents("exploration")) == 1
    assert workbench.project.list_results() == []


def test_durable_compare_cancelled_between_cells_never_saves_receipt(
    workbench, tmp_path, monkeypatch
):
    _, _, request = import_image(workbench, tmp_path)
    job = submit_job(workbench, comparison_request(request), "cancel-matrix", "exploration_compare")
    original = workbench.run_recipe
    calls = 0

    def cancel_after_first_cell(*args, **kwargs):
        nonlocal calls
        calls += 1
        response = original(*args, **kwargs)
        cancel_job(workbench.project, job["id"])
        return response

    monkeypatch.setattr(workbench, "run_recipe", cancel_after_first_cell)
    with pytest.raises(ValueError, match="cancelled"):
        run_job(workbench, job["id"])
    assert calls == 1
    assert workbench.project.job(job["id"])["state"] == "cancelled"
    assert workbench.project.documents("exploration") == []


def test_durable_adoption_cancelled_during_staging_never_publishes(
    workbench, tmp_path, monkeypatch
):
    _, _, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, request)["receipt"]
    job = submit_job(workbench, {"receipt": receipt}, "cancel-adoption", "exploration_run")
    original = workbench.project.store_array

    def cancel_while_staging(array):
        stored = original(array)
        cancel_job(workbench.project, job["id"])
        return stored

    monkeypatch.setattr(workbench.project, "store_array", cancel_while_staging)
    with pytest.raises(ValueError, match="cancelled"):
        run_job(workbench, job["id"])
    assert workbench.project.job(job["id"])["state"] == "cancelled"
    assert workbench.project.list_results() == []


def test_saved_comparison_can_be_inspected_after_cold_reopen(workbench, tmp_path):
    _, source, request = import_image(workbench, tmp_path)
    saved = dispatch_exploration(workbench, "exploration_compare", comparison_request(request))
    reopened = Workbench(ResearchProject(workbench.project.root))
    binding = {"source_id": source["id"], "source_sha256": source["sha256"]}
    listing = reopened.execute("exploration_list", binding)
    assert listing["comparisons"][0]["id"] == saved["comparison"]["id"]
    assert listing["comparisons"][0]["region_count"] == 3
    restored = reopened.execute(
        "exploration_get", {**binding, "comparison_id": saved["comparison"]["id"]}
    )
    assert restored["comparison"] == saved["comparison"]
    with pytest.raises(ValueError, match="identity"):
        reopened.execute("exploration_list", {**binding, "source_sha256": "0" * 64})
    with pytest.raises(ValueError, match="absent"):
        reopened.execute("exploration_get", {**binding, "comparison_id": "a" * 32})
    reopened.close()


def test_adopted_exploration_origin_survives_portable_export_import(workbench, tmp_path):
    from loci_engine.research_interchange import export_project, import_project

    _, _, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, request)["receipt"]
    result = workbench.execute("exploration_run", {"receipt": receipt})["result"]
    archive = tmp_path / "export.zip"
    export_project(workbench.project, archive)
    restored = import_project(archive, tmp_path / "restored.loci-study")
    assert restored.result(result["id"])["provenance"]["exploration"] == receipt


def test_png_receipt_hashes_are_hashes_of_the_actual_png_bytes(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    output = preview(workbench, request)
    for name in ("image", "label_image"):
        png = base64.b64decode(output[name].split(",", 1)[1], validate=True)
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        assert (
            output["receipt"]["content_hashes"][f"{name}_png_sha256"]
            == hashlib.sha256(png).hexdigest()
        )


def test_adoption_refuses_a_changed_numerical_implementation_identity(
    workbench, tmp_path, monkeypatch
):
    import loci_engine.research_exploration as exploration

    _, _, request = import_image(workbench, tmp_path)
    receipt = preview(workbench, request)["receipt"]
    assert receipt["software_identity"]["kind"] == "source-modules-sha256"
    monkeypatch.setattr(
        exploration,
        "_software_identity",
        lambda: {"kind": "source-modules-sha256", "sha256": "0" * 64},
    )
    with pytest.raises(ValueError, match="preview changed"):
        dispatch_exploration(workbench, "exploration_run", {"receipt": receipt})
    assert workbench.project.list_results() == []


def test_legacy_recipe_preview_keeps_its_bounded_response_contract(workbench, tmp_path):
    _, _, request = import_image(workbench, tmp_path)
    recipe = {
        "segmentation": {"method": "components", "threshold": 50},
        "measurement_channels": [0],
    }
    output = workbench.run_recipe(
        {"source_id": request["source_id"], "selection": request["selection"], "recipe": recipe},
        preview=True,
    )
    assert output["object_count"] == 2
    assert [row["measure"] for row in output["measurements"]] == [6, 12]
    assert {"label_image", "content_hashes", "size_summary"}.isdisjoint(output)
    assert workbench.project.list_results() == []


def test_gui_json_roundtrip_preserves_exact_opaque_receipt_adoption(workbench, tmp_path):
    import json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the real GUI JSON transport check")
    _, _, request = import_image(workbench, tmp_path, calibrated=True)
    output = preview(workbench, request)
    transported = subprocess.run(
        [
            node,
            "-e",
            "let s='';process.stdin.on('data',d=>s+=d);"
            "process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))));",
        ],
        input=canonical_json(output),
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    wire = json.loads(transported.stdout)
    assert type(wire["receipt"]["effective_recipe"]["segmentation"]["threshold"]) is int
    assert wire["receipt_json"] == canonical_json(output["receipt"])
    job = submit_job(
        workbench, {"receipt_json": wire["receipt_json"]}, "gui-wire-roundtrip", "exploration_run"
    )
    result = run_job(workbench, job["id"])
    assert result["job"]["state"] == "succeeded"
    # Geometry uses a floating determinant; retain its values and bound only rounding error.
    np.testing.assert_allclose(
        [row["measure"] for row in result["measurements"]], [0.75, 1.5], rtol=0, atol=1e-14
    )
    assert (
        workbench.project.result(result["result"]["id"])["provenance"]["exploration"]
        == output["receipt"]
    )
