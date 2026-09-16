"""Durable, revision-bound physical registration and explicit resampling."""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import numpy as np
import scipy
import skimage
from scipy import ndimage as ndi

from .models import ENGINE_VERSION
from .quantitative import (
    Geometry,
    exact_keys,
    finite_number,
    integer,
    measure_objects,
    validate_array,
)
from .research_project import canonical_json, checked_id, parse_json
from .temporal import estimate_translation
from .workbench import geometry_from_dict, result_summary

if TYPE_CHECKING:
    from .workbench import Workbench

REGISTRATION_OPERATIONS = frozenset({"registration_preview", "registration_run", "resample_grid"})
PREVIEW_SCHEMA = "loci.registration-preview/v1"
DEFAULT_WORKING_BYTES = 512 * 1024**2
MAX_OUTPUTS = 8
MAX_PREVIEW_RECEIPT_BYTES = 1024 * 1024


def _guard(callback: Callable[[], None] | None) -> None:
    if callback is not None:
        callback()


def _bound_array(
    workbench: Workbench, binding: object, *, role: str
) -> tuple[dict[str, Any], dict[str, Any], Geometry, dict[str, Any]]:
    exact_keys(binding, {"result_id", "revision_hash", "array"}, f"{role} result binding")
    result = workbench.project.result(checked_id(binding.get("result_id")))
    if result["revision_hash"] != binding.get("revision_hash"):
        raise ValueError(f"{role.capitalize()} result revision is stale")
    source = workbench.project.source(result["source_id"], verify=True)
    name = binding.get("array")
    if not isinstance(name, str) or name not in result["arrays"]:
        raise ValueError(f"{role.capitalize()} result array is unavailable")
    geometry_value = result.get("provenance", {}).get("geometry")
    if not isinstance(geometry_value, dict):
        raise ValueError(f"{role.capitalize()} result has no explicit geometry")
    geometry = geometry_from_dict(geometry_value)
    artifact = result["arrays"][name]
    shape, _dtype, _decoded_bytes = _artifact_contract(artifact, role=f"{role} array")
    if len(shape) != len(geometry.axes):
        raise ValueError(f"{role.capitalize()} result array disagrees with its geometry")
    return result, artifact, geometry, source


def _artifact_contract(
    artifact: object, *, role: str
) -> tuple[tuple[int, ...], np.dtype[Any], int]:
    if not isinstance(artifact, dict) or set(artifact) != {"sha256", "bytes", "shape", "dtype"}:
        raise ValueError(f"{role.capitalize()} has an invalid artifact descriptor")
    shape_value = artifact.get("shape")
    try:
        dtype = np.dtype(artifact.get("dtype"))
    except TypeError as exc:
        raise ValueError(f"{role.capitalize()} has an invalid numeric dtype") from exc
    if (
        not isinstance(shape_value, list)
        or not 1 <= len(shape_value) <= 3
        or dtype.kind not in "buif"
        or dtype.itemsize > 8
    ):
        raise ValueError(f"{role.capitalize()} has an invalid numeric array descriptor")
    shape = tuple(integer(value, f"{role} dimension", 1, 2**31 - 1) for value in shape_value)
    return shape, dtype, math.prod(shape) * dtype.itemsize


def _load_bound_array(
    workbench: Workbench,
    artifact: dict[str, Any],
    geometry: Geometry,
    *,
    working_bytes: int,
) -> np.ndarray:
    array = workbench.project.load_array(artifact)
    validate_array(array, geometry=geometry, working_bytes=working_bytes)
    return array


def _resampling_peak_bytes(
    outputs: list[dict[str, Any]],
    result: dict[str, Any],
    output_shape: tuple[int, ...],
) -> int:
    """Bound retained outputs plus the active source and resampling workspace."""
    output_voxels = math.prod(output_shape)
    retained = 0
    peak = 0
    for spec in outputs:
        source_shape, dtype, source_bytes = _artifact_contract(
            result["arrays"][spec["array"]], role=f"{spec['array']} resampling input"
        )
        output_bytes = output_voxels * (dtype.itemsize if spec["kind"] == "labels" else 8)
        peak = max(
            peak, retained + max(math.prod(source_shape) * 64, source_bytes + output_bytes * 4)
        )
        retained += output_bytes
    measurement_peak = (
        retained + output_voxels * 128
        if any(spec["kind"] == "labels" for spec in outputs)
        else retained
    )
    return max(peak, measurement_peak)


def _binding_record(
    result: dict[str, Any], array_name: str, geometry: Geometry, source: dict[str, Any]
) -> dict[str, Any]:
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "array": array_name,
        "array_artifact": result["arrays"][array_name],
        "source_id": result["source_id"],
        "source_sha256": source["sha256"],
        "geometry": geometry.to_dict(),
    }


