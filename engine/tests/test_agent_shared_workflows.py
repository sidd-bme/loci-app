"""Native numerical oracles and policy boundaries for shared workflow actions."""

import copy
import json
from dataclasses import replace

import numpy as np
import pytest
import tifffile
from test_agent_actions import actions_agent
from test_experiment_intensity import request as intensity_request
from test_experiment_intensity import sample
from test_research_workflow import definition

from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.research_action_registry import (
    ACTION_NAMES,
    EXECUTION_KINDS,
    PREVIEW_ACTIONS,
    READ_ACTIONS,
    TASK_ACTIONS,
    action_guide,
)
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_project import canonical_json
from loci_engine.workbench import runtime_record


@pytest.fixture
def scene(tmp_path):
    agent, workbench, result, *rest = actions_agent(tmp_path)
    result = workbench.project.result(result["id"])
    yield agent, workbench, result, rest
    workbench.close()


def plane():
    return {"x": 0, "y": 0, "width": 32, "height": 32, "t": 0, "c": 0, "z": 1, "level": 0}


def workflow_binding(workbench, result):
    saved = workbench.execute(
        "workflow_save",
        {
            "workflow_id": "a" * 32,
            "expected_revision": 0,
            "definition": definition(),
        },
    )["workflow"]
    return {
        "workflow_id": saved["id"],
        "workflow_revision": saved["revision"],
        "definition_sha256": saved["data"]["definition_sha256"],
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "selection": plane(),
    }


def exploration(result):
    return {
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "selection": plane(),
        "threshold": 50,
        "min_size": 0,
    }


