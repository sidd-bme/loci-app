#!/usr/bin/env python3
"""M6 synthetic engineering qualification. Run phases serially in fresh processes.

No lab images, biological validation, model downloads or installed-app changes.
Every phase writes its resource receipt even when an assertion fails.
"""

from __future__ import annotations

import argparse
import csv
import xml.etree.ElementTree as ET
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import struct
import subprocess
import sys
import threading
import time
import traceback

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "engine/src"))
import numpy as np
import tifffile
from loci_engine import large_components  # initialize numerical runtime before baseline
from loci_engine.research_export import export_research_result
from loci_engine.research_large_exchange import adopt_large_result, create_exchange_grant
from loci_engine.research_project import ResearchProject
from loci_engine.research_session import clone_study
from loci_engine.research_tiled_store import iter_object_rows, iter_tiles, label_value_hash
from loci_engine.workbench import Workbench
from loci_engine.working_result import _sha256_file_stable

ALLOWANCE = 256 * 1024**2
CORE = 512
CAL = {
    "axes": "YX",
    "PhysicalSizeX": 0.5,
    "PhysicalSizeY": 0.75,
    "PhysicalSizeXUnit": "µm",
    "PhysicalSizeYUnit": "µm",
}


def rss():
    if sys.platform == "linux":
        # Linux statm's second field is resident pages, not bytes. Read the
        # kernel counter directly; no optional runtime dependency is needed.
        return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    if sys.platform != "darwin":
        raise RuntimeError("RSS qualification supports macOS and Linux only")
    buffer = ctypes.create_string_buffer(128)
    size = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo(os.getpid(), 4, 0, buffer, 128)
    if size < 16:
        raise RuntimeError("Cannot read kernel resident size")
    return struct.unpack_from("QQ", buffer.raw)[1]


