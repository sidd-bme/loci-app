import copy
import hashlib
import json
import stat
import zipfile
from pathlib import Path

import numpy as np
import pytest
import tifffile

import loci_engine.research_interchange as interchange_module
from loci_engine.research_interchange import (
    export_project,
    export_recipe,
    import_project,
    import_recipe,
    relink_interchanged_source,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


def _workbench(tmp_path: Path) -> tuple[Workbench, Path, dict]:
    project = ResearchProject.create(tmp_path / "source.loci-study", "Portable study")
    source_path = tmp_path / "source.tif"
    tifffile.imwrite(source_path, np.arange(64, dtype=np.uint16).reshape(8, 8))
    workbench = Workbench(project)
    source = workbench.import_native(str(source_path))
    return workbench, source_path, source


def _rewrite(source: Path, destination: Path, transform) -> None:
    with zipfile.ZipFile(source, "r") as incoming:
        entries = [(info, incoming.read(info)) for info in incoming.infolist()]
    entries = transform(entries)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as output:
        for old, payload in entries:
            info = zipfile.ZipInfo(old.filename, date_time=old.date_time)
            info.compress_type = old.compress_type
            info.create_system = old.create_system
            info.external_attr = old.external_attr
            info.flag_bits = old.flag_bits
            info.extra = old.extra
            info.comment = old.comment
            output.writestr(info, payload)


def test_recipe_roundtrip_explicitly_remaps_and_records_new_sources(tmp_path):
    workbench, _, source = _workbench(tmp_path)
    other_path = tmp_path / "other.tif"
    tifffile.imwrite(other_path, np.arange(64, dtype=np.uint16).reshape(8, 8) + 100)
    other = workbench.import_native(str(other_path))
    saved = workbench.execute(
        "recipe",
        {
            "id": "a" * 32,
            "source_id": source["id"],
            "data": {
                "name": "threshold template",
                "selection": {"x": 1, "y": 1, "width": 6, "height": 6},
                "recipe": {"segmentation": {"method": "components", "threshold": 12}},
            },
        },
    )
    package = tmp_path / "recipe.loci-recipe.json"
    receipt = export_recipe(workbench, saved["id"], source["id"], package)
    imported = import_recipe(
        workbench,
        package,
        {"primary": other["id"]},
        recipe_id="b" * 32,
        expected_package_sha256=receipt["package_sha256"],
    )
    evidence = imported["recipe"]["data"]["interchange"]
    assert evidence["original_bindings"]["primary"]["source_sha256"] == source["sha256"]
    assert evidence["imported_bindings"]["primary"]["source_sha256"] == other["sha256"]
    assert imported["recipe"]["data"]["selection"]["width"] == 6
    with pytest.raises(ValueError, match="original source identity"):
        import_recipe(
            workbench,
            package,
            {"primary": other["id"]},
            recipe_id="c" * 32,
            require_exact_sources=True,
        )


def test_recipe_import_rejects_missing_primary_and_a_file_changed_during_read(
    tmp_path, monkeypatch
):
    workbench, _, source = _workbench(tmp_path)
    workbench.execute(
        "recipe",
        {
            "id": "a" * 32,
            "source_id": source["id"],
            "data": {"name": "template", "recipe": {"segmentation": {"threshold": 12}}},
        },
    )
    package = tmp_path / "recipe.json"
    receipt = export_recipe(workbench, "a" * 32, source["id"], package)
    value = json.loads(package.read_text())
    value["original_bindings"] = {}
    missing_primary = tmp_path / "missing-primary.json"
    missing_primary.write_text(canonical_json(value))
    with pytest.raises(ValueError, match="primary source"):
        import_recipe(workbench, missing_primary, {})

    real_open = interchange_module.os.open
    package_opens = 0

    def replace_before_open(path, flags, *args, **kwargs):
        nonlocal package_opens
        if Path(path) == package:
            package_opens += 1
        if Path(path) == package and package_opens == 2:
            package.write_text("{}")
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(interchange_module.os, "open", replace_before_open)
    with pytest.raises(ValueError, match="changed"):
        import_recipe(
            workbench,
            package,
            {"primary": source["id"]},
            recipe_id="b" * 32,
            expected_package_sha256=receipt["package_sha256"],
        )


def test_project_roundtrip_preserves_scientific_records_but_requires_relink(tmp_path):
    workbench, source_path, source = _workbench(tmp_path)
    saved = workbench.execute(
        "run_recipe",
        {"source_id": source["id"], "recipe": {"segmentation": {"threshold": 20}}},
    )
    result = workbench.project.result(saved["result"]["id"])
    review = workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    document = workbench.project.put_document(
        "sample", source["id"], {"condition": "control"}, expected_revision=0
    )
    model = workbench.project.put_document(
        "model",
        "c" * 32,
        {
            "schema": "loci.managed-model/v1",
            "private_path": str(tmp_path / "private-model"),
            "package": {"package_sha256": "7" * 64},
            "reference_qualification": {"passed": True},
            "import_working_bytes": 1024**2,
        },
        expected_revision=0,
    )
    remote = workbench.project.put_document(
        "policy",
        "d" * 32,
        {
            "schema": "loci.remote-run-state/v1",
            "private_request_b64": "c2VjcmV0",
            "private_retrieval_directory": "/private/result",
            "state": "submitted",
            "remote_state": "RUNNING",
            "remote_job_id": "pbs-123",
            "cancel_requested": False,
        },
        expected_revision=0,
    )
    job = workbench.project.submit("run_recipe", {"source_id": source["id"]}, "intent")
    workbench.project.update_job(
        job["id"], expected_state="queued", state="running", pid=31415, progress=0.5
    )
    archive = tmp_path / "portable.loci-study.zip"
    receipt = export_project(workbench.project, archive)
    restored = import_project(
        archive,
        tmp_path / "restored.loci-study",
        expected_archive_sha256=receipt["archive_sha256"],
    )
    assert restored.meta == workbench.project.meta
    assert restored.list_sources()[0]["sha256"] == source["sha256"]
    assert restored.list_sources()[0]["locator_state"] == "relink-required"
    assert restored.result(result["id"]) == result
    assert restored.review_state(result["id"]) == review
    assert restored.documents("sample") == [document]
    restored_model = restored.documents("model")[0]
    assert restored_model["revision"] == model["revision"]
    assert restored_model["data"]["package"] == model["data"]["package"]
    assert restored_model["data"]["interchange_state"] == "model-package-not-included"
    assert "private_path" not in restored_model["data"]
    restored_remote = restored.documents("policy")[0]
    assert restored_remote["revision"] == remote["revision"]
    assert restored_remote["data"]["state"] == "interrupted"
    assert restored_remote["data"]["remote_job_id"] is None
    assert restored_remote["data"]["interchange"]["historical_remote_job_id"] == "pbs-123"
    assert not any(key.startswith("private_") for key in restored_remote["data"])
    restored_job = restored.job(job["id"])
    assert restored_job["state"] == "interrupted"
    assert restored_job["interchange"]["original_state"] == "running"
    assert "pid" not in restored_job
    for descriptor in result["arrays"].values():
        np.testing.assert_array_equal(
            restored.load_array(descriptor), workbench.project.load_array(descriptor)
        )
    relink_interchanged_source(restored, source["id"], source_path)
    assert restored.source(source["id"], verify=True)["sha256"] == source["sha256"]


@pytest.mark.parametrize("attack", ["traversal", "symlink", "compression", "extra"])
def test_project_import_rejects_unsafe_archive_members(tmp_path, attack):
    workbench, _, _ = _workbench(tmp_path)
    archive = tmp_path / "valid.zip"
    export_project(workbench.project, archive)
    malicious = tmp_path / f"{attack}.zip"

    def transform(entries):
        if attack == "traversal":
            info = zipfile.ZipInfo("../escape", date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            entries.insert(0, (info, b"escape"))
        elif attack == "symlink":
            info, payload = entries[0]
            linked = copy.copy(info)
            linked.external_attr = (stat.S_IFLNK | 0o777) << 16
            entries[0] = (linked, payload)
        elif attack == "compression":
            info, payload = entries[0]
            compressed = copy.copy(info)
            compressed.compress_type = zipfile.ZIP_DEFLATED
            entries[0] = (compressed, payload)
        else:
            info, payload = entries[0]
            extra = copy.copy(info)
            extra.extra = b"\x02\x00\x01\x00x"
            entries[0] = (extra, payload)
        return entries

    _rewrite(archive, malicious, transform)
    with pytest.raises(ValueError, match="unsafe|non-canonical"):
        import_project(malicious, tmp_path / f"{attack}.loci-study")
    assert not (tmp_path / f"{attack}.loci-study").exists()


def test_project_import_rejects_member_tampering(tmp_path):
    workbench, _, _ = _workbench(tmp_path)
    archive = tmp_path / "valid.zip"
    export_project(workbench.project, archive)
    tampered = tmp_path / "tampered.zip"

    def transform(entries):
        index = next(
            i for i, (info, _) in enumerate(entries) if info.filename.startswith("sources/")
        )
        info, payload = entries[index]
        entries[index] = (info, payload + b" ")
        return entries

    _rewrite(archive, tampered, transform)
    with pytest.raises(ValueError, match="size disagrees|manifest hash"):
        import_project(tampered, tmp_path / "tampered.loci-study")


def test_project_export_rechecks_source_before_atomic_publication(tmp_path, monkeypatch):
    workbench, _, _ = _workbench(tmp_path)
    original_source = workbench.project.source
    strict_reads = 0

    def source(source_id, *, verify=False):
        nonlocal strict_reads
        if verify:
            strict_reads += 1
            if strict_reads == 2:
                raise ValueError("source changed before publication")
        return original_source(source_id, verify=verify)

    monkeypatch.setattr(workbench.project, "source", source)
    destination = tmp_path / "should-not-publish.zip"
    with pytest.raises(ValueError, match="changed before publication"):
        export_project(workbench.project, destination)
    assert not destination.exists()


def test_project_import_rejects_stale_review_even_with_rewritten_manifest(tmp_path):
    workbench, _, source = _workbench(tmp_path)
    saved = workbench.execute(
        "run_recipe",
        {"source_id": source["id"], "recipe": {"segmentation": {"threshold": 20}}},
    )
    workbench.project.review(saved["result"]["id"], saved["result"]["revision_hash"], "reviewed")
    archive = tmp_path / "valid.zip"
    export_project(workbench.project, archive)
    stale = tmp_path / "stale.zip"

    def transform(entries):
        review_index = next(
            i for i, (info, _) in enumerate(entries) if info.filename.startswith("reviews/")
        )
        info, payload = entries[review_index]
        review = json.loads(payload)
        review["revision_hash"] = "0" * 64
        changed = canonical_json(review).encode()
        entries[review_index] = (info, changed)
        manifest_index = next(
            i for i, (entry_info, _) in enumerate(entries) if entry_info.filename == "manifest.json"
        )
        manifest_info, manifest_payload = entries[manifest_index]
        manifest = json.loads(manifest_payload)
        member = next(item for item in manifest["members"] if item["path"] == info.filename)
        member["sha256"] = hashlib.sha256(changed).hexdigest()
        member["size_bytes"] = len(changed)
        entries[manifest_index] = (manifest_info, canonical_json(manifest).encode())
        return entries

    _rewrite(archive, stale, transform)
    with pytest.raises(ValueError, match="review is stale"):
        import_project(stale, tmp_path / "stale.loci-study")


def test_relink_rejects_archive_metadata_that_disagrees_with_exact_source(tmp_path):
    workbench, source_path, source = _workbench(tmp_path)
    archive = tmp_path / "valid.zip"
    export_project(workbench.project, archive)
    forged = tmp_path / "forged-metadata.zip"

    def transform(entries):
        source_index = next(
            i for i, (info, _) in enumerate(entries) if info.filename.startswith("sources/")
        )
        info, payload = entries[source_index]
        record = json.loads(payload)
        record["metadata"]["axes"] = "forged"
        changed = canonical_json(record).encode()
        entries[source_index] = (info, changed)
        manifest_index = next(
            i for i, (entry_info, _) in enumerate(entries) if entry_info.filename == "manifest.json"
        )
        manifest_info, manifest_payload = entries[manifest_index]
        manifest = json.loads(manifest_payload)
        member = next(item for item in manifest["members"] if item["path"] == info.filename)
        member["sha256"] = hashlib.sha256(changed).hexdigest()
        member["size_bytes"] = len(changed)
        entries[manifest_index] = (manifest_info, canonical_json(manifest).encode())
        return entries

    _rewrite(archive, forged, transform)
    restored = import_project(forged, tmp_path / "forged.loci-study")
    with pytest.raises(ValueError, match="shape, calibration, or metadata"):
        relink_interchanged_source(restored, source["id"], source_path)
