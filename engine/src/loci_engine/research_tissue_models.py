"""Isolated PUMA research dispatch and immutable tissue-result contracts.

This module grants no source, model, path, job or export authority. Trusted
callers supply ApprovedPumaWeights and a mandatory live ``check`` callback,
resolve source_bindings before execution, and authorize BOTH full normalization
context and output ROI. Preview tokens are identity references, not capabilities.

Preview retains bounded metadata only. Run repeats inference and must reproduce
that exact receipt before publishing through ResearchProject.save_result. No
Torch import, model installation or new database schema occurs in this layer.
"""

from __future__ import annotations

import copy
import hashlib
import re
import uuid
from collections.abc import Callable
from dataclasses import asdict

import numpy as np
from scipy import ndimage as ndi

from . import puma_backend as backend
from .native_image import (
    MAX_NATIVE_READ_BUDGET_BYTES,
    NativeDimensions,
    NativeLevel,
    NativeSelection,
    PhysicalCalibration,
    native_geometry,
)
from .quantitative import Geometry, integer, measure_objects
from .research_project import canonical_json, checked_id, parse_json, timestamp
from .tissue_model_profiles import (
    PUMA_CLASS_NAMES,
    PUMA_EPIDERMIS_CLASS,
    PUMA_MAX_CONTEXT_EDGE,
    PUMA_MAX_WORKING_BYTES,
    PUMA_MIN_WORKING_BYTES,
    PUMA_NUMERIC_PROFILE,
    PUMA_PROFILE_ID,
    PUMA_RGB_POLICY,
    PUMA_RUNTIME_VERSIONS,
    PUMA_TENSOR_BYTES,
    PUMA_TORCH_GIT_VERSION,
    PUMA_WEIGHTS_SHA256,
    puma_profile,
    runtime_metadata_status,
)

Check = Callable[[], None]
KIND = "tissue-model-regions"
SCHEMA = "loci.puma-tissue-result/v1"
PREVIEW_SCHEMA = "loci.puma-tissue-preview/v1"
PREVIEW_PREFIX = "tissue-model-preview:"
MAX_PREVIEW_BYTES = 64 * 1024
MAX_CACHE_BYTES = 1024 * 1024
MAX_PREVIEWS = 16
MAX_REGIONS = 4096
MAX_PARENT_DEPTH = 64
PREVIEW_EDGE = 512
CONNECTIVITY = "face-connected-2D"
MEASUREMENT_BASIS = "selected-tissue-region-geometry-only"
_ORIGINAL_ARRAYS = {"class_labels", "probabilities", "image"}
_RESULT_ARRAYS = _ORIGINAL_ARRAYS | {"labels"}
_SELECTION_KEYS = {"x", "y", "width", "height", "c", "z", "t", "level"}
_REQUEST_KEYS = {
    "source_id",
    "source_sha256",
    "series",
    "context_selection",
    "output_selection",
    "profile_id",
    "profile_contract_sha256",
    "runtime_contract_sha256",
    "weights_sha256",
    "rgb_policy",
    "declared_stain",
    "working_bytes",
}
_SHA = re.compile(r"[0-9a-f]{64}\Z")


def _exact(value, keys, name):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f"Invalid {name} fields")
    return value


def _sha(value):
    if type(value) is not str or not _SHA.fullmatch(value):
        raise ValueError("Expected an exact lowercase SHA-256")
    return value


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _same(first, second):
    return canonical_json(first) == canonical_json(second)


def _clone(value):
    return parse_json(canonical_json(value))


def _check(check):
    if not callable(check):
        raise ValueError(
            "Tissue model operations require a trusted live authority/cancellation guard"
        )
    check()


def _geometry(value):
    _exact(value, {"axes", "affine", "unit", "frame"}, "tissue geometry")
    geometry = Geometry(
        value["axes"], tuple(map(tuple, value["affine"])), value["unit"], value["frame"]
    )
    if geometry.axes != "YX":
        raise ValueError("Tissue model results require an explicit two-dimensional YX grid")
    return geometry


def _array_hash(array):
    return hashlib.sha256(array.tobytes(order="C")).hexdigest()


def _descriptor(array):
    return {
        "axes": "CYX" if array.ndim == 3 else "YX",
        "shape": list(array.shape),
        "dtype": str(array.dtype),
        "sha256": _array_hash(array),
    }


def _selection(value):
    _exact(value, _SELECTION_KEYS, "tissue selection")
    for key in _SELECTION_KEYS:
        integer(value[key], f"selection {key}", 1 if key in {"width", "height"} else 0, 2**31 - 1)
    if value["c"] != 0 or value["level"] != 0:
        raise ValueError("PUMA requires explicit native level zero and RGB channel zero")
    return dict(value)


def validate_request(request):
    """Canonical path-free request. No fields are silently defaulted or coerced."""
    _exact(request, _REQUEST_KEYS, "tissue model request")
    checked_id(request["source_id"])
    _sha(request["source_sha256"])
    integer(request["series"], "native series", 0, 65535)
    profile = puma_profile()
    if (
        request["profile_id"] != PUMA_PROFILE_ID
        or request["profile_contract_sha256"] != profile["contract_sha256"]
        or request["runtime_contract_sha256"] != _hash(profile["runtime"])
        or request["weights_sha256"] != PUMA_WEIGHTS_SHA256
        or request["rgb_policy"] != PUMA_RGB_POLICY
        or request["declared_stain"] != "hematoxylin-eosin"
    ):
        raise ValueError("Tissue profile, runtime, weights or RGB policy identity is stale")
    integer(
        request["working_bytes"],
        "PUMA working bytes",
        PUMA_MIN_WORKING_BYTES,
        PUMA_MAX_WORKING_BYTES,
    )
    context = _selection(request["context_selection"])
    output = _selection(request["output_selection"])
    if context["x"] != 0 or context["y"] != 0:
        raise ValueError("PUMA normalization context must begin at the native source origin")
    if max(context["width"], context["height"]) > PUMA_MAX_CONTEXT_EDGE:
        raise ValueError("PUMA normalization context exceeds the 1024-pixel native bound")
    if any(output[key] != context[key] for key in ("z", "t", "c", "level")):
        raise ValueError("PUMA output and normalization context must use the same exact plane")
    if (
        output["x"] + output["width"] > context["width"]
        or output["y"] + output["height"] > context["height"]
    ):
        raise ValueError("PUMA output ROI exceeds the normalization context")
    return _clone(request)


