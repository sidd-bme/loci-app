"""Write a calibrated, lossless OME-TIFF from the locked scikit-image wheel.

scikit-image data.cell documents CC0 and 0.107 µm spacing for this digital
holography image, citing https://doi.org/10.1364/OE.26.010729.
"""

import csv
import hashlib
import json
import math
import sys
from importlib.resources import files
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

PNG_SHA256 = "8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515"


def source_pixels() -> np.ndarray:
    source = files("skimage").joinpath("data/cell.png")
    assert hashlib.sha256(source.read_bytes()).hexdigest() == PNG_SHA256
    with source.open("rb") as handle, Image.open(handle) as image:
        pixels = np.array(image)
    assert pixels.shape == (660, 550) and pixels.dtype == np.uint8
    return pixels


def write_fixture(destination: Path) -> None:
    pixels = source_pixels()
    with destination.open("xb") as output:
        tifffile.imwrite(
            output,
            pixels,
            ome=True,
            metadata={
                "axes": "YX",
                "UUID": "urn:uuid:12304ae0-eaaf-4fa2-b7b4-a5d0caf2c159",
                "PhysicalSizeX": 0.107,
                "PhysicalSizeY": 0.107,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeYUnit": "µm",
            },
            byteorder="<",
        )
    np.testing.assert_array_equal(pixels, tifffile.imread(destination))


def verify_export(directory: Path) -> dict:
    from skimage.measure import label

    raw = source_pixels()
    components = label(raw > 128, connectivity=1)
    sizes = np.bincount(components.ravel())
    ids = np.flatnonzero(sizes[1:] * 0.107**2 >= 2) + 1
    assert len(ids) == 1
    expected = components == ids[0]
    labels = np.load(directory / "labels.npy", allow_pickle=False)
    assert labels.dtype == np.uint32
    np.testing.assert_array_equal(labels, expected.astype(np.uint32))
    np.testing.assert_array_equal(tifffile.imread(directory / "labels.ome.tif"), labels)
    with (directory / "objects.csv").open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 1
    row = rows[0]
    y, x = np.nonzero(expected)
    values = raw[expected]
    assert int(row["label"]) == 1 and int(row["voxel_count"]) == len(values)
    assert row["index_axes"] == "YX" and row["measure_unit"] == "um^2"
    quantitative = {
        "measure": len(values) * 0.107**2,
        "centroid_index:0": y.mean(),
        "centroid_index:1": x.mean(),
        "intensity:1: Channel 1:sum": values.sum(),
        "intensity:1: Channel 1:mean": values.mean(),
    }
    for key, reference in quantitative.items():
        assert math.isclose(float(row[key]), reference, rel_tol=1e-10), key
    return {
        "compared_label_pixels": labels.size,
        "csv_rows": len(rows),
        "raw_sum": int(values.sum()),
    }


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--verify-export":
        print(json.dumps(verify_export(Path(sys.argv[2]))))
    else:
        write_fixture(Path(sys.argv[1]))
