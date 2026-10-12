"""Synthetic-only v3 policy, display, child and MCP image regression coverage."""

import asyncio
import copy
import json
import os
import subprocess
import sys
import time

import numpy as np
import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_policy import make_study, specification
from test_research_mcp import stdio_parameters

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.agent_vision import render_source_image, validate_png
from loci_engine.research_mcp import PolicyAgent
from loci_engine.source_view_state import _default_view_state_for_source
from loci_engine.workbench import Workbench


def channel(index=0, **updates):
    return {
        "channel": index,
        "low": 0,
        "high": 100,
        "gamma": 1,
        "color": "#ffffff",
        "opacity": 1,
        "visible": True,
        **updates,
    }


def make_v3(tmp_path, *, templates=True, disclosures=None):
    workbench, source, request = make_study(tmp_path)
    root = tmp_path / "exports"
    root.mkdir()
    request["recipe"]["segmentation"]["min_size"] = 0
    spec = specification(
        workbench,
        source,
        request,
        root,
        recipes=False,
        disclosures=(
            ["previews", "geometry", "provenance", "agent_metadata", "measurements"]
            if disclosures is None
            else disclosures
        ),
    )
    spec["operations"] += [
        "analysis_context",
        "source_image",
        "source_display",
        "set_source_display",
        "export_vision_handoff",
    ]
    spec["export"]["filenames"].append("approved.loci-vision")
    spec["remote_grants"] = []
    spec["experimental_recipes"] = (
        [
            {
                "key": "threshold-sweep",
                "source_id": source["id"],
                "selection": request["selection"],
                "recipe": request["recipe"],
                "parameters": {
                    "threshold": {"min": 40, "max": 90},
                    "min_size": {"min": 0, "max": 200},
                },
                "preview": True,
                "run": True,
            }
        ]
        if templates
        else []
    )
    path = tmp_path / "v3.json"
    write_policy(path, workbench.project, spec)
    image_request = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 16,
            "height": 16,
            "t": 0,
            "c": 0,
            "z": 1,
            "level": 0,
        },
        "channels": [channel()],
        "projection": "plane",
        "max_size": 64,
    }
    return PolicyAgent(load_policy(path)), workbench, source, request, image_request, path, spec


def test_v3_normalizes_template_and_preserves_legacy_exact_grant_independently(tmp_path):
    agent, wb, _, request, _, path, spec = make_v3(tmp_path)
    template = agent.analysis_context()["experimental_recipes"][0]
    assert template["selection"] == wb.validate_recipe(request)["selection"]
    assert template["recipe"] == wb.validate_recipe(request)["recipe"]
    changed = copy.deepcopy(request)
    changed["recipe"]["segmentation"]["threshold"] = 75
    assert agent.validate_recipe(changed)["approved"] == {"preview": True, "run": True}
    assert agent.validate_recipe(changed)["experimental_templates"] == ["threshold-sweep"]
    agent._validate(wb, changed, "preview")
    changed["recipe"]["segmentation"]["threshold"] = 99
    assert agent.validate_recipe(changed)["approved"] == {"preview": False, "run": False}
    with pytest.raises(PermissionError):
        agent._validate(wb, changed, "run")
    digest = wb.validate_recipe(changed)["recipe_sha256"]
    spec["recipes"] = [{"sha256": digest, "preview": False, "run": True}]
    write_policy(path, wb.project, spec)
    replacement = PolicyAgent(load_policy(path))
    replacement._validate(wb, changed, "run")
    with pytest.raises(PermissionError):
        replacement._validate(wb, changed, "preview")


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r["recipe"]["segmentation"].update(threshold=True),
        lambda r: r["recipe"]["segmentation"].update(threshold=float("nan")),
        lambda r: r["recipe"]["segmentation"].update(threshold=91),
        lambda r: r["recipe"]["segmentation"].update(min_size=-1),
        lambda r: r["recipe"]["segmentation"].update(method="watershed"),
        lambda r: r["recipe"].update(steps=[{"op": "gaussian", "sigma": 1}]),
        lambda r: r["recipe"].update(working_bytes=64 * 1024**2),
        lambda r: r["recipe"].update(
            gates=[{"name": "changed", "channel": "x", "statistic": "mean", "threshold": 1}]
        ),
        lambda r: r["recipe"].update(references={"flatfield": {"source_id": "0" * 32}}),
        lambda r: r["selection"].update(width=16),
        lambda r: r["selection"].update(t=1),
        lambda r: r.update(extra=True),
    ],
)
def test_experiments_reject_range_and_every_frozen_field_drift(tmp_path, mutation):
    agent, wb, _, request, _, _, _ = make_v3(tmp_path)
    mutation(request)
    with pytest.raises((PermissionError, ValueError)):
        agent._validate(wb, request, "run")


