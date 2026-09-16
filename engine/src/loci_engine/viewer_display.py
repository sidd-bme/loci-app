"""Stable source-display defaults and bounded, non-destructive compositing.

Acquisition display metadata and user display settings are interpretation state,
not source pixels.  This module never derives defaults from the current viewport
crop.  A caller may instead supply an explicitly identified whole-source or
deterministic coarse-level sample and then reuse the resolved settings.
"""

from __future__ import annotations

import hashlib
import io
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np
from PIL import Image, ImageCms

from .native_image import (
    MAX_EMBEDDED_ICC_BYTES,
    NativeChannelDisplay,
    NativeImageMetadata,
    NativeRgbColorPolicy,
    srgb_output_profile_bytes,
)

DisplaySampleBasis = Literal["whole-source", "deterministic-coarse-level"]
MAX_DISPLAY_CHANNELS = 16
MAX_DISPLAY_PIXELS = 2048**2
MAX_DISPLAY_SAMPLE_VALUES = 4 * 1024**2


class ViewerDisplayError(ValueError):
    """Raised when display inputs do not satisfy the bounded display contract."""


@dataclass(frozen=True, slots=True)
class ResolvedChannelDisplay:
    """One complete channel mapping whose origin is explicit for every field."""

    channel: int
    low: float
    high: float
    gamma: float
    color_rgb: tuple[float, float, float]
    opacity: float
    visible: bool
    range_basis: str
    gamma_basis: str
    color_basis: str
    opacity_basis: str
    visibility_basis: str

    @property
    def color_hex(self) -> str:
        components = tuple(round(component * 255) for component in self.color_rgb)
        return "#" + "".join(f"{component:02x}" for component in components)

    def as_view_mapping(self) -> dict[str, object]:
        """Return the existing workbench-shaped mapping without losing provenance."""

        return {
            "channel": self.channel,
            "low": self.low,
            "high": self.high,
            "gamma": self.gamma,
            "color": self.color_hex,
            "opacity": self.opacity,
            "visible": self.visible,
        }


def _validated_acquisition(
    metadata: NativeImageMetadata,
) -> dict[int, NativeChannelDisplay]:
    records: dict[int, NativeChannelDisplay] = {}
    for record in metadata.acquisition_display:
        if (
            isinstance(record.channel, bool)
            or not isinstance(record.channel, int)
            or not 0 <= record.channel < metadata.dimensions.c
        ):
            raise ViewerDisplayError("Acquisition display channel index is outside the source.")
        if record.channel in records:
            raise ViewerDisplayError("Acquisition display channel indices are duplicated.")
        records[record.channel] = record
    return records


def _validate_sample(value: np.ndarray, *, channel: int) -> np.ndarray:
    array = np.asarray(value)
    if array.size == 0 or array.dtype.kind not in "buif":
        raise ViewerDisplayError(
            f"Display sample for channel {channel} must be non-empty and real."
        )
    if array.dtype.kind == "f" and not np.isfinite(array).all():
        raise ViewerDisplayError(
            f"Display sample for channel {channel} contains non-finite values."
        )
    return array


def _dtype_range(dtype_name: str) -> tuple[float, float, str]:
    try:
        dtype = np.dtype(dtype_name)
    except TypeError as exc:
        raise ViewerDisplayError(f"Channel dtype {dtype_name!r} is invalid.") from exc
    if np.issubdtype(dtype, np.bool_):
        return 0.0, 1.0, "native-dtype-range"
    if np.issubdtype(dtype, np.integer):
        limits = np.iinfo(dtype)
        return float(limits.min), float(limits.max), "native-dtype-range"
    if np.issubdtype(dtype, np.floating):
        return 0.0, 1.0, "unit-range-fallback"
    raise ViewerDisplayError(f"Channel dtype {dtype} is not a real display type.")


