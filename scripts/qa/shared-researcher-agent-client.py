"""Synthetic shared-workflow fixtures, independent oracle and actual SDK controller.

No application engine is imported. ``serve`` reuses the existing session SDK
controller. ``crash-worker`` signals only the exact current-user MCP server named
by this generated study's session record, after verifying its executable/policy.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import re
import signal
import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

SELECTION = {
    "x": 8,
    "y": 8,
    "width": 40,
    "height": 40,
    "z": 0,
    "t": 0,
    "c": 0,
    "level": 0,
}
VALUES = ((100, 150, 200), (80, 160, 240))
PIXELS = (64, 96, 48)
MARKER = "shared-agent-fixture.json"


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def fixture(directory: Path, size: int, *, announce=True):
    import numpy as np
    import tifffile

    directory = directory.resolve(strict=True)
    if (directory / MARKER).exists():
        raise FileExistsError("Generated fixture destination must be new")
    sources = []
    for index, values in enumerate(VALUES):
        target = directory / f"shared-synthetic-{index + 1}.ome.tif"
        if target.exists():
            raise FileExistsError(target)
        image = np.zeros((2, size, size), np.uint16)
        image[0, 12:20, 12:20] = values[0]
        image[0, 28:36, 28:40] = values[1]
        image[0, 40:46, 14:22] = values[2]
        image[1] = np.arange(size * size, dtype=np.uint16).reshape(size, size)
        tifffile.imwrite(
            target,
            image,
            photometric="minisblack",
            ome=True,
            metadata={
                "axes": "CYX",
                "Channel": {"Name": ["Synthetic raw", "Synthetic ramp"]},
                "PhysicalSizeX": 0.5,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeY": 0.5,
                "PhysicalSizeYUnit": "µm",
            },
        )
        sources.append(
            {
                "path": str(target),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "variant": index,
            }
        )
    record = {
        "schema": "loci.shared-agent-synthetic-fixture/v1",
        "sources": sources,
        "selection": SELECTION,
        "size": size,
        "pixel_size_um": 0.5,
        "expected": [expected(index) for index in range(2)],
    }
    (directory / MARKER).write_text(json.dumps(record, indent=2) + "\n")
    if announce:
        emit(record)


def expected(variant, corrected=False):
    labels = (2, 3) if corrected else (1, 2, 3)
    return [
        {
            "label": label,
            "voxel_count": PIXELS[label - 1],
            "measure": PIXELS[label - 1] / 4,
            "mean": VALUES[variant][label - 1],
        }
        for label in labels
    ]


def verify_result(study: Path, result_id: str, variant: int, corrected: bool):
    import numpy as np

    if not re.fullmatch("[a-f0-9]{32}", result_id):
        raise ValueError("Choose an exact result id")
    study = study.resolve(strict=True)
    if not (study.parent / MARKER).is_file():
        raise ValueError("Oracle reads only a generated shared-workflow QA study")
    with sqlite3.connect(
        f"file:{study / 'study.sqlite3'}?mode=ro", uri=True
    ) as database:
        row = database.execute(
            "SELECT record FROM results WHERE id=?", (result_id,)
        ).fetchone()
        if row is None:
            raise ValueError("Exact result is absent")
        record = json.loads(row[0])
    labels = np.zeros((40, 40), np.uint32)
    labels[4:12, 4:12] = 1
    labels[20:28, 20:32] = 2
    labels[32:38, 6:14] = 3
    image = np.zeros((40, 40), np.uint16)
    for label, value in enumerate(VALUES[variant], 1):
        image[labels == label] = value
    if corrected:
        labels[labels == 1] = 0
    hashes = {}
    for key, array in (("image", image), ("labels", labels)):
        artifact = record["arrays"][key]
        if not re.fullmatch("[a-f0-9]{64}", artifact["sha256"]):
            raise ValueError("Invalid content-addressed array identity")
        target = study / "artifacts" / (artifact["sha256"] + ".npy")
        assert hashlib.sha256(target.read_bytes()).hexdigest() == artifact["sha256"]
        np.testing.assert_array_equal(np.load(target, allow_pickle=False), array)
        hashes[key] = artifact["sha256"]
    actual = [
        {
            "label": row["label"],
            "voxel_count": row["voxel_count"],
            "measure": row["measure"],
            "mean": next(iter(row["intensity"].values()))["mean"],
        }
        for row in record["provenance"]["measurements"]
    ]
    assert actual == expected(variant, corrected), (
        actual,
        expected(variant, corrected),
    )
    emit(
        {
            "verified": True,
            "result_id": result_id,
            "revision_hash": record["revision_hash"],
            "variant": variant,
            "corrected": corrected,
            "measurements": actual,
            "arrays": hashes,
        }
    )


def crash_worker(study: Path, session_id: str, worker: Path, policy: Path):
    study, worker, policy = (
        value.resolve(strict=True) for value in (study, worker, policy)
    )
    if not (study.parent / MARKER).is_file() or not policy.is_relative_to(study.parent):
        raise ValueError(
            "Crash control is restricted to its generated fixture/access bundle"
        )
    if not re.fullmatch("[a-f0-9]{32}", session_id):
        raise ValueError("Choose an exact synthetic session")
    with sqlite3.connect(
        f"file:{study / 'study.sqlite3'}?mode=ro", uri=True
    ) as database:
        row = database.execute(
            "SELECT value FROM metadata WHERE key=?", ("agent-session:" + session_id,)
        ).fetchone()
    session = json.loads(row[0]) if row else None
    if not session or not session["client_id"].startswith("Loci shared workflow QA"):
        raise ValueError("Crash control requires this QA controller's exact session")
    pid = session["private_pid"]
    command = subprocess.check_output(
        ["/bin/ps", "-p", str(pid), "-o", "command="], text=True
    ).strip()
    uid = int(
        subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", "uid="], text=True)
    )
    if (
        uid != os.getuid()
        or not command.startswith(str(worker) + " ")
        or f"--cli mcp --policy {policy}" not in command
    ):
        raise ValueError(
            "MCP process command/owner differs from the exact QA worker and policy"
        )
    os.kill(pid, signal.SIGKILL)
    emit({"crashed": True, "session_id": session_id, "target": "exact QA MCP server"})


async def approval_expiry(worker: Path, directory: Path, *, prepare_only=False):
    """Actual 900-second expiry in a dedicated synthetic study, without a GUI."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.types import Implementation

    worker = worker.resolve(strict=True)
    directory = directory.resolve(strict=True)
    fixture(directory, 64, announce=False)
    study = directory / "expiry.loci-study"
    exports = directory / "exports"
    exports.mkdir()

    def cli(*arguments):
        return json.loads(
            subprocess.check_output(
                [str(worker), "--loci", "--json", *arguments], text=True
            )
        )

    cli("create", "--project", str(study), "--title", "Synthetic approval expiry")
    manifest = json.loads((directory / MARKER).read_text())
    source = cli("import", "--project", str(study), manifest["sources"][0]["path"])[
        "sources"
    ][0]
    request = {
        "source_id": source["id"],
        "selection": SELECTION,
        "recipe": {
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0],
        },
    }
    request_file = directory / "recipe.json"
    request_file.write_text(json.dumps(request))
    produced = cli(
        "submit",
        "--project",
        str(study),
        "--request",
        "@" + str(request_file),
        "--request-key",
        "expiry-baseline",
        "--run",
    )
    result = produced["result"]
    raw = cli(
        "execute",
        "--project",
        str(study),
        "result",
        "--request",
        json.dumps({"result_id": result["id"]}),
    )
    runtime = raw["provenance"]["runtime"]
    keys = ("engine", "numpy", "scipy", "scikit_image", "backend", "resolved_device")
    specification = {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {key: SELECTION[key] for key in ("x", "y", "width", "height")},
                "t": [0],
                "c": [0],
                "z": [0],
                "level": [0],
                "measurement_channels": [0],
            }
        ],
        "recipes": [],
        "operations": ["inspect_source", "review_result", "review_history", "result"],
        "model_packages": [],
        "runtimes": [{key: runtime[key] for key in keys}],
        "export": None,
        "limits": {"cpu_seconds": 60, "memory_bytes": 512 * 1024**2, "concurrency": 1},
        "disclosures": [
            "geometry",
            "source_names",
            "previews",
            "measurements",
            "provenance",
            "agent_metadata",
        ],
        "remote_grants": [],
        "experimental_recipes": [],
        "actions": [],
        "delegation": {
            "id": uuid4().hex,
            "client_id": "Loci shared workflow QA expiry",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
        "permission_mode": "ask_approval",
    }
    spec_file = directory / "specification.json"
    spec_file.write_text(json.dumps(specification))
    policy = directory / "agent-policy.json"
    cli(
        "policy",
        "--project",
        str(study),
        "--destination",
        str(policy),
        "--specification",
        "@" + str(spec_file),
    )
    receipt = {
        "status": "running",
        "scope": "real native approval TTL; dedicated generated study",
        "worker_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
        "started_at": datetime.now(UTC).isoformat(),
        "study": str(study),
    }
    receipt_file = directory / "approval-expiry-receipt.json"

    def save():
        receipt_file.write_text(json.dumps(receipt, indent=2) + "\n")

    save()
    if prepare_only:
        receipt["status"] = "prepared"
        save()
        emit(
            {"status": "prepared", "receipt": str(receipt_file), "policy": str(policy)}
        )
        return
    parameters = StdioServerParameters(
        command=str(worker), args=["--cli", "mcp", "--policy", str(policy)]
    )
    try:
        async with (
            stdio_client(parameters) as streams,
            ClientSession(
                *streams,
                client_info=Implementation(
                    name="Loci shared workflow QA expiry", version="1.0"
                ),
            ) as session,
        ):
            await session.initialize()
            response_task = asyncio.create_task(
                session.call_tool(
                    "review_result",
                    {
                        "request": {
                            "result_id": result["id"],
                            "revision_hash": result["revision_hash"],
                            "disposition": "reviewed",
                            "reason": "Unapproved synthetic TTL request must expire without a review",
                            "coverage": "Generated fixture only",
                            "expected_review_sha256": None,
                        }
                    },
                )
            )
            response_task.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None
            )
            approval = None
            for _ in range(20):
                await asyncio.sleep(0.25)
                state = cli("snapshot", "--project", str(study))
                approval = next(
                    (
                        item
                        for item in state["agent_sessions"]["approvals"]
                        if item["state"] == "pending"
                    ),
                    None,
                )
                if approval:
                    break
            assert approval is not None, (
                "Actual MCP request did not create a pending approval"
            )
            expiry = datetime.fromisoformat(approval["expires_at"])
            assert 850 < (expiry - datetime.now(UTC)).total_seconds() <= 901
            receipt["approval"] = approval
            save()
            emit(
                {
                    "expiry_started": True,
                    "receipt": str(receipt_file),
                    "expires_at": approval["expires_at"],
                }
            )
            while datetime.now(UTC) < expiry:
                await asyncio.sleep(
                    min(10, max(0.1, (expiry - datetime.now(UTC)).total_seconds()))
                )
                keepalive = await session.call_tool(
                    "inspect_source", {"source_id": source["id"]}
                )
                assert not keepalive.isError
            state = cli("snapshot", "--project", str(study))
            final = next(
                item
                for item in state["agent_sessions"]["approvals"]
                if item["id"] == approval["id"]
            )
            assert final["state"] == "expired", final
            assert (
                next(item for item in state["results"] if item["id"] == result["id"])[
                    "review"
                ]
                is None
            )
            assert len(state["jobs"]) == 1 and len(state["results"]) == 1
            response = await response_task
            assert response.isError
            receipt.update(
                status="passed",
                final_approval=final,
                no_review=True,
                no_duplicate_publication=True,
            )
    except Exception as exc:
        receipt.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        receipt["finished_at"] = datetime.now(UTC).isoformat()
        save()
    emit({"status": receipt["status"], "receipt": str(receipt_file)})


