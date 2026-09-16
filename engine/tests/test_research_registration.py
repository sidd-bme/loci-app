from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pytest
from scipy import ndimage as ndi

from loci_engine.quantitative import Geometry
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_registration import execute_registration
from loci_engine.workbench import Workbench, geometry_from_dict


def _phantom(shape: tuple[int, int] = (48, 52)) -> np.ndarray:
    image = np.zeros(shape, dtype=np.float64)
    image[7:15, 10:20] = 2
    image[29:38, 33:45] = 0.7
    image[20:24, 6:12] = 1.2
    return ndi.gaussian_filter(image, 1.0)


def _oblique_reflected_geometry() -> Geometry:
    angle = math.radians(27)
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    basis = rotation @ np.diag([-0.7, 2.0])
    affine = np.eye(4)
    affine[:2, :2] = basis
    affine[:3, 3] = (42.0, -17.0, 3.0)
    return Geometry("YX", tuple(map(tuple, affine)), "mm", "LPS")


def _source(project: ResearchProject, path: Path, payload: bytes) -> dict:
    path.write_bytes(payload)
    return project.register_source(
        path.resolve(), hashlib.sha256(payload).hexdigest(), {"fixture": True}
    )


def _result(
    project: ResearchProject,
    source: dict,
    image: np.ndarray,
    geometry: Geometry,
    *,
    labels: np.ndarray | None = None,
    extra_arrays: dict[str, np.ndarray] | None = None,
) -> dict:
    arrays = {"image": image}
    if labels is not None:
        arrays["labels"] = labels
    if extra_arrays is not None:
        arrays.update(extra_arrays)
    return project.save_result(
        source_id=source["id"],
        kind="fixture",
        arrays=arrays,
        provenance={"geometry": geometry.to_dict(), "fixture": True},
    )


@pytest.fixture
def registration_scene(tmp_path: Path):
    project = ResearchProject.create(tmp_path / "registration.loci-study", "Registration")
    workbench = Workbench(project)
    geometry = _oblique_reflected_geometry()
    fixed_image = _phantom()
    moving_image = ndi.shift(fixed_image, (3, -4), order=1, mode="constant")
    moving_labels = np.zeros(fixed_image.shape, dtype=np.uint32)
    moving_labels[10:18, 6:16] = 2**24 + 19
    moving_counts = np.arange(fixed_image.size, dtype=np.uint16).reshape(fixed_image.shape)
    fixed_source = _source(project, tmp_path / "fixed.bin", b"fixed-source")
    moving_source = _source(project, tmp_path / "moving.bin", b"moving-source")
    fixed = _result(project, fixed_source, fixed_image, geometry)
    moving = _result(
        project,
        moving_source,
        moving_image,
        geometry,
        labels=moving_labels,
        extra_arrays={"counts": moving_counts},
    )
    yield workbench, fixed, moving, geometry, fixed_image, moving_image
    workbench.close()


def _registration_request(fixed: dict, moving: dict) -> dict:
    return {
        "fixed": {
            "result_id": fixed["id"],
            "revision_hash": fixed["revision_hash"],
            "array": "image",
        },
        "moving": {
            "result_id": moving["id"],
            "revision_hash": moving["revision_hash"],
            "array": "image",
        },
        "method": "translation_phase_correlation",
        "settings": {"upsample_factor": 20, "min_normalized_correlation": 0.8},
        "outputs": [
            {
                "array": "image",
                "output_name": "image",
                "kind": "scalar",
                "interpolation": "linear",
                "default_value": 0,
            },
            {
                "array": "labels",
                "output_name": "labels",
                "kind": "labels",
                "interpolation": "nearest",
                "default_value": 0,
            },
        ],
        "working_bytes": 16 * 1024**2,
    }


