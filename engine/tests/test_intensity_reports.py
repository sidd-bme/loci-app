"""Report storage/publication integration and independent Python/R package readers."""

from __future__ import annotations

import copy
import csv
import hashlib
import io
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_experiment_intensity import actual_compartment_scene, request, sample
from test_experiment_intensity import study as study  # noqa: F401

import loci_engine.experiment_intensity as intensity
import loci_engine.research_intensity_export as export
from loci_engine.intensity_export_readers import PYTHON_READER, R_READER
from loci_engine.research_intensity_reports import execute, load
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_project import ResearchProject, canonical_json


@pytest.fixture
def saved(study):
    project, add, created = study
    results = [
        add([10] * 100),
        add([30]),
        add([40], replicate="R2"),
        add([-2, 0], condition="B"),
        add([900], condition="B", replicate=None),
        add([9999], condition="A", replicate="R9", disposition="excluded"),
    ]
    sample(project, results[3], condition="B", sample='=SUM(1,2)\nµ, "literal"')
    report = intensity.preview(project, request(results))
    saved = execute(project, "intensity_save", {"report": report})
    return project, results, created, saved


def test_canonical_preview_survives_javascript_numeric_roundtrip(study):
    project, add, _ = study

    def stored_negative_zero(provenance):
        # The stored endpoint is authoritative, including its zero sign. The
        # measurement reducer may itself sum -0.0 to +0.0 before persistence.
        values = provenance["measurements"][1]["intensity"]
        next(iter(values.values()))["mean"] = -0.0

    result = add([10.0, -0.0, -1.2345678901234567], mutator=stored_negative_zero)
    response = execute(project, "intensity_preview", request([result]))
    assert set(response) == {"report_json"}
    text = response["report_json"]
    exact = json.loads(text)
    assert text == canonical_json(exact)
    assert '"value":10.0' in text and '"value":-0.0' in text
    # JavaScript JSON.stringify normalizes integral floats and negative zero.
    changed = json.loads(
        text, parse_float=lambda x: int(float(x)) if float(x).is_integer() else float(x)
    )
    with pytest.raises(ValueError, match="content hash mismatch"):
        execute(project, "intensity_save", {"report": changed})
    # The opaque canonical string crosses the display boundary without encoding
    # its parsed numeric tree, preserving the original saved snapshot verbatim.
    transported = json.loads(json.dumps(response))
    saved = execute(project, "intensity_save", transported)
    assert canonical_json(saved["report"]) == text
    assert canonical_json(load(project, saved["report_id"])) == text


@pytest.mark.parametrize("bad", [None, {}, "{", "null", '{"a":1,"a":2}', '{"a":NaN}'])
def test_save_rejects_invalid_canonical_snapshot(study, bad):
    project, _, _ = study
    with pytest.raises(ValueError):
        execute(project, "intensity_save", {"report_json": bad})


def test_save_bounds_snapshot_text_and_rejects_ambiguous_envelope(study, monkeypatch):
    project, add, _ = study
    text = execute(project, "intensity_preview", request([add([10.0])]))["report_json"]
    with pytest.raises(ValueError):
        execute(project, "intensity_save", {"report_json": text, "report": json.loads(text)})
    monkeypatch.setattr(intensity, "MAX_REPORT_BYTES", len(text.encode()) - 1)
    with pytest.raises(ValueError, match="byte limit"):
        execute(project, "intensity_save", {"report_json": text})


def test_warm_rpc_cancel_avoids_reopen_and_report_reads_still_validate(saved, monkeypatch):
    import loci_engine.research_intensity_reports as reports
    import loci_engine.research_rpc as rpc

    project, _, _, stored = saved
    monkeypatch.setattr(rpc, "_ACTIVE", None)
    active = rpc._open(str(project.root))
    job = project.submit("intensity_export", {}, "authored cancellation probe")

    def invalid_report(*args, **kwargs):
        raise ValueError("Corrupt saved report probe")

    monkeypatch.setattr(reports, "load", invalid_report)
    try:
        outcome = rpc.dispatch_research(
            "research_cancel", {"project": str(project.root), "job_id": job["id"]}
        )
        assert outcome["state"] == "cancelled" and outcome["cancel_requested"]
        assert rpc._ACTIVE is active
        with pytest.raises(ValueError, match="Corrupt saved report"):
            rpc.dispatch_research(
                "research_execute",
                {
                    "project": str(project.root),
                    "operation": "intensity_get",
                    "request": {"report_id": stored["report_id"]},
                },
            )
        monkeypatch.setattr(rpc, "_ACTIVE", None)
        with pytest.raises(ValueError, match="Corrupt saved report"):
            rpc._open(str(project.root))
    finally:
        active.close()


