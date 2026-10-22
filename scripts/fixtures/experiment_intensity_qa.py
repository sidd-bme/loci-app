#!/usr/bin/env python3
"""Authored raw-intensity hierarchy fixture; never reads laboratory images."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import sys
from pathlib import Path


def create_cancellation(directory):
    """Separate bounded study so running export cancellation has real work."""
    import numpy as np
    import tifffile
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    directory.mkdir()
    inputs = directory / "inputs"
    inputs.mkdir()
    source_path = inputs / "Cancellation.ome.tif"
    raw = np.zeros((302, 302), np.float64)
    raw[1:301:3, 1:301:3] = 11
    tifffile.imwrite(source_path, raw, ome=True, metadata={"axes": "YX"})
    project = ResearchProject.create(
        directory / "Cancellation.loci-study", "Authored cancellation comparison"
    )
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(source_path))
        result = workbench.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "selection": {"c": 0},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 1},
                    "measurement_channels": [0],
                },
            },
        )["result"]
        assert result["object_count"] == 10_000
        project.review(result["id"], result["revision_hash"], "reviewed")
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(
            [
                "source_id",
                "study",
                "sample",
                "condition",
                "biological_replicate",
                "plate",
                "well",
            ]
        )
        writer.writerow(
            [
                source["id"],
                project.meta["title"],
                "Cancellation",
                "Cancel",
                "R1",
                "",
                "",
            ]
        )
        csv_path = directory / "samples.csv"
        csv_path.write_text(output.getvalue(), encoding="utf-8")
        return {
            "study_path": str(project.root),
            "samples_csv": str(csv_path),
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "source_id": source["id"],
            "source_hashes": {str(source_path): source["sha256"]},
            "object_count": 10_000,
        }
    finally:
        workbench.close()


def create(directory):
    import numpy as np
    import tifffile

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine/src"))
    from loci_engine.research_channels import save_channels
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    inputs = directory / "inputs"
    inputs.mkdir()
    project = ResearchProject.create(
        directory / "Intensity.loci-study", "Authored intensity comparison"
    )
    workbench = Workbench(project)
    records = {}
    sample_rows = []
    try:
        for name, count, value, condition, replicate, disposition in (
            ("A100", 100, 10, "A", "R1", "reviewed"),
            ("A30", 1, 30, "A", "R1", "reviewed"),
            ("A40", 1, 40, "A", "R2", "reviewed"),
            ("Bnegative", 2, -5, "B", "R1", "reviewed"),
            ("Bzero", 1, 0, "B", "R2", "reviewed"),
            ("Unassigned", 1, 7, "B", "", "reviewed"),
            ("Excluded", 1, 999, "A", "R3", "excluded"),
            ("Pending", 1, 88, "A", "R4", "pending"),
        ):
            raw = np.zeros((3, 32, 32), np.float64)
            for index in range(count):
                y, x = 1 + (index // 10) * 3, 1 + (index % 10) * 3
                raw[0, y : y + 2, x : x + 2] = value
                raw[1, y : y + 2, x : x + 2] = 100
                # One B cell has an empty nuclear intersection.
                if name != "Bnegative" or index == 0:
                    raw[2, y, x] = 100
            # Exercise real filename wrapping; labels and numerical oracle stay identical.
            basename = (
                name + "_native-grid_float64_declared-raw-channel_replicate-R1_long-source-name"
                if name == "A100"
                else name
            )
            source_path = inputs / (basename + ".ome.tif")
            tifffile.imwrite(
                source_path,
                raw,
                ome=True,
                metadata={
                    "axes": "CYX",
                    "PhysicalSizeX": 1.0,
                    "PhysicalSizeY": 1.0,
                    "PhysicalSizeXUnit": "µm",
                    "PhysicalSizeYUnit": "µm",
                    "Channel": {"Name": ["raw.mean:核/β", "Cell mask", "Nuclear mask"]},
                },
            )
            source = workbench.import_native(str(source_path))
            recipe = {
                "segmentation": {"method": "components", "threshold": 50},
                "measurement_channels": [0],
            }
            cells = workbench.execute(
                "run_recipe",
                {"source_id": source["id"], "selection": {"c": 1}, "recipe": recipe},
            )["result"]
            nuclei = workbench.execute(
                "run_recipe",
                {"source_id": source["id"], "selection": {"c": 2}, "recipe": recipe},
            )["result"]
            # Explicit synthetic declarations change after label production.
            # The endpoint must retain this measurement epoch independently.
            channels = workbench.channel_metadata(source["id"])["channels"]
            channels[0].update(
                marker="IL4R",
                fluorophore="AF647",
                declaration="Authored measurement-time declaration; no identity inference",
            )
            measurement_metadata = save_channels(
                project,
                {
                    "source_id": source["id"],
                    "channels": channels,
                    "expected_revision": 0,
                },
            )
            compartment = workbench.execute(
                "associate_results",
                {
                    "cells": {
                        "result_id": cells["id"],
                        "revision_hash": cells["revision_hash"],
                    },
                    "nuclei": {
                        "result_id": nuclei["id"],
                        "revision_hash": nuclei["revision_hash"],
                    },
                    "roles": {"cells": "Authored cells", "nuclei": "Authored nuclei"},
                    "control": "Synthetic constant raw intensity within each authored cell",
                    "measurement_channels": [0],
                    "working_bytes": 16 * 1024**2,
                },
            )["result"]
            for result in (cells, compartment):
                if disposition != "pending":
                    project.review(result["id"], result["revision_hash"], disposition)
            records[name] = {
                "source_id": source["id"],
                "name": name,
                "object_count": count,
                "object": {
                    "result_id": cells["id"],
                    "revision_hash": cells["revision_hash"],
                },
                "compartment": {
                    "result_id": compartment["id"],
                    "revision_hash": compartment["revision_hash"],
                },
                "condition": condition,
                "replicate": replicate or None,
                "disposition": disposition,
                "raw_mean": value,
                "source_sha256": source["sha256"],
                "measurement_channel_metadata": measurement_metadata,
            }
            sample_rows.append(
                [
                    source["id"],
                    project.meta["title"],
                    name,
                    condition,
                    replicate,
                    "Plate 1",
                    "A1",
                ]
            )
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(
            [
                "source_id",
                "study",
                "sample",
                "condition",
                "biological_replicate",
                "plate",
                "well",
            ]
        )
        writer.writerows(sample_rows)
        csv_path = directory / "samples.csv"
        csv_path.write_text(output.getvalue(), encoding="utf-8")
        manifest = {
            "schema": "loci.intensity-qa-fixture/v1",
            "study_path": str(project.root),
            "samples_csv": str(csv_path),
            "records": records,
            "source_hashes": {
                str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in inputs.iterdir()
            },
            "cancellation": create_cancellation(directory / "cancellation"),
        }
        target = directory / "fixture.json"
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        return {"manifest": str(target), "study_path": str(project.root)}
    finally:
        workbench.close()


def verify(manifest_path, package):
    fixture = json.loads(Path(manifest_path).read_text())
    report = json.loads((Path(package) / "report.json").read_text())
    condition = next(row for row in report["conditions"] if row["condition"] == "A")
    assert condition["mean"] == 30
    assert math.isclose(condition["sd"], math.sqrt(200), rel_tol=1e-14)
    assert condition["object_count"] == 102
    assert condition["image_count"] == 3
    assert condition["declared_replicate_count"] == 2
    assert condition["valid_replicate_count"] == 2
    for binding in report["bindings"]:
        source = next(
            row
            for row in fixture["records"].values()
            if row["source_id"] == binding["source_id"]
        )
        assert binding["producing_channels"]["revision"] == 0
        if report["endpoint"]["compartment"] == "object":
            assert binding["channel"]["metadata"]["marker"] == ""
        else:
            assert (
                binding["measurement_channel_metadata"]
                == source["measurement_channel_metadata"]
            )
            assert (
                binding["channel"]["metadata"]
                == source["measurement_channel_metadata"]["channels"][0]
            )
            assert binding["measurement_channel_metadata"]["revision"] == 1
            for producer in binding["scope"]["label_producers"].values():
                assert producer["input_channel"]["metadata"]["marker"] == ""
    for row in report["images"]:
        source = next(
            value
            for value in fixture["records"].values()
            if value["source_id"] == row["source_id"]
        )
        if source["disposition"] == "excluded":
            assert row["mean"] is None
        else:
            assert row["mean"] == source["raw_mean"]
    for source_path, expected in fixture["source_hashes"].items():
        assert hashlib.sha256(Path(source_path).read_bytes()).hexdigest() == expected
    if report["endpoint"]["compartment"] == "nuclear":
        result_id = fixture["records"]["Bnegative"]["compartment"]["result_id"]
        rows = [row for row in report["observations"] if row["result_id"] == result_id]
        assert sorted(row["status"] for row in rows) == ["null", "value"]
    return {
        "oracle": "passed",
        "mean": 30,
        "sd": condition["sd"],
        "counts": [102, 3, 2],
        "compartment": report["endpoint"]["compartment"],
        "source_immutability": "passed",
        "measurement_epoch": "passed",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("create").add_argument("directory")
    command = sub.add_parser("verify")
    command.add_argument("manifest")
    command.add_argument("package")
    args = parser.parse_args()
    print(
        json.dumps(
            create(args.directory)
            if args.command == "create"
            else verify(args.manifest, args.package)
        )
    )
