"""Bounded, exact-source sample CSV preview and atomic metadata publication.

Only derived sample documents are written. A preview is reproducible data rather
than authority: apply rebuilds it under the same SQLite write transaction that
publishes the sample envelopes, and independently verifies registered source bytes.
"""

from __future__ import annotations

import csv
import hashlib
import io
from collections.abc import Callable
from typing import Any

from .research_project import ResearchProject, canonical_json, checked_id, parse_json, timestamp
from .study_analysis import validate_sample_metadata

COLUMNS = ("source_id", "study", "sample", "condition", "biological_replicate", "plate", "well")
MAX_CSV_BYTES = 1024 * 1024
MAX_ROWS = 1000
TEMPLATE_SCHEMA = "loci.sample-sheet-template/v1"
PREVIEW_SCHEMA = "loci.sample-sheet-preview/v1"
APPLY_SCHEMA = "loci.sample-sheet-apply/v1"


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _snapshot(project: ResearchProject, connection) -> tuple[dict, dict, dict]:
    row = connection.execute("SELECT value FROM metadata WHERE key='project'").fetchone()
    if row is None:
        raise ValueError("Study project identity is missing")
    meta = parse_json(row[0])
    if meta.get("project_id") != project.meta["project_id"] or meta != project.meta:
        raise ValueError("Study project changed; reopen before importing a sample sheet")
    checked_id(meta["project_id"])
    source_rows = connection.execute(
        "SELECT id,record FROM sources ORDER BY id LIMIT ?", (MAX_ROWS + 1,)
    )
    sources = {}
    for index, (source_id, encoded) in enumerate(source_rows):
        if index == MAX_ROWS:
            raise ValueError("Sample sheets support at most 1,000 registered sources")
        checked_id(source_id)
        source = parse_json(encoded)
        if source.get("id") != source_id:
            raise ValueError("Stored source identity is invalid")
        sources[source_id] = {
            "source_id": source_id,
            "sha256": source["sha256"],
            "identity_kind": source.get("identity_kind"),
            "record_sha256": _hash(source),
        }
    samples = {}
    for source_id, revision, encoded in connection.execute(
        "SELECT id,revision,record FROM documents WHERE kind='sample' ORDER BY id"
    ):
        if source_id not in sources:
            continue
        envelope = parse_json(encoded)
        if (
            set(envelope) != {"id", "kind", "revision", "updated_at", "data"}
            or type(revision) is not int
            or revision < 1
            or envelope.get("id") != source_id
            or envelope.get("kind") != "sample"
            or type(envelope.get("revision")) is not int
            or envelope["revision"] != revision
        ):
            raise ValueError("Stored sample document identity is invalid")
        validate_sample_metadata(envelope.get("data"))
        samples[source_id] = envelope
    bindings = {
        "project": {"study_id": meta["project_id"], "metadata_sha256": _hash(meta)},
        "source_set": list(sources.values()),
        "samples": [
            {
                "source_id": source_id,
                "revision": samples[source_id]["revision"] if source_id in samples else 0,
                "data": samples[source_id]["data"] if source_id in samples else None,
                "document_sha256": _hash(samples.get(source_id)),
            }
            for source_id in sources
        ],
    }
    return meta, sources, {"documents": samples, "bindings": bindings}


def _csv_text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Sample sheet must be UTF-8 CSV text")
    try:
        size = len(value.encode("utf-8", errors="strict"))
    except UnicodeError:
        raise ValueError("Sample sheet must contain valid UTF-8 text") from None
    if size > MAX_CSV_BYTES:
        raise ValueError("Sample sheet exceeds the 1 MiB limit")
    return value


def _strict_csv(text: str) -> list[list[str]]:
    # csv.reader(strict=True) accepts a bare quote inside an unquoted field.
    # Refuse that malformed shape as well; quoted newlines and doubled quotes
    # remain valid. Do not normalize any literal field content.
    state = "start"
    for char in text:
        if state == "quoted":
            if char == '"':
                state = "closed"
        elif state == "closed":
            if char == '"':
                state = "quoted"
            elif char in ",\r\n":
                state = "start"
            else:
                raise ValueError("Malformed CSV quoting")
        elif char == '"':
            if state != "start":
                raise ValueError("Malformed CSV quoting")
            state = "quoted"
        elif char in ",\r\n":
            state = "start"
        else:
            state = "plain"
    if state == "quoted":
        raise ValueError("Malformed CSV quoting")
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        rows = []
        for row in reader:
            rows.append(row)
            if len(rows) > MAX_ROWS + 1:
                raise ValueError("Sample sheet exceeds the 1,000 data row limit")
    except csv.Error:
        raise ValueError("Malformed CSV text") from None
    return rows


def template(project: ResearchProject) -> dict[str, Any]:
    """Return literal current values in an editable exact-ID CSV template."""
    with project.connection() as connection:
        connection.execute("BEGIN")
        meta, sources, snapshot = _snapshot(project, connection)
        stream = io.StringIO(newline="")
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(COLUMNS)
        for source_id in sources:
            envelope = snapshot["documents"].get(source_id)
            data = envelope["data"] if envelope else {"study": meta["title"]}
            writer.writerow([source_id, *(data.get(field) for field in COLUMNS[1:])])
        csv_text = _csv_text(stream.getvalue())
    return {
        "schema": TEMPLATE_SCHEMA,
        "study_id": meta["project_id"],
        "columns": list(COLUMNS),
        "csv_text": csv_text,
        "source_count": len(sources),
    }


