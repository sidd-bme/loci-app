#!/usr/bin/env python3
"""Bounded, synthetic-only readback for the packaged M6 exchange journey.

The fixture equations are fixed here independently of the result producer. TIFF
segments and SQLite rows are read one at a time; the decoded grids are never
materialised. A study check uses its stored cores through the public reader.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import sys
import xml.etree.ElementTree as ET

import numpy as np
import tifffile

SIDE = 16_384
CORE = 512
COUNT = 1_026
CAL = (0.5, 0.75)


def rectangles():
    cells = [
        (y + 64, y + 192, x + 64, x + 192, 200 + (y // CORE * 32 + x // CORE) % 400)
        for y in range(0, SIDE, CORE)
        for x in range(0, SIDE, CORE)
    ]
    cells.append((500, 524, 500, 524, 900))
    return sorted(cells, key=lambda item: (item[0], item[2]))


RECTS = rectangles()


def expected_tile(y, x, *, raw=False, removed=False):
    yy, xx = np.ogrid[y : y + CORE, x : x + CORE]
    output = ((yy * 13 + xx * 7) % 37).astype(np.uint16) if raw else np.zeros((CORE, CORE), np.uint32)
    bar = ((yy >= 20) & (yy < 23)) | ((xx >= 20) & (xx < 23))
    output[np.broadcast_to(bar, output.shape)] = 600 if raw else (0 if removed else 1)
    for label, (y0, y1, x0, x1, value) in enumerate(RECTS, 2):
        ya, yb, xa, xb = max(y, y0), min(y + CORE, y1), max(x, x0), min(x + CORE, x1)
        if ya < yb and xa < xb:
            output[ya - y : yb - y, xa - x : xb - x] = value if raw else label
    return output


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def close(actual, expected, name):
    assert isinstance(actual, (int, float)) and math.isfinite(actual), name
    assert abs(actual - expected) <= 1e-9 + 1e-12 * abs(expected), (name, actual, expected)


def oracle_rows(removed):
    # The cross is a disjoint union of two 3-pixel-wide bars after subtracting
    # their 3x3 intersection. Integer moments avoid cancellation while deriving
    # its centroid and covariance. Rectangles have closed-form uniform moments.
    def sums(lo, hi):
        n = hi - lo
        return n, n * (lo + hi - 1) // 2, sum(i * i for i in range(lo, hi))

    rows = []
    if not removed:
        a, sy, sy2 = sums(20, 23)
        b, sx, sx2 = sums(20, 23)
        n = 6 * SIDE - 9
        sum_y = sy * SIDE + sums(0, SIDE)[1] * b - sy * b
        sum_x = sums(0, SIDE)[1] * a + sx * SIDE - sx * a
        sum_y2 = sy2 * SIDE + sums(0, SIDE)[2] * b - sy2 * b
        sum_x2 = sums(0, SIDE)[2] * a + sx2 * SIDE - sx2 * a
        sum_yx = sy * sums(0, SIDE)[1] + sums(0, SIDE)[1] * sx - sy * sx
        cy, cx = sum_y / n, sum_x / n
        cov = np.array([[.75**2 * (sum_y2 / n - cy**2), .75 * .5 * (sum_yx / n - cy * cx)],
                        [.75 * .5 * (sum_yx / n - cy * cx), .5**2 * (sum_x2 / n - cx**2)]])
        rows.append((1, n, 600, [cy, cx], [0, 0], [SIDE, SIDE],
                     np.sqrt(np.maximum(np.linalg.eigvalsh(cov)[::-1], 0)).tolist() + [0.0]))
    for label, (y0, y1, x0, x1, value) in enumerate(RECTS, 2):
        h, w = y1 - y0, x1 - x0
        rows.append((label, h * w, value, [(y0 + y1 - 1) / 2, (x0 + x1 - 1) / 2],
                     [y0, x0], [y1, x1],
                     sorted([.75 * math.sqrt((h * h - 1) / 12), .5 * math.sqrt((w * w - 1) / 12), 0], reverse=True)))
    return rows


def check_rows(rows, removed):
    expected = oracle_rows(removed)
    assert len(rows) == len(expected) == COUNT - int(removed)
    centers = np.asarray([[r[3][1] * .5, r[3][0] * .75] for r in expected])
    for index, (row, (label, n, value, center, start, stop, radii)) in enumerate(zip(rows, expected, strict=True)):
        assert row["label"] == label and row["voxel_count"] == n, label
        assert row["measure_kind"] == "area" and row["measure_unit"] == "um^2", label
        assert row["index_axes"] == "YX" and row["world_frame"] == "image" and row["distance_unit"] == "um", label
        assert row["bbox_start"] == start and row["bbox_stop_exclusive"] == stop, label
        assert row["touches_crop_border"] is (label == 1), label
        close(row["measure"], n * .375, f"{label}:area")
        for actual, wanted in zip(row["centroid_index"], center, strict=True):
            close(actual, wanted, f"{label}:index")
        for actual, wanted in zip(row["centroid_world_xyz"], [center[1] * .5, center[0] * .75, 0], strict=True):
            close(actual, wanted, f"{label}:world")
        for actual, wanted in zip(row["principal_rms_radii"], radii, strict=True):
            close(actual, wanted, f"{label}:radii")
        intensity = row["intensity"]
        assert set(intensity) == {"1: Channel 1"}, label
        assert set(intensity["1: Channel 1"]) == {"min", "max", "mean", "sum", "std_population"}, label
        for key, wanted in {"min": value, "max": value, "mean": value, "sum": n * value, "std_population": 0}.items():
            close(intensity["1: Channel 1"][key], wanted, f"{label}:{key}")
        distance = np.linalg.norm(centers - centers[index], axis=1)
        distance[index] = math.inf
        close(row["nearest_centroid_distance"], float(distance.min()), f"{label}:nearest")


def check_tiff(path, *, raw, removed):
    with tifffile.TiffFile(path) as tif:
        assert len(tif.pages) == 1
        page = tif.pages[0]
        assert page.shape == (SIDE, SIDE)
        assert page.dtype == (np.dtype("uint16") if raw else np.dtype("uint32"))
        assert page.is_tiled and page.tilewidth == page.tilelength == CORE
        pixels = next(node for node in ET.fromstring(tif.ome_metadata).iter() if node.tag.endswith("}Pixels"))
        assert pixels.attrib["DimensionOrder"] in {"XYCZT", "XYZCT", "XYZTC", "XYCTZ", "XYTCZ", "XYTZC"}
        assert [float(pixels.attrib[f"PhysicalSize{axis}"]) for axis in "XY"] == list(CAL)
        assert [pixels.attrib[f"PhysicalSize{axis}Unit"] for axis in "XY"] == ["µm", "µm"]
        positions = set()
        for data, index, _ in page.segments(maxworkers=1):
            y, x = index[2:4]
            assert 0 <= y < SIDE and 0 <= x < SIDE and y % CORE == x % CORE == 0
            assert (y, x) not in positions, (path, y, x)
            positions.add((y, x))
            assert np.array_equal(data[0, :, :, 0], expected_tile(y, x, raw=raw, removed=removed)), (path, y, x)
        assert len(positions) == (SIDE // CORE) ** 2, (path, len(positions))
    return len(positions)


def check_export(root, removed):
    manifest = json.loads((root / "manifest.json").read_text())
    record = json.loads((root / "result.json").read_text())
    result = record["result"]
    assert manifest["result_id"] == result["id"] and manifest["revision_hash"] == result["revision_hash"]
    assert result["object_count"] == COUNT - int(removed)
    assert result["provenance"]["selection"] == {"x": 0, "y": 0, "width": SIDE, "height": SIDE, "t": 0, "c": 0, "z": 0, "level": 0}
    assert result["provenance"]["geometry"] == {"axes": "YX", "frame": "image", "unit": "um", "affine": [[.5, 0, 0, 0], [0, .75, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
    names = set()
    for item in manifest["files"]:
        name = item["name"]
        assert name == Path(name).name and name not in names
        names.add(name)
        path = root / name
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == item["size_bytes"] and file_hash(path) == item["sha256"], name
    assert {"image.ome.tif", "labels.ome.tif", "objects.csv", "objects.sqlite3", "result.json"} <= names
    tiles = {name: check_tiff(root / f"{name}.ome.tif", raw=name == "image", removed=removed) for name in ("image", "labels")}
    table_path = root / "objects.sqlite3"
    assert file_hash(table_path) == result["object_table"]["sha256"]
    with sqlite3.connect(f"file:{table_path}?mode=ro&immutable=1", uri=True) as connection:
        rows = []
        for label, value in connection.execute("SELECT label,record FROM objects ORDER BY label"):
            row = json.loads(value)
            assert label == row["label"]
            rows.append(row)
    check_rows(rows, removed)
    with (root / "objects.csv").open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames is not None and len(reader.fieldnames) == len(set(reader.fieldnames))
        csv_count = 0
        for row, canonical in zip(reader, rows, strict=True):
            flat = {}
            for key, value in canonical.items():
                if isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        if isinstance(subvalue, dict):
                            flat.update({f"{key}:{subkey}:{field}": field_value for field, field_value in subvalue.items()})
                        else:
                            flat[f"{key}:{subkey}"] = subvalue
                elif isinstance(value, list):
                    flat.update({f"{key}:{axis}": item for axis, item in enumerate(value)})
                else:
                    flat[key] = value
            assert set(reader.fieldnames) == set(flat) == set(row), canonical["label"]
            for key, value in flat.items():
                expected = "" if value is None else str(value)
                assert row[key] == expected, (canonical["label"], key, row[key], expected)
            csv_count += 1
    assert csv_count == len(rows)
    return {"result_id": result["id"], "revision_hash": result["revision_hash"], "objects": len(rows), "exact_tiff_tiles": tiles, "all_csv_fields": True, "manifest_files": len(names)}


def check_study(root, result_id, removed):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/src"))
    from loci_engine.research_project import ResearchProject
    from loci_engine.research_tiled_store import iter_object_rows, iter_tiles

    project = ResearchProject(root)
    result = project.result(result_id)
    assert result["schema"] == "loci.research-result/v2"
    assert result["kind"] == ("large-corrected-labels" if removed else "large-components")
    assert (result["parent_id"] is not None) == removed
    assert result["provenance"]["selection"] == {"x": 0, "y": 0, "width": SIDE, "height": SIDE, "t": 0, "c": 0, "z": 0, "level": 0}
    assert result["provenance"]["geometry"] == {"axes": "YX", "frame": "image", "unit": "um", "affine": [[.5, 0, 0, 0], [0, .75, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
    assert result["provenance"]["remote_exchange"]["remote_result_id"]
    if removed:
        assert project.review_state(result_id)["disposition"] == "reviewed"
    assert result["object_count"] == COUNT - int(removed)
    rows = list(iter_object_rows(project, result["object_table"]))
    check_rows(rows, removed)
    tiles = {}
    for name in ("image", "labels"):
        positions = set()
        for y, x, values in iter_tiles(project, result["arrays"][name]):
            assert (y, x) not in positions
            positions.add((y, x))
            assert np.array_equal(values, expected_tile(y, x, raw=name == "image", removed=removed)), (name, y, x)
        assert len(positions) == (SIDE // CORE) ** 2
        tiles[name] = len(positions)
    return {"result_id": result_id, "revision_hash": result["revision_hash"], "objects": len(rows), "exact_study_cores": tiles}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--export", type=Path)
    parser.add_argument("--study", type=Path)
    parser.add_argument("--result-id")
    parser.add_argument("--removed", action="store_true")
    parser.add_argument("--fixture", type=Path, help="Also verify the immutable synthetic source TIFF against the oracle")
    args = parser.parse_args()
    assert (args.export is None) != (args.study is None)
    assert (args.study is None) == (args.result_id is None)
    assert args.fixture is None or args.export is not None
    receipt = check_export(args.export, args.removed) if args.export else check_study(args.study, args.result_id, args.removed)
    if args.fixture is not None:
        receipt["exact_source_tiff_tiles"] = check_tiff(args.fixture, raw=True, removed=False)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
