"""Create a private, bounded MCP access bundle from the trusted desktop UI."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .agent_plugin import plugin_documents
from .agent_policy import DISCLOSURES, write_policy
from .export import _fsync_directory, _rename_noreplace
from .quantitative import exact_keys, finite_number
from .research_process import research_command
from .workbench import Workbench, runtime_record


def _whole_source_grants(workbench, scope, selected_source):
    exact_keys(scope, {"mode", "sources"}, "agent source scope")
    bindings = scope.get("sources")
    if (
        scope.get("mode") != "study-sources"
        or not isinstance(bindings, list)
        or not 1 <= len(bindings) <= 1000
    ):
        raise ValueError("Choose an explicit snapshot of 1-1000 study sources")
    grants, seen = [], set()
    for binding in bindings:
        exact_keys(binding, {"id", "sha256"}, "source binding")
        source = workbench.project.source(binding.get("id"), verify=True)
        if source["id"] in seen or source["sha256"] != binding.get("sha256"):
            raise ValueError("The chosen study source identities changed or are duplicated")
        seen.add(source["id"])
        if source.get("source_kind") in {"native", "whole_slide", "ome_zarr"}:
            metadata = workbench.inspect(source["id"])["metadata"]
            dimensions = metadata["dimensions"]
            levels = len(metadata["levels"])
        else:
            shape = source["metadata"]["shape"]
            dimensions = {
                "x": shape[-1],
                "y": shape[-2],
                "z": shape[0] if len(shape) == 3 else 1,
                "t": 1,
                "c": 1,
            }
            levels = 1
        if any(not 1 <= dimensions[axis] <= 4096 for axis in ("c", "z", "t")):
            raise ValueError(
                "Whole-source access supports at most 4096 indices per C/Z/T axis; "
                "choose a bounded source region"
            )
        grants.append(
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {"x": 0, "y": 0, "width": dimensions["x"], "height": dimensions["y"]},
                "t": list(range(dimensions["t"])),
                "c": list(range(dimensions["c"])),
                "z": list(range(dimensions["z"])),
                "level": list(range(levels)),
                "measurement_channels": list(range(dimensions["c"])),
            }
        )
    if selected_source not in seen:
        raise ValueError("The selected analysis source must belong to the chosen study scope")
    return grants


def _interactive_grants(
    workbench: Workbench, request: dict[str, Any], validated: dict[str, Any]
) -> dict[str, Any] | None:
    if "interactive" not in request:
        return None
    value = request["interactive"]
    expected = {
        "allow_image",
        "allow_display",
        "allow_handoff",
        "channels",
        "handoff_names",
        "parameters",
    }
    exact_keys(value, expected, "interactive agent access")
    if set(value) != expected:
        raise ValueError("Interactive access requires every explicit permission and range")
    for name in ("allow_image", "allow_display", "allow_handoff"):
        if not isinstance(value[name], bool):
            raise ValueError("Interactive operation grants must be boolean")
    channels = value["channels"]
    if (
        not isinstance(channels, list)
        or len(channels) > 16
        or any(isinstance(c, bool) or not isinstance(c, int) for c in channels)
        or channels != sorted(set(channels))
    ):
        raise ValueError("Interactive channels must be a sorted unique list of at most 16 indices")
    if channels and not any(
        value[name] for name in ("allow_image", "allow_display", "allow_handoff")
    ):
        raise ValueError("Interactive channels require an image, display or handoff grant")
    if not channels and any(
        value[name] for name in ("allow_image", "allow_display", "allow_handoff")
    ):
        raise ValueError("Interactive image or display access requires explicit channels")
    for channel in channels:
        workbench.selection(validated["source_id"], {**validated["selection"], "c": channel})
    names = value["handoff_names"]
    if not isinstance(names, list) or any(
        not isinstance(name, str) or not name.endswith(".loci-vision") for name in names
    ):
        raise ValueError("Vision handoff names must end with .loci-vision")
    if not value["allow_handoff"] and names:
        raise ValueError("Vision handoff names require an explicit handoff grant")
    if value["allow_handoff"] and not names:
        raise ValueError("Vision handoff requires explicit filenames")
    if not isinstance(request["export_names"], list) or any(
        not isinstance(name, str) for name in request["export_names"]
    ):
        raise ValueError("Export names must be an explicit list of filenames")
    combined_names = request["export_names"] + names
    if len(set(combined_names)) != len(combined_names):
        raise ValueError("Export and handoff filenames must be unique")
    parameters = value["parameters"]
    exact_keys(parameters, {"threshold", "min_size"}, "experimental parameters")
    if parameters:
        if not (request["allow_preview"] or request["allow_run"]):
            raise ValueError("Experimental parameters require a preview or run grant")
        segmentation = validated["recipe"].get("segmentation")
        if not isinstance(segmentation, dict):
            raise ValueError("Experimental parameters require a base segmentation recipe")
        for name, bounds in parameters.items():
            exact_keys(bounds, {"min", "max"}, "experimental range")
            if set(bounds) != {"min", "max"}:
                raise ValueError("Experimental ranges require explicit min and max")
            minimum, maximum = (0, 1e20) if name == "min_size" else (-1e30, 1e30)
            try:
                low = finite_number(bounds["min"], "range minimum", minimum, maximum)
                high = finite_number(bounds["max"], "range maximum", minimum, maximum)
                if low > high:
                    raise ValueError("Experimental minimum must not exceed maximum")
                finite_number(segmentation.get(name), "base parameter", low, high)
            except OverflowError as exc:
                raise ValueError("Experimental ranges must be finite bounded numbers") from exc
    disclosures = set(request["disclosures"])
    metadata = {"geometry", "provenance", "agent_metadata"}
    if value["allow_image"] and "previews" not in disclosures:
        raise ValueError("Image access requires explicit previews disclosure")
    if value["allow_display"] and not metadata <= disclosures:
        raise ValueError("Display access requires geometry, provenance and agent_metadata")
    if value["allow_handoff"] and not metadata | {"previews"} <= disclosures:
        raise ValueError(
            "Vision handoff requires previews, geometry, provenance and agent_metadata"
        )
    if parameters and not metadata <= disclosures:
        raise ValueError("Experimental parameters require geometry, provenance and agent_metadata")
    return value


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
    optional = {"interactive", "delegation", "actions", "source_scope", "export_scope"}
    exact_keys(request, expected | optional, "agent access")
    if set(request) - optional != expected:
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
    interactive = _interactive_grants(workbench, request, validated)
    delegation = request.get("delegation")
    if "delegation" in request:
        delegation_keys = {"client_id", "expires_at", "result_scope", "allow_review"}
        exact_keys(delegation, delegation_keys, "agent delegation")
        if set(delegation) != delegation_keys or type(delegation["allow_review"]) is not bool:
            raise ValueError(
                "Delegation requires a client, expiry, result scope and explicit review permission"
            )
        if "agent_metadata" not in disclosures:
            raise ValueError("Delegation requires analysis context disclosure")
    actions = request.get("actions", [])
    if not isinstance(actions, list) or any(not isinstance(item, str) for item in actions):
        raise ValueError("Research actions must be an explicit list")
    if actions:
        from .research_action_registry import ACTION_NAMES, TASK_ACTIONS

        if len(set(actions)) != len(actions) or not set(actions) <= ACTION_NAMES:
            raise ValueError("Choose unique supported research actions")
        if (
            delegation is None
            or delegation["result_scope"] != "granted-sources"
            or not set(disclosures) >= DISCLOSURES
        ):
            raise ValueError(
                "Research actions require source-scoped delegation and all response disclosures"
            )
        if set(actions) & TASK_ACTIONS and not request["allow_run"]:
            raise ValueError("Mutating research actions require explicit run permission")
    export_mode = request.get("export_scope", "listed")
    if export_mode not in {"listed", "directory"}:
        raise ValueError("Choose listed names or new names within the selected export directory")
    if export_mode == "directory" and (delegation is None or not request["allow_export"]):
        raise ValueError("New export names require explicit delegated export permission")
    if "source_scope" in request and delegation is None:
        raise ValueError("Study source access requires an explicit delegation")
    allow_handoff = interactive is not None and interactive["allow_handoff"]
    if request["allow_export"]:
        required = {"geometry", "source_names", "previews", "measurements", "provenance"}
        if not required <= set(disclosures) or export_root is None:
            raise ValueError(
                "Export requires all result disclosures and a chosen local export folder"
            )
        if not request["allow_run"] and delegation is None:
            raise ValueError("Export requires the exact recipe run grant to authorize its result")
    elif request["export_names"]:
        raise ValueError("Export destinations require an explicit export grant")
    if allow_handoff and export_root is None:
        raise ValueError("Vision handoff requires a chosen local export folder")
    if not (request["allow_export"] or allow_handoff) and export_root is not None:
        raise ValueError("Export destinations require an explicit export or handoff grant")
    selection = validated["selection"]
    source = workbench.project.source(validated["source_id"], verify=True)
    operations = ["inspect_source", "validate_recipe"]
    if "agent_metadata" in disclosures:
        operations.append("analysis_context")
    if request["allow_preview"]:
        operations.append("preview_recipe")
    if request["allow_run"]:
        operations.extend(["submit_recipe", "job_status", "cancel_job", "result"])
        if "previews" in disclosures:
            operations.append("result_view")
    if request["allow_export"]:
        operations.append("export_result")
    if interactive is not None:
        if interactive["allow_image"]:
            operations.append("source_image")
        if interactive["allow_display"]:
            operations.extend(["source_display", "set_source_display"])
        if allow_handoff:
            operations.append("export_vision_handoff")
    if delegation is not None:
        operations.extend(["review_history", "study_results"])
        operations.extend(["result", *(["result_view"] if "previews" in disclosures else [])])
        if delegation["allow_review"]:
            operations.append("review_result")
    if actions:
        from .research_action_registry import READ_ACTIONS, TASK_ACTIONS

        operations.append("validate_action")
        if set(actions) & READ_ACTIONS:
            operations.append("inspect_action")
        if set(actions) & TASK_ACTIONS:
            operations.extend(["submit_action", "job_status", "cancel_job"])
    operations = sorted(set(operations))
    runtime = runtime_record()
    specification = {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {key: selection[key] for key in ("x", "y", "width", "height")},
                "t": [selection["t"]],
                "c": sorted({selection["c"], *(interactive["channels"] if interactive else [])}),
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
        "export": {
            "root": str(export_root),
            "filenames": request["export_names"]
            + (interactive["handoff_names"] if interactive else []),
        }
        if request["allow_export"] or allow_handoff
        else None,
        "limits": limits,
        "disclosures": disclosures,
    }
    if interactive is not None:
        specification["remote_grants"] = []
        specification["experimental_recipes"] = (
            [
                {
                    "key": "interactive-recipe",
                    **{key: validated[key] for key in ("source_id", "selection", "recipe")},
                    "parameters": interactive["parameters"],
                    "preview": request["allow_preview"],
                    "run": request["allow_run"],
                }
            ]
            if interactive["parameters"]
            else []
        )
    if delegation is not None:
        specification.setdefault("remote_grants", [])
        specification.setdefault("experimental_recipes", [])
        specification["delegation"] = {
            "id": uuid.uuid4().hex,
            **{key: delegation[key] for key in ("client_id", "expires_at", "result_scope")},
        }
        specification["actions"] = actions
        if specification["export"] is not None:
            specification["export"]["filename_mode"] = export_mode
        if "source_scope" in request:
            specification["sources"] = _whole_source_grants(
                workbench, request["source_scope"], source["id"]
            )
    include_plugin = interactive is not None or delegation is not None
    target = Path(destination).expanduser()
    if not target.is_absolute() or target.is_symlink() or target.exists():
        raise ValueError("Choose an absent absolute directory for the agent access bundle")
    parent = target.parent.resolve(strict=True)
    parent_stat = parent.stat()
    target = parent / target.name
    stage = Path(tempfile.mkdtemp(prefix=".loci-agent-access-", dir=parent))
    os.chmod(stage, 0o700)
    stage_stat = stage.lstat()
    bundle_directories = {stage}
    try:
        receipt = write_policy(stage / "agent-policy.json", workbench.project, specification)
        command = research_command(["mcp", "--policy", str(target / "agent-policy.json")])
        config = {"mcpServers": {"loci-research": {"command": command[0], "args": command[1:]}}}
        # A source checkout needs a deterministic import directory; frozen workers do not.
        if "-m" in command:
            config["mcpServers"]["loci-research"]["cwd"] = str(Path(__file__).resolve().parents[2])
        stdio = config["mcpServers"]["loci-research"]
        if include_plugin:
            for name, body in plugin_documents(stdio, receipt["policy_sha256"]).items():
                path = stage / name
                missing = []
                directory = path.parent
                while directory != stage and not directory.exists():
                    missing.append(directory)
                    directory = directory.parent
                for directory in reversed(missing):
                    directory.mkdir(mode=0o700)
                    os.chmod(directory, 0o700)
                    bundle_directories.add(directory)
                with path.open("x", encoding="utf-8") as stream:
                    os.fchmod(stream.fileno(), 0o600) if hasattr(os, "fchmod") else os.chmod(
                        path, 0o600
                    )
                    stream.write(body)
                    stream.flush()
                    os.fsync(stream.fileno())
                _fsync_directory(path.parent)
        codex_config = (
            "[mcp_servers.loci-research]\n"
            + "\n".join(
                f"{key} = {json.dumps(value, ensure_ascii=False)}" for key, value in stdio.items()
            )
            + "\n"
        )
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
            "Local Codex host (desktop app, CLI or IDE): configure a STDIO MCP server using "
            "the command, arguments and optional cwd in mcp-config.json, then restart the "
            "server. Alternatively merge codex-config.toml into your Codex config.toml, "
            "preserving existing configuration.\n\n"
            "ChatGPT web and claude.ai do not read this local STDIO configuration. "
            "This bundle does not create a hosted connector or expose a network server.\n\n"
            "Start by asking the assistant to list Loci's granted operations and inspect "
            "the selected source. recipe_guide (or loci://guides/recipes) explains request "
            "fields and units without reading study data. If agent_metadata was explicitly "
            "selected for this bundle, analysis_context (or loci://context) lists bounded "
            "pages of permitted source handles, recipe hashes and resource limits. Names "
            "and geometry still require their independent disclosures. Follow next_offset "
            "with the analysis_context tool for later pages. Use approved-request.json "
            "as the request argument for validate_recipe, preview_recipe or submit_recipe. "
            "Only enabled operations are permitted. The CPU runtime and source scope are pinned. "
            "Without named action grants, changes require an explicit experimental recipe range. "
            "For named study actions, consult action_guide and analysis_context; input scopes, "
            "revision checks and resource limits still apply.\n\n"
            "These files are private local configuration. They contain local locations and "
            "selected analysis settings. Connecting a cloud client may disclose the enabled "
            "categories to that provider; processing remains local. Do not upload this folder "
            "as a dataset. Reviewed export requires a revision-bound review receipt. "
            "A permitted vision handoff exports image/context only and does not imply review.\n\n"
            "To revoke this access, remove agent-policy.json and disconnect the client. "
            "A changed policy or runtime fails closed; create a new bundle to authorize it. "
            "Keep the bundle in this location, or create a new one after moving it.\n"
            "\nOpenAI setup documentation (checked 2026-10-07):\n"
            "https://learn.chatgpt.com/docs/extend/mcp\n"
            "https://developers.openai.com/plugins/build/plugins\n"
        )
        if delegation is not None:
            instructions += (
                "\nDelegated result access\n\n"
                f"Declared client: {delegation['client_id']}. "
                f"Result scope: {delegation['result_scope']}. "
                f"Expiry: {delegation['expires_at'] or 'until revoked'}. "
                + (
                    "This policy explicitly permits agent review. Read the current history, "
                    "inspect the exact result revision, and record your reason and actual "
                    "coverage with its current review digest. Agent decisions remain labelled "
                    "agent decisions; a researcher may supersede them without deleting history.\n"
                    if delegation["allow_review"]
                    else "Review history is readable, but this policy does not permit approval.\n"
                )
            )
        if include_plugin:
            instructions += (
                "\nLocal Loci analysis plugin\n\n"
                "plugin/ contains a portable plugin manifest, stdio MCP configuration and "
                "loci-analysis workflow skill. .agents/plugins/marketplace.json makes this "
                "bundle a local marketplace root. Add this folder with `codex plugin "
                "marketplace add /absolute/path/to/this/bundle`, then use the supported "
                "desktop plugin directory or Codex CLI /plugins browser to install Loci "
                "analysis from this local source. Start a new session and inspect its "
                "catalog/context to verify the actual connection. This bundle does not "
                "install or enable a client plugin. Choose either the plugin connection "
                "or the manual MCP configuration to avoid duplicate server sessions.\n\n"
                "The plugin pins this bundle's policy path and worker command. Keep the "
                "policy here even if a client copies plugin/ into its cache. Revocation "
                "still removes the original agent-policy.json. A new bundle has a distinct "
                "marketplace identity; disconnect the old access before replacing it.\n\n"
                "For ChatGPT web, export a permitted .loci-vision handoff locally, then "
                "explicitly upload only chosen image/context artifacts in your browser "
                "and choose your available model. Local stdio is not a hosted connector; "
                "no model availability or subscription-to-API bridge is supplied.\n\n"
                "Exact local installation commands:\n"
                f"codex plugin marketplace add {shlex.quote(str(target))}\n"
                f"codex plugin add loci-analysis@loci-local-{receipt['policy_sha256'][:12]}\n"
            )
        with (stage / "README.txt").open("x", encoding="utf-8") as stream:
            os.chmod(stage / "README.txt", 0o600)
            stream.write(instructions)
            stream.flush()
            os.fsync(stream.fileno())
        for grant in specification["sources"]:
            current_source = workbench.project.source(grant["id"], verify=True)
            if current_source["sha256"] != grant["sha256"]:
                raise ValueError("An authorized source changed before grant publication")
        for directory in sorted(bundle_directories, key=lambda path: len(path.parts), reverse=True):
            _fsync_directory(directory)
        current_parent = parent.lstat()
        if parent.is_symlink() or (current_parent.st_dev, current_parent.st_ino) != (
            parent_stat.st_dev,
            parent_stat.st_ino,
        ):
            raise ValueError("Agent access parent directory changed before publication")
        current_stage = stage.lstat()
        if stage.is_symlink() or (current_stage.st_dev, current_stage.st_ino) != (
            stage_stat.st_dev,
            stage_stat.st_ino,
        ):
            raise ValueError("Agent access staging directory changed before publication")
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
            **({"plugin_filename": "plugin/plugin.json"} if include_plugin else {}),
            **({"delegation": specification["delegation"]} if delegation is not None else {}),
            **(
                {
                    "actions": actions,
                    "sources": [
                        {"id": grant["id"], "sha256": grant["sha256"]}
                        for grant in specification["sources"]
                    ],
                    "export_scope": export_mode,
                }
                if delegation is not None
                else {}
            ),
        }
    finally:
        if stage.exists() and not stage.is_symlink():
            current_stage = stage.lstat()
            if (current_stage.st_dev, current_stage.st_ino) == (
                stage_stat.st_dev,
                stage_stat.st_ino,
            ):
                shutil.rmtree(stage)
