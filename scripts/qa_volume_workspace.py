#!/usr/bin/env python3
"""Prepare exact fixtures and independently verify the packaged 3D workspace.

Preparation never starts Loci, creates a result, downloads data or grants an
agent access. The separate Playwright journey is lead-run. Public biological
inputs remain technical annotation/display evidence, not biological validation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

import numpy as np
import tifffile

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / ".loci/evidence/2026-10-30/research-program/public-data"
KIDNEY = REPO / ".loci/archive/qualification/2026-09-08/image-first/public-fixtures"
PINS = {
    "c5image.tif": "7aadf9c004aa4c89573bfe1d9d4e5d3d5bd0f8f50c5ddffc3ed4c22b1c0a1cff",
    "c5labels_new_label.tif": "61c2fd06391622264e48bb8c1cc796ccce88e7929d17e1b5fb98a44c9e003e18",
    "Kidney fluorescence.ome.tiff": (
        "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564"
    ),
}


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def numerical_hash(labels):
    metadata = json.dumps(
        {"dtype": "<u4", "shape": list(labels.shape)}, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(
        b"loci-label-array-v1\0"
        + metadata.encode()
        + b"\0"
        + labels.astype("<u4").tobytes(order="C")
    ).hexdigest()


def synthetic_arrays():
    t, c, z, y, x = np.indices((2, 2, 16, 48, 64))
    raw = (10000 * t + 4000 * c + 200 * z + 3 * y + x).astype(np.uint16)
    labels = np.zeros((12, 48, 64), np.uint32)
    labels[0:4, 3:9, 6:12] = 17
    labels[-1, -2, -3] = 17  # disconnected ID remains one volumetric object
    labels[4:8, 17:23, 23:29] = 65536
    labels[3:10, 30:39, 42:51] = 2**32 - 1
    return raw, labels


def expected_rows(labels, raw, affine, unit):
    rows = []
    for label in np.unique(labels):
        if label == 0:
            continue
        mask = labels == label
        coordinates = np.argwhere(mask)
        center = coordinates.mean(axis=0)
        values = raw[mask].astype(np.float64)
        rows.append(
            {
                "label": int(label),
                "voxel_count": len(coordinates),
                "measure": len(coordinates) * abs(float(np.linalg.det(affine[:3, :3]))),
                "measure_kind": "volume",
                "measure_unit": unit + "^3",
                "index_axes": "ZYX",
                "centroid_index": center.tolist(),
                "centroid_world_xyz": (affine @ [*center[::-1], 1])[:3].tolist(),
                "bbox_start": coordinates.min(axis=0).tolist(),
                "bbox_stop_exclusive": (coordinates.max(axis=0) + 1).tolist(),
                "intensity": {
                    "sum": float(values.sum()),
                    "mean": float(values.mean()),
                    "min": float(values.min()),
                    "max": float(values.max()),
                    "std_population": float(values.std(ddof=0)),
                },
            }
        )
    return rows


def pinned(path):
    path = Path(path).resolve(strict=True)
    require(sha(path) == PINS[path.name], "Public fixture fingerprint changed: " + path.name)
    return {"path": str(path), "sha256": PINS[path.name]}


def public_arrays(case, public=PUBLIC, kidney=KIDNEY):
    """Read only existing pinned public inputs and retained rights evidence."""
    if case == "cellseg3d":
        rights_path = public / "source-rights-and-gaps.json"
        rights = json.loads(rights_path.read_text())["cellseg3d"]
        require(rights["api_license"]["id"] == "cc-by-4.0", "CellSeg3D rights evidence changed")
        require("MIT" in rights["paper_license_statement"], "Retain the published licence conflict")
        originals = [
            pinned(public / "cellseg3d/extracted/DATASET_WITH_GT" / "c5image.tif"),
            pinned(
                public / "cellseg3d/extracted/DATASET_WITH_GT/labels" / "c5labels_new_label.tif"
            ),
        ]
        arrays = [tifffile.imread(item["path"]) for item in originals]
        require(all(a.shape == (249, 86, 94) for a in arrays), "CellSeg3D shape drift")
        require(
            arrays[0].dtype == np.uint16 and arrays[1].dtype == np.int64, "CellSeg3D dtype drift"
        )
        require(
            arrays[1].min() >= 0 and arrays[1].max() <= 2**32 - 1,
            "Labels cannot be converted exactly",
        )
        provenance = {
            "originals": originals,
            "rights_evidence": {"path": str(rights_path), "sha256": sha(rights_path)},
            "rights": rights,
            "transformation": (
                "Stored QYX explicitly declared ZYX from publisher volumetric description; "
                "no transpose/resample; int64 IDs exactly converted to uint32"
            ),
            "physical_calibration": None,
            "interpretation": (
                "Public supplied 3D annotations, not independent animal samples "
                "or validated biological truth"
            ),
        }
        return arrays[0][None, None], arrays[1].astype(np.uint32), (1, 1, 1), "pixel", provenance
    rights_path = kidney / "provenance.json"
    notices = json.loads(rights_path.read_text())
    notice = next(row for row in notices if row["file"] == "Kidney fluorescence.ome.tiff")
    require(
        notice["licence"] == "CC0-1.0" and notice["sha256"] == PINS[notice["file"]],
        "Kidney rights evidence changed",
    )
    original = pinned(kidney / "Kidney fluorescence.ome.tiff")
    with tifffile.TiffFile(original["path"]) as tif:
        require(
            tif.series[0].axes == "CZYX" and tif.series[0].shape == (3, 16, 512, 512),
            "Kidney grid drift",
        )
        raw = np.stack(
            [
                np.stack([tif.pages[c * 16 + z].asarray()[208:304, 208:304] for z in range(4, 12)])
                for c in range(3)
            ]
        )[None]
    z, y, x = np.indices(raw.shape[-3:])
    # Inert engineering masks on real pixels, explicitly not biological reference labels.
    labels = np.zeros(z.shape, np.uint32)
    labels[(z >= 1) & (z < 4) & (y >= 10) & (y < 24) & (x >= 12) & (x < 29)] = 17
    labels[(z >= 3) & (z < 7) & (y >= 50) & (y < 67) & (x >= 55) & (x < 72)] = 2**32 - 1
    provenance = {
        "originals": [original],
        "rights_evidence": {"path": str(rights_path), "sha256": sha(rights_path)},
        "rights": notices,
        "transformation": (
            "Exact raw crop C0:3 Z4:12 Y208:304 X208:304 re-encoded TCZYX; "
            "local origin reset explicitly, original native offset retained here"
        ),
        "original_offset_xyz": [208, 208, 4],
        "physical_calibration": "Existing registered OME spacing preserved: XYZ1.24,1.24,1.25um",
        "label_basis": (
            "Authored geometric masks for engineering acceptance on public biological raw pixels; "
            "not cell annotations"
        ),
        "interpretation": (
            "Public kidney raw fluorescence with inert technical labels; "
            "no biological segmentation accuracy claim"
        ),
    }
    return raw, labels, (1.24, 1.24, 1.25), "um", provenance


def prepare(output, case="synthetic", *, allow_test_output=False, public=PUBLIC, kidney=KIDNEY):
    output = Path(output).absolute()
    if not allow_test_output:
        require(
            output.is_relative_to(REPO / ".loci/evidence"),
            "Preparation must remain in ignored local evidence",
        )
    output.mkdir(parents=True, exist_ok=False)
    if case == "synthetic":
        raw, labels = synthetic_arrays()
        selection = {
            "x": 0,
            "y": 0,
            "width": 64,
            "height": 48,
            "z": 2,
            "z_stop": 14,
            "t": 1,
            "c": 1,
            "level": 0,
        }
        spacing, unit = (0.5, 1.5, 2.5), "um"
        provenance = {
            "origin": "Authored asymmetric technical fixture",
            "biological_validation": False,
        }
    else:
        raw, labels, spacing, unit, provenance = public_arrays(case, public, kidney)
        selection = {
            "x": 0,
            "y": 0,
            "width": labels.shape[2],
            "height": labels.shape[1],
            "z": 0,
            "z_stop": labels.shape[0],
            "t": 0,
            "c": 0,
            "level": 0,
        }
    source, label_file = output / "source.ome.tif", output / "labels.tif"
    metadata = {
        "axes": "TCZYX",
        "Channel": {"Name": ["QA channel " + str(i + 1) for i in range(raw.shape[1])]},
    }
    if unit != "pixel":
        metadata.update(
            {"PhysicalSize" + axis: value for axis, value in zip("XYZ", spacing, strict=True)}
        )
    tifffile.imwrite(
        source, raw, ome=True, photometric="minisblack", metadata=metadata, compression="deflate"
    )
    tifffile.imwrite(
        label_file,
        labels,
        photometric="minisblack",
        metadata={"axes": "ZYX"},
        compression="deflate",
    )
    selected = raw[selection["t"], selection["c"], selection["z"] : selection["z_stop"]]
    affine = np.diag([*spacing, 1.0])
    affine[2, 3] = selection["z"] * spacing[2]
    rows = expected_rows(labels, selected, affine, unit)
    # Prefer an object away from volume borders; ensure all three MPR probes are real label voxels.
    candidates = [
        r
        for r in rows
        if all(a > 0 for a in r["bbox_start"])
        and all(b < s for b, s in zip(r["bbox_stop_exclusive"], labels.shape, strict=True))
    ]
    target = max(candidates or rows, key=lambda r: r["voxel_count"])
    coords = np.argwhere(labels == target["label"])
    point = coords[np.argmin(np.linalg.norm(coords - np.array(target["centroid_index"]), axis=1))]
    np.save(output / "expected-labels.npy", labels, allow_pickle=False)
    np.save(output / "expected-image.npy", selected, allow_pickle=False)
    manifest = {
        "schema": "loci.volume-workspace-fixture/v1",
        "phase": "prepared-not-executed",
        "case": case,
        "output": str(output),
        "source": {"path": str(source), "sha256": sha(source)},
        "labels": {"path": str(label_file), "sha256": sha(label_file)},
        "selection": selection,
        "shape_zyx": list(labels.shape),
        "source_dimensions_xyz": [raw.shape[-1], raw.shape[-2], raw.shape[-3]],
        "affine": affine.tolist(),
        "unit": unit,
        "rows": rows,
        "target_label": target["label"],
        "probe_source_xyz": [int(point[2]), int(point[1]), int(point[0] + selection["z"])],
        "numerical_label_sha256": numerical_hash(labels),
        "data_sha256": hashlib.sha256(labels.astype("<u4").tobytes()).hexdigest(),
        "oracle_files": {
            name: sha(output / name) for name in ["expected-labels.npy", "expected-image.npy"]
        },
        "provenance": provenance,
        "limits": [
            "Engineering acceptance only; no biological validation or human scientific review",
            "Prepared files do not establish app, picker, packaged or actual-host acceptance",
        ],
    }
    write(output / "fixture.json", manifest)
    return manifest


def identity(manifest_path):
    manifest_path = Path(manifest_path)
    fixture = json.loads(manifest_path.read_text())
    require(fixture["schema"] == "loci.volume-workspace-fixture/v1", "Unsupported fixture")
    root = manifest_path.parent
    require(root == Path(fixture["output"]), "Fixture root changed")
    for key in ["source", "labels"]:
        require(Path(fixture[key]["path"]).parent == root, "Fixture path escaped its root")
        require(
            sha(fixture[key]["path"]) == fixture[key]["sha256"], "Fixture input changed: " + key
        )
    for name, digest in fixture["oracle_files"].items():
        require(
            name in {"expected-image.npy", "expected-labels.npy"} and sha(root / name) == digest,
            "Expected-array oracle changed",
        )
    labels = np.load(root / "expected-labels.npy", allow_pickle=False)
    require(
        numerical_hash(labels) == fixture["numerical_label_sha256"],
        "Numerical label identity changed",
    )
    for item in fixture["provenance"].get("originals", []):
        require(sha(item["path"]) == item["sha256"], "Original public source changed")
    notice = fixture["provenance"].get("rights_evidence")
    if notice:
        require(sha(notice["path"]) == notice["sha256"], "Public rights evidence changed")
    return fixture


def compare_rows(actual, expected):
    require(
        [row["label"] for row in actual] == [row["label"] for row in expected],
        "Measured object IDs changed",
    )
    for row, oracle in zip(actual, expected, strict=True):
        for key in [
            "measure_kind",
            "measure_unit",
            "index_axes",
            "voxel_count",
            "bbox_start",
            "bbox_stop_exclusive",
        ]:
            require(row[key] == oracle[key], "Measured " + key + " differs")
        for key in ["measure", "centroid_index", "centroid_world_xyz"]:
            np.testing.assert_allclose(row[key], oracle[key], rtol=1e-12, atol=1e-9)
        channels = list(row["intensity"].values())
        require(len(channels) == 1, "Exactly one imported raw measurement channel required")
        for key, value in oracle["intensity"].items():
            np.testing.assert_allclose(channels[0][key], value, rtol=1e-12, atol=1e-9)


def verify(manifest_path, study, parent_id, child_id=None):
    """Verify NPY bytes and numerical rows directly; imports no engine measurement code."""
    fixture = identity(manifest_path)
    root = Path(manifest_path).parent
    expected_labels = np.load(root / "expected-labels.npy", allow_pickle=False)
    expected_image = np.load(root / "expected-image.npy", allow_pickle=False)
    with sqlite3.connect(Path(study) / "study.sqlite3") as connection:
        parent = json.loads(
            connection.execute("SELECT record FROM results WHERE id=?", (parent_id,)).fetchone()[0]
        )
        records = [(parent, expected_labels)]
        if child_id:
            child = json.loads(
                connection.execute("SELECT record FROM results WHERE id=?", (child_id,)).fetchone()[
                    0
                ]
            )
            require(child["parent_id"] == parent_id, "Correction parent identity changed")
            corrected = expected_labels.copy()
            corrected[corrected == fixture["target_label"]] = 0
            records.append((child, corrected))
    for record, expected in records:
        unhashed = {k: v for k, v in record.items() if k != "revision_hash"}
        digest = hashlib.sha256(
            json.dumps(unhashed, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        require(digest == record["revision_hash"], "Result revision integrity changed")
        for name, oracle in [("image", expected_image), ("labels", expected)]:
            descriptor = record["arrays"][name]
            file = Path(study) / "artifacts" / (descriptor["sha256"] + ".npy")
            require(sha(file) == descriptor["sha256"], "Retained artifact hash changed")
            actual = np.load(file, allow_pickle=False)
            require(actual.dtype == oracle.dtype, "Retained dtype changed")
            np.testing.assert_array_equal(actual, oracle)
        require(
            record["source_sha256"] == fixture["source"]["sha256"],
            "Result source fingerprint changed",
        )
        require(
            record["provenance"]["selection"] == fixture["selection"],
            "Result source selection changed",
        )
        np.testing.assert_allclose(
            record["provenance"]["geometry"]["affine"], fixture["affine"], rtol=0, atol=1e-12
        )
        compare_rows(
            record["provenance"]["measurements"],
            expected_rows(expected, expected_image, np.array(fixture["affine"]), fixture["unit"]),
        )
        require(
            record["provenance"]["external_labels"]["alignment"] == "same-native-zyx-grid",
            "Volume alignment provenance changed",
        )
        external = record["provenance"]["external_labels"]
        require(external["profile"] == "scalar-native-zyx/v1", "Import profile changed")
        require(
            external["file_sha256"] == fixture["labels"]["sha256"], "Imported file identity changed"
        )
        require(
            external["labels_sha256"] == fixture["data_sha256"], "Imported input values changed"
        )
    return {
        "schema": "loci.volume-workspace-array-oracle/v1",
        "status": "passed",
        "parent_id": parent_id,
        "child_id": child_id,
        "exact_arrays": True,
        "raw_measurements": True,
        "parent_unchanged": True,
        "scientific_validation": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--case", choices=["synthetic", "cellseg3d", "kidney"], default="synthetic")
    check = commands.add_parser("verify")
    check.add_argument("--fixture", type=Path, required=True)
    check.add_argument("--study", type=Path, required=True)
    check.add_argument("--parent", required=True)
    check.add_argument("--child")
    args = parser.parse_args(argv)
    result = (
        prepare(args.output, args.case)
        if args.command == "prepare"
        else verify(args.fixture, args.study, args.parent, args.child)
    )
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
