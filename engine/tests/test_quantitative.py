"""Analytic references fixed before tuning quantitative operations."""

import numpy as np
import pytest

from loci_engine.quantitative import (
    Geometry,
    apply_marker_gates,
    associate_labels,
    colocalisation,
    measure_objects,
    process_scalar,
    segment_scalar,
    validate_array,
)


def test_geometry_oblique_voxel_centers_and_crop():
    affine = ((0, -2, 0, 10), (3, 0, 0, 20), (0, 0, 5, 30), (0, 0, 0, 1))
    geometry = Geometry("ZYX", affine, "mm", "LPS")
    assert geometry.spacing == (5, 2, 3)
    assert geometry.orthogonal_spacing() == (5, 2, 3)
    np.testing.assert_array_equal(geometry.world(np.array([[1, 2, 3]])), [[6, 29, 35]])
    cropped = geometry.cropped((1, 2, 3))
    np.testing.assert_array_equal(cropped.world(np.array([[0, 0, 0]])), [[6, 29, 35]])


@pytest.mark.parametrize("spacing", [(1, 0), (1, float("nan")), (True, 1), (1,)])
def test_invalid_spacing_rejected(spacing):
    with pytest.raises(ValueError):
        Geometry.diagonal(spacing)


def test_shear_rejected_for_euclidean_morphology_but_measure_is_affine_correct():
    geometry = Geometry("ZYX", ((1, 1, 0, 0), (0, 1, 0, 0), (0, 0, 2, 0), (0, 0, 0, 1)))
    with pytest.raises(ValueError, match="orthogonal"):
        process_scalar(np.ones((2, 2, 2)), geometry, [])
    assert measure_objects(np.ones((2, 2, 2), np.uint32), geometry)[0]["measure"] == 16


def test_3d_connected_object_is_not_projected_count():
    image = np.zeros((9, 12, 12), np.uint16)
    image[1:3, 2:5, 2:5] = 100
    image[6:8, 2:5, 2:5] = 200  # same XY footprint, separated in Z
    geometry = Geometry.diagonal((2, 0.5, 0.5), "um")
    labels, record = segment_scalar(image, geometry, {"threshold": 50})
    assert record["count"] == 2
    assert record["dimensions"] == 3
    rows = measure_objects(labels, geometry, {"signal": image})
    assert [row["measure"] for row in rows] == [9.0, 9.0]
    assert [row["intensity"]["signal"]["mean"] for row in rows] == [100, 200]
    assert rows[0]["nearest_centroid_distance"] == 10
    assert rows[0]["centroid_world_xyz"] == [1.5, 1.5, 3.0]
    assert rows[0]["measure_unit"] == "um^3"
    assert not rows[0]["touches_crop_border"]


def test_anisotropic_minimum_size_and_border_exclusion():
    image = np.zeros((10, 10), np.float32)
    image[0:2, 0:2] = 10
    image[5:7, 5:7] = 10
    geometry = Geometry.diagonal((2, 3), "um")
    labels, record = segment_scalar(
        image,
        geometry,
        {
            "threshold": 5,
            "min_size": 24,
            "exclude_border": True,
        },
    )
    assert record["count"] == 1
    assert np.count_nonzero(labels) == 4
    _, too_small = segment_scalar(image, geometry, {"threshold": 5, "min_size": 25})
    assert too_small["count"] == 0


def test_watershed_true_3d_touching_blobs_and_small_seed_fallback():
    zz, yy, xx = np.mgrid[:17, :24, :32]
    a = ((zz - 8) / 3) ** 2 + ((yy - 12) / 6) ** 2 + ((xx - 10) / 6) ** 2 < 1
    b = ((zz - 8) / 3) ** 2 + ((yy - 12) / 6) ** 2 + ((xx - 20) / 6) ** 2 < 1
    image = (a | b).astype(np.uint8)
    image[1, 1, 1] = 1
    geometry = Geometry.diagonal((2, 1, 1), "um")
    labels, record = segment_scalar(
        image,
        geometry,
        {
            "method": "watershed",
            "threshold": 0.5,
            "split_height": 1.5,
        },
    )
    assert record["count"] == 3
    assert np.array_equal(labels > 0, image > 0)
    assert labels.dtype == np.uint32


def test_full_crop_watershed_has_symmetric_exterior_background():
    labels, record = segment_scalar(
        np.ones((5, 5)),
        Geometry.diagonal((1, 1)),
        {
            "method": "watershed",
            "threshold": 0,
            "split_height": 1,
        },
    )
    assert record["count"] == 1
    assert np.all(labels == 1)


def test_large_sparse_labels_preserve_identity_and_exact_volume():
    labels = np.zeros((6, 6), np.uint64)
    labels[1:3, 1:3] = 4_000_000_001
    labels[4, 4] = 65_536
    rows = measure_objects(labels, Geometry.diagonal((2, 3), "um"))
    assert [r["label"] for r in rows] == [65_536, 4_000_000_001]
    assert [r["measure"] for r in rows] == [6, 24]
    assert all(r["measure_kind"] == "area" for r in rows)


def test_processing_does_not_modify_source_or_normalise_scale():
    source = np.full((8, 8), 1200, np.uint16)
    original = source.copy()
    output, records = process_scalar(
        source,
        Geometry.diagonal((1, 1)),
        [
            {"op": "subtract_constant", "value": 100},
            {"op": "gaussian", "sigma": 2},
        ],
    )
    np.testing.assert_array_equal(source, original)
    np.testing.assert_allclose(output, 1100, atol=1e-12, rtol=0)
    assert output.dtype == np.float64
    assert records[1]["sigma_voxels"] == (2, 2)
    assert records[0]["clip_negative"] is False


