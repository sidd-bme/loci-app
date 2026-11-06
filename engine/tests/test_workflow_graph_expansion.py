"""Exact typed reports, native-only fresh continuation, and retained proof checks."""
# ruff: noqa: F811

import copy
from uuid import uuid4

import pytest
from test_research_annotation_evaluation import scene  # noqa: F401
from test_research_methods import setup_method  # noqa: F401
from test_research_morphometrics import make_parent  # noqa: F401
from test_research_tissue_models import make_case, preview, token  # noqa: F401
from test_research_workflow_graph import (
    advance,
    allow,
    call,
    graph_study,  # noqa: F401
    run_child,
    snapshots,
    start,
)

from loci_engine import research_methods as methods
from loci_engine import research_tissue_models as tissue
from loci_engine.research_jobs import run_job
from loci_engine.research_workflow_graph import (
    continue_workflow_graph,
    validate_workflow_graph_document,
)
from loci_engine.workflow_graph import build_plan, resolve_node, validate_definition


def prepare(wb, definition, bindings, key="expanded"):
    saved = call(
        wb,
        "save",
        {
            "workflow_id": uuid4().hex,
            "expected_revision": 0,
            "definition": definition,
        },
    )["workflow"]
    binding = {
        "workflow_id": saved["id"],
        "workflow_revision": saved["revision"],
        "definition_sha256": saved["data"]["definition_sha256"],
        "bindings": bindings,
    }
    plan = call(wb, "preflight", binding)["plan"]
    return {**binding, "plan_sha256": plan["plan_sha256"], "request_key": key}


def bound(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def test_annotation_adapter_exact_numerical_publication_and_portable_history(scene):
    wb, source, parent, reference, request = scene
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Exact annotation agreement",
        "inputs": {"prediction": "label-result", "reference": "label-result"},
        "nodes": [
            {
                "id": "agreement",
                "operation": "annotation_evaluation_run",
                "contract_version": 1,
                "inputs": {name: {"input": name} for name in ("prediction", "reference")},
                "settings": {
                    key: value
                    for key, value in request.items()
                    if key not in {"result_id", "revision_hash", "reference"}
                },
            }
        ],
        "outputs": {"report": {"node": "agreement", "port": "result"}},
        "working_bytes": request["working_bytes"],
    }
    run = start(
        wb, prepare(wb, definition, {"prediction": bound(parent), "reference": bound(reference)})
    )
    run = advance(wb, run)
    run_child(wb, run, "agreement")
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    assert run["data"]["state"] == "succeeded"
    report = wb.project.result(run["data"]["outputs"]["report"]["result_id"])
    scores = report["provenance"]["annotation_evaluation"]["metrics"]["instances"]["scores"]
    assert [score["f1"] for score in scores] == [1, 1]
    assert wb.project.review_state(report["id"]) is None
    packet = {
        "sources": [source],
        "results": [parent, reference, report],
        "documents": wb.project.documents("workflow") + wb.project.documents("workflow_run"),
        "jobs": wb.project.list_jobs(),
    }
    validate_workflow_graph_document(run, **packet)
    # A retained agreement report is never accepted as reusable segmentation.
    definition["nodes"].append(
        {
            "id": "shape",
            "operation": "morphometrics_run",
            "contract_version": 1,
            "inputs": {"objects": {"node": "agreement", "port": "result"}},
            "settings": {},
        }
    )
    definition["outputs"] = {"shape": {"node": "shape", "port": "result"}}
    with pytest.raises(ValueError, match="Incompatible workflow port type"):
        validate_definition(definition)


def stopped_partial(wb, request):
    run = advance(wb, start(wb, request))
    run_child(wb, run, "cells")
    # Reconcile exactly one completed branch, then stop the original owner.
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    return call(wb, "cancel", {"run_id": run["id"]})["run"]


