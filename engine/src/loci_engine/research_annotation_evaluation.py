"""Immutable source/grid-bound annotation agreement and frozen vector references.

Shared dispatch, job authority, review and export hooks are owned by callers.
Cold validation uses saved source metadata and content-addressed artifacts only;
source decoding occurs only when creating a new reference or comparison.
"""

from __future__ import annotations

import copy
import hashlib
import math
import sys
from pathlib import Path

import numpy as np
from skimage.draw import polygon2mask

from .annotation_evaluation import (
    RULES,
    compare_labels,
    estimated_working_bytes,
)
from .annotation_evaluation import (
    SCHEMA as KERNEL_SCHEMA,
)
from .annotation_evaluation import (
    validate_settings as validate_kernel_settings,
)
from .quantitative import MAX_WORKING_BYTES, Geometry, exact_keys, integer
from .research_data_tables import _finite_tree
from .research_project import (
    MAX_ARTIFACT_BYTES,
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
)

KIND = "annotation-agreement"
REFERENCE_KIND = "annotation-reference"
SCHEMA = "loci.annotation-agreement/v1"
REFERENCE_SCHEMA = "loci.annotation-reference/v1"
CORRECTION_REFUSAL = (
    "Edit the underlying labels or source annotations and save a new reference or agreement"
)
REQUEST_KEYS = {
    "result_id",
    "revision_hash",
    "reference",
    "semantics",
    "iou_thresholds",
    "reference_declaration",
    "working_bytes",
}
REFERENCE_REQUEST_KEYS = {
    "result_id",
    "revision_hash",
    "source_annotations_revision",
    "annotation_ids",
    "semantics",
    "coverage_declaration",
    "working_bytes",
}
PARENT_KINDS = {
    "segmentation",
    "cell-segmentation",
    "adaptive-segmentation",
    "cellpose-segmentation",
    "model-segmentation",
    "external-labels",
    "corrected-labels",
    "tissue-model-regions",
    "controlled-method",
    REFERENCE_KIND,
}
REFERENCE_RULES = {
    "coordinates": "Saved level0-pixel-edges minus crop origin minus 0.5 yields voxel centers",
    "raster": "Pixel center inside or on the closed polygon boundary",
    "instances": (
        "One positive ID per selected annotation, in sorted annotation-ID order; overlap refused"
    ),
    "region": "Union of selected closed polygons; all foreground has ID 1",
    "scope": (
        "Exact selected level-zero YX crop and Z/T; no clipping, interpolation or inferred coverage"
    ),
    "history": (
        "Selected annotation snapshot and revision are frozen; "
        "later edits do not replace this reference"
    ),
    "interpretation": "User-declared reference, not biological ground truth or human approval",
}


def _same(a, b):
    return canonical_json(a) == canonical_json(b)


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _exact(value, keys, name):
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"{name} requires exactly its declared fields")


def _sha(value):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Annotation agreement requires an exact SHA-256 identity")


def _binding(record):
    return {"result_id": record["id"], "revision_hash": record["revision_hash"]}


def _binding_value(binding):
    _exact(binding, {"result_id", "revision_hash"}, "annotation result binding")
    checked_id(binding["result_id"])
    _sha(binding["revision_hash"])


def _geometry(value):
    _exact(value, {"axes", "affine", "unit", "frame"}, "annotation geometry")
    try:
        geometry = Geometry(
            value["axes"], tuple(map(tuple, value["affine"])), value["unit"], value["frame"]
        )
    except (TypeError, OverflowError) as exc:
        raise ValueError("Annotation geometry is invalid") from exc
    if geometry.axes != "YX":
        raise ValueError("Annotation agreement initially requires a single YX plane")
    return geometry


def _descriptor(value, *, labels=False):
    _exact(value, {"sha256", "bytes", "shape", "dtype"}, "annotation array descriptor")
    _sha(value["sha256"])
    shape = value["shape"]
    if not isinstance(shape, list) or len(shape) != 2:
        raise ValueError("Annotation arrays require explicit YX dimensions")
    for length in shape:
        integer(length, "annotation dimension", 1, 2**31 - 1)
    try:
        dtype = np.dtype(value["dtype"])
    except (TypeError, ValueError) as exc:
        raise ValueError("Annotation array dtype is invalid") from exc
    if not isinstance(value["dtype"], str) or dtype.kind not in "buif" or dtype.itemsize > 8:
        raise ValueError("Annotation images must be real finite scalar arrays")
    if labels and dtype != np.uint32:
        raise ValueError("Annotation labels must retain exact uint32 IDs")
    decoded = math.prod(shape) * dtype.itemsize
    integer(value["bytes"], "artifact bytes", 1, MAX_ARTIFACT_BYTES + 4096)
    if decoded > MAX_ARTIFACT_BYTES or not decoded < value["bytes"] <= decoded + 4096:
        raise ValueError("Annotation artifact size disagrees with its scalar grid")


