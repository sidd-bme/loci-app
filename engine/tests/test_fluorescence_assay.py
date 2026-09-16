"""Tests for the shared fluorescence assay numerical module."""

from __future__ import annotations

import numpy as np
import pytest

from loci_engine.fluorescence_assay import (
    AssayError,
    compute_field_quantification,
    evaluate_manual_count_points,
    generate_qc_overlay,
    segment_nuclei,
    validate_assay_config,
)


def _fixture(
    *,
    config_extra: dict | None = None,
    focus: np.ndarray | None = None,
    shape: tuple[int, int] = (12, 12),
):
    nuclei = np.zeros(shape, dtype=np.uint16)
    nuclei[3:5, 3:5] = 200
    nuclei[7:9, 7:9] = 200
    signal = np.full(shape, 3, dtype=np.uint16)
    signal[3:5, 3:5] = 12
    signal[7:9, 7:9] = 18
    if focus is None:
        focus = np.ones(shape, dtype=bool)
        focus[:2, :] = False  # 120 pixels in focus
    background = ~focus
    config = {
        "nuclear_threshold": 100,
        "gaussian_sigma_px": 0,
        "min_nucleus_area_px": 2,
        "max_nucleus_area_px": 20,
        "watershed_min_distance_px": 2,
        "signal_channel_label": "declared-signal",
        "endpoint_status": "exploratory",
    }
    if config_extra:
        config.update(config_extra)
    return nuclei, signal, focus, background, validate_assay_config(config)


def test_exact_field_integral_allows_negative_without_clamping():
    nuclei, signal, focus, _, config = _fixture()
    result = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=None,
        background_value=5.0,
        config=config,
    )
    summary = result["summary"]
    # Known fixture truth: 120 focus pixels, raw sum 456, corrected sum -144, ratio -72.
    assert int(summary["focus_pixels"]) == 120
    assert float(summary["raw_signal_sum_adu"]) == 456.0
    assert float(summary["integrated_signal_minus_background_adu"]) == -144.0
    assert float(summary["field_ratio_integrated_signal_per_accepted_nucleus_adu"]) == -72.0
    assert summary["accepted_nuclei_count"] == 2
    assert summary["reviewed_nuclei_count"] == 2
    assert summary["count_mode"] == "algorithmic"


def test_background_mask_mode():
    nuclei, signal, focus, background, config = _fixture()
    signal[background] = 4
    result = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=background,
        background_value=None,
        config=config,
    )
    summary = result["summary"]
    assert float(summary["background_value_adu"]) == 4.0
    # 456 - 120 * 4 = -24
    assert float(summary["integrated_signal_minus_background_adu"]) == -24.0


def test_background_overlap_rejected():
    nuclei, signal, focus, background, config = _fixture()
    background[5, 5] = True  # overlaps focus
    with pytest.raises(AssayError, match="disjoint"):
        compute_field_quantification(
            nuclei,
            signal,
            focus,
            background_mask=background,
            background_value=None,
            config=config,
        )


def test_empty_background_mask_rejected():
    nuclei, signal, focus, _, config = _fixture()
    empty_bg = np.zeros(focus.shape, dtype=bool)
    with pytest.raises(AssayError, match="at least one pixel"):
        compute_field_quantification(
            nuclei,
            signal,
            focus,
            background_mask=empty_bg,
            background_value=None,
            config=config,
        )


def test_zero_nuclei_undefined_ratio():
    nuclei, signal, focus, _, config = _fixture()
    nuclei.fill(0)  # no nuclei above threshold
    result = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=None,
        background_value=1.0,
        config=config,
    )
    assert result["summary"]["accepted_nuclei_count"] == 0
    assert result["summary"]["field_ratio_integrated_signal_per_accepted_nucleus_adu"] == ""
    assert any("undefined" in w for w in result["warnings"])

    # In reviewed mode, zero nuclei must raise AssayError
    reviewed_config = dict(config)
    reviewed_config["endpoint_status"] = "reviewed"
    for key in (
        "channel_identity_confirmed",
        "acquisition_comparable",
        "focus_reviewed",
        "nuclei_reviewed",
        "background_reviewed",
    ):
        reviewed_config[key] = True
    reviewed_config = validate_assay_config(reviewed_config)

    with pytest.raises(AssayError, match="undefined field ratio"):
        compute_field_quantification(
            nuclei,
            signal,
            focus,
            background_mask=None,
            background_value=1.0,
            config=reviewed_config,
        )


