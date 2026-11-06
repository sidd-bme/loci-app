"""Tissue model qualification kit: prepare, MCP SDK smoke, verifier, and future Codex host runner.

Phases:
  prepare            Prepare an isolated study, managed model store, and minimal v6 policy.
  sdk-check          Run a real MCP stdio smoke sequence via Python MCP SDK and verify it.
  verify             Read-only verification of transcript and existing study/export artifacts.
  finalize-artifacts Create bound native export/view/cold QA once after transcript checks.
  run-host           Execute an ephemeral Codex CLI host run (for the Codex lead only) and verify.
  prepare-native-ui  Prepare an isolated native-picker desktop UI kit and launch script.
  verify-native-ui   Verify post-action study, store, review, export, and cold-reopen artifacts.

Non-host phases (help, import, default, prepare, sdk-check, verify, prepare-native-ui,
verify-native-ui, finalize-artifacts) never invoke Codex or any external model session.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import builtins
import copy
import hashlib
import io
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_SRC = REPO_ROOT / "engine" / "src"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

SERVER = "loci-tissue-qa"
SDK_CLIENT_ID = "loci-tissue-sdk-smoke"
SIMULATED_CLIENT_ID = "simulated-client"
DELEGATION_CLIENT_ID = "codex-tissue-qa"

DENIED_KEY = "codex-tissue-denied-v1"
PREVIEW_KEY = "codex-tissue-preview-v1"
RUN_KEY = "codex-tissue-run-v1"

SOURCE_SHA = "34d13bdc3b05a9ab580f3edc63e826f38f1e1c10bafeacacb0d7573096226166"
WEIGHTS_SHA = "f32a81e49ff3fc60e0831fcb4e6c1bce311586151ef2257c0f1ddcf7792804ad"
CONVERSION_SHA = "9383634f6840b382e343a9bdc8b73fa92e606ce05e251508ddb904aebe31c486"
REFERENCE_RECEIPT_SHA = "a599bff208a11a1dd2067492a9231cae8eeaf1d5b8e446df0fc5dc4de34b32b2"
REFERENCE_CLASSES_FILE_SHA = "ce6bc9c3e4a8a6b3e090990fcf979157a0676e76c621c8d06b7ef7f9aa79904f"
REFERENCE_PROBABILITIES_FILE_SHA = (
    "3e7be44d383ef92f73938d8d243c828fbd58e72aec4d9f209042f48275de9bbe"
)
REFERENCE_ARRAY_RAW_SHAS = {
    "class_labels": "155ab3509f1374519a2bc3887472b006ea0f68c12b1a40fab4446cf988f0c37c",
    "probabilities": "3833cada4c4c28081706e6e109059927eae232b0da0a03daef87a7f4054585da",
}
EXPECTED_RESULT_ARRAY_SHAS = {
    "class_labels": REFERENCE_CLASSES_FILE_SHA,
    "probabilities": REFERENCE_PROBABILITIES_FILE_SHA,
    "image": "e9309bc424a88298b0be8c8134d186db4e85d9bef28bd988365169a56fcb7925",
    "labels": "c170ccc6dbe2d37ccd30c05973da382f4fdd11cc84cd2d422313851adabad2a0",
}

CONTEXT_SELECTION = {
    "x": 0,
    "y": 0,
    "width": 1024,
    "height": 1024,
    "c": 0,
    "z": 0,
    "t": 0,
    "level": 0,
}
OUTPUT_SELECTION = {
    "x": 960,
    "y": 0,
    "width": 64,
    "height": 64,
    "c": 0,
    "z": 0,
    "t": 0,
    "level": 0,
}
EXPECTED_VIEWS = ("tissue_classes", "compartments", "epidermis_score")

POLICY_OPERATIONS = (
    "analysis_context",
    "cancel_job",
    "inspect_action",
    "inspect_source",
    "job_status",
    "result",
    "result_view",
    "review_history",
    "review_result",
    "submit_action",
    "validate_action",
)
POLICY_ACTIONS = (
    "tissue_model_profiles",
    "tissue_model_status",
    "tissue_model_preview",
    "tissue_model_run",
    "task_preview_get",
)


def require(condition: Any, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256_file(path: str | Path) -> str:
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical_bytes(value: Any) -> bytes:
    from loci_engine.research_project import canonical_json

    return canonical_json(value).encode("utf-8")


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def write_json(path: str | Path, value: Any, *, mode: int | None = None) -> None:
    target = Path(path)
    text = json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n"
    target.write_text(text, encoding="utf-8")
    if mode is not None and os.name == "posix":
        os.chmod(target, mode)


def read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def default_inputs_manifest(repo: Path) -> Path:
    local_manifest = repo / ".loci/evidence/2026-11-02/tissue-final-qualification/INPUTS.json"
    if local_manifest.is_file():
        data = read_json(local_manifest)
        if "original_inputs" in data:
            candidate = Path(data["original_inputs"])
            if candidate.is_file():
                if "original_inputs_sha256" in data:
                    require(
                        sha256_file(candidate) == data["original_inputs_sha256"],
                        "Original inputs manifest hash mismatch",
                    )
                return candidate
        return local_manifest
    raise FileNotFoundError("Supply --inputs-manifest or a repository-local ignored INPUTS.json")


def resolve_authorized_inputs(repo: Path, manifest_path: Path | None = None) -> dict[str, Any]:
    path = (manifest_path or default_inputs_manifest(repo)).resolve(strict=True)
    raw = read_json(path)
    if "original_inputs" in raw and "inputs" not in raw:
        path = Path(raw["original_inputs"]).resolve(strict=True)
        raw = read_json(path)
    inputs = raw.get("inputs", raw.get("authorized_public_inputs", raw))
    expected = {
        "source": SOURCE_SHA,
        "weights": WEIGHTS_SHA,
        "conversion_receipt": CONVERSION_SHA,
        "reference_receipt": REFERENCE_RECEIPT_SHA,
        "reference_classes": REFERENCE_CLASSES_FILE_SHA,
        "reference_probabilities": REFERENCE_PROBABILITIES_FILE_SHA,
    }
    verified: dict[str, dict[str, Any]] = {}
    for key, expected_sha in expected.items():
        require(key in inputs, f"Authorized inputs manifest is missing {key}")
        entry = inputs[key]
        file_path = Path(entry["path"]).resolve(strict=True)
        actual_sha = sha256_file(file_path)
        require(
            actual_sha == expected_sha == entry["sha256"],
            f"Authorized public input hash mismatch for {key}",
        )
        verified[key] = {
            "path": str(file_path),
            "sha256": actual_sha,
            "bytes": file_path.stat().st_size,
        }
    return {"manifest_path": str(path), "manifest_sha256": sha256_file(path), "files": verified}


def tracked_source_hashes(repo: Path) -> dict[str, str]:
    tracked = (
        "engine/src/loci_engine/agent_actions.py",
        "engine/src/loci_engine/agent_policy.py",
        "engine/src/loci_engine/agent_sessions.py",
        "engine/src/loci_engine/agent_shared_workflows.py",
        "engine/src/loci_engine/agent_study.py",
        "engine/src/loci_engine/puma_architecture.py",
        "engine/src/loci_engine/puma_backend.py",
        "engine/src/loci_engine/research_action_registry.py",
        "engine/src/loci_engine/research_agent_setup.py",
        "engine/src/loci_engine/research_export.py",
        "engine/src/loci_engine/research_mcp.py",
        "engine/src/loci_engine/research_task_preview.py",
        "engine/src/loci_engine/research_tissue_integration.py",
        "engine/src/loci_engine/research_tissue_models.py",
        "engine/src/loci_engine/tissue_model_profiles.py",
        "engine/src/loci_engine/tissue_model_store.py",
        "engine/src/loci_engine/workbench.py",
        "scripts/qa/tissue_model_journey.py",
    )
    hashes = {rel: sha256_file(repo / rel) for rel in tracked}
    hashes["scripts/qa/codex-tissue.py"] = sha256_file(Path(__file__).resolve())
    return hashes


def inspect_worker_and_app(
    worker_path: Path,
    app_path: Path | None = None,
    expected_worker_sha256: str | None = None,
) -> dict[str, Any]:
    worker = worker_path.expanduser().resolve(strict=True)
    require(
        worker.is_file() and os.access(worker, os.X_OK),
        "Choose an executable worker binary",
    )
    worker_sha = sha256_file(worker)
    if expected_worker_sha256 is not None:
        require(
            worker_sha == expected_worker_sha256,
            "Frozen worker SHA-256 does not match expected pin",
        )
    resolved_app = app_path
    if resolved_app is None and len(worker.parents) >= 4:
        candidate = worker.parents[3]
        if candidate.suffix == ".app" and (
            (candidate / "Contents/Resources/loci-build-identity.json").is_file()
            or (candidate / "Contents/Resources/build-meta.json").is_file()
        ):
            resolved_app = candidate
    info: dict[str, Any] = {
        "worker_path": str(worker),
        "worker_sha256": worker_sha,
    }
    if resolved_app is not None:
        app = resolved_app.expanduser().resolve(strict=True)
        require(worker.is_relative_to(app), "Worker is outside selected app bundle")
        meta_path = app / "Contents/Resources/loci-build-identity.json"
        if not meta_path.is_file():
            meta_path = app / "Contents/Resources/build-meta.json"
        exe_path = app / "Contents/MacOS/Loci"
        asar_path = app / "Contents/Resources/app.asar"
        require(
            meta_path.is_file() and exe_path.is_file() and asar_path.is_file(),
            "App bundle is missing build identity metadata, executable, or app.asar",
        )
        info["app"] = {
            "path": str(app),
            "build_meta": read_json(meta_path),
            "build_meta_sha256": sha256_file(meta_path),
            "executable_sha256": sha256_file(exe_path),
            "asar_sha256": sha256_file(asar_path),
        }
    return info


def prepare_output_directory(repo: Path, output: Path, *, allow_test_output: bool = False) -> Path:
    target = output.expanduser().absolute()
    require(
        target.parent.resolve(strict=True) == target.parent,
        "Output parent directory must exist and be canonical",
    )
    if not allow_test_output:
        evidence_root = (repo / ".loci/evidence").resolve(strict=True)
        require(
            target.is_relative_to(evidence_root),
            "Output directory must reside under repository-local .loci/evidence",
        )
    target.mkdir(mode=0o700, exist_ok=False)
    return target


def runtime_identity() -> dict[str, str]:
    from loci_engine.agent_policy import _RUNTIME_KEYS
    from loci_engine.workbench import runtime_record

    record = runtime_record()
    return {key: record[key] for key in _RUNTIME_KEYS}


def build_tissue_request(source_id: str, profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_id": source_id,
        "source_sha256": SOURCE_SHA,
        "series": 0,
        "context_selection": copy.deepcopy(CONTEXT_SELECTION),
        "output_selection": copy.deepcopy(OUTPUT_SELECTION),
        "declared_stain": "hematoxylin-eosin",
        "profile_id": profile["id"],
        "profile_contract_sha256": profile["contract_sha256"],
        "runtime_contract_sha256": value_sha256(profile["runtime"]),
        "weights_sha256": profile["model"]["sha256"],
        "rgb_policy": profile["input"]["rgb_policy"],
        "working_bytes": profile["resources"]["minimum_working_bytes"],
    }


def build_policy_specification(
    source_id: str,
    profile: dict[str, Any],
    *,
    expires_at: str,
    delegation_id: str | None = None,
) -> dict[str, Any]:
    from loci_engine import research_tissue_integration as integration
    from loci_engine.agent_policy import DISCLOSURES

    min_bytes = int(profile["resources"]["minimum_working_bytes"])
    return {
        "sources": [
            {
                "id": source_id,
                "sha256": SOURCE_SHA,
                "crop": {"x": 0, "y": 0, "width": 1024, "height": 1024},
                "t": [0],
                "c": [0],
                "z": [0],
                "level": [0],
                "measurement_channels": [0],
            }
        ],
        "tissue_outputs": [
            {
                "source_id": source_id,
                "source_sha256": SOURCE_SHA,
                "output_selection": copy.deepcopy(OUTPUT_SELECTION),
            }
        ],
        "recipes": [],
        "operations": sorted(POLICY_OPERATIONS),
        "model_packages": [
            {
                "id": profile["model"]["artifact_id"],
                "sha256": profile["model"]["sha256"],
            }
        ],
        "runtimes": [integration.policy_runtime(), runtime_identity()],
        "export": None,
        "limits": {
            "cpu_seconds": 180,
            "memory_bytes": min_bytes,
            "concurrency": 1,
        },
        "disclosures": sorted(DISCLOSURES),
        "remote_grants": [],
        "experimental_recipes": [],
        "delegation": {
            "id": delegation_id or uuid.uuid4().hex,
            "client_id": DELEGATION_CLIENT_ID,
            "expires_at": expires_at,
            "result_scope": "granted-sources",
        },
        "actions": list(POLICY_ACTIONS),
    }


def build_host_prompt(
    source_id: str,
    tissue_request: dict[str, Any],
    denied_request: dict[str, Any],
) -> str:
    lines = [
        f"Exercise the Loci PUMA tissue model qualification sequence using ONLY {SERVER} tools.",
        "NO shell, file reads/writes, browsing, other MCP servers, plugins, plans, or subagents.",
        "Make EVERY tool call serially, awaiting its response before the next (concurrency=1).",
        (
            "For EVERY durable job, poll job_status until state == 'succeeded' AND "
            "owned_worker_active == false."
        ),
        "Stop and report any unexpected tool error, including job_status errors.",
        "While an owned worker is active, ONLY job_status calls for that job_id are permitted.",
        "There is NO export or filesystem path grant. Native export and cold-reopen run later.",
        (
            "Your review authority is AGENT technical review of the deterministic "
            "engineering fixture "
            "only — never human scientific approval, clinical validation, or biological accuracy."
        ),
        "",
        "Execute these exact steps in order:",
        '1. Call action_guide with {"operation": "tissue_model_preview"}.',
        '2. Call analysis_context with {"offset": 0, "limit": 50}.',
        f'3. Call inspect_source with {{"source_id": "{source_id}"}} and confirm verified == true.',
        '4. Call validate_action then inspect_action for "tissue_model_profiles" with request {}.',
        (
            '5. Call validate_action then inspect_action for "tissue_model_status" with '
            "tissue_request."
        ),
        (
            "6. Bounded negative authority check: call submit_action for "
            '"tissue_model_preview" with '
            f'the exact denied_request below and request_key "{DENIED_KEY}". Confirm the tool call '
            "returns an error before any execution or job creation, and do not retry it."
        ),
        '7. Call validate_action for operation "tissue_model_preview" with tissue_request.',
        (
            '8. Call submit_action for operation "tissue_model_preview" with tissue_request and '
            f'request_key "{PREVIEW_KEY}". Poll job_status until state == "succeeded" AND '
            "owned_worker_active == false. Then replay submit_action once with the exact same "
            f'tissue_request and request_key "{PREVIEW_KEY}" and confirm the same job ID '
            "is returned."
        ),
        (
            '9. Call inspect_action for operation "task_preview_get" with '
            '{"job_id": "<preview_job_id>"} and extract only the token '
            '{"preview_id": ..., "preview_hash": ...} from preview.output.'
        ),
        '10. Call validate_action for "tissue_model_run" with that {"preview_id", "preview_hash"}.',
        (
            '11. Call submit_action for operation "tissue_model_run" with that exact token and '
            f'request_key "{RUN_KEY}". Poll job_status until state == "succeeded" AND '
            "owned_worker_active == false. Then replay submit_action once with the "
            "exact same token "
            f'and request_key "{RUN_KEY}" and confirm the same job ID and result ID are returned.'
        ),
        '12. Call result with {"result_id": "<adopted_result_id>"} (no pagination overrides).',
        '13. Call result_view three times on "<adopted_result_id>" and inspect the PNG images:',
        '    a) {"result_id": "<adopted_result_id>", "label_field": "tissue_classes"}',
        '    b) {"result_id": "<adopted_result_id>", "label_field": "compartments"}',
        '    c) {"result_id": "<adopted_result_id>", "labels": false}',
        (
            '14. Call review_history with {"result_id": "<adopted_result_id>"} and confirm '
            "current_review_sha256 is null."
        ),
        (
            '15. Call review_result once with {"request": {"result_id": "<adopted_result_id>", '
            '"revision_hash": "<adopted_revision_hash>", "disposition": "reviewed", '
            '"reason": "AGENT technical verification of deterministic PUMA tissue-model output on '
            'public TRAINING004 fixture; not human or biological validation.", '
            '"coverage": "64x64 output ROI at (960,0) with full 1024x1024 normalization context; '
            "inspected tissue_classes, compartments, and epidermis_score views and geometry-only "
            'measurements.", "expected_review_sha256": null}}.'
        ),
        (
            "16. Report the preview and run job IDs, preview_id/preview_hash, "
            "result_id/revision_hash, "
            "region count, array hashes, and explicit scientific limits (scores are uncalibrated, "
            "class-4 is not a basal boundary, stroma is not dermis, TRAINING004 is not holdout)."
        ),
    ]
    payload = {
        "source_id": source_id,
        "denied_request_key": DENIED_KEY,
        "denied_request": denied_request,
        "preview_request_key": PREVIEW_KEY,
        "run_request_key": RUN_KEY,
        "tissue_request": tissue_request,
    }
    return "\n".join(lines) + "\n\n" + json.dumps(payload, indent=2, sort_keys=True) + "\n"


def build_codex_command(
    codex_executable: str,
    worker: Path,
    policy_path: Path,
    model_home: Path,
    answer_path: Path,
    *,
    model: str = "gpt-6.1-sol",
    effort: str = "high",
) -> list[str]:
    server = f"mcp_servers.{SERVER}."
    overrides = {
        "model_reasoning_effort": effort,
        "service_tier": "default",
        "approval_policy": "never",
        server + "command": str(worker),
        server + "args": ["--cli", "mcp", "--policy", str(policy_path)],
        server + "env.LOCI_MODEL_HOME": str(model_home),
        server + "required": True,
        server + "startup_timeout_sec": 60,
        server + "tool_timeout_sec": 180,
        server + "default_tools_approval_mode": "auto",
    }
    command = [
        codex_executable,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "--model",
        model,
    ]
    for key, value in overrides.items():
        command.extend(["-c", f"{key}={json.dumps(value)}"])
    command.extend(["-o", str(answer_path), "-"])
    return command


def _ensure_repo_imports(repo: Path | None = None) -> None:
    root = (repo or Path(__file__).resolve().parents[2]).resolve(strict=True)
    for candidate in (str(root), str(root / "engine/src")):
        if candidate not in sys.path:
            sys.path.insert(0, candidate)


def prepare_phase(
    *,
    repo: Path,
    worker: Path,
    output: Path,
    app: Path | None = None,
    expected_worker_sha256: str | None = None,
    inputs_manifest: Path | None = None,
    model: str = "gpt-6.1-sol",
    effort: str = "high",
    allow_test_output: bool = False,
) -> dict[str, Any]:
    """Prepare isolated study, managed model home, and minimal v6 policy without launching Codex."""
    _ensure_repo_imports(repo)
    from loci_engine import research_tissue_integration as integration
    from loci_engine.agent_policy import load_policy, write_policy
    from loci_engine.agent_sessions import register_policy
    from loci_engine.research_project import ResearchProject
    from loci_engine.tissue_model_profiles import puma_profile
    from loci_engine.workbench import Workbench

    worker_info = inspect_worker_and_app(worker, app, expected_worker_sha256)
    authorized_inputs = resolve_authorized_inputs(repo, inputs_manifest)
    source_hashes = tracked_source_hashes(repo)
    output_dir = prepare_output_directory(repo, output, allow_test_output=allow_test_output)

    inputs_dir = output_dir / "inputs"
    models_dir = output_dir / "models"
    study_parent = output_dir / "study"
    access_dir = output_dir / "access"
    for folder in (inputs_dir, study_parent, access_dir):
        folder.mkdir(mode=0o700)

    source_copy = inputs_dir / "TRAINING004.tif"
    shutil.copyfile(authorized_inputs["files"]["source"]["path"], source_copy)
    require(sha256_file(source_copy) == SOURCE_SHA, "Copied source SHA-256 mismatch")

    previous_model_home = os.environ.get("LOCI_MODEL_HOME")
    os.environ["LOCI_MODEL_HOME"] = str(models_dir)
    try:
        before_profiles = integration.profiles()["profiles"]
        require(
            len(before_profiles) == 1 and before_profiles[0]["store"]["state"] == "missing",
            "Isolated model store did not start in the missing state",
        )
        profile = puma_profile()
        require(
            before_profiles[0]["profile"] == profile,
            "PUMA profile catalogue entry drifted",
        )
        after_import = integration.native_import(
            {
                "profile_id": profile["id"],
                "weights_path": authorized_inputs["files"]["weights"]["path"],
                "receipt_path": authorized_inputs["files"]["conversion_receipt"]["path"],
            }
        )["profiles"]
        require(
            after_import[0]["store"]["state"] == "provisioned-unverified",
            "Native model provisioning into isolated store did not reach provisioned-unverified",
        )
    finally:
        if previous_model_home is None:
            os.environ.pop("LOCI_MODEL_HOME", None)
        else:
            os.environ["LOCI_MODEL_HOME"] = previous_model_home

    study_path = study_parent / "TRAINING004.loci-study"
    project = ResearchProject.create(study_path, title="Public TRAINING004 tissue agent QA")
    wb = Workbench(project)
    try:
        source_record = wb.import_native(str(source_copy))
        require(
            source_record["sha256"] == SOURCE_SHA,
            "Imported study source SHA-256 mismatch",
        )
        require(
            project.list_results() == [] and project.list_jobs() == [],
            "Fresh prepared study unexpectedly contains results or jobs",
        )
    finally:
        wb.close()

    expires_at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    delegation_id = uuid.uuid4().hex
    policy_spec = build_policy_specification(
        source_record["id"], profile, expires_at=expires_at, delegation_id=delegation_id
    )
    policy_path = access_dir / "agent-policy.json"
    policy_receipt = write_policy(policy_path, project, policy_spec)
    loaded_policy = load_policy(policy_path)
    register_policy(
        project,
        loaded_policy,
        permission_mode="full_access",
        bundle_name="access",
    )

    tissue_request = build_tissue_request(source_record["id"], profile)
    denied_request = {**tissue_request, "working_bytes": 4 * 1024**3}
    prompt_text = build_host_prompt(source_record["id"], tissue_request, denied_request)
    prompt_path = output_dir / "prompt.txt"
    prompt_path.write_text(prompt_text, encoding="utf-8")
    os.chmod(prompt_path, 0o600)

    mcp_config = {
        "mcpServers": {
            SERVER: {
                "command": worker_info["worker_path"],
                "args": ["--cli", "mcp", "--policy", str(policy_path)],
                "env": {"LOCI_MODEL_HOME": str(models_dir)},
            }
        }
    }
    write_json(access_dir / "mcp-config.json", mcp_config, mode=0o600)

    codex_template = build_codex_command(
        "codex",
        Path(worker_info["worker_path"]),
        policy_path,
        models_dir,
        output_dir / "answer.txt",
        model=model,
        effort=effort,
    )
    prepared = {
        "schema": "loci.codex-tissue-prepared/v1",
        "prepared_at": datetime.now(UTC).isoformat(),
        "status": "prepared-ready-for-host-or-sdk",
        "codex_launched": False,
        "repo": str(repo),
        "output": str(output_dir),
        "study": str(study_path),
        "project_id": project.meta["project_id"],
        "source_copy": str(source_copy),
        "source_id": source_record["id"],
        "source_sha256": SOURCE_SHA,
        "model_home": str(models_dir),
        "policy_path": str(policy_path),
        "policy_sha256": policy_receipt["policy_sha256"],
        "policy_schema": policy_receipt["schema"],
        "delegation_id": delegation_id,
        "delegation_expires_at": expires_at,
        "worker": worker_info,
        "authorized_inputs": authorized_inputs,
        "source_hashes": source_hashes,
        "model_files_sha256": tree_hashes(models_dir),
        "tissue_request": tissue_request,
        "denied_request": denied_request,
        "keys": {
            "denied": DENIED_KEY,
            "preview": PREVIEW_KEY,
            "run": RUN_KEY,
        },
        "prompt_path": str(prompt_path),
        "prompt_sha256": sha256_file(prompt_path),
        "model_requested": model,
        "effort_requested": effort,
        "service_tier_requested": "default (Standard)",
        "host_command_template": codex_template,
        "lead_run_command": [
            str(repo / "engine/.venv/bin/python"),
            "-I",
            str(Path(__file__).resolve()),
            "run-host",
            "--output",
            str(output_dir),
            "--model",
            model,
            "--effort",
            effort,
        ],
    }
    write_json(output_dir / "prepared-fixture.json", prepared, mode=0o600)
    write_json(output_dir / "receipt.json", prepared, mode=0o600)
    return prepared


def extract_structured(call: dict[str, Any], *, expect_error: bool = False) -> dict[str, Any]:
    result = call.get("result") or {}
    is_err = bool(call.get("error") or result.get("isError") or result.get("is_error"))
    # Codex represents an MCP tool-result error as a terminal failed item and
    # omits isError. Accept that shape only for the exact planned negative call;
    # transport errors and all other failed calls remain disqualifying.
    content = result.get("content", [])
    host_denial = (
        expect_error
        and call.get("status") == "failed"
        and call.get("tool") == "submit_action"
        and call.get("arguments", {}).get("operation") == "tissue_model_preview"
        and call.get("arguments", {}).get("request_key") == DENIED_KEY
        and call.get("error") is None
        and result.get("structuredContent", result.get("structured_content")) is None
        and len(content) == 1
        and content[0].get("type") == "text"
        and content[0].get("text", "").startswith("Error executing tool submit_action:")
    )
    require(
        call.get("status") == "completed" or host_denial,
        f"Incomplete MCP tool call: {call.get('tool')}",
    )
    is_err = is_err or host_denial
    if expect_error:
        require(is_err, f"Expected negative authority check {call.get('tool')} to fail closed")
        texts = [
            item.get("text", "")
            for item in result.get("content", [])
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        return {"is_error": True, "messages": texts}
    require(not is_err, f"MCP call failed unexpectedly: {call.get('tool')}")
    value = result.get("structuredContent", result.get("structured_content"))
    if value is None:
        texts = [
            item.get("text", "")
            for item in result.get("content", [])
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        require(len(texts) == 1, f"MCP response for {call.get('tool')} has no JSON payload")
        value = json.loads(texts[0])
    require(
        isinstance(value, dict) and "error" not in value,
        f"MCP response returned error payload for {call.get('tool')}",
    )
    return value


def parse_transcript_events(
    events: list[dict[str, Any]], *, expect_mode: str
) -> tuple[list[dict[str, Any]], str]:
    require(events, "Transcript event list is empty")
    origins = {event.get("event_origin") for event in events if "event_origin" in event}
    if origins == {"python-mcp-sdk"}:
        detected_mode = "sdk"
    elif "simulated" in origins or any(event.get("simulated") for event in events):
        detected_mode = "simulated"
    else:
        require(
            not origins,
            f"Unexpected mixed or non-host event_origin markers: {sorted(map(str, origins))}",
        )
        require(
            any(event.get("type") == "turn.completed" for event in events),
            "Codex host transcript is missing turn.completed",
        )
        detected_mode = "codex-host"

    if expect_mode == "codex-host":
        require(
            not any(event.get("type", "").startswith("sdk.") for event in events),
            "SDK session events cannot qualify a Codex host",
        )
        require(
            detected_mode == "codex-host",
            "SDK or simulated transcripts cannot qualify a Codex host",
        )
    elif expect_mode == "sdk":
        require(
            detected_mode == "sdk",
            f"Expected Python MCP SDK smoke transcript, got {detected_mode}",
        )
    elif expect_mode == "simulated":
        require(
            detected_mode == "simulated",
            f"Expected simulated transcript, got {detected_mode}",
        )
    else:
        raise ValueError(f"Unsupported expect_mode: {expect_mode}")

    allowed: dict[str, set[str] | None] = {
        "action_guide": None,
        "analysis_context": None,
        "inspect_source": None,
        "job_status": None,
        "result": None,
        "result_view": None,
        "review_history": None,
        "review_result": None,
        "validate_action": {
            "tissue_model_profiles",
            "tissue_model_status",
            "tissue_model_preview",
            "tissue_model_run",
        },
        "inspect_action": {
            "tissue_model_profiles",
            "tissue_model_status",
            "task_preview_get",
        },
        "submit_action": {
            "tissue_model_preview",
            "tissue_model_run",
        },
    }
    active: set[str] = set()
    started_items: dict[str, dict[str, Any]] = {}
    calls: list[dict[str, Any]] = []
    seen_jobs: set[str] = set()
    executing: str | None = None

    for event in events:
        require(
            event.get("type") not in {"error", "turn.failed"},
            "Transcript reported a failed turn or transport error",
        )
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        require(
            kind in {"reasoning", "agent_message", "mcp_tool_call"},
            f"Transcript bypassed MCP-only scope using item type {kind}",
        )
        if kind != "mcp_tool_call":
            continue
        require(
            item.get("server") == SERVER,
            f"Called unexpected MCP server {item.get('server')}",
        )
        require(
            event.get("type") in {"item.started", "item.completed"},
            "Unexpected MCP transcript event type",
        )
        call_id = item.get("id")
        require(isinstance(call_id, str) and call_id, "MCP tool call is missing a string id")
        if event.get("type") == "item.started":
            require(not active, "Overlapped MCP tool calls despite concurrency=1")
            require(call_id not in started_items, "Transcript reused MCP call ID")
            started_items[call_id] = item
            active.add(call_id)
        elif event.get("type") == "item.completed":
            require(
                active == {call_id},
                f"MCP completion {call_id} lacks matching serial item.started",
            )
            started = started_items[call_id]
            require(
                all(started.get(key) == item.get(key) for key in ("tool", "arguments", "server")),
                "MCP start/completion arguments differ",
            )
            active.clear()
            tool = item.get("tool")
            arguments = item.get("arguments")
            require(
                isinstance(tool, str) and tool in allowed and isinstance(arguments, dict),
                f"Unexpected MCP tool or malformed arguments: {tool}",
            )
            allowed_ops = allowed[tool]
            if allowed_ops is not None:
                require(
                    arguments.get("operation") in allowed_ops,
                    f"Unexpected operation {arguments.get('operation')} for tool {tool}",
                )
            is_denied_call = tool == "submit_action" and arguments.get("request_key") == DENIED_KEY
            require(
                item.get("status") == "completed"
                or (is_denied_call and item.get("status") == "failed"),
                "MCP call has non-completed status",
            )
            if executing is not None:
                require(
                    tool == "job_status" and arguments == {"job_id": executing},
                    "Issued another tool call before the active owned worker exited",
                )
            if is_denied_call:
                require(
                    not seen_jobs,
                    "Negative authority check must occur before any valid durable job submission",
                )
                extract_structured(item, expect_error=True)
            else:
                payload = extract_structured(item, expect_error=False)
                if tool == "submit_action":
                    job_id = payload["job"]["id"]
                    if job_id not in seen_jobs:
                        seen_jobs.add(job_id)
                        executing = job_id
                elif tool == "job_status":
                    job = payload["job"]
                    require(
                        job["id"] == arguments.get("job_id"),
                        "job_status returned a mismatched job ID",
                    )
                    require(
                        job["state"] in {"queued", "running", "succeeded"},
                        f"Owned job entered unexpected state {job['state']}",
                    )
                    if job["state"] == "succeeded" and job.get("owned_worker_active") is False:
                        executing = None
            calls.append(item)
    require(
        calls and not active and executing is None,
        "Transcript ended with unfinished MCP calls or an active owned worker",
    )
    return calls, detected_mode


def matching_calls(
    calls: list[dict[str, Any]], tool: str, operation: str | None = None
) -> list[dict[str, Any]]:
    return [
        call
        for call in calls
        if call.get("tool") == tool
        and (operation is None or call.get("arguments", {}).get("operation") == operation)
    ]


def verify_mcp_view_png(
    view_meta: dict[str, Any], png_bytes: bytes, arrays: dict[str, Any]
) -> None:
    import numpy as np
    from loci_engine.workbench import display_scalar
    from PIL import Image

    require(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"), "MCP result_view block is not PNG")
    actual = np.asarray(Image.open(io.BytesIO(png_bytes)))
    rgb, _ = display_scalar(arrays["image"])
    field = view_meta.get("field")
    if field == "epidermis_score":
        expected = np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    else:
        label_key = "class_labels" if field == "tissue_classes" else "labels"
        label_plane = arrays[label_key].astype(np.uint32)
        tint = np.stack(
            [(label_plane * multiplier % 223 + 32) / 255 for multiplier in (67, 97, 137)],
            axis=-1,
        )
        blended = np.where((label_plane > 0)[..., None], 0.6 * rgb + 0.4 * tint, rgb)
        expected = np.round(np.clip(blended, 0, 1) * 255).astype(np.uint8)
    np.testing.assert_array_equal(actual, expected)


def ColdRetainedSubprocessCheck(config_path: Path) -> int:
    """Subprocess entrypoint: verify retained result and views with Torch/source/model blocked."""
    config = read_json(config_path)
    repo = Path(config["repo"])
    output = Path(config["output"])
    _ensure_repo_imports(repo)
    original_import = builtins.__import__

    def forbid_torch(name: str, *args: Any, **kwargs: Any) -> Any:
        require(
            name != "torch" and not name.startswith("torch."),
            "Cold retained reopen unexpectedly imported Torch",
        )
        return original_import(name, *args, **kwargs)

    builtins.__import__ = forbid_torch
    import numpy as np
    from loci_engine import research_tissue_integration as integration
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    from scripts.qa.tissue_model_journey import check_views, load_array

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Cold retained reopen attempted raw source or model store access")

    integration.store.resolve_approved_weights = forbidden
    Workbench._session = forbidden
    require(
        not Path(config["registered_source"]).exists(),
        "Raw source copy is still online during cold retained check",
    )
    require(
        not Path(os.environ["LOCI_MODEL_HOME"]).exists(),
        "Cold retained check unexpectedly has an existing model store",
    )
    project = ResearchProject(config["study"])
    workbench = Workbench(project)
    try:
        expected = read_json(output / "exports/original/result.json")["result"]
        result = project.result(expected["id"])
        require(result == expected, "Cold reopen result record differs from exported bundle")
        review = project.review_state(result["id"])
        require(
            review is not None and review.get("disposition") == "reviewed",
            "Cold reopen lost its reviewed state",
        )
        arrays = {
            key: project.load_array(descriptor) for key, descriptor in result["arrays"].items()
        }
        for key, array in arrays.items():
            np.testing.assert_array_equal(
                array, load_array(output / "exports/original" / f"{key}.npy")
            )
        views_dir = output / "views"
        views_dir.mkdir(exist_ok=True)
        check_views(workbench.execute, result, arrays, views_dir, "cold-original")
    finally:
        workbench.close()
    report = {
        "schema": "loci.codex-tissue-cold-retained/v1",
        "verified_result_id": result["id"],
        "verified_revision_hash": result["revision_hash"],
        "source_decode": False,
        "model_access": False,
        "torch_import": False,
    }
    write_json(output / "cold-retained-check.json", report, mode=0o600)
    print(json.dumps(report), flush=True)
    return 0


def session_shutdown_evidence(session: dict[str, Any], *, expect_mode: str) -> dict[str, Any]:
    """Observe termination without rewriting the original host session record."""
    from loci_engine.resource_limits import process_alive

    state = session.get("state")
    if expect_mode == "codex-host":
        pid = session.get("private_pid")
        require(type(pid) is int and pid > 0, "Host session lacks a valid server PID")
        require(not process_alive(pid), "Host MCP server process is still running")
        unclean_idle = (
            state == "connected_idle"
            and session.get("current_operation") is None
            and session.get("active_approval_id") is None
            and session.get("last_error") is None
        )
        require(
            state == "disconnected" or unclean_idle,
            f"Host MCP session ended in an unexpected state: {state}",
        )
    else:
        require(state == "disconnected", f"MCP session did not disconnect cleanly (state={state})")
    return {
        "persisted_state": state,
        "clean_disconnect_recorded": state == "disconnected",
        "server_process_running": False if expect_mode == "codex-host" else None,
        "expected_reconciled_state": "disconnected" if state == "disconnected" else "interrupted",
    }


def verify_phase(
    *,
    output: Path,
    transcript_path: Path | None = None,
    expect_mode: str = "sdk",
    skip_native_export: bool = False,
    prepared_harness: Path | None = None,
) -> dict[str, Any]:
    """Read-only verification of transcript, retained state and previously generated artifacts."""
    _ensure_repo_imports()
    import numpy as np
    from loci_engine.research_project import ResearchProject

    from scripts.qa.tissue_model_journey import load_array

    output_dir = output.expanduser().resolve(strict=True)
    prepared = read_json(output_dir / "prepared-fixture.json")
    repo = Path(prepared["repo"]).resolve(strict=True)

    current_sources = tracked_source_hashes(repo)
    verifier_identity = validate_prepared_identity(
        output_dir, prepared, prepared_harness=prepared_harness
    )
    worker_path = Path(prepared["worker"]["worker_path"])

    # 2. Load and validate transcript events and mode separation.
    default_transcript = (
        output_dir / "codex-events.jsonl"
        if expect_mode == "codex-host"
        else output_dir / "sdk-events.jsonl"
    )
    selected_transcript = (transcript_path or default_transcript).expanduser().resolve(strict=True)
    events = [
        json.loads(line)
        for line in selected_transcript.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    calls, detected_mode = parse_transcript_events(events, expect_mode=expect_mode)

    # 3. Verify study database sessions, jobs, and results.
    study_path = Path(prepared["study"]).resolve(strict=True)
    project = ResearchProject(study_path)
    require(
        project.meta["project_id"] == prepared["project_id"],
        "Study project_id changed",
    )
    db_path = study_path / "study.sqlite3"
    with sqlite3.connect("file:" + quote(str(db_path)) + "?mode=ro", uri=True) as conn:
        session_rows = conn.execute(
            "SELECT value FROM metadata WHERE key LIKE 'agent-session:%'"
        ).fetchall()
    require(
        len(session_rows) == 1,
        f"Expected exactly one MCP session in study database, found {len(session_rows)}",
    )
    session_record = json.loads(session_rows[0][0])
    require(
        session_record.get("policy_sha256") == prepared["policy_sha256"],
        "Recorded MCP session belongs to a different policy",
    )
    if expect_mode == "codex-host":
        validate_host_binding(output_dir, prepared, selected_transcript, events, session_record)
    elif expect_mode == "sdk":
        require(
            session_record.get("client_id") == SDK_CLIENT_ID,
            f"Expected SDK client_id {SDK_CLIENT_ID}, got {session_record.get('client_id')}",
        )
    shutdown = session_shutdown_evidence(session_record, expect_mode=expect_mode)

    expected_owner = {
        "policy_sha256": prepared["policy_sha256"],
        "session_id": session_record["session_id"],
    }

    # 4. Verify discovery, status, and negative authority check calls.
    guide_calls = matching_calls(calls, "action_guide")
    require(len(guide_calls) == 1, "Expected one action_guide call")
    guide_payload = extract_structured(guide_calls[0])
    first_action = guide_payload["actions"][0]
    require(
        (first_action.get("operation") or first_action.get("name")) == "tissue_model_preview"
        and first_action["execution"] == "durable-task",
        "action_guide did not return the tissue_model_preview durable-task contract",
    )

    context_calls = matching_calls(calls, "analysis_context")
    require(len(context_calls) == 1, "Expected one analysis_context call")
    context_payload = extract_structured(context_calls[0])
    ctx_limits = context_payload.get("policy", {}).get("limits") or context_payload.get(
        "limits", {}
    )
    ctx_sources = context_payload.get("source_grants") or context_payload.get("sources", [])
    require(
        ctx_limits.get("concurrency") == 1
        and len(ctx_sources) == 1
        and (ctx_sources[0].get("source_id") or ctx_sources[0].get("id")) == prepared["source_id"],
        "analysis_context did not report the pinned source and concurrency=1",
    )

    source_calls = matching_calls(calls, "inspect_source")
    require(len(source_calls) == 1, "Expected one inspect_source call")
    source_payload = extract_structured(source_calls[0])
    require(
        source_payload.get("verified") is True
        and source_payload.get("source_id") == prepared["source_id"]
        and source_payload.get("source_sha256") == SOURCE_SHA,
        "inspect_source did not verify the exact PUBLIC TRAINING004 fingerprint",
    )

    profile_val = matching_calls(calls, "validate_action", "tissue_model_profiles")
    profile_ins = matching_calls(calls, "inspect_action", "tissue_model_profiles")
    require(
        len(profile_val) == 1
        and extract_structured(profile_val[0]).get("authorized") is True
        and len(profile_ins) == 1,
        "Expected validate_action and inspect_action for tissue_model_profiles",
    )
    profile_payload = extract_structured(profile_ins[0])["profiles"][0]
    require(
        profile_payload["store"]["state"] == "provisioned-unverified"
        and profile_payload["profile"]["contract_sha256"]
        == prepared["tissue_request"]["profile_contract_sha256"],
        "tissue_model_profiles did not report provisioned-unverified store and exact contract",
    )

    status_val = matching_calls(calls, "validate_action", "tissue_model_status")
    status_ins = matching_calls(calls, "inspect_action", "tissue_model_status")
    require(
        len(status_val) == 1
        and status_val[0]["arguments"].get("request") == prepared["tissue_request"]
        and extract_structured(status_val[0]).get("authorized") is True
        and len(status_ins) == 1
        and status_ins[0]["arguments"].get("request") == prepared["tissue_request"],
        "Expected exact validate_action and inspect_action for tissue_model_status",
    )
    status_payload = extract_structured(status_ins[0])
    model_exec = (
        status_payload.get("store", {}).get("model_execution_performed")
        if "store" in status_payload
        else status_payload.get("status", {}).get("model_execution_performed")
    )
    require(
        model_exec is False
        and status_payload.get("source_verification") == "registered-metadata-only",
        "tissue_model_status unexpectedly executed a model or decoded pixels",
    )

    denied_submits = [
        call
        for call in matching_calls(calls, "submit_action", "tissue_model_preview")
        if call["arguments"].get("request_key") == DENIED_KEY
    ]
    require(
        len(denied_submits) == 1
        and denied_submits[0]["arguments"].get("request") == prepared["denied_request"],
        "Missing exact bounded negative authority check call",
    )
    denied_info = extract_structured(denied_submits[0], expect_error=True)
    require(denied_info["is_error"] is True, "Negative authority check did not fail closed")

    # 5. Verify durable preview job + idempotent replay + task_preview_get.
    jobs = project.list_jobs()
    require(
        len(jobs) == 2 and all(j["request_key"] != DENIED_KEY for j in jobs),
        f"Expected exactly two durable jobs (preview and run) and no denied job, found {len(jobs)}",
    )

    def verify_durable_action(
        operation: str, expected_request: dict[str, Any], key: str
    ) -> dict[str, Any]:
        validations = [
            call
            for call in matching_calls(calls, "validate_action", operation)
            if call["arguments"].get("request") == expected_request
        ]
        require(
            len(validations) == 1 and extract_structured(validations[0]).get("authorized") is True,
            f"Missing exact validate_action for {operation}",
        )
        submits = [
            call
            for call in matching_calls(calls, "submit_action", operation)
            if call["arguments"].get("request_key") == key
        ]
        require(
            len(submits) == 2 and submits[0]["arguments"] == submits[1]["arguments"],
            f"Expected initial submit_action and one exact idempotent replay for {key}",
        )
        require(
            submits[0]["arguments"]
            == {
                "operation": operation,
                "request": expected_request,
                "request_key": key,
            },
            f"submit_action arguments drifted for {operation}",
        )
        first_job = extract_structured(submits[0])["job"]
        replay_job = extract_structured(submits[1])["job"]
        require(
            first_job["id"] == replay_job["id"],
            f"Idempotent replay for {key} created a different job ID",
        )
        job = project.job(first_job["id"])
        normalized = {
            "source_id": prepared["source_id"],
            "task_request": expected_request,
        }
        require(
            job["operation"] == operation
            and job["request_key"] == key
            and job["request"] == normalized
            and job["request_hash"] == value_sha256({"operation": operation, "request": normalized})
            and job["state"] == "succeeded"
            and job["owner"] == expected_owner,
            f"Durable job record or ownership mismatch for {operation}",
        )
        ok_status_calls = [
            call
            for call in matching_calls(calls, "job_status")
            if call["arguments"] == {"job_id": job["id"]}
            and not bool(
                call.get("error")
                or (call.get("result") or {}).get("isError")
                or (call.get("result") or {}).get("is_error")
            )
        ]
        statuses = [extract_structured(call)["job"] for call in ok_status_calls]
        require(
            any(
                s["state"] == "succeeded" and s.get("owned_worker_active") is False
                for s in statuses
            ),
            "Transcript did not observe state=='succeeded' and "
            f"owned_worker_active==False for {operation}",
        )
        first_submit_idx = calls.index(submits[0])
        replay_submit_idx = calls.index(submits[1])
        done_status_idx = min(
            calls.index(call)
            for call in ok_status_calls
            if extract_structured(call)["job"]["state"] == "succeeded"
            and extract_structured(call)["job"].get("owned_worker_active") is False
        )
        require(
            first_submit_idx < done_status_idx < replay_submit_idx,
            f"Replay for {key} must occur after observing owned worker exit",
        )
        return job

    preview_job = verify_durable_action(
        "tissue_model_preview", prepared["tissue_request"], PREVIEW_KEY
    )
    require(
        preview_job["result_ids"] == [],
        "tissue_model_preview unexpectedly published an adopted result",
    )

    preview_gets = matching_calls(calls, "inspect_action", "task_preview_get")
    require(
        len(preview_gets) == 1
        and preview_gets[0]["arguments"].get("request") == {"job_id": preview_job["id"]},
        "Missing exact task_preview_get inspection for preview job",
    )
    preview_record = extract_structured(preview_gets[0])["preview"]
    require(
        preview_record["schema"] == "loci.task-preview/v1"
        and preview_record["job_id"] == preview_job["id"]
        and preview_record["adopted"] is False,
        "task_preview_get returned invalid preview record",
    )
    preview_output = preview_record["output"]
    overlay_url = preview_output.get("overlay_png", "")
    require(
        isinstance(overlay_url, str) and overlay_url.startswith("data:image/png;base64,"),
        "task_preview_get output is missing overlay_png data URL",
    )
    overlay_bytes = base64.b64decode(overlay_url.split(",", 1)[1], validate=True)
    require(
        overlay_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
        "task_preview_get overlay_png is not a valid PNG",
    )
    token = {
        "preview_id": preview_output["preview_id"],
        "preview_hash": preview_output["preview_hash"],
    }

    # 6. Verify token-only tissue_model_run + idempotent replay + adopted result.
    run_job = verify_durable_action("tissue_model_run", token, RUN_KEY)
    require(
        len(run_job["result_ids"]) == 1,
        "tissue_model_run did not publish exactly one adopted result",
    )
    result_id = run_job["result_ids"][0]
    results = project.list_results()
    require(
        len(results) == 1 and results[0]["id"] == result_id,
        "Study contains unexpected extra results",
    )
    adopted = project.result(result_id)
    require(
        adopted["kind"] == "tissue-model-regions"
        and adopted["source_id"] == prepared["source_id"]
        and adopted["source_sha256"] == SOURCE_SHA
        and adopted["provenance"]["job_id"] == run_job["id"]
        and adopted["provenance"]["tissue_model"]["preview"] == token,
        "Adopted tissue result provenance or preview token binding drifted",
    )

    # 7. Verify retained arrays against exact reference hashes and values.
    require(
        set(adopted["arrays"]) == set(EXPECTED_RESULT_ARRAY_SHAS),
        "Adopted tissue result array keys changed",
    )
    loaded_arrays: dict[str, Any] = {}
    artifact_file_hashes: dict[str, str] = {}
    for key, expected_sha in EXPECTED_RESULT_ARRAY_SHAS.items():
        descriptor = adopted["arrays"][key]
        npy_path = study_path / "artifacts" / f"{descriptor['sha256']}.npy"
        actual_sha = sha256_file(npy_path)
        require(
            actual_sha == descriptor["sha256"] == expected_sha,
            f"Retained NPY file hash mismatch for {key}",
        )
        artifact_file_hashes[key] = actual_sha
        loaded_arrays[key] = load_array(npy_path)

    ref_receipt = read_json(prepared["authorized_inputs"]["files"]["reference_receipt"]["path"])[
        "backend"
    ]
    ref_classes = load_array(
        Path(prepared["authorized_inputs"]["files"]["reference_classes"]["path"]),
        ref_receipt["artifacts"]["class_labels"],
    )
    ref_probs = load_array(
        Path(prepared["authorized_inputs"]["files"]["reference_probabilities"]["path"]),
        ref_receipt["artifacts"]["probabilities"],
    )
    require(
        loaded_arrays["class_labels"].tobytes() == ref_classes.tobytes()
        and hashlib.sha256(loaded_arrays["class_labels"].tobytes()).hexdigest()
        == REFERENCE_ARRAY_RAW_SHAS["class_labels"],
        "Retained class_labels array is not bitwise equal to reference",
    )
    require(
        loaded_arrays["probabilities"].tobytes() == ref_probs.tobytes()
        and hashlib.sha256(loaded_arrays["probabilities"].tobytes()).hexdigest()
        == REFERENCE_ARRAY_RAW_SHAS["probabilities"],
        "Retained probabilities array is not bitwise equal to reference",
    )
    require(
        loaded_arrays["image"].tobytes() == ref_probs[4].tobytes(),
        "Retained score plane is not bitwise equal to reference class-4 probability plane",
    )
    np.testing.assert_array_equal(loaded_arrays["labels"] > 0, loaded_arrays["class_labels"] == 4)

    # 8. Verify result read and all three retained result_view calls + PNG image blocks.
    result_calls = matching_calls(calls, "result")
    require(
        len(result_calls) == 1 and result_calls[0]["arguments"] == {"result_id": result_id},
        "Expected one exact result read call",
    )
    result_payload = extract_structured(result_calls[0])
    require(
        result_payload["result"]["id"] == result_id
        and result_payload["result"]["revision_hash"] == adopted["revision_hash"]
        and result_payload["result"]["tissue_model"]["preview"] == token
        and all(row["intensity"] == {} for row in result_payload["measurements"]),
        "result tool payload did not match adopted revision or fabricated intensity measurements",
    )

    view_calls = matching_calls(calls, "result_view")
    require(len(view_calls) == 3, f"Expected 3 result_view calls, found {len(view_calls)}")
    mcp_views_dir = output_dir / "mcp-views"
    observed_fields: dict[str, dict[str, Any]] = {}
    for call in view_calls:
        require(
            call["arguments"].get("result_id") == result_id,
            "result_view targeted an unexpected result_id",
        )
        view_meta = extract_structured(call)
        field = view_meta.get("field")
        require(
            field in EXPECTED_VIEWS and field not in observed_fields,
            f"Unexpected or duplicate result_view field {field}",
        )
        require(
            view_meta.get("revision_hash") == adopted["revision_hash"],
            f"result_view {field} revision_hash mismatch",
        )
        blocks = [
            item
            for item in (call.get("result") or {}).get("content", [])
            if isinstance(item, dict) and item.get("type") == "image"
        ]
        require(len(blocks) == 1, f"Expected 1 MCP PNG image block for result_view {field}")
        block = blocks[0]
        require(
            block.get("mimeType") == "image/png",
            f"Unexpected MIME type {block.get('mimeType')} for result_view {field}",
        )
        png_bytes = base64.b64decode(block["data"], validate=True)
        verify_mcp_view_png(view_meta, png_bytes, loaded_arrays)
        png_file = mcp_views_dir / f"mcp-{field}.png"
        observed_fields[field] = {
            "field": field,
            "basis": view_meta.get("basis"),
            "png_file": str(png_file.relative_to(output_dir)),
            "png_sha256": hashlib.sha256(png_bytes).hexdigest(),
        }
    require(
        set(observed_fields) == set(EXPECTED_VIEWS),
        "Transcript omitted one of the required retained result_view fields",
    )

    # 9. Verify review_history before review_result and exact agent review state.
    history_calls = matching_calls(calls, "review_history")
    review_calls = matching_calls(calls, "review_result")
    require(
        len(history_calls) == 1 and len(review_calls) == 1,
        "Expected one review_history call and one review_result call",
    )
    require(
        calls.index(history_calls[0]) < calls.index(review_calls[0]),
        "review_history must be inspected before calling review_result",
    )
    require(
        history_calls[0]["arguments"] == {"result_id": result_id}
        and extract_structured(history_calls[0])
        == {
            "events": [],
            "total_events": 0,
            "next_offset": None,
            "current_review_sha256": None,
            "assessment_disclosed": True,
        },
        "Pre-review review_history did not report an unreviewed result",
    )
    review_payload = extract_structured(review_calls[0])["review"]
    stored_review = project.review_state(result_id)
    require(
        stored_review is not None
        and review_payload == stored_review
        and stored_review["actor"] == "agent"
        and stored_review["actor_id"] == DELEGATION_CLIENT_ID
        and stored_review["disposition"] == "reviewed"
        and stored_review["revision_hash"] == adopted["revision_hash"]
        and stored_review["authority"]
        == {
            "kind": "policy-delegation",
            "policy_sha256": prepared["policy_sha256"],
            "delegation_id": prepared["delegation_id"],
            "client_id": DELEGATION_CLIENT_ID,
        },
        "Recorded review is not the exact policy-bound AGENT review decision",
    )

    require(
        len(matching_calls(calls, "submit_action")) == 5,
        "Unexpected mutating submit_action calls (expected 1 denied + 2 preview + 2 run)",
    )

    # Verification only reads accepted artifacts. Explicit finalize-artifacts creates them.
    native_export_info = None
    cold_reopen_info = None
    if not skip_native_export:
        artifacts = read_json(output_dir / "artifact-generation.json")
        require(
            artifacts["transcript_sha256"] == sha256_file(selected_transcript)
            and artifacts["policy_sha256"] == prepared["policy_sha256"]
            and artifacts["result_id"] == result_id
            and artifacts["revision_hash"] == adopted["revision_hash"],
            "Generated artifact binding differs from this transcript/result",
        )
        for relative, digest in artifacts["files_sha256"].items():
            artifact = (output_dir / relative).resolve(strict=True)
            require(artifact.is_relative_to(output_dir), "Artifact path escaped output")
            require(
                sha256_file(artifact) == digest,
                f"Generated artifact changed: {relative}",
            )
        for field, view in observed_fields.items():
            require(
                artifacts["files_sha256"].get(view["png_file"]) == view["png_sha256"],
                f"Saved MCP view differs from transcript: {field}",
            )
        native_export_info = artifacts["native_export"]
        cold_reopen_info = artifacts["cold_reopen"]
        exported = read_json(output_dir / "exports/original/result.json")
        require(
            exported["result"] == adopted and exported["review"] == stored_review,
            "Export result/review differs from retained state",
        )
        for key, array in loaded_arrays.items():
            relative = f"exports/original/{key}.npy"
            require(relative in artifacts["files_sha256"], f"Missing export array binding: {key}")
            np.testing.assert_array_equal(array, load_array(output_dir / relative))
        require(
            cold_reopen_info == read_json(output_dir / "cold-retained-check.json")
            and cold_reopen_info["verified_result_id"] == result_id
            and cold_reopen_info["verified_revision_hash"] == adopted["revision_hash"]
            and all(
                cold_reopen_info.get(key) is False
                for key in ("source_decode", "model_access", "torch_import")
            ),
            "Cold retained artifact binding differs from current result",
        )

    # Final post-verification immutability check.
    require(
        sha256_file(worker_path) == prepared["worker"]["worker_sha256"]
        and tracked_source_hashes(repo) == current_sources,
        "Worker or source files drifted during verification",
    )

    evidence_kind = (
        "codex-host"
        if detected_mode == "codex-host"
        else "mcp-sdk-smoke"
        if detected_mode == "sdk"
        else "simulated-non-qualifying"
    )
    verification = {
        "schema": "loci.codex-tissue-verification/v1",
        "verifier_identity": verifier_identity,
        "verified_at": datetime.now(UTC).isoformat(),
        "status": (
            "passed-codex-host-engineering-qa"
            if detected_mode == "codex-host"
            else "passed-mcp-sdk-smoke-only"
            if detected_mode == "sdk"
            else "passed-simulated-test-only"
        ),
        "evidence_kind": evidence_kind,
        "codex_host_qualified": detected_mode == "codex-host",
        "scientific_qualification": "not-established",
        "human_review": False,
        "host_provenance": (
            read_json(output_dir / "host-run.json") if detected_mode == "codex-host" else None
        ),
        "transcript_path": str(selected_transcript),
        "transcript_sha256": sha256_file(selected_transcript),
        "worker_sha256": prepared["worker"]["worker_sha256"],
        "policy_sha256": prepared["policy_sha256"],
        "session_id": session_record["session_id"],
        "session_client_id": session_record.get("client_id"),
        "session_state": session_record.get("state"),
        "session_shutdown": shutdown,
        "study_id": prepared["project_id"],
        "source_id": prepared["source_id"],
        "source_sha256": SOURCE_SHA,
        "preview_job_id": preview_job["id"],
        "run_job_id": run_job["id"],
        "preview_token": token,
        "result_id": result_id,
        "revision_hash": adopted["revision_hash"],
        "artifact_file_hashes": artifact_file_hashes,
        "reference_array_raw_shas": REFERENCE_ARRAY_RAW_SHAS,
        "mcp_views": observed_fields,
        "review": stored_review,
        "native_export": native_export_info,
        "cold_reopen": cold_reopen_info,
    }
    return verification


def finalize_artifacts_phase(
    *, output: Path, expect_mode: str, prepared_harness: Path | None = None
) -> dict[str, Any]:
    """Explicit native QA generation; refuse to overwrite earlier attempts."""
    verification = verify_phase(
        output=output,
        expect_mode=expect_mode,
        skip_native_export=True,
        prepared_harness=prepared_harness,
    )
    output_dir = output.expanduser().resolve(strict=True)
    for name in (
        "exports",
        "views",
        "mcp-views",
        "artifact-generation.json",
        "cold-check-input.json",
        "cold-retained-check.json",
    ):
        require(
            not (output_dir / name).exists(),
            f"Artifact generation already attempted: {name}",
        )
    prepared = read_json(output_dir / "prepared-fixture.json")
    repo = Path(prepared["repo"])
    source_copy = Path(prepared["source_copy"])
    study_path = Path(prepared["study"])
    from loci_engine.research_export import export_research_result
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    from scripts.qa.tissue_model_journey import check_views

    project = ResearchProject(study_path)
    result_id = verification["result_id"]
    adopted = project.result(result_id)
    loaded_arrays = {key: project.load_array(desc) for key, desc in adopted["arrays"].items()}
    events = [
        json.loads(line)
        for line in Path(verification["transcript_path"]).read_text().splitlines()
        if line.strip()
    ]
    calls, _ = parse_transcript_events(events, expect_mode=expect_mode)
    (output_dir / "mcp-views").mkdir()
    for call in matching_calls(calls, "result_view"):
        field = extract_structured(call)["field"]
        block = next(block for block in call["result"]["content"] if block["type"] == "image")
        (output_dir / "mcp-views" / f"mcp-{field}.png").write_bytes(
            base64.b64decode(block["data"], validate=True)
        )
    exports_dir = output_dir / "exports" / "original"
    exports_dir.parent.mkdir(exist_ok=True)
    require(
        not exports_dir.exists(),
        "Export artifacts already exist; preserve this attempt",
    )
    export_receipt = export_research_result(
        project, result_id, adopted["revision_hash"], exports_dir
    )
    views_dir = output_dir / "views"
    views_dir.mkdir(exist_ok=True)
    wb = Workbench(project)
    try:
        check_views(wb.execute, adopted, loaded_arrays, views_dir, "original")
    finally:
        wb.close()

    offline_source = source_copy.with_suffix(".offline.tif")
    require(not offline_source.exists(), "Offline source destination already exists")
    source_copy.rename(offline_source)
    try:
        cold_config_path = output_dir / "cold-check-input.json"
        write_json(
            cold_config_path,
            {
                "repo": str(repo),
                "output": str(output_dir),
                "registered_source": str(source_copy),
                "study": str(study_path),
            },
            mode=0o600,
        )
        cold_env = {
            **os.environ,
            "LOCI_MODEL_HOME": str(output_dir / "absent-cold-models"),
        }
        cold_proc = subprocess.run(
            [
                sys.executable,
                "-I",
                str(Path(__file__).resolve()),
                "--cold-retained-check",
                str(cold_config_path),
            ],
            cwd=repo,
            env=cold_env,
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        cold_reopen_info = json.loads(cold_proc.stdout.strip().splitlines()[-1])
        require(
            cold_reopen_info.get("schema") == "loci.codex-tissue-cold-retained/v1"
            and cold_reopen_info.get("verified_result_id") == result_id,
            "Cold retained check did not complete cleanly",
        )
    finally:
        if offline_source.exists():
            offline_source.rename(source_copy)
    require(
        sha256_file(source_copy) == SOURCE_SHA,
        "Restored source copy SHA-256 mismatch after cold reopen check",
    )
    native_export_info = {
        "export_directory": str(exports_dir.relative_to(output_dir)),
        "export_receipt": export_receipt,
        "exported_files_sha256": {
            str(p.relative_to(output_dir)): sha256_file(p)
            for p in sorted(exports_dir.rglob("*"))
            if p.is_file()
        },
        "native_view_files_sha256": {
            str(p.relative_to(output_dir)): sha256_file(p)
            for p in sorted(views_dir.rglob("*.png"))
            if p.is_file()
        },
    }

    report = {
        "schema": "loci.codex-tissue-artifact-generation/v1",
        "verifier_identity": verification["verifier_identity"],
        "transcript_sha256": verification["transcript_sha256"],
        "policy_sha256": prepared["policy_sha256"],
        "result_id": result_id,
        "revision_hash": adopted["revision_hash"],
        "native_export": native_export_info,
        "cold_reopen": cold_reopen_info,
        "files_sha256": {
            str(path.relative_to(output_dir)): sha256_file(path)
            for root in (
                output_dir / "exports",
                output_dir / "views",
                output_dir / "mcp-views",
            )
            for path in sorted(root.rglob("*"))
            if path.is_file()
        }
        | {"cold-retained-check.json": sha256_file(output_dir / "cold-retained-check.json")},
    }
    write_json(output_dir / "artifact-generation.json", report, mode=0o600)
    return report


async def _run_sdk_sequence(
    worker: Path,
    policy_path: Path,
    model_home: Path,
    prepared: dict[str, Any],
    transcript_path: Path,
    timeout: int,
) -> None:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.types import Implementation

    env = {**os.environ, "LOCI_MODEL_HOME": str(model_home)}
    params = StdioServerParameters(
        command=str(worker),
        args=["--cli", "mcp", "--policy", str(policy_path)],
        env=env,
    )
    call_counter = 0

    def record_event(payload: dict[str, Any]) -> None:
        entry = {
            "timestamp": datetime.now(UTC).isoformat(),
            "event_origin": "python-mcp-sdk",
            **payload,
        }
        with transcript_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, sort_keys=True, allow_nan=False) + "\n")

    record_event(
        {
            "type": "sdk.session.started",
            "client_id": SDK_CLIENT_ID,
            "policy_sha256": prepared["policy_sha256"],
            "worker_sha256": prepared["worker"]["worker_sha256"],
        }
    )
    async with (
        stdio_client(params) as (read_stream, write_stream),
        ClientSession(
            read_stream,
            write_stream,
            client_info=Implementation(name=SDK_CLIENT_ID, version="1.0.0"),
        ) as session,
    ):
        await session.initialize()
        listed = await session.list_tools()
        tool_names = sorted(tool.name for tool in listed.tools)
        record_event({"type": "sdk.tools.listed", "tools": tool_names})

        async def call_mcp(
            tool: str, arguments: dict[str, Any], *, expect_error: bool = False
        ) -> dict[str, Any]:
            nonlocal call_counter
            call_counter += 1
            call_id = f"sdk-call-{call_counter:02d}"
            record_event(
                {
                    "type": "item.started",
                    "item": {
                        "id": call_id,
                        "type": "mcp_tool_call",
                        "server": SERVER,
                        "tool": tool,
                        "arguments": arguments,
                        "status": "in_progress",
                    },
                }
            )
            raw = await session.call_tool(tool, arguments)
            dumped = raw.model_dump(by_alias=True, mode="json", exclude_none=False)
            completed_item = {
                "id": call_id,
                "type": "mcp_tool_call",
                "server": SERVER,
                "tool": tool,
                "arguments": arguments,
                "status": "completed",
                "result": dumped,
                "error": None,
            }
            record_event({"type": "item.completed", "item": completed_item})
            return extract_structured(completed_item, expect_error=expect_error)

        async def poll_until_done(job_id: str) -> dict[str, Any]:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                status = (await call_mcp("job_status", {"job_id": job_id}))["job"]
                if (
                    status["state"] not in {"queued", "running"}
                    and status.get("owned_worker_active") is False
                ):
                    require(
                        status["state"] == "succeeded",
                        f"Job {job_id} terminated in state {status['state']}",
                    )
                    return status
                await asyncio.sleep(0.25)
            raise TimeoutError(f"Timed out waiting for job {job_id} to complete")

        tissue_request = prepared["tissue_request"]
        denied_request = prepared["denied_request"]
        source_id = prepared["source_id"]

        await call_mcp("action_guide", {"operation": "tissue_model_preview"})
        await call_mcp("analysis_context", {"offset": 0, "limit": 50})
        await call_mcp("inspect_source", {"source_id": source_id})
        await call_mcp("validate_action", {"operation": "tissue_model_profiles", "request": {}})
        await call_mcp("inspect_action", {"operation": "tissue_model_profiles", "request": {}})
        await call_mcp(
            "validate_action",
            {"operation": "tissue_model_status", "request": tissue_request},
        )
        await call_mcp(
            "inspect_action",
            {"operation": "tissue_model_status", "request": tissue_request},
        )
        await call_mcp(
            "submit_action",
            {
                "operation": "tissue_model_preview",
                "request": denied_request,
                "request_key": DENIED_KEY,
            },
            expect_error=True,
        )
        await call_mcp(
            "validate_action",
            {"operation": "tissue_model_preview", "request": tissue_request},
        )
        preview_submit = await call_mcp(
            "submit_action",
            {
                "operation": "tissue_model_preview",
                "request": tissue_request,
                "request_key": PREVIEW_KEY,
            },
        )
        preview_job_id = preview_submit["job"]["id"]
        await poll_until_done(preview_job_id)
        preview_replay = await call_mcp(
            "submit_action",
            {
                "operation": "tissue_model_preview",
                "request": tissue_request,
                "request_key": PREVIEW_KEY,
            },
        )
        require(
            preview_replay["job"]["id"] == preview_job_id,
            "Preview replay did not return the same job ID",
        )
        preview_cached = await call_mcp(
            "inspect_action",
            {"operation": "task_preview_get", "request": {"job_id": preview_job_id}},
        )
        preview_output = preview_cached["preview"]["output"]
        token = {
            "preview_id": preview_output["preview_id"],
            "preview_hash": preview_output["preview_hash"],
        }
        await call_mcp("validate_action", {"operation": "tissue_model_run", "request": token})
        run_submit = await call_mcp(
            "submit_action",
            {
                "operation": "tissue_model_run",
                "request": token,
                "request_key": RUN_KEY,
            },
        )
        run_job_id = run_submit["job"]["id"]
        done_run = await poll_until_done(run_job_id)
        run_replay = await call_mcp(
            "submit_action",
            {
                "operation": "tissue_model_run",
                "request": token,
                "request_key": RUN_KEY,
            },
        )
        require(
            run_replay["job"]["id"] == run_job_id,
            "Run replay did not return the same job ID",
        )
        result_id = done_run["result_ids"][0]
        read_res = await call_mcp("result", {"result_id": result_id})
        revision_hash = read_res["result"]["revision_hash"]
        await call_mcp("result_view", {"result_id": result_id, "label_field": "tissue_classes"})
        await call_mcp("result_view", {"result_id": result_id, "label_field": "compartments"})
        await call_mcp("result_view", {"result_id": result_id, "labels": False})
        history = await call_mcp("review_history", {"result_id": result_id})
        require(
            history.get("current_review_sha256") is None,
            "Freshly adopted tissue result already had a review digest",
        )
        await call_mcp(
            "review_result",
            {
                "request": {
                    "result_id": result_id,
                    "revision_hash": revision_hash,
                    "disposition": "reviewed",
                    "reason": (
                        "AGENT technical verification of deterministic PUMA tissue-model "
                        "output on public TRAINING004 fixture; not human or biological validation."
                    ),
                    "coverage": (
                        "64x64 output ROI at (960,0) with full 1024x1024 normalization context; "
                        "inspected tissue_classes, compartments, and epidermis_score views and "
                        "geometry-only measurements."
                    ),
                    "expected_review_sha256": None,
                }
            },
        )
    record_event({"type": "sdk.session.completed", "total_calls": call_counter})


def sdk_check_phase(
    *,
    repo: Path,
    worker: Path,
    output: Path,
    app: Path | None = None,
    expected_worker_sha256: str | None = None,
    inputs_manifest: Path | None = None,
    timeout: int = 180,
    allow_test_output: bool = False,
) -> dict[str, Any]:
    """Run real MCP stdio smoke sequence through packaged worker via Python MCP SDK."""
    prepared = prepare_phase(
        repo=repo,
        worker=worker,
        output=output,
        app=app,
        expected_worker_sha256=expected_worker_sha256,
        inputs_manifest=inputs_manifest,
        allow_test_output=allow_test_output,
    )
    output_dir = Path(prepared["output"])
    validate_unused_prepared(output_dir, repo=repo)
    (output_dir / "sdk-attempt.json").open("x").close()
    transcript_path = output_dir / "sdk-events.jsonl"
    started = time.monotonic()
    receipt: dict[str, Any] = {
        **prepared,
        "schema": "loci.codex-tissue-sdk-smoke/v1",
        "execution_mode": "mcp-sdk-smoke",
        "codex_launched": False,
        "codex_host_qualified": False,
        "status": "running",
    }
    try:
        asyncio.run(
            _run_sdk_sequence(
                Path(prepared["worker"]["worker_path"]),
                Path(prepared["policy_path"]),
                Path(prepared["model_home"]),
                prepared,
                transcript_path,
                timeout,
            )
        )
        finalize_artifacts_phase(output=output_dir, expect_mode="sdk")
        verification = verify_phase(
            output=output_dir,
            transcript_path=transcript_path,
            expect_mode="sdk",
        )
        write_json(output_dir / "verification.json", verification, mode=0o600)
        receipt["verification"] = verification
        receipt["status"] = "passed-mcp-sdk-smoke-only"
        return receipt
    except BaseException as exc:
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(exc).__name__, "message": str(exc)}
        raise
    finally:
        receipt["elapsed_seconds"] = time.monotonic() - started
        write_json(output_dir / "receipt.json", receipt, mode=0o600)


def tree_hashes(root: Path) -> dict[str, str]:
    require(root.is_dir() and not root.is_symlink(), "Expected plain artifact directory")
    paths = sorted(root.rglob("*"))
    require(
        not any(path.is_symlink() for path in paths),
        "Artifact directory contains symlink",
    )
    return {str(path.relative_to(root)): sha256_file(path) for path in paths if path.is_file()}


def study_sessions(study: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(
        "file:" + quote(str(study / "study.sqlite3")) + "?mode=ro", uri=True
    ) as conn:
        rows = conn.execute(
            "SELECT value FROM metadata WHERE key LIKE 'agent-session:%'"
        ).fetchall()
    return [json.loads(row[0]) for row in rows]


def validate_prepared_identity(
    output: Path, prepared: dict[str, Any], *, prepared_harness: Path | None = None
) -> dict[str, Any]:
    """Read-only immutable inputs check, shared by launch and verification."""
    require(
        Path(prepared["output"]).resolve(strict=True) == output,
        "Prepared output mismatch",
    )
    worker = prepared["worker"]
    require(
        sha256_file(worker["worker_path"]) == worker["worker_sha256"],
        "Worker binary changed after preparation",
    )
    if worker.get("app"):
        require(
            inspect_worker_and_app(Path(worker["worker_path"]), Path(worker["app"]["path"]))
            == worker,
            "App bundle changed after preparation",
        )
    observed_sources = tracked_source_hashes(Path(prepared["repo"]))
    harness_key = "scripts/qa/codex-tissue.py"
    if prepared_harness is not None:
        require(
            prepared_harness.is_file() and not prepared_harness.is_symlink(),
            "Prepared harness must be a plain source file",
        )
        archived_sha = sha256_file(prepared_harness)
        require(
            archived_sha == prepared["source_hashes"][harness_key],
            "Archived prepared harness hash mismatch",
        )
        # Verification may explicitly bind the original QA source after a
        # verifier repair. Launch never supplies this option. Every runtime and
        # other QA source pin still has to match the preparation exactly.
        observed_sources[harness_key] = archived_sha
    require(
        observed_sources == prepared["source_hashes"],
        "Repository engine or QA harness source files changed after preparation",
    )
    require(
        sha256_file(prepared["policy_path"]) == prepared["policy_sha256"],
        "Pinned policy file changed after preparation",
    )
    require(
        sha256_file(prepared["source_copy"]) == prepared["source_sha256"] == SOURCE_SHA,
        "Isolated study source copy changed during run",
    )
    for name, info in prepared["authorized_inputs"]["files"].items():
        require(
            sha256_file(info["path"]) == info["sha256"],
            f"Authorized public input {name} changed on disk",
        )
    require(
        sha256_file(prepared["prompt_path"]) == prepared["prompt_sha256"],
        "Prepared host prompt changed",
    )
    require(
        tree_hashes(Path(prepared["model_home"])) == prepared["model_files_sha256"],
        "Managed model files changed",
    )
    return {
        "verifier_sha256": sha256_file(Path(__file__).resolve()),
        "prepared_harness_sha256": prepared["source_hashes"][harness_key],
        "archived_prepared_harness": (
            str(prepared_harness.resolve()) if prepared_harness is not None else None
        ),
    }


def validate_unused_prepared(
    output: Path,
    *,
    repo: Path,
    worker: Path | None = None,
    app: Path | None = None,
    expected_worker_sha256: str | None = None,
    inputs_manifest: Path | None = None,
) -> dict[str, Any]:
    """Reject reuse or mismatch BEFORE policy refresh, executable queries, or execution."""
    prepared = read_json(output / "prepared-fixture.json")
    require(
        Path(prepared["repo"]).resolve(strict=True) == repo.resolve(strict=True),
        "Prepared repository mismatch",
    )
    for key, supplied in (("worker_path", worker),):
        if supplied is not None:
            require(
                supplied.expanduser().resolve(strict=True) == Path(prepared["worker"][key]),
                "Requested worker mismatch",
            )
    if app is not None:
        require(
            str(app.expanduser().resolve(strict=True))
            == prepared["worker"].get("app", {}).get("path"),
            "Requested app mismatch",
        )
    if expected_worker_sha256 is not None:
        require(
            expected_worker_sha256 == prepared["worker"]["worker_sha256"],
            "Requested worker hash mismatch",
        )
    if inputs_manifest is not None:
        require(
            resolve_authorized_inputs(repo, inputs_manifest) == prepared["authorized_inputs"],
            "Requested input manifest mismatch",
        )
    validate_prepared_identity(output, prepared)
    from loci_engine.research_project import ResearchProject

    project = ResearchProject(prepared["study"])
    require(
        project.meta["project_id"] == prepared["project_id"],
        "Prepared study identity mismatch",
    )
    require(
        not project.list_jobs() and not project.list_results() and not study_sessions(project.root),
        "Prepared study already used",
    )
    require(
        [source["id"] for source in project.list_sources()] == [prepared["source_id"]],
        "Prepared study source mismatch",
    )
    allowed = {
        "inputs",
        "models",
        "study",
        "access",
        "prompt.txt",
        "prepared-fixture.json",
        "receipt.json",
    }
    require(
        {path.name for path in output.iterdir()} <= allowed,
        "Existing run artifacts: preserve attempt and prepare a new output",
    )
    require(
        read_json(output / "receipt.json").get("status") == "prepared-ready-for-host-or-sdk",
        "Prepared run already attempted",
    )
    return prepared


def host_thread_id(events: list[dict[str, Any]]) -> str:
    threads = [event.get("thread_id") for event in events if event.get("type") == "thread.started"]
    require(
        len(threads) == 1 and isinstance(threads[0], str) and threads[0],
        "Host transcript needs one real thread.started thread_id",
    )
    return threads[0]


def validate_host_binding(
    output: Path,
    prepared: dict[str, Any],
    transcript: Path,
    events: list[dict[str, Any]],
    session: dict[str, Any],
) -> None:
    metadata = read_json(output / "host-run.json")
    require(
        metadata.get("schema") == "loci.codex-tissue-host-run/v2",
        "Incomplete Codex launcher metadata",
    )
    require(session.get("client_id") == "codex-mcp-client", "Non-host MCP session client_id")
    require(
        isinstance(session.get("client_version"), str)
        and metadata.get("codex_version") == "codex-cli " + session["client_version"],
        "Codex launcher and observed MCP client versions differ",
    )
    require(
        metadata.get("execution_mode") == "codex-host" and metadata.get("codex_exit_code") == 0,
        "Codex host execution did not succeed",
    )
    require(
        sha256_file(metadata["codex_executable"]) == metadata["codex_executable_sha256"],
        "Codex executable changed",
    )
    require(metadata["thread_id"] == host_thread_id(events), "Host thread binding mismatch")
    require(
        metadata["transcript_sha256"] == sha256_file(transcript)
        and metadata["prepared_sha256"] == sha256_file(output / "prepared-fixture.json")
        and metadata["prompt_sha256"] == prepared["prompt_sha256"]
        and metadata["session_sha256"] == value_sha256(session),
        "Host transcript/session/input binding mismatch",
    )
    for name in ("answer.txt", "codex-stderr.log"):
        require(
            sha256_file(output / name) == metadata["files_sha256"][name],
            f"Host output changed: {name}",
        )
    expected = build_codex_command(
        metadata["codex_executable"],
        Path(prepared["worker"]["worker_path"]),
        Path(prepared["policy_path"]),
        Path(prepared["model_home"]),
        output / "answer.txt",
        model=metadata["model_requested"],
        effort=metadata["effort_requested"],
    )
    require(metadata["host_command"] == expected, "Host launcher command mismatch")
    require(
        datetime.fromisoformat(metadata["started_at"])
        <= datetime.fromisoformat(session["started_at"])
        <= datetime.fromisoformat(metadata["finished_at"]),
        "Host session outside launcher interval",
    )
    require(
        metadata["model_observed"] is None
        and metadata["observed_model_basis"] == "not-exposed-by-cli-json",
        "Unverifiable observed model claim",
    )


def _refresh_validated_policy(output_dir: Path, prepared: dict[str, Any]) -> dict[str, Any]:
    """Refresh only after run_host_phase has completed its authoritative preflight."""
    _ensure_repo_imports()
    from loci_engine.agent_policy import load_policy, write_policy
    from loci_engine.agent_sessions import register_policy
    from loci_engine.research_project import ResearchProject
    from loci_engine.tissue_model_profiles import puma_profile

    study = ResearchProject(prepared["study"])
    profile = puma_profile()
    expires_at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    delegation_id = uuid.uuid4().hex
    policy_spec = build_policy_specification(
        prepared["source_id"],
        profile,
        expires_at=expires_at,
        delegation_id=delegation_id,
    )
    policy_path = Path(prepared["policy_path"])
    policy_receipt = write_policy(policy_path, study, policy_spec)
    loaded = load_policy(policy_path)
    register_policy(study, loaded, permission_mode="full_access", bundle_name="access")
    prepared["policy_sha256"] = policy_receipt["policy_sha256"]
    prepared["policy_schema"] = policy_receipt["schema"]
    prepared["delegation_id"] = delegation_id
    prepared["delegation_expires_at"] = expires_at
    write_json(output_dir / "prepared-fixture.json", prepared, mode=0o600)
    return prepared


def run_host_phase(
    *,
    repo: Path,
    output: Path,
    worker: Path | None = None,
    app: Path | None = None,
    expected_worker_sha256: str | None = None,
    inputs_manifest: Path | None = None,
    model: str = "gpt-6.1-sol",
    effort: str = "high",
    timeout: int = 1800,
) -> dict[str, Any]:
    """Execute ephemeral Codex CLI host run (for the Codex lead only) and verify."""
    target = output.expanduser().absolute()
    if not target.exists():
        require(worker is not None, "--worker is required when --output is not yet prepared")
        prepared = prepare_phase(
            repo=repo,
            worker=worker,
            output=target,
            app=app,
            expected_worker_sha256=expected_worker_sha256,
            inputs_manifest=inputs_manifest,
            model=model,
            effort=effort,
        )
        validate_unused_prepared(Path(prepared["output"]), repo=repo)
    else:
        prepared = validate_unused_prepared(
            target.resolve(strict=True),
            repo=repo,
            worker=worker,
            app=app,
            expected_worker_sha256=expected_worker_sha256,
            inputs_manifest=inputs_manifest,
        )
        prepared = _refresh_validated_policy(target, prepared)

    output_dir = Path(prepared["output"])
    # Exclusive marker is preserved even when executable lookup or launch fails.
    (output_dir / "host-attempt.json").open("x").close()
    codex = shutil.which("codex")
    require(codex is not None, "Installed Codex CLI is unavailable")
    codex_resolved = Path(codex).resolve(strict=True)
    codex_version = subprocess.check_output([str(codex_resolved), "--version"], text=True).strip()
    codex_sha = sha256_file(codex_resolved)

    worker_path = Path(prepared["worker"]["worker_path"]).resolve(strict=True)
    policy_path = Path(prepared["policy_path"]).resolve(strict=True)
    model_home = Path(prepared["model_home"]).resolve(strict=True)
    answer_path = output_dir / "answer.txt"
    events_path = output_dir / "codex-events.jsonl"
    stderr_path = output_dir / "codex-stderr.log"
    prompt_text = Path(prepared["prompt_path"]).read_text(encoding="utf-8")

    command = build_codex_command(
        str(codex_resolved),
        worker_path,
        policy_path,
        model_home,
        answer_path,
        model=model,
        effort=effort,
    )
    host_env = {**os.environ, "LOCI_MODEL_HOME": str(model_home)}
    started = time.monotonic()
    started_at = datetime.now(UTC).isoformat()
    receipt: dict[str, Any] = {
        **prepared,
        "schema": "loci.codex-tissue-host-qa/v1",
        "execution_mode": "codex-host",
        "codex_launched": True,
        "codex_version": codex_version,
        "codex_executable": str(codex_resolved),
        "codex_executable_sha256": codex_sha,
        "model_requested": model,
        "effort_requested": effort,
        "service_tier_requested": "default (Standard)",
        "host_command": command,
        "status": "running",
    }
    try:
        with (
            tempfile.TemporaryDirectory(prefix="loci-codex-tissue-") as cwd,
            events_path.open("x", encoding="utf-8") as stdout_stream,
            stderr_path.open("x", encoding="utf-8") as stderr_stream,
        ):
            completed = subprocess.run(
                command,
                input=prompt_text,
                text=True,
                stdout=stdout_stream,
                stderr=stderr_stream,
                cwd=cwd,
                env=host_env,
                timeout=timeout,
                check=False,
            )
        receipt["codex_exit_code"] = completed.returncode
        require(
            completed.returncode == 0,
            "Codex CLI host run exited nonzero; inspect codex-stderr.log and codex-events.jsonl",
        )
        write_json(
            output_dir / "host-run.json",
            {
                "schema": "loci.codex-tissue-host-run/v2",
                "execution_mode": "codex-host",
                "codex_version": codex_version,
                "codex_executable": str(codex_resolved),
                "codex_executable_sha256": codex_sha,
                "codex_exit_code": completed.returncode,
                "model_requested": model,
                "effort_requested": effort,
                "service_tier_requested": "default (Standard)",
                "model_observed": None,
                "observed_model_basis": "not-exposed-by-cli-json",
                "provenance_limit": (
                    "Unsigned local launcher records establish engineering "
                    "traceability, not cryptographic host attestation"
                ),
                "host_command": command,
                "started_at": started_at,
                "finished_at": datetime.now(UTC).isoformat(),
                "thread_id": host_thread_id(
                    [
                        json.loads(line)
                        for line in events_path.read_text().splitlines()
                        if line.strip()
                    ]
                ),
                "transcript_sha256": sha256_file(events_path),
                "prepared_sha256": sha256_file(output_dir / "prepared-fixture.json"),
                "prompt_sha256": sha256_file(prepared["prompt_path"]),
                "session_sha256": value_sha256(study_sessions(Path(prepared["study"]))[0]),
                "files_sha256": {
                    name: sha256_file(output_dir / name)
                    for name in ("answer.txt", "codex-stderr.log")
                },
            },
            mode=0o600,
        )
        finalize_artifacts_phase(output=output_dir, expect_mode="codex-host")
        verification = verify_phase(
            output=output_dir,
            transcript_path=events_path,
            expect_mode="codex-host",
        )
        write_json(output_dir / "verification.json", verification, mode=0o600)
        receipt["verification"] = verification
        receipt["status"] = "passed-codex-host-engineering-qa"
        return receipt
    except BaseException as exc:
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(exc).__name__, "message": str(exc)}
        raise
    finally:
        receipt["elapsed_seconds"] = time.monotonic() - started
        write_json(output_dir / "receipt.json", receipt, mode=0o600)


def prepare_native_ui_phase(
    *,
    repo: Path,
    app: Path,
    output: Path,
    inputs_manifest: Path | None = None,
    allow_test_output: bool = False,
) -> dict[str, Any]:
    """Prepare isolated fixture, invalid receipt, launch script, and checklist for native UI QA."""
    output_dir = prepare_output_directory(repo, output, allow_test_output=allow_test_output)
    app_resolved = app.expanduser().resolve(strict=True)
    worker_path = app_resolved / "Contents/Resources/loci-engine/loci-engine"
    worker_info = inspect_worker_and_app(worker_path, app_resolved)
    authorized_inputs = resolve_authorized_inputs(repo, inputs_manifest)

    inputs_dir = output_dir / "inputs"
    user_data_dir = output_dir / "user-data"
    model_home_dir = user_data_dir / "models"
    study_parent_dir = output_dir / "study"
    exports_dir = output_dir / "exports"
    for folder in (inputs_dir, user_data_dir, study_parent_dir, exports_dir):
        folder.mkdir(mode=0o700)

    source_copy = inputs_dir / "TRAINING004.tif"
    weights_copy = inputs_dir / "checkpoint_best.network_weights.pth"
    valid_receipt_copy = inputs_dir / "checkpoint_best.network_weights.pth.receipt.json"
    shutil.copyfile(authorized_inputs["files"]["source"]["path"], source_copy)
    shutil.copyfile(authorized_inputs["files"]["weights"]["path"], weights_copy)
    shutil.copyfile(authorized_inputs["files"]["conversion_receipt"]["path"], valid_receipt_copy)
    require(sha256_file(source_copy) == SOURCE_SHA, "Source copy hash mismatch")
    require(sha256_file(weights_copy) == WEIGHTS_SHA, "Weights copy hash mismatch")
    require(
        sha256_file(valid_receipt_copy) == CONVERSION_SHA,
        "Valid receipt copy hash mismatch",
    )

    invalid_receipt_data = read_json(valid_receipt_copy)
    if "weights_sha256" in invalid_receipt_data:
        invalid_receipt_data["weights_sha256"] = "0" * 64
    elif isinstance(invalid_receipt_data.get("output"), dict):
        invalid_receipt_data["output"]["sha256"] = "0" * 64
    else:
        invalid_receipt_data["corrupted_for_negative_qa"] = True
    invalid_receipt_copy = inputs_dir / "invalid-conversion-receipt.json"
    write_json(invalid_receipt_copy, invalid_receipt_data, mode=0o600)

    study_target = study_parent_dir / "TRAINING004-native-ui.loci-study"
    executable_path = app_resolved / "Contents/MacOS/Loci"

    launch_script = output_dir / "launch-native-ui.sh"
    launch_body = f"""#!/bin/zsh
