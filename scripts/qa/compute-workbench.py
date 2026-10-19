"""Independent arithmetic for the bounded public-image remote-compute journey.

Reads SQLite, NPY and TIFF directly. It does not import the application engine.
This checks engineering consistency, not segmentation accuracy or biology.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
from pathlib import Path

import numpy as np
import tifffile
from scipy import ndimage


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def record(project, identity):
    with sqlite3.connect(
        f"file:{project / 'study.sqlite3'}?mode=ro", uri=True
    ) as database:
        row = database.execute(
            "SELECT record FROM results WHERE id=?", (identity,)
        ).fetchone()
    assert row is not None
    return json.loads(row[0])


def array(project, descriptor):
    path = project / "artifacts" / (descriptor["sha256"] + ".npy")
    assert digest(path) == descriptor["sha256"]
    value = np.load(path, allow_pickle=False)
    assert list(value.shape) == descriptor["shape"]
    return value


def check(project, source, identity, expected_device, parent_id=None, export=None):
    value = record(project, identity)
    provenance = value["provenance"]
    selection = provenance["selection"]
    assert value["source_sha256"] == digest(source)
    assert provenance["geometry"]["unit"] == "pixel"
    assert selection["level"] == selection["z"] == selection["t"] == selection["c"] == 0
    raw = tifffile.imread(source)
    assert raw.ndim == 2
    raw = raw[
        selection["y"] : selection["y"] + selection["height"],
        selection["x"] : selection["x"] + selection["width"],
    ]
    image = array(project, value["arrays"]["image"])
    if expected_device == "classical":
        np.testing.assert_array_equal(image, raw)
        image_basis = "raw-source-plane"
    else:
        # Cellpose retains a normalized result-view image. Reconstruct that
        # display contract independently; quantitative statistics below must
        # still use the original TIFF samples, including their full range.
        assert (
            provenance["measurement_basis"]
            == "raw-selected-channel-values-on-result-grid"
        )
        display_input = raw.astype(np.float32)
        low, high = np.percentile(display_input, (1, 99))
        assert high > low, "The qualification fixture must have usable display contrast"
        expected_image = (
            np.clip((np.clip(display_input, low, high) - low) / (high - low), 0, 1)
            .astype(np.float32)
            .astype(np.float64)
        )
        np.testing.assert_array_equal(image, expected_image)
        assert not np.array_equal(image, raw)
        image_basis = "result-view-float32-percentile-1-99-clipped"
    labels = array(project, value["arrays"]["labels"])
    assert labels.shape == raw.shape and labels.dtype.kind in "ui"
    ids = np.unique(labels)
    ids = ids[ids != 0]
    rows = provenance["measurements"]
    assert len(rows) == len(ids) and len(ids) > 0
    assert [row["label"] for row in rows] == ids.tolist()
    exported_rows = None
    if export:
        with (export / "objects.csv").open(newline="") as stream:
            exported_rows = list(csv.DictReader(stream))
        assert [int(row["label"]) for row in exported_rows] == ids.tolist()
    numerical_fields = 0
    for index, (label, row) in enumerate(zip(ids, rows, strict=True)):
        mask = labels == label
        coordinates = np.argwhere(mask)
        intensity = raw[mask].astype(np.float64)
        assert row["voxel_count"] == int(mask.sum())
        assert row["measure"] == float(mask.sum())
        assert row["measure_kind"] == "area" and row["measure_unit"] == "pixel^2"
        np.testing.assert_allclose(
            row["centroid_index"], coordinates.mean(axis=0), rtol=1e-12, atol=1e-9
        )
        centroid_world = [coordinates[:, 1].mean(), coordinates[:, 0].mean(), 0.0]
        np.testing.assert_allclose(
            row["centroid_world_xyz"], centroid_world, rtol=1e-12, atol=1e-9
        )
        assert row["bbox_start"] == coordinates.min(axis=0).tolist()
        assert row["bbox_stop_exclusive"] == (coordinates.max(axis=0) + 1).tolist()
        expected = {
            "sum": intensity.sum(),
            "mean": intensity.mean(),
            "min": intensity.min(),
            "max": intensity.max(),
            "std_population": intensity.std(),
        }
        assert len(row["intensity"]) == 1
        observed = next(iter(row["intensity"].values()))
        for field, number in expected.items():
            assert np.isclose(observed[field], number, rtol=1e-12, atol=1e-9)
        expected_fields = {
            "voxel_count": int(mask.sum()),
            "measure": float(mask.sum()),
            **{
                f"centroid_index:{axis}": number
                for axis, number in enumerate(coordinates.mean(axis=0))
            },
            **{
                f"centroid_world_xyz:{axis}": number
                for axis, number in enumerate(centroid_world)
            },
            **{
                f"bbox_start:{axis}": number
                for axis, number in enumerate(coordinates.min(axis=0))
            },
            **{
                f"bbox_stop_exclusive:{axis}": number
                for axis, number in enumerate(coordinates.max(axis=0) + 1)
            },
            **{
                f"intensity:{next(iter(row['intensity']))}:{field}": number
                for field, number in expected.items()
            },
        }
        numerical_fields += len(expected_fields)
        if exported_rows is not None:
            exported_row = exported_rows[index]
            assert (
                exported_row["measure_kind"] == "area"
                and exported_row["measure_unit"] == "pixel^2"
            )
            for field, number in expected_fields.items():
                assert np.isclose(
                    float(exported_row[field]), number, rtol=1e-12, atol=1e-9
                )
    runtime = provenance["runtime"]
    if expected_device == "classical":
        expected_labels, _ = ndimage.label(
            raw > 1000, structure=ndimage.generate_binary_structure(2, 1)
        )
        np.testing.assert_array_equal(labels, expected_labels)
        assert runtime["resolved_device"] == "cpu"
    else:
        model = runtime["cellpose"]
        assert model["requested_device"] == model["resolved_device"] == expected_device
        assert model["fallback_reason"] is None
        assert model["package"] == {"name": "cellpose", "version": "4.2.1.1"}
        assert model["model"] == {
            "artifact_id": "cpsam",
            "sha256": "e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2",
        }
        assert "remote_attachment" in provenance
    if parent_id:
        parent = record(project, parent_id)
        assert value["parent_id"] == parent_id
        before = array(project, parent["arrays"]["labels"])
        deletion = provenance["correction"]["operations"][0]
        assert deletion["op"] == "delete"
        expected = before.copy()
        expected[expected == deletion["label"]] = 0
        np.testing.assert_array_equal(labels, expected)
        assert parent["arrays"]["image"] == value["arrays"]["image"]
        assert (
            parent["provenance"]["remote_attachment"] == provenance["remote_attachment"]
        )
    if export:
        np.testing.assert_array_equal(tifffile.imread(export / "image.ome.tif"), image)
        np.testing.assert_array_equal(
            tifffile.imread(export / "labels.ome.tif"), labels
        )
        exported = json.loads((export / "result.json").read_text())
        assert exported["result"] == value
        assert exported["review"]["revision_hash"] == value["revision_hash"]
        assert exported["raw_source_included"] is False
    return {
        "result_id": identity,
        "revision_hash": value["revision_hash"],
        "objects": len(ids),
        "numerical_fields_checked": numerical_fields,
        "exported_numerical_fields_checked": numerical_fields if export else 0,
        "image_basis": image_basis,
        "image_sha256": value["arrays"]["image"]["sha256"],
        "labels_sha256": value["arrays"]["labels"]["sha256"],
        "source_sha256": value["source_sha256"],
        "runtime": runtime,
        "remote_attachment": provenance["remote_attachment"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument(
        "--expected-device", choices=["classical", "cpu", "cuda"], required=True
    )
    parser.add_argument("--parent")
    parser.add_argument("--export", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            check(
                args.project,
                args.source,
                args.result,
                args.expected_device,
                args.parent,
                args.export,
            ),
            allow_nan=False,
        )
    )
