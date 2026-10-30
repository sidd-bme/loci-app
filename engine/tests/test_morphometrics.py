"""Independent digital-union formulas; no biological shape-accuracy claims."""

import math

import numpy as np
import pytest

from loci_engine import morphometrics as morphology
from loci_engine.morphometrics import estimated_working_bytes, measure_morphometrics
from loci_engine.quantitative import Geometry, measure_objects


def affine(x, y, z=(0, 0, 1), origin=(0, 0, 0), axes="YX"):
    matrix = np.eye(4)
    matrix[:3, :3] = np.array([x, y, z], dtype=float).T
    matrix[:3, 3] = origin
    return Geometry(axes, tuple(map(tuple, matrix)), "um")


def rectangle(ny=3, nx=4):
    labels = np.zeros((ny + 4, nx + 4), np.uint32)
    labels[2 : 2 + ny, 2 : 2 + nx] = 4_000_000_000
    return labels


def test_anisotropic_rectangle_perimeter_area_and_center_moments():
    labels = rectangle()
    report = measure_morphometrics(labels, Geometry.diagonal((2, 3), "um"))
    row = report["rows"][0]
    assert report["schema"] == "loci.morphometrics/v1"
    assert report["object_count"] == 1
    assert row["label"] == 4_000_000_000 and row["voxel_count"] == 12
    assert row["pixel_union_area"] == 72
    assert row["perimeter"] == 36
    assert row["exposed_face_counts"] == [8, 6]
    assert row["circularity"] == pytest.approx(2 * math.pi / 9)
    assert row["center_covariance_eigenvalues"] == pytest.approx([45 / 4, 8 / 3])
    assert row["eccentricity"] == pytest.approx(math.sqrt(103 / 135))
    assert row["elongation"] == pytest.approx(math.sqrt(135 / 32))
    assert row["touches_crop_border"] is False
    assert row["surface_area"] is None and row["sphericity"] is None
    assert row["undefined_reasons"]["surface_area"] == "requires-3d"
    assert report["units"]["perimeter"] == "um"
    assert report["units"]["pixel_union_area"] == "um^2"
    assert report["units"]["center_covariance_eigenvalues"] == "um^2"


def test_pixel_union_is_not_a_fitted_disk_and_zero_moment_ratios_stay_null():
    row = measure_morphometrics(np.array([[9]], np.uint32), Geometry.diagonal((1, 1)))["rows"][0]
    assert row["pixel_union_area"] == 1 and row["perimeter"] == 4
    assert row["circularity"] == pytest.approx(math.pi / 4)
    assert row["eccentricity"] is None and row["elongation"] is None
    assert row["undefined_reasons"]["eccentricity"] == "zero-major-center-moment"
    assert row["undefined_reasons"]["elongation"] == "zero-major-center-moment"
    assert row["center_covariance_eigenvalues"] == [0, 0]
    assert row["touches_crop_border"] is True


@pytest.mark.parametrize("sheared", [False, True])
def test_exact_collinear_center_rank_does_not_invent_finite_elongation(sheared):
    labels = np.zeros((7, 7), np.uint32)
    for index in range(1, 6):
        labels[index, index] = 101
    geometry = affine((1.3, 0.7, 0.2), (0.4, 2.1, 0.8)) if sheared else Geometry.diagonal((2, 3))
    row = measure_morphometrics(labels, geometry)["rows"][0]
    assert row["eccentricity"] == 1
    assert row["elongation"] is None
    assert row["undefined_reasons"]["elongation"] == "zero-minor-center-moment"
    assert row["center_covariance_eigenvalues"][1] == 0
    assert row["perimeter"] > 0 and row["pixel_union_area"] > 0


def test_sheared_rectangle_matches_analytic_parallelogram_and_moment_eigenvalues():
    geometry = affine((1, 0, 0), (0.5, 2, 0))
    row = measure_morphometrics(rectangle(), geometry)["rows"][0]
    assert row["pixel_union_area"] == 24
    perimeter = 8 + 6 * math.sqrt(4.25)
    assert row["perimeter"] == pytest.approx(perimeter)
    xx, yy, xy = 17 / 12, 8 / 3, 2 / 3
    gap = math.sqrt((xx - yy) ** 2 + 4 * xy**2)
    major, minor = ((xx + yy + gap) / 2, (xx + yy - gap) / 2)
    assert row["center_covariance_eigenvalues"] == pytest.approx([major, minor])
    assert row["elongation"] == pytest.approx(math.sqrt(major / minor))
    assert row["eccentricity"] == pytest.approx(math.sqrt(1 - minor / major))
    assert row["circularity"] == pytest.approx(4 * math.pi * 24 / perimeter**2)


