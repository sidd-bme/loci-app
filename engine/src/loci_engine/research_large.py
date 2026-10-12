"""Explicit source-resolution YX workflow over immutable bounded result chunks."""

from __future__ import annotations

import copy
import hashlib
import math
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from .native_image import NativeSelection
from .quantitative import MAX_WORKING_BYTES, exact_keys, integer, segment_scalar
from .research_project import canonical_json, checked_id

WORKING_BYTES = 256 * 1024**2
TILE_SIZE = 512
POLICY = "loci.large-components/1"


def is_large(result: dict[str, Any]) -> bool:
    return result.get("schema") == "loci.research-result/v2"


def preflight(workbench, request, *, check=None):
    exact_keys(
        request, {"source_id", "selection", "segmentation", "working_bytes"}, "large analysis"
    )
    if workbench.project.meta["schema"] != "loci.study/v2":
        raise ValueError(
            "Large analysis needs a new study created by this Loci version; "
            "existing studies are not upgraded in place"
        )
    source_id = checked_id(request.get("source_id"))
    source = workbench.project.source(source_id)
    if source.get("source_kind") != "native":
        raise ValueError("Large components currently supports calibrated scalar tiled OME-TIFF")
    selection = workbench.selection(source_id, request.get("selection"))
    if selection["level"] != 0 or "z_stop" in selection:
        raise ValueError("Choose one native-resolution C/Z/T plane for large analysis")
    session = workbench._session(source_id, check=check)
    metadata = session.metadata
    if (
        metadata.format != "OME-TIFF"
        or metadata.dimensions.s != 1
        or not metadata.capabilities.tiled
    ):
        raise ValueError("Large components currently supports calibrated scalar tiled OME-TIFF")
    dtype = np.dtype(metadata.channel_dtypes[selection["c"]])
    if dtype not in (np.dtype("uint8"), np.dtype("uint16")):
        raise ValueError("Large components requires uint8 or uint16 raw samples")
    geometry = workbench._native_geometry(session, selection, False)
    if geometry.unit not in {"um", "nm", "mm", "m"}:
        raise ValueError("Declare physical XY calibration before large analysis")
    geometry.orthogonal_spacing()
    height, width = selection["height"], selection["width"]
    if max(height, width) > 65536 or height * width >= 2**32:
        raise ValueError(
            "Large analysis supports up to 65536 pixels per edge and fewer than 2^32 pixels"
        )
    if math.ceil(height / TILE_SIZE) * math.ceil(width / TILE_SIZE) > 16384:
        raise ValueError("The selected grid exceeds the 16384-chunk result envelope")
    spec = request.get("segmentation")
    exact_keys(
        spec,
        {"method", "threshold", "polarity", "min_size", "exclude_border"},
        "large segmentation",
    )
    if spec.get("method", "components") != "components" or isinstance(
        spec.get("threshold"), (str, bool)
    ):
        raise ValueError(
            "Large components requires an explicit numeric threshold; "
            "Otsu and watershed are not supported"
        )
    _, resolved = segment_scalar(np.zeros((2, 2), dtype=dtype), geometry, spec)
    working = integer(
        request.get("working_bytes", WORKING_BYTES),
        "working_bytes",
        WORKING_BYTES,
        MAX_WORKING_BYTES,
    )
    # Temporary provisional labels, adopted raw/labels, correction/export headroom.
    disk_required = height * width * (dtype.itemsize + 16) + 128 * 1024**2
    used = sum(p.stat().st_size for p in workbench.project.arrays.iterdir() if p.is_file())
    if used + disk_required > workbench.project.meta["disk_budget_bytes"]:
        raise ValueError(
            "The study disk budget cannot hold large analysis and its temporary artifacts; "
            "choose a smaller scope or a new study"
        )
    if disk_required > shutil.disk_usage(workbench.project.root).free:
        raise ValueError("Insufficient free disk space for large analysis and temporary artifacts")
    normalized_spec = {
        key: resolved[key]
        for key in ("method", "threshold", "polarity", "min_size", "exclude_border")
    }
    return {
        "source_id": source_id,
        "source_sha256": source["sha256"],
        "selection": selection,
        "segmentation": normalized_spec,
        "working_bytes": working,
        "shape": [height, width],
        "dtype": str(dtype),
        "geometry": geometry.to_dict(),
        "tile_size": TILE_SIZE,
        "policy": POLICY,
        "disk_required_bytes": disk_required,
        "decoded_labels_bytes": height * width * 4,
        "maximum_objects": 100_000,
        "maximum_provisional_components": 1_000_000,
    }


