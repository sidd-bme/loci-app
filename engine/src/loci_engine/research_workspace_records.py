"""Durable reversible workspace visibility; scientific records stay immutable."""

from __future__ import annotations

from typing import Any

from .quantitative import exact_keys, integer
from .research_project import ResearchProject, checked_id

SCHEMA = "loci.workspace-visibility/v1"
MAX_BINDINGS = 10_000


def _ordered_source_bindings(
    data: dict[str, Any], sources: dict[str, dict[str, Any]]
) -> list[dict[str, str]]:
    """Return the saved source order with newly registered sources appended."""
    entries = data.get("source_order")
    if entries is None:
        return [{"id": item["id"], "sha256": item["sha256"]} for item in sources.values()]
    if not isinstance(entries, list) or len(entries) > MAX_BINDINGS:
        raise ValueError("Workspace source order exceeds its bounded record limit")
    ordered: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"id", "sha256"}:
            raise ValueError("Workspace source order requires exact scientific bindings")
        source_id = checked_id(entry["id"])
        if source_id in seen:
            raise ValueError("Workspace source order contains duplicate sources")
        source = sources.get(source_id)
        if source is None:
            raise ValueError("Workspace source order references a missing source")
        if source["sha256"] != entry["sha256"]:
            raise ValueError("Workspace source order has a stale scientific identity")
        seen.add(source_id)
        ordered.append({"id": source_id, "sha256": source["sha256"]})
    ordered.extend(
        {"id": source_id, "sha256": source["sha256"]}
        for source_id, source in sources.items()
        if source_id not in seen
    )
    return ordered


