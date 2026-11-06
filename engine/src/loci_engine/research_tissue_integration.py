"""Trusted tissue wiring: no package paths or approval values cross public APIs."""

from __future__ import annotations

import os
import select
import selectors
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager, suppress
from pathlib import Path

from . import research_tissue_models as tissue
from . import tissue_model_store as store
from .research_project import parse_json, timestamp
from .tissue_model_profiles import PUMA_PROFILE_ID, puma_profile, runtime_metadata_status

OPERATIONS = frozenset({"tissue_model_status", "tissue_model_preview", "tissue_model_run"})
TASKS = OPERATIONS - {"tissue_model_status"}
RUNTIME_KEYS = {"engine", "numpy", "scipy", "scikit_image", "backend", "resolved_device"}


def model_root():
    # Desktop main owns this setting. Never accept a cache root from a renderer,
    # MCP request or study document; absence must not fall back to another store.
    value = os.environ.get("LOCI_MODEL_HOME")
    if not value or not Path(value).is_absolute():
        raise ValueError("The native managed model location is unavailable")
    return Path(value)


def profiles():
    return {
        "profiles": [
            {
                "profile": puma_profile(),
                "store": store.inspect_store(model_root(), check=lambda: None, verify=False),
                "runtime": runtime_metadata_status(),
                "runtime_policy_identity": policy_runtime(),
            }
        ]
    }


def native_import(request):
    if type(request) is not dict or set(request) != {"profile_id", "weights_path", "receipt_path"}:
        raise ValueError("Native tissue import requires the exact selected files")
    if request["profile_id"] != PUMA_PROFILE_ID:
        raise ValueError("Unknown tissue model profile")
    store.import_puma_weights(
        request["weights_path"],
        request["receipt_path"],
        cache_root=model_root(),
        check=lambda: None,
    )
    return profiles()


def policy_runtime():
    from .workbench import runtime_record

    value = {key: item for key, item in runtime_record().items() if key in RUNTIME_KEYS}
    # Existing policy schema stays exact. The backend binds the full fixed PUMA
    # runtime contract, including Torch/version/git/numeric profile, rather than
    # pretending the scalar NumPy backend performed inference.
    value["backend"] = "puma:" + tissue._hash(puma_profile()["runtime"])
    value["resolved_device"] = "cpu"
    return value


def validate_host_runtime(value, *, engine_version):
    if (
        type(value) is not dict
        or set(value) != RUNTIME_KEYS
        or any(type(item) is not str or not 1 <= len(item) <= 256 for item in value.values())
        or value["engine"] != engine_version
        or value["numpy"] != tissue.PUMA_RUNTIME_VERSIONS["numpy"]
        or value["scipy"] != tissue.PUMA_RUNTIME_VERSIONS["scipy"]
        or value["resolved_device"] != "cpu"
        or value["backend"] != "puma:" + tissue._hash(puma_profile()["runtime"])
    ):
        raise ValueError("Tissue host runtime identity is invalid")
    return value


def accepted(project, operation, request):
    return (
        tissue.peek_preview(project, request)["receipt"]["request"]
        if operation == "tissue_model_run"
        else tissue.validate_request(request)
    )


def preflight(workbench, operation, request, *, policy=None):
    value = accepted(workbench.project, operation, request)
    source = workbench.project.source(value["source_id"])
    tissue._validate_source_request(source, value)
    if policy is not None:
        policy.require_tissue_output(value)
        if value["working_bytes"] > policy.memory_bytes:
            raise PermissionError("Tissue working-memory budget exceeds the policy")
        for binding in tissue.source_bindings(workbench.project, operation, request):
            grant = policy.source_grant(workbench.project, binding["source_id"])
            if grant.sha256 != binding["source_sha256"] or not grant.allows(
                binding["selection"], []
            ):
                raise PermissionError(
                    "Tissue normalization context or output selection exceeds the grant"
                )
        policy.require_runtime(policy_runtime())
        policy.require_model(puma_profile()["model"])
        policy.recheck()
    return value


