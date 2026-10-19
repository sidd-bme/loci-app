"""Exact paired correction effects, historical receipts and reviewed publication.

This endpoint has deliberately separate semantics from study_compare. Labels are
edit identifiers, objects are correlated, and captured metadata is never replaced
by current metadata when reproducing a historical receipt.
"""

from __future__ import annotations

import hashlib
import math
import os
import shutil
import tempfile
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from .export import _fsync_directory, _rename_noreplace, sanitize_basename
from .quantitative import DEFAULT_WORKING_BYTES, MAX_OBJECTS, integer
from .research_annotations import correct_labels
from .research_project import (
    MAX_JSON_BYTES,
    SHA_PATTERN,
    ResearchProject,
    canonical_json,
    checked_id,
)
from .research_review import validate_review
from .study_analysis import measurements_csv, validate_sample_metadata
from .working_result import _sha256_file_stable

SCHEMA = "loci.study-correction-effect/v1"
WEIGHTING = "equal images within biological replicate; equal biological replicates within condition"
INDEPENDENT_N = "declared biological replicate"
INTERPRETATION = (
    "Descriptive paired correction effect; no p-values, significance or biological/causal claims. "
    "Object and image counts are not independent biological n."
)
LABEL_INTERPRETATION = (
    "Retained label IDs are edit identifiers, not one-to-one biological correspondence; "
    "split and merge operations may change identity."
)
_TOP_KEYS = {
    "schema",
    "value",
    "unit",
    "study",
    "independent_n_basis",
    "weighting",
    "before_bindings",
    "after_bindings",
    "images",
    "replicates",
    "conditions",
    "p_values",
    "interpretation",
    "runtime",
    "receipt_sha256",
}


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _same_json(left: Any, right: Any) -> bool:
    """Exact persisted identity; Python equality conflates bool/int/float values."""
    return canonical_json(left) == canonical_json(right)


def _ids(value: Any) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 10_000:
        raise ValueError("Choose a unique bounded set of correction-effect result revisions")
    ids = [checked_id(item) for item in value]
    if len(set(ids)) != len(ids):
        raise ValueError("Correction-effect result revisions must be unique")
    return ids


def validate_request(request: Any) -> dict[str, Any]:
    if (
        not isinstance(request, dict)
        or set(request) != {"before_result_ids", "after_result_ids", "value"}
        or request["value"] != "measure"
    ):
        raise ValueError("Correction effect requires exact before/after lists and value=measure")
    _ids(request["before_result_ids"])
    _ids(request["after_result_ids"])
    return request


def _scope(result: dict[str, Any]) -> dict[str, Any]:
    provenance = result["provenance"]
    external = provenance.get("external_labels")
    method = {
        key: provenance.get(key)
        for key in ("recipe", "recipe_sha256", "cellpose", "model", "segmentation", "processing")
    }
    if external is not None:
        method["external_labels"] = {
            key: external.get(key)
            for key in (
                "schema",
                "producer",
                "producer_identity_basis",
                "upstream_settings",
                "upstream_model",
                "upstream_runtime",
                "upstream_validation",
                "importer",
            )
        }
    return {
        "selection": provenance.get("selection"),
        "geometry": provenance["geometry"],
        "measurement_basis": provenance.get("measurement_basis"),
        "method": _digest(method),
    }


def _review(review: Any, result: dict[str, Any]) -> None:
    if review is None:
        return
    try:
        validate_review(review, result_id=result["id"], revision_hash=result["revision_hash"])
    except ValueError as exc:
        raise ValueError("Correction-effect review snapshot is invalid") from exc


def _binding(result: dict[str, Any], sample: dict[str, Any], review: Any) -> dict[str, Any]:
    _review(review, result)
    metadata = validate_sample_metadata(sample["data"]).to_dict()
    integer(sample["revision"], "sample revision", 1, 2**53 - 1)
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "arrays": result["arrays"],
        "review": review,
        "sample_document": {"revision": sample["revision"], "data": metadata},
        "scope": _scope(result),
    }