def continuation_request(wb, run):
    receipt = call(wb, "continuation", {"run_id": run["id"]})["continuation"]
    return {
        "run_id": run["id"],
        "run_revision": run["revision"],
        "run_sha256": run["data"]["run_sha256"],
        "continuation_sha256": receipt["continuation_sha256"],
        "workflow_id": uuid4().hex,
        "request_key": "fresh-continuation",
    }, receipt


def test_native_fresh_continuation_reuses_only_proven_completed_work(graph_study):
    wb, request, _ = graph_study
    original = stopped_partial(wb, request)
    req, receipt = continuation_request(wb, original)
    before_jobs = wb.project.list_jobs()
    before_original = copy.deepcopy(original)
    assert [proof["node_id"] for proof in receipt["completed_nodes"]] == ["cells"]
    assert receipt["can_start_fresh"]
    assert (
        receipt["proposal"]["bindings"]["reused_0"] == original["data"]["nodes"]["cells"]["output"]
    )
    owner = {"policy_sha256": "a" * 64, "session_id": None}
    approvals = []

    def approve(payload):
        approvals.append(payload)
        return True

    fresh = continue_workflow_graph(
        wb,
        req,
        owner=owner,
        authorize=allow,
        authorize_binding=allow,
        approve_continuation=approve,
    )["run"]
    assert fresh["data"]["owner"] == owner
    assert fresh["data"]["continuation"] == receipt
    assert set(fresh["data"]["nodes"]) == {"nuclei", "join"}
    assert wb.project.list_jobs() == before_jobs  # no dispatch from approval/start
    assert wb.project.documents("workflow_run", document_id=original["id"])[0] == before_original
    assert approvals[0]["new_owner"] == owner
    # Fresh grants own only new work. Old cells job is neither rerun nor reassigned.
    for node_id in ("nuclei", "join"):
        fresh = advance(wb, fresh, owner=owner)
        run_child(wb, fresh, node_id)
    fresh = call(wb, "status", {"run_id": fresh["id"]}, owner=owner)["run"]
    assert fresh["data"]["state"] == "succeeded"
    assert len(wb.project.list_jobs()) == 3
    assert wb.project.list_jobs()[0].get("owner") is None
    assert all(job["owner"] == owner for job in wb.project.list_jobs()[1:])
    packet = snapshots(wb, original)
    validate_workflow_graph_document(fresh, **packet)
    # Native continuation retry uses the same prepared workflow/run identity.
    assert (
        continue_workflow_graph(
            wb,
            req,
            owner=owner,
            authorize=allow,
            authorize_binding=allow,
            approve_continuation=approve,
        )["run"]["id"]
        == fresh["id"]
    )


@pytest.mark.parametrize("denial", ["approval", "scope", "stale", "active"])
def test_continuation_refuses_before_mutation(graph_study, denial):
    wb, request, _ = graph_study
    run = stopped_partial(wb, request) if denial != "active" else start(wb, request)
    req, _ = continuation_request(wb, run)
    before = (
        wb.project.documents("workflow"),
        wb.project.documents("workflow_run"),
        wb.project.list_jobs(),
    )
    authorize_binding = allow
    if denial == "scope":

        def authorize_binding(*_args):
            raise PermissionError("fresh source grant denied")

    if denial == "stale":
        req["continuation_sha256"] = "0" * 64
    with pytest.raises((PermissionError, ValueError)):
        continue_workflow_graph(
            wb,
            req,
            owner=None,
            authorize=allow,
            authorize_binding=authorize_binding,
            approve_continuation=(lambda _payload: denial != "approval"),
        )
    assert (
        wb.project.documents("workflow"),
        wb.project.documents("workflow_run"),
        wb.project.list_jobs(),
    ) == before


