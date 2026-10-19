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
    labels = sub.add_parser(
        "import-labels", help="Preview an explicit external scalar TIFF label plane"
    )
    labels.add_argument("--project", required=True)
    labels.add_argument("--path", required=True)
    labels.add_argument("--source", required=True)
    labels.add_argument("--source-sha256", required=True)
    labels.add_argument("--selection", required=True, help="Explicit native T/C/Z/level JSON")
    labels.add_argument("--working-bytes", type=int, default=512 * 1024**2)
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
    effect_export = sub.add_parser(
        "export-correction-effect",
        help="Atomically export an exact reviewed correction-effect receipt",
    )
    effect_export.add_argument("--project", required=True)
    effect_export.add_argument("--receipt-sha256", required=True)
    effect_export.add_argument("--destination", required=True)
    relink = sub.add_parser("relink", help="Verify and replace a missing source locator")
    relink.add_argument("--project", required=True)
    relink.add_argument("--source", required=True)
    relink.add_argument("--candidate", required=True)
    transfer = sub.add_parser("bounded-transfer", help="Fixed internal file-size-limited SCP child")
    transfer.add_argument("--file-size-limit", type=int, required=True)
    transfer.add_argument("transfer_arguments", nargs=argparse.REMAINDER)
    remote = sub.add_parser("remote-worker", help="Run a fixed, staged worker manifest")
    remote.add_argument("--request", required=True)
    grant = sub.add_parser(
        "remote-grant", help="Read exact identities for a human-staged classical run"
    )
    grant.add_argument("--project", required=True)
    grant.add_argument("--request-key", required=True)
    grant.add_argument("--key", required=True)
    grant.add_argument(
        "--operations",
        nargs="+",
        choices=["submit", "status", "cancel", "retrieve", "attach"],
        required=True,
    )
    grant.add_argument("--max-output-bytes", type=int, required=True)
    grant.add_argument("--cancel-on-revocation", action="store_true")
    agent_remote = sub.add_parser(
        "agent-remote", help="Fixed policy-pinned transfer/adoption child"
    )
    for name in ("project", "job", "grant-key", "policy", "policy-sha256"):
        agent_remote.add_argument("--" + name, required=True)
    agent_remote.add_argument("--operation", required=True, choices=["retrieve", "attach"])
    for name in ("policy-file-identity", "project-directory-identity", "export-directory-identity"):
        agent_remote.add_argument("--" + name, required=True)
    vision = sub.add_parser("vision-render", help=argparse.SUPPRESS)
    for name in (
        "project",
        "policy",
        "policy-sha256",
        "request",
        "policy-file-identity",
        "project-directory-identity",
        "export-directory-identity",
    ):
        vision.add_argument("--" + name, required=True)
    vision.add_argument(
        "--operation",
        choices=["source_image", "export_vision_handoff", "inspect_action", "study_results"],
        required=True,
    )
    vision.add_argument("--cpu-seconds", type=int, required=True)
    vision.add_argument("--memory-bytes", type=int, required=True)
    mcp = sub.add_parser("mcp", help="Serve policy-scoped task tools over local stdio")
    mcp.add_argument("--policy", required=True)
    policy = sub.add_parser("policy", help="Write an explicit local-human agent access policy")
    policy.add_argument("--project", required=True)
    policy.add_argument("--destination", required=True)
    policy.add_argument("--specification", required=True, help="Explicit JSON grants or @file")
    # Internal children are launchable by their fixed command but absent from human discovery.
    sub._choices_actions = [
        action for action in sub._choices_actions if action.dest != "vision-render"
    ]
    sub.metavar = "{" + ",".join(name for name in sub.choices if name != "vision-render") + "}"
    return root


def execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "bounded-transfer":
        from .agent_remote_transfer import exec_bounded_scp

        exec_bounded_scp(args.file_size_limit, args.transfer_arguments)
        raise RuntimeError("Bounded SCP did not replace its disposable process")
    if args.command in {"run", "bounded-preview", "vision-render"}:
        from .resource_limits import apply_process_limits

        cpu = getattr(args, "cpu_seconds", None)
        memory = getattr(args, "memory_bytes", None)
        apply_process_limits(cpu, memory)
    if args.command == "vision-render":
        from .agent_policy import load_policy
        from .research_mcp import PolicyAgent

        policy = load_policy(args.policy)

        def identity(value):
            return "none" if value is None else ":".join(map(str, value))

        if (
            policy.content_sha256 != args.policy_sha256
            or policy.project_path != Path(args.project)
            or args.policy_file_identity != identity(policy.file_identity)
            or args.project_directory_identity != identity(policy.project_directory_identity)
            or args.export_directory_identity != identity(policy.export_root_identity)
            or args.cpu_seconds != policy.cpu_seconds
            or args.memory_bytes != policy.memory_bytes
        ):
            raise PermissionError("Vision child policy or resource identity changed")
        if args.operation == "export_vision_handoff":
            for category in ("previews", "geometry", "provenance", "agent_metadata"):
                policy.require_disclosure(category)
        agent = PolicyAgent(policy)
        workbench = agent._workbench(args.operation)
        try:
            request = _request(args.request)
            if args.operation == "inspect_action":
                from .agent_actions import inspect_action
                from .quantitative import exact_keys

                exact_keys(request, {"operation", "request"}, "action inspection")
                return inspect_action(agent, workbench, request["operation"], request["request"])
            if args.operation == "study_results":
                return agent._study_results(workbench, request)
            return agent._vision_frame(
                workbench, request, supervised=False, operation=args.operation
            )
        finally:
            workbench.close()
    if args.command == "agent-remote":
        from .agent_policy import load_policy
        from .agent_remote import execute_child

        policy = load_policy(args.policy)
        if policy.content_sha256 != args.policy_sha256 or policy.project_path != Path(args.project):
            raise PermissionError("Agent child policy identity changed")

        def identity(value):
            return "none" if value is None else ":".join(map(str, value))

        if (
            args.policy_file_identity != identity(policy.file_identity)
            or args.project_directory_identity != identity(policy.project_directory_identity)
            or args.export_directory_identity != identity(policy.export_root_identity)
        ):
            raise PermissionError("Agent child filesystem identities changed")
        return execute_child(policy, args.grant_key, args.operation, args.job)
    if args.command == "discover":
        from .research_action_registry import operation_catalog

        return {"schema": "loci.operations/v1", "operations": operation_catalog()}
    if args.command == "remote-worker":
        from .remote_worker import run_manifest

        return run_manifest(args.request)
    from .research_jobs import cancel_job, reconcile_jobs, run_job, submit_job
    from .research_project import ResearchProject
    from .workbench import Workbench

    if args.command == "create":
        return Workbench(ResearchProject.create(args.project, args.title)).snapshot()
    project = ResearchProject(args.project)
    if args.command == "remote-grant":
        from .agent_remote import human_remote_grant

        return human_remote_grant(
            project,
            args.request_key,
            args.key,
            args.operations,
            args.max_output_bytes,
            args.cancel_on_revocation,
        )
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
        if args.command == "import-labels":
            from .research_labels_import import create_import_grant

            return create_import_grant(
                workbench,
                str(Path(args.path).absolute()),
                args.source,
                args.source_sha256,
                _request(args.selection),
                args.working_bytes,
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
        if args.command == "export-correction-effect":
            from .research_correction_effect import export_effect

            return export_effect(project, args.receipt_sha256, args.destination)
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
        if args.command in {"agent-remote", "vision-render"}:
            print(
                json.dumps(
                    {
                        "error": {
                            "type": "AgentVisionError"
                            if args.command == "vision-render"
                            else "AgentRemoteError",
                            "message": "Bounded vision work failed."
                            if args.command == "vision-render"
                            else "Bounded remote work failed.",
                        }
                    }
                ),
                file=sys.stderr,
            )
            return 1
        # The stderr message is an explicit local diagnostic. stdout is always
        # machine-readable, and no traceback or image content is emitted.
        print(
            json.dumps({"error": {"type": type(exc).__name__, "message": str(exc)}}),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
