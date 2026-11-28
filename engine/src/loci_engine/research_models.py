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
    ModelPackageError,
    import_model_package,
    inspect_model_package,
    preview_inference,
    run_inference,
    runtime_status,
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
from .workbench import Workbench, display_scalar, result_summary, runtime_record

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
MAX_UNADOPTED_MODEL_PREVIEWS = 64
_POLICY_RUNTIME_KEYS = ("engine", "numpy", "scipy", "scikit_image")

NUCLEI_MODEL_PACKAGE_ID = "nuclei-segmentation-boundary-model"
NUCLEI_MODEL_VERSION = "0.1.0-publication-20261015-r2"
NUCLEI_MODEL_DEFAULT_WORKING_BYTES = 2 * 1024**3
NUCLEI_MODEL_MIN_POLICY_MEMORY_BYTES = 512 * 1024**2
NUCLEI_MODEL_PACKAGE_SHA256 = "774aa0c53566c9f995af02c905863c0ca86b71460f93c3a11fe101b11c5ba582"
NUCLEI_MODEL_METADATA_SHA256 = "e77c15651c117ded7a9eb73b643c889c4abb41d40024a1294438b767fa6d622d"
NUCLEI_MODEL_WEIGHTS_SHA256 = "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44"
NUCLEI_MODEL_REFERENCE_INPUT_SHA256 = (
    "c29bd6e16e3f7856217b407ba948222b1c2a0da41922a0f79297e25588614fe2"
)
NUCLEI_MODEL_REFERENCE_OUTPUT_SHA256 = (
    "510181f38930e59e4fd8ecc03d6ea7c980eb6609759655f2d4a41fe36108d5f5"
)
VERIFIED_NUCLEI_MODEL_PACKAGE: dict[str, Any] = {
    "schema_version": "loci.model-package/1",
    "source_format": "loci",
    "id": NUCLEI_MODEL_PACKAGE_ID,
    "version": NUCLEI_MODEL_VERSION,
    "task": "semantic-segmentation",
    "package_sha256": NUCLEI_MODEL_PACKAGE_SHA256,
    "metadata_sha256": NUCLEI_MODEL_METADATA_SHA256,
    "model_sha256": NUCLEI_MODEL_WEIGHTS_SHA256,
    "opset_version": 12,
    "reference_input_sha256": NUCLEI_MODEL_REFERENCE_INPUT_SHA256,
    "reference_output_sha256": NUCLEI_MODEL_REFERENCE_OUTPUT_SHA256,
    "input_axes": "BCYX",
    "input_dtype": "float32",
    "input_shape": [1, 1, 256, 256],
    "input_scale_yx": [1.0, 1.0],
    "input_scale_unit": "pixel",
}
VERIFIED_AGENT_MODEL_PACKAGES: tuple[dict[str, Any], ...] = (VERIFIED_NUCLEI_MODEL_PACKAGE,)


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
    matches = project.documents(kind, document_id=document_id)
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


NUCLEI_MODEL_ID = _model_id_from_record(
    {
        "id": NUCLEI_MODEL_PACKAGE_ID,
        "version": NUCLEI_MODEL_VERSION,
        "package_sha256": NUCLEI_MODEL_PACKAGE_SHA256,
    }
)


def is_verified_agent_model_package(package: Any) -> bool:
    """Return True only when package matches a pinned verified ONNX model contract."""
    if not isinstance(package, dict) or set(package) != _PACKAGE_PUBLIC_KEYS:
        return False
    model = package.get("model")
    reference = package.get("reference")
    input_spec = package.get("input")
    if (
        not isinstance(model, dict)
        or not isinstance(reference, dict)
        or not isinstance(reference.get("input"), dict)
        or not isinstance(reference.get("output"), dict)
        or not isinstance(input_spec, dict)
    ):
        return False
    for spec in VERIFIED_AGENT_MODEL_PACKAGES:
        if (
            package.get("schema_version") == spec["schema_version"]
            and package.get("source_format") == spec["source_format"]
            and package.get("id") == spec["id"]
            and package.get("version") == spec["version"]
            and package.get("task") == spec["task"]
            and package.get("package_sha256") == spec["package_sha256"]
            and package.get("metadata_sha256") == spec["metadata_sha256"]
            and model.get("sha256") == spec["model_sha256"]
            and model.get("opset_version") == spec["opset_version"]
            and reference["input"].get("sha256") == spec["reference_input_sha256"]
            and reference["output"].get("sha256") == spec["reference_output_sha256"]
            and input_spec.get("axes") == spec["input_axes"]
            and input_spec.get("dtype") == spec["input_dtype"]
            and input_spec.get("shape") == spec["input_shape"]
            and input_spec.get("scale_yx") == spec["input_scale_yx"]
            and input_spec.get("scale_unit") == spec["input_scale_unit"]
        ):
            return True
    return False