@pytest.mark.parametrize(
    "mutation",
    [
        lambda t: t.update(extra=1),
        lambda t: t.update(preview=1),
        lambda t: t.update(parameters={}),
        lambda t: t.update(parameters={"method": {"min": 0, "max": 1}}),
        lambda t: t["parameters"]["threshold"].update(extra=0),
        lambda t: t["parameters"]["threshold"].update(min=True),
        lambda t: t["parameters"]["threshold"].update(max=float("inf")),
        lambda t: t["parameters"]["threshold"].update(min=80, max=70),
        lambda t: t["parameters"]["min_size"].update(min=-1),
        lambda t: t["selection"].update(x=1, width=32),
    ],
)
def test_human_writer_rejects_invalid_experimental_grants(tmp_path, mutation):
    _, wb, _, _, _, path, spec = make_v3(tmp_path)
    mutation(spec["experimental_recipes"][0])
    with pytest.raises((ValueError, PermissionError)):
        write_policy(path, wb.project, spec)


def test_templates_require_all_disclosures_and_no_schema_downgrade(tmp_path):
    _, wb, _, _, _, path, spec = make_v3(tmp_path)
    for disclosure in ("geometry", "provenance", "agent_metadata"):
        bad = copy.deepcopy(spec)
        bad["disclosures"].remove(disclosure)
        with pytest.raises(PermissionError):
            write_policy(path, wb.project, bad)
    document = json.loads(path.read_text())
    document["schema"] = "loci.agent-policy/v2"
    path.write_text(json.dumps(document))
    os.chmod(path, 0o600)
    with pytest.raises(ValueError):
        load_policy(path)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r["selection"].update(x=31, width=2),
        lambda r: r["selection"].update(t=1),
        lambda r: r["selection"].update(c=1),
        lambda r: r["selection"].update(z=4),
        lambda r: r["selection"].update(level=1),
        lambda r: r["selection"].pop("x"),
        lambda r: r["channels"].append(channel(1, visible=False)),
        lambda r: r["channels"][0].update(low=float("nan")),
        lambda r: r["channels"][0].update(visible=1),
        lambda r: r.update(max_size=True),
        lambda r: r.update(max_size=2049),
        lambda r: r.update(extra=1),
        lambda r: r.update(projection="max"),
    ],
)
def test_source_image_rejects_scope_before_first_pixel_decode(tmp_path, mutation, monkeypatch):
    agent, _, _, _, request, _, _ = make_v3(tmp_path, templates=False)
    mutation(request)
    monkeypatch.setattr(
        Workbench, "view", lambda *a, **k: pytest.fail("decoded unauthorized source")
    )
    with pytest.raises((ValueError, PermissionError)):
        agent.source_image(request)


def test_source_image_checks_every_z_and_memory_before_decode(tmp_path, monkeypatch):
    agent, _, _, _, request, path, spec = make_v3(tmp_path, templates=False)
    spec["sources"][0]["z"] = [0, 1, 3]
    write_policy(path, agent.policy.project_path, spec)
    agent = PolicyAgent(load_policy(path))
    request["selection"].update(z=0, z_stop=4)
    request["projection"] = "mean"
    monkeypatch.setattr(
        Workbench, "view", lambda *a, **k: pytest.fail("decoded unauthorized source")
    )
    with pytest.raises(PermissionError):
        agent.source_image(request)
    from loci_engine.agent_vision import validate_source_image

    wb = agent._workbench("source_image")
    with pytest.raises(PermissionError):
        validate_source_image(wb, request, working_bytes=1024)
    wb.close()


