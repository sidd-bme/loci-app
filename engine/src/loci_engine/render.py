"""Preview and overlay rendering for the desktop client."""

from __future__ import annotations

import base64
import io

import cv2
import numpy as np
from PIL import Image
from skimage import color, segmentation, transform

DISPLAY_NORMALIZATION_MAX_SAMPLES = 262_144
DISPLAY_NORMALIZATION_BUFFER_VALUES = 262_144
DISPLAY_NORMALIZATION_SCRATCH_BYTES = (
    DISPLAY_NORMALIZATION_BUFFER_VALUES * np.dtype(np.float64).itemsize * 2
)
_DISPLAY_SAMPLE_SEED = 0x4C4F4349


def _bounded_display_sample(
    image: np.ndarray,
    *,
    max_samples: int = DISPLAY_NORMALIZATION_MAX_SAMPLES,
) -> np.ndarray:
    """Return deterministic source pixels without materializing a full flattened copy."""

    source = np.asarray(image)
    if source.ndim == 2:
        channels = 1
    elif source.ndim == 3 and source.shape[-1] in {1, 3, 4}:
        channels = int(source.shape[-1])
    else:
        raise ValueError("A display sample requires a 2D grayscale, RGB, or RGBA image")
    if max_samples < 1:
        raise ValueError("max_samples must be positive")

    height, width = source.shape[:2]
    pixel_count = int(height) * int(width)
    sample_count = min(pixel_count, max_samples)
    if sample_count < 1:
        raise ValueError("A display sample requires at least one source pixel")
    if sample_count == pixel_count:
        linear_indices = np.arange(pixel_count, dtype=np.intp)
    else:
        # One fixed-seed sample from every equal-width stratum avoids the severe
        # phase aliasing of a flattened arithmetic stride while staying bounded,
        # deterministic, and spatially distributed across the complete source.
        edges = np.linspace(0, pixel_count, num=sample_count + 1, dtype=np.intp)
        widths = np.diff(edges)
        generator = np.random.Generator(np.random.PCG64(_DISPLAY_SAMPLE_SEED))
        offsets = np.asarray(generator.random(sample_count) * widths, dtype=np.intp)
        linear_indices = edges[:-1] + offsets
    rows, columns = np.divmod(linear_indices, width)
    if source.ndim == 2:
        return source[rows, columns]
    if channels == 1:
        return source[rows, columns, 0]
    # Alpha does not participate in the visible RGB normalization basis.
    return source[rows, columns, :3]


def _display_bounds(image: np.ndarray) -> tuple[float, float]:
    """Return one bounded, deterministic source-DN normalization interval."""

    array = np.asarray(image)
    if array.dtype == np.uint8:
        return 0.0, 255.0
    if np.issubdtype(array.dtype, np.bool_):
        return 0.0, 1.0
    if (
        np.issubdtype(array.dtype, np.unsignedinteger)
        and array.ndim == 3
        and array.shape[-1] in {3, 4}
    ):
        return 0.0, float(np.iinfo(array.dtype).max)

    sampled = _bounded_display_sample(array)
    finite = np.isfinite(sampled)
    if not finite.any():
        return 0.0, 1.0
    # Bounds are reported back in source DN units. Keep the bounded sample in
    # float64 so signed, uint32, and float64 metadata are not needlessly rounded
    # merely because the eventual preview raster is float32/8-bit.
    finite_values = np.asarray(sampled[finite], dtype=np.float64)
    if np.issubdtype(array.dtype, np.floating):
        minimum = float(finite_values.min())
        maximum = float(finite_values.max())
        if minimum >= 0.0 and maximum <= 1.0:
            return 0.0, 1.0

    with np.errstate(over="ignore", invalid="ignore"):
        low, high = (float(value) for value in np.percentile(finite_values, (1.0, 99.0)))
    if not (np.isfinite(low) and np.isfinite(high)):
        low, high = float(finite_values.min()), float(finite_values.max())
    if high <= low:
        low, high = float(finite_values.min()), float(finite_values.max())
    if high <= low:
        if np.issubdtype(array.dtype, np.unsignedinteger):
            return 0.0, float(np.iinfo(array.dtype).max)
        return 0.0, 1.0
    return low, high


