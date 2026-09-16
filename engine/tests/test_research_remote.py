from __future__ import annotations

import base64
import hashlib
import json
import shutil
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
import tifffile

import loci_engine.research_remote as service
from loci_engine.cellpose_backend import CELLPOSE_PACKAGE_VERSION, resolve_cellpose_model_spec
from loci_engine.models import CellposeSettings
from loci_engine.remote_compute import (
    ConnectionReceipt,
    RemoteCleanupReceipt,
    RemoteJobIdentity,
    RemoteJobStatus,
    verify_output_manifest,
)
from loci_engine.remote_worker import run_manifest
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_remote import ResearchRemoteError, execute_remote
from loci_engine.workbench import Workbench

FINGERPRINT = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
TASK_ID = "d" * 32


def test_diagnostics_redact_wrapped_scheduler_paths_and_unconfigured_home_paths():
    raw = (
        "Job Id: 123.fixture\n    Error_Path = login:/scratch/owner/loci-qualifi\n"
        "\tcation/output/error.log\n    Variable_List = PBS_O_HOME=/home/owner,\n"
        "\tPBS_O_PATH=/usr/bin:/opt/pbs/bin\n    comment = Insufficient node_pool\n"
        "File C:\\private\\patient.tif failed\n"
    )
    redacted = service._redacted_remote_text(raw, None, limit=4096)
    assert "123.fixture" in redacted
    assert "Insufficient node_pool" in redacted
    assert "\n    Variable_List = " in redacted
    assert "\n    comment = Insufficient node_pool\n" in redacted
    for private in (
        "/scratch",
        "/home",
        "/usr/bin",
        "/opt/pbs",
        "patient.tif",
        "owner",
        "error.log",
    ):
        assert private not in redacted
    assert "[remote-path]" in redacted


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


@dataclass
class TransportState:
    submit_calls: int = 0
    fail_submit_once: bool = False
    mismatched_identity: bool = False
    cancelled: bool = False
    cleanup_calls: int = 0
    fail_cleanup_once: bool = False


