"""Scientific export identity, numerical preservation and publication boundaries."""

from __future__ import annotations

import csv
import errno
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest
import test_research_jobs as jobs
import tifffile

import loci_engine.research_data_export as export
from loci_engine.research_groups import dispatch_group
from loci_engine.research_population import intensity_metric_id
from loci_engine.research_project import canonical_json


@pytest.fixture
def task(tmp_path):
    workbench, request = jobs.task.__wrapped__(tmp_path)
    summary = workbench.run_recipe(request)["result"]
    result = workbench.project.result(summary["id"])
    binding = {key: result[key] for key in ("source_id", "source_sha256", "revision_hash")}
    binding.update(result_id=result["id"], group_ids=[], subset="all")
    yield workbench, result, {"purpose": "provisional", "bindings": [binding]}
    workbench.close()


def _review(workbench, result):
    return workbench.project.review(result["id"], result["revision_hash"], "reviewed")


def _sample(project, result, replicate="R1"):
    documents = project.documents("sample")
    old = next((doc for doc in documents if doc["id"] == result["source_id"]), None)
    return project.put_document(
        "sample",
        result["source_id"],
        {
            "study": "Study",
            "sample": "Sample",
            "condition": "Control",
            "biological_replicate": replicate,
            "plate": None,
            "well": None,
        },
        expected_revision=old["revision"] if old else 0,
    )


def _plan(task):
    workbench, _, request = task
    return export.plan_export(workbench.project, request)


def _rows(target, filename):
    with (target / filename).open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def _group(workbench, result, name="one"):
    metric = intensity_metric_id(
        next(iter(result["provenance"]["measurements"][0]["intensity"])), "mean"
    )
    gate = {
        "kind": "rectangle",
        "x_metric": "measure",
        "y_metric": metric,
        "x_transform": "linear",
        "y_transform": "linear",
        "bounds": [0, 10000, 0, 10000],
    }
    bound = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    receipt = dispatch_group(workbench, "population_gate_evaluate", {**bound, "gate": gate})
    response = dispatch_group(
        workbench,
        "population_group_save",
        {
            **bound,
            "gate": gate,
            "name": name,
            "membership_sha256": receipt["membership_sha256"],
        },
    )
    return response


def test_plan_readonly_compact_and_reviewed_gate(task):
    workbench, result, request = task
    before = (workbench.project.documents("sample"), workbench.project.review_history(result["id"]))
    planned = _plan(task)
    plan = planned["plan"]
    assert planned["plan_json"] == canonical_json(plan)
    assert plan["total_count"] == plan["selected_count"] == 1
    assert plan["result_count"] == plan["source_count"] == 1
    assert plan["unassigned_source_count"] == 1
    assert plan["results"][0]["review_status"] == "pending"
    assert len(plan["results"][0]["preview"]) <= 5
    assert plan["mixed_units"] is False
    assert str(workbench.project.root) not in planned["plan_json"]
    assert before == (
        workbench.project.documents("sample"),
        workbench.project.review_history(result["id"]),
    )
    request["purpose"] = "reviewed"
    with pytest.raises(ValueError, match="Review"):
        _plan(task)
    _review(workbench, result)
    assert _plan(task)["plan"]["results"][0]["review_status"] == "reviewed"


@pytest.mark.parametrize("disposition", ["pending", "excluded", "reviewed"])
def test_provisional_retains_review_without_approval(task, tmp_path, disposition):
    workbench, result, _ = task
    workbench.project.review(result["id"], result["revision_hash"], disposition)
    before = workbench.project.review_history(result["id"])
    target = tmp_path / "data"
    receipt = export.export_data_package(workbench.project, _plan(task)["plan_json"], target)
    assert receipt["purpose"] == "provisional"
    assert _rows(target, "results.csv")[0]["review_disposition"] == disposition
    assert workbench.project.review_history(result["id"]) == before


