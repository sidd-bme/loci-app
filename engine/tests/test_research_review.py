import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_review import REVIEW_SCHEMA, review_sha256, validate_review


@pytest.fixture
def reviewed_study(tmp_path):
    import hashlib

    source_path = tmp_path / "source.tif"
    source_path.write_bytes(b"immutable review fixture")
    project = ResearchProject.create(tmp_path / "review.loci-study", "Review events")
    source = project.register_source(
        source_path,
        hashlib.sha256(source_path.read_bytes()).hexdigest(),
        {"axes": "YX", "dtype": "uint16"},
    )
    result = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        parent_id=None,
        arrays={"labels": np.ones((3, 5), dtype=np.uint32)},
        provenance={"method": "fixture"},
    )
    return project, result


def decide(project, result, disposition="reviewed", **kwargs):
    return project.review(result["id"], result["revision_hash"], disposition, **kwargs)


def agent_kwargs():
    return {
        "actor": "agent",
        "actor_id": "research-assistant",
        "authority": {
            "kind": "policy-delegation",
            "policy_sha256": "a" * 64,
            "delegation_id": "b" * 32,
            "client_id": "research-assistant",
        },
        "reason": "Inspected boundaries against the granted raw-channel view.",
        "coverage": "The selected plane and its five labelled objects.",
        "expected_review_sha256": None,
    }


def test_decisions_append_and_reopen_without_erasing_earlier_review(reviewed_study):
    project, result = reviewed_study
    first = decide(project, result, **agent_kwargs())
    second = decide(project, result, "excluded", reason="Boundary crosses an artefact.")
    third = decide(project, result, "pending")
    assert first["schema"] == REVIEW_SCHEMA
    assert first["actor"] == "agent" and first["identity_assurance"] == "declared"
    assert second["actor"] == "human" and second["authority"] is None
    assert second["previous_review_sha256"] == review_sha256(first)
    reopened = ResearchProject(project.root)
    assert reopened.review_history(result["id"]) == [first, second, third]
    assert reopened.review_state(result["id"]) == third


def test_legacy_receipt_is_preserved_exactly_on_first_new_decision(reviewed_study):
    project, result = reviewed_study
    legacy = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "actor": "human",
        "disposition": "reviewed",
        "reviewed_at": "2026-09-01T00:00:00Z",
    }
    with project.connection() as connection:
        connection.execute(
            "INSERT INTO metadata VALUES(?,?)",
            (
                "review:" + result["id"],
                canonical_json(legacy),
            ),
        )
    assert project.review_state(result["id"]) == legacy
    new = decide(project, result, "excluded", expected_review_sha256=review_sha256(legacy))
    assert project.review_history(result["id"]) == [legacy, new]
    assert new["previous_review_sha256"] == review_sha256(legacy)


@pytest.mark.parametrize(
    "change",
    [
        {"authority": None},
        {"reason": ""},
        {"coverage": ""},
        {"actor_id": "someone-else"},
    ],
)
def test_agent_review_requires_declared_identity_authority_and_assessment(reviewed_study, change):
    project, result = reviewed_study
    with pytest.raises(ValueError):
        decide(project, result, **{**agent_kwargs(), **change})
    assert project.review_history(result["id"]) == []


def test_concurrent_review_cannot_overwrite_a_newer_decision_with_stale_context(reviewed_study):
    project, result = reviewed_study
    first = decide(project, result)

    def attempt(disposition):
        try:
            return decide(
                ResearchProject(project.root),
                result,
                disposition,
                expected_review_sha256=review_sha256(first),
            )
        except ValueError as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(attempt, ["excluded", "pending"]))
    assert sum(isinstance(value, dict) for value in outcomes) == 1
    assert any("Review changed since" in value for value in outcomes if isinstance(value, str))
    assert len(project.review_history(result["id"])) == 2


def test_revocation_rolls_back_both_current_review_and_history(reviewed_study):
    project, result = reviewed_study
    count = 0

    def check():
        nonlocal count
        count += 1
        if count == 2:
            raise PermissionError("Policy revoked")

    with pytest.raises(PermissionError, match="revoked"):
        decide(project, result, check=check, **agent_kwargs())
    assert project.review_state(result["id"]) is None
    assert project.review_history(result["id"]) == []


def test_missing_or_changed_predecessor_is_rejected(reviewed_study):
    project, result = reviewed_study
    first = decide(project, result)
    decide(project, result, "excluded")
    with project.connection() as connection:
        connection.execute(
            "DELETE FROM metadata WHERE key=?",
            (f"review-event:{result['id']}:{first['event_id']}",),
        )
    with pytest.raises(ValueError, match="predecessor"):
        project.review_state(result["id"])


def test_an_event_receipt_cannot_silently_lose_its_history(reviewed_study):
    project, result = reviewed_study
    decide(project, result)
    with project.connection() as connection:
        connection.execute("DELETE FROM metadata WHERE key LIKE 'review-event:%'")
    with pytest.raises(ValueError, match="decision history"):
        project.review_state(result["id"])


def test_imported_actor_assurance_cannot_claim_verified_identity(reviewed_study):
    project, result = reviewed_study
    receipt = decide(project, result, **agent_kwargs())
    changed = json.loads(canonical_json(receipt))
    changed["identity_assurance"] = "verified"
    with pytest.raises(ValueError, match="declared"):
        validate_review(changed)