def _sample_range(
    array: np.ndarray, *, basis: DisplaySampleBasis, dtype_name: str
) -> tuple[float, float, str]:
    low = float(array.min())
    high = float(array.max())
    if math.isfinite(low) and math.isfinite(high) and high > low:
        return low, high, f"{basis}-min-max"
    dtype_low, dtype_high, dtype_basis = _dtype_range(dtype_name)
    if dtype_high > dtype_low and dtype_low <= low <= dtype_high:
        return dtype_low, dtype_high, f"{basis}-constant-{dtype_basis}"
    expanded = math.nextafter(low, math.inf)
    if math.isfinite(expanded) and expanded > low:
        return low, expanded, f"{basis}-constant-nextafter"
    return 0.0, 1.0, "unit-range-fallback"


def _valid_color(value: tuple[float, float, float] | None) -> bool:
    return (
        value is not None
        and len(value) == 3
        and all(
            not isinstance(item, bool) and math.isfinite(item) and 0.0 <= item <= 1.0
            for item in value
        )
    )


def resolve_display_defaults(
    metadata: NativeImageMetadata,
    *,
    auto: bool = False,
    samples: Mapping[int, np.ndarray] | None = None,
    sample_basis: DisplaySampleBasis | None = None,
) -> tuple[ResolvedChannelDisplay, ...]:
    """Resolve stable channel settings from acquisition state or a declared sample.

    ``samples`` must represent a whole source or a deterministic coarse level.
    Current viewport crops are deliberately not an accepted basis.
    """

    if not isinstance(auto, bool):
        raise ViewerDisplayError("Auto display mode must be boolean.")
    if (samples is None) != (sample_basis is None):
        raise ViewerDisplayError(
            "Display samples and their stable basis must be supplied together."
        )
    if sample_basis not in {None, "whole-source", "deterministic-coarse-level"}:
        raise ViewerDisplayError(
            "Display sample basis must be whole-source or deterministic-coarse-level."
        )
    if len(metadata.channel_dtypes) != metadata.dimensions.c:
        raise ViewerDisplayError("Channel dtype count differs from the native C dimension.")
    if not 1 <= metadata.dimensions.c <= MAX_DISPLAY_CHANNELS:
        raise ViewerDisplayError(
            f"Display defaults require 1-{MAX_DISPLAY_CHANNELS} scalar channels."
        )
    sample_map = dict(samples or {})
    for channel in sample_map:
        if (
            isinstance(channel, bool)
            or not isinstance(channel, int)
            or not 0 <= channel < metadata.dimensions.c
        ):
            raise ViewerDisplayError("Display sample channel index is outside the source.")
    if sum(np.asarray(value).size for value in sample_map.values()) > MAX_DISPLAY_SAMPLE_VALUES:
        raise ViewerDisplayError("Display samples exceed the bounded value-count limit.")
    if auto and set(sample_map) != set(range(metadata.dimensions.c)):
        raise ViewerDisplayError("Auto display requires one stable sample for every channel.")
    acquisition = _validated_acquisition(metadata)

    resolved: list[ResolvedChannelDisplay] = []
    for channel, dtype_name in enumerate(metadata.channel_dtypes):
        record = acquisition.get(channel, NativeChannelDisplay(channel=channel))
        if auto:
            sample = _validate_sample(sample_map[channel], channel=channel)
            assert sample_basis is not None
            low, high, range_basis = _sample_range(
                sample, basis=sample_basis, dtype_name=dtype_name
            )
            range_basis = f"auto-{range_basis}"
        elif record.value_range is not None:
            low, high = record.value_range
            if not (math.isfinite(low) and math.isfinite(high) and high > low):
                raise ViewerDisplayError("Validated acquisition display range is inconsistent.")
            range_basis = record.range_basis or "acquisition-display"
        elif channel in sample_map:
            sample = _validate_sample(sample_map[channel], channel=channel)
            assert sample_basis is not None
            low, high, range_basis = _sample_range(
                sample, basis=sample_basis, dtype_name=dtype_name
            )
        else:
            low, high, range_basis = _dtype_range(dtype_name)

        if record.gamma is None:
            gamma, gamma_basis = 1.0, "neutral-gamma-fallback"
        else:
            gamma, gamma_basis = record.gamma, record.gamma_basis or "acquisition-display"
        if not math.isfinite(gamma) or not 0.1 <= gamma <= 10.0:
            raise ViewerDisplayError("Validated acquisition gamma is inconsistent.")

        if record.color_rgb is not None and not _valid_color(record.color_rgb):
            raise ViewerDisplayError("Validated acquisition color is inconsistent.")
        if _valid_color(record.color_rgb):
            assert record.color_rgb is not None
            color_rgb = record.color_rgb
            color_basis = record.color_basis or "acquisition-display"
            has_acquisition_colour = True
        else:
            color_rgb = (1.0, 1.0, 1.0)
            color_basis = "neutral-grayscale-fallback"
            has_acquisition_colour = False

        if record.opacity is None:
            opacity, opacity_basis = 1.0, "opaque-fallback"
        else:
            opacity, opacity_basis = record.opacity, record.opacity_basis or "acquisition-display"
        if not math.isfinite(opacity) or not 0.0 <= opacity <= 1.0:
            raise ViewerDisplayError("Validated acquisition opacity is inconsistent.")

        if record.visible is not None and not isinstance(record.visible, bool):
            raise ViewerDisplayError("Validated acquisition visibility is inconsistent.")
        if record.visible is not None:
            visible = record.visible
            visibility_basis = record.visibility_basis or "acquisition-display"
        elif has_acquisition_colour:
            visible = True
            visibility_basis = "acquisition-colour-present"
        else:
            visible = channel == 0
            visibility_basis = "first-channel-neutral-fallback"

        resolved.append(
            ResolvedChannelDisplay(
                channel=channel,
                low=low,
                high=high,
                gamma=gamma,
                color_rgb=color_rgb,
                opacity=opacity,
                visible=visible,
                range_basis=range_basis,
                gamma_basis=gamma_basis,
                color_basis=color_basis,
                opacity_basis=opacity_basis,
                visibility_basis=visibility_basis,
            )
        )
    return tuple(resolved)


