#!/usr/bin/env python3
"""Independent synthetic fixture/oracle for external-label packaged QA.

Uses NumPy/tifffile from the existing engine environment, never the Loci
measurement/import implementation. No laboratory inputs or runtime installs.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

import numpy as np
import tifffile


SIZE = 256
COUNT = 256
TARGET = 2**32 - 1


def digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def label_id(index: int) -> int:
    return TARGET if index == COUNT - 1 else (index + 1) * 1009


def owned_pixels(index: int) -> list[tuple[int, int]]:
    y, x = (index // 16) * 16 + 2, (index % 16) * 16 + 3
    pixels = [(yy, xx) for yy in range(y, y + 3) for xx in range(x, x + 4)]
    # One original ID occupies two disconnected regions, still one object.
    if index == 0:
        pixels.append((12, 12))
    return pixels


def expected_arrays(deleted: bool = False) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.indices((SIZE, SIZE))
    signal = (1000 + 3 * yy + 2 * xx).astype(np.uint16)
    labels = np.zeros((SIZE, SIZE), dtype=np.uint32)
    for index in range(COUNT):
        if deleted and label_id(index) == TARGET:
            continue
        for y, x in owned_pixels(index):
            assert labels[y, x] == 0, "Synthetic geometries must not overlap"
            labels[y, x] = label_id(index)
    return signal, labels


def expected_rows(calibrated: bool, deleted: bool = False) -> list[dict]:
    rows = []
    for index in range(COUNT):
        label = label_id(index)
        if deleted and label == TARGET:
            continue
        pixels = owned_pixels(index)
        yy, xx = zip(*pixels, strict=True)
        values = [1000 + 3 * y + 2 * x for y, x in pixels]
        mean = sum(values) / len(values)
        rows.append({
            "label": label,
            "voxel_count": len(pixels),
            "measure": len(pixels) * (0.5 if calibrated else 1),
            "measure_kind": "area",
            "measure_unit": "um^2" if calibrated else "pixel^2",
            "centroid_index": [sum(yy) / len(yy), sum(xx) / len(xx)],
            "bbox_start": [min(yy), min(xx)],
            "bbox_stop_exclusive": [max(yy) + 1, max(xx) + 1],
            "intensity": {
                "mean": mean, "sum": sum(values), "min": min(values),
                "max": max(values),
                "std_population": (sum((v - mean)**2 for v in values) / len(values))**0.5,
            },
        })
    return rows


def create(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    signal, labels = expected_arrays()
    yy, xx = np.indices(signal.shape)
    low = (7 + yy + xx).astype(np.uint16)
    tifffile.imwrite(root / "calibrated-source.ome.tiff", np.stack([low, signal]),
        ome=True, photometric="minisblack", metadata={
            "axes": "CYX", "PhysicalSizeX": 0.5, "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 1.0, "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["synthetic-low", "synthetic-raw-signal"]},
        })
    tifffile.imwrite(root / "pixel-source.tiff", signal,
        photometric="minisblack", metadata={"axes": "YX"})
    # TIFF input is plain scalar YX, without spatial-calibration claims.
    tifffile.imwrite(root / "sparse-original-ids.tiff", labels,
        photometric="minisblack", metadata={"axes": "YX"})
    tifffile.imwrite(root / "empty-labels.tiff", np.zeros_like(labels),
        photometric="minisblack", metadata={"axes": "YX"})
    manifest = {
        "schema": "loci.external-label-synthetic-fixture/v1",
        "purpose": "Computational QA only; no biological validation",
        "shape_yx": [SIZE, SIZE], "object_count": COUNT, "selected_label": TARGET,
        "ids": [label_id(index) for index in range(COUNT)],
        "raw_formula": "C1(y,x)=1000+3*y+2*x; C0(y,x)=7+y+x",
        "geometry": "3x4 rectangles at (16*row+2,16*column+3); ID1009 also owns (12,12)",
        "calibration_xy_um": [0.5, 1.0],
        "sha256": {file.name: digest(file) for file in sorted(root.glob("*.tiff"))},
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def assert_measurements(actual: list[dict], calibrated: bool, deleted: bool = False):
    expected = expected_rows(calibrated, deleted)
    assert len(actual) == len(expected), (len(actual), len(expected))
    by_label = {row["label"]: row for row in actual}
    assert len(by_label) == len(actual)
    assert set(by_label) == {row["label"] for row in expected}
    for want in expected:
        got = by_label[want["label"]]
        for key in ("label", "voxel_count", "measure_kind", "measure_unit"):
            assert got[key] == want[key], (want["label"], key, got[key], want[key])
        for key in ("measure", "centroid_index", "bbox_start", "bbox_stop_exclusive"):
            np.testing.assert_allclose(got[key], want[key], rtol=0, atol=1e-10)
        assert len(got["intensity"]) == 1, "Only the explicitly selected raw channel is measured"
        intensity = next(iter(got["intensity"].values()))
        for key, value in want["intensity"].items():
            np.testing.assert_allclose(intensity[key], value, rtol=0, atol=1e-10)


def assert_private_absent(value, private_paths: list[str]):
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    for private_path in private_paths:
        assert private_path not in text, "An input path leaked into a public artifact"
    assert "labels_import_grant" not in text, "Internal grants leaked into a public artifact"
    assert '"canonical_path"' not in text


def verify(root: Path, study: Path, exported: Path, archive: Path, records_path: Path) -> dict:
    records = json.loads(records_path.read_text())
    manifest = json.loads((root / "manifest.json").read_text())
    private_paths = [str(root), *[str(root / name) for name in manifest["sha256"]]]
    signal, labels = expected_arrays()
    _, corrected = expected_arrays(deleted=True)
    # This read-only SQLite connection does not invoke any Loci oracle.
    with sqlite3.connect(f"file:{study / 'study.sqlite3'}?mode=ro", uri=True) as connection:
        stored = {rid: json.loads(value) for rid, value in connection.execute("SELECT id,record FROM results")}
    for name, wanted, calibrated in (("parent", labels, True), ("child", corrected, True),
        ("pixel", labels, False), ("empty", np.zeros_like(labels), False)):
        inspected = records[name]
        result = stored[inspected["result"]["id"]]
        assert result["revision_hash"] == inspected["result"]["revision_hash"]
        assert_private_absent(result, private_paths)
        origin = result["provenance"]["external_labels"]
        assert origin["producer"] is None and origin["producer_identity_basis"] == "unknown"
        assert origin["upstream_validation"] == "unknown"
        assert all(origin[key] is None for key in ("upstream_settings", "upstream_model", "upstream_runtime"))
        expected_import = np.zeros_like(labels) if name == "empty" else labels
        assert origin["labels_sha256"] == hashlib.sha256(expected_import.tobytes()).hexdigest()
        assert origin["measurement_channel"]["basis"] == "raw-source-channel-values"
        assert origin["measurement_channel"]["index"] == (1 if calibrated else 0)
        assert origin["source_sha256"] == result["source_sha256"]
        assert origin["alignment"] == "same-native-yx-grid"
        for key, expected in (("labels", wanted), ("image", signal)):
            descriptor = result["arrays"][key]
            artifact = study / "artifacts" / (descriptor["sha256"] + ".npy")
            assert digest(artifact) == descriptor["sha256"]
            actual = np.load(artifact, allow_pickle=False)
            assert actual.shape == expected.shape
            if key == "labels":
                assert actual.dtype == np.dtype("uint32")
            np.testing.assert_array_equal(actual, expected)
        if name == "empty":
            assert inspected["measurements"] == []
        else:
            assert_measurements(inspected["measurements"], calibrated, name == "child")
            assert_measurements(result["provenance"]["measurements"], calibrated, name == "child")
    assert_private_absent(records["snapshot"], private_paths)
    # Parent and child are separate immutable arrays, and source stays exact.
    for name in ("calibrated-source.ome.tiff", "pixel-source.tiff", "empty-labels.tiff"):
        assert digest(root / name) == manifest["sha256"][name]
    assert not (root / "sparse-original-ids.tiff").exists(), "Original labels were intentionally removed after adoption"
    receipt = json.loads((exported / "result.json").read_text())
    assert receipt["result"]["id"] == records["child"]["result"]["id"]
    assert receipt["result"]["revision_hash"] == records["child"]["result"]["revision_hash"]
    assert receipt["review"]["disposition"] == "reviewed"
    assert_private_absent(receipt, private_paths)
    for key, expected in (("labels", corrected), ("image", signal)):
        npy = np.load(exported / (key + ".npy"), allow_pickle=False)
        tiff = tifffile.imread(exported / (key + ".ome.tif"))
        np.testing.assert_array_equal(npy, expected)
        np.testing.assert_array_equal(tiff, expected)
        assert npy.dtype == tiff.dtype
    with (exported / "objects.csv").open(newline="") as stream:
        csv_rows = list(csv.DictReader(stream))
    expected = expected_rows(True, deleted=True)
    assert len(csv_rows) == len(expected)
    csv_by_label = {int(row["label"]): row for row in csv_rows}
    assert set(csv_by_label) == {row["label"] for row in expected}
    for row in expected:
        got = csv_by_label[row["label"]]
        assert float(got["measure"]) == row["measure"]
        assert int(got["voxel_count"]) == row["voxel_count"]
        assert got["measure_unit"] == "um^2"
        for statistic in ("mean", "sum", "min", "max", "std_population"):
            keys = [key for key in got if key.startswith("intensity:") and key.endswith(":" + statistic)]
            assert len(keys) == 1
            np.testing.assert_allclose(float(got[keys[0]]), row["intensity"][statistic], rtol=0, atol=1e-8)
    methods = (exported / "methods.md").read_text()
    assert_private_absent(methods, private_paths)
    assert "external_labels" in methods and "same-native-yx-grid" in methods
    assert "unknown" in methods.lower() and "producer" in methods.lower()
    assert "parent_revision_hash" in methods
    export_manifest = json.loads((exported / "manifest.json").read_text())
    for entry in export_manifest["files"]:
        file = exported / entry["name"]
        assert digest(file) == entry["sha256"] and file.stat().st_size == entry["size_bytes"]
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        assert not any(name.endswith(".sqlite3") or "labels_import_grant" in name for name in package.namelist())
        public_records = {name: json.loads(package.read(name)) for name in package.namelist() if name.endswith(".json")}
        for value in public_records.values():
            assert_private_absent(value, private_paths)
        result_records = [value for name, value in public_records.items() if name.startswith("results/")]
        assert {r["id"] for r in result_records} == set(stored)
        for result in result_records:
            for descriptor in result["arrays"].values():
                member = "artifacts/" + descriptor["sha256"] + ".npy"
                assert hashlib.sha256(package.read(member)).hexdigest() == descriptor["sha256"]
    return {"status": "passed", "fixture_sha256": manifest["sha256"],
        "independent_counts": {"parent": COUNT, "child": COUNT - 1, "pixel": COUNT, "empty": 0},
        "original_ids": "preserved including disconnected ID1009 and uint32 max",
        "measurements": "formula-derived coordinates, calibrated/pixel areas and selected raw-channel statistics",
        "artifacts": "independently read TIFF, NPY, CSV, manifest, methods and portable ZIP",
        "privacy": "public snapshot/results/jobs/export/archive contain no input paths or internal grant records; jobs may retain opaque binding IDs"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("create", "verify"))
    parser.add_argument("--root", type=Path, required=True)
    for argument in ("study", "export", "archive", "records"):
        parser.add_argument("--" + argument, type=Path)
    args = parser.parse_args()
    if args.mode == "create":
        result = create(args.root.resolve())
    else:
        if any(getattr(args, key) is None for key in ("study", "export", "archive", "records")):
            parser.error("verify requires --study, --export, --archive and --records")
        result = verify(args.root.resolve(), args.study.resolve(), args.export.resolve(),
            args.archive.resolve(), args.records.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
