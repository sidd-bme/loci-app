"""Retained XYZ kinematics, exact observation provenance and legacy no-write reads."""

import copy
import csv
import hashlib
import json
import math
from dataclasses import replace

import numpy as np
import pytest
import test_research_temporal as temporal_fixtures
import tifffile
from test_research_interchange import _rewrite

from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_temporal import (
    PAGE_BYTES,
    _graph_from_record,
    _graph_record,
    project_inputs,
    validate_inputs,
    validate_registration_arrays,
)
from loci_engine.temporal_metrics import measure_trajectories
from loci_engine.workbench import Workbench


@pytest.fixture
def scene(tmp_path):
    opened = []

    def make(stationary=False):
        image = np.zeros((3, 7, 8, 10), np.uint16)
        indices = [(1, 1, 1)] * 3 if stationary else [(1, 1, 1), (1, 3, 4), (5, 3, 4)]
        for t, point in enumerate(indices):
            image[(t, *point)] = 100 + t * 10
        path = tmp_path / f"xyz-{len(opened)}.ome.tif"
        tifffile.imwrite(
            path,
            image,
            ome=True,
            photometric="minisblack",
            metadata={
                "axes": "TZYX",
                "PhysicalSizeX": 1,
                "PhysicalSizeY": 2,
                "PhysicalSizeZ": 3,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeYUnit": "µm",
                "PhysicalSizeZUnit": "µm",
            },
        )
        wb = Workbench(ResearchProject.create(tmp_path / f"xyz-{len(opened)}.loci-study", "XYZ"))
        opened.append(wb)
        source = wb.import_native(str(path))
        originals = []
        for t in range(3):
            result = wb.execute(
                "run_recipe",
                {
                    "source_id": source["id"],
                    "selection": {"t": t, "z": 0, "z_stop": 7},
                    "recipe": {
                        "segmentation": {"method": "components", "threshold": 50},
                        "measurement_channels": [0],
                    },
                },
            )["result"]
            originals.append(wb.project.result(result["id"]))
        request = {
            "frames": [
                {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "time_s": time,
                }
                for result, time in zip(originals, [0, 2, 8], strict=True)
            ],
            "time_declaration": "Generated acquisition log: actual seconds 0, 2 and 8",
            "max_distance": 20,
            "max_gap_frames": 0,
            "ambiguity_distance": 0,
        }
        return wb, originals, request, path

    yield make
    for wb in opened:
        wb.close()


@pytest.fixture
def registered_observations(tmp_path):
    yield from temporal_fixtures.observations.__wrapped__(tmp_path)


def bound(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def publish(wb, request):
    output = wb.execute("track_results", request)
    return wb.project.result(output["result"]["id"])


def page(wb, result, table, **kwargs):
    return wb.execute(
        "tracking_result", {**bound(result), "table": table, "offset": 0, "limit": 100, **kwargs}
    )


def rewrite(project, result):
    result.pop("revision_hash", None)
    result["revision_hash"] = hashlib.sha256(canonical_json(result).encode()).hexdigest()
    with project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(result), result["id"])
        )
    return result


def test_native_independent_xyz_time_weighted_speed_and_exact_raw_inputs(scene):
    wb, originals, request, path = scene()
    before = path.read_bytes()
    result = publish(wb, request)
    metrics = result["provenance"]["trajectory_metrics"]
    assert metrics["units"] == {
        "position": "um",
        "time": "s",
        "velocity": "um/s",
        "directionality": "dimensionless",
    }
    track = metrics["tracks"][0]
    assert track["net_displacement_xyz"] == [3, 4, 12]
    assert track["net_displacement"] == 13 and track["observed_path_length"] == 17
    assert track["mean_velocity_xyz"] == [3 / 8, 4 / 8, 12 / 8]
    assert track["mean_speed"] == 17 / 8 and track["mean_speed"] != (2.5 + 2) / 2
    assert track["directionality_ratio"] == 13 / 17
    assert [r["velocity_xyz"] for r in metrics["intervals"]] == [[1.5, 2, 0], [0, 0, 2]]
    read = wb.execute("tracking_result", bound(result))
    assert read["trajectory_metrics"]["storage"] == "persisted"
    assert "intervals" not in read["trajectory_metrics"]
    assert read["trajectory_metrics"]["interval_count"] == 2
    assert path.read_bytes() == before
    for original, binding in zip(originals, read["inputs"], strict=True):
        assert wb.project.result(original["id"]) == original
        assert binding["raw_object_measurements"] == original["provenance"]["measurements"]
    assert wb.project.review_state(result["id"]) is None


