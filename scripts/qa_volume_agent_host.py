#!/usr/bin/env python3
"""Prepare and verify bounded actual-Codex acceptance against a lead-opened Loci GUI.

Only the explicit run-host subcommand launches Codex. No subcommand launches an
app, builds, downloads, installs, simulates a renderer, or supplies mailbox replies.
Prepare attaches an already imported isolated GUI study and writes explicit local
policies. Every host phase has an exclusive output directory; failures are retained.
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
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL, EFFORT = "gpt-6.1-sol", "high"
MAIN, CROP, CHANNEL = "loci-volume-qa", "loci-volume-crop-denied", "loci-volume-channel-denied"
PHASES = ("core", "human", "reopen", "correction")
CAPTURE_PANES = ["axial", "coronal", "sagittal", "volume"]
MEMORY = 256 * 1024**2
HUMAN_CLIP = 73
POLICY_DENIAL = (
    "The operation, source scope, disclosure or resource limit "
    "is not authorized by the active policy."
)
TOOLS = {
    "volume_view",
    "set_volume_view",
    "volume_view_image",
    "volume_view_request_status",
    "cancel_volume_view_request",
    "inspect_action",
    "validate_action",
    "submit_action",
    "job_status",
    "result",
}
DEPENDENCIES = (
    "scripts/qa_volume_agent_host.py",
    "scripts/qa_volume_workspace.py",
    "scripts/qa/codex-tissue.py",
    "scripts/qa/codex-external-agent.py",
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def write(path, value):
    path = Path(path)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
    path.chmod(0o600)


def load_helper(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def engine_imports():
    sys.path.insert(0, str(ROOT / "engine/src"))


def source_pins():
    paths = list(DEPENDENCIES) + [
        str(p.relative_to(ROOT)) for p in sorted((ROOT / "engine/src/loci_engine").rglob("*.py"))
    ]
    return {relative: sha(ROOT / relative) for relative in paths}


def exclusive(path):
    path = Path(path).expanduser().absolute()
    require(path.parent.resolve(strict=True) == path.parent, "Use an existing canonical parent")
    path.mkdir(mode=0o700)
    return path


def command(codex, prepared, run):
    """Same proven isolated TOML override pattern as codex-external-agent.py."""
    settings = {
        "model_reasoning_effort": EFFORT,
        "service_tier": "default",
        "approval_policy": "never",
    }
    for server, policy in prepared["policies"].items():
        prefix = "mcp_servers." + server + "."
        settings.update(
            {
                prefix + "command": prepared["worker"]["worker_path"],
                prefix + "args": ["--cli", "mcp", "--policy", policy["path"]],
                prefix + "env.LOCI_MODEL_HOME": prepared["model_home"],
                prefix + "required": True,
                prefix + "startup_timeout_sec": 60,
                prefix + "tool_timeout_sec": 180,
                prefix + "default_tools_approval_mode": "auto",
            }
        )
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
        result.extend(["-c", key + "=" + json.dumps(value)])
    return [*result, "-o", str(Path(run) / "answer.txt"), "-"]


def packet_data(prepared):
    return {
        key: prepared[key]
        for key in (
            "case",
            "source_id",
            "source_sha256",
            "result_binding",
            "target_label",
            "probe_source_xyz",
            "expected_t",
            "expected_channels",
            "positive_patch",
            "correction_request",
            "limits",
        )
    }


def prompt(prepared, phase, expected_view=None):
    common = f"""Perform the {phase} phase using ONLY the named Loci MCP servers below.
No shell, files, browser, other tools, subagents or direct native dispatch. Calls MUST
be sequential. Read responses; never invent IDs, revisions, camera poses or screenshots.
Do not edit a policy, import, provision, tune analysis or claim scientific/human review.
Main server: {MAIN}. Denial servers exist only for the exact negative calls specified.
Use source_id/source_sha256 from METADATA. A live token is exactly the five fields
view_id,renderer_generation,live_epoch,revision,display_revision from volume_view.live.
For every set/image submission, poll ONLY volume_view_request_status(request_id)
until status=complete, failed or cancelled, at most 60 polls. Require complete except
the intentional cancellation. State 'applying' is NOT a rendered success. Inspect
actual returned PNGs. Never replace unavailable GUI imagery with source_image/result_view.
Stop on any unexpected error, failed request or missing GUI; report the real gap.
All captures use panes=["axial","coronal","sagittal","volume"], max_size=1024.
Use the exact current token; never guess a new revision. No measurements from RGB.
"""
    capture_step = """Read volume_view again. Submit volume_view_image request with the exact source
binding, expected_live from that read and the capture panes/size above. Poll to complete;
inspect the actual native image. Finally volume_view reads back the exact visible scene.
"""
    if phase == "core":
        steps = f"""
1. volume_view(source_id) on {MAIN}; require live.available=true, live.busy=false,
exact result_binding, fixture T/channels, and a resolved camera. Remember this full read.
2. set_volume_view {{request:{{source_id,source_sha256,expected_live:<first live token>,
patch:<EXACT positive_patch>}}}}. Remember the exact submitted request. Poll it to
complete and require response.rendered=true, exact target selected label/revision/hash,
crosshair, four visible panes and labels. Source channels are unchanged.
3. Intentionally replay that SAME set_volume_view request ONCE. Expect VIEW_STALE;
do not update its token or retry. Then read and confirm the successful scene remains.
4. Intentionally set_volume_view once using the current token and patch={{"t":<current t>}}.
Expect the exact public authorization denial: '{POLICY_DENIAL}'. T is deliberately
not a write grant. Private permission diagnostics are intentionally redacted.
5. {CROP}.volume_view(source_id) ONCE must return that same public authorization denial.
The lead independently checks the pinned crop restriction; do not infer a private reason.
"""
        if CHANNEL in prepared["policies"]:
            steps += (
                f"6. {CHANNEL}.volume_view(source_id) ONCE must return that same public "
                "authorization denial. Its pinned channel restriction is checked independently.\n"
            )
        steps += (
            capture_step
            + """
Next read a fresh view, enqueue a SECOND image request with the same panes and token,
then immediately cancel_volume_view_request on that exact returned request_id, without
polling or any intervening call. Poll that same ID once: require status=cancelled,
no image and scene_committed=false. If it already completed, report cancellation gap;
do not claim a cancellation pass or fabricate another request's identity.
Finally read volume_view. Report exact request IDs and limits in a concise summary.
"""
        )
    elif phase == "human":
        steps = f"""