def rectangles(side):
    cells = [
        (y + 64, y + 192, x + 64, x + 192, 200 + (y // CORE * 32 + x // CORE) % 400)
        for y in range(0, side, CORE)
        for x in range(0, side, CORE)
    ]
    cells.append((500, 524, 500, 524, 900))
    return sorted(cells, key=lambda r: (r[0], r[2]))


def expected_tile(side, y, x, *, raw=False, removed=False):
    h, w = min(CORE, side - y), min(CORE, side - x)
    yy, xx = np.ogrid[y : y + h, x : x + w]
    if side == 447:
        foreground = (yy + xx) % 2 == 1
        if raw:
            return (foreground * 200).astype(np.uint16)
        # Number of preceding foreground pixels in alternating odd-length rows.
        first = yy // 2 * side + (yy % 2) * 223
        index = first + (xx + (yy % 2) + 1) // 2
        return np.where(foreground, index, 0).astype(np.uint32)
    output = ((yy * 13 + xx * 7) % 37).astype(np.uint16) if raw else np.zeros((h, w), np.uint32)
    bar = ((yy >= 20) & (yy < 23)) | ((xx >= 20) & (xx < 23))
    output[np.broadcast_to(bar, (h, w))] = 600 if raw else (0 if removed else 1)
    for label, (y0, y1, x0, x1, value) in enumerate(rectangles(side), 2):
        ya, yb, xa, xb = max(y, y0), min(y + h, y1), max(x, x0), min(x + w, x1)
        if ya < yb and xa < xb:
            output[ya - y : yb - y, xa - x : xb - x] = value if raw else label
    return output


def fixture(path, side):
    def tiles():
        for y in range(0, side, CORE):
            for x in range(0, side, CORE):
                data = expected_tile(side, y, x, raw=True)
                padded = np.zeros((CORE, CORE), np.uint16)
                padded[: data.shape[0], : data.shape[1]] = data
                yield padded

    tifffile.imwrite(
        path,
        tiles(),
        shape=(side, side),
        dtype=np.uint16,
        tile=(CORE, CORE),
        compression="deflate",
        maxworkers=1,
        buffersize=4 * 1024**2,
        bigtiff=True,
        ome=True,
        metadata=CAL,
    )


def verify(project, result, side, removed=False):
    count = 0
    for y, x, values in iter_tiles(project, result["arrays"]["labels"]):
        assert np.array_equal(values, expected_tile(side, y, x, removed=removed)), (y, x)
        count += 1
    assert label_value_hash(project, result["arrays"]["labels"]) == result["label_sha256"]
    rows_count = 0
    rects = rectangles(side) if side != 447 else None
    for row in iter_object_rows(project, result["object_table"]):
        label = row["label"]
        if side == 447:
            n, value = 1, 200
            assert math.isclose(
                row["nearest_centroid_distance"], math.hypot(0.5, 0.75), rel_tol=1e-12
            )  # diagonal foreground is nearer than two x pixels
        elif label == 1:
            n, value = 6 * side - 9, 600
        else:
            y0, y1, x0, x1, value = rects[label - 2]
            n = (y1 - y0) * (x1 - x0)
            np.testing.assert_allclose(
                row["centroid_index"], [(y0 + y1 - 1) / 2, (x0 + x1 - 1) / 2], rtol=0, atol=1e-10
            )
            expected_radii = sorted(
                [
                    0.75 * math.sqrt(((y1 - y0) ** 2 - 1) / 12),
                    0.5 * math.sqrt(((x1 - x0) ** 2 - 1) / 12),
                    0,
                ],
                reverse=True,
            )
            np.testing.assert_allclose(
                row["principal_rms_radii"], expected_radii, rtol=1e-12, atol=1e-10
            )
        assert row["voxel_count"] == n and row["measure"] == n * 0.375
        assert row["measure_unit"] == "um^2"
        stats = next(iter(row["intensity"].values()))
        assert stats["sum"] == n * value and stats["mean"] == value and stats["std_population"] == 0
        rows_count += 1
    expected_count = 99904 if side == 447 else len(rects) + (0 if removed else 1)
    assert rows_count == expected_count == result["object_count"]
    return {
        "exact_cores": count,
        "exact_objects": rows_count,
        "label_sha256": result["label_sha256"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--side", type=int, choices=[447, 4096, 16384], required=True)
    parser.add_argument(
        "--phase",
        choices=["fixture", "run", "inspect", "delete", "export", "clone", "reopen", "adopt"],
        required=True,
    )
    parser.add_argument(
        "--source-commit",
        help="Declared commit for a transferred source archive; per-file hashes remain authoritative",
    )
    parser.add_argument("--durable-run", action="store_true", help="Execute run through durable jobs")
    args = parser.parse_args()
    if args.source_commit is not None and (
        len(args.source_commit) != 40 or any(c not in "0123456789abcdef" for c in args.source_commit)
    ):
        parser.error("--source-commit must be a full lowercase Git SHA")
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / "source.ome.tif"
    state_path = root / "state.json"
    receipt = {
        "phase": args.phase,
        "side": args.side,
        "pid": os.getpid(),
        "allowance": ALLOWANCE,
        "decoded_raw_bytes": args.side**2 * 2,
        "decoded_labels_bytes": args.side**2 * 4,
        "head": args.source_commit or subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
        "head_origin": "declared transferred archive" if args.source_commit else "local git",
        "platform": sys.platform,
        "rss_sampler": "/proc/self/statm resident pages" if sys.platform == "linux" else "proc_pidinfo",
    }
    source_files = sorted((REPO / "engine/src/loci_engine").glob("*.py"))
    receipt["source_sha256"] = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files
    }
    receipt["harness_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    baseline = rss()
    receipt["baseline_rss"] = baseline
    receipt["pre_phase_high_water_rss"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (
        1024 if sys.platform == "linux" else 1
    )
    stop = threading.Event()
    peak = [baseline]
    start = time.monotonic()
    stamp = time.time_ns()
    sample_path = root / f"{args.phase}-{stamp}-rss.csv"

    def sample():
        with sample_path.open("x") as stream:
            stream.write("seconds,rss_bytes\n")
            while not stop.wait(0.01):
                value = rss()
                peak[0] = max(peak[0], value)
                stream.write(f"{time.monotonic() - start:.6f},{value}\n")

    thread = threading.Thread(target=sample, daemon=True)
    thread.start()
    wb = None
    try:
        if args.phase == "fixture":
            assert not path.exists(), "Fixture already exists; preserve prior artifacts"
            fixture(path, args.side)
            receipt["fixture_sha256"], receipt["fixture_bytes"] = _sha256_file_stable(
                path, reject_symlink=True
            )
        else:
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
            if args.phase == "run":
                project = ResearchProject.create(
                    root / "analysis.loci-study", "M6 synthetic qualification", schema_version=2
                )
                wb = Workbench(project)
                source = wb.import_native(str(path))
                request = {
                    "source_id": source["id"],
                    "selection": {
                        "x": 0,
                        "y": 0,
                        "width": args.side,
                        "height": args.side,
                        "t": 0,
                        "c": 0,
                        "z": 0,
                        "level": 0,
                    },
                    "segmentation": {
                        "method": "components",
                        "threshold": 100,
                        "polarity": "bright",
                        "min_size": 0,
                        "exclude_border": False,
                    },
                    "working_bytes": ALLOWANCE,
                }
                receipt["plan"] = wb.execute("large_components_preflight", request)
                if args.durable_run:
                    from loci_engine.research_jobs import run_job, submit_job

                    job = submit_job(wb, request, f"qualification-{stamp}", operation="large_components_run")
                    completed = run_job(wb, job["id"])
                    assert completed["job"]["state"] == "succeeded"
                    receipt["durable_job"] = completed["job"]
                    result = completed["result"]
                else:
                    result = wb.execute("large_components_run", request)["result"]
                state = {"result_id": result["id"], "source_id": source["id"], "request": request}
                receipt["oracle"] = verify(project, project.result(result["id"]), args.side)
                state_path.write_text(json.dumps(state))
            else:
                cold_start = time.monotonic()
                project = ResearchProject(
                    root / ("saved.loci-study" if args.phase == "reopen" else "analysis.loci-study")
                )
                wb = Workbench(project)
                rid = state.get("child_id", state["result_id"])
                result = project.result(rid)
                receipt["cold_reopen_seconds"] = time.monotonic() - cold_start
                if args.phase == "inspect":
                    t = time.monotonic()
                    overview = wb.execute(
                        "large_result_view",
                        {"result_id": rid, "revision_hash": result["revision_hash"]},
                    )
                    receipt["first_overview_seconds"] = time.monotonic() - t
                    assert overview["image_shape"][0] <= 1024
                    samples = []
                    for index in range(20):
                        for kind, op, request in [
                            (
                                "page",
                                "result",
                                {
                                    "result_id": rid,
                                    "offset": min(index * 200, max(0, result["object_count"] - 1)),
                                    "limit": 200,
                                },
                            ),
                            (
                                "pick",
                                "large_result_pick",
                                {
                                    "result_id": rid,
                                    "revision_hash": result["revision_hash"],
                                    "u": 64 + index % 3,
                                    "v": 64,
                                },
                            ),
                            (
                                "region",
                                "large_result_view",
                                {
                                    "result_id": rid,
                                    "revision_hash": result["revision_hash"],
                                    "region": {
                                        "x": index * 7,
                                        "y": index * 5,
                                        "width": 256,
                                        "height": 256,
                                    },
                                    "max_edge": 512,
                                },
                            ),
                        ]:
                            t = time.monotonic()
                            wb.execute(op, request)
                            samples.append({"kind": kind, "seconds": time.monotonic() - t})
                    receipt["latencies"] = samples
                    receipt["p95_seconds"] = {
                        kind: float(
                            np.percentile([s["seconds"] for s in samples if s["kind"] == kind], 95)
                        )
                        for kind in ("page", "pick", "region")
                    }
                    assert (
                        receipt["cold_reopen_seconds"] <= 10
                        and receipt["first_overview_seconds"] <= 10
                    )
                    assert max(receipt["p95_seconds"].values()) <= 1
                elif args.phase == "delete":
                    child = wb.execute(
                        "large_result_delete",
                        {"result_id": rid, "revision_hash": result["revision_hash"], "label": 1},
                    )["result"]
                    assert child["parent_id"] == rid
                    receipt["oracle"] = verify(
                        project, project.result(child["id"]), args.side, removed=True
                    )
                    receipt["parent_oracle"] = verify(project, result, args.side)
                    state["child_id"] = child["id"]
                    state_path.write_text(json.dumps(state))
                elif args.phase == "export":
                    project.review(rid, result["revision_hash"], "reviewed")
                    receipt["export"] = export_research_result(
                        project, rid, result["revision_hash"], root / "export"
                    )
                    for name in ("image", "labels"):
                        with tifffile.TiffFile(root / "export" / (name + ".ome.tif")) as tif:
                            pixels = next(
                                node
                                for node in ET.fromstring(tif.ome_metadata).iter()
                                if node.tag.endswith("}Pixels")
                            )
                            assert float(pixels.attrib["PhysicalSizeX"]) == 0.5
                            assert float(pixels.attrib["PhysicalSizeY"]) == 0.75
                            assert (
                                pixels.attrib["PhysicalSizeXUnit"]
                                == pixels.attrib["PhysicalSizeYUnit"]
                                == "µm"
                            )
                            for data, index, segment_shape in tif.pages[0].segments(maxworkers=1):
                                y, x = index[2:4]
                                expected = expected_tile(
                                    args.side,
                                    y,
                                    x,
                                    raw=name == "image",
                                    removed="child_id" in state,
                                )
                                assert np.array_equal(
                                    data[0, : expected.shape[0], : expected.shape[1], 0], expected
                                )
                    csv_count = 0
                    with (root / "export" / "objects.csv").open(newline="") as stream:
                        for row in csv.DictReader(stream):
                            label = int(row["label"])
                            assert label != 1 if "child_id" in state else label >= 1
                            assert row["measure_unit"] == "um^2"
                            csv_count += 1
                    assert csv_count == result["object_count"]
                    receipt["independent_export_oracle"] = {
                        "exact_TIFF_pixels": True,
                        "OME_XY_units": "0.5 x 0.75 µm",
                        "CSV_rows": csv_count,
                    }
                elif args.phase == "clone":
                    clone = clone_study(project, root / "saved.loci-study")
                    assert clone.result(rid)["revision_hash"] == result["revision_hash"]
                elif args.phase == "reopen":
                    receipt["oracle"] = verify(
                        project, result, args.side, removed="child_id" in state
                    )
                    assert project.review_state(rid)["disposition"] == "reviewed"
                elif args.phase == "adopt":
                    root_export_dir = root / "export"
                    if (root_export_dir / "result.json").exists():
                        res_data = json.loads((root_export_dir / "result.json").read_text())
                        if res_data.get("result", {}).get("parent_id") is not None:
                            root_export_dir = root / "root-export"
                    if not root_export_dir.exists():
                        root_rid = state["result_id"]
                        root_res = project.result(root_rid)
                        project.review(root_rid, root_res["revision_hash"], "reviewed")
                        export_research_result(
                            project, root_rid, root_res["revision_hash"], root_export_dir
                        )
                    adopted_study_path = root / "adopted.loci-study"
                    if adopted_study_path.exists():
                        raise ValueError("Adoption study already exists; preserve prior evidence")
                    adopted_project = ResearchProject.create(
                        adopted_study_path, "M6 synthetic adoption qualification", schema_version=2
                    )
                    adopted_wb = Workbench(adopted_project)
                    try:
                        adopted_source = adopted_wb.import_native(str(path))
                        grant = create_exchange_grant(
                            adopted_project, adopted_source["id"], root_export_dir
                        )
                        adopt_req = {
                            "source_id": adopted_source["id"],
                            "grant_id": grant["grant_id"],
                            "manifest_sha256": grant["manifest_sha256"],
                        }
                        adopted = adopt_large_result(adopted_wb, adopt_req)
                        adopted_res = adopted["result"]
                        assert adopted_res["kind"] == "large-components"
                        assert adopted_res["parent_id"] is None
                        assert adopted_res["source_id"] == adopted_source["id"]
                        receipt["oracle"] = verify(
                            adopted_project,
                            adopted_project.result(adopted_res["id"]),
                            args.side,
                            removed=False,
                        )
                        adopted_again = adopt_large_result(adopted_wb, adopt_req)
                        assert adopted_again["result"]["id"] == adopted_res["id"]
                        state["adopted_id"] = adopted_res["id"]
                        state_path.write_text(json.dumps(state))
                        receipt["adopted"] = {
                            "result_id": adopted_res["id"],
                            "object_count": adopted_res["object_count"],
                            "source_id": adopted_res["source_id"],
                        }
                    finally:
                        adopted_wb.close()
        receipt["status"] = "passed"
    except BaseException:
        receipt["status"] = "failed"
        receipt["error"] = traceback.format_exc()
        raise
    finally:
        if wb:
            wb.close()
        stop.set()
        thread.join()
        peak[0] = max(peak[0], rss())
        receipt.update(
            seconds=time.monotonic() - start,
            sampled_peak_rss=peak[0],
            peak_rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            * (1024 if sys.platform == "linux" else 1),
            samples_file=sample_path.name,
        )
        receipt["rss_growth"] = max(receipt["peak_rss"], peak[0]) - baseline
        receipt["resource_pass"] = receipt["rss_growth"] <= ALLOWANCE
        (root / f"{args.phase}-{stamp}.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(
            json.dumps(
                {
                    key: receipt[key]
                    for key in (
                        "phase",
                        "status",
                        "seconds",
                        "baseline_rss",
                        "peak_rss",
                        "rss_growth",
                        "resource_pass",
                    )
                }
            )
        )
    if not receipt["resource_pass"]:
        raise AssertionError("Numerical working RSS growth exceeds declared allowance")


if __name__ == "__main__":
    main()
