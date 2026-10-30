"""Persisted registration-aware tracking of exact reviewed or unreviewed results.

Registration changes tracking coordinates only. Object intensities and sizes
remain the measurements of each original result; absent frames are explicit.
"""

from __future__ import annotations

import copy
import hashlib
import math
from collections.abc import Callable
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import numpy as np

from .quantitative import (
    DEFAULT_WORKING_BYTES,
    MAX_WORKING_BYTES,
    exact_keys,
    finite_number,
    integer,
)
from .research_project import canonical_json, checked_id, checked_text, parse_json
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
from .temporal_metrics import MAX_OBSERVATIONS, MAX_RECORD_BYTES, measure_trajectories

if TYPE_CHECKING:
    from .workbench import Workbench

PAGE_BYTES = 64 * 1024
MAX_INPUT_RECORDS = 2048
MAX_CORRECTION_DEPTH = 64


def _graph_record(graph: TrackingGraph) -> dict[str, Any]:
    validate_track_graph(graph)
    return {
        **asdict(graph),
        "trajectories": [[asdict(point) for point in track] for track in trajectories(graph)],
    }


def _graph_from_record(record: dict[str, Any]) -> TrackingGraph:
    if not isinstance(record, dict) or set(record) != {
        "frames",
        "edges",
        "hypotheses",
        "trajectories",
    }:
        raise ValueError("Stored tracking graph fields are invalid")
    if (
        not isinstance(record["frames"], (list, tuple))
        or not 1 <= len(record["frames"]) <= 1000
        or any(not isinstance(frame, dict) for frame in record["frames"])
    ):
        raise ValueError("Stored tracking graph requires bounded explicit frames")
    if (
        any(not isinstance(frame.get("detections"), (list, tuple)) for frame in record["frames"])
        or sum(len(frame.get("detections", ())) for frame in record["frames"]) > MAX_OBSERVATIONS
        or any(
            not isinstance(record[key], (list, tuple))
            for key in ("edges", "hypotheses", "trajectories")
        )
        or len(record["edges"]) > MAX_OBSERVATIONS
        or len(canonical_json(record).encode()) > MAX_RECORD_BYTES
    ):
        raise ValueError("Stored tracking graph exceeds its bounded observation size")
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


def validate_record(result: dict[str, Any]) -> dict[str, Any]:
    """Recompute exact graph-derived endpoints; absent legacy metrics stay absent."""
    from .workbench import geometry_from_dict

    provenance = result["provenance"]
    graph = _graph_from_record(provenance["tracking"])
    unit = geometry_from_dict(provenance["geometry"]).unit
    if provenance.get("trajectory_units") != {"position": unit, "time": "s", "speed": unit + "/s"}:
        raise ValueError("Stored tracking position/time units disagree with exact geometry")
    expected = measure_trajectories(graph, unit)
    if "trajectory_metrics" in provenance and canonical_json(
        provenance["trajectory_metrics"]
    ) != canonical_json(expected):
        raise ValueError("Stored trajectory metrics disagree with the exact observation graph")
    return expected


def metrics_summary(result: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any]:
    """Small disclosure with no duplicate interval or track populations."""
    return {
        "schema": "loci.trajectory-summary/v1",
        "metrics_schema": metrics["schema"],
        "graph_sha256": metrics["graph_sha256"],
        "units": metrics["units"],
        "rules": metrics["rules"],
        "observation_count": metrics["observation_count"],
        "track_count": len(metrics["tracks"]),
        "interval_count": len(metrics["intervals"]),
        "storage": "persisted"
        if "trajectory_metrics" in result["provenance"]
        else "derived-from-legacy-graph",
        "numerical_policy": metrics["numerical_policy"],
    }


