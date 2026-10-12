#!/usr/bin/env python3
"""Actual SIGKILL/retry qualification of the synthetic 16k large-result importer.

Run only with an explicitly selected synthetic source and uncorrected exported
bundle, in an absent output directory. All attempts, private artifacts and logs
are retained. The default child runs the production research_cli module; the
optional table checkpoint wraps the same CLI in a child-only SIGSTOP hook just
before the real private table staging file would be renamed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import traceback
import uuid

REPO = Path(__file__).resolve().parents[1]
ENGINE = REPO / "engine" / "src"
VERIFY = REPO / "scripts" / "verify-large-exchange.py"
SIDE = 16_384
EXPECTED_OBJECTS = 1_026
POLL_SECONDS = 0.02
CORE_TRIGGER = 8


def stamp():
    return datetime.now(timezone.utc).isoformat()


def file_identity(path):
    path = Path(path)
    stat = path.lstat()
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Expected a plain file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    after = path.lstat()
    if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
    ):
        raise ValueError(f"Input changed while hashing: {path}")
    return {"sha256": digest.hexdigest(), "bytes": stat.st_size}


def input_identities(source, bundle):
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Remote bundle has no manifest file list")
    names = set()
    files = {}
    for entry in entries:
        name = entry["name"]
        if not isinstance(name, str) or Path(name).name != name or name in names:
            raise ValueError("Remote bundle manifest has an invalid file name")
        names.add(name)
        files[name] = file_identity(bundle / name)
        if files[name] != {"sha256": entry["sha256"], "bytes": entry["size_bytes"]}:
            raise ValueError(f"Remote bundle artifact changed: {name}")
    required = {"result.json", "objects.sqlite3", "objects.csv", "image.ome.tif", "labels.ome.tif"}
    if not required <= names:
        raise ValueError("Remote bundle lacks a required artifact")
    return {"source": file_identity(source), "manifest": file_identity(manifest_path), "files": files}


def source_code_identity():
    selected = [
        REPO / "scripts" / "qualify-large-exchange-interruption.py",
        VERIFY,
        ENGINE / "loci_engine" / "research_cli.py",
        ENGINE / "loci_engine" / "research_jobs.py",
        ENGINE / "loci_engine" / "research_large_exchange.py",
        ENGINE / "loci_engine" / "research_project.py",
        ENGINE / "loci_engine" / "research_tiled_store.py",
        ENGINE / "loci_engine" / "native_image.py",
        ENGINE / "loci_engine" / "workbench.py",
    ]
    git = lambda *args: subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()
    return {
        "head": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"),
        "status": git("status", "--porcelain"),
        "selected_file_sha256": {str(p.relative_to(REPO)): file_identity(p)["sha256"] for p in selected},
    }


def artifact_counts(study):
    artifacts = study / "artifacts"
    return {
        "published_npy": len(list(artifacts.glob("*.npy"))),
        "published_sqlite3": len(list(artifacts.glob("*.sqlite3"))),
        "private_table_staging": len(list(study.glob(".table-staging-*"))),
        "other_private_staging": len(list(study.glob(".objects-*.sqlite3"))),
    }


def cli_command(python, study, job_id):
    return [str(python), "-m", "loci_engine.research_cli", "run", "--project", str(study), "--job", job_id]


TABLE_CHECKPOINT_CHILD = r"""
import os, signal, sys, time
from pathlib import Path
import loci_engine.research_large_exchange as exchange
from loci_engine.research_cli import main
original = exchange._rename_noreplace
marker = Path(os.environ['LOCI_QA_TABLE_STOP_MARKER'])
def stop_before_table_publish(source, target):
    if Path(source).name.startswith('.table-staging-'):
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, (str(os.getpid()) + '\n' + str(time.time_ns()) + '\n').encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.kill(os.getpid(), signal.SIGSTOP)
    return original(source, target)