def test_exact_package_hashes_counts_keys_and_privacy(task, tmp_path):
    workbench, result, _ = task
    _sample(workbench.project, result)
    _review(workbench, result)
    target = tmp_path / "Scientific data"
    planned = _plan(task)
    receipt = export.export_data_package(workbench.project, planned["plan_json"], target)
    assert set(receipt) == {
        "schema",
        "basename",
        "purpose",
        "manifest_sha256",
        "result_count",
        "source_count",
        "selected_count",
    }
    manifest = json.loads((target / "manifest.json").read_text())
    assert (
        hashlib.sha256((target / "manifest.json").read_bytes()).hexdigest()
        == receipt["manifest_sha256"]
    )
    expected_names = {"manifest.json"}
    for record in manifest["files"]:
        artifact = target / record["name"]
        assert artifact.stat().st_size == record["size_bytes"]
        assert hashlib.sha256(artifact.read_bytes()).hexdigest() == record["sha256"]
        expected_names.add(record["name"])
    assert {path.name for path in target.iterdir()} == expected_names
    schema = json.loads((target / "schema.json").read_text())
    assert schema["independent_n_basis"] == (
        "No independent n inferred; declared groups use study, condition and "
        "biological_replicate; objects/images may be correlated"
    )
    assert schema["replicate_grouping"] == ["study", "condition", "biological_replicate"]
    for name, table in schema["tables"].items():
        if table["format"] == "csv":
            assert len(_rows(target, name)) == table["row_count"]
    exact = json.loads((target / "object-records.jsonl").read_text())
    assert exact["object"] == result["provenance"]["measurements"][0]
    assert _rows(target, "samples.csv")[0]["biological_replicate"] == "R1"
    assert planned["plan"]["declared_replicate_count"] == 1
    for artifact in target.iterdir():
        assert str(tmp_path) not in artifact.read_text()
    assert not list(target.glob("*.npy")) and not list(target.glob("*.tif"))
    with pytest.raises(ValueError, match="absent"):
        export.export_data_package(workbench.project, planned["plan_json"], target)


@pytest.mark.parametrize("change", ["review", "sample", "group", "source", "array"])
def test_stale_state_rejects_package(task, tmp_path, change):
    workbench, result, _ = task
    _sample(workbench.project, result)
    plan_json = _plan(task)["plan_json"]
    if change == "review":
        _review(workbench, result)
    elif change == "sample":
        _sample(workbench.project, result, "R2")
    elif change == "group":
        _group(workbench, result)
    elif change == "source":
        source = Path(workbench.project.source(result["source_id"])["private_path"])
        source.write_bytes(source.read_bytes() + b"changed")
    else:
        array = workbench.project.arrays / (result["arrays"]["labels"]["sha256"] + ".npy")
        array.write_bytes(array.read_bytes() + b"changed")
    with pytest.raises((ValueError, OSError)):
        export.export_data_package(workbench.project, plan_json, tmp_path / "data")
    assert not (tmp_path / "data").exists()
    assert not list(tmp_path.glob(".loci-data-*"))


def test_complete_overlapping_groups_subset_union_and_unrelated_source(task, tmp_path):
    workbench, result, request = task
    first = _group(workbench, result, "first")
    second = _group(workbench, result, "second")
    unrelated = tmp_path / "unrelated.tif"
    tifffile.imwrite(unrelated, np.zeros((4, 4), np.uint8))
    workbench.import_native(str(unrelated))
    unrelated.unlink()
    request["bindings"][0].update(subset="groups", group_ids=[first["id"], second["id"]])
    planned = _plan(task)
    assert planned["plan"]["selected_count"] == 1
    assert planned["plan"]["group_count"] == 2
    assert planned["plan"]["membership_count"] == 2
    target = tmp_path / "data"
    export.export_data_package(workbench.project, planned["plan_json"], target)
    assert len(_rows(target, "objects.csv")) == 1
    assert len(_rows(target, "memberships.csv")) == 2


def test_zero_objects_has_headers_and_no_rows(tmp_path):
    workbench, request = jobs.task.__wrapped__(tmp_path)
    request["recipe"]["segmentation"]["threshold"] = 200
    summary = workbench.run_recipe(request)["result"]
    result = workbench.project.result(summary["id"])
    binding = {key: result[key] for key in ("source_id", "source_sha256", "revision_hash")}
    binding.update(result_id=result["id"], group_ids=[], subset="all")
    planned = export.plan_export(
        workbench.project, {"purpose": "provisional", "bindings": [binding]}
    )
    assert planned["plan"]["selected_count"] == 0
    target = tmp_path / "empty"
    export.export_data_package(workbench.project, planned["plan_json"], target)
    assert _rows(target, "objects.csv") == []
    assert (target / "object-records.jsonl").read_bytes() == b""
    workbench.close()


