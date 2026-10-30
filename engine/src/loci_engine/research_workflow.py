"""Saved typed linear workflows over the established quantitative recipe engine.

V1 has no arbitrary code, branching, intermediate adoption or checkpoint cache.
The final result and durable job publish atomically; a missing run receipt can be
reconstructed from that exact result without executing the analysis again.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np

from .quantitative import (
    DEFAULT_WORKING_BYTES,
    MAX_WORKING_BYTES,
    Geometry,
    apply_marker_gates,
    exact_keys,
    finite_number,
    integer,
    segment_scalar,
    validate_processing_steps,
)
from .research_population import _objects, intensity_metric_id, query_population
from .research_project import SHA_PATTERN, canonical_json, checked_id, checked_text, timestamp

NODE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
MAX_WORKFLOWS = 1024
BINDING_KEYS = {
    "workflow_id",
    "workflow_revision",
    "definition_sha256",
    "source_id",
    "source_sha256",
    "selection",
}
TYPES = {"source", "process", "segment", "measure", "population", "review", "export"}


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _sha(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError(f"{name} requires an exact SHA-256")
    return value


def _filters(settings: dict[str, Any]) -> list[dict[str, Any]]:
    exact_keys(settings, {"filters"}, "workflow population")
    filters = settings.get("filters", [])
    if not isinstance(filters, list) or len(filters) > 8:
        raise ValueError("Choose at most eight workflow population filters")
    normalized = []
    for item in filters:
        exact_keys(item, {"metric", "min", "max", "unit"}, "workflow population filter")
        entry = {
            "metric": checked_text(item.get("metric"), "Population metric", 1024),
            "unit": checked_text(item.get("unit"), "Population unit", 128),
        }
        if not ({"min", "max"} & item.keys()):
            raise ValueError("Population filter requires a finite bound")
        for field in ("min", "max"):
            if field in item:
                entry[field] = finite_number(item[field], f"filter {field}", -1e30, 1e30)
        if "min" in entry and "max" in entry and entry["min"] > entry["max"]:
            raise ValueError("Population filter minimum exceeds maximum")
        normalized.append(entry)
    return sorted(normalized, key=canonical_json)


def validate_definition(definition: Any) -> dict[str, Any]:
    exact_keys(definition, {"schema", "name", "nodes", "edges", "working_bytes"}, "workflow")
    if definition.get("schema") != "loci.workflow/v1":
        raise ValueError("Unsupported workflow schema")
    name = checked_text(definition.get("name"), "Workflow name")
    nodes, edges = definition.get("nodes"), definition.get("edges")
    if not isinstance(nodes, list) or not 5 <= len(nodes) <= 38:
        raise ValueError("A workflow requires 5-38 bounded nodes")
    if not isinstance(edges, list) or len(edges) != len(nodes) - 1:
        raise ValueError("A workflow requires one connected linear path")
    by_id = {}
    for node in nodes:
        exact_keys(node, {"id", "type", "settings"}, "workflow node")
        node_id, kind = node.get("id"), node.get("type")
        if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id) or node_id in by_id:
            raise ValueError("Workflow node IDs must be valid and unique")
        if (
            not isinstance(kind, str)
            or kind not in TYPES
            or not isinstance(node.get("settings"), dict)
        ):
            raise ValueError("Choose a supported typed workflow node")
        by_id[node_id] = node
    incoming, outgoing = {}, {}
    for edge in edges:
        exact_keys(edge, {"from", "to"}, "workflow edge")
        start, end = edge.get("from"), edge.get("to")
        if not isinstance(start, str) or not isinstance(end, str):
            raise ValueError("Workflow edges require node IDs")
        if start not in by_id or end not in by_id or start == end:
            raise ValueError("Workflow edge references an invalid node")
        if start in outgoing or end in incoming:
            raise ValueError("Workflow branching and duplicate edges are unsupported")
        outgoing[start], incoming[end] = end, start
    starts = [key for key in by_id if key not in incoming]
    if len(starts) != 1:
        raise ValueError("Workflow contains cycles or disconnected nodes")
    ordered, current = [], starts[0]
    while current is not None:
        if current in ordered:
            raise ValueError("Workflow contains a cycle")
        ordered.append(current)
        current = outgoing.get(current)
    if len(ordered) != len(nodes):
        raise ValueError("Workflow contains orphaned nodes or a cycle")
    kinds = [by_id[key]["type"] for key in ordered]
    process_count = kinds.count("process")
    expected = ["source"] + ["process"] * process_count + ["segment", "measure"]
    if "population" in kinds:
        expected.append("population")
    expected += ["review", "export"]
    if process_count > 32 or kinds != expected:
        raise ValueError("Incompatible workflow connection types or node ordering")
    recipe = {
        "steps": [],
        "segmentation": None,
        "measurement_channels": [],
        "gates": [],
        "working_bytes": integer(
            definition.get("working_bytes", DEFAULT_WORKING_BYTES),
            "working_bytes",
            1024,
            MAX_WORKING_BYTES,
        ),
    }
    normalized_nodes = []
    probe = np.ones((3, 3), dtype=np.float64)
    geometry = Geometry.diagonal((1.0, 1.0))
    for key in ordered:
        node = by_id[key]
        kind, settings = node["type"], node["settings"]
        if kind == "source":
            exact_keys(settings, {"input_transform"}, "workflow source")
            if settings:
                if settings.get("input_transform") != "rgb_intensity":
                    raise ValueError("Unsupported workflow input transform")
                recipe["input_transform"] = "rgb_intensity"
        elif kind == "process":
            if settings.get("op") == "flatfield":
                raise ValueError("V1 workflows do not bind reference-image processing")
            validate_processing_steps([settings])
            recipe["steps"].append(settings)
        elif kind == "segment":
            segment_scalar(probe, geometry, settings)
            recipe["segmentation"] = settings
        elif kind == "measure":
            exact_keys(settings, {"measurement_channels", "gates"}, "workflow measure")
            channels = settings.get("measurement_channels", [])
            if not isinstance(channels, list) or len(channels) > 32:
                raise ValueError("Workflow requires bounded measurement channels")
            for channel in channels:
                integer(channel, "measurement channel", 0, 2**31 - 1)
            if len(set(channels)) != len(channels):
                raise ValueError("Workflow measurement channels must be unique")
            if not channels and recipe.get("input_transform") != "rgb_intensity":
                raise ValueError("Workflow requires at least one measurement channel")
            if channels and recipe.get("input_transform") == "rgb_intensity":
                raise ValueError("RGB components are not biological measurement channels")
            gates = settings.get("gates", [])
            apply_marker_gates([], gates)
            recipe.update(measurement_channels=channels, gates=gates)
            settings = {"measurement_channels": channels, "gates": gates}
        elif kind == "population":
            settings = {"filters": _filters(settings)}
        else:
            exact_keys(settings, set(), f"workflow {kind}")
        normalized_nodes.append({"id": key, "type": kind, "settings": settings})
    normalized = json.loads(
        canonical_json(
            {
                "schema": "loci.workflow/v1",
                "name": name,
                "nodes": normalized_nodes,
                "edges": [
                    {"from": left, "to": right}
                    for left, right in zip(ordered, ordered[1:], strict=False)
                ],
                "working_bytes": recipe["working_bytes"],
            }
        )
    )
    return {
        "definition": normalized,
        "definition_sha256": _hash(normalized),
        "recipe": json.loads(canonical_json(recipe)),
        "node_order": ordered,
    }


def _get(workbench, workflow_id):
    workflow_id = checked_id(workflow_id)
    doc = next(
        (doc for doc in workbench.project.documents("workflow") if doc["id"] == workflow_id), None
    )
    if doc is None:
        raise ValueError("Choose an existing saved workflow")
    validated = validate_definition(doc["data"].get("definition"))
    if validated["definition_sha256"] != doc["data"].get("definition_sha256"):
        raise ValueError("Stored workflow definition identity is invalid")
    return doc, validated


def _population_settings(definition):
    return next(
        (node["settings"] for node in definition["nodes"] if node["type"] == "population"), None
    )


def _validate_units(filters, metrics):
    units = {metric["id"]: metric["unit"] for metric in metrics}
    for item in filters:
        if item["metric"] not in units or units[item["metric"]] != item["unit"]:
            raise ValueError("Workflow population metric or unit is incompatible with measurements")


def preflight(workbench, request):
    exact_keys(request, BINDING_KEYS, "workflow binding")
    doc, validated = _get(workbench, request.get("workflow_id"))
    revision = integer(request.get("workflow_revision"), "workflow revision", 1, 2**31 - 1)
    if (
        revision != doc["revision"]
        or _sha(request.get("definition_sha256"), "Workflow") != validated["definition_sha256"]
    ):
        raise ValueError("Saved workflow changed; reload before execution")
    source_id = checked_id(request.get("source_id"))
    source = workbench.project.source(source_id, verify=True)
    if _sha(request.get("source_sha256"), "Workflow source") != source["sha256"]:
        raise ValueError("Workflow source identity changed")
    normalized = workbench.validate_recipe(
        {
            "source_id": source_id,
            "selection": request.get("selection"),
            "recipe": validated["recipe"],
        }
    )
    selection = normalized["selection"]
    volume = "z_stop" in selection
    if source.get("source_kind") == "medical":
        unit = source["metadata"]["geometry"]["unit"]
    else:
        unit = workbench._native_geometry(workbench._session(source_id), selection, volume).unit
    metrics = [
        {
            "id": "measure",
            "label": "Volume" if volume else "Area",
            "unit": f"{unit}^{3 if volume else 2}",
        },
        {
            "id": "voxel_count",
            "label": "Voxel count" if volume else "Pixel count",
            "unit": "voxel" if volume else "pixel",
        },
        {"id": "nearest_centroid_distance", "label": "Nearest centroid distance", "unit": unit},
    ]
    declarations = workbench.channel_metadata(source_id)["channels"]
    channels = [
        f"{index + 1}: {declarations[index]['name']}"
        for index in normalized["recipe"]["measurement_channels"]
    ]
    if normalized["recipe"].get("input_transform") == "rgb_intensity":
        channels.append("RGB-DERIVED:rgb_intensity")
    for channel in channels:
        for stat in ("mean", "sum", "min", "max", "std_population"):
            metrics.append(
                {
                    "id": intensity_metric_id(channel, stat),
                    "label": f"{channel} · {stat.replace('_', ' ')}",
                    "unit": f"source-intensity*{'voxel' if volume else 'pixel'}"
                    if stat == "sum"
                    else "source-intensity",
                }
            )
    for gate in normalized["recipe"]["gates"]:
        if gate["channel"] not in channels:
            raise ValueError("Workflow gate references an unavailable measurement channel")
    population = _population_settings(validated["definition"])
    if population is not None:
        _validate_units(population["filters"], metrics)
    return {
        **normalized,
        "source_sha256": source["sha256"],
        "workflow": {
            "id": doc["id"],
            "revision": doc["revision"],
            "definition_sha256": validated["definition_sha256"],
        },
        "definition": validated["definition"],
        "metrics": metrics,
    }


def _population(rows, definition, binding, *, _legacy_summary=False):
    population = _population_settings(definition)
    if population is None:
        return None
    filters = population["filters"]
    request = {
        "filters": [
            {key: value for key, value in item.items() if key != "unit"} for item in filters
        ]
    }
    # For empty results validate units against preflight; the explorer has no
    # observed descriptors, so only an unfiltered empty query is meaningful.
    if not rows:
        result = query_population(rows, {}, binding, _legacy_summary=_legacy_summary)
        result["query"]["filters"] = request["filters"]
        result["membership_sha256"] = _hash(
            {**binding, "filters": request["filters"], "labels": []}
        )
        result["query_sha256"] = _hash(
            {**binding, "query": result["query"], "membership_sha256": result["membership_sha256"]}
        )
        return result
    result = query_population(rows, request, binding, _legacy_summary=_legacy_summary)
    _validate_units(filters, result["metrics"])
    return result


def validate_result_population(provenance):
    """Validate filters before atomic result/job publication, never edit rows."""
    context = provenance["workflow"]
    _population(provenance["measurements"], context["definition"], {})


def workflow_export_data(result):
    """Full filter membership and raw measurement rows for atomic bundle staging."""
    provenance = result["provenance"]
    context = provenance.get("workflow")
    if context is None:
        return None
    validated = validate_definition(context["definition"])
    if (
        validated["definition_sha256"] != context["definition_sha256"]
        or validated["recipe"] != provenance["recipe"]
        or _hash(provenance["recipe"]) != context["recipe_sha256"]
        or provenance["selection"] != context["selection"]
        or result["source_id"] != context["source_id"]
        or result["source_sha256"] != context["source_sha256"]
    ):
        raise ValueError("Workflow export execution binding is invalid")
    rows = provenance["measurements"]
    binding = {key: result[key] for key in ("source_id", "source_sha256", "revision_hash")}
    binding["result_id"] = result["id"]
    population = _population(rows, context["definition"], binding)
    if population is None:
        selected = rows
    else:
        objects, _ = _objects(rows)
        filters = population["query"]["filters"]
        labels = {
            obj["label"]
            for obj in objects
            if all(
                obj["values"][item["metric"]] is not None
                and ("min" not in item or obj["values"][item["metric"]] >= item["min"])
                and ("max" not in item or obj["values"][item["metric"]] <= item["max"])
                for item in filters
            )
        }
        selected = [row for row in rows if row["label"] in labels]
        if len(selected) != population["filtered_count"]:
            raise ValueError("Workflow selected measurement membership disagrees with receipt")
    receipt = {
        "schema": "loci.workflow-export/v1",
        "workflow": context,
        "job_id": provenance.get("job_id"),
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "population": population,
        "scope": {
            "labels": "full-segmentation",
            "objects_csv": "full-object-table",
            "selected_measurements_csv": "population-filter-members"
            if population is not None
            else "full-object-table",
        },
        "selected_labels": sorted(row["label"] for row in selected),
    }
    return receipt, selected


def validate_workflow_document(document, sources, results, documents=()):
    """Validate portable workflow records against exact source/result snapshots."""
    kind, data = document.get("kind"), document.get("data")
    checked_id(document.get("id"))
    integer(document.get("revision"), "workflow document revision", 1, 2**31 - 1)
    if kind == "workflow":
        exact_keys(data, {"definition", "definition_sha256"}, "saved workflow")
        validated = validate_definition(data.get("definition"))
        if validated["definition"] != data["definition"] or validated[
            "definition_sha256"
        ] != data.get("definition_sha256"):
            raise ValueError("Stored workflow definition identity is invalid")
        return
    sources_by_id = sources if isinstance(sources, dict) else {item["id"]: item for item in sources}
    results_by_id = results if isinstance(results, dict) else {item["id"]: item for item in results}
    if kind == "workflow_run":
        keys = {
            "schema",
            "workflow_id",
            "workflow_revision",
            "definition_sha256",
            "definition",
            "source_id",
            "source_sha256",
            "selection",
            "recipe_sha256",
            "job_id",
            "result_id",
            "revision_hash",
            "population",
            "created_at",
        }
        exact_keys(data, keys, "workflow run receipt")
        if set(data) != keys or data["schema"] != "loci.workflow-run/v1":
            raise ValueError("Invalid workflow run receipt schema")
        checked_id(data["workflow_id"])
        integer(data["workflow_revision"], "workflow revision", 1, 2**31 - 1)
        if data["job_id"] != document["id"]:
            raise ValueError("Workflow run and job identities differ")
        result = results_by_id.get(data["result_id"])
        source = sources_by_id.get(data["source_id"])
        if result is None or source is None or source["sha256"] != data["source_sha256"]:
            raise ValueError("Workflow run source or result binding is invalid")
        if (
            result["source_id"] != data["source_id"]
            or result["source_sha256"] != data["source_sha256"]
            or result["revision_hash"] != data["revision_hash"]
        ):
            raise ValueError("Workflow run does not match the exact result")
        context = {
            key: data[key]
            for key in (
                "workflow_id",
                "workflow_revision",
                "definition_sha256",
                "definition",
                "source_id",
                "source_sha256",
                "selection",
                "recipe_sha256",
            )
        }
        provenance = result["provenance"]
        if (
            provenance.get("workflow") != context
            or provenance.get("job_id") != data["job_id"]
            or provenance["selection"] != data["selection"]
            or provenance["recipe_sha256"] != data["recipe_sha256"]
            or result["created_at"] != data["created_at"]
        ):
            raise ValueError("Workflow run result publication binding is invalid")
        validated = validate_definition(data["definition"])
        if (
            validated["definition_sha256"] != data["definition_sha256"]
            or validated["recipe"] != provenance["recipe"]
            or _hash(provenance["recipe"]) != data["recipe_sha256"]
        ):
            raise ValueError("Historical workflow or recipe identity is invalid")
        binding = {
            key: data[key] for key in ("result_id", "revision_hash", "source_id", "source_sha256")
        }
        replay = _population(provenance["measurements"], data["definition"], binding)
        if replay != data["population"]:
            # Preserve historical receipts with the original subnormal summary
            # arithmetic. The complete original replay must match; no fields
            # are repaired, ignored or written back to the saved record.
            try:
                legacy = _population(
                    provenance["measurements"], data["definition"], binding, _legacy_summary=True
                )
            except OverflowError as exc:
                raise ValueError("Workflow population receipt does not replay exactly") from exc
            if legacy != data["population"]:
                raise ValueError("Workflow population receipt does not replay exactly")
        return
    if kind == "workflow_export":
        exact_keys(data, {"run_id", "receipt", "verified_at"}, "workflow export receipt")
        checked_id(data.get("run_id"))
        checked_text(data.get("verified_at"), "Export verification time")
        receipt = data.get("receipt")
        exact_keys(
            receipt,
            {"export_name", "manifest_sha256", "files", "result_id", "revision_hash"},
            "workflow export manifest receipt",
        )
        name = checked_text(receipt.get("export_name"), "Export name")
        if Path(name).name != name or name in {".", ".."}:
            raise ValueError("Workflow export name must be a basename")
        _sha(receipt.get("manifest_sha256"), "Export manifest")
        result = results_by_id.get(receipt.get("result_id"))
        if result is None or result["revision_hash"] != receipt.get("revision_hash"):
            raise ValueError("Workflow export result binding is invalid")
        files = receipt.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= 128:
            raise ValueError("Workflow export file receipt exceeds its bound")
        seen = set()
        for item in files:
            exact_keys(item, {"name", "sha256", "size_bytes"}, "exported workflow file")
            filename = checked_text(item.get("name"), "Exported filename")
            if Path(filename).name != filename or filename in {".", ".."} or filename in seen:
                raise ValueError("Workflow export file names must be unique basenames")
            seen.add(filename)
            _sha(item.get("sha256"), "Exported file")
            integer(item.get("size_bytes"), "Exported file size", 0, 2**63 - 1)
        if documents:
            run = next(
                (
                    doc
                    for doc in documents
                    if doc["kind"] == "workflow_run" and doc["id"] == data["run_id"]
                ),
                None,
            )
            if run is None or any(
                run["data"][key] != receipt[key] for key in ("result_id", "revision_hash")
            ):
                raise ValueError("Workflow export references an unavailable run")
        return
    raise ValueError("Unsupported workflow document kind")


def _recover_run(workbench, run_id):
    run_id = checked_id(run_id)
    existing = next(
        (doc for doc in workbench.project.documents("workflow_run") if doc["id"] == run_id), None
    )
    if existing is not None:
        source = workbench.project.source(existing["data"]["source_id"], verify=True)
        result = workbench.project.result(existing["data"]["result_id"])
        validate_workflow_document(existing, [source], [result])
        return existing
    job = workbench.project.job(run_id)
    if (
        job["operation"] != "workflow_run"
        or job["state"] != "succeeded"
        or len(job["result_ids"]) != 1
    ):
        raise ValueError("Workflow run has no atomically published result")
    result = workbench.project.result(job["result_ids"][0])
    context = result["provenance"].get("workflow")
    if not isinstance(context, dict) or context != job["request"].get("workflow_context"):
        raise ValueError("Workflow result publication binding is invalid")
    if (
        result["provenance"].get("job_id") != run_id
        or result["source_id"] != context["source_id"]
        or result["source_sha256"] != context["source_sha256"]
    ):
        raise ValueError("Workflow result does not match the exact durable job")
    if (
        result["provenance"]["selection"] != context["selection"]
        or result["provenance"]["recipe_sha256"] != context["recipe_sha256"]
    ):
        raise ValueError("Workflow result recipe or selection binding is invalid")
    validated = validate_definition(context["definition"])
    if validated["definition_sha256"] != context["definition_sha256"]:
        raise ValueError("Historical workflow identity is invalid")
    source = workbench.project.source(context["source_id"], verify=True)
    if source["sha256"] != context["source_sha256"]:
        raise ValueError("Workflow result source identity changed")
    binding = {key: result[key] for key in ("source_id", "source_sha256", "revision_hash")}
    binding["result_id"] = result["id"]
    record = {
        "schema": "loci.workflow-run/v1",
        **context,
        "job_id": run_id,
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "population": _population(
            result["provenance"]["measurements"], context["definition"], binding
        ),
        "created_at": result["created_at"],
    }
    try:
        return workbench.project.put_document("workflow_run", run_id, record, expected_revision=0)
    except ValueError:
        existing = next(
            (doc for doc in workbench.project.documents("workflow_run") if doc["id"] == run_id),
            None,
        )
        if existing is None or existing["data"] != record:
            raise
        return existing


def export_run(workbench, request):
    """Native destination-picker route only; no arbitrary-path agent operation."""
    exact_keys(request, {"run_id", "result_id", "revision_hash", "destination"}, "workflow export")
    run = _recover_run(workbench, request.get("run_id"))
    record = run["data"]
    if (
        request.get("result_id") != record["result_id"]
        or request.get("revision_hash") != record["revision_hash"]
    ):
        raise ValueError("Workflow export requires its exact published result")
    from .research_export import export_research_result

    receipt = export_research_result(
        workbench.project, record["result_id"], record["revision_hash"], request["destination"]
    )
    target = Path(request["destination"]).parent / receipt["export_name"]
    return record_verified_export(workbench, run, receipt, target)


def record_verified_export(workbench, run, receipt, target):
    """Verify the published native bundle before recording a path-free workflow receipt."""
    record = run["data"]
    if (
        receipt.get("result_id") != record["result_id"]
        or receipt.get("revision_hash") != record["revision_hash"]
    ):
        raise ValueError("Workflow export requires its exact published result")
    manifest = target / "manifest.json"
    if (
        manifest.is_symlink()
        or _sha(receipt["manifest_sha256"], "Export manifest")
        != hashlib.sha256(manifest.read_bytes()).hexdigest()
    ):
        raise ValueError("Published workflow export manifest could not be verified")
    manifest_record = json.loads(manifest.read_text())
    if (
        manifest_record.get("result_id") != record["result_id"]
        or manifest_record.get("revision_hash") != record["revision_hash"]
        or manifest_record.get("files") != receipt["files"]
    ):
        raise ValueError("Published workflow export receipt does not match its manifest")
    for item in receipt["files"]:
        path = target / item["name"]
        if Path(item["name"]).name != item["name"] or path.is_symlink():
            raise ValueError("Published workflow export contains an invalid file")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if path.stat().st_size != item["size_bytes"] or digest.hexdigest() != item["sha256"]:
            raise ValueError("Published workflow export file integrity check failed")
    # Store the verified path-free receipt, never an inferred success.
    export_id = uuid4().hex
    workbench.project.put_document(
        "workflow_export",
        export_id,
        {
            "run_id": run["id"],
            "receipt": receipt,
            "verified_at": timestamp(),
        },
        expected_revision=0,
    )
    return {**receipt, "workflow_run_id": run["id"]}


def execute_workflow(workbench, operation, request, *, job_id=None, publication_guard=None):
    if operation == "workflow_validate":
        exact_keys(request, {"definition"}, operation)
        return validate_definition(request.get("definition"))
    if operation == "workflow_save":
        exact_keys(request, {"workflow_id", "expected_revision", "definition"}, operation)
        validated = validate_definition(request.get("definition"))
        workflows = workbench.project.documents("workflow")
        if len(workflows) >= MAX_WORKFLOWS and not any(
            doc["id"] == request.get("workflow_id") for doc in workflows
        ):
            raise ValueError("Study exceeds 1024 saved workflows")
        return {
            "workflow": workbench.project.put_document(
                "workflow",
                checked_id(request.get("workflow_id")),
                {key: validated[key] for key in ("definition", "definition_sha256")},
                expected_revision=request.get("expected_revision"),
            )
        }
    if operation == "workflow_list":
        exact_keys(request, set(), operation)
        workflows = workbench.project.documents("workflow")
        if len(workflows) > MAX_WORKFLOWS:
            raise ValueError("Study exceeds the saved workflow listing bound")
        linear = []
        for doc in workflows:
            if doc["data"].get("schema") == "loci.saved-workflow/v2":
                # The two editors share a document collection. Validate a
                # composed definition through its own contract, then keep it
                # out of the v1 editor instead of interpreting it as v1.
                from .research_workflow_graph import _get as get_graph

                get_graph(workbench, doc["id"])
                continue
            _get(workbench, doc["id"])
            linear.append(doc)
        return {"workflows": linear}
    if operation == "workflow_get":
        exact_keys(request, {"workflow_id"}, operation)
        return {"workflow": _get(workbench, request.get("workflow_id"))[0]}
    if operation == "workflow_status":
        exact_keys(request, {"run_id"}, operation)
        run = _recover_run(workbench, request.get("run_id"))
        record = run["data"]
        doc, _ = _get(workbench, record["workflow_id"])
        review = workbench.project.review_state(record["result_id"])
        exports = [
            doc
            for doc in workbench.project.documents("workflow_export")
            if doc["data"]["run_id"] == run["id"]
        ]
        disposition = review["disposition"] if review else "pending"
        state = "waiting_review" if disposition == "pending" else disposition
        if state == "reviewed" and exports:
            state = "exported"
        return {
            "run": run,
            "workflow_outdated": doc["revision"] != record["workflow_revision"],
            "state": state,
            "review": review,
            "exports": exports[-100:],
            "export_count": len(exports),
        }
    if operation == "workflow_preflight":
        return preflight(workbench, request)
    if operation == "workflow_preview":
        exact_keys(request, BINDING_KEYS | {"target_node_id"}, operation)
        resolved = preflight(
            workbench, {key: value for key, value in request.items() if key != "target_node_id"}
        )
        definition = resolved["definition"]
        node_ids = [node["id"] for node in definition["nodes"]]
        if request.get("target_node_id") not in node_ids:
            raise ValueError("Choose a workflow preview node")
        target_index = node_ids.index(request["target_node_id"])
        prefix = definition["nodes"][: target_index + 1]
        if prefix[-1]["type"] in {"review", "export"}:
            raise ValueError("Human review and export nodes cannot execute a preview")
        recipe = {
            **resolved["recipe"],
            "steps": [node["settings"] for node in prefix if node["type"] == "process"],
        }
        if not any(node["type"] == "segment" for node in prefix):
            recipe["segmentation"] = None
            recipe["gates"] = []
        output = workbench.run_recipe(
            {
                "source_id": resolved["source_id"],
                "selection": resolved["selection"],
                "recipe": recipe,
            },
            preview=True,
            exploration_details=any(node["type"] == "segment" for node in prefix),
            workflow_context=workflow_context(resolved)
            if prefix[-1]["type"] == "population"
            else None,
        )
        population = None
        if prefix[-1]["type"] == "population":
            # Full measurement rows are in the preview provenance only internally;
            # use the full pure pipeline on this bounded crop, not a truncated page.
            population = output.pop("workflow_population", None)
        return {
            **output,
            "workflow": resolved["workflow"],
            "target_node_id": request["target_node_id"],
            "population": population,
        }
    if operation == "workflow_run":
        if job_id is None:
            raise ValueError("Submit a durable workflow task before execution")
        resolved = preflight(workbench, request)
        context = workbench.project.job(job_id)["request"].get("workflow_context")
        if context != workflow_context(resolved):
            raise ValueError("Workflow job binding changed before execution")
        output = workbench.run_recipe(
            {
                "source_id": resolved["source_id"],
                "selection": resolved["selection"],
                "recipe": resolved["recipe"],
            },
            job_id=job_id,
            publication_guard=publication_guard,
            workflow_context=context,
        )
        return {**output, "run": _recover_run(workbench, job_id)}
    raise ValueError("Unknown workflow operation")


def workflow_context(resolved):
    return {
        "workflow_id": resolved["workflow"]["id"],
        "workflow_revision": resolved["workflow"]["revision"],
        "definition_sha256": resolved["workflow"]["definition_sha256"],
        **{
            key: resolved[key]
            for key in ("definition", "source_id", "source_sha256", "selection", "recipe_sha256")
        },
    }
