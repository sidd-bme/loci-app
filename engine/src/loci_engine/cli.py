"""Human-friendly entry point around the unchanged local research execution API."""

from __future__ import annotations

import argparse
import copy
import io
import json
import math
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from typing import Any

from . import cli_support, research_cli
from .terminal import MARK, WorkIndicator, render, safe_text
from .terminal_identity import animate_logo, logo_frame
from .terminal_session import run_session

_INTERNAL = {
    "mcp",
    "bounded-transfer",
    "bounded-preview",
    "agent-remote",
    "remote-worker",
    "vision-render",
}
_FORMAT_FLAGS = {"--json", "--plain", "--no-motion"}
_EXAMPLES = """Run loci without arguments to open an interactive terminal session.
The animated identity stays above your commands. Ctrl-P pauses; Ctrl-D exits.

Start a local study (absolute project path):
  LOCI_STUDY="$PWD/experiment.loci-study"
  loci create --project "$LOCI_STUDY" --title "Experiment"
  loci import --project "$LOCI_STUDY" ./image.tif
  loci sources --project "$LOCI_STUDY"

Prepare and validate an explicit recipe:
  loci guide recipe
  loci example components-2d --source SOURCE_ID > recipe.json
  loci execute --project "$LOCI_STUDY" validate_recipe --request @recipe.json
  loci submit --project "$LOCI_STUDY" --request @recipe.json --request-key run-1 --run

Output: tables in a terminal, JSON when piped. --json keeps complete machine receipts;
--plain selects readable text without motion. --no-motion disables the work indicator.
Sources stay immutable. Commands use the same validated engine as the workbench."""


def _duration(value: str) -> float:
    try:
        duration = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "Duration must be a number between 0.2 and 8 seconds."
        ) from exc
    if not math.isfinite(duration) or not 0.2 <= duration <= 8:
        raise argparse.ArgumentTypeError("Duration must be finite and between 0.2 and 8 seconds.")
    return duration


def parser() -> argparse.ArgumentParser:
    root = research_cli.parser()
    root.prog = "loci"
    root.usage = "%(prog)s COMMAND [options]"
    root.description = MARK + "\n\nLocal image research, with source-bound results."
    root.add_argument(
        "--version", action="version", version="Loci " + cli_support.version()["version"]
    )
    root.epilog = _EXAMPLES
    root.formatter_class = argparse.RawDescriptionHelpFormatter
    # Reuse every legacy command/argument instead of maintaining a second parser tree.
    sub = next(action for action in root._actions if isinstance(action, argparse._SubParsersAction))
    sub.metavar = "COMMAND"
    from .cli_study import add_commands

    add_commands(sub)
    sub.choices["discover"].add_argument(
        "query", nargs="?", help="Search operation names and purposes"
    )
    detail = sub.add_parser(
        "operation", help="Inspect one operation and its exact invocation route"
    )
    detail.add_argument("name", choices=sorted(research_cli.OPERATION_CATALOG))
    sub.add_parser("examples", help="List authored editable request examples")
    sub.add_parser("doctor", help="Inspect lightweight runtime facts without importing backends")
    complete = sub.add_parser("completion", help="Print a static shell completion script")
    complete.add_argument("shell", choices=["bash", "zsh", "fish"])
    logo = sub.add_parser("logo", help="Show the procedural Loci identity")
    logo.add_argument("--animate", action="store_true", help="Play a bounded terminal brand reveal")
    logo.add_argument(
        "--duration", type=_duration, default=3.0, help="Reveal duration, 0.2 to 8 seconds"
    )
    for name, help_text in (
        ("vision-handoff", "Export a provisional PNG/context bundle for a vision client"),
        ("agent-access", "Create a private bounded MCP access and optional plugin bundle"),
    ):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--project", required=True)
        command.add_argument("--request", required=True, help="Explicit JSON, @file.json or -")
        command.add_argument(
            "--destination", required=True, help="Absent absolute bundle directory"
        )
        if name == "agent-access":
            command.add_argument(
                "--export-root", help="Existing root for explicitly granted exports"
            )
    for name, description in {
        "snapshot": "Reopen the complete current study snapshot",
        "jobs": "Inspect durable task states and result bindings",
        "job": "Inspect one exact durable task",
        "run": "Execute a queued task with optional resource limits",
        "cancel": "Request cancellation of one durable task",
    }.items():
        sub._choices_actions.append(sub._ChoicesPseudoAction(name, [], description))
    for name in ("sources", "results"):
        command = sub.add_parser(name, help=f"Show this study's registered {name}")
        command.add_argument("--project", required=True)
    guide = sub.add_parser("guide", help="Read source-independent recipe structure and examples")
    guide.add_argument("topic", choices=["recipe"])
    example = sub.add_parser(
        "example", help="Print an authored recipe request as JSON; never run it"
    )
    example.add_argument("name")
    example.add_argument(
        "--source", required=True, help="Explicit registered 32-character source ID"
    )
    for command in (root, *sub.choices.values()):
        if command is not root:
            command.prog = command.prog.replace("loci-research", "loci", 1)
            command.epilog = "Use loci --help for a complete create/import/validate/run example."
        options = command.add_mutually_exclusive_group()
        options.add_argument(
            "--json",
            action="store_true",
            default=argparse.SUPPRESS,
            help="Print the complete machine-readable JSON receipt",
        )
        options.add_argument(
            "--plain",
            action="store_true",
            default=argparse.SUPPRESS,
            help="Print readable text, including when piped; no motion",
        )
        command.add_argument(
            "--no-motion",
            action="store_true",
            default=argparse.SUPPRESS,
            help="Disable the terminal work indicator",
        )
    # Hide transport internals in human help without removing their parser/dispatch.
    sub._choices_actions.clear()
    sub.container.description = """Explore
  discover [QUERY]     Search the operation catalog
  operation NAME       Read an exact invocation route
  guide recipe         Read authored recipe structure and units
  examples / example   List or print authored editable requests

Study
  create / import      Create a study and register immutable sources
  sources / snapshot   Inspect source IDs or the complete saved study
  results / relink     Inspect results or verify a missing source locator
  open PATH            Open a study; select its sole measurable result
  objects / locate     Query native-unit ranges or locate an object label

Analysis
  execute              Inspect, validate, preview or update declared metadata
  submit / run         Publish a durable task or execute a queued task
  jobs / job / cancel  Inspect or request cancellation of durable tasks
  review / export      Review and atomically export an exact revision
  import-labels        Preview an external scalar TIFF label plane
  import-model         Qualify an explicitly selected local model package

Connections
  agent-access         Create bounded MCP access and a local assistant plugin
  vision-handoff       Export an image and context for your chosen vision client
  policy / remote-grant  Declare explicit local assistant/remote authority

Terminal
  doctor / completion  Inspect runtime facts or generate shell completion
  logo                 Show the Loci identity (--animate for motion)
  --version            Print the engine version"""
    sub.container.title = "Commands"
    return root


