"""Map OpenSlide's edge coordinates to the shared native task convention."""

from __future__ import annotations

from dataclasses import asdict

import numpy as np

from .native_image import (
    NativeCapabilities,
    NativeDimensions,
    NativeImageMetadata,
    NativeLevel,
    NativeRegion,
    NativeRgbColorPolicy,
    NativeSelection,
    PhysicalCalibration,
)
from .quantitative import Geometry
from .whole_slide import WholeSlideRegion, WholeSlideRegionRequest, WholeSlideSession


class SlideAdapter:
    def __init__(self, path: str, *, expected_sha256: str | None = None):
        self.slide = WholeSlideSession(path, expected_sha256=expected_sha256)
        slide = self.slide.metadata
        levels = []
        for level in slide.levels:
            dimensions = NativeDimensions(
                1, 1, 1, level.dimensions_xy[1], level.dimensions_xy[0], 3
            )
            calibration = None
            if level.micrometres_per_pixel_xy:
                calibration = PhysicalCalibration("YX", level.micrometres_per_pixel_xy[::-1], "um")
            levels.append(NativeLevel(level.index, dimensions, calibration))
        dimensions = levels[0].dimensions
        self.metadata = NativeImageMetadata(
            format=slide.format,
            axes="TCZYXS",
            shape=(1, 1, 1, dimensions.y, dimensions.x, 3),
            source_axes="YXS",
            source_shape=(dimensions.y, dimensions.x, 3),
            dimensions=dimensions,
            levels=tuple(levels),
            channel_names=("Source RGB samples",),
            channel_dtypes=("uint8",),
            sample_semantics="RGB",
            physical_calibration=levels[0].calibration,
            sha256=slide.sha256,
            selected_series=0,
            series_count=1,
            capabilities=NativeCapabilities(
                True, False, False, False, len(levels) > 1, True, ("openslide-region",)
            ),
            rgb_color_policy=NativeRgbColorPolicy(
                source_space="source-device-RGB",
                source_status=slide.icc.source_status,
                source_icc_sha256=slide.icc.source_icc_sha256,
                source_icc_bytes=slide.icc.source_icc_bytes,
                display_space=slide.icc.display_space,
                transform=slide.icc.transform,
                rendering_intent=slide.icc.rendering_intent,
                output_icc_sha256=slide.icc.output_icc_sha256,
            ),
        )

    def public_metadata(self) -> dict:
        return {**asdict(self.metadata), "whole_slide": asdict(self.slide.metadata)}

    def raw_region(self, selection: NativeSelection) -> WholeSlideRegion:
        if selection.t != 0 or selection.c != 0 or selection.z != 0 or selection.series != 0:
            raise ValueError("Whole-slide RGB has no biological channel, Z or time axis")
        if selection.level < 0 or selection.level >= len(self.metadata.levels):
            raise ValueError("Unknown whole-slide pyramid level")
        downsample = self.slide.metadata.levels[selection.level].downsample
        return self.slide.read_region(
            WholeSlideRegionRequest(
                level0_x=round(selection.x * downsample),
                level0_y=round(selection.y * downsample),
                level=selection.level,
                width=selection.width,
                height=selection.height,
                budget_bytes=selection.budget_bytes,
                expected_sha256=selection.expected_sha256,
            )
        )

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        region = self.raw_region(selection)
        return NativeRegion(
            pixels=region.analysis_rgb,
            axes="YXS",
            selection=selection,
            sha256=region.sha256,
            format=self.metadata.format,
            native_dtype="uint8",
            read_mode="openslide-region",
            estimated_peak_bytes=region.estimated_peak_bytes,
            integrity_mode="stat-verified-session",
        )

    def geometry(self, selection: dict, volume: bool = False) -> Geometry:
        if volume:
            raise ValueError("A whole slide cannot be treated as a Z volume")
        level = self.slide.metadata.levels[selection["level"]]
        factor = level.downsample
        mpp = self.slide.metadata.micrometres_per_pixel_xy
        unit = "um" if mpp else "pixel"
        sx, sy = mpp or (1.0, 1.0)
        affine = np.eye(4)
        affine[0, 0], affine[1, 1] = sx * factor, sy * factor
        # OpenSlide region origins are integer level-0 edges. Quantitative
        # Geometry maps the returned sample centres, including half a pixel.
        affine[0, 3] = sx * (round(selection["x"] * factor) + factor / 2)
        affine[1, 3] = sy * (round(selection["y"] * factor) + factor / 2)
        return Geometry("YX", tuple(tuple(v) for v in affine), unit)

    def verify_strict(self):
        return self.slide.verify_strict()

    def validate_source(self) -> None:
        self.slide.validate_source()

    def close(self) -> None:
        self.slide.close()