def _settings(provenance):
    settings = provenance.get("tracking_settings")
    if not isinstance(settings, dict) or settings.get("method") != (
        "distance-gated-one-to-one-linear-sum-assignment"
    ):
        raise ValueError("Tracking requires its retained code-owned automatic method")
    registration = settings.get("registration")
    if not isinstance(registration, dict) or registration.get("method") not in {
        "none",
        "translation",
    }:
        raise ValueError("Tracking registration method must be explicit")
    exact_keys(
        registration,
        {"method", "upsample_factor", "min_normalized_correlation"},
        "retained tracking registration",
    )
    checked_text(settings.get("time_declaration"), "Tracking seconds declaration", 1024)
    budget = integer(
        settings.get("working_bytes", DEFAULT_WORKING_BYTES),
        "retained tracking working bytes",
        1024**2,
        MAX_WORKING_BYTES,
    )
    return settings, registration, budget


def validate_inputs(result: dict[str, Any], results: dict[str, dict[str, Any]]) -> None:
    """Pixel-free original/automatic-graph proof; translations also need array replay.

    Call validate_registration_arrays only after source authorization, or with
    verified staged arrays before portable publication. A transform being
    internally consistent does not establish its image-derived estimate.
    """
    from .workbench import geometry_from_dict

    validate_record(result)
    p = result["provenance"]
    graph = _graph_from_record(p["tracking"])
    settings, registration_settings, _ = _settings(p)
    inputs = p.get("temporal_inputs")
    if not isinstance(inputs, list) or len(inputs) != len(graph.frames):
        raise ValueError("Tracking inputs differ from the exact scheduled frames")
    geometry = geometry_from_dict(p["geometry"])
    first = None
    acquisitions = set()
    for binding, frame in zip(inputs, graph.frames, strict=True):
        if not isinstance(binding, dict) or binding.get("time_s") != frame.time_s:
            raise ValueError("Tracking input elapsed seconds changed")
        if "missing_reason" in binding:
            checked_text(binding["missing_reason"], "Missing observation reason", 512)
            if binding.get("frame_id") != frame.frame_id or frame.detections:
                raise ValueError("Missing tracking slots cannot contain invented observations")
            continue
        original = results.get(binding.get("result_id"))
        if (
            original is None
            or original["id"] != frame.frame_id
            or any(
                binding.get(key) != original[key]
                for key in ("revision_hash", "source_id", "source_sha256")
            )
        ):
            raise ValueError("Tracking original result revision or source binding changed")
        raw = original["provenance"]
        if "tracking" in raw or "labels" not in original["arrays"]:
            raise ValueError("Tracking observations require underlying label measurements")
        if canonical_json(binding.get("raw_object_measurements")) != canonical_json(
            raw.get("measurements")
        ) or canonical_json(binding.get("selection")) != canonical_json(raw.get("selection")):
            raise ValueError("Tracking changed original raw measurements or source selection")
        if canonical_json(raw.get("geometry")) != canonical_json(p["geometry"]):
            raise ValueError("Tracking observations must retain the same exact physical grid")
        acquisition = (
            original["source_id"],
            canonical_json({key: value for key, value in raw["selection"].items() if key != "c"}),
        )
        if acquisition in acquisitions:
            raise ValueError("One acquisition cannot represent two tracking observations")
        acquisitions.add(acquisition)
        is_reference = first is None
        first = original if is_reference else first
        registration = binding.get("registration")
        if registration_settings["method"] == "none" and registration is not None:
            raise ValueError("Tracking registration method none forbids retained transforms")
        if registration_settings["method"] == "translation":
            if is_reference and registration is not None:
                raise ValueError("Tracking reference observation cannot carry a registration shift")
            if not is_reference and not isinstance(registration, dict):
                raise ValueError("Tracking translation requires its image-derived transform")
        shift = np.zeros(3)
        if registration is not None:
            shift = np.asarray(registration.get("moving_to_reference_shift_world"), dtype=float)
            index = np.asarray(registration.get("moving_to_reference_shift_index"), dtype=float)
            if (
                shift.shape != (3,)
                or index.shape != (len(geometry.axes),)
                or not np.isfinite(shift).all()
                or not np.isfinite(index).all()
            ):
                raise ValueError("Tracking registration requires a finite declared XYZ shift")
            expected_shift = np.asarray(geometry.affine)[:3, : len(index)] @ index[::-1]
            if not np.allclose(shift, expected_shift, rtol=1e-12, atol=1e-12):
                raise ValueError("Tracking registration index/world shifts disagree")
        expected = tuple(
            Detection(
                str(row["label"]),
                tuple(np.asarray(row["centroid_world_xyz"]) + shift),
                row["measure"],
            )
            for row in raw["measurements"]
        )
        if canonical_json([asdict(d) for d in expected]) != canonical_json(
            [asdict(d) for d in frame.detections]
        ):
            raise ValueError("Tracking coordinates or measures differ from original observations")
    if first is None or len(acquisitions) < 2:
        raise ValueError("Retained tracking requires at least two actual observations")
    if (
        any(result[key] != first[key] for key in ("source_id", "source_sha256"))
        or any(result["arrays"].get(key) != first["arrays"].get(key) for key in ("image", "labels"))
        or set(result["arrays"]) != {"image", "labels"}
        or canonical_json(p.get("selection")) != canonical_json(first["provenance"]["selection"])
    ):
        raise ValueError("Tracking retained arrays or primary source changed")
    correction = p.get("track_correction")
    if correction is None:
        if result.get("parent_id") != first["id"]:
            raise ValueError("Tracking lost its exact first observation parent")
        automatic = track_detections(
            graph.frames,
            max_distance=settings.get("max_distance"),
            max_gap_frames=settings.get("max_gap_frames", 0),
            ambiguity_distance=settings.get("ambiguity_distance", 1e-9),
        )
        if canonical_json(_graph_record(automatic)) != canonical_json(p["tracking"]):
            raise ValueError("Stored automatic tracking differs from its retained method/settings")
        return
    if (
        not isinstance(correction, dict)
        or set(correction)
        != {"parent_revision_hash", "changes", "automatic_hypotheses_retained_as_history"}
        or correction["automatic_hypotheses_retained_as_history"] is not True
    ):
        raise ValueError("Tracking correction history must retain its automatic hypotheses")
    parent = results.get(result.get("parent_id"))
    if parent is None or parent["revision_hash"] != correction.get("parent_revision_hash"):
        raise ValueError("Tracking correction parent is missing or stale")
    if any(
        canonical_json(p[key]) != canonical_json(parent["provenance"][key])
        for key in ("temporal_inputs", "trajectory_units", "geometry", "tracking_settings")
    ):
        raise ValueError("Tracking correction changed original observation or method context")
    edits = correction.get("changes")
    if not isinstance(edits, list) or not 1 <= len(edits) <= 64:
        raise ValueError("Tracking correction requires a bounded exact edit ledger")
    editor = TrackingEditor(_graph_from_record(parent["provenance"]["tracking"]))
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"action", "edge"}:
            raise ValueError("Tracking correction ledger fields are invalid")
        edge = TrackEdge(**edit["edge"])
        if edit["action"] == "add":
            editor.add_edge(edge)
        elif edit["action"] == "remove":
            editor.remove_edge(
                edge.source_frame_id, edge.source_label, edge.target_frame_id, edge.target_label
            )
        else:
            raise ValueError("Unknown retained tracking correction")
    if canonical_json(_graph_record(editor.graph)) != canonical_json(p["tracking"]) or (
        canonical_json([asdict(change) for change in editor.corrections]) != canonical_json(edits)
    ):
        raise ValueError("Tracking corrected graph differs from its exact parent/edit ledger")


