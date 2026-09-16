"""Explicit local-human CLI; policy-bound MCP has a separate, narrower surface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .research_operations import OPERATION_CATALOG, PREVIEW_OPERATIONS, TASK_OPERATIONS


def _request(value: str, maximum: int = 1024 * 1024) -> dict[str, Any]:
    from .research_project import parse_json

    # @file is an explicit manual CLI read grant, never an MCP tool parameter.
    if value == "-":
        encoded = sys.stdin.read(maximum + 1)
    elif value.startswith("@"):
        file = Path(value[1:])
        if file.is_symlink() or not file.is_file() or file.stat().st_size > maximum:
            raise ValueError(
                f"Request file must be a plain JSON file of at most {maximum // 1024**2} MiB"
            )
        encoded = file.read_text(encoding="utf-8")
    else:
        encoded = value
    if len(encoded.encode()) > maximum:
        raise ValueError(f"Request exceeds the {maximum // 1024**2} MiB limit")
    parsed = parse_json(encoded)
    if not isinstance(parsed, dict):
        raise ValueError("Request must be a JSON object")
    return parsed


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="loci-research", description="Local, reproducible Loci research tasks"
    )
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("discover", help="List the shared validated operation catalog")
    create = sub.add_parser("create", help="Create an absent study directory")
    create.add_argument("--project", required=True)
    create.add_argument("--title", required=True)
    import_source = sub.add_parser("import", help="Register explicitly selected immutable sources")
    import_source.add_argument("--project", required=True)
    import_source.add_argument("--kind", choices=["files", "dicom"], default="files")
    import_source.add_argument("paths", nargs="+")
    import_model = sub.add_parser(
        "import-model", help="Qualify and import an explicitly selected local model package"
    )
    import_model.add_argument("--project", required=True)
    import_model.add_argument("--path", required=True)
    import_model.add_argument("--working-bytes", type=int, default=512 * 1024**2)
    for name in ("snapshot", "jobs"):
        command = sub.add_parser(name)
        command.add_argument("--project", required=True)
    execute = sub.add_parser(
        "execute", help="Inspect, validate, preview or update declared metadata"
    )
    execute.add_argument("--project", required=True)
    execute.add_argument("operation", choices=sorted(OPERATION_CATALOG))
    execute.add_argument("--request", required=True, help="JSON, @file.json or - for stdin")
    preview = sub.add_parser("bounded-preview", help="Resource-limited non-adopted recipe preview")
    preview.add_argument("--project", required=True)
    preview.add_argument("--request", required=True)
    preview.add_argument("--cpu-seconds", type=int, required=True)
    preview.add_argument("--memory-bytes", type=int, required=True)
    submit = sub.add_parser("submit", help="Submit a versioned run with a stable retry key")
    submit.add_argument("--project", required=True)
    submit.add_argument("--request", required=True)
    submit.add_argument("--request-key", required=True)
    submit.add_argument("--operation", choices=sorted(TASK_OPERATIONS), default="run_recipe")
    submit.add_argument("--run", action="store_true", help="Execute this queued job now")
    for name in ("run", "cancel", "job"):
        command = sub.add_parser(name)
        command.add_argument("--project", required=True)
        command.add_argument("--job", required=True)
        if name == "run":
            command.add_argument("--cpu-seconds", type=int)
            command.add_argument("--memory-bytes", type=int)
            command.add_argument("--max-concurrency", type=int)
            command.add_argument("--policy")
            command.add_argument("--policy-sha256")
    review = sub.add_parser("review", help="Explicit local-human review of an exact revision")
    review.add_argument("--project", required=True)
    review.add_argument("--result", required=True)
    review.add_argument("--revision", required=True)
    review.add_argument("--disposition", choices=["reviewed", "excluded", "pending"], required=True)
    export = sub.add_parser("export", help="Atomically export an already reviewed exact revision")
    export.add_argument("--project", required=True)
    export.add_argument("--result", required=True)
    export.add_argument("--revision", required=True)
    export.add_argument("--destination", required=True)
    relink = sub.add_parser("relink", help="Verify and replace a missing source locator")
    relink.add_argument("--project", required=True)
    relink.add_argument("--source", required=True)
    relink.add_argument("--candidate", required=True)
    remote = sub.add_parser("remote-worker", help="Run a fixed, staged worker manifest")
    remote.add_argument("--request", required=True)
    mcp = sub.add_parser("mcp", help="Serve policy-scoped task tools over local stdio")
    mcp.add_argument("--policy", required=True)
    policy = sub.add_parser("policy", help="Write an explicit local-human agent access policy")
    policy.add_argument("--project", required=True)
    policy.add_argument("--destination", required=True)
    policy.add_argument("--specification", required=True, help="Explicit JSON grants or @file")
    return root


def execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command in {"run", "bounded-preview"}:
        from .resource_limits import apply_process_limits

        cpu = getattr(args, "cpu_seconds", None)
        memory = getattr(args, "memory_bytes", None)
        apply_process_limits(cpu, memory)
    if args.command == "discover":
        return {"schema": "loci.operations/v1", "operations": OPERATION_CATALOG}
    if args.command == "remote-worker":
        from .remote_worker import run_manifest

        return run_manifest(args.request)
    from .research_jobs import cancel_job, reconcile_jobs, run_job, submit_job
    from .research_project import ResearchProject
    from .workbench import Workbench

    if args.command == "create":
        return Workbench(ResearchProject.create(args.project, args.title)).snapshot()
    project = ResearchProject(args.project)
    if args.command == "policy":
        from .agent_policy import write_policy

        return write_policy(args.destination, project, _request(args.specification))
    workbench = Workbench(project)
    try:
        if args.command == "import-model":
            from .research_models import import_model

            return import_model(workbench, args.path, args.working_bytes)
        if args.command == "import":
            from .research_rpc import dispatch_research

            return dispatch_research(
                "research_import",
                {
                    "project": str(project.root),
                    "paths": [str(Path(p).absolute()) for p in args.paths],
                    "kind": args.kind,
                },
            )
        if args.command == "snapshot":
            reconcile_jobs(project)
            return workbench.snapshot()
        if args.command == "jobs":
            return {"jobs": reconcile_jobs(project)}
        if args.command == "job":
            from .research_jobs import public_job

            return public_job(project.job(args.job))
        if args.command == "execute":
            if args.operation in TASK_OPERATIONS - PREVIEW_OPERATIONS:
                raise ValueError("Use submit --request-key KEY --run for a durable execution")
            return workbench.execute(args.operation, _request(args.request))
        if args.command == "bounded-preview":
            return workbench.run_recipe(_request(args.request), preview=True)
        if args.command == "submit":
            maximum = 12 * 1024**2 if args.operation == "roi_import" else 1024**2
            job = submit_job(
                workbench, _request(args.request, maximum), args.request_key, args.operation
            )
            return run_job(workbench, job["id"]) if args.run else {"job": job}
        if args.command == "run":
            guard = None
            if bool(args.policy) != bool(args.policy_sha256):
                raise ValueError("Policy execution requires both path and pinned identity")
            if args.policy:
                from .agent_policy import load_policy
                from .research_mcp import PolicyAgent

                policy = load_policy(args.policy)
                if (
                    policy.content_sha256 != args.policy_sha256
                    or policy.project_path != project.root
                ):
                    raise PermissionError(
                        "The execution policy changed before this process started"
                    )
                policy_agent = PolicyAgent(policy)
                policy_agent._authorize_job(workbench, args.job)
                if (
                    args.cpu_seconds != policy.cpu_seconds
                    or args.memory_bytes != policy.memory_bytes
                    or args.max_concurrency != policy.concurrency
                ):
                    raise PermissionError(
                        "The execution resource limits differ from the pinned policy"
                    )
                guard = policy.recheck
            return run_job(
                workbench, args.job, publication_guard=guard, max_concurrency=args.max_concurrency
            )
        if args.command == "cancel":
            return cancel_job(project, args.job)
        if args.command == "review":
            return project.review(args.result, args.revision, args.disposition)
        if args.command == "relink":
            return project.relink(args.source, args.candidate)
        if args.command == "export":
            from .research_export import export_research_result

            return export_research_result(project, args.result, args.revision, args.destination)
        raise ValueError("Unknown local command")
    finally:
        workbench.close()


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "mcp":
        try:
            from .research_mcp import serve

            serve(args.policy)
            return 0
        except Exception:
            # The MCP process owns a renderer-safe public boundary. Startup
            # failures must not disclose policy, project, or implementation paths.
            print(
                json.dumps(
                    {
                        "error": {
                            "type": "MCPStartupError",
                            "message": "The local research tool server could not start.",
                        }
                    }
                ),
                file=sys.stderr,
            )
            return 1
    try:
        output = execute(args)
        if args.command == "discover":
            print(json.dumps(output, sort_keys=True, separators=(",", ":"), allow_nan=False))
        else:
            from .research_project import canonical_json

            print(canonical_json(output))
        return 0
    except (ValueError, TypeError, OSError, KeyError, RuntimeError) as exc:
        # The stderr message is an explicit local diagnostic. stdout is always
        # machine-readable, and no traceback or image content is emitted.
        print(
            json.dumps({"error": {"type": type(exc).__name__, "message": str(exc)}}),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