def ordered_sources(data: dict[str, Any], sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply durable workspace order without changing immutable source records."""
    sources_by_id = {item["id"]: item for item in sources}
    return [sources_by_id[item["id"]] for item in _ordered_source_bindings(data, sources_by_id)]


def validate_visibility(
    data: Any,
    sources: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not isinstance(data, dict) or set(data) not in (
        {"schema", "sources", "results"},
        {"schema", "sources", "results", "source_order"},
    ):
        raise ValueError("Workspace visibility record is invalid")
    if data["schema"] != SCHEMA:
        raise ValueError("Workspace visibility schema is unsupported")
    for kind, records, fingerprint in (
        ("sources", sources, "sha256"),
        ("results", results, "revision_hash"),
    ):
        entries = data[kind]
        if not isinstance(entries, dict) or len(entries) > MAX_BINDINGS:
            raise ValueError("Workspace visibility exceeds its bounded record limit")
        for record_id, digest in entries.items():
            record = records.get(checked_id(record_id))
            if record is None or record[fingerprint] != digest:
                raise ValueError("Workspace visibility has a stale scientific identity")
    _ordered_source_bindings(data, sources)
    return data


def read_visibility(project: ResearchProject) -> dict[str, Any]:
    documents = project.documents("workspace")
    if len(documents) > 1 or documents and documents[0]["id"] != project.meta["project_id"]:
        raise ValueError("Workspace visibility belongs to a different study")
    if not documents:
        return {"revision": 0, "data": {"schema": SCHEMA, "sources": {}, "results": {}}}
    document = documents[0]
    integer(document["revision"], "saved workspace revision", 1, 2**53 - 1)
    if document.get("kind") != "workspace":
        raise ValueError("Saved workspace envelope is invalid")
    validate_visibility(
        document["data"],
        {item["id"]: item for item in project.list_sources()},
        {item["id"]: item for item in project.list_results()},
    )
    return document


def update_visibility(project: ResearchProject, request: Any) -> dict[str, Any]:
    """Hide/restore exact source/result bindings with a compare-and-swap revision."""
    if not isinstance(request, dict):
        raise ValueError("Workspace visibility change must be an exact request")
    exact_keys(request, {"expected_revision", "sources", "results"}, "workspace visibility")
    if set(request) != {"expected_revision", "sources", "results"}:
        raise ValueError("Workspace visibility change requires all fields")
    revision = integer(request["expected_revision"], "workspace revision", 0, 2**53 - 1)
    previous = read_visibility(project)
    if previous["revision"] != revision:
        raise ValueError("Workspace changed; reload before closing images or clearing results")
    data = {
        "schema": SCHEMA,
        "sources": dict(previous["data"]["sources"]),
        "results": dict(previous["data"]["results"]),
        "source_order": _ordered_source_bindings(
            previous["data"], {item["id"]: item for item in project.list_sources()}
        ),
    }
    changed = 0
    for kind, fingerprint in (("sources", "sha256"), ("results", "revision_hash")):
        changes = request[kind]
        if not isinstance(changes, list) or len(changes) > MAX_BINDINGS:
            raise ValueError("Choose a bounded set of source or result bindings")
        seen: set[str] = set()
        for entry in changes:
            if not isinstance(entry, dict) or set(entry) != {"id", fingerprint, "visible"}:
                raise ValueError("Workspace change requires an exact scientific binding")
            record_id = checked_id(entry["id"])
            if record_id in seen or type(entry["visible"]) is not bool:
                raise ValueError("Workspace changes must be unique with explicit visibility")
            seen.add(record_id)
            record = project.source(record_id) if kind == "sources" else project.result(record_id)
            if record[fingerprint] != entry[fingerprint]:
                raise ValueError("Workspace change uses a stale scientific identity")
            if entry["visible"]:
                data[kind].pop(record_id, None)
            else:
                data[kind][record_id] = entry[fingerprint]
            changed += 1
    if not changed:
        raise ValueError("Choose at least one image or result to change")
    validate_visibility(
        data,
        {item["id"]: item for item in project.list_sources()},
        {item["id"]: item for item in project.list_results()},
    )
    return project.put_document(
        "workspace", project.meta["project_id"], data, expected_revision=revision
    )


def reorder_sources(project: ResearchProject, request: Any) -> dict[str, Any]:
    """Persist an exact visible-source order with compare-and-swap protection."""
    if not isinstance(request, dict):
        raise ValueError("Source order change must be an exact request")
    exact_keys(request, {"expected_revision", "sources"}, "source order")
    if set(request) != {"expected_revision", "sources"}:
        raise ValueError("Source order change requires all fields")
    revision = integer(request["expected_revision"], "workspace revision", 0, 2**53 - 1)
    previous = read_visibility(project)
    if previous["revision"] != revision:
        raise ValueError("Workspace changed; reload before reordering images")

    all_sources = project.list_sources()
    all_by_id = {item["id"]: item for item in all_sources}
    current = ordered_sources(previous["data"], all_sources)
    hidden = set(previous["data"]["sources"])
    visible = [item for item in current if item["id"] not in hidden]
    requested = request["sources"]
    if not isinstance(requested, list) or not 1 <= len(requested) <= MAX_BINDINGS:
        raise ValueError("Choose a bounded source order")
    requested_ids: list[str] = []
    seen: set[str] = set()
    for entry in requested:
        if not isinstance(entry, dict) or set(entry) != {"id", "sha256"}:
            raise ValueError("Source order requires exact scientific bindings")
        source_id = checked_id(entry["id"])
        if source_id in seen:
            raise ValueError("Source order must contain unique images")
        source = all_by_id.get(source_id)
        if source is None:
            raise ValueError("Source order references a missing image")
        if source["sha256"] != entry["sha256"]:
            raise ValueError("Source order uses a stale scientific identity")
        seen.add(source_id)
        requested_ids.append(source_id)
    if seen != {item["id"] for item in visible}:
        raise ValueError("Source order must include every current visible image exactly once")

    requested_iterator = iter(requested_ids)
    merged_ids = [
        item["id"] if item["id"] in hidden else next(requested_iterator) for item in current
    ]
    data = {
        "schema": SCHEMA,
        "sources": dict(previous["data"]["sources"]),
        "results": dict(previous["data"]["results"]),
        "source_order": [
            {"id": source_id, "sha256": all_by_id[source_id]["sha256"]} for source_id in merged_ids
        ],
    }
    validate_visibility(data, all_by_id, {item["id"]: item for item in project.list_results()})
    return project.put_document(
        "workspace", project.meta["project_id"], data, expected_revision=revision
    )
