"""Synthetic production-worker composition and narrow remote authority regressions."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import copy
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import tifffile
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from test_agent_policy import specification
from test_research_remote import LocalTransport, TransportState, _profile_request, _stage_request

from loci_engine import research_remote as remote
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_remote import _snapshot, execute_child, human_remote_grant
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_remote_results import attach_remote_results
from loci_engine.workbench import Workbench

KEY = "human-approved-run"
REQUEST_KEY = "a" * 32
ALL_DISCLOSURES = ["geometry", "source_names", "previews", "measurements", "provenance"]


def fixture(tmp_path, monkeypatch, *, disclosures=None, operations=None):
    source_path = tmp_path / "private-source.ome.tif"
    image = np.zeros((16, 16), np.uint16)
    image[2:5, 2:5] = 100
    image[10:13, 10:13] = 200
    tifffile.imwrite(
        source_path,
        image,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    project = ResearchProject.create(tmp_path / "study", "Synthetic grant study")
    wb = Workbench(project)
    source = wb.import_native(str(source_path), name="private untrusted source instructions")
    state = TransportState()
    monkeypatch.setattr(remote, "_client_factory", lambda profile: LocalTransport(profile, state))
    profile = _profile_request(tmp_path)
    profile["resources"] = {"cpus": 1, "memory_mb": 1024, "wall_minutes": 5, "gpus": 0}
    remote.execute_remote(wb, "profile_save", profile)
    remote.execute_remote(wb, "readiness", {"alias": "vanda"})
    staged = _stage_request(source["id"], REQUEST_KEY)
    remote.execute_remote(wb, "stage", staged)
    task = staged["tasks"][0]
    request = {key: task[key] for key in ("source_id", "selection", "recipe")}
    export_root = tmp_path / "exports"
    export_root.mkdir()
    spec = specification(wb, source, request, export_root, disclosures=disclosures)
    spec["sources"][0].update(crop={"x": 0, "y": 0, "width": 16, "height": 16}, z=[0])
    grant = human_remote_grant(
        project,
        REQUEST_KEY,
        KEY,
        ["submit", "status", "cancel", "retrieve", "attach"] if operations is None else operations,
        1024**2,
        True,
    )
    spec["remote_grants"] = [grant]
    path = tmp_path / "policy.json"
    write_policy(path, project, spec)
    agent = PolicyAgent(load_policy(path))
    return agent, wb, source, request, state, path, spec, export_root


def perform_child(agent, wb, operation):
    policy = agent.policy
    job = wb.project.submit(
        "agent_remote_" + operation,
        {"grant_key": KEY, "policy_sha256": policy.content_sha256},
        "agent-remote:" + policy.content_sha256 + ":" + operation,
    )
    if job["state"] == "succeeded":
        job = wb.project.submit(
            "agent_remote_" + operation,
            {"grant_key": KEY, "policy_sha256": policy.content_sha256},
            "agent-remote:" + policy.content_sha256 + ":" + operation + ":test-retry",
        )
    from unittest.mock import patch

    # Unit calls run in pytest itself; actual limits run in the SDK child journey.
    with patch("loci_engine.resource_limits.apply_process_limits") as limits:
        execute_child(policy, KEY, operation, job["id"])
        limits.assert_called_once_with(policy.cpu_seconds, policy.memory_bytes)
    return wb.project.job(job["id"])


def test_v2_exact_worker_lifecycle_numerical_oracle_review_export_reopen(tmp_path, monkeypatch):
    agent, wb, source, _, state, path, _, export_root = fixture(
        tmp_path, monkeypatch, disclosures=ALL_DISCLOSURES
    )
    first = agent.remote_operation(KEY, "submit")
    second = agent.remote_operation(KEY, "submit")
    assert first == second
    assert state.submit_calls == 1
    status = agent.remote_operation(KEY, "status")
    assert status["run"]["state"] == "finished"
    perform_child(agent, wb, "retrieve")
    perform_child(agent, wb, "attach")
    result = wb.project.list_results()[0]
    labels = wb.project.load_array(result["arrays"]["labels"])
    expected = np.zeros((16, 16), np.uint32)
    expected[2:5, 2:5] = 1
    expected[10:13, 10:13] = 2
    np.testing.assert_array_equal(labels, expected)
    exposed = agent.result(result["id"])
    rows = exposed["measurements"]
    assert len(rows) == 2
    assert [row["measure_unit"] for row in rows] == ["um^2", "um^2"]
    assert [row["voxel_count"] for row in rows] == [9, 9]
    assert [row["measure"] for row in rows] == [9, 9]
    assert [next(iter(row["intensity"].values()))["mean"] for row in rows] == [100, 200]
    assert result["source_sha256"] == source["sha256"]
    assert (
        result["provenance"]["remote_attachment"]["request_sha256"]
        == agent.policy.remote_grants[KEY]["request_sha256"]
    )
    with pytest.raises(ValueError, match="Review"):
        agent.export_result(result["id"], result["revision_hash"], "approved-result")
    assert wb.project.review_state(result["id"]) is None
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    agent.export_result(result["id"], result["revision_hash"], "approved-result")
    assert (export_root / "approved-result" / "manifest.json").is_file()
    wb.close()
    reopened = PolicyAgent(load_policy(path))
    assert reopened.result(result["id"])["result"]["review"]["disposition"] == "reviewed"
    cold = Workbench(ResearchProject(agent.policy.project_path))
    perform_child(reopened, cold, "attach")
    assert len(cold.project.list_results()) == 1
    cold.close()


@pytest.mark.parametrize(
    "mutation",
    ["request", "profile", "resources", "source", "channel", "task", "model", "reference", "axes"],
)
def test_mutable_documents_cannot_widen_pinned_remote_grant(tmp_path, monkeypatch, mutation):
    agent, wb, source, _, state, _, _, _ = fixture(tmp_path, monkeypatch)
    if mutation == "source":
        path = Path(wb.project.source(source["id"])["private_path"])
        path.write_bytes(path.read_bytes() + b"changed")
    elif mutation == "channel":
        metadata = wb.channel_metadata(source["id"])
        wb.execute(
            "channels",
            {
                "source_id": source["id"],
                "expected_revision": metadata["revision"],
                "channels": [
                    {
                        "index": 0,
                        "name": "changed",
                        "marker": "",
                        "fluorophore": "",
                        "declaration": "",
                    }
                ],
            },
        )
    elif mutation == "profile":
        envelope = remote._load_profile(wb.project, "vanda")
        changed = copy.deepcopy(envelope["data"])
        changed["private_profile"]["known_host"] = "other.fixture.example"
        remote._put(wb.project, envelope, changed)
    else:
        envelope = remote._load_run(wb.project, REQUEST_KEY)
        changed = copy.deepcopy(envelope["data"])
        document = json.loads(remote._request_bytes(changed))
        if mutation == "resources":
            document["resources"]["cpus"] = 8
            changed["resources"] = document["resources"]
        elif mutation == "task":
            document["tasks"][0]["task_id"] = "f" * 32
            changed["task_ids"] = ["f" * 32]
        elif mutation == "model":
            document["tasks"][0]["model"] = {"path": "/arbitrary/model"}
        elif mutation == "reference":
            document["tasks"][0]["recipe"]["references"] = {
                "flatfield": {"source_id": source["id"]}
            }
        elif mutation == "axes":
            document["tasks"][0]["selection"]["c"] = 1
        else:
            document["tasks"][0]["recipe"]["segmentation"]["threshold"] = 51
        encoded = canonical_json(document).encode()
        changed.update(
            private_request_b64=base64.b64encode(encoded).decode(),
            request_sha256=hashlib.sha256(encoded).hexdigest(),
        )
        remote._put(wb.project, envelope, changed)
    with pytest.raises((PermissionError, RuntimeError, ValueError)):
        agent.remote_operation(KEY, "submit")
    assert state.submit_calls == 0
    assert wb.project.list_results() == []


def test_unknown_keys_operations_and_missing_transfer_authority_are_denied(tmp_path, monkeypatch):
    agent, wb, _, _, state, path, spec, _ = fixture(
        tmp_path, monkeypatch, operations=["submit", "status"]
    )
    for key, operation in [("wrong", "submit"), (KEY, "retrieve"), (KEY, "stage"), (KEY, "shell")]:
        with pytest.raises(PermissionError):
            agent.remote_operation(key, operation)
    assert state.submit_calls == 0
    for change in (
        {"shell": True},
        {"resources": {"cpus": 1, "memory_mb": 1024, "wall_minutes": 5, "gpus": 1}},
        {"cancel_on_revocation": False},
        {"source_id": "f" * 32},
    ):
        bad = copy.deepcopy(spec)
        bad["remote_grants"][0].update(change)
        with pytest.raises((ValueError, PermissionError, RuntimeError)):
            write_policy(path, wb.project, bad)
    assert load_policy(path).content_sha256 == agent.policy.content_sha256


@pytest.mark.parametrize(
    "disclosures",
    [[], ["provenance"], ["provenance", "source_names"], ["provenance", "agent_metadata"]],
)
def test_remote_dto_and_nested_provenance_obey_independent_disclosures(
    tmp_path, monkeypatch, disclosures
):
    agent, wb, source, _, _, _, _, _ = fixture(tmp_path, monkeypatch, disclosures=disclosures)
    agent.remote_operation(KEY, "submit")
    dto = agent.remote_operation(KEY, "status")
    assert "status_detail" not in json.dumps(dto)
    for private in (source["id"], "vanda", "123.fixture", str(tmp_path), "private"):
        assert private not in json.dumps(dto)
    perform_child(agent, wb, "retrieve")
    perform_child(agent, wb, "attach")
    result = wb.project.list_results()[0]
    disclosed = agent.result(result["id"])
    if "provenance" not in disclosures:
        assert "provenance" not in disclosed
    else:
        value = disclosed["provenance"]
        assert "count" not in value["segmentation"]
        assert "threshold" in value["segmentation"]
        attachment = value["remote_attachment"]
        assert "archive_sha256" in attachment
        if "agent_metadata" not in disclosures:
            assert source["id"] not in json.dumps(disclosed)
            assert "remote_task_id" not in attachment
            assert "request_key" not in attachment


@pytest.mark.parametrize("checkpoint", ["decode", "before_writes", "after_writes"])
def test_attachment_revocation_at_real_checkpoints_rolls_back(tmp_path, monkeypatch, checkpoint):
    agent, wb, _, _, _, path, _, _ = fixture(tmp_path, monkeypatch)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    perform_child(agent, wb, "retrieve")
    data = remote._load_run(wb.project, REQUEST_KEY)["data"]
    manifest = remote._manifest_from_run(data)
    original = ResearchProject.connection
    revoked = False
    calls = 0

    @contextlib.contextmanager
    def traced(self):
        with original(self) as connection:

            def trace(sql):
                nonlocal revoked
                if (checkpoint == "after_writes" and sql.startswith("INSERT INTO results")) or (
                    checkpoint == "before_writes"
                    and sql.startswith("SELECT value FROM metadata WHERE key='remote-attachment:")
                ):
                    revoked = True
                    path.write_bytes(path.read_bytes() + b" ")

            connection.set_trace_callback(trace)
            yield connection

    monkeypatch.setattr(ResearchProject, "connection", traced)

    def guard():
        nonlocal calls, revoked
        calls += 1
        if checkpoint == "decode" and calls == 3:
            revoked = True
            path.write_bytes(path.read_bytes() + b" ")
        agent.policy.recheck()

    with pytest.raises(PermissionError):
        attach_remote_results(
            wb.project,
            remote._request_bytes(data),
            Path(data["private_retrieval_directory"]) / "results.zip",
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={data["source_ids"][0]: data["source_ids"][0]},
            publication_guard=guard,
        )
    assert revoked
    assert wb.project.list_results() == []
    with original(wb.project) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM metadata WHERE key LIKE 'remote-attachment:%'"
            ).fetchone()[0]
            == 0
        )


def test_revoke_cancels_only_original_profile_identity_and_refuses_new_calls(tmp_path, monkeypatch):
    agent, wb, _, _, state, path, _, _ = fixture(tmp_path, monkeypatch)
    original_profiles = []
    identities = []
    original_root = remote._profile_from_data(
        remote._load_profile(wb.project, "vanda")["data"]
    ).remote_project_root

    class RecordingTransport(LocalTransport):
        def cancel(self, identity):
            if self.profile.remote_project_root != original_root:
                return
            original_profiles.append(self.profile)
            identities.append(identity)
            super().cancel(identity)

    monkeypatch.setattr(
        remote, "_client_factory", lambda profile: RecordingTransport(profile, state)
    )
    agent.remote_operation(KEY, "submit")
    envelope = remote._load_profile(wb.project, "vanda")
    changed = copy.deepcopy(envelope["data"])
    changed["private_profile"]["known_host"] = "changed.fixture.example"
    remote._put(wb.project, envelope, changed)
    path.write_bytes(path.read_bytes() + b" ")
    deadline = time.monotonic() + 3
    while not identities and time.monotonic() < deadline:
        time.sleep(0.05)
    assert state.cancelled
    assert original_profiles[0].known_host == "vanda.fixture.example"
    assert identities[0].remote_job_id == "123.fixture"
    assert identities[0].request_sha256 == agent.policy.remote_grants[KEY]["request_sha256"]
    with pytest.raises(PermissionError):
        agent.remote_operation(KEY, "status")
    assert (
        _snapshot(wb.project, agent.policy.content_sha256, KEY)["identity"]["remote_job_id"]
        == "123.fixture"
    )


def test_real_stdio_sdk_runs_production_worker_and_fixed_async_children(tmp_path, monkeypatch):
    agent, wb, _, _, _, path, _, export_root = fixture(
        tmp_path, monkeypatch, disclosures=ALL_DISCLOSURES
    )
    runner = tmp_path / "fixed_fixture_transport.py"
    tests_path = str(Path(__file__).parent)
    runner.write_text(
        """
