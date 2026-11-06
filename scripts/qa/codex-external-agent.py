"""Prepare/run/verify an actual Codex-host plan, composed-analysis and assessment journey.

Only run-host launches Codex. Preparation and focused fixture tests use native APIs;
they never qualify a host. No downloads, model execution, SDK substitute or human
review. Every output root is exclusive; a failed host attempt cannot be overwritten.
Use the matching engine/.venv/bin/python and a signed packaged --worker.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine/src"))
_spec = importlib.util.spec_from_file_location(
    "external_qa_tissue_helpers", ROOT / "scripts/qa/codex-tissue.py"
)
TISSUE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(TISSUE)
SERVER = "loci-external-agent-qa"
MODEL, EFFORT = "gpt-6.1-sol", "high"
HUMAN_EDIT_GOAL = "Human-edited goal: inspect exact labels and preserve annotation limits"
MEMORY = 128 * 1024**2
PUBLIC_ROOT = ROOT / ".loci/evidence/2026-10-30/research-program/public-data"
PUBLIC_FILES = {
    "image": (
        "cellseg3d/extracted/DATASET_WITH_GT/c5image.tif",
        "7aadf9c004aa4c89573bfe1d9d4e5d3d5bd0f8f50c5ddffc3ed4c22b1c0a1cff",
    ),
    "labels": (
        "cellseg3d/extracted/DATASET_WITH_GT/labels/c5labels_new_label.tif",
        "61c2fd06391622264e48bb8c1cc796ccce88e7929d17e1b5fb98a44c9e003e18",
    ),
}
CAPTURE_KEY = "external-agent-reference-v1"
GRAPH_KEY = "external-agent-composed-v1"
ALLOWED = {
    "action_guide": None,
    "analysis_context": None,
    "inspect_source": None,
    "result": None,
    "result_view": None,
    "job_status": None,
    "agent_task_read": {"list", "get"},
    "agent_task_write": {"publish_plan", "publish_assessment"},
    "validate_action": {"annotation_reference_run"},
    "inspect_action": {
        "annotation_reference_candidates",
        "annotation_evaluation_get",
        "method_query",
    },
    "submit_action": {"annotation_reference_run"},
    "workflow_graph_inspect": {"workflow_graph_preflight", "workflow_graph_status"},
    "workflow_graph_control": {
        "workflow_graph_start",
        "workflow_graph_advance",
        "workflow_graph_save_from_run",
    },
}
require, digest, write_json, read_json = (
    TISSUE.require,
    TISSUE.sha256_file,
    TISSUE.write_json,
    TISSUE.read_json,
)


def value_hash(value):
    from loci_engine.research_project import canonical_json

    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def binding(record):
    return {"result_id": record["id"], "revision_hash": record["revision_hash"]}


def target(record):
    return {
        "kind": "result",
        "id": record["id"],
        "revision_hash": record["revision_hash"],
        "source_id": record["source_id"],
        "source_sha256": record["source_sha256"],
    }


def sources_hashes():
    paths = sorted((ROOT / "engine/src/loci_engine").rglob("*.py"))
    paths += [Path(__file__).resolve(), ROOT / "scripts/qa/codex-tissue.py"]
    return {str(p.relative_to(ROOT)): digest(p) for p in paths}


def arrays(case, output, public_root):
    import numpy as np
    import tifffile

    if case == "synthetic":
        raw = np.zeros((32, 32), np.uint16)
        raw[4:12, 4:12] = 100
        raw[18:24, 19:27] = 200
        labels = np.zeros_like(raw, dtype=np.uint32)
        labels[4:12, 4:12] = 7
        labels[18:24, 19:27] = 42
        provenance = {
            "origin": "authored technical fixture",
            "axes": "YX",
            "physical_calibration": None,
            "biological_validation": False,
        }
    else:
        originals = {}
        for name, (relative, sha) in PUBLIC_FILES.items():
            path = (public_root / relative).resolve(strict=True)
            require(digest(path) == sha, f"Public original hash mismatch: {name}")
            originals[name] = {"path": str(path), "sha256": sha}
        volumes = {name: tifffile.imread(info["path"]) for name, info in originals.items()}
        require(all(a.shape == (249, 86, 94) for a in volumes.values()), "Public stack shape drift")
        raw = volumes["image"][124].copy()
        labels = volumes["labels"][124].copy()
        require(labels.dtype.kind in "ui", "Public labels are not integer instances")
        require(labels.max() <= np.iinfo(np.uint32).max, "Public instance ID exceeds uint32")
        labels = labels.astype(np.uint32)
        provenance = {
            "origin": "public CellSeg3D c5 fixed middle plane",
            "originals": originals,
            "stored_axes": "QYX",
            "author_declared_axes": "ZYX",
            "original_shape": [249, 86, 94],
            "zero_based_z": 124,
            "derived_axes": "YX",
            "physical_calibration": None,
            "reference_limit": "Public annotation agreement, not biological validation",
        }
    tifffile.imwrite(output / "image.tif", raw, metadata={"axes": "YX"})
    tifffile.imwrite(output / "reference.tif", labels, metadata={"axes": "YX"})
    np.save(output / "expected-reference.npy", labels, allow_pickle=False)
    return raw, labels, provenance


def controlled_result(wb, parent, output):
    """Adopt authored count values as inert data; never compile or execute Wasm."""
    import numpy as np

    from loci_engine import research_methods as methods
    from loci_engine.research_jobs import run_job, submit_job

    # Core module with one bounded memory and a constant-return ABI function.
    sections = [
        (1, bytes.fromhex("0160047f7f7f7f017f")),
        (3, b"\x01\0"),
        (5, bytes.fromhex("0101018004")),
        (7, b"\x02\x06memory\x02\0" + bytes([len(b"loci_method_v1")]) + b"loci_method_v1\0\0"),
        (10, bytes.fromhex("01040041000b")),
    ]
    module = b"\0asm\x01\0\0\0" + b"".join(
        bytes([kind, len(data)]) + data for kind, data in sections
    )
    manifest = {
        "schema": "loci.controlled-method/v1",
        "id": "external-agent-authored-count",
        "version": "1.0.0",
        "abi": "loci-method-buffers/v1",
        "module": {"sha256": hashlib.sha256(module).hexdigest(), "bytes": len(module)},
        "rights": {
            "license": "Apache-2.0",
            "source": "Loci authored technical QA fixture",
            "use_basis": "Data-only adoption; no runtime or biological qualification",
        },
        "metrics": [
            {
                "id": "pixel_count",
                "kind": "measurement",
                "unit": "pixel",
                "description": "Authored per-label pixel count; not an executed method",
            }
        ],
    }
    path = output / "authored-method.json"
    write_json(
        path,
        {
            "schema": "loci.controlled-method-package/v1",
            "manifest": manifest,
            "module_base64": base64.b64encode(module).decode(),
        },
    )
    saved = methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY)
    request = {
        **binding(parent),
        **{k: saved[k] for k in ("method_id", "manifest_sha256", "module_sha256")},
        "raw_channels": [0],
        "working_bytes": MEMORY,
    }
    flight = methods.preflight(wb, request)
    labels = wb.project.load_array(parent["arrays"]["labels"])
    rows = [
        {"label_id": int(label), "values": [float(np.count_nonzero(labels == label))]}
        for label in flight["preflight"]["label_ids"]
    ]
    external = output / "authored-output.bin"
    external.write_bytes(
        struct.pack("<8sII", b"LOCIMO01", len(rows), 1)
        + b"".join(struct.pack("<Id", row["label_id"], row["values"][0]) for row in rows)
    )
    exact = {**request, "preflight_hash": flight["preflight_hash"]}
    grant = methods.create_output_grant(wb, external, exact, authority=methods.NATIVE_AUTHORITY)
    job = submit_job(
        wb,
        {**exact, "mode": "adopt-external", "output_grant_id": grant["output_grant_id"]},
        "native-prepared-authored-method",
        operation="method_run",
    )
    run_job(wb, job["id"])
    published = wb.project.job(job["id"])
    require(published["state"] == "succeeded", "Native authored method adoption failed")
    return wb.project.result(published["result_ids"][0]), rows


def graph_definition():
    return {
        "schema": "loci.workflow/v2",
        "name": "Morphology and annotation agreement",
        "inputs": {"prediction": "label-result", "reference": "label-result"},
        "nodes": [
            {
                "id": "agreement",
                "operation": "annotation_evaluation_run",
                "contract_version": 1,
                "inputs": {
                    "prediction": {"input": "prediction"},
                    "reference": {"input": "reference"},
                },
                "settings": {
                    "semantics": "instances",
                    "iou_thresholds": [0.5, 0.75],
                    "reference_declaration": "Declared fixed reference plane; agreement only",
                    "working_bytes": MEMORY,
                },
            },
            {
                "id": "morphology",
                "operation": "morphometrics_run",
                "contract_version": 1,
                "inputs": {"objects": {"input": "prediction"}},
                "settings": {"working_bytes": MEMORY},
            },
        ],
        "outputs": {
            "agreement": {"node": "agreement", "port": "result"},
            "morphology": {"node": "morphology", "port": "result"},
        },
        "working_bytes": MEMORY,
    }


def prompt(fixture):
    edit = ""
    if fixture.get("wait_for_human_edit"):
        edit = f"""