def execute(workbench, operation, request, *, job_id=None, publication_guard=None):
    def guard():
        supervisor = getattr(workbench, "_tissue_supervisor_pid", None)
        if supervisor is not None and os.getppid() != supervisor:
            raise ValueError("The native tissue supervisor exited before publication")
        if publication_guard is not None:
            publication_guard()
        preflight(workbench, operation, request)
        if job_id is not None:
            job = workbench.project.job(job_id)
            normalized = {
                "source_id": accepted(workbench.project, operation, request)["source_id"],
                "task_request": request,
            }
            if (
                job["operation"] != operation
                or job["state"] != "running"
                or job["cancel_requested"]
                or job["request"] != normalized
                or job["request_hash"]
                != tissue._hash({"operation": operation, "request": normalized})
            ):
                raise ValueError("Tissue operation requires its exact running job")

    guard()
    if operation == "tissue_model_status":
        output = tissue.execute(workbench, operation, request, check=guard)
        managed = store.inspect_store(model_root(), check=guard, verify=False)
        output["store"] = managed
        output["status"]["weights"] = {"status": managed["state"], "verified": False}
        output["status"]["status"] = (
            "compatibility-unverified"
            if managed["provisioned"]
            and output["status"]["runtime"]["status"] == "metadata-matches-unverified"
            else "unavailable"
        )
        guard()
        return output
    if job_id is None or not getattr(workbench, "_exclusive_tissue_worker", False):
        raise ValueError("Tissue inference requires an exclusive disposable durable task worker")
    weights = store.resolve_approved_weights(model_root(), check=guard)
    guard()
    return tissue.execute(
        workbench, operation, request, weights=weights, job_id=job_id, check=guard
    )


def authorize_retained(policy, workbench, result):
    tissue.validate_record(result)
    value = result["provenance"]["tissue_model"]["receipt"]["request"]
    policy.require_tissue_output(value)
    tissue._validate_source_request(workbench.project.source(value["source_id"]), value)
    for selection in (value["context_selection"], value["output_selection"]):
        grant = policy.source_grant(workbench.project, value["source_id"])
        if grant.sha256 != value["source_sha256"] or not grant.allows(selection, []):
            raise PermissionError(
                "Tissue normalization context or output selection exceeds the grant"
            )
    policy.require_runtime(result["provenance"]["host_runtime"])
    policy.require_model(puma_profile()["model"])
    policy.recheck()


def project_records(project, result, *, check=None, arrays=False, working_bytes=None):
    """Resolve metadata ancestry before any pixels; never load source/model data."""
    guard = check or (lambda: None)
    records, sources, current = {}, {}, result
    for _ in range(tissue.MAX_PARENT_DEPTH):
        guard()
        tissue.validate_record(current)
        if current["id"] in records:
            raise ValueError("Cyclic tissue correction ancestry")
        records[current["id"]] = current
        sources[current["source_id"]] = project.source(current["source_id"])
        if not current.get("parent_id"):
            break
        # Metadata-only result() does not recurse through this resolver.
        current = project.result(current["parent_id"], check=guard, verify_scientific_arrays=False)
    else:
        raise ValueError("Tissue correction ancestry exceeds its bounded depth")
    for record in records.values():
        byte_count = sum(item["bytes"] for item in record["arrays"].values())
        budget = record["provenance"]["working_bytes"]
        if working_bytes is not None:
            if type(working_bytes) is not int or working_bytes <= 0:
                raise ValueError("Tissue working-memory budget must be a positive integer")
            budget = min(budget, working_bytes)
        if byte_count * 8 > budget:
            raise ValueError("Tissue arrays exceed the working-memory budget before decode")
    tissue.validate_portable_references(
        result, records, sources, array_loader=project.load_array if arrays else None, check=guard
    )
    return records


