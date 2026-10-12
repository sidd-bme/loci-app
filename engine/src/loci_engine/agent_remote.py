"""Experimental single human-prestaged classical remote-run authority.

No input here grants source staging, profile editing, shell execution, or review.
The private policy is the authority; mutable workflow documents are only inputs.
"""

from __future__ import annotations

import copy
import hashlib
import os
import signal
import subprocess
import threading
import time

from . import research_remote as remote
from .agent_policy import _exact_keys, _integer, _sha256, _text
from .remote_compute import RemoteRecipeTask
from .research_process import research_command
from .research_project import ResearchProject, canonical_json, checked_id, parse_json, timestamp
from .research_remote_results import _request_from_bytes
from .workbench import Workbench, runtime_record

REMOTE_OPERATIONS = frozenset({"submit", "status", "cancel", "retrieve", "attach"})
_GRANT_KEYS = {
    "key",
    "request_key",
    "request_sha256",
    "profile_sha256",
    "source_id",
    "source_sha256",
    "source_size_bytes",
    "task_id",
    "resources",
    "operations",
    "max_output_bytes",
    "cancel_on_revocation",
}
_ACTIVE_REMOTE = {"submitted", "queued", "running", "unknown"}


def validate_grants(project, document, sources, recipes):
    grants = document["remote_grants"]
    if not isinstance(grants, list) or len(grants) > 1:
        raise ValueError("Remote authority permits at most one exact run grant")
    for grant in grants:
        _exact_keys(grant, _GRANT_KEYS, "remote grant")
        _text(grant["key"], "opaque grant key", 80)
        checked_id(grant["request_key"])
        checked_id(grant["source_id"])
        checked_id(grant["task_id"])
        for key in ("request_sha256", "profile_sha256", "source_sha256"):
            _sha256(grant[key], key)
        _integer(
            grant["source_size_bytes"],
            "source size",
            1,
            min(document["limits"]["memory_bytes"] // 4, 512 * 1024**2),
        )
        _integer(
            grant["max_output_bytes"],
            "remote output cap",
            1,
            min(document["limits"]["memory_bytes"] // 4, 512 * 1024**2),
        )
        resource = _exact_keys(
            grant["resources"],
            {"cpus", "memory_mb", "wall_minutes", "gpus"},
            "remote grant resources",
        )
        _integer(resource["cpus"], "remote CPUs", 1, 8)
        _integer(resource["memory_mb"], "remote memory", 256, 8192)
        _integer(resource["wall_minutes"], "remote wall minutes", 1, 60)
        if type(resource["gpus"]) is not int or resource["gpus"] != 0:
            raise ValueError("Agent remote runs require exactly zero GPUs")
        operations = grant["operations"]
        if (
            not isinstance(operations, list)
            or not all(isinstance(op, str) for op in operations)
            or len(set(operations)) != len(operations)
            or not set(operations) <= REMOTE_OPERATIONS
        ):
            raise ValueError("Unsupported remote grant operations")
        if type(grant["cancel_on_revocation"]) is not bool:
            raise ValueError("Remote revocation cancellation authority must be explicit")
        if "submit" in operations and not grant["cancel_on_revocation"]:
            raise ValueError("Submit requires exact owned-job cancellation on revocation")
        with _closing_workbench(project) as wb:
            validate_binding(
                wb,
                grant,
                sources,
                recipes,
                document["runtimes"],
                document["limits"]["memory_bytes"],
                initial=True,
            )


class _closing_workbench:
    def __init__(self, project):
        self.wb = Workbench(project)

    def __enter__(self):
        return self.wb

    def __exit__(self, *args):
        self.wb.close()


def validate_binding(wb, grant, sources, recipes, runtimes, memory_bytes, *, initial=False):
    envelope = remote._load_run(wb.project, grant["request_key"])
    data = envelope["data"]
    if initial and data["state"] not in {
        "staged",
        "submitted",
        "queued",
        "running",
        "finished",
        "retrieved",
        "attached",
        "cancel_requested",
        "failed",
        "unknown",
    }:
        raise PermissionError("Remote grant requires a fully human-staged run")
    if data["state"] in {"prepared", "cleaned"}:
        raise PermissionError("Remote run is not available under this grant")
    profile_envelope = remote._load_profile(wb.project, data["alias"])
    profile = remote._profile_from_data(profile_envelope["data"])
    encoded = remote._request_bytes(data)
    contract = _request_from_bytes(encoded, grant["request_sha256"])
    if (
        hashlib.sha256(encoded).hexdigest() != grant["request_sha256"]
        or data["profile_sha256"] != grant["profile_sha256"]
        or remote._profile_sha256(profile_envelope) != grant["profile_sha256"]
        or data["resources"] != grant["resources"]
        or profile_envelope["data"]["resources"] != grant["resources"]
        or data["project_id"] != wb.project.meta["project_id"]
        or contract.project_id != wb.project.meta["project_id"]
        or profile.scheduler not in {"pbs", "pbspro", "slurm"}
        or data["scheduler"] != profile.scheduler
        or profile.allow_direct_compute
        or len(contract.sources) != 1
        or len(contract.tasks) != 1
    ):
        raise PermissionError("Remote immutable request/profile/resource binding changed")
    remote._remote_request_from_run(data, profile)
    directory = data.get("private_retrieval_directory")
    cache = wb.project.root / ".remote-results"
    expected_directory = cache / (".agent-stage-" + grant["request_key"])
    if directory is not None and (
        directory != str(expected_directory)
        or cache.is_symlink()
        or expected_directory.is_symlink()
    ):
        raise PermissionError("Agent retrieval locator is outside its fixed private staging")
    source, task = contract.sources[0], contract.tasks[0]
    if (
        not isinstance(task, RemoteRecipeTask)
        or task.operation != "run_recipe"
        or task.task_id != grant["task_id"]
        or task.source_id != grant["source_id"]
        or source.source_id != grant["source_id"]
        or source.sha256 != grant["source_sha256"]
        or source.size_bytes != grant["source_size_bytes"]
        or task.recipe.get("references")
    ):
        raise PermissionError("Remote task/source identity is outside the grant")
    local = wb.project.source(grant["source_id"], verify=True)
    source_grant = sources.get(grant["source_id"])
    if (
        source_grant is None
        or local["sha256"] != source_grant.sha256
        or local["sha256"] != source.sha256
        or local["size_bytes"] != source.size_bytes
    ):
        raise PermissionError("Remote source bytes exceed the pinned authority")
    validation = wb.validate_recipe(
        {"source_id": source.source_id, "selection": task.selection, "recipe": task.recipe}
    )
    recipe = recipes.get(validation["recipe_sha256"])
    runtime = runtime_record()
    from .agent_policy import _RUNTIME_KEYS

    if (
        recipe is None
        or not recipe.run
        or validation["recipe"] != task.recipe
        or validation["selection"] != task.selection
        or not source_grant.allows(validation["selection"], task.recipe["measurement_channels"])
        or task.recipe["working_bytes"] > memory_bytes
        or {key: runtime.get(key) for key in _RUNTIME_KEYS} not in runtimes
        or task.channel_declarations != wb.channel_metadata(source.source_id)["channels"]
    ):
        raise PermissionError("Remote recipe/axes/channels/runtime authority changed")
    return envelope, profile_envelope


def authorize(agent, wb, key, operation):
    agent.policy.recheck()
    grant = agent.policy.remote_grants.get(key)
    if grant is None or operation not in grant["operations"]:
        raise PermissionError("Remote grant or operation is not authorized")
    envelope, profile = validate_binding(
        wb,
        grant,
        agent.policy.sources,
        agent.policy.recipes,
        agent.policy.runtimes,
        agent.policy.memory_bytes,
    )
    snapshot = _snapshot(wb.project, agent.policy.content_sha256, key)
    if (
        snapshot
        and snapshot.get("identity")
        and envelope["data"]["remote_job_id"] != snapshot["identity"]["remote_job_id"]
    ):
        raise PermissionError("The exact service-owned remote job identity changed")
    return grant, envelope, profile


def safe_run(agent, grant, data):
    value = {
        "grant_key": grant["key"],
        "state": data["state"],
        "cancel_requested": bool(data["cancel_requested"]),
    }
    attachment = data.get("attachment")
    if attachment is None:
        with ResearchProject(agent.policy.project_path).connection() as connection:
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?",
                ("remote-attachment:" + grant["request_key"],),
            ).fetchone()
        attachment = parse_json(row[0]) if row else None
    if attachment:
        value["results"] = [
            {"id": item["local_result_id"], "revision_hash": item["local_revision_hash"]}
            for item in attachment["task_results"]
        ]
    if "agent_metadata" in agent.policy.disclosures:
        value.update({key: data[key] for key in ("request_sha256", "profile_sha256", "resources")})
    return {"run": value}


def _snapshot_key(policy_hash, key):
    return "agent-remote-owned:" + hashlib.sha256((policy_hash + ":" + key).encode()).hexdigest()


def _snapshot(project, policy_hash, key):
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", (_snapshot_key(policy_hash, key),)
        ).fetchone()
    return parse_json(row[0]) if row else None


