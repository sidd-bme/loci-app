"""Verification and atomic adoption of remotely produced large results."""

from __future__ import annotations

import contextlib
import csv
import hashlib
import hmac
import math
import os
import stat
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from .export import _rename_noreplace
from .large_components import measure_tiled
from .native_image import NativeImageSession, NativeSelection
from .quantitative import MAX_WORKING_BYTES, exact_keys
from .research_export import flat_measurements
from .research_project import (
    ResearchProject,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
    timestamp,
)
from .research_tiled_store import (
    TiledArrayWriter,
    _open_table,
    iter_object_rows,
    label_value_hash,
    object_rows,
    read_region,
    validate_grid,
    validate_object_table,
)
from .workbench import Workbench, geometry_from_dict, result_summary, runtime_record
from .working_result import _sha256_file_stable

ALLOWED_BUNDLE_FILES = frozenset(
    {
        "manifest.json",
        "result.json",
        "image.ome.tif",
        "labels.ome.tif",
        "objects.csv",
        "objects.sqlite3",
        "methods.md",
        "loci-export.json",
    }
)
FLOAT_ATOL = 1e-9
FLOAT_RTOL = 1e-12
MAX_TEXT_SIZE = 16 * 1024 * 1024
LOCAL_WORKING_ALLOWANCE = 256 * 1024 * 1024


def float_close(actual: float, expected: float) -> bool:
    if not math.isfinite(actual) or not math.isfinite(expected):
        return False
    return abs(actual - expected) <= FLOAT_ATOL + FLOAT_RTOL * abs(expected)


def _require_exact(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"Invalid or incomplete {name} fields")
    return value


def _validate_producer_records(receipt: dict[str, Any], result: dict[str, Any]) -> None:
    """Require the exported records to describe one supported CPU computation."""
    source = receipt["source"]
    prov = result["provenance"]
    source_keys = {
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
    if "derivation" in source:
        source_keys.add("derivation")
    _require_exact(source, source_keys, "exported source")
    if ("source_derivation" in prov) != ("derivation" in source) or (
        "derivation" in source and prov["source_derivation"] != source["derivation"]
    ):
        raise ValueError("Exported source derivation disagrees with result provenance")
    checked_id(source["id"])
    if (
        source["id"] != result["source_id"]
        or source["sha256"] != result["source_sha256"]
        or type(source["size_bytes"]) is not int
        or source["size_bytes"] <= 0
        or source["source_kind"] != "native"
        or source["identity_kind"] != "full-file-sha256"
        or not isinstance(source["metadata"], dict)
        or source["metadata"].get("sha256") != source["sha256"]
    ):
        raise ValueError("Exported source and result identity or size disagree")

    selection = prov["selection"]
    _require_exact(
        selection, {"x", "y", "width", "height", "t", "c", "z", "level"}, "remote selection"
    )
    if any(type(value) is not int or value < 0 for value in selection.values()):
        raise ValueError("Remote selection indices must be non-negative integers")
    if selection["level"] != 0 or min(selection["width"], selection["height"]) < 1:
        raise ValueError("Remote selection must be a non-empty level-zero plane")

    recipe = prov["recipe"]
    _require_exact(
        recipe, {"steps", "segmentation", "measurement_channels", "working_bytes"}, "large recipe"
    )
    if (
        recipe["steps"] != []
        or prov["processing"] != []
        or recipe["measurement_channels"] != [selection["c"]]
        or type(recipe["working_bytes"]) is not int
        or not LOCAL_WORKING_ALLOWANCE <= recipe["working_bytes"] <= MAX_WORKING_BYTES
    ):
        raise ValueError("Large recipe preprocessing, channel, or allowance is unsupported")
    spec = recipe["segmentation"]
    _require_exact(
        spec,
        {"method", "threshold", "polarity", "min_size", "exclude_border"},
        "large recipe segmentation",
    )
    seg = prov["segmentation"]
    _require_exact(
        seg,
        {
            "method",
            "dimensions",
            "threshold",
            "threshold_method",
            "polarity",
            "connectivity",
            "min_size",
            "size_unit",
            "split_height",
            "distance_unit",
            "exclude_border",
            "count",
            "provisional_count",
            "tile_size",
            "scientific_validation",
        },
        "large segmentation record",
    )
    geom = prov["geometry"]
    if (
        seg["dimensions"] != 2
        or seg["connectivity"] != 1
        or seg["threshold_method"] != "user-defined"
        or seg["split_height"] is not None
        or seg["tile_size"] != 512
        or seg["scientific_validation"] != "unvalidated-research-method"
        or seg["size_unit"] != f"{geom['unit']}^2"
        or seg["distance_unit"] != geom["unit"]
        or type(seg["count"]) is not int
        or not 0 <= seg["count"] <= 100_000
        or type(seg["provisional_count"]) is not int
        or not seg["count"] <= seg["provisional_count"] <= 1_000_000
        or any(seg[key] != spec[key] for key in spec)
    ):
        raise ValueError("Segmentation record contradicts the resolved CPU recipe")
    policy = prov["execution_policy"]
    _require_exact(
        policy,
        {
            "name",
            "core_size",
            "connectivity",
            "halo",
            "maximum_objects",
            "maximum_provisional_components",
        },
        "large execution policy",
    )
    if (
        policy["maximum_objects"] != 100_000
        or policy["maximum_provisional_components"] != 1_000_000
    ):
        raise ValueError("Unsupported large component bounds")
    runtime = prov["runtime"]
    if isinstance(runtime, dict) and runtime.get("resolved_device") not in (None, "cpu"):
        raise ValueError(
            f"Unsupported execution device: {runtime['resolved_device']}; only CPU is supported"
        )
    if isinstance(runtime, dict) and runtime.get("backend") not in (None, "numpy-scipy-cpu"):
        raise ValueError(f"Unsupported execution backend: {runtime['backend']}")
    _require_exact(
        runtime,
        {
            "engine",
            "numpy",
            "scipy",
            "scikit_image",
            "requested_device",
            "resolved_device",
            "backend",
            "fallback_reason",
            "scientific_validation",
        },
        "large CPU runtime",
    )
    if (
        runtime["requested_device"] != "auto"
        or runtime["resolved_device"] != "cpu"
        or runtime["backend"] != "numpy-scipy-cpu"
        or runtime["fallback_reason"] is not None
        or runtime["scientific_validation"] != "unvalidated-research-method"
        or any(
            not isinstance(runtime[key], str) or not runtime[key]
            for key in ("engine", "numpy", "scipy", "scikit_image")
        )
        or result["engine_version"] != runtime["engine"]
    ):
        raise ValueError("Unsupported or contradictory CPU runtime record")

    channels = prov["channel_metadata"]
    _require_exact(
        channels,
        {"source_id", "source_sha256", "original_names", "revision", "channels", "basis"},
        "remote channel metadata",
    )
    if (
        channels["source_id"] != source["id"]
        or channels["source_sha256"] != source["sha256"]
        or not isinstance(channels["channels"], list)
        or not 1 <= len(channels["channels"]) <= 256
        or not isinstance(channels["original_names"], list)
        or len(channels["original_names"]) != len(channels["channels"])
        or type(channels["revision"]) is not int
        or channels["revision"] < 0
        or channels["basis"]
        != (
            "acquisition metadata and explicit user declarations; "
            "no identity inferred from appearance"
        )
        or len(channels["channels"]) != source["metadata"].get("dimensions", {}).get("c")
    ):
        raise ValueError("Remote channel metadata contradicts the source")
    from .research_channels import validate_declarations

    if (
        validate_declarations(channels["channels"], len(channels["channels"]))
        != channels["channels"]
    ):
        raise ValueError("Remote channel declarations are not canonical")
    if channels["original_names"] != source["metadata"].get("channel_names"):
        raise ValueError("Remote acquisition channel names disagree with source")
    c = selection["c"]
    if (
        c >= len(channels["channels"])
        or prov["measurement_channel_name"] != f"{c + 1}: {channels['channels'][c]['name']}"
    ):
        raise ValueError("Remote measurement channel does not match selected C index")
    if prov["measurement_basis"] != "raw-selected-channel-values-on-result-grid":
        raise ValueError("Unsupported measurement basis")
    review = receipt["review"]
    _require_exact(
        review,
        {"actor", "disposition", "result_id", "reviewed_at", "revision_hash"},
        "exported review",
    )
    if (
        review["result_id"] != result["id"]
        or review["revision_hash"] != result["revision_hash"]
        or review["disposition"] != "reviewed"
        or receipt["geometry_authority"]
        != "result.provenance.geometry voxel-center XYZ-to-world affine"
    ):
        raise ValueError("Export review or geometry authority disagrees with result")


def _check_cancellation(workbench: Workbench, job_id: str | None, guard: Any | None) -> None:
    if guard:
        guard()
    if job_id is not None:
        job = workbench.project.job(job_id)
        if job["state"] != "running" or job["cancel_requested"]:
            raise ValueError("Large result adoption cancelled before publication")


def _read_bounded_bytes(path: Path, max_bytes: int = MAX_TEXT_SIZE) -> bytes:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
        raise ValueError(f"Bundle file {path.name} must be regular and within allowed size")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("Bundle metadata changed before reading")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError(f"Bundle file {path.name} exceeds allowed size")
    finally:
        os.close(fd)
    after = path.lstat()
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
        before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns
    ):
        raise ValueError("Bundle metadata changed during reading")
    return raw


