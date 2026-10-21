"""Bounded immutable report package, with native-only grants and no replacement."""

from __future__ import annotations

import csv
import hashlib
import io
import os
import platform
import shutil
import sys
import uuid
from contextlib import suppress
from pathlib import Path

from .export import _rename_noreplace
from .research_data_export import (
    _DIRECTORY_FLAGS,
    _capability,
    _destination,
    _identity,
    _verify_files,
)
from .research_intensity_reports import load
from .research_project import canonical_json, checked_id, timestamp

SCHEMA = "loci.experiment-intensity-package/v1"
MAX_BYTES = 64 * 1024**2
MAX_FILES = 16


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _software(check=None):
    from .models import ENGINE_VERSION
    from .working_result import _sha256_file_stable

    if getattr(sys, "frozen", False):
        digest, _ = _sha256_file_stable(Path(sys.executable), reject_symlink=True, check=check)
        kind = "frozen-executable-sha256"
    else:
        digests = {
            name: _sha256_file_stable(
                Path(__file__).with_name(name), reject_symlink=True, check=check
            )[0]
            for name in (
                "research_intensity_export.py",
                "research_intensity_reports.py",
                "intensity_export_readers.py",
            )
        }
        digest, kind = _hash(digests), "source-modules-sha256"
    return {
        "kind": kind,
        "sha256": digest,
        "engine_version": ENGINE_VERSION,
        "python_version": platform.python_version(),
    }


def plan(project, report_id, check=None):
    from .experiment_intensity import current_status

    if check:
        check()
    report = load(project, report_id, verify_sources=True, check=check)
    value = {
        "schema": "loci.intensity-export-plan/v1",
        "report_id": report_id,
        "report_hash": report["report_hash"],
        "status": current_status(project, report, check=check),
        "export_software": _software(check=check),
    }
    if check:
        check()
    return {**value, "plan_hash": _hash(value)}


def grant(project, report_id, expected_plan_hash, destination):
    _capability()
    current = plan(project, report_id)
    if current["plan_hash"] != expected_plan_hash:
        raise ValueError("Report inputs changed; prepare a fresh export preview")
    target = _destination(project, destination)
    parent = target.parent.stat()
    grant_id = uuid.uuid4().hex
    project.put_document(
        "intensity_export_grant",
        grant_id,
        {
            "schema": "loci.intensity-export-grant/v1",
            "plan": current,
            "destination": str(target),
            "parent_identity": [parent.st_dev, parent.st_ino],
            "source_id": load(project, report_id)["bindings"][0]["source_id"],
            "project_id": project.meta["project_id"],
            "private_project_root": str(project.root),
            "created_at": timestamp(),
        },
        expected_revision=0,
    )
    return {"grant_id": grant_id, "plan_hash": current["plan_hash"], "basename": target.name}


def _grant(project, request):
    if not isinstance(request, dict) or set(request) != {"grant_id", "plan_hash"}:
        raise ValueError("Choose an exact intensity export grant")
    documents = project.documents(
        "intensity_export_grant", document_id=checked_id(request["grant_id"])
    )
    if len(documents) != 1 or documents[0]["data"]["plan"]["plan_hash"] != request["plan_hash"]:
        raise ValueError("Intensity export grant is missing or stale")
    data = documents[0]["data"]
    if data.get("project_id") != project.meta["project_id"] or data.get(
        "private_project_root"
    ) != str(project.root):
        raise ValueError("Intensity export destination grant belongs to another study location")
    return documents[0]


def task_source(project, request):
    return _grant(project, request)["data"]["source_id"]


def _csv(rows):
    # JSON cells are reversible, preserve literal strings and null, and prevent
    # spreadsheet formula execution. Numbers use Python's round-trip repr.
    columns = sorted({key for row in rows for key in row})
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow(canonical_json(row.get(column)) for column in columns)
    return output.getvalue()


