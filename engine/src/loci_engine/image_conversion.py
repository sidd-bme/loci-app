"""Lossless, bounded level-zero microscopy interchange for a registered scalar series."""

from __future__ import annotations

import hashlib
import math
import os
import shutil
import stat
import tempfile
from contextlib import ExitStack
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
import tifffile
import zarr
from numcodecs import Zlib

from .export import _rename_noreplace
from .native_image import NativeImageSession, NativeSelection
from .ome_zarr import (
    MAX_STORE_ENTRIES,
    OMEZarrPlaneRequest,
    OMEZarrSession,
    _entry_identity,
    _inventory,
)
from .research_data_export import _capability, _destination
from .research_project import canonical_json, parse_json
from .working_result import _sha256_file_stable

AXES = "TCZYX"
TILE = 256
FORMATS = {"ome-tiff": "image.ome.tif", "ome-zarr": "image.ome.zarr"}
BIGTIFF_THRESHOLD = 2**32 - 32 * 1024**2
NGFF_SECONDS = {
    "second": 1.0,
    "millisecond": 1e-3,
    "microsecond": 1e-6,
    "nanosecond": 1e-9,
    "minute": 60.0,
    "hour": 3600.0,
    "day": 86400.0,
}
OME_DTYPES = {"uint8", "uint16", "uint32", "int8", "int16", "int32", "float32", "float64"}


def _regions(shape):
    nt, nc, nz, ny, nx = shape
    for t, c, z in np.ndindex(nt, nc, nz):
        for y in range(0, ny, TILE):
            for x in range(0, nx, TILE):
                yield (t, c, z, slice(y, min(y + TILE, ny)), slice(x, min(x + TILE, nx)))


def _source_tiles(session, shape):
    if hasattr(session, "store"):
        requests = (
            OMEZarrPlaneRequest(
                t=t, c=c, z=z, y=y.start, x=x.start, height=y.stop - y.start, width=x.stop - x.start
            )
            for t, c, z, y, x in _regions(shape)
        )
        for plane in session.store.iter_verified_planes(requests):
            yield plane.values
        return
    meta = session.metadata
    for t, c, z, y, x in _regions(shape):
        yield session.read_region(
            NativeSelection(
                t=t,
                c=c,
                z=z,
                x=x.start,
                y=y.start,
                width=x.stop - x.start,
                height=y.stop - y.start,
                series=meta.selected_series,
                expected_sha256=meta.sha256,
            )
        ).pixels


def _coordinates(session):
    if hasattr(session, "store"):
        level = session.store.metadata.levels[0]
        return list(level.units_tczyx), list(level.scale_tczyx), list(level.translation_tczyx)
    meta = session.metadata
    units, scale, origin = [None] * 5, [1.0] * 5, [0.0] * 5
    if meta.physical_calibration:
        calibration = meta.physical_calibration
        for axis, spacing in zip(calibration.axes, calibration.spacing, strict=True):
            index = AXES.index(axis)
            units[index] = "micrometer" if calibration.unit in {"µm", "um"} else None
            scale[index] = spacing
    if meta.levels[0].origin_xyz:
        origin[-3:] = reversed(meta.levels[0].origin_xyz)
    if meta.timing and meta.timing.uniform_interval:
        scale[0], units[0] = meta.timing.uniform_interval, "second"
        if meta.timing.elapsed_times:
            origin[0] = meta.timing.elapsed_times[0]
    return units, scale, origin


