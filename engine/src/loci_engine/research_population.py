"""Bounded, descriptive exploration of exact immutable object measurements.

Object counts describe regions in one result, never independent biological samples.
No images are decoded and no records or scientific state are written.
"""

from __future__ import annotations

import hashlib
import math
import sys
from bisect import bisect_right
from collections.abc import Iterable
from statistics import mean as exact_mean
from typing import Any

from .quantitative import MAX_OBJECTS, exact_keys, integer
from .research_project import SHA_PATTERN, ResearchProject, canonical_json, checked_id

STATISTICS = ("mean", "sum", "min", "max", "std_population")
REQUEST_KEYS = {
    "result_id",
    "revision_hash",
    "x_metric",
    "y_metric",
    "filters",
    "sort",
    "offset",
    "limit",
    "plot_limit",
    "bins",
    "selected_label",
}


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def intensity_metric_id(channel: str, statistic: str) -> str:
    """Reversible UTF-8 hex avoids separator collisions and preserves actual names."""
    return f"intensity:{channel.encode().hex()}:{statistic}"


def _number(value: Any, name: str, *, nonnegative: bool = False) -> float | None:
    if value is None:
        return None
    if type(value) not in (int, float):
        raise ValueError(f"Invalid numeric object measurement: {name}")
    try:
        finite = math.isfinite(value)
    except OverflowError as exc:
        raise ValueError(f"Object measurement exceeds numeric range: {name}") from exc
    if not finite:
        return None
    if nonnegative and value < 0:
        raise ValueError(f"Negative object measurement: {name}")
    return float(value)


def _bound(value: Any, name: str) -> float:
    number = _number(value, name)
    if number is None:
        raise ValueError(f"{name} must be finite")
    return number


