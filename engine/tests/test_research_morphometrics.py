"""Exact-parent native derivative contracts, not biological shape validation."""

import copy
import hashlib
import math
from types import SimpleNamespace

import numpy as np
import pytest
import tifffile

from loci_engine import research_morphometrics as morphology
from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_project import ResearchProject, canonical_json, timestamp
from loci_engine.workbench import Workbench


def rehash(record):
    record.pop("revision_hash", None)
    record["revision_hash"] = hashlib.sha256(canonical_json(record).encode()).hexdigest()
    return record


def binding(record):
    return {
        "result_id": record["id"],
        "revision_hash": record["revision_hash"],
        "working_bytes": 16 * 1024**2,
    }


@pytest.fixture
def make_parent(tmp_path):
    opened = []

    def make(volume=False, calibrated=True, labels=None):
        shape = (5, 8, 10) if volume else (8, 10)
        image = np.arange(math.prod(shape), dtype=np.uint16).reshape(shape)
        metadata = {"axes": "ZYX" if volume else "YX"}
        if calibrated:
            metadata.update(
                PhysicalSizeX=1, PhysicalSizeXUnit="µm", PhysicalSizeY=2, PhysicalSizeYUnit="µm"
            )
            if volume:
                metadata.update(PhysicalSizeZ=3, PhysicalSizeZUnit="µm")
        path = tmp_path / f"source-{len(opened)}.ome.tif"
        tifffile.imwrite(path, image, ome=calibrated, metadata=metadata, photometric="minisblack")
        project = ResearchProject.create(
            tmp_path / f"morph-{len(opened)}.loci-study", "Digital shape"
        )
        wb = Workbench(project)
        opened.append(wb)
        source = wb.import_native(str(path))
        selection = {"level": 0, **({"z": 0, "z_stop": shape[0]} if volume else {})}
        raw, geometry, selection = wb.load_scalar(source["id"], selection)
        if labels is None:
            labels = np.zeros(shape, np.uint32)
            if volume:
                labels[1:3, 2:5, 3:7] = 4_000_000_000
            else:
                labels[2:4, 3:6] = 4_000_000_000
                labels[0, 0] = 17
        parent = project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": raw, "labels": labels},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": selection,
                "measurement_channels": [0],
                "measurement_basis": "Fixture raw channel",
                "measurements": measure_objects(labels, geometry, {"raw": raw}),
            },
        )
        return wb, project.result(parent["id"]), geometry, labels, path

    yield make
    for wb in opened:
        wb.close()


def derived(wb, parent):
    output = morphology.execute_morphometrics(wb, binding(parent))
    return output, wb.project.result(output["result"]["id"])


def test_anisotropic_derivative_keeps_raw_rows_arrays_rms_and_unreviewed_state(make_parent):
    wb, parent, geometry, labels, _ = make_parent()
    wb.project.review(parent["id"], parent["revision_hash"], "reviewed")
    before = copy.deepcopy(parent)
    artifacts = {p.name for p in wb.project.arrays.iterdir()}
    output, result = derived(wb, parent)
    assert result["kind"] == morphology.KIND and result["parent_id"] == parent["id"]
    assert result["arrays"] == parent["arrays"]
    assert {p.name for p in wb.project.arrays.iterdir()} == artifacts
    assert wb.project.result(parent["id"]) == before
    assert wb.project.review_state(result["id"]) is None
    assert output["total_measurements"] == 2
    for row, original in zip(
        result["provenance"]["measurements"], parent["provenance"]["measurements"], strict=True
    ):
        assert {k: v for k, v in row.items() if k != "morphometrics"} == original
        assert row["principal_rms_radii"] == original["principal_rms_radii"]
    row = next(r for r in output["measurements"] if r["label"] == 4_000_000_000)
    metrics = row["morphometrics"]
    assert metrics["pixel_union_area"] == 12 and metrics["perimeter"] == 14
    assert metrics["circularity"] == pytest.approx(12 * math.pi / 49)
    assert metrics["eccentricity"] == pytest.approx(math.sqrt(1 / 3))
    assert metrics["elongation"] == pytest.approx(math.sqrt(3 / 2))
    assert metrics["exposed_face_counts"] == [6, 4]
    assert metrics["touches_crop_border"] is False
    singleton = next(r for r in output["measurements"] if r["label"] == 17)["morphometrics"]
    assert singleton["eccentricity"] is singleton["elongation"] is None
    assert singleton["undefined_reasons"]["elongation"] == "zero-major-center-moment"
    assert singleton["touches_crop_border"] is True
    morphology.validate_parents(result, {parent["id"]: parent})
    morphology.validate_source(result, wb.project.source(parent["source_id"]))
    arrays = {k: wb.project.load_array(v) for k, v in result["arrays"].items()}
    assert all(not a.flags.writeable for a in arrays.values())
    morphology.validate_arrays(result, arrays)
    assert np.array_equal(arrays["labels"], labels)
    reopened = ResearchProject(wb.project.root).result(result["id"])
    assert reopened == result
    values = morphology.metric_values(row, geometry)
    assert values["morphometrics:perimeter"] == 14
    assert {d["id"] for d in morphology.metric_descriptors(geometry)} == set(values)
    assert output["morphometrics"]["calibration_status"] == "declared-physical-calibration"


