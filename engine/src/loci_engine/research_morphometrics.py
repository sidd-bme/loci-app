"""Opt-in, exact-parent digital morphometrics; shared routing is integrated separately.

This derivative retains parent image/labels and every original measurement field.
It adds no smoothing, resampling, intensity inference or replacement RMS radii.
Physical validity depends on the declared calibration and segmentation. Pixel
units remain explicitly uncalibrated. Correct the underlying labels and rerun;
generic correction/ROI mutation of this derivative must be refused by its caller.

Native task normalization: {source_id: parent.source_id, task_request: request}.
Pass the normal publication_guard for policy/session/cancellation authority. Each
publication needs its own native job; this module never schedules or reuses a
parent job. Historical metadata validation performs no file I/O or pixel decode.
"""

from __future__ import annotations

import copy
import hashlib
import math
import sys
from pathlib import Path

import numpy as np

from .morphometrics import (
    CHUNK_PIXELS,
    MAX_BASIS_CONDITION,
    RULES,
    _lattice,
    estimated_working_bytes,
    measure_morphometrics,
)
from .morphometrics import (
    SCHEMA as KERNEL_SCHEMA,
)
from .quantitative import MAX_OBJECTS, MAX_WORKING_BYTES, Geometry, exact_keys, integer
from .research_data_tables import _finite_tree, _optional_spatial_fields
from .research_population import _objects
from .research_project import (
    MAX_ARTIFACT_BYTES,
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
)

KIND = "morphometrics"
SCHEMA = "loci.morphometrics-result/v1"
CORRECTION_REFUSAL = "Correct or annotate the underlying label result and rerun morphometrics"
REQUEST_KEYS = {"result_id", "revision_hash", "working_bytes"}
MAX_ANCESTORS = 64
SCALARS = (
    "pixel_union_area",
    "voxel_union_volume",
    "perimeter",
    "surface_area",
    "circularity",
    "eccentricity",
    "elongation",
    "sphericity",
)
ROW_KEYS = {
    *SCALARS,
    "center_covariance_eigenvalues",
    "exposed_face_counts",
    "touches_crop_border",
    "undefined_reasons",
}
PARENT_KINDS = {
    "segmentation",
    "cell-segmentation",
    "adaptive-segmentation",
    "cellpose-segmentation",
    "model-segmentation",
    "external-labels",
    "corrected-labels",
}
DERIVED = {
    "morphometrics",
    "spatial",
    "perinuclear",
    "association",
    "association_inputs",
    "tracking",
    "temporal_inputs",
    "derived_measurement_arrays",
    "stain_separation",
    "compartment_measurement",
    "fixed_result",
    "moving_result",
}


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _same(first, second):
    return canonical_json(first) == canonical_json(second)


def _exact(value, keys, name):
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"{name} requires exactly the declared fields")


def _sha(value):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Morphometrics requires an exact SHA-256 identity")


def _binding(record):
    return {"result_id": record["id"], "revision_hash": record["revision_hash"]}


def _geometry(value):
    _exact(value, {"axes", "affine", "unit", "frame"}, "morphometrics geometry")
    try:
        geometry = Geometry(
            value["axes"], tuple(map(tuple, value["affine"])), value["unit"], value["frame"]
        )
    except (TypeError, OverflowError) as exc:
        raise ValueError("Morphometrics geometry is invalid") from exc
    _lattice(geometry)  # Authoritative shear/conditioning and finite face-measure boundary.
    return geometry


def _units(geometry):
    unit = geometry if isinstance(geometry, str) else geometry.unit
    return {
        "pixel_union_area": f"{unit}^2",
        "voxel_union_volume": f"{unit}^3",
        "perimeter": unit,
        "surface_area": f"{unit}^2",
        **dict.fromkeys(("circularity", "eccentricity", "elongation", "sphericity"), "1"),
        "center_covariance_eigenvalues": f"{unit}^2",
    }