@pytest.mark.parametrize("change", ["identity", "directory", "database-link"])
def test_warm_rpc_retains_project_identity_and_layout_guards(tmp_path, monkeypatch, change):
    import loci_engine.research_rpc as rpc

    project = ResearchProject.create(tmp_path / "warm-study", "Authored warm RPC")
    monkeypatch.setattr(rpc, "_ACTIVE", None)
    active = rpc._open(str(project.root))
    try:
        if change == "identity":
            with project.connection() as connection:
                data = {**project.meta, "project_id": "f" * 32}
                connection.execute(
                    "UPDATE metadata SET value=? WHERE key='project'", (canonical_json(data),)
                )
        elif change == "directory":
            project.root.rename(tmp_path / "original")
            project.root.mkdir()
        else:
            target = project.database.with_suffix(".original")
            project.database.rename(target)
            project.database.symlink_to(target)
        with pytest.raises(ValueError, match="identity|plain file|missing"):
            rpc._open(str(project.root))
    finally:
        active.close()


@pytest.fixture(scope="module", params=["python", "r"])
def reader(request):
    if request.param == "python":
        return "Python", [sys.executable, "-B"], "read_report.py"
    rscript = shutil.which("Rscript")
    if not rscript:
        pytest.skip("Rscript unavailable; independent Python reader cases remain active")
    available = subprocess.run(
        [rscript, "-e", "quit(status=if(requireNamespace('jsonlite',quietly=TRUE)) 0 else 1)"],
        text=True,
        capture_output=True,
        timeout=30,
    )
    if available.returncode != 0:
        pytest.skip("R jsonlite unavailable; no dependency installation attempted")
    return "R", [rscript], "read_report.R"


def run_readers(target, reader, *, expected_ok=True):
    name, prefix, filename = reader
    result = subprocess.run(
        [*prefix, str(target / filename), str(target)], text=True, capture_output=True, timeout=60
    )
    assert (result.returncode == 0) == expected_ok, f"{name}: {result.stdout}\n{result.stderr}"
    return [json.loads(result.stdout) if expected_ok else result.stderr]


def package(project, report_id, target):
    plan = export.plan(project, report_id)
    receipt = export.publish(project, report_id, plan, target)
    return receipt


def rehash_manifest(target):
    manifest = json.loads((target / "manifest.json").read_text())
    for row in manifest["files"]:
        data = (target / row["name"]).read_bytes()
        row.update(sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))
    (target / "manifest.json").write_text(canonical_json(manifest) + "\n")


def test_saved_snapshot_current_status_and_explicit_recompute(saved):
    project, results, _, saved_report = saved
    report_id = saved_report["report_id"]
    before = canonical_json(saved_report["report"])
    sample(project, results[0], condition="Changed", replicate="R-new")
    reopened = execute(project, "intensity_get", {"report_id": report_id})
    assert canonical_json(reopened["report"]) == before
    assert not reopened["status"]["current"]
    assert reopened["status"]["changes"][0]["result_id"] == results[0]["id"]
    recomputed = intensity.preview(project, request(results))
    assert recomputed["report_hash"] != saved_report["report"]["report_hash"]
    new = execute(project, "intensity_save", {"report": recomputed})
    assert new["report_id"] != report_id
    assert canonical_json(load(project, report_id)) == before
    with pytest.raises(ValueError, match="immutable"):
        project.put_document(
            "intensity_report", report_id, saved_report["report"], expected_revision=1
        )


