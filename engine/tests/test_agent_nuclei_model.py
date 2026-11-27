"""Policy-bound scientific MCP parity for the verified BioImage.IO nuclei ONNX path."""

from __future__ import annotations

import asyncio
import copy
import json
import shutil
import tempfile
from base64 import b64decode
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import tifffile
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from mcp.types import CallToolResult, ImageContent
from test_experiment_intensity import sample
from test_model_packages import _native_package
from test_research_mcp import stdio_parameters

from loci_engine import model_packages
from loci_engine import research_models as rm
from loci_engine.agent_actions import authorize_action, inspect_action
from loci_engine.agent_policy import DISCLOSURES, load_policy, write_policy
from loci_engine.agent_sessions import (
    AgentSessionApprovalError,
    agent_sessions_snapshot,
    capability_map,
    control_agent_session,
    register_policy,
    start_session,
)
from loci_engine.profiles import DEFAULT_PROFILE_ID
from loci_engine.research_action_registry import action_guide
from loci_engine.research_channels import save_channels
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_mcp import JobSupervisor, PolicyAgent, protocol_image_result
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench, runtime_record


def _pixel_scale_package(root: Path) -> tuple[Path, np.ndarray]:
    """Build a synthetic ONNX package whose input/output scale is [1.0, 1.0] pixel."""
    pkg_dir, ref = _native_package(root)
    manifest_path = pkg_dir / "loci-model.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["input"]["scale_yx"] = [1.0, 1.0]
    manifest["input"]["scale_unit"] = "pixel"
    manifest["output"]["scale_yx"] = [1.0, 1.0]
    manifest["output"]["scale_unit"] = "pixel"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return pkg_dir, ref


def _verified_spec_from_package(pkg: model_packages.ModelPackage) -> dict[str, Any]:
    record = pkg.public_record()
    return {
        "schema_version": record["schema_version"],
        "source_format": record["source_format"],
        "id": record["id"],
        "version": record["version"],
        "task": record["task"],
        "package_sha256": record["package_sha256"],
        "metadata_sha256": record["metadata_sha256"],
        "model_sha256": record["model"]["sha256"],
        "opset_version": record["model"]["opset_version"],
        "reference_input_sha256": record["reference"]["input"]["sha256"],
        "reference_output_sha256": record["reference"]["output"]["sha256"],
        "input_axes": record["input"]["axes"],
        "input_dtype": record["input"]["dtype"],
        "input_shape": record["input"]["shape"],
        "input_scale_yx": record["input"]["scale_yx"],
        "input_scale_unit": record["input"]["scale_unit"],
    }


def _fluorescence_crop_source(workbench: Workbench, tmp_path: Path) -> dict[str, Any]:
    """Create a calibrated 2-channel fluorescence image with two distinct bright nuclei."""
    image = np.full((1, 2, 1, 32, 32), 0.02, dtype=np.float32)
    yy, xx = np.ogrid[:32, :32]
    n1 = ((yy - 8) ** 2 + (xx - 8) ** 2) <= 16
    n2 = ((yy - 16) ** 2 + (xx - 18) ** 2) <= 16
    image[0, 0, 0][n1] = np.float32(0.9)
    image[0, 0, 0][n2] = np.float32(0.85)
    image[0, 1, 0][n1] = np.float32(0.45)
    image[0, 1, 0][n2] = np.float32(0.75)
    path = tmp_path / "fluorescence-crop.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.5,
            "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["DNA stain", "Reporter"]},
        },
    )
    return workbench.import_native(str(path), name="Fluorescence field A1")


def _rgb_source(workbench: Workbench, tmp_path: Path) -> dict[str, Any]:
    rgb = np.zeros((16, 16, 3), dtype=np.uint8)
    rgb[4:12, 4:12, 0] = 200
    path = tmp_path / "brightfield-rgb.tif"
    tifffile.imwrite(path, rgb, photometric="rgb")
    return workbench.import_native(str(path), name="Brightfield RGB")