def _base(record, *, hashed=True, derivative=False):
    if not isinstance(record, dict) or record.get("schema") != "loci.research-result/v1":
        raise ValueError("Annotation agreement requires bounded immutable result arrays")
    checked_id(record.get("id"))
    checked_id(record.get("source_id"))
    _sha(record.get("source_sha256"))
    if hashed or "revision_hash" in record:
        _sha(record.get("revision_hash"))
        if record["revision_hash"] != _hash(
            {k: v for k, v in record.items() if k != "revision_hash"}
        ):
            raise ValueError("Annotation result revision failed integrity verification")
    _finite_tree(record)
    p = record.get("provenance")
    if not isinstance(p, dict):
        raise ValueError("Annotation result provenance is missing")
    geometry = _geometry(p.get("geometry"))
    arrays = record.get("arrays")
    required = {"image", "labels", "reference_labels"} if derivative else {"image", "labels"}
    if (
        not isinstance(arrays, dict)
        or not required <= set(arrays)
        or (derivative and set(arrays) != required)
    ):
        raise ValueError("Annotation result is missing its exact retained grids")
    for name in required:
        _descriptor(arrays[name], labels=name != "image")
    shape = arrays["labels"]["shape"]
    if any(arrays[name]["shape"] != shape for name in required):
        raise ValueError("Annotation image and label grids differ")
    selection = p.get("selection")
    _exact(selection, {"x", "y", "width", "height", "c", "z", "t", "level"}, "annotation selection")
    for key, value in selection.items():
        integer(value, f"selection {key}", 1 if key in {"width", "height"} else 0, 2**31 - 1)
    if selection["level"] != 0 or shape != [selection["height"], selection["width"]]:
        raise ValueError("Annotation agreement requires the exact level-zero single-plane crop")
    return geometry


def _parent(record, semantics):
    geometry = _base(record)
    if record.get("kind") not in PARENT_KINDS or "annotation_evaluation" in record["provenance"]:
        raise ValueError("Choose underlying saved label results, not an agreement derivative")
    p = record["provenance"]
    if semantics == "instances" and "tissue_model" in p:
        raise ValueError("Tissue compartment regions cannot implicitly become object instances")
    if record["kind"] == REFERENCE_KIND:
        validate_record(record)
        if semantics is not None and p["annotation_reference"]["semantics"] != semantics:
            raise ValueError("Frozen annotation-reference semantics differ from this comparison")
    return geometry


def validate_settings(request):
    _exact(request, REQUEST_KEYS, "annotation evaluation request")
    _binding_value({k: request[k] for k in ("result_id", "revision_hash")})
    _binding_value(request["reference"])
    validate_kernel_settings(request["semantics"], request["iou_thresholds"])
    checked_text(request["reference_declaration"], "Reference declaration", 2048)
    integer(request["working_bytes"], "working_bytes", 1024**2, MAX_WORKING_BYTES)


def _reference_settings(request):
    _exact(request, REFERENCE_REQUEST_KEYS, "annotation reference request")
    _binding_value({k: request[k] for k in ("result_id", "revision_hash")})
    integer(request["source_annotations_revision"], "source annotations revision", 1, 2**31 - 1)
    ids = request["annotation_ids"]
    if not isinstance(ids, list) or not 1 <= len(ids) <= 1000:
        raise ValueError("Choose 1-1000 explicit closed source annotation IDs")
    for identity in ids:
        checked_id(identity)
    if len(ids) != len(set(ids)):
        raise ValueError("Source annotation IDs must be unique")
    validate_kernel_settings(
        request["semantics"], [0.5] if request["semantics"] == "instances" else []
    )
    checked_text(request["coverage_declaration"], "Reference coverage declaration", 2048)
    integer(request["working_bytes"], "working_bytes", 1024**2, MAX_WORKING_BYTES)


def validate_source(result, source):
    """Pure saved-source scope check; no decoder or access to current annotation history."""
    from .research_morphometrics import validate_source as validate_source_scope

    validate_source_scope(result, source)
    if source.get("source_kind") == "native":
        from .native_image import (
            NativeDimensions,
            NativeLevel,
            PhysicalCalibration,
            native_geometry,
        )

        saved = source["metadata"]["levels"][0]
        calibration = saved["calibration"]
        level = NativeLevel(
            index=saved["index"],
            dimensions=NativeDimensions(**saved["dimensions"]),
            calibration=PhysicalCalibration(**calibration) if calibration is not None else None,
            origin_xyz=saved.get("origin_xyz"),
        )
        selection = result["provenance"]["selection"]
        expected = native_geometry((level,), selection, False)
        if not _same(expected.to_dict(), result["provenance"]["geometry"]):
            raise ValueError("Annotation geometry differs from registered native calibration")
        if result.get("kind") == REFERENCE_KIND:
            receipt = result["provenance"]["annotation_reference"]
            planar = native_geometry((level,), {**selection, "x": 0, "y": 0}, False)
            raw = native_geometry(
                (level,), {**selection, "x": 0, "y": 0, "z": 0}, level.dimensions.z > 1
            )
            if not _same(planar.to_dict(), receipt["source_planar_geometry"]) or not _same(
                raw.to_dict(), receipt["source_geometry"]
            ):
                raise ValueError(
                    "Frozen annotation coordinate receipts differ from registered native geometry"
                )
    if result.get("kind") == REFERENCE_KIND:
        metadata = source.get("metadata", {})
        if source.get("source_kind") == "medical":
            shape = metadata["shape"]
            dimensions = {
                "x": shape[-1],
                "y": shape[-2],
                "z": shape[0] if len(shape) == 3 else 1,
                "t": 1,
            }
        else:
            dimensions = {k: metadata.get("dimensions", {}).get(k) for k in ("x", "y", "z", "t")}
        if not _same(result["provenance"]["annotation_reference"]["source_dimensions"], dimensions):
            raise ValueError(
                "Frozen source annotation dimensions differ from the registered source"
            )