def _source_binding(source):
    return {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "source_kind": source["source_kind"],
        "metadata_sha256": _hash(source["metadata"]),
    }


def _validate_source_request(source, request):
    metadata = source.get("metadata", {})
    dimensions = metadata.get("dimensions", {})
    if (
        source.get("id") != request["source_id"]
        or source.get("sha256") != request["source_sha256"]
        or source.get("source_kind") != "native"
        or metadata.get("sha256") != source["sha256"]
        or metadata.get("selected_series") != request["series"]
        or metadata.get("sample_semantics") not in {"RGB", "RGBA"}
    ):
        raise ValueError("PUMA requires its exact registered native RGB/RGBA source and series")
    for axis in ("x", "y", "z", "t", "c", "s"):
        integer(dimensions.get(axis), f"native {axis} size", 1, 2**31 - 1)
    samples = 3 if metadata["sample_semantics"] == "RGB" else 4
    if (
        dimensions["s"] != samples
        or dimensions["c"] != 1
        or metadata.get("channel_dtypes") != ["uint8"]
    ):
        # Registered JSON may store the originally tuple-valued dtype list as a
        # list. No scalar channels, palette expansion or RGB channel set is inferred.
        raise ValueError("PUMA supports one native uint8 RGB/RGBA sample plane")
    context = request["context_selection"]
    if context["width"] != dimensions["x"] or context["height"] != dimensions["y"]:
        raise ValueError("PUMA must normalize the complete native image plane, never a viewport")
    if context["z"] >= dimensions["z"] or context["t"] >= dimensions["t"]:
        raise ValueError("PUMA context plane is outside the registered acquisition")


def _source(project, request, check, *, verify):
    _check(check)
    source = project.source(request["source_id"], verify=verify, check=check)
    _validate_source_request(source, request)
    _check(check)
    return source


def _backend_request(request):
    context, output = request["context_selection"], request["output_selection"]
    return {
        "source_sha256": request["source_sha256"],
        "source_kind": "native",
        "source_shape_yx": [context["height"], context["width"]],
        "series": request["series"],
        "context_selection": copy.deepcopy(context),
        "output_roi_yxhw": [output["y"], output["x"], output["height"], output["width"]],
        "rgb_policy": PUMA_RGB_POLICY,
    }


def _weights_identity(weights):
    if type(weights) is not backend.ApprovedPumaWeights:
        raise ValueError("PUMA execution requires trusted caller-provided ApprovedPumaWeights")
    weights.validate()
    if weights.path.resolve(strict=False) != weights.path:
        raise ValueError("Approved PUMA weight path contains a link")
    identity = backend._identity(weights.path)
    if identity[2] != weights.size_bytes:
        raise ValueError("Approved PUMA weights changed size")
    return identity


def _verify_weights(weights, check):
    # Reuse the backend's no-symlink, stable-descriptor, exact-hash boundary.
    with backend._verified_weights(weights, check=check):
        pass


def _runtime_record_valid(runtime):
    if not isinstance(runtime, dict):
        raise ValueError("PUMA runtime record is missing")
    _exact(
        runtime,
        {
            "numeric_profile",
            "versions",
            "python_version",
            "platform",
            "machine",
            "torch_git_version",
            "torch_build_configuration_sha256",
            "device",
            "intra_op_threads",
            "inter_op_threads",
            "deterministic_algorithms",
            "autocast",
            "runtime_import_verified",
            "technical_compatibility_verified",
            "modeling_prototype_parity",
            "official_cuda_runtime_parity",
            "added_serialization_globals",
            "serialization_policy",
        },
        "PUMA runtime",
    )
    required = {
        "serialization_policy": {
            "load_window": "zero-added-globals-weights-only-cpu",
            "known_torch_defaults": "identity-checked-cleared-for-load-restored-afterward",
            "process_ownership": "exclusive-disposable-worker-required",
        },
        "numeric_profile": PUMA_NUMERIC_PROFILE,
        "versions": dict(PUMA_RUNTIME_VERSIONS),
        "torch_git_version": PUMA_TORCH_GIT_VERSION,
        "device": "cpu",
        "intra_op_threads": 1,
        "deterministic_algorithms": True,
        "autocast": False,
        "runtime_import_verified": True,
        "technical_compatibility_verified": False,
        "modeling_prototype_parity": "unverified-distinct-runtime",
        "official_cuda_runtime_parity": "unverified",
        "added_serialization_globals": [],
    }
    if any(not _same(runtime.get(key), value) for key, value in required.items()):
        raise ValueError("PUMA runtime differs from the exact candidate numeric profile")
    _sha(runtime.get("torch_build_configuration_sha256"))
    if type(runtime.get("python_version")) is not str or not runtime["python_version"].startswith(
        "3.12."
    ):
        raise ValueError("PUMA runtime Python identity is invalid")
    integer(runtime.get("inter_op_threads"), "PUMA inter-op threads", 1, 1024)
    for key in ("platform", "machine"):
        if type(runtime.get(key)) is not str or not 1 <= len(runtime[key]) <= 512:
            raise ValueError("PUMA runtime host identity is invalid")


def _validate_inference_metadata(record):
    _exact(
        record,
        {
            "schema",
            "status",
            "adopted",
            "profile",
            "profile_id",
            "request",
            "decoding",
            "preprocessing",
            "tiles",
            "resource_preflight",
            "runtime",
            "weights_validation",
            "execution",
            "artifacts",
        },
        "PUMA inference",
    )
    if record["profile_id"] != PUMA_PROFILE_ID:
        raise ValueError("PUMA inference profile identity changed")
    _exact(
        record["execution"],
        {
            "network_calls",
            "model_forward_executed",
            "gaussian_sha256",
            "class_map",
            "selected_class",
            "scores_are_validated_confidence",
        },
        "PUMA execution semantics",
    )
    if not _same(
        record["weights_validation"],
        {
            "tensor_keys": 396,
            "unique_storages": 148,
            "tensor_bytes": PUMA_TENSOR_BYTES,
            "finite_values_checked": True,
            "aliases_checked": True,
        },
    ):
        raise ValueError("PUMA exact tensor validation record changed")


