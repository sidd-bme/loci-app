import numpy as np
import pytest
from scipy import ndimage as ndi

from loci_engine.quantitative import Geometry
from loci_engine.temporal import (
    Detection,
    TimeFrame,
    TrackEdge,
    TrackingEditor,
    TrackingGraph,
    estimate_translation,
    resample_registered,
    track_detections,
    trajectories,
    validate_track_graph,
)


def _spot(shape=(64, 64)):
    values = np.zeros(shape, dtype=np.float64)
    values[15:23, 29:39] = 1
    values[40:47, 7:16] = 0.6
    return ndi.gaussian_filter(values, 1.2)


def test_integer_and_subpixel_2d_translation_are_explicit_derived_outputs():
    reference = _spot()
    moving = ndi.shift(reference, (3.0, -4.0), order=1, mode="constant")
    before = moving.copy()
    result = estimate_translation(reference, moving, Geometry.diagonal((2, 3), "um"))
    np.testing.assert_allclose(result.moving_to_reference_shift_index, (-3, 4), atol=0.05)
    np.testing.assert_allclose(result.moving_to_reference_shift_world, (12, -6, 0), atol=0.1)
    derived = resample_registered(moving, Geometry.diagonal((2, 3), "um"), result)
    assert derived.measurement_basis == "registered_derived"
    assert result.boundary_mode == "constant" and result.boundary_value == 0.0
    np.testing.assert_array_equal(moving, before)
    assert np.corrcoef(reference.ravel(), derived.values.ravel())[0, 1] > 0.98
    shifted = ndi.shift(reference, (2.25, -1.75), order=1, mode="constant")
    subpixel = estimate_translation(reference, shifted, Geometry.diagonal((1, 1)))
    np.testing.assert_allclose(subpixel.moving_to_reference_shift_index, (-2.25, 1.75), atol=0.2)


def test_anisotropic_3d_transform_sign_and_axis_order():
    reference = np.zeros((20, 48, 52), dtype=np.float64)
    reference[4:9, 12:19, 25:34] = 1
    reference[11:16, 30:39, 7:15] = 0.5
    reference = ndi.gaussian_filter(reference, 1.0)
    moving = ndi.shift(reference, (2, -3, 4), order=1, mode="constant")
    geometry = Geometry.diagonal((5, 2, 0.5), "um")
    result = estimate_translation(reference, moving, geometry)
    np.testing.assert_allclose(result.moving_to_reference_shift_index, (-2, 3, -4), atol=0.1)
    # ZYX shift -> XYZ index shift -4, 3, -2; geometry uses X,Y,Z columns.
    np.testing.assert_allclose(result.moving_to_reference_shift_world, (-2, 6, -10), atol=0.2)


def test_registration_rejects_constant_nan_wrong_grid_and_memory():
    geometry = Geometry.diagonal((1, 1))
    with pytest.raises(ValueError, match="Constant"):
        estimate_translation(np.ones((8, 8)), np.ones((8, 8)), geometry)
    with pytest.raises(ValueError, match="Non-finite"):
        estimate_translation(_spot(), np.full((64, 64), np.nan), geometry)
    with pytest.raises(ValueError, match="same declared grid"):
        estimate_translation(_spot(), _spot((32, 32)), geometry)
    with pytest.raises(ValueError, match="working-memory"):
        estimate_translation(_spot(), _spot(), geometry, working_bytes=1024)
    periodic = (np.indices((64, 64)).sum(axis=0) % 2 == 0).astype(np.float64)
    with pytest.raises(ValueError, match="ambiguous"):
        estimate_translation(periodic, np.roll(periodic, (2, 2), axis=(0, 1)), geometry)


def test_label_resampling_is_nearest_only_and_never_makes_ids():
    source = np.zeros((16, 16), dtype=np.uint16)
    source[4:10, 5:11] = 7
    intensity = np.zeros((16, 16), dtype=np.float64)
    intensity[3:7, 4:9] = 1
    intensity[10:13, 10:15] = 0.5
    intensity = ndi.gaussian_filter(intensity, 0.7)
    registration = estimate_translation(
        intensity, ndi.shift(intensity, (1, 1)), Geometry.diagonal((1, 1))
    )
    labels = resample_registered(source, Geometry.diagonal((1, 1)), registration, labels=True)
    assert labels.values.dtype == np.uint16
    assert set(np.unique(labels.values)) <= {0, 7}
    with pytest.raises(ValueError, match="resampling grid"):
        resample_registered(source[:8], Geometry.diagonal((1, 1)), registration, labels=True)


def _frame(frame_id, time_s, *points):
    return TimeFrame(
        frame_id, time_s, tuple(Detection(label, xyz, measure) for label, xyz, measure in points)
    )


def test_tracking_crossing_ambiguity_missing_frames_and_observed_trajectory_metrics():
    frames = (
        _frame("t0", 0, ("a", (0, 0, 0), 1), ("b", (2, 0, 0), 1)),
        _frame("t1", 1, ("c", (1, 0, 0), 1), ("d", (1, 0, 0), 1)),
        _frame("t2", 2),
        _frame("t3", 3, ("e", (3, 0, 0), 2)),
    )
    graph = track_detections(frames, max_distance=2, max_gap_frames=1, ambiguity_distance=0.01)
    assert len(graph.edges) == 3  # one-to-one assignment; no inferred split/merge edge
    assert any(h.kind == "ambiguous" for h in graph.hypotheses)
    # The empty t2 is explicit, and cannot create a fake t2 measurement.
    observations = trajectories(graph)
    assert all(o.frame_id != "t2" for track in observations for o in track)
    assert any(edge.gap == 1 for edge in graph.edges)


