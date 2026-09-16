"""Atomic rendered PNG and bounded, tiled full-resolution TIFF16 export."""

from __future__ import annotations

import base64
import hashlib
import io
import math
import os
import re
import shutil
import tempfile
from collections.abc import Callable, Iterator
from contextlib import suppress
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import tifffile
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
from PIL import __version__ as PILLOW_VERSION

from .export import _fsync_directory, _NamedBinaryStream, _rename_noreplace, _sync_stream
from .models import ENGINE_VERSION
from .native_image import NativeImageMetadata, NativeSelection, srgb_output_profile_bytes
from .quantitative import exact_keys
from .research_interchange import _atomic_write
from .research_project import canonical_json, checked_id
from .viewer_display import render_channel_composite
from .viewer_image import (
    MAX_PROJECTION_PLANES,
    _display_payload,
    _read_plane_or_projection,
    _read_rgb_display,
    _request_settings,
    _revision,
)

if TYPE_CHECKING:
    from .workbench import Workbench


TIFF_TILE_EDGE = 256
MAX_RENDERED_TIFF_BYTES = 64 * 1024**3
MIN_FREE_BYTES_AFTER_EXPORT = 256 * 1024**2
DEFAULT_EXPORT_DPI = 300
MIN_EXPORT_DPI = 72
MAX_EXPORT_DPI = 1200
MAX_LEGEND_ENTRIES = 32
MAX_LEGEND_LABEL_LENGTH = 80
MIN_FOOTER_WIDTH = 160
MAX_FOOTER_PIXELS = 4 * 1024**2
_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_PHYSICAL_TO_MICROMETRES = {"nm": 1e-3, "um": 1.0, "µm": 1.0, "μm": 1.0, "mm": 1e3, "m": 1e6}


@dataclass(frozen=True, slots=True)
class _FigureOptions:
    dpi: int
    scale_bar: bool
    channel_legend: bool
    channel_labels: tuple[dict[str, Any], ...]

    def request_payload(self) -> dict[str, Any]:
        return {
            "dpi": self.dpi,
            "scale_bar": self.scale_bar,
            "channel_legend": self.channel_legend,
            "channel_labels": [dict(item) for item in self.channel_labels],
        }


def _figure_options(view: dict[str, Any]) -> tuple[dict[str, Any], _FigureOptions]:
    render_view = dict(view)
    raw = render_view.pop("figure", None)
    if raw is None:
        return render_view, _FigureOptions(DEFAULT_EXPORT_DPI, False, False, ())
    exact_keys(
        raw,
        {"dpi", "scale_bar", "channel_legend", "channel_labels"},
        "rendered figure",
    )
    dpi = _integer(raw.get("dpi", DEFAULT_EXPORT_DPI), "dpi", MIN_EXPORT_DPI, MAX_EXPORT_DPI)
    scale_bar = raw.get("scale_bar", False)
    channel_legend = raw.get("channel_legend", False)
    if not isinstance(scale_bar, bool) or not isinstance(channel_legend, bool):
        raise ValueError("Rendered figure options must use boolean scale-bar and legend choices")
    labels = raw.get("channel_labels", [])
    if not isinstance(labels, list) or len(labels) > MAX_LEGEND_ENTRIES:
        raise ValueError(f"A rendered channel legend is limited to {MAX_LEGEND_ENTRIES} entries")
    normalized: list[dict[str, Any]] = []
    seen: set[int] = set()
    for label in labels:
        exact_keys(label, {"channel", "name", "color"}, "channel legend entry")
        channel = _integer(label.get("channel"), "legend channel", 0, MAX_LEGEND_ENTRIES - 1)
        name = label.get("name")
        color = label.get("color")
        if (
            not isinstance(name, str)
            or not name.strip()
            or len(name) > MAX_LEGEND_LABEL_LENGTH
            or any(ord(character) < 32 or ord(character) == 127 for character in name)
        ):
            raise ValueError(
                f"Channel legend names must be 1-{MAX_LEGEND_LABEL_LENGTH} control-free characters"
            )
        if not isinstance(color, str) or _HEX_COLOR.fullmatch(color) is None:
            raise ValueError("Channel legend colors must be six-digit hexadecimal RGB values")
        if channel in seen:
            raise ValueError("Channel legend entries must use unique channel indices")
        seen.add(channel)
        normalized.append({"channel": channel, "name": name.strip(), "color": color.lower()})
    if channel_legend != bool(normalized):
        raise ValueError(
            "Channel legend entries must be present exactly when the legend is enabled"
        )
    return render_view, _FigureOptions(dpi, scale_bar, channel_legend, tuple(normalized))