def _validate_inference(inference, context, expected_plan, check):
    _check(check)
    if type(inference) is not backend.PumaInference:
        raise ValueError("PUMA backend returned an unsupported inference record")
    record = _clone(dict(inference.record))
    _validate_inference_metadata(record)
    if (
        record.get("schema") != "loci.puma-inference/v1"
        or record.get("adopted") is not False
        or record.get("status") != "executed-not-qualified"
    ):
        raise ValueError("PUMA backend did not return an unadopted candidate inference")
    if record.get("profile_id") != PUMA_PROFILE_ID or not _same(
        record.get("profile"), puma_profile()
    ):
        raise ValueError("PUMA backend profile identity changed")
    for key in ("request", "decoding", "preprocessing", "tiles", "resource_preflight"):
        if not _same(record.get(key), expected_plan[key]):
            raise ValueError("PUMA backend normalization context, decode or tile plan changed")
    if record["decoding"]["decoded_array_sha256"] != _array_hash(context):
        raise ValueError("PUMA backend source bytes changed")
    _runtime_record_valid(record.get("runtime"))
    execution = record.get("execution", {})
    if (
        execution.get("class_map") != {str(i): name for i, name in enumerate(PUMA_CLASS_NAMES)}
        or execution.get("selected_class") != PUMA_EPIDERMIS_CLASS
        or execution.get("scores_are_validated_confidence") is not False
        or execution.get("network_calls") != record["tiles"]["planned_network_calls"]
        or execution.get("model_forward_executed") != bool(record["tiles"]["tiles"])
    ):
        raise ValueError("PUMA backend execution/class semantics changed")
    _sha(execution.get("gaussian_sha256"))
    height, width = record["request"]["output_roi_yxhw"][2:]
    specs = {
        "class_labels": (np.dtype("uint8"), (height, width)),
        "probabilities": (np.dtype("float32"), (6, height, width)),
        "logits": (np.dtype("float16"), (6, height, width)),
        "epidermis_mask": (np.dtype("bool"), (height, width)),
        "computed_mask": (np.dtype("bool"), (height, width)),
        "weight_sum": (np.dtype("float16"), (height, width)),
    }
    if set(inference.arrays) != set(specs) or set(record.get("artifacts", {})) != set(specs):
        raise ValueError("PUMA backend original artifacts are incomplete")
    for name, (dtype, shape) in specs.items():
        _check(check)
        array = inference.arrays[name]
        if (
            type(array) is not np.ndarray
            or array.dtype != dtype
            or array.shape != shape
            or not np.isfinite(array).all()
        ):
            raise ValueError("PUMA backend artifact shape, dtype or finite range is invalid")
        if not _same(record["artifacts"][name], _descriptor(array)):
            raise ValueError("PUMA backend original artifact hash changed")
    probabilities = inference.arrays["probabilities"]
    classes = inference.arrays["class_labels"]
    _original_arrays_valid(classes, probabilities, probabilities[PUMA_EPIDERMIS_CLASS])
    computed, weights = inference.arrays["computed_mask"], inference.arrays["weight_sum"]
    if not np.array_equal(computed, weights > 0) or np.any(weights < 0):
        raise ValueError("PUMA accumulation coverage/weights disagree")
    expected_computed = np.zeros((height, width), dtype=bool)
    bbox = record["tiles"]["computed_bbox_output_yx"]
    if bbox is not None:
        (y0, y1), (x0, x1) = bbox
        expected_computed[y0:y1, x0:x1] = True
    if not np.array_equal(computed, expected_computed):
        raise ValueError("PUMA computed region differs from the full-context tile plan")
    if not np.array_equal(inference.arrays["epidermis_mask"], classes == PUMA_EPIDERMIS_CLASS):
        raise ValueError("PUMA class-4 mask differs from the original argmax labels")
    if (
        np.any(classes[~computed] != 0)
        or np.any(probabilities[0, ~computed] != 1)
        or np.any(probabilities[1:, ~computed] != 0)
    ):
        raise ValueError("PUMA outside-context predictions are not the original background")
    _check(check)
    return record


def _original_arrays_valid(classes, probabilities, image):
    if (
        classes.dtype != np.uint8
        or classes.ndim != 2
        or probabilities.dtype != np.float32
        or probabilities.shape != (6, *classes.shape)
        or image.dtype != np.float32
        or image.shape != classes.shape
        or np.any(classes > 5)
        or not np.isfinite(probabilities).all()
        or np.any(probabilities < 0)
        or np.any(probabilities > 1)
        or not np.allclose(
            probabilities.sum(axis=0, dtype=np.float32),
            1,
            rtol=0,
            atol=8 * np.finfo(np.float32).eps,
        )
        or not np.array_equal(classes, np.argmax(probabilities, axis=0))
        or not np.array_equal(image, probabilities[PUMA_EPIDERMIS_CLASS])
    ):
        raise ValueError("Original six-class predictions/score plane are inconsistent")


def _regions(labels, geometry, working_bytes, check):
    _check(check)
    if type(labels) is not np.ndarray or labels.dtype != np.uint32 or labels.ndim != 2:
        raise ValueError("Editable tissue regions require uint32 YX labels")
    ids = np.unique(labels)
    count = int(np.count_nonzero(ids))
    if count > MAX_REGIONS:
        raise ValueError("Tissue model result exceeds the 4096 connected-region limit")
    rows = measure_objects(labels, geometry, {}, working_bytes=working_bytes)
    _check(check)
    if len(rows) != count or any(row["intensity"] for row in rows):
        raise ValueError("Tissue measurements must contain geometry only")
    return rows