def _check(workbench, job_id, guard):
    if guard:
        guard()
    if job_id is not None:
        job = workbench.project.job(job_id)
        if job["state"] != "running" or job["cancel_requested"]:
            raise ValueError("Large analysis cancelled before publication")


def run(workbench, request, *, job_id=None, publication_guard=None):
    from .large_components import measure_tiled, stream_components
    from .research_tiled_store import (
        ObjectTableWriter,
        TiledArrayWriter,
        label_value_hash,
        object_rows,
        read_region,
    )
    from .workbench import geometry_from_dict, result_summary, runtime_record

    def check():
        _check(workbench, job_id, publication_guard)

    check()
    plan = preflight(workbench, request, check=check)
    project = workbench.project
    selection, shape = plan["selection"], tuple(plan["shape"])
    session = workbench._session(plan["source_id"], check=check)
    session.verify_strict(check=check)
    geometry = geometry_from_dict(plan["geometry"])

    check()
    image_writer = TiledArrayWriter(project, shape, plan["dtype"], TILE_SIZE)
    label_writer = TiledArrayWriter(project, shape, "uint32", TILE_SIZE)

    def native(y, x, height, width):
        check()
        return session.read_region(
            NativeSelection(
                x=selection["x"] + x,
                y=selection["y"] + y,
                width=width,
                height=height,
                t=selection["t"],
                c=selection["c"],
                z=selection["z"],
                level=0,
                series=session.metadata.selected_series,
                expected_sha256=plan["source_sha256"],
                budget_bytes=64 * 1024**2,
            )
        ).pixels

    def save_tile(y, x, labels):
        check()
        label_writer.write(y, x, labels)
        image_writer.write(y, x, native(y, x, *labels.shape))

    with tempfile.TemporaryDirectory(prefix=".large-components-", dir=project.root) as directory:
        segmentation = stream_components(
            native,
            save_tile,
            shape,
            geometry,
            plan["segmentation"],
            work_dir=Path(directory),
            working_bytes=plan["working_bytes"],
            tile_size=TILE_SIZE,
            check=check,
        )
    arrays = {"image": image_writer.finish(), "labels": label_writer.finish()}
    declarations = workbench.channel_metadata(plan["source_id"])
    channel_name = f"{selection['c'] + 1}: {declarations['channels'][selection['c']]['name']}"
    table = ObjectTableWriter(project)
    try:
        measure_tiled(
            lambda y, x, h, w: read_region(project, arrays["labels"], y, x, h, w),
            lambda y, x, h, w: read_region(project, arrays["image"], y, x, h, w),
            shape,
            geometry,
            channel_name,
            table.append,
            working_bytes=plan["working_bytes"],
            tile_size=TILE_SIZE,
            check=check,
        )
        object_table = table.finalize()
    finally:
        table.close()
    label_hash = label_value_hash(project, arrays["labels"], check=check)
    session.verify_strict(check=check)
    check()
    recipe = {
        "steps": [],
        "segmentation": plan["segmentation"],
        "measurement_channels": [selection["c"]],
        "working_bytes": plan["working_bytes"],
    }
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "recipe": recipe,
        "recipe_sha256": hashlib.sha256(canonical_json(recipe).encode()).hexdigest(),
        "segmentation": segmentation,
        "processing": [],
        "channel_metadata": declarations,
        "measurement_channel_name": channel_name,
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "runtime": runtime_record(),
        "execution_policy": {
            "name": POLICY,
            "core_size": TILE_SIZE,
            "connectivity": 4,
            "halo": 0,
            "maximum_objects": 100_000,
            "maximum_provisional_components": 1_000_000,
        },
    }
    if job_id:
        provenance["job_id"] = job_id
    result = project.save_tiled_result(
        source_id=plan["source_id"],
        kind="large-components",
        arrays=arrays,
        provenance=provenance,
        object_table=object_table,
        label_sha256=label_hash,
        job_id=job_id,
        publication_guard=check,
    )
    return {
        "result": result_summary(result),
        "measurements": object_rows(project, object_table, limit=200),
    }


def bound_result(workbench, request, *, check=None):
    result = workbench.project.result(request.get("result_id"), check=check)
    if not is_large(result) or request.get("revision_hash") != result["revision_hash"]:
        raise ValueError("Choose the exact large result revision")
    return result


