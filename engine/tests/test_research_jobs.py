import json
import os

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import cancel_job, reconcile_jobs, run_job, submit_job
from loci_engine.research_project import ResearchProject
from loci_engine.research_rpc import dispatch_research
from loci_engine.workbench import Workbench


@pytest.fixture
def task(tmp_path):
    file = tmp_path / "source.tif"
    image = np.zeros((32, 32), np.uint16)
    image[2:6, 5:9] = 100
    tifffile.imwrite(file, image)
    workbench = Workbench(ResearchProject.create(tmp_path / "study", "Study"))
    source = workbench.import_native(str(file))
    request = {
        "source_id": source["id"],
        "recipe": {
            "segmentation": {"method": "components", "threshold": 50},
        },
    }
    return workbench, request


def test_repeat_submission_and_atomic_result_recovery(task):
    workbench, request = task
    job = submit_job(workbench, request, "client-1")
    assert submit_job(workbench, request, "client-1")["id"] == job["id"]
    output = run_job(workbench, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert output["job"]["result_ids"] == [output["result"]["id"]]
    reopened = Workbench(ResearchProject(workbench.project.root))
    assert run_job(reopened, job["id"])["job"] == output["job"]
    assert len(reopened.project.list_results()) == 1
    result = reopened.project.result(output["result"]["id"])
    assert result["provenance"]["job_id"] == job["id"]
    with pytest.raises(ValueError, match="different parameters"):
        submit_job(workbench, {**request, "selection": {"x": 1}}, "client-1")


def test_policy_revoked_at_publication_leaves_no_accepted_result(task):
    workbench, request = task
    job = submit_job(workbench, request, "guarded-run")

    def denied():
        raise PermissionError("Policy was revoked")

    with pytest.raises(PermissionError, match="revoked"):
        run_job(workbench, job["id"], publication_guard=denied)
    assert workbench.project.list_results() == []
    assert workbench.project.job(job["id"])["state"] == "failed"


def test_different_processes_share_atomic_project_execution_capacity(task):
    workbench, request = task
    first = submit_job(workbench, request, "first-server")
    workbench.project.update_job(
        first["id"], expected_state="queued", state="running", pid=os.getpid(), max_running=1
    )
    second = submit_job(workbench, request, "second-server")
    isolated = Workbench(ResearchProject(workbench.project.root))
    output = run_job(isolated, second["id"], max_concurrency=1)
    assert output["job"]["state"] == "failed"
    assert "concurrent" in output["job"]["error"]
    assert not workbench.project.list_results()


def test_cancel_before_and_during_publication_never_accepts_result(task, monkeypatch):
    workbench, request = task
    queued = submit_job(workbench, request, "queued")
    assert cancel_job(workbench.project, queued["id"])["state"] == "cancelled"
    assert run_job(workbench, queued["id"])["job"]["state"] == "cancelled"
    job = submit_job(workbench, request, "running")
    store = workbench.project.store_array

    def cancel_while_staging(array):
        receipt = store(array)
        cancel_job(workbench.project, job["id"])
        return receipt

    monkeypatch.setattr(workbench.project, "store_array", cancel_while_staging)
    with pytest.raises(ValueError, match="cancelled"):
        run_job(workbench, job["id"])
    assert workbench.project.job(job["id"])["state"] == "cancelled"
    assert workbench.project.list_results() == []


def test_interrupted_process_requires_explicit_new_submission(task, monkeypatch):
    workbench, request = task
    job = submit_job(workbench, request, "lost")
    workbench.project.update_job(job["id"], expected_state="queued", state="running", pid=12345)

    def lost(_pid, _signal):
        raise ProcessLookupError

    monkeypatch.setattr(os, "kill", lost)
    assert reconcile_jobs(workbench.project)[0]["state"] == "interrupted"
    assert submit_job(workbench, request, "lost")["state"] == "interrupted"
    assert workbench.project.list_results() == []


def test_rpc_paths_do_not_enter_public_receipts_and_no_review_via_execute(task):
    workbench, request = task
    params = {"project": str(workbench.project.root)}
    snapshot = dispatch_research("research_snapshot", params)
    assert str(workbench.project.root.parent) not in json.dumps(snapshot)
    with pytest.raises(ValueError, match="Unknown"):
        dispatch_research("research_execute", {**params, "operation": "review", "request": {}})
    with pytest.raises(ValueError, match="durable"):
        dispatch_research(
            "research_execute", {**params, "operation": "run_recipe", "request": request}
        )
    job = dispatch_research("research_submit", {**params, "request": request, "request_key": "rpc"})
    output = dispatch_research("research_run", {**params, "job_id": job["id"]})
    assert output["job"]["state"] == "succeeded"
    assert "pid" not in output["job"]


@pytest.mark.parametrize(
    "changes",
    [
        {"progress": float("nan")},
        {"progress": True},
        {"progress": 2},
        {"pid": -1},
        {"pid": True},
        {"cancel_requested": "yes"},
    ],
)
def test_invalid_job_state_is_rejected(task, changes):
    workbench, request = task
    job = submit_job(workbench, request, "validation")
    with pytest.raises(ValueError):
        workbench.project.update_job(job["id"], expected_state="queued", state="running", **changes)
