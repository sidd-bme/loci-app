"""Project-scoped model import, preview, and exact-preview adoption workflows.

Only the trusted local import function accepts a filesystem path.  All other
operations resolve a strict project-managed model identity and use Workbench
source selection, verification, and artifact publication boundaries.
"""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import stat
import uuid
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

import numpy as np

from .model_packages import (
    DEFAULT_WORKING_BYTES,
    ModelPackage,
    import_model_package,
    inspect_model_package,
    preview_inference,
    run_inference,
)
from .models import ENGINE_VERSION
from .quantitative import (
    Geometry,
    exact_keys,
    finite_number,
    integer,
    measure_objects,
    segment_scalar,
)
from .render import render_overlay
from .research_project import ResearchProject, canonical_json, checked_id
from .workbench import Workbench, display_scalar

MODEL_SCHEMA = "loci.managed-model/v1"
PREVIEW_SCHEMA = "loci.model-preview/v1"
MODEL_OPERATIONS = frozenset({"model_list", "model_preview", "model_run"})
_MAX_CHANNELS = 32
_MODEL_COMMON_KEYS = {
    "schema",
    "package",
    "reference_qualification",
    "import_working_bytes",
}
_MODEL_READY_KEYS = _MODEL_COMMON_KEYS | {"private_path"}
_MODEL_RECOVERY_KEYS = _MODEL_COMMON_KEYS | {"interchange_state", "recovery"}
_PACKAGE_PUBLIC_KEYS = {
    "schema_version",
    "source_format",
    "id",
    "version",
    "task",
    "model",
    "input",
    "output",
    "preprocessing",
    "tiling",
    "postprocessing",
    "labels",
    "reference",
    "citations",
    "rights",
    "validation",
    "metadata_sha256",
    "package_sha256",
    "files",
}
_REFERENCE_KEYS = {"compatible", "package", "runtime", "comparison", "meaning"}
_RECOVERY_STATE = "model-package-not-included"
_RECOVERY_ACTION = "reimport-the-exact-declared-package-before-use"


def _models_root(project: ResearchProject, *, create: bool) -> Path:
    # Opening a connection rechecks the study directory and database identities.
    with project.connection():
        pass
    root = project.root / "models"
    if not root.exists() and not root.is_symlink():
        if not create:
            return root
        with suppress(FileExistsError):
            root.mkdir(mode=0o700)
    details = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(details.st_mode):
        raise ValueError("Project model storage must be a plain directory")
    if os.name == "posix" and stat.S_IMODE(details.st_mode) != 0o700:
        raise ValueError("Project model storage permissions must be 0700")
    if root.resolve(strict=True).parent != project.root:
        raise ValueError("Project model storage escaped the study")
    return root


def _document(project: ResearchProject, kind: str, document_id: str) -> dict[str, Any]:
    checked_id(document_id)
    matches = [item for item in project.documents(kind) if item.get("id") == document_id]
    if len(matches) != 1:
        raise ValueError(f"{kind.replace('_', ' ').title()} is not part of this study")
    return matches[0]


def _model_id(package: ModelPackage) -> str:
    identity = {
        "schema": MODEL_SCHEMA,
        "package_id": package.id,
        "version": package.version,
        "package_sha256": package.package_sha256,
    }
    return hashlib.sha256(canonical_json(identity).encode()).hexdigest()[:32]


def _model_id_from_record(package: dict[str, Any]) -> str:
    identity = {
        "schema": MODEL_SCHEMA,
        "package_id": package["id"],
        "version": package["version"],
        "package_sha256": package["package_sha256"],
    }
    return hashlib.sha256(canonical_json(identity).encode()).hexdigest()[:32]


