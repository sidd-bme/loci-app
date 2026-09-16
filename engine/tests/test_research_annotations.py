from __future__ import annotations

import copy
import hashlib
import json

import numpy as np
import pytest
from roifile import ImagejRoi

import loci_engine.research_annotations as annotation_module
from loci_engine.quantitative import Geometry
from loci_engine.research_annotations import (
    AnnotationError,
    correct_labels,
    create_polygon_roi,
    geometry_sha256,
    label_array_sha256,
    measure_polygon_roi,
    roi_from_geojson,
    roi_from_imagej,
    roi_to_geojson,
    roi_to_imagej,
)

SOURCE = "1" * 64
RESULT = "2" * 64


def _geometry_3d() -> Geometry:
    return Geometry.diagonal((5.0, 2.0, 1.0), "um")


def _op(labels: np.ndarray, **values: object) -> dict[str, object]:
    return {"expected_input_sha256": label_array_sha256(labels), **values}


def _points(*values: tuple[float, float]) -> list[dict[str, float]]:
    return [{"u": float(u), "v": float(v)} for u, v in values]


def test_physical_xy_brush_uses_uv_axis_order_and_anisotropic_radius() -> None:
    labels = np.zeros((3, 7, 9), dtype=np.uint32)
    original = labels.tobytes()
    corrected, record = correct_labels(
        labels,
        _geometry_3d(),
        [
            _op(
                labels,
                op="brush",
                mode="paint",
                plane="XY",
                index=1,
                points=_points((4, 3)),
                radius=1.1,
                label=4_000_000_000,
            )
        ],
    )

    expected = np.zeros_like(labels)
    expected[1, 3, 3:6] = 4_000_000_000
    np.testing.assert_array_equal(corrected, expected)
    assert labels.tobytes() == original
    assert corrected.dtype == np.uint32
    assert not corrected.flags.writeable
    assert record["operations"][0]["plane_axes_uv"] == ["X", "Y"]
    assert record["operations"][0]["radius_unit"] == "um"
    assert record["operations"][0]["changed_voxels"] == 3
    assert record["input_mutation"] == "none-derived-copy"


@pytest.mark.parametrize(
    ("plane", "index", "point", "expected_indices", "axes"),
    [
        ("XZ", 2, (4, 1), [(0, 2, 4), (1, 2, 4), (2, 2, 4)], ["X", "Z"]),
        ("YZ", 4, (2, 1), [(0, 2, 4), (1, 2, 4), (2, 2, 4)], ["Y", "Z"]),
    ],
)
def test_orthogonal_plane_brush_axis_mapping(
    plane: str,
    index: int,
    point: tuple[float, float],
    expected_indices: list[tuple[int, int, int]],
    axes: list[str],
) -> None:
    labels = np.zeros((4, 6, 8), dtype=np.uint32)
    # Z spacing is 5, so radius 5.1 spans one Z neighbor but not a second.
    corrected, record = correct_labels(
        labels,
        _geometry_3d(),
        [
            _op(
                labels,
                op="brush",
                mode="paint",
                plane=plane,
                index=index,
                points=_points(point),
                radius=5.1,
                label=17,
            )
        ],
    )
    for location in expected_indices:
        assert corrected[location] == 17
    assert record["operations"][0]["plane_axes_uv"] == axes
    # The brush is confined to exactly one orthogonal plane.
    if plane == "XZ":
        assert np.all(corrected[:, :index, :] == 0)
        assert np.all(corrected[:, index + 1 :, :] == 0)
    else:
        assert np.all(corrected[:, :, :index] == 0)
        assert np.all(corrected[:, :, index + 1 :] == 0)


def test_brush_collision_and_erase_are_explicit_and_failure_isolated() -> None:
    labels = np.zeros((9, 9), dtype=np.uint32)
    labels[4, 3] = 7
    labels[4, 5] = 8
    before = labels.copy()
    collision = _op(
        labels,
        op="brush",
        mode="paint",
        plane="XY",
        index=0,
        points=_points((4, 4)),
        radius=1.1,
        label=7,
    )
    with pytest.raises(AnnotationError, match="unrelated labels"):
        correct_labels(labels, Geometry.diagonal((1, 1)), [collision])
    np.testing.assert_array_equal(labels, before)

    erase_labels = np.zeros((9, 9), dtype=np.uint32)
    erase_labels[3:6, 3:6] = 7
    erased, record = correct_labels(
        erase_labels,
        Geometry.diagonal((1, 1)),
        [
            _op(
                erase_labels,
                op="brush",
                mode="erase",
                plane="XY",
                index=0,
                points=_points((4, 4)),
                radius=1,
                label=7,
            )
        ],
    )
    assert erased[4, 4] == 0
    assert np.count_nonzero(erased == 7) == 4
    assert record["operations"][0]["changed_voxels"] == 5


