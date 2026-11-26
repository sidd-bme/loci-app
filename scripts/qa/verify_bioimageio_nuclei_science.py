#!/usr/bin/env python3
"""Independent export verifier for BioImage.IO 2D nuclei ONNX runs.

No Loci imports, no hardcoded personal paths, and no GUI/worker execution.
Reuses the BBBC039 manual-mask decoder and Hungarian IoU matcher from
scripts/qa/real_fluorescence_evaluate.py, and independently verifies:
  - exported manifest, array SHA-256s, and NPY/OME-TIFF parity
  - package reference tensor and tiled CPU ONNX Runtime probabilities
  - per-object raw-channel measurements and objects.csv arithmetic in NumPy/SciPy
  - BBBC039 manual instance mask metrics and lowest-IoU false-positive candidate
  - parent-to-child correction delta when --parent-export-dir is supplied
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import tifffile
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

REPO = Path(__file__).resolve().parents[2]
EVAL_HELPER = REPO / "scripts/qa/real_fluorescence_evaluate.py"


def _load_eval_helper():
    spec = importlib.util.spec_from_file_location("real_fluorescence_evaluate", EVAL_HELPER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_identity(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    return {"path": str(resolved), "bytes": resolved.stat().st_size, "sha256": sha256_file(resolved)}


def independent_tiled_onnx(package_dir: Path, raw_yx: np.ndarray) -> dict[str, Any]:
    """Run independent ONNX Runtime CPU inference without importing Loci."""
    manifest = json.loads((package_dir / "loci-model.json").read_text(encoding="utf-8"))
    model_path = package_dir / manifest["model"]["source"]
    assert sha256_file(model_path) == manifest["model"]["sha256"]
    ref_in = np.load(package_dir / manifest["reference"]["input"]["source"], allow_pickle=False)
    ref_out = np.load(package_dir / manifest["reference"]["output"]["source"], allow_pickle=False)
    assert sha256_file(package_dir / manifest["reference"]["input"]["source"]) == manifest["reference"]["input"]["sha256"]
    assert sha256_file(package_dir / manifest["reference"]["output"]["source"]) == manifest["reference"]["output"]["sha256"]

    opts = ort.SessionOptions()
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    opts.enable_cpu_mem_arena = False
    opts.enable_mem_pattern = False
    session = ort.InferenceSession(str(model_path), sess_options=opts, providers=["CPUExecutionProvider"])
    in_name, out_name = manifest["input"]["id"], manifest["output"]["id"]

    def zmvu(tile_bcyx: np.ndarray, eps: float = 1e-6) -> np.ndarray:
        x = tile_bcyx.astype(np.float32, copy=False)
        mean = x.mean(axis=(1, 2, 3), keepdims=True, dtype=np.float64).astype(np.float32)
        std = x.std(axis=(1, 2, 3), keepdims=True, dtype=np.float64).astype(np.float32)
        return (x - mean) / np.maximum(std, eps)

    hy, hx = manifest["tiling"]["halo_yx"]
    ref_pred = session.run([out_name], {in_name: zmvu(ref_in)})[0]
    ref_crop = ref_pred[:, :, hy : ref_pred.shape[2] - hy, hx : ref_pred.shape[3] - hx]
    ref_exp = ref_out[:, :, hy : ref_out.shape[2] - hy, hx : ref_out.shape[3] - hx]
    ref_max_err = float(np.max(np.abs(ref_crop.astype(np.float64) - ref_exp.astype(np.float64))))
    assert ref_max_err <= float(manifest["reference"]["atol"]) + float(manifest["reference"]["rtol"])

    height, width = raw_yx.shape
    tile_y, tile_x = manifest["tiling"]["input_yx"]
    core_y, core_x = tile_y - 2 * hy, tile_x - 2 * hx
    pad_b = math.ceil(height / core_y) * core_y - height
    pad_r = math.ceil(width / core_x) * core_x - width
    padded = np.pad(
        np.ascontiguousarray(raw_yx[None, None, ...], dtype=np.float32),
        ((0, 0), (0, 0), (hy, hy + pad_b), (hx, hx + pad_r)),
        mode="reflect",
    )
    probs = np.empty((len(manifest["output"]["channels"]), height + pad_b, width + pad_r), dtype=np.float32)
    tiles = 0
    for y in range(0, height + pad_b, core_y):
        for x in range(0, width + pad_r, core_x):
            tile = np.ascontiguousarray(padded[:, :, y : y + tile_y, x : x + tile_x])
            pred = session.run([out_name], {in_name: zmvu(tile)})[0]
            probs[:, y : y + core_y, x : x + core_x] = pred[0, :, hy : tile_y - hy, hx : tile_x - hx]
            tiles += 1
    probs = np.ascontiguousarray(probs[:, :height, :width])
    comp_labels, _ = ndi.label(probs[0] > float(manifest["labels"]["threshold"]), structure=ndi.generate_binary_structure(2, 1))
    return {
        "ort_version": ort.__version__,
        "reference_max_abs_err": ref_max_err,
        "tile_count": tiles,
        "probabilities": probs,
        "components_labels": comp_labels.astype(np.uint32),
    }


def independent_measurements_yx(raw_yx: np.ndarray, labels_yx: np.ndarray) -> list[dict[str, Any]]:
    """Independent NumPy/SciPy measurement arithmetic on an uncalibrated YX pixel grid."""
    if raw_yx.shape != labels_yx.shape or raw_yx.ndim != 2:
        raise ValueError("Raw and label arrays must share one 2D YX grid")
    rows: list[dict[str, Any]] = []
    centers: list[list[float]] = []
    for label_id in [int(v) for v in np.unique(labels_yx) if v != 0]:
        coords = np.argwhere(labels_yx == label_id)
        start, stop = coords.min(axis=0), coords.max(axis=0) + 1
        world = np.column_stack((coords[:, ::-1], np.zeros(len(coords), dtype=np.float64)))
        center_xyz = world.mean(axis=0)
        cov = np.cov(world, rowvar=False, bias=True) if len(world) > 1 else np.zeros((3, 3))
        eigvals = np.maximum(np.linalg.eigvalsh(cov), 0.0)
        vals = raw_yx[coords[:, 0], coords[:, 1]].astype(np.float64)
        rows.append(
            {
                "label": label_id,
                "voxel_count": len(coords),
                "measure": float(len(coords)),
                "measure_kind": "area",
                "measure_unit": "pixel^2",
                "centroid_index": coords.mean(axis=0).tolist(),
                "index_axes": "YX",
                "centroid_world_xyz": center_xyz.tolist(),
                "world_frame": "image",
                "distance_unit": "pixel",
                "bbox_start": start.tolist(),
                "bbox_stop_exclusive": stop.tolist(),
                "principal_rms_radii": np.sqrt(eigvals[::-1]).tolist(),
                "touches_crop_border": bool(np.any(start == 0) or np.any(stop == np.array(labels_yx.shape))),
                "intensity": {
                    "source_channel_0": {
                        "mean": float(vals.mean()),
                        "sum": float(vals.sum()),
                        "min": float(vals.min()),
                        "max": float(vals.max()),
                        "std_population": float(vals.std(ddof=0)),
                    }
                },
            }
        )
        centers.append(center_xyz.tolist())
    if len(rows) > 1:
        dists = cKDTree(np.asarray(centers, dtype=np.float64)).query(centers, k=2)[0][:, 1]
        for row, d in zip(rows, dists, strict=True):
            row["nearest_centroid_distance"] = float(d)
    elif rows:
        rows[0]["nearest_centroid_distance"] = None
    return rows


def _close(a: Any, b: Any, max_diff: list[float], ctx: str) -> None:
    if isinstance(b, dict):
        assert isinstance(a, dict) and set(a) == set(b), f"{ctx}: keys differ"
        for k, v in b.items():
            _close(a[k], v, max_diff, f"{ctx}.{k}")
    elif isinstance(b, list):
        assert isinstance(a, list) and len(a) == len(b), f"{ctx}: length differs"
        for i, v in enumerate(b):
            _close(a[i], v, max_diff, f"{ctx}[{i}]")
    elif isinstance(b, float):
        diff = abs(float(a) - b)
        max_diff[0] = max(max_diff[0], diff)
        assert diff <= 1e-9 + 1e-12 * abs(b), f"{ctx}: {a} vs {b}"
    else:
        assert a == b, f"{ctx}: {a} vs {b}"


def compare_measurements(actual: list[dict[str, Any]], expected: list[dict[str, Any]], *, corrected: bool) -> dict[str, Any]:
    assert len(actual) == len(expected), f"Row count mismatch: {len(actual)} vs {len(expected)}"
    max_diff = [0.0]
    for act, exp in zip(actual, expected, strict=True):
        row = dict(act)
        if corrected and row.get("marker_gates") == {}:
            row.pop("marker_gates")
        _close(row, exp, max_diff, f"label[{exp['label']}]")
    return {"row_count": len(actual), "max_abs_diff": max_diff[0]}


def lowest_iou_candidate(labels: np.ndarray, ref_labels: np.ndarray) -> dict[str, Any]:
    ids = [int(v) for v in np.unique(labels) if v != 0]
    assert ids, "Expected at least one predicted label"
    best_pick = (2.0, ids[0])
    for cid in ids:
        cm = labels == cid
        overlapping = [int(r) for r in np.unique(ref_labels[cm]) if r != 0]
        max_iou = max(
            (float(np.count_nonzero(cm & (ref_labels == rid)) / np.count_nonzero(cm | (ref_labels == rid))) for rid in overlapping),
            default=0.0,
        )
        if max_iou < best_pick[0]:
            best_pick = (max_iou, cid)
    return {"label": best_pick[1], "max_iou_with_manual": best_pick[0]}


def verify_export(args: argparse.Namespace) -> dict[str, Any]:
    eval_mod = _load_eval_helper()
    export_dir = args.export_dir.resolve()
    raw_id = file_identity(args.image)
    mask_id = file_identity(args.mask)
    if args.expected_image_sha256:
        assert raw_id["sha256"] == args.expected_image_sha256, "Source image SHA-256 mismatch"
    if args.expected_mask_sha256:
        assert mask_id["sha256"] == args.expected_mask_sha256, "Manual mask SHA-256 mismatch"

    manifest = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.get("schema") == "loci.export-manifest/v1"
    for entry in manifest["files"]:
        f = export_dir / entry["name"]
        assert f.is_file() and f.stat().st_size == entry["size_bytes"] and sha256_file(f) == entry["sha256"], f"Bad export file: {entry['name']}"

    result = json.loads((export_dir / "result.json").read_text(encoding="utf-8"))["result"]
    prov = result["provenance"]
    assert prov["geometry"]["unit"] == "pixel" and prov["geometry"]["axes"] == "YX"
    assert prov["source_scale"]["resampled"] is False
    assert prov["source_scale"]["scientific_output_geometry"] == "registered-source-geometry-unchanged"

    raw = tifffile.imread(args.image)
    if raw.ndim == 3:
        raw = raw[0]
    labels = np.load(export_dir / "labels.npy", allow_pickle=False)
    assert np.array_equal(labels, tifffile.imread(export_dir / "labels.ome.tif"))
    assert sha256_file(export_dir / "labels.npy") == result["arrays"]["labels"]["sha256"]

    expected_rows = independent_measurements_yx(raw, labels)
    meas_parity = compare_measurements(prov["measurements"], expected_rows, corrected=(result["kind"] == "corrected-labels"))

    with (export_dir / "objects.csv").open(newline="", encoding="utf-8") as stream:
        csv_rows = list(csv.DictReader(stream))
    assert len(csv_rows) == len(expected_rows)
    for csv_row, exp in zip(csv_rows, expected_rows, strict=True):
        assert int(csv_row["label"]) == exp["label"] and int(csv_row["voxel_count"]) == exp["voxel_count"]
        assert csv_row["measure_unit"] == "pixel^2" and csv_row["distance_unit"] == "pixel"
        for stat_key in ("sum", "mean", "min", "max", "std_population"):
            assert math.isclose(
                float(csv_row[f"intensity:source_channel_0:{stat_key}"]),
                exp["intensity"]["source_channel_0"][stat_key],
                rel_tol=1e-12,
                abs_tol=1e-9,
            )

    probs = np.load(export_dir / "probabilities.npy", allow_pickle=False)
    assert sha256_file(export_dir / "probabilities.npy") == result["arrays"]["probabilities"]["sha256"]
    ind_ort = independent_tiled_onnx(args.package.resolve(), raw)
    prob_diff = float(np.max(np.abs(probs - ind_ort["probabilities"])))
    assert prob_diff <= 1e-4, f"Probabilities diverged from independent ORT: {prob_diff}"

    with Image.open(args.mask) as img:
        ref_labels = eval_mod.decode_039_rgb(np.asarray(img))
    metrics = eval_mod.instance_metrics(ref_labels, labels, thresholds=(0.5, 0.75))

    report: dict[str, Any] = {
        "schema": "loci.bioimageio-nuclei-export-verifier/v1",
        "status": "passed",
        "export_dir": str(export_dir),
        "source": raw_id,
        "manual_mask": mask_id,
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "kind": result["kind"],
        "geometry": prov["geometry"],
        "source_scale": prov["source_scale"],
        "object_count": len(expected_rows),
        "measurement_parity": meas_parity,
        "csv_rows_verified": len(csv_rows),
        "independent_ort": {
            "ort_version": ind_ort["ort_version"],
            "reference_max_abs_err": ind_ort["reference_max_abs_err"],
            "tile_count": ind_ort["tile_count"],
            "probabilities_max_abs_diff": prob_diff,
            "components_label_parity_with_initial": bool(np.array_equal(labels, ind_ort["components_labels"])) if result["kind"] == "model-segmentation" else None,
        },
        "bbbc039_instance_metrics": metrics,
        "recommended_false_positive": lowest_iou_candidate(labels, ref_labels),
    }

    if args.parent_export_dir is not None:
        parent_dir = args.parent_export_dir.resolve()
        parent_res = json.loads((parent_dir / "result.json").read_text(encoding="utf-8"))["result"]
        parent_labels = np.load(parent_dir / "labels.npy", allow_pickle=False)
        assert result["parent_id"] == parent_res["id"]
        assert prov["correction"]["parent_id"] == parent_res["id"]
        assert prov["correction"]["parent_revision_hash"] == parent_res["revision_hash"]
        if args.deleted_label is not None:
            expected_after = parent_labels.copy()
            expected_after[parent_labels == args.deleted_label] = 0
            assert np.array_equal(labels, expected_after)
            ops = prov["correction"].get("operations", [])
            assert len(ops) == 1 and ops[0].get("op") == "delete" and ops[0].get("label") == args.deleted_label
        changed = int(np.count_nonzero(labels != parent_labels))
        assert sum(int(op.get("changed_voxels", 0)) for op in prov["correction"].get("operations", [])) == changed
        report["correction_verification"] = {
            "parent_id": parent_res["id"],
            "parent_object_count": len(parent_res["provenance"]["measurements"]),
            "child_object_count": len(expected_rows),
            "changed_voxel_count": changed,
            "operations": prov["correction"].get("operations", []),
        }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-dir", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--parent-export-dir", type=Path)
    parser.add_argument("--deleted-label", type=int)
    parser.add_argument("--expected-image-sha256")
    parser.add_argument("--expected-mask-sha256")
    args = parser.parse_args()
    print(json.dumps(verify_export(args), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
