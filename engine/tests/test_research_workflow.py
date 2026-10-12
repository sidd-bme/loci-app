"""Behavioral workflow contracts, including publication and recovery boundaries."""

import copy
import csv
import json
import math

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_workflow import (
    export_run,
    validate_definition,
    validate_workflow_document,
)
from loci_engine.workbench import Workbench


def definition():
    nodes = [
        {"id": "source", "type": "source", "settings": {}},
        {
            "id": "background",
            "type": "process",
            "settings": {"op": "subtract_constant", "value": 10},
        },
        {"id": "segment", "type": "segment", "settings": {"method": "components", "threshold": 50}},
        {
            "id": "measure",
            "type": "measure",
            "settings": {"measurement_channels": [0], "gates": []},
        },
        {
            "id": "population",
            "type": "population",
            "settings": {"filters": [{"metric": "measure", "min": 10, "unit": "pixel^2"}]},
        },
        {"id": "review", "type": "review", "settings": {}},
        {"id": "export", "type": "export", "settings": {}},
    ]
    return {
        "schema": "loci.workflow/v1",
        "name": "Measured objects",
        "nodes": nodes,
        "edges": [
            {"from": left["id"], "to": right["id"]}
            for left, right in zip(nodes, nodes[1:], strict=False)
        ],
        "working_bytes": 512 * 1024**2,
    }


