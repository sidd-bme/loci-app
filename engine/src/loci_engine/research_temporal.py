"""Persisted registration-aware tracking of exact reviewed or unreviewed results.

Registration changes tracking coordinates only. Object intensities and sizes
remain the measurements of each original result; absent frames are explicit.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Callable
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import numpy as np

from .quantitative import exact_keys, finite_number, integer
from .research_project import canonical_json, checked_id, checked_text
from .temporal import (
    Detection,
    TimeFrame,
    TrackEdge,
    TrackingEditor,
    TrackingGraph,
    TrackingHypothesis,
    estimate_translation,
    track_detections,
    trajectories,
    validate_track_graph,
)

if TYPE_CHECKING:
    from .workbench import Workbench


def _graph_record(graph: TrackingGraph) -> dict[str, Any]:
    validate_track_graph(graph)
    return {
        **asdict(graph),
        "trajectories": [[asdict(point) for point in track] for track in trajectories(graph)],
    }


def _graph_from_record(record: dict[str, Any]) -> TrackingGraph:
    frames = tuple(
        TimeFrame(
            frame["frame_id"],
            frame["time_s"],
            tuple(
                Detection(item["label"], tuple(item["centroid_world_xyz"]), item["measure"])
                for item in frame["detections"]
            ),
        )
        for frame in record["frames"]
    )
    graph = TrackingGraph(
        frames,
        tuple(TrackEdge(**item) for item in record["edges"]),
        tuple(TrackingHypothesis(**item) for item in record["hypotheses"]),
    )
    validate_track_graph(graph)
    if canonical_json(_graph_record(graph)) != canonical_json(record):
        raise ValueError("Stored trajectories do not match their exact observation graph")
    return graph


def _tracking_result(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    result = workbench.project.result(checked_id(request.get("result_id")))
    if result["revision_hash"] != request.get("revision_hash"):
        raise ValueError("Select the exact temporal result revision")
    if "tracking" not in result["provenance"]:
        raise ValueError("The selected result contains no temporal observation graph")
    return result


def _input_guard(workbench: Workbench, bindings: list[dict[str, Any]]) -> None:
    for item in bindings:
        if item.get("missing_reason"):
            continue
        actual = workbench.project.result(item["result_id"])
        if actual["revision_hash"] != item["revision_hash"]:
            raise ValueError("A bound temporal result changed before publication")
        workbench.project.source(actual["source_id"], verify=True)


def execute_temporal(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    from .workbench import geometry_from_dict, result_summary, runtime_record

    if operation in {"tracking_result", "correct_tracks"}:
        exact_keys(
            request,
            {"result_id", "revision_hash"}
            if operation == "tracking_result"
            else {"result_id", "revision_hash", "changes"},
            operation,
        )
        parent = _tracking_result(workbench, request)
        provenance = copy.deepcopy(parent["provenance"])
        graph = _graph_from_record(provenance["tracking"])
        _input_guard(workbench, provenance["temporal_inputs"])
        if operation == "tracking_result":
            return {
                "result": result_summary(parent, workbench.project.review_state(parent["id"])),
                "tracking": provenance["tracking"],
                "inputs": provenance["temporal_inputs"],
                "settings": provenance["tracking_settings"],
                "units": provenance["trajectory_units"],
            }
        changes = request.get("changes")
        if not isinstance(changes, list) or not 1 <= len(changes) <= 64:
            raise ValueError("Choose 1-64 explicit temporal association edits")
        editor = TrackingEditor(graph)
        nodes = {
            (frame.frame_id, point.label): point
            for frame in graph.frames
            for point in frame.detections
        }
        frame_index = {frame.frame_id: index for index, frame in enumerate(graph.frames)}
        for change in changes:
            exact_keys(
                change,
                {
                    "op",
                    "source_frame_id",
                    "source_label",
                    "target_frame_id",
                    "target_label",
                    "identity_uncertain",
                },
                "track edit",
            )
            node_fields = [
                change[key]
                for key in ("source_frame_id", "source_label", "target_frame_id", "target_label")
            ]
            if change.get("op") == "remove":
                if "identity_uncertain" in change:
                    raise ValueError("Removing an edge does not create a new identity judgment")
                editor.remove_edge(*node_fields)
            elif change.get("op") == "add":
                uncertain = change.get("identity_uncertain")
                if not isinstance(uncertain, bool):
                    raise ValueError("Declare whether the manually linked identity is uncertain")
                src, dst = tuple(node_fields[:2]), tuple(node_fields[2:])
                if src not in nodes or dst not in nodes:
                    raise ValueError("Manual associations must use actual observed detections")
                cost = float(
                    np.linalg.norm(
                        np.asarray(nodes[src].centroid_world_xyz) - nodes[dst].centroid_world_xyz
                    )
                )
                editor.add_edge(
                    TrackEdge(
                        *node_fields, cost, frame_index[dst[0]] - frame_index[src[0]] - 1, uncertain
                    )
                )
            else:
                raise ValueError("Track edits support explicit add or remove associations")
        provenance["tracking"] = _graph_record(editor.graph)
        provenance["track_correction"] = {
            "parent_revision_hash": parent["revision_hash"],
            "changes": [asdict(item) for item in editor.corrections],
            "automatic_hypotheses_retained_as_history": True,
        }
        arrays = {key: workbench.project.load_array(item) for key, item in parent["arrays"].items()}
        first = parent
        parent_id = parent["id"]
    else:
        exact_keys(
            request,
            {
                "frames",
                "time_declaration",
                "max_distance",
                "max_gap_frames",
                "ambiguity_distance",
                "registration",
                "working_bytes",
            },
            "temporal tracking",
        )
        raw_frames = request.get("frames")
        if not isinstance(raw_frames, list) or not 2 <= len(raw_frames) <= 1000:
            raise ValueError(
                "Tracking needs 2-1000 explicitly timed result or missing-frame records"
            )
        declaration = checked_text(
            request.get("time_declaration"), "Time calibration declaration", 1024
        )
        budget = integer(
            request.get("working_bytes", 512 * 1024**2),
            "working-memory budget",
            1024**2,
            8 * 1024**3,
        )
        registration = request.get("registration", {"method": "none"})
        exact_keys(
            registration,
            {"method", "upsample_factor", "min_normalized_correlation"},
            "tracking registration",
        )
        if registration.get("method") not in {"none", "translation"}:
            raise ValueError(
                "Tracking registration supports none or explicit phase-correlation translation"
            )
        frames, bindings, references = [], [], {}
        first, reference_image, geometry = None, None, None
        last_time = -math.inf
        observed_acquisitions = set()
        for raw_frame in raw_frames:
            if not isinstance(raw_frame, dict):
                raise ValueError("Each temporal frame must be an explicit object")
            missing = raw_frame.get("result_id") is None
            exact_keys(
                raw_frame,
                {"frame_id", "time_s", "missing_reason"}
                if missing
                else {"result_id", "revision_hash", "time_s"},
                "temporal frame",
            )
            time_s = finite_number(raw_frame.get("time_s"), "frame seconds", -1e15, 1e15)
            if time_s <= last_time:
                raise ValueError("Frame times must be strictly increasing actual seconds")
            last_time = time_s
            if missing:
                frame_id = checked_text(raw_frame.get("frame_id"), "Missing frame identity", 128)
                reason = checked_text(raw_frame.get("missing_reason"), "Missing frame reason", 512)
                frames.append(TimeFrame(frame_id, time_s, ()))
                bindings.append({"frame_id": frame_id, "time_s": time_s, "missing_reason": reason})
                continue
            result = workbench.project.result(checked_id(raw_frame.get("result_id")))
            if result["revision_hash"] != raw_frame.get("revision_hash"):
                raise ValueError("Every tracked frame must bind to its exact result revision")
            record = result["provenance"]
            acquisition = (
                result["source_id"],
                canonical_json(
                    {key: value for key, value in record["selection"].items() if key != "c"}
                ),
            )
            if acquisition in observed_acquisitions:
                raise ValueError(
                    "Different result revisions or channels of one acquisition "
                    "are not separate time observations"
                )
            observed_acquisitions.add(acquisition)
            if "labels" not in result["arrays"] or "tracking" in record:
                raise ValueError("Each observed frame requires an object label result")
            current_geometry = geometry_from_dict(record["geometry"])
            image = workbench.project.load_array(result["arrays"]["image"])
            if image.nbytes * 16 > budget:
                raise ValueError("Tracking registration exceeds the bounded working-memory budget")
            if first is None:
                first, reference_image, geometry = result, image, current_geometry
            elif image.shape != reference_image.shape or canonical_json(
                current_geometry.to_dict()
            ) != canonical_json(geometry.to_dict()):
                raise ValueError("Tracked frames must have identical declared physical grids")
            transform = None
            shift = np.zeros(3)
            if registration["method"] == "translation" and result["id"] != first["id"]:
                transform = estimate_translation(
                    reference_image,
                    image,
                    geometry,
                    upsample_factor=registration.get("upsample_factor", 20),
                    working_bytes=budget,
                    min_normalized_correlation=registration.get("min_normalized_correlation", 0.25),
                )
                shift = np.asarray(transform.moving_to_reference_shift_world)
            detections = tuple(
                Detection(
                    str(row["label"]),
                    tuple(np.asarray(row["centroid_world_xyz"]) + shift),
                    row["measure"],
                )
                for row in record.get("measurements", [])
            )
            frames.append(TimeFrame(result["id"], time_s, detections))
            binding = {
                **raw_frame,
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "selection": record["selection"],
                "registration": asdict(transform) if transform else None,
                "raw_object_measurements": record.get("measurements", []),
            }
            bindings.append(binding)
            references[f"frame_{len(bindings)}"] = {
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
            }
        if first is None or len([item for item in bindings if not item.get("missing_reason")]) < 2:
            raise ValueError("Tracking requires at least two observed result frames")
        graph = track_detections(
            frames,
            max_distance=request.get("max_distance"),
            max_gap_frames=request.get("max_gap_frames", 0),
            ambiguity_distance=request.get("ambiguity_distance", 1e-9),
        )
        settings = {
            key: request.get(key, default)
            for key, default in (
                ("max_distance", None),
                ("max_gap_frames", 0),
                ("ambiguity_distance", 1e-9),
            )
        }
        provenance = {
            "geometry": geometry.to_dict(),
            "selection": first["provenance"]["selection"],
            "temporal_inputs": bindings,
            "references": references,
            "tracking": _graph_record(graph),
            "tracking_settings": {
                **settings,
                "registration": registration,
                "time_declaration": declaration,
                "method": "distance-gated-one-to-one-linear-sum-assignment",
            },
            "measurement_basis": (
                "original-frame-object-measurements; "
                "registration-adjusted-tracking-coordinates-only"
            ),
            "trajectory_units": {
                "position": geometry.unit,
                "time": "s",
                "speed": geometry.unit + "/s",
            },
            "runtime": runtime_record(),
            "measurements": [],
            "scientific_interpretation": (
                "observed-associations; no asserted lineage or biological identity"
            ),
        }
        arrays = {
            "image": reference_image,
            "labels": workbench.project.load_array(first["arrays"]["labels"]),
        }
        parent_id = first["id"]

    def guard() -> None:
        if publication_guard is not None:
            publication_guard()
        _input_guard(workbench, provenance["temporal_inputs"])

    result = workbench.project.save_result(
        source_id=first["source_id"],
        kind="temporal-tracking",
        arrays=arrays,
        provenance=provenance,
        parent_id=parent_id,
        job_id=job_id,
        publication_guard=guard,
    )
    return {
        "result": result_summary(result),
        "tracking": provenance["tracking"],
        "inputs": provenance["temporal_inputs"],
        "units": provenance["trajectory_units"],
    }
