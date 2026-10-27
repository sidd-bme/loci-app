"""Bounded, path-free native identities for agent activity and approval recovery."""

from __future__ import annotations

import hashlib
from typing import Any

from .research_project import ID_PATTERN, SHA_PATTERN, canonical_json

MAX_TARGETS = 128
DOCUMENT_KEYS = {
    "workflow_id": "workflow",
    "group_id": "population_group",
    "report_id": "intensity_report",
    "comparison_id": "exploration",
}
SELECTION_KEYS = {"x", "y", "width", "height", "c", "z", "z_stop", "t", "level"}


def _id(value):
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


def _sha(value):
    return isinstance(value, str) and SHA_PATTERN.fullmatch(value) is not None


def collect_targets(project, payload: Any) -> list[dict[str, Any]]:
    """Resolve only explicit native identities. Never infer from prose or arbitrary id keys."""
    targets: list[dict[str, Any]] = []
    seen: set[str] = set()
    visits = 0
    visited_results: set[str] = set()
    visited_documents: set[tuple[str, str]] = set()

    def add(target):
        key = canonical_json(target)
        if key not in seen:
            if len(targets) >= MAX_TARGETS:
                raise ValueError("Agent target dependency bound exceeded")
            seen.add(key)
            targets.append(target)

    def source_target(source_id, selection=None):
        source = project.source(source_id)
        target = {"kind": "source", "id": source_id, "sha256": source["sha256"]}
        if (
            isinstance(selection, dict)
            and selection
            and set(selection) <= SELECTION_KEYS
            and all(type(v) is int and v >= 0 for v in selection.values())
        ):
            target["selection"] = dict(selection)
        add(target)

    def visit(value, depth=0):
        nonlocal visits
        visits += 1
        if visits > 4096 or depth > 12:
            raise ValueError("Agent target payload bound exceeded")
        if isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
            return
        if not isinstance(value, dict):
            return
        source_id = value.get("source_id")
        if _id(source_id):
            source_target(source_id, value.get("selection"))
        result_id = value.get("result_id")
        if _id(result_id):
            result = project.result(result_id)
            revision = value.get("revision_hash", result["revision_hash"])
            if not _sha(revision):
                raise ValueError("Invalid agent result revision")
            target = {
                "kind": "result",
                "id": result_id,
                "revision_hash": revision,
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
            }
            add(target)
            source_target(result["source_id"], result.get("provenance", {}).get("selection"))
            if result_id not in visited_results:
                visited_results.add(result_id)
                visit(result.get("provenance", {}), depth + 1)
                if _id(result.get("parent_id")):
                    visit({"result_id": result["parent_id"]}, depth + 1)
        for field, singular in (
            ("result_ids", "result_id"),
            ("source_ids", "source_id"),
            ("group_ids", "group_id"),
        ):
            if isinstance(value.get(field), list):
                for identity in value[field]:
                    visit({singular: identity}, depth + 1)
        for field in ("report_json", "receipt_json"):
            if isinstance(value.get(field), str):
                from .research_project import parse_json

                visit(parse_json(value[field]), depth + 1)
        run_id = value.get("run_id")
        if _id(run_id):
            docs = project.documents("workflow_run", document_id=run_id)
            if docs:
                add({"kind": "job", "id": run_id})
                visit(docs[0]["data"], depth + 1)
        job_id = value.get("job_id")
        if _id(job_id):
            try:
                job = project.job(job_id)
            except ValueError:
                job = None  # Portable result provenance can retain an unavailable original job.
            if job is not None:
                bound_source = job.get("request", {}).get("source_id")
                if _id(bound_source):
                    source_target(bound_source, job["request"].get("selection"))
                add({"kind": "job", "id": job_id})
        for key, kind in DOCUMENT_KEYS.items():
            document_id = value.get(key)
            if not _id(document_id):
                continue
            docs = project.documents(kind, document_id=document_id)
            revision_key = "workflow_revision" if kind == "workflow" else "expected_revision"
            revision = value.get(revision_key, value.get("expected_revision"))
            if docs:
                doc = docs[0]
                target = {
                    "kind": kind,
                    "id": document_id,
                    "revision": revision if type(revision) is int else doc["revision"],
                }
                if kind == "workflow":
                    digest = value.get("definition_sha256", doc["data"].get("definition_sha256"))
                    if _sha(digest):
                        target["sha256"] = digest
                else:
                    target["sha256"] = hashlib.sha256(
                        canonical_json(doc["data"]).encode()
                    ).hexdigest()
                add(target)
                if (kind, document_id) not in visited_documents:
                    visited_documents.add((kind, document_id))
                    visit(doc["data"], depth + 1)
            elif revision == 0:
                add({"kind": kind, "id": document_id, "revision": 0})
        # Only identity-bearing structured containers; ignore notes, names, arbitrary metadata.
        for key in (
            "request",
            "preview",
            "report",
            "receipt",
            "groups",
            "parent_result",
            "fixed_result",
            "moving_result",
            "temporal_inputs",
            "association_inputs",
            "compartment_measurement",
            "label_inputs",
            "definition",
            "recipe",
            "inputs",
            "members",
            "targets",
            "references",
            "bindings",
            "sources",
            "results",
            "frames",
            "label_binding",
            "intensity_bindings",
            "labels",
            "channels",
            "task_request",
            "workflow_context",
            "regions",
            "nucleus",
            "nuclei",
            "cells",
            "control",
            "fixed",
            "moving",
            "cell",
            "source_bindings",
            "result_bindings",
            "parent",
            "signal",
            "geometry_binding",
        ):
            item = value.get(key)
            if isinstance(item, dict) and key in {
                "references",
                "intensity_bindings",
                "label_inputs",
                "association_inputs",
            }:
                for nested in item.values():
                    visit(nested, depth + 1)
            elif isinstance(item, (dict, list)):
                visit(item, depth + 1)

    visit(payload)
    return targets