def test_phase_preview_and_exact_run_preserve_oblique_left_right_world_geometry(
    registration_scene,
) -> None:
    workbench, fixed, moving, geometry, fixed_image, moving_image = registration_scene
    moving_before = moving_image.copy()
    preview = execute_registration(
        workbench, "registration_preview", _registration_request(fixed, moving)
    )

    assert preview["adopted"] is False
    receipt = preview["preview"]
    transform = np.asarray(receipt["transform"]["moving_to_fixed"]["homogeneous_matrix"])
    expected_shift_xyz = np.array([4.0, -3.0, 0.0])
    expected_world = np.asarray(geometry.affine)[:3, :3] @ expected_shift_xyz
    np.testing.assert_allclose(transform[:3, 3], expected_world, atol=0.15)
    assert receipt["transform"]["moving_to_fixed"]["direction"].startswith("moving-world")

    output = execute_registration(
        workbench,
        "registration_run",
        {"preview": receipt, "preview_sha256": preview["preview_sha256"]},
    )
    child = workbench.project.result(output["result"]["id"])
    registered = workbench.project.load_array(child["arrays"]["image"])
    labels = workbench.project.load_array(child["arrays"]["labels"])

    assert child["parent_id"] == moving["id"]
    assert registered.dtype == np.float64
    assert np.corrcoef(fixed_image.ravel(), registered.ravel())[0, 1] > 0.98
    assert 2**24 + 19 in np.unique(labels)
    assert set(np.unique(labels)) <= {0, 2**24 + 19}
    assert child["provenance"]["measurement_basis"].startswith("REGISTERED-DERIVED")
    assert child["provenance"]["measurements"][0]["label"] == 2**24 + 19
    output_geometry = geometry_from_dict(child["provenance"]["geometry"])
    np.testing.assert_allclose(output_geometry.affine, geometry.affine)
    assert np.linalg.det(np.asarray(output_geometry.affine)[:2, :2]) < 0
    np.testing.assert_array_equal(moving_image, moving_before)


def test_exact_preview_bytes_survive_javascript_numeric_roundtrip(registration_scene) -> None:
    workbench, fixed, moving, _, _, _ = registration_scene
    response = execute_registration(
        workbench, "registration_preview", _registration_request(fixed, moving)
    )
    # JavaScript JSON.stringify emits 1 for 1.0 and 0 for -0.0. Preserve the
    # engine's canonical string instead of regenerating it from display numbers.
    transport = json.loads(
        json.dumps(response),
        parse_float=lambda raw: int(float(raw)) if float(raw).is_integer() else float(raw),
    )
    assert transport["preview_json"] == response["preview_json"]
    assert (
        hashlib.sha256(transport["preview_json"].encode()).hexdigest()
        == response["preview_sha256"]
    )
    assert (
        hashlib.sha256(canonical_json(transport["preview"]).encode()).hexdigest()
        != response["preview_sha256"]
    )
    output = execute_registration(
        workbench,
        "registration_run",
        {key: transport[key] for key in ("preview_json", "preview_sha256")},
    )
    record = workbench.project.result(output["result"]["id"])
    assert (
        canonical_json(record["provenance"]["registration_preview"]["receipt"])
        == response["preview_json"]
    )
    assert record["provenance"]["registration_preview"]["sha256"] == response["preview_sha256"]
    assert record["parent_id"] == moving["id"]


@pytest.mark.parametrize("mutation", ["hash", "whitespace", "duplicate", "both", "oversize"])
def test_encoded_preview_refuses_changed_or_ambiguous_receipt(registration_scene, mutation) -> None:
    workbench, fixed, moving, _, _, _ = registration_scene
    preview = execute_registration(
        workbench, "registration_preview", _registration_request(fixed, moving)
    )
    request = {key: preview[key] for key in ("preview_json", "preview_sha256")}
    if mutation == "hash":
        request["preview_sha256"] = "0" * 64
    elif mutation == "whitespace":
        request["preview_json"] += " "
    elif mutation == "duplicate":
        request["preview_json"] = '{"schema":"x","schema":"y"}'
    elif mutation == "both":
        request["preview"] = preview["preview"]
    else:
        request["preview_json"] = " " * (1024**2 + 1)
    before = len(workbench.project.list_results())
    with pytest.raises(ValueError):
        execute_registration(workbench, "registration_run", request)
    assert len(workbench.project.list_results()) == before


def test_identical_phase_registration_is_identity(registration_scene) -> None:
    workbench, fixed, _, _, _, _ = registration_scene
    request = _registration_request(fixed, fixed)
    request["outputs"] = request["outputs"][:1]
    preview_response = execute_registration(workbench, "registration_preview", request)
    preview = preview_response["preview"]
    np.testing.assert_allclose(
        preview["transform"]["moving_to_fixed"]["homogeneous_matrix"],
        np.eye(4),
        atol=1e-7,
    )


