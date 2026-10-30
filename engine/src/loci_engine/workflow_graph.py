"""Bounded typed composition of code-owned native operations, without execution.

V2 is separate from the unchanged linear workflow/v1 contract. Planning verifies
exact study bindings and metadata but never decodes arrays, runs algorithms,
creates records, grants authority, or adopts a result. Callers must authorize
all resolved native requests and bind completed outputs to their actual jobs.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

import numpy as np

from .profiles import DEFAULT_PROFILE_ID
from .quantitative import (
    MAX_WORKING_BYTES,
    apply_marker_gates,
    exact_keys,
    finite_number,
    integer,
    validate_processing_steps,
)
from .research_action_registry import REQUESTS
from .research_project import SHA_PATTERN, canonical_json, checked_id, checked_text

SCHEMA = "loci.workflow/v2"
PLAN_SCHEMA = "loci.workflow-plan/v2"
MAX_NODES = 32
MAX_REFERENCES = 64
MAX_DEFINITION_BYTES = 1024**2
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
SELECTION_KEYS = {"x", "y", "width", "height", "t", "c", "z", "level"}
# An adapter describes typed ports, never user-selected functions or JSON paths.
ADAPTERS = {
    "run_recipe": {"source": "source-selection"},
    "classical_run": {"source": "source-selection"},
    "associate_results": {"cells": "label-result", "nuclei": "label-result"},
    "morphometrics_run": {"objects": "label-result"},
    "spatial_distance_run": {
        "objects": "label-result",
        "compartment": "label-result",
        "boundary": "label-result",
    },
}
ADAPTER_VERSIONS = dict.fromkeys(ADAPTERS, 1)
_BINDING = {"result_id": "0" * 32, "revision_hash": "0" * 64}


def _exact(value, keys, name):
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"{name} requires every declared field")
    return value


def _name(value, name):
    if not isinstance(value, str) or NAME.fullmatch(value) is None:
        raise ValueError(f"{name} must be a bounded identifier")
    return value


def _sha(value, name):
    if not isinstance(value, str) or SHA_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{name} requires an exact SHA-256")
    return value


def _json(value, depth=0):
    """Reject non-JSON/nonfinite/cyclic/deep inputs before canonical serialization."""
    if depth > 16:
        raise ValueError("Workflow JSON exceeds the nesting bound")
    if value is None or type(value) in (str, bool):
        return
    if type(value) in (int, float):
        if abs(value) > 1e30 or not math.isfinite(value):
            raise ValueError("Workflow JSON requires bounded finite numbers")
    elif type(value) is list:
        if len(value) > 4096:
            raise ValueError("Workflow JSON exceeds the item bound")
        for item in value:
            _json(item, depth + 1)
    elif type(value) is dict:
        if len(value) > 128 or any(type(key) is not str for key in value):
            raise ValueError("Workflow JSON requires bounded string-keyed objects")
        for item in value.values():
            _json(item, depth + 1)
    else:
        raise ValueError("Workflow values must be ordinary JSON")


def _copy(value):
    return json.loads(canonical_json(value))


def _schema(value, schema):
    """Check the native registry's structural schema; exact validators add semantics."""
    for alternatives in ("anyOf", "oneOf"):
        if alternatives in schema:
            matches = 0
            for candidate in schema[alternatives]:
                try:
                    _schema(value, candidate)
                except ValueError:
                    continue
                matches += 1
            if not matches or (alternatives == "oneOf" and matches != 1):
                raise ValueError("Workflow setting must match its native request schema")
            return
    if "const" in schema and value != schema["const"]:
        raise ValueError("Workflow setting disagrees with its native constant")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("Workflow setting is not a supported native value")
    kind = schema.get("type")
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool}
    if kind in types and type(value) is not types[kind]:
        raise ValueError(f"Workflow setting must be {kind}")
    if kind == "null" and value is not None:
        raise ValueError("Workflow setting must be null")
    if kind in {"number", "integer"}:
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("Workflow setting must be a finite number")
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise ValueError("Workflow setting exceeds native bounds")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            raise ValueError("Workflow setting exceeds native bounds")
    if kind == "string":
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 2048):
            raise ValueError("Workflow setting exceeds native text bounds")
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            raise ValueError("Workflow setting has an invalid native identity")
    if kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 4096):
            raise ValueError("Workflow setting exceeds native item bounds")
        if schema.get("uniqueItems") and len({canonical_json(item) for item in value}) != len(
            value
        ):
            raise ValueError("Workflow settings must be unique")
        for item in value:
            _schema(item, schema.get("items", {}))
    if kind == "object":
        if not set(schema.get("required", [])) <= set(value):
            raise ValueError("Workflow settings omit required native fields")
        if len(value) > schema.get("maxProperties", 128):
            raise ValueError("Workflow settings exceed native field bounds")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                _schema(item, properties[key])
            elif schema.get("additionalProperties") is False:
                raise ValueError("Workflow settings contain an unknown native field")


