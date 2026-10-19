import asyncio
import copy
import json
import tempfile
import zipfile

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_policy import make_study, specification
from test_research_mcp import stdio_parameters

from loci_engine.agent_policy import STUDY_POLICY_SCHEMA, load_policy, write_policy
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import canonical_json
from loci_engine.research_review import review_sha256

DISCLOSURES = [
    "geometry",
    "source_names",
    "previews",
    "measurements",
    "provenance",
    "agent_metadata",
]


def setup(tmp_path, *, scope="pinned-recipes", disclosures=None, review=True):
    workbench, source, request = make_study(tmp_path)
    root = tmp_path / "exports"
    root.mkdir()
    spec = specification(
        workbench,
        source,
        request,
        root,
        disclosures=list(DISCLOSURES if disclosures is None else disclosures),
    )
    spec.update(
        remote_grants=[],
        experimental_recipes=[],
        delegation={
            "id": "d" * 32,
            "client_id": "declared-test-client",
            "expires_at": None,
            "result_scope": scope,
        },
    )
    spec["operations"].append("review_history")
    if review:
        spec["operations"].append("review_result")
    path = tmp_path / "agent-policy.json"
    write_policy(path, workbench.project, spec)
    agent = PolicyAgent(load_policy(path))
    result = workbench.run_recipe(request)["result"]
    return agent, workbench, result, path, request, spec, root


def decision(result, **updates):
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "disposition": "reviewed",
        "reason": "Boundary review completed for this fixture.",
        "coverage": "All four Z planes of the granted 32 by 32 region.",
        "expected_review_sha256": None,
        **updates,
    }


def test_delegated_decision_survives_export_and_portable_study_roundtrip(tmp_path):
    agent, workbench, result, _, _, _, root = setup(tmp_path)
    assert agent.policy.schema == STUDY_POLICY_SCHEMA
    receipt = agent.review_result(decision(result))["review"]
    assert receipt["actor"] == "agent"
    assert receipt["actor_id"] == "declared-test-client"
    assert receipt["authority"]["policy_sha256"] == agent.policy.content_sha256
    agent.export_result(result["id"], result["revision_hash"], "approved-result")
    exported = json.loads((root / "approved-result/result.json").read_text())
    assert exported["review"] == receipt
    history = json.loads((root / "approved-result/review-history.json").read_text())
    assert history["events"] == [receipt]
    researcher = workbench.project.review(result["id"], result["revision_hash"], "excluded")
    path = tmp_path / "study.loci-study.zip"
    export_project(workbench.project, path)
    restored = import_project(path, tmp_path / "restored.loci-study")
    assert restored.review_state(result["id"]) == researcher
    assert restored.review_history(result["id"]) == [receipt, researcher]


def test_review_permission_cannot_be_inferred_from_run_export_or_full_source_scope(tmp_path):
    agent, workbench, result, *_ = setup(tmp_path, scope="granted-sources", review=False)
    with pytest.raises(PermissionError, match="operation"):
        agent.review_result(decision(result))
    assert workbench.project.review_state(result["id"]) is None


def test_export_only_grant_does_not_start_accepting_agent_approval(tmp_path):
    agent, workbench, result, path, _, spec, root = setup(tmp_path)
    agent.review_result(decision(result))
    spec["operations"].remove("review_result")
    write_policy(path, workbench.project, spec)
    with pytest.raises(PermissionError, match="delegated approval"):
        PolicyAgent(load_policy(path)).export_result(
            result["id"], result["revision_hash"], "approved-result"
        )
    assert not (root / "approved-result").exists()


def test_paired_channel_and_result_dependencies_remain_inside_study_grant(tmp_path):
    agent, workbench, result, path, request, spec, _ = setup(tmp_path, scope="granted-sources")
    paired = workbench.execute(
        "colocalisation_run",
        {
            "source_id": result["source_id"],
            "selection": request["selection"],
            "first_channel": 0,
            "second_channel": 1,
            "threshold_first": 50,
            "threshold_second": 10,
            "control": "Synthetic known channels",
            "working_bytes": 16 * 1024**2,
        },
    )["result"]
    with pytest.raises(PermissionError, match="selection"):
        agent.review_result(decision(paired))
    spec["sources"][0]["c"] = [0, 1]
    spec["sources"][0]["measurement_channels"] = [0, 1]
    write_policy(path, workbench.project, spec)
    agent = PolicyAgent(load_policy(path))
    assert agent.review_result(decision(paired))["review"]["actor"] == "agent"
    other_request = copy.deepcopy(request)
    other_request["selection"]["c"] = 1
    other_request["recipe"]["segmentation"]["threshold"] = 10
    other = workbench.run_recipe(other_request)["result"]
    association = workbench.execute(
        "associate_results",
        {
            "nuclei": {"result_id": result["id"], "revision_hash": result["revision_hash"]},
            "cells": {"result_id": other["id"], "revision_hash": other["revision_hash"]},
            "roles": {"nuclei": "synthetic regions A", "cells": "synthetic regions B"},
            "control": "Fixture only",
            "working_bytes": 16 * 1024**2,
        },
    )["result"]
    assert agent.review_result(decision(association))["review"]["actor"] == "agent"
    spec["sources"][0]["c"] = [1]
    write_policy(path, workbench.project, spec)
    with pytest.raises(PermissionError, match="selection"):
        PolicyAgent(load_policy(path)).review_history(association["id"])