def view(workbench, request):
    from .research_tiled_store import validate_grid
    from .workbench import _png, display_scalar

    exact_keys(
        request, {"result_id", "revision_hash", "region", "max_edge", "labels"}, "large result view"
    )
    result = bound_result(workbench, request)
    image_grid, labels_grid = result["arrays"]["image"], result["arrays"]["labels"]
    validate_grid(workbench.project, image_grid)
    shape = image_grid["shape"]
    region = request.get("region", {"x": 0, "y": 0, "width": shape[1], "height": shape[0]})
    exact_keys(region, {"x", "y", "width", "height"}, "large view region")
    x, y = (
        integer(region.get("x"), "x", 0, shape[1] - 1),
        integer(region.get("y"), "y", 0, shape[0] - 1),
    )
    width = integer(region.get("width"), "width", 1, shape[1] - x)
    height = integer(region.get("height"), "height", 1, shape[0] - y)
    edge = integer(request.get("max_edge", 1024), "max_edge", 64, 1024)
    step = max(1, math.ceil(max(height, width) / edge))
    # Explicit nearest source-pixel centres for display only; never measurements.
    ys, xs = np.arange(y, y + height, step), np.arange(x, x + width, step)

    def sample(grid):
        out = np.empty((len(ys), len(xs)), dtype=grid["dtype"])
        for tile in grid["tiles"]:
            ty, tx = tile["y"], tile["x"]
            th, tw = tile["artifact"]["shape"]
            yi = np.flatnonzero((ys >= ty) & (ys < ty + th))
            xi = np.flatnonzero((xs >= tx) & (xs < tx + tw))
            if len(yi) and len(xi):
                data = workbench.project.load_array(tile["artifact"])
                out[np.ix_(yi, xi)] = data[np.ix_(ys[yi] - ty, xs[xi] - tx)]
        return out

    image = sample(image_grid)
    rgb, display = display_scalar(image, working_bytes=WORKING_BYTES)
    if request.get("labels", True):
        validate_grid(workbench.project, labels_grid)
        labels = sample(labels_grid)
        tint = np.stack(
            [(labels.astype(np.uint64) * v % 223 + 32) / 255 for v in (67, 97, 137)], axis=-1
        )
        rgb = np.where((labels > 0)[..., None], 0.6 * rgb + 0.4 * tint, rgb)
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "region": region,
        "shape": shape,
        "step": step,
        "image_shape": list(image.shape),
        "display": display,
        "sampling": "nearest-source-pixels-display-only",
        "image": _png(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)),
    }


def pick(workbench, request):
    from .research_tiled_store import object_row, read_region

    exact_keys(
        request, {"result_id", "revision_hash", "u", "v", "axis", "index"}, "large result pick"
    )
    result = bound_result(workbench, request)
    if request.get("axis", "z") != "z" or request.get("index", 0) != 0:
        raise ValueError("Large results contain one XY plane")
    shape = result["arrays"]["labels"]["shape"]
    u = integer(request.get("u"), "u", 0, shape[1] - 1)
    v = integer(request.get("v"), "v", 0, shape[0] - 1)
    label = int(read_region(workbench.project, result["arrays"]["labels"], v, u, 1, 1)[0, 0])
    row = object_row(workbench.project, result["object_table"], label) if label else None
    if label and row is None:
        raise ValueError("Result label is missing from its quantitative object table")
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "label": label,
        "measurement": row,
    }


def locate(workbench, request):
    from .research_tiled_store import object_row, read_region, validate_grid

    exact_keys(request, {"result_id", "revision_hash", "label"}, "large object locate")
    result = bound_result(workbench, request)
    label = integer(request.get("label"), "label", 1, 2**32 - 1)
    row = object_row(workbench.project, result["object_table"], label)
    if row is None:
        raise ValueError("The selected object does not belong to this revision")
    grid = result["arrays"]["labels"]
    validate_grid(workbench.project, grid)
    height, width = grid["shape"]
    start, stop = row.get("bbox_start"), row.get("bbox_stop_exclusive")
    if (
        not isinstance(start, list)
        or not isinstance(stop, list)
        or len(start) != 2
        or len(stop) != 2
        or any(type(value) is not int for value in start + stop)
        or not (0 <= start[0] < stop[0] <= height and 0 <= start[1] < stop[1] <= width)
    ):
        raise ValueError("The object has an invalid YX bounding box")
    centroid = row.get("centroid_index")
    if (
        not isinstance(centroid, list)
        or len(centroid) != 2
        or any(type(value) not in (int, float) or not math.isfinite(value) for value in centroid)
    ):
        raise ValueError("The object has an invalid YX centroid")
    cy, cx = math.floor(centroid[0]), math.floor(centroid[1])
    if (
        start[0] <= cy < stop[0]
        and start[1] <= cx < stop[1]
        and int(read_region(workbench.project, grid, cy, cx, 1, 1)[0, 0]) == label
    ):
        point = [cy, cx]
        return {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "label": label,
            "point_index": point,
        }
    for tile in grid["tiles"]:
        y, x = tile["y"], tile["x"]
        th, tw = tile["artifact"]["shape"]
        top, left = max(y, start[0]), max(x, start[1])
        bottom, right = min(y + th, stop[0]), min(x + tw, stop[1])
        if top >= bottom or left >= right:
            continue
        values = workbench.project.load_array(tile["artifact"])[
            top - y : bottom - y, left - x : right - x
        ]
        matches = values == label
        if np.any(matches):
            dy, dx = np.unravel_index(int(np.argmax(matches)), matches.shape)
            return {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "label": label,
                "point_index": [top + int(dy), left + int(dx)],
            }
    raise ValueError("The quantitative object has no matching pixel in this revision")


