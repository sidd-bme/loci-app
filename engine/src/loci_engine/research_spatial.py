"""Revision-bound sampled tissue distance bands; no anatomical boundary inference."""

from __future__ import annotations

import copy
import math

import numpy as np

from .quantitative import exact_keys, integer, validate_array
from .research_project import SHA_PATTERN, canonical_json, checked_id, checked_text
from .spatial_measurements import estimated_working_bytes

KIND = "spatial-distance-bands"
SCHEMA = "loci.spatial-distance-bands/v1"
ROLES = ("objects", "compartment", "boundary")
KEYS = {
    "result_id",
    "revision_hash",
    "compartment",
    "boundary",
    "band_edges",
    "exclude_crop_border",
    "control",
    "boundary_coverage",
    "working_bytes",
}
RULES = {
    "distance": "Euclidean distance to declared boundary pixel centers, not tissue thickness",
    "membership": "Object centroid containing pixel floor(index + 0.5); ties toward higher index",
    "bands": "Half-open [lower, upper); final upper endpoint excluded",
    "area": "Sampled compartment pixels in each distance band, including boundary overlap",
    "coverage": "Only the declared boundary subset; unseen boundary outside crop is not inferred",
    "density": "Eligible object count / sampled compartment area; zero area is undefined",
    "aggregation": "One field only; objects are not independent biological replicates",
}


def _same(a, b):
    return canonical_json(a) == canonical_json(b)


def validate_settings(request):
    exact_keys(request, KEYS, "spatial distance request")
    if set(request) != KEYS:
        raise ValueError("Spatial distance requires every explicit input and coverage field")
    integer(request["working_bytes"], "working_bytes", 1024**2, 8 * 1024**3)
    for key in ("control", "boundary_coverage"):
        checked_text(request[key], key, 2048)
    if type(request["exclude_crop_border"]) is not bool:
        raise ValueError("Choose an explicit crop-border exclusion policy")
    edges = request["band_edges"]
    if not isinstance(edges, list) or not 2 <= len(edges) <= 33:
        raise ValueError("Choose 1-32 bounded distance bands")
    if any(
        type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1e12 for v in edges
    ) or any(a >= b for a, b in zip(edges, edges[1:], strict=False)):
        raise ValueError("Band edges must be finite, nonnegative and strictly increasing")
    for binding in (
        {k: request[k] for k in ("result_id", "revision_hash")},
        request["compartment"],
        request["boundary"],
    ):
        exact_keys(binding, {"result_id", "revision_hash"}, "spatial input")
        checked_id(binding.get("result_id"))
        if not isinstance(binding.get("revision_hash"), str) or not SHA_PATTERN.fullmatch(
            binding["revision_hash"]
        ):
            raise ValueError("Spatial input requires an exact revision hash")


def validate_request(workbench, request):
    from .workbench import geometry_from_dict

    validate_settings(request)
    bindings = [
        {k: request[k] for k in ("result_id", "revision_hash")},
        request["compartment"],
        request["boundary"],
    ]
    parents = [workbench.project.result(b["result_id"]) for b in bindings]
    for parent, binding in zip(parents, bindings, strict=True):
        if parent["revision_hash"] != binding["revision_hash"]:
            raise ValueError("Spatial input revision is stale")
        if (
            parent["schema"] != "loci.research-result/v1"
            or not {"image", "labels"} <= set(parent["arrays"])
            or "spatial" in parent["provenance"]
        ):
            raise ValueError("Choose underlying bounded image/label results for spatial inputs")
        source = workbench.project.source(parent["source_id"], verify=True)
        if source["sha256"] != parent["source_sha256"]:
            raise ValueError("Spatial source fingerprint changed")
    first = parents[0]
    if first["kind"] not in {
        "segmentation",
        "cell-segmentation",
        "adaptive-segmentation",
        "cellpose-segmentation",
        "model-segmentation",
        "external-labels",
        "corrected-labels",
    } or any(
        k in first["provenance"]
        for k in (
            "derived_measurement_arrays",
            "stain_separation",
            "association",
            "perinuclear",
            "tracking",
            "spatial",
        )
    ):
        raise ValueError("Spatial objects require underlying scalar object measurements")
    geometry = geometry_from_dict(first["provenance"]["geometry"])
    if geometry.axes != "YX" or geometry.unit == "pixel":
        raise ValueError("Spatial distance bands require calibrated physical YX geometry")
    geometry.orthogonal_spacing()
    selection = first["provenance"].get("selection")
    if not isinstance(selection, dict) or "z_stop" in selection:
        raise ValueError("Spatial inputs require an exact single-plane selection")
    plane = {k: v for k, v in selection.items() if k != "c"}
    shape = first["arrays"]["labels"]["shape"]
    for parent in parents:
        if (
            parent["source_id"] != first["source_id"]
            or parent["source_sha256"] != first["source_sha256"]
            or not _same(parent["provenance"].get("geometry"), geometry.to_dict())
            or not _same(
                {k: v for k, v in parent["provenance"].get("selection", {}).items() if k != "c"},
                plane,
            )
            or parent["arrays"]["labels"]["shape"] != shape
            or parent["arrays"]["image"]["shape"] != shape
        ):
            raise ValueError("Spatial inputs must share the exact source, plane and physical grid")
    for parent in parents:
        if np.dtype(parent["arrays"]["labels"]["dtype"]).kind not in "ui":
            raise ValueError("Spatial masks must retain nonnegative integer labels")
    retained = sum(p["arrays"]["labels"]["bytes"] for p in parents)
    retained += first["arrays"]["image"]["bytes"]
    metadata = sum(len(canonical_json(p).encode()) for p in parents) * 16
    if retained + metadata + estimated_working_bytes(math.prod(shape)) > request["working_bytes"]:
        raise ValueError("Spatial inputs exceed aggregate working-memory budget before decode")
    return parents, geometry


