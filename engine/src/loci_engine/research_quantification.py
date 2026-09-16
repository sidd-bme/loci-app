"""Durable bounded puncta, label-association, and colocalisation operations.

The operations in this module consume only explicitly selected scalar channels or
exact immutable result revisions.  They preserve physical geometry and source or
artifact identities; they do not infer biological channel roles or interaction.
"""

from __future__ import annotations

import base64
import copy
import io
import itertools
import math
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.segmentation import watershed

from .quantitative import (
    DEFAULT_WORKING_BYTES,
    Geometry,
    associate_labels,
    colocalisation,
    exact_keys,
    finite_number,
    integer,
    measure_objects,
    validate_array,
)
from .research_project import canonical_json, checked_id, checked_text

if TYPE_CHECKING:
    from .workbench import Workbench


QUANTIFICATION_OPERATIONS = frozenset(
    {"puncta_preview", "puncta_run", "associate_results", "colocalisation_run"}
)
MAX_CANDIDATES = 10_000
MAX_PEAKS = 10_000
PUNCTA_BYTES_PER_VOXEL = 192
MAX_SIGMA_VOXELS = 256.0


def _guard(callback: Callable[[], None] | None) -> None:
    if callback is not None:
        callback()


def _same_record(first: object, second: object) -> bool:
    return canonical_json(first) == canonical_json(second)


def _channel_snapshot(workbench: Workbench, source_id: str) -> dict[str, Any]:
    snapshot = workbench.channel_metadata(source_id)
    if snapshot.get("source_id") != source_id:
        raise ValueError("Channel metadata belongs to a different source")
    source = workbench.project.source(source_id, verify=True)
    if snapshot.get("source_sha256") != source["sha256"]:
        raise ValueError("Channel metadata source identity is stale")
    return snapshot


def _channel_name(snapshot: dict[str, Any], index: int) -> str:
    channels = snapshot.get("channels")
    if not isinstance(channels, list) or not 0 <= index < len(channels):
        raise ValueError("Selected channel has no exact channel metadata")
    record = channels[index]
    if not isinstance(record, dict) or record.get("index") != index:
        raise ValueError("Channel metadata indices do not match acquisition order")
    name = checked_text(record.get("name"), "Channel name", 256)
    return f"{index + 1}: {name}"


def _puncta_settings(request: dict[str, Any]) -> tuple[dict[str, Any], int]:
    exact_keys(
        request,
        {
            "source_id",
            "selection",
            "sigma",
            "response_threshold",
            "raw_threshold",
            "minimum_distance",
            "aperture_radius",
            "exclude_border",
            "control",
            "working_bytes",
        },
        "puncta request",
    )
    required = {
        "sigma",
        "response_threshold",
        "raw_threshold",
        "minimum_distance",
        "aperture_radius",
        "exclude_border",
        "control",
    }
    if not required <= request.keys():
        raise ValueError("Puncta analysis requires every explicit scale, threshold and control")
    exclude_border = request["exclude_border"]
    if not isinstance(exclude_border, bool):
        raise ValueError("exclude_border must be an explicit boolean")
    settings = {
        "sigma": finite_number(request["sigma"], "sigma", 1e-9, 1e6),
        "response_threshold": finite_number(
            request["response_threshold"], "response_threshold", 0, 1e30
        ),
        "raw_threshold": finite_number(request["raw_threshold"], "raw_threshold", -1e30, 1e30),
        "minimum_distance": finite_number(request["minimum_distance"], "minimum_distance", 0, 1e6),
        "aperture_radius": finite_number(request["aperture_radius"], "aperture_radius", 1e-9, 1e6),
        "exclude_border": exclude_border,
        "control": checked_text(request["control"], "Puncta control/assumptions", 2048),
    }
    working_bytes = integer(
        request.get("working_bytes", DEFAULT_WORKING_BYTES),
        "working_bytes",
        1024,
        DEFAULT_WORKING_BYTES,
    )
    return settings, working_bytes


