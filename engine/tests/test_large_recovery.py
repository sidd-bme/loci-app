"""Destructive-process and hostile-table regressions using synthetic disposable studies."""

import hashlib
import os
import sqlite3
import subprocess
import sys
import time

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import reconcile_jobs, run_job, submit_job
from loci_engine.research_project import ResearchProject
from loci_engine.research_session import clone_study
from loci_engine.research_tiled_store import (
    MAX_OBJECT_ROW_BYTES,
    object_rows,
    validate_object_table,
)
from loci_engine.workbench import Workbench


def test_sqlite_rejects_oversized_value_before_returning_it_to_python(tmp_path):
    project = ResearchProject.create(
        tmp_path / "malformed.loci-study", "Synthetic", schema_version=2
    )
    temporary = tmp_path / "table.sqlite3"
    with sqlite3.connect(temporary) as connection:
        connection.execute("CREATE TABLE objects(label INTEGER PRIMARY KEY,record TEXT NOT NULL)")
        connection.execute("INSERT INTO objects VALUES(1,?)", ("x" * (MAX_OBJECT_ROW_BYTES * 4),))
    payload = temporary.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    temporary.rename(project.arrays / (digest + ".sqlite3"))
    descriptor = {
        "schema": "loci.object-table/v1",
        "sha256": digest,
        "bytes": len(payload),
        "count": 1,
    }
    # SQLite itself must refuse materialisation. A later Python JSON/length
    # ValueError would not protect against a valid-hash multi-hundred-MiB row.
    with pytest.raises(sqlite3.DataError, match="too big"):
        object_rows(project, descriptor)
    with pytest.raises(sqlite3.DataError, match="too big"):
        validate_object_table(project, descriptor)


@pytest.mark.skipif(os.name == "nt", reason="SIGKILL interruption qualification is POSIX-specific")
def test_killed_measurement_retry_and_save_as(tmp_path):
    source_path = tmp_path / "synthetic.ome.tif"
    pixels = np.zeros((64, 64), np.uint16)
    pixels[5:9, 5:9] = 200
    tifffile.imwrite(
        source_path,
        pixels,
        tile=(32, 32),
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.75,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
        },
    )
    project = ResearchProject.create(tmp_path / "work.loci-study", "Interrupted", schema_version=2)
    wb = Workbench(project)
    source = wb.import_native(str(source_path))
    request = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 64,
            "height": 64,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "segmentation": {"method": "components", "threshold": 100},
        "working_bytes": 256 * 1024**2,
    }
    job = submit_job(wb, request, "will-be-killed", operation="large_components_run")
    marker = tmp_path / "measurement-started"
    code = """
import sys,time
from pathlib import Path
from loci_engine.research_project import ResearchProject
from loci_engine.research_jobs import run_job
from loci_engine.research_tiled_store import ObjectTableWriter
from loci_engine.workbench import Workbench
original=ObjectTableWriter.append
def pause(self,row):
    original(self,row)
    self._connection.commit()
    Path(sys.argv[3]).write_text("writing")
    time.sleep(30)
ObjectTableWriter.append=pause
run_job(Workbench(ResearchProject(sys.argv[1])),sys.argv[2])
"""
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(project.root), job["id"], str(marker)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists(), process.communicate(timeout=1)
        process.kill()
        process.wait(timeout=5)
        assert process.returncode < 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    assert list(project.root.glob(".objects-*.sqlite3")), "The real killed staging file is retained"
    assert not list(project.arrays.glob(".objects-*"))
    assert project.list_results() == []
    interrupted = reconcile_jobs(project)
    assert interrupted[0]["state"] == "interrupted"
    retry = submit_job(wb, request, "explicit-retry", operation="large_components_run")
    finished = run_job(wb, retry["id"])
    assert finished["job"]["state"] == "succeeded"
    rid = finished["job"]["result_ids"][0]
    result = project.result(rid)
    assert result["object_count"] == 1
    cloned = clone_study(project, tmp_path / "recovered.loci-study")
    assert cloned.result(rid) == result
    assert not list(cloned.root.glob(".objects-*"))
    wb.close()


