import copy
import json

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import measure_objects
from loci_engine.research_data_tables import _metric_value, _metrics
from loci_engine.research_export import export_research_result
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_population import query_population
from loci_engine.research_project import ResearchProject
from loci_engine.research_spatial import validate_arrays, validate_parents
from loci_engine.workbench import Workbench


@pytest.fixture
def spatial(tmp_path):
    path = tmp_path / "spatial.ome.tif"
    image = np.arange(120, dtype=np.uint16).reshape(10, 12)
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 1.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "spatial.loci-study", "Spatial"))
    source = wb.import_native(str(path))
    raw, geometry, selection = wb.load_scalar(source["id"], {"level": 0})
    labels = np.zeros(image.shape, np.uint32)
    labels[3, 3] = 3
    labels[5, 7] = 4_000_000_000
    compartment = np.ones_like(labels)
    boundary = np.zeros_like(labels)
    boundary[:, 1] = 1
    inputs = []
    for mask in (labels, compartment, boundary):
        inputs.append(
            wb.project.save_result(
                source_id=source["id"],
                kind="segmentation",
                arrays={"image": raw, "labels": mask},
                provenance={
                    "geometry": geometry.to_dict(),
                    "selection": selection,
                    "measurements": measure_objects(mask, geometry, {"source_channel_0": raw}),
                },
            )
        )
    bindings = [{"result_id": r["id"], "revision_hash": r["revision_hash"]} for r in inputs]
    request = {
        **bindings[0],
        "compartment": bindings[1],
        "boundary": bindings[2],
        "band_edges": [0, 4, 8, 15],
        "exclude_crop_border": True,
        "control": "Known rectangular technical fixture",
        "boundary_coverage": "Only supplied full-height column; no anatomical interpretation",
        "working_bytes": 16 * 1024**2,
    }
    return wb, request, inputs


def test_durable_spatial_query_export_and_cold_reopen(spatial, tmp_path):
    wb, request, inputs = spatial
    job = submit_job(wb, request, "spatial-fixture", operation="spatial_distance_run")
    output = run_job(wb, job["id"])
    result = output["result"]
    record = wb.project.result(result["id"])
    assert [b["object_count"] for b in output["spatial"]["bands"]] == [1, 1, 0]
    assert [b["area"] for b in output["spatial"]["bands"]] == [100, 80, 60]
    assert [r["spatial"]["distance"] for r in output["measurements"]] == [2, 6]
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    data = query_population(
        record["provenance"]["measurements"], {**binding, "x_metric": "spatial:distance"}, binding
    )
    assert data
    for row in record["provenance"]["measurements"]:
        descriptor = next(d for d in _metrics(row) if d["id"] == "spatial:distance")
        assert _metric_value(row, descriptor) == (row["spatial"]["distance"], "value")
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    dest = tmp_path / "export"
    export_research_result(wb.project, result["id"], result["revision_hash"], dest)
    assert json.loads((dest / "spatial-distance-bands.json").read_text()) == output["spatial"]
    reopened = Workbench(ResearchProject(wb.project.root)).project.result(result["id"])
    assert reopened == record
    arrays = {name: wb.project.load_array(d) for name, d in record["arrays"].items()}
    validate_arrays(record, arrays)
    for role, parent in zip(("objects", "compartment", "boundary"), inputs, strict=True):
        assert (
            record["provenance"]["spatial"]["inputs"][role]["labels_sha256"]
            == parent["arrays"]["labels"]["sha256"]
        )