def test_known_3d_shift_uses_anisotropic_oblique_world_coordinates(tmp_path: Path) -> None:
    project = ResearchProject.create(tmp_path / "volume.loci-study", "Volume")
    workbench = Workbench(project)
    fixed_values = np.zeros((20, 28, 32), dtype=np.float64)
    fixed_values[3:8, 5:12, 17:25] = 1
    fixed_values[12:17, 18:25, 4:11] = 0.6
    fixed_values = ndi.gaussian_filter(fixed_values, 0.8)
    moving_values = ndi.shift(fixed_values, (2, -3, 4), order=1, mode="constant")
    angle = math.radians(19)
    rotation = np.array(
        [
            [math.cos(angle), -math.sin(angle), 0],
            [math.sin(angle), math.cos(angle), 0],
            [0, 0, 1],
        ]
    )
    basis = rotation @ np.diag([-0.6, 1.5, 3.0])
    affine = np.eye(4)
    affine[:3, :3] = basis
    affine[:3, 3] = (80, -20, 11)
    geometry = Geometry("ZYX", tuple(map(tuple, affine)), "mm", "LPS")
    fixed_source = _source(project, tmp_path / "fixed-3d.bin", b"fixed-3d")
    moving_source = _source(project, tmp_path / "moving-3d.bin", b"moving-3d")
    fixed = _result(project, fixed_source, fixed_values, geometry)
    moving = _result(project, moving_source, moving_values, geometry)
    request = _registration_request(fixed, moving)
    request["outputs"] = request["outputs"][:1]

    preview = execute_registration(workbench, "registration_preview", request)["preview"]

    transform = np.asarray(preview["transform"]["moving_to_fixed"]["homogeneous_matrix"])
    expected_world = basis @ np.array([-4.0, 3.0, -2.0])
    np.testing.assert_allclose(transform[:3, 3], expected_world, atol=0.2)
    assert np.linalg.det(np.asarray(preview["output_grid"]["geometry"]["affine"])[:3, :3]) < 0
    workbench.close()


def test_simpleitk_rigid_route_records_deterministic_runtime(registration_scene) -> None:
    workbench, fixed, _, _, _, _ = registration_scene
    request = _registration_request(fixed, fixed)
    request["method"] = "sitk_rigid"
    request["settings"] = {
        "iterations": 20,
        "learning_rate": 0.25,
        "minimum_step": 0.0001,
        "min_correlation": 0.95,
        "min_overlap": 0.9,
    }
    request["outputs"] = request["outputs"][:1]

    preview_response = execute_registration(workbench, "registration_preview", request)
    preview = preview_response["preview"]

    assert preview["runtime"]["backend"] == "SimpleITK-cpu"
    assert preview["runtime"]["threads"] == 1
    assert preview["settings"]["sampling"] == "all"
    assert preview["quality"]["confidence"] == "accepted"
    np.testing.assert_allclose(
        preview["transform"]["moving_to_fixed"]["homogeneous_matrix"],
        np.eye(4),
        atol=1e-4,
    )
    run = execute_registration(
        workbench,
        "registration_run",
        {
            "preview": preview,
            "preview_sha256": preview_response["preview_sha256"],
        },
    )
    assert run["adopted"] is True


def test_declared_grid_crop_preserves_world_coordinates_and_float_precision(
    registration_scene,
) -> None:
    workbench, _, moving, geometry, _, _ = registration_scene
    request = {
        "parent": {
            "result_id": moving["id"],
            "revision_hash": moving["revision_hash"],
            "array": "image",
        },
        "grid": {"start": [4, 6], "shape": [12, 16], "spacing": [1.0, 0.35]},
        "outputs": _registration_request(moving, moving)["outputs"],
        "working_bytes": 16 * 1024**2,
    }
    request["outputs"].append(
        {
            "array": "counts",
            "output_name": "counts",
            "kind": "scalar",
            "interpolation": "linear",
            "default_value": 0,
        }
    )

    output = execute_registration(workbench, "resample_grid", request)
    child = workbench.project.result(output["result"]["id"])
    result_geometry = geometry_from_dict(child["provenance"]["geometry"])
    scalar = workbench.project.load_array(child["arrays"]["image"])
    labels = workbench.project.load_array(child["arrays"]["labels"])
    counts = workbench.project.load_array(child["arrays"]["counts"])

    np.testing.assert_allclose(
        np.asarray(result_geometry.affine)[:3, 3], geometry.world(np.array([[4, 6]]))[0]
    )
    assert result_geometry.spacing == pytest.approx((1.0, 0.35))
    assert scalar.dtype == np.float64
    assert counts.dtype == np.float64
    assert np.any(counts != np.floor(counts))
    assert set(np.unique(labels)) <= {0, 2**24 + 19}