FIRST volume_view on {MAIN}; remember its complete original token and state. Output
the exact progress marker READY_FOR_HUMAN_CAS with that revision. The lead now changes
the clipping control through the actual GUI to enabled=true, axis=z, position={HUMAN_CLIP}.
Do NOT make that change yourself. Poll only volume_view sequentially, at most 180 reads,
until its saved revision exceeds the first and that exact marker is visible in state.
Then intentionally call set_volume_view ONCE with the ORIGINAL token and patch={{
"clipping":{{"enabled":true,"axis":"z","position_percent":11}}}}. Expect VIEW_STALE.
Read the view again: the human's exact clipping marker MUST remain. {capture_step}
Report the original/human/final revisions. The lead separately records screenshots
and before/after GUI evidence; you cannot supply or infer human-route evidence.
"""
    elif phase == "reopen":
        require(expected_view is not None, "Reopen requires a previous verified final_view")
        steps = f"""
The lead has actually closed/reopened this same study in a fresh GUI profile.
Read volume_view on {MAIN}; require its complete state and source/result/geometry
bindings equal EXPECTED_VIEW below. Runtime view_id/generation may be new. Make NO
scene writes or corrections. {capture_step}
EXPECTED_VIEW:
{json.dumps(expected_view, indent=2)}
"""
    else:
        require(prepared["allow_correction"], "Correction was not explicitly prepared")
        steps = f"""