def test_opaque_plan_rejects_reserialization_and_mutation(task, tmp_path):
    planned = _plan(task)
    workbench, _, _ = task
    reformatted = json.dumps(planned["plan"], indent=2)
    with pytest.raises(ValueError, match="canonical"):
        export.export_data_package(workbench.project, reformatted, tmp_path / "data")
    plan = planned["plan"]
    plan["selected_count"] += 1
    with pytest.raises(ValueError, match="checksum"):
        export.export_data_package(workbench.project, canonical_json(plan), tmp_path / "data")


@pytest.mark.parametrize("failure", ["cancel", "io", "race", "linked-stage", "source"])
def test_mid_export_failures_never_publish_partial(task, tmp_path, monkeypatch, failure):
    from loci_engine import research_data_tables

    workbench, result, _ = task
    planned = _plan(task)
    target = tmp_path / "data"
    original = research_data_tables.write_tables
    cancelled = False

    def write(*args, **kwargs):
        nonlocal cancelled
        tables = original(*args, **kwargs)
        if failure == "cancel":
            cancelled = True
        elif failure == "io":
            raise OSError(errno.ENOSPC, "disk full")
        elif failure == "race":
            target.mkdir()
            (target / "keep").write_text("existing")
        elif failure == "linked-stage":
            stage = next(tmp_path.glob(".loci-data-*"))
            (stage / "objects.csv").unlink()
            (stage / "objects.csv").symlink_to(tmp_path / "outside")
        else:
            Path(workbench.project.source(result["source_id"])["private_path"]).write_bytes(
                b"changed"
            )
        return tables

    monkeypatch.setattr(research_data_tables, "write_tables", write)

    def check():
        if cancelled:
            raise ValueError("cancelled")

    with pytest.raises((ValueError, OSError)):
        export.export_data_package(workbench.project, planned["plan_json"], target, check=check)
    if failure == "race":
        assert (target / "keep").read_text() == "existing"
        assert list(target.iterdir()) == [target / "keep"]
    else:
        assert not target.exists()
    assert not list(tmp_path.glob(".loci-data-*"))


def test_parent_symlink_and_inside_study_rejected(task, tmp_path):
    workbench, _, _ = task
    plan_json = _plan(task)["plan_json"]
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path, target_is_directory=True)
    for target in (linked / "data", workbench.project.root / "data"):
        with pytest.raises(ValueError):
            export.export_data_package(workbench.project, plan_json, target)


def test_post_rename_fsync_preserves_published_package(task, tmp_path, monkeypatch):
    workbench, _, _ = task
    plan_json = _plan(task)["plan_json"]
    target = tmp_path / "data"
    original_rename = export._rename_noreplace
    original_fsync = os.fsync
    renamed = False

    def rename(*args, **kwargs):
        nonlocal renamed
        original_rename(*args, **kwargs)
        renamed = True

    def fsync(descriptor):
        if renamed:
            raise OSError(errno.EIO, "sync failed")
        return original_fsync(descriptor)

    monkeypatch.setattr(export, "_rename_noreplace", rename)
    monkeypatch.setattr(os, "fsync", fsync)
    with pytest.raises(RuntimeError, match="was published.*durability"):
        export.export_data_package(workbench.project, plan_json, target)
    assert (target / "manifest.json").is_file()
    assert (target / "objects.csv").is_file()
    assert not list(tmp_path.glob(".loci-data-*"))


def test_unsupported_atomic_primitive_fails_before_staging(task, tmp_path, monkeypatch):
    workbench, _, _ = task
    plan_json = _plan(task)["plan_json"]
    monkeypatch.setattr(export, "_NATIVE_RENAME", None)
    with pytest.raises(ValueError, match="atomic no-replace"):
        export.export_data_package(workbench.project, plan_json, tmp_path / "data")
    assert not list(tmp_path.glob(".loci-data-*"))


