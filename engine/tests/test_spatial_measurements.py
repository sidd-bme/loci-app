"""Independent discrete-distance oracles; no anatomical validity claims."""

from __future__ import annotations

import math

import numpy as np
import pytest

from loci_engine import spatial_measurements as spatial
from loci_engine.quantitative import Geometry
from loci_engine.spatial_measurements import measure_distance_bands


def brute_force(labels, compartment, boundary, spacing, edges, exclude_border):
    """Enumerate source pixels and boundary centers, independently of EDT/tree."""
    boundary_points = list(zip(*np.nonzero(boundary), strict=True))

    def distance(y, x):
        return min(
            math.hypot((y - by) * spacing[0], (x - bx) * spacing[1]) for by, bx in boundary_points
        )

    def band_for(value):
        for index, (lower, upper) in enumerate(zip(edges[:-1], edges[1:], strict=True)):
            if lower <= value < upper:
                return index
        return None

    output = np.zeros(labels.shape, dtype=np.uint32)
    pixels = [0] * (len(edges) - 1)
    objects = [0] * (len(edges) - 1)
    for y in range(labels.shape[0]):
        for x in range(labels.shape[1]):
            index = band_for(distance(y, x))
            if compartment[y, x] and index is not None:
                pixels[index] += 1
                output[y, x] = index + 1
    rows = []
    for label in sorted(set(labels.ravel().tolist()) - {0}):
        coordinates = np.argwhere(labels == label)
        y, x = coordinates.mean(axis=0)
        value = distance(y, x)
        candidate = band_for(value)
        exclusions = []
        if not compartment[math.floor(y + 0.5), math.floor(x + 0.5)]:
            exclusions.append("outside_compartment")
        if exclude_border and any(
            py in (0, labels.shape[0] - 1) or px in (0, labels.shape[1] - 1)
            for py, px in coordinates
        ):
            exclusions.append("crop_border")
        if candidate is None:
            exclusions.append("outside_bands")
        selected = None if exclusions else candidate
        if selected is not None:
            objects[selected] += 1
        rows.append(
            {"label": label, "distance": value, "band_index": selected, "exclusions": exclusions}
        )
    bands = []
    for index, (lower, upper) in enumerate(zip(edges[:-1], edges[1:], strict=True)):
        area = pixels[index] * spacing[0] * spacing[1]
        bands.append(
            {
                "lower": lower,
                "upper": upper,
                "pixel_count": pixels[index],
                "area": area,
                "object_count": objects[index],
                "density": objects[index] / area if area else None,
            }
        )
    return rows, bands, output


def assert_oracle(actual, expected):
    rows, bands, output = actual
    expected_rows, expected_bands, expected_output = expected
    assert len(rows) == len(expected_rows)
    for row, reference in zip(rows, expected_rows, strict=True):
        assert row.keys() == reference.keys()
        assert row["label"] == reference["label"]
        assert row["distance"] == pytest.approx(reference["distance"], abs=1e-12)
        assert row["band_index"] == reference["band_index"]
        assert row["exclusions"] == reference["exclusions"]
    assert len(bands) == len(expected_bands)
    for band, reference in zip(bands, expected_bands, strict=True):
        assert band == pytest.approx(reference)
    assert output.dtype == np.uint32
    np.testing.assert_array_equal(output, expected_output)


@pytest.mark.parametrize("seed", range(5))
@pytest.mark.parametrize("exclude_border", [False, True])
def test_anisotropic_sparse_objects_against_independent_oracle(seed, exclude_border):
    rng = np.random.default_rng(seed)
    labels = rng.choice(np.array([0, 0, 0, 7, 801, 2**32 - 1], dtype=np.uint32), (9, 11))
    compartment = rng.random(labels.shape) > 0.25
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[0, 2] = boundary[4, 7] = boundary[8, 10] = True
    before = [value.copy() for value in (labels, compartment, boundary)]
    spacing, edges = (2.0, 0.5), [0, 0.5, 1, 2, 4, 20]
    actual = measure_distance_bands(
        labels,
        compartment,
        boundary,
        Geometry.diagonal(spacing, "um"),
        edges,
        exclude_crop_border=exclude_border,
    )
    assert_oracle(
        actual, brute_force(labels, compartment, boundary, spacing, edges, exclude_border)
    )
    for value, original in zip((labels, compartment, boundary), before, strict=True):
        np.testing.assert_array_equal(value, original)


def test_fractional_centroid_is_direct_distance_not_sampled_or_interpolated_edt():
    labels = np.zeros((5, 5), dtype=np.uint32)
    labels[1:3, 1:3] = 900_000_001
    boundary = np.zeros_like(labels, dtype=bool)
    boundary[0, 0] = True
    compartment = np.ones_like(boundary)
    rows, _, _ = measure_distance_bands(
        labels, compartment, boundary, Geometry.diagonal((2, 3), "um"), [0, 5.5, 20]
    )
    assert rows == [
        {"label": 900_000_001, "distance": math.hypot(3, 4.5), "band_index": 0, "exclusions": []}
    ]


