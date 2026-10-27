"""Deterministic synthetic palette QA fixture and independent TIFF export oracle.

This script only creates its named synthetic fixture, or reads that fixture and a
rendered export. It never accepts or copies the optional authorized real source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import tifffile

NAME = "synthetic-palette-cz.ome.tiff"
WIDTH, HEIGHT, CHANNELS, DEPTH = 1280, 160, 2, 3
CENTRE_CODES = (32768, 45000, 60000)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / NAME
    manifest_path = directory / "palette-reference.json"
    if destination.exists() or manifest_path.exists():
        raise ValueError("Synthetic fixture and manifest destinations must be absent")
    # A broad uniform centre permits actual-canvas pixel checks after Fit.
    indices = np.full((HEIGHT, WIDTH), 2, dtype=np.uint8)
    indices[:, :128] = 0
    indices[:, 128:256] = 1
    indices[:, -128:] = 3
    indices[:, -256:-128] = 4
    xml = (
        '<?xml version="1.0"?>'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" '
        f'Type="uint8" SizeX="{WIDTH}" SizeY="{HEIGHT}" SizeZ="{DEPTH}" '
        f'SizeC="{CHANNELS}" SizeT="1" PhysicalSizeX="0.25" '
        'PhysicalSizeY="0.5" PhysicalSizeZ="2">'
        '<Channel ID="Channel:0:0" SamplesPerPixel="1" Color="-16776961"/>'
        '<Channel ID="Channel:0:1" SamplesPerPixel="1" Color="16711935"/>'
        f'<TiffData IFD="0" PlaneCount="{CHANNELS * DEPTH}"/>'
        "</Pixels></Image></OME>"
    )
    with tifffile.TiffWriter(destination) as tif:
        for c in range(CHANNELS):
            for z in range(DEPTH):
                lut = np.zeros((3, 256), dtype=np.uint16)
                lut[c, :5] = [1, 257, CENTRE_CODES[z], 65535, 65280]
                tif.write(
                    indices,
                    photometric="palette",
                    colormap=lut,
                    compression="deflate",
                    rowsperstrip=8,
                    metadata=None,
                    description=xml if c == z == 0 else None,
                    extratags=[(274, "H", 1, 1, False)],
                )
    with tifffile.TiffFile(destination) as tif:
        series = tif.series[0]
        assert series.axes == "CZYX" and series.shape == (2, 3, HEIGHT, WIDTH)
        assert len(series.levels) == 1
        assert isinstance(series.pages[3], tifffile.TiffFrame)
        assert series.pages[3].aspage().colormap[1, 2] == CENTRE_CODES[0]
        assert series.pages[3].keyframe.colormap[1, 2] == 0
    manifest = {
        "schema": "loci.synthetic-palette-qa/v1",
        "source_name": NAME,
        "source_sha256": sha256(destination),
        "source_shape_czyx": [CHANNELS, DEPTH, HEIGHT, WIDTH],
        "palette_component_dtype": "uint16",
        "stored_index_dtype": "uint8",
        "centre_codes": list(CENTRE_CODES),
        "centre_canvas_codes": [(value + 128) // 257 for value in CENTRE_CODES],
        "auto": {"low": 0, "high": 65535},
        "scope": "Generated software fixture; no biomedical accuracy claim",
    }
    with manifest_path.open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, indent=2)
        stream.write("\n")
    return manifest


def verify_export(directory: Path, exported: Path, c: int, z: int) -> dict:
    if not 0 <= c < CHANNELS or not 0 <= z < DEPTH:
        raise ValueError("Synthetic C/Z selection is outside the fixture")
    source = directory / NAME
    with tifffile.TiffFile(source) as tif:
        frame = tif.series[0].pages[c * DEPTH + z]
        actual = frame.aspage() if isinstance(frame, tifffile.TiffFrame) else frame
        indices = actual.asarray()
        expected = np.moveaxis(actual.colormap[:, indices], 0, -1)
    with tifffile.TiffFile(exported) as tif:
        page = tif.pages[0]
        observed = page.asarray()
        provenance = json.loads(page.description)
        assert page.dtype == np.dtype("uint16")
        assert page.photometric == tifffile.PHOTOMETRIC.RGB
    np.testing.assert_array_equal(observed, expected)
    assert provenance["source_sha256"] == sha256(source)
    assert provenance["selection"] == {
        "x": 0,
        "y": 0,
        "width": WIDTH,
        "height": HEIGHT,
        "c": c,
        "z": z,
        "t": 0,
        "level": 0,
    }
    assert provenance["precision_policy"] == "native-uint16-display-codes"
    assert provenance["palette"]["lookup_policy"] == "actual-IFD-ColorMap"
    assert provenance["palette"]["stored_index_dtype"] == "uint8"
    assert len(provenance["display"]) == 1
    display = provenance["display"][0]
    assert display["channel"] == c
    assert (display["low"], display["high"], display["gamma"]) == (0, 65535, 1)
    assert str(directory) not in json.dumps(provenance)
    for value in (1, 257, CENTRE_CODES[z], 65535, 65280):
        assert np.any(observed[..., c] == value)
    return {
        "source_sha256": sha256(source),
        "export_sha256": sha256(exported),
        "c": c,
        "z": z,
        "shape": list(observed.shape),
        "dtype": str(observed.dtype),
        "exact_per_ifd_lookup_match": True,
        "precision_policy": provenance["precision_policy"],
        "reader": "tifffile actual IFD indices and ColorMap; independent of Loci engine",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--verify-export", type=Path)
    parser.add_argument("--channel", type=int, default=1)
    parser.add_argument("--z", type=int, default=2)
    args = parser.parse_args()
    result = (
        verify_export(args.directory, args.verify_export, args.channel, args.z)
        if args.verify_export
        else prepare(args.directory)
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
