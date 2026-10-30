"""Raw nuclear-to-perinuclear-ring measurements on one exact native 2D grid.

Rings are geometric proxies, never inferred cell or cytoplasm boundaries. Every
nucleus competes for ring pixels, including nuclei excluded from the endpoint.
"""

from __future__ import annotations

import copy
import math
import statistics
from typing import TYPE_CHECKING, Any

import numpy as np
from scipy import ndimage as ndi

from .quantitative import MAX_OBJECTS, finite_number, integer, measure_objects, validate_array
from .research_project import canonical_json, checked_id, checked_text

if TYPE_CHECKING:
    from .workbench import Workbench

SCHEMA = "loci.perinuclear-enrichment/v1"
KIND = "perinuclear-enrichment"
REQUEST_KEYS = {
    "result_id",
    "revision_hash",
    "signal_channel",
    "radius_px",
    "working_bytes",
    "control",
}
REASONS = ("boundary-touching-nucleus", "empty-ring", "zero-mean-ring")
RULES = {
    "distance_basis": "Euclidean pixel-center distance on native YX indices; inclusive radius",
    "overlap_policy": "discard every pixel claimed by more than one nucleus",
    "nucleus_policy": "all positive nucleus labels block and compete, including excluded nuclei",
    "boundary_policy": "exclude nuclei touching the full source image boundary",
    "empty_policy": "empty ring count/sum zero and mean null; excluded ratio null",
    "zero_policy": "zero-mean rings excluded; no epsilon, imputation or intensity gate",
    "signal_policy": (
        "nonnegative raw selected-plane samples; reject negatives without clipping or offset"
    ),
    "interpretation": "nuclear-to-perinuclear-ring enrichment proxy; not true cytoplasm",
    "endpoint": "median of eligible per-object nuclear-mean / ring-mean raw signal ratios",
}
NUCLEUS_CONTEXT = (
    "runtime",
    "profile",
    "model",
    "settings",
    "accepted_request",
    "segmentation",
    "recipe",
    "processing",
    "preprocessing",
    "correction",
    "channel_metadata",
    "external_labels",
    "measurement_channels",
    "measurement_basis",
    "source_derivation",
    "scientific_validation",
)


def _same(first, second):
    return canonical_json(first) == canonical_json(second)


def _radius(value):
    radius = finite_number(value, "ring radius in pixels", 0, 128)
    if radius == 0:
        raise ValueError("Ring radius must be greater than zero")
    return radius


def _nucleus_analysis(parent):
    return {
        "kind": parent["kind"],
        "engine_version": parent["engine_version"],
        "provenance": {
            key: copy.deepcopy(parent["provenance"][key])
            for key in NUCLEUS_CONTEXT
            if key in parent["provenance"]
        },
    }


def _required_bytes(shape, object_count, retained_bytes=0):
    return math.prod(shape) * 192 + object_count * 16384 + retained_bytes


def _nonnegative_raw(raw):
    if np.any(raw < 0):
        raise ValueError(
            "Perinuclear fluorescence enrichment requires nonnegative raw signal samples; "
            "choose a nonnegative acquisition channel. Values are never clipped or offset."
        )


def nucleus_result_eligible(parent: dict[str, Any]) -> bool:
    """Renderer-safe label eligibility; source/grid/resource checks remain required."""
    provenance = parent.get("provenance", {})
    return (
        parent.get("schema") == "loci.research-result/v1"
        and {"image", "labels"} <= set(parent.get("arrays", {}))
        and not provenance.get("derived_measurement_arrays")
        and not provenance.get("stain_separation")
        and not any(
            key in provenance for key in ("perinuclear", "association", "tracking", "spatial")
        )
    )