def session_controller():
    helper = Path(__file__).with_name("agent-session-client.py")
    spec = importlib.util.spec_from_file_location("shared_workflow_sdk", helper)
    if spec is None or spec.loader is None:
        raise RuntimeError("Existing SDK controller is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("fixture")
    make.add_argument("directory", type=Path)
    make.add_argument("--size", type=int, choices=[64, 2048], default=64)
    server = commands.add_parser("serve")
    server.add_argument("worker")
    server.add_argument("policy")
    server.add_argument("--client-name", default="Loci shared workflow QA 1")
    verify = commands.add_parser("verify-result")
    verify.add_argument("study", type=Path)
    verify.add_argument("result_id")
    verify.add_argument("variant", type=int, choices=[0, 1])
    verify.add_argument("--corrected", action="store_true")
    expiry = commands.add_parser("approval-expiry")
    expiry.add_argument("worker", type=Path)
    expiry.add_argument("directory", type=Path)
    expiry.add_argument("--prepare-only", action="store_true")
    crash = commands.add_parser("crash-worker")
    crash.add_argument("study", type=Path)
    crash.add_argument("session_id")
    crash.add_argument("worker", type=Path)
    crash.add_argument("policy", type=Path)
    args = parser.parse_args()
    if args.command == "fixture":
        fixture(args.directory, args.size)
    elif args.command == "verify-result":
        verify_result(args.study, args.result_id, args.variant, args.corrected)
    elif args.command == "approval-expiry":
        asyncio.run(
            approval_expiry(args.worker, args.directory, prepare_only=args.prepare_only)
        )
    elif args.command == "crash-worker":
        crash_worker(args.study, args.session_id, args.worker, args.policy)
    else:
        asyncio.run(
            session_controller().serve(args.worker, args.policy, args.client_name)
        )
