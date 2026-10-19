"""Synthetic fixture generation and a JSONL controller for actual frozen-worker MCP."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import sys
from pathlib import Path


def fixture(directory: Path) -> None:
    import numpy as np
    import tifffile

    directory = directory.resolve(strict=True)
    target = directory / "agent-synthetic.ome.tif"
    if target.exists():
        raise FileExistsError("Synthetic fixture destination must be absent")
    image = np.zeros((2, 64, 64), np.uint16)
    image[0, 12:20, 12:20] = 100
    image[0, 28:36, 28:40] = 150
    image[0, 40:46, 14:22] = 200
    image[1] = np.arange(64 * 64, dtype=np.uint16).reshape(64, 64)
    tifffile.imwrite(
        target,
        image,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.5,
            "PhysicalSizeYUnit": "µm",
        },
    )
    print(
        json.dumps(
            {
                "source": str(target),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "shape": [2, 64, 64],
                "axes": "CYX",
                "expected_objects": 3,
                "selection": {
                    "x": 8,
                    "y": 8,
                    "width": 40,
                    "height": 40,
                    "z": 0,
                    "t": 0,
                    "c": 0,
                    "level": 0,
                },
            }
        )
    )


def verify_correction(directory: Path, parent_id: str, child_id: str) -> None:
    """Independent known-grid oracle; does not import the application engine."""
    import sqlite3

    import numpy as np

    with sqlite3.connect(f"file:{directory / 'study.sqlite3'}?mode=ro", uri=True) as database:
        records = [
            json.loads(
                database.execute("SELECT record FROM results WHERE id=?", (key,)).fetchone()[0]
            )
            for key in (parent_id, child_id)
        ]
    parent, child = records
    assert child["parent_id"] == parent_id
    labels = np.zeros((40, 40), dtype=np.uint32)
    labels[4:12, 4:12] = 1
    labels[20:28, 20:32] = 2
    labels[32:38, 6:14] = 3
    image = np.zeros((40, 40), dtype=np.uint16)
    for label, intensity in ((1, 100), (2, 150), (3, 200)):
        image[labels == label] = intensity
    hashes = {}
    for record, expected in ((parent, labels), (child, np.where(labels == 1, 0, labels))):
        for name, expected_array in (("image", image), ("labels", expected)):
            digest = record["arrays"][name]["sha256"]
            file = directory / "artifacts" / (digest + ".npy")
            assert hashlib.sha256(file.read_bytes()).hexdigest() == digest
            np.testing.assert_array_equal(np.load(file, allow_pickle=False), expected_array)
            hashes[f"{record['id']}:{name}"] = digest
    rows = child["provenance"]["measurements"]
    assert sorted(row["measure"] for row in rows) == [12, 24]
    assert child["provenance"]["correction"]["operations"][0]["changed_voxels"] == 64
    print(
        json.dumps(
            {
                "parent_objects": 3,
                "child_objects": 2,
                "changed_pixels": 64,
                "areas_um2": [12, 24],
                "array_sha256": hashes,
            }
        )
    )


async def serve(worker: str, policy: str) -> None:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    parameters = StdioServerParameters(command=worker, args=["--cli", "mcp", "--policy", policy])
    async with stdio_client(parameters) as streams, ClientSession(*streams) as session:
        await session.initialize()
        print(json.dumps({"ready": True}), flush=True)
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            if request.get("action") == "tools":
                tools = await session.list_tools()
                output = {"tools": [item.name for item in tools.tools]}
            else:
                response = await session.call_tool(request["name"], request.get("arguments", {}))
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
                                "png_signature": data[:8] == b"\x89PNG\r\n\x1a\n",
                            }
                        )
                    else:
                        content.append(block)
                output = {
                    "is_error": document.get("isError", False),
                    "content": content,
                    "structured_content": document.get("structuredContent"),
                }
            print(json.dumps(output, allow_nan=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("fixture")
    make.add_argument("directory", type=Path)
    server = commands.add_parser("serve")
    server.add_argument("worker")
    server.add_argument("policy")
    verify = commands.add_parser("verify-correction")
    verify.add_argument("directory", type=Path)
    verify.add_argument("parent_id")
    verify.add_argument("child_id")
    args = parser.parse_args()
    if args.command == "fixture":
        fixture(args.directory)
    elif args.command == "verify-correction":
        verify_correction(args.directory, args.parent_id, args.child_id)
    else:
        asyncio.run(serve(args.worker, args.policy))
