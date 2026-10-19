"""Tests for large result remote exchange: adoption and durable export."""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import sqlite3

import numpy as np
import pytest
import tifffile

from loci_engine.native_image import NativeSourceChangedError
from loci_engine.research_export import flat_measurements
from loci_engine.research_jobs import cancel_job, reconcile_jobs, run_job, submit_job
from loci_engine.research_large_exchange import adopt_large_result, create_exchange_grant
from loci_engine.research_large_export import create_export_grant, export_large_result
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_review import review_sha256
from loci_engine.research_tiled_store import object_rows, read_region
from loci_engine.source_browser_location import associate_import_root, prepare_import_root
from loci_engine.workbench import Workbench

ATOL = 1e-9
SELECTION = {"x": 11, "y": 13, "width": 530, "height": 530, "t": 1, "c": 1, "z": 1, "level": 0}


def _create_study_and_source(root_path, *, name="Study"):
    root_path.mkdir(parents=True, exist_ok=True)
    project = ResearchProject.create(
        root_path / "study.loci-study",
        name,
        schema_version=2,
    )
    workbench = Workbench(project)
    return workbench


def _associate_folder(workbench, source, path):
    plan = prepare_import_root(str(path.parent), [str(path)], [path.name])
    associate_import_root(workbench.project, [source], plan)
    public = workbench.project.public_source(workbench.project.source(source["id"]))
    assert public["browser_location"]["root"] is not None
    return public


def _generate_synthetic_image(image_path):
    stack = np.full((2, 2, 2, 560, 568), 100, dtype=np.uint16)
    stack[0, 0, 0] = 300
    selected = stack[1, 1, 1]
    y0, x0 = SELECTION["y"], SELECTION["x"]
    selected[y0 : y0 + 1, x0 + 20 : x0 + 24] = 1300  # border
    selected[y0 + 100 : y0 + 104, x0 + 506 : x0 + 516] = 1000  # seam 1
    selected[y0 + 506 : y0 + 516, x0 + 100 : x0 + 104] = 1100  # seam 2
    selected[y0 + 509 : y0 + 515, x0 + 509 : x0 + 515] = 1200  # corner

    metadata = {
        "axes": "TCZYX",
        "Channel": {"Name": ["Reference", "Marker"]},
        "PhysicalSizeX": 0.5,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeY": 0.75,
        "PhysicalSizeYUnit": "µm",
        "PhysicalSizeZ": 2.0,
        "PhysicalSizeZUnit": "µm",
    }
    tifffile.imwrite(
        image_path,
        stack,
        ome=True,
        tile=(64, 64),
        compression="deflate",
        metadata=metadata,
    )


@pytest.fixture
def shared_source(tmp_path):
    img_path = tmp_path / "shared-synthetic.ome.tif"
    _generate_synthetic_image(img_path)
    return img_path


def _publish_root_result(workbench, source_id, *, job_id=None):
    request = {
        "source_id": source_id,
        "selection": dict(SELECTION),
        "segmentation": {
            "method": "components",
            "threshold": 500,
            "polarity": "bright",
            "min_size": 1.0,
            "exclude_border": True,
        },
        "working_bytes": 256 * 1024**2,
    }
    workbench.execute("large_components_preflight", request)
    if job_id:
        job = submit_job(workbench, request, job_id, operation="large_components_run")
        run_job(workbench, job["id"])
        finished = workbench.project.job(job["id"])
        assert finished["state"] == "succeeded"
        return finished["result_ids"][0], request
    saved = workbench.execute("large_components_run", request)
    result_id = saved["result"]["id"]
    return result_id, request