def _settings(operation, settings, budget):
    """Validate settings without source pixels or synthetic segmentation probes."""
    if operation == "run_recipe":
        _exact(settings, {"recipe"}, "recipe adapter settings")
        recipe = settings["recipe"]
        _schema(recipe, REQUESTS[operation]["properties"]["recipe"])
        if not isinstance(recipe.get("segmentation"), dict):
            raise ValueError("Workflow recipe must produce a label-result through segmentation")
        recipe = _copy(recipe)
        recipe.setdefault("working_bytes", budget)
        integer(recipe["working_bytes"], "working_bytes", 1024, budget)
        validate_processing_steps(recipe.get("steps", []))
        # Match segment_scalar's settings boundary without running segmentation.
        segment = recipe["segmentation"]
        finite_number(segment.get("min_size", 0), "min_size", 0, 1e20)
        if segment.get("method", "components") == "watershed":
            finite_number(segment.get("split_height", 1), "split_height", 1e-9, 1e9)
        apply_marker_gates([], recipe.get("gates", []))
        if recipe.get("input_transform") == "rgb_intensity" and (
            recipe.get("measurement_channels") or recipe.get("gates")
        ):
            raise ValueError("RGB components cannot be biological channels or marker gates")
        if recipe.get("references"):
            raise ValueError("Workflow recipes do not bind reference sources")
        return {"recipe": recipe}
    fields = set(REQUESTS[operation]["properties"]) - {
        "source_id",
        "selection",
        "result_id",
        "revision_hash",
        *ADAPTERS[operation],
    }
    exact_keys(settings, fields, "native adapter settings")
    settings = _copy(settings)
    settings.setdefault("working_bytes", budget)
    integer(settings["working_bytes"], "working_bytes", 1024**2, budget)
    properties = REQUESTS[operation]["properties"]
    required = set(REQUESTS[operation]["required"]) & fields
    _schema(
        settings,
        {
            "type": "object",
            "additionalProperties": False,
            "properties": {key: properties[key] for key in fields},
            "required": list(required),
        },
    )
    if operation == "classical_run":
        from .working_result import _settings_from_record

        _settings_from_record(
            {"kind": "SegmentationSettings", "values": settings["settings"]},
            backend_kind="classical",
        )
        if settings["profile_id"] != DEFAULT_PROFILE_ID:
            raise ValueError("Workflow supports only the built-in classical profile")
        channels = settings["measurement_channels"]
        if len(set(channels)) != len(channels):
            raise ValueError("Measurement channels must be distinct")
    elif operation == "associate_results":
        roles = settings["roles"]
        for role in ("nuclei", "cells"):
            roles[role] = checked_text(roles[role], f"{role} role", 512)
        if roles["nuclei"] == roles["cells"]:
            raise ValueError("Association roles must be distinct")
        settings["control"] = checked_text(settings["control"], "Association control", 2048)
        if "measurement_channels" in settings:
            channels = settings["measurement_channels"]
            if not 1 <= len(channels) <= 32 or len(set(channels)) != len(channels):
                raise ValueError("Association requires 1-32 distinct measurement channels")
            for channel in channels:
                integer(channel, "measurement channel", 0, 255)
    elif operation == "morphometrics_run":
        from .research_morphometrics import validate_settings

        validate_settings({**settings, **_BINDING})
    else:
        from .research_spatial import validate_settings

        validate_settings({**settings, **_BINDING, "compartment": _BINDING, "boundary": _BINDING})
    return settings


