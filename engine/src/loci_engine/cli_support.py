"""Source-independent CLI discovery. Never opens a study or provisions a runtime."""

from __future__ import annotations

import importlib.util
import platform
import shlex
import sys
from typing import Any

from .models import ENGINE_VERSION
from .research_action_registry import REQUESTS, operation_catalog
from .research_operations import OPERATION_CATALOG, PREVIEW_OPERATIONS, TASK_OPERATIONS

RECIPE_OPERATIONS = {"validate_recipe", "recipe_preflight", "preview_recipe", "run_recipe"}


def discover(query: str | None) -> dict[str, Any]:
    # No-query discovery is the existing public protocol, with no added fields.
    catalog = operation_catalog()
    if query is None:
        return {"schema": "loci.operations/v1", "operations": catalog}
    words = query.casefold().split()
    return {
        "schema": "loci.operations/v1",
        "query": query,
        "operations": {
            name: item
            for name, item in catalog.items()
            if all(word in (name + " " + item["summary"]).casefold() for word in words)
        },
    }


def operation(name: str) -> dict[str, Any]:
    if name not in OPERATION_CATALOG:
        raise ValueError(
            f"Unknown operation {name!r}. Use loci discover QUERY to find an exact name."
        )
    durable = name in TASK_OPERATIONS - PREVIEW_OPERATIONS
    argv = (
        [
            "loci",
            "submit",
            "--project",
            "STUDY",
            "--operation",
            name,
            "--request",
            "@request.json",
            "--request-key",
            "KEY",
            "--run",
        ]
        if durable
        else ["loci", "execute", "--project", "STUDY", name, "--request", "@request.json"]
    )
    receipt = {
        "schema": "loci.cli-operation/v1",
        "name": name,
        **operation_catalog()[name],
        "route": "submit" if durable else "execute",
        "preview": name in PREVIEW_OPERATIONS,
        "invocation": shlex.join(argv),
        "argv": argv,
        "guidance": [
            "Replace STUDY with an absolute study path; supply an operation-specific JSON request.",
            "KEY is a new explicit retry identity for an intentional new durable run."
            if durable
            else "This execute route does not require a durable request key.",
        ],
        "request_schema": REQUESTS.get(name),
        "examples": [],
    }
    if name == "labels_import":
        receipt["request_schema"] = {
            "type": "object",
            "additionalProperties": False,
            "required": ["source_id", "source_sha256", "grant_id", "alignment"],
            "properties": {
                "source_id": {"type": "string", "pattern": "^[a-f0-9]{32}$"},
                "source_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "grant_id": {"type": "string", "pattern": "^[a-f0-9]{32}$"},
                "alignment": {"const": "same-native-yx-grid"},
                "producer": {
                    "type": ["object", "null"],
                    "additionalProperties": False,
                    "required": ["name"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 128},
                        "version": {"type": ["string", "null"], "maxLength": 128},
                    },
                },
            },
        }
        receipt["guidance"].append(
            "First run loci import-labels with --path, --source, --source-sha256 and explicit "
            "--selection JSON to inspect a private preview grant; use its grant_id here. "
            "The alignment declaration asserts correspondence; matching shape does not prove it."
        )
        receipt["request_schema"]["examples"] = [
            {
                "source_id": "SOURCE_ID",
                "source_sha256": "SOURCE_SHA256",
                "grant_id": "PREVIEW_GRANT_ID",
                "alignment": "same-native-yx-grid",
            }
        ]
    elif name in RECIPE_OPERATIONS:
        from .research_recipe_guide import recipe_guide

        guide = recipe_guide()
        # The authored recipe schema documents recipe requests only, not other operations.
        receipt["recipe_guide"] = "loci guide recipe --json"
        receipt["request_schema"] = guide["request_schema"]
        receipt["examples"] = [item["name"] for item in guide["examples"]]
        receipt["guidance"].append("Read the recipe guide for authored settings and unit meanings.")
    else:
        receipt["guidance"].append(
            "No authored CLI request schema/example is available for this operation. "
            "Use its documented contract and the source-dependent validator."
        )
    return receipt


def examples() -> dict[str, Any]:
    from .research_recipe_guide import recipe_guide

    guide = recipe_guide()
    return {
        "schema": "loci.cli-examples/v1",
        "examples": [
            {
                "name": item["name"],
                "description": item["description"],
                "invocation": f"loci example {item['name']} --source SOURCE_ID",
            }
            for item in guide["examples"]
        ],
        "guidance": "Authored settings illustrate structure; inspect and edit before validation.",
    }


def version() -> dict[str, Any]:
    return {"schema": "loci.cli-version/v1", "version": ENGINE_VERSION}


