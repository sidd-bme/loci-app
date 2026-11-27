"""Exercise the generated local MCP setup against a real headless CLI and worker.

Run from the repository with PYTHONPATH=engine/src and the engine environment.
Use an isolated, natively authenticated host home for the subscription run.
The script generates its own synthetic study and never installs a plugin,
changes a live client configuration, launches a GUI, or reads credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import numpy as np
import tifffile
import tomllib
from loci_engine.agent_sessions import agent_sessions_snapshot
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench

JOB_KEY = "external-host-setup-fixture-v1"
TOOLS = ("catalog", "inspect_source", "submit_recipe", "job_status")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def fixture(output, worker, client):
    path = output / "synthetic image.tif"
    image = np.zeros((32, 32), dtype=np.uint16)
    image[4:12, 4:12] = 100
    tifffile.imwrite(path, image)
    project = ResearchProject.create(
        output / "Synthetic study", "External host setup QA"
    )
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(path), name="Synthetic threshold fixture")
        request = {
            "source_id": source["id"],
            "selection": {"x": 0, "y": 0, "width": 32, "height": 32},
            "recipe": {
                "segmentation": {"method": "components", "threshold": 50},
                "measurement_channels": [0],
            },
        }
        bundle = output / "Loci access bundle"
        # Exercise the current bundle generator against an existing frozen worker.
        # This does not claim the existing executable includes the generator change.
        with patch(
            "loci_engine.research_agent_setup.research_command",
            side_effect=lambda argv: [str(worker), "--cli", *argv],
        ):
            receipt = create_agent_access(
                workbench,
                {
                    **request,
                    "client": client,
                    "allow_preview": False,
                    "allow_run": True,
                    "allow_export": False,
                    "export_names": [],
                    "disclosures": ["agent_metadata"],
                    "limits": {
                        "cpu_seconds": 60,
                        "memory_bytes": 4 * 1024**3,
                        "concurrency": 1,
                    },
                    "permission_mode": "full_access",
                },
                bundle,
            )
    finally:
        workbench.close()
    return project, bundle, receipt, digest(path)


def run_command(command, cwd, env, output, stem, timeout=60):
    with (
        (output / f"{stem}.stdout").open("x") as stdout,
        (output / f"{stem}.stderr").open("x") as stderr,
    ):
        return subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            timeout=timeout,
            check=False,
        ).returncode


def antigravity_command(executable, model, bundle, access, prompt, output, env):
    workspace = bundle / access["antigravity_workspace"]
    config = json.loads((bundle / access["antigravity_config_filename"]).read_text())
    (server,) = config["mcpServers"]
    manifest = bundle / access["antigravity_plugin_filename"]
    require(
        run_command(
            [executable, "plugin", "validate", "--strict", "--json", manifest.parent],
            workspace,
            env,
            output,
            "plugin-validation",
        )
        == 0,
        "Antigravity rejected the generated plugin",
    )
    settings = {
        "permissions": {
            "allow": [f"mcp({server}/{tool})" for tool in TOOLS],
            "deny": [
                "command(*)",
                "unsandboxed(*)",
                "read_file(*)",
                "write_file(*)",
                "read_url(*)",
                "execute_url(*)",
            ],
        },
    }
    return (
        workspace,
        server,
        [
            executable,
            "--model",
            model,
            "--mode",
            "plan",
            "--sandbox",
            "--settings",
            json.dumps(settings),
            "--output-format",
            "stream-json",
            "--print-timeout",
            "3m",
            "--print",
            prompt,
        ],
    )


def codex_command(executable, model, bundle, access, prompt):
    workspace = bundle / access["codex_workspace"]
    config = tomllib.loads((bundle / access["codex_config_filename"]).read_text())
    (server,) = config["mcp_servers"]
    # Apply normal host trust inside the isolated profile. Codex discovers
    # the server from the generated workspace with no MCP command overrides.
    command = [
        executable,
        "--ask-for-approval",
        "never",
        "exec",
        "--ignore-rules",
        "--ephemeral",
        "--trust",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        model,
        "--disable",
        "apps",
        "--disable",
        "shell_tool",
        "--disable",
        "shell_snapshot",
        "-c",
        'web_search="disabled"',
        "-c",
        'service_tier="default"',
    ]
    return workspace, server, [*command, prompt]


def host_calls(path, client, server):
    """Track completed tool steps from the real CLI log, independent of prose."""
    calls = []
    for line in path.read_text().splitlines():
        event = json.loads(line)
        if client == "codex":
            item = event.get("item") or {}
            if event.get("type") != "item.completed":
                continue
            if item.get("type") != "mcp_tool_call":
                require(
                    item.get("type") in {"agent_message", "reasoning"},
                    "Unexpected host tool",
                )
                continue
            require(
                item.get("server") == server
                and item.get("status") == "completed"
                and not item.get("error"),
                "Codex MCP call failed or used another server",
            )
            data = item.get("result") or {}
            body = data.get("structured_content", data.get("structuredContent"))
            if body is None:
                body = json.loads(data["content"][0]["text"])
            calls.append((item["tool"], body))
        else:
            step = event.get("step_update") or {}
            if step.get("step_type") != "tool" or step.get("state") != "DONE":
                continue
            info = step.get("tool_info") or {}
            parameters = info.get("parameters") or {}
            tool = parameters.get("ToolName")
            require(
                step.get("tool_name") == "call_mcp_tool"
                and parameters.get("ServerName") == server
                and tool in TOOLS
                and not info.get("error"),
                "Antigravity used an unexpected tool",
            )
            calls.append((tool, json.loads(info["output"])))
    return calls


def verify(project, access, calls):
    names = [name for name, _ in calls]
    require(
        names[:3] == list(TOOLS[:3]) and names[3:] and set(names[3:]) == {"job_status"},
        "Host did not perform the scoped read and job journey",
    )
    catalog, inspected, submitted = (value for _, value in calls[:3])
    terminal = calls[-1][1]["job"]
    require(
        catalog["policy"]["sha256"] == access["policy_sha256"]
        and inspected["source_id"] == access["source_id"]
        and inspected["verified"] is True,
        "Host tool responses did not verify the current scoped source",
    )
    require(
        submitted["job"]["id"] == terminal["id"]
        and terminal["state"] == "succeeded"
        and terminal["owned_worker_active"] is False,
        "Host did not poll its owned job to completion",
    )
    snapshot = agent_sessions_snapshot(project)
    sessions = snapshot["sessions"]
    require(len(sessions) == 1, "Expected exactly one real MCP session")
    session = sessions[0]
    require(
        session["policy_sha256"] == access["policy_sha256"]
        and session["tool_calls_count"] >= len(TOOLS) - 1,
        "Recorded Loci session does not match the host policy or audited calls",
    )
    actions = {
        (event["kind"], event["operation"])
        for event in snapshot["events"]
        if event["session_id"] == session["session_id"]
    }
    require(
        {
            ("session_connected", None),
            ("operation_inspected", "catalog"),
            ("operation_inspected", "inspect_source"),
            ("operation_submitted", "submit_recipe"),
            ("operation_completed", "run_recipe"),
        }
        <= actions,
        "Loci activity does not confirm the completed read and job",
    )
    jobs = project.list_jobs()
    require(len(jobs) == 1, "Expected exactly one native job")
    job = jobs[0]
    require(
        job["state"] == "succeeded"
        and job["id"] == terminal["id"]
        and job["result_ids"] == terminal["result_ids"]
        and job["owner"]
        == {
            "policy_sha256": access["policy_sha256"],
            "session_id": session["session_id"],
        }
        and session["recent_result_ids"] == job["result_ids"]
        and len(job["result_ids"]) == 1,
        "Native job did not finish with an owned result",
    )
    result = project.result(job["result_ids"][0])
    require(
        result["source_id"] == access["source_id"],
        "Result belongs to a different source",
    )
    return session, job["id"], result["revision_hash"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", choices=("codex", "antigravity"), required=True)
    parser.add_argument("--host-bin", type=Path, required=True)
    parser.add_argument(
        "--host-home", type=Path, help="Explicit isolated native auth profile"
    )
    parser.add_argument(
        "--model", required=True, help="Subscription model available in this host"
    )
    parser.add_argument(
        "--worker", type=Path, required=True, help="Installed packaged loci-engine"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="Absent private evidence directory"
    )
    args = parser.parse_args()
    worker = args.worker.resolve(strict=True)
    executable = args.host_bin.resolve(strict=True)
    output = args.output.resolve()
    if args.client == "codex":
        require(
            not any((path / ".git").exists() for path in output.parents),
            "Codex QA output must be outside Git repositories to isolate project trust",
        )
    output.mkdir(mode=0o700)
    home = (
        args.host_home.resolve(strict=True) if args.host_home else output / "Host home"
    )
    home.mkdir(mode=0o700, exist_ok=True)
    require(
        home != Path.home().resolve(),
        "Provide a private QA home, separate from the live home",
    )
    if args.client == "codex":
        config = home / ".codex/config.toml"
        require(
            not config.exists() and not config.is_symlink(),
            "Use a fresh Codex QA profile",
        )
    # Allow only OS and execution essentials. In particular, never forward API
    # keys, paid provider credentials or settings inherited from the parent.
    names = (
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "USER",
        "LOGNAME",
        "SYSTEMROOT",
        "WINDIR",
    )
    env = {name: os.environ[name] for name in names if name in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), CODEX_HOME=str(home / ".codex"))
    project, bundle, access, source_hash = fixture(output, worker, args.client)
    verification = access["verification_prompt"]
    approved = json.loads((bundle / "approved-request.json").read_text())
    prompt = (
        "This is a synthetic engineering fixture. Use serial Loci MCP calls only: no shell, "
        "file, web or other tools. "
        + verification.split(" Use MCP only.")[0]
        + " Once verified, call submit_recipe with the exact Arguments object below. "
        "Poll job_status until succeeded and owned_worker_active is false, then report the job "
        "and result IDs. Do not use any other source. "
        f"Arguments: {json.dumps({'request': approved, 'request_key': JOB_KEY})}"
    )
    (output / "prompt.txt").write_text(prompt + "\n")
    receipt = {
        "client": args.client,
        "host_sha256": digest(executable),
        "worker_sha256": digest(worker),
        "policy_sha256": access["policy_sha256"],
        "source_id": access["source_id"],
        "source_sha256": source_hash,
        "model_requested": args.model,
        "workspace_config_sha256": digest(
            bundle / access[f"{args.client}_config_filename"]
        ),
    }
    try:
        receipt["host_version"] = subprocess.check_output(
            [executable, "--version"],
            cwd=output,
            env=env,
            text=True,
            timeout=15,
        ).strip()
        if args.client == "antigravity":
            workspace, server, argv = antigravity_command(
                executable, args.model, bundle, access, prompt, output, env
            )
        else:
            workspace, server, argv = codex_command(
                executable, args.model, bundle, access, prompt
            )
        receipt["exit_code"] = run_command(
            argv, workspace, env, output, "host", timeout=200
        )
        transcript = output / "host.stdout"
        receipt["transcript_sha256"] = digest(transcript)
        calls = host_calls(transcript, args.client, server)
        receipt["mcp_calls"] = [name for name, _ in calls]
        require(
            receipt["exit_code"] == 0,
            "Headless host exited unsuccessfully; see host.stderr",
        )
        session, job_id, revision = verify(project, access, calls)
        require(
            digest(output / "synthetic image.tif") == source_hash,
            "Source bytes changed",
        )
        receipt.update(
            status="passed",
            recorded_session=session,
            job_id=job_id,
            result_revision_sha256=revision,
        )
    except (RuntimeError, subprocess.SubprocessError, ValueError) as exc:
        receipt.update(status="failed", reason=str(exc))
        raise
    finally:
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