def _resolved_legend(
    options: _FigureOptions,
    metadata: NativeImageMetadata,
    settings: tuple[Any, ...],
) -> tuple[dict[str, Any], ...]:
    if not options.channel_legend:
        return ()
    if metadata.sample_semantics != "none":
        raise ValueError("Channel legends require independently mapped scalar source channels")
    visible = [setting for setting in settings if setting.visible and setting.opacity > 0]
    by_channel = {item["channel"]: item for item in options.channel_labels}
    if set(by_channel) != {setting.channel for setting in visible}:
        raise ValueError("Channel legend entries must match the currently visible source channels")
    for setting in visible:
        if by_channel[setting.channel]["color"] != setting.color_hex:
            raise ValueError("Channel legend colors must match the current display mapping")
    return tuple(dict(by_channel[setting.channel]) for setting in visible)


def _scale_micrometres_per_pixel(geometry: dict[str, Any]) -> float:
    if geometry.get("axes") != "YX":
        raise ValueError("A scale bar requires a two-dimensional source geometry")
    factor = _PHYSICAL_TO_MICROMETRES.get(geometry.get("unit"))
    if factor is None:
        raise ValueError("A scale bar requires declared physical calibration")
    matrix = np.asarray(geometry.get("affine"), dtype=np.float64)
    if (
        matrix.shape != (4, 4)
        or not np.isfinite(matrix).all()
        or not np.array_equal(matrix[3], [0, 0, 0, 1])
    ):
        raise ValueError("A scale bar requires finite source geometry")
    spacing = float(np.linalg.norm(matrix[:3, 0])) * factor
    if not math.isfinite(spacing) or spacing <= 0:
        raise ValueError("A scale bar requires positive physical X calibration")
    return spacing


def _nice_scale_length(target_um: float) -> float:
    exponent = math.floor(math.log10(target_um))
    base = 10.0**exponent
    candidates = [factor * base for factor in (1.0, 2.0, 5.0, 10.0)]
    return max((value for value in candidates if value <= target_um), default=candidates[0])


def _format_micrometres(value: float) -> str:
    if value >= 1000:
        return f"{value / 1000:g} mm"
    if value < 1:
        return f"{value * 1000:g} nm"
    return f"{value:g} µm"


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: Any, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        proposal = word if not current else f"{current} {word}"
        if draw.textlength(proposal, font=font) <= width:
            current = proposal
            continue
        if current:
            lines.append(current)
            current = ""
        while draw.textlength(word, font=font) > width and len(word) > 1:
            cut = len(word) - 1
            while cut > 1 and draw.textlength(word[:cut], font=font) > width:
                cut -= 1
            lines.append(word[:cut])
            word = word[cut:]
        current = word
    if current:
        lines.append(current)
    return lines or [text]