def test_volume_surface_is_voxel_union_not_mesh_and_original_rms_is_preserved(make_parent):
    wb, parent, geometry, _, _ = make_parent(volume=True)
    output, result = derived(wb, parent)
    row = output["measurements"][0]
    metrics = row["morphometrics"]
    assert metrics["voxel_union_volume"] == 144
    assert metrics["surface_area"] == 168
    assert metrics["sphericity"] == pytest.approx((36 * math.pi) ** (1 / 3) * 144 ** (2 / 3) / 168)
    assert metrics["eccentricity"] is None
    assert metrics["undefined_reasons"]["eccentricity"] == "requires-2d"
    assert (
        row["principal_rms_radii"] == parent["provenance"]["measurements"][0]["principal_rms_radii"]
    )
    assert {d["id"] for d in morphology.metric_descriptors(geometry)} == {
        "morphometrics:voxel_union_volume",
        "morphometrics:surface_area",
        "morphometrics:sphericity",
    }
    morphology.validate_arrays(
        result, {k: wb.project.load_array(v) for k, v in result["arrays"].items()}
    )


def test_pixel_units_empty_foreground_and_linear_degenerate_endpoint(make_parent):
    labels = np.zeros((8, 10), np.uint32)
    labels[2, 2:6] = 65537
    wb, parent, geometry, _, _ = make_parent(calibrated=False, labels=labels)
    output, result = derived(wb, parent)
    row = output["measurements"][0]
    assert output["morphometrics"]["calibration_status"] == "uncalibrated-pixel-geometry"
    assert output["morphometrics"]["units"]["perimeter"] == "pixel"
    assert row["morphometrics"]["eccentricity"] == 1
    assert morphology.metric_values(row, geometry)["morphometrics:elongation"] is None
    morphology.validate_parents(result, {parent["id"]: parent})
    wb, parent, _, _, _ = make_parent(labels=np.zeros((8, 10), np.uint32))
    output, result = derived(wb, parent)
    assert output["measurements"] == [] and output["total_measurements"] == 0
    morphology.validate_record(result)


def test_native_job_publication_is_atomic_and_names_its_own_job(make_parent):
    wb, parent, _, _, _ = make_parent()
    request = binding(parent)
    normalized = {"source_id": parent["source_id"], "task_request": request}
    job = wb.project.submit("morphometrics_run", normalized, "own-morph-job")
    wb.project.update_job(
        job["id"], expected_state="queued", state="running", started_at=timestamp()
    )
    output = morphology.execute_morphometrics(wb, request, job_id=job["id"])
    result = wb.project.result(output["result"]["id"])
    job = wb.project.job(job["id"])
    assert job["state"] == "succeeded" and job["result_ids"] == [result["id"]]
    assert result["provenance"]["job_id"] == job["id"]
    assert "job_id" not in parent["provenance"]
    with pytest.raises(ValueError, match="own exact running"):
        morphology.execute_morphometrics(wb, request, job_id=job["id"])
    assert len(wb.project.list_results()) == 2