def test_paged_queries_bind_revision_and_graph_and_never_decode_arrays(scene, monkeypatch):
    wb, _, request, _ = scene()
    result = publish(wb, request)
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Query decoded image"))
    first = page(wb, result, "intervals", limit=1)
    assert len(canonical_json(first).encode()) <= PAGE_BYTES
    assert first["result_id"] == result["id"] and first["next_offset"] == 1
    assert (
        first["summary"]["graph_sha256"]
        == result["provenance"]["trajectory_metrics"]["graph_sha256"]
    )
    assert first["rows"][0]["velocity_xyz"] == [1.5, 2, 0]
    last = page(wb, result, "intervals", offset=first["next_offset"], limit=1)
    assert last["rows"][0]["velocity_xyz"] == [0, 0, 2] and last["next_offset"] is None
    for extra in ({"table": "unknown"}, {"limit": 101}, {"revision_hash": "f" * 64}):
        with pytest.raises(ValueError):
            wb.execute("tracking_result", {**bound(result), "table": "tracks", **extra})


def test_gaps_are_chords_not_interpolation_and_stationary_directionality_is_undefined(scene):
    wb, _, request, _ = scene()
    spec = copy.deepcopy(request)
    spec["frames"][1] = {
        "frame_id": "missing-slot",
        "time_s": 2,
        "missing_reason": "No observation acquired",
    }
    spec["max_gap_frames"] = 1
    result = publish(wb, spec)
    row = page(wb, result, "intervals")["rows"][0]
    assert row["gap_frames"] == 1 and row["velocity_xyz"] == [3 / 8, 4 / 8, 12 / 8]
    assert row["sampling"] == "gap-spanning-observed-endpoints"
    assert page(wb, result, "tracks")["rows"][0]["mean_speed"] == 13 / 8
    wb, _, request, _ = scene(stationary=True)
    result = publish(wb, request)
    row = page(wb, result, "tracks")["rows"][0]
    assert row["mean_speed"] == 0 and row["mean_velocity_xyz"] == [0, 0, 0]
    assert row["directionality_ratio"] is None and row["directionality_status"] == "stationary"


def edit(edge, operation, uncertain=None):
    request = {
        "op": operation,
        **{
            key: edge[key]
            for key in ("source_frame_id", "source_label", "target_frame_id", "target_label")
        },
    }
    if uncertain is not None:
        request["identity_uncertain"] = uncertain
    return request


def test_corrections_recompute_metrics_keep_parent_and_preserve_identity_uncertainty(scene):
    wb, _, request, _ = scene()
    parent = publish(wb, request)
    edges = parent["provenance"]["tracking"]["edges"]
    removed = wb.execute("correct_tracks", {**bound(parent), "changes": [edit(edges[0], "remove")]})
    child = wb.project.result(removed["result"]["id"])
    tracks = page(wb, child, "tracks")["rows"]
    assert len(tracks) == 2
    singleton = next(row for row in tracks if row["interval_count"] == 0)
    assert singleton["mean_speed"] is singleton["mean_velocity_xyz"] is None
    assert singleton["directionality_status"] == "single-observation"
    linked = wb.execute(
        "correct_tracks", {**bound(child), "changes": [edit(edges[0], "add", True)]}
    )
    result = wb.project.result(linked["result"]["id"])
    track = page(wb, result, "tracks")["rows"][0]
    assert track["mean_speed"] == 17 / 8 and track["uncertain_edge_count"] == 1
    assert any(
        row["identity_uncertain"] and row["association_provenance"] == "manual"
        for row in page(wb, result, "intervals")["rows"]
    )
    assert result["provenance"]["temporal_inputs"] == parent["provenance"]["temporal_inputs"]
    assert wb.project.result(parent["id"]) == parent
    assert wb.project.review_state(result["id"]) is None