@pytest.mark.parametrize(
    "disclosures",
    [
        ["previews"],
        ["previews", "geometry"],
        ["previews", "provenance"],
        ["previews", "agent_metadata"],
        ["previews", "source_names"],
    ],
)
def test_image_response_independently_filters_disclosures(tmp_path, disclosures):
    agent, _, _, _, request, _, _ = make_v3(tmp_path, templates=False, disclosures=disclosures)
    frame = agent.source_image(request)
    validate_png(frame["image"])
    assert ("geometry" in frame) == ("geometry" in disclosures)
    assert ("rendering" in frame) == ("provenance" in disclosures)
    assert ("source_sha256" in frame) == ("agent_metadata" in disclosures)
    assert ("source_name" in frame) == ("source_names" in disclosures)
    if "rendering" in frame:
        assert not {"geometry", "selection", "output_size"} & frame["rendering"].keys()
    assert str(tmp_path) not in json.dumps(frame)


def test_display_patch_preserves_crop_camera_other_channel_and_analysis_values(tmp_path):
    agent, wb, source, request, image_request, _, _ = make_v3(tmp_path)
    state = _default_view_state_for_source(source)
    state["selection"] = {
        "x": 4,
        "y": 4,
        "width": 16,
        "height": 16,
        "z": 1,
        "t": 0,
        "c": 1,
        "level": 0,
    }
    state["camera"] = {"x": 12, "y": 12, "scale": 2}
    state["interpretation"] = "generic"
    wb.execute(
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "state": state,
        },
    )
    raw_before = wb.load_scalar(source["id"], image_request["selection"])[0].copy()
    preview_before = wb.run_recipe(request, preview=True)
    display = agent.source_display(source["id"])
    assert [c["channel"] for c in display["channels"]] == [0]
    assert "selection" not in display and "camera" not in display
    changed = agent.set_source_display(
        source["id"],
        source["sha256"],
        display["revision"],
        [channel(gamma=2, high=200, opacity=0.5)],
    )
    assert changed["revision"] == 2
    saved = wb.execute("source_view", {"source_id": source["id"]})["state"]
    assert {
        k: saved[k] for k in ("selection", "camera", "interpretation", "projection", "rgb_mapping")
    } == {
        k: state[k] for k in ("selection", "camera", "interpretation", "projection", "rgb_mapping")
    }
    assert saved["channels"][1] == state["channels"][1]
    np.testing.assert_array_equal(
        wb.load_scalar(source["id"], image_request["selection"])[0], raw_before
    )
    preview_after = wb.run_recipe(request, preview=True)
    assert preview_before["measurements"] == preview_after["measurements"]
    assert (
        preview_before["provenance"]["recipe_sha256"]
        == preview_after["provenance"]["recipe_sha256"]
    )
    with pytest.raises(ValueError):
        agent.set_source_display(source["id"], source["sha256"], 1, [channel()])
    with pytest.raises(ValueError):
        agent.set_source_display(source["id"], "0" * 64, 2, [channel()])
    with pytest.raises(PermissionError):
        agent.set_source_display(source["id"], source["sha256"], 2, [channel(1)])


def test_display_defaults_preserve_full_presentation_without_decoding_or_preview(
    tmp_path, monkeypatch
):
    agent, wb, source, _, request, _, _ = make_v3(
        tmp_path, templates=False, disclosures=["geometry", "provenance", "agent_metadata"]
    )
    expected = _default_view_state_for_source(source)
    assert expected["interpretation"] == "fluorescence"
    assert [item["channel"] for item in expected["channels"]] == [0, 1]
    monkeypatch.setattr(
        Workbench, "load_scalar", lambda *a, **k: pytest.fail("default sampled source")
    )
    before = agent.source_display(source["id"])
    assert before["revision"] == 0 and before["source_sha256"] == source["sha256"]
    assert before["channels"] == [expected["channels"][0]]
    assert "interpretation" not in before and "selection" not in before and "camera" not in before
    assert wb.execute("source_view", {"source_id": source["id"]})["state"] is None
    update = channel(gamma=2, opacity=0.5)
    written = agent.set_source_display(source["id"], source["sha256"], 0, [update])
    expected["channels"][0] = update
    assert written["revision"] == 1 and written["channels"] == [update]
    assert wb.execute("source_view", {"source_id": source["id"]})["state"] == expected
    with pytest.raises(PermissionError, match="previews"):
        agent.source_image(request)


