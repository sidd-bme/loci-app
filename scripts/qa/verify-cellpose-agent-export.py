"""Compare exported masks and every measured object to the pinned BBBC034 native channels."""

import csv
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import tifffile


def grid_digest(grid: np.ndarray) -> str:
    header = json.dumps(
        {"shape": list(grid.shape), "dtype": str(grid.dtype)},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(header + grid.tobytes(order="C")).hexdigest()


def verify(
    source_file: Path,
    export: Path,
    preview_digest: str,
    input_digest: str,
    raw_digest: str,
    parent_export: str | None = None,
    deleted_label: str | None = None,
) -> dict:
    receipt = json.loads((export / "result.json").read_bytes())
    assert (
        receipt["source"]["sha256"]
        == hashlib.sha256(source_file.read_bytes()).hexdigest()
    )
    with tifffile.TiffFile(source_file) as source:
        assert source.series[0].axes == "CYX"
        image = source.series[0].asarray()
    assert image.shape == (3, 624, 924) and image.dtype == np.uint16
    result = receipt["result"]
    accepted = result["provenance"]["accepted_request"]
    selection = accepted["selection"]
    assert selection == {
        "x": 320,
        "y": 192,
        "width": 256,
        "height": 256,
        "c": 0,
        "t": 0,
        "z": 0,
        "level": 0,
    }
    assert accepted["measurement_channels"] == [1]
    labels = np.load(export / "labels.npy", allow_pickle=False)
    assert labels.shape == (256, 256) and labels.dtype == np.uint32
    ome_labels = tifffile.imread(export / "labels.ome.tif")
    assert ome_labels.dtype == labels.dtype
    np.testing.assert_array_equal(labels, ome_labels)
    if parent_export is None:
        assert deleted_label is None and grid_digest(labels) == preview_digest
    else:
        assert deleted_label is not None and result["kind"] == "corrected-labels"
        parent = Path(parent_export)
        parent_result = json.loads((parent / "result.json").read_bytes())["result"]
        assert result["parent_id"] == parent_result["id"]
        assert (
            result["provenance"]["correction"]["parent_revision_hash"]
            == parent_result["revision_hash"]
        )
        original = np.load(parent / "labels.npy", allow_pickle=False)
        assert grid_digest(original) == preview_digest
        remove = original == int(deleted_label)
        assert np.any(remove)
        np.testing.assert_array_equal(labels, np.where(remove, np.uint32(0), original))
    ids = set(np.unique(labels)) - {0}
    rows = result["provenance"]["measurements"]
    assert ids and len(rows) == len(ids) and ids == {row["label"] for row in rows}
    x, y = selection["x"], selection["y"]
    crop = image[1, y : y + labels.shape[0], x : x + labels.shape[1]]
    assert grid_digest(crop) == raw_digest
    inference = image[0, y : y + labels.shape[0], x : x + labels.shape[1]]
    assert grid_digest(inference) == input_digest
    with (export / "objects.csv").open(newline="", encoding="utf-8") as handle:
        csv_rows = {int(row["label"]): row for row in csv.DictReader(handle)}
    assert csv_rows.keys() == ids
    for row in rows:
        raw = crop[labels == row["label"]].astype(np.float64)
        assert raw.size == row["voxel_count"]
        assert set(row["intensity"]) == {"source_channel_1"}
        expected = {
            "mean": raw.mean(),
            "sum": raw.sum(),
            "min": raw.min(),
            "max": raw.max(),
            "std_population": raw.std(ddof=0),
        }
        observed = row["intensity"]["source_channel_1"]
        table_row = csv_rows[row["label"]]
        assert int(table_row["voxel_count"]) == raw.size
        for name, value in expected.items():
            np.testing.assert_allclose(observed[name], value, rtol=1e-12, atol=0)
            np.testing.assert_allclose(
                float(table_row[f"intensity:source_channel_1:{name}"]),
                value,
                rtol=1e-12,
                atol=0,
            )
    return {
        "objects": len(ids),
        "first_label": int(min(ids)),
        "measured_channel": 1,
        "mask_pixels": int(np.sum(labels > 0)),
        "statistics_per_object": sorted(expected),
        "exact_exported_labels": True,
    }


if __name__ == "__main__":
    print(json.dumps(verify(Path(sys.argv[1]), Path(sys.argv[2]), *sys.argv[3:])))
