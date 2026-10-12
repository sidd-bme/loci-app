"""Independent topology and numeric oracles for the bounded YX route."""

import math
from collections import deque

import numpy as np
import pytest

import loci_engine.large_components as large
from loci_engine.quantitative import Geometry, measure_objects

# Declared before examining numerical output: counts/IDs/sums exact; physical
# floating measures and centered moments within these absolute tolerances.
POSITION_ATOL = 1e-10
MOMENT_ATOL = 1e-9


def _flood(image, *, threshold, polarity, min_pixels=1, exclude_border=False):
    """Hand BFS in global row-major order; independent of scipy.label/union-find."""
    height, width = image.shape
    mask = image > threshold if polarity == "bright" else image < threshold
    visited = set()
    output = np.zeros(image.shape, dtype=np.uint32)
    next_label = 1
    for y in range(height):
        for x in range(width):
            if not mask[y, x] or (y, x) in visited:
                continue
            queue = deque([(y, x)])
            visited.add((y, x))
            pixels = []
            while queue:
                cy, cx = queue.popleft()
                pixels.append((cy, cx))
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if (
                        0 <= ny < height
                        and 0 <= nx < width
                        and mask[ny, nx]
                        and (ny, nx) not in visited
                    ):
                        visited.add((ny, nx))
                        queue.append((ny, nx))
            border = any(py in (0, height - 1) or px in (0, width - 1) for py, px in pixels)
            if len(pixels) >= min_pixels and not (exclude_border and border):
                for py, px in pixels:
                    output[py, px] = next_label
                next_label += 1
    return output


def _segment(
    image, directory, *, core, threshold=5, polarity="bright", min_size=0, border=False, check=None
):
    output = np.full(image.shape, 0xFFFFFFFF, dtype=np.uint32)
    geometry = Geometry.diagonal((1.5, 0.5), "um")

    def read(y, x, h, w):
        return image[y : y + h, x : x + w]

    def write(y, x, values):
        output[y : y + values.shape[0], x : x + values.shape[1]] = values

    metadata = large.stream_components(
        read,
        write,
        image.shape,
        geometry,
        {
            "method": "components",
            "threshold": threshold,
            "polarity": polarity,
            "min_size": min_size,
            "exclude_border": border,
        },
        work_dir=directory,
        tile_size=core,
        check=check,
    )
    return output, metadata


@pytest.mark.parametrize("core", [2, 3, 4, 16])
def test_global_four_connected_seams_ragged_filters_and_threshold(core, tmp_path):
    # Horizontal/vertical seams, four-tile junction, diagonal-only contact,
    # tile-edge interior component and outer-border component coexist.
    image = np.array(
        [
            [9, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 9, 9, 0, 9, 9, 0, 0, 0],
            [0, 9, 5, 9, 9, 0, 0, 9, 0],
            [0, 0, 9, 9, 0, 0, 0, 9, 0],
            [0, 0, 0, 9, 9, 9, 0, 0, 0],
            [0, 9, 0, 0, 0, 9, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 9],
        ],
        dtype=np.uint16,
    )
    expected = _flood(image, threshold=5, polarity="bright", min_pixels=2, exclude_border=True)
    output, metadata = _segment(image, tmp_path, core=core, min_size=1.5, border=True)
    assert np.array_equal(output, expected)
    assert metadata["count"] == int(expected.max())
    assert metadata["threshold"] == 5.0
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("polarity", ["bright", "dark"])
def test_all_foreground_background_and_equality(polarity, tmp_path):
    image = np.full((5, 7), 5, dtype=np.uint8)
    image[1:4, 1:6] = 9 if polarity == "bright" else 1
    expected = _flood(image, threshold=5, polarity=polarity)
    output, metadata = _segment(image, tmp_path, core=2, polarity=polarity)
    assert np.array_equal(output, expected)
    assert metadata["count"] == 1
    empty, info = _segment(np.full((3, 3), 5, dtype=np.uint8), tmp_path, core=2, polarity=polarity)
    assert not empty.any() and info["count"] == 0
    full = np.full((3, 3), 9 if polarity == "bright" else 1, dtype=np.uint8)
    labels, info = _segment(full, tmp_path, core=2, polarity=polarity)
    assert np.array_equal(labels, np.ones((3, 3), dtype=np.uint32))
    assert info["count"] == 1


