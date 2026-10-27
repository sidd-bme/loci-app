#!/usr/bin/env python3
"""Explicit approved BBBC039/013 provisioning; never executes downloaded code.

Original archives are retained and fingerprinted. References live separately in
the evaluator directory, which must not be granted to the task-performing agent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import stat
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import numpy as np
import tifffile
from PIL import Image

SOURCES = {
    "039-images": ("BBBC039/images.zip", "CC0", False),
    "039-masks": ("BBBC039/masks.zip", "CC0", True),
    "039-metadata": ("BBBC039/metadata.zip", "CC0", False),
    "013-frm": ("BBBC013/BBBC013_v1_images_frm.zip", "CC-BY-3.0; Ilya Ravkin", False),
    "013-bmp": ("BBBC013/BBBC013_v1_images_bmp.zip", "CC-BY-3.0; Ilya Ravkin", False),
    "013-reproduction": (
        "BBBC013/BBBC013_reproduce_logan.zip",
        "BBBC-hosted methods; no separate redistribution licence asserted",
        True,
    ),
    **{
        f"013-platemap-{key}": (
            f"BBBC013/BBBC013_v1_platemap_{key}.txt",
            "BBBC-hosted metadata",
            False,
        )
        for key in ("all", "wortmannin", "ly294002")
    },
}
BASE_URL = "https://data.broadinstitute.org/bbbc/"
MAX_ARCHIVE = 256 << 20
MAX_MEMBER = 128 << 20
MAX_EXPANDED = 2 << 30
MAX_MEMBERS = 5000
RETAINED_039 = {
    "039-images": (
        "images.zip",
        77915748,
        "6f30a5d4fe38c928ded972704f085975f8dc0d65d9aa366df00e5a9d449fddd7",
    ),
    "039-masks": (
        "masks.zip",
        2753811,
        "f9e6043d8ca56344a4886f96a700d804d6ee982f31e2b2cd3194af2a053c2710",
    ),
    "039-metadata": (
        "metadata.zip",
        17816,
        "a2c1f900bed9ba92a99553efd4c2ae98598433691c7401d818653ab61110deb2",
    ),
}
RETAINED_SELECTION_SHA256 = (
    "cf5c2ba3d94e1d61be63e001d20105a031c22a2675e7fdc985c71570e56f02c2"
)
RETAINED_SELECTION_NAMES = {
    "train": {
        "IXMtest_A06_s6_w1B9577918-4973-4A87-BA73-A168AA755527.png",
        "IXMtest_A15_s5_w1825174D4-ED30-490C-9635-6196417D6C9D.png",
        "IXMtest_A16_s3_w1032BE329-E21B-4E1B-B4B8-58700685EE0C.png",
    },
    "test": {
        "IXMtest_A09_s1_w1CE70AD49-290D-4312-82E6-CDC717F32637.png",
        "IXMtest_A12_s7_w1EAEEA614-51ED-43B3-A4FF-088730911E4C.png",
        "IXMtest_A16_s2_w15AF20A10-82AE-48FA-AC50-7AE8AC3AA544.png",
    },
}
OFFICIAL_039_PARTITION_SHA256 = {
    "training": "0e576fbbc420a7435ceeab3d0db6c8af7a5d0b42abf9d376cb29fe027e8d9f74",
    "validation": "4fca45a79803e9abda51ecfca8acb97239b8e3183385c91c6f2c9f493174aa20",
    "test": "938af88d75a723e83c1e5b5802f8cd22e0cc4b0e2be7bebaf6b48e26a7fef2ba",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def identity(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Not a regular source file: {path}")
    return {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def write_json(path: Path, value) -> None:
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def reject_symlink_ancestors(path: Path) -> None:
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError(f"Symlink path refused: {candidate}")


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname != "data.broadinstitute.org":
            raise ValueError("Redirect left approved official dataset host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, destination: Path) -> dict:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "data.broadinstitute.org":
        raise ValueError("Download URL is not on the approved official dataset host")
    reject_symlink_ancestors(destination)
    if destination.exists():
        raise FileExistsError(destination)
    opener = urllib.request.build_opener(OfficialRedirects())
    request = urllib.request.Request(
        url, headers={"User-Agent": "Loci-approved-BBBC-qualification/1"}
    )
    with opener.open(request, timeout=90) as response, destination.open("xb") as stream:
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > MAX_ARCHIVE:
            raise ValueError("Download exceeds archive byte limit")
        total = 0
        for block in iter(lambda: response.read(1 << 20), b""):
            total += len(block)
            if total > MAX_ARCHIVE:
                raise ValueError("Download exceeds archive byte limit")
            stream.write(block)
        if declared and total != int(declared):
            raise ValueError("Truncated download")
        final_url = response.url
    return {
        **identity(destination),
        "url": url,
        "final_url": final_url,
        "upstream_checksum": None,
        "checksum_basis": "locally measured after HTTPS download",
    }


def safe_extract(archive: Path, destination: Path) -> list[dict]:
    """Validate all entries before exclusive bounded extraction; never overwrite."""
    reject_symlink_ancestors(destination)
    if destination.exists():
        raise FileExistsError(destination)
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if (
            len(members) > MAX_MEMBERS
            or sum(m.file_size for m in members) > MAX_EXPANDED
        ):
            raise ValueError("Expanded archive limit exceeded")
        seen = set()
        for member in members:
            name = member.filename
            path = PurePosixPath(name)
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (
                not name
                or "\\" in name
                or path.is_absolute()
                or ":" in name
                or any(p in ("", ".", "..") for p in name.rstrip("/").split("/"))
                or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                or member.flag_bits & 1
                or member.file_size > MAX_MEMBER
                or name.rstrip("/").casefold() in seen
            ):
                raise ValueError(f"Unsafe archive member: {name!r}")
            seen.add(name.rstrip("/").casefold())
        destination.mkdir(parents=True, exist_ok=False)
        records = []
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.filename).parts)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, target.open("xb") as output:
                copied = 0
                for block in iter(lambda: source.read(1 << 20), b""):
                    copied += len(block)
                    if copied > member.file_size or copied > MAX_MEMBER:
                        raise ValueError("Expanded member limit exceeded")
                    output.write(block)
            if copied != member.file_size:
                raise ValueError("Expanded member size mismatch")
            records.append({**identity(target), "archive_member": member.filename})
    return records


def scalar_bmp(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        if (
            image.format != "BMP"
            or image.size != (640, 640)
            or image.mode not in ("L", "P", "RGB")
        ):
            raise ValueError(f"Unexpected BBBC013 BMP: {path}")
        values = np.asarray(image)
        if image.mode == "P":
            palette = np.asarray(image.getpalette()).reshape(-1, 3)
            rgb = palette[values]
            if not (
                np.array_equal(rgb[..., 0], rgb[..., 1])
                and np.array_equal(rgb[..., 0], rgb[..., 2])
            ):
                raise ValueError("BMP palette is not grayscale")
            values = rgb[..., 0]
        elif image.mode == "RGB":
            if not (
                np.array_equal(values[..., 0], values[..., 1])
                and np.array_equal(values[..., 0], values[..., 2])
            ):
                raise ValueError("BMP channels differ")
            values = values[..., 0]
    if values.dtype != np.uint8:
        raise ValueError("BBBC013 BMP must retain 8-bit source samples")
    return values


def prepare_013(extracted: Path, output: Path) -> list[dict]:
    """Stack exact scalar BMP values as C,Y,X; never call these native FRM values."""
    reject_symlink_ancestors(output)
    output.mkdir(parents=True, exist_ok=False)
    pairs: dict[str, dict[int, Path]] = {}
    for path in sorted(extracted.rglob("*")):
        if path.suffix.lower() != ".bmp":
            continue
        match = re.fullmatch(
            r"Channel([12])-(\d{2})-([A-H])-(\d{2})", path.stem, re.IGNORECASE
        )
        if not match:
            raise ValueError(f"Unrecognized BBBC013 BMP name: {path.name}")
        row, column, channel = match[3].upper(), int(match[4]), int(match[1])
        well = f"{row}{column:02d}"
        if (
            not 1 <= column <= 12
            or int(match[2]) != (ord(row) - ord("A")) * 12 + column
        ):
            raise ValueError("BBBC013 plate index disagrees with row/column")
        if channel not in (1, 2) or channel in pairs.setdefault(well, {}):
            raise ValueError("Duplicate/unknown channel")
        pairs[well][channel] = path
    if len(pairs) != 96 or any(set(channels) != {1, 2} for channels in pairs.values()):
        raise ValueError("Expected 96 complete two-channel BBBC013 wells")
    records = []
    for well, channels in sorted(pairs.items()):
        pixels = np.stack([scalar_bmp(channels[c]) for c in (1, 2)])
        path = output / f"BBBC013_{well}_8bit_bmp.ome.tif"
        tifffile.imwrite(
            path,
            pixels,
            ome=True,
            metadata={"axes": "CYX", "Channel": {"Name": ["FKHR-GFP", "DNA (DRAQ)"]}},
            photometric="minisblack",
        )
        if not np.array_equal(tifffile.imread(path), pixels):
            raise ValueError("Prepared TIFF pixel mismatch")
        records.append(
            {
                "well": well,
                "derived": identity(path),
                "sources": [identity(channels[c]) for c in (1, 2)],
                "axes": "CYX",
                "dtype": "uint8",
                "shape": list(pixels.shape),
                "physical_calibration": None,
                "units": "source BMP digital numbers; spatial pixel units",
                "channel_names": ["FKHR-GFP", "DNA (DRAQ)"],
                "native_frm_converted": False,
            }
        )
    return records


def validated_039_partitions(
    data: Path, prior_selection: Path | None = None
) -> tuple[dict, set]:
    """Pin the same frozen six-field exposure list and official splits.

    Public replay needs no private run artifact. An explicitly supplied historical
    manifest must still match both the exact authorized bytes and frozen names.
    """
    metadata = data / "extracted/039-metadata/metadata"
    selected = {key: sorted(names) for key, names in RETAINED_SELECTION_NAMES.items()}
    if prior_selection is not None:
        reject_symlink_ancestors(prior_selection)
        if sha256(prior_selection) != RETAINED_SELECTION_SHA256:
            raise ValueError(
                "Historical selection manifest differs from authorized SHA-256"
            )
        prior = json.loads(prior_selection.read_text())
        selected = prior.get("selected", {})
        if set(selected) != {"train", "test"} or any(
            len(selected.get(key, [])) != 3 or set(selected[key]) != names
            for key, names in RETAINED_SELECTION_NAMES.items()
        ):
            raise ValueError(
                "Historical selection names differ from the authorized six fields"
            )
    exposed = set(selected["train"] + selected["test"])
    for key, expected in OFFICIAL_039_PARTITION_SHA256.items():
        partition = metadata / f"{key}.txt"
        reject_symlink_ancestors(partition)
        if sha256(partition) != expected:
            raise ValueError("Official BBBC039 partition identity changed")
    partitions = {
        key: (metadata / f"{key}.txt").read_text().splitlines()
        for key in ("training", "validation", "test")
    }
    if {key: len(names) for key, names in partitions.items()} != {
        "training": 100,
        "validation": 50,
        "test": 50,
    }:
        raise ValueError("Unexpected official BBBC039 partition sizes")
    names = [name for group in partitions.values() for name in group]
    if len(set(names)) != 200 or not exposed.issubset(names):
        raise ValueError("Partitions overlap or prior exposure cannot be reconciled")
    if not set(selected["train"]).issubset(partitions["training"]):
        raise ValueError(
            "Prior training exposure does not match official training partition"
        )
    if not set(selected["test"]).issubset(partitions["test"]):
        raise ValueError("Prior test exposure does not match official test partition")
    if len(set(partitions["test"]) - exposed) != 47:
        raise ValueError("Expected exactly 47 eligible sealed BBBC039 test fields")
    return partitions, exposed


def prepare_039(data: Path, prior_selection: Path | None = None) -> dict:
    """Partition and losslessly remove non-microscopy DPI tags; no mask access."""
    partitions, exposed = validated_039_partitions(data, prior_selection)
    metadata = data / "extracted/039-metadata/metadata"
    output = data / "prepared/BBBC039"
    reject_symlink_ancestors(output)
    output.mkdir(parents=True, exist_ok=False)
    records = []
    for split, names in partitions.items():
        for name in names:
            if Path(name).name != name or not name.endswith(".png"):
                raise ValueError("Unexpected official partition filename")
            source = data / "extracted/039-images/images" / (Path(name).stem + ".tif")
            pixels = tifffile.imread(source)
            if pixels.shape != (520, 696) or pixels.dtype != np.uint16:
                raise ValueError("Unexpected BBBC039 source array")
            role = (
                "historically-exposed"
                if name in exposed
                else ("sealed-test" if split == "test" else "development")
            )
            target_dir = output / role / split
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / (Path(name).stem + ".ome.tif")
            tifffile.imwrite(
                target,
                pixels,
                ome=True,
                photometric="minisblack",
                resolution=(1, 1),
                resolutionunit="NONE",
                metadata={"axes": "YX"},
            )
            if not np.array_equal(tifffile.imread(target), pixels):
                raise ValueError("BBBC039 adapter changed raw pixels")
            records.append(
                {
                    "official_split": split,
                    "role": role,
                    "reference_filename": name,
                    "source": identity(source),
                    "derived": identity(target),
                    "axes": "YX",
                    "dtype": "uint16",
                    "shape": [520, 696],
                    "physical_calibration": None,
                    "spatial_units": "pixel",
                }
            )
    return {
        "images": records,
        "prior_exposure_manifest": identity(prior_selection)
        if prior_selection is not None
        else None,
        "exposure_basis": (
            "exact-authorized-historical-selection-manifest"
            if prior_selection is not None
            else "frozen-protocol-six-field-list"
        ),
        "frozen_exposure_fields": {
            key: sorted(names) for key, names in RETAINED_SELECTION_NAMES.items()
        },
        "official_partitions": {
            key: identity(metadata / f"{key}.txt") for key in partitions
        },
        "sealed_test_fields": sum(
            record["role"] == "sealed-test" for record in records
        ),
        "exposure_rule": "All six historical fields are development; three official test fields excluded from sealed test",
    }


def verify_manifest(path: Path) -> dict:
    """Reject modified originals or extracted members before every replay."""
    manifest = json.loads(path.read_text())
    checked = 0
    for source in manifest["sources"]:
        for record in (source, *source.get("members", [])):
            file = Path(record["path"])
            reject_symlink_ancestors(file)
            actual = identity(file)
            if (
                actual["bytes"] != record["bytes"]
                or actual["sha256"] != record["sha256"]
            ):
                raise ValueError(f"Source identity changed: {file}")
            checked += 1
    return {"manifest": identity(path), "verified_files": checked}


def provision(root: Path, evaluator: Path, reuse_039: Path | None = None) -> None:
    for directory in (root, evaluator):
        reject_symlink_ancestors(directory)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "originals").mkdir(exist_ok=True)
        if (directory / "source-manifest.json").exists() or (
            directory / "reference-manifest.json"
        ).exists():
            raise FileExistsError("Provisioning manifest already published")
    public, private = [], []
    for key, (relative, licence, held) in SOURCES.items():
        owner = evaluator if held else root
        archive = owner / "originals" / f"{key}-{Path(relative).name}"
        if reuse_039 is not None and key in RETAINED_039:
            name, size, digest = RETAINED_039[key]
            source = reuse_039 / name
            actual = identity(source)
            if actual["bytes"] != size or actual["sha256"] != digest:
                raise ValueError(
                    "Retained approved archive differs from pinned prior manifest"
                )
            with source.open("rb") as incoming, archive.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            acquired = {
                **identity(archive),
                "url": BASE_URL + relative,
                "reused_from": actual,
                "checksum_basis": "matches retained authorized official-download archive; not publisher supplied",
            }
        else:
            acquired = download(BASE_URL + relative, archive)
        record = {"key": key, "rights_statement": licence, **acquired}
        if archive.suffix == ".zip":
            record["members"] = safe_extract(archive, owner / "extracted" / key)
        (private if held else public).append(record)
        print(
            f"Provisioned {key}: {record['bytes']} bytes {record['sha256']}", flush=True
        )
    write_json(
        root / "source-manifest.json",
        {
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "sources": public,
            "source_pages": [
                "https://bbbc.broadinstitute.org/BBBC039",
                "https://bbbc.broadinstitute.org/BBBC013",
            ],
            "attribution_013": "BBBC013v1, provided by Ilya Ravkin, Broad Bioimage Benchmark Collection, CC BY 3.0",
            "originals_policy": "Never modify originals; verify sizes and SHA-256 before every replay",
        },
    )
    write_json(
        evaluator / "reference-manifest.json",
        {"sources": private, "task_agent_access": "forbidden"},
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    fetch = sub.add_parser("provision")
    fetch.add_argument("--data", type=Path, required=True)
    fetch.add_argument("--evaluator", type=Path, required=True)
    fetch.add_argument("--reuse-039", type=Path)
    prepare = sub.add_parser("prepare-013")
    prepare.add_argument("--data", type=Path, required=True)
    nuclei = sub.add_parser("prepare-039")
    nuclei.add_argument("--data", type=Path, required=True)
    nuclei.add_argument(
        "--prior-selection",
        type=Path,
        help=(
            "Optional exact authorized historical selection manifest; when omitted, "
            "use the same six frozen exposure filenames and retain 47 sealed test fields"
        ),
    )
    verify = sub.add_parser("verify")
    verify.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "provision":
        provision(args.data.absolute(), args.evaluator.absolute(), args.reuse_039)
    elif args.action == "prepare-013":
        verify_manifest(args.data / "source-manifest.json")
        records = prepare_013(
            args.data / "extracted/013-bmp", args.data / "prepared/BBBC013"
        )
        write_json(args.data / "prepared/BBBC013-manifest.json", {"images": records})
    elif args.action == "prepare-039":
        verify_manifest(args.data / "source-manifest.json")
        records = prepare_039(args.data, args.prior_selection)
        write_json(args.data / "prepared/BBBC039-manifest.json", records)
    else:
        print(json.dumps(verify_manifest(args.manifest), indent=2))


if __name__ == "__main__":
    main()
