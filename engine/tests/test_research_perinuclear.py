import base64
import copy
import csv
import hashlib
import io
import json
import math
import statistics
import zipfile

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine.quantitative import Geometry
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import _zip_info, export_project, import_project
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_perinuclear import (
    measure_rings,
    summary_rows,
    validate_arrays,
    validate_record,
    validate_source,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench

BUDGET = 16 * 1024**2


def oracle(labels, raw, radius):
    """Brute pairwise squared distances, independent of EDT and local bounding boxes."""
    candidates = {}
    for label in np.unique(labels):
        if label:
            points = np.argwhere(labels == label)
            candidates[int(label)] = {
                (y, x)
                for y, x in np.argwhere(labels == 0)
                if min((int(y) - int(yy)) ** 2 + (int(x) - int(xx)) ** 2 for yy, xx in points)
                <= radius**2
            }
    owners = np.zeros(labels.shape, np.uint32)
    ambiguous = np.zeros(labels.shape, np.uint8)
    for y, x in np.argwhere(labels == 0):
        claimed = [label for label, pixels in candidates.items() if (y, x) in pixels]
        if len(claimed) == 1:
            owners[y, x] = claimed[0]
        elif len(claimed) > 1:
            ambiguous[y, x] = 1
    rows = {}
    for label in candidates:
        nuclear = raw[labels == label]
        ring = raw[owners == label]
        touches = bool(
            np.any(labels[0] == label)
            or np.any(labels[-1] == label)
            or np.any(labels[:, 0] == label)
            or np.any(labels[:, -1] == label)
        )
        ring_sum = math.fsum(float(value) for value in ring)
        ring_mean = ring_sum / len(ring) if len(ring) else None
        reasons = ["boundary-touching-nucleus"] if touches else []
        reasons += ["empty-ring"] if not len(ring) else ["zero-mean-ring"] if ring_mean == 0 else []
        nuclear_sum = math.fsum(float(value) for value in nuclear)
        rows[label] = {
            "count": len(ring),
            "sum": ring_sum,
            "mean": ring_mean,
            "nuclear_to_ring_mean_ratio": None
            if reasons
            else nuclear_sum / len(nuclear) / ring_mean,
            "exclusions": reasons,
        }
    return owners, ambiguous, rows


@pytest.mark.parametrize("radius", [1, 2.5, 5])
def test_rings_match_independent_oracle_including_unequal_competition_and_excluded_nuclei(radius):
    labels = np.zeros((11, 13), np.uint32)
    labels[4:6, 4] = 1
    labels[4, 7] = 4_000_000_000  # Sparse IDs must never size an allocation.
    labels[0, 4] = 3
    raw = np.arange(labels.size, dtype=np.uint16).reshape(labels.shape)
    expected, ambiguous, expected_rows = oracle(labels, raw, radius)
    rows, rings, shared, _ = measure_rings(
        labels, raw, Geometry.diagonal((1, 1)), radius, working_bytes=BUDGET
    )
    np.testing.assert_array_equal(rings, expected)
    np.testing.assert_array_equal(shared, ambiguous)
    for row in rows:
        assert row["perinuclear_ring"] == expected_rows[row["label"]]
    if radius == 5:
        assert shared[4, 5] == 1  # Distances differ; nearest-owner allocation would be wrong.
        assert shared[2, 4] == 1  # The excluded edge nucleus still competes.


@pytest.mark.parametrize("mode", ["empty", "zero", "zero-numerator", "no-nuclei"])
def test_undefined_and_low_endpoints_are_explicit_without_epsilon_or_intensity_gate(mode):
    labels = np.zeros((9, 9), np.uint32)
    labels[4, 4] = 1
    raw = np.full(labels.shape, 10, np.uint8)
    if mode == "empty":
        labels[:] = 1
    elif mode == "zero":
        raw[:] = 0
    elif mode == "zero-numerator":
        raw[4, 4] = 0
    else:
        labels[:] = 0
    rows, _, _, _ = measure_rings(labels, raw, Geometry.diagonal((1, 1)), 5, working_bytes=BUDGET)
    summary = summary_rows(rows)
    assert summary["endpoint_defined"] is (mode == "zero-numerator")
    if mode == "zero-numerator":
        assert summary["median_ratio"] == summary["mean_ratio"] == 0
    else:
        assert summary["median_ratio"] is summary["mean_ratio"] is None
    if mode == "empty":
        assert rows[0]["perinuclear_ring"] == {
            "count": 0,
            "sum": 0,
            "mean": None,
            "nuclear_to_ring_mean_ratio": None,
            "exclusions": ["boundary-touching-nucleus", "empty-ring"],
        }
    elif mode == "zero":
        assert rows[0]["perinuclear_ring"]["exclusions"] == ["zero-mean-ring"]


def scene(tmp_path, *, raw_signal=None):
    labels = np.zeros((16, 19), np.uint32)
    labels[5:7, 5:7] = 1
    labels[8, 12] = 2
    labels[0:2, 9] = 3
    raw = (
        np.arange(labels.size, dtype=np.uint16).reshape(labels.shape) + 1
        if raw_signal is None
        else np.asarray(raw_signal)
    )
    channels = np.stack([np.where(labels > 0, 100, 0).astype(np.uint16), raw])
    path = tmp_path / "public-synthetic.tif"
    tifffile.imwrite(path, channels, ome=True, metadata={"axes": "CYX"})
    wb = Workbench(ResearchProject.create(tmp_path / "test-study", "Synthetic rings"))
    source = wb.import_native(str(path))
    selection = wb.selection(
        source["id"],
        {"x": 0, "y": 0, "width": 19, "height": 16, "c": 0, "z": 0, "t": 0, "level": 0},
    )
    _, geometry, _ = wb.load_scalar(source["id"], selection, working_bytes=BUDGET)
    parent = wb.project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": np.zeros(labels.shape, np.float64), "labels": labels},
        provenance={
            "geometry": geometry.to_dict(),
            "selection": selection,
            "measurement_channels": [],
            "measurements": [],
        },
    )
    request = {
        "result_id": parent["id"],
        "revision_hash": parent["revision_hash"],
        "signal_channel": 1,
        "radius_px": 5,
        "working_bytes": BUDGET,
        "control": "Synthetic pixel oracle; ring is a proxy, not cytoplasm",
    }
    return wb, path, source, parent, request, labels, raw


