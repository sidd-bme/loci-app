"""Actual ephemeral Codex host acceptance on the generated graph/density study.

Example (from the matching reviewed source tree, not an installed plugin):
  engine/.venv/bin/python scripts/qa/codex-program.py --worker /absolute/loci-engine \
    --output /absolute/absent-evidence-directory --model gpt-6.1-sol --effort high

Standard service tier, isolated cwd and --ignore-user-config; no config edits or
plugin installation. The host may use only this policy-bound MCP server, serially.
After the host exits, THIS native harness grants/exports the saved density report
solely for the independent CSV oracle. The agent receives NO export authority.
Retains raw JSONL/results and source/worker hashes. Engineering acceptance only;
generated donor names and masks are not biological evidence or human review.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from loci_engine.agent_policy import DISCLOSURES
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench

SERVER = "loci-program-qa"
DENSITY_KEY = "codex-program-density-v1"
GRAPH_KEY = "codex-program-graph-v1"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            value.update(block)
    return value.hexdigest()


def value_hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def response(call):
    """Check the actual MCP response, including tool errors in completed events."""
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
        texts = [b.get("text", "") for b in result.get("content", []) if b.get("type") == "text"]
        require(len(texts) == 1, "MCP response has no unambiguous JSON payload")
        value = json.loads(texts[0])
    require(
        isinstance(value, dict) and "error" not in value,
        "MCP returned an error payload",
    )
    return value


def host_calls(events):
    """Fail closed on other tools, incomplete calls, and overlapping MCP requests."""
    active, calls = set(), []
    allowed = {
        "action_guide": None,
        "analysis_context": None,
        "inspect_source": None,
        "result_view": None,
        "result": None,
        "job_status": None,
        "validate_action": {"spatial_density_preview", "spatial_density_save"},
        "inspect_action": {
            "spatial_density_preview",
            "spatial_density_get",
            "spatial_density_query",
        },
        "submit_action": {"spatial_density_save"},
        "workflow_graph_inspect": {"workflow_graph_preflight", "workflow_graph_status"},
        "workflow_graph_control": {"workflow_graph_start", "workflow_graph_advance"},
    }
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
            require(
                active == {item.get("id")},
                "MCP completion has no matching serial start",
            )
            active.remove(item["id"])
            require(item.get("tool") in allowed, "Host called a tool outside the acceptance steps")
            operations = allowed[item["tool"]]
            require(
                operations is None or item.get("arguments", {}).get("operation") in operations,
                "Host attempted an operation outside the acceptance steps",
            )
            response(item)
            calls.append(item)
    require(calls and not active, "Host left missing or unfinished MCP calls")
    require(
        any(e.get("type") == "turn.completed" for e in events),
        "Host turn did not complete",
    )
    return calls


def matching(calls, tool, operation=None):
    return [
        call
        for call in calls
        if call.get("tool") == tool
        and (operation is None or call.get("arguments", {}).get("operation") == operation)
    ]


def one(calls, tool, operation=None):
    found = matching(calls, tool, operation)
    require(len(found) == 1, f"Expected one actual {tool}/{operation} response")
    return found[0]


def verify_host(calls, fixture, project, policy_sha256, output):
    """Bind successful MCP data to persisted intents, jobs and exact publications."""
    require(matching(calls, "action_guide"), "Host did not consult the action guide")
    inspected = {c["arguments"].get("source_id") for c in matching(calls, "inspect_source")}
    require(
        inspected == {s["id"] for s in project.list_sources()},
        "Host did not inspect all five sources",
    )
    for call in matching(calls, "inspect_source"):
        value = response(call)
        source = project.source(call["arguments"]["source_id"], verify=True)
        require(
            value.get("verified") is True
            and value.get("source_id") == source["id"]
            and value.get("source_sha256") == source["sha256"],
            "Host source inspection did not verify the granted fingerprint",
        )
    preview = one(calls, "inspect_action", "spatial_density_preview")
    require(
        preview["arguments"]["request"] == fixture["density_request"],
        "Density request changed",
    )
    token = {key: response(preview)[key] for key in ("preview_id", "preview_hash")}
    for operation, request in (
        ("spatial_density_preview", fixture["density_request"]),
        ("spatial_density_save", token),
    ):
        validation = one(calls, "validate_action", operation)
        require(
            validation["arguments"]["request"] == request
            and response(validation).get("authorized") is True,
            "Host did not successfully validate the exact " + operation + " request",
        )
    saves = matching(calls, "submit_action", "spatial_density_save")
    require(len(saves) == 2, "Expected one density save and one exact idempotent replay")
    require(
        saves[0]["arguments"] == saves[1]["arguments"],
        "Density replay changed request/key",
    )
    require(
        saves[0]["arguments"]
        == {
            "operation": "spatial_density_save",
            "request": token,
            "request_key": DENSITY_KEY,
        },
        "Density save did not bind the actual preview token/key",
    )
    density_job_id = response(saves[0])["job"]["id"]
    require(
        response(saves[1])["job"]["id"] == density_job_id,
        "Density replay duplicated the job",
    )
    reports = project.documents("spatial_density_report")
    require(len(reports) == 1, "Expected exactly one saved density report")
    report_id, report = reports[0]["id"], reports[0]["data"]
    require(
        report["request"] == fixture["density_request"],
        "Persisted density request changed",
    )
    require(
        report["report_hash"] == token["preview_hash"],
        "Saved density differs from preview",
    )
    saved = one(calls, "inspect_action", "spatial_density_get")
    require(
        saved["arguments"]["request"] == {"report_id": report_id},
        "Host read another report",
    )
    saved_value = response(saved)
    require(
        saved_value["report_id"] == report_id
        and saved_value["status"]["current"] is True
        and saved_value["summary"]["report_hash"] == report["report_hash"]
        and saved_value["summary"]["request_sha256"] == value_hash(fixture["density_request"]),
        "MCP bounded report summary differs from durable data",
    )
    require(
        saved_value["summary"]["aggregation"]["donor_rows"] == report["aggregation"]["donor_rows"],
        "MCP saved report summary lost the generated donor endpoints",
    )
    for table in ("donor_rows", "cells"):
        pages = [
            c
            for c in matching(calls, "inspect_action", "spatial_density_query")
            if c["arguments"]["request"].get("table") == table
        ]
        require(len(pages) == 1, "Expected one successful " + table + " page")
        request, page = pages[0]["arguments"]["request"], response(pages[0])
        expected = {"report_id": report_id, "table": table, "offset": 0, "limit": 100}
        if table == "cells":
            expected["field_result_id"] = fixture["fields"][0]["result_id"]
        require(request == expected, "Host queried different density identities/page")
        require(
            page["table"] == table
            and page["report_hash"] == report["report_hash"]
            and page["returned"] == len(page["rows"]) > 0
            and page["next_offset"] is None,
            "Density query did not return the complete generated page",
        )
        if table == "donor_rows":
            require(
                page["rows"] == report["aggregation"]["donor_rows"],
                "MCP donor values changed",
            )
        else:
            require(
                len(page["rows"]) == 1
                and page["rows"][0]["label"] == 1
                and page["rows"][0]["result_id"] == expected["field_result_id"],
                "MCP cell page does not identify the selected generated cell",
            )

    preflight = one(calls, "workflow_graph_inspect", "workflow_graph_preflight")
    binding = fixture["graph"]["binding"]
    require(preflight["arguments"]["request"] == binding, "Graph bindings changed")
    plan = response(preflight)["plan"]
    require(
        plan["definition"] == fixture["graph"]["workflow"]["data"]["definition"]
        and value_hash(plan["definition"]) == binding["definition_sha256"]
        and plan["bindings"] == binding["bindings"]
        and plan["plan_sha256"]
        == value_hash({k: v for k, v in plan.items() if k != "plan_sha256"}),
        "Preflight did not preserve the declared definition, exact bindings and plan hash",
    )
    start = one(calls, "workflow_graph_control", "workflow_graph_start")
    start_request = {
        **binding,
        "plan_sha256": plan["plan_sha256"],
        "request_key": GRAPH_KEY,
    }
    require(
        start["arguments"]["request"] == start_request,
        "Graph start did not bind preflight",
    )
    run_id = response(start)["run"]["id"]
    runs = project.documents("workflow_run")
    require(len(runs) == 1 and runs[0]["id"] == run_id, "Unexpected graph run publication")
    run = runs[0]["data"]
    owner = run["owner"]
    require(
        isinstance(owner, dict) and owner.get("policy_sha256") == policy_sha256,
        "Graph owner differs from the granted agent policy",
    )
    require(
        run["state"] == "succeeded" and run["plan"] == plan,
        "Graph did not finish its exact plan",
    )
    require(
        run["request_sha256"] == value_hash(start_request),
        "Persisted graph request changed",
    )
    final_statuses = [
        c
        for c in matching(calls, "workflow_graph_inspect", "workflow_graph_status")
        if response(c).get("state") == "succeeded"
    ]
    require(
        final_statuses
        and all(c["arguments"]["request"] == {"run_id": run_id} for c in final_statuses),
        "Host did not inspect successful graph status",
    )
    require(
        response(final_statuses[-1])["run"] == runs[0],
        "MCP final graph differs from durable record",
    )
    advances = matching(calls, "workflow_graph_control", "workflow_graph_advance")
    require(
        len(advances) >= 4
        and all(c["arguments"]["request"] == {"run_id": run_id} for c in advances),
        "Expected graph progression plus a completed-run idempotent advance",
    )
    require(
        response(advances[-1])["state"] == "succeeded",
        "Completed graph advance did not remain succeeded",
    )

    jobs = project.list_jobs()
    require(
        len(jobs) == 4,
        "Expected three graph children and one idempotent density save, no parent job",
    )
    finished = {
        response(c)["job"]["id"]
        for c in matching(calls, "job_status")
        if response(c)["job"]["state"] == "succeeded"
        and response(c)["job"].get("owned_worker_active") is False
    }
    density_job = project.job(density_job_id)
    require(
        density_job["operation"] == "spatial_density_save"
        and density_job["state"] == "succeeded"
        and density_job["request_key"] == DENSITY_KEY
        and density_job["request"]
        == {"source_id": fixture["fields"][0]["source_id"], "task_request": token}
        and density_job.get("owner") == owner
        and density_job.get("report_id") == report_id,
        "Density durable job lost its exact token, owner or publication",
    )
    children, result_ids = [], []
    source = binding["bindings"]["image"]
    for name in ("cells", "nuclei", "join"):
        node = run["nodes"][name]
        intent, output_binding = node["intent"], node["output"]
        job = project.job(intent["job_id"])
        result = project.result(output_binding["result_id"])
        expected_operation = "associate_results" if name == "join" else "run_recipe"
        require(
            node["state"] == "succeeded" and job["operation"] == expected_operation,
            "Graph child has the wrong state or native operation",
        )
        require(
            job["request_key"] == f"graph-v2:{run_id}:{name}"
            and intent["request_key"] == job["request_key"]
            and intent["request_sha256"] == value_hash(intent["request"]),
            "Graph intent identity changed",
        )
        request = intent["request"]
        if name == "join":
            for role in ("cells", "nuclei"):
                require(
                    request[role] == run["nodes"][role]["output"],
                    "Join input is not its exact branch output",
                )
                actual = result["provenance"]["association_inputs"][role]
                require(
                    all(actual[k] == v for k, v in request[role].items()),
                    "Join provenance changed",
                )
            settings = fixture["graph"]["definition"]["nodes"][-1]["settings"]
            require(
                all(request[k] == v for k, v in settings.items()),
                "Join settings changed",
            )
            normalized = {"source_id": source["source_id"], "task_request": request}
        else:
            require(
                request["source_id"] == source["source_id"]
                and request["selection"] == source["selection"],
                "Branch source selection changed",
            )
            expected_recipe = fixture["graph"]["definition"]["nodes"][0 if name == "cells" else 1][
                "settings"
            ]["recipe"]
            require(
                all(request["recipe"][k] == v for k, v in expected_recipe.items()),
                "Branch recipe changed",
            )
            require(
                request["recipe"]["working_bytes"]
                == fixture["graph"]["definition"]["working_bytes"],
                "Branch memory budget changed",
            )
            require(
                result["provenance"]["recipe"] == request["recipe"],
                "Published branch recipe changed",
            )
            normalized = request
        require(
            job["request"] == normalized
            and job["request_hash"]
            == value_hash({"operation": expected_operation, "request": normalized}),
            "Durable child request differs from persisted intent",
        )
        require(
            job.get("owner") == owner
            and job["state"] == "succeeded"
            and job["result_ids"] == [result["id"]]
            and job["id"] in finished,
            "Host did not observe this exact owned child succeed",
        )
        require(
            result["revision_hash"] == output_binding["revision_hash"]
            and result["provenance"]["job_id"] == job["id"]
            and result["provenance"]["runtime"] == plan["runtime"]
            and project.review_state(result["id"]) is None,
            "Graph result provenance/review changed",
        )
        children.append(job["id"])
        result_ids.append(result["id"])
    import numpy as np

    joined = project.result(run["outputs"]["associated"]["result_id"])
    cell_result = project.result(run["nodes"]["cells"]["output"]["result_id"])
    for field in ("image", "labels"):
        require(
            np.array_equal(
                project.load_array(joined["arrays"][field]),
                project.load_array(cell_result["arrays"][field]),
            ),
            "Joined raw image or cell labels differ from the independently checked branch",
        )
    require(
        len(set(children)) == 3 and density_job_id in finished,
        "Host did not observe all four jobs",
    )
    inspected_result = run["outputs"]["associated"]
    exact_reads = [
        c
        for c in matching(calls, "result")
        if c["arguments"].get("result_id") == inspected_result["result_id"]
    ]
    require(
        exact_reads
        and response(exact_reads[-1])["result"]["revision_hash"]
        == inspected_result["revision_hash"]
        and response(exact_reads[-1])["total_rows"] > 0,
        "Host did not inspect exact output measurements",
    )

    images = []
    expected_views = {fixture["fields"][0]["result_id"], inspected_result["result_id"]}
    for call in matching(calls, "result_view"):
        identity = call["arguments"].get("result_id")
        if identity not in expected_views:
            continue
        view = response(call)
        require(
            view["result_id"] == identity
            and view["revision_hash"] == project.result(identity)["revision_hash"],
            "MCP image identity differs from its exact result",
        )
        blocks = [b for b in call["result"].get("content", []) if b.get("type") == "image"]
        require(blocks, "MCP result view returned no actual image")
        for block in blocks:
            require(
                block.get("mimeType") == "image/png"
                and isinstance(block.get("data"), str)
                and len(block["data"]) <= 16 * 1024**2,
                "Invalid or oversized MCP image",
            )
            data = base64.b64decode(block["data"], validate=True)
            require(data.startswith(b"\x89PNG\r\n\x1a\n"), "MCP image is not a PNG")
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
        expected_views <= {v["result_id"] for v in images},
        "Host did not receive input AND output MCP images",
    )
    return {
        "report_id": report_id,
        "report_hash": report["report_hash"],
        "run_id": run_id,
        "owner": owner,
        "density_job_id": density_job_id,
        "child_job_ids": children,
        "result_ids": result_ids,
        "images": images,
    }


def prompt_for(fixture, sources):
    instructions = f"""Exercise Loci MCP on generated engineering images using ONLY {SERVER} tools.