def test_registration_rejects_stale_bindings_bad_labels_outside_grid_and_cancel(
    registration_scene,
) -> None:
    workbench, fixed, moving, geometry, _, _ = registration_scene
    stale = _registration_request(fixed, moving)
    stale["fixed"]["revision_hash"] = "a" * 64
    with pytest.raises(ValueError, match="stale"):
        execute_registration(workbench, "registration_preview", stale)

    bad_labels = _registration_request(fixed, moving)
    bad_labels["outputs"][1]["interpolation"] = "linear"
    with pytest.raises(ValueError, match="nearest"):
        execute_registration(workbench, "registration_preview", bad_labels)

    incompatible_geometry = Geometry(geometry.axes, geometry.affine, geometry.unit, "RAS")
    incompatible = _result(
        workbench.project,
        workbench.project.source(moving["source_id"]),
        workbench.project.load_array(moving["arrays"]["image"]),
        incompatible_geometry,
    )
    mixed_frame = _registration_request(fixed, incompatible)
    mixed_frame["outputs"] = mixed_frame["outputs"][:1]
    with pytest.raises(ValueError, match="same world frame"):
        execute_registration(workbench, "registration_preview", mixed_frame)

    outside = {
        "parent": {
            "result_id": moving["id"],
            "revision_hash": moving["revision_hash"],
            "array": "image",
        },
        "grid": {"start": [40, 40], "shape": [20, 20], "spacing": [2.0, 0.7]},
        "outputs": [_registration_request(fixed, moving)["outputs"][0]],
        "working_bytes": 16 * 1024**2,
    }
    with pytest.raises(ValueError, match="outside"):
        execute_registration(workbench, "resample_grid", outside)

    calls = 0

    def cancelled() -> None:
        nonlocal calls
        calls += 1
        if calls >= 2:
            raise ValueError("cancelled before publication")

    before = len(workbench.project.list_results())
    with pytest.raises(ValueError, match="cancelled"):
        execute_registration(
            workbench,
            "registration_preview",
            _registration_request(fixed, moving),
            publication_guard=cancelled,
        )
    assert len(workbench.project.list_results()) == before


def test_exact_preview_hash_and_current_source_are_required(registration_scene) -> None:
    workbench, fixed, moving, _, _, _ = registration_scene
    preview = execute_registration(
        workbench, "registration_preview", _registration_request(fixed, moving)
    )
    before = len(workbench.project.list_results())
    with pytest.raises(ValueError, match="exact preview"):
        execute_registration(
            workbench,
            "registration_run",
            {"preview": preview["preview"], "preview_sha256": "b" * 64},
        )
    assert len(workbench.project.list_results()) == before

    source = workbench.project.source(moving["source_id"])
    with Path(source["private_path"]).open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(ValueError, match="changed"):
        execute_registration(
            workbench, "registration_preview", _registration_request(fixed, moving)
        )


@pytest.mark.parametrize("receipt_key", ["preview", "preview_json"])
def test_shared_durable_registration_roi_and_export_use_derived_values(
    registration_scene, tmp_path, receipt_key
):
    from loci_engine.research_export import export_research_result
    from loci_engine.research_jobs import run_job, submit_job

    workbench, fixed, moving, geometry, _, _ = registration_scene
    job = submit_job(
        workbench,
        _registration_request(fixed, moving),
        "registration-preview-shared",
        "registration_preview",
    )
    preview = run_job(workbench, job["id"])
    assert preview["job"]["state"] == "succeeded"
    request = {key: preview[key] for key in (receipt_key, "preview_sha256")}
    job = submit_job(workbench, request, "registration-adoption-shared", "registration_run")
    saved = run_job(workbench, job["id"])["result"]
    binding = {"result_id": saved["id"], "revision_hash": saved["revision_hash"]}
    viewed = workbench.execute("result_view", {"result_id": saved["id"]})
    assert viewed["image"].startswith("data:image/png;base64,")
    assert workbench.execute("correction_info", binding)["derived_measurement_arrays"] == ["image"]
    annotation = workbench.execute(
        "roi_add",
        {
            **binding,
            "roi": {
                "annotation_id": "a" * 32,
                "plane": "XY",
                "index": 0,
                "points": [
                    {"u": 10, "v": 7},
                    {"u": 19, "v": 7},
                    {"u": 19, "v": 14},
                    {"u": 10, "v": 14},
                ],
            },
            "measurement_channels": [0],
        },
    )
    child = workbench.project.result(annotation["result"]["id"])
    record = child["provenance"]["annotations"][0]
    assert record["basis"].startswith("REGISTERED-DERIVED")
    assert set(record["measurements"]) == {"REGISTERED-DERIVED:image"}
    workbench.project.review(child["id"], child["revision_hash"], "reviewed")
    destination = tmp_path / "registered-export"
    export_research_result(workbench.project, child["id"], child["revision_hash"], destination)
    exported = json.loads((destination / "result.json").read_text())
    np.testing.assert_allclose(
        exported["result"]["provenance"]["geometry"]["affine"], geometry.affine
    )
    assert (destination / "annotations.geojson").is_file()
    assert "REGISTERED-DERIVED" in (destination / "methods.md").read_text()


