#!/usr/bin/env python3
"""Rebuild the frozen public BBBC039 field and publisher ONNX reference package."""

import argparse
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import tifffile

FIELD = "IXMtest_A06_s6_w1B9577918-4973-4A87-BA73-A168AA755527"
BROAD = "https://data.broadinstitute.org/bbbc/BBBC039/"
BIOIMAGEIO = "https://hypha.aicell.io/bioimage-io/artifacts/affable-shark/files/new-dir/"
IMAGE_ARCHIVE = (77915748, "6f30a5d4fe38c928ded972704f085975f8dc0d65d9aa366df00e5a9d449fddd7")
MASK_ARCHIVE = (2753811, "f9e6043d8ca56344a4886f96a700d804d6ee982f31e2b2cd3194af2a053c2710")
IMAGE_MEMBER = (726350, "f9a51ae558e53416980ca152c740ad9dced85eedbd105261841139aada16b77d")
MASK = (10002, "e0737550efe11dc9969971947d9095ac0971bf77cfd0f448eeb7592cea7969b3")
OME = (724706, "502822d7b7f4a7164b6f7e1c2b35807724e1f755efba4678b60b4ea492db3ad9")
PIXELS = "a80d71b2fdce30809804b771d8334a917537413bd108fea2694fff861c1ae4da"
ADAPTER = (3012, "e77c15651c117ded7a9eb73b643c889c4abb41d40024a1294438b767fa6d622d")
PACKAGE_SHA = "774aa0c53566c9f995af02c905863c0ca86b71460f93c3a11fe101b11c5ba582"
ARTIFACTS = {
    "reference-input-float32.npy": (
        "test_input_0.npy", 262272,
        "c29bd6e16e3f7856217b407ba948222b1c2a0da41922a0f79297e25588614fe2",
    ),
    "test_output_0.npy": (
        "test_output_0.npy", 524416,
        "510181f38930e59e4fd8ecc03d6ea7c980eb6609759655f2d4a41fe36108d5f5",
    ),
    "weights.onnx": (
        "weights.onnx", 115839324,
        "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44",
    ),
}


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def verify(path, expected):
    size = path.stat().st_size
    with path.open("rb") as stream:
        identity = (size, hashlib.file_digest(stream, "sha256").hexdigest())
    if identity != expected:
        raise ValueError(f"Fingerprint mismatch for {path.name}: {identity} != {expected}")
    return {"size_bytes": identity[0], "sha256": identity[1]}


class PublisherRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        previous = urllib.parse.urlsplit(req.full_url)
        if target.scheme != "https" or target.netloc != previous.netloc:
            raise ValueError(f"Unexpected publisher redirect to {target.netloc}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def acquire(url, path, expected, local=None):
    if local is not None:
        verify(local, expected)
        shutil.copyfile(local, path)
    else:
        opener = urllib.request.build_opener(PublisherRedirects())
        request = urllib.request.Request(url, headers={
            "Accept-Encoding": "identity",
            "User-Agent": "Loci-approved-BBBC-qualification/1",
        })
        print(f"Downloading {url}", flush=True)
        for attempt in range(3):
            try:
                with opener.open(request, timeout=90) as response, path.open("wb") as output:
                    total = 0
                    for block in iter(lambda: response.read(1 << 20), b""):
                        total += len(block)
                        if total > expected[0]:
                            raise ValueError(f"Publisher response exceeded pinned size for {url}")
                        output.write(block)
                break
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise
    verify(path, expected)
    return path


def member_bytes(archive, member, expected):
    with zipfile.ZipFile(archive) as bundle:
        info = bundle.getinfo(member)
        if info.file_size != expected[0]:
            raise ValueError(f"Unexpected member size for {member}")
        data = bundle.read(info)
    if (len(data), sha_bytes(data)) != expected:
        raise ValueError(f"Unexpected member fingerprint for {member}")
    return data


def canonical_pixel_sha(pixels):
    if pixels.shape != (520, 696) or pixels.dtype.kind != "u" or pixels.dtype.itemsize != 2:
        raise ValueError(f"Unexpected original or derived image: {pixels.shape} {pixels.dtype}")
    return sha_bytes(pixels.astype("<u2", copy=False).tobytes(order="C"))


def write_ome(raw, output):
    pixels = tifffile.imread(io.BytesIO(raw))
    if canonical_pixel_sha(pixels) != PIXELS:
        raise ValueError("Published TIFF pixels failed the independent uint16-LE pin")
    tifffile.imwrite(
        output, pixels, ome=True, byteorder="<", photometric="minisblack", resolution=(1, 1),
        resolutionunit="NONE", metadata={
            "axes": "YX",
            "UUID": "c5108174-cec2-11f1-a40b-59f303123f2b",
            "Creator": "tifffile.py 2026.8.23",
        },
    )
    with tifffile.TiffFile(output) as derived:
        if not derived.is_ome or derived.series[0].axes != "YX":
            raise ValueError("Expected a scalar YX OME-TIFF")
        observed = derived.asarray()
        if canonical_pixel_sha(observed) != PIXELS or not np.array_equal(observed, pixels):
            raise ValueError("OME conversion changed raw pixels")
    return verify(output, OME)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--images-archive", type=Path, help="Optional locally cached official ZIP")
    parser.add_argument("--masks-archive", type=Path, help="Optional locally cached official ZIP")
    parser.add_argument("--model-cache", type=Path, help="Optional directory of pinned package members")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Read the byte-exact adapter blob even when Windows Git converts checkout line endings.
    adapter = subprocess.check_output([
        "git", "-C", str(args.repo.resolve()), "show", "HEAD:desktop/src/main/nuclei-model-package.json",
    ])
    if (len(adapter), sha_bytes(adapter)) != ADAPTER:
        raise ValueError("Checkout adapter does not match the frozen gallery package")

    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".onnx-fixture-") as temporary:
        staging = Path(temporary)
        fixture = staging / "fixture"
        model = fixture / "model"
        model.mkdir(parents=True)
        source = fixture / (FIELD + ".ome.tif")
        mask = fixture / (FIELD + ".png")
        images = acquire(BROAD + "images.zip", staging / "images.zip", IMAGE_ARCHIVE, args.images_archive)
        masks = acquire(BROAD + "masks.zip", staging / "masks.zip", MASK_ARCHIVE, args.masks_archive)
        source_identity = write_ome(member_bytes(images, f"images/{FIELD}.tif", IMAGE_MEMBER), source)
        mask.write_bytes(member_bytes(masks, f"masks/{FIELD}.png", MASK))

        member_pins = {"loci-model.json": verify_written_adapter(model, adapter)}
        for name, (upstream, size, digest) in ARTIFACTS.items():
            url = BIOIMAGEIO + upstream + "?version=v0"
            local = args.model_cache / name if args.model_cache else None
            acquire(url, model / name, (size, digest), local)
            member_pins[name] = {"size_bytes": size, "sha256": digest, "url": url}
        package_sha = sha_bytes("".join(
            f"{name}\0{pin['sha256']}\n" for name, pin in sorted(member_pins.items())
        ).encode("utf-8"))
        if package_sha != PACKAGE_SHA:
            raise ValueError(f"Unexpected assembled reference package: {package_sha}")

        receipt = {
            "dataset": {"title": "BBBC039v1", "license": "CC0-1.0", "field": FIELD},
            "source": {"filename": source.name, **source_identity, "uint16le_yx_sha256": PIXELS},
            "mask": {"filename": mask.name, **verify(mask, MASK)},
            "model": {
                "publisher": "Constantin Pape", "doi": "10.5281/zenodo.6647674",
                "license": "CC-BY-4.0", "package_sha256": package_sha, "members": member_pins,
            },
        }
        (fixture / "fixture-identity.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        fixture.rename(output)
    print(json.dumps(receipt, indent=2))


def verify_written_adapter(model, adapter):
    target = model / "loci-model.json"
    target.write_bytes(adapter)
    return verify(target, ADAPTER)


if __name__ == "__main__":
    main()