def _save_snapshot(project, policy_hash, key, value):
    with project.connection() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (_snapshot_key(policy_hash, key), canonical_json(value)),
        )


def active_remote_count(policy, project):
    total = 0
    for grant in policy.remote_grants.values():
        data = remote._load_run(project, grant["request_key"])["data"]
        # A cancel command is a request, never evidence that resources were freed.
        active = data["state"] in _ACTIVE_REMOTE
        if data["state"] == "cancel_requested":
            active = data.get("remote_state") not in {"finished", "failed"}
        total += active
    return total


class RemoteSupervisor:
    """Fixed disposable child, durable retry identity, and owned revocation cleanup."""

    def __init__(self, agent):
        self.agent = agent
        self._children = {}
        self._lock = threading.RLock()
        self._watching = set()

    def _guard(self, key, operation, project):
        wb = Workbench(project)
        try:
            return authorize(self.agent, wb, key, operation)
        finally:
            wb.close()

    def watch_remote(self, grant, envelope, profile):
        # Copy the ORIGINAL validated profile and full submitted identity. Never
        # reconnect mutable documents to cancel after revocation.
        key = grant["key"]
        existing = _snapshot(
            ResearchProject(self.agent.policy.project_path),
            self.agent.policy.content_sha256,
            key,
        )
        if existing is None:
            return  # A human-owned previously submitted job is not ours to cancel.
        if (
            remote._profile_sha256(existing["profile"]) != grant["profile_sha256"]
            or existing["profile"]["data"]["private_profile"] != profile["data"]["private_profile"]
            or not existing.get("identity")
            or existing["identity"]["request_key"] != grant["request_key"]
            or existing["identity"]["request_sha256"] != grant["request_sha256"]
            or existing["identity"]["scheduler"] != envelope["data"]["scheduler"]
            or existing["identity"]["remote_job_id"] != envelope["data"]["remote_job_id"]
        ):
            raise PermissionError("Original owned cancellation snapshot changed")
        with self._lock:
            if key in self._watching:
                return
            self._watching.add(key)
        captured = copy.deepcopy(existing)

        def watch():
            while True:
                try:
                    _, current, _ = self._guard(
                        key, "submit", ResearchProject(self.agent.policy.project_path)
                    )
                    if current["data"]["state"] in {
                        "finished",
                        "retrieved",
                        "attached",
                        "failed",
                    }:
                        return
                except Exception:
                    self._cancel_original(key, captured)
                    return
                time.sleep(0.1)

        threading.Thread(target=watch, daemon=True).start()

    def _cancel_original(self, key, snapshot):
        if not snapshot.get("cancel_on_revocation"):
            return
        status = "unconfirmed"
        try:
            identity = remote.RemoteJobIdentity(**snapshot["identity"])
            client = remote._reconnect(snapshot["profile"])
            client.cancel(identity)
            status = "cancel_requested"
        except Exception:
            pass  # Only a private bounded failure code; no secret diagnostics.
        try:
            project = ResearchProject(self.agent.policy.project_path)
            _save_snapshot(
                project,
                self.agent.policy.content_sha256,
                key,
                {**snapshot, "revocation_cancellation": status},
            )
        except Exception:
            pass

    def work_state(self, job):
        process = self._children.get(job["id"])
        return "running" if process is not None and process.poll() is None else job["state"]

    def start(self, wb, grant, operation):
        from .research_jobs import reconcile_jobs

        policy = self.agent.policy
        project = wb.project
        request = {"grant_key": grant["key"], "policy_sha256": policy.content_sha256}
        job = project.submit(
            "agent_remote_" + operation,
            request,
            "agent-remote:" + policy.content_sha256 + ":" + operation,
        )
        with self.agent.supervisor._lock, self._lock:
            reconcile_jobs(project)
            job = project.job(job["id"])
            if self.work_state(job) == "running":
                return {**job, "state": "running"}
            if job["state"] == "cancelled":
                raise PermissionError("Cancelled agent work cannot restart")
            if job["state"] in {"failed", "interrupted", "succeeded"}:
                attempts = [
                    item
                    for item in project.list_jobs()
                    if item["operation"] == "agent_remote_" + operation
                    and item["request"] == request
                ]
                latest = attempts[-1]
                if latest["state"] == "running":
                    return latest
                if latest["state"] == "queued":
                    job = latest
                else:
                    if len(attempts) >= 8:
                        raise PermissionError(
                            "Agent remote retry limit requires human reconciliation"
                        )
                    job = project.submit(
                        "agent_remote_" + operation,
                        request,
                        "agent-remote:"
                        + policy.content_sha256
                        + ":"
                        + operation
                        + ":retry:"
                        + str(len(attempts)),
                    )
            if job["id"] in self._children and self._children[job["id"]].poll() is None:
                return job
            running = {item["id"] for item in project.list_jobs() if item["state"] == "running"}
            owned = {
                job_id
                for job_id, proc in (self.agent.supervisor._children | self._children).items()
                if proc.poll() is None
            }
            active = (
                len(running | owned)
                + self.agent.supervisor._preview_count
                + active_remote_count(policy, project)
            )
            if active >= policy.concurrency:
                raise PermissionError("The shared policy concurrency limit is in use")
            command = research_command(
                [
                    "agent-remote",
                    "--project",
                    str(project.root),
                    "--job",
                    job["id"],
                    "--operation",
                    operation,
                    "--grant-key",
                    grant["key"],
                    "--policy",
                    str(policy.path),
                    "--policy-sha256",
                    policy.content_sha256,
                    "--policy-file-identity",
                    ":".join(map(str, policy.file_identity)),
                    "--project-directory-identity",
                    ":".join(map(str, policy.project_directory_identity)),
                    "--export-directory-identity",
                    "none"
                    if policy.export_root_identity is None
                    else ":".join(map(str, policy.export_root_identity)),
                ]
            )
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                start_new_session=True,
            )
            self._children[job["id"]] = process

        def watch():
            deadline = time.monotonic() + policy.cpu_seconds * 2 + 30
            stopped = False
            while process.poll() is None:
                try:
                    self._guard(grant["key"], operation, project)
                    if time.monotonic() > deadline:
                        raise PermissionError("Agent child wall limit exceeded")
                    # macOS has no working RLIMIT_AS. Bound observed RSS of this
                    # exact owned process in addition to recipe/ZIP preflight.
                    if os.name == "posix" and os.uname().sysname == "Darwin":
                        usage = subprocess.run(
                            ["/bin/ps", "-o", "rss=", "-p", str(process.pid)],
                            capture_output=True,
                            timeout=1,
                            check=False,
                        )
                        rss = usage.stdout.strip()
                        if rss and int(rss) * 1024 > policy.memory_bytes:
                            raise PermissionError("Agent child memory limit exceeded")
                    if project.job(job["id"])["cancel_requested"]:
                        raise PermissionError("Agent child was cancelled")
                except Exception:
                    stopped = True
                    from .research_jobs import cancel_job

                    cancel_job(project, job["id"])
                    terminate_owned_tree(process)
                    break
                time.sleep(0.1)
            process.wait()
            current = project.job(job["id"])
            if current["state"] in {"queued", "running"}:
                project.update_job(
                    job["id"],
                    expected_state=current["state"],
                    state="cancelled" if stopped else "failed",
                    finished_at=timestamp(),
                    error="Bounded agent remote work stopped.",
                )

        threading.Thread(target=watch, daemon=True).start()
        return job