class LocalTransport:
    def __init__(self, profile, state: TransportState):
        self.profile = profile
        self.state = state

    def test_connection(self) -> ConnectionReceipt:
        return ConnectionReceipt(
            self.profile.alias,
            self.profile.host_key_sha256,
            "Linux",
            "Python 3.12 fixture",
            self.profile.scheduler,
            "PBS fixture",
        )

    def setup_roots(self) -> None:
        Path(self.profile.remote_project_root).mkdir(parents=True, exist_ok=True)
        Path(self.profile.remote_output_root).mkdir(parents=True, exist_ok=True)

    def test_runtime(self) -> str:
        return "usage: loci-research remote-worker"

    def reserve(self, request) -> RemoteJobIdentity:
        staging = Path(self.profile.run_root(request.request_key))
        output = Path(self.profile.output_root(request.request_key))
        staging.mkdir(parents=True, exist_ok=True)
        output.mkdir(parents=True, exist_ok=True)
        marker = _canonical(
            {
                "schema": "loci.remote-run/v1",
                "request_key": request.request_key,
                "request_sha256": request.request_sha256,
            }
        )
        (staging / ".loci-owned.json").write_bytes(marker)
        (output / ".loci-owned.json").write_bytes(marker)
        return RemoteJobIdentity(
            request.request_key,
            request.request_sha256,
            self.profile.scheduler,
            None,
            "reserved",
        )

    def stage(self, manifest) -> str:
        staging = Path(self.profile.run_root(manifest.request_key))
        for entry in manifest.entries:
            target = staging.joinpath(*Path(entry.remote_relative_path).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(entry.local_path, target)
        return hashlib.sha256(manifest.encoded()).hexdigest()

    def stage_request_and_script(self, request, request_document: bytes) -> tuple[str, str]:
        staging = Path(self.profile.run_root(request.request_key))
        (staging / "request.json").write_bytes(request_document)
        return request.request_sha256, hashlib.sha256(b"fixed-script").hexdigest()

    def submit(self, request) -> RemoteJobIdentity:
        self.state.submit_calls += 1
        output = Path(self.profile.output_root(request.request_key))
        if not (output / "output-manifest.json").exists():
            run_manifest(Path(self.profile.run_root(request.request_key)) / "request.json")
        if self.state.fail_submit_once and self.state.submit_calls == 1:
            raise RuntimeError("fixture lost submission response")
        digest = "f" * 64 if self.state.mismatched_identity else request.request_sha256
        return RemoteJobIdentity(
            request.request_key,
            digest,
            self.profile.scheduler,
            "123.fixture",
            "submitted",
        )

    def status(self, identity) -> RemoteJobStatus:
        return RemoteJobStatus(
            RemoteJobIdentity(
                identity.request_key,
                identity.request_sha256,
                identity.scheduler,
                identity.remote_job_id,
                "finished",
            ),
            "finished",
            "fixture worker completed",
        )

    def cancel(self, _identity) -> None:
        self.state.cancelled = True

    def fetch_output_manifest(self, identity):
        path = Path(self.profile.output_root(identity.request_key)) / "output-manifest.json"
        return verify_output_manifest(path.read_text(), identity)

    def retrieve_outputs(self, identity, destination: Path) -> tuple[Path, ...]:
        manifest = self.fetch_output_manifest(identity)
        destination.mkdir(mode=0o700)
        outputs = []
        for entry in manifest.entries:
            source = Path(self.profile.output_root(identity.request_key)) / entry.relative_path
            target = destination.joinpath(*Path(entry.relative_path).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            outputs.append(target)
        return tuple(outputs)

    def logs(self, _identity, *, stderr=False, limit=64 * 1024) -> str:
        return ("fixture stderr" if stderr else "fixture stdout")[:limit]

    def cleanup(self, identity) -> RemoteCleanupReceipt:
        self.state.cleanup_calls += 1
        if self.state.fail_cleanup_once and self.state.cleanup_calls == 1:
            raise RuntimeError("fixture lost cleanup response")
        return RemoteCleanupReceipt(
            identity.request_key,
            identity.request_sha256,
            identity.scheduler,
            identity.remote_job_id,
            2,
            "cleaned",
        )


def _project(tmp_path: Path) -> tuple[ResearchProject, Workbench, dict]:
    source = tmp_path / "source.ome.tif"
    image = np.zeros((16, 16), dtype=np.uint16)
    image[2:5, 2:5] = 100
    image[10:13, 10:13] = 200
    tifffile.imwrite(source, image, ome=True, metadata={"axes": "YX"})
    project = ResearchProject.create(tmp_path / "study.loci-study", "Remote fixture")
    workbench = Workbench(project)
    imported = workbench.import_native(str(source), name="Exact source")
    return project, workbench, imported


def _profile_request(tmp_path: Path) -> dict:
    known_hosts = tmp_path / "known_hosts"
    known_hosts.write_text("fixture ssh-ed25519 AAAA\n")
    remote_project = tmp_path / "mock-remote" / "project-root"
    remote_output = tmp_path / "mock-remote" / "output-root"
    remote_project.mkdir(parents=True, exist_ok=True)
    remote_output.mkdir(parents=True, exist_ok=True)
    return {
        "alias": "vanda",
        "known_host": "vanda.fixture.example",
        "known_hosts_file": str(known_hosts),
        "host_key_sha256": FINGERPRINT,
        "runtime_python": "/opt/loci/runtime/bin/python",
        "remote_project_root": str(remote_project),
        "remote_output_root": str(remote_output),
        "scheduler": "pbspro",
        "scheduler_bin_dir": None,
        "identity_file": None,
        "queue": "batch",
        "account": None,
        "pbs_gpu_resource": None,
        "allow_direct_compute": False,
        "remote_input_roots": [],
        "connect_timeout_seconds": 10,
        "resources": {"cpus": 2, "memory_mb": 256, "wall_minutes": 10, "gpus": 0},
        "expected_revision": 0,
    }


def _stage_request(source_id: str, request_key: str) -> dict:
    return {
        "alias": "vanda",
        "request_key": request_key,
        "sources": [{"source_id": source_id}],
        "tasks": [
            {
                "task_id": TASK_ID,
                "source_id": source_id,
                "selection": {
                    "x": 0,
                    "y": 0,
                    "width": 16,
                    "height": 16,
                    "t": 0,
                    "c": 0,
                    "z": 0,
                    "level": 0,
                },
                "recipe": {
                    "steps": [],
                    "segmentation": {"method": "components", "threshold": 50},
                    "measurement_channels": [0],
                    "gates": [],
                    "working_bytes": 8 * 1024 * 1024,
                },
            }
        ],
        "transfer_authority": {
            "approved": True,
            "scope": "remote-run-recipe",
            "destination_alias": "vanda",
            "source_ids": [source_id],
        },
    }


def _stage_cellpose_request(source_id: str, request_key: str) -> dict:
    spec = resolve_cellpose_model_spec("cellpose-sam-v2")
    request = _stage_request(source_id, request_key)
    request["tasks"] = [
        {
            "task_id": TASK_ID,
            "source_id": source_id,
            "operation": "run_cellpose",
            "selection": request["tasks"][0]["selection"],
            "cellpose": {
                "profile_id": spec.profile_id,
                "package_version": CELLPOSE_PACKAGE_VERSION,
                "artifact_id": spec.artifact_id,
                "model_sha256": spec.sha256,
                "model_size_bytes": spec.size_bytes,
                "requested_device": "cuda",
                "allow_cpu_fallback": False,
                "rights_basis": "noncommercial-research",
                "settings": CellposeSettings(device="cuda").to_dict(),
                "measurement_channels": [0],
                "gates": [],
                "working_bytes": 8 * 1024 * 1024,
            },
        }
    ]
    return request


def _install_fake_cellpose(monkeypatch: pytest.MonkeyPatch) -> None:
    from loci_engine import cellpose_backend

    spec = resolve_cellpose_model_spec("cellpose-sam-v2")
    monkeypatch.setattr(
        cellpose_backend,
        "get_cellpose_status",
        lambda _profile: types.SimpleNamespace(
            ready=True,
            installed_version=CELLPOSE_PACKAGE_VERSION,
            model_verified=True,
            model_spec=spec,
        ),
    )
    labels = np.zeros((16, 16), dtype=np.int32)
    labels[2:5, 2:5] = 1
    monkeypatch.setattr(
        cellpose_backend,
        "segment_cellpose",
        lambda _image, _settings, _profile: types.SimpleNamespace(
            output=types.SimpleNamespace(
                labels=labels,
                normalized=np.zeros((16, 16), dtype=np.float64),
                count=1,
            ),
            runtime={
                "package": {"name": "cellpose", "version": CELLPOSE_PACKAGE_VERSION},
                "model": {"artifact_id": spec.artifact_id, "sha256": spec.sha256},
                "profile_id": spec.profile_id,
                "preprocessing_mode": "dynamic-range-preserving",
                "requested_device": "cuda",
                "resolved_device": "cuda",
                "fallback_reason": None,
                "memory_preflight": {"device": "cuda", "available_bytes": 8 * 1024**3},
                "inference_scale": 1.0,
            },
        ),
    )
    fake_torch = types.ModuleType("torch")
    fake_torch.__version__ = "2.9.0"  # type: ignore[attr-defined]
    fake_torch.version = types.SimpleNamespace(cuda="12.8")  # type: ignore[attr-defined]
    fake_torch.backends = types.SimpleNamespace(  # type: ignore[attr-defined]
        cudnn=types.SimpleNamespace(version=lambda: 91002)
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


def _install_transport(monkeypatch: pytest.MonkeyPatch, state: TransportState) -> None:
    monkeypatch.setattr(service, "_client_factory", lambda profile: LocalTransport(profile, state))


def _save_and_stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    state: TransportState,
    request_key: str,
) -> tuple[ResearchProject, Workbench, dict]:
    project, workbench, source = _project(tmp_path)
    _install_transport(monkeypatch, state)
    execute_remote(workbench, "profile_save", _profile_request(tmp_path))
    execute_remote(workbench, "readiness", {"alias": "vanda"})
    staged = execute_remote(workbench, "stage", _stage_request(source["id"], request_key))
    return project, workbench, staged


def test_profile_dto_redacts_manual_paths_and_uses_fixed_saved_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, workbench, _source = _project(tmp_path)
    _install_transport(monkeypatch, TransportState())
    profile_request = _profile_request(tmp_path)

    saved = execute_remote(workbench, "profile_save", profile_request)["profile"]
    tested = execute_remote(workbench, "profile_test", {"alias": "vanda"})["profile"]
    listed = execute_remote(workbench, "profile_list", {})["profiles"]

    assert listed == [tested]
    assert saved["resources"] == profile_request["resources"]
    encoded = canonical_json({"saved": saved, "tested": tested})
    assert str(tmp_path) not in encoded
    assert "known_hosts_file" not in encoded
    assert "remote_project_root" not in encoded
    internal = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.PROFILE_SCHEMA
    ][0]
    assert (
        internal["data"]["private_profile"]["remote_project_root"]
        == profile_request["remote_project_root"]
    )
    workbench.close()


def test_complete_remote_lifecycle_preserves_request_and_attachment_parity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "a" * 32
    state = TransportState()
    project, workbench, staged = _save_and_stage(tmp_path, monkeypatch, state, key)
    assert staged["run"]["state"] == "staged"
    workbench.close()
    workbench = Workbench(project)
    assert execute_remote(workbench, "run_list", {})["runs"] == [staged["run"]]
    repeated_stage = execute_remote(
        workbench,
        "stage",
        _stage_request(staged["run"]["source_ids"][0], key),
    )
    assert repeated_stage == staged
    assert (
        len(
            [
                item
                for item in project.documents("policy")
                if item["data"].get("schema") == service.RUN_SCHEMA
            ]
        )
        == 1
    )
    submitted = execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})
    assert submitted["run"]["state"] == "submitted"
    status = execute_remote(workbench, "status", {"alias": "vanda", "request_key": key})
    assert status["run"]["state"] == "finished"
    retrieved = execute_remote(
        workbench,
        "retrieve",
        {"alias": "vanda", "request_key": key, "transfer_authorized": True},
    )
    assert retrieved["run"]["outputs"][0]["relative_path"] == "results.zip"
    attached = execute_remote(workbench, "attach", {"alias": "vanda", "request_key": key})

    run = attached["run"]
    receipt = attached["attachment"]
    assert run["state"] == "attached"
    assert project.summary()["counts"]["results"] == 1
    local_result = project.result(receipt["task_results"][0]["local_result_id"])
    assert (
        local_result["provenance"]["remote_attachment"]["request_sha256"] == run["request_sha256"]
    )
    internal = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ][0]["data"]
    original = base64.b64decode(internal["private_request_b64"], validate=True)
    assert hashlib.sha256(original).hexdigest() == run["request_sha256"]
    assert internal["request_sha256"] == run["request_sha256"]
    assert str(tmp_path) not in canonical_json(run)
    log = execute_remote(
        workbench,
        "logs",
        {"alias": "vanda", "request_key": key, "stderr": False, "limit": 1024},
    )
    assert log["text"] == "fixture stdout"
    cleaned = execute_remote(
        workbench,
        "remove_owned",
        {
            "alias": "vanda",
            "request_key": key,
            "request_sha256": run["request_sha256"],
            "cleanup_authorized": True,
        },
    )
    assert cleaned["run"]["state"] == "cleaned"
    assert cleaned["cleanup"]["remote_job_id"] == "123.fixture"
    assert project.result(receipt["task_results"][0]["local_result_id"])["revision_hash"]
    workbench.close()


