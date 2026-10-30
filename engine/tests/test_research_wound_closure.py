"""Exact generated filled masks, independent area/time math and publication boundaries."""

import copy
import csv
import hashlib
import io
import json
from contextlib import contextmanager

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import measure_objects
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_wound_closure import (
    DOCUMENT_KIND,
    MAX_PREVIEWS,
    PAGE_BYTES,
    PREVIEW_PREFIX,
    SCHEMA,
    current_status,
    execute,
    execute_export,
    export_input_result_ids,
    grant,
    input_result_ids,
    load,
    plan,
    preview,
    publish,
    references,
    request_result_bindings,
    save_job,
    save_task_source,
    validate_portable_references,
    validate_report,
)
from loci_engine.workbench import Workbench, runtime_record
from loci_engine.wound_closure import FILLED_AREA


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def rehash(record):
    record["revision_hash"] = digest({k: v for k, v in record.items() if k != "revision_hash"})
    return record


@pytest.fixture
def wound(tmp_path):
    image = np.arange(5 * 8 * 10, dtype=np.uint16).reshape(5, 8, 10)
    path = tmp_path / "generated-wound-sequence.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "TYX",
            "PhysicalSizeX": 3.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "wound.loci-study", "Generated wound"))
    source = wb.import_native(str(path))
    wb.project.put_document(
        "sample",
        source["id"],
        {
            "study": "Generated wound study",
            "sample": "Declared specimen",
            "condition": "Technical fixture",
            "biological_replicate": "D1",
        },
        expected_revision=0,
    )
    records, masks = {}, {}
    for t, region in (
        (0, (slice(2, 5), slice(2, 6))),
        (2, (slice(2, 4), slice(2, 5))),
        (3, (slice(1, 4), slice(2, 8))),
        (4, None),
    ):
        raw, geometry, selection = wb.load_scalar(source["id"], {"t": t})
        mask = np.zeros(raw.shape, np.uint32)
        if region is not None:
            mask[region] = 1
        if t == 2:
            mask[6, 7:9] = 2  # Explicitly unselected positive area, never part of the wound.
        record = wb.project.save_result(
            source_id=source["id"],
            kind="external-labels",
            arrays={"image": raw, "labels": mask},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": selection,
                "runtime": runtime_record(),
                "measurement_channels": [0],
                "mask_semantics": FILLED_AREA,
                "measurements": measure_objects(mask, geometry, {"raw": raw}),
            },
        )
        records[t] = wb.project.result(record["id"])
        masks[t] = mask.copy()
    frames = []
    for t in range(5):
        if t == 1:
            frames.append({"frame_id": "frame-1", "missing_reason": "Acquisition missing"})
        else:
            frames.append(
                {
                    "frame_id": f"frame-{t}",
                    "result_id": records[t]["id"],
                    "revision_hash": records[t]["revision_hash"],
                    "selected_labels": [1] if t != 4 else [],
                    "mask_semantics": FILLED_AREA,
                }
            )
    request = {
        "frames": frames,
        "time_s": [10, 40, 90, 150, 210],
        "time_unit": "s",
        "time_declaration": "Actual elapsed seconds from the generated acquisition log",
        "specimen_id": "Declared specimen",
        "sequence_id": "Longitudinal sequence A",
        "area_declaration": (
            "Selected labels are explicitly supplied filled-wound area, not a boundary trace"
        ),
        "grid_declaration": (
            "Identical declared physical field and channel; no resampling or registration"
        ),
        "working_bytes": 16 * 1024**2,
    }
    yield wb, request, records, masks
    wb.close()


def token(opaque):
    return {k: opaque[k] for k in ("preview_id", "preview_hash")}


def save(project, request):
    opaque = execute(project, "wound_closure_preview", request)
    return execute(project, "wound_closure_save", token(opaque)), token(opaque)


