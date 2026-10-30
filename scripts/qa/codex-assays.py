"""Actual ephemeral Codex assay acceptance; generated data and one frozen MCP worker.

Prepare/run from the matching reviewed checkout:
  engine/.venv/bin/python scripts/qa/codex-assays.py --worker /absolute/loci-engine \
    --output /absolute/absent-evidence-directory --model gpt-6.1-sol --effort high

No Codex config edits, plugin installs or host shell/files/subagent bypass. The
host receives explicit agent technical-review authority, never human approval,
and NO export/path grants. Only AFTER successful host verification this native
harness exports reviewed results and native-granted wound reports, twice across
cold reopen, solely for independent NPY/math/CSV oracles. Engineering acceptance
does not establish biological accuracy, cell identity or general host capability.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from loci_engine.agent_policy import DISCLOSURES
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_export import export_research_result
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench

SERVER = "loci-assays-qa"
WOUND_KEY = "codex-assays-wound-v1"
MEMORY = 256 * 1024**2


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def helper(path, name):
    """Load only a code-owned, receipt-hashed native QA oracle, never host input."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def response(call):
    result = call.get("result") or {}
    require(
        call.get("status") == "completed"
        and not call.get("error")
        and not result.get("isError")
        and not result.get("is_error"),
        "MCP call failed: " + str(call.get("tool")),
    )
    value = result.get("structured_content", result.get("structuredContent"))
    if value is None:
        texts = [
            item.get("text", "")
            for item in result.get("content", [])
            if item.get("type") == "text"
        ]
        require(len(texts) == 1, "MCP response has no unambiguous JSON payload")
        value = json.loads(texts[0])
    require(
        isinstance(value, dict) and "error" not in value,
        "MCP returned an error payload",
    )
    return value


def matching(calls, tool, operation=None):
    return [
        call
        for call in calls
        if call["tool"] == tool
        and (
            operation is None or call.get("arguments", {}).get("operation") == operation
        )
    ]


def host_calls(events):
    allowed = {
        "action_guide": None,
        "analysis_context": None,
        "inspect_source": None,
        "result": None,
        "result_view": None,
        "review_result": None,
        "review_history": None,
        "job_status": None,
        "validate_action": {
            "morphometrics_run",
            "wound_closure_preview",
            "wound_closure_save",
            "track_results",
            "correct_tracks",
        },
        "inspect_action": {
            "population_query",
            "wound_closure_preview",
            "wound_closure_get",
            "wound_closure_query",
            "tracking_result",
        },
        "submit_action": {
            "morphometrics_run",
            "wound_closure_save",
            "track_results",
            "correct_tracks",
        },
    }
    active, calls, seen_jobs, executing = set(), [], set(), None
    for event in events:
        require(
            event.get("type") not in {"error", "turn.failed"},
            "Host reported a failed turn",
        )
        item = event.get("item", {})
        kind = item.get("type")
        if kind is None:
            continue
        require(
            kind in {"reasoning", "agent_message", "mcp_tool_call"},
            "Host bypassed MCP-only scope using " + str(kind),
        )
        if kind != "mcp_tool_call":
            continue
        require(item.get("server") == SERVER, "Host called another MCP server")
        if event.get("type") == "item.started":
            require(not active, "Host overlapped calls despite concurrency=1")
            active.add(item["id"])
        elif event.get("type") == "item.completed":
            require(active == {item.get("id")}, "MCP completion lacks its serial start")
            active.clear()
            tool, arguments = item.get("tool"), item.get("arguments", {})
            require(
                tool in allowed
                and (
                    allowed[tool] is None or arguments.get("operation") in allowed[tool]
                ),
                "Unexpected host tool/operation",
            )
            value = response(item)
            if executing is not None:
                require(
                    tool == "job_status" and arguments == {"job_id": executing},
                    "Host continued before its owned worker exited",
                )
            if tool == "submit_action":
                identity = value["job"]["id"]
                if identity not in seen_jobs:
                    seen_jobs.add(identity)
                    executing = identity
            elif tool == "job_status":
                job = value["job"]
                require(job["id"] == arguments["job_id"], "Status returned another job")
                require(
                    job["state"] in {"queued", "running", "succeeded"},
                    "Host job failed/cancelled",
                )
                if (
                    job["state"] == "succeeded"
                    and job.get("owned_worker_active") is False
                ):
                    executing = None
            calls.append(item)
    require(
        calls and not active and executing is None,
        "Host left an unfinished call or worker",
    )
    require(
        any(event.get("type") == "turn.completed" for event in events),
        "Host turn did not complete",
    )
    return calls


