"""Source-bound descriptive figures, generated exclusively from canonical measurements."""

from __future__ import annotations

import hashlib
import io
import math
import os
import platform
import stat
import sys
import uuid
import xml.etree.ElementTree as ET
from contextlib import suppress
from pathlib import Path
from typing import Any

import PIL
from PIL import Image, ImageDraw, ImageFont

from .models import ENGINE_VERSION
from .quantitative import integer
from .research_population import population_query
from .research_project import ResearchProject, canonical_json
from .statistics_figure_publication import (
    _DIRECTORY_FLAGS,
    _matches_identity,
    publish_statistics_figure,
)

DPI = 600
MAX_EDGE = 8192
MAX_PIXELS = 16_000_000
REQUEST_KEYS = {
    "schema_version",
    "source_id",
    "source_sha256",
    "result_id",
    "revision_hash",
    "query",
    "query_sha256",
    "membership_sha256",
    "chart",
    "domain",
    "width_mm",
    "height_mm",
    "preset",
}
QUERY_KEYS = {
    "x_metric",
    "y_metric",
    "filters",
    "sort",
    "offset",
    "limit",
    "plot_limit",
    "bins",
    "selected_label",
}
BINDINGS = (
    "source_id",
    "source_sha256",
    "result_id",
    "revision_hash",
    "query_sha256",
    "membership_sha256",
)
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)


def _exact(value: Any, keys: set[str], name: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"Invalid {name} fields")
    return value


def _finite(value: Any) -> float:
    if type(value) not in (int, float):
        raise ValueError("Figure domain and dimensions must be finite numbers")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError("Figure number exceeds finite range") from exc
    if not math.isfinite(number):
        raise ValueError("Figure domain and dimensions must be finite numbers")
    return number


def _metric(value: Any, nullable=False) -> None:
    if nullable and value is None:
        return
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 560
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise ValueError("Invalid statistics metric identity")


def checked_request(value: Any) -> dict:
    request = _exact(value, REQUEST_KEYS, "statistics figure")
    if (
        request["schema_version"] != "loci.statistics-figure-request/v1"
        or request["preset"] != "publication-monochrome"
        or request["chart"] not in ("histogram", "scatter")
    ):
        raise ValueError("Unsupported statistics figure options")
    import re

    for key in BINDINGS:
        pattern = r"[a-f0-9]{32}" if key in ("source_id", "result_id") else r"[a-f0-9]{64}"
        if not isinstance(request[key], str) or re.fullmatch(pattern, request[key]) is None:
            raise ValueError("Invalid statistics figure identity or hash")
    width, height = (_finite(request[key]) for key in ("width_mm", "height_mm"))
    if not (40 <= width <= 300 and 40 <= height <= 300):
        raise ValueError("Choose statistics figure dimensions between 40 and 300 mm")
    # Same positive half-up rule as JavaScript Math.round, not Python banker rounding.
    pixels = [math.floor(size / 25.4 * DPI + 0.5) for size in (width, height)]
    if max(pixels) > MAX_EDGE or math.prod(pixels) > MAX_PIXELS:
        raise ValueError("Statistics figure exceeds bounded raster allocation")
    query = _exact(request["query"], QUERY_KEYS, "normalized population query")
    _metric(query["x_metric"], True)
    _metric(query["y_metric"], True)
    filters = query["filters"]
    if not isinstance(filters, list) or len(filters) > 8:
        raise ValueError("Invalid statistics filters")
    for item in filters:
        if (
            not isinstance(item, dict)
            or set(item) - {"metric", "min", "max"}
            or "metric" not in item
            or not ({"min", "max"} & set(item))
        ):
            raise ValueError("Invalid statistics filter fields")
        _metric(item["metric"])
        for key in ("min", "max"):
            if key in item:
                _finite(item[key])
        if "min" in item and "max" in item and item["min"] > item["max"]:
            raise ValueError("Unordered statistics filter")
    if query["sort"] is not None:
        sort = _exact(query["sort"], {"metric", "direction"}, "statistics sort")
        _metric(sort["metric"])
        if sort["direction"] not in ("asc", "desc"):
            raise ValueError("Invalid statistics sort")
    for key, low, high in (
        ("offset", 0, 100000),
        ("limit", 1, 200),
        ("plot_limit", 1, 2000),
        ("bins", 1, 64),
    ):
        integer(query[key], key, low, high)
    if query["selected_label"] is not None:
        integer(query["selected_label"], "selected label", 1, 0xFFFFFFFF)
    domain = request["domain"]
    if not isinstance(domain, dict):
        raise ValueError("Invalid statistics figure domain")
    if domain.get("mode") == "full":
        _exact(domain, {"mode"}, "full statistics domain")
    elif domain.get("mode") == "current":
        _exact(domain, {"mode", "x", "y"}, "current statistics domain")
        for key in ("x", "y"):
            bounds = domain[key]
            if (
                not isinstance(bounds, list)
                or len(bounds) != 2
                or _finite(bounds[0]) > _finite(bounds[1])
            ):
                raise ValueError("Invalid statistics figure domain bounds")
    else:
        raise ValueError("Invalid statistics figure domain mode")
    return request


