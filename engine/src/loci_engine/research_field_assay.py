"""Workbench operations for fluorescence field assays.

Provides contextual fluorescence field assay preview, execution, and review within
the native Loci workbench. Supports binding focus and background regions from
source vector annotations or explicit exact binary masks, previewing provisional
DAPI segmentation with transparent outlines, and recording signed background-corrected
fluorescence integrals with explicit provenance.
"""

from __future__ import annotations

import base64
import io
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image
from skimage.draw import polygon2mask

from .fluorescence_assay import (
    compute_field_quantification,
    generate_qc_overlay,
    validate_assay_config,
)
from .quantitative import DEFAULT_WORKING_BYTES, integer
from .research_project import checked_id

if TYPE_CHECKING:
    from .workbench import Workbench


SCHEMA = "loci.field-assay-result/v1"
_MISSING = object()


def _resolve_config_parameter(
    request: dict[str, Any],
    raw_config: dict[str, Any],
    name: str,
    *,
    request_names: tuple[str, ...] | None = None,
    default: Any = _MISSING,
    normalize: Callable[[Any], Any] | None = None,
) -> Any:
    """Resolve one parameter while rejecting contradictory duplicate inputs."""
    normalize = normalize or (lambda value: value)
    candidates: list[tuple[str, Any]] = []
    for request_name in request_names or (name,):
        if request_name in request and request[request_name] is not None:
            candidates.append((request_name, normalize(request[request_name])))
    if name in raw_config and raw_config[name] is not None:
        candidates.append((f"config.{name}", normalize(raw_config[name])))

    if candidates:
        source, value = candidates[0]
        for other_source, other_value in candidates[1:]:
            if other_value != value:
                raise ValueError(
                    f"Conflicting field assay parameter '{name}': "
                    f"{source}={value!r} and {other_source}={other_value!r}"
                )
        return value
    if default is not _MISSING:
        return default
    return None


def _png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _get_source_annotations(workbench: Workbench, source_id: str) -> list[dict[str, Any]]:
    document = next(
        (item for item in workbench.project.documents("annotations") if item["id"] == source_id),
        None,
    )
    if not document:
        return []
    data = document.get("data", {})
    history = data.get("history", [[]])
    cursor = data.get("cursor", 0)
    if 0 <= cursor < len(history):
        return history[cursor]
    return []


def _rasterize_annotation_polygon(
    annotation: dict[str, Any], shape: tuple[int, int]
) -> np.ndarray:
    kind = annotation.get("kind")
    if kind not in {"polygon", "rectangle"}:
        raise ValueError(
            f"Annotation {annotation.get('id')} must be a polygon or rectangle, got {kind}"
        )
    points = annotation.get("points")
    if not isinstance(points, list) or len(points) < 3:
        raise ValueError(f"Annotation {annotation.get('id')} does not have sufficient vertices")
    # Source annotations use level-zero pixel-edge coordinates. polygon2mask
    # samples at integer pixel centers, so translate edges into its center frame.
    coords = [(float(pt["y"]) - 0.5, float(pt["x"]) - 0.5) for pt in points]
    return polygon2mask(shape, coords)


def _annotation_matches_plane(annotation: dict[str, Any], *, z: int, t: int) -> bool:
    """Return whether a source annotation belongs to the requested acquisition plane."""
    return annotation.get("z") == z and annotation.get("t") == t


def _require_annotation_plane(
    annotation: dict[str, Any], *, z: int, t: int, role: str
) -> None:
    if _annotation_matches_plane(annotation, z=z, t=t):
        return
    raise ValueError(
        f"{role} annotation '{annotation.get('id')}' belongs to "
        f"Z {annotation.get('z')}, T {annotation.get('t')}; "
        f"the assay is using Z {z}, T {t}"
    )


