"""Synthetic-only state, policy and real-GUI-mailbox protocol regressions."""

import asyncio
import base64
import copy
import io

import numpy as np
import pytest
import tifffile
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from PIL import Image
from test_agent_policy import make_study, specification
from test_research_mcp import stdio_parameters

from loci_engine.agent_policy import VOLUME_POLICY_SCHEMA, load_policy, write_policy
from loci_engine.research_mcp import PolicyAgent, build_server, protocol_image_result
from loci_engine.research_project import ResearchProject
from loci_engine.research_session import clone_study
from loci_engine.source_view_state import _default_view_state_for_source
from loci_engine.volume_view_mailbox import live_token, presence
from loci_engine.volume_view_state import PATCH_GROUPS
from loci_engine.workbench import Workbench


def fixture(tmp_path, *, mode="full_access", view_grant=True):
    workbench, source, recipe = make_study(tmp_path)
    workbench.execute(
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "state": _default_view_state_for_source(source),
        },
    )
    state = {
        "t": 0,
        "channels": [0],
        "result": None,
        "selected_object": None,
        "representation": {
            "mode": "mpr",
            "extent": "context",
            "render_mode": "blend",
            "quality": 50,
        },
        "camera": {
            "projection": "parallel",
            "position_xyz": [40, 40, 40],
            "focal_point_xyz": [15, 15, 1.5],
            "view_up_xyz": [0, 1, 0],
            "clipping_range": [0.1, 100],
            "view_angle_degrees": 30,
            "parallel_scale": 25,
            "frame": "image",
            "unit": "pixel",
        },
        "crosshair_source_xyz": [11, 17, 2],
        "clipping": {"enabled": True, "axis": "z", "position_percent": 37.5},
        "refinement": {"target_long_axis": 128, "focus_region_xyzxyz": [3, 20, 4, 25, 0, 3]},
        "layout": {
            "mode": "four",
            "expanded_pane": None,
            "pane_order": ["axial", "coronal", "sagittal", "volume"],
            "col_split": 41,
            "row_split": 57,
        },
        "labels": {"visible": False, "opacity": 0.6, "selected_only": False},
    }
    workbench.execute(
        "save_volume_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "expected_display_revision": 1,
            "state": state,
        },
    )
    exports = tmp_path / "exports"
    exports.mkdir()
    spec = specification(
        workbench,
        source,
        recipe,
        exports,
        recipes=False,
        disclosures=["geometry", "provenance", "agent_metadata", "previews"],
    )
    if view_grant:
        spec["volume_views"] = {
            "read": True,
            "write": True,
            "image": True,
            "fields": sorted(PATCH_GROUPS),
        }
        spec["operations"] += [
            "volume_view",
            "set_volume_view",
            "volume_view_image",
            "volume_view_request_status",
            "cancel_volume_view_request",
        ]
    spec["permission_mode"] = mode
    path = tmp_path / "policy.json"
    write_policy(path, workbench.project, spec)
    agent = PolicyAgent(load_policy(path))
    token = {
        "view_id": "volume-test",
        "renderer_generation": 1,
        "live_epoch": 5,
        "revision": 1,
        "display_revision": 1,
    }
    publish(workbench, source, token)
    return workbench, source, state, agent, token, spec, path


def publish(workbench, source, token, **flags):
    return workbench.execute(
        "volume_view_presence",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            **token,
            "busy": False,
            "available": True,
            **flags,
        },
    )


def image_request(source, token):
    return {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "expected_live": token,
        "panes": ["volume"],
        "max_size": 64,
    }


