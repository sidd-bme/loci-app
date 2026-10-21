"""Real trusted RPC/CLI boundaries retain opaque plans and hide private grants."""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile

import pytest
import test_research_data_export as fixtures

from loci_engine.research_project import canonical_json
from loci_engine.research_rpc import dispatch_research


@pytest.fixture
def task(tmp_path):
    yield from fixtures.task.__wrapped__(tmp_path)


def test_manual_cli_plan_response_is_consumed_without_reserializing_plan(task, tmp_path):
    workbench, _, request = task
    project = str(workbench.project.root)
    command = [sys.executable, "-m", "loci_engine.research_cli"]
    planned = subprocess.run(
        command + ["plan-data-export", "--project", project, "--request", json.dumps(request)],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    response = json.loads(planned.stdout)
    assert canonical_json(response["plan"]) == response["plan_json"]
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(planned.stdout, encoding="utf-8")
    target = tmp_path / "csv-data"
    exported = subprocess.run(
        command
        + [
            "export-data",
            "--project",
            project,
            "--plan",
            "@" + str(plan_file),
            "--destination",
            str(target),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    receipt = json.loads(exported.stdout)
    assert receipt["schema"] == "loci.data-export-receipt/v1"
    assert receipt["selected_count"] == response["plan"]["selected_count"]
    assert target.joinpath("objects.csv").is_file()
    assert "destination" not in receipt


def test_trusted_rpc_grant_job_and_portable_archive_keep_destinations_private(task, tmp_path):
    workbench, _, request = task
    project = str(workbench.project.root)
    response = dispatch_research(
        "research_data_export_plan", {"project": project, "request": request}
    )
    target = tmp_path / "csv-data"
    grant = dispatch_research(
        "research_data_export_grant",
        {
            "project": project,
            "plan_json": response["plan_json"],
            "destination": str(target),
        },
    )
    job = dispatch_research(
        "research_submit",
        {
            "project": project,
            "operation": "scientific_data_export",
            "request": {"grant_id": grant["grant_id"], "plan_sha256": grant["plan_sha256"]},
            "request_key": "scientific-export:11111111-1111-4111-8111-111111111111",
        },
    )
    outcome = dispatch_research("research_run", {"project": project, "job_id": job["id"]})
    assert outcome["job"]["state"] == "succeeded"
    snapshot = dispatch_research("research_snapshot", {"project": project})
    assert str(target) not in canonical_json(snapshot)
    archive = tmp_path / "portable.zip"
    dispatch_research("research_project_export", {"project": project, "destination": str(archive)})
    with zipfile.ZipFile(archive) as handle:
        assert not any("data_export_grant" in name for name in handle.namelist())
        for name in handle.namelist():
            if name.endswith(".json"):
                assert str(target).encode() not in handle.read(name)


def test_cancel_between_atomic_publication_and_success_recording_retains_receipt(
    task, tmp_path, monkeypatch
):
    import hashlib

    import loci_engine.research_data_export as exporter
    from loci_engine.research_jobs import cancel_job

    workbench, _, request = task
    project = str(workbench.project.root)
    plan = dispatch_research("research_data_export_plan", {"project": project, "request": request})
    target = tmp_path / "published-before-late-cancel"
    grant = dispatch_research(
        "research_data_export_grant",
        {"project": project, "plan_json": plan["plan_json"], "destination": str(target)},
    )
    job = dispatch_research(
        "research_submit",
        {
            "project": project,
            "operation": "scientific_data_export",
            "request": {"grant_id": grant["grant_id"], "plan_sha256": grant["plan_sha256"]},
            "request_key": "scientific-export:late-cancel",
        },
    )
    original = exporter._rename_noreplace

    def publish_then_cancel(*args, **kwargs):
        original(*args, **kwargs)
        assert target.is_dir()
        cancelled = cancel_job(workbench.project, job["id"])
        assert cancelled["state"] == "running" and cancelled["cancel_requested"]

    monkeypatch.setattr(exporter, "_rename_noreplace", publish_then_cancel)
    receipt = dispatch_research("research_run", {"project": project, "job_id": job["id"]})
    assert receipt["job"]["state"] == "succeeded"
    assert (
        receipt["manifest_sha256"]
        == hashlib.sha256((target / "manifest.json").read_bytes()).hexdigest()
    )
    assert receipt["basename"] == target.name
    assert not list(tmp_path.glob(".loci-data-*"))