def _log_response(
    raw: np.ndarray, geometry: Geometry, sigma: float
) -> tuple[np.ndarray, tuple[float, ...]]:
    spacing = geometry.orthogonal_spacing()
    sigma_voxels = tuple(sigma / step for step in spacing)
    if min(sigma_voxels) < 0.5:
        raise ValueError("Physical sigma must span at least 0.5 voxel on every selected axis")
    if max(sigma_voxels) > MAX_SIGMA_VOXELS:
        raise ValueError("Physical sigma exceeds 256 voxels on at least one axis")
    values = raw.astype(np.float64, copy=False)
    response = np.zeros(raw.shape, dtype=np.float64)
    for axis, normalized_sigma in enumerate(sigma_voxels):
        order = [0] * raw.ndim
        order[axis] = 2
        response -= (
            ndi.gaussian_filter(
                values,
                sigma=sigma_voxels,
                order=tuple(order),
                mode="reflect",
                truncate=4.0,
            )
            * normalized_sigma**2
        )
    if not np.isfinite(response).all():
        raise ValueError("LoG response produced non-finite values")
    return response, sigma_voxels


def _plateau_candidates(
    response: np.ndarray,
    raw: np.ndarray,
    *,
    response_threshold: float,
    raw_threshold: float,
) -> list[tuple[int, tuple[int, ...], float, float]]:
    """Return one deterministic representative for each connected maximum plateau."""
    maximum = ndi.maximum_filter(response, size=3, mode="constant", cval=-np.inf)
    eligible = (response == maximum) & (response > response_threshold) & (raw > raw_threshold)
    components, count = ndi.label(
        eligible, structure=ndi.generate_binary_structure(response.ndim, response.ndim)
    )
    if count > MAX_CANDIDATES:
        raise ValueError(
            "Puncta candidate limit exceeded; choose a smaller crop or higher threshold"
        )
    candidates: list[tuple[int, tuple[int, ...], float, float]] = []
    for component, region in enumerate(ndi.find_objects(components), 1):
        if region is None:
            continue
        local_coordinates = np.argwhere(components[region] == component)
        starts = np.asarray([part.start for part in region], dtype=np.int64)
        coordinates = local_coordinates + starts
        values = response[tuple(coordinates.T)]
        best_response = float(values.max())
        tied = coordinates[values == best_response]
        flat = np.ravel_multi_index(tuple(tied.T), response.shape)
        winner = tied[int(np.argmin(flat))]
        index = tuple(int(value) for value in winner)
        flat_index = int(np.ravel_multi_index(index, response.shape))
        candidates.append((flat_index, index, best_response, float(raw[index])))
    return candidates


def _inside_physical_border(
    index: tuple[int, ...], shape: tuple[int, ...], spacing: tuple[float, ...], radius: float
) -> bool:
    return all(
        min(coordinate * step, (length - 1 - coordinate) * step) >= radius
        for coordinate, length, step in zip(index, shape, spacing, strict=True)
    )


def _physical_nms(
    candidates: list[tuple[int, tuple[int, ...], float, float]],
    geometry: Geometry,
    shape: tuple[int, ...],
    *,
    minimum_distance: float,
    aperture_radius: float,
    exclude_border: bool,
) -> list[dict[str, Any]]:
    spacing = geometry.orthogonal_spacing()
    ordered = sorted(candidates, key=lambda item: (-item[2], item[0]))
    if exclude_border:
        ordered = [
            item
            for item in ordered
            if _inside_physical_border(item[1], shape, spacing, aperture_radius)
        ]
    accepted: list[dict[str, Any]] = []
    buckets: dict[tuple[int, int, int], list[int]] = {}
    squared = minimum_distance**2
    for flat_index, index, response, raw in ordered:
        world = geometry.world(np.asarray([index]))[0]
        keep = True
        key = None
        if minimum_distance > 0:
            key = tuple(int(math.floor(value / minimum_distance)) for value in world)
            for offset in itertools.product((-1, 0, 1), repeat=3):
                neighbour = tuple(a + b for a, b in zip(key, offset, strict=True))
                for accepted_index in buckets.get(neighbour, []):
                    other = np.asarray(accepted[accepted_index]["world_xyz"])
                    if float(np.dot(world - other, world - other)) < squared:
                        keep = False
                        break
                if not keep:
                    break
        if not keep:
            continue
        if len(accepted) >= MAX_PEAKS:
            raise ValueError(
                "Puncta peak limit exceeded; choose a smaller crop or higher threshold"
            )
        accepted.append(
            {
                "label": len(accepted) + 1,
                "index": list(index),
                "index_axes": geometry.axes,
                "flat_index_c_order": flat_index,
                "world_xyz": world.tolist(),
                "world_frame": geometry.frame,
                "distance_unit": geometry.unit,
                "response": response,
                "raw": raw,
            }
        )
        if key is not None:
            buckets.setdefault(key, []).append(len(accepted) - 1)
    return accepted