def _rehash_bundle(bundle_dir, *, result_modifier=None, rows_modifier=None):
    receipt = json.loads((bundle_dir / "result.json").read_text())
    result = receipt["result"]
    if rows_modifier is not None:
        db_path = bundle_dir / "objects.sqlite3"
        conn = sqlite3.connect(str(db_path))
        rows = [
            json.loads(row[0]) for row in conn.execute("SELECT record FROM objects ORDER BY label")
        ]
        rows_modifier(rows)
        for row in rows:
            conn.execute(
                "UPDATE objects SET record=? WHERE label=?",
                (canonical_json(row), row["label"]),
            )
        conn.commit()
        conn.close()
        raw_db = db_path.read_bytes()
        result["object_table"]["sha256"] = hashlib.sha256(raw_db).hexdigest()
        result["object_table"]["bytes"] = len(raw_db)
        with (bundle_dir / "objects.csv").open("w", newline="") as stream:
            flat = flat_measurements(rows)
            writer = csv.DictWriter(stream, fieldnames=list(flat[0]))
            writer.writeheader()
            writer.writerows(flat)

    if result_modifier is not None:
        result_modifier(result, receipt)

    result.pop("revision_hash", None)
    result["revision_hash"] = hashlib.sha256(canonical_json(result).encode()).hexdigest()
    if receipt["review"] is not None:
        receipt["review"]["revision_hash"] = result["revision_hash"]
    history_path = bundle_dir / "review-history.json"
    if history_path.exists():
        history = json.loads(history_path.read_text())
        history["revision_hash"] = result["revision_hash"]
        previous = None
        for event in history["events"]:
            event["revision_hash"] = result["revision_hash"]
            if "previous_review_sha256" in event:
                event["previous_review_sha256"] = review_sha256(previous)
            previous = event
        receipt["review"] = previous
        history["current_sha256"] = review_sha256(previous)
        history_path.write_text(canonical_json(history))
    (bundle_dir / "result.json").write_text(canonical_json(receipt))

    marker = json.loads((bundle_dir / "loci-export.json").read_text())
    marker["revision_hash"] = result["revision_hash"]
    (bundle_dir / "loci-export.json").write_text(canonical_json(marker))

    manifest = json.loads((bundle_dir / "manifest.json").read_text())
    manifest["revision_hash"] = result["revision_hash"]
    for entry in manifest["files"]:
        raw = (bundle_dir / entry["name"]).read_bytes()
        entry["sha256"] = hashlib.sha256(raw).hexdigest()
        entry["size_bytes"] = len(raw)
    (bundle_dir / "manifest.json").write_text(canonical_json(manifest))


@pytest.mark.parametrize("attack", ["missing", "predecessor"])
def test_exchange_grant_rejects_missing_or_altered_review_history(tmp_path, shared_source, attack):
    origin = _create_study_and_source(tmp_path / "origin")
    source = origin.import_native(str(shared_source))
    result_id, _ = _publish_root_result(origin, source["id"])
    result = origin.project.result(result_id)
    origin.project.review(result_id, result["revision_hash"], "reviewed")
    destination = tmp_path / "bundle"
    export_large_result(origin.project, result_id, result["revision_hash"], destination)
    history_path = destination / "review-history.json"
    manifest = json.loads((destination / "manifest.json").read_text())
    if attack == "missing":
        history_path.unlink()
        manifest["files"] = [
            item for item in manifest["files"] if item["name"] != history_path.name
        ]
    else:
        history = json.loads(history_path.read_text())
        history["events"][0]["previous_review_sha256"] = "c" * 64
        history_path.write_text(canonical_json(history))
        entry = next(item for item in manifest["files"] if item["name"] == history_path.name)
        entry.update(
            sha256=hashlib.sha256(history_path.read_bytes()).hexdigest(),
            size_bytes=history_path.stat().st_size,
        )
    (destination / "manifest.json").write_text(canonical_json(manifest))
    recipient = _create_study_and_source(tmp_path / "recipient")
    target_source = recipient.import_native(str(shared_source))
    with pytest.raises(ValueError, match="history"):
        create_exchange_grant(recipient.project, target_source["id"], str(destination))