def test_native_reopen_and_portable_preserve_exact_report(saved, tmp_path):
    project, results, created, saved_report = saved
    report_id = saved_report["report_id"]
    before = canonical_json(saved_report["report"])
    reopened = ResearchProject(project.root)
    assert canonical_json(load(reopened, report_id)) == before
    assert [reopened.result(result["id"])["revision_hash"] for result in results] == [
        r["revision_hash"] for r in results
    ]
    archive = tmp_path / "comparison.loci-study.zip"
    receipt = export_project(reopened, archive)
    restored = import_project(
        archive, tmp_path / "restored-study", expected_archive_sha256=receipt["archive_sha256"]
    )
    assert canonical_json(load(restored, report_id)) == before
    assert all(
        canonical_json(restored.result(result["id"])) == canonical_json(result)
        for result in results
    )
    assert all(source["locator_state"] == "relink-required" for source in restored.list_sources())
    for result, path in created:
        restored.relink(result["source_id"], path)
    assert execute(restored, "intensity_get", {"report_id": report_id})["status"]["current"]
    assert canonical_json(load(ResearchProject(restored.root), report_id)) == before


@pytest.mark.parametrize("coherent_forgery", [False, True])
def test_corrupt_native_report_rejected_against_retained_measurements(study, coherent_forgery):
    project, add, _ = study
    result = add([10])
    report = intensity.preview(project, request([result]))
    stored = execute(project, "intensity_save", {"report": report})
    forged = copy.deepcopy(report)
    forged["observations"][0]["value"] = 20.0
    if coherent_forgery:
        for name in ("images", "replicates", "conditions"):
            forged[name][0]["mean"] = 20.0
        forged["report_hash"] = hashlib.sha256(
            canonical_json(
                {key: value for key, value in forged.items() if key != "report_hash"}
            ).encode()
        ).hexdigest()
    old = project.documents("intensity_report")[0]
    identity = forged["report_hash"][:32]
    envelope = {**old, "id": identity, "data": forged}
    with project.connection() as connection:
        connection.execute(
            "DELETE FROM documents WHERE kind='intensity_report' AND id=?", (stored["report_id"],)
        )
        connection.execute(
            "INSERT INTO documents VALUES(?,?,?,?)",
            ("intensity_report", identity, 1, canonical_json(envelope)),
        )
    with pytest.raises(ValueError):
        load(project, identity)
    with pytest.raises(ValueError):
        ResearchProject(project.root)
    with pytest.raises(ValueError):
        export_project(project, project.root.parent / "corrupt.zip")


def test_object_package_exact_readers_and_independent_oracle(saved, tmp_path, reader):
    project, _, created, saved_report = saved
    before = {str(path): path.read_bytes() for _, path in created}
    target = tmp_path / "intensity-package"
    receipt = package(project, saved_report["report_id"], target)
    assert receipt["report_hash"] == saved_report["report"]["report_hash"]
    assert (target / "read_report.py").read_text() == PYTHON_READER
    assert (target / "read_report.R").read_text() == R_READER
    for result in run_readers(target, reader):
        assert result["verified"]
        conditions = {row["condition"]: row for row in result["conditions"]}
        condition = conditions["A"]
        assert condition["mean"] == 30
        assert condition["sd"] == pytest.approx(math.sqrt(200))
        assert (
            condition["object_count"],
            condition["image_count"],
            condition["declared_replicate_count"],
        ) == (102, 3, 2)
        assert conditions["B"]["mean"] == -1
        assert conditions["B"]["sd"] is None
        assert conditions["B"]["unassigned_image_count"] == 1
    assert all(path.read_bytes() == before[str(path)] for _, path in created)
    assert not list(tmp_path.glob(".loci-intensity-*"))


@pytest.mark.parametrize("compartment", ["cell", "nuclear", "cytoplasm"])
def test_actual_compartment_packages_pass_both_independent_readers(tmp_path, compartment, reader):
    workbench, result, parents, _ = actual_compartment_scene(tmp_path)
    try:
        project = workbench.project
        path = Path(project.source(result["source_id"])["private_path"])
        before = path.read_bytes()
        report = intensity.preview(project, request([result], compartment))
        assert {
            role: value["result_id"]
            for role, value in report["bindings"][0]["label_inputs"].items()
        } == {role: parent["id"] for role, parent in parents.items()}
        saved_report = execute(project, "intensity_save", {"report": report})
        target = tmp_path / f"{compartment}-package"
        package(project, saved_report["report_id"], target)
        for verified in run_readers(target, reader):
            assert verified["compartment"] == compartment
            assert verified["object_count"] == len(report["observations"])
        if compartment == "nuclear":
            assert any(
                row["status"] == "null" and row["value"] is None for row in report["observations"]
            )
        assert path.read_bytes() == before
    finally:
        workbench.close()