def _puncta_labels(
    raw: np.ndarray,
    response: np.ndarray,
    peaks: list[dict[str, Any]],
    geometry: Geometry,
    *,
    raw_threshold: float,
    aperture_radius: float,
) -> np.ndarray:
    if not peaks:
        return np.zeros(raw.shape, dtype=np.uint32)
    markers = np.zeros(raw.shape, dtype=np.uint32)
    for peak in peaks:
        markers[tuple(peak["index"])] = peak["label"]
    distance = ndi.distance_transform_edt(markers == 0, sampling=geometry.orthogonal_spacing())
    candidate_regions = (raw > raw_threshold) & (distance <= aperture_radius)
    labels = watershed(
        -response,
        markers=markers,
        mask=candidate_regions,
        connectivity=ndi.generate_binary_structure(raw.ndim, 1),
    ).astype(np.uint32, copy=False)
    if int(labels.max(initial=0)) > MAX_PEAKS:
        raise RuntimeError("Puncta watershed produced an invalid label identity")
    return labels


def _overlay_png(raw: np.ndarray, peaks: list[dict[str, Any]]) -> tuple[str, str]:
    plane = raw.max(axis=0) if raw.ndim == 3 else raw
    low, high = float(plane.min()), float(plane.max())
    scaled = (
        np.zeros(plane.shape, dtype=np.uint8)
        if high == low
        else np.round(np.clip((plane - low) / (high - low), 0, 1) * 255).astype(np.uint8)
    )
    image = Image.fromarray(scaled, mode="L").convert("RGB")
    draw = ImageDraw.Draw(image)
    for peak in peaks:
        y, x = peak["index"][-2:]
        draw.ellipse((x - 2, y - 2, x + 2, y + 2), outline=(255, 48, 48), width=1)
        draw.point((x, y), fill=(255, 255, 0))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return (
        "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
        "maximum-intensity-projection" if raw.ndim == 3 else "selected-raw-plane",
    )