set -euo pipefail
export LOCI_MODEL_HOME={shlex.quote(str(model_home_dir))}
exec {shlex.quote(str(executable_path))} --user-data-dir={shlex.quote(str(user_data_dir))}
"""
    launch_script.write_text(launch_body, encoding="utf-8")
    os.chmod(launch_script, 0o700)

    invalid_sha = sha256_file(invalid_receipt_copy)
    py_exe = repo / "engine/.venv/bin/python"
    script_self = Path(__file__).resolve()
    steps_lines = [
        "# Prepared Native UI Qualification Kit",
        "",
        "## Isolated Paths",
        f"- **App Bundle**: `{app_resolved}`",
        f"- **Single-Command Launch**: `{launch_script}`",
        f"- **Isolated Electron `--user-data-dir`**: `{user_data_dir}`",
        f"- **Isolated `LOCI_MODEL_HOME`** (starts absent): `{model_home_dir}`",
        f"- **Target Study Path**: `{study_target}`",
        f"- **Source Image Copy**: `{source_copy}` (`{SOURCE_SHA}`)",
        f"- **Valid Weights Copy**: `{weights_copy}` (`{WEIGHTS_SHA}`)",
        f"- **Valid Conversion Receipt Copy**: `{valid_receipt_copy}` (`{CONVERSION_SHA}`)",
        f"- **Derived Invalid Receipt Copy**: `{invalid_receipt_copy}` (`{invalid_sha}`)",
        f"- **Export Parent Directory**: `{exports_dir}`",
        "",
        "## Concise Native Picker & UI Steps",
        "1. **Launch**:",
        "   ```zsh",
        f"   {launch_script}",
        "   ```",
        "2. **Create Study & Ordinary Source Picker Cancellation + Selection**:",
        f"   - Click **New study…** and choose `{study_target}`.",
        "   - Open **File ▾ → Add images…** and click **Cancel** in the macOS native open panel.",
        "     - *Pass observation*: Study sources list remains empty (`0` sources); no modal.",
        f"   - Open **File ▾ → Add images…**, select `{source_copy}`, and click **Open**.",
        "     - *Pass observation*: `TRAINING004.tif` appears in the source rail (`1024 × 1024`).",
        "3. **Missing State & Two-Stage Model Import Cancellation / Invalid Receipt / Valid**:",
        "   - Open the **Tissue model** panel.",
        (
            "     - *Pass observation*: Store state shows **Missing** (`missing`); "
            "runtime shows `metadata-matches-unverified`."
        ),
        (
            "   - Click **Import approved weights & receipt…**, then click **Cancel** on the "
            "1st native dialog (weights)."
        ),
        f"     - *Pass observation*: Store state remains **Missing**; `{model_home_dir}` absent.",
        (
            f"   - Click **Import approved weights & receipt…**, select `{weights_copy}` in the "
            "1st dialog, then click **Cancel** on the 2nd dialog (conversion receipt)."
        ),
        "     - *Pass observation*: Store state remains **Missing**.",
        (
            f"   - Click **Import approved weights & receipt…**, select `{weights_copy}` in the "
            f"1st dialog, and select `{invalid_receipt_copy}` in the 2nd dialog."
        ),
        (
            "     - *Pass observation*: UI reports an explicit validation error "
            "and refuses import; "
            "store state remains **Missing**."
        ),
        (
            f"   - Click **Import approved weights & receipt…**, select `{weights_copy}` in the "
            f"1st dialog, and select `{valid_receipt_copy}` in the 2nd dialog."
        ),
        (
            "     - *Pass observation*: Store state transitions to "
            "**Provisioned (compatibility unverified)** (`provisioned-unverified`)."
        ),
        (
            "4. **Declared H&E, Full 1024 Context + Exact 64×64 ROI "
            "(`x=960, y=0, width=64, height=64`)**:"
        ),
        (
            "   - Confirm declared stain is **Hematoxylin & eosin (H&E)** (`hematoxylin-eosin`), "
            "normalization context is `0, 0, 1024, 1024`, and set output ROI to "
            "`x=960, y=0, width=64, height=64`."
        ),
        "5. **Preview & Token-Only Adoption**:",
        "   - Click **Preview tissue model** and wait for the durable preview job to succeed.",
        "     - *Pass observation*: Preview overlay renders; study result count remains `0`.",
        "   - Click **Adopt tissue result** and wait for the durable adoption job to succeed.",
        "     - *Pass observation*: Exactly `1` `Candidate PUMA tissue regions` result published.",
        "6. **Retained Field Views, Review, Export, and Cold Reopen**:",
        (
            "   - Switch retained views across **Original classes (1–5)** (`tissue_classes`), "
            "**Effective compartments** (`compartments`), and **Original epidermis score** "
            "(`epidermis_score`)."
        ),
        (
            "   - Exercise the native **Reviewed** control for automated UI engineering QA "
            "(this is not a human scientific review) and export the "
            f"reviewed bundle to `{exports_dir / 'original'}`."
        ),
        (
            "   - Quit Loci cleanly (`Cmd+Q`) and verify zero surviving `Loci` or `loci-engine` "
            "processes."
        ),
        "",
        "## Post-Action Artifact Verification Command",
        "After completing the UI steps above, run:",
        "```zsh",
        f"{py_exe} -I {script_self} verify-native-ui --kit {output_dir}",
        "```",
        "",
    ]
    steps_path = output_dir / "NATIVE_UI_STEPS.md"
    steps_path.write_text("\n".join(steps_lines), encoding="utf-8")

    kit = {
        "schema": "loci.native-ui-qualification-kit/v1",
        "prepared_at": datetime.now(UTC).isoformat(),
        "repo": str(repo),
        "kit_dir": str(output_dir),
        "worker": worker_info,
        "authorized_inputs": authorized_inputs,
        "paths": {
            "launch_script": str(launch_script),
            "steps_markdown": str(steps_path),
            "user_data_dir": str(user_data_dir),
            "model_home_dir": str(model_home_dir),
            "study_target": str(study_target),
            "source_copy": str(source_copy),
            "weights_copy": str(weights_copy),
            "valid_receipt_copy": str(valid_receipt_copy),
            "invalid_receipt_copy": str(invalid_receipt_copy),
            "invalid_receipt_sha256": sha256_file(invalid_receipt_copy),
            "exports_dir": str(exports_dir),
        },
        "verify_command": [
            str(repo / "engine/.venv/bin/python"),
            "-I",
            str(Path(__file__).resolve()),
            "verify-native-ui",
            "--kit",
            str(output_dir),
        ],
    }
    write_json(output_dir / "native-ui-kit.json", kit, mode=0o600)
    return kit


def verify_native_ui_phase(*, kit_dir: Path) -> dict[str, Any]:
    """Read-only checks of post-action native UI state and export; not human scientific review."""
    _ensure_repo_imports()
    import numpy as np
    from loci_engine import tissue_model_store as store
    from loci_engine.research_project import ResearchProject

    from scripts.qa.tissue_model_journey import load_array

    kit_root = kit_dir.expanduser().resolve(strict=True)
    kit = read_json(kit_root / "native-ui-kit.json")
    paths = kit["paths"]

    require(
        sha256_file(paths["source_copy"]) == SOURCE_SHA,
        "Native UI source copy changed on disk",
    )
    model_home = Path(paths["model_home_dir"])
    store_status = store.inspect_store(model_home, check=lambda: None, verify=True)
    require(
        store_status["provisioned"] is True and store_status["files_verified"] is True,
        f"Isolated model store was not provisioned and verified: {store_status}",
    )

    study_path = Path(paths["study_target"])
    require(study_path.is_dir(), f"Expected study directory at {study_path}")
    project = ResearchProject(study_path)
    sources = project.list_sources()
    require(
        len(sources) == 1 and sources[0]["sha256"] == SOURCE_SHA,
        "Study does not contain the single expected TRAINING004 source",
    )
    results = project.list_results()
    require(results, "Study contains no adopted tissue results")
    original = next((r for r in results if r.get("kind") == "tissue-model-regions"), None)
    require(original is not None, "Study has no tissue-model-regions result")
    for key, expected_sha in EXPECTED_RESULT_ARRAY_SHAS.items():
        actual_sha = original["arrays"][key]["sha256"]
        require(
            actual_sha == expected_sha,
            f"Adopted result array {key} SHA-256 mismatch ({actual_sha} != {expected_sha})",
        )
    review = project.review_state(original["id"])
    require(
        review is not None
        and review.get("disposition") == "reviewed"
        and review.get("actor") == "human",
        "Original tissue result lacks a native UI reviewed disposition; "
        "automated QA is not human scientific review",
    )
    export_bundle = Path(paths["exports_dir"]) / "original"
    require(
        (export_bundle / "result.json").is_file(),
        f"Expected exported result bundle at {export_bundle}",
    )
    arrays = {key: project.load_array(descriptor) for key, descriptor in original["arrays"].items()}
    for key, array in arrays.items():
        np.testing.assert_array_equal(array, load_array(export_bundle / f"{key}.npy"))
    report = {
        "schema": "loci.native-ui-verification/v1",
        "verified_at": datetime.now(UTC).isoformat(),
        "status": "passed-native-ui-engineering-qa",
        "human_scientific_review": False,
        "study": str(study_path),
        "result_id": original["id"],
        "revision_hash": original["revision_hash"],
        "store_status": store_status,
        "review": review,
    }
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codex-tissue.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--cold-retained-check", type=Path, help=argparse.SUPPRESS)
    subparsers = parser.add_subparsers(dest="phase")

    subparsers.add_parser("help", help="Show this help message and exit without side effects")

    prep = subparsers.add_parser(
        "prepare",
        help="Prepare isolated study, managed model store, and minimal v6 policy (no Codex launch)",
    )
    prep.add_argument("--repo", type=Path, default=REPO_ROOT)
    prep.add_argument("--worker", type=Path, required=True)
    prep.add_argument("--app", type=Path)
    prep.add_argument("--expected-worker-sha256")
    prep.add_argument("--inputs-manifest", type=Path)
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--model", default="gpt-6.1-sol")
    prep.add_argument("--effort", choices=("low", "medium", "high", "xhigh"), default="high")
    prep.add_argument("--allow-test-output", action="store_true", help=argparse.SUPPRESS)

    sdk = subparsers.add_parser(
        "sdk-check",
        help="Run real MCP stdio smoke run via Python MCP SDK and verify (no Codex launch)",
    )
    sdk.add_argument("--repo", type=Path, default=REPO_ROOT)
    sdk.add_argument("--worker", type=Path, required=True)
    sdk.add_argument("--app", type=Path)
    sdk.add_argument("--expected-worker-sha256")
    sdk.add_argument("--inputs-manifest", type=Path)
    sdk.add_argument("--output", type=Path, required=True)
    sdk.add_argument("--timeout", type=int, default=180)
    sdk.add_argument("--allow-test-output", action="store_true", help=argparse.SUPPRESS)

    artifacts = subparsers.add_parser(
        "finalize-artifacts",
        help="Generate native export/views/cold QA once, preserving attempts",
    )
    artifacts.add_argument("--output", type=Path, required=True)
    artifacts.add_argument("--expect-mode", choices=("sdk", "codex-host"), required=True)
    artifacts.add_argument("--prepared-harness", type=Path)

    ver = subparsers.add_parser(
        "verify",
        help="Verify a recorded SDK or Codex-host transcript and study/export artifacts",
    )
    ver.add_argument("--output", type=Path, required=True)
    ver.add_argument("--transcript", type=Path)
    ver.add_argument(
        "--expect-mode",
        choices=("sdk", "codex-host", "simulated"),
        default="sdk",
    )
    ver.add_argument("--skip-native-export", action="store_true")
    ver.add_argument("--prepared-harness", type=Path)

    host = subparsers.add_parser(
        "run-host",
        help="Execute ephemeral Codex CLI host run (for the Codex lead only) and verify",
    )
    host.add_argument("--repo", type=Path, default=REPO_ROOT)
    host.add_argument("--output", type=Path, required=True)
    host.add_argument("--worker", type=Path)
    host.add_argument("--app", type=Path)
    host.add_argument("--expected-worker-sha256")
    host.add_argument("--inputs-manifest", type=Path)
    host.add_argument("--model", default="gpt-6.1-sol")
    host.add_argument("--effort", choices=("low", "medium", "high", "xhigh"), default="high")
    host.add_argument("--timeout", type=int, default=1800)

    nprep = subparsers.add_parser(
        "prepare-native-ui",
        help="Prepare isolated native-picker desktop UI fixture and launch script",
    )
    nprep.add_argument("--repo", type=Path, default=REPO_ROOT)
    nprep.add_argument(
        "--app",
        type=Path,
        default=REPO_ROOT / ".loci/builds/staging/Loci-darwin-arm64/Loci.app",
    )
    nprep.add_argument("--inputs-manifest", type=Path)
    nprep.add_argument("--output", type=Path, required=True)
    nprep.add_argument("--allow-test-output", action="store_true", help=argparse.SUPPRESS)

    nver = subparsers.add_parser(
        "verify-native-ui",
        help="Verify post-action native UI study, store, review, and export artifacts",
    )
    nver.add_argument("--kit", type=Path, required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cold_retained_check is not None:
        return ColdRetainedSubprocessCheck(args.cold_retained_check)
    if args.phase in (None, "help"):
        parser.print_help()
        return 0
    if args.phase == "prepare":
        result = prepare_phase(
            repo=args.repo.resolve(strict=True),
            worker=args.worker,
            output=args.output,
            app=args.app,
            expected_worker_sha256=args.expected_worker_sha256,
            inputs_manifest=args.inputs_manifest,
            model=args.model,
            effort=args.effort,
            allow_test_output=args.allow_test_output,
        )
        print(json.dumps({"status": result["status"], "output": result["output"]}))
        return 0
    if args.phase == "sdk-check":
        result = sdk_check_phase(
            repo=args.repo.resolve(strict=True),
            worker=args.worker,
            output=args.output,
            app=args.app,
            expected_worker_sha256=args.expected_worker_sha256,
            inputs_manifest=args.inputs_manifest,
            timeout=args.timeout,
            allow_test_output=args.allow_test_output,
        )
        print(json.dumps({"status": result["status"], "output": result["output"]}))
        return 0
    if args.phase == "finalize-artifacts":
        result = finalize_artifacts_phase(
            output=args.output, expect_mode=args.expect_mode, prepared_harness=args.prepared_harness
        )
        print(json.dumps(result))
        return 0
    if args.phase == "verify":
        result = verify_phase(
            output=args.output,
            transcript_path=args.transcript,
            expect_mode=args.expect_mode,
            skip_native_export=args.skip_native_export,
            prepared_harness=args.prepared_harness,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    if args.phase == "run-host":
        result = run_host_phase(
            repo=args.repo.resolve(strict=True),
            output=args.output,
            worker=args.worker,
            app=args.app,
            expected_worker_sha256=args.expected_worker_sha256,
            inputs_manifest=args.inputs_manifest,
            model=args.model,
            effort=args.effort,
            timeout=args.timeout,
        )
        print(json.dumps({"status": result["status"], "output": result["output"]}))
        return 0
    if args.phase == "prepare-native-ui":
        result = prepare_native_ui_phase(
            repo=args.repo.resolve(strict=True),
            app=args.app,
            output=args.output,
            inputs_manifest=args.inputs_manifest,
            allow_test_output=args.allow_test_output,
        )
        print(json.dumps({"status": "prepared-native-ui-kit", "kit_dir": result["kit_dir"]}))
        return 0
    if args.phase == "verify-native-ui":
        result = verify_native_ui_phase(kit_dir=args.kit)
        print(json.dumps(result, sort_keys=True))
        return 0
    raise ValueError(f"Unknown phase: {args.phase}")


if __name__ == "__main__":
    raise SystemExit(main())