def test_native_persistence_context_export_and_portable_roundtrip_preserve_raw_statistics(tmp_path):
    wb, path, _, parent, request, labels, raw = scene(tmp_path)
    source_bytes = path.read_bytes()
    job = submit_job(wb, request, "measure-rings", "perinuclear_run")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert submit_job(wb, request, "measure-rings", "perinuclear_run")["id"] == job["id"]
    result = wb.project.result(output["result"]["id"])
    assert output["result"]["method_label"] == "Perinuclear enrichment"
    assert output["result"]["perinuclear_nuclei_eligible"] is False
    assert (
        wb.execute("result", {"result_id": parent["id"]})["result"]["perinuclear_nuclei_eligible"]
        is True
    )
    assert output["result"]["perinuclear"] == output["perinuclear"]
    assert result["parent_id"] == parent["id"]
    assert result["provenance"]["nucleus_analysis"]["provenance"]["measurement_channels"] == []
    assert result["arrays"]["labels"] == parent["arrays"]["labels"]
    assert result["provenance"]["selection"] == {**parent["provenance"]["selection"], "c": 1}
    owners, shared, expected_rows = oracle(labels, raw, 5)
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["image"]), raw)
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["ring_labels"]), owners)
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["ring_ambiguous"]), shared)
    ratios = []
    for row in result["provenance"]["measurements"]:
        assert row["perinuclear_ring"] == expected_rows[row["label"]]
        nuclear = row["intensity"]["source_channel_1"]
        assert nuclear["sum"] == math.fsum(raw[labels == row["label"]])
        assert nuclear["mean"] == nuclear["sum"] / row["voxel_count"]
        if not row["perinuclear_ring"]["exclusions"]:
            ratios.append(row["perinuclear_ring"]["nuclear_to_ring_mean_ratio"])
    assert output["summary"]["median_ratio"] == statistics.median(ratios)
    assert output["summary"]["mean_ratio"] == math.fsum(ratios) / len(ratios)
    assert wb.project.review_state(result["id"]) is None
    reopened = Workbench(ResearchProject(wb.project.root))
    assert (
        reopened.execute("result", {"result_id": result["id"]})["result"]["perinuclear"]
        == output["perinuclear"]
    )
    context = reopened.execute(
        "describe_result", {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    )
    assert context["method_label"] == "Perinuclear enrichment"
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "reviewed-export"
    export_research_result(wb.project, result["id"], result["revision_hash"], destination)
    receipt = json.loads((destination / "result.json").read_text())
    assert receipt["result"] == result
    assert "nucleus_analysis" in (destination / "methods.md").read_text()
    assert (
        json.loads((destination / "perinuclear-summary.json").read_text()) == output["perinuclear"]
    )
    exported_rows = list(csv.DictReader(io.StringIO((destination / "objects.csv").read_text())))
    for exported, row in zip(exported_rows, output["measurements"], strict=True):
        assert float(exported["perinuclear_ring:sum"]) == row["perinuclear_ring"]["sum"]
        assert int(exported["perinuclear_ring:count"]) == row["perinuclear_ring"]["count"]
        assert (
            float(exported["intensity:source_channel_1:mean"])
            == row["intensity"]["source_channel_1"]["mean"]
        )
    for name in ("ring_labels", "ring_ambiguous"):
        np.testing.assert_array_equal(
            tifffile.imread(destination / f"{name}.ome.tif"),
            wb.project.load_array(result["arrays"][name]),
        )
    archive = tmp_path / "portable.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "restored")
    assert restored.result(result["id"]) == result
    assert path.read_bytes() == source_bytes


@pytest.mark.parametrize("attack", ["stale", "channel", "radius", "extra", "crop", "budget"])
def test_invalid_inputs_fail_before_publication(tmp_path, attack, monkeypatch):
    wb, _, _, parent, request, *_ = scene(tmp_path)
    if attack == "stale":
        request["revision_hash"] = "f" * 64
    elif attack == "channel":
        request["signal_channel"] = 2
    elif attack == "radius":
        request["radius_px"] = 0
    elif attack == "extra":
        request["epsilon"] = 1e-6
    elif attack == "crop":
        parent = copy.deepcopy(parent)
        parent["provenance"]["selection"]["x"] = 1
        original = wb.project.result
        monkeypatch.setattr(
            wb.project,
            "result",
            lambda identity: parent if identity == parent["id"] else original(identity),
        )
    else:
        request["working_bytes"] = 1024
    with pytest.raises(ValueError):
        wb.execute("perinuclear_run", request)
    assert len(wb.project.list_results()) == 1


@pytest.mark.parametrize("change", ["source", "metadata", "parent-array"])
def test_staging_rechecks_inputs_and_does_not_publish_stale_result(tmp_path, change, monkeypatch):
    wb, path, _, parent, request, *_ = scene(tmp_path)
    original = wb.project.store_array
    calls = 0

    def mutate(array):
        nonlocal calls
        descriptor = original(array)
        calls += 1
        if calls == 1:
            if change == "source":
                path.write_bytes(b"changed")
            elif change == "parent-array":
                artifact = parent["arrays"]["labels"]
                (wb.project.arrays / (artifact["sha256"] + ".npy")).write_bytes(b"changed")
            else:
                metadata = wb.channel_metadata(parent["source_id"])
                channels = copy.deepcopy(metadata["channels"])
                channels[1]["name"] = "changed"
                wb.execute(
                    "channels",
                    {
                        "source_id": parent["source_id"],
                        "channels": channels,
                        "expected_revision": metadata["revision"],
                    },
                )
        return descriptor

    monkeypatch.setattr(wb.project, "store_array", mutate)
    with pytest.raises(ValueError):
        wb.execute("perinuclear_run", request)
    assert len(wb.project.list_results()) == 1


@pytest.mark.parametrize("change", ["summary", "ratio", "empty", "channel", "binding", "artifact"])
def test_internally_forged_but_rehashed_result_is_rejected(tmp_path, change):
    wb, _, _, _, request, *_ = scene(tmp_path)
    output = wb.execute("perinuclear_run", request)
    result = copy.deepcopy(wb.project.result(output["result"]["id"]))
    provenance = result["provenance"]
    if change == "summary":
        provenance["perinuclear"]["summary"]["median_ratio"] = 12
    elif change == "ratio":
        provenance["measurements"][0]["perinuclear_ring"]["nuclear_to_ring_mean_ratio"] = 12
    elif change == "empty":
        provenance["measurements"][0]["perinuclear_ring"]["count"] = 0
    elif change == "channel":
        provenance["measurement_channels"] = [0]
    elif change == "binding":
        provenance["parent_result"]["arrays"]["labels"]["sha256"] = "f" * 64
    else:
        result["arrays"]["ring_labels"]["shape"] = [1, 1]
    with pytest.raises(ValueError):
        validate_record(result)
    result["revision_hash"] = hashlib.sha256(
        canonical_json({k: v for k, v in result.items() if k != "revision_hash"}).encode()
    ).hexdigest()
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(result), result["id"])
        )
    with pytest.raises(ValueError):
        wb.project.result(result["id"])