def _population(result: dict[str, Any], loader: Callable) -> tuple[np.ndarray, float | None, str]:
    from .workbench import geometry_from_dict

    if result.get("schema") != "loci.research-result/v1" or "labels" not in result["arrays"]:
        raise ValueError("Correction effect supports only ordinary v1 label results")
    geometry = geometry_from_dict(result["provenance"]["geometry"])
    descriptor = result["arrays"]["labels"]
    # The audit replay and unique/count operations share the established bounded
    # correction kernel budget, rather than trusting an unbounded descriptor.
    shape = descriptor.get("shape")
    if (
        not isinstance(shape, list)
        or len(shape) != len(geometry.axes)
        or any(type(n) is not int or n < 1 for n in shape)
        or math.prod(shape) * 112 > DEFAULT_WORKING_BYTES
    ):
        raise ValueError("Correction-effect labels exceed the bounded working-memory budget")
    if result["arrays"].get("image", {}).get("shape") != shape:
        raise ValueError("Correction-effect labels and image grids disagree")
    labels = loader(descriptor)
    if labels.dtype != np.dtype("uint32") or list(labels.shape) != shape:
        raise ValueError("Correction effect requires exact uint32 labels and geometry")
    ids, counts = np.unique(labels, return_counts=True)
    nonzero = ids != 0
    ids, counts = ids[nonzero], counts[nonzero]
    if len(ids) > MAX_OBJECTS:
        raise ValueError("Correction-effect population exceeds the bounded object limit")
    rows = result["provenance"].get("measurements")
    if not isinstance(rows, list) or len(rows) != len(ids):
        raise ValueError("Correction-effect measurement count disagrees with the label array")
    basis = np.asarray(geometry.affine)[:3, : len(geometry.axes)]
    element_measure = float(np.sqrt(np.linalg.det(basis.T @ basis)))
    unit = f"{geometry.unit}^{len(geometry.axes)}"
    kind = "area" if labels.ndim == 2 else "volume"
    expected = {int(label): int(count) for label, count in zip(ids, counts, strict=True)}
    seen = set()
    values = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Correction-effect object measurement is invalid")
        label = row.get("label")
        measure = row.get("measure")
        if (
            type(label) is not int
            or label not in expected
            or label in seen
            or (type(row.get("voxel_count")) is not int or row["voxel_count"] != expected[label])
            or type(measure) not in {int, float}
            or not math.isfinite(measure)
            or measure <= 0
            or (
                measure != float(expected[label] * element_measure)
                or row.get("measure_unit") != unit
                or row.get("measure_kind") != kind
            )
        ):
            raise ValueError("Correction-effect object measure/ID disagrees with exact labels")
        seen.add(label)
        values.append(measure)
    mean = math.fsum(values) / len(values) if values else None
    return labels, mean, unit


def _operation_request(operation: dict[str, Any]) -> dict[str, Any]:
    op = operation.get("op")
    keys = {
        "delete": ("label",),
        "merge": ("source_labels", "target_label"),
        "brush": ("mode", "plane", "index", "radius", "label"),
        "polygon_add": ("plane", "index", "label"),
        "polygon_replace": ("plane", "index", "label"),
        "watershed_split": ("mode", "label", "seeds"),
        "move_boundary_vertex": ("plane", "index", "label"),
    }
    if op not in keys:
        raise ValueError("Unsupported or forged correction audit operation")
    request = {"op": op, "expected_input_sha256": operation["input_labels_sha256"]}
    request.update({key: operation[key] for key in keys[op]})
    if op in {"brush", "polygon_add", "polygon_replace"}:
        request["points"] = [{"u": p[0], "v": p[1]} for p in operation["points_uv"]]
    if op == "watershed_split" and operation["mode"] == "2D":
        request.update({key: operation[key] for key in ("plane", "index")})
    if op == "move_boundary_vertex":
        request["source_vertices"] = [
            {"u": p[0], "v": p[1]} for p in operation["source_vertices_uv"]
        ]
        request["vertices"] = [{"u": p[0], "v": p[1]} for p in operation["vertices_uv"]]
    return request