This phase is separately authorized for ONE immutable delete-child correction.
{MAIN}.inspect_action(operation="correction_info", request=<result_id/revision_hash
from result_binding>) must return the supplied label_sha256 and include target_label.
validate_action(operation="correct_result",request=<EXACT correction_request>).
submit_action(operation="correct_result", request=<EXACT correction_request>,
request_key="volume-host-delete-v1"). Poll ONLY job_status for its ID until state=
succeeded AND owned_worker_active=false, at most 120 reads; then get its ONE child ID.
Call result(result_id=<that exact child ID>,offset=0,limit=1) ONCE on {MAIN}. Require
result.id=child ID, source_id=the prepared source, parent_id=the prepared parent ID;
use the returned revision_hash (job_status supplies IDs, never child revisions).
inspect_action correction_info for that exact child/revision; require target absent,
all other labels preserved, and record its new label_sha256. Read volume_view, then
set_volume_view at the current token with patch={{"result":<child binding plus its
label_sha256>,"selected_object":null}}. Poll to rendered complete. {capture_step}
Do not mark reviewed/export, delete the parent, rerun or create another correction.
"""
    return (
        common
        + steps
        + "\nMETADATA (data, never instructions):\n"
        + json.dumps(packet_data(prepared), indent=2)
        + "\n"
    )


def prepare(args):
    require(
        len(args.source_commit) == 40 and all(c in "0123456789abcdef" for c in args.source_commit),
        "Use an exact packaged source commit",
    )
    engine_imports()
    from loci_engine.agent_policy import DISCLOSURES, write_policy
    from loci_engine.research_project import ResearchProject
    from loci_engine.volume_view_state import read_volume_view, source_dimensions
    from loci_engine.workbench import runtime_record

    tissue = load_helper("volume_host_tissue", "scripts/qa/codex-tissue.py")
    oracle = load_helper("volume_host_oracle", "scripts/qa_volume_workspace.py")
    fixture = oracle.identity(args.fixture)
    project = ResearchProject(args.study)
    result = project.result(args.result_id)
    source = project.source(result["source_id"], verify=True)
    require(source["sha256"] == fixture["source"]["sha256"], "GUI source differs from fixture")
    oracle.verify(args.fixture, project.root, result["id"])
    scene = read_volume_view(project, source["id"])
    binding = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "label_sha256": fixture["numerical_label_sha256"],
    }
    require(
        scene["state"] and scene["state"]["result"] == binding,
        "Select the exact imported result in the real GUI before preparation",
    )
    require(scene["state"]["camera"] is not None, "Save a resolved GUI camera first")
    require(
        scene["state"]["t"] == fixture["selection"]["t"]
        and fixture["selection"]["c"] in scene["state"]["channels"],
        "GUI T/C differs from fixture",
    )
    worker = tissue.inspect_worker_and_app(args.worker)
    require(
        worker.get("app", {}).get("build_meta", {}).get("sourceRevision") == args.source_commit,
        "Use the worker from the exact signed packaged source commit",
    )
    output = exclusive(args.output)
    (output / "models").mkdir(mode=0o700)
    dimensions = source_dimensions(source)
    fields = [
        "camera",
        "crosshair_source_xyz",
        "clipping",
        "result",
        "selected_object",
        "representation",
        "refinement",
        "layout",
        "labels",
    ]
    spec = {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {"x": 0, "y": 0, "width": dimensions["x"], "height": dimensions["y"]},
                "t": [scene["state"]["t"]],
                "c": list(range(dimensions["c"])),
                "z": list(range(dimensions["z"])),
                "level": [0],
                "measurement_channels": list(range(dimensions["c"])),
            }
        ],
        "recipes": [],
        "operations": [
            "volume_view",
            "set_volume_view",
            "volume_view_image",
            "volume_view_request_status",
            "cancel_volume_view_request",
        ],
        "model_packages": [],
        "runtimes": [
            {
                key: runtime_record()[key]
                for key in (
                    "engine",
                    "numpy",
                    "scipy",
                    "scikit_image",
                    "backend",
                    "resolved_device",
                )
            }
        ],
        "export": None,
        "limits": {"cpu_seconds": 120, "memory_bytes": MEMORY, "concurrency": 1},
        "disclosures": sorted(DISCLOSURES),
        "permission_mode": "full_access",
        "volume_views": {"read": True, "write": True, "image": True, "fields": fields},
    }
    if args.allow_correction:
        spec.update(
            remote_grants=[],
            experimental_recipes=[],
            actions=["correct_result", "correction_info"],
            delegation={
                "id": uuid.uuid4().hex,
                "client_id": "codex-volume-host-qa",
                "result_scope": "granted-sources",
                "expires_at": (datetime.now(UTC) + timedelta(hours=4)).isoformat(),
            },
        )
        spec["operations"] += [
            "validate_action",
            "inspect_action",
            "submit_action",
            "job_status",
            "result",
        ]
    policies = {}
    variants = {MAIN: spec, CROP: copy.deepcopy(spec)}
    variants[CROP]["sources"][0]["crop"]["width"] -= 1
    if dimensions["c"] > 1:
        variants[CHANNEL] = copy.deepcopy(spec)
        displayed = set(scene["state"]["channels"])
        withheld = next((index for index in range(dimensions["c"]) if index not in displayed), None)
        if withheld is None:
            withheld = next(
                index for index in range(dimensions["c"]) if index != scene["state"]["channels"][0]
            )
        variants[CHANNEL]["sources"][0]["c"] = [withheld]
    for server, value in variants.items():
        if server != MAIN:
            for key in ("remote_grants", "experimental_recipes", "actions", "delegation"):
                value.pop(key, None)
            value["operations"] = ["volume_view"]
            value["volume_views"] = {"read": True, "write": False, "image": False, "fields": []}
        path = output / (server + ".json")
        receipt = write_policy(path, project, value)
        policies[server] = {"path": str(path), "sha256": receipt["policy_sha256"]}
    patch = {
        "result": binding,
        "selected_object": {**binding, "label_id": fixture["target_label"]},
        "crosshair_source_xyz": fixture["probe_source_xyz"],
        "labels": {"visible": True, "opacity": 0.65, "selected_only": False},
        "representation": {
            "mode": "volume",
            "extent": "context",
            "render_mode": "blend",
            "quality": 50,
        },
        "layout": {
            "mode": "four",
            "expanded_pane": None,
            "pane_order": ["axial", "coronal", "sagittal", "volume"],
            "col_split": 50,
            "row_split": 50,
        },
    }
    prepared = {
        "schema": "loci.volume-host-prepared/v1",
        "status": "prepared-not-executed",
        "created_at": datetime.now(UTC).isoformat(),
        "case": fixture["case"],
        "output": str(output),
        "study": str(project.root),
        "project_id": project.meta["project_id"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "result_binding": binding,
        "target_label": fixture["target_label"],
        "probe_source_xyz": fixture["probe_source_xyz"],
        "expected_t": scene["state"]["t"],
        "expected_channels": scene["state"]["channels"],
        "fixture_path": str(args.fixture.resolve()),
        "fixture_sha256": sha(args.fixture),
        "positive_patch": patch,
        "allow_correction": args.allow_correction,
        "correction_request": {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "operations": [
                {
                    "op": "delete",
                    "label": fixture["target_label"],
                    "expected_input_sha256": binding["label_sha256"],
                }
            ],
            "working_bytes": MEMORY,
        },
        "policies": policies,
        "worker": worker,
        "source_commit": args.source_commit,
        "model_home": str(output / "models"),
        "source_hashes": source_pins(),
        "initial_result_ids": [r["id"] for r in project.list_results()],
        "initial_job_ids": [j["id"] for j in project.list_jobs()],
        "limits": [
            "Engineering acceptance only; no human review or biological validation",
            "Actual GUI launch, ordinary input and fresh-profile reopen are lead-owned",
            "One-channel sources cannot exercise an independent channel-withholding policy",
        ],
    }
    write(output / "prepared.json", prepared)
    for phase in PHASES:
        if phase == "reopen" or (phase == "correction" and not args.allow_correction):
            continue
        (output / (phase + "-prompt.txt")).write_text(prompt(prepared, phase))
    return prepared


def identity(kit):
    kit = Path(kit).resolve(strict=True)
    prepared = read(kit / "prepared.json")
    require(prepared["schema"] == "loci.volume-host-prepared/v1", "Unknown prepared packet")
    require(prepared["output"] == str(kit), "Prepared directory moved")
    require(source_pins() == prepared["source_hashes"], "Source/helper changed after preparation")
    require(
        sha(prepared["worker"]["worker_path"]) == prepared["worker"]["worker_sha256"],
        "Packaged worker changed",
    )
    require(sha(prepared["fixture_path"]) == prepared["fixture_sha256"], "Fixture metadata changed")
    require(not list(Path(prepared["model_home"]).iterdir()), "Unexpected model provisioning")
    for policy in prepared["policies"].values():
        require(sha(policy["path"]) == policy["sha256"], "Pinned policy changed")
    return prepared


def structured(call):
    result = call.get("result") or {}
    value = result.get("structuredContent", result.get("structured_content"))
    if value is None:
        texts = [b.get("text", "") for b in result.get("content", []) if b.get("type") == "text"]
        require(len(texts) == 1, "Missing unambiguous native JSON response")
        value = json.loads(texts[0])
    require(isinstance(value, dict), "Native structured response must be an object")
    return value


def error_text(call):
    result = call.get("result") or {}
    failed = call.get("status") == "failed" or result.get("isError") or result.get("is_error")
    if not failed:
        return None
    require(not call.get("error"), "A transport error is not an expected scope/CAS denial")
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    require(
        len(texts) == 1 and texts[0].startswith("Error executing tool "), "Unknown tool-error shape"
    )
    return texts[0]


def is_policy_denial(tool, text):
    return text == f"Error executing tool {tool}: {POLICY_DENIAL}"


def scene_live_token(view):
    return {
        key: view["live"][key]
        for key in ("view_id", "renderer_generation", "live_epoch", "revision", "display_revision")
    }


def verify_correction_calls(prepared, calls, project, session_id):
    """Bind the exact child read/inspection to this host's one successful correction."""
    parent = prepared["result_binding"]
    parent_request = {key: parent[key] for key in ("result_id", "revision_hash")}
    submitted = succeeded = child = parent_info = child_info = None
    validated = False
    scientific = {"result", "inspect_action", "validate_action", "submit_action", "job_status"}
    for call in calls:
        tool = call["tool"]
        if tool not in scientific:
            continue
        require(
            prepared["allow_correction"] and call["server"] == MAIN and not error_text(call),
            "Correction evidence came from an unauthorized server or failed call",
        )
        arguments, value = call["arguments"], structured(call)
        if tool == "inspect_action":
            require(arguments["operation"] == "correction_info", "Unexpected correction inspection")
            if child is None:
                require(
                    parent_info is None
                    and submitted is None
                    and arguments["request"] == parent_request
                    and value["result_id"] == parent["result_id"]
                    and value["revision_hash"] == parent["revision_hash"]
                    and value["label_sha256"] == parent["label_sha256"]
                    and prepared["target_label"] in value["label_ids"],
                    "Parent correction inspection changed",
                )
                parent_info = value
            else:
                require(
                    child_info is None
                    and arguments["request"]
                    == {"result_id": child["id"], "revision_hash": child["revision_hash"]}
                    and value["result_id"] == child["id"]
                    and value["revision_hash"] == child["revision_hash"]
                    and value["parent_id"] == parent["result_id"]
                    and set(value["label_ids"])
                    == set(parent_info["label_ids"]) - {prepared["target_label"]}
                    and value["shape"] == parent_info["shape"]
                    and value["label_sha256"] != parent["label_sha256"],
                    "Child correction inspection changed",
                )
                child_info = value
        elif tool in {"validate_action", "submit_action"}:
            require(
                parent_info is not None
                and submitted is None
                and arguments["operation"] == "correct_result"
                and arguments["request"] == prepared["correction_request"],
                "Correction request changed or was duplicated",
            )
            if tool == "validate_action":
                require(
                    not validated
                    and value["authorized"] is True
                    and value["operation"] == "correct_result"
                    and value["request"] == prepared["correction_request"],
                    "Exact correction validation missing",
                )
                validated = True
            else:
                require(
                    validated and arguments["request_key"] == "volume-host-delete-v1",
                    "Correction submission changed",
                )
                submitted = value["job"]
        elif tool == "job_status":
            require(
                submitted is not None and arguments == {"job_id": submitted["id"]},
                "Unrelated correction job read",
            )
            job = value["job"]
            require(
                job["id"] == submitted["id"] and job["request_hash"] == submitted["request_hash"],
                "Correction job identity changed",
            )
            require(child is None, "Correction polling continued after child inspection")
            if job["state"] == "succeeded" and job.get("owned_worker_active") is False:
                require(len(job["result_ids"]) == 1, "Correction must return exactly one child")
                succeeded = job
        else:
            require(
                succeeded is not None and child is None,
                "Child read preceded observed correction worker exit or was duplicated",
            )
            child_id = succeeded["result_ids"][0]
            require(
                arguments == {"result_id": child_id, "offset": 0, "limit": 1},
                "Child result read must be exact and bounded",
            )
            actual = project.result(child_id, verify_scientific_arrays=False)
            metadata = value["result"]
            require(
                metadata["id"] == actual["id"] == child_id
                and metadata["source_id"] == actual["source_id"] == prepared["source_id"]
                and actual["source_sha256"] == prepared["source_sha256"]
                and metadata["parent_id"] == actual["parent_id"] == parent["result_id"]
                and metadata["revision_hash"] == actual["revision_hash"]
                and metadata["review"] is None
                and project.review_state(child_id) is None,
                "Child result metadata changed",
            )
            child = actual
    require(
        submitted and succeeded and child and child_info, "Missing exact correction child evidence"
    )
    actual_job = project.job(submitted["id"])
    require(
        actual_job["state"] == "succeeded"
        and actual_job["operation"] == "correct_result"
        and actual_job["request_hash"] == submitted["request_hash"]
        and actual_job["request"]["task_request"] == prepared["correction_request"]
        and actual_job["result_ids"] == [child["id"]]
        and actual_job["owner"]
        == {"policy_sha256": prepared["policies"][MAIN]["sha256"], "session_id": session_id},
        "Persisted correction job differs from observed submitted work",
    )
    return {
        "result_id": child["id"],
        "revision_hash": child["revision_hash"],
        "label_sha256": child_info["label_sha256"],
    }