@pytest.mark.parametrize("durable", [False, True])
def test_adopt_valid_export_bundle_into_fresh_study(tmp_path, shared_source, durable):
    # 1. Produce and review in Origin study
    wb_origin = _create_study_and_source(tmp_path / "origin", name="Origin Study")
    src_origin = wb_origin.import_native(str(shared_source))
    src_origin = _associate_folder(wb_origin, src_origin, shared_source)
    stored_source = wb_origin.project.source(src_origin["id"])
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])

    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "exported-bundle"
    receipt = export_large_result(
        wb_origin.project, res_id, res_origin["revision_hash"], export_dest
    )
    assert receipt["result_id"] == res_id
    assert (export_dest / "manifest.json").is_file()
    exported_source = json.loads((export_dest / "result.json").read_text())["source"]
    assert set(exported_source) == {
        "id",
        "name",
        "sha256",
        "size_bytes",
        "metadata",
        "created_at",
        "annotations",
        "source_kind",
        "identity_kind",
    }
    assert exported_source == {
        key: value for key, value in src_origin.items() if key != "browser_location"
    }
    assert wb_origin.project.source(src_origin["id"]) == stored_source

    # 2. In Recipient study with the same source image
    wb_dest = _create_study_and_source(tmp_path / "recipient", name="Recipient Study")
    src_dest = wb_dest.import_native(str(shared_source))
    src_dest = _associate_folder(wb_dest, src_dest, shared_source)
    destination_source = wb_dest.project.source(src_dest["id"])

    # Grant creation
    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    assert grant["grant_id"]
    assert grant["source_id"] == src_dest["id"]

    # Both direct and durable adoption retain local browser metadata.
    adopt_request = {
        "source_id": src_dest["id"],
        "grant_id": grant["grant_id"],
        "manifest_sha256": grant["manifest_sha256"],
    }
    if durable:
        job = submit_job(wb_dest, adopt_request, "adopt-job-1", operation="large_result_adopt")
        run_job(wb_dest, job["id"])
        finished_job = wb_dest.project.job(job["id"])
        assert finished_job["state"] == "succeeded"
        adopted_id = finished_job["result_ids"][0]
    else:
        adopted_id = adopt_large_result(wb_dest, adopt_request)["result"]["id"]
    assert wb_dest.project.source(src_dest["id"]) == destination_source

    adopted_result = wb_dest.project.result(adopted_id)
    assert adopted_result["parent_id"] is None
    assert adopted_result["schema"] == "loci.research-result/v2"
    assert adopted_result["object_count"] == res_origin["object_count"]
    assert adopted_result["label_sha256"] == res_origin["label_sha256"]
    assert adopted_result["provenance"]["recipe"] == res_origin["provenance"]["recipe"]

    # Verify cold reopen of recipient project
    wb_dest.close()
    reopened = ResearchProject(wb_dest.project.root)
    assert reopened.result(adopted_id) == adopted_result
    origin_rows = object_rows(wb_origin.project, res_origin["object_table"])
    adopted_rows = object_rows(reopened, adopted_result["object_table"])
    assert len(adopted_rows) == len(origin_rows)
    assert [r["label"] for r in adopted_rows] == [r["label"] for r in origin_rows]

    # Verify tile labels read
    lbls = read_region(reopened, adopted_result["arrays"]["labels"], 0, 0, 530, 530)
    origin_lbls = read_region(wb_origin.project, res_origin["arrays"]["labels"], 0, 0, 530, 530)
    np.testing.assert_array_equal(lbls, origin_lbls)

    wb_origin.close()