def render_channel_composite(
    channels: Mapping[int, np.ndarray],
    settings: Sequence[ResolvedChannelDisplay],
    *,
    bit_depth: Literal[8, 16] = 8,
) -> np.ndarray:
    """Render separate scalar channels without changing their native values."""

    if bit_depth not in {8, 16}:
        raise ViewerDisplayError("Composite display bit depth must be 8 or 16.")
    if not 1 <= len(settings) <= MAX_DISPLAY_CHANNELS:
        raise ViewerDisplayError(f"A composite requires 1-{MAX_DISPLAY_CHANNELS} channel mappings.")
    seen: set[int] = set()
    shape: tuple[int, int] | None = None
    composite: np.ndarray | None = None
    for display in settings:
        if display.channel in seen:
            raise ViewerDisplayError("Composite channel mappings are duplicated.")
        seen.add(display.channel)
        if display.channel not in channels:
            raise ViewerDisplayError(f"Composite channel {display.channel} has no source array.")
        array = np.asarray(channels[display.channel])
        if array.ndim != 2 or array.dtype.kind not in "buif":
            raise ViewerDisplayError(
                "Composite source channels must be real two-dimensional arrays."
            )
        if array.dtype.kind == "f" and not np.isfinite(array).all():
            raise ViewerDisplayError("Composite source channel contains non-finite values.")
        if array.size > MAX_DISPLAY_PIXELS:
            raise ViewerDisplayError("Composite source channel exceeds the display pixel bound.")
        if shape is None:
            shape = (int(array.shape[0]), int(array.shape[1]))
            composite = np.zeros((*shape, 3), dtype=np.float64)
        elif array.shape != shape:
            raise ViewerDisplayError("Composite source channel shapes differ.")
        if not (
            math.isfinite(display.low)
            and math.isfinite(display.high)
            and display.high > display.low
            and math.isfinite(display.gamma)
            and 0.1 <= display.gamma <= 10.0
            and math.isfinite(display.opacity)
            and 0.0 <= display.opacity <= 1.0
            and _valid_color(display.color_rgb)
        ):
            raise ViewerDisplayError("Composite display mapping is invalid.")
        if not isinstance(display.visible, bool):
            raise ViewerDisplayError("Composite channel visibility must be boolean.")
        if not display.visible or display.opacity == 0:
            continue
        normalized = np.clip(
            (array.astype(np.float64) - display.low) / (display.high - display.low), 0, 1
        )
        np.power(normalized, 1.0 / display.gamma, out=normalized)
        normalized *= display.opacity
        assert composite is not None
        composite += normalized[..., np.newaxis] * np.asarray(display.color_rgb, dtype=np.float64)
    assert composite is not None
    maximum = 255 if bit_depth == 8 else 65_535
    dtype = np.uint8 if bit_depth == 8 else np.uint16
    return np.asarray(np.rint(np.clip(composite, 0, 1) * maximum), dtype=dtype)