def test_complete_remote_cellpose_lifecycle_binds_gpu_runtime_and_unreviewed_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "9" * 32
    state = TransportState()
    project, workbench, source = _project(tmp_path)
    _install_transport(monkeypatch, state)
    _install_fake_cellpose(monkeypatch)
    profile = _profile_request(tmp_path)
    profile["resources"] = {"cpus": 2, "memory_mb": 256, "wall_minutes": 10, "gpus": 1}
    execute_remote(workbench, "profile_save", profile)
    execute_remote(workbench, "readiness", {"alias": "vanda"})

    stage_request = _stage_cellpose_request(source["id"], key)
    channel_name = "1: " + workbench.channel_metadata(source["id"])["channels"][0]["name"]
    stage_request["tasks"][0]["cellpose"]["gates"] = [
        {
            "name": "declared-positive",
            "channel": channel_name,
            "statistic": "mean",
            "threshold": 95,
            "control": "Synthetic technical gate; no biological inference",
        }
    ]
    staged = execute_remote(workbench, "stage", stage_request)
    internal = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ][0]["data"]
    request = json.loads(base64.b64decode(internal["private_request_b64"], validate=True))
    assert request["schema"] == "loci.remote-worker-request/v2"
    assert request["tasks"][0]["operation"] == "run_cellpose"
    assert staged["run"]["resources"]["gpus"] == 1

    execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})
    execute_remote(workbench, "status", {"alias": "vanda", "request_key": key})
    execute_remote(
        workbench,
        "retrieve",
        {"alias": "vanda", "request_key": key, "transfer_authorized": True},
    )
    attached = execute_remote(workbench, "attach", {"alias": "vanda", "request_key": key})

    result = project.result(attached["attachment"]["task_results"][0]["local_result_id"])
    assert result["kind"] == "cellpose-segmentation"
    assert result["provenance"]["runtime"]["cellpose"]["resolved_device"] == "cuda"
    assert result["provenance"]["rights"]["basis"] == "noncommercial-research"
    assert project.review_state(result["id"]) is None
    assert result["provenance"]["measurements"][0]["marker_gates"]["declared-positive"] is True
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    info = workbench.execute("correction_info", binding)
    corrected = workbench.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "brush",
                    "mode": "paint",
                    "plane": "XY",
                    "index": 0,
                    "label": 1,
                    "points": [{"u": 5, "v": 3}],
                    "radius": 0.6,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        },
    )
    child = project.result(corrected["result"]["id"])
    row = child["provenance"]["measurements"][0]
    assert row["intensity"][channel_name]["mean"] == 90
    assert row["marker_gates"]["declared-positive"] is False
    assert child["provenance"]["cellpose"] == result["provenance"]["cellpose"]
    workbench.close()


