"""Create a private, bounded MCP access bundle from the trusted desktop UI."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .agent_policy import write_policy
from .export import _fsync_directory, _rename_noreplace
from .quantitative import exact_keys
from .research_process import research_command
from .workbench import Workbench, runtime_record


def create_agent_access(
    workbench: Workbench,
    request: dict[str, Any],
    destination: str | Path,
    export_root: str | Path | None = None,
) -> dict[str, Any]:
    """No network access, model import, human review or execution is performed."""
    expected = {
        "source_id",
        "selection",
        "recipe",
        "allow_preview",
        "allow_run",
        "allow_export",
        "export_names",
        "disclosures",
        "limits",
    }
    exact_keys(request, expected, "agent access")
    if set(request) != expected:
        raise ValueError("Agent access requires every explicit permission and limit")
    for name in ("allow_preview", "allow_run", "allow_export"):
        if not isinstance(request[name], bool):
            raise ValueError("Agent operation grants must be boolean")
    recipe = request["recipe"]
    if isinstance(recipe, dict) and recipe.get("references"):
        raise ValueError("Agent access does not yet support separately scoped reference images")
    validated = workbench.validate_recipe(
        {key: request[key] for key in ("source_id", "selection", "recipe")}
    )
    limits = request["limits"]
    exact_keys(limits, {"cpu_seconds", "memory_bytes", "concurrency"}, "agent limits")
    memory = limits.get("memory_bytes")
    if (
        isinstance(memory, bool)
        or not isinstance(memory, int)
        or validated["recipe"]["working_bytes"] > memory
    ):
        raise ValueError("The recipe working-memory budget exceeds the agent memory limit")
    disclosures = request["disclosures"]
    if not isinstance(disclosures, list) or not all(isinstance(item, str) for item in disclosures):
        raise ValueError("Agent disclosures must be an explicit list")
    if request["allow_preview"] and "previews" not in disclosures:
        raise ValueError("Preview access requires explicit previews disclosure")
    if request["allow_export"]:
        required = {"geometry", "source_names", "previews", "measurements", "provenance"}
        if not required <= set(disclosures) or export_root is None:
            raise ValueError(
                "Export requires all result disclosures and a chosen local export folder"
            )
        if not request["allow_run"]:
            raise ValueError("Export requires the exact recipe run grant to authorize its result")
    elif export_root is not None or request["export_names"]:
        raise ValueError("Export destinations require an explicit export grant")
    selection = validated["selection"]
    source = workbench.project.source(validated["source_id"], verify=True)
    operations = ["inspect_source", "validate_recipe"]
    if request["allow_preview"]:
        operations.append("preview_recipe")
    if request["allow_run"]:
        operations.extend(["submit_recipe", "job_status", "cancel_job", "result"])
        if "previews" in disclosures:
            operations.append("result_view")
    if request["allow_export"]:
        operations.append("export_result")
    runtime = runtime_record()
    specification = {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {key: selection[key] for key in ("x", "y", "width", "height")},
                "t": [selection["t"]],
                "c": [selection["c"]],
                "z": list(range(selection["z"], selection.get("z_stop", selection["z"] + 1))),
                "level": [selection["level"]],
                "measurement_channels": sorted(validated["recipe"]["measurement_channels"]),
            }
        ],
        "recipes": [
            {
                "sha256": validated["recipe_sha256"],
                "preview": request["allow_preview"],
                "run": request["allow_run"],
            }
        ],
        "operations": operations,
        "model_packages": [],
        "runtimes": [
            {
                key: runtime[key]
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
        "export": {"root": str(export_root), "filenames": request["export_names"]}
        if request["allow_export"]
        else None,
        "limits": limits,
        "disclosures": disclosures,
    }
    target = Path(destination).expanduser()
    if not target.is_absolute() or target.is_symlink() or target.exists():
        raise ValueError("Choose an absent absolute directory for the agent access bundle")
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    stage = Path(tempfile.mkdtemp(prefix=".loci-agent-access-", dir=parent))
    os.chmod(stage, 0o700)
    try:
        receipt = write_policy(stage / "agent-policy.json", workbench.project, specification)
        command = research_command(["mcp", "--policy", str(target / "agent-policy.json")])
        config = {"mcpServers": {"loci-research": {"command": command[0], "args": command[1:]}}}
        # A source checkout needs a deterministic import directory; frozen workers do not.
        if "-m" in command:
            config["mcpServers"]["loci-research"]["cwd"] = str(Path(__file__).resolve().parents[2])
        stdio = config["mcpServers"]["loci-research"]
        codex_config = "[mcp_servers.loci-research]\n" + "\n".join(
            f"{key} = {json.dumps(value, ensure_ascii=False)}" for key, value in stdio.items()
        ) + "\n"
        with (stage / "codex-config.toml").open("x", encoding="utf-8") as stream:
            os.chmod(stage / "codex-config.toml", 0o600)
            stream.write(codex_config)
            stream.flush()
            os.fsync(stream.fileno())
        approved_request = {key: validated[key] for key in ("source_id", "selection", "recipe")}
        for name, document in (
            ("mcp-config.json", config),
            ("approved-request.json", approved_request),
        ):
            with (stage / name).open("x", encoding="utf-8") as stream:
                os.chmod(stage / name, 0o600)
                json.dump(document, stream, indent=2, allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        instructions = (
            "Loci local MCP access\n\n"
            "Claude Desktop: merge the loci-research entry from mcp-config.json into the "
            "mcpServers object in your Developer > Edit Config file; preserve other servers. "
            "Restart Claude Desktop and inspect its connected tools.\n\n"
            "ChatGPT desktop / Codex: in Settings > MCP servers add a STDIO server using "
            "the command, arguments and optional cwd in mcp-config.json, then restart the "
            "server. Alternatively merge codex-config.toml into your Codex config.toml, "
            "preserving existing configuration.\n\n"
            "ChatGPT web and claude.ai do not read this local STDIO configuration. "
            "This bundle does not create a hosted connector or expose a network server.\n\n"
            "Start by asking the assistant to list Loci's granted operations and inspect "
            "the selected source. Use approved-request.json "
            "as the request argument for validate_recipe, preview_recipe or submit_recipe. "
            "Only the enabled operations are permitted. The selected recipe and CPU runtime "
            "are pinned; any threshold change requires a new grant.\n\n"
            "These files are private local configuration. They contain local locations and "
            "selected analysis settings. Connecting a cloud client may disclose the enabled "
            "categories to that provider; processing remains local. Do not upload this folder "
            "as a dataset. Review must be performed in Loci before permitted export.\n\n"
            "To revoke this access, remove agent-policy.json and disconnect the client. "
            "A changed policy or runtime fails closed; create a new bundle to authorize it. "
            "Keep the bundle in this location, or create a new one after moving it.\n"
            "\nSetup documentation (checked 2026-09-08):\n"
            "https://learn.chatgpt.com/docs/extend/mcp\n"
            "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp\n"
        )
        with (stage / "README.txt").open("x", encoding="utf-8") as stream:
            os.chmod(stage / "README.txt", 0o600)
            stream.write(instructions)
            stream.flush()
            os.fsync(stream.fileno())
        workbench.project.source(source["id"], verify=True)
        _fsync_directory(stage)
        _rename_noreplace(stage, target)
        _fsync_directory(parent)
        return {
            **receipt,
            "recipe_sha256": validated["recipe_sha256"],
            "policy_filename": "agent-policy.json",
            "config_filename": "mcp-config.json",
            "disclosures": sorted(disclosures),
            "operations": sorted(operations),
            "source_id": source["id"],
            "selection": selection,
        }
    finally:
        if stage.exists() and not stage.is_symlink():
            shutil.rmtree(stage)