def test_duplicate_adoption_is_idempotent(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-idempotent"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    # First adoption
    grant1 = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    job1 = submit_job(
        wb_dest,
        {
            "source_id": src_dest["id"],
            "grant_id": grant1["grant_id"],
            "manifest_sha256": grant1["manifest_sha256"],
        },
        "adopt-1",
        operation="large_result_adopt",
    )
    run_job(wb_dest, job1["id"])
    assert wb_dest.project.job(job1["id"])["state"] == "succeeded"
    adopted_id1 = wb_dest.project.job(job1["id"])["result_ids"][0]

    # Second adoption of same bundle
    grant2 = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    job2 = submit_job(
        wb_dest,
        {
            "source_id": src_dest["id"],
            "grant_id": grant2["grant_id"],
            "manifest_sha256": grant2["manifest_sha256"],
        },
        "adopt-2",
        operation="large_result_adopt",
    )
    run_job(wb_dest, job2["id"])
    assert wb_dest.project.job(job2["id"])["state"] == "succeeded"
    adopted_id2 = wb_dest.project.job(job2["id"])["result_ids"][0]

    assert adopted_id1 == adopted_id2
    assert len(wb_dest.project.list_results()) == 1

    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_source_mismatch(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-mismatch"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    # Different source image in destination
    different_img = tmp_path / "diff.ome.tif"
    _generate_synthetic_image(different_img)
    # Modify raw pixels
    raw = tifffile.imread(different_img)
    raw[0, 0, 0, 0, 0] = 999
    tifffile.imwrite(different_img, raw)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(different_img))

    with pytest.raises(ValueError, match="different source image"):
        create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    assert len(wb_dest.project.list_results()) == 0

    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_tampered_manifest(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-tampered-manifest"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    # Grant issued on clean bundle
    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))

    # Tamper with manifest.json after grant was issued
    manifest_path = export_dest / "manifest.json"
    manifest_data = json.loads(manifest_path.read_text())
    manifest_data["files"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest_data))

    with pytest.raises(
        ValueError,
        match="integrity check against manifest|Checksum mismatch|digest does not match grant",
    ):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )

    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_extra_unexpected_file_or_symlink(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-extra"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    # Add extra unexpected file
    (export_dest / "unexpected.sh").write_text("echo evil")

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    with pytest.raises(ValueError, match="exact 8 files|unexpected file"):
        create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))

    # Remove extra file, add symlink
    (export_dest / "unexpected.sh").unlink()
    (export_dest / "methods.md").unlink()
    (export_dest / "methods.md").symlink_to(shared_source)

    with pytest.raises(ValueError, match="is a symlink|Symlinks are not allowed"):
        create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))

    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_forged_measurements(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-forged"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    def forge_row(rows):
        rows[0]["measure"] = 999999.0

    _rehash_bundle(export_dest, rows_modifier=forge_row)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    with pytest.raises(ValueError, match="Measure value mismatch"):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )

    wb_origin.close()
    wb_dest.close()


def test_durable_large_export_cancellation(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)

    # Unreviewed export grant fails
    export_dest = tmp_path / "durable-export"
    with pytest.raises(ValueError, match="Review this exact result"):
        create_export_grant(
            wb_origin.project, res_id, res_origin["revision_hash"], str(export_dest)
        )

    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")
    grant = create_export_grant(
        wb_origin.project, res_id, res_origin["revision_hash"], str(export_dest)
    )

    # Submit durable export job
    export_request = {
        "result_id": res_id,
        "revision_hash": res_origin["revision_hash"],
        "grant_id": grant["grant_id"],
    }
    job = submit_job(wb_origin, export_request, "export-job-1", operation="large_result_export")

    # Cancel job before run
    cancel_job(wb_origin.project, job["id"])
    run_job(wb_origin, job["id"])

    finished = wb_origin.project.job(job["id"])
    assert finished["state"] == "cancelled"
    assert not export_dest.exists()

    wb_origin.close()


def test_reconcile_jobs_post_publication_honesty(tmp_path, shared_source, monkeypatch):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "post-pub-export"
    grant = create_export_grant(
        wb_origin.project, res_id, res_origin["revision_hash"], str(export_dest)
    )

    # Run the export cleanly so export_dest exists and is published
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)
    assert (export_dest / "manifest.json").is_file()

    # Now simulate a job that was left in "running" state when the process crashed after publication
    export_request = {
        "result_id": res_id,
        "revision_hash": res_origin["revision_hash"],
        "grant_id": grant["grant_id"],
    }
    job = submit_job(
        wb_origin, export_request, "crashed-export-job", operation="large_result_export"
    )
    # Manually mark as running
    wb_origin.project.update_job(job["id"], expected_state="queued", state="running")

    # Recovery must remain bounded on the control worker. The destination may be
    # present after a crash, but its contents have not been reverified here.
    def forbid_file_hash(*_args, **_kwargs):
        raise AssertionError("unexpected file hash")

    monkeypatch.setattr(
        "loci_engine.research_large_export._checked_hash",
        forbid_file_hash,
    )
    reconcile_jobs(wb_origin.project)

    reconciled = wb_origin.project.job(job["id"])
    assert reconciled["state"] == "interrupted"
    assert "Export destination exists" in reconciled["error"]
    assert "completeness is not verified" in reconciled["error"]

    wb_origin.close()