def test_polygon_add_and_selected_boundary_replace_preserve_other_labels() -> None:
    labels = np.zeros((12, 12), dtype=np.uint32)
    labels[2:5, 2:5] = 20
    labels[8:10, 8:10] = 4_000_000_000
    add = _op(
        labels,
        op="polygon_add",
        plane="XY",
        index=0,
        points=_points((5, 5), (7, 5), (7, 7), (5, 7)),
        label=3_000_000_000,
    )
    added, _ = correct_labels(labels, Geometry.diagonal((1, 1)), [add])
    assert np.count_nonzero(added == 3_000_000_000) == 9
    np.testing.assert_array_equal(added[8:10, 8:10], labels[8:10, 8:10])

    replace = _op(
        added,
        op="polygon_replace",
        plane="XY",
        index=0,
        points=_points((1, 1), (5, 1), (5, 4), (1, 4)),
        label=20,
    )
    replaced, record = correct_labels(added, Geometry.diagonal((1, 1)), [replace])
    assert np.count_nonzero(replaced == 20) == 20
    assert record["operations"][0]["changed_voxels"] == 11
    np.testing.assert_array_equal(replaced[8:10, 8:10], labels[8:10, 8:10])


def test_polygon_rejects_self_crossing_collision_and_ambiguous_target() -> None:
    geometry = Geometry.diagonal((1, 1))
    labels = np.zeros((10, 10), dtype=np.uint32)
    labels[2:4, 2:4] = 5
    labels[6:8, 6:8] = 5
    labels[4, 4] = 9
    crossing = _op(
        labels,
        op="polygon_add",
        plane="XY",
        index=0,
        points=_points((1, 1), (7, 7), (1, 7), (7, 1)),
        label=10,
    )
    with pytest.raises(AnnotationError, match="self-intersect"):
        correct_labels(labels, geometry, [crossing])
    collision = _op(
        labels,
        op="polygon_add",
        plane="XY",
        index=0,
        points=_points((3, 3), (5, 3), (5, 5), (3, 5)),
        label=10,
    )
    with pytest.raises(AnnotationError, match="overwrite"):
        correct_labels(labels, geometry, [collision])
    ambiguous = _op(
        labels,
        op="polygon_replace",
        plane="XY",
        index=0,
        points=_points((1, 1), (4, 1), (4, 4), (1, 4)),
        label=5,
    )
    with pytest.raises(AnnotationError, match="multiple plane components"):
        correct_labels(labels, geometry, [ambiguous])


def test_whole_label_merge_delete_preserve_sparse_uint32_ids() -> None:
    labels = np.zeros((5, 7), dtype=np.uint32)
    labels[1:3, 1:3] = 17
    labels[1:3, 4:6] = 4_000_000_000
    merged, merge_record = correct_labels(
        labels,
        Geometry.diagonal((1, 1)),
        [
            _op(
                labels,
                op="merge",
                source_labels=[17, 4_000_000_000],
                target_label=4_000_000_000,
            )
        ],
    )
    assert set(np.unique(merged)) == {0, 4_000_000_000}
    assert merge_record["operations"][0]["changed_voxels"] == 4
    deleted, _ = correct_labels(
        merged,
        Geometry.diagonal((1, 1)),
        [_op(merged, op="delete", label=4_000_000_000)],
    )
    assert not np.any(deleted)


def test_two_dimensional_seeded_watershed_splits_target_only() -> None:
    labels = np.zeros((15, 19), dtype=np.uint32)
    labels[3:12, 3:16] = 4_000_000_000
    labels[0:2, 0:2] = 77
    corrected, record = correct_labels(
        labels,
        Geometry.diagonal((2, 1), "um"),
        [
            _op(
                labels,
                op="watershed_split",
                label=4_000_000_000,
                mode="2D",
                plane="XY",
                index=0,
                seeds=[{"u": 5, "v": 7}, {"u": 13, "v": 7}],
            )
        ],
    )
    allocated = record["operations"][0]["allocated_labels"]
    assert allocated == [1]
    assert corrected[7, 5] == 4_000_000_000
    assert corrected[7, 13] == 1
    np.testing.assert_array_equal(corrected[0:2, 0:2], labels[0:2, 0:2])
    assert set(np.unique(corrected)) == {0, 1, 77, 4_000_000_000}