def _correction(before: dict, after: dict, left: np.ndarray, right: np.ndarray) -> dict:
    from .workbench import geometry_from_dict

    audit = after["provenance"].get("correction")
    if (
        after.get("kind") != "corrected-labels"
        or after.get("parent_id") != before["id"]
        or (
            not isinstance(audit, dict)
            or audit.get("parent_id") != before["id"]
            or audit.get("parent_revision_hash") != before["revision_hash"]
        )
    ):
        raise ValueError("After revision must be the verified direct corrected-labels child")
    if left.shape != right.shape or set(before["arrays"]) != set(after["arrays"]):
        raise ValueError("Correction child has a mismatched array grid")
    for name in before["arrays"]:
        if name != "labels" and not _same_json(before["arrays"][name], after["arrays"][name]):
            raise ValueError("Correction changed a non-label result artifact")
    operations = audit.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 64:
        raise ValueError("Correction child needs a complete bounded audit")
    try:
        requests = [_operation_request(operation) for operation in operations]
        geometry = geometry_from_dict(before["provenance"]["geometry"])
        if any(request["op"] == "move_boundary_vertex" for request in requests):
            from .research_boundary_editing import move_boundary_vertex

            if len(requests) != 1:
                raise ValueError("Boundary vertex correction must be atomic")
            replayed, expected = move_boundary_vertex(left, geometry, requests[0])
        else:
            replayed, expected = correct_labels(left, geometry, requests)
    except (KeyError, TypeError, IndexError) as exc:
        raise ValueError("Correction audit is incomplete or forged") from exc
    actual = {
        key: value
        for key, value in audit.items()
        if key not in {"parent_id", "parent_revision_hash", "working_memory_limit_bytes"}
    }
    if canonical_json(actual) != canonical_json(expected) or not np.array_equal(replayed, right):
        raise ValueError("Correction audit cannot reproduce its exact child labels")
    integer(audit.get("working_memory_limit_bytes"), "correction memory limit", 1, 8 * 1024**3)
    before_ids = set(int(v) for v in np.unique(left) if v)
    after_ids = set(int(v) for v in np.unique(right) if v)
    changed = left != right
    changed_ids = set(int(v) for v in np.unique(left[changed])) | set(
        int(v) for v in np.unique(right[changed])
    )
    return {
        "operations": operations,
        "changed_voxel_count": int(np.count_nonzero(changed)),
        "added_label_ids": sorted(after_ids - before_ids),
        "removed_label_ids": sorted(before_ids - after_ids),
        "changed_retained_label_ids": sorted(before_ids & after_ids & changed_ids),
        "label_identity_interpretation": LABEL_INTERPRETATION,
    }


