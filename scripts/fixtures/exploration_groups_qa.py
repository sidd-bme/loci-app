"""Synthetic fixture and independent SQLite/ZIP/NPY oracle; no Loci imports."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

import numpy as np
import tifffile


def create(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    image = np.zeros((2, 128, 128), dtype=np.uint16)
    for start, size, signal, marker in (
        (8, 4, 100, 10),
        (24, 6, 160, 30),
        (44, 8, 220, 50),
    ):
        image[0, start : start + size, start : start + size] = signal
        image[1, start : start + size, start : start + size] = marker
    source = root / "synthetic-signals.ome.tiff"
    tifffile.imwrite(
        source,
        image,
        ome=True,
        metadata={
            "axes": "CYX",
            "Channel": {"Name": ["Signal A", "Signal B"]},
            "PhysicalSizeX": 1.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 1.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    large = np.zeros((400, 400), dtype=np.uint16)
    for y in range(100):
        for x in range(100):
            large[y * 4 + 1 : y * 4 + 3, x * 4 + 1 : x * 4 + 3] = 100
    large_source = root / "synthetic-10000.ome.tiff"
    tifffile.imwrite(large_source, large, ome=True, metadata={"axes": "YX"})
    calibrated = np.zeros((32, 32), dtype=np.uint16)
    calibrated[4:6, 4:7] = 100
    calibrated[10:12, 10:13] = 100
    calibrated[16:18, 16:19] = 100
    calibrated_source = root / "synthetic-calibrated-repeated.ome.tiff"
    tifffile.imwrite(
        calibrated_source,
        calibrated,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.25,
            "PhysicalSizeYUnit": "µm",
        },
    )
    second = np.zeros((32, 32), dtype=np.uint16)
    second[4:10, 4:10] = 150
    second_source = root / "synthetic-second-source.ome.tiff"
    tifffile.imwrite(
        second_source,
        second,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 1.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 1.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    manifest = {
        "schema": "loci.exploration-groups-fixture/v1",
        "licence": "Apache-2.0; newly generated mathematical fixture; no patient/laboratory data",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source": source.name,
        "large_source": large_source.name,
        "large_source_sha256": hashlib.sha256(large_source.read_bytes()).hexdigest(),
        "calibrated_source": calibrated_source.name,
        "calibrated_source_sha256": hashlib.sha256(
            calibrated_source.read_bytes()
        ).hexdigest(),
        "second_source": second_source.name,
        "second_source_sha256": hashlib.sha256(second_source.read_bytes()).hexdigest(),
        "large_oracle": {"objects": 10000, "pixels_per_object": 4, "raw_mean": 100},
        "shape_cyx": list(image.shape),
        "geometry": "1 micrometre square pixels, no resampling",
        "oracles": {
            "threshold64": {
                "count": 3,
                "area_um2": [16, 36, 64],
                "mean_raw": [100, 160, 220],
            },
            "threshold128": {"count": 2, "area_um2": [36, 64]},
            "threshold192": {"count": 1, "area_um2": [64]},
            "rectangle": [1, 2],
            "polygon": [1, 2, 3],
            "unclassified": [3],
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def verify(root: Path, study: Path, archive: Path):
    manifest = json.loads((root / "manifest.json").read_text())
    assert (
        hashlib.sha256((root / manifest["source"]).read_bytes()).hexdigest()
        == manifest["source_sha256"]
    )
    assert (
        hashlib.sha256((root / manifest["calibrated_source"]).read_bytes()).hexdigest()
        == manifest["calibrated_source_sha256"]
    )
    assert (
        hashlib.sha256((root / manifest["second_source"]).read_bytes()).hexdigest()
        == manifest["second_source_sha256"]
    )
    with sqlite3.connect(f"file:{study / 'study.sqlite3'}?mode=ro", uri=True) as db:
        results = [
            json.loads(row[0]) for row in db.execute("SELECT record FROM results")
        ]
        groups = [
            json.loads(row[0])
            for row in db.execute(
                "SELECT record FROM documents WHERE kind='population_group'"
            )
        ]
        comparisons = [
            json.loads(row[0])
            for row in db.execute(
                "SELECT record FROM documents WHERE kind='exploration'"
            )
        ]
    result = next(
        item
        for item in results
        if item["kind"] == "segmentation"
        and item["provenance"]["recipe"]["segmentation"]["threshold"] == 64
    )
    rows = result["provenance"]["measurements"]
    assert [row["measure"] for row in rows] == [16, 36, 64]
    assert [row["voxel_count"] for row in rows] == [16, 36, 64]
    assert [next(iter(row["intensity"].values()))["mean"] for row in rows] == [
        100,
        160,
        220,
    ]
    assert [next(iter(row["intensity"].values()))["sum"] for row in rows] == [
        1600,
        5760,
        14080,
    ]
    labels_ref = result["arrays"]["labels"]
    # Resolve only the relative artifact locator already in the generated study.
    labels = np.load(
        study / "artifacts" / (labels_ref["sha256"] + ".npy"), allow_pickle=False
    )
    assert [int(np.count_nonzero(labels == label)) for label in (1, 2, 3)] == [
        16,
        36,
        64,
    ]
    associated = next(
        item for item in results if item["kind"] == "nucleus-cell-association"
    )
    compartment_rows = associated["provenance"]["measurements"]
    assert [row["compartments"]["nuclear"]["measure"] for row in compartment_rows] == [
        0,
        0,
        64,
    ]
    assert [
        row["compartments"]["cytoplasm"]["measure"] for row in compartment_rows
    ] == [16, 36, 0]
    for row in compartment_rows:
        whole, nuclear, remaining = (
            row["compartments"][name] for name in ("cell", "nuclear", "cytoplasm")
        )
        assert whole["measure"] == nuclear["measure"] + remaining["measure"]
        channel = next(iter(whole["intensity"]))
        assert (
            whole["intensity"][channel]["sum"]
            == nuclear["intensity"][channel]["sum"]
            + remaining["intensity"][channel]["sum"]
        )
    expected = {
        "Small": [1, 2],
        "All": [1, 2, 3],
        "Remainder": [3],
        "Nuclear-high": [3],
        "Small-compartments": [1, 2],
    }
    for name, members in expected.items():
        group = next(item for item in groups if item["data"]["name"] == name)
        receipt = group["data"]["receipt"]
        assert receipt["labels"] == members
        target = (
            associated if name in {"Nuclear-high", "Small-compartments"} else result
        )
        assert receipt["result_id"] == target["id"]
        assert receipt["revision_hash"] == target["revision_hash"]
        assert receipt["source_sha256"] == manifest["source_sha256"]
    assert len(comparisons) >= 1
    matrix = comparisons[0]["data"]
    assert len(matrix["cells"]) == 9
    assert [cell["receipt"]["object_count"] for cell in matrix["cells"]] == [
        3,
        2,
        1,
    ] * 3
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        for document in groups + comparisons:
            saved = json.loads(
                bundle.read(f"documents/{document['kind']}/{document['id']}.json")
            )
            assert saved == document
    downloads = root.parent / "downloads"
    comparison_file = next(downloads.glob("*-loci-exploration.json"))
    downloaded = json.loads(comparison_file.read_text())
    assert (
        downloaded["receipt_sha256"]
        == hashlib.sha256(
            json.dumps(
                {
                    key: value
                    for key, value in downloaded.items()
                    if key != "receipt_sha256"
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()
    )
    group_file = next(downloads.glob("*-loci-population-group.json"))
    downloaded_group = json.loads(group_file.read_text())["data"]
    assert downloaded_group["receipt"]["labels"] == [1, 2]
    assert (
        downloaded_group["record_sha256"]
        == hashlib.sha256(
            json.dumps(
                {
                    key: value
                    for key, value in downloaded_group.items()
                    if key != "record_sha256"
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()
    )
    return {
        "status": "passed",
        "groups": expected,
        "comparison_counts": [3, 2, 1] * 3,
        "raw_measurements": "unchanged",
        "archive_records": "byte-semantic exact",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["create", "verify"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--study", type=Path)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    result = (
        create(args.root)
        if args.operation == "create"
        else verify(args.root, args.study, args.archive)
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