def _json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _friendly_execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command in {"open", "objects", "locate"}:
        from .cli_study import execute

        output, args.study_context = execute(args)
        return output
    if args.command in {"vision-handoff", "agent-access"}:
        from .research_project import ResearchProject
        from .workbench import Workbench

        workbench = Workbench(ResearchProject(args.project))
        try:
            request = research_cli._request(args.request)
            if args.command == "vision-handoff":
                from .vision_handoff import create_vision_handoff

                return create_vision_handoff(workbench, request, args.destination)
            from .research_agent_setup import create_agent_access

            return create_agent_access(workbench, request, args.destination, args.export_root)
        finally:
            workbench.close()
    if args.command == "discover":
        return cli_support.discover(args.query)
    if args.command == "operation":
        return cli_support.operation(args.name)
    if args.command == "examples":
        return cli_support.examples()
    if args.command == "doctor":
        return cli_support.doctor()
    if args.command == "completion":
        root = parser()
        sub = next(
            action for action in root._actions if isinstance(action, argparse._SubParsersAction)
        )
        commands = sorted(set(sub.choices) - _INTERNAL)
        flags = sorted(
            {
                flag
                for command in (root, *[sub.choices[name] for name in commands])
                for action in command._actions
                for flag in action.option_strings
                if flag.startswith("--")
            }
        )
        value_flags = sorted(
            {
                flag
                for command in (root, *[sub.choices[name] for name in commands])
                for action in command._actions
                if action.nargs != 0
                for flag in action.option_strings
                if flag.startswith("--")
            }
        )
        return {
            "schema": "loci.cli-completion/v1",
            "shell": args.shell,
            "script": cli_support.completion(args.shell, commands, flags, value_flags),
        }
    if args.command == "logo":
        return {"schema": "loci.cli-logo/v1", "mark": logo_frame()}
    if args.command in {"guide", "example"}:
        from .research_recipe_guide import recipe_guide

        guide = recipe_guide()
        if args.command == "guide":
            return guide
        if not re.fullmatch(r"[a-f0-9]{32}", args.source):
            raise ValueError(
                "Choose an explicit registered source ID: 32 lowercase hex characters."
            )
        example = next((item for item in guide["examples"] if item["name"] == args.name), None)
        if example is None:
            names = ", ".join(item["name"] for item in guide["examples"])
            raise ValueError(f"Unknown recipe example {args.name!r}. Available examples: {names}.")
        request = copy.deepcopy(example["request"])
        request["source_id"] = args.source
        return request
    if args.command in {"sources", "results"}:
        selected = args.command
        args = copy.copy(args)
        args.command = "snapshot"
        snapshot = research_cli.execute(args)
        return {selected: snapshot[selected]}
    return research_cli.execute(args)


def _error(kind: str, message: str, machine: bool, hint: str | None = None) -> None:
    if machine:
        print(_json({"error": {"type": kind, "message": message}}), file=sys.stderr)
    else:
        print(f"Loci: {safe_text(message)}", file=sys.stderr)
        if hint:
            print(hint, file=sys.stderr)