def test_saturation_detection_and_review_gate():
    nuclei, signal, focus, _, config = _fixture()
    signal[3, 3] = 65535  # uint16 ceiling
    result = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=None,
        background_value=1.0,
        config=config,
    )
    assert result["summary"]["signal_saturated_pixels"] == 1
    assert any("Saturated" in w for w in result["warnings"])

    # In reviewed mode without saturation_reviewed, must fail
    reviewed_config = dict(config)
    reviewed_config["endpoint_status"] = "reviewed"
    for key in (
        "channel_identity_confirmed",
        "acquisition_comparable",
        "focus_reviewed",
        "nuclei_reviewed",
        "background_reviewed",
    ):
        reviewed_config[key] = True
    reviewed_config["saturation_reviewed"] = False
    reviewed_config = validate_assay_config(reviewed_config)

    with pytest.raises(AssayError, match="saturation_reviewed"):
        compute_field_quantification(
            nuclei,
            signal,
            focus,
            background_mask=None,
            background_value=1.0,
            config=reviewed_config,
        )

    # With saturation_reviewed=True, it succeeds in reviewed mode
    reviewed_config["saturation_reviewed"] = True
    res_sat = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=None,
        background_value=1.0,
        config=reviewed_config,
    )
    assert res_sat["summary"]["signal_saturated_pixels"] == 1


def test_manual_count_points_integration():
    nuclei, signal, focus, _, config = _fixture()
    # Provide manual points: 2 inside focus (rows >= 2), 1 outside focus (row 0)
    manual_pts = [
        {"x": 4.0, "y": 4.0, "id": "p1"},  # inside
        {"x": 8.0, "y": 8.0, "id": "p2"},  # inside
        {"x": 10.0, "y": 10.0, "id": "p3"},  # inside
        {"x": 1.0, "y": 0.0, "id": "p4"},  # outside focus (row 0)
    ]
    count, pts_data = evaluate_manual_count_points(manual_pts, focus)
    assert count == 3
    assert pts_data[0]["inside_focus"] is True
    assert pts_data[3]["inside_focus"] is False

    result = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=None,
        background_value=5.0,
        config=config,
        manual_points=manual_pts,
    )
    summary = result["summary"]
    assert summary["count_mode"] == "manual_points"
    assert summary["accepted_nuclei_count"] == 2  # algorithmic
    assert summary["reviewed_nuclei_count"] == 3  # manual inside focus
    # Ratio: -144 / 3 = -48
    assert float(summary["field_ratio_integrated_signal_per_accepted_nucleus_adu"]) == -48.0


def test_qc_overlay_generation():
    nuclei, _, focus, _, config = _fixture()
    accepted, _, _, rejected = segment_nuclei(nuclei, focus, config)
    overlay = generate_qc_overlay(nuclei, focus, accepted, rejected)
    assert overlay.size == (12, 12)
    assert overlay.mode == "RGB"