def _descriptor(descriptor, dimension, *, labels=False):
    _exact(descriptor, {"sha256", "bytes", "shape", "dtype"}, "morphometrics artifact")
    _sha(descriptor["sha256"])
    size = integer(descriptor["bytes"], "artifact bytes", 1, MAX_ARTIFACT_BYTES + 4096)
    shape = descriptor["shape"]
    if not isinstance(shape, list) or len(shape) != dimension:
        raise ValueError("Morphometrics artifact axes disagree")
    for length in shape:
        integer(length, "artifact extent", 1, 2**31 - 1)
    try:
        if not isinstance(descriptor["dtype"], str):
            raise ValueError("Artifact dtype must be text")
        dtype = np.dtype(descriptor["dtype"])
    except (ValueError, TypeError) as exc:
        raise ValueError("Morphometrics artifact dtype is invalid") from exc
    if dtype.kind not in ("ui" if labels else "buif") or dtype.itemsize > 8:
        raise ValueError("Morphometrics requires integer labels and real scalar images")
    decoded = math.prod(shape) * dtype.itemsize
    if decoded > MAX_ARTIFACT_BYTES or not decoded < size <= decoded + 4096:
        raise ValueError("Morphometrics artifact size exceeds its declared payload")


def _base(record, *, hashed=True):
    if not isinstance(record, dict) or record.get("schema") != "loci.research-result/v1":
        raise ValueError("Morphometrics requires a bounded immutable label result")
    checked_id(record.get("id"))
    checked_id(record.get("source_id"))
    _sha(record.get("source_sha256"))
    if hashed or "revision_hash" in record:
        _sha(record.get("revision_hash"))
        if record["revision_hash"] != _hash(
            {k: v for k, v in record.items() if k != "revision_hash"}
        ):
            raise ValueError("Morphometrics result revision failed integrity verification")
    _finite_tree(record)
    p = record.get("provenance")
    if not isinstance(p, dict):
        raise ValueError("Morphometrics result provenance is missing")
    geometry = _geometry(p.get("geometry"))
    arrays = record.get("arrays")
    if not isinstance(arrays, dict) or set(arrays) != {"image", "labels"}:
        raise ValueError("Morphometrics initially requires exactly the parent image and labels")
    for name, descriptor in arrays.items():
        _descriptor(descriptor, len(geometry.axes), labels=name == "labels")
    shape = arrays["labels"]["shape"]
    if arrays["image"]["shape"] != shape:
        raise ValueError("Morphometrics image and labels must share one exact grid")
    selection = p.get("selection")
    keys = {"x", "y", "width", "height", "c", "z", "t", "level"}
    if len(shape) == 3:
        keys.add("z_stop")
    _exact(selection, keys, "morphometrics source selection")
    for key, value in selection.items():
        integer(
            value, f"selection {key}", 1 if key in {"width", "height", "z_stop"} else 0, 2**31 - 1
        )
    selected_shape = [selection["height"], selection["width"]]
    if len(shape) == 3:
        selected_shape.insert(0, selection["z_stop"] - selection["z"])
    if shape != selected_shape:
        raise ValueError("Morphometrics labels disagree with source selection extents")
    rows = p.get("measurements")
    if not isinstance(rows, list) or len(rows) > MAX_OBJECTS:
        raise ValueError("Morphometrics requires bounded original measurement rows")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Morphometrics requires original object measurement records")
        _optional_spatial_fields(row)
        _objects([row], shape)  # Existing authoritative scalar/axes/bounds/intensity contract.
        if row["label"] in seen:
            raise ValueError("Morphometrics parent measurement labels are duplicated")
        seen.add(row["label"])
        if (
            row["measure_unit"] != f"{geometry.unit}^{len(shape)}"
            or row.get("distance_unit") != geometry.unit
        ):
            raise ValueError("Morphometrics original units disagree with declared geometry")
    return geometry


def _parent(record):
    geometry = _base(record)
    if record.get("kind") not in PARENT_KINDS or DERIVED & set(record["provenance"]):
        raise ValueError("Choose underlying label measurements, not a derived measurement result")
    if any("morphometrics" in row for row in record["provenance"]["measurements"]):
        raise ValueError("Parent rows already contain morphometrics")
    return geometry