def build_receipt(
    request: dict,
    results: dict,
    before_bindings: list,
    after_bindings: list,
    loader: Callable,
    runtime: dict,
) -> dict:
    """Reconstruct arithmetic and audit from bound artifacts and captured metadata."""
    validate_request(request)
    selected_ids = set(request["before_result_ids"] + request["after_result_ids"])
    encoded_bytes = 0
    object_count = 0
    for result_id in selected_ids:
        result = results.get(result_id)
        if not isinstance(result, dict):
            raise ValueError("Correction-effect result binding is missing")
        encoded_bytes += len(canonical_json(result).encode())
        rows = result.get("provenance", {}).get("measurements")
        if not isinstance(rows, list):
            raise ValueError("Correction-effect object measurements are invalid")
        object_count += len(rows)
        if encoded_bytes > MAX_JSON_BYTES or object_count > MAX_OBJECTS:
            raise ValueError("Correction-effect cohort exceeds the bounded record/object budget")
    sides = []
    for key, bindings in (
        ("before_result_ids", before_bindings),
        ("after_result_ids", after_bindings),
    ):
        ids = request[key]
        if not isinstance(bindings, list) or len(bindings) != len(ids):
            raise ValueError("Correction-effect result bindings are invalid")
        side = {}
        for result_id, binding in zip(ids, bindings, strict=True):
            result = results.get(result_id)
            if (
                not isinstance(result, dict)
                or not isinstance(binding, dict)
                or set(binding)
                != {
                    "result_id",
                    "revision_hash",
                    "source_id",
                    "source_sha256",
                    "arrays",
                    "review",
                    "sample_document",
                    "scope",
                }
            ):
                raise ValueError("Correction-effect result binding is missing or invalid")
            sample = binding["sample_document"]
            if (
                not isinstance(sample, dict)
                or set(sample) != {"revision", "data"}
                or not _same_json(binding, _binding(result, sample, binding["review"]))
            ):
                raise ValueError("Correction-effect result binding is stale or forged")
            if result["source_id"] in side:
                raise ValueError("Assign exactly one result per source on each side")
            side[result["source_id"]] = (result, binding)
        sides.append(side)
    before, after = sides
    if set(before) != set(after):
        raise ValueError("Correction effect requires the same exact source set")
    images = []
    units, studies, methods, bases, dimensions = set(), set(), set(), set(), set()
    corrections = 0
    for source_id in sorted(before):
        left, left_binding = before[source_id]
        right, right_binding = after[source_id]
        if not _same_json(left_binding["scope"], right_binding["scope"]) or (
            left["source_sha256"] != right["source_sha256"]
            or not _same_json(left_binding["sample_document"], right_binding["sample_document"])
        ):
            raise ValueError("Correction-effect source, selection, geometry or method differs")
        left_labels, left_mean, unit = _population(left, loader)
        right_labels, right_mean, right_unit = _population(right, loader)
        if left_labels.shape != right_labels.shape or unit != right_unit:
            raise ValueError("Correction-effect grids or units differ")
        correction = None
        if left["id"] != right["id"]:
            correction = _correction(left, right, left_labels, right_labels)
            corrections += 1
        metadata = left_binding["sample_document"]["data"]
        scope = left_binding["scope"]
        units.add(unit)
        studies.add(metadata["study"])
        methods.add(scope["method"])
        bases.add(canonical_json(scope["measurement_basis"]))
        dimensions.add(scope["geometry"]["axes"])
        reasons = []
        for name, binding, mean in (
            ("before", left_binding, left_mean),
            ("after", right_binding, right_mean),
        ):
            if binding["review"] and binding["review"]["disposition"] == "excluded":
                reasons.append(name + " excluded")
            if mean is None:
                reasons.append(name + " empty population")
        if metadata["biological_replicate"] is None:
            reasons.append("biological replicate unassigned")
        images.append(
            {
                "source_id": source_id,
                "before_result_id": left["id"],
                "after_result_id": right["id"],
                "metadata": metadata,
                "before_count": len(left["provenance"]["measurements"]),
                "after_count": len(right["provenance"]["measurements"]),
                "count_difference": len(right["provenance"]["measurements"])
                - len(left["provenance"]["measurements"]),
                "before_mean": left_mean,
                "after_mean": right_mean,
                "mean_difference": right_mean - left_mean
                if left_mean is not None and right_mean is not None
                else None,
                "eligible": not reasons,
                "omission_reasons": reasons,
                "needs_review": any(
                    not binding["review"] or binding["review"]["disposition"] == "pending"
                    for binding in (left_binding, right_binding)
                ),
                "correction": correction,
            }
        )
    if not corrections:
        raise ValueError("Choose at least one real direct correction child")
    if any(len(values) != 1 for values in (units, studies, methods, bases, dimensions)):
        raise ValueError(
            "Correction effect requires one study, compatible methods, dimensions and units"
        )
    groups = defaultdict(list)
    conditions_by_name = defaultdict(list)
    for image in images:
        meta = image["metadata"]
        conditions_by_name[(meta["study"], meta["condition"])].append(image)
        if meta["biological_replicate"] is not None:
            groups[(meta["study"], meta["condition"], meta["biological_replicate"])].append(image)
    replicates = []
    for (study, condition, replicate), rows in sorted(groups.items()):
        eligible = [row for row in rows if row["eligible"]]
        means = {
            side: math.fsum(row[side + "_mean"] for row in eligible) / len(eligible)
            if eligible
            else None
            for side in ("before", "after")
        }
        replicates.append(
            {
                "study": study,
                "condition": condition,
                "biological_replicate": replicate,
                "image_pair_count": len(eligible),
                "omitted_image_pair_count": len(rows) - len(eligible),
                "before_mean": means["before"],
                "after_mean": means["after"],
                "mean_difference": means["after"] - means["before"] if eligible else None,
            }
        )
    conditions = []
    for (study, condition), rows in sorted(conditions_by_name.items()):
        selected = [
            row
            for row in replicates
            if row["study"] == study and row["condition"] == condition and row["image_pair_count"]
        ]
        means = {
            side: math.fsum(row[side + "_mean"] for row in selected) / len(selected)
            if selected
            else None
            for side in ("before", "after")
        }
        conditions.append(
            {
                "study": study,
                "condition": condition,
                "biological_n": len(selected),
                "image_pair_count": sum(row["eligible"] for row in rows),
                "omitted_image_pair_count": sum(not row["eligible"] for row in rows),
                "before_mean": means["before"],
                "after_mean": means["after"],
                "mean_difference": means["after"] - means["before"] if selected else None,
            }
        )
    from .workbench import runtime_record

    if (
        not isinstance(runtime, dict)
        or set(runtime) != set(runtime_record())
        or any(
            not isinstance(runtime[key], str) or not runtime[key] or len(runtime[key]) > 256
            for key in runtime
            if key != "fallback_reason"
        )
        or runtime.get("fallback_reason") is not None
        or any(
            runtime[key] != runtime_record()[key]
            for key in ("requested_device", "resolved_device", "backend", "scientific_validation")
        )
    ):
        raise ValueError("Correction-effect runtime identity is invalid")
    receipt = {
        "schema": SCHEMA,
        "value": "measure",
        "unit": next(iter(units)),
        "study": next(iter(studies)),
        "independent_n_basis": INDEPENDENT_N,
        "weighting": WEIGHTING,
        "before_bindings": before_bindings,
        "after_bindings": after_bindings,
        "images": images,
        "replicates": replicates,
        "conditions": conditions,
        "p_values": None,
        "interpretation": INTERPRETATION,
        "runtime": runtime,
    }
    receipt["receipt_sha256"] = _digest(receipt)
    return receipt


