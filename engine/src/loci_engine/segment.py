"""Deterministic segmentation baseline used by the first Loci vertical slice."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
from scipy import ndimage as ndi
from skimage import color, exposure, feature, filters, measure, morphology, segmentation

from .models import SegmentationSettings

MAX_ANALYSIS_SOURCE_PIXELS = 30_000_000
MAX_ANALYSIS_WORKING_BYTES = 1024 * 1024 * 1024
_CLASSICAL_WORKING_BYTES_PER_PIXEL = 64
_CELLPOSE_SOURCE_WORKING_BYTES_PER_PIXEL = 32
_CELLPOSE_PREPARED_WORKING_BYTES_PER_PIXEL = 96


class AnalysisResourceError(ValueError):
    """Raised before a 2D segmentation would exceed its separate resource guard."""


class AnalysisPrecisionError(ValueError):
    """Raised when analysis would discard source contrast during float32 conversion."""


def _cellpose_prepared_pixels(height: int, width: int, max_edge_px: int) -> int:
    scale = min(1.0, max_edge_px / max(height, width))
    return max(1, round(height * scale)) * max(1, round(width * scale))


def validate_analysis_budget(
    image: np.ndarray,
    backend: Literal["classical", "cellpose"],
    *,
    cellpose_max_edge_px: int | None = None,
) -> None:
    """Reject unsafe segmentation while leaving the independently guarded viewer usable."""

    source = np.asarray(image)
    if source.ndim not in {2, 3} or source.shape[0] <= 0 or source.shape[1] <= 0:
        raise ValueError("2D analysis requires a non-empty image plane")
    height, width = (int(value) for value in source.shape[:2])
    source_pixels = height * width

    if (
        np.issubdtype(source.dtype, np.integer)
        and not np.issubdtype(source.dtype, np.bool_)
        and source.dtype.itemsize > 2
    ) or (np.issubdtype(source.dtype, np.floating) and source.dtype.itemsize > 4):
        raise AnalysisPrecisionError(
            f"Loci did not start analysis for this {source.dtype} image because the current "
            "segmentation backends use float32 working pixels and may discard a narrow "
            "intensity range at this source offset. The image remains available in View and "
            "rendered View export. Create a documented, rescaled 16-bit integer or 32-bit "
            "floating-point copy before analysis."
        )

    if backend == "classical":
        estimated_bytes = int(source.nbytes) + (source_pixels * _CLASSICAL_WORKING_BYTES_PER_PIXEL)
        backend_name = "LociSeg"
    elif backend == "cellpose":
        if cellpose_max_edge_px is None:
            raise ValueError("Cellpose analysis budgeting requires max_edge_px")
        prepared_pixels = _cellpose_prepared_pixels(height, width, cellpose_max_edge_px)
        estimated_bytes = (
            int(source.nbytes)
            + source_pixels * _CELLPOSE_SOURCE_WORKING_BYTES_PER_PIXEL
            + prepared_pixels * _CELLPOSE_PREPARED_WORKING_BYTES_PER_PIXEL
        )
        backend_name = "Cellpose"
    else:
        raise ValueError(f"Unknown analysis backend: {backend}")

    if source_pixels > MAX_ANALYSIS_SOURCE_PIXELS or estimated_bytes > MAX_ANALYSIS_WORKING_BYTES:
        raise AnalysisResourceError(
            f"Loci did not start {backend_name} segmentation for this "
            f"{source_pixels:,}-pixel image. The analysis is estimated to require "
            f"{estimated_bytes / (1024 * 1024):,.1f} MiB of working memory; Loci's 2D "
            f"analysis guards are {MAX_ANALYSIS_SOURCE_PIXELS:,} source pixels and "
            f"{MAX_ANALYSIS_WORKING_BYTES // (1024 * 1024)} MiB working memory. The image "
            "remains available in View. Crop or downsample a copy before segmentation; "
            "tiled segmentation is not implemented yet."
        )


@dataclass(frozen=True, slots=True)
class SegmentationOutput:
    labels: np.ndarray
    normalized: np.ndarray
    count: int
    confluence_percent: float
    measurements: list[dict[str, float | int]]
    resolved_polarity: str
    threshold: float


def _to_gray_float(image: np.ndarray) -> np.ndarray:
    array = np.asarray(image)
    if array.ndim == 3:
        rgb = array[..., :3]
        array = rgb[..., 0] if rgb.shape[-1] == 1 else color.rgb2gray(rgb)
    array = np.asarray(array, dtype=np.float32)
    finite = np.isfinite(array)
    if not finite.any():
        raise ValueError("The image has no finite intensity values.")
    fill_value = float(np.nanmedian(array[finite]))
    array = np.where(finite, array, fill_value)
    low, high = np.percentile(array, (1.0, 99.0))
    if high <= low:
        low, high = float(array.min()), float(array.max())
    if high <= low:
        raise ValueError("The image contains no usable intensity contrast.")
    normalized = np.asarray(
        exposure.rescale_intensity(array, in_range=(low, high), out_range=(0.0, 1.0)),
        dtype=np.float32,
    )
    # ``rescale_intensity`` performs part of this calculation with the
    # float32 source and part with float64 percentile bounds. At the upper
    # endpoint that can round one ULP above the declared 0..1 output range.
    # The display array is a bounded rendering aid, so enforce its stated
    # invariant at the producer rather than publishing a pack that restoration
    # must later reject.
    np.clip(normalized, 0.0, 1.0, out=normalized)
    return normalized


def _candidate_score(mask: np.ndarray, min_area: int) -> float:
    foreground_fraction = float(mask.mean())
    if foreground_fraction <= 0.0005 or foreground_fraction >= 0.92:
        return -1_000.0
    cleaned = morphology.remove_small_objects(mask, max_size=max(1, min_area // 2 - 1))
    objects = measure.label(cleaned).max()
    fraction_preference = -abs(foreground_fraction - 0.18) * 12
    return float(np.log1p(objects)) + fraction_preference


def _resolve_polarity(
    smoothed: np.ndarray,
    threshold: float,
    settings: SegmentationSettings,
) -> str:
    if settings.polarity != "auto":
        return settings.polarity
    if settings.image_mode == "brightfield":
        return "dark"
    if settings.image_mode == "fluorescence":
        return "bright"
    bright_score = _candidate_score(smoothed > threshold, settings.min_area_px)
    dark_score = _candidate_score(smoothed < threshold, settings.min_area_px)
    return "bright" if bright_score >= dark_score else "dark"


def _threshold_with_sensitivity(base: float, polarity: str, sensitivity: float) -> float:
    # Positive sensitivity admits more foreground for either polarity.
    shift = 0.22 * float(sensitivity)
    return float(np.clip(base - shift if polarity == "bright" else base + shift, 0.01, 0.99))


def _split_instances(mask: np.ndarray, expected_diameter: float) -> np.ndarray:
    distance = ndi.distance_transform_edt(mask)
    min_distance = max(2, int(round(expected_diameter * 0.32)))
    coordinates = feature.peak_local_max(
        distance,
        labels=mask,
        min_distance=min_distance,
        exclude_border=False,
    )
    markers = np.zeros(mask.shape, dtype=np.int32)
    if coordinates.size:
        markers[tuple(coordinates.T)] = np.arange(1, len(coordinates) + 1)
    else:
        markers = measure.label(mask)
    return segmentation.watershed(-distance, markers, mask=mask)


def rebuild_output_from_labels(
    original: SegmentationOutput,
    labels: np.ndarray,
) -> SegmentationOutput:
    """Recalculate all derived values after a full-resolution label correction."""

    candidate = np.asarray(labels)
    if candidate.ndim != 2 or candidate.shape != original.normalized.shape[:2]:
        raise ValueError("Corrected labels must match the source-resolution image grid.")
    if not np.issubdtype(candidate.dtype, np.integer):
        raise TypeError("Corrected labels must use an integer dtype.")
    if np.any(candidate < 0):
        raise ValueError("Corrected labels cannot contain negative instance IDs.")

    sequential, _, _ = segmentation.relabel_sequential(candidate)
    sequential = sequential.astype(np.int32, copy=False)
    measurements: list[dict[str, float | int]] = []
    for region in measure.regionprops(sequential):
        measurements.append(
            {
                "cell_id": int(region.label),
                "area_px": int(region.area),
                "centroid_x_px": round(float(region.centroid[1]), 3),
                "centroid_y_px": round(float(region.centroid[0]), 3),
                "equivalent_diameter_px": round(float(region.equivalent_diameter_area), 3),
                "eccentricity": round(float(region.eccentricity), 5),
            }
        )

    foreground = sequential > 0
    return SegmentationOutput(
        labels=sequential,
        normalized=original.normalized,
        count=len(measurements),
        confluence_percent=round(float(foreground.mean() * 100), 3),
        measurements=measurements,
        resolved_polarity=original.resolved_polarity,
        threshold=original.threshold,
    )


def segment_image(image: np.ndarray, settings: SegmentationSettings) -> SegmentationOutput:
    """Segment one still image using an interpretable morphology/watershed baseline."""

    settings.validate()
    validate_analysis_budget(image, "classical")
    normalized = _to_gray_float(image)
    smoothed = filters.gaussian(normalized, sigma=settings.smoothing_px, preserve_range=True)
    base_threshold = float(filters.threshold_otsu(smoothed))
    polarity = _resolve_polarity(smoothed, base_threshold, settings)
    threshold = _threshold_with_sensitivity(base_threshold, polarity, settings.sensitivity)
    mask = smoothed > threshold if polarity == "bright" else smoothed < threshold

    cleanup_radius = max(1, min(4, int(round(settings.expected_diameter_px / 22))))
    footprint = morphology.disk(cleanup_radius)
    mask = morphology.opening(mask, footprint)
    mask = morphology.closing(mask, footprint)
    mask = ndi.binary_fill_holes(mask)
    mask = morphology.remove_small_objects(mask, max_size=settings.min_area_px - 1)

    if settings.split_touching:
        labels = _split_instances(mask, settings.expected_diameter_px)
    else:
        labels = measure.label(mask)

    # Watershed can create small fragments, so enforce the area floor per instance.
    for region in measure.regionprops(labels):
        if region.area < settings.min_area_px:
            labels[labels == region.label] = 0
    if settings.exclude_border:
        labels = segmentation.clear_border(labels)
    unmeasured = SegmentationOutput(
        labels=np.asarray(labels, dtype=np.int32),
        normalized=normalized,
        count=0,
        confluence_percent=0.0,
        measurements=[],
        resolved_polarity=polarity,
        threshold=round(threshold, 6),
    )
    return rebuild_output_from_labels(unmeasured, unmeasured.labels)
