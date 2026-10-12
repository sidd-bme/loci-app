"""Bounded explicit-crop, display-only rendering for trusted human callers."""

from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image
from PIL import __version__ as pillow_version

from .quantitative import DEFAULT_WORKING_BYTES, finite_number, integer
from .research_project import checked_id
from .workbench import _png, runtime_record

REQUEST_FIELDS = {"source_id", "selection", "channels", "projection", "max_size"}
CHANNEL_FIELDS = {"channel", "low", "high", "gamma", "color", "opacity", "visible"}
SELECTION_FIELDS = {"x", "y", "width", "height", "t", "c", "z", "level"}


def validate_channels(channels: Any) -> list[dict[str, Any]]:
    from .source_annotations import COLOR

    if not isinstance(channels, list) or not 1 <= len(channels) <= 16:
        raise ValueError("Vision requires 1-16 explicit channels")
    seen = set()
    for item in channels:
        if not isinstance(item, dict) or set(item) != CHANNEL_FIELDS:
            raise ValueError("Vision channel fields must be exact")
        channel = integer(item["channel"], "channel", 0, 1_000_000)
        if channel in seen:
            raise ValueError("Vision channels must be unique")
        seen.add(channel)
        low = finite_number(item["low"], "low", -1e30, 1e30)
        high = finite_number(item["high"], "high", -1e30, 1e30)
        if high <= low:
            raise ValueError("Display high must exceed low")
        finite_number(item["gamma"], "gamma", 0.1, 10)
        finite_number(item["opacity"], "opacity", 0, 1)
        if not isinstance(item["color"], str) or not COLOR.fullmatch(item["color"]):
            raise ValueError("Display color must be hexadecimal")
        if not isinstance(item["visible"], bool):
            raise ValueError("Display visibility must be boolean")
    return channels


def validate_source_image(workbench, request, *, working_bytes=None) -> dict[str, Any]:
    """Metadata-only preflight; no source samples or implicit crop defaults."""
    if not isinstance(request, dict) or set(request) != REQUEST_FIELDS:
        raise ValueError("Vision request fields must be exact")
    source_id = checked_id(request["source_id"])
    supplied = request["selection"]
    if (
        not isinstance(supplied, dict)
        or not set(supplied) >= SELECTION_FIELDS
        or set(supplied) - (SELECTION_FIELDS | {"z_stop"})
    ):
        raise ValueError("Vision requires explicit crop and T/C/Z/level selection")
    channels = validate_channels(request["channels"])
    max_size = integer(request["max_size"], "max_size", 64, 2048)
    projection = request["projection"]
    if projection not in {"plane", "max", "mean"}:
        raise ValueError("Vision projection must be plane, max or mean")
    if (projection == "plane") == ("z_stop" in supplied):
        raise ValueError("Projection and explicit Z range disagree")
    selection = workbench.selection(source_id, supplied)
    if selection["width"] > 2048 or selection["height"] > 2048:
        raise ValueError("Vision crop is limited to 2048 pixels per edge")
    # Validate every channel, including invisible ones, before decoding the first.
    for channel in channels:
        workbench.selection(source_id, {**selection, "c": channel["channel"]})
    budget = DEFAULT_WORKING_BYTES if working_bytes is None else working_bytes
    integer(budget, "working bytes", 1024, 8 * 1024**3)
    depth = selection.get("z_stop", selection["z"] + 1) - selection["z"]
    # Reserve decoded/projection/intermediate arrays and compositing/image buffers.
    estimate = selection["width"] * selection["height"] * (depth * 96 + 96)
    if estimate > min(budget, DEFAULT_WORKING_BYTES):
        raise PermissionError("Vision working-memory estimate exceeds its allowance")
    source = workbench.project.source(source_id, verify=True)
    rgb = source["metadata"].get("sample_semantics") in {"RGB", "RGBA"}
    if rgb and (len(channels) != 1 or projection != "plane"):
        raise ValueError("Interleaved RGB requires a single plane display")
    return {
        "source_id": source_id,
        "source_sha256": source["sha256"],
        "selection": selection,
        "channels": channels,
        "projection": projection,
        "max_size": max_size,
        "estimated_working_bytes": estimate,
        "interleaved_rgb": rgb,
    }