@pytest.mark.parametrize("role", ["objects", "compartment", "boundary"])
def test_stale_inputs_refused_before_any_publication(spatial, role):
    wb, request, _ = spatial
    target = request if role == "objects" else request[role]
    target["revision_hash"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        wb.execute("spatial_distance_run", request)
    assert len(wb.project.list_results()) == 3


def test_derivative_edit_refused_and_tampered_table_rejected(spatial):
    wb, request, _ = spatial
    result = wb.execute("spatial_distance_run", request)["result"]
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    with pytest.raises(ValueError, match="underlying"):
        wb.execute("correct_result", {**binding, "operations": []})
    saved = wb.project.result(result["id"])
    arrays = {name: wb.project.load_array(d) for name, d in saved["arrays"].items()}
    tampered = copy.deepcopy(saved)
    tampered["provenance"]["spatial"]["bands"][0]["object_count"] = 999
    with pytest.raises(ValueError, match="disagree"):
        validate_arrays(tampered, arrays)


def test_cancellation_guard_blocks_publication(spatial):
    wb, request, _ = spatial

    def revoked():
        raise PermissionError("revoked")

    with pytest.raises(PermissionError, match="revoked"):
        wb.execute("spatial_distance_run", request, publication_guard=revoked)
    assert len(wb.project.list_results()) == 3


@pytest.mark.parametrize("field", ["units", "measure", "intensity", "mask"])
def test_inconsistent_scientific_records_refused_even_with_new_hash(spatial, field):
    wb, request, inputs = spatial
    result = wb.execute("spatial_distance_run", request)["result"]
    record = copy.deepcopy(wb.project.result(result["id"]))
    if field == "units":
        record["provenance"]["spatial"]["distance_unit"] = "mm"
    elif field == "measure":
        record["provenance"]["measurements"][0]["measure"] = 999
    elif field == "intensity":
        record["provenance"]["measurements"][0]["intensity"]["source_channel_0"]["mean"] = 999
    else:
        record["provenance"]["spatial"]["inputs"]["boundary"]["labels_sha256"] = "0" * 64
    with pytest.raises(ValueError):
        validate_parents(record, {r["id"]: r for r in inputs})


@pytest.mark.parametrize("dtype,value", [(np.float32, 0.5), (np.int32, -1)])
def test_invalid_compartment_labels_are_not_silently_thresholded(spatial, dtype, value):
    wb, request, inputs = spatial
    mask = np.ones((10, 12), dtype=dtype)
    mask[0, 0] = value
    replacement = wb.project.save_result(
        source_id=inputs[0]["source_id"],
        kind="external-labels",
        arrays={"image": np.zeros(mask.shape), "labels": mask},
        provenance=inputs[1]["provenance"],
    )
    request["compartment"] = {
        "result_id": replacement["id"],
        "revision_hash": replacement["revision_hash"],
    }
    with pytest.raises(ValueError, match="integer|negative"):
        wb.execute("spatial_distance_run", request)


def test_later_agent_access_traverses_all_mask_dependencies(spatial):
    from loci_engine.agent_study import authorize_result

    wb, request, inputs = spatial
    result = wb.execute("spatial_distance_run", request)["result"]
    visited = []
    original = wb.project.result

    def checked(identity, **kwargs):
        visited.append(identity)
        if identity == inputs[2]["id"]:
            raise PermissionError("boundary grant revoked")
        return original(identity, **kwargs)

    class Grant:
        sha256 = inputs[0]["source_sha256"]
        c = [0]

        def allows(self, selection, channels):
            return True

    class Policy:
        def source_grant(self, project, source_id):
            return Grant()

    wb.project.result = checked
    with pytest.raises(PermissionError, match="boundary grant revoked"):
        authorize_result(Policy(), wb, result["id"])
    assert inputs[2]["id"] in visited


def test_portable_interchange_preserves_spatial_arrays_and_inputs(spatial, tmp_path):
    from loci_engine.research_interchange import export_project, import_project

    wb, request, _ = spatial
    result = wb.execute("spatial_distance_run", request)["result"]
    archive = tmp_path / "spatial.zip"
    export_project(wb.project, archive)
    target = tmp_path / "restored.loci-study"
    import_project(archive, target)
    restored = ResearchProject(target)
    record = restored.result(result["id"])
    assert record == wb.project.result(result["id"])
    validate_arrays(record, {k: restored.load_array(v) for k, v in record["arrays"].items()})


def test_retained_spatial_label_views_match_exact_arrays(spatial):
    import base64
    import io

    from PIL import Image

    wb, request, inputs = spatial
    result = wb.execute("spatial_distance_run", request)["result"]
    record = wb.project.result(result["id"])
    default = wb.result_view({"result_id": result["id"]})
    assert default["label_field"] == "objects"
    for field, array in {
        "objects": "labels",
        "compartment": "compartment_labels",
        "boundary": "boundary_labels",
        "bands": "distance_bands",
    }.items():
        view = wb.result_view({"result_id": result["id"], "label_field": field})
        assert view["revision_hash"] == result["revision_hash"]
        assert view["label_field"] == field and view["label_field_basis"]
        image = np.asarray(
            Image.open(io.BytesIO(base64.b64decode(view["label_image"].split(",")[1])))
        )
        labels = wb.project.load_array(record["arrays"][array])
        np.testing.assert_array_equal(image[..., 3], np.where(labels > 0, 150, 0))
    for field in ("nuclei", "rings", "ambiguous", "unknown", 1):
        with pytest.raises(ValueError, match="label fields"):
            wb.result_view({"result_id": result["id"], "label_field": field})
    with pytest.raises(ValueError, match="Alternative"):
        wb.result_view({"result_id": inputs[0]["id"], "label_field": "boundary"})
