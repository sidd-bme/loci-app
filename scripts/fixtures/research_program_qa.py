"""Generated donor-density and branching graph fixtures with independent oracles.

No laboratory data, biological claims, learned model execution, or human review.
Initialization uses native scalar-label adoption. Verification reads saved arrays
and calculates expected endpoints directly, without calling the measured kernels.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from pathlib import Path
from uuid import uuid4

import numpy as np
import tifffile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine" / "src"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def definition():
    return {
        "schema": "loci.workflow/v2",
        "name": "Generated branching cell and nucleus association",
        "inputs": {"image": "source-selection"},
        "nodes": [
            {
                "id": role,
                "operation": "run_recipe",
                "contract_version": 1,
                "inputs": {"source": {"input": "image"}},
                "settings": {
                    "recipe": {
                        "segmentation": {"method": "components", "threshold": value},
                        "measurement_channels": [0],
                    }
                },
            }
            for role, value in (("cells", 10), ("nuclei", 50))
        ]
        + [
            {
                "id": "join",
                "operation": "associate_results",
                "contract_version": 1,
                "inputs": {role: {"node": role, "port": "result"} for role in ("cells", "nuclei")},
                "settings": {
                    "roles": {"cells": "Declared cells", "nuclei": "Declared nuclei"},
                    "control": "Generated technical fixture",
                },
            }
        ],
        "outputs": {"associated": {"node": "join", "port": "result"}},
        "working_bytes": 16 * 1024**2,
    }


def create(root):
    from loci_engine.research_labels_import import ALIGNMENT, create_import_grant
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    root.mkdir(parents=True, exist_ok=False)
    study = root / "program.loci-study"
    wb = Workbench(ResearchProject.create(study, "Generated research program QA"))
    files, fields = {}, []

    def image(name, array, calibrated=False):
        path = root / f"{name}.ome.tif"
        metadata = {"axes": "YX"}
        if calibrated:
            metadata.update(
                PhysicalSizeX=1.0,
                PhysicalSizeXUnit="µm",
                PhysicalSizeY=2.0,
                PhysicalSizeYUnit="µm",
            )
        tifffile.imwrite(path, array, ome=calibrated, photometric="minisblack", metadata=metadata)
        path.chmod(0o444)
        files[str(path)] = sha(path)
        return path

    try:
        for index, (count, donor, condition) in enumerate(
            [(1, "D1", "A"), (3, "D1", "A"), (1, "D2", "A"), (1, "D1", "B")]
        ):
            raw = (np.arange(120, dtype=np.uint16) + index).reshape(10, 12)
            source = wb.import_native(str(image(f"field-{index + 1}", raw, True)))
            wb.project.put_document(
                "sample",
                source["id"],
                {
                    "study": "Generated donors",
                    "sample": f"Field {index + 1}",
                    "condition": condition,
                    "biological_replicate": donor,
                },
                expected_revision=0,
            )
            labels = np.zeros_like(raw, dtype=np.uint32)
            for label, (y, x) in enumerate([(3, 3), (5, 7), (6, 8)][:count], 1):
                labels[y, x] = label
            compartment = np.ones_like(labels)
            boundary = np.zeros_like(labels)
            boundary[:, 1] = 1
            bindings = {}
            for role, mask in (
                ("objects", labels),
                ("compartment", compartment),
                ("boundary", boundary),
            ):
                mask_path = image(f"field-{index + 1}-{role}", mask)
                grant = create_import_grant(
                    wb,
                    str(mask_path),
                    source["id"],
                    source["sha256"],
                    {"t": 0, "c": 0, "z": 0, "level": 0},
                )
                result = wb.execute(
                    "labels_import",
                    {
                        "source_id": source["id"],
                        "source_sha256": source["sha256"],
                        "grant_id": grant["grant_id"],
                        "alignment": ALIGNMENT,
                        "producer": {
                            "name": "Generated program QA masks",
                            "version": "1",
                        },
                    },
                )["result"]
                bindings[role] = {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                }
            spatial = wb.execute(
                "spatial_distance_run",
                {
                    **bindings["objects"],
                    "compartment": bindings["compartment"],
                    "boundary": bindings["boundary"],
                    "band_edges": [0, 20],
                    "exclude_crop_border": True,
                    "control": "Generated technical fixture",
                    "boundary_coverage": "Full supplied column",
                    "working_bytes": 16 * 1024**2,
                },
            )["result"]
            fields.append(
                {
                    "result_id": spatial["id"],
                    "revision_hash": spatial["revision_hash"],
                    "source_id": source["id"],
                    "count": count,
                    "donor": donor,
                    "condition": condition,
                }
            )

        graph_pixels = np.zeros((12, 16), dtype=np.uint16)
        graph_pixels[3:8, 4:10] = 20
        graph_pixels[4:6, 5:7] = 100
        source = wb.import_native(str(image("branching-source", graph_pixels, True)))
        saved = wb.execute(
            "workflow_graph_save",
            {
                "workflow_id": uuid4().hex,
                "expected_revision": 0,
                "definition": definition(),
            },
        )["workflow"]
        fixture = {
            "schema": "loci.research-program-fixture/v1",
            "study": str(study),
            "scope": "Generated engineering QA; declared donor names are artificial",
            "files": files,
            "fields": fields,
            "density_request": {
                "fields": [
                    {"result_id": f["result_id"], "revision_hash": f["revision_hash"]}
                    for f in fields
                ],
                "stratum": {"t": 0, "z": 0},
                "condition_pair": ["A", "B"],
            },
            "graph": {
                "definition": definition(),
                "workflow": saved,
                "binding": {
                    "workflow_id": saved["id"],
                    "workflow_revision": saved["revision"],
                    "definition_sha256": saved["data"]["definition_sha256"],
                    "bindings": {
                        "image": {
                            "source_id": source["id"],
                            "source_sha256": source["sha256"],
                            "selection": wb.selection(source["id"], {"level": 0}),
                        }
                    },
                },
            },
        }
        write_json(root / "fixture.json", fixture)
        return fixture
    finally:
        wb.close()


def verify(root, exports, expected_owner="native"):
    from loci_engine.research_project import ResearchProject

    fixture = json.loads((root / "fixture.json").read_text())
    for filename, expected in fixture["files"].items():
        assert sha(filename) == expected, "Generated source or reference mask changed"
    project = ResearchProject(fixture["study"])
    reports = project.documents("spatial_density_report")
    assert len(reports) == 1, "Expected exactly one report from GUI save"
    report = reports[0]["data"]
    assert report["schema"] == "loci.spatial-density-report/v2"
    aggregate = report["aggregation"]
    actual = {(r["condition"], r["biological_replicate"]): r for r in aggregate["donor_rows"]}
    expected_donors = {}
    for field in fixture["fields"]:
        key = field["condition"], field["donor"]
        values = expected_donors.setdefault(key, [0, 0, 0])
        values[0] += field["count"]
        values[1] += 10 * 12 * 1 * 2
        values[2] += 1
    assert set(actual) == set(expected_donors)
    for key, (count, area, n_fields) in expected_donors.items():
        row = actual[key]
        assert (row["object_count"], row["sampled_area"], row["n_fields"]) == (
            count,
            area,
            n_fields,
        )
        assert math.isclose(row["density"], count / area, rel_tol=1e-12)
    condition_a = next(row for row in aggregate["condition_rows"] if row["condition"] == "A")
    mean_a = (4 / 480 + 1 / 240) / 2
    assert condition_a["n"] == 2 and math.isclose(condition_a["mean"], mean_a, rel_tol=1e-12)
    assert not math.isclose(condition_a["mean"], 5 / 720, rel_tol=1e-12)
    assert len(aggregate["paired_rows"]) == 1
    assert math.isclose(aggregate["paired_rows"][0]["difference"], 1 / 240 - 4 / 480, rel_tol=1e-12)
    assert (
        len(aggregate["unmatched_donors"]) == 1
        and aggregate["unmatched_donors"][0]["biological_replicate"] == "D2"
    )

    expected_cells = {}
    for index, field in enumerate(fixture["fields"]):
        result = project.result(field["result_id"])
        assert result["revision_hash"] == field["revision_hash"]
        expected_labels = np.zeros((10, 12), dtype=np.uint32)
        expected_image = (np.arange(120, dtype=np.uint16) + index).reshape(10, 12)
        for label, (y, x) in enumerate([(3, 3), (5, 7), (6, 8)][: field["count"]], 1):
            expected_labels[y, x] = label
            expected_cells[field["result_id"], label] = {
                "field": field,
                "centroid_index": [y, x],
                "centroid_world_xyz": [x, 2 * y, 0],
                "intensity": int(expected_image[y, x]),
                "distance": x - 1,
            }
        assert np.array_equal(project.load_array(result["arrays"]["labels"]), expected_labels)
        assert np.array_equal(project.load_array(result["arrays"]["image"]), expected_image)

    runs = project.documents("workflow_run")
    completed = [
        r
        for r in runs
        if r["data"].get("schema") == "loci.workflow-run/v2" and r["data"]["state"] == "succeeded"
    ]
    assert len(completed) == 1
    run = completed[0]
    assert expected_owner in {"native", "agent"}
    owner = run["data"].get("owner")
    if expected_owner == "native":
        assert owner is None, "Expected a native-owned graph run"
    else:
        assert isinstance(owner, dict) and set(owner) == {
            "policy_sha256",
            "session_id",
        }, "Expected an exact agent-owned graph run"
        assert isinstance(owner["policy_sha256"], str) and len(owner["policy_sha256"]) == 64
    ids = []
    for role, rectangle in (
        ("cells", (slice(3, 8), slice(4, 10))),
        ("nuclei", (slice(4, 6), slice(5, 7))),
    ):
        node = run["data"]["nodes"][role]
        assert node["state"] == "succeeded"
        result = project.result(node["output"]["result_id"])
        assert result["revision_hash"] == node["output"]["revision_hash"]
        expected = np.zeros((12, 16), dtype=np.uint32)
        expected[rectangle] = 1
        assert np.array_equal(project.load_array(result["arrays"]["labels"]), expected)
        measurements = result["provenance"]["measurements"]
        assert len(measurements) == 1 and measurements[0]["measure"] == 2 * int(
            np.count_nonzero(expected)
        )
        job = project.job(node["intent"]["job_id"])
        assert (
            job.get("owner") == owner
            and job["state"] == "succeeded"
            and job["result_ids"] == [result["id"]]
        )
        assert result["provenance"]["job_id"] == job["id"]
        ids.append(job["id"])
    join = run["data"]["nodes"]["join"]
    result = project.result(join["output"]["result_id"])
    job = project.job(join["intent"]["job_id"])
    assert (
        result["kind"] == "nucleus-cell-association" and result["provenance"]["job_id"] == job["id"]
    )
    assert job.get("owner") == owner and job["state"] == "succeeded"
    ids.append(job["id"])
    assert len(set(ids)) == 3
    assert run["data"]["outputs"]["associated"] == join["output"]

    packages = []
    for destination in exports:
        manifest = json.loads((destination / "manifest.json").read_text())
        assert manifest["report_hash"] == report["report_hash"]
        for item in manifest["files"]:
            file = destination / item["name"]
            assert sha(file) == item["sha256"] and file.stat().st_size == item["size_bytes"]
        assert json.loads((destination / "report.json").read_text()) == report
        # Bind every plotted donor point to the independently verified saved
        # table, including its label and the direction of the value-to-Y map.
        import xml.etree.ElementTree as ET

        for filename, table, value_key in (
            ("donor-density.svg", "donor_rows", "density"),
            ("paired-density-change.svg", "paired_rows", "difference"),
        ):
            svg = ET.parse(destination / filename).getroot()
            circles = list(svg.iter("{http://www.w3.org/2000/svg}circle"))
            expected = {
                i: row for i, row in enumerate(aggregate[table]) if row[value_key] is not None
            }
            assert len(circles) == len(expected)
            points = {}
            for circle in circles:
                assert circle.attrib["data-table"] == table
                index = int(circle.attrib["data-row"])
                assert index in expected and index not in points
                row = expected[index]
                title = circle.find("{http://www.w3.org/2000/svg}title")
                assert title.text == f"{row['biological_replicate']}: {row[value_key]!r}"
                points[index] = float(circle.attrib["cy"])
            assert set(points) == set(expected)
            for i, left in expected.items():
                for j, right in expected.items():
                    if (left["study"], left["band_index"]) == (right["study"], right["band_index"]):
                        if left[value_key] == right[value_key]:
                            assert points[i] == points[j]
                        elif left[value_key] < right[value_key]:
                            assert points[i] > points[j]
        with (destination / "donor-rows.csv").open(newline="") as handle:
            rows = [
                {key: json.loads(value) for key, value in row.items()}
                for row in csv.DictReader(handle)
            ]
        assert rows == aggregate["donor_rows"]
        with (destination / "cells.csv").open(newline="") as handle:
            cells = [
                {key: json.loads(value) for key, value in row.items()}
                for row in csv.DictReader(handle)
            ]
        actual_cells = {(row["result_id"], row["label"]): row for row in cells}
        assert len(cells) == len(actual_cells) == len(expected_cells)
        assert set(actual_cells) == set(expected_cells)
        for key, expected in expected_cells.items():
            row = actual_cells[key]
            field = expected["field"]
            assert row["revision_hash"] == field["revision_hash"]
            assert row["source_id"] == field["source_id"]
            assert row["condition"] == field["condition"]
            assert row["biological_replicate"] == field["donor"]
            assert row["phenotype_id"] is None and row["phenotype_member"] is True
            assert row["contributes_to_donor_density"] is True
            assert row["distance"] == expected["distance"] and row["distance_unit"] == "um"
            assert row["band_index"] == 0
            assert row["object_exclusions"] == row["field_exclusions"] == []
            measurement = row["measurement"]
            assert measurement["index_axes"] == "YX"
            assert measurement["centroid_index"] == expected["centroid_index"]
            assert measurement["centroid_world_xyz"] == expected["centroid_world_xyz"]
            assert row["index_axes"] == "YX"
            assert row["centroid_index"] == expected["centroid_index"]
            assert row["centroid_world_xyz"] == expected["centroid_world_xyz"]
            assert row["intensity"] == measurement["intensity"]
            assert measurement["measure"] == 2 and measurement["measure_unit"] == "um^2"
            raw = measurement["intensity"]["1: Channel 1"]
            assert raw["mean"] == raw["sum"] == raw["min"] == raw["max"] == expected["intensity"]
            assert raw["std_population"] == 0
        packages.append(str(destination))
    return {
        "status": "passed",
        "scope": fixture["scope"],
        "report_id": reports[0]["id"],
        "donor_counts_areas": {"/".join(key): value for key, value in expected_donors.items()},
        "mean_condition_a": mean_a,
        "graph_run_id": run["id"],
        "native_child_jobs": ids,
        "expected_owner": expected_owner,
        "graph_owner": owner,
        "verified_export_packages": packages,
        "independently_verified_cells": len(expected_cells),
        "immutable_sources": len(fixture["files"]),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("create", "verify"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--export", dest="exports", type=Path, action="append", default=[])
    parser.add_argument("--expected-owner", choices=("native", "agent"), default="native")
    args = parser.parse_args()
    result = (
        create(args.root)
        if args.operation == "create"
        else verify(args.root, args.exports, args.expected_owner)
    )
    print(json.dumps(result, allow_nan=False))