def _planar_geometry(workbench, source, selection):
    if source.get("source_kind") == "medical":
        from .workbench import geometry_from_dict

        geometry = geometry_from_dict(source["metadata"]["geometry"])
        geometry = geometry.cropped(
            tuple(selection[k] for k in ("z", "y", "x")[-len(geometry.axes) :])
        )
        geometry = Geometry("YX", geometry.affine, geometry.unit, geometry.frame)
    else:
        geometry = workbench._native_geometry(workbench._session(source["id"]), selection, False)
    return geometry


def _source_geometry(workbench, record):
    source = workbench.project.source(record["source_id"], verify=True)
    validate_source(record, source)
    selection = record["provenance"]["selection"]
    if not _same(workbench.selection(source["id"], selection), selection):
        raise ValueError("Annotation source selection changed during resolution")
    geometry = _planar_geometry(workbench, source, selection)
    if not _same(geometry.to_dict(), record["provenance"]["geometry"]):
        raise ValueError("Annotation affine/calibration differs from the exact source grid")
    return source


def _aligned(parent, reference):
    if (
        any(parent[k] != reference[k] for k in ("source_id", "source_sha256"))
        or any(
            not _same(parent["provenance"].get(k), reference["provenance"].get(k))
            for k in ("selection", "geometry")
        )
        or parent["arrays"]["labels"]["shape"] != reference["arrays"]["labels"]["shape"]
    ):
        raise ValueError(
            "Annotation inputs must share the exact source, crop, C/Z/T and calibrated grid"
        )


def _resources(parent, reference, request):
    # Parent contract validation may need method/module/tissue arrays as well as
    # the compared labels. Bound all retained scientific inputs before decoding.
    descriptors = list(parent["arrays"].values())
    if reference is not None:
        descriptors.extend(reference["arrays"].values())
    metadata = len(canonical_json(parent).encode())
    if reference is not None:
        metadata += len(canonical_json(reference).encode())
    overhead = 2 * sum(d["bytes"] for d in descriptors) + metadata * 16
    minimum = estimated_working_bytes(
        math.prod(parent["arrays"]["labels"]["shape"]),
        thresholds=len(request.get("iou_thresholds", [])),
    )
    budget = request["working_bytes"] - overhead
    if budget < max(1024**2, minimum):
        raise ValueError(
            "Annotation operation exceeds aggregate working-memory budget before decode"
        )
    return {"overhead_bytes": overhead, "kernel_budget": budget, "minimum_kernel_bytes": minimum}


def validate_request(workbench, request, *, check=None):
    validate_settings(request)
    if check:
        check()
    parent = workbench.project.result(request["result_id"], verify_scientific_arrays=False)
    reference = workbench.project.result(
        request["reference"]["result_id"], verify_scientific_arrays=False
    )
    if (
        _binding(parent) != {k: request[k] for k in ("result_id", "revision_hash")}
        or _binding(reference) != request["reference"]
    ):
        raise ValueError("Annotation input revision is stale")
    geometry = _parent(parent, request["semantics"])
    _parent(reference, request["semantics"])
    _aligned(parent, reference)
    resources = _resources(parent, reference, request)
    sources = {}
    for record in (parent, reference):
        if check:
            check()
        source = _source_geometry(workbench, record)
        sources[source["id"]] = source
    return {
        "parent": parent,
        "reference": reference,
        "geometry": geometry,
        "sources": sources,
        "resource_estimate": resources,
    }


def _selected_annotations(data, request, parent):
    from .research_annotations import _simple_polygon

    selection = parent["provenance"]["selection"]
    by_id = {a["id"]: a for a in data["history"][data["cursor"]]}
    if not set(request["annotation_ids"]) <= set(by_id):
        raise ValueError("A selected source annotation no longer exists")
    selected = [copy.deepcopy(by_id[i]) for i in sorted(request["annotation_ids"])]
    for item in selected:
        if item["kind"] not in {"polygon", "rectangle"}:
            raise ValueError("Only closed source polygons and rectangles can form a reference")
        if item["z"] != selection["z"] or item["t"] != selection["t"]:
            raise ValueError("Source annotations must lie on the exact selected Z/T plane")
        points = tuple((p["x"], p["y"]) for p in item["points"])
        if not _simple_polygon(points):
            raise ValueError("Reference polygon edges must not cross")
        if any(
            not selection[axis] <= p[axis] <= selection[axis] + selection[size]
            for p in item["points"]
            for axis, size in (("x", "width"), ("y", "height"))
        ):
            raise ValueError(
                "Reference polygons must lie entirely within the comparison crop; "
                "clipping is not inferred"
            )
    return selected


def validate_reference_request(workbench, request, *, check=None):
    from .source_annotation_interchange import _current_data

    _reference_settings(request)
    if check:
        check()
    parent = workbench.project.result(request["result_id"], verify_scientific_arrays=False)
    if _binding(parent) != {k: request[k] for k in ("result_id", "revision_hash")}:
        raise ValueError("Annotation reference image/grid revision is stale")
    _parent(parent, None)
    source = _source_geometry(workbench, parent)
    _, data, revision = _current_data(workbench, source["id"], source["sha256"])
    if revision != request["source_annotations_revision"]:
        raise ValueError("Source annotations changed; reload before freezing a reference")
    selected = _selected_annotations(data, request, parent)
    resources = _resources(parent, None, request)
    snapshot_bytes = len(canonical_json(selected).encode()) * 16
    resources["overhead_bytes"] += snapshot_bytes
    resources["kernel_budget"] -= snapshot_bytes
    if resources["kernel_budget"] < max(1024**2, resources["minimum_kernel_bytes"]):
        raise ValueError("Annotation snapshot exceeds aggregate working-memory budget")
    return {
        "parent": parent,
        "source": source,
        "annotations": selected,
        "document": data,
        "source_planar_geometry": _planar_geometry(
            workbench, source, {**parent["provenance"]["selection"], "x": 0, "y": 0}
        ).to_dict(),
        "resource_estimate": resources,
    }