def validate_request(workbench: Workbench, request: Any) -> dict[str, Any]:
    """No array decoding or analysis: bind a full native plane and exact parent."""
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        raise ValueError("Perinuclear enrichment requires one exact revision-bound request")
    integer(request["working_bytes"], "working_bytes", 1024**2, 8 * 1024**3)
    radius = _radius(request["radius_px"])
    checked_text(request["control"], "Perinuclear controls and assumptions", 2048)
    parent = workbench.project.result(checked_id(request["result_id"]))
    if parent["revision_hash"] != request["revision_hash"]:
        raise ValueError("Perinuclear nucleus result revision is stale")
    provenance = parent["provenance"]
    if not nucleus_result_eligible(parent):
        raise ValueError("Choose the underlying native nucleus label result")
    source = workbench.project.source(parent["source_id"], verify=True)
    if source["sha256"] != parent["source_sha256"]:
        raise ValueError("Perinuclear nucleus source fingerprint changed")
    if source.get("source_kind") != "native" or source["metadata"].get("sample_semantics") in {
        "RGB",
        "RGBA",
    }:
        raise ValueError("Perinuclear enrichment requires native scalar acquisition channels")
    selection = provenance.get("selection")
    if not isinstance(selection, dict) or set(selection) != {
        "x",
        "y",
        "width",
        "height",
        "t",
        "c",
        "z",
        "level",
    }:
        raise ValueError("Perinuclear enrichment requires one fully resolved native 2D plane")
    dimensions = workbench.inspect(source["id"])["metadata"]["dimensions"]
    if (
        selection["x"] != 0
        or selection["y"] != 0
        or selection["level"] != 0
        or selection["width"] != dimensions["x"]
        or selection["height"] != dimensions["y"]
        or not _same(workbench.selection(source["id"], selection), selection)
    ):
        raise ValueError("Perinuclear enrichment requires the full level-zero source image plane")
    channel = integer(
        request["signal_channel"], "raw signal channel", 0, min(255, dimensions["c"] - 1)
    )
    geometry = provenance.get("geometry")
    shape = [selection["height"], selection["width"]]
    if (
        not isinstance(geometry, dict)
        or geometry.get("axes") != "YX"
        or parent["arrays"]["labels"]["shape"] != shape
        or parent["arrays"]["image"]["shape"] != shape
        or np.dtype(parent["arrays"]["labels"]["dtype"]).kind not in "ui"
    ):
        raise ValueError("Nucleus labels must share the exact native scalar YX grid")
    # One full-sized EDT workspace, retained input/output arrays, label geometry
    # and source-reader workspaces are bounded together before any array read.
    required = _required_bytes(shape, 0, 16 * len(canonical_json(parent).encode()))
    if required > request["working_bytes"]:
        raise ValueError("Perinuclear inputs exceed the aggregate working-memory budget")
    return {
        "parent": parent,
        "source": source,
        "selection": {**selection, "c": channel},
        "radius": radius,
        "estimated_bytes": required,
    }


def _stats(values: np.ndarray) -> dict[str, Any]:
    values = np.asarray(values, dtype=np.float64)
    count = int(values.size)
    total = math.fsum(values)
    result = {
        "count": count,
        "sum": total,
        "mean": total / count if count else None,
        "min": float(values.min()) if count else None,
        "max": float(values.max()) if count else None,
        "std_population": float(values.std(ddof=0)) if count else None,
    }
    if any(value is not None and not math.isfinite(value) for value in result.values()):
        raise ValueError("Perinuclear raw statistics must be finite")
    return result


def summary_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ratios = [
        row["perinuclear_ring"]["nuclear_to_ring_mean_ratio"]
        for row in rows
        if not row["perinuclear_ring"]["exclusions"]
    ]
    return {
        "object_count": len(rows),
        "eligible_count": len(ratios),
        "excluded_count": len(rows) - len(ratios),
        "excluded_by_reason": {
            reason: sum(reason in row["perinuclear_ring"]["exclusions"] for row in rows)
            for reason in REASONS
        },
        "endpoint_defined": bool(ratios),
        "median_ratio": statistics.median(ratios) if ratios else None,
        "mean_ratio": math.fsum(ratios) / len(ratios) if ratios else None,
    }


