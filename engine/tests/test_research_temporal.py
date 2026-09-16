import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def observations(tmp_path):
    image = np.zeros((3, 32, 36), np.uint16)
    for t in range(3):
        image[t, 5:9, 5 + t : 9 + t] = 100 + 10 * t
        image[t, 18:24, 19 + t : 26 + t] = 120 + 10 * t
    file = tmp_path / "timed.ome.tif"
    tifffile.imwrite(
        file,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["Reporter"]},
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study.loci-study", "Timed study"))
    source = wb.import_native(str(file))
    results = []
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
        results.append(wb.project.result(output["result"]["id"]))
    yield wb, file, results
    wb.close()


def request(results):
    return {
        "frames": [
            {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "time_s": index * 2,
            }
            for index, result in enumerate(results)
        ],
        "time_declaration": "Acquisition log: 2 seconds between the three recorded frames",
        "max_distance": 2,
        "max_gap_frames": 0,
        "ambiguity_distance": 0.001,
    }


def test_true_timed_observations_raw_intensity_and_trajectory_units(observations):
    wb, file, results = observations
    job = submit_job(wb, request(results), "tracking-once", "track_results")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert output["units"] == {"position": "um", "time": "s", "speed": "um/s"}
    assert len(output["tracking"]["trajectories"]) == 2
    for track in output["tracking"]["trajectories"]:
        assert len(track) == 3
        assert track[1]["speed"] == 0.25
        assert track[-1]["path_length"] == 1
    assert (
        output["inputs"][1]["raw_object_measurements"][0]["intensity"]["1: Reporter"]["mean"] == 110
    )
    result = wb.project.result(output["result"]["id"])
    assert wb.project.review_state(result["id"]) is None
    assert hashlib.sha256(file.read_bytes()).hexdigest() == results[0]["source_sha256"]
    reopened = Workbench(ResearchProject(wb.project.root))
    actual = reopened.execute(
        "tracking_result", {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    )
    assert len(actual["tracking"]["trajectories"]) == 2
    reopened.close()


def test_registration_adjusts_only_coordinates_and_records_actual_transform(observations):
    wb, _, results = observations
    output = wb.execute(
        "track_results",
        {**request(results), "registration": {"method": "translation", "upsample_factor": 1}},
    )
    for track in output["tracking"]["trajectories"]:
        assert track[-1]["path_length"] == pytest.approx(0, abs=1e-12)
    assert output["inputs"][1]["registration"]["moving_to_reference_shift_index"] == (0, -1)
    assert (
        output["inputs"][1]["raw_object_measurements"] == results[1]["provenance"]["measurements"]
    )


def test_missing_observation_is_explicit_and_manual_association_is_revision_bound(observations):
    wb, _, results = observations
    spec = request([results[0], results[2]])
    spec["frames"][1]["time_s"] = 4
    spec["frames"].insert(
        1, {"frame_id": "unavailable-frame", "time_s": 2, "missing_reason": "Frame not acquired"}
    )
    output = wb.execute("track_results", {**spec, "max_gap_frames": 1})
    assert all(edge["gap"] == 1 for edge in output["tracking"]["edges"])
    assert all(
        point["frame_id"] != "unavailable-frame"
        for track in output["tracking"]["trajectories"]
        for point in track
    )
    parent = wb.project.result(output["result"]["id"])
    edge = output["tracking"]["edges"][0]
    removed = wb.execute(
        "correct_tracks",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "changes": [
                {
                    "op": "remove",
                    **{
                        key: edge[key]
                        for key in (
                            "source_frame_id",
                            "source_label",
                            "target_frame_id",
                            "target_label",
                        )
                    },
                }
            ],
        },
    )
    assert len(removed["tracking"]["edges"]) == 1
    assert len(parent["provenance"]["tracking"]["edges"]) == 2
    assert removed["result"]["parent_id"] == parent["id"]


def test_stale_duplicate_or_nonincreasing_observations_fail_closed(observations):
    wb, _, results = observations
    before = len(wb.project.list_results())
    spec = request(results)
    spec["frames"][1]["revision_hash"] = "a" * 64
    with pytest.raises(ValueError, match="exact"):
        wb.execute("track_results", spec)
    spec = request(results)
    spec["frames"][1]["time_s"] = 0
    with pytest.raises(ValueError, match="increasing"):
        wb.execute("track_results", spec)
    spec = request([results[0], results[0]])
    with pytest.raises(ValueError, match="not separate"):
        wb.execute("track_results", spec)
    assert len(wb.project.list_results()) == before


def test_tracking_export_preserves_numeric_speeds_units_and_all_input_bindings(
    observations, tmp_path
):
    import csv
    import json

    from loci_engine.research_export import export_research_result

    wb, file, results = observations
    output = wb.execute("track_results", request(results))
    result = output["result"]
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "tracks-export"
    export_research_result(wb.project, result["id"], result["revision_hash"], destination)
    exported = json.loads((destination / "tracking.json").read_text())
    assert exported["tracking"]["trajectories"] == json.loads(
        json.dumps(output["tracking"]["trajectories"])
    )
    assert exported["inputs"] == json.loads(json.dumps(output["inputs"]))
    with (destination / "trajectories.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 6
    assert rows[1]["speed"] == "0.25" and rows[1]["speed_unit"] == "um/s"
    artifact = wb.project.arrays / (results[-1]["arrays"]["labels"]["sha256"] + ".npy")
    artifact.write_bytes(artifact.read_bytes() + b"bad")
    rejected = tmp_path / "tampered-tracks"
    with pytest.raises(ValueError):
        export_research_result(wb.project, result["id"], result["revision_hash"], rejected)
    assert not rejected.exists()
