"""Tissue output authority and freshly authorized MCP observation during publication."""

import asyncio
import copy
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_tissue_models import policy_spec
from test_research_mcp import stdio_parameters
from test_research_tissue_models import token
from test_tissue_model_integration import corrected, exact, produce, task

from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.agent_policy import TISSUE_POLICY_SCHEMA, load_policy, write_policy
from loci_engine.agent_sessions import AgentSessionApprovalError, start_session
from loci_engine.agent_study import authorize_result
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import ResearchProject, canonical_json, parse_json

pytest_plugins = ["test_tissue_model_integration"]


def scoped_policy(case, tmp_path):
    spec = policy_spec(case, tmp_path)
    spec["tissue_outputs"] = [
        {
            "source_id": case.source["id"],
            "source_sha256": case.source["sha256"],
            "output_selection": copy.deepcopy(case.request["output_selection"]),
        }
    ]
    return spec


def test_exact_output_applies_to_preview_token_replay_retained_and_correction(ready, tmp_path):
    case = ready
    spec = scoped_policy(case, tmp_path)
    path = tmp_path / "output-policy.json"
    write_policy(path, case.project, spec)
    policy = load_policy(path)
    assert policy.schema == TISSUE_POLICY_SCHEMA
    agent = PolicyAgent(policy)
    for operation, mode in (("tissue_model_preview", "task"), ("tissue_model_status", "read")):
        authorize_action(agent, case.wb, operation, case.request, mode=mode)
        different = copy.deepcopy(case.request)
        different["output_selection"]["x"] = 0  # Within the full-context read grant.
        with pytest.raises(PermissionError, match="exact tissue output"):
            authorize_action(agent, case.wb, operation, different, mode=mode)

    preview, _, result = produce(case)
    authorize_action(agent, case.wb, "tissue_model_run", token(preview), mode="task")
    authorize_result(policy, case.wb, result["id"])
    child = corrected(case, result)
    authorize_result(policy, case.wb, child["id"])
    inspect_action(agent, case.wb, "correction_info", exact(child))

    # A legitimate token from a broader policy grants no authority to this policy.
    case.request["output_selection"]["x"] = 0
    other_preview = task(case, "tissue_model_preview", case.request, "other-output-preview")
    other_run = task(case, "tissue_model_run", token(other_preview), "other-output-run")
    before = case.project.list_jobs()
    with pytest.raises(PermissionError, match="exact tissue output"):
        agent.submit_action("tissue_model_run", token(other_preview), "denied-token")
    assert case.project.list_jobs() == before
    with pytest.raises(PermissionError, match="exact tissue output"):
        authorize_result(policy, case.wb, other_run["result"]["id"])
    owned = submit_job(
        case.wb, token(other_preview), "denied-replay", "tissue_model_run", owner=agent.job_owner
    )
    with pytest.raises(PermissionError, match="exact tissue output"):
        agent.job_status(owned["id"])


@pytest.mark.parametrize(
    "change",
    ["null", "missing-axis", "boolean-axis", "level", "source", "hash", "outside", "duplicate"],
)
def test_malformed_or_stale_output_grants_fail_before_policy_write(ready, tmp_path, change):
    spec = scoped_policy(ready, tmp_path)
    grant = spec["tissue_outputs"][0]
    if change == "null":
        spec["tissue_outputs"] = None
    elif change == "missing-axis":
        del grant["output_selection"]["t"]
    elif change == "boolean-axis":
        grant["output_selection"]["t"] = False
    elif change == "level":
        grant["output_selection"]["level"] = 1
    elif change == "source":
        grant["source_id"] = "f" * 32
    elif change == "hash":
        grant["source_sha256"] = "f" * 64
    elif change == "outside":
        grant["output_selection"]["width"] = 11
    else:
        spec["tissue_outputs"].append(copy.deepcopy(grant))
    path = tmp_path / "invalid-policy.json"
    with pytest.raises(ValueError):
        write_policy(path, ready.project, spec)
    assert not path.exists()


def test_scoped_schema_requires_scope_and_empty_scope_denies_while_legacy_stays_broad(
    ready, tmp_path
):
    path = tmp_path / "policy.json"
    spec = scoped_policy(ready, tmp_path)
    spec["tissue_outputs"] = []
    write_policy(path, ready.project, spec)
    with pytest.raises(PermissionError, match="exact tissue output"):
        authorize_action(
            PolicyAgent(load_policy(path)),
            ready.wb,
            "tissue_model_preview",
            ready.request,
            mode="task",
        )
    document = parse_json(path.read_text())
    del document["tissue_outputs"]
    path.write_text(canonical_json(document))
    with pytest.raises(ValueError):
        load_policy(path)
    del spec["tissue_outputs"]
    write_policy(path, ready.project, spec)
    assert load_policy(path).tissue_outputs is None
    authorize_action(
        PolicyAgent(load_policy(path)), ready.wb, "tissue_model_preview", ready.request, mode="task"
    )


