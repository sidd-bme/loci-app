"""Small, explicit study-level summaries for object measurement records.

This module deliberately treats objects as correlated observations. Images are
first reduced to an image summary, images are then reduced within a biological
replicate, and only replicate summaries enter condition-level statistics.
"""

from __future__ import annotations

import csv
import io
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

_FIELDS = ("study", "sample", "condition", "biological_replicate", "plate", "well")
_TEXT_FIELDS = {"study", "sample", "condition", "plate", "well"}


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError(f"{name} must be non-empty text of at most 256 characters")
    if any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise ValueError(f"{name} contains control characters")
    return value


@dataclass(frozen=True)
class StudySampleMetadata:
    study: str
    sample: str
    condition: str
    biological_replicate: str | None = None
    plate: str | None = None
    well: str | None = None

    def __post_init__(self) -> None:
        for field in ("study", "sample", "condition"):
            _text(getattr(self, field), field)
        for field in ("biological_replicate", "plate", "well"):
            value = getattr(self, field)
            if value is not None:
                _text(value, field)

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any]) -> StudySampleMetadata:
        if not isinstance(values, Mapping) or set(values) - set(_FIELDS):
            raise ValueError("Invalid or unknown study sample metadata fields")
        missing = {"study", "sample", "condition"} - set(values)
        if missing:
            raise ValueError(f"Missing study sample metadata: {sorted(missing)}")
        return cls(**{key: values.get(key) for key in _FIELDS})

    def to_dict(self) -> dict[str, str | None]:
        return {field: getattr(self, field) for field in _FIELDS}


