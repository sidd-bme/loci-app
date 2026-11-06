"""Opt-in real local tissue graph timing on an isolated failed-study copy.

Never modifies the failed study or supplied source/model/golden artifacts. Uses
normal resource-bounded, exact-supervisor source CLI children. The only child
instrumentation counts annotation method-identity calls and returns the unchanged
native identity. Source elapsed time is supplemental; packaged QA is decisive.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024**2):
            value.update(block)
    return value.hexdigest()


def child(project, job, parent, memory, counts):
    from loci_engine import research_annotation_evaluation as annotation
    from loci_engine.research_cli import main

    original = annotation._software
    calls = 0

    def counted():
        nonlocal calls
        calls += 1
        return original()

    annotation._software = counted
    from loci_engine.research_project import ResearchProject

    operation = ResearchProject(project).job(job)["operation"]
    arguments = [
        "run",
        "--project",
        project,
        "--job",
        job,
        "--cpu-seconds",
        "600",
        "--memory-bytes",
        str(memory),
    ]
    if operation in {"tissue_model_preview", "tissue_model_run"}:
        arguments.extend(["--supervisor-pid", str(parent)])
    try:
        return main(arguments)
    finally:
        Path(counts).write_text(json.dumps({"annotation_method_identity_calls": calls}) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--failed-study", type=Path)
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--model-home", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--child-project")
    parser.add_argument("--child-job")
    parser.add_argument("--child-parent", type=int)
    parser.add_argument("--child-memory", type=int)
    parser.add_argument("--child-counts")
    args = parser.parse_args()
    if args.child_project:
        return child(
            args.child_project,
            args.child_job,
            args.child_parent,
            args.child_memory,
            args.child_counts,
        )
    for key in ("failed_study", "inputs", "model_home", "output"):
        value = getattr(args, key)
        if value is None or not value.is_absolute():
            parser.error(f"--{key.replace('_', '-')} requires an explicit absolute path")
    if args.output.exists():
        parser.error("Output must be absent; existing evidence is never overwritten")
    with sqlite3.connect(
        (args.failed_study / "study.sqlite3").as_uri() + "?mode=ro", uri=True
    ) as db:
        records = [json.loads(row[0]) for row in db.execute("SELECT record FROM jobs")]
        if any(job["state"] in {"queued", "running"} for job in records):
            parser.error("Failed evidence still has active native jobs; do not copy a live study")
    args.output.mkdir()
    receipt = {
        "status": "running",
        "failed_study": str(args.failed_study),
        "schema": "loci.source-tissue-graph-guard-qa/v1",
        "jobs": [],
        "limits": [
            "Real source-runtime engineering regression; no packaged or scientific qualification",
            "Only method identity call counts are instrumented; native identity is unchanged",
            "Golden arrays measure deterministic regression, not independent accuracy",
        ],
    }
    workbench = None
    try:
        import numpy as np

        from loci_engine.research_jobs import submit_job
        from loci_engine.research_project import ResearchProject
        from loci_engine.research_task_preview import get_preview
        from loci_engine.research_tissue_models import peek_preview
        from loci_engine.research_workflow_graph import execute_workflow_graph
        from loci_engine.workbench import Workbench

        root = Path(__file__).resolve().parents[2]
        tracked = [
            "engine/src/loci_engine/research_workflow_graph.py",
            "engine/src/loci_engine/workflow_graph.py",
            "engine/src/loci_engine/research_jobs.py",
            "engine/src/loci_engine/research_project.py",
        ]
        receipt["source"] = {
            "head": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip(),
            "files": {name: digest(root / name) for name in tracked},
            "reproducer_sha256": digest(__file__),
        }
        manifest = json.loads(args.inputs.read_text())
        inputs = manifest["inputs"]
        for name in (
            "source",
            "weights",
            "conversion_receipt",
            "reference_receipt",
            "reference_classes",
            "reference_probabilities",
        ):
            value = inputs[name]
            assert digest(value["path"]) == value["sha256"], name
            assert Path(value["path"]).stat().st_size == value["bytes"], name
        receipt["input_manifest_sha256"] = digest(args.inputs)
        project_path = args.output / "isolated.loci-study"
        shutil.copytree(args.failed_study, project_path)
        project = ResearchProject(project_path)
        workbench = Workbench(project)
        original = next(
            doc
            for doc in project.documents("workflow_run")
            if any(
                node["operation"] == "tissue_model_run"
                for node in doc["data"].get("plan", {}).get("definition", {}).get("nodes", [])
            )
        )
        plan = original["data"]["plan"]
        prepared = next(
            binding
            for name, binding in plan["bindings"].items()
            if plan["definition"]["inputs"][name] == "tissue-preview"
        )
        source_request = prepared["receipt"]["request"]
        assert source_request["source_sha256"] == inputs["source"]["sha256"]
        assert source_request["weights_sha256"] == inputs["weights"]["sha256"]
        source = args.output / "source-copy.tif"
        shutil.copyfile(inputs["source"]["path"], source)
        project.relink(source_request["source_id"], source)
        os.environ["LOCI_MODEL_HOME"] = str(args.model_home)

        def run_child(job):
            counts = args.output / f"{job['id']}-counts.json"
            started = time.perf_counter()
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--child-project",
                str(project_path),
                "--child-job",
                job["id"],
                "--child-parent",
                str(os.getpid()),
                "--child-memory",
                str(source_request["working_bytes"]),
                "--child-counts",
                str(counts),
            ]
            output = subprocess.run(
                command, text=True, capture_output=True, timeout=180, check=False
            )
            (args.output / f"{job['id']}-stdout.txt").write_text(output.stdout)
            (args.output / f"{job['id']}-stderr.txt").write_text(output.stderr)
            saved = project.job(job["id"])
            row = {
                "job_id": job["id"],
                "operation": job["operation"],
                "state": saved["state"],
                "elapsed_seconds": time.perf_counter() - started,
                "exit_code": output.returncode,
                **(
                    json.loads(counts.read_text())
                    if counts.exists()
                    else {"annotation_method_identity_calls": None}
                ),
            }
            receipt["jobs"].append(row)
            assert output.returncode == 0 and saved["state"] == "succeeded", row
            assert row["annotation_method_identity_calls"] is not None, row
            if job["operation"] == "tissue_model_run" and job["request_key"].startswith(
                "graph-v2:"
            ):
                assert row["annotation_method_identity_calls"] == 2, row
            return saved

        preview = submit_job(
            workbench, source_request, uuid4().hex, operation="tissue_model_preview"
        )
        run_child(preview)
        response = get_preview(project, preview["id"])["preview"]["output"]
        token = {key: response[key] for key in ("preview_id", "preview_hash")}
        native = peek_preview(project, token)
        bindings = dict(plan["bindings"])
        for name, kind in plan["definition"]["inputs"].items():
            if kind == "tissue-preview":
                bindings[name] = {
                    key: native[key] for key in ("preview_id", "preview_hash", "receipt")
                }
        definition = {**plan["definition"], "name": "Isolated source guard timing regression"}

        def call(suffix, request):
            return execute_workflow_graph(
                workbench,
                "workflow_graph_" + suffix,
                request,
                authorize=lambda *_: None,
                authorize_binding=lambda *_: None,
            )

        saved = call(
            "save", {"workflow_id": uuid4().hex, "expected_revision": 0, "definition": definition}
        )["workflow"]
        binding = {
            "workflow_id": saved["id"],
            "workflow_revision": saved["revision"],
            "definition_sha256": saved["data"]["definition_sha256"],
            "bindings": bindings,
        }
        checked = call("preflight", binding)["plan"]
        run = call(
            "start", {**binding, "plan_sha256": checked["plan_sha256"], "request_key": uuid4().hex}
        )["run"]
        for _ in definition["nodes"]:
            run = call("advance", {"run_id": run["id"]})["run"]
            entry = next(
                entry for entry in run["data"]["nodes"].values() if entry["state"] == "queued"
            )
            run_child(project.job(entry["intent"]["job_id"]))
            run = call("status", {"run_id": run["id"]})["run"]
        assert run["data"]["state"] == "succeeded"
        candidate_id = run["data"]["nodes"][
            next(
                node["id"]
                for node in definition["nodes"]
                if node["operation"] == "tissue_model_run"
            )
        ]["output"]["result_id"]
        candidate = project.result(candidate_id)
        for key, name in (
            ("class_labels", "reference_classes"),
            ("probabilities", "reference_probabilities"),
        ):
            actual = project.load_array(candidate["arrays"][key])
            expected = np.load(inputs[name]["path"], allow_pickle=False)
            assert actual.dtype == expected.dtype and actual.shape == expected.shape
            assert actual.tobytes() == expected.tobytes(), key
        receipt.update(
            status="passed",
            run_id=run["id"],
            candidate_id=candidate_id,
            source_runtime=checked["runtime"],
            golden_arrays_bitwise_equal=True,
        )
    except BaseException as error:
        receipt.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        if workbench is not None:
            workbench.close()
        (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"status": receipt["status"], "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