def test_adopt_valid_durable_origin_export(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"], job_id="durable-producer-1")
    res_origin = wb_origin.project.result(res_id)
    origin_job_id = res_origin["provenance"].get("job_id")
    assert origin_job_id is not None
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-durable-origin"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    adopted = adopt_large_result(
        wb_dest,
        {
            "source_id": src_dest["id"],
            "grant_id": grant["grant_id"],
            "manifest_sha256": grant["manifest_sha256"],
        },
    )
    adopted_res = wb_dest.project.result(adopted["result"]["id"])
    assert adopted_res["provenance"]["remote_exchange"]["remote_job_id"] == origin_job_id
    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_translated_geometry_affine(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-translated-geom"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    def mod_geom(res, receipt):
        res["provenance"]["geometry"]["affine"][0][3] += 10000.0

    def mod_rows(rows):
        for r in rows:
            r["centroid_world_xyz"][0] += 10000.0

    _rehash_bundle(export_dest, result_modifier=mod_geom, rows_modifier=mod_rows)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    with pytest.raises(ValueError, match="Local source physical calibration or affine disagrees"):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )
    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_extra_intensity_channel(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-extra-channel"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    def mod_rows(rows):
        for r in rows:
            r["intensity"]["9: Unmeasured biological marker"] = {
                "mean": 999999.0,
                "sum": -123.0,
                "min": 9000.0,
                "max": 1.0,
                "std_population": -5.0,
            }

    _rehash_bundle(export_dest, rows_modifier=mod_rows)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    with pytest.raises(ValueError, match="Object table intensity must contain exactly one channel"):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )
    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_false_provenance(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-false-prov"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    def mod_prov(res, receipt):
        res["provenance"]["runtime"] = {
            "resolved_device": "cuda",
            "backend": "unvalidated-remote-model",
        }

    _rehash_bundle(export_dest, result_modifier=mod_prov)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    with pytest.raises(
        ValueError,
        match="Unsupported execution device: cuda|Unsupported execution backend",
    ):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )
    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_stale_revision_hash(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-stale-rev"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    # Tamper result.json without updating revision_hash
    receipt = json.loads((export_dest / "result.json").read_text())
    receipt["result"]["provenance"]["runtime"]["engine"] = "forged-engine"
    (export_dest / "result.json").write_text(canonical_json(receipt))
    # Update manifest file hash for result.json so manifest file checksum passes
    manifest = json.loads((export_dest / "manifest.json").read_text())
    raw = (export_dest / "result.json").read_bytes()
    for f in manifest["files"]:
        if f["name"] == "result.json":
            f["sha256"] = hashlib.sha256(raw).hexdigest()
            f["size_bytes"] = len(raw)
    (export_dest / "manifest.json").write_text(canonical_json(manifest))

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    with pytest.raises(
        ValueError, match="Result revision hash does not match canonical serialization"
    ):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )
    wb_origin.close()
    wb_dest.close()


def test_adopt_rejects_unknown_grid_schema(tmp_path, shared_source):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-unknown-grid"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    def mod_grid(res, receipt):
        for grid in res["arrays"].values():
            grid["schema"] = "loci.unknown-grid/v999"
            grid["tiles"] = []

    _rehash_bundle(export_dest, result_modifier=mod_grid)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    with pytest.raises(
        ValueError,
        match=(
            "Unknown tiled grid schema|"
            "Unknown or invalid array schema|"
            "Exported grids must be 512-core"
        ),
    ):
        adopt_large_result(
            wb_dest,
            {
                "source_id": src_dest["id"],
                "grant_id": grant["grant_id"],
                "manifest_sha256": grant["manifest_sha256"],
            },
        )
    wb_origin.close()
    wb_dest.close()