def _chain(parent, lookup, working_bytes=MAX_WORKING_BYTES):
    """Exact bounded correction ancestry; no implicit newest result or mixed source."""
    records, seen, current, metadata_bytes = [], set(), parent, 0
    while True:
        metadata_bytes += 16 * len(canonical_json(current).encode())
        if metadata_bytes > working_bytes:
            raise ValueError("Morphometrics ancestry exceeds the metadata working-memory budget")
        _parent(current)
        if current["id"] in seen or len(records) >= MAX_ANCESTORS:
            raise ValueError("Morphometrics ancestry contains a cycle or exceeds its bound")
        if any(current[k] != parent[k] for k in ("source_id", "source_sha256")):
            raise ValueError("Morphometrics ancestors have mixed source identities")
        seen.add(current["id"])
        records.append(current)
        identity = current.get("parent_id")
        if identity is None:
            if current.get("kind") == "corrected-labels":
                raise ValueError("Corrected labels lost their exact parent identity")
            return records
        checked_id(identity)
        correction = current["provenance"].get("correction", {})
        previous = lookup(identity)
        if (
            previous is None
            or current["kind"] != "corrected-labels"
            or (
                correction.get("parent_id") != identity
                or correction.get("parent_revision_hash") != previous.get("revision_hash")
                or current["arrays"]["image"] != previous.get("arrays", {}).get("image")
                or any(
                    not _same(current["provenance"].get(k), previous.get("provenance", {}).get(k))
                    for k in ("geometry", "selection")
                )
            )
        ):
            raise ValueError("Morphometrics correction ancestry is missing or stale")
        current = previous


def validate_settings(request):
    _exact(request, REQUEST_KEYS, "morphometrics request")
    checked_id(request["result_id"])
    _sha(request["revision_hash"])
    integer(request["working_bytes"], "working_bytes", 1024**2, MAX_WORKING_BYTES)


def validate_source(result, source):
    """Pure primary-source fingerprint/scope validation; native request also checks affine."""
    if (
        source.get("source_kind") not in {"native", "whole_slide", "ome_zarr", "medical"}
        or source.get("id") != result["source_id"]
        or source.get("sha256") != result["source_sha256"]
    ):
        raise ValueError("Morphometrics source fingerprint changed")
    selection = result["provenance"]["selection"]
    metadata = source.get("metadata", {})
    if source.get("source_kind") == "medical":
        shape = metadata.get("shape", [])
        if len(shape) not in {2, 3}:
            raise ValueError("Morphometrics medical source has no bounded scalar geometry")
        dimensions = {
            "x": shape[-1],
            "y": shape[-2],
            "z": shape[0] if len(shape) == 3 else 1,
            "t": 1,
            "c": 1,
        }
    else:
        dimensions = metadata.get("dimensions", {})
    for axis in ("x", "y", "z", "t", "c"):
        size = integer(dimensions.get(axis), f"source {axis}", 1, 2**31 - 1)
        stop = (
            selection[axis] + selection[{"x": "width", "y": "height"}[axis]]
            if axis in {"x", "y"}
            else selection[axis] + 1
        )
        if axis == "z":
            stop = selection.get("z_stop", stop)
        if stop > size:
            raise ValueError("Morphometrics selection exceeds its source scope")


def _source_geometry(workbench, record):
    source = workbench.project.source(record["source_id"], verify=True)
    validate_source(record, source)
    selection = record["provenance"]["selection"]
    if not _same(workbench.selection(source["id"], selection), selection):
        raise ValueError("Morphometrics selection changed during resolution")
    if source.get("source_kind") == "medical":
        geometry = _geometry(source["metadata"]["geometry"])
        if "z_stop" in selection and geometry.axes != "ZYX":
            raise ValueError("Medical source has no ZYX volume")
        geometry = geometry.cropped(
            tuple(selection[k] for k in ("z", "y", "x")[-len(geometry.axes) :])
        )
        if "z_stop" not in selection:
            geometry = Geometry("YX", geometry.affine, geometry.unit, geometry.frame)
    else:
        geometry = workbench._native_geometry(
            workbench._session(source["id"]), selection, "z_stop" in selection
        )
    if not _same(geometry.to_dict(), record["provenance"]["geometry"]):
        raise ValueError(
            "Morphometrics parent affine/calibration differs from the exact source grid"
        )
    return source


def _resources(parent, chain, request):
    # Two retained-array allowances cover decode and bounded hashing/staging.
    # JSON headroom covers original rows, copies, lookup sets and validation.
    overhead = 2 * sum(d["bytes"] for d in parent["arrays"].values())
    overhead += 16 * sum(len(canonical_json(r).encode()) for r in chain)
    kernel_budget = request["working_bytes"] - overhead
    required = estimated_working_bytes(
        math.prod(parent["arrays"]["labels"]["shape"]), len(parent["provenance"]["measurements"])
    )
    if required > kernel_budget:
        raise ValueError("Morphometrics exceeds aggregate working-memory budget before decode")
    return {
        "overhead_bytes": overhead,
        "kernel_budget": kernel_budget,
        "estimated_working_bytes": overhead + required,
    }