def test_flatfield_formula_matches_reference_and_denominator_rejection():
    flat = np.tile(np.arange(1, 6), (4, 1)).astype(np.float64) * 10 + 3
    image = (flat - 3) * 4 + 3
    result, records = process_scalar(
        image,
        Geometry.diagonal((1, 1)),
        [{"op": "flatfield"}],
        flatfield=flat,
        darkfield=np.full_like(flat, 3),
    )
    np.testing.assert_allclose(result, 120, atol=1e-12, rtol=0)
    assert records[0]["scale"] == 30
    with pytest.raises(ValueError, match="positive"):
        process_scalar(
            image, Geometry.diagonal((1, 1)), [{"op": "flatfield"}], flatfield=flat, darkfield=flat
        )


def test_background_is_explicit_signed_derived_data_and_morphology_is_physical():
    image = np.full((9, 9), 20, np.float32)
    image[4, 4] = 100
    output, _ = process_scalar(
        image,
        Geometry.diagonal((2, 1), "um"),
        [
            {"op": "subtract_background", "sigma": 2},
        ],
    )
    assert output[4, 4] > 0
    assert output[4, 3] < 0
    output, record = process_scalar(
        image,
        Geometry.diagonal((2, 1), "um"),
        [
            {"op": "opening", "radius": 1.5},
        ],
    )
    np.testing.assert_array_equal(output, 20)
    assert record[0]["unit"] == "um"


@pytest.mark.parametrize(
    "array",
    [
        np.array([[float("nan")]]),
        np.array([[float("inf")]]),
        np.array([[2**53 + 2]], dtype=np.uint64),
        np.array([[1 + 2j]]),
    ],
)
def test_unsafe_intensity_or_precision_rejected(array):
    with pytest.raises(ValueError):
        validate_array(array)


def test_memory_guard_and_label_type_rejected_before_analysis():
    with pytest.raises(ValueError, match="budget"):
        validate_array(np.zeros((10, 10)), working_bytes=1024)
    with pytest.raises(ValueError, match="non-negative integers"):
        measure_objects(np.ones((2, 2), np.float32), Geometry.diagonal((1, 1)))


@pytest.mark.parametrize(
    "step",
    [
        {"op": "gaussian", "sigma": 1, "threshold": 5},
        {"op": "gaussian", "sigma": True},
        {"op": "subtract_constant", "value": 1, "clip_negative": "yes"},
        {"op": "python", "value": "exec('x')"},
    ],
)
def test_unknown_recipe_controls_fail_closed(step):
    with pytest.raises(ValueError):
        process_scalar(np.ones((3, 3)), Geometry.diagonal((1, 1)), [step])


def test_colocalisation_analytic_reference_and_undefined_correlation():
    a = np.array([[0, 1], [2, 3]])
    b = np.array([[0, 2], [4, 0]])
    result = colocalisation(a, b, threshold_first=0, threshold_second=0)
    assert result["manders_first"] == 0.5
    assert result["manders_second"] == 1
    assert result["pearson_r"] == pytest.approx(np.corrcoef(a.ravel(), b.ravel())[0, 1], abs=1e-14)
    constant = colocalisation(a * 0, b, threshold_first=0, threshold_second=0)
    assert constant["pearson_r"] is None
    assert constant["manders_first"] is None
    with pytest.raises(ValueError, match="non-negative"):
        colocalisation(a - 1, b, threshold_first=0, threshold_second=0)


def test_nucleus_cell_overlap_ambiguity_and_outside_are_retained():
    nuclei = np.array([[1, 1, 1, 0], [0, 2, 2, 0]], np.uint32)
    cells = np.array([[9, 9, 8, 0], [0, 0, 0, 0]], np.uint32)
    rows = associate_labels(nuclei, cells)
    assert rows[0]["cell_label"] == 9
    assert rows[0]["overlap_fraction"] == 2 / 3
    assert rows[0]["ambiguous"] is True
    assert rows[1]["cell_label"] is None
    assert rows[1]["outside_fraction"] == 1


def test_marker_rules_require_controls_and_leave_measurements_unchanged():
    rows = [{"label": 10, "intensity": {"CD3": {"mean": 5.0}}}]
    gates = [
        {
            "name": "CD3-high",
            "channel": "CD3",
            "threshold": 4,
            "control": "threshold from declared unstained reference",
        }
    ]
    result = apply_marker_gates(rows, gates)
    assert result[0]["marker_gates"] == {"CD3-high": True}
    assert "marker_gates" not in rows[0]
    with pytest.raises(ValueError, match="control"):
        apply_marker_gates(rows, [{**gates[0], "control": ""}])


@pytest.mark.parametrize("value,dtype", [(2**53 + 1, np.uint64), (-(2**53) - 1, np.int64)])
def test_integer_precision_boundary_checked_before_float_conversion(value, dtype):
    raw = np.array([[value]], dtype=dtype)
    with pytest.raises(ValueError, match="2\\^53"):
        validate_array(raw)
    boundary = np.array([[2**53]], dtype=np.uint64)
    assert validate_array(boundary)[0, 0] == 2**53
