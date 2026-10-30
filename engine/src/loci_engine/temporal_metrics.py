"""Observed-trajectory kinematics; no interpolation or inferred cell identity.

Directionality is endpoint displacement / observed chord path length. It is not
a fitted persistence time. Coordinates and seconds come from the exact retained
tracking graph; upstream registration changes coordinates, not source pixels.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import asdict

from .research_project import canonical_json
from .temporal import TrackingGraph, validate_track_graph

SCHEMA = "loci.trajectory-metrics/v1"
MAX_OBSERVATIONS = 100_000
MAX_RECORD_BYTES = 64 * 1024**2
RULES = {
    "coordinates": "Exact retained world XYZ coordinates, including declared registration",
    "time": "Actual supplied seconds; no frame-rate inference",
    "velocity": "XYZ displacement divided by elapsed seconds between observed endpoints",
    "speed": "Observed chord length divided by elapsed seconds between its endpoints",
    "mean_speed": "Sum of observed chord lengths divided by first-to-last elapsed seconds",
    "directionality": "Net endpoint displacement divided by summed observed chord lengths",
    "gaps": "Missing frames are never interpolated; gap-spanning chords are explicitly flagged",
    "interpretation": (
        "Observed associations; directionality is not persistence time or biological identity"
    ),
}


def _finite(value, name):
    if not math.isfinite(value):
        raise ValueError(f"Trajectory {name} exceeds finite numerical range")
    return value


def measure_trajectories(graph: TrackingGraph, position_unit: str) -> dict:
    """Return stable, source-graph-bound observation intervals and track summaries."""
    if type(graph) is not TrackingGraph:
        raise ValueError("Trajectory metrics require an exact tracking graph")
    if position_unit not in {"pixel", "nm", "um", "mm", "m"}:
        raise ValueError("Trajectory position unit must be explicit")
    count = sum(len(frame.detections) for frame in graph.frames)
    if not 1 <= len(graph.frames) <= 1000 or count > MAX_OBSERVATIONS:
        raise ValueError("Trajectory metrics exceed the bounded observation/frame limit")
    validate_track_graph(graph)
    graph_json = canonical_json(asdict(graph))
    if len(graph_json.encode()) > MAX_RECORD_BYTES:
        raise ValueError("Trajectory graph exceeds the bounded record size")
    nodes = {
        (frame.frame_id, d.label): (
            float(frame.time_s),
            tuple(float(v) for v in d.centroid_world_xyz),
        )
        for frame in graph.frames
        for d in frame.detections
    }
    incoming = {(e.target_frame_id, e.target_label): e for e in graph.edges}
    outgoing = {(e.source_frame_id, e.source_label): e for e in graph.edges}
    # A retained hypothesis remains visible even if it did not produce an edge.
    hypotheses = {}
    for index, h in enumerate(graph.hypotheses):
        keys = {
            (h.frame_id, h.label),
            *((h.candidate_frame_id, label) for label in h.candidate_labels),
        }
        for key in keys:
            if key in nodes:
                hypotheses.setdefault(key, set()).add(index)
    summaries, intervals = [], []
    for start in sorted(node for node in nodes if node not in incoming):
        track_key = canonical_json(list(start))
        current = start
        t0, p0 = nodes[start]
        steps, gap_count, uncertain_count, observations = [], 0, 0, 1
        hypothesis_indices = set(hypotheses.get(start, ()))
        while current in outgoing:
            edge = outgoing[current]
            target = (edge.target_frame_id, edge.target_label)
            t1, p1 = nodes[current]
            t2, p2 = nodes[target]
            elapsed = _finite(t2 - t1, "elapsed seconds")
            if elapsed <= 0:
                raise ValueError("Trajectory seconds must increase strictly")
            displacement = [_finite(b - a, "XYZ displacement") for a, b in zip(p1, p2, strict=True)]
            chord = _finite(math.hypot(*displacement), "chord length")
            velocity = [_finite(value / elapsed, "XYZ velocity") for value in displacement]
            speed = _finite(chord / elapsed, "speed")
            intervals.append(
                {
                    "track_key": track_key,
                    "source_frame_id": current[0],
                    "source_label": current[1],
                    "target_frame_id": target[0],
                    "target_label": target[1],
                    "start_time_s": t1,
                    "end_time_s": t2,
                    "elapsed_s": elapsed,
                    "displacement_xyz": displacement,
                    "chord_length": chord,
                    "velocity_xyz": velocity,
                    "speed": speed,
                    "gap_frames": edge.gap,
                    "identity_uncertain": edge.identity_uncertain,
                    "association_provenance": edge.provenance,
                    "sampling": "gap-spanning-observed-endpoints"
                    if edge.gap
                    else "adjacent-observed-endpoints",
                }
            )
            steps.append(chord)
            gap_count += edge.gap
            uncertain_count += int(edge.identity_uncertain)
            hypothesis_indices.update(hypotheses.get(target, ()))
            observations += 1
            current = target
        end_time, endpoint = nodes[current]
        elapsed = _finite(end_time - t0, "track elapsed seconds")
        vector = [_finite(b - a, "net XYZ displacement") for a, b in zip(p0, endpoint, strict=True)]
        displacement = _finite(math.hypot(*vector), "net displacement")
        try:
            length = _finite(math.fsum(steps), "path length")
        except OverflowError as exc:
            raise ValueError("Trajectory path length exceeds finite numerical range") from exc
        # Triangle inequality can differ by a handful of floating-point ulps.
        # Bound only this documented numerical error; never repair a larger mismatch.
        ratio = displacement / length if length > 0 else None
        if ratio is not None and ratio > 1:
            if ratio > 1 + 8 * math.ulp(1.0):
                raise ValueError("Trajectory displacement exceeds its observed path length")
            ratio = 1.0
        summaries.append(
            {
                "track_key": track_key,
                "start_frame_id": start[0],
                "start_label": start[1],
                "end_frame_id": current[0],
                "end_label": current[1],
                "observation_count": observations,
                "interval_count": len(steps),
                "start_time_s": t0,
                "end_time_s": end_time,
                "elapsed_s": elapsed,
                "net_displacement_xyz": vector,
                "net_displacement": displacement,
                "observed_path_length": length,
                "mean_velocity_xyz": [_finite(v / elapsed, "mean XYZ velocity") for v in vector]
                if elapsed
                else None,
                "mean_speed": _finite(length / elapsed, "mean speed") if elapsed else None,
                "rate_status": "defined" if elapsed else "single-observation",
                "directionality_ratio": ratio,
                "directionality_status": "defined"
                if ratio is not None
                else "single-observation"
                if not steps
                else "stationary",
                "gap_frames": gap_count,
                "uncertain_edge_count": uncertain_count,
                "hypothesis_indices": sorted(hypothesis_indices),
                "sampling": "contains-observation-gaps" if gap_count else "observed-adjacent-links",
            }
        )
    result = {
        "schema": SCHEMA,
        "graph_sha256": hashlib.sha256(graph_json.encode()).hexdigest(),
        "units": {
            "position": position_unit,
            "time": "s",
            "velocity": position_unit + "/s",
            "directionality": "dimensionless",
        },
        "rules": dict(RULES),
        "tracks": summaries,
        "intervals": intervals,
        "observation_count": count,
        "numerical_policy": (
            "Float64 arithmetic; directionality overshoot at most 8 ulps at 1 is clipped to 1"
        ),
    }
    if len(canonical_json(result).encode()) > MAX_RECORD_BYTES:
        raise ValueError("Trajectory metrics exceed the bounded record size")
    return result
