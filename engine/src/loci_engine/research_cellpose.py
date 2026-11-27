"""Project-scoped local Cellpose preview, exact adoption, and direct execution."""

from __future__ import annotations

import base64
import copy
import hashlib
import math
import platform
import re
import uuid
from collections.abc import Callable
from dataclasses import fields
from pathlib import Path, PureWindowsPath
from typing import TYPE_CHECKING, Any

import numpy as np

from .cellpose_backend import (
    CELLPOSE_PACKAGE_VERSION,
    CELLPOSE_PROFILE_ID,
    CELLPOSE_SAM_V2_SPEC,
    _import_runtime,
    get_cellpose_status,
)
from .models import ENGINE_VERSION, CellposeSettings
from .profiles import resolve_profile
from .quantitative import MAX_WORKING_BYTES, Geometry, exact_keys, integer, measure_objects
from .render import _display_bounds, png_data_url, render_overlay_rgb
from .research_project import ResearchProject, canonical_json, checked_id
from .segment import _cellpose_prepared_pixels
from .workbench import result_summary, runtime_record

if TYPE_CHECKING:
    from .profiles import SegmentationProfile
    from .workbench import Workbench


CELLPOSE_PREVIEW_SCHEMA = "loci.cellpose-preview/v1"
CELLPOSE_MODEL_STATUS_SCHEMA = "loci.cellpose-model-status/v1"
CELLPOSE_PREVIEW_DOC_KIND = "model_preview"
CELLPOSE_PROVENANCE_PREVIEW_KEY = "cellpose_preview"
CELLPOSE_AGENT_PROFILE_ID = CELLPOSE_PROFILE_ID
CELLPOSE_DEFAULT_WORKING_BYTES = 2 * 1024**3
CELLPOSE_MIN_POLICY_MEMORY_BYTES = 512 * 1024**2
MAX_UNADOPTED_CELLPOSE_PREVIEWS = 64
CELLPOSE_OPERATIONS = frozenset(
    {
        "cellpose_model_status",
        "cellpose_preview",
        "cellpose_adopt",
        "cellpose_run",
    }
)

_POLICY_RUNTIME_KEYS = ("engine", "numpy", "scipy", "scikit_image")
_REQUEST_KEYS = {
    "source_id",
    "selection",
    "profile_id",
    "settings",
    "measurement_channels",
    "working_bytes",
}
_SELECTION_KEYS = {"x", "y", "width", "height", "t", "c", "z", "level"}
_ALLOWED_SOURCE_KINDS = {"native", "whole_slide", "ome_zarr"}
_SAFE_STATUS_SUMMARIES = {
    "ready": (
        "The cpsam_v2 checkpoint and Cellpose 4.2.1.1 CPU runtime are installed, "
        "verified, and ready for local processing."
    ),
    "package-missing": (
        f"Cellpose {CELLPOSE_PACKAGE_VERSION} is not installed in this Loci engine runtime."
    ),
    "package-version-mismatch": (
        f"Installed Cellpose version does not match required {CELLPOSE_PACKAGE_VERSION}."
    ),
    "runtime-import-failed": (
        f"Cellpose {CELLPOSE_PACKAGE_VERSION} is installed, but its local CPU runtime "
        "could not be imported."
    ),
    "model-missing": (
        "The cpsam_v2 checkpoint is not installed. Import the official checkpoint "
        "before using this Cellpose profile; Loci will not download it silently."
    ),
    "model-size-mismatch": (
        "The managed cpsam_v2 checkpoint has an unexpected byte size and will not be loaded."
    ),
    "model-hash-mismatch": (
        "The managed cpsam_v2 checkpoint failed SHA-256 verification and will not be loaded."
    ),
    "model-invalid": ("The managed cpsam_v2 checkpoint could not be verified as a regular file."),
    "model-unverified": "The managed cpsam_v2 checkpoint has not passed verification.",
}


_WINDOWS_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:[\\/]")