def test_workbench_field_assay_preview_and_run(tmp_path):
    import tifffile

    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    # Create 2-channel 16-bit image
    shape = (2, 24, 24)
    data = np.zeros(shape, dtype=np.uint16)
    # Channel 0: Nuclei (two nuclei at 200)
    data[0, 4:8, 4:8] = 200
    data[0, 14:18, 14:18] = 200
    # Channel 1: Signal
    data[1, :, :] = 5
    data[1, 4:8, 4:8] = 50
    data[1, 14:18, 14:18] = 80

    path = tmp_path / "field.tif"
    tifffile.imwrite(path, data, metadata={"axes": "CYX"})

    study_dir = tmp_path / "study.loci-study"
    workbench = Workbench(ResearchProject.create(study_dir, "FieldAssayStudy"))
    source = workbench.import_native(str(path))

    # 1. Preview
    preview = workbench.execute(
        "field_assay_preview",
        {
            "source_id": source["id"],
            "nuclei_channel": 0,
            "signal_channel": 1,
            "focus_all": True,
            "background_value": 5.0,
            "segmentation_method": "manual",
            "threshold_manual": 100,
        },
    )
    assert preview["preview"] is True
    assert preview["overlay"].startswith("data:image/png;base64,")
    summary = preview["summary"]
    assert summary["focus_pixels"] == 576  # 24 * 24
    assert summary["accepted_nuclei_count"] == 2
    assert summary["reviewed_nuclei_count"] == 2
    assert summary["background_value_adu"] == 5.0
    assert summary["count_mode"] == "algorithmic"

    # 2. Run / Adopt
    run_res = workbench.execute(
        "field_assay_run",
        {
            "source_id": source["id"],
            "nuclei_channel": 0,
            "signal_channel": 1,
            "focus_all": True,
            "background_value": 5.0,
            "segmentation_method": "manual",
            "threshold_manual": 100,
            "reviewer": "Reviewer A",
            "assay_notes": "Test field assay note",
        },
    )
    assert run_res["adopted"] is True
    result = run_res["result"]
    assert result["kind"] == "field-assay"
    assert result["source_id"] == source["id"]

    # Verify result persistence and full provenance
    results = workbench.project.list_results()
    assert len(results) == 1
    assert results[0]["id"] == result["id"]
    saved_result = workbench.project.result(result["id"])
    assert saved_result["provenance"]["reviewer"] == "Reviewer A"
    assert saved_result["provenance"]["assay_notes"] == "Test field assay note"


def test_field_assay_annotation_pixel_edges_select_exact_pixels(tmp_path):
    import tifffile

    from loci_engine.research_field_assay import _rasterize_annotation_polygon
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    path = tmp_path / "pixel-edges.tif"
    data = np.zeros((2, 24, 24), dtype=np.uint16)
    data[0, :, :] = 200
    data[1] = np.arange(24 * 24, dtype=np.uint16).reshape(24, 24)
    tifffile.imwrite(path, data, metadata={"axes": "CYX"})
    workbench = Workbench(ResearchProject.create(tmp_path / "edges.loci-study", "Edges"))
    source = workbench.import_native(str(path))
    points = [
        {"x": 0.0, "y": 0.0},
        {"x": 2.0, "y": 0.0},
        {"x": 2.0, "y": 2.0},
        {"x": 0.0, "y": 2.0},
    ]
    mask = _rasterize_annotation_polygon(
        {"id": "a" * 32, "kind": "rectangle", "points": points},
        (24, 24),
    )

    assert mask.astype(np.uint8).tolist() == [
        [1, 1, *([0] * 22)],
        [1, 1, *([0] * 22)],
        *[[0] * 24 for _ in range(22)],
    ]
    saved = workbench.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "action": "add",
            "annotation": {
                "kind": "rectangle",
                "points": points,
                "label": "focus",
                "color": "#ffffff",
                "z": 0,
                "t": 0,
            },
        },
    )
    focus_id = saved["annotations"][0]["id"]
    response = workbench.execute(
        "field_assay_preview",
        {
            "source_id": source["id"],
            "nuclei_channel": 0,
            "signal_channel": 1,
            "focus_annotation_id": focus_id,
            "background_value": 1.0,
            "segmentation_method": "manual",
            "threshold_manual": 100,
            "manual_count": 1,
        },
    )
    assert response["summary"]["focus_pixels"] == 4
    assert response["summary"]["raw_signal_sum_adu"] == 50.0
    assert response["summary"]["integrated_signal_minus_background_adu"] == 46.0


