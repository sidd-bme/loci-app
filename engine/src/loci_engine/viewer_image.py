"""Source-stable defaults and bounded 2D tiles for the desktop image viewport.

The service consumes an already authorized, source-scoped image session.  It
never accepts a filesystem path and never derives display ranges from the
current pan or zoom crop.  Whole-source overviews use a compatible native
pyramid level when one fits; otherwise they sample level zero through bounded
512-pixel source tiles and may cache only the rendered, derived PNG.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import stat
import tempfile
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .native_image import NativeImageMetadata, NativeSelection
from .viewer_display import (
    MAX_DISPLAY_CHANNELS,
    MAX_DISPLAY_PIXELS,
    MAX_DISPLAY_SAMPLE_VALUES,
    ResolvedChannelDisplay,
    ViewerDisplayError,
    render_adjusted_source_rgb,
    render_channel_composite,
    render_source_rgb,
    resolve_display_defaults,
)

MAX_OVERVIEW_EDGE = 1024
SOURCE_TILE_EDGE = 512
MAX_PROJECTION_PLANES = 512
MAX_CACHE_PNG_BYTES = 32 * 1024 * 1024
MAX_VIEWER_WORKING_BYTES = 256 * 1024 * 1024
MAX_OVERVIEW_CACHE_BYTES = 256 * 1024 * 1024
MAX_OVERVIEW_CACHE_FILES = 256
MAX_HISTOGRAM_BINS = 256


class ViewerImageError(ValueError):
    """Raised before an unsafe or ambiguous 2D viewer payload is returned."""


def _exact_keys(value: Mapping[str, Any], allowed: set[str], name: str) -> None:
    unexpected = set(value) - allowed
    if unexpected:
        raise ViewerImageError(f"{name} contains unsupported fields: {sorted(unexpected)}.")


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ViewerImageError(f"{name} must be an integer between {low} and {high}.")
    return value


def _source_id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ViewerImageError("source_id must be non-empty bounded text.")
    return value


def _metadata(session: Any) -> NativeImageMetadata:
    metadata = getattr(session, "metadata", None)
    if not isinstance(metadata, NativeImageMetadata):
        raise ViewerImageError("The viewer session metadata is invalid.")
    if metadata.rgb_color_policy is None:
        raise ViewerImageError("The source does not declare a renderer color policy.")
    return metadata


def _require_working_budget(
    metadata: NativeImageMetadata,
    settings: Sequence[ResolvedChannelDisplay],
    width: int,
    height: int,
    *,
    projection: str | None,
) -> None:
    pixels = width * height
    if metadata.sample_semantics != "none":
        # Decoder RGB(A), transformed/output RGB, PNG encoder input and scratch.
        required = pixels * 32
    else:
        source_bytes = 0
        for setting in settings:
            try:
                dtype = np.dtype(metadata.channel_dtypes[setting.channel])
            except TypeError as exc:
                raise ViewerImageError("A viewer channel dtype is invalid.") from exc
            if dtype.kind not in "buif" or dtype.itemsize > 8:
                raise ViewerImageError("Viewer channels require bounded real native dtypes.")
            source_bytes += pixels * (8 if projection == "mean" else dtype.itemsize)
        # Retained source planes, float64 composite, one float64 normalized
        # channel, uint8 output and bounded PNG encoder scratch.
        required = source_bytes + pixels * (24 + 8 + 3 + 4)
    if required > MAX_VIEWER_WORKING_BYTES:
        raise ViewerImageError(
            "The requested viewer render exceeds its aggregate working-memory budget."
        )


def _png_bytes(array: np.ndarray) -> bytes:
    output = io.BytesIO()
    Image.fromarray(array).save(output, format="PNG", optimize=False)
    encoded = output.getvalue()
    if len(encoded) > MAX_CACHE_PNG_BYTES:
        raise ViewerImageError("The rendered PNG exceeds the bounded viewer payload limit.")
    return encoded


def _data_url(encoded: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(encoded).decode("ascii")


def _scaled_shape(width: int, height: int, max_edge: int) -> tuple[int, int]:
    longest = max(width, height)
    if longest <= max_edge:
        return width, height
    return (
        max(1, round(width * max_edge / longest)),
        max(1, round(height * max_edge / longest)),
    )


def _indices(length: int, output: int) -> np.ndarray:
    if output == length:
        return np.arange(length, dtype=np.int64)
    return np.rint(np.linspace(0, length - 1, output)).astype(np.int64)


def _mapped_z(z: int, source_depth: int, level_depth: int) -> int:
    if source_depth == 1 or level_depth == 1:
        return 0
    return round(z * (level_depth - 1) / (source_depth - 1))


def _mapped_z_range(
    z: int, z_stop: int | None, source_depth: int, level_depth: int
) -> tuple[int, int]:
    if z_stop is None:
        selected = _mapped_z(z, source_depth, level_depth)
        return selected, selected + 1
    start = min(level_depth - 1, math.floor(z * level_depth / source_depth))
    stop = min(level_depth, math.ceil(z_stop * level_depth / source_depth))
    return start, max(start + 1, stop)


def _select_native_overview_level(metadata: NativeImageMetadata, max_edge: int) -> int | None:
    fitting = [
        level
        for level in metadata.levels[1:]
        if max(level.dimensions.x, level.dimensions.y) <= max_edge
    ]
    if not fitting:
        return None
    return min(fitting, key=lambda level: level.index).index


def _validate_t_z(
    metadata: NativeImageMetadata, t_value: Any, z_value: Any, z_stop_value: Any = None
) -> tuple[int, int, int | None]:
    t = _integer(t_value, "t", 0, metadata.dimensions.t - 1)
    z = _integer(z_value, "z", 0, metadata.dimensions.z - 1)
    z_stop = None
    if z_stop_value is not None:
        z_stop = _integer(z_stop_value, "z_stop", z + 1, metadata.dimensions.z)
    return t, z, z_stop


def _projection(value: Any, z_stop: int | None) -> str | None:
    if value is None:
        if z_stop is not None:
            raise ViewerImageError("An explicit Z range requires max or mean projection.")
        return None
    if value not in {"max", "mean"} or z_stop is None:
        raise ViewerImageError("Projection requires an explicit Z range and max or mean method.")
    return value


def _read_plane_or_projection(
    session: Any,
    metadata: NativeImageMetadata,
    *,
    x: int,
    y: int,
    width: int,
    height: int,
    t: int,
    channel: int,
    level: int,
    z_start: int,
    z_stop: int,
    projection: str | None,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    depth = z_stop - z_start
    if not 1 <= depth <= MAX_PROJECTION_PLANES:
        raise ViewerImageError(
            f"A 2D projection is limited to {MAX_PROJECTION_PLANES} source planes."
        )
    aggregate: np.ndarray | None = None
    for offset, z in enumerate(range(z_start, z_stop)):
        if cancellation_check is not None:
            cancellation_check()
        region = session.read_region(
            NativeSelection(
                x=x,
                y=y,
                width=width,
                height=height,
                t=t,
                c=channel,
                z=z,
                level=level,
                series=metadata.selected_series,
                expected_sha256=metadata.sha256,
            )
        )
        plane = np.asarray(region.pixels)
        if plane.ndim != 2 or plane.shape != (height, width) or plane.dtype.kind not in "buif":
            raise ViewerImageError("The native reader returned an inconsistent scalar plane.")
        if plane.dtype.kind == "f" and not np.isfinite(plane).all():
            raise ViewerImageError("A selected viewer plane contains non-finite values.")
        if projection is None:
            return np.array(plane, copy=True, order="C")
        if projection == "max":
            aggregate = (
                np.array(plane, copy=True) if aggregate is None else np.maximum(aggregate, plane)
            )
        else:
            if aggregate is None:
                aggregate = plane.astype(np.float64)
            else:
                aggregate += plane
        if offset + 1 == depth and projection == "mean":
            assert aggregate is not None
            aggregate /= depth
    assert aggregate is not None
    return aggregate


def _sample_scalar_plane(
    session: Any,
    metadata: NativeImageMetadata,
    *,
    channel: int,
    t: int,
    z: int,
    z_stop: int | None,
    projection: str | None,
    output_width: int,
    output_height: int,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    source = metadata.levels[0].dimensions
    x_indices = _indices(source.x, output_width)
    y_indices = _indices(source.y, output_height)
    result: np.ndarray | None = None
    for y0 in range(0, source.y, SOURCE_TILE_EDGE):
        height = min(SOURCE_TILE_EDGE, source.y - y0)
        output_y = np.flatnonzero((y_indices >= y0) & (y_indices < y0 + height))
        if output_y.size == 0:
            continue
        for x0 in range(0, source.x, SOURCE_TILE_EDGE):
            width = min(SOURCE_TILE_EDGE, source.x - x0)
            output_x = np.flatnonzero((x_indices >= x0) & (x_indices < x0 + width))
            if output_x.size == 0:
                continue
            tile = _read_plane_or_projection(
                session,
                metadata,
                x=x0,
                y=y0,
                width=width,
                height=height,
                t=t,
                channel=channel,
                level=0,
                z_start=z,
                z_stop=z_stop or z + 1,
                projection=projection,
                cancellation_check=cancellation_check,
            )
            if result is None:
                result = np.empty((output_height, output_width), dtype=tile.dtype)
            result[np.ix_(output_y, output_x)] = tile[
                np.ix_(y_indices[output_y] - y0, x_indices[output_x] - x0)
            ]
    if result is None:
        raise ViewerImageError("The deterministic overview sample is empty.")
    return result


def _validated_whole_slide_display(region: Any, metadata: NativeImageMetadata) -> np.ndarray:
    pixels = np.asarray(getattr(region, "display_rgb", None))
    policy = metadata.rgb_color_policy
    display_color = getattr(region, "display_color", None)
    if pixels.ndim != 3 or pixels.shape[-1] != 3 or pixels.dtype != np.uint8:
        raise ViewerImageError("The whole-slide reader returned an invalid display RGB region.")
    if policy is None or display_color is None:
        raise ViewerImageError("The whole-slide display color policy is unavailable.")
    for name in (
        "source_status",
        "source_icc_sha256",
        "source_icc_bytes",
        "display_space",
        "transform",
        "rendering_intent",
        "output_icc_sha256",
    ):
        if getattr(display_color, name, object()) != getattr(policy, name):
            raise ViewerImageError("The whole-slide display color policy changed during decoding.")
    return np.array(pixels, copy=True, order="C")


def _read_rgb_display(
    session: Any,
    metadata: NativeImageMetadata,
    selection: NativeSelection,
    *,
    embedded_icc: bytes | None,
    display: ResolvedChannelDisplay | None = None,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    if cancellation_check is not None:
        cancellation_check()
    raw_region = getattr(session, "raw_region", None)
    neutral = display is None or (
        display.low == 0.0 and display.high == 255.0 and display.gamma == 1.0
    )
    if callable(raw_region) and neutral:
        # WholeSlideSession performs its validated source-to-sRGB transform as
        # part of this one bounded decode.  Returning display_rgb here avoids a
        # second ICC transform in the generic native path.
        return _validated_whole_slide_display(raw_region(selection), metadata)
    if callable(raw_region):
        raw = np.asarray(getattr(raw_region(selection), "analysis_rgb", None))
    else:
        raw = np.asarray(session.read_region(selection).pixels)
    return _render_rgb(raw, metadata, embedded_icc=embedded_icc, display=display)


def _sample_rgb_plane(
    session: Any,
    metadata: NativeImageMetadata,
    *,
    t: int,
    z: int,
    output_width: int,
    output_height: int,
    embedded_icc: bytes | None,
    display: ResolvedChannelDisplay | None,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    source = metadata.levels[0].dimensions
    x_indices = _indices(source.x, output_width)
    y_indices = _indices(source.y, output_height)
    result = np.empty((output_height, output_width, 3), dtype=np.uint8)
    wrote = False
    for y0 in range(0, source.y, SOURCE_TILE_EDGE):
        height = min(SOURCE_TILE_EDGE, source.y - y0)
        output_y = np.flatnonzero((y_indices >= y0) & (y_indices < y0 + height))
        if output_y.size == 0:
            continue
        for x0 in range(0, source.x, SOURCE_TILE_EDGE):
            width = min(SOURCE_TILE_EDGE, source.x - x0)
            output_x = np.flatnonzero((x_indices >= x0) & (x_indices < x0 + width))
            if output_x.size == 0:
                continue
            tile = _read_rgb_display(
                session,
                metadata,
                NativeSelection(
                    x=x0,
                    y=y0,
                    width=width,
                    height=height,
                    t=t,
                    c=0,
                    z=z,
                    level=0,
                    series=metadata.selected_series,
                    expected_sha256=metadata.sha256,
                ),
                embedded_icc=embedded_icc,
                display=display,
                cancellation_check=cancellation_check,
            )
            result[np.ix_(output_y, output_x)] = tile[
                np.ix_(y_indices[output_y] - y0, x_indices[output_x] - x0)
            ]
            wrote = True
    if not wrote:
        raise ViewerImageError("The deterministic RGB overview sample is empty.")
    return result


def _native_rgb_overview(
    session: Any,
    metadata: NativeImageMetadata,
    *,
    level: int,
    t: int,
    z: int,
    embedded_icc: bytes | None,
    display: ResolvedChannelDisplay | None,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    dimensions = metadata.levels[level].dimensions
    return _read_rgb_display(
        session,
        metadata,
        NativeSelection(
            x=0,
            y=0,
            width=dimensions.x,
            height=dimensions.y,
            t=t,
            c=0,
            z=_mapped_z(z, metadata.dimensions.z, dimensions.z),
            level=level,
            series=metadata.selected_series,
            expected_sha256=metadata.sha256,
        ),
        embedded_icc=embedded_icc,
        display=display,
        cancellation_check=cancellation_check,
    )


def _native_overview_scalar(
    session: Any,
    metadata: NativeImageMetadata,
    *,
    channel: int,
    level: int,
    t: int,
    z: int,
    z_stop: int | None,
    projection: str | None,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    dimensions = metadata.levels[level].dimensions
    start, stop = _mapped_z_range(z, z_stop, metadata.dimensions.z, dimensions.z)
    return _read_plane_or_projection(
        session,
        metadata,
        x=0,
        y=0,
        width=dimensions.x,
        height=dimensions.y,
        t=t,
        channel=channel,
        level=level,
        z_start=start,
        z_stop=stop,
        projection=projection,
        cancellation_check=cancellation_check,
    )


def _display_payload(settings: Sequence[ResolvedChannelDisplay]) -> list[dict[str, Any]]:
    return [display.as_view_mapping() for display in settings]


def _display_basis(settings: Sequence[ResolvedChannelDisplay]) -> list[dict[str, Any]]:
    return [
        {
            "channel": display.channel,
            "range": display.range_basis,
            "gamma": display.gamma_basis,
            "color": display.color_basis,
            "opacity": display.opacity_basis,
            "visibility": display.visibility_basis,
        }
        for display in settings
    ]


def _revision(metadata: NativeImageMetadata, display: Any, basis: Any) -> str:
    value = {
        "source_sha256": metadata.sha256,
        "display": display,
        "basis": basis,
        "rgb_policy": asdict(metadata.rgb_color_policy) if metadata.rgb_color_policy else None,
    }
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def viewer_defaults(
    session: Any,
    request: Mapping[str, Any],
    *,
    cancellation_check: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Resolve source-stable acquisition or explicit Auto display settings."""

    _exact_keys(request, {"source_id", "t", "z", "auto"}, "viewer_defaults request")
    metadata = _metadata(session)
    source_id = _source_id(request.get("source_id"))
    auto = request.get("auto", False)
    if not isinstance(auto, bool):
        raise ViewerImageError("auto must be boolean.")
    t, z, _ = _validate_t_z(metadata, request.get("t", 0), request.get("z", 0))
    samples: dict[int, np.ndarray] | None = None
    basis: dict[str, Any] = {"mode": "acquisition", "viewport_dependent": False}
    if auto:
        if metadata.sample_semantics != "none":
            level = _select_native_overview_level(metadata, MAX_OVERVIEW_EDGE)
            native_level = (
                level is not None
                and metadata.levels[level].dimensions.x * metadata.levels[level].dimensions.y
                <= MAX_OVERVIEW_EDGE * MAX_OVERVIEW_EDGE
            )
            if native_level:
                assert level is not None
                dimensions = metadata.levels[level].dimensions
                sample = _read_stored_rgb(
                    session,
                    metadata,
                    NativeSelection(
                        x=0,
                        y=0,
                        width=dimensions.x,
                        height=dimensions.y,
                        t=t,
                        c=0,
                        z=_mapped_z(z, metadata.dimensions.z, dimensions.z),
                        level=level,
                        series=metadata.selected_series,
                        expected_sha256=metadata.sha256,
                    ),
                    cancellation_check=cancellation_check,
                )
            else:
                source = metadata.levels[0].dimensions
                width, height = _scaled_shape(source.x, source.y, MAX_OVERVIEW_EDGE)
                sample = _sample_stored_rgb_plane(
                    session,
                    metadata,
                    t=t,
                    z=z,
                    output_width=width,
                    output_height=height,
                    cancellation_check=cancellation_check,
                )
            rgb_components = sample[..., :3]
            p1 = float(np.percentile(rgb_components, 1.0))
            p99 = float(np.percentile(rgb_components, 99.0))
            dtype_max = float(np.iinfo(sample.dtype).max) if sample.dtype.kind in "ui" else 255.0
            if not (0.0 <= p1 < p99 <= dtype_max):
                p1, p99 = 0.0, dtype_max
            channels = [
                {
                    "channel": 0,
                    "low": p1,
                    "high": p99,
                    "gamma": 1.0,
                    "color": "#ffffff",
                    "opacity": 1.0,
                    "visible": True,
                }
            ]
            basis = {
                "mode": "auto",
                "sample": (
                    "deterministic-native-pyramid-level"
                    if native_level
                    else "deterministic-nearest-whole-source"
                ),
                "level": level if native_level else 0,
                "t": t,
                "z": z,
                "viewport_dependent": False,
                "channels": [
                    {
                        "channel": 0,
                        "range": "auto-deterministic-coarse-level-percentiles",
                        "gamma": "neutral-gamma-fallback",
                        "color": "neutral-grayscale-fallback",
                        "opacity": "opaque-fallback",
                        "visibility": "first-channel-neutral-fallback",
                    }
                ],
            }
            return {
                "source_id": source_id,
                "source_sha256": metadata.sha256,
                "channels": channels,
                "basis": basis,
                "display_revision": _revision(metadata, channels, basis),
                "rgb_policy": asdict(metadata.rgb_color_policy)
                if metadata.rgb_color_policy
                else None,
            }
        level = _select_native_overview_level(metadata, MAX_OVERVIEW_EDGE)
        if level is None:
            source = metadata.levels[0].dimensions
            width, height = _scaled_shape(source.x, source.y, MAX_OVERVIEW_EDGE)
            samples = {
                channel: _sample_scalar_plane(
                    session,
                    metadata,
                    channel=channel,
                    t=t,
                    z=z,
                    z_stop=None,
                    projection=None,
                    output_width=width,
                    output_height=height,
                    cancellation_check=cancellation_check,
                )
                for channel in range(metadata.dimensions.c)
            }
            basis = {
                "mode": "auto",
                "sample": "deterministic-nearest-whole-source",
                "level": 0,
                "t": t,
                "z": z,
                "viewport_dependent": False,
            }
        else:
            samples = {
                channel: _native_overview_scalar(
                    session,
                    metadata,
                    channel=channel,
                    level=level,
                    t=t,
                    z=z,
                    z_stop=None,
                    projection=None,
                    cancellation_check=cancellation_check,
                )
                for channel in range(metadata.dimensions.c)
            }
            basis = {
                "mode": "auto",
                "sample": "deterministic-native-pyramid-level",
                "level": level,
                "t": t,
                "z": z,
                "viewport_dependent": False,
            }
    try:
        resolved = resolve_display_defaults(
            metadata,
            auto=auto,
            samples=samples,
            sample_basis="deterministic-coarse-level" if auto else None,
        )
    except ViewerDisplayError as exc:
        raise ViewerImageError(str(exc)) from exc
    channels = _display_payload(resolved)
    basis["channels"] = _display_basis(resolved)
    return {
        "source_id": source_id,
        "source_sha256": metadata.sha256,
        "channels": channels,
        "basis": basis,
        "display_revision": _revision(metadata, channels, basis),
        "rgb_policy": asdict(metadata.rgb_color_policy),
    }