def test_vision_revocation_source_mutation_and_spawn_failure_release_reservation(
    tmp_path, monkeypatch
):
    agent, wb, source, _, request, path, _ = make_v3(tmp_path, templates=False)
    monkeypatch.setattr(
        subprocess, "Popen", lambda *a, **k: (_ for _ in ()).throw(OSError("spawn failed"))
    )
    with pytest.raises(OSError):
        agent.source_image(request)
    assert agent.supervisor._preview_count == 0
    monkeypatch.undo()
    with agent.supervisor._lock:
        agent.supervisor._preview_count = 1
    with pytest.raises(PermissionError, match="concurrency"):
        agent.source_image(request)
    agent.supervisor._preview_count = 0
    original = render_source_image

    def revoked(workbench, image_request, **kwargs):
        result = original(workbench, image_request, **kwargs)
        path.unlink()
        return result

    monkeypatch.setattr("loci_engine.agent_vision.render_source_image", revoked)
    with pytest.raises((PermissionError, ValueError, OSError)):
        agent._vision_frame(wb, request, supervised=False)
    assert source["id"] == request["source_id"]


def test_real_handoff_is_provisional_path_free_and_requires_separate_disclosures(tmp_path):
    agent, _, source, _, request, path, spec = make_v3(tmp_path, templates=False)
    receipt = agent.export_vision_handoff(request, "approved.loci-vision")
    context_path = tmp_path / "exports" / "approved.loci-vision" / "context.json"
    context = json.loads(context_path.read_text())
    assert context["source_sha256"] == source["sha256"]
    assert context["status"] == "provisional-visualization"
    assert "source_name" not in context
    assert str(tmp_path) not in json.dumps([receipt, context])
    assert set(receipt["artifacts"]) == {"image.png", "context.json", "README.md", "manifest.json"}
    with pytest.raises((FileExistsError, ValueError)):
        agent.export_vision_handoff(request, "approved.loci-vision")
    with pytest.raises(PermissionError):
        agent.export_vision_handoff(request, "approved-result")
    for category in ("geometry", "provenance", "agent_metadata", "previews"):
        bad = copy.deepcopy(spec)
        bad["disclosures"].remove(category)
        write_policy(path, agent.policy.project_path, bad)
        replacement = PolicyAgent(load_policy(path))
        with pytest.raises(PermissionError):
            replacement.export_vision_handoff(request, "approved.loci-vision")


