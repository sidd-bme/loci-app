"""Private next-slice native morphology authority/persistence/export contracts."""

import copy
import csv
import hashlib
import json
from uuid import uuid4

import numpy as np
import pytest
import test_research_morphometrics as fixtures
from test_research_interchange import _rewrite
from test_research_morphometrics import binding, derived, rehash
from test_research_workflow_graph import advance, call, run_child, start

from loci_engine import research_morphometrics as morphology
from loci_engine.research_annotation_import import import_annotations
from loci_engine.research_data_export import export_data_package, plan_export
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


@pytest.fixture
def make_parent(tmp_path):
    yield from fixtures.make_parent.__wrapped__(tmp_path)


def exact(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def replace_record(project, record):
    with project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(record), record["id"])
        )


def changed_moments(record):
    bad = copy.deepcopy(record)
    row = next(row for row in bad["provenance"]["measurements"] if row["label"] == 4_000_000_000)
    row["morphometrics"].update(
        center_covariance_eigenvalues=[4.0, 1.0], eccentricity=np.sqrt(3 / 4).item(), elongation=2.0
    )
    return rehash(bad)


@pytest.mark.parametrize("route", ["read", "cold-read", "population", "review", "publication"])
def test_forged_moments_fail_before_inspection_or_review(make_parent, route):
    wb, parent, _, labels, _ = make_parent()
    _, result = derived(wb, parent)
    bad = changed_moments(result)
    if route != "publication":
        replace_record(wb.project, bad)
    with pytest.raises(ValueError, match="endpoints disagree"):
        if route == "read":
            wb.project.result(bad["id"])
        elif route == "cold-read":
            ResearchProject(wb.project.root).result(bad["id"])
        elif route == "population":
            wb.execute("population_query", exact(bad))
        elif route == "review":
            wb.project.review(bad["id"], bad["revision_hash"], "reviewed")
        else:
            wb.project.save_result(
                source_id=parent["source_id"],
                kind="morphometrics",
                arrays={
                    "image": wb.project.load_array(parent["arrays"]["image"]),
                    "labels": labels,
                },
                provenance=bad["provenance"],
                parent_id=parent["id"],
            )


def test_validated_morphology_cache_still_rejects_changed_artifact_bytes(make_parent):
    wb, parent, _, _, _ = make_parent()
    _, result = derived(wb, parent)
    assert wb.project.result(result["id"]) == result
    artifact = wb.project.arrays / (result["arrays"]["labels"]["sha256"] + ".npy")
    original = artifact.read_bytes()
    artifact.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    try:
        with pytest.raises(ValueError, match="artifact hash/size verification"):
            wb.project.result(result["id"])
    finally:
        artifact.write_bytes(original)


def test_current_morphology_replay_budget_is_enforced_before_loading(make_parent, monkeypatch):
    labels = np.zeros((128, 128), dtype=np.uint32)
    labels[2:4, 3:6] = 4_000_000_000
    wb, parent, _, _, _ = make_parent(labels=labels)
    _, result = derived(wb, parent)
    cold = ResearchProject(wb.project.root)
    monkeypatch.setattr(cold, "load_array", lambda *_: pytest.fail("Over-budget pixels decoded"))
    with pytest.raises(ValueError, match="working-memory budget before decode"):
        cold.validate_result_arrays(result, working_bytes=1024**2)


def data_request(result):
    return {
        "purpose": "provisional",
        "bindings": [
            {
                **exact(result),
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "group_ids": [],
                "subset": "all",
            }
        ],
    }