def _inprocess_popen(workbench: Workbench):
    """Run supervised durable jobs synchronously in-process so monkeypatches apply."""

    class _FakeChild:
        pid = 999_999

        def poll(self) -> int:
            return 0

        def terminate(self) -> None:
            pass

    def _spawn(command, **_kwargs):
        job_idx = command.index("--job") + 1
        job_id = command[job_idx]
        policy_idx = command.index("--policy") + 1
        policy_path = command[policy_idx]
        policy = load_policy(policy_path)
        owner = workbench.project.job(job_id).get("owner") or {}
        worker_agent = PolicyAgent(policy, session_id=owner.get("session_id"))
        worker_agent._authorize_job(workbench, job_id)
        run_job(
            workbench,
            job_id,
            publication_guard=worker_agent._recheck_session,
            max_concurrency=policy.concurrency,
        )
        return _FakeChild()

    return _spawn


def _host_runtime_identity() -> dict[str, str]:
    host = runtime_record()
    return {
        k: host[k]
        for k in ("engine", "numpy", "scipy", "scikit_image", "backend", "resolved_device")
    }


def _preview_request(model_id: str, source_id: str) -> dict[str, Any]:
    return {
        "model_id": model_id,
        "source_id": source_id,
        "selection": {
            "x": 0,
            "y": 0,
            "width": 26,
            "height": 24,
            "t": 0,
            "z": 0,
            "level": 0,
        },
        "channel_mapping": [
            {
                "model_input_index": 0,
                "model_channel": "input-0",
                "source_channel": 0,
            }
        ],
        "scale": {
            "mode": "override",
            "scale_yx": [1.0, 1.0],
            "scale_unit": "pixel",
            "declaration": (
                "Pixel-grid BioImage.IO nuclei ONNX evaluated at native 0.5 um/px sampling "
                "without resampling; physical source calibration retained for measurements."
            ),
        },
        "postprocessing": {
            "probability_channel": 0,
            "threshold": 0.5,
            "method": "components",
            "min_size": 2,
            "exclude_border": False,
        },
        "measurement_channels": [0, 1],
        "display": {
            "source_channel": 0,
            "low": 0.0,
            "high": 1.0,
            "gamma": 1.0,
            "color": "#ffffff",
        },
        "working_bytes": 256 * 1024**2,
    }


def _policy_spec(
    source: dict[str, Any],
    export_root: Path,
    *,
    model_packages_grant: list[dict[str, str]],
    runtimes_grant: list[dict[str, str]],
    permission_mode: str = "full_access",
) -> dict[str, Any]:
    return {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {"x": 0, "y": 0, "width": 26, "height": 24},
                "t": [0],
                "c": [0],
                "z": [0],
                "level": [0],
                "measurement_channels": [0, 1],
            }
        ],
        "recipes": [],
        "operations": [
            "analysis_context",
            "inspect_source",
            "validate_action",
            "inspect_action",
            "submit_action",
            "job_status",
            "cancel_job",
            "study_results",
            "result",
            "result_view",
            "review_history",
            "review_result",
            "export_result",
        ],
        "model_packages": model_packages_grant,
        "runtimes": runtimes_grant,
        "export": {
            "root": str(export_root),
            "filename_mode": "directory",
            "filenames": [],
        },
        "limits": {
            "cpu_seconds": 120,
            "memory_bytes": 512 * 1024**2,
            "concurrency": 1,
        },
        "disclosures": sorted(DISCLOSURES),
        "remote_grants": [],
        "experimental_recipes": [],
        "delegation": {
            "id": "a" * 32,
            "client_id": "nuclei-parity-qa",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
        "actions": [
            "model_list",
            "model_preview",
            "model_run",
            "task_preview_get",
            "classical_run",
            "describe_result",
            "study_summary",
            "annotation_evaluation_run",
            "correction_info",
            "correct_result",
        ],
        "permission_mode": permission_mode,
    }