NO shell, files, browsing, other servers, plugins, plans, or subagents.
Make EVERY call sequentially and await its response: policy concurrency=1.
No biological validation, human review, models, extra runs, or permission bypass.
The native harness exports density AFTER you exit solely for its independent CSV oracle.
You have NO export grant. Do not export or create any grant.
For EVERY durable job, poll job_status until BOTH state=succeeded AND owned_worker_active=false.
A publication can precede worker exit: wait for that exact worker to exit before continuing.
If a job fails/cancels, report and stop. Do not bypass or replace requests.

1. Consult action_guide. inspect_source on all five source IDs below.
View the first density input with result_view and examine the actual returned MCP image.

2. validate_action then inspect_action spatial_density_preview with EXACT density request below.
Retain preview_id/preview_hash. validate_action spatial_density_save with exactly that token.
submit_action spatial_density_save with that token and request_key={DENSITY_KEY}.
Wait for success AND worker exit, then replay EXACT same submit_action request/key once.
Confirm the same job ID. inspect_action spatial_density_get with report_id=preview_id.
Query spatial_density_query twice on that exact report, with offset=0,limit=100:
table=donor_rows; then table=cells,field_result_id={fixture["fields"][0]["result_id"]}.

3. workflow_graph_inspect operation=workflow_graph_preflight with EXACT binding below.
workflow_graph_control operation=workflow_graph_start with that binding plus returned plan_sha256
and request_key={GRAPH_KEY}. Start prepares a run; it is not a native job.
workflow_graph_control operation=workflow_graph_advance with request={{"run_id":returned_run_id}}.
This schedules ONE ready node. Find its run.data.nodes[node].intent.job_id.
Poll that job_status serially until success AND worker exit, then workflow_graph_inspect
workflow_graph_status, then advance the next ready node. Repeat for both branches and the join:
THREE separate owned native jobs. Do not submit children manually.
Inspect final successful status. Advance the completed run once more: it must stay succeeded
with the same three job/output identities.