def test_native_durable_job_idempotence_array_free_population_and_exact_locate(
    make_parent, monkeypatch
):
    wb, parent, _, labels, _ = make_parent()
    request = binding(parent)
    job = submit_job(wb, request, "physical-morphology", operation="morphometrics_run")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    result = wb.project.result(output["result"]["id"])
    assert result["provenance"]["job_id"] == job["id"]
    assert (
        submit_job(wb, request, "physical-morphology", operation="morphometrics_run")["id"]
        == job["id"]
    )
    assert run_job(wb, job["id"])["job"]["result_ids"] == [result["id"]]
    assert len(wb.project.list_results()) == 2
    with monkeypatch.context() as patch:
        patch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Query decoded pixels"))
        query = wb.execute(
            "population_query",
            {
                **exact(result),
                "x_metric": "morphometrics:perimeter",
                "y_metric": "morphometrics:elongation",
                "limit": 10,
                "sort": {"metric": "morphometrics:perimeter", "direction": "desc"},
            },
        )
    assert [r["label"] for r in query["rows"]] == [4_000_000_000, 17]
    assert query["rows"][0]["values"]["morphometrics:perimeter"] == 14
    assert query["rows"][1]["values"]["morphometrics:elongation"] is None
    assert query["accounting"]["metric_missing_counts"]["morphometrics:elongation"] == 1
    assert next(d for d in query["metrics"] if d["id"] == "morphometrics:perimeter")["unit"] == "um"
    locate = wb.execute("population_locate", {**exact(result), "label": 4_000_000_000})
    assert labels[tuple(locate["point_index"])] == 4_000_000_000
    context = wb.execute("describe_result", exact(result))
    assert context["method_label"] == "Digital morphometrics"
    assert context["parents"][0]["revision_hash"] == parent["revision_hash"]
    assert context["replay"]["operation"] == "morphometrics_run"
    assert context["replay"]["request"] == request
    assert any(f["value"] == morphology.RULES["circularity"] for f in context["settings"])


@pytest.mark.parametrize("operation", ["correct_result", "roi_add", "roi_import", "direct-import"])
def test_mutation_of_derivative_refused_before_decode_including_direct_import(
    make_parent, monkeypatch, operation
):
    wb, parent, _, _, _ = make_parent()
    _, result = derived(wb, parent)
    request = exact(result)
    if operation == "correct_result":
        request["operations"] = []
    elif operation == "roi_add":
        request["roi"] = {}
    else:
        request.update(format="geojson", payload="invalid before decode")
    monkeypatch.setattr(wb.project, "load_array", lambda *_: pytest.fail("Decoded derivative"))
    with pytest.raises(ValueError, match="underlying label result"):
        if operation == "direct-import":
            import_annotations(wb, request)
        else:
            wb.execute(operation, request)
    assert len(wb.project.list_results()) == 2


def test_cancelled_native_job_has_no_derivative_publication(make_parent):
    wb, parent, _, _, _ = make_parent()
    job = submit_job(wb, binding(parent), "cancel-morph", operation="morphometrics_run")
    cancel_job(wb.project, job["id"])
    assert run_job(wb, job["id"])["job"]["state"] == "cancelled"
    assert wb.project.job(job["id"])["result_ids"] == []
    assert len(wb.project.list_results()) == 1


def test_native_cancellation_inside_kernel_is_checked_before_next_block(make_parent, monkeypatch):
    wb, parent, _, _, _ = make_parent()
    job = submit_job(wb, binding(parent), "cancel-in-kernel", operation="morphometrics_run")
    kernel = morphology.measure_morphometrics

    def cancel_then_scan(*args, **kwargs):
        cancel_job(wb.project, job["id"])
        return kernel(*args, **kwargs)

    monkeypatch.setattr(morphology, "measure_morphometrics", cancel_then_scan)
    with pytest.raises(ValueError, match="cancelled or stopped"):
        run_job(wb, job["id"])
    assert wb.project.job(job["id"])["state"] == "cancelled"
    assert wb.project.job(job["id"])["result_ids"] == []
    assert len(wb.project.list_results()) == 1