def _contents(report, status):
    files = {"report.json": canonical_json(report) + "\n"}
    tables = {}
    for key in ("observations", "images", "replicates", "conditions", "audit"):
        rows = report[key]
        name = "objects.csv" if key == "observations" else key + ".csv"
        files[name] = _csv(rows)
        columns = sorted({k for row in rows for k in row})
        meanings = {
            "result_id": "Exact saved result revision ID",
            "revision_hash": "Result SHA256",
            "source_id": "Stable source ID",
            "label": "Exact positive object label ID",
            "value": "Stored raw-channel object mean; null when status is null or missing",
            "status": (
                "value: finite signed number; null: empty compartment; missing: absent measurement"
            ),
            "mean": "Equal-weight mean at this table's level; null with no valid contributors",
            "sd": "Sample SD of valid replicate means (ddof=1); null with fewer than two",
            "object_count": (
                "Objects represented by this row; excluded image rows retain their counts; "
                "aggregate rows count eligible images"
            ),
            "valid_object_count": "Objects with finite mean values",
            "null_object_count": "Objects with explicit null measured means",
            "missing_object_count": "Objects missing the selected measurement",
            "image_count": "Included images, including images without valid means",
            "valid_image_count": "Images with a finite image mean",
            "declared_replicate_count": "Distinct declared replicate labels within condition",
            "valid_replicate_count": "Declared replicate groups with a finite mean",
            "unassigned_image_count": "Images without replicate labels; omitted from condition",
            "included": "Reviewed image eligible for image-level descriptive mean",
            "reason": "Explicit inclusion or omission reason",
            "contributes_to_condition": "Reviewed image with valid mean and replicate label",
            "biological_replicate": "Declared group label; no independence inferred",
            "result_ids": "Exact result IDs in this declared replicate group",
            "review_disposition": "Captured review disposition when report was created",
        }
        tables[name] = {
            "rows": len(rows),
            "columns": columns,
            "dictionary": {
                key: meanings.get(key, "Captured declared sample " + key) for key in columns
            },
        }
    files["schema.json"] = (
        canonical_json(
            {
                "schema": SCHEMA,
                "report_hash": report["report_hash"],
                "tables": tables,
                "encoding": "UTF-8",
                "cell_encoding": (
                    "Every CSV cell is JSON; parse with JSON, not spreadsheet coercion"
                ),
                "unit": "source-intensity",
                "null": "JSON null; distinct from numerical zero and missing status",
                "numeric_policy": "Unrounded round-trip floats; exact integer labels/counts",
                "endpoint": report["endpoint"],
                "aggregation": report["aggregation"],
            }
        )
        + "\n"
    )
    files["provenance.json"] = (
        canonical_json(
            {
                "report_hash": report["report_hash"],
                "created_at": report["created_at"],
                "software": report["software"],
                "bindings": report["bindings"],
                "declaration": report["declaration"],
                "current_input_status_at_export": status,
            }
        )
        + "\n"
    )
    files["readme.md"] = (
        "# Loci experiment intensity report\n\n"
        "report.json is the immutable saved snapshot. CSV cells are JSON encoded; "
        "parse each cell with a JSON reader to preserve nulls and strings. "
        "objects.csv contains stored per-object raw means, never pixels. "
        "Average valid object means within each reviewed image, valid image means "
        "within each declared (condition, biological_replicate), then valid replicate "
        "means within condition. SD uses ddof=1, null below two replicate means. "
        "Excluded images and unassigned replicate labels never enter condition estimates. "
        "Declared replicates do not prove biological independence. Missing acquisition "
        "settings and user-declared comparability remain explicit. No calibrated "
        "fluorescence or biological inference is claimed. Verify manifest checksums "
        "before use. Run python read_report.py . or Rscript read_report.R .\n"
    )
    from .intensity_export_readers import PYTHON_READER, R_READER

    files["read_report.py"] = PYTHON_READER
    files["read_report.R"] = R_READER
    return files