def test_field_assay_annotations_are_bound_to_requested_zt_plane(tmp_path):
    import tifffile

    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    path = tmp_path / "planes.tif"
    data = np.zeros((2, 2, 8, 8), dtype=np.uint16)
    data[:, 0, :, :] = 200
    data[:, 1, :, :] = 10
    tifffile.imwrite(path, data, metadata={"axes": "ZCYX"})
    workbench = Workbench(ResearchProject.create(tmp_path / "planes.loci-study", "Planes"))
    source = workbench.import_native(str(path))

    revision = 0
    annotation_ids: dict[str, str] = {}

    def add_annotation(label: str, kind: str, points: list[dict[str, float]], z: int) -> None:
        nonlocal revision
        saved = workbench.execute(
            "annotate_source",
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "expected_revision": revision,
                "action": "add",
                "annotation": {
                    "kind": kind,
                    "points": points,
                    "label": label,
                    "color": "#ffffff",
                    "z": z,
                    "t": 0,
                },
            },
        )
        revision = saved["revision"]
        annotation_ids[label] = saved["annotations"][-1]["id"]

    rectangle = [
        {"x": 0.0, "y": 0.0},
        {"x": 4.0, "y": 0.0},
        {"x": 4.0, "y": 4.0},
        {"x": 0.0, "y": 4.0},
    ]
    background = [
        {"x": 4.0, "y": 4.0},
        {"x": 8.0, "y": 4.0},
        {"x": 8.0, "y": 8.0},
        {"x": 4.0, "y": 8.0},
    ]
    add_annotation("focus-z0", "rectangle", rectangle, 0)
    add_annotation("focus-z1", "rectangle", rectangle, 1)
    add_annotation("background-z0", "rectangle", background, 0)
    add_annotation("background-z1", "rectangle", background, 1)
    add_annotation("count-z0", "point", [{"x": 1.0, "y": 1.0}], 0)
    add_annotation("count-z1", "point", [{"x": 2.0, "y": 2.0}], 1)

    base = {
        "source_id": source["id"],
        "nuclei_channel": 0,
        "signal_channel": 1,
        "z": 1,
        "t": 0,
        "segmentation_method": "manual",
        "threshold_manual": 100,
    }
    with pytest.raises(ValueError, match=r"Focus annotation.*Z 0, T 0.*Z 1, T 0"):
        workbench.execute(
            "field_assay_preview",
            {
                **base,
                "focus_annotation_id": annotation_ids["focus-z0"],
                "background_value": 1.0,
            },
        )
    with pytest.raises(ValueError, match=r"Background annotation.*Z 0, T 0.*Z 1, T 0"):
        workbench.execute(
            "field_assay_preview",
            {
                **base,
                "focus_annotation_id": annotation_ids["focus-z1"],
                "background_annotation_id": annotation_ids["background-z0"],
            },
        )
    with pytest.raises(ValueError, match=r"Manual points annotation.*Z 0, T 0.*Z 1, T 0"):
        workbench.execute(
            "field_assay_preview",
            {
                **base,
                "focus_annotation_id": annotation_ids["focus-z1"],
                "background_annotation_id": annotation_ids["background-z1"],
                "manual_points_annotation_id": annotation_ids["count-z0"],
            },
        )

    response = workbench.execute(
        "field_assay_preview",
        {
            **base,
            "focus_annotation_id": annotation_ids["focus-z1"],
            "background_annotation_id": annotation_ids["background-z1"],
            "manual_points_annotation_id": "all_points",
        },
    )
    assert response["summary"]["count_mode"] == "manual_points"
    assert response["summary"]["reviewed_nuclei_count"] == 1


def test_background_estimator_mean_vs_median():
    nuclei, signal, focus, background, config = _fixture()
    # 24 background pixels: 23 pixels of 2, 1 pixel of 26
    # Median is 2.0; Mean is (23*2 + 26) / 24 = 72 / 24 = 3.0
    signal[background] = 2
    bg_coords = np.argwhere(background)
    signal[bg_coords[0][0], bg_coords[0][1]] = 26

    res_median = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=background,
        background_value=None,
        config={**config, "background_estimator": "median"},
    )
    assert res_median["summary"]["background_value_adu"] == 2.0

    res_mean = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=background,
        background_value=None,
        config={**config, "background_estimator": "mean"},
    )
    assert res_mean["summary"]["background_value_adu"] == 3.0