@pytest.fixture
def workflow(tmp_path):
    image = np.full((32, 32), 10, np.uint16)
    image[2:6, 5:9] = 100
    image[15:17, 20:22] = 90
    path = tmp_path / "source.tif"
    tifffile.imwrite(path, image)
    workbench = Workbench(ResearchProject.create(tmp_path / "study", "Workflow study"))
    source = workbench.import_native(str(path))
    doc = workbench.execute(
        "workflow_save",
        {
            "workflow_id": "a" * 32,
            "expected_revision": 0,
            "definition": definition(),
        },
    )["workflow"]
    binding = {
        "workflow_id": doc["id"],
        "workflow_revision": doc["revision"],
        "definition_sha256": doc["data"]["definition_sha256"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": {},
    }
    return workbench, binding, image, path


def run(workbench, binding, key="workflow-1"):
    job = submit_job(workbench, binding, key, "workflow_run")
    return run_job(workbench, job["id"])


@pytest.mark.parametrize(
    "mutation",
    [
        lambda d: d["nodes"].append(copy.deepcopy(d["nodes"][0])),
        lambda d: d["edges"].__setitem__(0, {"from": "source", "to": "source"}),
        lambda d: d["edges"].__setitem__(1, copy.deepcopy(d["edges"][0])),
        lambda d: d["edges"].__setitem__(0, {"from": "export", "to": "source"}),
        lambda d: d["edges"].__setitem__(0, {"from": "unknown", "to": "background"}),
        lambda d: d["nodes"][2].__setitem__("type", "process"),
        lambda d: d["nodes"][0]["settings"].__setitem__("source_id", "b" * 32),
        lambda d: d["nodes"][1]["settings"].__setitem__("op", "flatfield"),
        lambda d: d["nodes"][1]["settings"].__setitem__("value", float("nan")),
        lambda d: d["nodes"][4]["settings"]["filters"][0].pop("unit"),
        lambda d: d["nodes"][4]["settings"]["filters"][0].update(min=30, max=20),
        lambda d: d["nodes"][5]["settings"].__setitem__("auto_review", True),
        lambda d: d["nodes"][6]["settings"].__setitem__("destination", "/private/export"),
    ],
)
def test_reject_invalid_typed_graphs_and_unsafe_settings(mutation):
    candidate = definition()
    mutation(candidate)
    with pytest.raises(ValueError):
        validate_definition(candidate)


def test_order_independent_serialization_and_no_processing_definition():
    first = definition()
    shuffled = copy.deepcopy(first)
    shuffled["nodes"].reverse()
    shuffled["edges"].reverse()
    assert validate_definition(first) == validate_definition(shuffled)
    first["nodes"] = [node for node in first["nodes"] if node["type"] != "process"]
    first["edges"] = [
        {"from": a["id"], "to": b["id"]}
        for a, b in zip(first["nodes"], first["nodes"][1:], strict=False)
    ]
    assert validate_definition(first)["recipe"]["steps"] == []


def test_saved_revision_and_source_bindings_are_fail_closed(workflow):
    wb, binding, _, path = workflow
    assert (
        wb.execute("workflow_get", {"workflow_id": binding["workflow_id"]})["workflow"]["revision"]
        == 1
    )
    assert len(wb.execute("workflow_list", {})["workflows"]) == 1
    with pytest.raises(ValueError, match="changed"):
        wb.execute(
            "workflow_save",
            {
                "workflow_id": binding["workflow_id"],
                "expected_revision": 0,
                "definition": definition(),
            },
        )
    with pytest.raises(ValueError, match="source identity"):
        wb.execute("workflow_preflight", {**binding, "source_sha256": "f" * 64})
    assert wb.project.list_jobs() == []
    path.write_bytes(b"changed source")
    with pytest.raises(ValueError):
        wb.execute("workflow_preflight", binding)
    assert wb.project.list_results() == []


def test_preflight_units_unknown_metrics_gates_and_budget(workflow):
    wb, binding, _, _ = workflow
    for metric, unit in [("measure", "um^2"), ("inferred_phenotype", "pixel^2")]:
        candidate = definition()
        candidate["nodes"][4]["settings"]["filters"] = [{"metric": metric, "unit": unit, "min": 1}]
        doc = wb.execute(
            "workflow_save",
            {
                "workflow_id": binding["workflow_id"],
                "expected_revision": binding["workflow_revision"],
                "definition": candidate,
            },
        )["workflow"]
        binding = {
            **binding,
            "workflow_revision": doc["revision"],
            "definition_sha256": doc["data"]["definition_sha256"],
        }
        with pytest.raises(ValueError, match="metric or unit"):
            submit_job(wb, binding, "invalid-units", "workflow_run")
    assert wb.project.list_jobs() == []


def test_raw_measurements_recipe_parity_population_and_review_export(workflow, tmp_path):
    wb, binding, image, path = workflow
    source_bytes = path.read_bytes()
    prepared = wb.execute("workflow_preflight", binding)
    assert prepared["metrics"][0]["label"] == "Area"
    assert all(metric.get("label") for metric in prepared["metrics"])
    assert any(metric["label"].endswith(" · mean") for metric in prepared["metrics"])
    direct = wb.run_recipe(
        {"source_id": binding["source_id"], "selection": {}, "recipe": prepared["recipe"]}
    )
    output = run(wb, binding)
    assert output["job"]["state"] == "succeeded"
    assert output["measurements"] == direct["measurements"]
    assert [next(iter(row["intensity"].values()))["mean"] for row in output["measurements"]] == [
        100,
        90,
    ]
    result = wb.project.result(output["result"]["id"])
    np.testing.assert_array_equal(
        wb.project.load_array(result["arrays"]["image"]), image.astype(float) - 10
    )
    assert result["provenance"]["measurement_basis"] == "raw-selected-channel-values-on-result-grid"
    population = output["run"]["data"]["population"]
    assert population["total_count"] == 2 and population["filtered_count"] == 1
    assert [row["label"] for row in population["rows"]] == [1]
    request = {
        "run_id": output["job"]["id"],
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "destination": str(tmp_path / "reviewed-export"),
    }
    with pytest.raises(ValueError, match="Review"):
        export_run(wb, request)
    assert (
        wb.execute("workflow_status", {"run_id": output["job"]["id"]})["state"] == "waiting_review"
    )
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    receipt = export_run(wb, request)
    assert (tmp_path / receipt["export_name"] / "manifest.json").exists()
    directory = tmp_path / receipt["export_name"]
    exported_workflow = json.loads((directory / "workflow.json").read_text())
    assert exported_workflow["population"] == output["run"]["data"]["population"]
    assert exported_workflow["selected_labels"] == [1]
    assert exported_workflow["scope"]["labels"] == "full-segmentation"
    with (directory / "selected_measurements.csv").open() as stream:
        selected_rows = list(csv.DictReader(stream))
    assert [int(row["label"]) for row in selected_rows] == [1]
    assert {"workflow.json", "selected_measurements.csv"} <= {
        item["name"] for item in receipt["files"]
    }
    np.testing.assert_array_equal(
        np.load(directory / "labels.npy"), wb.project.load_array(result["arrays"]["labels"])
    )
    status = wb.execute("workflow_status", {"run_id": output["job"]["id"]})
    assert status["state"] == "exported" and status["export_count"] == 1
    assert str(tmp_path) not in json.dumps(status)
    wb.project.review(result["id"], result["revision_hash"], "excluded")
    assert wb.execute("workflow_status", {"run_id": output["job"]["id"]})["state"] == "excluded"
    assert path.read_bytes() == source_bytes
    reopened = Workbench(ResearchProject(wb.project.root))
    assert (
        reopened.execute("workflow_status", {"run_id": output["job"]["id"]})["run"] == output["run"]
    )


def test_previews_are_prefix_bound_nonadopting_and_full_population(workflow):
    wb, binding, _, _ = workflow
    for target in ("source", "background", "segment", "measure", "population"):
        output = wb.execute("workflow_preview", {**binding, "target_node_id": target})
        assert output["preview"] and not output["adopted"]
        assert output["image"].startswith("data:image/png")
        assert output["target_node_id"] == target
        if target == "source":
            assert output["provenance"]["processing"] == [] and output["object_count"] == 0
        if target == "population":
            assert output["population"]["filtered_count"] == 1
    assert wb.project.list_results() == []
    with pytest.raises(ValueError, match="cannot execute"):
        wb.execute("workflow_preview", {**binding, "target_node_id": "review"})
    job = submit_job(wb, {**binding, "target_node_id": "measure"}, "preview", "workflow_preview")
    assert run_job(wb, job["id"])["job"]["state"] == "succeeded"
    assert wb.project.list_results() == []


def test_edited_definitions_invalidate_queued_requests_and_preserve_history(workflow):
    wb, binding, _, _ = workflow
    complete = run(wb, binding)
    queued = submit_job(wb, binding, "queued-before-edit", "workflow_run")
    candidate = definition()
    candidate["nodes"][1]["settings"]["value"] = 20
    wb.execute(
        "workflow_save",
        {"workflow_id": binding["workflow_id"], "expected_revision": 1, "definition": candidate},
    )
    assert wb.execute("workflow_status", {"run_id": complete["job"]["id"]})["workflow_outdated"]
    with pytest.raises(ValueError, match="changed"):
        run_job(wb, queued["id"])
    assert wb.project.job(queued["id"])["state"] == "failed"
    assert len(wb.project.list_results()) == 1
    assert run_job(wb, complete["job"]["id"])["run"] == complete["run"]


def test_atomic_publication_guard_cancellation_and_run_receipt_recovery(workflow, monkeypatch):
    wb, binding, _, _ = workflow
    queued = submit_job(wb, binding, "cancelled", "workflow_run")
    cancel_job(wb.project, queued["id"])
    assert run_job(wb, queued["id"])["job"]["state"] == "cancelled"
    guarded = submit_job(wb, binding, "denied", "workflow_run")

    def denied():
        raise PermissionError("Revoked")

    with pytest.raises(PermissionError):
        run_job(wb, guarded["id"], publication_guard=denied)
    assert not wb.project.list_results()
    original = wb.project.put_document

    def interrupted(kind, *args, **kwargs):
        if kind == "workflow_run":
            raise RuntimeError("Process stopped after atomic result publication")
        return original(kind, *args, **kwargs)

    monkeypatch.setattr(wb.project, "put_document", interrupted)
    job = submit_job(wb, binding, "receipt-interruption", "workflow_run")
    with pytest.raises(RuntimeError, match="atomic result"):
        run_job(wb, job["id"])
    assert wb.project.job(job["id"])["state"] == "succeeded"
    assert len(wb.project.list_results()) == 1
    reopened = Workbench(ResearchProject(wb.project.root))
    recovered = run_job(reopened, job["id"])
    assert recovered["run"]["data"]["job_id"] == job["id"]
    assert len(reopened.project.list_results()) == 1
    assert run_job(reopened, job["id"])["run"] == recovered["run"]


def test_portable_receipts_reject_tampering_and_can_inspect_without_job(workflow):
    wb, binding, _, _ = workflow
    output = run(wb, binding)
    record = copy.deepcopy(output["run"])
    result = wb.project.result(output["result"]["id"])
    sources = [wb.project.source(binding["source_id"])]
    validate_workflow_document(record, sources, [result])
    record["data"]["population"]["filtered_count"] = 100
    with pytest.raises(ValueError, match="replay"):
        validate_workflow_document(record, sources, [result])
    with wb.project.connection() as connection:
        connection.execute("DELETE FROM jobs WHERE id=?", (output["job"]["id"],))
    assert (
        wb.execute("workflow_status", {"run_id": output["job"]["id"]})["state"] == "waiting_review"
    )


def test_portable_study_preserves_workflow_run_and_verified_export(workflow, tmp_path):
    from loci_engine.research_interchange import export_project, import_project

    wb, binding, _, _ = workflow
    output = run(wb, binding)
    result = wb.project.result(output["result"]["id"])
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    export_run(
        wb,
        {
            "run_id": output["job"]["id"],
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "destination": str(tmp_path / "portable-result"),
        },
    )
    archive = tmp_path / "workflow.loci-study.zip"
    exported = export_project(wb.project, archive)
    restored = import_project(
        archive,
        tmp_path / "restored.loci-study",
        expected_archive_sha256=exported["archive_sha256"],
    )
    for kind in ("workflow", "workflow_run", "workflow_export"):
        assert restored.documents(kind) == wb.project.documents(kind)
    candidate = copy.deepcopy(restored.documents("workflow")[0])
    candidate["data"]["definition"]["name"] = "Altered"
    with pytest.raises(ValueError, match="identity"):
        validate_workflow_document(candidate, restored.list_sources(), restored.list_results())


def test_legacy_subnormal_receipt_reopens_and_roundtrips_without_accepting_corruption(
    tmp_path, monkeypatch
):
    import loci_engine.research_population as population
    from loci_engine.research_interchange import (
        export_project,
        import_project,
        relink_interchanged_source,
    )

    image = np.zeros((3, 5), np.float64)
    image[1, 1] = image[1, 3] = math.ulp(0.0)
    path = tmp_path / "subnormal.tif"
    tifffile.imwrite(path, image, metadata={"axes": "YX"})
    wb = Workbench(ResearchProject.create(tmp_path / "legacy-study", "Legacy summary"))
    source = wb.import_native(str(path))
    candidate = definition()
    candidate["nodes"] = [node for node in candidate["nodes"] if node["type"] != "process"]
    candidate["edges"] = [
        {"from": left["id"], "to": right["id"]}
        for left, right in zip(candidate["nodes"], candidate["nodes"][1:], strict=False)
    ]
    next(node for node in candidate["nodes"] if node["type"] == "segment")["settings"][
        "threshold"
    ] = 0
    next(node for node in candidate["nodes"] if node["type"] == "population")["settings"][
        "filters"
    ][0]["min"] = 1
    doc = wb.execute(
        "workflow_save", {"workflow_id": "d" * 32, "expected_revision": 0, "definition": candidate}
    )["workflow"]
    binding = {
        "workflow_id": doc["id"],
        "workflow_revision": doc["revision"],
        "definition_sha256": doc["data"]["definition_sha256"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": {},
    }
    original_summary = population._summary

    def prior_summary(rows, metric, **kwargs):
        summary, values = original_summary(rows, metric)
        size = len(values)
        if size:
            summary["mean"] = math.fsum(value / size for value in values)
            summary["median"] = (
                values[size // 2] if size % 2 else values[size // 2 - 1] / 2 + values[size // 2] / 2
            )
        return summary, values

    # Publish through the real pipeline using the independently reproduced old
    # reductions, then restore current arithmetic before reopen/import checks.
    with monkeypatch.context() as patch:
        patch.setattr(population, "_summary", prior_summary)
        output = run(wb, binding)
    old = output["run"]
    assert old["data"]["population"]["summaries"]["y"]["count"] == 2
    assert old["data"]["population"]["summaries"]["y"]["mean"] == 0
    assert old["data"]["population"]["summaries"]["y"]["median"] == 0
    original_bytes = canonical_json(old)
    result = wb.project.result(output["result"]["id"])
    current = wb.execute(
        "population_query",
        {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
        },
    )
    assert current["summaries"]["y"]["mean"] == math.ulp(0.0)
    reopened = Workbench(ResearchProject(wb.project.root))
    status = reopened.execute("workflow_status", {"run_id": old["id"]})
    assert status["state"] == "waiting_review"
    assert canonical_json(status["run"]) == original_bytes
    archive = tmp_path / "legacy.loci-study.zip"
    exported = export_project(reopened.project, archive)
    restored = import_project(
        archive,
        tmp_path / "restored-legacy.loci-study",
        expected_archive_sha256=exported["archive_sha256"],
    )
    assert canonical_json(restored.documents("workflow_run")[0]) == original_bytes
    relink_interchanged_source(restored, source["id"], path)
    status = Workbench(restored).execute("workflow_status", {"run_id": old["id"]})
    assert status["state"] == "waiting_review"
    assert canonical_json(status["run"]) == original_bytes
    assert canonical_json(reopened.project.documents("workflow_run")[0]) == original_bytes
    for field in ("summary", "membership", "count", "row"):
        altered = copy.deepcopy(old)
        receipt = altered["data"]["population"]
        if field == "summary":
            receipt["summaries"]["y"]["mean"] = 2 * math.ulp(0.0)
        elif field == "membership":
            receipt["membership_sha256"] = "0" * 64
        elif field == "count":
            receipt["filtered_count"] += 1
        else:
            receipt["rows"][0]["label"] = 90000
        with pytest.raises(ValueError, match="replay"):
            validate_workflow_document(altered, restored.list_sources(), restored.list_results())


def test_selected_export_includes_members_beyond_population_page(tmp_path):
    image = np.full((64, 64), 10, np.uint16)
    image[::4, ::4] = 100
    path = tmp_path / "many.tif"
    tifffile.imwrite(path, image)
    wb = Workbench(ResearchProject.create(tmp_path / "many-study", "Many objects"))
    source = wb.import_native(str(path))
    candidate = definition()
    candidate["nodes"][4]["settings"]["filters"][0]["min"] = 1
    doc = wb.execute(
        "workflow_save", {"workflow_id": "c" * 32, "expected_revision": 0, "definition": candidate}
    )["workflow"]
    binding = {
        "workflow_id": doc["id"],
        "workflow_revision": 1,
        "definition_sha256": doc["data"]["definition_sha256"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": {},
    }
    output = run(wb, binding)
    population = output["run"]["data"]["population"]
    assert population["filtered_count"] == 256 and len(population["rows"]) == 200
    result = wb.project.result(output["result"]["id"])
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    export_run(
        wb,
        {
            "run_id": output["job"]["id"],
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "destination": str(tmp_path / "many-export"),
        },
    )
    with (tmp_path / "many-export" / "selected_measurements.csv").open() as stream:
        assert len(list(csv.DictReader(stream))) == 256


def test_empty_population_and_failed_bundle_staging_are_explicit(workflow, tmp_path, monkeypatch):
    wb, binding, _, _ = workflow
    candidate = definition()
    candidate["nodes"][2]["settings"]["threshold"] = 1000
    doc = wb.execute(
        "workflow_save",
        {"workflow_id": binding["workflow_id"], "expected_revision": 1, "definition": candidate},
    )["workflow"]
    binding = {
        **binding,
        "workflow_revision": doc["revision"],
        "definition_sha256": doc["data"]["definition_sha256"],
    }
    output = run(wb, binding)
    assert output["run"]["data"]["population"]["filtered_count"] == 0
    result = wb.project.result(output["result"]["id"])
    wb.project.review(result["id"], result["revision_hash"], "reviewed")

    def failed(_result):
        raise ValueError("Workflow staging failed")

    monkeypatch.setattr("loci_engine.research_workflow.workflow_export_data", failed)
    with pytest.raises(ValueError, match="staging failed"):
        export_run(
            wb,
            {
                "run_id": output["job"]["id"],
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "destination": str(tmp_path / "failed-export"),
            },
        )
    assert not (tmp_path / "failed-export").exists()
    assert wb.project.documents("workflow_export") == []