def render_source_rgb(
    pixels: np.ndarray,
    policy: NativeRgbColorPolicy,
    *,
    embedded_icc: bytes | None = None,
    already_srgb: bool = False,
) -> np.ndarray:
    """Return one RGB(A) display array, applying a validated ICC transform once."""

    array = np.asarray(pixels)
    if array.ndim != 3 or array.shape[-1] not in {3, 4} or array.dtype != np.uint8:
        raise ViewerDisplayError(
            "Source RGB display requires uint8 YXS pixels with three or four samples."
        )
    if policy.source_space != "source-device-RGB":
        raise ViewerDisplayError(
            "Scalar colour policy cannot render interleaved source RGB pixels."
        )
    if policy.transform == "Pillow-ImageCms-source-to-sRGB":
        if policy.source_status != "embedded-usable" or policy.display_space != "sRGB":
            raise ViewerDisplayError("ICC transform policy is internally inconsistent.")
        if (
            isinstance(policy.rendering_intent, bool)
            or not isinstance(policy.rendering_intent, int)
            or not 0 <= policy.rendering_intent <= 3
        ):
            raise ViewerDisplayError("ICC rendering intent is outside the supported range.")
    if already_srgb:
        if policy.transform != "Pillow-ImageCms-source-to-sRGB":
            raise ViewerDisplayError(
                "already_srgb is valid only for a declared source-to-sRGB policy."
            )
        return np.array(array, copy=True, order="C")
    if policy.transform not in {"none", "Pillow-ImageCms-source-to-sRGB"}:
        raise ViewerDisplayError("Source RGB transform policy is unsupported.")
    if policy.transform == "none":
        if embedded_icc is not None:
            raise ViewerDisplayError(
                "An ICC profile was supplied for a policy that does not apply it."
            )
        return np.array(array, copy=True, order="C")
    if not isinstance(embedded_icc, bytes) or not embedded_icc:
        raise ViewerDisplayError(
            "The validated embedded ICC bytes are required for display conversion."
        )
    if len(embedded_icc) > MAX_EMBEDDED_ICC_BYTES:
        raise ViewerDisplayError("The embedded ICC profile exceeds the display conversion bound.")
    if policy.source_icc_bytes != len(embedded_icc):
        raise ViewerDisplayError("The embedded ICC profile size differs from inspected metadata.")
    if hashlib.sha256(embedded_icc).hexdigest() != policy.source_icc_sha256:
        raise ViewerDisplayError("The embedded ICC profile differs from inspected source metadata.")
    try:
        source_profile = ImageCms.ImageCmsProfile(io.BytesIO(embedded_icc))
        output_bytes = srgb_output_profile_bytes()
        output_profile = ImageCms.ImageCmsProfile(io.BytesIO(output_bytes))
        if (
            policy.output_icc_sha256 is not None
            and hashlib.sha256(output_bytes).hexdigest() != policy.output_icc_sha256
        ):
            raise ViewerDisplayError("The active sRGB output profile differs from inspection.")
        mode = "RGBA" if array.shape[-1] == 4 else "RGB"
        transform = ImageCms.buildTransform(
            source_profile,
            output_profile,
            mode,
            mode,
            policy.rendering_intent,
            0,
        )
        converted = ImageCms.applyTransform(Image.fromarray(array, mode=mode), transform)
    except ViewerDisplayError:
        raise
    except Exception as exc:
        raise ViewerDisplayError("The validated ICC display transform failed.") from exc
    return np.asarray(converted).copy()