def reference_candidates(workbench, request, *, check=None):
    """Only supported shape IDs within the already-authorized exact crop/plane."""
    from .source_annotation_interchange import _current_data

    exact_keys(request, {"result_id", "revision_hash", "offset", "limit"}, "annotation candidates")
    _binding_value({k: request.get(k) for k in ("result_id", "revision_hash")})
    if check:
        check()
    parent = workbench.project.result(request["result_id"], verify_scientific_arrays=False)
    if _binding(parent) != {k: request[k] for k in ("result_id", "revision_hash")}:
        raise ValueError("Annotation candidate result revision is stale")
    _parent(parent, None)
    source = _source_geometry(workbench, parent)
    _, data, revision = _current_data(workbench, source["id"], source["sha256"])
    candidates = []
    for item in data["history"][data["cursor"]]:
        if check:
            check()
        try:
            _selected_annotations(data, {"annotation_ids": [item["id"]]}, parent)
        except ValueError:
            continue
        candidates.append(
            {
                "id": item["id"],
                "kind": item["kind"],
                "z": item["z"],
                "t": item["t"],
                "point_count": len(item["points"]),
            }
        )
    candidates.sort(key=lambda value: value["id"])
    offset = integer(request.get("offset", 0), "candidate offset", 0, len(candidates))
    limit = integer(request.get("limit", 100), "candidate limit", 1, 100)
    return {
        **_binding(parent),
        "source_annotations_revision": revision,
        "offset": offset,
        "total": len(candidates),
        "candidates": candidates[offset : offset + limit],
    }


def _rasterize(parent, selected, semantics, *, check=None):
    selection = parent["provenance"]["selection"]
    shape = tuple(parent["arrays"]["labels"]["shape"])
    labels = np.zeros(shape, dtype=np.uint32)
    for index, item in enumerate(selected, 1):
        if check:
            check()
        vertices = np.asarray(
            [
                (p["y"] - selection["y"] - 0.5, p["x"] - selection["x"] - 0.5)
                for p in item["points"]
            ],
            dtype=np.float64,
        )
        mask = polygon2mask(shape, vertices)
        if not mask.any():
            raise ValueError("A reference polygon contains no pixel centers")
        if semantics == "instances" and np.any(mask & (labels != 0)):
            raise ValueError("Instance reference polygons overlap on sampled pixels")
        labels[mask] = index if semantics == "instances" else 1
    return labels


def _software():
    from .models import ENGINE_VERSION
    from .working_result import _sha256_file_stable

    path = Path(sys.executable) if getattr(sys, "frozen", False) else Path(__file__)
    dispatcher = _sha256_file_stable(path, reject_symlink=True)[0]
    kernel = (
        dispatcher
        if getattr(sys, "frozen", False)
        else _sha256_file_stable(path.with_name("annotation_evaluation.py"), reject_symlink=True)[0]
    )
    return {"engine": ENGINE_VERSION, "kernel_sha256": kernel, "dispatcher_sha256": dispatcher}


def _check_job(workbench, request, source_id, job_id, operation, publication_guard):
    if publication_guard:
        publication_guard()
    if job_id is not None:
        job = workbench.project.job(job_id)
        normalized = {"source_id": source_id, "task_request": request}
        if (
            job["state"] != "running"
            or job["cancel_requested"]
            or job["operation"] != operation
            or job["request"] != normalized
            or job["request_hash"] != _hash({"operation": operation, "request": normalized})
        ):
            raise ValueError("Annotation publication requires its exact running native job")


def _provenance(parent, request, runtime):
    p = parent["provenance"]
    provenance = {
        k: copy.deepcopy(p[k]) for k in ("geometry", "selection", "channel_metadata") if k in p
    }
    provenance.update(
        parent_result=_binding(parent),
        accepted_request=copy.deepcopy(request),
        runtime=runtime,
        working_bytes=request["working_bytes"],
        measurement_channels=[],
        measurements=[],
        measurement_basis=(
            "Exact saved label-grid annotation agreement; no intensity or biological interpretation"
        ),
        scientific_validation="unvalidated-technical-annotation-agreement",
    )
    return provenance


def _draft(parent, kind, provenance, descriptors):
    draft = {
        **parent,
        "id": "0" * 32,
        "kind": kind,
        "parent_id": parent["id"],
        "provenance": provenance,
        "arrays": descriptors,
    }
    draft.pop("revision_hash", None)
    canonical_json(draft)
    return draft