def _preview(project: ResearchProject, csv_text: str, connection) -> dict[str, Any]:
    meta, sources, snapshot = _snapshot(project, connection)
    errors: list[str] = []
    rows: list[dict[str, Any]] = []
    try:
        parsed = _strict_csv(csv_text)
    except ValueError as error:
        parsed = []
        errors.append(str(error))
    if not errors and (not parsed or parsed[0] != list(COLUMNS)):
        errors.append("CSV header must contain the exact sample-sheet columns in order")
    if not errors and len(parsed) == 1:
        errors.append("Sample sheet must contain at least one data row")
    if not errors:
        occurrences: dict[str, list[dict]] = {}
        for index, values in enumerate(parsed[1:], start=2):
            source_id = values[0] if values else ""
            issues: list[str] = []
            after = None
            match = "matched" if source_id in sources else "unmatched"
            if match == "unmatched":
                issues.append("Unknown source_id; IDs must match a registered source exactly")
            if len(values) != len(COLUMNS):
                issues.append("CSV row must contain exactly seven fields")
            else:
                data = dict(zip(COLUMNS[1:], values[1:], strict=True))
                for field in COLUMNS[4:]:
                    if data[field] == "":
                        data[field] = None
                try:
                    after = validate_sample_metadata(data).to_dict()
                    if after["study"] != meta["title"]:
                        issues.append("Sample study title must match the open study")
                except ValueError as error:
                    issues.append(str(error))
            before = snapshot["documents"].get(source_id)
            row = {
                "row_number": index,
                "source_id": source_id,
                "before": before["data"] if before else None,
                "after": after,
                "match": match,
                "issues": issues,
            }
            rows.append(row)
            occurrences.setdefault(source_id, []).append(row)
        for duplicates in occurrences.values():
            if len(duplicates) > 1:
                conflict = len({_hash(row["after"]) for row in duplicates}) > 1
                issue = "Conflicting duplicate source_id" if conflict else "Duplicate source_id"
                for row in duplicates:
                    row["issues"].append(issue)
    result = {
        "schema": PREVIEW_SCHEMA,
        "study_id": meta["project_id"],
        "csv_text": csv_text,
        "rows": rows,
        "errors": errors,
        "bindings": snapshot["bindings"],
        "can_apply": bool(rows) and not errors and not any(row["issues"] for row in rows),
    }
    return {**result, "preview_sha256": _hash(result)}


def preview(project: ResearchProject, csv_text: str) -> dict[str, Any]:
    """Inspect every row without changing sources or sample documents."""
    csv_text = _csv_text(csv_text)
    with project.connection() as connection:
        connection.execute("BEGIN")
        return _preview(project, csv_text, connection)


def apply(
    project: ResearchProject,
    preview: dict[str, Any],
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Publish the exact valid preview, or roll back every sample change."""
    if not isinstance(preview, dict) or set(preview) != {
        "schema",
        "study_id",
        "csv_text",
        "rows",
        "errors",
        "bindings",
        "can_apply",
        "preview_sha256",
    }:
        raise ValueError("Invalid sample-sheet preview shape")
    csv_text = _csv_text(preview["csv_text"])
    unsigned = {key: value for key, value in preview.items() if key != "preview_sha256"}
    if preview["schema"] != PREVIEW_SCHEMA or _hash(unsigned) != preview["preview_sha256"]:
        raise ValueError("Sample-sheet preview hash is invalid")
    if publication_guard is not None:
        publication_guard()
    documents = []
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = _preview(project, csv_text, connection)
        if canonical_json(current) != canonical_json(preview):
            raise ValueError("Sample-sheet preview is stale or changed; preview again")
        if not current["can_apply"]:
            raise ValueError("Sample-sheet validation failed; resolve every issue before apply")
        # BEGIN IMMEDIATE prevents source/metadata writers throughout verification
        # and publication. project.source uses the authoritative safe locator and
        # reader-specific fingerprint verifier; never construct paths from CSV.
        for row in current["rows"]:
            if publication_guard is not None:
                publication_guard()
            try:
                project.source(row["source_id"], verify=True, check=publication_guard)
            except (ValueError, OSError):
                raise ValueError("Registered source bytes are unavailable or changed") from None
        revisions = {
            binding["source_id"]: binding["revision"] for binding in current["bindings"]["samples"]
        }
        for row in current["rows"]:
            if publication_guard is not None:
                publication_guard()
            source_id = row["source_id"]
            revision = revisions[source_id] + 1
            envelope = {
                "id": source_id,
                "kind": "sample",
                "revision": revision,
                "updated_at": timestamp(),
                "data": row["after"],
            }
            connection.execute(
                "INSERT OR REPLACE INTO documents VALUES(?,?,?,?)",
                ("sample", source_id, revision, canonical_json(envelope)),
            )
            documents.append(envelope)
        # Check bytes again after staged writes so source edits during a long
        # multi-row publication also roll back the entire metadata transaction.
        for row in current["rows"]:
            if publication_guard is not None:
                publication_guard()
            try:
                project.source(row["source_id"], verify=True, check=publication_guard)
            except (ValueError, OSError):
                raise ValueError("Registered source bytes are unavailable or changed") from None
        if publication_guard is not None:
            publication_guard()
    return {
        "schema": APPLY_SCHEMA,
        "study_id": current["study_id"],
        "preview_sha256": current["preview_sha256"],
        "applied_count": len(documents),
        "documents": documents,
    }
