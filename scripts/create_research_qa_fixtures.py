#!/usr/bin/env python3
"""Create deterministic numerical fixtures for the packaged research-workbench QA.

The destination must be an explicitly selected disposable QA directory.  The
fixtures are synthetic arrays, not biological images or validation data.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np
import tifffile


def write_volume(destination: Path) -> dict[str, object]:
    # TCZYX: two time points, one scalar channel, three anisotropic Z planes.
    value = np.zeros((2, 1, 3, 32, 40), dtype=np.uint16)
    # Two disconnected objects in T=0.  Each persists through every Z plane.
    value[0, 0, :, 4:8, 5:10] = 100
    value[0, 0, :, 18:24, 25:31] = 200
    # A different nonzero region at T=1 establishes real T navigation.
    value[1, 0, :, 10:15, 14:20] = 150
    path = destination / "anisotropic_tczyx_two_objects.ome.tiff"
    tifffile.imwrite(
        path,
        value,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 1.0,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 2.0,
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["synthetic-intensity"]},
        },
    )
    return {
        "path": path.name,
        "shape_tczyx": list(value.shape),
        "raw_intensities": [100, 200, 150],
        "two_dimensional_t0_z1": {
            "object_count": 2,
            "areas_um2": [10.0, 18.0],
        },
        "three_dimensional_t0": {
            "object_count": 2,
            "volumes_um3": [60.0, 108.0],
        },
    }


def write_rgb(destination: Path) -> dict[str, object]:
    value = np.full((32, 40, 3), 245, dtype=np.uint8)
    # Numerically distinct brightfield patches for a declared H-DAB transform.
    value[5:14, 6:16] = [78, 55, 35]
    value[18:28, 24:35] = [120, 85, 48]
    path = destination / "declared_h_dab_rgb.tiff"
    tifffile.imwrite(path, value, photometric="rgb")
    return {"path": path.name, "shape_yxs": list(value.shape)}


def write_multiplex_time(destination: Path) -> dict[str, object]:
    """Known translating 3D objects and two proportional acquisition channels."""
    value = np.zeros((3, 2, 5, 48, 64), dtype=np.uint16)
    for time in range(3):
        for channel, scale in enumerate((1, 2)):
            value[time, channel, 1:4, 10:16, 10 + time : 16 + time] = 100 * scale
            value[time, channel, 1:4, 30:36, 40 + time : 46 + time] = 200 * scale
    output = destination / "multiplex_translating_objects.ome.tiff"
    tifffile.imwrite(
        output,
        value,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 1.0,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 2.0,
            "PhysicalSizeZUnit": "µm",
            "TimeIncrement": 5.0,
            "TimeIncrementUnit": "s",
            "Channel": {"Name": ["synthetic-nuclear", "synthetic-reporter"]},
        },
    )
    return {
        "path": output.name,
        "shape_tczyx": list(value.shape),
        "raw_t0_z2_means": [[100, 200], [200, 400]],
        "areas_um2": [18, 18],
        "volumes_um3": [108, 108],
        "elapsed_times_s": [0, 5, 10],
        "translation_um_per_frame_xyz": [0.5, 0, 0],
        "trajectory_speed_um_per_s": 0.1,
        "pearson": 1.0,
    }


def write_oblique_nifti(destination: Path) -> dict[str, object]:
    # A minimal, uncompressed NIfTI-1 float32 volume with an explicit oblique
    # sform and explicit units for import, quantitative 3D analysis, and export.
    value = np.arange(5 * 6 * 7, dtype="<f4").reshape((5, 6, 7))
    path = destination / "oblique_scalar.nii"
    header = bytearray(348)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, 5, 6, 7, 1, 1, 1, 1)
    struct.pack_into("<h", header, 70, 16)  # float32
    struct.pack_into("<h", header, 72, 32)
    struct.pack_into("<8f", header, 76, 1.0, 0.7, 0.8, 1.2, 1, 1, 1, 1)
    struct.pack_into("<f", header, 108, 352.0)
    header[123] = 2  # NIFTI_UNITS_MM
    struct.pack_into("<h", header, 254, 1)
    angle = np.deg2rad(30.0)
    cosine, sine = float(np.cos(angle)), float(np.sin(angle))
    struct.pack_into("<4f", header, 280, cosine * 0.7, -sine * 0.8, 0.0, 10.0)
    struct.pack_into("<4f", header, 296, sine * 0.7, cosine * 0.8, 0.0, 20.0)
    struct.pack_into("<4f", header, 312, 0.0, 0.0, 1.2, 30.0)
    header[344:348] = b"n+1\0"
    path.write_bytes(header + b"\0\0\0\0" + value.tobytes(order="F"))
    return {
        "path": path.name,
        "shape_xyz": [5, 6, 7],
        "xyzt_units": 2,
        "sform_code": 1,
        "rotation_degrees": 30.0,
        "intensity_range": [0.0, 209.0],
        "threshold_gt_100": {
            "threshold": 100.0,
            "comparison": "greater_than",
            "voxel_count": 109,
            "intensity_sum": 16895.0,
            "voxel_volume_mm3": 0.672,
            "volume_mm3": 73.248,
            "absolute_tolerance": 1e-5,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        required=True,
        help="Explicit disposable directory supplied as LOCI_QA_RESEARCH_FIXTURES",
    )
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "loci.research-qa-fixtures/v1",
        "meaning": "synthetic numerical QA fixtures; not biological validation data",
        "volume": write_volume(root),
        "rgb": write_rgb(root),
        "multiplex_time": write_multiplex_time(root),
        "oblique_nifti": write_oblique_nifti(root),
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