IMMEDIATELY after the first plan publication, call ONLY agent_task_read operation=get,
request={{"task_id":"{fixture["task_id"]}"}} repeatedly until task.goal is exactly
{json.dumps(fixture["human_edit_goal"])}. This is an actual human UI edit; do not perform
it yourself. Read calls must stay sequential. The native human edit must be revision2.
Then deliberately call agent_task_write publish_plan with EXACT original plan_request
EXCEPT expected_revision=1. This single stale update MUST fail with 'revision changed'.
This is the ONLY expected tool error. Do not retry or change that stale request.
Re-read task, verify human goal and step titles remain, then publish_plan at the current
expected_revision=2 using ALL goal/steps/state/targets values from that read unchanged.
Keep human-edited goal and titles exactly; this becomes revision3. Continue step1 context
inspection. At the end publish_assessment with expected_revision=3 (not 1).
"""
    return f"""Exercise Loci using ONLY {SERVER} MCP tools, strictly sequentially.
No shell, files, browsing, other servers, embedded agent, plugins or subagents.
Use the EXACT supplied requests. Do not tune segmentation, execute custom methods,
claim human review, infer biological validity or invent model observations.
Every native job: ONLY job_status(job_id) until state=succeeded AND
owned_worker_active=false. A result may publish before its worker exits. Stop on
any unexpected error. Do not retry errors with changed inputs or widen grants.

1. FIRST agent_task_write publish_plan with EXACT plan_request below. Keep revision.
{edit}
Then action_guide, analysis_context, inspect_source(source_id), result on baseline
and reference, and result_view on baseline with labels=true. Examine returned image.
2. inspect_action method_query using EXACT method_query below. These values are
native-adopted authored technical data, NOT code execution or biological evidence.
3. inspect_action annotation_reference_candidates EXACT candidates below; verify
annotation_ids and revision match capture_request. validate_action then submit_action
annotation_reference_run with EXACT capture_request, request_key={CAPTURE_KEY}.
Poll job_status until succeeded AND owned_worker_active=false, then replay that
EXACT submit_action once with same request/key and confirm same job id. This captures
an authored rectangle demonstration, separate from the public/technical label reference.
4. workflow_graph_inspect workflow_graph_preflight with EXACT graph_binding below.
workflow_graph_control workflow_graph_start with that binding plus plan_sha256
from preflight and request_key={GRAPH_KEY}. Then workflow_graph_advance with run_id.
It schedules ONE node. Find run.data.nodes[node].intent.job_id; ONLY poll that
job_status until succeeded AND owned_worker_active=false; then graph_status and
advance. Complete both morphology and agreement nodes, each with its own job.
Inspect final graph_status. Advance completed run once again: same identities.
workflow_graph_control workflow_graph_save_from_run with exact run_id, run_revision,
run_sha256 from successful status, workflow_id={fixture["captured_workflow_id"]},
expected_revision=0,name="Captured morphology and agreement". No re-execution.
5. result on terminal agreement output and morphology output. result_view on terminal
agreement result; examine returned image. inspect_action annotation_evaluation_get
with exact terminal result_id,revision_hash,table="summary".
6. agent_task_write publish_assessment with task_id={fixture["task_id"]},
expected_revision={3 if fixture.get("wait_for_human_edit") else 1}, a concise summary,
observations string list, nonempty limitations string list, and targets including
exact baseline, reference, morphology and terminal
result targets. Result target shape is {{kind:"result",id,revision_hash,source_id,
source_sha256}}; source_id and source_sha256 are the supplied source identity/hash.
Include source target below too. Explicitly state {fixture["case"]} context, absent
physical calibration, annotation agreement limits and that method values were authored
and adopted. No human review or biological validation. agent_task_read get verifies
the saved task. Leave its authored state awaiting_review; do not claim completion of
human review. Finish with exact evidence IDs and findings.