def test_manual_count_decoupled_from_segmentation_rejections():
    shape = (12, 12)
    nuclei = np.zeros(shape, dtype=np.uint16)
    # Put a nucleus touching the boundary (row 0)
    nuclei[0:2, 4:6] = 200
    signal = np.full(shape, 10, dtype=np.uint16)
    focus = np.ones(shape, dtype=bool)
    focus[10:, :] = False  # 120 pixels in focus
    background = ~focus

    config = {
        "nuclear_threshold": 100,
        "gaussian_sigma_px": 0,
        "min_nucleus_area_px": 2,
        "max_nucleus_area_px": 20,
        "watershed_min_distance_px": 2,
        "signal_channel_label": "declared-signal",
        "endpoint_status": "exploratory",
        "allow_boundary_exclusions": False,
    }

    # In algorithmic mode, boundary rejections with allow_boundary_exclusions=False
    # raises AssayError
    with pytest.raises(AssayError, match="touch the image edge"):
        compute_field_quantification(
            nuclei,
            signal,
            focus,
            background_mask=background,
            background_value=None,
            config=config,
        )

    # In manual_count mode, the manual count is authoritative:
    # It does NOT fail on boundary rejections, and the effective mask is strictly the focus mask.
    res_manual = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=background,
        background_value=None,
        config=config,
        manual_count=7,
    )
    summary = res_manual["summary"]
    assert summary["count_mode"] == "manual_override"
    assert summary["reviewed_nuclei_count"] == 7
    # Effective pixels equals full focus pixels (120), not eroded by boundary rejection
    assert summary["effective_measurement_pixels"] == 120
    assert summary["focus_pixels"] == 120


@pytest.mark.parametrize(
    ("manual_input", "expected_mode"),
    [
        ({"manual_count": 1}, "manual_override"),
        ({"manual_points": [{"id": "reviewed-1", "x": 4.0, "y": 1.0}]}, "manual_points"),
    ],
)
def test_reviewed_manual_count_isolated_from_algorithmic_qc_rejections(
    manual_input, expected_mode
):
    shape = (12, 12)
    nuclei = np.zeros(shape, dtype=np.uint16)
    nuclei[0:2, 4:6] = 200  # Algorithmic candidate touches the image edge.
    focus = np.ones(shape, dtype=bool)
    focus[10:, :] = False
    background = ~focus
    signal = np.ones(shape, dtype=np.uint16)
    signal[focus] = 10
    config = validate_assay_config(
        {
            "nuclear_threshold": 100,
            "gaussian_sigma_px": 0,
            "min_nucleus_area_px": 2,
            "max_nucleus_area_px": 20,
            "watershed_min_distance_px": 2,
            "signal_channel_label": "declared-signal",
            "endpoint_status": "reviewed",
            "allow_boundary_exclusions": False,
            "channel_identity_confirmed": True,
            "acquisition_comparable": True,
            "focus_reviewed": True,
            "nuclei_reviewed": True,
            "background_reviewed": True,
        }
    )

    result = compute_field_quantification(
        nuclei,
        signal,
        focus,
        background_mask=background,
        background_value=None,
        config=config,
        **manual_input,
    )

    summary = result["summary"]
    assert summary["endpoint_status"] == "reviewed"
    assert summary["count_mode"] == expected_mode
    assert summary["reviewed_nuclei_count"] == 1
    assert summary["candidate_nuclei_count"] == 1
    assert summary["accepted_nuclei_count"] == 0
    assert result["nuclei_rows"][0]["qc_status"] == "image_edge_rejected"
    assert result["rejected"].sum() == 4
    assert summary["focus_pixels"] == 120
    assert summary["effective_measurement_pixels"] == 120
    assert summary["raw_signal_sum_adu"] == 1200.0
    assert summary["background_value_adu"] == 1.0
    assert summary["integrated_signal_minus_background_adu"] == 1080.0
    assert summary["field_ratio_integrated_signal_per_accepted_nucleus_adu"] == 1080.0


