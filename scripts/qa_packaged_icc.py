"""Qualify the packaged ICC path using an explicitly synthetic tiled RGB slide."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import struct
import subprocess
import time
from pathlib import Path

import numpy as np
import openslide
import tifffile
from PIL import Image, ImageCms


def identity(path: Path) -> dict[str, int | str]:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "size_bytes": path.stat().st_size}


def linear_rgb_profile() -> bytes:
    # Generated sRGB primaries/white point with ICC curveType gamma=1 TRCs.
    # The fixture describes linear RGB, not scanner output or biological truth.
    encoded = bytearray(
        ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    )
    offset = len(encoded)
    encoded.extend(b"curv" + b"\0" * 4 + struct.pack(">IH", 1, 256) + b"\0\0")
    changed = set()
    for index in range(struct.unpack_from(">I", encoded, 128)[0]):
        entry = 132 + index * 12
        tag = bytes(encoded[entry : entry + 4])
        if tag in {b"rTRC", b"gTRC", b"bTRC"}:
            struct.pack_into(">II", encoded, entry + 4, offset, 14)
            changed.add(tag)
    assert changed == {b"rTRC", b"gTRC", b"bTRC"}
    struct.pack_into(">I", encoded, 0, len(encoded))
    encoded[84:100] = b"\0" * 16
    # Serialize the generated profile once so the embedded fixture contains the
    # canonical parsed profile, without the now-unreferenced original TRC bytes.
    return ImageCms.ImageCmsProfile(io.BytesIO(encoded)).tobytes()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    worker = args.app / "Contents/Resources/loci-engine/loci-engine"
    build_paths = {
        "executable": args.app / "Contents/MacOS/Loci",
        "asar": args.app / "Contents/Resources/app.asar",
        "worker": worker,
    }
    build = {key: identity(path) for key, path in build_paths.items()}
    project = args.output_dir / "synthetic-icc.loci-study"
    fixture = args.output_dir / "synthetic-linear-profile.svs"
    profile = linear_rgb_profile()
    y, x = np.indices((256, 256))
    rgb = np.stack((x, y, np.full_like(x, 17)), axis=-1).astype(np.uint8)
    tifffile.imwrite(
        fixture,
        rgb,
        tile=(64, 64),
        photometric="rgb",
        compression="deflate",
        metadata=None,
        description=(
            "Aperio Image Library v12.3.3\n"
            "256x256 [0,0 256x256] (64x64) |AppMag = 20|MPP = 0.5"
        ),
        extratags=[(34675, 7, len(profile), profile, False)],
    )
    before = identity(fixture)
    with openslide.OpenSlide(str(fixture)) as slide:
        assert slide.properties["openslide.vendor"] == "aperio"
        assert slide.color_profile is not None
        assert slide.color_profile.tobytes() == profile
        np.testing.assert_array_equal(
            np.asarray(slide.read_region((0, 0), 0, (256, 256)).convert("RGB")), rgb
        )

    calls = []

    def cli(*arguments: str) -> dict:
        started = time.monotonic()
        process = subprocess.run(
            [str(worker), "--cli", *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert process.stderr == "", process.stderr
        calls.append(
            {"command": arguments[0], "elapsed_seconds": time.monotonic() - started}
        )
        return json.loads(process.stdout)

    cli("create", "--project", str(project), "--title", "Synthetic ICC qualification")
    imported = cli("import", "--project", str(project), str(fixture))
    source = imported["sources"][0]
    assert source["source_kind"] == "whole_slide"
    selection = {
        "x": 0,
        "y": 0,
        "width": 256,
        "height": 256,
        "level": 0,
        "t": 0,
        "c": 0,
        "z": 0,
    }
    viewed = cli(
        "execute",
        "--project",
        str(project),
        "view",
        "--request",
        json.dumps({"source_id": source["id"], "selection": selection}),
    )
    pixels = np.asarray(
        Image.open(io.BytesIO(base64.b64decode(viewed["image"].split(",", 1)[1])))
    )
    linear = rgb.astype(np.float64) / 255
    # Independent IEC sRGB transfer equation. Allow one integer code value for
    # ICC matrix/TRC quantization; do not compare against another ImageCms call.
    expected = np.rint(
        255
        * np.where(
            linear <= 0.0031308, 12.92 * linear, 1.055 * linear ** (1 / 2.4) - 0.055
        )
    ).astype(np.uint8)
    error = int(np.max(np.abs(pixels.astype(np.int16) - expected.astype(np.int16))))
    assert error <= 1, error
    assert not np.array_equal(pixels, rgb)
    assert viewed["statistics"][0] == {
        "channel": 0,
        "dtype": "uint8",
        "min": 0.0,
        "max": 255.0,
        "mean": float(rgb.mean()),
    }
    icc = viewed["display"][0]["icc"]
    assert icc["source_status"] == "embedded-usable"
    assert icc["transform"] == "Pillow-ImageCms-source-to-sRGB"
    assert icc["source_icc_sha256"] == hashlib.sha256(profile).hexdigest()
    assert viewed["source_sha256"] == before["sha256"]
    assert identity(fixture) == before
    assert {key: identity(path) for key, path in build_paths.items()} == build
    Image.fromarray(rgb).save(args.output_dir / "raw-linear-rgb.png")
    Image.fromarray(pixels).save(args.output_dir / "packaged-srgb-display.png")
    report = {
        "schema": "loci.packaged-icc-qualification/v1",
        "passed": True,
        "scope": "Synthetic RGB matrix/TRC golden; not a real scanner profile qualification",
        "app": build,
        "harness": identity(Path(__file__)),
        "fixture": before,
        "source_unchanged": True,
        "icc": icc,
        "maximum_code_value_error": error,
        "predeclared_maximum_code_value_error": 1,
        "raw_statistics_preserved": True,
        "calls": calls,
    }
    (args.output_dir / "qa-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