def test_parent_correction_required_and_new_child_endpoint_starts_unreviewed(tmp_path):
    wb, _, _, _, request, *_ = scene(tmp_path)
    result = wb.execute("perinuclear_run", request)["result"]
    with pytest.raises(ValueError, match="underlying nucleus"):
        wb.execute(
            "correct_result",
            {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "operations": [],
                "working_bytes": BUDGET,
            },
        )


def test_bounded_qc_views_show_exact_saved_masks_and_leave_default_nuclei_unchanged(tmp_path):
    wb, _, _, parent, request, *_ = scene(tmp_path)
    result = wb.execute("perinuclear_run", request)["result"]
    original = wb.result_view({"result_id": result["id"]})
    assert original["label_field"] == "nuclei"
    for field, artifact in (
        ("nuclei", "labels"),
        ("rings", "ring_labels"),
        ("ambiguous", "ring_ambiguous"),
    ):
        view = wb.result_view({"result_id": result["id"], "label_field": field})
        saved = wb.project.load_array(result["arrays"][artifact])
        rgba = np.asarray(
            Image.open(io.BytesIO(base64.b64decode(view["label_image"].split(",", 1)[1])))
        )
        np.testing.assert_array_equal(rgba[..., 3], np.where(saved > 0, 150, 0).astype(np.uint8))
        assert view["label_field"] == field and view["axis"] == "z" and view["index"] == 0
        assert view["revision_hash"] == result["revision_hash"]
        assert view["shape"] == [16, 19]
        if field == "nuclei":
            assert original == view
    for field in ("image", "labels", "../ring_labels"):
        with pytest.raises(ValueError, match="Choose nuclei"):
            wb.result_view({"result_id": result["id"], "label_field": field})
    for request_part in ({"index": 1}, {"index": False}, {"labels": "false"}):
        with pytest.raises(ValueError):
            wb.result_view({"result_id": result["id"], **request_part})
    with pytest.raises(ValueError, match="require a perinuclear"):
        wb.result_view({"result_id": parent["id"], "label_field": "rings"})