def test_adopt_clean_retry_after_copy_interruption(tmp_path, shared_source, monkeypatch):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-interruption"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    request = {
        "source_id": src_dest["id"],
        "grant_id": grant["grant_id"],
        "manifest_sha256": grant["manifest_sha256"],
    }

    import os

    call_count = 0

    def interrupted_rename(src, dst):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("Synthetic interruption before atomic table rename")
        os.replace(src, dst)

    monkeypatch.setattr("loci_engine.research_large_exchange._rename_noreplace", interrupted_rename)

    with pytest.raises(RuntimeError, match="Synthetic interruption before atomic table rename"):
        adopt_large_result(wb_dest, request)

    assert len(wb_dest.project.list_results()) == 0

    # Staging artifact from interrupted attempt does not poison retry
    adopted = adopt_large_result(wb_dest, request)
    assert adopted["result"]["id"]
    assert len(wb_dest.project.list_results()) == 1

    wb_origin.close()
    wb_dest.close()


def test_adopt_preserves_local_channel_names_divergence(tmp_path, shared_source):
    from loci_engine.research_channels import save_channels

    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-divergent-channel"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    # Rename local channel 1 in recipient study
    save_channels(
        wb_dest.project,
        {
            "source_id": src_dest["id"],
            "channels": [
                {
                    "index": 0,
                    "name": "Renamed-Reference",
                    "marker": "",
                    "fluorophore": "",
                    "declaration": "",
                },
                {
                    "index": 1,
                    "name": "User-Custom-Marker",
                    "marker": "",
                    "fluorophore": "",
                    "declaration": "",
                },
            ],
            "expected_revision": 0,
        },
    )

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    adopted = adopt_large_result(
        wb_dest,
        {
            "source_id": src_dest["id"],
            "grant_id": grant["grant_id"],
            "manifest_sha256": grant["manifest_sha256"],
        },
    )
    assert adopted["result"]["id"]
    local_meta = wb_dest.channel_metadata(src_dest["id"])
    assert local_meta["channels"][1]["name"] == "User-Custom-Marker"

    wb_origin.close()
    wb_dest.close()


def test_exchange_grant_creation_is_bounded_and_fast(tmp_path, shared_source, monkeypatch):
    wb_origin = _create_study_and_source(tmp_path / "origin")
    src_origin = wb_origin.import_native(str(shared_source))
    res_id, _ = _publish_root_result(wb_origin, src_origin["id"])
    res_origin = wb_origin.project.result(res_id)
    wb_origin.project.review(res_id, res_origin["revision_hash"], "reviewed")

    export_dest = tmp_path / "bundle-bounded"
    export_large_result(wb_origin.project, res_id, res_origin["revision_hash"], export_dest)

    wb_dest = _create_study_and_source(tmp_path / "recipient")
    src_dest = wb_dest.import_native(str(shared_source))

    # Forbid opening NativeImageSession or hashing large TIFF files during grant creation
    def forbid_native_session(*_args, **_kwargs):
        raise AssertionError("NativeImageSession opened during grant creation")

    monkeypatch.setattr(
        "loci_engine.research_large_exchange.NativeImageSession", forbid_native_session
    )

    grant = create_exchange_grant(wb_dest.project, src_dest["id"], str(export_dest))
    assert grant["grant_id"]
    assert grant["manifest_sha256"]

    wb_origin.close()
    wb_dest.close()