def capture(workbench, source, token):
    output = io.BytesIO()
    Image.new("RGB", (32, 24), "red").save(output, format="PNG")
    value = workbench.execute("volume_view", {"source_id": source["id"]})
    return {
        "image": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
        "rendering": {
            "kind": "gui-rendered-scene",
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "geometry_sha256": value["geometry_sha256"],
            "live_token": token,
            "panes": ["volume"],
            "width": 32,
            "height": 24,
            "manifest": {
                "schema": "loci.volume-scene-capture/v1",
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "state": value["state"],
                "display_channels": [_default_view_state_for_source(source)["channels"][0]],
                "raw_payloads": {"context_data_sha256": "a" * 64, "focus_data_sha256": None},
                "labels": None,
                "panes": ["volume"],
                "composition": "gui-pane-contact-sheet",
                "image_size": [32, 24],
            },
        },
    }


def test_roundtrip_save_as_missing_source_and_old_records_unchanged(tmp_path):
    wb, source, state, _, _, _, _ = fixture(tmp_path)
    before = (tmp_path / "synthetic.tif").read_bytes()
    expected = wb.execute("volume_view", {"source_id": source["id"]})
    reopened = Workbench(ResearchProject(wb.project.root))
    assert reopened.execute("volume_view", {"source_id": source["id"]}) == expected
    clone = clone_study(wb.project, tmp_path / "copy.loci-study")
    assert Workbench(clone).execute("volume_view", {"source_id": source["id"]}) == expected
    assert wb.project.documents("display")[0]["revision"] == 1
    assert not wb.project.documents("workspace")
    assert not wb.project.list_results()
    assert (tmp_path / "synthetic.tif").read_bytes() == before
    (tmp_path / "synthetic.tif").unlink()
    assert reopened.execute("volume_view", {"source_id": source["id"]})["state"] == state


@pytest.mark.parametrize("declared_unit,to_um", [("µm", 1), ("nm", 0.001), ("mm", 1000)])
def test_calibrated_native_camera_matches_renderer_and_survives_missing_source(
    tmp_path, declared_unit, to_um
):
    from loci_engine.viewer_volume import build_volume_payload

    wb, _, state, _, _, _, _ = fixture(tmp_path)
    path = tmp_path / "calibrated.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((4, 32, 32), dtype=np.uint16),
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "ZYX",
            **{
                f"PhysicalSize{axis}": size
                for axis, size in zip("XYZ", [0.5, 1.5, 2.5], strict=True)
            },
            **{f"PhysicalSize{axis}Unit": declared_unit for axis in "XYZ"},
        },
    )
    source = wb.import_native(str(path))
    payload = build_volume_payload(wb._session(source["id"]), source_id=source["id"])
    assert payload["context"]["unit"] == "um"
    assert payload["context"]["spacing_xyz"] == pytest.approx(
        [0.5 * to_um, 1.5 * to_um, 2.5 * to_um]
    )
    state["camera"].update(unit=payload["context"]["unit"], frame=payload["context"]["frame"])
    wb.execute(
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "state": _default_view_state_for_source(source),
        },
    )
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "expected_revision": 0,
        "expected_display_revision": 1,
        "state": state,
    }
    saved = wb.execute("save_volume_view", request)
    incompatible = copy.deepcopy(request)
    incompatible["expected_revision"] = saved["revision"]
    incompatible["state"]["camera"]["unit"] = "pixel"
    with pytest.raises(ValueError, match="frame and unit"):
        wb.execute("save_volume_view", incompatible)
    wb.close()
    path.unlink()
    reopened = Workbench(ResearchProject(wb.project.root))
    try:
        assert reopened.execute("volume_view", {"source_id": source["id"]}) == saved
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s.update(crosshair_source_xyz=[1, 2, 31]),
        lambda s: s.update(channels=[0, 0]),
        lambda s: s["camera"].update(frame="RAS"),
        lambda s: s["camera"].update(view_up_xyz=[0, 0, 0]),
        lambda s: s["camera"].update(position_xyz=[float("nan"), 0, 0]),
        lambda s: s["layout"].update(pane_order=["axial"] * 4),
        lambda s: s["refinement"].update(focus_region_xyzxyz=[0, 1, 0, 1, 1, 1]),
        lambda s: s.update(selected_object={"result_id": "a" * 32}),
    ],
)
def test_invalid_state_is_atomic(tmp_path, mutate):
    wb, source, state, _, _, _, _ = fixture(tmp_path)
    before = wb.execute("volume_view", {"source_id": source["id"]})
    mutate(state)
    with pytest.raises(ValueError):
        wb.execute(
            "save_volume_view",
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "expected_revision": 1,
                "expected_display_revision": 1,
                "state": state,
            },
        )
    assert wb.execute("volume_view", {"source_id": source["id"]}) == before


