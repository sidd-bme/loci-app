import copy
import json
from dataclasses import asdict

import pytest
from test_research_remote import (
    LocalTransport,
    TransportState,
    _profile_request,
    _project,
    _stage_request,
)

from loci_engine import research_remote as remote
from loci_engine.models import CellposeSettings
from loci_engine.remote_compute import RemoteJobStatus
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def setup(tmp_path, monkeypatch):
    project, workbench, source = _project(tmp_path)
    state = TransportState()
    monkeypatch.setattr(remote, "_client_factory", lambda profile: LocalTransport(profile, state))
    profile = _profile_request(tmp_path)
    workbench.execute("remote_profile_save", profile)
    native = _stage_request(source["id"], "a" * 32)["tasks"][0]
    analysis = {
        "project_id": project.meta["project_id"],
        "alias": "vanda",
        "request_key": "a" * 32,
        "device": "cpu",
        "allow_cpu_fallback": False,
        "rights_basis": None,
        "tasks": [
            {
                "operation": "run_recipe",
                "source": {"id": source["id"], "sha256": source["sha256"]},
                "request": {key: value for key, value in native.items() if key != "task_id"},
            }
        ],
    }
    plan = workbench.execute("remote_analysis_plan", analysis)["plan"]
    authorized = {
        "analysis": analysis,
        "plan_sha256": plan["plan_sha256"],
        "transfer_authorized": True,
        "retrieval_authorized": True,
        "attachment_authorized": True,
    }
    return project, workbench, source, state, profile, plan, authorized


def advance(workbench):
    return workbench.execute(
        "remote_analysis_advance",
        {
            "project_id": workbench.project.meta["project_id"],
            "alias": "vanda",
            "request_key": "a" * 32,
        },
    )["run"]


def test_one_click_analysis_preserves_numerical_result_and_recovers_after_reopen(
    tmp_path, monkeypatch
):
    project, workbench, source, state, _, plan, authorized = setup(tmp_path, monkeypatch)
    assert plan["transfer_bytes"] == source["size_bytes"]
    assert plan["transfer_scope"] == "whole-registered-files"
    assert str(tmp_path) not in json.dumps(plan)
    assert remote._runs(project) == [] and state.submit_calls == 0
    run = workbench.execute("remote_analysis_start", authorized)["run"]
    assert run["automatic"] is True and run["state"] == "submitted"
    root = project.root
    workbench.close()
    reopened = Workbench(ResearchProject(root))
    assert advance(reopened)["state"] == "finished"
    assert advance(reopened)["state"] == "retrieved"
    attached = advance(reopened)
    assert attached["state"] == "attached"
    result_id = attached["attachment"]["task_results"][0]["local_result_id"]
    result = reopened.project.result(result_id)
    assert len(result["provenance"]["measurements"]) == 2
    assert sum(row["measure"] for row in result["provenance"]["measurements"]) == 18
    assert reopened.project.review_state(result_id) is None
    assert advance(reopened)["attachment"] == attached["attachment"]
    assert reopened.execute("remote_analysis_start", authorized)["run"]["state"] == "attached"
    assert state.submit_calls == 1


def test_lost_submission_response_reuses_the_same_run_and_canonical_request(tmp_path, monkeypatch):
    project, workbench, _, state, _, _, authorized = setup(tmp_path, monkeypatch)
    state.fail_submit_once = True
    with pytest.raises(RuntimeError, match="lost submission"):
        workbench.execute("remote_analysis_start", authorized)
    saved = remote._runs(project)[0]["data"]
    assert saved["state"] == "staged" and saved["automation"]["retrieval_authorized"] is True
    original_bytes = saved["private_request_b64"]
    assert advance(workbench)["state"] == "submitted"
    assert remote._runs(project)[0]["data"]["private_request_b64"] == original_bytes
    assert len(remote._runs(project)) == 1


@pytest.mark.parametrize("attack", ["source", "method", "profile", "permission", "key"])
def test_changed_plan_is_rejected_before_transfer_or_submission(tmp_path, monkeypatch, attack):
    project, workbench, _, state, profile, _, authorized = setup(tmp_path, monkeypatch)
    if attack == "source":
        authorized["analysis"]["tasks"][0]["source"]["sha256"] = "f" * 64
    elif attack == "method":
        authorized["analysis"]["tasks"][0]["request"]["recipe"]["segmentation"]["threshold"] = 75
    elif attack == "profile":
        profile["expected_revision"] = 1
        profile["resources"]["cpus"] = 4
        workbench.execute("remote_profile_save", profile)
    elif attack == "key":
        authorized["analysis"]["request_key"] = "b" * 32
    else:
        authorized["retrieval_authorized"] = False
    with pytest.raises((ValueError, PermissionError)):
        workbench.execute("remote_analysis_start", authorized)
    assert remote._runs(project) == [] and state.submit_calls == 0


