"""Source-driven coordinator evidence over normal native jobs and atomic results."""

import copy
import hashlib
from uuid import uuid4

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_workflow_graph import execute_workflow_graph, guard_node_job
from loci_engine.workbench import Workbench


def allow(*args):
    return None


def call(wb, suffix, request, **kwargs):
    return execute_workflow_graph(
        wb,
        f"workflow_graph_{suffix}",
        request,
        authorize=kwargs.pop("authorize", allow),
        authorize_binding=kwargs.pop("authorize_binding", allow),
        **kwargs,
    )


def definition():
    return {
        "schema": "loci.workflow/v2",
        "name": "Native branching association",
        "inputs": {"image": "source-selection"},
        "nodes": [
            {
                "id": identity,
                "operation": "run_recipe",
                "contract_version": 1,
                "inputs": {"source": {"input": "image"}},
                "settings": {
                    "recipe": {
                        "segmentation": {"method": "components", "threshold": threshold},
                        "measurement_channels": [0],
                    }
                },
            }
            for identity, threshold in (("cells", 10), ("nuclei", 50))
        ]
        + [
            {
                "id": "join",
                "operation": "associate_results",
                "contract_version": 1,
                "inputs": {role: {"node": role, "port": "result"} for role in ("cells", "nuclei")},
                "settings": {
                    "roles": {"cells": "declared cell labels", "nuclei": "declared nucleus labels"},
                    "control": "Generated technical fixture",
                },
            }
        ],
        "outputs": {"associated": {"node": "join", "port": "result"}},
        "working_bytes": 16 * 1024**2,
    }