def execute_annotation_evaluation(workbench, request, *, job_id=None, publication_guard=None):
    from .workbench import result_summary, runtime_record

    request = copy.deepcopy(request)
    accepted = validate_request(workbench, request, check=publication_guard)
    parent, reference = accepted["parent"], accepted["reference"]
    software, runtime = _software(), runtime_record()

    def controls():
        _check_job(
            workbench,
            request,
            parent["source_id"],
            job_id,
            "annotation_evaluation_run",
            publication_guard,
        )

    def guard():
        controls()
        if _software() != software or runtime_record() != runtime:
            raise ValueError("Annotation method/runtime changed before publication")
        for record in (parent, reference):
            current = workbench.project.result(record["id"], verify_scientific_arrays=False)
            if not _same(current, record):
                raise ValueError("Annotation input changed before publication")
            workbench.project.validate_result_arrays(
                record, check=controls, working_bytes=request["working_bytes"]
            )
            for name in ("image", "labels"):
                workbench.project.verify_array(record["arrays"][name])
        for source in accepted["sources"].values():
            if not _same(workbench.project.source(source["id"], verify=True), source):
                raise ValueError("Annotation source changed before publication")

    guard()
    arrays = {
        "image": workbench.project.load_array(parent["arrays"]["image"]),
        "labels": workbench.project.load_array(parent["arrays"]["labels"]),
        "reference_labels": workbench.project.load_array(reference["arrays"]["labels"]),
    }
    metrics = compare_labels(
        arrays["reference_labels"],
        arrays["labels"],
        semantics=request["semantics"],
        iou_thresholds=request["iou_thresholds"],
        working_bytes=accepted["resource_estimate"]["kernel_budget"],
        check=controls,
    )
    record = {
        "schema": SCHEMA,
        "kernel_schema": KERNEL_SCHEMA,
        "rules": RULES,
        "semantics": request["semantics"],
        "reference_declaration": request["reference_declaration"],
        "inputs": {
            role: {**_binding(r), "labels_sha256": r["arrays"]["labels"]["sha256"]}
            for role, r in (("prediction", parent), ("reference", reference))
        },
        "metrics": metrics,
        "resource_estimate": accepted["resource_estimate"],
        "software": software,
    }
    provenance = _provenance(parent, request, runtime)
    provenance.update(annotation_evaluation=record, reference_result=_binding(reference))
    if job_id:
        provenance["job_id"] = job_id
    descriptors = {
        "image": parent["arrays"]["image"],
        "labels": parent["arrays"]["labels"],
        "reference_labels": reference["arrays"]["labels"],
    }
    draft = _draft(parent, KIND, provenance, descriptors)
    validate_parents(draft, {r["id"]: r for r in (parent, reference)})
    guard()
    result = workbench.project.save_result(
        source_id=parent["source_id"],
        kind=KIND,
        arrays=arrays,
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=guard,
    )
    return {"result": result_summary(result), "annotation_evaluation": _summary(record)}


def execute_annotation_reference(workbench, request, *, job_id=None, publication_guard=None):
    from .source_annotation_interchange import _current_data
    from .workbench import result_summary, runtime_record

    request = copy.deepcopy(request)
    accepted = validate_reference_request(workbench, request, check=publication_guard)
    parent, source = accepted["parent"], accepted["source"]
    software, runtime = _software(), runtime_record()

    def controls():
        _check_job(
            workbench, request, source["id"], job_id, "annotation_reference_run", publication_guard
        )

    def guard():
        controls()
        if _software() != software or runtime_record() != runtime:
            raise ValueError("Annotation-reference method/runtime changed before publication")
        if not _same(
            workbench.project.result(parent["id"], verify_scientific_arrays=False), parent
        ):
            raise ValueError("Annotation-reference parent changed before publication")
        current_source, data, revision = _current_data(workbench, source["id"], source["sha256"])
        if (
            not _same(current_source, source)
            or revision != request["source_annotations_revision"]
            or not _same(data, accepted["document"])
        ):
            raise ValueError("Source annotations changed before reference publication")
        workbench.project.validate_result_arrays(
            parent, check=controls, working_bytes=request["working_bytes"]
        )
        workbench.project.verify_array(parent["arrays"]["image"])

    guard()
    labels = _rasterize(parent, accepted["annotations"], request["semantics"], check=controls)
    image = workbench.project.load_array(parent["arrays"]["image"])
    # Compute the NPY descriptor without staging; save_result owns atomic publication.
    descriptor = _array_descriptor(labels, controls)
    record = {
        "schema": REFERENCE_SCHEMA,
        "rules": REFERENCE_RULES,
        "semantics": request["semantics"],
        "source_annotations_revision": request["source_annotations_revision"],
        "coordinate_space": "level0-pixel-edges",
        "annotation_snapshot": accepted["annotations"],
        "source_geometry": copy.deepcopy(accepted["document"]["geometry"]),
        "source_planar_geometry": copy.deepcopy(accepted["source_planar_geometry"]),
        "source_dimensions": copy.deepcopy(accepted["document"]["dimensions"]),
        "snapshot_sha256": _hash(accepted["annotations"]),
        "coverage_declaration": request["coverage_declaration"],
        "labels_sha256": descriptor["sha256"],
        "software": software,
    }
    provenance = _provenance(parent, request, runtime)
    provenance["annotation_reference"] = record
    if job_id:
        provenance["job_id"] = job_id
    draft = _draft(
        parent,
        REFERENCE_KIND,
        provenance,
        {"image": parent["arrays"]["image"], "labels": descriptor},
    )
    validate_parents(draft, {parent["id"]: parent})
    guard()
    result = workbench.project.save_result(
        source_id=source["id"],
        kind=REFERENCE_KIND,
        arrays={"image": image, "labels": labels},
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=guard,
    )
    return {"result": result_summary(result), **public_summary(result)}


def _software_record(value):
    _exact(value, {"engine", "kernel_sha256", "dispatcher_sha256"}, "annotation software")
    checked_text(value["engine"], "Annotation engine identity", 64)
    for key in ("kernel_sha256", "dispatcher_sha256"):
        _sha(value[key])