def canonical_population(project: ResearchProject, request: dict) -> dict:
    checked_request(request)
    receipt = population_query(
        project,
        {
            **request["query"],
            "result_id": request["result_id"],
            "revision_hash": request["revision_hash"],
        },
    )
    if (
        any(receipt[key] != request[key] for key in BINDINGS)
        or receipt["query"] != request["query"]
    ):
        raise ValueError("Statistics figure source, result, normalized query or membership changed")
    return receipt


def _ratio(value: float, domain: list[float]) -> float:
    low, high = domain
    if low == high:
        return 0.5
    if value <= low:
        return 0.0
    if value >= high:
        return 1.0
    # Difference first retains adjacent subnormals; scale only an overflowing span.
    span = high - low
    if math.isfinite(span):
        return (value - low) / span
    scale = max(abs(low), abs(high))
    return (value / scale - low / scale) / (high / scale - low / scale)


def _interpolate(domain: list[float], fraction: float) -> float:
    if fraction == 0:
        return domain[0]
    if fraction == 1:
        return domain[1]
    return domain[0] * (1 - fraction) + domain[1] * fraction


def _label(metric: dict) -> str:
    display_units = {
        "um^2": "µm²",
        "um^3": "µm³",
        "pixel^2": "pixel²",
        "pixel^3": "pixel³",
        "um": "µm",
    }
    unit = display_units.get(metric["unit"], metric["unit"])
    return f"{metric['label']} ({unit})" if unit else metric["label"]


def _font(size: int, labels: list[str]) -> tuple[Any, dict]:
    if any(len(label) > 1024 for label in labels) or any(
        ord(c) < 32 or ord(c) == 127 for label in labels for c in label
    ):
        raise ValueError("Metric labels contain unsupported control characters")
    candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
    ]
    for file in candidates:
        if not file.is_file() or file.is_symlink():
            continue
        with file.open("rb") as stream:
            data = stream.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            continue
        font = ImageFont.truetype(io.BytesIO(data), size=size)
        missing = {
            (font.getmask(character).size, bytes(font.getmask(character)))
            for character in ("\ufffd", "\U0010ffff")
        }
        if any(
            (font.getmask(character).size, bytes(font.getmask(character))) in missing
            for text in labels
            for character in text
            if not character.isspace()
        ):
            continue
        return font, {
            "family": font.getname()[0],
            "style": font.getname()[1],
            "sha256": hashlib.sha256(data).hexdigest(),
            "svg_font_policy": "named-local-font-no-external-resources",
        }
    raise ValueError("No installed verified font supports all actual metric labels and units")


