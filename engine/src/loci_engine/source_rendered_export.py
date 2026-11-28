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
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import tifffile
from PIL import Image, ImageDraw, PngImagePlugin
from PIL import __version__ as PILLOW_VERSION

from .export import _fsync_directory, _NamedBinaryStream, _rename_noreplace, _sync_stream
from .figure_fonts import verified_figure_font
from .models import ENGINE_VERSION
from .native_image import (
    DEFAULT_NATIVE_READ_BUDGET_BYTES,
    NativeImageMetadata,
    NativeSelection,
    srgb_output_profile_bytes,
)
from .quantitative import exact_keys
from .research_interchange import _atomic_write
from .research_project import canonical_json, checked_id
from .viewer_display import render_channel_composite
from .viewer_image import (
    MAX_PROJECTION_PLANES,
    MAX_VIEWER_WORKING_BYTES,
    SOURCE_TILE_EDGE,
    _display_payload,
    _read_plane_or_projection,
    _read_rgb_display,
    _request_settings,
    _retained_scalar_bytes_per_pixel,
    _revision,
    prepare_viewer_scalar_planes,
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
SPLIT_LAYOUTS = frozenset({"channels-and-merge-row", "channels-and-merge-column"})
VALID_LAYOUTS = frozenset({"merge", *SPLIT_LAYOUTS})
MIN_SPLIT_PANEL_WIDTH = 64
MAX_HEADER_PIXELS = 4 * 1024**2
MAX_SPLIT_PNG_PIXELS = 32 * 1024**2
ACCESSIBILITY_NOTE = (
    "Separate named grayscale channels alongside a multichannel merge aid inspection "
    "across color vision differences; no single color palette is universally color-blind-safe."
)
_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_PHYSICAL_TO_MICROMETRES = {"nm": 1e-3, "um": 1.0, "µm": 1.0, "μm": 1.0, "mm": 1e3, "m": 1e6}


@dataclass(frozen=True, slots=True)
class _FigureOptions:
    dpi: int
    scale_bar: bool
    channel_legend: bool
    channel_labels: tuple[dict[str, Any], ...]
    layout: str = "merge"
    invert_grayscale: bool = False

    @property
    def is_split(self) -> bool:
        return self.layout in SPLIT_LAYOUTS

    def request_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "dpi": self.dpi,
            "scale_bar": self.scale_bar,
            "channel_legend": self.channel_legend,
            "channel_labels": [dict(item) for item in self.channel_labels],
        }
        if self.layout != "merge" or self.invert_grayscale:
            payload["layout"] = self.layout
            payload["invert_grayscale"] = self.invert_grayscale
        return payload


def _figure_options(view: dict[str, Any]) -> tuple[dict[str, Any], _FigureOptions]:
    render_view = dict(view)
    raw = render_view.pop("figure", None)
    if raw is None:
        return render_view, _FigureOptions(DEFAULT_EXPORT_DPI, False, False, ())
    exact_keys(
        raw,
        {"dpi", "scale_bar", "channel_legend", "channel_labels", "layout", "invert_grayscale"},
        "rendered figure",
    )
    dpi = _integer(raw.get("dpi", DEFAULT_EXPORT_DPI), "dpi", MIN_EXPORT_DPI, MAX_EXPORT_DPI)
    scale_bar = raw.get("scale_bar", False)
    channel_legend = raw.get("channel_legend", False)
    if not isinstance(scale_bar, bool) or not isinstance(channel_legend, bool):
        raise ValueError("Rendered figure options must use boolean scale-bar and legend choices")
    layout = raw.get("layout", "merge")
    if not isinstance(layout, str) or layout not in VALID_LAYOUTS:
        raise ValueError(
            "Rendered figure layout must be merge, channels-and-merge-row, "
            "or channels-and-merge-column"
        )
    invert_grayscale = raw.get("invert_grayscale", False)
    if not isinstance(invert_grayscale, bool):
        raise ValueError("Inverted grayscale option must be boolean")
    if invert_grayscale and layout == "merge":
        raise ValueError("Inverted grayscale applies only to separate grayscale channel panels")
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
    requires_labels = channel_legend or layout in SPLIT_LAYOUTS
    if requires_labels != bool(normalized):
        raise ValueError(
            "Channel labels must be present exactly when the legend or split-channel layout "
            "is enabled"
            if layout in SPLIT_LAYOUTS
            else "Channel legend entries must be present exactly when the legend is enabled"
        )
    return render_view, _FigureOptions(
        dpi, scale_bar, channel_legend, tuple(normalized), layout, invert_grayscale
    )


def _resolved_channel_labels(
    options: _FigureOptions,
    metadata: NativeImageMetadata,
    settings: tuple[Any, ...],
) -> tuple[dict[str, Any], ...]:
    if not options.channel_legend and not options.is_split:
        return ()
    if metadata.sample_semantics != "none":
        if options.is_split:
            raise ValueError(
                "Separate grayscale channel panels require scalar source channels; "
                "interleaved RGB samples are not independent channels"
            )
        raise ValueError("Channel legends require independently mapped scalar source channels")
    visible = [setting for setting in settings if setting.visible and setting.opacity > 0]
    if options.is_split and len(visible) < 2:
        raise ValueError(
            "Separate grayscale channels alongside a merge require at least two visible "
            "scalar channels"
        )
    by_channel = {item["channel"]: item for item in options.channel_labels}
    if set(by_channel) != {setting.channel for setting in visible}:
        raise ValueError(
            "Channel panel labels must match the currently visible source channels"
            if options.is_split
            else "Channel legend entries must match the currently visible source channels"
        )
    for setting in visible:
        if by_channel[setting.channel]["color"] != setting.color_hex:
            raise ValueError(
                "Channel panel colors must match the current display mapping"
                if options.is_split
                else "Channel legend colors must match the current display mapping"
            )
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


