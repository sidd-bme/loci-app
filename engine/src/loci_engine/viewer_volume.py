"""Bounded whole-extent volume payloads for the isolated desktop renderer.

The payload is display state: source values are sampled without modifying the
source, and every spatial mapping remains explicit.  A context overview always
covers the complete selected native pyramid level.  An optional level-zero
focus brick is returned beside that context and never replaces it.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import math
from collections.abc import Sequence
from dataclasses import replace
from typing import Any

import numpy as np

from .native_image import NativeImageMetadata, NativeSelection
from .quantitative import Geometry
from .viewer_display import ResolvedChannelDisplay, resolve_display_defaults

DEFAULT_VOLUME_TARGET = 128
MAX_VOLUME_TARGET = 256
DEFAULT_VOLUME_BUDGET_BYTES = 128 * 1024 * 1024
MAX_VOLUME_BUDGET_BYTES = 128 * 1024 * 1024
MAX_VOLUME_CHANNELS = 4
MAX_PLANE_READ_BYTES = 64 * 1024 * 1024
AUTO_RANGE_HISTOGRAM_BINS = 2048


class ViewerVolumeError(ValueError):
    """Raised before an unsafe or spatially ambiguous renderer payload is returned."""


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ViewerVolumeError(f"{name} must be an integer between {low} and {high}.")
    return value


def _channels(value: Sequence[int] | None, count: int) -> tuple[int, ...]:
    selected = tuple(range(min(count, MAX_VOLUME_CHANNELS))) if value is None else tuple(value)
    if not 1 <= len(selected) <= MAX_VOLUME_CHANNELS:
        raise ViewerVolumeError("A volume requires one to four explicit scalar channels.")
    if any(
        isinstance(channel, bool)
        or not isinstance(channel, int)
        or not 0 <= channel < count
        for channel in selected
    ):
        raise ViewerVolumeError("A selected volume channel is outside the source.")
    if len(set(selected)) != len(selected):
        raise ViewerVolumeError("Selected volume channels must be unique.")
    return selected


def _output_dtype(dtype_names: Sequence[str]) -> tuple[np.dtype[Any], str, str]:
    try:
        dtypes = tuple(np.dtype(name) for name in dtype_names)
    except TypeError as exc:
        raise ViewerVolumeError("A selected channel has an invalid scalar dtype.") from exc
    if any(dtype.kind not in "buif" or dtype.itemsize > 8 for dtype in dtypes):
        raise ViewerVolumeError("Volume rendering supports finite real scalar source values only.")
    common = np.result_type(*dtypes)
    direct = {
        ("u", 1): (np.dtype("u1"), "uint8"),
        ("i", 1): (np.dtype("i1"), "int8"),
        ("u", 2): (np.dtype("<u2"), "uint16"),
        ("i", 2): (np.dtype("<i2"), "int16"),
        ("u", 4): (np.dtype("<u4"), "uint32"),
        ("i", 4): (np.dtype("<i4"), "int32"),
        ("f", 4): (np.dtype("<f4"), "float32"),
    }
    if common.kind == "b":
        return np.dtype("u1"), "uint8", "boolean-to-uint8-display-cast"
    if (common.kind, common.itemsize) in direct:
        dtype, name = direct[(common.kind, common.itemsize)]
        return dtype, name, "native-common-dtype"
    return np.dtype("<f4"), "float32", "float32-display-cast"


def _scaled_shape(shape_xyz: tuple[int, int, int], target: int) -> tuple[int, int, int]:
    longest = max(shape_xyz)
    if longest <= target:
        return shape_xyz
    return tuple(
        min(length, max(2 if length >= 2 else 1, round(length * target / longest)))
        for length in shape_xyz
    )  # type: ignore[return-value]


def _aggregate_bytes(shape_xyz: tuple[int, int, int], components: int, itemsize: int) -> int:
    scalar_bytes = math.prod(shape_xyz) * components * itemsize
    # Interleaved CPU array + base64 text + decoded JS array + GPU texture.
    return math.ceil(scalar_bytes * (3 + 4 / 3))


def _fit_shape(
    source_shape_xyz: tuple[int, int, int], target: int, components: int, itemsize: int, budget: int
) -> tuple[int, int, int]:
    candidate = _scaled_shape(source_shape_xyz, target)
    while _aggregate_bytes(candidate, components, itemsize) > budget and max(candidate) > 16:
        target = max(16, target - 8)
        candidate = _scaled_shape(source_shape_xyz, target)
    if _aggregate_bytes(candidate, components, itemsize) > budget:
        raise ViewerVolumeError(
            "The smallest supported whole-volume overview exceeds the renderer memory budget."
        )
    return candidate


def _indices(length: int, output: int) -> np.ndarray:
    if output == length:
        return np.arange(length, dtype=np.int64)
    return np.rint(np.linspace(0, length - 1, output)).astype(np.int64)


def _decompose_geometry(
    geometry: Geometry,
    source_shape_xyz: tuple[int, int, int],
    output_shape_xyz: tuple[int, int, int],
) -> tuple[list[float], list[float], list[float], list[list[float]]]:
    affine = np.asarray(geometry.affine, dtype=np.float64)
    basis = affine[:3, :3]
    source_spacing = np.linalg.norm(basis, axis=0)
    if not np.isfinite(affine).all() or np.any(source_spacing <= 0):
        raise ViewerVolumeError("Volume geometry must be finite and invertible.")
    direction = basis / source_spacing
    if not np.allclose(direction.T @ direction, np.eye(3), atol=1e-7, rtol=0):
        raise ViewerVolumeError(
            "The source uses sheared voxel geometry, which this renderer cannot "
            "represent faithfully."
        )
    scale = np.ones(3, dtype=np.float64)
    for axis, (source, output) in enumerate(zip(source_shape_xyz, output_shape_xyz, strict=True)):
        if source > 1 and output > 1:
            scale[axis] = (source - 1) / (output - 1)
    output_basis = basis @ np.diag(scale)
    spacing = np.linalg.norm(output_basis, axis=0)
    output_direction = output_basis / spacing
    output_affine = affine.copy()
    output_affine[:3, :3] = output_basis
    return (
        [float(value) for value in affine[:3, 3]],
        [float(value) for value in spacing],
        # vtk.js/gl-matrix consumes a column-major mat3.
        [float(value) for value in output_direction.T.reshape(-1)],
        [[float(value) for value in row] for row in output_affine],
    )


def _component_record(display: ResolvedChannelDisplay, name: str) -> dict[str, Any]:
    return {
        "channel_index": display.channel,
        "name": name,
        "color_rgb": list(display.color_rgb),
        "window": {"low": display.low, "high": display.high, "gamma": display.gamma},
        "opacity": display.opacity,
        "visible": display.visible,
        "opacity_points": [[display.low, 0.0], [display.high, display.opacity]],
        "provenance": {
            "range": display.range_basis,
            "gamma": display.gamma_basis,
            "color": display.color_basis,
            "opacity": display.opacity_basis,
            "visibility": display.visibility_basis,
        },
    }


def _bounded_context_display(
    display: ResolvedChannelDisplay, component_values: np.ndarray
) -> ResolvedChannelDisplay:
    """Use acquisition range metadata, otherwise derive a bounded robust range."""

    if display.range_basis not in {"native-dtype-range", "unit-range-fallback"}:
        return display
    observed_low = float(np.min(component_values))
    observed_high = float(np.max(component_values))
    if not math.isfinite(observed_low) or not math.isfinite(observed_high):
        raise ViewerVolumeError("A selected volume channel contains non-finite values.")
    if observed_high <= observed_low:
        return display
    if component_values.size < 256:
        return replace(
            display,
            low=observed_low,
            high=observed_high,
            range_basis="bounded-context-min-max",
        )
    histogram, edges = np.histogram(
        component_values,
        bins=AUTO_RANGE_HISTOGRAM_BINS,
        range=(observed_low, observed_high),
    )
    cumulative = np.cumsum(histogram, dtype=np.int64)
    lower_count = max(1, math.ceil(component_values.size * 0.01))
    upper_count = max(lower_count + 1, math.ceil(component_values.size * 0.99))
    lower_bin = min(
        int(np.searchsorted(cumulative, lower_count, side="left")),
        len(edges) - 2,
    )
    upper_bin = min(
        int(np.searchsorted(cumulative, upper_count, side="left")),
        len(edges) - 2,
    )
    robust_low = float(edges[lower_bin])
    robust_high = float(edges[upper_bin + 1])
    if not math.isfinite(robust_low) or not math.isfinite(robust_high) or robust_high <= robust_low:
        robust_low, robust_high = observed_low, observed_high
        basis = "bounded-context-min-max"
    else:
        basis = "bounded-context-histogram-p1-p99-2048bins"
    return replace(display, low=robust_low, high=robust_high, range_basis=basis)


def _selected_displays(
    metadata: NativeImageMetadata,
    channels: tuple[int, ...],
    *,
    explicit_channel_selection: bool,
) -> tuple[ResolvedChannelDisplay, ...]:
    if metadata.dimensions.c <= 16:
        resolved = {item.channel: item for item in resolve_display_defaults(metadata)}
        selected = tuple(resolved[channel] for channel in channels)
        if explicit_channel_selection:
            selected = tuple(
                replace(
                    display,
                    visible=True,
                    visibility_basis="explicit-volume-channel-selection",
                )
                for display in selected
            )
        return selected
    remap = {channel: index for index, channel in enumerate(channels)}
    acquisition = tuple(
        replace(record, channel=remap[record.channel])
        for record in metadata.acquisition_display
        if record.channel in remap
    )
    selected_metadata = replace(
        metadata,
        dimensions=replace(metadata.dimensions, c=len(channels)),
        channel_names=tuple(metadata.channel_names[channel] for channel in channels),
        channel_dtypes=tuple(metadata.channel_dtypes[channel] for channel in channels),
        acquisition_display=acquisition,
    )
    selected = tuple(
        replace(display, channel=channels[display.channel])
        for display in resolve_display_defaults(selected_metadata)
    )
    if explicit_channel_selection:
        selected = tuple(
            replace(
                display,
                visible=True,
                visibility_basis="explicit-volume-channel-selection",
            )
            for display in selected
        )
    return selected


def _select_level(metadata: NativeImageMetadata, target: int) -> int:
    candidates = [level for level in metadata.levels if level.dimensions.z >= 2]
    if not candidates:
        raise ViewerVolumeError("Raw 3D rendering requires at least two source Z planes.")
    return min(
        candidates,
        key=lambda level: (
            abs(math.log(max(level.dimensions.x, level.dimensions.y, level.dimensions.z) / target)),
            -level.index,
        ),
    ).index


def _native_block(
    session: Any,
    *,
    source_id: str,
    t: int,
    channels: tuple[int, ...],
    level: int,
    extent_xyzxyz: tuple[int, int, int, int, int, int],
    target: int,
    budget: int,
    role: str,
    explicit_channel_selection: bool,
) -> dict[str, Any]:
    metadata: NativeImageMetadata = session.metadata
    level_dimensions = metadata.levels[level].dimensions
    x0, x1, y0, y1, z0, z1 = extent_xyzxyz
    source_shape_xyz = (x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1)
    dtype, scalar_type, encoding_basis = _output_dtype(
        [metadata.channel_dtypes[channel] for channel in channels]
    )
    tile_budget = min(MAX_PLANE_READ_BYTES, max(64 * 1024, budget // 8))
    output_shape_xyz = _fit_shape(
        source_shape_xyz, target, len(channels), dtype.itemsize, budget - tile_budget
    )
    x_indices = _indices(source_shape_xyz[0], output_shape_xyz[0]) + x0
    y_indices = _indices(source_shape_xyz[1], output_shape_xyz[1]) + y0
    z_indices = _indices(source_shape_xyz[2], output_shape_xyz[2]) + z0
    values = np.empty(
        (output_shape_xyz[2], output_shape_xyz[1], output_shape_xyz[0], len(channels)),
        dtype=dtype,
    )
    peak_source_read_bytes = 0
    source_read_count = 0
    for component, channel in enumerate(channels):
        source_itemsize = np.dtype(metadata.channel_dtypes[channel]).itemsize
        maximum_width = max(1, tile_budget // source_itemsize)
        x_groups: list[tuple[int, int, np.ndarray]] = []
        group_start = 0
        while group_start < len(x_indices):
            group_stop = group_start + 1
            while (
                group_stop < len(x_indices)
                and int(x_indices[group_stop] - x_indices[group_start] + 1) <= maximum_width
            ):
                group_stop += 1
            x_groups.append(
                (
                    int(x_indices[group_start]),
                    int(x_indices[group_stop - 1]),
                    np.arange(group_start, group_stop, dtype=np.int64),
                )
            )
            group_start = group_stop
        for output_z, source_z in enumerate(z_indices):
            for read_x0, read_x1, output_x_positions in x_groups:
                read_width = read_x1 - read_x0 + 1
                maximum_height = max(1, tile_budget // (read_width * source_itemsize))
                y_groups: list[tuple[int, int, np.ndarray]] = []
                group_start = 0
                while group_start < len(y_indices):
                    group_stop = group_start + 1
                    while (
                        group_stop < len(y_indices)
                        and int(y_indices[group_stop] - y_indices[group_start] + 1)
                        <= maximum_height
                    ):
                        group_stop += 1
                    y_groups.append(
                        (
                            int(y_indices[group_start]),
                            int(y_indices[group_stop - 1]),
                            np.arange(group_start, group_stop, dtype=np.int64),
                        )
                    )
                    group_start = group_stop
                for read_y0, read_y1, output_y_positions in y_groups:
                    region = session.read_region(
                        NativeSelection(
                            x=read_x0,
                            y=read_y0,
                            width=read_width,
                            height=read_y1 - read_y0 + 1,
                            t=t,
                            c=channel,
                            z=int(source_z),
                            level=level,
                            series=metadata.selected_series,
                            budget_bytes=tile_budget,
                            expected_sha256=metadata.sha256,
                        )
                    )
                    source_read_count += 1
                    peak_source_read_bytes = max(
                        peak_source_read_bytes, region.estimated_peak_bytes, region.pixels.nbytes
                    )
                    tile = np.asarray(region.pixels)
                    expected_shape = (read_y1 - read_y0 + 1, read_width)
                    if tile.ndim != 2 or tile.shape != expected_shape:
                        raise ViewerVolumeError(
                            "The native reader returned an inconsistent scalar tile."
                        )
                    x_offsets = x_indices[output_x_positions] - read_x0
                    y_offsets = y_indices[output_y_positions] - read_y0
                    sampled = tile[np.ix_(y_offsets, x_offsets)]
                    if sampled.dtype.kind == "f" and not np.isfinite(sampled).all():
                        raise ViewerVolumeError(
                            "A selected volume channel contains non-finite values."
                        )
                    converted = sampled.astype(dtype, copy=False)
                    if dtype == np.dtype("<f4") and not np.isfinite(converted).all():
                        raise ViewerVolumeError(
                            "A display cast would create non-finite voxel values."
                        )
                    output_plane = values[output_z, :, :, component]
                    output_plane[np.ix_(output_y_positions, output_x_positions)] = converted

    selection = {"level": level, "x": x0, "y": y0, "z": z0}
    geometry = session.geometry(selection, True)
    origin, spacing, direction, affine = _decompose_geometry(
        geometry, source_shape_xyz, output_shape_xyz
    )
    # Acquisition settings and dtype fallbacks are stable across LOD/focus requests.
    resolved = tuple(
        _bounded_context_display(display, values[..., component])
        for component, display in enumerate(
            _selected_displays(
                metadata,
                channels,
                explicit_channel_selection=explicit_channel_selection,
            )
        )
    )
    resolved_by_channel = {display.channel: display for display in resolved}
    encoded_bytes = values.tobytes(order="C")
    digest = hashlib.sha256(encoded_bytes).hexdigest()
    native_shape = (level_dimensions.x, level_dimensions.y, level_dimensions.z)
    level_zero = metadata.levels[0].dimensions
    level_zero_shape = (level_zero.x, level_zero.y, level_zero.z)
    level_zero_indices = []
    for sampled, level_length, full_length in zip(
        (x_indices, y_indices, z_indices), native_shape, level_zero_shape, strict=True
    ):
        if level_length <= 1 or full_length <= 1:
            level_zero_indices.append(np.zeros_like(sampled))
        else:
            level_zero_indices.append(
                np.rint(sampled * (full_length - 1) / (level_length - 1)).astype(np.int64)
            )
    return {
        "schema_version": 1,
        "role": role,
        "source_id": source_id,
        "source_sha256": metadata.sha256,
        "t": t,
        "level": level,
        "dimensions_xyz": list(output_shape_xyz),
        "native_level_dimensions_xyz": list(native_shape),
        "source_dimensions_xyz": list(level_zero_shape),
        "source_extent_xyzxyz": list(extent_xyzxyz),
        "origin_xyz": origin,
        "spacing_xyz": spacing,
        "direction_3x3": direction,
        "affine_4x4": affine,
        "unit": geometry.unit,
        "frame": geometry.frame,
        "scalar_type": scalar_type,
        "source_dtypes": [metadata.channel_dtypes[channel] for channel in channels],
        "encoding_basis": encoding_basis,
        "interleave": "voxel-major",
        "components": [
            _component_record(
                resolved_by_channel[channel],
                metadata.channel_names[channel]
                if channel < len(metadata.channel_names)
                else f"Channel {channel + 1}",
            )
            for channel in channels
        ],
        "data_base64": base64.b64encode(encoded_bytes).decode("ascii"),
        "data_sha256": digest,
        "byte_length": len(encoded_bytes),
        "sampling": {
            "method": "nearest-whole-extent",
            "source_indices_xyz": [
                x_indices.tolist(),
                y_indices.tolist(),
                z_indices.tolist(),
            ],
            "level_zero_indices_xyz": [values.tolist() for values in level_zero_indices],
            "aggregate_budget_bytes": budget,
            "estimated_aggregate_bytes": _aggregate_bytes(
                output_shape_xyz, len(channels), dtype.itemsize
            ) + peak_source_read_bytes,
            "peak_source_read_bytes": peak_source_read_bytes,
            "source_read_count": source_read_count,
        },
    }


def build_volume_payload(
    session: Any,
    *,
    source_id: str,
    t: int = 0,
    channel_indices: Sequence[int] | None = None,
    target_long_axis: int = DEFAULT_VOLUME_TARGET,
    max_decoded_bytes: int = DEFAULT_VOLUME_BUDGET_BYTES,
    focus_region_xyzxyz: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Build a bounded context payload and optional level-zero focus brick."""

    metadata = session.metadata
    if not isinstance(metadata, NativeImageMetadata):
        raise ViewerVolumeError("The native volume session metadata is invalid.")
    if metadata.sample_semantics != "none" or metadata.dimensions.s != 1:
        raise ViewerVolumeError("Interleaved RGB samples are not scalar biological channels.")
    target = _integer(target_long_axis, "target_long_axis", 16, MAX_VOLUME_TARGET)
    budget = _integer(
        max_decoded_bytes, "max_decoded_bytes", 1024 * 1024, MAX_VOLUME_BUDGET_BYTES
    )
    selected_channels = _channels(channel_indices, metadata.dimensions.c)
    selected_t = _integer(t, "t", 0, metadata.dimensions.t - 1)
    level = _select_level(metadata, target)
    dimensions = metadata.levels[level].dimensions
    block_budget = budget // 2 if focus_region_xyzxyz is not None else budget
    context = _native_block(
        session,
        source_id=source_id,
        t=selected_t,
        channels=selected_channels,
        level=level,
        extent_xyzxyz=(0, dimensions.x - 1, 0, dimensions.y - 1, 0, dimensions.z - 1),
        target=target,
        budget=block_budget,
        role="whole-volume-context",
        explicit_channel_selection=channel_indices is not None,
    )
    context["refinement"] = {
        "available": level > 0 or context["dimensions_xyz"] != list(
            (dimensions.x, dimensions.y, dimensions.z)
        ),
        "maximum_target_long_axis": MAX_VOLUME_TARGET,
        "focus_supported": metadata.levels[0].dimensions.z >= 2,
    }

    focus = None
    if focus_region_xyzxyz is not None:
        if not isinstance(focus_region_xyzxyz, Sequence) or len(focus_region_xyzxyz) != 6:
            raise ViewerVolumeError("focus_region_xyzxyz must contain six inclusive indices.")
        focus_extent = tuple(focus_region_xyzxyz)
        if any(isinstance(value, bool) or not isinstance(value, int) for value in focus_extent):
            raise ViewerVolumeError("Focus-region indices must be integers.")
        full = metadata.levels[0].dimensions
        x0, x1, y0, y1, z0, z1 = focus_extent
        if not (0 <= x0 <= x1 < full.x and 0 <= y0 <= y1 < full.y and 0 <= z0 < z1 < full.z):
            raise ViewerVolumeError("The focus region must be a nonempty level-zero 3D extent.")
        focus = _native_block(
            session,
            source_id=source_id,
            t=selected_t,
            channels=selected_channels,
            level=0,
            extent_xyzxyz=focus_extent,  # type: ignore[arg-type]
            target=target,
            budget=block_budget,
            role="level-zero-focus",
            explicit_channel_selection=channel_indices is not None,
        )
        # Focus is a separate spatial payload but belongs to the context's
        # display session, so it uses the context-derived transfer defaults.
        focus["components"] = copy.deepcopy(context["components"])
    return {"schema_version": 1, "context": context, "focus": focus}