def validate_registration_arrays(result, results, *, array_loader, check=None, working_bytes=None):
    """Reproduce translation from exact retained original images, after authority.

    This is intentionally separate from metadata-only project/portable preflight:
    opening a policy-scoped study must not decode ungranted source pixels. The
    caller supplies its verified loader and applies source/resource authority.
    Legacy records without a retained budget use the original 512 MiB default;
    a caller cap can only reduce the declared working-memory allowance.
    """
    from .workbench import geometry_from_dict

    validate_inputs(result, results)
    p = result["provenance"]
    _, registration, budget = _settings(p)
    if registration["method"] == "none":
        return
    if working_bytes is not None:
        budget = min(
            budget,
            integer(working_bytes, "tracking replay working bytes", 1024**2, MAX_WORKING_BYTES),
        )
    observed = [binding for binding in p["temporal_inputs"] if not binding.get("missing_reason")]
    geometry = geometry_from_dict(p["geometry"])
    for binding in observed:
        descriptor = results[binding["result_id"]]["arrays"]["image"]
        shape = descriptor.get("shape")
        if (
            not isinstance(shape, list)
            or len(shape) != len(geometry.axes)
            or any(type(length) is not int or length < 1 for length in shape)
        ):
            raise ValueError("Tracking registration replay requires an exact scalar image shape")
        if math.prod(shape) * 128 > budget:
            raise ValueError(
                "Tracking registration replay exceeds its bounded working-memory budget"
            )
    if check:
        check()
    reference = array_loader(results[observed[0]["result_id"]]["arrays"]["image"])
    for binding in observed[1:]:
        if check:
            check()
        moving = array_loader(results[binding["result_id"]]["arrays"]["image"])
        estimate = estimate_translation(
            reference,
            moving,
            geometry,
            upsample_factor=registration.get("upsample_factor", 20),
            min_normalized_correlation=registration.get("min_normalized_correlation", 0.25),
            working_bytes=budget,
        )
        if canonical_json(asdict(estimate)) != canonical_json(binding["registration"]):
            raise ValueError("Stored tracking translation differs from the exact original images")
        del moving
    if check:
        check()