@pytest.mark.parametrize(
    "case",
    [
        "wrong-channel",
        "contradictory-recipe",
        "unknown-runtime",
        "contradictory-segmentation",
        "unknown-selection",
        "forged-core",
        "mismatched-source",
        "unknown-source-field",
        "browser-source-field",
        "wrong-raw-tiff",
    ],
)
def test_adoption_rejects_rehashed_semantic_forgeries(tmp_path, shared_source, case):
    origin = _create_study_and_source(tmp_path / "origin")
    source = origin.import_native(str(shared_source))
    result_id, _ = _publish_root_result(origin, source["id"])
    result = origin.project.result(result_id)
    origin.project.review(result_id, result["revision_hash"], "reviewed")
    pristine = tmp_path / "pristine"
    export_large_result(origin.project, result_id, result["revision_hash"], pristine)
    bundle = tmp_path / "forged"
    shutil.copytree(pristine, bundle)

    def modify(record, receipt):
        prov = record["provenance"]
        if case == "wrong-channel":
            prov["measurement_channel_name"] = "1: Reference"
        elif case == "contradictory-recipe":
            prov["recipe"]["segmentation"]["threshold"] = 98765
            prov["recipe"]["measurement_channels"] = [0]
            prov["recipe"]["steps"] = [{"operation": "gaussian", "sigma": 12}]
            prov["recipe_sha256"] = hashlib.sha256(
                canonical_json(prov["recipe"]).encode()
            ).hexdigest()
        elif case == "unknown-runtime":
            prov["runtime"] = {"arbitrary": "unknown"}
        elif case == "contradictory-segmentation":
            prov["segmentation"].update(
                connectivity=8,
                dimensions=3,
                count=999,
                scientific_validation="clinically-validated",
            )
        elif case == "unknown-selection":
            prov["selection"]["series"] = 999
        elif case == "forged-core":
            record["arrays"]["image"]["tiles"][0]["artifact"]["sha256"] = "1" * 64
        elif case == "mismatched-source":
            receipt["source"].update(id="fabricated-source", size_bytes=None)
        elif case == "unknown-source-field":
            receipt["source"]["unknown"] = {"identity": "unverified"}
        elif case == "browser-source-field":
            receipt["source"]["browser_location"] = {
                "relative_path": "safe.tif",
                "root": None,
            }

    if case == "wrong-raw-tiff":
        raw_path = bundle / "image.ome.tif"
        raw = tifffile.imread(raw_path).astype(np.uint32)
        tifffile.imwrite(
            raw_path,
            raw,
            ome=True,
            tile=(64, 64),
            metadata={
                "axes": "YX",
                "PhysicalSizeX": 999,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeY": 999,
                "PhysicalSizeYUnit": "µm",
            },
        )

    def modify_rows(rows):
        if case == "wrong-channel":
            for row in rows:
                value = next(iter(row["intensity"].values()))
                row["intensity"] = {"1: Reference": value}

    _rehash_bundle(
        bundle,
        result_modifier=modify,
        rows_modifier=modify_rows if case == "wrong-channel" else None,
    )
    recipient = _create_study_and_source(tmp_path / "recipient")
    local_source = recipient.import_native(str(shared_source))
    expected_error = (
        "Invalid or incomplete exported source fields"
        if case in {"unknown-source-field", "browser-source-field"}
        else None
    )
    with pytest.raises(ValueError, match=expected_error):
        grant = create_exchange_grant(recipient.project, local_source["id"], str(bundle))
        adopt_large_result(
            recipient, {key: grant[key] for key in ("source_id", "grant_id", "manifest_sha256")}
        )
    assert recipient.project.list_results() == []
    origin.close()
    recipient.close()