def _onnx_runtime_contract(onnx_version: str, onnxruntime_version: str) -> dict[str, Any]:
    return {
        "backend": "onnxruntime",
        "onnx_version": onnx_version,
        "onnxruntime_version": onnxruntime_version,
        "requested_providers": ["CPUExecutionProvider"],
        "session_providers": ["CPUExecutionProvider"],
        "execution_mode": "sequential",
        "intra_op_threads": 1,
        "inter_op_threads": 1,
        "graph_optimization": "basic",
    }


def onnx_policy_runtime() -> dict[str, str]:
    """Return the pinned CPU ONNX runtime identity for agent policy validation."""
    status = runtime_status()
    versions = status.get("versions", {})
    if not status.get("ready") or not all(
        isinstance(versions.get(key), str) and versions[key]
        for key in ("onnx", "onnxruntime", "yaml")
    ):
        raise PermissionError("The bounded ONNX CPU runtime is unavailable")
    contract = _onnx_runtime_contract(str(versions["onnx"]), str(versions["onnxruntime"]))
    digest = hashlib.sha256(canonical_json(contract).encode()).hexdigest()
    host = runtime_record()
    return {
        **{key: host[key] for key in _POLICY_RUNTIME_KEYS},
        "backend": f"onnxruntime-cpu:{digest}",
        "resolved_device": "cpu",
    }


def onnx_runtime_identity_from_record(runtime: Any) -> dict[str, str]:
    """Derive the policy runtime identity from a persisted ONNX model runtime record."""
    if (
        not isinstance(runtime, dict)
        or runtime.get("backend") != "onnxruntime"
        or not isinstance(runtime.get("onnx_version"), str)
        or not runtime["onnx_version"]
        or not isinstance(runtime.get("onnxruntime_version"), str)
        or not runtime["onnxruntime_version"]
        or runtime.get("requested_providers") != ["CPUExecutionProvider"]
        or runtime.get("session_providers") != ["CPUExecutionProvider"]
        or runtime.get("execution_mode") != "sequential"
        or type(runtime.get("intra_op_threads")) is not int
        or runtime["intra_op_threads"] != 1
        or type(runtime.get("inter_op_threads")) is not int
        or runtime["inter_op_threads"] != 1
        or runtime.get("graph_optimization") != "basic"
    ):
        raise PermissionError("The result ONNX runtime identity is outside the pinned policy")
    contract = _onnx_runtime_contract(runtime["onnx_version"], runtime["onnxruntime_version"])
    digest = hashlib.sha256(canonical_json(contract).encode()).hexdigest()
    host = runtime_record()
    return {
        **{key: host[key] for key in _POLICY_RUNTIME_KEYS},
        "backend": f"onnxruntime-cpu:{digest}",
        "resolved_device": "cpu",
    }


def _reference_runtime_matches_live(data: dict[str, Any], live_onnx_rt: dict[str, str]) -> bool:
    qual_rt = data.get("reference_qualification", {}).get("runtime")
    try:
        return onnx_runtime_identity_from_record(qual_rt) == live_onnx_rt
    except PermissionError:
        return False


