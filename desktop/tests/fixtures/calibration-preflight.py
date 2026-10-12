#!/usr/bin/env python3
"""Tiny synthetic Q5 fixtures and independent persisted-array oracle.

Run with the existing engine/.venv/bin/python; no environment synchronization or
downloads. Generation fails if the destination already exists. Verification
reads packaged-worker artifacts and never executes a Loci processing algorithm.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import tifffile
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench
from scipy import __version__ as scipy_version
from scipy import ndimage as ndi


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate(root):
    root.mkdir(parents=True, exist_ok=False)
    wb = Workbench(
        ResearchProject.create(root / "calibration.loci-study", "Synthetic Q5")
    )
    cases = []
    for volume in (False, True):
        image = np.arange(72, dtype=np.uint16).reshape(8, 9)
        if volume:
            image = np.stack([image, image + 72, image + 144])
        for coarse in (True, False):
            spacing = (6.0, 4.0, 2.0) if volume else (4.0, 2.0)
            if not coarse:
                spacing = (1.0, 4.0, 2.0) if volume else (4.0, 1.0)
            name = f"{'coarse' if coarse else 'fine'}-{'3d' if volume else '2d'}"
            metadata = {"axes": "ZYX" if volume else "YX"}
            for axis, value in zip(metadata["axes"], spacing, strict=True):
                metadata[f"PhysicalSize{axis}"] = value
                metadata[f"PhysicalSize{axis}Unit"] = "µm"
            source_path = root / f"{name}.ome.tif"
            tifffile.imwrite(source_path, image, ome=True, metadata=metadata)
            source = wb.import_native(str(source_path))
            pixels = tuple(300.0 / value for value in spacing)
            expected = {}
            if coarse:
                smooth = ndi.gaussian_filter(
                    image.astype(float), pixels, mode="reflect", truncate=4
                )
                for op, values in (
                    ("gaussian", smooth),
                    ("subtract_background", image - smooth),
                ):
                    oracle = root / f"{name}-{op}.npy"
                    np.save(oracle, values, allow_pickle=False)
                    expected[op] = {"path": str(oracle), "sha256": sha(oracle)}
            cases.append(
                {
                    "name": name,
                    "coarse": coarse,
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "path": str(source_path),
                    "selection": {"z": 0, "z_stop": 3} if volume else {},
                    "spacing": spacing,
                    "sigma_voxels": pixels,
                    "shape": image.shape,
                    "expected": expected,
                }
            )
    manifest = {
        "schema": "loci.qa.calibration-preflight/v1",
        "synthetic": True,
        "study": str(wb.project.root),
        "cases": cases,
        "oracle": "scipy.ndimage.gaussian_filter; reflect; truncate=4; float64",
        "numpy_version": np.__version__,
        "scipy_version": scipy_version,
        "generator_sha256": sha(Path(__file__)),
    }
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n")
    print(path)


def verify(manifest_path, receipt_path):
    manifest = json.loads(manifest_path.read_text())
    receipt = json.loads(receipt_path.read_text())
    assert (
        manifest["schema"] == "loci.qa.calibration-preflight/v1"
        and manifest["synthetic"]
    )
    assert manifest["generator_sha256"] == sha(Path(__file__))
    assert receipt["fixture_manifest_sha256"] == sha(manifest_path)
    assert len(receipt["cases"]) == 4
    project = ResearchProject(Path(receipt["study"]))
    ids, pairs, seen = [], [], set()
    for check in receipt["cases"]:
        fixture = next(
            case for case in manifest["cases"] if case["name"] == check["fixture"]
        )
        op = check["op"]
        assert fixture["coarse"] and (fixture["name"], op) not in seen
        seen.add((fixture["name"], op))
        oracle = fixture["expected"][op]
        assert sha(Path(oracle["path"])) == oracle["sha256"]
        expected = np.load(oracle["path"], allow_pickle=False)
        actuals = []
        assert len(check["result_ids"]) == 2
        for result_id in check["result_ids"]:
            result = project.result(result_id)
            assert result["source_id"] == fixture["source_id"]
            assert result["source_sha256"] == fixture["source_sha256"]
            actual = project.load_array(result["arrays"]["image"])
            assert actual.shape == expected.shape == tuple(fixture["shape"])
            assert actual.dtype == expected.dtype == np.dtype("float64")
            np.testing.assert_allclose(actual, expected, rtol=1e-12, atol=1e-12)
            actuals.append(actual)
            ids.append(result_id)
        np.testing.assert_array_equal(*actuals)
        pairs.append(
            {
                "fixture": fixture["name"],
                "op": op,
                "maximum_absolute_error": float(np.max(np.abs(actuals[0] - expected))),
            }
        )
    assert len(ids) == len(set(ids)) == len(project.list_results()) == 8
    for case in manifest["cases"]:
        assert sha(Path(case["path"])) == case["source_sha256"]
    print(json.dumps({"status": "passed", "arrays_checked": len(ids), "pairs": pairs}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--verify-receipt", type=Path)
    args = parser.parse_args()
    if (
        args.output is not None
        and args.manifest is None
        and args.verify_receipt is None
    ):
        generate(args.output.resolve())
    elif (
        args.output is None
        and args.manifest is not None
        and args.verify_receipt is not None
    ):
        verify(args.manifest.resolve(), args.verify_receipt.resolve())
    else:
        parser.error("Choose --output OR both --manifest and --verify-receipt")
