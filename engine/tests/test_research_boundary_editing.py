import numpy as np
import pytest
from skimage.draw import polygon2mask

from loci_engine.quantitative import Geometry
from loci_engine.research_annotations import AnnotationError, label_array_sha256
from loci_engine.research_boundary_editing import (
    editable_instance_boundary,
    move_boundary_vertex,
)


def _mask(vertices, shape):
    return polygon2mask(
        shape,
        np.asarray([[point["v"], point["u"]] for point in vertices], dtype=np.float64),
    )


def _outward_edit(vertices, shape):
    edited = [dict(point) for point in vertices]
    position = min(
        range(len(edited)),
        key=lambda item: float(edited[item]["u"]) + float(edited[item]["v"]),
    )
    edited[position] = {
        "u": max(0.0, float(edited[position]["u"]) - 1.0),
        "v": max(0.0, float(edited[position]["v"]) - 1.0),
    }
    return edited, position


def test_boundary_reports_exact_plane_axes_and_full_precision_world_coordinates():
    labels = np.zeros((5, 9, 12), dtype=np.uint32)
    labels[1:4, 2:7, 3:10] = 7
    geometry = Geometry.diagonal((2.0, 0.5, 0.25), "um")

    boundary = editable_instance_boundary(labels, geometry, plane="XZ", index=4, label=7)

    assert boundary["plane_axes_uv"] == ["X", "Z"]
    assert boundary["distance_unit"] == "um"
    assert 3 <= len(boundary["vertices_uv"]) <= 96
    first = boundary["vertices_uv"][0]
    expected = geometry.world(np.asarray([[first["v"], 4, first["u"]]], dtype=np.float64))[0]
    np.testing.assert_array_equal(boundary["world_vertices_xyz"][0], expected)


def test_vertex_move_changes_only_polygon_delta_and_preserves_hole_and_input():
    labels = np.zeros((32, 36), dtype=np.uint32)
    labels[5:27, 6:30] = 4
    labels[12:20, 14:22] = 0
    original = labels.copy()
    geometry = Geometry.diagonal((0.8, 0.3), "um")
    boundary = editable_instance_boundary(labels, geometry, plane="XY", index=0, label=4)
    source = boundary["vertices_uv"]
    edited, moved_index = _outward_edit(source, labels.shape)
    expected_hash = label_array_sha256(labels)

    corrected, audit = move_boundary_vertex(
        labels,
        geometry,
        {
            "op": "move_boundary_vertex",
            "expected_input_sha256": expected_hash,
            "plane": "XY",
            "index": 0,
            "label": 4,
            "source_vertices": source,
            "vertices": edited,
        },
    )

    delta = _mask(source, labels.shape) ^ _mask(edited, labels.shape)
    np.testing.assert_array_equal(corrected[~delta], original[~delta])
    assert not corrected[12:20, 14:22].any()
    assert np.array_equal(labels, original)
    assert not corrected.flags.writeable
    record = audit["operations"][0]
    assert record["op"] == "move_boundary_vertex"
    assert record["moved_vertex_index"] == moved_index
    assert record["changed_voxels"] > 0
    assert (
        record["source_vertex_world_xyz"]
        == geometry.world(np.asarray([[source[moved_index]["v"], source[moved_index]["u"]]]))[
            0
        ].tolist()
    )
    assert (
        record["destination_vertex_world_xyz"]
        == geometry.world(np.asarray([[edited[moved_index]["v"], edited[moved_index]["u"]]]))[
            0
        ].tolist()
    )


def test_vertex_move_rejects_stale_source_multiple_handles_and_label_collision():
    labels = np.zeros((28, 34), dtype=np.uint32)
    labels[8:21, 8:20] = 3
    labels[8:21, 22:30] = 9
    geometry = Geometry.diagonal((1.0, 1.0))
    boundary = editable_instance_boundary(labels, geometry, plane="XY", index=0, label=3)
    source = boundary["vertices_uv"]
    edited, position = _outward_edit(source, labels.shape)
    operation = {
        "op": "move_boundary_vertex",
        "expected_input_sha256": label_array_sha256(labels),
        "plane": "XY",
        "index": 0,
        "label": 3,
        "source_vertices": source,
        "vertices": edited,
    }
    multiple = [dict(point) for point in edited]
    other = (position + 1) % len(multiple)
    multiple[other]["u"] = max(0.0, float(multiple[other]["u"]) - 1.0)
    with pytest.raises(AnnotationError, match="exactly one vertex"):
        move_boundary_vertex(labels, geometry, {**operation, "vertices": multiple})
    stale = [dict(point) for point in source]
    stale[0]["u"] = float(stale[0]["u"]) + 0.25
    with pytest.raises(AnnotationError, match="do not match"):
        move_boundary_vertex(labels, geometry, {**operation, "source_vertices": stale})
    toward_other = [dict(point) for point in source]
    right = max(range(len(toward_other)), key=lambda item: float(toward_other[item]["u"]))
    toward_other[right]["u"] = 24.0
    with pytest.raises(AnnotationError, match="unrelated label"):
        move_boundary_vertex(labels, geometry, {**operation, "vertices": toward_other})
    np.testing.assert_array_equal(labels[8:21, 22:30], 9)