def _medical_display(dtype_name: str) -> dict[str, Any]:
    dtype = np.dtype(dtype_name)
    if dtype.kind in "ui":
        limits = np.iinfo(dtype)
        low, high = float(limits.min), float(limits.max)
        range_basis = "native-dtype-range"
    else:
        low, high = 0.0, 1.0
        range_basis = "unit-range-fallback"
    return {
        "channel_index": 0,
        "name": "Scalar intensity",
        "color_rgb": [1.0, 1.0, 1.0],
        "window": {"low": low, "high": high, "gamma": 1.0},
        "opacity": 1.0,
        "visible": True,
        "opacity_points": [[low, 0.0], [high, 1.0]],
        "provenance": {
            "range": range_basis,
            "gamma": "neutral-gamma-fallback",
            "color": "neutral-grayscale-fallback",
            "opacity": "opaque-fallback",
            "visibility": "single-scalar-channel",
        },
    }


def _medical_block(
    source: Any,
    inspection: Any,
    *,
    source_id: str,
    extent_xyzxyz: tuple[int, int, int, int, int, int],
    target: int,
    budget: int,
    role: str,
    decoded_full: np.ndarray | None,
) -> dict[str, Any]:
    from .medical_image import read_medical

    x0, x1, y0, y1, z0, z1 = extent_xyzxyz
    source_shape_xyz = (x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1)
    dtype, scalar_type, encoding_basis = _output_dtype([inspection.dtype])
    output_shape_xyz = _fit_shape(source_shape_xyz, target, 1, dtype.itemsize, budget)
    x_indices = _indices(source_shape_xyz[0], output_shape_xyz[0]) + x0
    y_indices = _indices(source_shape_xyz[1], output_shape_xyz[1]) + y0
    z_indices = _indices(source_shape_xyz[2], output_shape_xyz[2]) + z0
    values = np.empty(
        (output_shape_xyz[2], output_shape_xyz[1], output_shape_xyz[0], 1), dtype=dtype
    )

    if decoded_full is not None:
        sampled = decoded_full[np.ix_(z_indices, y_indices, x_indices)]
        if sampled.dtype.kind == "f" and not np.isfinite(sampled).all():
            raise ViewerVolumeError("A medical volume contains non-finite values.")
        values[..., 0] = sampled.astype(dtype, copy=False)
    else:
        plane_bytes = (
            source_shape_xyz[0]
            * source_shape_xyz[1]
            * np.dtype(inspection.dtype).itemsize
        )
        if plane_bytes + _aggregate_bytes(output_shape_xyz, 1, dtype.itemsize) > budget:
            raise ViewerVolumeError(
                "A medical source plane and its whole-volume overview exceed the memory budget."
            )
        if inspection.format == "dicom-series":
            raise ViewerVolumeError(
                "This DICOM series requires an eager whole-series decode above the renderer budget."
            )
        for output_z, source_z in enumerate(z_indices):
            volume = read_medical(
                source,
                region=(
                    slice(int(source_z), int(source_z) + 1),
                    slice(y0, y1 + 1),
                    slice(x0, x1 + 1),
                ),
                expected_identity=inspection,
                max_decoded_bytes=max(1, min(MAX_VOLUME_BUDGET_BYTES, budget)),
            )
            plane = np.asarray(volume.array[0])
            if plane.dtype.kind == "f" and not np.isfinite(plane).all():
                raise ViewerVolumeError("A medical volume contains non-finite values.")
            sampled = plane[np.ix_(y_indices - y0, x_indices - x0)]
            values[output_z, :, :, 0] = sampled.astype(dtype, copy=False)

    geometry = inspection.geometry.cropped((z0, y0, x0))
    origin, spacing, direction, affine = _decompose_geometry(
        geometry, source_shape_xyz, output_shape_xyz
    )
    encoded_bytes = values.tobytes(order="C")
    identity = inspection.source_identity
    source_sha256 = identity.removeprefix("sha256:")
    return {
        "schema_version": 1,
        "role": role,
        "source_id": source_id,
        "source_sha256": source_sha256,
        "source_identity": identity,
        "t": 0,
        "level": 0,
        "dimensions_xyz": list(output_shape_xyz),
        "native_level_dimensions_xyz": list(reversed(inspection.shape)),
        "source_dimensions_xyz": list(reversed(inspection.shape)),
        "source_extent_xyzxyz": list(extent_xyzxyz),
        "origin_xyz": origin,
        "spacing_xyz": spacing,
        "direction_3x3": direction,
        "affine_4x4": affine,
        "unit": geometry.unit,
        "frame": geometry.frame,
        "scalar_type": scalar_type,
        "source_dtypes": [inspection.dtype],
        "encoding_basis": encoding_basis,
        "interleave": "voxel-major",
        "components": [_medical_display(inspection.dtype)],
        "data_base64": base64.b64encode(encoded_bytes).decode("ascii"),
        "data_sha256": hashlib.sha256(encoded_bytes).hexdigest(),
        "byte_length": len(encoded_bytes),
        "sampling": {
            "method": "nearest-whole-extent" if role == "whole-volume-context" else "nearest-focus",
            "source_indices_xyz": [x_indices.tolist(), y_indices.tolist(), z_indices.tolist()],
            "level_zero_indices_xyz": [
                x_indices.tolist(),
                y_indices.tolist(),
                z_indices.tolist(),
            ],
            "aggregate_budget_bytes": budget,
            "estimated_aggregate_bytes": _aggregate_bytes(output_shape_xyz, 1, dtype.itemsize),
        },
    }