def validate_record(result):
    """Pure metadata proof, including pre-hash drafts. Array endpoints are checked separately."""
    p = result.get("provenance", {})
    if result.get("kind") not in {KIND, REFERENCE_KIND} and not {
        "annotation_evaluation",
        "annotation_reference",
    } & set(p):
        return
    is_reference = result.get("kind") == REFERENCE_KIND
    _base(result, hashed=False, derivative=not is_reference)
    if is_reference:
        if set(result["arrays"]) != {"image", "labels"}:
            raise ValueError("Frozen annotation reference requires exactly its image and labels")
        _reference_settings(p.get("accepted_request"))
        r = p.get("annotation_reference")
        _exact(
            r,
            {
                "schema",
                "rules",
                "semantics",
                "source_annotations_revision",
                "coordinate_space",
                "annotation_snapshot",
                "snapshot_sha256",
                "source_geometry",
                "source_planar_geometry",
                "source_dimensions",
                "coverage_declaration",
                "labels_sha256",
                "software",
            },
            "frozen annotation reference",
        )
        if (
            "annotation_evaluation" in p
            or r["schema"] != REFERENCE_SCHEMA
            or r["rules"] != REFERENCE_RULES
        ):
            raise ValueError("Frozen annotation-reference method disagrees")
        request = p["accepted_request"]
        if (
            r["semantics"] != request["semantics"]
            or r["source_annotations_revision"] != request["source_annotations_revision"]
            or r["coverage_declaration"] != request["coverage_declaration"]
        ):
            raise ValueError("Frozen annotation-reference request disagrees")
        snapshot = r["annotation_snapshot"]
        if not isinstance(snapshot, list) or len(snapshot) != len(request["annotation_ids"]):
            raise ValueError("Frozen annotation snapshot is missing")
        if (
            r["coordinate_space"] != "level0-pixel-edges"
            or r["snapshot_sha256"] != _hash(snapshot)
            or r["labels_sha256"] != result["arrays"]["labels"]["sha256"]
        ):
            raise ValueError("Frozen annotation-reference identity disagrees")
        # Reuse the raw annotation schema to verify exact geometry and measurements
        # without looking up mutable current history or opening the original image.
        from .source_annotations import SCHEMA as SOURCE_SCHEMA
        from .source_annotations import validate_annotation_data

        data = {
            "schema": SOURCE_SCHEMA,
            "source_id": result["source_id"],
            "source_sha256": result["source_sha256"],
            "coordinate_space": "level0-pixel-edges",
            "geometry": r["source_geometry"],
            "dimensions": r["source_dimensions"],
            "history": [snapshot],
            "cursor": 0,
        }
        validate_annotation_data(
            data, {"id": result["source_id"], "sha256": result["source_sha256"]}
        )
        from .workbench import geometry_from_dict

        # Raw annotation history uses its original source-global 2D/3D frame.
        # A planar source reader can intentionally omit uncalibrated Z translation;
        # preserve that separate exact plane receipt rather than guessing from ZYX.
        source_geometry = geometry_from_dict(r["source_planar_geometry"])
        if source_geometry.axes != "YX":
            raise ValueError("Frozen annotation planar receipt must retain YX axes")
        selection = p["selection"]
        matrix = np.array(source_geometry.affine)
        matrix[:3, 3] += sum(matrix[:3, i] * selection[axis] for i, axis in enumerate(("x", "y")))
        expected_geometry = Geometry(
            "YX", tuple(map(tuple, matrix)), source_geometry.unit, source_geometry.frame
        )
        if not _same(expected_geometry.to_dict(), p["geometry"]):
            raise ValueError("Frozen source annotation geometry differs from the selected grid")
        if [a["id"] for a in snapshot] != sorted(request["annotation_ids"]):
            raise ValueError("Frozen annotation IDs disagree with the accepted selection")
        _selected_annotations(data, request, result)
    else:
        if result.get("kind") != KIND or "annotation_reference" in p:
            raise ValueError("Annotation-agreement kind disagrees with provenance")
        validate_settings(p.get("accepted_request"))
        r = p.get("annotation_evaluation")
        _exact(
            r,
            {
                "schema",
                "kernel_schema",
                "rules",
                "semantics",
                "reference_declaration",
                "inputs",
                "metrics",
                "resource_estimate",
                "software",
            },
            "annotation agreement",
        )
        request = p["accepted_request"]
        if (
            r["schema"] != SCHEMA
            or r["kernel_schema"] != KERNEL_SCHEMA
            or r["rules"] != RULES
            or r["semantics"] != request["semantics"]
            or r["reference_declaration"] != request["reference_declaration"]
        ):
            raise ValueError("Persisted annotation agreement method disagrees")
        _exact(r["inputs"], {"prediction", "reference"}, "annotation inputs")
        for role, array in (("prediction", "labels"), ("reference", "reference_labels")):
            value = r["inputs"][role]
            _exact(
                value, {"result_id", "revision_hash", "labels_sha256"}, "annotation retained input"
            )
            _binding_value({k: value[k] for k in ("result_id", "revision_hash")})
            binding = (
                request["reference"]
                if role == "reference"
                else {k: request[k] for k in ("result_id", "revision_hash")}
            )
            if (
                any(value[k] != binding[k] for k in binding)
                or value["labels_sha256"] != result["arrays"][array]["sha256"]
            ):
                raise ValueError("Retained annotation arrays differ from the exact input revision")
        if p.get("reference_result") != request["reference"]:
            raise ValueError("Annotation reference dependency disagrees")
        metrics = r["metrics"]
        _exact(
            metrics, {"schema", "semantics", "region", "instances"}, "annotation agreement metrics"
        )
        if metrics["schema"] != KERNEL_SCHEMA or metrics["semantics"] != request["semantics"]:
            raise ValueError("Annotation metric semantics disagree")
        if (metrics["instances"] is None) != (request["semantics"] == "foreground-region"):
            raise ValueError("Annotation instance/region interpretation disagrees")
        if (
            metrics["instances"] is not None
            and [s["iou_threshold"] for s in metrics["instances"]["scores"]]
            != request["iou_thresholds"]
        ):
            raise ValueError("Annotation metric thresholds disagree")
        _exact(
            r["resource_estimate"],
            {"overhead_bytes", "kernel_budget", "minimum_kernel_bytes"},
            "annotation resources",
        )
        for key, value in r["resource_estimate"].items():
            integer(value, f"annotation {key}", 1, request["working_bytes"])
        if (
            r["resource_estimate"]["kernel_budget"] + r["resource_estimate"]["overhead_bytes"]
            != request["working_bytes"]
        ):
            raise ValueError("Annotation aggregate memory declaration disagrees")
    _software_record(r["software"])
    if (
        not isinstance(p.get("runtime"), dict)
        or not p["runtime"]
        or p["runtime"].get("engine") != r["software"]["engine"]
    ):
        raise ValueError("Annotation software/runtime identity disagrees")
    binding = {k: p["accepted_request"][k] for k in ("result_id", "revision_hash")}
    if (
        p.get("parent_result") != binding
        or result.get("parent_id") != binding["result_id"]
        or result["id"] == binding["result_id"]
    ):
        raise ValueError("Annotation exact parent binding disagrees")