def test_rotated_reflected_embedded_plane_and_huge_translation_preserve_metrics():
    base = affine((1, 0, 0), (0.5, 2, 0))
    rotation = np.array([[0, -1, 0], [0, 0, 1], [1, 0, 0]], dtype=float)
    matrix = np.array(base.affine)
    matrix[:3, :3] = rotation @ matrix[:3, :3]
    matrix[:3, 3] = [1e20, -1e20, 3e20]
    rotated = Geometry("YX", tuple(map(tuple, matrix)), "um")
    a = measure_morphometrics(rectangle(), base)["rows"][0]
    b = measure_morphometrics(rectangle(), rotated)["rows"][0]
    for key in ("pixel_union_area", "perimeter", "circularity", "eccentricity", "elongation"):
        assert b[key] == pytest.approx(a[key], rel=1e-12)
    assert b["center_covariance_eigenvalues"] == pytest.approx(a["center_covariance_eigenvalues"])


def test_nonzero_tiny_minor_moment_is_not_erased_by_relative_eigenvalue_tolerance():
    row = measure_morphometrics(rectangle(2, 3), Geometry.diagonal((1e-9, 1), "um"))["rows"][0]
    assert row["center_covariance_eigenvalues"][1] == pytest.approx(2.5e-19, rel=1e-12, abs=0)
    assert row["elongation"] == pytest.approx(math.sqrt(2 / 3) / 5e-10)
    assert "elongation" not in row["undefined_reasons"]


def test_holes_and_different_label_contact_faces_are_counted_explicitly():
    labels = np.zeros((5, 5), np.uint32)
    labels[1:4, 1:4] = 7
    labels[2, 2] = 0
    row = measure_morphometrics(labels, Geometry.diagonal((2, 3), "um"))["rows"][0]
    assert row["pixel_union_area"] == 48
    assert row["exposed_face_counts"] == [8, 8]
    assert row["perimeter"] == 40  # outer perimeter30 plus hole perimeter10
    touching = np.array([[7, 0xFFFFFFFF]], np.uint32)
    rows = measure_morphometrics(touching, Geometry.diagonal((2, 3), "um"))["rows"]
    assert [r["label"] for r in rows] == [7, 0xFFFFFFFF]
    assert [r["perimeter"] for r in rows] == [10, 10]
    union = measure_morphometrics(np.ones((1, 2), np.uint32), Geometry.diagonal((2, 3), "um"))[
        "rows"
    ][0]
    assert union["perimeter"] == 16
    assert sum(r["perimeter"] for r in rows) - union["perimeter"] == 4


def test_3d_anisotropic_cuboid_voxel_union_surface_and_sphericity():
    labels = np.zeros((6, 7, 8), np.uint32)
    labels[2:4, 2:5, 2:6] = 13
    report = measure_morphometrics(labels, Geometry.diagonal((5, 2, 3), "um"))
    row = report["rows"][0]
    assert row["voxel_count"] == 24
    assert row["voxel_union_volume"] == 720
    assert row["surface_area"] == 504
    assert row["exposed_face_counts"] == [24, 16, 12]
    assert row["center_covariance_eigenvalues"] == pytest.approx([45 / 4, 25 / 4, 8 / 3])
    assert row["sphericity"] == pytest.approx((36 * math.pi * 720**2) ** (1 / 3) / 504)
    assert row["perimeter"] is None and row["pixel_union_area"] is None
    assert row["eccentricity"] is None and row["undefined_reasons"]["eccentricity"] == "requires-2d"
    assert report["units"]["surface_area"] == "um^2"
    assert report["units"]["voxel_union_volume"] == "um^3"


