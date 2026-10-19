"""Source-, revision- and resource-bound access to shared native actions."""

from __future__ import annotations

from typing import Any

from .agent_policy import DISCLOSURES, AgentPolicy
from .quantitative import DEFAULT_WORKING_BYTES, exact_keys, integer
from .research_action_registry import READ_ACTIONS, REQUESTS, TASK_ACTIONS
from .research_project import canonical_json, parse_json
from .workbench import Workbench, result_working_bytes, runtime_record

MAX_REQUEST_BYTES = 1024**2


def source_scope(policy, workbench, source_id, selection, channels):
    grant = policy.source_grant(workbench.project, source_id)
    resolved = workbench.selection(source_id, selection)
    if not isinstance(channels, list) or any(type(value) is not int for value in channels):
        raise ValueError("Action measurement channels must be explicit integer indices")
    if not grant.allows(resolved, channels):
        raise PermissionError("Action source selection or measurement channels exceed the grant")
    return resolved


def recipe_scope(policy: AgentPolicy, workbench: Workbench, request: dict[str, Any]):
    """Authorize every raw/reference input before accepting a normalized recipe."""
    policy.source_grant(workbench.project, request.get("source_id"))
    raw_recipe = request.get("recipe", {})
    if not isinstance(raw_recipe, dict):
        raise ValueError("Action recipe must be an object")
    references = raw_recipe.get("references", {})
    if not isinstance(references, dict):
        raise ValueError("Recipe references must be explicit bindings")
    for reference in references.values():
        if not isinstance(reference, dict):
            raise ValueError("Recipe reference is invalid")
        policy.source_grant(workbench.project, reference.get("source_id"))
    normalized = workbench.validate_recipe(request)
    recipe = normalized["recipe"]
    source_scope(
        policy,
        workbench,
        normalized["source_id"],
        normalized["selection"],
        recipe["measurement_channels"],
    )
    for reference in recipe.get("references", {}).values():
        source_scope(policy, workbench, reference["source_id"], reference["selection"], [])
    if recipe["working_bytes"] > policy.memory_bytes:
        raise PermissionError("Action working-memory budget exceeds the policy")
    policy.require_runtime(runtime_record())
    return normalized