def _read_bounded_json(path: Path, max_bytes: int = MAX_TEXT_SIZE) -> Any:
    raw = _read_bounded_bytes(path, max_bytes)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Invalid UTF-8 in {path.name}") from exc
    return parse_json(text)


def validate_export_bundle_metadata(
    directory: Path, expected_manifest_sha256: str | None = None
) -> dict[str, Any]:
    """Bounded, fast validation of bundle structure and small JSON metadata.

    Performs only metadata/manifest checks without hashing large image/table files.
    """
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise ValueError("Export bundle must be an absolute non-symlink directory")

    entries = []
    with os.scandir(directory) as iterator:
        for entry in iterator:
            if len(entries) == 32:
                raise ValueError("Bundle contains too many entries")
            entries.append(Path(entry.path))
    names = {entry.name for entry in entries}
    for entry in entries:
        if entry.is_symlink():
            raise ValueError(f"Bundle entry {entry.name} is a symlink")
        if entry.is_dir():
            raise ValueError(f"Bundle contains unexpected directory {entry.name}")
        if entry.name not in ALLOWED_BUNDLE_FILES:
            raise ValueError(f"Bundle contains unexpected file {entry.name}")

    if not ALLOWED_BUNDLE_FILES.issubset(names):
        missing = sorted(ALLOWED_BUNDLE_FILES - names)
        raise ValueError(f"Bundle missing required files: {missing}")

    manifest_path = directory / "manifest.json"
    manifest_raw = _read_bounded_bytes(manifest_path)
    manifest_digest = hashlib.sha256(manifest_raw).hexdigest()
    if expected_manifest_sha256 is not None and not hmac.compare_digest(
        manifest_digest, expected_manifest_sha256
    ):
        raise ValueError("Bundle manifest digest does not match grant")

    manifest = parse_json(manifest_raw.decode("utf-8"))
    exact_keys(manifest, {"schema", "result_id", "revision_hash", "files"}, "export manifest")
    if manifest["schema"] != "loci.export-manifest/v1":
        raise ValueError(f"Unsupported manifest schema {manifest['schema']}")
    checked_id(manifest["result_id"])
    checked_text(manifest["revision_hash"], "Manifest revision hash", 64)

    files_list = manifest["files"]
    if not isinstance(files_list, list) or len(files_list) != len(ALLOWED_BUNDLE_FILES) - 1:
        raise ValueError("Manifest file count does not match bundle content")

    manifest_files_map: dict[str, dict[str, Any]] = {}
    for item in files_list:
        exact_keys(item, {"name", "sha256", "size_bytes"}, "manifest file entry")
        name = item["name"]
        if name in manifest_files_map:
            raise ValueError(f"Duplicate entry {name} in manifest")
        if type(item["size_bytes"]) is not int or item["size_bytes"] < 0:
            raise ValueError(f"Invalid size_bytes for {name}")
        checked_text(item["sha256"], f"SHA-256 for {name}", 64)
        manifest_files_map[name] = item

    expected_other_names = ALLOWED_BUNDLE_FILES - {"manifest.json"}
    if set(manifest_files_map) != expected_other_names:
        raise ValueError("Manifest entries disagree with required bundle files")

    marker = _read_bounded_json(directory / "loci-export.json")
    exact_keys(marker, {"schema", "bundle_kind", "result_id", "revision_hash"}, "export marker")
    if (
        marker["schema"] != "loci.export-marker/v1"
        or marker["bundle_kind"] != "loci-export"
        or marker["result_id"] != manifest["result_id"]
        or marker["revision_hash"] != manifest["revision_hash"]
    ):
        raise ValueError("Export marker disagrees with bundle manifest")

    receipt = _read_bounded_json(directory / "result.json")
    exact_keys(
        receipt,
        {
            "schema",
            "result",
            "review",
            "source",
            "correction_ancestors",
            "geometry_authority",
            "raw_source_included",
            "selected_raw_plane_included",
            "ancestor_arrays_included",
            "label_value_sha256",
        },
        "export receipt",
    )
    if receipt["schema"] != "loci.research-export/v2":
        raise ValueError(f"Unsupported export receipt schema {receipt['schema']}")
    if (
        receipt["raw_source_included"] is not False
        or receipt["selected_raw_plane_included"] is not True
        or receipt["ancestor_arrays_included"] is not False
    ):
        raise ValueError("Export receipt array inclusion flags are invalid")
    if receipt["correction_ancestors"] != []:
        raise ValueError("Remote exchange only supports uncorrected root results without ancestors")

    result = receipt["result"]
    exact_keys(
        result,
        {
            "schema",
            "id",
            "source_id",
            "source_sha256",
            "kind",
            "parent_id",
            "created_at",
            "engine_version",
            "arrays",
            "provenance",
            "object_table",
            "object_count",
            "label_sha256",
            "revision_hash",
        },
        "exported result",
    )
    if (
        result["schema"] != "loci.research-result/v2"
        or result["kind"] != "large-components"
        or result["parent_id"] is not None
        or result["id"] != manifest["result_id"]
        or result["revision_hash"] != manifest["revision_hash"]
        or result["label_sha256"] != receipt["label_value_sha256"]
    ):
        raise ValueError(
            "Result record does not match uncorrected large-components root specification"
        )

    return {
        "manifest": manifest,
        "manifest_digest": manifest_digest,
        "manifest_files_map": manifest_files_map,
        "receipt": receipt,
        "result": result,
    }


