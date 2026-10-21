"""Review regressions at measurement and atomic-publication boundaries."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from test_experiment_intensity import actual_compartment_scene, request
from test_experiment_intensity import study as study  # noqa: F401
from test_intensity_reports import package, run_readers
from test_intensity_reports import reader as reader  # noqa: F401
from test_intensity_reports import saved as saved  # noqa: F401

import loci_engine.research_intensity_export as export
import loci_engine.research_project as project_module
import loci_engine.working_result as working_result
from loci_engine.research_channels import save_channels
from loci_engine.research_intensity_reports import execute, load
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


@pytest.mark.parametrize("compartment", ["cell", "nuclear", "cytoplasm"])
def test_measurement_epoch_survives_native_portable_and_package(tmp_path, compartment, reader):
    declaration = {
        "name": "Corrected raw marker:核/β",
        "marker": "IL4R",
        "fluorophore": "AF647",
        "declaration": "Authored measurement-time declaration",
    }
    wb, result, parents, _ = actual_compartment_scene(tmp_path, declaration=declaration)
    try:
        project = wb.project
        source_path = Path(project.source(result["source_id"])["private_path"])
        source_before = source_path.read_bytes()
        measured = result["provenance"]["compartment_measurement"]["channel_metadata"]
        later = copy.deepcopy(measured["channels"])
        later[0].update(name="Later label", marker="Later marker", fluorophore="Later dye")
        save_channels(
            project,
            {
                "source_id": result["source_id"],
                "channels": later,
                "expected_revision": 1,
            },
        )
        response = execute(
            project,
            "intensity_preview",
            request(
                [result],
                compartment,
                "1: Corrected raw marker:核/β",
            ),
        )
        expected = response["report_json"]
        saved_report = execute(project, "intensity_save", response)
        report = saved_report["report"]
        binding = report["bindings"][0]
        assert binding["measurement_channel_metadata"] == measured
        assert binding["measurement_channel_metadata"]["revision"] == 1
        assert binding["producing_channels"]["revision"] == 0
        assert binding["channels"]["revision"] == 2
        assert binding["channel"]["metadata"] == {"index": 0, **declaration}
        assert [row["value"] for row in report["observations"]] == (
            [-5, None, 0] if compartment == "nuclear" else [-5, -5, 0]
        )
        for role, parent in parents.items():
            assert binding["label_inputs"][role]["revision_hash"] == parent["revision_hash"]
            assert (
                binding["scope"]["label_producers"][role]["input_channel"]["metadata"]
                == (
                    parent["provenance"]["channel_metadata"]["channels"][
                        1 if role == "cells" else 2
                    ]
                )
            )
        identity = saved_report["report_id"]
        reopened = ResearchProject(project.root)
        assert canonical_json(load(reopened, identity)) == expected
        archive = tmp_path / "measurement-epoch.zip"
        receipt = export_project(reopened, archive)
        restored = import_project(
            archive,
            tmp_path / "restored",
            expected_archive_sha256=receipt["archive_sha256"],
        )
        assert canonical_json(load(restored, identity)) == expected
        restored.relink(result["source_id"], source_path)
        assert execute(restored, "intensity_get", {"report_id": identity})["status"]["current"]
        target = tmp_path / "measurement-package"
        package(restored, identity, target)
        assert canonical_json(json.loads((target / "report.json").read_text())) == expected
        assert run_readers(target, reader)[0]["compartment"] == compartment
        assert source_path.read_bytes() == source_before
    finally:
        wb.close()


@pytest.mark.parametrize("phase", ["source-hash", "software-hash", "after-final-plan"])
def test_final_verification_cancel_is_durable_and_leaves_no_package(
    saved, tmp_path, monkeypatch, phase
):
    project, _, _, saved_report = saved
    wb = Workbench(project)
    target = tmp_path / "cancelled-package"
    current = export.plan(project, saved_report["report_id"])
    grant = export.grant(project, saved_report["report_id"], current["plan_hash"], target)
    req = {key: grant[key] for key in ("grant_id", "plan_hash")}
    job = submit_job(wb, req, "final verification cancellation", "intensity_export")
    original_plan = export.plan
    original_hash = working_result._sha256_file_stable
    state = {"plan_calls": 0, "cancelled": False}

    def cancel():
        assert not target.exists()
        assert list(tmp_path.glob(".loci-intensity-*"))
        project.update_job(job["id"], expected_state="running", cancel_requested=True)
        state["cancelled"] = True

    def observed_plan(*args, **kwargs):
        state["plan_calls"] += 1
        assert kwargs.get("check") is not None
        output = original_plan(*args, **kwargs)
        if state["plan_calls"] == 3 and phase == "after-final-plan":
            cancel()
        return output

    def observed_hash(path, **kwargs):
        software = Path(path).name in {
            "research_intensity_export.py",
            "research_intensity_reports.py",
            "intensity_export_readers.py",
        }
        if (
            state["plan_calls"] == 3
            and not state["cancelled"]
            and (
                (phase == "software-hash" and software) or (phase == "source-hash" and not software)
            )
        ):
            assert kwargs.get("check") is not None
            cancel()
        return original_hash(path, **kwargs)

    monkeypatch.setattr(export, "plan", observed_plan)
    monkeypatch.setattr(working_result, "_sha256_file_stable", observed_hash)
    monkeypatch.setattr(project_module, "_sha256_file_stable", observed_hash)
    try:
        with pytest.raises(ValueError, match="cancelled before publication"):
            run_job(wb, job["id"])
        durable = project.job(job["id"])
        assert state["plan_calls"] == 3 and state["cancelled"]
        assert durable["state"] == "cancelled" and durable["cancel_requested"]
        assert durable["finished_at"] and "destination is absent" in durable["error"]
        assert not target.exists()
        assert not list(tmp_path.glob(".loci-intensity-*"))
    finally:
        wb.close()


def test_cancel_after_atomic_rename_retains_success_and_receipt(saved, tmp_path, monkeypatch):
    project, _, _, saved_report = saved
    wb = Workbench(project)
    target = tmp_path / "already-published"
    current = export.plan(project, saved_report["report_id"])
    grant = export.grant(project, saved_report["report_id"], current["plan_hash"], target)
    req = {key: grant[key] for key in ("grant_id", "plan_hash")}
    job = submit_job(wb, req, "late publication cancellation", "intensity_export")
    original_rename = export._rename_noreplace

    def renamed_then_cancel(*args, **kwargs):
        original_rename(*args, **kwargs)
        assert target.is_dir()
        project.update_job(job["id"], expected_state="running", cancel_requested=True)

    monkeypatch.setattr(export, "_rename_noreplace", renamed_then_cancel)
    try:
        output = run_job(wb, job["id"])
        assert output["schema"] == "loci.intensity-export-receipt/v1"
        assert output["report_hash"] == saved_report["report"]["report_hash"]
        assert output["job"]["state"] == "succeeded" and output["job"]["cancel_requested"]
        assert project.job(job["id"])["state"] == "succeeded"
        assert (target / "manifest.json").is_file()
        assert not list(tmp_path.glob(".loci-intensity-*"))
    finally:
        wb.close()