def verify_corrected_scene(binding, final, writes, calls, images):
    """A parent capture cannot stand in for the newly selected child scene."""
    require(
        final["state"]["result"] == binding
        and final["state"]["selected_object"] is None
        and len(writes) == 1
        and writes[0]["status"] == "complete"
        and writes[0]["proposed_state"]["result"] == binding,
        "Exact corrected child was not acknowledged rendered",
    )
    child_sets = [c for c in calls if c["tool"] == "set_volume_view"]
    require(
        len(child_sets) == 1
        and child_sets[0]["arguments"]["request"]["patch"]
        == {"result": binding, "selected_object": None},
        "Correction changed unrelated scene fields",
    )
    require(
        any(
            image["rendering"]["manifest"]["state"] == final["state"]
            and image["rendering"]["manifest"]["state"]["result"] == binding
            for image in images
        ),
        "Missing actual corrected-child GUI capture",
    )


def verify_denial_policies(prepared, policies, dimensions):
    """Bind generic public refusals to the exact intended negative policy fixtures."""
    main = policies[MAIN]
    grant = main["sources"][0]
    required = {
        "id": prepared["source_id"],
        "sha256": prepared["source_sha256"],
        "crop": {"x": 0, "y": 0, "width": dimensions["x"], "height": dimensions["y"]},
        "t": [prepared["expected_t"]],
        "c": list(range(dimensions["c"])),
        "z": list(range(dimensions["z"])),
        "level": [0],
        "measurement_channels": list(range(dimensions["c"])),
    }
    require(main["sources"] == [required], "Main policy lacks exact whole-context authority")
    require(
        main["volume_views"]["read"] is True
        and main["volume_views"]["write"] is True
        and main["volume_views"]["image"] is True
        and "t" not in main["volume_views"]["fields"]
        and {"volume_view", "set_volume_view", "volume_view_image"} <= set(main["operations"])
        and {"geometry", "provenance", "agent_metadata", "previews"} <= set(main["disclosures"]),
        "Main policy does not isolate the intended field refusal",
    )
    for server in (CROP, CHANNEL):
        if server not in policies:
            require(server == CHANNEL and dimensions["c"] == 1, "Missing scope policy")
            continue
        expected = copy.deepcopy(main)
        for key in ("remote_grants", "experimental_recipes", "actions", "delegation"):
            expected.pop(key, None)
        expected["operations"] = ["volume_view"]
        expected["volume_views"] = {
            "read": True,
            "write": False,
            "image": False,
            "fields": [],
        }
        if server == CROP:
            expected["sources"][0]["crop"]["width"] = grant["crop"]["width"] - 1
        else:
            channels = policies[server]["sources"][0]["c"]
            require(
                len(channels) == 1
                and channels[0] in required["c"]
                and not set(prepared["expected_channels"]) <= set(channels),
                "Channel policy does not withhold a displayed input",
            )
            expected["sources"][0]["c"] = channels
        require(
            policies[server] == expected,
            "Scope policy changed beyond its intended restriction",
        )


def host_calls(events, policies):
    active, calls, seen = None, [], set()
    threads = [event["thread_id"] for event in events if event.get("type") == "thread.started"]
    require(
        len(threads) == 1 and isinstance(threads[0], str) and threads[0],
        "Need exactly one actual Codex thread",
    )
    require(
        any(e.get("type") == "turn.completed" for e in events), "Actual host turn did not complete"
    )
    for event in events:
        require(
            not event.get("simulated")
            and not event.get("event_origin")
            and not event.get("type", "").startswith("sdk."),
            "SDK/simulation cannot qualify an actual host",
        )
        require(event.get("type") not in {"error", "turn.failed"}, "Actual host failed")
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        require(
            item.get("type") in {"reasoning", "agent_message", "mcp_tool_call"},
            "Host used a non-MCP tool",
        )
        if item["type"] != "mcp_tool_call":
            continue
        require(
            item.get("server") in policies and item.get("tool") in TOOLS, "Unexpected server/tool"
        )
        require(isinstance(item.get("arguments"), dict), "MCP arguments are not an object")
        if item["server"] != MAIN:
            require(item["tool"] == "volume_view", "Denial server used for another operation")
        if event["type"] == "item.started":
            require(
                isinstance(item.get("id"), str) and item["id"], "Missing actual MCP call identity"
            )
            require(active is None and item.get("id") not in seen, "Overlapped or reused MCP call")
            active = item
            seen.add(item.get("id"))
        else:
            require(
                event["type"] == "item.completed"
                and active is not None
                and all(
                    active.get(k) == item.get(k) for k in ("id", "server", "tool", "arguments")
                ),
                "MCP call pairing changed",
            )
            active = None
            calls.append(item)
    require(active is None and calls, "Incomplete/empty actual-host transcript")
    return threads[0], calls


