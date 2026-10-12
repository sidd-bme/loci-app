#!/usr/bin/env python3
"""Independent known-area fixtures/oracle; never imports the Loci engine."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sqlite3
import zipfile
from pathlib import Path

import numpy as np
import tifffile


SIZE = 256
FIELDS = (
    ("r1-corrected", [2, 6], "replicate-1"),
    ("r1-context", [8], "replicate-1"),
    ("r2-field-a", [1, 1, 1], "replicate-2"),
    ("r2-field-b", [12, 12], "replicate-2"),
    ("r2-field-c", [20], "replicate-2"),
)


def digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def arrays(index: int, corrected: bool = False) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.indices((SIZE, SIZE))
    # Authored distinct source bytes prevent source deduplication.
    image = (1000 + index * 100 + 3 * yy + 2 * xx).astype(np.uint16)
    labels = np.zeros((SIZE, SIZE), dtype=np.uint32)
    for ordinal, area in enumerate(FIELDS[index][1], start=1):
        if corrected and index == 0 and ordinal == 1:
            continue
        y, x = 30 + 30 * ordinal, 40 + 40 * ordinal
        labels[y, x:x + area] = ordinal
    return image, labels


def create(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    fields = []
    for index, (name, areas, replicate) in enumerate(FIELDS):
        image, labels = arrays(index)
        for suffix, data in (("source", image), ("labels", labels)):
            tifffile.imwrite(root / f"{name}-{suffix}.tiff", data,
                photometric="minisblack", metadata={"axes": "YX"})
        fields.append({"name": name, "areas": areas, "replicate": replicate,
            "before_mean": sum(areas) / len(areas),
            "after_mean": 6 if index == 0 else sum(areas) / len(areas)})
    manifest = {"schema": "loci.correction-effect-synthetic-fixture/v1",
        "purpose": "Software qualification only; no biological validation",
        "shape_yx": [SIZE, SIZE], "measure_unit": "pixel^2", "fields": fields,
        "correction": {"operation": "delete", "label_id": 1, "changed_voxels": 2},
        "oracle": {"replicate-1": {"before_mean": 6, "after_mean": 7, "difference": 1, "image_pair_count": 2},
            "replicate-2": {"before_mean": 11, "after_mean": 11, "difference": 0, "image_pair_count": 3},
            "condition": {"before_mean": 8.5, "after_mean": 9, "difference": 0.5, "n_biological_replicates": 2}},
        "metadata_recalculation": "move r2-field-c from replicate-2 to replicate-1; condition change becomes 1/3",
        "sha256": {file.name: digest(file) for file in sorted(root.glob("*.tiff"))}}
    assert len(set(manifest["sha256"][f"{name}-source.tiff"] for name, _, _ in FIELDS)) == 5
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def close(actual, expected):
    assert isinstance(actual, (float, int)) and not isinstance(actual, bool)
    assert math.isfinite(actual) and math.isclose(actual, expected, rel_tol=0, abs_tol=1e-10), (actual, expected)


def private_absent(value, root: Path):
    text = value if isinstance(value, str) else json.dumps(value)
    assert str(root) not in text, "Private input path leaked"
    for key in ("canonical_path", "labels_import_grant", "source_grant"):
        assert key not in text, "Internal grant/path leaked: " + key


def receipt_oracle(receipt: dict, moved: bool):
    assert receipt["schema"] == "loci.study-correction-effect/v1"
    assert receipt["unit"] == "pixel^2" and receipt["value"] == "measure"
    assert receipt["p_values"] is None
    assert "equal images" in receipt["weighting"] and "equal biological replicates" in receipt["weighting"]
    assert len(receipt["images"]) == 5
    by_sample = {row["metadata"]["sample"]: row for row in receipt["images"]}
    assert set(by_sample) == {name for name, _, _ in FIELDS}
    for index, (name, areas, replicate) in enumerate(FIELDS):
        row = by_sample[name]
        wanted_after = areas[1:] if index == 0 else areas
        assert row["metadata"]["condition"] == "synthetic-condition"
        assert row["metadata"]["biological_replicate"] == ("replicate-1" if moved and index == 4 else replicate)
        assert row["before_count"] == len(areas) and row["after_count"] == len(wanted_after)
        assert row["count_difference"] == (-1 if index == 0 else 0)
        close(row["before_mean"], sum(areas) / len(areas))
        close(row["after_mean"], sum(wanted_after) / len(wanted_after))
        close(row["mean_difference"], 2 if index == 0 else 0)
        assert row["eligible"] is True and row["omission_reasons"] == []
        if index == 0:
            audit = row["correction"]
            assert audit["changed_voxel_count"] == 2
            assert audit["added_label_ids"] == [] and audit["removed_label_ids"] == [1]
            assert audit["changed_retained_label_ids"] == []
            assert len(audit["operations"]) == 1 and audit["operations"][0]["op"] == "delete"
            assert audit["operations"][0]["label"] == 1
        else:
            assert row["before_result_id"] == row["after_result_id"] and row["correction"] is None
    replicates = {row["biological_replicate"]: row for row in receipt["replicates"]}
    assert set(replicates) == {"replicate-1", "replicate-2"}
    # These constants come from authored areas, rather than the report's own
    # contributing values. Field and object pooling yield different answers.
    expected = {"replicate-1": (32 / 3, 34 / 3, 2 / 3, 3), "replicate-2": (6.5, 6.5, 0, 2)} if moved else {
        "replicate-1": (6, 7, 1, 2), "replicate-2": (11, 11, 0, 3)}
    for key, (before, after, delta, count) in expected.items():
        row = replicates[key]
        close(row["before_mean"], before)
        close(row["after_mean"], after)
        close(row["mean_difference"], delta)
        assert row["image_pair_count"] == count and row["omitted_image_pair_count"] == 0
    assert len(receipt["conditions"]) == 1
    condition = receipt["conditions"][0]
    assert condition["condition"] == "synthetic-condition" and condition["biological_n"] == 2
    assert condition["image_pair_count"] == 5 and condition["omitted_image_pair_count"] == 0
    for key, expected in (("before_mean", 103 / 12 if moved else 8.5),
        ("after_mean", 107 / 12 if moved else 9), ("mean_difference", 1 / 3 if moved else 0.5)):
        close(condition[key], expected)


def verify(root: Path, study: Path, exported: Path, archive: Path, records_path: Path) -> dict:
    records = json.loads(records_path.read_text())
    manifest = json.loads((root / "manifest.json").read_text())
    with sqlite3.connect(f"file:{study / 'study.sqlite3'}?mode=ro", uri=True) as connection:
        stored = {rid: json.loads(value) for rid, value in connection.execute("SELECT id,record FROM results")}
        comparisons = [json.loads(value) for (value,) in connection.execute("SELECT record FROM documents WHERE kind='comparison'")]
    assert len(stored) == 6, "Metadata/reports must not create segmentation arrays"
    for index, (name, areas, _) in enumerate(FIELDS):
        for role in ("parent", "child") if index == 0 else ("context",):
            inspected = records["results"][name][role]
            result = stored[inspected["result"]["id"]]
            assert result["revision_hash"] == inspected["result"]["revision_hash"]
            private_absent(result, root)
            image, labels = arrays(index, corrected=role == "child")
            for key, expected in (("image", image), ("labels", labels)):
                descriptor = result["arrays"][key]
                artifact = study / "artifacts" / (descriptor["sha256"] + ".npy")
                assert digest(artifact) == descriptor["sha256"]
                np.testing.assert_array_equal(np.load(artifact, allow_pickle=False), expected)
            wanted_areas = areas[1:] if role == "child" else areas
            measurements = inspected["measurements"]
            assert len(measurements) == len(wanted_areas)
            for row, area in zip(measurements, wanted_areas, strict=True):
                assert row["measure_unit"] == "pixel^2" and row["measure_kind"] == "area"
                assert row["voxel_count"] == area
                close(row["measure"], area)
            assert result["provenance"]["measurements"] == measurements
    for name, expected in manifest["sha256"].items():
        assert digest(root / name) == expected, "Synthetic source/labels changed"
    receipts = [document["data"]["receipt"] for document in comparisons]
    assert all(receipt["schema"] == "loci.study-correction-effect/v1" for receipt in receipts)
    assert records["final_receipt"] in receipts
    receipt_oracle(records["pending_receipt"], False)
    receipt_oracle(records["baseline_receipt"], False)
    receipt_oracle(records["final_receipt"], True)
    for receipt in receipts:
        moved = next(row for row in receipt["images"] if row["metadata"]["sample"] == "r2-field-c")["metadata"]["biological_replicate"] == "replicate-1"
        receipt_oracle(receipt, moved)
    # JSON, CSV and archive checks are defined against exact public report fields
    # below, independently of the application implementation.
    verify_report(exported, records, root)
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        public = {name: json.loads(package.read(name)) for name in package.namelist() if name.endswith(".json")}
        for value in public.values():
            private_absent(value, root)
        assert any(value.get("data", {}).get("receipt") == records["final_receipt"] for value in public.values()), "Portable report receipt absent"
        for name, value in public.items():
            if name.startswith("results/"):
                for descriptor in value["arrays"].values():
                    assert hashlib.sha256(package.read("artifacts/" + descriptor["sha256"] + ".npy")).hexdigest() == descriptor["sha256"]
    return {"status": "passed", "fixture_sha256": manifest["sha256"],
        "oracle": manifest["oracle"], "metadata_condition_difference": 1 / 3,
        "artifacts": "Independent NPY, SQLite, report JSON/CSV/methods/manifest and portable ZIP reads",
        "limitation": "Synthetic numerical/structural software check only"}


def verify_report(exported: Path, records: dict, root: Path):
    expected_files = {"receipt.json", "image-pairs.csv", "biological-replicates.csv", "conditions.csv", "methods.txt", "manifest.json"}
    assert {file.name for file in exported.iterdir()} == expected_files, "Incomplete or unexpected export artifact"
    receipt = json.loads((exported / "receipt.json").read_text())
    assert receipt == records["final_receipt"]
    receipt_oracle(receipt, True)
    payload = {key: value for key, value in receipt.items() if key != "receipt_sha256"}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    assert hashlib.sha256(encoded).hexdigest() == receipt["receipt_sha256"], "Receipt digest is inconsistent"
    assert all(row["needs_review"] is False for row in receipt["images"])
    assert all(binding["review"]["disposition"] == "reviewed" for binding in receipt["before_bindings"] + receipt["after_bindings"])
    for filename, key, identifier in (("image-pairs.csv", "images", "source_id"),
        ("biological-replicates.csv", "replicates", "biological_replicate"), ("conditions.csv", "conditions", "condition")):
        with (exported / filename).open(newline="") as stream:
            csv_rows = list(csv.DictReader(stream))
        expected_rows = receipt[key]
        assert len(csv_rows) == len(expected_rows)
        actual = {row[identifier]: row for row in csv_rows}
        assert len(actual) == len(csv_rows)
        for expected in expected_rows:
            row = actual[expected[identifier]]
            assert row["unit"] == "pixel^2"
            for field, value in expected.items():
                if field == "correction":
                    continue
                if field == "metadata":
                    for metadata_key, metadata_value in value.items():
                        assert row[metadata_key] == ("" if metadata_value is None else str(metadata_value))
                elif isinstance(value, bool):
                    assert row[field] == str(value)
                elif isinstance(value, (float, int)):
                    close(float(row[field]), value)
                elif isinstance(value, list):
                    assert json.loads(row[field]) == value
                else:
                    assert row[field] == ("" if value is None else str(value))
    # A negative count is numeric, never CSV formula escaping or absolute value.
    with (exported / "image-pairs.csv").open(newline="") as stream:
        assert next(row for row in csv.DictReader(stream) if row["sample"] == "r1-corrected")["count_difference"] == "-1"
    methods = (exported / "methods.txt").read_text()
    for phrase in (receipt["receipt_sha256"], "pixel^2", "equal images within biological replicate",
        "equal biological replicates within condition", "identical eligible image pairs", "after minus before",
        "Counts are descriptive", "no p-values", "empty", "null", "blank in CSV"):
        assert phrase in methods, "Missing scientific method disclosure: " + phrase
    manifest = json.loads((exported / "manifest.json").read_text())
    assert manifest["schema"] == "loci.correction-effect-export/v1"
    assert manifest["receipt_sha256"] == receipt["receipt_sha256"]
    assert {entry["name"] for entry in manifest["files"]} == expected_files - {"manifest.json"}
    assert len(manifest["files"]) == 5
    for entry in manifest["files"]:
        artifact = exported / entry["name"]
        assert digest(artifact) == entry["sha256"] and artifact.stat().st_size == entry["size_bytes"]
    for file in exported.iterdir():
        private_absent(file.read_text(), root)


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
        result = verify(args.root.resolve(), args.study.resolve(), args.export.resolve(), args.archive.resolve(), args.records.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