def test_half_pixel_membership_ties_choose_increasing_array_index():
    labels = np.zeros((5, 5), dtype=np.uint32)
    labels[1, 1:3] = 1  # centroid (1, 1.5), rounds to compartment pixel (1, 2)
    compartment = np.zeros(labels.shape, dtype=bool)
    compartment[1, 1] = True
    boundary = np.zeros_like(compartment)
    boundary[0, 0] = True
    rows, _, _ = measure_distance_bands(
        labels, compartment, boundary, Geometry.diagonal((1, 1), "mm"), [0, 10]
    )
    assert rows[0]["band_index"] is None
    assert rows[0]["exclusions"] == ["outside_compartment"]
    compartment[1, 2] = True
    rows, _, _ = measure_distance_bands(
        labels, compartment, boundary, Geometry.diagonal((1, 1), "mm"), [0, 10]
    )
    assert rows[0]["band_index"] == 0


def test_half_open_edges_overlap_and_last_upper_edge_exclusion():
    labels = np.zeros((5, 5), dtype=np.uint64)
    labels[2, 0:5] = [3, 0, 9, 0, 2**32 - 1]
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[:, 0] = True
    compartment = np.ones_like(boundary)
    rows, bands, output = measure_distance_bands(
        labels,
        compartment,
        boundary,
        Geometry.diagonal((1, 2), "nm"),
        [0, 4, 8],
        exclude_crop_border=False,
    )
    assert [(r["label"], r["distance"], r["band_index"], r["exclusions"]) for r in rows] == [
        (3, 0, 0, []),
        (9, 4, 1, []),
        (2**32 - 1, 8, None, ["outside_bands"]),
    ]
    assert [band["pixel_count"] for band in bands] == [10, 10]
    assert [band["area"] for band in bands] == [20, 20]
    assert [band["object_count"] for band in bands] == [1, 1]
    np.testing.assert_array_equal(output[2], [1, 1, 2, 2, 0])


def test_crop_border_excludes_whole_object_even_with_interior_centroid():
    labels = np.zeros((5, 5), dtype=np.uint32)
    labels[0:3, 2] = 77
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[:, 0] = True
    compartment = np.ones_like(boundary)
    geometry = Geometry.diagonal((1, 1), "um")
    rows, bands, _ = measure_distance_bands(labels, compartment, boundary, geometry, [0, 10])
    assert rows[0]["exclusions"] == ["crop_border"]
    assert rows[0]["distance"] == 2
    assert bands[0]["density"] == 0.0
    rows, bands, _ = measure_distance_bands(
        labels, compartment, boundary, geometry, [0, 10], exclude_crop_border=False
    )
    assert rows[0]["exclusions"] == []
    assert bands[0]["object_count"] == 1


def test_empty_objects_and_compartment_have_explicit_zero_and_null_density():
    labels = np.zeros((3, 3), dtype=np.uint32)
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[1, 1] = True
    geometry = Geometry.diagonal((2, 3), "um")
    rows, bands, output = measure_distance_bands(
        labels, np.ones_like(boundary), boundary, geometry, [0, 1, 2, 10]
    )
    assert rows == []
    assert bands[0] == {
        "lower": 0,
        "upper": 1,
        "pixel_count": 1,
        "area": 6,
        "object_count": 0,
        "density": 0.0,
    }
    assert bands[1]["area"] == 0
    assert bands[1]["density"] is None
    rows, bands, output = measure_distance_bands(
        labels, np.zeros_like(boundary), boundary, geometry, [0, 10]
    )
    assert rows == []
    assert bands[0]["area"] == 0
    assert bands[0]["density"] is None
    assert not output.any()


def test_rotated_translated_orthogonal_grid_retains_distances_and_area():
    labels = np.zeros((5, 5), dtype=np.uint32)
    labels[2, 3] = 18
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[1, 1] = True
    compartment = np.ones_like(boundary)
    geometry = Geometry(
        "YX", ((0, -2, 0, 100), (3, 0, 0, -40), (0, 0, 1, 5), (0, 0, 0, 1)), "um", "LPS"
    )
    assert_oracle(
        measure_distance_bands(labels, compartment, boundary, geometry, [0, 4, 20]),
        brute_force(labels, compartment, boundary, (2, 3), [0, 4, 20], True),
    )


def test_fractional_centroid_can_count_in_a_zero_sampled_area_band_without_density():
    labels = np.zeros((5, 5), dtype=np.uint32)
    labels[1, 1] = labels[2, 2] = 4
    compartment = np.ones(labels.shape, dtype=bool)
    boundary = np.zeros_like(compartment)
    boundary[0, 0] = True
    rows, bands, output = measure_distance_bands(
        labels, compartment, boundary, Geometry.diagonal((1, 1), "um"), [2.1, 2.2]
    )
    assert rows[0]["distance"] == pytest.approx(math.sqrt(4.5))
    assert rows[0]["band_index"] == 0
    assert bands[0]["object_count"] == 1
    assert bands[0]["area"] == 0
    assert bands[0]["density"] is None
    assert not output.any()