def _display_float(
    values: np.ndarray,
    *,
    display_bounds: tuple[float, float] | None = None,
) -> np.ndarray:
    """Map source intensities to display space without changing channel balance."""

    array = np.asarray(values)
    raw_low, raw_high = display_bounds if display_bounds is not None else _display_bounds(array)
    low, high = float(raw_low), float(raw_high)
    display = np.empty(array.shape, dtype=np.float32)
    span = high - low
    use_half_scale = not np.isfinite(span)
    if use_half_scale:
        half_low = low / 2.0
        half_span = (high / 2.0) - (low / 2.0)

    # Subtract the source-DN offset in float64 before the final float32 cast.
    # Casting a large-offset floating or supported integer plane first can erase
    # meaningful differences. nditer keeps both conversion buffers bounded for full-view
    # export rather than allocating a second full-resolution float64 raster.
    iterator = np.nditer(
        [array, display],
        flags=["external_loop", "buffered", "zerosize_ok"],
        op_flags=[["readonly"], ["writeonly"]],
        op_dtypes=[np.float64, np.float32],
        casting="unsafe",
        buffersize=DISPLAY_NORMALIZATION_BUFFER_VALUES,
    )
    for source_chunk, destination_chunk in iterator:
        normalized = np.array(source_chunk, dtype=np.float64, copy=True)
        # Invalid samples have no trustworthy intensity, so map them
        # deterministically to the nearest display endpoint.
        np.nan_to_num(normalized, copy=False, nan=low, posinf=high, neginf=low)
        if use_half_scale:
            normalized /= 2.0
            normalized -= half_low
            normalized /= half_span
        else:
            normalized -= low
            normalized /= span
        np.clip(normalized, 0.0, 1.0, out=normalized)
        destination_chunk[...] = normalized
    return display


def render_display_statistics(
    image: np.ndarray,
    *,
    histogram_bins: int = 96,
    max_samples: int = 262_144,
) -> dict[str, object]:
    """Summarize the exact preview display basis without exposing raw source pixels."""

    if histogram_bins < 16 or histogram_bins > 512:
        raise ValueError("histogram_bins must be between 16 and 512")
    if max_samples < histogram_bins:
        raise ValueError("max_samples must be at least histogram_bins")

    source = np.asarray(image)
    display_bounds = _display_bounds(source)
    sampled_source = _bounded_display_sample(source, max_samples=max_samples)
    if source.ndim == 2 or (source.ndim == 3 and source.shape[-1] == 1):
        display = _display_float(sampled_source, display_bounds=display_bounds)
        basis = "intensity"
    elif source.ndim == 3 and source.shape[-1] in {3, 4}:
        rgb = _display_float(sampled_source, display_bounds=display_bounds)
        display = np.einsum(
            "...c,c->...",
            rgb,
            np.array([0.213, 0.715, 0.072], dtype=np.float32),
            optimize=False,
        )
        basis = "luminance"
    else:
        raise ValueError("Display statistics require a 2D grayscale, RGB, or RGBA image")

    sampled = np.asarray(np.ravel(display), dtype=np.float32)
    sampled = sampled[np.isfinite(sampled)]
    if sampled.size == 0:
        sampled = np.zeros(1, dtype=np.float32)
    np.clip(sampled, 0.0, 1.0, out=sampled)
    histogram, _ = np.histogram(sampled, bins=histogram_bins, range=(0.0, 1.0))
    percentile_low, percentile_high = (
        float(value) for value in np.percentile(sampled, (1.0, 99.0))
    )
    if percentile_high - percentile_low < 1.0 / 255.0:
        percentile_low, percentile_high = 0.0, 1.0

    source_values = np.asarray(sampled_source)
    if np.issubdtype(source_values.dtype, np.integer) or np.issubdtype(
        source_values.dtype, np.bool_
    ):
        source_minimum = float(source_values.min())
        source_maximum = float(source_values.max())
    else:
        finite_source = np.isfinite(source_values)
        if finite_source.any():
            source_minimum = float(np.min(source_values, where=finite_source, initial=np.inf))
            source_maximum = float(np.max(source_values, where=finite_source, initial=-np.inf))
        else:
            source_minimum = 0.0
            source_maximum = 0.0
    display_minimum, display_maximum = display_bounds
    return {
        "histogram_bins": [int(value) for value in histogram],
        "percentile_low": percentile_low,
        "percentile_high": percentile_high,
        "basis": basis,
        "sample_count": int(sampled.size),
        "display_minimum": display_minimum,
        "display_maximum": display_maximum,
        "source_minimum": source_minimum,
        "source_maximum": source_maximum,
    }


def _alpha_float(alpha: np.ndarray) -> np.ndarray:
    """Convert alpha through its native range rather than contrast stretching it."""

    array = np.asarray(alpha)
    if np.issubdtype(array.dtype, np.bool_):
        return array.astype(np.float32)
    if np.issubdtype(array.dtype, np.integer):
        info = np.iinfo(array.dtype)
        scale = float(info.max - info.min)
        floating = array.astype(np.float32)
        floating -= float(info.min)
        floating /= scale
        return np.clip(floating, 0.0, 1.0, out=floating)
    floating = np.asarray(array, dtype=np.float32)
    return np.clip(np.where(np.isfinite(floating), floating, 0.0), 0.0, 1.0)


