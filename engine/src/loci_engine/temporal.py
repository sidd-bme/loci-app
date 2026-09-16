"""Bounded time-series registration and detection tracking.

This module deliberately implements only translation drift correction and
one-to-one detection association.  It keeps raw arrays untouched, makes array
axes and world geometry explicit, and records uncertainty rather than turning
weak image evidence or a branching association into a biological claim.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

import numpy as np
from scipy import ndimage as ndi
from scipy.optimize import linear_sum_assignment
from skimage.registration import phase_cross_correlation

from .quantitative import DEFAULT_WORKING_BYTES, Geometry, finite_number, validate_array

_MAX_DETECTIONS = 100_000
_ARRAY_AXES = {2: "YX", 3: "ZYX"}


@dataclass(frozen=True)
class RegistrationResult:
    """A moving-to-reference translation; index shifts follow the array's axes."""

    axes: str
    reference_shape: tuple[int, ...]
    moving_to_reference_shift_index: tuple[float, ...]
    moving_to_reference_shift_world: tuple[float, float, float]
    phase_error: float
    phase_difference: float
    normalized_correlation: float
    overlap_fraction: float
    boundary_mode: Literal["constant"]
    boundary_value: float
    interpolation: Literal["linear", "nearest"]
    confidence: Literal["accepted", "low"]
    reason: str | None = None


@dataclass(frozen=True)
class ResampledImage:
    """A derived image on the reference grid; raw source data is never retained here."""

    values: np.ndarray
    geometry: Geometry
    source_basis: Literal["moving_raw"] = "moving_raw"
    measurement_basis: Literal["registered_derived"] = "registered_derived"


def _validate_registration_inputs(
    reference: np.ndarray, moving: np.ndarray, geometry: Geometry, working_bytes: int
) -> tuple[np.ndarray, np.ndarray]:
    ref = validate_array(
        reference, geometry=geometry, working_bytes=working_bytes, bytes_per_voxel=32
    )
    mov = validate_array(moving, geometry=geometry, working_bytes=working_bytes, bytes_per_voxel=32)
    if ref.shape != mov.shape:
        raise ValueError("Reference and moving arrays must have the same declared grid")
    if _ARRAY_AXES[ref.ndim] != geometry.axes:
        raise ValueError("Registration requires a YX or ZYX geometry matching the array")
    if np.ptp(ref) == 0 or np.ptp(mov) == 0:
        raise ValueError("Constant images cannot support a confident translation registration")
    if ref.size * 128 > working_bytes:
        raise ValueError(
            "Registration exceeds the operation working-memory budget; choose a smaller crop"
        )
    return ref, mov


def _phase_peak_ambiguous(reference: np.ndarray, moving: np.ndarray) -> bool:
    """Detect tied phase-correlation maxima away from the selected peak.

    This is intentionally a conservative guard against periodic/repeated
    structure.  It is not a substitute for domain validation.
    """
    product = np.fft.fftn(reference) * np.conj(np.fft.fftn(moving))
    magnitude = np.abs(product)
    normalized = np.divide(product, magnitude, out=np.zeros_like(product), where=magnitude > 1e-12)
    peaks = np.abs(np.fft.ifftn(normalized))
    best = np.unravel_index(int(np.argmax(peaks)), peaks.shape)
    peak = float(peaks[best])
    if not math.isfinite(peak) or peak <= 0:
        return True
    # Examine only the strongest candidates.  Avoid a Python loop over every
    # voxel, which would defeat the module's bounded-memory intent on volumes.
    flat = peaks.ravel()
    strongest = np.argpartition(flat, -min(128, flat.size))[-min(128, flat.size) :]
    for flat_index in strongest:
        index = np.unravel_index(int(flat_index), peaks.shape)
        local = all(
            min((i - b) % n, (b - i) % n) <= 1
            for i, b, n in zip(index, best, peaks.shape, strict=True)
        )
        if not local and float(peaks[index]) >= 0.995 * peak:
            return True
    return False