def _digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _validated_model_data(document: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Validate both locally ready and path-free recoverable model envelopes."""

    data = document.get("data")
    if not isinstance(data, dict):
        raise ValueError("Stored model record is invalid")
    keys = set(data)
    if keys == _MODEL_READY_KEYS:
        state = "ready"
    elif keys == _MODEL_RECOVERY_KEYS:
        state = "reimport-required"
        if (
            data.get("interchange_state") != _RECOVERY_STATE
            or data.get("recovery") != _RECOVERY_ACTION
        ):
            raise ValueError("Stored recoverable model state is invalid")
    else:
        raise ValueError("Stored model record is invalid")
    if data.get("schema") != MODEL_SCHEMA:
        raise ValueError("Stored model schema is unsupported")
    package = data.get("package")
    if not isinstance(package, dict) or set(package) != _PACKAGE_PUBLIC_KEYS:
        raise ValueError("Stored model package record is invalid")
    if (
        package.get("schema_version") != "loci.model-package/1"
        or package.get("task") != "semantic-segmentation"
        or not isinstance(package.get("id"), str)
        or not package["id"]
        or len(package["id"]) > 80
        or not isinstance(package.get("version"), str)
        or not package["version"]
        or len(package["version"]) > 80
        or not _digest(package.get("package_sha256"))
        or not _digest(package.get("metadata_sha256"))
        or not isinstance(package.get("model"), dict)
        or not _digest(package["model"].get("sha256"))
        or not isinstance(package.get("rights"), dict)
        or not isinstance(package.get("validation"), dict)
        or _model_id_from_record(package) != document.get("id")
    ):
        raise ValueError("Stored model package identity is invalid")
    qualification = data.get("reference_qualification")
    if not isinstance(qualification, dict) or set(qualification) != _REFERENCE_KEYS:
        raise ValueError("Stored model reference qualification is invalid")
    runtime = qualification.get("runtime")
    comparison = qualification.get("comparison")
    if (
        qualification.get("compatible") is not True
        or qualification.get("package") != package
        or qualification.get("meaning")
        != "technical compatibility; not scientific or clinical validation"
        or not isinstance(runtime, dict)
        or runtime.get("package_sha256") != package["package_sha256"]
        or runtime.get("metadata_sha256") != package["metadata_sha256"]
        or runtime.get("model_sha256") != package["model"]["sha256"]
        or not isinstance(comparison, dict)
        or isinstance(comparison.get("mismatched_elements"), bool)
        or not isinstance(comparison.get("mismatched_elements"), int)
        or comparison["mismatched_elements"] < 0
    ):
        raise ValueError("Stored model reference qualification is inconsistent")
    integer(data.get("import_working_bytes"), "import_working_bytes", 1024**2, 8 * 1024**3)
    return data, state


def _path_free_model(document: dict[str, Any]) -> dict[str, Any]:
    data, state = _validated_model_data(document)
    ready = state == "ready"
    return {
        "model_id": document["id"],
        "revision": document["revision"],
        "updated_at": document["updated_at"],
        "schema": data["schema"],
        "package": data["package"],
        "reference_qualification": data["reference_qualification"],
        "import_working_bytes": data["import_working_bytes"],
        "availability": {
            "state": state,
            "summary": (
                "The exact project-managed package is available."
                if ready
                else "Re-import the exact declared package to rerun its reference qualification."
            ),
            "recovery": None if ready else _RECOVERY_ACTION,
        },
        "technical_compatibility": (
            "reference-qualified on the recorded CPU runtime"
            if ready
            else "historical qualification only; exact package re-import and rerun required"
        ),
        "scientific_validation": data["package"]["validation"],
        "usage_rights": {
            "supplier_declarations": data["package"]["rights"],
            "review_state": "independent-rights-review-required",
        },
    }


def _managed_package(workbench: Workbench, model_id: str) -> tuple[dict[str, Any], ModelPackage]:
    document = _document(workbench.project, "model", model_id)
    data, state = _validated_model_data(document)
    if state == "reimport-required":
        raise ValueError(
            "Model package is unavailable after study interchange; re-import the exact "
            "declared package before previewing or running it"
        )
    root = _models_root(workbench.project, create=False)
    path_value = data["private_path"]
    if not isinstance(path_value, str):
        raise ValueError("Stored model locator is invalid")
    path = Path(path_value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or not path.is_dir()
        or path.resolve(strict=True).parent != root
    ):
        raise ValueError("Stored model escaped project-managed storage")
    package = inspect_model_package(path)
    stored_package = data["package"]
    if (
        not isinstance(stored_package, dict)
        or package.public_record() != stored_package
        or _model_id(package) != model_id
    ):
        raise ValueError("Stored model package identity changed")
    return document, package


def import_model(
    workbench: Workbench,
    path: str | Path,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    recovery_model_id: str | None = None,
) -> dict[str, Any]:
    """Qualify and atomically adopt one explicitly selected local package."""
    integer(working_bytes, "working_bytes", 1024**2, 8 * 1024**3)
    candidate = inspect_model_package(path)
    candidate_id = _model_id(candidate)
    if recovery_model_id is not None and checked_id(recovery_model_id) != candidate_id:
        raise ValueError("Re-import must select the exact package declared by this model")
    existing_models = workbench.project.documents("model")
    existing_candidate: dict[str, Any] | None = None
    for item in existing_models:
        data, state = _validated_model_data(item)
        if item["id"] == candidate_id:
            existing_candidate = item
        if (
            state == "reimport-required"
            and item["id"] == candidate_id
            and data["package"] != candidate.public_record()
        ):
            raise ValueError("Selected package differs from the recoverable model declaration")
    if recovery_model_id is not None and existing_candidate is None:
        raise ValueError("The selected recovery model is not part of this study")
    if existing_candidate is not None:
        _data, existing_state = _validated_model_data(existing_candidate)
        if existing_state != "reimport-required":
            raise ValueError("This exact model package is already managed by the study")

    managed_root = _models_root(workbench.project, create=True)
    adopted: ModelPackage | None = None
    try:
        adopted, qualification = import_model_package(
            path, managed_root, working_bytes=working_bytes
        )
        if (
            adopted.public_record() != candidate.public_record()
            or _model_id(adopted) != candidate_id
        ):
            raise ValueError("Selected model package changed during import")
        expected_revision = 0
        if existing_candidate is not None:
            stored_data, state = _validated_model_data(existing_candidate)
            if state != "reimport-required" or stored_data["package"] != adopted.public_record():
                raise ValueError("Recoverable model declaration changed during import")
            expected_revision = existing_candidate["revision"]
        document = workbench.project.put_document(
            "model",
            candidate_id,
            {
                "schema": MODEL_SCHEMA,
                "private_path": str(adopted.root),
                "package": adopted.public_record(),
                "reference_qualification": qualification.to_dict(),
                "import_working_bytes": working_bytes,
            },
            expected_revision=expected_revision,
        )
    except BaseException:
        # Only roll back the exact directory this call successfully imported.
        if (
            adopted is not None
            and adopted.root.parent == managed_root
            and adopted.root.is_dir()
            and not adopted.root.is_symlink()
        ):
            shutil.rmtree(adopted.root)
        raise
    return _path_free_model(document)


def _checked_mapping(package: ModelPackage, value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) != len(package.input.channels):
        raise ValueError("Channel mapping must explicitly map every model input channel")
    mapping = []
    for index, ((name, slot), raw) in enumerate(zip(package.input.channels, value, strict=True)):
        exact_keys(raw, {"model_input_index", "model_channel", "source_channel"}, "mapping")
        if raw.get("model_input_index") != index or raw.get("model_channel") != name:
            raise ValueError("Channel mapping must match model input order and names exactly")
        mapping.append(
            {
                "model_input_index": index,
                "model_channel": name,
                "package_source_slot": slot,
                "source_channel": integer(raw.get("source_channel"), "source channel", 0, 255),
            }
        )
    return mapping


def _checked_measurement_channels(value: Any) -> list[int]:
    if not isinstance(value, list) or not 1 <= len(value) <= _MAX_CHANNELS:
        raise ValueError("Measurement channels must be a list of 1-32 source channel indices")
    channels = [integer(item, "measurement channel", 0, 255) for item in value]
    if channels != sorted(set(channels)):
        raise ValueError("Measurement channels must be sorted and unique")
    return channels


def _scale_record(
    package: ModelPackage, geometry: Geometry, value: Any
) -> tuple[tuple[float, float], str, dict[str, Any]]:
    actual_scale = geometry.orthogonal_spacing()
    if geometry.axes != "YX" or len(actual_scale) != 2:
        raise ValueError("Model inference requires one explicit two-dimensional source plane")
    actual = {"scale_yx": list(actual_scale), "scale_unit": geometry.unit}
    if not isinstance(value, dict) or value.get("mode") not in {"source", "override"}:
        raise ValueError("Scale must explicitly use source or override mode")
    if value["mode"] == "source":
        exact_keys(value, {"mode"}, "source scale")
        used_scale, used_unit = actual_scale, geometry.unit
        declaration = None
    else:
        exact_keys(
            value,
            {"mode", "scale_yx", "scale_unit", "declaration"},
            "scale override",
        )
        scale = value.get("scale_yx")
        if not isinstance(scale, list) or len(scale) != 2:
            raise ValueError("Scale override requires explicit Y and X values")
        used_scale = tuple(finite_number(item, "scale override", 1e-12, 1e12) for item in scale)
        used_unit = value.get("scale_unit")
        if not isinstance(used_unit, str) or used_unit not in {"pixel", "nm", "um", "mm", "m"}:
            raise ValueError("Scale override unit is unsupported")
        declaration = value.get("declaration")
        if (
            not isinstance(declaration, str)
            or not declaration.strip()
            or len(declaration) > 2048
            or any(ord(character) < 32 and character not in "\n\t" for character in declaration)
        ):
            raise ValueError("Scale override requires a bounded non-empty declaration")
    if used_scale != package.input.scale_yx or used_unit != package.input.scale_unit:
        raise ValueError(
            "Used source scale must exactly equal the model contract; "
            "implicit resampling is forbidden"
        )
    return (
        used_scale,
        used_unit,
        {
            "mode": value["mode"],
            "source_geometry": actual,
            "model_input": {"scale_yx": list(used_scale), "scale_unit": used_unit},
            "override_declaration": declaration,
            "override_scope": "model-input-compatibility-only",
            "scientific_output_geometry": "registered-source-geometry-unchanged",
            "resampled": False,
        },
    )


def _geometry_record(geometry: Geometry) -> dict[str, Any]:
    return {
        "axes": geometry.axes,
        "affine": [list(row) for row in geometry.affine],
        "unit": geometry.unit,
        "frame": geometry.frame,
    }


def _postprocess(
    probabilities: np.ndarray,
    package: ModelPackage,
    geometry: Geometry,
    value: Any,
    *,
    working_bytes: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    exact_keys(
        value,
        {
            "probability_channel",
            "threshold",
            "method",
            "min_size",
            "split_height",
            "exclude_border",
        },
        "model postprocessing",
    )
    output_indices = {source_index for _name, source_index in package.output.channels}
    channel = integer(
        value.get("probability_channel"),
        "probability channel",
        0,
        probabilities.shape[0] - 1,
    )
    if channel not in output_indices:
        raise ValueError("Probability channel is not declared by the model output")
    threshold = finite_number(value.get("threshold"), "probability threshold", 0, 1)
    method = value.get("method")
    if method not in {"components", "watershed"}:
        raise ValueError("Postprocessing method must be components or watershed")
    settings: dict[str, Any] = {
        "method": method,
        "threshold": threshold,
        "polarity": "bright",
        "min_size": finite_number(value.get("min_size", 0), "minimum size", 0, 1e20),
        "exclude_border": value.get("exclude_border", False),
    }
    if not isinstance(settings["exclude_border"], bool):
        raise ValueError("exclude_border must be boolean")
    split_height = value.get("split_height")
    if method == "watershed":
        settings["split_height"] = finite_number(split_height, "watershed split height", 1e-9, 1e9)
    elif split_height is not None:
        raise ValueError("split_height is only valid for watershed postprocessing")
    labels, record = segment_scalar(
        probabilities[channel], geometry, settings, working_bytes=working_bytes
    )
    return labels, {"probability_channel": channel, **record}


def _array_sha256(array: np.ndarray) -> str:
    value = np.ascontiguousarray(array)
    digest = hashlib.sha256()
    digest.update(canonical_json({"shape": list(value.shape), "dtype": str(value.dtype)}).encode())
    digest.update(value.tobytes(order="C"))
    return digest.hexdigest()


def _normal_request(request: dict[str, Any]) -> dict[str, Any]:
    exact_keys(
        request,
        {
            "model_id",
            "source_id",
            "selection",
            "channel_mapping",
            "scale",
            "postprocessing",
            "measurement_channels",
            "display",
            "working_bytes",
        },
        "model preview",
    )
    if not isinstance(request.get("selection"), dict):
        raise ValueError("Model preview requires an explicit selection object")
    if "c" in request["selection"] or "z_stop" in request["selection"]:
        raise ValueError("Model selection uses channel_mapping and one Z plane; omit c and z_stop")
    return request


def _display_request(value: Any) -> tuple[int, dict[str, Any]]:
    exact_keys(
        value,
        {"source_channel", "low", "high", "gamma", "color"},
        "model preview display",
    )
    source_channel = integer(value.get("source_channel"), "display source channel", 0, 255)
    return source_channel, {key: item for key, item in value.items() if key != "source_channel"}


def _preview_overlay(
    source: np.ndarray,
    probability: np.ndarray,
    labels: np.ndarray,
    display: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    source_rgb, display_record = display_scalar(source, display)
    confidence = np.clip(np.asarray(probability, dtype=np.float32), 0.0, 1.0)[..., None]
    heat_color = np.array([1.0, 0.36, 0.12], dtype=np.float32)
    alpha = confidence * np.float32(0.42)
    probability_overlay = (
        np.asarray(source_rgb, dtype=np.float32) * (1.0 - alpha) + heat_color * alpha
    )
    data_url = render_overlay(probability_overlay, labels)
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise RuntimeError("Model preview renderer returned an invalid PNG payload")
    try:
        png = base64.b64decode(data_url.removeprefix(prefix), validate=True)
    except ValueError as exc:
        raise RuntimeError("Model preview renderer returned invalid base64") from exc
    return data_url, {
        "purpose": "display-only-model-preview; excluded from quantitative analysis",
        "source_mapping": display_record,
        "probability_color": "#ff5c1f",
        "probability_alpha_max": 0.42,
        "label_overlay": "filled-labels-with-outer-boundaries",
        "png_sha256": hashlib.sha256(png).hexdigest(),
    }


def _compute(
    workbench: Workbench,
    model_document: dict[str, Any],
    package: ModelPackage,
    request: dict[str, Any],
    *,
    purpose: str,
) -> tuple[dict[str, Any], np.ndarray, np.ndarray, list[dict[str, Any]], Geometry, str]:
    request = _normal_request(request)
    source_id = checked_id(request.get("source_id"))
    source = workbench.project.source(source_id, verify=True)
    mapping = _checked_mapping(package, request.get("channel_mapping"))
    measurement_channels = _checked_measurement_channels(request.get("measurement_channels"))
    display_channel, display_settings = _display_request(request.get("display"))
    working_bytes = integer(request.get("working_bytes"), "working_bytes", 1024**2, 8 * 1024**3)
    first_channel = mapping[0]["source_channel"]
    base = workbench.selection(source_id, {**request["selection"], "c": first_channel})
    base_selection = {key: item for key, item in base.items() if key != "c"}
    required_channels = sorted(
        {item["source_channel"] for item in mapping} | set(measurement_channels) | {display_channel}
    )
    pixels = base["width"] * base["height"]
    slots = max(item["package_source_slot"] for item in mapping) + 1
    if pixels * (len(required_channels) + slots + 8) * 8 > working_bytes:
        raise ValueError("Selected model channels exceed the working-memory budget")
    raw_channels: dict[int, np.ndarray] = {}
    geometry: Geometry | None = None
    for channel in required_channels:
        array, current_geometry, selected = workbench.load_scalar(
            source_id,
            {**base_selection, "c": channel},
            working_bytes=min(working_bytes, DEFAULT_WORKING_BYTES),
        )
        if array.ndim != 2:
            raise ValueError("Model inference requires one two-dimensional source plane")
        if {key: item for key, item in selected.items() if key != "c"} != base_selection:
            raise ValueError("Source channel selections resolved to different grids")
        if geometry is None:
            geometry = current_geometry
        elif current_geometry.to_dict() != geometry.to_dict():
            raise ValueError("Source channels do not share one exact physical grid")
        raw_channels[channel] = array
    assert geometry is not None
    used_scale, used_unit, scale_record = _scale_record(package, geometry, request.get("scale"))
    common_dtype = np.result_type(*(array.dtype for array in raw_channels.values()))
    source_tensor = np.zeros((slots, base["height"], base["width"]), dtype=common_dtype)
    for item in mapping:
        source_tensor[item["package_source_slot"]] = raw_channels[item["source_channel"]]
    if purpose == "preview":
        inference = preview_inference(
            package,
            source_tensor,
            source_axes="CYX",
            source_scale_yx=used_scale,
            source_scale_unit=used_unit,
            working_bytes=working_bytes,
        )
    elif purpose == "run":
        inference = run_inference(
            package,
            source_tensor,
            source_axes="CYX",
            source_scale_yx=used_scale,
            source_scale_unit=used_unit,
            purpose="run",
            working_bytes=working_bytes,
        )
    else:
        raise ValueError("Unknown model workflow purpose")
    labels, postprocessing = _postprocess(
        inference.probabilities,
        package,
        geometry,
        request.get("postprocessing"),
        working_bytes=working_bytes,
    )
    selected_probability = postprocessing["probability_channel"]
    overlay, overlay_record = _preview_overlay(
        raw_channels[display_channel],
        inference.probabilities[selected_probability],
        labels,
        display_settings,
    )
    measurement_values = {
        f"source_channel_{channel}": raw_channels[channel] for channel in measurement_channels
    }
    measurements = measure_objects(
        labels, geometry, measurement_values, working_bytes=working_bytes
    )
    current_source = workbench.project.source(source_id, verify=True)
    if current_source["sha256"] != source["sha256"]:
        raise ValueError("Source changed during model preview")
    output_channels = []
    names = {index: name for name, index in package.output.channels}
    for index, probability in enumerate(inference.probabilities):
        output_channels.append(
            {
                "index": index,
                "name": names.get(index),
                "sha256": _array_sha256(probability),
                "minimum": float(probability.min()),
                "maximum": float(probability.max()),
            }
        )
    inference_record = dict(inference.record)
    receipt = {
        "schema": PREVIEW_SCHEMA,
        "engine_version": ENGINE_VERSION,
        "model_id": model_document["id"],
        "model_revision": model_document["revision"],
        "package": {
            "id": package.id,
            "version": package.version,
            "model_sha256": package.model.sha256,
            "metadata_sha256": package.metadata_sha256,
            "package_sha256": package.package_sha256,
        },
        "source": {
            "id": source_id,
            "sha256": source["sha256"],
            "selection": base_selection,
            "channel_mapping": mapping,
            "measurement_channels": measurement_channels,
            "channel_metadata_sha256": hashlib.sha256(
                canonical_json(workbench.channel_metadata(source_id)).encode()
            ).hexdigest(),
            "scale": scale_record,
            "geometry": _geometry_record(geometry),
            "display": {
                "request": dict(request["display"]),
                "probability_channel": selected_probability,
                "probability_display_range": [0.0, 1.0],
                "probability_values_clipped_for_display": True,
                **overlay_record,
            },
        },
        "working_bytes": working_bytes,
        "reference_qualification": inference_record["reference_qualification"],
        "runtime": inference_record["runtime"],
        "preprocessing": inference_record["preprocessing"],
        "tiling": inference_record["tiling"],
        "package_postprocessing": inference_record["postprocessing"],
        "segmentation_postprocessing": postprocessing,
        "output": {
            "probabilities_axes": "CYX",
            "probabilities_shape": list(inference.probabilities.shape),
            "probabilities_dtype": "float32",
            "probability_channels": output_channels,
            "probabilities_sha256": _array_sha256(inference.probabilities),
            "labels_axes": "YX",
            "labels_shape": list(labels.shape),
            "labels_dtype": str(labels.dtype),
            "labels_sha256": _array_sha256(labels),
            "object_count": len(measurements),
            "measurements_sha256": hashlib.sha256(
                canonical_json(measurements).encode()
            ).hexdigest(),
        },
        "scientific_validation": dict(package.validation),
        "rights": {
            "supplier_declarations": dict(package.rights),
            "review_state": "independent-rights-review-required",
        },
        "meaning": "technical preview; not biological or clinical validation",
    }
    return (
        receipt,
        inference.probabilities,
        labels,
        measurements,
        geometry,
        overlay,
    )


def _preview_hash(receipt: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(receipt).encode()).hexdigest()


def _request_from_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    source = receipt["source"]
    scale = source["scale"]
    scale_request = {"mode": "source"}
    if scale["mode"] == "override":
        scale_request = {
            "mode": "override",
            "scale_yx": scale["model_input"]["scale_yx"],
            "scale_unit": scale["model_input"]["scale_unit"],
            "declaration": scale["override_declaration"],
        }
    return {
        "model_id": receipt["model_id"],
        "source_id": source["id"],
        "selection": source["selection"],
        "channel_mapping": [
            {
                "model_input_index": item["model_input_index"],
                "model_channel": item["model_channel"],
                "source_channel": item["source_channel"],
            }
            for item in source["channel_mapping"]
        ],
        "scale": scale_request,
        "postprocessing": {
            "probability_channel": receipt["segmentation_postprocessing"]["probability_channel"],
            "threshold": receipt["segmentation_postprocessing"]["threshold"],
            "method": receipt["segmentation_postprocessing"]["method"],
            "min_size": receipt["segmentation_postprocessing"]["min_size"],
            "split_height": receipt["segmentation_postprocessing"]["split_height"],
            "exclude_border": receipt["segmentation_postprocessing"]["exclude_border"],
        },
        "measurement_channels": source["measurement_channels"],
        "display": source["display"]["request"],
        "working_bytes": receipt["working_bytes"],
    }


def _preview(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    request = _normal_request(request)
    model_document, package = _managed_package(workbench, checked_id(request.get("model_id")))
    receipt, _probabilities, _labels, measurements, _geometry, overlay = _compute(
        workbench, model_document, package, request, purpose="preview"
    )
    digest = _preview_hash(receipt)
    preview_id = uuid.uuid4().hex
    document = workbench.project.put_document(
        "model_preview",
        preview_id,
        {**receipt, "preview_sha256": digest},
        expected_revision=0,
    )
    return {
        "preview": {
            "id": preview_id,
            "revision": document["revision"],
            "updated_at": document["updated_at"],
            **document["data"],
        },
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "overlay_png": overlay,
        "adopted": False,
    }


def _run(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    external_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    exact_keys(request, {"preview_id", "preview_sha256"}, "model run")
    preview_id = checked_id(request.get("preview_id"))
    preview_hash = request.get("preview_sha256")
    if (
        not isinstance(preview_hash, str)
        or len(preview_hash) != 64
        or any(character not in "0123456789abcdef" for character in preview_hash)
    ):
        raise ValueError("Model run requires an exact preview SHA-256")
    document = _document(workbench.project, "model_preview", preview_id)
    stored = document.get("data")
    if not isinstance(stored, dict) or stored.get("schema") != PREVIEW_SCHEMA:
        raise ValueError("Stored model preview is invalid")
    stored_hash = stored.get("preview_sha256")
    receipt = {key: value for key, value in stored.items() if key != "preview_sha256"}
    if stored_hash != _preview_hash(receipt) or preview_hash != stored_hash:
        raise ValueError("Model run must bind to the exact persisted preview")
    model_document, package = _managed_package(workbench, checked_id(receipt.get("model_id")))
    candidate, probabilities, labels, measurements, geometry, _overlay = _compute(
        workbench,
        model_document,
        package,
        _request_from_receipt(receipt),
        purpose="run",
    )
    if (
        canonical_json(candidate) != canonical_json(receipt)
        or _preview_hash(candidate) != stored_hash
    ):
        raise ValueError("Source, model, runtime, settings, or output changed after preview")
    selected_probability = receipt["segmentation_postprocessing"]["probability_channel"]
    channel_declaration = workbench.channel_metadata(receipt["source"]["id"])
    if hashlib.sha256(canonical_json(channel_declaration).encode()).hexdigest() != receipt[
        "source"
    ].get("channel_metadata_sha256"):
        raise ValueError("Channel declarations changed after the model preview")
    provenance = {
        "geometry": _geometry_record(geometry),
        "selection": receipt["source"]["selection"],
        "model": package.public_record(),
        "runtime": receipt["runtime"],
        "model_preview": {
            "id": preview_id,
            "revision": document["revision"],
            "sha256": stored_hash,
        },
        "source_scale": receipt["source"]["scale"],
        "channel_mapping": receipt["source"]["channel_mapping"],
        "preprocessing": receipt["preprocessing"],
        "tiling": receipt["tiling"],
        "package_postprocessing": receipt["package_postprocessing"],
        "segmentation": receipt["segmentation_postprocessing"],
        "probabilities": receipt["output"]["probability_channels"],
        "measurements": measurements,
        "measurement_basis": "raw-selected-source-channel-values-on-model-label-grid",
        "measurement_channels": receipt["source"]["measurement_channels"],
        "channel_metadata": channel_declaration,
        "working_bytes": receipt["working_bytes"],
        "reference_qualification": receipt["reference_qualification"],
        "scientific_validation": receipt["scientific_validation"],
        "rights": receipt["rights"],
    }

    def publication_guard() -> None:
        if external_guard is not None:
            external_guard()
        current_preview = _document(workbench.project, "model_preview", preview_id)
        if current_preview != document:
            raise ValueError("Model preview changed before result publication")
        current_model, current_package = _managed_package(workbench, model_document["id"])
        if (
            current_model != model_document
            or current_package.public_record() != package.public_record()
        ):
            raise ValueError("Managed model changed before result publication")
        current_source = workbench.project.source(receipt["source"]["id"], verify=True)
        if current_source["sha256"] != receipt["source"]["sha256"]:
            raise ValueError("Source changed before result publication")

    # Recheck before staging and once more under the result publication
    # transaction, after potentially slow array hashing and writes.
    publication_guard()
    result = workbench.project.save_result(
        source_id=receipt["source"]["id"],
        kind="model-segmentation",
        arrays={
            "image": probabilities[selected_probability],
            "probabilities": probabilities,
            "labels": labels,
        },
        provenance=provenance,
        publication_guard=publication_guard,
        job_id=job_id,
    )
    return {
        "result": {
            "id": result["id"],
            "source_id": result["source_id"],
            "kind": result["kind"],
            "revision_hash": result["revision_hash"],
            "arrays": result["arrays"],
            "preview_id": preview_id,
            "preview_sha256": stored_hash,
            "object_count": len(measurements),
        },
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def execute_model(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Execute a path-free shared model workflow operation."""
    if operation not in MODEL_OPERATIONS or not isinstance(request, dict):
        raise ValueError("Unknown or invalid model workflow operation")
    if operation == "model_list":
        exact_keys(request, set(), "model list")
        models = []
        for item in workbench.project.documents("model"):
            _data, state = _validated_model_data(item)
            if state == "ready":
                document, _package = _managed_package(workbench, item["id"])
                models.append(_path_free_model(document))
            else:
                models.append(_path_free_model(item))
        return {"models": models}
    if operation == "model_preview":
        return _preview(workbench, request)
    return _run(workbench, request, job_id=job_id, external_guard=publication_guard)