def generate_figure(
    population: dict, request: dict, application_version: str
) -> tuple[dict[str, bytes], dict]:
    """One bounded drawing model drives SVG and raster with identical geometry."""
    checked_request(request)
    chart = request["chart"]
    metrics = {metric["id"]: metric for metric in population["metrics"]}
    if population["query"]["x_metric"] not in metrics or (
        chart == "scatter" and population["query"]["y_metric"] not in metrics
    ):
        raise ValueError("Statistics figure needs actual measured metrics")
    histogram = population["histogram"]
    summaries = population["summaries"]
    x_data = [summaries["x"]["min"], summaries["x"]["max"]]
    y_data = (
        [0, max(histogram["counts"], default=0)]
        if chart == "histogram"
        else [summaries["y"]["min"], summaries["y"]["max"]]
    )
    if None in x_data or None in y_data:
        raise ValueError("Statistics figure has no finite measured data")
    raw_domains = {"x": x_data, "y": y_data}
    domains = (
        raw_domains
        if request["domain"]["mode"] == "full"
        else {key: list(request["domain"][key]) for key in ("x", "y")}
    )
    if request["domain"]["mode"] == "current" and any(
        domains[axis][0] < raw_domains[axis][0] or domains[axis][1] > raw_domains[axis][1]
        for axis in ("x", "y")
    ):
        raise ValueError("Current figure domain must lie within full canonical data domains")
    x_label = _label(metrics[population["query"]["x_metric"]])
    y_label = (
        "Object count" if chart == "histogram" else _label(metrics[population["query"]["y_metric"]])
    )
    width, height = [
        math.floor(request[key] / 25.4 * DPI + 0.5) for key in ("width_mm", "height_mm")
    ]
    # 8 pt fonts and 0.5 pt lines retain physical size across preset dimensions.
    font_size = round(8 / 72 * DPI)
    font, font_identity = _font(font_size, [x_label, y_label, "0123456789.e+-"])
    image = Image.new("RGB", (width, height), "white")
    raster = ImageDraw.Draw(image)
    root = ET.Element(
        f"{{{SVG}}}svg",
        {
            "width": f"{request['width_mm']}mm",
            "height": f"{request['height_mm']}mm",
            "viewBox": f"0 0 {width} {height}",
        },
    )
    ET.SubElement(
        root, f"{{{SVG}}}rect", {"width": str(width), "height": str(height), "fill": "white"}
    )
    tick_data = {}
    for axis in ("x", "y"):
        domain = domains[axis]
        fractions = [0.5] if domain[0] == domain[1] else [0, 0.25, 0.5, 0.75, 1]
        if axis == "y" and chart == "histogram":
            # Object counts use integral ticks; display clipping never creates fractional counts.
            low, high = domain
            first, last = math.ceil(low), math.floor(high)
            if first <= last:
                tick_values = sorted(set(round(_interpolate([first, last], f)) for f in fractions))
                fractions = [_ratio(value, domain) for value in tick_values]
                values = tick_values
            else:
                fractions, values = [], []
        else:
            values = [_interpolate(domain, fraction) for fraction in fractions]
        for precision in (4, 6, 8, 17):
            labels = [format(value, f".{precision}g") for value in values]
            if len(set(labels)) == len(set(values)):
                break
        tick_data[axis] = list(zip(fractions, values, labels, strict=True))
    widest_y = max(
        (raster.textlength(label, font=font) for _, _, label in tick_data["y"]), default=0
    )
    widest_x = max(raster.textlength(label, font=font) for _, _, label in tick_data["x"])
    left, right, top, bottom = (
        max(350.0, widest_y + 245),
        width - max(110.0, widest_x / 2 + 25),
        90.0,
        height - 320.0,
    )
    if right <= left or bottom <= top:
        raise ValueError("Figure dimensions leave no legible plot area")
    stroke_width = max(1, round(0.5 / 72 * DPI))

    def line(x1, y1, x2, y2, color="black"):
        raster.line((x1, y1, x2, y2), fill=color, width=stroke_width)
        ET.SubElement(
            root,
            f"{{{SVG}}}line",
            {
                "x1": str(x1),
                "y1": str(y1),
                "x2": str(x2),
                "y2": str(y2),
                "stroke": color,
                "stroke-width": str(stroke_width),
            },
        )

    def text(x, y, label, anchor="mm", rotate=False):
        # Vector labels retain real source text and XML escaping. No URLs/scripts.
        attrs = {
            "x": str(x),
            "y": str(y),
            "font-family": font_identity["family"],
            "font-size": str(font_size),
            "fill": "black",
            "text-anchor": "middle" if anchor == "mm" else "end",
            "dominant-baseline": "central",
        }
        if rotate:
            attrs["transform"] = f"rotate(-90 {x} {y})"
            mask = Image.new(
                "RGBA",
                (round(raster.textlength(label, font=font)) + font_size, font_size * 2),
                (255, 255, 255, 0),
            )
            ImageDraw.Draw(mask).text(
                (font_size / 2, font_size), label, fill="black", font=font, anchor="lm"
            )
            mask = mask.rotate(90, expand=True)
            image.paste(mask, (round(x - mask.width / 2), round(y - mask.height / 2)), mask)
        else:
            raster.text((x, y), label, fill="black", font=font, anchor=anchor)
        ET.SubElement(root, f"{{{SVG}}}text", attrs).text = label

    # Wrap source labels without abbreviation or substituted glyphs.
    def wrapped_label(label: str, maximum: float) -> list[str]:
        lines, current = [], ""
        for character in label:
            if current and raster.textlength(current + character, font=font) > maximum:
                # Prefer word boundaries; split a single long source token only when necessary.
                space = current.rfind(" ")
                if space > 0:
                    lines.append(current[:space])
                    current = current[space + 1 :]
                else:
                    lines.append(current)
                    current = ""
            current += character
        if current:
            lines.append(current)
        return lines

    x_lines = wrapped_label(x_label, right - left)
    y_lines = wrapped_label(y_label, bottom - top)
    if len(x_lines) > 2 or len(y_lines) > 2:
        raise ValueError("Actual metric label needs a larger figure for legible export")
    for index, label in enumerate(x_lines):
        text((left + right) / 2, height - 130 + index * font_size * 1.2, label)
    for index, label in enumerate(y_lines):
        text(85 + index * font_size * 1.2, (top + bottom) / 2, label, rotate=True)
    line(left, top, left, bottom)
    line(left, bottom, right, bottom)
    for axis in ("x", "y"):
        ticks = tick_data[axis]
        if axis == "x" and len(ticks) > 1:
            # Reduce tick density before any measured label can overlap.
            available = right - left
            if available / 4 < widest_x + 35:
                ticks = [ticks[0], ticks[len(ticks) // 2], ticks[-1]]
            if available / 2 < widest_x + 35:
                ticks = [ticks[0], ticks[-1]]
            if available < widest_x + 35:
                raise ValueError("Scientific tick labels need a larger figure for legible export")
        tick_labels = []
        for fraction, _value, label in ticks:
            if label in tick_labels:
                continue
            tick_labels.append(label)
            if axis == "x":
                coordinate = left + fraction * (right - left)
                line(coordinate, bottom, coordinate, bottom + 20)
                text(coordinate, bottom + 75, label)
            else:
                coordinate = bottom - fraction * (bottom - top)
                line(left - 20, coordinate, left, coordinate)
                text(left - 35, coordinate, label, anchor="rm")

    definitions = ET.SubElement(root, f"{{{SVG}}}defs")
    clip = ET.SubElement(definitions, f"{{{SVG}}}clipPath", {"id": "plot"})
    ET.SubElement(
        clip,
        f"{{{SVG}}}rect",
        {"x": str(left), "y": str(top), "width": str(right - left), "height": str(bottom - top)},
    )
    marks = ET.SubElement(root, f"{{{SVG}}}g", {"clip-path": "url(#plot)"})
    primitives = []
    if chart == "histogram":
        edges, counts = histogram["edges"], histogram["counts"]
        for index, count in enumerate(counts):
            a, b = edges[index : index + 2]
            low, high = domains["x"]
            # Half-open bin intersection, with canonical final endpoint closed.
            if a == b or low == high:
                if a == b:
                    if not low <= a <= high:
                        continue
                    center_value = a
                else:
                    if not (a <= low < b or (index == len(counts) - 1 and low == b)):
                        continue
                    center_value = low
                center = left + _ratio(center_value, domains["x"]) * (right - left)
                x1, x2 = center - (right - left) * 0.025, center + (right - left) * 0.025
            else:
                if b <= low or a > high or (a == high and index != len(counts) - 1):
                    continue
                x1 = left + _ratio(max(a, low), domains["x"]) * (right - left)
                x2 = left + _ratio(min(b, high), domains["x"]) * (right - left)
                if x2 <= x1:
                    continue
            if count < domains["y"][0] or domains["y"][1] < 0:
                continue
            y1 = bottom - _ratio(min(count, domains["y"][1]), domains["y"]) * (bottom - top)
            y2 = bottom - _ratio(max(0, domains["y"][0]), domains["y"]) * (bottom - top)
            raster.rectangle((x1, y1, x2, y2), fill="#707070", outline="black", width=stroke_width)
            ET.SubElement(
                marks,
                f"{{{SVG}}}rect",
                {
                    "x": str(x1),
                    "y": str(y1),
                    "width": str(x2 - x1),
                    "height": str(y2 - y1),
                    "fill": "#707070",
                    "stroke": "black",
                    "stroke-width": str(stroke_width),
                },
            )
            primitives.append(
                {
                    "bin_index": index,
                    "canonical_count": count,
                    "clipped_x": [max(a, low), min(b, high)],
                }
            )
    else:
        radius = max(3, DPI / 72 * 1.2)
        plot_layer = Image.new("RGB", (width, height), "white")
        plot_raster = ImageDraw.Draw(plot_layer)
        for point in population["scatter"]["points"]:
            if not all(domains[axis][0] <= point[axis] <= domains[axis][1] for axis in ("x", "y")):
                continue
            x = left + _ratio(point["x"], domains["x"]) * (right - left)
            y = bottom - _ratio(point["y"], domains["y"]) * (bottom - top)
            # Keep marks inside plot bounds, including canonical endpoint extrema.
            plot_raster.ellipse((x - radius, y - radius, x + radius, y + radius), fill="#303030")
            ET.SubElement(
                marks,
                f"{{{SVG}}}circle",
                {"cx": str(x), "cy": str(y), "r": str(radius), "fill": "#303030"},
            )
            primitives.append(point["label"])
        plot_box = (
            math.ceil(left + stroke_width),
            math.ceil(top),
            math.floor(right),
            math.floor(bottom - stroke_width),
        )
        image.paste(plot_layer.crop(plot_box), plot_box)
    svg_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    stream = io.BytesIO()
    image.save(stream, format="PNG", dpi=(DPI, DPI))
    files = {"figure.svg": svg_bytes, "figure.png": stream.getvalue()}
    # Hash the executing trusted runtime without putting local paths in provenance.
    from .working_result import _sha256_file_stable

    worker_hash, worker_size = _sha256_file_stable(
        Path(os.path.realpath(sys.executable)),
        reject_symlink=True,
    )
    manifest = {
        "schema_version": "loci.statistics-figure/v1",
        **{key: request[key] for key in BINDINGS},
        "query": population["query"],
        "chart": chart,
        "preset": request["preset"],
        "figure": {
            "width_mm": request["width_mm"],
            "height_mm": request["height_mm"],
            "width_px": width,
            "height_px": height,
            "dpi": DPI,
            "font_size_pt": 8,
            "axis_labels": {"x": x_label, "y": y_label},
        },
        "domains": {
            "requested": request["domain"],
            "raw": raw_domains,
            "effective": domains,
            "constant_policy": (
                "equal-finite-endpoints-map-to-center; histogram-centered-5-percent-bar"
            ),
        },
        "metrics": {
            "x": metrics[population["query"]["x_metric"]],
            "y": {"id": "object_count", "label": "Object count", "unit": "object", "kind": "count"}
            if chart == "histogram"
            else metrics[population["query"]["y_metric"]],
        },
        "scope": (
            "descriptive objects in one exact source/result; "
            "objects are not independent biological samples"
        ),
        "total_count": population["total_count"],
        "filtered_count": population["filtered_count"],
        "accounting": population["accounting"],
        "summaries": summaries,
        "histogram": histogram if chart == "histogram" else None,
        "scatter": population["scatter"] if chart == "scatter" else None,
        "visible_primitives": primitives,
        "view_policy": "clip-canonical-bins-without-rebinning"
        if chart == "histogram"
        else "clip-canonical-deterministic-sample; bounds-from-full-filtered-summaries",
        "software": {
            "application_version": application_version,
            "engine_version": ENGINE_VERSION,
            "worker": {
                "kind": "frozen-executable" if getattr(sys, "frozen", False) else "python-runtime",
                "executable_sha256": worker_hash,
                "executable_size_bytes": worker_size,
            },
            "python_version": platform.python_version(),
            "pillow_version": PIL.__version__,
            "font": font_identity,
        },
        "artifacts": {
            name: {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}
            for name, data in files.items()
        },
    }
    files["manifest.json"] = (canonical_json(manifest) + "\n").encode()
    limits = {
        "figure.svg": 4 * 1024 * 1024,
        "figure.png": 32 * 1024 * 1024,
        "manifest.json": 1024 * 1024,
    }
    if any(len(data) > limits[name] for name, data in files.items()):
        raise ValueError("Statistics figure artifacts exceed bounded allocation")
    return files, manifest


def _require_staging_capability() -> None:
    required = (os.open, os.mkdir, os.unlink, os.rmdir, os.stat)
    if any(operation not in os.supports_dir_fd for operation in required):
        raise ValueError(
            "Statistics figure export is unavailable on this platform: "
            "safe publication requires directory-descriptor staging. "
            "Windows figure export has not been qualified."
        )


def _scientific_scope(project: ResearchProject, request: dict) -> dict:
    """Read only bounded scientific fields from exact canonical result/source records."""
    result = project.result(request["result_id"])
    source = project.source(request["source_id"], verify=True)
    if (
        result["revision_hash"] != request["revision_hash"]
        or result["source_id"] != request["source_id"]
        or result["source_sha256"] != request["source_sha256"]
        or source["sha256"] != request["source_sha256"]
    ):
        raise ValueError("Statistics figure scientific scope has stale source/result bindings")
    provenance = result.get("provenance", {})
    selection = provenance.get("selection")
    if selection is not None:
        accepted = {"x", "y", "width", "height", "t", "c", "z", "z_stop", "level", "elapsed_time_s"}
        if not isinstance(selection, dict) or set(selection) - accepted:
            raise ValueError("Statistics figure result selection has unsupported scope fields")
        selection = dict(selection)
        for key, value in selection.items():
            if key == "elapsed_time_s":
                _finite(value)
            else:
                integer(
                    value,
                    f"result selection {key}",
                    1 if key in {"width", "height"} else 0,
                    2**53 - 1,
                )
        if "z_stop" in selection and (
            "z" not in selection or selection["z_stop"] <= selection["z"]
        ):
            raise ValueError("Statistics figure requires a half-open recorded Z selection")

    def geometry(value):
        if value is None:
            return None
        _exact(value, {"axes", "affine", "unit", "frame"}, "scientific scope geometry")
        from .quantitative import Geometry

        checked = Geometry(
            value["axes"],
            tuple(tuple(row) for row in value["affine"]),
            value["unit"],
            value["frame"],
        )
        return checked.to_dict()

    def calibration(value):
        if value is None:
            return None
        _exact(value, {"axes", "spacing", "unit"}, "source calibration")
        axes, spacing, unit = value["axes"], value["spacing"], value["unit"]
        if axes not in {"YX", "ZYX"} or not isinstance(spacing, list) or len(spacing) != len(axes):
            raise ValueError("Statistics figure source calibration axes disagree with spacing")
        if any(_finite(number) <= 0 for number in spacing):
            raise ValueError("Statistics figure source calibration spacing must be positive")
        from .native_image import _LENGTH_TO_MICROMETRES, _NONPHYSICAL_LENGTH_UNITS

        if unit not in _LENGTH_TO_MICROMETRES and unit not in _NONPHYSICAL_LENGTH_UNITS:
            raise ValueError("Statistics figure source calibration unit is unsupported")
        return {"axes": axes, "spacing": list(spacing), "unit": unit}

    shape = result["arrays"]["labels"]["shape"]
    axes = "YX" if len(shape) == 2 else "ZYX"
    result_geometry = geometry(provenance.get("geometry"))
    if result_geometry is not None and result_geometry["axes"] != axes:
        raise ValueError("Statistics figure result geometry disagrees with measured grid axes")
    metadata = source.get("metadata", {})
    dimensions = metadata.get("dimensions")
    if dimensions is not None:
        if not isinstance(dimensions, dict) or set(dimensions) - {"t", "c", "z", "y", "x", "s"}:
            raise ValueError("Invalid statistics figure source dimensions")
        dimensions = dict(dimensions)
        for key, value in dimensions.items():
            integer(value, f"source dimension {key}", 1, 2**53 - 1)
    source_shape = metadata.get("shape")
    if source_shape is not None:
        if not isinstance(source_shape, list) or not 2 <= len(source_shape) <= 6:
            raise ValueError("Invalid statistics figure source shape")
        for extent in source_shape:
            integer(extent, "source shape extent", 1, 2**53 - 1)
    source_axes = metadata.get("axes")
    if source_axes is not None and (
        not isinstance(source_axes, str)
        or len(source_axes) > 6
        or any(character not in "TCZYXS" for character in source_axes)
    ):
        raise ValueError("Invalid statistics figure source axis order")
    selected_level = None
    if selection is not None and "level" in selection and "levels" in metadata:
        levels = metadata["levels"]
        if not isinstance(levels, list) or len(levels) > 64:
            raise ValueError("Invalid statistics figure source pyramid levels")
        level = next((value for value in levels if value.get("index") == selection["level"]), None)
        if level is None:
            raise ValueError("Recorded statistics result level is absent from its source")
        selected_level = {
            "index": selection["level"],
            "calibration": calibration(level.get("calibration")),
        }
    series = metadata.get("selected_series")
    if series is not None:
        integer(series, "source series", 0, 2**53 - 1)
    return {
        "result_kind": result["kind"],
        "selection": selection,
        "selection_status": "recorded" if selection is not None else "not-recorded",
        "selection_coordinates": "source-level XY rectangle; T/C/Z indices; Z stop exclusive",
        "spatial_dimension": len(shape),
        "index_axes": axes,
        "result_shape": list(shape),
        "measure_kind": "area" if axes == "YX" else "volume",
        "measurement_geometry": result_geometry,
        "source": {
            "source_kind": source.get("source_kind"),
            "axes": source_axes,
            "shape": source_shape,
            "dimensions": dimensions,
            "selected_series": series,
            "physical_calibration": calibration(metadata.get("physical_calibration")),
            "geometry": geometry(metadata.get("geometry")),
            "selected_level": selected_level,
        },
    }


def export_statistics_figure(
    project: ResearchProject, request: dict, destination: str, application_version: str
) -> dict:
    _require_staging_capability()
    population = canonical_population(project, request)
    scientific_scope = _scientific_scope(project, request)
    if (
        not isinstance(application_version, str)
        or not application_version
        or len(application_version) > 128
        or any(ord(c) < 32 for c in application_version)
    ):
        raise ValueError("Invalid application version")
    if not isinstance(destination, str) or "\x00" in destination or not os.path.isabs(destination):
        raise ValueError("Invalid statistics figure destination")
    name = os.path.basename(destination)
    if not name.lower().endswith(".loci-figure") or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("Invalid statistics figure bundle basename")
    parent = os.path.realpath(os.path.dirname(destination))
    destination = os.path.join(parent, name)
    files, manifest = generate_figure(population, request, application_version)
    manifest["scientific_scope"] = scientific_scope
    files["manifest.json"] = (canonical_json(manifest) + "\n").encode()
    if len(files["manifest.json"]) > 1024 * 1024:
        raise ValueError("Statistics figure scientific scope exceeds bounded manifest allocation")
    artifacts = {
        key: {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}
        for key, data in files.items()
    }
    stage_name = ".loci-statistics-figure-" + uuid.uuid4().hex
    stage = os.path.join(parent, stage_name)
    parent_fd = os.open(parent, _DIRECTORY_FLAGS)
    stage_fd = None
    stage_identity = None
    published = False
    try:
        parent_stat = os.fstat(parent_fd)
        if not stat.S_ISDIR(parent_stat.st_mode) or not os.path.samestat(
            parent_stat, os.lstat(parent)
        ):
            raise ValueError("Statistics figure parent changed before staging")
        os.mkdir(stage_name, mode=0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        stage_stat = os.fstat(stage_fd)
        stage_identity = (stage_stat.st_dev, stage_stat.st_ino)
        for artifact, data in files.items():
            fd = os.open(
                artifact,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=stage_fd,
            )
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        os.fsync(stage_fd)

        def reverify():
            final = canonical_population(project, request)
            if final != population or _scientific_scope(project, request) != scientific_scope:
                raise ValueError("Statistics population changed before publication")

        publish_statistics_figure(
            {
                "parent": parent,
                "staging": stage,
                "destination": destination,
                "parent_identity": {
                    "device": str(parent_stat.st_dev),
                    "inode": str(parent_stat.st_ino),
                },
                "staging_identity": {
                    "device": str(stage_stat.st_dev),
                    "inode": str(stage_stat.st_ino),
                },
                "artifacts": [{"name": key, **metadata} for key, metadata in artifacts.items()],
            },
            reverify,
        )
        published = True
    finally:
        if stage_fd is not None:
            if not published:
                # A rename may have succeeded before a durability failure. Never erase the
                # now-published bundle through the still-open staging descriptor.
                try:
                    current = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if current is not None and _matches_identity(current, stage_identity):
                    for artifact in files:
                        with suppress(FileNotFoundError):
                            os.unlink(artifact, dir_fd=stage_fd)
                    os.rmdir(stage_name, dir_fd=parent_fd)
            os.close(stage_fd)
        os.close(parent_fd)
    return {
        "schema_version": "loci.statistics-figure-receipt/v1",
        "basename": name,
        **{
            key: manifest["figure"][key]
            for key in ("width_mm", "height_mm", "width_px", "height_px", "dpi")
        },
        **{key: request[key] for key in BINDINGS},
        "artifacts": artifacts,
    }
