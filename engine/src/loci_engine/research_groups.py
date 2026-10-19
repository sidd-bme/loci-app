"""Exact revision-bound population gates and immutable named memberships.

Gates operate on every stored measurement, never the scatter display sample.
Reusable geometry is evaluated in transformed measurement coordinates. Fixed
memberships retain numeric labels only within their original immutable result.
"""

from __future__ import annotations

import hashlib
import math
import sys
import uuid
from collections.abc import Callable, Iterable
from fractions import Fraction
from typing import Any

from .quantitative import MAX_OBJECTS, exact_keys, integer
from .research_population import _bound, _objects
from .research_project import (
    SHA_PATTERN,
    ResearchProject,
    canonical_json,
    checked_id,
    checked_text,
)

DOCUMENT_KIND = "population_group"
GROUP_SCHEMA = "loci.population-group/v1"
GATE_SCHEMA = "loci.population-gate/v1"
MAX_VERTICES = 64
MAX_GROUP_INPUTS = 32
MAX_GROUPS = 256
MAX_GROUP_DEPTH = 16
BINDING_KEYS = {"result_id", "revision_hash", "source_id", "source_sha256"}


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _sha(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError(f"{name} requires an exact SHA-256")
    return value


def _orient(a, b, c) -> int:
    """Adaptive exact sign avoids fuzzy edges and overflow at finite extremes."""
    ax, ay = b[0] - a[0], b[1] - a[1]
    bx, by = c[0] - a[0], c[1] - a[1]
    left, right = ax * by, ay * bx
    determinant = left - right
    error = max(8 * sys.float_info.epsilon * (abs(left) + abs(right)), math.ulp(0.0))
    if math.isfinite(determinant) and abs(determinant) > error:
        return 1 if determinant > 0 else -1
    ax, ay = Fraction(b[0]) - Fraction(a[0]), Fraction(b[1]) - Fraction(a[1])
    bx, by = Fraction(c[0]) - Fraction(a[0]), Fraction(c[1]) - Fraction(a[1])
    determinant = ax * by - ay * bx
    return (determinant > 0) - (determinant < 0)


def _on_segment(a, b, point) -> bool:
    return (
        min(a[0], b[0]) <= point[0] <= max(a[0], b[0])
        and min(a[1], b[1]) <= point[1] <= max(a[1], b[1])
        and _orient(a, b, point) == 0
    )


def _intersects(a, b, c, d) -> bool:
    sides = (_orient(a, b, c), _orient(a, b, d), _orient(c, d, a), _orient(c, d, b))
    return (sides[0] * sides[1] < 0 and sides[2] * sides[3] < 0) or any(
        sign == 0 and _on_segment(start, stop, point)
        for sign, start, stop, point in (
            (sides[0], a, b, c),
            (sides[1], a, b, d),
            (sides[2], c, d, a),
            (sides[3], c, d, b),
        )
    )


def _polygon(vertices: Any) -> list[list[float]]:
    if not isinstance(vertices, list) or not 3 <= len(vertices) <= MAX_VERTICES:
        raise ValueError("Population polygon requires 3-64 vertices")
    points = []
    for point in vertices:
        if not isinstance(point, list) or len(point) != 2:
            raise ValueError("Polygon vertices require transformed x/y coordinates")
        points.append([_bound(value, "polygon coordinate") for value in point])
    if len({tuple(point) for point in points}) != len(points):
        raise ValueError("Polygon vertices must be distinct; omit a repeated closing vertex")
    area = sum(
        Fraction(a[0]) * Fraction(b[1]) - Fraction(b[0]) * Fraction(a[1])
        for a, b in zip(points, points[1:] + points[:1], strict=True)
    )
    if area == 0:
        raise ValueError("Polygon must enclose a nonzero area")
    size = len(points)
    for index, a in enumerate(points):
        b = points[(index + 1) % size]
        previous = points[(index - 1) % size]
        if _on_segment(previous, a, b) or _on_segment(a, b, previous):
            raise ValueError("Polygon adjacent edges overlap")
        for other in range(index + 1, size):
            if other in {index + 1, (index - 1) % size}:
                continue
            if _intersects(a, b, points[other], points[(other + 1) % size]):
                raise ValueError("Polygon must be simple without intersecting edges")
    return points


def normalize_gate(gate: Any, metrics: list[dict[str, Any]]) -> dict[str, Any]:
    """Bind metric descriptors and units, while retaining reusable geometry."""
    keys = {
        "kind",
        "x_metric",
        "y_metric",
        "x_transform",
        "y_transform",
        "x_descriptor",
        "y_descriptor",
        "edge_policy",
        "bounds",
        "vertices",
    }
    exact_keys(gate, keys, "population gate")
    kind = gate.get("kind")
    if kind not in {"rectangle", "polygon"}:
        raise ValueError("Population gate must be rectangle or polygon")
    geometry_key = "bounds" if kind == "rectangle" else "vertices"
    if geometry_key not in gate or ({"bounds", "vertices"} - {geometry_key}) & set(gate):
        raise ValueError("Population gate geometry disagrees with its kind")
    if gate.get("edge_policy", "include") != "include":
        raise ValueError("Population gate edge policy must be include")
    descriptors = {item["id"]: item for item in metrics}
    normalized: dict[str, Any] = {"kind": kind, "edge_policy": "include"}
    for axis in ("x", "y"):
        metric, transform = gate.get(f"{axis}_metric"), gate.get(f"{axis}_transform", "linear")
        if not isinstance(metric, str) or metric not in descriptors:
            raise ValueError("Population gate requires an actual stored measurement metric")
        if transform not in {"linear", "log10"}:
            raise ValueError("Population gate transform must be linear or log10")
        descriptor = descriptors[metric]
        if f"{axis}_descriptor" in gate and gate[f"{axis}_descriptor"] != descriptor:
            raise ValueError("Reusable gate measurement descriptor or units are incompatible")
        normalized.update(
            {
                f"{axis}_metric": metric,
                f"{axis}_transform": transform,
                f"{axis}_descriptor": descriptor,
            }
        )
    if kind == "rectangle":
        bounds = gate["bounds"]
        if not isinstance(bounds, list) or len(bounds) != 4:
            raise ValueError("Rectangle bounds require [xmin,xmax,ymin,ymax]")
        bounds = [_bound(value, "gate bound") for value in bounds]
        if bounds[0] > bounds[1] or bounds[2] > bounds[3]:
            raise ValueError("Rectangle gate minimum exceeds maximum")
        normalized["bounds"] = bounds
    else:
        normalized["vertices"] = _polygon(gate["vertices"])
    return normalized


def _inside(point, gate) -> bool:
    x, y = point
    if gate["kind"] == "rectangle":
        xmin, xmax, ymin, ymax = gate["bounds"]
        return xmin <= x <= xmax and ymin <= y <= ymax
    inside = False
    vertices = gate["vertices"]
    for a, b in zip(vertices, vertices[1:] + vertices[:1], strict=True):
        if _on_segment(a, b, point):
            return True
        if (a[1] > y) != (b[1] > y):
            orientation = _orient(a, b, point)
            if (orientation > 0) == (b[1] > a[1]):
                inside = not inside
    return inside


def _membership_hash(binding: dict[str, str], labels: list[int]) -> str:
    return _hash({**binding, "labels": labels})


def _evaluate(objects, metrics, gate, binding) -> dict[str, Any]:
    normalized = normalize_gate(gate, metrics)
    selected = []
    missing_count = nonpositive_count = outside_count = 0
    axis_missing = {"x": 0, "y": 0}
    axis_nonpositive = {"x": 0, "y": 0}
    for row in objects:
        point, missing, nonpositive = [], False, False
        for axis in ("x", "y"):
            value = row["values"][normalized[f"{axis}_metric"]]
            invalid_log = (
                value is not None and normalized[f"{axis}_transform"] == "log10" and value <= 0
            )
            axis_missing[axis] += value is None
            axis_nonpositive[axis] += invalid_log
            missing |= value is None
            nonpositive |= invalid_log
            point.append(
                math.log10(value)
                if value is not None
                and not invalid_log
                and normalized[f"{axis}_transform"] == "log10"
                else value
            )
        if missing:
            missing_count += 1
        elif nonpositive:
            nonpositive_count += 1
        elif _inside(point, normalized):
            selected.append(row["label"])
        else:
            outside_count += 1
    labels = sorted(selected)
    return {
        "schema": GATE_SCHEMA,
        **binding,
        "gate": normalized,
        "total_count": len(objects),
        "included_count": len(labels),
        "labels": labels,
        "accounting": {
            "excluded_missing_or_nonfinite_count": missing_count,
            "excluded_nonpositive_log_count": nonpositive_count,
            "excluded_outside_count": outside_count,
            "axis_missing_or_nonfinite_counts": axis_missing,
            "axis_nonpositive_log_counts": axis_nonpositive,
        },
        "population_sha256": _membership_hash(binding, sorted(row["label"] for row in objects)),
        "membership_sha256": _membership_hash(binding, labels),
        "gate_sha256": _hash(normalized),
    }


def evaluate_gate(
    rows: Iterable[dict[str, Any]],
    gate: dict[str, Any],
    binding: dict[str, str],
    *,
    shape: list[int] | None = None,
    include_centroids: bool = False,
) -> dict[str, Any]:
    """Pure complete-population oracle; the caller verifies result/source identity."""
    _validate_binding(binding)
    objects, metrics = _objects(rows, shape)
    receipt = _evaluate(objects, metrics, gate, binding)
    return _with_centroids(receipt, objects, include_centroids)


def _with_centroids(receipt, objects, include):
    if type(include) is not bool:
        raise ValueError("include_centroids must be boolean")
    if not include:
        return receipt
    selected = set(receipt["labels"])
    return {
        **receipt,
        "centroids": [
            {
                "label": row["label"],
                "centroid_index": row["centroid_index"],
                "index_axes": row["index_axes"],
            }
            for row in sorted(objects, key=lambda row: row["label"])
            if row["label"] in selected
        ],
    }


def _validate_binding(binding):
    if not isinstance(binding, dict) or set(binding) != BINDING_KEYS:
        raise ValueError("Population membership requires complete immutable bindings")
    checked_id(binding["result_id"])
    checked_id(binding["source_id"])
    _sha(binding["revision_hash"], "Result revision")
    _sha(binding["source_sha256"], "Source identity")


def _result_objects(result, *, project=None):
    labels = result.get("arrays", {}).get("labels")
    if not isinstance(labels, dict):
        raise ValueError("Population gate requires a label-bearing measured result")
    shape = labels.get("shape")
    if (
        not isinstance(shape, list)
        or len(shape) not in {2, 3}
        or any(type(extent) is not int or extent < 1 for extent in shape)
        or labels.get("dtype")
        not in {
            "uint8",
            "uint16",
            "uint32",
            "uint64",
            "int8",
            "int16",
            "int32",
            "int64",
        }
    ):
        raise ValueError("Population gate requires a YX or ZYX integer label array")
    if result.get("schema") == "loci.research-result/v1":
        rows = result.get("provenance", {}).get("measurements")
        if not isinstance(rows, list) or len(rows) > MAX_OBJECTS:
            raise ValueError("Population gate requires at most 100000 actual measurements")
    elif result.get("schema") == "loci.research-result/v2" and project is not None:
        from .research_tiled_store import iter_object_rows

        integer(result.get("object_count"), "population object count", 0, MAX_OBJECTS)
        rows = iter_object_rows(project, result["object_table"])
    else:
        raise ValueError("Unsupported population gate result schema")
    objects, metrics = _objects(rows, shape)
    if "object_count" in result and (
        type(result["object_count"]) is not int or result["object_count"] != len(objects)
    ):
        raise ValueError("Population count disagrees with actual measurements")
    return objects, metrics


def _context(project, request):
    result_id = checked_id(request.get("result_id"))
    revision = _sha(request.get("revision_hash"), "Population gate result revision")
    result = project.result(result_id)
    if result["revision_hash"] != revision:
        raise ValueError("Population group requires the exact result revision")
    source = project.source(result["source_id"], verify=True)
    if source["sha256"] != result["source_sha256"]:
        raise ValueError("Population result source identity is stale")
    binding = {
        "result_id": result_id,
        "revision_hash": revision,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
    }
    objects, metrics = _result_objects(result, project=project)
    _assert_current(project, binding)
    return objects, metrics, binding


def _assert_current(project, binding):
    if (
        project.result(binding["result_id"])["revision_hash"] != binding["revision_hash"]
        or project.source(binding["source_id"], verify=True)["sha256"] != binding["source_sha256"]
    ):
        raise ValueError("Population group source or result changed during evaluation")


def _record(document):
    if (
        not isinstance(document, dict)
        or set(document) != {"id", "kind", "revision", "updated_at", "data"}
        or document.get("kind") != DOCUMENT_KIND
        or type(document.get("revision")) is not int
        or document["revision"] != 1
    ):
        raise ValueError("Immutable population group envelope is invalid")
    checked_id(document["id"])
    checked_text(document["updated_at"], "Group timestamp", 64)
    data = document["data"]
    if (
        not isinstance(data, dict)
        or set(data) != {"schema", "id", "name", "definition", "receipt", "record_sha256"}
        or data.get("schema") != GROUP_SCHEMA
        or data.get("id") != document["id"]
    ):
        raise ValueError("Population group record is invalid")
    checked_text(data["name"], "Group name", 128)
    if data["record_sha256"] != _hash({k: v for k, v in data.items() if k != "record_sha256"}):
        raise ValueError("Population group record failed integrity verification")
    receipt = data["receipt"]
    if not isinstance(receipt, dict) or not set(receipt) >= BINDING_KEYS:
        raise ValueError("Population group receipt is invalid")
    binding = {key: receipt[key] for key in BINDING_KEYS}
    _validate_binding(binding)
    labels = receipt.get("labels")
    if not isinstance(labels, list) or len(labels) > MAX_OBJECTS:
        raise ValueError("Population group membership exceeds 100000 labels")
    for label in labels:
        integer(label, "group object label", 1, 0xFFFFFFFF)
    if labels != sorted(set(labels)) or receipt.get("membership_sha256") != _membership_hash(
        binding, labels
    ):
        raise ValueError("Population group membership failed integrity verification")
    return data


def _combined(objects, binding, mode, operands):
    universe = {row["label"] for row in objects}
    sets = [set(item["labels"]) for item in operands]
    if any(not labels <= universe for labels in sets):
        raise ValueError("Population group has labels outside its exact revision")
    if mode == "intersection":
        labels = set.intersection(*sets)
    else:
        labels = set.union(*sets) if sets else set()
        if mode == "unclassified":
            labels = universe - labels
    labels = sorted(labels)
    return {
        "schema": "loci.population-combination/v1",
        **binding,
        "mode": mode,
        "total_count": len(objects),
        "included_count": len(labels),
        "labels": labels,
        "population_sha256": _membership_hash(binding, sorted(universe)),
        "membership_sha256": _membership_hash(binding, labels),
    }


def _definition_depth(definition, documents, visiting=frozenset(), depths=None):
    """Bound dependency work before evaluation or publishing a new combination."""
    if not isinstance(definition, dict):
        raise ValueError("Population group definition is invalid")
    if definition.get("kind") == "gate":
        return 1
    references = definition.get("groups")
    if not isinstance(references, list) or len(references) > MAX_GROUP_INPUTS:
        raise ValueError("Population combination requires at most 32 fixed groups")
    depths = {} if depths is None else depths
    maximum = 0
    for reference in references:
        group_id = checked_id(reference.get("group_id") if isinstance(reference, dict) else None)
        if group_id in visiting or len(visiting) >= MAX_GROUP_DEPTH:
            raise ValueError("Population group dependencies are cyclic or exceed 16 levels")
        document = documents.get(group_id)
        if document is None:
            raise ValueError("Population combination group is missing")
        if group_id not in depths:
            data = _record(document)
            depths[group_id] = _definition_depth(
                data["definition"], documents, visiting | {group_id}, depths
            )
        maximum = max(maximum, depths[group_id])
    if maximum >= MAX_GROUP_DEPTH:
        raise ValueError("Population group dependencies exceed 16 levels")
    return maximum + 1


def _reproduce(document, documents, context, cache, visiting):
    group_id = document["id"]
    if group_id in cache:
        return cache[group_id]
    if group_id in visiting or len(visiting) >= MAX_GROUP_DEPTH:
        raise ValueError("Population group dependencies are cyclic or exceed 16 levels")
    data = _record(document)
    if not visiting:
        _definition_depth(data["definition"], documents, frozenset({group_id}))
    receipt = data["receipt"]
    binding = {key: receipt[key] for key in BINDING_KEYS}
    objects, metrics, actual_binding = context(binding)
    if actual_binding != binding:
        raise ValueError("Population group has a stale source or exact result binding")
    definition = data["definition"]
    exact_keys(definition, {"kind", "gate", "mode", "groups"}, "group definition")
    if definition.get("kind") == "gate" and set(definition) == {"kind", "gate"}:
        expected = _evaluate(objects, metrics, definition["gate"], binding)
    elif definition.get("kind") == "combination" and set(definition) == {"kind", "mode", "groups"}:
        mode, references = definition["mode"], definition["groups"]
        if mode not in {"union", "intersection", "unclassified"}:
            raise ValueError("Unsupported population group combination")
        if (
            not isinstance(references, list)
            or len(references) > MAX_GROUP_INPUTS
            or not references
            and mode != "unclassified"
        ):
            raise ValueError("Population combination requires 1-32 fixed groups")
        operands, seen = [], set()
        for reference in references:
            if not isinstance(reference, dict) or set(reference) != {
                "group_id",
                "record_sha256",
                "membership_sha256",
            }:
                raise ValueError("Population combination group reference is invalid")
            dependency_id = checked_id(reference["group_id"])
            dependency = documents.get(dependency_id)
            if dependency is None or dependency_id in seen:
                raise ValueError("Population combination group is missing or repeated")
            seen.add(dependency_id)
            operand = _reproduce(dependency, documents, context, cache, visiting | {group_id})
            if (
                {key: operand[key] for key in BINDING_KEYS} != binding
                or reference["record_sha256"] != dependency["data"]["record_sha256"]
                or reference["membership_sha256"] != operand["membership_sha256"]
            ):
                raise ValueError("Population combination requires the same exact revision")
            operands.append(operand)
        expected = _combined(objects, binding, mode, operands)
    else:
        raise ValueError("Population group definition is invalid")
    if canonical_json(expected) != canonical_json(receipt):
        raise ValueError("Population group receipt is not reproducible from exact measurements")
    cache[group_id] = receipt
    return receipt


def _documents(project):
    documents = project.documents(DOCUMENT_KIND)
    if len(documents) > MAX_GROUPS:
        raise ValueError("Study exceeds 256 immutable population groups")
    indexed = {}
    for document in documents:
        _record(document)
        if document["id"] in indexed:
            raise ValueError("Population group identity is repeated")
        indexed[document["id"]] = document
    return indexed


def validate_group_document(document, sources, results, documents):
    """Portable v1 validator: rederive membership without source locators/decoding.

    Call for export and before portable import publication. V2 portable import
    remains unsupported by the existing interchange contract.
    """
    groups = [item for item in documents if item.get("kind") == DOCUMENT_KIND]
    indexed = {item["id"]: item for item in groups}
    if len(indexed) != len(groups):
        raise ValueError("Population group identity is repeated")
    if len(indexed) > MAX_GROUPS:
        raise ValueError("Study exceeds 256 immutable population groups")
    indexed[document["id"]] = document
    if len(indexed) > MAX_GROUPS:
        raise ValueError("Study exceeds 256 immutable population groups")
    contexts = {}

    def context(binding):
        result = results.get(binding["result_id"])
        source = sources.get(binding["source_id"])
        if (
            result is None
            or source is None
            or source["sha256"] != binding["source_sha256"]
            or result["source_id"] != binding["source_id"]
            or result["source_sha256"] != binding["source_sha256"]
            or result["revision_hash"] != binding["revision_hash"]
            or result["revision_hash"]
            != _hash({key: value for key, value in result.items() if key != "revision_hash"})
        ):
            raise ValueError("Population group has a stale source or exact result binding")
        if result["id"] not in contexts:
            objects, metrics = _result_objects(result)
            contexts[result["id"]] = objects, metrics, binding
        return contexts[result["id"]]

    _reproduce(document, indexed, context, {}, set())


def _is_source_unavailable(exc: BaseException) -> bool:
    if isinstance(exc, (FileNotFoundError, OSError)):
        return True
    if isinstance(exc, ValueError):
        message = str(exc)
        if "unavailable after interchange" in message or "relink an exact local copy" in message:
            return True
    return False


def _reader(project, documents):
    contexts, cache = {}, {}

    def context(binding):
        key = binding["result_id"], binding["revision_hash"]
        if key not in contexts:
            contexts[key] = _context(project, binding)
        return contexts[key]

    def read(group_id):
        document = documents.get(checked_id(group_id))
        if document is None:
            raise ValueError("Population group is not part of this study")
        receipt = _reproduce(document, documents, context, cache, set())
        _assert_current(project, {key: receipt[key] for key in BINDING_KEYS})
        return document, receipt, context({key: receipt[key] for key in BINDING_KEYS})

    return read


def _save(project, name, definition, receipt, publication_guard):
    checked_text(name, "Group name", 128)
    documents = _documents(project)
    if len(documents) >= MAX_GROUPS:
        raise ValueError("Study already contains 256 immutable population groups")
    _definition_depth(definition, documents)
    group_id = uuid.uuid4().hex
    data = {
        "schema": GROUP_SCHEMA,
        "id": group_id,
        "name": name,
        "definition": definition,
        "receipt": receipt,
    }
    data["record_sha256"] = _hash(data)
    binding = {key: receipt[key] for key in BINDING_KEYS}

    def guard():
        if publication_guard is not None:
            publication_guard()
        current_documents = project.documents(DOCUMENT_KIND)
        if len(current_documents) >= MAX_GROUPS:
            raise ValueError("Study already contains 256 immutable population groups")
        current_by_id = {item["id"]: item for item in current_documents}
        for reference in definition.get("groups", []):
            current = current_by_id.get(reference["group_id"])
            if current is None or _record(current)["record_sha256"] != reference["record_sha256"]:
                raise ValueError("Population group dependency changed during publication")
        _assert_current(project, binding)

    return project.put_document(
        DOCUMENT_KIND, group_id, data, expected_revision=0, publication_guard=guard
    )


def dispatch_group(
    workbench_or_project: Any,
    operation: str,
    request: dict[str, Any],
    *,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Bounded operation entrypoint; document kinds/registry are wired by Workbench."""
    project = (
        workbench_or_project
        if isinstance(workbench_or_project, ResearchProject)
        else workbench_or_project.project
    )
    bound = {"result_id", "revision_hash"}
    if operation in {"population_gate_evaluate", "population_gate_export"}:
        keys = (
            {"gate", "include_centroids"}
            if operation == "population_gate_evaluate"
            else {"gate", "membership_sha256"}
        )
        exact_keys(request, bound | keys, operation)
        objects, metrics, binding = _context(project, request)
        receipt = _evaluate(objects, metrics, request.get("gate"), binding)
        _assert_current(project, binding)
        if operation == "population_gate_export":
            if request.get("membership_sha256") != receipt["membership_sha256"]:
                raise ValueError("Population membership changed before exact export")
            return {"json": canonical_json(receipt)}
        return _with_centroids(receipt, objects, request.get("include_centroids", False))
    if operation == "population_group_save":
        exact_keys(request, bound | {"name", "gate", "membership_sha256"}, operation)
        objects, metrics, binding = _context(project, request)
        receipt = _evaluate(objects, metrics, request.get("gate"), binding)
        if (
            _sha(request.get("membership_sha256"), "Expected group membership")
            != receipt["membership_sha256"]
        ):
            raise ValueError("Population membership changed; evaluate the exact gate again")
        return _save(
            project,
            request.get("name"),
            {"kind": "gate", "gate": receipt["gate"]},
            receipt,
            publication_guard,
        )
    documents = _documents(project)
    read = _reader(project, documents)
    if operation in {"population_group_get", "population_group_export"}:
        exact_keys(
            request,
            bound
            | {"group_id"}
            | ({"include_centroids"} if operation == "population_group_get" else set()),
            operation,
        )
        document, receipt, (objects, _, binding) = read(request.get("group_id"))
        for key in bound & set(request):
            if request[key] != binding[key]:
                raise ValueError("Population group belongs to another exact result revision")
        if operation == "population_group_export":
            return {"json": canonical_json(document)}
        return {
            "group": document,
            "membership": _with_centroids(
                receipt, objects, request.get("include_centroids", False)
            ),
        }
    if operation == "population_group_list":
        exact_keys(request, bound, operation)
        if "revision_hash" in request and "result_id" not in request:
            raise ValueError("A group revision filter requires its result identity")
        if "result_id" in request:
            checked_id(request["result_id"])
        if "revision_hash" in request:
            _sha(request["revision_hash"], "Group revision filter")
        if "result_id" in request:
            result = project.result(request["result_id"])
            if "revision_hash" in request and result["revision_hash"] != request["revision_hash"]:
                raise ValueError("Population group list requires the exact result revision")
        groups = []
        for document in documents.values():
            receipt = document["data"]["receipt"]
            if any(receipt[key] != request[key] for key in bound & set(request)):
                continue
            source_available = True
            try:
                document, receipt, _ = read(document["id"])
            except Exception as exc:
                if not _is_source_unavailable(exc):
                    raise
                source_available = False
            groups.append(
                {
                    "id": document["id"],
                    "name": document["data"]["name"],
                    "definition_kind": document["data"]["definition"]["kind"],
                    **{key: receipt[key] for key in BINDING_KEYS},
                    "included_count": receipt["included_count"],
                    "total_count": receipt["total_count"],
                    "membership_sha256": receipt["membership_sha256"],
                    "record_sha256": document["data"]["record_sha256"],
                    "source_available": source_available,
                }
            )
        return {"schema": "loci.population-group-list/v1", "groups": groups}
    if operation == "population_gate_apply":
        exact_keys(request, bound | {"group_id", "name"}, operation)
        group_id = checked_id(request.get("group_id"))
        document = documents.get(group_id)
        if document is None:
            raise ValueError("Population group is not part of this study")
        definition = document["data"]["definition"]
        if definition["kind"] != "gate":
            raise ValueError("Only a reusable gate definition can be applied to another result")
        try:
            read(group_id)
        except Exception as exc:
            if not _is_source_unavailable(exc):
                raise
        objects, metrics, binding = _context(project, request)
        receipt = _evaluate(objects, metrics, definition["gate"], binding)
        return _save(project, request.get("name"), definition, receipt, publication_guard)
    if operation == "population_group_combine":
        exact_keys(request, bound | {"name", "mode", "group_ids"}, operation)
        mode, group_ids = request.get("mode"), request.get("group_ids")
        if mode not in {"union", "intersection", "unclassified"}:
            raise ValueError("Population combination must be union, intersection or unclassified")
        if (
            not isinstance(group_ids, list)
            or len(group_ids) > MAX_GROUP_INPUTS
            or not group_ids
            and mode != "unclassified"
        ):
            raise ValueError("Population combination requires 1-32 fixed groups")
        for group_id in group_ids:
            checked_id(group_id)
        if len(group_ids) != len(set(group_ids)):
            raise ValueError("Population combination cannot repeat a fixed group")
        objects, _, binding = _context(project, request)
        references, operands = [], []
        for group_id in sorted(group_ids):
            document, operand, _ = read(group_id)
            if {key: operand[key] for key in BINDING_KEYS} != binding:
                raise ValueError("Population combination requires the same exact result revision")
            references.append(
                {
                    "group_id": group_id,
                    "record_sha256": document["data"]["record_sha256"],
                    "membership_sha256": operand["membership_sha256"],
                }
            )
            operands.append(operand)
        receipt = _combined(objects, binding, mode, operands)
        definition = {"kind": "combination", "mode": mode, "groups": references}
        return _save(project, request.get("name"), definition, receipt, publication_guard)
    raise ValueError("Unsupported population group operation")