def validate_export_bundle_directory(
    directory: Path,
    expected_manifest_sha256: str | None = None,
    check: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Strict, comprehensive validation of the complete bundle, including all files and schemas."""
    meta = validate_export_bundle_metadata(directory, expected_manifest_sha256)
    manifest = meta["manifest"]
    manifest_digest = meta["manifest_digest"]
    manifest_files_map = meta["manifest_files_map"]
    receipt = meta["receipt"]
    result = meta["result"]

    expected_other_names = ALLOWED_BUNDLE_FILES - {"manifest.json"}
    for name in sorted(expected_other_names):
        if check is not None:
            check()
        entry_path = directory / name
        digest, size = _sha256_file_stable(entry_path, reject_symlink=True, check=check)
        file_meta = manifest_files_map[name]
        if size != file_meta["size_bytes"] or not hmac.compare_digest(digest, file_meta["sha256"]):
            raise ValueError(f"Bundle file {name} failed integrity check against manifest")

    # Canonical result revision hash verification
    candidate_result = {k: v for k, v in result.items() if k != "revision_hash"}
    computed_rev = hashlib.sha256(canonical_json(candidate_result).encode()).hexdigest()
    if not hmac.compare_digest(result["revision_hash"], computed_rev):
        raise ValueError(
            "Result revision hash does not match canonical serialization of result record"
        )
    _validate_producer_records(receipt, result)

    # Array descriptors and grid schema verification
    arrays = result["arrays"]
    if not isinstance(arrays, dict) or set(arrays) != {"image", "labels"}:
        raise ValueError("Large result must contain exactly image and labels arrays")
    img_grid, lbl_grid = arrays["image"], arrays["labels"]
    validate_grid(None, img_grid, verify=False)
    validate_grid(None, lbl_grid, verify=False)
    if (
        img_grid["shape"] != lbl_grid["shape"]
        or img_grid["tile_size"] != 512
        or lbl_grid["tile_size"] != 512
        or img_grid["dtype"] not in ("uint8", "uint16")
        or lbl_grid["dtype"] != "uint32"
    ):
        raise ValueError(
            "Exported grids must be 512-core YX grids with uint8/16 image and uint32 labels"
        )

    # Object table descriptor verification
    table = result["object_table"]
    exact_keys(table, {"schema", "sha256", "bytes", "count"}, "object table descriptor")
    if (
        table["schema"] != "loci.object-table/v1"
        or type(table["count"]) is not int
        or table["count"] < 0
        or table["count"] > 100_000
        or table["count"] != result["object_count"]
    ):
        raise ValueError("Exported object table descriptor is invalid or exceeds 100000 objects")
    if (
        table["sha256"] != manifest_files_map["objects.sqlite3"]["sha256"]
        or table["bytes"] != manifest_files_map["objects.sqlite3"]["size_bytes"]
    ):
        raise ValueError("Object table descriptor disagrees with objects.sqlite3 file in manifest")

    # Provenance schema & semantic validation
    prov = result["provenance"]
    allowed_prov_keys = {
        "geometry",
        "selection",
        "recipe",
        "recipe_sha256",
        "segmentation",
        "processing",
        "channel_metadata",
        "measurement_channel_name",
        "measurement_basis",
        "runtime",
        "execution_policy",
    }
    prov_keys = set(prov)
    if "job_id" in prov_keys:
        checked_id(prov["job_id"])
        prov_keys.remove("job_id")
    if "source_derivation" in prov_keys:
        prov_keys.remove("source_derivation")
    if prov_keys != allowed_prov_keys:
        raise ValueError(
            f"Result provenance keys mismatch: extra={prov_keys - allowed_prov_keys}, "
            f"missing={allowed_prov_keys - prov_keys}"
        )

    # Recompute recipe hash
    computed_recipe_hash = hashlib.sha256(canonical_json(prov["recipe"]).encode()).hexdigest()
    if not hmac.compare_digest(prov["recipe_sha256"], computed_recipe_hash):
        raise ValueError("Recipe hash disagrees with canonical recipe serialization")

    policy = prov["execution_policy"]
    if (
        not isinstance(policy, dict)
        or policy.get("name") != "loci.large-components/1"
        or policy.get("core_size") != 512
        or policy.get("connectivity") != 4
        or policy.get("halo") != 0
    ):
        raise ValueError(
            "Execution policy must be loci.large-components/1 with core512 and 4-connectivity"
        )

    seg = prov["segmentation"]
    if (
        not isinstance(seg, dict)
        or seg.get("method") != "components"
        or seg.get("polarity") not in ("bright", "dark")
        or type(seg.get("min_size")) not in (int, float)
        or type(seg.get("min_size")) is bool
        or seg.get("min_size") < 0
        or type(seg.get("exclude_border")) is not bool
        or type(seg.get("threshold")) not in (int, float)
        or type(seg.get("threshold")) is bool
        or not math.isfinite(seg.get("threshold"))
    ):
        raise ValueError("Segmentation parameters are invalid or non-finite")

    runtime = prov["runtime"]
    if not isinstance(runtime, dict):
        raise ValueError("Runtime record must be a dictionary")
    resolved_device = runtime.get("resolved_device")
    if resolved_device is not None and resolved_device != "cpu":
        raise ValueError(f"Unsupported execution device: {resolved_device}; only CPU is supported")
    backend = runtime.get("backend")
    if backend is not None and backend not in ("numpy-scipy-cpu", "cpu"):
        raise ValueError(f"Unsupported execution backend: {backend}")

    geom = prov["geometry"]
    if (
        not isinstance(geom, dict)
        or geom.get("axes") != "YX"
        or geom.get("unit") not in {"um", "nm", "mm", "m"}
    ):
        raise ValueError("Large components requires calibrated YX geometry")

    sel = prov["selection"]
    if not isinstance(sel, dict) or sel.get("level") != 0 or "z_stop" in sel:
        raise ValueError("Large components requires a single level-0 native plane")
    if (sel.get("height"), sel.get("width")) != tuple(img_grid["shape"]):
        raise ValueError("Selection dimensions disagree with array shape")

    ch_meta = prov.get("channel_metadata")
    if (
        not isinstance(ch_meta, dict)
        or "channels" not in ch_meta
        or not isinstance(ch_meta["channels"], list)
    ):
        raise ValueError("Channel metadata must declare channels list")
    meas_ch_name = prov.get("measurement_channel_name")
    if not isinstance(meas_ch_name, str) or not meas_ch_name:
        raise ValueError("Measurement channel name must be a non-empty string")
    decl_names = {ch.get("name") for ch in ch_meta["channels"] if isinstance(ch, dict)}
    if not any(meas_ch_name.endswith(f": {name}") or meas_ch_name == name for name in decl_names):
        raise ValueError(
            f"Measurement channel '{meas_ch_name}' not found in declared channel metadata"
        )

    return {
        "manifest": manifest,
        "manifest_digest": manifest_digest,
        "receipt": receipt,
        "result": result,
    }


def create_exchange_grant(
    project: ResearchProject, source_id: str, directory_path: str
) -> dict[str, Any]:
    """Synchronous, bounded grant creation without full source or bundle hashing."""
    if project.schema_version != 2:
        raise ValueError("Large exchange requires a v2 study")
    source = project.source(checked_id(source_id), verify=False)
    directory = Path(directory_path).resolve(strict=True)
    if (
        directory == project.root
        or project.root.is_relative_to(directory)
        or directory.is_relative_to(project.root)
    ):
        raise ValueError("Export bundle cannot be inside or contain the project root")

    validated = validate_export_bundle_metadata(directory)
    exported_source = validated["receipt"]["source"]
    if exported_source["sha256"] != source["sha256"]:
        raise ValueError("Exported result was produced from a different source image")
    if exported_source["size_bytes"] != source["size_bytes"]:
        raise ValueError("Exported source file size disagrees with local source")

    remote_res = validated["result"]
    if remote_res["source_sha256"] != source["sha256"]:
        raise ValueError("Exported result source hash disagrees with local source")

    grant_id = hashlib.sha256(
        f"{source['id']}:{source['sha256']}:{validated['manifest_digest']}:{directory}".encode()
    ).hexdigest()[:32]
    existing = next(
        (doc for doc in project.documents("large_exchange_grant") if doc["id"] == grant_id),
        None,
    )
    if existing is not None:
        if (
            existing["data"]["source_id"] != source["id"]
            or existing["data"]["source_sha256"] != source["sha256"]
        ):
            raise ValueError("Existing exchange grant belongs to another registered source")
        return {
            "grant_id": grant_id,
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "manifest_sha256": validated["manifest_digest"],
            "bundle_name": directory.name,
        }
    grant_data = {
        "grant_id": grant_id,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "export_directory": str(directory),
        "manifest_sha256": validated["manifest_digest"],
        "bundle_name": directory.name,
        "created_at": timestamp(),
    }
    project.put_document("large_exchange_grant", grant_id, grant_data, expected_revision=0)
    return {
        "grant_id": grant_id,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "manifest_sha256": validated["manifest_digest"],
        "bundle_name": directory.name,
    }


def _stage_and_publish_table(
    project: ResearchProject,
    source_db_path: Path,
    table_desc: dict[str, Any],
    check: Callable[[], None],
) -> None:
    """Safely stages and atomically publishes the object table into project arrays."""
    check()
    target = project.arrays / f"{table_desc['sha256']}.sqlite3"
    if target.exists():
        digest, size = _sha256_file_stable(target, reject_symlink=True, check=check)
        if digest != table_desc["sha256"] or size != table_desc["bytes"]:
            raise ValueError("Existing stored object table is corrupt")
        validate_object_table(project, table_desc, check=check)
        return

    descriptor, temp_str = tempfile.mkstemp(prefix=".table-staging-", dir=project.root)
    temp_path = Path(temp_str)
    try:
        with (
            source_db_path.open("rb") as src_stream,
            os.fdopen(descriptor, "wb") as dst_stream,
        ):
            while chunk := src_stream.read(1024 * 1024):
                check()
                dst_stream.write(chunk)
            dst_stream.flush()
            os.fsync(dst_stream.fileno())
        check()
        digest, size = _sha256_file_stable(temp_path, reject_symlink=True, check=check)
        if digest != table_desc["sha256"] or size != table_desc["bytes"]:
            raise ValueError("Staged object table failed SHA-256 verification")
        try:
            _rename_noreplace(temp_path, target)
        except FileExistsError as err:
            if temp_path.exists():
                with contextlib.suppress(FileNotFoundError):
                    temp_path.unlink()
            digest, size = _sha256_file_stable(target, reject_symlink=True, check=check)
            if digest != table_desc["sha256"] or size != table_desc["bytes"]:
                raise ValueError("Existing stored object table is corrupt") from err
    except Exception:
        raise

    check()
    validate_object_table(project, table_desc, check=check)


def adopt_large_result(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Any | None = None,
) -> dict[str, Any]:
    exact_keys(request, {"source_id", "grant_id", "manifest_sha256"}, "adoption request")
    project = workbench.project
    if project.schema_version != 2:
        raise ValueError("Adoption requires a v2 study")

    def check():
        _check_cancellation(workbench, job_id, publication_guard)

    check()
    source_id = checked_id(request["source_id"])
    grant_id = checked_id(request["grant_id"])
    expected_manifest_sha = checked_text(request["manifest_sha256"], "Manifest SHA-256", 64)

    grant_doc = next(
        (doc for doc in project.documents("large_exchange_grant") if doc["id"] == grant_id),
        None,
    )
    if grant_doc is None:
        raise ValueError("Exchange grant not found or expired")
    grant = grant_doc["data"]
    if grant["source_id"] != source_id or grant["manifest_sha256"] != expected_manifest_sha:
        raise ValueError("Exchange grant does not match requested source or manifest")

    local_source = project.source(source_id, verify=False)
    if local_source["sha256"] != grant["source_sha256"]:
        raise ValueError("Local source changed during exchange staging")

    bundle_dir = Path(grant["export_directory"]).resolve(strict=True)
    if not bundle_dir.is_dir() or bundle_dir.is_symlink():
        raise ValueError("Export bundle directory is invalid or inaccessible")

    stats_before = {
        p.name: (p.stat().st_dev, p.stat().st_ino, p.stat().st_size, p.stat().st_mtime_ns)
        for p in bundle_dir.iterdir()
    }
    validated = validate_export_bundle_directory(bundle_dir, expected_manifest_sha, check=check)
    remote_result = validated["result"]
    selection = remote_result["provenance"]["selection"]
    shape = tuple(remote_result["arrays"]["image"]["shape"])
    returned_geometry = geometry_from_dict(remote_result["provenance"]["geometry"])

    # Compute deterministic adoption ID
    adopted_key = (
        f"loci.large-adoption:{source_id}:{grant['source_sha256']}:"
        f"{grant['manifest_sha256']}:{remote_result['revision_hash']}"
    )
    adopted_result_id = hashlib.sha256(adopted_key.encode()).hexdigest()[:32]

    # Strict local source verification and authoritative geometry resolution
    local_session = workbench._session(source_id, check=check)
    local_session.verify_strict(check=check)
    local_meta = local_session.metadata
    if local_meta.format != "OME-TIFF" or not local_meta.capabilities.tiled:
        raise ValueError("Local source must be a tiled OME-TIFF")
    remote_source = validated["receipt"]["source"]
    if remote_source.get("derivation") != local_source.get("derivation"):
        raise ValueError("Exported native source derivation disagrees with registered source")
    scientific_source_fields = (
        "format",
        "axes",
        "shape",
        "source_axes",
        "source_shape",
        "dimensions",
        "channel_dtypes",
        "channel_names",
        "selected_series",
        "series_count",
        "physical_calibration",
        "levels",
        "plane_positions",
        "plane_times",
        "timing",
        "sample_semantics",
    )
    if (
        any(
            remote_source["metadata"].get(field) != local_source["metadata"].get(field)
            for field in scientific_source_fields
        )
        or remote_source["metadata"].get("selected_series") != local_meta.selected_series
    ):
        raise ValueError("Exported scientific source metadata disagrees with registered source")
    if workbench.selection(source_id, selection) != selection:
        raise ValueError("Remote selection is not the resolved native source selection")
    if selection["c"] < 0 or selection["c"] >= len(local_meta.channel_dtypes):
        raise ValueError("Selection channel is out of range for local source")
    local_dtype = np.dtype(local_meta.channel_dtypes[selection["c"]])
    if str(local_dtype) != remote_result["arrays"]["image"]["dtype"]:
        raise ValueError("Local source channel dtype disagrees with exported image")

    local_geom = workbench._native_geometry(local_session, selection, False)
    if (
        local_geom.unit != returned_geometry.unit
        or local_geom.frame != returned_geometry.frame
        or local_geom.axes != returned_geometry.axes
        or not np.allclose(
            local_geom.spacing, returned_geometry.spacing, rtol=FLOAT_RTOL, atol=FLOAT_ATOL
        )
        or not np.allclose(
            local_geom.affine, returned_geometry.affine, rtol=FLOAT_RTOL, atol=FLOAT_ATOL
        )
    ):
        raise ValueError(
            "Local source physical calibration or affine disagrees with exported result"
        )

    image_path = bundle_dir / "image.ome.tif"
    labels_path = bundle_dir / "labels.ome.tif"

    image_writer = TiledArrayWriter(project, shape, str(local_dtype), 512)
    label_writer = TiledArrayWriter(project, shape, "uint32", 512)

    with (
        NativeImageSession(str(image_path), check=check) as bundle_raw,
        NativeImageSession(str(labels_path), check=check) as bundle_lbl,
    ):
        bundle_raw.verify_strict(check=check)
        bundle_lbl.verify_strict(check=check)

        raw_dims = bundle_raw.metadata.dimensions
        lbl_dims = bundle_lbl.metadata.dimensions
        if (raw_dims.y, raw_dims.x) != shape or (lbl_dims.y, lbl_dims.x) != shape:
            raise ValueError("Exported TIFF dimensions disagree with result shape")
        if any(
            getattr(raw_dims, axis) != 1 or getattr(lbl_dims, axis) != 1
            for axis in ("t", "c", "z", "s")
        ):
            raise ValueError("Exported TIFF must contain one scalar C/Z/T plane")
        if bundle_raw.metadata.channel_dtypes[0] != str(local_dtype):
            raise ValueError("Exported raw TIFF dtype disagrees with selected source")
        if bundle_lbl.metadata.channel_dtypes[0] != "uint32":
            raise ValueError("Exported label TIFF must be uint32")
        factors = {"um": 1.0, "µm": 1.0, "nm": 0.001, "mm": 1000.0, "m": 1e6}
        for session in (bundle_raw, bundle_lbl):
            calibration = session.metadata.physical_calibration
            if (
                calibration is None
                or calibration.unit not in factors
                or set(calibration.axes) != {"X", "Y"}
            ):
                raise ValueError("Exported TIFF has missing or unsupported XY calibration")
            actual_spacing = dict(zip(calibration.axes, calibration.spacing, strict=True))
            for axis, expected_spacing in zip("YX", returned_geometry.spacing, strict=True):
                if not np.isclose(
                    actual_spacing[axis] * factors[calibration.unit],
                    expected_spacing * factors[returned_geometry.unit],
                    rtol=1e-12,
                    atol=0,
                ):
                    raise ValueError("Exported TIFF XY calibration disagrees with result geometry")

        for y in range(0, shape[0], 512):
            for x in range(0, shape[1], 512):
                check()
                h = min(512, shape[0] - y)
                w = min(512, shape[1] - x)

                exported_raw_tile = bundle_raw.read_region(
                    NativeSelection(x=x, y=y, width=w, height=h, budget_bytes=16 * 1024**2)
                ).pixels
                local_raw_tile = local_session.read_region(
                    NativeSelection(
                        x=selection["x"] + x,
                        y=selection["y"] + y,
                        width=w,
                        height=h,
                        t=selection["t"],
                        c=selection["c"],
                        z=selection["z"],
                        level=0,
                        series=local_session.metadata.selected_series,
                        expected_sha256=local_source["sha256"],
                        budget_bytes=16 * 1024**2,
                    )
                ).pixels

                if not np.array_equal(exported_raw_tile, local_raw_tile):
                    raise ValueError("Exported raw image pixels disagree with local source")

                label_tile = bundle_lbl.read_region(
                    NativeSelection(x=x, y=y, width=w, height=h, budget_bytes=16 * 1024**2)
                ).pixels

                image_writer.write(y, x, local_raw_tile)
                label_writer.write(y, x, label_tile)

    arrays = {"image": image_writer.finish(), "labels": label_writer.finish()}
    check()
    if arrays != remote_result["arrays"]:
        raise ValueError("Reconstructed canonical cores disagree with exported grid descriptors")

    computed_label_hash = label_value_hash(project, arrays["labels"], check=check)
    if computed_label_hash != remote_result["label_sha256"]:
        raise ValueError("Adopted label grid canonical value hash mismatch")
    if remote_result["provenance"]["segmentation"]["count"] != remote_result["object_count"]:
        raise ValueError("Segmentation count disagrees with exported object count")

    table_desc = remote_result["object_table"]
    _stage_and_publish_table(project, bundle_dir / "objects.sqlite3", table_desc, check=check)

    declarations = workbench.channel_metadata(source_id)
    local_channel_name = f"{selection['c'] + 1}: {declarations['channels'][selection['c']]['name']}"
    declared_remote_channel = remote_result["provenance"]["measurement_channel_name"]

    # Streamed measurement reconstruction comparison directly with SQLite cursor
    with contextlib.closing(_open_table(project, table_desc, check=check)) as conn:
        cursor = conn.execute("SELECT label, record FROM objects ORDER BY label")
        verified_count = 0

        def compare_row(rec_row: dict[str, Any]) -> None:
            nonlocal verified_count
            if verified_count % 200 == 0:
                check()
            row_data = cursor.fetchone()
            if row_data is None:
                raise ValueError("Returned object table has fewer rows than reconstructed objects")
            if row_data[0] != rec_row["label"]:
                raise ValueError(f"Label ID mismatch: {rec_row['label']} != {row_data[0]}")
            table_row = parse_json(row_data[1])

            if rec_row["label"] != table_row["label"]:
                raise ValueError(f"Label ID mismatch for label {rec_row['label']}")
            if rec_row["voxel_count"] != table_row["voxel_count"]:
                raise ValueError(f"Voxel count mismatch for label {rec_row['label']}")
            if rec_row["measure_kind"] != table_row["measure_kind"]:
                raise ValueError(f"Measure kind mismatch for label {rec_row['label']}")
            if rec_row["measure_unit"] != table_row["measure_unit"]:
                raise ValueError(f"Measure unit mismatch for label {rec_row['label']}")
            if rec_row["index_axes"] != table_row["index_axes"]:
                raise ValueError(f"Index axes mismatch for label {rec_row['label']}")
            if rec_row["world_frame"] != table_row["world_frame"]:
                raise ValueError(f"World frame mismatch for label {rec_row['label']}")
            if rec_row["distance_unit"] != table_row["distance_unit"]:
                raise ValueError(f"Distance unit mismatch for label {rec_row['label']}")
            if rec_row["bbox_start"] != table_row["bbox_start"]:
                raise ValueError(f"Bounding box start mismatch for label {rec_row['label']}")
            if rec_row["bbox_stop_exclusive"] != table_row["bbox_stop_exclusive"]:
                raise ValueError(f"Bounding box stop mismatch for label {rec_row['label']}")
            if rec_row["touches_crop_border"] != table_row["touches_crop_border"]:
                raise ValueError(f"Crop border flag mismatch for label {rec_row['label']}")

            if not float_close(rec_row["measure"], table_row["measure"]):
                raise ValueError(f"Measure value mismatch for label {rec_row['label']}")
            if not float_close(
                rec_row["centroid_index"][0], table_row["centroid_index"][0]
            ) or not float_close(rec_row["centroid_index"][1], table_row["centroid_index"][1]):
                raise ValueError(f"Centroid index mismatch for label {rec_row['label']}")
            for c_act, c_exp in zip(
                rec_row["centroid_world_xyz"], table_row["centroid_world_xyz"], strict=True
            ):
                if not float_close(c_act, c_exp):
                    raise ValueError(f"Centroid world mismatch for label {rec_row['label']}")
            for r_act, r_exp in zip(
                rec_row["principal_rms_radii"], table_row["principal_rms_radii"], strict=True
            ):
                if not float_close(r_act, r_exp):
                    raise ValueError(f"Principal radii mismatch for label {rec_row['label']}")

            rec_dist = rec_row["nearest_centroid_distance"]
            tbl_dist = table_row.get("nearest_centroid_distance")
            if (rec_dist is None) != (tbl_dist is None):
                raise ValueError(f"Nearest distance presence mismatch for label {rec_row['label']}")
            if rec_dist is not None and not float_close(rec_dist, tbl_dist):
                raise ValueError(f"Nearest distance mismatch for label {rec_row['label']}")

            tbl_intensity = table_row.get("intensity")
            if not isinstance(tbl_intensity, dict) or len(tbl_intensity) != 1:
                raise ValueError(
                    f"Object table intensity must contain exactly one channel "
                    f"for label {rec_row['label']}"
                )
            if declared_remote_channel not in tbl_intensity:
                raise ValueError(
                    f"Intensity key mismatch for label {rec_row['label']}: "
                    f"expected '{declared_remote_channel}', got {set(tbl_intensity)}"
                )
            tbl_ch = tbl_intensity[declared_remote_channel]
            rec_ch = rec_row["intensity"][local_channel_name]
            exact_keys(tbl_ch, {"mean", "sum", "min", "max", "std_population"}, "intensity stats")
            if (
                rec_ch["sum"] != tbl_ch["sum"]
                or rec_ch["min"] != tbl_ch["min"]
                or rec_ch["max"] != tbl_ch["max"]
            ):
                raise ValueError(
                    f"Exact intensity sum/min/max mismatch for label {rec_row['label']}"
                )
            if not float_close(rec_ch["mean"], tbl_ch["mean"]) or not float_close(
                rec_ch["std_population"], tbl_ch["std_population"]
            ):
                raise ValueError(f"Intensity mean or stddev mismatch for label {rec_row['label']}")

            verified_count += 1

        measure_tiled(
            lambda y, x, h, w: read_region(project, arrays["labels"], y, x, h, w),
            lambda y, x, h, w: read_region(project, arrays["image"], y, x, h, w),
            shape,
            local_geom,
            local_channel_name,
            compare_row,
            working_bytes=LOCAL_WORKING_ALLOWANCE,
            tile_size=512,
            check=check,
        )
        if cursor.fetchone() is not None:
            raise ValueError("Returned object table has more rows than reconstructed objects")
        if verified_count != table_desc["count"]:
            raise ValueError("Reconstructed object count differs from returned table")

    check()

    # Streamed CSV validation against verified SQLite rows
    with (bundle_dir / "objects.csv").open("r", newline="", encoding="utf-8") as stream:
        raw_csv_reader = csv.reader(stream)
        try:
            header = next(raw_csv_reader)
        except StopIteration:
            header = []
        if len(header) != len(set(header)):
            raise ValueError("objects.csv contains duplicate header columns")

        # Rewind to parse rows with DictReader
        stream.seek(0)
        dict_reader = csv.DictReader(stream)
        csv_count = 0
        for idx, table_row in enumerate(iter_object_rows(project, table_desc, check=check)):
            if idx % 200 == 0:
                check()
            csv_row = next(dict_reader, None)
            if csv_row is None:
                raise ValueError("objects.csv has fewer rows than object table")
            flat = flat_measurements([table_row])[0]
            if set(csv_row) != set(flat):
                raise ValueError(f"objects.csv column mismatch at row {idx}")
            for k, val in flat.items():
                csv_val = csv_row[k]
                if val is None:
                    if csv_val != "":
                        raise ValueError(
                            f"objects.csv field {k} expected empty for None at row {idx}"
                        )
                elif isinstance(val, bool):
                    if str(val) != csv_val:
                        raise ValueError(f"objects.csv field {k} bool mismatch at row {idx}")
                elif isinstance(val, int):
                    if str(val) != csv_val:
                        raise ValueError(f"objects.csv field {k} integer mismatch at row {idx}")
                elif isinstance(val, str):
                    if val != csv_val:
                        raise ValueError(f"objects.csv field {k} string mismatch at row {idx}")
                elif isinstance(val, float) and (
                    not math.isfinite(val) or not float_close(float(csv_val), val)
                ):
                    raise ValueError(f"objects.csv field {k} float mismatch at row {idx}")
            csv_count += 1

        if next(dict_reader, None) is not None:
            raise ValueError("objects.csv has more rows than object table")
        if csv_count != table_desc["count"]:
            raise ValueError("objects.csv row count disagrees with table object count")

    # Post-streaming bundle modification check
    stats_after = {
        p.name: (p.stat().st_dev, p.stat().st_ino, p.stat().st_size, p.stat().st_mtime_ns)
        for p in bundle_dir.iterdir()
    }
    if stats_before != stats_after:
        raise ValueError("Bundle files modified during exchange verification")

    project.source(source_id, verify=True, check=check)
    check()
    # Construct provenance with remote claims preserved and local verification recorded
    adopted_provenance = dict(remote_result["provenance"])
    remote_job_id = adopted_provenance.pop("job_id", None)
    adopted_provenance["remote_exchange"] = {
        "remote_result_id": remote_result["id"],
        "remote_revision_hash": remote_result["revision_hash"],
        "remote_source_id": remote_result["source_id"],
        "remote_source_sha256": remote_result["source_sha256"],
        "manifest_sha256": grant["manifest_sha256"],
        "remote_runtime": remote_result["provenance"].get("runtime"),
        "remote_job_id": remote_job_id,
        "verified_at": grant["created_at"],
        "verification_tolerance": {"absolute": FLOAT_ATOL, "relative": FLOAT_RTOL},
        "verification_runtime": runtime_record(),
        "reconstruction_method": "loci.large-components.reconstruct/1",
    }
    if job_id is not None:
        adopted_provenance["job_id"] = job_id

    # A retry earns reuse only after the current source and complete returned
    # bundle have passed the same checks as a first adoption.
    with project.connection() as connection:
        existing_row = connection.execute(
            "SELECT record FROM results WHERE id=?", (adopted_result_id,)
        ).fetchone()
    if existing_row is not None:
        existing = project.result(adopted_result_id, check=check)
        existing_provenance = dict(existing["provenance"])
        existing_provenance.pop("job_id", None)
        proposed_provenance = dict(adopted_provenance)
        proposed_provenance.pop("job_id", None)
        for provenance in (existing_provenance, proposed_provenance):
            exchange = dict(provenance["remote_exchange"])
            exchange.pop("verified_at", None)
            provenance["remote_exchange"] = exchange
        if (
            existing["source_id"] != source_id
            or existing["source_sha256"] != local_source["sha256"]
            or existing["kind"] != "large-components"
            or existing["parent_id"] is not None
            or existing["arrays"] != arrays
            or existing["object_table"] != table_desc
            or existing["object_count"] != table_desc["count"]
            or existing["label_sha256"] != remote_result["label_sha256"]
            or existing_provenance != proposed_provenance
        ):
            raise ValueError("Existing adopted result has different source or verified content")
        with project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            check()
            current = connection.execute(
                "SELECT record FROM results WHERE id=?", (adopted_result_id,)
            ).fetchone()
            if current is None or parse_json(current[0]) != existing:
                raise ValueError("Existing adopted result changed during retry")
            if job_id is not None:
                job_row = connection.execute(
                    "SELECT record FROM jobs WHERE id=?", (checked_id(job_id),)
                ).fetchone()
                if job_row is None:
                    raise ValueError("Adoption job is not part of this study")
                job = parse_json(job_row[0])
                if (
                    job["state"] != "running"
                    or job["cancel_requested"]
                    or job["operation"] != "large_result_adopt"
                    or job["request"].get("source_id") != source_id
                ):
                    raise ValueError("Adoption job was cancelled or belongs to another source")
                job.update(
                    state="succeeded",
                    progress=1.0,
                    result_ids=[adopted_result_id],
                    finished_at=timestamp(),
                    updated_at=timestamp(),
                )
                connection.execute(
                    "UPDATE jobs SET record=? WHERE id=?",
                    (canonical_json(job), job_id),
                )
        return {
            "result": result_summary(existing),
            "measurements": object_rows(project, existing["object_table"], limit=200),
        }

    published = project.save_tiled_result(
        source_id=source_id,
        kind="large-components",
        arrays=arrays,
        provenance=adopted_provenance,
        object_table=table_desc,
        label_sha256=remote_result["label_sha256"],
        result_id=adopted_result_id,
        created_at=grant["created_at"],
        job_id=job_id,
        publication_guard=check,
    )

    return {
        "result": result_summary(published),
        "measurements": object_rows(project, published["object_table"], limit=200),
    }
