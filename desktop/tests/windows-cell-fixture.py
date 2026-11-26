"""Write a calibrated, lossless OME-TIFF from the locked scikit-image wheel.

scikit-image data.cell documents CC0 and 0.107 µm spacing for this digital
holography image, citing https://doi.org/10.1364/OE.26.010729.
"""

import hashlib
import sys
from importlib.resources import files
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

PNG_SHA256 = "8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515"


def write_fixture(destination: Path) -> None:
    source = files("skimage").joinpath("data/cell.png")
    assert hashlib.sha256(source.read_bytes()).hexdigest() == PNG_SHA256
    with source.open("rb") as handle, Image.open(handle) as image:
        pixels = np.array(image)
    assert pixels.shape == (660, 550) and pixels.dtype == np.uint8
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


if __name__ == "__main__":
    write_fixture(Path(sys.argv[1]))