def execute_field_assay(
    workbench: Workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Execute field_assay_preview or field_assay_run workbench operation."""
    if operation not in {"field_assay_preview", "field_assay_run"}:
        raise ValueError(f"Unknown field assay operation: {operation}")

    source_id = checked_id(request.get("source_id"))
    source = workbench.project.source(source_id, verify=True)
    if source.get("metadata", {}).get("sample_semantics") in {"RGB", "RGBA"}:
        raise ValueError(
            "Fluorescence field assay requires scalar channels, not interleaved RGB/RGBA"
        )

    metadata = source.get("metadata", {})
    dimensions = metadata.get("dimensions") or {
        "x": metadata.get("shape", [1, 1])[-1],
        "y": metadata.get("shape", [1, 1])[-2],
        "z": 1,
        "c": 1,
        "t": 1,
    }

    nuclei_c = integer(request.get("nuclei_channel", 0), "nuclei channel", 0, dimensions["c"] - 1)
    signal_c = integer(request.get("signal_channel", 1), "signal channel", 0, dimensions["c"] - 1)
    z = integer(request.get("z", 0), "z index", 0, dimensions["z"] - 1)
    t = integer(request.get("t", 0), "t index", 0, dimensions["t"] - 1)

    height = dimensions["y"]
    width = dimensions["x"]
    full_selection_nuclei = {
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
        "z": z,
        "c": nuclei_c,
        "t": t,
        "level": 0,
    }
    full_selection_signal = {
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
        "z": z,
        "c": signal_c,
        "t": t,
        "level": 0,
    }

    nuclei_array, geometry, _ = workbench.load_scalar(
        source_id, full_selection_nuclei, working_bytes=DEFAULT_WORKING_BYTES
    )
    signal_array, _, _ = workbench.load_scalar(
        source_id, full_selection_signal, working_bytes=DEFAULT_WORKING_BYTES
    )

    if nuclei_array.ndim > 2:
        nuclei_array = nuclei_array[0]
    if signal_array.ndim > 2:
        signal_array = signal_array[0]

    # Resolve focus mask
    annotations = _get_source_annotations(workbench, source_id)
    focus_mask: np.ndarray | None = None
    focus_source_desc: str = ""

    if request.get("focus_annotation_id"):
        ann_id = str(request["focus_annotation_id"])
        target_ann = next((a for a in annotations if a.get("id") == ann_id), None)
        if not target_ann:
            raise ValueError(f"Focus annotation '{ann_id}' was not found in source annotations")
        _require_annotation_plane(target_ann, z=z, t=t, role="Focus")
        focus_mask = _rasterize_annotation_polygon(target_ann, (height, width))
        focus_source_desc = f"source_annotation:{ann_id}"
    elif request.get("focus_mask_base64"):
        raw_bytes = base64.b64decode(request["focus_mask_base64"])
        mask_img = Image.open(io.BytesIO(raw_bytes))
        arr = np.array(mask_img)
        if arr.shape != (height, width):
            raise ValueError(
                f"Imported focus mask dimensions {arr.shape} do not match image {(height, width)}"
            )
        focus_mask = arr > 0
        focus_source_desc = "imported_mask_base64"
    elif request.get("focus_all", False):
        focus_mask = np.ones((height, width), dtype=bool)
        focus_source_desc = "full_field"
    else:
        # Check if an annotation labeled "focus" exists
        focus_ann = next(
            (
                a
                for a in annotations
                if a.get("label", "").lower() == "focus"
                and _annotation_matches_plane(a, z=z, t=t)
            ),
            None,
        )
        if focus_ann:
            focus_mask = _rasterize_annotation_polygon(focus_ann, (height, width))
            focus_source_desc = f"source_annotation:{focus_ann.get('id')}"
        else:
            raise ValueError("Select a focus region polygon or import a valid focus mask")

    # Resolve background mask or value
    background_mask: np.ndarray | None = None
    background_value: float | None = None
    bg_source_desc: str = ""

    if request.get("background_value") is not None:
        background_value = float(request["background_value"])
        bg_source_desc = f"explicit_scalar:{background_value}"
    elif request.get("background_annotation_id"):
        ann_id = str(request["background_annotation_id"])
        target_ann = next((a for a in annotations if a.get("id") == ann_id), None)
        if not target_ann:
            raise ValueError(
                f"Background annotation '{ann_id}' was not found in source annotations"
            )
        _require_annotation_plane(target_ann, z=z, t=t, role="Background")
        background_mask = _rasterize_annotation_polygon(target_ann, (height, width))
        bg_source_desc = f"source_annotation:{ann_id}"
    elif request.get("background_mask_base64"):
        raw_bytes = base64.b64decode(request["background_mask_base64"])
        mask_img = Image.open(io.BytesIO(raw_bytes))
        arr = np.array(mask_img)
        if arr.shape != (height, width):
            raise ValueError(
                f"Imported background mask dimensions {arr.shape} "
                f"do not match image {(height, width)}"
            )
        background_mask = arr > 0
        bg_source_desc = "imported_mask_base64"
    else:
        # Check if an annotation labeled "background" exists
        bg_ann = next(
            (
                a
                for a in annotations
                if a.get("label", "").lower() == "background"
                and _annotation_matches_plane(a, z=z, t=t)
            ),
            None,
        )
        if bg_ann:
            background_mask = _rasterize_annotation_polygon(bg_ann, (height, width))
            bg_source_desc = f"source_annotation:{bg_ann.get('id')}"
        else:
            # Default to zero background if not provided
            background_value = 0.0
            bg_source_desc = "default_zero"

    # Resolve manual count points if provided
    manual_points = request.get("manual_points")
    manual_count = request.get("manual_count")
    if manual_points is None and request.get("manual_points_annotation_id"):
        pts_id = str(request["manual_points_annotation_id"])
        if pts_id == "all_points":
            pts_ann = [
                a
                for a in annotations
                if _annotation_matches_plane(a, z=z, t=t)
                and (
                    a.get("kind") == "point"
                    or a.get("label", "").lower() in {"count", "nucleus", "nuclei"}
                )
            ]
        else:
            exact_point = next((a for a in annotations if a.get("id") == pts_id), None)
            if exact_point is not None:
                _require_annotation_plane(exact_point, z=z, t=t, role="Manual points")
                pts_ann = [exact_point]
            else:
                pts_ann = [
                    a
                    for a in annotations
                    if pts_id in {"count", "nuclei"}
                    and a.get("label", "").lower() in {"count", "nucleus", "nuclei"}
                    and _annotation_matches_plane(a, z=z, t=t)
                ]
        if pts_ann:
            manual_points = [
                {"x": pt["x"], "y": pt["y"], "id": ann.get("id", "")}
                for ann in pts_ann
                if ann.get("kind") == "point"
                for pt in ann.get("points", [])
            ]

    # Validate config and consume GUI parameters
    raw_config = request.get("config", {})
    if not isinstance(raw_config, dict):
        raise ValueError("Field assay configuration must be an object")

    seg_method = _resolve_config_parameter(
        request,
        raw_config,
        "segmentation_method",
        default="manual",
        normalize=lambda value: str(value).lower(),
    )
    sigma = _resolve_config_parameter(
        request,
        raw_config,
        "gaussian_sigma_px",
        default=1.0,
        normalize=float,
    )
    threshold_supplied = (
        any(request.get(key) is not None for key in ("threshold_manual", "nuclear_threshold"))
        or raw_config.get("nuclear_threshold") is not None
    )
    nuclear_threshold = _resolve_config_parameter(
        request,
        raw_config,
        "nuclear_threshold",
        request_names=("threshold_manual", "nuclear_threshold"),
        normalize=float,
    )
    if seg_method in {"otsu", "yen"} and threshold_supplied:
        raise ValueError(
            f"Fixed nuclear_threshold must be omitted when segmentation_method is {seg_method}"
        )

    bg_estimator = _resolve_config_parameter(
        request,
        raw_config,
        "background_estimator",
        default="median",
        normalize=lambda value: str(value).lower(),
    )
    reviewer = _resolve_config_parameter(
        request,
        raw_config,
        "reviewer",
        default="",
        normalize=lambda value: str(value).strip(),
    )

    confirmations: dict[str, Any] = {}
    for key in (
        "channel_identity_confirmed",
        "acquisition_comparable",
        "focus_reviewed",
        "nuclei_reviewed",
        "background_reviewed",
    ):
        value = _resolve_config_parameter(request, raw_config, key)
        if value is not None:
            confirmations[key] = value

    endpoint_status = _resolve_config_parameter(request, raw_config, "endpoint_status")
    if not endpoint_status:
        if operation == "field_assay_preview":
            endpoint_status = "exploratory"
        elif (
            all(confirmations.get(key) is True for key in confirmations) and len(confirmations) == 5
        ):
            endpoint_status = "reviewed"
        else:
            endpoint_status = "exploratory"

    # Enforce strict reviewed guards:
    if endpoint_status == "reviewed":
        if not reviewer:
            raise ValueError(
                "A non-empty reviewer name/ID is strictly required "
                "for reviewed endpoint publication"
            )
        if seg_method in {"otsu", "yen"} and manual_count is None and manual_points is None:
            raise ValueError(
                "Reviewed status requires a fixed calibrated threshold or manual nucleus count, "
                "not dynamic per-image Otsu/Yen thresholding"
            )
        if request.get("focus_all") or (focus_source_desc == "full_field"):
            raise ValueError(
                "Reviewed endpoint requires a human-approved focus ROI, not whole-field measurement"
            )
        if bg_source_desc == "default_zero" or (
            background_value == 0.0 and background_mask is None
        ):
            raise ValueError(
                "Reviewed endpoint requires a cell-free background selection "
                "or verified non-zero background value"
            )

    exclude_boundary = _resolve_config_parameter(
        request, raw_config, "exclude_boundary_nuclei", default=True
    )
    allow_boundary = _resolve_config_parameter(
        request,
        raw_config,
        "allow_boundary_exclusions",
        default=not exclude_boundary,
    )
    if seg_method not in {"otsu", "yen"} and nuclear_threshold is None:
        raise ValueError(
            "A fixed nuclear_threshold is required for manual field assay segmentation"
        )
    if nuclear_threshold is None:
        # Required only to validate the remaining configuration before deriving
        # the automatic threshold; this value is never executed or returned.
        nuclear_threshold = 0.0

    config_with_defaults = dict(raw_config)
    config_with_defaults.update(
        {
            "nuclear_threshold": nuclear_threshold,
            "gaussian_sigma_px": sigma,
            "min_nucleus_area_px": _resolve_config_parameter(
                request, raw_config, "min_nucleus_area_px", default=10
            ),
            "max_nucleus_area_px": _resolve_config_parameter(
                request, raw_config, "max_nucleus_area_px", default=5000
            ),
            "watershed_min_distance_px": _resolve_config_parameter(
                request, raw_config, "watershed_min_distance_px", default=5
            ),
            "signal_channel_label": _resolve_config_parameter(
                request,
                raw_config,
                "signal_channel_label",
                default=f"Channel {signal_c + 1}",
            ),
            "endpoint_status": endpoint_status,
            "boundary_exclusion_px": _resolve_config_parameter(
                request, raw_config, "boundary_exclusion_px", default=0
            ),
            "allow_boundary_exclusions": allow_boundary,
            "saturation_reviewed": _resolve_config_parameter(
                request, raw_config, "saturation_reviewed", default=False
            ),
            "background_estimator": bg_estimator,
            "segmentation_method": seg_method,
            "reviewer": reviewer,
            "exclude_boundary_nuclei": exclude_boundary,
            **confirmations,
        }
    )

    assay_notes = _resolve_config_parameter(
        request, raw_config, "assay_notes", normalize=lambda value: str(value)
    )
    if assay_notes is not None:
        config_with_defaults["assay_notes"] = assay_notes

    config = validate_assay_config(config_with_defaults)

    if seg_method in {"otsu", "yen"}:
        from scipy import ndimage
        from skimage import filters

        smoothed = (
            ndimage.gaussian_filter(
                nuclei_array.astype(np.float64), sigma=config["gaussian_sigma_px"]
            )
            if config["gaussian_sigma_px"]
            else nuclei_array.astype(np.float64)
        )
        focus_pixels = smoothed[focus_mask] if np.any(focus_mask) else smoothed
        threshold_function = (
            filters.threshold_otsu if seg_method == "otsu" else filters.threshold_yen
        )
        try:
            nuclear_threshold = float(threshold_function(focus_pixels))
        except Exception as exc:
            raise ValueError(
                f"{seg_method.title()} threshold calculation failed "
                f"for the selected focus pixels: {exc}"
            ) from exc
        config["nuclear_threshold"] = nuclear_threshold
        config = validate_assay_config(config)

    comp = compute_field_quantification(
        nuclei_array,
        signal_array,
        focus_mask,
        background_mask=background_mask,
        background_value=background_value,
        config=config,
        manual_count=manual_count,
        manual_points=manual_points,
    )

    accepted_labels = comp["accepted_labels"]
    nuclei_rows = comp["nuclei_rows"]
    warnings = comp["warnings"]
    rejected = comp["rejected"]
    effective = comp["effective_mask"]
    summary = comp["summary"]
    resolved_config = comp["config"]

    overlay_img = generate_qc_overlay(nuclei_array, focus_mask, accepted_labels, rejected)
    qc_data_url = _png_data_url(overlay_img)

    if operation == "field_assay_preview":
        return {
            "preview": True,
            "source_id": source_id,
            "source_sha256": source["sha256"],
            "nuclei_channel": nuclei_c,
            "signal_channel": signal_c,
            "z": z,
            "t": t,
            "summary": summary,
            "nuclei_count": summary["accepted_nuclei_count"],
            "reviewed_count": summary["reviewed_nuclei_count"],
            "count_mode": summary["count_mode"],
            "warnings": warnings,
            "qc_overlay": qc_data_url,
            "overlay": qc_data_url,
            "measurements": nuclei_rows,
            "effective_mask_pixels": summary["effective_measurement_pixels"],
            "focus_mask_pixels": summary["focus_pixels"],
            "raw_signal_sum": summary["raw_signal_sum_adu"],
            "integrated_signal_minus_background": summary["integrated_signal_minus_background_adu"],
            "field_ratio": summary["field_ratio_integrated_signal_per_accepted_nucleus_adu"],
            "fraction_positive": summary["fraction_positive"],
            "saturation": {
                "nuclei": summary["nuclei_saturated_pixels"],
                "signal": summary["signal_saturated_pixels"],
                "background": summary["background_saturated_pixels"],
            },
            "nuclei_rows": nuclei_rows[:100],
            "total_nuclei": len(nuclei_rows),
            "computed_threshold": resolved_config["nuclear_threshold"],
            "segmentation_method": resolved_config["segmentation_method"],
            "background_estimator": resolved_config["background_estimator"],
            "config": resolved_config,
        }

    # field_assay_run: publish immutable result
    if publication_guard:
        publication_guard()

    provenance = {
        "schema": SCHEMA,
        "source_id": source_id,
        "source_sha256": source["sha256"],
        "selection": full_selection_signal,
        "geometry": geometry.to_dict(),
        "nuclei_channel": nuclei_c,
        "signal_channel": signal_c,
        "z": z,
        "t": t,
        "focus_source": focus_source_desc,
        "background_source": bg_source_desc,
        "summary": summary,
        "config": resolved_config,
        "warnings": warnings,
        "measurements": nuclei_rows,
        "manual_points": comp.get("manual_points"),
        "reviewer": resolved_config.get("reviewer"),
        "assay_notes": resolved_config.get("assay_notes"),
    }

    result = workbench.project.save_result(
        source_id=source_id,
        kind="field-assay",
        arrays={
            "image": signal_array,
            "nuclei": nuclei_array,
            "labels": accepted_labels,
            "effective_mask": np.where(effective, 255, 0).astype(np.uint8),
            "focus_mask": np.where(focus_mask, 255, 0).astype(np.uint8),
        },
        provenance=provenance,
        job_id=job_id,
        publication_guard=publication_guard,
    )

    from .workbench import result_summary

    return {
        "adopted": True,
        "result": result_summary(result),
        "summary": summary,
        "warnings": warnings,
        "qc_overlay": qc_data_url,
        "nuclei_rows": nuclei_rows[:100],
        "total_nuclei": len(nuclei_rows),
    }