def validate_definition(definition: Any) -> dict[str, Any]:
    """Return a detached canonical definition, hash and deterministic topological order."""
    _json(definition)
    if len(canonical_json(definition).encode()) > MAX_DEFINITION_BYTES:
        raise ValueError("Workflow definition exceeds its byte bound")
    _exact(
        definition, {"schema", "name", "inputs", "nodes", "outputs", "working_bytes"}, "workflow"
    )
    if definition["schema"] != SCHEMA:
        raise ValueError("Unsupported workflow graph schema")
    budget = integer(definition["working_bytes"], "working_bytes", 1024**2, MAX_WORKING_BYTES)
    name = checked_text(definition["name"], "Workflow name")
    inputs, nodes, outputs = definition["inputs"], definition["nodes"], definition["outputs"]
    if not isinstance(inputs, dict) or not inputs or len(inputs) > MAX_REFERENCES:
        raise ValueError("Workflow requires bounded declared inputs")
    for key, kind in inputs.items():
        _name(key, "Input name")
        if not isinstance(kind, str) or kind not in {"source-selection", "label-result"}:
            raise ValueError("Unknown workflow input type")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= MAX_NODES:
        raise ValueError("Workflow requires 1-32 bounded nodes")
    if not isinstance(outputs, dict) or not outputs or len(outputs) > MAX_REFERENCES:
        raise ValueError("Workflow requires bounded named outputs")
    by_id = {}
    for node in nodes:
        _exact(node, {"id", "operation", "contract_version", "inputs", "settings"}, "workflow node")
        identity = _name(node["id"], "Node ID")
        if identity in by_id:
            raise ValueError("Duplicate workflow node ID")
        operation = node["operation"]
        if not isinstance(operation, str) or operation not in ADAPTERS:
            raise ValueError("Unsupported code-owned workflow operation")
        if type(node["contract_version"]) is not int or node["contract_version"] != 1:
            raise ValueError("Unsupported workflow adapter contract version")
        _exact(node["inputs"], set(ADAPTERS[operation]), "typed input ports")
        by_id[identity] = {**node, "settings": _settings(operation, node["settings"], budget)}
    dependencies = {key: set() for key in by_id}
    used = set()
    references = len(outputs)

    def reference(ref, expected, owner=None):
        if not isinstance(ref, dict):
            raise ValueError("Workflow reference must be a typed exact binding")
        if set(ref) == {"input"}:
            key = ref["input"]
            if not isinstance(key, str) or key not in inputs or inputs[key] != expected:
                raise ValueError("Unknown workflow input or incompatible port type")
            used.add(key)
        else:
            _exact(ref, {"node", "port"}, "node result reference")
            key = ref["node"]
            if not isinstance(key, str) or key not in by_id or ref["port"] != "result":
                raise ValueError("Unknown workflow node or result port")
            if expected != "label-result":
                raise ValueError("Incompatible workflow port type")
            if owner is not None:
                dependencies[owner].add(key)

    for identity, node in by_id.items():
        references += len(node["inputs"])
        for port, ref in node["inputs"].items():
            reference(ref, ADAPTERS[node["operation"]][port], identity)
    for key, ref in outputs.items():
        _name(key, "Output name")
        reference(ref, "label-result")
        if "node" not in ref:
            raise ValueError("Workflow outputs must name a node result port")
    if references > MAX_REFERENCES:
        raise ValueError("Workflow exceeds 64 references")
    if used != set(inputs):
        raise ValueError("Workflow has unused declared inputs")
    pending, ordered = set(by_id), []
    while pending:
        ready = sorted(key for key in pending if not dependencies[key] & pending)
        if not ready:
            raise ValueError("Workflow contains a cycle")
        ordered.extend(ready)
        pending.difference_update(ready)
    reachable = {ref["node"] for ref in outputs.values()}
    for identity in reversed(ordered):
        if identity in reachable:
            reachable.update(dependencies[identity])
    if reachable != set(by_id):
        raise ValueError("Workflow contains unreachable nodes")
    normalized = _copy(
        {
            "schema": SCHEMA,
            "name": name,
            "inputs": inputs,
            "nodes": [by_id[key] for key in ordered],
            "outputs": outputs,
            "working_bytes": budget,
        }
    )
    return {"definition": normalized, "definition_sha256": _hash(normalized), "node_order": ordered}


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def definition_hash(definition: Any) -> str:
    return validate_definition(definition)["definition_sha256"]


