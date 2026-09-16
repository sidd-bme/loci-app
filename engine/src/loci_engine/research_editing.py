"""Revision-bound label and ROI editing using the shared scientific kernels."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import numpy as np

from .quantitative import apply_marker_gates, exact_keys, integer, measure_objects
from .research_annotations import (
    correct_labels,
    create_polygon_roi,
    label_array_sha256,
    measure_polygon_roi,
    roi_to_geojson,
)
from .research_project import canonical_json, checked_id

if TYPE_CHECKING:
    from .workbench import Workbench


def _bound_result(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    result = workbench.project.result(checked_id(request.get("result_id")))
    if result["revision_hash"] != request.get("revision_hash"):
        raise ValueError("Editing requires the exact selected result revision")
    workbench.project.source(result["source_id"], verify=True)
    return result


def _raw_channels(
    workbench: Workbench,
    result: dict[str, Any],
    channels: list[int],
    working_bytes: int,
) -> dict[str, np.ndarray]:
    from .workbench import geometry_from_dict

    provenance = result["provenance"]
    geometry = geometry_from_dict(provenance["geometry"])
    if not isinstance(channels, list) or len(channels) > 16 or len(set(channels)) != len(channels):
        raise ValueError("Choose at most 16 distinct source measurement channels")
    values = {}
    derived = provenance.get("derived_measurement_arrays")
    if derived is not None:
        prefix = _derived_prefix(provenance)
        for channel in channels:
            index = integer(channel, "derived measurement channel", 0, len(derived) - 1)
            name = derived[index]
            values[f"{prefix}:{name}"] = workbench.project.load_array(result["arrays"][name])
        return values
    if provenance.get("stain_separation"):
        from skimage.color import separate_stains

        raw, actual_geometry, _ = workbench.load_scalar(
            result["source_id"],
            provenance["selection"],
            allow_rgb=True,
            working_bytes=working_bytes,
        )
        if canonical_json(actual_geometry.to_dict()) != canonical_json(geometry.to_dict()):
            raise ValueError("Stain ROI measurement grid differs from the selected result")
        record = provenance["stain_separation"]
        stains = separate_stains(raw, np.asarray(record["matrix"], dtype=np.float64))
        stain_names = [
            "hematoxylin-basis",
            "eosin-basis" if record["declared_basis"] == "H&E" else "DAB-basis",
        ]
        for channel in channels:
            index = integer(channel, "declared stain coordinate", 0, 1)
            values[stain_names[index]] = stains[..., index]
        return values
    saved_channels = provenance.get("channel_metadata", {}).get("channels")
    names = (
        [item["name"] for item in saved_channels]
        if saved_channels
        else workbench.project.source(result["source_id"])["metadata"].get("channel_names", [])
    )
    for channel in channels:
        channel = integer(channel, "measurement channel", 0, 65535)
        array, actual_geometry, _ = workbench.load_scalar(
            result["source_id"],
            {**provenance["selection"], "c": channel},
            working_bytes=working_bytes,
        )
        if canonical_json(actual_geometry.to_dict()) != canonical_json(geometry.to_dict()):
            raise ValueError("Source measurement grid differs from the selected result")
        name = (
            f"source_channel_{channel}"
            if provenance.get("model")
            else (f"{channel + 1}: {names[channel] if channel < len(names) else 'Intensity'}")
        )
        values[name] = array
    return values


def _derived_prefix(provenance: dict[str, Any]) -> str:
    prefix = provenance.get("derived_measurement_prefix", "REGISTERED-DERIVED")
    if prefix not in {"REGISTERED-DERIVED", "TISSUE-DERIVED", "LEGACY-DERIVED", "RGB-DERIVED"}:
        raise ValueError("Unknown derived measurement basis")
    if prefix == "TISSUE-DERIVED" and not provenance.get("tissue_mask"):
        raise ValueError("Tissue-derived values require an executed tissue-mask record")
    if prefix == "LEGACY-DERIVED" and not provenance.get("legacy_import"):
        raise ValueError("Legacy-derived values require a verified legacy import record")
    if prefix == "RGB-DERIVED" and (
        provenance.get("recipe", {}).get("input_transform") != "rgb_intensity"
        or provenance.get("input_transform", {}).get("method") != "skimage.color.rgb2gray"
    ):
        raise ValueError("RGB-derived values require an executed intensity conversion record")
    return prefix


def _measurements(
    workbench: Workbench, parent: dict[str, Any], labels: np.ndarray, working_bytes: int
) -> list[dict[str, Any]]:
    from .workbench import geometry_from_dict

    provenance = parent["provenance"]
    geometry = geometry_from_dict(provenance["geometry"])
    if provenance.get("derived_measurement_arrays"):
        channels = _raw_channels(
            workbench,
            parent,
            list(range(len(provenance["derived_measurement_arrays"]))),
            working_bytes,
        )
    elif provenance.get("stain_separation"):
        from skimage.color import separate_stains

        raw, actual_geometry, _ = workbench.load_scalar(
            parent["source_id"],
            provenance["selection"],
            allow_rgb=True,
            working_bytes=working_bytes,
        )
        if canonical_json(actual_geometry.to_dict()) != canonical_json(geometry.to_dict()):
            raise ValueError("Stain measurement grid differs from the selected result")
        record = provenance["stain_separation"]
        stains = separate_stains(raw, np.asarray(record["matrix"], dtype=np.float64))
        names = [
            "hematoxylin-basis",
            "eosin-basis" if record["declared_basis"] == "H&E" else "DAB-basis",
        ]
        channels = {name: stains[..., index] for index, name in enumerate(names)}
    else:
        executed = provenance.get("recipe", provenance.get("cellpose", {}))
        channels = _raw_channels(
            workbench,
            parent,
            provenance.get("measurement_channels", executed.get("measurement_channels", [])),
            working_bytes,
        )
    rows = measure_objects(labels, geometry, channels, working_bytes=working_bytes)
    executed = provenance.get("recipe", provenance.get("cellpose", {}))
    return apply_marker_gates(rows, executed.get("gates", []))


def execute_edit(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    from .workbench import geometry_from_dict, result_summary

    if operation == "select_result":
        exact_keys(request, {"result_id", "revision_hash", "expected_revision"}, operation)
        result = _bound_result(workbench, request)
        cursor = workbench.project.put_document(
            "selection",
            result["source_id"],
            {"result_id": result["id"], "revision_hash": result["revision_hash"]},
            expected_revision=request.get("expected_revision", 0),
        )
        return {
            "selection": cursor,
            "result": result_summary(result, workbench.project.review_state(result["id"])),
        }
    if operation == "correction_info":
        info_keys = {"result_id", "revision_hash"}
        boundary_keys = info_keys | {"label", "plane", "index"}
        request_keys = frozenset(request)
        if request_keys not in {frozenset(info_keys), frozenset(boundary_keys)}:
            raise ValueError(
                "correction_info requires an exact result binding and, when requested, "
                "exactly label, plane, and index"
            )
        result = _bound_result(workbench, request)
        labels = (
            workbench.project.load_array(result["arrays"]["labels"])
            if "labels" in result["arrays"]
            else None
        )
        provenance = result["provenance"]
        if provenance.get("derived_measurement_arrays"):
            prefix = _derived_prefix(provenance)
            names = [prefix + ":" + name for name in provenance["derived_measurement_arrays"]]
            basis = prefix + " scalar values"
        elif provenance.get("stain_separation"):
            names = [
                "hematoxylin-basis",
                "eosin-basis"
                if provenance["stain_separation"]["declared_basis"] == "H&E"
                else "DAB-basis",
            ]
            basis = "declared-stain-coordinate-values"
        else:
            saved = provenance.get("channel_metadata") or workbench.channel_metadata(
                result["source_id"]
            )
            names = [item["name"] for item in saved["channels"]]
            basis = "raw-source-channel-values"
        response = {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "label_sha256": label_array_sha256(labels) if labels is not None else None,
            "shape": list(labels.shape)
            if labels is not None
            else result["arrays"]["image"]["shape"],
            "label_ids": [int(v) for v in np.unique(labels) if v] if labels is not None else [],
            "measurement_channels": [
                {"index": index, "name": name, "basis": basis} for index, name in enumerate(names)
            ],
            "parent_id": result["parent_id"],
            "derived_measurement_arrays": result["provenance"].get("derived_measurement_arrays"),
        }
        if request_keys == boundary_keys:
            if labels is None:
                raise ValueError("Choose a segmented result before editing boundary vertices")
            from .research_boundary_editing import editable_instance_boundary

            response["boundary"] = editable_instance_boundary(
                labels,
                geometry_from_dict(result["provenance"]["geometry"]),
                label=request["label"],
                plane=request["plane"],
                index=request["index"],
            )
        return response
    exact_keys(
        request,
        {"result_id", "revision_hash", "operations", "working_bytes"}
        if operation == "correct_result"
        else {"result_id", "revision_hash", "roi", "measurement_channels", "working_bytes"},
        operation,
    )
    parent = _bound_result(workbench, request)
    if operation == "correct_result" and "association" in parent["provenance"]:
        raise ValueError("Correct the underlying cell or nucleus result and rerun the association")
    if "tracking" in parent["provenance"]:
        raise ValueError(
            "Correct the underlying frame labels or the temporal associations explicitly"
        )
    working_bytes = integer(
        request.get("working_bytes", 512 * 1024**2), "working-memory budget", 1024**2, 8 * 1024**3
    )
    if sum(item["bytes"] for item in parent["arrays"].values()) > working_bytes // 2:
        raise ValueError("Result arrays exceed the bounded editing working-memory budget")
    arrays = {key: workbench.project.load_array(value) for key, value in parent["arrays"].items()}
    geometry = geometry_from_dict(parent["provenance"]["geometry"])
    provenance = copy.deepcopy(parent["provenance"])
    provenance.pop("job_id", None)
    if operation == "correct_result":
        if "labels" not in arrays:
            raise ValueError("Choose a segmented result before correcting labels")
        operations = request.get("operations")
        vertex_operations = (
            [
                item
                for item in operations
                if isinstance(item, dict) and item.get("op") == "move_boundary_vertex"
            ]
            if isinstance(operations, list)
            else []
        )
        if vertex_operations:
            if len(operations) != 1:
                raise ValueError(
                    "A boundary vertex move must be committed as one atomic correction"
                )
            from .research_boundary_editing import move_boundary_vertex

            arrays["labels"], audit = move_boundary_vertex(
                arrays["labels"], geometry, vertex_operations[0], working_bytes=working_bytes
            )
        else:
            arrays["labels"], audit = correct_labels(
                arrays["labels"], geometry, operations, working_bytes=working_bytes
            )
        provenance["measurements"] = _measurements(
            workbench, parent, arrays["labels"], working_bytes
        )
        provenance["correction"] = {
            "parent_id": parent["id"],
            "parent_revision_hash": parent["revision_hash"],
            **audit,
        }
        if "puncta" in provenance:
            provenance["puncta_peak_status"] = "initial-detections-before-manual-label-correction"
        if "tissue_mask" in provenance:
            provenance["tissue_mask_status"] = (
                "initial-mask-statistics-before-manual-label-correction"
            )
        kind = "corrected-labels"
    elif operation == "roi_add":
        spec = request.get("roi")
        exact_keys(
            spec,
            {"annotation_id", "plane", "index", "points", "slab_start", "slab_stop_exclusive"},
            "ROI",
        )
        selection = provenance["selection"]
        roi = create_polygon_roi(
            annotation_id=spec["annotation_id"],
            image_shape=arrays["image"].shape,
            geometry=geometry,
            source_sha256=parent["source_sha256"],
            result_sha256=parent["revision_hash"],
            source_t=selection["t"],
            source_c=selection["c"],
            plane=spec["plane"],
            plane_index=spec["index"],
            points=spec["points"],
            slab_start=spec.get("slab_start"),
            slab_stop_exclusive=spec.get("slab_stop_exclusive"),
        )
        channels = request.get(
            "measurement_channels",
            [0] if provenance.get("derived_measurement_arrays") else [selection["c"]],
        )
        values = _raw_channels(workbench, parent, channels, working_bytes)
        if not values:
            raise ValueError("ROI intensity analysis requires explicit source channels")
        measured = {
            name: measure_polygon_roi(
                image,
                roi,
                source_sha256=parent["source_sha256"],
                result_sha256=parent["revision_hash"],
                working_bytes=working_bytes,
            )
            for name, image in values.items()
        }
        if provenance.get("derived_measurement_arrays") or provenance.get("stain_separation"):
            for measurement in measured.values():
                measurement["derived_intensity"] = measurement.pop("raw_intensity")
        annotations = provenance.setdefault("annotations", [])
        if len(annotations) >= 1000 or any(item["id"] == roi.annotation_id for item in annotations):
            raise ValueError("Choose a unique ROI identifier within the 1000 annotation limit")
        annotations.append(
            {
                "id": roi.annotation_id,
                "geojson": roi_to_geojson(roi),
                "measurements": measured,
                "basis": _derived_prefix(provenance) + " scalar values"
                if provenance.get("derived_measurement_arrays")
                else "declared-stain-coordinate-values"
                if provenance.get("stain_separation")
                else "raw-source-channel-values",
                "parent_result_id": parent["id"],
            }
        )
        kind = "annotated-result"
    else:
        raise ValueError("Unsupported revision editing operation")

    def guard() -> None:
        if publication_guard is not None:
            publication_guard()
        _bound_result(
            workbench, {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
        )
        for artifact in parent["arrays"].values():
            workbench.project.verify_array(artifact)

    result = workbench.project.save_result(
        source_id=parent["source_id"],
        kind=kind,
        arrays=arrays,
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=guard,
    )
    return {
        "result": result_summary(result),
        "measurements": provenance.get("measurements", [])[:1000],
        "annotations": provenance.get("annotations", []),
    }