@dataclass(frozen=True, slots=True)
class _FooterPlan:
    height: int
    font_bytes: int
    record: dict[str, Any]
    render: Callable[[], np.ndarray]


def _plan_footer(
    *,
    width: int,
    image_height: int,
    channels: int,
    bit_depth: int,
    options: _FigureOptions,
    geometry: dict[str, Any],
    legend: tuple[dict[str, Any], ...],
    scale_reference_width: int | None = None,
    scale_applies_to: str | None = None,
    channel_windows: dict[int, str] | None = None,
) -> _FooterPlan | None:
    if not options.scale_bar and not legend:
        return None
    if channels == 4:
        raise ValueError("RGBA rendered figures do not support a publication footer")
    spacing_um = _scale_micrometres_per_pixel(geometry) if options.scale_bar else None
    if width < MIN_FOOTER_WIDTH:
        raise ValueError(
            f"A publication footer requires an export at least {MIN_FOOTER_WIDTH} pixels wide"
        )
    font_size = max(10, min(round(options.dpi * 10 / 72), max(10, width // 14)))
    printed_labels = [entry["name"] for entry in legend]
    if channel_windows:
        printed_labels.extend(channel_windows.values())
    if options.scale_bar:
        printed_labels.append("0123456789.e+- nm µm mm")
    font, font_identity = verified_figure_font(font_size, printed_labels, allow_embedded=True)
    measure = ImageDraw.Draw(Image.new("L", (1, 1)))
    text_box = measure.textbbox((0, 0), "Ag", font=font)
    line_height = max(12, text_box[3] - text_box[1] + max(3, font_size // 4))
    padding = max(6, min(round(options.dpi * 0.06), width // 12))
    swatch = max(8, min(line_height - 3, round(options.dpi * 0.06)))
    text_width = width - 3 * padding - swatch
    if text_width < 32:
        raise ValueError("The rendered figure is too narrow for its channel legend")
    wrapped = []
    for entry in legend:
        display_text = entry["name"]
        if channel_windows and entry["channel"] in channel_windows:
            display_text = f"{display_text} ({channel_windows[entry['channel']]})"
        wrapped.append((entry, _wrap_text(measure, display_text, font, text_width)))
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
    y = padding
    scale_record: dict[str, Any] | None = None
    scale_text: tuple[int, int, str] | None = None
    if options.scale_bar:
        assert spacing_um is not None
        ref_width = width if scale_reference_width is None else scale_reference_width
        # Size the bar against one image even if the footer spans several panels.
        ref_padding = min(padding, max(6, ref_width // 12))
        target_pixels = max(32, min(ref_width // 4, ref_width - 2 * ref_padding))
        label_um = _nice_scale_length(target_pixels * spacing_um)
        bar_pixels = max(1, round(label_um / spacing_um))
        if bar_pixels < 16 or bar_pixels > ref_width - 2 * ref_padding:
            raise ValueError("The export is too narrow for a trustworthy calibrated scale bar")
        thickness = max(2, min(round(options.dpi / 72), line_height // 3))
        bar_y = y + max(0, (line_height - thickness) // 2)
        label = _format_micrometres(label_um)
        text_x = padding + bar_pixels + padding
        if text_x + measure.textlength(label, font=font) > width - padding:
            raise ValueError("The export is too narrow for its calibrated scale-bar label")
        scale_text = (text_x, y, label)
        scale_record = {
            "label": label,
            "label_length_um": label_um,
            "represented_length_um": bar_pixels * spacing_um,
            "micrometres_per_output_pixel": spacing_um,
            "bar_xywh": [padding, image_height + bar_y, bar_pixels, thickness],
        }
        if scale_applies_to is not None:
            scale_record["applies_to"] = scale_applies_to
        y += scale_height
    legend_records: list[dict[str, Any]] = []
    legend_text: list[tuple[int, list[str]]] = []
    for entry, lines in wrapped:
        row_height = max(line_height, len(lines) * line_height)
        swatch_y = y + max(0, (line_height - swatch) // 2)
        legend_records.append(
            {**entry, "swatch_xywh": [padding, image_height + swatch_y, swatch, swatch]}
        )
        legend_text.append((y, lines))
        y += row_height

    def render() -> np.ndarray:
        footer = np.full((height, width, 3), maximum, dtype=dtype)

        def paint_text(text_x: int, text_y: int, label: str) -> None:
            mask = Image.new("L", (width, height), 0)
            ImageDraw.Draw(mask).text((text_x, text_y), label, fill=255, font=font)
            _apply_mask(footer, mask, (0, 0, 0))

        if scale_record is not None:
            assert scale_text is not None
            x, y, bar_width, thickness = scale_record["bar_xywh"]
            y -= image_height
            footer[y : y + thickness, x : x + bar_width] = 0
            paint_text(*scale_text)
        for entry, (text_y, lines) in zip(legend_records, legend_text, strict=True):
            x, y, swatch_width, swatch_height = entry["swatch_xywh"]
            y -= image_height
            color = tuple(int(entry["color"][index : index + 2], 16) for index in (1, 3, 5))
            footer[y : y + swatch_height, x : x + swatch_width] = (
                np.asarray(color, dtype=np.uint32) * (maximum // 255)
            ).astype(dtype)
            for line_index, line in enumerate(lines):
                paint_text(padding * 2 + swatch, text_y + line_index * line_height, line)
        return footer

    return _FooterPlan(
        height,
        2 * len(font.font_bytes),  # Allow both the Python buffer and FreeType's copy.
        {
            "placement": "below-source-raster",
            "font": font_identity,
            "offset_y": image_height,
            "width": width,
            "height": height,
            "background": "#ffffff",
            "scale_bar": scale_record,
            "channel_legend": legend_records,
        },
        render,
    )


def _render_grayscale_panel(
    array: np.ndarray,
    display: Any,
    *,
    bit_depth: Literal[8, 16],
    invert: bool,
) -> np.ndarray:
    pixels = render_channel_composite(
        {display.channel: array},
        (replace(display, color_rgb=(1.0, 1.0, 1.0), visible=True),),
        bit_depth=bit_depth,
    )
    if not invert:
        return pixels
    maximum = 255 if bit_depth == 8 else 65_535
    return (maximum - pixels.astype(np.int32)).astype(pixels.dtype)


def _format_display_number(value: float) -> str:
    if value == 0:
        return "0"
    if float(value).is_integer() and abs(value) < 1e12:
        return str(int(value))
    return f"{value:.6g}"


def _window_label(display: Any, *, invert: bool) -> str:
    prefix = "inv. gray" if invert else "gray"
    low = _format_display_number(float(display.low))
    high = _format_display_number(float(display.high))
    gamma = _format_display_number(float(display.gamma))
    text = f"{prefix} \u00b7 {low}-{high} \u00b7 gamma {gamma}"
    if display.opacity < 1.0:
        text += f" \u00b7 opacity {_format_display_number(float(display.opacity))}"
    return text


@dataclass(frozen=True, slots=True)
class _SplitPanel:
    index: int
    kind: Literal["grayscale", "merge"]
    name: str
    header_xywh: tuple[int, int, int, int]
    raster_xywh: tuple[int, int, int, int]
    setting: Any | None
    merge_color: str | None
    tone: str | None
    window_label: str | None
    channels: tuple[int, ...]
    colors: tuple[str, ...]

    def provenance(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "index": self.index,
            "kind": self.kind,
            "name": self.name,
            "header_xywh": list(self.header_xywh),
            "raster_xywh": list(self.raster_xywh),
        }
        if self.kind == "grayscale":
            assert self.setting is not None
            payload.update(
                {
                    "channel": self.setting.channel,
                    "merge_color": self.merge_color,
                    "tone": self.tone,
                    "window": {
                        "low": self.setting.low,
                        "high": self.setting.high,
                        "gamma": self.setting.gamma,
                        "opacity": self.setting.opacity,
                    },
                    "window_label": self.window_label,
                }
            )
        else:
            payload.update(
                {
                    "channels": list(self.channels),
                    "colors": list(self.colors),
                    "meaning": "multichannel merge display; not original-value quantitative data",
                }
            )
        return payload


@dataclass(frozen=True, slots=True)
class _SplitLayoutPlan:
    layout: str
    panel_width: int
    panel_height: int
    header_height: int
    header_font: dict[str, str]
    header_font_bytes: int
    grout: int
    margin: int
    border: int
    content_width: int
    content_height: int
    panels: tuple[_SplitPanel, ...]
    channel_windows: dict[int, str]


def _split_border_boxes(
    raster_xywh: tuple[int, int, int, int],
) -> tuple[tuple[int, int, int, int], ...]:
    px, py, pw, ph = raster_xywh
    return (
        (px - 1, py - 1, pw + 2, 1),
        (px - 1, py + ph, pw + 2, 1),
        (px - 1, py, 1, ph),
        (px + pw, py, 1, ph),
    )


def _plan_split_layout(
    *,
    panel_width: int,
    panel_height: int,
    bit_depth: Literal[8, 16],
    options: _FigureOptions,
    visible_settings: tuple[Any, ...],
    legend: tuple[dict[str, Any], ...],
) -> tuple[_SplitLayoutPlan, Callable[[], Iterator[np.ndarray]]]:
    if panel_width < MIN_SPLIT_PANEL_WIDTH:
        raise ValueError(
            f"Separate grayscale channel panels require an image at least "
            f"{MIN_SPLIT_PANEL_WIDTH} pixels wide"
        )
    labels_by_channel = {entry["channel"]: entry for entry in legend}
    border = 1 if options.invert_grayscale else 0
    grout = max(
        6 if border else 4,
        min(24, round(options.dpi * 0.04), max(6, min(panel_width, panel_height) // 16)),
    )
    margin = grout

    title_font_size = max(10, min(round(options.dpi * 9 / 72), max(10, panel_width // 12)))
    meta_font_size = max(9, min(round(options.dpi * 7.5 / 72), max(9, title_font_size - 2)))
    printed_labels = [entry["name"] for entry in legend]
    printed_labels.append("Merge display only inv. gray · gamma opacity 0123456789e+-")
    title_font, font_identity = verified_figure_font(
        title_font_size, printed_labels, allow_embedded=True
    )
    meta_font = title_font.font_variant(size=meta_font_size)
    measure = ImageDraw.Draw(Image.new("L", (1, 1)))
    title_box = measure.textbbox((0, 0), "AgQpy", font=title_font)
    meta_box = measure.textbbox((0, 0), "AgQpy", font=meta_font)
    title_offset = max(0, -title_box[1])
    meta_offset = max(0, -meta_box[1])
    title_line_height = max(12, title_box[3] + title_offset + max(2, title_font_size // 5))
    meta_line_height = max(11, meta_box[3] + meta_offset + max(2, meta_font_size // 5))
    padding = max(4, min(round(options.dpi * 0.04), panel_width // 16))
    text_width = panel_width - 2 * padding

    channel_windows = {
        setting.channel: _window_label(setting, invert=options.invert_grayscale)
        for setting in visible_settings
    }
    channel_specs: list[tuple[Any, str, str, list[str], list[str], int]] = []
    max_header_height = 0
    for setting in visible_settings:
        name = labels_by_channel[setting.channel]["name"]
        window_text = channel_windows[setting.channel]
        title_lines = _wrap_text(measure, name, title_font, text_width)
        meta_lines = _wrap_text(measure, window_text, meta_font, text_width)
        needed = (
            padding
            + len(title_lines) * title_line_height
            + len(meta_lines) * meta_line_height
            + padding
        )
        max_header_height = max(max_header_height, needed)
        channel_specs.append((setting, name, window_text, title_lines, meta_lines, needed))

    merge_title_lines = _wrap_text(measure, "Merge", title_font, text_width)
    swatch = max(6, min(meta_line_height - 4, round(options.dpi * 0.045)))
    swatch_gap = max(3, swatch // 2)
    swatch_positions: list[tuple[int, int, str]] = []
    swatch_row = 0
    sx = 0
    last_row_end = 0
    for setting in visible_settings:
        if sx > 0 and sx + swatch > text_width:
            swatch_row += 1
            sx = 0
        swatch_positions.append((swatch_row, sx, setting.color_hex))
        last_row_end = sx + swatch
        sx += swatch + swatch_gap
    swatch_rows = swatch_row + 1
    display_note = "display only"
    inline_note = (
        swatch_rows == 1
        and last_row_end + swatch_gap + measure.textlength(display_note, font=meta_font)
        <= text_width
    )
    merge_meta_lines = (
        [] if inline_note else _wrap_text(measure, display_note, meta_font, text_width)
    )
    merge_needed = (
        padding
        + len(merge_title_lines) * title_line_height
        + swatch_rows * meta_line_height
        + len(merge_meta_lines) * meta_line_height
        + padding
    )
    header_height = max(max_header_height, merge_needed)
    panel_count = len(visible_settings) + 1
    if header_height > 1024 or panel_count * panel_width * header_height > MAX_HEADER_PIXELS:
        raise ValueError(
            "Split-channel panel headers exceed the bounded size; use shorter channel names"
        )

    def render_headers() -> Iterator[np.ndarray]:
        dtype = np.uint8 if bit_depth == 8 else np.uint16
        maximum = int(np.iinfo(dtype).max)

        for _setting, _name, _window_text, title_lines, meta_lines, _needed in channel_specs:
            header = np.full((header_height, panel_width, 3), maximum, dtype=dtype)
            y = padding
            mask = Image.new("L", (panel_width, header_height), 0)
            draw = ImageDraw.Draw(mask)
            for line in title_lines:
                draw.text((padding, y + title_offset), line, fill=255, font=title_font)
                y += title_line_height
            for line in meta_lines:
                draw.text((padding, y + meta_offset), line, fill=255, font=meta_font)
                y += meta_line_height
            _apply_mask(header, mask, (0, 0, 0))
            yield header
            del header, mask, draw

        merge_header = np.full((header_height, panel_width, 3), maximum, dtype=dtype)
        y = padding
        mask = Image.new("L", (panel_width, header_height), 0)
        draw = ImageDraw.Draw(mask)
        for line in merge_title_lines:
            draw.text((padding, y + title_offset), line, fill=255, font=title_font)
            y += title_line_height
        swatch_top = y
        for row_index, rel_x, color_hex in swatch_positions:
            swatch_y = (
                swatch_top + row_index * meta_line_height + max(0, (meta_line_height - swatch) // 2)
            )
            swatch_x = padding + rel_x
            rgb = tuple(int(color_hex[idx : idx + 2], 16) for idx in (1, 3, 5))
            merge_header[swatch_y : swatch_y + swatch, swatch_x : swatch_x + swatch] = (
                np.asarray(rgb, dtype=np.uint32) * (maximum // 255)
            ).astype(dtype)
        if inline_note:
            draw.text(
                (padding + last_row_end + swatch_gap, swatch_top + meta_offset),
                display_note,
                fill=255,
                font=meta_font,
            )
        else:
            note_y = swatch_top + swatch_rows * meta_line_height
            for line in merge_meta_lines:
                draw.text((padding, note_y + meta_offset), line, fill=255, font=meta_font)
                note_y += meta_line_height
        _apply_mask(merge_header, mask, (0, 0, 0))
        yield merge_header

    if options.layout == "channels-and-merge-row":
        content_width = 2 * margin + panel_count * panel_width + (panel_count - 1) * grout
        content_height = 2 * margin + header_height + border + panel_height
    else:
        content_width = 2 * margin + panel_width
        block_height = header_height + border + panel_height
        content_height = 2 * margin + panel_count * block_height + (panel_count - 1) * grout

    def _panel_coords(index: int) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
        if options.layout == "channels-and-merge-row":
            px = margin + index * (panel_width + grout)
            hy = margin
            py = margin + header_height + border
        else:
            px = margin
            hy = margin + index * (header_height + border + panel_height + grout)
            py = hy + header_height + border
        return (px, hy, panel_width, header_height), (px, py, panel_width, panel_height)

    panels: list[_SplitPanel] = []
    for index, (setting, name, window_text, _, _, _) in enumerate(channel_specs):
        header_xywh, raster_xywh = _panel_coords(index)
        panels.append(
            _SplitPanel(
                index=index,
                kind="grayscale",
                name=name,
                header_xywh=header_xywh,
                raster_xywh=raster_xywh,
                setting=setting,
                merge_color=setting.color_hex,
                tone="inverted-grayscale" if options.invert_grayscale else "grayscale",
                window_label=window_text,
                channels=(setting.channel,),
                colors=(setting.color_hex,),
            )
        )
    merge_header_xywh, merge_raster_xywh = _panel_coords(len(channel_specs))
    panels.append(
        _SplitPanel(
            index=len(channel_specs),
            kind="merge",
            name="Merge",
            header_xywh=merge_header_xywh,
            raster_xywh=merge_raster_xywh,
            setting=None,
            merge_color=None,
            tone=None,
            window_label=None,
            channels=tuple(setting.channel for setting in visible_settings),
            colors=tuple(setting.color_hex for setting in visible_settings),
        )
    )
    return _SplitLayoutPlan(
        layout=options.layout,
        panel_width=panel_width,
        panel_height=panel_height,
        header_height=header_height,
        header_font=font_identity,
        header_font_bytes=2 * (len(title_font.font_bytes) + len(meta_font.font_bytes)),
        grout=grout,
        margin=margin,
        border=border,
        content_width=content_width,
        content_height=content_height,
        panels=tuple(panels),
        channel_windows=channel_windows,
    ), render_headers


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
        len(settings) != 1 or settings[0].channel != c or projection is not None
    ):
        raise ValueError(
            "Interleaved source RGB uses one mapping for the selected logical channel "
            "and no Z projection"
        )
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
    dtype = np.dtype(metadata.channel_dtypes[selection.c])
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
                            c=selection["c"],
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


def _atomic_rendered_write(
    destination: str | Path,
    *,
    suffix: str,
    writer: Callable[[Any], None],
    before_publish: Callable[[Path], None],
) -> tuple[Path, str, int]:
    format_name = "TIFF" if suffix == ".tiff" else "PNG"
    target = Path(destination).expanduser()
    if not target.is_absolute():
        raise ValueError(f"Rendered {format_name} destination must be absolute")
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    if target.exists() or target.is_symlink():
        raise ValueError(f"Rendered {format_name} destination must be absent")
    parent_identity = (parent.stat().st_dev, parent.stat().st_ino)
    descriptor, temporary = tempfile.mkstemp(prefix=".loci-rendered-", suffix=suffix, dir=parent)
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
            raise ValueError(
                f"Rendered {format_name} destination directory changed before publication"
            )
        _rename_noreplace(temporary_path, target)
        _fsync_directory(parent)
    finally:
        with suppress(FileNotFoundError):
            temporary_path.unlink()
    return target, digest, byte_length


def _split_tiff_tiles(
    session: Any,
    metadata: NativeImageMetadata,
    selection: dict[str, int],
    projection: str | None,
    settings: tuple[Any, ...],
    figure: _FigureOptions,
    plan: _SplitLayoutPlan,
    headers: tuple[np.ndarray, ...],
    precision: list[str],
    footer: np.ndarray | None,
) -> Iterator[np.ndarray]:
    x_start, y_start = selection["x"], selection["y"]
    output_width = plan.content_width
    output_height = plan.content_height + (0 if footer is None else int(footer.shape[0]))
    border_code = 34 * 257

    for y_offset in range(0, output_height, TIFF_TILE_EDGE):
        tile_h = min(TIFF_TILE_EDGE, output_height - y_offset)
        for x_offset in range(0, output_width, TIFF_TILE_EDGE):
            tile_w = min(TIFF_TILE_EDGE, output_width - x_offset)
            tile = np.full((tile_h, tile_w, 3), 65_535, dtype=np.uint16)

            if plan.border > 0:
                for panel in plan.panels:
                    if panel.kind != "grayscale":
                        continue
                    for bx, by, bw, bh in _split_border_boxes(panel.raster_xywh):
                        ix0 = max(x_offset, bx)
                        iy0 = max(y_offset, by)
                        ix1 = min(x_offset + tile_w, bx + bw)
                        iy1 = min(y_offset + tile_h, by + bh)
                        if ix0 < ix1 and iy0 < iy1:
                            tile[
                                iy0 - y_offset : iy1 - y_offset,
                                ix0 - x_offset : ix1 - x_offset,
                            ] = border_code

            for panel, header in zip(plan.panels, headers, strict=True):
                hx, hy, hw, hh = panel.header_xywh
                ix0 = max(x_offset, hx)
                iy0 = max(y_offset, hy)
                ix1 = min(x_offset + tile_w, hx + hw)
                iy1 = min(y_offset + tile_h, hy + hh)
                if ix0 < ix1 and iy0 < iy1:
                    tile[
                        iy0 - y_offset : iy1 - y_offset,
                        ix0 - x_offset : ix1 - x_offset,
                    ] = header[iy0 - hy : iy1 - hy, ix0 - hx : ix1 - hx]

                px, py, pw, ph = panel.raster_xywh
                ix0 = max(x_offset, px)
                iy0 = max(y_offset, py)
                ix1 = min(x_offset + tile_w, px + pw)
                iy1 = min(y_offset + tile_h, py + ph)
                if ix0 >= ix1 or iy0 >= iy1:
                    continue
                sw = ix1 - ix0
                sh = iy1 - iy0
                sx = x_start + (ix0 - px)
                sy = y_start + (iy0 - py)
                if panel.kind == "grayscale":
                    assert panel.setting is not None
                    array = _read_plane_or_projection(
                        session,
                        metadata,
                        x=sx,
                        y=sy,
                        width=sw,
                        height=sh,
                        t=selection["t"],
                        channel=panel.setting.channel,
                        level=0,
                        z_start=selection["z"],
                        z_stop=selection.get("z_stop", selection["z"] + 1),
                        projection=projection,
                        cancellation_check=None,
                    )
                    pixels = _render_grayscale_panel(
                        array,
                        panel.setting,
                        bit_depth=16,
                        invert=figure.invert_grayscale,
                    )
                else:
                    arrays = {
                        display.channel: _read_plane_or_projection(
                            session,
                            metadata,
                            x=sx,
                            y=sy,
                            width=sw,
                            height=sh,
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
                if precision and precision[0] != tile_precision:
                    raise ValueError("Rendered TIFF precision policy changed between tiles")
                if not precision:
                    precision.append(tile_precision)
                expected = (sh, sw, 3)
                if pixels.shape != expected or pixels.dtype != np.uint16:
                    raise ValueError("Rendered TIFF tile has an inconsistent shape or dtype")
                tile[
                    iy0 - y_offset : iy1 - y_offset,
                    ix0 - x_offset : ix1 - x_offset,
                ] = pixels

            if footer is not None and y_offset + tile_h > plan.content_height:
                iy0 = max(y_offset, plan.content_height)
                iy1 = min(y_offset + tile_h, output_height)
                footer_start = iy0 - plan.content_height
                footer_end = iy1 - plan.content_height
                tile[iy0 - y_offset : iy1 - y_offset] = footer[
                    footer_start:footer_end,
                    x_offset : x_offset + tile_w,
                ]
            yield np.ascontiguousarray(tile)


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
    legend = _resolved_channel_labels(figure, metadata, settings)
    plan: _SplitLayoutPlan | None = None
    visible_settings = ()
    if figure.is_split:
        visible_settings = tuple(
            setting for setting in settings if setting.visible and setting.opacity > 0
        )
        plan, render_headers = _plan_split_layout(
            panel_width=selection["width"],
            panel_height=selection["height"],
            bit_depth=16,
            options=figure,
            visible_settings=visible_settings,
            legend=legend,
        )
    output_width = selection["width"] if plan is None else plan.content_width
    image_height = selection["height"] if plan is None else plan.content_height
    footer_plan = _plan_footer(
        width=output_width,
        image_height=image_height,
        channels=channels,
        bit_depth=16,
        options=figure,
        geometry=geometry,
        legend=legend if figure.channel_legend else (),
        scale_reference_width=None if plan is None else plan.panel_width,
        scale_applies_to=None if plan is None else "each-panel",
        channel_windows=None if plan is None else plan.channel_windows,
    )
    output_height = image_height + (0 if footer_plan is None else footer_plan.height)
    padded_width = math.ceil(output_width / TIFF_TILE_EDGE) * TIFF_TILE_EDGE
    padded_height = math.ceil(output_height / TIFF_TILE_EDGE) * TIFF_TILE_EDGE
    estimated_bytes = padded_width * padded_height * channels * 2 + 16 * 1024**2
    if estimated_bytes > MAX_RENDERED_TIFF_BYTES:
        raise ValueError(
            "Rendered TIFF exceeds Loci's 64 GiB output guard; export a smaller source region"
        )
    parent = Path(destination).expanduser().parent.resolve(strict=True)
    if shutil.disk_usage(parent).free < estimated_bytes + MIN_FREE_BYTES_AFTER_EXPORT:
        raise ValueError("Rendered TIFF needs more free destination storage")
    headers = ()
    if plan is not None:
        headers = tuple(render_headers())
        del render_headers
    footer = None if footer_plan is None else footer_plan.render()
    footer_record = None if footer_plan is None else footer_plan.record
    del footer_plan
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
    figure_metadata: dict[str, Any] = {
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
        "output_raster": {"width": output_width, "height": output_height},
        "footer": footer_record,
    }
    if plan is not None:
        figure_metadata.update(
            {
                "layout": plan.layout,
                "invert_grayscale": figure.invert_grayscale,
                "accessibility_note": ACCESSIBILITY_NOTE,
                "grout_px": plan.grout,
                "margin_px": plan.margin,
                "panel_border_px": plan.border,
                "header_font": plan.header_font,
                "panels": [panel.provenance() for panel in plan.panels],
            }
        )
    provenance = {
        "schema": "loci.rendered-source/v3",
        "software": {
            "engine": ENGINE_VERSION,
            "numpy": np.__version__,
            "pillow": PILLOW_VERSION,
            "tifffile": tifffile.__version__,
        },
        "source_sha256": source["sha256"],
        "meaning": (
            "display RGB uint16 split-channel figure "
            "(separate named grayscale channels + multichannel merge); "
            "not original-value quantitative data"
            if figure.is_split
            else "display RGB uint16; not original-value quantitative data"
        ),
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
        "palette": asdict(metadata.palette) if metadata.palette is not None else None,
        "precision_policy": precision_policy,
        "figure": figure_metadata,
        "output": {
            "dtype": "uint16",
            "channels": channels,
            "axes": "YXS",
            "width": output_width,
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
        tile_stream = (
            _split_tiff_tiles(
                session,
                metadata,
                selection,
                projection,
                visible_settings,
                figure,
                plan,
                headers,
                precision_seen,
                footer,
            )
            if plan is not None
            else _tiff_tiles(
                session,
                metadata,
                selection,
                projection,
                settings,
                embedded_icc,
                precision_seen,
                footer,
            )
        )
        with tifffile.TiffWriter(
            _NamedBinaryStream(stream, Path(destination).name),
            bigtiff=estimated_bytes >= 2**32 - 32 * 1024**2,
        ) as tif:
            tif.write(
                tile_stream,
                shape=(output_height, output_width, channels),
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
            if tuple(page.shape) != (output_height, output_width, channels):
                raise ValueError("Rendered TIFF dimensions changed before publication")
            if page.dtype != np.dtype(np.uint16) or not page.is_tiled:
                raise ValueError("Rendered TIFF is not a tiled uint16 image")
            if page.description != description:
                raise ValueError("Rendered TIFF provenance changed before publication")

    target, digest, byte_length = _atomic_rendered_write(
        destination, suffix=".tiff", writer=writer, before_publish=before_publish
    )
    receipt = {
        "schema": provenance["schema"],
        "basename": target.name,
        "sha256": digest,
        "width": output_width,
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
    if figure.is_split:
        receipt["layout"] = figure.layout
    return receipt


def _require_split_png_budget(
    plan: _SplitLayoutPlan,
    footer: _FooterPlan | None,
    *,
    retained_scalar_bytes: int,
    overview_sampled: bool,
) -> None:
    width = plan.content_width
    footer_pixels = 0 if footer is None else width * footer.height
    height = plan.content_height + (0 if footer is None else footer.height)
    canvas_pixels = width * height
    if canvas_pixels > MAX_SPLIT_PNG_PIXELS:
        raise ValueError(
            "Split-channel PNG figure exceeds Loci's bounded raster limit; "
            "export a smaller region or use tiled TIFF16"
        )

    canvas_bytes = 3 * canvas_pixels
    panel_pixels = plan.panel_width * plan.panel_height
    header_pixels = plan.panel_width * plan.header_height
    font_bytes = plan.header_font_bytes + (0 if footer is None else footer.font_bytes)
    # RGB typography rasters, Pillow L masks and crops, and _apply_mask's
    # uint32 alpha plus up to three concurrent uint32 RGB intermediates.
    typography_bytes = (
        font_bytes
        + 3 * (len(plan.panels) * header_pixels + footer_pixels)
        + 44 * max(header_pixels, footer_pixels)
    )

    # Native decoding has its own gate. Reserve a previous decoded plane,
    # reduction temporaries, or the two tiles and gather used by overview sampling.
    read_pixels = SOURCE_TILE_EDGE**2 if overview_sampled else panel_pixels
    read_bytes = DEFAULT_NATIVE_READ_BUDGET_BYTES + 24 * read_pixels
    # The final compositor expression can hold the RGB float64 accumulator,
    # one normalized channel, and two float64 RGB clip/scale/round intermediates.
    composite_bytes = (24 + 8 + 2 * 24) * panel_pixels

    # Pillow stores RGB at four bytes per pixel, with row pointers. Its PNG
    # encoder uses scanline filters and bounded output chunks written to disk.
    encoder_bytes = 4 * canvas_pixels + 8 * height + 32 * width
    # The canvas spans all three phases. Allow 2 MiB for the codec (including
    # zlib), metadata and other small buffers.
    working_bytes = (
        canvas_bytes
        + 2 * 1024**2
        + max(
            typography_bytes,
            retained_scalar_bytes + max(read_bytes, composite_bytes),
            encoder_bytes,
        )
    )
    if working_bytes > MAX_VIEWER_WORKING_BYTES:
        raise ValueError(
            "Split-channel PNG figure exceeds Loci's aggregate working-memory budget; "
            "export a smaller region or use tiled TIFF16"
        )


def _export_split_png(
    workbench: Workbench,
    session: Any,
    source: dict[str, Any],
    source_metadata: NativeImageMetadata,
    view: dict[str, Any],
    destination: str | Path,
    figure: _FigureOptions,
    legend: tuple[dict[str, Any], ...],
) -> dict[str, Any]:
    plane_view = prepare_viewer_scalar_planes(session, view)
    rendered = plane_view.rendering
    if rendered["source_sha256"] != source["sha256"]:
        raise ValueError("Rendered export lost source identity")
    panel_width = int(rendered["width"])
    panel_height = int(rendered["height"])
    plan, render_headers = _plan_split_layout(
        panel_width=panel_width,
        panel_height=panel_height,
        bit_depth=8,
        options=figure,
        visible_settings=plane_view.visible_settings,
        legend=legend,
    )
    footer_plan = _plan_footer(
        width=plan.content_width,
        image_height=plan.content_height,
        channels=3,
        bit_depth=8,
        options=figure,
        geometry=rendered["geometry"],
        legend=legend if figure.channel_legend else (),
        scale_reference_width=plan.panel_width,
        scale_applies_to="each-panel",
        channel_windows=plan.channel_windows,
    )
    width = plan.content_width
    height = plan.content_height + (0 if footer_plan is None else footer_plan.height)
    retained_bytes_per_pixel = _retained_scalar_bytes_per_pixel(
        source_metadata, plane_view.visible_settings, rendered["projection"]
    )
    _require_split_png_budget(
        plan,
        footer_plan,
        retained_scalar_bytes=panel_width * panel_height * retained_bytes_per_pixel,
        overview_sampled=rendered.get("preparation") == "derived-cache",
    )
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    for panel, header in zip(plan.panels, render_headers(), strict=True):
        hx, hy, hw, hh = panel.header_xywh
        canvas[hy : hy + hh, hx : hx + hw] = header
    del header, render_headers
    footer_record = None if footer_plan is None else footer_plan.record
    if footer_plan is not None:
        canvas[plan.content_height :] = footer_plan.render()
    del footer_plan

    arrays = plane_view.read_arrays()
    for panel in plan.panels:
        px, py, pw, ph = panel.raster_xywh
        if panel.kind == "grayscale":
            assert panel.setting is not None
            if plan.border > 0:
                for bx, by, bw, bh in _split_border_boxes(panel.raster_xywh):
                    canvas[by : by + bh, bx : bx + bw] = 34
            canvas[py : py + ph, px : px + pw] = _render_grayscale_panel(
                arrays[panel.setting.channel],
                panel.setting,
                bit_depth=8,
                invert=figure.invert_grayscale,
            )
        else:
            canvas[py : py + ph, px : px + pw] = render_channel_composite(
                arrays, plane_view.visible_settings, bit_depth=8
            )
    del arrays
    provenance = {
        "schema": "loci.rendered-source/v3",
        "software": {
            "engine": ENGINE_VERSION,
            "numpy": np.__version__,
            "pillow": PILLOW_VERSION,
            "tifffile": tifffile.__version__,
        },
        "source_sha256": source["sha256"],
        "meaning": (
            "display RGB split-channel figure "
            "(separate named grayscale channels + multichannel merge); "
            "not original-value quantitative data"
        ),
        "palette": asdict(source_metadata.palette) if source_metadata.palette is not None else None,
        "canvas_quantization": None,
        "annotations_included": False,
        "sampling": "full-extent overview" if view.get("overview") else "selected source grid",
        "request": {key: value for key, value in view.items() if key != "source_id"},
        "rendering": rendered,
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
            "layout": plan.layout,
            "invert_grayscale": figure.invert_grayscale,
            "accessibility_note": ACCESSIBILITY_NOTE,
            "grout_px": plan.grout,
            "margin_px": plan.margin,
            "panel_border_px": plan.border,
            "header_font": plan.header_font,
            "source_raster": {"width": panel_width, "height": panel_height},
            "output_raster": {"width": width, "height": height},
            "geometry": rendered["geometry"],
            "panels": [panel.provenance() for panel in plan.panels],
            "footer": footer_record,
        },
        "output": {
            "dtype": "uint8",
            "channels": 3,
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

    def writer(stream: Any) -> None:
        with Image.fromarray(canvas, mode="RGB") as output_image:
            output_image.save(
                stream,
                format="PNG",
                pnginfo=metadata,
                icc_profile=srgb_output_profile_bytes(),
                dpi=(figure.dpi, figure.dpi),
            )

    def before_publish(_temporary: Path) -> None:
        if workbench.project.source(source["id"], verify=True)["sha256"] != source["sha256"]:
            raise ValueError("Rendered PNG source changed during export")

    target, digest, _size = _atomic_rendered_write(
        destination, suffix=".png", writer=writer, before_publish=before_publish
    )
    return {
        "schema": provenance["schema"],
        "basename": target.name,
        "sha256": digest,
        "width": width,
        "height": height,
        "image_width": panel_width,
        "image_height": panel_height,
        "sampling": provenance["sampling"],
        "format": "png",
        "dtype": "uint8",
        "channels": 3,
        "display_revision": rendered["display_revision"],
        "dpi": figure.dpi,
        "layout": figure.layout,
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
    legend = _resolved_channel_labels(figure, source_metadata, settings)
    if figure.is_split:
        return _export_split_png(
            workbench, session, source, source_metadata, view, destination, figure, legend
        )
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
        footer_plan = _plan_footer(
            width=image.width,
            image_height=image.height,
            channels=image_channels,
            bit_depth=8,
            options=figure,
            geometry=rendered["geometry"],
            legend=legend,
        )
        footer_record = None if footer_plan is None else footer_plan.record
        if footer_plan is not None:
            if source_pixels.ndim != 3 or source_pixels.shape[-1] != 3:
                raise ValueError("Publication footers require a rendered RGB image")
            output_pixels = np.concatenate((source_pixels, footer_plan.render()), axis=0)
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
            "palette": asdict(source_metadata.palette)
            if source_metadata.palette is not None
            else None,
            "canvas_quantization": (
                "uint16-fixed-range-nearest-v1"
                if source_metadata.sample_semantics != "none"
                and np.dtype(source_metadata.channel_dtypes[settings[0].channel]) == np.uint16
                else None
            ),
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