def test_comb_seams_and_provisional_final_caps(tmp_path, monkeypatch):
    image = np.zeros((9, 9), dtype=np.uint8)
    image[4, :] = 9
    image[1:8, 1::2] = 9
    output, metadata = _segment(image, tmp_path, core=2)
    assert np.array_equal(output, _flood(image, threshold=5, polarity="bright"))
    assert metadata["provisional_count"] > metadata["count"] == 1
    fragmented = np.fromfunction(lambda y, x: ((y + x) % 2) * 9, (5, 5), dtype=int).astype(np.uint8)
    monkeypatch.setattr(large, "MAX_PROVISIONAL", 5)
    with pytest.raises(ValueError, match="provisional"):
        _segment(fragmented, tmp_path, core=2)
    assert not list(tmp_path.iterdir())
    monkeypatch.setattr(large, "MAX_PROVISIONAL", 1_000_000)
    monkeypatch.setattr(large, "MAX_OBJECTS", 5)
    with pytest.raises(ValueError, match="final objects"):
        _segment(fragmented, tmp_path, core=2)
    assert not list(tmp_path.iterdir())


def test_near_final_object_limit_is_accepted(tmp_path):
    # 447^2 checkerboard with background at (0,0) has 99,904 objects.
    image = np.fromfunction(lambda y, x: ((y + x) % 2) * 9, (447, 447), dtype=int).astype(np.uint8)
    output, metadata = _segment(image, tmp_path, core=256)
    assert metadata["count"] == 99_904
    assert int(output.max()) == 99_904
    assert np.count_nonzero(output) == 99_904
    assert not list(tmp_path.iterdir())


def test_cancel_and_bad_source_leave_no_owned_temporary_cores(tmp_path):
    image = np.ones((10, 10), dtype=np.uint8) * 9
    calls = 0

    def cancel():
        nonlocal calls
        calls += 1
        if calls == 5:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        _segment(image, tmp_path, core=2, check=cancel)
    assert not list(tmp_path.iterdir())
    with pytest.raises(ValueError, match="Raw source"):
        large.stream_components(
            lambda y, x, h, w: np.ones((h, w), dtype=np.float32),
            lambda y, x, values: None,
            image.shape,
            Geometry.diagonal((1, 1)),
            {"threshold": 5},
            work_dir=tmp_path,
            tile_size=2,
        )
    assert not list(tmp_path.iterdir())


def _measure(labels, image, *, core, geometry=None):
    rows = []
    geometry = geometry or Geometry.diagonal((2, 3), "um")
    count = large.measure_tiled(
        lambda y, x, h, w: labels[y : y + h, x : x + w],
        lambda y, x, h, w: image[y : y + h, x : x + w],
        labels.shape,
        geometry,
        "raw",
        rows.append,
        tile_size=core,
    )
    assert count == len(rows)
    return rows


def test_closed_form_rectangle_measurement_and_legacy_reference():
    labels = np.zeros((4, 5), dtype=np.uint32)
    labels[1:3, 1:4] = 7
    image = (60000 + np.arange(20).reshape(4, 5)).astype(np.uint16)
    rows = _measure(labels, image, core=2)
    row = rows[0]
    raw = image[1:3, 1:4].astype(int).ravel().tolist()
    mean = math.fsum(raw) / 6
    variance = math.fsum((value - mean) ** 2 for value in raw) / 6
    assert row["label"] == 7 and row["voxel_count"] == 6
    assert row["measure"] == 36.0
    assert row["centroid_index"] == pytest.approx([1.5, 2.0], abs=POSITION_ATOL)
    assert row["centroid_world_xyz"] == pytest.approx([6.0, 3.0, 0.0], abs=POSITION_ATOL)
    assert row["bbox_start"] == [1, 1] and row["bbox_stop_exclusive"] == [3, 4]
    assert row["principal_rms_radii"] == pytest.approx([math.sqrt(6), 1.0, 0.0], abs=MOMENT_ATOL)
    assert row["intensity"]["raw"]["sum"] == sum(raw)
    assert row["intensity"]["raw"]["mean"] == pytest.approx(mean, abs=POSITION_ATOL)
    assert row["intensity"]["raw"]["std_population"] == pytest.approx(
        math.sqrt(variance), abs=MOMENT_ATOL
    )
    assert row["nearest_centroid_distance"] is None
    legacy = measure_objects(labels, Geometry.diagonal((2, 3), "um"), {"raw": image})[0]
    for field in ("measure", "centroid_index", "centroid_world_xyz", "principal_rms_radii"):
        assert row[field] == pytest.approx(legacy[field], abs=MOMENT_ATOL)