def test_preserves_all_exclusion_reasons_and_accepts_32_bands():
    labels = np.zeros((3, 3), dtype=np.uint32)
    labels[0, 0] = 19
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[0, 0] = True
    rows, bands, output = measure_distance_bands(
        labels,
        np.zeros_like(boundary),
        boundary,
        Geometry.diagonal((1, 1), "um"),
        list(range(1, 34)),
    )
    assert rows == [
        {
            "label": 19,
            "distance": 0.0,
            "band_index": None,
            "exclusions": ["outside_compartment", "crop_border", "outside_bands"],
        }
    ]
    assert len(bands) == 32
    assert all(band["density"] is None for band in bands)
    assert not output.any()


@pytest.mark.parametrize(
    "edges",
    [
        [],
        [0],
        [0, 0],
        [1, 0],
        [-1, 2],
        [0, float("inf")],
        [0, float("nan")],
        [False, 2],
        [0, "2"],
        list(range(34)),
        np.array([[0, 1]]),
    ],
)
def test_rejects_invalid_or_excessive_bands(edges):
    labels = np.zeros((3, 3), dtype=np.uint32)
    mask = np.ones_like(labels, dtype=bool)
    with pytest.raises(ValueError):
        measure_distance_bands(labels, mask, mask, Geometry.diagonal((1, 1), "um"), edges)


@pytest.mark.parametrize(
    "labels",
    [
        np.zeros((0, 3), dtype=np.uint32),
        np.zeros((3, 3, 3), dtype=np.uint32),
        np.zeros((3, 3), dtype=float),
        np.full((3, 3), -1, dtype=np.int64),
        np.full((3, 3), 2**32, dtype=np.uint64),
    ],
)
def test_rejects_invalid_label_grids(labels):
    mask = np.ones_like(labels, dtype=bool)
    with pytest.raises(ValueError):
        measure_distance_bands(labels, mask, mask, Geometry.diagonal((1, 1), "um"), [0, 10])


@pytest.mark.parametrize(
    "geometry",
    [
        Geometry.diagonal((1, 1)),
        Geometry.diagonal((1, 1, 1), "um"),
        Geometry("YX", ((1, 0.5, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)), "um"),
        None,
    ],
)
def test_rejects_uncalibrated_wrong_axes_unknown_or_sheared_geometry(geometry):
    labels = np.zeros((3, 3), dtype=np.uint32)
    mask = np.ones_like(labels, dtype=bool)
    with pytest.raises(ValueError):
        measure_distance_bands(labels, mask, mask, geometry, [0, 10])


@pytest.mark.parametrize("which", ["compartment", "boundary"])
@pytest.mark.parametrize("mask", [np.ones((3, 3), dtype=np.uint8), np.ones((2, 3), dtype=bool)])
def test_masks_require_exact_shape_and_boolean_dtype(which, mask):
    labels = np.zeros((3, 3), dtype=np.uint32)
    compartment = boundary = np.ones(labels.shape, dtype=bool)
    if which == "compartment":
        compartment = mask
    else:
        boundary = mask
    with pytest.raises(ValueError, match="mask must be boolean"):
        measure_distance_bands(
            labels, compartment, boundary, Geometry.diagonal((1, 1), "um"), [0, 10]
        )


def test_rejects_empty_boundary():
    labels = np.zeros((3, 3), dtype=np.uint32)
    with pytest.raises(ValueError, match="boundary must contain"):
        measure_distance_bands(
            labels,
            np.ones_like(labels, dtype=bool),
            np.zeros_like(labels, dtype=bool),
            Geometry.diagonal((1, 1), "um"),
            [0, 10],
        )


def test_rejects_memory_before_unique_edt_or_tree_allocation(monkeypatch):
    labels = np.zeros((30, 30), dtype=np.uint32)
    mask = np.ones(labels.shape, dtype=bool)

    def forbidden(*args, **kwargs):
        raise AssertionError("Pixel-sized work allocated before memory preflight")

    monkeypatch.setattr(spatial.np, "unique", forbidden)
    monkeypatch.setattr(spatial.ndi, "distance_transform_edt", forbidden)
    monkeypatch.setattr(spatial, "cKDTree", forbidden)
    with pytest.raises(ValueError, match="working-memory budget"):
        measure_distance_bands(
            labels, mask, mask, Geometry.diagonal((1, 1), "um"), [0, 10], working_bytes=1024
        )


def test_rejects_more_than_100000_objects_without_largest_id_indexing():
    labels = np.arange(1, 100_002, dtype=np.uint32).reshape(1, -1)
    mask = np.ones(labels.shape, dtype=bool)
    with pytest.raises(ValueError, match="at most 100000"):
        measure_distance_bands(labels, mask, mask, Geometry.diagonal((1, 1), "um"), [0, 10])