def _ring_masks(labels, rows, radius):
    """One mask kernel shared by execution and persisted-mask verification."""
    pad = math.ceil(radius)
    regions = [
        tuple(
            slice(max(0, a - pad), min(size, b + pad))
            for a, b, size in zip(
                row["bbox_start"], row["bbox_stop_exclusive"], labels.shape, strict=True
            )
        )
        for row in rows
    ]
    # Disconnected/interleaved labels must not turn local EDTs into unbounded
    # objects-times-full-image work. This is a rejection, never approximation.
    if sum(math.prod(s.stop - s.start for s in region) for region in regions) > max(
        64 * labels.size, 1024**2
    ):
        raise ValueError("Perinuclear candidate windows exceed the bounded overlap work allowance")
    claims = np.zeros(labels.shape, dtype=np.uint32)
    owners = np.zeros(labels.shape, dtype=np.uint32)
    for row, region in zip(rows, regions, strict=True):
        local = labels[region]
        candidate = (local == 0) & (ndi.distance_transform_edt(local != row["label"]) <= radius)
        claims[region][candidate] += 1
        owners[region][candidate] = row["label"]
    ambiguous = (claims > 1).astype(np.uint8)
    owners[claims != 1] = 0
    return owners, ambiguous, regions


def measure_rings(labels, raw, geometry, radius, *, working_bytes, retained_bytes=0):
    """Construct each inclusive radius band; nearest-only allocation is insufficient."""
    validate_array(labels, geometry=geometry, labels=True, working_bytes=working_bytes)
    validate_array(raw, geometry=geometry, working_bytes=working_bytes)
    _nonnegative_raw(raw)
    if labels.ndim != 2 or labels.shape != raw.shape or int(labels.max()) > 2**32 - 1:
        raise ValueError(
            "Perinuclear labels and raw signal must share one uint32-compatible YX grid"
        )
    ids = np.unique(labels)
    count = int(np.count_nonzero(ids))
    required = _required_bytes(labels.shape, count, retained_bytes)
    if count > MAX_OBJECTS or required > working_bytes:
        raise ValueError("Perinuclear objects exceed the aggregate working-memory budget")
    rows = measure_objects(labels, geometry, working_bytes=working_bytes)
    owners, ambiguous, regions = _ring_masks(labels, rows, radius)
    for row, region in zip(rows, regions, strict=True):
        nuclear = _stats(raw[region][labels[region] == row["label"]])
        ring = _stats(raw[region][owners[region] == row["label"]])
        reasons = []
        if row["touches_crop_border"]:
            reasons.append(REASONS[0])
        if ring["count"] == 0:
            reasons.append(REASONS[1])
        elif ring["mean"] == 0:
            reasons.append(REASONS[2])
        ratio = None if reasons else nuclear["mean"] / ring["mean"]
        if ratio is not None and not math.isfinite(ratio):
            raise ValueError("Perinuclear ratio must be finite; no clipping or epsilon is applied")
        row["perinuclear_ring"] = {
            "count": ring["count"],
            "sum": ring["sum"],
            "mean": ring["mean"],
            "nuclear_to_ring_mean_ratio": ratio,
            "exclusions": reasons,
        }
        row["intensity"] = {
            "raw_signal": {key: value for key, value in nuclear.items() if key != "count"}
        }
    return rows, owners, ambiguous, required


