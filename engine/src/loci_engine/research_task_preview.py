"""Bounded, non-adopted task previews shared by desktop, CLI and scoped agents.

This is a recoverable local display cache, not an analysis result or portable
study document. Eviction is explicit and never triggers recomputation.
"""

from __future__ import annotations

import hashlib
from typing import Any

from .research_operations import PREVIEW_OPERATIONS
from .research_project import canonical_json, checked_id, parse_json, timestamp

SCHEMA = "loci.task-preview/v1"
MAX_PREVIEW_BYTES = 8 * 1024**2
MAX_PREVIEWS = 8
PREFIX = "task-preview:"


def complete_preview(project, job_id: str, output: dict[str, Any], *, check=None):
    """Publish cache and terminal job state together, after the final guard."""
    job = project.job(checked_id(job_id))
    if job["operation"] not in PREVIEW_OPERATIONS or job["state"] != "running":
        raise ValueError("Only a running preview task can publish a preview")
    if not isinstance(output, dict) or output.get("adopted") is True or "result" in output:
        raise ValueError("A preview cannot claim an adopted result")
    source = project.source(job["request"]["source_id"], verify=True, check=check)
    payload = canonical_json(output)
    if len(payload.encode()) > MAX_PREVIEW_BYTES:
        raise ValueError("Preview exceeds the shared display cache limit")
    now = timestamp()
    record = {
        "schema": SCHEMA,
        "job_id": job_id,
        "operation": job["operation"],
        "request_sha256": job["request_hash"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "created_at": now,
        "adopted": False,
        "output_sha256": hashlib.sha256(payload.encode()).hexdigest(),
        "output": output,
    }
    encoded = canonical_json(record)
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if check is not None:
            check()
        row = connection.execute("SELECT record FROM jobs WHERE id=?", (job_id,)).fetchone()
        current = parse_json(row[0]) if row else None
        if not current or current["state"] != "running" or current["cancel_requested"]:
            raise ValueError("The preview was cancelled or interrupted before publication")
        if current["request_hash"] != record["request_sha256"]:
            raise ValueError("Preview task binding changed")
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)", (PREFIX + job_id, encoded)
        )
        current.update(state="succeeded", progress=1.0, finished_at=now, updated_at=now)
        connection.execute("UPDATE jobs SET record=? WHERE id=?", (canonical_json(current), job_id))
        cached = connection.execute(
            "SELECT key, value FROM metadata WHERE key LIKE 'task-preview:%'"
        ).fetchall()
        # Stable timestamp ordering; the just-published item wins equal-time ties.
        cached.sort(
            key=lambda row: (parse_json(row[1])["created_at"], row[0] == PREFIX + job_id, row[0]),
            reverse=True,
        )
        for key, _ in cached[MAX_PREVIEWS:]:
            connection.execute("DELETE FROM metadata WHERE key=?", (key,))
    return record


def get_preview(project, job_id: str, *, check=None) -> dict[str, Any]:
    job = project.job(checked_id(job_id))
    if job["operation"] not in PREVIEW_OPERATIONS or job["state"] != "succeeded":
        raise ValueError("This job has no completed preview")
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", (PREFIX + job_id,)
        ).fetchone()
    if row is None:
        raise ValueError("This preview is unavailable or was evicted; it has not been rerun")
    record = parse_json(row[0])
    source = project.source(job["request"]["source_id"], verify=True, check=check)
    payload = canonical_json(record.get("output"))
    if (
        record.get("schema") != SCHEMA
        or record.get("job_id") != job_id
        or record.get("operation") != job["operation"]
        or record.get("request_sha256") != job["request_hash"]
        or record.get("source_id") != source["id"]
        or record.get("source_sha256") != source["sha256"]
        or record.get("adopted") is not False
        or not isinstance(record.get("output"), dict)
        or len(payload.encode()) > MAX_PREVIEW_BYTES
        or hashlib.sha256(payload.encode()).hexdigest() != record.get("output_sha256")
    ):
        raise ValueError("Stored preview does not match the exact task and source")
    if check is not None:
        check()
    return {"preview": record}