4. result on run.data.outputs.associated.result_id; inspect exact revision and measurements.
result_view on that exact output; examine the actual returned MCP image. Leave results unreviewed.
Report IDs/revisions, all four job IDs, donor count/area/density, equal-donor mean, unmatched donor,
calibration and generated-fixture limitations. If a step fails, report its error and stop.
"""
    return (
        instructions
        + "\n"
        + "\n".join(
            (
                "Source IDs: " + json.dumps([s["id"] for s in sources]),
                "First density input: " + json.dumps(fixture["density_request"]["fields"][0]),
                "Exact density request: " + json.dumps(fixture["density_request"]),
                "Exact graph binding: " + json.dumps(fixture["graph"]["binding"]),
            )
        )
        + "\n"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="gpt-6.1-sol")
    parser.add_argument("--effort", choices=("low", "medium", "high", "xhigh"), default="high")
    args = parser.parse_args()
    worker = args.worker.resolve(strict=True)
    require(
        worker.is_file() and os.access(worker, os.X_OK),
        "Choose an executable frozen worker",
    )
    output = args.output.absolute()
    output.mkdir(mode=0o700)
    helper = Path(__file__).resolve().parents[1] / "fixtures/research_program_qa.py"
    receipt = {
        "schema": "loci.codex-program-host-qa/v1",
        "started_at": datetime.now(UTC).isoformat(),
        "status": "running",
        "model_requested": args.model,
        "effort_requested": args.effort,
        "service_tier_requested": "default (Standard)",
        "worker_sha256": digest(worker),
        "harness_sha256": digest(__file__),
        "fixture_helper_sha256": digest(helper),
        "scope": "Generated five-source graph/density engineering acceptance; no human review",
        "native_oracle_export": {
            "authority": "Native harness AFTER host exits; agent export disabled"
        },
    }
    try:
        generated = subprocess.run(
            [sys.executable, str(helper), "create", "--root", str(output / "fixture")],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        fixture = json.loads(generated.stdout)
        receipt["fixture"] = fixture
        workbench = Workbench(ResearchProject(fixture["study"]))
        try:
            sources = workbench.project.list_sources()
            expected_sources = {f["source_id"] for f in fixture["fields"]} | {
                fixture["graph"]["binding"]["bindings"]["image"]["source_id"]
            }
            require(
                len(sources) == 5 and {s["id"] for s in sources} == expected_sources,
                "Fixture did not contain exactly the five generated source identities",
            )
            receipt["initial_result_ids"] = [r["id"] for r in workbench.project.list_results()]
            require(
                not workbench.project.list_jobs(),
                "Generated fixture unexpectedly contains jobs",
            )
            image = fixture["graph"]["binding"]["bindings"]["image"]
            access = output / "access"
            grant = create_agent_access(
                workbench,
                {
                    "source_id": image["source_id"],
                    "selection": image["selection"],
                    "recipe": {
                        "segmentation": {"method": "components", "threshold": 10},
                        "measurement_channels": [0],
                        "working_bytes": 16 * 1024**2,
                    },
                    "allow_preview": True,
                    "allow_run": True,
                    "allow_export": False,
                    "export_names": [],
                    "allow_workflow_graph": True,
                    "disclosures": sorted(DISCLOSURES),
                    "limits": {
                        "cpu_seconds": 120,
                        "memory_bytes": 1024**3,
                        "concurrency": 1,
                    },
                    "delegation": {
                        "client_id": "codex-program-host-qa",
                        "result_scope": "granted-sources",
                        "allow_review": False,
                        "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
                    },
                    "source_scope": {
                        "mode": "study-sources",
                        "sources": [{"id": s["id"], "sha256": s["sha256"]} for s in sources],
                    },
                    "actions": [
                        "run_recipe",
                        "associate_results",
                        "spatial_density_preview",
                        "spatial_density_save",
                        "spatial_density_get",
                        "spatial_density_query",
                    ],
                    "permission_mode": "full_access",
                },
                access,
            )
        finally:
            workbench.close()
        receipt["policy_sha256"] = grant["policy_sha256"]
        prompt = prompt_for(fixture, sources)
        (output / "prompt.txt").write_text(prompt)
        codex = shutil.which("codex")
        require(codex is not None, "Codex CLI is unavailable")
        receipt["codex_version"] = subprocess.check_output([codex, "--version"], text=True).strip()
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
                str(access / "agent-policy.json"),
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
            tempfile.TemporaryDirectory(prefix="loci-codex-program-") as cwd,
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
                timeout=1200,
                check=False,
            )
        receipt["codex_exit_code"] = completed.returncode
        require(
            completed.returncode == 0,
            "Codex CLI failed; inspect retained raw host diagnostics",
        )
        events = [
            json.loads(line)
            for line in (output / "codex-events.jsonl").read_text().splitlines()
            if line.strip()
        ]
        calls = host_calls(events)
        receipt["calls"] = [
            {k: call.get(k) for k in ("id", "server", "tool", "arguments", "status")}
            for call in calls
        ]
        project = ResearchProject(fixture["study"])
        receipt["host_verification"] = verify_host(
            calls, fixture, project, grant["policy_sha256"], output
        )
        created_ids = {r["id"] for r in project.list_results()} - set(receipt["initial_result_ids"])
        require(
            created_ids == set(receipt["host_verification"]["result_ids"]),
            "Host published extra results",
        )
        report_id = receipt["host_verification"]["report_id"]
        report = project.documents("spatial_density_report", document_id=report_id)[0]["data"]
        require(
            report["software"]["aggregation_sha256"] == receipt["worker_sha256"]
            and report["software"]["dispatcher_sha256"] == receipt["worker_sha256"],
            "Density endpoints were not produced by the selected frozen worker",
        )
        # Explicitly native, after successful host verification; never an agent grant.
        from loci_engine.research_spatial_density import execute_export, plan
        from loci_engine.research_spatial_density import grant as native_grant

        export = output / "native-density-oracle"
        native = Workbench(project)
        try:
            export_plan = plan(project, report_id)
            allowed = native_grant(project, report_id, export_plan["plan_hash"], export)
            exported = execute_export(native, {k: allowed[k] for k in ("grant_id", "plan_hash")})
        finally:
            native.close()
        receipt["native_oracle_export"].update(plan=export_plan, receipt=exported)
        verified = subprocess.run(
            [
                sys.executable,
                str(helper),
                "verify",
                "--root",
                str(output / "fixture"),
                "--expected-owner",
                "agent",
                "--export",
                str(export),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        receipt["oracle"] = json.loads(verified.stdout)
        receipt["status"] = "passed"
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
        if isinstance(error, subprocess.CalledProcessError):
            receipt["error"].update(stdout=error.stdout, stderr=error.stderr)
        raise
    finally:
        # Check even failed/timeout journeys; retain changed identity as a failure.
        try:
            receipt["worker_sha256_after"] = digest(worker)
            receipt["worker_unchanged"] = receipt["worker_sha256_after"] == receipt["worker_sha256"]
            require(
                receipt["worker_unchanged"],
                "Frozen worker changed during the host journey",
            )
            require(
                digest(helper) == receipt["fixture_helper_sha256"]
                and digest(__file__) == receipt["harness_sha256"],
                "Harness/helper changed during acceptance",
            )
        except Exception as error:
            receipt["status"] = "failed"
            receipt["identity_error"] = {
                "type": type(error).__name__,
                "message": str(error),
            }
            raise
        finally:
            receipt["finished_at"] = datetime.now(UTC).isoformat()
            write_json(output / "receipt.json", receipt)
            print(json.dumps({"status": receipt["status"], "output": str(output)}))


if __name__ == "__main__":
    main()