def estimate_translation(
    reference: np.ndarray,
    moving: np.ndarray,
    geometry: Geometry,
    *,
    upsample_factor: int = 20,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    min_normalized_correlation: float = 0.25,
) -> RegistrationResult:
    """Estimate the array-axis shift that resamples ``moving`` onto ``reference``.

    ``phase_cross_correlation`` returns the shift to apply to moving data.  The
    matching world displacement is derived through the declared affine, so YX
    and ZYX ordering is never confused with XYZ world coordinates.
    """
    if (
        not isinstance(upsample_factor, int)
        or isinstance(upsample_factor, bool)
        or not 1 <= upsample_factor <= 200
    ):
        raise ValueError("upsample_factor must be an integer from 1 to 200")
    threshold = finite_number(min_normalized_correlation, "min_normalized_correlation", -1.0, 1.0)
    ref, mov = _validate_registration_inputs(reference, moving, geometry, working_bytes)
    if _phase_peak_ambiguous(ref, mov):
        raise ValueError(
            "Registration has ambiguous phase-correlation peaks; choose a distinctive ROI"
        )
    shift, phase_error, phase_difference = phase_cross_correlation(
        ref, mov, upsample_factor=upsample_factor
    )
    shift = np.asarray(shift, dtype=np.float64)
    if not np.isfinite(shift).all() or not math.isfinite(float(phase_error)):
        raise ValueError("Registration did not produce a finite transform")
    valid = (
        ndi.shift(np.ones(ref.shape, dtype=np.float32), shift, order=0, mode="constant", cval=0)
        > 0.5
    )
    overlap = float(valid.mean())
    aligned = ndi.shift(
        mov.astype(np.float64, copy=False), shift, order=1, mode="constant", cval=0.0
    )
    if valid.sum() < 4 or np.ptp(ref[valid]) == 0 or np.ptp(aligned[valid]) == 0:
        raise ValueError("Registration overlap has insufficient varying signal")
    correlation = float(np.corrcoef(ref[valid].ravel(), aligned[valid].ravel())[0, 1])
    if not math.isfinite(correlation) or correlation < threshold:
        raise ValueError("Registration is low confidence; select a distinctive, overlapping ROI")
    # Geometry maps XYZ index offsets to world.  Arrays are YX/ZYX.
    index_xyz = shift[::-1]
    world = np.zeros(3, dtype=np.float64)
    world[:] = np.asarray(geometry.affine, dtype=np.float64)[:3, : len(index_xyz)] @ index_xyz
    return RegistrationResult(
        axes=geometry.axes,
        reference_shape=tuple(int(length) for length in ref.shape),
        moving_to_reference_shift_index=tuple(float(value) for value in shift),
        moving_to_reference_shift_world=tuple(float(value) for value in world),
        phase_error=float(phase_error),
        phase_difference=float(phase_difference),
        normalized_correlation=correlation,
        overlap_fraction=overlap,
        boundary_mode="constant",
        boundary_value=0.0,
        interpolation="linear",
        confidence="accepted",
    )


def resample_registered(
    moving: np.ndarray,
    reference_geometry: Geometry,
    registration: RegistrationResult,
    *,
    labels: bool = False,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> ResampledImage:
    """Create a derived registered image with declared linear/nearest sampling."""
    if registration.confidence != "accepted":
        raise ValueError("Only an accepted registration can be resampled")
    values = validate_array(
        moving,
        geometry=reference_geometry,
        labels=labels,
        working_bytes=working_bytes,
        bytes_per_voxel=32,
    )
    if registration.axes != reference_geometry.axes or values.shape != registration.reference_shape:
        raise ValueError("Registration axes do not match the requested resampling grid")
    order = 0 if labels else 1
    result = ndi.shift(
        values if labels else values.astype(np.float64, copy=False),
        registration.moving_to_reference_shift_index,
        order=order,
        mode="constant",
        cval=0,
        prefilter=False,
    )
    if labels:
        result = result.astype(values.dtype, copy=False)
        source_ids = np.unique(values)
        if not np.isin(np.unique(result), source_ids).all():
            raise RuntimeError("Nearest-neighbour label resampling generated an unexpected label")
    else:
        result = result.astype(np.float64, copy=False)
    return ResampledImage(result, reference_geometry)


@dataclass(frozen=True)
class Detection:
    label: str
    centroid_world_xyz: tuple[float, float, float]
    measure: float | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.label, str) or not self.label:
            raise ValueError("Detection label must be a nonempty string")
        if len(self.centroid_world_xyz) != 3 or not all(
            math.isfinite(float(v)) for v in self.centroid_world_xyz
        ):
            raise ValueError(
                "Detection centroid_world_xyz must contain three finite world coordinates"
            )
        if self.measure is not None and not math.isfinite(float(self.measure)):
            raise ValueError("Detection measure must be finite when supplied")