def authorize_action(
    agent, workbench: Workbench, operation: str, request: Any, *, mode: str | None = None
):
    policy = agent.policy
    policy.recheck()
    if (
        not isinstance(operation, str)
        or operation not in policy.actions
        or operation not in REQUESTS
    ):
        raise PermissionError("The delegated policy does not allow this research action")
    if (
        mode == "read"
        and operation not in READ_ACTIONS
        or mode == "task"
        and operation not in TASK_ACTIONS
    ):
        raise ValueError("Choose the inspection or durable-task tool declared by the action guide")
    for disclosure in DISCLOSURES:
        policy.require_disclosure(disclosure)
    encoded = canonical_json(request)
    if len(encoded.encode()) > MAX_REQUEST_BYTES:
        raise ValueError("Action request exceeds its bounded payload")
    request = parse_json(encoded)
    contract = REQUESTS[operation]
    exact_keys(request, set(contract["properties"]), operation)
    if not set(contract["required"]) <= set(request):
        raise ValueError("Action request is missing required fields from its schema")
    budget = min(DEFAULT_WORKING_BYTES, policy.memory_bytes)
    if "working_bytes" in contract["properties"]:
        budget = integer(
            request.get("working_bytes", budget),
            "action working bytes",
            1024**2,
            policy.memory_bytes,
        )
        request["working_bytes"] = budget
    bound = None

    def result_binding(binding):
        if not isinstance(binding, dict):
            raise ValueError("Action requires an exact result binding")
        result = agent._authorize_result(workbench, binding.get("result_id"))
        if result["revision_hash"] != binding.get("revision_hash"):
            raise PermissionError("Action result revision changed; inspect it again")
        return result

    if "result_id" in request:
        bound = result_binding(request)
    if operation == "run_recipe":
        normalized = recipe_scope(policy, workbench, request)
        request = {key: normalized[key] for key in ("source_id", "selection", "recipe")}
    elif operation in {
        "puncta_run",
        "colocalisation_run",
        "large_components_run",
        "large_components_preflight",
    }:
        source_id = request["source_id"]
        policy.source_grant(workbench.project, source_id)
        selection = workbench.selection(source_id, request.get("selection"))
        channels = [selection["c"]]
        if operation == "colocalisation_run":
            channels = [request["first_channel"], request["second_channel"]]
            for channel in channels:
                source_scope(policy, workbench, source_id, {**selection, "c": channel}, [channel])
            selection["c"] = request["first_channel"]
        request["selection"] = source_scope(policy, workbench, source_id, selection, channels)
        if operation == "puncta_run":
            from .research_quantification import _puncta_settings

            _puncta_settings(request)
        elif operation.startswith("large_components"):
            from .research_large import preflight

            preflight(workbench, request, check=policy.recheck)
    elif operation == "associate_results":
        result_binding(request["nuclei"])
        cells = result_binding(request["cells"])
        if "measurement_channels" in request:
            source_scope(
                policy,
                workbench,
                cells["source_id"],
                cells["provenance"]["selection"],
                request["measurement_channels"],
            )
    elif operation == "track_results":
        frames = request.get("frames")
        if not isinstance(frames, list) or not 2 <= len(frames) <= 1000:
            raise ValueError("Tracking requires 2-1000 explicit frames")
        observed = 0
        for frame in frames:
            if not isinstance(frame, dict):
                raise ValueError("Tracking frame must be an object")
            if frame.get("result_id") is not None:
                result_binding(frame)
                observed += 1
            else:
                exact_keys(frame, {"frame_id", "time_s", "missing_reason"}, "missing frame")
        if observed < 2:
            raise ValueError("Tracking requires at least two observed result frames")
    if bound is not None:
        provenance = bound["provenance"]
        if operation == "roi_add" and not (
            provenance.get("stain_separation") or provenance.get("derived_measurement_arrays")
        ):
            source_scope(
                policy,
                workbench,
                bound["source_id"],
                provenance["selection"],
                request["measurement_channels"],
            )
        if (
            operation in {"correct_result", "roi_add", "correction_info"}
            and bound.get("schema") == "loci.research-result/v2"
        ):
            raise ValueError("Use large-result actions for a chunked result")
        if operation in {"correct_result", "roi_add"}:
            request["working_bytes"] = min(
                request.get("working_bytes", result_working_bytes(bound)), policy.memory_bytes
            )
        if operation in {"correct_result", "roi_add", "correct_tracks", "correction_info"}:
            total_bytes = sum(item.get("bytes", 0) for item in bound["arrays"].values())
            if total_bytes > budget // 4:
                raise PermissionError(
                    "Result arrays exceed the delegated inspection or editing budget"
                )
        if operation == "large_result_delete" and policy.memory_bytes < 256 * 1024**2:
            raise PermissionError("Large-result editing requires a 256 MiB working allowance")
    if operation in TASK_ACTIONS:
        policy.require_runtime(runtime_record())
    policy.recheck()
    return request


def inspect_action(agent, workbench, operation, request):
    """Run only in the disposable read worker, after independent authorization."""
    request = authorize_action(agent, workbench, operation, request, mode="read")
    output = workbench.execute(operation, request)
    if operation == "correction_info":
        result = agent._authorize_result(workbench, request["result_id"])
        if not result["provenance"].get("derived_measurement_arrays") and not result[
            "provenance"
        ].get("stain_separation"):
            grant = agent.policy.sources[result["source_id"]]
            allowed = set(grant.c) | set(grant.measurement_channels)
            output["measurement_channels"] = [
                item for item in output["measurement_channels"] if item["index"] in allowed
            ]
    authorize_action(agent, workbench, operation, request, mode="read")
    return output