def execute_child(policy, grant_key, operation, job_id):
    from .research_mcp import PolicyAgent
    from .resource_limits import apply_process_limits

    apply_process_limits(policy.cpu_seconds, policy.memory_bytes)
    agent = PolicyAgent(policy)
    wb = Workbench(ResearchProject(policy.project_path))
    project = wb.project
    try:
        job = project.job(job_id)
        expected = {"grant_key": grant_key, "policy_sha256": policy.content_sha256}
        if job["operation"] != "agent_remote_" + operation or job["request"] != expected:
            raise PermissionError("Agent child durable identity changed")
        if job["state"] != "queued" or job["cancel_requested"]:
            raise PermissionError("Agent child cannot claim this job")
        project.update_job(
            job_id,
            expected_state="queued",
            state="running",
            pid=os.getpid(),
            started_at=timestamp(),
            max_running=policy.concurrency,
        )

        def guard():
            authorize(agent, wb, grant_key, operation)
            current = project.job(job_id)
            if (
                current["state"] not in {"running", "succeeded"}
                or current["cancel_requested"]
                or current.get("pid") != os.getpid()
            ):
                raise PermissionError("Agent remote work was cancelled")

        grant, envelope, _profile = authorize(agent, wb, grant_key, operation)
        request = {"alias": envelope["data"]["alias"], "request_key": grant["request_key"]}
        if operation == "retrieve":
            remote._retrieve(
                wb,
                {**request, "transfer_authorized": True},
                publication_guard=guard,
                max_output_bytes=grant["max_output_bytes"],
            )
            guard()
            project.update_job(
                job_id,
                expected_state="running",
                state="succeeded",
                progress=1,
                finished_at=timestamp(),
            )
        elif operation == "attach":
            existing = envelope["data"].get("attachment")
            publication_job = existing["local_job_id"] if existing else job_id
            remote._attach(
                wb,
                {**request, "local_job_id": publication_job},
                publication_guard=guard,
                max_output_bytes=grant["max_output_bytes"],
                max_decoded_bytes=policy.memory_bytes // 4,
            )
        else:
            raise PermissionError("Unsupported agent child operation")
        current = project.job(job_id)
        if current["state"] == "running":
            guard()
            project.update_job(
                job_id,
                expected_state="running",
                state="succeeded",
                progress=1,
                finished_at=timestamp(),
            )
        return {"completed": True}
    finally:
        wb.close()