def test_independent_grant_and_typed_discovery(tmp_path):
    wb, source, _, agent, _, _, path = fixture(tmp_path)
    assert agent.policy.schema == VOLUME_POLICY_SCHEMA
    tools = {t["name"]: t for t in agent.catalog()["tools"]}
    assert (
        tools["set_volume_view"]["request_schema"]["properties"]["patch"]["additionalProperties"]
        is False
    )
    assert agent.volume_view(source["id"])["live"]["available"] is True
    build_server(path)  # Real MCP SDK registration resolves the annotated schemas.
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    _, old_source, _, old_agent, _, _, _ = fixture(legacy, view_grant=False)
    with pytest.raises(PermissionError):
        old_agent.volume_view(old_source["id"])
    assert "volume_view" not in {t["name"] for t in old_agent.catalog()["tools"]}


def test_cas_concurrent_gesture_busy_and_headless(tmp_path):
    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    request = image_request(source, token)
    with pytest.raises(ValueError, match="resolved camera"):
        agent.set_volume_view(
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "expected_live": token,
                "patch": {"camera": None},
            }
        )
    publish(wb, source, token, busy=True)
    with pytest.raises(ValueError, match="VIEW_BUSY"):
        agent.volume_view_image(request)
    publish(wb, source, {**token, "live_epoch": 6})
    with pytest.raises(ValueError, match="VIEW_STALE"):
        agent.volume_view_image(request)
    publish(wb, source, {**token, "live_epoch": 6}, available=False)
    with pytest.raises(ValueError, match="VIEW_UNAVAILABLE"):
        agent.volume_view_image(request)


def test_set_request_commits_then_requires_exact_render_ack(tmp_path):
    wb, source, state, agent, token, _, _ = fixture(tmp_path)
    patch = {"crosshair_source_xyz": [4, 7, 1]}
    queued = agent.set_volume_view(
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_live": token,
            "patch": patch,
        }
    )
    pending = wb.execute("volume_view_requests", {})["requests"]
    assert len(pending) == 1 and "policy_path" not in pending[0]
    applied = wb.execute(
        "volume_view_request_apply", {"request_id": queued["request_id"], "live_token": token}
    )
    assert applied["view"]["state"] == {**state, **patch}
    assert agent.volume_view_request_status(queued["request_id"])["status"] == "applying"
    wb.execute(
        "volume_view_request_complete",
        {"request_id": queued["request_id"], "live_token": applied["live_token"], "capture": None},
    )
    response = agent.volume_view_request_status(queued["request_id"])
    assert response["response"]["rendered"] is True
    assert applied["live_token"] == {**token, "revision": 2}


def test_stale_human_edit_does_not_apply_queued_agent_patch(tmp_path):
    wb, source, state, agent, token, _, _ = fixture(tmp_path)
    queued = agent.set_volume_view(
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_live": token,
            "patch": {"crosshair_source_xyz": [4, 7, 1]},
        }
    )
    publish(wb, source, {**token, "live_epoch": 6}, busy=True)
    with pytest.raises(ValueError, match="VIEW_STALE"):
        wb.execute(
            "volume_view_request_apply", {"request_id": queued["request_id"], "live_token": token}
        )
    assert wb.execute("volume_view", {"source_id": source["id"]})["state"] == state