def test_independent_area_closure_and_only_adjacent_observed_slopes(wound):
    wb, request, records, _ = wound
    report = preview(wb.project, request)
    m = report["measurement"]
    assert report["schema"] == SCHEMA
    assert m["area_unit"] == "um^2" and m["time_unit"] == "s"
    assert m["baseline_area"] == 12 * 6
    assert [r["area"] for r in m["frames"]] == [72, None, 36, 108, 0]
    assert [r["closure_fraction"] for r in m["frames"]] == [0, None, 0.5, -0.5, 1]
    assert [r["area_fraction"] for r in m["frames"]] == [1, None, 0.5, 1.5, 0]
    assert m["frames"][2]["excluded_positive_pixel_count"] == 2
    assert [r["area_change_rate"] for r in m["intervals"]] == [None, None, 72 / 60, -108 / 60]
    assert [r["closure_change_rate"] for r in m["intervals"]] == [None, None, -1 / 60, 1.5 / 60]
    assert report["inputs"][1]["missing_reason"] == "Acquisition missing"
    assert len(input_result_ids(report)) == len(request_result_bindings(request)) == 4
    assert report["inputs"][0]["geometry"] == records[0]["provenance"]["geometry"]
    assert report["inputs"][0]["selection"] == records[0]["provenance"]["selection"]
    assert report["sample_identity"]["biological_replicate"] == "D1"
    assert "measurements" not in canonical_json(report)
    assert str(wb.project.root) not in canonical_json(report)
    assert ".ome.tif" not in canonical_json(report)
    assert validate_report(report) == report