def _label_statistics(labels, rows):
    pixels = int(np.count_nonzero(labels))
    return {
        "sha256": _array_hash(labels),
        "region_count": len(rows),
        "pixel_count": pixels,
        "fraction": pixels / labels.size,
    }


def _preview_image(context, output, labels):
    from .workbench import _png

    y, x, height, width = (output[key] for key in ("y", "x", "height", "width"))
    step = max(1, (max(height, width) + PREVIEW_EDGE - 1) // PREVIEW_EDGE)
    overlay = context[y : y + height : step, x : x + width : step, :3].copy()
    mask = labels[::step, ::step] > 0
    overlay[mask] = np.round(overlay[mask] * 0.5 + np.array([0, 210, 140]) * 0.5).astype(np.uint8)
    png = _png(overlay)
    return png, {
        "encoding": "data-url-png-rgb",
        "encoded_sha256": hashlib.sha256(png.encode()).hexdigest(),
        "shape_yxs": list(overlay.shape),
        "source_step_yx": [step, step],
        "method": "nearest-sampled-RGB-with-class4-region-overlay",
        "display_only": True,
    }


def _compute(workbench, request, weights, check):
    request = validate_request(request)
    source = _source(workbench.project, request, check, verify=True)
    binding = _source_binding(source)
    weight_identity = _weights_identity(weights)
    metadata_status = _clone(runtime_metadata_status())
    if metadata_status.get("status") != "metadata-matches-unverified":
        raise ValueError("The exact PUMA runtime is unavailable or mismatched before source decode")
    _check(check)
    session = workbench._session(source["id"], check=check)
    if not _same(asdict(session.metadata), source["metadata"]):
        raise ValueError("Native source metadata changed after registration")
    # The generic scalar helper does not propagate a live check through source
    # hashing. Keep this bounded native plane decode explicit and guarded.
    selection = request["context_selection"]
    session.verify_strict(check=check)
    _check(check)
    native_selection = NativeSelection(
        **selection,
        series=request["series"],
        budget_bytes=min(MAX_NATIVE_READ_BUDGET_BYTES, request["working_bytes"]),
        expected_sha256=request["source_sha256"],
    )
    region = session.read_region(native_selection)
    _check(check)
    session.verify_strict(check=check)
    if (
        region.selection != native_selection
        or region.sha256 != request["source_sha256"]
        or region.axes != "YXS"
        or region.native_dtype != "uint8"
    ):
        raise ValueError("PUMA native decoder changed source, samples, selection or dtype")
    context = np.array(region.pixels)
    context_geometry = workbench._native_geometry(session, selection, False)
    if context_geometry.axes != "YX":
        raise ValueError("PUMA decoder changed its exact context or spatial axes")
    if _weights_identity(weights) != weight_identity:
        raise ValueError("Approved PUMA weights changed before inference")
    accepted = _backend_request(request)
    planned = backend.plan_puma(
        context, accepted, working_bytes=request["working_bytes"], check=check
    )
    inference = backend.infer_puma(
        context, accepted, weights=weights, working_bytes=request["working_bytes"], check=check
    )
    record = _validate_inference(inference, context, planned, check)
    output = request["output_selection"]
    geometry = context_geometry.cropped((output["y"], output["x"]))
    labels, count = ndi.label(
        inference.arrays["class_labels"] == PUMA_EPIDERMIS_CLASS, output=np.uint32
    )
    if count > MAX_REGIONS:
        raise ValueError("PUMA selected class exceeds the 4096 connected-region limit")
    rows = _regions(labels, geometry, request["working_bytes"], check)
    arrays = {
        "class_labels": np.array(inference.arrays["class_labels"], copy=True),
        "probabilities": np.array(inference.arrays["probabilities"], copy=True),
        "image": np.array(inference.arrays["probabilities"][PUMA_EPIDERMIS_CLASS], copy=True),
        "labels": labels,
    }
    for array in arrays.values():
        array.flags.writeable = False
    png, display = _preview_image(context, output, labels)
    _check(check)
    if _source_binding(_source(workbench.project, request, check, verify=True)) != binding:
        raise ValueError("PUMA source changed during computation")
    if _weights_identity(weights) != weight_identity or not _same(
        runtime_metadata_status(), metadata_status
    ):
        raise ValueError("PUMA trusted weights or runtime metadata changed during computation")
    receipt = {
        "schema": PREVIEW_SCHEMA,
        "request": request,
        "source": binding,
        "context_geometry": _clone(context_geometry.to_dict()),
        "geometry": _clone(geometry.to_dict()),
        "inference": record,
        "artifacts": {name: _descriptor(array) for name, array in arrays.items()},
        "labels": _label_statistics(labels, rows),
        "measurements_sha256": _hash(rows),
        "connectivity": CONNECTIVITY,
        "entity_type": "tissue-region",
        "regions_are_cells": False,
        "display": display,
        "scientific_review": "pending",
    }
    _validate_receipt(receipt)
    return receipt, arrays, rows, png, weight_identity, metadata_status


def _validate_receipt(receipt):
    _exact(
        receipt,
        {
            "schema",
            "request",
            "source",
            "context_geometry",
            "geometry",
            "inference",
            "artifacts",
            "labels",
            "measurements_sha256",
            "connectivity",
            "entity_type",
            "regions_are_cells",
            "display",
            "scientific_review",
        },
        "PUMA preview receipt",
    )
    if (
        receipt["schema"] != PREVIEW_SCHEMA
        or receipt["connectivity"] != CONNECTIVITY
        or receipt["entity_type"] != "tissue-region"
        or receipt["regions_are_cells"] is not False
        or receipt["scientific_review"] != "pending"
    ):
        raise ValueError("Invalid PUMA preview semantics")
    request = validate_request(receipt["request"])
    _exact(
        receipt["source"],
        {"source_id", "source_sha256", "source_kind", "metadata_sha256"},
        "PUMA source binding",
    )
    if (
        receipt["source"]["source_id"] != request["source_id"]
        or receipt["source"]["source_sha256"] != request["source_sha256"]
        or receipt["source"]["source_kind"] != "native"
    ):
        raise ValueError("PUMA receipt source binding differs from its request")
    _sha(receipt["source"]["metadata_sha256"])
    context_geometry = _geometry(receipt["context_geometry"])
    output = request["output_selection"]
    geometry = _geometry(receipt["geometry"])
    if not _same(
        context_geometry.cropped((output["y"], output["x"])).to_dict(), geometry.to_dict()
    ):
        raise ValueError("PUMA ROI geometry is not the exact full-context crop transform")
    inference = receipt["inference"]
    _validate_inference_metadata(inference)
    if (
        not isinstance(inference, dict)
        or inference.get("schema") != "loci.puma-inference/v1"
        or inference.get("adopted") is not False
        or inference.get("status") != "executed-not-qualified"
        or not _same(inference.get("profile"), puma_profile())
    ):
        raise ValueError("PUMA retained inference profile is invalid")
    _runtime_record_valid(inference.get("runtime"))
    backend_request = _backend_request(request)
    expected_accepted = {
        **backend_request,
        "output_selection": output,
        "roi_changes_context": False,
        "context_authorization": "caller-must-grant-entire-context-before-decoding",
    }
    if not _same(inference.get("request"), expected_accepted):
        raise ValueError("PUMA retained inference context differs from the accepted request")
    shape = [output["height"], output["width"]]
    inference_dtypes = {
        "class_labels": "uint8",
        "probabilities": "float32",
        "logits": "float16",
        "epidermis_mask": "bool",
        "computed_mask": "bool",
        "weight_sum": "float16",
    }
    _exact(inference["artifacts"], inference_dtypes, "PUMA original inference descriptors")
    for name, dtype in inference_dtypes.items():
        descriptor = inference["artifacts"][name]
        _exact(descriptor, {"axes", "shape", "dtype", "sha256"}, "PUMA original descriptor")
        channels = name in {"probabilities", "logits"}
        if (
            descriptor["shape"] != ([6, *shape] if channels else shape)
            or descriptor["axes"] != ("CYX" if channels else "YX")
            or descriptor["dtype"] != dtype
        ):
            raise ValueError("PUMA original inference descriptor dimensions or type changed")
        _sha(descriptor["sha256"])
    expected_class_map = {str(i): name for i, name in enumerate(PUMA_CLASS_NAMES)}
    execution = inference.get("execution", {})
    if (
        execution.get("class_map") != expected_class_map
        or execution.get("selected_class") != PUMA_EPIDERMIS_CLASS
        or execution.get("scores_are_validated_confidence") is not False
    ):
        raise ValueError("PUMA retained class semantics changed")
    _sha(execution.get("gaussian_sha256"))
    _exact(receipt["artifacts"], _RESULT_ARRAYS, "PUMA retained output descriptors")
    shape = [output["height"], output["width"]]
    for name, descriptor in receipt["artifacts"].items():
        _exact(descriptor, {"axes", "shape", "dtype", "sha256"}, "PUMA array descriptor")
        dtype = {
            "image": "float32",
            "labels": "uint32",
            "class_labels": "uint8",
            "probabilities": "float32",
        }[name]
        if (
            descriptor["shape"] != ([6, *shape] if name == "probabilities" else shape)
            or descriptor["dtype"] != dtype
            or descriptor["axes"] != ("CYX" if name == "probabilities" else "YX")
        ):
            raise ValueError("PUMA array descriptor dimensions or type changed")
        _sha(descriptor["sha256"])
    for name in ("class_labels", "probabilities"):
        if not _same(receipt["artifacts"][name], inference.get("artifacts", {}).get(name)):
            raise ValueError("PUMA original model array descriptor changed")
    _label_statistics_valid(receipt["labels"], shape)
    if receipt["labels"]["sha256"] != receipt["artifacts"]["labels"]["sha256"]:
        raise ValueError("PUMA initial label identity changed")
    _sha(receipt["measurements_sha256"])
    if len(canonical_json(receipt).encode()) > MAX_PREVIEW_BYTES:
        raise ValueError("PUMA preview metadata exceeds its bounded byte limit")
    return receipt


def _label_statistics_valid(stats, shape):
    _exact(stats, {"sha256", "region_count", "pixel_count", "fraction"}, "PUMA label statistics")
    _sha(stats["sha256"])
    integer(stats["region_count"], "region count", 0, MAX_REGIONS)
    integer(stats["pixel_count"], "mask pixel count", 0, shape[0] * shape[1])
    if type(stats["fraction"]) not in {int, float} or stats["fraction"] != stats["pixel_count"] / (
        shape[0] * shape[1]
    ):
        raise ValueError("PUMA retained mask fraction changed")


def _token(request):
    _exact(request, {"preview_id", "preview_hash"}, "PUMA preview token")
    checked_id(request["preview_id"])
    _sha(request["preview_hash"])
    return dict(request)


def peek_preview(project, request):
    """Internal metadata lookup. Possession of this token grants no source access."""
    token = _token(request)
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", (PREVIEW_PREFIX + token["preview_id"],)
        ).fetchone()
    if row is None:
        raise ValueError("Tissue model preview is unavailable or evicted; preview again")
    if len(row[0].encode()) > MAX_PREVIEW_BYTES + 1024:
        raise ValueError("Stored tissue preview exceeds the bounded metadata size")
    stored = parse_json(row[0])
    _exact(stored, {"preview_id", "preview_hash", "created_at", "receipt"}, "stored PUMA preview")
    if (
        stored["preview_id"] != token["preview_id"]
        or stored["preview_hash"] != token["preview_hash"]
        or _hash(stored["receipt"]) != token["preview_hash"]
    ):
        raise ValueError("Tissue model preview identity or receipt changed")
    _validate_receipt(stored["receipt"])
    return stored