def test_export_rejects_self_consistent_rehashed_statistics_that_disagree_with_raw_masks(tmp_path):
    wb, _, _, _, request, *_ = scene(tmp_path)
    result = copy.deepcopy(
        wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    )
    provenance = result["provenance"]
    row = next(
        row for row in provenance["measurements"] if not row["perinuclear_ring"]["exclusions"]
    )
    ring = row["perinuclear_ring"]
    ring["sum"] += ring["count"]
    ring["mean"] = ring["sum"] / ring["count"]
    ring["nuclear_to_ring_mean_ratio"] = row["intensity"]["source_channel_1"]["mean"] / ring["mean"]
    provenance["perinuclear"]["summary"] = summary_rows(provenance["measurements"])
    validate_record(result)  # Consistent metadata alone cannot prove the raw arithmetic.
    result["revision_hash"] = hashlib.sha256(
        canonical_json({k: v for k, v in result.items() if k != "revision_hash"}).encode()
    ).hexdigest()
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(result), result["id"])
        )
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "forged-endpoint"
    with pytest.raises(ValueError, match="raw statistics disagree"):
        export_research_result(wb.project, result["id"], result["revision_hash"], destination)
    assert not destination.exists()
    with pytest.raises(ValueError, match="raw statistics disagree"):
        export_project(wb.project, tmp_path / "forged-study.zip")