@pytest.mark.parametrize("change", ["metrics", "unit", "raw", "time"])
def test_rehashed_tampering_fails_on_persisted_read_and_export(scene, tmp_path, change):
    wb, _, request, _ = scene()
    result = publish(wb, request)
    bad = copy.deepcopy(result)
    p = bad["provenance"]
    if change == "metrics":
        p["trajectory_metrics"]["tracks"][0]["mean_speed"] += 1
    elif change == "unit":
        p["trajectory_units"]["time"] = "frame"
    elif change == "raw":
        p["temporal_inputs"][1]["raw_object_measurements"][0]["measure"] += 1
    else:
        p["temporal_inputs"][1]["time_s"] = 3
    rewrite(wb.project, bad)
    with pytest.raises(ValueError):
        wb.project.result(result["id"])
    with pytest.raises(ValueError):
        export_project(wb.project, tmp_path / "refused.zip")
    assert not (tmp_path / "refused.zip").exists()


def test_legacy_reads_derive_without_rewrite_and_export_adds_xyz_tables(scene, tmp_path):
    wb, _, request, _ = scene()
    legacy = publish(wb, request)
    legacy["provenance"].pop("trajectory_metrics")
    rewrite(wb.project, legacy)
    before = canonical_json(wb.project.result(legacy["id"]))
    reopened = Workbench(ResearchProject(wb.project.root))
    read = reopened.execute("tracking_result", bound(legacy))
    assert read["trajectory_metrics"]["storage"] == "derived-from-legacy-graph"
    assert read["trajectory_metrics"]["track_count"] == 1
    assert page(reopened, legacy, "tracks")["rows"][0]["mean_speed"] == 17 / 8
    wb.project.review(legacy["id"], legacy["revision_hash"], "reviewed")
    destination = tmp_path / "legacy-tracks"
    export_research_result(wb.project, legacy["id"], legacy["revision_hash"], destination)
    exported = json.loads((destination / "tracking.json").read_text())
    assert exported["tracking"] == legacy["provenance"]["tracking"]
    assert exported["trajectory_metrics"]["tracks"][0]["directionality_ratio"] == 13 / 17
    with (destination / "track-summaries.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert float(rows[0]["mean_velocity_z"]) == 12 / 8
    assert float(rows[0]["mean_speed"]) == 17 / 8 and rows[0]["velocity_unit"] == "um/s"
    with (destination / "track-intervals.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert [float(row["velocity_z"]) for row in rows] == [0, 2]
    assert canonical_json(wb.project.result(legacy["id"])) == before
    assert "directionality" in (destination / "methods.md").read_text()
    reopened.close()


@pytest.mark.parametrize("matching_registration", [False, True])
def test_self_consistent_altered_graph_and_metrics_still_fail_original_observation_binding(
    scene, matching_registration
):
    wb, _, request, _ = scene()
    bad = publish(wb, request)
    graph = _graph_from_record(bad["provenance"]["tracking"])
    frames = list(graph.frames)
    detection = frames[1].detections[0]
    position = list(detection.centroid_world_xyz)
    position[0] += 0.25
    frames[1] = replace(
        frames[1], detections=(replace(detection, centroid_world_xyz=tuple(position)),)
    )
    nodes = {
        (frame.frame_id, d.label): d.centroid_world_xyz
        for frame in frames
        for d in frame.detections
    }
    edges = tuple(
        replace(
            edge,
            cost=math.dist(
                nodes[(edge.source_frame_id, edge.source_label)],
                nodes[(edge.target_frame_id, edge.target_label)],
            ),
        )
        for edge in graph.edges
    )
    forged = replace(graph, frames=tuple(frames), edges=edges)
    bad["provenance"]["tracking"] = _graph_record(forged)
    bad["provenance"]["trajectory_metrics"] = measure_trajectories(forged, "um")
    if matching_registration:
        # A self-consistent coordinate shift is still forbidden when the
        # retained method explicitly states there is no registration.
        bad["provenance"]["temporal_inputs"][1]["registration"] = {
            "moving_to_reference_shift_index": [0, 0, 0.25],
            "moving_to_reference_shift_world": [0.25, 0, 0],
        }
    rewrite(wb.project, bad)
    with pytest.raises(ValueError, match="original observations|method none forbids"):
        wb.project.result(bad["id"])


@pytest.mark.parametrize("legacy", [False, True])
def test_automatic_graph_cannot_drop_edge_without_correction_ledger(scene, legacy):
    wb, _, request, _ = scene()
    bad = publish(wb, request)
    graph = _graph_from_record(bad["provenance"]["tracking"])
    forged = replace(graph, edges=graph.edges[1:])
    bad["provenance"]["tracking"] = _graph_record(forged)
    if legacy:
        bad["provenance"].pop("trajectory_metrics")
        bad["provenance"]["tracking_settings"].pop("working_bytes", None)
    else:
        bad["provenance"]["trajectory_metrics"] = measure_trajectories(forged, "um")
    rewrite(wb.project, bad)
    with pytest.raises(ValueError, match="automatic tracking"):
        wb.project.result(bad["id"])


def forged_translation(result):
    bad = copy.deepcopy(result)
    graph = _graph_from_record(bad["provenance"]["tracking"])
    frames = list(graph.frames)
    frames[1] = replace(
        frames[1],
        detections=tuple(
            replace(
                d, centroid_world_xyz=(d.centroid_world_xyz[0] + 0.25, *d.centroid_world_xyz[1:])
            )
            for d in frames[1].detections
        ),
    )
    nodes = {
        (frame.frame_id, d.label): d.centroid_world_xyz
        for frame in frames
        for d in frame.detections
    }
    edges = tuple(
        replace(
            edge,
            cost=math.dist(
                nodes[(edge.source_frame_id, edge.source_label)],
                nodes[(edge.target_frame_id, edge.target_label)],
            ),
        )
        for edge in graph.edges
    )
    forged = replace(graph, frames=tuple(frames), edges=edges)
    bad["provenance"]["tracking"] = _graph_record(forged)
    bad["provenance"]["trajectory_metrics"] = measure_trajectories(forged, "um")
    registration = bad["provenance"]["temporal_inputs"][1]["registration"]
    registration["moving_to_reference_shift_index"][1] += 0.5
    registration["moving_to_reference_shift_world"][0] += 0.25
    return bad


def test_translation_replay_requires_authoritative_original_images(
    registered_observations, monkeypatch
):
    wb, path, originals = registered_observations
    before = path.read_bytes()
    spec = {
        **temporal_fixtures.request(originals),
        "registration": {"method": "translation", "upsample_factor": 1},
    }
    good = publish(wb, spec)
    records = {record["id"]: record for record in originals}
    validate_registration_arrays(good, records, array_loader=wb.project.load_array)
    bad = forged_translation(good)
    # Metadata authority/preflight does not touch any source pixels. It is a
    # necessary structural check, not acceptance of an image-derived estimate.
    with monkeypatch.context() as patch:
        patch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Preflight decoded pixels"))
        validate_inputs(bad, records)
        project_inputs(wb.project, bad, verify_arrays=False)
    with pytest.raises(ValueError, match="exact original images"):
        validate_registration_arrays(bad, records, array_loader=wb.project.load_array)
    rewrite(wb.project, bad)
    with pytest.raises(ValueError, match="exact original images"):
        wb.project.result(bad["id"])
    assert path.read_bytes() == before
    assert all(wb.project.result(record["id"]) == record for record in originals)


def test_valid_legacy_translation_is_read_without_rewriting(registered_observations):
    wb, _, originals = registered_observations
    result = publish(
        wb,
        {
            **temporal_fixtures.request(originals),
            "registration": {"method": "translation", "upsample_factor": 1},
        },
    )
    result["provenance"].pop("trajectory_metrics")
    result["provenance"]["tracking_settings"].pop("working_bytes")
    rewrite(wb.project, result)
    before = canonical_json(result)
    read = wb.execute("tracking_result", bound(result))
    assert read["trajectory_metrics"]["storage"] == "derived-from-legacy-graph"
    assert canonical_json(wb.project.result(result["id"])) == before


def test_translation_replay_budget_refuses_before_array_loader(
    registered_observations, tmp_path, monkeypatch
):
    wb, path, _ = registered_observations
    padded = np.pad(tifffile.imread(path), ((0, 0), (0, 96), (0, 92)))
    bigger = tmp_path / "generated-registration-budget.ome.tif"
    tifffile.imwrite(
        bigger,
        padded,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
        },
    )
    source = wb.import_native(str(bigger))
    originals = []
    for t in range(3):
        output = wb.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "selection": {"t": t},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 50},
                    "measurement_channels": [0],
                },
            },
        )
        originals.append(wb.project.result(output["result"]["id"]))
    good = publish(
        wb,
        {
            **temporal_fixtures.request(originals),
            "working_bytes": 8 * 1024**2,
            "registration": {"method": "translation", "upsample_factor": 1},
        },
    )
    records = {record["id"]: record for record in originals}
    monkeypatch.setattr(
        wb.project, "load_array", lambda *_: pytest.fail("Decoded over-budget images")
    )
    with pytest.raises(ValueError, match="working-memory budget"):
        validate_registration_arrays(
            good, records, array_loader=wb.project.load_array, working_bytes=1024**2
        )


