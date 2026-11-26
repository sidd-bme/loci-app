"""Independent readback for the packaged DynaCell QA journey (NumPy + tifffile)."""

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import tifffile

SHAPE = (40, 512, 512)
VOXELS = math.prod(SHAPE)
ATOL, RTOL = 1e-6, 2e-6
SOURCE_CHANNELS = ("Phase3D", "Nuclei")
OUTPUT_CHANNELS = ("Predicted nuclear stain (DynaCell)", "Phase3D")
CHECKPOINT_SHA256 = "58b222f92978b50647d547e5fd69edaafa2d2c5854fbc7f7324e9bcf8835051d"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pixel_sha(array):
    return hashlib.sha256(np.ascontiguousarray(array, dtype="<f4")).hexdigest()


def grid(tiff, channels):
    require(len(tiff.series) == 1 and tiff.is_ome, "Expected a single OME-TIFF series")
    series = tiff.series[0]
    require(
        series.axes == "CZYX"
        and series.shape == (2, *SHAPE)
        and series.dtype == np.float32
        and len(series.levels) == 1,
        "Expected native float32 CZYX (2, 40, 512, 512)",
    )
    image = ET.fromstring(tiff.ome_metadata).find("{*}Image")
    pixels = image.find("{*}Pixels")
    require(
        tuple(c.get("Name") for c in pixels.findall("{*}Channel")) == channels,
        "OME channel order or names differ",
    )
    require(
        all(pixels.get(f"PhysicalSize{axis}Unit") == "µm" for axis in "ZYX"),
        "Expected micrometre units",
    )
    require(
        image.find("{*}StageLabel") is None
        and not any(
            key.startswith("Position")
            for plane in pixels.findall("{*}Plane")
            for key in plane.attrib
        ),
        "Unexpected stage position on the local grid",
    )
    spacing = [float(pixels.get(f"PhysicalSize{axis}")) for axis in "ZYX"]
    return series, spacing, image.findtext("{*}Description")