def _ome_attributes(meta, coordinates):
    channels = []
    for c, name in enumerate(meta.channel_names):
        channel = {"Name": name}
        if c < len(meta.acquisition_display):
            display = meta.acquisition_display[c]
            if display.color_rgb is not None:
                alpha = display.opacity if display.opacity is not None else 1.0
                rgba = bytes(round(v * 255) for v in (*display.color_rgb, alpha))
                channel["Color"] = int.from_bytes(rgba, "big", signed=True)
        channels.append(channel)
    attrs = {"axes": AXES, "Channel": channels}
    calibration = meta.physical_calibration
    if calibration:
        for axis, value in zip(calibration.axes, calibration.spacing, strict=True):
            attrs["PhysicalSize" + axis] = value
            attrs["PhysicalSize" + axis + "Unit"] = (
                "µm" if calibration.unit in {"µm", "um"} else "pixel"
            )
    units, scale, _ = coordinates
    if units[0] in NGFF_SECONDS:
        attrs.update(TimeIncrement=scale[0] * NGFF_SECONDS[units[0]], TimeIncrementUnit="s")
    if meta.plane_positions or meta.plane_times or (meta.timing and meta.timing.elapsed_times):
        planes = {}
        for item in meta.plane_positions:
            plane = planes.setdefault((item.t, item.c, item.z), {})
            for axis, value, unit in zip("XYZ", item.position_xyz, item.units_xyz, strict=True):
                if value is not None:
                    plane["Position" + axis] = value
                    plane["Position" + axis + "Unit"] = unit
        for item in meta.plane_times:
            planes.setdefault((item.t, item.c, item.z), {}).update(
                DeltaT=item.delta_t_seconds, DeltaTUnit="s"
            )
        entries = []
        for t, c, z in np.ndindex(*meta.shape[:3]):
            entry = planes.get((t, c, z), {})
            if (
                meta.timing
                and len(meta.timing.elapsed_times) == meta.dimensions.t
                and "DeltaT" not in entry
            ):
                entry = {**entry, "DeltaT": meta.timing.elapsed_times[t], "DeltaTUnit": "s"}
            entries.append(entry)
        attrs["Plane"] = entries
    return attrs


def _ngff_attributes(meta, coordinates, ranges):
    units, scale, origin = coordinates
    axes = [
        {"name": axis.lower(), "type": kind, **({"unit": unit} if unit else {})}
        for axis, kind, unit in zip(
            AXES, ("time", "channel", "space", "space", "space"), units, strict=True
        )
    ]
    transform = [{"type": "scale", "scale": scale}]
    if any(origin):
        transform.append({"type": "translation", "translation": origin})
    channels = []
    for c, label in enumerate(meta.channel_names):
        low, high = ranges[c]
        if not math.isfinite(low):
            low, high = 0, 1
        color = "FFFFFF"
        if c < len(meta.acquisition_display) and meta.acquisition_display[c].color_rgb is not None:
            color = "".join(
                f"{round(value * 255):02X}" for value in meta.acquisition_display[c].color_rgb
            )
        channels.append(
            {
                "label": label,
                "color": color,
                "active": True,
                "window": {"min": low, "max": high, "start": low, "end": high},
            }
        )
    return {
        "multiscales": [
            {
                "version": "0.4",
                "axes": axes,
                "datasets": [{"path": "0", "coordinateTransformations": transform}],
            }
        ],
        "omero": {"version": "0.4", "channels": channels},
    }


def _write_image(session, meta, target, image_format, shape, dtype, coordinates, bigtiff):
    digest = hashlib.sha256()
    regions = _regions(shape)

    def tiles():
        for region, tile in zip(regions, _source_tiles(session, shape), strict=True):
            expected = tuple(s.stop - s.start for s in region[-2:])
            if tile.shape != expected or tile.dtype.name != dtype.name:
                raise ValueError("Source tile does not match the declared scalar grid or dtype")
            native = np.ascontiguousarray(tile, dtype=dtype)
            digest.update(memoryview(native).cast("B"))
            yield region, native

    if image_format == "ome-tiff":
        tile_size = tuple(min(TILE, 16 * math.ceil(size / 16)) for size in shape[-2:])
        with tifffile.TiffWriter(target, ome=True, bigtiff=bigtiff, byteorder="<") as writer:
            writer.write(
                data=(a for _, a in tiles()),
                shape=shape,
                dtype=dtype,
                tile=tile_size,
                photometric="minisblack",
                compression="deflate",
                maxworkers=1,
                metadata=_ome_attributes(meta, coordinates),
            )
    else:
        group = zarr.open_group(target, mode="w-", zarr_format=2)
        array = group.create_array(
            "0",
            shape=shape,
            chunks=(1, 1, 1, min(TILE, shape[3]), min(TILE, shape[4])),
            dtype=dtype,
            compressor=Zlib(level=3),
            fill_value=0,
            config={"write_empty_chunks": True},
        )
        ranges = [[math.inf, -math.inf] for _ in meta.channel_names]
        for indices, tile in tiles():
            array[indices] = tile
            # Source readers verify finite scientific samples before returning each tile.
            limits = ranges[indices[1]]
            limits[:] = min(limits[0], tile.min().item()), max(limits[1], tile.max().item())
        group.attrs.update(_ngff_attributes(meta, coordinates, ranges))
    return digest.hexdigest()


