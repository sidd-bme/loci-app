"""Exact tissue source/runtime/model scopes and actual network-free MCP stdio."""

import asyncio
import copy
import tempfile
import time

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_policy import runtime_identity
from test_research_mcp import stdio_parameters
from test_tissue_model_integration import produce

from loci_engine import research_tissue_integration as integration
from loci_engine import research_tissue_models as tissue
from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.agent_policy import DISCLOSURES, load_policy, write_policy
from loci_engine.agent_study import authorize_result
from loci_engine.research_mcp import PolicyAgent

pytest_plugins = ["test_tissue_model_integration"]


def policy_spec(case, tmp_path):
    export_root = tmp_path / "exports"
    export_root.mkdir(exist_ok=True)
    return {
        "sources": [
            {
                "id": case.source["id"],
                "sha256": case.source["sha256"],
                "crop": {"x": 0, "y": 0, "width": 10, "height": 8},
                "t": [0],
                "c": [0],
                "z": [0],
                "level": [0],
                "measurement_channels": [0],
            }
        ],
        "recipes": [],
        "operations": [
            "validate_action",
            "inspect_action",
            "submit_action",
            "job_status",
            "cancel_job",
            "result",
            "result_view",
            "export_result",
        ],
        "model_packages": [
            {
                "id": tissue.puma_profile()["model"]["artifact_id"],
                "sha256": tissue.PUMA_WEIGHTS_SHA256,
            }
        ],
        "runtimes": [integration.policy_runtime(), runtime_identity()],
        "export": {"root": str(export_root), "filenames": ["tissue"]},
        "limits": {
            "cpu_seconds": 60,
            "memory_bytes": tissue.PUMA_MIN_WORKING_BYTES,
            "concurrency": 1,
        },
        "disclosures": sorted(DISCLOSURES),
        "remote_grants": [],
        "experimental_recipes": [],
        "delegation": {
            "id": "d" * 32,
            "client_id": "tissue-fixture",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
        "actions": [
            "tissue_model_profiles",
            "tissue_model_status",
            "tissue_model_preview",
            "tissue_model_run",
            "task_preview_get",
            "correct_result",
            "correction_info",
        ],
    }


def test_profile_discovery_needs_action_but_not_execution_grants(ready, tmp_path, monkeypatch):
    spec = policy_spec(ready, tmp_path)
    spec["runtimes"] = []
    spec["model_packages"] = []
    spec["actions"] = ["tissue_model_profiles"]
    path = tmp_path / "discovery-policy.json"
    write_policy(path, ready.project, spec)
    agent = PolicyAgent(load_policy(path))
    monkeypatch.setattr(
        type(agent.policy), "source_grant", lambda *a: pytest.fail("Discovery read a source")
    )
    monkeypatch.setattr(
        integration.store, "_stream", lambda *a, **k: pytest.fail("Discovery hashed model files")
    )
    monkeypatch.setattr(
        integration.store,
        "resolve_approved_weights",
        lambda *a, **k: pytest.fail("Approved weights"),
    )
    output = inspect_action(agent, ready.wb, "tissue_model_profiles", {})
    item = output["profiles"][0]
    assert item["profile"] == tissue.puma_profile()
    assert item["runtime_policy_identity"] == integration.policy_runtime()
    assert item["store"]["state"] == "missing"
    assert str(tmp_path) not in str(output)
    with pytest.raises(ValueError):
        inspect_action(agent, ready.wb, "tissue_model_profiles", {"weights_path": "/native"})
    with pytest.raises(PermissionError):
        inspect_action(agent, ready.wb, "tissue_model_status", ready.request)


@pytest.mark.parametrize(
    "change", ["action", "context", "runtime", "model", "memory", "stain", "hash", "path"]
)
def test_scope_denials_happen_before_decode_weights_or_job(ready, tmp_path, monkeypatch, change):
    case = ready
    spec, request = policy_spec(case, tmp_path), copy.deepcopy(case.request)
    if change == "action":
        spec["actions"].remove("tissue_model_preview")
    elif change == "context":
        # The output ROI fits but normalization needs the whole image.
        spec["sources"][0]["crop"] = {"x": 2, "y": 1, "width": 5, "height": 4}
    elif change == "runtime":
        spec["runtimes"] = [runtime_identity()]
    elif change == "model":
        spec["model_packages"] = []
    elif change == "memory":
        spec["limits"]["memory_bytes"] //= 2
    elif change == "stain":
        request["declared_stain"] = "inferred"
    elif change == "hash":
        request["source_sha256"] = "f" * 64
    else:
        request["weights_path"] = "/untrusted"
    path = tmp_path / "policy.json"
    write_policy(path, case.project, spec)
    monkeypatch.setattr(
        case.wb, "_session", lambda *a: pytest.fail("Denied request opened decoder")
    )
    monkeypatch.setattr(
        integration.store,
        "resolve_approved_weights",
        lambda *a, **k: pytest.fail("Denied request hashed weights"),
    )
    with pytest.raises((PermissionError, ValueError)):
        authorize_action(
            PolicyAgent(load_policy(path)), case.wb, "tissue_model_preview", request, mode="task"
        )
    assert case.project.list_jobs() == []


def test_retained_context_authority_is_checked_before_any_prediction_pixels(
    ready, tmp_path, monkeypatch
):
    case = ready
    _, _, result = produce(case)
    spec = policy_spec(case, tmp_path)
    spec["sources"][0]["crop"] = {"x": 2, "y": 1, "width": 5, "height": 4}
    path = tmp_path / "policy.json"
    write_policy(path, case.project, spec)
    monkeypatch.setattr(case.project, "load_array", lambda *a: pytest.fail("Denied pixels decoded"))
    with pytest.raises(PermissionError, match="normalization context"):
        authorize_result(load_policy(path), case.wb, result["id"])


def test_full_scope_retained_view_has_authentic_class_metadata(ready, tmp_path):
    case = ready
    _, _, result = produce(case)
    spec = policy_spec(case, tmp_path)
    path = tmp_path / "policy.json"
    write_policy(path, case.project, spec)
    agent = PolicyAgent(load_policy(path))
    viewed = agent.result_view(result["id"], label_field="tissue_classes")
    assert viewed["label_field"] == viewed["field"] == "tissue_classes"
    assert "original" in viewed["basis"]
    retained = agent.result(result["id"])
    assert (
        retained["result"]["tissue_model"]["preview"]
        == result["provenance"]["tissue_model"]["preview"]
    )
    assert retained["provenance"]["runtime"] == result["provenance"]["runtime"]


def test_actual_stdio_status_guide_and_missing_store_task_refusal(ready, tmp_path, monkeypatch):
    case = ready
    spec = policy_spec(case, tmp_path)
    path = tmp_path / "policy.json"
    write_policy(path, case.project, spec)
    # In-process fake inference is intentionally not exported into the child.
    # The child must fail on its missing store before importing Torch/inference.
    model_home = tmp_path / "missing-models"
    monkeypatch.setenv("LOCI_MODEL_HOME", str(model_home))
    parameters = stdio_parameters(path)
    parameters.env = {**(parameters.env or {}), "LOCI_MODEL_HOME": str(model_home)}

    async def exercise(errlog):
        async with (
            stdio_client(parameters, errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, args):
                output = await session.call_tool(name, args)
                assert not output.is_error, output
                return output.structured_content

            guide = await call("action_guide", {"operation": "tissue_model_preview"})
            assert guide["actions"][0]["execution"] == "durable-task"
            assert "declared_stain" in guide["actions"][0]["request_schema"]["required"]
            catalogue = await call(
                "inspect_action", {"operation": "tissue_model_profiles", "request": {}}
            )
            profile = catalogue["profiles"][0]
            assert profile["profile"]["contract_sha256"] == case.request["profile_contract_sha256"]
            assert profile["runtime_policy_identity"] == integration.policy_runtime()
            assert profile["store"]["state"] == "missing"
            denied = await session.call_tool(
                "submit_action",
                {
                    "operation": "tissue_model_preview",
                    "request": {**case.request, "weights_path": "/untrusted"},
                    "request_key": "stdio-denied-path",
                },
            )
            assert denied.is_error
            assert case.project.list_jobs() == []
            status = await call(
                "inspect_action", {"operation": "tissue_model_status", "request": case.request}
            )
            assert status["source_verification"] == "registered-metadata-only"
            assert status["status"]["model_execution_performed"] is False
            arguments = {
                "operation": "tissue_model_preview",
                "request": case.request,
                "request_key": "stdio-no-store",
            }
            submitted = (await call("submit_action", arguments))["job"]
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                job = (await call("job_status", {"job_id": submitted["id"]}))["job"]
                if job["state"] not in {"queued", "running"} and not job["owned_worker_active"]:
                    break
                await asyncio.sleep(0.05)
            assert job["state"] == "failed" and not job["owned_worker_active"]
            assert job["result_ids"] == []
            assert (await call("submit_action", arguments))["job"]["id"] == submitted["id"]

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
    assert case.project.list_results() == []