def test_token_save_get_query_cold_reopen_and_original_masks_preserved(wound):
    wb, request, records, masks = wound
    saved, opaque = save(wb.project, request)
    assert len(canonical_json(opaque).encode()) < 200
    assert execute(wb.project, "wound_closure_save", opaque) == saved
    got = execute(
        ResearchProject(wb.project.root), "wound_closure_get", {"report_id": saved["report_id"]}
    )
    assert got == saved
    listing = execute(wb.project, "wound_closure_list", {})
    assert [r["id"] for r in listing["reports"]] == [saved["report_id"]]
    collected, offset = [], 0
    while True:
        page = execute(
            wb.project,
            "wound_closure_query",
            {**opaque, "table": "frames", "offset": offset, "limit": 2},
        )
        assert len(canonical_json(page).encode()) <= PAGE_BYTES
        collected.extend(page["rows"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert collected == saved["report"]["measurement"]["frames"]
    inputs = execute(
        wb.project,
        "wound_closure_query",
        {"report_id": saved["report_id"], "table": "inputs", "offset": 0, "limit": 100},
    )
    assert inputs["rows"][0]["selected_label_count"] == 1
    assert "selected_labels" not in inputs["rows"][0]
    labels = execute(
        wb.project,
        "wound_closure_query",
        {**opaque, "table": "selected_labels", "frame_id": "frame-0", "offset": 0, "limit": 100},
    )
    assert labels["rows"] == [1] and labels["frame_id"] == "frame-0"
    for t, record in records.items():
        assert wb.project.result(record["id"]) == record
        np.testing.assert_array_equal(wb.project.load_array(record["arrays"]["labels"]), masks[t])


def test_changed_sample_metadata_marks_stale_without_rewriting_endpoints(wound):
    wb, request, records, _ = wound
    saved, opaque = save(wb.project, request)
    sample = wb.project.documents("sample", document_id=records[0]["source_id"])[0]
    wb.project.put_document(
        "sample",
        sample["id"],
        {**sample["data"], "condition": "Later metadata"},
        expected_revision=1,
    )
    reopened = load(ResearchProject(wb.project.root), saved["report_id"])
    assert reopened == saved["report"]
    assert current_status(wb.project, reopened) == {
        "current": False,
        "changes": [{"source_id": sample["id"], "reason": "sample_metadata_changed"}],
    }
    with pytest.raises(ValueError, match="metadata changed"):
        execute(wb.project, "wound_closure_save", opaque)


@pytest.mark.parametrize(
    "attack",
    ["endpoint", "interval", "time", "selection", "mask_hash", "source", "kernel", "sample"],
)
def test_tampered_projection_or_receipts_refused_even_with_new_report_hash(wound, attack):
    wb, request, _, _ = wound
    report = preview(wb.project, request)
    if attack == "endpoint":
        report["measurement"]["frames"][2]["area"] = 999
    elif attack == "interval":
        report["measurement"]["intervals"][0]["area_change_rate"] = 0
    elif attack == "time":
        report["inputs"][2]["time_s"] = 90.5
    elif attack == "selection":
        report["inputs"][2]["selection"]["x"] = 1
    elif attack == "mask_hash":
        report["inputs"][2]["labels"]["sha256"] = "f" * 64
    elif attack == "source":
        report["inputs"][2]["source_sha256"] = "f" * 64
    elif attack == "kernel":
        report["kernel_record_sha256"] = "f" * 64
    else:
        report["inputs"][2]["sample"]["data"]["biological_replicate"] = "Other specimen"
    report["report_hash"] = digest({k: v for k, v in report.items() if k != "report_hash"})
    with pytest.raises(ValueError):
        references(wb.project, report)


@pytest.mark.parametrize(
    "change",
    [
        "stale_revision",
        "boundary_request",
        "boundary_source",
        "duplicate_acquisition",
        "changed_grid",
        "changed_channel",
    ],
)
def test_exact_mask_semantics_revisions_and_grid_refusals(wound, change):
    wb, request, records, _ = wound
    request = copy.deepcopy(request)
    if change == "stale_revision":
        request["frames"][2]["revision_hash"] = "f" * 64
    elif change == "boundary_request":
        request["frames"][2]["mask_semantics"] = "boundary-only"
    elif change == "duplicate_acquisition":
        request["frames"][2].update(
            result_id=records[0]["id"], revision_hash=records[0]["revision_hash"]
        )
    else:
        record = copy.deepcopy(records[2])
        if change == "boundary_source":
            record["provenance"]["mask_semantics"] = "skeleton"
        elif change == "changed_grid":
            record["provenance"]["geometry"]["affine"][0][-1] += 1
        else:
            record["provenance"]["selection"]["c"] = 1
        rehash(record)
        with wb.project.connection() as connection:
            connection.execute(
                "UPDATE results SET record=? WHERE id=?", (canonical_json(record), record["id"])
            )
        request["frames"][2]["revision_hash"] = record["revision_hash"]
    with pytest.raises(ValueError):
        execute(wb.project, "wound_closure_preview", request)
    assert wb.project.documents(DOCUMENT_KIND) == []


@pytest.mark.parametrize(
    "attack",
    [
        "units",
        "time_order",
        "time_count",
        "time_bool",
        "unknown_label",
        "zero_baseline",
        "missing_baseline",
    ],
)
def test_explicit_seconds_baseline_and_selected_labels_fail_closed(wound, attack):
    wb, request, _, _ = wound
    request = copy.deepcopy(request)
    if attack == "units":
        request["time_unit"] = "ms"
    elif attack == "time_order":
        request["time_s"][2] = request["time_s"][1]
    elif attack == "time_count":
        request["time_s"].pop()
    elif attack == "time_bool":
        request["time_s"][0] = True
    elif attack == "unknown_label":
        request["frames"][2]["selected_labels"] = [99]
    elif attack == "zero_baseline":
        request["frames"][0]["selected_labels"] = []
    else:
        request["frames"][0] = {"frame_id": "frame-0", "missing_reason": "No baseline"}
    with pytest.raises(ValueError):
        execute(wb.project, "wound_closure_preview", request)
    assert wb.project.documents(DOCUMENT_KIND) == []


def test_actual_mask_and_original_record_tampering_refused_on_saved_read(wound):
    wb, request, records, _ = wound
    saved, _ = save(wb.project, request)
    descriptor = records[2]["arrays"]["labels"]
    path = wb.project.arrays / (descriptor["sha256"] + ".npy")
    original = path.read_bytes()
    corrupted = bytearray(original)
    corrupted[-1] ^= 1
    path.write_bytes(corrupted)
    with pytest.raises(ValueError, match="hash/size"):
        load(wb.project, saved["report_id"])
    path.write_bytes(original)
    record = copy.deepcopy(records[2])
    record["provenance"]["unreviewed_metadata_change"] = True
    rehash(record)
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(record), record["id"])
        )
    with pytest.raises(ValueError, match="canonical result record hash"):
        load(wb.project, saved["report_id"], verify_arrays=False)