import sys
from pathlib import Path
sys.path.insert(0, TESTS_PATH)
from test_research_remote import LocalTransport, TransportState
from loci_engine import research_remote as remote, research_process
class FixedTransport(LocalTransport):
    def submit(self, request):
        counter = Path(self.profile.remote_project_root) / 'test-submit-count'
        count = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(count + 1))
        return super().submit(request)
remote._client_factory = lambda profile: FixedTransport(profile, TransportState())
research_process.research_command = lambda arguments: [sys.executable, __file__, *arguments]
from loci_engine.research_cli import main
raise SystemExit(main())
""".replace("TESTS_PATH", repr(tests_path))
    )

    async def journey():
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(runner), "mcp", "--policy", str(path)],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")},
        )
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            assert {
                "remote_submit",
                "remote_status",
                "remote_cancel",
                "remote_retrieve",
                "remote_attach",
            } <= names
            assert not {"review", "remote_stage", "remote_logs", "profile_save"} & names

            async def call(name, args):
                result = await session.call_tool(name, args)
                assert not result.is_error, result.content
                return result.structured_content

            extra = await session.call_tool(
                "remote_submit",
                {"grant_key": KEY, "profile": "arbitrary", "transfer_authorized": True},
            )
            assert extra.is_error
            submitted = await call("remote_submit", {"grant_key": KEY})
            assert submitted["run"]["state"] == "submitted"
            await call("remote_submit", {"grant_key": KEY})
            await call("remote_status", {"grant_key": KEY})
            for operation in ("retrieve", "attach"):
                started = await call("remote_" + operation, {"grant_key": KEY})
                assert started["work"]["state"] in {"queued", "running"}
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    # Control/status stays responsive while dedicated children run.
                    status = await asyncio.wait_for(
                        call("remote_status", {"grant_key": KEY}), timeout=2
                    )
                    matching = [item for item in status["work"] if item["operation"] == operation]
                    if matching and matching[-1]["state"] not in {"queued", "running"}:
                        assert matching[-1]["state"] == "succeeded"
                        break
                    await asyncio.sleep(0.1)
                else:
                    pytest.fail("Bounded asynchronous child did not finish")
            result = wb.project.list_results()[0]
            result_dto = await call("result", {"result_id": result["id"]})
            assert len(result_dto["measurements"]) == 2
            await call("result_view", {"result_id": result["id"]})
            args = {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "filename": "approved-result",
            }
            denied = await session.call_tool("export_result", args)
            assert denied.is_error
            wb.project.review(result["id"], result["revision_hash"], "reviewed")
            await call("export_result", args)
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            result = wb.project.list_results()[0]
            reopened = await session.call_tool("result", {"result_id": result["id"]})
            assert not reopened.is_error
            assert reopened.structured_content["result"]["review"]["disposition"] == "reviewed"

    asyncio.run(journey())
    profile = remote._profile_from_data(remote._load_profile(wb.project, "vanda")["data"])
    assert (Path(profile.remote_project_root) / "test-submit-count").read_text() == "1"
    assert len(wb.project.list_results()) == 1
    assert (export_root / "approved-result" / "manifest.json").is_file()


def test_private_stale_retrieval_never_becomes_published_on_revoke(tmp_path, monkeypatch):
    agent, wb, _, _, state, path, _, _ = fixture(tmp_path, monkeypatch)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")

    class RevokingTransport(LocalTransport):
        def retrieve_outputs(self, identity, destination, **kwargs):
            output = super().retrieve_outputs(identity, destination, **kwargs)
            path.write_bytes(path.read_bytes() + b" ")
            return output

    monkeypatch.setattr(
        remote, "_client_factory", lambda profile: RevokingTransport(profile, state)
    )
    with pytest.raises(PermissionError):
        perform_child(agent, wb, "retrieve")
    data = remote._load_run(wb.project, REQUEST_KEY)["data"]
    assert data["state"] == "finished"
    assert data["private_retrieval_directory"] is None
    assert (wb.project.root / ".remote-results" / (".agent-stage-" + REQUEST_KEY)).is_dir()
    assert wb.project.list_results() == []


@pytest.mark.skipif(os.name != "posix", reason="POSIX owned session test")
def test_owned_session_cancellation_stops_fixed_cli_descendant(tmp_path):
    import subprocess

    from loci_engine.agent_remote import terminate_owned_tree

    marker = tmp_path / "descendant-wrote"
    child = (
        "import time; from pathlib import Path; time.sleep(1); Path("
        + repr(str(marker))
        + ").write_text('late')"
    )
    parent = (
        "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',"
        + repr(child)
        + "]); time.sleep(5)"
    )
    process = subprocess.Popen([sys.executable, "-c", parent], start_new_session=True)
    time.sleep(0.2)
    terminate_owned_tree(process)
    process.wait(timeout=2)
    time.sleep(1.1)
    assert not marker.exists()


def test_remote_runtime_and_decoded_memory_cap_reject_before_array_staging(tmp_path, monkeypatch):
    from test_research_remote_results import _manifest_for, _mutate_task_archive, _rehash_result

    from loci_engine.research_remote_results import RemoteResultsError

    agent, wb, _, _, _, _, _, _ = fixture(tmp_path, monkeypatch)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    perform_child(agent, wb, "retrieve")
    data = remote._load_run(wb.project, REQUEST_KEY)["data"]
    manifest = remote._manifest_from_run(data)
    archive = Path(data["private_retrieval_directory"]) / "results.zip"

    def mutate(record, _members):
        record["result"]["provenance"]["runtime"]["numpy"] = "unapproved"
        _rehash_result(record)

    malicious = tmp_path / "mutated-runtime.zip"
    _mutate_task_archive(archive, malicious, mutate)
    changed = _manifest_for(malicious, manifest.request_sha256)
    mapping = {data["source_ids"][0]: data["source_ids"][0]}
    with pytest.raises(RemoteResultsError, match="runtime"):
        attach_remote_results(
            wb.project,
            remote._request_bytes(data),
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping=mapping,
            publication_guard=agent.policy.recheck,
        )
    with pytest.raises(RemoteResultsError, match="memory envelope"):
        attach_remote_results(
            wb.project,
            remote._request_bytes(data),
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping=mapping,
            publication_guard=agent.policy.recheck,
            max_decoded_bytes=100,
        )
    assert list(wb.project.arrays.iterdir()) == []
    assert wb.project.list_results() == []


def test_independent_child_rejects_same_content_policy_replacement(tmp_path, monkeypatch):
    from loci_engine.research_cli import execute, parser

    agent, wb, _, _, _, path, _, _ = fixture(tmp_path, monkeypatch)
    policy = agent.policy
    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(path.read_bytes())
    replacement.chmod(0o600)
    os.replace(replacement, path)
    arguments = [
        "agent-remote",
        "--project",
        str(wb.project.root),
        "--job",
        "b" * 32,
        "--operation",
        "retrieve",
        "--grant-key",
        KEY,
        "--policy",
        str(path),
        "--policy-sha256",
        policy.content_sha256,
        "--policy-file-identity",
        ":".join(map(str, policy.file_identity)),
        "--project-directory-identity",
        ":".join(map(str, policy.project_directory_identity)),
        "--export-directory-identity",
        ":".join(map(str, policy.export_root_identity)),
    ]
    with pytest.raises(PermissionError, match="filesystem identities"):
        execute(parser().parse_args(arguments))
    assert wb.project.list_results() == []


def test_opaque_grant_never_accepts_arbitrary_retrieval_locator(tmp_path, monkeypatch):
    agent, wb, _, _, state, _, _, _ = fixture(tmp_path, monkeypatch)
    envelope = remote._load_run(wb.project, REQUEST_KEY)
    changed = {**envelope["data"], "private_retrieval_directory": str(tmp_path)}
    remote._put(wb.project, envelope, changed)
    with pytest.raises(PermissionError, match="locator"):
        agent.remote_operation(KEY, "submit")
    assert state.submit_calls == 0


def test_cancel_remains_responsive_for_pending_local_adoption(tmp_path, monkeypatch):
    agent, wb, _, _, state, _, _, _ = fixture(tmp_path, monkeypatch)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    perform_child(agent, wb, "retrieve")
    job = wb.project.submit(
        "agent_remote_attach",
        {"grant_key": KEY, "policy_sha256": agent.policy.content_sha256},
        "agent-remote:" + agent.policy.content_sha256 + ":attach",
    )
    dto = agent.remote_operation(KEY, "cancel")
    assert dto["run"]["cancel_requested"] is True
    assert wb.project.job(job["id"])["state"] == "cancelled"
    assert state.cancelled is False  # Finished scheduler work needs no cancellation.
    with pytest.raises((PermissionError, RuntimeError)):
        perform_child(agent, wb, "attach")
    assert wb.project.list_results() == []


def test_supervisor_revocation_terminates_owned_child_and_descendant(tmp_path, monkeypatch):
    from loci_engine import agent_remote

    agent, wb, _, _, _, path, _, _ = fixture(tmp_path, monkeypatch)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    perform_child(agent, wb, "retrieve")
    ready = tmp_path / "child-started"
    late = tmp_path / "late-transfer"
    runner = tmp_path / "fixed_slow_child.py"
    descendant = (
        "import time;from pathlib import Path;time.sleep(1);Path("
        + repr(str(late))
        + ").write_text('late')"
    )
    runner.write_text(
        "import os,sys,time,subprocess\n"
        "from pathlib import Path\n"
        "from loci_engine.research_project import ResearchProject\n"
        "p=ResearchProject(sys.argv[1]);j=sys.argv[2]\n"
        "p.update_job(j,expected_state='queued',state='running',pid=os.getpid())\n"
        "subprocess.Popen([sys.executable,'-c',"
        + repr(descendant)
        + "])\nPath("
        + repr(str(ready))
        + ").write_text('ready')\ntime.sleep(5)\n"
    )

    def fixed_command(arguments):
        assert arguments[0] == "agent-remote"
        assert "--policy-file-identity" in arguments
        return [
            sys.executable,
            str(runner),
            arguments[arguments.index("--project") + 1],
            arguments[arguments.index("--job") + 1],
        ]

    monkeypatch.setattr(agent_remote, "research_command", fixed_command)
    agent.remote_operation(KEY, "attach")
    deadline = time.monotonic() + 3
    while not ready.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert ready.exists()
    path.write_bytes(path.read_bytes() + b" ")
    job = [item for item in wb.project.list_jobs() if item["operation"] == "agent_remote_attach"][0]
    deadline = time.monotonic() + 3
    while (
        wb.project.job(job["id"])["state"] in {"queued", "running"} and time.monotonic() < deadline
    ):
        time.sleep(0.05)
    assert wb.project.job(job["id"])["state"] == "cancelled"
    time.sleep(1.1)
    assert not late.exists()
    assert wb.project.list_results() == []


class DormantThread:
    def __init__(self, *args, **kwargs):
        pass

    def start(self):
        pass


class PendingProcess:
    pid = 99999999

    def poll(self):
        return None


def test_pending_owned_children_reserve_capacity_before_durable_claim(tmp_path, monkeypatch):
    from loci_engine import agent_remote

    agent, wb, _, request, _, _, _, _ = fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(agent_remote.threading, "Thread", DormantThread)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    spawned = []

    def spawn(*args, **kwargs):
        spawned.append(args[0])
        return PendingProcess()

    monkeypatch.setattr(agent_remote.subprocess, "Popen", spawn)
    first = agent.remote_operation(KEY, "retrieve")
    assert first["work"]["state"] == "queued"
    # The owned parent has not claimed its durable queued job yet.
    assert not any(job["state"] == "running" for job in wb.project.list_jobs())
    with pytest.raises(PermissionError, match="concurrency"):
        agent.remote_operation(KEY, "attach")
    with pytest.raises(PermissionError, match="concurrency"):
        agent.submit_recipe(request, "b" * 32)
    assert len(spawned) == 1
    wb.close()


def test_cancel_request_retains_capacity_and_polling_until_confirmed_terminal(
    tmp_path, monkeypatch
):
    from loci_engine import agent_remote
    from loci_engine.remote_compute import RemoteJobStatus

    agent, wb, _, request, state, path, _, _ = fixture(tmp_path, monkeypatch)
    scheduler_state = ["running"]
    queries = []

    class StillRunningTransport(LocalTransport):
        def status(self, identity):
            queries.append(identity)
            return RemoteJobStatus(identity, scheduler_state[0], "synthetic scheduler state")

    monkeypatch.setattr(
        remote, "_client_factory", lambda profile: StillRunningTransport(profile, state)
    )
    monkeypatch.setattr(agent_remote.threading, "Thread", DormantThread)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    agent.remote_operation(KEY, "cancel")
    assert remote._load_run(wb.project, REQUEST_KEY)["data"]["state"] == "cancel_requested"
    assert agent_remote.active_remote_count(agent.policy, wb.project) == 1
    # A restarted agent must also retain the unconfirmed reservation.
    restarted = PolicyAgent(load_policy(path))
    with pytest.raises(PermissionError, match="concurrency"):
        restarted.submit_recipe(request, "b" * 32)
    with pytest.raises(PermissionError, match="concurrency"):
        restarted.remote_operation(KEY, "retrieve")
    before = len(queries)
    restarted.remote_operation(KEY, "status")
    assert len(queries) == before + 1
    assert agent_remote.active_remote_count(agent.policy, wb.project) == 1
    scheduler_state[0] = "unknown"
    restarted.remote_operation(KEY, "status")
    assert agent_remote.active_remote_count(agent.policy, wb.project) == 1
    scheduler_state[0] = "finished"
    restarted.remote_operation(KEY, "status")
    assert agent_remote.active_remote_count(agent.policy, wb.project) == 0
    spawned = []

    def spawn(*args, **kwargs):
        spawned.append(args[0])
        return PendingProcess()

    restarted.supervisor._popen = spawn
    restarted.submit_recipe(request, "c" * 32)
    assert len(spawned) == 1
    assert len({item.remote_job_id for item in queries}) == 1
    wb.close()


@pytest.mark.parametrize("change", ["oversized", "same_size_new_hash"])
def test_refetched_transfer_manifest_is_pinned_before_any_copy(tmp_path, monkeypatch, change):
    from loci_engine import agent_remote
    from loci_engine.remote_compute import (
        CommandResult,
        OutputEntry,
        RemoteComputeClient,
        VerifiedOutputManifest,
    )

    agent, wb, _, _, state, _, _, _ = fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(agent_remote.threading, "Thread", DormantThread)
    agent.remote_operation(KEY, "submit")
    agent.remote_operation(KEY, "status")
    transferred = []
    cap = agent.policy.remote_grants[KEY]["max_output_bytes"]

    class Transfer:
        def run(self, arguments, **kwargs):
            transferred.append(arguments)
            pytest.fail("Changed manifest must be rejected before invoking SCP")

    class ChangingManifestClient(LocalTransport):
        retrieve_outputs = RemoteComputeClient.retrieve_outputs
        _scp_prefix = RemoteComputeClient._scp_prefix

        def __init__(self, profile):
            super().__init__(profile, state)
            self.runner = Transfer()
            self.fetches = 0

        def fetch_output_manifest(self, identity):
            original = super().fetch_output_manifest(identity)
            self.fetches += 1
            if self.fetches == 1:
                return original
            entry = original.entries[0]
            return VerifiedOutputManifest(
                identity.request_key,
                identity.request_sha256,
                (
                    OutputEntry(
                        "results.zip",
                        "d" * 64,
                        cap + 1 if change == "oversized" else entry.size_bytes,
                        "application/zip",
                    ),
                ),
            )

        def _ssh(self, *args, **kwargs):
            return CommandResult(0, "", "")

    monkeypatch.setattr(remote, "_client_factory", ChangingManifestClient)
    with pytest.raises(remote.ResearchRemoteError, match="bounded manifest verification"):
        perform_child(agent, wb, "retrieve")
    assert transferred == []
    assert remote._load_run(wb.project, REQUEST_KEY)["data"]["state"] == "finished"
    assert wb.project.list_results() == []
    wb.close()