@pytest.mark.parametrize("volume", [False, True])
def test_normal_and_normalized_data_exports_preserve_rules_units_nulls_and_cold_reopen(
    make_parent, tmp_path, volume
):
    wb, parent, _, _, _ = make_parent(volume=volume)
    _, result = derived(wb, parent)
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    target = tmp_path / "reviewed-shape"
    export_research_result(wb.project, result["id"], result["revision_hash"], target)
    contract = result["provenance"]["morphometrics"]
    assert json.loads((target / "morphometrics.json").read_text()) == contract
    assert json.loads((target / "result.json").read_text())["result"] == result
    methods = (target / "methods.md").read_text()
    assert morphology.RULES["pixel_extent_moments"] in methods
    package = tmp_path / "data"
    plan = plan_export(wb.project, data_request(result))
    export_data_package(wb.project, plan["plan_json"], package)
    records = [
        json.loads(line)["object"]
        for line in (package / "object-records.jsonl").read_text().splitlines()
    ]
    assert sorted(records, key=lambda r: r["label"]) == sorted(
        result["provenance"]["measurements"], key=lambda r: r["label"]
    )
    with (package / "measurements.csv").open(newline="") as stream:
        metrics = list(csv.DictReader(stream))
    endpoint = "surface_area" if volume else "perimeter"
    assert any(
        r["metric_id"] == "morphometrics:" + endpoint and r["status"] == "value" for r in metrics
    )
    if not volume:
        assert any(
            r["metric_id"] == "morphometrics:elongation" and r["status"] == "null" for r in metrics
        )
    provenance = json.loads((package / "provenance.json").read_text())
    assert provenance["results"][0]["morphometrics"] == contract
    reopened = ResearchProject(wb.project.root)
    assert reopened.result(result["id"]) == result
    assert reopened.result(parent["id"]) == parent
    for name in ("image", "labels"):
        assert result["arrays"][name] == parent["arrays"][name]
        assert not reopened.load_array(result["arrays"][name]).flags.writeable


@pytest.mark.parametrize("route", ["result-export", "data-export", "study-export"])
def test_self_consistent_rehashed_moments_fail_numerical_export_before_publication(
    make_parent, tmp_path, route
):
    wb, parent, _, _, _ = make_parent()
    _, result = derived(wb, parent)
    bad = changed_moments(result)
    replace_record(wb.project, bad)
    morphology.validate_record(bad)
    target = tmp_path / "unpublished"
    with pytest.raises(ValueError, match="endpoints disagree"):
        if route == "result-export":
            wb.project.review(bad["id"], bad["revision_hash"], "reviewed")
            export_research_result(wb.project, bad["id"], bad["revision_hash"], target)
        elif route == "data-export":
            plan_export(wb.project, data_request(bad))
        else:
            export_project(wb.project, target)
    assert not target.exists()


def test_portable_staged_arrays_recompute_moments_even_with_rewritten_record_and_manifest(
    make_parent, tmp_path
):
    wb, parent, _, _, source_path = make_parent()
    _, result = derived(wb, parent)
    archive = tmp_path / "morph.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "restored-study")
    assert restored.result(result["id"]) == result
    restored.relink(parent["source_id"], source_path)
    assert Workbench(restored).execute("population_query", exact(result))["total_count"] == 2
    bad = changed_moments(result)

    def mutate(entries):
        name = f"results/{result['id']}.json"
        payload = canonical_json(bad).encode()
        rewritten = [(info, payload if info.filename == name else data) for info, data in entries]
        for index, (info, data) in enumerate(rewritten):
            if info.filename == "manifest.json":
                manifest = json.loads(data)
                member = next(m for m in manifest["members"] if m["path"] == name)
                member.update(sha256=hashlib.sha256(payload).hexdigest(), size_bytes=len(payload))
                rewritten[index] = (info, canonical_json(manifest).encode())
        return rewritten

    tampered = tmp_path / "tampered.zip"
    _rewrite(archive, tampered, mutate)
    target = tmp_path / "refused-study"
    with pytest.raises(ValueError, match="endpoints disagree"):
        import_project(tampered, target)
    assert not target.exists()