def test_native_export_preserves_every_mask_csv_value_and_plot_gaps(wound, tmp_path):
    import xml.etree.ElementTree as ET

    wb, request, records, _ = wound
    saved, _ = save(wb.project, request)
    p = plan(wb.project, saved["report_id"])
    target = tmp_path / "wound-package"
    approved = grant(wb.project, saved["report_id"], p["plan_hash"], str(target))
    opaque = {k: approved[k] for k in ("grant_id", "plan_hash")}
    assert export_input_result_ids(wb.project, opaque) == input_result_ids(saved["report"])
    receipt = execute_export(wb, opaque)
    assert receipt["basename"] == "wound-package" and "destination" not in receipt
    manifest = json.loads((target / "manifest.json").read_text())
    for item in manifest["files"]:
        data = (target / item["name"]).read_bytes()
        assert (
            len(data) == item["size_bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"]
        )
    assert json.loads((target / "report.json").read_text()) == saved["report"]
    rows = [
        {key: json.loads(value) for key, value in row.items()}
        for row in csv.DictReader(io.StringIO((target / "frames.csv").read_text()))
    ]
    assert [row["area"] for row in rows] == [72, None, 36, 108, 0]
    assert [row["closure_fraction"] for row in rows] == [0, None, 0.5, -0.5, 1]
    assert rows[0]["geometry"] == records[0]["provenance"]["geometry"]
    assert rows[2]["selected_labels"] == [1] and rows[2]["excluded_positive_pixel_count"] == 2
    for record in records.values():
        artifact = record["arrays"]["labels"]
        assert (target / ("labels-" + artifact["sha256"] + ".npy")).read_bytes() == (
            wb.project.arrays / (artifact["sha256"] + ".npy")
        ).read_bytes()
    svg = ET.fromstring((target / "closure.svg").read_text(encoding="utf-8"))
    ns = {"s": "http://www.w3.org/2000/svg"}
    assert len(svg.findall(".//s:circle", ns)) == 4
    lines = [node for node in svg.findall(".//s:path", ns) if node.get("stroke") == "#285c8d"]
    assert len(lines) == 2  # Missing frame creates no baseline-to-later bridge.
    with pytest.raises(ValueError, match="absent"):
        execute_export(wb, opaque)


@pytest.mark.parametrize("stage", ["document", "job"])
def test_atomic_save_guard_rolls_back_document_and_job_completion(wound, monkeypatch, stage):
    wb, request, _, _ = wound
    opaque = token(execute(wb.project, "wound_closure_preview", request))
    job = wb.project.submit(
        "wound_closure_save",
        {"source_id": save_task_source(wb.project, opaque), "task_request": opaque},
        "wound-rollback",
    )
    wb.project.update_job(job["id"], expected_state="queued", state="running")
    original = wb.project.connection
    mutated = False

    def trace(sql):
        nonlocal mutated
        if (stage == "document" and sql.startswith("INSERT INTO documents")) or (
            stage == "job" and sql.startswith("UPDATE jobs SET record=")
        ):
            mutated = True

    @contextmanager
    def observed():
        with original() as connection:
            connection.set_trace_callback(trace)
            yield connection

    def revoked():
        if mutated:
            raise PermissionError("Wound authority revoked after mutation")

    monkeypatch.setattr(wb.project, "connection", observed)
    with pytest.raises(PermissionError, match="revoked after mutation"):
        save_job(wb.project, opaque, job["id"], check=revoked)
    assert wb.project.documents(DOCUMENT_KIND) == []
    assert wb.project.job(job["id"])["state"] == "running"


def test_atomic_save_finishes_exact_job_and_refuses_cancelled_other_requests(wound):
    wb, request, _, _ = wound
    opaque = token(execute(wb.project, "wound_closure_preview", request))
    source = save_task_source(wb.project, opaque)
    job = wb.project.submit(
        "wound_closure_save", {"source_id": source, "task_request": opaque}, "wound-good"
    )
    wb.project.update_job(job["id"], expected_state="queued", state="running")
    saved = save_job(wb.project, opaque, job["id"])
    assert wb.project.job(job["id"])["state"] == "succeeded"
    assert wb.project.job(job["id"])["report_id"] == saved["report_id"]
    cancelled = wb.project.submit(
        "wound_closure_save", {"source_id": source, "task_request": opaque}, "wound-cancelled"
    )
    wb.project.update_job(
        cancelled["id"], expected_state="queued", state="running", cancel_requested=True
    )
    with pytest.raises(ValueError, match="cancelled"):
        save_job(wb.project, opaque, cancelled["id"])
    other = {**opaque, "preview_hash": "f" * 64}
    wrong = wb.project.submit(
        "wound_closure_save", {"source_id": source, "task_request": other}, "wound-wrong-token"
    )
    wb.project.update_job(wrong["id"], expected_state="queued", state="running")
    with pytest.raises(ValueError, match="changed"):
        save_job(wb.project, opaque, wrong["id"])
    assert len(wb.project.documents(DOCUMENT_KIND)) == 1


