"""Revision-bound review receipts and append-only decision history.

Actor identity is declared by the local interface or named policy, not a claim
that Loci authenticated a natural person or the cloud model behind an MCP host.
Legacy five-field receipts remain unchanged and are never upgraded in place.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from .research_project import canonical_json, checked_id, checked_text

REVIEW_SCHEMA = "loci.result-review/v2"
LEGACY_KEYS = {"result_id", "revision_hash", "disposition", "reviewed_at", "actor"}
REVIEW_KEYS = LEGACY_KEYS | {
    "schema",
    "event_id",
    "actor_id",
    "identity_assurance",
    "authority",
    "reason",
    "coverage",
    "previous_review_sha256",
}
DISPOSITIONS = frozenset({"reviewed", "excluded", "pending"})
MAX_REVIEW_EVENTS = 10_000
_SHA = re.compile(r"[a-f0-9]{64}\Z")


def review_sha256(receipt: dict[str, Any] | None) -> str | None:
    return None if receipt is None else hashlib.sha256(canonical_json(receipt).encode()).hexdigest()


def validate_review(
    receipt: Any,
    *,
    result_id: str | None = None,
    revision_hash: str | None = None,
) -> dict[str, Any]:
    """Validate without changing historical bytes or asserting actor verification."""
    if not isinstance(receipt, dict) or set(receipt) not in (LEGACY_KEYS, REVIEW_KEYS):
        raise ValueError("Review receipt fields are invalid")
    checked_id(receipt["result_id"])
    if not isinstance(receipt["revision_hash"], str) or not _SHA.fullmatch(
        receipt["revision_hash"]
    ):
        raise ValueError("Review revision must be a SHA-256 digest")
    if (result_id is not None and receipt["result_id"] != result_id) or (
        revision_hash is not None and receipt["revision_hash"] != revision_hash
    ):
        raise ValueError("Review is stale or bound to a different result revision")
    if not isinstance(receipt["disposition"], str) or receipt["disposition"] not in DISPOSITIONS:
        raise ValueError("Review disposition must be reviewed, excluded or pending")
    checked_text(receipt["reviewed_at"], "Review time", 128)
    if set(receipt) == LEGACY_KEYS:
        if receipt["actor"] != "human":
            raise ValueError("Legacy review actor must retain its original human declaration")
        return receipt
    if (
        receipt["schema"] != REVIEW_SCHEMA
        or not isinstance(receipt["actor"], str)
        or receipt["actor"] not in {"human", "agent"}
    ):
        raise ValueError("Review schema or actor is invalid")
    checked_id(receipt["event_id"])
    checked_text(receipt["actor_id"], "Review actor identity", 256)
    if receipt["identity_assurance"] != "declared":
        raise ValueError("Review actor identity must be labelled declared")
    for name in ("reason", "coverage"):
        value = receipt[name]
        if not isinstance(value, str) or len(value) > 4096:
            raise ValueError(f"Review {name} must be text of at most 4096 characters")
        if value:
            checked_text(value, f"Review {name}", 4096)
        elif receipt["actor"] == "agent":
            raise ValueError(f"Agent review requires an explicit {name}")
    previous = receipt["previous_review_sha256"]
    if previous is not None and (not isinstance(previous, str) or not _SHA.fullmatch(previous)):
        raise ValueError("Previous review identity is invalid")
    authority = receipt["authority"]
    if receipt["actor"] == "human":
        if authority is not None:
            raise ValueError("Human review cannot carry agent delegation")
    else:
        if not isinstance(authority, dict) or set(authority) != {
            "kind",
            "policy_sha256",
            "delegation_id",
            "client_id",
        }:
            raise ValueError("Agent review requires an exact policy delegation receipt")
        if authority["kind"] != "policy-delegation":
            raise ValueError("Agent review authority is invalid")
        checked_id(authority["delegation_id"])
        if authority["client_id"] != receipt["actor_id"]:
            raise ValueError("Review actor disagrees with the delegated client")
        if not isinstance(authority["policy_sha256"], str) or not _SHA.fullmatch(
            authority["policy_sha256"]
        ):
            raise ValueError("Review policy identity is invalid")
    return receipt


def event_key(receipt: dict[str, Any]) -> str:
    identity = receipt.get("event_id") or "legacy-" + str(review_sha256(receipt))
    return f"review-event:{receipt['result_id']}:{identity}"


def validate_review_history(
    history: Any,
    current: dict[str, Any] | None,
    *,
    result_id: str,
    revision_hash: str,
) -> list[dict[str, Any]]:
    if not isinstance(history, list) or len(history) > MAX_REVIEW_EVENTS:
        raise ValueError("Review history exceeds its event bound")
    previous = None
    seen: set[str] = set()
    for index, receipt in enumerate(history):
        validate_review(receipt, result_id=result_id, revision_hash=revision_hash)
        key = event_key(receipt)
        if key in seen:
            raise ValueError("Review history contains a duplicate event")
        seen.add(key)
        if receipt.get("schema") == REVIEW_SCHEMA:
            if receipt["previous_review_sha256"] != review_sha256(previous):
                raise ValueError("Review history has a missing or changed predecessor")
        elif index:
            raise ValueError("A legacy review can only start a review history")
        previous = receipt
    if previous != current:
        raise ValueError("Current review disagrees with its decision history")
    return history


def history_document(project: Any, receipt: dict[str, Any], *, check: Any = None) -> dict[str, Any]:
    events = project.review_history(receipt["result_id"], check=check)
    validate_review_history(
        events,
        receipt,
        result_id=receipt["result_id"],
        revision_hash=receipt["revision_hash"],
    )
    return {
        "schema": "loci.review-history/v1",
        "result_id": receipt["result_id"],
        "revision_hash": receipt["revision_hash"],
        "events": events,
        "current_sha256": review_sha256(receipt),
    }


def validate_history_document(document: Any, receipt: dict[str, Any]) -> None:
    if (
        not isinstance(document, dict)
        or set(document) != {"schema", "result_id", "revision_hash", "events", "current_sha256"}
        or document["schema"] != "loci.review-history/v1"
        or document["result_id"] != receipt["result_id"]
        or document["revision_hash"] != receipt["revision_hash"]
        or document["current_sha256"] != review_sha256(receipt)
    ):
        raise ValueError("Exported review history binding is invalid")
    validate_review_history(
        document["events"],
        receipt,
        result_id=receipt["result_id"],
        revision_hash=receipt["revision_hash"],
    )