def source_bindings(project, operation, request):
    """Trusted grant-preflight helper; authorize both entries before execute()."""
    accepted = (
        peek_preview(project, request)["receipt"]["request"]
        if operation == "tissue_model_run"
        else validate_request(request)
    )
    if operation not in {"tissue_model_status", "tissue_model_preview", "tissue_model_run"}:
        raise ValueError("Unknown tissue model operation")
    return [
        {
            "source_id": accepted["source_id"],
            "source_sha256": accepted["source_sha256"],
            "series": accepted["series"],
            "selection": copy.deepcopy(accepted[name]),
            "purpose": purpose,
        }
        for name, purpose in (
            ("context_selection", "normalization-context"),
            ("output_selection", "output-region"),
        )
    ]


def task_source(project, request):
    """Source locator for durable job normalization; not an authority grant."""
    return peek_preview(project, request)["receipt"]["request"]["source_id"]


def _cache_preview(project, receipt, check):
    _validate_receipt(receipt)
    record = {
        "preview_id": uuid.uuid4().hex,
        "preview_hash": _hash(receipt),
        "created_at": timestamp(),
        "receipt": receipt,
    }
    encoded = canonical_json(record)
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _check(check)
        connection.execute(
            "INSERT INTO metadata VALUES(?,?)", (PREVIEW_PREFIX + record["preview_id"], encoded)
        )
        cached = connection.execute(
            "SELECT key,value FROM metadata WHERE key LIKE ?", (PREVIEW_PREFIX + "%",)
        ).fetchall()
        # New record wins ties; never inspect another preview's source or arrays.
        cached.sort(
            key=lambda row: (row[0] == PREVIEW_PREFIX + record["preview_id"], row[0]), reverse=True
        )
        used = kept = 0
        for key, value in cached:
            size = len(value.encode())
            if kept >= MAX_PREVIEWS or used + size > MAX_CACHE_BYTES:
                connection.execute("DELETE FROM metadata WHERE key=?", (key,))
            else:
                used += size
                kept += 1
        _check(check)
    return {key: record[key] for key in ("preview_id", "preview_hash")}


