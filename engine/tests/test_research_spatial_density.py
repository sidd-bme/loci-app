"""Real immutable records/arrays and independent donor arithmetic, no patient data."""

import copy
import csv
import hashlib
import io
import json

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import measure_objects
from loci_engine.research_groups import dispatch_group
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_spatial_density import (
    DOCUMENT_KIND,
    execute,
    execute_export,
    export_input_result_ids,
    grant,
    input_result_ids,
    load,
    plan,
    preview,
    publish,
    validate_report,
)
from loci_engine.workbench import Workbench, runtime_record


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


@pytest.fixture
def density(tmp_path):
    wb = Workbench(ResearchProject.create(tmp_path / "density.loci-study", "Density fixture"))
    results, parents = [], []
    for index, (count, donor, condition) in enumerate(
        [(1, "D1", "A"), (3, "D1", "A"), (1, "D2", "A"), (1, "D1", "B")]
    ):
        path = tmp_path / f"generated-{index}.ome.tif"
        image = (np.arange(120, dtype=np.uint16) + index).reshape(10, 12)
        tifffile.imwrite(
            path,
            image,
            ome=True,
            metadata={
                "axes": "YX",
                "PhysicalSizeX": 1.0,
                "PhysicalSizeXUnit": "µm",
                "PhysicalSizeY": 2.0,
                "PhysicalSizeYUnit": "µm",
            },
        )
        source = wb.import_native(str(path))
        wb.project.put_document(
            "sample",
            source["id"],
            {
                "study": "Synthetic study",
                "sample": f"Field {index}",
                "condition": condition,
                "biological_replicate": donor,
            },
            expected_revision=0,
        )
        raw, geometry, selection = wb.load_scalar(source["id"], {"level": 0})
        labels = np.zeros(image.shape, np.uint32)
        for label, (y, x) in enumerate([(3, 3), (5, 7), (6, 8)][:count], 1):
            labels[y, x] = label
        compartment = np.ones_like(labels)
        boundary = np.zeros_like(labels)
        boundary[:, 1] = 1
        inputs = []
        for mask in (labels, compartment, boundary):
            inputs.append(
                wb.project.save_result(
                    source_id=source["id"],
                    kind="segmentation",
                    arrays={"image": raw, "labels": mask},
                    provenance={
                        "geometry": geometry.to_dict(),
                        "selection": selection,
                        "runtime": runtime_record(),
                        "measurement_channels": [0],
                        "measurements": measure_objects(mask, geometry, {"raw": raw}),
                    },
                )
            )
        bindings = [{"result_id": r["id"], "revision_hash": r["revision_hash"]} for r in inputs]
        output = wb.execute(
            "spatial_distance_run",
            {
                **bindings[0],
                "compartment": bindings[1],
                "boundary": bindings[2],
                "band_edges": [0, 20],
                "exclude_crop_border": True,
                "control": "Generated technical fixture",
                "boundary_coverage": "Supplied column",
                "working_bytes": 16 * 1024**2,
            },
        )
        results.append(wb.project.result(output["result"]["id"]))
        parents.extend(inputs)
    request = {
        "fields": [{"result_id": r["id"], "revision_hash": r["revision_hash"]} for r in results],
        "condition_pair": ["A", "B"],
    }
    return wb, request, results, parents


def save(project, request):
    opaque = execute(project, "spatial_density_preview", request)
    token = {k: opaque[k] for k in ("preview_id", "preview_hash")}
    return execute(project, "spatial_density_save", token)


