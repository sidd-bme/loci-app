"""Exact normalized scientific tables from stored measurements, without array decoding.

The service owns source/review/group authorization and atomic publication. These
functions consume its pinned snapshots and caller-owned text streams only.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
from collections.abc import Callable, Iterator
from contextlib import ExitStack
from pathlib import Path, PureWindowsPath
from typing import Any

from .research_population import _objects
from .research_project import canonical_json

NULL = r"\N"
TEXT_ENCODING = {
    "null": NULL,
    "text": (
        "Prefix one apostrophe to text starting with an apostrophe or whose first "
        "non-whitespace character is =,+,-,@; double an initial backslash. "
        "Decode null first, then remove one initial apostrophe or backslash. "
        "Empty text remains empty."
    ),
    "numbers": (
        "Finite Python repr for floats; decimal integers; no rounding; signed zero preserved."
    ),
    "status": (
        "value is an actual number; null is an explicit stored null; missing is an absent field."
    ),
}
KEY = ("result_id", "revision_hash")
OBJECT_KEY = (*KEY, "label")


def _field(name: str, kind: str = "string", description: str = "") -> dict:
    descriptions = {
        "label": "Original nonzero uint32 object label, encoded as text; never biological n",
        "index_axes": "Stored spatial index order YX or ZYX; absent Z fields are null",
        "world_frame": "Declared coordinate frame for world XYZ centroid; no inferred frame",
        "measure": "Exact stored area or volume; use measure_kind and measure_unit together",
        "measure_unit": "Stored spatial measurement unit; no implicit unit conversion",
        "metric_id": "Collision-safe metric identity; channel names use reversible UTF-8 hex",
        "value": "Exact stored finite numeric scalar; raw_numeric_type governs parsing",
        "status": "value, null (explicit stored null), or missing (absent stored field)",
        "raw_numeric_type": "integer or float for values; null for null/missing states",
        "row_sha256": "SHA-256 of all original rows in label order, including unselected rows",
        "biological_replicate": "Declared grouping only; null remains unassigned; not object n",
    }
    if name.startswith("centroid_index_"):
        description = "Stored centroid on the result grid in the named index axis"
    elif name.startswith("centroid_world_"):
        description = "Stored XYZ world centroid in distance_unit and world_frame"
    elif name.startswith("bbox_stop_exclusive_"):
        description = "Exclusive bounding-box stop on the result grid in the named index axis"
    elif name.startswith("bbox_start_"):
        description = "Inclusive bounding-box start on the result grid in the named index axis"
    return {
        "name": name,
        "type": kind,
        "description": description or descriptions.get(name, name.replace("_", " ")),
    }


def _fields(names: str, **types: str) -> list[dict]:
    return [_field(name, types.get(name, "string")) for name in names.split()]


SCHEMAS = {
    "results.csv": {
        "fields": _fields(
            "result_id revision_hash source_id source_sha256 schema kind parent_id "
            "created_at engine_version total_count selected_count measurement_count "
            "row_sha256 review_disposition review_json geometry_json selection_json",
            total_count="integer",
            selected_count="integer",
            measurement_count="integer",
        ),
        "primaryKey": list(KEY),
        "foreignKeys": [],
    },
    "objects.csv": {
        "fields": _fields(
            "result_id revision_hash label index_axes centroid_index_y centroid_index_x "
            "centroid_index_z centroid_world_x centroid_world_y centroid_world_z "
            "world_frame bbox_start_y bbox_start_x bbox_start_z bbox_stop_exclusive_y "
            "bbox_stop_exclusive_x bbox_stop_exclusive_z voxel_count measure "
            "measure_kind measure_unit distance_unit touches_crop_border",
            voxel_count="integer",
            measure="number",
            touches_crop_border="boolean",
            **{
                f"centroid_{space}_{axis}": "number"
                for space, axes in (("index", "yxz"), ("world", "xyz"))
                for axis in axes
            },
            **{
                f"bbox_{edge}_{axis}": "integer"
                for edge in ("start", "stop_exclusive")
                for axis in "yxz"
            },
        ),
        "primaryKey": list(OBJECT_KEY),
        "foreignKeys": [
            {"fields": list(KEY), "reference": {"resource": "results.csv", "fields": list(KEY)}}
        ],
    },
    "measurements.csv": {
        "fields": _fields(
            "result_id revision_hash label metric_id kind unit channel compartment "
            "statistic value status raw_numeric_type",
            value="number",
        ),
        "primaryKey": [*OBJECT_KEY, "metric_id"],
        "foreignKeys": [
            {
                "fields": list(OBJECT_KEY),
                "reference": {"resource": "objects.csv", "fields": list(OBJECT_KEY)},
            }
        ],
    },
    "samples.csv": {
        "fields": _fields(
            "source_id document_revision updated_at study sample condition "
            "biological_replicate plate well",
            document_revision="integer",
        ),
        "primaryKey": ["source_id"],
        "foreignKeys": [],
    },
    "groups.csv": {
        "fields": _fields(
            "group_id result_id revision_hash source_id source_sha256 name record_sha256 "
            "membership_sha256 total_count included_count exported_count definition_json",
            total_count="integer",
            included_count="integer",
            exported_count="integer",
        ),
        "primaryKey": ["group_id"],
        "foreignKeys": [
            {"fields": list(KEY), "reference": {"resource": "results.csv", "fields": list(KEY)}}
        ],
    },
    "memberships.csv": {
        "fields": _fields("group_id result_id revision_hash label"),
        "primaryKey": ["group_id", *OBJECT_KEY],
        "foreignKeys": [
            {
                "fields": ["group_id"],
                "reference": {"resource": "groups.csv", "fields": ["group_id"]},
            },
            {
                "fields": list(OBJECT_KEY),
                "reference": {"resource": "objects.csv", "fields": list(OBJECT_KEY)},
            },
        ],
    },
}


def encode_cell(value: Any) -> str:
    """Lossless, formula-safe scalar CSV encoding; schema defines decoding."""
    if value is None:
        return NULL
    if isinstance(value, str):
        if value.startswith("\\"):
            return "\\" + value
        if value.startswith("'") or value.lstrip()[:1] in {"=", "+", "-", "@"}:
            return "'" + value
        return value
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if type(value) is float and math.isfinite(value):
        return repr(value)
    raise ValueError("Scientific CSV requires finite scalar values")


PRIVATE_KEYS = {
    "password",
    "credential",
    "credentials",
    "access_token",
    "api_key",
    "secret",
    "canonical_path",
    "source_path",
    "file_path",
    "locator",
    "destination",
    "compute_profile",
    "ssh",
    "ssh_alias",
    "ssh_aliases",
    "ssh_settings",
    "ssh_config",
    "ssh_host",
    "ssh_key",
    "ssh_private_key",
}


def _finite_tree(value: Any, depth: int = 0) -> None:
    """Preserve benign extensions but reject nonfinite values and private locators."""
    if depth > 32:
        raise ValueError("Stored scientific data exceeds its nesting bound")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError("Stored scientific object keys must be text")
            normalized = key.lower().replace("-", "_")
            if normalized.startswith("private_") or normalized in PRIVATE_KEYS:
                raise ValueError("Stored scientific data contains private metadata")
            _finite_tree(key, depth + 1)
            _finite_tree(child, depth + 1)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _finite_tree(child, depth + 1)
    elif isinstance(value, str):
        if Path(value).is_absolute() or PureWindowsPath(value).is_absolute():
            raise ValueError("Stored scientific data contains an absolute path")
        if value.lower().startswith("file://"):
            raise ValueError("Stored scientific data contains a private file locator")
    elif type(value) is float and not math.isfinite(value):
        raise ValueError("Stored scientific data contains non-finite values")


def _optional_spatial_fields(row: dict) -> None:
    """Check present producer coordinates without filling or transforming them."""
    for field in ("centroid_world_xyz", "principal_rms_radii"):
        if field not in row:
            continue
        values = row[field]
        if not isinstance(values, list) or len(values) != 3:
            raise ValueError(f"Stored {field} requires exactly three numeric components")
        for value in values:
            if type(value) not in (int, float):
                raise ValueError(f"Stored {field} components must be numeric")
            try:
                finite = math.isfinite(value)
            except OverflowError as exc:
                raise ValueError(f"Stored {field} exceeds the numeric range") from exc
            if not finite:
                raise ValueError(f"Stored {field} must be finite")
            if field == "principal_rms_radii" and value < 0:
                raise ValueError("Stored principal RMS radii must be nonnegative")
    if "principal_rms_radii" in row:
        unit = row.get("distance_unit")
        if not isinstance(unit, str) or not unit:
            raise ValueError("Stored principal RMS radii require a recorded distance unit")


def _raw_rows(project: Any, item: dict, check: Callable | None) -> Iterator[dict]:
    result = item["result"]
    if result["schema"] == "loci.research-result/v1":
        provenance = result.get("provenance", {})
        if "measurements" not in provenance:
            # Study plans keep compact result snapshots; load just this result's
            # authoritative measurements for the duration of the current pass.
            authoritative = project.result(result["id"], check=check)
            if any(
                authoritative.get(key) != result.get(key)
                for key in ("id", "schema", "revision_hash", "source_id", "source_sha256")
            ):
                raise ValueError("Authoritative measurements have a stale result/source binding")
            provenance = authoritative.get("provenance", {})
        rows = provenance.get("measurements")
        if not isinstance(rows, list) or len(rows) > 100_000:
            raise ValueError("Scientific tables require at most 100000 stored measurements")
        if any(not isinstance(row, dict) or type(row.get("label")) is not int for row in rows):
            raise ValueError("Scientific tables require labelled object measurements")
        rows = sorted(rows, key=lambda row: row["label"])
    elif result["schema"] == "loci.research-result/v2":
        from .research_tiled_store import iter_object_rows

        rows = iter_object_rows(project, result["object_table"], check=check)
    else:
        raise ValueError("Unsupported scientific result schema")
    seen = set()
    shape = result.get("arrays", {}).get("labels", {}).get("shape")
    if not isinstance(shape, list) or len(shape) not in {2, 3}:
        raise ValueError("Scientific object export requires a labelled YX or ZYX result")
    for index, row in enumerate(rows):
        if check is not None and index % 200 == 0:
            check()
        _finite_tree(row)
        _optional_spatial_fields(row)
        # This oracle checks physical kinds/units, axes, bounds and partitions.
        # Its coerced numeric output is deliberately discarded.
        _objects([row], shape)
        label = row["label"]
        if label in seen:
            raise ValueError("Duplicate scientific object label")
        seen.add(label)
        yield row
    if "object_count" in result and result["object_count"] != len(seen):
        raise ValueError("Scientific object count disagrees with stored measurements")


def _selection(item: dict) -> set[int] | None:
    labels = item.get("selected_labels")
    if labels is None:
        return None
    if (
        not isinstance(labels, list)
        or len(labels) > 100_000
        or any(type(label) is not int or not 1 <= label <= 0xFFFFFFFF for label in labels)
        or labels != sorted(set(labels))
    ):
        raise ValueError("Selected labels must be sorted unique nonzero uint32 labels")
    return set(labels)


def _metric_value(row: dict, descriptor: dict) -> tuple[Any, str]:
    if descriptor["id"].startswith("spatial:"):
        field = descriptor["id"].split(":", 1)[1]
        target = row.get("spatial", {})
        if field not in target:
            return None, "missing"
        return target[field], "null" if target[field] is None else "value"
    if descriptor["id"].startswith("principal_rms_radius:"):
        if "principal_rms_radii" not in row:
            return None, "missing"
        index = int(descriptor["id"].split(":")[1]) - 1
        return row["principal_rms_radii"][index], "value"
    target = row
    if "compartment" in descriptor:
        target = target.get("compartments", {}).get(descriptor["compartment"], {})
    if "channel" in descriptor:
        target = target.get("intensity", {}).get(descriptor["channel"], {})
        field = descriptor["statistic"]
    elif "compartment" in descriptor:
        field = descriptor["id"].rsplit(":", 1)[1]
    else:
        field = descriptor["id"]
    if field not in target:
        return None, "missing"
    value = target[field]
    return value, "null" if value is None else "value"


def _metrics(row: dict) -> list[dict]:
    descriptors = _objects([row])[1]
    if "principal_rms_radii" in row:
        descriptors.extend(
            {
                "id": f"principal_rms_radius:{index + 1}",
                "label": f"Principal RMS radius {index + 1} (stored order)",
                "kind": "distance",
                "unit": row["distance_unit"],
            }
            for index in range(3)
        )
    return descriptors


def _measurement(result: dict, row: dict, descriptor: dict) -> dict:
    value, status = _metric_value(row, descriptor)
    if status == "value" and (type(value) not in (int, float) or not math.isfinite(value)):
        raise ValueError("Scientific measurement is not a finite number")
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "label": str(row["label"]),
        "metric_id": descriptor["id"],
        **{
            key: descriptor.get(key)
            for key in ("kind", "unit", "channel", "compartment", "statistic")
        },
        "value": value,
        "status": status,
        "raw_numeric_type": None
        if status != "value"
        else ("integer" if type(value) is int else "float"),
    }


def _hash_row(digest: Any, result: dict, row: dict) -> None:
    digest.update(
        (
            canonical_json(
                {"result_id": result["id"], "revision_hash": result["revision_hash"], "object": row}
            )
            + "\n"
        ).encode()
    )


def inspect_item(project: Any, item: dict, check: Callable | None = None) -> dict:
    """Validate every raw row; return bounded exact-string preview and totals."""
    selection = _selection(item)
    descriptors: dict[str, dict] = {}
    channels: dict[str, set[str]] = {"object": set(), "compartment": set()}
    total = selected = 0
    found = set()
    preview_rows = []
    digest = hashlib.sha256()
    for row in _raw_rows(project, item, check):
        total += 1
        _hash_row(digest, item["result"], row)
        for descriptor in _metrics(row):
            if "channel" in descriptor:
                scope = "compartment" if "compartment" in descriptor else "object"
                channels[scope].add(descriptor["channel"])
                if len(channels[scope]) > 32:
                    raise ValueError("Result exceeds 32 distinct channels per measurement scope")
            identity = descriptor["id"]
            if identity in descriptors and descriptors[identity] != descriptor:
                raise ValueError("Result contains incompatible metric kinds or units")
            descriptors[identity] = descriptor
        if selection is None or row["label"] in selection:
            selected += 1
            found.add(row["label"])
            if len(preview_rows) < 5:
                preview_rows.append(row)
    if selection is not None and found != selection:
        raise ValueError("Selected object labels are absent from the exact result")
    ordered = [descriptors[key] for key in sorted(descriptors)]
    preview = [
        {
            "label": str(row["label"]),
            "measure": encode_cell(row.get("measure")),
            "measure_unit": row["measure_unit"],
            "status": "missing"
            if "measure" not in row
            else ("null" if row["measure"] is None else "value"),
        }
        for row in preview_rows
    ]
    return {
        "total_count": total,
        "selected_count": selected,
        "measurement_count": selected * len(ordered),
        "row_sha256": digest.hexdigest(),
        "preview": preview,
        "descriptors": ordered,
        "units": sorted({descriptor["unit"] for descriptor in ordered}),
    }


def _object(result: dict, row: dict) -> dict:
    record = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "label": str(row["label"]),
    }
    for key in (
        "index_axes",
        "world_frame",
        "voxel_count",
        "measure",
        "measure_kind",
        "measure_unit",
        "distance_unit",
        "touches_crop_border",
    ):
        record[key] = row.get(key)
    for field in ("centroid_index", "bbox_start", "bbox_stop_exclusive"):
        for axis, value in zip(row["index_axes"].lower(), row[field], strict=True):
            record[f"{field}_{axis}"] = value
    for axis, value in zip("xyz", row.get("centroid_world_xyz", [None] * 3), strict=True):
        record[f"centroid_world_{axis}"] = value
    return record


def write_tables(
    project: Any,
    items: list[dict],
    open_text: Callable,
    check: Callable | None = None,
    progress: Callable | None = None,
) -> dict:
    """Write fixed-schema CSV tables and authoritative exact raw object JSONL."""
    ordered_items = sorted(
        items, key=lambda item: (item["result"]["id"], item["result"]["revision_hash"])
    )
    keys = [(item["result"]["id"], item["result"]["revision_hash"]) for item in ordered_items]
    if len(keys) != len(set(keys)):
        raise ValueError("Repeated result revision in scientific export")
    inspections = [inspect_item(project, item, check) for item in ordered_items]
    tables = {
        name: {
            **json.loads(json.dumps(schema)),
            "format": "csv",
            "row_count": 0,
            "encoding": TEXT_ENCODING,
        }
        for name, schema in SCHEMAS.items()
    }
    tables["object-records.jsonl"] = {
        "format": "jsonl",
        "fields": [
            _field("result_id"),
            _field("revision_hash"),
            _field("object", "object", "Exact original selected measurement row"),
        ],
        "row_count": 0,
        "primaryKey": [*KEY, "object.label"],
        "foreignKeys": [],
    }
    samples = {}
    groups_seen = set()
    with ExitStack() as stack:
        writers = {}
        for name, schema in SCHEMAS.items():
            stream = stack.enter_context(open_text(name))
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow([field["name"] for field in schema["fields"]])
            writers[name] = writer
        raw_stream = stack.enter_context(open_text("object-records.jsonl"))

        def emit(name: str, record: dict) -> None:
            _finite_tree(record)
            writers[name].writerow(
                [encode_cell(record.get(field["name"])) for field in SCHEMAS[name]["fields"]]
            )
            tables[name]["row_count"] += 1
            if check is not None and tables[name]["row_count"] % 200 == 0:
                check()

        completed = 0
        for item, inspection in zip(ordered_items, inspections, strict=True):
            result = item["result"]
            source = item["source"]
            if source["id"] != result["source_id"] or source["sha256"] != result["source_sha256"]:
                raise ValueError("Export snapshot source binding disagrees with result")
            provenance = result["provenance"]
            review = item.get("review")
            for metadata in (review, provenance.get("geometry"), provenance.get("selection")):
                _finite_tree(metadata)
            emit(
                "results.csv",
                {
                    "result_id": result["id"],
                    **{
                        key: result.get(key)
                        for key in (
                            "revision_hash",
                            "source_id",
                            "source_sha256",
                            "schema",
                            "kind",
                            "parent_id",
                            "created_at",
                            "engine_version",
                        )
                    },
                    **{
                        key: inspection[key]
                        for key in (
                            "total_count",
                            "selected_count",
                            "measurement_count",
                            "row_sha256",
                        )
                    },
                    "review_disposition": review.get("disposition") if review else None,
                    "review_json": canonical_json(review) if review is not None else None,
                    "geometry_json": canonical_json(provenance.get("geometry")),
                    "selection_json": canonical_json(provenance.get("selection")),
                },
            )
            sample = item.get("sample")
            if sample is not None:
                from .study_analysis import validate_sample_metadata

                if sample["id"] != source["id"] or sample["kind"] != "sample":
                    raise ValueError("Sample document does not belong to export source")
                _finite_tree(sample["data"])
                metadata = validate_sample_metadata(sample["data"]).to_dict()
                if source["id"] in samples and samples[source["id"]] != sample:
                    raise ValueError("Conflicting sample snapshots for one source")
                if source["id"] not in samples:
                    samples[source["id"]] = sample
                    emit(
                        "samples.csv",
                        {
                            "source_id": source["id"],
                            "document_revision": sample["revision"],
                            "updated_at": sample["updated_at"],
                            **metadata,
                        },
                    )
            selection = _selection(item)
            selected_labels = set()
            digest = hashlib.sha256()
            for row in _raw_rows(project, item, check):
                _hash_row(digest, result, row)
                if selection is not None and row["label"] not in selection:
                    continue
                selected_labels.add(row["label"])
                emit("objects.csv", _object(result, row))
                for descriptor in inspection["descriptors"]:
                    emit("measurements.csv", _measurement(result, row, descriptor))
                raw_stream.write(
                    canonical_json(
                        {
                            "result_id": result["id"],
                            "revision_hash": result["revision_hash"],
                            "object": row,
                        }
                    )
                    + "\n"
                )
                tables["object-records.jsonl"]["row_count"] += 1
                completed += 1
                if progress is not None and completed % 200 == 0:
                    progress(completed)
            if (
                digest.hexdigest() != inspection["row_sha256"]
                or len(selected_labels) != inspection["selected_count"]
            ):
                raise ValueError("Stored measurements changed during scientific export")
            for document in sorted(item.get("groups", []), key=lambda value: value["id"]):
                data, group_id = document["data"], document["id"]
                _finite_tree(data)
                receipt = data["receipt"]
                if group_id in groups_seen:
                    raise ValueError("Repeated group in scientific export")
                groups_seen.add(group_id)
                for key, expected in (
                    ("result_id", result["id"]),
                    ("revision_hash", result["revision_hash"]),
                    ("source_id", source["id"]),
                    ("source_sha256", source["sha256"]),
                ):
                    if receipt[key] != expected:
                        raise ValueError("Group does not bind the exact exported result")
                members = sorted(selected_labels.intersection(receipt["labels"]))
                emit(
                    "groups.csv",
                    {
                        "group_id": group_id,
                        **{
                            key: receipt[key]
                            for key in (
                                "result_id",
                                "revision_hash",
                                "source_id",
                                "source_sha256",
                                "membership_sha256",
                                "total_count",
                                "included_count",
                            )
                        },
                        "name": data["name"],
                        "record_sha256": data["record_sha256"],
                        "definition_json": canonical_json(data["definition"]),
                        "exported_count": len(members),
                    },
                )
                for label in members:
                    emit(
                        "memberships.csv",
                        {
                            "group_id": group_id,
                            "result_id": result["id"],
                            "revision_hash": result["revision_hash"],
                            "label": str(label),
                        },
                    )
        if progress is not None:
            progress(completed)
    return tables