def _execute_puncta(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    preview: bool,
    job_id: str | None,
    publication_guard: Callable[[], None] | None,
) -> dict[str, Any]:
    settings, working_bytes = _puncta_settings(request)
    source_id = checked_id(request.get("source_id"))
    selection = workbench.selection(source_id, request.get("selection"))
    voxels = (
        selection["width"]
        * selection["height"]
        * (selection.get("z_stop", selection["z"] + 1) - selection["z"])
    )
    if voxels * PUNCTA_BYTES_PER_VOXEL > working_bytes:
        raise ValueError("Puncta selection exceeds the 192-bytes-per-voxel working-memory budget")
    raw_input, geometry, selection = workbench.load_scalar(
        source_id, selection, working_bytes=working_bytes
    )
    validate_array(raw_input, geometry=geometry, working_bytes=working_bytes)
    raw = raw_input.astype(np.float64, copy=True)
    source = workbench.project.source(source_id, verify=True)
    channel_metadata = _channel_snapshot(workbench, source_id)
    channel_name = _channel_name(channel_metadata, selection["c"])
    response, sigma_voxels = _log_response(raw, geometry, settings["sigma"])
    candidates = _plateau_candidates(
        response,
        raw,
        response_threshold=settings["response_threshold"],
        raw_threshold=settings["raw_threshold"],
    )
    peaks = _physical_nms(
        candidates,
        geometry,
        raw.shape,
        minimum_distance=settings["minimum_distance"],
        aperture_radius=settings["aperture_radius"],
        exclude_border=settings["exclude_border"],
    )
    labels = _puncta_labels(
        raw,
        response,
        peaks,
        geometry,
        raw_threshold=settings["raw_threshold"],
        aperture_radius=settings["aperture_radius"],
    )
    measurements = measure_objects(
        labels, geometry, {channel_name: raw}, working_bytes=working_bytes
    )
    method = {
        **settings,
        "sigma_voxels_array_axes": list(sigma_voxels),
        "spacing_array_axes": list(geometry.orthogonal_spacing()),
        "array_axes": geometry.axes,
        "response_formula": (
            "-sum_axis(gaussian_filter(raw, sigma=sigma/spacing, "
            "order=2_on_axis, mode=reflect, truncate=4)*(sigma/spacing_axis)^2)"
        ),
        "candidate_rule": (
            "strict response/raw thresholds; one representative per full-connectivity "
            "maximum plateau; highest response then lowest C-order index"
        ),
        "suppression_rule": (
            "highest response then lowest C-order index; suppress physical Euclidean "
            "distance strictly below minimum_distance"
        ),
        "region_rule": (
            "raw>raw_threshold within aperture_radius of an accepted peak; "
            "watershed(-response) with face connectivity"
        ),
        "limits": {
            "working_bytes_per_voxel": PUNCTA_BYTES_PER_VOXEL,
            "max_candidates": MAX_CANDIDATES,
            "max_peaks": MAX_PEAKS,
            "max_sigma_voxels_per_axis": MAX_SIGMA_VOXELS,
        },
        "interpretation": "bright puncta-like intensity maxima; no PSF or molecule inference",
    }
    from .workbench import result_summary, runtime_record

    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "channel_metadata": channel_metadata,
        "puncta": method,
        "peaks": peaks,
        "measurements": measurements,
        "measurement_basis": "raw-selected-channel intensity and physical result-grid regions",
        "measurement_channels": [selection["c"]],
        "runtime": runtime_record(),
        "references": {"source": {"source_id": source_id, "source_sha256": source["sha256"]}},
        "scientific_validation": "unvalidated descriptive research quantification",
    }
    if job_id is not None:
        provenance["job_id"] = job_id

    def final_guard() -> None:
        _guard(publication_guard)
        current = workbench.project.source(source_id, verify=True)
        if current["sha256"] != source["sha256"]:
            raise ValueError("Puncta source identity changed before publication")
        if not _same_record(_channel_snapshot(workbench, source_id), channel_metadata):
            raise ValueError("Puncta channel metadata changed before publication")

    final_guard()
    if preview:
        overlay, projection = _overlay_png(raw, peaks)
        return {
            "preview": True,
            "adopted": False,
            "overlay": overlay,
            "overlay_basis": projection,
            "object_count": len(measurements),
            "peaks": peaks[:1000],
            "total_peaks": len(peaks),
            "measurements": measurements[:1000],
            "provenance": {k: v for k, v in provenance.items() if k != "measurements"},
        }
    result = workbench.project.save_result(
        source_id=source_id,
        kind="puncta-quantification",
        arrays={"image": raw, "labels": labels, "response": response},
        provenance=provenance,
        job_id=job_id,
        publication_guard=final_guard,
    )
    return {
        "result": result_summary(result),
        "peaks": peaks[:1000],
        "total_peaks": len(peaks),
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def _artifact_decoded_bytes(descriptor: dict[str, Any]) -> int:
    try:
        shape = descriptor["shape"]
        dtype = np.dtype(descriptor["dtype"])
    except (KeyError, TypeError) as exc:
        raise ValueError("Result has an invalid array artifact descriptor") from exc
    if dtype.kind not in "buif" or not isinstance(shape, list):
        raise ValueError("Result has an invalid numeric array artifact descriptor")
    return (
        math.prod(integer(value, "artifact dimension", 1, 2**31 - 1) for value in shape)
        * dtype.itemsize
    )


def _bound_label_result(
    workbench: Workbench,
    binding: object,
    *,
    role: str,
    working_bytes: int,
) -> tuple[dict[str, Any], dict[str, np.ndarray], Geometry, dict[str, Any]]:
    exact_keys(binding, {"result_id", "revision_hash"}, f"{role} result binding")
    result = workbench.project.result(checked_id(binding.get("result_id")))
    if result["revision_hash"] != binding.get("revision_hash"):
        raise ValueError(f"{role.capitalize()} result revision is stale")
    if "image" not in result["arrays"] or "labels" not in result["arrays"]:
        raise ValueError(f"{role.capitalize()} result requires image and label artifacts")
    estimated = sum(_artifact_decoded_bytes(item) for item in result["arrays"].values())
    if estimated * 2 > working_bytes:
        raise ValueError(f"{role.capitalize()} result exceeds the association memory budget")
    source = workbench.project.source(result["source_id"], verify=True)
    if source["sha256"] != result["source_sha256"]:
        raise ValueError(f"{role.capitalize()} result source identity is stale")
    geometry_value = result.get("provenance", {}).get("geometry")
    selection = result.get("provenance", {}).get("selection")
    if not isinstance(geometry_value, dict) or not isinstance(selection, dict):
        raise ValueError(f"{role.capitalize()} result lacks exact geometry or selection")
    from .workbench import geometry_from_dict

    geometry = geometry_from_dict(geometry_value)
    arrays = {name: workbench.project.load_array(item) for name, item in result["arrays"].items()}
    labels = arrays["labels"]
    image = arrays["image"]
    if labels.dtype.kind not in "ui" or labels.shape != image.shape:
        raise ValueError(f"{role.capitalize()} labels must be integer values on the image grid")
    if labels.ndim != len(geometry.axes):
        raise ValueError(f"{role.capitalize()} result grid disagrees with its geometry")
    return result, arrays, geometry, source


def _result_binding(result: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "source_id": result["source_id"],
        "source_sha256": source["sha256"],
        "arrays": result["arrays"],
        "geometry": result["provenance"]["geometry"],
        "selection": result["provenance"]["selection"],
    }


def _selection_without_channel(selection: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in selection.items() if key != "c"}


def _execute_association(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None,
    publication_guard: Callable[[], None] | None,
) -> dict[str, Any]:
    exact_keys(
        request,
        {"nuclei", "cells", "roles", "control", "working_bytes"},
        "result association",
    )
    roles = request.get("roles")
    exact_keys(roles, {"nuclei", "cells"}, "association roles")
    nucleus_role = checked_text(roles.get("nuclei"), "Nucleus label role", 512)
    cell_role = checked_text(roles.get("cells"), "Cell label role", 512)
    if nucleus_role == cell_role:
        raise ValueError("Nucleus and cell label roles must be distinct declarations")
    control = checked_text(request.get("control"), "Association control/assumptions", 2048)
    working_bytes = integer(
        request.get("working_bytes", DEFAULT_WORKING_BYTES),
        "working_bytes",
        1024,
        8 * 1024**3,
    )
    nuclei, nucleus_arrays, nucleus_geometry, nucleus_source = _bound_label_result(
        workbench, request.get("nuclei"), role="nuclei", working_bytes=working_bytes
    )
    cells, cell_arrays, cell_geometry, cell_source = _bound_label_result(
        workbench, request.get("cells"), role="cells", working_bytes=working_bytes
    )
    if nuclei["id"] == cells["id"]:
        raise ValueError("Association requires two distinct result revisions")
    if (
        nuclei["source_id"] != cells["source_id"]
        or nucleus_source["sha256"] != cell_source["sha256"]
    ):
        raise ValueError(
            "Nucleus and cell results must belong to the same exact source acquisition"
        )
    if nuclei["arrays"]["labels"]["sha256"] == cells["arrays"]["labels"]["sha256"]:
        raise ValueError("Association requires distinct nucleus and cell label artifacts")
    if not _same_record(nucleus_geometry.to_dict(), cell_geometry.to_dict()):
        raise ValueError("Nucleus and cell results must share the exact physical grid")
    nucleus_selection = nuclei["provenance"]["selection"]
    cell_selection = cells["provenance"]["selection"]
    if not _same_record(
        _selection_without_channel(nucleus_selection), _selection_without_channel(cell_selection)
    ):
        raise ValueError("Nucleus and cell results must share acquisition, time and crop")
    if nucleus_arrays["labels"].shape != cell_arrays["labels"].shape:
        raise ValueError("Nucleus and cell labels must share exactly the same array grid")
    metadata_at_association = _channel_snapshot(workbench, cells["source_id"])
    channel_metadata = copy.deepcopy(
        cells["provenance"].get("channel_metadata") or metadata_at_association
    )
    memory = (
        sum(array.nbytes for arrays in (nucleus_arrays, cell_arrays) for array in arrays.values())
        + cell_arrays["labels"].size * 96
    )
    if memory > working_bytes:
        raise ValueError(
            "Association fields and measurements exceed the combined working-memory budget"
        )
    associations = associate_labels(nucleus_arrays["labels"], cell_arrays["labels"])
    measurements = copy.deepcopy(cells["provenance"].get("measurements", []))
    if measurements:
        ids = [row.get("label") for row in measurements]
        positive_ids = [int(label) for label in np.unique(cell_arrays["labels"]) if label]
        if sorted(ids) != positive_ids:
            raise ValueError("Cell measurement rows do not match the exact label field")
        measurement_basis = cells["provenance"].get(
            "measurement_basis", "retained exact parent measurement records"
        )
    else:
        measurements = measure_objects(
            cell_arrays["labels"], cell_geometry, working_bytes=working_bytes
        )
        measurement_basis = "physical-label-grid-only; no verified parent intensity measurements"

    by_cell: dict[int, list[dict[str, Any]]] = {}
    for row in associations:
        if row["cell_label"] is not None:
            by_cell.setdefault(row["cell_label"], []).append(row)
    for row in measurements:
        linked = by_cell.get(row["label"], [])
        row["association"] = {
            "nucleus_labels": [item["nucleus_label"] for item in linked],
            "nucleus_count": len(linked),
            "ambiguous_nucleus_labels": [
                item["nucleus_label"] for item in linked if item["ambiguous"]
            ],
            "rule": "largest-overlap per nucleus; unassigned nuclei remain in associations",
        }
    nucleus_binding = _result_binding(nuclei, nucleus_source)
    cell_binding = _result_binding(cells, cell_source)
    from .workbench import result_summary, runtime_record

    provenance = {
        **{
            key: value
            for key, value in copy.deepcopy(cells["provenance"]).items()
            if key != "job_id"
        },
        "geometry": cell_geometry.to_dict(),
        "selection": cell_selection,
        "channel_metadata": channel_metadata,
        "association_inputs": {"nuclei": nucleus_binding, "cells": cell_binding},
        "association": {
            "roles": {"nuclei": nucleus_role, "cells": cell_role},
            "control": control,
            "rows": associations,
            "rule": "largest observed overlap; equal overlap resolves to lowest cell label ID",
            "interpretation": "declared label-field association; no biological identity inference",
        },
        "measurements": measurements,
        "measurement_basis": measurement_basis,
        "association_measurement_policy": (
            "retain exact cell-parent measurements and add nucleus overlap links"
        ),
        "runtime": runtime_record(),
        "references": {
            **cells["provenance"].get("references", {}),
            "nuclei_source": {
                "source_id": nuclei["source_id"],
                "source_sha256": nucleus_source["sha256"],
            },
            "cells_source": {
                "source_id": cells["source_id"],
                "source_sha256": cell_source["sha256"],
            },
        },
        "scientific_validation": "unvalidated descriptive research association",
    }
    if job_id is not None:
        provenance["job_id"] = job_id

    def final_guard() -> None:
        _guard(publication_guard)
        for role, expected in (("nuclei", nucleus_binding), ("cells", cell_binding)):
            current = workbench.project.result(expected["result_id"])
            if current["revision_hash"] != expected["revision_hash"]:
                raise ValueError(f"Bound {role} result changed before publication")
            source = workbench.project.source(current["source_id"], verify=True)
            if source["sha256"] != expected["source_sha256"]:
                raise ValueError(f"Bound {role} source changed before publication")
            if not _same_record(current["arrays"], expected["arrays"]):
                raise ValueError(f"Bound {role} artifact set changed before publication")
            for descriptor in current["arrays"].values():
                workbench.project.verify_array(descriptor)
        if not _same_record(
            _channel_snapshot(workbench, cells["source_id"]), metadata_at_association
        ):
            raise ValueError("Association channel metadata changed before publication")

    final_guard()
    result = workbench.project.save_result(
        source_id=cells["source_id"],
        kind="nucleus-cell-association",
        arrays={**cell_arrays, "nuclei_labels": nucleus_arrays["labels"]},
        provenance=provenance,
        parent_id=cells["id"],
        job_id=job_id,
        publication_guard=final_guard,
    )
    return {
        "result": result_summary(result),
        "associations": associations[:1000],
        "total_associations": len(associations),
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def _execute_colocalisation(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None,
    publication_guard: Callable[[], None] | None,
) -> dict[str, Any]:
    exact_keys(
        request,
        {
            "source_id",
            "selection",
            "first_channel",
            "second_channel",
            "threshold_first",
            "threshold_second",
            "control",
            "working_bytes",
        },
        "colocalisation run",
    )
    source_id = checked_id(request.get("source_id"))
    first_channel = integer(request.get("first_channel"), "first_channel", 0, 255)
    second_channel = integer(request.get("second_channel"), "second_channel", 0, 255)
    if first_channel == second_channel:
        raise ValueError("Colocalisation requires two distinct acquisition channels")
    control = checked_text(request.get("control"), "Colocalisation control/assumptions", 2048)
    working_bytes = integer(
        request.get("working_bytes", DEFAULT_WORKING_BYTES),
        "working_bytes",
        1024,
        DEFAULT_WORKING_BYTES,
    )
    selection = workbench.selection(
        source_id, {**(request.get("selection") or {}), "c": first_channel}
    )
    voxels = (
        selection["width"]
        * selection["height"]
        * (selection.get("z_stop", selection["z"] + 1) - selection["z"])
    )
    if voxels * 64 > working_bytes:
        raise ValueError("Colocalisation selection exceeds its bounded working-memory budget")
    first_input, geometry, first_selection = workbench.load_scalar(
        source_id, selection, working_bytes=working_bytes
    )
    second_input, second_geometry, second_selection = workbench.load_scalar(
        source_id,
        {**first_selection, "c": second_channel},
        strict=False,
        working_bytes=working_bytes,
    )
    if not _same_record(geometry.to_dict(), second_geometry.to_dict()) or not _same_record(
        _selection_without_channel(first_selection), _selection_without_channel(second_selection)
    ):
        raise ValueError("Colocalisation channels must share the exact acquisition grid")
    validate_array(first_input, geometry=geometry, working_bytes=working_bytes)
    validate_array(second_input, geometry=second_geometry, working_bytes=working_bytes)
    first = first_input.astype(np.float64, copy=True)
    second = second_input.astype(np.float64, copy=True)
    metrics = colocalisation(
        first,
        second,
        threshold_first=request.get("threshold_first"),
        threshold_second=request.get("threshold_second"),
    )
    source = workbench.project.source(source_id, verify=True)
    channel_metadata = _channel_snapshot(workbench, source_id)
    first_name = _channel_name(channel_metadata, first_channel)
    second_name = _channel_name(channel_metadata, second_channel)
    from .workbench import result_summary, runtime_record

    provenance = {
        "geometry": geometry.to_dict(),
        "selection": first_selection,
        "paired_selection": second_selection,
        "channel_metadata": channel_metadata,
        "colocalisation": {
            **metrics,
            "first_channel": {"index": first_channel, "name": first_name},
            "second_channel": {"index": second_channel, "name": second_name},
            "control": control,
            "pixel_p_value": "not-calculated",
            "interpretation": "descriptive spatial association; no molecular interaction inference",
        },
        "measurements": [],
        "measurement_basis": "exact paired raw source-channel intensities on one selected grid",
        "runtime": runtime_record(),
        "references": {"source": {"source_id": source_id, "source_sha256": source["sha256"]}},
        "scientific_validation": "unvalidated descriptive research quantification",
    }
    if job_id is not None:
        provenance["job_id"] = job_id

    def final_guard() -> None:
        _guard(publication_guard)
        current = workbench.project.source(source_id, verify=True)
        if current["sha256"] != source["sha256"]:
            raise ValueError("Colocalisation source identity changed before publication")
        if not _same_record(_channel_snapshot(workbench, source_id), channel_metadata):
            raise ValueError("Colocalisation channel metadata changed before publication")

    final_guard()
    result = workbench.project.save_result(
        source_id=source_id,
        kind="colocalisation",
        arrays={"image": first, "paired_image": second},
        provenance=provenance,
        job_id=job_id,
        publication_guard=final_guard,
    )
    return {"result": result_summary(result), "metrics": metrics, "adopted": True}


def execute_quantification(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Execute one bounded quantitative operation against exact local inputs."""
    if operation not in QUANTIFICATION_OPERATIONS or not isinstance(request, dict):
        raise ValueError("Unknown or invalid quantification operation")
    if operation in {"puncta_preview", "puncta_run"}:
        return _execute_puncta(
            workbench,
            request,
            preview=operation == "puncta_preview",
            job_id=job_id,
            publication_guard=publication_guard,
        )
    if operation == "associate_results":
        return _execute_association(
            workbench, request, job_id=job_id, publication_guard=publication_guard
        )
    return _execute_colocalisation(
        workbench, request, job_id=job_id, publication_guard=publication_guard
    )