def test_capture_only_successful_exact_definition_with_cas(graph_study):
    wb, request, _ = graph_study
    run = start(wb, request)
    for identity in ("cells", "nuclei", "join"):
        run = advance(wb, run)
        run_child(wb, run, identity)
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    req = {
        "run_id": run["id"],
        "run_revision": run["revision"],
        "run_sha256": run["data"]["run_sha256"],
        "workflow_id": uuid4().hex,
        "expected_revision": 0,
        "name": "Reusable successful analysis",
    }
    captured = call(wb, "save_from_run", req)["workflow"]
    expected = copy.deepcopy(run["data"]["plan"]["definition"])
    expected["name"] = req["name"]
    assert captured["data"]["definition"] == expected
    assert len(wb.project.list_jobs()) == 3
    with pytest.raises(ValueError, match="changed"):
        call(wb, "save_from_run", req)
    req["workflow_id"] = uuid4().hex
    req["run_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="changed"):
        call(wb, "save_from_run", req)


def test_specific_method_adapter_resolves_native_preflight_and_preserves_runtime_refusal(
    setup_method, monkeypatch
):
    wb, parent, request, flight, _ = setup_method
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Pinned method",
        "inputs": {"objects": "label-result"},
        "nodes": [
            {
                "id": "method",
                "operation": "method_run",
                "contract_version": 1,
                "inputs": {"objects": {"input": "objects"}},
                "settings": {
                    **{k: v for k, v in request.items() if k not in {"result_id", "revision_hash"}},
                    "mode": "execute",
                },
            }
        ],
        "outputs": {"measured": {"node": "method", "port": "result"}},
        "working_bytes": request["working_bytes"],
    }
    bindings = {"objects": bound(parent)}
    native = resolve_node(wb, definition, bindings, {}, "method")
    assert native["request"] == {
        **request,
        "mode": "execute",
        "preflight_hash": flight["preflight_hash"],
    }
    methods.review_rights(
        wb,
        {
            "method_id": request["method_id"],
            "manifest_sha256": request["manifest_sha256"],
            "module_sha256": request["module_sha256"],
            "decision": "approved",
            "reviewer": "Technical fixture",
            "evidence": "Synthetic rights-control test",
        },
        authority=methods.NATIVE_AUTHORITY,
    )
    monkeypatch.setattr(methods, "qualified_runtime", lambda: None)
    run = advance(wb, start(wb, prepare(wb, definition, bindings)))
    with pytest.raises(methods.runtime.MethodRuntimeUnavailable):
        run_child(wb, run, "method")
    job = wb.project.list_jobs()[0]
    assert job["state"] == "failed" and not job["result_ids"]
    definition["nodes"][0]["settings"]["mode"] = "adopt-external"
    with pytest.raises(ValueError, match="qualified execution"):
        validate_definition(definition)


