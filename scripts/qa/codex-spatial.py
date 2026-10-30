"""Actual ephemeral Codex CLI host journey against one generated Loci study.

Uses the signed frozen worker selected by the lead. It changes no Codex config,
installs no plugin, and preserves raw JSONL host events for independent inspection.
This is scoped engineering acceptance, not general host or scientific approval.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from loci_engine.agent_policy import DISCLOSURES
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(8 * 1024**2), b""):
            h.update(part)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="gpt-6.1-sol")
    parser.add_argument("--effort", default="high")
    args = parser.parse_args()
    worker = args.worker.resolve(strict=True)
    output = args.output.absolute()
    output.mkdir(mode=0o700)
    repo = Path(__file__).resolve().parents[2]
    helper = repo / "scripts/fixtures/spatial_qa.py"
    receipt = {
        "schema": "loci.codex-spatial-host-qa/v1",
        "started_at": datetime.now(UTC).isoformat(),
        "status": "running",
        "scope": "Generated single-plane engineering fixture; agent review only",
        "model_requested": args.model,
        "effort_requested": args.effort,
        "worker_sha256": digest(worker),
        "harness_sha256": digest(__file__),
        "fixture_helper_sha256": digest(helper),
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
        project = ResearchProject(fixture["study"])
        workbench = Workbench(project)
        exports = output / "exports"
        exports.mkdir(mode=0o700)
        access = output / "access"
        grant = create_agent_access(
            workbench,
            {
                "source_id": fixture["source"]["id"],
                "selection": {
                    "x": 0,
                    "y": 0,
                    "width": 80,
                    "height": 64,
                    "c": 0,
                    "t": 0,
                    "z": 0,
                    "level": 0,
                },
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 100},
                    "measurement_channels": [0],
                    "working_bytes": 512 * 1024**2,
                },
                "allow_preview": True,
                "allow_run": True,
                "allow_export": True,
                "export_names": ["codex-spatial"],
                "disclosures": sorted(DISCLOSURES),
                "limits": {
                    "cpu_seconds": 60,
                    "memory_bytes": 2 * 1024**3,
                    "concurrency": 1,
                },
                "delegation": {
                    "client_id": "codex-spatial-host-qa",
                    "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
                    "result_scope": "granted-sources",
                    "allow_review": True,
                },
                "actions": [
                    "spatial_distance_run",
                    "describe_result",
                    "population_query",
                    "population_locate",
                ],
                "permission_mode": "full_access",
            },
            access,
            exports,
        )
        workbench.close()
        receipt["policy_sha256"] = grant["policy_sha256"]
        receipt["fixture"] = fixture
        prompt = (
            "You are exercising the real Loci MCP integration on explicitly generated technical images. "
            "Use ONLY tools from loci-spatial-qa. Do not use shell, files, browsing, other servers, or subagents. "
            "The input masks are authored geometry, not biological segmentation evidence. "
            "Discover the action guide and inspect the source and object result, including an actual result_view image. "
            "Run tissue distance bands with the exact request below after validating it. Wait for its durable job to succeed. "
            "Submit the same request/key once more to check idempotency: key codex-spatial-host-v1. "
            "Inspect the output image and all rows. Query the spatial distance metric and locate object 3. "
            "Give the output your own explicit AGENT review (never human review) with technical-fixture scope, "
            "then export that exact reviewed result as codex-spatial. No other mutations. "
            "Report exact result/job IDs, revision, band counts/areas/density, exclusions, calibration and limitations. "
            "If any step fails report its error; do not bypass permissions.\n"
            + "Source ID: "
            + fixture["source"]["id"]
            + "\n"
            + "Object input: "
            + json.dumps(fixture["inputs"]["objects"])
            + "\n"
            + "Exact spatial request: "
            + json.dumps(fixture["request"])
            + "\n"
        )
        (output / "prompt.txt").write_text(prompt)
        codex = shutil.which("codex")
        if codex is None:
            raise RuntimeError("Codex CLI is unavailable")
        receipt["codex_version"] = subprocess.check_output(
            [codex, "--version"], text=True
        ).strip()
        server = "mcp_servers.loci-spatial-qa."
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
            server + "tool_timeout_sec": 120,
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
        # A non-repository cwd avoids inheriting project-specific MCP settings.
        with (
            tempfile.TemporaryDirectory(prefix="loci-codex-spatial-") as cwd,
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
                timeout=900,
                check=False,
            )
        receipt["codex_exit_code"] = completed.returncode
        if completed.returncode != 0:
            raise RuntimeError(
                "Codex CLI did not complete; inspect retained host diagnostics"
            )
        events = [
            json.loads(line)
            for line in (output / "codex-events.jsonl").read_text().splitlines()
            if line.strip()
        ]
        calls = [
            event["item"]
            for event in events
            if event.get("type") == "item.completed"
            and event.get("item", {}).get("type") == "mcp_tool_call"
        ]
        receipt["calls"] = [
            {key: item.get(key) for key in ("server", "tool", "status")}
            for item in calls
        ]
        if not calls or any(item.get("server") != "loci-spatial-qa" for item in calls):
            raise AssertionError("Expected actual scoped MCP calls from Codex")
        for required in (
            "action_guide",
            "result_view",
            "validate_action",
            "submit_action",
            "job_status",
            "result",
            "review_result",
            "export_result",
        ):
            if required not in {item.get("tool") for item in calls}:
                raise AssertionError("Codex did not exercise " + required)
        if any(
            event.get("item", {}).get("type") in {"command_execution", "file_change"}
            for event in events
        ):
            raise AssertionError("Host bypassed the MCP-only journey")
        project = ResearchProject(fixture["study"])
        results = [
            r for r in project.list_results() if r["kind"] == "spatial-distance-bands"
        ]
        if len(results) != 1:
            raise AssertionError("Expected exactly one idempotent spatial publication")
        result = results[0]
        review = project.review_state(result["id"])
        if (
            not review
            or review.get("actor") != "agent"
            or review.get("disposition") != "reviewed"
        ):
            raise AssertionError("Exact output requires recorded agent review")
        verified = subprocess.run(
            [
                sys.executable,
                str(helper),
                "verify",
                "--study",
                fixture["study"],
                "--result",
                result["id"],
                "--export",
                str(exports / "codex-spatial"),
                "--negative-checks",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        receipt["oracle"] = json.loads(verified.stdout)
        receipt["result"] = {
            "id": result["id"],
            "revision_hash": result["revision_hash"],
        }
        receipt["review"] = review
        if digest(worker) != receipt["worker_sha256"]:
            raise AssertionError("Frozen worker changed during host journey")
        receipt["status"] = "passed"
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
        if isinstance(error, subprocess.CalledProcessError):
            receipt["error"].update(stdout=error.stdout, stderr=error.stderr)
        raise
    finally:
        receipt["finished_at"] = datetime.now(UTC).isoformat()
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"status": receipt["status"], "output": str(output)}))


if __name__ == "__main__":
    main()