def test_actual_native_png_response_and_late_capture_refusal(tmp_path):
    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    queued = agent.volume_view_image(image_request(source, token))
    receipt = capture(wb, source, token)
    wb.execute(
        "volume_view_request_complete",
        {"request_id": queued["request_id"], "live_token": token, "capture": receipt},
    )
    response = agent.volume_view_request_status(queued["request_id"])
    delivered = protocol_image_result(response, required=False)
    assert delivered.content[1].type == "image"
    assert delivered.structured_content["response"]["rendering"]["display_only"] is True
    queued2 = agent.volume_view_image(image_request(source, token))
    publish(wb, source, {**token, "live_epoch": 6})
    with pytest.raises(ValueError, match="VIEW_STALE"):
        wb.execute(
            "volume_view_request_complete",
            {"request_id": queued2["request_id"], "live_token": token, "capture": receipt},
        )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda spec: spec["sources"][0]["crop"].update(width=16),
        lambda spec: spec["sources"][0].update(z=[0, 1]),
        lambda spec: spec["sources"][0].update(c=[1]),
        lambda spec: spec["volume_views"].update(image=False),
        lambda spec: spec.update(disclosures=["geometry", "provenance", "agent_metadata"]),
    ],
)
def test_scope_and_disclosure_denials(tmp_path, mutate):
    _, source, _, _, token, spec, path = fixture(tmp_path)
    mutate(spec)
    write_policy(path, ResearchProject(tmp_path / "synthetic-study"), spec)
    agent = PolicyAgent(load_policy(path))
    with pytest.raises(PermissionError):
        agent.volume_view_image(image_request(source, token))


def test_cancellation_owner_revocation_and_inspect_only(tmp_path):
    wb, source, _, agent, token, _, path = fixture(tmp_path)
    queued = agent.volume_view_image(image_request(source, token))
    assert agent.cancel_volume_view_request(queued["request_id"])["status"] == "cancelled"
    with pytest.raises(ValueError, match="no longer pending"):
        wb.execute(
            "volume_view_request_complete",
            {
                "request_id": queued["request_id"],
                "live_token": token,
                "capture": capture(wb, source, token),
            },
        )
    queued2 = agent.volume_view_image(image_request(source, token))
    path.write_text(path.read_text() + " ")
    with pytest.raises(PermissionError):
        wb.execute(
            "volume_view_request_complete",
            {
                "request_id": queued2["request_id"],
                "live_token": token,
                "capture": capture(wb, source, token),
            },
        )
    other = tmp_path / "inspect"
    other.mkdir()
    _, s2, _, a2, t2, _, _ = fixture(other, mode="inspect_only")
    with pytest.raises(PermissionError, match="Inspect-only"):
        a2.set_volume_view(
            {
                "source_id": s2["id"],
                "source_sha256": s2["sha256"],
                "expected_live": t2,
                "patch": {"crosshair_source_xyz": [1, 2, 3]},
            }
        )


def test_display_revision_in_materialized_token(tmp_path):
    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    from loci_engine.source_view_state import _default_view_state_for_source

    wb.execute(
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 1,
            "state": _default_view_state_for_source(source),
        },
    )
    with pytest.raises(ValueError, match="VIEW_STALE"):
        agent.volume_view_image(image_request(source, token))
    assert live_token(presence(wb.project, source["id"])) == token


def test_legacy_linked_plane_operation_preserved(tmp_path):
    wb, source, _, _, _, _, _ = fixture(tmp_path)
    response = wb.execute(
        "volume_view",
        {
            "source_id": source["id"],
            "selection": {"x": 0, "y": 0, "width": 8, "height": 9, "z": 0, "z_stop": 4},
            "crosshair": [1, 2, 3],
            "display": {"low": 0, "high": 100},
            "include_volume": False,
        },
    )
    assert response["shape"] == [4, 9, 8]
    assert response["crosshair"] == [1, 2, 3]