def test_cancelled_run_cannot_automatically_retrieve_or_attach(tmp_path, monkeypatch):
    project, workbench, _, _, _, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    workbench.execute("remote_cancel", {"alias": "vanda", "request_key": "a" * 32})
    cancelled = advance(workbench)
    assert cancelled["cancel_requested"] is True
    assert cancelled["state"] == "cancelled" and cancelled["remote_state"] == "finished"
    assert project.list_results() == []
    assert not (project.root / ".remote-results").exists()


@pytest.mark.parametrize("lost_at", ["connection", "response"])
def test_cancel_intent_survives_connection_loss_and_reopen_until_confirmed(
    tmp_path, monkeypatch, lost_at
):
    project, workbench, _, state, _, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    cancel_calls, status_calls = [], []
    connection_lost = lost_at == "connection"
    response_lost = lost_at == "response"

    class CancelTransport(LocalTransport):
        def test_connection(self):
            nonlocal connection_lost
            if connection_lost:
                connection_lost = False
                raise RuntimeError("fixture lost connection")
            return super().test_connection()

        def cancel(self, identity):
            nonlocal response_lost
            cancel_calls.append(identity)
            if response_lost:
                response_lost = False
                raise RuntimeError("fixture lost response")
            state.cancelled = True

        def status(self, identity):
            status_calls.append(identity)
            return RemoteJobStatus(identity, "failed" if state.cancelled else "running", "fixture")

    monkeypatch.setattr(remote, "_client_factory", lambda profile: CancelTransport(profile, state))
    bound = {"project_id": project.meta["project_id"], "alias": "vanda", "request_key": "a" * 32}
    with pytest.raises(RuntimeError, match="fixture lost"):
        workbench.execute("remote_analysis_cancel", bound)
    saved = remote._load_run(project, "a" * 32)["data"]
    assert saved["cancel_requested"] is True and saved["state"] == "cancel_requested"
    assert saved.get("cancel_sent_at") is None
    workbench.close()
    reopened = Workbench(ResearchProject(project.root))
    assert advance(reopened)["state"] == "cancel_requested"
    assert state.cancelled is True
    assert remote._load_run(reopened.project, "a" * 32)["data"]["cancel_sent_at"]
    confirmed = advance(reopened)
    assert confirmed["state"] == "cancelled" and confirmed["remote_state"] == "failed"
    assert len(cancel_calls) == (1 if lost_at == "connection" else 2)
    assert all(
        item.remote_job_id == "123.fixture" and item.request_key == "a" * 32
        for item in cancel_calls
    )
    assert len(status_calls) == 2 and state.submit_calls == 1
    monkeypatch.setattr(
        remote, "_client_factory", lambda _: pytest.fail("Terminal cancellation must not reconnect")
    )
    assert advance(reopened) == confirmed
    assert reopened.execute("remote_analysis_cancel", bound)["run"] == confirmed
    assert reopened.project.list_results() == []
    assert not (reopened.project.root / ".remote-results").exists()


def test_cancel_confirmation_recovers_a_saved_terminal_scheduler_status(tmp_path, monkeypatch):
    project, workbench, _, _, _, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    workbench.execute("remote_cancel", {"alias": "vanda", "request_key": "a" * 32})
    workbench.execute("remote_status", {"alias": "vanda", "request_key": "a" * 32})
    monkeypatch.setattr(remote, "_client_factory", lambda _: pytest.fail("Status already terminal"))
    cancelled = advance(workbench)
    assert cancelled["state"] == "cancelled" and cancelled["remote_state"] == "finished"
    assert project.list_results() == []


def test_profile_edit_preserves_the_original_execution_target_during_recovery(
    tmp_path, monkeypatch
):
    project, workbench, _, state, profile, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    original_output = profile["remote_output_root"]
    connections = []

    def connect(saved):
        connections.append(saved)
        return LocalTransport(saved, state)

    monkeypatch.setattr(remote, "_client_factory", connect)
    profile["expected_revision"] = 1
    profile["remote_output_root"] += "-changed"
    profile["resources"]["cpus"] = 4
    workbench.execute("remote_profile_save", profile)
    assert workbench.execute("remote_analysis_start", authorized)["run"]["state"] == "submitted"
    assert advance(workbench)["state"] == "finished"
    assert advance(workbench)["state"] == "retrieved"
    attached = advance(workbench)
    assert attached["state"] == "attached" and len(project.list_results()) == 1
    assert connections and all(item.remote_output_root == original_output for item in connections)
    assert attached["resources"]["cpus"] != profile["resources"]["cpus"]
    assert state.submit_calls == 1
    assert "private_profile_snapshot" not in attached


def test_changed_execution_snapshot_is_rejected_before_reconnection(tmp_path, monkeypatch):
    project, workbench, _, _, _, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    envelope = remote._load_run(project, "a" * 32)
    data = copy.deepcopy(envelope["data"])
    data["private_profile_snapshot"]["private_profile"]["remote_output_root"] += "-forged"
    remote._put(project, envelope, data)
    monkeypatch.setattr(remote, "_client_factory", lambda _: pytest.fail("Must not reconnect"))
    with pytest.raises(remote.ResearchRemoteError, match="Saved profile changed"):
        advance(workbench)