def _apply_mask(canvas: np.ndarray, mask: Image.Image, color: tuple[int, int, int]) -> None:
    bounds = mask.getbbox()
    if bounds is None:
        return
    left, top, right, bottom = bounds
    canvas = canvas[top:bottom, left:right]
    alpha = np.asarray(mask.crop(bounds), dtype=np.uint32)[..., None]
    maximum = int(np.iinfo(canvas.dtype).max)
    target = np.asarray(color, dtype=np.uint32) * (maximum // 255)
    blended = (canvas.astype(np.uint32) * (255 - alpha) + target * alpha + 127) // 255
    canvas[...] = blended.astype(canvas.dtype)


def _render_footer(
    *,
    width: int,
    image_height: int,
    channels: int,
    bit_depth: int,
    options: _FigureOptions,
    geometry: dict[str, Any],
    legend: tuple[dict[str, Any], ...],
) -> tuple[np.ndarray | None, dict[str, Any] | None]:
    if not options.scale_bar and not legend:
        return None, None
    if channels == 4:
        raise ValueError("RGBA rendered figures do not support a publication footer")
    spacing_um = _scale_micrometres_per_pixel(geometry) if options.scale_bar else None
    if width < MIN_FOOTER_WIDTH:
        raise ValueError(
            f"A publication footer requires an export at least {MIN_FOOTER_WIDTH} pixels wide"
        )
    font_size = max(10, min(round(options.dpi * 10 / 72), max(10, width // 14)))
    font = ImageFont.load_default(size=font_size)
    measure = ImageDraw.Draw(Image.new("L", (1, 1)))
    text_box = measure.textbbox((0, 0), "Ag", font=font)
    line_height = max(12, text_box[3] - text_box[1] + max(3, font_size // 4))
    padding = max(6, min(round(options.dpi * 0.06), width // 12))
    swatch = max(8, min(line_height - 3, round(options.dpi * 0.06)))
    text_width = width - 3 * padding - swatch
    if text_width < 32:
        raise ValueError("The rendered figure is too narrow for its channel legend")
    wrapped = [(entry, _wrap_text(measure, entry["name"], font, text_width)) for entry in legend]
    scale_height = line_height + padding if options.scale_bar else 0
    legend_height = sum(max(line_height, len(lines) * line_height) for _, lines in wrapped)
    height = padding + scale_height + legend_height + padding
    if height > 4096 or width * height > MAX_FOOTER_PIXELS:
        raise ValueError(
            "The rendered channel legend exceeds the bounded footer size; "
            "use a smaller image region or fewer labels"
        )
    dtype = np.uint8 if bit_depth == 8 else np.uint16
    maximum = np.iinfo(dtype).max
    footer = np.full((height, width, 3), maximum, dtype=dtype)
    y = padding
    scale_record: dict[str, Any] | None = None
    if options.scale_bar:
        assert spacing_um is not None
        target_pixels = max(32, min(width // 4, width - 2 * padding))
        label_um = _nice_scale_length(target_pixels * spacing_um)
        bar_pixels = max(1, round(label_um / spacing_um))
        if bar_pixels < 16 or bar_pixels > width - 2 * padding:
            raise ValueError("The export is too narrow for a trustworthy calibrated scale bar")
        thickness = max(2, min(round(options.dpi / 72), line_height // 3))
        bar_y = y + max(0, (line_height - thickness) // 2)
        label = _format_micrometres(label_um)
        text_x = padding + bar_pixels + padding
        if text_x + measure.textlength(label, font=font) > width - padding:
            raise ValueError("The export is too narrow for its calibrated scale-bar label")
        footer[bar_y : bar_y + thickness, padding : padding + bar_pixels] = 0
        mask = Image.new("L", (width, height), 0)
        ImageDraw.Draw(mask).text((text_x, y), label, fill=255, font=font)
        _apply_mask(footer, mask, (0, 0, 0))
        scale_record = {
            "label": label,
            "label_length_um": label_um,
            "represented_length_um": bar_pixels * spacing_um,
            "micrometres_per_output_pixel": spacing_um,
            "bar_xywh": [padding, image_height + bar_y, bar_pixels, thickness],
        }
        y += scale_height
    legend_records: list[dict[str, Any]] = []
    for entry, lines in wrapped:
        row_height = max(line_height, len(lines) * line_height)
        swatch_y = y + max(0, (line_height - swatch) // 2)
        color = tuple(int(entry["color"][index : index + 2], 16) for index in (1, 3, 5))
        footer[swatch_y : swatch_y + swatch, padding : padding + swatch] = (
            np.asarray(color, dtype=np.uint32) * (maximum // 255)
        ).astype(dtype)
        text_x = padding * 2 + swatch
        for line_index, line in enumerate(lines):
            mask = Image.new("L", (width, height), 0)
            ImageDraw.Draw(mask).text(
                (text_x, y + line_index * line_height), line, fill=255, font=font
            )
            _apply_mask(footer, mask, (0, 0, 0))
        legend_records.append(
            {**entry, "swatch_xywh": [padding, image_height + swatch_y, swatch, swatch]}
        )
        y += row_height
    return footer, {
        "placement": "below-source-raster",
        "offset_y": image_height,
        "width": width,
        "height": height,
        "background": "#ffffff",
        "scale_bar": scale_record,
        "channel_legend": legend_records,
    }


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer between {low} and {high}")
    return value


def _tiff_plan(
    session: Any, view: dict[str, Any]
) -> tuple[NativeImageMetadata, dict[str, int], str | None, tuple[Any, ...]]:
    exact_keys(view, {"source_id", "selection", "channels", "projection"}, "TIFF view")
    metadata = getattr(session, "metadata", None)
    if not isinstance(metadata, NativeImageMetadata):
        raise ValueError("Rendered TIFF source metadata is invalid")
    selection = view.get("selection")
    if not isinstance(selection, dict):
        raise ValueError("Rendered TIFF requires an explicit source selection")
    exact_keys(
        selection,
        {"x", "y", "width", "height", "level", "c", "z", "t", "z_stop"},
        "TIFF selection",
    )
    level = _integer(selection.get("level", 0), "level", 0, len(metadata.levels) - 1)
    if level != 0:
        raise ValueError("Rendered TIFF export requires the full-resolution source level")
    dimensions = metadata.levels[level].dimensions
    x = _integer(selection.get("x"), "x", 0, dimensions.x - 1)
    y = _integer(selection.get("y"), "y", 0, dimensions.y - 1)
    width = _integer(selection.get("width"), "width", 1, dimensions.x - x)
    height = _integer(selection.get("height"), "height", 1, dimensions.y - y)
    t = _integer(selection.get("t", 0), "t", 0, dimensions.t - 1)
    z = _integer(selection.get("z", 0), "z", 0, dimensions.z - 1)
    c = _integer(selection.get("c", 0), "c", 0, dimensions.c - 1)
    z_stop_value = selection.get("z_stop")
    z_stop = None if z_stop_value is None else _integer(z_stop_value, "z_stop", z + 1, dimensions.z)
    projection = view.get("projection")
    if projection is None:
        if z_stop is not None:
            raise ValueError("A TIFF Z range requires max or mean projection")
    elif projection not in {"max", "mean"} or z_stop is None:
        raise ValueError("TIFF projection requires an explicit Z range and max or mean method")
    elif z_stop - z > MAX_PROJECTION_PLANES:
        raise ValueError(f"A TIFF projection is limited to {MAX_PROJECTION_PLANES} source planes")
    settings = _request_settings(view.get("channels"), metadata)
    if metadata.sample_semantics != "none" and (
        len(settings) != 1 or settings[0].channel != 0 or projection is not None
    ):
        raise ValueError("Interleaved source RGB uses channel zero and no Z projection")
    return (
        metadata,
        {
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "level": level,
            "c": c,
            "z": z,
            "t": t,
            **({"z_stop": z_stop} if z_stop is not None else {}),
        },
        projection,
        settings,
    )


def _rgb_tiff_tile(
    session: Any,
    metadata: NativeImageMetadata,
    selection: NativeSelection,
    embedded_icc: bytes | None,
    display: Any,
) -> tuple[np.ndarray, str]:
    dtype = np.dtype(metadata.channel_dtypes[0])
    policy = metadata.rgb_color_policy
    if policy is None or policy.source_space != "source-device-RGB":
        raise ValueError("Interleaved source RGB has no validated colour policy")
    if dtype in {np.dtype(np.uint8), np.dtype(np.uint16)}:
        maximum = int(np.iinfo(dtype).max)
        neutral = display.low == 0 and display.high == maximum and display.gamma == 1
        displayed = _read_rgb_display(
            session,
            metadata,
            selection,
            embedded_icc=embedded_icc,
            display=None if dtype == np.uint8 and neutral else display,
            cancellation_check=None,
        )
        if displayed.dtype == np.uint16:
            return np.array(displayed, copy=True, order="C"), (
                "native-uint16-display-codes" if neutral else "adjusted-uint16-display-codes"
            )
        if displayed.dtype != np.uint8:
            raise ValueError("The RGB display renderer returned an unsupported precision")
        return displayed.astype(np.uint16) * 257, "uint8-display-expanded-to-uint16"
    raise ValueError("Rendered TIFF supports interleaved unsigned 8- or 16-bit RGB samples")


def _tiff_tiles(
    session: Any,
    metadata: NativeImageMetadata,
    selection: dict[str, int],
    projection: str | None,
    settings: tuple[Any, ...],
    embedded_icc: bytes | None,
    precision: list[str],
    footer: np.ndarray | None,
) -> Iterator[np.ndarray]:
    x_start, y_start = selection["x"], selection["y"]
    output_height = selection["height"] + (0 if footer is None else int(footer.shape[0]))
    channels = 4 if metadata.sample_semantics == "RGBA" else 3
    for y_offset in range(0, output_height, TIFF_TILE_EDGE):
        height = min(TIFF_TILE_EDGE, output_height - y_offset)
        for x_offset in range(0, selection["width"], TIFF_TILE_EDGE):
            width = min(TIFF_TILE_EDGE, selection["width"] - x_offset)
            tile = np.full((height, width, channels), 65_535, dtype=np.uint16)
            source_height = max(0, min(height, selection["height"] - y_offset))
            if source_height:
                if metadata.sample_semantics == "none":
                    arrays = {
                        display.channel: _read_plane_or_projection(
                            session,
                            metadata,
                            x=x_start + x_offset,
                            y=y_start + y_offset,
                            width=width,
                            height=source_height,
                            t=selection["t"],
                            channel=display.channel,
                            level=0,
                            z_start=selection["z"],
                            z_stop=selection.get("z_stop", selection["z"] + 1),
                            projection=projection,
                            cancellation_check=None,
                        )
                        for display in settings
                    }
                    pixels = render_channel_composite(arrays, settings, bit_depth=16)
                    tile_precision = "direct-float64-composite-to-uint16"
                else:
                    pixels, tile_precision = _rgb_tiff_tile(
                        session,
                        metadata,
                        NativeSelection(
                            x=x_start + x_offset,
                            y=y_start + y_offset,
                            width=width,
                            height=source_height,
                            t=selection["t"],
                            c=0,
                            z=selection["z"],
                            level=0,
                            series=metadata.selected_series,
                            expected_sha256=metadata.sha256,
                        ),
                        embedded_icc,
                        settings[0],
                    )
                if precision and precision[0] != tile_precision:
                    raise ValueError("Rendered TIFF precision policy changed between tiles")
                if not precision:
                    precision.append(tile_precision)
                expected = (source_height, width, channels)
                if pixels.shape != expected or pixels.dtype != np.uint16:
                    raise ValueError("Rendered TIFF tile has an inconsistent shape or dtype")
                tile[:source_height] = pixels
            if footer is not None and y_offset + height > selection["height"]:
                footer_start = max(0, y_offset - selection["height"])
                tile_start = max(0, selection["height"] - y_offset)
                footer_rows = height - tile_start
                tile[tile_start:] = footer[
                    footer_start : footer_start + footer_rows,
                    x_offset : x_offset + width,
                ]
            yield np.ascontiguousarray(tile)


def _sha256_stream(stream: Any) -> str:
    stream.flush()
    stream.seek(0)
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    stream.seek(0, os.SEEK_END)
    return digest.hexdigest()


def _atomic_tiff_write(
    destination: str | Path,
    *,
    writer: Callable[[Any], None],
    before_publish: Callable[[Path], None],
) -> tuple[Path, str, int]:
    target = Path(destination).expanduser()
    if not target.is_absolute():
        raise ValueError("Rendered TIFF destination must be absolute")
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    if target.exists() or target.is_symlink():
        raise ValueError("Rendered TIFF destination must be absent")
    parent_identity = (parent.stat().st_dev, parent.stat().st_ino)
    descriptor, temporary = tempfile.mkstemp(prefix=".loci-rendered-", suffix=".tiff", dir=parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w+b") as stream:
            writer(stream)
            _sync_stream(stream)
            digest = _sha256_stream(stream)
            byte_length = int(os.fstat(stream.fileno()).st_size)
        before_publish(temporary_path)
        current = parent.stat()
        if (current.st_dev, current.st_ino) != parent_identity:
            raise ValueError("Rendered TIFF destination directory changed before publication")
        _rename_noreplace(temporary_path, target)
        _fsync_directory(parent)
    finally:
        with suppress(FileNotFoundError):
            temporary_path.unlink()
    return target, digest, byte_length


def _export_tiff(
    workbench: Workbench,
    source: dict[str, Any],
    view: dict[str, Any],
    destination: str | Path,
    figure: _FigureOptions,
) -> dict[str, Any]:
    session = workbench._session(source["id"])
    metadata, selection, projection, settings = _tiff_plan(session, view)
    channels = 4 if metadata.sample_semantics == "RGBA" else 3
    geometry = session.geometry(selection, False).to_dict()
    legend = _resolved_legend(figure, metadata, settings)
    footer, footer_record = _render_footer(
        width=selection["width"],
        image_height=selection["height"],
        channels=channels,
        bit_depth=16,
        options=figure,
        geometry=geometry,
        legend=legend,
    )
    output_height = selection["height"] + (0 if footer is None else int(footer.shape[0]))
    padded_width = math.ceil(selection["width"] / TIFF_TILE_EDGE) * TIFF_TILE_EDGE
    padded_height = math.ceil(output_height / TIFF_TILE_EDGE) * TIFF_TILE_EDGE
    estimated_bytes = padded_width * padded_height * channels * 2 + 16 * 1024**2
    if estimated_bytes > MAX_RENDERED_TIFF_BYTES:
        raise ValueError(
            "Rendered TIFF exceeds Loci's 64 GiB output guard; export a smaller source region"
        )
    parent = Path(destination).expanduser().parent.resolve(strict=True)
    if shutil.disk_usage(parent).free < estimated_bytes + MIN_FREE_BYTES_AFTER_EXPORT:
        raise ValueError("Rendered TIFF needs more free destination storage")
    embedded_icc = session.display_icc() if hasattr(session, "display_icc") else None
    display = _display_payload(settings)
    basis = {"mode": "explicit", "viewport_dependent": False}
    display_revision = _revision(metadata, display, basis)
    color_policy = asdict(metadata.rgb_color_policy) if metadata.rgb_color_policy else None
    if metadata.sample_semantics == "none":
        precision_policy = "direct-float64-composite-to-uint16"
    elif np.dtype(metadata.channel_dtypes[0]) == np.dtype(np.uint16):
        resolved_display = settings[0]
        precision_policy = (
            "native-uint16-display-codes"
            if resolved_display.low == 0
            and resolved_display.high == 65_535
            and resolved_display.gamma == 1
            else "adjusted-uint16-display-codes"
        )
    else:
        precision_policy = "uint8-display-expanded-to-uint16"
    provenance = {
        "schema": "loci.rendered-source/v3",
        "software": {
            "engine": ENGINE_VERSION,
            "numpy": np.__version__,
            "pillow": PILLOW_VERSION,
            "tifffile": tifffile.__version__,
        },
        "source_sha256": source["sha256"],
        "meaning": "display RGB uint16; not original-value quantitative data",
        "annotations_included": False,
        "sampling": "full-resolution source plane"
        if (
            selection["x"] == 0
            and selection["y"] == 0
            and selection["width"] == metadata.dimensions.x
            and selection["height"] == metadata.dimensions.y
        )
        else "selected full-resolution source grid",
        "selection": selection,
        "projection": projection,
        "display": display,
        "display_revision": display_revision,
        "display_basis": basis,
        "geometry": geometry,
        "rgb_color_policy": color_policy,
        "precision_policy": precision_policy,
        "figure": {
            "request": figure.request_payload(),
            "request_sha256": hashlib.sha256(
                canonical_json(
                    {
                        "view": {key: value for key, value in view.items() if key != "source_id"},
                        "figure": figure.request_payload(),
                    }
                ).encode()
            ).hexdigest(),
            "source_raster": {"width": selection["width"], "height": selection["height"]},
            "output_raster": {"width": selection["width"], "height": output_height},
            "footer": footer_record,
        },
        "output": {
            "dtype": "uint16",
            "channels": channels,
            "axes": "YXS",
            "width": selection["width"],
            "height": output_height,
            "dpi": figure.dpi,
            "resolution_unit": "inch",
            "tile_yx": [TIFF_TILE_EDGE, TIFF_TILE_EDGE],
        },
    }
    description = canonical_json(provenance)
    precision_seen: list[str] = []
    output_icc = None
    if (
        metadata.sample_semantics == "none"
        or color_policy
        and color_policy["display_space"] == "sRGB"
    ):
        output_icc = srgb_output_profile_bytes()

    def writer(stream: Any) -> None:
        extra_tags = (
            []
            if output_icc is None
            else [
                (34675, "B", len(output_icc), output_icc, False),
            ]
        )
        with tifffile.TiffWriter(
            _NamedBinaryStream(stream, Path(destination).name),
            bigtiff=estimated_bytes >= 2**32 - 32 * 1024**2,
        ) as tif:
            tif.write(
                _tiff_tiles(
                    session,
                    metadata,
                    selection,
                    projection,
                    settings,
                    embedded_icc,
                    precision_seen,
                    footer,
                ),
                shape=(output_height, selection["width"], channels),
                dtype=np.uint16,
                photometric="rgb",
                planarconfig="contig",
                tile=(TIFF_TILE_EDGE, TIFF_TILE_EDGE),
                extrasamples="unassalpha" if channels == 4 else None,
                metadata=None,
                description=description,
                resolution=(figure.dpi, figure.dpi),
                resolutionunit="INCH",
                extratags=extra_tags,
            )

    def before_publish(temporary: Path) -> None:
        # Rehash the immutable input after the final tile and before the
        # no-overwrite rename. This also detects changes outside the open session.
        if not precision_seen or precision_seen[0] != precision_policy:
            raise ValueError("Rendered TIFF precision policy was not exercised")
        if temporary.stat().st_size > estimated_bytes:
            raise ValueError("Rendered TIFF exceeded its preflight output estimate")
        if workbench.project.source(source["id"], verify=True)["sha256"] != source["sha256"]:
            raise ValueError("Rendered TIFF source changed during export")
        with tifffile.TiffFile(temporary) as tif:
            if len(tif.pages) != 1:
                raise ValueError("Rendered TIFF did not produce exactly one image plane")
            page = tif.pages[0]
            if tuple(page.shape) != (output_height, selection["width"], channels):
                raise ValueError("Rendered TIFF dimensions changed before publication")
            if page.dtype != np.dtype(np.uint16) or not page.is_tiled:
                raise ValueError("Rendered TIFF is not a tiled uint16 image")
            if page.description != description:
                raise ValueError("Rendered TIFF provenance changed before publication")

    target, digest, byte_length = _atomic_tiff_write(
        destination, writer=writer, before_publish=before_publish
    )
    return {
        "schema": provenance["schema"],
        "basename": target.name,
        "sha256": digest,
        "width": selection["width"],
        "height": output_height,
        "image_width": selection["width"],
        "image_height": selection["height"],
        "sampling": provenance["sampling"],
        "format": "tiff",
        "dtype": "uint16",
        "channels": channels,
        "display_revision": display_revision,
        "dpi": figure.dpi,
        "provenance_sha256": hashlib.sha256(description.encode()).hexdigest(),
    }


def _export_png(
    workbench: Workbench,
    source: dict[str, Any],
    view: dict[str, Any],
    destination: str | Path,
    figure: _FigureOptions,
) -> dict[str, Any]:
    session = workbench._session(source["id"])
    source_metadata = getattr(session, "metadata", None)
    if not isinstance(source_metadata, NativeImageMetadata):
        raise ValueError("Rendered PNG source metadata is invalid")
    settings = _request_settings(view.get("channels"), source_metadata)
    legend = _resolved_legend(figure, source_metadata, settings)
    rendered = workbench.execute("viewer_tile", view)
    if rendered["source_sha256"] != source["sha256"]:
        raise ValueError("Rendered export lost source identity")
    prefix = "data:image/png;base64,"
    if not rendered["image"].startswith(prefix):
        raise ValueError("Rendered export did not produce PNG pixels")
    encoded = base64.b64decode(rendered["image"][len(prefix) :], validate=True)
    with Image.open(io.BytesIO(encoded)) as image:
        image.load()
        source_width, source_height = image.size
        source_pixels = np.asarray(image)
        image_channels = 1 if source_pixels.ndim == 2 else int(source_pixels.shape[-1])
        footer, footer_record = _render_footer(
            width=image.width,
            image_height=image.height,
            channels=image_channels,
            bit_depth=8,
            options=figure,
            geometry=rendered["geometry"],
            legend=legend,
        )
        if footer is not None:
            if source_pixels.ndim != 3 or source_pixels.shape[-1] != 3:
                raise ValueError("Publication footers require a rendered RGB image")
            output_pixels = np.concatenate((source_pixels, footer), axis=0)
            output_image = Image.fromarray(output_pixels, mode="RGB")
        else:
            output_image = image.copy()
        width, height = output_image.size
        provenance = {
            "schema": "loci.rendered-source/v3",
            "software": {
                "engine": ENGINE_VERSION,
                "numpy": np.__version__,
                "pillow": PILLOW_VERSION,
                "tifffile": tifffile.__version__,
            },
            "source_sha256": source["sha256"],
            "meaning": "display RGB; not original-value quantitative data",
            "annotations_included": False,
            "sampling": "full-extent overview" if view.get("overview") else "selected source grid",
            "request": {key: value for key, value in view.items() if key != "source_id"},
            "rendering": {
                key: value for key, value in rendered.items() if key not in {"image", "source_id"}
            },
            "figure": {
                "request": figure.request_payload(),
                "request_sha256": hashlib.sha256(
                    canonical_json(
                        {
                            "view": {
                                key: value for key, value in view.items() if key != "source_id"
                            },
                            "figure": figure.request_payload(),
                        }
                    ).encode()
                ).hexdigest(),
                "source_raster": {"width": image.width, "height": image.height},
                "output_raster": {"width": width, "height": height},
                "geometry": rendered["geometry"],
                "footer": footer_record,
            },
            "output": {
                "dtype": "uint8",
                "channels": image_channels,
                "axes": "YXS",
                "width": width,
                "height": height,
                "dpi": figure.dpi,
                "resolution_unit": "inch",
            },
        }
        description = canonical_json(provenance)
        metadata = PngImagePlugin.PngInfo()
        metadata.add_itxt("Loci rendering provenance", description)
        output = io.BytesIO()
        output_image.save(
            output,
            format="PNG",
            pnginfo=metadata,
            icc_profile=srgb_output_profile_bytes(),
            dpi=(figure.dpi, figure.dpi),
        )
    if workbench.project.source(source["id"], verify=True)["sha256"] != source["sha256"]:
        raise ValueError("Rendered PNG source changed during export")
    target, digest = _atomic_write(destination, output.getvalue())
    return {
        "schema": provenance["schema"],
        "basename": target.name,
        "sha256": digest,
        "width": width,
        "height": height,
        "image_width": source_width,
        "image_height": source_height,
        "sampling": provenance["sampling"],
        "format": "png",
        "dtype": "uint8",
        "channels": image_channels,
        "display_revision": rendered["display_revision"],
        "dpi": figure.dpi,
        "provenance_sha256": hashlib.sha256(description.encode()).hexdigest(),
    }


def export_rendered_source(
    workbench: Workbench, request: dict[str, Any], destination: str | Path
) -> dict[str, Any]:
    exact_keys(request, {"source_id", "source_sha256", "format", "view"}, "rendered source export")
    source = workbench.project.source(checked_id(request.get("source_id")), verify=True)
    if request.get("source_sha256") != source["sha256"]:
        raise ValueError("Rendered export source changed; reopen an intact copy")
    view_value = request.get("view")
    if not isinstance(view_value, dict) or view_value.get("source_id") != source["id"]:
        raise ValueError("Rendered export view must match its source")
    view, figure = _figure_options(view_value)
    export_format = request.get("format")
    target = Path(destination)
    if export_format == "png":
        if target.suffix.lower() != ".png":
            raise ValueError("Rendered PNG destination must use a .png suffix")
        return _export_png(workbench, source, view, destination, figure)
    if export_format == "tiff":
        if target.suffix.lower() not in {".tif", ".tiff"}:
            raise ValueError("Rendered TIFF destination must use a .tif or .tiff suffix")
        return _export_tiff(workbench, source, view, destination, figure)
    raise ValueError("Rendered source export format must be png or tiff")