def _selection(workbench, source_id, selection):
    exact_keys(selection, SELECTION_KEYS | {"z_stop"}, "source selection")
    if not set(selection) >= SELECTION_KEYS:
        raise ValueError("Workflow source selection must be fully explicit")
    resolved = workbench.selection(source_id, selection)
    if canonical_json(resolved) != canonical_json(selection):
        raise ValueError("Workflow selection changed during resolution")
    return resolved


def _result(workbench, binding, budget):
    from .research_quantification import _artifact_decoded_bytes
    from .workbench import geometry_from_dict

    _exact(binding, {"result_id", "revision_hash"}, "result binding")
    identity = checked_id(binding["result_id"])
    revision = _sha(binding["revision_hash"], "Result revision")
    record = workbench.project.result(identity)
    if record["revision_hash"] != revision:
        raise ValueError("Workflow result revision is stale")
    arrays = record.get("arrays", {})
    if record.get("schema") != "loci.research-result/v1" or not {"image", "labels"} <= set(arrays):
        raise ValueError("Workflow label-result requires bounded image and label artifacts")
    if sum(_artifact_decoded_bytes(item) for item in arrays.values()) * 2 > budget:
        raise ValueError("Workflow result exceeds working-memory budget before decode")
    labels, image = arrays["labels"], arrays["image"]
    if np.dtype(labels["dtype"]).kind not in "ui" or labels["shape"] != image["shape"]:
        raise ValueError("Workflow label-result requires integer labels on the image grid")
    geometry = geometry_from_dict(record["provenance"]["geometry"])
    if len(labels["shape"]) != len(geometry.axes):
        raise ValueError("Workflow label-result geometry and shape disagree")
    source = workbench.project.source(record["source_id"], verify=True)
    if source["sha256"] != record["source_sha256"]:
        raise ValueError("Workflow result source fingerprint is stale")
    _selection(workbench, source["id"], record["provenance"].get("selection"))
    return record


def validate_bindings(workbench, definition, bindings) -> dict[str, Any]:
    """Verify exact project/source/revision scope; this grants no execution authority."""
    definition = validate_definition(definition)["definition"]
    _json(bindings)
    _exact(bindings, set(definition["inputs"]), "workflow input bindings")
    normalized = {}
    for name, kind in definition["inputs"].items():
        binding = bindings[name]
        if kind == "source-selection":
            _exact(binding, {"source_id", "source_sha256", "selection"}, "source binding")
            source = workbench.project.source(checked_id(binding["source_id"]), verify=True)
            if source["sha256"] != _sha(binding["source_sha256"], "Source fingerprint"):
                raise ValueError("Workflow source fingerprint is stale")
            normalized[name] = {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "selection": _selection(workbench, source["id"], binding["selection"]),
            }
        else:
            record = _result(workbench, binding, definition["working_bytes"])
            normalized[name] = {"result_id": record["id"], "revision_hash": record["revision_hash"]}
    normalized = _copy(normalized)
    _lineage_scopes(workbench, definition, normalized)
    return normalized


def _geometry(workbench, source_id, selection):
    from .quantitative import Geometry
    from .workbench import geometry_from_dict

    source = workbench.project.source(source_id)
    if source.get("source_kind") == "medical":
        geometry = geometry_from_dict(source["metadata"]["geometry"])
        if "z_stop" in selection and geometry.axes != "ZYX":
            raise ValueError("Medical volume selection requires declared ZYX geometry")
        starts = tuple(selection[key] for key in ("z", "y", "x")[-len(geometry.axes) :])
        geometry = geometry.cropped(starts)
        if "z_stop" not in selection:
            geometry = Geometry("YX", geometry.affine, geometry.unit, geometry.frame)
        return geometry
    return workbench._native_geometry(
        workbench._session(source_id), selection, "z_stop" in selection
    )


def _same_grid(first, second):
    a, b = first["provenance"], second["provenance"]
    if (
        (first["source_id"], first["source_sha256"])
        != (second["source_id"], second["source_sha256"])
        or canonical_json(a["geometry"]) != canonical_json(b["geometry"])
        or canonical_json({k: v for k, v in a["selection"].items() if k != "c"})
        != canonical_json({k: v for k, v in b["selection"].items() if k != "c"})
        or first["arrays"]["labels"]["shape"] != second["arrays"]["labels"]["shape"]
    ):
        raise ValueError("Workflow join requires the same exact source, selection and grid")


