"""Scoped density inspection and atomic durable report publication, generated data only."""

import copy
from contextlib import contextmanager
from dataclasses import replace

import pytest
from test_agent_policy import runtime_identity, specification
from test_agent_review import DISCLOSURES
from test_research_spatial_density import density as density

from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.quantitative import measure_objects
from loci_engine.research_action_registry import (
    ACTION_NAMES,
    READ_ACTIONS,
    TASK_ACTIONS,
    action_guide,
)
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import canonical_json
from loci_engine.research_spatial_density import (
    DOCUMENT_KIND,
    _load_preview,
    execute,
    save_job,
    save_task_source,
)
from loci_engine.workbench import runtime_record


def scoped_agent(tmp_path, wb, results, *, memory_bytes=128 * 1024**2):
    root = tmp_path / "agent-exports"
    root.mkdir(exist_ok=True)
    source = wb.project.source(results[0]["source_id"])
    recipe = {
        "source_id": source["id"],
        "selection": {},
        "recipe": {
            "segmentation": {"method": "components", "threshold": 0},
            "measurement_channels": [0],
        },
    }
    spec = specification(wb, source, recipe, root, disclosures=DISCLOSURES, recipes=False)
    unique = {r["source_id"]: r for r in results}
    spec["sources"] = []
    for r in unique.values():
        selection = wb.selection(r["source_id"], {})
        spec["sources"].append(
            {
                "id": r["source_id"],
                "sha256": r["source_sha256"],
                "crop": {key: selection[key] for key in ("x", "y", "width", "height")},
                "t": [0],
                "c": [0],
                "z": [0],
                "level": [0],
                "measurement_channels": [0],
            }
        )
    spec["actions"] = sorted(ACTION_NAMES)
    spec["operations"] += ["validate_action", "inspect_action", "submit_action", "study_results"]
    spec.update(
        remote_grants=[],
        experimental_recipes=[],
        delegation={
            "id": "d" * 32,
            "client_id": "density-fixture-client",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
    )
    spec["runtimes"] = [runtime_identity()]
    spec["limits"]["memory_bytes"] = memory_bytes
    path = tmp_path / "density-policy.json"
    write_policy(path, wb.project, spec)
    return PolicyAgent(load_policy(path))


def test_density_registry_modes_and_no_export_path_authority():
    assert {
        "spatial_density_preview",
        "spatial_density_get",
        "spatial_density_list",
    } <= READ_ACTIONS
    assert "spatial_density_save" in TASK_ACTIONS
    assert "spatial_density_export" not in ACTION_NAMES
    guide = action_guide("spatial_density_save")["actions"][0]
    assert guide["execution_kind"] == "publication-task"
    assert guide["output_types"] == ["immutable-density-report"]


def test_agent_preview_save_job_get_list_match_native_endpoints(density, tmp_path):
    wb, request, results, _ = density
    agent = scoped_agent(tmp_path, wb, results)
    opaque = inspect_action(agent, wb, "spatial_density_preview", request)
    token = {k: opaque[k] for k in ("preview_id", "preview_hash")}
    report = _load_preview(wb.project, token)
    assert report["aggregation"]["condition_rows"][0]["mean"] == pytest.approx(0.00625)
    with pytest.raises(ValueError, match="inspection or durable-task"):
        authorize_action(agent, wb, "spatial_density_save", token, mode="read")
    normalized = authorize_action(agent, wb, "spatial_density_save", token, mode="task")
    job = submit_job(wb, normalized, "density-agent-save", operation="spatial_density_save")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert output["job"]["result_ids"] == []
    assert output["job"]["report_id"] == output["report_id"]
    assert output["report"] == report
    got = inspect_action(agent, wb, "spatial_density_get", {"report_id": output["report_id"]})
    assert got["summary"]["report_hash"] == report["report_hash"]
    assert "report" not in got
    assert [r["id"] for r in inspect_action(agent, wb, "spatial_density_list", {})["reports"]] == [
        output["report_id"]
    ]
    assert len(wb.project.documents(DOCUMENT_KIND)) == 1


def test_every_recursive_spatial_role_requires_runtime_and_source_grants(
    density, tmp_path, monkeypatch
):
    wb, request, results, parents = density
    agent = scoped_agent(tmp_path, wb, results)
    visited = []
    original = agent._authorize_result

    def observe(workbench, identity):
        visited.append(identity)
        return original(workbench, identity)

    monkeypatch.setattr(agent, "_authorize_result", observe)
    authorize_action(agent, wb, "spatial_density_preview", request, mode="read")
    assert {p["id"] for p in parents} <= set(visited)
    agent.policy = replace(agent.policy, runtimes=[])
    with pytest.raises(PermissionError, match="runtime"):
        authorize_action(agent, wb, "spatial_density_preview", request, mode="read")


def test_ungranted_input_refused_before_decoding_or_task_creation(density, tmp_path, monkeypatch):
    wb, request, results, _ = density
    agent = scoped_agent(tmp_path, wb, results[:1])
    decoded = []
    monkeypatch.setattr(wb.project, "load_array", lambda descriptor: decoded.append(descriptor))
    with pytest.raises(PermissionError):
        inspect_action(agent, wb, "spatial_density_preview", request)
    assert decoded == []
    assert wb.project.list_jobs() == []
    assert wb.project.documents(DOCUMENT_KIND) == []


def cropped_result(wb, original):
    source_id = original["source_id"]
    raw, geometry, selection = wb.load_scalar(source_id, {"x": 0, "y": 0, "width": 6, "height": 10})
    inputs = []
    for name in ("labels", "compartment_labels", "boundary_labels"):
        labels = wb.project.load_array(original["arrays"][name])[:, :6]
        inputs.append(
            wb.project.save_result(
                source_id=source_id,
                kind="segmentation",
                arrays={"image": raw, "labels": labels},
                provenance={
                    "geometry": geometry.to_dict(),
                    "selection": selection,
                    "runtime": runtime_record(),
                    "measurement_channels": [0],
                    "measurements": measure_objects(labels, geometry, {"raw": raw}),
                },
            )
        )
    b = [{"result_id": r["id"], "revision_hash": r["revision_hash"]} for r in inputs]
    result = wb.execute(
        "spatial_distance_run",
        {
            **b[0],
            "compartment": b[1],
            "boundary": b[2],
            "band_edges": [0, 20],
            "exclude_crop_border": True,
            "control": "Generated crop",
            "boundary_coverage": "Supplied column",
            "working_bytes": 16 * 1024**2,
        },
    )["result"]
    return wb.project.result(result["id"])


def test_listing_filters_source_and_crop_without_unrelated_counts(density, tmp_path):
    wb, request, results, _ = density
    hidden = execute(
        wb.project,
        "spatial_density_save",
        token_of(execute(wb.project, "spatial_density_preview", {"fields": request["fields"][:1]})),
    )
    other_source = execute(
        wb.project,
        "spatial_density_save",
        token_of(
            execute(wb.project, "spatial_density_preview", {"fields": request["fields"][1:2]})
        ),
    )
    crop = cropped_result(wb, results[0])
    allowed = execute(
        wb.project,
        "spatial_density_save",
        token_of(
            execute(
                wb.project,
                "spatial_density_preview",
                {"fields": [{"result_id": crop["id"], "revision_hash": crop["revision_hash"]}]},
            )
        ),
    )
    agent = scoped_agent(tmp_path, wb, results[:1])
    source_id = results[0]["source_id"]
    agent.policy = replace(
        agent.policy,
        sources={source_id: replace(agent.policy.sources[source_id], crop=(0, 0, 6, 10))},
    )
    # Only valid saved reports are present. The policy's project-integrity check
    # remains fail closed independently of report listing authorization.
    listing = inspect_action(agent, wb, "spatial_density_list", {})
    assert [r["id"] for r in listing["reports"]] == [allowed["report_id"]]
    assert hidden["report_id"] not in canonical_json(listing)
    assert other_source["report_id"] not in canonical_json(listing)
    assert set(listing) == {"reports"}
    with pytest.raises(PermissionError):
        inspect_action(agent, wb, "spatial_density_get", {"report_id": hidden["report_id"]})
    with pytest.raises(PermissionError):
        inspect_action(agent, wb, "spatial_density_get", {"report_id": other_source["report_id"]})


@pytest.mark.parametrize("after", ["document", "completion"])
def test_atomic_save_rolls_back_document_and_job_after_insertion(density, monkeypatch, after):
    wb, request, _, _ = density
    opaque = execute(wb.project, "spatial_density_preview", request)
    token = token_of(opaque)
    job = submit_job(wb, token, "density-rollback", operation="spatial_density_save")
    wb.project.update_job(job["id"], expected_state="queued", state="running")
    original = wb.project.connection
    inserted = False

    def trace(sql):
        nonlocal inserted
        if (after == "document" and sql.startswith("INSERT INTO documents")) or (
            after == "completion" and sql.startswith("UPDATE jobs SET record=")
        ):
            inserted = True

    @contextmanager
    def observed_connection():
        with original() as connection:
            connection.set_trace_callback(trace)
            yield connection

    def revoke():
        if inserted:
            raise PermissionError("fixture revocation after document insertion")

    monkeypatch.setattr(wb.project, "connection", observed_connection)
    with pytest.raises(PermissionError, match="after document insertion"):
        save_job(wb.project, token, job["id"], check=revoke)
    assert wb.project.documents(DOCUMENT_KIND) == []
    assert wb.project.job(job["id"])["state"] == "running"


@pytest.mark.parametrize("tamper", ["cancelled", "operation", "request"])
def test_atomic_save_requires_exact_uncancelled_running_job(density, tamper):
    wb, request, _, _ = density
    opaque = execute(wb.project, "spatial_density_preview", request)
    token = token_of(opaque)
    submitted = copy.deepcopy(token)
    operation = "spatial_density_save"
    if tamper == "operation":
        operation = "intensity_save"
    if tamper == "request":
        submitted["preview_hash"] = "f" * 64
    job = wb.project.submit(
        operation,
        {"source_id": save_task_source(wb.project, token), "task_request": submitted},
        "density-wrong-job",
    )
    wb.project.update_job(
        job["id"], expected_state="queued", state="running", cancel_requested=tamper == "cancelled"
    )
    with pytest.raises(ValueError, match="changed|cancelled"):
        save_job(wb.project, token, job["id"])
    assert wb.project.documents(DOCUMENT_KIND) == []
    assert wb.project.job(job["id"])["state"] == "running"


def token_of(output):
    return {k: output[k] for k in ("preview_id", "preview_hash")}
