"""Independent synthetic native-grid perinuclear QA; never imports Loci code.

Create explicitly artificial CYX uint16 data; verify saved/exported arrays and
raw integer arithmetic with NumPy/SciPy, not the application's implementation.
This is software regression evidence, never scientific domain qualification.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import scipy
import tifffile
from scipy import ndimage

SIZE = 128
CENTERS = [(0, 30), (40, 45), (40, 68), (96, 30), (96, 96)]
REASONS = ["boundary-touching-nucleus", "empty-ring", "zero-mean-ring"]


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def arrays():
    yy, xx = np.indices((SIZE, SIZE))
    dna = np.full((SIZE, SIZE), 100, np.uint16)
    for y, x in CENTERS:
        dna[(yy - y) ** 2 + (xx - x) ** 2 <= 8 ** 2] = 4000
    signal = (1000 + 3 * yy + 2 * xx).astype(np.uint16)
    # One isolated object's complete neighborhood is zero, exercising an
    # undefined ratio without epsilon or imputation. Other objects stay eligible.
    signal[78:115, 12:49] = 0
    return dna, signal


def create(root):
    root.mkdir(parents=True, exist_ok=False)
    dna, signal = arrays()
    file = root / "synthetic-dna-and-signal.ome.tiff"
    tifffile.imwrite(file, np.stack([dna, signal]), ome=True, photometric="minisblack", metadata={
        "axes": "CYX", "PhysicalSizeX": 0.5, "PhysicalSizeXUnit": "µm",
        "PhysicalSizeY": 1.0, "PhysicalSizeYUnit": "µm",
        "Channel": {"Name": ["synthetic-DNA-proxy", "synthetic-raw-signal"]},
    })
    manifest = {
        "schema": "loci.perinuclear-synthetic-fixture/v1",
        "purpose": "Synthetic software QA only; no biological or clinical validation",
        "source_name": file.name, "sha256": digest(file), "axes": "CYX",
        "shape": [2, SIZE, SIZE], "dtype": "uint16", "centers_yx": CENTERS,
        "dna_formula": "C0=4000 inside radius8 disks at centers_yx, otherwise100",
        "signal_formula": "C1=1000+3*y+2*x except [78:115,12:49]=0",
        "calibration_xy_um": [0.5, 1.0], "radius_px": 5,
        "settings": {"image_mode": "fluorescence", "polarity": "bright", "expected_diameter_px": 18,
                     "min_area_px": 35, "sensitivity": 0, "smoothing_px": 0,
                     "split_touching": True, "exclude_border": False},
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def close(actual, expected):
    if expected is None:
        assert actual is None, (actual, expected)
    else:
        assert np.isfinite(actual)
        assert abs(actual - expected) <= 1e-9 + 1e-12 * abs(expected), (actual, expected)


def oracle(labels, raw, geometry, channel, rings=False):
    """Full-image EDT for each actual label; no engine bounding-box kernel."""
    ids = np.unique(labels[labels > 0])
    candidates = np.stack([(labels == 0) & (ndimage.distance_transform_edt(labels != label) <= 5)
                           for label in ids])
    claims = candidates.sum(axis=0)
    owners = np.zeros(labels.shape, np.uint32)
    for label, candidate in zip(ids, candidates, strict=True):
        owners[candidate & (claims == 1)] = label
    ambiguous = (claims > 1).astype(np.uint8)
    affine = np.asarray(geometry["affine"], dtype=np.float64)
    assert geometry["axes"] == "YX" and geometry["unit"] == "um" and geometry["frame"] == "image"
    np.testing.assert_array_equal(affine, np.diag([0.5, 1.0, 1.0, 1.0]))
    basis = affine[:3, :2]
    element_area = float(np.sqrt(np.linalg.det(basis.T @ basis)))
    close(element_area, 0.5)
    rows = []
    for label in ids:
        coordinates = np.argwhere(labels == label)
        world = coordinates[:, ::-1] @ basis.T + affine[:3, 3]
        values = raw[labels == label]
        total = int(values.sum(dtype=np.uint64))
        start, stop = coordinates.min(axis=0), coordinates.max(axis=0) + 1
        touching = bool(np.any(start == 0) or np.any(stop == labels.shape))
        covariance = np.cov(world, rowvar=False, bias=True) if len(world) > 1 else np.zeros((3, 3))
        row = {"label": int(label), "voxel_count": len(values), "measure": len(values) * element_area,
               "measure_kind": "area", "measure_unit": "um^2", "centroid_index": coordinates.mean(axis=0).tolist(),
               "index_axes": "YX", "centroid_world_xyz": world.mean(axis=0).tolist(),
               "world_frame": geometry["frame"], "distance_unit": "um", "bbox_start": start.tolist(),
               "bbox_stop_exclusive": stop.tolist(), "touches_crop_border": touching,
               "principal_rms_radii": np.sqrt(np.maximum(np.linalg.eigvalsh(covariance), 0)[::-1]).tolist(),
               "intensity": {f"source_channel_{channel}": {
                   "sum": total, "mean": total / len(values), "min": int(values.min()), "max": int(values.max()),
                   "std_population": float(values.astype(np.float64).std(ddof=0))}}}
        if rings:
            samples = raw[owners == label]
            count = len(samples)
            ring_sum = int(samples.sum(dtype=np.uint64))
            mean = ring_sum / count if count else None
            reasons = ([REASONS[0]] if touching else []) + ([REASONS[1]] if not count else [REASONS[2]] if mean == 0 else [])
            row["perinuclear_ring"] = {"count": count, "sum": ring_sum, "mean": mean,
                "nuclear_to_ring_mean_ratio": None if reasons else (total / len(values)) / mean, "exclusions": reasons}
        rows.append(row)
    for row in rows:
        distances = [float(np.linalg.norm(np.asarray(row["centroid_world_xyz"]) - other["centroid_world_xyz"]))
                     for other in rows if other["label"] != row["label"]]
        row["nearest_centroid_distance"] = min(distances) if distances else None
    return rows, owners, ambiguous


def compare(actual, expected, key=""):
    if isinstance(expected, dict):
        assert set(actual) == set(expected), (key, set(actual), set(expected))
        for name, value in expected.items():
            compare(actual[name], value, key + "." + name)
    elif isinstance(expected, list):
        assert len(actual) == len(expected), key
        for index, value in enumerate(expected):
            compare(actual[index], value, key + "." + str(index))
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        # Counts and uint16->uint64 sums are exact; only floating quantities use tolerance.
        if key.endswith((".sum", ".count", ".voxel_count", ".label")):
            assert actual == expected, (key, actual, expected)
        else:
            close(actual, expected)
    else:
        assert actual == expected, (key, actual, expected)


def flat(value, prefix=""):
    if isinstance(value, dict):
        return {k: v for name, item in value.items() for k, v in flat(item, prefix + name + ":").items()}
    if isinstance(value, list):
        return {k: v for i, item in enumerate(value) for k, v in flat(item, prefix + str(i) + ":").items()}
    return {prefix[:-1]: value}


def ome_metadata(file):
    with tifffile.TiffFile(file) as image:
        assert len(image.series) == 1
        root = ET.fromstring(image.ome_metadata)
        # tifffile creates a fresh container UUID for each write. Remove ONLY
        # UUID attribute values and UUID-element text; retain every other field.
        for node in root.iter():
            if "UUID" in node.attrib:
                node.attrib["UUID"] = "GENERATED-CONTAINER-UUID"
            if node.tag.rsplit("}", 1)[-1] == "UUID":
                node.text = "GENERATED-CONTAINER-UUID"
        return {"axes": image.series[0].axes, "dtype": str(image.series[0].dtype),
                "shape": list(image.series[0].shape), "ome_xml_except_uuid": ET.tostring(root, encoding="unicode")}


def verify(root, study, records_path, before, after):
    manifest = json.loads((root / "manifest.json").read_text())
    source = root / manifest["source_name"]
    assert digest(source) == manifest["sha256"]
    dna, signal = arrays()
    np.testing.assert_array_equal(tifffile.imread(source), np.stack([dna, signal]))
    records = json.loads(records_path.read_text())
    with sqlite3.connect(f"file:{study / 'study.sqlite3'}?mode=ro", uri=True) as db:
        stored = {rid: json.loads(record) for rid, record in db.execute("SELECT id,record FROM results")}
    assert len(stored) == 2
    parent, child = [stored[records[key]["result"]["id"]] for key in ("parent", "child")]
    assert parent["kind"] == "adaptive-segmentation" and child["kind"] == "perinuclear-enrichment"
    loaded = {}
    for name, result in (("parent", parent), ("child", child)):
        assert result["revision_hash"] == records[name]["result"]["revision_hash"]
        assert result["source_sha256"] == manifest["sha256"]
        loaded[name] = {}
        for field, descriptor in result["arrays"].items():
            file = study / "artifacts" / (descriptor["sha256"] + ".npy")
            assert digest(file) == descriptor["sha256"] and file.stat().st_size == descriptor["bytes"]
            array = np.load(file, allow_pickle=False)
            assert array.shape == tuple(descriptor["shape"]) == (SIZE, SIZE)
            assert str(array.dtype) == descriptor["dtype"]
            loaded[name][field] = array
    labels = loaded["parent"]["labels"]
    assert labels.dtype == np.uint32
    ids = np.unique(labels[labels > 0])
    assert len(ids) == len(CENTERS) == len({int(labels[y, x]) for y, x in CENTERS})
    assert all(labels[y, x] > 0 for y, x in CENTERS)
    yy, xx = np.indices(labels.shape)
    envelope = np.zeros(labels.shape, bool)
    for y, x in CENTERS:
        envelope |= (yy-y)**2 + (xx-x)**2 <= 12**2
    assert not np.any((labels > 0) & ~envelope), "Unexpected foreground beyond synthetic disk neighborhoods"
    np.testing.assert_array_equal(loaded["parent"]["image"], (dna == 4000).astype(np.float32))
    np.testing.assert_array_equal(loaded["child"]["image"], signal)
    np.testing.assert_array_equal(loaded["child"]["labels"], labels)
    assert child["arrays"]["labels"] == parent["arrays"]["labels"]
    assert child["parent_id"] == parent["id"]
    assert child["provenance"]["parent_result"]["revision_hash"] == parent["revision_hash"]
    assert parent["provenance"]["settings"] == manifest["settings"]
    assert parent["provenance"]["selection"]["c"] == 0
    assert child["provenance"]["selection"] == {**parent["provenance"]["selection"], "c": 1}
    assert child["provenance"]["measurement_channels"] == [1]
    assert child["provenance"]["measurement_basis"] == "raw-selected-channel-values-on-result-grid"
    expected = {}
    for name, result, raw, channel in (("parent", parent, dna, 0), ("child", child, signal, 1)):
        rows, owners, ambiguous = oracle(labels, raw, result["provenance"]["geometry"], channel, name == "child")
        compare(records[name]["measurements"], rows, name)
        compare(result["provenance"]["measurements"], rows, name)
        expected[name] = rows
    np.testing.assert_array_equal(loaded["child"]["ring_labels"], owners)
    np.testing.assert_array_equal(loaded["child"]["ring_ambiguous"], ambiguous)
    assert owners.dtype == np.uint32 and ambiguous.dtype == np.uint8
    assert np.any(ambiguous), "Fixture must exercise discarded shared ring pixels"
    ratios = [row["perinuclear_ring"]["nuclear_to_ring_mean_ratio"] for row in rows if not row["perinuclear_ring"]["exclusions"]]
    excluded = {reason: sum(reason in row["perinuclear_ring"]["exclusions"] for row in rows) for reason in REASONS}
    assert excluded[REASONS[0]] > 0 and excluded[REASONS[2]] > 0 and ratios
    summary = {"object_count": len(rows), "eligible_count": len(ratios), "excluded_count": len(rows)-len(ratios),
               "excluded_by_reason": excluded, "endpoint_defined": True,
               "median_ratio": float(np.median(ratios)), "mean_ratio": sum(ratios)/len(ratios)}
    compare(child["provenance"]["perinuclear"]["summary"], summary, "summary")
    assert child["provenance"]["perinuclear"]["radius_px"] == 5
    assert child["provenance"]["perinuclear"]["signal_channel"] == 1
    assert "SIMULATED automated" in child["provenance"]["perinuclear"]["control"]
    export_reports = []
    for directory in (before, after):
        native = json.loads((directory / "result.json").read_text())
        assert native["result"] == child
        assert native["review"]["disposition"] == "reviewed"
        assert json.loads((directory / "perinuclear-summary.json").read_text()) == child["provenance"]["perinuclear"]
        export_manifest = json.loads((directory / "manifest.json").read_text())
        assert export_manifest["result_id"] == child["id"] and export_manifest["revision_hash"] == child["revision_hash"]
        assert {entry["name"] for entry in export_manifest["files"]} == {file.name for file in directory.iterdir()} - {"manifest.json"}
        for entry in export_manifest["files"]:
            file = directory / entry["name"]
            assert file.is_file() and not file.is_symlink()
            assert digest(file) == entry["sha256"] and file.stat().st_size == entry["size_bytes"]
        for field, array in loaded["child"].items():
            for suffix in (".npy", ".ome.tif"):
                file = directory / (field + suffix)
                actual = np.load(file, allow_pickle=False) if suffix == ".npy" else tifffile.imread(file)
                assert actual.dtype == array.dtype
                np.testing.assert_array_equal(actual, array)
            assert digest(directory / (field + ".npy")) == child["arrays"][field]["sha256"]
        with (directory / "objects.csv").open(newline="") as stream:
            exported_rows = list(csv.DictReader(stream))
        assert len(exported_rows) == len(rows)
        for actual, expected_row in zip(exported_rows, rows, strict=True):
            csv_expected = flat({key: value for key, value in expected_row.items() if key != "perinuclear_ring"})
            for key, value in expected_row["perinuclear_ring"].items():
                csv_expected["perinuclear_ring:" + key] = str(value) if isinstance(value, list) else value
            for key, value in csv_expected.items():
                # The native CSV encodes nested exclusion lists as literal text;
                # preserve their exact contents, including an explicit empty list.
                if value is None:
                    assert actual[key] == ""
                elif isinstance(value, bool):
                    assert actual[key].lower() == str(value).lower()
                elif isinstance(value, (int, float)):
                    compare(float(actual[key]), value, "csv." + key.replace(":", "."))
                else:
                    assert actual[key] == value, (key, actual[key], value)
        export_reports.append({"manifest_sha256": digest(directory / "manifest.json"), "files": export_manifest["files"]})
    assert sorted(file.name for file in before.iterdir()) == sorted(file.name for file in after.iterdir())
    for first in before.iterdir():
        second = after / first.name
        if first.name.endswith(".ome.tif"):
            assert ome_metadata(first) == ome_metadata(second), first.name
        elif first.name != "manifest.json":
            assert first.read_bytes() == second.read_bytes(), first.name
    # Input paths and internal source locators never belong in public payloads.
    for value in (records["snapshot"], *(json.loads((d / "result.json").read_text()) for d in (before, after))):
        text = json.dumps(value)
        assert str(root) not in text and '"canonical_path"' not in text and '"private_path"' not in text
    return {"status": "passed", "runtime": {"numpy": np.__version__, "scipy": scipy.__version__, "tifffile": tifffile.__version__},
            "fixture_sha256": manifest["sha256"], "summary": summary, "shared_ring_pixels": int(ambiguous.sum()),
            "exports": export_reports,
            "cold_reopen_payload_comparison": "Exact bytes except OME TIFF container UUIDs; decoded arrays/dtypes and complete OME metadata with only UUID attributes and UUID-element text normalized are identical; each original container hash retained above",
            "review": "SIMULATED automated GUI review gate exercise, never human scientific approval; original interface actor preserved"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("create", "verify"))
    parser.add_argument("--root", required=True, type=Path)
    for name in ("study", "records", "before", "after"):
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args()
    if args.mode == "create":
        result = create(args.root.resolve())
    else:
        if any(getattr(args, name) is None for name in ("study", "records", "before", "after")):
            parser.error("verify requires --study, --records, --before and --after")
        result = verify(args.root.resolve(), args.study.resolve(), args.records.resolve(), args.before.resolve(), args.after.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
