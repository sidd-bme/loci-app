"""Combined native/MCP engineering journeys on small authored scalar fixtures.

External fixture bytes exercise adoption, never imported-method execution or
scientific qualification. The real stdio test uses the existing bounded engine
launcher and policy; no custom runtime, network, model or protected data is used.
"""

import asyncio
import copy
import csv
import json
import struct
import tempfile
import time
import zipfile
from types import SimpleNamespace

import numpy as np
import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_actions import actions_agent
from test_research_annotation_evaluation import _add
from test_research_mcp import stdio_parameters
from test_research_methods import package_file

from loci_engine import method_protocol as protocol
from loci_engine import research_data_export as data_export
from loci_engine import research_methods as methods
from loci_engine.agent_actions import authorize_action
from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_interchange import (
    export_project,
    import_project,
    relink_interchanged_source,
)
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_mcp import PolicyAgent
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


def bound(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def run_native(workbench, operation, request, key, *, check=None):
    job = submit_job(workbench, request, key, operation=operation)
    output = run_job(workbench, job["id"], publication_guard=check)
    assert output["job"]["state"] == "succeeded", output
    result = workbench.project.result(output["result"]["id"]) if "result" in output else None
    return result, output


@pytest.fixture
def combined_scene(tmp_path):
    _, wb, _, policy_path, recipe, spec, _ = actions_agent(tmp_path)
    spec["sources"][0]["c"] = [0, 1]
    spec["sources"][0]["measurement_channels"] = [0, 1]
    write_policy(policy_path, wb.project, spec)
    agent = PolicyAgent(load_policy(policy_path))
    selection = {"x": 0, "y": 0, "width": 32, "height": 32, "z": 1, "t": 0, "c": 0, "level": 0}
    parent = wb.project.result(wb.run_recipe({**recipe, "selection": selection})["result"]["id"])
    package_path, package = package_file(tmp_path)
    package["manifest"]["metrics"].append(
        {
            "id": "fixture_score",
            "kind": "prediction",
            "unit": "probability",
            "description": "Authored technical fixture score; no accuracy claim",
        }
    )
    package_path.write_text(json.dumps(package))
    imported = methods.import_package(wb, package_path, authority=methods.NATIVE_AUTHORITY)
    request = {
        **bound(parent),
        "method_id": imported["method_id"],
        "manifest_sha256": imported["manifest_sha256"],
        "module_sha256": imported["module_sha256"],
        "raw_channels": [1, 0],
        "working_bytes": 64 * 1024**2,
    }
    flight = wb.execute("method_preflight", request)
    assert flight["preflight"]["label_ids"] == [1]
    output_path = tmp_path / "technical-output.bin"
    output_path.write_bytes(struct.pack("<8sIIIdd", protocol.OUTPUT_MAGIC, 1, 2, 1, 64.0, 0.375))
    grant = methods.create_output_grant(
        wb,
        output_path,
        {**request, "preflight_hash": flight["preflight_hash"]},
        authority=methods.NATIVE_AUTHORITY,
    )
    run_request = {
        **request,
        "preflight_hash": flight["preflight_hash"],
        "mode": "adopt-external",
        "output_grant_id": grant["output_grant_id"],
    }
    yield SimpleNamespace(
        wb=wb,
        parent=parent,
        agent=agent,
        policy_path=policy_path,
        spec=spec,
        request=request,
        flight=flight,
        run=run_request,
        source=wb.project.source(parent["source_id"]),
        source_path=tmp_path / "synthetic.tif",
    )
    wb.close()


def test_native_method_annotation_data_export_and_portable_reuse(combined_scene, tmp_path):
    scene = combined_scene
    wb = scene.wb
    method_result, _ = run_native(wb, "method_run", scene.run, "native-method")
    raw = wb.project.load_array(method_result["arrays"]["method_raw"])
    assert np.all(raw[0] == 20)  # Requested C1 then C0, never implicit channel order.
    assert raw[1, 4:12, 4:12].sum() == 6400
    query = wb.execute("method_query", {**bound(method_result), "offset": 0, "limit": 1})
    assert query["rows"] == [{"label_id": 1, "values": [64.0, 0.375]}]
    population = wb.execute(
        "population_query",
        {
            **bound(method_result),
            "x_metric": "controlled_method:pixel_count",
            "y_metric": "controlled_method:fixture_score",
        },
    )
    descriptors = {metric["id"]: metric for metric in population["metrics"]}
    assert (
        descriptors["controlled_method:pixel_count"]["kind"],
        descriptors["controlled_method:pixel_count"]["unit"],
    ) == ("measurement", "pixel")
    assert (
        descriptors["controlled_method:fixture_score"]["kind"],
        descriptors["controlled_method:fixture_score"]["unit"],
    ) == ("prediction", "probability")
    assert population["rows"][0]["values"]["controlled_method:fixture_score"] == 0.375

    annotation = _add(
        wb, scene.source, [(4, 4), (12, 4), (12, 12), (4, 12)], z=1, t=0, kind="rectangle"
    )
    freeze = {
        **bound(method_result),
        "source_annotations_revision": annotation["revision"],
        "annotation_ids": [annotation["annotations"][0]["id"]],
        "semantics": "instances",
        "coverage_declaration": "Complete synthetic crop; one authored reference square",
        "working_bytes": 64 * 1024**2,
    }
    reference, _ = run_native(wb, "annotation_reference_run", freeze, "native-reference")
    comparison = {
        **bound(method_result),
        "reference": bound(reference),
        "semantics": "instances",
        "iou_thresholds": [0.5],
        "reference_declaration": "Authored technical reference; no biological truth claim",
        "working_bytes": 64 * 1024**2,
    }
    agreement, _ = run_native(wb, "annotation_evaluation_run", comparison, "native-agreement")
    report = wb.execute("annotation_evaluation_get", {**bound(agreement), "table": "summary"})
    assert agreement["provenance"]["annotation_evaluation"]["metrics"]["region"]["iou"] == 1.0
    assert report["result_id"] == agreement["id"]

    planned = data_export.plan_export(
        wb.project,
        {
            "purpose": "provisional",
            "bindings": [
                {
                    **bound(method_result),
                    "source_id": method_result["source_id"],
                    "source_sha256": method_result["source_sha256"],
                    "group_ids": [],
                    "subset": "all",
                }
            ],
        },
    )
    export_target = tmp_path / "scientific-method-data"
    export_grant = data_export.create_export_grant(
        wb.project, planned["plan_json"], str(export_target)
    )
    _, exported = run_native(
        wb,
        "scientific_data_export",
        {"grant_id": export_grant["grant_id"], "plan_sha256": export_grant["plan_sha256"]},
        "native-data-export",
    )
    assert exported["job"]["state"] == "succeeded"
    with (export_target / "measurements.csv").open(newline="") as handle:
        csv_rows = {row["metric_id"]: row for row in csv.DictReader(handle)}
    assert (
        csv_rows["controlled_method:pixel_count"]["kind"],
        csv_rows["controlled_method:pixel_count"]["unit"],
        csv_rows["controlled_method:pixel_count"]["value"],
    ) == ("measurement", "pixel", "64.0")
    assert (
        csv_rows["controlled_method:fixture_score"]["kind"],
        csv_rows["controlled_method:fixture_score"]["unit"],
        csv_rows["controlled_method:fixture_score"]["value"],
    ) == ("prediction", "probability", "0.375")

    rights = {k: scene.request[k] for k in ("method_id", "manifest_sha256", "module_sha256")}
    methods.review_rights(
        wb,
        {
            **rights,
            "decision": "approved",
            "reviewer": "Technical fixture reviewer",
            "evidence": "Synthetic test license declaration reviewed only for this fixture",
        },
        authority=methods.NATIVE_AUTHORITY,
    )
    assert wb.project.documents(methods.AUTHORITY_KIND) and wb.project.documents(
        methods.OUTPUT_KIND
    )
    archive = tmp_path / "method-annotation.loci-study.zip"
    export_project(wb.project, archive)
    with zipfile.ZipFile(archive) as package:
        assert not any(
            f"documents/{kind}/" in name
            for name in package.namelist()
            for kind in methods.LOCAL_DOCUMENT_KINDS
        )
    restored = import_project(archive, tmp_path / "restored.loci-study")
    assert all(restored.documents(kind) == [] for kind in methods.LOCAL_DOCUMENT_KINDS)
    reopened = Workbench(ResearchProject(wb.project.root))
    portable = Workbench(restored)
    try:
        assert reopened.project.result(agreement["id"]) == agreement
        assert portable.project.result(method_result["id"]) == method_result
        assert portable.project.result(agreement["id"]) == agreement
        assert (
            portable.execute("method_query", {**bound(method_result), "offset": 0, "limit": 1})[
                "rows"
            ]
            == query["rows"]
        )
        assert (
            portable.execute("method_get", {"method_id": scene.request["method_id"]})[
                "rights_status"
            ]
            == "not-reviewed"
        )
        relink_interchanged_source(restored, scene.source["id"], scene.source_path)
        assert (
            portable.execute("method_preflight", scene.request)["preflight_hash"]
            == scene.flight["preflight_hash"]
        )
    finally:
        reopened.close()
        portable.close()


def test_real_mcp_discovers_submits_and_reads_same_method_values(combined_scene):
    scene = combined_scene

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(scene.policy_path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, arguments):
                deadline = time.monotonic() + 20
                while True:
                    result = await session.call_tool(name, arguments)
                    if not result.is_error:
                        return result.structured_content
                    message = " ".join(getattr(block, "text", "") for block in result.content)
                    assert "concurrency allowance" in message and time.monotonic() < deadline, (
                        result
                    )
                    # A durable terminal row can precede its exact worker's
                    # reap. Honor only the API's explicit retryable capacity
                    # response; other failures remain immediate failures.
                    await asyncio.sleep(0.025)

            guide = await call("action_guide", {})
            actions = {action["operation"] for action in guide["actions"]}
            assert {
                "method_preflight",
                "method_run",
                "method_query",
                "annotation_evaluation_run",
            } <= actions
            assert not {"method_import", "method_approve", "method_output_grant"} & actions
            flight = await call(
                "inspect_action", {"operation": "method_preflight", "request": scene.request}
            )
            assert flight["preflight_hash"] == scene.flight["preflight_hash"]
            submitted = await call(
                "submit_action",
                {"operation": "method_run", "request": scene.run, "request_key": "mcp-method"},
            )
            job_id = submitted["job"]["id"]
            deadline = time.monotonic() + 20
            while True:
                job = (await call("job_status", {"job_id": job_id}))["job"]
                if job["state"] not in {"queued", "running"}:
                    break
                assert time.monotonic() < deadline, job
                await asyncio.sleep(0.025)
            assert job["state"] == "succeeded", job
            result = scene.wb.project.result(job["result_ids"][0])
            query = await call(
                "inspect_action",
                {
                    "operation": "method_query",
                    "request": {**bound(result), "offset": 0, "limit": 1},
                },
            )
            assert query["rows"] == [{"label_id": 1, "values": [64.0, 0.375]}]
            population = await call(
                "inspect_action",
                {
                    "operation": "population_query",
                    "request": {**bound(result), "x_metric": "controlled_method:fixture_score"},
                },
            )
            assert population["rows"][0]["values"]["controlled_method:fixture_score"] == 0.375
            assert "module_base64" not in canonical_json(query)
            inspected = await call("result", {"result_id": result["id"]})
            disclosed = canonical_json(inspected)
            assert "module_base64" not in disclosed
            assert "output_grant_id" not in disclosed
            assert scene.run["output_grant_id"] not in disclosed
            replay = await call(
                "submit_action",
                {"operation": "method_run", "request": scene.run, "request_key": "mcp-method"},
            )
            assert replay["job"]["id"] == job_id

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))


