#!/usr/bin/env python3
"""Serial real CLI/MCP execution; no segmentation, evaluator or ground-truth imports.

Run-recipe/v1 JSON: schema=loci.real-fluorescence.run-recipe/v1, dataset,
classical (native classical_run request without source_id), perinuclear (native
request without result_id/revision_hash, or null), runtime (six policy identity
fields), limits (cpu_seconds,memory_bytes,concurrency=1). Classical selection is
explicit full native YX, DNA1 for BBBC013 and channel0 for BBBC039. BBBC013 rings
use raw GFP0, radius5 and constant control text. Only a packaged worker executes.

Code identity JSON: schema=loci.source-identity/v1, source_commit, source_tree,
files=[absolute path/sha256/bytes records], optional dirty. Candidate identity JSON:
schema=loci.candidate-identity/v1, source_commit, source_tree, files={executable,
app_asar,worker: absolute file records}. These are explicit operator trust pins,
not signature verification or proof an app was launched. Qualification additionally
requires an independently pinned existing settings-freeze containing dataset and
prepared_manifest,source_manifest,driver_recipe,code_manifest,candidate_identity
file records. Exploratory execution makes no frozen-app or qualification claim.

Every output root must be absent. No automatic retry of a failed analysis: only
transport exceptions may retry the identical durable request key. Uncertain active
jobs stop further submissions. Failed fields and unattempted fields remain visible.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

MAX_JSON = 16 << 20
RUNTIME_KEYS = {
    "engine",
    "numpy",
    "scipy",
    "scikit_image",
    "backend",
    "resolved_device",
}
REVIEW_REASON = "automated qualification artifact check; no human scientific approval"
REVIEW_COVERAGE = (
    "Automated source fingerprint, native result metadata and declared array shape/dtype checks only; "
    "no pixel-mask assessment, visual review or biological validation"
)
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def plain_path(value, *, absent=False):
    path = Path(value)
    if not path.is_absolute() or any(
        part.is_symlink() for part in (path, *path.parents)
    ):
        raise ValueError("Paths must be absolute and cannot traverse symlinks")
    if absent and path.exists():
        raise FileExistsError(
            "Output directory already exists; prior runs are never overwritten"
        )
    return path


def identity(path):
    path = plain_path(path)
    if not path.is_file():
        raise ValueError("Pinned input must be a plain file")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return {
        "path": str(path),
        "sha256": digest.hexdigest(),
        "bytes": path.stat().st_size,
    }


def pinned(path, expected):
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("An independently supplied SHA-256 pin is required")
    actual = identity(path)
    if actual["sha256"] != expected:
        raise ValueError("Pinned file identity changed")
    return actual


def verify_record(record):
    actual = pinned(record["path"], record["sha256"])
    if actual["bytes"] != record.get("bytes"):
        raise ValueError("Pinned file size changed")
    return actual


def read_json(path):
    if Path(path).stat().st_size > MAX_JSON:
        raise ValueError("JSON exceeds the driver resource bound")
    value = json.loads(
        Path(path).read_text(),
        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
    )
    if not isinstance(value, dict):
        raise TypeError("Expected a JSON object")
    return value


def write_json(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")


def event(root, kind, **details):
    with (root / "transcript.jsonl").open("a") as stream:
        stream.write(
            json.dumps(
                {"time": datetime.now(UTC).isoformat(), "kind": kind, **details},
                sort_keys=True,
                allow_nan=False,
            )
            + "\n"
        )


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--dataset", choices=["BBBC039v1", "BBBC013v1"], required=True)
    result.add_argument(
        "--split",
        choices=["development", "historically-exposed", "sealed-test"],
        required=True,
    )
    result.add_argument(
        "--select",
        action="append",
        help="Exact filename/well; repeat, or omit for every field in the chosen split",
    )
    result.add_argument(
        "--mode", choices=["exploratory", "qualification"], required=True
    )
    for name in (
        "worker",
        "prepared-manifest",
        "source-manifest",
        "recipe",
        "code-manifest",
    ):
        result.add_argument("--" + name, type=Path, required=True)
        result.add_argument("--" + name + "-sha256", required=True)
    for name in ("frozen-settings", "candidate-identity"):
        result.add_argument("--" + name, type=Path)
        result.add_argument("--" + name + "-sha256")
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--poll-seconds", type=float, default=0.5)
    result.add_argument("--job-timeout-seconds", type=float, default=600)
    result.add_argument("--transport-retries", type=int, choices=[0, 1, 2], default=1)
    return result


def selected_entries(manifest, dataset, split, selected):
    images = manifest.get("images")
    if not isinstance(images, list) or not 1 <= len(images) <= 200:
        raise ValueError("Prepared image list is missing or exceeds the driver bound")
    entries = {}
    for item in images:
        key = item.get("reference_filename" if dataset == "BBBC039v1" else "well")
        if not isinstance(key, str) or Path(key).name != key or key in entries:
            raise ValueError("Prepared keys must be unique safe filenames/wells")
        if dataset == "BBBC013v1":
            if not re.fullmatch(r"[A-H](0[1-9]|1[0-2])", key):
                raise ValueError("Invalid BBBC013 well")
            role = "development" if key[0] in "ABEF" else "sealed-test"
        else:
            role = item.get("role")
            official = item.get("official_split")
            if official not in {"training", "validation", "test"} or role not in {
                "development",
                "historically-exposed",
                "sealed-test",
            }:
                raise ValueError("Invalid BBBC039 split metadata")
            if (official == "test" and role == "development") or (
                official != "test" and role == "sealed-test"
            ):
                raise ValueError("BBBC039 role disagrees with official partition")
        entries[key] = (role, item)
    if selected is not None and (
        len(set(selected)) != len(selected) or set(selected) - entries.keys()
    ):
        raise ValueError("Selected source keys are duplicate or missing")
    keys = sorted(
        selected
        if selected is not None
        else [key for key, (role, _) in entries.items() if role == split]
    )
    if not keys or any(entries[key][0] != split for key in keys):
        raise ValueError("Every selected field must belong to the explicit split")
    return [(key, entries[key][1]) for key in keys]


def preflight(args):
    pins = {}
    for name in (
        "worker",
        "prepared_manifest",
        "source_manifest",
        "recipe",
        "code_manifest",
    ):
        pins[name] = pinned(getattr(args, name), getattr(args, name + "_sha256"))
    if not os.access(args.worker, os.X_OK):
        raise ValueError("Worker must be executable")
    if not 0 < args.poll_seconds <= 10 or not 1 <= args.job_timeout_seconds <= 86400:
        raise ValueError("Invalid poll/job timeout bound")
    manifest, recipe, code = (
        read_json(getattr(args, name))
        for name in ("prepared_manifest", "recipe", "code_manifest")
    )
    entries = selected_entries(manifest, args.dataset, args.split, args.select)
    if args.split == "sealed-test" and args.mode != "qualification":
        raise PermissionError(
            "Sealed fields require qualification mode and independently frozen settings"
        )
    if (
        code.get("schema") != "loci.source-identity/v1"
        or not isinstance(code.get("files"), list)
        or not 1 <= len(code["files"]) <= 4096
    ):
        raise ValueError("An explicit source code identity manifest is required")
    for key in ("source_commit", "source_tree"):
        if not re.fullmatch(r"[0-9a-f]{40}", code.get(key, "")):
            raise ValueError("Source commit/tree identity is required")
    for record in code["files"]:
        verify_record(record)
    for name in ("frozen_settings", "candidate_identity"):
        path, digest = getattr(args, name), getattr(args, name + "_sha256")
        if (path is None) != (digest is None):
            raise ValueError("Optional identity path requires its independent SHA-256")
        if path is not None:
            pins[name] = pinned(path, digest)
    if args.mode == "qualification":
        if not {"frozen_settings", "candidate_identity"} <= pins.keys():
            raise PermissionError(
                "Qualification requires frozen settings and complete candidate identity pins"
            )
        freeze, candidate = (
            read_json(args.frozen_settings),
            read_json(args.candidate_identity),
        )
        if (
            freeze.get("schema") != "loci.real-fluorescence.settings-freeze/v1"
            or freeze.get("dataset") != args.dataset
        ):
            raise ValueError("Frozen settings schema/dataset differs")
        for key, pin in (
            ("prepared_manifest", "prepared_manifest"),
            ("source_manifest", "source_manifest"),
            ("driver_recipe", "recipe"),
            ("code_manifest", "code_manifest"),
            ("candidate_identity", "candidate_identity"),
        ):
            if freeze.get(key) != pins[pin]:
                raise ValueError("Frozen settings differ from requested " + key)
        if candidate.get("schema") != "loci.candidate-identity/v1" or set(
            candidate.get("files", {})
        ) != {"executable", "app_asar", "worker"}:
            raise ValueError(
                "Candidate must pin executable, app.asar and embedded worker"
            )
        if any(
            candidate.get(key) != code[key] for key in ("source_commit", "source_tree")
        ):
            raise ValueError("Candidate and code identities differ")
        for record in candidate["files"].values():
            verify_record(record)
        if candidate["files"]["worker"] != pins["worker"]:
            raise ValueError(
                "Requested worker is not the pinned embedded candidate worker"
            )
    validate_recipe(recipe, args.dataset)
    sources = read_json(args.source_manifest).get("sources", [])
    if not sources or any(
        item.get("key") in {"039-masks", "013-reproduction"} for item in sources
    ):
        raise PermissionError(
            "Source manifest must contain originals without evaluator references"
        )
    members = {}
    for archive in sources:
        verify_record(archive)
        for member in archive.get("members", []):
            actual = verify_record(member)
            members[actual["path"]] = actual
    for _, entry in entries:
        verify_record(entry["derived"])
        originals = (
            [entry["source"]] if args.dataset == "BBBC039v1" else entry["sources"]
        )
        for original in originals:
            if verify_record(original) != members.get(original["path"]):
                raise ValueError(
                    "Selected original is not bound to the pinned source manifest"
                )
        shape = entry.get("shape", [])
        if (
            entry.get("dtype") != ("uint16" if args.dataset == "BBBC039v1" else "uint8")
            or any(type(value) is not int or value < 1 for value in shape)
            or entry.get("axes") != ("YX" if args.dataset == "BBBC039v1" else "CYX")
            or len(shape) != (2 if args.dataset == "BBBC039v1" else 3)
        ):
            raise ValueError("Prepared source axes differ from dataset")
        selection = recipe["classical"]["selection"]
        if (
            selection["width"] != shape[-1]
            or selection["height"] != shape[-2]
            or (args.dataset == "BBBC013v1" and shape[0] != 2)
        ):
            raise ValueError("Recipe must select the exact full prepared source grid")
    return pins, entries, recipe


def validate_recipe(recipe, dataset):
    if (
        recipe.get("schema") != "loci.real-fluorescence.run-recipe/v1"
        or recipe.get("dataset") != dataset
    ):
        raise ValueError("Explicit run recipe schema/dataset differs")
    classical = recipe.get("classical", {})
    if set(classical) != {
        "selection",
        "profile_id",
        "settings",
        "measurement_channels",
        "working_bytes",
    }:
        raise ValueError(
            "Classical recipe must contain the exact native request fields without source_id"
        )
    selection = classical["selection"]
    if classical["profile_id"] != "loci-classical" or not isinstance(
        classical["settings"], dict
    ):
        raise ValueError(
            "Only the native built-in classical profile/settings are supported"
        )
    channel = 0 if dataset == "BBBC039v1" else 1
    if set(selection) != {"x", "y", "width", "height", "c", "z", "t", "level"} or any(
        type(value) is not int for value in selection.values()
    ):
        raise ValueError("Full native integer selection required")
    if (
        selection["width"] < 1
        or selection["height"] < 1
        or selection["width"] * selection["height"] > 16_000_000
    ):
        raise ValueError("Native selection exceeds the bounded full-plane grid")
    if any(
        selection[key] != value
        for key, value in {
            "x": 0,
            "y": 0,
            "c": channel,
            "z": 0,
            "t": 0,
            "level": 0,
        }.items()
    ) or classical["measurement_channels"] != [channel]:
        raise ValueError("Classical source/measurement channel differs from protocol")
    runtime, limits = recipe.get("runtime", {}), recipe.get("limits", {})
    if set(runtime) != RUNTIME_KEYS or any(
        not isinstance(value, str) or not value for value in runtime.values()
    ):
        raise ValueError("Exact native runtime identity is required")
    if (
        set(limits) != {"cpu_seconds", "memory_bytes", "concurrency"}
        or any(type(value) is not int for value in limits.values())
        or limits["concurrency"] != 1
        or not 1 <= limits["cpu_seconds"] <= 86400
        or not 64 * 1024**2 <= limits["memory_bytes"] <= 8 * 1024**3
    ):
        raise ValueError(
            "Policy v4 limits must specify bounded CPU/memory and serial concurrency"
        )
    ring = recipe.get("perinuclear")
    if ring is not None and (
        dataset != "BBBC013v1"
        or set(ring) != {"signal_channel", "radius_px", "working_bytes", "control"}
        or type(ring.get("signal_channel")) is not int
        or ring["signal_channel"] != 0
        or type(ring.get("radius_px")) not in (int, float)
        or ring["radius_px"] != 5
        or not isinstance(ring.get("control"), str)
        or not ring["control"].strip()
    ):
        raise ValueError(
            "Perinuclear recipe must fix raw GFP0, radius5 and constant control"
        )
    for request in [classical, *([ring] if ring is not None else [])]:
        if (
            type(request["working_bytes"]) is not int
            or not 1024**2 <= request["working_bytes"] <= limits["memory_bytes"]
        ):
            raise ValueError("Request working memory exceeds its native policy limit")


def cli_call(worker, worker_sha, args, root):
    pinned(worker, worker_sha)
    index = len(list(root.glob("cli-*.stdout"))) + 1
    command = [str(worker), "--cli", *map(str, args)]
    stdout, stderr = root / f"cli-{index:03d}.stdout", root / f"cli-{index:03d}.stderr"
    event(root, "cli-request", command=command)
    with stdout.open("xb") as out, stderr.open("xb") as err:
        completed = subprocess.run(
            command, stdout=out, stderr=err, check=False, timeout=600
        )
    event(
        root,
        "cli-response",
        command=command,
        returncode=completed.returncode,
        stdout=identity(stdout),
        stderr=identity(stderr),
    )
    if completed.returncode:
        raise RuntimeError(
            f"Native CLI failed ({completed.returncode}); retained {stderr.name}"
        )
    return read_json(stdout)


@asynccontextmanager
async def native_session(worker, policy, root):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    with (root / "mcp.stderr").open("x") as error:
        parameters = StdioServerParameters(
            command=str(worker), args=["--cli", "mcp", "--policy", str(policy)]
        )
        async with (
            stdio_client(parameters, errlog=error) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            yield session


class MCP:
    def __init__(self, session, root, retries):
        self.session, self.root, self.retries = session, root, retries

    async def call(self, name, arguments):
        for attempt in range(self.retries + 1):
            event(
                self.root,
                "mcp-request",
                name=name,
                arguments=arguments,
                attempt=attempt,
            )
            try:
                response = await asyncio.wait_for(
                    self.session.call_tool(name, arguments), timeout=120
                )
            except (OSError, TimeoutError, ConnectionError) as error:
                event(
                    self.root,
                    "transport-failure",
                    name=name,
                    error=f"{type(error).__name__}: {error}",
                    attempt=attempt,
                )
                if attempt == self.retries:
                    raise
                continue
            document = response.model_dump(
                by_alias=True, mode="json", exclude_none=False
            )
            event(self.root, "mcp-response", name=name, response=document)
            if document.get("isError"):
                raise RuntimeError("Native MCP tool failed: " + json.dumps(document))
            value = document.get("structuredContent")
            if not isinstance(value, dict):
                texts = [
                    block["text"]
                    for block in document.get("content", [])
                    if block.get("type") == "text"
                ]
                value = json.loads(texts[0]) if len(texts) == 1 else None
            if not isinstance(value, dict):
                raise TypeError("Native MCP tool did not return an object")
            return value
        raise AssertionError("Unreachable transport retry state")


class UncertainJob(RuntimeError):
    """A possible active task prevents subsequent submissions."""


async def execute_action(mcp, operation, request, key, timeout, interval):
    validation = await mcp.call(
        "validate_action", {"operation": operation, "request": request}
    )
    if validation.get("authorized") is not True:
        raise ValueError("Native action validation did not authorize request")
    # A lost submit response can represent an active task; retry only the same key.
    try:
        submitted = await mcp.call(
            "submit_action",
            {"operation": operation, "request": request, "request_key": key},
        )
        job_id = submitted["job"]["id"]
        deadline = time.monotonic() + timeout
        while True:
            job = (await mcp.call("job_status", {"job_id": job_id}))["job"]
            if job.get("state") in TERMINAL and job.get("owned_worker_active") is False:
                break
            if time.monotonic() >= deadline:
                await mcp.call("cancel_job", {"job_id": job_id})
                raise UncertainJob(
                    "Job timeout; cancellation requested, termination not proven"
                )
            await asyncio.sleep(interval)
    except UncertainJob:
        raise
    except Exception as error:
        raise UncertainJob(
            f"Task may remain active; stop further submissions: {error}"
        ) from error
    if job["state"] != "succeeded":
        raise RuntimeError("Native task failed; no analysis retry: " + json.dumps(job))
    if len(job.get("result_ids", [])) != 1:
        raise ValueError("Expected exactly one native result")
    return await mcp.call(
        "result", {"result_id": job["result_ids"][0], "offset": 0, "limit": 100}
    )


def policy_spec(source, entry, recipe, exports):
    channels = [0] if recipe["dataset"] == "BBBC039v1" else [0, 1]
    selection = recipe["classical"]["selection"]
    return {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {key: selection[key] for key in ("x", "y", "width", "height")},
                "t": [0],
                "c": channels,
                "z": [0],
                "level": [0],
                "measurement_channels": channels,
            }
        ],
        "recipes": [],
        "operations": [
            "analysis_context",
            "inspect_source",
            "validate_action",
            "submit_action",
            "job_status",
            "cancel_job",
            "result",
            "review_history",
            "review_result",
            "export_result",
        ],
        "model_packages": [],
        "runtimes": [recipe["runtime"]],
        "export": {
            "root": str(exports),
            "filenames": ["nuclei", "perinuclear"],
            "filename_mode": "listed",
        },
        "limits": recipe["limits"],
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
        "delegation": {
            "id": "a" * 32,
            "client_id": "real-fluorescence-serial-runner",
            "expires_at": None,
            "result_scope": "granted-sources",
        },
        "actions": [
            "classical_run",
            *(["perinuclear_run"] if recipe.get("perinuclear") is not None else []),
        ],
    }


def inspect_bundle(directory, expected, source):
    manifest = read_json(directory / "manifest.json")
    if manifest.get("schema") != "loci.export-manifest/v1":
        raise ValueError("Native export manifest schema differs")
    names = set()
    for item in manifest["files"]:
        name = item["name"]
        if (
            Path(name).name != name
            or name in {".", ".."}
            or "\\" in name
            or name.casefold() in names
        ):
            raise ValueError("Native export member unsafe or duplicated")
        names.add(name.casefold())
        verify_record(
            {
                "path": str(directory / name),
                "sha256": item["sha256"],
                "bytes": item["size_bytes"],
            }
        )
    if not {"result.json", "labels.npy", "loci-export.json"} <= names:
        raise ValueError("Native export lacks required artifacts")
    payload = read_json(directory / "result.json")
    result = payload["result"]
    marker = read_json(directory / "loci-export.json")
    if (
        any(result.get(key) != expected[key] for key in ("id", "revision_hash"))
        or result.get("source_id") != source["id"]
        or result.get("source_sha256") != source["sha256"]
        or payload["source"].get("sha256") != source["sha256"]
        or payload["source"].get("id") != source["id"]
        or marker.get("schema") != "loci.export-marker/v1"
        or any(
            manifest.get(key) != result.get(native)
            or marker.get(key) != result.get(native)
            for key, native in (("result_id", "id"), ("revision_hash", "revision_hash"))
        )
    ):
        raise ValueError("Native export result/source differs from inspected revision")
    if {
        key: {field: descriptor.get(field) for field in ("shape", "dtype")}
        for key, descriptor in result["arrays"].items()
    } != {
        key: {field: descriptor.get(field) for field in ("shape", "dtype")}
        for key, descriptor in expected["arrays"].items()
    }:
        raise ValueError("Native export arrays differ from inspected descriptors")
    for name, descriptor in result["arrays"].items():
        if name + ".npy" not in names:
            raise ValueError("Native export array not listed in pinned manifest")
        verify_record(
            {
                "path": str(directory / (name + ".npy")),
                "sha256": descriptor["sha256"],
                "bytes": descriptor["bytes"],
            }
        )
    provenance = result["provenance"]
    return {
        "directory": str(directory),
        "manifest": identity(directory / "manifest.json"),
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "parent_id": result.get("parent_id"),
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "arrays": result["arrays"],
        "labels_npy": identity(directory / "labels.npy"),
        "native_provenance": {
            key: provenance[key]
            for key in (
                "accepted_request",
                "runtime",
                "selection",
                "geometry",
                "parent_result",
                "nucleus_analysis",
                "perinuclear",
                "resource_guard",
                "measurement_channels",
                "measurement_basis",
            )
            if key in provenance
        },
    }


async def review_export(mcp, value, name, source, exports, recipe):
    result = value["result"]
    shape = [recipe["classical"]["selection"][key] for key in ("height", "width")]
    expected_channel = recipe["classical"]["selection"]["c"] if name == "nuclei" else 0
    selection = {**recipe["classical"]["selection"], "c": expected_channel}
    arrays = result.get("arrays", {})
    if (
        result.get("source_id") != source["id"]
        or not {"image", "labels"} <= arrays.keys()
        or not re.fullmatch(r"[0-9a-f]{64}", result.get("revision_hash", ""))
        or result.get("selection") != selection
        or any(
            item.get("shape") != shape
            or item.get("dtype")
            not in {"uint8", "uint16", "uint32", "float32", "float64"}
            for item in arrays.values()
        )
        or arrays["labels"].get("dtype") != "uint32"
        or any(
            value.get("provenance", {}).get("runtime", {}).get(key) != expected
            for key, expected in recipe["runtime"].items()
        )
    ):
        raise ValueError("Native result lacks source/revision/array metadata")
    history = await mcp.call("review_history", {"result_id": result["id"]})
    await mcp.call(
        "review_result",
        {
            "request": {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "disposition": "reviewed",
                "expected_review_sha256": history["current_review_sha256"],
                "reason": REVIEW_REASON,
                "coverage": REVIEW_COVERAGE,
            }
        },
    )
    await mcp.call(
        "export_result",
        {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "filename": name,
        },
    )
    return inspect_bundle(exports / name, result, source)


async def run(args, *, cli=cli_call, session_factory=native_session):
    root = plain_path(args.output, absent=True)
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    records, pins = [], {}
    planned, failure = [], None
    event(
        root,
        "run-start",
        arguments={
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        driver=identity(Path(__file__).absolute()),
    )
    try:
        pins, planned, recipe = preflight(args)
        write_json(
            root / "inputs.json",
            {
                "pins": pins,
                "requested_recipe": recipe,
                "selected_keys": [key for key, _ in planned],
                "execution_identity_claim": "pinned candidate artifacts; launch/signature authority remains lead receipt"
                if args.mode == "qualification"
                else "exploratory pinned worker and code manifest; no frozen app claim",
            },
        )
        cli(args.worker, args.worker_sha256, ["discover"], root)
        for index, (key, entry) in enumerate(planned):
            field = root / f"field-{index:04d}"
            field.mkdir()
            record = {
                "source_key": key,
                "status": "started",
                "requested_classical": recipe["classical"],
                "requested_perinuclear": recipe.get("perinuclear"),
                "exports": [],
            }
            records.append(record)
            try:
                verify_record(entry["derived"])
                for original in (
                    [entry["source"]]
                    if args.dataset == "BBBC039v1"
                    else entry["sources"]
                ):
                    verify_record(original)
                project, exports = field / "study", field / "exports"
                exports.mkdir()
                cli(
                    args.worker,
                    args.worker_sha256,
                    [
                        "create",
                        "--project",
                        project,
                        "--title",
                        f"Real fluorescence {key}",
                    ],
                    field,
                )
                snapshot = cli(
                    args.worker,
                    args.worker_sha256,
                    [
                        "import",
                        "--project",
                        project,
                        "--kind",
                        "files",
                        entry["derived"]["path"],
                    ],
                    field,
                )
                imported = snapshot.get("sources", [])
                if (
                    len(imported) != 1
                    or imported[0].get("sha256") != entry["derived"]["sha256"]
                ):
                    raise ValueError(
                        "Native import did not preserve exact selected source identity"
                    )
                source = imported[0]
                record["source"] = {"id": source["id"], **entry["derived"]}
                specification, policy = (
                    field / "policy-specification.json",
                    field / "agent-policy.json",
                )
                write_json(specification, policy_spec(source, entry, recipe, exports))
                cli(
                    args.worker,
                    args.worker_sha256,
                    [
                        "policy",
                        "--project",
                        project,
                        "--destination",
                        policy,
                        "--specification",
                        "@" + str(specification),
                    ],
                    field,
                )
                if read_json(policy).get("schema") != "loci.agent-policy/v4":
                    raise ValueError("Native policy generation did not produce v4")
                record["policy"] = identity(policy)
                pinned(args.worker, args.worker_sha256)
                async with session_factory(args.worker, policy, field) as session:
                    tools = await session.list_tools()
                    event(
                        field,
                        "mcp-tools",
                        tools=tools.model_dump(
                            by_alias=True, mode="json", exclude_none=False
                        ),
                    )
                    mcp = MCP(session, field, args.transport_retries)
                    await mcp.call("catalog", {})
                    for operation in (
                        "classical_run",
                        *(
                            ["perinuclear_run"]
                            if recipe.get("perinuclear") is not None
                            else []
                        ),
                    ):
                        guide = await mcp.call("action_guide", {"operation": operation})
                        if not any(
                            item.get("operation") == operation
                            and isinstance(item.get("request_schema"), dict)
                            for item in guide.get("actions", [])
                        ):
                            raise ValueError(
                                "Native action guide does not expose requested schema"
                            )
                    classical = {**recipe["classical"], "source_id": source["id"]}
                    parent = await execute_action(
                        mcp,
                        "classical_run",
                        classical,
                        f"field-{index:04d}-classical",
                        args.job_timeout_seconds,
                        args.poll_seconds,
                    )
                    record["exports"].append(
                        await review_export(
                            mcp, parent, "nuclei", source, exports, recipe
                        )
                    )
                    if recipe.get("perinuclear") is not None:
                        target = parent["result"]
                        request = {
                            **recipe["perinuclear"],
                            "result_id": target["id"],
                            "revision_hash": target["revision_hash"],
                        }
                        child = await execute_action(
                            mcp,
                            "perinuclear_run",
                            request,
                            f"field-{index:04d}-perinuclear",
                            args.job_timeout_seconds,
                            args.poll_seconds,
                        )
                        record["exports"].append(
                            await review_export(
                                mcp, child, "perinuclear", source, exports, recipe
                            )
                        )
                record["status"] = "native-execution-complete; no qualification outcome"
            except Exception as error:
                record.update(status="failed", error=f"{type(error).__name__}: {error}")
                event(field, "field-failure", error=record["error"])
                if isinstance(
                    error, (UncertainJob, OSError, TimeoutError, ConnectionError)
                ):
                    raise
            finally:
                write_json(field / "receipt.json", record)
        status = (
            "completed"
            if all(
                record["status"].startswith("native-execution-complete")
                for record in records
            )
            else "failed"
        )
    except Exception as error:  # noqa: BLE001 - retain all startup/identity/transport failures as evidence.
        status = "failed"
        failure = f"{type(error).__name__}: {error}"
        event(root, "run-failure", error=failure)
        for key, _ in planned[len(records) :]:
            records.append(
                {
                    "source_key": key,
                    "status": "not-run",
                    "reason": "Earlier failure stopped safe serial execution",
                }
            )
    receipt = {
        "schema": "loci.real-fluorescence.execution-receipt/v1",
        "status": status,
        "mode": args.mode,
        "error": failure,
        "pins": pins,
        "fields": records,
        "review_actor": "agent",
        "review_reason": REVIEW_REASON,
        "review_coverage": REVIEW_COVERAGE,
        "qualification_outcomes_computed": False,
    }
    write_json(root / "run-receipt.json", receipt)
    return receipt


def main():
    args = parser().parse_args()
    receipt = asyncio.run(run(args))
    print(
        json.dumps(
            {
                "status": receipt["status"],
                "receipt": str(args.output / "run-receipt.json"),
            },
            sort_keys=True,
        )
    )
    return 0 if receipt["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
