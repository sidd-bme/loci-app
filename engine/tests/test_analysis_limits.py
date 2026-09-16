from __future__ import annotations

import numpy as np
import pytest

import loci_engine.cellpose_backend as cellpose_backend
from loci_engine.cellpose_backend import segment_cellpose
from loci_engine.models import CellposeSettings, SegmentationSettings
from loci_engine.segment import (
    AnalysisPrecisionError,
    AnalysisResourceError,
    segment_image,
    validate_analysis_budget,
)


def test_classical_analysis_rejects_source_above_pixel_guard_before_conversion() -> None:
    source = np.broadcast_to(np.zeros((1, 1), dtype=np.uint8), (6_000, 6_000))

    with pytest.raises(
        AnalysisResourceError,
        match=r"36,000,000-pixel image.*30,000,000 source pixels.*remains available in View",
    ):
        segment_image(source, SegmentationSettings())


def test_classical_analysis_rejects_estimated_working_memory_below_pixel_guard() -> None:
    source = np.broadcast_to(np.zeros((1, 1), dtype=np.uint8), (4_100, 4_100))

    with pytest.raises(
        AnalysisResourceError,
        match=r"16,810,000-pixel image.*estimated to require.*1024 MiB working memory",
    ):
        validate_analysis_budget(source, "classical")


@pytest.mark.parametrize("dtype", [np.int32, np.uint32, np.float64])
def test_analysis_rejects_source_types_that_can_collapse_in_float32(
    dtype: type[np.generic],
) -> None:
    source = np.array([[0, 1]], dtype=dtype)

    for backend, kwargs in (
        ("classical", {}),
        ("cellpose", {"cellpose_max_edge_px": 1_000}),
    ):
        with pytest.raises(
            AnalysisPrecisionError,
            match=r"float32 working pixels.*remains available in View.*documented, rescaled",
        ):
            validate_analysis_budget(source, backend, **kwargs)


def test_cellpose_analysis_guard_runs_before_model_or_runtime_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = np.broadcast_to(np.zeros((1, 1, 3), dtype=np.uint8), (6_000, 6_000, 3))

    def fail_if_status_checked(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("Cellpose status was checked before the analysis resource guard")

    monkeypatch.setattr(cellpose_backend, "get_cellpose_status", fail_if_status_checked)

    with pytest.raises(
        AnalysisResourceError,
        match=r"Cellpose segmentation.*36,000,000-pixel image.*tiled segmentation",
    ):
        segment_cellpose(source, CellposeSettings())


def test_routine_source_fits_both_analysis_budgets() -> None:
    source = np.broadcast_to(np.zeros((1, 1, 3), dtype=np.uint8), (2_048, 2_048, 3))

    validate_analysis_budget(source, "classical")
    validate_analysis_budget(source, "cellpose", cellpose_max_edge_px=1_000)