@dataclass(frozen=True)
class TimeFrame:
    frame_id: str
    time_s: float
    detections: tuple[Detection, ...]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.frame_id, str)
            or not self.frame_id
            or not math.isfinite(float(self.time_s))
        ):
            raise ValueError("Frames require a nonempty frame_id and finite time_s")
        if len(self.detections) > _MAX_DETECTIONS or len({d.label for d in self.detections}) != len(
            self.detections
        ):
            raise ValueError(
                "Frame detection labels must be unique and within the configured bound"
            )


@dataclass(frozen=True)
class TrackEdge:
    source_frame_id: str
    source_label: str
    target_frame_id: str
    target_label: str
    cost: float
    gap: int
    identity_uncertain: bool
    provenance: Literal["automatic", "manual"] = "automatic"


@dataclass(frozen=True)
class TrackingHypothesis:
    kind: Literal["ambiguous", "split_or_merge"]
    frame_id: str
    label: str
    candidate_frame_id: str
    candidate_labels: tuple[str, ...]
    reason: str


@dataclass(frozen=True)
class TrackingGraph:
    frames: tuple[TimeFrame, ...]
    edges: tuple[TrackEdge, ...]
    hypotheses: tuple[TrackingHypothesis, ...] = ()


def _checked_frames(frames: Sequence[TimeFrame]) -> tuple[TimeFrame, ...]:
    ordered = tuple(frames)
    if not ordered or len({f.frame_id for f in ordered}) != len(ordered):
        raise ValueError("Tracking requires uniquely identified frames")
    if any(
        later.time_s <= earlier.time_s for earlier, later in zip(ordered, ordered[1:], strict=False)
    ):
        raise ValueError("Frame time_s values must be strictly increasing")
    return ordered


def track_detections(
    frames: Sequence[TimeFrame],
    *,
    max_distance: float,
    max_gap_frames: int = 0,
    ambiguity_distance: float = 1e-9,
) -> TrackingGraph:
    """Associate explicit detection observations with distance-gated Hungarian assignment.

    Empty frames remain observations of absence.  They can be crossed only when
    ``max_gap_frames`` explicitly permits it; no coordinates or measures are
    interpolated for that gap.
    """
    ordered = _checked_frames(frames)
    limit = finite_number(max_distance, "max_distance", 0.0, 1e12)
    ambiguity = finite_number(ambiguity_distance, "ambiguity_distance", 0.0, 1e12)
    if (
        not isinstance(max_gap_frames, int)
        or isinstance(max_gap_frames, bool)
        or not 0 <= max_gap_frames <= 1000
    ):
        raise ValueError("max_gap_frames must be an integer from 0 to 1000")
    edges: list[TrackEdge] = []
    hypotheses: list[TrackingHypothesis] = []
    used_sources: set[tuple[str, str]] = set()
    used_targets: set[tuple[str, str]] = set()
    for source_index, source in enumerate(ordered[:-1]):
        if not source.detections:
            continue
        for target_index in range(
            source_index + 1, min(len(ordered), source_index + max_gap_frames + 2)
        ):
            target = ordered[target_index]
            if not target.detections:
                continue
            source_available = [
                d for d in source.detections if (source.frame_id, d.label) not in used_sources
            ]
            target_available = [
                d for d in target.detections if (target.frame_id, d.label) not in used_targets
            ]
            if not source_available:
                break
            if not target_available:
                continue
            if len(source_available) * len(target_available) > 1_000_000:
                raise ValueError(
                    "Tracking pair matrix exceeds its memory budget; subdivide the declared scope"
                )
            a = np.asarray([d.centroid_world_xyz for d in source_available], dtype=np.float64)
            b = np.asarray([d.centroid_world_xyz for d in target_available], dtype=np.float64)
            distances = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=2)
            # A finite large sentinel preserves deterministic rectangular assignment.
            cost = np.where(
                distances <= limit, distances, (min(len(a), len(b)) + 1) * (limit + 1.0)
            )
            rows, columns = linear_sum_assignment(cost)
            for row, column in zip(rows, columns, strict=True):
                distance = float(distances[row, column])
                if distance > limit:
                    continue
                src, dst = source_available[row], target_available[column]
                near_targets = tuple(
                    target_available[i].label
                    for i, value in enumerate(distances[row])
                    if value <= distance + ambiguity
                )
                near_sources = tuple(
                    source_available[i].label
                    for i, value in enumerate(distances[:, column])
                    if value <= distance + ambiguity
                )
                uncertain = len(near_targets) > 1 or len(near_sources) > 1
                if uncertain:
                    hypotheses.append(
                        TrackingHypothesis(
                            "ambiguous",
                            source.frame_id,
                            src.label,
                            target.frame_id,
                            near_targets,
                            "near-tied distance-gated candidates",
                        )
                    )
                if len(near_targets) > 1:
                    hypotheses.append(
                        TrackingHypothesis(
                            "split_or_merge",
                            source.frame_id,
                            src.label,
                            target.frame_id,
                            near_targets,
                            "one source has multiple plausible targets",
                        )
                    )
                if len(near_sources) > 1:
                    hypotheses.append(
                        TrackingHypothesis(
                            "split_or_merge",
                            target.frame_id,
                            dst.label,
                            source.frame_id,
                            near_sources,
                            "one target has multiple plausible sources",
                        )
                    )
                edges.append(
                    TrackEdge(
                        source.frame_id,
                        src.label,
                        target.frame_id,
                        dst.label,
                        distance,
                        target_index - source_index - 1,
                        uncertain,
                    )
                )
                used_sources.add((source.frame_id, src.label))
                used_targets.add((target.frame_id, dst.label))
    return TrackingGraph(ordered, tuple(edges), tuple(hypotheses))


