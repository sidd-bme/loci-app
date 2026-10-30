"""Generated wound/shape prerequisites and independent saved/export arithmetic.

Creation never runs the new assays. Verification reads SQLite/NPY/CSV/XML
without importing either assay kernel or its report validator. No lab data.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

import numpy as np
import tifffile

LABEL = 4_000_000_000


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def close(actual, expected):
    assert math.isfinite(actual) and math.isclose(
        actual, expected, rel_tol=1e-11, abs_tol=1e-12
    ), (actual, expected)


def create(root):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine" / "src"))
    from loci_engine.quantitative import measure_objects
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench, runtime_record

    root.mkdir(parents=True, exist_ok=False)
    wb = Workbench(
        ResearchProject.create(root / "assays.loci-study", "Generated assay QA")
    )
    files, originals = {}, {}

    def source(name, array, axes, spacing=None):
        path = root / (name + ".ome.tif")
        metadata = {"axes": axes}
        if spacing:
            for axis, value in zip(axes.replace("T", ""), spacing, strict=True):
                metadata[f"PhysicalSize{axis}"] = value
                metadata[f"PhysicalSize{axis}Unit"] = "µm"
        tifffile.imwrite(
            path, array, ome=True, photometric="minisblack", metadata=metadata
        )
        path.chmod(0o444)
        files[str(path)] = sha(path)
        return wb.import_native(str(path))

    def parent(name, src, mask, selection, filled=False):
        raw, geometry, selected = wb.load_scalar(src["id"], selection)
        provenance = {
            "geometry": geometry.to_dict(),
            "selection": selected,
            "runtime": runtime_record(),
            "measurement_channels": [0],
            "measurement_basis": "Generated raw channel values",
            "producer": {
                "name": "Loci generated assay QA prerequisites",
                "version": "1",
            },
            "measurements": measure_objects(mask, geometry, {"raw": raw}),
        }
        if filled:
            provenance["mask_semantics"] = "filled-wound-area"
        saved = wb.project.save_result(
            source_id=src["id"],
            kind="segmentation",
            arrays={"image": raw, "labels": mask},
            provenance=provenance,
        )
        record = wb.project.result(saved["id"])
        reference = root / (name + "-reference.npy")
        np.save(reference, mask, allow_pickle=False)
        reference.chmod(0o444)
        files[str(reference)] = sha(reference)
        originals[record["id"]] = digest(record)
        return {
            "result_id": record["id"],
            "revision_hash": record["revision_hash"],
            "source_id": src["id"],
            "source_sha256": src["sha256"],
            "name": name,
            "reference": str(reference),
            "labels_sha256": record["arrays"]["labels"]["sha256"],
            "object_count": len(provenance["measurements"]),
        }

    try:
        pixels = np.arange(5 * 48 * 48, dtype=np.uint16).reshape(5, 48, 48)
        wound_source = source("wound-sequence", pixels, "TYX", (2, 3))
        wb.project.put_document(
            "sample",
            wound_source["id"],
            {
                "study": "Generated assay QA",
                "sample": "Generated specimen",
                "condition": "Technical",
                "biological_replicate": "D1",
            },
            expected_revision=0,
        )
        wound = []
        for t, height, width in [(0, 3, 4), (2, 2, 3), (3, 3, 6), (4, 0, 0)]:
            mask = np.zeros((48, 48), np.uint32)
            if height:
                mask[36 : 36 + height, 10 : 10 + width] = LABEL
            if t == 0:
                # Exactly 1001 positive measured labels, not a 1..count population.
                mask[:25, :40] = np.arange(1001, 2001, dtype=np.uint32).reshape(25, 40)
            if t == 2:
                mask[44, 43:45] = (
                    77  # Preserved but explicitly outside the chosen wound union.
                )
            item = parent(f"wound-frame-{t}", wound_source, mask, {"t": t}, True)
            wound.append({**item, "t": t, "selected_labels": [LABEL] if height else []})
        wrong_source = source("wound-wrong-grid", pixels, "TYX", (2, 4))
        wrong_mask = np.zeros((48, 48), np.uint32)
        wrong_mask[36:38, 10:13] = LABEL
        wrong = parent("wound-wrong-grid", wrong_source, wrong_mask, {"t": 2}, True)
        frame_by_t = {item["t"]: item for item in wound}
        request = {
            "frames": [
                {
                    "frame_id": f"frame-{t}",
                    "missing_reason": "Generated acquisition missing",
                }
                if t == 1
                else {
                    "frame_id": f"frame-{t}",
                    **{
                        k: frame_by_t[t][k]
                        for k in ("result_id", "revision_hash", "selected_labels")
                    },
                    "mask_semantics": "filled-wound-area",
                }
                for t in range(5)
            ],
            "time_s": [10, 40, 90, 150, 210],
            "time_unit": "s",
            "time_declaration": "Actual seconds supplied by the generated acquisition log",
            "specimen_id": "Generated specimen",
            "sequence_id": "Generated sequence A",
            "area_declaration": "Only the explicit filled region label union represents wound area",
            "grid_declaration": "Original shared field, plane, channel and physical calibration",
            "working_bytes": 256 * 1024**2,
        }
        morphology = []
        for dimension in (2, 3):
            for calibrated in (False, True):
                name = f"shape-{dimension}d-{'physical' if calibrated else 'pixel'}"
                shape = (8, 10) if dimension == 2 else (5, 8, 10)
                axes, spacing = ("YX", (2, 1)) if dimension == 2 else ("ZYX", (3, 2, 1))
                raw = np.arange(math.prod(shape), dtype=np.uint16).reshape(shape)
                src = source(name, raw, axes, spacing if calibrated else None)
                mask = np.zeros(shape, np.uint32)
                if dimension == 2:
                    mask[2:4, 3:6] = LABEL
                else:
                    mask[1:3, 2:5, 3:7] = LABEL
                mask[(0,) * dimension] = 17
                selected = {"z": 0, "z_stop": 5} if dimension == 3 else {}
                item = parent(name, src, mask, selected)
                morphology.append(
                    {
                        **item,
                        "axes": axes,
                        "unit": "um" if calibrated else "pixel",
                        "spacing": list(spacing if calibrated else (1,) * dimension),
                        "extent": [2, 3] if dimension == 2 else [2, 3, 4],
                        "metric": "morphometrics:perimeter"
                        if dimension == 2
                        else "morphometrics:surface_area",
                    }
                )
        fixture = {
            "schema": "loci.generated-assay-fixture/v1",
            "study": str(wb.project.root),
            "source_count": 6,
            "initial_result_count": 9,
            "files": files,
            "original_records": originals,
            "wound": wound,
            "wrong_grid": wrong,
            "wound_request": request,
            "morphology": morphology,
            "scope": "Generated engineering QA; simulated GUI review is not human approval",
        }
        write(root / "fixture.json", fixture)
        return fixture
    finally:
        wb.close()


def manifest(directory):
    data = json.loads((directory / "manifest.json").read_text())
    names = set()
    for entry in data["files"]:
        name = entry["name"]
        assert Path(name).name == name and name not in names
        names.add(name)
        path = directory / name
        assert path.is_file() and not path.is_symlink()
        assert (
            sha(path) == entry["sha256"] and path.stat().st_size == entry["size_bytes"]
        )
    assert {path.name for path in directory.iterdir()} == names | {"manifest.json"}
    return data


def json_cells(path):
    with path.open(newline="") as stream:
        return [
            {key: json.loads(value) for key, value in row.items()}
            for row in csv.DictReader(stream)
        ]


def verify_wound(report, fixture, exports):
    assert len(exports) == 2, "First-session and cold-reopen wound exports are required"
    request = fixture["wound_request"]
    assert report["request"] == request
    observed = {item["t"]: item for item in fixture["wound"]}
    expected_areas = [72, None, 36, 108, 0]
    expected_closure = [0, None, 0.5, -0.5, 1]
    m = report["measurement"]
    assert (
        m["area_unit"] == "um^2" and m["time_unit"] == "s" and m["baseline_area"] == 72
    )
    for i, row in enumerate(m["frames"]):
        assert row["frame_id"] == f"frame-{i}" and row["time_s"] == request["time_s"][i]
        if i == 1:
            assert (
                row["status"] == "missing"
                and row["area"] is row["closure_fraction"] is None
            )
            continue
        assert row["status"] == "observed"
        assert report["inputs"][i]["selection"]["t"] == i
        np.testing.assert_array_equal(
            report["inputs"][i]["geometry"]["affine"], np.diag([3, 2, 1, 1])
        )
        mask = np.load(observed[i]["reference"], allow_pickle=False)
        selected = np.isin(mask, observed[i]["selected_labels"])
        count = int(np.count_nonzero(selected))
        assert count * 6 == expected_areas[i] == row["area"]
        assert row["selected_pixel_count"] == count
        assert (
            row["excluded_positive_pixel_count"] == int(np.count_nonzero(mask)) - count
        )
        close(row["area_fraction"], expected_areas[i] / 72)
        close(row["closure_fraction"], expected_closure[i])
    for i, row in enumerate(m["intervals"]):
        dt = request["time_s"][i + 1] - request["time_s"][i]
        assert row["delta_time_s"] == dt
        if i in (0, 1):
            assert row["status"] == "missing_endpoint"
            assert row["area_change_rate"] is row["closure_change_rate"] is None
        else:
            close(
                row["area_change_rate"],
                (expected_areas[i + 1] - expected_areas[i]) / dt,
            )
            close(
                row["closure_change_rate"],
                (expected_closure[i + 1] - expected_closure[i]) / dt,
            )
    stable = []
    for directory in exports:
        package = manifest(directory)
        assert package["report_hash"] == report["report_hash"]
        assert json.loads((directory / "report.json").read_text()) == report
        frames, intervals = (
            json_cells(directory / "frames.csv"),
            json_cells(directory / "intervals.csv"),
        )
        assert intervals == m["intervals"]
        for exported, row, source in zip(
            frames, m["frames"], report["inputs"], strict=True
        ):
            assert all(exported[key] == value for key, value in row.items())
            assert exported["revision_hash"] == source.get("revision_hash")
            assert exported["area_unit"] == "um^2" and exported["time_unit"] == "s"
            if "labels" in source:
                file = directory / ("labels-" + source["labels"]["sha256"] + ".npy")
                assert sha(file) == source["labels"]["sha256"]
        svg = ET.parse(directory / "closure.svg").getroot()
        ns = "{http://www.w3.org/2000/svg}"
        points = svg.findall(".//" + ns + "circle")
        assert len(points) == 4
        for point, time, closure in zip(
            points, (10, 90, 150, 210), (0, 0.5, -0.5, 1), strict=True
        ):
            close(float(point.attrib["cx"]), 88 + 620 * (time - 10) / 200)
            close(float(point.attrib["cy"]), 44 + 300 * (1 - (closure + 0.5) / 1.5))
        lines = [
            node
            for node in svg.findall(".//" + ns + "path")
            if node.attrib.get("stroke") == "#285c8d"
        ]
        assert len(lines) == 2
        for line, a, b in zip(lines, (2, 3), (3, 4), strict=True):
            coordinates = [
                float(v)
                for v in re.findall(r"[-+]?[0-9]+(?:\.[0-9]+)?", line.attrib["d"])
            ]
            expected = []
            for index in (a, b):
                expected.extend(
                    [
                        88 + 620 * (request["time_s"][index] - 10) / 200,
                        44 + 300 * (1 - (expected_closure[index] + 0.5) / 1.5),
                    ]
                )
            for actual, value in zip(coordinates, expected, strict=True):
                assert abs(actual - value) <= 1e-6
        assert svg.find(ns + "metadata").text == report["report_hash"]
        stable.append(
            {
                name: sha(directory / name)
                for name in (
                    "report.json",
                    "frames.csv",
                    "intervals.csv",
                    "closure.svg",
                )
            }
        )
    assert stable and all(value == stable[0] for value in stable)
    return stable[0]


def expected_shape(case, label):
    spacing, extent = (
        case["spacing"],
        case["extent"] if label == LABEL else [1] * len(case["axes"]),
    )
    dimension = len(extent)
    size = [n * step for n, step in zip(extent, spacing, strict=True)]
    measure = math.prod(size)
    eigen = sorted(
        [
            (n * n - 1) * step * step / 12
            for n, step in zip(extent, spacing, strict=True)
        ],
        reverse=True,
    )
    faces = [
        2 * math.prod(extent[:axis] + extent[axis + 1 :]) for axis in range(dimension)
    ]
    if dimension == 2:
        boundary = 2 * sum(size)
        return {
            "pixel_union_area": measure,
            "perimeter": boundary,
            "circularity": 4 * math.pi * measure / boundary**2,
            "eccentricity": math.sqrt(1 - eigen[-1] / eigen[0]) if eigen[0] else None,
            "elongation": math.sqrt(eigen[0] / eigen[-1]) if eigen[-1] else None,
            "exposed_face_counts": faces,
            "center_covariance_eigenvalues": eigen,
        }
    boundary = 2 * sum(size[a] * size[b] for a, b in ((0, 1), (0, 2), (1, 2)))
    return {
        "voxel_union_volume": measure,
        "surface_area": boundary,
        "sphericity": (36 * math.pi) ** (1 / 3) * measure ** (2 / 3) / boundary,
        "exposed_face_counts": faces,
        "center_covariance_eigenvalues": eigen,
    }


def verify(root, wound_exports, morph_exports):
    root = root.resolve(strict=True)
    fixture = json.loads((root / "fixture.json").read_text())
    assert fixture["schema"] == "loci.generated-assay-fixture/v1"
    assert Path(fixture["study"]).resolve() == root / "assays.loci-study"
    assert set(morph_exports) == {case["name"] for case in fixture["morphology"]}
    for filename, fingerprint in fixture["files"].items():
        path = Path(filename)
        assert path.is_relative_to(root) and path.is_file() and not path.is_symlink()
        assert sha(filename) == fingerprint, "An original generated fixture changed"
    database = Path(fixture["study"]) / "study.sqlite3"
    with sqlite3.connect(
        "file:" + quote(str(database)) + "?mode=ro", uri=True
    ) as connection:
        results = {
            key: json.loads(value)
            for key, value in connection.execute("SELECT id,record FROM results")
        }
        reports = [
            json.loads(row[0])["data"]
            for row in connection.execute(
                "SELECT record FROM documents WHERE kind='wound_closure_report'"
            )
        ]
        jobs = [
            json.loads(row[0]) for row in connection.execute("SELECT record FROM jobs")
        ]
    for identity, fingerprint in fixture["original_records"].items():
        assert digest(results[identity]) == fingerprint, (
            "An original mask record changed"
        )
    assert len(reports) == 1
    report = reports[0]
    assert report["report_hash"] == digest(
        {k: v for k, v in report.items() if k != "report_hash"}
    )
    assert (
        len(
            [
                j
                for j in jobs
                if j["operation"] == "wound_closure_save" and j["state"] == "succeeded"
            ]
        )
        == 1
    )
    wound_hashes = verify_wound(report, fixture, wound_exports)
    shape_hashes = {}
    for case in fixture["morphology"]:
        derived = [
            r
            for r in results.values()
            if r["kind"] == "morphometrics" and r["parent_id"] == case["result_id"]
        ]
        assert len(derived) == 1
        result, parent = derived[0], results[case["result_id"]]
        assert result["arrays"] == parent["arrays"]
        assert result["provenance"]["geometry"] == parent["provenance"]["geometry"]
        assert result["provenance"]["selection"] == parent["provenance"]["selection"]
        geometry = result["provenance"]["geometry"]
        assert geometry["axes"] == case["axes"] and geometry["unit"] == case["unit"]
        xyz_spacing = list(reversed(case["spacing"]))
        if len(xyz_spacing) == 2:
            xyz_spacing.append(1)
        np.testing.assert_array_equal(geometry["affine"], np.diag([*xyz_spacing, 1]))
        assert result["source_sha256"] == case["source_sha256"]
        rows = result["provenance"]["measurements"]
        assert [
            {k: v for k, v in row.items() if k != "morphometrics"} for row in rows
        ] == parent["provenance"]["measurements"]
        assert {row["label"] for row in rows} == {17, LABEL}
        for row in rows:
            expected, actual = expected_shape(case, row["label"]), row["morphometrics"]
            for key, value in expected.items():
                if isinstance(value, list):
                    for a, b in zip(actual[key], value, strict=True):
                        close(a, b)
                elif value is None:
                    assert actual[key] is None
                else:
                    close(actual[key], value)
            assert actual["touches_crop_border"] is (row["label"] == 17)
        exports = morph_exports.get(case["name"], [])
        assert len(exports) == 2, (
            "Both first-session and cold-reopen exports are required"
        )
        stable = []
        for directory in exports:
            data = manifest(directory)
            assert (
                data["result_id"] == result["id"]
                and data["revision_hash"] == result["revision_hash"]
            )
            assert (
                json.loads((directory / "result.json").read_text())["result"] == result
            )
            assert (
                json.loads((directory / "morphometrics.json").read_text())
                == result["provenance"]["morphometrics"]
            )
            np.testing.assert_array_equal(
                np.load(directory / "labels.npy", allow_pickle=False),
                np.load(case["reference"], allow_pickle=False),
            )
            assert sha(directory / "labels.npy") == result["arrays"]["labels"]["sha256"]
            with (directory / "objects.csv").open(newline="") as stream:
                table = list(csv.DictReader(stream))
            assert {int(row["label"]) for row in table} == {17, LABEL}
            for row in table:
                expected = expected_shape(case, int(row["label"]))
                for name, value in expected.items():
                    if isinstance(value, list):
                        continue
                    cell = row["morphometrics:" + name]
                    if value is None:
                        assert cell == ""
                    else:
                        close(float(cell), value)
            stable.append(
                {
                    name: sha(directory / name)
                    for name in (
                        "objects.csv",
                        "morphometrics.json",
                        "labels.npy",
                        "image.npy",
                    )
                }
            )
        assert stable[0] == stable[1]
        shape_hashes[case["name"]] = {
            "result_id": result["id"],
            "stable_files": stable[0],
        }
    assert (
        len(
            [
                j
                for j in jobs
                if j["operation"] == "morphometrics_run" and j["state"] == "succeeded"
            ]
        )
        == 4
    )
    return {
        "status": "passed",
        "scope": "Independent generated geometry/time/export engineering oracle",
        "wound_hashes": wound_hashes,
        "shape_hashes": shape_hashes,
        "original_records_unchanged": len(fixture["original_records"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "verify"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--wound-export", type=Path, action="append", default=[])
    parser.add_argument(
        "--morph-export", action="append", default=[], metavar="CASE=PATH"
    )
    args = parser.parse_args()
    if args.command == "create":
        result = create(args.root)
    else:
        exports = {}
        for item in args.morph_export:
            name, value = item.split("=", 1)
            exports.setdefault(name, []).append(Path(value))
        result = verify(args.root, args.wound_export, exports)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