def _objects(
    rows: Iterable[dict[str, Any]],
    shape: list[int] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    result: list[dict[str, Any]] = []
    labels: set[int] = set()
    descriptors: dict[str, dict[str, Any]] = {}
    channels: set[str] = set()
    for row in rows:
        if len(result) >= MAX_OBJECTS:
            raise ValueError("Population exceeds 100000 objects")
        if not isinstance(row, dict):
            raise ValueError("Population requires actual object measurement rows")
        label = integer(row.get("label"), "object label", 1, 0xFFFFFFFF)
        if label in labels:
            raise ValueError("Duplicate object label in population")
        labels.add(label)
        kind, unit = row.get("measure_kind"), row.get("measure_unit")
        if kind not in {"area", "volume"} or not isinstance(unit, str) or not unit:
            raise ValueError("Population requires a supported object measurement schema")
        axes = "YX" if kind == "area" else "ZYX"
        if row.get("index_axes") != axes:
            raise ValueError("Object measurement axes disagree with measure kind")
        coordinates = {}
        for field in ("centroid_index", "bbox_start", "bbox_stop_exclusive"):
            values = row.get(field)
            if not isinstance(values, list) or len(values) != len(axes):
                raise ValueError("Invalid object measurement coordinates")
            if any(_number(value, field) is None for value in values):
                raise ValueError("Non-finite object measurement coordinates")
            coordinates[field] = list(values)
        starts, stops = coordinates["bbox_start"], coordinates["bbox_stop_exclusive"]
        if any(
            type(start) is not int or type(stop) is not int or start < 0 or stop <= start
            for start, stop in zip(starts, stops, strict=True)
        ):
            raise ValueError("Invalid object measurement bounds")
        if any(
            not start <= center < stop
            for start, center, stop in zip(
                starts, coordinates["centroid_index"], stops, strict=True
            )
        ):
            raise ValueError("Object centroid is outside measurement bounds")
        if shape is not None and (
            len(shape) != len(stops)
            or any(stop > extent for stop, extent in zip(stops, shape, strict=True))
        ):
            raise ValueError("Object bounds disagree with label array")
        count = integer(row.get("voxel_count"), "object voxel count", 1, 2**53)
        if count > math.prod(stop - start for start, stop in zip(starts, stops, strict=True)):
            raise ValueError("Object voxel count exceeds measurement bounds")
        values = {"voxel_count": count}

        def add(
            metric: str, value: Any, descriptor: dict[str, Any], nonnegative=False, target=values
        ):
            if metric in descriptors and descriptors[metric] != descriptor:
                raise ValueError("Population has incompatible measurement kinds or units")
            descriptors[metric] = descriptor
            target[metric] = _number(value, metric, nonnegative=nonnegative)

        add(
            "voxel_count",
            count,
            {
                "id": "voxel_count",
                "label": "Pixel count" if kind == "area" else "Voxel count",
                "kind": "count",
                "unit": "pixel" if kind == "area" else "voxel",
            },
            True,
        )
        if "measure" not in row:
            raise ValueError("Population requires actual object measurements")
        add(
            "measure",
            row["measure"],
            {
                "id": "measure",
                "label": kind.capitalize(),
                "kind": kind,
                "unit": unit,
            },
            True,
        )
        if "nearest_centroid_distance" in row:
            distance_unit = row.get("distance_unit")
            if not isinstance(distance_unit, str) or not distance_unit:
                raise ValueError("Object distance unit is missing")
            add(
                "nearest_centroid_distance",
                row["nearest_centroid_distance"],
                {
                    "id": "nearest_centroid_distance",
                    "label": "Nearest centroid distance",
                    "kind": "distance",
                    "unit": distance_unit,
                },
                True,
            )
        if "spatial" in row:
            spatial = row["spatial"]
            for name, title, metric_kind, metric_unit in (
                ("distance", "Distance to declared boundary", "distance", row["distance_unit"]),
                ("band_index", "Distance band (zero based)", "index", "index"),
            ):
                metric = "spatial:" + name
                add(
                    metric,
                    spatial[name],
                    {"id": metric, "label": title, "kind": metric_kind, "unit": metric_unit},
                    True,
                )
        intensity = row.get("intensity")
        if not isinstance(intensity, dict) or len(intensity) > 32:
            raise ValueError("Population requires bounded actual intensity measurements")
        for channel, statistics in intensity.items():
            if not isinstance(channel, str) or not channel or len(channel.encode()) > 256:
                raise ValueError("Invalid object measurement channel")
            channels.add(channel)
            if len(channels) > 32:
                raise ValueError("Population exceeds 32 measurement channels")
            if not isinstance(statistics, dict):
                raise ValueError("Invalid object intensity statistics")
            for statistic in STATISTICS:
                if statistic in statistics:
                    metric = intensity_metric_id(channel, statistic)
                    add(
                        metric,
                        statistics[statistic],
                        {
                            "id": metric,
                            "label": f"{channel} {statistic}",
                            "kind": "intensity",
                            "unit": (
                                "source-intensity*pixel"
                                if kind == "area"
                                else "source-intensity*voxel"
                            )
                            if statistic == "sum"
                            else "source-intensity",
                            "channel": channel,
                            "statistic": statistic,
                        },
                        statistic == "std_population",
                    )
        compartments = row.get("compartments")
        if compartments is not None:
            exact_keys(compartments, {"cell", "nuclear", "cytoplasm"}, "compartment measurements")
            if set(compartments) != {"cell", "nuclear", "cytoplasm"}:
                raise ValueError("Compartment measurements require a complete cell partition")
            for compartment, record in compartments.items():
                if (
                    not isinstance(record, dict)
                    or record.get("measure_kind") != kind
                    or record.get("measure_unit") != unit
                ):
                    raise ValueError("Compartment measurement kinds or units disagree with cell")
                compartment_count = integer(
                    record.get("voxel_count"), "compartment count", 0, count
                )
                for field, metric_kind, metric_unit in (
                    ("voxel_count", "count", "pixel" if kind == "area" else "voxel"),
                    ("measure", kind, unit),
                ):
                    value = _bound(record.get(field), f"compartment {field}")
                    if value < 0 or (compartment_count == 0 and value != 0):
                        raise ValueError("Invalid empty or negative compartment measure")
                    metric = f"compartment:{compartment}:{field}"
                    add(
                        metric,
                        value,
                        {
                            "id": metric,
                            "label": f"{compartment.capitalize()} {field}",
                            "kind": metric_kind,
                            "unit": metric_unit,
                            "compartment": compartment,
                        },
                        True,
                    )
                compartment_intensity = record.get("intensity")
                if (
                    not isinstance(compartment_intensity, dict)
                    or not 1 <= len(compartment_intensity) <= 32
                ):
                    raise ValueError("Compartment intensity requires bounded raw channels")
                for channel, statistics in compartment_intensity.items():
                    if not isinstance(channel, str) or not channel or len(channel.encode()) > 1024:
                        raise ValueError("Invalid compartment intensity channel")
                    exact_keys(statistics, {"count", *STATISTICS}, "compartment intensity")
                    if (
                        not isinstance(statistics, dict)
                        or set(statistics) != {"count", *STATISTICS}
                        or integer(statistics.get("count"), "compartment intensity count", 0, count)
                        != compartment_count
                    ):
                        raise ValueError("Compartment intensity count disagrees with partition")
                    for statistic in ("count", *STATISTICS):
                        value = statistics.get(statistic)
                        if statistic in {"count", "sum"}:
                            value = _bound(value, f"compartment {statistic}")
                        elif compartment_count == 0:
                            if value is not None:
                                raise ValueError("Empty compartment intensity must be undefined")
                        else:
                            value = _bound(value, f"compartment {statistic}")
                        if compartment_count == 0 and statistic in {"count", "sum"} and value != 0:
                            raise ValueError("Empty compartment count and sum must be zero")
                        metric = (
                            f"compartment:{compartment}:{intensity_metric_id(channel, statistic)}"
                        )
                        metric_unit = (
                            ("pixel" if kind == "area" else "voxel")
                            if statistic == "count"
                            else (
                                (
                                    "source-intensity*pixel"
                                    if kind == "area"
                                    else "source-intensity*voxel"
                                )
                                if statistic == "sum"
                                else "source-intensity"
                            )
                        )
                        add(
                            metric,
                            value,
                            {
                                "id": metric,
                                "label": f"{compartment.capitalize()} {channel} {statistic}",
                                "kind": "count" if statistic == "count" else "intensity",
                                "unit": metric_unit,
                                "channel": channel,
                                "statistic": statistic,
                                "compartment": compartment,
                            },
                            statistic in {"count", "std_population"},
                        )
            if (
                compartments["cell"]["voxel_count"] != count
                or compartments["nuclear"]["voxel_count"] + compartments["cytoplasm"]["voxel_count"]
                != count
            ):
                raise ValueError("Compartment counts do not conserve the cell whole")
            whole, nuclear, cytoplasm = (
                compartments[name] for name in ("cell", "nuclear", "cytoplasm")
            )
            if (
                not math.isclose(whole["measure"], row["measure"], rel_tol=1e-12, abs_tol=0)
                or not math.isclose(
                    whole["measure"],
                    nuclear["measure"] + cytoplasm["measure"],
                    rel_tol=1e-12,
                    abs_tol=0,
                )
                or set(whole["intensity"]) != set(nuclear["intensity"])
                or set(whole["intensity"]) != set(cytoplasm["intensity"])
            ):
                raise ValueError("Compartment physical measures or raw channels disagree")
        result.append({"label": label, "values": values, "index_axes": axes, **coordinates})
    ordered = [
        descriptors[key]
        for key in ("measure", "voxel_count", "nearest_centroid_distance")
        if key in descriptors
    ]
    ordered.extend(
        descriptors[key]
        for key in sorted(descriptors)
        if key.startswith(("intensity:", "compartment:", "spatial:"))
    )
    for row in result:
        row["values"] = {metric["id"]: row["values"].get(metric["id"]) for metric in ordered}
    return result, ordered


def _normalize(request: dict[str, Any], metrics: list[dict[str, Any]]) -> dict[str, Any]:
    ids = {metric["id"] for metric in metrics}
    default_x = "measure" if "measure" in ids else next(iter(ids), None)
    default_y = next(
        (metric["id"] for metric in metrics if metric.get("statistic") == "mean"),
        "voxel_count" if "voxel_count" in ids else default_x,
    )

    def metric(value, *, allow_empty=False):
        if value is None and not ids and allow_empty:
            return None
        if not isinstance(value, str) or value not in ids:
            raise ValueError("Choose an actual measured population metric")
        return value

    x, y = (
        metric(request.get("x_metric", default_x), allow_empty=True),
        metric(request.get("y_metric", default_y), allow_empty=True),
    )
    filters = request.get("filters", [])
    if not isinstance(filters, list) or len(filters) > 8:
        raise ValueError("Choose at most eight population filters")
    normalized = []
    for item in filters:
        exact_keys(item, {"metric", "min", "max"}, "population filter")
        if "min" not in item and "max" not in item:
            raise ValueError("Population filter requires a finite bound")
        entry = {"metric": metric(item.get("metric"))}
        for field in ("min", "max"):
            if field in item:
                entry[field] = _bound(item[field], f"filter {field}")
        if "min" in entry and "max" in entry and entry["min"] > entry["max"]:
            raise ValueError("Population filter minimum exceeds maximum")
        normalized.append(entry)
    # Filter order does not alter the membership receipt.
    normalized.sort(key=canonical_json)
    sort = request.get("sort")
    if sort is not None:
        exact_keys(sort, {"metric", "direction"}, "population sort")
        direction = sort.get("direction")
        if direction not in {"asc", "desc"}:
            raise ValueError("Population sort direction must be asc or desc")
        sort = {
            "metric": "label" if sort.get("metric") == "label" else metric(sort.get("metric")),
            "direction": direction,
        }
    selected = request.get("selected_label")
    if selected is not None:
        selected = integer(selected, "selected label", 1, 0xFFFFFFFF)
    return {
        "x_metric": x,
        "y_metric": y,
        "filters": normalized,
        "sort": sort,
        "offset": integer(request.get("offset", 0), "population offset", 0, MAX_OBJECTS),
        "limit": integer(request.get("limit", 200), "population limit", 1, 200),
        "plot_limit": integer(request.get("plot_limit", 2000), "plot limit", 1, 2000),
        "bins": integer(request.get("bins", 32), "histogram bins", 1, 64),
        "selected_label": selected,
    }


def _summary(rows, metric, *, _legacy_summary=False):
    values = (
        sorted(row["values"][metric] for row in rows if row["values"][metric] is not None)
        if metric is not None
        else []
    )
    size = len(values)
    if size:
        # Preserve ordinary arithmetic for existing exact query receipts. Use
        # exact accumulation when division loses subnormal precision or the
        # rounded quotients overflow despite a finite mathematical mean.
        if not _legacy_summary and any(
            value != 0 and abs(value / size) < sys.float_info.min for value in values
        ):
            mean = exact_mean(values)
        else:
            try:
                mean = math.fsum(value / size for value in values)
            except OverflowError:
                if _legacy_summary:
                    raise
                mean = exact_mean(values)
        median = (
            values[size // 2] if size % 2 else (values[size // 2 - 1] / 2 + values[size // 2] / 2)
        )
        if not _legacy_summary and size % 2 == 0:
            middle = values[size // 2 - 1 : size // 2 + 1]
            if any(value != 0 and abs(value / 2) < sys.float_info.min for value in middle):
                median = exact_mean(middle)
    else:
        mean = median = None
    return {
        "metric": metric,
        "count": size,
        "missing_count": len(rows) - size,
        "min": values[0] if size else None,
        "max": values[-1] if size else None,
        "mean": mean,
        "median": median,
    }, values


def query_population(
    rows: Iterable[dict[str, Any]],
    request: dict[str, Any],
    binding: dict[str, str],
    *,
    shape: list[int] | None = None,
    _legacy_summary: bool = False,
) -> dict[str, Any]:
    """Pure numeric query; caller must verify the immutable revision and source."""
    exact_keys(request, REQUEST_KEYS, "population query")
    objects, metrics = _objects(rows, shape)
    query = _normalize(request, metrics)
    filtered = []
    filter_missing = 0
    for row in objects:
        missing = any(row["values"][item["metric"]] is None for item in query["filters"])
        if missing:
            filter_missing += 1
            continue
        if all(
            ("min" not in item or row["values"][item["metric"]] >= item["min"])
            and ("max" not in item or row["values"][item["metric"]] <= item["max"])
            for item in query["filters"]
        ):
            filtered.append(row)
    membership = _hash(
        {**binding, "filters": query["filters"], "labels": sorted(row["label"] for row in filtered)}
    )
    ordered = sorted(filtered, key=lambda row: row["label"])
    sort = query["sort"]
    if sort:
        metric = sort["metric"]
        sign = 1 if sort["direction"] == "asc" else -1
        if metric == "label":
            ordered.sort(key=lambda row: sign * row["label"])
        else:
            ordered.sort(
                key=lambda row: (
                    row["values"][metric] is None,
                    sign * row["values"][metric] if row["values"][metric] is not None else 0,
                    row["label"],
                )
            )
    selected = next((row for row in objects if row["label"] == query["selected_label"]), None)
    selected_index = next(
        (index for index, row in enumerate(ordered) if row["label"] == query["selected_label"]),
        None,
    )
    x, y = query["x_metric"], query["y_metric"]
    pairs = [
        {"label": row["label"], "x": row["values"][x], "y": row["values"][y]}
        for row in sorted(filtered, key=lambda row: row["label"])
        if x is not None
        and y is not None
        and row["values"][x] is not None
        and row["values"][y] is not None
    ]
    total_pairs = len(pairs)
    plot_limit = query["plot_limit"]
    sampled = total_pairs > plot_limit
    if sampled:
        pairs = (
            [pairs[0]]
            if plot_limit == 1
            else [
                pairs[index * (total_pairs - 1) // (plot_limit - 1)] for index in range(plot_limit)
            ]
        )
    x_summary, x_values = _summary(filtered, x, _legacy_summary=_legacy_summary)
    y_summary, _ = _summary(filtered, y, _legacy_summary=_legacy_summary)
    edges, counts = [], []
    if x_values:
        low, high = x_values[0], x_values[-1]
        if low == high:
            edges, counts = [low, high], [len(x_values)]
        else:
            bins = query["bins"]
            edges = sorted(
                set(
                    [low, high]
                    + [low * (1 - index / bins) + high * (index / bins) for index in range(1, bins)]
                )
            )
            counts = [0] * (len(edges) - 1)
            for value in x_values:
                counts[min(bisect_right(edges, value) - 1, len(counts) - 1)] += 1
    return {
        "schema": "loci.population/v1",
        **binding,
        "metrics": metrics,
        "query": query,
        "total_count": len(objects),
        "filtered_count": len(filtered),
        "accounting": {
            "filter_excluded_count": len(objects) - len(filtered),
            "filter_missing_count": filter_missing,
            "scatter_missing_count": len(filtered) - total_pairs,
            "metric_missing_counts": {
                metric["id"]: sum(row["values"][metric["id"]] is None for row in filtered)
                for metric in metrics
            },
        },
        "rows": ordered[query["offset"] : query["offset"] + query["limit"]],
        "selected": {"row": selected, "filtered_index": selected_index} if selected else None,
        "scatter": {
            "points": pairs,
            "total_count": total_pairs,
            "displayed_count": len(pairs),
            "sampled": sampled,
            "sampling": "deterministic-evenly-spaced-label-order" if sampled else "all",
        },
        "histogram": {
            "metric": x,
            "edges": edges,
            "counts": counts,
            "finite_count": len(x_values),
            "missing_count": len(filtered) - len(x_values),
            "endpoints": "left-closed-right-open-last-closed",
        },
        "summaries": {"x": x_summary, "y": y_summary},
        "membership_sha256": membership,
        "query_sha256": _hash({**binding, "query": query, "membership_sha256": membership}),
    }


def population_query(project: ResearchProject, request: dict[str, Any]) -> dict[str, Any]:
    exact_keys(request, REQUEST_KEYS, "population query")
    result_id = checked_id(request.get("result_id"))
    revision = request.get("revision_hash")
    if not isinstance(revision, str) or not SHA_PATTERN.fullmatch(revision):
        raise ValueError("Population query requires an exact result revision hash")
    result = project.result(result_id)
    if result["revision_hash"] != revision:
        raise ValueError("Population query requires the exact result revision")
    source = project.source(result["source_id"], verify=True)
    if source["sha256"] != result["source_sha256"]:
        raise ValueError("Population result source identity disagrees with registered source")
    if "labels" not in result.get("arrays", {}):
        raise ValueError("Population query requires a label-bearing measured result")
    if result["schema"] == "loci.research-result/v1":
        rows = result["provenance"].get("measurements")
        if not isinstance(rows, list):
            raise ValueError("Population query requires actual object measurements")
        if len(rows) > MAX_OBJECTS:
            raise ValueError("Population exceeds 100000 objects")
    elif result["schema"] == "loci.research-result/v2":
        from .research_tiled_store import iter_object_rows

        if result["object_count"] > MAX_OBJECTS:
            raise ValueError("Population exceeds 100000 objects")
        rows = iter_object_rows(project, result["object_table"])
    else:
        raise ValueError("Unsupported population result schema")
    binding = {
        "result_id": result_id,
        "revision_hash": revision,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
    }
    labels = result["arrays"]["labels"]
    shape = labels.get("shape")
    if (
        not isinstance(shape, list)
        or len(shape) not in {2, 3}
        or any(type(extent) is not int or extent < 1 for extent in shape)
        or labels.get("dtype")
        not in {
            "uint8",
            "uint16",
            "uint32",
            "uint64",
            "int8",
            "int16",
            "int32",
            "int64",
        }
    ):
        raise ValueError("Population requires a YX or ZYX integer label array")
    receipt = query_population(rows, request, binding, shape=shape)
    if "object_count" in result and (
        type(result["object_count"]) is not int or result["object_count"] != receipt["total_count"]
    ):
        raise ValueError("Population object count disagrees with actual measurement rows")
    if project.source(source["id"], verify=True)["sha256"] != source["sha256"]:
        raise ValueError("Population source changed during query")
    return receipt


def population_locate(project: ResearchProject, request: dict[str, Any]) -> dict[str, Any]:
    """Find the closest owned pixel to the measured centroid, with index-order ties."""
    import itertools

    import numpy as np

    from .working_result import _sha256_file_stable

    exact_keys(request, {"result_id", "revision_hash", "label"}, "population locate")
    result_id = checked_id(request.get("result_id"))
    revision = request.get("revision_hash")
    if not isinstance(revision, str) or not SHA_PATTERN.fullmatch(revision):
        raise ValueError("Population locate requires an exact result revision hash")
    result = project.result(result_id)
    if result["revision_hash"] != revision:
        raise ValueError("Population locate requires the exact result revision")
    source = project.source(result["source_id"], verify=True)
    if source["sha256"] != result["source_sha256"]:
        raise ValueError("Population result source identity disagrees with registered source")
    label = integer(request.get("label"), "object label", 1, 0xFFFFFFFF)
    if "labels" not in result.get("arrays", {}):
        raise ValueError("Population locate requires a label-bearing measured result")
    if result["schema"] == "loci.research-result/v2":
        from .research_tiled_store import object_row, read_region

        row = object_row(project, result["object_table"], label)
        shape = result["arrays"]["labels"]["shape"]
    elif result["schema"] == "loci.research-result/v1":
        rows = result["provenance"].get("measurements")
        if not isinstance(rows, list):
            raise ValueError("Population locate requires actual object measurements")
        checked, _ = _objects(rows)
        row = next((row for row in checked if row["label"] == label), None)
        file, digest, size, labels = project._open_array_artifact(result["arrays"]["labels"])
        if labels.dtype.kind not in "ui" or labels.ndim not in {2, 3}:
            raise ValueError("Population locate requires a YX or ZYX integer label array")
        shape = labels.shape
    else:
        raise ValueError("Unsupported population result schema")
    if row is None:
        raise ValueError("The selected object does not belong to this revision")
    # Also validate canonical geometry of the v2 table row before using it.
    if result["schema"] == "loci.research-result/v2":
        checked, _ = _objects([row])
        row = checked[0]
    start, stop, centroid = row["bbox_start"], row["bbox_stop_exclusive"], row["centroid_index"]
    if len(shape) != len(start) or any(
        end > extent for end, extent in zip(stop, shape, strict=True)
    ):
        raise ValueError("Object bounds disagree with label array")
    best: tuple[float, tuple[int, ...]] | None = None
    # Each temporary numeric block is at most 64^3 pixels, independent of object size.
    for origin in itertools.product(
        *(range(begin, end, 64) for begin, end in zip(start, stop, strict=True))
    ):
        end = tuple(min(begin + 64, bound) for begin, bound in zip(origin, stop, strict=True))
        if result["schema"] == "loci.research-result/v2":
            block = read_region(
                project,
                result["arrays"]["labels"],
                origin[0],
                origin[1],
                end[0] - origin[0],
                end[1] - origin[1],
            )
        else:
            block = labels[
                tuple(slice(begin, bound) for begin, bound in zip(origin, end, strict=True))
            ]
        coordinates = np.argwhere(block == label)
        if not len(coordinates):
            continue
        coordinates += np.array(origin)
        distances = np.square(coordinates - np.array(centroid)).sum(axis=1)
        index = int(np.argmin(distances))
        candidate = (float(distances[index]), tuple(int(value) for value in coordinates[index]))
        if best is None or candidate < best:
            best = candidate
    if result["schema"] == "loci.research-result/v1":
        after, after_size = _sha256_file_stable(file, reject_symlink=True)
        if after != digest or after_size != size:
            raise ValueError("Label artifact changed during object location")
    if best is None:
        raise ValueError("The quantitative object has no matching pixel in this revision")
    if project.source(source["id"], verify=True)["sha256"] != source["sha256"]:
        raise ValueError("Population source changed during location")
    return {
        "result_id": result_id,
        "revision_hash": revision,
        "label": label,
        "point_index": list(best[1]),
    }