def delete_object(workbench, request, *, job_id=None, publication_guard=None):
    from .large_components import measure_tiled
    from .research_tiled_store import (
        ObjectTableWriter,
        TiledArrayWriter,
        iter_tiles,
        label_value_hash,
        object_row,
        object_rows,
        read_region,
    )
    from .workbench import geometry_from_dict, result_summary

    exact_keys(request, {"result_id", "revision_hash", "label"}, "large object removal")
    def check():
        _check(workbench, job_id, publication_guard)

    parent = bound_result(workbench, request, check=check)
    workbench.project.source(parent["source_id"], verify=True, check=check)
    label = integer(request.get("label"), "label", 1, 2**32 - 1)
    if object_row(workbench.project, parent["object_table"], label) is None:
        raise ValueError("The selected object does not belong to this revision")

    grid = parent["arrays"]["labels"]
    writer = TiledArrayWriter(workbench.project, tuple(grid["shape"]), "uint32", grid["tile_size"])
    for y, x, tile in iter_tiles(workbench.project, grid):
        check()
        edited = np.array(tile, copy=True)
        edited[edited == label] = 0
        writer.write(y, x, edited)
    labels = writer.finish()
    image = parent["arrays"]["image"]
    table = ObjectTableWriter(workbench.project)
    provenance = copy.deepcopy(parent["provenance"])
    provenance.pop("job_id", None)
    try:
        measure_tiled(
            lambda y, x, h, w: read_region(workbench.project, labels, y, x, h, w),
            lambda y, x, h, w: read_region(workbench.project, image, y, x, h, w),
            tuple(grid["shape"]),
            geometry_from_dict(provenance["geometry"]),
            provenance["measurement_channel_name"],
            table.append,
            working_bytes=provenance["recipe"]["working_bytes"],
            tile_size=grid["tile_size"],
            check=check,
        )
        objects = table.finalize()
    finally:
        table.close()
    digest = label_value_hash(workbench.project, labels, check=check)
    provenance["correction"] = {
        "parent_id": parent["id"],
        "parent_revision_hash": parent["revision_hash"],
        "operations": [{"op": "delete", "label": label}],
        "input_label_sha256": parent["label_sha256"],
        "output_label_sha256": digest,
        "working_memory_limit_bytes": provenance["recipe"]["working_bytes"],
    }
    result = workbench.project.save_tiled_result(
        source_id=parent["source_id"],
        kind="large-corrected-labels",
        arrays={"image": image, "labels": labels},
        provenance=provenance,
        object_table=objects,
        label_sha256=digest,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=check,
    )
    return {
        "result": result_summary(result),
        "measurements": object_rows(workbench.project, objects, limit=200),
    }


def execute_large(workbench, operation, request, *, job_id=None, publication_guard=None):
    if operation == "large_components_preflight":
        return preflight(workbench, request)
    if operation == "large_components_run":
        return run(workbench, request, job_id=job_id, publication_guard=publication_guard)
    if operation == "large_result_view":
        return view(workbench, request)
    if operation == "large_result_pick":
        return pick(workbench, request)
    if operation == "large_result_locate":
        return locate(workbench, request)
    if operation == "large_result_delete":
        return delete_object(workbench, request, job_id=job_id, publication_guard=publication_guard)
    if operation == "large_result_adopt":
        from .research_large_exchange import adopt_large_result

        return adopt_large_result(
            workbench, request, job_id=job_id, publication_guard=publication_guard
        )
    if operation == "large_result_export":
        from .research_large_export import execute_large_export_task

        return execute_large_export_task(
            workbench, request, job_id=job_id, publication_guard=publication_guard
        )
    raise ValueError("Unknown large-result operation")