@pytest.fixture
def graph_study(tmp_path):
    path = tmp_path / "native.ome.tif"
    image = np.zeros((12, 16), np.uint16)
    image[3:8, 4:10] = 20
    image[4:6, 5:7] = 100
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 1.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "graph.loci-study", "Graph"))
    source = wb.import_native(str(path))
    selection = wb.selection(source["id"], {"level": 0})
    workflow = call(
        wb, "save", {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": definition()}
    )["workflow"]
    binding = {
        "workflow_id": workflow["id"],
        "workflow_revision": workflow["revision"],
        "definition_sha256": workflow["data"]["definition_sha256"],
        "bindings": {
            "image": {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "selection": selection,
            }
        },
    }
    plan = call(wb, "preflight", binding)["plan"]
    request = {**binding, "plan_sha256": plan["plan_sha256"], "request_key": "technical-graph"}
    return wb, request, path


def start(wb, request):
    return call(wb, "start", request)["run"]


def advance(wb, run, **kwargs):
    return call(wb, "advance", {"run_id": run["id"]}, **kwargs)["run"]


def run_child(wb, run, identity):
    job_id = run["data"]["nodes"][identity]["intent"]["job_id"]
    return run_job(wb, job_id, publication_guard=lambda: guard_node_job(wb, wb.project.job(job_id)))


def test_normal_native_jobs_branch_join_and_cold_resume(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    assert run["data"]["state"] == "prepared" and not wb.project.list_jobs()
    run = advance(wb, run)
    run_child(wb, run, "cells")
    # Re-open after a successful native publication but before coordinator ack.
    wb = Workbench(ResearchProject(wb.project.root))
    run = advance(wb, run)
    assert run["data"]["nodes"]["cells"]["state"] == "succeeded"
    run_child(wb, run, "nuclei")
    run = advance(wb, run)
    run_child(wb, run, "join")
    status = call(wb, "status", {"run_id": run["id"]})
    assert status["state"] == "succeeded"
    jobs = wb.project.list_jobs()
    assert len(jobs) == 3 and len({job["id"] for job in jobs}) == 3
    assert all(job["id"] != run["id"] for job in jobs)
    assert len(status["partial_results"]) == 3
    final = status["run"]["data"]["outputs"]["associated"]
    result = wb.project.result(final["result_id"])
    assert result["kind"] == "nucleus-cell-association"
    assert result["provenance"]["job_id"] == jobs[2]["id"]
    assert all(wb.project.review_state(job["result_ids"][0]) is None for job in jobs)
    assert start(wb, request)["id"] == run["id"]
    assert advance(wb, run)["data"]["state"] == "succeeded"
    assert len(wb.project.list_jobs()) == 3


def test_intent_is_persisted_before_submission_and_recovers_lost_response(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    observed = []

    def lost_response(workbench, operation, body, key):
        saved = wb.project.documents("workflow_run", document_id=run["id"])[0]
        intent = saved["data"]["nodes"]["cells"]["intent"]
        observed.append(intent["request_key"] == key and intent["request"] == body)
        submit_job(workbench, body, key, operation=operation)
        raise ConnectionError("lost submit response")

    with pytest.raises(ConnectionError):
        advance(wb, run, submit=lost_response)
    assert observed == [True] and len(wb.project.list_jobs()) == 1
    run = advance(wb, run)
    assert len(wb.project.list_jobs()) == 2  # next independent branch can now queue
    assert run["data"]["nodes"]["cells"]["intent"]["job_id"] == wb.project.list_jobs()[0]["id"]


def test_crash_before_submission_reuses_same_intent_and_key(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    keys = []

    def stopped(workbench, operation, body, key):
        keys.append(key)
        raise ConnectionError("before native submission")

    with pytest.raises(ConnectionError):
        advance(wb, run, submit=stopped)
    assert not wb.project.list_jobs()
    run = advance(wb, run)
    assert wb.project.list_jobs()[0]["request_key"] == keys[0]
    assert run["data"]["nodes"]["cells"]["intent"]["request_key"] == keys[0]


def test_publication_is_recovered_without_rerun_or_duplicate_result(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)

    def published_then_lost(workbench, operation, body, key):
        job = submit_job(workbench, body, key, operation=operation)
        run_job(
            workbench,
            job["id"],
            publication_guard=lambda: guard_node_job(workbench, workbench.project.job(job["id"])),
        )
        raise ConnectionError("lost successful publication response")

    with pytest.raises(ConnectionError):
        advance(wb, run, submit=published_then_lost)
    assert len(wb.project.list_results()) == 1
    recovered = call(wb, "status", {"run_id": run["id"]})
    assert recovered["run"]["data"]["nodes"]["cells"]["state"] == "succeeded"
    assert len(wb.project.list_results()) == len(wb.project.list_jobs()) == 1


def test_cancel_stops_future_nodes_and_preserves_unreviewed_partial_results(graph_study):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    run_child(wb, run, "cells")
    run = advance(wb, run)  # acknowledge cells, queue nuclei
    cancelled = call(wb, "cancel", {"run_id": run["id"]})
    assert cancelled["state"] == "cancelled"
    assert len(cancelled["partial_results"]) == 1
    assert wb.project.list_jobs()[1]["state"] == "cancelled"
    assert len(wb.project.list_results()) == 1
    assert advance(wb, run)["data"]["state"] == "cancelled"
    assert len(wb.project.list_jobs()) == 2
    assert wb.project.review_state(cancelled["partial_results"][0]["result_id"]) is None


def test_cancel_racing_submission_blocks_native_publication(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)

    def raced(workbench, operation, body, key):
        call(wb, "cancel", {"run_id": run["id"]})
        job = submit_job(workbench, body, key, operation=operation)
        with pytest.raises(PermissionError, match="stopped"):
            run_job(
                workbench,
                job["id"],
                publication_guard=lambda: guard_node_job(
                    workbench, workbench.project.job(job["id"])
                ),
            )
        return workbench.project.job(job["id"])

    run = advance(wb, run, submit=raced)
    assert run["data"]["cancel_requested"]
    assert not wb.project.list_results()
    assert wb.project.list_jobs()[0]["state"] == "cancelled"


def test_cancel_inflight_checks_guard_after_array_staging(graph_study, monkeypatch):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    original = wb.project.store_array
    cancelled = False

    def cancel_after_staging(array):
        nonlocal cancelled
        artifact = original(array)
        if not cancelled:
            cancelled = True
            call(wb, "cancel", {"run_id": run["id"]})
        return artifact

    monkeypatch.setattr(wb.project, "store_array", cancel_after_staging)
    with pytest.raises(PermissionError, match="stopped"):
        run_child(wb, run, "cells")
    assert wb.project.list_results() == []
    assert wb.project.list_jobs()[0]["state"] == "cancelled"


@pytest.mark.parametrize("mutation", ["source", "revision", "runtime", "saved_definition", "plan"])
def test_resume_rejects_changed_exact_identity(graph_study, mutation, monkeypatch):
    wb, request, path = graph_study
    run = start(wb, request)
    if mutation == "source":
        with path.open("ab") as stream:
            stream.write(b"changed")
    elif mutation == "saved_definition":
        changed = definition()
        changed["name"] = "Changed saved definition"
        call(
            wb,
            "save",
            {"workflow_id": request["workflow_id"], "expected_revision": 1, "definition": changed},
        )
    elif mutation == "runtime":
        from loci_engine import workbench

        original = workbench.runtime_record
        monkeypatch.setattr(
            workbench, "runtime_record", lambda: {**original(), "engine": "changed-runtime"}
        )
    elif mutation == "revision":
        request["workflow_revision"] = 2
        with pytest.raises(ValueError, match="changed"):
            call(wb, "start", request)
        return
    else:
        data = copy.deepcopy(run["data"])
        data["plan"]["runtime"]["engine"] = "changed-plan"
        with wb.project.connection() as connection:
            envelope = copy.deepcopy(run)
            envelope["data"] = data
            connection.execute(
                "UPDATE documents SET record=? WHERE kind='workflow_run' AND id=?",
                (canonical_json(envelope), run["id"]),
            )
    with pytest.raises(ValueError):
        advance(wb, run)
    assert not wb.project.list_jobs()


def test_every_resume_rechecks_input_request_and_completed_result_authority(graph_study):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    run_child(wb, run, "cells")
    seen = []

    def deny_result(workbench, kind, binding):
        seen.append(kind)
        if kind == "label-result":
            raise PermissionError("completed result authority revoked")

    with pytest.raises(PermissionError, match="revoked"):
        advance(wb, run, authorize_binding=deny_result)
    assert seen == ["source-selection", "label-result"]
    with pytest.raises(PermissionError):
        advance(
            wb,
            run,
            authorize=lambda *args: (_ for _ in ()).throw(PermissionError("request revoked")),
        )
    assert len(wb.project.list_jobs()) == 1


def test_execution_requires_explicit_current_authority_callbacks(graph_study):
    wb, request, _ = graph_study
    with pytest.raises(PermissionError, match="authority"):
        execute_workflow_graph(wb, "workflow_graph_start", request)
    assert not wb.project.documents("workflow_run")


def test_start_key_rejects_other_parameters_and_run_owner(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    changed = copy.deepcopy(request)
    changed["bindings"]["image"]["selection"]["width"] = 10
    changed["plan_sha256"] = call(
        wb,
        "preflight",
        {key: value for key, value in changed.items() if key not in {"plan_sha256", "request_key"}},
    )["plan"]["plan_sha256"]
    with pytest.raises(ValueError, match="different parameters"):
        call(wb, "start", changed)
    with pytest.raises(PermissionError, match="different policy"):
        call(
            wb,
            "advance",
            {"run_id": run["id"]},
            owner={"policy_sha256": "0" * 64, "session_id": None},
        )


def test_output_job_provenance_tamper_is_rejected_even_with_rehashed_result(graph_study):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    output = run_child(wb, run, "cells")
    result = wb.project.result(output["result"]["id"])
    result["provenance"]["job_id"] = "0" * 32
    result.pop("revision_hash")
    result["revision_hash"] = hashlib.sha256(canonical_json(result).encode()).hexdigest()
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(result), result["id"])
        )
    with pytest.raises(ValueError, match="publication job"):
        call(wb, "status", {"run_id": run["id"]})
    assert len(wb.project.list_jobs()) == 1


def test_save_get_list_validators_and_cas_preserve_v1_documents(graph_study):
    wb, request, _ = graph_study
    legacy_id = uuid4().hex
    wb.project.put_document(
        "workflow", legacy_id, {"definition": {"schema": "loci.workflow/v1"}}, expected_revision=0
    )
    listed = call(wb, "list", {})["workflows"]
    assert [doc["id"] for doc in listed] == [request["workflow_id"]]
    assert call(wb, "get", {"workflow_id": request["workflow_id"]})["workflow"] == listed[0]
    assert (
        call(wb, "validate", {"definition": definition()})["definition_sha256"]
        == request["definition_sha256"]
    )
    with pytest.raises(ValueError, match="changed"):
        call(
            wb,
            "save",
            {
                "workflow_id": request["workflow_id"],
                "expected_revision": 0,
                "definition": definition(),
            },
        )
    assert (
        wb.project.documents("workflow", document_id=legacy_id)[0]["data"]["definition"]["schema"]
        == "loci.workflow/v1"
    )


def test_supervisor_restarts_orphaned_queued_child_using_the_original_key(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)

    def lost_before_launch(workbench, operation, body, key):
        submit_job(workbench, body, key, operation=operation)
        raise ConnectionError("supervisor stopped before launching queued child")

    with pytest.raises(ConnectionError):
        advance(wb, run, submit=lost_before_launch)
    queued = wb.project.list_jobs()[0]
    seen = []

    def recovered_supervisor(workbench, operation, body, key):
        job = submit_job(workbench, body, key, operation=operation)
        seen.append(job["id"])
        run_job(
            workbench,
            job["id"],
            publication_guard=lambda: guard_node_job(workbench, workbench.project.job(job["id"])),
        )
        return workbench.project.job(job["id"])

    advance(wb, run, submit=recovered_supervisor)
    assert seen == [queued["id"]]
    assert len(wb.project.list_jobs()) == len(wb.project.list_results()) == 1


def test_external_spatial_masks_have_separate_atomic_native_job(graph_study):
    from loci_engine.quantitative import measure_objects

    wb, initial_request, _ = graph_study
    source = initial_request["bindings"]["image"]
    raw, geometry, selection = wb.load_scalar(source["source_id"], source["selection"])
    objects = np.zeros(raw.shape, np.uint32)
    objects[4:6, 5:7] = 1
    compartment = np.ones(raw.shape, np.uint32)
    boundary = np.zeros(raw.shape, np.uint32)
    boundary[:, 0] = 1
    results = [
        wb.project.save_result(
            source_id=source["source_id"],
            kind="external-labels",
            arrays={"image": raw, "labels": labels},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": selection,
                "measurements": measure_objects(labels, geometry, {"source_channel_0": raw}),
            },
        )
        for labels in (objects, compartment, boundary)
    ]
    graph = {
        "schema": "loci.workflow/v2",
        "name": "External calibrated spatial masks",
        "inputs": dict.fromkeys(("objects", "compartment", "boundary"), "label-result"),
        "nodes": [
            {
                "id": "distance",
                "operation": "spatial_distance_run",
                "contract_version": 1,
                "inputs": {
                    role: {"input": role} for role in ("objects", "compartment", "boundary")
                },
                "settings": {
                    "band_edges": [0, 4, 8, 20],
                    "exclude_crop_border": True,
                    "control": "Generated grid",
                    "boundary_coverage": "First column only",
                },
            }
        ],
        "outputs": {"distance": {"node": "distance", "port": "result"}},
        "working_bytes": 16 * 1024**2,
    }
    saved = call(
        wb, "save", {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": graph}
    )["workflow"]
    body = {
        "workflow_id": saved["id"],
        "workflow_revision": saved["revision"],
        "definition_sha256": saved["data"]["definition_sha256"],
        "bindings": {
            role: {"result_id": result["id"], "revision_hash": result["revision_hash"]}
            for role, result in zip(("objects", "compartment", "boundary"), results, strict=True)
        },
    }
    plan = call(wb, "preflight", body)["plan"]
    run = advance(
        wb, start(wb, {**body, "plan_sha256": plan["plan_sha256"], "request_key": "spatial-masks"})
    )
    run_child(wb, run, "distance")
    status = call(wb, "status", {"run_id": run["id"]})
    assert status["state"] == "succeeded"
    assert len(wb.project.list_jobs()) == 1
    output = wb.project.result(status["run"]["data"]["outputs"]["distance"]["result_id"])
    assert output["kind"] == "spatial-distance-bands"
    assert output["provenance"]["accepted_request"]["boundary"]["result_id"] == results[2]["id"]


def test_scheduling_cas_conflict_does_not_submit_any_child(graph_study, monkeypatch):
    wb, request, _ = graph_study
    run = start(wb, request)
    original = wb.project.put_document
    raced = False

    def concurrent_writer(kind, identity, record, **kwargs):
        nonlocal raced
        if kind == "workflow_run" and not raced:
            raced = True
            existing = wb.project.documents(kind, document_id=identity)[0]
            original(kind, identity, existing["data"], expected_revision=existing["revision"])
        return original(kind, identity, record, **kwargs)

    monkeypatch.setattr(wb.project, "put_document", concurrent_writer)
    with pytest.raises(ValueError, match="changed"):
        advance(wb, run)
    assert not wb.project.list_jobs()


def test_fabricated_completed_state_without_a_child_job_is_rejected(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    data = copy.deepcopy(run["data"])
    data["nodes"]["cells"]["state"] = "succeeded"
    data.pop("run_sha256")
    data["run_sha256"] = hashlib.sha256(canonical_json(data).encode()).hexdigest()
    with wb.project.connection() as connection:
        envelope = {**run, "data": data}
        connection.execute(
            "UPDATE documents SET record=? WHERE kind='workflow_run' AND id=?",
            (canonical_json(envelope), run["id"]),
        )
    with pytest.raises(ValueError, match="no durable intent"):
        advance(wb, run)
    assert not wb.project.list_jobs()


def snapshots(wb, run):
    source_id = run["data"]["plan"]["bindings"]["image"]["source_id"]
    return {
        "sources": {source_id: wb.project.source(source_id)},
        "results": {
            result["id"]: wb.project.result(result["id"]) for result in wb.project.list_results()
        },
        "documents": wb.project.documents("workflow") + wb.project.documents("workflow_run"),
        "jobs": {job["id"]: job for job in wb.project.list_jobs()},
    }


def test_pure_snapshot_validator_retains_complete_graph_and_native_jobs(graph_study, monkeypatch):
    from loci_engine.research_workflow_graph import validate_workflow_graph_document

    wb, request, _ = graph_study
    run = start(wb, request)
    for identity in ("cells", "nuclei", "join"):
        run = advance(wb, run)
        run_child(wb, run, identity)
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    packet = snapshots(wb, run)
    before = copy.deepcopy((packet, run))

    def forbidden(*_args, **_kwargs):
        pytest.fail("Pure portable validator attempted live IO or image execution")

    monkeypatch.setattr("loci_engine.native_image.NativeImageSession.__init__", forbidden)
    monkeypatch.setattr("loci_engine.quantitative.segment_scalar", forbidden)
    monkeypatch.setattr("builtins.open", forbidden)
    for doc in packet["documents"]:
        validate_workflow_graph_document(doc, **packet)
    assert (packet, run) == before


@pytest.mark.parametrize(
    "mutation",
    ["missing_job", "wrong_job_request", "wrong_output", "source_hash", "adapter", "scope"],
)
def test_pure_snapshot_validator_rejects_rehashed_inconsistent_inputs(graph_study, mutation):
    from loci_engine.research_workflow_graph import validate_workflow_graph_document

    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    run_child(wb, run, "cells")
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    packet = snapshots(wb, run)
    if mutation == "missing_job":
        packet["jobs"] = {}
    elif mutation == "wrong_job_request":
        job = next(iter(packet["jobs"].values()))
        job["request"]["recipe"]["segmentation"]["threshold"] = 999
        job["request_hash"] = hashlib.sha256(
            canonical_json({"operation": job["operation"], "request": job["request"]}).encode()
        ).hexdigest()
    elif mutation == "source_hash":
        next(iter(packet["sources"].values()))["sha256"] = "0" * 64
    else:
        data = run["data"]
        if mutation == "wrong_output":
            data["nodes"]["cells"]["output"]["revision_hash"] = "0" * 64
        else:
            if mutation == "adapter":
                data["plan"]["adapter_versions"]["run_recipe"] = 2
            else:
                data["plan"]["node_scopes"]["cells"]["geometry"]["affine"][0][0] = 9
            data["plan"].pop("plan_sha256")
            data["plan"]["plan_sha256"] = hashlib.sha256(
                canonical_json(data["plan"]).encode()
            ).hexdigest()
            original_request = {**request, "plan_sha256": data["plan"]["plan_sha256"]}
            data["request_sha256"] = hashlib.sha256(
                canonical_json(original_request).encode()
            ).hexdigest()
        data.pop("run_sha256")
        data["run_sha256"] = hashlib.sha256(canonical_json(data).encode()).hexdigest()
        packet["documents"] = [
            run if doc["kind"] == "workflow_run" else doc for doc in packet["documents"]
        ]
    with pytest.raises(ValueError):
        validate_workflow_graph_document(run, **packet)


def test_historical_interrupted_native_jobs_are_valid_snapshots_and_do_not_restart(graph_study):
    from loci_engine.research_interchange import _historical_job
    from loci_engine.research_workflow_graph import validate_workflow_graph_document

    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    packet = snapshots(wb, run)
    packet["jobs"] = {identity: _historical_job(job) for identity, job in packet["jobs"].items()}
    validate_workflow_graph_document(run, **packet)
    historical = next(iter(packet["jobs"].values()))
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE jobs SET record=? WHERE id=?", (canonical_json(historical), historical["id"])
        )
    assert advance(wb, run)["data"]["state"] == "failed"
    assert len(wb.project.list_jobs()) == 1


def test_actual_portable_study_roundtrip_preserves_graph_native_jobs_and_outputs(
    graph_study, tmp_path
):
    from loci_engine.research_interchange import export_project, import_project

    wb, request, source_path = graph_study
    run = start(wb, request)
    for identity in ("cells", "nuclei", "join"):
        run = advance(wb, run)
        run_child(wb, run, identity)
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    archive = tmp_path / "complete-graph.loci-study.zip"
    export_project(wb.project, archive)
    imported = import_project(archive, tmp_path / "imported-graph.loci-study")
    assert imported.documents("workflow_run", document_id=run["id"])[0] == run
    assert len(imported.list_jobs()) == 3
    assert all(job["interchange"]["historical"] for job in imported.list_jobs())
    source_id = request["bindings"]["image"]["source_id"]
    imported.relink(source_id, source_path)
    reopened = Workbench(imported)
    status = call(reopened, "status", {"run_id": run["id"]})
    assert status["state"] == "succeeded"
    assert status["run"]["data"]["outputs"] == run["data"]["outputs"]
    assert len(imported.list_jobs()) == len(imported.list_results()) == 3


def test_native_run_listing_is_read_only_and_preserves_agent_ownership(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    before = wb.project.documents("workflow_run")
    assert wb.execute("workflow_graph_runs", {}) == {"runs": [run]}
    assert wb.project.documents("workflow_run") == before
    with pytest.raises(ValueError):
        wb.execute("workflow_graph_runs", {"owner": None})