def morphology_graph(wb, parent):
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Exact digital morphology",
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
        "outputs": {"measured": {"node": "shape", "port": "result"}},
        "working_bytes": 16 * 1024**2,
    }
    workflow = call(
        wb, "save", {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": definition}
    )["workflow"]
    request = {
        "workflow_id": workflow["id"],
        "workflow_revision": workflow["revision"],
        "definition_sha256": workflow["data"]["definition_sha256"],
        "bindings": {"objects": exact(parent)},
    }
    plan = call(wb, "preflight", request)["plan"]
    return {**request, "plan_sha256": plan["plan_sha256"], "request_key": "graph-morph"}, plan


def test_graph_adapter_pins_method_identity_and_keeps_exact_own_job_portably(make_parent, tmp_path):
    wb, parent, _, _, _ = make_parent()
    request, plan = morphology_graph(wb, parent)
    assert plan["method_identities"]["morphometrics_run"] == morphology._software()
    run = advance(wb, start(wb, request))
    run_child(wb, run, "shape")
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    assert run["data"]["state"] == "succeeded"
    output = run["data"]["outputs"]["measured"]
    result = wb.project.result(output["result_id"])
    assert result["parent_id"] == parent["id"] and result["arrays"] == parent["arrays"]
    jobs = wb.project.list_jobs()
    assert len(jobs) == 1 and result["provenance"]["job_id"] == jobs[0]["id"] != run["id"]
    assert advance(wb, run)["data"]["state"] == "succeeded"
    assert len(wb.project.list_jobs()) == 1
    archive = tmp_path / "graph-shape.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "graph-restored")
    assert restored.documents("workflow_run", document_id=run["id"])[0] == run
    assert restored.result(result["id"]) == result


def test_graph_resume_refuses_changed_method_before_scheduling(make_parent, monkeypatch):
    wb, parent, _, _, _ = make_parent()
    request, plan = morphology_graph(wb, parent)
    run = start(wb, request)
    monkeypatch.setattr(
        morphology,
        "_software",
        lambda: {**plan["method_identities"]["morphometrics_run"], "kernel_sha256": "f" * 64},
    )
    with pytest.raises(ValueError, match="plan|runtime|identit"):
        advance(wb, run)
    assert wb.project.list_jobs() == []


def test_source_recipe_then_morphology_each_publish_under_separate_native_job(make_parent):
    wb, parent, _, _, _ = make_parent()
    source = wb.project.source(parent["source_id"])
    definition = {
        "schema": "loci.workflow/v2",
        "name": "Segment then digital morphology",
        "inputs": {"image": "source-selection"},
        "nodes": [
            {
                "id": "mask",
                "operation": "run_recipe",
                "contract_version": 1,
                "inputs": {"source": {"input": "image"}},
                "settings": {"recipe": {"segmentation": {"method": "components", "threshold": 20}}},
            },
            {
                "id": "shape",
                "operation": "morphometrics_run",
                "contract_version": 1,
                "inputs": {"objects": {"node": "mask", "port": "result"}},
                "settings": {},
            },
        ],
        "outputs": {"measured": {"node": "shape", "port": "result"}},
        "working_bytes": 16 * 1024**2,
    }
    saved = call(
        wb, "save", {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": definition}
    )["workflow"]
    request = {
        "workflow_id": saved["id"],
        "workflow_revision": saved["revision"],
        "definition_sha256": saved["data"]["definition_sha256"],
        "bindings": {
            "image": {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "selection": parent["provenance"]["selection"],
            }
        },
    }
    plan = call(wb, "preflight", request)["plan"]
    run = start(wb, {**request, "plan_sha256": plan["plan_sha256"], "request_key": "two-steps"})
    for identity in ("mask", "shape"):
        run = advance(wb, run)
        run_child(wb, run, identity)
    run = call(wb, "status", {"run_id": run["id"]})["run"]
    assert run["data"]["state"] == "succeeded"
    result = wb.project.result(run["data"]["outputs"]["measured"]["result_id"])
    mask = wb.project.result(result["parent_id"])
    assert result["arrays"] == mask["arrays"]
    assert result["provenance"]["parent_result"] == exact(mask)
    assert result["provenance"]["job_id"] != mask["provenance"]["job_id"]
    assert {job["operation"] for job in wb.project.list_jobs()} == {
        "run_recipe",
        "morphometrics_run",
    }
    assert all(job["id"] != run["id"] for job in wb.project.list_jobs())