@pytest.mark.parametrize("artifact", ["ring_labels", "ring_ambiguous"])
def test_saved_mask_rules_are_verified_from_exact_nuclei_and_radius(tmp_path, artifact):
    wb, _, _, _, request, *_ = scene(tmp_path)
    result = wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    arrays = {name: wb.project.load_array(item).copy() for name, item in result["arrays"].items()}
    location = tuple(np.argwhere(arrays[artifact] > 0)[0])
    arrays[artifact][location] = 0
    with pytest.raises(ValueError, match="declared radius and competition"):
        validate_arrays(result, arrays, parent=wb.project.result(result["parent_id"]))


def _store_rehashed(project, result):
    result["revision_hash"] = hashlib.sha256(
        canonical_json(
            {key: value for key, value in result.items() if key != "revision_hash"}
        ).encode()
    ).hexdigest()
    with project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(result), result["id"])
        )


def _forge_archive(original, destination, result_id, mutate):
    """Rehash both record and archive member: corruption must fail semantically."""
    with zipfile.ZipFile(original) as archive:
        members = {info.filename: archive.read(info) for info in archive.infolist()}
    name = f"results/{result_id}.json"
    record = json.loads(members[name])
    mutate(record)
    record["revision_hash"] = hashlib.sha256(
        canonical_json(
            {key: value for key, value in record.items() if key != "revision_hash"}
        ).encode()
    ).hexdigest()
    members[name] = canonical_json(record).encode()
    manifest = json.loads(members["manifest.json"])
    item = next(item for item in manifest["members"] if item["path"] == name)
    item["sha256"] = hashlib.sha256(members[name]).hexdigest()
    item["size_bytes"] = len(members[name])
    members["manifest.json"] = canonical_json(manifest).encode()
    with zipfile.ZipFile(destination, "w") as archive:
        for name, data in members.items():
            archive.writestr(_zip_info(name), data)