def test_real_sdk_native_images_experiments_and_durable_child_results(tmp_path):
    _, _, _, request, image_request, path, _ = make_v3(tmp_path)
    request["recipe"]["segmentation"]["threshold"] = 75
    request["recipe"]["segmentation"]["min_size"] = 1

    async def exercise():
        async with (
            stdio_client(stdio_parameters(path)) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            tools = await session.list_tools()
            assert {
                "source_image",
                "source_display",
                "set_source_display",
                "export_vision_handoff",
            } <= {t.name for t in tools.tools}
            source = await session.call_tool("source_image", {"request": image_request})
            preview = await session.call_tool("preview_recipe", {"request": request})
            for response in (source, preview):
                assert not response.is_error
                assert any(
                    c.type == "image" and c.mime_type == "image/png" for c in response.content
                )
                assert "image" not in response.structured_content
                assert "base64" not in json.dumps(response.structured_content)
                assert all("data:image" not in c.text for c in response.content if c.type == "text")
            submitted = await session.call_tool(
                "submit_recipe", {"request": request, "request_key": "v3-experiment"}
            )
            assert not submitted.is_error
            job_id = submitted.structured_content["job"]["id"]
            deadline = time.monotonic() + 15
            while True:
                status = await session.call_tool("job_status", {"job_id": job_id})
                job = status.structured_content["job"]
                if job["state"] in {"succeeded", "failed", "cancelled"}:
                    break
                assert time.monotonic() < deadline
                await asyncio.sleep(0.05)
            assert job["state"] == "succeeded"
            result_id = job["result_ids"][0]
            result = await session.call_tool("result", {"result_id": result_id})
            assert not result.is_error
            rendered = await session.call_tool("result_view", {"result_id": result_id})
            assert not rendered.is_error
            assert any(c.type == "image" for c in rendered.content)
            assert "image" not in rendered.structured_content
            bad = await session.call_tool("source_image", {"request": image_request, "extra": True})
            assert bad.is_error
            bad = await session.call_tool(
                "set_source_display",
                {
                    "source_id": image_request["source_id"],
                    "source_sha256": "0" * 64,
                    "expected_revision": True,
                    "channels": [channel()],
                },
            )
            assert bad.is_error

    asyncio.run(exercise())


def test_projection_render_receipt_and_opacity_are_explicit_display_only(tmp_path):
    _, wb, source, _, request, _, _ = make_v3(tmp_path, templates=False)
    request["projection"] = "max"
    request["selection"].update(z=0, z_stop=4)
    request["channels"] = [channel(opacity=0.5)]
    frame = render_source_image(wb, request)
    import io

    from PIL import Image

    with Image.open(io.BytesIO(validate_png(frame["image"]))) as image:
        rendered = np.asarray(image)
    assert rendered.shape == (16, 16, 3)
    np.testing.assert_array_equal(rendered[4:12, 4:12], np.full((8, 8, 3), 128))
    assert frame["rendering"]["selection"] == request["selection"]
    assert frame["rendering"]["projection"] == "max"
    assert frame["source_sha256"] == source["sha256"]
    request["projection"] = "mean"
    request["channels"] = [channel(visible=False)]
    frame = render_source_image(wb, request)
    with Image.open(io.BytesIO(validate_png(frame["image"]))) as image:
        assert not np.asarray(image).any()


def test_rgb_mapping_conflict_is_rejected_without_clearing_semantics(tmp_path):
    import tifffile

    from loci_engine.research_project import ResearchProject
    from loci_engine.source_view_state import execute_view_state

    path = tmp_path / "rgb-planes.tif"
    tifffile.imwrite(
        path, np.ones((3, 16, 16), dtype=np.uint16), ome=True, metadata={"axes": "CYX"}
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Synthetic RGB mapping"))
    source = wb.import_native(str(path))
    state = _default_view_state_for_source(source)
    state["rgb_mapping"] = [0, 1, 2]
    for setting, color in zip(state["channels"], ["#ff0000", "#00ff00", "#0000ff"], strict=True):
        setting["color"] = color
    execute_view_state(
        wb,
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "state": state,
        },
    )
    root = tmp_path / "exports"
    root.mkdir()
    request = {"source_id": source["id"], "selection": {"z": 0}, "recipe": {}}
    spec = specification(
        wb,
        source,
        request,
        root,
        recipes=False,
        disclosures=["geometry", "provenance", "agent_metadata"],
    )
    spec["sources"][0]["crop"] = {"x": 0, "y": 0, "width": 16, "height": 16}
    spec["sources"][0]["z"] = [0]
    spec["operations"] += ["set_source_display"]
    spec["remote_grants"] = []
    spec["experimental_recipes"] = []
    policy_path = tmp_path / "policy.json"
    write_policy(policy_path, wb.project, spec)
    agent = PolicyAgent(load_policy(policy_path))
    with pytest.raises(ValueError, match="mapping"):
        agent.set_source_display(source["id"], source["sha256"], 1, [channel(color="#ffffff")])
    saved = execute_view_state(wb, "source_view", {"source_id": source["id"]})
    assert saved["revision"] == 1 and saved["state"] == state


def test_source_mutation_prevents_display_and_image(tmp_path):
    import tifffile

    agent, _, source, _, request, _, _ = make_v3(tmp_path, templates=False)
    tifffile.imwrite(tmp_path / "synthetic.tif", np.ones((32, 32), dtype=np.uint16))
    with pytest.raises((PermissionError, ValueError)):
        agent.source_display(source["id"])
    with pytest.raises((PermissionError, ValueError)):
        agent.source_image(request)


def test_real_recipe_child_rejects_out_of_range_proposal_before_execution(tmp_path):
    from loci_engine.research_jobs import submit_job

    agent, wb, _, request, _, _, _ = make_v3(tmp_path)
    request["recipe"]["segmentation"]["threshold"] = 95
    job = submit_job(wb, request, "human-unapproved")
    completed = subprocess.run(
        agent.supervisor._command(wb.project, job["id"]),
        capture_output=True,
        timeout=15,
        check=False,
        env={**os.environ, "PYTHONPATH": str(wb_source_path())},
    )
    assert completed.returncode != 0
    assert not wb.project.job(job["id"])["result_ids"]
    assert wb.project.job(job["id"])["state"] == "queued"


def wb_source_path():
    from pathlib import Path

    return Path(__file__).resolve().parents[1] / "src"


def test_hidden_vision_child_rejects_replaced_policy_and_help_omits_internal_route(tmp_path):
    agent, _, _, _, request, path, _ = make_v3(tmp_path, templates=False)
    policy = agent.policy
    args = [
        sys.executable,
        "-m",
        "loci_engine.research_cli",
        "vision-render",
        "--project",
        str(policy.project_path),
        "--operation",
        "source_image",
        "--request",
        "-",
        "--cpu-seconds",
        str(policy.cpu_seconds),
        "--memory-bytes",
        str(policy.memory_bytes),
        "--policy",
        str(path),
        "--policy-sha256",
        policy.content_sha256,
        "--policy-file-identity",
        ":".join(map(str, policy.file_identity)),
        "--project-directory-identity",
        ":".join(map(str, policy.project_directory_identity)),
        "--export-directory-identity",
        ":".join(map(str, policy.export_root_identity)),
    ]
    replacement = path.with_suffix(".replacement")
    replacement.write_bytes(path.read_bytes())
    os.chmod(replacement, 0o600)
    replacement.replace(path)
    completed = subprocess.run(
        args,
        input=json.dumps(request),
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
        env={**os.environ, "PYTHONPATH": str(wb_source_path())},
    )
    assert completed.returncode != 0
    assert not completed.stdout
    assert str(tmp_path) not in completed.stderr
    help_result = subprocess.run(
        [sys.executable, "-m", "loci_engine.research_cli", "--help"],
        capture_output=True,
        check=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(wb_source_path())},
    )
    assert "vision-render" not in help_result.stdout