def run_host(args):
    engine_imports()
    tissue = load_helper("volume_host_tissue", "scripts/qa/codex-tissue.py")
    prepared = identity(args.kit)
    require(
        args.phase != "human" or args.human_evidence is not None,
        "Human phase requires its lead evidence path",
    )
    require(
        args.phase != "reopen"
        or (args.expected_view is not None and args.reopen_evidence is not None),
        "Reopen requires a prior verified view and lead reopen evidence path",
    )
    expected = read(args.expected_view)["final_view"] if args.expected_view else None
    run = exclusive(Path(args.kit) / args.phase)
    text = prompt(prepared, args.phase, expected)
    (run / "prompt.txt").write_text(text)
    codex = shutil.which("codex")
    require(codex is not None, "Installed Codex CLI unavailable")
    codex = str(Path(codex).resolve(strict=True))
    version = subprocess.check_output([codex, "--version"], text=True).strip()
    cmd = command(codex, prepared, run)
    prior_sessions = {s["session_id"] for s in tissue.study_sessions(Path(prepared["study"]))}
    metadata = {
        "schema": "loci.volume-host-run/v1",
        "status": "running",
        "phase": args.phase,
        "kit": str(Path(args.kit).resolve()),
        "execution_mode": "codex-host",
        "command": cmd,
        "codex_executable": codex,
        "codex_sha256": sha(codex),
        "codex_version": version,
        "model_requested": MODEL,
        "effort_requested": EFFORT,
        "service_tier_requested": "default",
        "model_observed": None,
        "observed_model_basis": "not-exposed-by-cli-json",
        "started_at": datetime.now(UTC).isoformat(),
        "prepared_sha256": sha(Path(args.kit) / "prepared.json"),
        "prompt_sha256": sha(run / "prompt.txt"),
        "expected_view": expected,
        "human_evidence_path": str(args.human_evidence.resolve()) if args.human_evidence else None,
        "reopen_evidence_path": str(args.reopen_evidence.resolve())
        if args.reopen_evidence
        else None,
    }
    write(run / "attempt.json", metadata)
    try:
        with (
            tempfile.TemporaryDirectory(prefix="loci-volume-codex-") as cwd,
            (run / "codex-events.jsonl").open("x") as output,
            (run / "codex-stderr.log").open("x") as errors,
        ):
            completed = subprocess.run(
                cmd,
                input=text,
                text=True,
                stdout=output,
                stderr=errors,
                cwd=cwd,
                env={**os.environ, "LOCI_MODEL_HOME": prepared["model_home"]},
                timeout=args.timeout,
                check=False,
            )
        metadata["exit_code"] = completed.returncode
        require(completed.returncode == 0, "Codex exited nonzero; preserve this failed phase")
        sessions = [
            s
            for s in tissue.study_sessions(Path(prepared["study"]))
            if s["session_id"] not in prior_sessions
        ]
        from loci_engine.resource_limits import process_alive

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and any(
            type(s.get("private_pid")) is int and process_alive(s["private_pid"]) for s in sessions
        ):
            time.sleep(0.1)

        metadata["server_processes_at_exit"] = {
            s["session_id"]: {
                "pid": s.get("private_pid"),
                "running": process_alive(s["private_pid"])
                if type(s.get("private_pid")) is int
                else None,
            }
            for s in sessions
        }
        write(run / "sessions-at-exit.json", sessions)
        metadata.update(
            status="finished-unverified",
            finished_at=datetime.now(UTC).isoformat(),
            transcript_sha256=sha(run / "codex-events.jsonl"),
            files_sha256={
                name: sha(run / name)
                for name in ("answer.txt", "codex-stderr.log", "sessions-at-exit.json")
            },
        )
    except BaseException as error:
        metadata.update(
            status="failed", error={"type": type(error).__name__, "message": str(error)}
        )
        raise
    finally:
        write(run / "host-run.json", metadata)
    return {"run": str(run), "status": "finished-unverified", "next": "verify --run " + str(run)}