def test_verified_nuclei_package_constants_match_shipped_manifest():
    manifest_path = (
        Path(__file__).resolve().parents[2]
        / "desktop"
        / "src"
        / "main"
        / "nuclei-model-package.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    spec = rm.VERIFIED_NUCLEI_MODEL_PACKAGE
    assert spec["id"] == manifest["id"] == "nuclei-segmentation-boundary-model"
    assert spec["version"] == manifest["version"] == "0.1.0-publication-20261015-r2"
    assert spec["task"] == manifest["task"] == "semantic-segmentation"
    assert spec["model_sha256"] == manifest["model"]["sha256"]
    assert spec["opset_version"] == manifest["model"]["opset_version"] == 12
    assert spec["reference_input_sha256"] == manifest["reference"]["input"]["sha256"]
    assert spec["reference_output_sha256"] == manifest["reference"]["output"]["sha256"]
    assert spec["input_axes"] == manifest["input"]["axes"] == "BCYX"
    assert spec["input_shape"] == manifest["input"]["shape"] == [1, 1, 256, 256]
    assert spec["input_scale_yx"] == manifest["input"]["scale_yx"] == [1.0, 1.0]
    assert spec["input_scale_unit"] == manifest["input"]["scale_unit"] == "pixel"
    assert len(rm.NUCLEI_MODEL_ID) == 32
    rt = rm.onnx_policy_runtime()
    assert set(rt) == {"engine", "numpy", "scipy", "scikit_image", "backend", "resolved_device"}
    assert rt["backend"].startswith("onnxruntime-cpu:")
    assert rt["resolved_device"] == "cpu"


def test_model_list_discovers_only_ready_verified_models_without_private_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Discovery study"))
    source = _fluorescence_crop_source(wb, tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()

    spec = _policy_spec(source, export_root, model_packages_grant=[], runtimes_grant=[])
    spec["actions"] = ["model_list"]
    policy_path = tmp_path / "discovery-policy.json"
    write_policy(policy_path, wb.project, spec)
    agent = PolicyAgent(load_policy(policy_path))

    assert inspect_action(agent, wb, "model_list", {}) == {"models": []}
    assert rm.agent_policy_model_grants(wb) == {"model_packages": [], "runtimes": []}

    pkg_dir, _ = _pixel_scale_package(tmp_path / "pkg")
    imported = rm.import_model(wb, pkg_dir, working_bytes=256 * 1024**2)

    # Unverified custom model is visible to human desktop RPC, but omitted from agent discovery.
    assert len(rm.execute_model(wb, "model_list", {})["models"]) == 1
    assert inspect_action(agent, wb, "model_list", {}) == {"models": []}
    assert rm.agent_policy_model_grants(wb) == {"model_packages": [], "runtimes": []}

    inspected_pkg = model_packages.inspect_model_package(pkg_dir)
    monkeypatch.setattr(
        rm, "VERIFIED_AGENT_MODEL_PACKAGES", (_verified_spec_from_package(inspected_pkg),)
    )
    discovered = inspect_action(agent, wb, "model_list", {})
    assert len(discovered["models"]) == 1
    entry = discovered["models"][0]
    assert entry["model_id"] == imported["model_id"]
    assert entry["availability"]["state"] == "ready"
    assert entry["agent_execution"] == {
        "model_package_granted": False,
        "runtime_granted": False,
        "runtime_policy_identity": rm.onnx_policy_runtime(),
        "adoption_requires_human_visual_review": True,
    }
    serialized = json.dumps(discovered)
    assert "private_path" not in serialized
    assert str(tmp_path) not in serialized

    grants = rm.agent_policy_model_grants(wb)
    assert grants == {
        "model_packages": [{"id": inspected_pkg.id, "sha256": inspected_pkg.package_sha256}],
        "runtimes": [rm.onnx_policy_runtime()],
    }

    with pytest.raises(ValueError):
        inspect_action(agent, wb, "model_list", {"private_path": "/etc/passwd"})

    # Transition model to reimport-required: no longer ready, so omitted from ready discovery.
    doc = wb.project.documents("model", document_id=imported["model_id"])[0]
    private_dir = Path(doc["data"]["private_path"])
    portable = {k: v for k, v in doc["data"].items() if k != "private_path"}
    portable.update(
        interchange_state="model-package-not-included",
        recovery="reimport-the-exact-declared-package-before-use",
    )
    wb.project.put_document("model", doc["id"], portable, expected_revision=doc["revision"])
    shutil.rmtree(private_dir)
    assert inspect_action(agent, wb, "model_list", {}) == {"models": []}
    assert rm.agent_policy_model_grants(wb) == {"model_packages": [], "runtimes": []}


@pytest.mark.parametrize(
    "case_name",
    [
        "missing_action",
        "unverified_model",
        "unpinned_model",
        "missing_onnx_runtime",
        "crop_outside_grant",
        "hidden_input_channel",
        "hidden_display_channel",
        "ungranted_measurement_channel",
        "memory_exceeds_policy",
        "rgb_source",
        "undeclared_path_field",
    ],
)
def test_model_preview_denials_fail_closed_before_pixel_decode_or_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case_name: str
):
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Scope study"))
    source = _fluorescence_crop_source(wb, tmp_path)
    rgb = _rgb_source(wb, tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()

    pkg_dir, _ = _pixel_scale_package(tmp_path / "pkg")
    imported = rm.import_model(wb, pkg_dir, working_bytes=256 * 1024**2)
    inspected_pkg = model_packages.inspect_model_package(pkg_dir)
    if case_name != "unverified_model":
        monkeypatch.setattr(
            rm, "VERIFIED_AGENT_MODEL_PACKAGES", (_verified_spec_from_package(inspected_pkg),)
        )

    grants = rm.agent_policy_model_grants(wb)
    spec = _policy_spec(
        source,
        export_root,
        model_packages_grant=(
            [{"id": inspected_pkg.id, "sha256": inspected_pkg.package_sha256}]
            if case_name != "unpinned_model"
            else []
        ),
        runtimes_grant=(
            [_host_runtime_identity()]
            if case_name == "missing_onnx_runtime"
            else [_host_runtime_identity(), rm.onnx_policy_runtime()]
        ),
    )
    if case_name == "rgb_source":
        spec["sources"].append(
            {
                "id": rgb["id"],
                "sha256": rgb["sha256"],
                "crop": {"x": 0, "y": 0, "width": 16, "height": 16},
                "t": [0],
                "c": [0, 1, 2],
                "z": [0],
                "level": [0],
                "measurement_channels": [0],
            }
        )
    if case_name == "missing_action":
        spec["actions"].remove("model_preview")
    if case_name == "ungranted_measurement_channel":
        spec["sources"][0]["measurement_channels"] = [0]

    request = _preview_request(imported["model_id"], source["id"])
    if case_name == "crop_outside_grant":
        request["selection"]["width"] = 30
    elif case_name == "hidden_input_channel":
        request["channel_mapping"][0]["source_channel"] = 1
    elif case_name == "hidden_display_channel":
        request["display"]["source_channel"] = 1
    elif case_name == "memory_exceeds_policy":
        request["working_bytes"] = 1024 * 1024**2
    elif case_name == "rgb_source":
        request["source_id"] = rgb["id"]
        request["selection"]["width"] = 16
        request["selection"]["height"] = 16
        request["measurement_channels"] = [0]
    elif case_name == "undeclared_path_field":
        request["private_path"] = str(pkg_dir)
    else:
        assert grants or case_name == "unverified_model"

    policy_path = tmp_path / "policy.json"
    write_policy(policy_path, wb.project, spec)
    monkeypatch.setattr(wb, "_session", lambda *a: pytest.fail("Denied request decoded pixels"))
    with pytest.raises((PermissionError, ValueError)):
        authorize_action(
            PolicyAgent(load_policy(policy_path)), wb, "model_preview", request, mode="task"
        )
    assert wb.project.list_jobs() == []


def test_end_to_end_watershed_comparison_and_forced_researcher_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Nuclei vs watershed study"))
    source = _fluorescence_crop_source(wb, tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()

    pkg_dir, _ = _pixel_scale_package(tmp_path / "pkg")
    imported = rm.import_model(wb, pkg_dir, working_bytes=256 * 1024**2)
    inspected_pkg = model_packages.inspect_model_package(pkg_dir)
    monkeypatch.setattr(
        rm, "VERIFIED_AGENT_MODEL_PACKAGES", (_verified_spec_from_package(inspected_pkg),)
    )

    grants = rm.agent_policy_model_grants(wb)
    spec = _policy_spec(
        source,
        export_root,
        model_packages_grant=grants["model_packages"],
        runtimes_grant=[_host_runtime_identity(), *grants["runtimes"]],
        permission_mode="full_access",
    )
    policy_path = tmp_path / "policy.json"
    write_policy(policy_path, wb.project, spec)
    policy = load_policy(policy_path)
    register_policy(wb.project, policy, permission_mode="full_access", bundle_name="Nuclei parity")
    session = start_session(wb.project, policy, client_id="parity-client")
    supervisor = JobSupervisor(policy, popen=_inprocess_popen(wb))
    agent = PolicyAgent(
        policy,
        supervisor=supervisor,
        session_id=session["session_id"],
        approval_wait_seconds=0.05,
    )
    supervisor.vision = lambda w, req, op: (
        inspect_action(agent, w, req["operation"], req["request"])
        if op == "inspect_action"
        else agent._study_results(w, req)
    )

    def submit_done(op: str, req: dict[str, Any], key: str) -> dict[str, Any]:
        queued = agent.submit_action(op, req, key)["job"]
        return agent.job_status(queued["id"])["job"]

    # 1. Classical adaptive watershed on the exact same registered fluorescence crop
    #    executes immediately in Full access mode.
    watershed_req = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 26,
            "height": 24,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "profile_id": DEFAULT_PROFILE_ID,
        "settings": {
            "image_mode": "fluorescence",
            "polarity": "bright",
            "expected_diameter_px": 8.0,
            "min_area_px": 4,
            "sensitivity": 0.0,
            "smoothing_px": 1.0,
            "split_touching": True,
            "exclude_border": False,
        },
        "measurement_channels": [0, 1],
        "working_bytes": 256 * 1024**2,
    }
    ws_job = submit_done("classical_run", watershed_req, "ws-crop-1")
    assert ws_job["state"] == "succeeded"
    ws_result_id = ws_job["result_ids"][0]

    # 2. Bounded model_preview on the exact same crop executes in Full access mode
    #    without adopting a result, and delivers a verified MCP PNG via task_preview_get.
    preview_req = _preview_request(imported["model_id"], source["id"])
    assert agent.validate_action("model_preview", preview_req)["authorized"] is True
    prev_job = submit_done("model_preview", preview_req, "nuclei-prev-1")
    assert prev_job["state"] == "succeeded"
    assert prev_job["result_ids"] == []
    assert [r["id"] for r in wb.project.list_results()] == [ws_result_id]

    raw_preview = agent.inspect_action("task_preview_get", {"job_id": prev_job["id"]})
    mcp_preview = protocol_image_result(
        copy.deepcopy(raw_preview), required=False, retained_preview=True
    )
    assert isinstance(mcp_preview, CallToolResult)
    img_blocks = [item for item in mcp_preview.content if isinstance(item, ImageContent)]
    assert len(img_blocks) == 1
    assert b64decode(img_blocks[0].data).startswith(b"\x89PNG\r\n\x1a\n")
    assert mcp_preview.structured_content["image_transport"]["images"][0]["json_pointer"] == (
        "/preview/output/overlay_png"
    )
    assert "overlay_png" not in mcp_preview.structured_content["preview"]["output"]
    assert str(tmp_path) not in json.dumps(mcp_preview.structured_content)

    preview_doc = raw_preview["preview"]["output"]["preview"]
    token = {"preview_id": preview_doc["id"], "preview_sha256": preview_doc["preview_sha256"]}

    # 3. Even in Full access mode, model_run MUST pause for a real human approval.
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.submit_action("model_run", token, "nuclei-adopt-stale")
    snap = agent_sessions_snapshot(wb.project)
    pending = [a for a in snap["approvals"] if a["state"] == "pending"]
    assert len(pending) == 1
    app = pending[0]
    assert app["explicit_approval_required"] is True
    assert app["action_name"] == "model_run"
    assert app["source_id"] == source["id"]
    assert app["source_sha256"] == source["sha256"]
    assert app["parameters_summary"]["preview_id"] == token["preview_id"]
    assert app["parameters_summary"]["preview_sha256"] == token["preview_sha256"]
    assert app["parameters_summary"]["preview_job_id"] == prev_job["id"]
    assert app["parameters_summary"]["png_sha256"] == preview_doc["source"]["display"]["png_sha256"]
    assert app["parameters_summary"]["review_requirement"] == "visual-preview-inspection-required"

    # Re-switching mode to full_access, recording an agent review_result, or calling
    # approve_request WITHOUT inspected_preview NEVER satisfies visual review!
    control_agent_session(
        wb,
        {
            "action": "set_permission_mode",
            "policy_sha256": policy.content_sha256,
            "permission_mode": "full_access",
        },
    )
    ws_record = agent.result(ws_result_id)["result"]
    agent.review_result(
        {
            "result_id": ws_result_id,
            "revision_hash": ws_record["revision_hash"],
            "disposition": "reviewed",
            "reason": "Agent watershed baseline check",
            "coverage": "26x24 crop",
            "expected_review_sha256": None,
        }
    )
    with pytest.raises(ValueError, match="inspected_preview"):
        control_agent_session(
            wb,
            {
                "action": "approve_request",
                "approval_id": app["id"],
                "reason": "Blind approve without preview confirmation",
            },
        )
    still_pending = [
        a for a in agent_sessions_snapshot(wb.project)["approvals"] if a["id"] == app["id"]
    ][0]
    assert still_pending["state"] == "pending"
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.submit_action("model_run", token, "nuclei-adopt-stale")

    # Worker defense-in-depth: an unapproved owned model_run job cannot authorize in worker.
    bypass_job = submit_job(
        wb, token, "unapproved-worker-bypass", "model_run", owner=agent.job_owner
    )
    with pytest.raises(PermissionError, match="single-use researcher approval"):
        agent._authorize_job(wb, bypass_job["id"])

    # 4. Stale channel declarations invalidate the pending model_run approval fail-closed.
    original_channels = wb.channel_metadata(source["id"])["channels"]
    save_channels(
        wb.project,
        {
            "source_id": source["id"],
            "channels": [
                {**original_channels[0], "name": "Changed DNA label"},
                original_channels[1],
            ],
            "expected_revision": wb.channel_metadata(source["id"])["revision"],
        },
    )
    stale_check = [
        a for a in agent_sessions_snapshot(wb.project)["approvals"] if a["id"] == app["id"]
    ][0]
    assert stale_check["state"] == "stale"

    # Fresh preview after channel declaration update -> human visual review -> approve_request.
    prev_job_2 = submit_done("model_preview", preview_req, "nuclei-prev-2")
    preview_doc_2 = agent.inspect_action("task_preview_get", {"job_id": prev_job_2["id"]})[
        "preview"
    ]["output"]["preview"]
    token_2 = {
        "preview_id": preview_doc_2["id"],
        "preview_sha256": preview_doc_2["preview_sha256"],
    }
    with pytest.raises(AgentSessionApprovalError, match="requires human approval"):
        agent.submit_action("model_run", token_2, "nuclei-adopt-live")
    live_pending = [
        a for a in agent_sessions_snapshot(wb.project)["approvals"] if a["state"] == "pending"
    ]
    assert len(live_pending) == 1
    with pytest.raises(ValueError, match="Inspected preview job does not match"):
        control_agent_session(
            wb,
            {
                "action": "approve_request",
                "approval_id": live_pending[0]["id"],
                "inspected_preview": {**token_2, "preview_job_id": prev_job["id"]},
            },
        )
    with monkeypatch.context() as scoped:
        scoped.setattr(rm, "runtime_status", lambda: {"ready": False})
        with pytest.raises(PermissionError, match="ONNX CPU runtime is unavailable"):
            control_agent_session(
                wb,
                {
                    "action": "approve_request",
                    "approval_id": live_pending[0]["id"],
                    "inspected_preview": {**token_2, "preview_job_id": prev_job_2["id"]},
                },
            )
    control_agent_session(
        wb,
        {
            "action": "approve_request",
            "approval_id": live_pending[0]["id"],
            "reason": "Visually inspected nuclei overlay on Display stage",
            "inspected_preview": {
                "preview_id": token_2["preview_id"],
                "preview_sha256": token_2["preview_sha256"],
                "preview_job_id": prev_job_2["id"],
            },
        },
    )

    with monkeypatch.context() as scoped:

        def interrupted_start(*args, **kwargs):
            raise RuntimeError("Interrupted before durable job creation")

        scoped.setattr(supervisor, "start", interrupted_start)
        with pytest.raises(RuntimeError, match="Interrupted before durable job creation"):
            agent.submit_action("model_run", token_2, "nuclei-adopt-live")

    adopt_job = submit_done("model_run", token_2, "nuclei-adopt-live")
    assert adopt_job["state"] == "succeeded"
    model_result_id = adopt_job["result_ids"][0]

    # Idempotent retry with same request_key returns the same job without re-prompting,
    # whereas a new request_key on the already-adopted preview is rejected cleanly.
    assert (
        agent.submit_action("model_run", token_2, "nuclei-adopt-live")["job"]["id"]
        == adopt_job["id"]
    )
    with pytest.raises(ValueError, match="already been adopted"):
        agent.submit_action("model_run", token_2, "nuclei-adopt-duplicate")

    # 5. Bit-exact numerical parity against native execute_model on the same crop,
    #    including canonical selection with scalar channel c=0 for agreement alignment.
    native_prev = rm.execute_model(wb, "model_preview", preview_req)["preview"]
    native_run = rm.execute_model(
        wb,
        "model_run",
        {"preview_id": native_prev["id"], "preview_sha256": native_prev["preview_sha256"]},
    )
    agent_rec = wb.project.result(model_result_id)
    native_rec = wb.project.result(native_run["result"]["id"])
    assert agent_rec["provenance"]["selection"] == watershed_req["selection"]
    assert (
        agent_rec["arrays"]["probabilities"]["sha256"]
        == (native_rec["arrays"]["probabilities"]["sha256"])
    )
    assert agent_rec["arrays"]["labels"]["sha256"] == native_rec["arrays"]["labels"]["sha256"]
    assert agent_rec["provenance"]["measurements"] == native_rec["provenance"]["measurements"]
    assert agent_rec["provenance"]["geometry"]["unit"] == "um"
    assert (
        agent_rec["provenance"]["source_scale"]["scientific_output_geometry"]
        == "registered-source-geometry-unchanged"
    )

    # 6. Downstream shared governance: study_results, describe_result, study_summary,
    #    direct two-prediction annotation_evaluation_run vs classical watershed baseline,
    #    review, and atomic reviewed export.
    listed_ids = [item["id"] for item in agent.study_results(source["id"])["results"]]
    assert ws_result_id in listed_ids and model_result_id in listed_ids
    desc = agent.inspect_action(
        "describe_result",
        {"result_id": model_result_id, "revision_hash": agent_rec["revision_hash"]},
    )
    assert desc["method_label"] == "Model segmentation"
    assert str(tmp_path) not in json.dumps(desc)

    sample(wb.project, agent_rec)
    wb.project.review(model_result_id, agent_rec["revision_hash"], "reviewed")
    for result_id in (ws_result_id, model_result_id):
        summary = agent.inspect_action("study_summary", {"result_ids": [result_id]})
        assert [row["result_id"] for row in summary["record_audit"]] == [result_id]
    with pytest.raises(ValueError, match="Duplicate source_id cannot be pooled"):
        agent.inspect_action("study_summary", {"result_ids": [ws_result_id, model_result_id]})

    eval_job = submit_done(
        "annotation_evaluation_run",
        {
            "result_id": model_result_id,
            "revision_hash": agent_rec["revision_hash"],
            "reference": {
                "result_id": ws_result_id,
                "revision_hash": ws_record["revision_hash"],
            },
            "semantics": "instances",
            "iou_thresholds": [0.5],
            "reference_declaration": (
                "Classical adaptive watershed prediction on the same registered fluorescence crop"
            ),
            "working_bytes": 128 * 1024**2,
        },
        "compare-model-vs-ws",
    )
    assert eval_job["state"] == "succeeded"

    # The agent exports the exact previously reviewed revision.
    exported = agent.export_result(model_result_id, agent_rec["revision_hash"], "nuclei-reviewed")
    assert exported["export_name"] == "nuclei-reviewed"
    bundle = export_root / "nuclei-reviewed"
    assert (bundle / "manifest.json").is_file()
    probabilities = np.load(bundle / "probabilities.npy", allow_pickle=False)
    assert probabilities.shape == (1, 24, 26)
    np.testing.assert_array_equal(
        tifffile.imread(bundle / "probabilities.ome.tif"), probabilities[0]
    )

    # Narrower policy without model_packages fails closed on retained model result inspection.
    narrow_spec = copy.deepcopy(spec)
    narrow_spec["model_packages"] = []
    narrow_path = tmp_path / "narrow-policy.json"
    write_policy(narrow_path, wb.project, narrow_spec)
    narrow_agent = PolicyAgent(load_policy(narrow_path))
    with pytest.raises(PermissionError, match="model identity"):
        narrow_agent.result(model_result_id)
    with pytest.raises(PermissionError, match="model identity"):
        inspect_action(
            narrow_agent, wb, "study_summary", {"result_ids": [ws_result_id, model_result_id]}
        )


def test_unadopted_model_preview_cap_preserves_adopted_and_pending_previews(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(rm, "MAX_UNADOPTED_MODEL_PREVIEWS", 3)
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Preview cap study"))
    source = _fluorescence_crop_source(wb, tmp_path)
    pkg_dir, _ = _pixel_scale_package(tmp_path / "pkg")
    imported = rm.import_model(wb, pkg_dir, working_bytes=256 * 1024**2)
    req = _preview_request(imported["model_id"], source["id"])

    first = rm.execute_model(wb, "model_preview", req)["preview"]
    rm.execute_model(
        wb,
        "model_run",
        {"preview_id": first["id"], "preview_sha256": first["preview_sha256"]},
    )
    unadopted_ids = [rm.execute_model(wb, "model_preview", req)["preview"]["id"] for _ in range(5)]
    stored_ids = [doc["id"] for doc in wb.project.documents("model_preview")]
    assert first["id"] in stored_ids
    assert stored_ids == [first["id"], *unadopted_ids[-3:]]


def test_actual_mcp_stdio_guide_discovery_and_unverified_model_refusal(tmp_path: Path):
    wb = Workbench(ResearchProject.create(tmp_path / "study", "MCP stdio study"))
    source = _fluorescence_crop_source(wb, tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()

    pkg_dir, _ = _pixel_scale_package(tmp_path / "pkg")
    imported = rm.import_model(wb, pkg_dir, working_bytes=256 * 1024**2)
    inspected_pkg = model_packages.inspect_model_package(pkg_dir)

    spec = _policy_spec(
        source,
        export_root,
        model_packages_grant=[
            {"id": rm.NUCLEI_MODEL_PACKAGE_ID, "sha256": rm.NUCLEI_MODEL_PACKAGE_SHA256},
            {"id": inspected_pkg.id, "sha256": inspected_pkg.package_sha256},
        ],
        runtimes_grant=[_host_runtime_identity(), rm.onnx_policy_runtime()],
        permission_mode="full_access",
    )
    policy_path = tmp_path / "stdio-policy.json"
    write_policy(policy_path, wb.project, spec)
    parameters = stdio_parameters(policy_path)

    cap = capability_map()
    by_op = {entry["operation"]: entry for entry in cap["entries"]}
    assert by_op["model_list"]["status"] == "supported_with_grant"
    assert by_op["model_preview"]["status"] == "supported_with_grant"
    assert by_op["model_run"]["status"] == "supported_with_grant"
    assert "Full access" in by_op["model_run"]["grant_requirement"]
    assert by_op["cellpose_run"]["status"] == "gui_only_gap"
    guide = {item["operation"]: item for item in action_guide()["actions"]}
    assert guide["model_preview"]["side_effects"] == "saved-model-preview-receipt"
    assert "single-use-human-visual-review-approval" in guide["model_run"]["permissions"]

    async def exercise(errlog):
        async with (
            stdio_client(parameters, errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            guide_out = await session.call_tool("action_guide", {"operation": "model_run"})
            assert not guide_out.is_error
            assert (
                guide_out.structured_content["actions"][0]["execution_kind"] == "publication-task"
            )

            listed = await session.call_tool(
                "inspect_action", {"operation": "model_list", "request": {}}
            )
            assert not listed.is_error
            assert listed.structured_content == {"models": []}
            assert str(tmp_path) not in json.dumps(listed.structured_content)

            denied = await session.call_tool(
                "submit_action",
                {
                    "operation": "model_preview",
                    "request": _preview_request(imported["model_id"], source["id"]),
                    "request_key": "stdio-unverified-model",
                },
            )
            assert denied.is_error
            assert str(tmp_path) not in str(denied.content)
            assert wb.project.list_jobs() == []

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
