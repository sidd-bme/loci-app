"""Bounded, crop-local classical exploration over the existing recipe engine.

Preview has no saved workflow or result. A comparison saves only a compact,
path-free receipt; adoption explicitly replays one exact preview as a normal
result. These receipts describe computational reproducibility, not accuracy.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import sys
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import uuid4

from .quantitative import exact_keys, finite_number, integer
from .research_project import SHA_PATTERN, canonical_json, checked_id, parse_json

MAX_EDGE = 512
MAX_REGIONS = 3
MAX_CONFIGURATIONS = 3
WORKING_BYTES = 64 * 1024 * 1024
SELECTION_KEYS = {"x", "y", "width", "height", "c", "z", "t", "level"}
BOUNDARY_POLICY = {
    "execution": "crop-local",
    "halo_pixels": 0,
    "border_objects": "retained-with-clipped-measurements",
    "full_image_equivalence": False,
    "scientific_validation": "unvalidated-research-method",
}
PREVIEW_KEYS = {
    "schema",
    "source_id",
    "source_sha256",
    "selection",
    "effective_recipe",
    "recipe_sha256",
    "min_size_unit",
    "geometry",
    "runtime",
    "software_identity",
    "boundary_policy",
    "content_hashes",
    "object_count",
    "size_summary",
    "receipt_sha256",
}
COMPARISON_KEYS = {
    "schema",
    "source_id",
    "source_sha256",
    "regions",
    "configurations",
    "cells",
    "boundary_policy",
    "receipt_sha256",
}
CONTENT_KEYS = {
    "image_array_sha256",
    "labels_array_sha256",
    "measurements_sha256",
    "image_png_sha256",
    "label_image_png_sha256",
}


@lru_cache(maxsize=1)
def _software_identity() -> dict[str, str]:
    """Path-free exact numerical implementation identity; dependencies are in runtime."""
    if getattr(sys, "frozen", False):
        from .working_result import _sha256_file_stable

        digest, _ = _sha256_file_stable(Path(sys.executable), reject_symlink=True)
        return {"kind": "frozen-executable-sha256", "sha256": digest}
    digest = hashlib.sha256()
    for name in ("research_exploration.py", "workbench.py", "quantitative.py"):
        module = Path(__file__).with_name(name)
        if module.stat().st_size > 1024 * 1024:
            raise ValueError("Exploration source identity exceeds the module bound")
        digest.update(name.encode() + b"\0" + module.read_bytes() + b"\0")
    return {"kind": "source-modules-sha256", "sha256": digest.hexdigest()}


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _sha(value: Any) -> str:
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Exploration requires an exact lowercase SHA-256")
    return value


def _complete(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"Complete explicit {name} fields are required")
    return value


def _selection(value: Any) -> dict[str, int]:
    _complete(value, SELECTION_KEYS, "exploration selection")
    return {
        key: integer(
            value[key],
            key,
            1 if key in {"width", "height"} else 0,
            MAX_EDGE if key in {"width", "height"} else 2**31 - 1,
        )
        for key in SELECTION_KEYS
    }


def _configuration(value: Any) -> dict[str, float]:
    exact_keys(value, {"threshold", "min_size"}, "exploration configuration")
    return {
        "threshold": finite_number(value.get("threshold"), "threshold", -1e30, 1e30),
        "min_size": finite_number(value.get("min_size", 0), "min_size", 0, 1e20),
    }


def _recipe(selection: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    return {
        "steps": [],
        "segmentation": {
            "method": "components",
            "threshold": config["threshold"],
            "min_size": config["min_size"],
            "polarity": "bright",
            "exclude_border": False,
        },
        "measurement_channels": [selection["c"]],
        "gates": [],
        "working_bytes": WORKING_BYTES,
    }


def _sealed(record: dict[str, Any]) -> dict[str, Any]:
    # Receipts cross JSON IPC and study boundaries; tuples must resolve to the
    # same wire representation before comparison or explicit adoption replay.
    return json.loads(canonical_json({**record, "receipt_sha256": _hash(record)}))


def _verify_seal(record: dict[str, Any]) -> None:
    digest = _sha(record.get("receipt_sha256"))
    if _hash({key: value for key, value in record.items() if key != "receipt_sha256"}) != digest:
        raise ValueError("Exploration receipt content hash mismatch")


def validate_exploration_receipt(receipt: Any) -> dict[str, Any]:
    """Validate an inspectable preview binding without reading a source file."""
    from .workbench import geometry_from_dict

    _complete(receipt, PREVIEW_KEYS, "exploration preview receipt")
    if receipt["schema"] != "loci.exploration-preview/v1":
        raise ValueError("Unsupported exploration preview schema")
    checked_id(receipt["source_id"])
    _sha(receipt["source_sha256"])
    selection = _selection(receipt["selection"])
    recipe = receipt["effective_recipe"]
    if not isinstance(recipe, dict) or not isinstance(recipe.get("segmentation"), dict):
        raise ValueError("Exploration requires a complete classical recipe")
    config = _configuration(
        {key: recipe["segmentation"].get(key) for key in ("threshold", "min_size")}
    )
    if recipe != _recipe(selection, config) or receipt["recipe_sha256"] != _hash(recipe):
        raise ValueError("Exploration recipe identity is invalid")
    geometry = geometry_from_dict(receipt["geometry"])
    if (
        geometry.axes != "YX"
        or receipt["boundary_policy"] != BOUNDARY_POLICY
        or receipt["min_size_unit"] != f"{geometry.unit}^2"
    ):
        raise ValueError("Exploration requires the declared crop-local single-plane context")
    runtime_keys = {
        "engine",
        "numpy",
        "scipy",
        "scikit_image",
        "requested_device",
        "resolved_device",
        "backend",
        "fallback_reason",
        "scientific_validation",
    }
    runtime = _complete(receipt["runtime"], runtime_keys, "exploration runtime")
    if (
        any(
            not isinstance(runtime[key], str) or not 1 <= len(runtime[key]) <= 128
            for key in ("engine", "numpy", "scipy", "scikit_image")
        )
        or runtime["requested_device"] != "auto"
        or runtime["resolved_device"] != "cpu"
        or runtime["backend"] != "numpy-scipy-cpu"
        or runtime["fallback_reason"] is not None
        or runtime["scientific_validation"] != "unvalidated-research-method"
    ):
        raise ValueError("Exploration runtime identity is invalid")
    software = _complete(
        receipt["software_identity"], {"kind", "sha256"}, "exploration software identity"
    )
    if software["kind"] not in {"source-modules-sha256", "frozen-executable-sha256"}:
        raise ValueError("Unsupported exploration software identity")
    _sha(software["sha256"])
    _complete(receipt["content_hashes"], CONTENT_KEYS, "exploration content hashes")
    for value in receipt["content_hashes"].values():
        _sha(value)
    count = integer(receipt["object_count"], "object count", 0, MAX_EDGE**2)
    summary = _complete(
        receipt["size_summary"],
        {
            "count",
            "measure_kind",
            "measure_unit",
            "total",
            "mean",
            "median",
            "min",
            "max",
            "border_object_count",
        },
        "exploration size summary",
    )
    if (
        summary["count"] != count
        or summary["measure_kind"] != "area"
        or summary["measure_unit"] != f"{geometry.unit}^2"
    ):
        raise ValueError("Exploration size summary units or count disagree")
    integer(summary["border_object_count"], "border object count", 0, count)
    total = finite_number(summary["total"], "total size", 0, 1e300)
    if count == 0:
        if total != 0 or any(summary[key] is not None for key in ("mean", "median", "min", "max")):
            raise ValueError("Empty exploration summaries must retain undefined size statistics")
    else:
        for key in ("mean", "median", "min", "max"):
            finite_number(summary[key], f"{key} size", 0, 1e300)
        if not 0 < summary["min"] <= summary["median"] <= summary["max"] <= total:
            raise ValueError("Exploration size summary range is invalid")
        min_size = summary["min"]
        max_size = summary["max"]
        mean_size = summary["mean"]
        # Allow float64 reduction rounding without a unit-dependent absolute floor.
        # Small physical areas must still reject zero or materially different means.
        if not (
            (
                min_size <= mean_size
                or math.isclose(mean_size, min_size, rel_tol=1e-12, abs_tol=0.0)
            )
            and (
                mean_size <= max_size
                or math.isclose(mean_size, max_size, rel_tol=1e-12, abs_tol=0.0)
            )
        ):
            raise ValueError("Exploration mean size is outside its range")
    _verify_seal(receipt)
    return receipt


def validate_exploration_document(document, sources, results, documents=()):
    """Validate compact comparison receipts for portable-study interchange."""
    checked_id(document.get("id"))
    integer(document.get("revision"), "exploration document revision", 1, 2**31 - 1)
    if document.get("kind") != "exploration":
        raise ValueError("Unsupported exploration document kind")
    data = _complete(document.get("data"), COMPARISON_KEYS, "exploration comparison")
    if data["schema"] != "loci.exploration-comparison/v1":
        raise ValueError("Unsupported exploration comparison schema")
    source_map = sources if isinstance(sources, dict) else {item["id"]: item for item in sources}
    source = source_map.get(checked_id(data["source_id"]))
    if source is None or source["sha256"] != _sha(data["source_sha256"]):
        raise ValueError("Exploration comparison source binding is invalid")
    regions, configurations = _matrix(data["regions"], data["configurations"])
    if regions != data["regions"] or configurations != data["configurations"]:
        raise ValueError("Exploration comparison settings are not normalized")
    if data["boundary_policy"] != BOUNDARY_POLICY:
        raise ValueError("Exploration comparison boundary policy is invalid")
    cells = data["cells"]
    if not isinstance(cells, list) or len(cells) != len(regions) * len(configurations):
        raise ValueError("Exploration comparison matrix is incomplete")
    for index, cell in enumerate(cells):
        _complete(cell, {"region_index", "configuration_index", "receipt"}, "exploration cell")
        region_index, config_index = divmod(index, len(configurations))
        if (cell["region_index"], cell["configuration_index"]) != (region_index, config_index):
            raise ValueError("Exploration comparison cell indices disagree")
        receipt = validate_exploration_receipt(cell["receipt"])
        if (
            receipt["source_id"] != source["id"]
            or receipt["source_sha256"] != source["sha256"]
            or receipt["selection"] != regions[region_index]
            or receipt["effective_recipe"]
            != _recipe(regions[region_index], configurations[config_index])
        ):
            raise ValueError("Exploration comparison cell binding disagrees")
    _verify_seal(data)


def _matrix(regions: Any, configurations: Any) -> tuple[list, list]:
    if not isinstance(regions, list) or not 1 <= len(regions) <= MAX_REGIONS:
        raise ValueError("Exploration comparison requires 1-3 explicit regions")
    if not isinstance(configurations, list) or not 1 <= len(configurations) <= MAX_CONFIGURATIONS:
        raise ValueError("Exploration comparison requires 1-3 explicit configurations")
    regions = [_selection(value) for value in regions]
    configurations = [_configuration(value) for value in configurations]
    plane = {key: regions[0][key] for key in ("c", "z", "t", "level")}
    if any(any(region[key] != value for key, value in plane.items()) for region in regions):
        raise ValueError("Comparison regions must share one explicit C/Z/T plane and pyramid level")
    for values in (regions, configurations):
        if len({_hash(value) for value in values}) != len(values):
            raise ValueError("Exploration comparison selections and configurations must be unique")
    return regions, configurations


def _check(workbench, source_id: str, sha256: str, publication_guard=None) -> None:
    if publication_guard is not None:
        publication_guard()
    source = workbench.project.source(source_id)
    if source.get("source_kind") != "native":
        raise ValueError(
            "Guided exploration currently requires an imported local native scalar image"
        )
    if source["sha256"] != sha256:
        raise ValueError("Exploration source SHA-256 does not match the imported source")
    session = workbench._session(source_id)
    if session.metadata.dimensions.s != 1:
        raise ValueError("RGB samples are not a scalar biological channel")
    if session.verify_strict().sha256 != sha256:
        raise ValueError("Exploration source changed")


def _preview(workbench, source_id, sha256, selection, configuration, publication_guard=None):
    _check(workbench, source_id, sha256, publication_guard)
    selection = _selection(selection)
    # Validation rejects out-of-image selections; it must never clamp or substitute one.
    validated = workbench.validate_recipe(
        {
            "source_id": source_id,
            "selection": selection,
            "recipe": _recipe(selection, configuration),
        }
    )
    if validated["selection"] != selection:
        raise ValueError("Exploration selection changed during validation")
    response = workbench.run_recipe(
        {
            "source_id": source_id,
            "selection": selection,
            "recipe": validated["recipe"],
        },
        preview=True,
        exploration_details=True,
    )
    _check(workbench, source_id, sha256, publication_guard)
    hashes = {
        **response["content_hashes"],
        **{
            f"{key}_png_sha256": hashlib.sha256(
                base64.b64decode(response[key].split(",", 1)[1], validate=True)
            ).hexdigest()
            for key in ("image", "label_image")
        },
    }
    provenance = response["provenance"]
    receipt = _sealed(
        {
            "schema": "loci.exploration-preview/v1",
            "source_id": source_id,
            "source_sha256": sha256,
            "selection": selection,
            "effective_recipe": provenance["recipe"],
            "recipe_sha256": provenance["recipe_sha256"],
            "min_size_unit": f"{provenance['geometry']['unit']}^2",
            "geometry": provenance["geometry"],
            "runtime": provenance["runtime"],
            "software_identity": _software_identity(),
            "boundary_policy": dict(BOUNDARY_POLICY),
            "content_hashes": hashes,
            "object_count": response["object_count"],
            "size_summary": response["size_summary"],
        }
    )
    validate_exploration_receipt(receipt)
    return {
        "preview": True,
        "adopted": False,
        "image": response["image"],
        "label_image": response["label_image"],
        "object_count": response["object_count"],
        "size_summary": response["size_summary"],
        "receipt": receipt,
        "receipt_json": canonical_json(receipt),
    }


def adoption_receipt(request: Any) -> dict[str, Any]:
    """The GUI forwards the server's exact JSON string, preserving float spellings."""
    exact_keys(request, {"receipt", "receipt_json"}, "exploration adoption")
    if set(request) == {"receipt_json"}:
        encoded = request["receipt_json"]
        if not isinstance(encoded, str):
            raise ValueError("An exact exploration receipt JSON string is required")
        receipt = parse_json(encoded)
        if canonical_json(receipt) != encoded:
            raise ValueError("Exploration receipt JSON must retain its exact canonical encoding")
    elif set(request) == {"receipt"}:
        receipt = request["receipt"]
    else:
        raise ValueError("Choose one exact exploration receipt representation")
    return validate_exploration_receipt(receipt)