@pytest.mark.parametrize(
    "attack",
    [
        "checksum",
        "csv-rehashed",
        "csv-shape-rehashed",
        "schema-rehashed",
        "provenance-rehashed",
        "extra-file",
        "symlink",
    ],
)
def test_both_readers_reject_package_corruption(saved, tmp_path, attack, reader):
    project, _, _, saved_report = saved
    target = tmp_path / "package"
    package(project, saved_report["report_id"], target)
    if attack in {"checksum", "csv-rehashed"}:
        path = target / "objects.csv"
        text = path.read_text()
        # A valid finite JSON number alteration must fail exact report equality,
        # even when the manifest is updated consistently.
        lines = text.splitlines()
        assert lines
        lines[-1] = lines[-1].replace("9999.0", "9998.0")
        assert "\n".join(lines) + "\n" != text
        path.write_text("\n".join(lines) + "\n")
    elif attack == "csv-shape-rehashed":
        path = target / "objects.csv"
        lines = path.read_text().splitlines()
        path.write_text(lines[0] + "\n" + "\n".join("hidden," + row for row in lines[1:]) + "\n")
    elif attack == "schema-rehashed":
        path = target / "schema.json"
        schema = json.loads(path.read_text())
        schema["tables"]["objects.csv"]["rows"] += 1
        path.write_text(canonical_json(schema) + "\n")
    elif attack == "provenance-rehashed":
        path = target / "provenance.json"
        provenance = json.loads(path.read_text())
        provenance["declaration"]["channel"] = "different literal channel"
        path.write_text(canonical_json(provenance) + "\n")
    elif attack == "extra-file":
        (target / "unlisted.txt").write_text("unexpected")
    elif attack == "symlink":
        path = target / "objects.csv"
        outside = tmp_path / "outside.csv"
        path.rename(outside)
        path.symlink_to(outside)
    if attack.endswith("rehashed"):
        rehash_manifest(target)
    run_readers(target, reader, expected_ok=False)


def test_atomic_no_replace_preserves_existing_destination(saved, tmp_path):
    project, _, _, saved_report = saved
    target = tmp_path / "existing"
    target.mkdir()
    sentinel = target / "keep.txt"
    sentinel.write_bytes(b"preserved")
    with pytest.raises(ValueError, match="absent"):
        package(project, saved_report["report_id"], target)
    assert sentinel.read_bytes() == b"preserved"
    assert list(target.iterdir()) == [sentinel]
    assert not list(tmp_path.glob(".loci-intensity-*"))


def test_cancel_after_staging_write_cleans_only_owned_directory(saved, tmp_path):
    project, _, _, saved_report = saved
    target = tmp_path / "cancelled"
    unrelated = tmp_path / ".loci-intensity-unrelated"
    unrelated.mkdir()
    (unrelated / "keep.txt").write_text("preserve")
    plan = export.plan(project, saved_report["report_id"])

    def cancel_after_write():
        for stage in tmp_path.glob(".loci-intensity-*"):
            if stage != unrelated and list(stage.iterdir()):
                raise RuntimeError("synthetic publication cancellation")

    with pytest.raises(RuntimeError, match="cancellation"):
        export.publish(project, saved_report["report_id"], plan, target, check=cancel_after_write)
    assert not target.exists()
    assert list(tmp_path.glob(".loci-intensity-*")) == [unrelated]
    assert (unrelated / "keep.txt").read_text() == "preserve"


def test_stale_export_grant_and_symlink_parent_rejected(saved, tmp_path):
    project, results, _, saved_report = saved
    plan = export.plan(project, saved_report["report_id"])
    target = tmp_path / "stale"
    grant = export.grant(project, saved_report["report_id"], plan["plan_hash"], target)
    sample(project, results[0], condition="changed")
    with pytest.raises(ValueError, match="changed"):
        export.execute(
            SimpleNamespace(project=project),
            {"grant_id": grant["grant_id"], "plan_hash": grant["plan_hash"]},
        )
    assert not target.exists()
    parent = tmp_path / "real-parent"
    parent.mkdir()
    linked = tmp_path / "linked-parent"
    linked.symlink_to(parent, target_is_directory=True)
    current = export.plan(project, saved_report["report_id"])
    with pytest.raises(ValueError, match="canonical plain directory"):
        export.publish(project, saved_report["report_id"], current, linked / "refused")
    assert not (parent / "refused").exists()
    assert not list(parent.glob(".loci-intensity-*"))