def test_true_3d_seeded_watershed_uses_anisotropic_geometry() -> None:
    labels = np.zeros((7, 11, 13), dtype=np.uint32)
    labels[1:6, 2:9, 2:11] = 3_900_000_000
    corrected, record = correct_labels(
        labels,
        _geometry_3d(),
        [
            _op(
                labels,
                op="watershed_split",
                label=3_900_000_000,
                mode="3D",
                seeds=[{"x": 3, "y": 5, "z": 2}, {"x": 9, "y": 5, "z": 4}],
            )
        ],
    )
    assert corrected[2, 5, 3] == 3_900_000_000
    assert corrected[4, 5, 9] == 1
    assert set(np.unique(corrected)) == {0, 1, 3_900_000_000}
    operation = record["operations"][0]
    assert operation["mode"] == "3D"
    assert operation["distance_unit"] == "um"
    assert operation["connectivity"] == "face"


@pytest.mark.parametrize(
    ("seeds", "message"),
    [
        ([{"u": 3, "v": 3}], "2 through 32"),
        ([{"u": 3, "v": 3}, {"u": 3, "v": 3}], "distinct"),
        ([{"u": 3, "v": 3}, {"u": 0, "v": 0}], "inside"),
    ],
)
def test_watershed_rejects_insufficient_duplicate_and_outside_seeds(
    seeds: list[dict[str, int]], message: str
) -> None:
    labels = np.zeros((9, 9), dtype=np.uint32)
    labels[2:7, 2:7] = 8
    operation = _op(
        labels,
        op="watershed_split",
        label=8,
        mode="2D",
        plane="XY",
        index=0,
        seeds=seeds,
    )
    with pytest.raises(AnnotationError, match=message):
        correct_labels(labels, Geometry.diagonal((1, 1)), [operation])


