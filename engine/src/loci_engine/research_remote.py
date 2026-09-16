"""Durable, policy-shaped remote recipe workflow for the research workbench.

This service exposes named lifecycle operations only. Connection paths and exact
worker request bytes remain in private project documents; renderer-facing return
values contain stable aliases, identities, states, and relative artifact names.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .remote_compute import (
    ConnectionProfile,
    ConnectionReceipt,
    RemoteCellposeTask,
    RemoteCleanupReceipt,
    RemoteComputeClient,
    RemoteJobIdentity,
    RemoteJobStatus,
    RemoteRecipeTask,
    RemoteRequest,
    RemoteSource,
    RemoteWorkerRequest,
    ResourceRequest,
    StageEntry,
    StagingManifest,
    VerifiedOutputManifest,
)
from .research_project import ResearchProject, canonical_json, checked_id, parse_json, timestamp
from .research_remote_results import attach_remote_results
from .workbench import Workbench
from .working_result import _sha256_file_stable

PROFILE_SCHEMA = "loci.remote-profile/v1"
RUN_SCHEMA = "loci.remote-run-state/v1"
TRANSFER_SCOPE = "remote-run-recipe"
DOCUMENT_KIND = "policy"
MAX_REMOTE_PROFILES = 32
MAX_REMOTE_TASKS = 1_000
_HEX32 = re.compile(r"^[a-f0-9]{32}$")
_REMOTE_JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,127}$")
_SAFE_SUFFIX = re.compile(r"^(?:\.[A-Za-z0-9]{1,12}){1,2}$")

REMOTE_OPERATION_CATALOG = {
    "profile_save": {"mutates": True, "summary": "Save one fixed private SSH profile"},
    "profile_list": {"mutates": False, "summary": "List redacted saved profiles"},
    "profile_test": {"mutates": True, "summary": "Test and record pinned host readiness"},
    "readiness": {"mutates": True, "summary": "Prepare roots and verify fixed worker runtime"},
    "run_list": {"mutates": False, "summary": "List resumable redacted remote runs"},
    "stage": {"mutates": True, "summary": "Authorize and stage exact local source bytes"},
    "submit": {"mutates": True, "summary": "Idempotently submit a staged request"},
    "status": {"mutates": True, "summary": "Refresh one exact remote job identity"},
    "cancel": {"mutates": True, "summary": "Cancel one exact remote job identity"},
    "retrieve": {"mutates": True, "summary": "Retrieve verified derived outputs"},
    "attach": {"mutates": True, "summary": "Strictly attach retrieved remote results"},
    "logs": {"mutates": False, "summary": "Read one bounded redacted owned job log"},
    "remove_owned": {"mutates": True, "summary": "Remove verified owned remote run data"},
}

_PROFILE_SAVE_KEYS = {
    "alias",
    "known_host",
    "known_hosts_file",
    "host_key_sha256",
    "runtime_python",
    "remote_project_root",
    "remote_output_root",
    "scheduler",
    "scheduler_bin_dir",
    "identity_file",
    "queue",
    "account",
    "pbs_gpu_resource",
    "allow_direct_compute",
    "remote_input_roots",
    "connect_timeout_seconds",
    "resources",
    "expected_revision",
}
_RESOURCE_KEYS = {"cpus", "memory_mb", "wall_minutes", "gpus"}
_STAGE_KEYS = {"alias", "request_key", "sources", "tasks", "transfer_authority"}
_STAGE_SOURCE_KEYS = {"source_id"}
_REMOTE_INPUT_KEYS = {"root_index", "relative_path", "source_sha256", "size_bytes"}
_STAGE_TASK_KEYS = {"task_id", "source_id", "selection", "recipe"}
_STAGE_CELLPOSE_TASK_KEYS = {
    "task_id",
    "source_id",
    "selection",
    "operation",
    "cellpose",
}
_AUTHORITY_KEYS = {"approved", "scope", "destination_alias", "source_ids"}

ClientFactory = Callable[[ConnectionProfile], RemoteComputeClient]
_client_factory: ClientFactory = RemoteComputeClient


class ResearchRemoteError(RuntimeError):
    """Raised when a durable remote lifecycle transition is invalid."""


def _exact(value: object, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ResearchRemoteError(f"{name} has unexpected or missing fields")
    return value


def _only(value: object, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - keys:
        raise ResearchRemoteError(f"{name} has unexpected fields")
    return value


def _alias_request(request: object) -> str:
    values = _exact(request, {"alias"}, "Remote profile request")
    alias = values["alias"]
    if not isinstance(alias, str):
        raise ResearchRemoteError("Remote profile alias must be text")
    return alias


def _document_id(namespace: str, identity: str) -> str:
    return hashlib.sha256(f"{namespace}:{identity}".encode()).hexdigest()[:32]


def _profile_id(alias: str) -> str:
    return _document_id("remote-profile", alias)


def _run_id(request_key: str) -> str:
    return _document_id("remote-run", request_key)


def _policy_documents(project: ResearchProject) -> list[dict[str, Any]]:
    return project.documents(DOCUMENT_KIND)


def _profiles(project: ResearchProject) -> list[dict[str, Any]]:
    return [
        envelope
        for envelope in _policy_documents(project)
        if envelope.get("data", {}).get("schema") == PROFILE_SCHEMA
    ]


def _runs(project: ResearchProject) -> list[dict[str, Any]]:
    return [
        envelope
        for envelope in _policy_documents(project)
        if envelope.get("data", {}).get("schema") == RUN_SCHEMA
    ]


def _load_profile(project: ResearchProject, alias: str) -> dict[str, Any]:
    matches = [item for item in _profiles(project) if item["data"].get("alias") == alias]
    if len(matches) != 1:
        raise ResearchRemoteError("Remote profile alias is not uniquely saved in this study")
    return matches[0]


def _load_run(project: ResearchProject, request_key: str) -> dict[str, Any]:
    if not isinstance(request_key, str) or not _HEX32.fullmatch(request_key):
        raise ResearchRemoteError("Remote request_key must be 32 lowercase hexadecimal characters")
    matches = [item for item in _runs(project) if item["data"].get("request_key") == request_key]
    if len(matches) != 1:
        raise ResearchRemoteError("Remote run identity is not uniquely persisted in this study")
    return matches[0]


def _put(
    project: ResearchProject, envelope: dict[str, Any], data: dict[str, Any]
) -> dict[str, Any]:
    try:
        return project.put_document(
            DOCUMENT_KIND,
            envelope["id"],
            data,
            expected_revision=envelope["revision"],
        )
    except (TypeError, ValueError) as exc:
        raise ResearchRemoteError("Remote workflow state changed; reload before retrying") from exc


def _new_document(
    project: ResearchProject, document_id: str, data: dict[str, Any]
) -> dict[str, Any]:
    try:
        return project.put_document(DOCUMENT_KIND, document_id, data, expected_revision=0)
    except (TypeError, ValueError) as exc:
        raise ResearchRemoteError(
            "Remote workflow identity already exists with other inputs"
        ) from exc


def _resource(value: object) -> ResourceRequest:
    values = _exact(value, _RESOURCE_KEYS, "Remote resource policy")
    try:
        resource = ResourceRequest(**values)
        resource.validate()
    except (TypeError, ValueError) as exc:
        raise ResearchRemoteError("Remote resource policy is invalid") from exc
    return resource


def _profile_from_data(data: dict[str, Any]) -> ConnectionProfile:
    profile = data["private_profile"]
    try:
        result = ConnectionProfile(
            alias=data["alias"],
            known_host=profile["known_host"],
            known_hosts_file=Path(profile["known_hosts_file"]),
            host_key_sha256=profile["host_key_sha256"],
            runtime_python=profile["runtime_python"],
            remote_project_root=profile["remote_project_root"],
            remote_output_root=profile["remote_output_root"],
            scheduler=data["scheduler"],
            scheduler_bin_dir=profile["scheduler_bin_dir"],
            identity_file=(Path(profile["identity_file"]) if profile["identity_file"] else None),
            queue=profile["queue"],
            account=profile["account"],
            pbs_gpu_resource=profile["pbs_gpu_resource"],
            allow_direct_compute=profile["allow_direct_compute"],
            remote_input_roots=tuple(profile["remote_input_roots"]),
            connect_timeout_seconds=profile["connect_timeout_seconds"],
        )
        result.validate()
        return result
    except (KeyError, TypeError, ValueError) as exc:
        raise ResearchRemoteError("Stored remote profile is corrupt or no longer valid") from exc


def _public_receipt(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "alias": value["alias"],
        "host_key_sha256": value["host_key_sha256"],
        "operating_system": value["operating_system"],
        "runtime_version": value["runtime_version"],
        "scheduler": value["scheduler"],
        "scheduler_version": value["scheduler_version"],
    }


def _public_profile(envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope["data"]
    return {
        "schema": "loci.remote-profile-public/v1",
        "id": envelope["id"],
        "revision": envelope["revision"],
        "alias": data["alias"],
        "scheduler": data["scheduler"],
        "allow_direct_compute": data["private_profile"]["allow_direct_compute"],
        "remote_input_root_count": len(data["private_profile"]["remote_input_roots"]),
        "resources": data["resources"],
        "connection": _public_receipt(data["connection"]),
        "runtime_ready": data["runtime_ready"],
        "tested_at": data["tested_at"],
        "readiness_checked_at": data["readiness_checked_at"],
    }


def _public_run(envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope["data"]
    return {
        "schema": "loci.remote-run-public/v1",
        "id": envelope["id"],
        "revision": envelope["revision"],
        "request_key": data["request_key"],
        "request_sha256": data["request_sha256"],
        "project_id": data["project_id"],
        "alias": data["alias"],
        "profile_revision": data["profile_revision"],
        "profile_sha256": data["profile_sha256"],
        "scheduler": data["scheduler"],
        "resources": data["resources"],
        "source_ids": data["source_ids"],
        "task_ids": data["task_ids"],
        "transfer_scope": data["transfer_scope"],
        "transfer_authorized_at": data["transfer_authorized_at"],
        "retrieval_authorized_at": data["retrieval_authorized_at"],
        "state": data["state"],
        "remote_job_id": data["remote_job_id"],
        "remote_state": data["remote_state"],
        "status_detail": _redacted_remote_text(data["status_detail"], None, limit=4096)
        if data["status_detail"] is not None
        else None,
        "cancel_requested": data["cancel_requested"],
        "outputs": data["outputs"],
        "attachment": data["attachment"],
        "cleanup_prepared_at": data["cleanup_prepared_at"],
        "cleanup_authorized_at": data["cleanup_authorized_at"],
        "remote_cleanup": data["remote_cleanup"],
        "created_at": data["created_at"],
        "updated_at": data["updated_at"],
    }


def _save_profile(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    values = _exact(request, _PROFILE_SAVE_KEYS, "Remote profile")
    resources = _resource(values["resources"])
    try:
        expected_revision = values["expected_revision"]
        if (
            isinstance(expected_revision, bool)
            or not isinstance(expected_revision, int)
            or expected_revision < 0
        ):
            raise ValueError
        profile = ConnectionProfile(
            alias=values["alias"],
            known_host=values["known_host"],
            known_hosts_file=Path(values["known_hosts_file"]),
            host_key_sha256=values["host_key_sha256"],
            runtime_python=values["runtime_python"],
            remote_project_root=values["remote_project_root"],
            remote_output_root=values["remote_output_root"],
            scheduler=values["scheduler"],
            scheduler_bin_dir=values["scheduler_bin_dir"],
            identity_file=(Path(values["identity_file"]) if values["identity_file"] else None),
            queue=values["queue"],
            account=values["account"],
            pbs_gpu_resource=values["pbs_gpu_resource"],
            allow_direct_compute=values["allow_direct_compute"],
            remote_input_roots=tuple(values["remote_input_roots"]),
            connect_timeout_seconds=values["connect_timeout_seconds"],
        )
        profile.validate()
    except (KeyError, TypeError, ValueError) as exc:
        raise ResearchRemoteError("Remote connection profile is invalid") from exc
    if profile.scheduler == "direct" and not profile.allow_direct_compute:
        raise ResearchRemoteError(
            "Direct research runs require explicit standalone compute-host approval"
        )
    existing = [
        item for item in _profiles(workbench.project) if item["data"]["alias"] == profile.alias
    ]
    if len(existing) > 1 or (
        not existing and len(_profiles(workbench.project)) >= MAX_REMOTE_PROFILES
    ):
        raise ResearchRemoteError("Remote profile set is ambiguous or at its bound")
    now = timestamp()
    data = {
        "schema": PROFILE_SCHEMA,
        "alias": profile.alias,
        "scheduler": profile.scheduler,
        "resources": asdict(resources),
        "private_profile": {
            "known_host": profile.known_host,
            "known_hosts_file": str(profile.known_hosts_file),
            "host_key_sha256": profile.host_key_sha256,
            "runtime_python": profile.runtime_python,
            "remote_project_root": profile.remote_project_root,
            "remote_output_root": profile.remote_output_root,
            "scheduler_bin_dir": profile.scheduler_bin_dir,
            "identity_file": str(profile.identity_file) if profile.identity_file else None,
            "queue": profile.queue,
            "account": profile.account,
            "pbs_gpu_resource": profile.pbs_gpu_resource,
            "allow_direct_compute": profile.allow_direct_compute,
            "remote_input_roots": list(profile.remote_input_roots),
            "connect_timeout_seconds": profile.connect_timeout_seconds,
        },
        "connection": None,
        "runtime_ready": False,
        "tested_at": None,
        "readiness_checked_at": None,
        "created_at": existing[0]["data"]["created_at"] if existing else now,
        "updated_at": now,
    }
    try:
        envelope = workbench.project.put_document(
            DOCUMENT_KIND,
            _profile_id(profile.alias),
            data,
            expected_revision=expected_revision,
        )
    except (TypeError, ValueError) as exc:
        raise ResearchRemoteError("Remote profile revision changed; reload before saving") from exc
    return {"profile": _public_profile(envelope)}


def _list_profiles(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    _exact(request, set(), "Remote profile list")
    return {"profiles": [_public_profile(item) for item in _profiles(workbench.project)]}


def _list_runs(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    _exact(request, set(), "Remote run list")
    return {"runs": [_public_run(item) for item in _runs(workbench.project)]}


def _tested_client(profile_envelope: dict[str, Any]) -> tuple[RemoteComputeClient, dict[str, Any]]:
    profile = _profile_from_data(profile_envelope["data"])
    client = _client_factory(profile)
    receipt = client.test_connection()
    if not isinstance(receipt, ConnectionReceipt) or receipt.alias != profile.alias:
        raise ResearchRemoteError("Remote connection receipt identity is invalid")
    return client, asdict(receipt)


def _test_profile(workbench: Workbench, request: dict[str, Any], *, ready: bool) -> dict[str, Any]:
    envelope = _load_profile(workbench.project, _alias_request(request))
    client, receipt = _tested_client(envelope)
    runtime_ready = False
    if ready:
        client.setup_roots()
        help_text = client.test_runtime()
        if not isinstance(help_text, str) or "remote-worker" not in help_text:
            raise ResearchRemoteError("Configured runtime does not expose the fixed remote worker")
        runtime_ready = True
    now = timestamp()
    data = {
        **envelope["data"],
        "connection": receipt,
        "runtime_ready": runtime_ready if ready else envelope["data"]["runtime_ready"],
        "tested_at": now,
        "readiness_checked_at": now if ready else envelope["data"]["readiness_checked_at"],
        "updated_at": now,
    }
    updated = _put(workbench.project, envelope, data)
    return {"profile": _public_profile(updated)}


def _source_suffix(source: dict[str, Any]) -> str:
    suffix = "".join(Path(source["private_path"]).suffixes[-2:])
    return suffix.lower() if _SAFE_SUFFIX.fullmatch(suffix) else ".bin"


def _validate_authority(value: object, alias: str, source_ids: list[str]) -> None:
    authority = _exact(value, _AUTHORITY_KEYS, "Remote transfer authority")
    approved = authority["approved"]
    approved_sources = authority["source_ids"]
    if (
        approved is not True
        or authority["scope"] != TRANSFER_SCOPE
        or authority["destination_alias"] != alias
        or not isinstance(approved_sources, list)
        or approved_sources != source_ids
        or len(set(approved_sources)) != len(approved_sources)
    ):
        raise ResearchRemoteError("Remote source transfer was not explicitly authorized")


def _build_remote_request(
    workbench: Workbench,
    profile: ConnectionProfile,
    resources: ResourceRequest,
    request: dict[str, Any],
) -> tuple[RemoteRequest, RemoteWorkerRequest, bytes, tuple[StageEntry, ...], list[str]]:
    source_values = request["sources"]
    task_values = request["tasks"]
    if (
        not isinstance(source_values, list)
        or not 1 <= len(source_values) <= MAX_REMOTE_TASKS
        or not isinstance(task_values, list)
        or not 1 <= len(task_values) <= MAX_REMOTE_TASKS
    ):
        raise ResearchRemoteError("Remote source and task lists must be bounded and non-empty")
    selected_sources: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    source_ids: list[str] = []
    for value in source_values:
        selected = _only(value, _STAGE_SOURCE_KEYS | {"remote_input"}, "Remote source selection")
        if set(selected) not in (
            _STAGE_SOURCE_KEYS,
            _STAGE_SOURCE_KEYS | {"remote_input"},
        ):
            raise ResearchRemoteError("Remote source selection is incomplete")
        source_id = selected["source_id"]
        remote_input = selected.get("remote_input")
        if remote_input is not None:
            remote_input = _exact(remote_input, _REMOTE_INPUT_KEYS, "Remote input mapping")
        try:
            source = workbench.project.source(checked_id(source_id), verify=remote_input is None)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ResearchRemoteError("Remote source is invalid, changed, or unavailable") from exc
        if source.get("source_kind") not in {"native", "whole_slide"} or (
            remote_input is None and "private_path" not in source
        ):
            raise ResearchRemoteError("Remote execution currently supports plain native files only")
        if source_id in source_ids:
            raise ResearchRemoteError("Remote source selection contains duplicates")
        if remote_input is not None:
            index = remote_input["root_index"]
            if (
                isinstance(index, bool)
                or not isinstance(index, int)
                or not 0 <= index < len(profile.remote_input_roots)
                or remote_input["source_sha256"] != source.get("sha256")
                or remote_input["size_bytes"] != source.get("size_bytes")
            ):
                raise ResearchRemoteError(
                    "Remote input mapping must match one permitted root and the exact "
                    "source fingerprint"
                )
        source_ids.append(source_id)
        selected_sources.append((source, remote_input))
    _validate_authority(request["transfer_authority"], profile.alias, source_ids)
    remote_sources: list[RemoteSource] = []
    stage_entries: list[StageEntry] = []
    for index, (source, remote_input) in enumerate(selected_sources):
        relative = (
            remote_input["relative_path"]
            if remote_input is not None
            else f"inputs/source-{index + 1:04d}{_source_suffix(source)}"
        )
        permitted_root = (
            profile.remote_input_roots[remote_input["root_index"]]
            if remote_input is not None
            else None
        )
        remote = RemoteSource(
            source["id"],
            relative,
            source["sha256"],
            source["size_bytes"],
            permitted_root=permitted_root,
        )
        remote.validate()
        remote_sources.append(remote)
        if remote_input is None:
            stage_entries.append(
                StageEntry(
                    Path(source["private_path"]),
                    relative,
                    source["sha256"],
                    source["size_bytes"],
                )
            )
    tasks: list[RemoteRecipeTask | RemoteCellposeTask] = []
    task_ids: set[str] = set()
    for value in task_values:
        if isinstance(value, dict) and value.get("operation") == "run_cellpose":
            task = _exact(value, _STAGE_CELLPOSE_TASK_KEYS, "Remote Cellpose task")
        else:
            task = _exact(value, _STAGE_TASK_KEYS, "Remote recipe task")
        if task["source_id"] not in source_ids:
            raise ResearchRemoteError("Remote task references a source outside the approved scope")
        try:
            if task.get("operation") == "run_cellpose":
                selection = workbench.selection(task["source_id"], task["selection"])
                remote_task: RemoteRecipeTask | RemoteCellposeTask = RemoteCellposeTask(
                    task["task_id"],
                    task["source_id"],
                    selection,
                    task["cellpose"],
                    channel_declarations=workbench.channel_metadata(task["source_id"])["channels"],
                )
            else:
                validated = workbench.validate_recipe(
                    {
                        "source_id": task["source_id"],
                        "selection": task["selection"],
                        "recipe": task["recipe"],
                    }
                )
                remote_task = RemoteRecipeTask(
                    task["task_id"],
                    task["source_id"],
                    validated["selection"],
                    validated["recipe"],
                    channel_declarations=workbench.channel_metadata(task["source_id"])["channels"],
                )
            remote_task.validate()
        except (KeyError, TypeError, ValueError) as exc:
            raise ResearchRemoteError("Remote recipe task is invalid for its local source") from exc
        if remote_task.task_id in task_ids:
            raise ResearchRemoteError("Remote task identities must be unique")
        if isinstance(remote_task, RemoteRecipeTask) and remote_task.recipe.get("references"):
            raise ResearchRemoteError("Remote reference-image recipes are not yet supported")
        working_bytes = (
            remote_task.recipe["working_bytes"]
            if isinstance(remote_task, RemoteRecipeTask)
            else remote_task.cellpose["working_bytes"]
        )
        if working_bytes > resources.memory_mb * 1024 * 1024:
            raise ResearchRemoteError("Remote task exceeds the saved profile memory policy")
        task_ids.add(remote_task.task_id)
        tasks.append(remote_task)
    worker = RemoteWorkerRequest(
        request["request_key"],
        workbench.project.meta["project_id"],
        resources,
        tuple(remote_sources),
        tuple(tasks),
    )
    remote_request, encoded = worker.encode(profile)
    return remote_request, worker, encoded, tuple(stage_entries), source_ids


def _request_bytes(data: dict[str, Any]) -> bytes:
    try:
        encoded = base64.b64decode(data["private_request_b64"], validate=True)
    except (KeyError, TypeError, ValueError) as exc:
        raise ResearchRemoteError("Persisted remote request bytes are corrupt") from exc
    if not hmac.compare_digest(hashlib.sha256(encoded).hexdigest(), data["request_sha256"]):
        raise ResearchRemoteError("Persisted remote request bytes failed their SHA-256")
    try:
        document = parse_json(encoded.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ResearchRemoteError("Persisted remote request is not canonical JSON") from exc
    if canonical_json(document).encode() != encoded:
        raise ResearchRemoteError("Persisted remote request is not canonical JSON")
    if (
        not isinstance(document, dict)
        or document.get("schema")
        not in {"loci.remote-worker-request/v1", "loci.remote-worker-request/v2"}
        or document.get("request_key") != data["request_key"]
        or document.get("project_id") != data["project_id"]
        or document.get("resources") != data["resources"]
        or [item.get("source_id") for item in document.get("sources", [])] != data["source_ids"]
        or [item.get("task_id") for item in document.get("tasks", [])] != data["task_ids"]
    ):
        raise ResearchRemoteError("Persisted remote request disagrees with its durable identity")
    return encoded


def _remote_request_from_run(data: dict[str, Any], profile: ConnectionProfile) -> RemoteRequest:
    request = RemoteRequest(
        data["request_key"],
        data["request_sha256"],
        data["project_id"],
        ResourceRequest(**data["resources"]),
    )
    try:
        request.validate()
    except (TypeError, ValueError) as exc:
        raise ResearchRemoteError("Persisted remote request identity is invalid") from exc
    encoded = _request_bytes(data)
    document = parse_json(encoded.decode("utf-8"))
    if document["output_root"] != profile.output_root(request.request_key):
        raise ResearchRemoteError("Persisted remote output root differs from the saved profile")
    return request


def _identity_from_run(data: dict[str, Any], *, require_job: bool = True) -> RemoteJobIdentity:
    job_id = data["remote_job_id"]
    if require_job and job_id is None:
        raise ResearchRemoteError("Remote run has no submitted job identity")
    return RemoteJobIdentity(
        data["request_key"],
        data["request_sha256"],
        data["scheduler"],
        job_id,
        data["remote_state"] or "unknown",
    )


def _assert_identity(identity: RemoteJobIdentity, data: dict[str, Any]) -> None:
    if (
        identity.request_key != data["request_key"]
        or identity.request_sha256 != data["request_sha256"]
        or identity.scheduler != data["scheduler"]
        or (data["remote_job_id"] is not None and identity.remote_job_id != data["remote_job_id"])
    ):
        raise ResearchRemoteError("Remote transport returned a mismatched run identity")


def _reconnect(profile_envelope: dict[str, Any]) -> RemoteComputeClient:
    client, _receipt = _tested_client(profile_envelope)
    return client


def _redacted_remote_text(text: str, profile: ConnectionProfile | None, *, limit: int) -> str:
    if not isinstance(text, str):
        raise ResearchRemoteError("Remote diagnostic text is invalid")
    # PBS uses four spaces for field starts and a tab (or eight spaces) for
    # continuation lines, including in the middle of a canonical path. Keep
    # field boundaries so redaction cannot consume the following field name.
    result = re.sub(r"\r?\n(?:\t+| {8,})", "", text)
    private_values = (
        (
            profile.runtime_python,
            profile.remote_project_root,
            profile.remote_output_root,
            *profile.remote_input_roots,
        )
        if profile is not None
        else ()
    )
    for value in sorted(private_values, key=len, reverse=True):
        result = result.replace(value, "[remote-path]")
    result = re.sub(r"(?<![\w/])/(?:[^\s\"'<>]+)", "[remote-path]", result)
    result = re.sub(r"[A-Za-z]:[\\/][^\s\"'<>]+", "[remote-path]", result)
    result = "".join(
        character for character in result if character in {"\n", "\r", "\t"} or ord(character) >= 32
    )
    encoded = result.encode("utf-8")
    if len(encoded) > limit:
        result = encoded[:limit].decode("utf-8", errors="ignore")
    return result


def _profile_sha256(envelope: dict[str, Any]) -> str:
    data = envelope["data"]
    return hashlib.sha256(
        canonical_json(
            {
                "alias": data["alias"],
                "scheduler": data["scheduler"],
                "resources": data["resources"],
                "private_profile": data["private_profile"],
            }
        ).encode()
    ).hexdigest()


def _require_profile_binding(data: dict[str, Any], profile_envelope: dict[str, Any]) -> None:
    if data["profile_sha256"] != _profile_sha256(profile_envelope):
        raise ResearchRemoteError("Saved profile changed after this remote run was prepared")


def _run_request(request: dict[str, Any]) -> tuple[str, str]:
    values = _exact(request, {"alias", "request_key"}, "Remote run request")
    if not isinstance(values["alias"], str) or not isinstance(values["request_key"], str):
        raise ResearchRemoteError("Remote alias and request key must be text")
    return values["alias"], values["request_key"]


def _stage(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    values = _exact(request, _STAGE_KEYS, "Remote stage request")
    profile_envelope = _load_profile(workbench.project, values["alias"])
    profile = _profile_from_data(profile_envelope["data"])
    resources = _resource(profile_envelope["data"]["resources"])
    remote_request, _worker, encoded, entries, source_ids = _build_remote_request(
        workbench, profile, resources, values
    )
    existing = [
        item
        for item in _runs(workbench.project)
        if item["data"]["request_key"] == values["request_key"]
    ]
    if len(existing) > 1:
        raise ResearchRemoteError("Remote request key is ambiguous in this study")
    task_ids = [item["task_id"] for item in values["tasks"]]
    binding = {
        "alias": profile.alias,
        "profile_revision": profile_envelope["revision"],
        "profile_sha256": _profile_sha256(profile_envelope),
        "request_key": remote_request.request_key,
        "request_sha256": remote_request.request_sha256,
        "project_id": remote_request.project_id,
        "scheduler": profile.scheduler,
        "resources": asdict(resources),
        "source_ids": source_ids,
        "task_ids": task_ids,
        "transfer_scope": TRANSFER_SCOPE,
    }
    if existing:
        current = existing[0]
        if any(
            current["data"].get(key) != value
            for key, value in binding.items()
            if key != "profile_revision"
        ):
            raise ResearchRemoteError("Remote request key already binds different inputs")
        if _request_bytes(current["data"]) != encoded:
            raise ResearchRemoteError("Remote request key already binds different canonical bytes")
        if current["data"]["state"] not in {"prepared", "staged"}:
            return {"run": _public_run(current)}
        prepared = current
    else:
        now = timestamp()
        data = {
            "schema": RUN_SCHEMA,
            **binding,
            "private_request_b64": base64.b64encode(encoded).decode("ascii"),
            "state": "prepared",
            "remote_job_id": None,
            "remote_state": "reserved",
            "status_detail": None,
            "cancel_requested": False,
            "staging_manifest_sha256": None,
            "script_sha256": None,
            "private_retrieval_directory": None,
            "outputs": None,
            "attachment": None,
            "cleanup_prepared_at": None,
            "cleanup_authorized_at": None,
            "remote_cleanup": None,
            "transfer_authorized_at": now,
            "retrieval_authorized_at": None,
            "created_at": now,
            "updated_at": now,
        }
        prepared = _new_document(workbench.project, _run_id(values["request_key"]), data)
    if prepared["data"]["state"] == "staged":
        return {"run": _public_run(prepared)}
    client = _reconnect(profile_envelope)
    client.setup_roots()
    help_text = client.test_runtime()
    if not isinstance(help_text, str) or "remote-worker" not in help_text:
        raise ResearchRemoteError("Configured runtime does not expose the fixed remote worker")
    client.reserve(remote_request)
    staging = StagingManifest(remote_request.request_key, remote_request.request_sha256, entries)
    staging_sha = client.stage(staging)
    request_sha, script_sha = client.stage_request_and_script(remote_request, encoded)
    if request_sha != remote_request.request_sha256:
        raise ResearchRemoteError("Remote staging returned a mismatched request identity")
    updated = _put(
        workbench.project,
        prepared,
        {
            **prepared["data"],
            "state": "staged",
            "staging_manifest_sha256": staging_sha,
            "script_sha256": script_sha,
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated)}


def _submit(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    alias, request_key = _run_request(request)
    envelope = _load_run(workbench.project, request_key)
    data = envelope["data"]
    if data["alias"] != alias:
        raise ResearchRemoteError("Remote run belongs to another saved profile")
    if data["state"] in {"submitted", "running", "finished", "retrieved", "attached"}:
        return {"run": _public_run(envelope)}
    if data["state"] != "staged":
        raise ResearchRemoteError("Remote run must be fully staged before submission")
    profile_envelope = _load_profile(workbench.project, alias)
    _require_profile_binding(data, profile_envelope)
    profile = _profile_from_data(profile_envelope["data"])
    client = _reconnect(profile_envelope)
    identity = client.submit(_remote_request_from_run(data, profile))
    _assert_identity(identity, data)
    if (
        identity.remote_job_id is None
        or not _REMOTE_JOB_ID.fullmatch(identity.remote_job_id)
        or identity.state == "unknown"
    ):
        raise ResearchRemoteError(
            "Remote submission outcome is unknown; retry the identical request key to recover"
        )
    updated = _put(
        workbench.project,
        envelope,
        {
            **data,
            "state": "submitted",
            "remote_job_id": identity.remote_job_id,
            "remote_state": identity.state,
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated)}


def _status(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    alias, request_key = _run_request(request)
    envelope = _load_run(workbench.project, request_key)
    data = envelope["data"]
    if data["alias"] != alias:
        raise ResearchRemoteError("Remote run belongs to another saved profile")
    if data["state"] == "cleaned":
        return {"run": _public_run(envelope)}
    profile_envelope = _load_profile(workbench.project, alias)
    _require_profile_binding(data, profile_envelope)
    client = _reconnect(profile_envelope)
    status = client.status(_identity_from_run(data))
    if not isinstance(status, RemoteJobStatus):
        raise ResearchRemoteError("Remote transport returned an invalid status record")
    _assert_identity(status.identity, data)
    detail = _redacted_remote_text(
        status.detail, _profile_from_data(profile_envelope["data"]), limit=4096
    )
    if (
        status.state not in {"submitted", "queued", "running", "finished", "failed", "unknown"}
        or len(detail.encode()) > 4096
    ):
        raise ResearchRemoteError("Remote transport returned an invalid bounded status")
    state = (
        data["state"]
        if data["state"] in {"retrieved", "attached"}
        else ("finished" if status.state == "finished" else status.state)
    )
    updated = _put(
        workbench.project,
        envelope,
        {
            **data,
            "state": state,
            "remote_state": status.state,
            "status_detail": detail,
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated)}


def _cancel(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    alias, request_key = _run_request(request)
    envelope = _load_run(workbench.project, request_key)
    data = envelope["data"]
    if data["alias"] != alias:
        raise ResearchRemoteError("Remote run belongs to another saved profile")
    if data["state"] in {"retrieved", "attached"}:
        raise ResearchRemoteError("Published remote results cannot be cancelled")
    profile_envelope = _load_profile(workbench.project, alias)
    _require_profile_binding(data, profile_envelope)
    client = _reconnect(profile_envelope)
    client.cancel(_identity_from_run(data))
    updated = _put(
        workbench.project,
        envelope,
        {
            **data,
            "state": "cancel_requested",
            "cancel_requested": True,
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated)}


def _verified_existing_retrieval(
    directory: Path, manifest: VerifiedOutputManifest
) -> tuple[Path, ...] | None:
    if directory.is_symlink() or not directory.is_dir():
        return None
    expected = {entry.relative_path: entry for entry in manifest.entries}
    actual: set[str] = set()
    for path in directory.rglob("*"):
        if path.is_symlink() or (not path.is_file() and not path.is_dir()):
            return None
        if path.is_file():
            relative = path.relative_to(directory).as_posix()
            actual.add(relative)
            entry = expected.get(relative)
            if entry is None:
                return None
            try:
                digest, size = _sha256_file_stable(path, reject_symlink=True)
            except (OSError, RuntimeError, ValueError):
                return None
            if digest != entry.sha256 or size != entry.size_bytes:
                return None
    if actual != set(expected):
        return None
    return tuple(directory.joinpath(*Path(name).parts) for name in sorted(expected))


def _output_dto(manifest: VerifiedOutputManifest) -> list[dict[str, Any]]:
    return [asdict(entry) for entry in manifest.entries]


def _retrieve(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    values = _exact(
        request, {"alias", "request_key", "transfer_authorized"}, "Remote retrieval request"
    )
    if values["transfer_authorized"] is not True:
        raise ResearchRemoteError("Remote output retrieval requires explicit transfer authority")
    alias, request_key = values["alias"], values["request_key"]
    envelope = _load_run(workbench.project, request_key)
    data = envelope["data"]
    if data["alias"] != alias:
        raise ResearchRemoteError("Remote run belongs to another saved profile")
    if data["cancel_requested"]:
        raise ResearchRemoteError("Cancelled remote runs cannot publish retrieved results")
    if data["state"] not in {"finished", "retrieved"}:
        raise ResearchRemoteError("Remote run must finish before output retrieval")
    profile_envelope = _load_profile(workbench.project, alias)
    _require_profile_binding(data, profile_envelope)
    client = _reconnect(profile_envelope)
    identity = _identity_from_run(data)
    manifest = client.fetch_output_manifest(identity)
    if (
        manifest.request_key != data["request_key"]
        or manifest.request_sha256 != data["request_sha256"]
    ):
        raise ResearchRemoteError("Remote output manifest identity is mismatched")
    root = workbench.project.root / ".remote-results"
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise ResearchRemoteError("Local remote-result cache is unsafe")
    destination = root / request_key
    retrieved = _verified_existing_retrieval(destination, manifest)
    if retrieved is None:
        if destination.exists() or destination.is_symlink():
            raise ResearchRemoteError("Existing local retrieval disagrees with remote manifest")
        retrieved = client.retrieve_outputs(identity, destination)
    expected_paths = tuple(
        destination.joinpath(*Path(entry.relative_path).parts) for entry in manifest.entries
    )
    if (
        tuple(retrieved) != expected_paths
        or _verified_existing_retrieval(destination, manifest) is None
    ):
        raise ResearchRemoteError("Retrieved remote outputs failed local manifest verification")
    updated = _put(
        workbench.project,
        envelope,
        {
            **data,
            "state": "retrieved",
            "private_retrieval_directory": str(destination),
            "outputs": _output_dto(manifest),
            "retrieval_authorized_at": timestamp(),
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated)}


def _manifest_from_run(data: dict[str, Any]) -> VerifiedOutputManifest:
    outputs = data["outputs"]
    if not isinstance(outputs, list):
        raise ResearchRemoteError("Remote outputs have not been durably retrieved")
    from .remote_compute import OutputEntry

    try:
        entries = tuple(OutputEntry(**item) for item in outputs)
    except (TypeError, ValueError) as exc:
        raise ResearchRemoteError("Persisted remote output manifest is invalid") from exc
    return VerifiedOutputManifest(data["request_key"], data["request_sha256"], entries)


def _attach(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    values = _only(request, {"alias", "request_key", "local_job_id"}, "Remote attach request")
    if set(values) not in ({"alias", "request_key"}, {"alias", "request_key", "local_job_id"}):
        raise ResearchRemoteError("Remote attach request is missing its run identity")
    alias, request_key = values["alias"], values["request_key"]
    envelope = _load_run(workbench.project, request_key)
    data = envelope["data"]
    if data["alias"] != alias:
        raise ResearchRemoteError("Remote run belongs to another saved profile")
    if data["cancel_requested"]:
        raise ResearchRemoteError("Cancelled remote runs cannot attach results")
    if data["state"] not in {"retrieved", "attached", "cleaned"}:
        raise ResearchRemoteError("Remote outputs must be retrieved before attachment")
    encoded = _request_bytes(data)
    manifest = _manifest_from_run(data)
    if len(manifest.entries) != 1 or manifest.entries[0].relative_path != "results.zip":
        raise ResearchRemoteError("Retrieved publication does not contain exactly results.zip")
    directory = Path(data["private_retrieval_directory"])
    archive = directory / "results.zip"
    source_mapping = {source_id: source_id for source_id in data["source_ids"]}
    receipt = attach_remote_results(
        workbench.project,
        encoded,
        archive,
        expected_archive_sha256=manifest.entries[0].sha256,
        outer_manifest=manifest,
        local_source_mapping=source_mapping,
        local_job_id=values.get("local_job_id"),
    )
    if data["state"] in {"attached", "cleaned"}:
        if receipt != data["attachment"]:
            raise ResearchRemoteError("Stored workflow attachment receipt is mismatched")
        return {"run": _public_run(envelope), "attachment": receipt}
    updated = _put(
        workbench.project,
        envelope,
        {
            **data,
            "state": "attached",
            "attachment": receipt,
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated), "attachment": receipt}


def _logs(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    values = _exact(request, {"alias", "request_key", "stderr", "limit"}, "Remote log request")
    if not isinstance(values["stderr"], bool):
        raise ResearchRemoteError("Remote log stream selection must be boolean")
    limit = values["limit"]
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 64 * 1024:
        raise ResearchRemoteError("Remote log limit must be between 1 byte and 64 KiB")
    envelope = _load_run(workbench.project, values["request_key"])
    data = envelope["data"]
    if data["alias"] != values["alias"] or data["state"] == "cleaned":
        raise ResearchRemoteError("Remote log request does not identify an available owned run")
    profile_envelope = _load_profile(workbench.project, values["alias"])
    _require_profile_binding(data, profile_envelope)
    profile = _profile_from_data(profile_envelope["data"])
    text = _reconnect(profile_envelope).logs(
        _identity_from_run(data), stderr=values["stderr"], limit=limit
    )
    return {
        "request_key": data["request_key"],
        "stream": "stderr" if values["stderr"] else "stdout",
        "text": _redacted_remote_text(text, profile, limit=limit),
        "limit_bytes": limit,
    }


def _remove_owned(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    values = _exact(
        request,
        {"alias", "request_key", "request_sha256", "cleanup_authorized"},
        "Remote owned cleanup request",
    )
    if values["cleanup_authorized"] is not True:
        raise ResearchRemoteError("Remote cleanup requires explicit ownership-bound authority")
    envelope = _load_run(workbench.project, values["request_key"])
    data = envelope["data"]
    if data["alias"] != values["alias"] or data["request_sha256"] != values["request_sha256"]:
        raise ResearchRemoteError("Remote cleanup identity does not match the durable run")
    if data["state"] == "cleaned":
        return {"run": _public_run(envelope), "cleanup": data["remote_cleanup"]}
    if data["state"] != "attached" or not isinstance(data["attachment"], dict):
        raise ResearchRemoteError("Remote owned data can be removed only after verified attachment")
    manifest = _manifest_from_run(data)
    retrieval = _verified_existing_retrieval(Path(data["private_retrieval_directory"]), manifest)
    if retrieval is None:
        raise ResearchRemoteError("Local retrieved outputs no longer match their stored manifest")
    attachment = _attach(
        workbench, {"alias": values["alias"], "request_key": values["request_key"]}
    )["attachment"]
    if attachment != data["attachment"]:
        raise ResearchRemoteError("Local attachment receipt no longer verifies")
    profile_envelope = _load_profile(workbench.project, values["alias"])
    _require_profile_binding(data, profile_envelope)
    client = _reconnect(profile_envelope)
    identity = _identity_from_run(data)
    if data["cleanup_prepared_at"] is None:
        remote_manifest = client.fetch_output_manifest(identity)
        if remote_manifest != manifest:
            raise ResearchRemoteError("Remote outputs changed before cleanup preparation")
        now = timestamp()
        envelope = _put(
            workbench.project,
            envelope,
            {
                **data,
                "cleanup_prepared_at": now,
                "cleanup_authorized_at": now,
                "updated_at": now,
            },
        )
        data = envelope["data"]
    receipt = client.cleanup(identity)
    if (
        not isinstance(receipt, RemoteCleanupReceipt)
        or receipt.request_key != data["request_key"]
        or receipt.request_sha256 != data["request_sha256"]
        or receipt.scheduler != data["scheduler"]
        or receipt.remote_job_id != data["remote_job_id"]
        or receipt.owned_run_roots != 2
        or receipt.state != "cleaned"
    ):
        raise ResearchRemoteError("Remote cleanup receipt identity is invalid")
    cleanup = asdict(receipt)
    updated = _put(
        workbench.project,
        envelope,
        {
            **data,
            "state": "cleaned",
            "remote_cleanup": cleanup,
            "updated_at": timestamp(),
        },
    )
    return {"run": _public_run(updated), "cleanup": cleanup}


def execute_remote(workbench: Workbench, operation: str, request: dict[str, Any]) -> dict[str, Any]:
    """Execute one fixed remote lifecycle operation for an open workbench."""

    if not isinstance(workbench, Workbench) or not isinstance(request, dict):
        raise ResearchRemoteError("Remote execution requires an open workbench and object request")
    operations = {
        "profile_save": _save_profile,
        "profile_list": _list_profiles,
        "profile_test": lambda value, body: _test_profile(value, body, ready=False),
        "readiness": lambda value, body: _test_profile(value, body, ready=True),
        "run_list": _list_runs,
        "stage": _stage,
        "submit": _submit,
        "status": _status,
        "cancel": _cancel,
        "retrieve": _retrieve,
        "attach": _attach,
        "logs": _logs,
        "remove_owned": _remove_owned,
    }
    handler = operations.get(operation)
    if handler is None:
        raise ResearchRemoteError("Unknown remote workflow operation")
    return handler(workbench, request)