def test_both_readers_independently_reject_rehashed_condition_arithmetic(saved, tmp_path, reader):
    project, _, _, saved_report = saved
    target = tmp_path / "forged-hierarchy"
    package(project, saved_report["report_id"], target)
    report = json.loads((target / "report.json").read_text())
    report["conditions"][0]["mean"] += 1.0
    report["report_hash"] = hashlib.sha256(
        canonical_json(
            {key: value for key, value in report.items() if key != "report_hash"}
        ).encode()
    ).hexdigest()
    (target / "report.json").write_text(canonical_json(report) + "\n")
    for name in ("schema.json", "provenance.json", "manifest.json"):
        document = json.loads((target / name).read_text())
        document["report_hash"] = report["report_hash"]
        (target / name).write_text(canonical_json(document) + "\n")
    rows = report["conditions"]
    columns = sorted({key for row in rows for key in row})
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow(canonical_json(row[column]) for column in columns)
    (target / "conditions.csv").write_text(stream.getvalue())
    rehash_manifest(target)
    for error in run_readers(target, reader, expected_ok=False):
        assert "conditions" in error and "independent" in error


@pytest.mark.parametrize("move", [False, True])
def test_destination_grant_cannot_be_replayed_from_cloned_or_moved_study(saved, tmp_path, move):
    project, _, _, saved_report = saved
    plan = export.plan(project, saved_report["report_id"])
    target = tmp_path / "grant-destination"
    grant = export.grant(project, saved_report["report_id"], plan["plan_hash"], target)
    original = project.root
    other = tmp_path / ("moved-study" if move else "cloned-study")
    if move:
        original.rename(other)
    else:
        shutil.copytree(original, other)
    try:
        relocated = ResearchProject(other)
        with pytest.raises(ValueError, match="another study location"):
            export.execute(
                SimpleNamespace(project=relocated),
                {"grant_id": grant["grant_id"], "plan_hash": grant["plan_hash"]},
            )
        assert not target.exists()
    finally:
        if move:
            other.rename(original)


def test_destination_created_during_staging_is_never_replaced(saved, tmp_path):
    project, _, _, saved_report = saved
    target = tmp_path / "raced-destination"
    plan = export.plan(project, saved_report["report_id"])

    def create_competing_destination():
        if not target.exists() and any(
            list(stage.iterdir()) for stage in tmp_path.glob(".loci-intensity-*")
        ):
            target.mkdir()
            (target / "keep.txt").write_text("concurrent owner")

    with pytest.raises((ValueError, FileExistsError)):
        export.publish(
            project, saved_report["report_id"], plan, target, check=create_competing_destination
        )
    assert (target / "keep.txt").read_text() == "concurrent owner"
    assert len(list(target.iterdir())) == 1
    assert not list(tmp_path.glob(".loci-intensity-*"))


