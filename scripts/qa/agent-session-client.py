"""JSONL controller for a real MCP SDK stdio client with deferred initialization.

The controller never edits a study or policy. Commands carry an integer ``id``;
responses may arrive out of order, so the UI can act while a tool awaits approval.
``fixture`` reuses the existing synthetic-only fixture generator.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import platform
import sys
from pathlib import Path
from typing import Any


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, allow_nan=False), flush=True)


def fixture(directory: Path) -> None:
    helper = Path(__file__).with_name("agent-workbench-client.py")
    spec = importlib.util.spec_from_file_location("agent_workbench_fixture", helper)
    if spec is None or spec.loader is None:
        raise RuntimeError("The synthetic fixture helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.fixture(directory)


def response_record(response: Any) -> dict[str, Any]:
    document = response.model_dump(by_alias=True)
    content = []
    for block in document["content"]:
        if block["type"] == "image":
            data = base64.b64decode(block["data"], validate=True)
            content.append(
                {
                    "type": "image",
                    "mimeType": block["mimeType"],
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size_bytes": len(data),
                }
            )
        else:
            content.append(block)
    return {
        "is_error": document.get("isError", False),
        "content": content,
        "structured_content": document.get("structuredContent"),
    }


async def serve(worker: str, policy: str, client_name: str) -> None:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.types import Implementation

    initialized = False
    initializing = False
    seen: set[int] = set()
    tasks: set[asyncio.Task[None]] = set()
    parameters = StdioServerParameters(
        command=worker, args=["--cli", "mcp", "--policy", policy]
    )
    async with (
        stdio_client(parameters) as streams,
        ClientSession(
            *streams, client_info=Implementation(name=client_name, version="1.0")
        ) as session,
    ):
        # A completed ping proves the server transport is running. It must not
        # manufacture connected presence before a successful initialize request.
        await session.send_ping()
        emit(
            {
                "event": "transport_ready",
                "initialized": False,
                "python": platform.python_version(),
                "mcp_sdk": importlib.metadata.version("mcp"),
                "client_name": client_name,
            }
        )

        async def dispatch(request: dict[str, Any]) -> None:
            nonlocal initialized, initializing
            request_id = request["id"]
            try:
                action = request.get("action", "call")
                if action == "initialize":
                    if initialized or initializing:
                        raise ValueError("Initialize is single-use for this controller")
                    initializing = True
                    result = await session.initialize()
                    initialized = True
                    output = {
                        "initialized": True,
                        "server": result.model_dump(by_alias=True),
                    }
                elif action == "ping":
                    await session.send_ping()
                    output = {"pong": True, "initialized": initialized}
                elif not initialized:
                    raise ValueError("Initialize the MCP session before invoking tools")
                elif action == "tools":
                    output = {
                        "tools": [
                            tool.name for tool in (await session.list_tools()).tools
                        ]
                    }
                elif action == "call":
                    output = response_record(
                        await session.call_tool(
                            request["name"], request.get("arguments", {})
                        )
                    )
                else:
                    raise ValueError(f"Unsupported controller action: {action}")
                emit({"id": request_id, **output})
            except Exception as exc:  # noqa: BLE001 - return controller errors, never success
                emit(
                    {
                        "id": request_id,
                        "controller_error": type(exc).__name__,
                        "message": str(exc),
                    }
                )
            finally:
                if request.get("action") == "initialize":
                    initializing = False

        try:
            while line := await asyncio.to_thread(sys.stdin.readline):
                request = json.loads(line)
                if not isinstance(request, dict) or type(request.get("id")) is not int:
                    raise ValueError("Controller commands need a unique integer id")
                if request["id"] in seen:
                    raise ValueError("Controller command id was reused")
                seen.add(request["id"])
                if request.get("action") == "close":
                    emit({"id": request["id"], "closing": True})
                    break
                task = asyncio.create_task(dispatch(request))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        finally:
            # Cancel outstanding SDK calls before closing the transport. The SDK
            # owns and reaps its frozen-worker child; no unrelated PID is signalled.
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("fixture")
    make.add_argument("directory", type=Path)
    server = commands.add_parser("serve")
    server.add_argument("worker")
    server.add_argument("policy")
    server.add_argument("--client-name", default="Loci packaged session QA")
    args = parser.parse_args()
    if args.command == "fixture":
        fixture(args.directory)
    else:
        asyncio.run(serve(args.worker, args.policy, args.client_name))
