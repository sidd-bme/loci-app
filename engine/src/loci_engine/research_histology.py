"""Explicit tissue-region masks on the bounded native source grid."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import numpy as np
from scipy import ndimage as ndi

from .quantitative import exact_keys, integer, measure_objects
from .research_project import checked_id
from .whole_slide import tissue_mask_pixels

if TYPE_CHECKING:
    from .workbench import Workbench


def execute_tissue(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    preview: bool,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    from .workbench import _png, result_summary, runtime_record

    exact_keys(request, {"source_id", "selection", "settings", "working_bytes"}, "tissue mask")
    source_id = checked_id(request.get("source_id"))
    selection = workbench.selection(source_id, request.get("selection"))
    source = workbench.project.source(source_id)
    if (
        source.get("source_kind") not in {"native", "whole_slide"}
        or workbench._session(source_id).metadata.dimensions.s != 3
        or "z_stop" in selection
    ):
        raise ValueError("Tissue masking requires one explicitly selected RGB brightfield plane")
    settings = request.get("settings", {})
    exact_keys(
        settings,
        {"closing_radius_pixels", "minimum_component_pixels", "control"},
        "tissue settings",
    )
    radius = integer(settings.get("closing_radius_pixels", 0), "closing radius", 0, 64)
    minimum = integer(
        settings.get("minimum_component_pixels", 0), "minimum region pixels", 0, 10_000_000
    )
    control = settings.get("control")
    if not isinstance(control, str) or not control.strip() or len(control) > 2000:
        raise ValueError(
            "Declare the tissue-mask control or visual-review criterion (1–2000 characters)"
        )
    budget = integer(
        request.get("working_bytes", 512 * 1024**2), "working bytes", 1024**2, 512 * 1024**2
    )
    if selection["width"] * selection["height"] * 128 > budget:
        raise ValueError("Tissue masking exceeds the declared working-memory budget before decode")
    rgb, geometry, selection = workbench.load_scalar(
        source_id, selection, allow_rgb=True, working_bytes=budget
    )
    mask, threshold, luminance = tissue_mask_pixels(
        rgb, closing_radius_pixels=radius, minimum_component_pixels=minimum, working_bytes=budget
    )
    labels, _ = ndi.label(mask, output=np.uint32)
    rows = measure_objects(
        labels, geometry, {"TISSUE-DERIVED:image": luminance}, working_bytes=budget
    )
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "processing": [],
        "segmentation": {"method": "otsu-dark-luminance-connected-regions", "threshold": threshold},
        "tissue_mask": {
            "threshold_method": "otsu-dark-luminance",
            "threshold": threshold,
            "closing_radius_pixels": radius,
            "minimum_component_pixels": minimum,
            "connectivity": "face-connected-2D",
            "control": control.strip(),
            "input": "source-device-RGB; display ICC transform excluded",
            "luminance_formula": (
                "skimage.color.rgb2gray source RGB / 255; weighted sum 0.2125R + 0.7154G + 0.0721B"
            ),
            "scientific_validation": "unvalidated-research-method",
            "initial_mask_pixel_count": int(np.count_nonzero(mask)),
            "initial_mask_fraction": float(np.mean(mask)),
            "scope": "selected bounded native region only",
        },
        "measurement_basis": (
            "TISSUE-DERIVED luminance on source grid; connected regions are not cell counts"
        ),
        "derived_measurement_arrays": ["image"],
        "derived_measurement_prefix": "TISSUE-DERIVED",
        "measurements": rows,
        "runtime": runtime_record(),
    }
    if preview:
        overlay = rgb.copy()
        overlay[mask] = np.round(0.5 * overlay[mask] + 0.5 * np.array([0, 210, 140])).astype(
            np.uint8
        )
        return {
            "preview": True,
            "adopted": False,
            "image": _png(overlay),
            "region_count": len(rows),
            "measurements": rows[:1000],
            "provenance": {k: v for k, v in provenance.items() if k != "measurements"},
        }
    result = workbench.project.save_result(
        source_id=source_id,
        kind="tissue-region-mask",
        arrays={"image": luminance, "labels": labels},
        provenance=provenance,
        job_id=job_id,
        publication_guard=publication_guard,
    )
    return {"result": result_summary(result), "measurements": rows[:1000]}