@pytest.mark.parametrize("change", ["policy-paused", "owner"])
def test_status_denies_current_authority_or_owner_under_writer_contention(
    ready, tmp_path, monkeypatch, change
):
    spec = scoped_policy(ready, tmp_path)
    path = tmp_path / "status-policy.json"
    write_policy(path, ready.project, spec)
    policy = load_policy(path)
    session = start_session(ready.project, policy)
    agent = PolicyAgent(policy, session_id=session["session_id"])
    owner = agent.job_owner
    if change == "owner":
        other_session = start_session(ready.project, policy)
        owner = {**owner, "session_id": other_session["session_id"]}
    job = submit_job(ready.wb, ready.request, "owned-preview", "tissue_model_preview", owner=owner)
    if change != "owner":
        key = "agent-policy:" + policy.content_sha256
        with ready.project.connection() as connection:
            record = parse_json(
                connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0]
            )
            record["paused"] = True
            connection.execute(
                "UPDATE metadata SET value=? WHERE key=?", (canonical_json(record), key)
            )
    original_connection = ResearchProject.connection

    @contextmanager
    def immediate_connection(project, **_kwargs):
        # A regression that attempts any write fails immediately, rather than
        # spending the default busy timeout and accidentally masking contention.
        with original_connection(project, timeout=0.0) as connection:
            yield connection

    monkeypatch.setattr(ResearchProject, "connection", immediate_connection)
    with ready.project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        with pytest.raises((AgentSessionApprovalError, PermissionError)):
            agent.job_status(job["id"])


def test_stdio_status_observes_publication_without_writes_and_rechecks_revocation(
    ready, tmp_path, monkeypatch
):
    case = ready
    spec = scoped_policy(case, tmp_path)
    spec["permission_mode"] = "full_access"
    path = tmp_path / "stdio-policy.json"
    write_policy(path, case.project, spec)
    policy = load_policy(path)
    preview = task(case, "tissue_model_preview", case.request, "publication-preview")
    publishing, release = threading.Event(), threading.Event()
    local = threading.local()
    original_connection, original_save = case.project.connection, case.project.save_result

    @contextmanager
    def observed_connection(**kwargs):
        with original_connection(**kwargs) as connection:
            stack = getattr(local, "connections", [])
            local.connections = [*stack, connection]
            try:
                yield connection
            finally:
                local.connections = stack

    def held_save(**kwargs):
        guard = kwargs["publication_guard"]

        def held_guard():
            guard()
            # Pause the real save_result guard only after BEGIN IMMEDIATE.
            if any(conn.in_transaction for conn in getattr(local, "connections", [])):
                publishing.set()
                assert release.wait(12), "Publication test did not release its writer"

        return original_save(**{**kwargs, "publication_guard": held_guard})

    monkeypatch.setattr(case.project, "connection", observed_connection)
    monkeypatch.setattr(case.project, "save_result", held_save)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            with case.project.connection() as connection:
                session_record = parse_json(
                    connection.execute(
                        "SELECT value FROM metadata WHERE key LIKE 'agent-session:%'"
                    ).fetchone()[0]
                )
            owner = {
                "policy_sha256": policy.content_sha256,
                "session_id": session_record["session_id"],
            }
            job = submit_job(
                case.wb, token(preview), "publication-run", "tissue_model_run", owner=owner
            )
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(run_job, case.wb, job["id"])
                try:
                    assert await asyncio.to_thread(publishing.wait, 5)
                    with case.project.connection() as connection:
                        before = connection.execute(
                            "SELECT * FROM metadata ORDER BY key"
                        ).fetchall()
                    for delay in (0, 2.2):
                        # Cross a periodic lifecycle tick while the writer is held.
                        await asyncio.sleep(delay)
                        response = await asyncio.wait_for(
                            session.call_tool("job_status", {"job_id": job["id"]}), timeout=2
                        )
                        assert not response.is_error, response
                        status = response.structured_content["job"]
                        assert status["state"] == "running" and status["result_ids"] == []
                        assert "pid" not in status and str(tmp_path) not in str(status)
                    with case.project.connection() as connection:
                        assert (
                            connection.execute("SELECT * FROM metadata ORDER BY key").fetchall()
                            == before
                        )
                finally:
                    release.set()
                output = future.result(timeout=5)
            response = await session.call_tool("job_status", {"job_id": job["id"]})
            assert not response.is_error
            assert response.structured_content["job"]["result_ids"] == [output["result"]["id"]]
            assert response.structured_content["job"]["state"] == "succeeded"

            # Commit revocation before another writer; deny using current durable
            # authority promptly under contention, without a status/audit write.
            with case.project.connection() as connection:
                key = "agent-policy:" + policy.content_sha256
                record = parse_json(
                    connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[
                        0
                    ]
                )
                record["revoked"] = True
                connection.execute(
                    "UPDATE metadata SET value=? WHERE key=?", (canonical_json(record), key)
                )
            with case.project.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                changes = connection.total_changes
                denied = await asyncio.wait_for(
                    session.call_tool("job_status", {"job_id": job["id"]}), timeout=2
                )
                assert denied.is_error
                assert connection.total_changes == changes

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