def test_cleanup_retry_uses_durable_prepare_after_lost_response(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "8" * 32
    state = TransportState(fail_cleanup_once=True)
    project, workbench, _ = _save_and_stage(tmp_path, monkeypatch, state, key)
    binding = {"alias": "vanda", "request_key": key}
    execute_remote(workbench, "submit", binding)
    execute_remote(workbench, "status", binding)
    run = execute_remote(workbench, "retrieve", {**binding, "transfer_authorized": True})["run"]
    execute_remote(workbench, "attach", binding)
    cleanup_request = {
        **binding,
        "request_sha256": run["request_sha256"],
        "cleanup_authorized": True,
    }
    with pytest.raises(RuntimeError, match="lost cleanup"):
        execute_remote(workbench, "remove_owned", cleanup_request)
    persisted = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ][0]
    assert persisted["data"]["cleanup_prepared_at"]
    assert persisted["data"]["state"] == "attached"
    recovered = execute_remote(workbench, "remove_owned", cleanup_request)
    assert recovered["run"]["state"] == "cleaned"
    assert state.cleanup_calls == 2
    workbench.close()


def test_remote_resident_source_is_root_index_and_fingerprint_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, workbench, source = _project(tmp_path)
    state = TransportState()
    _install_transport(monkeypatch, state)
    remote_input = tmp_path / "mock-remote" / "input-root"
    remote_input.mkdir(parents=True)
    relative = Path("cohort") / "exact.ome.tif"
    (remote_input / relative.parent).mkdir()
    shutil.copyfile(project.source(source["id"])["private_path"], remote_input / relative)
    profile = _profile_request(tmp_path)
    profile["remote_input_roots"] = [str(remote_input)]
    execute_remote(workbench, "profile_save", profile)
    execute_remote(workbench, "readiness", {"alias": "vanda"})
    request = _stage_request(source["id"], "7" * 32)
    request["sources"] = [
        {
            "source_id": source["id"],
            "remote_input": {
                "root_index": 0,
                "relative_path": relative.as_posix(),
                "source_sha256": source["sha256"],
                "size_bytes": source["size_bytes"],
            },
        }
    ]
    staged = execute_remote(workbench, "stage", request)["run"]
    run_data = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ][0]["data"]
    encoded = json.loads(base64.b64decode(run_data["private_request_b64"], validate=True))
    assert encoded["sources"][0]["permitted_root"] == str(remote_input)
    transferred_inputs = (
        Path(profile["remote_project_root"]) / ".loci-runs" / staged["request_key"] / "inputs"
    )
    assert not transferred_inputs.exists()
    execute_remote(workbench, "submit", {"alias": "vanda", "request_key": staged["request_key"]})
    workbench.close()