def test_correction_ancestry_is_pinned_without_copying_parent_population_twice(make_parent):
    wb, parent, _, _, _ = make_parent()
    info = wb.execute(
        "correction_info", {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    )
    edited = wb.execute(
        "correct_result",
        {
            **binding(parent),
            "operations": [
                {"op": "delete", "label": 17, "expected_input_sha256": info["label_sha256"]}
            ],
        },
    )["result"]
    corrected = wb.project.result(edited["id"])
    _, result = derived(wb, corrected)
    assert result["provenance"]["morphometrics"]["parent_chain"] == [
        {"result_id": corrected["id"], "revision_hash": corrected["revision_hash"]},
        {"result_id": parent["id"], "revision_hash": parent["revision_hash"]},
    ]
    assert "object_analysis" not in result["provenance"]
    morphology.validate_parents(result, {r["id"]: r for r in (corrected, parent)})
    with pytest.raises(ValueError, match="missing or stale"):
        morphology.validate_parents(result, {corrected["id"]: corrected})


@pytest.mark.parametrize(
    "mutation",
    [
        "revision",
        "source",
        "calibration",
        "selection",
        "kind",
        "derived",
        "dtype",
        "raw_nonfinite",
        "duplicate_labels",
        "budget",
    ],
)
def test_invalid_parent_or_budget_refused_before_array_decode(make_parent, monkeypatch, mutation):
    wb, parent, _, _, _ = make_parent()
    bad = copy.deepcopy(parent)
    request = binding(parent)
    if mutation == "revision":
        request["revision_hash"] = "0" * 64
    elif mutation == "source":
        bad["source_sha256"] = "0" * 64
    elif mutation == "calibration":
        bad["provenance"]["geometry"]["affine"][0][0] = 10
    elif mutation == "selection":
        bad["provenance"]["selection"]["x"] = 99
    elif mutation == "kind":
        bad["kind"] = "nucleus-cell-association"
    elif mutation == "derived":
        bad["provenance"]["spatial"] = {}
    elif mutation == "dtype":
        bad["arrays"]["labels"]["dtype"] = "float32"
    elif mutation == "raw_nonfinite":
        bad["provenance"]["measurements"][0]["intensity"]["raw"]["mean"] = float("nan")
    elif mutation == "duplicate_labels":
        bad["provenance"]["measurements"].append(
            copy.deepcopy(bad["provenance"]["measurements"][0])
        )
    else:
        request["working_bytes"] = 1024**2
        bad["provenance"]["measurements"][0]["benign_large_context"] = "x" * 100000
    if mutation != "raw_nonfinite":
        rehash(bad)
        if mutation != "revision":
            request["revision_hash"] = bad["revision_hash"]
    original = wb.project.result
    monkeypatch.setattr(
        wb.project,
        "result",
        lambda identity, **kw: bad if identity == bad["id"] else original(identity, **kw),
    )
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Decoded invalid parent"))
    with pytest.raises(ValueError):
        morphology.execute_morphometrics(wb, request)
    assert len(wb.project.list_results()) == 1


@pytest.mark.parametrize(
    "field",
    [
        "perimeter",
        "units",
        "rules",
        "reason",
        "count",
        "raw",
        "rms",
        "array_hash",
        "ancestor",
        "resource",
    ],
)
def test_persisted_tampering_refused_even_with_recomputed_revision(make_parent, field):
    wb, parent, _, _, _ = make_parent()
    _, result = derived(wb, parent)
    bad = copy.deepcopy(result)
    p, contract = bad["provenance"], bad["provenance"]["morphometrics"]
    if field == "perimeter":
        p["measurements"][0]["morphometrics"]["perimeter"] += 1
    elif field == "units":
        contract["units"]["perimeter"] = "mm"
    elif field == "rules":
        contract["rules"]["boundary"] = "display mesh"
    elif field == "reason":
        p["measurements"][0]["morphometrics"]["undefined_reasons"] = {}
    elif field == "count":
        contract["object_count"] += 1
    elif field == "raw":
        p["measurements"][0]["intensity"]["raw"]["mean"] += 1
    elif field == "rms":
        p["measurements"][0]["principal_rms_radii"][0] += 1
    elif field == "array_hash":
        bad["arrays"]["image"]["sha256"] = "0" * 64
    elif field == "ancestor":
        contract["parent_chain"][0]["revision_hash"] = "0" * 64
    else:
        contract["resource_estimate"]["working_bytes"] = 1024
    rehash(bad)
    with pytest.raises(ValueError):
        morphology.validate_parents(bad, {parent["id"]: parent})


def test_artifact_bytes_changed_before_decode_or_before_publication_fail_closed(
    make_parent, monkeypatch
):
    wb, parent, _, _, _ = make_parent()
    descriptor = parent["arrays"]["labels"]
    path = wb.project.arrays / (descriptor["sha256"] + ".npy")
    original = path.read_bytes()
    path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    with pytest.raises(ValueError, match="hash|verification"):
        morphology.execute_morphometrics(wb, binding(parent))
    path.write_bytes(original)
    kernel = morphology.measure_morphometrics

    def mutate_after(*args, **kwargs):
        result = kernel(*args, **kwargs)
        path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        return result

    monkeypatch.setattr(morphology, "measure_morphometrics", mutate_after)
    with pytest.raises(ValueError, match="hash|verification"):
        morphology.execute_morphometrics(wb, binding(parent))
    assert len(wb.project.list_results()) == 1


@pytest.mark.parametrize("stage", ["preflight", "kernel", "atomic"])
def test_cancellation_never_publishes_partial_derivative(make_parent, monkeypatch, stage):
    wb, parent, _, _, _ = make_parent()
    before = copy.deepcopy(parent)
    if stage == "atomic":
        save = wb.project.save_result

        def cancel_in_transaction(**kwargs):
            guard = kwargs["publication_guard"]

            def revoked():
                guard()
                raise PermissionError("cancelled during atomic publication")

            return save(**{**kwargs, "publication_guard": revoked})

        monkeypatch.setattr(wb.project, "save_result", cancel_in_transaction)

    def check():
        if stage == "preflight":
            raise PermissionError("cancelled before decode")

    if stage == "kernel":
        kernel = morphology.measure_morphometrics

        def cancelled(*args, **kwargs):
            def abort():
                raise PermissionError("cancelled during kernel")

            return kernel(*args, **{**kwargs, "check": abort})

        monkeypatch.setattr(morphology, "measure_morphometrics", cancelled)
    with pytest.raises(PermissionError, match="cancelled"):
        morphology.execute_morphometrics(wb, binding(parent), publication_guard=check)
    assert wb.project.result(parent["id"]) == before
    assert len(wb.project.list_results()) == 1


def test_exact_result_bytes_and_new_endpoint_reproduction_are_independently_checked(make_parent):
    wb, parent, _, _, _ = make_parent()
    _, result = derived(wb, parent)
    arrays = {k: wb.project.load_array(v) for k, v in result["arrays"].items()}
    changed = {**arrays, "image": arrays["image"].copy()}
    changed["image"][0, 0] += 1
    with pytest.raises(ValueError, match="hash"):
        morphology.validate_arrays(result, changed)
    bad = copy.deepcopy(result)
    # Alter both moments/ratios consistently: metadata arithmetic passes, pixels do not.
    row = next(r for r in bad["provenance"]["measurements"] if r["label"] == 4_000_000_000)[
        "morphometrics"
    ]
    row["center_covariance_eigenvalues"] = [4.0, 1.0]
    row["eccentricity"], row["elongation"] = math.sqrt(3 / 4), 2.0
    rehash(bad)
    morphology.validate_record(bad)
    with pytest.raises(ValueError, match="endpoints disagree"):
        morphology.validate_arrays(bad, arrays)


@pytest.mark.parametrize("volume", [False, True])
def test_sheared_medical_crop_affine_is_validated_without_array_decode(volume):
    matrix = np.array([[1, 0.5, 0, 100], [0, 2, 0.25, -30], [0, 0, 3, 9], [0, 0, 0, 1]], float)
    full = Geometry("ZYX", tuple(map(tuple, matrix)), "mm", "LPS")
    selected = {"x": 4, "y": 3, "width": 10, "height": 8, "z": 2, "t": 0, "c": 0, "level": 0}
    cropped = full.cropped((2, 3, 4))
    if volume:
        selected["z_stop"] = 7
    else:
        cropped = Geometry("YX", cropped.affine, "mm", "LPS")
    source = {
        "id": "a" * 32,
        "sha256": "b" * 64,
        "source_kind": "medical",
        "metadata": {"shape": [20, 30, 40], "geometry": full.to_dict()},
    }
    record = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "provenance": {"selection": selected, "geometry": cropped.to_dict()},
    }
    workbench = SimpleNamespace(
        project=SimpleNamespace(source=lambda *args, **kw: source),
        selection=lambda identity, value: value,
    )
    assert morphology._source_geometry(workbench, record) == source
    assert cropped.affine[0][3] == 105.5
    bad = copy.deepcopy(record)
    bad["provenance"]["geometry"] = full.to_dict()
    with pytest.raises(ValueError, match="affine/calibration"):
        morphology._source_geometry(workbench, bad)