def validate_document(document: dict, results: dict, loader: Callable) -> dict:
    data = document.get("data")
    if not isinstance(data, dict) or set(data) != {"request", "receipt"}:
        raise ValueError("Correction-effect comparison document fields are invalid")
    receipt = data["receipt"]
    if (
        not isinstance(receipt, dict)
        or set(receipt) != _TOP_KEYS
        or receipt.get("schema") != SCHEMA
    ):
        raise ValueError("Correction-effect receipt fields are invalid")
    expected = build_receipt(
        data["request"],
        results,
        receipt["before_bindings"],
        receipt["after_bindings"],
        loader,
        receipt["runtime"],
    )
    if not _same_json(receipt, expected) or document["id"] != expected["receipt_sha256"][:32]:
        raise ValueError(
            "Correction-effect receipt cannot reproduce its exact bindings and arithmetic"
        )
    return expected


def _current(project: ResearchProject, bindings: list, *, reviewed: bool = False) -> dict:
    samples = {item["id"]: item for item in project.documents("sample")}
    results = {}
    for binding in bindings:
        result = project.result(binding["result_id"])
        sample = samples.get(result["source_id"])
        if sample is None or not _same_json(
            _binding(result, sample, project.review_state(result["id"])), binding
        ):
            raise ValueError("Correction-effect sample or review bindings are stale; recalculate")
        review = binding["review"]
        if reviewed and (not review or review["disposition"] == "pending"):
            raise ValueError("Review all non-excluded correction-effect revisions before export")
        results[result["id"]] = result
    for result in results.values():
        source = project.source(result["source_id"], verify=True)
        if source["sha256"] != result["source_sha256"]:
            raise ValueError("Correction-effect source identity changed")
        for descriptor in result["arrays"].values():
            project.verify_array(descriptor)
    return results