def test_prepared_tissue_adapter_composes_report_and_survives_evicted_preview(
    make_case, monkeypatch
):
    case = make_case()
    wb = case.wb
    first = preview(case)
    prepared = {
        **token(first),
        "receipt": tissue.peek_preview(case.project, token(first))["receipt"],
    }
    # Independently declared technical reference on the exact output grid.
    from test_research_tissue_models import run as adopt

    reference = adopt(case, first)
    reference = case.project.result(reference["result"]["id"])
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Prepared tissue and report",
        "inputs": {"prepared": "tissue-preview", "reference": "label-result"},
        "nodes": [
            {
                "id": "tissue",
                "operation": "tissue_model_run",
                "contract_version": 1,
                "inputs": {"preview": {"input": "prepared"}},
                "settings": {},
            },
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
                    "reference_declaration": "Synthetic technical reference, not accuracy",
                    "working_bytes": case.request["working_bytes"],
                },
            },
        ],
        "outputs": {"report": {"node": "report", "port": "result"}},
        "working_bytes": case.request["working_bytes"],
    }
    discovered = call(wb, "prepared_previews", {"source_id": case.source["id"]})
    assert discovered == {"previews": [prepared], "unavailable_count": 0}
    req = prepare(wb, definition, {"prepared": prepared, "reference": bound(reference)})
    run = advance(wb, start(wb, req))
    assert call(wb, "prepared_previews", {"source_id": case.source["id"]}) == {
        "previews": [],
        "unavailable_count": 1,
    }
    with pytest.raises(ValueError, match="single-use"):
        start(wb, {**req, "request_key": "other-tissue-run"})
    job_id = run["data"]["nodes"]["tissue"]["intent"]["job_id"]
    # Explicitly fake inference, preserving real native job/persistence/guard boundaries.
    original_execute = wb.execute

    def execute(operation, request, **kwargs):
        if operation == "tissue_model_run":
            return tissue.execute(
                wb,
                operation,
                request,
                weights=case.weights,
                check=kwargs.get("publication_guard") or allow,
                job_id=kwargs.get("job_id"),
            )
        return original_execute(operation, request, **kwargs)

    monkeypatch.setattr(wb, "execute", execute)
    run_job(wb, job_id)
    with wb.project.connection() as connection:
        connection.execute("DELETE FROM metadata WHERE key LIKE ?", (tissue.PREVIEW_PREFIX + "%",))
    run = advance(wb, run)
    run_job(wb, run["data"]["nodes"]["report"]["intent"]["job_id"])
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    assert run["data"]["state"] == "succeeded"
    packet = {
        "sources": [wb.project.source(case.source["id"])],
        "results": [wb.project.result(r["id"]) for r in wb.project.list_results()],
        "documents": wb.project.documents("workflow") + wb.project.documents("workflow_run"),
        "jobs": wb.project.list_jobs(),
    }
    validate_workflow_graph_document(run, **packet)
    assert len(wb.project.list_jobs()) == 2
    assert start(wb, req)["id"] == run["id"]


def test_general_graph_morphology_preserves_explicit_zyx_geometry(make_parent):
    wb, parent, _, _, _ = make_parent(volume=True)
    definition = {
        "schema": "loci.workflow/v2",
        "name": "General volume morphology",
        "inputs": {"objects": "label-result"},
        "nodes": [
            {
                "id": "shape",
                "operation": "morphometrics_run",
                "contract_version": 1,
                "inputs": {"objects": {"input": "objects"}},
                "settings": {},
            }
        ],
        "outputs": {"shape": {"node": "shape", "port": "result"}},
        "working_bytes": 16 * 1024**2,
    }
    run = advance(wb, start(wb, prepare(wb, definition, {"objects": bound(parent)})))
    run_child(wb, run, "shape")
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    result = wb.project.result(run["data"]["outputs"]["shape"]["result_id"])
    assert run["data"]["state"] == "succeeded"
    assert result["provenance"]["geometry"] == parent["provenance"]["geometry"]
    assert result["provenance"]["geometry"]["axes"] == "ZYX"
    assert result["arrays"]["labels"] == parent["arrays"]["labels"]
    assert result["provenance"]["measurements"] != []