FIXTURE (metadata only, no file access authority):
{json.dumps(fixture, indent=2)}
"""


def prepare(
    *,
    output,
    worker,
    case,
    public_root=PUBLIC_ROOT,
    allow_test_output=False,
    wait_for_human_edit=False,
):
    from loci_engine.agent_policy import DISCLOSURES
    from loci_engine.research_agent_setup import create_agent_access
    from loci_engine.research_project import ResearchProject
    from loci_engine.research_workflow_graph import execute_workflow_graph
    from loci_engine.source_annotations import execute_annotations
    from loci_engine.workbench import Workbench

    require(case in {"synthetic", "fluorescence"}, "Unknown fixture case")
    require(
        not wait_for_human_edit or case == "synthetic",
        "Human-edit synchronization is synthetic-only",
    )
    worker_info = TISSUE.inspect_worker_and_app(worker)
    output = TISSUE.prepare_output_directory(ROOT, output, allow_test_output=allow_test_output)
    for name in ("inputs", "models"):
        (output / name).mkdir(mode=0o700)
    raw, reference_labels, provenance = arrays(case, output / "inputs", public_root)
    study = output / "study.loci-study"
    wb = Workbench(ResearchProject.create(study, f"External agent {case} QA"))
    try:
        source = wb.import_native(str(output / "inputs/image.tif"))
        selection = {
            "x": 0,
            "y": 0,
            "width": raw.shape[1],
            "height": raw.shape[0],
            "z": 0,
            "t": 0,
            "c": 0,
            "level": 0,
        }
        recipe = {
            "source_id": source["id"],
            "selection": selection,
            "recipe": {
                "segmentation": {"method": "components", "threshold": "otsu"},
                "measurement_channels": [0],
                "working_bytes": MEMORY,
            },
        }
        baseline = wb.run_recipe(recipe)["result"]
        image, geometry, resolved = wb.load_scalar(source["id"], selection)
        retained_provenance = copy.deepcopy(provenance)
        if "originals" in retained_provenance:
            retained_provenance["originals"] = {
                name: {"name": Path(info["path"]).name, "sha256": info["sha256"]}
                for name, info in retained_provenance["originals"].items()
            }
        reference = wb.project.save_result(
            source_id=source["id"],
            kind="external-labels",
            arrays={"image": image, "labels": reference_labels},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": resolved,
                "measurement_channels": [0],
                "measurements": [],
                "reference_provenance": retained_provenance,
            },
        )
        method, rows = controlled_result(wb, baseline, output / "inputs")
        state = execute_annotations(wb, "source_annotations", {"source_id": source["id"]})
        annotated = execute_annotations(
            wb,
            "annotate_source",
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "expected_revision": state["revision"],
                "action": "add",
                "annotation": {
                    "kind": "rectangle",
                    "points": [{"x": x, "y": y} for x, y in ((4, 4), (12, 4), (12, 12), (4, 12))],
                    "label": "Authored reference capture demonstration",
                    "color": "#aabbcc",
                    "z": 0,
                    "t": 0,
                },
            },
        )
        definition = graph_definition()
        workflow = execute_workflow_graph(
            wb,
            "workflow_graph_save",
            {
                "workflow_id": uuid.uuid4().hex,
                "expected_revision": 0,
                "definition": definition,
            },
        )["workflow"]
        task_id = uuid.uuid4().hex
        source_target = {"kind": "source", "id": source["id"], "sha256": source["sha256"]}
        fixture = {
            "case": case,
            "wait_for_human_edit": wait_for_human_edit,
            "human_edit_goal": HUMAN_EDIT_GOAL,
            "task_id": task_id,
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "source_target": source_target,
            "baseline": binding(baseline),
            "reference": binding(reference),
            "method_query": {**binding(method), "offset": 0, "limit": 100},
            "candidates": {**binding(baseline), "offset": 0, "limit": 100},
            "capture_request": {
                **binding(baseline),
                "source_annotations_revision": annotated["revision"],
                "annotation_ids": [a["id"] for a in annotated["annotations"]],
                "semantics": "instances",
                "coverage_declaration": "Authored rectangle demo only",
                "working_bytes": MEMORY,
            },
            "graph_binding": {
                "workflow_id": workflow["id"],
                "workflow_revision": workflow["revision"],
                "definition_sha256": workflow["data"]["definition_sha256"],
                "bindings": {"prediction": binding(baseline), "reference": binding(reference)},
            },
            "captured_workflow_id": uuid.uuid4().hex,
            "plan_request": {
                "task_id": task_id,
                "expected_revision": 0,
                "goal": "Inspect fixed images and compare exact labels with explicit limitations",
                "steps": [
                    {
                        "id": "inspect",
                        "title": "Inspect images and measurements",
                        "state": "planned",
                        "note": "",
                        "targets": [target(baseline)],
                    },
                    {
                        "id": "compare",
                        "title": "Run morphology and annotation agreement",
                        "state": "planned",
                        "note": "",
                        "targets": [target(reference)],
                    },
                ],
                "state": "awaiting_review",
                "targets": [source_target, target(baseline), target(reference)],
            },
        }
        access = create_agent_access(
            wb,
            {
                **recipe,
                "allow_preview": False,
                "allow_run": True,
                "allow_export": False,
                "export_names": [],
                "allow_task_records": True,
                "allow_workflow_graph": True,
                "disclosures": sorted(DISCLOSURES),
                "limits": {"cpu_seconds": 120, "memory_bytes": 1024**3, "concurrency": 1},
                "delegation": {
                    "client_id": "codex-external-agent-qa",
                    "result_scope": "granted-sources",
                    "allow_review": False,
                    "expires_at": (datetime.now(UTC) + timedelta(hours=4)).isoformat(),
                },
                "actions": [
                    "annotation_reference_candidates",
                    "annotation_reference_run",
                    "annotation_evaluation_run",
                    "annotation_evaluation_get",
                    "morphometrics_run",
                    "method_query",
                ],
                "permission_mode": "full_access",
            },
            output / "access",
        )
        initial = {
            "results": [binding(r) for r in wb.project.list_results()],
            "jobs": [j["id"] for j in wb.project.list_jobs()],
        }
    finally:
        wb.close()
    prompt_path = output / "prompt.txt"
    prompt_path.write_text(prompt(fixture))
    prepared = {
        "schema": "loci.codex-external-agent-prepared/v1",
        "output": str(output),
        "repo": str(ROOT),
        "case": case,
        "worker": worker_info,
        "study": str(study),
        "model_home": str(output / "models"),
        "policy_path": str(output / "access/agent-policy.json"),
        "policy_sha256": access["policy_sha256"],
        "fixture": fixture,
        "provenance": provenance,
        "method_rows": rows,
        "initial": initial,
        "prompt_path": str(prompt_path),
        "prompt_sha256": digest(prompt_path),
        "source_hashes": sources_hashes(),
        "input_hashes": TISSUE.tree_hashes(output / "inputs"),
        "initial_study_hashes": TISSUE.tree_hashes(study),
        "model_requested": MODEL,
        "effort_requested": EFFORT,
        "service_tier_requested": "default",
        "human_review": False,
    }
    write_json(output / "prepared-fixture.json", prepared, mode=0o600)
    return prepared


def identity(output, *, unused=False):
    prepared = read_json(output / "prepared-fixture.json")
    require(
        prepared["schema"] == "loci.codex-external-agent-prepared/v1", "Unknown prepared schema"
    )
    require(Path(prepared["output"]).resolve(strict=True) == output, "Prepared output mismatch")
    require(
        sources_hashes() == prepared["source_hashes"],
        "Engine/harness source changed after preparation",
    )
    require(
        TISSUE.inspect_worker_and_app(Path(prepared["worker"]["worker_path"]))
        == prepared["worker"],
        "Frozen worker/app changed",
    )
    require(
        TISSUE.tree_hashes(output / "inputs") == prepared["input_hashes"], "Fixture inputs changed"
    )
    require(digest(prepared["policy_path"]) == prepared["policy_sha256"], "Pinned policy changed")
    require(digest(prepared["prompt_path"]) == prepared["prompt_sha256"], "Host prompt changed")
    require(not TISSUE.tree_hashes(output / "models"), "Unexpected model files")
    for info in prepared["provenance"].get("originals", {}).values():
        require(digest(info["path"]) == info["sha256"], "Public original changed")
    if unused:
        require(
            not (output / "host-attempt.json").exists(),
            "Prepared root already attempted; preserve and prepare a new root",
        )
        require(
            not TISSUE.study_sessions(Path(prepared["study"])),
            "Prepared study already has agent sessions",
        )
        require(
            TISSUE.tree_hashes(Path(prepared["study"])) == prepared["initial_study_hashes"],
            "Prepared study changed before host launch",
        )
        for name in (
            "codex-events.jsonl",
            "answer.txt",
            "codex-stderr.log",
            "host-run.json",
            "session-at-exit.json",
        ):
            require(not (output / name).exists(), "Prepared root contains prior host artifacts")
    return prepared


def command(codex, prepared, output):
    prefix = f"mcp_servers.{SERVER}."
    settings = {
        "model_reasoning_effort": EFFORT,
        "service_tier": "default",
        "approval_policy": "never",
        prefix + "command": prepared["worker"]["worker_path"],
        prefix + "args": ["--cli", "mcp", "--policy", prepared["policy_path"]],
        prefix + "env.LOCI_MODEL_HOME": prepared["model_home"],
        prefix + "required": True,
        prefix + "startup_timeout_sec": 60,
        prefix + "tool_timeout_sec": 180,
        prefix + "default_tools_approval_mode": "auto",
    }
    result = [
        str(codex),
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
        MODEL,
    ]
    for key, value in settings.items():
        result.extend(["-c", f"{key}={json.dumps(value)}"])
    return [*result, "-o", str(output / "answer.txt"), "-"]


def response(call):
    return TISSUE.extract_structured(call)


def expected_stale_error(item, expected):
    if (
        expected is None
        or item.get("tool") != "agent_task_write"
        or item.get("arguments")
        != {
            "operation": "publish_plan",
            "request": expected,
        }
    ):
        return False
    result = item.get("result") or {}
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    return (
        not item.get("error")
        and item.get("status") in {"completed", "failed"}
        and result.get("structured_content", result.get("structuredContent")) is None
        and len(texts) == 1
        and "revision changed" in texts[0]
        and texts[0].startswith("Error executing tool agent_task_write:")
        and (result.get("isError") or result.get("is_error") or item.get("status") == "failed")
    )


def host_calls(events, *, expected_stale_request=None):
    """Reject SDK/simulations, tools outside scope, overlaps and calls during worker exit."""
    require(TISSUE.host_thread_id(events), "Missing host thread")
    require(any(e.get("type") == "turn.completed" for e in events), "Host turn did not complete")
    active, seen, calls, executing = None, set(), [], None
    exited_jobs = set()
    for event in events:
        require(
            not event.get("event_origin")
            and not event.get("simulated")
            and not event.get("type", "").startswith("sdk."),
            "SDK or simulated transcript cannot qualify a host",
        )
        require(event.get("type") not in {"error", "turn.failed"}, "Host turn failed")
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        require(
            item.get("type") in {"reasoning", "agent_message", "mcp_tool_call"},
            "Host bypassed MCP-only tools",
        )
        if item["type"] != "mcp_tool_call":
            continue
        require(item.get("server") == SERVER, "Host called another MCP server")
        if event["type"] == "item.started":
            require(active is None and item.get("id") not in seen, "Overlapped/reused MCP call")
            require(isinstance(item.get("id"), str) and item["id"], "Missing MCP call identity")
            active = item
            seen.add(item["id"])
            continue
        require(
            event["type"] == "item.completed" and active is not None, "Unmatched MCP completion"
        )
        require(
            all(active.get(k) == item.get(k) for k in ("id", "server", "tool", "arguments")),
            "MCP start/completion mismatch",
        )
        active = None
        tool, args = item.get("tool"), item.get("arguments")
        require(tool in ALLOWED and isinstance(args, dict), "Unexpected MCP tool/arguments")
        require(
            ALLOWED[tool] is None or args.get("operation") in ALLOWED[tool],
            "Unexpected MCP operation",
        )
        if executing:
            require(
                tool == "job_status" and args == {"job_id": executing},
                "Called another tool before owned worker exit",
            )
        if expected_stale_error(item, expected_stale_request):
            calls.append({**item, "_expected_error": True})
            continue
        payload = response(item)
        if tool == "submit_action":
            identity_ = payload["job"]["id"]
            if identity_ not in exited_jobs:
                executing = identity_
        elif tool == "workflow_graph_control" and args["operation"] == "workflow_graph_advance":
            run = payload["run"]["data"]
            running = [
                n["intent"]["job_id"]
                for n in run["nodes"].values()
                if n.get("intent", {}).get("job_id") and n["intent"]["job_id"] not in exited_jobs
            ]
            require(len(running) <= 1, "Graph scheduled concurrent children")
            if running:
                executing = running[0]
        elif tool == "job_status":
            job = payload["job"]
            require(job["id"] == args["job_id"], "Job status identity mismatch")
            require(
                job["state"] in {"queued", "running", "succeeded"}, "Owned job failed/cancelled"
            )
            if job["state"] == "succeeded" and job.get("owned_worker_active") is False:
                exited_jobs.add(job["id"])
                executing = None
        calls.append(item)
    require(calls and active is None and executing is None, "Unfinished MCP call/owned worker")
    return calls


def matching(calls, tool, operation=None):
    return [
        c
        for c in calls
        if c["tool"] == tool
        and not c.get("_expected_error")
        and (operation is None or c["arguments"].get("operation") == operation)
    ]


def one(calls, tool, operation=None):
    found = matching(calls, tool, operation)
    require(len(found) == 1, f"Expected one {tool}/{operation}")
    return found[0]


def independent_agreement(prediction, reference):
    """Independent dense intersection/count oracle, preserving nonconsecutive label IDs."""
    import numpy as np
    from scipy.optimize import linear_sum_assignment

    pids = np.unique(prediction[prediction != 0])
    rids = np.unique(reference[reference != 0])
    intersection = int(np.count_nonzero((prediction != 0) & (reference != 0)))
    union = int(np.count_nonzero((prediction != 0) | (reference != 0)))
    scores = {}
    pairwise = np.zeros((len(rids), len(pids)), float)
    for i, rid in enumerate(rids):
        for j, pid in enumerate(pids):
            shared = np.count_nonzero((reference == rid) & (prediction == pid))
            total = np.count_nonzero((reference == rid) | (prediction == pid))
            pairwise[i, j] = shared / total
    for threshold in (0.5, 0.75):
        # Cardinality dominates IoU sum; dummy assignment permits unmatched instances.
        eligible = pairwise >= threshold
        utility = eligible * (1 + min(len(rids), len(pids))) + pairwise * eligible
        rows, cols = linear_sum_assignment(utility, maximize=True)
        tp = sum(bool(eligible[r, c]) for r, c in zip(rows, cols, strict=True))
        scores[str(threshold)] = {
            "true_positive": tp,
            "false_positive": len(pids) - tp,
            "false_negative": len(rids) - tp,
        }
    return {
        "intersection_pixels": intersection,
        "union_pixels": union,
        "prediction_pixels": int(np.count_nonzero(prediction)),
        "reference_pixels": int(np.count_nonzero(reference)),
        "reference_count": len(rids),
        "prediction_count": len(pids),
        "scores": scores,
    }


def verify_metrics(metrics, prediction, reference):
    oracle = independent_agreement(prediction, reference)
    for name in ("intersection_pixels", "union_pixels", "prediction_pixels", "reference_pixels"):
        require(metrics["region"][name] == oracle[name], "Region pixel oracle mismatch")
    union = oracle["union_pixels"]
    expected_iou = oracle["intersection_pixels"] / union if union else None
    pixels = oracle["prediction_pixels"] + oracle["reference_pixels"]
    expected_dice = 2 * oracle["intersection_pixels"] / pixels if pixels else None
    require(
        metrics["region"]["iou"] == expected_iou and metrics["region"]["dice"] == expected_dice,
        "Region ratio oracle mismatch",
    )
    for name in ("reference_count", "prediction_count"):
        require(metrics["instances"][name] == oracle[name], "Instance-count oracle mismatch")
    require(
        [row["iou_threshold"] for row in metrics["instances"]["scores"]] == [0.5, 0.75],
        "Instance matching threshold drift",
    )
    for row in metrics["instances"]["scores"]:
        for name, value in oracle["scores"][str(row["iou_threshold"])].items():
            require(row[name] == value, "Independent instance assignment mismatch")
    return oracle


def bind_exit_session(output, metadata, current):
    """Keep the observed exit record immutable across an actual UI reconciliation."""
    saved = read_json(output / "session-at-exit.json")
    require(value_hash(saved) == metadata["session_sha256"], "Exit session snapshot changed")
    if current != saved:
        lifecycle = {
            "state",
            "ended_at",
            "updated_at",
            "current_operation",
            "active_approval_id",
            "disconnect_reason",
        }
        require(
            saved.get("state") == "connected_idle"
            and current.get("state") == "interrupted"
            and current.get("disconnect_reason") == "MCP server process is no longer running"
            and current.get("current_operation") is None
            and current.get("active_approval_id") is None
            and current.get("ended_at") is not None
            and {k: v for k, v in current.items() if k not in lifecycle}
            == {k: v for k, v in saved.items() if k not in lifecycle},
            "Durable host session changed outside native shutdown reconciliation",
        )
    if saved.get("state") == "interrupted":
        from loci_engine.resource_limits import process_alive

        pid = saved.get("private_pid")
        require(
            type(pid) is int
            and pid > 0
            and not process_alive(pid)
            and saved.get("disconnect_reason") == "MCP server process is no longer running"
            and saved.get("current_operation") is None
            and saved.get("active_approval_id") is None
            and saved.get("last_error") is None
            and saved.get("ended_at") is not None,
            "Interrupted exit lacks exact dead-server lifecycle evidence",
        )
        shutdown = {
            "persisted_state": "interrupted",
            "clean_disconnect_recorded": False,
            "server_process_running": False,
            "expected_reconciled_state": "interrupted",
        }
    else:
        shutdown = TISSUE.session_shutdown_evidence(saved, expect_mode="codex-host")
    shutdown["current_persisted_state"] = current["state"]
    shutdown["native_reconciliation_observed"] = current != saved
    return saved, shutdown


def verify(output):
    """Read-only verification. Local records are traceability, not cryptographic attestation."""
    import numpy as np

    from loci_engine.agent_tasks import task_snapshot
    from loci_engine.research_project import ResearchProject

    prepared = identity(output)
    events_path = output / "codex-events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines() if line.strip()]
    stale_request = (
        {**prepared["fixture"]["plan_request"], "expected_revision": 1}
        if prepared["fixture"].get("wait_for_human_edit")
        else None
    )
    calls = host_calls(events, expected_stale_request=stale_request)
    metadata = read_json(output / "host-run.json")
    sessions = TISSUE.study_sessions(Path(prepared["study"]))
    require(len(sessions) == 1, "Expected exactly one actual host MCP session")
    session, shutdown = bind_exit_session(output, metadata, sessions[0])
    require(session.get("client_id") == "codex-mcp-client", "Non-Codex MCP client")
    require(
        metadata["codex_version"] == "codex-cli " + session.get("client_version", ""),
        "Host/client version mismatch",
    )
    require(
        metadata["execution_mode"] == "codex-host" and metadata["exit_code"] == 0,
        "Host did not exit successfully",
    )
    require(
        metadata["command"] == command(metadata["codex_executable"], prepared, output),
        "Host command drift",
    )
    require(
        digest(metadata["codex_executable"]) == metadata["codex_sha256"], "Codex executable drift"
    )
    require(metadata["thread_id"] == TISSUE.host_thread_id(events), "Thread mismatch")
    require(
        metadata["transcript_sha256"] == digest(events_path)
        and metadata["prepared_sha256"] == digest(output / "prepared-fixture.json")
        and metadata["session_sha256"] == value_hash(session),
        "Host provenance binding mismatch",
    )
    require(
        metadata["model_observed"] is None
        and metadata["observed_model_basis"] == "not-exposed-by-cli-json",
        "Unverifiable observed-model claim",
    )
    require(
        datetime.fromisoformat(metadata["started_at"])
        <= datetime.fromisoformat(session["started_at"])
        <= datetime.fromisoformat(metadata["finished_at"]),
        "Session outside launcher interval",
    )
    for name in ("answer.txt", "codex-stderr.log", "session-at-exit.json"):
        require(digest(output / name) == metadata["files_sha256"][name], "Host output changed")
    fixture = prepared["fixture"]
    project = ResearchProject(prepared["study"])
    require(
        calls[0]["tool"] == "agent_task_write"
        and calls[0]["arguments"]
        == {"operation": "publish_plan", "request": fixture["plan_request"]},
        "Host did not publish exact plan first",
    )
    require(
        matching(calls, "action_guide") and matching(calls, "analysis_context"),
        "Host did not inspect native context",
    )
    source_call = one(calls, "inspect_source")
    require(
        source_call["arguments"] == {"source_id": fixture["source_id"]}
        and response(source_call).get("verified") is True
        and response(source_call).get("source_sha256") == fixture["source_sha256"],
        "Host source inspection mismatch",
    )
    require(
        one(calls, "inspect_action", "method_query")["arguments"]["request"]
        == fixture["method_query"],
        "Method query binding drift",
    )
    method_value = response(one(calls, "inspect_action", "method_query"))
    require(
        method_value["rows"] == prepared["method_rows"][:100]
        and method_value["origin"] == "adopted-external",
        "Authored method values/origin drift",
    )
    candidates = one(calls, "inspect_action", "annotation_reference_candidates")
    require(
        candidates["arguments"]["request"] == fixture["candidates"],
        "Annotation candidates binding drift",
    )
    candidate_value = response(candidates)
    require(
        candidate_value["source_annotations_revision"]
        == fixture["capture_request"]["source_annotations_revision"]
        and [c["id"] for c in candidate_value["candidates"]]
        == fixture["capture_request"]["annotation_ids"],
        "Annotation candidate identity/revision drift",
    )
    capture_validation = one(calls, "validate_action", "annotation_reference_run")
    require(
        capture_validation["arguments"]["request"] == fixture["capture_request"]
        and response(capture_validation).get("authorized") is True,
        "Host did not validate exact annotation capture",
    )
    capture = matching(calls, "submit_action", "annotation_reference_run")
    require(
        len(capture) == 2
        and capture[0]["arguments"]
        == capture[1]["arguments"]
        == {
            "operation": "annotation_reference_run",
            "request": fixture["capture_request"],
            "request_key": CAPTURE_KEY,
        },
        "Missing exact capture replay",
    )
    capture_id = response(capture[0])["job"]["id"]
    require(response(capture[1])["job"]["id"] == capture_id, "Capture replay duplicated job")
    preflight = one(calls, "workflow_graph_inspect", "workflow_graph_preflight")
    require(
        preflight["arguments"]["request"] == fixture["graph_binding"],
        "Graph preflight binding drift",
    )
    plan = response(preflight)["plan"]
    start = one(calls, "workflow_graph_control", "workflow_graph_start")
    start_request = {
        **fixture["graph_binding"],
        "plan_sha256": plan["plan_sha256"],
        "request_key": GRAPH_KEY,
    }
    require(
        start["arguments"]["request"] == start_request, "Graph start did not bind exact preflight"
    )
    run = response(start)["run"]
    run_id = run["id"]
    docs = project.documents("workflow_run", document_id=run_id)
    require(
        len(docs) == 1 and docs[0]["data"]["state"] == "succeeded",
        "Composed graph not durably successful",
    )
    data = docs[0]["data"]
    require(
        data["plan"] == plan and data["request_sha256"] == value_hash(start_request),
        "Graph plan/intention identity drift",
    )
    require(data["plan"]["definition"] == graph_definition(), "Graph definition changed")
    require(
        data["plan"]["bindings"] == fixture["graph_binding"]["bindings"], "Graph inputs changed"
    )
    child_ids = {n["intent"]["job_id"] for n in data["nodes"].values()}
    require(len(child_ids) == 2, "Graph did not execute two distinct native children")
    jobs = [j for j in project.list_jobs() if j["id"] not in prepared["initial"]["jobs"]]
    require(
        {j["id"] for j in jobs} == child_ids | {capture_id}, "Unexpected or duplicated native jobs"
    )
    owner = {"policy_sha256": prepared["policy_sha256"], "session_id": session["session_id"]}
    require(data["owner"] == owner, "Graph run owner drift")
    for job in jobs:
        require(
            job["state"] == "succeeded" and job.get("owner") == owner,
            "Native job owner/state mismatch",
        )
        require(
            any(
                response(c)["job"]["state"] == "succeeded"
                and response(c)["job"].get("owned_worker_active") is False
                for c in matching(calls, "job_status")
                if c["arguments"] == {"job_id": job["id"]}
            ),
            "Missing actual worker-exit observation",
        )
    captured = project.documents("workflow", document_id=fixture["captured_workflow_id"])
    require(
        len(captured) == 1
        and captured[0]["data"]["definition"]["nodes"] == graph_definition()["nodes"],
        "Successful workflow was not captured",
    )
    saved_call = one(calls, "workflow_graph_control", "workflow_graph_save_from_run")
    require(
        saved_call["arguments"]["request"]
        == {
            "run_id": run_id,
            "run_revision": docs[0]["revision"],
            "run_sha256": data["run_sha256"],
            "workflow_id": fixture["captured_workflow_id"],
            "expected_revision": 0,
            "name": "Captured morphology and agreement",
        },
        "Captured workflow did not bind exact successful run",
    )
    advances = matching(calls, "workflow_graph_control", "workflow_graph_advance")
    require(
        len(advances) >= 3
        and response(advances[-1])["state"] == "succeeded"
        and response(advances[-1])["run"] == docs[0],
        "Completed graph replay changed run identities",
    )
    terminal = project.result(data["outputs"]["agreement"]["result_id"])
    morphology_job = next(j for j in jobs if j["operation"] == "morphometrics_run")
    morphology = project.result(morphology_job["result_ids"][0])
    baseline = project.result(fixture["baseline"]["result_id"])
    reference = project.result(fixture["reference"]["result_id"])
    prediction = project.load_array(baseline["arrays"]["labels"])
    captured_reference = project.result(project.job(capture_id)["result_ids"][0])
    captured_labels = project.load_array(captured_reference["arrays"]["labels"])
    expected_rectangle = np.zeros_like(prediction)
    expected_rectangle[4:12, 4:12] = 1
    np.testing.assert_array_equal(captured_labels, expected_rectangle)
    expected_ref = np.load(output / "inputs/expected-reference.npy", allow_pickle=False)
    np.testing.assert_array_equal(project.load_array(reference["arrays"]["labels"]), expected_ref)
    np.testing.assert_array_equal(project.load_array(morphology["arrays"]["labels"]), prediction)
    np.testing.assert_array_equal(project.load_array(terminal["arrays"]["labels"]), prediction)
    np.testing.assert_array_equal(
        project.load_array(terminal["arrays"]["reference_labels"]), expected_ref
    )
    report_call = one(calls, "inspect_action", "annotation_evaluation_get")
    require(
        report_call["arguments"]["request"] == {**binding(terminal), "table": "summary"},
        "Terminal report binding drift",
    )
    metrics = response(report_call)["annotation_evaluation"]["metrics"]
    oracle = verify_metrics(metrics, prediction, expected_ref)
    images = []
    viewed = set()
    for call in matching(calls, "result_view"):
        value = response(call)
        identity_ = call["arguments"]["result_id"]
        record = project.result(identity_)
        require(
            value["result_id"] == identity_ and value["revision_hash"] == record["revision_hash"],
            "MCP image binding mismatch",
        )
        blocks = [b for b in call["result"].get("content", []) if b.get("type") == "image"]
        require(
            len(blocks) == 1
            and blocks[0].get("mimeType", blocks[0].get("mime_type")) == "image/png",
            "Missing actual MCP PNG image",
        )
        image = base64.b64decode(blocks[0]["data"], validate=True)
        TISSUE.verify_mcp_view_png(
            value,
            image,
            {
                "image": project.load_array(record["arrays"]["image"]),
                "labels": project.load_array(record["arrays"]["labels"]),
            },
        )
        images.append(
            {
                "call_id": call["id"],
                "result": binding(record),
                "png_sha256": hashlib.sha256(image).hexdigest(),
            }
        )
        viewed.add(identity_)
    require(
        {baseline["id"], terminal["id"]} <= viewed,
        "Host did not view actual baseline and terminal MCP images",
    )
    inspected = {c["arguments"]["result_id"] for c in matching(calls, "result")}
    require(
        {r["id"] for r in (baseline, reference, morphology, terminal)} <= inspected,
        "Host omitted exact result measurements",
    )
    tasks = task_snapshot(project)
    require(
        len(tasks) == 1
        and tasks[0]["id"] == fixture["task_id"]
        and tasks[0]["revision"] == (4 if fixture.get("wait_for_human_edit") else 2),
        "Task publication/revision mismatch",
    )
    task = tasks[0]
    require(
        task["session_id"] == session["session_id"]
        and task["policy_sha256"] == prepared["policy_sha256"]
        and not task["stale"],
        "Task provenance/evidence stale",
    )
    require(
        task["state"] == "awaiting_review"
        and task["updated_by"] == "agent"
        and len(task["assessments"]) == 1,
        "Authored task status/assessment mismatch",
    )
    assessment = task["assessments"][0]
    require(
        assessment["limitations"] and assessment["observations"],
        "Assessment omitted evidence limits",
    )
    for expected in [
        fixture["source_target"],
        *(target(r) for r in (baseline, reference, morphology, terminal)),
    ]:
        require(expected in assessment["targets"], "Assessment lacks exact native evidence target")
    one(calls, "agent_task_write", "publish_assessment")
    reads = matching(calls, "agent_task_read", "get")
    require(
        reads and response(reads[-1])["task"] == task, "Final task read differs from durable record"
    )
    errors = [c for c in calls if c.get("_expected_error")]
    if fixture.get("wait_for_human_edit"):
        require(len(errors) == 1, "Expected exactly one deliberate stale plan rejection")
        human_reads = [response(c)["task"] for c in reads if response(c)["task"]["revision"] == 2]
        require(
            len(human_reads) >= 2
            and all(
                r["goal"] == fixture["human_edit_goal"] and r["updated_by"] == "human"
                for r in human_reads
            ),
            "Missing actual human edit reads before and after stale rejection",
        )
        require(
            task["goal"] == fixture["human_edit_goal"]
            and task["steps"] == human_reads[-1]["steps"],
            "Human goal/step edits were overwritten",
        )
        plans = matching(calls, "agent_task_write", "publish_plan")
        require(len(plans) == 2, "Expected original and human-preserving plan publications")
        require(
            plans[1]["arguments"]["request"]
            == {
                "task_id": task["id"],
                "expected_revision": 2,
                **{key: human_reads[-1][key] for key in ("goal", "steps", "state", "targets")},
            },
            "Agent did not preserve exact human plan edit",
        )
        error_index = calls.index(errors[0])
        expected_read = {"operation": "get", "request": {"task_id": task["id"]}}
        require(
            error_index >= 2
            and all(
                c["tool"] == "agent_task_read" and c["arguments"] == expected_read
                for c in calls[1:error_index]
            ),
            "Host did not wait using only task reads",
        )
        require(
            calls[error_index + 1]["tool"] == "agent_task_read"
            and calls[error_index + 1]["arguments"] == expected_read,
            "Host did not immediately verify human edit after stale rejection",
        )
        require(
            any(calls.index(c) < error_index for c in reads if response(c)["task"]["revision"] == 2)
            and any(
                calls.index(c) > error_index for c in reads if response(c)["task"]["revision"] == 2
            ),
            "Stale rejection did not retain observed human edit across the attempted write",
        )
    else:
        require(
            not errors and len(matching(calls, "agent_task_write", "publish_plan")) == 1,
            "Unexpected authored plan mutation",
        )
    require(
        all(project.review_state(r["id"]) is None for r in project.list_results()),
        "Unexpected human or agent review",
    )
    return {
        "status": "passed-codex-host-engineering-qa",
        "case": prepared["case"],
        "execution_mode": "codex-host",
        "model_requested": MODEL,
        "model_observed": None,
        "session_id": session["session_id"],
        "shutdown": shutdown,
        "task": task,
        "graph_run_id": run_id,
        "jobs": [j["id"] for j in jobs],
        "images": images,
        "oracle": oracle,
        "human_review": False,
        "biological_validation": False,
        "limit": "Unsigned local launcher traceability, not cryptographic host attestation",
    }


def run_host(*, output, timeout=1800):
    prepared = identity(output, unused=True)
    (output / "host-attempt.json").open("x").close()
    receipt = {
        "schema": "loci.codex-external-agent-host/v1",
        "status": "starting",
        "execution_mode": "codex-host",
        "model_requested": MODEL,
        "model_observed": None,
        "observed_model_basis": "not-exposed-by-cli-json",
    }
    started = time.monotonic()
    try:
        executable = shutil.which("codex")
        require(executable is not None, "Installed Codex CLI is unavailable")
        executable = str(Path(executable).resolve(strict=True))
        version = subprocess.check_output([executable, "--version"], text=True).strip()
        cmd = command(executable, prepared, output)
        began = datetime.now(UTC).isoformat()
        receipt.update(
            command=cmd,
            codex_executable=executable,
            codex_sha256=digest(executable),
            codex_version=version,
            started_at=began,
            effort_requested=EFFORT,
            service_tier_requested="default",
        )
        with (
            tempfile.TemporaryDirectory(prefix="loci-codex-external-") as cwd,
            (output / "codex-events.jsonl").open("x") as stream,
            (output / "codex-stderr.log").open("x") as errors,
        ):
            result = subprocess.run(
                cmd,
                input=Path(prepared["prompt_path"]).read_text(),
                text=True,
                stdout=stream,
                stderr=errors,
                cwd=cwd,
                env={**os.environ, "LOCI_MODEL_HOME": prepared["model_home"]},
                timeout=timeout,
                check=False,
            )
        receipt["exit_code"] = result.returncode
        require(
            result.returncode == 0, "Codex host exited nonzero; retain original attempt artifacts"
        )
        sessions = TISSUE.study_sessions(Path(prepared["study"]))
        require(len(sessions) == 1, "Actual host did not create exactly one MCP session")
        write_json(output / "session-at-exit.json", sessions[0], mode=0o600)
        events = [
            json.loads(line)
            for line in (output / "codex-events.jsonl").read_text().splitlines()
            if line.strip()
        ]
        metadata = {
            **receipt,
            "command": cmd,
            "codex_executable": executable,
            "codex_sha256": receipt["codex_sha256"],
            "codex_version": version,
            "started_at": began,
            "finished_at": datetime.now(UTC).isoformat(),
            "exit_code": result.returncode,
            "thread_id": TISSUE.host_thread_id(events),
            "transcript_sha256": digest(output / "codex-events.jsonl"),
            "prepared_sha256": digest(output / "prepared-fixture.json"),
            "session_sha256": value_hash(sessions[0]),
            "files_sha256": {
                name: digest(output / name)
                for name in ("answer.txt", "codex-stderr.log", "session-at-exit.json")
            },
        }
        write_json(output / "host-run.json", metadata, mode=0o600)
        verification = verify(output)
        write_json(output / "verification.json", verification, mode=0o600)
        receipt.update(status=verification["status"], verification=verification)
        return verification
    except BaseException as error:
        receipt.update(status="failed", error={"type": type(error).__name__, "message": str(error)})
        raise
    finally:
        receipt["elapsed_seconds"] = time.monotonic() - started
        write_json(output / "receipt.json", receipt, mode=0o600)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "run-host", "verify"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--case", choices=("synthetic", "fluorescence"), default="synthetic")
    parser.add_argument("--public-root", type=Path, default=PUBLIC_ROOT)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--wait-for-human-edit", action="store_true")
    args = parser.parse_args(argv)
    output = args.output.expanduser().absolute()
    if args.phase == "prepare" or (args.phase == "run-host" and not output.exists()):
        require(args.worker is not None, "--worker is required for a new preparation")
        prepared = prepare(
            output=output,
            worker=args.worker,
            case=args.case,
            public_root=args.public_root,
            wait_for_human_edit=args.wait_for_human_edit,
        )
        if args.phase == "prepare":
            print(json.dumps(prepared, indent=2))
            return 0
    else:
        require(output.resolve(strict=True) == output, "Output must be a canonical existing root")
        if args.worker is not None:
            require(
                str(args.worker.expanduser().resolve(strict=True))
                == read_json(output / "prepared-fixture.json")["worker"]["worker_path"],
                "Requested worker differs from the prepared worker",
            )
    result = (
        run_host(output=output, timeout=args.timeout)
        if args.phase == "run-host"
        else verify(output)
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