def execute_effect(
    workbench: Any, request: dict, publication_guard: Callable | None = None
) -> dict:
    from .workbench import runtime_record

    validate_request(request)
    project = workbench.project
    samples = {item["id"]: item for item in project.documents("sample")}
    results = {}
    sides = []
    encoded_bytes = 0
    object_count = 0
    for key in ("before_result_ids", "after_result_ids"):
        bindings = []
        for result_id in request[key]:
            result = project.result(result_id)
            if result_id not in results:
                encoded_bytes += len(canonical_json(result).encode())
                rows = result.get("provenance", {}).get("measurements")
                if not isinstance(rows, list):
                    raise ValueError("Correction effect supports only ordinary v1 label results")
                object_count += len(rows)
                if encoded_bytes > MAX_JSON_BYTES or object_count > MAX_OBJECTS:
                    raise ValueError(
                        "Correction-effect cohort exceeds the bounded record/object budget"
                    )
            sample = samples.get(result["source_id"])
            if sample is None:
                raise ValueError("Assign study/sample metadata to every selected source")
            results[result_id] = result
            bindings.append(_binding(result, sample, project.review_state(result_id)))
        sides.append(bindings)
    _current(project, sides[0] + sides[1])
    receipt = build_receipt(request, results, *sides, project.load_array, runtime_record())
    _current(project, sides[0] + sides[1])
    document_id = receipt["receipt_sha256"][:32]
    stored = {"request": request, "receipt": receipt}
    existing = next(
        (item for item in project.documents("comparison") if item["id"] == document_id), None
    )
    if existing is not None:
        if not _same_json(existing["data"], stored):
            raise ValueError("Stored correction-effect comparison identity is inconsistent")
        document = existing
    else:

        def guard() -> None:
            if publication_guard is not None:
                publication_guard()
            _current(project, sides[0] + sides[1])

        document = project.put_document(
            "comparison", document_id, stored, expected_revision=0, publication_guard=guard
        )
    return {
        **receipt,
        "comparison_document": {"id": document["id"], "revision": document["revision"]},
    }