def test_nearest_labels_allow_new_background_but_no_new_object_ids():
    from loci_engine.research_registration import _resample

    labels = np.full((7, 8), 2**24 + 33, np.uint32)
    geometry = Geometry.diagonal((1, 1))
    transform = np.eye(4)
    transform[0, 3] = 2
    moved = _resample(
        labels,
        geometry,
        geometry,
        labels.shape,
        transform,
        labels=True,
        interpolation="nearest",
        default_value=0,
        working_bytes=1024**2,
    )
    assert set(np.unique(moved)) == {0, 2**24 + 33}


def test_registration_budget_preflight_rejects_before_array_materialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = ResearchProject.create(tmp_path / "preflight.loci-study", "Preflight")
    workbench = Workbench(project)
    geometry = Geometry.diagonal((1, 1))
    values = np.zeros((384, 384), dtype=np.float64)
    fixed_source = _source(project, tmp_path / "preflight-fixed.bin", b"fixed")
    moving_source = _source(project, tmp_path / "preflight-moving.bin", b"moving")
    fixed = _result(project, fixed_source, values, geometry)
    moving = _result(project, moving_source, values, geometry)
    request = _registration_request(fixed, moving)
    request["outputs"] = request["outputs"][:1]
    request["working_bytes"] = 1024**2
    calls = 0
    original = project.load_array

    def counted_load(artifact):
        nonlocal calls
        calls += 1
        return original(artifact)

    monkeypatch.setattr(project, "load_array", counted_load)
    with pytest.raises(ValueError, match="working-memory budget"):
        execute_registration(workbench, "registration_preview", request)
    assert calls == 0

    grid_request = {
        "parent": request["moving"],
        "grid": {"start": [0, 0], "shape": [384, 384], "spacing": [1, 1]},
        "outputs": request["outputs"],
        "working_bytes": 1024**2,
    }
    with pytest.raises(ValueError, match="working-memory budget"):
        execute_registration(workbench, "resample_grid", grid_request)
    assert calls == 0
    workbench.close()


def test_resample_grid_preflights_retained_outputs_as_one_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = ResearchProject.create(tmp_path / "aggregate.loci-study", "Aggregate")
    workbench = Workbench(project)
    geometry = Geometry.diagonal((1, 1))
    source = _source(project, tmp_path / "aggregate.bin", b"aggregate")
    parent = _result(project, source, np.zeros((128, 128), dtype=np.uint8), geometry)
    outputs = [
        {
            "array": "image",
            "output_name": "image" if index == 0 else f"copy{index}",
            "kind": "scalar",
            "interpolation": "nearest",
            "default_value": 0,
        }
        for index in range(8)
    ]
    calls = 0
    original = project.load_array

    def counted_load(artifact):
        nonlocal calls
        calls += 1
        return original(artifact)

    monkeypatch.setattr(project, "load_array", counted_load)
    with pytest.raises(ValueError, match="working-memory budget"):
        execute_registration(
            workbench,
            "resample_grid",
            {
                "parent": {
                    "result_id": parent["id"],
                    "revision_hash": parent["revision_hash"],
                    "array": "image",
                },
                "grid": {"start": [0, 0], "shape": [128, 128], "spacing": [1, 1]},
                "outputs": outputs,
                "working_bytes": 1024**2,
            },
        )
    assert calls == 0
    workbench.close()