def _record_scope(record):
    return {
        "source_id": record["source_id"],
        "source_sha256": record["source_sha256"],
        "selection": {k: v for k, v in record["provenance"]["selection"].items() if k != "c"},
        "geometry": record["provenance"]["geometry"],
        "shape": record["arrays"]["labels"]["shape"],
    }


def _lineage_scopes(workbench, definition, bindings):
    """Every adapter preserves the exact source grid; reject incompatible joins early."""
    external = {}
    for name, binding in bindings.items():
        if definition["inputs"][name] == "label-result":
            external[name] = _record_scope(_result(workbench, binding, definition["working_bytes"]))
        else:
            selection = binding["selection"]
            shape = [selection["height"], selection["width"]]
            if "z_stop" in selection:
                shape.insert(0, selection["z_stop"] - selection["z"])
            external[name] = {
                "source_id": binding["source_id"],
                "source_sha256": binding["source_sha256"],
                "selection": {k: v for k, v in selection.items() if k != "c"},
                "geometry": _geometry(workbench, binding["source_id"], selection).to_dict(),
                "shape": shape,
            }
    external = _copy(external)
    scopes = {}
    for node in definition["nodes"]:
        parents = [
            external[ref["input"]] if "input" in ref else scopes[ref["node"]]
            for ref in node["inputs"].values()
        ]
        if any(parent != parents[0] for parent in parents[1:]):
            raise ValueError("Workflow join requires the same exact source, selection and grid")
        scopes[node["id"]] = parents[0]
    return scopes


def _request(workbench, node, inputs, budget):
    operation, settings = node["operation"], _copy(node["settings"])
    if operation in {"run_recipe", "classical_run"}:
        bound = inputs["source"]
        source_id, selection = bound["source_id"], bound["selection"]
        request = {"source_id": source_id, "selection": selection, **settings}
        geometry = _geometry(workbench, source_id, selection)
        voxels = (
            selection["width"]
            * selection["height"]
            * (selection.get("z_stop", selection["z"] + 1) - selection["z"])
        )
        if operation == "run_recipe":
            recipe = request["recipe"]
            rgb = recipe.get("input_transform") == "rgb_intensity"
            source = workbench.project.source(source_id)
            if rgb:
                if source.get("source_kind") not in {"native", "whole_slide"}:
                    raise ValueError("RGB conversion requires a verified native RGB source")
                session = workbench._session(source_id)
                if session.metadata.dimensions.s not in {3, 4} or "z_stop" in selection:
                    raise ValueError("RGB conversion requires one verified interleaved RGB plane")
            elif (
                source.get("source_kind") in {"native", "whole_slide", "ome_zarr"}
                and workbench._session(source_id).metadata.dimensions.s > 1
            ):
                raise ValueError("RGB source requires an explicit supported intensity transform")
            validate_processing_steps(recipe.get("steps", []), geometry=geometry)
            geometry.orthogonal_spacing()
            channels = recipe.get("measurement_channels", [] if rgb else [selection["c"]])
            if not rgb and not channels:
                raise ValueError("Scalar recipe requires measurement channels")
            for channel in channels:
                workbench.selection(source_id, {**selection, "c": channel})
            estimated = voxels * (96 + 8 * len(channels) + (32 if rgb else 0))
            limit = recipe["working_bytes"]
        else:
            if "z_stop" in selection:
                raise ValueError("Classical adapter requires one fully resolved 2D plane")
            channels = settings["measurement_channels"]
            for channel in channels:
                workbench.selection(source_id, {**selection, "c": channel})
            source = workbench.project.source(source_id)
            rgb = source.get("source_kind") in {
                "native",
                "whole_slide",
                "ome_zarr",
            } and workbench._session(source_id).metadata.dimensions.s in {3, 4}
            if rgb and (selection["c"] != 0 or channels):
                raise ValueError("RGB samples cannot be measured as biological channels")
            # Conservative input allowance, matching the native aggregate guard.
            estimated = voxels * (192 + 8 * len(channels))
            limit = settings["working_bytes"]
        if estimated > min(limit, budget):
            raise ValueError("Workflow node exceeds working-memory budget before decode")
    elif operation == "associate_results":
        request = {**inputs, **settings}
        records = [_result(workbench, inputs[role], budget) for role in ("cells", "nuclei")]
        _same_grid(*records)
        if (
            records[0]["id"] == records[1]["id"]
            or records[0]["arrays"]["labels"]["sha256"] == records[1]["arrays"]["labels"]["sha256"]
        ):
            raise ValueError("Association requires distinct cell and nucleus label artifacts")
        from .research_quantification import _artifact_decoded_bytes

        decoded = sum(_artifact_decoded_bytes(a) for r in records for a in r["arrays"].values())
        voxels = math.prod(records[0]["arrays"]["labels"]["shape"])
        metadata = sum(len(canonical_json(r["provenance"]).encode()) for r in records) * 16
        if decoded * 2 + voxels * 192 + metadata > settings["working_bytes"]:
            raise ValueError("Workflow association exceeds aggregate working-memory budget")
        for channel in settings.get("measurement_channels", []):
            workbench.selection(
                records[0]["source_id"], {**records[0]["provenance"]["selection"], "c": channel}
            )
    elif operation == "morphometrics_run":
        from .research_morphometrics import validate_request

        request = {**inputs["objects"], **settings}
        validate_request(workbench, request)
    else:
        from .research_spatial import validate_request

        request = {
            **inputs["objects"],
            "compartment": inputs["compartment"],
            "boundary": inputs["boundary"],
            **settings,
        }
        validate_request(workbench, request)
    return {"operation": operation, "request": _copy(request)}


