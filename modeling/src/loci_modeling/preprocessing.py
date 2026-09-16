"""Immutable spatial and intensity preprocessing contract for native models."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PreprocessingConfig:
    """Release-locked preprocessing shared by training, evaluation, and deployment."""

    channel_conversion: str = "grayscale-luminance"
    intensity_normalization: str = "per-image-percentile-1-99"
    resize_policy: str = "downsample-only"
    max_edge_px: int = 1000
    image_interpolation: str = "bilinear-antialias"
    instance_mask_interpolation: str = "nearest"
    preserve_instance_ids: bool = True
    output_grid: str = "source-resolution"

    def validate(self) -> None:
        expected = {
            "channel_conversion": "grayscale-luminance",
            "intensity_normalization": "per-image-percentile-1-99",
            "resize_policy": "downsample-only",
            "max_edge_px": 1000,
            "image_interpolation": "bilinear-antialias",
            "instance_mask_interpolation": "nearest",
            "preserve_instance_ids": True,
            "output_grid": "source-resolution",
        }
        for field_name, expected_value in expected.items():
            if getattr(self, field_name) != expected_value:
                raise ValueError(
                    f"preprocessing.{field_name} must remain release-locked to {expected_value!r}"
                )


DEFAULT_PREPROCESSING_CONFIG = PreprocessingConfig()