def validate_record(result: dict[str, Any]) -> None:
    """Fail closed on malformed or stale-shaped persisted scientific records."""
    if result.get("kind") != KIND and "perinuclear" not in result.get("provenance", {}):
        return
    provenance = result["provenance"]
    record = provenance.get("perinuclear")
    if (
        result.get("kind") != KIND
        or not isinstance(record, dict)
        or set(record)
        != {"schema", "radius_px", "control", "signal_channel", "nucleus_result", "summary", *RULES}
        or record.get("schema") != SCHEMA
        or any(record.get(key) != value for key, value in RULES.items())
    ):
        raise ValueError("Invalid persisted perinuclear contract")
    _radius(record["radius_px"])
    channel = integer(record["signal_channel"], "raw signal channel", 0, 255)
    checked_text(record["control"], "Perinuclear controls and assumptions", 2048)
    selection = provenance.get("selection", {})
    binding = provenance.get("parent_result", {})
    if (
        provenance.get("measurement_channels") != [channel]
        or selection.get("c") != channel
        or provenance.get("measurement_basis") != "raw-selected-channel-values-on-result-grid"
        or result.get("parent_id") != binding.get("result_id")
        or record["nucleus_result"]
        != {key: binding.get(key) for key in ("result_id", "revision_hash")}
        or binding.get("source_id") != result.get("source_id")
        or binding.get("source_sha256") != result.get("source_sha256")
        or not _same(result["arrays"].get("labels"), binding.get("arrays", {}).get("labels"))
        or not _same(provenance.get("geometry"), binding.get("geometry"))
        or not _same(
            {k: v for k, v in selection.items() if k != "c"},
            {k: v for k, v in binding.get("selection", {}).items() if k != "c"},
        )
    ):
        raise ValueError("Perinuclear source, channel or nucleus-grid binding changed")
    analysis = provenance.get("nucleus_analysis")
    if (
        not isinstance(analysis, dict)
        or set(analysis) != {"kind", "engine_version", "provenance"}
        or not isinstance(analysis["provenance"], dict)
        or not set(analysis["provenance"]) <= set(NUCLEUS_CONTEXT)
    ):
        raise ValueError("Perinuclear input analysis provenance is missing or invalid")
    arrays = result.get("arrays", {})
    if (
        set(arrays) != {"image", "labels", "ring_labels", "ring_ambiguous"}
        or any(value.get("shape") != arrays["labels"]["shape"] for value in arrays.values())
        or arrays["ring_labels"].get("dtype") != "uint32"
        or arrays["ring_ambiguous"].get("dtype") != "uint8"
    ):
        raise ValueError("Perinuclear artifacts must share the exact saved label grid")
    rows = provenance.get("measurements")
    if not isinstance(rows, list) or len(rows) > MAX_OBJECTS:
        raise ValueError("Invalid persisted perinuclear measurement rows")
    guard = provenance.get("resource_guard")
    if not isinstance(guard, dict) or set(guard) != {
        "working_memory_limit_bytes",
        "aggregate_required_bytes",
    }:
        raise ValueError("Perinuclear resource guard must record its exact aggregate budget")
    budget = integer(
        guard["working_memory_limit_bytes"], "perinuclear working bytes", 1024**2, 8 * 1024**3
    )
    required = integer(
        guard["aggregate_required_bytes"], "perinuclear aggregate required bytes", 0, 8 * 1024**3
    )
    if not _required_bytes(arrays["labels"]["shape"], len(rows)) <= required <= budget:
        raise ValueError("Persisted perinuclear aggregate working-memory budget is invalid")
    labels = set()
    for row in rows:
        label = integer(row.get("label"), "nucleus label", 1, 2**32 - 1)
        if label in labels:
            raise ValueError("Duplicate perinuclear nucleus measurement")
        labels.add(label)
        ring = row.get("perinuclear_ring")
        if not isinstance(ring, dict) or set(ring) != {
            "count",
            "sum",
            "mean",
            "nuclear_to_ring_mean_ratio",
            "exclusions",
        }:
            raise ValueError("Invalid perinuclear ring statistics")
        count = integer(ring["count"], "ring count", 0, math.prod(arrays["labels"]["shape"]))
        total = finite_number(ring["sum"], "ring sum", 0, 1e40)
        mean = ring["mean"]
        if (count == 0 and (total != 0 or mean is not None)) or (
            count > 0 and (type(mean) not in {int, float} or mean != total / count)
        ):
            raise ValueError("Perinuclear ring count, sum and mean disagree")
        reasons = [REASONS[0]] if row.get("touches_crop_border") else []
        if type(row.get("touches_crop_border")) is not bool:
            raise ValueError("Nucleus boundary status must be explicit")
        reasons += [REASONS[1]] if count == 0 else [REASONS[2]] if mean == 0 else []
        if ring["exclusions"] != reasons:
            raise ValueError("Perinuclear exclusions disagree with recorded counts and boundary")
        intensity = row.get("intensity", {})
        if set(intensity) != {f"source_channel_{channel}"}:
            raise ValueError("Perinuclear raw signal channel is not explicit")
        nucleus = intensity[f"source_channel_{channel}"]
        nuclear_count = integer(
            row.get("voxel_count"), "nucleus count", 1, math.prod(arrays["labels"]["shape"])
        )
        for key in ("mean", "sum", "min", "max", "std_population"):
            finite_number(nucleus.get(key), f"nuclear {key}", 0, 1e40)
        if (
            nucleus["mean"] < nucleus["min"]
            and not math.isclose(nucleus["mean"], nucleus["min"], rel_tol=1e-12)
            or nucleus["mean"] > nucleus["max"]
            and not math.isclose(nucleus["mean"], nucleus["max"], rel_tol=1e-12)
        ):
            raise ValueError("Nuclear raw mean is outside its saved nonnegative intensity bounds")
        if nucleus["mean"] != nucleus["sum"] / nuclear_count:
            raise ValueError("Nuclear raw count, sum and mean disagree")
        ratio = None if reasons else nucleus["mean"] / mean
        if (
            ring["nuclear_to_ring_mean_ratio"] != ratio
            or ratio is not None
            and not math.isfinite(ratio)
        ):
            raise ValueError("Perinuclear ratio disagrees with the raw means")
    if not _same(record["summary"], summary_rows(rows)):
        raise ValueError("Perinuclear summary disagrees with its eligible object rows")
    from .research_population import _objects

    _objects(rows, arrays["labels"]["shape"])