def validate_request(workbench, request, *, check=None):
    """Metadata-only preflight; source bytes are verified, pixels are not decoded."""
    validate_settings(request)
    if check:
        check()
    parent = workbench.project.result(request["result_id"])
    if parent["revision_hash"] != request["revision_hash"]:
        raise ValueError("Morphometrics parent revision is stale")
    geometry = _parent(parent)
    chain = _chain(parent, workbench.project.result, request["working_bytes"])
    sources = {}
    for record in chain:
        if check:
            check()
        source = _source_geometry(workbench, record)
        sources[source["id"]] = source
        references = record["provenance"].get("references", {})
        if not isinstance(references, dict) or len(references) > 16:
            raise ValueError("Morphometrics parent source references are invalid")
        for reference in references.values():
            if not isinstance(reference, dict):
                raise ValueError("Morphometrics parent source reference is invalid")
            bound = workbench.project.source(reference.get("source_id"), verify=True)
            if bound["sha256"] != reference.get("source_sha256"):
                raise ValueError("Morphometrics parent source reference is stale")
            sources[bound["id"]] = bound
    return {
        "parent": parent,
        "geometry": geometry,
        "chain": chain,
        "sources": sources,
        **_resources(parent, chain, request),
    }


def _metric_row(row, geometry):
    value = row.get("morphometrics")
    _exact(value, ROW_KEYS, "stored morphology row")
    count = integer(row["voxel_count"], "morphology voxel count", 1, 2**53)
    dimension = len(geometry.axes)
    faces, eigen = value["exposed_face_counts"], value["center_covariance_eigenvalues"]
    if (
        not isinstance(faces, list)
        or len(faces) != dimension
        or not isinstance(eigen, list)
        or len(eigen) != dimension
    ):
        raise ValueError("Stored morphometrics face/moment axes disagree")
    for n in faces:
        integer(n, "exposed face count", 2, 2 * count)
        if n % 2:
            raise ValueError("Stored exposed face counts must be paired along each grid axis")
    if any(
        type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in eigen
    ) or eigen != sorted(eigen, reverse=True):
        raise ValueError("Stored physical center eigenvalues are invalid")
    if count == 1 and any(eigen):
        raise ValueError("A single sample must retain zero center moments")
    if count > 1 and eigen[0] == 0:
        raise ValueError("Distinct sample centers cannot have zero major moment")
    if dimension == 2 and count == 2 and eigen[1] != 0:
        raise ValueError("Two sample centers must retain a zero minor moment")
    if (
        type(value["touches_crop_border"]) is not bool
        or row.get("touches_crop_border", value["touches_crop_border"])
        != value["touches_crop_border"]
    ):
        raise ValueError("Stored crop-truncation flag disagrees with the original object")
    element, weights, _ = _lattice(geometry)
    measure = count * element
    boundary = math.fsum(n * w for n, w in zip(faces, weights, strict=True))
    expected = dict.fromkeys(SCALARS)
    reasons = {}
    if dimension == 2:
        expected.update(
            pixel_union_area=measure,
            perimeter=boundary,
            circularity=4 * math.pi * (math.sqrt(measure) / boundary) ** 2,
        )
        reasons.update(
            surface_area="requires-3d", voxel_union_volume="requires-3d", sphericity="requires-3d"
        )
        major, minor = eigen
        if major == 0:
            reasons.update(
                eccentricity="zero-major-center-moment", elongation="zero-major-center-moment"
            )
        else:
            ratio = math.sqrt(minor) / math.sqrt(major)
            expected["eccentricity"] = math.sqrt(1 - ratio * ratio)
            if minor == 0:
                reasons["elongation"] = "zero-minor-center-moment"
            else:
                expected["elongation"] = math.sqrt(major) / math.sqrt(minor)
    else:
        expected.update(
            voxel_union_volume=measure,
            surface_area=boundary,
            sphericity=(36 * math.pi) ** (1 / 3) * (math.cbrt(measure) / math.sqrt(boundary)) ** 2,
        )
        reasons.update(
            dict.fromkeys(
                ("pixel_union_area", "perimeter", "circularity", "eccentricity", "elongation"),
                "requires-2d",
            )
        )
    if not _same({k: value[k] for k in SCALARS}, expected) or value["undefined_reasons"] != reasons:
        raise ValueError(
            "Stored morphometrics formulas/null reasons disagree with the declared convention"
        )
    for name, v in expected.items():
        if v is not None and (
            not math.isfinite(v)
            or v < 0
            or (name in {"circularity", "eccentricity", "sphericity"} and v > 1)
        ):
            raise ValueError("Stored morphology metric is outside its finite geometric range")
    return value