exchange._rename_noreplace = stop_before_table_publish
raise SystemExit(main(sys.argv[1:]))
"""


def run_process(command, env, stdout_path, stderr_path):
    stdout = stdout_path.open("xb")
    stderr = stderr_path.open("xb")
    try:
        process = subprocess.Popen(command, cwd=REPO, env=env, stdout=stdout, stderr=stderr)
    finally:
        stdout.close()
        stderr.close()
    return process


def wait_and_kill(process, project, study, job_id, kill_point, marker, baseline, timeout):
    deadline = time.monotonic() + timeout
    observations = 0
    last_counts = baseline
    while time.monotonic() < deadline:
        observations += 1
        if kill_point == "cores":
            last_counts = artifact_counts(study)
            triggered = last_counts["published_npy"] - baseline["published_npy"] >= CORE_TRIGGER
        else:
            triggered = marker.is_file() and any(study.glob(".table-staging-*"))
            if triggered:
                last_counts = artifact_counts(study)
        if triggered:
            if process.poll() is not None:
                raise AssertionError("Adoption child exited before SIGKILL; no interruption qualified")
            if project.list_results():
                raise AssertionError("Result was already published before SIGKILL; no interruption qualified")
            job = project.job(job_id)
            if job["state"] != "running" or job.get("pid") != process.pid:
                raise AssertionError(f"Adoption job was not running in the observed child PID: {job['state']}")
            observed = {"utc": stamp(), "monotonic_seconds": time.monotonic(), "file_counts": last_counts, "polls": observations,
                        "pid": process.pid, "job_id": job_id,
                        "marker": marker.read_text().strip().splitlines() if marker.is_file() else None}
            os.kill(process.pid, signal.SIGKILL)
            process.wait(timeout=30)
            if process.returncode != -signal.SIGKILL:
                raise AssertionError(f"Expected actual SIGKILL exit; child returned {process.returncode}")
            return observed
        if process.poll() is not None:
            raise AssertionError(f"Adoption child exited before kill point with code {process.returncode}")
        time.sleep(POLL_SECONDS)
    raise TimeoutError(f"Adoption did not reach {kill_point} within {timeout} seconds; last counts {last_counts}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Explicit synthetic 16384x16384 source.ome.tif")
    parser.add_argument("--bundle", type=Path, required=True, help="Explicit uncorrected large-result export directory")
    parser.add_argument("--output-root", type=Path, required=True, help="Absent directory for study and retained evidence")
    parser.add_argument("--python", type=Path, default=REPO / "engine" / ".venv" / "bin" / "python")
    parser.add_argument("--kill-point", choices=["cores", "table-prepublish"], default="cores")
    parser.add_argument("--kill-timeout-seconds", type=int, default=900)
    parser.add_argument("--retry-timeout-seconds", type=int, default=1800)
    args = parser.parse_args()
    source, bundle, root, python = (p.expanduser().absolute() for p in (args.source, args.bundle, args.output_root, args.python))
    if os.name != "posix":
        raise RuntimeError("Actual SIGKILL qualification requires POSIX")
    if source.name != "source.ome.tif" or source.is_symlink() or not source.is_file():
        raise ValueError("Use the explicit plain 16k synthetic source.ome.tif")
    if bundle.is_symlink() or not bundle.is_dir() or root.exists() or root.is_symlink():
        raise ValueError("Bundle must exist plainly and output root must be absent")
    if root.is_relative_to(bundle) or bundle.is_relative_to(root) or root == source or source.is_relative_to(root):
        raise ValueError("Inputs and output must be separate")
    if not python.is_file() or not python.resolve(strict=True).is_file():
        raise ValueError("Select an existing Python interpreter; no dependency installation occurs")
    if not root.parent.is_dir():
        raise ValueError("Output parent must already exist")

    root.mkdir(mode=0o700)
    study = root / "adoption.loci-study"
    marker = root / "table-prepublish.stopped"
    receipt = {"schema": "loci.large-exchange-interruption-qa/v1", "status": "running", "started_at": stamp(),
               "kill_point": args.kill_point, "instrumented_checkpoint": args.kill_point == "table-prepublish",
               "study": str(study), "source": str(source), "bundle": str(bundle), "output_root": str(root),
               "python": str(python), "poll_interval_seconds": POLL_SECONDS, "core_trigger": CORE_TRIGGER if args.kill_point == "cores" else None,
               "stages": []}
    child = None
    try:
        # Imports occur only after the source/bundle/output path boundary is fixed.
        sys.path.insert(0, str(ENGINE))
        import tifffile
        from loci_engine.research_jobs import reconcile_jobs, submit_job
        from loci_engine.research_large_exchange import create_exchange_grant
        from loci_engine.research_project import ResearchProject
        from loci_engine.workbench import Workbench

        with tifffile.TiffFile(source) as tif:
            if (len(tif.pages) != 1 or tif.pages[0].shape != (SIDE, SIDE)
                    or str(tif.pages[0].dtype) != "uint16" or not tif.pages[0].is_tiled
                    or tif.pages[0].tilewidth != 512 or tif.pages[0].tilelength != 512):
                raise ValueError("Source is outside declared 16k single-plane tiled scope")
        receipt["inputs_before"] = input_identities(source, bundle)
        remote = json.loads((bundle / "result.json").read_text(encoding="utf-8"))
        if remote["source"]["sha256"] != receipt["inputs_before"]["source"]["sha256"]:
            raise ValueError("Bundle source identity differs from local synthetic fixture")
        if remote["result"]["source_sha256"] != receipt["inputs_before"]["source"]["sha256"]:
            raise ValueError("Bundle result source identity differs from local synthetic fixture")
        if remote["result"]["parent_id"] is not None or remote["result"]["object_count"] != EXPECTED_OBJECTS:
            raise ValueError("Bundle is not the expected uncorrected 16k result")
        receipt["remote_claims"] = {"result_id": remote["result"]["id"], "revision_hash": remote["result"]["revision_hash"],
                                    "source_sha256": remote["result"]["source_sha256"], "runtime": remote["result"]["provenance"]["runtime"]}
        receipt["source_code"] = source_code_identity()

        project = ResearchProject.create(study, "Synthetic M6 adoption interruption", schema_version=2)
        workbench = Workbench(project)
        registered = workbench.import_native(str(source))
        if registered["sha256"] != receipt["inputs_before"]["source"]["sha256"]:
            raise AssertionError("Registered source fingerprint differs from selected fixture")
        grant = create_exchange_grant(project, registered["id"], str(bundle))
        request = {"source_id": registered["id"], "grant_id": grant["grant_id"], "manifest_sha256": grant["manifest_sha256"]}
        first_key = uuid.uuid4().hex
        first_job = submit_job(workbench, request, first_key, operation="large_result_adopt")
        if first_job["state"] != "queued" or project.list_results():
            raise AssertionError("First adoption was not queued into an empty study")
        receipt["first_job"] = {"id": first_job["id"], "request_key": first_key, "grant_id": grant["grant_id"],
                                "manifest_sha256": grant["manifest_sha256"]}
        baseline = artifact_counts(study)
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ENGINE)
        env.pop("LOCI_QA_TABLE_STOP_MARKER", None)
        if args.kill_point == "table-prepublish":
            env["LOCI_QA_TABLE_STOP_MARKER"] = str(marker)
            command = [str(python), "-c", TABLE_CHECKPOINT_CHILD, "run", "--project", str(study), "--job", first_job["id"]]
        else:
            command = cli_command(python, study, first_job["id"])
        child = run_process(command, env, root / "first-run.stdout.json", root / "first-run.stderr.log")
        receipt["first_job"]["pid"] = child.pid
        receipt["first_job"]["command_mode"] = "production CLI main with child-only table SIGSTOP hook" if args.kill_point == "table-prepublish" else "production research_cli module"
        receipt["first_job"]["launched_at"] = stamp()
        killed = wait_and_kill(child, project, study, first_job["id"], args.kill_point, marker, baseline, args.kill_timeout_seconds)
        receipt["first_job"].update({"killed_at": killed["utc"], "kill_observation": killed,
                                     "returncode": child.returncode, "artifacts_after_kill": artifact_counts(study)})
        child = None
        jobs = reconcile_jobs(project)
        interrupted = next(job for job in jobs if job["id"] == first_job["id"])
        if interrupted["state"] != "interrupted" or project.list_results():
            raise AssertionError("Killed adoption did not reconcile to interrupted with zero published results")
        if submit_job(workbench, request, first_key, operation="large_result_adopt")["id"] != first_job["id"]:
            raise AssertionError("Original request key no longer identifies its interrupted job")
        receipt["first_job"]["reconciled_state"] = interrupted["state"]
        receipt["first_job"]["published_results_after_reconcile"] = 0

        retry_key = uuid.uuid4().hex
        if retry_key == first_key:
            raise AssertionError("Fresh retry key collided")
        retry = submit_job(workbench, request, retry_key, operation="large_result_adopt")
        if retry["id"] == first_job["id"] or retry["state"] != "queued":
            raise AssertionError("Retry reused interrupted job or did not queue")
        receipt["retry_job"] = {"id": retry["id"], "request_key": retry_key, "launched_at": stamp()}
        retry_command = cli_command(python, study, retry["id"])
        retry_env = env.copy()
        retry_env.pop("LOCI_QA_TABLE_STOP_MARKER", None)
        child = run_process(retry_command, retry_env, root / "retry.stdout.json", root / "retry.stderr.log")
        receipt["retry_job"]["pid"] = child.pid
        try:
            child.wait(timeout=args.retry_timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("Retry exceeded declared timeout") from exc
        receipt["retry_job"]["returncode"] = child.returncode
        receipt["retry_job"]["finished_at"] = stamp()
        child = None
        if receipt["retry_job"]["returncode"] != 0:
            raise AssertionError("Explicit retry process failed; retained stderr has exact diagnostic")
        jobs = reconcile_jobs(project)
        completed = next(job for job in jobs if job["id"] == retry["id"])
        if completed["state"] != "succeeded" or next(job for job in jobs if job["id"] == first_job["id"])["state"] != "interrupted":
            raise AssertionError("Retry did not succeed while original remained interrupted")
        results = project.list_results()
        if len(results) != 1:
            raise AssertionError(f"Expected one published adopted root after retry, got {len(results)}")
        result = results[0]
        if result["schema"] != "loci.research-result/v2" or result["kind"] != "large-components" or result["parent_id"] is not None:
            raise AssertionError("Retry published the wrong result kind or lineage")
        if result["source_id"] != registered["id"] or result["source_sha256"] != registered["sha256"]:
            raise AssertionError("Retry result lost exact local source binding")
        if result["object_count"] != EXPECTED_OBJECTS:
            raise AssertionError("Retry result object count differs from 16k oracle")
        exchange = result["provenance"]["remote_exchange"]
        if (exchange["manifest_sha256"] != grant["manifest_sha256"]
                or exchange["remote_result_id"] != remote["result"]["id"]
                or exchange["remote_revision_hash"] != remote["result"]["revision_hash"]):
            raise AssertionError("Retry result lost exact remote source/result binding")
        receipt["retry_job"].update({"state": completed["state"], "result_id": result["id"],
                                     "revision_hash": result["revision_hash"], "artifacts_after_retry": artifact_counts(study)})

        oracle = subprocess.run([str(python), str(VERIFY), "--study", str(study), "--result-id", result["id"]],
                                cwd=REPO, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=1800, check=False)
        (root / "oracle.stdout.json").write_text(oracle.stdout, encoding="utf-8")
        (root / "oracle.stderr.log").write_text(oracle.stderr, encoding="utf-8")
        if oracle.returncode != 0:
            raise AssertionError("Independent 16k study oracle failed; retained stderr has exact diagnostic")
        receipt["independent_oracle"] = json.loads(oracle.stdout)
        final_code = source_code_identity()
        if final_code["selected_file_sha256"] != receipt["source_code"]["selected_file_sha256"]:
            raise AssertionError("Qualification source files changed during execution")
        receipt["source_code_after"] = final_code
        receipt["inputs_after"] = input_identities(source, bundle)
        if receipt["inputs_after"] != receipt["inputs_before"]:
            raise AssertionError("Source or remote bundle changed during qualification")
        receipt["finished_at"] = stamp()
        receipt["status"] = "passed"
    except BaseException as exc:
        receipt["status"] = "failed"
        receipt["failed_at"] = stamp()
        receipt["error"] = {"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()}
        if child is not None:
            receipt["failed_child"] = {"pid": child.pid, "returncode_at_failure": child.poll()}
        if child is not None and child.poll() is None:
            os.kill(child.pid, signal.SIGKILL)
            child.wait(timeout=30)
            receipt["failed_child_cleanup"] = {"pid": child.pid, "signal": "SIGKILL", "returncode": child.returncode}
        if study.exists():
            receipt["failure_artifacts"] = artifact_counts(study)
    finally:
        (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": receipt["status"], "receipt": str(root / "receipt.json")}, sort_keys=True))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