def test_tracking_records_exact_split_and_merge_candidates_without_branching_edges():
    frames = (
        _frame("t0", 0, ("a", (0, 0, 0), 1)),
        _frame("t1", 4, ("b", (-1, 0, 0), 1), ("c", (1, 0, 0), 1)),
        _frame("t2", 8, ("d", (0, 0, 0), 1)),
    )
    graph = track_detections(
        frames,
        max_distance=2,
        max_gap_frames=0,
        ambiguity_distance=0.01,
    )

    split_candidates = [
        hypothesis
        for hypothesis in graph.hypotheses
        if hypothesis.kind == "split_or_merge"
        and hypothesis.reason == "one source has multiple plausible targets"
    ]
    merge_candidates = [
        hypothesis
        for hypothesis in graph.hypotheses
        if hypothesis.kind == "split_or_merge"
        and hypothesis.reason == "one target has multiple plausible sources"
    ]
    assert [
        (item.frame_id, item.label, item.candidate_frame_id, item.candidate_labels)
        for item in split_candidates
    ] == [("t0", "a", "t1", ("b", "c"))]
    assert [
        (item.frame_id, item.label, item.candidate_frame_id, item.candidate_labels)
        for item in merge_candidates
    ] == [("t2", "d", "t1", ("b", "c"))]
    assert len(graph.edges) == 2
    assert len({(edge.source_frame_id, edge.source_label) for edge in graph.edges}) == 2
    assert len({(edge.target_frame_id, edge.target_label) for edge in graph.edges}) == 2
    validate_track_graph(graph)


def test_manual_edges_are_forward_one_to_one_and_undo_redo_preserve_records():
    frames = (_frame("one", 0, ("a", (0, 0, 0), None)), _frame("two", 1, ("b", (1, 0, 0), None)))
    editor = TrackingEditor(TrackingGraph(frames, ()))
    edge = TrackEdge("one", "a", "two", "b", 1.0, 0, False)
    editor.add_edge(edge)
    assert editor.graph.edges[0].provenance == "manual"
    editor.undo()
    assert not editor.graph.edges
    editor.redo()
    assert len(editor.graph.edges) == 1 and len(editor.corrections) == 1
    with pytest.raises(ValueError, match="one-to-one"):
        editor.add_edge(edge)
    backward = TrackingGraph(frames, (TrackEdge("two", "b", "one", "a", 1, 0, False),))
    with pytest.raises(ValueError, match="forward time"):
        validate_track_graph(backward)


def test_trajectory_metrics_follow_real_observations_without_measurement_invention():
    frames = (
        _frame("t0", 0, ("a", (0, 0, 0), 3)),
        _frame("t1", 2, ("b", (3, 4, 0), 7)),
    )
    graph = TrackingGraph(frames, (TrackEdge("t0", "a", "t1", "b", 5, 0, False),))
    track = trajectories(graph)[0]
    assert [point.measure for point in track] == [3, 7]
    assert track[1].displacement == 5 and track[1].path_length == 5 and track[1].speed == 2.5


def test_tracking_can_bridge_one_occluded_object_while_others_remain_visible():
    frames = (
        _frame("t0", 0, ("a", (0, 0, 0), 1), ("b", (100, 0, 0), 1)),
        _frame("t1", 1, ("c", (1, 0, 0), 1)),
        _frame("t2", 2, ("d", (2, 0, 0), 1), ("e", (101, 0, 0), 1)),
    )
    graph = track_detections(frames, max_distance=3, max_gap_frames=1)
    assert any(
        edge.source_label == "b" and edge.target_label == "e" and edge.gap == 1
        for edge in graph.edges
    )
    validate_track_graph(graph)


def test_tracking_rejects_an_unbounded_pair_matrix_before_allocating():
    detections = tuple(Detection(str(i), (i, 0, 0)) for i in range(1001))
    with pytest.raises(ValueError, match="memory budget"):
        track_detections(
            (TimeFrame("first", 0, detections), TimeFrame("second", 1, detections)), max_distance=3
        )


def test_integer_intensity_registration_retains_fractional_interpolation():
    from dataclasses import replace

    import numpy as np

    from loci_engine.quantitative import Geometry
    from loci_engine.temporal import RegistrationResult, resample_registered

    moving = np.zeros((4, 4), dtype=np.uint16)
    moving[:, 1] = 1
    registration = RegistrationResult(
        axes="YX",
        reference_shape=(4, 4),
        moving_to_reference_shift_index=(0.0, 0.5),
        moving_to_reference_shift_world=(0.5, 0.0, 0.0),
        phase_error=0.0,
        phase_difference=0.0,
        normalized_correlation=1.0,
        overlap_fraction=0.75,
        boundary_mode="constant",
        boundary_value=0.0,
        interpolation="linear",
        confidence="accepted",
    )
    derived = resample_registered(moving, Geometry.diagonal((1.0, 1.0)), registration)
    assert derived.values[1, 1] == 0.5
    assert derived.values[1, 2] == 0.5
    labels = resample_registered(
        moving,
        Geometry.diagonal((1.0, 1.0)),
        replace(registration, interpolation="nearest"),
        labels=True,
    )
    assert labels.values.dtype == np.uint16
    assert set(np.unique(labels.values)) == {0, 1}
