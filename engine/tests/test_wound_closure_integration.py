"""Native report jobs, portable mask replay and private destination grants."""

import copy
import csv
import hashlib
import json
import zipfile

import numpy as np
import pytest
import test_research_wound_closure as fixtures

from loci_engine import research_rpc
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_wound_closure import DOCUMENT_KIND, GRANT_KIND, PAGE_BYTES, PREVIEW_PREFIX
from loci_engine.workbench import Workbench


@pytest.fixture
def wound(tmp_path):
    yield from fixtures.wound.__wrapped__(tmp_path)


def token(preview):
    return {key: preview[key] for key in ("preview_id", "preview_hash")}


def saved(wb, request, key="save-wound"):
    opaque = token(wb.execute("wound_closure_preview", request))
    job = submit_job(wb, opaque, key, operation="wound_closure_save")
    return run_job(wb, job["id"]), opaque


def test_native_report_requires_own_durable_save_job_and_replays_without_new_result(wound):
    wb, request, records, masks = wound
    before = copy.deepcopy(records)
    opaque = token(wb.execute("wound_closure_preview", request))
    with pytest.raises(ValueError, match="durable native job"):
        wb.execute("wound_closure_save", opaque)
    job = submit_job(wb, opaque, "exact-wound", operation="wound_closure_save")
    output = run_job(wb, job["id"])
    assert output["job"]["state"] == "succeeded"
    assert output["job"]["result_ids"] == []
    assert output["job"]["report_id"] == output["report_id"] == opaque["preview_id"]
    assert output["report"]["request"] == request
    assert submit_job(wb, opaque, "exact-wound", operation="wound_closure_save")["id"] == job["id"]
    assert run_job(wb, job["id"])["job"]["report_id"] == output["report_id"]
    assert len(wb.project.documents(DOCUMENT_KIND)) == len(wb.project.list_jobs()) == 1
    assert len(wb.project.list_results()) == 4
    assert "review" not in output and "review" not in output["report"]
    page = wb.execute(
        "wound_closure_query",
        {
            "report_id": output["report_id"],
            "table": "frames",
            "offset": 0,
            "limit": 100,
        },
    )
    assert len(canonical_json(page).encode()) <= PAGE_BYTES
    assert [row["area"] for row in page["rows"]] == [72, None, 36, 108, 0]
    assert [row["closure_fraction"] for row in page["rows"]] == [0, None, 0.5, -0.5, 1]
    intervals = wb.execute(
        "wound_closure_query",
        {
            **opaque,
            "table": "intervals",
            "offset": 0,
            "limit": 100,
        },
    )["rows"]
    assert [row["area_change_rate"] for row in intervals] == [None, None, 1.2, -1.8]
    assert [row["status"] for row in intervals[:2]] == ["missing_endpoint", "missing_endpoint"]
    labels = wb.execute(
        "wound_closure_query",
        {
            **opaque,
            "table": "selected_labels",
            "frame_id": "frame-2",
            "offset": 0,
            "limit": 1,
        },
    )
    assert labels["rows"] == [1] and labels["total"] == 1
    for t, record in records.items():
        assert wb.project.result(record["id"]) == before[t]
        assert wb.project.review_state(record["id"]) is None
        np.testing.assert_array_equal(wb.project.load_array(record["arrays"]["labels"]), masks[t])


def test_cancelled_save_and_revoked_publication_produce_no_report(wound):
    wb, request, _, _ = wound
    opaque = token(wb.execute("wound_closure_preview", request))
    job = submit_job(wb, opaque, "cancel-before-save", operation="wound_closure_save")
    cancel_job(wb.project, job["id"])
    assert run_job(wb, job["id"])["job"]["state"] == "cancelled"
    other = submit_job(wb, opaque, "revoke-save", operation="wound_closure_save")

    def revoke():
        raise PermissionError("Fixture authority revoked")

    with pytest.raises(PermissionError, match="revoked"):
        run_job(wb, other["id"], publication_guard=revoke)
    assert wb.project.job(other["id"])["state"] == "failed"
    assert wb.project.documents(DOCUMENT_KIND) == []


@pytest.mark.parametrize("change", ["sample", "mask", "source", "token"])
def test_save_rechecks_every_preview_dependency_and_fails_before_report_publication(wound, change):
    wb, request, records, _ = wound
    opaque = token(wb.execute("wound_closure_preview", request))
    job = submit_job(wb, opaque, "changed-before-save", operation="wound_closure_save")
    source = records[0]["source_id"]
    if change == "sample":
        document = wb.project.documents("sample", document_id=source)[0]
        wb.project.put_document(
            "sample",
            source,
            {**document["data"], "condition": "changed"},
            expected_revision=document["revision"],
        )
    elif change == "mask":
        path = wb.project.arrays / (records[2]["arrays"]["labels"]["sha256"] + ".npy")
        path.write_bytes(path.read_bytes() + b"changed")
    elif change == "source":
        from pathlib import Path

        path = Path(wb.project.source(source)["private_path"])
        path.write_bytes(path.read_bytes() + b"changed")
    else:
        with wb.project.connection() as connection:
            connection.execute(
                "DELETE FROM metadata WHERE key=?", (PREVIEW_PREFIX + opaque["preview_id"],)
            )
    with pytest.raises((ValueError, OSError)):
        run_job(wb, job["id"])
    assert wb.project.job(job["id"])["state"] == "failed"
    assert wb.project.documents(DOCUMENT_KIND) == []