def test_lost_submission_response_recovers_without_duplicate_submission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "b" * 32
    state = TransportState(fail_submit_once=True)
    project, workbench, _staged = _save_and_stage(tmp_path, monkeypatch, state, key)

    with pytest.raises(RuntimeError, match="lost submission"):
        execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})
    persisted = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ][0]
    assert persisted["data"]["state"] == "staged"

    recovered = execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})
    assert recovered["run"]["remote_job_id"] == "123.fixture"
    assert state.submit_calls == 2
    assert (
        len(list(Path(_profile_request(tmp_path)["remote_output_root"]).glob("**/results.zip")))
        == 1
    )
    workbench.close()


def test_identity_mismatch_is_rejected_without_advancing_durable_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "c" * 32
    state = TransportState(mismatched_identity=True)
    project, workbench, _staged = _save_and_stage(tmp_path, monkeypatch, state, key)

    with pytest.raises(ResearchRemoteError, match="mismatched"):
        execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})

    run = [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ][0]
    assert run["data"]["state"] == "staged"
    assert run["data"]["remote_job_id"] is None
    workbench.close()


def test_cancel_uses_persisted_identity_and_blocks_retrieval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "e" * 32
    state = TransportState()
    _project_value, workbench, _staged = _save_and_stage(tmp_path, monkeypatch, state, key)
    execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})

    cancelled = execute_remote(workbench, "cancel", {"alias": "vanda", "request_key": key})
    assert cancelled["run"]["cancel_requested"] is True
    assert state.cancelled is True
    with pytest.raises(ResearchRemoteError, match="Cancelled"):
        execute_remote(
            workbench,
            "retrieve",
            {"alias": "vanda", "request_key": key, "transfer_authorized": True},
        )
    workbench.close()