def test_method_graph_retains_simulated_native_execution_and_portable_identity(
    setup_method, monkeypatch
):
    import struct

    from test_research_methods import identity

    from loci_engine import method_protocol as protocol

    wb, parent, request, _, source = setup_method
    review = {key: request[key] for key in ("method_id", "manifest_sha256", "module_sha256")}
    methods.review_rights(
        wb,
        {
            **review,
            "decision": "approved",
            "reviewer": "Fixture",
            "evidence": "Synthetic test only",
        },
        authority=methods.NATIVE_AUTHORITY,
    )
    qualification = {
        "schema": "loci.controlled-method-runtime-qualification/v1",
        "identity": identity(),
        "evidence_sha256": "a" * 64,
        "accepted_at": "fixture",
    }
    monkeypatch.setattr(methods, "qualified_runtime", lambda: qualification)

    def simulated(method, snapshot, *, approval, check):
        check()
        output = struct.pack("<8sII", protocol.OUTPUT_MAGIC, len(snapshot.label_ids), 1)
        output += b"".join(struct.pack("<Id", label, 1.0) for label in snapshot.label_ids)
        result = protocol.adopt_method_output(
            method, snapshot, output, expected_output_sha256=protocol.sha256(output)
        )
        runtime = {
            key: identity()[key]
            for key in (
                "runtime_profile",
                "wasmtime_version",
                "native_sha256",
                "python_version",
            )
        }
        runtime.update(
            schema="loci.controlled-method-execution/v1",
            mode="execute",
            module_sha256=method.module_sha256,
            input_sha256=snapshot.sha256,
            output_sha256=protocol.sha256(output),
            limits=methods.runtime._limits_record(),
        )
        return {
            **result,
            "origin": "executed-local-child",
            "runtime": runtime,
            "rights_evidence_sha256": approval.rights_evidence_sha256,
        }

    monkeypatch.setattr(methods.runtime, "execute_method", simulated)
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Simulated pinned method",
        "inputs": {"objects": "label-result"},
        "nodes": [
            {
                "id": "method",
                "operation": "method_run",
                "contract_version": 1,
                "inputs": {"objects": {"input": "objects"}},
                "settings": {
                    **{k: v for k, v in request.items() if k not in {"result_id", "revision_hash"}},
                    "mode": "execute",
                },
            }
        ],
        "outputs": {"measured": {"node": "method", "port": "result"}},
        "working_bytes": request["working_bytes"],
    }
    req = prepare(wb, definition, {"objects": bound(parent)})
    run = advance(wb, start(wb, req))
    run_job(wb, run["data"]["nodes"]["method"]["intent"]["job_id"])
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    assert run["data"]["state"] == "succeeded"
    result = wb.project.result(run["data"]["outputs"]["measured"]["result_id"])
    assert result["arrays"]["labels"] == parent["arrays"]["labels"]
    assert result["provenance"]["accepted_request"]["module_sha256"] == request["module_sha256"]
    packet = {
        "sources": [wb.project.source(parent["source_id"])],
        "results": [parent, result],
        "documents": wb.project.documents("workflow") + wb.project.documents("workflow_run"),
        "jobs": wb.project.list_jobs(),
    }
    validate_workflow_graph_document(run, **packet)
    assert len(wb.project.list_jobs()) == 1


def test_continuation_rechecks_native_proof_after_approval_and_rejects_rehashed_forgery(
    graph_study,
):
    import hashlib

    from loci_engine.research_project import canonical_json

    wb, request, _ = graph_study
    original = stopped_partial(wb, request)
    req, _ = continuation_request(wb, original)
    before_workflows = wb.project.documents("workflow")

    def changed_after_approval(_payload):
        call(wb, "cancel", {"run_id": original["id"]})
        return True

    with pytest.raises(ValueError, match="changed during continuation approval"):
        continue_workflow_graph(
            wb,
            req,
            owner=None,
            authorize=allow,
            authorize_binding=allow,
            approve_continuation=changed_after_approval,
        )
    assert wb.project.documents("workflow") == before_workflows
    original = wb.project.documents("workflow_run", document_id=original["id"])[0]
    req, _ = continuation_request(wb, original)
    fresh = continue_workflow_graph(
        wb,
        req,
        owner=None,
        authorize=allow,
        authorize_binding=allow,
        approve_continuation=lambda _: True,
    )["run"]
    forged = copy.deepcopy(fresh)
    receipt = forged["data"]["continuation"]
    receipt["completed_nodes"][0]["output"]["revision_hash"] = "0" * 64
    receipt["continuation_sha256"] = hashlib.sha256(
        canonical_json({k: v for k, v in receipt.items() if k != "continuation_sha256"}).encode()
    ).hexdigest()
    forged["data"]["run_sha256"] = hashlib.sha256(
        canonical_json({k: v for k, v in forged["data"].items() if k != "run_sha256"}).encode()
    ).hexdigest()
    packet = snapshots(wb, original)
    packet["documents"] = [
        forged if doc["id"] == forged["id"] else doc for doc in packet["documents"]
    ]
    with pytest.raises(ValueError, match="prove exactly its reused native work"):
        validate_workflow_graph_document(forged, **packet)


