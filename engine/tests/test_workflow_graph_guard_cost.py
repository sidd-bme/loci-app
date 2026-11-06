"""Exact-job inner checks versus mandatory full atomic graph publication checks."""

# ruff: noqa: F811
import copy

import pytest
from test_research_tissue_models import make_case, preview, token  # noqa: F401
from test_research_workflow_graph import advance, call, graph_study, start  # noqa: F401
from test_workflow_graph_expansion import bound, prepare, prepared_tissue_graph

from loci_engine import research_annotation_evaluation as annotation
from loci_engine import research_tissue_integration as integration
from loci_engine import research_tissue_models as tissue
from loci_engine import research_workflow_graph as graph
from loci_engine.research_jobs import run_job


def queued_tissue_report(case):
    first = preview(case)
    reference = tissue.execute(
        case.wb, "tissue_model_run", token(first), weights=case.weights, check=lambda: None
    )["result"]
    definition, prepared = prepared_tissue_graph(case)
    definition["inputs"]["reference"] = "label-result"
    definition["nodes"].append(
        {
            "id": "report",
            "operation": "annotation_evaluation_run",
            "contract_version": 1,
            "inputs": {
                "prediction": {"node": "tissue", "port": "result"},
                "reference": {"input": "reference"},
            },
            "settings": {
                "semantics": "foreground-region",
                "iou_thresholds": [],
                "reference_declaration": "Technical fixture, not accuracy",
                "working_bytes": case.request["working_bytes"],
            },
        }
    )
    definition["outputs"]["report"] = {"node": "report", "port": "result"}
    request = prepare(case.wb, definition, {"prepared": prepared, "reference": bound(reference)})
    run = advance(case.wb, start(case.wb, request))
    return run, run["data"]["nodes"]["tissue"]["intent"]["job_id"], reference


def native_fixture_route(case, monkeypatch, tmp_path):
    """Exercise original run_job→Workbench→integration→tissue→save_result.

    Only the learned inference/weight store is an explicit fixture; all graph,
    native job, source, publication and transaction code is the real route.
    """
    monkeypatch.setenv("LOCI_MODEL_HOME", str(tmp_path / "models"))
    monkeypatch.setattr(
        integration.store, "resolve_approved_weights", lambda root, check: case.weights
    )
    case.wb._exclusive_tissue_worker = True

    def many_chunks(_weights, check):
        for _ in range(8):
            check()

    monkeypatch.setattr(tissue, "_verify_weights", many_chunks)


def test_tissue_chunk_callbacks_have_bounded_method_hashes_and_full_publication(
    make_case,
    monkeypatch,
    tmp_path,
):
    case = make_case()
    run, job_id, reference = queued_tissue_report(case)
    native_fixture_route(case, monkeypatch, tmp_path)
    original = annotation._software
    counts = {"method_hash": 0, "volatile_check": 0, "publication": 0, "full_plan": 0}

    def software():
        counts["method_hash"] += 1
        return original()

    def volatile():
        counts["volatile_check"] += 1

    publish = graph.guard_node_publication

    def full_publication(project, job):
        assert job["id"] == job_id
        counts["publication"] += 1
        return publish(project, job)

    validate = graph._validate_plan

    def full_plan(*args, **kwargs):
        counts["full_plan"] += 1
        return validate(*args, **kwargs)

    monkeypatch.setattr(graph, "_validate_plan", full_plan)
    monkeypatch.setattr(annotation, "_software", software)
    monkeypatch.setattr(graph, "guard_node_publication", full_publication)
    output = run_job(case.wb, job_id, publication_guard=volatile)
    assert output["job"]["state"] == "succeeded"
    assert counts["volatile_check"] >= 128
    assert counts["method_hash"] == 2  # initial full check + atomic full check
    assert counts["full_plan"] == 2  # unchanged chunks do not rebuild scientific receipts
    assert counts["publication"] == 1
    assert len(case.project.list_results()) == 2  # retained reference + exact candidate
    assert reference["id"] != output["result"]["id"]
    assert (
        call(case.wb, "status", {"run_id": run["id"]})["run"]["data"]["nodes"]["tissue"]["state"]
        == "succeeded"
    )


@pytest.mark.parametrize("change", ["method", "source", "reference", "workflow"])
def test_atomic_full_guard_rejects_late_tamper_without_result_or_success(
    make_case,
    monkeypatch,
    tmp_path,
    change,
):
    case = make_case()
    run, job_id, reference = queued_tissue_report(case)
    native_fixture_route(case, monkeypatch, tmp_path)
    before_results = case.project.list_results()
    artifacts = {p.name: p.read_bytes() for p in case.project.arrays.iterdir()}
    publish = graph.guard_node_publication
    original_result = case.project.result
    entered = []

    def late_change(project, job):
        assert job["id"] == job_id
        entered.append(job_id)
        if change == "method":
            native = annotation._software()
            monkeypatch.setattr(
                annotation, "_software", lambda: {**native, "kernel_sha256": "0" * 64}
            )
        elif change == "source":
            with case.path.open("ab") as stream:
                stream.write(b"changed-after-staging")
        elif change == "reference":
            read = project.result

            def result(identity, **kwargs):
                value = read(identity, **kwargs)
                return (
                    {**value, "revision_hash": "0" * 64} if identity == reference["id"] else value
                )

            monkeypatch.setattr(project, "result", result)
        else:
            documents = project.documents

            def docs(kind, **kwargs):
                values = documents(kind, **kwargs)
                return [
                    {**doc, "revision": doc["revision"] + 1}
                    if doc["id"] == run["data"]["workflow_id"]
                    else doc
                    for doc in values
                ]

            monkeypatch.setattr(project, "documents", docs)
        return publish(project, job)

    monkeypatch.setattr(graph, "guard_node_publication", late_change)
    with pytest.raises((ValueError, PermissionError)):
        run_job(case.wb, job_id)
    assert entered == [job_id]
    if change == "reference":
        monkeypatch.setattr(case.project, "result", original_result)
    assert case.project.list_results() == before_results
    job = case.project.job(job_id)
    assert job["state"] == "failed" and job["result_ids"] == []
    for name, content in artifacts.items():
        assert (case.project.arrays / name).read_bytes() == content
    # Newly staged content-addressed bytes may remain unreferenced, as before.
    # Nothing is adopted by a result or successful job after the full guard fails.