def _job_guard(project, job_id, request, source_id):
    if job_id is None:
        return
    job = project.job(checked_id(job_id))
    normalized = {"source_id": source_id, "task_request": request}
    if (
        job["operation"] != "tissue_model_run"
        or job["state"] != "running"
        or job["cancel_requested"]
        or job["request"] != normalized
        or job["request_hash"] != _hash({"operation": "tissue_model_run", "request": normalized})
    ):
        raise ValueError("Tissue model publication requires its exact running job")


def execute(workbench, operation, request, *, check: Check, weights=None, job_id=None):
    """Status/preview/run shared API; caller owns grants and disposable-worker limits."""
    _check(check)
    if operation == "tissue_model_status":
        accepted = validate_request(request)
        source = _source(workbench.project, accepted, check, verify=False)
        status = backend.inspect_puma_status(weights, verify_weights=False)
        _check(check)
        return {
            "source": _source_binding(source),
            "request": accepted,
            "status": status,
            "source_verification": "registered-metadata-only",
            "adopted": False,
        }
    if operation not in {"tissue_model_preview", "tissue_model_run"}:
        raise ValueError("Unknown tissue model operation")
    stored = peek_preview(workbench.project, request) if operation == "tissue_model_run" else None
    accepted = stored["receipt"]["request"] if stored else validate_request(request)
    token = _token(request) if stored else None
    if stored:
        _job_guard(workbench.project, job_id, token, accepted["source_id"])
    receipt, arrays, rows, png, weight_identity, metadata_status = _compute(
        workbench, accepted, weights, check
    )
    if stored and not _same(receipt, stored["receipt"]):
        raise ValueError("Source, runtime, context or prediction changed after the exact preview")

    def guard():
        _check(check)
        if (
            _source_binding(_source(workbench.project, accepted, check, verify=True))
            != receipt["source"]
        ):
            raise ValueError("Tissue source metadata changed before publication")
        if (
            puma_profile()["contract_sha256"] != accepted["profile_contract_sha256"]
            or not _same(runtime_metadata_status(), metadata_status)
            or _weights_identity(weights) != weight_identity
        ):
            raise ValueError("Tissue model/profile/runtime changed before publication")
        _verify_weights(weights, check)
        if stored:
            if not _same(peek_preview(workbench.project, token), stored):
                raise ValueError("Tissue preview changed before publication")
            _job_guard(workbench.project, job_id, token, accepted["source_id"])
        for name, array in arrays.items():
            _check(check)
            if not _same(_descriptor(array), receipt["artifacts"][name]):
                raise ValueError("Tissue output changed before publication")
        _check(check)

    if operation == "tissue_model_preview":
        token = _cache_preview(workbench.project, receipt, guard)
        return {
            **token,
            "adopted": False,
            "region_count": len(rows),
            "selected_class": PUMA_EPIDERMIS_CLASS,
            "entity_type": "tissue-region",
            "output_selection": accepted["output_selection"],
            "context_selection": accepted["context_selection"],
            "overlay_png": png,
            "scientific_review": "pending",
        }
    provenance = {
        "geometry": receipt["geometry"],
        "selection": accepted["output_selection"],
        "measurement_channels": [],
        "measurement_basis": MEASUREMENT_BASIS,
        "measurements": rows,
        "working_bytes": accepted["working_bytes"],
        "runtime": receipt["inference"]["runtime"],
        "tissue_model": {
            "schema": SCHEMA,
            "preview": token,
            "receipt": receipt,
            "label_semantics": "original_selected_compartment",
            "effective_labels": receipt["labels"],
            "initial_statistics_apply_to_effective_labels": True,
            "correction_parent": None,
        },
    }
    from .research_tissue_integration import policy_runtime

    provenance["host_runtime"] = policy_runtime()
    if job_id is not None:
        provenance["job_id"] = job_id
    guard()
    _validate_payload(provenance, arrays, check)
    result = workbench.project.save_result(
        source_id=accepted["source_id"],
        kind=KIND,
        arrays=arrays,
        provenance=provenance,
        job_id=job_id,
        publication_guard=guard,
    )
    from .workbench import result_summary

    return {
        "adopted": True,
        "result": {
            **result_summary(result),
            "entity_type": "tissue-region",
            "region_count": len(rows),
        },
        "region_count": len(rows),
        "measurements": rows[:1000],
        "total_measurements": len(rows),
    }