def test_preview_pools_counts_and_areas_then_equal_weights_donors(density):
    wb, request, _, _ = density
    report = preview(wb.project, request)
    a = report["aggregation"]
    donors = {(r["condition"], r["biological_replicate"]): r for r in a["donor_rows"]}
    assert donors["A", "D1"]["object_count"] == 4
    assert donors["A", "D1"]["sampled_area"] == 480
    assert donors["A", "D1"]["density"] == pytest.approx(4 / 480)
    assert donors["A", "D2"]["density"] == pytest.approx(1 / 240)
    condition = next(r for r in a["condition_rows"] if r["condition"] == "A")
    assert condition["n"] == 2
    assert condition["mean"] == pytest.approx((4 / 480 + 1 / 240) / 2)
    assert condition["mean"] != pytest.approx(5 / 720)
    assert a["paired_rows"][0]["difference"] == pytest.approx(1 / 240 - 4 / 480)
    assert a["unmatched_donors"] == [
        {
            "study": "Synthetic study",
            "condition": "A",
            "biological_replicate": "D2",
            "reason": "missing_paired_condition",
        }
    ]
    assert len(input_result_ids(report)) == 16
    assert str(wb.project.root) not in canonical_json(report)
    assert ".ome.tif" not in canonical_json(report)


def test_save_get_list_reopen_and_metadata_change_preserve_report(density):
    wb, request, results, _ = density
    saved = save(wb.project, request)
    report_id = saved["report_id"]
    assert (
        execute(
            wb.project,
            "spatial_density_save",
            {"preview_id": saved["report_id"], "preview_hash": saved["report"]["report_hash"]},
        )
        == saved
    )
    source_id = results[0]["source_id"]
    sample = wb.project.documents("sample", document_id=source_id)[0]
    wb.project.put_document(
        "sample",
        source_id,
        {**sample["data"], "condition": "Changed"},
        expected_revision=sample["revision"],
    )
    got = execute(wb.project, "spatial_density_get", {"report_id": report_id})
    assert got["report"] == saved["report"]
    assert got["status"]["current"] is False
    assert got["status"]["changes"][0]["reason"] == "sample_metadata_changed"
    assert execute(wb.project, "spatial_density_list", {})["reports"][0]["status"] == got["status"]
    assert load(ResearchProject(wb.project.root), report_id) == saved["report"]
    with pytest.raises(ValueError, match="changed"):
        execute(
            wb.project,
            "spatial_density_save",
            {"preview_id": saved["report_id"], "preview_hash": saved["report"]["report_hash"]},
        )
    with pytest.raises(ValueError, match="immutable"):
        wb.project.put_document(DOCUMENT_KIND, report_id, saved["report"], expected_revision=1)


@pytest.mark.parametrize("tamper", ["endpoint", "result", "sample", "missing_parent", "group"])
def test_replay_refuses_tampered_snapshots_even_with_new_outer_hash(density, tamper):
    wb, request, _, _ = density
    report = preview(wb.project, request)
    if tamper == "endpoint":
        report["aggregation"]["donor_rows"][0]["object_count"] += 1
    elif tamper == "result":
        report["aggregation"]["input_snapshots"][0]["result"]["source_sha256"] = "f" * 64
    elif tamper == "sample":
        report["aggregation"]["input_snapshots"][0]["sample"]["data"]["condition"] = "Forged"
    elif tamper == "missing_parent":
        report["result_bindings"] = report["result_bindings"][1:]
    else:
        report["phenotype_bindings"].append({"id": "f" * 32})
    report["report_hash"] = digest({k: v for k, v in report.items() if k != "report_hash"})
    with pytest.raises(ValueError):
        validate_report(report)