def publish(project, report_id, expected_plan, destination, check=None):
    _capability()

    def bound():
        if check:
            check()
        if plan(project, report_id, check=check) != expected_plan:
            raise ValueError("Intensity export inputs changed; prepare a new preview")

    bound()
    report = load(project, report_id, verify_sources=True, check=check)
    contents = _contents(report, expected_plan["status"])
    records = {
        name: {
            "sha256": hashlib.sha256(value.encode()).hexdigest(),
            "size_bytes": len(value.encode()),
        }
        for name, value in contents.items()
    }
    contents["manifest.json"] = (
        canonical_json(
            {
                "schema": "loci.intensity-export-manifest/v1",
                "package_schema": SCHEMA,
                "report_hash": report["report_hash"],
                "plan_hash": expected_plan["plan_hash"],
                "export_software": expected_plan["export_software"],
                "files": [{"name": name, **value} for name, value in sorted(records.items())],
            }
        )
        + "\n"
    )
    records["manifest.json"] = {
        "sha256": hashlib.sha256(contents["manifest.json"].encode()).hexdigest(),
        "size_bytes": len(contents["manifest.json"].encode()),
    }
    size = sum(value["size_bytes"] for value in records.values())
    target = _destination(project, destination)
    if (
        len(contents) > MAX_FILES
        or size > MAX_BYTES
        or shutil.disk_usage(target.parent).free < size
    ):
        raise ValueError("Intensity package exceeds the file, byte or available disk budget")
    parent_fd = os.open(target.parent, _DIRECTORY_FLAGS)
    stage_name, stage_fd, stage_identity, published = (
        ".loci-intensity-" + uuid.uuid4().hex,
        None,
        None,
        False,
    )
    parent_identity = _identity(os.fstat(parent_fd))
    try:
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise ValueError("Intensity destination parent changed")
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        stage_identity = _identity(os.fstat(stage_fd))
        for name, contents_text in contents.items():
            if check:
                check()
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=stage_fd,
            )
            with os.fdopen(fd, "wb") as stream:
                data = contents_text.encode()
                for offset in range(0, len(data), 65536):
                    if check:
                        check()
                    stream.write(data[offset : offset + 65536])
                stream.flush()
                os.fsync(stream.fileno())
        os.fsync(stage_fd)
        _verify_files(stage_fd, records, check)
        bound()
        _verify_files(stage_fd, records, check)
        bound()
        if (
            target.parent.resolve(strict=True) != target.parent
            or parent_identity != _identity(target.parent.lstat())
            or stage_identity
            != _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
        ):
            raise ValueError("Intensity publication directory changed")
        if check:
            check()
        _rename_noreplace(stage_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published = True
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise RuntimeError(
                "Intensity package published; destination parent moved. Inspect before retrying"
            )
        os.fsync(parent_fd)
        return {
            "schema": "loci.intensity-export-receipt/v1",
            "basename": target.name,
            "report_hash": report["report_hash"],
            "manifest_sha256": records["manifest.json"]["sha256"],
        }
    finally:
        if stage_fd is not None:
            if not published:
                error = sys.exception()
                try:
                    with suppress(FileNotFoundError):
                        if (
                            _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
                            == stage_identity
                        ):
                            shutil.rmtree(stage_name, dir_fd=parent_fd)
                except OSError:
                    if error:
                        error.add_note("Owned intensity staging cleanup failed")
                    else:
                        raise
            os.close(stage_fd)
        os.close(parent_fd)


def execute(workbench, request, job_id=None, publication_guard=None):
    project = workbench.project
    document = _grant(project, request)
    data = document["data"]

    def check():
        if publication_guard:
            publication_guard()
        if _grant(project, request) != document:
            raise ValueError("Intensity export grant changed")
        if job_id:
            job = project.job(job_id)
            if job["state"] != "running" or job["cancel_requested"]:
                raise ValueError("Intensity export cancelled before publication")
        parent = Path(data["destination"]).parent
        if (
            parent.resolve(strict=True) != parent
            or list(_identity(parent.lstat())) != data["parent_identity"]
        ):
            raise ValueError("Granted intensity export parent changed")

    receipt = publish(project, data["plan"]["report_id"], data["plan"], data["destination"], check)
    if job_id:
        project.update_job(
            job_id,
            expected_state="running",
            state="succeeded",
            progress=1.0,
            finished_at=timestamp(),
        )
    return receipt