def validate_record(result):
    """Pure persisted contract check; accepts a pre-hash record during publication."""
    if result.get("kind") != KIND and "morphometrics" not in result.get("provenance", {}):
        return
    geometry = _base(result, hashed=False)
    p = result["provenance"]
    record = p.get("morphometrics")
    _exact(
        record,
        {
            "schema",
            "kernel_schema",
            "rules",
            "units",
            "index_axes",
            "object_count",
            "input",
            "parent_chain",
            "resource_estimate",
            "software",
            "calibration_status",
        },
        "morphometrics record",
    )
    if (
        result["kind"] != KIND
        or record["schema"] != SCHEMA
        or record["kernel_schema"] != KERNEL_SCHEMA
        or record["rules"] != RULES
        or record["units"] != _units(geometry)
        or record["index_axes"] != geometry.axes
    ):
        raise ValueError("Persisted morphometrics method, rules or units disagree")
    validate_settings(p.get("accepted_request"))
    binding = {k: p["accepted_request"][k] for k in ("result_id", "revision_hash")}
    if p.get("parent_result") != binding or result.get("parent_id") != binding["result_id"]:
        raise ValueError("Morphometrics parent binding disagrees")
    _exact(
        record["input"],
        {"result_id", "revision_hash", "image_sha256", "labels_sha256"},
        "morphometrics input",
    )
    if any(record["input"][k] != v for k, v in binding.items()) or any(
        record["input"][f"{name}_sha256"] != result["arrays"][name]["sha256"]
        for name in ("image", "labels")
    ):
        raise ValueError("Morphometrics retained arrays differ from the exact parent binding")
    ancestors = record["parent_chain"]
    if (
        not isinstance(ancestors, list)
        or not 1 <= len(ancestors) <= MAX_ANCESTORS
        or ancestors[0] != binding
    ):
        raise ValueError("Morphometrics parent ancestry is missing")
    seen = {result["id"]}
    for ancestor in ancestors:
        _exact(ancestor, {"result_id", "revision_hash"}, "morphometrics ancestor")
        checked_id(ancestor["result_id"])
        _sha(ancestor["revision_hash"])
        if ancestor["result_id"] in seen:
            raise ValueError("Morphometrics ancestry contains duplicate or cyclic identities")
        seen.add(ancestor["result_id"])
    rows = p["measurements"]
    if type(record["object_count"]) is not int or record["object_count"] != len(rows):
        raise ValueError("Morphometrics object count disagrees")
    for row in rows:
        _metric_row(row, geometry)
    calibration = (
        "uncalibrated-pixel-geometry"
        if geometry.unit == "pixel"
        else "declared-physical-calibration"
    )
    if record["calibration_status"] != calibration:
        raise ValueError("Morphometrics calibration status disagrees")
    resources = record["resource_estimate"]
    _exact(
        resources,
        {
            "estimated_working_bytes",
            "working_bytes",
            "scan_chunk_pixels",
            "basis_condition_maximum",
        },
        "morphometrics resource estimate",
    )
    required = estimated_working_bytes(math.prod(result["arrays"]["labels"]["shape"]), len(rows))
    integer(
        resources["working_bytes"],
        "kernel working_bytes",
        1024,
        p["accepted_request"]["working_bytes"],
    )
    if (
        resources["estimated_working_bytes"] != required
        or required > resources["working_bytes"]
        or resources["scan_chunk_pixels"] != CHUNK_PIXELS
        or resources["basis_condition_maximum"] != MAX_BASIS_CONDITION
    ):
        raise ValueError("Morphometrics persisted resource bounds disagree")
    _exact(
        record["software"],
        {"engine", "kernel_sha256", "dispatcher_sha256"},
        "morphometrics software",
    )
    for key in ("kernel_sha256", "dispatcher_sha256"):
        _sha(record["software"][key])
    checked_text(record["software"]["engine"], "Morphometrics engine identity", 64)
    runtime = p.get("runtime")
    _exact(
        runtime,
        {
            "engine",
            "numpy",
            "scipy",
            "scikit_image",
            "requested_device",
            "resolved_device",
            "backend",
            "fallback_reason",
            "scientific_validation",
        },
        "morphometrics runtime identity",
    )
    for key, value in runtime.items():
        if key != "fallback_reason" or value is not None:
            checked_text(value, f"Morphometrics runtime {key}", 256)
    if runtime["engine"] != record["software"]["engine"]:
        raise ValueError("Morphometrics runtime/software engine identities disagree")