def _preview_pixels(
    image: np.ndarray,
    *,
    max_edge: int | None,
    preserve_alpha: bool,
    display_bounds: tuple[float, float] | None = None,
) -> np.ndarray:
    array = np.asarray(image)
    normalization = display_bounds if display_bounds is not None else _display_bounds(array)
    height, width = array.shape[:2]
    scale = 1.0 if max_edge is None else min(1.0, max_edge / max(height, width))
    if scale < 1:
        target_height = max(1, round(height * scale))
        target_width = max(1, round(width * scale))
        try:
            # Resize native samples before float conversion. This bounds preview
            # working memory for large still images instead of allocating one or
            # more full-resolution float RGB planes merely to show a thumbnail.
            array = cv2.resize(
                array,
                (target_width, target_height),
                interpolation=cv2.INTER_AREA,
            )
        except cv2.error:
            # OpenCV does not accept every scientific integer dtype. Decimate to
            # a bounded view first, then let scikit-image handle the uncommon type.
            # Axes must be reduced independently: a 1 x N uint32 strip otherwise
            # inherits a stride of one from its short axis and remains unbounded.
            row_stride = max(1, (height + target_height - 1) // target_height)
            column_stride = max(1, (width + target_width - 1) // target_width)
            sampled = array[::row_stride, ::column_stride]
            array = transform.resize(
                sampled,
                (target_height, target_width),
                anti_aliasing=True,
                preserve_range=True,
            )
    if array.ndim == 2:
        display = color.gray2rgb(_display_float(array, display_bounds=normalization))
    elif array.ndim == 3 and array.shape[-1] == 1:
        display = color.gray2rgb(_display_float(array[..., 0], display_bounds=normalization))
    elif array.ndim == 3 and array.shape[-1] in {3, 4}:
        display = _display_float(array[..., :3], display_bounds=normalization)
        if preserve_alpha and array.shape[-1] == 4:
            display = np.concatenate(
                (display, _alpha_float(array[..., 3])[..., np.newaxis]),
                axis=-1,
            )
    else:
        raise ValueError("A preview requires a 2D grayscale, RGB, or RGBA image.")

    return np.asarray(np.round(np.clip(display, 0.0, 1.0) * 255), dtype=np.uint8)


def _preview_rgb(image: np.ndarray, max_edge: int | None = 2200) -> np.ndarray:
    return _preview_pixels(image, max_edge=max_edge, preserve_alpha=False)


def png_data_url(rgb_or_gray: np.ndarray) -> str:
    array = np.asarray(rgb_or_gray)
    if array.dtype != np.uint8:
        if np.issubdtype(array.dtype, np.integer) and array.max(initial=0) > 255:
            maximum = int(array.max(initial=1))
            array = np.asarray(np.round(array.astype(np.float64) / maximum * 255), dtype=np.uint8)
        else:
            array = np.asarray(np.round(np.clip(array, 0, 1) * 255), dtype=np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def render_preview(image: np.ndarray, *, max_edge: int = 2200) -> str:
    """Render a bounded, color-preserving PNG without changing the input array."""

    source = np.asarray(image)
    return png_data_url(
        _preview_pixels(
            source,
            max_edge=max_edge,
            preserve_alpha=True,
            display_bounds=_display_bounds(source),
        )
    )


def render_overlay_rgb(
    normalized: np.ndarray,
    labels: np.ndarray,
    *,
    max_edge: int | None = 2200,
) -> np.ndarray:
    """Render a uint8 RGB overlay, optionally retaining full source resolution."""

    preview = _preview_rgb(normalized, max_edge=max_edge)
    if preview.shape[:2] != labels.shape:
        labels = transform.resize(
            labels,
            preview.shape[:2],
            order=0,
            preserve_range=True,
            anti_aliasing=False,
        ).astype(np.int32)
    base = preview.astype(np.float32) / 255.0
    tinted = color.label2rgb(
        labels,
        image=base,
        colors=[(0.08, 0.72, 0.62), (0.23, 0.55, 0.92), (0.96, 0.63, 0.22)],
        alpha=0.26,
        bg_label=0,
    )
    boundaries = segmentation.find_boundaries(labels, mode="outer")
    tinted[boundaries] = np.array([0.16, 0.96, 0.79])
    return np.asarray(np.round(tinted * 255), dtype=np.uint8)


def render_overlay(normalized: np.ndarray, labels: np.ndarray) -> str:
    return png_data_url(render_overlay_rgb(normalized, labels))
