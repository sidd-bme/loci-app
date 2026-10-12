#!/usr/bin/env python3
"""Retained CC0 BBBC039 workflow acceptance; no downloads or model provisioning.

Invoke with engine/.venv/bin/python. Writes only a fresh visual-workflows evidence
run. Fixed field selection and segmentation settings come from the retained
manifest. Automated review calls exercise the human-review gate; they are QA
fixtures, not a human scientific approval. No biological accuracy is inferred.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from itertools import pairwise
from pathlib import Path

import numpy as np
import tifffile

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / ".loci/evidence/2026-10-03/object-population/real-images"
PRIOR = FIXTURES / "run-20261003T073611077539Z/numerical-results.json"
OUTPUT = REPO / ".loci/evidence/2026-10-03/visual-workflows/real-images"
HELPER = REPO / "scripts/qa/population-real-images.py"
sys.dont_write_bytecode = True
SELECTION = {"c": 0, "z": 0, "t": 0, "level": 0}
GAUSSIAN_STEP = {"op": "gaussian", "sigma": 1.0}
FILTERS = [{"metric": "measure", "min": 100, "max": 1000, "unit": "pixel^2"}]


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(
        json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )


def identity():
    return {
        "head": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
        "branch": subprocess.check_output(
            ["git", "branch", "--show-current"], cwd=REPO, text=True
        ).strip(),
        "engine_sources": {
            str(p.relative_to(REPO)): sha(p)
            for p in sorted((REPO / "engine/src/loci_engine").rglob("*.py"))
        },
        "script_sha256": sha(Path(__file__)),
        "oracle_helper_sha256": sha(HELPER),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "tifffile": tifffile.__version__,
        "command": [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]],
    }


def engine():
    sys.path.insert(0, str(REPO / "engine/src"))
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    return Workbench, ResearchProject


def oracle_helper():
    spec = importlib.util.spec_from_file_location("retained_population_oracle", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def retained_inputs():
    """Verify existing pinned bytes without rewriting/extracting original fixtures."""
    manifest_path = FIXTURES / "source-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    prior = json.loads(PRIOR.read_text())
    pins = {str(manifest_path): sha(manifest_path), str(PRIOR): sha(PRIOR)}
    for archive in manifest["archives"]:
        path = FIXTURES / "originals" / Path(archive["path"]).name
        if path.stat().st_size != archive["bytes"] or sha(path) != archive["sha256"]:
            raise AssertionError("Retained archive identity mismatch")
        pins[str(path)] = archive["sha256"]
    records = {Path(r["filename"]).stem: r for r in prior["fields"]}
    fields = []
    for split in ("train", "test"):
        for filename in manifest["selected"][split]:
            stem = Path(filename).stem
            previous = records[stem]
            paths = {
                "original": FIXTURES / "selected" / (stem + ".tif"),
                "mask": FIXTURES / "selected" / (stem + ".png"),
                "derived": FIXTURES
                / "derived-pixel-inputs"
                / (stem + "-uncalibrated.tif"),
            }
            expected = {
                "original": previous["image_sha256"],
                "mask": previous["mask_sha256"],
                "derived": previous["derived_source"]["sha256"],
            }
            for key, path in paths.items():
                if sha(path) != expected[key]:
                    raise AssertionError("Retained field bytes changed")
                pins[str(path)] = expected[key]
            raw, companion = (
                tifffile.imread(paths["original"]),
                tifffile.imread(paths["derived"]),
            )
            if raw.shape != (520, 696) or raw.dtype != np.uint16:
                raise AssertionError("Unexpected retained image axes/dtype/shape")
            np.testing.assert_array_equal(raw, companion)
            if (
                hashlib.sha256(raw.tobytes()).hexdigest()
                != previous["derived_source"]["array_sha256"]
            ):
                raise AssertionError("Pixel identity mismatch")
            fields.append({"split": split, "filename": stem, **paths})
    if len(fields) != 6:
        raise AssertionError("Fixed six-field selection changed")
    return manifest, fields, pins


def definition(settings, steps=()):
    nodes = [
        {"id": "source", "type": "source", "settings": {}},
        {"id": "segment", "type": "segment", "settings": copy.deepcopy(settings)},
        {
            "id": "measure",
            "type": "measure",
            "settings": {"measurement_channels": [0], "gates": []},
        },
        {
            "id": "population",
            "type": "population",
            "settings": {"filters": copy.deepcopy(FILTERS)},
        },
        {"id": "review", "type": "review", "settings": {}},
        {"id": "export", "type": "export", "settings": {}},
    ]
    nodes[1:1] = [
        {"id": f"process_{index}", "type": "process", "settings": copy.deepcopy(step)}
        for index, step in enumerate(steps)
    ]
    return {
        "schema": "loci.workflow/v1",
        "name": "BBBC039 fixed raw-pixel QA",
        "working_bytes": 512 * 1024**2,
        "nodes": nodes,
        "edges": [{"from": a["id"], "to": b["id"]} for a, b in pairwise(nodes)],
    }


def save(wb, graph, workflow_id=None, revision=0):
    return wb.execute(
        "workflow_save",
        {
            "workflow_id": workflow_id or uuid.uuid4().hex,
            "expected_revision": revision,
            "definition": graph,
        },
    )["workflow"]


def binding(workflow, source):
    return {
        "workflow_id": workflow["id"],
        "workflow_revision": workflow["revision"],
        "definition_sha256": workflow["data"]["definition_sha256"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "selection": SELECTION.copy(),
    }


def rejected(action):
    try:
        action()
    except (ValueError, PermissionError) as exc:
        return {
            "status": "passed",
            "rejection_type": type(exc).__name__,
            "message": str(exc),
        }
    raise AssertionError("Expected fail-closed rejection did not occur")


def selected_membership(wb, result, expected):
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "x_metric": "measure",
        "filters": [{k: v for k, v in f.items() if k != "unit"} for f in FILTERS],
        "sort": {"metric": "measure", "direction": "asc"},
        "limit": 17,
    }
    labels, response = [], None
    wanted = sorted(row["label"] for row in expected if 100 <= row["measure"] <= 1000)
    for offset in range(0, max(len(wanted), 1), 17):
        response = wb.execute("population_query", {**request, "offset": offset})
        labels.extend(row["label"] for row in response["rows"])
    if sorted(labels) != wanted or response["filtered_count"] != len(wanted):
        raise AssertionError("Workflow area selection differs from independent pixels")
    hash_binding = {
        key: result[key]
        for key in ("id", "revision_hash", "source_id", "source_sha256")
    }
    hash_binding["result_id"] = hash_binding.pop("id")
    encoded = json.dumps(
        {**hash_binding, "filters": response["query"]["filters"], "labels": wanted},
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    independent_hash = hashlib.sha256(encoded.encode()).hexdigest()
    if response["membership_sha256"] != independent_hash:
        raise AssertionError("Population membership digest mismatch")
    return {
        "status": "passed",
        "count": len(wanted),
        "labels": wanted,
        "membership_sha256": independent_hash,
    }


def export_check(wb, output, destination, image, labels, expected):
    from loci_engine.research_workflow import export_run

    result = output["result"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = {
        "run_id": output["job"]["id"],
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "destination": str(destination),
    }
    denial = rejected(lambda: export_run(wb, request))
    if destination.exists():
        raise AssertionError("Unreviewed export published a destination")
    # Test-only simulated manual action: never claim this QA actor is a reviewer.
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    receipt = export_run(wb, request)
    manifest = json.loads((destination / "manifest.json").read_text())
    if sha(destination / "manifest.json") != receipt["manifest_sha256"]:
        raise AssertionError("Export manifest hash mismatch")
    hashes = {}
    for item in manifest["files"]:
        path = destination / item["name"]
        if sha(path) != item["sha256"]:
            raise AssertionError("Exported artifact hash mismatch")
        hashes[item["name"]] = item["sha256"]
    np.testing.assert_array_equal(tifffile.imread(destination / "image.ome.tif"), image)
    np.testing.assert_array_equal(
        tifffile.imread(destination / "labels.ome.tif"), labels
    )
    full = wb.project.result(result["id"])
    exported_record = json.loads((destination / "result.json").read_text())
    if exported_record["result"]["revision_hash"] != result["revision_hash"]:
        raise AssertionError("Exported revision binding mismatch")
    with (destination / "objects.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    if len(rows) != len(full["provenance"]["measurements"]):
        raise AssertionError("Export CSV object count mismatch")
    for row, measured in zip(rows, full["provenance"]["measurements"], strict=True):
        if int(row["label"]) != measured["label"] or row["measure_unit"] != "pixel^2":
            raise AssertionError("Export CSV identity/unit mismatch")
        np.testing.assert_allclose(
            [float(row["voxel_count"]), float(row["measure"])],
            [measured["voxel_count"], measured["measure"]],
            atol=1e-9,
            rtol=1e-12,
        )
        for channel, stats in measured["intensity"].items():
            for name in ("sum", "mean"):
                np.testing.assert_allclose(
                    float(row[f"intensity:{channel}:{name}"]),
                    stats[name],
                    atol=1e-9,
                    rtol=1e-12,
                )
    if not {
        "workflow.json",
        "selected_measurements.csv",
        "objects.csv",
        "result.json",
    }.issubset(hashes):
        raise AssertionError(
            "Workflow selection artifacts are not covered by atomic manifest"
        )
    workflow_export = json.loads((destination / "workflow.json").read_text())
    wanted = sorted(row["label"] for row in expected if 100 <= row["measure"] <= 1000)
    if (
        workflow_export["schema"] != "loci.workflow-export/v1"
        or workflow_export["workflow"] != full["provenance"]["workflow"]
        or workflow_export["job_id"] != output["job"]["id"]
    ):
        raise AssertionError("Exported workflow context/job binding mismatch")
    if workflow_export["population"] != output["run"]["data"]["population"]:
        raise AssertionError(
            "Exported population receipt differs from exact workflow run"
        )
    if (
        workflow_export["result_id"] != result["id"]
        or workflow_export["revision_hash"] != result["revision_hash"]
        or workflow_export["selected_labels"] != wanted
    ):
        raise AssertionError("Exported workflow population/revision mismatch")
    if workflow_export["scope"] != {
        "labels": "full-segmentation",
        "objects_csv": "full-object-table",
        "selected_measurements_csv": "population-filter-members",
    }:
        raise AssertionError("Workflow export full/selected scope is ambiguous")
    with (destination / "selected_measurements.csv").open(newline="") as stream:
        selected = list(csv.DictReader(stream))
    if sorted(int(row["label"]) for row in selected) != wanted:
        raise AssertionError(
            "Selected export CSV membership differs from independent pixels"
        )
    full_csv = {int(row["label"]): row for row in rows}
    if any(row != full_csv[int(row["label"])] for row in selected):
        raise AssertionError("Selected export modified original full object values")
    reference = {row["label"]: row for row in expected}
    for row in selected:
        actual = reference[int(row["label"])]
        np.testing.assert_allclose(
            float(row["measure"]), actual["measure"], atol=1e-9, rtol=1e-12
        )
        mean_headers = [
            header
            for header in row
            if header.startswith("intensity:") and header.endswith(":mean")
        ]
        sum_headers = [
            header
            for header in row
            if header.startswith("intensity:") and header.endswith(":sum")
        ]
        if len(mean_headers) != 1 or len(sum_headers) != 1:
            raise AssertionError("Selected export raw intensity channel mismatch")
        np.testing.assert_allclose(
            [float(row[mean_headers[0]]), float(row[sum_headers[0]])],
            [actual["intensity"]["mean"], actual["intensity"]["sum"]],
            atol=1e-9,
            rtol=1e-12,
        )
    duplicate = rejected(lambda: export_run(wb, request))
    return {
        "status": "passed",
        "unreviewed_rejection": denial,
        "duplicate_destination_rejection": duplicate,
        "manifest_sha256": receipt["manifest_sha256"],
        "file_sha256": hashes,
        "receipt": receipt,
        "review_mode": "automated QA simulation of explicit human action",
    }


def interrupt_child(project, job_id, marker):
    """Pause after the first staged array, before any result publication."""
    from loci_engine.research_jobs import run_job

    Workbench, ResearchProject = engine()
    wb = Workbench(ResearchProject(project))
    store = wb.project.store_array

    def pause_after_staging(array):
        value = store(array)
        write_json(
            marker,
            {
                "pid": os.getpid(),
                "job_id": job_id,
                "stage": "array stored; result unpublished",
            },
        )
        while True:
            time.sleep(0.1)
        return value

    wb.project.store_array = pause_after_staging
    run_job(wb, job_id)


def recovery_check(run, derived, graph):
    from loci_engine.research_jobs import reconcile_jobs, run_job, submit_job

    Workbench, ResearchProject = engine()
    project_path = run / "recovery.loci-study"
    wb = Workbench(ResearchProject.create(project_path, "Workflow interruption QA"))
    source = wb.import_native(str(derived))
    workflow = save(wb, graph)
    request = binding(workflow, source)
    job = submit_job(wb, request, "real-killed-process", operation="workflow_run")
    marker = run / "interrupt-stage.json"
    with (run / "interrupt-child.log").open("w") as log:
        child = subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--interrupt-child",
                str(project_path),
                job["id"],
                str(marker),
            ],
            cwd=REPO,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 30
            while not marker.exists():
                if child.poll() is not None:
                    raise AssertionError(
                        "Interruption child exited before staging; inspect child log"
                    )
                if time.monotonic() > deadline:
                    raise AssertionError(
                        "Interruption child did not reach staging in 30 seconds"
                    )
                time.sleep(0.05)
            if wb.project.list_results():
                raise AssertionError("Result was published before interruption marker")
            child.kill()
            exitcode = child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
    reopened = Workbench(ResearchProject(project_path))
    reconcile_jobs(reopened.project)
    interrupted = reopened.project.job(job["id"])
    if interrupted["state"] != "interrupted" or reopened.project.list_results():
        raise AssertionError(
            "Lost process did not reconcile without result publication"
        )
    replay = submit_job(
        reopened, request, "real-killed-process", operation="workflow_run"
    )
    if replay["id"] != job["id"] or replay["state"] != "interrupted":
        raise AssertionError("Interrupted idempotency key was silently retried")
    retry = submit_job(reopened, request, "explicit-retry", operation="workflow_run")
    # Inject one post-publication receipt-write failure. The real result/job
    # transaction must survive; reopening must reconstruct without recomputation.
    import loci_engine.research_workflow as workflow_module

    recover = workflow_module._recover_run

    def fail_receipt(*_args):
        raise RuntimeError("QA injected post-publication run-receipt interruption")

    workflow_module._recover_run = fail_receipt
    try:
        try:
            run_job(reopened, retry["id"])
        except RuntimeError as exc:
            receipt_failure = str(exc)
        else:
            raise AssertionError("Post-publication receipt fault did not occur")
    finally:
        workflow_module._recover_run = recover
    if reopened.project.job(retry["id"])[
        "state"
    ] != "succeeded" or reopened.project.documents("workflow_run"):
        raise AssertionError(
            "Receipt fault did not leave exact durable publication recoverable"
        )
    output = run_job(Workbench(ResearchProject(project_path)), retry["id"])
    if (
        output["job"]["state"] != "succeeded"
        or len(reopened.project.list_results()) != 1
    ):
        raise AssertionError("Explicit retry did not publish exactly one result")
    result_id = output["result"]["id"]
    rerun = run_job(Workbench(ResearchProject(project_path)), retry["id"])
    if (
        rerun["job"]["result_ids"] != [result_id]
        or len(reopened.project.list_results()) != 1
    ):
        raise AssertionError("Successful durable replay duplicated publication")
    return {
        "status": "passed",
        "child_exit_code": exitcode,
        "post_publication_receipt_failure": receipt_failure,
        "reconstructed_run_id": output["run"]["id"],
        "interrupted_job": interrupted,
        "retry_job": output["job"],
        "published_result_id": result_id,
        "result_count": 1,
    }


def reopen_check(wb, records, run):
    Workbench, ResearchProject = engine()
    reopened = Workbench(ResearchProject(wb.project.root))
    checked = []
    for field in records:
        for method, receipt in field["methods"].items():
            workflow = reopened.execute(
                "workflow_get", {"workflow_id": receipt["workflow"]["id"]}
            )["workflow"]
            if workflow != receipt["workflow"]:
                raise AssertionError("Reopened saved workflow differs")
            result = reopened.project.result(receipt["result_id"])
            if result["revision_hash"] != receipt["revision_hash"]:
                raise AssertionError("Reopened result revision differs")
            labels = reopened.project.load_array(result["arrays"]["labels"])
            if (
                hashlib.sha256(labels.tobytes()).hexdigest()
                != receipt["label_array_sha256"]
            ):
                raise AssertionError("Reopened labels differ")
            status = reopened.execute("workflow_status", {"run_id": receipt["job_id"]})
            if (
                status["state"] != "exported"
                or status["workflow_outdated"]
                or status["review"]["revision_hash"] != result["revision_hash"]
            ):
                raise AssertionError("Reopened workflow/review/export state differs")
            if len(status["exports"]) != 1:
                raise AssertionError("Expected one persisted workflow export receipt")
            destination = run / "exports" / (field["filename"] + "-" + method)
            if (
                sha(destination / "manifest.json")
                != receipt["export"]["manifest_sha256"]
            ):
                raise AssertionError("Reopened export manifest differs")
            for filename, fingerprint in receipt["export"]["file_sha256"].items():
                if sha(destination / filename) != fingerprint:
                    raise AssertionError("Reopened export artifact differs")
            checked.append(
                {
                    "result_id": result["id"],
                    "workflow_id": workflow["id"],
                    "revision_hash": result["revision_hash"],
                    "state": status["state"],
                }
            )
    return reopened, {
        "status": "passed",
        "checked_runs": checked,
        "result_count": len(reopened.project.list_results()),
    }


def invalidation_check(wb, record, other_source):
    receipt = record["methods"]["components"]
    workflow, request = receipt["workflow"], receipt["binding"]
    wrong_hash = rejected(
        lambda: wb.execute("workflow_preflight", {**request, "source_sha256": "0" * 64})
    )
    changed_source = rejected(
        lambda: wb.execute(
            "workflow_preflight", {**request, "source_id": other_source["id"]}
        )
    )
    graph = copy.deepcopy(workflow["data"]["definition"])
    graph["nodes"][1]["settings"]["min_size"] = 1
    updated = save(wb, graph, workflow["id"], workflow["revision"])
    stale_request = rejected(lambda: wb.execute("workflow_preflight", request))
    stale_write = rejected(
        lambda: save(wb, graph, workflow["id"], workflow["revision"])
    )
    status = wb.execute("workflow_status", {"run_id": receipt["job_id"]})
    if (
        not status["workflow_outdated"]
        or status["run"]["data"]["definition_sha256"] != request["definition_sha256"]
    ):
        raise AssertionError("Edited workflow did not mark historical run outdated")
    return {
        "status": "passed",
        "wrong_source_hash": wrong_hash,
        "changed_source_binding": changed_source,
        "stale_execution": stale_request,
        "stale_write": stale_write,
        "old_revision": workflow["revision"],
        "new_revision": updated["revision"],
        "workflow_outdated": status["workflow_outdated"],
        "historical_result_unchanged": wb.project.result(receipt["result_id"])[
            "revision_hash"
        ]
        == receipt["revision_hash"],
    }


def source_change_check(run, derived, graph):
    from loci_engine.research_jobs import run_job, submit_job

    Workbench, ResearchProject = engine()
    # Mutate only this new QA-owned copy. Retained originals and companions are immutable.
    copy_path = run / "source-mutation-copy.tif"
    original_bytes = derived.read_bytes()
    copy_path.write_bytes(original_bytes)
    wb = Workbench(
        ResearchProject.create(
            run / "source-change.loci-study", "Workflow source mutation QA"
        )
    )
    source = wb.import_native(str(copy_path))
    workflow = save(wb, graph)
    request = binding(workflow, source)
    job = submit_job(wb, request, "source-before-change", operation="workflow_run")
    output = run_job(wb, job["id"])
    if output["job"]["state"] != "succeeded":
        raise AssertionError("Source mutation setup workflow did not succeed")
    copy_path.write_bytes(original_bytes + b"QA-owned-source-change")
    try:
        preflight = rejected(lambda: wb.execute("workflow_preflight", request))
        status = rejected(lambda: wb.execute("workflow_status", {"run_id": job["id"]}))
        if len(wb.project.list_results()) != 1:
            raise AssertionError("Source change altered historical publication count")
    finally:
        copy_path.write_bytes(original_bytes)
    return {
        "status": "passed",
        "source_hash_before_and_restored": sha(copy_path),
        "preflight_rejection": preflight,
        "run_status_rejection": status,
        "result_id": output["result"]["id"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument(
        "--interrupt-child",
        nargs=3,
        metavar=("PROJECT", "JOB", "MARKER"),
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()
    Workbench, ResearchProject = engine()
    if args.interrupt_child:
        interrupt_child(
            Path(args.interrupt_child[0]),
            args.interrupt_child[1],
            Path(args.interrupt_child[2]),
        )
        return
    from loci_engine.research_jobs import run_job, submit_job

    run = args.output.resolve() / (
        "run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    )
    run.mkdir(parents=True)
    before = identity()
    write_json(run / "source-identity-before.json", before)
    results = {
        "schema": "loci.workflow-real-images-qa/v1",
        "status": "running",
        "fields": [],
        "scope": "Six retained CC0 whole fields; fixed components/watershed plus declared first-training-field Gaussian; pixel numerical and workflow integrity evidence only",
        "limitations": [
            "Automated review is QA simulation, not human scientific approval",
            "No annotation accuracy rescoring, physical calibration, biological/clinical validation or usability claim",
            "Packaged GUI and batch qualification belongs to the lead",
        ],
    }
    pins = {}
    try:
        manifest, fields, pins = retained_inputs()
        write_json(
            run / "input-identities.json",
            {"manifest": manifest, "retained_file_sha256": pins},
        )
        results["declared_processing_case"] = {
            "field": fields[0]["filename"],
            "split": "train",
            "steps": [GAUSSIAN_STEP],
            "segmentation": manifest["segmentation_settings_frozen_before_scores"][
                "components"
            ],
            "measurement_basis": "raw source channel pixels",
        }
        write_json(run / "results.json", results)
        helper = oracle_helper()
        wb = Workbench(
            ResearchProject.create(
                run / "bbbc039-workflows.loci-study", "BBBC039 workflow integrity QA"
            )
        )
        for field in fields:
            raw = tifffile.imread(field["derived"])
            source = wb.import_native(str(field["derived"]))
            record = {
                "filename": field["filename"],
                "split": field["split"],
                "source_sha256": source["sha256"],
                "methods": {},
            }
            results["fields"].append(record)
            cases = [
                (method, settings, [])
                for method, settings in manifest[
                    "segmentation_settings_frozen_before_scores"
                ].items()
            ]
            if field == fields[0]:
                cases.append(
                    (
                        "gaussian-components",
                        manifest["segmentation_settings_frozen_before_scores"][
                            "components"
                        ],
                        [GAUSSIAN_STEP],
                    )
                )
            for method, settings, steps in cases:
                graph = definition(settings, steps)
                workflow = save(wb, graph)
                request = binding(workflow, source)
                preflight = wb.execute("workflow_preflight", request)
                preview = wb.execute(
                    "workflow_preview", {**request, "target_node_id": "measure"}
                )
                direct = wb.execute(
                    "run_recipe",
                    {
                        "source_id": source["id"],
                        "selection": SELECTION,
                        "recipe": {
                            "steps": steps,
                            "segmentation": settings,
                            "measurement_channels": [0],
                        },
                    },
                )
                job = submit_job(
                    wb,
                    request,
                    field["filename"] + ":" + method,
                    operation="workflow_run",
                )
                if (
                    submit_job(
                        wb,
                        request,
                        field["filename"] + ":" + method,
                        operation="workflow_run",
                    )["id"]
                    != job["id"]
                ):
                    raise AssertionError("Repeated submission changed job identity")
                output = run_job(wb, job["id"])
                if output["job"]["state"] != "succeeded":
                    raise AssertionError("Workflow job did not succeed")
                result = wb.project.result(output["result"]["id"])
                direct_result = wb.project.result(direct["result"]["id"])
                labels = wb.project.load_array(result["arrays"]["labels"])
                np.testing.assert_array_equal(
                    labels, wb.project.load_array(direct_result["arrays"]["labels"])
                )
                image = wb.project.load_array(result["arrays"]["image"])
                np.testing.assert_array_equal(
                    image, wb.project.load_array(direct_result["arrays"]["image"])
                )
                if steps:
                    from scipy.ndimage import gaussian_filter

                    np.testing.assert_array_equal(
                        image,
                        gaussian_filter(
                            raw.astype(np.float64), 1.0, mode="reflect", truncate=4.0
                        ),
                    )
                    if (
                        np.array_equal(image, raw)
                        or result["provenance"]["measurement_basis"]
                        != "raw-selected-channel-values-on-result-grid"
                    ):
                        raise AssertionError(
                            "Gaussian processing/raw measurement distinction was lost"
                        )
                else:
                    np.testing.assert_array_equal(raw, image)
                expected = helper.oracle(labels, raw)
                measured = helper.check_measurements(
                    expected, result["provenance"]["measurements"]
                )
                if (
                    result["provenance"]["measurements"]
                    != direct_result["provenance"]["measurements"]
                ):
                    raise AssertionError("Workflow/direct measurement parity failed")
                if (
                    preview["object_count"] != len(expected)
                    or preview["measurements"]
                    != result["provenance"]["measurements"][:1000]
                ):
                    raise AssertionError(
                        "Workflow measurement preview/run parity failed"
                    )
                membership = selected_membership(wb, result, expected)
                population = output["run"]["data"]["population"]
                if (
                    population["total_count"] != len(expected)
                    or population["filtered_count"] != membership["count"]
                    or population["membership_sha256"]
                    != membership["membership_sha256"]
                ):
                    raise AssertionError(
                        "Stored workflow population differs from independent membership"
                    )
                pending = wb.execute("workflow_status", {"run_id": job["id"]})
                if (
                    pending["state"] != "waiting_review"
                    or pending["review"] is not None
                ):
                    raise AssertionError("Workflow silently approved a new result")
                exported = export_check(
                    wb,
                    output,
                    run / "exports" / (field["filename"] + "-" + method),
                    image,
                    labels,
                    expected,
                )
                record["methods"][method] = {
                    "status": "passed",
                    "settings": settings,
                    "preprocessing_steps": steps,
                    "measurement_basis": result["provenance"]["measurement_basis"],
                    "workflow": workflow,
                    "binding": request,
                    "job_id": job["id"],
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "direct_result_id": direct_result["id"],
                    "label_array_sha256": hashlib.sha256(labels.tobytes()).hexdigest(),
                    "measurement": measured,
                    "population": membership,
                    "export": exported,
                    "preflight": preflight,
                    "preview": {
                        k: v
                        for k, v in preview.items()
                        if k not in {"image", "measurements"}
                    },
                }
                write_json(
                    run / (field["filename"] + "-" + method + "-oracle.json"), expected
                )
                write_json(run / "results.json", results)
        results["recovery"] = recovery_check(
            run,
            fields[0]["derived"],
            definition(
                manifest["segmentation_settings_frozen_before_scores"]["components"]
            ),
        )
        reopened, results["reopen"] = reopen_check(wb, results["fields"], run)
        other_source = reopened.project.source(
            results["fields"][1]["methods"]["components"]["binding"]["source_id"]
        )
        results["invalidation"] = invalidation_check(
            reopened, results["fields"][0], other_source
        )
        results["source_change"] = source_change_check(
            run,
            fields[0]["derived"],
            definition(
                manifest["segmentation_settings_frozen_before_scores"]["components"]
            ),
        )
        results["status"] = "passed"
    except BaseException as exc:
        results["status"] = "failed"
        results["failure"] = {"type": type(exc).__name__, "message": str(exc)}
        raise
    finally:
        after = identity()
        write_json(run / "source-identity-after.json", after)
        results["source_stable_during_run"] = before == after
        results["retained_inputs_unchanged"] = (
            all(Path(p).exists() and sha(p) == h for p, h in pins.items())
            if pins
            else False
        )
        if results["status"] == "passed" and not (
            results["source_stable_during_run"] and results["retained_inputs_unchanged"]
        ):
            results["status"] = "failed"
            results["failure"] = {
                "type": "IdentityMismatch",
                "message": "Source or retained fixture changed during run",
            }
        write_json(run / "results.json", results)
        report = [
            "# Retained BBBC039 visual workflow acceptance",
            "",
            f"Status: **{results['status']}**. Completed field/method cases: {sum(len(f['methods']) for f in results['fields'])}/13 (12 zero-step fixed cases plus one declared training-field Gaussian case).",
            "",
            "| Split | Field | Fixed method | Object count | Maximum numerical error | Selected objects | Status |",
            "| --- | --- | --- | ---: | ---: | ---: | --- |",
        ]
        for field in results["fields"]:
            for method, receipt in field["methods"].items():
                report.append(
                    f"| {field['split']} | {field['filename']} | {method} | {receipt['measurement']['objects']} | {receipt['measurement']['maximum_absolute_error']:.3g} | {receipt['population']['count']} | {receipt['status']} |"
                )
        report.extend(["", "| Acceptance boundary | Status |", "| --- | --- |"])
        for check in ("recovery", "reopen", "invalidation", "source_change"):
            report.append(
                f"| {check} | {results.get(check, {}).get('status', 'not completed')} |"
            )
        report.extend(
            [
                f"| Engine/script identity stable during run | {results['source_stable_during_run']} |",
                f"| Retained fixture bytes unchanged | {results['retained_inputs_unchanged']} |",
                "",
                "Independent direct-pixel count, area, geometry and intensity checks; workflow/direct recipe and measurement preview parity (12 zero-step cases plus declared Gaussian sigma=1 pixel on the first training field); inclusive population membership; exact review-gated export CSV values, TIFF arrays and file hashes are in results.json.",
                "",
                "Recovery includes actual pre-publication SIGKILL, explicit new-key retry, injected post-publication run-receipt failure, fresh-project reconstruction and absence of duplicate result publication.",
                "",
                "Three official training and three test fields, fixed Otsu components/watershed settings, retained CC0 images and manual mask identities are preserved; no held-out tuning or annotation accuracy rescoring occurred. Areas and distances are pixel-based; physical calibration is unknown.",
                "",
                "Automated review calls exercise the gate only; they are not human scientific approval. This software evidence does not establish biological/clinical accuracy or usability. Packaged GUI/batch qualification belongs to the lead.",
                "",
                "Reproduce: `engine/.venv/bin/python scripts/qa/workflow-real-images.py`. No download option or model provisioning exists.",
            ]
        )
        if "failure" in results:
            report.extend(
                [
                    "",
                    f"Failure: {results['failure']['type']}: {results['failure']['message']}",
                ]
            )
        (run / "report.md").write_text("\n".join(report) + "\n")
        print(json.dumps({"run": str(run), "status": results["status"]}))
    if results["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