def _motion_allowed(values: list[str], machine: bool) -> bool:
    return (
        not machine
        and not any(flag in values for flag in ("--plain", "--no-motion"))
        and sys.stdout.isatty()
        and sys.stderr.isatty()
        and "NO_COLOR" not in os.environ
        and os.environ.get("TERM") != "dumb"
    )


def main(argv: list[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    # These commands own a machine protocol or disposable resource-limited child.
    # No terminal wrapper, thread or banner may run around their execution.
    remaining = values[:]
    while remaining and remaining[0] in _FORMAT_FLAGS:
        remaining.pop(0)
    if remaining and remaining[0] in _INTERNAL:
        return research_cli.main(remaining)
    machine = "--json" in values or ("--plain" not in values and not sys.stdout.isatty())
    if "--json" in values and "--plain" in values:
        _error("ArgumentError", "Choose either --json or --plain.", machine)
        return 2
    if remaining == ["--version"]:
        output = cli_support.version()
        print(_json(output) if machine else "Loci " + output["version"])
        return 0
    if not remaining:
        if machine:
            print(_json({"schema": "loci.cli-help/v1", "examples": _EXAMPLES.splitlines()}))
        else:
            try:
                if _motion_allowed(values, machine) and sys.stdin.isatty():
                    if os.name == "posix":
                        return run_session()
                    animate_logo(sys.stdout, 1.05)
                else:
                    print(MARK + "\n")
            except KeyboardInterrupt:
                _error("Interrupted", "Identity reveal interrupted.", machine)
                return 130
            except SystemExit as exc:
                if exc.code == 143:
                    return 143
                raise
            print(_EXAMPLES + "\n\nUse loci --help for all commands.")
        return 0
    root = parser()
    diagnostics = io.StringIO()
    help_text = io.StringIO()
    try:
        if "--json" in values and any(flag in values for flag in ("--help", "-h")):
            with redirect_stdout(help_text), redirect_stderr(diagnostics):
                args = root.parse_args(values)
        else:
            with redirect_stderr(diagnostics):
                args = root.parse_args(values)
        if getattr(args, "json", False) and getattr(args, "plain", False):
            raise ValueError("Choose either --json or --plain.")
    except SystemExit as exc:
        if exc.code:
            _error(
                "ArgumentError",
                diagnostics.getvalue().strip(),
                machine,
                "Use loci COMMAND --help for required arguments and examples.",
            )
        elif help_text.getvalue():
            print(_json({"schema": "loci.cli-help/v1", "help": help_text.getvalue()}))
        return int(exc.code or 0)
    except ValueError as exc:
        _error(type(exc).__name__, str(exc), machine)
        return 2
    motion = _motion_allowed(values, machine) and args.command in {
        "import",
        "import-model",
        "import-labels",
        "execute",
        "submit",
        "run",
        "export",
        "relink",
        "vision-handoff",
        "agent-access",
    }
    try:
        if args.command == "logo" and args.animate and _motion_allowed(values, machine):
            animate_logo(sys.stdout, args.duration)
            return 0
        with WorkIndicator(sys.stderr, args.command.replace("-", " "), motion):
            output = _friendly_execute(args)
        if (
            machine and (args.command != "completion" or "--json" in values)
        ) or args.command == "example":
            print(_json(output))
        elif args.command == "completion":
            print(output["script"], end="")
        elif args.command == "logo":
            print(output["mark"])
        else:
            print(
                render(args.command, output, context=getattr(args, "study_context", None)), end=""
            )
        if args.command == "doctor" and any(
            item.get("required") and item["status"] not in {"ok", "discoverable"}
            for item in output["checks"]
        ):
            _error("DiagnosticError", "A required runtime/package discovery check failed.", machine)
            return 1
        requested_run = args.command == "run" or (
            args.command == "submit" and getattr(args, "run", False)
        )
        job = output.get("job")
        if (
            requested_run
            and isinstance(job, dict)
            and job.get("state") in {"failed", "cancelled", "interrupted"}
        ):
            message = job.get("error") or f"Requested execution is {job['state']}."
            _error(
                "JobExecutionError",
                message,
                machine,
                "Inspect jobs; submit a new explicit request key to retry failed work.",
            )
            return 1
        return 0
    except KeyboardInterrupt:
        if args.command == "logo":
            _error("Interrupted", "Identity reveal interrupted.", machine)
            return 130
        _error(
            "Interrupted",
            "Interrupted. Inspect jobs before retrying; published results are retained.",
            machine,
            "loci jobs --project YOUR_STUDY",
        )
        return 130
    except SystemExit as exc:
        if exc.code == 128 + 15:
            if args.command == "logo":
                _error("Interrupted", "Identity reveal terminated.", machine)
                return 143
            _error(
                "Interrupted",
                "Terminated. Inspect jobs before retrying; published results are retained.",
                machine,
                "loci jobs --project YOUR_STUDY",
            )
            return int(exc.code)
        raise
    except Exception as exc:  # local CLI boundary: retain the diagnostic, omit traceback
        _error(
            type(exc).__name__,
            str(exc),
            machine,
            "Inspect loci jobs/sources --project YOUR_STUDY; use loci COMMAND --help for inputs.",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