@pytest.mark.parametrize(
    "field,value",
    [
        ("measure", 123456789),
        ("centroid_index", [5.1, 5.1]),
        ("centroid_world_xyz", [999, 999, 999]),
        ("bbox_start", [4, 4]),
        ("principal_rms_radii", [9, 8, 7]),
        ("nearest_centroid_distance", 123),
    ],
)
def test_persisted_native_geometry_must_match_nucleus_pixels_on_export_and_restore(
    tmp_path, field, value
):
    wb, _, _, _, request, *_ = scene(tmp_path)
    result = wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    original = tmp_path / "original.zip"
    export_project(wb.project, original)

    def mutate(record):
        record["provenance"]["measurements"][0][field] = value

    forged = copy.deepcopy(result)
    mutate(forged)
    validate_record(forged)  # Shape/range checks cannot prove native geometry.
    _store_rehashed(wb.project, forged)
    wb.project.review(forged["id"], forged["revision_hash"], "reviewed")
    with pytest.raises(ValueError, match="object geometry disagrees"):
        export_research_result(
            wb.project, forged["id"], forged["revision_hash"], tmp_path / "forged-result"
        )
    with pytest.raises(ValueError, match="object geometry disagrees"):
        export_project(wb.project, tmp_path / "forged-export.zip")
    malformed = tmp_path / "forged-input.zip"
    _forge_archive(original, malformed, result["id"], mutate)
    with pytest.raises(ValueError, match="object geometry disagrees"):
        import_project(malformed, tmp_path / "restored-forged")
    assert not (tmp_path / "restored-forged").exists()


@pytest.mark.parametrize("kind", ["under-minimum", "zero-required", "retained-parent"])
def test_persisted_budget_preflight_rejects_before_any_export_or_restore_decode(
    tmp_path, kind, monkeypatch
):
    import loci_engine.research_interchange as interchange

    wb, _, _, parent, request, *_ = scene(tmp_path)
    if kind == "retained-parent":
        provenance = copy.deepcopy(parent["provenance"])
        provenance["retained_test_note"] = "x" * 80_000
        parent = wb.project.save_result(
            source_id=parent["source_id"],
            kind=parent["kind"],
            arrays={name: wb.project.load_array(item) for name, item in parent["arrays"].items()},
            provenance=provenance,
        )
        request.update(result_id=parent["id"], revision_hash=parent["revision_hash"])
    result = wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    original = tmp_path / "original.zip"
    export_project(wb.project, original)

    def mutate(record):
        guard = record["provenance"]["resource_guard"]
        if kind == "under-minimum":
            guard["working_memory_limit_bytes"] = 65536
        elif kind == "zero-required":
            guard["aggregate_required_bytes"] = 0
        else:
            guard["working_memory_limit_bytes"] = 1024**2
            guard["aggregate_required_bytes"] = math.prod(
                record["arrays"]["labels"]["shape"]
            ) * 192 + 16384 * len(record["provenance"]["measurements"])

    malformed = tmp_path / "budget-input.zip"
    _forge_archive(original, malformed, result["id"], mutate)
    forged = copy.deepcopy(result)
    mutate(forged)
    _store_rehashed(wb.project, forged)
    if kind == "retained-parent":
        wb.project.review(forged["id"], forged["revision_hash"], "reviewed")

    def forbid_decode(*args, **kwargs):
        raise AssertionError("Invalid budget reached artifact decoding")

    monkeypatch.setattr(wb.project, "load_array", forbid_decode)
    monkeypatch.setattr(interchange, "_load_npy_file", forbid_decode)
    with pytest.raises(ValueError, match="working bytes|aggregate"):
        export_research_result(
            wb.project, forged["id"], forged["revision_hash"], tmp_path / "budget-result"
        )
    with pytest.raises(ValueError, match="working bytes|aggregate"):
        export_project(wb.project, tmp_path / "budget-export.zip")
    with pytest.raises(ValueError, match="working bytes|aggregate"):
        import_project(malformed, tmp_path / "budget-restored")
    assert not (tmp_path / "budget-restored").exists()


