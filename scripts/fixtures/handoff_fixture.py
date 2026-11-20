"""Independent synthetic TIFF oracle for the packaged external segmentation workflow."""

import argparse
import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import imageio.v3 as imageio
import numpy as np
import tifffile

HEIGHT, WIDTH = 19, 27
DEPTH = 5
IDENTITIES = (7, 2**32 - 1)


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pixels(t, c, z):
    y, x = np.indices((HEIGHT, WIDTH))
    return (1000 + 16000 * t + 4000 * c + 320 * z + 9 * y + 2 * x).astype(np.uint16)


def expected_mask(volume):
    shape = (3, HEIGHT, WIDTH) if volume else (HEIGHT, WIDTH)
    mask = np.zeros(shape, dtype=np.uint32)
    mask[..., 2:5, 3:7] = IDENTITIES[0]
    mask[..., 10:15, 12:18] = IDENTITIES[1]
    if volume:
        mask[0, 10:15, 12:18] = 0
    return mask


def generate(directory):
    raw = np.stack(
        [
            np.stack(
                [np.stack([pixels(t, c, z) for z in range(DEPTH)]) for c in range(2)]
            )
            for t in range(2)
        ]
    )
    original = directory / "synthetic.ome.tif"
    tifffile.imwrite(
        original,
        raw,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.0,
            "PhysicalSizeZ": 2.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["Synthetic A", "Synthetic B"]},
        },
    )
    masks = {}
    for volume in (False, True):
        axes = "ZYX" if volume else "YX"
        dest = directory / f"authored-labels-{axes}.tif"
        if volume:
            tifffile.imwrite(
                dest,
                expected_mask(True),
                photometric="minisblack",
                compression="zlib",
                metadata={"axes": axes},
            )
        else:
            # The automatic-segmentation writer in micro-sam 2.0.1.
            imageio.imwrite(dest, expected_mask(False), compression="zlib")
        masks[axes] = {"file": str(dest), "sha256": file_hash(dest)}
    ambiguous = directory / "ambiguous-three-plane-labels.tif"
    imageio.imwrite(ambiguous, expected_mask(True), compression="zlib")
    return {
        "source": str(original),
        "ambiguous_volume": str(ambiguous),
        "sha256": file_hash(original),
        "width": WIDTH,
        "height": HEIGHT,
        "depth": DEPTH,
        "labels": masks,
    }


def verify_input(tiff, selection):
    t, c, z = (selection[key] for key in ("t", "c", "z"))
    assert selection["level"] == selection["x"] == selection["y"] == 0
    assert selection["width"] == WIDTH and selection["height"] == HEIGHT
    volume = "z_stop" in selection
    expected = (
        np.stack([pixels(t, c, k) for k in range(z, selection["z_stop"])])
        if volume
        else pixels(t, c, z)
    )
    with tifffile.TiffFile(tiff) as container:
        assert len(container.series) == 1
        series = container.series[0]
        assert series.axes == ("ZYX" if volume else "YX")
        assert all(page.samplesperpixel == 1 for page in container.pages)
        result = series.asarray()
    assert result.dtype == np.dtype("uint16")
    np.testing.assert_array_equal(result, expected)
    # micro-sam loads ordinary image files through imageio when no key is supplied.
    np.testing.assert_array_equal(imageio.imread(tiff), expected)
    return {
        "shape": list(result.shape),
        "dtype": str(result.dtype),
        "axes": "ZYX" if volume else "YX",
        "sha256": file_hash(tiff),
        "minimum": int(result.min()),
        "maximum": int(result.max()),
    }


def verify_result(study, record, selection):
    result = record.get("result", record)
    database = (study / "study.sqlite3").resolve(strict=True)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        row = conn.execute(
            "SELECT record FROM results WHERE id = ?", (result["id"],)
        ).fetchone()
    saved = json.loads(row[0])
    assert saved["revision_hash"] == result["revision_hash"]
    assert (
        saved["provenance"]["external_labels"]
        == record["provenance"]["external_labels"]
    )
    desc = saved["arrays"]["labels"]
    path = study / "artifacts" / (desc["sha256"] + ".npy")
    assert (
        path.is_file() and not path.is_symlink() and file_hash(path) == desc["sha256"]
    )
    actual = np.load(path, allow_pickle=False)
    volume = "z_stop" in selection
    expected = expected_mask(volume)
    np.testing.assert_array_equal(actual, expected)
    assert actual.dtype == np.uint32
    assert record["measurements"] == saved["provenance"]["measurements"]
    rows = {row["label"]: row for row in record["measurements"]}
    assert set(rows) == set(IDENTITIES)
    plane = pixels(selection["t"], selection["c"], selection["z"])
    raw = (
        np.stack(
            [
                pixels(selection["t"], selection["c"], k)
                for k in range(selection["z"], selection["z_stop"])
            ]
        )
        if volume
        else plane
    )
    signal = saved["arrays"]["image"]
    source_artifact = study / "artifacts" / (signal["sha256"] + ".npy")
    assert file_hash(source_artifact) == signal["sha256"]
    np.testing.assert_array_equal(np.load(source_artifact, allow_pickle=False), raw)
    for label, row in rows.items():
        vals = raw[expected == label]
        assert row["voxel_count"] == len(vals)
        assert row["measure_kind"] == ("volume" if volume else "area")
        assert row["measure_unit"] == ("um^3" if volume else "um^2")
        assert row["measure"] == len(vals) * (1 if volume else 0.5)
        assert len(row["intensity"]) == 1
        stats = next(iter(row["intensity"].values()))
        assert stats["min"] == float(vals.min()) and stats["max"] == float(vals.max())
        assert stats["sum"] == float(vals.sum()) and stats["mean"] == float(vals.mean())
    return {
        "identities": sorted(rows),
        "pixels_per_object": [rows[i]["voxel_count"] for i in sorted(rows)],
        "checked_raw_measures": True,
        "labels_sha256": desc["sha256"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    generate_args = sub.add_parser("generate")
    generate_args.add_argument("directory", type=Path)
    input_args = sub.add_parser("input")
    input_args.add_argument("tiff", type=Path)
    input_args.add_argument("selection", type=json.loads)
    result_args = sub.add_parser("result")
    result_args.add_argument("study", type=Path)
    result_args.add_argument("record", type=Path)
    result_args.add_argument("selection", type=json.loads)
    args = parser.parse_args()
    if args.command == "generate":
        report = generate(args.directory)
    elif args.command == "input":
        report = verify_input(args.tiff, args.selection)
    else:
        report = verify_result(
            args.study, json.loads(args.record.read_text()), args.selection
        )
    print(json.dumps(report, allow_nan=False))
