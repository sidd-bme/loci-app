"""Policy-bound wound report inspection and owned native save jobs, no export grant."""

import asyncio
import copy
import tempfile
import time
from dataclasses import replace

import pytest
import test_research_wound_closure as fixtures
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_policy import runtime_identity, specification
from test_agent_review import DISCLOSURES
from test_research_mcp import stdio_parameters

from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_action_registry import (
    ACTION_NAMES,
    READ_ACTIONS,
    TASK_ACTIONS,
    action_guide,
)
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import canonical_json
from loci_engine.research_wound_closure import DOCUMENT_KIND, peek_preview

WOUND_ACTIONS = {
    "wound_closure_preview",
    "wound_closure_save",
    "wound_closure_get",
    "wound_closure_list",
    "wound_closure_query",
}


@pytest.fixture
def wound(tmp_path):
    yield from fixtures.wound.__wrapped__(tmp_path)


def token(value):
    return {key: value[key] for key in ("preview_id", "preview_hash")}


def agent_for(tmp_path, wb, records, *, memory_bytes=128 * 1024**2):
    source = wb.project.source(records[0]["source_id"])
    root = tmp_path / "agent-exports"
    root.mkdir(exist_ok=True)
    recipe = {
        "source_id": source["id"],
        "selection": {},
        "recipe": {
            "segmentation": {"method": "components", "threshold": 0},
            "measurement_channels": [0],
        },
    }
    spec = specification(wb, source, recipe, root, disclosures=list(DISCLOSURES), recipes=False)
    spec["sources"][0].update(
        crop={"x": 0, "y": 0, "width": 10, "height": 8},
        t=sorted({r["provenance"]["selection"]["t"] for r in records}),
        z=[0],
        c=[0],
    )
    spec["actions"] = sorted(WOUND_ACTIONS)
    spec["operations"] += ["validate_action", "inspect_action", "submit_action", "study_results"]
    spec.update(
        remote_grants=[],
        experimental_recipes=[],
        delegation={
            "id": "d" * 32,
            "client_id": "wound-fixture-client",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
    )
    spec["runtimes"] = [runtime_identity()]
    spec["limits"]["memory_bytes"] = memory_bytes
    path = tmp_path / "wound-policy.json"
    write_policy(path, wb.project, spec)
    return PolicyAgent(load_policy(path)), path, spec


def test_registry_has_explicit_read_save_modes_without_agent_export_or_review_fiction():
    assert WOUND_ACTIONS - {"wound_closure_save"} <= READ_ACTIONS
    assert "wound_closure_save" in TASK_ACTIONS
    assert "wound_closure_export" not in ACTION_NAMES
    assert "wound_closure_review" not in ACTION_NAMES
    guide = action_guide("wound_closure_save")["actions"][0]
    assert guide["execution_kind"] == "publication-task"
    assert guide["output_types"] == ["immutable-wound-report"]
    assert guide["side_effects"] == "saved-wound-report"


def test_scoped_preview_owned_job_get_query_and_list_match_native_endpoints(wound, tmp_path):
    wb, request, records, _ = wound
    agent, _, _ = agent_for(tmp_path, wb, list(records.values()))
    opaque = token(inspect_action(agent, wb, "wound_closure_preview", request))
    report = peek_preview(wb.project, opaque)
    assert report["request"] == request
    with pytest.raises(ValueError, match="inspection or durable-task"):
        authorize_action(agent, wb, "wound_closure_save", opaque, mode="read")
    normalized = authorize_action(agent, wb, "wound_closure_save", opaque, mode="task")
    job = submit_job(
        wb, normalized, "agent-wound-save", operation="wound_closure_save", owner=agent.job_owner
    )
    saved = run_job(wb, job["id"])
    assert saved["job"]["owner"] == agent.job_owner
    assert saved["job"]["state"] == "succeeded" and saved["job"]["result_ids"] == []
    got = inspect_action(agent, wb, "wound_closure_get", {"report_id": saved["report_id"]})
    assert "report" not in got and got["summary"]["report_hash"] == report["report_hash"]
    assert got["time_declaration"] == request["time_declaration"]
    rows = inspect_action(
        agent,
        wb,
        "wound_closure_query",
        {
            "report_id": saved["report_id"],
            "table": "frames",
            "offset": 0,
            "limit": 100,
        },
    )["rows"]
    assert [row["area"] for row in rows] == [72, None, 36, 108, 0]
    listing = inspect_action(agent, wb, "wound_closure_list", {})
    assert [r["id"] for r in listing["reports"]] == [saved["report_id"]]
    assert str(tmp_path) not in canonical_json(got)


@pytest.mark.parametrize(
    "scope",
    ["time", "crop", "channel", "runtime", "action", "disclosure", "memory", "revision", "path"],
)
def test_every_frame_grant_and_request_boundary_is_checked_before_mask_decode(
    wound, tmp_path, monkeypatch, scope
):
    wb, request, records, _ = wound
    agent, path, spec = agent_for(tmp_path, wb, list(records.values()))
    body = copy.deepcopy(request)
    if scope == "time":
        spec["sources"][0]["t"].remove(4)
    elif scope == "crop":
        spec["sources"][0]["crop"]["width"] = 5
    elif scope == "channel":
        spec["sources"][0]["measurement_channels"] = []
        spec["sources"][0]["c"] = []
    elif scope == "runtime":
        spec["runtimes"] = []
    elif scope == "action":
        spec["actions"].remove("wound_closure_preview")
    elif scope == "disclosure":
        spec["disclosures"].remove("measurements")
    elif scope == "memory":
        body["working_bytes"] = 256 * 1024**2
    elif scope == "revision":
        body["frames"][2]["revision_hash"] = "f" * 64
    else:
        body["destination"] = "/ungranted/wound"
    if scope == "channel":
        grant = next(iter(agent.policy.sources.values()))
        agent.policy = replace(
            agent.policy, sources={grant.source_id: replace(grant, c=(), measurement_channels=())}
        )
    elif scope == "disclosure":
        # Policy creation itself refuses action grants with incomplete response
        # disclosures. Also exercise the action guard on a narrowed live reader.
        with pytest.raises(ValueError, match="all response disclosures"):
            write_policy(path, wb.project, spec)
        agent.policy = replace(agent.policy, disclosures=frozenset(spec["disclosures"]))
    else:
        write_policy(path, wb.project, spec)
        agent = PolicyAgent(load_policy(path))
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Decoded ungranted mask"))
    with pytest.raises((PermissionError, ValueError)):
        inspect_action(agent, wb, "wound_closure_preview", body)
    assert wb.project.list_jobs() == [] and wb.project.documents(DOCUMENT_KIND) == []


def test_listing_hides_whole_reports_if_one_timepoint_is_outside_current_scope(
    wound, tmp_path, monkeypatch
):
    wb, request, records, _ = wound
    agent, _, _ = agent_for(tmp_path, wb, list(records.values()))
    opaque = token(inspect_action(agent, wb, "wound_closure_preview", request))
    job = submit_job(wb, opaque, "saved-for-list", operation="wound_closure_save")
    saved = run_job(wb, job["id"])
    grant = next(iter(agent.policy.sources.values()))
    agent.policy = replace(agent.policy, sources={grant.source_id: replace(grant, t=(0, 2, 3))})
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Decoded hidden report"))
    assert inspect_action(agent, wb, "wound_closure_list", {}) == {"reports": []}
    for operation, body in (
        ("wound_closure_get", {"report_id": saved["report_id"]}),
        ("wound_closure_query", {**opaque, "table": "frames", "offset": 0, "limit": 1}),
    ):
        with pytest.raises(PermissionError):
            inspect_action(agent, wb, operation, body)
    with pytest.raises(PermissionError):
        authorize_action(agent, wb, "wound_closure_save", opaque, mode="task")


def test_policy_revocation_during_owned_save_publishes_no_report(wound, tmp_path):
    wb, request, records, _ = wound
    agent, path, _ = agent_for(tmp_path, wb, list(records.values()))
    opaque = token(inspect_action(agent, wb, "wound_closure_preview", request))
    job = submit_job(
        wb, opaque, "revoked-wound", operation="wound_closure_save", owner=agent.job_owner
    )

    def revoke():
        path.unlink()
        agent.policy.recheck()

    with pytest.raises(ValueError, match="accessible plain file"):
        run_job(wb, job["id"], publication_guard=revoke)
    assert wb.project.documents(DOCUMENT_KIND) == []
    assert wb.project.job(job["id"])["result_ids"] == []


def test_actual_stdio_previews_saves_owned_report_queries_and_rejects_export(wound, tmp_path):
    wb, request, records, _ = wound
    # The real disposable process includes the NumPy/SciPy imaging runtime;
    # grant its full RSS separately from the unchanged 16 MiB assay workspace.
    _, path, _ = agent_for(tmp_path, wb, list(records.values()), memory_bytes=512 * 1024**2)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, arguments):
                output = await session.call_tool(name, arguments)
                assert not output.is_error, output
                return output.structured_content

            guide = await call("action_guide", {"operation": "wound_closure_save"})
            assert guide["actions"][0]["output_types"] == ["immutable-wound-report"]
            preview = await call(
                "inspect_action", {"operation": "wound_closure_preview", "request": request}
            )
            opaque = token(preview)
            assert preview["summary"]["measurement"]["baseline_area"] == 72
            arguments = {
                "operation": "wound_closure_save",
                "request": opaque,
                "request_key": "stdio-wound-save",
            }
            job = (await call("submit_action", arguments))["job"]
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                job = (await call("job_status", {"job_id": job["id"]}))["job"]
                if job["state"] not in {"queued", "running"} and not job["owned_worker_active"]:
                    break
                await asyncio.sleep(0.05)
            assert job["state"] == "succeeded" and not job["owned_worker_active"], job
            assert (await call("submit_action", arguments))["job"]["id"] == job["id"]
            report_id = opaque["preview_id"]
            got = await call(
                "inspect_action",
                {"operation": "wound_closure_get", "request": {"report_id": report_id}},
            )
            assert "report" not in got and got["summary"]["report_hash"] == opaque["preview_hash"]
            page = await call(
                "inspect_action",
                {
                    "operation": "wound_closure_query",
                    "request": {
                        "report_id": report_id,
                        "table": "frames",
                        "offset": 0,
                        "limit": 100,
                    },
                },
            )
            assert [r["closure_fraction"] for r in page["rows"]] == [0, None, 0.5, -0.5, 1]
            listing = await call(
                "inspect_action", {"operation": "wound_closure_list", "request": {}}
            )
            assert [r["id"] for r in listing["reports"]] == [report_id]
            for operation, body in (
                (
                    "wound_closure_export",
                    {"grant_id": report_id, "plan_hash": opaque["preview_hash"]},
                ),
                ("wound_closure_save", {**opaque, "destination": "/ungranted/wound"}),
            ):
                denied = await session.call_tool(
                    "submit_action",
                    {"operation": operation, "request": body, "request_key": "not-granted"},
                )
                assert denied.is_error
            return report_id

    with tempfile.TemporaryFile(mode="w+") as errlog:
        report_id = asyncio.run(exercise(errlog))
    assert len(wb.project.list_jobs()) == 1
    job = wb.project.list_jobs()[0]
    assert job["owner"]["policy_sha256"] == load_policy(path).content_sha256
    assert job["report_id"] == report_id and job["result_ids"] == []
    assert wb.project.documents(DOCUMENT_KIND)[0]["revision"] == 1