def test_derivative_is_not_an_eligible_recursive_input(make_parent, monkeypatch):
    wb, parent, _, _, _ = make_parent()
    _, result = derived(wb, parent)
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Decoded derivative"))
    with pytest.raises(ValueError, match="derived measurement"):
        morphology.execute_morphometrics(wb, binding(result))
    assert morphology.CORRECTION_REFUSAL


def test_parent_record_change_after_computation_blocks_publication(make_parent, monkeypatch):
    wb, parent, _, _, _ = make_parent()
    original, kernel = wb.project.result, morphology.measure_morphometrics
    changed = False
    bad = copy.deepcopy(parent)
    bad["provenance"]["measurements"][0]["intensity"]["raw"]["mean"] += 1
    rehash(bad)

    def resolved(identity, **kwargs):
        return bad if changed and identity == parent["id"] else original(identity, **kwargs)

    def mutate_after(*args, **kwargs):
        nonlocal changed
        result = kernel(*args, **kwargs)
        changed = True
        return result

    monkeypatch.setattr(wb.project, "result", resolved)
    monkeypatch.setattr(morphology, "measure_morphometrics", mutate_after)
    with pytest.raises(ValueError, match="parent changed"):
        morphology.execute_morphometrics(wb, binding(parent))
    assert len(wb.project.list_results()) == 1
