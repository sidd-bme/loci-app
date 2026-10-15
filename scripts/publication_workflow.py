#!/usr/bin/env python3
"""Bounded source-level reproduction; no data/model download without explicit opt-in.

The oracle implements only the declared 2D raw bright-component demonstration.
It never calls Loci numerical code, scipy.label, or a segmentation library.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import select
import subprocess
import sys
import time
import traceback
from collections import deque
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine" / "src"
PUBLIC_SHA256 = "8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515"
PUBLIC_BYTES = 74183
PUBLIC_URL = (
    "https://gitlab.com/scikit-image/data/-/raw/"
    "5c090b56df3988d988ff97928e2ef2d2cbe38e1b/cell.png"
)
ATOL = 1e-9
RTOL = 1e-12
TIMEOUT = 90


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def environment(*, frozen: bool = False) -> dict[str, str]:
    result = {**os.environ, "PYTHONPATH": str(ENGINE)}
    if frozen:
        result.pop("PYTHONPATH", None)
    return result


def oracle(
    image: Any,
    spacing_yx: tuple[float, float],
    threshold: float,
    min_area: float,
    exclude_border: bool = False,
) -> tuple[Any, list[dict[str, Any]]]:
    """Row-major 4-neighbour BFS, then independent integer/sample formulas."""
    import numpy as np

    require(
        image.ndim == 2 and image.dtype == np.uint8, "Oracle requires 2D uint8 samples"
    )
    sy, sx = spacing_yx
    require(all(math.isfinite(s) and s > 0 for s in spacing_yx), "Invalid spacing")
    h, w = image.shape
    seen = bytearray(h * w)
    labels = np.zeros((h, w), dtype=np.uint32)
    rows = []
    for y in range(h):
        for x in range(w):
            start = y * w + x
            if seen[start] or int(image[y, x]) <= threshold:
                continue
            seen[start] = 1
            queue = deque([(y, x)])
            points = []
            while queue:
                cy, cx = queue.popleft()
                points.append((cy, cx))
                for ny, nx in ((cy - 1, cx), (cy, cx - 1), (cy, cx + 1), (cy + 1, cx)):
                    if (
                        0 <= ny < h
                        and 0 <= nx < w
                        and not seen[ny * w + nx]
                        and int(image[ny, nx]) > threshold
                    ):
                        seen[ny * w + nx] = 1
                        queue.append((ny, nx))
            border = any(py in (0, h - 1) or px in (0, w - 1) for py, px in points)
            n = len(points)
            if n * sy * sx < min_area or (exclude_border and border):
                continue
            label = len(rows) + 1
            for py, px in points:
                labels[py, px] = label
            ys, xs = [p[0] for p in points], [p[1] for p in points]
            values = [int(image[p]) for p in points]
            mean = sum(values) / n
            center = [sum(ys) / n, sum(xs) / n]
            rows.append(
                {
                    "label": label,
                    "voxel_count": n,
                    "measure": n * sy * sx,
                    "measure_kind": "area",
                    "measure_unit": "um^2",
                    "index_axes": "YX",
                    "centroid_index": center,
                    "centroid_world_xyz": [center[1] * sx, center[0] * sy, 0.0],
                    "world_frame": "image",
                    "distance_unit": "um",
                    "bbox_start": [min(ys), min(xs)],
                    "bbox_stop_exclusive": [max(ys) + 1, max(xs) + 1],
                    "touches_crop_border": border,
                    "raw_intensity": {
                        "mean": mean,
                        "sum": sum(values),
                        "min": min(values),
                        "max": max(values),
                        "std_population": math.sqrt(
                            sum((v - mean) ** 2 for v in values) / n
                        ),
                    },
                }
            )
    for row in rows:
        center = row["centroid_world_xyz"]
        distances = [
            math.dist(center, other["centroid_world_xyz"])
            for other in rows
            if other["label"] != row["label"]
        ]
        row["nearest_centroid_distance"] = min(distances) if distances else None
    return labels, rows


def synthetic() -> Any:
    import numpy as np

    y, x = np.indices((48, 64))
    image = ((3 * y + 5 * x) % 61).astype(np.uint8)
    image[0:5, 1:8] = 180  # retained crop-border component
    image[8:19, 8:22] = (150 + (y[8:19, 8:22] + x[8:19, 8:22]) % 80).astype(np.uint8)
    image[11:16, 12:18] = 20  # actual hole
    image[25:29, 30:34] = 210
    image[29:33, 34:38] = 230  # diagonal contact must remain separate
    image[36:44, 46:59] = (160 + x[36:44, 46:59] % 71).astype(np.uint8)
    image[38:41, 50:54] = 30
    image[23, 4] = 220  # removed by physical minimum area
    image[22, 60] = 120  # strict threshold excludes equality
    return image


def write_fixture(path: Path, image: Any, spacing_yx: tuple[float, float]) -> None:
    """Authored fixed OME metadata, avoiding generated UUIDs, dates and file names."""
    import tifffile

    h, w = image.shape
    sy, sx = spacing_yx
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<Image ID="Image:0" Name="Declared reproduction samples">'
        '<Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint8" '
        f'SizeX="{w}" SizeY="{h}" SizeC="1" SizeZ="1" SizeT="1" '
        f'PhysicalSizeX="{sx}" PhysicalSizeXUnit="µm" '
        f'PhysicalSizeY="{sy}" PhysicalSizeYUnit="µm">'
        '<Channel ID="Channel:0:0" Name="Encoded sample values" SamplesPerPixel="1"/>'
        '<TiffData IFD="0" PlaneCount="1"/></Pixels></Image></OME>'
    )
    # TIFF ImageDescription is ASCII; OME numeric entities preserve the unit.
    xml = xml.replace("µ", "&#181;")
    tifffile.imwrite(
        path,
        image,
        description=xml,
        metadata=None,
        photometric="minisblack",
        compression=None,
        software="Loci publication fixture/v1",
        datetime=None,
    )


def public_image(path: Path) -> Any:
    import numpy as np
    from PIL import Image

    require(
        path.is_file() and not path.is_symlink(), "Public input must be a plain file"
    )
    require(path.stat().st_size == PUBLIC_BYTES, "Public input byte count mismatch")
    require(digest(path.read_bytes()) == PUBLIC_SHA256, "Public input SHA256 mismatch")
    with Image.open(path) as decoded:
        image = np.asarray(decoded)
    require(
        image.shape == (660, 550) and image.dtype == np.uint8,
        "Public input must be exactly 660Y x 550X uint8",
    )
    return image


def compare_value(actual: Any, expected: Any, field: str) -> None:
    if isinstance(expected, dict):
        require(
            isinstance(actual, dict) and set(actual) == set(expected),
            f"{field}: keys differ",
        )
        for key in expected:
            compare_value(actual[key], expected[key], f"{field}.{key}")
    elif isinstance(expected, list):
        require(
            isinstance(actual, list) and len(actual) == len(expected),
            f"{field}: length differs",
        )
        for index, value in enumerate(expected):
            compare_value(actual[index], value, f"{field}[{index}]")
    elif isinstance(expected, float):
        require(
            isinstance(actual, (int, float))
            and math.isfinite(actual)
            and abs(actual - expected) <= ATOL + RTOL * abs(expected),
            f"{field}: {actual!r} != {expected!r}",
        )
    else:
        require(actual == expected, f"{field}: {actual!r} != {expected!r}")


def check_rows(actual: list[dict[str, Any]], expected: list[dict[str, Any]]) -> None:
    require(len(actual) == len(expected), "Object count differs from oracle")
    for row, reference in zip(actual, expected, strict=True):
        require(
            len(row["intensity"]) == 1,
            "Expected one encoded-sample measurement channel",
        )
        for key, value in reference.items():
            measured = (
                next(iter(row["intensity"].values()))
                if key == "raw_intensity"
                else row[key]
            )
            compare_value(measured, value, f"object[{reference['label']}].{key}")


class Runner:
    def __init__(self, output: Path, frozen_worker: Path | None = None):
        self.output = output
        self.frozen_worker = frozen_worker
        self.calls: list[dict[str, Any]] = []
        self.negatives: list[dict[str, Any]] = []

    def process(
        self, args: list[str], *, deny: bool = False, frozen: bool = False
    ) -> Any:
        start = time.monotonic()
        executable = str(self.frozen_worker) if frozen else sys.executable
        result = subprocess.run(
            [executable, *args],
            capture_output=True,
            text=True,
            env=environment(frozen=frozen),
            timeout=TIMEOUT,
            cwd=ROOT,
            check=False,
        )
        index = len(self.calls)
        (self.output / f"process-{index:03d}.stdout.txt").write_text(result.stdout)
        (self.output / f"process-{index:03d}.stderr.txt").write_text(result.stderr)
        self.calls.append(
            {
                "transport": "process",
                "executable": executable,
                "argv": args,
                "elapsed_seconds": time.monotonic() - start,
                "exit_code": result.returncode,
            }
        )
        if deny:
            require(result.returncode != 0, "Expected process denial, got success")
            value = json.loads(result.stderr)
            require(isinstance(value.get("error"), dict), "Missing structured denial")
            require(
                "Review" in value["error"].get("message", ""),
                "Unrelated export failure",
            )
            self.negatives.append(
                {
                    "case": "unreviewed-export",
                    "transport": "cli",
                    "error": value["error"],
                }
            )
            return value
        require(
            result.returncode == 0,
            f"Process failed ({result.returncode}); inspect process-{index:03d}",
        )
        return json.loads(result.stdout)

    def cli(self, *args: str, deny: bool = False) -> Any:
        if self.frozen_worker:
            return self.process(["--cli", *args], deny=deny, frozen=True)
        return self.process(["-m", "loci_engine.research_cli", *args], deny=deny)


class RPC:
    def __init__(self, runner: Runner, directory: Path):
        self.runner = runner
        self.log = (directory / f"worker-{len(runner.calls):03d}.stderr.txt").open("w")
        self.process = subprocess.Popen(
            [str(runner.frozen_worker)]
            if runner.frozen_worker
            else [sys.executable, "-m", "loci_engine.worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
            bufsize=1,
            env=environment(frozen=bool(runner.frozen_worker)),
            cwd=ROOT,
        )
        self.index = 0

    def call(self, method: str, params: dict[str, Any], *, deny: bool = False) -> Any:
        self.index += 1
        start = time.monotonic()
        require(
            self.process.stdin is not None and self.process.stdout is not None,
            "Worker pipes unavailable",
        )
        self.process.stdin.write(
            canonical({"id": self.index, "method": method, "params": params}) + "\n"
        )
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], TIMEOUT)
        require(bool(ready), "Worker RPC timed out")
        line = self.process.stdout.readline()
        require(bool(line), "Worker exited without response")
        value = json.loads(line)
        require(value.get("id") == self.index, "Worker response ID mismatch")
        self.runner.calls.append(
            {
                "transport": "worker-json-lines",
                "method": method,
                "elapsed_seconds": time.monotonic() - start,
                "denied": "error" in value,
            }
        )
        if deny:
            require("error" in value, "Expected worker denial, got success")
            require(
                "Review" in value["error"].get("message", ""),
                "Unrelated worker export failure",
            )
            self.runner.negatives.append(
                {
                    "case": "unreviewed-export",
                    "transport": "worker",
                    "error": value["error"],
                }
            )
            return value
        require("error" not in value, f"Worker operation failed: {value.get('error')}")
        return value["result"]

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.log.close()


def request_for(
    source_id: str, shape: tuple[int, int], min_area: float
) -> dict[str, Any]:
    return {
        "source_id": source_id,
        "selection": {
            "x": 0,
            "y": 0,
            "width": shape[1],
            "height": shape[0],
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "recipe": {
            "steps": [],
            "segmentation": {
                "method": "components",
                "threshold": 120,
                "min_size": min_area,
                "polarity": "bright",
                "exclude_border": False,
            },
            "measurement_channels": [0],
            "gates": [],
            "working_bytes": 128 * 1024**2,
        },
    }


def policy_for(
    project: Any, source: dict[str, Any], validation: dict[str, Any], root: Path
) -> dict[str, Any]:
    from loci_engine.agent_policy import write_policy
    from loci_engine.workbench import runtime_record

    runtime = runtime_record()
    selected = validation["selection"]
    spec = {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {k: selected[k] for k in ("x", "y", "width", "height")},
                "t": [0],
                "c": [0],
                "z": [0],
                "level": [0],
                "measurement_channels": [0],
            }
        ],
        "recipes": [
            {"sha256": validation["recipe_sha256"], "preview": True, "run": True}
        ],
        "operations": [
            "validate_recipe",
            "preview_recipe",
            "submit_recipe",
            "job_status",
            "result",
            "export_result",
        ],
        "model_packages": [],
        "runtimes": [
            {
                key: runtime[key]
                for key in (
                    "engine",
                    "numpy",
                    "scipy",
                    "scikit_image",
                    "backend",
                    "resolved_device",
                )
            }
        ],
        "export": {
            "root": str(root / "exports"),
            "filenames": ["demonstration-export"],
        },
        "limits": {"cpu_seconds": 60, "memory_bytes": 512 * 1024**2, "concurrency": 1},
        "disclosures": [
            "geometry",
            "source_names",
            "measurements",
            "provenance",
            "previews",
            "agent_metadata",
        ],
    }
    return write_policy(root / "policy.json", project, spec)


async def mcp_run(
    runner: Runner,
    root: Path,
    request: dict[str, Any],
    *,
    reopen_id: str | None = None,
    simulate_review: bool = False,
) -> dict[str, Any]:
    from mcp.client.session import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(
        command=str(runner.frozen_worker) if runner.frozen_worker else sys.executable,
        args=(["--cli"] if runner.frozen_worker else ["-m", "loci_engine.research_cli"])
        + ["mcp", "--policy", str(root / "policy.json")],
        env=environment(frozen=bool(runner.frozen_worker)),
        cwd=str(ROOT),
    )
    with (root / ("mcp-reopen.stderr.txt" if reopen_id else "mcp.stderr.txt")).open(
        "w"
    ) as log:
        async with (
            stdio_client(params, errlog=log) as streams,
            ClientSession(*streams) as session,
        ):
            await asyncio.wait_for(session.initialize(), TIMEOUT)
            names = sorted(
                tool.name
                for tool in (
                    await asyncio.wait_for(session.list_tools(), TIMEOUT)
                ).tools
            )
            require(
                not any(
                    "review" in name and name != "preview_recipe" for name in names
                ),
                "MCP unexpectedly exposes review authority",
            )
            if not reopen_id:
                runner.negatives.append(
                    {
                        "case": "no-review-tool",
                        "transport": "mcp-sdk-stdio",
                        "discovered_tools": names,
                    }
                )

            async def call(
                name: str,
                args: dict[str, Any],
                *,
                deny: bool = False,
                case: str | None = None,
            ) -> Any:
                start = time.monotonic()
                value = await asyncio.wait_for(session.call_tool(name, args), TIMEOUT)
                runner.calls.append(
                    {
                        "transport": "mcp-sdk-stdio",
                        "tool": name,
                        "elapsed_seconds": time.monotonic() - start,
                        "denied": bool(value.is_error),
                    }
                )
                if deny:
                    require(
                        bool(value.is_error), f"Expected MCP {name} denial, got success"
                    )
                    runner.negatives.append(
                        {
                            "case": case or name,
                            "transport": "mcp-sdk-stdio",
                            "content": [
                                item.text
                                for item in value.content
                                if hasattr(item, "text")
                            ],
                        }
                    )
                    return None
                require(not value.is_error, f"MCP {name} failed: {value.content}")
                if value.structured_content is not None:
                    return value.structured_content
                text = [item.text for item in value.content if hasattr(item, "text")]
                require(len(text) == 1, "Missing MCP structured/JSON result")
                return json.loads(text[0])

            if reopen_id:
                value = await call("result", {"result_id": reopen_id, "limit": 1000})
                return {
                    "result": value["result"],
                    "tools": names,
                    "measurements": value["measurements"],
                    "total_rows": value["total_rows"],
                }
            await call("catalog", {})
            validation = await call("validate_recipe", {"request": request})
            altered = json.loads(canonical(request))
            altered["recipe"]["segmentation"]["threshold"] = 121
            await call(
                "submit_recipe",
                {"request": altered, "request_key": "denied-recipe"},
                deny=True,
                case="out-of-scope-recipe",
            )
            submitted = await call(
                "submit_recipe", {"request": request, "request_key": "reproduction"}
            )
            job_id = submitted["job"]["id"]
            deadline = time.monotonic() + TIMEOUT
            while True:
                job = (await call("job_status", {"job_id": job_id}))["job"]
                if job["state"] not in {"queued", "running"}:
                    break
                require(time.monotonic() < deadline, "MCP durable job timed out")
                await asyncio.sleep(0.1)
            require(
                job["state"] == "succeeded" and len(job["result_ids"]) == 1,
                f"MCP job did not succeed: {job}",
            )
            value = await call(
                "result", {"result_id": job["result_ids"][0], "limit": 1000}
            )
            result = value["result"]
            export_args = {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "filename": "demonstration-export",
            }
            await call(
                "export_result", export_args, deny=True, case="unreviewed-export"
            )
            if simulate_review:
                runner.cli(
                    "review",
                    "--project",
                    str(root / "study.loci-study"),
                    "--result",
                    result["id"],
                    "--revision",
                    result["revision_hash"],
                    "--disposition",
                    "reviewed",
                )
                await call("export_result", export_args)
            policy = root / "policy.json"
            replacement = root / "replacement-policy.json"
            replacement.write_bytes(policy.read_bytes())
            replacement.chmod(0o600)
            os.replace(
                replacement, policy
            )  # same bytes, different inode: must revoke live server
            await call("catalog", {}, deny=True, case="policy-replacement-revocation")
            return {
                "result": result,
                "validation": validation,
                "tools": names,
                "job": job,
                "policy_replacement": "identical bytes; different inode",
            }


def inspect_persisted(study: Path, result_id: str, destination: Path) -> dict[str, Any]:
    """Executed by a fresh interpreter, using production integrity-checked reads."""
    import numpy as np
    from loci_engine.research_project import ResearchProject

    project = ResearchProject(study)
    require(
        len(project.list_results()) == 1,
        "Expected exactly one published result per interface",
    )
    result = project.result(result_id)
    source = project.source(result["source_id"], verify=True)
    labels = project.load_array(result["arrays"]["labels"])
    raw = project.load_array(result["arrays"]["image"])
    np.save(destination / "labels.npy", labels, allow_pickle=False)
    np.save(destination / "image.npy", raw, allow_pickle=False)
    write_json(destination / "persisted-result.json", result)
    return {
        "source_sha256": source["sha256"],
        "revision_hash": result["revision_hash"],
        "review": project.review_state(result_id),
    }


def verify_result(
    runner: Runner,
    root: Path,
    result: dict[str, Any],
    image: Any,
    spacing: tuple[float, float],
    expected_labels: Any,
    expected_rows: list[dict[str, Any]],
    fixture_hash: str,
) -> dict[str, Any]:
    import numpy as np

    inspection = runner.process(
        [
            str(Path(__file__).resolve()),
            "--inspect-study",
            str(root / "study.loci-study"),
            "--result-id",
            result["id"],
            "--inspection-output",
            str(root),
        ]
    )
    require(
        inspection["revision_hash"] == result["revision_hash"], "Cold revision changed"
    )
    require(inspection["source_sha256"] == fixture_hash, "Cold source changed")
    labels = np.load(root / "labels.npy", allow_pickle=False)
    require(
        labels.dtype == np.uint32 and np.array_equal(labels, expected_labels),
        "Native uint32 labels differ from independent oracle",
    )
    np.testing.assert_array_equal(
        np.load(root / "image.npy", allow_pickle=False), image
    )
    stored = json.loads((root / "persisted-result.json").read_text())
    provenance = stored["provenance"]
    rows = provenance["measurements"]
    live = json.loads((root / "cold-interface-result.json").read_text())
    require(
        live["total_rows"] == len(rows) and live["measurements"] == rows,
        "Cold interface measurement response differs from persisted native state",
    )
    require(
        result["object_count"] == len(expected_rows), "Interface object count mismatch"
    )
    check_rows(rows, expected_rows)
    require(
        inspection["review"] is None
        or inspection["review"]["disposition"] == "reviewed",
        "Unexpected review state",
    )
    exported = root / "exports" / "demonstration-export"
    if exported.exists():
        import tifffile

        require(
            inspection["review"] is not None, "Export exists without simulated review"
        )
        np.testing.assert_array_equal(
            tifffile.imread(exported / "labels.ome.tif"), labels
        )
        np.testing.assert_array_equal(
            tifffile.imread(exported / "image.ome.tif"), image
        )
        manifest = json.loads((exported / "manifest.json").read_text())
        for item in manifest["files"]:
            content = (exported / item["name"]).read_bytes()
            require(
                len(content) == item["size_bytes"]
                and digest(content) == item["sha256"],
                "Simulated-review export manifest mismatch",
            )
    geometry = provenance["geometry"]
    require(
        geometry["axes"] == "YX"
        and geometry["unit"] == "um"
        and geometry["frame"] == "image",
        "Calibration unit/axes/frame mismatch",
    )
    sy, sx = spacing
    compare_value(
        geometry["affine"],
        [
            [sx, 0.0, 0.0, 0.0],
            [0.0, sy, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        "affine",
    )
    identity = {
        "source_sha256": fixture_hash,
        "recipe": provenance["recipe"],
        "recipe_sha256": provenance["recipe_sha256"],
        "runtime": provenance["runtime"],
        "geometry": geometry,
        "selection": provenance["selection"],
        "measurement_basis": provenance["measurement_basis"],
    }
    require(
        digest(canonical(identity["recipe"]).encode()) == identity["recipe_sha256"],
        "Recipe hash disagrees with normalized recipe",
    )
    return {
        "object_count": len(rows),
        "labels_sample_sha256": digest(labels.astype("<u4").tobytes()),
        "labels_artifact_sha256": stored["arrays"]["labels"]["sha256"],
        "measurements_sha256": digest(canonical(rows).encode()),
        "normalized_identity": identity,
        "revision_hash": result["revision_hash"],
        "result_id": result["id"],
        "cold_reopen": inspection,
        "oracle": "exact labels/count; formula-based measurements",
    }


def interface_run(
    runner: Runner,
    name: str,
    root: Path,
    fixture: Path,
    image: Any,
    min_area: float,
    simulate_review: bool,
) -> dict[str, Any]:
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    root.mkdir()
    (root / "exports").mkdir()
    study = root / "study.loci-study"
    start = time.monotonic()
    if name == "direct":
        workbench = Workbench(ResearchProject.create(study, "Reproduction direct"))
        try:
            source = workbench.import_native(str(fixture))
            request = request_for(source["id"], image.shape, min_area)
            validation = workbench.validate_recipe(request)
            result = workbench.run_recipe(request)["result"]
            from loci_engine.research_export import export_research_result

            try:
                export_research_result(
                    workbench.project,
                    result["id"],
                    result["revision_hash"],
                    root / "exports" / "denied",
                )
            except ValueError as exc:
                require(
                    "Review" in str(exc), "Direct export failed for unrelated reason"
                )
                runner.negatives.append(
                    {
                        "case": "unreviewed-export",
                        "transport": "direct",
                        "error": str(exc),
                    }
                )
            else:
                raise ValueError("Unreviewed direct export unexpectedly succeeded")
        finally:
            workbench.close()
        reopened = runner.cli(
            "execute",
            "--project",
            str(study),
            "result",
            "--request",
            canonical({"result_id": result["id"], "limit": 1000}),
        )
        require(
            reopened["result"]["revision_hash"] == result["revision_hash"],
            "Direct reopen differs",
        )
        live = reopened
    elif name in {"cli", "mcp"}:
        runner.cli("create", "--project", str(study), "--title", f"Reproduction {name}")
        source = runner.cli("import", "--project", str(study), str(fixture))["sources"][
            0
        ]
        request = request_for(source["id"], image.shape, min_area)
        validation = runner.cli(
            "execute",
            "--project",
            str(study),
            "validate_recipe",
            "--request",
            canonical(request),
        )
        if name == "mcp":
            policy = policy_for(ResearchProject(study), source, validation, root)
            value = asyncio.run(
                mcp_run(runner, root, request, simulate_review=simulate_review)
            )
            result = value["result"]
            require(
                value["validation"]["recipe_sha256"] == validation["recipe_sha256"],
                "MCP normalized recipe differs",
            )
            cold = asyncio.run(mcp_run(runner, root, request, reopen_id=result["id"]))
            require(
                cold["result"]["revision_hash"] == result["revision_hash"],
                "MCP cold reopen differs",
            )
            write_json(
                root / "mcp-evidence.json",
                {**value, "policy": policy, "cold_reopen": cold},
            )
            # MCP summary omits object count even with measurement disclosure.
            result["object_count"] = cold["total_rows"]
            live = cold
        else:
            value = runner.cli(
                "submit",
                "--project",
                str(study),
                "--request",
                canonical(request),
                "--request-key",
                "reproduction",
                "--run",
            )
            result = value["result"]
            runner.cli(
                "export",
                "--project",
                str(study),
                "--result",
                result["id"],
                "--revision",
                result["revision_hash"],
                "--destination",
                str(root / "exports" / "denied"),
                deny=True,
            )
            live = runner.cli(
                "execute",
                "--project",
                str(study),
                "result",
                "--request",
                canonical({"result_id": result["id"], "limit": 1000}),
            )
    elif name == "worker":
        rpc = RPC(runner, root)
        try:
            rpc.call(
                "research_create", {"path": str(study), "title": "Reproduction worker"}
            )
            source = rpc.call(
                "research_import",
                {"project": str(study), "kind": "files", "paths": [str(fixture)]},
            )["sources"][0]
            request = request_for(source["id"], image.shape, min_area)
            validation = rpc.call(
                "research_execute",
                {
                    "project": str(study),
                    "operation": "validate_recipe",
                    "request": request,
                },
            )
            job = rpc.call(
                "research_submit",
                {
                    "project": str(study),
                    "request": request,
                    "request_key": "reproduction",
                    "operation": "run_recipe",
                },
            )
            result = rpc.call(
                "research_run", {"project": str(study), "job_id": job["id"]}
            )["result"]
            rpc.call(
                "research_export",
                {
                    "project": str(study),
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "destination": str(root / "exports" / "denied"),
                },
                deny=True,
            )
        finally:
            rpc.close()
        cold = RPC(runner, root)
        try:
            restored = cold.call(
                "research_execute",
                {
                    "project": str(study),
                    "operation": "result",
                    "request": {"result_id": result["id"], "limit": 1000},
                },
            )
            require(
                restored["result"]["revision_hash"] == result["revision_hash"],
                "Worker cold reopen differs",
            )
            live = restored
        finally:
            cold.close()
    else:
        raise ValueError("Unknown interface")
    require(
        not (root / "exports" / "denied").exists(),
        "Denied export left a published directory",
    )
    if simulate_review and name != "mcp":
        runner.cli(
            "review",
            "--project",
            str(study),
            "--result",
            result["id"],
            "--revision",
            result["revision_hash"],
            "--disposition",
            "reviewed",
        )
        runner.cli(
            "export",
            "--project",
            str(study),
            "--result",
            result["id"],
            "--revision",
            result["revision_hash"],
            "--destination",
            str(root / "exports" / "demonstration-export"),
        )
    if not simulate_review:
        require(
            live["result"]["review"] is None and not list((root / "exports").iterdir()),
            "Default reproduction must leave unreviewed results and no published export",
        )
    write_json(root / "validation.json", validation)
    write_json(root / "cold-interface-result.json", live)
    runner.calls.append(
        {
            "transport": name,
            "phase": "create-import-run-deny-reopen",
            "elapsed_seconds": time.monotonic() - start,
            "interpretation": "observed elapsed time; not a ranking or benchmark",
        }
    )
    return result


def source_identity() -> dict[str, Any]:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip()

    tracked = sorted(
        str(path.relative_to(ROOT))
        for path in ENGINE.rglob("*.py")
        if not path.name.startswith("._")
    )
    tracked.extend(["engine/pyproject.toml", "engine/uv.lock"])
    hashes = {
        path: digest((ROOT / path).read_bytes())
        for path in tracked
        if (ROOT / path).is_file()
    }
    return {
        "commit": git("rev-parse", "HEAD"),
        "status": git("status", "--short"),
        "engine_files": hashes,
        "engine_tree_sha256": digest(canonical(hashes).encode()),
        "harness_sha256": digest(Path(__file__).read_bytes()),
        "python": platform.python_version(),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "packages": {
            name: importlib.metadata.version(name)
            for name in (
                "loci-engine",
                "numpy",
                "scipy",
                "scikit-image",
                "tifffile",
                "pillow",
                "mcp",
            )
        },
    }


def run(args: argparse.Namespace, receipt: dict[str, Any]) -> None:
    import loci_engine.workbench as production
    import numpy as np

    require(
        Path(production.__file__).resolve().is_relative_to(ENGINE),
        "Wrong engine source imported",
    )
    receipt["source_identity"] = source_identity()
    fixtures = [
        (
            "synthetic",
            synthetic(),
            (0.75, 0.5),
            1.5,
            {
                "meaning": "authored geometric regression, not tissue or biological truth",
                "calibration": "authored Y=0.75 um/pixel, X=0.5 um/pixel",
            },
        )
    ]
    if args.fetch_public_cell:
        from urllib.request import urlopen

        target = args.output / "cell.png"
        with urlopen(PUBLIC_URL, timeout=30) as response:
            content = response.read(PUBLIC_BYTES + 1)
        require(
            len(content) == PUBLIC_BYTES and digest(content) == PUBLIC_SHA256,
            "Downloaded public fixture identity mismatch",
        )
        target.write_bytes(content)
        args.public_cell = target
    if args.public_cell:
        fixtures.append(
            (
                "public-cell",
                public_image(args.public_cell),
                (0.107, 0.107),
                10.0,
                {
                    "input_sha256": PUBLIC_SHA256,
                    "input_bytes": PUBLIC_BYTES,
                    "pinned_url": PUBLIC_URL,
                    "licence": "CC0",
                    "credit": "Paul Müller et al., Optics Express 2018, DOI 10.1364/OE.26.010729",
                    "source": "https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.cell",
                    "calibration": "documented 0.107 um/pixel; explicitly authored into OME",
                    "meaning": "encoded uint8 phase-image sample values, not physical phase units",
                    "claim": "declared threshold demonstration; no segmentation accuracy claim",
                },
            )
        )
    runner = Runner(args.output, args.frozen_worker)
    if args.frozen_worker:
        receipt["frozen_worker"] = {
            "path": str(args.frozen_worker),
            "sha256": digest(args.frozen_worker.read_bytes()),
            "scope": "CLI, JSON-lines worker and MCP use this frozen executable; direct engine and independent oracle use source Python.",
        }
    receipt["calls"] = runner.calls
    receipt["negative_cases"] = runner.negatives
    receipt["fixtures"] = []
    for name, image, spacing, min_area, provenance in fixtures:
        root = args.output / name
        root.mkdir()
        fixture = root / "source.ome.tif"
        duplicate = root / "determinism-check.ome.tif"
        write_fixture(fixture, image, spacing)
        write_fixture(duplicate, image, spacing)
        require(
            fixture.read_bytes() == duplicate.read_bytes(),
            "OME fixture generation is not deterministic",
        )
        fixture_hash = digest(fixture.read_bytes())
        labels, rows = oracle(image, spacing, 120, min_area)
        require(
            len(rows) <= 1000,
            "Declared demonstration exceeds the bounded 1000-row response",
        )
        np.save(root / "oracle-labels.npy", labels, allow_pickle=False)
        write_json(root / "oracle-measurements.json", rows)
        fixture_receipt = {
            "name": name,
            "source_sha256": fixture_hash,
            "sample_sha256": digest(image.tobytes()),
            "shape_yx": list(image.shape),
            "dtype": str(image.dtype),
            "spacing_yx_um": list(spacing),
            "threshold": 120,
            "min_area_um2": min_area,
            "oracle_object_count": len(rows),
            "provenance": provenance,
            "interfaces": {},
        }
        receipt["fixtures"].append(fixture_receipt)
        for interface in ("direct", "cli", "worker", "mcp"):
            interface_root = root / interface
            result = interface_run(
                runner,
                interface,
                interface_root,
                fixture,
                image,
                min_area,
                args.simulate_operator_review,
            )
            evidence = verify_result(
                runner,
                interface_root,
                result,
                image,
                spacing,
                labels,
                rows,
                fixture_hash,
            )
            fixture_receipt["interfaces"][interface] = evidence
            if interface != "direct":
                baseline = fixture_receipt["interfaces"]["direct"]
                for field in (
                    "labels_sample_sha256",
                    "labels_artifact_sha256",
                    "measurements_sha256",
                    "normalized_identity",
                    "object_count",
                ):
                    require(
                        evidence[field] == baseline[field],
                        f"{interface}: cross-interface {field} differs",
                    )
            write_json(args.output / "receipt.json", receipt)
    receipt["source_identity_end"] = source_identity()
    for field in ("commit", "engine_tree_sha256", "harness_sha256", "packages"):
        require(
            receipt["source_identity_end"][field] == receipt["source_identity"][field],
            f"Source changed during reproduction: {field}",
        )
    if args.frozen_worker:
        require(
            digest(args.frozen_worker.read_bytes())
            == receipt["frozen_worker"]["sha256"],
            "Frozen worker changed during reproduction",
        )
    receipt["status"] = "passed"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, help="Absent evidence directory; never overwritten"
    )
    public = parser.add_mutually_exclusive_group()
    public.add_argument(
        "--public-cell",
        type=Path,
        help="Exact pinned CC0 cell.png, explicitly supplied",
    )
    public.add_argument(
        "--fetch-public-cell",
        action="store_true",
        help="Opt in to one bounded pinned download",
    )
    parser.add_argument(
        "--simulate-operator-review",
        action="store_true",
        help="Automated transition test only; not actual researcher review",
    )
    parser.add_argument(
        "--frozen-worker",
        type=Path,
        help="Exact packaged executable for CLI, worker and MCP; no source Python fallback",
    )
    parser.add_argument("--inspect-study", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--result-id", help=argparse.SUPPRESS)
    parser.add_argument("--inspection-output", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.frozen_worker:
        args.frozen_worker = args.frozen_worker.resolve(strict=True)
        require(
            os.access(args.frozen_worker, os.X_OK), "Frozen worker is not executable"
        )
    sys.path.insert(0, str(ENGINE))
    if args.inspect_study:
        try:
            require(
                bool(args.result_id) and args.inspection_output is not None,
                "Missing inspection arguments",
            )
            print(
                canonical(
                    inspect_persisted(
                        args.inspect_study, args.result_id, args.inspection_output
                    )
                )
            )
            return 0
        except Exception as exc:  # noqa: BLE001 - process boundary returns explicit failure
            print(
                canonical({"error": {"type": type(exc).__name__, "message": str(exc)}}),
                file=sys.stderr,
            )
            return 1
    if args.output is None:
        parser.error("--output is required")
    args.output = args.output.expanduser().absolute()
    try:
        # mkdir is exclusive, including symlinks and concurrent invocation.
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.mkdir(mode=0o700)
    except OSError as exc:
        print(f"Cannot create absent output directory: {exc}", file=sys.stderr)
        return 1
    receipt: dict[str, Any] = {
        "schema": "loci.publication-reproduction/v1",
        "status": "running",
        "tolerance": {
            "absolute": ATOL,
            "relative": RTOL,
            "formula": "abs(actual-reference) <= absolute + relative*abs(reference)",
            "labels_counts_and_identity": "exact",
        },
        "review": "SIMULATED automated operator transition"
        if args.simulate_operator_review
        else "unreviewed; no human signoff claimed",
        "limitations": [
            "Source Python interfaces; not a packaged Electron GUI journey",
            "Same source/runtime and declared 2D classical recipe only",
            "No biological/clinical accuracy or independent researcher usability validation",
            "MCP native labels checked by fresh local production artifact reader",
            "Timing observations include startup; no randomized benchmark or ranking",
        ],
        "failures": [],
    }
    try:
        run(args, receipt)
        code = 0
    except Exception as exc:  # noqa: BLE001 - retain failed receipts and a nonzero exit
        receipt["status"] = "failed"
        receipt["failures"].append({"type": type(exc).__name__, "message": str(exc)})
        (args.output / "failure.traceback.txt").write_text(traceback.format_exc())
        code = 1
    finally:
        write_json(args.output / "receipt.json", receipt)
    print(
        canonical(
            {"status": receipt["status"], "receipt": str(args.output / "receipt.json")}
        )
    )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
