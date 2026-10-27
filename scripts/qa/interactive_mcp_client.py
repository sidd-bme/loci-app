"""Bounded JSONL bridge to an actual policy-bound Loci MCP worker."""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import hashlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAX_LINE_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024
_IMAGE_FORMATS = {
    "image/png": ("png", b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": ("jpg", b"\xff\xd8\xff"),
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _discard_frame_remainder(stream) -> None:
    """Consume one oversized JSONL frame without buffering its remaining bytes."""
    while True:
        chunk = stream.readline(MAX_LINE_BYTES + 1)
        if not chunk or chunk.endswith(b"\n"):
            return


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def decode_image(
    block: dict[str, Any], output: Path, index: int, remaining: int
) -> tuple[dict[str, Any], int]:
    """Validate and exclusively save one native MCP PNG/JPEG content block."""
    mime = block.get("mimeType")
    if mime not in _IMAGE_FORMATS:
        raise ValueError("Unsupported native MCP image MIME type")
    encoded = block.get("data")
    if not isinstance(encoded, str):
        raise TypeError("Native MCP image data must be base64 text")
    # Bound before decoding as well as after it, preventing a large allocation.
    if len(encoded) > ((min(MAX_IMAGE_BYTES, remaining) + 2) // 3) * 4:
        raise ValueError("Native MCP image exceeds the configured byte limit")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Native MCP image contains malformed base64") from exc
    if not data or len(data) > MAX_IMAGE_BYTES or len(data) > remaining:
        raise ValueError("Native MCP image exceeds the configured byte limit")
    extension, signature = _IMAGE_FORMATS[mime]
    if not data.startswith(signature):
        raise ValueError("Native MCP image bytes do not match the declared MIME type")
    path = output / f"image-{index:04d}.{extension}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as image_file:
            image_file.write(data)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return (
        {
            "type": "image",
            "mimeType": mime,
            "sha256": _sha256(data),
            "size_bytes": len(data),
            "path": str(path.resolve()),
        },
        len(data),
    )


def prepare_output(path: Path) -> Path:
    """Create a new output directory; never reuse or overwrite a prior run."""
    path = path.expanduser().absolute()
    path.mkdir(mode=0o700, parents=False, exist_ok=False)
    return path.resolve(strict=True)


def _response_for_stdout(
    document: dict[str, Any], output: Path, next_image: int, used: int
):
    content = []
    for block in document.get("content", []):
        if block.get("type") == "image":
            item, size = decode_image(
                block, output, next_image, MAX_TOTAL_IMAGE_BYTES - used
            )
            content.append(item)
            next_image += 1
            used += size
        else:
            content.append(block)
    result = {
        "isError": document.get("isError", False),
        "content": content,
    }
    if "structuredContent" in document:
        result["structuredContent"] = document["structuredContent"]
    return result, next_image, used


def _read_action(line: str) -> dict[str, Any]:
    try:
        action = json.loads(
            line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value))
        )
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError("Input line must be valid finite JSON") from exc
    if not isinstance(action, dict) or action.get("action") not in {
        "tools",
        "toolcall",
        "close",
    }:
        raise ValueError("Action must be tools, toolcall, or close")
    if action["action"] == "toolcall":
        if not isinstance(action.get("name"), str) or not action["name"]:
            raise ValueError("toolcall requires a nonempty tool name")
        if not isinstance(action.get("arguments", {}), dict):
            raise ValueError("toolcall arguments must be a JSON object")
    return action


def _append_transcript(
    transcript: Path, request: Any, response: Any, bridge_response: Any | None = None
) -> None:
    request_text = _canonical_json(request)
    response_text = _canonical_json(response)
    record = {
        "timestamp": datetime.now(UTC).isoformat(),
        "request": request,
        "request_sha256": _sha256(request_text.encode("utf-8")),
        "response": response,
        "response_sha256": _sha256(response_text.encode("utf-8")),
    }
    if bridge_response is not None:
        bridge_text = _canonical_json(bridge_response)
        record["bridge_response"] = bridge_response
        record["bridge_response_sha256"] = _sha256(bridge_text.encode("utf-8"))
    with transcript.open("a", encoding="utf-8") as stream:
        stream.write(_canonical_json(record) + "\n")


async def serve(worker: Path, policy: Path, output: Path) -> int:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    worker = worker.expanduser().resolve(strict=True)
    # Keep a supplied symlink path intact so the worker's policy loader can reject it.
    policy = policy.expanduser().absolute()
    if not worker.is_file() or not os.access(worker, os.X_OK):
        raise ValueError("--worker must be an executable file")
    if not policy.is_file():
        raise ValueError("--policy must be an existing file")
    output = prepare_output(output)
    transcript = output / "transcript.jsonl"
    command = [str(worker), "--cli", "mcp", "--policy", str(policy)]
    metadata = {
        "type": "bridge_start",
        "timestamp": datetime.now(UTC).isoformat(),
        "bridge_sha256": _sha256(Path(__file__).read_bytes()),
        "worker": str(worker),
        "worker_sha256": _sha256_file(worker),
        "command": command,
        "policy": str(policy),
    }
    with transcript.open("x", encoding="utf-8") as stream:
        stream.write(_canonical_json(metadata) + "\n")

    parameters = StdioServerParameters(command=str(worker), args=command[1:])
    image_index = 1
    image_bytes = 0
    async with stdio_client(parameters) as streams, ClientSession(*streams) as session:
        await session.initialize()
        listed = await session.list_tools()
        initial = {
            "type": "ready",
            "output": str(output),
            "tools": [
                tool.model_dump(by_alias=True, mode="json", exclude_none=False)
                for tool in listed.tools
            ],
        }
        with transcript.open("a", encoding="utf-8") as stream:
            stream.write(
                _canonical_json({**metadata, "initial_tools": initial["tools"]}) + "\n"
            )
        print(_canonical_json(initial), flush=True)
        while True:
            raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_LINE_BYTES or (
                not raw.endswith(b"\n") and len(raw) == MAX_LINE_BYTES + 1
            ):
                if not raw.endswith(b"\n"):
                    await asyncio.to_thread(_discard_frame_remainder, sys.stdin.buffer)
                response = {"error": "Input line exceeds 1 MiB limit"}
                _append_transcript(
                    transcript, {"invalid_line_sha256": _sha256(raw)}, response
                )
                print(_canonical_json(response), flush=True)
                continue
            request = {"raw": raw.decode("utf-8", "replace")}
            actual_response = None
            try:
                request = _read_action(raw.decode("utf-8").rstrip("\r\n"))
                if request["action"] == "close":
                    response = {"closed": True}
                    _append_transcript(transcript, request, response)
                    print(_canonical_json(response), flush=True)
                    return 0
                if request["action"] == "tools":
                    refreshed = await session.list_tools()
                    response = {
                        "tools": [
                            tool.model_dump(
                                by_alias=True, mode="json", exclude_none=False
                            )
                            for tool in refreshed.tools
                        ]
                    }
                else:
                    raw_response = await session.call_tool(
                        request["name"], request.get("arguments", {})
                    )
                    document = raw_response.model_dump(
                        by_alias=True, mode="json", exclude_none=False
                    )
                    actual_response = document
                    response, image_index, image_bytes = _response_for_stdout(
                        document, output, image_index, image_bytes
                    )
            except Exception as exc:  # noqa: BLE001 - return actual bridge/worker failures to the caller.
                response = {"error": f"{type(exc).__name__}: {exc}"}
            _append_transcript(
                transcript,
                request,
                actual_response if actual_response is not None else response,
                response,
            )
            print(_canonical_json(response), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--worker", required=True, type=Path, help="Exact executable MCP worker"
    )
    parser.add_argument("--policy", required=True, type=Path, help="Exact policy file")
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Fresh transcript and image directory",
    )
    args = parser.parse_args()
    try:
        return asyncio.run(serve(args.worker, args.policy, args.output))
    except Exception as exc:  # noqa: BLE001 - startup/transport failures are JSON protocol errors too.
        print(_canonical_json({"error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