def test_ungranted_raw_channel_and_reference_refuse_before_decode(combined_scene, monkeypatch):
    scene = combined_scene
    wb = scene.wb
    outside = wb.project.result(
        wb.run_recipe(
            {
                "source_id": scene.parent["source_id"],
                "selection": {**scene.parent["provenance"]["selection"], "t": 1},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 50},
                    "measurement_channels": [0],
                },
            }
        )["result"]["id"]
    )
    limited = copy.deepcopy(scene.spec)
    limited["sources"][0].update(c=[0], measurement_channels=[0])
    write_policy(scene.policy_path, wb.project, limited)
    limited_agent = PolicyAgent(load_policy(scene.policy_path))
    monkeypatch.setattr(wb, "load_scalar", lambda *a, **k: pytest.fail("denial decoded raw source"))
    monkeypatch.setattr(
        wb.project, "load_array", lambda *a, **k: pytest.fail("denial decoded retained arrays")
    )
    with pytest.raises(PermissionError, match="channel|selection"):
        authorize_action(limited_agent, wb, "method_preflight", scene.request, mode="read")
    compare = {
        **bound(scene.parent),
        "reference": bound(outside),
        "semantics": "instances",
        "iou_thresholds": [0.5],
        "reference_declaration": "Outside-T fixture must refuse",
        "working_bytes": 64 * 1024**2,
    }
    with pytest.raises(PermissionError, match="selection|grant"):
        authorize_action(limited_agent, wb, "annotation_evaluation_run", compare, mode="task")


@pytest.mark.parametrize("interruption", ["cancel", "policy-revocation"])
def test_integrated_publication_cancel_or_policy_revocation_keeps_no_partial_result(
    combined_scene, monkeypatch, interruption
):
    scene = combined_scene
    wb = scene.wb
    request = authorize_action(scene.agent, wb, "method_run", scene.run, mode="task")
    job = submit_job(wb, request, f"interrupted-{interruption}", operation="method_run")
    before = {row["id"] for row in wb.project.list_results()}
    original = wb.project.save_result

    def interrupt_at_publication(**kwargs):
        if interruption == "cancel":
            cancel_job(wb.project, job["id"])
        else:
            scene.policy_path.unlink()
        return original(**kwargs)

    monkeypatch.setattr(wb.project, "save_result", interrupt_at_publication)
    with pytest.raises(
        (ValueError, PermissionError), match="cancel|running|accessible|Policy|current"
    ):
        run_job(wb, job["id"], publication_guard=scene.agent.policy.recheck)
    assert {row["id"] for row in wb.project.list_results()} == before
    assert wb.project.job(job["id"])["state"] == (
        "cancelled" if interruption == "cancel" else "failed"
    )