def validate_parent(result: dict[str, Any], parent: dict[str, Any]) -> None:
    validate_record(result)
    binding = result["provenance"]["parent_result"]
    if not _same(
        binding,
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "source_id": parent["source_id"],
            "source_sha256": parent["source_sha256"],
            "arrays": parent["arrays"],
            "selection": parent["provenance"]["selection"],
            "geometry": parent["provenance"]["geometry"],
        },
    ):
        raise ValueError("Perinuclear nucleus input revision, artifacts or grid changed")
    if not _same(result["provenance"]["nucleus_analysis"], _nucleus_analysis(parent)):
        raise ValueError("Perinuclear nucleus analysis provenance changed")
    required = _required_bytes(
        result["arrays"]["labels"]["shape"],
        len(result["provenance"]["measurements"]),
        16 * len(canonical_json(parent).encode()),
    )
    guard = result["provenance"]["resource_guard"]
    if (
        guard["aggregate_required_bytes"] != required
        or guard["working_memory_limit_bytes"] < required
    ):
        raise ValueError(
            "Persisted perinuclear aggregate budget disagrees with the retained nucleus input"
        )


def validate_source(result: dict[str, Any], source: dict[str, Any]) -> None:
    """Validate persisted acquisition scope without requiring external raw files online."""
    metadata = source.get("metadata", {})
    dimensions = metadata.get("dimensions")
    if (
        source.get("id") != result["source_id"]
        or source.get("sha256") != result["source_sha256"]
        or source.get("source_kind") != "native"
        or metadata.get("sample_semantics") in {"RGB", "RGBA"}
        or not isinstance(dimensions, dict)
    ):
        raise ValueError("Perinuclear persisted source must be the bound native scalar acquisition")
    for axis in ("x", "y", "c", "z", "t"):
        integer(dimensions.get(axis), f"perinuclear source {axis} size", 1, 2**31 - 1)
    selections = (
        result["provenance"]["selection"],
        result["provenance"]["parent_result"]["selection"],
    )
    for selection in selections:
        if (
            set(selection) != {"x", "y", "width", "height", "c", "z", "t", "level"}
            or any(type(value) is not int for value in selection.values())
            or selection["x"] != 0
            or selection["y"] != 0
            or selection["level"] != 0
            or selection["width"] != dimensions["x"]
            or selection["height"] != dimensions["y"]
        ):
            raise ValueError(
                "Persisted perinuclear selection must occupy the full level-zero source plane"
            )
        for axis in ("c", "z", "t"):
            integer(selection[axis], f"persisted perinuclear {axis} index", 0, dimensions[axis] - 1)
    if result["arrays"]["labels"]["shape"] != [dimensions["y"], dimensions["x"]]:
        raise ValueError("Persisted perinuclear labels disagree with the source image dimensions")


