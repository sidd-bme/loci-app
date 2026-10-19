"""One authorized analysis journey over the existing durable remote lifecycle.

Plans are read-only. Start pins the complete request and the transfer/retrieval/
attachment authority before the first network write. Advance replays one durable
step; neither reconnection nor a lost submit response creates a new request key.
"""

from __future__ import annotations

import hashlib
from typing import Any

from . import research_remote as remote
from .quantitative import exact_keys
from .research_project import canonical_json, checked_id, parse_json, timestamp

PLAN_SCHEMA = "loci.compute-plan/v1"
AUTHORITY_SCHEMA = "loci.compute-authority/v1"
REQUEST_KEYS = {
    "project_id",
    "alias",
    "request_key",
    "tasks",
    "device",
    "allow_cpu_fallback",
    "rights_basis",
}


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _prepare(workbench, request, *, profile=None):
    exact_keys(request, REQUEST_KEYS, "remote analysis")
    if set(request) != REQUEST_KEYS:
        raise ValueError("Remote analysis requires every explicit execution setting")
    if request["project_id"] != workbench.project.meta["project_id"]:
        raise PermissionError("The analysis belongs to a different study")
    checked_id(request["request_key"])
    if request["device"] not in {"cpu", "cuda"} or type(request["allow_cpu_fallback"]) is not bool:
        raise ValueError("Choose CPU or CUDA and declare the fallback policy")
    tasks = request["tasks"]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= remote.MAX_REMOTE_TASKS:
        raise ValueError("Choose 1-1000 explicit analysis tasks")
    if profile is None:
        profile = remote._load_profile(workbench.project, request["alias"])
    sources, remote_tasks = {}, []
    for index, task in enumerate(tasks):
        exact_keys(task, {"operation", "source", "request"}, "analysis task")
        binding, body = task.get("source"), task.get("request")
        exact_keys(binding, {"id", "sha256"}, "analysis source")
        source = workbench.project.source(binding.get("id"), verify=True)
        if source["sha256"] != binding.get("sha256"):
            raise ValueError("The source changed after the displayed analysis was chosen")
        if not isinstance(body, dict) or body.get("source_id") != source["id"]:
            raise ValueError("The task must match its displayed source identity")
        sources[source["id"]] = source
        task_id = _digest([request["request_key"], index])[:32]
        if task.get("operation") == "run_recipe":
            exact_keys(body, {"source_id", "selection", "recipe"}, "analysis recipe")
            validated = workbench.validate_recipe(body)
            remote_tasks.append(
                {
                    "task_id": task_id,
                    **{key: validated[key] for key in ("source_id", "selection", "recipe")},
                }
            )
        elif task.get("operation") == "cellpose_run":
            from .cellpose_backend import CELLPOSE_PACKAGE_VERSION, resolve_cellpose_model_spec
            from .research_cellpose import _REQUEST_KEYS, _measurement_channels, _settings

            exact_keys(body, _REQUEST_KEYS, "Cellpose analysis")
            if set(body) != _REQUEST_KEYS:
                raise ValueError("Cellpose analysis requires every native setting")
            spec = resolve_cellpose_model_spec(body["profile_id"])
            settings = {**body["settings"], "device": request["device"]}
            _settings(settings)
            channels = workbench.channel_metadata(source["id"])["channels"]
            measurement = _measurement_channels(body["measurement_channels"], len(channels))
            remote_tasks.append(
                {
                    "task_id": task_id,
                    "operation": "run_cellpose",
                    "source_id": source["id"],
                    "selection": body["selection"],
                    "cellpose": {
                        "profile_id": spec.profile_id,
                        "package_version": CELLPOSE_PACKAGE_VERSION,
                        "artifact_id": spec.artifact_id,
                        "model_sha256": spec.sha256,
                        "model_size_bytes": spec.size_bytes,
                        "requested_device": request["device"],
                        "allow_cpu_fallback": request["allow_cpu_fallback"],
                        "rights_basis": request["rights_basis"],
                        "settings": settings,
                        "measurement_channels": measurement,
                        "gates": [],
                        "working_bytes": body["working_bytes"],
                    },
                }
            )
        else:
            raise ValueError("This compute target currently supports native recipes and Cellpose")
    has_model = any(task.get("operation") == "run_cellpose" for task in remote_tasks)
    if not has_model and (
        request["device"] != "cpu"
        or request["allow_cpu_fallback"]
        or request["rights_basis"] is not None
    ):
        raise ValueError(
            "Classical analysis requires CPU without model rights or fallback settings"
        )
    stage = {
        "alias": request["alias"],
        "request_key": request["request_key"],
        "sources": [{"source_id": identity} for identity in sources],
        "tasks": remote_tasks,
        "transfer_authority": {
            "approved": True,
            "scope": remote.TRANSFER_SCOPE,
            "destination_alias": request["alias"],
            "source_ids": list(sources),
        },
    }
    connection = remote._profile_from_data(profile["data"])
    identity, _, _, _, _ = remote._build_remote_request(
        workbench, connection, remote._resource(profile["data"]["resources"]), stage
    )
    # The public plan contains exact source metadata and no machine paths.
    plan = {
        "schema": PLAN_SCHEMA,
        "alias": request["alias"],
        "request_key": request["request_key"],
        "profile_sha256": remote._profile_sha256(profile),
        "profile_revision": profile["revision"],
        "request_sha256": identity.request_sha256,
        "resources": profile["data"]["resources"],
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "name": source["name"],
                "size_bytes": source["size_bytes"],
            }
            for source in sources.values()
        ],
        "transfer_bytes": sum(source["size_bytes"] for source in sources.values()),
        "transfer_scope": "whole-registered-files",
        "task_count": len(tasks),
        "device": request["device"],
        "allow_cpu_fallback": request["allow_cpu_fallback"],
        "rights_basis": request["rights_basis"],
        "models": [task["cellpose"] for task in remote_tasks if "cellpose" in task],
    }
    # Readiness timestamp/revision changes do not alter a previously accepted plan.
    plan["plan_sha256"] = _digest(
        {key: value for key, value in plan.items() if key != "profile_revision"}
    )
    return plan, stage