def test_byte_identical_sources_get_distinct_grants_and_adoptions(tmp_path, shared_source):
    origin = _create_study_and_source(tmp_path / "origin")
    remote = origin.import_native(str(shared_source))
    result_id, _ = _publish_root_result(origin, remote["id"])
    result = origin.project.result(result_id)
    origin.project.review(result_id, result["revision_hash"], "reviewed")
    bundle = tmp_path / "bundle"
    export_large_result(origin.project, result_id, result["revision_hash"], bundle)
    copied_bundle = tmp_path / "bundle-copy"
    shutil.copytree(bundle, copied_bundle)
    copied_source = tmp_path / "source-copy.ome.tif"
    shutil.copyfile(shared_source, copied_source)
    recipient = _create_study_and_source(tmp_path / "recipient")
    first = recipient.import_native(str(shared_source))
    second = recipient.import_native(str(copied_source))
    assert first["id"] != second["id"]
    first_grant = create_exchange_grant(recipient.project, first["id"], str(bundle))
    second_grant = create_exchange_grant(recipient.project, second["id"], str(bundle))
    assert first_grant["grant_id"] != second_grant["grant_id"]
    adopted = []
    for local, exchange in ((first, first_grant), (second, second_grant)):
        request = {key: exchange[key] for key in ("source_id", "grant_id", "manifest_sha256")}
        adopted.append(adopt_large_result(recipient, request)["result"]["id"])
        assert recipient.project.result(adopted[-1])["source_id"] == local["id"]
    assert len(set(adopted)) == 2
    copy_grant = create_exchange_grant(recipient.project, second["id"], str(copied_bundle))
    copy_request = {key: copy_grant[key] for key in ("source_id", "grant_id", "manifest_sha256")}
    assert adopt_large_result(recipient, copy_request)["result"]["id"] == adopted[1]
    with copied_source.open("r+b") as stream:
        stream.seek(-1, 2)
        last = stream.read(1)
        stream.seek(-1, 2)
        stream.write(bytes([last[0] ^ 1]))
    with pytest.raises(NativeSourceChangedError):
        adopt_large_result(recipient, copy_request)
    origin.close()
    recipient.close()


def test_grant_rejects_oversized_manifest_before_hashing(tmp_path, monkeypatch):
    from loci_engine import research_large_exchange as exchange

    bundle = tmp_path / "bundle"
    bundle.mkdir()
    for name in exchange.ALLOWED_BUNDLE_FILES:
        (bundle / name).touch()
    with (bundle / "manifest.json").open("wb") as stream:
        stream.truncate(exchange.MAX_TEXT_SIZE + 1)

    def forbid_hash(*args, **kwargs):
        raise AssertionError("Unbounded file hashing reached during metadata admission")

    monkeypatch.setattr(exchange, "_sha256_file_stable", forbid_hash)
    with pytest.raises(ValueError, match="within allowed size"):
        exchange.validate_export_bundle_metadata(bundle)


def test_grant_stops_directory_enumeration_at_bound(tmp_path, monkeypatch):
    from loci_engine import research_large_exchange as exchange

    visited = []

    class Entries:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def __iter__(self):
            from types import SimpleNamespace

            for i in range(1_000_000):
                visited.append(i)
                if i > 32:
                    raise AssertionError("Directory admission read past its 33rd entry")
                yield SimpleNamespace(path=str(tmp_path / f"extra-{i}"))

    monkeypatch.setattr(exchange.os, "scandir", lambda _: Entries())
    with pytest.raises(ValueError, match="too many entries"):
        exchange.validate_export_bundle_metadata(tmp_path)
    assert len(visited) == 33


def test_duplicate_adoption_rechecks_source_after_measurement(tmp_path, shared_source, monkeypatch):
    import loci_engine.research_large_exchange as exchange

    origin = _create_study_and_source(tmp_path / "origin")
    remote = origin.import_native(str(shared_source))
    result_id, _ = _publish_root_result(origin, remote["id"])
    result = origin.project.result(result_id)
    origin.project.review(result_id, result["revision_hash"], "reviewed")
    bundle = tmp_path / "bundle"
    export_large_result(origin.project, result_id, result["revision_hash"], bundle)
    recipient = _create_study_and_source(tmp_path / "recipient")
    local = recipient.import_native(str(shared_source))
    grant = create_exchange_grant(recipient.project, local["id"], str(bundle))
    request = {k: grant[k] for k in ("source_id", "grant_id", "manifest_sha256")}
    original = adopt_large_result(recipient, request)["result"]["id"]
    measure = exchange.measure_tiled

    def mutate_after_measure(*args, **kwargs):
        result = measure(*args, **kwargs)
        with shared_source.open("ab") as stream:
            stream.write(b"changed-after-last-raw-read")
        return result

    monkeypatch.setattr(exchange, "measure_tiled", mutate_after_measure)
    with pytest.raises(ValueError, match="changed"):
        adopt_large_result(recipient, request)
    assert [r["id"] for r in recipient.project.list_results()] == [original]
    origin.close()
    recipient.close()