def _verify_image(path, image_format, meta, coordinates, dtype, expected):
    shape = tuple(meta.shape)
    digest = hashlib.sha256()
    with ExitStack() as stack:
        if image_format == "ome-tiff":
            tif = stack.enter_context(tifffile.TiffFile(path))
            series = tif.series[0]
            if not tif.is_ome or len(tif.series) != 1 or not tif.pages[0].is_tiled:
                raise ValueError("Expected one tiled OME-TIFF series")
            axes = series.axes
            store = stack.enter_context(series.aszarr())
            array = zarr.open_array(store, mode="r")
        else:
            array = zarr.open_array(path / "0", mode="r", zarr_format=2)
            axes = AXES
        if (
            not set(axes) <= set(AXES)
            or len(set(axes)) != len(axes)
            or tuple(dict(zip(axes, array.shape, strict=True)).get(a, 1) for a in AXES) != shape
            or array.dtype.name != dtype.name
        ):
            raise ValueError("Converted image axes, dimensions or dtype differ from the source")
        for indices in _regions(shape):
            key = tuple(indices[AXES.index(a)] for a in axes)
            tile = np.ascontiguousarray(array[key], dtype=dtype)
            digest.update(memoryview(tile).cast("B"))
    if digest.hexdigest() != expected:
        raise ValueError("Independent read-back detected different native pixel values")
    if image_format == "ome-tiff":
        with NativeImageSession(path) as output:
            read = output.metadata
            if read.channel_names != meta.channel_names:
                raise ValueError("OME-TIFF read-back found different channel labels")
            original, written = meta.physical_calibration, read.physical_calibration
            if bool(original) != bool(written) or (
                original
                and (
                    original.axes != written.axes
                    or original.spacing != written.spacing
                    or original.unit.replace("µ", "u") != written.unit.replace("µ", "u")
                )
            ):
                raise ValueError("OME-TIFF read-back found different physical calibration")
            if coordinates[0][0] in NGFF_SECONDS and (
                not read.timing
                or read.timing.uniform_interval
                != coordinates[1][0] * NGFF_SECONDS[coordinates[0][0]]
            ):
                raise ValueError("OME-TIFF read-back found a different time interval")
            if meta.plane_positions != read.plane_positions:
                raise ValueError("OME-TIFF read-back found different plane positions")
            times = {(i.t, i.c, i.z): i.delta_t_seconds for i in read.plane_times}
            if any(times.get((i.t, i.c, i.z)) != i.delta_t_seconds for i in meta.plane_times):
                raise ValueError("OME-TIFF read-back found different plane timestamps")
        return _sha256_file_stable(path, reject_symlink=True)
    with OMEZarrSession(path) as check:
        level = check.metadata.levels[0]
        if (
            check.metadata.channel_labels != meta.channel_names
            or tuple(coordinates[0]) != level.units_tczyx
            or tuple(coordinates[1]) != level.scale_tczyx
            or tuple(coordinates[2]) != level.translation_tczyx
        ):
            raise ValueError("OME-Zarr read-back found different channels or coordinates")
        integrity = check.verify_strict()
        return integrity.content_manifest_sha256, integrity.source_size_bytes