def plan_analysis(workbench, request):
    plan, _ = _prepare(workbench, request)
    return {"plan": plan}


def start_analysis(workbench, request):
    exact_keys(
        request,
        {
            "analysis",
            "plan_sha256",
            "transfer_authorized",
            "retrieval_authorized",
            "attachment_authorized",
        },
        "analysis authorization",
    )
    if any(
        request.get(key) is not True
        for key in ("transfer_authorized", "retrieval_authorized", "attachment_authorized")
    ):
        raise PermissionError(
            "Starting a remote analysis requires transfer, retrieval and attachment authority"
        )
    analysis = request.get("analysis")
    exact_keys(analysis, REQUEST_KEYS, "remote analysis")
    if analysis.get("project_id") != workbench.project.meta["project_id"]:
        raise PermissionError("The analysis belongs to a different study")
    checked_id(analysis.get("request_key"))
    existing = [
        item
        for item in remote._runs(workbench.project)
        if item["data"]["request_key"] == analysis["request_key"]
    ]
    profile = None
    if existing:
        if len(existing) != 1:
            raise remote.ResearchRemoteError("Remote request key is ambiguous in this study")
        saved = existing[0]["data"]
        authority = saved.get("automation") or {}
        if authority.get("analysis_sha256") != _digest(analysis) or authority.get(
            "plan_sha256"
        ) != request.get("plan_sha256"):
            raise PermissionError("This request key already binds a different analysis authority")
        remote._request_bytes(saved)
        profile = remote._profile_for_run(workbench.project, saved)
        if saved["state"] not in {"prepared", "staged"} or saved["cancel_requested"]:
            return {"run": remote._public_run(existing[0])}
    plan, stage = _prepare(workbench, analysis, profile=profile)
    if request.get("plan_sha256") != plan["plan_sha256"]:
        raise ValueError(
            "The compute plan changed; inspect the new source, target and method scope"
        )
    authority = {
        "schema": AUTHORITY_SCHEMA,
        "plan_sha256": plan["plan_sha256"],
        "analysis": parse_json(canonical_json(request["analysis"])),
        "analysis_sha256": _digest(request["analysis"]),
        "stage_request": stage,
        "stage_sha256": _digest(stage),
        "transfer_authorized": True,
        "retrieval_authorized": True,
        "attachment_authorized": True,
        "granted_at": timestamp(),
    }
    staged = remote._stage(
        workbench, stage, automation=authority, expected_profile_sha256=plan["profile_sha256"]
    )
    if staged["run"]["state"] != "staged":
        return staged
    return remote._submit(workbench, {"alias": stage["alias"], "request_key": stage["request_key"]})