def authorize_retained_model_result(policy: Any, record: dict[str, Any]) -> None:
    """Fail closed when a persisted model-segmentation result exceeds policy grants."""
    provenance = record.get("provenance")
    if not isinstance(provenance, dict):
        raise PermissionError("Model result provenance is invalid")
    model = provenance.get("model")
    if not is_verified_agent_model_package(model):
        raise PermissionError(
            "Only the verified BioImage.IO nuclei ONNX model package is supported for agent access"
        )
    policy.require_model(model)
    policy.require_runtime(onnx_runtime_identity_from_record(provenance.get("runtime")))


def agent_policy_model_grants(workbench: Workbench) -> dict[str, list[dict[str, str]]]:
    """Return pinned model_packages and runtimes for setup bundles when verified & ready."""
    try:
        onnx_rt = onnx_policy_runtime()
    except PermissionError:
        return {"model_packages": [], "runtimes": []}
    granted_packages: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in workbench.project.documents("model"):
        data, state = _validated_model_data(item)
        package = data["package"]
        if (
            state != "ready"
            or not is_verified_agent_model_package(package)
            or not _reference_runtime_matches_live(data, onnx_rt)
        ):
            continue
        try:
            _managed_package_safe(workbench, item["id"])
        except ValueError:
            continue
        identity = (str(package["id"]), str(package["package_sha256"]))
        if identity not in seen:
            seen.add(identity)
            granted_packages.append({"id": identity[0], "sha256": identity[1]})
    if not granted_packages:
        return {"model_packages": [], "runtimes": []}
    return {"model_packages": granted_packages, "runtimes": [onnx_rt]}


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


def _managed_package_safe(
    workbench: Workbench, model_id: str
) -> tuple[dict[str, Any], ModelPackage]:
    """Verify a managed package while sanitizing any filesystem-bearing package error."""
    try:
        return _managed_package(workbench, model_id)
    except (ModelPackageError, OSError) as exc:
        raise ValueError("Managed model package is unavailable or failed verification") from exc


def import_model(
    workbench: Workbench,
    path: str | Path,
    working_bytes: int = DEFAULT_WORKING_BYTES,
    recovery_model_id: str | None = None,
    expected_package_sha256: str | None = None,
) -> dict[str, Any]:
    """Qualify and atomically adopt one explicitly selected local package."""
    integer(working_bytes, "working_bytes", 1024**2, 8 * 1024**3)
    candidate = inspect_model_package(path)
    if expected_package_sha256 is not None and candidate.package_sha256 != expected_package_sha256:
        raise ValueError("Model package differs from the selected registry entry")
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
            working_bytes=working_bytes,
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


def _prune_unadopted_model_previews(
    project: ResearchProject, *, max_unadopted: int | None = None
) -> None:
    """Bound unreferenced model_preview documents without evicting adopted or active previews."""
    limit = MAX_UNADOPTED_MODEL_PREVIEWS if max_unadopted is None else max_unadopted
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        # Choose and delete victims against the same job, approval and result state.
        connection.execute(
            "DELETE FROM documents WHERE kind='model_preview' "
            "AND json_extract(record, '$.data.schema')=? AND id IN ("
            "SELECT id FROM documents WHERE kind='model_preview' "
            "AND json_extract(record, '$.data.schema')=? AND id NOT IN ("
            "SELECT json_extract(record, '$.provenance.model_preview.id') FROM results "
            "WHERE json_type(record, '$.provenance.model_preview.id')='text' UNION "
            "SELECT json_extract(record, '$.request.task_request.preview_id') FROM jobs "
            "WHERE json_extract(record, '$.state') IN ('queued','running') "
            "AND json_extract(record, '$.operation')='model_run' "
            "AND json_type(record, '$.request.task_request.preview_id')='text' UNION "
            "SELECT json_extract(value, '$.parameters_summary.preview_id') FROM metadata "
            "WHERE key LIKE 'agent-approval:%' "
            "AND json_extract(value, '$.state') IN ('pending','approved') "
            "AND json_type(value, '$.parameters_summary.preview_id')='text') "
            "ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
            (PREVIEW_SCHEMA, PREVIEW_SCHEMA, max(1, limit)),
        )