def test_legacy_portable_receipt_keeps_original_schema_and_fields(tmp_path):
    _, workbench, result, *_ = setup(tmp_path)
    legacy = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "disposition": "reviewed",
        "reviewed_at": "2026-01-01T00:00:00Z",
        "actor": "human",
    }
    with workbench.project.connection() as connection:
        connection.execute(
            "INSERT INTO metadata VALUES(?,?)", ("review:" + result["id"], canonical_json(legacy))
        )
    archive = tmp_path / "legacy.zip"
    export_project(workbench.project, archive)
    with zipfile.ZipFile(archive) as incoming:
        assert json.loads(incoming.read("manifest.json"))["schema"] == "loci.study-interchange/v1"
    restored = import_project(archive, tmp_path / "restored")
    assert restored.review_history(result["id"]) == [legacy]
    assert restored.review_state(result["id"]) == legacy


def test_export_rejects_orphaned_review_history(tmp_path):
    agent, workbench, result, *_ = setup(tmp_path)
    agent.review_result(decision(result))
    with workbench.project.connection() as connection:
        connection.execute("DELETE FROM metadata WHERE key=?", ("review:" + result["id"],))
    with pytest.raises(ValueError, match="history has no current"):
        export_project(workbench.project, tmp_path / "orphan.zip")


def test_portable_import_rejects_an_omitted_event_history_even_with_rehashed_manifest(tmp_path):
    from test_research_interchange import _rewrite

    agent, workbench, result, *_ = setup(tmp_path)
    agent.review_result(decision(result))
    archive, forged = tmp_path / "valid.zip", tmp_path / "forged.zip"
    export_project(workbench.project, archive)

    def remove_history(entries):
        changed = []
        for info, raw in entries:
            if info.filename.startswith("review-history/"):
                continue
            if info.filename == "manifest.json":
                manifest = json.loads(raw)
                manifest["members"] = [
                    item
                    for item in manifest["members"]
                    if not item["path"].startswith("review-history/")
                ]
                raw = canonical_json(manifest).encode()
            changed.append((info, raw))
        return changed

    _rewrite(archive, forged, remove_history)
    with pytest.raises(ValueError, match="complete decision history"):
        import_project(forged, tmp_path / "imported")
    assert not (tmp_path / "imported").exists()


def test_agent_cannot_impersonate_human_or_overwrite_a_concurrent_researcher_decision(tmp_path):
    agent, workbench, result, *_ = setup(tmp_path)
    with pytest.raises(ValueError):
        agent.review_result({**decision(result), "actor": "human"})
    human = workbench.project.review(result["id"], result["revision_hash"], "excluded")
    with pytest.raises(ValueError, match="changed since"):
        agent.review_result(decision(result))
    assert workbench.project.review_state(result["id"]) == human
    accepted = agent.review_result(decision(result, expected_review_sha256=review_sha256(human)))
    assert accepted["review"]["actor"] == "agent"


def test_full_source_grant_can_review_a_different_method_but_not_another_timepoint(tmp_path):
    agent, workbench, _, _, request, *_ = setup(tmp_path, scope="granted-sources")
    changed = copy.deepcopy(request)
    changed["recipe"]["segmentation"]["threshold"] = 77
    result = workbench.run_recipe(changed)["result"]
    assert agent.review_result(decision(result))["review"]["actor"] == "agent"
    changed["selection"]["t"] = 1
    outside = workbench.run_recipe(changed)["result"]
    with pytest.raises(PermissionError, match="selection"):
        agent.review_result(decision(outside))
    assert workbench.project.review_state(outside["id"]) is None


def test_history_redacts_free_text_when_its_underlying_disclosures_are_not_granted(tmp_path):
    agent, workbench, result, *_ = setup(tmp_path, disclosures=["agent_metadata"])
    receipt = workbench.project.review(
        result["id"],
        result["revision_hash"],
        "reviewed",
        reason="secret source name and measured intensity",
    )
    history = agent.review_history(result["id"])
    assert "secret source" not in json.dumps(history)
    assert history["assessment_disclosed"] is False
    assert history["current_review_sha256"] == review_sha256(receipt)


def test_expired_or_revoked_delegation_cannot_review(tmp_path, monkeypatch):
    from datetime import UTC, datetime

    import loci_engine.agent_policy as policy_module

    agent, workbench, result, path, _, spec, _ = setup(tmp_path)
    spec["delegation"]["expires_at"] = "2099-01-01T00:00:00+00:00"
    write_policy(path, workbench.project, spec)
    current = PolicyAgent(load_policy(path))
    with pytest.raises(PermissionError, match="changed or replaced"):
        agent.review_result(decision(result))

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2100, 1, 1, tzinfo=UTC)

    monkeypatch.setattr(policy_module, "datetime", Later)
    with pytest.raises(PermissionError, match="expired"):
        current.review_result(decision(result))
    assert workbench.project.review_state(result["id"]) is None


def test_actual_stdio_review_has_agent_identity_and_rejects_extra_actor_arguments(tmp_path):
    _, workbench, result, path, *_ = setup(tmp_path)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            assert "review_result" in tools
            assert tools["review_result"].annotations.read_only_hint is False
            bad = await session.call_tool(
                "review_result", {"request": decision(result), "actor": "human"}
            )
            assert bad.is_error
            invalid = await session.call_tool(
                "review_result", {"request": {**decision(result), "actor": "human"}}
            )
            assert invalid.is_error
            response = await session.call_tool("review_result", {"request": decision(result)})
            assert not response.is_error
            assert response.structured_content["review"]["actor"] == "agent"
            history = await session.call_tool("review_history", {"result_id": result["id"]})
            assert not history.is_error
            assert history.structured_content["total_events"] == 1

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
    assert workbench.project.review_state(result["id"])["actor"] == "agent"