def verify(args):
    engine_imports()
    from loci_engine.agent_vision import validate_png
    from loci_engine.research_project import ResearchProject
    from loci_engine.volume_view_mailbox import validate_capture_manifest

    run = Path(args.run).resolve(strict=True)
    metadata = read(run / "host-run.json")
    prepared = identity(metadata["kit"])
    require(
        metadata["schema"] == "loci.volume-host-run/v1"
        and metadata["execution_mode"] == "codex-host"
        and metadata["exit_code"] == 0
        and metadata["status"] == "finished-unverified",
        "No successful actual host run",
    )
    require(
        metadata["command"] == command(metadata["codex_executable"], prepared, run)
        and sha(metadata["codex_executable"]) == metadata["codex_sha256"],
        "Codex command/executable changed",
    )
    require(
        metadata["prepared_sha256"] == sha(Path(metadata["kit"]) / "prepared.json")
        and metadata["prompt_sha256"] == sha(run / "prompt.txt"),
        "Prepared/prompt provenance changed",
    )
    require(metadata["transcript_sha256"] == sha(run / "codex-events.jsonl"), "Transcript changed")
    for name, pin in metadata["files_sha256"].items():
        require(sha(run / name) == pin, "Host artifact changed: " + name)
    require(metadata["model_observed"] is None, "Observed model must not be invented")
    require(
        (run / "codex-events.jsonl").stat().st_size <= 256 * 1024**2, "Transcript exceeds its bound"
    )
    events = [
        json.loads(line)
        for line in (run / "codex-events.jsonl").read_text().splitlines()
        if line.strip()
    ]
    thread, calls = host_calls(events, prepared["policies"])
    require(len(calls) <= 1000, "Actual host exceeded the bounded call budget")
    sessions = read(run / "sessions-at-exit.json")
    require(
        len(sessions) == len(prepared["policies"]),
        "Expected one actual Codex MCP session per configured policy",
    )
    for policy in prepared["policies"].values():
        owned = [s for s in sessions if s["policy_sha256"] == policy["sha256"]]
        require(
            len(owned) == 1
            and owned[0]["client_id"] == "codex-mcp-client"
            and metadata["codex_version"] == "codex-cli " + owned[0]["client_version"],
            "Host/session provenance mismatch",
        )
        require(
            metadata["started_at"] <= owned[0]["started_at"] <= metadata["finished_at"],
            "Session outside host interval",
        )
        require(
            metadata["server_processes_at_exit"][owned[0]["session_id"]]["running"] is False,
            "A host-owned MCP server remained alive after exit",
        )
    main_session = next(
        s for s in sessions if s["policy_sha256"] == prepared["policies"][MAIN]["sha256"]
    )
    project = ResearchProject(prepared["study"])
    from loci_engine.volume_view_state import source_dimensions

    verify_denial_policies(
        prepared,
        {server: read(policy["path"]) for server, policy in prepared["policies"].items()},
        source_dimensions(project.source(prepared["source_id"])),
    )
    requests = {d["id"]: d["data"] for d in project.documents("volume_view_request")}
    errors, images, writes, cancelled, reads = [], [], [], [], []
    successful_set = None
    phase = metadata["phase"]
    for call in calls:
        tool, arguments, server = call["tool"], call["arguments"], call["server"]
        if tool in {"inspect_action", "validate_action", "submit_action", "job_status", "result"}:
            require(
                phase == "correction" and server == MAIN,
                "Scientific action outside the main correction phase",
            )
            if tool == "inspect_action":
                require(arguments["operation"] == "correction_info", "Unexpected scientific read")
            elif tool in {"validate_action", "submit_action"}:
                require(
                    arguments["operation"] == "correct_result"
                    and arguments["request"] == prepared["correction_request"],
                    "Correction request changed",
                )
                if tool == "submit_action":
                    require(
                        arguments["request_key"] == "volume-host-delete-v1",
                        "Correction request key changed",
                    )
        denial = error_text(call)
        if denial:
            if server in {CROP, CHANNEL}:
                require(
                    phase == "core"
                    and arguments == {"source_id": prepared["source_id"]}
                    and tool == "volume_view"
                    and is_policy_denial(tool, denial),
                    "Unexpected scoped-denial request",
                )
                errors.append(server)
            elif tool == "set_volume_view" and "VIEW_STALE" in denial:
                require(phase in {"core", "human"}, "Unexpected stale call")
                if phase == "core":
                    require(arguments == successful_set, "Stale replay changed its exact request")
                else:
                    require(
                        reads
                        and arguments["request"]
                        == {
                            "source_id": prepared["source_id"],
                            "source_sha256": prepared["source_sha256"],
                            "expected_live": scene_live_token(reads[0]),
                            "patch": {
                                "clipping": {
                                    "enabled": True,
                                    "axis": "z",
                                    "position_percent": 11,
                                }
                            },
                        },
                        "Human CAS did not use original token",
                    )
                errors.append("stale")
            elif (
                phase == "core"
                and tool == "set_volume_view"
                and server == MAIN
                and is_policy_denial(tool, denial)
            ):
                require(
                    reads
                    and arguments["request"]
                    == {
                        "source_id": prepared["source_id"],
                        "source_sha256": prepared["source_sha256"],
                        "expected_live": scene_live_token(reads[-1]),
                        "patch": {"t": reads[-1]["state"]["t"]},
                    },
                    "Wrong denied field, source or current scene token",
                )
                errors.append("field")
            else:
                raise AssertionError("Unexpected host tool error: " + denial)
            continue
        value = structured(call)
        if tool == "volume_view":
            require(
                server == MAIN
                and value["source_id"] == prepared["source_id"]
                and value["source_sha256"] == prepared["source_sha256"],
                "View source drift",
            )
            reads.append(value)
        elif tool in {"set_volume_view", "volume_view_image"}:
            if tool == "volume_view_image":
                require(
                    arguments["request"]["panes"] == CAPTURE_PANES
                    and arguments["request"]["max_size"] == 1024,
                    "Host did not request the actual four visible GUI panes",
                )
            request_id = value["request_id"]
            record = requests[request_id]
            require(
                record["owner"]
                == {
                    "policy_sha256": prepared["policies"][MAIN]["sha256"],
                    "session_id": main_session["session_id"],
                },
                "GUI request owner changed",
            )
            require(
                record["expected_live"] == arguments["request"]["expected_live"],
                "GUI token changed",
            )
            if tool == "set_volume_view":
                if phase == "core":
                    require(
                        arguments["request"]["patch"] == prepared["positive_patch"],
                        "Positive scene patch changed",
                    )
                successful_set = arguments
                writes.append(record)
        elif tool == "cancel_volume_view_request":
            require(
                value["request_id"] == arguments["request_id"]
                and value["status"] == "cancelled"
                and value["response"]["scene_committed"] is False,
                "Actual cancellation was not observed",
            )
            cancelled.append(value["request_id"])
        elif tool == "volume_view_request_status" and value["status"] == "complete":
            record = requests[value["request_id"]]
            if record["kind"] == "set":
                require(
                    value["response"]["rendered"] is True
                    and record["response"]["rendered"] is True,
                    "Persisted state was not acknowledged rendered",
                )
                continue
            content = [b for b in call["result"]["content"] if b.get("type") == "image"]
            require(
                len(content) == 1
                and content[0].get("mimeType", content[0].get("mime_type")) == "image/png",
                "No actual native protocol image",
            )
            pixels = base64.b64decode(content[0]["data"], validate=True)
            response = record["response"]
            require(
                pixels == validate_png(response["image"])
                and hashlib.sha256(pixels).hexdigest() == response["rendering"]["png_sha256"],
                "Protocol PNG differs from native mailbox",
            )
            rendering = response["rendering"]
            require(
                value["response"]["rendering"] == rendering
                and rendering["kind"] == "gui-rendered-scene",
                "Image receipt changed",
            )
            require(
                rendering["live_token"] == record["expected_live"]
                and record["status"] == "complete",
                "Captured scene token changed",
            )
            scene = {
                "source_id": prepared["source_id"],
                "source_sha256": prepared["source_sha256"],
                "geometry_sha256": rendering["geometry_sha256"],
                "display_revision": rendering["live_token"]["display_revision"],
                "state": rendering["manifest"]["state"],
            }
            validate_capture_manifest(project, scene, rendering)
            images.append(
                {
                    "request_id": value["request_id"],
                    "sha256": hashlib.sha256(pixels).hexdigest(),
                    "rendering": rendering,
                }
            )
    require(reads and images, "Missing actual scene read or GUI image")
    require(
        all(
            v.get("live") and v["live"]["available"] is True and v["live"]["busy"] is False
            for v in (reads[0], reads[-1])
        ),
        "Initial/final GUI was unavailable or busy",
    )
    final = reads[-1]
    if phase == "core":
        require(
            reads[0]["state"]["t"] == prepared["expected_t"]
            and reads[0]["state"]["channels"] == prepared["expected_channels"],
            "Initial GUI T/channels changed",
        )
        expected_errors = {CROP, "stale", "field"} | (
            {CHANNEL} if CHANNEL in prepared["policies"] else set()
        )
        require(
            set(errors) == expected_errors and len(errors) == len(expected_errors),
            "Missing/duplicated negative calls",
        )
        require(
            len(writes) == 1 and writes[0]["status"] == "complete" and len(cancelled) == 1,
            "Missing rendered write/cancellation",
        )
        require(
            final["state"]["selected_object"] == prepared["positive_patch"]["selected_object"],
            "Exact label selection lost",
        )
    elif phase == "human":
        require(
            errors == ["stale"]
            and final["state"]["clipping"]
            == {"enabled": True, "axis": "z", "position_percent": HUMAN_CLIP},
            "Human edit was not preserved",
        )
        evidence = read(metadata["human_evidence_path"])
        require(
            evidence["schema"] == "loci.volume-host-human-edit/v1"
            and evidence["route"] == "ordinary GUI controls"
            and evidence["before"]["state"] == reads[0]["state"]
            and evidence["after"]["state"] == final["state"],
            "Missing genuine human GUI edit evidence",
        )
        check_capture_files(evidence)
    elif phase == "reopen":
        require(
            not errors
            and not writes
            and final["state"] == metadata["expected_view"]["state"]
            and final["geometry_sha256"] == metadata["expected_view"]["geometry_sha256"],
            "Reopened exact state changed",
        )
        evidence = read(metadata["reopen_evidence_path"])
        require(
            evidence["schema"] == "loci.volume-host-reopen/v1"
            and evidence["fresh_profile"] is True
            and evidence["study"] == prepared["study"]
            and evidence["before_app_pid"] != evidence["after_app_pid"]
            and evidence["before_profile"] != evidence["after_profile"],
            "Fresh real-GUI reopen evidence missing",
        )
        check_capture_files(evidence)
    else:
        require(
            not errors and prepared["allow_correction"], "Unexpected correction errors/authority"
        )
        child_id = final["state"]["result"]["result_id"]
        oracle = load_helper("volume_host_oracle", "scripts/qa_volume_workspace.py")
        oracle.verify(
            prepared["fixture_path"],
            prepared["study"],
            prepared["result_binding"]["result_id"],
            child_id,
        )
        binding = verify_correction_calls(prepared, calls, project, main_session["session_id"])
        verify_corrected_scene(binding, final, writes, calls, images)
    if phase != "correction":
        oracle = load_helper("volume_host_oracle", "scripts/qa_volume_workspace.py")
        oracle.verify(
            prepared["fixture_path"], prepared["study"], prepared["result_binding"]["result_id"]
        )
        require(
            {r["id"] for r in project.list_results()} == set(prepared["initial_result_ids"])
            and {j["id"] for j in project.list_jobs()} == set(prepared["initial_job_ids"]),
            "Unexpected scientific result/job mutation",
        )
    return {
        "schema": "loci.volume-host-verification/v1",
        "status": "passed-actual-codex-host-engineering",
        "phase": phase,
        "thread_id": thread,
        "call_count": len(calls),
        "native_images": images,
        "expected_denials": errors,
        "cancelled_requests": cancelled,
        "final_view": final,
        "session_exit_states": {s["session_id"]: s["state"] for s in sessions},
        "model_requested": MODEL,
        "model_observed": None,
        "limits": prepared["limits"],
    }


