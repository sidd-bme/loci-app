"""Stream reviewed large results without materialising their numerical grids."""

from __future__ import annotations

import csv
import hashlib
import os
import shutil
import stat
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .research_project import ResearchProject

import numpy as np
import tifffile

from .export import _fsync_directory, _rename_noreplace, sanitize_basename
from .native_image import NativeImageSession, NativeSelection
from .research_export import flat_measurements, methods_text
from .research_project import canonical_json
from .research_tiled_store import iter_object_rows, iter_tiles, label_value_hash
from .workbench import geometry_from_dict


def _checked_hash(path: Path, check=None) -> tuple[str, int]:
    """Hash a stable regular file with cancellation between bounded reads."""
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("Export artifact is not a regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("Export artifact changed before verification")
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            while chunk := stream.read(1024 * 1024):
                if check:
                    check()
                digest.update(chunk)
                size += len(chunk)
    finally:
        os.close(descriptor)
    after = path.lstat()
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ):
        raise ValueError("Export artifact changed during verification")
    return digest.hexdigest(), size


def _copy_checked(source: Path, target: Path, check=None) -> None:
    before = source.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("Object table is not a regular file")
    descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("Object table changed before export")
        with os.fdopen(descriptor, "rb", closefd=False) as reader, target.open("xb") as writer:
            while chunk := reader.read(1024 * 1024):
                if check:
                    check()
                writer.write(chunk)
    finally:
        os.close(descriptor)
    after = source.lstat()
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
        before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns
    ):
        raise ValueError("Object table changed during export")


def _write_grid(project, grid, path, geometry, check=None):
    core = grid["tile_size"]
    metadata = {"axes": "YX"}
    unit = {"um": "µm", "mm": "mm", "nm": "nm", "m": "m"}[geometry.unit]
    for axis, spacing in zip("YX", geometry.spacing, strict=True):
        metadata[f"PhysicalSize{axis}"] = spacing
        metadata[f"PhysicalSize{axis}Unit"] = unit

    def tiles():
        for _, _, values in iter_tiles(project, grid):
            if check:
                check()
            if values.shape != (core, core):
                padded = np.zeros((core, core), dtype=values.dtype)
                padded[: values.shape[0], : values.shape[1]] = values
                yield padded
            else:
                yield values

    tifffile.imwrite(
        path,
        tiles(),
        shape=grid["shape"],
        dtype=grid["dtype"],
        tile=(core, core),
        ome=True,
        metadata=metadata,
        photometric="minisblack",
        compression="deflate",
        bigtiff=True,
        maxworkers=1,
        buffersize=4 * 1024**2,
    )
    if check:
        check()
    # Independent TIFF decoder, bounded regions, exact values. OME spacing is
    # checked separately from the authoritative source-grid affine in result.json.
    with NativeImageSession(path, check=check) as session:
        dims = session.metadata.dimensions
        if (dims.y, dims.x) != tuple(grid["shape"]) or np.dtype(
            session.metadata.channel_dtypes[0]
        ) != np.dtype(grid["dtype"]):
            raise ValueError("Exported TIFF shape or dtype changed")
        calibration = session.metadata.physical_calibration
        factors = {"um": 1.0, "µm": 1.0, "nm": 0.001, "mm": 1000.0, "m": 1e6}
        if calibration is None or calibration.unit not in factors:
            raise ValueError("Exported TIFF lost physical calibration")
        actual_spacing = dict(zip(calibration.axes, calibration.spacing, strict=True))
        for axis, expected_spacing in zip("YX", geometry.spacing, strict=True):
            if not np.isclose(
                actual_spacing[axis] * factors[calibration.unit],
                expected_spacing * factors[geometry.unit],
                rtol=1e-12,
                atol=0,
            ):
                raise ValueError("Exported TIFF physical spacing changed")
        for y, x, expected in iter_tiles(project, grid):
            if check:
                check()
            actual = session.read_region(
                NativeSelection(
                    x=x,
                    y=y,
                    width=expected.shape[1],
                    height=expected.shape[0],
                    budget_bytes=16 * 1024**2,
                )
            ).pixels
            if not np.array_equal(actual, expected):
                raise ValueError("Exported TIFF failed exact bounded numerical round trip")
        session.verify_strict(check=check)