def test_stage_and_retrieve_reject_source_and_egress_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, workbench, source = _project(tmp_path)
    _install_transport(monkeypatch, TransportState())
    execute_remote(workbench, "profile_save", _profile_request(tmp_path))
    request = _stage_request(source["id"], "f" * 32)
    request["sources"][0]["path"] = "/tmp/override.tif"
    with pytest.raises(ResearchRemoteError, match="unexpected"):
        execute_remote(workbench, "stage", request)
    del request["sources"][0]["path"]
    request["transfer_authority"]["approved"] = False
    with pytest.raises(ResearchRemoteError, match="explicitly authorized"):
        execute_remote(workbench, "stage", request)
    assert not [
        item
        for item in project.documents("policy")
        if item["data"].get("schema") == service.RUN_SCHEMA
    ]
    with pytest.raises(ResearchRemoteError, match="unexpected"):
        execute_remote(
            workbench,
            "retrieve",
            {
                "alias": "vanda",
                "request_key": "f" * 32,
                "transfer_authorized": True,
                "destination": "/tmp/egress-override",
            },
        )
    workbench.close()


def test_profile_change_after_staging_requires_explicit_reconciliation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = "1" * 32
    _project_value, workbench, staged = _save_and_stage(
        tmp_path, monkeypatch, TransportState(), key
    )
    profile = _profile_request(tmp_path)
    profile["expected_revision"] = staged["run"]["profile_revision"]
    profile["queue"] = "other-batch"
    execute_remote(workbench, "profile_save", profile)

    with pytest.raises(ResearchRemoteError, match="changed after"):
        execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})
    workbench.close()


