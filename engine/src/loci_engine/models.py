"""Typed value objects shared by the engine entry points."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Literal, TypeAlias

ENGINE_VERSION = "0.1.0"

ImageMode = Literal["auto", "brightfield", "fluorescence"]
Polarity = Literal["auto", "dark", "bright"]
CellposeDevice = Literal["auto", "cpu", "mps", "cuda"]
ViewerExportFormat = Literal["png", "tiff"]
SourceColorModel = Literal["intensity", "interleaved-rgb", "channel-composite"]
SourceAccessMode = Literal["full", "overview"]


@dataclass(frozen=True, slots=True)
class ViewerDisplaySettings:
    """Non-destructive controls for rendering a source image for export."""

    black_point: float = 0.0
    white_point: float = 1.0
    brightness: float = 0.0
    contrast: float = 100.0
    gamma: float = 1.0
    saturation: float = 100.0
    red: bool = True
    green: bool = True
    blue: bool = True

    def validate(self) -> None:
        numeric_fields = {
            "black_point": self.black_point,
            "white_point": self.white_point,
            "brightness": self.brightness,
            "contrast": self.contrast,
            "gamma": self.gamma,
            "saturation": self.saturation,
        }
        for name, value in numeric_fields.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a finite number")
            if not math.isfinite(float(value)):
                raise ValueError(f"{name} must be a finite number")
        for name, value in {
            "red": self.red,
            "green": self.green,
            "blue": self.blue,
        }.items():
            if not isinstance(value, bool):
                raise TypeError(f"{name} must be a boolean")

        if not 0 <= self.black_point < self.white_point <= 1:
            raise ValueError(
                "black_point and white_point must satisfy 0 <= black_point < white_point <= 1"
            )
        if not -50 <= self.brightness <= 50:
            raise ValueError("brightness must be between -50 and 50")
        if not 0 <= self.contrast <= 200:
            raise ValueError("contrast must be between 0 and 200")
        if not 0.2 <= self.gamma <= 3:
            raise ValueError("gamma must be between 0.2 and 3")
        if not 0 <= self.saturation <= 200:
            raise ValueError("saturation must be between 0 and 200")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class SegmentationSettings:
    """Interpretable controls for the deterministic baseline engine."""

    image_mode: ImageMode = "auto"
    polarity: Polarity = "auto"
    expected_diameter_px: float = 34.0
    min_area_px: int = 80
    sensitivity: float = 0.0
    smoothing_px: float = 1.2
    split_touching: bool = True
    exclude_border: bool = False

    def validate(self) -> None:
        if self.image_mode not in {"auto", "brightfield", "fluorescence"}:
            raise ValueError(f"Unsupported image_mode: {self.image_mode}")
        if self.polarity not in {"auto", "dark", "bright"}:
            raise ValueError(f"Unsupported polarity: {self.polarity}")
        if not 4 <= self.expected_diameter_px <= 1000:
            raise ValueError("expected_diameter_px must be between 4 and 1000")
        if not 1 <= self.min_area_px <= 10_000_000:
            raise ValueError("min_area_px must be between 1 and 10000000")
        if not -1 <= self.sensitivity <= 1:
            raise ValueError("sensitivity must be between -1 and 1")
        if not 0 <= self.smoothing_px <= 20:
            raise ValueError("smoothing_px must be between 0 and 20")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class CellposeSettings:
    """Supported 2D Cellpose-SAM controls for the still-image workspace.

    The names intentionally follow the Cellpose 4.2.1.1 ``CellposeModel.eval``
    API where possible. ``max_edge_px`` is Loci's bounded, downsample-only
    preprocessing control; labels are mapped back to the source-resolution
    grid before review and export.
    """

    max_edge_px: int = 1000
    diameter_px: float = 0.0
    flow_threshold: float = 0.4
    cellprob_threshold: float = 0.0
    min_size_px: int = 15
    max_size_fraction: float = 0.4
    niter: int = 250
    batch_size: int = 8
    resample: bool = True
    augment: bool = False
    tile_overlap: float = 0.1
    normalize: bool = True
    percentile_low: float = 1.0
    percentile_high: float = 99.0
    tile_norm_blocksize: int = 0
    sharpen_radius: float = 0.0
    smooth_radius: float = 0.0
    invert: bool = False
    device: CellposeDevice = "auto"

    def validate(self) -> None:
        integer_fields = {
            "max_edge_px": self.max_edge_px,
            "min_size_px": self.min_size_px,
            "niter": self.niter,
            "batch_size": self.batch_size,
            "tile_norm_blocksize": self.tile_norm_blocksize,
        }
        for name, value in integer_fields.items():
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an integer")

        numeric_fields = {
            "diameter_px": self.diameter_px,
            "flow_threshold": self.flow_threshold,
            "cellprob_threshold": self.cellprob_threshold,
            "max_size_fraction": self.max_size_fraction,
            "tile_overlap": self.tile_overlap,
            "percentile_low": self.percentile_low,
            "percentile_high": self.percentile_high,
            "sharpen_radius": self.sharpen_radius,
            "smooth_radius": self.smooth_radius,
        }
        for name, value in numeric_fields.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a finite number")
            if not math.isfinite(float(value)):
                raise ValueError(f"{name} must be a finite number")

        boolean_fields = {
            "resample": self.resample,
            "augment": self.augment,
            "normalize": self.normalize,
            "invert": self.invert,
        }
        for name, value in boolean_fields.items():
            if not isinstance(value, bool):
                raise TypeError(f"{name} must be a boolean")

        if not 64 <= self.max_edge_px <= 10_000:
            raise ValueError("max_edge_px must be between 64 and 10000")
        if not 0 <= self.diameter_px <= 10_000:
            raise ValueError("diameter_px must be between 0 and 10000; use 0 for automatic")
        if not 0 <= self.flow_threshold <= 3:
            raise ValueError("flow_threshold must be between 0 and 3")
        if not -10 <= self.cellprob_threshold <= 10:
            raise ValueError("cellprob_threshold must be between -10 and 10")
        if not 0 <= self.min_size_px <= 10_000_000:
            raise ValueError("min_size_px must be between 0 and 10000000")
        if not 0 < self.max_size_fraction <= 1:
            raise ValueError("max_size_fraction must be greater than 0 and at most 1")
        if not 1 <= self.niter <= 10_000:
            raise ValueError("niter must be between 1 and 10000")
        if not 1 <= self.batch_size <= 256:
            raise ValueError("batch_size must be between 1 and 256")
        if not 0.05 <= self.tile_overlap <= 0.5:
            raise ValueError("tile_overlap must be between 0.05 and 0.5")
        if not 0 <= self.percentile_low < self.percentile_high <= 100:
            raise ValueError(
                "percentile_low and percentile_high must satisfy 0 <= low < high <= 100"
            )
        if not 0 <= self.tile_norm_blocksize <= 10_000:
            raise ValueError("tile_norm_blocksize must be between 0 and 10000")
        if not 0 <= self.sharpen_radius <= 10_000:
            raise ValueError("sharpen_radius must be between 0 and 10000")
        if not 0 <= self.smooth_radius <= 10_000:
            raise ValueError("smooth_radius must be between 0 and 10000")
        if self.device not in {"auto", "cpu", "mps", "cuda"}:
            raise ValueError(f"Unsupported device: {self.device}")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


AnalysisSettings: TypeAlias = SegmentationSettings | CellposeSettings


@dataclass(frozen=True, slots=True)
class SourceVolumeMetadata:
    """Declared source-volume geometry and the plane chosen for a bounded view."""

    width: int
    height: int
    depth: int
    channels: int
    timepoints: int
    resolution_levels: int
    selected_resolution_level: int
    selected_level_width: int
    selected_level_height: int
    selected_level_depth: int
    selected_timepoint: int
    selected_z: int
    sampling_stride: int
    channel_names: tuple[str, ...]
    channel_dtypes: tuple[str, ...]
    channel_color_sources: tuple[str, ...]
    channel_range_sources: tuple[str, ...]
    composite_mode: str
    rendered_dtype: str
    physical_extents: tuple[tuple[float, float], ...] | None = None
    voxel_size: tuple[float, float, float] | None = None
    physical_unit: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {"kind": "ims-volume", **asdict(self)}


@dataclass(frozen=True, slots=True)
class SourceMetadata:
    path: str
    name: str
    width: int
    height: int
    channels: int
    dtype: str
    format: str
    page_count: int
    sha256: str
    color_model: SourceColorModel = "intensity"
    access_mode: SourceAccessMode = "full"
    view_only_reason: str | None = None
    source_details: dict[str, object] | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)