def validate_sample_metadata(
    values: Mapping[str, Any] | StudySampleMetadata,
) -> StudySampleMetadata:
    """Validate metadata; a missing biological replicate remains unassigned."""
    return (
        values
        if isinstance(values, StudySampleMetadata)
        else StudySampleMetadata.from_mapping(values)
    )


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _records(records: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    result = [dict(record) for record in records]
    seen_sources: set[Any] = set()
    seen_results: set[Any] = set()
    for record in result:
        if "metadata" not in record or "objects" not in record:
            raise ValueError("Each measurement record requires metadata and objects")
        validate_sample_metadata(record["metadata"])
        for key, seen in (("source_id", seen_sources), ("result_id", seen_results)):
            if key in record and record[key] is not None:
                if record[key] in seen:
                    raise ValueError(f"Duplicate {key} cannot be pooled")
                seen.add(record[key])
        if not isinstance(record["objects"], list):
            raise ValueError("objects must be a list of quantitative.measure_objects rows")
        for row in record["objects"]:
            if not isinstance(row, Mapping):
                raise ValueError("Object rows must be mappings")
    return result


def _row_value(row: Mapping[str, Any], value: str) -> float:
    if value in row:
        return _number(row[value], value)
    measurement = row.get("measure")
    if value in {"area", "volume", "measure"} and measurement is not None:
        return _number(measurement, value)
    intensity = row.get("intensity", {})
    if isinstance(intensity, Mapping) and "." in value:
        channel, statistic = value.split(".", 1)
        channel_data = intensity.get(channel)
        if isinstance(channel_data, Mapping) and statistic in channel_data:
            return _number(channel_data[statistic], value)
    raise ValueError(f"Object row has no numeric measurement {value!r}")


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _sd(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / (len(values) - 1))


def summarize_measurements(
    records: Iterable[Mapping[str, Any]], *, value: str = "measure"
) -> dict[str, Any]:
    """Summarize records, with condition statistics based only on replicates.

    A record is one image/result and must contain ``metadata`` and ``objects``.
    Excluded records are omitted from estimates but their exact revision and
    review state are retained in ``record_audit``.
    """
    all_records = _records(records)
    active = [record for record in all_records if not record.get("excluded", False)]
    if any(not isinstance(record.get("excluded", False), bool) for record in all_records):
        raise ValueError("excluded must be boolean")
    units: set[Any] = set()
    methods: set[Any] = set()
    scopes: set[Any] = set()
    studies: set[str] = set()
    for record in active:
        studies.add(validate_sample_metadata(record["metadata"]).study)
        for row in record["objects"]:
            if "measure_unit" in row:
                units.add(row["measure_unit"])
        if "method" in record:
            methods.add(record["method"])
        if "run_scope" in record:
            scopes.add(record["run_scope"])
    if len(units) > 1:
        raise ValueError("Incompatible measurement units cannot be pooled")
    if len(methods) > 1:
        raise ValueError("Incompatible methods cannot be pooled")
    if len(scopes) > 1:
        raise ValueError("Incompatible run scopes cannot be pooled")
    if len(studies) > 1:
        raise ValueError("Different studies cannot be pooled into one replicate summary")
    unit = next(iter(units), None)
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    # Reduce each image to its object mean, retaining object n separately.
    for record in active:
        metadata = validate_sample_metadata(record["metadata"])
        key = (
            metadata.condition,
            metadata.study,
            metadata.biological_replicate or "__unassigned__",
        )
        entry = groups.setdefault(
            key,
            {
                "condition": metadata.condition,
                "biological_replicate": metadata.biological_replicate,
                "images": [],
            },
        )
        values = [_row_value(row, value) for row in record["objects"]]
        entry["images"].append(
            {
                "mean": _mean(values),
                "n_objects": len(values),
                "revision": record.get("revision_hash", record.get("revision")),
                "source_id": record.get("source_id"),
                "result_id": record.get("result_id"),
            }
        )
    replicate_rows: list[dict[str, Any]] = []
    for entry in groups.values():
        images = entry["images"]
        image_means = [image["mean"] for image in images if image["mean"] is not None]
        replicate_rows.append(
            {
                "condition": entry["condition"],
                "biological_replicate": None
                if entry["biological_replicate"] == "__unassigned__"
                else entry["biological_replicate"],
                "mean": _mean(image_means),
                "n_images": len(images),
                "n_objects": sum(image["n_objects"] for image in images),
                "image_means": image_means,
            }
        )
    conditions: dict[str, dict[str, Any]] = {}
    for row in replicate_rows:
        condition = row["condition"]
        out = conditions.setdefault(
            condition,
            {
                "condition": condition,
                "replicate_means": [],
                "unassigned_images": 0,
                "unassigned_objects": 0,
            },
        )
        if row["biological_replicate"] is None:
            out["unassigned_images"] += row["n_images"]
            out["unassigned_objects"] += row["n_objects"]
        elif row["mean"] is not None:
            out["replicate_means"].append(row["mean"])
    summaries = []
    for condition, out in conditions.items():
        values = out["replicate_means"]
        summaries.append(
            {
                "condition": condition,
                "mean": _mean(values),
                "sd": _sd(values),
                "n_biological_replicates": len(values),
                "n_objects": sum(
                    r["n_objects"] for r in replicate_rows if r["condition"] == condition
                ),
                "n_images": sum(
                    r["n_images"] for r in replicate_rows if r["condition"] == condition
                ),
                "unassigned_images": out["unassigned_images"],
                "unassigned_objects": out["unassigned_objects"],
            }
        )
    audit = [
        {
            key: record.get(key)
            for key in (
                "source_id",
                "result_id",
                "revision",
                "revision_hash",
                "excluded",
                "reviewed",
                "review",
            )
            if key not in {"revision_hash", "review"} or key in record
        }
        for record in all_records
    ]
    return {
        "value": value,
        "unit": unit,
        "summaries": summaries,
        "replicates": replicate_rows,
        "record_audit": audit,
        "method": next(iter(methods), None),
        "run_scope": next(iter(scopes), None),
        "independent_n_basis": "biological replicate means; objects and images are correlated",
    }


def compare_runs(
    left: Iterable[Mapping[str, Any]], right: Iterable[Mapping[str, Any]], *, value: str = "measure"
) -> dict[str, Any]:
    """Descriptively compare two compatible runs; no hypothesis p-values."""
    a, b = summarize_measurements(left, value=value), summarize_measurements(right, value=value)
    if (
        a["unit"] != b["unit"]
        or a["value"] != b["value"]
        or a["method"] != b["method"]
        or a["run_scope"] != b["run_scope"]
    ):
        raise ValueError("Runs have incompatible measurement units, methods, or scopes")
    amap = {row["condition"]: row for row in a["summaries"]}
    bmap = {row["condition"]: row for row in b["summaries"]}
    comparison = []
    for condition in sorted(set(amap) | set(bmap)):
        av, bv = amap.get(condition, {}).get("mean"), bmap.get(condition, {}).get("mean")
        comparison.append(
            {
                "condition": condition,
                "left_mean": av,
                "right_mean": bv,
                "difference": None if av is None or bv is None else bv - av,
                "left_n_biological_replicates": amap.get(condition, {}).get(
                    "n_biological_replicates", 0
                ),
                "right_n_biological_replicates": bmap.get(condition, {}).get(
                    "n_biological_replicates", 0
                ),
            }
        )
    return {
        "value": value,
        "unit": a["unit"],
        "comparisons": comparison,
        "p_values": None,
        "interpretation": "descriptive run comparison; no hypothesis tests on correlated objects",
    }


def executed_methods_record(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Create a methods receipt containing only supplied executed fields."""
    output = []
    for record in records:
        if not isinstance(record, Mapping):
            raise ValueError("Executed records must be mappings")
        fields = {
            key: record[key]
            for key in (
                "op",
                "threshold",
                "thresholds",
                "sigma",
                "geometry",
                "model_id",
                "runtime_id",
            )
            if key in record
        }
        if not fields:
            raise ValueError("Executed record contains no supported method fields")
        output.append(fields)
    return {"executed_records": output}


def methods_citation_text(receipt: Mapping[str, Any]) -> str:
    lines = []
    for record in receipt.get("executed_records", []):
        parts = [
            f"{key}={record[key]}"
            for key in (
                "op",
                "threshold",
                "thresholds",
                "sigma",
                "geometry",
                "model_id",
                "runtime_id",
            )
            if key in record
        ]
        lines.append("Executed analysis: " + "; ".join(parts) + ".")
    return "\n".join(lines)


def measurements_csv(rows: Iterable[Mapping[str, Any]]) -> str:
    """Formula-safe CSV with stable columns and RFC-compliant quoting."""
    rows = [dict(row) for row in rows]
    columns = sorted({key for row in rows for key in row})
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(
        [
            "'" + column if column.lstrip(" \t\r\n")[:1] in {"=", "+", "-", "@"} else column
            for column in columns
        ]
    )
    for row in rows:
        values = []
        for column in columns:
            raw = row.get(column)
            value = "" if raw is None else str(raw)
            # Escape only text: negative numeric measurements must remain numeric
            # when a spreadsheet imports the CSV.
            if isinstance(raw, str) and value.lstrip(" \t\r\n")[:1] in {"=", "+", "-", "@"}:
                value = "'" + value
            values.append(value)
        writer.writerow(values)
    return stream.getvalue()


# Short aliases for callers that prefer verb-oriented names.
generate_measurements_csv = measurements_csv
build_methods_record = executed_methods_record