def _preview(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    request = _normal_request(request)
    model_document, package = _managed_package_safe(workbench, checked_id(request.get("model_id")))
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
    _prune_unadopted_model_previews(workbench.project)
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
    if external_guard is not None:
        external_guard()
    model_document, package = _managed_package_safe(workbench, checked_id(receipt.get("model_id")))
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
    mapped_source_channels = {
        int(item["source_channel"]) for item in receipt["source"]["channel_mapping"]
    }
    provenance_selection = (
        {**receipt["source"]["selection"], "c": next(iter(mapped_source_channels))}
        if len(mapped_source_channels) == 1
        else receipt["source"]["selection"]
    )
    provenance = {
        "geometry": _geometry_record(geometry),
        "selection": provenance_selection,
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

    owned_run = job_id is not None and workbench.project.job(job_id).get("owner") is not None

    def publication_guard() -> None:
        if owned_run:
            with workbench.project.connection() as connection:
                if connection.execute(
                    "SELECT 1 FROM results "
                    "WHERE json_extract(record, '$.provenance.model_preview.id')=? LIMIT 1",
                    (preview_id,),
                ).fetchone():
                    raise ValueError(
                        "This model preview has already been adopted as a saved result"
                    )
        if workbench.channel_metadata(receipt["source"]["id"]) != channel_declaration:
            raise ValueError("Channel declarations changed before model result publication")
        if external_guard is not None:
            external_guard()
        current_preview = _document(workbench.project, "model_preview", preview_id)
        if current_preview != document:
            raise ValueError("Model preview changed before result publication")
        current_model, current_package = _managed_package_safe(workbench, model_document["id"])
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
            **result_summary(result),
            "preview_id": preview_id,
            "preview_sha256": stored_hash,
        },
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def inspect_agent_models(workbench: Workbench, *, policy: Any) -> dict[str, Any]:
    """Return path-free ready verified models installed in this study."""
    status = runtime_status()
    onnx_rt: dict[str, str] | None = None
    if status.get("ready"):
        with suppress(PermissionError):
            onnx_rt = onnx_policy_runtime()
    models: list[dict[str, Any]] = []
    for item in workbench.project.documents("model"):
        data, state = _validated_model_data(item)
        package = data["package"]
        if state != "ready" or not is_verified_agent_model_package(package):
            continue
        if onnx_rt is None or not _reference_runtime_matches_live(data, onnx_rt):
            continue
        document, _package = _managed_package_safe(workbench, item["id"])
        entry = _path_free_model(document)
        entry["agent_execution"] = {
            "model_package_granted": (package["id"], package["package_sha256"])
            in policy.model_packages,
            "runtime_granted": onnx_rt in policy.runtimes,
            "runtime_policy_identity": onnx_rt,
            "adoption_requires_human_visual_review": True,
        }
        models.append(entry)
    return {"models": models}


def _preflight_preview_request(
    workbench: Workbench, request: dict[str, Any], *, policy: Any
) -> dict[str, Any]:
    from .agent_actions import source_scope

    request = _normal_request(request)
    working_bytes = integer(
        request.get("working_bytes"), "working_bytes", 1024**2, policy.memory_bytes
    )
    model_id = checked_id(request.get("model_id"))
    document = _document(workbench.project, "model", model_id)
    data, state = _validated_model_data(document)
    if state != "ready":
        raise ValueError(
            "Managed model package is unavailable after study interchange; "
            "human re-import is required before preview or run"
        )
    package_record = data["package"]
    if not is_verified_agent_model_package(package_record):
        raise PermissionError(
            "Only the verified BioImage.IO nuclei ONNX model package is supported for agent access"
        )
    policy.require_model(package_record)
    live_onnx_rt = onnx_policy_runtime()
    if not _reference_runtime_matches_live(data, live_onnx_rt):
        raise PermissionError(
            "Managed model reference qualification differs from the active ONNX CPU runtime"
        )
    policy.require_runtime(live_onnx_rt)

    source_id = checked_id(request.get("source_id"))
    grant = policy.source_grant(workbench.project, source_id)
    source = workbench.project.source(source_id)
    metadata = source.get("metadata", {})
    if (
        metadata.get("sample_semantics") in {"RGB", "RGBA"}
        or metadata.get("rgb") is True
        or metadata.get("rgb_samples")
        or metadata.get("is_rgb")
        or "S" in metadata.get("axes", "")
        or metadata.get("dimensions", {}).get("s", 1) > 1
    ):
        raise ValueError(
            "BioImage.IO nuclei model requires scalar channels; "
            "RGB components are not biological channels"
        )

    input_channels = package_record["input"]["channels"]
    raw_mapping = request.get("channel_mapping")
    if not isinstance(raw_mapping, list) or len(raw_mapping) != len(input_channels):
        raise ValueError("Channel mapping must explicitly map every model input channel")
    mapped_channels: list[int] = []
    slots: list[int] = []
    for index, (spec, item) in enumerate(zip(input_channels, raw_mapping, strict=True)):
        exact_keys(item, {"model_input_index", "model_channel", "source_channel"}, "mapping")
        if item.get("model_input_index") != index or item.get("model_channel") != spec["name"]:
            raise ValueError("Channel mapping must match model input order and names exactly")
        ch = integer(item.get("source_channel"), "source channel", 0, 255)
        if ch not in grant.c:
            raise PermissionError("Model input channel is outside the source grant")
        mapped_channels.append(ch)
        slots.append(int(spec["source_index"]))

    measurement_channels = _checked_measurement_channels(request.get("measurement_channels"))
    display_channel, _display_settings = _display_request(request.get("display"))
    if display_channel not in grant.c:
        raise PermissionError("Model preview display channel is outside the source grant")

    resolved_base: dict[str, Any] | None = None
    for ch in sorted(set(mapped_channels) | {display_channel}):
        candidate_plane = {**request["selection"], "c": ch}
        if not grant.allows(candidate_plane, measurement_channels):
            raise PermissionError(
                "Action source selection or measurement channels exceed the grant"
            )
        resolved = source_scope(
            policy,
            workbench,
            source_id,
            candidate_plane,
            measurement_channels,
        )
        plane = {k: resolved[k] for k in ("x", "y", "width", "height", "t", "z", "level")}
        if resolved_base is None:
            resolved_base = plane
        elif plane != resolved_base:
            raise ValueError("Source channel selections resolved to different grids")
    assert resolved_base is not None

    _verified_doc, package = _managed_package_safe(workbench, model_id)
    _checked_mapping(package, raw_mapping)

    post = request.get("postprocessing")
    exact_keys(
        post,
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
    prob_channel = integer(
        post.get("probability_channel"),
        "probability channel",
        0,
        max(output_indices),
    )
    if prob_channel not in output_indices:
        raise ValueError("Probability channel is not declared by the model output")
    finite_number(post.get("threshold"), "probability threshold", 0, 1)
    method = post.get("method")
    if method not in {"components", "watershed"}:
        raise ValueError("Postprocessing method must be components or watershed")
    finite_number(post.get("min_size", 0), "minimum size", 0, 1e20)
    if not isinstance(post.get("exclude_border", False), bool):
        raise ValueError("exclude_border must be boolean")
    if method == "watershed":
        finite_number(post.get("split_height"), "watershed split height", 1e-9, 1e9)
    elif post.get("split_height") is not None:
        raise ValueError("split_height is only valid for watershed postprocessing")

    scale = request.get("scale")
    if not isinstance(scale, dict) or scale.get("mode") not in {"source", "override"}:
        raise ValueError("Scale must explicitly use source or override mode")
    if scale["mode"] == "override":
        exact_keys(scale, {"mode", "scale_yx", "scale_unit", "declaration"}, "scale override")
        raw_yx = scale.get("scale_yx")
        if not isinstance(raw_yx, list) or len(raw_yx) != 2:
            raise ValueError("Scale override requires explicit Y and X values")
        used_yx = tuple(finite_number(v, "scale override", 1e-12, 1e12) for v in raw_yx)
        if used_yx != package.input.scale_yx or scale.get("scale_unit") != package.input.scale_unit:
            raise ValueError(
                "Used source scale must exactly equal the model contract; "
                "implicit resampling is forbidden"
            )
    else:
        exact_keys(scale, {"mode"}, "source scale")

    required_channels = sorted(set(mapped_channels) | set(measurement_channels) | {display_channel})
    pixels = resolved_base["width"] * resolved_base["height"]
    slot_count = max(slots) + 1
    if pixels * (len(required_channels) + slot_count + 8) * 8 > working_bytes:
        raise ValueError("Selected model channels exceed the working-memory budget")

    return {
        **request,
        "selection": resolved_base,
        "working_bytes": working_bytes,
    }


def verify_model_review_installation(workbench: Workbench, preview: dict[str, Any]) -> None:
    """Check the retained receipt against its persisted document and installed CPU runtime."""
    doc = _document(workbench.project, "model_preview", checked_id(preview.get("id")))
    stored = doc["data"]
    if preview != {
        **stored,
        "id": doc["id"],
        "updated_at": doc["updated_at"],
        "revision": doc["revision"],
    } or stored["preview_sha256"] != _preview_hash(
        {key: val for key, val in stored.items() if key != "preview_sha256"}
    ):
        raise ValueError("The retained model preview no longer matches the persisted receipt")
    model, package = _managed_package_safe(workbench, checked_id(stored["model_id"]))
    live = onnx_policy_runtime()
    if (
        model["revision"] != stored["model_revision"]
        or not is_verified_agent_model_package(package.public_record())
        or not _reference_runtime_matches_live(model["data"], live)
        or onnx_runtime_identity_from_record(stored["runtime"]) != live
    ):
        raise ValueError("The inspected model package or ONNX CPU runtime changed")


def preflight_agent_model(
    workbench: Workbench, operation: str, request: dict[str, Any], *, policy: Any
) -> dict[str, Any]:
    """Validate policy, model, runtime, source, and channel scopes before decode or job creation."""
    if policy.delegation is None or policy.delegation.get("result_scope") != "granted-sources":
        raise PermissionError("Model actions require delegated granted-sources study scope")
    if operation == "model_preview":
        return _preflight_preview_request(workbench, request, policy=policy)
    if operation == "model_run":
        exact_keys(request, {"preview_id", "preview_sha256"}, "model run")
        preview_id = checked_id(request.get("preview_id"))
        preview_hash = request.get("preview_sha256")
        if not _digest(preview_hash):
            raise ValueError("Model run requires an exact preview SHA-256")
        document = _document(workbench.project, "model_preview", preview_id)
        stored = document.get("data")
        if not isinstance(stored, dict) or stored.get("schema") != PREVIEW_SCHEMA:
            raise ValueError("Stored model preview is invalid")
        stored_hash = stored.get("preview_sha256")
        receipt = {key: value for key, value in stored.items() if key != "preview_sha256"}
        if stored_hash != _preview_hash(receipt) or preview_hash != stored_hash:
            raise ValueError("Model run must bind to the exact persisted preview")
        if receipt.get("working_bytes", 0) > policy.memory_bytes:
            raise PermissionError("Model preview working-memory budget exceeds the policy")
        _preflight_preview_request(workbench, _request_from_receipt(receipt), policy=policy)
        model_doc = _document(workbench.project, "model", checked_id(receipt.get("model_id")))
        if model_doc["revision"] != receipt.get("model_revision"):
            raise ValueError("Managed model changed after the model preview")
        current_source = workbench.project.source(receipt["source"]["id"], verify=True)
        if current_source["sha256"] != receipt["source"]["sha256"]:
            raise ValueError("Source changed after the model preview")
        channel_decl = workbench.channel_metadata(receipt["source"]["id"])
        if hashlib.sha256(canonical_json(channel_decl).encode()).hexdigest() != receipt[
            "source"
        ].get("channel_metadata_sha256"):
            raise ValueError("Channel declarations changed after the model preview")
        return {"preview_id": preview_id, "preview_sha256": preview_hash}
    raise ValueError("Unsupported agent model action")


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