def test_exact_result_label_hash_id_and_time(tmp_path):
    wb, source, state, _, _, _, _ = fixture(tmp_path)
    output = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"z": 0, "z_stop": 4},
            "recipe": {
                "segmentation": {"method": "components", "threshold": 50},
                "measurement_channels": [0],
            },
        },
    )
    result = wb.project.result(output["result"]["id"])
    from loci_engine.research_annotations import label_array_sha256

    label_hash = label_array_sha256(wb.project.load_array(result["arrays"]["labels"]))
    binding = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "label_sha256": label_hash,
    }
    state["result"] = binding
    state["selected_object"] = {**binding, "label_id": 1}
    state["labels"]["visible"] = True
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "expected_revision": 1,
        "expected_display_revision": 1,
        "state": state,
    }
    saved = wb.execute("save_volume_view", request)
    assert saved["state"]["selected_object"] == {**binding, "label_id": 1}
    request["expected_revision"] = 2
    for mutate in (
        lambda s: s["selected_object"].update(label_id=999),
        lambda s: s["result"].update(label_sha256="b" * 64),
        lambda s: s.update(t=1),
    ):
        bad = copy.deepcopy(request)
        mutate(bad["state"])
        with pytest.raises(ValueError):
            wb.execute("save_volume_view", bad)
        assert wb.execute("volume_view", {"source_id": source["id"]}) == saved
    (tmp_path / "synthetic.tif").unlink()
    assert wb.execute("volume_view", {"source_id": source["id"]}) == saved


@pytest.mark.parametrize(
    "change",
    [
        lambda c: c["rendering"]["manifest"]["state"]["clipping"].update(position_percent=11),
        lambda c: c["rendering"]["manifest"].update(display_channels=[]),
        lambda c: c["rendering"]["manifest"].update(panes=["axial"]),
        lambda c: c["rendering"]["manifest"]["raw_payloads"].update(context_data_sha256="bad"),
        lambda c: c["rendering"].update(width=31),
        lambda c: c["rendering"]["manifest"].update(source_path="/private/source.tif"),
    ],
)
def test_gui_capture_manifest_and_png_are_fail_closed(tmp_path, change):
    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    queued = agent.volume_view_image(image_request(source, token))
    image = capture(wb, source, token)
    change(image)
    with pytest.raises(ValueError):
        wb.execute(
            "volume_view_request_complete",
            {"request_id": queued["request_id"], "live_token": token, "capture": image},
        )
    assert agent.volume_view_request_status(queued["request_id"])["status"] == "queued"


def test_real_stdio_sdk_request_to_native_gui_mailbox_image(tmp_path):
    wb, source, _, _, token, _, path = fixture(tmp_path)

    async def journey():
        async with (
            stdio_client(stdio_parameters(path)) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            assert (
                tools["set_volume_view"].input_schema["properties"]["request"]["properties"][
                    "patch"
                ]["additionalProperties"]
                is False
            )
            read = await session.call_tool("volume_view", {"source_id": source["id"]})
            assert not read.is_error
            queued = await session.call_tool(
                "volume_view_image", {"request": image_request(source, token)}
            )
            assert not queued.is_error
            request_id = queued.structured_content["request_id"]
            wb.execute(
                "volume_view_request_complete",
                {
                    "request_id": request_id,
                    "live_token": token,
                    "capture": capture(wb, source, token),
                },
            )
            response = await session.call_tool(
                "volume_view_request_status", {"request_id": request_id}
            )
            assert not response.is_error
            assert any(content.type == "image" for content in response.content)
            assert (
                response.structured_content["response"]["rendering"]["kind"] == "gui-rendered-scene"
            )
            assert "image" not in response.structured_content["response"]
            async with (
                stdio_client(stdio_parameters(path)) as other_streams,
                ClientSession(*other_streams) as other,
            ):
                await other.initialize()
                denied = await other.call_tool(
                    "volume_view_request_status", {"request_id": request_id}
                )
                assert denied.is_error
            bad = await session.call_tool(
                "volume_view",
                {"source_id": source["id"], "native_operation": "save_volume_view"},
            )
            assert bad.is_error

    asyncio.run(journey())


def test_approval_binds_scene_token_and_mode_change_invalidates_queue(tmp_path):
    from loci_engine.agent_sessions import AgentSessionApprovalError, control_agent_session

    wb, source, state, agent, token, _, _ = fixture(tmp_path, mode="ask_approval")
    agent.approval_wait_seconds = 0
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "expected_live": token,
        "patch": {"crosshair_source_xyz": [1, 2, 3]},
    }
    with pytest.raises(AgentSessionApprovalError):
        agent.set_volume_view(request)
    approval = wb.snapshot()["agent_sessions"]["approvals"][0]
    assert any(t["kind"] == "volume_view" for t in approval["targets"])
    control_agent_session(wb, {"action": "approve_request", "approval_id": approval["id"]})
    queued = agent.set_volume_view(request)
    control_agent_session(
        wb,
        {
            "action": "set_permission_mode",
            "policy_sha256": agent.policy.content_sha256,
            "permission_mode": "full_access",
        },
    )
    with pytest.raises(PermissionError, match="mode changed"):
        wb.execute(
            "volume_view_request_apply", {"request_id": queued["request_id"], "live_token": token}
        )
    assert wb.execute("volume_view", {"source_id": source["id"]})["state"] == state