def build_medical_volume_payload(
    source: Any,
    *,
    source_id: str,
    expected_source_identity: str | None = None,
    target_long_axis: int = DEFAULT_VOLUME_TARGET,
    max_decoded_bytes: int = DEFAULT_VOLUME_BUDGET_BYTES,
    focus_region_xyzxyz: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Build the same bounded contract for NIfTI, NRRD, or an explicit DICOM series."""

    from .medical_image import inspect_medical, read_medical

    target = _integer(target_long_axis, "target_long_axis", 16, MAX_VOLUME_TARGET)
    budget = _integer(
        max_decoded_bytes, "max_decoded_bytes", 1024 * 1024, MAX_VOLUME_BUDGET_BYTES
    )
    inspection = inspect_medical(source)
    if (
        expected_source_identity is not None
        and inspection.source_identity != expected_source_identity
    ):
        raise ViewerVolumeError("The medical source identity changed before volume rendering.")
    if len(inspection.shape) != 3 or inspection.shape[0] < 2:
        raise ViewerVolumeError("Raw 3D rendering requires at least two source Z planes.")
    full_shape_xyz = tuple(reversed(inspection.shape))
    output_dtype, _, _ = _output_dtype([inspection.dtype])
    block_budget = budget // 2 if focus_region_xyzxyz is not None else budget
    context_output_shape = _fit_shape(
        full_shape_xyz, target, 1, output_dtype.itemsize, block_budget
    )
    decoded_full = None
    if (
        inspection.estimated_decoded_bytes
        + _aggregate_bytes(context_output_shape, 1, output_dtype.itemsize)
        <= block_budget
    ):
        decoded_full = np.asarray(
            read_medical(
                source,
                expected_identity=inspection,
                max_decoded_bytes=max(1, inspection.estimated_decoded_bytes),
            ).array
        )
    context = _medical_block(
        source,
        inspection,
        source_id=source_id,
        extent_xyzxyz=(
            0,
            full_shape_xyz[0] - 1,
            0,
            full_shape_xyz[1] - 1,
            0,
            full_shape_xyz[2] - 1,
        ),
        target=target,
        budget=block_budget,
        role="whole-volume-context",
        decoded_full=decoded_full,
    )
    context["refinement"] = {
        "available": context["dimensions_xyz"] != list(full_shape_xyz),
        "maximum_target_long_axis": MAX_VOLUME_TARGET,
        "focus_supported": True,
    }
    focus = None
    if focus_region_xyzxyz is not None:
        if not isinstance(focus_region_xyzxyz, Sequence) or len(focus_region_xyzxyz) != 6:
            raise ViewerVolumeError("focus_region_xyzxyz must contain six inclusive indices.")
        focus_extent = tuple(focus_region_xyzxyz)
        if any(isinstance(value, bool) or not isinstance(value, int) for value in focus_extent):
            raise ViewerVolumeError("Focus-region indices must be integers.")
        x0, x1, y0, y1, z0, z1 = focus_extent
        if not (
            0 <= x0 <= x1 < full_shape_xyz[0]
            and 0 <= y0 <= y1 < full_shape_xyz[1]
            and 0 <= z0 < z1 < full_shape_xyz[2]
        ):
            raise ViewerVolumeError("The focus region must be a nonempty 3D source extent.")
        focus = _medical_block(
            source,
            inspection,
            source_id=source_id,
            extent_xyzxyz=focus_extent,  # type: ignore[arg-type]
            target=target,
            budget=block_budget,
            role="native-detail-focus",
            decoded_full=decoded_full,
        )
    return {"schema_version": 1, "context": context, "focus": focus}