def _fixture_study(tmp_path):
    source_path = tmp_path / "source.ome.tif"
    image = np.zeros((64, 64), np.uint16)
    image[5:9, 5:9] = 200
    image[30:35, 30:35] = 300
    tifffile.imwrite(
        source_path,
        image,
        tile=(32, 32),
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.75,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
        },
    )
    project = ResearchProject.create(tmp_path / "work.loci-study", "Recovery", schema_version=2)
    wb = Workbench(project)
    source = wb.import_native(str(source_path))
    request = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 64,
            "height": 64,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "segmentation": {"method": "components", "threshold": 100},
        "working_bytes": 256 * 1024**2,
    }
    return wb, request


def _kill_at_marker(code, project, token, marker):
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(project.root), token, str(marker)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists(), process.communicate(timeout=1)
        process.kill()
        process.wait(timeout=5)
        assert process.returncode < 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.skipif(os.name == "nt", reason="SIGKILL qualification is POSIX-specific")
@pytest.mark.parametrize("operation", ["large_components_run", "large_result_delete"])
def test_killed_chunk_generation_publishes_no_revision_and_retry_is_explicit(tmp_path, operation):
    wb, request = _fixture_study(tmp_path)
    project = wb.project
    parent = None
    if operation == "large_result_delete":
        output = wb.execute("large_components_run", request)
        parent = project.result(output["result"]["id"])
        request = {"result_id": parent["id"], "revision_hash": parent["revision_hash"], "label": 1}
    job = submit_job(wb, request, "interrupted-chunks", operation=operation)
    code = """
import sys,time
from pathlib import Path
from loci_engine.research_project import ResearchProject
from loci_engine.research_jobs import run_job
from loci_engine.research_tiled_store import TiledArrayWriter
from loci_engine.workbench import Workbench
original=TiledArrayWriter.write
def pause(self,y,x,values):
    original(self,y,x,values)
    Path(sys.argv[3]).write_text("core-written")
    time.sleep(30)
TiledArrayWriter.write=pause
run_job(Workbench(ResearchProject(sys.argv[1])),sys.argv[2])
"""
    _kill_at_marker(code, project, job["id"], tmp_path / "chunk-started")
    assert len(project.list_results()) == (1 if parent else 0)
    assert (
        next(item for item in reconcile_jobs(project) if item["id"] == job["id"])["state"]
        == "interrupted"
    )
    if parent:
        assert project.result(parent["id"]) == parent
    retry = submit_job(wb, request, "explicit-chunk-retry", operation=operation)
    output = run_job(wb, retry["id"])
    assert output["job"]["state"] == "succeeded"
    assert len(project.list_results()) == (2 if parent else 1)
    result = project.result(output["job"]["result_ids"][0])
    assert result["object_count"] == (1 if parent else 2)
    if parent:
        assert object_rows(project, result["object_table"])[0]["label"] == 2
        assert project.result(parent["id"]) == parent
    copied = clone_study(project, tmp_path / "reopened.loci-study")
    assert copied.result(result["id"]) == result
    wb.close()


@pytest.mark.skipif(os.name == "nt", reason="SIGKILL qualification is POSIX-specific")
def test_killed_export_leaves_no_success_destination_and_retry_is_atomic(tmp_path):
    from loci_engine.research_export import export_research_result

    wb, request = _fixture_study(tmp_path)
    project = wb.project
    output = wb.execute("large_components_run", request)
    result = project.result(output["result"]["id"])
    review = project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "published-result"
    code = """
import sys,time
from pathlib import Path
from loci_engine.research_project import ResearchProject
from loci_engine import research_large_export
project=ResearchProject(sys.argv[1])
result=project.result(sys.argv[2])
original=research_large_export._write_grid
def pause(*args, check=None):
    original(*args, check=check)
    Path(sys.argv[3]).write_text("tiff-written")
    time.sleep(30)
research_large_export._write_grid=pause
research_large_export.export_large_result(project,result["id"],result["revision_hash"],project.root.parent/"published-result")
"""
    _kill_at_marker(code, project, result["id"], tmp_path / "export-started")
    assert not destination.exists()
    assert list(tmp_path.glob(".loci-export-*")), "Killed private staging is retained as evidence"
    assert project.result(result["id"]) == result
    assert project.review_state(result["id"]) == review
    receipt = export_research_result(project, result["id"], result["revision_hash"], destination)
    assert receipt["revision_hash"] == result["revision_hash"]
    assert destination.joinpath("manifest.json").is_file()
    assert len(project.list_results()) == 1
    wb.close()