def _validate_payload(provenance, arrays, check):
    """Pure original/effective-array and geometric arithmetic checks, no runtime load."""
    _check(check)
    tissue = provenance["tissue_model"]
    receipt = _validate_receipt(tissue["receipt"])
    if set(arrays) != _RESULT_ARRAYS:
        raise ValueError("Tissue result must preserve original classes, probabilities and score")
    shape = tuple(receipt["artifacts"]["labels"]["shape"])
    for name, array in arrays.items():
        _check(check)
        expected = receipt["artifacts"][name]
        if (
            not isinstance(array, np.ndarray)
            or list(array.shape) != expected["shape"]
            or str(array.dtype) != expected["dtype"]
        ):
            raise ValueError("Tissue retained array has an unsupported shape or dtype")
        if name in _ORIGINAL_ARRAYS and not _same(_descriptor(array), expected):
            raise ValueError("Original model arrays were changed or confused with edited labels")
    _original_arrays_valid(arrays["class_labels"], arrays["probabilities"], arrays["image"])
    if not _same(
        _descriptor(arrays["class_labels"] == PUMA_EPIDERMIS_CLASS),
        receipt["inference"]["artifacts"]["epidermis_mask"],
    ):
        raise ValueError("Original class-4 mask descriptor differs from immutable predictions")
    geometry = _geometry(provenance["geometry"])
    rows = _regions(arrays["labels"], geometry, provenance["working_bytes"], check)
    if not _same(rows, provenance["measurements"]) or not _same(
        _label_statistics(arrays["labels"], rows), tissue["effective_labels"]
    ):
        raise ValueError("Tissue effective geometry measurements or mask statistics changed")
    if tissue["label_semantics"] == "original_selected_compartment":
        expected_labels, _ = ndi.label(
            arrays["class_labels"] == PUMA_EPIDERMIS_CLASS, output=np.uint32
        )
        if (
            not np.array_equal(arrays["labels"], expected_labels)
            or not _same(_descriptor(arrays["labels"]), receipt["artifacts"]["labels"])
            or _hash(rows) != receipt["measurements_sha256"]
        ):
            raise ValueError(
                "Unedited tissue labels are not the original class-4 connected regions"
            )
    elif tissue["label_semantics"] != "edited_selected_compartment":
        raise ValueError("Unknown tissue label semantics")
    if arrays["labels"].shape != shape:
        raise ValueError("Tissue labels no longer occupy their original output grid")
    _check(check)


def _result_binding(record):
    return {
        "result_id": record["id"],
        "revision_hash": record["revision_hash"],
        "record_sha256": _hash(record),
        "labels_sha256": record["arrays"]["labels"]["sha256"],
    }


def validate_record(result):
    """Historical metadata validator; requires no weights, Torch or source file."""
    if (
        result.get("schema") != "loci.research-result/v1"
        or type(result.get("provenance")) is not dict
    ):
        raise ValueError("Unsupported tissue model result schema")
    checked_id(result.get("id"))
    checked_id(result.get("source_id"))
    _sha(result.get("source_sha256"))
    provenance = result["provenance"]
    from .research_tissue_integration import validate_host_runtime

    validate_host_runtime(provenance.get("host_runtime"), engine_version=result["engine_version"])
    tissue = provenance.get("tissue_model")
    _exact(
        tissue,
        {
            "schema",
            "preview",
            "receipt",
            "label_semantics",
            "effective_labels",
            "initial_statistics_apply_to_effective_labels",
            "correction_parent",
        },
        "tissue result provenance",
    )
    if tissue["schema"] != SCHEMA:
        raise ValueError("Unsupported tissue model provenance version")
    receipt = _validate_receipt(tissue["receipt"])
    token = _token(tissue["preview"])
    if token["preview_hash"] != _hash(receipt):
        raise ValueError("Tissue result lost its original exact preview receipt")
    accepted = receipt["request"]
    if (
        result["source_id"] != accepted["source_id"]
        or result["source_sha256"] != accepted["source_sha256"]
        or not _same(provenance.get("selection"), accepted["output_selection"])
        or not _same(provenance.get("geometry"), receipt["geometry"])
    ):
        raise ValueError("Tissue result source/ROI/geometry binding changed")
    if (
        provenance.get("measurement_channels") != []
        or provenance.get("measurement_basis") != MEASUREMENT_BASIS
        or provenance.get("working_bytes") != accepted["working_bytes"]
        or not _same(provenance.get("runtime"), receipt["inference"]["runtime"])
    ):
        raise ValueError("Tissue result must retain geometry-only measurements and exact runtime")
    artifacts = result.get("arrays")
    if not isinstance(artifacts, dict) or set(artifacts) != _RESULT_ARRAYS:
        raise ValueError("Tissue result is missing immutable original model arrays")
    for name, descriptor in artifacts.items():
        expected = receipt["artifacts"][name]
        if (
            not isinstance(descriptor, dict)
            or descriptor.get("shape") != expected["shape"]
            or descriptor.get("dtype") != expected["dtype"]
        ):
            raise ValueError("Tissue array artifact descriptor changed shape or dtype")
        _sha(descriptor.get("sha256"))
    _label_statistics_valid(tissue["effective_labels"], receipt["artifacts"]["labels"]["shape"])
    rows = provenance.get("measurements")
    if (
        not isinstance(rows, list)
        or len(rows) != tissue["effective_labels"]["region_count"]
        or any(not isinstance(row, dict) or row.get("intensity") != {} for row in rows)
    ):
        raise ValueError("Tissue region measurement rows are invalid")
    if tissue["label_semantics"] == "original_selected_compartment":
        if (
            result.get("kind") != KIND
            or result.get("parent_id") is not None
            or tissue["correction_parent"] is not None
            or tissue["initial_statistics_apply_to_effective_labels"] is not True
            or not _same(tissue["effective_labels"], receipt["labels"])
            or _hash(rows) != receipt["measurements_sha256"]
        ):
            raise ValueError("Original tissue prediction is incorrectly marked as edited")
    elif tissue["label_semantics"] == "edited_selected_compartment":
        if (
            result.get("kind") != "corrected-labels"
            or tissue["initial_statistics_apply_to_effective_labels"] is not False
        ):
            raise ValueError("Edited tissue regions cannot claim original six-class predictions")
        parent = tissue["correction_parent"]
        _exact(
            parent,
            {"result_id", "revision_hash", "record_sha256", "labels_sha256"},
            "tissue correction parent",
        )
        checked_id(parent["result_id"])
        for key in ("revision_hash", "record_sha256", "labels_sha256"):
            _sha(parent[key])
        if result.get("parent_id") != parent["result_id"] or result["id"] == parent["result_id"]:
            raise ValueError("Tissue correction is missing its exact parent")
    else:
        raise ValueError("Unknown tissue label semantics")
    canonical_json(result)
    return result


