"""Recreate the exact pinned CC0 Loci kidney OME-TIFF without rescaling pixels."""

import argparse
import hashlib
import os
from pathlib import Path
import tempfile
from urllib.request import urlopen

import imagecodecs
import numpy
import tifffile

ORIGINAL_URL = (
    "https://gitlab.com/scikit-image/data/-/raw/"
    "2cdc5ce89b334d28f06a58c9f0ca21aa6992a5ba/kidney-tissue-fluorescence.tif"
)
ORIGINAL_SHA256 = "80c0799bc58b08cf6eaa53ecd202305eb42fd7bc73746cb6c5064dbeae7e8476"
ORIGINAL_BYTES = 25_219_204
OUTPUT_SHA256 = "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564"
REQUIRED_VERSIONS = ("2.4.6", "2026.8.23", "2026.8.16")


def verify_hash(path, expected):
    with path.open("rb") as handle:
        actual = hashlib.file_digest(handle, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"{path.name}: expected SHA-256 {expected}, received {actual}")


def download_original(destination):
    remaining = ORIGINAL_BYTES
    with urlopen(ORIGINAL_URL, timeout=30) as remote, destination.open("xb") as local:
        while chunk := remote.read(min(1024 * 1024, remaining + 1)):
            remaining -= len(chunk)
            if remaining < 0:
                raise ValueError("Public download exceeds the pinned TIFF size.")
            local.write(chunk)
    if remaining != 0:
        raise ValueError("Public download is shorter than the pinned TIFF.")


def convert(source, output):
    verify_hash(source, ORIGINAL_SHA256)
    with tifffile.TiffFile(source) as original:
        series = original.series[0]
        if (series.axes, series.shape, series.dtype.name) != (
            "ZCYX",
            (16, 3, 512, 512),
            "uint16",
        ):
            raise ValueError("Unexpected scikit-image TIFF axes, geometry or dtype.")
        volume = series.asarray().transpose(1, 0, 2, 3)[None, ...]
    tifffile.imwrite(
        output,
        volume,
        byteorder="<",
        ome=True,
        tile=(128, 128),
        compression="zlib",
        compressionargs={"level": 6},
        metadata={
            "axes": "TCZYX",
            "UUID": "urn:uuid:301c393e-ab25-11f1-9644-65f23b368c57",
            "PhysicalSizeX": 1.24,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 1.24,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 1.25,
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["450 nm emission", "515 nm emission", "605 nm emission"]},
        },
    )
    verify_hash(output, OUTPUT_SHA256)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--original", type=Path, help="Local original scikit-image kidney.tif")
    source.add_argument("--download", action="store_true", help="Fetch the pinned public GitLab TIFF")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    versions = (numpy.__version__, tifffile.__version__, imagecodecs.__version__)
    if versions != REQUIRED_VERSIONS:
        parser.error(f"Expected NumPy/tifffile/imagecodecs {REQUIRED_VERSIONS}, found {versions}")
    destination = args.out.absolute()
    if destination.exists():
        verify_hash(destination, OUTPUT_SHA256)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="prepare-kidney-", dir=destination.parent) as temporary:
            original = args.original
            if args.download:
                original = Path(temporary) / "kidney.tif"
                download_original(original)
            staged = Path(temporary) / "verified.ome.tiff"
            convert(original, staged)
            os.link(staged, destination)
    print(f"{OUTPUT_SHA256}  {destination}")


if __name__ == "__main__":
    main()