def targets_stale(project, targets, *, verify_sources=False) -> bool:
    if not isinstance(targets, list) or len(targets) > MAX_TARGETS:
        return True
    verified_sources = {}

    def source_sha(identity):
        if identity not in verified_sources:
            verified_sources[identity] = project.source(identity, verify=verify_sources)["sha256"]
        return verified_sources[identity]

    try:
        for target in targets:
            kind, identity = target["kind"], target["id"]
            if kind == "source":
                if source_sha(identity) != target["sha256"]:
                    return True
            elif kind == "result":
                record = project.result(identity)
                if record["revision_hash"] != target["revision_hash"]:
                    return True
                if source_sha(record["source_id"]) != target["source_sha256"]:
                    return True
            elif kind == "job":
                project.job(identity)
            elif kind in set(DOCUMENT_KEYS.values()):
                docs = project.documents(kind, document_id=identity)
                if not docs:
                    if target.get("revision") == 0:
                        continue
                    return True
                doc = docs[0]
                if doc["revision"] != target.get("revision"):
                    return True
                digest = (
                    doc["data"].get("definition_sha256")
                    if kind == "workflow"
                    else hashlib.sha256(canonical_json(doc["data"]).encode()).hexdigest()
                )
                if target.get("sha256") is not None and digest != target["sha256"]:
                    return True
            else:
                return True
    except (ValueError, OSError, KeyError, TypeError):
        return True
    return False


def response_targets(project, body):
    """Promote opaque ids only in native, typed response containers."""
    payload = dict(body)
    for key, field in (
        ("job", "job_id"),
        ("result", "result_id"),
        ("workflow", "workflow_id"),
        ("comparison", "comparison_id"),
        ("group", "group_id"),
    ):
        item = body.get(key)
        if not isinstance(item, dict) or not _id(item.get("id")):
            continue
        payload[field] = item["id"]
        if key == "result" and _sha(item.get("revision_hash")):
            payload["revision_hash"] = item["revision_hash"]
        if key == "workflow":
            payload["workflow_revision"] = item.get("revision")
            payload["definition_sha256"] = item.get("data", item).get("definition_sha256")
    output = collect_targets(project, payload)
    for key, field in (
        ("workflows", "workflow_id"),
        ("comparisons", "comparison_id"),
        ("groups", "group_id"),
        ("reports", "report_id"),
    ):
        for item in body.get(key, [])[:MAX_TARGETS] if isinstance(body.get(key), list) else []:
            if isinstance(item, dict) and _id(item.get("id")):
                output.extend(collect_targets(project, {field: item["id"]}))
    return list({canonical_json(target): target for target in output}.values())[:MAX_TARGETS]
