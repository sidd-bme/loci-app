"""Bounded, read-only overview support for modern HDF5-backed Imaris files.

This is deliberately not a 3D viewer. It validates the documented Imaris 5.5+
layout, selects one pyramid level, and reads only a central Z plane for a
truthfully labelled overview.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import h5py
import numpy as np

from .models import SourceVolumeMetadata
from .render import _display_bounds, _display_float

IMS_OVERVIEW_MAX_EDGE = 2200
IMS_MAX_DECODED_CHUNK_BYTES = 64 * 1024 * 1024
IMS_MAX_OVERVIEW_CHANNELS = 64
_NUMBERED_GROUP = re.compile(r"^(?P<label>ResolutionLevel|TimePoint|Channel) (?P<index>\d+)$")
_DEFAULT_CHANNEL_COLORS = (
    (0.16, 0.86, 0.64),
    (0.94, 0.32, 0.62),
    (0.25, 0.62, 1.0),
    (1.0, 0.77, 0.24),
    (0.96, 0.32, 0.28),
    (0.55, 0.42, 0.96),
    (0.88, 0.88, 0.88),
)


class UnsupportedImarisError(ValueError):
    """Raised when a file is not a supported modern Imaris HDF5 dataset."""


@dataclass(frozen=True, slots=True)
class _Level:
    index: int
    width: int
    height: int
    depth: int
    group: h5py.Group


def is_hdf5_file(path: Path) -> bool:
    """Return whether HDF5 recognizes the file signature without opening pixel data."""

    try:
        return bool(h5py.is_hdf5(path))
    except (OSError, TypeError):
        return False


def _attribute_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").rstrip("\x00")
    if isinstance(value, str):
        return value.rstrip("\x00")
    array = np.asarray(value)
    if array.ndim == 0:
        return _attribute_text(array.item())
    if array.dtype.kind == "S":
        raw = b"".join(bytes(item) for item in array.reshape(-1))
        return raw.decode("utf-8", errors="replace").rstrip("\x00")
    if array.dtype.kind == "U":
        return "".join(str(item) for item in array.reshape(-1)).rstrip("\x00")
    if array.size == 1:
        return str(array.reshape(-1)[0])
    return " ".join(str(item) for item in array.reshape(-1))


def _attribute_int(group: h5py.Group, name: str, fallback: int) -> int:
    if name not in group.attrs:
        return fallback
    try:
        value = int(float(_attribute_text(group.attrs[name])))
    except (TypeError, ValueError, OverflowError) as exc:
        raise UnsupportedImarisError(f"The IMS attribute {name} is invalid.") from exc
    if value <= 0:
        raise UnsupportedImarisError(f"The IMS attribute {name} must be positive.")
    return value


def _attribute_float(group: h5py.Group, name: str) -> float | None:
    if name not in group.attrs:
        return None
    try:
        value = float(_attribute_text(group.attrs[name]))
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _numbered_children(group: h5py.Group, label: str) -> list[tuple[int, h5py.Group]]:
    children: list[tuple[int, h5py.Group]] = []
    for name in group:
        match = _NUMBERED_GROUP.fullmatch(name)
        if match is None or match.group("label") != label:
            continue
        child = _local_child(group, name)
        if not isinstance(child, h5py.Group):
            continue
        children.append((int(match.group("index")), child))
    return sorted(children, key=lambda item: item[0])


def _local_child(group: h5py.Group, name: str) -> h5py.Group | h5py.Dataset | None:
    """Resolve only links whose bytes are covered by the selected IMS fingerprint."""

    link = group.get(name, getlink=True)
    if isinstance(link, h5py.ExternalLink):
        raise UnsupportedImarisError(
            "IMS external links are not supported because their target bytes are outside "
            "the selected source's integrity fingerprint."
        )
    child = group.get(name)
    if child is not None and child.file.id != group.file.id:
        raise UnsupportedImarisError(
            "IMS linked objects outside the selected container are not supported because "
            "their bytes are outside the selected source's integrity fingerprint."
        )
    return child


def _local_numeric_dataset(channel: h5py.Group) -> h5py.Dataset:
    data = _local_child(channel, "Data")
    if not isinstance(data, h5py.Dataset):
        raise UnsupportedImarisError("An IMS channel is missing its Data dataset.")
    if data.is_virtual or data.external:
        raise UnsupportedImarisError(
            "IMS virtual or externally stored channel data is not supported because all "
            "pixel bytes must be covered by the selected source's integrity fingerprint."
        )
    dtype = np.dtype(data.dtype)
    if not (
        np.issubdtype(dtype, np.bool_)
        or np.issubdtype(dtype, np.integer)
        or np.issubdtype(dtype, np.floating)
    ):
        raise UnsupportedImarisError(f"IMS channel type {dtype} is not a real intensity type.")
    if np.issubdtype(dtype, np.integer) and dtype.itemsize > 4:
        raise UnsupportedImarisError(
            f"IMS channel type {dtype} uses unsupported 64-bit integer samples. Loci cannot "
            "preserve a narrow intensity range at that offset in its current display basis."
        )
    if np.issubdtype(dtype, np.floating) and dtype.itemsize > 8:
        raise UnsupportedImarisError(
            f"IMS channel type {dtype} uses floating-point samples wider than 64 bits."
        )
    if data.chunks is not None:
        decoded_chunk_bytes = int(data.dtype.itemsize)
        for dimension in data.chunks:
            decoded_chunk_bytes *= int(dimension)
        if decoded_chunk_bytes > IMS_MAX_DECODED_CHUNK_BYTES:
            raise UnsupportedImarisError(
                "This IMS channel uses an HDF5 chunk that expands to "
                f"{decoded_chunk_bytes / (1024 * 1024):,.1f} MiB, above Loci's "
                f"{IMS_MAX_DECODED_CHUNK_BYTES // (1024 * 1024)} MiB decoded-chunk guard. "
                "The plane was not read. Re-export the IMS with bounded chunk geometry."
            )
    return data


def _channel_groups(timepoint: h5py.Group) -> list[tuple[int, h5py.Group]]:
    channels = _numbered_children(timepoint, "Channel")
    if not channels or channels[0][0] != 0:
        raise UnsupportedImarisError("The IMS dataset does not contain Channel 0.")
    expected = list(range(len(channels)))
    if [index for index, _group in channels] != expected:
        raise UnsupportedImarisError("The IMS channel indices are not contiguous.")
    if len(channels) > IMS_MAX_OVERVIEW_CHANNELS:
        raise UnsupportedImarisError(
            f"This IMS declares {len(channels)} channels, above Loci's current "
            f"{IMS_MAX_OVERVIEW_CHANNELS}-channel overview guard."
        )
    return channels


def _channel_dtypes(channels: list[tuple[int, h5py.Group]]) -> tuple[str, ...]:
    return tuple(str(_local_numeric_dataset(channel).dtype) for _index, channel in channels)


def _level_geometry(level_index: int, level_group: h5py.Group) -> _Level:
    timepoints = _numbered_children(level_group, "TimePoint")
    if not timepoints or timepoints[0][0] != 0:
        raise UnsupportedImarisError(f"IMS resolution level {level_index} has no TimePoint 0.")
    if [index for index, _group in timepoints] != list(range(len(timepoints))):
        raise UnsupportedImarisError(
            f"IMS timepoint indices are not contiguous at resolution level {level_index}."
        )
    channels = _channel_groups(timepoints[0][1])
    data = _local_numeric_dataset(channels[0][1])
    if data.ndim != 3:
        raise UnsupportedImarisError("IMS channel data must use the documented Z, Y, X layout.")
    depth = _attribute_int(channels[0][1], "ImageSizeZ", int(data.shape[0]))
    height = _attribute_int(channels[0][1], "ImageSizeY", int(data.shape[1]))
    width = _attribute_int(channels[0][1], "ImageSizeX", int(data.shape[2]))
    if depth > data.shape[0] or height > data.shape[1] or width > data.shape[2]:
        raise UnsupportedImarisError("IMS declared dimensions exceed the stored channel dataset.")
    return _Level(level_index, width, height, depth, level_group)


def _channel_name(info: h5py.Group | None, index: int) -> str:
    if info is None or "Name" not in info.attrs:
        return f"Channel {index + 1}"
    name = _attribute_text(info.attrs["Name"]).strip()
    if not name or name.casefold() == "(name not specified)":
        return f"Channel {index + 1}"
    return name[:160]


_KNOWN_FLUOROPHORES: tuple[tuple[tuple[str, ...], tuple[float, float, float]], ...] = (
    (("dapi", "hoechst", "blue"), (0.0, 0.45, 1.0)),
    (("gfp", "fitc", "alexa 488", "alexa488", "cy2", "green", "egfp", "fam"), (0.1, 0.9, 0.2)),
    (
        (
            "tritc",
            "rfp",
            "cy3",
            "alexa 555",
            "alexa555",
            "alexa 568",
            "alexa568",
            "alexa 594",
            "alexa594",
            "mcherry",
            "texas red",
            "red",
        ),
        (1.0, 0.2, 0.1),
    ),
    (("cy5", "alexa 647", "alexa647", "draq5", "far-red", "far red", "magenta"), (0.9, 0.2, 0.8)),
    (("cyan", "cfp"), (0.0, 0.9, 0.9)),
    (("yellow", "yfp"), (1.0, 0.9, 0.1)),
)


def _color_from_table(dataset: Any) -> tuple[float, float, float] | None:
    if not isinstance(dataset, h5py.Dataset):
        return None
    try:
        raw = np.asarray(dataset)
        if raw.dtype.kind == "S":
            text = b"".join(bytes(x) for x in raw.reshape(-1)).decode("utf-8", errors="replace")
        elif raw.dtype.kind == "U":
            text = "".join(str(x) for x in raw.reshape(-1))
        elif raw.size > 0 and isinstance(raw.item(0) if raw.size == 1 else raw[0], (bytes, str)):
            text = " ".join(str(x) for x in raw.reshape(-1))
        else:
            return None
        parts = text.strip().split()
        if len(parts) >= 3 and len(parts) % 3 == 0:
            r = float(parts[-3])
            g = float(parts[-2])
            b = float(parts[-1])
            if all(math.isfinite(v) and 0.0 <= v <= 1.0 for v in (r, g, b)):
                peak = max(r, g, b)
                if peak > 0.0:
                    return (r / peak, g / peak, b / peak)
    except Exception:
        return None
    return None


def _fluorophore_color_from_name(name: str) -> tuple[float, float, float] | None:
    cleaned = re.sub(r"[^a-z0-9 ]+", " ", name.casefold()).strip()
    for triggers, color in _KNOWN_FLUOROPHORES:
        for trigger in triggers:
            if re.search(rf"\b{re.escape(trigger)}\b", cleaned):
                return color
    return None


def _channel_color(
    info: h5py.Group | None,
    index: int,
) -> tuple[tuple[float, float, float], str]:
    color_mode = (
        _attribute_text(info.attrs["ColorMode"]).strip().casefold()
        if info is not None and "ColorMode" in info.attrs
        else ""
    )
    if info is not None and "Color" in info.attrs and color_mode in {"", "basecolor"}:
        try:
            values = tuple(float(value) for value in _attribute_text(info.attrs["Color"]).split())
        except ValueError:
            values = ()
        if len(values) == 3 and all(math.isfinite(value) and 0 <= value <= 1 for value in values):
            return values, "declared-base-colour"
    if info is not None and "ColorTable" in info:
        table_color = _color_from_table(info.get("ColorTable"))
        if table_color is not None:
            return table_color, "declared-table-colour"
    if info is not None and "Name" in info.attrs:
        name_color = _fluorophore_color_from_name(_attribute_text(info.attrs["Name"]))
        if name_color is not None:
            return name_color, "declared-channel-name"
    return _DEFAULT_CHANNEL_COLORS[index % len(_DEFAULT_CHANNEL_COLORS)], "loci-fallback-colour"


def _physical_geometry(
    info_root: h5py.Group | None,
    level: _Level,
) -> tuple[
    tuple[tuple[float, float], ...] | None,
    tuple[float, float, float] | None,
    str | None,
]:
    image_info = _local_child(info_root, "Image") if isinstance(info_root, h5py.Group) else None
    if not isinstance(image_info, h5py.Group):
        return None, None, None
    extents: list[tuple[float, float]] = []
    spans: list[float] = []
    for axis in range(3):
        lower = _attribute_float(image_info, f"ExtMin{axis}")
        upper = _attribute_float(image_info, f"ExtMax{axis}")
        if lower is None or upper is None or upper <= lower:
            return None, None, None
        span = upper - lower
        if not math.isfinite(span) or span <= 0:
            return None, None, None
        extents.append((lower, upper))
        spans.append(span)
    dimensions = (level.width, level.height, level.depth)
    voxel_size = tuple(
        span / dimension for span, dimension in zip(spans, dimensions, strict=True)
    )
    if not all(math.isfinite(value) and value > 0 for value in voxel_size):
        return None, None, None
    unit = None
    for name in ("Unit", "PhysicalUnit"):
        if name in image_info.attrs:
            candidate = _attribute_text(image_info.attrs[name]).strip()
            if candidate:
                unit = candidate[:40]
                break
    return tuple(extents), voxel_size, unit


def _read_plane(
    channel: h5py.Group,
    *,
    z_index: int,
    width: int,
    height: int,
    stride: int,
) -> np.ndarray:
    data = _local_numeric_dataset(channel)
    if data.ndim != 3:
        raise UnsupportedImarisError("Every IMS channel must contain a 3D Data dataset.")
    if z_index >= data.shape[0] or height > data.shape[1] or width > data.shape[2]:
        raise UnsupportedImarisError("IMS channel geometry is inconsistent across channels.")
    return np.asarray(data[z_index, :height:stride, :width:stride])


def _normalise_plane(plane: np.ndarray, channel: h5py.Group) -> tuple[np.ndarray, str]:
    lower = _attribute_float(channel, "HistogramMin")
    upper = _attribute_float(channel, "HistogramMax")
    if lower is None or upper is None or upper <= lower:
        lower, upper = _display_bounds(plane)
        range_source = "bounded-sampled-display-range"
    else:
        range_source = "stored-histogram-range"
    if upper <= lower:
        return np.zeros(plane.shape, dtype=np.float32), range_source
    return _display_float(plane, display_bounds=(lower, upper)), range_source


def _read_composite(
    channels: list[tuple[int, h5py.Group]],
    infos: list[h5py.Group | None],
    colors: list[tuple[float, float, float]],
    *,
    z_index: int,
    width: int,
    height: int,
    stride: int,
) -> tuple[np.ndarray, str, tuple[str, ...]]:
    if len(channels) == 1:
        return (
            _read_plane(
                channels[0][1],
                z_index=z_index,
                width=width,
                height=height,
                stride=stride,
            ),
            "single-channel",
            ("native-channel-values",),
        )

    output_shape = (math.ceil(height / stride), math.ceil(width / stride), 3)
    composite = np.zeros(output_shape, dtype=np.float32)
    range_sources: list[str] = []
    for (_index, channel), _info, color in zip(channels, infos, colors, strict=True):
        plane = _read_plane(
            channel,
            z_index=z_index,
            width=width,
            height=height,
            stride=stride,
        )
        normalized, range_source = _normalise_plane(plane, channel)
        range_sources.append(range_source)
        composite += normalized[..., np.newaxis] * np.asarray(color, dtype=np.float32)
    # This is deliberately a Loci-generated overview rather than a recreation of
    # the saved Imaris display. HistogramMin/Max describe the stored histogram;
    # Imaris ColorRange, ColorOpacity, gamma, and table-colour state belong to a
    # later interactive-channel milestone. Keep that provenance explicit.
    return (
        np.asarray(np.rint(np.clip(composite, 0, 1) * 255), dtype=np.uint8),
        "loci-overview-composite",
        tuple(range_sources),
    )


def load_ims_overview(path: Path) -> tuple[np.ndarray, SourceVolumeMetadata]:
    """Read one bounded central-Z overview from a modern Imaris 5.5+ file."""

    if not is_hdf5_file(path):
        raise UnsupportedImarisError(
            "This .ims file is not a modern HDF5-backed Imaris 5.5+ dataset. "
            "Older IMS variants are not supported yet."
        )
    try:
        with h5py.File(path, "r") as ims:
            marker = _attribute_text(ims.attrs.get("ImarisDataSet", ""))
            dataset_root = _local_child(ims, "DataSet")
            if marker != "ImarisDataSet" or not isinstance(dataset_root, h5py.Group):
                raise UnsupportedImarisError(
                    "This HDF5 file does not declare the modern Imaris dataset layout."
                )
            level_groups = _numbered_children(dataset_root, "ResolutionLevel")
            if not level_groups or level_groups[0][0] != 0:
                raise UnsupportedImarisError("The IMS dataset has no ResolutionLevel 0.")
            if [index for index, _group in level_groups] != list(range(len(level_groups))):
                raise UnsupportedImarisError("IMS resolution-level indices are not contiguous.")
            levels = [_level_geometry(index, group) for index, group in level_groups]
            candidates = [
                level for level in levels if max(level.width, level.height) <= IMS_OVERVIEW_MAX_EDGE
            ]
            selected = candidates[0] if candidates else levels[-1]
            stride = max(1, math.ceil(max(selected.width, selected.height) / IMS_OVERVIEW_MAX_EDGE))

            selected_timepoints = _numbered_children(selected.group, "TimePoint")
            selected_timepoint = selected_timepoints[0][1]
            channels = _channel_groups(selected_timepoint)
            highest_timepoints = _numbered_children(levels[0].group, "TimePoint")
            highest_channels = _channel_groups(highest_timepoints[0][1])
            if len(channels) != len(highest_channels):
                raise UnsupportedImarisError("IMS channel count differs between resolution levels.")

            info_root = _local_child(ims, "DataSetInfo")
            infos: list[h5py.Group | None] = []
            for index, _channel in channels:
                candidate = (
                    _local_child(info_root, f"Channel {index}")
                    if isinstance(info_root, h5py.Group)
                    else None
                )
                infos.append(candidate if isinstance(candidate, h5py.Group) else None)
            color_records = [_channel_color(info, index) for index, info in enumerate(infos)]
            colors = [color for color, _source in color_records]
            color_sources = tuple(source for _color, source in color_records)
            names = tuple(_channel_name(info, index) for index, info in enumerate(infos))
            channel_dtypes = _channel_dtypes(highest_channels)
            selected_z = selected.depth // 2
            image, composite_mode, range_sources = _read_composite(
                channels,
                infos,
                colors,
                z_index=selected_z,
                width=selected.width,
                height=selected.height,
                stride=stride,
            )
            physical_extents, voxel_size, physical_unit = _physical_geometry(
                info_root if isinstance(info_root, h5py.Group) else None,
                levels[0],
            )
            volume = SourceVolumeMetadata(
                width=levels[0].width,
                height=levels[0].height,
                depth=levels[0].depth,
                channels=len(highest_channels),
                timepoints=len(highest_timepoints),
                resolution_levels=len(levels),
                selected_resolution_level=selected.index,
                selected_level_width=selected.width,
                selected_level_height=selected.height,
                selected_level_depth=selected.depth,
                selected_timepoint=0,
                selected_z=selected_z,
                sampling_stride=stride,
                channel_names=names,
                channel_dtypes=channel_dtypes,
                channel_color_sources=color_sources,
                channel_range_sources=range_sources,
                composite_mode=composite_mode,
                rendered_dtype=str(image.dtype),
                physical_extents=physical_extents,
                voxel_size=voxel_size,
                physical_unit=physical_unit,
            )
            return image, volume
    except OSError as exc:
        raise UnsupportedImarisError("Loci could not read this IMS container safely.") from exc