def bound(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def gate():
    return {
        "kind": "rectangle",
        "x_metric": "voxel_count",
        "y_metric": "measure",
        "bounds": [128, 128, 128, 128],
    }


def test_execution_contract_distinguishes_preview_from_mutation():
    assert ACTION_NAMES == READ_ACTIONS | TASK_ACTIONS == set(EXECUTION_KINDS)
    assert {"workflow_preview", "exploration_preview", "exploration_compare"} == PREVIEW_ACTIONS
    guide = {item["operation"]: item for item in action_guide()["actions"]}
    assert guide["workflow_preview"]["execution_kind"] == "preview-task"
    assert guide["exploration_compare"]["side_effects"] == "saved-comparison-receipt"
    assert guide["workflow_run"]["execution_kind"] == "publication-task"
    assert guide["study_summary"]["execution_kind"] == "inspection"
    assert (
        not {"workflow_save", "population_group_save", "intensity_save", "cellpose_run"}
        & ACTION_NAMES
    )


def test_workflow_preflight_preview_run_status_share_native_math(scene):
    agent, workbench, result, _ = scene
    request = workflow_binding(workbench, result)
    resolved = inspect_action(agent, workbench, "workflow_preflight", request)
    assert resolved["selection"] == plane()
    preview = {**request, "target_node_id": "population"}
    with pytest.raises(ValueError, match="inspection or durable-task"):
        authorize_action(agent, workbench, "workflow_preview", preview, mode="read")
    normalized = authorize_action(agent, workbench, "workflow_preview", preview, mode="task")
    job = submit_job(workbench, normalized, "workflow-preview", "workflow_preview")
    output = run_job(workbench, job["id"])
    assert output["object_count"] == 1
    assert output["population"]["filtered_count"] == 1
    assert len(workbench.project.list_results()) == 1
    normalized = authorize_action(agent, workbench, "workflow_run", request, mode="task")
    job = submit_job(workbench, normalized, "workflow-adopt", "workflow_run")
    run_job(workbench, job["id"])
    status = inspect_action(agent, workbench, "workflow_status", {"run_id": job["id"]})
    produced = workbench.project.result(status["run"]["data"]["result_id"])
    # Independently known source: one 8x8 square of raw intensity 100;
    # subtraction affects segmentation, raw measurements remain unchanged.
    assert produced["provenance"]["measurements"][0]["voxel_count"] == 64
    assert produced["provenance"]["measurements"][0]["measure"] == 64
    assert (
        next(iter(produced["provenance"]["measurements"][0]["intensity"].values()))["mean"] == 100
    )
    assert status["state"] == "waiting_review"


@pytest.mark.parametrize(
    "change", ["revision", "definition", "source", "channel", "memory", "runtime"]
)
def test_workflow_stale_scope_and_runtime_fail_before_job(scene, change):
    agent, workbench, result, _ = scene
    request = workflow_binding(workbench, result)
    if change == "revision":
        request["workflow_revision"] += 1
    elif change == "definition":
        request["definition_sha256"] = "f" * 64
    elif change == "source":
        request["source_sha256"] = "f" * 64
    elif change == "channel":
        request["selection"]["c"] = 1
    elif change == "memory":
        agent.policy = replace(agent.policy, memory_bytes=16 * 1024**2)
    else:
        agent.policy = replace(agent.policy, runtimes=[])
    with pytest.raises((PermissionError, ValueError)):
        authorize_action(agent, workbench, "workflow_run", request, mode="task")
    assert workbench.project.list_jobs() == []


def test_exploration_matrix_authorizes_every_crop_before_native_execution(scene):
    agent, workbench, result, _ = scene
    request = exploration(result)
    request = {key: request[key] for key in ("source_id", "source_sha256")}
    request.update(regions=[plane(), {**plane(), "c": 1}], configurations=[{"threshold": 50}])
    with pytest.raises((PermissionError, ValueError)):
        authorize_action(agent, workbench, "exploration_compare", request, mode="task")
    request["regions"] = [
        {**plane(), "width": 16, "height": 16},
        {**plane(), "x": 16, "width": 16, "height": 16},
    ]
    request["configurations"] = [{"threshold": 50}, {"threshold": 150}]
    authorized = authorize_action(agent, workbench, "exploration_compare", request, mode="task")
    job = submit_job(workbench, authorized, "comparison", "exploration_compare")
    output = run_job(workbench, job["id"])
    assert [cell["object_count"] for cell in output["cells"]] == [1, 0, 0, 0]
    assert len(workbench.project.list_results()) == 1
    receipt = output["cells"][0]["receipt_json"]
    adopted = authorize_action(
        agent, workbench, "exploration_run", {"receipt_json": receipt}, mode="task"
    )
    job = submit_job(workbench, adopted, "adopt-comparison", "exploration_run")
    run_job(workbench, job["id"])
    assert len(workbench.project.list_results()) == 2


def test_exploration_list_filters_unauthorized_saved_channels_before_disclosure(scene):
    agent, workbench, result, _ = scene
    source = {key: exploration(result)[key] for key in ("source_id", "source_sha256")}
    allowed = workbench.execute(
        "exploration_compare",
        {**source, "regions": [plane()], "configurations": [{"threshold": 50}]},
    )
    hidden = workbench.execute(
        "exploration_compare",
        {**source, "regions": [{**plane(), "c": 1}], "configurations": [{"threshold": 10}]},
    )
    listing = inspect_action(agent, workbench, "exploration_list", source)
    assert [item["id"] for item in listing["comparisons"]] == [allowed["comparison"]["id"]]
    assert hidden["comparison"]["id"] not in canonical_json(listing)
    with pytest.raises(PermissionError):
        inspect_action(
            agent,
            workbench,
            "exploration_get",
            {**source, "comparison_id": hidden["comparison"]["id"]},
        )


def test_population_exact_membership_group_and_stale_revision(scene):
    agent, workbench, result, _ = scene
    evaluated = inspect_action(
        agent, workbench, "population_gate_evaluate", {**bound(result), "gate": gate()}
    )
    assert evaluated["labels"] == [1]
    assert evaluated["included_count"] == evaluated["total_count"] == 1
    group = workbench.execute(
        "population_group_save",
        {
            **bound(result),
            "gate": gate(),
            "name": "Exact square",
            "membership_sha256": evaluated["membership_sha256"],
        },
    )
    listing = inspect_action(agent, workbench, "population_group_list", bound(result))
    assert [item["id"] for item in listing["groups"]] == [group["id"]]
    reopened = inspect_action(
        agent,
        workbench,
        "population_group_get",
        {**bound(result), "group_id": group["id"], "include_centroids": True},
    )
    assert reopened["membership"]["labels"] == [1]
    assert reopened["membership"]["centroids"][0]["centroid_index"] == [1.5, 7.5, 7.5]
    with pytest.raises(PermissionError, match="revision"):
        inspect_action(
            agent, workbench, "population_group_list", {**bound(result), "revision_hash": "f" * 64}
        )
    with pytest.raises(ValueError, match="missing"):
        authorize_action(agent, workbench, "population_group_list", {})


def test_summary_intensity_exact_raw_mean_and_saved_report_leakage(scene, tmp_path):
    agent, workbench, result, _ = scene
    sample(workbench.project, result)
    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    summary = inspect_action(agent, workbench, "study_summary", {"result_ids": [result["id"]]})
    assert summary == workbench.execute("study_summary", {"result_ids": [result["id"]]})
    catalog = inspect_action(agent, workbench, "intensity_catalog", {"result_ids": [result["id"]]})
    metric = catalog["results"][0]["descriptors"][0]
    request = intensity_request([result], channel=metric["channel"])
    preview = inspect_action(agent, workbench, "intensity_preview", request)
    report = json.loads(preview["report_json"])
    assert report["images"][0]["mean"] == 100
    assert report["replicates"][0]["mean"] == 100
    assert report["conditions"][0]["mean"] == 100
    saved = workbench.execute("intensity_save", preview)
    reopened = inspect_action(agent, workbench, "intensity_get", {"report_id": saved["report_id"]})
    assert reopened["report"] == report
    image = tmp_path / "unauthorized.tif"
    tifffile.imwrite(image, np.ones((4, 4), np.uint16))
    unauthorized = workbench.import_native(str(image))
    hidden_result = workbench.run_recipe(
        {
            "source_id": unauthorized["id"],
            "selection": {},
            "recipe": {
                "segmentation": {"method": "components", "threshold": 0},
                "measurement_channels": [0],
            },
        }
    )["result"]
    hidden_result = workbench.project.result(hidden_result["id"])
    sample(workbench.project, hidden_result)
    workbench.project.review(hidden_result["id"], hidden_result["revision_hash"], "reviewed")
    hidden_catalog = workbench.execute("intensity_catalog", {"result_ids": [hidden_result["id"]]})
    hidden_metric = hidden_catalog["results"][0]["descriptors"][0]
    hidden_preview = workbench.execute(
        "intensity_preview", intensity_request([hidden_result], channel=hidden_metric["channel"])
    )
    hidden_saved = workbench.execute("intensity_save", hidden_preview)
    listing = inspect_action(agent, workbench, "intensity_list", {})
    assert [item["id"] for item in listing["reports"]] == [saved["report_id"]]
    assert unauthorized["id"] not in canonical_json(listing)
    with pytest.raises((ValueError, PermissionError)):
        inspect_action(agent, workbench, "intensity_get", {"report_id": hidden_saved["report_id"]})


def test_result_runtime_and_secondary_reference_are_not_implicit_grants(scene, tmp_path):
    agent, workbench, result, _ = scene
    agent.policy = replace(agent.policy, runtimes=[])
    with pytest.raises(PermissionError, match="runtime"):
        inspect_action(agent, workbench, "intensity_catalog", {"result_ids": [result["id"]]})
    agent.policy = replace(agent.policy, runtimes=[runtime_record()])
    image = tmp_path / "reference.tif"
    tifffile.imwrite(image, np.ones((32, 32), np.uint16))
    source = workbench.import_native(str(image))
    parent = copy.deepcopy(result["provenance"])
    parent["references"] = {
        "flat": {"source_id": source["id"], "source_sha256": source["sha256"], "selection": plane()}
    }
    child = workbench.project.save_result(
        source_id=result["source_id"],
        kind="segmentation",
        arrays={"labels": workbench.project.load_array(result["arrays"]["labels"])},
        provenance=parent,
    )
    with pytest.raises(PermissionError, match="source identity"):
        inspect_action(agent, workbench, "intensity_catalog", {"result_ids": [child["id"]]})


def test_scoped_inspection_never_uses_unfiltered_native_document_enumeration(scene, monkeypatch):
    agent, workbench, result, _ = scene
    request = workflow_binding(workbench, result)
    original = workbench.project.documents

    def guarded(kind, *, document_id=None):
        if (
            kind
            in {
                "workflow",
                "workflow_run",
                "workflow_export",
                "exploration",
                "population_group",
                "sample",
                "intensity_report",
            }
            and document_id is None
        ):
            raise AssertionError("Unfiltered native document enumeration")
        return original(kind, document_id=document_id)

    monkeypatch.setattr(workbench.project, "documents", guarded)
    listing = inspect_action(agent, workbench, "workflow_list", {})
    assert len(listing["workflows"]) == 1
    assert (
        inspect_action(agent, workbench, "workflow_get", {"workflow_id": request["workflow_id"]})[
            "workflow"
        ]["id"]
        == request["workflow_id"]
    )
    assert inspect_action(agent, workbench, "population_group_list", bound(result))["groups"] == []


def test_task_preview_get_retrieves_owned_output_through_disposable_worker(scene):
    agent, workbench, result, _ = scene
    request = {**workflow_binding(workbench, result), "target_node_id": "measure"}
    normalized = authorize_action(agent, workbench, "workflow_preview", request, mode="task")
    job = submit_job(
        workbench, normalized, "owned-preview", "workflow_preview", owner=agent.job_owner
    )
    output = run_job(workbench, job["id"])
    response = agent.inspect_action("task_preview_get", {"job_id": job["id"]})
    preview = response["preview"]
    assert preview["job_id"] == job["id"]
    assert preview["source_id"] == result["source_id"]
    assert preview["adopted"] is False
    assert preview["output"]["object_count"] == 1
    assert preview["output"]["measurements"][0]["measure"] == 64
    assert canonical_json(preview["output"]) == canonical_json(
        {key: value for key, value in output.items() if key != "job"}
    )
    assert len(workbench.project.list_results()) == 1
    # A different policy's identical numerical request grants no job access.
    foreign = submit_job(
        workbench,
        normalized,
        "foreign-preview",
        "workflow_preview",
        owner={"policy_sha256": "f" * 64, "session_id": None},
    )
    run_job(workbench, foreign["id"])
    with pytest.raises(PermissionError, match="different policy or session"):
        inspect_action(agent, workbench, "task_preview_get", {"job_id": foreign["id"]})
    agent.policy = replace(agent.policy, runtimes=[])
    with pytest.raises(PermissionError, match="runtime"):
        inspect_action(agent, workbench, "task_preview_get", {"job_id": job["id"]})


def test_retained_preview_rechecks_exact_workflow_revision_without_replay(scene):
    agent, workbench, result, _ = scene
    request = {**workflow_binding(workbench, result), "target_node_id": "measure"}
    normalized = authorize_action(agent, workbench, "workflow_preview", request, mode="task")
    job = submit_job(
        workbench, normalized, "stale-preview", "workflow_preview", owner=agent.job_owner
    )
    run_job(workbench, job["id"])
    changed = definition()
    changed["name"] = "New human revision"
    workbench.execute(
        "workflow_save",
        {"workflow_id": request["workflow_id"], "expected_revision": 1, "definition": changed},
    )
    with pytest.raises(ValueError, match="workflow changed"):
        inspect_action(agent, workbench, "task_preview_get", {"job_id": job["id"]})
    assert len(workbench.project.list_jobs()) == 1
    assert len(workbench.project.list_results()) == 1