def test_human_gesture_marks_pending_approval_stale(tmp_path):
    from loci_engine.agent_sessions import AgentSessionApprovalError, control_agent_session

    wb, source, state, agent, token, _, _ = fixture(tmp_path, mode="ask_approval")
    agent.approval_wait_seconds = 0
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "expected_live": token,
        "patch": {"crosshair_source_xyz": [1, 2, 3]},
    }
    with pytest.raises(AgentSessionApprovalError):
        agent.set_volume_view(request)
    approval = wb.snapshot()["agent_sessions"]["approvals"][0]
    publish(wb, source, {**token, "live_epoch": 6}, busy=True)
    with pytest.raises(ValueError):
        control_agent_session(wb, {"action": "approve_request", "approval_id": approval["id"]})
    assert not wb.project.documents("volume_view_request")
    assert wb.execute("volume_view", {"source_id": source["id"]})["state"] == state


def test_capacity_expiry_and_disconnected_presence(tmp_path, monkeypatch):
    import loci_engine.volume_view_mailbox as mailbox

    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    monkeypatch.setattr(mailbox, "MAX_REQUESTS", 1)
    queued = agent.volume_view_image(image_request(source, token))
    with pytest.raises(ValueError, match="capacity"):
        agent.volume_view_image(image_request(source, token))
    document = wb.project.documents("volume_view_request")[0]
    document["data"]["deadline"] = 0
    wb.project.put_document(
        "volume_view_request",
        document["id"],
        document["data"],
        expected_revision=document["revision"],
    )
    assert agent.volume_view_request_status(queued["request_id"])["response"]["reason"] == "expired"
    assert not wb.execute("volume_view_requests", {})["requests"]
    registered = wb.project.documents("volume_view_presence")[0]
    registered["data"]["heartbeat"] = 0
    wb.project.put_document(
        "volume_view_presence",
        registered["id"],
        registered["data"],
        expected_revision=registered["revision"],
    )
    with pytest.raises(ValueError, match="VIEW_UNAVAILABLE"):
        agent.volume_view_image(image_request(source, token))