def test_export_revocation_leaves_no_published_or_partial_package(wound, tmp_path, monkeypatch):
    import loci_engine.research_wound_closure as module

    wb, request, _, _ = wound
    saved, _ = save(wb.project, request)
    p = plan(wb.project, saved["report_id"])
    target = tmp_path / "revoked-package"
    original = module._verify_files

    def revoked(stage_fd, records, check=None):
        original(stage_fd, records, check)
        raise PermissionError("Revoked after complete staging")

    monkeypatch.setattr(module, "_verify_files", revoked)
    with pytest.raises(PermissionError, match="Revoked"):
        publish(wb.project, saved["report_id"], p, target)
    assert not target.exists() and not list(tmp_path.glob(".loci-wound-*"))


def test_portable_reference_replay_requires_matching_original_records_and_masks(wound):
    wb, request, records, _ = wound
    report = preview(wb.project, request)
    by_id = {r["id"]: r for r in records.values()}
    sources = {r["source_id"]: wb.project.source(r["source_id"]) for r in records.values()}
    assert (
        validate_portable_references(report, by_id, sources, array_loader=wb.project.load_array)
        == report
    )
    altered = copy.deepcopy(by_id)
    altered[records[2]["id"]]["provenance"]["selection"]["x"] = 1
    rehash(altered[records[2]["id"]])
    with pytest.raises(ValueError, match="retained result changed"):
        validate_portable_references(report, altered, sources)

    def bad_array(descriptor):
        array = wb.project.load_array(descriptor).copy()
        array.flat[0] ^= 1
        return array

    with pytest.raises(ValueError, match="exact retained artifact"):
        validate_portable_references(report, by_id, sources, array_loader=bad_array)


def test_preview_cache_eviction_and_runtime_changes_do_not_grant_save_authority(wound, monkeypatch):
    import loci_engine.research_wound_closure as module

    wb, request, _, _ = wound
    first = token(execute(wb.project, "wound_closure_preview", request))
    saved = execute(wb.project, "wound_closure_save", first)
    for _ in range(MAX_PREVIEWS):
        latest = token(execute(wb.project, "wound_closure_preview", request))
    with wb.project.connection() as connection:
        rows = connection.execute(
            "SELECT value FROM metadata WHERE key LIKE ?", (PREVIEW_PREFIX + "%",)
        ).fetchall()
    assert len(rows) == MAX_PREVIEWS
    assert sum(len(row[0].encode()) for row in rows) <= module.MAX_PREVIEW_BYTES
    with pytest.raises(ValueError, match="unavailable or evicted"):
        execute(wb.project, "wound_closure_save", first)
    assert load(wb.project, saved["report_id"]) == saved["report"]
    actual = module._software()
    monkeypatch.setattr(module, "_software", lambda: {**actual, "kernel_sha256": "f" * 64})
    with pytest.raises(ValueError, match="runtime changed"):
        execute(wb.project, "wound_closure_save", latest)


def test_recursive_input_bindings_include_parent_masks_without_copying_measurement_populations(
    wound,
):
    wb, request, records, _ = wound
    parent = records[2]
    derived = wb.project.save_result(
        source_id=parent["source_id"],
        kind="corrected-labels",
        arrays={
            "image": wb.project.load_array(parent["arrays"]["image"]),
            "labels": wb.project.load_array(parent["arrays"]["labels"]),
        },
        provenance=parent["provenance"],
        parent_id=parent["id"],
    )
    request = copy.deepcopy(request)
    request["frames"][2].update(result_id=derived["id"], revision_hash=derived["revision_hash"])
    report = preview(wb.project, request)
    assert len(input_result_ids(report)) == 5
    assert parent["id"] in input_result_ids(report)
    assert "measurements" not in canonical_json(report)
    assert report["measurement"]["frames"][2]["area"] == 36