def validate_record(result):
    if result.get("kind") != KIND and "spatial" not in result.get("provenance", {}):
        return
    p = result["provenance"]
    record = p.get("spatial", {})
    if (
        result.get("kind") != KIND
        or record.get("schema") != SCHEMA
        or not _same(record.get("rules"), RULES)
        or set(result["arrays"])
        != {"image", "labels", "compartment_labels", "boundary_labels", "distance_bands"}
    ):
        raise ValueError("Invalid persisted spatial contract")
    validate_settings(p["accepted_request"])
    bindings = record.get("inputs")
    if not isinstance(bindings, dict) or set(bindings) != set(ROLES):
        raise ValueError("Spatial input identities are missing")
    for role in ROLES:
        binding = bindings[role]
        checked_id(binding.get("result_id"))
        for key in ("revision_hash", "labels_sha256"):
            if not isinstance(binding.get(key), str) or not SHA_PATTERN.fullmatch(binding[key]):
                raise ValueError("Spatial input identity is invalid")
        array = "labels" if role == "objects" else f"{role}_labels"
        if result["arrays"][array]["sha256"] != binding["labels_sha256"]:
            raise ValueError("Spatial retained mask differs from its bound input")
        requested = p["accepted_request"] if role == "objects" else p["accepted_request"][role]
        if any(binding[k] != requested[k] for k in ("result_id", "revision_hash")):
            raise ValueError("Spatial request and retained dependencies disagree")
    if result.get("parent_id") != bindings["objects"]["result_id"]:
        raise ValueError("Spatial parent identity disagrees")
    from .workbench import geometry_from_dict

    geometry = geometry_from_dict(p["geometry"])
    if (
        geometry.axes != "YX"
        or geometry.unit == "pixel"
        or record.get("distance_unit") != geometry.unit
        or record.get("area_unit") != f"{geometry.unit}^2"
    ):
        raise ValueError("Spatial units disagree with physical geometry")
    geometry.orthogonal_spacing()
    shapes = [item["shape"] for item in result["arrays"].values()]
    if any(shape != shapes[0] or len(shape) != 2 for shape in shapes):
        raise ValueError("Spatial arrays must share one YX shape")
    if estimated_working_bytes(math.prod(shapes[0])) > p["accepted_request"]["working_bytes"]:
        raise ValueError("Persisted spatial masks exceed working-memory budget")


def validate_parents(result, results):
    validate_record(result)
    p = result["provenance"]
    parents = {}
    for role, binding in p["spatial"]["inputs"].items():
        parent = results.get(binding["result_id"])
        if parent is None or parent["revision_hash"] != binding["revision_hash"]:
            raise ValueError("Spatial dependency is missing or stale")
        if (
            parent["source_id"] != result["source_id"]
            or parent["source_sha256"] != result["source_sha256"]
            or not _same(parent["provenance"]["geometry"], p["geometry"])
            or not _same(
                {k: v for k, v in parent["provenance"]["selection"].items() if k != "c"},
                {k: v for k, v in p["selection"].items() if k != "c"},
            )
            or parent["arrays"]["labels"]["sha256"] != binding["labels_sha256"]
        ):
            raise ValueError("Spatial dependency source, grid or mask disagrees")
        parents[role] = parent
    original = parents["objects"]
    if not _same(p.get("object_analysis"), original["provenance"]):
        raise ValueError("Spatial object analysis lost its exact parent provenance")
    rows = [{k: v for k, v in row.items() if k != "spatial"} for row in p["measurements"]]
    originals = sorted(original["provenance"]["measurements"], key=lambda row: row["label"])
    if not _same(rows, originals) or result["arrays"]["image"] != original["arrays"]["image"]:
        raise ValueError("Spatial object measurements differ from exact parent")