def test_single_voxel_and_internal_cavity_are_digital_union_endpoints():
    row = measure_morphometrics(np.ones((1, 1, 1), np.uint32), Geometry.diagonal((2, 2, 2), "um"))[
        "rows"
    ][0]
    assert row["voxel_union_volume"] == 8 and row["surface_area"] == 24
    assert row["sphericity"] == pytest.approx((math.pi / 6) ** (1 / 3))
    assert row["center_covariance_eigenvalues"] == [0, 0, 0]
    labels = np.zeros((5, 5, 5), np.uint32)
    labels[1:4, 1:4, 1:4] = 2
    labels[2, 2, 2] = 0
    cavity = measure_morphometrics(labels, Geometry.diagonal((1, 1, 1)))["rows"][0]
    assert cavity["voxel_union_volume"] == 26
    assert cavity["surface_area"] == 60
    assert cavity["exposed_face_counts"] == [20, 20, 20]
    assert cavity["touches_crop_border"] is False


def test_3d_sheared_reflected_cuboid_surface_is_exact_affine_faces():
    geometry = affine((2, 0, 0), (1, 3, 0), (0.5, 0.5, 4), axes="ZYX")
    labels = np.ones((2, 3, 4), np.uint32)
    row = measure_morphometrics(labels, geometry)["rows"][0]
    assert row["voxel_union_volume"] == 24 * 24
    assert row["surface_area"] == pytest.approx(24 * 6 + 16 * math.sqrt(65) + 12 * math.sqrt(161))
    matrix = np.array(geometry.affine)
    matrix[0, :3] *= -1
    matrix[:3, 3] = [100, -200, 300]
    reflected = measure_morphometrics(labels, Geometry("ZYX", tuple(map(tuple, matrix)), "um"))[
        "rows"
    ][0]
    assert reflected["surface_area"] == pytest.approx(row["surface_area"])
    assert reflected["voxel_union_volume"] == row["voxel_union_volume"]
    assert reflected["sphericity"] == pytest.approx(row["sphericity"])


@pytest.mark.parametrize("dimension", [2, 3])
def test_sparse_label_permutation_and_crop_flags_do_not_change_geometry(dimension):
    rng = np.random.default_rng(9)
    labels = rng.choice(
        np.array([0, 7, 301, 0xFFFFFFFF], np.uint32), (4, 5) if dimension == 2 else (3, 4, 5)
    )
    geometry = Geometry.diagonal((2, 3) if dimension == 2 else (5, 2, 3), "um")
    rows = {r["label"]: r for r in measure_morphometrics(labels, geometry)["rows"]}
    permutation = {7: 0xFFFFFFFF, 301: 7, 0xFFFFFFFF: 301}
    changed = np.zeros_like(labels)
    for old, new in permutation.items():
        changed[labels == old] = new
    swapped = {r["label"]: r for r in measure_morphometrics(changed, geometry)["rows"]}
    for old, new in permutation.items():
        assert {k: v for k, v in rows[old].items() if k != "label"} == {
            k: v for k, v in swapped[new].items() if k != "label"
        }
    padded = measure_morphometrics(np.pad(labels, 1), geometry)["rows"]
    for row in padded:
        assert row["touches_crop_border"] is False
        for key in ("perimeter", "surface_area", "pixel_union_area", "voxel_union_volume"):
            assert row[key] == rows[row["label"]][key]


def brute_faces(labels, spacing):
    output = {}
    for index in np.ndindex(labels.shape):
        identity = int(labels[index])
        if not identity:
            continue
        count, faces = output.setdefault(identity, [0, [0] * labels.ndim])
        output[identity][0] = count + 1
        for axis in range(labels.ndim):
            for delta in (-1, 1):
                neighbor = list(index)
                neighbor[axis] += delta
                if (
                    not 0 <= neighbor[axis] < labels.shape[axis]
                    or labels[tuple(neighbor)] != identity
                ):
                    faces[axis] += 1
    return {
        key: (
            count,
            faces,
            sum(
                number * math.prod(spacing[:axis] + spacing[axis + 1 :])
                for axis, number in enumerate(faces)
            ),
        )
        for key, (count, faces) in output.items()
    }


@pytest.mark.parametrize("dimension", [2, 3])
@pytest.mark.parametrize("seed", range(4))
def test_chunked_face_counts_against_independent_neighbor_enumeration(dimension, seed, monkeypatch):
    monkeypatch.setattr(morphology, "CHUNK_PIXELS", 7)
    rng = np.random.default_rng(seed)
    shape = (5, 7) if dimension == 2 else (4, 5, 6)
    spacing = (2.0, 0.5) if dimension == 2 else (3.0, 2.0, 0.5)
    labels = rng.choice(np.array([0, 1, 7, 4000000000], np.uint32), shape)
    expected = brute_faces(labels, spacing)
    for row in measure_morphometrics(labels, Geometry.diagonal(spacing, "um"))["rows"]:
        count, faces, boundary = expected[row["label"]]
        assert row["voxel_count"] == count
        assert row["exposed_face_counts"] == faces
        assert row["perimeter" if dimension == 2 else "surface_area"] == boundary