def test_reviewed_algorithmic_count_still_rejects_bad_segmentation():
    shape = (12, 12)
    nuclei = np.zeros(shape, dtype=np.uint16)
    nuclei[0:2, 4:6] = 200
    focus = np.ones(shape, dtype=bool)
    focus[10:, :] = False
    background = ~focus
    signal = np.full(shape, 10, dtype=np.uint16)
    config = validate_assay_config(
        {
            "nuclear_threshold": 100,
            "gaussian_sigma_px": 0,
            "min_nucleus_area_px": 2,
            "max_nucleus_area_px": 20,
            "watershed_min_distance_px": 2,
            "signal_channel_label": "declared-signal",
            "endpoint_status": "reviewed",
            "allow_boundary_exclusions": True,
            "channel_identity_confirmed": True,
            "acquisition_comparable": True,
            "focus_reviewed": True,
            "nuclei_reviewed": True,
            "background_reviewed": True,
        }
    )

    with pytest.raises(AssayError, match="exploratory-only endpoint labelling"):
        compute_field_quantification(
            nuclei,
            signal,
            focus,
            background_mask=background,
            background_value=None,
            config=config,
        )


def test_reviewed_mode_guards(tmp_path):
    import tifffile

    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    shape = (2, 24, 24)
    data = np.zeros(shape, dtype=np.uint16)
    data[0, 4:8, 4:8] = 200
    data[1, :, :] = 10
    path = tmp_path / "field_reviewed.tif"
    tifffile.imwrite(path, data, metadata={"axes": "CYX"})

    study_dir = tmp_path / "study_rev.loci-study"
    workbench = Workbench(ResearchProject.create(study_dir, "ReviewedGuardsStudy"))
    source = workbench.import_native(str(path))

    # 1. Missing reviewer name in reviewed mode fails
    with pytest.raises(ValueError, match="non-empty reviewer"):
        workbench.execute(
            "field_assay_run",
            {
                "source_id": source["id"],
                "nuclei_channel": 0,
                "signal_channel": 1,
                "focus_all": True,
                "background_value": 5.0,
                "endpoint_status": "reviewed",
                "channel_identity_confirmed": True,
                "acquisition_comparable": True,
                "focus_reviewed": True,
                "nuclei_reviewed": True,
                "background_reviewed": True,
                "reviewer": "",  # Empty reviewer!
            },
        )

    # 2. Otsu in reviewed mode without manual count fails
    with pytest.raises(ValueError, match="fixed calibrated threshold"):
        workbench.execute(
            "field_assay_run",
            {
                "source_id": source["id"],
                "nuclei_channel": 0,
                "signal_channel": 1,
                "focus_all": True,
                "background_value": 5.0,
                "segmentation_method": "otsu",
                "endpoint_status": "reviewed",
                "channel_identity_confirmed": True,
                "acquisition_comparable": True,
                "focus_reviewed": True,
                "nuclei_reviewed": True,
                "background_reviewed": True,
                "reviewer": "Reviewer B",
            },
        )

    # 3. Whole-field (focus_all) in reviewed mode fails
    with pytest.raises(ValueError, match="focus ROI"):
        workbench.execute(
            "field_assay_run",
            {
                "source_id": source["id"],
                "nuclei_channel": 0,
                "signal_channel": 1,
                "focus_all": True,
                "background_value": 5.0,
                "segmentation_method": "manual",
                "threshold_manual": 100,
                "endpoint_status": "reviewed",
                "channel_identity_confirmed": True,
                "acquisition_comparable": True,
                "focus_reviewed": True,
                "nuclei_reviewed": True,
                "background_reviewed": True,
                "reviewer": "Reviewer B",
            },
        )