def advance_analysis(workbench, request):
    request = _bound_run_request(workbench, request)
    alias, key = remote._run_request(request)
    envelope = remote._load_run(workbench.project, key)
    data = envelope["data"]
    authority = data.get("automation")
    if (
        data["alias"] != alias
        or not isinstance(authority, dict)
        or authority.get("schema") != AUTHORITY_SCHEMA
    ):
        raise PermissionError("This run has no matching automatic analysis authority")
    if any(
        authority.get(field) is not True
        for field in ("transfer_authorized", "retrieval_authorized", "attachment_authorized")
    ):
        raise PermissionError("The saved analysis authority is incomplete")
    if (
        _digest(authority["analysis"]) != authority["analysis_sha256"]
        or _digest(authority["stage_request"]) != authority["stage_sha256"]
        or authority["analysis"]["project_id"] != workbench.project.meta["project_id"]
        or authority["analysis"]["alias"] != alias
        or authority["analysis"]["request_key"] != key
    ):
        raise PermissionError("The saved automatic analysis no longer matches this run")
    remote._request_bytes(data)
    profile = remote._profile_for_run(workbench.project, data)
    if data["state"] in {"attached", "cleaned", "cancelled"} or (
        data["state"] == "failed" and not data["cancel_requested"]
    ):
        return {"run": remote._public_run(envelope)}
    if data["cancel_requested"]:
        # A cancellation request is not a scheduler outcome. Keep reconciling
        # the exact job, and retry a lost cancellation response without ever
        # restoring retrieval/attachment authority.
        if data["remote_state"] not in {"finished", "failed"}:
            remote._status(workbench, request)
        current = remote._load_run(workbench.project, key)
        if current["data"]["remote_state"] in {"finished", "failed"}:
            settled = remote._put(
                workbench.project,
                current,
                {
                    **current["data"],
                    "state": "cancelled",
                    "cancel_confirmed_at": timestamp(),
                    "updated_at": timestamp(),
                },
            )
            return {"run": remote._public_run(settled)}
        if not current["data"].get("cancel_sent_at") and current["data"]["remote_state"] in {
            "submitted",
            "queued",
            "running",
        }:
            return remote._cancel(workbench, request)
        return {"run": remote._public_run(current)}
    if data["state"] == "prepared":
        # Source bytes are checked again before replaying an unfinished transfer.
        # Once staged, status/recovery remains available with a detached source disk;
        # attachment independently verifies the original source before publication.
        plan, stage = _prepare(workbench, authority["analysis"], profile=profile)
        if (
            plan["plan_sha256"] != authority["plan_sha256"]
            or plan["request_sha256"] != data["request_sha256"]
        ):
            raise PermissionError("The saved analysis changed before transfer recovery")
        return remote._stage(
            workbench, stage, automation=authority, expected_profile_sha256=plan["profile_sha256"]
        )
    if data["state"] == "staged":
        return remote._submit(workbench, request)
    if data["state"] == "finished":
        return remote._retrieve(workbench, {**request, "transfer_authorized": True})
    if data["state"] == "retrieved":
        return remote._attach(workbench, request)
    return remote._status(workbench, request)


def _bound_run_request(workbench, request):
    exact_keys(request, {"project_id", "alias", "request_key"}, "analysis run")
    if request.get("project_id") != workbench.project.meta["project_id"]:
        raise PermissionError("The analysis belongs to a different study")
    return {key: request[key] for key in ("alias", "request_key")}


def cancel_analysis(workbench, request):
    bound = _bound_run_request(workbench, request)
    envelope = remote._load_run(workbench.project, bound["request_key"])
    data = envelope["data"]
    if data["alias"] != bound["alias"]:
        raise PermissionError("The analysis belongs to a different compute target")
    if data["state"] == "cancelled":
        return {"run": remote._public_run(envelope)}
    if data["state"] in {"prepared", "finished", "retrieved"}:
        # No active scheduler job needs terminating in these states. Retain
        # transferred/cache artifacts, but revoke further submission/attachment.
        updated = remote._put(
            workbench.project,
            envelope,
            {
                **data,
                "cancel_requested": True,
                "state": "cancelled",
                "cancel_confirmed_at": timestamp(),
                "updated_at": timestamp(),
            },
        )
        return {"run": remote._public_run(updated)}
    if data["state"] == "staged" and data["remote_job_id"] is None:
        raise remote.ResearchRemoteError(
            "Submission is being reconciled. "
            "Cancel after the saved scheduler identity is recovered."
        )
    return remote._cancel(workbench, bound)


def execute_compute(workbench, operation: str, request: dict[str, Any]):
    return {
        "analysis_plan": plan_analysis,
        "analysis_start": start_analysis,
        "analysis_advance": advance_analysis,
        "analysis_cancel": cancel_analysis,
    }[operation](workbench, request)