def test_existing_center_rms_radii_and_all_input_arrays_remain_unchanged():
    base = rectangle()
    labels = np.asfortranarray(base)
    labels.flags.writeable = False
    geometry = Geometry.diagonal((2, 3), "um")
    before = measure_objects(labels, geometry)
    report = measure_morphometrics(labels, geometry)
    assert "principal_rms_radii" not in report["rows"][0]
    assert measure_objects(labels, geometry) == before
    assert report["rows"][0]["center_covariance_eigenvalues"] == pytest.approx(
        [r * r for r in before[0]["principal_rms_radii"][:2]]
    )
    np.testing.assert_array_equal(labels, base)
    assert labels.flags.writeable is False
    strided = base[::2, ::2]
    assert measure_morphometrics(strided, geometry) == measure_morphometrics(
        np.ascontiguousarray(strided), geometry
    )
    report["geometry"]["affine"][0][0] = -123
    assert geometry.affine[0][0] == 3


@pytest.mark.parametrize("dimension", [2, 3])
def test_empty_foreground_has_no_invented_object_or_zero_denominator_metric(dimension):
    report = measure_morphometrics(
        np.zeros((3,) * dimension, np.uint32), Geometry.diagonal((1,) * dimension)
    )
    assert report["rows"] == [] and report["object_count"] == 0


@pytest.mark.parametrize(
    "labels",
    [
        np.array([[True]]),
        np.array([[1.0]]),
        np.array([[-1]], np.int32),
        np.array([[2**32]], np.uint64),
        np.zeros((0, 2), np.uint32),
        np.zeros((3,), np.uint32),
        [[1, 2]],
    ],
)
def test_invalid_labels_shapes_and_unbounded_ids_are_refused(labels):
    with pytest.raises(ValueError):
        measure_morphometrics(labels, Geometry.diagonal((1, 1)))


def test_axes_memory_and_object_bounds_fail_before_expensive_work(monkeypatch):
    labels = np.arange(64, dtype=np.uint32).reshape(8, 8)
    geometry = Geometry.diagonal((1, 1))
    with pytest.raises(ValueError, match="axes"):
        measure_morphometrics(labels, Geometry.diagonal((1, 1, 1)))
    with monkeypatch.context() as patch:
        patch.setattr(
            np, "unique", lambda *a, **k: pytest.fail("Sort occurred before memory refusal")
        )
        with pytest.raises(ValueError, match="workspace"):
            measure_morphometrics(labels, geometry, working_bytes=1024)
    with pytest.raises(ValueError, match="object rows"):
        measure_morphometrics(
            labels, geometry, working_bytes=estimated_working_bytes(labels.size) + 100
        )
    monkeypatch.setattr(morphology, "MAX_OBJECTS", 2)
    with pytest.raises(ValueError, match="at most"):
        measure_morphometrics(labels, geometry)


def test_ill_conditioned_or_nonfinite_physical_endpoint_is_refused():
    labels = rectangle()
    with pytest.raises(ValueError, match="ill-conditioned"):
        measure_morphometrics(labels, affine((1, 0, 0), (1, 1e-14, 0)))
    with np.errstate(over="ignore", invalid="ignore"):
        huge = affine((1e200, 0, 0), (0, 1e200, 0))
    with pytest.raises(ValueError, match="finite positive"):
        measure_morphometrics(labels, huge)


@pytest.mark.parametrize("stop_at", [1, 3, 30, 60, 120])
def test_cancellation_check_interrupts_bounded_stages_without_mutating_input(stop_at, monkeypatch):
    monkeypatch.setattr(morphology, "CHUNK_PIXELS", 4)
    labels = np.zeros((8, 10), np.uint32)
    labels[1:7, 2:8] = 7
    original = labels.copy()
    calls = 0

    def cancel():
        nonlocal calls
        calls += 1
        if calls == stop_at:
            raise InterruptedError("cancelled exact morphology call")

    with pytest.raises(InterruptedError, match="cancelled"):
        measure_morphometrics(labels, Geometry.diagonal((2, 3)), check=cancel)
    assert calls == stop_at
    np.testing.assert_array_equal(labels, original)