def validate_arrays(
    result: dict[str, Any], arrays: dict[str, np.ndarray], *, parent: dict[str, Any]
) -> None:
    """Verify saved mask counts and raw arithmetic at export/restore, without refitting."""
    validate_parent(result, parent)
    provenance = result["provenance"]
    from .workbench import geometry_from_dict, result_working_bytes

    geometry = geometry_from_dict(provenance["geometry"])
    budget = result_working_bytes(result)
    labels, raw = arrays["labels"], arrays["image"]
    rings, ambiguous = arrays["ring_labels"], arrays["ring_ambiguous"]
    validate_array(labels, geometry=geometry, labels=True, working_bytes=budget)
    validate_array(raw, geometry=geometry, working_bytes=budget)
    _nonnegative_raw(raw)
    if (
        any(array.shape != labels.shape for array in arrays.values())
        or rings.dtype != np.uint32
        or ambiguous.dtype != np.uint8
        or np.any((ambiguous != 0) & (ambiguous != 1))
        or np.any((labels > 0) & ((rings > 0) | (ambiguous > 0)))
        or np.any((rings > 0) & (ambiguous > 0))
    ):
        raise ValueError("Perinuclear mask artifacts overlap nuclei or discarded pixels")
    nuclear_ids, nuclear_counts = np.unique(labels[labels > 0], return_counts=True)
    ring_ids, ring_counts = np.unique(rings[rings > 0], return_counts=True)
    nuclear_counts = dict(zip(map(int, nuclear_ids), map(int, nuclear_counts), strict=True))
    ring_counts = dict(zip(map(int, ring_ids), map(int, ring_counts), strict=True))
    rows = provenance["measurements"]
    if set(nuclear_counts) != {row["label"] for row in rows} or not set(ring_counts) <= set(
        nuclear_counts
    ):
        raise ValueError("Perinuclear mask identities disagree with object measurements")
    expected_rows = {
        row["label"]: row for row in measure_objects(labels, geometry, working_bytes=budget)
    }
    for row in rows:
        expected_row = expected_rows[row["label"]]
        if set(row) != {*expected_row, "perinuclear_ring"} or not _same(
            {key: row[key] for key in expected_row if key != "intensity"},
            {key: value for key, value in expected_row.items() if key != "intensity"},
        ):
            raise ValueError(
                "Perinuclear object geometry disagrees with the exact native nucleus grid"
            )
    channel = provenance["perinuclear"]["signal_channel"]
    expected, shared, regions = _ring_masks(labels, rows, provenance["perinuclear"]["radius_px"])
    if not np.array_equal(rings, expected) or not np.array_equal(ambiguous, shared):
        raise ValueError(
            "Saved perinuclear masks disagree with the declared radius and competition"
        )
    border_ids = set(
        map(int, np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1]))))
    )
    for row, region in zip(rows, regions, strict=True):
        nuclear = _stats(raw[region][labels[region] == row["label"]])
        ring = _stats(raw[region][rings[region] == row["label"]])
        if (
            nuclear_counts[row["label"]] != row["voxel_count"]
            or row["touches_crop_border"] != (row["label"] in border_ids)
            or nuclear["count"] != row["voxel_count"]
            or not _same(
                {k: v for k, v in nuclear.items() if k != "count"},
                row["intensity"][f"source_channel_{channel}"],
            )
            or ring_counts.get(row["label"], 0) != row["perinuclear_ring"]["count"]
            or any(row["perinuclear_ring"][key] != ring[key] for key in ("count", "sum", "mean"))
        ):
            raise ValueError("Perinuclear raw statistics disagree with saved mask artifacts")