def validate_parents(result, results):
    validate_record(result)
    p, request = result["provenance"], result["provenance"]["accepted_request"]
    parent = results.get(request["result_id"])
    if parent is None or _binding(parent) != p["parent_result"]:
        raise ValueError("Annotation exact parent is missing or stale")
    _parent(parent, None if result["kind"] == REFERENCE_KIND else request["semantics"])
    if (
        any(result[k] != parent[k] for k in ("source_id", "source_sha256"))
        or any(not _same(p[k], parent["provenance"][k]) for k in ("selection", "geometry"))
        or result["arrays"]["image"] != parent["arrays"]["image"]
    ):
        raise ValueError("Annotation source/image/grid differs from its exact parent")
    if result["kind"] == KIND:
        reference = results.get(request["reference"]["result_id"])
        if reference is None or _binding(reference) != request["reference"]:
            raise ValueError("Annotation exact reference is missing or stale")
        _parent(reference, request["semantics"])
        _aligned(parent, reference)
        if (
            result["arrays"]["labels"] != parent["arrays"]["labels"]
            or result["arrays"]["reference_labels"] != reference["arrays"]["labels"]
        ):
            raise ValueError("Annotation retained labels differ from their exact input snapshots")
        if not _same(
            _resources(parent, reference, request), p["annotation_evaluation"]["resource_estimate"]
        ):
            raise ValueError("Annotation aggregate resources disagree with input snapshots")


def project_parents(project, result, *, check=None):
    """Direct/hash-checked parent reads prevent recursive forged-derivative cycles."""
    validate_record(result)
    p = result["provenance"]
    bindings = [p["parent_result"]]
    if result["kind"] == KIND:
        bindings.append(p["reference_result"])
    results = {}
    metadata = 0
    for binding in bindings:
        if check:
            check()
        with project.connection() as connection:
            row = connection.execute(
                "SELECT record FROM results WHERE id=?", (binding["result_id"],)
            ).fetchone()
        if row is None:
            raise ValueError("Annotation exact input snapshot is missing")
        metadata += len(row[0].encode()) * 16
        if metadata > p["accepted_request"]["working_bytes"]:
            raise ValueError("Annotation input metadata exceeds its working-memory allowance")
        record = parse_json(row[0])
        _base(record)
        results[record["id"]] = record
    validate_parents(result, results)
    return results


class _ArrayDigest:
    def __init__(self, check=None):
        self.digest, self.size, self.check = hashlib.sha256(), 0, check

    def write(self, data):
        if self.check:
            self.check()
        value = memoryview(data).cast("B")
        self.digest.update(value)
        self.size += value.nbytes
        return value.nbytes

    def tell(self):
        return self.size

    def flush(self):
        pass


def _array_descriptor(array, check=None):
    digest = _ArrayDigest(check)
    np.save(digest, array, allow_pickle=False)
    return {
        "sha256": digest.digest.hexdigest(),
        "bytes": digest.size,
        "dtype": str(array.dtype),
        "shape": list(array.shape),
    }