def validate_source(result, source):
    validate_record(result)
    receipt = result["provenance"]["tissue_model"]["receipt"]
    _validate_source_request(source, receipt["request"])
    if not _same(_source_binding(source), receipt["source"]):
        raise ValueError("Historical tissue source metadata changed or fingerprint mismatched")
    # Reconstruct only metadata, using the same pure rules as NativeImageSession.
    # A self-consistent forged receipt cannot redefine the registered calibration.
    level = source["metadata"]["levels"][0]
    calibration = level["calibration"]
    native_level = NativeLevel(
        index=level["index"],
        dimensions=NativeDimensions(**level["dimensions"]),
        calibration=PhysicalCalibration(**calibration) if calibration is not None else None,
        origin_xyz=level.get("origin_xyz"),
    )
    expected = native_geometry((native_level,), receipt["request"]["context_selection"], False)
    if not _same(expected.to_dict(), receipt["context_geometry"]):
        raise ValueError("Tissue geometry differs from the registered native source calibration")


def validate_parent(result, parent):
    validate_record(result)
    validate_record(parent)
    tissue = result["provenance"]["tissue_model"]
    if tissue["label_semantics"] != "edited_selected_compartment" or not _same(
        tissue["correction_parent"], _result_binding(parent)
    ):
        raise ValueError("Tissue correction parent revision or artifacts changed")
    if not _same(tissue["receipt"], parent["provenance"]["tissue_model"]["receipt"]) or not _same(
        tissue["preview"], parent["provenance"]["tissue_model"]["preview"]
    ):
        raise ValueError("Tissue correction lost the original six-class prediction receipt")
    for name in _ORIGINAL_ARRAYS:
        if not _same(result["arrays"][name], parent["arrays"][name]):
            raise ValueError("Correction changed an immutable original model array")


def validate_arrays(result, arrays, *, parent=None, check: Check):
    validate_record(result)
    if result["provenance"]["tissue_model"]["label_semantics"] == "edited_selected_compartment":
        if parent is None:
            raise ValueError("Edited tissue validation requires its exact original parent record")
        validate_parent(result, parent)
    elif parent is not None:
        raise ValueError("Original tissue prediction cannot declare a correction parent")
    _validate_payload(result["provenance"], arrays, check)


def prepare_correction(parent, arrays, edited_labels, *, check: Check):
    """Prepare immutable originals + edited geometry for the existing correction writer.

    The caller must validate its full ancestry first (validate_portable_references
    or equivalent project resolver), and supply the exact already-verified parent
    arrays. This helper publishes nothing and grants no editing authority.
    """
    validate_record(parent)
    _validate_payload(parent["provenance"], arrays, check)
    if (
        not isinstance(edited_labels, np.ndarray)
        or edited_labels.dtype != np.uint32
        or edited_labels.shape != arrays["labels"].shape
    ):
        raise ValueError("Edited tissue labels must retain the exact uint32 output grid")
    labels = np.array(edited_labels, copy=True)
    labels.flags.writeable = False
    provenance = _clone(parent["provenance"])
    provenance.pop("job_id", None)
    rows = _regions(labels, _geometry(provenance["geometry"]), provenance["working_bytes"], check)
    provenance["measurements"] = rows
    tissue = provenance["tissue_model"]
    tissue.update(
        label_semantics="edited_selected_compartment",
        effective_labels=_label_statistics(labels, rows),
        initial_statistics_apply_to_effective_labels=False,
        correction_parent=_result_binding(parent),
    )
    retained = {name: arrays[name] for name in _ORIGINAL_ARRAYS}
    retained["labels"] = labels
    _validate_payload(provenance, retained, check)
    return retained, provenance


def validate_portable_references(
    result, results_by_id, sources_by_id, *, array_loader=None, check: Check
):
    """Resolve a bounded correction chain without runtime/model/raw-source access.

    With array_loader, recompute every effective geometry and verify immutable
    predictions. Without it, this is metadata preflight only, not array validation.
    """
    seen = set()
    current = result
    for _ in range(MAX_PARENT_DEPTH):
        _check(check)
        validate_record(current)
        if current["id"] in seen:
            raise ValueError("Cyclic tissue correction ancestry")
        seen.add(current["id"])
        _sha(current.get("revision_hash"))
        if current["revision_hash"] != _hash(
            {key: value for key, value in current.items() if key != "revision_hash"}
        ):
            raise ValueError("Historical tissue result revision hash changed")
        source = sources_by_id.get(current["source_id"])
        if source is None:
            raise ValueError("Historical tissue source is missing")
        validate_source(current, source)
        parent_id = current.get("parent_id")
        parent = results_by_id.get(parent_id) if parent_id else None
        if parent_id and parent is None:
            raise ValueError("Historical tissue correction parent is missing")
        if parent is not None:
            validate_parent(current, parent)
        if array_loader is not None:
            loaded = {}
            for name, descriptor in current["arrays"].items():
                _check(check)
                loaded[name] = array_loader(descriptor)
            validate_arrays(current, loaded, parent=parent, check=check)
        if parent is None:
            return result
        current = parent
    raise ValueError("Tissue correction ancestry exceeds its bounded depth")