def test_sparse_ids_survive_deletion_and_nearest_neighbors_recompute():
    labels = np.zeros((1, 11), dtype=np.uint32)
    labels[0, [0, 1, 10]] = [1, 70000, 0xFFFFFFFF]
    image = np.full(labels.shape, 65535, dtype=np.uint16)
    geometry = Geometry.diagonal((1, 1), "um")
    first = _measure(labels, image, core=2, geometry=geometry)
    assert [row["label"] for row in first] == [1, 70000, 0xFFFFFFFF]
    assert [row["nearest_centroid_distance"] for row in first] == pytest.approx([1, 1, 9])
    labels[labels == 70000] = 0
    corrected = _measure(labels, image, core=3, geometry=geometry)
    assert [row["label"] for row in corrected] == [1, 0xFFFFFFFF]
    assert [row["nearest_centroid_distance"] for row in corrected] == pytest.approx([10, 10])
    assert all(row["intensity"]["raw"]["std_population"] == 0 for row in corrected)


def test_affine_world_coordinates_and_measurement_cancellation():
    matrix = (
        (0.0, -2.0, 0.0, 100.0),
        (3.0, 0.0, 0.0, 200.0),
        (0.0, 0.0, 1.0, 5.0),
        (0.0, 0.0, 0.0, 1.0),
    )
    geometry = Geometry("YX", matrix, "um", "image")
    labels = np.zeros((5, 6), dtype=np.uint32)
    labels[2, 3] = 4
    image = np.ones(labels.shape, dtype=np.uint8)
    row = _measure(labels, image, core=2, geometry=geometry)[0]
    assert row["centroid_world_xyz"] == pytest.approx([96.0, 209.0, 5.0], abs=POSITION_ATOL)
    assert row["measure"] == pytest.approx(6.0, abs=POSITION_ATOL)
    calls = 0

    def check():
        nonlocal calls
        calls += 1
        if calls == 3:
            raise RuntimeError("cancelled")

    emitted = []
    with pytest.raises(RuntimeError, match="cancelled"):
        large.measure_tiled(
            lambda y, x, h, w: labels[y : y + h, x : x + w],
            lambda y, x, h, w: image[y : y + h, x : x + w],
            labels.shape,
            geometry,
            "raw",
            emitted.append,
            tile_size=2,
            check=check,
        )
    assert emitted == []


def test_sparse_multiobject_measurements_match_legacy_small_reference():
    rng = np.random.default_rng(240924)
    labels = rng.choice(
        np.array([0, 1, 70000, 0xFFFFFFFF], dtype=np.uint32),
        size=(7, 9),
        p=[0.7, 0.1, 0.1, 0.1],
    )
    image = rng.integers(65000, 65536, size=labels.shape, dtype=np.uint16)
    geometry = Geometry.diagonal((0.75, 1.25), "um")
    actual = _measure(labels, image, core=3, geometry=geometry)
    expected = measure_objects(labels, geometry, {"raw": image})
    assert [row["label"] for row in actual] == [row["label"] for row in expected]
    for row, reference in zip(actual, expected, strict=True):
        for field in (
            "voxel_count",
            "measure_kind",
            "measure_unit",
            "index_axes",
            "world_frame",
            "distance_unit",
            "bbox_start",
            "bbox_stop_exclusive",
            "touches_crop_border",
        ):
            assert row[field] == reference[field]
        for field in (
            "measure",
            "centroid_index",
            "centroid_world_xyz",
            "principal_rms_radii",
            "nearest_centroid_distance",
        ):
            assert row[field] == pytest.approx(reference[field], abs=MOMENT_ATOL)
        for field in ("sum", "min", "max"):
            assert row["intensity"]["raw"][field] == reference["intensity"]["raw"][field]
        for field in ("mean", "std_population"):
            assert row["intensity"]["raw"][field] == pytest.approx(
                reference["intensity"]["raw"][field], abs=MOMENT_ATOL
            )


def test_measurement_rejects_shape_or_dtype_and_empty_is_valid():
    labels = np.zeros((3, 3), dtype=np.uint32)
    image = np.ones((3, 3), dtype=np.uint8)
    assert _measure(labels, image, core=2) == []
    labels[1, 1] = 1
    with pytest.raises(ValueError, match="Raw image"):
        _measure(labels, image.astype(np.float32), core=2)