def test_stale_preview_and_stale_sample_save_refused(density):
    wb, request, results, _ = density
    stale = copy.deepcopy(request)
    stale["fields"][0]["revision_hash"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        preview(wb.project, stale)
    opaque = execute(wb.project, "spatial_density_preview", request)
    token = {k: opaque[k] for k in ("preview_id", "preview_hash")}
    sample = wb.project.documents("sample", document_id=results[0]["source_id"])[0]
    wb.project.put_document(
        "sample",
        sample["id"],
        {**sample["data"], "biological_replicate": "D9"},
        expected_revision=1,
    )
    with pytest.raises(ValueError, match="changed"):
        execute(wb.project, "spatial_density_save", token)
    assert not wb.project.documents(DOCUMENT_KIND)


def test_phenotype_group_exact_binding_definition_and_full_denominator(density):
    wb, request, results, _ = density
    request = copy.deepcopy(request)
    request["phenotype_name"] = "Declared positive phenotype"
    for field, result in zip(request["fields"], results, strict=True):
        parent = result["provenance"]["spatial"]["inputs"]["objects"]
        gate_request = {
            "result_id": parent["result_id"],
            "revision_hash": parent["revision_hash"],
            "gate": {
                "kind": "rectangle",
                "x_metric": "voxel_count",
                "y_metric": "voxel_count",
                "bounds": [0, 2, 0, 2],
            },
        }
        evaluated = dispatch_group(wb.project, "population_gate_evaluate", gate_request)
        document = dispatch_group(
            wb.project,
            "population_group_save",
            {
                **gate_request,
                "name": "Positive",
                "membership_sha256": evaluated["membership_sha256"],
            },
        )
        field.update(
            phenotype_group_id=document["id"],
            phenotype_record_sha256=document["data"]["record_sha256"],
        )
    report = preview(wb.project, request)
    assert len(report["phenotype_bindings"]) == 4
    assert report["aggregation"]["donor_rows"][0]["sampled_area"] == 480
    request["fields"][0]["phenotype_record_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        preview(wb.project, request)


def test_tampered_mask_bytes_refused_by_getter(density):
    wb, request, results, _ = density
    saved = save(wb.project, request)
    descriptor = results[0]["arrays"]["boundary_labels"]
    path = wb.project.arrays / (descriptor["sha256"] + ".npy")
    data = bytearray(path.read_bytes())
    data[-1] ^= 1
    path.write_bytes(data)
    with pytest.raises(ValueError, match="hash/size"):
        load(wb.project, saved["report_id"])


@pytest.mark.parametrize("tamper", ["units", "grid"])
def test_mixed_units_and_mismatched_grid_refused(density, monkeypatch, tamper):
    wb, request, results, _ = density
    original = wb.project.result
    altered = copy.deepcopy(results[1])
    if tamper == "units":
        altered["provenance"]["geometry"]["unit"] = "mm"
        altered["provenance"]["spatial"]["distance_unit"] = "mm"
        altered["provenance"]["spatial"]["area_unit"] = "mm^2"
    else:
        altered["provenance"]["geometry"]["affine"][0][-1] += 1
    altered["revision_hash"] = digest({k: v for k, v in altered.items() if k != "revision_hash"})
    request = copy.deepcopy(request)
    request["fields"][1]["revision_hash"] = altered["revision_hash"]
    monkeypatch.setattr(
        wb.project,
        "result",
        lambda identity, **kwargs: (
            altered if identity == altered["id"] else original(identity, **kwargs)
        ),
    )
    with pytest.raises(ValueError, match="units|grid"):
        preview(wb.project, request)


def test_atomic_export_complete_report_roundtrip_and_no_replace(density, tmp_path):
    wb, request, _, _ = density
    saved = save(wb.project, request)
    p = plan(wb.project, saved["report_id"])
    target = tmp_path / "density-package"
    opaque = grant(wb.project, saved["report_id"], p["plan_hash"], str(target))
    export_request = {k: opaque[k] for k in ("grant_id", "plan_hash")}
    assert export_input_result_ids(wb.project, export_request) == input_result_ids(saved["report"])
    receipt = execute_export(wb, export_request)
    assert receipt["basename"] == "density-package"
    assert json.loads((target / "report.json").read_text()) == saved["report"]
    manifest = json.loads((target / "manifest.json").read_text())
    for file in manifest["files"]:
        data = (target / file["name"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == file["sha256"]
        assert len(data) == file["size_bytes"]
    rows = list(csv.DictReader(io.StringIO((target / "donor-rows.csv").read_text())))
    decoded = [{k: json.loads(v) for k, v in row.items()} for row in rows]
    assert decoded == saved["report"]["aggregation"]["donor_rows"]
    assert str(wb.project.root) not in (target / "report.json").read_text()
    with pytest.raises(ValueError, match="absent"):
        execute_export(wb, export_request)


def test_export_cancellation_leaves_no_partial_publication(density, tmp_path, monkeypatch):
    import loci_engine.research_spatial_density as module

    wb, request, _, _ = density
    saved = save(wb.project, request)
    p = plan(wb.project, saved["report_id"])
    target = tmp_path / "cancelled-density"
    original = module._verify_files

    def revoke(stage_fd, expected, check=None):
        original(stage_fd, expected, check)
        raise PermissionError("fixture grant revoked after writes")

    monkeypatch.setattr(module, "_verify_files", revoke)
    with pytest.raises(PermissionError, match="revoked"):
        publish(wb.project, saved["report_id"], p, target)
    assert not target.exists()
    assert not list(tmp_path.glob(".loci-spatial-density-*"))


def test_export_plan_goes_stale_when_sample_changes(density, tmp_path):
    wb, request, results, _ = density
    saved = save(wb.project, request)
    p = plan(wb.project, saved["report_id"])
    sample = wb.project.documents("sample", document_id=results[0]["source_id"])[0]
    wb.project.put_document(
        "sample", sample["id"], {**sample["data"], "condition": "Changed"}, expected_revision=1
    )
    with pytest.raises(ValueError, match="changed"):
        grant(wb.project, saved["report_id"], p["plan_hash"], str(tmp_path / "stale-export"))


def test_portable_study_retains_report_and_old_sample_snapshot(density, tmp_path):
    from loci_engine.research_interchange import export_project, import_project

    wb, request, results, _ = density
    saved = save(wb.project, request)
    sample = wb.project.documents("sample", document_id=results[0]["source_id"])[0]
    wb.project.put_document(
        "sample",
        sample["id"],
        {**sample["data"], "condition": "Later metadata"},
        expected_revision=1,
    )
    archive = tmp_path / "density-study.zip"
    export_project(wb.project, archive)
    target = tmp_path / "restored.loci-study"
    import_project(archive, target)
    restored = ResearchProject(target)
    report = execute(restored, "spatial_density_get", {"report_id": saved["report_id"]})
    assert report["report"] == saved["report"]
    assert report["status"]["current"] is False


def test_save_publication_guard_prevents_document(density):
    wb, request, _, _ = density
    opaque = execute(wb.project, "spatial_density_preview", request)
    token = {k: opaque[k] for k in ("preview_id", "preview_hash")}

    def revoked():
        raise PermissionError("density study grant revoked")

    with pytest.raises(PermissionError, match="revoked"):
        execute(wb.project, "spatial_density_save", token, check=revoked)
    assert wb.project.documents(DOCUMENT_KIND) == []


def test_legacy_v1_report_remains_readable_but_legacy_echo_save_is_refused(density):
    from loci_engine.research_spatial_density import _legacy_preview

    wb, request, _, _ = density
    report = _legacy_preview(wb.project, request)
    assert report["schema"] == "loci.spatial-density-report/v1"
    validate_report(report)
    identity = report["report_hash"][:32]
    wb.project.put_document(DOCUMENT_KIND, identity, report, expected_revision=0)
    assert load(wb.project, identity) == report
    with pytest.raises(ValueError, match="Legacy.*preview again"):
        execute(wb.project, "spatial_density_save", {"report_json": canonical_json(report)})


def test_preview_tokens_are_bounded_expire_and_do_not_replace_saved_reports(density, monkeypatch):
    import loci_engine.research_spatial_density as module

    wb, request, _, _ = density
    request = {"fields": request["fields"][:1]}
    first = execute(wb.project, "spatial_density_preview", request)
    token = {k: first[k] for k in ("preview_id", "preview_hash")}
    saved = execute(wb.project, "spatial_density_save", token)
    for _ in range(8):
        latest = execute(wb.project, "spatial_density_preview", request)
    with wb.project.connection() as connection:
        cached = connection.execute(
            "SELECT value FROM metadata WHERE key LIKE ?", (module.PREVIEW_PREFIX + "%",)
        ).fetchall()
    assert len(cached) == 8
    assert sum(len(row[0].encode()) for row in cached) <= module.MAX_PREVIEW_BYTES
    with pytest.raises(ValueError, match="unavailable or evicted"):
        execute(wb.project, "spatial_density_save", token)
    assert load(wb.project, saved["report_id"]) == saved["report"]
    bad = {"preview_id": latest["preview_id"], "preview_hash": "f" * 64}
    with pytest.raises(ValueError, match="identity changed"):
        execute(wb.project, "spatial_density_save", bad)
    monkeypatch.setattr(module, "MAX_PREVIEW_BYTES", 100)
    with pytest.raises(ValueError, match="cache byte limit"):
        execute(wb.project, "spatial_density_preview", request)


def test_query_pages_are_exact_bounded_and_cells_keep_saved_sample_context(density):
    wb, request, results, _ = density
    output = execute(wb.project, "spatial_density_preview", request)
    token = {k: output[k] for k in ("preview_id", "preview_hash")}
    saved = execute(wb.project, "spatial_density_save", token)
    collected = []
    offset = 0
    while True:
        page = execute(
            wb.project,
            "spatial_density_query",
            {**token, "table": "input_snapshots", "offset": offset, "limit": 2},
        )
        assert len(canonical_json(page).encode()) <= 64 * 1024
        assert page["returned"] == len(page["rows"])
        assert page["report_hash"] == saved["report"]["report_hash"]
        collected.extend(page["rows"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert collected == saved["report"]["aggregation"]["input_snapshots"]
    selected = results[1]
    sample = wb.project.documents("sample", document_id=selected["source_id"])[0]
    wb.project.put_document(
        "sample", sample["id"], {**sample["data"], "condition": "Later edit"}, expected_revision=1
    )
    page = execute(
        wb.project,
        "spatial_density_query",
        {
            "report_id": saved["report_id"],
            "table": "cells",
            "field_result_id": selected["id"],
            "offset": 0,
            "limit": 100,
        },
    )
    assert page["total"] == page["returned"] == 3
    assert all(row["condition"] == "A" for row in page["rows"])
    assert [row["measurement"] for row in page["rows"]] == selected["provenance"]["measurements"]
    assert all(row["schema"] == "loci.spatial-density-cell/v1" for row in page["rows"])


def test_portable_cache_omission_and_finished_save_job_is_historical(density, tmp_path):
    from loci_engine.research_interchange import export_project, import_project
    from loci_engine.research_jobs import run_job, submit_job
    from loci_engine.research_spatial_density import PREVIEW_PREFIX

    wb, request, _, _ = density
    opaque = execute(wb.project, "spatial_density_preview", request)
    token = {k: opaque[k] for k in ("preview_id", "preview_hash")}
    job = submit_job(wb, token, "density-portable-save", operation="spatial_density_save")
    saved = run_job(wb, job["id"])
    archive = tmp_path / "density-cache-free.zip"
    export_project(wb.project, archive)
    restored = import_project(archive, tmp_path / "restored-cache-free.loci-study")
    assert load(restored, saved["report_id"]) == saved["report"]
    with restored.connection() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM metadata WHERE key LIKE ?", (PREVIEW_PREFIX + "%",)
            ).fetchone()[0]
            == 0
        )
    historical = restored.job(job["id"])
    assert historical["state"] == "succeeded" and historical["interchange"]["historical"] is True
    assert run_job(Workbench(restored), job["id"])["job"]["state"] == "succeeded"
    with pytest.raises(ValueError, match="unavailable or evicted"):
        execute(restored, "spatial_density_save", token)


@pytest.fixture
def density_40x1000(tmp_path):
    """Ten declared donor/condition sources, four nonoverlapping 1000-cell fields each."""
    wb = Workbench(
        ResearchProject.create(tmp_path / "density40.loci-study", "Generated scale fixture")
    )
    results = []
    ys, xs = np.mgrid[1:33, 1:33]
    for donor in range(1, 6):
        for condition in ("A", "B"):
            index = (donor - 1) * 2 + (condition == "B")
            raw_source = (np.arange(128 * 128, dtype=np.uint16) + index).reshape(128, 128)
            path = tmp_path / f"scale-{donor}-{condition}.ome.tif"
            tifffile.imwrite(
                path,
                raw_source,
                ome=True,
                metadata={
                    "axes": "YX",
                    "PhysicalSizeX": 1.0,
                    "PhysicalSizeXUnit": "µm",
                    "PhysicalSizeY": 1.0,
                    "PhysicalSizeYUnit": "µm",
                },
            )
            source = wb.import_native(str(path))
            wb.project.put_document(
                "sample",
                source["id"],
                {
                    "study": "Generated scale study",
                    "sample": f"D{donor}-{condition}",
                    "condition": condition,
                    "biological_replicate": f"D{donor}",
                },
                expected_revision=0,
            )
            for x, y in ((0, 0), (64, 0), (0, 64), (64, 64)):
                raw, geometry, selection = wb.load_scalar(
                    source["id"], {"x": x, "y": y, "width": 64, "height": 64}
                )
                labels = np.zeros((64, 64), np.uint32)
                labels[ys.ravel()[:1000], xs.ravel()[:1000]] = np.arange(1, 1001, dtype=np.uint32)
                compartment = np.ones_like(labels)
                boundary = np.zeros_like(labels)
                boundary[:, 0] = 1
                inputs = []
                for mask in (labels, compartment, boundary):
                    inputs.append(
                        wb.project.save_result(
                            source_id=source["id"],
                            kind="segmentation",
                            arrays={"image": raw, "labels": mask},
                            provenance={
                                "geometry": geometry.to_dict(),
                                "selection": selection,
                                "runtime": runtime_record(),
                                "measurement_channels": [0],
                                "measurements": measure_objects(mask, geometry, {"raw": raw}),
                            },
                        )
                    )
                bindings = [
                    {"result_id": r["id"], "revision_hash": r["revision_hash"]} for r in inputs
                ]
                result = wb.execute(
                    "spatial_distance_run",
                    {
                        **bindings[0],
                        "compartment": bindings[1],
                        "boundary": bindings[2],
                        "band_edges": [0, 100],
                        "exclude_crop_border": True,
                        "control": "Generated 1000-cell grid",
                        "boundary_coverage": "Supplied full-height column",
                        "working_bytes": 32 * 1024**2,
                    },
                )["result"]
                results.append(wb.project.result(result["id"]))
    request = {
        "fields": [{"result_id": r["id"], "revision_hash": r["revision_hash"]} for r in results],
        "condition_pair": ["A", "B"],
    }
    return wb, request, results


def test_40_images_1000_cells_have_small_receipts_same_donor_math_and_exact_pages(density_40x1000):
    import time

    from test_agent_spatial_density import scoped_agent

    from loci_engine.research_spatial_density import _load_preview

    wb, request, results = density_40x1000
    opaque = execute(wb.project, "spatial_density_preview", request)
    token = {k: opaque[k] for k in ("preview_id", "preview_hash")}
    assert len(canonical_json(token).encode()) < 200
    assert len(canonical_json(opaque).encode()) <= 64 * 1024 + 256
    report = _load_preview(wb.project, token)
    assert report["schema"] == "loci.spatial-density-report/v2"
    assert len(canonical_json(report).encode()) < 512 * 1024
    assert "measurements" not in canonical_json(report)
    a = report["aggregation"]
    assert len(a["field_rows"]) == 40 and len(a["donor_rows"]) == 10
    assert all(
        row["object_count"] == 4000 and row["sampled_area"] == 4 * 4096 for row in a["donor_rows"]
    )
    assert all(row["density"] == 1000 / 4096 for row in a["donor_rows"])
    assert all(
        row["n"] == 5 and row["mean"] == 1000 / 4096 and row["sd"] == 0
        for row in a["condition_rows"]
    )
    assert len(a["paired_rows"]) == 5 and all(row["difference"] == 0 for row in a["paired_rows"])
    # Actual source-authorized disposable agent task: the LLM sends only131B.
    agent = scoped_agent(wb.project.root.parent, wb, results, memory_bytes=512 * 1024**2)
    submitted = agent.submit_action("spatial_density_save", token, "density40-agent-save")["job"]
    deadline = time.monotonic() + 60
    while True:
        job = wb.project.job(submitted["id"])
        if job["state"] not in {"queued", "running"}:
            break
        if time.monotonic() >= deadline:
            raise AssertionError("Bounded density agent save did not finish")
        time.sleep(0.05)
    assert job["state"] == "succeeded", job
    saved = execute(wb.project, "spatial_density_get", {"report_id": token["preview_id"]})
    assert saved["report"] == report
    agent_get = agent.inspect_action("spatial_density_get", {"report_id": saved["report_id"]})
    assert "report" not in agent_get
    assert agent_get["summary"]["report_hash"] == report["report_hash"]
    assert len(canonical_json(agent_get).encode()) < 128 * 1024
    agent_page = agent.inspect_action(
        "spatial_density_query",
        {"report_id": saved["report_id"], "table": "field_rows", "offset": 5, "limit": 10},
    )
    assert agent_page["returned"] == 10 and agent_page["rows"] == a["field_rows"][5:15]
    page = execute(
        wb.project,
        "spatial_density_query",
        {
            "report_id": saved["report_id"],
            "table": "cells",
            "field_result_id": results[0]["id"],
            "offset": 900,
            "limit": 100,
        },
    )
    assert page["total"] == 1000 and 0 < page["returned"] <= 100
    assert len(canonical_json(page).encode()) <= 64 * 1024
    assert page["rows"][0]["label"] == 901
    target = wb.project.root.parent / "density40-export"
    export_plan = plan(wb.project, saved["report_id"])
    receipt = publish(wb.project, saved["report_id"], export_plan, target)
    assert receipt["report_hash"] == report["report_hash"]
    cell_file = target / "cells.csv"
    manifest = json.loads((target / "manifest.json").read_text())
    cell_manifest = next(f for f in manifest["files"] if f["name"] == "cells.csv")
    data = cell_file.read_bytes()
    assert len(data) == cell_manifest["size_bytes"]
    assert hashlib.sha256(data).hexdigest() == cell_manifest["sha256"]
    counts = {}
    with cell_file.open(newline="") as stream:
        for row in csv.DictReader(stream):
            cell = {k: json.loads(value) for k, value in row.items()}
            assert cell["schema"] == "loci.spatial-density-cell/v1"
            assert cell["phenotype_member"] is True and cell["contributes_to_donor_density"] is True
            assert cell["measurement"]["label"] == cell["label"]
            assert cell["centroid_index"] == cell["measurement"]["centroid_index"]
            assert cell["centroid_world_xyz"] == cell["measurement"]["centroid_world_xyz"]
            assert cell["index_axes"] == cell["measurement"]["index_axes"] == "YX"
            assert cell["intensity"] == cell["measurement"]["intensity"]
            assert cell["intensity"]["raw"]["mean"] is not None
            assert cell["coordinate_unit"] == "um"
            assert cell["phenotype_name"] is None
            key = (cell["condition"], cell["biological_replicate"])
            counts[key] = counts.get(key, 0) + 1
    assert sum(counts.values()) == 40_000
    assert len(counts) == 10 and set(counts.values()) == {4000}
    print(
        "density40_sizes",
        canonical_json(
            {
                "token_bytes": len(canonical_json(token).encode()),
                "preview_bytes": len(canonical_json(opaque).encode()),
                "report_bytes": len(canonical_json(report).encode()),
                "cell_csv_bytes": len(data),
            }
        ),
    )


def test_metadata_open_binds_full_records_without_replaying_cells(density, monkeypatch):
    import loci_engine.spatial_density as kernel

    wb, request, _, _ = density
    saved = save(wb.project, request)
    original = kernel.project_spatial_density_field
    calls = []

    def observed(field):
        calls.append(field["result"]["id"])
        return original(field)

    monkeypatch.setattr(kernel, "project_spatial_density_field", observed)
    reopened = ResearchProject(wb.project.root)
    assert calls == []
    assert load(reopened, saved["report_id"]) == saved["report"]
    assert len(calls) == 4
    binding = saved["report"]["result_bindings"][0]
    record = wb.project.result(binding["id"])
    record["provenance"]["fixture_tampering"] = True
    record["revision_hash"] = digest({k: v for k, v in record.items() if k != "revision_hash"})
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(record), record["id"])
        )
    with pytest.raises(ValueError, match="canonical record hash"):
        ResearchProject(wb.project.root)
