"""Bounded native-value inspection and rectangular image reads.

This module is an engine-only foundation.  It does not expose source paths in
returned value objects, does not apply display normalisation, and never eagerly
materialises a TIFF/IMS volume.  Callers must provide an explicit decoded-memory
budget for every selection (or accept the conservative default).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import math
import re
import stat
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import h5py
import numpy as np
import tifffile
from PIL import Image, ImageCms, UnidentifiedImageError

from .ims import _color_from_table, _fluorophore_color_from_name

if TYPE_CHECKING:
    from .quantitative import Geometry

DEFAULT_NATIVE_READ_BUDGET_BYTES = 64 * 1024 * 1024
MAX_NATIVE_READ_BUDGET_BYTES = 512 * 1024 * 1024
MAX_DECODED_SEGMENT_BYTES = 64 * 1024 * 1024
MAX_OME_XML_BYTES = 8 * 1024 * 1024
MAX_EMBEDDED_ICC_BYTES = 4 * 1024 * 1024

# Generated once with Pillow 12.3.0 and LittleCMS 2.19 using
# ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes(). The
# profile declares "No copyright, use freely" and is embedded byte-for-byte so
# its ICC date header and resulting artifact hashes remain stable across workers.
SRGB_OUTPUT_PROFILE_SHA256 = "84ed4269186d77548852f98e2d3f108ddc7235201f913cd8df0ff468c85c8113"
_SRGB_OUTPUT_PROFILE_BASE64 = (
    "AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACQAIABAANAAUYWNzcEFQUEwAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hh"
    "ZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAg"
    "Z1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMA"
    "AAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAA"
    "ADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFla"
    "IAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPc"
    "AADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcA"
    "ALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAA"
    "VHsAAEzNAACZmgAAJmYAAA9c"
)


def srgb_output_profile_bytes() -> bytes:
    """Return the pinned canonical sRGB output profile payload."""

    return base64.b64decode(_SRGB_OUTPUT_PROFILE_BASE64, validate=True)


_IMS_GROUP = re.compile(r"^(?P<label>ResolutionLevel|TimePoint|Channel) (?P<index>\d+)$")
_SUPPORTED_AXES = frozenset("TCZYXS")
_NUMERIC_KINDS = frozenset("buif")
_LENGTH_TO_MICROMETRES = {
    "Ym": 1e30,
    "Zm": 1e27,
    "Em": 1e24,
    "Pm": 1e21,
    "Tm": 1e18,
    "Gm": 1e15,
    "Mm": 1e12,
    "km": 1e9,
    "hm": 1e8,
    "dam": 1e7,
    "m": 1e6,
    "dm": 1e5,
    "cm": 1e4,
    "mm": 1e3,
    "µm": 1.0,
    "μm": 1.0,
    "um": 1.0,
    "nm": 1e-3,
    "pm": 1e-6,
    "fm": 1e-9,
    "am": 1e-12,
    "zm": 1e-15,
    "ym": 1e-18,
    "Å": 1e-4,
    "thou": 25.4,
    "li": 25_400.0 / 12.0,
    "in": 25_400.0,
    "ft": 304_800.0,
    "yd": 914_400.0,
    "mi": 1_609_344_000.0,
    "ua": 149_597_870_700_000_000.0,
    "ly": 9.4607304725808e21,
    "pc": 3.085677581491367e22,
    "pt": 25_400.0 / 72.0,
}
_NONPHYSICAL_LENGTH_UNITS = frozenset(("pixel", "reference frame"))
_TIME_TO_SECONDS = {
    "Ys": 1e24,
    "Zs": 1e21,
    "Es": 1e18,
    "Ps": 1e15,
    "Ts": 1e12,
    "Gs": 1e9,
    "Ms": 1e6,
    "ks": 1e3,
    "hs": 1e2,
    "das": 1e1,
    "s": 1.0,
    "ds": 1e-1,
    "cs": 1e-2,
    "ms": 1e-3,
    "µs": 1e-6,
    "ns": 1e-9,
    "ps": 1e-12,
    "fs": 1e-15,
    "as": 1e-18,
    "zs": 1e-21,
    "ys": 1e-24,
    "min": 60.0,
    "h": 3600.0,
    "d": 86_400.0,
}


class NativeImageError(ValueError):
    """Raised when native pixels cannot be inspected or read safely."""


class NativeReadBudgetError(NativeImageError):
    """Raised before pixel access when a selection can exceed its memory budget."""

    def __init__(self, required_bytes: int, budget_bytes: int) -> None:
        self.required_bytes = required_bytes
        self.budget_bytes = budget_bytes
        super().__init__(
            f"The native selection can require {required_bytes / (1024 * 1024):,.1f} MiB, "
            f"above its {budget_bytes / (1024 * 1024):,.1f} MiB decoded-memory budget. "
            "No pixel data was read."
        )


class NativeSourceChangedError(RuntimeError):
    """Raised when the full source SHA-256 changes across an operation."""


@dataclass(frozen=True, slots=True)
class NativeDimensions:
    """Canonical image dimensions; S denotes interleaved colour samples."""

    t: int
    c: int
    z: int
    y: int
    x: int
    s: int = 1


@dataclass(frozen=True, slots=True)
class PhysicalCalibration:
    """Positive spacing values aligned exactly with ``axes``."""

    axes: Literal["YX", "ZYX"]
    spacing: tuple[float, ...]
    unit: str


@dataclass(frozen=True, slots=True)
class NativeTimeCalibration:
    """Declared temporal coordinates without inventing missing frames or cadence."""

    source: Literal["ome-plane-delta-t", "ome-time-increment", "ims-time-info"]
    timestamps: tuple[str, ...] = ()
    elapsed_times: tuple[float, ...] = ()
    frame_intervals: tuple[float, ...] = ()
    uniform_interval: float | None = None
    interval_unit: Literal["s"] = "s"


@dataclass(frozen=True, slots=True)
class NativePlanePosition:
    """One indexed OME stage position; its image-pixel anchor is unspecified."""

    t: int
    c: int
    z: int
    position_xyz: tuple[float | None, float | None, float | None]
    units_xyz: tuple[str | None, str | None, str | None]
    position_micrometres_xyz: tuple[float | None, float | None, float | None]
    sample: int | None = None


@dataclass(frozen=True, slots=True)
class NativePlaneTime:
    """One indexed OME plane time, retaining raw and normalized coordinates."""

    t: int
    c: int
    z: int
    delta_t: float
    delta_t_unit: str
    delta_t_seconds: float
    sample: int | None = None


@dataclass(frozen=True, slots=True)
class NativeDisplayIssue:
    """One present acquisition-display field that could not be used safely."""

    field: str
    reason: str


@dataclass(frozen=True, slots=True)
class NativeChannelDisplay:
    """Validated acquisition display metadata for one scalar source channel."""

    channel: int
    color_mode: Literal["base-color", "table-color", "ome-rgba"] | None = None
    color_mode_basis: Literal["ims-ColorMode", "ome-Channel-Color"] | None = None
    color_rgb: tuple[float, float, float] | None = None
    color_basis: Literal["ims-Color", "ome-Channel-Color"] | None = None
    value_range: tuple[float, float] | None = None
    range_basis: Literal["ims-ColorRange"] | None = None
    gamma: float | None = None
    gamma_basis: Literal["ims-GammaCorrection"] | None = None
    opacity: float | None = None
    opacity_basis: Literal["ims-ColorOpacity", "ome-Channel-Color-alpha"] | None = None
    visible: bool | None = None
    visibility_basis: Literal["ims-Visible"] | None = None
    ignored: tuple[NativeDisplayIssue, ...] = ()


@dataclass(frozen=True, slots=True)
class NativeRgbColorPolicy:
    """Renderer-safe policy for interleaved source RGB(A) samples."""

    source_space: Literal["scalar", "source-device-RGB"]
    source_status: Literal[
        "not-applicable", "missing", "embedded-usable", "embedded-invalid", "embedded-oversized"
    ]
    source_icc_sha256: str | None
    source_icc_bytes: int | None
    display_space: Literal["not-applicable", "sRGB", "uncharacterized-source-RGB"]
    transform: Literal["none", "Pillow-ImageCms-source-to-sRGB"]
    rendering_intent: int | None = None
    output_icc_sha256: str | None = None
    ignored_reason: str | None = None


@dataclass(frozen=True, slots=True)
class NativeLevel:
    """Declared geometry and calibration for one native pyramid level."""

    index: int
    dimensions: NativeDimensions
    calibration: PhysicalCalibration | None
    origin_xyz: tuple[float, float, float] | None = None


@dataclass(frozen=True, slots=True)
class NativeCapabilities:
    """Truthful operations supported by this reader for the selected series."""

    region_read: bool
    select_t: bool
    select_c: bool
    select_z: bool
    pyramid_levels: bool
    tiled: bool
    read_modes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class NativeImageMetadata:
    """Path-redacted source metadata with a full-file integrity fingerprint."""

    format: str
    axes: Literal["TCZYX", "TCZYXS"]
    shape: tuple[int, ...]
    source_axes: str
    source_shape: tuple[int, ...]
    dimensions: NativeDimensions
    levels: tuple[NativeLevel, ...]
    channel_names: tuple[str, ...]
    channel_dtypes: tuple[str, ...]
    sample_semantics: Literal["none", "RGB", "RGBA"]
    physical_calibration: PhysicalCalibration | None
    sha256: str
    selected_series: int
    series_count: int
    capabilities: NativeCapabilities
    timing: NativeTimeCalibration | None = None
    plane_positions: tuple[NativePlanePosition, ...] = ()
    plane_times: tuple[NativePlaneTime, ...] = ()
    acquisition_display: tuple[NativeChannelDisplay, ...] = ()
    rgb_color_policy: NativeRgbColorPolicy | None = None


@dataclass(frozen=True, slots=True)
class NativeSelection:
    """One T/C/Z plane and half-open XY rectangle at a declared native level."""

    x: int
    y: int
    width: int
    height: int
    t: int = 0
    c: int = 0
    z: int = 0
    level: int = 0
    series: int = 0
    budget_bytes: int = DEFAULT_NATIVE_READ_BUDGET_BYTES
    expected_sha256: str | None = None


@dataclass(frozen=True, slots=True)
class NativeRegion:
    """An immutable native-value region and the provenance needed to interpret it."""

    pixels: np.ndarray
    axes: Literal["YX", "YXS"]
    selection: NativeSelection
    sha256: str
    format: str
    native_dtype: str
    read_mode: str
    estimated_peak_bytes: int
    integrity_mode: Literal["full-sha256", "stat-verified-session"]


@dataclass(frozen=True, slots=True)
class NativeIntegrityReceipt:
    """Result of an explicit source-integrity verification boundary."""

    sha256: str
    integrity_mode: Literal["full-sha256"]


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True, slots=True)
class _Inspection:
    metadata: NativeImageMetadata
    kind: Literal["tiff", "ims", "ordinary"]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_expected_sha256(expected: str) -> None:
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        raise NativeImageError("expected_sha256 must be 64 lowercase hexadecimal characters.")


def _checked_fingerprint(path: Path, expected: str | None = None) -> str:
    if expected is not None:
        _validate_expected_sha256(expected)
    fingerprint = _sha256(path)
    if expected is not None and not hmac.compare_digest(fingerprint, expected):
        raise NativeSourceChangedError(
            "The source does not match the expected full SHA-256 fingerprint."
        )
    return fingerprint


def _verify_unchanged(path: Path, before: str) -> None:
    if not hmac.compare_digest(_sha256(path), before):
        raise NativeSourceChangedError("The source changed while native image data was read.")


def _file_identity(path: Path) -> _FileIdentity:
    try:
        status = path.stat()
    except OSError as exc:
        raise NativeSourceChangedError("The native source is no longer accessible.") from exc
    if not stat.S_ISREG(status.st_mode):
        raise NativeSourceChangedError("The native source is no longer a regular file.")
    return _FileIdentity(
        device=int(status.st_dev),
        inode=int(status.st_ino),
        size=int(status.st_size),
        mtime_ns=int(status.st_mtime_ns),
        ctime_ns=int(status.st_ctime_ns),
    )


def _validate_dtype(dtype: np.dtype[Any], *, context: str) -> np.dtype[Any]:
    dtype = np.dtype(dtype)
    if dtype.kind not in _NUMERIC_KINDS:
        raise NativeImageError(f"{context} uses unsupported non-real sample type {dtype}.")
    if dtype.kind in "iu" and dtype.itemsize > 4:
        raise NativeImageError(f"{context} uses unsupported 64-bit integer samples ({dtype}).")
    if dtype.kind == "f" and dtype.itemsize > 8:
        raise NativeImageError(
            f"{context} uses unsupported floating-point samples wider than 64 bits ({dtype})."
        )
    return dtype


def _validate_positive_int(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise NativeImageError(f"{name} must be a positive integer.")
    return value


def _validate_selection(selection: NativeSelection, dimensions: NativeDimensions) -> None:
    for name in ("x", "y", "t", "c", "z", "level", "series"):
        value = getattr(selection, name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise NativeImageError(f"{name} must be a non-negative integer.")
    _validate_positive_int(selection.width, "width")
    _validate_positive_int(selection.height, "height")
    budget = _validate_positive_int(selection.budget_bytes, "budget_bytes")
    if budget > MAX_NATIVE_READ_BUDGET_BYTES:
        raise NativeImageError(
            f"budget_bytes cannot exceed {MAX_NATIVE_READ_BUDGET_BYTES // (1024 * 1024)} MiB."
        )
    if selection.t >= dimensions.t:
        raise NativeImageError(f"T index {selection.t} is outside 0..{dimensions.t - 1}.")
    if selection.c >= dimensions.c:
        raise NativeImageError(f"C index {selection.c} is outside 0..{dimensions.c - 1}.")
    if selection.z >= dimensions.z:
        raise NativeImageError(f"Z index {selection.z} is outside 0..{dimensions.z - 1}.")
    if selection.x + selection.width > dimensions.x:
        raise NativeImageError("The requested X rectangle extends outside the selected level.")
    if selection.y + selection.height > dimensions.y:
        raise NativeImageError("The requested Y rectangle extends outside the selected level.")


def _decoded_bytes(shape: tuple[int, ...], dtype: np.dtype[Any]) -> int:
    size = int(dtype.itemsize)
    for dimension in shape:
        size *= _validate_positive_int(int(dimension), "decoded dimension")
    return size


def _require_budget(required: int, budget: int) -> None:
    if required > budget:
        raise NativeReadBudgetError(required, budget)


def _freeze_pixels(pixels: np.ndarray) -> np.ndarray:
    if not pixels.flags.c_contiguous or not pixels.flags.owndata:
        pixels = np.array(pixels, copy=True, order="C")
    else:
        pixels = np.asarray(pixels)
    if pixels.dtype.kind == "f" and not np.isfinite(pixels).all():
        raise NativeImageError("The selected native region contains non-finite sample values.")
    pixels.flags.writeable = False
    return pixels


def _canonical_dimensions(axes: str, shape: tuple[int, ...]) -> NativeDimensions:
    mapping = dict(zip(axes, shape, strict=True))
    return NativeDimensions(**{axis.lower(): int(mapping.get(axis, 1)) for axis in "TCZYXS"})


def _canonical_shape(dimensions: NativeDimensions) -> tuple[str, tuple[int, ...]]:
    if dimensions.s > 1:
        return "TCZYXS", (
            dimensions.t,
            dimensions.c,
            dimensions.z,
            dimensions.y,
            dimensions.x,
            dimensions.s,
        )
    return "TCZYX", (
        dimensions.t,
        dimensions.c,
        dimensions.z,
        dimensions.y,
        dimensions.x,
    )


def _scaled_calibration(
    calibration: PhysicalCalibration | None,
    base: NativeDimensions,
    level: NativeDimensions,
) -> PhysicalCalibration | None:
    if calibration is None:
        return None
    size = {"Z": base.z, "Y": base.y, "X": base.x}
    level_size = {"Z": level.z, "Y": level.y, "X": level.x}
    spacing = tuple(
        value * size[axis] / level_size[axis]
        for axis, value in zip(calibration.axes, calibration.spacing, strict=True)
    )
    return PhysicalCalibration(calibration.axes, spacing, calibration.unit)


def _finite_float(value: Any, *, context: str, positive: bool = False) -> float:
    try:
        result = float(_text(value).strip())
    except (TypeError, ValueError, OverflowError) as exc:
        raise NativeImageError(f"{context} is not a valid number.") from exc
    if not math.isfinite(result) or (positive and result <= 0):
        condition = "a positive finite number" if positive else "finite"
        raise NativeImageError(f"{context} must be {condition}.")
    return result


def _length_in_micrometres(value: float, unit: str, *, context: str) -> float:
    factor = _LENGTH_TO_MICROMETRES.get(unit)
    if factor is None:
        raise NativeImageError(f"{context} uses unsupported length unit {unit!r}.")
    normalized = value * factor
    if not math.isfinite(normalized) or (value != 0 and normalized == 0):
        raise NativeImageError(f"{context} is outside the supported numeric range.")
    return normalized


def _time_in_seconds(value: float, unit: str, *, context: str) -> float:
    factor = _TIME_TO_SECONDS.get(unit)
    if factor is None:
        raise NativeImageError(f"{context} uses unsupported time unit {unit!r}.")
    normalized = value * factor
    if not math.isfinite(normalized) or (value != 0 and normalized == 0):
        raise NativeImageError(f"{context} is outside the supported numeric range.")
    return normalized


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").rstrip("\x00")
    if isinstance(value, str):
        return value.rstrip("\x00")
    array = np.asarray(value)
    if array.ndim == 0:
        return _text(array.item())
    if array.dtype.kind == "S":
        return (
            b"".join(bytes(item) for item in array.reshape(-1))
            .decode("utf-8", errors="replace")
            .rstrip("\x00")
        )
    if array.dtype.kind == "U":
        return "".join(str(item) for item in array.reshape(-1)).rstrip("\x00")
    if array.size == 1:
        return str(array.reshape(-1)[0])
    return " ".join(str(item) for item in array.reshape(-1))


def _display_issue(field: str, reason: str) -> NativeDisplayIssue:
    return NativeDisplayIssue(field=field, reason=reason)


def _display_numbers(value: Any, count: int) -> tuple[float, ...] | None:
    try:
        parts = _text(value).split()
        numbers = tuple(float(part) for part in parts)
    except (TypeError, ValueError, OverflowError):
        return None
    if len(numbers) != count or not all(math.isfinite(number) for number in numbers):
        return None
    return numbers


def _native_dtype_bounds(dtype: np.dtype[Any]) -> tuple[float, float] | None:
    dtype = np.dtype(dtype)
    if np.issubdtype(dtype, np.bool_):
        return 0.0, 1.0
    if np.issubdtype(dtype, np.integer):
        limits = np.iinfo(dtype)
        return float(limits.min), float(limits.max)
    return None


def _ims_acquisition_display(
    root: h5py.File, channel_dtypes: tuple[str, ...]
) -> tuple[NativeChannelDisplay, ...]:
    info = _local_hdf5_child(root, "DataSetInfo")
    records: list[NativeChannelDisplay] = []
    for index, dtype_name in enumerate(channel_dtypes):
        channel = (
            _local_hdf5_child(info, f"Channel {index}") if isinstance(info, h5py.Group) else None
        )
        if not isinstance(channel, h5py.Group):
            records.append(NativeChannelDisplay(channel=index))
            continue

        ignored: list[NativeDisplayIssue] = []
        color_mode = None
        color_mode_basis = None
        unrecognized_color_mode = False
        color_table_dataset = channel.get("ColorTable") if "ColorTable" in channel else None
        table_color = (
            _color_from_table(color_table_dataset) if color_table_dataset is not None else None
        )

        if "ColorMode" in channel.attrs:
            raw_mode = _text(channel.attrs["ColorMode"]).strip().casefold()
            if raw_mode == "basecolor":
                color_mode = "base-color"
                color_mode_basis = "ims-ColorMode"
            elif raw_mode == "tablecolor":
                color_mode = "table-color"
                color_mode_basis = "ims-ColorMode"
                if table_color is None:
                    ignored.append(
                        _display_issue(
                            "ColorMode", "table-colour acquisition LUTs are not supported"
                        )
                    )
            else:
                unrecognized_color_mode = True
                ignored.append(_display_issue("ColorMode", "unrecognized acquisition colour mode"))

        color_rgb = None
        color_basis = None
        if "Color" in channel.attrs:
            values = _display_numbers(channel.attrs["Color"], 3)
            if color_mode == "table-color":
                if table_color is None:
                    ignored.append(
                        _display_issue("Color", "ignored for unsupported table-colour mode")
                    )
            elif unrecognized_color_mode:
                ignored.append(
                    _display_issue("Color", "ignored for unrecognized acquisition colour mode")
                )
            elif values is None or not all(0.0 <= value <= 1.0 for value in values):
                ignored.append(
                    _display_issue("Color", "expected three finite components from zero to one")
                )
            else:
                color_rgb = (values[0], values[1], values[2])
                color_basis = "ims-Color"

        if table_color is not None:
            color_rgb = table_color
            color_basis = "ims-ColorTable"
        elif (
            color_rgb is None
            and not unrecognized_color_mode
            and color_mode != "table-color"
            and "Name" in channel.attrs
        ):
            name_color = _fluorophore_color_from_name(_text(channel.attrs["Name"]))
            if name_color is not None:
                color_rgb = name_color
                color_basis = "fluorophore-name-lookup"

        value_range = None
        range_basis = None
        if "ColorRange" in channel.attrs:
            values = _display_numbers(channel.attrs["ColorRange"], 2)
            dtype_bounds = _native_dtype_bounds(np.dtype(dtype_name))
            if values is None or values[1] <= values[0]:
                ignored.append(
                    _display_issue("ColorRange", "expected two increasing finite native values")
                )
            elif dtype_bounds is not None and (
                values[0] < dtype_bounds[0] or values[1] > dtype_bounds[1]
            ):
                ignored.append(_display_issue("ColorRange", "outside native channel dtype bounds"))
            else:
                value_range = (values[0], values[1])
                range_basis = "ims-ColorRange"

        gamma = None
        gamma_basis = None
        if "GammaCorrection" in channel.attrs:
            values = _display_numbers(channel.attrs["GammaCorrection"], 1)
            if values is None or not 0.1 <= values[0] <= 10.0:
                ignored.append(
                    _display_issue("GammaCorrection", "outside supported range 0.1 to 10")
                )
            else:
                gamma = values[0]
                gamma_basis = "ims-GammaCorrection"

        opacity = None
        opacity_basis = None
        if "ColorOpacity" in channel.attrs:
            values = _display_numbers(channel.attrs["ColorOpacity"], 1)
            if values is None or not 0.0 <= values[0] <= 1.0:
                ignored.append(
                    _display_issue("ColorOpacity", "expected a finite value from zero to one")
                )
            else:
                opacity = values[0]
                opacity_basis = "ims-ColorOpacity"

        visible = None
        visibility_basis = None
        if "Visible" in channel.attrs:
            raw_visible = _text(channel.attrs["Visible"]).strip().casefold()
            if raw_visible in {"true", "1"}:
                visible = True
                visibility_basis = "ims-Visible"
            elif raw_visible in {"false", "0"}:
                visible = False
                visibility_basis = "ims-Visible"
            else:
                ignored.append(_display_issue("Visible", "expected true, false, zero, or one"))

        records.append(
            NativeChannelDisplay(
                channel=index,
                color_mode=color_mode,
                color_mode_basis=color_mode_basis,
                color_rgb=color_rgb,
                color_basis=color_basis,
                value_range=value_range,
                range_basis=range_basis,
                gamma=gamma,
                gamma_basis=gamma_basis,
                opacity=opacity,
                opacity_basis=opacity_basis,
                visible=visible,
                visibility_basis=visibility_basis,
                ignored=tuple(ignored),
            )
        )
    return tuple(records)


def _ome_channel_display(
    channels: list[ET.Element], dimensions: NativeDimensions
) -> tuple[NativeChannelDisplay, ...]:
    records: list[NativeChannelDisplay] = []
    for index in range(dimensions.c):
        element = channels[index] if index < len(channels) else None
        ignored: list[NativeDisplayIssue] = []
        color_rgb = None
        opacity = None
        color_mode = None
        color_mode_basis = None
        color_basis = None
        opacity_basis = None
        if element is not None and "Color" in element.attrib:
            raw = element.attrib["Color"].strip()
            if dimensions.s > 1:
                ignored.append(
                    _display_issue(
                        "OME Channel Color", "not applied to interleaved source RGB samples"
                    )
                )
            elif re.fullmatch(r"[+-]?\d+", raw) is None:
                ignored.append(
                    _display_issue("OME Channel Color", "expected a signed 32-bit RGBA integer")
                )
            else:
                encoded = int(raw)
                if not -(2**31) <= encoded <= 2**31 - 1:
                    ignored.append(
                        _display_issue("OME Channel Color", "outside signed 32-bit range")
                    )
                else:
                    unsigned = encoded & 0xFFFFFFFF
                    color_rgb = (
                        ((unsigned >> 24) & 0xFF) / 255.0,
                        ((unsigned >> 16) & 0xFF) / 255.0,
                        ((unsigned >> 8) & 0xFF) / 255.0,
                    )
                    opacity = (unsigned & 0xFF) / 255.0
                    color_mode = "ome-rgba"
                    color_mode_basis = "ome-Channel-Color"
                    color_basis = "ome-Channel-Color"
                    opacity_basis = "ome-Channel-Color-alpha"
        records.append(
            NativeChannelDisplay(
                channel=index,
                color_mode=color_mode,
                color_mode_basis=color_mode_basis,
                color_rgb=color_rgb,
                color_basis=color_basis,
                opacity=opacity,
                opacity_basis=opacity_basis,
                ignored=tuple(ignored),
            )
        )
    return tuple(records)


def _rgb_policy_without_profile(
    semantics: Literal["none", "RGB", "RGBA"],
) -> NativeRgbColorPolicy:
    if semantics == "none":
        return NativeRgbColorPolicy(
            source_space="scalar",
            source_status="not-applicable",
            source_icc_sha256=None,
            source_icc_bytes=None,
            display_space="not-applicable",
            transform="none",
        )
    return NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="missing",
        source_icc_sha256=None,
        source_icc_bytes=None,
        display_space="uncharacterized-source-RGB",
        transform="none",
    )


def _rgb_policy_from_profile(
    raw_profile: Any, semantics: Literal["none", "RGB", "RGBA"]
) -> NativeRgbColorPolicy:
    if semantics == "none":
        return _rgb_policy_without_profile(semantics)
    if raw_profile is None:
        return _rgb_policy_without_profile(semantics)
    if not isinstance(raw_profile, bytes) or not raw_profile:
        return NativeRgbColorPolicy(
            source_space="source-device-RGB",
            source_status="embedded-invalid",
            source_icc_sha256=None,
            source_icc_bytes=None,
            display_space="uncharacterized-source-RGB",
            transform="none",
            ignored_reason="embedded ICC profile is not non-empty bytes",
        )
    profile_sha256 = hashlib.sha256(raw_profile).hexdigest()
    if len(raw_profile) > MAX_EMBEDDED_ICC_BYTES:
        return NativeRgbColorPolicy(
            source_space="source-device-RGB",
            source_status="embedded-oversized",
            source_icc_sha256=profile_sha256,
            source_icc_bytes=len(raw_profile),
            display_space="uncharacterized-source-RGB",
            transform="none",
            ignored_reason=f"embedded ICC profile exceeds {MAX_EMBEDDED_ICC_BYTES} bytes",
        )
    try:
        source_profile = ImageCms.ImageCmsProfile(io.BytesIO(raw_profile))
        output_bytes = srgb_output_profile_bytes()
        output_profile = ImageCms.ImageCmsProfile(io.BytesIO(output_bytes))
        rendering_intent = int(ImageCms.getDefaultIntent(source_profile))
        ImageCms.buildTransform(
            source_profile,
            output_profile,
            semantics,
            semantics,
            rendering_intent,
            0,
        )
    except Exception:
        return NativeRgbColorPolicy(
            source_space="source-device-RGB",
            source_status="embedded-invalid",
            source_icc_sha256=profile_sha256,
            source_icc_bytes=len(raw_profile),
            display_space="uncharacterized-source-RGB",
            transform="none",
            ignored_reason="embedded ICC profile cannot define a source-to-sRGB transform",
        )
    return NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="embedded-usable",
        source_icc_sha256=profile_sha256,
        source_icc_bytes=len(raw_profile),
        display_space="sRGB",
        transform="Pillow-ImageCms-source-to-sRGB",
        rendering_intent=rendering_intent,
        output_icc_sha256=hashlib.sha256(output_bytes).hexdigest(),
    )


def _ordinary_rgb_policy(
    image: Image.Image, semantics: Literal["none", "RGB", "RGBA"]
) -> NativeRgbColorPolicy:
    return _rgb_policy_from_profile(image.info.get("icc_profile"), semantics)


def _tiff_icc_profile(tif: tifffile.TiffFile, series_index: int) -> Any:
    page = tif.series[series_index].pages[0]
    if page is None:
        return None
    # TIFF tag 34675 is named InterColorProfile by tifffile.
    tag = _tiff_keyframe(page).tags.get(34675)
    return None if tag is None else tag.value


def _local_hdf5_child(group: h5py.Group, name: str) -> h5py.Group | h5py.Dataset | None:
    link = group.get(name, getlink=True)
    if isinstance(link, h5py.ExternalLink):
        raise NativeImageError(
            "IMS external links are unsupported because their pixels are outside the "
            "source fingerprint."
        )
    child = group.get(name)
    if child is not None and child.file.id != group.file.id:
        raise NativeImageError("IMS linked pixels outside the selected container are unsupported.")
    return child


def _numbered_hdf5_groups(group: h5py.Group, label: str) -> list[h5py.Group]:
    found: list[tuple[int, h5py.Group]] = []
    for name in group:
        match = _IMS_GROUP.fullmatch(name)
        if match is None or match.group("label") != label:
            continue
        child = _local_hdf5_child(group, name)
        if isinstance(child, h5py.Group):
            found.append((int(match.group("index")), child))
    found.sort(key=lambda item: item[0])
    if [index for index, _ in found] != list(range(len(found))):
        raise NativeImageError(f"IMS {label} indices are not contiguous from zero.")
    return [child for _, child in found]


def _ims_declared_size(channel: h5py.Group, axis: str, fallback: int) -> int:
    name = f"ImageSize{axis}"
    if name not in channel.attrs:
        return fallback
    try:
        value = int(float(_text(channel.attrs[name])))
    except (TypeError, ValueError, OverflowError) as exc:
        raise NativeImageError(f"IMS attribute {name} is invalid.") from exc
    return _validate_positive_int(value, f"IMS attribute {name}")


def _ims_dataset(channel: h5py.Group) -> h5py.Dataset:
    dataset = _local_hdf5_child(channel, "Data")
    if not isinstance(dataset, h5py.Dataset):
        raise NativeImageError("An IMS channel is missing its Data dataset.")
    if dataset.is_virtual or dataset.external:
        raise NativeImageError(
            "IMS virtual or externally stored pixels are outside the source fingerprint."
        )
    _validate_dtype(dataset.dtype, context="IMS channel")
    if dataset.ndim != 3:
        raise NativeImageError("IMS channel data must use the documented Z, Y, X layout.")
    if dataset.chunks is not None:
        chunk_bytes = _decoded_bytes(tuple(int(value) for value in dataset.chunks), dataset.dtype)
        if chunk_bytes > MAX_DECODED_SEGMENT_BYTES:
            raise NativeImageError(
                "An IMS decoded chunk exceeds the 64 MiB native-read segment guard."
            )
    return dataset


def _ims_channel_geometry(channel: h5py.Group) -> tuple[int, int, int]:
    dataset = _ims_dataset(channel)
    z = _ims_declared_size(channel, "Z", int(dataset.shape[0]))
    y = _ims_declared_size(channel, "Y", int(dataset.shape[1]))
    x = _ims_declared_size(channel, "X", int(dataset.shape[2]))
    if any(declared > stored for declared, stored in zip((z, y, x), dataset.shape, strict=True)):
        raise NativeImageError("IMS declared dimensions exceed the stored channel dataset.")
    return z, y, x


def _ims_calibration(
    root: h5py.File, dimensions: NativeDimensions
) -> tuple[PhysicalCalibration | None, tuple[float, float, float] | None]:
    info = _local_hdf5_child(root, "DataSetInfo")
    image = _local_hdf5_child(info, "Image") if isinstance(info, h5py.Group) else None
    if not isinstance(image, h5py.Group):
        return None, None
    extent_names = tuple(f"Ext{bound}{axis}" for axis in range(3) for bound in ("Min", "Max"))
    present = tuple(name in image.attrs for name in extent_names)
    if not any(present):
        return None, None
    if not all(present):
        raise NativeImageError("IMS physical extents are incomplete.")
    lower_xyz: list[float] = []
    spans_xyz: list[float] = []
    for axis in range(3):
        lower = _finite_float(image.attrs[f"ExtMin{axis}"], context=f"IMS ExtMin{axis}")
        upper = _finite_float(image.attrs[f"ExtMax{axis}"], context=f"IMS ExtMax{axis}")
        span = upper - lower
        if not math.isfinite(span) or span <= 0:
            raise NativeImageError(f"IMS extent {axis} must have a positive finite span.")
        lower_xyz.append(lower)
        spans_xyz.append(span)
    unit = ""
    for name in ("Unit", "PhysicalUnit"):
        if name in image.attrs:
            unit = _text(image.attrs[name]).strip()[:40]
            if unit:
                break
    if not unit:
        raise NativeImageError("IMS physical extents do not declare a unit.")
    lower_um_values = tuple(
        _length_in_micrometres(value, unit, context=f"IMS ExtMin{axis}")
        for axis, value in enumerate(lower_xyz)
    )
    spans_um = tuple(
        _length_in_micrometres(value, unit, context=f"IMS extent {axis}")
        for axis, value in enumerate(spans_xyz)
    )
    spacing = (
        spans_um[2] / dimensions.z,
        spans_um[1] / dimensions.y,
        spans_um[0] / dimensions.x,
    )
    if not all(math.isfinite(value) and value > 0 for value in spacing):
        raise NativeImageError("IMS physical spacing is outside the supported numeric range.")
    lower_um = (lower_um_values[0], lower_um_values[1], lower_um_values[2])
    return PhysicalCalibration("ZYX", spacing, "µm"), lower_um


def _ims_time_calibration(root: h5py.File, timepoint_count: int) -> NativeTimeCalibration | None:
    info = _local_hdf5_child(root, "DataSetInfo")
    time_info = _local_hdf5_child(info, "TimeInfo") if isinstance(info, h5py.Group) else None
    if not isinstance(time_info, h5py.Group):
        return None

    declared_counts: list[int] = []
    for name in ("DatasetTimePoints", "DataSetTimePoints", "FileTimePoints"):
        if name not in time_info.attrs:
            continue
        raw = _text(time_info.attrs[name]).strip()
        if re.fullmatch(r"\+?\d+", raw) is None:
            raise NativeImageError(f"IMS TimeInfo {name} is not a non-negative integer.")
        declared_counts.append(int(raw))
    if declared_counts and any(value != timepoint_count for value in declared_counts):
        raise NativeImageError("IMS TimeInfo count disagrees with the stored timepoints.")

    indexed_names: dict[int, str] = {}
    for name in time_info.attrs:
        match = re.fullmatch(r"TimePoint(\d+)", str(name))
        if match is None:
            continue
        index = int(match.group(1))
        if index in indexed_names:
            raise NativeImageError("IMS TimeInfo contains duplicate timestamp indices.")
        indexed_names[index] = str(name)
    if not indexed_names:
        return None
    expected = set(range(1, timepoint_count + 1))
    if set(indexed_names) != expected:
        raise NativeImageError("IMS TimeInfo timestamps are incomplete or out of range.")

    timestamps: list[str] = []
    parsed: list[datetime] = []
    for index in range(1, timepoint_count + 1):
        raw = _text(time_info.attrs[indexed_names[index]]).strip()
        if not raw:
            raise NativeImageError(f"IMS TimePoint{index} timestamp is empty.")
        try:
            instant = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise NativeImageError(
                f"IMS TimePoint{index} is not a supported ISO date-time."
            ) from exc
        timestamps.append(raw)
        parsed.append(instant)
    try:
        elapsed = tuple((instant - parsed[0]).total_seconds() for instant in parsed)
    except TypeError as exc:
        raise NativeImageError("IMS TimeInfo mixes timezone-aware and local timestamps.") from exc
    if not all(math.isfinite(value) for value in elapsed):
        raise NativeImageError("IMS TimeInfo elapsed times are outside the numeric range.")
    intervals = tuple(later - earlier for earlier, later in zip(elapsed, elapsed[1:], strict=False))
    if any(value <= 0 for value in intervals):
        raise NativeImageError("IMS TimeInfo timestamps must be strictly increasing.")
    return NativeTimeCalibration(
        source="ims-time-info",
        timestamps=tuple(timestamps),
        elapsed_times=elapsed,
        frame_intervals=intervals,
    )


def _ims_channel_names(root: h5py.File, count: int) -> tuple[str, ...]:
    info = _local_hdf5_child(root, "DataSetInfo")
    names: list[str] = []
    for index in range(count):
        channel = (
            _local_hdf5_child(info, f"Channel {index}") if isinstance(info, h5py.Group) else None
        )
        name = (
            _text(channel.attrs["Name"]).strip()
            if isinstance(channel, h5py.Group) and "Name" in channel.attrs
            else ""
        )
        names.append(
            name[:160]
            if name and name.casefold() != "(name not specified)"
            else f"Channel {index + 1}"
        )
    return tuple(names)


def _inspect_ims(path: Path, sha256: str) -> NativeImageMetadata:
    try:
        with h5py.File(path, "r", rdcc_nbytes=0) as root:
            if _text(root.attrs.get("ImarisDataSet", "")) != "ImarisDataSet":
                raise NativeImageError("This HDF5 file is not a modern Imaris dataset.")
            dataset_root = _local_hdf5_child(root, "DataSet")
            if not isinstance(dataset_root, h5py.Group):
                raise NativeImageError("The IMS container has no DataSet group.")
            levels = _numbered_hdf5_groups(dataset_root, "ResolutionLevel")
            if not levels:
                raise NativeImageError("The IMS dataset has no ResolutionLevel 0.")

            level_dimensions: list[NativeDimensions] = []
            base_dtypes: tuple[str, ...] | None = None
            base_t = base_c = 0
            tiled = False
            for level_index, level in enumerate(levels):
                timepoints = _numbered_hdf5_groups(level, "TimePoint")
                if not timepoints:
                    raise NativeImageError(f"IMS resolution level {level_index} has no timepoints.")
                level_geometry: tuple[int, int, int] | None = None
                level_dtypes: tuple[str, ...] | None = None
                for timepoint in timepoints:
                    channels = _numbered_hdf5_groups(timepoint, "Channel")
                    if not channels:
                        raise NativeImageError("An IMS timepoint has no Channel 0.")
                    geometries = tuple(_ims_channel_geometry(channel) for channel in channels)
                    if len(set(geometries)) != 1:
                        raise NativeImageError("IMS channel geometry is inconsistent.")
                    dtypes = tuple(str(_ims_dataset(channel).dtype) for channel in channels)
                    if level_geometry is None:
                        level_geometry, level_dtypes = geometries[0], dtypes
                    elif level_geometry != geometries[0] or level_dtypes != dtypes:
                        raise NativeImageError(
                            "IMS geometry or channel types vary across timepoints."
                        )
                    tiled = tiled or any(
                        _ims_dataset(channel).chunks is not None for channel in channels
                    )
                assert level_geometry is not None and level_dtypes is not None
                z, y, x = level_geometry
                dims = NativeDimensions(len(timepoints), len(level_dtypes), z, y, x)
                if level_index == 0:
                    base_t, base_c, base_dtypes = dims.t, dims.c, level_dtypes
                elif dims.t != base_t or dims.c != base_c or level_dtypes != base_dtypes:
                    raise NativeImageError(
                        "IMS timepoint count, channel count, or channel types differ "
                        "between levels."
                    )
                level_dimensions.append(dims)

            assert base_dtypes is not None
            dimensions = level_dimensions[0]
            calibration, extent_min_xyz = _ims_calibration(root, dimensions)
            native_levels_list: list[NativeLevel] = []
            for index, dims in enumerate(level_dimensions):
                level_calibration = _scaled_calibration(calibration, dimensions, dims)
                origin_xyz = None
                if level_calibration is not None and extent_min_xyz is not None:
                    spacing_z, spacing_y, spacing_x = level_calibration.spacing
                    origin_xyz = (
                        extent_min_xyz[0] + spacing_x / 2,
                        extent_min_xyz[1] + spacing_y / 2,
                        extent_min_xyz[2] + spacing_z / 2,
                    )
                    if not all(math.isfinite(value) for value in origin_xyz) or any(
                        centre == lower
                        for centre, lower in zip(origin_xyz, extent_min_xyz, strict=True)
                    ):
                        raise NativeImageError(
                            "IMS voxel-centre origins are outside representable precision."
                        )
                native_levels_list.append(NativeLevel(index, dims, level_calibration, origin_xyz))
            native_levels = tuple(native_levels_list)
            timing = _ims_time_calibration(root, dimensions.t)
            axes, shape = _canonical_shape(dimensions)
            return NativeImageMetadata(
                format="IMS",
                axes=axes,
                shape=shape,
                source_axes="TCZYX",
                source_shape=shape,
                dimensions=dimensions,
                levels=native_levels,
                channel_names=_ims_channel_names(root, dimensions.c),
                channel_dtypes=base_dtypes,
                sample_semantics="none",
                physical_calibration=calibration,
                sha256=sha256,
                selected_series=0,
                series_count=1,
                capabilities=NativeCapabilities(
                    region_read=True,
                    select_t=dimensions.t > 1,
                    select_c=dimensions.c > 1,
                    select_z=dimensions.z > 1,
                    pyramid_levels=len(native_levels) > 1,
                    tiled=tiled,
                    read_modes=("ims-hyperslab",),
                ),
                timing=timing,
                acquisition_display=_ims_acquisition_display(root, base_dtypes),
                rgb_color_policy=_rgb_policy_without_profile("none"),
            )
    except NativeImageError:
        raise
    except (OSError, KeyError, RuntimeError, TypeError, ValueError) as exc:
        raise NativeImageError("Loci could not inspect this IMS container safely.") from exc


def _validate_tiff_axes(axes: str, shape: tuple[int, ...]) -> None:
    if len(axes) != len(shape) or len(set(axes)) != len(axes):
        raise NativeImageError("The TIFF declares invalid or repeated array axes.")
    unsupported = set(axes) - _SUPPORTED_AXES
    if unsupported:
        raise NativeImageError(
            "The TIFF uses unsupported axis labels " + ", ".join(sorted(unsupported)) + "."
        )
    if "Y" not in axes or "X" not in axes:
        raise NativeImageError("The TIFF series does not declare both Y and X axes.")
    if any(int(value) <= 0 for value in shape):
        raise NativeImageError("The TIFF declares an empty array dimension.")


def _tiff_keyframe(page: tifffile.TiffPage | tifffile.TiffFrame) -> tifffile.TiffPage:
    return page.keyframe if isinstance(page, tifffile.TiffFrame) else page


def _tiff_page_layout(
    series: tifffile.TiffPageSeries, owner: tifffile.TiffFile
) -> tuple[int, bool, str]:
    pages = tuple(series.pages)
    if not pages or any(page is None for page in pages):
        raise NativeImageError("The TIFF series contains missing pixel planes.")
    if any(page is not None and page.parent is not owner for page in pages):
        raise NativeImageError(
            "TIFF pixels in companion files are unsupported because their bytes are "
            "outside the selected source fingerprint."
        )
    outer_axes = "".join(axis for axis in series.axes if axis not in "YXS")
    mapping = dict(zip(series.axes, series.shape, strict=True))
    expected_pages = math.prod(int(mapping[axis]) for axis in outer_axes)
    if len(pages) != expected_pages:
        raise NativeImageError(
            "The TIFF page layout cannot be mapped unambiguously to its declared axes."
        )
    first = pages[0]
    assert first is not None
    first_keyframe = _tiff_keyframe(first)
    page_axes = str(first_keyframe.axes)
    if set(page_axes) - set("YXS") or "Y" not in page_axes or "X" not in page_axes:
        raise NativeImageError("A TIFF plane contains unsupported non-spatial page axes.")
    orientation = first_keyframe.tags.get("Orientation")
    orientation_value = int(orientation.value) if orientation is not None else 1
    if orientation_value != 1:
        raise NativeImageError("Native rectangular reads currently require TIFF Orientation 1.")
    photometric = first_keyframe.photometric
    if photometric not in {
        tifffile.PHOTOMETRIC.MINISBLACK,
        tifffile.PHOTOMETRIC.MINISWHITE,
        tifffile.PHOTOMETRIC.RGB,
    }:
        name = getattr(photometric, "name", str(photometric))
        raise NativeImageError(f"Native TIFF reads do not support {name} photometric data.")
    samples = int(mapping.get("S", 1))
    if photometric == tifffile.PHOTOMETRIC.RGB and samples not in {3, 4}:
        raise NativeImageError("An RGB TIFF must declare three or four samples on axis S.")
    if photometric != tifffile.PHOTOMETRIC.RGB and samples != 1:
        raise NativeImageError("Only RGB TIFF data may use a sample axis in native reads.")
    for page in pages:
        assert page is not None
        keyframe = _tiff_keyframe(page)
        if np.dtype(keyframe.dtype) != np.dtype(first_keyframe.dtype) or (
            keyframe.photometric != photometric
        ):
            raise NativeImageError("TIFF plane type or photometric meaning varies within a level.")
    return samples, bool(first_keyframe.is_tiled), getattr(photometric, "name", str(photometric))


def _ome_details(
    tif: tifffile.TiffFile, series_index: int, dimensions: NativeDimensions
) -> tuple[
    tuple[str, ...],
    PhysicalCalibration | None,
    NativeTimeCalibration | None,
    tuple[NativePlanePosition, ...],
    tuple[NativePlaneTime, ...],
    tuple[NativeChannelDisplay, ...],
]:
    names = tuple(f"Channel {index + 1}" for index in range(dimensions.c))
    xml = tif.ome_metadata
    if not xml:
        return (
            names,
            None,
            None,
            (),
            (),
            tuple(NativeChannelDisplay(channel=index) for index in range(dimensions.c)),
        )
    encoded = xml.encode("utf-8", errors="replace")
    if len(encoded) > MAX_OME_XML_BYTES or "<!DOCTYPE" in xml or "<!ENTITY" in xml:
        raise NativeImageError(
            "The OME metadata is too large or contains unsupported declarations."
        )
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise NativeImageError("The TIFF contains malformed OME-XML metadata.") from exc
    images = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "Image"]
    if series_index >= len(images):
        return (
            names,
            None,
            None,
            (),
            (),
            tuple(NativeChannelDisplay(channel=index) for index in range(dimensions.c)),
        )
    pixels = next(
        (child for child in images[series_index] if child.tag.rsplit("}", 1)[-1] == "Pixels"),
        None,
    )
    if pixels is None:
        return (
            names,
            None,
            None,
            (),
            (),
            tuple(NativeChannelDisplay(channel=index) for index in range(dimensions.c)),
        )
    channel_elements = [child for child in pixels if child.tag.rsplit("}", 1)[-1] == "Channel"]
    declared_names = [child.attrib.get("Name", "").strip()[:160] for child in channel_elements]
    if len(declared_names) >= dimensions.c:
        names = tuple(
            declared_names[index] or f"Channel {index + 1}" for index in range(dimensions.c)
        )
    size_present = {axis: f"PhysicalSize{axis}" in pixels.attrib for axis in "XYZ"}
    unit_present = {axis: f"PhysicalSize{axis}Unit" in pixels.attrib for axis in "XYZ"}
    for axis in "XYZ":
        if unit_present[axis] and not size_present[axis]:
            raise NativeImageError(
                f"OME PhysicalSize{axis}Unit is present without PhysicalSize{axis}."
            )
    calibration = None
    if any(size_present.values()):
        if not size_present["X"] or not size_present["Y"]:
            raise NativeImageError("OME physical calibration requires both X and Y spacing.")
        calibration_axes = "ZYX" if size_present["Z"] else "YX"
        declared_units = [
            pixels.attrib.get(f"PhysicalSize{axis}Unit", "µm").strip() for axis in calibration_axes
        ]
        pixel_units = all(unit == "pixel" for unit in declared_units)
        if "pixel" in declared_units and not pixel_units:
            raise NativeImageError("OME pixel spacing cannot be mixed with physical length units.")
        spacing: list[float] = []
        for axis in calibration_axes:
            value = _finite_float(
                pixels.attrib[f"PhysicalSize{axis}"],
                context=f"OME PhysicalSize{axis}",
                positive=True,
            )
            # The OME 2016-06 schema defaults each PhysicalSize unit to µm.
            unit = pixels.attrib.get(f"PhysicalSize{axis}Unit", "µm").strip()
            spacing.append(
                value
                if pixel_units
                else _length_in_micrometres(value, unit, context=f"OME PhysicalSize{axis}")
            )
        if not all(value > 0 for value in spacing):
            raise NativeImageError("OME physical spacing underflows the supported numeric range.")
        calibration = PhysicalCalibration(
            calibration_axes, tuple(spacing), "pixel" if pixel_units else "µm"
        )

    time_increment: float | None = None
    if "TimeIncrementUnit" in pixels.attrib and "TimeIncrement" not in pixels.attrib:
        raise NativeImageError("OME TimeIncrementUnit is present without TimeIncrement.")
    if "TimeIncrement" in pixels.attrib:
        value = _finite_float(
            pixels.attrib["TimeIncrement"],
            context="OME TimeIncrement",
            positive=True,
        )
        unit = pixels.attrib.get("TimeIncrementUnit", "s").strip()
        time_increment = _time_in_seconds(value, unit, context="OME TimeIncrement")
        if time_increment <= 0:
            raise NativeImageError("OME TimeIncrement must remain positive after normalization.")

    seen_planes: set[tuple[int, int, int]] = set()
    delta_by_t: dict[int, list[float]] = {}
    plane_positions: list[NativePlanePosition] = []
    plane_times: list[NativePlaneTime] = []
    # OME SizeC counts samples, whereas the native C axis counts logical
    # channels and S contains RGB(A) components. Preserve the component index
    # separately; a Plane record for green is not a second biological channel.
    ome_size_c = dimensions.c * dimensions.s
    if dimensions.s > 1 and pixels.attrib.get("SizeC") != str(ome_size_c):
        raise NativeImageError("OME SizeC disagrees with the logical channel and sample axes.")
    bounds = {"TheT": dimensions.t, "TheC": ome_size_c, "TheZ": dimensions.z}
    for plane in (child for child in pixels if child.tag.rsplit("}", 1)[-1] == "Plane"):
        indices: dict[str, int] = {}
        for attribute, upper in bounds.items():
            raw = plane.attrib.get(attribute, "").strip()
            if re.fullmatch(r"\+?\d+", raw) is None:
                raise NativeImageError(f"OME Plane {attribute} is not a non-negative integer.")
            index = int(raw)
            if index >= upper:
                raise NativeImageError(
                    f"OME Plane {attribute} index {index} is outside 0..{upper - 1}."
                )
            indices[attribute] = index
        key = (indices["TheT"], indices["TheC"], indices["TheZ"])
        logical_c = key[1] // dimensions.s
        sample_index = key[1] % dimensions.s if dimensions.s > 1 else None
        if key in seen_planes:
            raise NativeImageError("OME Plane indices are duplicated.")
        seen_planes.add(key)

        if "DeltaTUnit" in plane.attrib and "DeltaT" not in plane.attrib:
            raise NativeImageError("OME Plane DeltaTUnit is present without DeltaT.")
        if "DeltaT" in plane.attrib:
            value = _finite_float(plane.attrib["DeltaT"], context="OME Plane DeltaT")
            if value < 0:
                raise NativeImageError("OME Plane DeltaT must be non-negative.")
            unit = plane.attrib.get("DeltaTUnit", "s").strip()
            normalized = _time_in_seconds(value, unit, context="OME Plane DeltaT")
            delta_by_t.setdefault(key[0], []).append(normalized)
            plane_times.append(
                NativePlaneTime(
                    t=key[0],
                    c=logical_c,
                    z=key[2],
                    delta_t=value,
                    delta_t_unit=unit,
                    delta_t_seconds=normalized,
                    sample=sample_index,
                )
            )

        raw_positions: list[float | None] = []
        units: list[str | None] = []
        normalized_positions: list[float | None] = []
        for axis in "XYZ":
            value_name = f"Position{axis}"
            unit_name = f"Position{axis}Unit"
            if unit_name in plane.attrib and value_name not in plane.attrib:
                raise NativeImageError(f"OME Plane {unit_name} is present without {value_name}.")
            if value_name not in plane.attrib:
                raw_positions.append(None)
                units.append(None)
                normalized_positions.append(None)
                continue
            value = _finite_float(plane.attrib[value_name], context=f"OME Plane {value_name}")
            unit = plane.attrib.get(unit_name, "reference frame").strip()
            if unit not in _LENGTH_TO_MICROMETRES and unit not in _NONPHYSICAL_LENGTH_UNITS:
                raise NativeImageError(
                    f"OME Plane {value_name} uses unsupported length unit {unit!r}."
                )
            raw_positions.append(value)
            units.append(unit)
            normalized_positions.append(
                _length_in_micrometres(value, unit, context=f"OME Plane {value_name}")
                if unit in _LENGTH_TO_MICROMETRES
                else None
            )
        if any(value is not None for value in raw_positions):
            plane_positions.append(
                NativePlanePosition(
                    t=key[0],
                    c=logical_c,
                    z=key[2],
                    position_xyz=(raw_positions[0], raw_positions[1], raw_positions[2]),
                    units_xyz=(units[0], units[1], units[2]),
                    position_micrometres_xyz=(
                        normalized_positions[0],
                        normalized_positions[1],
                        normalized_positions[2],
                    ),
                    sample=sample_index,
                )
            )

    timing = None
    if delta_by_t:
        elapsed: tuple[float, ...] = ()
        intervals: tuple[float, ...] = ()
        per_t_is_complete_and_unambiguous = set(delta_by_t) == set(range(dimensions.t)) and all(
            all(
                math.isclose(value, values[0], rel_tol=1e-12, abs_tol=1e-12) for value in values[1:]
            )
            for values in delta_by_t.values()
        )
        if per_t_is_complete_and_unambiguous:
            elapsed = tuple(delta_by_t[index][0] for index in range(dimensions.t))
            intervals = tuple(
                later - earlier for earlier, later in zip(elapsed, elapsed[1:], strict=False)
            )
            if any(value <= 0 for value in intervals):
                raise NativeImageError("OME Plane DeltaT values must increase strictly with T.")
        timing = NativeTimeCalibration(
            source="ome-plane-delta-t",
            elapsed_times=elapsed,
            frame_intervals=intervals,
            uniform_interval=time_increment,
        )
    elif time_increment is not None:
        timing = NativeTimeCalibration(source="ome-time-increment", uniform_interval=time_increment)

    return (
        names,
        calibration,
        timing,
        tuple(plane_positions),
        tuple(plane_times),
        _ome_channel_display(channel_elements, dimensions),
    )


def _resolution_value(value: Any) -> float | None:
    try:
        numerator, denominator = value
        result = float(numerator) / float(denominator)
    except (TypeError, ValueError, ZeroDivisionError, OverflowError):
        try:
            result = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
    return result if math.isfinite(result) and result > 0 else None


def _tiff_tag_calibration(page: tifffile.TiffPage) -> PhysicalCalibration | None:
    x_tag = page.tags.get("XResolution")
    y_tag = page.tags.get("YResolution")
    unit_tag = page.tags.get("ResolutionUnit")
    if x_tag is None or y_tag is None or unit_tag is None:
        return None
    x_ppu = _resolution_value(x_tag.value)
    y_ppu = _resolution_value(y_tag.value)
    unit_value = int(unit_tag.value)
    micrometres = {2: 25_400.0, 3: 10_000.0}.get(unit_value)
    if x_ppu is None or y_ppu is None or micrometres is None:
        return None
    return PhysicalCalibration("YX", (micrometres / y_ppu, micrometres / x_ppu), "µm")


def _inspect_tiff(path: Path, sha256: str, series_index: int) -> NativeImageMetadata:
    try:
        with tifffile.TiffFile(path) as tif:
            if not tif.series:
                raise NativeImageError("The TIFF contains no image series.")
            if series_index >= len(tif.series):
                raise NativeImageError(
                    f"TIFF series {series_index} is outside 0..{len(tif.series) - 1}."
                )
            series = tif.series[series_index]
            source_axes = str(series.axes)
            source_shape = tuple(int(value) for value in series.shape)
            _validate_tiff_axes(source_axes, source_shape)
            dimensions = _canonical_dimensions(source_axes, source_shape)
            dtype = _validate_dtype(series.dtype, context="TIFF series")
            samples, tiled, photometric = _tiff_page_layout(series, tif)
            if samples != dimensions.s:
                raise NativeImageError("The TIFF sample count disagrees with its S axis.")

            (
                names,
                calibration,
                timing,
                plane_positions,
                plane_times,
                acquisition_display,
            ) = _ome_details(tif, series_index, dimensions)
            if calibration is None and dimensions.z == 1:
                page = series.pages[0]
                assert page is not None
                calibration = _tiff_tag_calibration(_tiff_keyframe(page))

            native_levels: list[NativeLevel] = []
            any_tiled = tiled
            for index, level in enumerate(series.levels):
                level_axes = str(level.axes)
                level_shape = tuple(int(value) for value in level.shape)
                _validate_tiff_axes(level_axes, level_shape)
                if level_axes != source_axes:
                    raise NativeImageError("TIFF pyramid axes vary between resolution levels.")
                level_dimensions = _canonical_dimensions(level_axes, level_shape)
                if (level_dimensions.t, level_dimensions.c, level_dimensions.s) != (
                    dimensions.t,
                    dimensions.c,
                    dimensions.s,
                ):
                    raise NativeImageError("TIFF T, C, or sample dimensions vary between levels.")
                _, level_tiled, _ = _tiff_page_layout(level, tif)
                any_tiled = any_tiled or level_tiled
                native_levels.append(
                    NativeLevel(
                        index,
                        level_dimensions,
                        _scaled_calibration(calibration, dimensions, level_dimensions),
                    )
                )
            axes, shape = _canonical_shape(dimensions)
            sample_semantics: Literal["none", "RGB", "RGBA"] = "none"
            if dimensions.s == 3:
                sample_semantics = "RGB"
            elif dimensions.s == 4:
                sample_semantics = "RGBA"
            format_name = "OME-TIFF" if tif.is_ome else "BigTIFF" if tif.is_bigtiff else "TIFF"
            modes = ["tiff-segments"]
            if all(page is not None and page.is_memmappable for page in series.pages):
                modes.insert(0, "tiff-memmap")
            return NativeImageMetadata(
                format=format_name,
                axes=axes,
                shape=shape,
                source_axes=source_axes,
                source_shape=source_shape,
                dimensions=dimensions,
                levels=tuple(native_levels),
                channel_names=names,
                channel_dtypes=tuple(str(dtype) for _ in range(dimensions.c)),
                sample_semantics=sample_semantics,
                physical_calibration=calibration,
                sha256=sha256,
                selected_series=series_index,
                series_count=len(tif.series),
                capabilities=NativeCapabilities(
                    region_read=True,
                    select_t=dimensions.t > 1,
                    select_c=dimensions.c > 1,
                    select_z=dimensions.z > 1,
                    pyramid_levels=len(native_levels) > 1,
                    tiled=any_tiled,
                    read_modes=tuple(modes),
                ),
                timing=timing,
                plane_positions=plane_positions,
                plane_times=plane_times,
                acquisition_display=acquisition_display,
                rgb_color_policy=_rgb_policy_from_profile(
                    _tiff_icc_profile(tif, series_index), sample_semantics
                ),
            )
    except NativeImageError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, tifffile.TiffFileError) as exc:
        raise NativeImageError("Loci could not inspect this TIFF safely.") from exc


def _ordinary_calibration(image: Image.Image) -> PhysicalCalibration | None:
    dpi = image.info.get("dpi")
    if not isinstance(dpi, tuple) or len(dpi) < 2:
        return None
    try:
        x_dpi, y_dpi = float(dpi[0]), float(dpi[1])
    except (TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(value) and value > 0 for value in (x_dpi, y_dpi)):
        return None
    return PhysicalCalibration("YX", (25_400.0 / y_dpi, 25_400.0 / x_dpi), "µm")


def _ordinary_layout(image: Image.Image) -> tuple[np.dtype[Any], int, str]:
    layouts: dict[str, tuple[np.dtype[Any], int, str]] = {
        "1": (np.dtype(np.bool_), 1, "none"),
        "L": (np.dtype(np.uint8), 1, "none"),
        "I": (np.dtype(np.int32), 1, "none"),
        "F": (np.dtype(np.float32), 1, "none"),
        "I;16": (np.dtype(np.uint16), 1, "none"),
        "I;16B": (np.dtype(np.uint16), 1, "none"),
        "I;16L": (np.dtype(np.uint16), 1, "none"),
        "RGB": (np.dtype(np.uint8), 3, "RGB"),
        "RGBA": (np.dtype(np.uint8), 4, "RGBA"),
    }
    layout = layouts.get(image.mode)
    if layout is None:
        raise NativeImageError(
            f"Ordinary {image.format or 'image'} mode {image.mode} has no lossless native layout."
        )
    return layout


def _inspect_ordinary(path: Path, sha256: str) -> NativeImageMetadata:
    try:
        with Image.open(path) as image:
            if int(getattr(image, "n_frames", 1)) != 1:
                raise NativeImageError("Animated or multi-frame ordinary images are unsupported.")
            dtype, samples, semantics = _ordinary_layout(image)
            dimensions = NativeDimensions(1, 1, 1, int(image.height), int(image.width), samples)
            calibration = _ordinary_calibration(image)
            axes, shape = _canonical_shape(dimensions)
            source_axes = "YXS" if samples > 1 else "YX"
            source_shape = (
                (dimensions.y, dimensions.x, samples)
                if samples > 1
                else (
                    dimensions.y,
                    dimensions.x,
                )
            )
            format_name = str(image.format or "ordinary").upper()
            return NativeImageMetadata(
                format=format_name,
                axes=axes,
                shape=shape,
                source_axes=source_axes,
                source_shape=source_shape,
                dimensions=dimensions,
                levels=(NativeLevel(0, dimensions, calibration),),
                channel_names=("Channel 1",),
                channel_dtypes=(str(dtype),),
                sample_semantics=semantics,  # type: ignore[arg-type]
                physical_calibration=calibration,
                sha256=sha256,
                selected_series=0,
                series_count=1,
                capabilities=NativeCapabilities(
                    region_read=True,
                    select_t=False,
                    select_c=False,
                    select_z=False,
                    pyramid_levels=False,
                    tiled=False,
                    read_modes=("ordinary-bounded-decode",),
                ),
                acquisition_display=(NativeChannelDisplay(channel=0),),
                rgb_color_policy=_ordinary_rgb_policy(image, semantics),
            )
    except (OSError, UnidentifiedImageError) as exc:
        raise NativeImageError(
            "The file is not a supported TIFF, IMS, PNG, or JPEG image."
        ) from exc


def _inspect_source(path: Path, *, series: int, sha256: str) -> _Inspection:
    if isinstance(series, bool) or not isinstance(series, int) or series < 0:
        raise NativeImageError("series must be a non-negative integer.")
    if not path.is_file():
        raise NativeImageError("The selected native image is not a regular file.")
    if h5py.is_hdf5(path):
        if series != 0:
            raise NativeImageError("IMS exposes one image series; series must be zero.")
        metadata = _inspect_ims(path, sha256)
        kind: Literal["tiff", "ims", "ordinary"] = "ims"
    else:
        try:
            with tifffile.TiffFile(path):
                is_tiff = True
        except (OSError, tifffile.TiffFileError):
            is_tiff = False
        if is_tiff:
            metadata = _inspect_tiff(path, sha256, series)
            kind = "tiff"
        else:
            if series != 0:
                raise NativeImageError("Ordinary images expose one series; series must be zero.")
            metadata = _inspect_ordinary(path, sha256)
            kind = "ordinary"
    return _Inspection(metadata, kind)


def _inspect_with_fingerprint(
    path: Path, *, series: int, expected: str | None = None
) -> _Inspection:
    before = _checked_fingerprint(path, expected)
    inspected = _inspect_source(path, series=series, sha256=before)
    _verify_unchanged(path, before)
    return inspected


def inspect_native(
    path: str | Path, *, series: int = 0, expected_sha256: str | None = None
) -> NativeImageMetadata:
    """Inspect one native image series without decoding a pixel plane."""

    return _inspect_with_fingerprint(Path(path), series=series, expected=expected_sha256).metadata


def _series_plane_index(axes: str, shape: tuple[int, ...], selection: NativeSelection) -> int:
    mapping = dict(zip(axes, shape, strict=True))
    outer_axes = "".join(axis for axis in axes if axis not in "YXS")
    selected = {"T": selection.t, "C": selection.c, "Z": selection.z}
    indices = tuple(selected[axis] for axis in outer_axes)
    outer_shape = tuple(int(mapping[axis]) for axis in outer_axes)
    return int(np.ravel_multi_index(indices, outer_shape)) if outer_shape else 0


def _tiff_indexer(axes: str, selection: NativeSelection) -> tuple[Any, ...]:
    selected = {"T": selection.t, "C": selection.c, "Z": selection.z}
    indexer: list[Any] = []
    for axis in axes:
        if axis in selected:
            indexer.append(selected[axis])
        elif axis == "Y":
            indexer.append(slice(selection.y, selection.y + selection.height))
        elif axis == "X":
            indexer.append(slice(selection.x, selection.x + selection.width))
        elif axis == "S":
            indexer.append(slice(None))
        else:  # pragma: no cover - inspection rejects this
            raise NativeImageError(f"Unsupported TIFF axis {axis}.")
    return tuple(indexer)


def _canonical_region(array: np.ndarray, remaining_axes: str) -> tuple[np.ndarray, str]:
    target = "YXS" if "S" in remaining_axes else "YX"
    if set(remaining_axes) != set(target) or len(remaining_axes) != len(target):
        raise NativeImageError("The selected plane did not resolve to YX or YXS pixels.")
    permutation = tuple(remaining_axes.index(axis) for axis in target)
    return np.transpose(array, permutation), target


def _read_tiff_memmap(
    path: Path,
    metadata: NativeImageMetadata,
    selection: NativeSelection,
) -> tuple[np.ndarray, str, int]:
    dtype = np.dtype(metadata.channel_dtypes[selection.c])
    output_shape = (selection.height, selection.width)
    if metadata.dimensions.s > 1:
        output_shape = (*output_shape, metadata.dimensions.s)
    output_bytes = _decoded_bytes(output_shape, dtype)
    _require_budget(output_bytes, selection.budget_bytes)
    array = tifffile.memmap(path, series=selection.series, level=selection.level, mode="r")
    selected = np.asarray(array[_tiff_indexer(metadata.source_axes, selection)])
    remaining = "".join(axis for axis in metadata.source_axes if axis not in "TCZ")
    selected, axes = _canonical_region(selected, remaining)
    return selected, f"tiff-memmap:{axes}", output_bytes


def _read_tiff_segments(
    tif: tifffile.TiffFile,
    metadata: NativeImageMetadata,
    selection: NativeSelection,
) -> tuple[np.ndarray, str, int]:
    series = tif.series[selection.series].levels[selection.level]
    page_index = _series_plane_index(metadata.source_axes, tuple(series.shape), selection)
    page = series.pages[page_index]
    if page is None:
        raise NativeImageError("The selected TIFF plane is missing.")
    dtype = _validate_dtype(page.dtype, context="TIFF plane")
    samples = metadata.dimensions.s
    output_shape = (
        (selection.height, selection.width, samples)
        if samples > 1
        else (
            selection.height,
            selection.width,
        )
    )
    output_bytes = _decoded_bytes(output_shape, dtype)
    needed: list[tuple[int, int]] = []
    largest_working = 0
    file_size = int(tif.filehandle.size)
    x0, x1 = selection.x, selection.x + selection.width
    y0, y1 = selection.y, selection.y + selection.height
    for index, (offset, bytecount) in enumerate(
        zip(page.dataoffsets, page.databytecounts, strict=True)
    ):
        offset, bytecount = int(offset), int(bytecount)
        if offset < 0 or bytecount < 0 or offset > file_size or bytecount > file_size - offset:
            raise NativeImageError(
                "A TIFF segment byte range extends outside the selected TIFF file."
            )
        _empty, position, segment_shape = page.decode(None, index)
        separate_sample, _depth, segment_y, segment_x, _contig_sample = position
        _segment_depth, segment_height, segment_width, segment_samples = segment_shape
        if separate_sample >= samples:
            continue
        intersects = (
            segment_x < x1
            and segment_x + segment_width > x0
            and segment_y < y1
            and segment_y + segment_height > y0
        )
        if intersects:
            decoded = _decoded_bytes((segment_height, segment_width, segment_samples), dtype)
            if decoded > MAX_DECODED_SEGMENT_BYTES:
                raise NativeImageError(
                    "A TIFF decoded tile or strip exceeds the 64 MiB segment guard."
                )
            largest_working = max(largest_working, decoded + int(bytecount))
            needed.append((index, int(bytecount)))
    if not needed:
        raise NativeImageError("No TIFF segments cover the requested rectangle.")
    coverage_bytes = math.prod(output_shape)
    estimated_peak = output_bytes + coverage_bytes + largest_working
    _require_budget(estimated_peak, selection.budget_bytes)
    output = np.empty(output_shape, dtype=dtype)
    coverage = np.zeros(output_shape, dtype=np.bool_)
    filehandle = tif.filehandle
    for index, bytecount in needed:
        filehandle.seek(page.dataoffsets[index])
        encoded = filehandle.read(bytecount)
        if len(encoded) != bytecount:
            raise NativeImageError("A TIFF segment ends before its declared byte count.")
        decoded, position, segment_shape = page.decode(encoded, index)
        if decoded is None:
            raise NativeImageError("A required TIFF segment could not be decoded.")
        if decoded.ndim != 4 or decoded.nbytes > MAX_DECODED_SEGMENT_BYTES:
            raise NativeImageError("A TIFF decoder returned an unsafe segment layout.")
        separate_sample, _depth, segment_y, segment_x, _contig_sample = position
        _segment_depth, segment_height, segment_width, segment_samples = segment_shape
        source_y0, source_y1 = max(y0, segment_y), min(y1, segment_y + segment_height)
        source_x0, source_x1 = max(x0, segment_x), min(x1, segment_x + segment_width)
        source = decoded[
            0,
            source_y0 - segment_y : source_y1 - segment_y,
            source_x0 - segment_x : source_x1 - segment_x,
            :,
        ]
        target = (
            slice(source_y0 - y0, source_y1 - y0),
            slice(source_x0 - x0, source_x1 - x0),
        )
        if samples == 1:
            output[target] = source[..., 0]
            coverage[target] = True
        elif segment_samples == samples and separate_sample == 0:
            output[target] = source
            coverage[target] = True
        elif segment_samples == 1:
            output[target + (separate_sample,)] = source[..., 0]
            coverage[target + (separate_sample,)] = True
        else:
            raise NativeImageError("The TIFF segment has an inconsistent sample layout.")
    if not coverage.all():
        raise NativeImageError("TIFF segments do not completely cover the requested rectangle.")
    axes = "YXS" if samples > 1 else "YX"
    return output, f"tiff-segments:{axes}", estimated_peak


def _read_tiff(
    path: Path, metadata: NativeImageMetadata, selection: NativeSelection
) -> tuple[np.ndarray, str, int]:
    try:
        with tifffile.TiffFile(path) as tif:
            series = tif.series[selection.series].levels[selection.level]
            page_index = _series_plane_index(metadata.source_axes, tuple(series.shape), selection)
            page = series.pages[page_index]
            if page is not None and page.is_memmappable:
                try:
                    return _read_tiff_memmap(path, metadata, selection)
                except NativeImageError:
                    raise
                except (OSError, ValueError):
                    pass
            return _read_tiff_segments(tif, metadata, selection)
    except NativeImageError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, tifffile.TiffFileError) as exc:
        raise NativeImageError("Loci could not read this TIFF region safely.") from exc


def _read_ims(
    path: Path, metadata: NativeImageMetadata, selection: NativeSelection
) -> tuple[np.ndarray, str, int]:
    try:
        with h5py.File(path, "r", rdcc_nbytes=0) as root:
            dataset_root = _local_hdf5_child(root, "DataSet")
            assert isinstance(dataset_root, h5py.Group)
            level = _numbered_hdf5_groups(dataset_root, "ResolutionLevel")[selection.level]
            timepoint = _numbered_hdf5_groups(level, "TimePoint")[selection.t]
            channel = _numbered_hdf5_groups(timepoint, "Channel")[selection.c]
            dataset = _ims_dataset(channel)
            output_bytes = _decoded_bytes((selection.height, selection.width), dataset.dtype)
            if dataset.chunks is None:
                estimated_peak = output_bytes * 2
            else:
                chunk_bytes = _decoded_bytes(
                    tuple(int(value) for value in dataset.chunks), dataset.dtype
                )
                estimated_peak = output_bytes + chunk_bytes
            _require_budget(estimated_peak, selection.budget_bytes)
            pixels = np.asarray(
                dataset[
                    selection.z,
                    selection.y : selection.y + selection.height,
                    selection.x : selection.x + selection.width,
                ]
            )
            return pixels, "ims-hyperslab:YX", estimated_peak
    except NativeImageError:
        raise
    except (OSError, IndexError, KeyError, RuntimeError, TypeError, ValueError) as exc:
        raise NativeImageError("Loci could not read this IMS region safely.") from exc


def _read_ordinary(
    path: Path, metadata: NativeImageMetadata, selection: NativeSelection
) -> tuple[np.ndarray, str, int]:
    dtype = np.dtype(metadata.channel_dtypes[0])
    full_shape = (metadata.dimensions.y, metadata.dimensions.x)
    output_shape = (selection.height, selection.width)
    if metadata.dimensions.s > 1:
        full_shape = (*full_shape, metadata.dimensions.s)
        output_shape = (*output_shape, metadata.dimensions.s)
    full_bytes = _decoded_bytes(full_shape, dtype)
    output_bytes = _decoded_bytes(output_shape, dtype)
    estimated_peak = full_bytes + 2 * output_bytes
    _require_budget(estimated_peak, selection.budget_bytes)
    try:
        with Image.open(path) as image:
            pixels = np.asarray(
                image.crop(
                    (
                        selection.x,
                        selection.y,
                        selection.x + selection.width,
                        selection.y + selection.height,
                    )
                )
            )
    except (OSError, UnidentifiedImageError) as exc:
        raise NativeImageError("Loci could not decode this ordinary image safely.") from exc
    mode = "ordinary-bounded-decode:YXS" if pixels.ndim == 3 else "ordinary-bounded-decode:YX"
    return pixels, mode, estimated_peak


def _read_inspected_region(
    source: Path,
    inspected: _Inspection,
    selection: NativeSelection,
    *,
    integrity_mode: Literal["full-sha256", "stat-verified-session"],
) -> NativeRegion:
    metadata = inspected.metadata
    if selection.level >= len(metadata.levels):
        raise NativeImageError(
            f"Pyramid level {selection.level} is outside 0..{len(metadata.levels) - 1}."
        )
    level_dimensions = metadata.levels[selection.level].dimensions
    _validate_selection(selection, level_dimensions)
    if inspected.kind == "tiff":
        pixels, mode, peak = _read_tiff(source, metadata, selection)
    elif inspected.kind == "ims":
        pixels, mode, peak = _read_ims(source, metadata, selection)
    else:
        pixels, mode, peak = _read_ordinary(source, metadata, selection)
    pixels = _freeze_pixels(pixels)
    expected_shape = (selection.height, selection.width)
    axes: Literal["YX", "YXS"] = "YX"
    if metadata.dimensions.s > 1:
        expected_shape = (*expected_shape, metadata.dimensions.s)
        axes = "YXS"
    if pixels.shape != expected_shape:
        raise NativeImageError(
            f"The decoder returned shape {pixels.shape}, expected {expected_shape}."
        )
    return NativeRegion(
        pixels=pixels,
        axes=axes,
        selection=selection,
        sha256=metadata.sha256,
        format=metadata.format,
        native_dtype=str(pixels.dtype),
        read_mode=mode.split(":", 1)[0],
        estimated_peak_bytes=peak,
        integrity_mode=integrity_mode,
    )


def read_native_region(path: str | Path, selection: NativeSelection) -> NativeRegion:
    """Read a region with full SHA-256 checks before inspection and after decoding."""

    source = Path(path)
    inspected = _inspect_with_fingerprint(
        source, series=selection.series, expected=selection.expected_sha256
    )
    try:
        region = _read_inspected_region(source, inspected, selection, integrity_mode="full-sha256")
    except Exception:
        _verify_unchanged(source, inspected.metadata.sha256)
        raise
    _verify_unchanged(source, inspected.metadata.sha256)
    return region


class NativeImageSession:
    """Reuse one inspected source while detecting ordinary edits and replacement.

    Opening a session computes one full SHA-256 and inspects one selected series.
    Each region read then checks the resolved target and its device, inode, size,
    modification time, and change time before and after decoding.  Those stat
    checks are explicitly not a cryptographic rehash.  ``verify_strict`` is the
    full-hash boundary intended for a run or export receipt.
    """

    __slots__ = (
        "_canonical_path",
        "_closed",
        "_identity",
        "_inspection",
        "_path",
    )

    def __init__(
        self,
        path: str | Path,
        *,
        series: int = 0,
        expected_sha256: str | None = None,
    ) -> None:
        # Keep the user-selected link path absolute so a later process cwd
        # change cannot retarget a relative session path accidentally.
        self._path = Path(path).absolute()
        try:
            self._canonical_path = self._path.resolve(strict=True)
        except OSError as exc:
            raise NativeImageError("The selected native image is not accessible.") from exc
        self._closed = False
        self._identity = _file_identity(self._path)
        fingerprint = _checked_fingerprint(self._path, expected_sha256)
        self._inspection = _inspect_source(self._path, series=series, sha256=fingerprint)
        self._validate_identity()

    @property
    def metadata(self) -> NativeImageMetadata:
        """Return path-redacted metadata captured when the session opened."""

        self._ensure_open()
        return self._inspection.metadata

    def _ensure_open(self) -> None:
        if self._closed:
            raise NativeImageError("This native image session is closed.")

    def _validate_identity(self) -> None:
        self._ensure_open()
        try:
            resolved = self._path.resolve(strict=True)
        except OSError as exc:
            raise NativeSourceChangedError("The native source is no longer accessible.") from exc
        if resolved != self._canonical_path:
            raise NativeSourceChangedError(
                "The native source symlink resolves to a different target."
            )
        if _file_identity(self._path) != self._identity:
            raise NativeSourceChangedError(
                "The native source identity or stat metadata changed during the session."
            )

    def validate_source(self) -> None:
        """Verify the open source still has its inspected path and stat identity."""

        self._validate_identity()

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        """Read with stat identity checks while reusing the opening fingerprint."""

        self._ensure_open()
        metadata = self._inspection.metadata
        if selection.series != metadata.selected_series:
            raise NativeImageError(
                "A native session can read only the series selected when it opened."
            )
        if selection.expected_sha256 is not None:
            _validate_expected_sha256(selection.expected_sha256)
            if not hmac.compare_digest(selection.expected_sha256, metadata.sha256):
                raise NativeSourceChangedError(
                    "The selection fingerprint differs from the session fingerprint."
                )
        self._validate_identity()
        try:
            region = _read_inspected_region(
                self._path,
                self._inspection,
                selection,
                integrity_mode="stat-verified-session",
            )
        except Exception:
            self._validate_identity()
            raise
        self._validate_identity()
        return region

    def display_icc(self) -> bytes | None:
        """Return validated private ICC bytes for engine display conversion only."""

        self._validate_identity()
        policy = self.metadata.rgb_color_policy
        if policy is None or policy.transform == "none":
            return None
        try:
            if self._inspection.kind == "ordinary":
                with Image.open(self._path) as image:
                    raw_profile = image.info.get("icc_profile")
            elif self._inspection.kind == "tiff":
                with tifffile.TiffFile(self._path) as tif:
                    raw_profile = _tiff_icc_profile(tif, self.metadata.selected_series)
            else:
                raw_profile = None
        except (OSError, UnidentifiedImageError, tifffile.TiffFileError) as exc:
            self._validate_identity()
            raise NativeImageError(
                "The embedded ICC profile could not be reopened safely."
            ) from exc
        self._validate_identity()
        if not isinstance(raw_profile, bytes) or not raw_profile:
            raise NativeImageError("The inspected embedded ICC profile is no longer available.")
        if len(raw_profile) != policy.source_icc_bytes:
            raise NativeImageError("The embedded ICC profile size changed after inspection.")
        if hashlib.sha256(raw_profile).hexdigest() != policy.source_icc_sha256:
            raise NativeImageError("The embedded ICC profile changed after inspection.")
        return raw_profile

    def geometry(self, selection: dict[str, Any], volume: bool) -> Geometry:
        """Resolve a crop's voxel-center geometry at its selected native level."""

        from .quantitative import Geometry

        self._ensure_open()
        if not isinstance(selection, dict):
            raise NativeImageError("Native geometry selection must be a mapping.")
        if not isinstance(volume, bool):
            raise NativeImageError("volume must be a boolean.")

        indices: dict[str, int] = {}
        for name in ("level", "x", "y", "z"):
            value = selection.get(name, 0)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise NativeImageError(f"{name} must be a non-negative integer.")
            indices[name] = value
        if indices["level"] >= len(self.metadata.levels):
            raise NativeImageError(
                f"Pyramid level {indices['level']} is outside 0..{len(self.metadata.levels) - 1}."
            )
        level = self.metadata.levels[indices["level"]]
        for name in ("x", "y", "z"):
            upper = getattr(level.dimensions, name)
            if indices[name] >= upper:
                raise NativeImageError(f"{name.upper()} index is outside 0..{upper - 1}.")

        calibration = level.calibration
        if calibration is None:
            spacing_xyz = (1.0, 1.0, 1.0)
            origin_xyz = (0.0, 0.0, 0.0)
            unit = "pixel"
            has_z_spacing = volume
        else:
            unit_aliases = {
                "µm": "um",
                "μm": "um",
                "um": "um",
                "micrometer": "um",
                "micrometers": "um",
                "nm": "nm",
                "mm": "mm",
                "m": "m",
                "pixel": "pixel",
            }
            unit = unit_aliases.get(calibration.unit)
            if unit is None:
                raise NativeImageError(
                    f"Native geometry uses unsupported calibration unit {calibration.unit!r}."
                )
            spacing_by_axis = dict(zip(calibration.axes, calibration.spacing, strict=True))
            if "X" not in spacing_by_axis or "Y" not in spacing_by_axis:
                raise NativeImageError("Native geometry requires complete X and Y calibration.")
            if volume and "Z" not in spacing_by_axis:
                raise NativeImageError(
                    "Volume geometry requires declared Z spacing in the same physical unit."
                )
            spacing_xyz = (
                spacing_by_axis["X"],
                spacing_by_axis["Y"],
                spacing_by_axis.get("Z", 1.0),
            )
            origin_xyz = level.origin_xyz or (0.0, 0.0, 0.0)
            has_z_spacing = "Z" in spacing_by_axis

        affine = np.eye(4, dtype=np.float64)
        axes_to_resolve = ((0, "x"), (1, "y"))
        if has_z_spacing:
            axes_to_resolve = (*axes_to_resolve, (2, "z"))
        for xyz, axis in axes_to_resolve:
            affine[xyz, xyz] = spacing_xyz[xyz]
            affine[xyz, 3] = origin_xyz[xyz] + spacing_xyz[xyz] * indices[axis]
        return Geometry(
            "ZYX" if volume else "YX",
            tuple(tuple(float(value) for value in row) for row in affine),
            unit,
        )

    def verify_strict(self) -> NativeIntegrityReceipt:
        """Rehash the source and confirm it still matches the opening SHA-256."""

        self._validate_identity()
        fingerprint = _sha256(self._path)
        self._validate_identity()
        if not hmac.compare_digest(fingerprint, self._inspection.metadata.sha256):
            raise NativeSourceChangedError(
                "The native source bytes differ from the session's full SHA-256."
            )
        return NativeIntegrityReceipt(fingerprint, "full-sha256")

    def close(self) -> None:
        """Invalidate this engine-only source session."""

        self._closed = True

    def __enter__(self) -> NativeImageSession:
        self._ensure_open()
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()