def test_cold_reopen_and_portable_study_preserve_report_arrays_and_historical_job(wound, tmp_path):
    wb, request, records, masks = wound
    output, _ = saved(wb, request)
    reopened = Workbench(ResearchProject(wb.project.root))
    assert (
        reopened.execute("wound_closure_get", {"report_id": output["report_id"]})["report"]
        == output["report"]
    )
    archive = tmp_path / "wound-study.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "restored-wound")
    assert restored.documents(DOCUMENT_KIND)[0]["data"] == output["report"]
    job = restored.job(output["job"]["id"])
    assert job["interchange"]["historical"] and job["report_id"] == output["report_id"]
    assert restored.documents(GRANT_KIND) == []
    for t, record in records.items():
        assert restored.result(record["id"]) == record
        np.testing.assert_array_equal(restored.load_array(record["arrays"]["labels"]), masks[t])
    got = Workbench(restored).execute("wound_closure_get", {"report_id": output["report_id"]})
    assert got["report"] == output["report"] and got["status"]["current"]


def test_portable_acceptance_must_replay_verified_staged_mask_arrays(wound, tmp_path, monkeypatch):
    wb, request, records, _ = wound
    saved(wb, request)
    archive = tmp_path / "wound-study.zip"
    export_project(wb.project, archive)
    original = ResearchProject.load_array
    seen = []
    target_hash = records[2]["arrays"]["labels"]["sha256"]

    def changed_staged_mask(project, descriptor):
        array = original(project, descriptor)
        if project.root != wb.project.root and descriptor["sha256"] == target_hash:
            seen.append(descriptor["sha256"])
            array = array.copy()
            array[2, 2] = 0
        return array

    monkeypatch.setattr(ResearchProject, "load_array", changed_staged_mask)
    target = tmp_path / "refused-wound"
    with pytest.raises(ValueError, match="Wound label bytes|retained original masks|hash"):
        import_project(archive, target)
    assert seen and not target.exists()


def test_native_rpc_export_grant_keeps_paths_private_and_exact_masks_and_csv(
    wound, tmp_path, monkeypatch
):
    wb, request, records, _ = wound
    output, _ = saved(wb, request)
    monkeypatch.setattr(research_rpc, "_ACTIVE", wb)
    params = {"project": str(wb.project.root), "report_id": output["report_id"]}
    plan = research_rpc.dispatch_research("research_wound_closure_export_plan", params)
    target = tmp_path / "wound-export"
    grant = research_rpc.dispatch_research(
        "research_wound_closure_export_grant",
        {
            **params,
            "plan_hash": plan["plan_hash"],
            "destination": str(target),
        },
    )
    assert str(tmp_path) not in canonical_json(grant)
    job = submit_job(
        wb,
        {key: grant[key] for key in ("grant_id", "plan_hash")},
        "export-wound",
        operation="wound_closure_export",
    )
    assert str(tmp_path) not in canonical_json(job)
    receipt = run_job(wb, job["id"])
    assert receipt["job"]["state"] == "succeeded" and "destination" not in receipt
    with (target / "frames.csv").open(newline="") as stream:
        rows = [
            {key: json.loads(value) for key, value in row.items()} for row in csv.DictReader(stream)
        ]
    assert [row["area"] for row in rows] == [72, None, 36, 108, 0]
    for record in records.values():
        digest = record["arrays"]["labels"]["sha256"]
        assert hashlib.sha256((target / f"labels-{digest}.npy").read_bytes()).hexdigest() == digest
    archive = tmp_path / "without-grants.zip"
    export_project(wb.project, archive)
    with zipfile.ZipFile(archive) as bundle:
        assert not any(GRANT_KIND in name for name in bundle.namelist())
        for name in bundle.namelist():
            if name.endswith(".json"):
                assert str(target) not in bundle.read(name).decode()


def test_immutable_report_edits_and_fabricated_generic_review_are_refused(wound):
    wb, request, _, _ = wound
    output, _ = saved(wb, request)
    with pytest.raises(ValueError, match="immutable"):
        wb.project.put_document(
            DOCUMENT_KIND, output["report_id"], output["report"], expected_revision=1
        )
    with pytest.raises(ValueError):
        wb.project.review(output["report_id"], output["report"]["report_hash"], "reviewed")
    assert "review" not in wb.execute("wound_closure_get", {"report_id": output["report_id"]})
