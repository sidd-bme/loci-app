"""Unit and regression tests for scripts/qa/codex-tissue.py verifier and phase separation."""

from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import io
import json
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import test_research_tissue_models as fixtures
from PIL import Image
from test_tissue_model_integration import run_job, submit_job

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_sessions import finish_session, register_policy, start_session
from loci_engine.research_project import ResearchProject
from loci_engine.tissue_model_profiles import puma_profile
from loci_engine.workbench import Workbench, display_scalar

pytest_plugins = ["test_tissue_model_integration"]

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/qa/codex-tissue.py"


def load_codex_tissue_module():
    spec = importlib.util.spec_from_file_location("codex_tissue_qa", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _encode_png(array: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(array).save(buf, format="PNG")
    return buf.getvalue()


def _make_completed_call(
    call_id: str,
    tool: str,
    arguments: dict[str, Any],
    payload: dict[str, Any],
    *,
    is_error: bool = False,
    image_png: bytes | None = None,
    origin: str | None = "python-mcp-sdk",
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": json.dumps(payload, sort_keys=True)}]
    if image_png is not None:
        content.append(
            {
                "type": "image",
                "mimeType": "image/png",
                "data": base64.b64encode(image_png).decode("ascii"),
            }
        )
    started = {
        "type": "item.started",
        "item": {
            "id": call_id,
            "type": "mcp_tool_call",
            "server": "loci-tissue-qa",
            "tool": tool,
            "arguments": copy.deepcopy(arguments),
            "status": "in_progress",
        },
    }
    completed = {
        "type": "item.completed",
        "item": {
            "id": call_id,
            "type": "mcp_tool_call",
            "server": "loci-tissue-qa",
            "tool": tool,
            "arguments": copy.deepcopy(arguments),
            "status": "completed",
            "result": {
                "isError": is_error,
                "content": content,
                "structuredContent": None if is_error else copy.deepcopy(payload),
            },
            "error": None,
        },
    }
    if origin is not None:
        started["event_origin"] = origin
        completed["event_origin"] = origin
    return [started, completed]


@pytest.fixture
def mod():
    return load_codex_tissue_module()


def test_non_host_entrypoints_never_query_or_invoke_codex(mod, monkeypatch, capsys):
    def forbid_codex_which(name: str, *_args: Any, **_kwargs: Any):
        if "codex" in str(name):
            pytest.fail("Non-host entrypoint queried codex executable")
        return None

    original_run = subprocess.run

    def forbid_codex_run(cmd: Any, *args: Any, **kwargs: Any):
        if any("codex" in str(part) for part in (cmd if isinstance(cmd, (list, tuple)) else [cmd])):
            pytest.fail("Non-host entrypoint attempted to execute codex")
        return original_run(cmd, *args, **kwargs)

    monkeypatch.setattr(shutil, "which", forbid_codex_which)
    monkeypatch.setattr(subprocess, "run", forbid_codex_run)

    assert mod.main([]) == 0
    out_default = capsys.readouterr().out
    assert "prepare" in out_default and "sdk-check" in out_default and "verify" in out_default

    assert mod.main(["help"]) == 0
    out_help = capsys.readouterr().out
    assert "run-host" in out_help


def test_minimal_v6_policy_specification_is_narrow_and_has_no_export_grant(mod, tmp_path):
    study = ResearchProject.create(tmp_path / "minimal.loci-study", title="Minimal policy test")
    source_file = tmp_path / "synthetic.tif"
    Image.fromarray(np.zeros((8, 8, 3), dtype=np.uint8)).save(source_file, format="TIFF")
    source_sha = mod.sha256_file(source_file)
    wb = Workbench(study)
    try:
        source_id = wb.import_native(str(source_file))["id"]
    finally:
        wb.close()
    profile = puma_profile()
    expires_at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    spec = mod.build_policy_specification(source_id, profile, expires_at=expires_at)
    spec["sources"][0]["sha256"] = source_sha
    spec["tissue_outputs"] = []

    assert spec["export"] is None
    assert spec["recipes"] == []
    assert spec["remote_grants"] == []
    assert spec["experimental_recipes"] == []
    assert spec["limits"]["concurrency"] == 1
    assert spec["limits"]["memory_bytes"] == profile["resources"]["minimum_working_bytes"]
    assert set(spec["actions"]) == set(mod.POLICY_ACTIONS)
    assert "export_result" not in spec["operations"]

    policy_path = tmp_path / "agent-policy.json"
    receipt = write_policy(policy_path, study, spec)
    assert receipt["schema"] == "loci.agent-policy/v6"
    loaded = load_policy(policy_path)
    assert loaded.export_root is None
    assert loaded.concurrency == 1


def _build_synthetic_verified_environment(
    mod: Any,
    case: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    origin: str | None = "python-mcp-sdk",
    session_client_id: str = "loci-tissue-sdk-smoke",
) -> tuple[Path, list[dict[str, Any]], dict[str, Any]]:
    output_dir = tmp_path / "run"
    output_dir.mkdir(mode=0o700)
    (output_dir / "models").mkdir(mode=0o700)
    (output_dir / "access").mkdir(mode=0o700)

    worker_bin = tmp_path / "fake-worker"
    worker_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    worker_bin.chmod(0o700)

    project = case.project
    wb = case.wb
    study_path = project.root
    source_copy = case.path
    source_id = case.source["id"]
    fake_source_sha = case.source["sha256"]
    monkeypatch.setattr(mod, "SOURCE_SHA", fake_source_sha)

    profile = puma_profile()
    expires_at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    delegation_id = "c" * 32
    spec = mod.build_policy_specification(
        source_id, profile, expires_at=expires_at, delegation_id=delegation_id
    )
    spec["sources"][0]["sha256"] = fake_source_sha
    spec["sources"][0]["crop"] = {"x": 0, "y": 0, "width": 10, "height": 8}
    spec["tissue_outputs"] = [
        {
            "source_id": source_id,
            "source_sha256": fake_source_sha,
            "output_selection": copy.deepcopy(case.request["output_selection"]),
        }
    ]
    policy_path = output_dir / "access/agent-policy.json"
    policy_receipt = write_policy(policy_path, project, spec)
    loaded_policy = load_policy(policy_path)
    register_policy(project, loaded_policy, permission_mode="full_access", bundle_name="access")
    session_info = start_session(
        project, loaded_policy, client_id=session_client_id, client_version="1.0.0", pid=12345
    )
    session_id = session_info["session_id"]

    tissue_request = copy.deepcopy(case.request)
    denied_request = {**tissue_request, "working_bytes": 4 * 1024**3}
    owner = {"policy_sha256": policy_receipt["policy_sha256"], "session_id": session_id}

    pjob = submit_job(wb, tissue_request, mod.PREVIEW_KEY, "tissue_model_preview", owner=owner)
    preview_out = run_job(wb, pjob["id"])
    preview_job_id = pjob["id"]
    token = fixtures.token(preview_out)

    rjob = submit_job(wb, token, mod.RUN_KEY, "tissue_model_run", owner=owner)
    run_out = run_job(wb, rjob["id"])
    run_job_id = rjob["id"]
    result_id = run_out["result"]["id"]
    result_record = project.result(result_id)
    revision_hash = result_record["revision_hash"]

    artifacts_dir = study_path / "artifacts"
    arrays: dict[str, np.ndarray] = {}
    expected_shas: dict[str, str] = {}
    for key, desc in result_record["arrays"].items():
        expected_shas[key] = desc["sha256"]
        arrays[key] = project.load_array(desc)

    ref_dir = tmp_path / "ref"
    ref_dir.mkdir()
    for key in ("class_labels", "probabilities"):
        shutil.copyfile(artifacts_dir / f"{expected_shas[key]}.npy", ref_dir / f"{key}.npy")
    raw_shas = {
        key: hashlib.sha256(arrays[key].tobytes()).hexdigest()
        for key in ("class_labels", "probabilities")
    }
    monkeypatch.setattr(mod, "EXPECTED_RESULT_ARRAY_SHAS", expected_shas)
    monkeypatch.setattr(mod, "REFERENCE_ARRAY_RAW_SHAS", raw_shas)

    ref_receipt_path = ref_dir / "receipt.json"
    mod.write_json(
        ref_receipt_path,
        {
            "backend": {
                "artifacts": {
                    key: {
                        "dtype": str(arrays[key].dtype),
                        "shape": list(arrays[key].shape),
                        "sha256": raw_shas[key],
                    }
                    for key in ("class_labels", "probabilities")
                }
            }
        },
    )

    review_receipt = project.review(
        result_id,
        revision_hash,
        "reviewed",
        actor="agent",
        actor_id=mod.DELEGATION_CLIENT_ID,
        authority={
            "kind": "policy-delegation",
            "policy_sha256": policy_receipt["policy_sha256"],
            "delegation_id": delegation_id,
            "client_id": mod.DELEGATION_CLIENT_ID,
        },
        reason="AGENT technical verification of deterministic fixture.",
        coverage="64x64 ROI.",
        expected_review_sha256=None,
    )
    finish_session(project, session_id, reason="MCP stdio connection closed", failed=False)

    preview_cached = wb.execute("task_preview_get", {"job_id": preview_job_id})
    overlay_data_url = preview_cached["preview"]["output"]["overlay_png"]

    rgb, _ = display_scalar(arrays["image"])
    view_pngs: dict[str, bytes] = {}
    for field in mod.EXPECTED_VIEWS:
        if field == "epidermis_score":
            img = np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
        else:
            lkey = "class_labels" if field == "tissue_classes" else "labels"
            lplane = arrays[lkey].astype(np.uint32)
            tint = np.stack([(lplane * m % 223 + 32) / 255 for m in (67, 97, 137)], axis=-1)
            blended = np.where((lplane > 0)[..., None], 0.6 * rgb + 0.4 * tint, rgb)
            img = np.round(np.clip(blended, 0, 1) * 255).astype(np.uint8)
        view_pngs[field] = _encode_png(img)

    events: list[dict[str, Any]] = []
    if origin is None:
        events.append({"type": "thread.started"})
        events.append({"type": "turn.started"})

    def add_call(
        cid: str,
        tool: str,
        args: dict[str, Any],
        payload: dict[str, Any],
        *,
        is_error: bool = False,
        image_png: bytes | None = None,
    ) -> None:
        events.extend(
            _make_completed_call(
                cid,
                tool,
                args,
                payload,
                is_error=is_error,
                image_png=image_png,
                origin=origin,
            )
        )

    add_call(
        "c1",
        "action_guide",
        {"operation": "tissue_model_preview"},
        {"actions": [{"name": "tissue_model_preview", "execution": "durable-task"}]},
    )
    add_call(
        "c2",
        "analysis_context",
        {"offset": 0, "limit": 50},
        {"limits": {"concurrency": 1}, "sources": [{"id": source_id}]},
    )
    add_call(
        "c3",
        "inspect_source",
        {"source_id": source_id},
        {"verified": True, "source_id": source_id, "source_sha256": fake_source_sha},
    )
    add_call(
        "c4",
        "validate_action",
        {"operation": "tissue_model_profiles", "request": {}},
        {"authorized": True},
    )
    add_call(
        "c5",
        "inspect_action",
        {"operation": "tissue_model_profiles", "request": {}},
        {
            "profiles": [
                {
                    "profile": profile,
                    "store": {"state": "provisioned-unverified"},
                }
            ]
        },
    )
    add_call(
        "c6",
        "validate_action",
        {"operation": "tissue_model_status", "request": tissue_request},
        {"authorized": True},
    )
    add_call(
        "c7",
        "inspect_action",
        {"operation": "tissue_model_status", "request": tissue_request},
        {
            "source_verification": "registered-metadata-only",
            "status": {"model_execution_performed": False},
        },
    )
    add_call(
        "c8",
        "submit_action",
        {
            "operation": "tissue_model_preview",
            "request": denied_request,
            "request_key": mod.DENIED_KEY,
        },
        {"error": "Working bytes exceed policy"},
        is_error=True,
    )
    add_call(
        "c9",
        "validate_action",
        {"operation": "tissue_model_preview", "request": tissue_request},
        {"authorized": True},
    )
    add_call(
        "c10",
        "submit_action",
        {
            "operation": "tissue_model_preview",
            "request": tissue_request,
            "request_key": mod.PREVIEW_KEY,
        },
        {"job": {"id": preview_job_id, "state": "queued", "owned_worker_active": True}},
    )
    add_call(
        "c11",
        "job_status",
        {"job_id": preview_job_id},
        {
            "job": {
                "id": preview_job_id,
                "state": "succeeded",
                "owned_worker_active": False,
                "result_ids": [],
            }
        },
    )
    add_call(
        "c12",
        "submit_action",
        {
            "operation": "tissue_model_preview",
            "request": tissue_request,
            "request_key": mod.PREVIEW_KEY,
        },
        {
            "job": {
                "id": preview_job_id,
                "state": "succeeded",
                "owned_worker_active": False,
                "result_ids": [],
            }
        },
    )
    add_call(
        "c13",
        "inspect_action",
        {"operation": "task_preview_get", "request": {"job_id": preview_job_id}},
        {
            "preview": {
                "schema": "loci.task-preview/v1",
                "job_id": preview_job_id,
                "adopted": False,
                "output": {
                    **token,
                    "adopted": False,
                    "overlay_png": overlay_data_url,
                },
            }
        },
    )
    add_call(
        "c14",
        "validate_action",
        {"operation": "tissue_model_run", "request": token},
        {"authorized": True},
    )
    add_call(
        "c15",
        "submit_action",
        {"operation": "tissue_model_run", "request": token, "request_key": mod.RUN_KEY},
        {"job": {"id": run_job_id, "state": "queued", "owned_worker_active": True}},
    )
    add_call(
        "c16",
        "job_status",
        {"job_id": run_job_id},
        {
            "job": {
                "id": run_job_id,
                "state": "succeeded",
                "owned_worker_active": False,
                "result_ids": [result_id],
            }
        },
    )
    add_call(
        "c17",
        "submit_action",
        {"operation": "tissue_model_run", "request": token, "request_key": mod.RUN_KEY},
        {
            "job": {
                "id": run_job_id,
                "state": "succeeded",
                "owned_worker_active": False,
                "result_ids": [result_id],
            }
        },
    )
    add_call(
        "c18",
        "result",
        {"result_id": result_id},
        {
            "result": {
                "id": result_id,
                "revision_hash": revision_hash,
                "tissue_model": {"preview": token},
            },
            "measurements": [{"label": 1, "measure": 64.0, "intensity": {}}],
        },
    )
    add_call(
        "c19",
        "result_view",
        {"result_id": result_id, "label_field": "tissue_classes"},
        {
            "result_id": result_id,
            "revision_hash": revision_hash,
            "field": "tissue_classes",
            "basis": "original",
        },
        image_png=view_pngs["tissue_classes"],
    )
    add_call(
        "c20",
        "result_view",
        {"result_id": result_id, "label_field": "compartments"},
        {
            "result_id": result_id,
            "revision_hash": revision_hash,
            "field": "compartments",
            "basis": "effective",
        },
        image_png=view_pngs["compartments"],
    )
    add_call(
        "c21",
        "result_view",
        {"result_id": result_id, "labels": False},
        {
            "result_id": result_id,
            "revision_hash": revision_hash,
            "field": "epidermis_score",
            "basis": "score",
        },
        image_png=view_pngs["epidermis_score"],
    )
    add_call(
        "c22",
        "review_history",
        {"result_id": result_id},
        {
            "events": [],
            "total_events": 0,
            "next_offset": None,
            "current_review_sha256": None,
            "assessment_disclosed": True,
        },
    )
    add_call(
        "c23",
        "review_result",
        {
            "request": {
                "result_id": result_id,
                "revision_hash": revision_hash,
                "disposition": "reviewed",
                "reason": "AGENT technical verification of deterministic fixture.",
                "coverage": "64x64 ROI.",
                "expected_review_sha256": None,
            }
        },
        {"review": review_receipt},
    )
    if origin is None:
        events.append({"type": "turn.completed"})

    prompt_path = output_dir / "prompt.txt"
    prompt_path.write_text("synthetic test prompt")
    prepared = {
        "schema": "loci.codex-tissue-prepared/v1",
        "repo": str(REPO_ROOT),
        "output": str(output_dir),
        "study": str(study_path),
        "project_id": project.meta["project_id"],
        "source_copy": str(source_copy),
        "source_id": source_id,
        "source_sha256": fake_source_sha,
        "model_home": str(output_dir / "models"),
        "policy_path": str(policy_path),
        "policy_sha256": policy_receipt["policy_sha256"],
        "delegation_id": delegation_id,
        "worker": {
            "worker_path": str(worker_bin),
            "worker_sha256": mod.sha256_file(worker_bin),
        },
        "authorized_inputs": {
            "files": {
                "source": {"path": str(source_copy), "sha256": fake_source_sha},
                "reference_receipt": {
                    "path": str(ref_receipt_path),
                    "sha256": mod.sha256_file(ref_receipt_path),
                },
                "reference_classes": {
                    "path": str(ref_dir / "class_labels.npy"),
                    "sha256": expected_shas["class_labels"],
                },
                "reference_probabilities": {
                    "path": str(ref_dir / "probabilities.npy"),
                    "sha256": expected_shas["probabilities"],
                },
            }
        },
        "source_hashes": mod.tracked_source_hashes(REPO_ROOT),
        "prompt_path": str(prompt_path),
        "prompt_sha256": mod.sha256_file(prompt_path),
        "model_files_sha256": {},
        "tissue_request": tissue_request,
        "denied_request": denied_request,
    }
    mod.write_json(output_dir / "prepared-fixture.json", prepared, mode=0o600)
    return output_dir, events, prepared


def _write_events(path: Path, events: list[dict[str, Any]]) -> Path:
    path.write_text(
        "".join(json.dumps(e, sort_keys=True) + "\n" for e in events),
        encoding="utf-8",
    )
    return path


def test_verifier_accepts_valid_sdk_transcript_and_marks_host_unqualified(
    mod, ready, tmp_path, monkeypatch
):
    output_dir, events, _ = _build_synthetic_verified_environment(
        mod, ready, tmp_path, monkeypatch, origin="python-mcp-sdk"
    )
    transcript = _write_events(output_dir / "sdk-events.jsonl", events)
    res = mod.verify_phase(
        output=output_dir,
        transcript_path=transcript,
        expect_mode="sdk",
        skip_native_export=True,
    )
    assert res["status"] == "passed-mcp-sdk-smoke-only"
    assert res["evidence_kind"] == "mcp-sdk-smoke"
    assert res["codex_host_qualified"] is False


def test_verifier_rejects_sdk_or_simulated_transcript_for_codex_host_qualification(
    mod, ready, tmp_path, monkeypatch
):
    output_dir, sdk_events, _ = _build_synthetic_verified_environment(
        mod, ready, tmp_path, monkeypatch, origin="python-mcp-sdk"
    )
    sdk_transcript = _write_events(output_dir / "sdk-events.jsonl", sdk_events)
    with pytest.raises(AssertionError, match="cannot qualify a Codex host"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=sdk_transcript,
            expect_mode="codex-host",
            skip_native_export=True,
        )

    sim_events = copy.deepcopy(sdk_events)
    for event in sim_events:
        event["event_origin"] = "simulated"
    sim_transcript = _write_events(output_dir / "sim-events.jsonl", sim_events)
    with pytest.raises(AssertionError, match="cannot qualify a Codex host"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=sim_transcript,
            expect_mode="codex-host",
            skip_native_export=True,
        )


def test_verifier_rejects_relabelled_sdk_with_arbitrary_client_and_minimal_host_metadata(
    mod, ready, tmp_path, monkeypatch
):
    output_dir, host_shaped_events, _ = _build_synthetic_verified_environment(
        mod,
        ready,
        tmp_path,
        monkeypatch,
        origin=None,
        session_client_id="invented-host",
    )
    transcript = _write_events(output_dir / "codex-events.jsonl", host_shaped_events)
    mod.write_json(
        output_dir / "host-run.json",
        {
            "execution_mode": "codex-host",
            "codex_version": "0.1.0",
            "codex_executable": "/usr/local/bin/codex",
            "codex_executable_sha256": "f" * 64,
            "codex_exit_code": 0,
        },
        mode=0o600,
    )
    with pytest.raises(AssertionError, match="Incomplete Codex launcher metadata"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=transcript,
            expect_mode="codex-host",
            skip_native_export=True,
        )


def test_verifier_rejects_altered_worker_policy_source_or_artifact_hashes(
    mod, ready, tmp_path, monkeypatch
):
    output_dir, events, prepared = _build_synthetic_verified_environment(
        mod, ready, tmp_path, monkeypatch
    )
    transcript = _write_events(output_dir / "sdk-events.jsonl", events)

    # 1. Worker binary modified after preparation.
    Path(prepared["worker"]["worker_path"]).write_text("#!/bin/sh\necho tampered\n")
    with pytest.raises(AssertionError, match="Worker binary changed"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=transcript,
            expect_mode="sdk",
            skip_native_export=True,
        )
    Path(prepared["worker"]["worker_path"]).write_text("#!/bin/sh\nexit 0\n")

    # 2. Source copy tampered.
    Path(prepared["source_copy"]).write_bytes(b"corrupted-tiff")
    with pytest.raises(AssertionError, match="source copy changed"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=transcript,
            expect_mode="sdk",
            skip_native_export=True,
        )


def test_verifier_rejects_missing_negative_check_wrong_replay_or_active_worker_violation(
    mod, ready, tmp_path, monkeypatch
):
    output_dir, events, _ = _build_synthetic_verified_environment(mod, ready, tmp_path, monkeypatch)

    # 1. Missing negative authority check call (c8).
    no_denied = [e for e in events if e.get("item", {}).get("id") != "c8"]
    t1 = _write_events(output_dir / "no-denied.jsonl", no_denied)
    with pytest.raises(AssertionError, match="negative authority check"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=t1,
            expect_mode="sdk",
            skip_native_export=True,
        )

    # 2. Negative authority check unexpectedly succeeded (isError=False).
    succeeded_denied = copy.deepcopy(events)
    for e in succeeded_denied:
        if e.get("type") == "item.completed" and e.get("item", {}).get("id") == "c8":
            e["item"]["result"]["isError"] = False
            e["item"]["result"]["structuredContent"] = {"job": {"id": "bad"}}
    t2 = _write_events(output_dir / "bad-denied.jsonl", succeeded_denied)
    with pytest.raises(AssertionError, match="fail closed"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=t2,
            expect_mode="sdk",
            skip_native_export=True,
        )

    # 3. Missing idempotent replay for preview (remove c12).
    no_replay = [e for e in events if e.get("item", {}).get("id") != "c12"]
    t3 = _write_events(output_dir / "no-replay.jsonl", no_replay)
    with pytest.raises(AssertionError, match="idempotent replay"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=t3,
            expect_mode="sdk",
            skip_native_export=True,
        )

    # 4. Continuing before owned_worker_active is False (c11 reports owned_worker_active=True).
    still_active = copy.deepcopy(events)
    for e in still_active:
        if e.get("type") == "item.completed" and e.get("item", {}).get("id") == "c11":
            e["item"]["result"]["structuredContent"]["job"]["owned_worker_active"] = True
    t4 = _write_events(output_dir / "still-active.jsonl", still_active)
    with pytest.raises(AssertionError, match="owned worker exited"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=t4,
            expect_mode="sdk",
            skip_native_export=True,
        )

    # 5. Forbidden host bypass item (command_execution).
    bypass_events = copy.deepcopy(events)
    bypass_events.insert(
        2,
        {
            "type": "item.completed",
            "event_origin": "python-mcp-sdk",
            "item": {"id": "shell-1", "type": "command_execution"},
        },
    )
    t5 = _write_events(output_dir / "bypass.jsonl", bypass_events)
    with pytest.raises(AssertionError, match="bypassed MCP-only scope"):
        mod.verify_phase(
            output=output_dir,
            transcript_path=t5,
            expect_mode="sdk",
            skip_native_export=True,
        )


def test_poll_errors_are_rejected_even_if_a_later_poll_succeeds(mod):
    events = _make_completed_call(
        "submit",
        "submit_action",
        {"operation": "tissue_model_preview", "request_key": mod.PREVIEW_KEY},
        {"job": {"id": "j", "state": "queued"}},
    )
    events += _make_completed_call(
        "poll-error", "job_status", {"job_id": "j"}, {"error": "database busy"}, is_error=True
    )
    events += _make_completed_call(
        "poll-ok",
        "job_status",
        {"job_id": "j"},
        {"job": {"id": "j", "state": "succeeded", "owned_worker_active": False}},
    )
    with pytest.raises(AssertionError, match="failed unexpectedly"):
        mod.parse_transcript_events(events, expect_mode="sdk")


def test_verify_reads_without_changing_accepted_artifacts(mod, ready, tmp_path, monkeypatch):
    output, events, _ = _build_synthetic_verified_environment(mod, ready, tmp_path, monkeypatch)
    transcript = _write_events(output / "sdk-events.jsonl", events)
    sentinel = output / "exports/original/keep.txt"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text("preserve existing accepted export")
    before = mod.tree_hashes(output)
    mod.verify_phase(
        output=output, transcript_path=transcript, expect_mode="sdk", skip_native_export=True
    )
    assert mod.tree_hashes(output) == before
    with pytest.raises(FileNotFoundError, match="artifact-generation"):
        mod.verify_phase(output=output, transcript_path=transcript, expect_mode="sdk")
    assert mod.tree_hashes(output) == before
    with pytest.raises(AssertionError, match="already attempted"):
        mod.finalize_artifacts_phase(output=output, expect_mode="sdk")
    assert mod.tree_hashes(output) == before


def test_used_or_mismatched_prepared_fixture_is_rejected_before_authority_or_host_probe(
    mod, ready, tmp_path, monkeypatch
):
    output, _, prepared = _build_synthetic_verified_environment(mod, ready, tmp_path, monkeypatch)
    before = mod.tree_hashes(output)
    monkeypatch.setattr(
        mod,
        "_refresh_validated_policy",
        lambda *_: pytest.fail("Policy refreshed before unused guard"),
    )
    monkeypatch.setattr(
        mod.shutil, "which", lambda *_: pytest.fail("Host executable probed before guard")
    )
    with pytest.raises(AssertionError, match="already used"):
        mod.run_host_phase(repo=REPO_ROOT, output=output)
    other_worker = tmp_path / "other-worker"
    other_worker.write_text("different")
    with pytest.raises(AssertionError, match="Requested worker mismatch"):
        mod.run_host_phase(repo=REPO_ROOT, output=output, worker=other_worker)
    assert mod.tree_hashes(output) == before
    Path(prepared["prompt_path"]).write_text("changed prompt")
    with pytest.raises(AssertionError, match="prompt changed"):
        mod.run_host_phase(repo=REPO_ROOT, output=output)


def test_prepare_rejects_invalid_inputs_before_creating_output(mod, tmp_path):
    output = tmp_path / "new-output"
    with pytest.raises(FileNotFoundError):
        mod.prepare_phase(
            repo=REPO_ROOT,
            worker=tmp_path / "missing-worker",
            output=output,
            allow_test_output=True,
        )
    assert not output.exists()


def test_non_host_cli_phases_route_without_launching_host(mod, monkeypatch, tmp_path):
    def forbid(*_args, **_kwargs):
        pytest.fail("Non-host CLI phase invoked host launcher")

    monkeypatch.setattr(mod, "run_host_phase", forbid)
    monkeypatch.setattr(mod.shutil, "which", forbid)
    seen = []

    def phase(name, result):
        def run(**kwargs):
            seen.append((name, kwargs))
            return result

        return run

    monkeypatch.setattr(
        mod, "prepare_phase", phase("prepare", {"status": "prepared", "output": "out"})
    )
    monkeypatch.setattr(mod, "sdk_check_phase", phase("sdk", {"status": "sdk", "output": "out"}))
    monkeypatch.setattr(
        mod, "verify_phase", phase("verify", {"status": "verified", "evidence_kind": "sdk"})
    )
    monkeypatch.setattr(mod, "finalize_artifacts_phase", phase("artifacts", {}))
    common = ["--output", str(tmp_path / "out")]
    assert mod.main(["prepare", "--worker", "unused", *common]) == 0
    assert mod.main(["sdk-check", "--worker", "unused", *common]) == 0
    assert mod.main(["verify", *common]) == 0
    assert mod.main(["finalize-artifacts", "--expect-mode", "sdk", *common]) == 0
    assert [name for name, _ in seen] == ["prepare", "sdk", "verify", "artifacts"]


def test_unused_guard_accepts_fresh_fixture_and_rejects_artifacts_before_refresh(
    mod, tmp_path, monkeypatch
):
    output = tmp_path / "fresh"
    output.mkdir()
    source = output / "inputs/source.tif"
    source.parent.mkdir()
    Image.fromarray(np.zeros((8, 8, 3), dtype=np.uint8)).save(source)
    monkeypatch.setattr(mod, "SOURCE_SHA", mod.sha256_file(source))
    project = ResearchProject.create(output / "study", title="Synthetic guard test")
    wb = Workbench(project)
    try:
        source_id = wb.import_native(str(source))["id"]
    finally:
        wb.close()
    worker = tmp_path / "worker"
    worker.write_text("synthetic executable bytes")
    worker.chmod(0o700)
    models = output / "models"
    models.mkdir()
    prompt = output / "prompt.txt"
    prompt.write_text("synthetic prompt")
    policy = output / "access/policy.json"
    policy.parent.mkdir()
    policy.write_text("synthetic unused policy bytes")
    prepared = {
        "output": str(output),
        "repo": str(REPO_ROOT),
        "study": str(project.root),
        "source_id": source_id,
        "project_id": project.meta["project_id"],
        "source_copy": str(source),
        "source_sha256": mod.SOURCE_SHA,
        "worker": mod.inspect_worker_and_app(worker),
        "policy_path": str(policy),
        "policy_sha256": mod.sha256_file(policy),
        "source_hashes": mod.tracked_source_hashes(REPO_ROOT),
        "authorized_inputs": {"files": {"source": {"path": str(source), "sha256": mod.SOURCE_SHA}}},
        "prompt_path": str(prompt),
        "prompt_sha256": mod.sha256_file(prompt),
        "model_home": str(models),
        "model_files_sha256": {},
    }
    mod.write_json(output / "prepared-fixture.json", prepared)
    mod.write_json(output / "receipt.json", {"status": "prepared-ready-for-host-or-sdk"})
    assert mod.validate_unused_prepared(output, repo=REPO_ROOT) == prepared
    monkeypatch.setattr(
        mod,
        "_refresh_validated_policy",
        lambda *_: pytest.fail("Authority refreshed for invalid fixture"),
    )
    monkeypatch.setattr(
        mod.shutil, "which", lambda *_: pytest.fail("Host probed for invalid fixture")
    )
    for path, message in ((policy, "policy file changed"), (prompt, "prompt changed")):
        original = path.read_bytes()
        path.write_text("tampered")
        with pytest.raises(AssertionError, match=message):
            mod.run_host_phase(repo=REPO_ROOT, output=output)
        path.write_bytes(original)
    (models / "unexpected").write_text("model drift")
    with pytest.raises(AssertionError, match="model files changed"):
        mod.run_host_phase(repo=REPO_ROOT, output=output)
    (models / "unexpected").unlink()
    (output / "codex-events.jsonl").write_text("prior attempt")
    before = mod.tree_hashes(output)
    with pytest.raises(AssertionError, match="Existing run artifacts"):
        mod.run_host_phase(repo=REPO_ROOT, output=output)
    assert mod.tree_hashes(output) == before


def test_local_launcher_binding_checks_thread_session_and_command_without_claiming_attestation(
    mod, tmp_path
):
    """Synthetic metadata exercises binding checks; it is not actual host evidence."""
    output = tmp_path
    executable = output / "fake-codex"
    executable.write_text("synthetic CLI bytes")
    for name in ("prepared-fixture.json", "prompt.txt", "answer.txt", "codex-stderr.log"):
        (output / name).write_text("synthetic fixture")
    events = [{"type": "thread.started", "thread_id": "synthetic-test-thread"}]
    transcript = _write_events(output / "events.jsonl", events)
    now = datetime.now(UTC).isoformat()
    session = {
        "client_id": "codex-mcp-client",
        "client_version": "synthetic-version",
        "session_id": "synthetic-session",
        "started_at": now,
    }
    prepared = {
        "worker": {"worker_path": str(output / "worker")},
        "policy_path": str(output / "policy"),
        "model_home": str(output / "models"),
        "prompt_sha256": mod.sha256_file(output / "prompt.txt"),
    }
    metadata = {
        "schema": "loci.codex-tissue-host-run/v2",
        "execution_mode": "codex-host",
        "codex_exit_code": 0,
        "codex_version": "codex-cli synthetic-version",
        "codex_executable": str(executable),
        "codex_executable_sha256": mod.sha256_file(executable),
        "thread_id": "synthetic-test-thread",
        "transcript_sha256": mod.sha256_file(transcript),
        "prepared_sha256": mod.sha256_file(output / "prepared-fixture.json"),
        "prompt_sha256": prepared["prompt_sha256"],
        "session_sha256": mod.value_sha256(session),
        "files_sha256": {
            name: mod.sha256_file(output / name) for name in ("answer.txt", "codex-stderr.log")
        },
        "model_requested": "requested-model",
        "effort_requested": "high",
        "model_observed": None,
        "observed_model_basis": "not-exposed-by-cli-json",
        "started_at": now,
        "finished_at": now,
    }
    metadata["host_command"] = mod.build_codex_command(
        str(executable),
        output / "worker",
        output / "policy",
        output / "models",
        output / "answer.txt",
        model="requested-model",
        effort="high",
    )
    mod.write_json(output / "host-run.json", metadata)
    mod.validate_host_binding(output, prepared, transcript, events, session)
    for key, altered, message in (
        ("thread_id", "other-thread", "thread binding"),
        ("session_sha256", "f" * 64, "session/input binding"),
        ("host_command", ["unrelated-command"], "launcher command"),
    ):
        mod.write_json(output / "host-run.json", {**metadata, key: altered})
        with pytest.raises(AssertionError, match=message):
            mod.validate_host_binding(output, prepared, transcript, events, session)


@pytest.mark.parametrize("damage", ["unfinished", "non-completed", "changed-arguments"])
def test_transcript_rejects_incomplete_or_inconsistent_tool_calls(mod, damage):
    events = _make_completed_call("call", "analysis_context", {}, {"sources": []})
    if damage == "unfinished":
        events.pop()
    elif damage == "non-completed":
        events[-1]["item"]["status"] = "failed"
    else:
        events[-1]["item"]["arguments"] = {"changed": True}
    with pytest.raises(AssertionError):
        mod.parse_transcript_events(events, expect_mode="sdk")


def test_artifact_generation_is_explicit_bound_and_verify_never_regenerates(
    mod, ready, tmp_path, monkeypatch
):
    output, events, prepared = _build_synthetic_verified_environment(
        mod, ready, tmp_path, monkeypatch
    )
    _write_events(output / "sdk-events.jsonl", events)

    def synthetic_cold_subprocess(command, **_kwargs):
        # This unit fixture has synthetic model/source identities; no process is launched.
        assert "--cold-retained-check" in command
        assert not Path(prepared["source_copy"]).exists()
        result = ready.project.list_results()[0]
        report = {
            "schema": "loci.codex-tissue-cold-retained/v1",
            "verified_result_id": result["id"],
            "verified_revision_hash": result["revision_hash"],
            "source_decode": False,
            "model_access": False,
            "torch_import": False,
        }
        mod.write_json(output / "cold-retained-check.json", report)
        return subprocess.CompletedProcess(command, 0, json.dumps(report) + "\n", "")

    monkeypatch.setattr(mod.subprocess, "run", synthetic_cold_subprocess)
    generated = mod.finalize_artifacts_phase(output=output, expect_mode="sdk")
    assert Path(prepared["source_copy"]).is_file()
    assert generated["transcript_sha256"] == mod.sha256_file(output / "sdk-events.jsonl")
    before = mod.tree_hashes(output)
    verified = mod.verify_phase(output=output, expect_mode="sdk")
    assert verified["cold_reopen"]["source_decode"] is False
    assert mod.tree_hashes(output) == before
    exported_array = output / "exports/original/image.npy"
    exported_array.write_bytes(b"tampered")
    tampered = mod.tree_hashes(output)
    with pytest.raises(AssertionError, match="Generated artifact changed"):
        mod.verify_phase(output=output, expect_mode="sdk")
    assert mod.tree_hashes(output) == tampered


@pytest.mark.parametrize("already_prepared", [False, True])
def test_host_launch_performs_one_preflight_before_refresh_and_lookup(
    mod, tmp_path, monkeypatch, already_prepared
):
    output = tmp_path / "run"
    if already_prepared:
        output.mkdir()
    prepared = {"output": str(output)}
    transitions = []

    def prepare(**_kwargs):
        transitions.append("prepare")
        output.mkdir()
        return prepared

    def preflight(*_args, **_kwargs):
        transitions.append("preflight")
        return prepared

    def refresh(_output, validated):
        assert validated is prepared
        assert transitions == ["preflight"]
        transitions.append("refresh")
        return validated

    def lookup(_name):
        transitions.append("lookup")
        assert (output / "host-attempt.json").is_file()
        return None

    monkeypatch.setattr(mod, "prepare_phase", prepare)
    monkeypatch.setattr(mod, "validate_unused_prepared", preflight)
    monkeypatch.setattr(mod, "_refresh_validated_policy", refresh)
    monkeypatch.setattr(mod.shutil, "which", lookup)
    with pytest.raises(AssertionError, match="CLI is unavailable"):
        mod.run_host_phase(repo=REPO_ROOT, output=output, worker=tmp_path / "unused-worker")
    assert transitions == (
        ["preflight", "refresh", "lookup"]
        if already_prepared
        else ["prepare", "preflight", "lookup"]
    )