def test_display_revocation_inside_transaction_rolls_back_presentation(tmp_path, monkeypatch):
    from loci_engine.research_project import ResearchProject

    agent, wb, source, _, _, path, _ = make_v3(tmp_path, templates=False)
    original = ResearchProject.put_document

    def revoke_before_commit(project, *args, publication_guard=None, **kwargs):
        calls = 0

        def wrapped_guard():
            nonlocal calls
            calls += 1
            if calls == 2:
                path.write_text(path.read_text() + " ")
            publication_guard()

        return original(project, *args, publication_guard=wrapped_guard, **kwargs)

    monkeypatch.setattr(ResearchProject, "put_document", revoke_before_commit)
    with pytest.raises(PermissionError, match="changed"):
        agent.set_source_display(source["id"], source["sha256"], 0, [channel(gamma=2)])
    value = wb.execute("source_view", {"source_id": source["id"]})
    assert value["revision"] == 0 and value["state"] is None


@pytest.mark.parametrize("category", ["geometry", "provenance", "agent_metadata"])
def test_display_read_and_write_require_independent_disclosures(tmp_path, category):
    agent, _, source, _, _, _, _ = make_v3(
        tmp_path,
        templates=False,
        disclosures=[
            item for item in ("geometry", "provenance", "agent_metadata") if item != category
        ],
    )
    with pytest.raises(PermissionError, match=category):
        agent.source_display(source["id"])
    with pytest.raises(PermissionError, match=category):
        agent.set_source_display(source["id"], source["sha256"], 0, [channel()])