def validate_parents(result, results):
    """Pure exact ancestry, original-measurement and retained-artifact validation."""
    validate_record(result)
    p = result["provenance"]
    parent = results.get(p["parent_result"]["result_id"])
    if parent is None or _binding(parent) != p["parent_result"]:
        raise ValueError("Morphometrics exact parent is missing or stale")
    chain = _chain(parent, results.get, p["accepted_request"]["working_bytes"])
    if [_binding(r) for r in chain] != p["morphometrics"]["parent_chain"]:
        raise ValueError("Morphometrics retained ancestry differs from its exact parents")
    if any(result[k] != parent[k] for k in ("source_id", "source_sha256", "arrays")) or any(
        not _same(p[k], parent["provenance"][k]) for k in ("geometry", "selection")
    ):
        raise ValueError("Morphometrics source, arrays or geometry differ from its parent")
    originals = [
        {k: v for k, v in row.items() if k != "morphometrics"} for row in p["measurements"]
    ]
    if not _same(originals, parent["provenance"]["measurements"]):
        raise ValueError("Morphometrics changed original raw measurements or RMS radii")
    resources = _resources(parent, chain, p["accepted_request"])
    if p["morphometrics"]["resource_estimate"]["working_bytes"] != resources["kernel_budget"]:
        raise ValueError("Morphometrics aggregate memory budget disagrees with exact parents")


def project_parents(project, result, *, check=None):
    """Verify bounded underlying snapshots without recursively reading a forged derivative.

    ResearchProject.result calls this for morphology records. Read/hash-check
    direct immutable rows here so mutually forged derivative parents cannot
    recurse through that loader before the underlying-kind refusal.
    """
    validate_record(result)
    parents, metadata = {}, 0
    for binding in result["provenance"]["morphometrics"]["parent_chain"]:
        if check:
            check()
        with project.connection() as connection:
            row = connection.execute(
                "SELECT record FROM results WHERE id=?", (binding["result_id"],)
            ).fetchone()
        if row is None:
            raise ValueError("Morphometrics parent is missing or stale")
        metadata += len(row[0].encode()) * 16
        if metadata > result["provenance"]["accepted_request"]["working_bytes"]:
            raise ValueError("Morphometrics parents exceed the metadata working-memory budget")
        parent = parse_json(row[0])
        _parent(parent)
        if _binding(parent) != binding:
            raise ValueError("Morphometrics parent is missing or stale")
        parents[parent["id"]] = parent
    validate_parents(result, parents)
    return parents


class _ArrayDigest:
    def __init__(self, check):
        self.hash, self.size, self.check = hashlib.sha256(), 0, check

    def write(self, data):
        if self.check:
            self.check()
        value = memoryview(data).cast("B")
        self.hash.update(value)
        self.size += value.nbytes
        return value.nbytes

    def tell(self):
        return self.size

    def flush(self):
        pass


def validate_arrays(result, arrays, *, check=None):
    """Verify exact NPY identities and recompute only the new scientific endpoints."""
    validate_record(result)
    if set(arrays) != {"image", "labels"}:
        raise ValueError("Morphometrics requires both retained input arrays")
    for name, descriptor in result["arrays"].items():
        if check:
            check()
        array = arrays[name]
        if (
            not isinstance(array, np.ndarray)
            or list(array.shape) != descriptor["shape"]
            or str(array.dtype) != descriptor["dtype"]
        ):
            raise ValueError("Morphometrics retained array shape/dtype disagrees")
        digest = _ArrayDigest(check)
        np.save(digest, array, allow_pickle=False)
        if digest.size != descriptor["bytes"] or digest.hash.hexdigest() != descriptor["sha256"]:
            raise ValueError("Morphometrics retained array hash disagrees")
    record = result["provenance"]["morphometrics"]
    measured = measure_morphometrics(
        arrays["labels"],
        _geometry(result["provenance"]["geometry"]),
        working_bytes=record["resource_estimate"]["working_bytes"],
        check=check,
    )
    _compare_rows(result["provenance"]["measurements"], measured["rows"])