def human_remote_grant(
    project, request_key, key, operations, max_output_bytes, cancel_on_revocation
):
    """Read-only manual helper; creates no profile, source transfer, or policy."""
    envelope = remote._load_run(project, checked_id(request_key))
    data = envelope["data"]
    if data["state"] != "staged":
        raise ValueError("A new grant requires a fully human-staged run")
    encoded = remote._request_bytes(data)
    contract = _request_from_bytes(encoded, data["request_sha256"])
    if (
        len(contract.sources) != 1
        or len(contract.tasks) != 1
        or not isinstance(contract.tasks[0], RemoteRecipeTask)
    ):
        raise ValueError("Agent grants support exactly one classical source/task")
    source, task = contract.sources[0], contract.tasks[0]
    profile = remote._load_profile(project, data["alias"])
    remote._require_profile_binding(data, profile)
    return {
        "key": key,
        "request_key": request_key,
        "request_sha256": data["request_sha256"],
        "profile_sha256": remote._profile_sha256(profile),
        "source_id": source.source_id,
        "source_sha256": source.sha256,
        "source_size_bytes": source.size_bytes,
        "task_id": task.task_id,
        "resources": data["resources"],
        "operations": operations,
        "max_output_bytes": max_output_bytes,
        "cancel_on_revocation": cancel_on_revocation,
    }


def terminate_owned_tree(process):
    """Cancel only a still-live Popen-owned session, including fixed SSH children."""
    if process.poll() is not None:
        return
    if os.name == "posix":
        try:
            if os.getpgid(process.pid) != process.pid:
                raise PermissionError("Owned child session identity changed")
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
    elif os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=True,
        )
    else:
        raise PermissionError("Owned process-tree cancellation is unsupported")
