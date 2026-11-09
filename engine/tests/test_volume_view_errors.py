"""Public volume codes cross the real SDK boundary; native diagnostics do not."""

import asyncio
import json
import tempfile

import anyio
import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from mcp.shared.memory import create_client_server_memory_streams
from test_research_mcp import stdio_parameters
from test_volume_view_state import fixture, image_request, publish

from loci_engine.agent_policy import write_policy
from loci_engine.research_mcp import PolicyAgent, build_server
from loci_engine.volume_view_errors import VolumeViewError


@pytest.mark.parametrize("code", ["VIEW_STALE", "VIEW_UNAVAILABLE", "VIEW_BUSY"])
def test_public_volume_error_accepts_only_fixed_codes(code):
    error = VolumeViewError(code)
    assert error.code == code
    assert str(error) == error.public_message
    assert error.public_message.startswith(code + ": ")
    # An arbitrary native diagnostic cannot replace the public message.
    error.args = ("/private/secret-study/labels.tif",)
    assert "/private" not in error.public_message


@pytest.mark.parametrize("code", ["/private/study", "VIEW_STALE: /private/study", None, 7])
def test_public_volume_error_refuses_unknown_or_diagnostic_codes(code):
    with pytest.raises(ValueError, match="^Unsupported public volume view error code$"):
        VolumeViewError(code)


def test_real_stdio_sdk_volume_failures_are_identifiable_without_private_details(tmp_path):
    wb, source, _, _, token, spec, path = fixture(tmp_path)

    async def journey():
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            request = {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "expected_live": token,
                "patch": {"crosshair_source_xyz": [4, 7, 1]},
            }
            queued = await session.call_tool("set_volume_view", {"request": request})
            assert not queued.is_error
            request_id = queued.structured_content["request_id"]
            applied = wb.execute(
                "volume_view_request_apply", {"request_id": request_id, "live_token": token}
            )
            current = applied["live_token"]
            publish(wb, source, current)
            wb.execute(
                "volume_view_request_complete",
                {"request_id": request_id, "live_token": current, "capture": None},
            )
            replay = await session.call_tool("set_volume_view", {"request": request})
            assert replay.is_error
            assert replay.content[0].text == (
                "Error executing tool set_volume_view: "
                + VolumeViewError("VIEW_STALE").public_message
            )
            assert len(wb.project.documents("volume_view_request")) == 1
            for code, flags in (
                ("VIEW_BUSY", {"busy": True}),
                ("VIEW_UNAVAILABLE", {"available": False}),
            ):
                publish(wb, source, current, **flags)
                response = await session.call_tool(
                    "volume_view_image", {"request": image_request(source, current)}
                )
                assert response.is_error
                assert response.content[0].text == (
                    "Error executing tool volume_view_image: "
                    + VolumeViewError(code).public_message
                )
                encoded = json.dumps(response.model_dump(by_alias=True))
                assert str(tmp_path) not in encoded
                assert source["id"] not in encoded
            # A displayed channel beyond the pinned grant remains a generic
            # authorization refusal even while GUI presence is unavailable.
            state = wb.execute("volume_view", {"source_id": source["id"]})["state"]
            state["channels"] = [1]
            wb.execute(
                "save_volume_view",
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "expected_revision": current["revision"],
                    "expected_display_revision": current["display_revision"],
                    "state": state,
                },
            )
            denied = await session.call_tool(
                "volume_view_image", {"request": image_request(source, current)}
            )
            assert denied.is_error
            assert denied.content[0].text == (
                "Error executing tool volume_view_image: The operation, source scope, "
                "disclosure or resource limit is not authorized by the active policy."
            )
            assert "VIEW_UNAVAILABLE" not in denied.content[0].text

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(journey())
        # The fixed unavailable code must not reveal even empty GUI state when
        # the pinned source crop cannot authorize its full context.
        with wb.project.connection() as connection:
            connection.execute("DELETE FROM documents WHERE kind='volume_view'")
        spec["sources"][0]["crop"]["width"] = 31
        write_policy(path, wb.project, spec)

        async def denied_empty_scene():
            async with (
                stdio_client(stdio_parameters(path), errlog=errlog) as streams,
                ClientSession(*streams) as session,
            ):
                await session.initialize()
                denied = await session.call_tool(
                    "volume_view_image", {"request": image_request(source, token)}
                )
                assert denied.is_error
                assert denied.content[0].text == (
                    "Error executing tool volume_view_image: The operation, source scope, "
                    "disclosure or resource limit is not authorized by the active policy."
                )

        asyncio.run(denied_empty_scene())
        errlog.seek(0)
        diagnostics = errlog.read()
    assert str(tmp_path) not in diagnostics
    assert "Traceback" not in diagnostics


@pytest.mark.parametrize("kind", [ValueError, OSError, PermissionError])
def test_sdk_boundary_never_infers_public_codes_from_arbitrary_exception_text(
    tmp_path, monkeypatch, kind
):
    _, source, _, _, _, _, path = fixture(tmp_path)
    private = "/private/secret-study/labels.tif"

    def fail(_self, _source_id):
        raise kind("VIEW_STALE: " + private)

    monkeypatch.setattr(PolicyAgent, "volume_view", fail)
    server = build_server(path)

    async def journey():
        async with (
            create_client_server_memory_streams() as (client_streams, server_streams),
            anyio.create_task_group() as group,
        ):
            group.start_soon(
                server._lowlevel_server.run,
                *server_streams,
                server._lowlevel_server.create_initialization_options(),
            )
            async with ClientSession(*client_streams) as session:
                await session.initialize()
                response = await session.call_tool("volume_view", {"source_id": source["id"]})
                assert response.is_error
                text = response.content[0].text
                expected = (
                    "The operation, source scope, disclosure or resource limit "
                    "is not authorized by the active policy."
                    if kind is PermissionError
                    else "The research operation failed validation or execution. "
                    "Inspect the source and settings in Loci."
                )
                assert text == "Error executing tool volume_view: " + expected
                assert "VIEW_STALE" not in text
                assert private not in json.dumps(response.model_dump(by_alias=True))
            group.cancel_scope.cancel()

    asyncio.run(journey())