def test_private_grant_public_job_and_task_receipt(task, tmp_path):
    from loci_engine.research_jobs import run_job, submit_job

    workbench, result, _ = task
    planned = _plan(task)
    grant = export.create_export_grant(
        workbench.project, planned["plan_json"], str(tmp_path / "data")
    )
    request = {"grant_id": grant["grant_id"], "plan_sha256": grant["plan_sha256"]}
    assert export.export_task_source(workbench.project, request) == result["source_id"]
    assert str(tmp_path) not in canonical_json(grant)
    job = submit_job(workbench, request, "data-package", operation="scientific_data_export")
    assert str(tmp_path) not in canonical_json(job)
    receipt = run_job(workbench, job["id"])
    assert receipt["job"]["state"] == "succeeded"
    assert receipt["job"]["progress"] == 1.0
    assert receipt["selected_count"] == 1
    assert str(tmp_path) not in canonical_json(receipt)
    with pytest.raises(ValueError, match="grant"):
        export.export_task_source(workbench.project, {**request, "plan_sha256": "0" * 64})
    with pytest.raises(ValueError, match="exactly"):
        export.export_task_source(workbench.project, {**request, "destination": "/tmp/escape"})


def test_revoked_grant_and_cancelled_job_fail_before_publication(task, tmp_path):
    workbench, _, _ = task
    grant = export.create_export_grant(
        workbench.project, _plan(task)["plan_json"], str(tmp_path / "data")
    )
    request = {"grant_id": grant["grant_id"], "plan_sha256": grant["plan_sha256"]}
    changed = False

    def revoke():
        nonlocal changed
        if not changed:
            document = workbench.project.documents("data_export_grant")[0]
            workbench.project.put_document(
                "data_export_grant",
                document["id"],
                document["data"],
                expected_revision=document["revision"],
            )
            changed = True

    with pytest.raises(PermissionError, match="revoked"):
        export.execute_export_task(workbench, request, publication_guard=revoke)
    assert not (tmp_path / "data").exists()


def test_mixed_units_are_not_pooled_or_normalized(task, tmp_path):
    import copy

    workbench, result, request = task
    provenance = copy.deepcopy(result["provenance"])
    provenance["geometry"]["unit"] = "um"
    for row in provenance["measurements"]:
        row["measure_unit"] = "um^2"
        row["distance_unit"] = "um"
    arrays = {key: workbench.project.load_array(value) for key, value in result["arrays"].items()}
    other = workbench.project.save_result(
        source_id=result["source_id"], kind=result["kind"], arrays=arrays, provenance=provenance
    )
    binding = {key: other[key] for key in ("source_id", "source_sha256", "revision_hash")}
    binding.update(result_id=other["id"], group_ids=[], subset="all")
    request["bindings"].append(binding)
    planned = _plan(task)
    assert planned["plan"]["mixed_units"] is True
    target = tmp_path / "data"
    export.export_data_package(workbench.project, planned["plan_json"], target)
    assert {row["measure_unit"] for row in _rows(target, "objects.csv")} == {"pixel^2", "um^2"}
    assert not (target / "conditions.csv").exists()