def resolve_node(workbench, definition, bindings, completed_outputs, node_id) -> dict[str, Any]:
    """Resolve a ready native request, rechecking every external and completed binding.

    completed_outputs is node ID -> exact {result_id, revision_hash}; it is never
    an instruction to select a latest result or an arbitrary response JSON path.
    The run owner additionally verifies that each binding was produced by its
    retained exact node request/job before passing it here.
    """
    definition = validate_definition(definition)["definition"]
    bindings = validate_bindings(workbench, definition, bindings)
    by_id = {node["id"]: node for node in definition["nodes"]}
    if not isinstance(node_id, str) or node_id not in by_id:
        raise ValueError("Choose an existing workflow node")
    exact_keys(completed_outputs, set(by_id), "completed node outputs")
    if node_id in completed_outputs:
        raise ValueError("Workflow node already has a completed output")
    _json(completed_outputs)
    scopes = _lineage_scopes(workbench, definition, bindings)
    for identity, binding in completed_outputs.items():
        if any(
            "node" in ref and ref["node"] not in completed_outputs
            for ref in by_id[identity]["inputs"].values()
        ):
            raise ValueError("Completed workflow output has missing completed dependencies")
        record = _result(workbench, binding, definition["working_bytes"])
        if _record_scope(record) != scopes[identity]:
            raise ValueError("Completed workflow output has a different source, selection or grid")
    node = by_id[node_id]
    inputs = {}
    for port, ref in node["inputs"].items():
        if "input" in ref:
            inputs[port] = bindings[ref["input"]]
        elif ref["node"] in completed_outputs:
            inputs[port] = completed_outputs[ref["node"]]
        else:
            raise ValueError("Workflow node dependencies are not completed")
    return _request(workbench, node, inputs, definition["working_bytes"])


def build_plan(workbench, definition, bindings) -> dict[str, Any]:
    """Create a detached immutable-identity plan; no run/checkpoint is persisted."""
    from .workbench import runtime_record

    validated = validate_definition(definition)
    definition = validated["definition"]
    bindings = validate_bindings(workbench, definition, bindings)
    # Validate every currently resolvable request. Internal joins are checked
    # once exact completed bindings exist, never by pretending placeholder masks.
    for node in definition["nodes"]:
        if all("input" in ref for ref in node["inputs"].values()):
            resolve_node(workbench, definition, bindings, {}, node["id"])
    payload = {
        "schema": PLAN_SCHEMA,
        "definition": definition,
        "definition_sha256": validated["definition_sha256"],
        "bindings": bindings,
        "bindings_sha256": _hash(bindings),
        "node_order": validated["node_order"],
        "adapter_versions": {
            node["operation"]: ADAPTER_VERSIONS[node["operation"]] for node in definition["nodes"]
        },
        "node_scopes": _lineage_scopes(workbench, definition, bindings),
        "runtime": runtime_record(),
    }
    if any(node["operation"] == "morphometrics_run" for node in definition["nodes"]):
        from .research_morphometrics import _software

        payload["method_identities"] = {"morphometrics_run": _software()}
    return _copy({**payload, "plan_sha256": _hash(payload)})