def export_large_result(project, result_id, revision_hash, destination, check=None):
    if check:
        check()
    result = project.result(result_id, check=check)
    if (
        result.get("schema") != "loci.research-result/v2"
        or result["revision_hash"] != revision_hash
    ):
        raise ValueError("Export requires the exact large result revision")
    review = project.review_state(result_id, check=check)
    if review is None or review["disposition"] != "reviewed":
        raise ValueError("Review this exact result revision before exporting it")
    source = project.source(result["source_id"], verify=True, check=check)
    target = Path(destination)
    if not target.is_absolute() or target.exists() or target.is_symlink():
        raise ValueError("Export needs an absent absolute destination")
    parent = target.parent.resolve(strict=True)
    parent_stat = parent.stat()
    target = parent / sanitize_basename(target.name, fallback="loci-result")
    if (
        target.exists()
        or target.is_symlink()
        or target == project.root
        or project.root.is_relative_to(target)
        or target.is_relative_to(project.root)
    ):
        raise ValueError("Export cannot overwrite existing work")
    decoded = sum(
        int(np.prod(grid["shape"])) * np.dtype(grid["dtype"]).itemsize
        for grid in result["arrays"].values()
    )
    if shutil.disk_usage(parent).free < decoded + result["object_table"]["bytes"] + 64 * 1024**2:
        raise ValueError("Insufficient disk space for the streamed result export")
    geometry = geometry_from_dict(result["provenance"]["geometry"])
    if geometry.axes != "YX":
        raise ValueError("Large export requires a YX result")
    published = False
    stage = Path(tempfile.mkdtemp(prefix=".loci-export-", dir=parent))
    try:
        if check:
            check()
        if (
            label_value_hash(project, result["arrays"]["labels"], check=check)
            != result["label_sha256"]
        ):
            raise ValueError("Effective label identity changed")
        for name, grid in result["arrays"].items():
            _write_grid(project, grid, stage / f"{name}.ome.tif", geometry, check=check)
        if check:
            check()
        with (stage / "objects.csv").open("x", newline="", encoding="utf-8") as stream:
            writer = None
            rows = iter_object_rows(project, result["object_table"], check=check)
            for idx, row in enumerate(rows):
                if check and idx % 200 == 0:
                    check()
                flat = flat_measurements([row])[0]
                if writer is None:
                    writer = csv.DictWriter(stream, fieldnames=list(flat))
                    writer.writeheader()
                writer.writerow(flat)
            if writer is None:
                stream.write("label,voxel_count,measure,measure_unit\n")
        if check:
            check()
        table = result["object_table"]
        _copy_checked(
            project.arrays / (table["sha256"] + ".sqlite3"), stage / "objects.sqlite3", check
        )
        if _checked_hash(stage / "objects.sqlite3", check) != (
            table["sha256"],
            table["bytes"],
        ):
            raise ValueError("Object table changed during export")
        lineage = []
        current = result
        while current.get("parent_id"):
            if len(lineage) >= 10000:
                raise ValueError("Correction lineage exceeds export bound")
            current = project.result(current["parent_id"], check=check)
            filename = "ancestor-" + current["id"] + ".json"
            encoded_ancestor = canonical_json(current)
            (stage / filename).write_text(encoded_ancestor + "\n", encoding="utf-8")
            lineage.append(
                {
                    "result_id": current["id"],
                    "revision_hash": current["revision_hash"],
                    "file": filename,
                }
            )
        receipt = {
            "schema": "loci.research-export/v2",
            "result": result,
            "review": review,
            "source": project.public_source(source),
            "correction_ancestors": lineage,
            "geometry_authority": "result.provenance.geometry voxel-center XYZ-to-world affine",
            "raw_source_included": False,
            "selected_raw_plane_included": True,
            "ancestor_arrays_included": False,
            "label_value_sha256": result["label_sha256"],
        }
        (stage / "result.json").write_text(canonical_json(receipt) + "\n", encoding="utf-8")
        (stage / "methods.md").write_text(methods_text(result), encoding="utf-8")
        (stage / "loci-export.json").write_text(
            canonical_json(
                {
                    "schema": "loci.export-marker/v1",
                    "bundle_kind": "loci-export",
                    "result_id": result_id,
                    "revision_hash": revision_hash,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        files = []
        for entry in sorted(stage.iterdir()):
            if check:
                check()
            with entry.open("rb+") as stream:
                os.fsync(stream.fileno())
            digest, size = _checked_hash(entry, check)
            files.append({"name": entry.name, "sha256": digest, "size_bytes": size})
        encoded = canonical_json(
            {
                "schema": "loci.export-manifest/v1",
                "result_id": result_id,
                "revision_hash": revision_hash,
                "files": files,
            }
        ).encode()
        if check:
            check()
        with (stage / "manifest.json").open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        _fsync_directory(stage)
        project.source(result["source_id"], verify=True, check=check)
        if (
            project.result(result_id, check=check)["revision_hash"] != revision_hash
            or project.review_state(result_id, check=check) != review
        ):
            raise ValueError("Result review changed during export")
        current = parent.stat()
        if (current.st_dev, current.st_ino) != (parent_stat.st_dev, parent_stat.st_ino):
            raise ValueError("Export directory changed during publication")
        if check:
            check()
        _rename_noreplace(stage, target)
        published = True
        _fsync_directory(parent)
        return {
            "export_name": target.name,
            "manifest_sha256": hashlib.sha256(encoded).hexdigest(),
            "files": files,
            "result_id": result_id,
            "revision_hash": revision_hash,
        }
    finally:
        if not published and stage.exists() and not stage.is_symlink():
            shutil.rmtree(stage)


def create_export_grant(
    project: ResearchProject, result_id: str, revision_hash: str, destination: str
) -> dict[str, Any]:
    from .research_project import checked_id, timestamp

    result = project.result(checked_id(result_id))
    if (
        result.get("schema") != "loci.research-result/v2"
        or result["revision_hash"] != revision_hash
    ):
        raise ValueError("Export grant requires the exact large result revision")
    review = project.review_state(result_id)
    if review is None or review["disposition"] != "reviewed":
        raise ValueError("Review this exact result revision before exporting it")

    target = Path(destination)
    if not target.is_absolute() or target.exists() or target.is_symlink():
        raise ValueError("Export needs an absent absolute destination")
    parent = target.parent.resolve(strict=True)
    target = parent / sanitize_basename(target.name, fallback="loci-result")
    if target.exists() or target.is_symlink():
        raise ValueError("Export cannot overwrite existing work")
    if (
        target == project.root
        or project.root.is_relative_to(target)
        or target.is_relative_to(project.root)
    ):
        raise ValueError("Export destination cannot replace or be inside the project root")

    grant_id = hashlib.sha256(f"{result_id}:{revision_hash}:{target}".encode()).hexdigest()[:32]
    existing = next(
        (doc for doc in project.documents("large_export_grant") if doc["id"] == grant_id),
        None,
    )
    if existing is not None:
        return {
            "grant_id": grant_id,
            "result_id": result_id,
            "revision_hash": revision_hash,
            "export_name": target.name,
        }

    grant_data = {
        "grant_id": grant_id,
        "result_id": result_id,
        "revision_hash": revision_hash,
        "destination": str(target),
        "export_name": target.name,
        "created_at": timestamp(),
    }
    project.put_document("large_export_grant", grant_id, grant_data, expected_revision=0)
    return {
        "grant_id": grant_id,
        "result_id": result_id,
        "revision_hash": revision_hash,
        "export_name": target.name,
    }


def execute_large_export_task(
    workbench, request, *, job_id=None, publication_guard=None
) -> dict[str, Any]:
    from .quantitative import exact_keys
    from .research_project import checked_id, checked_text, timestamp

    exact_keys(request, {"result_id", "revision_hash", "grant_id"}, "large export task request")
    project = workbench.project
    grant_id = checked_id(request["grant_id"])
    result_id = checked_id(request["result_id"])
    revision_hash = checked_text(request["revision_hash"], "Revision hash", 64)

    grant_doc = next(
        (doc for doc in project.documents("large_export_grant") if doc["id"] == grant_id),
        None,
    )
    if grant_doc is None:
        raise ValueError("Export grant not found or expired")
    grant = grant_doc["data"]
    if grant.get("result_id") != result_id or grant.get("revision_hash") != revision_hash:
        raise ValueError("Export grant does not match requested result revision")

    destination = grant["destination"]

    def check():
        if publication_guard is not None:
            publication_guard()
        if job_id is not None:
            job = project.job(job_id)
            if job["state"] != "running" or job["cancel_requested"]:
                raise ValueError("Large export cancelled before publication")

    receipt = export_large_result(project, result_id, revision_hash, destination, check=check)

    if job_id is not None:
        project.update_job(
            job_id,
            expected_state="running",
            state="succeeded",
            progress=1.0,
            finished_at=timestamp(),
        )

    return receipt