def _read_stored_rgb(
    session: Any,
    metadata: NativeImageMetadata,
    selection: NativeSelection,
    *,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    """Read stored RGB(A), deliberately before the separate display ICC step."""

    if cancellation_check is not None:
        cancellation_check()
    raw_region = getattr(session, "raw_region", None)
    if callable(raw_region):
        pixels = np.asarray(getattr(raw_region(selection), "analysis_rgb", None))
    else:
        pixels = np.asarray(session.read_region(selection).pixels)
    if (
        pixels.ndim != 3
        or pixels.shape[-1] not in {3, 4}
        or pixels.dtype not in {np.dtype(np.uint8), np.dtype(np.uint16)}
    ):
        raise ViewerImageError(
            "The native reader returned invalid stored RGB(A) component samples."
        )
    return np.array(pixels, copy=True, order="C")


def _sample_stored_rgb_plane(
    session: Any,
    metadata: NativeImageMetadata,
    *,
    t: int,
    z: int,
    output_width: int,
    output_height: int,
    cancellation_check: Callable[[], None] | None,
) -> np.ndarray:
    """Return a deterministic nearest whole-source stored-RGB sample."""

    source = metadata.levels[0].dimensions
    x_indices = _indices(source.x, output_width)
    y_indices = _indices(source.y, output_height)
    result: np.ndarray | None = None
    for y0 in range(0, source.y, SOURCE_TILE_EDGE):
        height = min(SOURCE_TILE_EDGE, source.y - y0)
        output_y = np.flatnonzero((y_indices >= y0) & (y_indices < y0 + height))
        if output_y.size == 0:
            continue
        for x0 in range(0, source.x, SOURCE_TILE_EDGE):
            width = min(SOURCE_TILE_EDGE, source.x - x0)
            output_x = np.flatnonzero((x_indices >= x0) & (x_indices < x0 + width))
            if output_x.size == 0:
                continue
            tile = _read_stored_rgb(
                session,
                metadata,
                NativeSelection(
                    x=x0,
                    y=y0,
                    width=width,
                    height=height,
                    t=t,
                    c=0,
                    z=z,
                    level=0,
                    series=metadata.selected_series,
                    expected_sha256=metadata.sha256,
                ),
                cancellation_check=cancellation_check,
            )
            if result is None:
                result = np.empty((output_height, output_width, tile.shape[-1]), dtype=tile.dtype)
            result[np.ix_(output_y, output_x)] = tile[
                np.ix_(y_indices[output_y] - y0, x_indices[output_x] - x0)
            ]
    if result is None:
        raise ViewerImageError("The deterministic stored RGB histogram sample is empty.")
    return result


def _histogram_shape(metadata: NativeImageMetadata, component_count: int) -> tuple[int, int]:
    """Bound a whole-source sample across all components before any source read."""

    if component_count < 1:
        raise ViewerImageError("Histogram component count is invalid.")
    maximum_pixels = min(MAX_OVERVIEW_EDGE**2, MAX_DISPLAY_SAMPLE_VALUES // component_count)
    if maximum_pixels < 1:
        raise ViewerImageError("Histogram component count exceeds the stable sample bound.")
    source = metadata.levels[0].dimensions
    width, height = _scaled_shape(source.x, source.y, MAX_OVERVIEW_EDGE)
    if width * height <= maximum_pixels:
        return width, height
    scale = math.sqrt(maximum_pixels / (width * height))
    return max(1, int(width * scale)), max(1, int(height * scale))


def _histogram_record(
    values: np.ndarray,
    *,
    component: int,
    label: str,
    units: str,
    bins: int,
) -> dict[str, Any]:
    array = np.asarray(values)
    if array.ndim != 2 or array.size == 0 or array.dtype.kind not in "buif":
        raise ViewerImageError("Histogram values must be non-empty real two-dimensional samples.")
    if array.dtype.kind == "f" and not np.isfinite(array).all():
        raise ViewerImageError("Histogram samples contain non-finite values.")
    observed_min = float(array.min())
    observed_max = float(array.max())
    if not math.isfinite(observed_min) or not math.isfinite(observed_max):
        raise ViewerImageError("Histogram sample bounds must be finite.")
    bin_low, bin_high = observed_min, observed_max
    constant = observed_min == observed_max
    if constant:
        # A single ULP cannot hold 256 distinct histogram edges. The plotting
        # interval may expand, while observed values and percentiles stay exact.
        padding = max(1.0, abs(observed_min) * 1e-6)
        bin_high = observed_max + padding
        if not math.isfinite(bin_high):
            bin_low, bin_high = observed_min - padding, observed_max
    if not math.isfinite(bin_high - bin_low) or bin_high <= bin_low:
        raise ViewerImageError("Histogram sample bounds cannot form a finite bin range.")
    counts, edges = np.histogram(array, bins=bins, range=(bin_low, bin_high))
    cumulative = np.cumsum(counts, dtype=np.int64)
    sample_count = int(array.size)
    lower_rank = max(1, math.ceil(sample_count * 0.01))
    upper_rank = max(lower_rank, math.ceil(sample_count * 0.99))
    lower_bin = min(int(np.searchsorted(cumulative, lower_rank, side="left")), bins - 1)
    upper_bin = min(int(np.searchsorted(cumulative, upper_rank, side="left")), bins - 1)
    return {
        "component": component,
        "label": label,
        "units": units,
        "dtype": str(array.dtype),
        "sample_count": sample_count,
        "min": observed_min,
        "max": observed_max,
        "bin_range": [float(edges[0]), float(edges[-1])],
        "counts": [int(value) for value in counts],
        "percentile_1": observed_min if constant else float(edges[lower_bin]),
        "percentile_99": observed_max
        if constant
        else min(observed_max, float(edges[upper_bin + 1])),
        "clipping": {
            "below_percentile_1_bin": int(cumulative[lower_bin - 1]) if lower_bin else 0,
            "above_percentile_99_bin": int(sample_count - cumulative[upper_bin]),
        },
    }


def viewer_histogram(
    session: Any,
    request: Mapping[str, Any],
    *,
    cancellation_check: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Compute bounded source-stable display histograms, never viewport histograms.

    Scalar entries follow native C channels.  Interleaved RGB(A) entries follow
    stored device components and are not biological-channel measurements.
    """

    if not isinstance(request, Mapping):
        raise ViewerImageError("viewer_histogram request must be a mapping.")
    _exact_keys(request, {"source_id", "t", "z", "bins"}, "viewer_histogram request")
    source_id = _source_id(request.get("source_id"))
    metadata = _metadata(session)
    t, z, _ = _validate_t_z(metadata, request.get("t", 0), request.get("z", 0))
    bins = _integer(request.get("bins", 256), "bins", 2, MAX_HISTOGRAM_BINS)
    component_count = (
        metadata.dimensions.c if metadata.sample_semantics == "none" else metadata.dimensions.s
    )
    if not 1 <= component_count <= MAX_DISPLAY_CHANNELS:
        raise ViewerImageError("Histogram component count is outside the viewer limit.")
    if metadata.sample_semantics != "none" and component_count not in {3, 4}:
        raise ViewerImageError("Stored RGB(A) metadata has an invalid component count.")
    width, height = _histogram_shape(metadata, component_count)
    try:
        dtype_sizes = [np.dtype(dtype).itemsize for dtype in metadata.channel_dtypes]
    except TypeError as exc:
        raise ViewerImageError("Histogram metadata contains an invalid native dtype.") from exc
    largest_dtype = max(dtype_sizes, default=0)
    estimated_working_bytes = width * height * component_count * (largest_dtype + 24) + bins * 32
    if estimated_working_bytes > MAX_VIEWER_WORKING_BYTES:
        raise ViewerImageError("The requested histogram exceeds the viewer working-memory budget.")
    level = _select_native_overview_level(metadata, MAX_OVERVIEW_EDGE)
    native_level = (
        level is not None
        and metadata.levels[level].dimensions.x * metadata.levels[level].dimensions.y
        <= width * height
    )
    sampled_dimensions = metadata.levels[level].dimensions if native_level else None
    sample_height = sampled_dimensions.y if sampled_dimensions is not None else height
    sample_width = sampled_dimensions.x if sampled_dimensions is not None else width
    records: list[dict[str, Any]] = []
    if metadata.sample_semantics == "none":
        for channel in range(metadata.dimensions.c):
            if native_level:
                assert level is not None
                sample = _native_overview_scalar(
                    session,
                    metadata,
                    channel=channel,
                    level=level,
                    t=t,
                    z=z,
                    z_stop=None,
                    projection=None,
                    cancellation_check=cancellation_check,
                )
            else:
                sample = _sample_scalar_plane(
                    session,
                    metadata,
                    channel=channel,
                    t=t,
                    z=z,
                    z_stop=None,
                    projection=None,
                    output_width=width,
                    output_height=height,
                    cancellation_check=cancellation_check,
                )
            records.append(
                _histogram_record(
                    sample,
                    component=channel,
                    label=metadata.channel_names[channel],
                    units="native scalar sample values",
                    bins=bins,
                )
            )
    else:
        if native_level:
            assert level is not None
            dimensions = metadata.levels[level].dimensions
            sample = _read_stored_rgb(
                session,
                metadata,
                NativeSelection(
                    x=0,
                    y=0,
                    width=dimensions.x,
                    height=dimensions.y,
                    t=t,
                    c=0,
                    z=_mapped_z(z, metadata.dimensions.z, dimensions.z),
                    level=level,
                    series=metadata.selected_series,
                    expected_sha256=metadata.sha256,
                ),
                cancellation_check=cancellation_check,
            )
        else:
            sample = _sample_stored_rgb_plane(
                session,
                metadata,
                t=t,
                z=z,
                output_width=width,
                output_height=height,
                cancellation_check=cancellation_check,
            )
        labels = ("stored RGB red", "stored RGB green", "stored RGB blue", "stored alpha")
        for component in range(sample.shape[-1]):
            records.append(
                _histogram_record(
                    sample[..., component],
                    component=component,
                    label=labels[component],
                    units="stored source-device component values",
                    bins=bins,
                )
            )
    _validate_cached_source(session)
    sample_basis = {
        "kind": "deterministic-native-pyramid-level"
        if native_level
        else "deterministic-nearest-whole-source",
        "level": level if native_level else 0,
        "t": t,
        "z": z,
        "shape": [sample_height, sample_width],
        "sample_count_per_component": sample_height * sample_width,
        "viewport_dependent": False,
    }
    return {
        "source_id": source_id,
        "source_sha256": metadata.sha256,
        "sample": sample_basis,
        "sample_semantics": metadata.sample_semantics,
        "histograms": records,
        "display_revision": _revision(metadata, records, sample_basis),
    }


def _request_settings(
    value: Any, metadata: NativeImageMetadata
) -> tuple[ResolvedChannelDisplay, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_DISPLAY_CHANNELS:
        raise ViewerImageError("channels must contain 1-16 explicit display mappings.")
    settings: list[ResolvedChannelDisplay] = []
    seen: set[int] = set()
    for record in value:
        if not isinstance(record, Mapping):
            raise ViewerImageError("Each channel display must be a mapping.")
        _exact_keys(
            record,
            {"channel", "low", "high", "gamma", "visible", "color", "opacity"},
            "channel display",
        )
        channel = _integer(record.get("channel"), "channel", 0, metadata.dimensions.c - 1)
        if channel in seen:
            raise ViewerImageError("Channel display mappings must be unique.")
        seen.add(channel)
        try:
            low = float(record["low"])
            high = float(record["high"])
            gamma = float(record["gamma"])
            opacity = float(record.get("opacity", 1.0))
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ViewerImageError("Channel display numbers are missing or invalid.") from exc
        color = record.get("color")
        if not isinstance(color, str) or len(color) != 7 or not color.startswith("#"):
            raise ViewerImageError("Channel display color must be #rrggbb.")
        try:
            color_rgb = tuple(int(color[index : index + 2], 16) / 255 for index in (1, 3, 5))
        except ValueError as exc:
            raise ViewerImageError("Channel display color must be #rrggbb.") from exc
        visible = record.get("visible")
        if not isinstance(visible, bool):
            raise ViewerImageError("Channel display visibility must be boolean.")
        if not (
            math.isfinite(low)
            and math.isfinite(high)
            and high > low
            and math.isfinite(gamma)
            and 0.1 <= gamma <= 10
            and math.isfinite(opacity)
            and 0 <= opacity <= 1
        ):
            raise ViewerImageError("Channel display mapping is outside its supported bounds.")
        settings.append(
            ResolvedChannelDisplay(
                channel=channel,
                low=low,
                high=high,
                gamma=gamma,
                color_rgb=color_rgb,  # type: ignore[arg-type]
                opacity=opacity,
                visible=visible,
                range_basis="explicit-viewer-request",
                gamma_basis="explicit-viewer-request",
                color_basis="explicit-viewer-request",
                opacity_basis="explicit-viewer-request",
                visibility_basis="explicit-viewer-request",
            )
        )
    return tuple(settings)


def _render_scalar(
    channels: Mapping[int, np.ndarray], settings: Sequence[ResolvedChannelDisplay]
) -> np.ndarray:
    try:
        return render_channel_composite(channels, settings)
    except ViewerDisplayError as exc:
        raise ViewerImageError(str(exc)) from exc


def _render_rgb(
    array: np.ndarray,
    metadata: NativeImageMetadata,
    *,
    embedded_icc: bytes | None,
    display: ResolvedChannelDisplay | None = None,
) -> np.ndarray:
    assert metadata.rgb_color_policy is not None
    try:
        if display is None:
            return render_source_rgb(array, metadata.rgb_color_policy, embedded_icc=embedded_icc)
        return render_adjusted_source_rgb(
            array,
            metadata.rgb_color_policy,
            low=display.low,
            high=display.high,
            gamma=display.gamma,
            embedded_icc=embedded_icc,
        )
    except ViewerDisplayError as exc:
        raise ViewerImageError(str(exc)) from exc


def _normal_tile(
    session: Any,
    metadata: NativeImageMetadata,
    request: Mapping[str, Any],
    settings: tuple[ResolvedChannelDisplay, ...],
    *,
    embedded_icc: bytes | None,
    cancellation_check: Callable[[], None] | None,
) -> dict[str, Any]:
    selection_value = request.get("selection")
    if not isinstance(selection_value, Mapping):
        raise ViewerImageError("selection must be an explicit mapping.")
    _exact_keys(
        selection_value,
        {"x", "y", "width", "height", "level", "c", "z", "t", "z_stop"},
        "viewer selection",
    )
    level = _integer(selection_value.get("level", 0), "level", 0, len(metadata.levels) - 1)
    dimensions = metadata.levels[level].dimensions
    x = _integer(selection_value.get("x"), "x", 0, dimensions.x - 1)
    y = _integer(selection_value.get("y"), "y", 0, dimensions.y - 1)
    width = _integer(selection_value.get("width"), "width", 1, dimensions.x - x)
    height = _integer(selection_value.get("height"), "height", 1, dimensions.y - y)
    if width * height > MAX_DISPLAY_PIXELS or width > 2048 or height > 2048:
        raise ViewerImageError("A viewer tile exceeds the 2048-pixel edge and area bounds.")
    t = _integer(selection_value.get("t", 0), "t", 0, dimensions.t - 1)
    z = _integer(selection_value.get("z", 0), "z", 0, dimensions.z - 1)
    z_stop_value = selection_value.get("z_stop")
    z_stop = None if z_stop_value is None else _integer(z_stop_value, "z_stop", z + 1, dimensions.z)
    projection = _projection(request.get("projection"), z_stop)
    _require_working_budget(metadata, settings, width, height, projection=projection)
    active_c = _integer(selection_value.get("c", settings[0].channel), "c", 0, dimensions.c - 1)
    resolved_selection = {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "level": level,
        "c": active_c,
        "z": z,
        "t": t,
    }
    if z_stop is not None:
        resolved_selection["z_stop"] = z_stop
    if metadata.sample_semantics == "none":
        arrays = {
            display.channel: _read_plane_or_projection(
                session,
                metadata,
                x=x,
                y=y,
                width=width,
                height=height,
                t=t,
                channel=display.channel,
                level=level,
                z_start=z,
                z_stop=z_stop or z + 1,
                projection=projection,
                cancellation_check=cancellation_check,
            )
            for display in settings
        }
        pixels = _render_scalar(arrays, settings)
    else:
        if len(settings) != 1 or settings[0].channel != 0 or projection is not None:
            raise ViewerImageError(
                "Interleaved RGB uses one channel-zero mapping and no projection."
            )
        pixels = _read_rgb_display(
            session,
            metadata,
            NativeSelection(
                x=x,
                y=y,
                width=width,
                height=height,
                t=t,
                c=0,
                z=z,
                level=level,
                series=metadata.selected_series,
                expected_sha256=metadata.sha256,
            ),
            embedded_icc=embedded_icc,
            display=settings[0],
            cancellation_check=cancellation_check,
        )
    geometry = session.geometry(resolved_selection, False)
    display = _display_payload(settings)
    basis = {"mode": "explicit", "viewport_dependent": False}
    if pixels.dtype != np.uint8:
        raise ViewerImageError("Viewer canvas RGB rendering requires uint8 stored components.")
    return {
        "image": _data_url(_png_bytes(pixels)),
        "selection": resolved_selection,
        "source_sha256": metadata.sha256,
        "display": display,
        "display_revision": _revision(metadata, display, basis),
        "geometry": geometry.to_dict(),
        "projection": projection,
    }


def _overview_geometry(
    session: Any,
    *,
    level: int,
    z: int,
    source_width: int,
    source_height: int,
    output_width: int,
    output_height: int,
) -> dict[str, Any]:
    geometry = session.geometry({"level": level, "x": 0, "y": 0, "z": z}, False)
    matrix = np.asarray(geometry.affine, dtype=np.float64)
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
        raise ViewerImageError("Viewer geometry must be a finite 4x4 affine.")
    scale_x = (source_width - 1) / (output_width - 1) if output_width > 1 else 1.0
    scale_y = (source_height - 1) / (output_height - 1) if output_height > 1 else 1.0
    matrix[:3, 0] *= scale_x
    matrix[:3, 1] *= scale_y
    value = geometry.to_dict()
    value["affine"] = [[float(item) for item in row] for row in matrix]
    return value


def _cache_directory(root: str | Path) -> Path:
    parent = Path(root)
    if parent.is_symlink() or not parent.is_dir():
        raise ViewerImageError("The project-owned viewer cache root is unavailable or linked.")
    directory = parent / "viewer-overviews"
    directory.mkdir(mode=0o700, exist_ok=True)
    status = directory.lstat()
    if not stat.S_ISDIR(status.st_mode) or directory.is_symlink():
        raise ViewerImageError("The project-owned viewer cache directory is unsafe.")
    return directory


def _cache_candidates(directory: Path, key: str) -> list[Path]:
    candidates = list(directory.glob(f"{key}-*.png"))
    if len(candidates) > 1:
        raise ViewerImageError("The derived viewer cache contains ambiguous entries.")
    return candidates


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        0 if os.name == "nt" else value.st_ctime_ns,
    )


def _read_plain_file(target: Path) -> bytes:
    status = target.lstat()
    if not stat.S_ISREG(status.st_mode):
        raise ViewerImageError("A derived viewer cache entry is linked or not a plain file.")
    if not 0 < status.st_size <= MAX_CACHE_PNG_BYTES:
        raise ViewerImageError("A cached viewer overview exceeds the payload bound.")
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (status.st_dev, status.st_ino):
            raise ViewerImageError("A derived viewer cache entry changed while opening.")
        encoded = stream.read(MAX_CACHE_PNG_BYTES + 1)
        after = os.fstat(stream.fileno())
    if (
        len(encoded) != status.st_size
        or _stat_identity(after) != _stat_identity(opened)
        or _stat_identity(target.lstat()) != _stat_identity(status)
    ):
        raise ViewerImageError("A derived viewer cache entry changed while reading.")
    return encoded


def _validate_png(encoded: bytes, width: int, height: int) -> None:
    try:
        with Image.open(io.BytesIO(encoded)) as image:
            if image.format != "PNG" or image.mode not in {"RGB", "RGBA"}:
                raise ViewerImageError("A cached viewer overview has an invalid image format.")
            if image.size != (width, height):
                raise ViewerImageError("A cached viewer overview has inconsistent dimensions.")
            image.verify()
    except ViewerImageError:
        raise
    except Exception as exc:
        raise ViewerImageError("A cached viewer overview is not a valid PNG.") from exc


def _cached_png(root: str | Path | None, key: str, *, width: int, height: int) -> bytes | None:
    if root is None:
        return None
    candidates = _cache_candidates(_cache_directory(root), key)
    if not candidates:
        return None
    target = candidates[0]
    expected_digest = target.stem.removeprefix(f"{key}-")
    if len(expected_digest) != 64 or any(
        value not in "0123456789abcdef" for value in expected_digest
    ):
        raise ViewerImageError("A derived viewer cache identity is invalid.")
    encoded = _read_plain_file(target)
    if hashlib.sha256(encoded).hexdigest() != expected_digest:
        raise ViewerImageError("A cached viewer overview failed its content hash.")
    _validate_png(encoded, width, height)
    return encoded


def _enforce_cache_bound(directory: Path, keep: Path) -> None:
    entries: list[tuple[int, str, int, Path]] = []
    for path in directory.glob("*-*.png"):
        status = path.lstat()
        if not stat.S_ISREG(status.st_mode):
            raise ViewerImageError("A derived viewer cache entry is linked or not a plain file.")
        entries.append((status.st_mtime_ns, path.name, status.st_size, path))
    entries.sort()
    total = sum(entry[2] for entry in entries)
    while len(entries) > MAX_OVERVIEW_CACHE_FILES or total > MAX_OVERVIEW_CACHE_BYTES:
        removable = next((entry for entry in entries if entry[3] != keep), None)
        if removable is None:
            raise ViewerImageError("The derived viewer cache cannot satisfy its storage bound.")
        entries.remove(removable)
        total -= removable[2]
        removable[3].unlink()


def _publish_cached_png(root: str | Path | None, key: str, encoded: bytes) -> None:
    if root is None:
        return
    directory = _cache_directory(root)
    digest = hashlib.sha256(encoded).hexdigest()
    target = directory / f"{key}-{digest}.png"
    existing = _cache_candidates(directory, key)
    if existing:
        if existing[0] != target:
            raise ViewerImageError("The same viewer cache request produced different content.")
        _enforce_cache_bound(directory, target)
        return
    descriptor, temporary_name = tempfile.mkstemp(prefix=".viewer-", suffix=".png", dir=directory)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        _enforce_cache_bound(directory, target)
        try:
            descriptor = os.open(directory, os.O_RDONLY)
        except OSError:
            if os.name == "nt":
                # Windows does not expose directory handles as CRT descriptors.
                return
            raise
        try:
            if os.name == "nt":
                with suppress(OSError):
                    os.fsync(descriptor)
            else:
                os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()


def _validate_cached_source(session: Any) -> None:
    validate = getattr(session, "validate_source", None)
    if callable(validate):
        validate()
        return
    verify = getattr(session, "verify_strict", None)
    if not callable(verify):
        raise ViewerImageError("The viewer session cannot validate a cached source.")
    verify()


def _overview_tile(
    session: Any,
    metadata: NativeImageMetadata,
    request: Mapping[str, Any],
    settings: tuple[ResolvedChannelDisplay, ...],
    *,
    cache_root: str | Path | None,
    embedded_icc: bytes | None,
    cancellation_check: Callable[[], None] | None,
) -> dict[str, Any]:
    max_edge = _integer(
        request.get("max_edge", MAX_OVERVIEW_EDGE), "max_edge", 16, MAX_OVERVIEW_EDGE
    )
    t, z, z_stop = _validate_t_z(
        metadata, request.get("t", 0), request.get("z", 0), request.get("z_stop")
    )
    projection = _projection(request.get("projection"), z_stop)
    if metadata.sample_semantics != "none" and (projection is not None or z_stop is not None):
        raise ViewerImageError("Interleaved RGB overview does not support Z projection.")
    requested_c = _integer(request.get("c", settings[0].channel), "c", 0, metadata.dimensions.c - 1)
    level = _select_native_overview_level(metadata, max_edge)
    display = _display_payload(settings)
    if level is None:
        preparation = "derived-cache"
        source_dimensions = metadata.levels[0].dimensions
        width, height = _scaled_shape(source_dimensions.x, source_dimensions.y, max_edge)
        geometry_level = 0
        geometry_z = z
    else:
        preparation = "native-pyramid"
        source_dimensions = metadata.levels[level].dimensions
        width, height = source_dimensions.x, source_dimensions.y
        geometry_level = level
        geometry_z = _mapped_z(z, metadata.dimensions.z, source_dimensions.z)
    _require_working_budget(metadata, settings, width, height, projection=projection)
    basis = {
        "mode": "explicit",
        "overview": preparation,
        "level": geometry_level,
        "t": t,
        "z": z,
        "z_stop": z_stop,
        "projection": projection,
        "viewport_dependent": False,
    }
    display_revision = _revision(metadata, display, basis)
    cache_value = {
        "source_sha256": metadata.sha256,
        "display_revision": display_revision,
        "width": width,
        "height": height,
        "max_edge": max_edge,
    }
    # A 128-bit request key keeps the full content digest in the filename while
    # remaining below legacy Windows path limits for long study directories.
    cache_key = hashlib.sha256(
        json.dumps(cache_value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:32]
    encoded = (
        _cached_png(cache_root, cache_key, width=width, height=height)
        if preparation == "derived-cache"
        else None
    )
    if encoded is not None:
        _validate_cached_source(session)
    if encoded is None:
        if metadata.sample_semantics != "none":
            if len(settings) != 1 or settings[0].channel != 0:
                raise ViewerImageError("Interleaved RGB uses one channel-zero display mapping.")
            if preparation == "derived-cache":
                pixels = _sample_rgb_plane(
                    session,
                    metadata,
                    t=t,
                    z=z,
                    output_width=width,
                    output_height=height,
                    embedded_icc=embedded_icc,
                    display=settings[0],
                    cancellation_check=cancellation_check,
                )
            else:
                assert level is not None
                pixels = _native_rgb_overview(
                    session,
                    metadata,
                    level=level,
                    t=t,
                    z=z,
                    embedded_icc=embedded_icc,
                    display=settings[0],
                    cancellation_check=cancellation_check,
                )
        elif preparation == "derived-cache":
            arrays = {
                setting.channel: _sample_scalar_plane(
                    session,
                    metadata,
                    channel=setting.channel,
                    t=t,
                    z=z,
                    z_stop=z_stop,
                    projection=projection,
                    output_width=width,
                    output_height=height,
                    cancellation_check=cancellation_check,
                )
                for setting in settings
            }
            pixels = _render_scalar(arrays, settings)
        else:
            assert level is not None
            arrays = {
                setting.channel: _native_overview_scalar(
                    session,
                    metadata,
                    channel=setting.channel,
                    level=level,
                    t=t,
                    z=z,
                    z_stop=z_stop,
                    projection=projection,
                    cancellation_check=cancellation_check,
                )
                for setting in settings
            }
            pixels = _render_scalar(arrays, settings)
        if pixels.dtype != np.uint8:
            raise ViewerImageError("Viewer canvas RGB rendering requires uint8 stored components.")
        encoded = _png_bytes(pixels)
        if cancellation_check is not None:
            cancellation_check()
        if preparation == "derived-cache":
            _publish_cached_png(cache_root, cache_key, encoded)
    geometry = _overview_geometry(
        session,
        level=geometry_level,
        z=geometry_z,
        source_width=source_dimensions.x,
        source_height=source_dimensions.y,
        output_width=width,
        output_height=height,
    )
    return {
        "image": _data_url(encoded),
        "source_sha256": metadata.sha256,
        "source_extent": [metadata.dimensions.x, metadata.dimensions.y],
        "width": width,
        "height": height,
        "display": display,
        "display_revision": display_revision,
        "geometry": geometry,
        "preparation": preparation,
        "selection": {"t": t, "z": z, "c": requested_c, "z_stop": z_stop},
        "projection": projection,
    }


def viewer_tile(
    session: Any,
    request: Mapping[str, Any],
    *,
    cache_root: str | Path | None = None,
    embedded_icc: bytes | None = None,
    cancellation_check: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Render one bounded crop or one full-extent overview from a source session."""

    if not isinstance(request, Mapping):
        raise ViewerImageError("viewer_tile request must be a mapping.")
    overview = request.get("overview", False)
    if not isinstance(overview, bool):
        raise ViewerImageError("overview must be boolean.")
    allowed = (
        {"source_id", "overview", "t", "z", "c", "channels", "projection", "z_stop", "max_edge"}
        if overview
        else {"source_id", "selection", "channels", "projection"}
    )
    _exact_keys(request, allowed, "viewer_tile request")
    _source_id(request.get("source_id"))
    metadata = _metadata(session)
    if len(metadata.channel_dtypes) != metadata.dimensions.c:
        raise ViewerImageError("Histogram metadata channel dtype count differs from C.")
    settings = _request_settings(request.get("channels"), metadata)
    if overview:
        return _overview_tile(
            session,
            metadata,
            request,
            settings,
            cache_root=cache_root,
            embedded_icc=embedded_icc,
            cancellation_check=cancellation_check,
        )
    return _normal_tile(
        session,
        metadata,
        request,
        settings,
        embedded_icc=embedded_icc,
        cancellation_check=cancellation_check,
    )