def _compare_rows(rows, measured):
    actual = {r["label"]: r for r in measured}
    if set(actual) != {r["label"] for r in rows}:
        raise ValueError("Morphometrics original rows and retained label population disagree")
    for row in rows:
        current = actual[row["label"]]
        if row["voxel_count"] != current["voxel_count"] or not _same(
            row["morphometrics"],
            {k: v for k, v in current.items() if k not in {"label", "voxel_count"}},
        ):
            raise ValueError("Morphometrics endpoints disagree with retained labels")


def _software():
    from .models import ENGINE_VERSION
    from .working_result import _sha256_file_stable

    path = Path(sys.executable) if getattr(sys, "frozen", False) else Path(__file__)
    dispatcher = _sha256_file_stable(path, reject_symlink=True)[0]
    kernel = (
        dispatcher
        if getattr(sys, "frozen", False)
        else _sha256_file_stable(path.with_name("morphometrics.py"), reject_symlink=True)[0]
    )
    return {"engine": ENGINE_VERSION, "kernel_sha256": kernel, "dispatcher_sha256": dispatcher}


def execute_morphometrics(workbench, request, *, job_id=None, publication_guard=None):
    from .workbench import result_summary, runtime_record

    request = copy.deepcopy(request)
    accepted = validate_request(workbench, request, check=publication_guard)
    parent, geometry = accepted["parent"], accepted["geometry"]
    software, runtime = _software(), runtime_record()

    def check_controls():
        if publication_guard:
            publication_guard()
        if job_id is not None:
            job = workbench.project.job(job_id)
            if job["state"] != "running" or job["cancel_requested"]:
                raise ValueError(
                    "Morphometrics requires its own exact running native job; "
                    "cancelled or stopped before publication"
                )

    def guard():
        check_controls()
        if _software() != software or runtime_record() != runtime:
            raise ValueError("Morphometrics method/runtime changed during execution")
        for record in accepted["chain"]:
            if not _same(workbench.project.result(record["id"]), record):
                raise ValueError("Morphometrics exact parent changed before publication")
        for source in accepted["sources"].values():
            if not _same(workbench.project.source(source["id"], verify=True), source):
                raise ValueError("Morphometrics source changed before publication")
        for descriptor in parent["arrays"].values():
            workbench.project.verify_array(descriptor)
        if job_id is not None:
            job = workbench.project.job(job_id)
            normalized = {"source_id": parent["source_id"], "task_request": request}
            if (
                job["operation"] != "morphometrics_run"
                or job["state"] != "running"
                or job["cancel_requested"]
                or job["request"] != normalized
                or job["request_hash"]
                != _hash({"operation": "morphometrics_run", "request": normalized})
            ):
                raise ValueError("Morphometrics requires its own exact running native job")

    guard()
    arrays = {}
    for name, descriptor in parent["arrays"].items():
        check_controls()
        arrays[name] = workbench.project.load_array(descriptor)
    measured = measure_morphometrics(
        arrays["labels"], geometry, working_bytes=accepted["kernel_budget"], check=check_controls
    )
    by_label = {r["label"]: r for r in measured["rows"]}
    rows = copy.deepcopy(parent["provenance"]["measurements"])
    if set(by_label) != {r["label"] for r in rows}:
        raise ValueError("Morphometrics original rows and retained label population disagree")
    for row in rows:
        current = by_label[row["label"]]
        if row["voxel_count"] != current["voxel_count"]:
            raise ValueError("Morphometrics original counts disagree with retained labels")
        row["morphometrics"] = {
            k: v for k, v in current.items() if k not in {"label", "voxel_count"}
        }
    record = {
        k: measured[k]
        for k in ("rules", "units", "index_axes", "object_count", "resource_estimate")
    }
    record.update(
        schema=SCHEMA,
        kernel_schema=KERNEL_SCHEMA,
        input={
            **_binding(parent),
            **{f"{name}_sha256": parent["arrays"][name]["sha256"] for name in ("image", "labels")},
        },
        parent_chain=[_binding(r) for r in accepted["chain"]],
        software=software,
        calibration_status="uncalibrated-pixel-geometry"
        if geometry.unit == "pixel"
        else "declared-physical-calibration",
    )
    p = parent["provenance"]
    provenance = {
        k: copy.deepcopy(p[k])
        for k in ("geometry", "selection", "measurement_channels", "channel_metadata", "references")
        if k in p
    }
    provenance.update(
        parent_result=_binding(parent),
        accepted_request=request,
        measurements=rows,
        morphometrics=record,
        runtime=runtime,
        measurement_basis=(
            "Original parent measurements retained; added metrics use exact parent label geometry"
        ),
        scientific_validation="unvalidated-descriptive-digital-geometry",
    )
    if job_id is not None:
        provenance["job_id"] = job_id
    # Metadata proof before staging, then the same live guard inside save_result's
    # atomic transaction. No new full-array copies or alternate publication path.
    draft = {
        **parent,
        "id": "0" * 32,
        "kind": KIND,
        "parent_id": parent["id"],
        "provenance": provenance,
    }
    draft.pop("revision_hash")
    canonical_json(draft)  # Refuse oversized derivative metadata before array staging.
    validate_parents(draft, {r["id"]: r for r in accepted["chain"]})
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
    return {
        "adopted": True,
        "result": result_summary(result),
        "morphometrics": record,
        "measurements": rows[:1000],
        "total_measurements": len(rows),
    }