def _same_world_contract(fixed: Geometry, moving: Geometry) -> None:
    if fixed.axes != moving.axes:
        raise ValueError("Fixed and moving arrays must have the same spatial dimensions")
    if fixed.unit != moving.unit or fixed.frame != moving.frame:
        raise ValueError("Fixed and moving arrays must use the same world frame and units")
    for geometry in (fixed, moving):
        geometry.orthogonal_spacing()
        matrix = np.asarray(geometry.affine, dtype=np.float64)
        if abs(float(np.linalg.det(matrix[:3, :3]))) < 1e-12:
            raise ValueError("Registration geometry is singular or numerically unstable")


def _output_specs(
    value: object, result: dict[str, Any], expected_shape: tuple[int, ...]
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_OUTPUTS:
        raise ValueError(f"Choose 1-{MAX_OUTPUTS} bounded resampling outputs")
    resolved: list[dict[str, Any]] = []
    names: set[str] = set()
    labels = 0
    for item in value:
        exact_keys(
            item,
            {"array", "output_name", "kind", "interpolation", "default_value"},
            "resampling output",
        )
        array_name = item.get("array")
        output_name = item.get("output_name", array_name)
        kind = item.get("kind")
        interpolation = item.get("interpolation")
        if not isinstance(array_name, str) or array_name not in result["arrays"]:
            raise ValueError("Resampling output references an unavailable parent array")
        artifact = result["arrays"][array_name]
        shape, dtype, _decoded_bytes = _artifact_contract(
            artifact, role=f"{array_name} resampling input"
        )
        if shape != expected_shape:
            raise ValueError("Every resampling output must share the registration input grid")
        if (
            not isinstance(output_name, str)
            or not output_name
            or len(output_name) > 64
            or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", output_name) is None
            or output_name in names
        ):
            raise ValueError("Resampling output names must be unique identifiers")
        if kind not in {"scalar", "labels"}:
            raise ValueError("Resampling output kind must be scalar or labels")
        if interpolation not in {"linear", "nearest"}:
            raise ValueError("Scalar interpolation must be linear or nearest")
        if kind == "labels" and interpolation != "nearest":
            raise ValueError("Label resampling requires nearest interpolation")
        if kind == "labels" and dtype != np.dtype(np.uint32):
            raise ValueError(
                "Shared label resampling requires uint32 labels for exact correction and export"
            )
        default = finite_number(item.get("default_value", 0), "default_value", -1e30, 1e30)
        if kind == "labels" and default != 0:
            raise ValueError("Label resampling requires zero as the outside value")
        labels += kind == "labels"
        names.add(output_name)
        resolved.append(
            {
                "array": array_name,
                "output_name": output_name,
                "kind": kind,
                "interpolation": interpolation,
                "default_value": default,
            }
        )
    if not any(item["kind"] == "scalar" and item["output_name"] == "image" for item in resolved):
        raise ValueError("A scalar output named image is required for the shared result workflow")
    if any(item["kind"] == "labels" and item["output_name"] != "labels" for item in resolved):
        raise ValueError("The label output must be named labels")
    if labels > 1:
        raise ValueError("One operation can carry at most one label array for measurement")
    return resolved


def _matrix_record(matrix: np.ndarray, direction: str) -> dict[str, Any]:
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
        raise ValueError("Registration produced a non-finite transform")
    if abs(float(np.linalg.det(matrix[:3, :3]))) < 1e-12:
        raise ValueError("Registration produced a singular transform")
    return {
        "direction": direction,
        "coordinate_order": "XYZ world",
        "homogeneous_matrix": matrix.tolist(),
    }


def _phase_transform(
    fixed: np.ndarray,
    moving: np.ndarray,
    fixed_geometry: Geometry,
    moving_geometry: Geometry,
    settings: dict[str, Any],
    working_bytes: int,
) -> tuple[np.ndarray, dict[str, Any], dict[str, Any]]:
    if fixed.shape != moving.shape:
        raise ValueError("Phase correlation requires matching fixed and moving array shapes")
    fixed_basis = np.asarray(fixed_geometry.affine)[:3, :3]
    moving_basis = np.asarray(moving_geometry.affine)[:3, :3]
    if not np.allclose(fixed_basis, moving_basis, rtol=1e-9, atol=1e-10):
        raise ValueError("Phase correlation requires matching fixed and moving sampling bases")
    exact_keys(
        settings,
        {"upsample_factor", "min_normalized_correlation"},
        "phase-correlation settings",
    )
    upsample = integer(settings.get("upsample_factor", 20), "upsample_factor", 1, 200)
    minimum = finite_number(
        settings.get("min_normalized_correlation", 0.25),
        "min_normalized_correlation",
        -1,
        1,
    )
    estimate = estimate_translation(
        fixed,
        moving,
        fixed_geometry,
        upsample_factor=upsample,
        min_normalized_correlation=minimum,
        working_bytes=working_bytes,
    )
    shift_xyz = np.zeros(3)
    shift_xyz[: fixed.ndim] = np.asarray(estimate.moving_to_reference_shift_index)[::-1]
    index_transform = np.eye(4)
    index_transform[:3, 3] = shift_xyz
    moving_to_fixed = (
        np.asarray(fixed_geometry.affine)
        @ index_transform
        @ np.linalg.inv(np.asarray(moving_geometry.affine))
    )
    resolved = {
        "upsample_factor": upsample,
        "min_normalized_correlation": minimum,
        "threads": 1,
        "seed": 0,
    }
    quality = {
        "phase_error": estimate.phase_error,
        "phase_difference": estimate.phase_difference,
        "normalized_correlation": estimate.normalized_correlation,
        "overlap_fraction": estimate.overlap_fraction,
        "confidence": estimate.confidence,
    }
    return moving_to_fixed, resolved, quality


def _sitk_image(array: np.ndarray, geometry: Geometry, sitk: Any) -> Any:
    image = sitk.GetImageFromArray(array.astype(np.float64, copy=False))
    matrix = np.asarray(geometry.affine, dtype=np.float64)
    ndim = array.ndim
    basis = matrix[:ndim, :ndim]
    if ndim == 2 and (
        not np.allclose(matrix[2, :2], 0, atol=1e-10)
        or not np.allclose(matrix[:2, 2], 0, atol=1e-10)
    ):
        raise ValueError("SimpleITK 2D registration requires a planar XY world geometry")
    spacing = np.linalg.norm(basis, axis=0)
    direction = basis / spacing
    if not np.allclose(direction.T @ direction, np.eye(ndim), atol=1e-7, rtol=0):
        raise ValueError("SimpleITK registration requires an orthogonal physical grid")
    image.SetSpacing(tuple(float(v) for v in spacing))
    image.SetOrigin(tuple(float(v) for v in matrix[:ndim, 3]))
    image.SetDirection(tuple(float(v) for v in direction.ravel()))
    return image


def _sitk_homogeneous(transform: Any, ndim: int) -> np.ndarray:
    zero = np.zeros(ndim)
    offset = np.asarray(transform.TransformPoint(tuple(zero)), dtype=np.float64)
    matrix = np.eye(4)
    matrix[:ndim, 3] = offset
    for axis in range(ndim):
        point = zero.copy()
        point[axis] = 1
        matrix[:ndim, axis] = np.asarray(transform.TransformPoint(tuple(point))) - offset
    return matrix


def _sitk_rigid_transform(
    fixed: np.ndarray,
    moving: np.ndarray,
    fixed_geometry: Geometry,
    moving_geometry: Geometry,
    settings: dict[str, Any],
    working_bytes: int,
) -> tuple[np.ndarray, dict[str, Any], dict[str, Any]]:
    exact_keys(
        settings,
        {"iterations", "learning_rate", "minimum_step", "min_correlation", "min_overlap"},
        "SimpleITK rigid settings",
    )
    iterations = integer(settings.get("iterations", 200), "iterations", 1, 1000)
    learning_rate = finite_number(settings.get("learning_rate", 1.0), "learning_rate", 1e-6, 100)
    minimum_step = finite_number(settings.get("minimum_step", 1e-4), "minimum_step", 1e-9, 10)
    min_correlation = finite_number(settings.get("min_correlation", 0.25), "min_correlation", -1, 1)
    min_overlap = finite_number(settings.get("min_overlap", 0.25), "min_overlap", 0.01, 1)
    if fixed.nbytes + moving.nbytes + fixed.size * 96 > working_bytes:
        raise ValueError("SimpleITK registration exceeds the working-memory budget")
    try:
        import SimpleITK as sitk
    except ImportError as exc:  # pragma: no cover - locked engine includes it
        raise ValueError("SimpleITK registration support is not provisioned") from exc
    fixed_image = _sitk_image(fixed, fixed_geometry, sitk)
    moving_image = _sitk_image(moving, moving_geometry, sitk)
    initial = sitk.Euler2DTransform() if fixed.ndim == 2 else sitk.Euler3DTransform()
    initial = sitk.CenteredTransformInitializer(
        fixed_image, moving_image, initial, sitk.CenteredTransformInitializerFilter.GEOMETRY
    )
    method = sitk.ImageRegistrationMethod()
    method.SetMetricAsMeanSquares()
    method.SetMetricSamplingStrategy(method.NONE)
    method.SetInterpolator(sitk.sitkLinear)
    method.SetOptimizerAsRegularStepGradientDescent(
        learningRate=learning_rate,
        minStep=minimum_step,
        numberOfIterations=iterations,
        gradientMagnitudeTolerance=1e-8,
    )
    method.SetOptimizerScalesFromPhysicalShift()
    method.SetShrinkFactorsPerLevel([4, 2, 1])
    method.SetSmoothingSigmasPerLevel([2, 1, 0])
    method.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    method.SetInitialTransform(initial, inPlace=False)
    method.SetNumberOfThreads(1)
    method.SetNumberOfWorkUnits(1)
    fixed_to_moving_transform = method.Execute(fixed_image, moving_image)

    def resample_for_quality(image: Any, interpolator: int, pixel_type: int) -> Any:
        resampler = sitk.ResampleImageFilter()
        resampler.SetReferenceImage(fixed_image)
        resampler.SetTransform(fixed_to_moving_transform)
        resampler.SetInterpolator(interpolator)
        resampler.SetDefaultPixelValue(0)
        resampler.SetOutputPixelType(pixel_type)
        resampler.SetNumberOfThreads(1)
        resampler.SetNumberOfWorkUnits(1)
        return resampler.Execute(image)

    aligned = sitk.GetArrayFromImage(
        resample_for_quality(moving_image, sitk.sitkLinear, sitk.sitkFloat64)
    )
    mask_image = sitk.GetImageFromArray(np.ones(moving.shape, dtype=np.uint8))
    mask_image.CopyInformation(moving_image)
    valid = sitk.GetArrayFromImage(
        resample_for_quality(mask_image, sitk.sitkNearestNeighbor, sitk.sitkUInt8)
    ).astype(bool)
    fixed_to_moving = _sitk_homogeneous(fixed_to_moving_transform, fixed.ndim)
    moving_to_fixed = np.linalg.inv(fixed_to_moving)
    overlap = float(valid.mean())
    if (
        valid.sum() < 4
        or overlap < min_overlap
        or np.ptp(fixed[valid]) == 0
        or np.ptp(aligned[valid]) == 0
    ):
        raise ValueError("Rigid registration has insufficient varying overlap")
    correlation = float(np.corrcoef(fixed[valid].ravel(), aligned[valid].ravel())[0, 1])
    metric = float(method.GetMetricValue())
    if not math.isfinite(metric) or not math.isfinite(correlation) or correlation < min_correlation:
        raise ValueError("Rigid registration failed its declared quality controls")
    resolved = {
        "metric": "mean_squares",
        "optimizer": "regular_step_gradient_descent",
        "iterations": iterations,
        "learning_rate": learning_rate,
        "minimum_step": minimum_step,
        "min_correlation": min_correlation,
        "min_overlap": min_overlap,
        "shrink_factors": [4, 2, 1],
        "smoothing_sigmas_physical": [2, 1, 0],
        "sampling": "all",
        "threads": 1,
        "seed": 0,
    }
    quality = {
        "metric_value": metric,
        "optimizer_iteration": int(method.GetOptimizerIteration()),
        "optimizer_stop": method.GetOptimizerStopConditionDescription()[:500],
        "normalized_correlation": correlation,
        "overlap_fraction": overlap,
        "confidence": "accepted",
    }
    return moving_to_fixed, resolved, quality


def _resample(
    source: np.ndarray,
    source_geometry: Geometry,
    output_geometry: Geometry,
    output_shape: tuple[int, ...],
    moving_to_output: np.ndarray,
    *,
    labels: bool,
    interpolation: str,
    default_value: float,
    working_bytes: int,
) -> np.ndarray:
    validate_array(source, geometry=source_geometry, labels=labels, working_bytes=working_bytes)
    if len(output_shape) != source.ndim or output_geometry.axes != source_geometry.axes:
        raise ValueError("Resampling source and output dimensions disagree")
    output_voxels = math.prod(output_shape)
    output_bytes = output_voxels * (source.dtype.itemsize if labels else 8)
    if source.nbytes + output_bytes * 4 > working_bytes:
        raise ValueError("Resampling exceeds the declared working-memory budget")
    source_from_output = (
        np.linalg.inv(np.asarray(source_geometry.affine))
        @ np.linalg.inv(moving_to_output)
        @ np.asarray(output_geometry.affine)
    )
    ndim = source.ndim
    if ndim == 2 and not np.allclose(source_from_output[2, [0, 1, 3]], 0, atol=1e-7):
        raise ValueError("The requested transform moves a 2D grid outside its source plane")
    xyz_matrix = source_from_output[:ndim, :ndim]
    xyz_offset = source_from_output[:ndim, 3]
    reverse = np.eye(ndim)[::-1]
    array_matrix = reverse @ xyz_matrix @ reverse
    array_offset = reverse @ xyz_offset
    values = source if labels else source.astype(np.float64, copy=False)
    result = ndi.affine_transform(
        values,
        array_matrix,
        offset=array_offset,
        output_shape=output_shape,
        order=0 if interpolation == "nearest" else 1,
        mode="constant",
        cval=default_value,
        prefilter=False,
    )
    if labels:
        result = result.astype(source.dtype, copy=False)
        if not np.isin(np.unique(result), np.union1d(np.unique(source), [0])).all():
            raise RuntimeError("Nearest label resampling generated an unknown label ID")
    else:
        result = result.astype(np.float64, copy=False)
    if not np.isfinite(result).all():
        raise ValueError("Resampling produced non-finite values")
    result.flags.writeable = False
    return result


def _runtime(method: str) -> dict[str, Any]:
    backend = {
        "translation_phase_correlation": "scikit-image/scipy-cpu",
        "sitk_rigid": "SimpleITK-cpu",
        "declared_grid": "scipy-cpu",
    }[method]
    record = {
        "backend": backend,
        "engine": ENGINE_VERSION,
        "scipy": scipy.__version__,
        "scikit_image": skimage.__version__,
        "requested_device": "cpu",
        "resolved_device": "cpu",
        "numpy": np.__version__,
        "threads": 1,
        "seed": 0,
        "scientific_validation": "unvalidated-research-method",
    }
    if method == "sitk_rigid":
        import SimpleITK as sitk

        record["simpleitk"] = sitk.Version_VersionString()
        record["itk"] = sitk.Version_ITKVersionString()
    return record


def _registration_request(
    workbench: Workbench, request: dict[str, Any], guard: Callable[[], None] | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    exact_keys(
        request,
        {"fixed", "moving", "method", "settings", "outputs", "working_bytes"},
        "registration preview",
    )
    working_bytes = integer(
        request.get("working_bytes", DEFAULT_WORKING_BYTES),
        "working-memory budget",
        1024**2,
        8 * 1024**3,
    )
    fixed_result, fixed_artifact, fixed_geometry, fixed_source = _bound_array(
        workbench, request.get("fixed"), role="fixed"
    )
    moving_result, moving_artifact, moving_geometry, moving_source = _bound_array(
        workbench, request.get("moving"), role="moving"
    )
    _same_world_contract(fixed_geometry, moving_geometry)
    fixed_shape, _fixed_dtype, fixed_bytes = _artifact_contract(fixed_artifact, role="fixed array")
    moving_shape, _moving_dtype, moving_bytes = _artifact_contract(
        moving_artifact, role="moving array"
    )
    if len(fixed_shape) != len(moving_shape):
        raise ValueError("Fixed and moving arrays must have the same dimensionality")
    outputs = _output_specs(request.get("outputs"), moving_result, moving_shape)
    estimated_peak = max(
        fixed_bytes + moving_bytes + math.prod(fixed_shape) * 128,
        _resampling_peak_bytes(outputs, moving_result, fixed_shape),
    )
    if estimated_peak > working_bytes:
        raise ValueError("Registration exceeds the declared working-memory budget")
    fixed = _load_bound_array(
        workbench, fixed_artifact, fixed_geometry, working_bytes=working_bytes
    )
    moving = _load_bound_array(
        workbench, moving_artifact, moving_geometry, working_bytes=working_bytes
    )
    method = request.get("method")
    settings = request.get("settings", {})
    if not isinstance(settings, dict):
        raise ValueError("Registration settings must be an object")
    _guard(guard)
    if method == "translation_phase_correlation":
        transform, resolved, quality = _phase_transform(
            fixed, moving, fixed_geometry, moving_geometry, settings, working_bytes
        )
    elif method == "sitk_rigid":
        transform, resolved, quality = _sitk_rigid_transform(
            fixed, moving, fixed_geometry, moving_geometry, settings, working_bytes
        )
    else:
        raise ValueError("Registration method must be translation_phase_correlation or sitk_rigid")
    _guard(guard)
    inverse = np.linalg.inv(transform)
    receipt = {
        "schema": PREVIEW_SCHEMA,
        "fixed": _binding_record(
            fixed_result, request["fixed"]["array"], fixed_geometry, fixed_source
        ),
        "moving": _binding_record(
            moving_result, request["moving"]["array"], moving_geometry, moving_source
        ),
        "method": method,
        "settings": resolved,
        "outputs": outputs,
        "working_bytes": working_bytes,
        "transform": {
            "moving_to_fixed": _matrix_record(transform, "moving-world to fixed-world"),
            "fixed_to_moving": _matrix_record(
                inverse, "fixed-world to moving-world; resampling map"
            ),
        },
        "output_grid": {"shape": list(fixed.shape), "geometry": fixed_geometry.to_dict()},
        "quality": quality,
        "runtime": _runtime(method),
        "meaning": "technical registration preview; not biological or clinical validation",
    }
    normalized = {
        "fixed": {k: receipt["fixed"][k] for k in ("result_id", "revision_hash", "array")},
        "moving": {k: receipt["moving"][k] for k in ("result_id", "revision_hash", "array")},
        "method": method,
        "settings": {k: settings[k] for k in settings},
        "outputs": outputs,
        "working_bytes": working_bytes,
    }
    return receipt, normalized


def _publish_registration(
    workbench: Workbench,
    receipt: dict[str, Any],
    *,
    job_id: str | None,
    external_guard: Callable[[], None] | None,
) -> dict[str, Any]:
    moving_binding = receipt["moving"]
    moving_result = workbench.project.result(moving_binding["result_id"])
    moving_geometry = geometry_from_dict(moving_binding["geometry"])
    output_geometry = geometry_from_dict(receipt["output_grid"]["geometry"])
    transform = np.asarray(receipt["transform"]["moving_to_fixed"]["homogeneous_matrix"])
    arrays: dict[str, np.ndarray] = {}
    for spec in receipt["outputs"]:
        _guard(external_guard)
        source = workbench.project.load_array(moving_result["arrays"][spec["array"]])
        arrays[spec["output_name"]] = _resample(
            source,
            moving_geometry,
            output_geometry,
            tuple(receipt["output_grid"]["shape"]),
            transform,
            labels=spec["kind"] == "labels",
            interpolation=spec["interpolation"],
            default_value=spec["default_value"],
            working_bytes=receipt["working_bytes"],
        )
        del source
    label_names = [spec["output_name"] for spec in receipt["outputs"] if spec["kind"] == "labels"]
    scalar_names = [spec["output_name"] for spec in receipt["outputs"] if spec["kind"] == "scalar"]
    measurements: list[dict[str, Any]] = []
    if label_names:
        measurements = measure_objects(
            arrays[label_names[0]],
            output_geometry,
            {f"REGISTERED-DERIVED:{name}": arrays[name] for name in scalar_names},
            working_bytes=receipt["working_bytes"],
        )
    preview_sha = hashlib.sha256(canonical_json(receipt).encode()).hexdigest()
    provenance = {
        "geometry": output_geometry.to_dict(),
        "selection": moving_result["provenance"].get("selection", {"t": 0, "c": 0}),
        "derived_measurement_arrays": scalar_names,
        "registration_preview": {"sha256": preview_sha, "receipt": receipt},
        "transform": receipt["transform"],
        "output_grid": receipt["output_grid"],
        "interpolation": receipt["outputs"],
        "runtime": receipt["runtime"],
        "quality": receipt["quality"],
        "fixed_result": receipt["fixed"],
        "moving_result": receipt["moving"],
        "references": {
            "fixed": {
                "source_id": receipt["fixed"]["source_id"],
                "source_sha256": receipt["fixed"]["source_sha256"],
            },
            "moving": {
                "source_id": receipt["moving"]["source_id"],
                "source_sha256": receipt["moving"]["source_sha256"],
            },
        },
        "measurements": measurements,
        "measurement_basis": "REGISTERED-DERIVED scalar values and output-grid geometry",
        "scientific_validation": "unvalidated-research-method",
    }

    def publication_guard() -> None:
        _guard(external_guard)
        for role in ("fixed", "moving"):
            binding = receipt[role]
            current = workbench.project.result(binding["result_id"])
            if current["revision_hash"] != binding["revision_hash"]:
                raise ValueError(f"{role.capitalize()} result changed before publication")
            source = workbench.project.source(binding["source_id"], verify=True)
            if source["sha256"] != binding["source_sha256"]:
                raise ValueError(f"{role.capitalize()} source changed before publication")
            for artifact in current["arrays"].values():
                workbench.project.verify_array(artifact)

    publication_guard()
    result = workbench.project.save_result(
        source_id=moving_result["source_id"],
        kind="registered-derived",
        arrays=arrays,
        provenance=provenance,
        parent_id=moving_result["id"],
        job_id=job_id,
        publication_guard=publication_guard,
    )
    return {
        "result": result_summary(result),
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def _grid_geometry(
    parent: Geometry, grid: object, source_shape: tuple[int, ...]
) -> tuple[Geometry, tuple[int, ...]]:
    exact_keys(grid, {"start", "shape", "spacing"}, "resample grid")
    ndim = len(parent.axes)
    start_value, shape_value, spacing_value = (
        grid.get("start"),
        grid.get("shape"),
        grid.get("spacing"),
    )
    if not all(
        isinstance(value, list) and len(value) == ndim
        for value in (start_value, shape_value, spacing_value)
    ):
        raise ValueError("Grid start, shape, and spacing must follow the array axes")
    start = tuple(
        integer(value, "grid start", 0, source_shape[i] - 1) for i, value in enumerate(start_value)
    )
    shape = tuple(integer(value, "grid shape", 1, 1_000_000) for value in shape_value)
    spacing = tuple(finite_number(value, "grid spacing", 1e-9, 1e9) for value in spacing_value)
    matrix = np.asarray(parent.affine, dtype=np.float64).copy()
    parent_spacing = parent.orthogonal_spacing()
    for array_axis, (new_spacing, old_spacing) in enumerate(
        zip(spacing, parent_spacing, strict=True)
    ):
        xyz = ndim - array_axis - 1
        matrix[:3, xyz] *= new_spacing / old_spacing
    matrix[:3, 3] = parent.world(np.asarray([start], dtype=np.float64))[0]
    output = Geometry(parent.axes, tuple(map(tuple, matrix)), parent.unit, parent.frame)
    corners = (
        np.asarray(np.meshgrid(*[(0, size - 1) for size in shape], indexing="ij"))
        .reshape(ndim, -1)
        .T
    )
    world = output.world(corners)
    inverse = np.linalg.inv(np.asarray(parent.affine))
    homogeneous = np.column_stack((world, np.ones(len(world))))
    source_xyz = (homogeneous @ inverse.T)[:, :ndim]
    source_indices = source_xyz[:, ::-1]
    if np.any(source_indices < -1e-7) or any(
        np.any(source_indices[:, axis] > source_shape[axis] - 1 + 1e-7) for axis in range(ndim)
    ):
        raise ValueError("Declared output grid extends outside the parent world geometry")
    return output, shape


def _resample_grid(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None,
    publication_guard: Callable[[], None] | None,
) -> dict[str, Any]:
    exact_keys(request, {"parent", "grid", "outputs", "working_bytes"}, "resample grid")
    working_bytes = integer(
        request.get("working_bytes", DEFAULT_WORKING_BYTES),
        "working-memory budget",
        1024**2,
        8 * 1024**3,
    )
    parent, parent_artifact, geometry, source = _bound_array(
        workbench, request.get("parent"), role="parent"
    )
    source_shape, _source_dtype, _source_bytes = _artifact_contract(
        parent_artifact, role="parent array"
    )
    outputs = _output_specs(request.get("outputs"), parent, source_shape)
    output_geometry, output_shape = _grid_geometry(geometry, request.get("grid"), source_shape)
    if _resampling_peak_bytes(outputs, parent, output_shape) > working_bytes:
        raise ValueError("Resampling exceeds the declared working-memory budget")
    identity = np.eye(4)
    arrays: dict[str, np.ndarray] = {}
    for spec in outputs:
        _guard(publication_guard)
        values = workbench.project.load_array(parent["arrays"][spec["array"]])
        arrays[spec["output_name"]] = _resample(
            values,
            geometry,
            output_geometry,
            output_shape,
            identity,
            labels=spec["kind"] == "labels",
            interpolation=spec["interpolation"],
            default_value=spec["default_value"],
            working_bytes=working_bytes,
        )
        del values
    label_names = [spec["output_name"] for spec in outputs if spec["kind"] == "labels"]
    scalar_names = [spec["output_name"] for spec in outputs if spec["kind"] == "scalar"]
    measurements = (
        measure_objects(
            arrays[label_names[0]],
            output_geometry,
            {f"REGISTERED-DERIVED:{name}": arrays[name] for name in scalar_names},
            working_bytes=working_bytes,
        )
        if label_names
        else []
    )
    provenance = {
        "geometry": output_geometry.to_dict(),
        "selection": parent["provenance"].get("selection", {"t": 0, "c": 0}),
        "derived_measurement_arrays": scalar_names,
        "transform": {
            "moving_to_fixed": _matrix_record(identity, "parent-world to output-world"),
            "fixed_to_moving": _matrix_record(
                identity, "output-world to parent-world; resampling map"
            ),
        },
        "output_grid": {
            "shape": list(output_shape),
            "geometry": output_geometry.to_dict(),
            "request": request["grid"],
        },
        "interpolation": outputs,
        "runtime": _runtime("declared_grid"),
        "quality": {"kind": "exact-declared-grid", "confidence": "not-estimated"},
        "parent_result": _binding_record(parent, request["parent"]["array"], geometry, source),
        "references": {
            "parent": {"source_id": parent["source_id"], "source_sha256": source["sha256"]}
        },
        "measurements": measurements,
        "measurement_basis": "REGISTERED-DERIVED scalar values and output-grid geometry",
        "scientific_validation": (
            "deterministic resampling operation; not biological or clinical validation"
        ),
        "working_bytes": working_bytes,
    }

    def final_guard() -> None:
        _guard(publication_guard)
        current = workbench.project.result(parent["id"])
        if current["revision_hash"] != parent["revision_hash"]:
            raise ValueError("Parent result changed before publication")
        if workbench.project.source(parent["source_id"], verify=True)["sha256"] != source["sha256"]:
            raise ValueError("Parent source changed before publication")
        for artifact in current["arrays"].values():
            workbench.project.verify_array(artifact)

    final_guard()
    result = workbench.project.save_result(
        source_id=parent["source_id"],
        kind="resampled-derived",
        arrays=arrays,
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=final_guard,
    )
    return {
        "result": result_summary(result),
        "measurements": measurements[:1000],
        "total_measurements": len(measurements),
        "adopted": True,
    }


def validated_preview_receipt(request: dict[str, Any]) -> dict[str, Any]:
    """Validate exact canonical receipt bytes before job binding or adoption."""
    exact_keys(request, {"preview", "preview_json", "preview_sha256"}, "registration run")
    if "preview_json" in request:
        encoded = request["preview_json"]
        if "preview" in request or not isinstance(encoded, str):
            raise ValueError("Registration run requires one exact preview representation")
        if len(encoded.encode()) > MAX_PREVIEW_RECEIPT_BYTES:
            raise ValueError("Registration preview exceeds its receipt size limit")
        preview = parse_json(encoded)
        if canonical_json(preview) != encoded:
            raise ValueError("Registration run requires canonical preview bytes")
    else:
        # Retain the original in-process Python interface. Cross-language
        # clients must echo preview_json to preserve 1.0, -0.0 and exponent bytes.
        preview = request.get("preview")
    preview_sha = request.get("preview_sha256")
    if not isinstance(preview, dict) or preview.get("schema") != PREVIEW_SCHEMA:
        raise ValueError("Registration run requires a valid preview receipt")
    try:
        preview_bytes = canonical_json(preview).encode()
        if len(preview_bytes) > MAX_PREVIEW_RECEIPT_BYTES:
            raise ValueError("Registration preview exceeds its receipt size limit")
        actual_preview_sha = hashlib.sha256(preview_bytes).hexdigest()
    except (TypeError, ValueError) as exc:
        raise ValueError("Registration run requires a valid preview receipt") from exc
    if not isinstance(preview_sha, str) or actual_preview_sha != preview_sha:
        raise ValueError("Registration run must bind to the exact preview SHA-256")
    return preview


def execute_registration(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Preview or publish an exact physical registration/resampling operation."""
    if operation not in REGISTRATION_OPERATIONS or not isinstance(request, dict):
        raise ValueError("Unknown or invalid registration operation")
    if operation == "registration_preview":
        receipt, _normalized = _registration_request(workbench, request, publication_guard)
        encoded = canonical_json(receipt)
        if len(encoded.encode()) > MAX_PREVIEW_RECEIPT_BYTES:
            raise ValueError("Registration preview exceeds its receipt size limit")
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        return {
            "preview": receipt,
            "preview_json": encoded,
            "preview_sha256": digest,
            "adopted": False,
        }
    if operation == "resample_grid":
        return _resample_grid(
            workbench,
            request,
            job_id=job_id,
            publication_guard=publication_guard,
        )
    preview = validated_preview_receipt(request)
    try:
        replay = {
            "fixed": {k: preview["fixed"][k] for k in ("result_id", "revision_hash", "array")},
            "moving": {k: preview["moving"][k] for k in ("result_id", "revision_hash", "array")},
            "method": preview["method"],
            "settings": {
                key: value
                for key, value in preview["settings"].items()
                if key
                not in {
                    "threads",
                    "seed",
                    "metric",
                    "optimizer",
                    "shrink_factors",
                    "smoothing_sigmas_physical",
                    "sampling",
                }
            },
            "outputs": preview["outputs"],
            "working_bytes": preview["working_bytes"],
        }
    except (KeyError, TypeError) as exc:
        raise ValueError("Registration run requires a complete preview receipt") from exc
    candidate, _normalized = _registration_request(workbench, replay, publication_guard)
    if canonical_json(candidate) != canonical_json(preview):
        raise ValueError("Inputs, runtime, settings, transform, or quality changed after preview")
    return _publish_registration(
        workbench,
        preview,
        job_id=job_id,
        external_guard=publication_guard,
    )