def check_capture_files(evidence):
    require(evidence.get("captures"), "Missing actual GUI capture artifacts")
    for artifact in evidence["captures"]:
        require(sha(artifact["path"]) == artifact["sha256"], "GUI evidence screenshot changed")


def packet(args):
    output = exclusive(args.output)
    fixtures = ROOT / ".loci/evidence/2026-11-07/volume-workspace/fixtures"
    paths = [fixtures / case / "fixture.json" for case in ("synthetic", "cellseg3d", "kidney")]
    metadata = {
        "schema": "loci.volume-host-kit/v1",
        "status": "packet-only-not-executed",
        "base_private": "0481c611ebf4ea17dd38395278ef54a296defa1c",
        "harness_sha256": sha(__file__),
        "fixtures": [{"path": str(p), "sha256": sha(p), "case": read(p)["case"]} for p in paths],
        "model_requested": MODEL,
        "effort_requested": EFFORT,
        "codex_launched": False,
        "instructions": "README.md",
        "ordinary_gui_required": True,
    }
    write(output / "packet.json", metadata)
    (output / "README.md").write_text(README)
    policy_template = {
        "schema": "loci.volume-host-policy-template/v1",
        "status": "template-only-not-a-policy",
        "requires": "Signed worker and imported real-GUI study/result; prepare writes authority",
        "template": {
            "schema": "loci.agent-policy/v7",
            "project": {"path": "<LEAD_GUI_STUDY>", "id": "<PROJECT_ID>"},
            "sources": [
                {
                    "id": "<SOURCE_ID>",
                    "sha256": "<SOURCE_SHA256>",
                    "crop": "whole native XY",
                    "t": "exact fixture T",
                    "c": "explicit source channels",
                    "z": "all native Z",
                    "level": [0],
                    "measurement_channels": "explicit source channels",
                }
            ],
            "operations": [
                "volume_view",
                "set_volume_view",
                "volume_view_image",
                "volume_view_request_status",
                "cancel_volume_view_request",
            ],
            "volume_views": {
                "read": True,
                "write": True,
                "image": True,
                "fields": [
                    "camera",
                    "crosshair_source_xyz",
                    "clipping",
                    "result",
                    "selected_object",
                    "representation",
                    "refinement",
                    "layout",
                    "labels",
                ],
            },
            "permission_mode": "full_access",
            "recipes": [],
            "export": None,
            "limits": {"cpu_seconds": 120, "memory_bytes": MEMORY, "concurrency": 1},
        },
    }
    write(output / "policy-template.json", policy_template)
    fixture = read(paths[0])
    binding = {
        "result_id": "<IMPORTED_RESULT_ID>",
        "revision_hash": "<RESULT_REVISION_SHA256>",
        "label_sha256": fixture["numerical_label_sha256"],
    }
    template = {
        "case": fixture["case"],
        "source_id": "<SOURCE_ID>",
        "source_sha256": fixture["source"]["sha256"],
        "result_binding": binding,
        "target_label": fixture["target_label"],
        "probe_source_xyz": fixture["probe_source_xyz"],
        "expected_t": fixture["selection"]["t"],
        "expected_channels": [fixture["selection"]["c"]],
        "positive_patch": {
            "result": binding,
            "selected_object": {**binding, "label_id": fixture["target_label"]},
            "crosshair_source_xyz": fixture["probe_source_xyz"],
            "labels": {"visible": True, "opacity": 0.65, "selected_only": False},
            "representation": {
                "mode": "volume",
                "extent": "context",
                "render_mode": "blend",
                "quality": 50,
            },
            "layout": {
                "mode": "four",
                "expanded_pane": None,
                "pane_order": ["axial", "coronal", "sagittal", "volume"],
                "col_split": 50,
                "row_split": 50,
            },
        },
        "correction_request": None,
        "policies": {MAIN: {}, CROP: {}, CHANNEL: {}},
        "limits": ["Template only; prepare resolves exact real-GUI bindings, patch and policy"],
    }
    (output / "core-prompt-template.txt").write_text(prompt(template, "core"))
    return metadata