def test_unacknowledged_child_failure_requires_status_before_new_approved_run(graph_study):
    wb, request, _ = graph_study
    run = advance(wb, start(wb, request))
    job_id = run["data"]["nodes"]["cells"]["intent"]["job_id"]
    wb.project.update_job(
        job_id, expected_state="queued", state="failed", error="Technical failure"
    )
    req, receipt = continuation_request(wb, run)
    assert receipt["state"] == "failed"
    assert not receipt["can_start_fresh"]
    assert "Refresh run status" in receipt["unavailable_reason"]
    approvals = []
    before = wb.project.documents("workflow_run")
    with pytest.raises(ValueError, match="Stop the original run"):
        continue_workflow_graph(
            wb,
            req,
            owner=None,
            authorize=allow,
            authorize_binding=allow,
            approve_continuation=lambda payload: approvals.append(payload) or True,
        )
    assert approvals == [] and wb.project.documents("workflow_run") == before
    retained = call(wb, "status", {"run_id": run["id"]})["run"]
    req, receipt = continuation_request(wb, retained)
    assert receipt["can_start_fresh"] and receipt["completed_nodes"] == []
    fresh = continue_workflow_graph(
        wb,
        req,
        owner=None,
        authorize=allow,
        authorize_binding=allow,
        approve_continuation=lambda _: True,
    )["run"]
    assert fresh["data"]["state"] == "prepared"
    assert call(wb, "status", {"run_id": fresh["id"]})["state"] == "prepared"


def test_continuation_receipt_survives_actual_portable_export_import(graph_study, tmp_path):
    from loci_engine.research_interchange import export_project, import_project
    from loci_engine.workbench import Workbench

    wb, request, source_path = graph_study
    original = stopped_partial(wb, request)
    req, receipt = continuation_request(wb, original)
    fresh = continue_workflow_graph(
        wb,
        req,
        owner=None,
        authorize=allow,
        authorize_binding=allow,
        approve_continuation=lambda _: True,
    )["run"]
    for node_id in ("nuclei", "join"):
        fresh = advance(wb, fresh)
        run_job(wb, fresh["data"]["nodes"][node_id]["intent"]["job_id"])
    fresh = call(wb, "status", {"run_id": fresh["id"]})["run"]
    archive = tmp_path / "continued.loci-study.zip"
    export_project(wb.project, archive)
    imported = import_project(archive, tmp_path / "restored.loci-study")
    restored = imported.documents("workflow_run", document_id=fresh["id"])[0]
    assert restored == fresh
    assert restored["data"]["continuation"] == receipt
    imported.relink(request["bindings"]["image"]["source_id"], source_path)
    reopened = Workbench(imported)
    assert call(reopened, "status", {"run_id": fresh["id"]})["state"] == "succeeded"
    assert len(imported.list_jobs()) == 3 and all(
        job["interchange"]["historical"] for job in imported.list_jobs()
    )


def integral_float_wire_copy(value):
    """The specific JSON.stringify/parse change: native 1.0/0.0 become wire 1/0."""
    if isinstance(value, dict):
        return {key: integral_float_wire_copy(item) for key, item in value.items()}
    if isinstance(value, list):
        return [integral_float_wire_copy(item) for item in value]
    if type(value) is float and value.is_integer():
        return int(value)
    return value


def prepared_tissue_graph(case):
    output = preview(case)
    prepared = {
        **token(output),
        "receipt": tissue.peek_preview(case.project, token(output))["receipt"],
    }
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Exact prepared preview wire transport",
        "inputs": {"prepared": "tissue-preview"},
        "nodes": [
            {
                "id": "tissue",
                "operation": "tissue_model_run",
                "contract_version": 1,
                "inputs": {"preview": {"input": "prepared"}},
                "settings": {},
            }
        ],
        "outputs": {"candidate": {"node": "tissue", "port": "result"}},
        "working_bytes": case.request["working_bytes"],
    }
    return definition, prepared