def render_source_image(workbench, request, *, working_bytes=None) -> dict[str, Any]:
    frame = validate_source_image(workbench, request, working_bytes=working_bytes)
    selection = frame["selection"]
    composite = np.zeros((selection["height"], selection["width"], 3), dtype=np.float64)
    geometry = None
    color_management = []
    budget = (
        min(DEFAULT_WORKING_BYTES, working_bytes)
        if working_bytes is not None
        else DEFAULT_WORKING_BYTES
    )
    for channel in frame["channels"]:
        display = {key: value for key, value in channel.items() if key != "opacity"}
        view = workbench.view(
            {
                "source_id": frame["source_id"],
                "selection": selection,
                "channels": [display],
                "projection": None if frame["projection"] == "plane" else frame["projection"],
            },
            working_bytes=min(DEFAULT_WORKING_BYTES, working_bytes)
            if working_bytes is not None
            else DEFAULT_WORKING_BYTES,
        )
        geometry = view["geometry"]
        icc = view["display"][0].get("icc")
        if icc is not None:
            allowed = {
                "source_status",
                "source_icc_sha256",
                "source_icc_bytes",
                "display_space",
                "transform",
                "rendering_intent",
                "output_icc_sha256",
                "pillow_version",
                "littlecms_version",
            }
            color_management.append(
                {
                    "channel": channel["channel"],
                    "icc": {key: value for key, value in icc.items() if key in allowed}
                    if isinstance(icc, dict)
                    else "unmanaged",
                }
            )
        with Image.open(
            io.BytesIO(base64.b64decode(view["image"].split(",", 1)[1], validate=True))
        ) as image:
            rendered = np.asarray(image.convert("RGB"), dtype=np.float64)
            if frame["interleaved_rgb"]:
                rendered = 255 * np.clip(
                    (rendered - channel["low"]) / (channel["high"] - channel["low"]), 0, 1
                ) ** (1 / channel["gamma"])
                color = np.array([int(channel["color"][n : n + 2], 16) for n in (1, 3, 5)]) / 255
                rendered *= color
            if channel["visible"]:
                composite += rendered * channel["opacity"]
    pixels = np.round(np.clip(composite, 0, 255)).astype(np.uint8)
    image = Image.fromarray(pixels)
    image.thumbnail((frame["max_size"], frame["max_size"]), Image.Resampling.LANCZOS)
    source = workbench.project.source(frame["source_id"], verify=True)
    if source["sha256"] != frame["source_sha256"]:
        raise PermissionError("Vision source changed during rendering")
    return {
        "image": _png(np.asarray(image)),
        "source_id": frame["source_id"],
        "source_sha256": frame["source_sha256"],
        "rendering": {
            "selection": selection,
            "geometry": geometry,
            "channels": frame["channels"],
            "projection": frame["projection"],
            "max_size": frame["max_size"],
            "output_size": list(image.size),
            "display_only": True,
            "runtime": {**runtime_record(), "pillow": pillow_version},
            "sample_basis": "interleaved RGB display samples; no biological-channel inference"
            if frame["interleaved_rgb"]
            else "explicit scalar channel planes",
            "scientific_validation": "not established",
            "resampling": "Lanczos thumbnail; no upsampling",
            "compositing": "Per-channel RGB8, opacity-weighted sum, clipping and RGB8 output",
            "color_management": color_management,
            "resource_estimate": {
                "working_bytes": budget,
                "estimated_working_bytes": frame["estimated_working_bytes"],
            },
        },
    }


def validate_png(image_url: Any) -> bytes:
    """Bound actual protocol images independently of render request receipts."""
    prefix = "data:image/png;base64,"
    if (
        not isinstance(image_url, str)
        or not image_url.startswith(prefix)
        or len(image_url) > 24 * 1024**2
    ):
        raise ValueError("Vision image exceeds its encoded bound or is not PNG")
    data = base64.b64decode(image_url[len(prefix) :], validate=True)
    if len(data) > 16 * 1024**2:
        raise ValueError("Vision PNG exceeds its byte bound")
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or image.mode not in {"RGB", "RGBA", "L", "P"}:
            raise ValueError("Unsupported vision image format")
        if not 1 <= image.width <= 2048 or not 1 <= image.height <= 2048:
            raise ValueError("Vision image dimensions exceed their bound")
        image.verify()
    return data