def test_compartment_parent_methods_retained_and_coherent_forgery_rejected_native_portable(
    tmp_path,
):
    from test_research_interchange import _rewrite

    workbench, result, parents, _ = actual_compartment_scene(tmp_path)
    try:
        project = workbench.project
        source_path = Path(project.source(result["source_id"])["private_path"])
        source_bytes = source_path.read_bytes()
        report = intensity.preview(project, request([result], "cell"))
        saved_report = execute(project, "intensity_save", {"report": report})
        identity = saved_report["report_id"]
        expected = canonical_json(report)
        reopened = ResearchProject(project.root)
        assert canonical_json(load(reopened, identity)) == expected
        for parent in parents.values():
            assert canonical_json(reopened.result(parent["id"])) == canonical_json(parent)
        archive = tmp_path / "retained-compartment-parents.zip"
        receipt = export_project(reopened, archive)
        restored = import_project(
            archive,
            tmp_path / "restored-compartment-study",
            expected_archive_sha256=receipt["archive_sha256"],
        )
        assert canonical_json(load(restored, identity)) == expected
        for role, parent in parents.items():
            assert canonical_json(restored.result(parent["id"])) == canonical_json(parent)
            retained = report["bindings"][0]["label_inputs"][role]
            assert retained["result_id"] == parent["id"]
            assert retained["revision_hash"] == parent["revision_hash"]

        # Re-sign an internally coherent report claiming a different nuclear
        # producer. Exact retained original parent evidence must reject it.
        forged = copy.deepcopy(report)
        producer = forged["bindings"][0]["scope"]["label_producers"]["nuclei"]["method"]
        producer["settings"]["recipe"]["segmentation"]["threshold"] += 1
        producer["settings"]["segmentation"]["threshold"] = producer["settings"]["recipe"][
            "segmentation"
        ]["threshold"]
        producer["sha256"] = hashlib.sha256(
            canonical_json(producer["settings"]).encode()
        ).hexdigest()
        forged["report_hash"] = hashlib.sha256(
            canonical_json(
                {key: value for key, value in forged.items() if key != "report_hash"}
            ).encode()
        ).hexdigest()
        intensity.validate_report(forged)
        forged_id = forged["report_hash"][:32]
        document = project.documents("intensity_report", document_id=identity)[0]
        envelope = {**document, "id": forged_id, "data": forged}
        encoded = canonical_json(envelope).encode()
        with project.connection() as connection:
            connection.execute(
                "DELETE FROM documents WHERE kind='intensity_report' AND id=?", (identity,)
            )
            connection.execute(
                "INSERT INTO documents VALUES(?,?,?,?)",
                ("intensity_report", forged_id, 1, encoded.decode()),
            )
        with pytest.raises(ValueError, match="producer|scope|method"):
            load(project, forged_id)
        with pytest.raises(ValueError, match="producer|scope|method"):
            ResearchProject(project.root)

        old_name = f"documents/intensity_report/{identity}.json"
        new_name = f"documents/intensity_report/{forged_id}.json"

        def replace_report_and_manifest(entries):
            changed = []
            manifest_entry = None
            for info, payload in entries:
                if info.filename == old_name:
                    info = copy.copy(info)
                    info.filename = new_name
                    payload = encoded
                if info.filename == "manifest.json":
                    manifest = json.loads(payload)
                    member = next(row for row in manifest["members"] if row["path"] == old_name)
                    member.update(
                        path=new_name,
                        sha256=hashlib.sha256(encoded).hexdigest(),
                        size_bytes=len(encoded),
                    )
                    manifest["members"].sort(key=lambda row: row["path"])
                    manifest_entry = (info, canonical_json(manifest).encode())
                else:
                    changed.append((info, payload))
            assert manifest_entry is not None
            return sorted(changed, key=lambda entry: entry[0].filename) + [manifest_entry]

        forged_archive = tmp_path / "forged-compartment-parent-method.zip"
        _rewrite(archive, forged_archive, replace_report_and_manifest)
        destination = tmp_path / "refused-compartment-study"
        with pytest.raises(ValueError, match="producer|scope|method"):
            import_project(forged_archive, destination)
        assert not destination.exists()
        assert source_path.read_bytes() == source_bytes
    finally:
        workbench.close()


def test_published_package_retained_when_ancestor_moves_and_symlinks_back(
    saved, tmp_path, monkeypatch
):
    project, _, _, saved_report = saved
    ancestor = tmp_path / "original-ancestor"
    parent = ancestor / "destination-parent"
    parent.mkdir(parents=True)
    moved = tmp_path / "moved-ancestor"
    target = parent / "published-package"
    plan = export.plan(project, saved_report["report_id"])
    original_rename = export._rename_noreplace

    def publish_then_move_ancestor(*args, **kwargs):
        original_rename(*args, **kwargs)
        ancestor.rename(moved)
        ancestor.symlink_to(moved, target_is_directory=True)

    monkeypatch.setattr(export, "_rename_noreplace", publish_then_move_ancestor)
    with pytest.raises(RuntimeError, match="published.*parent.*moved"):
        export.publish(project, saved_report["report_id"], plan, target)
    retained = moved / "destination-parent" / target.name
    assert json.loads((retained / "report.json").read_text()) == saved_report["report"]
    assert (retained / "manifest.json").is_file()
    assert list((moved / "destination-parent").iterdir()) == [retained]
    assert not list((moved / "destination-parent").glob(".loci-intensity-*"))