def test_tissue_preview_wire_integral_floats_resolve_native_hash_and_durable_start(make_case):
    import hashlib

    from loci_engine.research_project import canonical_json

    case = make_case()
    definition, native = prepared_tissue_graph(case)
    wire = integral_float_wire_copy(native)
    assert type(native["receipt"]["geometry"]["affine"][0][0]) is float
    assert type(wire["receipt"]["geometry"]["affine"][0][0]) is int
    assert (
        hashlib.sha256(canonical_json(wire["receipt"]).encode()).hexdigest() != wire["preview_hash"]
    )
    before = tissue.peek_preview(case.project, token(native))
    plan = build_plan(case.wb, definition, {"prepared": wire})
    assert canonical_json(plan["bindings"]["prepared"]) == canonical_json(native)
    assert tissue.peek_preview(case.project, token(native)) == before
    request = prepare(case.wb, definition, {"prepared": wire}, key="native-wire-retry")
    run = start(case.wb, request)
    assert run["data"]["state"] == "prepared" and case.project.list_jobs() == []
    assert canonical_json(run["data"]["plan"]["bindings"]["prepared"]) == canonical_json(native)
    # Submission identity binds the native normalized plan, not the lossy wire view.
    assert start(case.wb, request)["id"] == run["id"]
    with case.project.connection() as connection:
        connection.execute("DELETE FROM metadata WHERE key LIKE ?", (tissue.PREVIEW_PREFIX + "%",))
    # A new preflight must not borrow an old run's authority after token eviction.
    with pytest.raises(ValueError, match="unavailable|evicted"):
        call(
            case.wb,
            "preflight",
            {
                key: value
                for key, value in request.items()
                if key not in {"plan_sha256", "request_key"}
            },
        )
    with pytest.raises(ValueError, match="unavailable|evicted"):
        build_plan(case.wb, definition, {"prepared": wire})
    assert start(case.wb, request)["id"] == run["id"]
    assert call(case.wb, "status", {"run_id": run["id"]})["state"] == "prepared"
    packet = {
        "sources": [case.project.source(case.source["id"])],
        "results": [],
        "documents": case.project.documents("workflow") + case.project.documents("workflow_run"),
        "jobs": [],
    }
    validate_workflow_graph_document(run, **packet)
    changed = copy.deepcopy(request)
    changed["bindings"]["prepared"]["receipt"]["geometry"]["affine"][0][0] = True
    with pytest.raises(ValueError, match="binding differs"):
        start(case.wb, changed)
    assert case.project.list_jobs() == []


@pytest.mark.parametrize(
    "mutation", ["boolean", "value", "structure", "nonfinite", "token", "cache"]
)
def test_tissue_preview_wire_never_repairs_changed_receipt_or_stale_native_cache(
    make_case, mutation
):
    from loci_engine.research_project import canonical_json

    case = make_case()
    definition, native = prepared_tissue_graph(case)
    wire = integral_float_wire_copy(native)
    if mutation == "boolean":
        wire["receipt"]["geometry"]["affine"][0][0] = True
    elif mutation == "value":
        wire["receipt"]["geometry"]["affine"][0][0] = 1.125
    elif mutation == "structure":
        wire["receipt"]["unexpected"] = 0
    elif mutation == "nonfinite":
        wire["receipt"]["geometry"]["affine"][0][0] = float("inf")
    elif mutation == "token":
        wire["preview_hash"] = "0" * 64
    else:
        stored = tissue.peek_preview(case.project, token(native))
        stored["receipt"]["geometry"]["affine"][0][0] = 1.125
        with case.project.connection() as connection:
            connection.execute(
                "UPDATE metadata SET value=? WHERE key=?",
                (
                    canonical_json(stored),
                    tissue.PREVIEW_PREFIX + native["preview_id"],
                ),
            )
    with pytest.raises(ValueError):
        build_plan(case.wb, definition, {"prepared": wire})
    assert case.project.list_jobs() == [] and case.project.documents("workflow_run") == []
