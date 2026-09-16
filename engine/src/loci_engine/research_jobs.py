"""Durable local task execution shared by manual and policy-bound clients."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from .research_operations import PREVIEW_OPERATIONS, TASK_OPERATIONS
from .research_project import ResearchProject, timestamp
from .resource_limits import process_alive
from .workbench import Workbench


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in job.items() if k not in {"pid"}}


def reconcile_jobs(project: ResearchProject) -> list[dict[str, Any]]:
    """Mark lost processes interrupted; never restart them or reuse a submission."""
    for job in project.list_jobs():
        if job["state"] != "running":
            continue
        pid = job.get("pid")
        alive = False if not isinstance(pid, int) or pid <= 0 else process_alive(pid)
        if not alive:
            try:
                project.update_job(
                    job["id"],
                    expected_state="running",
                    state="cancelled" if job["cancel_requested"] else "interrupted",
                    finished_at=timestamp(),
                    error="Execution stopped before publication; submit a new key to retry.",
                )
            except ValueError:
                # A live executor may have committed completion since this read.
                if project.job(job["id"])["state"] == "running":
                    raise
    return [public_job(job) for job in project.list_jobs()]


def submit_job(
    workbench: Workbench, request: dict[str, Any], key: str, operation: str = "run_recipe"
) -> dict[str, Any]:
    if operation not in TASK_OPERATIONS:
        raise ValueError("Unknown local task operation")
    if operation in {"run_recipe", "preview_recipe"}:
        validated = workbench.validate_recipe(request)
        normalized = {k: validated[k] for k in ("source_id", "selection", "recipe")}
    else:
        # Full numerical validation remains in the shared operation; only a
        # registered source can be bound to a durable task before it starts.
        if not isinstance(request, dict):
            raise ValueError("Task request must be an object")
        if operation in {"correct_result", "roi_add", "roi_import", "correct_tracks"}:
            parent = workbench.project.result(request.get("result_id"))
            if parent["revision_hash"] != request.get("revision_hash"):
                raise ValueError("Task revision is stale")
            source_id = parent["source_id"]
        elif operation in {"registration_preview", "registration_run", "resample_grid"}:
            if operation == "registration_run":
                from .research_registration import validated_preview_receipt

                binding = validated_preview_receipt(request).get("moving")
            else:
                binding = request.get("moving" if operation == "registration_preview" else "parent")
            if not isinstance(binding, dict):
                raise ValueError("Registration task needs an exact parent binding")
            parent = workbench.project.result(binding.get("result_id"))
            if parent["revision_hash"] != binding.get("revision_hash"):
                raise ValueError("Registration task parent revision is stale")
            source_id = parent["source_id"]
        elif operation == "associate_results":
            binding = request.get("cells")
            if not isinstance(binding, dict):
                raise ValueError("Association requires the exact cell result binding")
            parent = workbench.project.result(binding.get("result_id"))
            if parent["revision_hash"] != binding.get("revision_hash"):
                raise ValueError("Association input revision is stale")
            source_id = parent["source_id"]
        elif operation == "track_results":
            frames = request.get("frames")
            if (
                not isinstance(frames, list)
                or not 2 <= len(frames) <= 1000
                or not all(isinstance(frame, dict) for frame in frames)
            ):
                raise ValueError("Tracking task requires a bounded timed frame list")
            observed = next((frame for frame in frames if frame.get("result_id")), None)
            if observed is None:
                raise ValueError("Tracking requires observed result frames")
            parent = workbench.project.result(observed["result_id"])
            if parent["revision_hash"] != observed.get("revision_hash"):
                raise ValueError("Tracking input revision is stale")
            source_id = parent["source_id"]
        elif operation == "model_run":
            preview = next(
                (
                    item
                    for item in workbench.project.documents("model_preview")
                    if item["id"] == request.get("preview_id")
                ),
                None,
            )
            if preview is None or preview["data"]["preview_sha256"] != request.get(
                "preview_sha256"
            ):
                raise ValueError("Task requires the exact stored model preview")
            source_id = preview["data"]["source"]["id"]
        else:
            source_id = request.get("source_id")
        workbench.project.source(source_id, verify=True)
        normalized = {"source_id": source_id, "task_request": request}
    return public_job(workbench.project.submit(operation, normalized, key))


def cancel_job(project: ResearchProject, job_id: str) -> dict[str, Any]:
    job = project.job(job_id)
    if job["state"] not in {"running", "queued"}:
        return public_job(job)
    return public_job(
        project.update_job(
            job_id,
            expected_state=job["state"],
            cancel_requested=True,
            state="cancelled" if job["state"] == "queued" else "running",
        )
    )


def run_job(
    workbench: Workbench,
    job_id: str,
    *,
    publication_guard: Callable[[], None] | None = None,
    max_concurrency: int | None = None,
) -> dict[str, Any]:
    project = workbench.project
    job = project.job(job_id)
    if job["state"] != "queued":
        return {"job": public_job(job)}
    if job["operation"] not in TASK_OPERATIONS:
        raise ValueError("Unknown local task operation")
    try:
        project.update_job(
            job_id,
            expected_state="queued",
            state="running",
            pid=os.getpid(),
            started_at=timestamp(),
            max_running=max_concurrency,
        )
    except PermissionError:
        project.update_job(
            job_id,
            expected_state="queued",
            state="failed",
            error="The authorized concurrent execution limit was reached before execution.",
        )
        return {"job": public_job(project.job(job_id))}
    except ValueError:
        # Another caller claimed or cancelled this exact submission.
        return {"job": public_job(project.job(job_id))}
    try:
        preview = job["operation"] in PREVIEW_OPERATIONS
        if job["operation"] in {"run_recipe", "preview_recipe"}:
            output = workbench.run_recipe(
                job["request"], job_id=job_id, preview=preview, publication_guard=publication_guard
            )
        else:
            output = workbench.execute(
                job["operation"],
                job["request"]["task_request"],
                job_id=job_id,
                publication_guard=publication_guard,
            )
        if preview:
            if publication_guard is not None:
                publication_guard()
            if project.job(job_id)["cancel_requested"]:
                raise ValueError("The preview was cancelled before disclosure")
            project.update_job(
                job_id,
                expected_state="running",
                state="succeeded",
                progress=1.0,
                finished_at=timestamp(),
            )
        return {**output, "job": public_job(project.job(job_id))}
    except BaseException as exc:
        current = project.job(job_id)
        if current["state"] == "running":
            project.update_job(
                job_id,
                expected_state="running",
                finished_at=timestamp(),
                state="cancelled" if current["cancel_requested"] else "failed",
                # Source paths and untrusted metadata never enter job diagnostics.
                error=f"{type(exc).__name__}: execution stopped before publication.",
            )
        raise