def test_interrupted_transfer_uses_its_snapshot_and_portable_copy_cannot_resume(
    tmp_path, monkeypatch
):
    import zipfile

    from loci_engine.research_interchange import export_project, import_project

    project, workbench, _, state, profile, _, authorized = setup(tmp_path, monkeypatch)

    class Interrupted(LocalTransport):
        def stage(self, manifest):
            raise RuntimeError("fixture interrupted transfer")

    monkeypatch.setattr(remote, "_client_factory", lambda saved: Interrupted(saved, state))
    with pytest.raises(RuntimeError, match="interrupted transfer"):
        workbench.execute("remote_analysis_start", authorized)
    original = remote._load_run(project, "a" * 32)["data"]
    assert original["state"] == "prepared"
    profile["expected_revision"] = 1
    profile["runtime_python"] += "-changed"
    workbench.execute("remote_profile_save", profile)
    monkeypatch.setattr(remote, "_client_factory", lambda saved: LocalTransport(saved, state))
    assert advance(workbench)["state"] == "staged"
    assert advance(workbench)["state"] == "submitted"
    archive = tmp_path / "interrupted.zip"
    export_project(project, archive)
    with zipfile.ZipFile(archive) as incoming:
        run = json.loads(incoming.read(f"documents/policy/{remote._run_id('a' * 32)}.json"))
        assert "private_profile_snapshot" not in run["data"]
        assert str(tmp_path) not in json.dumps(run)
        assert run["data"]["cancel_requested"] is True
    restored = Workbench(import_project(archive, tmp_path / "restored"))
    with pytest.raises((PermissionError, remote.ResearchRemoteError)):
        advance(restored)
    assert restored.project.list_results() == []


def test_cancellation_during_array_staging_prevents_atomic_result_publication(
    tmp_path, monkeypatch
):
    project, workbench, _, _, _, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    advance(workbench)
    advance(workbench)
    original = project.store_array

    def cancel_before_publication(array):
        artifact = original(array)
        workbench.execute(
            "remote_analysis_cancel",
            {"project_id": project.meta["project_id"], "alias": "vanda", "request_key": "a" * 32},
        )
        return artifact

    monkeypatch.setattr(project, "store_array", cancel_before_publication)
    with pytest.raises(remote.ResearchRemoteError, match="cancelled or changed"):
        advance(workbench)
    assert project.list_results() == []


def test_detached_source_does_not_prevent_status_but_prevents_attachment(tmp_path, monkeypatch):
    project, workbench, source, _, _, _, authorized = setup(tmp_path, monkeypatch)
    workbench.execute("remote_analysis_start", authorized)
    from pathlib import Path

    path = Path(project.source(source["id"])["private_path"])
    saved = path.with_suffix(".temporarily-detached")
    path.rename(saved)
    assert advance(workbench)["state"] == "finished"
    assert advance(workbench)["state"] == "retrieved"
    with pytest.raises(RuntimeError, match="source"):
        advance(workbench)
    assert project.list_results() == []
    saved.rename(path)
    assert advance(workbench)["state"] == "attached"


def test_manual_remote_run_cannot_acquire_retrieval_authority_by_advancing(tmp_path, monkeypatch):
    _, workbench, source, _, _, _, _ = setup(tmp_path, monkeypatch)
    workbench.execute("remote_stage", _stage_request(source["id"], "a" * 32))
    with pytest.raises(PermissionError, match="no matching"):
        advance(workbench)


def test_cellpose_plan_binds_registered_identity_and_explicit_remote_device(tmp_path, monkeypatch):
    _, workbench, source, state, profile, _, authorized = setup(tmp_path, monkeypatch)
    profile["expected_revision"] = 1
    profile["resources"].update(gpus=1, memory_mb=4096)
    workbench.execute("remote_profile_save", profile)
    request = copy.deepcopy(authorized["analysis"])
    request.update(device="cuda", rights_basis="noncommercial-research")
    task = request["tasks"][0]
    task["operation"] = "cellpose_run"
    task["request"] = {
        "source_id": source["id"],
        "selection": task["request"]["selection"],
        "profile_id": "cellpose-sam-v2",
        "settings": asdict(CellposeSettings()),
        "measurement_channels": [0],
        "working_bytes": 256 * 1024**2,
    }
    plan = workbench.execute("remote_analysis_plan", request)["plan"]
    assert plan["models"][0]["requested_device"] == "cuda"
    assert plan["models"][0]["settings"]["device"] == "cuda"
    assert plan["models"][0]["allow_cpu_fallback"] is False
    assert plan["models"][0]["artifact_id"] == "cpsam_v2"
    assert state.submit_calls == 0
    request["rights_basis"] = "unverified"
    with pytest.raises((ValueError, remote.ResearchRemoteError)):
        workbench.execute("remote_analysis_plan", request)
