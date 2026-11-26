"""Check a frozen Windows x64 worker and wheel-sourced replacement OpenSlide DLL.

Run in the engine build environment with --worker <onedir>/loci-engine.exe.
Only the script's fresh temporary copy of the onedir bundle is modified.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import tempfile
from importlib.metadata import distribution
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

WHEEL_DLL = "openslide_bin/libopenslide-1.dll"
DLL_SHA256 = "dc8e35ad0ce001c4e878f2bebc23e87fb85d2bdebec5a542af2ecec3cb5cd635"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def make_fixture(path):
    y, x = np.indices((96, 160))
    rgb = np.stack((x, 2 * y, (3 * x + 5 * y) % 256), axis=-1).astype(np.uint8)
    tifffile.imwrite(
        path,
        rgb,
        tile=(32, 32),
        photometric="rgb",
        metadata=None,
        software="Loci QA",
        description="Aperio Image Library v12.3.3\n160x96 [0,0 160x96] (32x32)|MPP = 0.5",
    )


def cli(worker, *args, missing_dll=False):
    process = subprocess.run(
        [worker, "--cli", *args],
        cwd=worker.parent,
        capture_output=True,
        check=False,
        timeout=120,
    )
    if missing_dll:
        require(
            process.returncode == 1,
            "Worker read must fail with its staged OpenSlide DLL absent",
        )
        error = json.loads(process.stderr)["error"]["type"]
        require(
            error == "WholeSlideDependencyError",
            f"Unexpected missing-DLL failure: {error}",
        )
        return error
    if process.returncode:
        raise RuntimeError(
            f"Worker {args[0]} failed: {process.stderr.decode(errors='replace').strip()}"
        )
    return json.loads(process.stdout)


def check_region(worker, project, source_id, fingerprint):
    # An asymmetric, off-origin rectangle crossing both X and Y tile boundaries.
    x, y, width, height = 27, 21, 43, 29
    selection = {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "level": 0,
        "t": 0,
        "c": 0,
        "z": 0,
    }
    request = json.dumps({"source_id": source_id, "selection": selection})
    view = cli(worker, "execute", "--project", project, "view", "--request", request)
    require(view["source_sha256"] == fingerprint, "Region source fingerprint changed")
    extent = view["display"][0]["level0_extent_xyxy"]
    geometry = view["geometry"]
    require(extent == [x, y, x + width, y + height], "Incorrect level-zero extent")
    require(
        geometry["axes"] == "YX" and geometry["unit"] == "um",
        "Incorrect calibrated axes",
    )
    require(
        geometry["affine"]
        == [
            [0.5, 0, 0, 0.5 * (x + 0.5)],
            [0, 0.5, 0, 0.5 * (y + 0.5)],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ],
        "Incorrect calibrated pixel-centre affine",
    )
    header, encoded = view["image"].split(",", 1)
    require(header == "data:image/png;base64", "Expected a PNG region")
    with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
        require(
            image.mode == "RGB" and image.size == (width, height),
            "Incorrect region dimensions",
        )
        pixels = image.tobytes()
    expected = bytes(
        value
        for row in range(y, y + height)
        for col in range(x, x + width)
        for value in (col, 2 * row, (3 * col + 5 * row) % 256)
    )
    require(pixels == expected, "Decoded region differs from the analytic RGB values")
    statistics = {
        "channel": 0,
        "dtype": "uint8",
        "min": min(expected),
        "max": max(expected),
        "mean": sum(expected) / len(expected),
    }
    require(
        view["statistics"] == [statistics],
        "Native RGB statistics differ from analytic values",
    )
    return {
        "level0_extent_xyxy": extent,
        "spacing_xy_um": [0.5, 0.5],
        "rgb_bytes": len(pixels),
        "rgb_sha256": hashlib.sha256(pixels).hexdigest(),
    }


def check_import(worker, project, fixture, fingerprint):
    cli(
        worker,
        "create",
        "--project",
        project,
        "--title",
        "Generated tiled OpenSlide control",
    )
    [source] = cli(worker, "import", "--project", project, fixture)["sources"]
    slide = source["metadata"]["whole_slide"]
    require(
        source["source_kind"] == "whole_slide"
        and source["sha256"] == fingerprint
        and slide["vendor"] == "aperio"
        and slide["format"] == "SVS"
        and slide["decoder"] == "OpenSlide"
        and slide["level0_dimensions_xy"] == [160, 96],
        "Worker did not import the expected Aperio slide",
    )
    return source["id"], slide["decoder_library_version"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path, required=True)
    args = parser.parse_args()
    original = args.worker.resolve(strict=True)
    require(
        os.name == "nt" and original.name.lower() == "loci-engine.exe",
        "Expected Windows worker",
    )
    with original.open("rb") as stream:
        require(stream.read(2) == b"MZ", "Expected PE executable")
        stream.seek(0x3C)
        stream.seek(struct.unpack("<I", stream.read(4))[0])
        require(
            stream.read(6) == b"PE\x00\x00\x64\x86", "Expected an AMD64 PE executable"
        )
    wheel = distribution("openslide-bin")
    require(wheel.version == "4.0.1.2", "Expected openslide-bin 4.0.1.2")
    [member] = [entry for entry in wheel.files or () if entry.as_posix() == WHEEL_DLL]
    installed = wheel.locate_file(member)
    bundled = original.parent / "_internal" / WHEEL_DLL
    require(
        sha256(installed) == sha256(bundled) == DLL_SHA256,
        "Unexpected OpenSlide DLL bytes",
    )

    with tempfile.TemporaryDirectory(prefix="loci-openslide-") as temp:
        root = Path(temp).resolve()
        require(
            not root.is_relative_to(original.parent),
            "Temporary directory is inside the bundle",
        )
        staged = shutil.copytree(original.parent, root / "worker")
        worker = staged / original.name
        dll = staged / "_internal" / WHEEL_DLL
        fixture = root / "generated.svs"
        project = root / "control.loci-study"
        make_fixture(fixture)
        fingerprint = sha256(fixture)
        worker_digest = sha256(worker)
        require(
            worker_digest == sha256(original),
            "Staged worker differs from the supplied binary",
        )
        require(sha256(dll) == DLL_SHA256, "Unexpected staged DLL bytes")
        source_id, version = check_import(worker, project, fixture, fingerprint)
        first = check_region(worker, project, source_id, fingerprint)

        backup = dll.rename(root / "original.dll")
        try:
            # A new worker must specifically lose OpenSlide access. This rules
            # out a successful region read through a DLL elsewhere on PATH.
            missing = cli(
                worker, "import", "--project", project, fixture, missing_dll=True
            )
            shutil.copyfile(installed, dll)
            replacement = sha256(dll)
            require(
                replacement == DLL_SHA256,
                "Replacement DLL differs from the pinned wheel bytes",
            )
            second = check_region(worker, project, source_id, fingerprint)
        finally:
            os.replace(backup, dll)
            require(sha256(dll) == DLL_SHA256, "Failed to restore staged DLL")
        require(sha256(fixture) == fingerprint, "Generated source changed")
        receipt = {
            "worker_sha256": worker_digest,
            "vendor": "aperio",
            "level0_dimensions_xy": [160, 96],
            "fixture_sha256": fingerprint,
            "wheel_version": wheel.version,
            "decoder_library_version": version,
            "wheel_dll_sha256": DLL_SHA256,
            "bundled_dll_sha256": sha256(bundled),
            "replacement_dll_sha256": replacement,
            "restored_dll_sha256": sha256(dll),
            "missing_dll_error": missing,
            "original_region": first,
            "replacement_region": second,
        }
        print(json.dumps(receipt, separators=(",", ":")))


if __name__ == "__main__":
    main()
