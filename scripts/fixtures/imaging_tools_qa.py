"""Independent full-series OME conversion checker for imaging-tools.qa.mjs.

Uses tifffile/XML and zarr directly. It checks the published bytes and compares
every scalar pixel in TCZYX order with a pinned source series.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from xml.etree import ElementTree

import numpy as np
import tifffile
import zarr

AXES = "TCZYX"
ARTIFACTS = {"ome-tiff": "image.ome.tif", "ome-zarr": "image.ome.zarr"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def physical_unit(unit):
    aliases = {
        "µm": ("µm", 1),
        "μm": ("µm", 1),
        "um": ("µm", 1),
        "micrometer": ("µm", 1),
        "micrometre": ("µm", 1),
        "nm": ("µm", 0.001),
        "nanometer": ("µm", 0.001),
        "mm": ("µm", 1000),
        "millimeter": ("µm", 1000),
        "s": ("s", 1),
        "second": ("s", 1),
        "ms": ("s", 0.001),
        "millisecond": ("s", 0.001),
        "pixel": ("pixel", 1),
    }
    require(unit in aliases, f"Unsupported OME coordinate unit: {unit}")
    return aliases[unit]


def coordinate(value, unit):
    normalized, factor = physical_unit(unit)
    scaled = float(value) * factor
    require(math.isfinite(scaled) and scaled > 0, "Invalid physical scale")
    return scaled, normalized


def read_tiff(path, *, output=False):
    with tifffile.TiffFile(path) as tif:
        require(
            tif.is_ome and len(tif.series) == 1, "Expected one scalar OME-TIFF series"
        )
        series = tif.series[0]
        require(
            len(series.levels) == 1 or not output,
            "The converted OME-TIFF must contain just the full-resolution level",
        )
        axes = series.axes
        require(
            len(set(axes)) == len(axes)
            and set(axes) <= set(AXES)
            and set("YX") <= set(axes),
            f"Unsupported TIFF axes: {axes}",
        )
        pixels = ElementTree.fromstring(tif.ome_metadata).find("{*}Image/{*}Pixels")
        require(pixels is not None, "Missing OME pixel metadata")
        shape = tuple(int(pixels.attrib[f"Size{axis}"]) for axis in AXES)
        data = series.asarray().transpose(
            [axes.index(axis) for axis in AXES if axis in axes]
        )
        actual_shape = tuple(
            dict(zip(axes, series.shape, strict=True)).get(axis, 1) for axis in AXES
        )
        require(actual_shape == shape, "OME metadata disagrees with the TIFF array")
        channels = pixels.findall("{*}Channel")
        require(len(channels) == shape[1], "Wrong number of scalar channels")
        require(
            all(c.get("SamplesPerPixel", "1") == "1" for c in channels),
            "Expected scalar channels",
        )
        names = [channel.attrib["Name"] for channel in channels]
        scales = {
            axis: coordinate(
                pixels.attrib[f"PhysicalSize{axis}"],
                pixels.get(f"PhysicalSize{axis}Unit", "µm"),
            )
            for axis in "XYZ"
            if f"PhysicalSize{axis}" in pixels.attrib
        }
        if pixels.get("TimeIncrement") is not None:
            scales["T"] = coordinate(
                pixels.attrib["TimeIncrement"], pixels.get("TimeIncrementUnit", "s")
            )
        return data.reshape(shape), names, scales


def read_zarr(path):
    group = zarr.open_group(path, mode="r")
    multiscales = group.attrs["multiscales"]
    require(len(multiscales) == 1, "Expected one OME-Zarr multiscale")
    multiscale = multiscales[0]
    require(multiscale.get("version") == "0.4", "Expected OME-NGFF 0.4 metadata")
    axes = multiscale["axes"]
    require(
        [axis["name"] for axis in axes] == list(AXES.lower()),
        "OME-Zarr must declare TCZYX",
    )
    require(
        [axis["type"] for axis in axes]
        == ["time", "channel", "space", "space", "space"],
        "OME-Zarr axis types disagree with TCZYX",
    )
    datasets = multiscale["datasets"]
    require(
        len(datasets) == 1 and datasets[0]["path"] == "0",
        "Expected just the full-resolution Zarr array",
    )
    transforms = datasets[0]["coordinateTransformations"]
    require(
        [item["type"] for item in transforms] in [["scale"], ["scale", "translation"]],
        "Unexpected OME-Zarr transforms",
    )
    scale = transforms[0]["scale"]
    require(
        len(scale) == len(AXES)
        and all(math.isfinite(item) and item > 0 for item in scale),
        "Invalid TCZYX scale",
    )
    translation = (
        transforms[1]["translation"] if len(transforms) == 2 else [0] * len(AXES)
    )
    require(translation == [0] * len(AXES), "The fixture has an unshifted image grid")
    scales = {
        name: coordinate(value, axis["unit"])
        for name, axis, value in zip(AXES, axes, scale, strict=True)
        if "unit" in axis
    }
    require(
        all(
            value == 1
            for axis, value in zip(axes, scale, strict=True)
            if "unit" not in axis
        ),
        "Unitless fixture axes must retain unit scale",
    )
    names = [channel["label"] for channel in group.attrs["omero"]["channels"]]
    return group["0"][:], names, scales


def tree_manifest(path):
    digest = hashlib.sha256()
    files = 0
    size = 0
    for entry in sorted(
        path.rglob("*"), key=lambda item: item.relative_to(path).as_posix()
    ):
        require(
            not entry.is_symlink() and (entry.is_dir() or entry.is_file()),
            "Unexpected Zarr store entry",
        )
        if entry.is_file():
            row = {
                "path": entry.relative_to(path).as_posix(),
                "bytes": entry.stat().st_size,
                "sha256": sha256(entry),
            }
            digest.update(
                json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n"
            )
            files += 1
            size += row["bytes"]
    require(files > 0, "Empty Zarr artifact")
    return digest.hexdigest(), size, files


def pixel_digest(source, converted):
    require(
        converted.shape == source.shape,
        f"Changed TCZYX shape: {source.shape} -> {converted.shape}",
    )
    require(
        converted.dtype.name == source.dtype.name,
        f"Changed dtype: {source.dtype} -> {converted.dtype}",
    )
    digest = hashlib.sha256()
    dtype = source.dtype.newbyteorder("<")
    for t, c, z in np.ndindex(*source.shape[:3]):
        for y in range(0, source.shape[3], 256):
            for x in range(0, source.shape[4], 256):
                key = (t, c, z, slice(y, y + 256), slice(x, x + 256))
                expected = np.asarray(source[key], dtype=dtype).tobytes(order="C")
                observed = np.asarray(converted[key], dtype=dtype).tobytes(order="C")
                require(
                    expected == observed,
                    f"Changed pixel bits in T{t}/C{c}/Z{z} tile at Y{y}/X{x}",
                )
                digest.update(expected)
    return digest.hexdigest()


def verify(source, bundle, format_name, expected_source_sha256, source_id):
    before = sha256(source)
    require(
        before == expected_source_sha256,
        "Source SHA-256 changed before numerical read-back",
    )
    filename = ARTIFACTS[format_name]
    require(
        not bundle.is_symlink()
        and {item.name for item in bundle.iterdir()} == {filename, "conversion.json"},
        "Unexpected conversion bundle contents",
    )
    manifest_path = bundle / "conversion.json"
    artifact = bundle / filename
    require(
        not manifest_path.is_symlink() and not artifact.is_symlink(),
        "Linked conversion artifacts are invalid",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    original, names, scales = read_tiff(source)
    if format_name == "ome-tiff":
        converted, output_names, output_scales = read_tiff(artifact, output=True)
        output_sha, size, files = sha256(artifact), artifact.stat().st_size, 1
        hash_kind = "file-sha256"
    else:
        output_sha, size, files = tree_manifest(artifact)
        converted, output_names, output_scales = read_zarr(artifact)
        hash_kind = "tree-content-manifest-sha256"

    require(names == output_names, "Channel names or order changed")
    require(
        scales == output_scales,
        f"Acquisition scale changed: {scales} -> {output_scales}",
    )
    require(
        set("XYZ") <= scales.keys() and all(scales[axis][1] == "µm" for axis in "XYZ"),
        "Expected a spatially calibrated 3D fixture",
    )
    pixels = pixel_digest(original, converted)
    fields = {
        "schema": "loci.image-conversion/v1",
        "source_id": source_id,
        "source_sha256": before,
        "series": 0,
        "exported_level": 0,
        "format": format_name,
        "artifact": filename,
        "shape": list(original.shape),
        "axes": AXES,
        "dtype": original.dtype.name,
        "channel_names": names,
        "raw_bytes": original.nbytes,
        "pixel_sha256": pixels,
        "output_sha256": output_sha,
        "output_hash_kind": hash_kind,
        "bytes": size,
    }
    for key, expected in fields.items():
        require(
            manifest.get(key) == expected, f"Incorrect conversion receipt field: {key}"
        )
    coordinates = manifest["coordinates"]
    receipt_scales = {
        axis: coordinate(value, unit)
        for axis, value, unit in zip(
            AXES, coordinates["scale"], coordinates["units"], strict=True
        )
        if unit is not None
    }
    require(
        receipt_scales == scales and coordinates["translation"] == [0] * len(AXES),
        "Conversion receipt coordinates differ from the source grid",
    )
    after = sha256(source)
    require(after == before, "Source SHA-256 changed during numerical read-back")
    return {
        **fields,
        "spatial_and_time_scales": scales,
        "pixels_compared": original.size,
        "planes_compared": math.prod(original.shape[:3]),
        "output_files": files,
        "manifest_sha256": sha256(manifest_path),
        "source_sha256_after": after,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("format", choices=ARTIFACTS)
    parser.add_argument("source_sha256")
    parser.add_argument("source_id")
    args = parser.parse_args()
    print(
        json.dumps(
            verify(
                args.source,
                args.bundle,
                args.format,
                args.source_sha256,
                args.source_id,
            ),
            sort_keys=True,
        )
    )