def verify(source, expected_prediction, bundle):
    expected = np.load(expected_prediction, allow_pickle=False, mmap_mode="r")
    require(
        expected.shape == SHAPE and expected.dtype == np.float32 and np.isfinite(expected).all(),
        "Expected an independent finite float32 ZYX (40, 512, 512) .npy",
    )
    with tifffile.TiffFile(source) as tiff:
        series, spacing, _ = grid(tiff, SOURCE_CHANNELS)
        require(spacing == [0.29, 0.108, 0.108], "Input fixture calibration differs")
        phase = series.asarray()[0].copy()
    require(np.isfinite(phase).all(), "Fixture Phase3D contains non-finite values")
    summary = {
        "shape_zyx": SHAPE,
        "spacing_zyx_um": spacing,
        "expected_prediction_pixels_sha256": pixel_sha(expected),
        "phase_pixels_sha256": pixel_sha(phase),
    }
    if bundle is None:
        return summary

    require(
        sorted(item.name for item in bundle.iterdir()) == ["image.ome.tif", "provenance.json"],
        "Expected exactly the two published artifacts",
    )
    image, sidecar = (bundle / name for name in ("image.ome.tif", "provenance.json"))
    for file in (image, sidecar):
        require(file.is_file() and not file.is_symlink(), "Expected plain published files")
    with tifffile.TiffFile(image) as tiff:
        series, derived_spacing, description = grid(tiff, OUTPUT_CHANNELS)
        prediction, copied_phase = series.asarray()
    require(derived_spacing == spacing, "Output calibration differs from the source")
    require(np.isfinite(prediction).all(), "Prediction contains non-finite values")
    require(pixel_sha(copied_phase) == summary["phase_pixels_sha256"], "Copied phase differs")

    # Use float64 errors and compare every voxel, including the low-context end planes.
    max_abs = 0.0
    total_abs = 0.0
    mismatches = 0
    for actual_plane, expected_plane in zip(prediction, expected, strict=True):
        reference = expected_plane.astype(np.float64)
        error = np.abs(actual_plane.astype(np.float64) - reference)
        mismatches += np.count_nonzero(error > ATOL + RTOL * np.abs(reference))
        max_abs = max(max_abs, float(error.max()))
        total_abs += float(error.sum())
    require(
        mismatches == 0,
        f"Prediction differs at {mismatches} voxels (max absolute error {max_abs:.9g}) "
        f"for atol={ATOL:g}, rtol={RTOL:g}",
    )

    require(sidecar.stat().st_size <= 16_384, "Public provenance exceeds its metadata budget")
    record = json.loads(sidecar.read_text(encoding="utf-8"))
    image_sha = file_sha(image)
    require(
        json.loads(description) == {k: v for k, v in record.items() if k != "artifact_sha256"},
        "Embedded OME derivation differs from the public sidecar",
    )
    predicted_sha = pixel_sha(prediction)
    expected_fields = {
        "source_sha256": file_sha(source),
        "channel": 0,
        "series": 0,
        "timepoint": 0,
        "level": 0,
        "start_zyx": [0, 0, 0],
        "end_exclusive_zyx": list(SHAPE),
        "spacing_zyx_um": spacing,
        "population_voxels": VOXELS,
        "artifact_sha256": image_sha,
        "phase_pixels_sha256": summary["phase_pixels_sha256"],
        "prediction_pixels_sha256": predicted_sha,
    }
    require(
        set(record)
        == set(expected_fields)
        | {
            "source_id",
            "profile",
            "mean",
            "std",
            "kernel_mean_float32",
            "kernel_std_float32",
            "runtime",
        }
        and re.fullmatch(r"[a-f0-9]{32}", record["source_id"]),
        "Unexpected public provenance fields or parent identity",
    )
    require(
        all(record.get(key) == value for key, value in expected_fields.items()),
        "Public derivation disagrees with independent artifact or selection identity",
    )
    mean, std = phase.mean(dtype=np.float64), phase.std(dtype=np.float64)
    for field, value in (("mean", mean), ("std", std)):
        require(
            math.isclose(record[field], value, rel_tol=1e-12, abs_tol=1e-12)
            and record[f"kernel_{field}_float32"] == float(np.float32(value)),
            f"Recorded {field} differs from independent full-field calculation",
        )
    profile = record["profile"]
    runtime = record["runtime"]
    profile_text = {
        "model",
        "phase_confirmation",
        "spatial_interpretation",
        "edge_context",
        "normalization",
        "validation_scope",
    }
    require(
        set(profile)
        == profile_text
        | {
            "schema",
            "weights_sha256",
            "weights_bytes",
            "axes",
            "dtype",
            "channels",
        }
        and profile["schema"] == "loci.dynacell-prediction/v1"
        and profile["weights_sha256"] == CHECKPOINT_SHA256
        and profile["weights_bytes"] == 386_093_992
        and profile["axes"] == "CZYX"
        and profile["dtype"] == "float32"
        and profile["channels"]
        == [
            {
                "name": OUTPUT_CHANNELS[0],
                "kind": "prediction",
                "units": "dimensionless target-IQR-normalized",
            },
            {"name": OUTPUT_CHANNELS[1], "kind": "source", "units": "stored phase units"},
        ]
        and all(re.fullmatch(r"[\w ,.;()+:=−µ-]{1,256}", profile[key]) for key in profile_text)
        and set(runtime) == {"device", "engine", "python", "numpy", "torch"}
        and runtime["device"] == "cpu"
        and all(
            re.fullmatch(r"[0-9][0-9A-Za-z+.\-]{0,63}", runtime[key])
            for key in ("engine", "python", "numpy", "torch")
        ),
        "Derivation does not identify the pinned CPU prediction profile",
    )
    return {
        **summary,
        "channels": OUTPUT_CHANNELS,
        "artifact_sha256": image_sha,
        "provenance_sha256": file_sha(sidecar),
        "prediction_pixels_sha256": predicted_sha,
        "prediction_voxels_compared": VOXELS,
        "phase_voxels_bit_exact": VOXELS,
        "prediction_bit_exact": predicted_sha == summary["expected_prediction_pixels_sha256"],
        "prediction_atol": ATOL,
        "prediction_rtol": RTOL,
        "prediction_mismatches": mismatches,
        "prediction_max_abs_error": max_abs,
        "prediction_mean_abs_error": total_abs / VOXELS,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("expected_prediction", type=Path)
    parser.add_argument("--bundle", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.source, args.expected_prediction, args.bundle)))