README = """# Actual Codex-host 3D acceptance kit

This packet is prepared only. It contains no host/app run or simulated renderer.
The lead owns signed build30, all GUI launches, ordinary input and process cleanup.
Do not run alongside source gates, packaging or timing-sensitive journeys.

1. Use the signed packaged app/worker from the same verified public source commit.
   Through the real GUI create an isolated study, import the prepared fixture raw
   source and exact 3D labels, select its result, open 3D, show all four panes,
   save/settle the scene and leave that exact study open. Retain the actual GUI
   journey receipt and screenshots; this helper does not supply picker acceptance.
2. Prepare only after that real GUI state exists (use a NEW output path):

   engine/.venv/bin/python scripts/qa_volume_agent_host.py prepare \\
     --fixture ABS/fixtures/synthetic/fixture.json --study ABS/Workspace.loci-study \\
     --result-id EXACT_IMPORTED_RESULT_ID \\
     --worker ABS/Loci.app/Contents/Resources/loci-engine/loci-engine \\
     --source-commit EXACT_PACKAGED_PUBLIC_40_HEX --output ABS/host-kit/attempt-synthetic \\
     --allow-correction

   Preparation validates immutable fixture/result oracles, registers no fake GUI,
   executes no job and launches no process. It writes explicit v7 policies and
   host prompts. The main policy permits presentation writes independently of
   scientific execution/review; the optional correction flag adds only one named
   correction action. Separate crop/channel policies exercise actual scope denial.
   A one-channel source records the missing independent channel-withholding case;
   synthetic and kidney fixtures cover it without inventing a channel.
3. Lead-run the actual host, leaving the real GUI visible and idle:

   engine/.venv/bin/python scripts/qa_volume_agent_host.py run-host \\
     --kit ABS/attempt-synthetic --phase core
   engine/.venv/bin/python scripts/qa_volume_agent_host.py verify --run ABS/attempt-synthetic/core

   Only run-host launches installed Codex. It uses the prior isolated TOML pattern:
   ephemeral, ignore-user-config, read-only sandbox, GPT-6.1 Sol High, Standard,
   exact signed worker/policy, MCP auto approval only within those explicit grants.
   The verifier requires actual Codex thread/MCP start-completion evidence and
   PNG blocks equal to the durable real-renderer mailbox response. Cancellation
   must really win the GUI race; if it already completed, preserve the failed phase.
4. Genuine concurrent human edit: run phase human with --human-evidence ABS/human.json.
   Watch codex-events.jsonl for READY_FOR_HUMAN_CAS. Only then change Clip through
   ordinary GUI controls to enabled/z/73. Save/settle it. Record before/after native
   volume_view snapshots and actual screenshots in human.json:
   {schema:loci.volume-host-human-edit/v1, route:ordinary GUI controls,
    before:<original view>,after:<saved human view>,captures:[{path,sha256}]}.
   The host must refuse a stale original token and show the preserved human scene.
   It cannot create this evidence or the human edit. Polling has a finite limit.
5. Close the real app normally and reopen the SAME study in a genuinely fresh GUI
   profile. Retain old/new app PIDs, distinct profile paths and screenshots in a
   separate reopen.json {schema:loci.volume-host-reopen/v1,fresh_profile:true,
   study:ABS,before_app_pid,after_app_pid,before_profile,after_profile,
   captures:[{path,sha256}]}.
   Run phase reopen with --expected-view ABS/attempt-synthetic/human/verification.json
   (or core/verification.json) and --reopen-evidence ABS/reopen.json. It performs
   reads/capture only and compares the exact previously verified saved scene.
6. Optional correction LAST: run phase correction once. It creates one immutable
   delete child, waits for actual worker exit, selects its exact label hash and
   captures it in the real GUI. Independent NPY/raw-mean oracles verify the parent
   unchanged and only the chosen child label deleted. No scientific review/export.
   To check corrected cold reopen, run a NEW prepare packet bound to that child
   only after adapting its expected oracle; the current fixture oracle targets the
   parent and deliberately refuses to mislabel a child as the original fixture.

Every run output is exclusive. Never overwrite a failed attempt or append a
simulated transcript. `verify` writes verification.json only when all phase
obligations pass. A metadata receipt supplies traceability, not cryptographic
attestation or a claim that a model identity was observed. GUI screenshot review,
native ordinary-dialog evidence, app source/signature qualification, biological
accuracy and human usability remain separately scoped evidence.
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    packet_parser = sub.add_parser("packet")
    packet_parser.add_argument("--output", type=Path, required=True)
    prep = sub.add_parser("prepare")
    for name in ("fixture", "study", "worker", "output"):
        prep.add_argument("--" + name, type=Path, required=True)
    prep.add_argument("--result-id", required=True)
    prep.add_argument("--source-commit", required=True)
    prep.add_argument("--allow-correction", action="store_true")
    host = sub.add_parser("run-host")
    host.add_argument("--kit", type=Path, required=True)
    host.add_argument("--phase", choices=PHASES, required=True)
    host.add_argument("--timeout", type=int, default=900)
    host.add_argument("--expected-view", type=Path)
    host.add_argument("--human-evidence", type=Path)
    host.add_argument("--reopen-evidence", type=Path)
    check = sub.add_parser("verify")
    check.add_argument("--run", type=Path, required=True)
    args = parser.parse_args(argv)
    value = {"packet": packet, "prepare": prepare, "run-host": run_host, "verify": verify}[
        args.action
    ](args)
    if args.action == "verify":
        write(args.run / "verification.json", value)
    print(json.dumps(value, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
