#!/usr/bin/env python3
"""Bounded BBBC039 real-image QA; invoke with engine/.venv/bin/python.

Only --download permits network acquisition of the three declared CC0 archives.
Original bytes, predetermined field selection, settings and source identity are
recorded before metrics. Measurement correctness and human-label agreement are
separate endpoints; neither establishes biological or clinical validation.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import platform
import subprocess
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import numpy as np
import tifffile
from PIL import Image
from scipy.optimize import linear_sum_assignment
from skimage.measure import label as decode_connected_labels

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO / ".loci/evidence/2026-10-03/object-population/real-images"
DATA_URL = "https://data.broadinstitute.org/bbbc/BBBC039/"
ARCHIVES = {"images.zip": 77915748, "masks.zip": 2753811, "metadata.zip": 17816}
SETTINGS = {
    method: {
        "method": method,
        "threshold": "otsu",
        "polarity": "bright",
        "min_size": 0,
        "exclude_border": False,
        **({"split_height": 2.0} if method == "watershed" else {}),
    }
    for method in ("components", "watershed")
}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def source_identity():
    return {
        "head": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
        "branch": subprocess.check_output(
            ["git", "branch", "--show-current"], cwd=REPO, text=True
        ).strip(),
        "engine_sources": {
            str(path.relative_to(REPO)): sha(path)
            for path in sorted((REPO / "engine/src/loci_engine").rglob("*.py"))
        },
        "qa_script_sha256": sha(Path(__file__)),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "tifffile": tifffile.__version__,
    }


def members(archive):
    infos = archive.infolist()
    if len(infos) > 2000:
        raise ValueError("Archive member count exceeds declared bounded fixture")
    names = set()
    for info in infos:
        path = PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts or "\\" in info.filename:
            raise ValueError("Unsafe archive member")
        if info.filename in names or info.file_size > 16 * 1024 * 1024:
            raise ValueError("Duplicate or oversized archive member")
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError("Archive symlink is forbidden")
        names.add(info.filename)
    return [
        info.filename
        for info in infos
        if not info.is_dir()
        and "__MACOSX" not in PurePosixPath(info.filename).parts
        and not PurePosixPath(info.filename).name.startswith("._")
    ]


def acquire(root, download):
    originals = root / "originals"
    originals.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, length in ARCHIVES.items():
        path = originals / name
        if not path.exists() and download:
            temporary = path.with_suffix(".download")
            with (
                urllib.request.urlopen(DATA_URL + name, timeout=60) as response,
                temporary.open("xb") as stream,
            ):
                written = 0
                while block := response.read(1024 * 1024):
                    written += len(block)
                    if written > length:
                        raise ValueError("Download exceeds declared size")
                    stream.write(block)
            temporary.rename(path)
        if not path.exists() or path.stat().st_size != length:
            raise ValueError(f"Missing/incomplete original archive: {name}")
        manifest.append(
            {
                "url": DATA_URL + name,
                "path": str(path),
                "bytes": length,
                "sha256": sha(path),
                "checksum_basis": "locally computed, not publisher supplied",
            }
        )
    previous = root / "source-manifest.json"
    if previous.exists() and json.loads(previous.read_text())["archives"] != manifest:
        raise ValueError("Original archives disagree with previously pinned manifest")
    return manifest


def prepare(root, archives):
    with zipfile.ZipFile(root / "originals/metadata.zip") as metadata:
        names = members(metadata)
        splits = {}
        for split in ("train", "test"):
            candidates = [name for name in names if split in Path(name).stem.lower()]
            if len(candidates) != 1:
                raise ValueError(
                    f"Cannot uniquely identify official {split} manifest: {names}"
                )
            text = metadata.read(candidates[0]).decode("utf-8")
            files = sorted(line.strip() for line in text.splitlines() if line.strip())
            if len(files) != (100 if split == "train" else 50) or len(
                set(files)
            ) != len(files):
                raise ValueError("Official split counts/uniqueness disagree")
            splits[split] = files[:3]
        if set(splits["train"]) & set(splits["test"]):
            raise ValueError("Development and held-out fields overlap")
        metadata_records = {
            name: hashlib.sha256(metadata.read(name)).hexdigest() for name in names
        }
    selection = {
        "schema": "loci.bbbc039-selection/v1",
        "archives": archives,
        "dataset": "BBBC039v1",
        "dataset_url": "https://bbbc.broadinstitute.org/BBBC039",
        "license": "CC0",
        "license_url": "https://bbbc.broadinstitute.org/BBBC039#copyright",
        "paper": "https://doi.org/10.1002/cyto.a.23863",
        "decoder_url": "https://gist.github.com/jccaicedo/15e811722fca51e3ae90e8b43057f075",
        "decoder": "first PNG channel; connected equal-valued regions; background=0; full 2D connectivity",
        "selection_rule": "First three lexicographically sorted filenames from official train and test lists",
        "selected": splits,
        "metadata_member_sha256": metadata_records,
        "sampling_unit": "whole field of view, one per compound; nuclei are not independent replicates",
        "geometry": "uncalibrated YX, unit pixel, spacing 1; no inherited physical calibration assumed",
        "segmentation_settings_frozen_before_scores": SETTINGS,
        "segmentation_evaluation": "Hungarian maximum summed IoU, one-to-one; accepted IoU >= 0.5",
        "measurement_tolerance": {"absolute": 1e-9, "relative": 1e-12},
    }
    path = root / "source-manifest.json"
    if path.exists() and json.loads(path.read_text()) != selection:
        raise ValueError("Predetermined selection/settings changed")
    if not path.exists():
        write_json(path, selection)
    selected = []
    output = root / "selected"
    output.mkdir(exist_ok=True)
    with (
        zipfile.ZipFile(root / "originals/images.zip") as images,
        zipfile.ZipFile(root / "originals/masks.zip") as masks,
    ):
        image_names, mask_names = members(images), members(masks)
        for split, filenames in splits.items():
            for filename in filenames:
                basename = Path(filename).stem
                ims = [name for name in image_names if Path(name).stem == basename]
                msk = [name for name in mask_names if Path(name).stem == basename]
                if len(ims) != 1 or len(msk) != 1:
                    raise ValueError(f"Unmatched or ambiguous image/mask: {filename}")
                paths = []
                for archive, member in ((images, ims[0]), (masks, msk[0])):
                    target = output / Path(member).name
                    raw = archive.read(member)  # verifies selected member CRC
                    if target.exists() and target.read_bytes() != raw:
                        raise ValueError("Selected original bytes changed")
                    if not target.exists():
                        target.write_bytes(raw)
                    paths.append(target)
                selected.append({"split": split, "image": paths[0], "mask": paths[1]})
    return selected


def oracle(labels, raw):
    """Direct NumPy pixels; no Loci measurement/geometry code or regionprops."""
    rows = []
    for number in np.unique(labels):
        if number == 0:
            continue
        y, x = np.nonzero(labels == number)
        values = raw[y, x].astype(np.float64)
        rows.append(
            {
                "label": int(number),
                "voxel_count": len(y),
                "measure": len(y),
                "centroid_index": [
                    float(y.sum(dtype=np.int64) / len(y)),
                    float(x.sum(dtype=np.int64) / len(x)),
                ],
                "bbox_start": [int(y.min()), int(x.min())],
                "bbox_stop_exclusive": [int(y.max()) + 1, int(x.max()) + 1],
                "intensity": {
                    "sum": float(values.sum()),
                    "mean": float(values.sum() / len(y)),
                    "min": float(values.min()),
                    "max": float(values.max()),
                    "std_population": float(
                        np.sqrt(((values - values.mean()) ** 2).sum() / len(y))
                    ),
                },
            }
        )
    centers = np.array([row["centroid_index"] for row in rows])
    if len(rows) > 1:
        distance = np.sqrt(
            ((centers[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        )
        np.fill_diagonal(distance, np.inf)
        for row, nearest in zip(rows, distance.min(axis=1), strict=True):
            row["nearest_centroid_distance"] = float(nearest)
    elif rows:
        rows[0]["nearest_centroid_distance"] = None
    return rows


def check_measurements(expected, actual):
    if [r["label"] for r in actual] != [r["label"] for r in expected]:
        raise AssertionError("Measurement object identity mismatch")
    maximum = 0.0
    for reference, measured in zip(expected, actual, strict=True):
        for key in (
            "voxel_count",
            "measure",
            "centroid_index",
            "bbox_start",
            "bbox_stop_exclusive",
            "nearest_centroid_distance",
        ):
            if reference[key] is None:
                assert measured[key] is None
            else:
                np.testing.assert_allclose(
                    measured[key], reference[key], atol=1e-9, rtol=1e-12
                )
                maximum = max(
                    maximum,
                    float(np.max(np.abs(np.asarray(measured[key]) - reference[key]))),
                )
        assert measured["index_axes"] == "YX" and measured["measure_unit"] == "pixel^2"
        np.testing.assert_allclose(
            measured["centroid_world_xyz"],
            [*reference["centroid_index"][::-1], 0],
            atol=1e-9,
            rtol=1e-12,
        )
        assert len(measured["intensity"]) == 1
        for statistic, value in reference["intensity"].items():
            got = next(iter(measured["intensity"].values()))[statistic]
            np.testing.assert_allclose(got, value, atol=1e-9, rtol=1e-12)
            maximum = max(maximum, abs(got - value))
    return {"passed": True, "objects": len(expected), "maximum_absolute_error": maximum}


def check_population(workbench, result, expected, channel):
    identity = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    mean_id = f"intensity:{channel.encode().hex()}:mean"
    cases = [
        [],
        [{"metric": "measure", "min": 100, "max": 1000}],
        [{"metric": "measure", "min": 1e9}],
        [
            {
                "metric": "measure",
                "min": expected[0]["measure"],
                "max": expected[0]["measure"],
            }
        ]
        if expected
        else [],
    ]
    receipts = []
    for filters in cases:
        ordered = sorted(
            [
                row
                for row in expected
                if all(
                    ("min" not in item or row["measure"] >= item["min"])
                    and ("max" not in item or row["measure"] <= item["max"])
                    for item in filters
                )
            ],
            key=lambda row: (-row["measure"], row["label"]),
        )
        request = {
            **identity,
            "x_metric": "measure",
            "y_metric": mean_id,
            "filters": filters,
            "sort": {"metric": "measure", "direction": "desc"},
            "limit": 17,
            "plot_limit": 11,
            "bins": 8,
        }
        got_labels = []
        response = None
        for offset in range(0, max(len(ordered), 1), 17):
            response = workbench.execute(
                "population_query", {**request, "offset": offset}
            )
            got_labels.extend(row["label"] for row in response["rows"])
        assert response is not None
        assert got_labels == [row["label"] for row in ordered]
        assert response["total_count"] == len(expected)
        assert response["filtered_count"] == len(ordered)
        values = np.array([row["measure"] for row in ordered], dtype=float)
        if not len(values):
            counts, edges = [], []
        elif values.min() == values.max():
            counts, edges = [len(values)], [float(values.min()), float(values.max())]
        else:
            edges = np.linspace(values.min(), values.max(), 9)
            counts = np.histogram(values, bins=edges)[0].tolist()
        np.testing.assert_allclose(
            response["histogram"]["edges"], edges, atol=1e-9, rtol=1e-12
        )
        assert response["histogram"]["counts"] == counts
        assert response["histogram"]["finite_count"] == len(ordered)
        points = sorted(ordered, key=lambda row: row["label"])
        if len(points) > 11:
            points = [points[index * (len(points) - 1) // 10] for index in range(11)]
        assert [point["label"] for point in response["scatter"]["points"]] == [
            p["label"] for p in points
        ]
        for point, row in zip(response["scatter"]["points"], points, strict=True):
            np.testing.assert_allclose(
                [point["x"], point["y"]],
                [row["measure"], row["intensity"]["mean"]],
                atol=1e-9,
                rtol=1e-12,
            )
        receipts.append(
            {
                "filters": filters,
                "expected_labels": got_labels,
                "histogram": response["histogram"],
                "pages": max(1, (len(ordered) + 16) // 17),
                "membership_sha256": response["membership_sha256"],
                "passed": True,
            }
        )
    return receipts


def agreement(prediction, reference):
    _, p = np.unique(prediction.ravel(), return_inverse=True)
    _, g = np.unique(reference.ravel(), return_inverse=True)
    pn, gn = int(p.max()), int(g.max())
    intersection = np.bincount(g * (pn + 1) + p, minlength=(gn + 1) * (pn + 1)).reshape(
        gn + 1, pn + 1
    )
    gsize, psize = intersection.sum(axis=1), intersection.sum(axis=0)
    union = gsize[1:, None] + psize[None, 1:] - intersection[1:, 1:]
    iou = np.divide(
        intersection[1:, 1:],
        union,
        out=np.zeros_like(union, dtype=float),
        where=union > 0,
    )
    gi, pi = linear_sum_assignment(-iou)
    matched = iou[gi, pi]
    tp = int((matched >= 0.5).sum())
    fg_intersection = int(((prediction > 0) & (reference > 0)).sum())
    fg_union = int(((prediction > 0) | (reference > 0)).sum())
    precision, recall = tp / pn if pn else 0, tp / gn if gn else 0
    return {
        "reference_count": gn,
        "predicted_count": pn,
        "count_error": pn - gn,
        "foreground_iou": fg_intersection / fg_union if fg_union else 1.0,
        "matching": "Hungarian maximum summed IoU; one-to-one; accepted IoU >= 0.5",
        "tp": tp,
        "fp": pn - tp,
        "fn": gn - tp,
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0,
        "matched_iou": matched[matched >= 0.5].tolist(),
    }


def write_report(run, results):
    lines = [
        "# BBBC039 bounded real-image evidence",
        "",
        (
            f"Measurement checks: {results['measurement_correctness']}. "
            f"Engine source stable during run: {results['source_stable_during_run']}."
        ),
        "",
        (
            "Official CC0 raw images and expert reference annotations are preserved unchanged. "
            "Selection/settings were recorded before scoring: first three sorted official training "
            "filenames and first three sorted official test filenames; no held-out tuning."
        ),
        "",
        (
            "The original TIFFs contain 72-per-inch resolution metadata, corresponding to "
            "352.7777777778 um/pixel when mechanically converted; that is not established "
            "biological calibration. Lead-authorized TIFF companions preserve every uint16 YX "
            "pixel and omit ambiguous DPI. All reported areas/distances here use pixels, with "
            "physical calibration unknown; no 0.656 um/pixel assumption is applied."
        ),
        "",
        (
            "Independent direct NumPy pixels check counts, area, centroids, bounding boxes, "
            "intensity sum/mean/min/max/population SD and nearest-centroid distances against "
            "production measurements. Inclusive area filters, empty/exact-area cases, all table "
            "pages, histogram bins and scatter sampling are independently checked through "
            "the real Workbench population_query route. Agreement metrics below instead compare "
            "existing classical segmentation with the independently authored human masks."
        ),
        "",
        "| Split | Field | Method | Human / predicted count | Foreground IoU | Precision | Recall | F1 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for field in results["fields"]:
        for method, receipt in field["methods"].items():
            metric = receipt["annotation_agreement"]
            lines.append(
                f"| {field['split']} | {field['filename']} | {method} | "
                f"{metric['reference_count']} / {metric['predicted_count']} | "
                f"{metric['foreground_iou']:.6f} | {metric['precision']:.6f} | "
                f"{metric['recall']:.6f} | {metric['f1']:.6f} |"
            )
    lines.extend(
        [
            "",
            (
                "Matching uses Hungarian maximum summed instance IoU, with accepted matches >= 0.5. "
                "Each field is one descriptive sampling unit; nuclei are not independent replicates. "
                "Human masks have annotation uncertainty. Six same-experiment fields do not establish "
                "general biological accuracy, calibrated intensity, clinical validation or usability."
            ),
            "",
            (
                "Reproduce: `engine/.venv/bin/python scripts/qa/population-real-images.py`. "
                "Use `--download` only when acquisition of the three declared archives is authorized. "
                "Source hashes, exact result revisions, settings, raw/derived identities and per-object "
                "oracle values are retained in the JSON receipts and study."
            ),
        ]
    )
    (run / "report.md").write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument(
        "--download",
        action="store_true",
        help="explicitly acquire declared CC0 archives",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    selected = prepare(root, acquire(root, args.download))
    run = root / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    run.mkdir()
    before = source_identity()
    write_json(run / "source-identity-before.json", before)
    sys.path.insert(0, str(REPO / "engine/src"))
    Workbench = importlib.import_module("loci_engine.workbench").Workbench
    ResearchProject = importlib.import_module(
        "loci_engine.research_project"
    ).ResearchProject
    workbench = Workbench(
        ResearchProject.create(run / "bbbc039.loci-study", "BBBC039 real microscopy QA")
    )
    results = {
        "fields": [],
        "measurement_correctness": "pending",
        "source_identity": str(run),
        "selection_sha256": sha(root / "source-manifest.json"),
        "scientific_scope": "Six fields; descriptive annotation agreement, no independent nuclei replicates or clinical validation",
    }
    try:
        for item in selected:
            raw = tifffile.imread(item["image"])
            with Image.open(item["mask"]) as mask_image:
                colors = np.array(mask_image.convert("RGB"))
            assert raw.shape == (520, 696) and raw.dtype == np.uint16
            assert colors.shape == (*raw.shape, 3)
            first = colors[:, :, 0]
            assert np.array_equal(first > 0, np.any(colors != 0, axis=2))
            reference = decode_connected_labels(
                first, background=0, connectivity=2
            ).astype(np.uint32)
            np.save(run / (item["image"].stem + "-human-reference.npy"), reference)
            record = {
                "filename": item["image"].name,
                "split": item["split"],
                "image_sha256": sha(item["image"]),
                "mask_sha256": sha(item["mask"]),
                "shape_yx": list(raw.shape),
                "dtype": str(raw.dtype),
                "manual_reference_count": int(reference.max()),
                "mask_unique_rgb_colors": len(np.unique(colors.reshape(-1, 3), axis=0)),
                "mask_unique_first_channel_values": len(np.unique(first)),
                "methods": {},
            }
            with tifffile.TiffFile(item["image"]) as original_tiff:
                tags = original_tiff.pages[0].tags
                record["original_resolution_metadata"] = {
                    name: str(tags[name].value)
                    for name in ("XResolution", "YResolution", "ResolutionUnit")
                    if name in tags
                }
            # Lead-authorized derived companion: preserve every source pixel;
            # remove ambiguous 72-dpi tags rather than invent physical calibration.
            derived_directory = root / "derived-pixel-inputs"
            derived_directory.mkdir(exist_ok=True)
            derived = derived_directory / (item["image"].stem + "-uncalibrated.tif")
            if not derived.exists():
                tifffile.imwrite(
                    derived,
                    raw,
                    photometric="minisblack",
                    metadata={"axes": "YX"},
                    resolution=(1, 1),
                    resolutionunit="NONE",
                )
            restored = tifffile.imread(derived)
            assert restored.dtype == raw.dtype and restored.shape == raw.shape
            np.testing.assert_array_equal(restored, raw)
            with tifffile.TiffFile(derived) as derived_tiff:
                assert derived_tiff.series[0].axes == "YX"
            record["derived_source"] = {
                "path": str(derived),
                "sha256": sha(derived),
                "original_sha256": record["image_sha256"],
                "array_sha256": hashlib.sha256(raw.tobytes()).hexdigest(),
                "pixel_identity": "exact shape YX, dtype uint16 and every pixel equal",
                "derivation": "Lossless pixels; explicit no physical calibration; ambiguous DPI omitted",
                "physical_calibration": "unknown; no 0.656 um inheritance assumed",
            }
            write_json(run / f"{item['image'].stem}-derivation.json", record)
            results["fields"].append(record)
            source = workbench.import_native(str(derived))
            for method, settings in SETTINGS.items():
                saved = workbench.execute(
                    "run_recipe",
                    {
                        "source_id": source["id"],
                        "selection": {"c": 0, "z": 0, "t": 0, "level": 0},
                        "recipe": {
                            "steps": [],
                            "segmentation": settings,
                            "measurement_channels": [0],
                        },
                    },
                )
                result = workbench.project.result(saved["result"]["id"])
                labels = workbench.project.load_array(result["arrays"]["labels"])
                provenance = result["provenance"]
                actual = provenance["measurements"]
                expected = oracle(labels, raw)
                measured = check_measurements(expected, actual)
                channel = (
                    next(iter(actual[0]["intensity"])) if actual else "1: Channel 1"
                )
                population = check_population(workbench, result, expected, channel)
                write_json(run / f"{item['image'].stem}-{method}-oracle.json", expected)
                record["methods"][method] = {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "settings": settings,
                    "resolved_segmentation": provenance["segmentation"],
                    "measurement": measured,
                    "population": population,
                    "annotation_agreement": agreement(labels, reference),
                }
            write_json(run / "numerical-results.json", results)
        results["measurement_correctness"] = "passed"
    except Exception as exc:
        results["failure"] = {"type": type(exc).__name__, "message": str(exc)}
        raise
    finally:
        after = source_identity()
        write_json(run / "source-identity-after.json", after)
        results["source_stable_during_run"] = before == after
        write_json(run / "numerical-results.json", results)
        write_report(run, results)
        print(
            json.dumps(
                {
                    "evidence": str(run),
                    "study": str(workbench.project.root),
                    "status": results["measurement_correctness"],
                    "source_stable": before == after,
                }
            )
        )
    if before != after:
        raise RuntimeError(
            "Engine source changed during evaluation; rerun on stable tree"
        )


if __name__ == "__main__":
    main()
