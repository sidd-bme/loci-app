"""Compare cached preview RGB8 pixels against the pinned public kidney crop."""

import hashlib
import json
import sys
from pathlib import Path
from xml.etree import ElementTree

import numpy as np
import tifffile
from PIL import Image

KIDNEY_SHA256 = "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564"


def check_preview(source, png, request):
    with source.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != KIDNEY_SHA256:
            raise ValueError("Expected the pinned public CC0 kidney OME-TIFF")

    selection = request["selection"]
    x, y, width, height = (selection[key] for key in ("x", "y", "width", "height"))
    c, z, t, level = (selection[key] for key in ("c", "z", "t", "level"))
    if (c, z, t, level) != (0, 8, 0, 0) or "z_stop" in selection:
        raise ValueError("Expected C0 Z8 T0 on level zero")
    if not (
        0 <= x < x + width <= 512
        and 0 <= y < y + height <= 512
        and max(width, height) <= 128
    ):
        raise ValueError("Expected a small bounded YX crop")

    with tifffile.TiffFile(source) as tiff:
        series = tiff.series[0]
        if (series.axes, series.shape, series.dtype) != (
            "CZYX",
            (3, 16, 512, 512),
            np.dtype("uint16"),
        ):
            raise ValueError("Unexpected source axes, shape or sample type")
        raw = series.asarray()[c, z, y : y + height, x : x + width].astype(np.float64)
        pixels = ElementTree.fromstring(tiff.ome_metadata).find(".//{*}Pixels")
        spacing = [float(pixels.attrib[f"PhysicalSize{axis}"]) for axis in "XYZ"]
        if [pixels.attrib[f"PhysicalSize{axis}Unit"] for axis in "XYZ"] != ["µm"] * 3:
            raise ValueError("Expected micrometre calibration")

    geometry = request["geometry"]
    if (geometry["axes"], geometry["unit"], geometry["frame"]) != ("YX", "um", "image"):
        raise ValueError("Expected a calibrated YX crop in the source image frame")
    affine = np.diag([*spacing, 1.0])
    affine[:3, 3] = np.multiply(spacing, [x, y, z])
    np.testing.assert_allclose(geometry["affine"], affine, rtol=0, atol=1e-12)

    # Explicit closed-form calculations in raw uint16 sample units, evaluated
    # in float64. No RGB conversion or scaling precedes the subtractions.
    clipped_first = np.maximum(raw - 550, 0) - 400
    clipped_last = np.maximum(raw - 950, 0)
    processed = {(550, 400): clipped_first, (400, 550): clipped_last}
    order = tuple(request["order"])
    plane = processed[order]
    lo, hi = float(plane.min()), float(plane.max())
    if hi <= lo or raw.min() >= 550 or raw.max() <= 950:
        raise ValueError(
            "Crop lacks the signal and threshold crossings needed to distinguish order"
        )
    if [lo, hi] != request["bounds"]:
        raise ValueError(
            "Preview normalization bounds differ from the independent crop"
        )

    def display(values):
        normalized = (values - values.min()) / np.ptp(values)
        gray = np.rint(255 * normalized).astype(np.uint8)
        return np.repeat(gray[..., None], 3, axis=-1)

    expected = display(plane)
    reverse = display(processed[order[::-1]])
    order_difference = int(np.count_nonzero(expected[..., 0] != reverse[..., 0]))
    if order_difference == 0:
        raise ValueError("Display normalization erased the order difference")
    with Image.open(png) as image:
        if (image.format, image.mode) != ("PNG", "RGB"):
            raise ValueError("Expected the preview RGB8 PNG")
        actual = np.asarray(image)
    np.testing.assert_array_equal(actual, expected)
    return {
        "comparison": "display-only, exact RGB8 after selected-crop min-max normalization (gamma 1, white)",
        "source_axes": "CZYX",
        "preview_axes": "YXS",
        "source_units": "native uint16 sample values",
        "arithmetic": "float64",
        "shape_yx": [height, width],
        "bounds": [lo, hi],
        "compared_pixels": width * height,
        "pixels_different_in_reverse_order": order_difference,
        "expected_rgb_sha256": hashlib.sha256(expected.tobytes()).hexdigest(),
        "actual_rgb_sha256": hashlib.sha256(actual.tobytes()).hexdigest(),
    }


if __name__ == "__main__":
    source_path, preview_path, parameters = sys.argv[1:]
    print(
        json.dumps(
            check_preview(Path(source_path), Path(preview_path), json.loads(parameters))
        )
    )