def test_cancel_after_artifact_staging_still_blocks_native_publication(
    make_case, monkeypatch, tmp_path
):
    case = make_case()
    run, job_id, _ = queued_tissue_report(case)
    native_fixture_route(case, monkeypatch, tmp_path)
    before = case.project.list_results()
    store = case.project.store_array
    cancelled = []

    def stage(array):
        artifact = store(array)
        if not cancelled:
            cancelled.append(True)
            call(case.wb, "cancel", {"run_id": run["id"]})
        return artifact

    monkeypatch.setattr(case.project, "store_array", stage)
    with pytest.raises((ValueError, PermissionError)):
        run_job(case.wb, job_id)
    assert cancelled == [True]
    assert case.project.list_results() == before
    assert case.project.job(job_id)["state"] == "cancelled"
    assert case.project.job(job_id)["result_ids"] == []


def test_direct_native_tissue_caller_cannot_bypass_atomic_graph_guard(
    make_case, monkeypatch, tmp_path
):
    case = make_case()
    _, job_id, _ = queued_tissue_report(case)
    native_fixture_route(case, monkeypatch, tmp_path)
    before = case.project.list_results()
    native = annotation._software()
    monkeypatch.setattr(annotation, "_software", lambda: {**native, "dispatcher_sha256": "0" * 64})
    job = case.project.update_job(job_id, expected_state="queued", state="running")
    with pytest.raises(ValueError, match="method|runtime identity changed"):
        integration.execute(
            case.wb, "tissue_model_run", job["request"]["task_request"], job_id=job_id
        )
    assert case.project.list_results() == before
    assert case.project.job(job_id)["state"] != "succeeded"
    assert case.project.job(job_id)["result_ids"] == []


@pytest.mark.parametrize("change", ["cancel", "source", "workflow"])
def test_inner_guard_keeps_volatile_state_live(graph_study, change):
    wb, request, source = graph_study
    run = advance(wb, start(wb, request))
    job = wb.project.job(run["data"]["nodes"]["cells"]["intent"]["job_id"])
    check = graph.node_job_inner_guard(wb, job)
    if change == "cancel":
        call(wb, "cancel", {"run_id": run["id"]})
    elif change == "source":
        with source.open("ab") as stream:
            stream.write(b"changed-after-initial-guard")
    else:
        saved = call(wb, "get", {"workflow_id": request["workflow_id"]})["workflow"]
        definition = copy.deepcopy(saved["data"]["definition"])
        definition["name"] = "Changed after exact-job initial validation"
        call(
            wb,
            "save",
            {
                "workflow_id": saved["id"],
                "expected_revision": saved["revision"],
                "definition": definition,
            },
        )
    with pytest.raises((ValueError, PermissionError)):
        check()
    assert wb.project.list_results() == []


def test_non_graph_publication_adds_no_graph_workbench_or_post_guard():
    assert graph.guard_node_publication(None, {"request_key": "ordinary-native-job"}) is False


def test_normal_job_progress_does_not_rebuild_scientific_plan(graph_study, monkeypatch):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    job = wb.project.job(run["data"]["nodes"]["cells"]["intent"]["job_id"])
    validate = graph._validate_plan
    calls = []

    def full(*args, **kwargs):
        calls.append(True)
        return validate(*args, **kwargs)

    monkeypatch.setattr(graph, "_validate_plan", full)
    check = graph.node_job_inner_guard(wb, job)
    assert len(calls) == 1
    wb.project.update_job(job["id"], expected_state="queued", state="running", progress=0.0)
    for index in range(10):
        wb.project.update_job(
            job["id"], expected_state="running", state="running", progress=index / 10
        )
        check()
    assert len(calls) == 1


def test_cached_snapshot_detects_job_owner_change_immediately(graph_study):
    from loci_engine.research_project import canonical_json

    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    job = wb.project.job(run["data"]["nodes"]["cells"]["intent"]["job_id"])
    check = graph.node_job_inner_guard(wb, job)
    changed = {**job, "owner": {"policy_sha256": "0" * 64, "session_id": None}}
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE jobs SET record=? WHERE id=?", (canonical_json(changed), job["id"])
        )
    with pytest.raises(PermissionError, match="ownership or exact request changed"):
        check()


def test_unrecognised_dependency_shape_keeps_full_guard(graph_study, monkeypatch):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    job = wb.project.job(run["data"]["nodes"]["cells"]["intent"]["job_id"])
    validate = graph._validate_plan
    calls = []

    def full(*args, **kwargs):
        calls.append(True)
        return validate(*args, **kwargs)

    monkeypatch.setattr(graph, "_validate_plan", full)
    monkeypatch.setattr(graph, "_node_watch_spec", lambda *_: None)
    check = graph.node_job_inner_guard(wb, job)
    check()
    assert len(calls) == 2