def test_freeform_review_and_private_profile_are_hash_bound_but_omitted(task, tmp_path):
    import copy

    workbench, result, request = task
    provenance = copy.deepcopy(result["provenance"])
    provenance["profile"] = {"private_path": str(tmp_path), "secret": "PRIVATE_PROFILE_SENTINEL"}
    provenance["runtime"]["credentials"] = "CREDENTIAL_SENTINEL"
    provenance["runtime"]["python_version"] = "3.12.13"
    provenance["unrecognized_secret"] = "OTHER_SECRET_SENTINEL"
    arrays = {key: workbench.project.load_array(value) for key, value in result["arrays"].items()}
    other = workbench.project.save_result(
        source_id=result["source_id"], kind=result["kind"], arrays=arrays, provenance=provenance
    )
    request["bindings"][0].update(result_id=other["id"], revision_hash=other["revision_hash"])
    workbench.project.review(
        other["id"],
        other["revision_hash"],
        "reviewed",
        reason="REVIEW_SECRET_SENTINEL",
        coverage="NOTES_SENTINEL",
    )
    target = tmp_path / "data"
    export.export_data_package(workbench.project, _plan(task)["plan_json"], target)
    for path in target.iterdir():
        content = path.read_text()
        for value in (
            str(tmp_path),
            "PRIVATE_PROFILE_SENTINEL",
            "CREDENTIAL_SENTINEL",
            "OTHER_SECRET_SENTINEL",
            "REVIEW_SECRET_SENTINEL",
            "NOTES_SENTINEL",
        ):
            assert value not in content
    scientific = json.loads((target / "provenance.json").read_text())["results"][0][
        "scientific_provenance"
    ]
    assert scientific["runtime"]["python_version"] == "3.12.13"
    assert scientific["recipe"]["segmentation"]["threshold"] == 50


def test_parent_replacement_during_export_does_not_publish_to_either_parent(
    task, tmp_path, monkeypatch
):
    from loci_engine import research_data_tables

    workbench, _, _ = task
    plan_json = _plan(task)["plan_json"]
    parent = tmp_path / "parent"
    parent.mkdir()
    moved = tmp_path / "moved"
    original = research_data_tables.write_tables

    def write(*args, **kwargs):
        tables = original(*args, **kwargs)
        parent.rename(moved)
        parent.mkdir()
        return tables

    monkeypatch.setattr(research_data_tables, "write_tables", write)
    with pytest.raises(ValueError, match="directory changed"):
        export.export_data_package(workbench.project, plan_json, parent / "data")
    assert not (parent / "data").exists()
    assert not (moved / "data").exists()
    assert list(parent.iterdir()) == list(moved.iterdir()) == []


def test_unsupported_filesystem_error_is_actionable_and_cleans_stage(task, tmp_path, monkeypatch):
    workbench, _, _ = task
    plan_json = _plan(task)["plan_json"]

    def unsupported(*args, **kwargs):
        raise OSError(errno.ENOTSUP, "not supported")

    monkeypatch.setattr(export, "_rename_noreplace", unsupported)
    with pytest.raises(ValueError, match="APFS"):
        export.export_data_package(workbench.project, plan_json, tmp_path / "data")
    assert not (tmp_path / "data").exists()
    assert not list(tmp_path.glob(".loci-data-*"))


def test_real_tiled_package_uses_stored_rows_and_hashes_without_decoding_arrays(
    tmp_path, monkeypatch
):
    from test_research_large import _fixture, _published

    workbench, _, _, request, _, _ = _fixture(tmp_path)
    _, _, result = _published(workbench, request)

    def forbidden(*args, **kwargs):
        pytest.fail("data package must not decode a stored image array")

    monkeypatch.setattr(workbench.project, "load_array", forbidden)
    monkeypatch.setattr(workbench.project, "verify_array", forbidden)
    binding = {key: result[key] for key in ("source_id", "source_sha256", "revision_hash")}
    binding.update(result_id=result["id"], group_ids=[], subset="all")
    planned = export.plan_export(
        workbench.project, {"purpose": "provisional", "bindings": [binding]}
    )
    assert planned["plan"]["selected_count"] == 3
    target = tmp_path / "data"
    export.export_data_package(workbench.project, planned["plan_json"], target)
    assert [row["label"] for row in _rows(target, "objects.csv")] == ["1", "2", "3"]
    provenance = json.loads((target / "provenance.json").read_text())["results"][0]
    assert provenance["arrays"]["labels"]["descriptor_sha256"] == export._hash(
        result["arrays"]["labels"]
    )
    assert "tiles" not in provenance["arrays"]["labels"]
    assert provenance["scientific_provenance"]["selection"] == result["provenance"]["selection"]
    workbench.close()