def test_portable_translation_acceptance_replays_staged_arrays(registered_observations, tmp_path):
    wb, _, originals = registered_observations
    good = publish(
        wb,
        {
            **temporal_fixtures.request(originals),
            "registration": {"method": "translation", "upsample_factor": 1},
        },
    )
    archive = tmp_path / "valid-registered.zip"
    export_project(wb.project, archive)
    bad = forged_translation(good)
    bad.pop("revision_hash")
    bad["revision_hash"] = hashlib.sha256(canonical_json(bad).encode()).hexdigest()

    def transform(entries):
        name = f"results/{bad['id']}.json"
        payload = canonical_json(bad).encode()
        changed = [(info, payload if info.filename == name else data) for info, data in entries]
        for index, (info, data) in enumerate(changed):
            if info.filename == "manifest.json":
                manifest = json.loads(data)
                item = next(item for item in manifest["members"] if item["path"] == name)
                item.update(sha256=hashlib.sha256(payload).hexdigest(), size_bytes=len(payload))
                changed[index] = (info, canonical_json(manifest).encode())
        return changed

    tampered = tmp_path / "forged-registered.zip"
    _rewrite(archive, tampered, transform)
    target = tmp_path / "refused-registered"
    with pytest.raises(ValueError, match="exact original images"):
        import_project(tampered, target)
    assert not target.exists()


def test_portable_roundtrip_retains_exact_graph_metrics_and_correction_history(scene, tmp_path):
    wb, _, request, _ = scene()
    parent = publish(wb, request)
    edge = parent["provenance"]["tracking"]["edges"][0]
    output = wb.execute("correct_tracks", {**bound(parent), "changes": [edit(edge, "remove")]})
    child = wb.project.result(output["result"]["id"])
    archive = tmp_path / "trajectories.zip"
    export_project(wb.project, archive)
    imported = import_project(archive, tmp_path / "restored-tracks")
    assert imported.result(parent["id"]) == parent
    assert imported.result(child["id"]) == child