def test_image_render_requires_pinned_runtime_before_spawn(tmp_path, monkeypatch):
    agent, _, _, _, request, path, spec = make_v3(tmp_path, templates=False)
    spec["runtimes"] = []
    write_policy(path, agent.policy.project_path, spec)
    agent = PolicyAgent(load_policy(path))
    monkeypatch.setattr(
        subprocess, "Popen", lambda *a, **k: pytest.fail("spawned unapproved runtime")
    )
    with pytest.raises(PermissionError, match="runtime"):
        agent.source_image(request)


def test_vision_budget_is_forwarded_to_native_reader_and_large_tiles_fail_before_decode(
    tmp_path, monkeypatch
):
    import tifffile

    from loci_engine.research_project import ResearchProject

    path = tmp_path / "large-tiles.tif"
    tifffile.imwrite(path, np.zeros((1024, 1024), dtype=np.uint16), tile=(512, 512))
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Synthetic tile budget"))
    source = wb.import_native(str(path))
    request = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 16,
            "height": 16,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "channels": [channel()],
        "projection": "plane",
        "max_size": 64,
    }
    session = wb._session(source["id"])
    original = type(session).read_region
    budgets = []

    def capture(current, selection):
        budgets.append(selection.budget_bytes)
        return original(current, selection)

    monkeypatch.setattr(type(session), "read_region", capture)
    with pytest.raises(ValueError, match="budget|decode|bytes"):
        render_source_image(wb, request, working_bytes=128 * 1024)
    assert budgets == [128 * 1024]


@pytest.mark.parametrize("saved", [False, True])
def test_display_read_write_require_runtime_and_leave_presentation_unchanged(tmp_path, saved):
    agent, wb, source, _, _, path, spec = make_v3(tmp_path, templates=False)
    if saved:
        wb.execute(
            "save_source_view",
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "expected_revision": 0,
                "state": _default_view_state_for_source(source),
            },
        )
    before = wb.execute("source_view", {"source_id": source["id"]})
    spec["runtimes"] = []
    write_policy(path, wb.project, spec)
    agent = PolicyAgent(load_policy(path))
    with pytest.raises(PermissionError, match="runtime"):
        agent.source_display(source["id"])
    with pytest.raises(PermissionError, match="runtime"):
        agent.set_source_display(
            source["id"], source["sha256"], before["revision"], [channel(gamma=2)]
        )
    assert wb.execute("source_view", {"source_id": source["id"]}) == before


def test_unsaved_display_with_too_many_channels_fails_without_truncating_defaults(
    tmp_path, monkeypatch
):
    import tifffile

    agent, wb, _, _, _, policy_path, spec = make_v3(tmp_path, templates=False)
    path = tmp_path / "seventeen-channels.tif"
    tifffile.imwrite(
        path, np.zeros((17, 32, 32), dtype=np.uint16), ome=True, metadata={"axes": "CYX"}
    )
    source = wb.import_native(str(path))
    spec["sources"] = [
        {**spec["sources"][0], "id": source["id"], "sha256": source["sha256"], "z": [0]}
    ]
    write_policy(policy_path, wb.project, spec)
    agent = PolicyAgent(load_policy(policy_path))
    monkeypatch.setattr(
        "loci_engine.source_view_state._default_view_state_for_source",
        lambda *a: pytest.fail("Allocated unsupported full-channel defaults"),
    )
    with pytest.raises(ValueError, match="1-16 source channels"):
        agent.source_display(source["id"])
    with pytest.raises(ValueError, match="1-16 source channels"):
        agent.set_source_display(source["id"], source["sha256"], 0, [channel()])
    assert wb.execute("source_view", {"source_id": source["id"]})["state"] is None
