"""Generate a synthetic OME-TIFF and read disposable CLI study state independently."""

import argparse
import hashlib
import io
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import numpy as np


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def generate(path):
    import tifffile

    pixels = np.zeros((2, 32, 32), dtype=np.uint16)
    pixels[0, 5:11, 6:12] = 140
    pixels[0, 18:25, 16:23] = 260
    pixels[1, 5:11, 6:12] = 45
    pixels[1, 18:25, 16:23] = 195
    tifffile.imwrite(
        path,
        pixels,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.0,
            "Channel": {"Name": ["Synthetic A", "Synthetic B"]},
        },
    )
    return {
        "source_sha256": digest(path.read_bytes()),
        "axes": "CYX",
        "shape": [2, 32, 32],
    }


def snapshot(study, image):
    database = (study / "study.sqlite3").resolve(strict=True)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        return {
            "source_sha256": digest(image.read_bytes()),
            "sources": dict(db.execute("SELECT id, record FROM sources")),
            "results": dict(db.execute("SELECT id, record FROM results")),
            "jobs": dict(db.execute("SELECT id, record FROM jobs")),
            "metadata": dict(db.execute("SELECT key, value FROM metadata")),
            # Viewer documents can be written by normal navigation and camera hydration.
            "artifacts": {
                file.name: digest(file.read_bytes())
                for file in sorted((study / "artifacts").iterdir())
                if file.is_file()
            },
        }


def labels(study, record):
    descriptor = record["arrays"]["labels"]
    checksum = descriptor["sha256"]
    assert len(checksum) == 64 and all(c in "0123456789abcdef" for c in checksum)
    path = study / "artifacts" / (checksum + ".npy")
    assert not path.is_symlink()
    raw = path.read_bytes()
    assert len(raw) == descriptor["bytes"] and digest(raw) == checksum
    labels = np.load(io.BytesIO(raw), allow_pickle=False)
    assert list(labels.shape) == descriptor["shape"] == [26, 26]
    assert str(labels.dtype) == descriptor["dtype"] == "uint32"
    return labels


def verify(study, original_id, new_id, state):
    original = json.loads(state["results"][original_id])
    replay = json.loads(state["results"][new_id])
    orig_labels = labels(study, original)
    new_labels = labels(study, replay)
    expected = np.zeros((26, 26), dtype=np.uint32)
    # The two authored source rectangles translated into the ROI at X=2, Y=2.
    expected[3:9, 4:10] = 1
    expected[16:23, 14:21] = 2
    np.testing.assert_array_equal(orig_labels, expected)
    np.testing.assert_array_equal(new_labels, expected)
    original_data = original["provenance"]
    new_data = replay["provenance"]
    assert new_data["measurements"] == original_data["measurements"]
    assert (
        new_data["geometry"]
        == original_data["geometry"]
        == {
            "axes": "YX",
            "unit": "um",
            "frame": "image",
            "affine": [[0.5, 0, 0, 1], [0, 1, 0, 2], [0, 0, 1, 0], [0, 0, 0, 1]],
        }
    )
    assert new_data["measurement_basis"] == original_data["measurement_basis"]
    assert new_data["measurement_basis"] == "raw-selected-channel-values-on-result-grid"
    rows = new_data["measurements"]
    assert len(rows) == 2
    for row, count, world, intensity_a, intensity_b in zip(
        rows,
        (36, 49),
        ([4.25, 7.5, 0.0], [9.5, 21.0, 0.0]),
        (140, 260),
        (45, 195),
        strict=True,
    ):
        assert row["voxel_count"] == count and row["measure"] == count * 0.5
        assert row["measure_kind"] == "area" and row["measure_unit"] == "um^2"
        assert row["index_axes"] == "YX" and row["centroid_world_xyz"] == world
        for channel, value in (
            ("1: Synthetic A", intensity_a),
            ("2: Synthetic B", intensity_b),
        ):
            assert row["intensity"][channel] == {
                "min": value,
                "max": value,
                "mean": value,
                "sum": count * value,
                "std_population": 0,
            }
    return {
        "original_labels_npy_sha256": original["arrays"]["labels"]["sha256"],
        "replay_labels_npy_sha256": replay["arrays"]["labels"]["sha256"],
        "decoded_labels_sha256": digest(
            new_labels.astype("<u4", copy=False).tobytes(order="C")
        ),
        "labels_shape_yx": list(new_labels.shape),
        "labels_dtype": str(new_labels.dtype),
        "pixel_exact_to_authored_geometry": True,
        "measurement_rows_exact_match": True,
        "measurement_rows": rows,
        "geometry": new_data["geometry"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    generator = sub.add_parser("generate")
    generator.add_argument("image", type=Path)
    reader = sub.add_parser("snapshot")
    reader.add_argument("study", type=Path)
    reader.add_argument("image", type=Path)
    verifier = sub.add_parser("verify")
    verifier.add_argument("study", type=Path)
    verifier.add_argument("snapshot", type=Path)
    verifier.add_argument("original_id")
    verifier.add_argument("new_id")
    args = parser.parse_args()
    if args.action == "generate":
        output = generate(args.image)
    elif args.action == "snapshot":
        output = snapshot(args.study, args.image)
    else:
        output = verify(
            args.study,
            args.original_id,
            args.new_id,
            json.loads(args.snapshot.read_text()),
        )
    print(json.dumps(output, allow_nan=False, sort_keys=True))


if __name__ == "__main__":
    main()