def test_sample_mutation_during_staging_invalidates_opaque_plan(task, tmp_path, monkeypatch):
    from loci_engine import research_data_tables

    workbench, result, _ = task
    _sample(workbench.project, result)
    plan_json = _plan(task)["plan_json"]
    original = research_data_tables.write_tables

    def write(*args, **kwargs):
        tables = original(*args, **kwargs)
        _sample(workbench.project, result, "R2")
        return tables

    monkeypatch.setattr(research_data_tables, "write_tables", write)
    with pytest.raises(ValueError, match="stale"):
        export.export_data_package(workbench.project, plan_json, tmp_path / "data")
    assert not (tmp_path / "data").exists()
    assert not list(tmp_path.glob(".loci-data-*"))


@pytest.mark.parametrize("name", ["CON", "trailing.", ".hidden", "bad:name", "x" * 121])
def test_data_package_container_name_is_portable(task, tmp_path, name):
    workbench, _, _ = task
    with pytest.raises(ValueError, match="portable data package name"):
        export.create_export_grant(
            workbench.project, _plan(task)["plan_json"], str(tmp_path / name)
        )


def test_plan_keeps_v1_measurement_population_out_of_retained_snapshot(task):
    workbench, _, request = task
    _, items = export._snapshot(workbench.project, request)
    assert "measurements" not in items[0]["result"]["provenance"]
    assert workbench.project.result(items[0]["result"]["id"])["provenance"]["measurements"]


def test_plan_binds_export_implementation_identity(task, tmp_path, monkeypatch):
    workbench, _, _ = task
    response = _plan(task)
    identity = response["plan"]["export_software"]
    assert identity["kind"] == "source-modules-sha256"
    assert len(identity["sha256"]) == 64
    assert identity["python_version"]
    monkeypatch.setattr(export, "_implementation", lambda: (identity["kind"], "0" * 64))
    with pytest.raises(ValueError, match="stale"):
        export.export_data_package(workbench.project, response["plan_json"], tmp_path / "data")


def test_export_task_checks_only_its_exact_grant_despite_unrelated_malformed_plan(
    task, tmp_path, monkeypatch
):
    workbench, result, _ = task
    project = workbench.project
    grant = export.create_export_grant(project, _plan(task)["plan_json"], str(tmp_path / "data"))
    request = {"grant_id": grant["grant_id"], "plan_sha256": grant["plan_sha256"]}
    with project.connection() as connection:
        connection.execute(
            "INSERT INTO documents VALUES(?,?,?,?)",
            (
                "data_export_grant",
                "f" * 32,
                1,
                '{"private_path":"/private/another-export", "plan_json": invalid',
            ),
        )
    lookups = []
    real_documents = project.documents

    def documents(kind, *, document_id=None):
        if kind == "data_export_grant":
            lookups.append(document_id)
            assert document_id == grant["grant_id"]
        return real_documents(kind, document_id=document_id)

    monkeypatch.setattr(project, "documents", documents)
    assert export.export_task_source(project, request) == result["source_id"]
    receipt = export.execute_export_task(workbench, request)
    assert receipt["selected_count"] == 1
    assert (tmp_path / "data" / "manifest.json").is_file()
    assert len(lookups) > 3  # Initial validation plus repeated execution/publication checks.


@pytest.mark.parametrize(
    "operation,kind",
    [
        ("scientific_data_export", "data_export_grant"),
        ("large_result_export", "large_export_grant"),
    ],
)
def test_export_interruption_reads_only_the_requested_grant(task, tmp_path, operation, kind):
    from loci_engine.research_jobs import _export_interruption_detail

    workbench, result, _ = task
    project = workbench.project
    grant_id = "a" * 32
    data = {
        "destination": str(tmp_path / "absent"),
        "plan_sha256": "b" * 64,
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
    }
    project.put_document(kind, grant_id, data, expected_revision=0)
    with project.connection() as connection:
        connection.execute(
            "INSERT INTO documents VALUES(?,?,?,?)",
            (kind, "f" * 32, 1, '{"private_path":"/private/unrelated", invalid'),
        )
    job = {
        "operation": operation,
        "request": {
            "task_request": {
                "grant_id": grant_id,
                "plan_sha256": data["plan_sha256"],
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
            }
        },
    }
    assert _export_interruption_detail(project, job) == (
        "Export destination is absent; no bundle is published there."
    )