def test_access_bundle_scene_grants_do_not_imply_execute_or_review(tmp_path):
    from test_research_agent_setup import access_request

    from loci_engine.research_agent_setup import create_agent_access

    wb, _, recipe = make_study(tmp_path)
    destination = tmp_path / "view-access"
    receipt = create_agent_access(
        wb,
        access_request(
            recipe,
            allow_run=False,
            disclosures=["geometry", "provenance", "agent_metadata", "previews"],
            volume_views={"read": True, "write": True, "image": True, "fields": ["camera"]},
        ),
        destination,
    )
    policy = load_policy(destination / "agent-policy.json")
    assert policy.schema == VOLUME_POLICY_SCHEMA
    assert policy.volume_views["fields"] == ["camera"]
    assert "set_volume_view" in receipt["operations"]
    assert "submit_recipe" not in receipt["operations"]
    assert "review_result" not in receipt["operations"]
    assert not policy.actions and policy.delegation is None
    assert receipt["volume_views"] == policy.volume_views


def test_same_content_policy_replacement_and_cloned_project_refuse_request(tmp_path):
    import os

    wb, source, _, agent, token, _, path = fixture(tmp_path)
    queued = agent.volume_view_image(image_request(source, token))
    clone = clone_study(wb.project, tmp_path / "copy.loci-study")
    with pytest.raises(PermissionError, match="policy changed"):
        Workbench(clone).execute(
            "volume_view_request_complete",
            {
                "request_id": queued["request_id"],
                "live_token": token,
                "capture": capture(wb, source, token),
            },
        )
    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(path.read_bytes())
    replacement.chmod(0o600)
    os.replace(replacement, path)
    with pytest.raises(PermissionError, match="policy changed"):
        wb.execute(
            "volume_view_request_complete",
            {
                "request_id": queued["request_id"],
                "live_token": token,
                "capture": capture(wb, source, token),
            },
        )


def test_session_heartbeat_expiry_refuses_native_late_delivery(tmp_path):
    from loci_engine.agent_sessions import _session_key, start_session
    from loci_engine.research_project import canonical_json, parse_json

    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    session = start_session(wb.project, agent.policy, client_id="volume-test")
    agent.session_id = session["session_id"]
    queued = agent.volume_view_image(image_request(source, token))
    with wb.project.connection() as connection:
        key = _session_key(agent.session_id)
        row = connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        record = parse_json(row[0])
        record["last_heartbeat_at"] = "2000-01-01T00:00:00+00:00"
        connection.execute("UPDATE metadata SET value=? WHERE key=?", (canonical_json(record), key))
    with pytest.raises(PermissionError, match="expired"):
        wb.execute(
            "volume_view_request_complete",
            {
                "request_id": queued["request_id"],
                "live_token": token,
                "capture": capture(wb, source, token),
            },
        )


def test_scene_capture_preserves_numeric_values_across_json_number_spelling(tmp_path):
    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    queued = agent.volume_view_image(image_request(source, token))
    receipt = capture(wb, source, token)
    channel = receipt["rendering"]["manifest"]["display_channels"][0]
    channel["high"] = int(channel["high"])
    channel["color"] = channel["color"].upper()
    receipt["rendering"]["manifest"]["state"]["camera"]["view_angle_degrees"] = 30.0
    wb.execute(
        "volume_view_request_complete",
        {"request_id": queued["request_id"], "live_token": token, "capture": receipt},
    )
    assert agent.volume_view_request_status(queued["request_id"])["status"] == "complete"


def test_legacy_implicit_source_opacity_is_preserved_in_capture(tmp_path):
    wb, source, _, agent, token, _, _ = fixture(tmp_path)
    original = _default_view_state_for_source(source)
    del original["channels"][0]["opacity"]
    wb.execute(
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 1,
            "state": original,
        },
    )
    token = {**token, "display_revision": 2}
    publish(wb, source, token)
    queued = agent.volume_view_image(image_request(source, token))
    wb.execute(
        "volume_view_request_complete",
        {
            "request_id": queued["request_id"],
            "live_token": token,
            "capture": capture(wb, source, token),
        },
    )
    assert agent.volume_view_request_status(queued["request_id"])["status"] == "complete"
    assert "opacity" not in wb.project.documents("display")[0]["data"]["state"]["channels"][0]