def test_nonexistent_signal_channel_rejected_before_decode_on_export_and_restore(
    tmp_path, monkeypatch
):
    import loci_engine.research_interchange as interchange

    wb, _, _, _, request, *_ = scene(tmp_path)
    result = wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    original = tmp_path / "source-original.zip"
    export_project(wb.project, original)

    def mutate(record):
        provenance = record["provenance"]
        provenance["perinuclear"]["signal_channel"] = 200
        provenance["measurement_channels"] = [200]
        provenance["selection"]["c"] = 200
        for row in provenance["measurements"]:
            row["intensity"] = {"source_channel_200": row["intensity"]["source_channel_1"]}

    malformed = tmp_path / "source-malformed.zip"
    _forge_archive(original, malformed, result["id"], mutate)
    forged = copy.deepcopy(result)
    mutate(forged)
    validate_record(forged)
    _store_rehashed(wb.project, forged)

    def forbid_decode(*args, **kwargs):
        raise AssertionError("Nonexistent signal channel reached artifact decoding")

    monkeypatch.setattr(wb.project, "load_array", forbid_decode)
    monkeypatch.setattr(interchange, "_load_npy_file", forbid_decode)
    for export in (
        lambda: export_project(wb.project, tmp_path / "source-export.zip"),
        lambda: export_research_result(
            wb.project, forged["id"], forged["revision_hash"], tmp_path / "source-export"
        ),
    ):
        with pytest.raises(ValueError, match="perinuclear c index"):
            export()
    with pytest.raises(ValueError, match="perinuclear c index"):
        import_project(malformed, tmp_path / "source-restored")


@pytest.mark.parametrize("field,value", [("c", 200), ("t", 5), ("z", 5), ("level", 1), ("x", 1)])
def test_source_aware_persisted_selection_bounds_are_explicit(tmp_path, field, value):
    wb, _, source, _, request, *_ = scene(tmp_path)
    result = copy.deepcopy(
        wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    )
    result["provenance"]["selection"][field] = value
    with pytest.raises(ValueError):
        validate_source(result, source)


@pytest.mark.parametrize("location", [(0, 0), (4, 4), (4, 5)])
def test_negative_raw_samples_fail_even_outside_measured_regions_without_modification(location):
    labels = np.zeros((15, 15), np.uint32)
    labels[4, 4] = 1
    raw = np.ones(labels.shape, np.float64)
    raw[location] = -0.25
    before = raw.copy()
    with pytest.raises(ValueError, match="nonnegative raw signal samples"):
        measure_rings(labels, raw, Geometry.diagonal((1, 1)), 2, working_bytes=BUDGET)
    np.testing.assert_array_equal(raw, before)


def test_negative_saved_raw_pixel_rejects_even_when_all_saved_region_statistics_are_nonnegative(
    tmp_path,
):
    wb, _, _, parent, request, *_ = scene(tmp_path)
    result = wb.project.result(wb.execute("perinuclear_run", request)["result"]["id"])
    arrays = {name: wb.project.load_array(item).copy() for name, item in result["arrays"].items()}
    arrays["image"] = arrays["image"].astype(np.float64)
    arrays["image"][0, 0] = -1
    validate_record(result)
    with pytest.raises(ValueError, match="nonnegative raw signal samples"):
        validate_arrays(result, arrays, parent=parent)


def test_nonnegative_float_rounding_is_preserved_without_clipping(tmp_path):
    labels = np.zeros((9, 9), np.uint32)
    labels[4, 3:6] = 1
    raw = np.full(labels.shape, 0.1, np.float64)
    rows, _, _, _ = measure_rings(labels, raw, Geometry.diagonal((1, 1)), 2, working_bytes=BUDGET)
    assert rows[0]["intensity"]["raw_signal"]["sum"] == math.fsum([0.1, 0.1, 0.1])


def test_native_execution_rejects_negative_selected_plane_even_outside_all_masks(tmp_path):
    raw = np.ones((16, 19), np.float64)
    raw[0, 0] = -0.25
    wb, path, _, _, request, *_ = scene(tmp_path, raw_signal=raw)
    original = path.read_bytes()
    with pytest.raises(ValueError, match="nonnegative raw signal samples"):
        wb.execute("perinuclear_run", request)
    assert len(wb.project.list_results()) == 1
    assert path.read_bytes() == original