def dispatch_exploration(
    workbench,
    operation: str,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Dispatch bounded preview, durable comparison, or explicit exact adoption."""
    if operation in {"exploration_list", "exploration_get"}:
        exact_keys(
            request,
            {"source_id", "source_sha256", "comparison_id"}
            if operation == "exploration_get"
            else {"source_id", "source_sha256"},
            operation,
        )
        source = workbench.project.source(checked_id(request.get("source_id")))
        if source["sha256"] != _sha(request.get("source_sha256")):
            raise ValueError("Saved comparison source identity disagrees")
        documents = workbench.project.documents("exploration")
        records = []
        for document in documents:
            if document["data"].get("source_id") != source["id"]:
                continue
            validate_exploration_document(document, {source["id"]: source}, {})
            records.append(document)
        if operation == "exploration_get":
            comparison_id = checked_id(request.get("comparison_id"))
            record = next((item for item in records if item["id"] == comparison_id), None)
            if record is None:
                raise ValueError("Saved comparison is absent from this source")
            return {"comparison": record, "comparison_json": canonical_json(record)}
        return {
            "comparisons": [
                {
                    "id": item["id"],
                    "updated_at": item["updated_at"],
                    "region_count": len(item["data"]["regions"]),
                    "configuration_count": len(item["data"]["configurations"]),
                    "receipt_sha256": item["data"]["receipt_sha256"],
                }
                for item in records[-16:]
            ]
        }
    if job_id is not None:
        checked_id(job_id)
        external_guard = publication_guard

        def job_guard():
            if external_guard is not None:
                external_guard()
            job = workbench.project.job(job_id)
            if (
                job["state"] != "running"
                or job["cancel_requested"]
                or job["operation"] != operation
                or canonical_json(job["request"].get("task_request")) != canonical_json(request)
            ):
                raise ValueError(
                    "Exploration job was cancelled, stopped or changed before publication"
                )

        publication_guard = job_guard
    if operation == "exploration_run":
        receipt = adoption_receipt(request)
        config = _configuration(
            {
                key: receipt["effective_recipe"]["segmentation"][key]
                for key in ("threshold", "min_size")
            }
        )
        source_id, sha256 = receipt["source_id"], receipt["source_sha256"]
        replay = _preview(
            workbench, source_id, sha256, receipt["selection"], config, publication_guard
        )
        if replay["receipt"] != receipt:
            raise ValueError(
                "Exploration preview changed; create and inspect a new preview before adoption"
            )

        def guard():
            _check(workbench, source_id, sha256, publication_guard)

        guard()
        result = workbench.run_recipe(
            {
                "source_id": source_id,
                "selection": receipt["selection"],
                "recipe": receipt["effective_recipe"],
            },
            job_id=job_id,
            publication_guard=guard,
            exploration_context=receipt,
        )
        return {**result, "receipt": receipt}
    if operation not in {"exploration_preview", "exploration_compare"}:
        raise ValueError("Unsupported exploration operation")
    keys = {"source_id", "source_sha256"}
    keys |= (
        {"regions", "configurations"}
        if operation == "exploration_compare"
        else {
            "selection",
            "threshold",
            "min_size",
        }
    )
    exact_keys(request, keys, "exploration request")
    source_id, sha256 = checked_id(request.get("source_id")), _sha(request.get("source_sha256"))
    if operation == "exploration_preview":
        config = _configuration(
            {key: request[key] for key in ("threshold", "min_size") if key in request}
        )
        return _preview(
            workbench, source_id, sha256, request.get("selection"), config, publication_guard
        )
    regions, configurations = _matrix(request.get("regions"), request.get("configurations"))
    # Validate the entire matrix before executing the first cell.
    _check(workbench, source_id, sha256, publication_guard)
    for selection in regions:
        workbench.validate_recipe(
            {
                "source_id": source_id,
                "selection": selection,
                "recipe": _recipe(selection, configurations[0]),
            }
        )
    cells = []
    compact = []
    for region_index, selection in enumerate(regions):
        for configuration_index, config in enumerate(configurations):
            cell = _preview(workbench, source_id, sha256, selection, config, publication_guard)
            index = {"region_index": region_index, "configuration_index": configuration_index}
            cells.append({**index, **cell})
            compact.append({**index, "receipt": cell["receipt"]})
    receipt = _sealed(
        {
            "schema": "loci.exploration-comparison/v1",
            "source_id": source_id,
            "source_sha256": sha256,
            "regions": regions,
            "configurations": configurations,
            "cells": compact,
            "boundary_policy": dict(BOUNDARY_POLICY),
        }
    )

    def guard():
        _check(workbench, source_id, sha256, publication_guard)

    guard()
    comparison = workbench.project.put_document(
        "exploration",
        uuid4().hex,
        receipt,
        expected_revision=0,
        publication_guard=guard,
    )
    return {
        "preview": True,
        "adopted": False,
        "cells": cells,
        "receipt": receipt,
        "receipt_json": canonical_json(receipt),
        "comparison": comparison,
    }