def execute_perinuclear(
    workbench: Workbench, request: dict[str, Any], *, job_id=None, publication_guard=None
):
    accepted = validate_request(workbench, request)
    parent, source = accepted["parent"], accepted["source"]
    metadata = workbench.channel_metadata(source["id"])
    labels = workbench.project.load_array(parent["arrays"]["labels"])
    raw, geometry, selection = workbench.load_scalar(
        source["id"], accepted["selection"], working_bytes=request["working_bytes"]
    )
    if not _same(geometry.to_dict(), parent["provenance"]["geometry"]) or not _same(
        selection, accepted["selection"]
    ):
        raise ValueError("Raw perinuclear signal disagrees with the exact nucleus grid")
    rows, rings, ambiguous, required = measure_rings(
        labels,
        raw,
        geometry,
        accepted["radius"],
        working_bytes=request["working_bytes"],
        retained_bytes=16 * len(canonical_json(parent).encode()),
    )
    channel = request["signal_channel"]
    for row in rows:
        row["intensity"] = {f"source_channel_{channel}": row["intensity"]["raw_signal"]}
    summary = summary_rows(rows)
    contract = {
        "schema": SCHEMA,
        **RULES,
        "radius_px": accepted["radius"],
        "control": request["control"],
        "signal_channel": channel,
        "summary": summary,
        "nucleus_result": {"result_id": parent["id"], "revision_hash": parent["revision_hash"]},
    }
    from .research_quantification import _result_binding
    from .workbench import result_summary, runtime_record

    provenance = {
        "selection": selection,
        "geometry": geometry.to_dict(),
        "parent_result": _result_binding(parent, source),
        "nucleus_analysis": _nucleus_analysis(parent),
        "channel_metadata": copy.deepcopy(metadata),
        "measurement_channels": [channel],
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "measurements": rows,
        "perinuclear": contract,
        "runtime": runtime_record(),
        "resource_guard": {
            "working_memory_limit_bytes": request["working_bytes"],
            "aggregate_required_bytes": max(required, accepted["estimated_bytes"]),
        },
        "scientific_validation": "unvalidated descriptive research proxy",
    }
    if job_id is not None:
        provenance["job_id"] = job_id

    def guard():
        if publication_guard is not None:
            publication_guard()
        current = workbench.project.result(parent["id"])
        if not _same(current, parent) or not _same(
            workbench.project.source(source["id"], verify=True), source
        ):
            raise ValueError("Perinuclear source or nucleus result changed before publication")
        if not _same(workbench.channel_metadata(source["id"]), metadata):
            raise ValueError("Perinuclear channel metadata changed before publication")
        for descriptor in parent["arrays"].values():
            workbench.project.verify_array(descriptor)

    guard()
    result = workbench.project.save_result(
        source_id=source["id"],
        kind=KIND,
        arrays={"image": raw, "labels": labels, "ring_labels": rings, "ring_ambiguous": ambiguous},
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=guard,
    )
    return {
        "adopted": True,
        "result": result_summary(result),
        "measurements": rows[:1000],
        "total_measurements": len(rows),
        "summary": summary,
        "perinuclear": contract,
    }