def adjust_source_rgb_components(
    pixels: np.ndarray,
    *,
    low: float,
    high: float,
    gamma: float,
) -> np.ndarray:
    """Apply one global stored-RGB window and gamma without changing source pixels.

    The controls have source sample-value units and apply equally to all stored
    RGB components.  They intentionally precede colour management: an embedded
    source profile is still applied exactly once by :func:`render_source_rgb`.
    This helper supports uint8 and uint16 so the same adjustment contract can
    be used by an 8-bit canvas render and a 16-bit rendered export.
    """

    array = np.asarray(pixels)
    if (
        array.ndim != 3
        or array.shape[-1] not in {3, 4}
        or array.dtype
        not in {
            np.dtype(np.uint8),
            np.dtype(np.uint16),
        }
    ):
        raise ViewerDisplayError(
            "Stored RGB adjustment requires uint8 or uint16 YXS pixels with three or four samples."
        )
    if any(isinstance(value, bool) for value in (low, high, gamma)):
        raise ViewerDisplayError("Stored RGB adjustment values must be finite numbers.")
    try:
        resolved_low = float(low)
        resolved_high = float(high)
        resolved_gamma = float(gamma)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ViewerDisplayError("Stored RGB adjustment values must be finite numbers.") from exc
    maximum = float(np.iinfo(array.dtype).max)
    if not (
        math.isfinite(resolved_low)
        and math.isfinite(resolved_high)
        and math.isfinite(resolved_gamma)
        and 0.0 <= resolved_low < resolved_high <= maximum
        and 0.1 <= resolved_gamma <= 10.0
    ):
        raise ViewerDisplayError(
            "Stored RGB adjustment requires 0 <= low < high <= the native dtype maximum "
            "and 0.1 <= gamma <= 10."
        )
    # Preserve exact source component values for the neutral mapping.  This is
    # also important for a source with a read-only backing array.
    if resolved_low == 0.0 and resolved_high == maximum and resolved_gamma == 1.0:
        return np.array(array, copy=True, order="C")
    normalized = (array[..., :3].astype(np.float64) - resolved_low) / (resolved_high - resolved_low)
    np.clip(normalized, 0.0, 1.0, out=normalized)
    np.power(normalized, 1.0 / resolved_gamma, out=normalized)
    output = np.array(array, copy=True, order="C")
    output[..., :3] = np.asarray(np.rint(normalized * maximum), dtype=array.dtype)
    return output


def render_adjusted_source_rgb(
    pixels: np.ndarray,
    policy: NativeRgbColorPolicy,
    *,
    low: float,
    high: float,
    gamma: float,
    embedded_icc: bytes | None = None,
) -> np.ndarray:
    """Adjust stored RGB components, then apply the declared ICC policy once.

    Pillow's ImageCms path is intentionally limited to uint8.  A uint16 caller
    with no ICC transform still receives a precise uint16 adjusted result; a
    caller requiring a uint16 ICC conversion fails rather than silently
    down-quantising or omitting its declared transform.
    """

    if policy.source_space != "source-device-RGB":
        raise ViewerDisplayError(
            "Scalar colour policy cannot render interleaved source RGB pixels."
        )
    if policy.transform not in {"none", "Pillow-ImageCms-source-to-sRGB"}:
        raise ViewerDisplayError("Source RGB transform policy is unsupported.")
    adjusted = adjust_source_rgb_components(pixels, low=low, high=high, gamma=gamma)
    if adjusted.dtype == np.uint16:
        if policy.transform != "none":
            raise ViewerDisplayError(
                "A declared ICC transform cannot be applied to uint16 stored RGB "
                "without changing precision."
            )
        if embedded_icc is not None:
            raise ViewerDisplayError(
                "An ICC profile was supplied for a policy that does not apply it."
            )
        return adjusted
    return render_source_rgb(adjusted, policy, embedded_icc=embedded_icc)
