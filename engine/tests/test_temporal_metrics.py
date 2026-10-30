import copy
import math

import pytest

from loci_engine.temporal import Detection, TimeFrame, TrackEdge, TrackingGraph, TrackingHypothesis
from loci_engine.temporal_metrics import measure_trajectories


def graph(points, times, *, gap=False, uncertain=False):
    frames = tuple(
        TimeFrame(f"f{i}", t, (Detection("object", p),) if p is not None else ())
        for i, (p, t) in enumerate(zip(points, times, strict=True))
    )
    observed = [(i, p) for i, p in enumerate(points) if p is not None]
    edges = tuple(
        TrackEdge(f"f{i}", "object", f"f{j}", "object", math.dist(a, b), j - i - 1, uncertain)
        for (i, a), (j, b) in zip(observed, observed[1:], strict=False)
        if gap or j == i + 1
    )
    return TrackingGraph(frames, edges)


def test_actual_seconds_xyz_velocity_and_time_weighted_speed():
    g = graph([(0, 0, 0), (3, 4, 0), (3, 4, 12)], [0, 2, 8])
    original = copy.deepcopy(g)
    result = measure_trajectories(g, "um")
    assert g == original
    track = result["tracks"][0]
    assert track["net_displacement_xyz"] == [3, 4, 12]
    assert track["net_displacement"] == 13
    assert track["observed_path_length"] == 17
    assert track["mean_speed"] == 17 / 8
    assert track["mean_velocity_xyz"] == [3 / 8, 4 / 8, 12 / 8]
    assert track["directionality_ratio"] == 13 / 17
    assert result["intervals"][0]["velocity_xyz"] == [1.5, 2, 0]
    assert result["intervals"][1]["velocity_xyz"] == [0, 0, 2]
    assert result["units"]["velocity"] == "um/s"
    assert measure_trajectories(g, "um") == result


def test_missing_slots_are_flagged_without_interpolation_or_frame_rate_inference():
    g = graph([(0, 0, 0), None, (8, 0, 0)], [0, 1, 4], gap=True, uncertain=True)
    result = measure_trajectories(g, "pixel")
    assert result["observation_count"] == 2 and len(result["intervals"]) == 1
    step = result["intervals"][0]
    assert step["velocity_xyz"] == [2, 0, 0]
    assert step["gap_frames"] == 1 and step["sampling"] == "gap-spanning-observed-endpoints"
    track = result["tracks"][0]
    assert track["directionality_ratio"] == 1
    assert track["gap_frames"] == 1 and track["uncertain_edge_count"] == 1
    assert track["sampling"] == "contains-observation-gaps"


def test_singleton_stationary_and_return_to_origin_are_distinct():
    singleton = measure_trajectories(graph([(3, 4, 5)], [12]), "nm")["tracks"][0]
    assert singleton["mean_speed"] is None and singleton["mean_velocity_xyz"] is None
    assert (
        singleton["directionality_ratio"] is None
        and singleton["rate_status"] == "single-observation"
    )
    stationary = measure_trajectories(graph([(3, 4, 5), (3, 4, 5)], [12, 15]), "nm")["tracks"][0]
    assert stationary["mean_speed"] == 0 and stationary["mean_velocity_xyz"] == [0, 0, 0]
    assert (
        stationary["directionality_ratio"] is None
        and stationary["directionality_status"] == "stationary"
    )
    returning = measure_trajectories(graph([(0, 0, 0), (3, 0, 0), (0, 0, 0)], [0, 1, 2]), "mm")[
        "tracks"
    ][0]
    assert returning["directionality_ratio"] == 0 and returning["mean_speed"] == 3


def test_unlinked_observations_and_hypotheses_are_not_fabricated_tracks():
    g = graph([(0, 0, 0), None, (2, 0, 0)], [0, 1, 2])
    g = TrackingGraph(
        g.frames,
        g.edges,
        (TrackingHypothesis("ambiguous", "f0", "object", "f2", ("object",), "Ambiguous example"),),
    )
    result = measure_trajectories(g, "um")
    assert len(result["tracks"]) == 2 and result["intervals"] == []
    assert all(t["hypothesis_indices"] == [0] for t in result["tracks"])


def test_changed_observation_changes_graph_identity_and_units_remain_explicit():
    a = measure_trajectories(graph([(0, 0, 0), (1, 0, 0)], [0, 1]), "pixel")
    b = measure_trajectories(graph([(0, 0, 0), (2, 0, 0)], [0, 1]), "pixel")
    assert a["graph_sha256"] != b["graph_sha256"]
    with pytest.raises(ValueError, match="unit"):
        measure_trajectories(graph([(0, 0, 0)], [0]), "unknown")


def test_tiny_elapsed_overflow_is_refused_instead_of_publishing_infinity():
    with pytest.raises(ValueError, match="finite"):
        measure_trajectories(graph([(0, 0, 0), (1, 0, 0)], [0, 5e-324]), "um")


def test_empty_observed_graph_retains_zero_counts():
    result = measure_trajectories(TrackingGraph((TimeFrame("missing", 0, ()),), ()), "um")
    assert result["observation_count"] == 0 and result["tracks"] == [] and result["intervals"] == []


def test_full_supported_thousand_frame_path_has_no_recursive_depth_limit():
    g = graph([(float(i), 0, 0) for i in range(1000)], list(range(1000)))
    result = measure_trajectories(g, "um")
    assert len(result["tracks"]) == 1 and len(result["intervals"]) == 999
    assert result["tracks"][0]["directionality_ratio"] == 1
    assert result["tracks"][0]["mean_speed"] == 1