def bound(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def morph_request(case):
    return {key: case[key] for key in ("result_id", "revision_hash")} | {
        "working_bytes": MEMORY
    }


def correction_request(initial, temporal):
    first, second = temporal["frames"][:2]
    edge = {
        "source_frame_id": first["result_id"],
        "source_label": "70001",
        "target_frame_id": second["result_id"],
        "target_label": "70001",
    }
    return {
        **bound(initial),
        "changes": [
            {"op": "remove", **edge},
            {"op": "add", **edge, "identity_uncertain": True},
        ],
    }


def verify_job(calls, project, operation, request, key, owner):
    submits = [
        call
        for call in matching(calls, "submit_action", operation)
        if call["arguments"].get("request_key") == key
    ]
    require(
        len(submits) == 2 and submits[0]["arguments"] == submits[1]["arguments"],
        "Expected one exact submission and one idempotent replay: " + key,
    )
    require(
        submits[0]["arguments"]
        == {"operation": operation, "request": request, "request_key": key},
        "Host changed the exact request/key",
    )
    identity = response(submits[0])["job"]["id"]
    require(
        response(submits[1])["job"]["id"] == identity,
        "Idempotent replay duplicated a job",
    )
    validations = [
        call
        for call in matching(calls, "validate_action", operation)
        if call["arguments"].get("request") == request
    ]
    require(
        len(validations) == 1 and response(validations[0]).get("authorized") is True,
        "Missing successful exact request validation",
    )
    job = project.job(identity)
    source_id = (
        project.result(request["result_id"])["source_id"]
        if "result_id" in request
        else project.result(request["frames"][0]["result_id"])["source_id"]
        if operation == "track_results"
        else job["request"]["source_id"]
    )
    normalized = {"source_id": source_id, "task_request": request}
    require(
        job["request"] == normalized
        and job["request_hash"]
        == digest({"operation": operation, "request": normalized}),
        "Durable request fingerprint changed",
    )
    require(
        job["state"] == "succeeded" and job["owner"] == owner,
        "Job lost exact agent ownership",
    )
    statuses = [
        response(call)["job"]
        for call in matching(calls, "job_status")
        if call["arguments"] == {"job_id": identity}
    ]
    require(
        any(
            value["state"] == "succeeded" and value.get("owned_worker_active") is False
            for value in statuses
        ),
        "Host did not observe success AND exact worker exit",
    )
    return job


def require_read(calls, tool, request, operation=None):
    found = [
        call
        for call in matching(calls, tool, operation)
        if (
            call["arguments"].get("request") == request
            if operation is not None
            else call["arguments"] == request
        )
    ]
    require(
        len(found) == 1,
        "Missing exact successful read: " + str((tool, operation, request)),
    )
    return response(found[0])


def verify_review(calls, project, result, policy_sha256):
    reviews = [
        call
        for call in matching(calls, "review_result")
        if call["arguments"].get("request", {}).get("result_id") == result["id"]
    ]
    require(
        len(reviews) == 1,
        "Host must explicitly review each exported derived result once",
    )
    value = response(reviews[0])["review"]
    actual = project.review_state(result["id"])
    require(
        value == actual
        and value["actor"] == "agent"
        and value["disposition"] == "reviewed"
        and value["revision_hash"] == result["revision_hash"]
        and value["authority"]["policy_sha256"] == policy_sha256,
        "Export review is not the exact scoped AGENT decision",
    )


def verify_host(
    calls, assay, temporal, project, policy_sha256, worker_hash, output, oracles
):
    require(matching(calls, "action_guide"), "Host did not consult the action guide")
    granted = {case["source_id"] for case in assay["morphology"]} | {
        assay["wound"][0]["source_id"],
        temporal["source"]["id"],
    }
    inspected = matching(calls, "inspect_source")
    require(
        {call["arguments"].get("source_id") for call in inspected} == granted,
        "Host did not inspect exactly the six granted generated sources",
    )
    for call in inspected:
        value = response(call)
        source = project.source(call["arguments"]["source_id"], verify=True)
        require(
            value.get("verified") is True
            and value.get("source_id") == source["id"]
            and value.get("source_sha256") == source["sha256"],
            "Source fingerprint inspection failed",
        )
    jobs = project.list_jobs()
    require(
        len(jobs) == 7 and jobs[0].get("owner") is not None,
        "Expected seven owned native assay jobs",
    )
    owner = jobs[0]["owner"]
    require(owner["policy_sha256"] == policy_sha256, "Jobs belong to another policy")
    results, job_ids = {}, []
    expected_views = {assay["wound"][0]["result_id"]}
    for case in assay["morphology"]:
        job = verify_job(
            calls,
            project,
            "morphometrics_run",
            morph_request(case),
            "codex-assays-morph-" + case["name"],
            owner,
        )
        require(
            len(job["result_ids"]) == 1, "Morphology job did not publish one result"
        )
        result = project.result(job["result_ids"][0])
        require(
            result["parent_id"] == case["result_id"]
            and result["arrays"] == project.result(case["result_id"])["arrays"]
            and result["provenance"]["job_id"] == job["id"],
            "Morphology parent/array/job changed",
        )
        method = result["provenance"]["morphometrics"]["software"]
        require(
            method["kernel_sha256"] == method["dispatcher_sha256"] == worker_hash,
            "Morphology was not produced by the selected frozen worker",
        )
        read = require_read(calls, "result", {"result_id": result["id"]})
        require(
            read["result"]["revision_hash"] == result["revision_hash"]
            and read["total_rows"] == 2,
            "Host did not inspect exact morphology output rows",
        )
        query = {
            **bound(result),
            "x_metric": case["metric"],
            "y_metric": "measure",
            "offset": 0,
            "limit": 100,
        }
        population = require_read(calls, "inspect_action", query, "population_query")
        row = next(
            item for item in population["rows"] if item["label"] == 4_000_000_000
        )
        endpoint = case["metric"].split(":", 1)[1]
        oracles.close(
            row["values"][case["metric"]],
            oracles.expected_shape(case, 4_000_000_000)[endpoint],
        )
        require(population["total_count"] == 2, "Morphology population count changed")
        verify_review(calls, project, result, policy_sha256)
        if case["name"] == "shape-2d-physical":
            expected_views.update((case["result_id"], result["id"]))
        results[case["name"]] = bound(result)
        job_ids.append(job["id"])
    preview = require_read(
        calls, "inspect_action", assay["wound_request"], "wound_closure_preview"
    )
    token = {key: preview[key] for key in ("preview_id", "preview_hash")}
    validation = require_read(
        calls, "validate_action", assay["wound_request"], "wound_closure_preview"
    )
    require(
        validation.get("authorized") is True,
        "Exact wound preview validation was unsuccessful",
    )
    wound = verify_job(calls, project, "wound_closure_save", token, WOUND_KEY, owner)
    require(
        not wound["result_ids"]
        and wound["report_id"] == token["preview_id"]
        and wound["request"]["source_id"] == assay["wound"][0]["source_id"],
        "Wound save identity or source routing changed",
    )
    reports = project.documents("wound_closure_report")
    require(len(reports) == 1, "Host created an extra wound report")
    report = reports[0]["data"]
    require(
        report["report_hash"] == token["preview_hash"]
        and report["request"] == assay["wound_request"],
        "Persisted wound report differs from preview",
    )
    require(
        all(
            report["software"][key] == worker_hash
            for key in (
                "kernel_sha256",
                "dispatcher_sha256",
                "dependency_resolver_sha256",
                "geometry_sha256",
            )
        ),
        "Wound report was not produced by the selected frozen worker",
    )
    got = require_read(
        calls, "inspect_action", {"report_id": wound["report_id"]}, "wound_closure_get"
    )
    require(
        got["summary"]["report_hash"] == report["report_hash"]
        and got["status"]["current"]
        and got["time_declaration"] == assay["wound_request"]["time_declaration"],
        "Wound get changed identity",
    )
    for table in ("frames", "intervals"):
        data = require_read(
            calls,
            "inspect_action",
            {
                "report_id": wound["report_id"],
                "table": table,
                "offset": 0,
                "limit": 100,
            },
            "wound_closure_query",
        )
        require(
            data["rows"] == report["measurement"][table]
            and data["next_offset"] is None,
            "Wound table page differs from durable data",
        )
    labels = require_read(
        calls,
        "inspect_action",
        {
            "report_id": wound["report_id"],
            "table": "selected_labels",
            "frame_id": "frame-0",
            "offset": 0,
            "limit": 100,
        },
        "wound_closure_query",
    )
    require(labels["rows"] == [4_000_000_000], "Wound selected-label union changed")
    job_ids.append(wound["id"])
    for role, operation, request, key in (
        ("initial", "track_results", temporal["request"], temporal["track_key"]),
        ("corrected", "correct_tracks", None, temporal["correct_key"]),
    ):
        if role == "corrected":
            request = correction_request(
                project.result(results["initial"]["result_id"]), temporal
            )
        job = verify_job(calls, project, operation, request, key, owner)
        require(
            len(job["result_ids"]) == 1,
            "Temporal job did not publish exactly one revision",
        )
        result = project.result(job["result_ids"][0])
        read = require_read(calls, "inspect_action", bound(result), "tracking_result")
        metrics = result["provenance"]["trajectory_metrics"]
        summary = read["trajectory_metrics"]
        require(
            summary["storage"] == "persisted"
            and summary["graph_sha256"] == metrics["graph_sha256"]
            and summary["track_count"] == 1
            and summary["interval_count"] == 2,
            "Temporal summary changed",
        )
        for table in ("tracks", "intervals"):
            page = require_read(
                calls,
                "inspect_action",
                {**bound(result), "table": table, "offset": 0, "limit": 100},
                "tracking_result",
            )
            require(
                page["rows"] == metrics[table] and page["next_offset"] is None,
                "Temporal page differs from exact graph-derived metrics",
            )
        verify_review(calls, project, result, policy_sha256)
        results[role] = bound(result)
        job_ids.append(job["id"])
        if role == "corrected":
            expected_views.add(result["id"])
    for call in matching(calls, "review_history"):
        require(
            call["arguments"] == {"result_id": call["arguments"].get("result_id")}
            and call["arguments"]["result_id"]
            in {binding["result_id"] for binding in results.values()},
            "Review history inspection escaped the exact derived-result scope",
        )
        require(
            response(call)
            == {
                "events": [],
                "total_events": 0,
                "next_offset": None,
                "current_review_sha256": None,
                "assessment_disclosed": True,
            },
            "Pre-review history must disclose an unreviewed derived result",
        )
        review_index = next(
            i
            for i, item in enumerate(calls)
            if item["tool"] == "review_result"
            and item["arguments"]["request"]["result_id"]
            == call["arguments"]["result_id"]
        )
        require(
            calls.index(call) < review_index,
            "Review history was inspected after review",
        )
    require(
        len(set(job_ids)) == 7 and {job["id"] for job in jobs} == set(job_ids),
        "Extra or duplicate native jobs",
    )
    require(
        {call["arguments"]["request_key"] for call in matching(calls, "submit_action")}
        == {job["request_key"] for job in jobs},
        "Unexpected submission key",
    )
    require(
        len(matching(calls, "submit_action")) == 14
        and len(matching(calls, "review_result")) == 6,
        "Host made extra mutations or omitted required idempotent/review checks",
    )
    images = []
    for call in matching(calls, "result_view"):
        view = response(call)
        identity = call["arguments"]["result_id"]
        require(
            identity in expected_views
            and view["revision_hash"] == project.result(identity)["revision_hash"],
            "MCP image is not an expected exact result revision",
        )
        blocks = [
            item
            for item in call["result"].get("content", [])
            if item.get("type") == "image"
        ]
        require(blocks, "Host received no actual MCP image")
        for block in blocks:
            require(
                block.get("mimeType") == "image/png"
                and len(block.get("data", "")) <= 16 * 1024**2,
                "Invalid MCP image encoding or size",
            )
            data = base64.b64decode(block["data"], validate=True)
            require(data.startswith(b"\x89PNG\r\n\x1a\n"), "MCP image is not PNG")
            filename = f"mcp-image-{len(images) + 1}.png"
            (output / filename).write_bytes(data)
            images.append(
                {
                    "result_id": identity,
                    "revision_hash": view["revision_hash"],
                    "file": filename,
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
    require(
        expected_views == {item["result_id"] for item in images},
        "Host omitted input/output image inspection",
    )
    return {
        "owner": owner,
        "job_ids": job_ids,
        "results": results,
        "wound_report_id": wound["report_id"],
        "wound_report_hash": report["report_hash"],
        "images": images,
    }


def prompt_for(assay, temporal, sources):
    cases = [
        {
            "name": case["name"],
            "request": morph_request(case),
            "metric": case["metric"],
            "request_key": "codex-assays-morph-" + case["name"],
        }
        for case in assay["morphology"]
    ]
    physical = next(
        case for case in assay["morphology"] if case["name"] == "shape-2d-physical"
    )
    text = f"""Exercise generated engineering assays using ONLY {SERVER} MCP tools.
NO shell, files, browsing, other servers, plugin installs, plans or subagents.
Make EVERY call serially, awaiting its result. The policy concurrency is ONE.
For EVERY job poll job_status until BOTH state=succeeded AND owned_worker_active=false.
Only job_status calls are allowed while that owned worker is active. A publication may precede exit.
If ANY tool/job fails, report and stop. No retries with altered requests or permission bypass.
There is NO export/path grant. The native harness alone exports after you exit for independent
oracles.
Your review authority is AGENT technical review of generated known geometry only, never human
approval,
biological accuracy or inferred cell identity. Do not review original masks or any wound report.

1. Consult action_guide. inspect_source for exactly all six source IDs below.
Use result_view on the physical2D morphology INPUT and wound baseline below and examine the
actual images.

2. For EACH of four morphology cases below: validate_action morphometrics_run exact request;
submit_action with exact supplied request/key; await success AND worker exit; replay exactly once
with same request/key and confirm same job. result on the derived result_id (no pagination
arguments).
inspect_action population_query with exact result_id/revision_hash plus x_metric=case.metric,
y_metric='measure',offset=0,limit=100. For physical2D also result_view on its output and inspect
image.
Give EACH derived morphology result one review_result: exact id/revision, disposition='reviewed',
reason and coverage explicitly limited to AGENT engineering checks of all generated
voxels/endpoints,
expected_review_sha256=null. Never claim human or biological validation.

3. validate_action then inspect_action wound_closure_preview with EXACT wound request below.
Retain only preview_id/preview_hash token. validate_action wound_closure_save with this token;
submit_action with token and request_key={WOUND_KEY}. Await success AND worker exit then exact
replay once.
inspect_action wound_closure_get with report_id=preview_id. Query wound_closure_query on that
report,
offset=0,limit=100: table='frames'; table='intervals'; table='selected_labels',frame_id='frame-0'.
Missing frame stays missing, zero is observed zero, growth stays negative closure. Do not fill
or interpolate.

4. validate_action track_results exact temporal request below; submit_action with
request_key={temporal["track_key"]}; await success/worker exit; exact replay once.
Read inspect_action tracking_result with its exact result_id/revision_hash (summary + graph).
Read tracking_result twice more with that exact binding and table='tracks', then 'intervals',
offset=0,limit=100.
Give this derived result one AGENT-only review_result with technical generated scope and
expected_review_sha256=null.

5. Correct the initial temporal result using ONLY this changes template, adding its exact
result_id/revision_hash:
remove the first observed association; re-add the SAME first association with
identity_uncertain=true.
validate_action correct_tracks then submit_action request_key={temporal["correct_key"]}.
Await success AND worker exit, exact replay once. Inspect its tracking_result summary, tracks
page and
intervals page exactly as step4. Inspect result_view axis='z',index=1 on this corrected result.
Give this correction one AGENT-only technical review_result with expected_review_sha256=null.
Report all seven job IDs, exact output revisions/report hash, arrays/source identities, 2D/3D units,
wound missing/zero/growth states, XYZ velocities, weighted observed speed, directionality and
uncertainty.
Directionality is NOT persistence time. Generated masks are not segmentation/biological accuracy
evidence.
"""
    first, second = temporal["frames"][:2]
    edge = {
        "source_frame_id": first["result_id"],
        "source_label": "70001",
        "target_frame_id": second["result_id"],
        "target_label": "70001",
    }
    return (
        text
        + "\n"
        + json.dumps(
            {
                "sources": sources,
                "physical2d_input": {
                    k: physical[k] for k in ("result_id", "revision_hash")
                },
                "wound_baseline": {
                    k: assay["wound"][0][k] for k in ("result_id", "revision_hash")
                },
                "morphology_cases": cases,
                "wound_request": assay["wound_request"],
                "temporal_request": temporal["request"],
                "correction_changes": [
                    {"op": "remove", **edge},
                    {"op": "add", **edge, "identity_uncertain": True},
                ],
            },
            indent=2,
        )
        + "\n"
    )


def originals_unchanged(assay, temporal):
    for filename, fingerprint in (assay["files"] | temporal["files"]).items():
        require(
            sha(filename) == fingerprint,
            "An original generated source/mask file changed",
        )
    records = assay["original_records"] | temporal["original_records"]
    database = Path(assay["study"]) / "study.sqlite3"
    with sqlite3.connect("file:" + quote(str(database)) + "?mode=ro", uri=True) as db:
        for identity, fingerprint in records.items():
            row = db.execute(
                "SELECT record FROM results WHERE id=?", (identity,)
            ).fetchone()
            require(
                row is not None and digest(json.loads(row[0])) == fingerprint,
                "An original generated mask/result record changed",
            )


def native_exports(assay, verification, output):
    from loci_engine.research_wound_closure import execute_export, grant, plan

    wound, morphology, temporal, receipts = [], {}, {}, []
    for cold in (0, 1):
        wb = Workbench(ResearchProject(assay["study"]))
        try:
            report_id = verification["wound_report_id"]
            current = plan(wb.project, report_id)
            destination = output / f"native-wound-{cold}"
            granted = grant(wb.project, report_id, current["plan_hash"], destination)
            exported = execute_export(
                wb, {key: granted[key] for key in ("grant_id", "plan_hash")}
            )
            wound.append(destination)
            receipts.append(
                {
                    "kind": "wound",
                    "cold_reopen": cold,
                    "plan": current,
                    "receipt": exported,
                }
            )
            for name, binding in verification["results"].items():
                destination = output / f"native-{name}-{cold}"
                exported = export_research_result(
                    wb.project,
                    binding["result_id"],
                    binding["revision_hash"],
                    destination,
                )
                (
                    temporal if name in {"initial", "corrected"} else morphology
                ).setdefault(name, []).append(destination)
                receipts.append(
                    {"kind": name, "cold_reopen": cold, "receipt": exported}
                )
        finally:
            wb.close()
    return wound, morphology, temporal, receipts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--expected-worker-sha256")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="gpt-6.1-sol")
    parser.add_argument(
        "--effort", choices=("low", "medium", "high", "xhigh"), default="high"
    )
    args = parser.parse_args()
    worker = args.worker.resolve(strict=True)
    require(
        worker.is_file() and os.access(worker, os.X_OK),
        "Choose an executable frozen worker",
    )
    output = args.output.absolute()
    output.mkdir(mode=0o700)
    paths = {
        "assay": Path(__file__).with_name("assay_fixture.py"),
        "temporal": Path(__file__).with_name("temporal_fixture.py"),
        "harness": Path(__file__),
    }
    engine = Path(__file__).resolve().parents[2] / "engine/src/loci_engine"
    for name in (
        "research_export",
        "research_data_tables",
        "research_temporal",
        "temporal_metrics",
        "research_morphometrics",
        "morphometrics",
        "research_wound_closure",
        "wound_closure",
        "quantitative",
        "research_agent_setup",
        "agent_policy",
    ):
        paths["native_" + name] = engine / (name + ".py")
    receipt = {
        "schema": "loci.codex-assays-host-qa/v1",
        "started_at": datetime.now(UTC).isoformat(),
        "status": "running",
        "worker_sha256": sha(worker),
        "source_hashes": {name: sha(path) for name, path in paths.items()},
        "model_requested": args.model,
        "effort_requested": args.effort,
        "service_tier_requested": "default (Standard)",
        "scope": "Generated shape/wound/XYZ engineering acceptance; AGENT review only",
        "native_oracle_export": (
            "Native post-host source exports only; agent export/path authority disabled"
        ),
    }
    assay, temporal = None, None
    try:
        if args.expected_worker_sha256 is not None:
            require(
                receipt["worker_sha256"] == args.expected_worker_sha256,
                "Frozen worker pin does not match",
            )
        modules = {
            name: helper(paths[name], "loci_qa_" + name)
            for name in ("assay", "temporal")
        }
        assay = modules["assay"].create(output / "fixture")
        temporal = modules["temporal"].create(output / "temporal", assay["study"])
        receipt["fixture"] = {"assay": assay, "temporal": temporal}
        wb = Workbench(ResearchProject(assay["study"]))
        try:
            initial_ids = {result["id"] for result in wb.project.list_results()}
            require(
                initial_ids
                == set(assay["original_records"] | temporal["original_records"])
                and not wb.project.list_jobs(),
                "Fixture contains unexpected initial results/jobs",
            )
            sources = [
                {"id": source["id"], "sha256": source["sha256"]}
                for source in wb.project.list_sources()
                if source["id"] != assay["wrong_grid"]["source_id"]
            ]
            require(
                len(sources) == 6, "Expected six explicitly generated granted sources"
            )
            primary = assay["morphology"][0]
            selected = wb.project.result(primary["result_id"])["provenance"][
                "selection"
            ]
            access = create_agent_access(
                wb,
                {
                    "source_id": primary["source_id"],
                    "selection": selected,
                    "recipe": {
                        "segmentation": {"method": "components", "threshold": 1},
                        "measurement_channels": [0],
                        "working_bytes": MEMORY,
                    },
                    "allow_preview": False,
                    "allow_run": True,
                    "allow_export": False,
                    "export_names": [],
                    "disclosures": sorted(DISCLOSURES),
                    "limits": {
                        "cpu_seconds": 120,
                        "memory_bytes": 1024**3,
                        "concurrency": 1,
                    },
                    "source_scope": {"mode": "study-sources", "sources": sources},
                    "delegation": {
                        "client_id": "codex-assays-host-qa",
                        "result_scope": "granted-sources",
                        "allow_review": True,
                        "expires_at": (
                            datetime.now(UTC) + timedelta(hours=1)
                        ).isoformat(),
                    },
                    "actions": [
                        "morphometrics_run",
                        "population_query",
                        "wound_closure_preview",
                        "wound_closure_save",
                        "wound_closure_get",
                        "wound_closure_query",
                        "track_results",
                        "tracking_result",
                        "correct_tracks",
                    ],
                    "permission_mode": "full_access",
                },
                output / "access",
            )
        finally:
            wb.close()
        receipt["policy_sha256"] = access["policy_sha256"]
        prompt = prompt_for(assay, temporal, sources)
        (output / "prompt.txt").write_text(prompt)
        codex = shutil.which("codex")
        require(codex is not None, "Installed Codex CLI is unavailable")
        receipt["codex_version"] = subprocess.check_output(
            [codex, "--version"], text=True
        ).strip()
        receipt["codex_executable_sha256"] = sha(Path(codex).resolve(strict=True))
        server = "mcp_servers." + SERVER + "."
        overrides = {
            "model_reasoning_effort": args.effort,
            "service_tier": "default",
            "approval_policy": "never",
            server + "command": str(worker),
            server + "args": [
                "--cli",
                "mcp",
                "--policy",
                str(output / "access/agent-policy.json"),
            ],
            server + "required": True,
            server + "startup_timeout_sec": 60,
            server + "tool_timeout_sec": 180,
            server + "default_tools_approval_mode": "auto",
        }
        command = [
            codex,
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
            args.model,
        ]
        for key, value in overrides.items():
            command += ["-c", key + "=" + json.dumps(value)]
        command += ["-o", str(output / "answer.txt"), "-"]
        receipt["host_command"] = command
        with (
            tempfile.TemporaryDirectory(prefix="loci-codex-assays-") as cwd,
            (output / "codex-events.jsonl").open("w") as stdout,
            (output / "codex-stderr.log").open("w") as stderr,
        ):
            completed = subprocess.run(
                command,
                input=prompt,
                text=True,
                stdout=stdout,
                stderr=stderr,
                cwd=cwd,
                timeout=1800,
                check=False,
            )
        receipt["codex_exit_code"] = completed.returncode
        require(
            completed.returncode == 0,
            "Codex failed; inspect retained raw host diagnostics",
        )
        events = [
            json.loads(line)
            for line in (output / "codex-events.jsonl").read_text().splitlines()
            if line.strip()
        ]
        calls = host_calls(events)
        receipt["calls"] = [
            {
                key: call.get(key)
                for key in ("id", "server", "tool", "arguments", "status")
            }
            for call in calls
        ]
        project = ResearchProject(assay["study"])
        verified = verify_host(
            calls,
            assay,
            temporal,
            project,
            access["policy_sha256"],
            receipt["worker_sha256"],
            output,
            modules["assay"],
        )
        receipt["host_verification"] = verified
        require(
            {result["id"] for result in project.list_results()} - initial_ids
            == {item["result_id"] for item in verified["results"].values()},
            "Host published extra results",
        )
        for identity in initial_ids:
            require(
                project.review_state(identity) is None,
                "Host reviewed an original authored mask",
            )
        wound_exports, morph_exports, temporal_exports, receipts = native_exports(
            assay, verified, output
        )
        receipt["native_export_receipts"] = receipts
        receipt["assay_oracle"] = modules["assay"].verify(
            output / "fixture", wound_exports, morph_exports
        )
        receipt["temporal_oracle"] = modules["temporal"].verify(
            output / "temporal", temporal_exports, access["policy_sha256"]
        )
        originals_unchanged(assay, temporal)
        receipt["status"] = "passed"
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        try:
            receipt["worker_sha256_after"] = sha(worker)
            receipt["source_hashes_after"] = {
                name: sha(path) for name, path in paths.items()
            }
            require(
                receipt["worker_sha256_after"] == receipt["worker_sha256"],
                "Frozen worker changed during journey",
            )
            require(
                receipt["source_hashes_after"] == receipt["source_hashes"],
                "Harness or fixture helper changed during journey",
            )
            if assay is not None and temporal is not None:
                originals_unchanged(assay, temporal)
            receipt["identities_unchanged"] = True
        except Exception as error:
            receipt["status"] = "failed"
            receipt["identity_error"] = {
                "type": type(error).__name__,
                "message": str(error),
            }
            raise
        finally:
            receipt["finished_at"] = datetime.now(UTC).isoformat()
            write(output / "receipt.json", receipt)
            print(json.dumps({"status": receipt["status"], "output": str(output)}))


if __name__ == "__main__":
    main()