def project_inputs(
    project, result, *, check=None, verify_arrays=False, working_bytes=None
) -> dict[str, dict[str, Any]]:
    """Bound/hash-check original snapshots without recursive forged graph reads."""
    records = {result["id"]: result}
    pending = [(result, 0)]
    tracks = []
    used = 0

    def load(identity):
        nonlocal used
        checked_id(identity)
        if identity in records:
            return records[identity]
        if check:
            check()
        with project.connection() as connection:
            row = connection.execute(
                "SELECT record FROM results WHERE id=?", (identity,)
            ).fetchone()
        if row is None:
            raise ValueError("Tracking original result is missing")
        used += len(row[0].encode())
        if used > MAX_RECORD_BYTES or len(records) >= MAX_INPUT_RECORDS:
            raise ValueError("Tracking retained inputs exceed the bounded metadata budget")
        original = parse_json(row[0])
        if (
            original.get("id") != identity
            or original.get("revision_hash")
            != hashlib.sha256(
                canonical_json({k: v for k, v in original.items() if k != "revision_hash"}).encode()
            ).hexdigest()
        ):
            raise ValueError("Tracking original result failed revision integrity")
        if project.source(original["source_id"])["sha256"] != original["source_sha256"]:
            raise ValueError("Tracking original source fingerprint changed")
        records[identity] = original
        return original

    visited = set()
    while pending:
        current, depth = pending.pop()
        if current["id"] in visited or depth >= MAX_CORRECTION_DEPTH:
            raise ValueError("Tracking correction ancestry is cyclic or exceeds its bound")
        visited.add(current["id"])
        validate_record(current)
        tracks.append(current)
        for binding in current["provenance"]["temporal_inputs"]:
            if not binding.get("missing_reason"):
                original = load(binding["result_id"])
                if "tracking" in original["provenance"]:
                    raise ValueError("Tracking observations cannot be another tracking result")
        if "track_correction" in current["provenance"]:
            parent = load(current["parent_id"])
            pending.append((parent, depth + 1))
    for current in tracks:
        validate_inputs(current, records)
        if verify_arrays:
            validate_registration_arrays(
                current,
                records,
                array_loader=project.load_array,
                check=check,
                working_bytes=working_bytes,
            )
    return records