def test_split_rejects_exhausted_configured_id_space(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    labels = np.ones((7, 7), dtype=np.uint32)
    labels[0, 0] = 2
    monkeypatch.setattr(annotation_module, "MAX_LABEL_ID", 2)
    operation = _op(
        labels,
        op="watershed_split",
        label=1,
        mode="2D",
        plane="XY",
        index=0,
        seeds=[{"u": 2, "v": 3}, {"u": 5, "v": 3}],
    )
    with pytest.raises(AnnotationError, match="No unused uint32"):
        correct_labels(labels, Geometry.diagonal((1, 1)), [operation])


def test_stale_unknown_noop_dtype_and_budget_fail_without_mutation() -> None:
    labels = np.zeros((20, 20), dtype=np.uint32)
    labels[3:6, 3:6] = 4
    before = labels.copy()
    with pytest.raises(AnnotationError, match="stale"):
        correct_labels(
            labels,
            Geometry.diagonal((1, 1)),
            [{"op": "delete", "expected_input_sha256": "0" * 64, "label": 4}],
        )
    with pytest.raises(AnnotationError, match="exactly"):
        correct_labels(
            labels,
            Geometry.diagonal((1, 1)),
            [{**_op(labels, op="delete", label=4), "surprise": True}],
        )
    with pytest.raises(AnnotationError, match="absent"):
        correct_labels(
            labels,
            Geometry.diagonal((1, 1)),
            [_op(labels, op="delete", label=99)],
        )
    with pytest.raises(AnnotationError, match="uint32"):
        correct_labels(labels.astype(np.uint16), Geometry.diagonal((1, 1)), [])
    with pytest.raises(ValueError, match="working-memory budget"):
        correct_labels(
            labels,
            Geometry.diagonal((1, 1)),
            [_op(labels, op="delete", label=4)],
            working_bytes=1024,
        )
    np.testing.assert_array_equal(labels, before)


def test_failure_after_first_operation_leaves_input_byteidentical() -> None:
    labels = np.zeros((8, 8), dtype=np.uint32)
    labels[2:5, 2:5] = 9
    first, _ = correct_labels(
        labels,
        Geometry.diagonal((1, 1)),
        [_op(labels, op="delete", label=9)],
    )
    operations = [
        _op(labels, op="delete", label=9),
        _op(first, op="delete", label=123),
    ]
    before = labels.tobytes()
    with pytest.raises(AnnotationError, match="absent"):
        correct_labels(labels, Geometry.diagonal((1, 1)), operations)
    assert labels.tobytes() == before


def _oblique_geometry() -> Geometry:
    return Geometry(
        "ZYX",
        (
            (0.0, -2.0, 0.0, 1_000_000_000.125),
            (3.0, 0.0, 0.0, -2_000_000_000.25),
            (0.0, 0.0, 5.0, 3_000_000_000.5),
            (0.0, 0.0, 0.0, 1.0),
        ),
        "um",
        "LPS",
    )


def test_roi_measurement_reports_raw_intensity_area_and_world_coordinates() -> None:
    image = np.arange(6 * 8, dtype=np.uint16).reshape(6, 8)
    geometry = Geometry.diagonal((2, 3), "um")
    roi = create_polygon_roi(
        annotation_id="roi-1",
        image_shape=image.shape,
        geometry=geometry,
        source_sha256=SOURCE,
        result_sha256=RESULT,
        source_t=2,
        source_c=4,
        plane="XY",
        plane_index=0,
        points=_points((1, 1), (4, 1), (4, 3), (1, 3)),
    )
    measured = measure_polygon_roi(image, roi, source_sha256=SOURCE, result_sha256=RESULT)
    mask = np.zeros_like(image, dtype=bool)
    mask[1:4, 1:5] = True
    values = image[mask].astype(np.float64)
    assert measured["polygon_area_index_squared"] == 6
    assert measured["polygon_area"] == 36
    assert measured["measure_kind"] == "area"
    assert measured["sampled_measure"] == 12 * 6
    assert measured["raw_intensity"]["mean"] == values.mean()
    assert measured["raw_intensity"]["basis"] == "unmodified-selected-scalar-values"
    assert measured["scientific_interpretation"] == ("descriptive-geometry-and-raw-intensity-only")


def test_anisotropic_oblique_slab_volume_and_yz_world_mapping() -> None:
    image = np.arange(5 * 7 * 9, dtype=np.float32).reshape(5, 7, 9)
    roi = create_polygon_roi(
        annotation_id="large-world",
        image_shape=image.shape,
        geometry=_oblique_geometry(),
        source_sha256=SOURCE,
        result_sha256=None,
        source_t=0,
        source_c=1,
        plane="YZ",
        plane_index=4,
        slab_start=3,
        slab_stop_exclusive=6,
        points=_points((1.25, 0.5), (5.5, 0.5), (5.5, 3.75), (1.25, 3.75)),
    )
    measured = measure_polygon_roi(image, roi, source_sha256=SOURCE, result_sha256=None)
    assert measured["measure_kind"] == "slab-volume"
    assert measured["measure_unit"] == "um^3"
    assert measured["geometric_measure"] == pytest.approx(13.8125 * 30 * 3)
    assert measured["plane_axes_uv"] == ["Y", "Z"]
    assert measured["world_frame"] == "LPS"
    assert max(abs(value) for point in measured["world_polygon_xyz"] for value in point) > 1e9


def test_single_plane_volume_distinguishes_polygon_area_from_sampled_voxel_volume() -> None:
    image = np.ones((3, 5, 6), dtype=np.uint8)
    roi = create_polygon_roi(
        annotation_id="single-plane",
        image_shape=image.shape,
        geometry=Geometry.diagonal((5, 2, 1), "um"),
        source_sha256=SOURCE,
        result_sha256=None,
        source_t=0,
        source_c=0,
        plane="XY",
        plane_index=1,
        points=_points((1, 1), (4, 1), (4, 3), (1, 3)),
    )
    measured = measure_polygon_roi(image, roi, source_sha256=SOURCE, result_sha256=None)
    assert measured["measure_kind"] == "area"
    assert measured["geometric_measure_unit"] == "um^2"
    assert measured["sampled_measure_kind"] == "voxel-volume"
    assert measured["sampled_measure_unit"] == "um^3"
    assert measured["sampled_measure"] == pytest.approx(12 * 10)


def test_roi_anchor_shape_self_crossing_and_slab_validation() -> None:
    geometry = _geometry_3d()
    kwargs = {
        "annotation_id": "roi",
        "image_shape": (4, 8, 9),
        "geometry": geometry,
        "source_sha256": SOURCE,
        "result_sha256": None,
        "source_t": 0,
        "source_c": 0,
        "plane": "XY",
        "plane_index": 1,
    }
    with pytest.raises(AnnotationError, match="self-intersect"):
        create_polygon_roi(
            **kwargs,
            points=_points((1, 1), (6, 6), (1, 6), (6, 1)),
        )
    with pytest.raises(AnnotationError, match="include plane_index"):
        create_polygon_roi(
            **kwargs,
            slab_start=2,
            slab_stop_exclusive=4,
            points=_points((1, 1), (6, 1), (6, 6), (1, 6)),
        )
    roi = create_polygon_roi(
        **kwargs,
        points=_points((1, 1), (6, 1), (6, 6), (1, 6)),
    )
    with pytest.raises(AnnotationError, match="different source"):
        measure_polygon_roi(
            np.zeros((4, 8, 9), dtype=np.uint8),
            roi,
            source_sha256="3" * 64,
            result_sha256=None,
        )


@pytest.mark.parametrize("plane", ["XY", "XZ", "YZ"])
def test_geojson_roundtrip_preserves_nonintegral_voxel_and_oblique_world_coordinates(
    plane: str,
) -> None:
    shape = (20, 2_000_005, 3_000_007)
    index = {"XY": 7, "XZ": 1_000_001, "YZ": 2_000_003}[plane]
    size_by_plane = {
        "XY": (3_000_007, 2_000_005),
        "XZ": (3_000_007, 20),
        "YZ": (2_000_005, 20),
    }[plane]
    width, height = size_by_plane
    roi = create_polygon_roi(
        annotation_id=f"geo-{plane}",
        image_shape=shape,
        geometry=_oblique_geometry(),
        source_sha256=SOURCE,
        result_sha256=RESULT,
        source_t=123,
        source_c=456,
        plane=plane,
        plane_index=index,
        points=_points(
            (width - 10.25, 1.125),
            (width - 2.5, 1.125),
            (width - 2.5, height - 2.25),
            (width - 10.25, height - 2.25),
        ),
    )
    geojson = roi_to_geojson(roi)
    restored = roi_from_geojson(json.loads(json.dumps(geojson)))
    assert restored == roi
    assert geojson["properties"]["coordinate_reference"]["geographical"] is False
    assert geojson["properties"]["coordinate_reference"]["axis_order"] == "XYZ"
    assert geojson["geometry"]["coordinates"][0][0] == (geojson["geometry"]["coordinates"][0][-1])


def test_geojson_rejects_affine_world_and_plane_tampering() -> None:
    roi = create_polygon_roi(
        annotation_id="geo",
        image_shape=(5, 8, 9),
        geometry=_oblique_geometry(),
        source_sha256=SOURCE,
        result_sha256=None,
        source_t=0,
        source_c=0,
        plane="XY",
        plane_index=2,
        points=_points((1, 1), (6, 1), (6, 5), (1, 5)),
    )
    changed_affine = copy.deepcopy(roi_to_geojson(roi))
    changed_affine["properties"]["affine_xyz_to_world"][0][3] += 1
    with pytest.raises(AnnotationError, match="geometry_sha256"):
        roi_from_geojson(changed_affine)
    changed_world = copy.deepcopy(roi_to_geojson(roi))
    changed_world["properties"]["world_polygon_xyz"][0][0] += 1
    with pytest.raises(AnnotationError, match="world coordinates"):
        roi_from_geojson(changed_world)
    changed_plane = copy.deepcopy(roi_to_geojson(roi))
    changed_plane["geometry"]["coordinates"][0][0][2] += 1
    changed_plane["geometry"]["coordinates"][0][-1][2] += 1
    with pytest.raises(AnnotationError, match="leaves its declared XY plane"):
        roi_from_geojson(changed_plane)
    changed_voxel = copy.deepcopy(roi_to_geojson(roi))
    changed_voxel["properties"]["polygon_uv"][0][0] += 1
    with pytest.raises(AnnotationError, match="polygon_uv disagrees"):
        roi_from_geojson(changed_voxel)


def test_imagej_polygon_roundtrip_preserves_czt_anchor_and_float32_tolerance() -> None:
    roi = create_polygon_roi(
        annotation_id="ij-roi",
        image_shape=(9, 200, 300),
        geometry=_oblique_geometry(),
        source_sha256=SOURCE,
        result_sha256=RESULT,
        source_t=4,
        source_c=3,
        plane="XY",
        plane_index=7,
        points=_points(
            (10.25001, 20.5),
            (100.75, 20.5),
            (100.75, 80.25),
            (10.25, 80.25),
        ),
    )
    encoded = roi_to_imagej(roi)
    binary = ImagejRoi.frombytes(encoded)
    assert (binary.c_position, binary.z_position, binary.t_position) == (4, 8, 5)
    assert binary.properties["loci_coordinate_origin"] == "zero-based-voxel-center"
    restored = roi_from_imagej(
        encoded,
        expected_source_sha256=SOURCE,
        expected_result_sha256=RESULT,
    )
    assert restored == roi
    assert geometry_sha256(restored.geometry) == geometry_sha256(roi.geometry)


def test_imagej_rejects_slab_non_xy_unrepresentable_precision_and_anchor_tampering() -> None:
    base = {
        "annotation_id": "ij",
        "image_shape": (9, 100, 120),
        "geometry": _geometry_3d(),
        "source_sha256": SOURCE,
        "result_sha256": None,
        "source_t": 0,
        "source_c": 0,
    }
    non_xy = create_polygon_roi(
        **base,
        plane="XZ",
        plane_index=2,
        points=_points((1, 1), (10, 1), (10, 6), (1, 6)),
    )
    with pytest.raises(AnnotationError, match="only one explicitly indexed XY"):
        roi_to_imagej(non_xy)
    slab = create_polygon_roi(
        **base,
        plane="XY",
        plane_index=2,
        slab_start=1,
        slab_stop_exclusive=4,
        points=_points((1, 1), (10, 1), (10, 6), (1, 6)),
    )
    with pytest.raises(AnnotationError, match="only one explicitly indexed XY"):
        roi_to_imagej(slab)
    precise = create_polygon_roi(
        **base,
        plane="XY",
        plane_index=2,
        points=_points((1.00001, 1), (10, 1), (10, 6), (1, 6)),
    )
    with pytest.raises(AnnotationError, match="float32"):
        roi_to_imagej(precise, float32_atol=1e-8)

    encoded = roi_to_imagej(
        create_polygon_roi(
            **base,
            plane="XY",
            plane_index=2,
            points=_points((1, 1), (10, 1), (10, 6), (1, 6)),
        )
    )
    with pytest.raises(AnnotationError, match="different source"):
        roi_from_imagej(encoded, expected_source_sha256="3" * 64)


def test_imagej_and_geojson_full_image_boundary_uses_half_voxel_vertices() -> None:
    roi = create_polygon_roi(
        annotation_id="full",
        image_shape=(4, 5),
        geometry=Geometry.diagonal((1, 1)),
        source_sha256=SOURCE,
        result_sha256=None,
        source_t=0,
        source_c=0,
        plane="XY",
        plane_index=0,
        points=_points((-0.5, -0.5), (4.5, -0.5), (4.5, 3.5), (-0.5, 3.5)),
    )
    measured = measure_polygon_roi(
        np.ones((4, 5), dtype=np.uint8),
        roi,
        source_sha256=SOURCE,
        result_sha256=None,
    )
    assert measured["sampled_voxel_count"] == 20
    encoded = roi_to_imagej(roi)
    np.testing.assert_allclose(
        ImagejRoi.frombytes(encoded).coordinates(), [[0, 0], [5, 0], [5, 4], [0, 4]]
    )
    assert roi_from_imagej(encoded) == roi
    assert roi_from_geojson(roi_to_geojson(roi)) == roi


def test_hashes_bind_dtype_shape_values_and_geometry_without_paths() -> None:
    labels = np.array([[0, 4_000_000_000]], dtype=np.uint32)
    assert label_array_sha256(labels) != label_array_sha256(labels.reshape(2, 1))
    changed = labels.copy()
    changed[0, 0] = 1
    assert label_array_sha256(labels) != label_array_sha256(changed)
    record_hash = geometry_sha256(_oblique_geometry())
    assert len(record_hash) == 64
    assert hashlib.sha256(bytes.fromhex(record_hash)).hexdigest() != record_hash
    integer_affine = Geometry(
        "YX",
        ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)),
    )
    floating_affine = Geometry(
        "YX",
        (
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ),
    )
    assert geometry_sha256(integer_affine) == geometry_sha256(floating_affine)
    assert "/Volumes/" not in json.dumps(
        roi_to_geojson(
            create_polygon_roi(
                annotation_id="safe",
                image_shape=(4, 5),
                geometry=Geometry.diagonal((1, 1)),
                source_sha256=SOURCE,
                result_sha256=None,
                source_t=0,
                source_c=0,
                plane="XY",
                plane_index=0,
                points=_points((0, 0), (3, 0), (3, 2), (0, 2)),
            )
        )
    )