def validate_arrays(result, arrays, parents=None, *, check=None, working_bytes=None):
    """Verify exact NPY identities and recompute endpoints, also before portable restore."""
    validate_record(result)
    if parents is not None:
        validate_parents(result, parents)
    if set(arrays) != set(result["arrays"]):
        raise ValueError("Annotation retained arrays are incomplete")
    request = result["provenance"]["accepted_request"]
    budget = request["working_bytes"]
    if working_bytes is not None:
        budget = min(
            budget, integer(working_bytes, "annotation replay budget", 1024**2, MAX_WORKING_BYTES)
        )
    overhead = 2 * sum(d["bytes"] for d in result["arrays"].values()) + 16 * len(
        canonical_json(result).encode()
    )
    kernel_budget = budget - overhead
    if kernel_budget < max(
        1024**2,
        estimated_working_bytes(
            math.prod(result["arrays"]["labels"]["shape"]),
            thresholds=len(request.get("iou_thresholds", [])),
        ),
    ):
        raise ValueError("Annotation replay exceeds aggregate working-memory budget before decode")
    for name, descriptor in result["arrays"].items():
        if check:
            check()
        array = arrays[name]
        if (
            not isinstance(array, np.ndarray)
            or not np.isfinite(array).all()
            or not _same(_array_descriptor(array, check), descriptor)
        ):
            raise ValueError("Annotation retained array hash/shape/dtype disagrees")
    if result["kind"] == REFERENCE_KIND:
        record = result["provenance"]["annotation_reference"]
        expected = _rasterize(
            result, record["annotation_snapshot"], request["semantics"], check=check
        )
        if not np.array_equal(expected, arrays["labels"]):
            raise ValueError("Frozen annotation-reference labels disagree with the saved polygons")
    else:
        measured = compare_labels(
            arrays["reference_labels"],
            arrays["labels"],
            semantics=request["semantics"],
            iou_thresholds=request["iou_thresholds"],
            working_bytes=kernel_budget,
            check=check,
        )
        if not _same(measured, result["provenance"]["annotation_evaluation"]["metrics"]):
            raise ValueError("Annotation agreement endpoints disagree with retained label arrays")
    if check:
        check()


def validate_project_arrays(project, result, *, arrays=None, check=None, working_bytes=None):
    validate_record(result)
    project_parents(project, result, check=check)
    budget = min(
        result["provenance"]["accepted_request"]["working_bytes"],
        working_bytes or MAX_WORKING_BYTES,
    )
    # Bound before retained-array decoding, including report/metadata copies.
    if (
        2 * sum(d["bytes"] for d in result["arrays"].values())
        + 16 * len(canonical_json(result).encode())
        + max(
            1024**2,
            estimated_working_bytes(
                math.prod(result["arrays"]["labels"]["shape"]),
                thresholds=len(result["provenance"]["accepted_request"].get("iou_thresholds", [])),
            ),
        )
        > budget
    ):
        raise ValueError("Annotation replay exceeds aggregate working-memory budget before decode")
    if arrays is None:
        arrays = {}
        for name, descriptor in result["arrays"].items():
            if check:
                check()
            arrays[name] = project.load_array(descriptor)
    validate_arrays(result, arrays, check=check, working_bytes=budget)


def _summary(record):
    value = copy.deepcopy(record)
    metrics = value.get("metrics", {})
    if metrics.get("instances") is not None:
        for score in metrics["instances"]["scores"]:
            for name in ("matches", "unmatched_reference", "unmatched_prediction"):
                score[name + "_count"] = len(score.pop(name))
    return value


def public_summary(result):
    """Bounded basic-listing payload: no polygon vertices or full match tables."""
    p = result.get("provenance", {})
    if result.get("kind") == KIND and "annotation_evaluation" in p:
        return {"annotation_evaluation": _summary(p["annotation_evaluation"])}
    if result.get("kind") == REFERENCE_KIND and "annotation_reference" in p:
        value = p["annotation_reference"]
        return {
            "annotation_reference": {
                k: copy.deepcopy(value[k])
                for k in (
                    "schema",
                    "semantics",
                    "source_annotations_revision",
                    "snapshot_sha256",
                    "coverage_declaration",
                    "labels_sha256",
                )
            }
            | {"annotation_count": len(value["annotation_snapshot"])}
        }
    return {}


def report_get(workbench, request, *, check=None):
    """Bounded report paging; no source decoder, current annotation access or path payloads."""
    exact_keys(
        request,
        {"result_id", "revision_hash", "table", "threshold_index", "offset", "limit"},
        "annotation report query",
    )
    _binding_value({k: request.get(k) for k in ("result_id", "revision_hash")})
    result = workbench.project.result(request["result_id"])
    if result["kind"] != KIND or result["revision_hash"] != request["revision_hash"]:
        raise ValueError("Select the exact saved annotation-agreement revision")
    validate_project_arrays(workbench.project, result, check=check)
    record = result["provenance"]["annotation_evaluation"]
    table = request.get("table", "summary")
    if table == "summary":
        if set(request) - {"result_id", "revision_hash", "table"}:
            raise ValueError("Summary queries do not accept table pagination")
        return {**_binding(result), "annotation_evaluation": _summary(record)}
    if (
        table not in {"matches", "unmatched_reference", "unmatched_prediction"}
        or record["metrics"]["instances"] is None
    ):
        raise ValueError("Choose an instance agreement match/unmatched table")
    scores = record["metrics"]["instances"]["scores"]
    threshold = integer(request.get("threshold_index", 0), "threshold index", 0, len(scores) - 1)
    rows = scores[threshold][table]
    offset = integer(request.get("offset", 0), "agreement row offset", 0, len(rows))
    limit = integer(request.get("limit", 100), "agreement row limit", 1, 100)
    return {
        **_binding(result),
        "table": table,
        "iou_threshold": scores[threshold]["iou_threshold"],
        "offset": offset,
        "total": len(rows),
        "rows": copy.deepcopy(rows[offset : offset + limit]),
    }
