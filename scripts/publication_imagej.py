#!/usr/bin/env python3
"""Explicit installed-ImageJ comparator; no installation or download path."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

# Support direct script execution and pytest imports from the repository root.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import publication_workflow as workflow

JAVA_SOURCE = ROOT / "scripts" / "PublicationImageJBaseline.java"
FIELDS = (
    "label",
    "area_um2",
    "mean",
    "min",
    "max",
    "raw_sum",
    "imagej_x_um",
    "imagej_y_um",
    "loci_origin_x_um",
    "loci_origin_y_um",
)


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def authored_cases() -> list[dict[str, Any]]:
    """Nine BFS-oracle cases and five independent, hand-authored edge cases."""
    import numpy as np

    ring = np.full((5, 5), 200, np.uint8)
    ring[1:4, 1:4] = 0
    backslash = np.zeros((6, 6), np.uint8)
    backslash[:3, :3], backslash[3:, 3:] = 180, 220
    slash = np.fliplr(backslash).copy()
    nested = np.zeros((9, 9), np.uint8)
    nested[1:8, 1:8], nested[2:7, 2:7], nested[3:5, 3:5] = 180, 0, 220
    variation = np.array(
        [[121, 120, 0, 130], [123, 0, 130, 0], [0, 140, 150, 0]], np.uint8
    )
    compact = np.array([[200, 0, 200, 200], [0, 0, 0, 0], [200, 200, 200, 0]], np.uint8)
    uint16 = np.array(
        [[65535, 120, 0, 1000], [65534, 0, 30000, 0], [0, 1000, 2000, 0]], np.uint16
    )
    definitions = [
        ("topology", workflow.synthetic(), (0.75, 0.5), 120, 1.5),
        ("diagonal-backslash", backslash, (1, 1), 120, 0),
        ("diagonal-slash", slash, (1, 1), 120, 0),
        ("ring", ring, (0.5, 0.25), 120, 2),
        ("ring-above-minimum", ring, (0.5, 0.25), 120, 2.001),
        ("nested-island", nested, (0.5, 0.75), 120, 0),
        ("threshold-and-variation", variation, (2, 3), 120, 0),
        ("filter-and-label-compaction", compact, (1, 1), 120, 2),
        ("empty", np.zeros((3, 3), np.uint8), (1, 1), 120, 0),
    ]
    cases = []
    for name, image, spacing, threshold, minimum in definitions:
        labels, rows = workflow.oracle(image, spacing, threshold, minimum)
        cases.append(
            {
                "name": name,
                "image": image,
                "spacing": spacing,
                "threshold": threshold,
                "minimum": minimum,
                "labels": labels,
                "rows": expected_rows(rows, spacing),
                "expectation": "independent Python queue oracle",
            }
        )
    # n, raw sum, min, max, centroid Y-index, centroid X-index. No segmentation
    # code (including the queue oracle) computes these five expectations.
    edges = [
        (
            "uint16-variable",
            uint16,
            120,
            (2, 3),
            [[1, 0, 0, 2], [1, 0, 3, 0], [0, 3, 3, 0]],
            [
                (2, 131069, 65534, 65535, 0.5, 0),
                (1, 1000, 1000, 1000, 0, 3),
                (3, 33000, 1000, 30000, 5 / 3, 5 / 3),
            ],
        ),
        (
            "uint16-maximum-exclusive",
            uint16,
            65534,
            (2, 3),
            [[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
            [(1, 65535, 65535, 65535, 0, 0)],
        ),
        (
            "single-pixel",
            np.array([[255]], np.uint8),
            0,
            (0.5, 0.25),
            [[1]],
            [(1, 255, 255, 255, 0, 0)],
        ),
        (
            "thin-diagonal",
            np.array([[200, 0], [0, 200]], np.uint8),
            120,
            (1, 1),
            [[1, 0], [0, 2]],
            [(1, 200, 200, 200, 0, 0), (1, 200, 200, 200, 1, 1)],
        ),
        (
            "all-foreground",
            np.full((3, 3), 200, np.uint8),
            0,
            (1, 1),
            [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
            [(9, 1800, 200, 200, 1, 1)],
        ),
    ]
    for name, image, threshold, spacing, labels, formulas in edges:
        sy, sx = spacing
        rows = []
        for label, (n, total, low, high, cy, cx) in enumerate(formulas, 1):
            rows.append(
                dict(
                    zip(
                        FIELDS,
                        (
                            label,
                            n * sy * sx,
                            total / n,
                            low,
                            high,
                            total,
                            (cx + 0.5) * sx,
                            (cy + 0.5) * sy,
                            cx * sx,
                            cy * sy,
                        ),
                        strict=True,
                    )
                )
            )
        cases.append(
            {
                "name": name,
                "image": image,
                "spacing": spacing,
                "threshold": threshold,
                "minimum": 0,
                "labels": np.array(labels, np.uint32),
                "rows": rows,
                "expectation": "authored labels and integer arithmetic",
            }
        )
    return cases


def expected_rows(
    rows: list[dict[str, Any]], spacing: tuple[float, float]
) -> list[dict[str, Any]]:
    sy, sx = spacing
    result = []
    for row in rows:
        raw = row["raw_intensity"]
        x, y, _ = row["centroid_world_xyz"]
        result.append(
            dict(
                zip(
                    FIELDS,
                    (
                        row["label"],
                        row["measure"],
                        raw["mean"],
                        raw["min"],
                        raw["max"],
                        raw["sum"],
                        x + sx / 2,
                        y + sy / 2,
                        x,
                        y,
                    ),
                    strict=True,
                )
            )
        )
    return result


def check_outputs(csv_path: Path, labels_path: Path, expected: dict[str, Any]) -> int:
    import numpy as np

    with csv_path.open(newline="") as stream:
        reader = csv.DictReader(stream)
        workflow.require(
            tuple(reader.fieldnames or ()) == FIELDS, "Comparator CSV schema mismatch"
        )
        actual = list(reader)
    workflow.require(
        len(actual) == len(expected["rows"]), "Comparator object count mismatch"
    )
    checks = 0
    for actual_row, row in zip(actual, expected["rows"], strict=True):
        workflow.require(set(actual_row) == set(FIELDS), "Comparator malformed CSV row")
        for field in FIELDS:
            value, reference = float(actual_row[field]), row[field]
            workflow.require(math.isfinite(value), "Nonfinite comparator value")
            if field == "label":
                workflow.require(value == reference, "Inexact row label")
            else:
                workflow.require(
                    abs(value - reference)
                    <= workflow.ATOL + workflow.RTOL * abs(reference),
                    f"Comparator mismatch: {field}: {value} != {reference}",
                )
            checks += 1
    # Parse integers before uint32 conversion: negative/fractional/overflow labels
    # must never wrap or round into an apparently matching native array.
    with labels_path.open(newline="") as stream:
        matrix = [[int(value) for value in row] for row in csv.reader(stream)]
    shape = expected["labels"].shape
    workflow.require(
        len(matrix) == shape[0] and all(len(row) == shape[1] for row in matrix),
        "Label grid mismatch",
    )
    workflow.require(
        all(0 <= value <= 2**32 - 1 for row in matrix for value in row),
        "Label range mismatch",
    )
    workflow.require(
        np.array_equal(np.array(matrix, np.uint32), expected["labels"]),
        "Exact native label mismatch",
    )
    return checks


def identities(java: Path, jar: Path) -> dict[str, Any]:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip()

    return {
        "commit": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"),
        "status": git("status", "--short"),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("numpy", "tifffile", "pillow")
        },
        "files": {
            name: {"path": str(path), "sha256": sha(path)}
            for name, path in (
                ("java", java),
                ("imagej_jar", jar),
                ("java_source", JAVA_SOURCE),
                ("runner", Path(__file__)),
                ("independent_oracle", Path(workflow.__file__)),
            )
        },
    }


def command(
    argv: list[str], directory: Path, name: str, receipt: dict[str, Any]
) -> subprocess.CompletedProcess[str]:
    entry = {"argv": argv, "cwd": str(ROOT)}
    receipt.setdefault("commands", []).append(entry)
    try:
        result = subprocess.run(
            argv, cwd=ROOT, capture_output=True, text=True, timeout=30, check=False
        )
    except subprocess.TimeoutExpired as exc:
        entry["timed_out"] = True
        for kind, value in (("stdout", exc.stdout), ("stderr", exc.stderr)):
            (directory / f"{name}.{kind}.txt").write_bytes(value or b"")
        raise
    entry["exit_code"] = result.returncode
    for kind in ("stdout", "stderr"):
        (directory / f"{name}.{kind}.txt").write_text(getattr(result, kind))
    return result


def java_argv(
    java: Path,
    jar: Path,
    source: Path,
    csv_path: Path,
    labels: Path | None,
    config: list[str],
) -> list[str]:
    return [
        str(java),
        "-Djava.awt.headless=true",
        "-Xmx256m",
        "-cp",
        str(jar),
        str(JAVA_SOURCE),
        str(source),
        str(csv_path),
        *config,
        *([str(labels)] if labels is not None else []),
    ]


def run(args: argparse.Namespace, receipt: dict[str, Any]) -> None:
    import numpy as np
    import tifffile

    java, jar = (
        Path(args.java).resolve(strict=True),
        Path(args.ij_jar).resolve(strict=True),
    )
    workflow.require(
        java.is_file() and os.access(java, os.X_OK), "Explicit Java executable required"
    )
    workflow.require(jar.is_file(), "Explicit installed ImageJ JAR required")
    before = identities(java, jar)
    receipt["source_identity"] = before
    version = command([str(java), "-version"], args.output, "java-version", receipt)
    workflow.require(version.returncode == 0, "Java runtime failed")
    cases = authored_cases()
    if args.public_cell:
        supplied = Path(args.public_cell)
        image = workflow.public_image(supplied)
        labels, rows = workflow.oracle(image, (0.107, 0.107), 120, 10)
        cases.append(
            {
                "name": "public-cell",
                "image": image,
                "spacing": (0.107, 0.107),
                "threshold": 120,
                "minimum": 10,
                "labels": labels,
                "rows": expected_rows(rows, (0.107, 0.107)),
                "expectation": "independent queue oracle; pinned CC0 encoded samples",
            }
        )
        receipt["public_input"] = {
            "path": str(supplied.resolve()),
            "sha256": sha(supplied),
        }
    receipt["cases"] = []
    for case in cases:
        directory = args.output / case["name"]
        directory.mkdir()
        source = directory / "source.tif"
        if case["image"].dtype == np.uint8:
            workflow.write_fixture(source, case["image"], case["spacing"])
        else:
            tifffile.imwrite(
                source,
                case["image"],
                metadata=None,
                datetime=None,
                photometric="minisblack",
            )
        initial = sha(source)
        csv_path, labels = directory / "measurements.csv", directory / "labels.csv"
        sy, sx = case["spacing"]
        config = list(map(str, (sx, sy, case["threshold"], case["minimum"])))
        save(
            directory / "expected.json",
            {
                "rows": case["rows"],
                "labels": case["labels"].tolist(),
                "expectation": case["expectation"],
                "config_xy_threshold_area": config,
            },
        )
        item = {
            "name": case["name"],
            "source_sha256": initial,
            "expectation": case["expectation"],
        }
        receipt["cases"].append(item)
        result = command(
            java_argv(java, jar, source, csv_path, labels, config),
            directory,
            "imagej",
            receipt,
        )
        workflow.require(
            result.returncode == 0,
            f"ImageJ failed: {case['name']}; inspect retained stderr",
        )
        item["numeric_checks"] = check_outputs(csv_path, labels, case)
        workflow.require(sha(source) == initial, "Original source file changed")
        workflow.require(
            np.array_equal(tifffile.imread(source), case["image"]),
            "Original source samples changed",
        )
        workflow.require(
            "RawSamplesPreserved=true" in result.stdout,
            "ImageJ raw-preservation check absent",
        )
        item.update(
            exact_labels=True,
            source_preserved=True,
            objects=len(case["rows"]),
            csv_sha256=sha(csv_path),
            labels_sha256=sha(labels),
        )
    negative_checks(java, jar, args.output, receipt)
    if args.public_cell:
        workflow.require(
            sha(Path(args.public_cell)) == receipt["public_input"]["sha256"],
            "Original public input changed during comparison",
        )
    after = identities(java, jar)
    receipt["end_source_identity"] = after
    workflow.require(
        before == after,
        "Runtime, comparator, oracle, packages or source identity changed during run",
    )
    receipt["numeric_checks"] = sum(item["numeric_checks"] for item in receipt["cases"])
    receipt["interpretation"] = (
        "Bounded ImageJ API arithmetic/topology checks; no GUI, speed, biological accuracy or release qualification"
    )


def negative_checks(
    java: Path, jar: Path, output: Path, receipt: dict[str, Any]
) -> None:
    import numpy as np
    import tifffile

    directory = output / "admission"
    directory.mkdir()
    source = output / "topology" / "source.tif"
    initial = sha(source)
    negatives = [
        ("nan-spacing", source, ["NaN", "1", "120", "0"]),
        ("infinite-spacing", source, ["1", "Infinity", "120", "0"]),
        ("zero-spacing", source, ["0", "1", "120", "0"]),
        ("overflow-calibration", source, ["1e308", "1e308", "120", "0"]),
        ("underflow-calibration", source, ["1e-300", "1e-300", "120", "0"]),
        ("nan-threshold", source, ["1", "1", "NaN", "0"]),
        ("above-threshold-domain", source, ["1", "1", "65536", "0"]),
        ("negative-threshold", source, ["1", "1", "-1", "0"]),
        ("nan-minimum", source, ["1", "1", "120", "NaN"]),
        ("negative-minimum", source, ["1", "1", "120", "-1"]),
    ]
    for name, image in (
        ("float", np.ones((2, 2), np.float32)),
        ("signed", np.ones((2, 2), np.int16)),
        ("stack", np.ones((2, 2, 2), np.uint8)),
        ("rgb", np.ones((2, 2, 3), np.uint8)),
        ("pixel-budget", np.zeros((1001, 1000), np.uint8)),
        (
            "work-budget",
            (np.indices((512, 512)).sum(axis=0) % 2 * 255).astype(np.uint8),
        ),
    ):
        path = directory / f"{name}.tif"
        tifffile.imwrite(
            path,
            image,
            metadata=None,
            photometric="rgb" if name == "rgb" else "minisblack",
        )
        negatives.append((name, path, ["1", "1", "120", "0"]))
    oversized = directory / "encoded-budget.tif"
    with oversized.open("wb") as stream:
        stream.truncate(16 * 1024 * 1024 + 1)
    negatives.append(("encoded-budget", oversized, ["1", "1", "120", "0"]))
    receipt["admission_checks"] = []
    for name, path, config in negatives:
        csv_path, labels = directory / f"{name}.csv", directory / f"{name}-labels.csv"
        result = command(
            java_argv(java, jar, path, csv_path, labels, config),
            directory,
            name,
            receipt,
        )
        workflow.require(
            result.returncode != 0 and not csv_path.exists() and not labels.exists(),
            f"Invalid input unexpectedly published output: {name}",
        )
        receipt["admission_checks"].append(
            {"name": name, "nonzero": True, "no_outputs": True}
        )
    # Full integer domain maximum produces empty foreground on both bit depths.
    for dtype in (np.uint8, np.uint16):
        name = f"maximum-domain-{np.dtype(dtype)}"
        path, csv_path, labels = (
            directory / f"{name}.{suffix}" for suffix in ("tif", "csv", "labels.csv")
        )
        image = np.array([[np.iinfo(dtype).max]], dtype)
        tifffile.imwrite(path, image, metadata=None)
        result = command(
            java_argv(java, jar, path, csv_path, labels, ["1", "1", "65535", "0"]),
            directory,
            name,
            receipt,
        )
        workflow.require(
            result.returncode == 0, "Maximum threshold must admit empty foreground"
        )
        check_outputs(
            csv_path, labels, {"rows": [], "labels": np.zeros((1, 1), np.uint32)}
        )
        receipt["admission_checks"].append({"name": name, "empty_foreground": True})
    # A fractional threshold preserves strict comparison on integer samples.
    fraction_csv, fraction_labels = (
        directory / "fraction.csv",
        directory / "fraction-labels.csv",
    )
    result = command(
        java_argv(
            java,
            jar,
            source,
            fraction_csv,
            fraction_labels,
            ["0.5", "0.75", "120.5", "1.5"],
        ),
        directory,
        "fraction",
        receipt,
    )
    workflow.require(result.returncode == 0, "Fractional threshold rejected")
    check_outputs(fraction_csv, fraction_labels, authored_cases()[0])
    receipt["admission_checks"].append(
        {"name": "fractional-threshold", "strict_comparison": True}
    )
    # Existing and aliased outputs, including dangling symlinks, are never replaced.
    for name in ("collision", "same-outputs", "dangling-symlink"):
        csv_path, labels = directory / f"{name}.csv", directory / f"{name}-labels.csv"
        if name == "collision":
            labels.write_text("preserved\n")
        elif name == "same-outputs":
            labels = csv_path
        else:
            labels.symlink_to(directory / "missing-target")
        result = command(
            java_argv(
                java, jar, source, csv_path, labels, ["0.5", "0.75", "120", "1.5"]
            ),
            directory,
            name,
            receipt,
        )
        workflow.require(
            result.returncode != 0 and not csv_path.exists(),
            "Output collision unexpectedly succeeded",
        )
        if name == "collision":
            workflow.require(
                labels.read_text() == "preserved\n", "Existing output overwritten"
            )
        if name == "dangling-symlink":
            workflow.require(
                labels.is_symlink() and not labels.exists(), "Dangling symlink replaced"
            )
        receipt["admission_checks"].append(
            {"name": name, "nonzero": True, "preserved": True}
        )
    legacy = directory / "six-argument.csv"
    result = command(
        java_argv(java, jar, source, legacy, None, ["0.5", "0.75", "120", "1.5"]),
        directory,
        "six-argument",
        receipt,
    )
    workflow.require(
        result.returncode == 0
        and legacy.read_bytes() == (output / "topology/measurements.csv").read_bytes(),
        "Legacy six-argument CLI differs",
    )
    workflow.require(sha(source) == initial, "Admission checks changed original source")
    receipt["six_argument_compatible"] = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, required=True, help="Absent evidence directory"
    )
    parser.add_argument(
        "--java",
        required=True,
        help="Explicit operator-supplied installed Java executable",
    )
    parser.add_argument(
        "--ij-jar",
        required=True,
        help="Explicit operator-supplied installed ImageJ JAR",
    )
    parser.add_argument(
        "--public-cell", help="Optional previously acquired exact pinned CC0 cell.png"
    )
    args = parser.parse_args(argv)
    args.output = args.output.absolute()
    if args.output.exists() or args.output.is_symlink():
        print("Output directory must be absent", file=sys.stderr)
        return 1
    args.output.mkdir(parents=True)
    receipt: dict[str, Any] = {
        "status": "running",
        "requested_runtime": {"java": args.java, "ij_jar": args.ij_jar},
    }
    try:
        run(args, receipt)
        receipt["status"] = "passed"
        code = 0
    except Exception as exc:  # noqa: BLE001 - retain diagnostics and exit nonzero at CLI boundary
        receipt.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        (args.output / "failure.traceback.txt").write_text(traceback.format_exc())
        print(receipt["error"], file=sys.stderr)
        code = 1
    save(args.output / "receipt.json", receipt)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