def test_workflow_rejects_direct_login_node_execution_profile(tmp_path: Path) -> None:
    _project_value, workbench, _source = _project(tmp_path)
    profile = _profile_request(tmp_path)
    profile["scheduler"] = "direct"
    profile["queue"] = None

    with pytest.raises(ResearchRemoteError, match="explicit standalone"):
        execute_remote(workbench, "profile_save", profile)
    profile["allow_direct_compute"] = True
    saved = execute_remote(workbench, "profile_save", profile)["profile"]
    assert saved["scheduler"] == "direct"
    assert saved["allow_direct_compute"] is True
    workbench.close()


def test_explicit_direct_profile_runs_the_same_durable_lifecycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _project_value, workbench, source = _project(tmp_path)
    _install_transport(monkeypatch, TransportState())
    profile = _profile_request(tmp_path)
    profile.update(
        scheduler="direct",
        queue=None,
        allow_direct_compute=True,
    )
    execute_remote(workbench, "profile_save", profile)
    execute_remote(workbench, "readiness", {"alias": "vanda"})
    key = "6" * 32
    execute_remote(workbench, "stage", _stage_request(source["id"], key))
    submitted = execute_remote(workbench, "submit", {"alias": "vanda", "request_key": key})
    finished = execute_remote(workbench, "status", {"alias": "vanda", "request_key": key})

    assert submitted["run"]["scheduler"] == "direct"
    assert submitted["run"]["remote_job_id"] == "123.fixture"
    assert finished["run"]["state"] == "finished"
    workbench.close()


def test_shared_remote_journey_freezes_channel_declarations_at_submission(tmp_path, monkeypatch):
    project, workbench, source = _project(tmp_path)
    _install_transport(monkeypatch, TransportState())
    workbench.execute("remote_profile_save", _profile_request(tmp_path))
    workbench.execute("remote_readiness", {"alias": "vanda"})
    channels = [
        {
            "index": 0,
            "name": "Declared reporter",
            "marker": "reporter",
            "fluorophore": "",
            "declaration": "Positive control sample",
        }
    ]
    workbench.execute("channels", {"source_id": source["id"], "channels": channels})
    key = "9" * 32
    stage_request = _stage_request(source["id"], key)
    stage_request["tasks"][0]["recipe"]["gates"] = [
        {
            "name": "control-gated",
            "channel": "1: Declared reporter",
            "statistic": "mean",
            "threshold": 150,
            "control": "Fixture control",
        }
    ]
    workbench.execute("remote_stage", stage_request)
    # Local edits after staging cannot change the submitted scientific meaning.
    channels[0]["name"] = "Later interpretation"
    workbench.execute(
        "channels", {"source_id": source["id"], "channels": channels, "expected_revision": 1}
    )
    binding = {"alias": "vanda", "request_key": key}
    workbench.execute("remote_submit", binding)
    workbench.execute("remote_status", binding)
    workbench.execute("remote_retrieve", {**binding, "transfer_authorized": True})
    attached = workbench.execute("remote_attach", binding)
    assert attached["run"]["state"] == "attached"
    result = project.list_results()[0]
    assert result["provenance"]["channel_metadata"]["channels"][0]["name"] == "Declared reporter"
    assert [
        row["intensity"]["1: Declared reporter"]["mean"]
        for row in result["provenance"]["measurements"]
    ] == [100, 200]
    assert [
        row["marker_gates"]["control-gated"] for row in result["provenance"]["measurements"]
    ] == [False, True]
    assert project.review_state(result["id"]) is None
    assert (
        workbench.execute("channel_metadata", {"source_id": source["id"]})["channels"][0]["name"]
        == "Later interpretation"
    )