def validate_arrays(result, arrays):
    from .spatial_measurements import measure_distance_bands
    from .workbench import geometry_from_dict

    validate_record(result)
    request = result["provenance"]["accepted_request"]
    geometry = geometry_from_dict(result["provenance"]["geometry"])
    for name in ("labels", "compartment_labels", "boundary_labels"):
        validate_array(
            arrays[name], geometry=geometry, labels=True, working_bytes=request["working_bytes"]
        )
    rows, bands, mask = measure_distance_bands(
        arrays["labels"],
        arrays["compartment_labels"] > 0,
        arrays["boundary_labels"] > 0,
        geometry_from_dict(result["provenance"]["geometry"]),
        request["band_edges"],
        exclude_crop_border=request["exclude_crop_border"],
        working_bytes=request["working_bytes"],
    )
    measurements = result["provenance"]["measurements"]
    stored = [{"label": row["label"], **row["spatial"]} for row in measurements]
    if not _same(rows, stored) or not _same(bands, result["provenance"]["spatial"]["bands"]):
        raise ValueError("Spatial measurements disagree with retained masks")
    if not np.array_equal(mask, arrays["distance_bands"]):
        raise ValueError("Spatial distance band mask disagrees")


def execute_spatial(workbench, request, *, job_id=None, publication_guard=None):
    from .spatial_measurements import measure_distance_bands
    from .workbench import result_summary, runtime_record

    parents, geometry = validate_request(workbench, request)
    objects, compartment, boundary = parents
    arrays = {
        "image": workbench.project.load_array(objects["arrays"]["image"]),
        "labels": workbench.project.load_array(objects["arrays"]["labels"]),
        "compartment_labels": workbench.project.load_array(compartment["arrays"]["labels"]),
        "boundary_labels": workbench.project.load_array(boundary["arrays"]["labels"]),
    }
    for name in ("labels", "compartment_labels", "boundary_labels"):
        validate_array(
            arrays[name], geometry=geometry, labels=True, working_bytes=request["working_bytes"]
        )
    rows, bands, arrays["distance_bands"] = measure_distance_bands(
        arrays["labels"],
        arrays["compartment_labels"] > 0,
        arrays["boundary_labels"] > 0,
        geometry,
        request["band_edges"],
        exclude_crop_border=request["exclude_crop_border"],
        working_bytes=request["working_bytes"],
    )
    original_rows = objects["provenance"].get("measurements", [])
    original = {row["label"]: row for row in original_rows}
    if len(original) != len(original_rows) or set(original) != {r["label"] for r in rows}:
        raise ValueError("Spatial objects require complete exact parent measurements")
    measurements = [
        {
            **copy.deepcopy(original[row["label"]]),
            "spatial": {k: v for k, v in row.items() if k != "label"},
        }
        for row in rows
    ]
    record = {
        "schema": SCHEMA,
        "rules": RULES,
        "bands": bands,
        "distance_unit": geometry.unit,
        "area_unit": f"{geometry.unit}^2",
        "inputs": {
            role: {
                "result_id": p["id"],
                "revision_hash": p["revision_hash"],
                "labels_sha256": p["arrays"]["labels"]["sha256"],
            }
            for role, p in zip(ROLES, parents, strict=True)
        },
    }
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": objects["provenance"]["selection"],
        "accepted_request": copy.deepcopy(request),
        "spatial": record,
        "measurements": measurements,
        "runtime": runtime_record(),
        "object_analysis": copy.deepcopy(objects["provenance"]),
        "scientific_validation": "unvalidated-research-method",
        "measurement_basis": "Exact parent object measurements and declared-mask distances",
        "parent_result": {"result_id": objects["id"], "revision_hash": objects["revision_hash"]},
    }
    # All dependency identities are rechecked immediately before atomic publication.
    validate_request(workbench, request)
    result = workbench.project.save_result(
        source_id=objects["source_id"],
        kind=KIND,
        arrays=arrays,
        provenance=provenance,
        parent_id=objects["id"],
        job_id=job_id,
        publication_guard=publication_guard,
    )
    return {
        "result": result_summary(result),
        "measurements": measurements[:1000],
        "spatial": record,
    }
