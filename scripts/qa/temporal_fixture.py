"""Generated XYZ tracking prerequisites and independent retained/CSV oracle.

Creation appends one generated source and three immutable masks to an existing
generated study. It never runs tracking. Verification uses SQLite/NPY/CSV/math,
without importing the tracking executor, graph validator or metric kernel.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sqlite3
import sys
from itertools import pairwise
from pathlib import Path
from urllib.parse import quote

import numpy as np
import tifffile

LABEL = 70_001
TRACK_KEY = "codex-assays-temporal-v1"
CORRECT_KEY = "codex-assays-temporal-correct-v1"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def close(actual, expected):
    assert type(actual) in (int, float) and math.isfinite(actual)
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12), (
        actual,
        expected,
    )


def create(root, study):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine/src"))
    from loci_engine.quantitative import measure_objects
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench, runtime_record

    root.mkdir(parents=True, exist_ok=False)
    image = np.zeros((3, 7, 8, 10), np.uint16)
    indices = [(1, 1, 1), (1, 3, 4), (5, 3, 4)]
    for t, point in enumerate(indices):
        image[(t, *point)] = 100 + 10 * t
    path = root / "xyz-sequence.ome.tif"
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
    path.chmod(0o444)
    wb = Workbench(ResearchProject(study))
    files, originals, frames = {str(path): sha(path)}, {}, []
    try:
        source = wb.import_native(str(path))
        for t, point in enumerate(indices):
            raw, geometry, selection = wb.load_scalar(
                source["id"], {"t": t, "z": 0, "z_stop": 7}
            )
            labels = np.zeros(raw.shape, np.uint32)
            labels[point] = LABEL
            result = wb.project.save_result(
                source_id=source["id"],
                kind="segmentation",
                arrays={"image": raw, "labels": labels},
                provenance={
                    "geometry": geometry.to_dict(),
                    "selection": selection,
                    "measurement_channels": [0],
                    "runtime": runtime_record(),
                    "measurement_basis": "Authored generated single-voxel masks and raw signal",
                    "measurements": measure_objects(labels, geometry, {"raw": raw}),
                },
            )
            result = wb.project.result(result["id"])
            reference = root / f"mask-{t}.npy"
            np.save(reference, labels, allow_pickle=False)
            reference.chmod(0o444)
            files[str(reference)] = sha(reference)
            originals[result["id"]] = digest(result)
            frames.append(
                {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "t": t,
                    "time_s": [0, 2, 8][t],
                    "reference": str(reference),
                }
            )
        fixture = {
            "schema": "loci.generated-temporal-fixture/v1",
            "study": str(wb.project.root),
            "source": {"id": source["id"], "sha256": source["sha256"]},
            "files": files,
            "original_records": originals,
            "frames": frames,
            "track_key": TRACK_KEY,
            "correct_key": CORRECT_KEY,
            "request": {
                "frames": [
                    {k: frame[k] for k in ("result_id", "revision_hash", "time_s")}
                    for frame in frames
                ],
                "time_declaration": "Generated acquisition log: actual seconds 0, 2 and 8",
                "max_distance": 20,
                "max_gap_frames": 0,
                "ambiguity_distance": 0,
                "registration": {"method": "none"},
                "working_bytes": 256 * 1024**2,
            },
            "scope": "Generated physical XYZ engineering oracle; no biological identity claim",
        }
        write(root / "fixture.json", fixture)
        return fixture
    finally:
        wb.close()


def verify(root, exports, policy_sha256=None):
    fixture = json.loads((root / "fixture.json").read_text())
    for filename, fingerprint in fixture["files"].items():
        assert sha(filename) == fingerprint, "Generated temporal source/mask changed"
    project = Path(fixture["study"])
    with sqlite3.connect(
        "file:" + quote(str(project / "study.sqlite3")) + "?mode=ro", uri=True
    ) as db:
        results = {
            key: json.loads(value)
            for key, value in db.execute("SELECT id,record FROM results")
        }
        jobs = [json.loads(row[0]) for row in db.execute("SELECT record FROM jobs")]
    positions = []
    for frame in fixture["frames"]:
        original = results[frame["result_id"]]
        assert digest(original) == fixture["original_records"][original["id"]]
        mask = np.load(frame["reference"], allow_pickle=False)
        z, y, x = np.argwhere(mask == LABEL).mean(axis=0)
        positions.append([float(x), float(y * 2), float(z * 3)])
        raw = np.load(
            project / "arrays" / (original["arrays"]["image"]["sha256"] + ".npy"),
            allow_pickle=False,
        )
        row = original["provenance"]["measurements"][0]
        assert row["label"] == LABEL and row["voxel_count"] == 1 and row["measure"] == 6
        close(row["intensity"]["raw"]["mean"], float(raw[mask == LABEL].mean()))
        assert row["intensity"]["raw"]["mean"] == 100 + frame["t"] * 10
    intervals = [
        [b - a for a, b in zip(first, last, strict=True)]
        for first, last in pairwise(positions)
    ]
    lengths = [math.hypot(*vector) for vector in intervals]
    net = [b - a for a, b in zip(positions[0], positions[-1], strict=True)]
    path_length, net_length = math.fsum(lengths), math.hypot(*net)
    assert lengths == [5, 12] and net == [3, 4, 12] and net_length == 13
    output, owners = {}, []
    for role, operation, key in (
        ("initial", "track_results", TRACK_KEY),
        ("corrected", "correct_tracks", CORRECT_KEY),
    ):
        found = [
            job
            for job in jobs
            if job["operation"] == operation and job["request_key"] == key
        ]
        assert len(found) == 1 and found[0]["state"] == "succeeded"
        job = found[0]
        assert len(job["result_ids"]) == 1 and job.get("owner") is not None
        owner = job["owner"]
        if policy_sha256 is not None:
            assert owner["policy_sha256"] == policy_sha256
        owners.append(owner)
        result = results[job["result_ids"][0]]
        p, graph = result["provenance"], result["provenance"]["tracking"]
        assert p["job_id"] == job["id"]
        assert (
            len(graph["frames"]) == 3
            and len(graph["edges"]) == 2
            and not graph["hypotheses"]
        )
        for frame, expected, original in zip(
            graph["frames"], positions, fixture["frames"], strict=True
        ):
            assert frame["frame_id"] == original["result_id"]
            assert frame["detections"][0]["centroid_world_xyz"] == expected
        assert [f["raw_object_measurements"] for f in p["temporal_inputs"]] == [
            results[f["result_id"]]["provenance"]["measurements"]
            for f in fixture["frames"]
        ]
        metrics = p["trajectory_metrics"]
        assert metrics["graph_sha256"] == digest(
            {k: graph[k] for k in ("frames", "edges", "hypotheses")}
        )
        assert metrics["units"] == {
            "position": "um",
            "time": "s",
            "velocity": "um/s",
            "directionality": "dimensionless",
        }
        assert len(metrics["tracks"]) == 1 and len(metrics["intervals"]) == 2
        track = metrics["tracks"][0]
        for name, expected in (
            ("observed_path_length", path_length),
            ("net_displacement", net_length),
            ("mean_speed", path_length / 8),
            ("directionality_ratio", net_length / path_length),
        ):
            close(track[name], expected)
        assert track["net_displacement_xyz"] == net and track["mean_velocity_xyz"] == [
            v / 8 for v in net
        ]
        assert track["gap_frames"] == 0 and track["uncertain_edge_count"] == int(
            role == "corrected"
        )
        for index, interval in enumerate(metrics["intervals"]):
            elapsed = [2, 6][index]
            assert interval["displacement_xyz"] == intervals[index]
            assert interval["velocity_xyz"] == [v / elapsed for v in intervals[index]]
            assert interval["gap_frames"] == 0 and interval["identity_uncertain"] is (
                role == "corrected" and index == 0
            )
            assert interval["association_provenance"] == (
                "manual" if role == "corrected" and index == 0 else "automatic"
            )
        if role == "corrected":
            assert result["parent_id"] == output["initial"]["result_id"]
            assert (
                p["track_correction"]["parent_revision_hash"]
                == output["initial"]["revision_hash"]
            )
        packages = exports.get(role, [])
        assert len(packages) == 2, "First and cold-reopen temporal exports required"
        fingerprints = []
        for directory in packages:
            receipt = json.loads((directory / "result.json").read_text())
            assert receipt["result"] == result and receipt["review"]["actor"] == "agent"
            exported = json.loads((directory / "tracking.json").read_text())
            assert (
                exported["tracking"] == graph
                and exported["trajectory_metrics"] == metrics
            )
            with (directory / "track-summaries.csv").open(newline="") as stream:
                rows = list(csv.DictReader(stream))
            close(float(rows[0]["mean_speed"]), path_length / 8)
            close(float(rows[0]["directionality_ratio"]), net_length / path_length)
            close(float(rows[0]["mean_velocity_z"]), 12 / 8)
            with (directory / "track-intervals.csv").open(newline="") as stream:
                rows = list(csv.DictReader(stream))
            assert [float(row["velocity_z"]) for row in rows] == [0, 2]
            fingerprints.append(
                {
                    name: sha(directory / name)
                    for name in (
                        "tracking.json",
                        "trajectories.csv",
                        "track-summaries.csv",
                        "track-intervals.csv",
                    )
                }
            )
        assert fingerprints[0] == fingerprints[1]
        output[role] = {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "job_id": job["id"],
            "stable_files": fingerprints[0],
        }
    assert owners[0] == owners[1]
    return {
        "status": "passed",
        "scope": "Independent generated XYZ/time/CSV engineering oracle",
        "results": output,
        "original_records_unchanged": len(fixture["original_records"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "verify"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--study", type=Path)
    parser.add_argument("--export", action="append", default=[], metavar="ROLE=PATH")
    parser.add_argument("--policy-sha256")
    args = parser.parse_args()
    if args.command == "create":
        if args.study is None:
            parser.error("create requires --study")
        result = create(args.root.absolute(), args.study)
    else:
        exports = {}
        for item in args.export:
            role, path = item.split("=", 1)
            exports.setdefault(role, []).append(Path(path))
        result = verify(args.root, exports, args.policy_sha256)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