def metric_descriptors(geometry):
    """Code-owned scalar descriptors for population/query/export integration."""
    if not isinstance(geometry, Geometry):
        geometry = _geometry(geometry)
    return _descriptors(geometry.axes, geometry.unit)


def _descriptors(axes, unit):
    fields = (
        (
            ("pixel_union_area", "Digital pixel-union area", "area"),
            ("perimeter", "Exposed-edge perimeter", "distance"),
            ("circularity", "Digital circularity", "ratio"),
            ("eccentricity", "Sample-center eccentricity", "ratio"),
            ("elongation", "Sample-center major/minor elongation", "ratio"),
        )
        if axes == "YX"
        else (
            ("voxel_union_volume", "Digital voxel-union volume", "volume"),
            ("surface_area", "Exposed-face surface area", "area"),
            ("sphericity", "Digital sphericity", "ratio"),
        )
    )
    return [
        {
            "id": "morphometrics:" + name,
            "label": label,
            "kind": kind,
            "unit": _units(unit)[name],
        }
        for name, label, kind in fields
    ]


def metric_values(row, geometry):
    """Finite numbers or explicit nulls; undefined reasons remain in the saved row."""
    if not isinstance(geometry, Geometry):
        geometry = _geometry(geometry)
    value = _metric_row(row, geometry)
    return {d["id"]: value[d["id"].split(":", 1)[1]] for d in metric_descriptors(geometry)}


def population_metrics(row):
    """Typed finite scalar projection; no inferred affine or recalculation of raw data.

    Full geometry/formula/parent validation belongs to validate_record/parents;
    standalone table/population consumers additionally reject malformed values.
    """
    axes, unit = row.get("index_axes"), row.get("distance_unit")
    if axes not in {"YX", "ZYX"} or unit not in {"pixel", "nm", "um", "mm", "m"}:
        raise ValueError("Morphometrics population axes/units are invalid")
    value = row.get("morphometrics")
    _exact(value, ROW_KEYS, "morphometrics population row")
    _finite_tree(value)
    reasons = value["undefined_reasons"]
    if not isinstance(reasons, dict) or set(reasons) != {k for k in SCALARS if value[k] is None}:
        raise ValueError("Morphometrics null values require their explicit undefined reasons")
    descriptors = _descriptors(axes, unit)
    values = {}
    for descriptor in descriptors:
        name = descriptor["id"].split(":", 1)[1]
        item = value[name]
        if item is None:
            if name not in {"eccentricity", "elongation"} or reasons[name] not in {
                "zero-major-center-moment",
                "zero-minor-center-moment",
            }:
                raise ValueError("Morphometrics population metric has an invalid null reason")
        elif (
            type(item) not in (int, float)
            or not math.isfinite(item)
            or (item < 0 if name == "eccentricity" else item <= 0)
            or (name in {"circularity", "eccentricity", "sphericity"} and item > 1)
            or (name == "elongation" and item < 1)
        ):
            raise ValueError("Morphometrics population metric exceeds its finite geometric range")
        values[descriptor["id"]] = item
    return descriptors, values
