"""Local analysis engine for Loci."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .models import ENGINE_VERSION, CellposeSettings, SegmentationSettings
from .profiles import CELLPOSE_PROFILE_ID, CLASSICAL_PROFILE, SegmentationProfile

if TYPE_CHECKING:
    import numpy as np

    from .segment import SegmentationOutput


def segment_image(image: np.ndarray, settings: SegmentationSettings) -> SegmentationOutput:
    """Load the numerical backend only when an image analysis is requested."""
    from .segment import segment_image as execute_segment

    return execute_segment(image, settings)


__all__ = [
    "CLASSICAL_PROFILE",
    "CELLPOSE_PROFILE_ID",
    "CellposeSettings",
    "ENGINE_VERSION",
    "SegmentationProfile",
    "SegmentationSettings",
    "segment_image",
]