def _metrics_page(result, metrics, request):
    table = request.get("table")
    if table not in {"tracks", "intervals"}:
        raise ValueError("Choose the trajectory tracks or intervals table")
    offset = integer(request.get("offset", 0), "trajectory offset", 0, 2**63 - 1)
    limit = integer(request.get("limit", 50), "trajectory page rows", 1, 100)
    rows = metrics[table]
    output = {
        "schema": "loci.trajectory-page/v1",
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "summary": metrics_summary(result, metrics),
        "table": table,
        "offset": offset,
        "limit": limit,
        "total": len(rows),
        "rows": [],
        "next_offset": None,
    }
    for row in rows[offset : offset + limit]:
        output["rows"].append(row)
        end = offset + len(output["rows"])
        output["next_offset"] = end if end < len(rows) else None
        if len(canonical_json(output).encode()) > PAGE_BYTES:
            output["rows"].pop()
            if not output["rows"]:
                raise ValueError("Trajectory row exceeds the bounded response size")
            output["next_offset"] = offset + len(output["rows"])
            break
    return output


def _tracking_result(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    result = workbench.project.result(
        checked_id(request.get("result_id")), verify_scientific_arrays=False
    )
    if result["revision_hash"] != request.get("revision_hash"):
        raise ValueError("Select the exact temporal result revision")
    if "tracking" not in result["provenance"]:
        raise ValueError("The selected result contains no temporal observation graph")
    workbench.project.validate_result_arrays(result)
    return result


def _input_guard(
    workbench: Workbench, bindings: list[dict[str, Any]], *, verify_arrays=False
) -> None:
    for item in bindings:
        if item.get("missing_reason"):
            continue
        actual = workbench.project.result(item["result_id"], verify_scientific_arrays=False)
        if actual["revision_hash"] != item["revision_hash"]:
            raise ValueError("A bound temporal result changed before publication")
        workbench.project.source(actual["source_id"], verify=True)
        if verify_arrays:
            workbench.project.validate_result_arrays(actual)
            for descriptor in actual["arrays"].values():
                workbench.project.verify_array(descriptor)


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
            {"result_id", "revision_hash", "table", "offset", "limit"}
            if operation == "tracking_result"
            else {"result_id", "revision_hash", "changes"},
            operation,
        )
        parent = _tracking_result(workbench, request)
        provenance = (
            parent["provenance"]
            if operation == "tracking_result"
            else copy.deepcopy(parent["provenance"])
        )
        graph = _graph_from_record(provenance["tracking"])
        _input_guard(workbench, provenance["temporal_inputs"])
        metrics = validate_record(parent)
        if operation == "tracking_result":
            if "table" in request:
                return _metrics_page(parent, metrics, request)
            if "offset" in request or "limit" in request:
                raise ValueError("Trajectory pagination requires an explicit table")
            return {
                "trajectory_metrics": metrics_summary(parent, metrics),
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
            result = workbench.project.result(
                checked_id(raw_frame.get("result_id")), verify_scientific_arrays=False
            )
            if result["revision_hash"] != raw_frame.get("revision_hash"):
                raise ValueError("Every tracked frame must bind to its exact result revision")
            workbench.project.validate_result_arrays(result)
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
                "working_bytes": budget,
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

    provenance["trajectory_metrics"] = measure_trajectories(
        _graph_from_record(provenance["tracking"]), geometry_from_dict(provenance["geometry"]).unit
    )
    provenance.pop("job_id", None)
    if job_id is not None:
        provenance["job_id"] = job_id

    def guard() -> None:
        if publication_guard is not None:
            publication_guard()
        _input_guard(workbench, provenance["temporal_inputs"], verify_arrays=True)
        if (
            operation == "correct_tracks"
            and workbench.project.result(parent["id"], verify_scientific_arrays=False)[
                "revision_hash"
            ]
            != parent["revision_hash"]
        ):
            raise ValueError("Tracking correction parent changed before publication")

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
        "trajectory_metrics": metrics_summary(result, provenance["trajectory_metrics"]),
        "tracking": provenance["tracking"],
        "inputs": provenance["temporal_inputs"],
        "units": provenance["trajectory_units"],
    }