@contextmanager
def _native_lifetime():
    """Catch native termination without throwing inside Popen's spawn window.

    The child owns a new session. Graceful supervisor loss must unwind through
    its group cleanup; SIGKILL cannot run this code and is covered separately by
    the child's pinned-parent publication guard and independent resource limits.
    """
    terminated, disconnected = None, False
    parent_pid = os.getppid()
    previous = {}
    pipe_watch = None

    def capture(signum, _frame):
        nonlocal terminated
        terminated = signum

    try:
        # Native JSON dispatch is serial on the main thread. Failure to install
        # these handlers refuses before any inference child can be created.
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, capture)
        pipes = []
        for stream, output in ((sys.stdin, False), (sys.stdout, True)):
            try:
                fd = stream.fileno()
                if stat.S_ISFIFO(os.fstat(fd).st_mode):
                    pipes.append((fd, output))
            except (AttributeError, OSError, ValueError):
                continue
        if hasattr(select, "poll"):
            pipe_watch = select.poll()
            for fd, _ in pipes:
                pipe_watch.register(fd, select.POLLHUP | select.POLLERR)

            def pipe_closed():
                return any(
                    flags & (select.POLLHUP | select.POLLERR) for _, flags in pipe_watch.poll(0)
                )
        elif hasattr(select, "kqueue"):
            pipe_watch = select.kqueue()
            changes = [
                select.kevent(
                    fd,
                    filter=select.KQ_FILTER_WRITE if output else select.KQ_FILTER_READ,
                    flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                )
                for fd, output in pipes
            ]
            pipe_watch.control(changes, 0, 0)

            def pipe_closed():
                return any(
                    event.flags & (select.KQ_EV_EOF | select.KQ_EV_ERROR)
                    for event in pipe_watch.control(None, max(1, len(pipes)), 0)
                )
        else:
            raise ValueError("Native tissue supervision requires POSIX pipe-disconnect detection")

        def check():
            nonlocal disconnected
            disconnected = os.getppid() != parent_pid or pipe_closed()
            if terminated is not None or disconnected:
                raise ValueError("Native tissue supervisor was terminated or disconnected")

        yield check
    finally:
        if pipe_watch is not None and hasattr(pipe_watch, "close"):
            pipe_watch.close()
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if terminated is not None or disconnected:
            # Do not return to the JSON request loop after the caller has left.
            raise SystemExit(128 + terminated if terminated is not None else 1)


def run_disposable(project, job_id):
    with _native_lifetime() as check:
        return _run_disposable(project, job_id, check)


def _run_disposable(project, job_id, check):
    """Native JSON worker supervises one fresh CLI process; it never imports Torch."""
    from .research_jobs import public_job
    from .research_process import research_command

    job = project.job(job_id)
    if job["operation"] not in TASKS or job.get("owner") is not None:
        raise ValueError("Native tissue child requires an unowned exact tissue job")
    if job["state"] != "queued":
        return {"job": public_job(job)}
    check()
    request = accepted(project, job["operation"], job["request"]["task_request"])
    command = research_command(
        [
            "run",
            "--project",
            str(project.root),
            "--job",
            job_id,
            "--cpu-seconds",
            "600",
            "--memory-bytes",
            str(request["working_bytes"]),
            "--supervisor-pid",
            str(os.getpid()),
        ]
    )
    child = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        close_fds=True,
        start_new_session=True,
    )
    selector, output, errors = selectors.DefaultSelector(), bytearray(), bytearray()
    assert child.stdout is not None and child.stderr is not None
    try:
        for stream, name in ((child.stdout, "output"), (child.stderr, "error")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        deadline = time.monotonic() + 1200
        while selector.get_map():
            check()
            current = project.job(job_id)
            if current["cancel_requested"] or time.monotonic() >= deadline:
                raise ValueError("Tissue task was cancelled or exceeded its wall deadline")
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                target = output if key.data == "output" else errors
                limit = 9 * 1024**2 if key.data == "output" else 8192
                if len(target) + len(chunk) > limit:
                    raise ValueError("Tissue task exceeded its bounded response size")
                target.extend(chunk)
        child.wait(timeout=2)
        check()
        if child.returncode != 0:
            state = project.job(job_id)["state"]
            raise ValueError(
                f"Tissue worker exited unsuccessfully; durable job state is {state}. "
                "Inspect the job and its retained result IDs before retrying."
            )
        value = parse_json(output.decode())
        if not isinstance(value, dict) or value.get("job") != public_job(project.job(job_id)):
            raise ValueError("Tissue task reply does not match its durable job")
        return value
    finally:
        selector.close()
        with suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()
        current = project.job(job_id)
        if current["state"] in {"queued", "running"}:
            project.update_job(
                job_id,
                expected_state=current["state"],
                state="cancelled" if current["cancel_requested"] else "failed",
                finished_at=timestamp(),
                error="Tissue child stopped before publication",
            )