def export_effect(project: ResearchProject, receipt_sha256: str, destination: str | Path) -> dict:
    """Publish an absent directory only after snapshot reproduction and current review."""
    if not isinstance(receipt_sha256, str) or not SHA_PATTERN.fullmatch(receipt_sha256):
        raise ValueError("Export requires an exact correction-effect receipt SHA-256")
    document = next(
        (item for item in project.documents("comparison") if item["id"] == receipt_sha256[:32]),
        None,
    )
    if document is None or document["data"]["receipt"].get("receipt_sha256") != receipt_sha256:
        raise ValueError("Correction-effect receipt is not part of this study")
    receipt = document["data"]["receipt"]
    bindings = receipt["before_bindings"] + receipt["after_bindings"]
    results = _current(project, bindings, reviewed=True)
    validate_document(document, results, project.load_array)
    target = Path(destination)
    if not target.is_absolute() or target.exists() or target.is_symlink():
        raise ValueError(
            "Export needs an absent absolute destination; existing work is never overwritten"
        )
    parent = target.parent.resolve(strict=True)
    parent_stat = parent.stat()
    target = parent / sanitize_basename(target.name, fallback="loci-correction-effect")
    if target.exists() or target.is_symlink() or project.root.is_relative_to(target):
        raise ValueError("Correction-effect export destination is invalid or already exists")
    stage = Path(tempfile.mkdtemp(prefix=".loci-correction-effect-", dir=parent))
    try:
        from .research_interchange import _reject_absolute_strings

        _reject_absolute_strings(receipt, "Correction-effect receipt")
        payloads = {"receipt.json": canonical_json(receipt) + "\n"}
        for name, rows in (
            ("image-pairs.csv", receipt["images"]),
            ("biological-replicates.csv", receipt["replicates"]),
            ("conditions.csv", receipt["conditions"]),
        ):
            flat = []
            for row in rows:
                record = {
                    key: value if not isinstance(value, (dict, list)) else canonical_json(value)
                    for key, value in row.items()
                    if key not in {"metadata", "correction"}
                }
                if "metadata" in row:
                    record.update(row["metadata"])
                record["unit"] = receipt["unit"]
                flat.append(record)
            payloads[name] = measurements_csv(flat)
        payloads["methods.txt"] = "\n".join(
            [
                "Executed Loci paired correction-effect methods",
                f"Receipt: {receipt_sha256}",
                f"Endpoint: measure ({receipt['unit']}); "
                "object area or volume from recorded geometry.",
                f"Weighting: {WEIGHTING}.",
                f"Independent n: {INDEPENDENT_N}.",
                "Both sides use identical eligible image pairs. A pair is omitted on both sides if",
                "either revision is excluded or empty, or its biological replicate is unassigned.",
                "Empty populations and undefined means: null in JSON; blank in CSV; never zero.",
                "Signed differences are after minus before. Counts are descriptive,",
                "not independent biological n.",
                LABEL_INTERPRETATION,
                INTERPRETATION,
                "Exact result/source/array identities, captured sample metadata and reviews,",
                "operations and changed label memberships are recorded in receipt.json.",
                "Runtime: " + canonical_json(receipt["runtime"]),
                "",
            ]
        )
        files = []
        for name, payload in sorted(payloads.items()):
            entry = stage / name
            with entry.open("xb") as stream:
                stream.write(payload.encode())
                stream.flush()
                os.fsync(stream.fileno())
            digest, size = _sha256_file_stable(entry, reject_symlink=True)
            files.append({"name": name, "sha256": digest, "size_bytes": size})
        manifest = {
            "schema": "loci.correction-effect-export/v1",
            "receipt_sha256": receipt_sha256,
            "files": files,
        }
        encoded = canonical_json(manifest).encode()
        with (stage / "manifest.json").open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        _fsync_directory(stage)
        # Serialize the final sample/review recheck and rename against project
        # metadata writers. Filesystem source/artifact checks also run immediately
        # before publication and destination publication is no-replace.
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _current(project, bindings, reviewed=True)
            current = parent.stat()
            if (current.st_dev, current.st_ino) != (parent_stat.st_dev, parent_stat.st_ino):
                raise ValueError("Correction-effect export directory changed during publication")
            if not _same_json(
                next(
                    (
                        item
                        for item in project.documents("comparison")
                        if item["id"] == document["id"]
                    ),
                    None,
                ),
                document,
            ):
                raise ValueError("Correction-effect comparison changed during publication")
            _rename_noreplace(stage, target)
        _fsync_directory(parent)
        return {
            "receipt_sha256": receipt_sha256,
            "files": [item["name"] for item in files] + ["manifest.json"],
            "manifest_sha256": hashlib.sha256(encoded).hexdigest(),
        }
    finally:
        if stage.exists() and not stage.is_symlink():
            shutil.rmtree(stage)