def test_missing_sample_metadata_remains_explicit_without_invented_biological_identity(wound):
    wb, request, records, _ = wound
    with wb.project.connection() as connection:
        connection.execute(
            "DELETE FROM documents WHERE kind='sample' AND id=?", (records[0]["source_id"],)
        )
    report = preview(wb.project, request)
    assert report["sample_identity"]["study"] is None
    assert report["sample_identity"]["biological_replicate"] is None
    assert report["sample_identity"]["missing_sample_frames"] == 4
    assert report["measurement"]["frames"][2]["closure_fraction"] == 0.5


def test_conflicting_known_specimen_samples_refused_before_any_publication(wound, tmp_path):
    wb, request, _, masks = wound
    path = tmp_path / "other-declared-specimen.ome.tif"
    raw = np.full((8, 10), 17, np.uint16)
    tifffile.imwrite(
        path,
        raw,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 3.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    source = wb.import_native(str(path))
    image, geometry, selection = wb.load_scalar(source["id"], {})
    wb.project.put_document(
        "sample",
        source["id"],
        {
            "study": "Generated wound study",
            "sample": "Other",
            "condition": "Technical fixture",
            "biological_replicate": "D2",
        },
        expected_revision=0,
    )
    mask = masks[2]
    record = wb.project.save_result(
        source_id=source["id"],
        kind="external-labels",
        arrays={"image": image, "labels": mask},
        provenance={
            "geometry": geometry.to_dict(),
            "selection": selection,
            "runtime": runtime_record(),
            "measurement_channels": [0],
            "mask_semantics": FILLED_AREA,
            "measurements": measure_objects(mask, geometry, {"raw": image}),
        },
    )
    request = copy.deepcopy(request)
    request["frames"][2].update(result_id=record["id"], revision_hash=record["revision_hash"])
    with pytest.raises(ValueError, match="conflicting declared.*specimen"):
        execute(wb.project, "wound_closure_preview", request)
    assert wb.project.documents(DOCUMENT_KIND) == []


def test_aggregate_memory_budget_refuses_before_array_decode(wound, monkeypatch):
    wb, request, records, _ = wound
    request = copy.deepcopy(request)
    request["working_bytes"] = 1024**2
    for t, original in records.items():
        record = copy.deepcopy(original)
        record["provenance"]["fixture_padding"] = "x" * (300 * 1024)
        rehash(record)
        with wb.project.connection() as connection:
            connection.execute(
                "UPDATE results SET record=? WHERE id=?", (canonical_json(record), record["id"])
            )
        request["frames"][t]["revision_hash"] = record["revision_hash"]
    monkeypatch.setattr(
        wb.project, "load_array", lambda descriptor: pytest.fail("Budget must refuse before decode")
    )
    with pytest.raises(ValueError, match="working-memory budget before decode"):
        preview(wb.project, request)


def test_export_plan_sample_drift_and_private_grant_location_are_fail_closed(wound, tmp_path):
    wb, request, records, _ = wound
    saved, _ = save(wb.project, request)
    p = plan(wb.project, saved["report_id"])
    sample = wb.project.documents("sample", document_id=records[0]["source_id"])[0]
    wb.project.put_document(
        "sample", sample["id"], {**sample["data"], "condition": "Changed"}, expected_revision=1
    )
    with pytest.raises(ValueError, match="changed"):
        grant(wb.project, saved["report_id"], p["plan_hash"], str(tmp_path / "stale-wound"))
    fresh = plan(wb.project, saved["report_id"])
    assert fresh["status"]["current"] is False
    approved = grant(
        wb.project, saved["report_id"], fresh["plan_hash"], str(tmp_path / "wound-stale-explicit")
    )
    with wb.project.connection() as connection:
        row = connection.execute(
            "SELECT record FROM documents WHERE kind='wound_closure_export_grant' AND id=?",
            (approved["grant_id"],),
        ).fetchone()
        document = json.loads(row[0])
        document["data"]["private_project_root"] = str(tmp_path / "different-study")
        connection.execute(
            "UPDATE documents SET record=? WHERE kind='wound_closure_export_grant' AND id=?",
            (canonical_json(document), approved["grant_id"]),
        )
    with pytest.raises(ValueError, match="another study location"):
        execute_export(wb, {k: approved[k] for k in ("grant_id", "plan_hash")})