def _string_contains_filesystem_path(value: str) -> bool:
    if (
        Path(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or value.startswith(("./", "../", "~/", ".\\", "..\\", "~\\", "\\\\"))
        or "/../" in value
        or value.endswith("/..")
        or value.lower().startswith("file:")
        or "\\" in value
    ):
        return True
    for raw_token in value.split():
        token = raw_token.strip("()[]{}'\",.;:")
        if (
            token.startswith(("/", "./", "../", "~/", "\\\\"))
            or "/../" in token
            or bool(_WINDOWS_DRIVE_PREFIX.match(token))
            or token.lower().startswith("file:")
        ):
            return True
    return False


def _validate_path_free_record(value: object, *, location: str) -> None:
    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{location} contains a non-finite number")
        return
    if isinstance(value, str):
        if _string_contains_filesystem_path(value):
            raise ValueError(f"{location} must not contain a filesystem path")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_path_free_record(item, location=f"{location}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{location} object keys must be strings")
            normalized_key = key.lower().replace("-", "_")
            if normalized_key.startswith("private_") or "path" in normalized_key.split("_"):
                raise ValueError(f"{location}.{key} is not allowed in a path-free record")
            _validate_path_free_record(item, location=f"{location}.{key}")
        return
    raise TypeError(f"{location} contains a non-JSON value of type {type(value).__name__}")


def _digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _safe_version_string(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 128
        or "/" in value
        or "\\" in value
        or any(ord(ch) < 32 for ch in value)
    ):
        raise PermissionError(f"{label} is missing or invalid")
    return value


def _array_sha256(array: np.ndarray) -> str:
    value = np.ascontiguousarray(array)
    digest = hashlib.sha256()
    digest.update(canonical_json({"shape": list(value.shape), "dtype": str(value.dtype)}).encode())
    digest.update(value.tobytes(order="C"))
    return digest.hexdigest()


def _geometry_record(geometry: Geometry) -> dict[str, Any]:
    return {
        "axes": geometry.axes,
        "affine": [list(row) for row in geometry.affine],
        "unit": geometry.unit,
        "frame": geometry.frame,
    }


def _preview_hash(receipt: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(receipt).encode()).hexdigest()


def _preview_document(project: ResearchProject, preview_id: str) -> dict[str, Any]:
    checked_id(preview_id)
    matches = project.documents(CELLPOSE_PREVIEW_DOC_KIND, document_id=preview_id)
    if len(matches) != 1:
        raise ValueError("Cellpose preview is not part of this study")
    return matches[0]


def _settings(value: object) -> CellposeSettings:
    expected = {field.name for field in fields(CellposeSettings)}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("Cellpose settings must contain every declared profile setting exactly")
    settings = CellposeSettings(**value)
    settings.validate()
    return settings


def _measurement_channels(value: object, count: int) -> list[int]:
    if (
        not isinstance(value, list)
        or len(value) > 32
        or any(isinstance(channel, bool) or not isinstance(channel, int) for channel in value)
        or any(channel < 0 or channel >= count for channel in value)
        or len(set(value)) != len(value)
    ):
        raise ValueError("Choose up to 32 unique available raw measurement channels")
    return list(value)


def _validated_labels(inference: Any, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    labels = np.asarray(inference.output.labels)
    normalized = np.asarray(inference.output.normalized, dtype=np.float64)
    if (
        labels.ndim != 2
        or labels.shape != shape
        or normalized.shape != shape
        or not np.issubdtype(labels.dtype, np.integer)
        or not np.isfinite(normalized).all()
        or np.any(normalized < 0)
        or np.any(normalized > 1)
        or labels.size == 0
        or int(labels.min()) < 0
        or int(labels.max()) > np.iinfo(np.uint32).max
    ):
        raise ValueError("Cellpose output does not match the selected 2D source grid")
    labels = labels.astype(np.uint32, copy=True)
    positive_ids = np.unique(labels)
    positive_ids = positive_ids[positive_ids != 0]
    if not np.array_equal(positive_ids, np.arange(1, len(positive_ids) + 1)) or int(
        inference.output.count
    ) != len(positive_ids):
        raise ValueError("Cellpose output labels or object count are inconsistent")
    return labels, normalized


def estimate_cellpose_memory_bytes(
    width: int,
    height: int,
    dtype_itemsize: int,
    measurement_channel_count: int,
    settings: CellposeSettings | dict[str, Any],
    *,
    sample_count: int = 1,
) -> dict[str, int]:
    """Deterministically compute all local Cellpose working-memory bounds before decode."""
    checked_width = integer(width, "width", 1, 1_000_000)
    checked_height = integer(height, "height", 1, 1_000_000)
    checked_itemsize = integer(dtype_itemsize, "dtype_itemsize", 1, 16)
    checked_channels = integer(measurement_channel_count, "measurement_channel_count", 0, 32)
    checked_samples = integer(sample_count, "sample_count", 1, 4)
    parsed_settings = settings if isinstance(settings, CellposeSettings) else _settings(settings)
    parsed_settings.validate()
    selected_pixels = checked_width * checked_height
    image_nbytes = selected_pixels * checked_itemsize * checked_samples
    aggregate_required = image_nbytes + selected_pixels * (160 + 8 * checked_channels)
    prepared_pixels = _cellpose_prepared_pixels(
        checked_height, checked_width, parsed_settings.max_edge_px
    )
    analysis_estimated = image_nbytes + selected_pixels * 32 + prepared_pixels * 96
    load_scalar_required = selected_pixels * 96
    accelerator_preflight = (
        2 * CELLPOSE_SAM_V2_SPEC.size_bytes
        + parsed_settings.batch_size * 32 * 1024**2
        + prepared_pixels * 64
        + 256 * 1024**2
    )
    return {
        "selected_pixels": selected_pixels,
        "prepared_pixels": prepared_pixels,
        "image_nbytes": image_nbytes,
        "aggregate_required_bytes": aggregate_required,
        "analysis_estimated_bytes": analysis_estimated,
        "load_scalar_required_bytes": load_scalar_required,
        "required_working_bytes": max(aggregate_required, analysis_estimated, load_scalar_required),
        "runtime_required_bytes": accelerator_preflight,
        "accelerator_preflight_bytes": accelerator_preflight,
    }


def _cellpose_cpu_runtime_contract(cellpose_version: str, torch_version: str) -> dict[str, Any]:
    return {
        "backend": "cellpose",
        "cellpose_version": cellpose_version,
        "torch_version": torch_version,
        "requested_device": "cpu",
        "resolved_device": "cpu",
        "use_bfloat16": True,
    }


def installed_cellpose_pins() -> tuple[dict[str, str], dict[str, str]]:
    """Verify the installed local Cellpose-SAM v2 checkpoint and CPU runtime pins."""
    status = get_cellpose_status(CELLPOSE_SAM_V2_SPEC, inspect_devices=True)
    if (
        not status.ready
        or status.code != "ready"
        or status.installed_version != CELLPOSE_PACKAGE_VERSION
        or not status.model_present
        or not status.model_verified
        or status.devices.get("cpu") is not True
    ):
        raise PermissionError("The verified local Cellpose-SAM v2 CPU runtime is unavailable")
    try:
        _cellpose_models, torch = _import_runtime()
    except Exception as exc:
        raise PermissionError(
            "The verified local Cellpose-SAM v2 CPU runtime could not be imported"
        ) from exc
    torch_version = _safe_version_string(getattr(torch, "__version__", None), "PyTorch version")
    contract = _cellpose_cpu_runtime_contract(CELLPOSE_PACKAGE_VERSION, torch_version)
    digest = hashlib.sha256(canonical_json(contract).encode()).hexdigest()
    host = runtime_record()
    host_pins = {
        key: _safe_version_string(host.get(key), f"Host {key} version")
        for key in _POLICY_RUNTIME_KEYS
    }
    model_pin = {
        "id": CELLPOSE_SAM_V2_SPEC.artifact_id,
        "sha256": CELLPOSE_SAM_V2_SPEC.sha256,
    }
    runtime_pin = {
        **host_pins,
        "backend": f"cellpose-cpu:{digest}",
        "resolved_device": "cpu",
    }
    return model_pin, runtime_pin


def cellpose_runtime_identity_from_record(runtime: Any) -> dict[str, str]:
    """Derive the policy runtime identity from a persisted Cellpose runtime record."""
    if not isinstance(runtime, dict):
        raise PermissionError("The result Cellpose runtime identity is outside the pinned policy")
    cellpose_info = runtime.get("cellpose")
    if (
        not isinstance(cellpose_info, dict)
        or cellpose_info.get("profile_id") != CELLPOSE_SAM_V2_SPEC.profile_id
        or cellpose_info.get("package") != {"name": "cellpose", "version": CELLPOSE_PACKAGE_VERSION}
        or cellpose_info.get("model")
        != {
            "artifact_id": CELLPOSE_SAM_V2_SPEC.artifact_id,
            "sha256": CELLPOSE_SAM_V2_SPEC.sha256,
        }
        or cellpose_info.get("requested_device") != "cpu"
        or cellpose_info.get("resolved_device") != "cpu"
        or cellpose_info.get("fallback_reason") is not None
    ):
        raise PermissionError("The result Cellpose runtime identity is outside the pinned policy")
    torch_version = _safe_version_string(runtime.get("torch_version"), "Result PyTorch version")
    host_source = runtime["engine"] if isinstance(runtime.get("engine"), dict) else runtime
    if not isinstance(host_source, dict):
        raise PermissionError("The result host runtime identity is invalid")
    host_pins = {
        key: _safe_version_string(host_source.get(key), f"Result {key} version")
        for key in _POLICY_RUNTIME_KEYS
    }
    contract = _cellpose_cpu_runtime_contract(CELLPOSE_PACKAGE_VERSION, torch_version)
    expected_backend = (
        f"cellpose-cpu:{hashlib.sha256(canonical_json(contract).encode()).hexdigest()}"
    )
    if "backend" in runtime and runtime.get("backend") != expected_backend:
        raise PermissionError("The result Cellpose backend contract hash disagrees")
    if "resolved_device" in runtime and runtime.get("resolved_device") != "cpu":
        raise PermissionError("The result Cellpose resolved device is outside CPU policy")
    return {
        **host_pins,
        "backend": expected_backend,
        "resolved_device": "cpu",
    }


def cellpose_result_pins(record: Any) -> tuple[dict[str, str], dict[str, str]]:
    """Extract and validate retained (model_pin, runtime_pin) for Cellpose results & children."""
    if not isinstance(record, dict) or not isinstance(record.get("provenance"), dict):
        raise PermissionError("Cellpose result provenance is invalid")
    provenance = record["provenance"]
    is_cellpose = (
        record.get("kind") == "cellpose-segmentation"
        or CELLPOSE_PROVENANCE_PREVIEW_KEY in provenance
        or (
            record.get("kind") == "corrected-labels"
            and isinstance(provenance.get("segmentation"), dict)
            and provenance["segmentation"].get("method") == "cellpose"
        )
    )
    if not is_cellpose:
        raise PermissionError("Result is not a verifiable Cellpose segmentation record")
    model = provenance.get("model")
    if not isinstance(model, dict) or not isinstance(model.get("profile"), dict):
        raise PermissionError("Cellpose result model provenance is invalid")
    profile_record = model["profile"]
    expected_model_artifact = {
        "format": "cellpose-native",
        "artifact_id": CELLPOSE_SAM_V2_SPEC.artifact_id,
        "sha256": CELLPOSE_SAM_V2_SPEC.sha256,
    }
    if (
        profile_record.get("id") != CELLPOSE_SAM_V2_SPEC.profile_id
        or profile_record.get("backend_kind") != "cellpose"
        or profile_record.get("version") != CELLPOSE_PACKAGE_VERSION
        or profile_record.get("model") != expected_model_artifact
    ):
        raise PermissionError(
            "Only the verified local Cellpose-SAM v2 checkpoint is supported for agent access"
        )
    for key in ("id", "artifact_id"):
        if key in model and model.get(key) != CELLPOSE_SAM_V2_SPEC.artifact_id:
            raise PermissionError("Cellpose result model identifier disagrees with profile")
    for key in ("sha256", "model_sha256", "package_sha256"):
        if key in model and model.get(key) != CELLPOSE_SAM_V2_SPEC.sha256:
            raise PermissionError("Cellpose result model digest disagrees with profile")
    runtime_pin = cellpose_runtime_identity_from_record(provenance.get("runtime"))
    model_pin = {
        "id": CELLPOSE_SAM_V2_SPEC.artifact_id,
        "sha256": CELLPOSE_SAM_V2_SPEC.sha256,
    }
    return model_pin, runtime_pin


def inspect_cellpose_model_status() -> dict[str, Any]:
    """Return path-free local Cellpose-SAM v2 checkpoint and CPU runtime readiness."""
    status = get_cellpose_status(CELLPOSE_SAM_V2_SPEC, inspect_devices=True)
    profile = resolve_profile(CELLPOSE_AGENT_PROFILE_ID, require_ready=False)
    runtime_pin: dict[str, str] | None = None
    ready = False
    code = status.code
    if status.ready:
        try:
            _model_pin, runtime_pin = installed_cellpose_pins()
            ready = True
        except PermissionError:
            code = "runtime-import-failed"
            ready = False
    summary = _SAFE_STATUS_SUMMARIES.get(
        code,
        "The local Cellpose-SAM v2 checkpoint or CPU runtime is unavailable.",
    )
    settings_contract = []
    for item in profile.settings_contract:
        entry = item.to_dict()
        if entry["key"] == "device":
            entry["choices"] = ["cpu"]
        settings_contract.append(entry)
    installed_ver = status.installed_version
    if installed_ver is not None:
        try:
            installed_ver = _safe_version_string(installed_ver, "Cellpose version")
        except PermissionError:
            installed_ver = None
    payload: dict[str, Any] = {
        "schema": CELLPOSE_MODEL_STATUS_SCHEMA,
        "profile_id": CELLPOSE_AGENT_PROFILE_ID,
        "ready": ready,
        "availability": {
            "code": code,
            "summary": summary,
        },
        "package": {
            "id": CELLPOSE_SAM_V2_SPEC.artifact_id,
            "name": "Cellpose-SAM v2 checkpoint (cpsam_v2)",
            "profile_id": CELLPOSE_AGENT_PROFILE_ID,
            "format": "cellpose-native",
            "version": CELLPOSE_PACKAGE_VERSION,
            "artifact_sha256": CELLPOSE_SAM_V2_SPEC.sha256,
            "package_sha256": CELLPOSE_SAM_V2_SPEC.sha256,
            "expected_size_bytes": CELLPOSE_SAM_V2_SPEC.size_bytes,
            "installed_version": installed_ver,
            "model_present": bool(status.model_present),
            "model_verified": bool(status.model_verified),
        },
        "model": {
            "id": CELLPOSE_SAM_V2_SPEC.artifact_id,
            "sha256": CELLPOSE_SAM_V2_SPEC.sha256,
        },
        "runtime": runtime_pin,
        "recommended_settings": CellposeSettings(device="cpu").to_dict(),
        "settings_contract": settings_contract,
        "default_working_bytes": CELLPOSE_DEFAULT_WORKING_BYTES,
        "rights": profile.rights.to_dict(),
        "validation": profile.validation.to_dict(),
        "adoption_requires_human_visual_review": True,
    }
    _validate_path_free_record(payload, location="cellpose_model_status")
    return payload


def _preview_overlay(
    image: np.ndarray,
    labels: np.ndarray,
    *,
    is_rgb: bool,
    source_channel: int,
) -> tuple[str, dict[str, Any]]:
    low, high = _display_bounds(image)
    overlay_rgb = render_overlay_rgb(image, labels, max_edge=2200)
    data_url = png_data_url(overlay_rgb)
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise RuntimeError("Cellpose preview renderer returned an invalid PNG payload")
    try:
        png = base64.b64decode(data_url.removeprefix(prefix), validate=True)
    except ValueError as exc:
        raise RuntimeError("Cellpose preview renderer returned invalid base64") from exc
    return data_url, {
        "purpose": "display-only-cellpose-preview; excluded from quantitative analysis",
        "source_mode": "interleaved-rgb" if is_rgb else "selected-source-channel",
        "source_channel": None if is_rgb else int(source_channel),
        "display_minimum": float(low),
        "display_maximum": float(high),
        "max_edge_px": 2200,
        "rendered_shape": [int(overlay_rgb.shape[0]), int(overlay_rgb.shape[1])],
        "label_overlay": "filled-labels-with-outer-boundaries",
        "boundary_mode": "outer",
        "boundary_color": "#29f5c9",
        "fill_colors": ["#14b89e", "#3b8ceb", "#f5a138"],
        "fill_alpha": 0.26,
        "png_sha256": hashlib.sha256(png).hexdigest(),
    }


def _validated_stored_preview(
    project: ResearchProject,
    preview_id: Any,
    preview_sha256: Any,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    checked_preview_id = checked_id(preview_id)
    if not _digest(preview_sha256):
        raise ValueError("Cellpose adoption requires an exact preview SHA-256")
    document = _preview_document(project, checked_preview_id)
    stored = document.get("data")
    if not isinstance(stored, dict) or stored.get("schema") != CELLPOSE_PREVIEW_SCHEMA:
        raise ValueError("Stored Cellpose preview is invalid")
    stored_hash = stored.get("preview_sha256")
    receipt = {key: value for key, value in stored.items() if key != "preview_sha256"}
    if not _digest(stored_hash) or stored_hash != _preview_hash(receipt):
        raise ValueError("Stored Cellpose preview failed integrity verification")
    if preview_sha256 != stored_hash:
        raise ValueError("Cellpose adoption must bind to the exact persisted preview")
    preview_job_id = receipt.get("preview_job_id")
    if preview_job_id is not None and checked_id(preview_job_id) != checked_preview_id:
        raise ValueError("Stored Cellpose preview job identity is inconsistent")
    return document, receipt, stored_hash


def _request_from_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    source = receipt.get("source")
    if not isinstance(source, dict):
        raise ValueError("Stored Cellpose preview source record is invalid")
    profile_id = receipt.get("profile_id")
    if profile_id != CELLPOSE_AGENT_PROFILE_ID:
        raise ValueError("Stored Cellpose preview profile is unsupported")
    settings = _settings(receipt.get("settings"))
    if settings.device != "cpu":
        raise ValueError("Cellpose preview adoption requires explicit CPU execution")
    selection = source.get("selection")
    if not isinstance(selection, dict) or set(selection) != _SELECTION_KEYS:
        raise ValueError("Stored Cellpose preview selection is invalid")
    working_bytes = integer(
        receipt.get("working_bytes"), "working_bytes", 1024**2, MAX_WORKING_BYTES
    )
    raw_channels = source.get("measurement_channels")
    if (
        not isinstance(raw_channels, list)
        or len(raw_channels) > 32
        or any(isinstance(ch, bool) or not isinstance(ch, int) or ch < 0 for ch in raw_channels)
        or len(set(raw_channels)) != len(raw_channels)
    ):
        raise ValueError("Stored Cellpose preview measurement channels are invalid")
    return {
        "source_id": checked_id(source.get("id")),
        "selection": {key: integer(selection[key], key, 0, 10_000_000) for key in _SELECTION_KEYS},
        "profile_id": profile_id,
        "settings": settings.to_dict(),
        "measurement_channels": list(raw_channels),
        "working_bytes": working_bytes,
    }


def cellpose_preview_request(
    workbench: Workbench,
    preview_id: Any,
    preview_sha256: Any,
) -> dict[str, Any]:
    """Verify a stored Cellpose preview receipt and return its normalized original request."""
    _document, receipt, _stored_hash = _validated_stored_preview(
        workbench.project, preview_id, preview_sha256
    )
    request = _request_from_receipt(receipt)
    declarations = workbench.channel_metadata(request["source_id"])
    _measurement_channels(request["measurement_channels"], len(declarations["channels"]))
    return request


def verify_cellpose_review_installation(workbench: Workbench, preview: dict[str, Any]) -> None:
    """Verify retained preview receipt against persisted doc, source, channels, and CPU runtime."""
    if not isinstance(preview, dict):
        raise ValueError("The retained Cellpose preview is invalid")
    document, receipt, _stored_hash = _validated_stored_preview(
        workbench.project,
        preview.get("id"),
        preview.get("preview_sha256"),
    )
    expected_envelope = {
        **document["data"],
        "id": document["id"],
        "updated_at": document["updated_at"],
        "revision": document["revision"],
    }
    if preview != expected_envelope:
        raise ValueError("The retained Cellpose preview no longer matches the persisted receipt")
    model_pin, runtime_pin = installed_cellpose_pins()
    package = receipt.get("package", {})
    if (
        not isinstance(package, dict)
        or package.get("id") != model_pin["id"]
        or package.get("package_sha256") != model_pin["sha256"]
        or package.get("artifact_sha256") != model_pin["sha256"]
        or package.get("version") != CELLPOSE_PACKAGE_VERSION
        or cellpose_runtime_identity_from_record(receipt.get("runtime")) != runtime_pin
    ):
        raise ValueError("The inspected Cellpose checkpoint or CPU runtime changed")
    source_rec = receipt["source"]
    current_source = workbench.project.source(checked_id(source_rec.get("id")), verify=True)
    if (
        current_source["sha256"] != source_rec.get("sha256")
        or current_source.get("source_kind", "native") != source_rec.get("source_kind")
        or current_source.get("metadata", {}).get("selected_series")
        != source_rec.get("selected_series")
        or current_source.get("metadata", {}).get("multiscale_index")
        != source_rec.get("multiscale_index")
    ):
        raise ValueError("Source or dataset identity changed after the Cellpose preview")
    declarations = workbench.channel_metadata(current_source["id"])
    if hashlib.sha256(canonical_json(declarations).encode()).hexdigest() != source_rec.get(
        "channel_metadata_sha256"
    ):
        raise ValueError("Channel declarations changed after the Cellpose preview")


def _prune_unadopted_cellpose_previews(
    project: ResearchProject, *, max_unadopted: int | None = None
) -> None:
    """Bound unreferenced Cellpose preview docs without evicting adopted or active previews."""
    limit = MAX_UNADOPTED_CELLPOSE_PREVIEWS if max_unadopted is None else max_unadopted
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "DELETE FROM documents WHERE kind='model_preview' "
            "AND json_extract(record, '$.data.schema')=? AND id IN ("
            "SELECT id FROM documents WHERE kind='model_preview' "
            "AND json_extract(record, '$.data.schema')=? AND id NOT IN ("
            "SELECT json_extract(record, '$.provenance.cellpose_preview.id') FROM results "
            "WHERE json_type(record, '$.provenance.cellpose_preview.id')='text' UNION "
            "SELECT json_extract(record, '$.request.task_request.preview_id') FROM jobs "
            "WHERE json_extract(record, '$.state') IN ('queued','running') "
            "AND json_extract(record, '$.operation')='cellpose_adopt' "
            "AND json_type(record, '$.request.task_request.preview_id')='text' UNION "
            "SELECT json_extract(value, '$.parameters_summary.preview_id') FROM metadata "
            "WHERE key LIKE 'agent-approval:%' "
            "AND json_extract(value, '$.state') IN ('pending','approved') "
            "AND json_type(value, '$.parameters_summary.preview_id')='text') "
            "ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
            (CELLPOSE_PREVIEW_SCHEMA, CELLPOSE_PREVIEW_SCHEMA, max(1, limit)),
        )


def _run_cellpose_core(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    require_v2_cpu: bool,
) -> dict[str, Any]:
    if not isinstance(request, dict) or set(request) != _REQUEST_KEYS:
        raise ValueError("Cellpose run requires one exact project-scoped request")
    source_id = checked_id(request["source_id"]) if require_v2_cpu else request["source_id"]
    selection_value = request["selection"]
    if not isinstance(selection_value, dict) or set(selection_value) != _SELECTION_KEYS:
        raise ValueError("Cellpose requires one fully resolved 2D source selection")
    working_bytes = integer(request["working_bytes"], "working_bytes", 1024**2, MAX_WORKING_BYTES)
    settings = _settings(request["settings"])
    if require_v2_cpu:
        if request["profile_id"] != CELLPOSE_AGENT_PROFILE_ID:
            raise ValueError("Cellpose preview supports only the cellpose-sam-v2 profile")
        if settings.device != "cpu":
            raise ValueError("Cellpose preview requires explicit CPU execution (device='cpu')")
        model_pin, runtime_pin = installed_cellpose_pins()
    else:
        model_pin = None
        runtime_pin = None

    profile: SegmentationProfile = resolve_profile(request["profile_id"], require_ready=True)
    if profile.backend_kind != "cellpose" or not isinstance(
        profile.recommended_settings, CellposeSettings
    ):
        raise ValueError("The selected profile is not a supported Cellpose profile")

    source = workbench.project.source(source_id, verify=True) if require_v2_cpu else None
    if source is not None and source.get("source_kind", "native") not in _ALLOWED_SOURCE_KINDS:
        raise ValueError("Cellpose preview requires a supported registered microscopy source")
    declarations = workbench.channel_metadata(source_id)
    channels = declarations["channels"]
    measurement_channels = _measurement_channels(request["measurement_channels"], len(channels))
    image, geometry, selection = workbench.load_scalar(
        source_id,
        selection_value,
        working_bytes=working_bytes,
        allow_rgb=True,
    )
    is_rgb = image.ndim == 3 and image.shape[-1] in {3, 4}
    if image.ndim != 2 and not is_rgb:
        raise ValueError("Cellpose requires one 2D scalar or interleaved RGB plane")
    if is_rgb and (selection["c"] != 0 or measurement_channels):
        raise ValueError(
            "RGB samples are one interleaved image and cannot be treated as biological channels"
        )
    if require_v2_cpu:
        if geometry.axes != "YX":
            raise ValueError("Cellpose preview requires an explicit 2D YX source plane")
        if {key: selection.get(key) for key in _SELECTION_KEYS} != selection_value:
            raise ValueError("Cellpose selection did not resolve to the exact requested 2D grid")

    selected_pixels = int(image.shape[0] * image.shape[1])
    # Retained inputs include the inference plane, normalized and label grids,
    # measurement workspaces, and every requested raw channel. This check is
    # deliberately performed before model execution so individually bounded
    # channel reads cannot accumulate beyond the caller's aggregate budget.
    aggregate_required_bytes = int(image.nbytes) + selected_pixels * (
        160 + 8 * len(measurement_channels)
    )
    if aggregate_required_bytes > working_bytes:
        raise ValueError(
            "Cellpose source and raw measurement channels require "
            f"{aggregate_required_bytes} bytes, exceeding the aggregate "
            f"working-memory budget of {working_bytes} bytes; "
            "choose a smaller crop, fewer channels, or select a larger allowance"
        )

    from .cellpose_backend import segment_cellpose

    inference = segment_cellpose(image, settings, profile.id, working_bytes=working_bytes)
    inference_runtime = dict(inference.runtime)
    expected_model = profile.model.to_dict()
    if (
        inference_runtime.get("profile_id") != profile.id
        or inference_runtime.get("model")
        != {
            "artifact_id": expected_model["artifact_id"],
            "sha256": expected_model["sha256"],
        }
        or inference_runtime.get("requested_device") != settings.device
    ):
        raise ValueError("Cellpose runtime identity disagrees with the accepted request")
    if require_v2_cpu and (
        inference_runtime.get("resolved_device") != "cpu"
        or inference_runtime.get("fallback_reason") is not None
    ):
        raise ValueError("Cellpose preview execution deviated from the pinned CPU runtime")
    labels, normalized = _validated_labels(inference, tuple(image.shape[:2]))

    raw_channels: dict[str, np.ndarray] = {}
    for channel in measurement_channels:
        raw, raw_geometry, raw_selection = workbench.load_scalar(
            source_id,
            {**selection, "c": channel},
            strict=require_v2_cpu,
            working_bytes=working_bytes,
        )
        if raw.ndim != 2 or raw.shape != labels.shape or raw_geometry != geometry:
            raise ValueError("A raw measurement channel disagrees with the Cellpose label grid")
        if raw_selection != {**selection, "c": channel}:
            raise ValueError("A Cellpose measurement selection was not resolved exactly")
        raw_channels[f"source_channel_{channel}"] = raw
    measurements = measure_objects(
        labels,
        geometry,
        raw_channels,
        working_bytes=working_bytes,
    )

    if require_v2_cpu:
        assert source is not None
        current_source = workbench.project.source(source_id, verify=True)
        if (
            current_source["sha256"] != source["sha256"]
            or current_source.get("source_kind", "native") != source.get("source_kind", "native")
            or current_source.get("metadata", {}).get("selected_series")
            != source.get("metadata", {}).get("selected_series")
            or current_source.get("metadata", {}).get("multiscale_index")
            != source.get("metadata", {}).get("multiscale_index")
        ):
            raise ValueError("Source changed during Cellpose execution")
        if workbench.channel_metadata(source_id) != declarations:
            raise ValueError("Channel declarations changed during Cellpose execution")
        if installed_cellpose_pins() != (model_pin, runtime_pin):
            raise ValueError("Installed Cellpose checkpoint or CPU runtime changed during run")

    input_mapping: dict[str, Any] = (
        {"mode": "interleaved-rgb-samples"}
        if is_rgb
        else {"mode": "source-channel", "channel": selection["c"]}
    )
    accepted_request = {
        "source_id": source_id,
        "selection": selection,
        "input_mapping": input_mapping,
        "profile_id": profile.id,
        "settings": settings.to_dict(),
        "measurement_channels": measurement_channels,
        "working_bytes": working_bytes,
    }
    resource_guard = {
        "working_memory_limit_bytes": working_bytes,
        "aggregate_required_bytes": aggregate_required_bytes,
        "aggregate_estimate_policy": (
            "input-bytes-plus-160B-per-source-pixel-plus-8B-per-raw-channel-pixel/v1"
        ),
        "selected_source_pixels": selected_pixels,
        "cellpose_memory_preflight": inference_runtime.get("memory_preflight"),
    }
    return {
        "source_id": source_id,
        "source": source,
        "image": image,
        "is_rgb": is_rgb,
        "geometry": geometry,
        "selection": selection,
        "settings": settings,
        "profile": profile,
        "declarations": declarations,
        "measurement_channels": measurement_channels,
        "raw_channels": raw_channels,
        "inference_runtime": inference_runtime,
        "labels": labels,
        "normalized": normalized,
        "measurements": measurements,
        "input_mapping": input_mapping,
        "accepted_request": accepted_request,
        "resource_guard": resource_guard,
        "working_bytes": working_bytes,
        "model_pin": model_pin,
        "runtime_pin": runtime_pin,
    }


def _compute_preview_bundle(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    preview_job_id: str | None,
) -> dict[str, Any]:
    computed = _run_cellpose_core(workbench, request, require_v2_cpu=True)
    source = computed["source"]
    assert source is not None
    model_pin = computed["model_pin"]
    runtime_pin = computed["runtime_pin"]
    assert model_pin is not None and runtime_pin is not None
    profile: SegmentationProfile = computed["profile"]
    selection = {key: int(computed["selection"][key]) for key in _SELECTION_KEYS}
    overlay_url, display_record = _preview_overlay(
        computed["image"],
        computed["labels"],
        is_rgb=computed["is_rgb"],
        source_channel=selection["c"],
    )
    _cellpose_models, torch = _import_runtime()
    torch_version = _safe_version_string(getattr(torch, "__version__", None), "PyTorch version")
    python_version = _safe_version_string(platform.python_version(), "Python version")
    inference_runtime = copy.deepcopy(computed["inference_runtime"])
    _validate_path_free_record(inference_runtime, location="cellpose_inference_runtime")
    runtime_record_payload: dict[str, Any] = {
        **runtime_pin,
        "requested_device": "cpu",
        "cellpose_version": CELLPOSE_PACKAGE_VERSION,
        "model_sha256": model_pin["sha256"],
        "torch_version": torch_version,
        "python_version": python_version,
        "cellpose": inference_runtime,
    }
    if cellpose_runtime_identity_from_record(runtime_record_payload) != runtime_pin:
        raise ValueError("Cellpose runtime attestation failed internal consistency check")

    declarations = computed["declarations"]
    channel_metadata_sha256 = hashlib.sha256(canonical_json(declarations).encode()).hexdigest()
    raw_channel_hashes = {
        name: _array_sha256(array) for name, array in computed["raw_channels"].items()
    }
    labels = computed["labels"]
    normalized = computed["normalized"]
    measurements = computed["measurements"]
    receipt: dict[str, Any] = {
        "schema": CELLPOSE_PREVIEW_SCHEMA,
        "engine_version": ENGINE_VERSION,
        "preview_job_id": checked_id(preview_job_id) if preview_job_id is not None else None,
        "profile_id": profile.id,
        "package": {
            "id": model_pin["id"],
            "name": "Cellpose-SAM v2 checkpoint (cpsam_v2)",
            "profile_id": profile.id,
            "format": "cellpose-native",
            "version": CELLPOSE_PACKAGE_VERSION,
            "artifact_sha256": model_pin["sha256"],
            "package_sha256": model_pin["sha256"],
        },
        "source": {
            "id": computed["source_id"],
            "sha256": source["sha256"],
            "source_kind": source.get("source_kind", "native"),
            "selected_series": source.get("metadata", {}).get("selected_series"),
            "multiscale_index": source.get("metadata", {}).get("multiscale_index"),
            "selection": selection,
            "input_mapping": computed["input_mapping"],
            "input_sha256": _array_sha256(computed["image"]),
            "measurement_channels": computed["measurement_channels"],
            "raw_channel_sha256s": raw_channel_hashes,
            "channel_metadata_sha256": channel_metadata_sha256,
            "geometry": _geometry_record(computed["geometry"]),
            "display": display_record,
        },
        "settings": computed["settings"].to_dict(),
        "working_bytes": computed["working_bytes"],
        "runtime": runtime_record_payload,
        "resource_guard": computed["resource_guard"],
        "output": {
            "labels_axes": "YX",
            "labels_shape": list(labels.shape),
            "labels_dtype": str(labels.dtype),
            "labels_sha256": _array_sha256(labels),
            "normalized_axes": "YX",
            "normalized_shape": list(normalized.shape),
            "normalized_dtype": str(normalized.dtype),
            "normalized_sha256": _array_sha256(normalized),
            "object_count": len(measurements),
            "measurements_sha256": hashlib.sha256(
                canonical_json(measurements).encode()
            ).hexdigest(),
        },
        "scientific_validation": profile.validation.to_dict(),
        "rights": {
            "supplier_declarations": profile.rights.to_dict(),
            "review_state": "independent-rights-review-required",
        },
        "meaning": "technical preview; not biological or clinical validation",
    }
    _validate_path_free_record(receipt, location="cellpose_preview_receipt")
    return {
        **computed,
        "receipt": receipt,
        "overlay_url": overlay_url,
        "channel_metadata_sha256": channel_metadata_sha256,
    }


def preview_cellpose(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Preview local 2D Cellpose-SAM v2 on CPU without publishing any scientific result."""
    if publication_guard is not None:
        publication_guard()
    checked_job_id = checked_id(job_id) if job_id is not None else None
    bundle = _compute_preview_bundle(workbench, request, preview_job_id=checked_job_id)
    receipt = bundle["receipt"]
    digest = _preview_hash(receipt)
    preview_id = checked_job_id if checked_job_id is not None else uuid.uuid4().hex

    def preview_guard() -> None:
        if publication_guard is not None:
            publication_guard()
        if checked_job_id is not None:
            current_job = workbench.project.job(checked_job_id)
            if current_job["state"] != "running" or current_job["cancel_requested"]:
                raise ValueError("The Cellpose preview job was cancelled before publication")

    document = workbench.project.put_document(
        CELLPOSE_PREVIEW_DOC_KIND,
        preview_id,
        {**receipt, "preview_sha256": digest},
        expected_revision=0,
        publication_guard=preview_guard,
    )
    _prune_unadopted_cellpose_previews(workbench.project)
    measurements = bundle["measurements"]
    summary = {
        "preview_id": preview_id,
        "preview_sha256": digest,
        "source_id": receipt["source"]["id"],
        "source_sha256": receipt["source"]["sha256"],
        "selection": receipt["source"]["selection"],
        "input_mapping": receipt["source"]["input_mapping"],
        "measurement_channels": receipt["source"]["measurement_channels"],
        "profile_id": receipt["profile_id"],
        "package_id": receipt["package"]["id"],
        "package_version": receipt["package"]["version"],
        "package_sha256": receipt["package"]["package_sha256"],
        "resolved_device": "cpu",
        "object_count": len(measurements),
        "overlay_png_sha256": receipt["source"]["display"]["png_sha256"],
        "adopted": False,
        "next_action": (
            "Inspect overlay_png in Loci and approve exact adoption with "
            "cellpose_adopt({preview_id, preview_sha256})."
        ),
    }
    _validate_path_free_record(summary, location="cellpose_preview_summary")
    return {
        "preview": {
            "id": preview_id,
            "revision": document["revision"],
            "updated_at": document["updated_at"],
            **document["data"],
        },
        "summary": summary,
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "overlay_png": bundle["overlay_url"],
        "adopted": False,
    }


def adopt_cellpose(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Recompute, verify exact output parity, and adopt a persisted Cellpose preview."""
    exact_keys(request, {"preview_id", "preview_sha256"}, "cellpose adopt")
    document, receipt, stored_hash = _validated_stored_preview(
        workbench.project,
        request.get("preview_id"),
        request.get("preview_sha256"),
    )
    preview_id = document["id"]
    with workbench.project.connection() as connection:
        if connection.execute(
            "SELECT 1 FROM results "
            "WHERE json_extract(record, '$.provenance.cellpose_preview.id')=? LIMIT 1",
            (preview_id,),
        ).fetchone():
            raise ValueError("This Cellpose preview has already been adopted as a saved result")
    if publication_guard is not None:
        publication_guard()

    original_request = _request_from_receipt(receipt)
    bundle = _compute_preview_bundle(
        workbench,
        original_request,
        preview_job_id=receipt.get("preview_job_id"),
    )
    candidate_receipt = bundle["receipt"]
    labels = bundle["labels"]
    normalized = bundle["normalized"]
    measurements = bundle["measurements"]
    if (
        canonical_json(candidate_receipt) != canonical_json(receipt)
        or _preview_hash(candidate_receipt) != stored_hash
        or _array_sha256(labels) != receipt["output"]["labels_sha256"]
        or _array_sha256(normalized) != receipt["output"]["normalized_sha256"]
        or len(measurements) != receipt["output"]["object_count"]
        or hashlib.sha256(canonical_json(measurements).encode()).hexdigest()
        != receipt["output"]["measurements_sha256"]
    ):
        raise ValueError(
            "Source, dataset, channels, model, runtime, settings, or output changed after "
            "Cellpose preview"
        )

    source_id = receipt["source"]["id"]
    declarations = bundle["declarations"]
    if (
        hashlib.sha256(canonical_json(declarations).encode()).hexdigest()
        != receipt["source"]["channel_metadata_sha256"]
    ):
        raise ValueError("Channel declarations changed after the Cellpose preview")

    is_rgb = receipt["source"]["input_mapping"]["mode"] == "interleaved-rgb-samples"
    measurement_channels = receipt["source"]["measurement_channels"]
    retained_indices = (
        [] if is_rgb else sorted({int(receipt["source"]["selection"]["c"]), *measurement_channels})
    )
    scoped_channel_metadata = {
        "scope": "selected-channels",
        "channel_metadata_sha256": receipt["source"]["channel_metadata_sha256"],
        "revision": declarations["revision"],
        "channels": [copy.deepcopy(declarations["channels"][idx]) for idx in retained_indices],
        "basis": declarations["basis"],
    }
    profile: SegmentationProfile = bundle["profile"]
    model_pin = bundle["model_pin"]
    runtime_pin = bundle["runtime_pin"]
    assert model_pin is not None and runtime_pin is not None
    segmentation = {
        "method": "cellpose",
        "dimensions": 2,
        "count": len(measurements),
        "scientific_validation": "unvalidated-research-method",
    }
    provenance: dict[str, Any] = {
        "geometry": receipt["source"]["geometry"],
        "selection": receipt["source"]["selection"],
        "accepted_request": bundle["accepted_request"],
        CELLPOSE_PROVENANCE_PREVIEW_KEY: {
            "id": preview_id,
            "revision": document["revision"],
            "sha256": stored_hash,
            "source_kind": receipt["source"]["source_kind"],
            "selected_series": receipt["source"]["selected_series"],
            "multiscale_index": receipt["source"]["multiscale_index"],
            "input_mapping": receipt["source"]["input_mapping"],
            "input_sha256": receipt["source"]["input_sha256"],
            "raw_channel_sha256s": receipt["source"]["raw_channel_sha256s"],
            "channel_metadata_sha256": receipt["source"]["channel_metadata_sha256"],
            "labels_sha256": receipt["output"]["labels_sha256"],
            "normalized_sha256": receipt["output"]["normalized_sha256"],
            "measurements_sha256": receipt["output"]["measurements_sha256"],
        },
        "profile": profile.provenance_dict(),
        "settings": receipt["settings"],
        "segmentation": segmentation,
        "measurements": measurements,
        "measurement_channels": measurement_channels,
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "channel_metadata": scoped_channel_metadata,
        "runtime": receipt["runtime"],
        "resource_guard": receipt["resource_guard"],
        "model": {
            "id": model_pin["id"],
            "artifact_id": model_pin["id"],
            "version": CELLPOSE_PACKAGE_VERSION,
            "sha256": model_pin["sha256"],
            "model_sha256": model_pin["sha256"],
            "package_sha256": model_pin["sha256"],
            "profile": profile.provenance_dict(),
            "rights": profile.rights.to_dict(),
            "validation": profile.validation.to_dict(),
        },
    }
    if job_id is not None:
        provenance["job_id"] = job_id

    def adopt_guard() -> None:
        with workbench.project.connection() as connection:
            if connection.execute(
                "SELECT 1 FROM results "
                "WHERE json_extract(record, '$.provenance.cellpose_preview.id')=? LIMIT 1",
                (preview_id,),
            ).fetchone():
                raise ValueError("This Cellpose preview has already been adopted as a saved result")
        if publication_guard is not None:
            publication_guard()
        if _preview_document(workbench.project, preview_id) != document:
            raise ValueError("Cellpose preview changed before result publication")
        if workbench.channel_metadata(source_id) != declarations:
            raise ValueError("Channel declarations changed before Cellpose result publication")
        if installed_cellpose_pins() != (model_pin, runtime_pin):
            raise ValueError(
                "Installed Cellpose checkpoint or CPU runtime changed before result publication"
            )
        current_source = workbench.project.source(source_id, verify=True)
        if (
            current_source["sha256"] != receipt["source"]["sha256"]
            or current_source.get("source_kind", "native") != receipt["source"]["source_kind"]
            or current_source.get("metadata", {}).get("selected_series")
            != receipt["source"]["selected_series"]
            or current_source.get("metadata", {}).get("multiscale_index")
            != receipt["source"]["multiscale_index"]
        ):
            raise ValueError("Source changed before Cellpose result publication")

    adopt_guard()
    result = workbench.project.save_result(
        source_id=source_id,
        kind="cellpose-segmentation",
        arrays={"image": normalized, "labels": labels},
        provenance=provenance,
        job_id=job_id,
        publication_guard=adopt_guard,
    )
    return {
        "result": {
            **result_summary(result),
            "preview_id": preview_id,
            "preview_sha256": stored_hash,
        },
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def execute_cellpose(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Any = None,
) -> dict[str, Any]:
    """Run one explicitly selected 2D plane with an already provisioned profile."""

    computed = _run_cellpose_core(workbench, request, require_v2_cpu=False)
    profile: SegmentationProfile = computed["profile"]
    measurements = computed["measurements"]
    engine_runtime = runtime_record()
    runtime: dict[str, Any] = {
        "engine": engine_runtime,
        "cellpose": computed["inference_runtime"],
        "python_version": platform.python_version(),
    }
    try:
        import torch

        runtime.update(
            torch_version=str(torch.__version__),
            cuda_runtime=(str(torch.version.cuda) if torch.version.cuda is not None else None),
            cudnn_version=torch.backends.cudnn.version(),
        )
    except (AttributeError, ImportError, RuntimeError):
        # Successful inference already records the verified Cellpose package,
        # checkpoint and resolved device. Optional accelerator diagnostics do
        # not change or invalidate those exact execution facts.
        runtime.update(torch_version=None, cuda_runtime=None, cudnn_version=None)
    segmentation = {
        "method": "cellpose",
        "dimensions": 2,
        "count": len(measurements),
        "scientific_validation": "unvalidated-research-method",
    }
    provenance = {
        "geometry": computed["geometry"].to_dict(),
        "selection": computed["selection"],
        "accepted_request": computed["accepted_request"],
        "profile": profile.provenance_dict(),
        "settings": computed["settings"].to_dict(),
        "segmentation": segmentation,
        "measurements": measurements,
        "measurement_channels": computed["measurement_channels"],
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "channel_metadata": computed["declarations"],
        "runtime": runtime,
        "resource_guard": computed["resource_guard"],
        "model": {
            "profile": profile.provenance_dict(),
            "rights": profile.rights.to_dict(),
            "validation": profile.validation.to_dict(),
        },
    }
    if job_id is not None:
        provenance["job_id"] = job_id
    result = workbench.project.save_result(
        source_id=computed["source_id"],
        kind="cellpose-segmentation",
        arrays={"image": computed["normalized"], "labels": computed["labels"]},
        provenance=provenance,
        job_id=job_id,
        publication_guard=publication_guard,
    )
    return {
        "result": result_summary(result),
        "measurements": measurements[:1000],
        "accepted_request": computed["accepted_request"],
        "profile": profile.to_dict(),
    }


def execute_cellpose_operation(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Dispatch local Cellpose status, preview, exact adoption, and legacy direct run."""
    if operation not in CELLPOSE_OPERATIONS or not isinstance(request, dict):
        raise ValueError("Unknown or invalid Cellpose operation")
    if operation == "cellpose_model_status":
        exact_keys(request, set(), "cellpose model status")
        return inspect_cellpose_model_status()
    if operation == "cellpose_preview":
        return preview_cellpose(
            workbench, request, job_id=job_id, publication_guard=publication_guard
        )
    if operation == "cellpose_adopt":
        return adopt_cellpose(
            workbench, request, job_id=job_id, publication_guard=publication_guard
        )
    return execute_cellpose(workbench, request, job_id=job_id, publication_guard=publication_guard)