def doctor() -> dict[str, Any]:
    """Report lightweight runtime facts without importing optional numerical backends."""
    checks = [
        {
            "name": "python",
            "required": True,
            "status": "ok" if sys.version_info >= (3, 11) else "unsupported",
            "detail": platform.python_version(),
        },
        {
            "name": "operation_catalog",
            "required": True,
            "status": "ok",
            "count": len(OPERATION_CATALOG),
        },
    ]
    for name in ("numpy", "scipy", "tifffile", "cellpose"):
        # Top-level lookup does not load the package, run inference or touch source files.
        available = importlib.util.find_spec(name) is not None
        checks.append(
            {
                "name": name,
                "required": name != "cellpose",
                "status": "discoverable" if available else "not-found",
            }
        )
    return {
        "schema": "loci.cli-doctor/v1",
        "version": ENGINE_VERSION,
        "runtime": "packaged" if getattr(sys, "frozen", False) else "python",
        "platform": sys.platform,
        "checks": checks,
        "scope": "Import-location discovery only. No backend was imported, no model was checked, "
        "and no study, network or download was accessed.",
    }


def completion(shell: str, commands: list[str], flags: list[str], value_flags: list[str]) -> str:
    """Static completion, generated from this parser; never execute Loci from the shell."""
    command_words = " ".join(commands)
    value_pattern = "|".join(value_flags)
    flag_words = " ".join(flags)
    operation_words = " ".join(sorted(OPERATION_CATALOG))
    task_words = " ".join(sorted(TASK_OPERATIONS))
    example_words = " ".join(item["name"] for item in examples()["examples"])
    if shell == "bash":
        return f"""# Loci static completion; source this file in bash.
_loci_complete() {{
  local cur="${{COMP_WORDS[COMP_CWORD]}}" prev="${{COMP_WORDS[COMP_CWORD-1]}}"
  local words='{command_words} {flag_words}' token
  # Operation names remain available after --project STUDY as well as directly.
  for token in "${{COMP_WORDS[@]:1:COMP_CWORD-1}}"; do
    case "$token" in
      execute|operation) words='{operation_words} {flag_words}'; break ;;
      example) words='{example_words} {flag_words}'; break ;;
    esac
  done
  case "$prev" in
    operation|execute) words='{operation_words}' ;;
    --operation) words='{task_words}' ;;
    example) words='{example_words}' ;;
    guide) words='recipe' ;;
    completion) words='bash zsh fish' ;;
    --kind) words='files dicom' ;;
    --disposition) words='reviewed excluded pending' ;;
    --project|--request|--destination|--path|--candidate|--policy)
      COMPREPLY=()
      while IFS= read -r token; do COMPREPLY+=("$token"); done < <(compgen -f -- "$cur")
      return ;;
    {value_pattern}) COMPREPLY=(); return ;;
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}}
complete -F _loci_complete loci
"""
    if shell == "zsh":
        return f"""#compdef loci
# Loci static completion; place in a completion directory as _loci.
_loci() {{
  local -a candidates
  candidates=({command_words} {flag_words})
  if (( ${{words[(I)execute]}} || ${{words[(I)operation]}} )); then
    candidates=({operation_words} {flag_words})
  elif (( ${{words[(I)example]}} )); then
    candidates=({example_words} {flag_words})
  fi
  case "$words[CURRENT-1]" in
    operation|execute) candidates=({operation_words}) ;;
    --operation) candidates=({task_words}) ;;
    example) candidates=({example_words}) ;;
    guide) candidates=(recipe) ;;
    completion) candidates=(bash zsh fish) ;;
    --kind) candidates=(files dicom) ;;
    --disposition) candidates=(reviewed excluded pending) ;;
    --project|--request|--destination|--path|--candidate|--policy) _files; return ;;
    {value_pattern}) return ;;
  esac
  compadd -- $candidates
}}
compdef _loci loci
"""
    return f"""# Loci static completion; save as ~/.config/fish/completions/loci.fish.
complete -c loci -f
complete -c loci -n '__fish_use_subcommand' -a '{command_words}'
complete -c loci -n '__fish_seen_subcommand_from operation execute' -a '{operation_words}'
complete -c loci -n '__fish_seen_subcommand_from example' -a '{example_words}'
complete -c loci -n '__fish_seen_subcommand_from guide' -a recipe
complete -c loci -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c loci -l operation -r -a '{task_words}'
complete -c loci -l kind -r -a 'files dicom'
complete -c loci -l disposition -r -a 'reviewed excluded pending'
""" + "".join(
        f"complete -c loci -l {flag[2:]}{' -r' if flag in value_flags else ''}\n"
        for flag in flags
        if flag not in {"--operation", "--kind", "--disposition"}
    )