def _node_times(graph: TrackingGraph) -> dict[tuple[str, str], float]:
    return {
        (frame.frame_id, d.label): float(frame.time_s)
        for frame in graph.frames
        for d in frame.detections
    }


def validate_track_graph(graph: TrackingGraph) -> None:
    """Fail closed on missing nodes, non-forward edges, cycles, or branching links."""
    _checked_frames(graph.frames)
    times = _node_times(graph)
    frame_index = {frame.frame_id: index for index, frame in enumerate(graph.frames)}
    points = {
        (frame.frame_id, detection.label): detection.centroid_world_xyz
        for frame in graph.frames
        for detection in frame.detections
    }
    outgoing: set[tuple[str, str]] = set()
    incoming: set[tuple[str, str]] = set()
    adjacency: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for edge in graph.edges:
        src, dst = (
            (edge.source_frame_id, edge.source_label),
            (edge.target_frame_id, edge.target_label),
        )
        if src not in times or dst not in times or not times[src] < times[dst]:
            raise ValueError("Track edges must connect declared detections in forward time")
        if src in outgoing or dst in incoming:
            raise ValueError("Automatic and manual tracking edges must remain one-to-one")
        if not math.isfinite(edge.cost) or edge.cost < 0 or edge.gap < 0:
            raise ValueError("Track edge cost and gap must be finite non-negative values")
        if type(edge.gap) is not int or edge.gap != frame_index[dst[0]] - frame_index[src[0]] - 1:
            raise ValueError("Track gap differs from the explicit intervening frames")
        distance = float(np.linalg.norm(np.asarray(points[src]) - points[dst]))
        if not math.isclose(edge.cost, distance, rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError("Track cost differs from its observed world-coordinate distance")
        if type(edge.identity_uncertain) is not bool or edge.provenance not in {
            "automatic",
            "manual",
        }:
            raise ValueError("Track identity uncertainty and provenance must be explicit")
        outgoing.add(src)
        incoming.add(dst)
        adjacency.setdefault(src, []).append(dst)
    visiting: set[tuple[str, str]] = set()
    visited: set[tuple[str, str]] = set()

    def visit(node: tuple[str, str]) -> None:
        if node in visiting:
            raise ValueError("Track graph must be acyclic")
        if node not in visited:
            visiting.add(node)
            for target in adjacency.get(node, []):
                visit(target)
            visiting.remove(node)
            visited.add(node)

    for node in adjacency:
        visit(node)


@dataclass(frozen=True)
class CorrectionRecord:
    action: Literal["add", "remove"]
    edge: TrackEdge


@dataclass
class TrackingEditor:
    """Small in-memory correction ledger with functional undo/redo semantics."""

    graph: TrackingGraph
    corrections: list[CorrectionRecord] = field(default_factory=list)
    _redo: list[CorrectionRecord] = field(default_factory=list, repr=False)

    def _replace_edges(self, edges: Sequence[TrackEdge]) -> None:
        candidate = replace(self.graph, edges=tuple(edges))
        validate_track_graph(candidate)
        self.graph = candidate

    def add_edge(self, edge: TrackEdge) -> None:
        manual = replace(edge, provenance="manual")
        self._replace_edges((*self.graph.edges, manual))
        self.corrections.append(CorrectionRecord("add", manual))
        self._redo.clear()

    def remove_edge(
        self, source_frame_id: str, source_label: str, target_frame_id: str, target_label: str
    ) -> None:
        found = next(
            (
                e
                for e in self.graph.edges
                if (e.source_frame_id, e.source_label, e.target_frame_id, e.target_label)
                == (source_frame_id, source_label, target_frame_id, target_label)
            ),
            None,
        )
        if found is None:
            raise ValueError("Requested edge does not exist")
        self._replace_edges([edge for edge in self.graph.edges if edge != found])
        self.corrections.append(CorrectionRecord("remove", found))
        self._redo.clear()

    def undo(self) -> None:
        if not self.corrections:
            raise ValueError("There is no tracking correction to undo")
        record = self.corrections.pop()
        if record.action == "add":
            self._replace_edges([edge for edge in self.graph.edges if edge != record.edge])
        else:
            self._replace_edges((*self.graph.edges, record.edge))
        self._redo.append(record)

    def redo(self) -> None:
        if not self._redo:
            raise ValueError("There is no tracking correction to redo")
        record = self._redo.pop()
        if record.action == "add":
            self._replace_edges((*self.graph.edges, record.edge))
        else:
            self._replace_edges([edge for edge in self.graph.edges if edge != record.edge])
        self.corrections.append(record)


@dataclass(frozen=True)
class TrajectoryObservation:
    frame_id: str
    label: str
    time_s: float
    centroid_world_xyz: tuple[float, float, float]
    measure: float | None
    displacement: float
    path_length: float
    speed: float | None
    gap_before: int | None


def trajectories(graph: TrackingGraph) -> tuple[tuple[TrajectoryObservation, ...], ...]:
    """Return observed-node trajectories; absent observations are never synthesized."""
    validate_track_graph(graph)
    detections = {(f.frame_id, d.label): (f, d) for f in graph.frames for d in f.detections}
    predecessor = {(e.target_frame_id, e.target_label): e for e in graph.edges}
    successor = {(e.source_frame_id, e.source_label): e for e in graph.edges}
    starts = sorted(node for node in detections if node not in predecessor)
    result: list[tuple[TrajectoryObservation, ...]] = []
    for start in starts:
        current = start
        first_point = np.asarray(detections[current][1].centroid_world_xyz, dtype=np.float64)
        previous_point: np.ndarray | None = None
        previous_time: float | None = None
        path = 0.0
        observations: list[TrajectoryObservation] = []
        while True:
            frame, detection = detections[current]
            point = np.asarray(detection.centroid_world_xyz, dtype=np.float64)
            edge = predecessor.get(current)
            speed: float | None = None
            if previous_point is not None and previous_time is not None:
                step = float(np.linalg.norm(point - previous_point))
                path += step
                speed = step / (float(frame.time_s) - previous_time)
            observations.append(
                TrajectoryObservation(
                    frame.frame_id,
                    detection.label,
                    float(frame.time_s),
                    detection.centroid_world_xyz,
                    detection.measure,
                    float(np.linalg.norm(point - first_point)),
                    path,
                    speed,
                    edge.gap if edge else None,
                )
            )
            edge = successor.get(current)
            if edge is None:
                break
            previous_point, previous_time = point, float(frame.time_s)
            current = (edge.target_frame_id, edge.target_label)
        result.append(tuple(observations))
    return tuple(result)