def _artifact_inventory(path, image_format):
    status = path.lstat()
    if image_format == "ome-tiff":
        if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
            raise ValueError("Converted TIFF must be one regular file")
        return {"": _entry_identity(status, "file")}
    if not stat.S_ISDIR(status.st_mode):
        raise ValueError("Converted store must be a plain directory")
    return {"": _entry_identity(status, "directory"), **_inventory(path)}


def _sync_directory_tree(folder):
    for _, dirs, names, fd in os.fwalk(folder, topdown=False, follow_symlinks=False):
        if any(
            not stat.S_ISDIR(os.stat(d, dir_fd=fd, follow_symlinks=False).st_mode) for d in dirs
        ):
            raise ValueError("Image conversion staging contains a linked directory")
        for name in names:
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                if not stat.S_ISREG(os.fstat(file_fd).st_mode):
                    raise ValueError("Image conversion staging contains an unexpected entry")
                os.fsync(file_fd)
            finally:
                os.close(file_fd)
        os.fsync(fd)


def convert_image(workbench, source_id, source_sha256, image_format, destination):
    """Publish one verified series and a metadata receipt together into a new directory."""
    _capability()
    if not isinstance(image_format, str) or image_format not in FORMATS:
        raise ValueError("Choose OME-TIFF or OME-Zarr")
    project = workbench.project
    target = _destination(project, destination)
    source = project.source(source_id)
    if source["sha256"] != source_sha256 or source.get("source_kind") not in {"native", "ome_zarr"}:
        raise ValueError("Select the current registered native image or OME-Zarr series")
    # Protect every registered source store, including closed images in the study.
    with project.connection() as db:
        for row in db.execute("SELECT record FROM sources"):
            locator = parse_json(row[0]).get("private_zarr_selection")
            if locator and target.is_relative_to(Path(locator["path"])):
                raise ValueError("Choose an output outside the original OME-Zarr store")
    if any(p.name.lower().endswith((".zarr", ".loci-study")) for p in target.parents):
        raise ValueError("Choose an output outside an image store or study")
    session = workbench._session(source_id)
    meta = session.metadata
    if hasattr(session, "store") and session.store.metadata.channel_labels:
        # Use labels on disk even if an older study registered generic display names.
        meta = replace(meta, channel_names=session.store.metadata.channel_labels)
    if meta.axes != AXES or meta.sample_semantics != "none" or meta.palette is not None:
        raise ValueError(
            "Choose a scalar series. RGB and indexed palettes need a color-aware export."
        )
    types = {np.dtype(d).name for d in meta.channel_dtypes}
    if len(types) != 1 or (image_format == "ome-tiff" and not types <= OME_DTYPES):
        raise ValueError("The destination cannot represent the source channel dtypes losslessly")
    dtype = np.dtype(next(iter(types))).newbyteorder("<")
    if dtype.kind not in "uif":
        raise ValueError("Unsupported scalar pixel type")
    shape = tuple(meta.shape)
    planes = math.prod(shape[:3])
    blocks = planes * math.ceil(shape[3] / TILE) * math.ceil(shape[4] / TILE)
    if image_format == "ome-zarr" and blocks + 8 > MAX_STORE_ENTRIES:
        raise ValueError("This series exceeds the supported OME-Zarr chunk count; choose OME-TIFF")
    if image_format == "ome-tiff" and planes > 1_000_000:
        raise ValueError("This series exceeds the OME-TIFF plane budget; choose OME-Zarr")
    raw_bytes = math.prod(shape) * dtype.itemsize
    chunk_dims = [
        min(TILE, 16 * math.ceil(s / 16)) if image_format == "ome-tiff" else min(TILE, s)
        for s in shape[-2:]
    ]
    bound = blocks * (math.prod(chunk_dims) * dtype.itemsize + 512) + planes * 512 + 1024**2
    if shutil.disk_usage(target.parent).free < bound:
        raise ValueError("Insufficient free disk space for a verified lossless conversion")
    bigtiff = image_format == "ome-tiff" and bound >= BIGTIFF_THRESHOLD
    coordinates = _coordinates(session)
    session.verify_strict()
    stage = Path(tempfile.mkdtemp(prefix=".loci-convert-", dir=target.parent))
    stage_id = stage.lstat()
    with ExitStack() as stack:
        parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, parent_fd)

        def verify_directory():
            if (
                target.parent.resolve(strict=True) != target.parent
                or not os.path.samestat(os.fstat(parent_fd), target.parent.lstat())
                or not os.path.samestat(
                    stage_id, os.stat(stage.name, dir_fd=parent_fd, follow_symlinks=False)
                )
            ):
                raise ValueError("Image conversion destination changed during export")

        try:
            verify_directory()
            path = stage / FORMATS[image_format]
            pixels = _write_image(
                session, meta, path, image_format, shape, dtype, coordinates, bigtiff
            )
            written = _artifact_inventory(path, image_format)
            if set(os.listdir(stage)) != {path.name}:
                raise ValueError("Image conversion staging contains an unexpected artifact")
            output_hash, size = _verify_image(path, image_format, meta, coordinates, dtype, pixels)
            session.verify_strict()
            summary = {
                "format": image_format,
                "artifact": path.name,
                "shape": list(shape),
                "axes": AXES,
                "dtype": dtype.name,
                "pixel_sha256": pixels,
                "output_sha256": output_hash,
                "bytes": size,
            }
            manifest = {
                "schema": "loci.image-conversion/v1",
                "source_id": source_id,
                "source_sha256": source_sha256,
                "source_format": meta.format,
                "series": meta.selected_series,
                "source_levels": len(meta.levels),
                "metadata_scope": (
                    "Selected full-resolution scalar series. The sidecar retains acquisition "
                    "timing, stage positions, display metadata and grid transforms. Other series, "
                    "pyramid levels, vendor tags, display edits and study results are excluded."
                ),
                "exported_level": 0,
                "raw_bytes": raw_bytes,
                "bigtiff": bigtiff,
                "pixel_hash_order": (
                    "TCZ, clipped 256x256 YX tiles, row-major little-endian samples"
                ),
                "output_hash_kind": "file-sha256"
                if image_format == "ome-tiff"
                else "tree-content-manifest-sha256",
                "channel_names": meta.channel_names,
                "calibration": asdict(meta.physical_calibration)
                if meta.physical_calibration
                else None,
                "coordinates": {
                    "units": coordinates[0],
                    "scale": coordinates[1],
                    "translation": coordinates[2],
                },
                "timing": asdict(meta.timing) if meta.timing else None,
                "plane_times": [asdict(v) for v in meta.plane_times],
                "plane_positions": [asdict(v) for v in meta.plane_positions],
                "acquisition_display": [asdict(v) for v in meta.acquisition_display],
                "source_selection": {
                    k: v
                    for k, v in source.get("private_zarr_selection", {}).items()
                    if k in {"image_group", "multiscale_index"}
                },
                **summary,
            }
            manifest_bytes = (canonical_json(manifest) + "\n").encode("utf-8")
            manifest_path = stage / "conversion.json"
            with manifest_path.open("xb") as stream:
                stream.write(manifest_bytes)
            _sync_directory_tree(stage)
            if (
                set(os.listdir(stage)) != {path.name, "conversion.json"}
                or written != _artifact_inventory(path, image_format)
                or _sha256_file_stable(manifest_path, reject_symlink=True)[0]
                != hashlib.sha256(manifest_bytes).hexdigest()
            ):
                raise ValueError("Converted image changed after read-back verification")
            verify_directory()
            _rename_noreplace(stage.name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            try:
                os.fsync(parent_fd)
            except OSError as error:
                raise ValueError(
                    "The verified image was published, but folder durability "
                    "could not be confirmed. Inspect the destination before retrying."
                ) from error
        finally:
            # Only remove the private staging directory we created.
            try:
                remaining = os.stat(stage.name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                if os.path.samestat(remaining, stage_id):
                    shutil.rmtree(stage.name, dir_fd=parent_fd)
    return summary
