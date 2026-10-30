"""Trusted, revision-bound UTF-8 scientific data packages; no image payloads.

The opaque canonical plan is an optimistic snapshot, not a permission. Only a
native/manual destination grant authorizes publication. MCP is deliberately absent.
"""

from __future__ import annotations

import errno
import hashlib
import math
import os
import platform
import re
import shutil
import stat
import sys
import uuid
from contextlib import contextmanager, suppress
from functools import lru_cache
from pathlib import Path

from .export import _NATIVE_RENAME, _rename_noreplace
from .models import ENGINE_VERSION
from .research_project import SHA_PATTERN, canonical_json, checked_id, parse_json, timestamp
from .research_result_context import _PROCESSING, _RUNTIME, _SEGMENTATION, _SETTINGS
from .working_result import _sha256_file_stable

PLAN_SCHEMA = "loci.data-export-plan/v1"
PACKAGE_SCHEMA = "loci.scientific-data-package/v1"
MAX_PLAN_BYTES = 2 * 1024**2
MAX_PACKAGE_BYTES = 8 * 1024**3
MAX_FILES = 32
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_FILE_FLAGS = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
_BINDINGS = {"source_id", "source_sha256", "result_id", "revision_hash", "group_ids", "subset"}
_SAFE_FILENAME = re.compile(r"[a-z][a-z0-9-]*\.(?:csv|json|jsonl|md)\Z")
# Scientific fields only. Free-form notes, profiles, paths, imported metadata,
# accepted requests and unknown extensions are intentionally absent.
_SCIENTIFIC_KEYS = frozenset(
    [
        "bytes",
        "tiles",
        "artifact",
        "schema",
        "dimensions",
        "axes",
        "affine",
        "unit",
        "frame",
        "selection",
        "x",
        "y",
        "width",
        "height",
        "t",
        "c",
        "z",
        "z_stop",
        "level",
        "elapsed_time_s",
        "geometry",
        "spacing",
        "physical_calibration",
        "measurement_basis",
        "recipe",
        "recipe_sha256",
        "processing",
        "segmentation",
        "method",
        "threshold",
        "polarity",
        "min_size",
        "max_size",
        "connectivity",
        "sigma",
        "radius",
        "size",
        "iterations",
        "operation",
        "op",
        "scale",
        "offset",
        "channel",
        "channels",
        "measurement_channels",
        "index",
        "name",
        "role",
        "declared",
        "name_source",
        "basis",
        "raw_channel_index",
        "channel_index",
        "index_axes",
        "compartment_measurement",
        "label_inputs",
        "parent_result",
        "result_id",
        "revision_hash",
        "source_id",
        "source_sha256",
        "labels_sha256",
        "input_sha256",
        "output_sha256",
        "input_labels_sha256",
        "output_labels_sha256",
        "changed_voxels",
        "correction",
        "operations",
        "model",
        "runtime",
        "id",
        "version",
        "task",
        "model_sha256",
        "metadata_sha256",
        "package_sha256",
        "artifact_id",
        "sha256",
        "engine",
        "numpy",
        "scipy",
        "scikit_image",
        "python",
        "torch",
        "cellpose",
        "onnxruntime",
        "backend",
        "requested_device",
        "resolved_device",
        "scientific_validation",
        "precision",
        "dtype",
        "shape",
        "interpolation",
        "output_grid",
        "transform",
        "matrix",
        "source_scale",
        "registration_quality",
        "quality",
        "normalization",
        "normalized",
        "resolved_settings",
        "preprocessing",
        "postprocessing",
        "weights",
        "weights_sha256",
        "package",
        "name",
        "version",
        "opset_version",
        "label_count",
        "object_count",
        "input_count",
        "output_count",
        "measure_kind",
        "measure_unit",
        "distance_unit",
        "nucleus_id",
        "cell_id",
        "compartment",
        "identity",
        "kind",
        "channel_mapping",
        "channel_metadata",
        "engine_version",
        "label_sha256",
        "seed",
        "deterministic",
        "execution_policy",
        "tile_size",
        "halo",
    ]
)
_SCIENTIFIC_KEYS |= frozenset(_PROCESSING + _RUNTIME + _SEGMENTATION + _SETTINGS)
_SCIENTIFIC_KEYS |= {
    "settings",
    "nuclei",
    "cells",
    "partition",
    "cell",
    "nuclear",
    "cytoplasm",
    "schema_version",
    "association_independent",
    "conservation",
    "relative_tolerance",
    "sum_absolute_tolerance",
    "model_input_index",
    "model_channel",
    "source_channel",
    # Normalized correction audit fields contain scientific IDs and geometry.
    "parent_id",
    "parent_revision_hash",
    "working_memory_limit_bytes",
    "array_axes",
    "geometry_sha256",
    "coordinate_convention",
    "operation_count",
    "input_mutation",
    "label",
    "source_labels",
    "target_label",
    "mode",
    "plane",
    "plane_axes_uv",
    "points_uv",
    "radius_unit",
    "seeds",
    "allocated_labels",
    "u",
    "v",
    "x",
    "y",
    "source_vertices_uv",
    "vertices_uv",
    "moved_vertex_index",
    "source_vertex_uv",
    "destination_vertex_uv",
    "source_vertex_world_xyz",
    "destination_vertex_world_xyz",
    "world_frame",
    "local_delta_voxels",
    "tissue_mask_status",
    "puncta_peak_status",
}


# Method-local typed projections. In particular, control/notes and unknown trees
# never become exportable just because a scientific-looking key occurs inside.
_METHOD_SETTINGS = {
    "tissue_mask": {
        "threshold_method": {"otsu-dark-luminance"},
        "threshold": (float, 0, 1),
        "closing_radius_pixels": (int, 0, 64),
        "minimum_component_pixels": (int, 0, 10_000_000),
        "connectivity": {"face-connected-2D"},
        "input": {"source-device-RGB; display ICC transform excluded"},
        "luminance_formula": {
            "skimage.color.rgb2gray source RGB / 255; weighted sum 0.2125R + 0.7154G + 0.0721B"
        },
        "scientific_validation": {"unvalidated-research-method"},
        "initial_mask_pixel_count": (int, 0, 2**53 - 1),
        "initial_mask_fraction": (float, 0, 1),
        "scope": {"selected bounded native region only"},
    },
    "stain_separation": {
        "declared_basis": {"H&E", "H-DAB"},
        "component": {"hematoxylin-basis", "eosin-basis", "DAB-basis"},
        "matrix": "matrix3",
        "method": {"skimage.color.separate_stains"},
        "input": {"source-device-RGB; display ICC transform excluded"},
    },
    "input_transform": {
        "method": {"skimage.color.rgb2gray"},
        "version": "version",
        "input": {"source-device RGB samples; display ICC excluded"},
        "coefficients_rgb": ("vector3", 0, 1),
        "integer_scale": (int, 1, 65535),
        "gamma_linearization": bool,
        "alpha": {"opaque only"},
        "meaning": {"derived weighted encoded RGB intensity; not biological channel intensity"},
    },
    "puncta": {
        "sigma": (float, 1e-9, 1e6),
        "response_threshold": (float, 0, 1e30),
        "raw_threshold": (float, -1e30, 1e30),
        "minimum_distance": (float, 0, 1e6),
        "aperture_radius": (float, 1e-9, 1e6),
        "exclude_border": bool,
        "sigma_voxels_array_axes": ("vector23", 0.5, 256),
        "spacing_array_axes": ("vector23", 0, 1e30),
        "array_axes": {"YX", "ZYX"},
    },
}


def _method_settings(name, value):
    if name == "input_transform" and value == "rgb_intensity":
        return value  # The normalized recipe names the transform; provenance records it.
    if not isinstance(value, dict):
        raise ValueError("Invalid scientific method setting structure")

    def number(item, minimum, maximum, integer=False):
        return (
            type(item) in ((int,) if integer else (int, float))
            and minimum <= item <= maximum
            and math.isfinite(item)
        )

    projected = {}
    for key, spec in _METHOD_SETTINGS[name].items():
        if key not in value:
            continue
        item = value[key]
        if isinstance(spec, set):
            valid = type(item) is str and item in spec
        elif spec is bool:
            valid = type(item) is bool
        elif spec == "version":
            valid = type(item) is str and re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,63}", item)
        elif spec == "matrix3":
            valid = (
                type(item) is list
                and len(item) == 3
                and all(
                    type(row) is list and len(row) == 3 and all(number(x, -1e6, 1e6) for x in row)
                    for row in item
                )
            )
        elif spec[0] in ("vector3", "vector23"):
            valid = (
                type(item) is list
                and len(item) in ((3,) if spec[0] == "vector3" else (2, 3))
                and all(number(x, spec[1], spec[2]) for x in item)
            )
        else:
            valid = number(item, spec[1], spec[2], integer=spec[0] is int)
        if not valid:
            raise ValueError(f"Invalid scientific method setting: {name}.{key}")
        projected[key] = item
    return projected


def _check(check):
    if check is not None:
        check()


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} requires exactly its declared fields")


def _safe(value, depth=0):
    """Project whitelisted scientific structures; never export arbitrary text trees."""
    if depth > 16:
        raise ValueError("Scientific provenance exceeds its nesting bound")
    if value is None or type(value) in (bool, int):
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("Scientific provenance contains non-finite data")
        return value
    if isinstance(value, str):
        if (
            len(value.encode()) > 512
            or "/" in value
            or "\\" in value
            or any(ord(c) < 32 for c in value)
        ):
            return None
        return value
    if isinstance(value, list):
        if len(value) > 1024:
            raise ValueError("Scientific provenance list exceeds its bound")
        return [_safe(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {
            key: _method_settings(key, item) if key in _METHOD_SETTINGS else _safe(item, depth + 1)
            for key, item in value.items()
            if key in _SCIENTIFIC_KEYS or key in _METHOD_SETTINGS
        }
    raise ValueError("Scientific provenance has an unsupported value")


@lru_cache(maxsize=1)
def _implementation():
    if getattr(sys, "frozen", False):
        digest, _ = _sha256_file_stable(Path(sys.executable), reject_symlink=True)
        return "frozen-executable-sha256", digest
    modules = {}
    for name in (
        "research_data_export.py",
        "research_data_tables.py",
        "scientific_export_readers.py",
    ):
        digest, _ = _sha256_file_stable(Path(__file__).with_name(name), reject_symlink=True)
        modules[name] = digest
    return "source-modules-sha256", _hash(modules)


def _export_software():
    kind, digest = _implementation()
    return {
        "kind": kind,
        "sha256": digest,
        "engine_version": ENGINE_VERSION,
        "python_version": platform.python_version(),
    }


def _request(value):
    _exact(value, {"purpose", "bindings"}, "Data export request")
    if value["purpose"] not in {"reviewed", "provisional"}:
        raise ValueError("Choose reviewed or provisional data export")
    bindings = value["bindings"]
    if not isinstance(bindings, list) or not 1 <= len(bindings) <= 100:
        raise ValueError("Choose 1-100 exact result revisions")
    seen = set()
    for binding in bindings:
        _exact(binding, _BINDINGS, "Data export binding")
        for key in ("source_id", "result_id"):
            checked_id(binding[key])
        for key in ("source_sha256", "revision_hash"):
            if not isinstance(binding[key], str) or not SHA_PATTERN.fullmatch(binding[key]):
                raise ValueError("Data export requires exact SHA-256 identities")
        if binding["result_id"] in seen:
            raise ValueError("Choose each exact result once")
        seen.add(binding["result_id"])
        groups = binding["group_ids"]
        if not isinstance(groups, list) or len(groups) > 256:
            raise ValueError("Choose at most 256 population groups")
        for group in groups:
            checked_id(group)
        if len(set(groups)) != len(groups):
            raise ValueError("Choose each population group once")
        if binding["subset"] not in {"all", "groups"} or (
            binding["subset"] == "groups" and not groups
        ):
            raise ValueError("Group subsets require at least one exact group")
    return parse_json(canonical_json(value))


def _artifacts(project, result, check):
    """Verify encoded content identities without loading or decoding image arrays."""
    project._check_layout()
    for descriptor in result["arrays"].values():
        descriptors = (
            [tile["artifact"] for tile in descriptor["tiles"]]
            if "tiles" in descriptor
            else [descriptor]
        )
        for artifact in descriptors:
            _check(check)
            digest = artifact.get("sha256")
            if not isinstance(digest, str) or not SHA_PATTERN.fullmatch(digest):
                raise ValueError("Invalid scientific artifact identity")
            if _sha256_file_stable(
                project.arrays / (digest + ".npy"), reject_symlink=True, check=check
            ) != (digest, artifact["bytes"]):
                raise ValueError("Scientific artifact checksum changed")


def _references(project, result, check):
    from .research_vendor import verify_result_derivation

    provenance = result["provenance"]
    verify_result_derivation(project.source(result["source_id"]), provenance)
    if "spatial" in provenance:
        from .research_spatial import validate_parents

        validate_parents(
            result,
            {
                b["result_id"]: project.result(b["result_id"])
                for b in provenance["spatial"]["inputs"].values()
            },
        )
    snapshots = []
    for reference in provenance.get("references", {}).values():
        _check(check)
        source = project.source(reference["source_id"], verify=True, check=check)
        if source["sha256"] != reference["source_sha256"]:
            raise ValueError("Scientific reference source changed")
        snapshots.append({"source_id": source["id"], "source_sha256": source["sha256"]})
    bindings = list(provenance.get("temporal_inputs", []))
    bindings.extend(provenance.get("association_inputs", {}).values())
    bindings.extend(provenance.get("spatial", {}).get("inputs", {}).values())
    bindings.extend(provenance.get("compartment_measurement", {}).get("label_inputs", {}).values())
    bindings.extend(
        provenance[key]
        for key in ("parent_result", "fixed_result", "moving_result")
        if key in provenance
    )
    if result.get("parent_id"):
        bindings.append({"result_id": result["parent_id"]})
    if len(bindings) > 10000:
        raise ValueError("Too many scientific references")
    for binding in bindings:
        _check(check)
        if binding.get("missing_reason"):
            continue
        parent = project.result(binding["result_id"], check=check)
        if "revision_hash" in binding and parent["revision_hash"] != binding["revision_hash"]:
            raise ValueError("Scientific reference revision changed")
        source = project.source(parent["source_id"], verify=True, check=check)
        if source["sha256"] != parent["source_sha256"]:
            raise ValueError("Scientific reference source identity changed")
        _artifacts(project, parent, check)
        snapshots.append(
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "source_sha256": source["sha256"],
            }
        )
    return snapshots


def _groups(project, binding, check):
    from .research_groups import _reader, _record

    # Only the relevant revision is validated; unrelated missing sources and groups
    # never enter _reader. Dependency references must remain in this same revision.
    indexed = {}
    for document in project.documents("population_group"):
        receipt = document.get("data", {}).get("receipt", {})
        if (
            receipt.get("result_id") == binding["result_id"]
            and receipt.get("revision_hash") == binding["revision_hash"]
        ):
            _check(check)
            _record(document)
            indexed[document["id"]] = document
    if len(indexed) > 256:
        raise ValueError("Too many groups on the exact result")
    selected = binding["group_ids"] or sorted(indexed)
    read = _reader(project, indexed)
    output = []
    for group_id in sorted(selected):
        _check(check)
        document, _, _ = read(group_id)
        output.append(document)
    dependencies = {}

    def collect(document):
        for reference in document["data"]["definition"].get("groups", []):
            dependency = indexed[reference["group_id"]]
            if dependency["id"] not in dependencies:
                dependencies[dependency["id"]] = dependency
                collect(dependency)

    for document in output:
        collect(document)
    return output, [dependencies[key] for key in sorted(dependencies)]


def _snapshot(project, request, check=None):
    from .research_data_tables import inspect_item
    from .study_analysis import validate_sample_metadata

    request = _request(request)
    samples = {doc["id"]: doc for doc in project.documents("sample")}
    items, results = [], []
    all_units, replicate_ids, source_ids = set(), set(), set()
    metric_units = {}
    unassigned = set()
    for binding in request["bindings"]:
        _check(check)
        result = project.result(binding["result_id"], check=check)
        source = project.source(binding["source_id"], verify=True, check=check)
        if (
            any(
                result[key] != binding[key]
                for key in ("revision_hash", "source_id", "source_sha256")
            )
            or source["sha256"] != binding["source_sha256"]
        ):
            raise ValueError("Data export source or result binding is stale")
        history = project.review_history(result["id"], check=check)
        review = history[-1] if history else None
        if request["purpose"] == "reviewed" and (
            review is None or review["disposition"] != "reviewed"
        ):
            raise ValueError("Review this exact result revision before reviewed data export")
        _artifacts(project, result, check)
        references = _references(project, result, check)
        groups, dependencies = _groups(project, binding, check)
        labels = (
            sorted({label for doc in groups for label in doc["data"]["receipt"]["labels"]})
            if binding["subset"] == "groups"
            else None
        )
        sample = samples.get(source["id"])
        if sample is not None:
            validate_sample_metadata(sample["data"])
            metadata = sample["data"]
            replicate = metadata.get("biological_replicate")
            if replicate:
                replicate_ids.add((metadata["study"], metadata["condition"], replicate))
            else:
                unassigned.add(source["id"])
        else:
            unassigned.add(source["id"])
        item = {
            "result": result,
            "source": source,
            "review": review,
            "sample": sample,
            "groups": groups,
            "group_dependencies": dependencies,
            "references": references,
            "selected_labels": labels,
        }
        inspection = inspect_item(project, item, check=check)
        units = inspection.get("units", [])
        all_units.update(canonical_json(unit) for unit in units)
        for descriptor in inspection.get("descriptors", []):
            metric_units.setdefault(descriptor["id"], set()).add(
                (descriptor.get("kind"), descriptor.get("unit"))
            )
        preview = [
            {key: str(value) if value is not None else "" for key, value in row.items()}
            for row in inspection["preview"][:5]
        ]
        results.append(
            {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "source_id": source["id"],
                "name": _safe(source.get("name")) or source["id"],
                "review_status": review["disposition"] if review else "pending",
                "total_count": inspection["total_count"],
                "selected_count": inspection["selected_count"],
                "measurement_count": inspection["measurement_count"],
                "group_count": len(groups),
                "membership_count": sum(len(doc["data"]["receipt"]["labels"]) for doc in groups),
                "preview": preview,
                "units": units,
                "descriptors": inspection.get("descriptors", []),
                "row_sha256": inspection["row_sha256"],
                "source_record_sha256": _hash(source),
                "review_sha256": _hash(history),
                "sample_sha256": _hash(sample),
                "groups_sha256": _hash({"selected": groups, "dependencies": dependencies}),
                "references_sha256": _hash(references),
            }
        )
        source_ids.add(source["id"])
        # Keep study plans bounded: do not retain every v1 measurement population.
        # The table reader reopens one authoritative exact revision per pass.
        if result["schema"] == "loci.research-result/v1":
            item["result"] = {
                **result,
                "provenance": {
                    key: value
                    for key, value in result["provenance"].items()
                    if key != "measurements"
                },
            }
        items.append(item)
    plan = {
        "schema": PLAN_SCHEMA,
        "export_software": _export_software(),
        "purpose": request["purpose"],
        "request": request,
        "source_count": len(source_ids),
        "result_count": len(results),
        "total_count": sum(row["total_count"] for row in results),
        "selected_count": sum(row["selected_count"] for row in results),
        "measurement_count": sum(row["measurement_count"] for row in results),
        "group_count": sum(row["group_count"] for row in results),
        "membership_count": sum(row["membership_count"] for row in results),
        "declared_replicate_count": len(replicate_ids),
        "unassigned_source_count": len(unassigned),
        "mixed_units": any(len(values) > 1 for values in metric_units.values()),
        "units": [parse_json(unit) for unit in sorted(all_units)],
        "results": results,
    }
    plan["plan_sha256"] = _hash(plan)
    encoded = canonical_json(plan)
    if len(encoded.encode()) > MAX_PLAN_BYTES:
        raise ValueError("Data export preview exceeds its bounded plan size")
    return plan, items


def plan_export(project, request, check=None):
    plan, _ = _snapshot(project, request, check)
    return {"plan": plan, "plan_json": canonical_json(plan)}


def _parse_plan(plan_json):
    if not isinstance(plan_json, str) or len(plan_json.encode()) > MAX_PLAN_BYTES:
        raise ValueError("Data export requires a bounded opaque plan")
    plan = parse_json(plan_json)
    if (
        not isinstance(plan, dict)
        or canonical_json(plan) != plan_json
        or plan.get("schema") != PLAN_SCHEMA
    ):
        raise ValueError("Data export requires the unchanged canonical plan")
    if plan.get("plan_sha256") != _hash(
        {key: value for key, value in plan.items() if key != "plan_sha256"}
    ):
        raise ValueError("Data export plan checksum changed")
    return plan


def _rebuild(project, plan_json, check=None):
    expected = _parse_plan(plan_json)
    plan, items = _snapshot(project, expected["request"], check)
    if canonical_json(plan) != plan_json:
        raise ValueError("Data export plan is stale; preview the current exact revisions again")
    return plan, items


def _capability():
    required = (os.open, os.mkdir, os.stat, os.unlink, os.rmdir)
    if (
        _NATIVE_RENAME is None
        or any(call not in os.supports_dir_fd for call in required)
        or os.listdir not in os.supports_fd
    ):
        raise ValueError(
            "Atomic scientific data export requires directory-descriptor "
            "staging and atomic no-replace renaming on a supported "
            "filesystem"
        )


def _destination(project, destination):
    target = Path(destination)
    if (
        not target.is_absolute()
        or target.name in {"", ".", ".."}
        or any(ord(c) < 32 for c in target.name)
    ):
        raise ValueError("Data export needs an absent absolute destination")
    from .research_review_package import review_package_label

    try:
        review_package_label(target.name)
    except ValueError as error:
        raise ValueError("Choose a portable data package name of 1-120 UTF-8 bytes") from error
    parent = target.parent
    if parent.resolve(strict=True) != parent or not stat.S_ISDIR(parent.lstat().st_mode):
        raise ValueError("Data export parent must be a canonical plain directory")
    if target.exists() or target.is_symlink():
        raise ValueError(
            "Data export destination must be absent; existing work is never overwritten"
        )
    root = project.root.resolve(strict=True)
    if target == root or target.is_relative_to(root) or root.is_relative_to(target):
        raise ValueError("Data export must be outside its source study")
    return target


def create_export_grant(project, plan_json, destination):
    _capability()
    plan, _ = _rebuild(project, plan_json)
    target = _destination(project, destination)
    parent = target.parent.stat()
    grant_id = uuid.uuid4().hex
    project.put_document(
        "data_export_grant",
        grant_id,
        {
            "schema": "loci.data-export-grant/v1",
            "plan_json": plan_json,
            "plan_sha256": plan["plan_sha256"],
            "destination": str(target),
            "parent_identity": [parent.st_dev, parent.st_ino],
            "source_id": plan["results"][0]["source_id"],
            "export_name": target.name,
            "created_at": timestamp(),
        },
        expected_revision=0,
    )
    return {
        "grant_id": grant_id,
        "plan_sha256": plan["plan_sha256"],
        "source_id": plan["results"][0]["source_id"],
        "export_name": target.name,
    }


def _review_record(receipt):
    if receipt is None:
        return None
    fields = {
        "schema",
        "result_id",
        "revision_hash",
        "disposition",
        "reviewed_at",
        "actor",
        "event_id",
        "identity_assurance",
        "previous_review_sha256",
    }
    # Free-form identity, reason and coverage are bound by hashes but not disclosed.
    output = {key: value for key, value in receipt.items() if key in fields}
    authority = receipt.get("authority")
    if isinstance(authority, dict):
        output["authority"] = {
            key: authority[key] for key in ("kind", "policy_sha256", "delegation_id")
        }
    return output


def _artifact_record(descriptor):
    if "tiles" in descriptor:
        return {
            **{key: descriptor[key] for key in ("schema", "shape", "dtype", "tile_size")},
            "tile_count": len(descriptor["tiles"]),
            "descriptor_sha256": _hash(descriptor),
        }
    return {key: descriptor[key] for key in ("sha256", "bytes", "shape", "dtype")}


def _provenance(project, plan, items):
    output = []
    for item in items:
        result, source = item["result"], item["source"]
        history = project.review_history(result["id"])
        output.append(
            {
                "source_id": source["id"],
                "source_name": _safe(source.get("name")) or source["id"],
                "source_sha256": source["sha256"],
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "parent_id": result.get("parent_id"),
                "references": item["references"],
                "source_derivation_sha256": _hash(result["provenance"].get("source_derivation")),
                "engine_version": _safe(result.get("engine_version")),
                "arrays": {
                    name: _artifact_record(descriptor)
                    for name, descriptor in result["arrays"].items()
                },
                "label_sha256": result.get("label_sha256"),
                "object_table": result.get("object_table"),
                "source_metadata": _safe(
                    {
                        key: source["metadata"][key]
                        for key in ("physical_calibration", "shape", "axes", "dtype", "dimensions")
                        if key in source.get("metadata", {})
                    }
                ),
                "scientific_provenance": _safe(result["provenance"]),
                "model_profile_sha256": _hash(
                    result["provenance"].get("profile")
                    or result["provenance"].get("model", {}).get("profile")
                ),
                "model_identity": _safe(
                    (
                        result["provenance"].get("profile")
                        or result["provenance"].get("model", {}).get("profile")
                        or {}
                    ).get("model")
                ),
                "review": _review_record(item["review"]),
                "review_history": [_review_record(event) for event in history],
                "review_history_sha256": _hash(history),
                "sample_document_sha256": _hash(item["sample"]),
                "group_dependencies": [
                    {
                        "id": doc["id"],
                        "record_sha256": doc["data"]["record_sha256"],
                        "membership_sha256": doc["data"]["receipt"]["membership_sha256"],
                        "definition": doc["data"]["definition"],
                    }
                    for doc in item["group_dependencies"]
                ],
                "groups": [
                    {
                        "id": doc["id"],
                        "record_sha256": doc["data"]["record_sha256"],
                        "membership_sha256": doc["data"]["receipt"]["membership_sha256"],
                        "definition": doc["data"]["definition"],
                    }
                    for doc in item["groups"]
                ],
            }
        )
    return {
        "schema": PACKAGE_SCHEMA,
        "export_software": plan["export_software"],
        "purpose": plan["purpose"],
        "plan_sha256": plan["plan_sha256"],
        "raw_source_included": False,
        "image_arrays_included": False,
        "review_notes_omitted": True,
        "unknown_provenance_metadata_omitted": True,
        "results": output,
    }


def _identity(details):
    return details.st_dev, details.st_ino


def _verify_files(stage_fd, expected, check=None):
    if set(os.listdir(stage_fd)) != set(expected):
        raise ValueError("Data package contains missing or unexpected files")
    for name, record in expected.items():
        _check(check)
        descriptor = os.open(name, _FILE_FLAGS, dir_fd=stage_fd)
        try:
            before = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_size != record["size_bytes"]
            ):
                raise ValueError("Data package artifact is unsafe or changed")
            digest = hashlib.sha256()
            while chunk := os.read(descriptor, 1024**2):
                _check(check)
                digest.update(chunk)
            after = os.fstat(descriptor)
            current = os.stat(name, dir_fd=stage_fd, follow_symlinks=False)
            if (
                digest.hexdigest() != record["sha256"]
                or _identity(before) != _identity(current)
                or current.st_nlink != 1
                or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
            ):
                raise ValueError("Data package artifact checksum changed")
        finally:
            os.close(descriptor)


def export_data_package(project, plan_json, destination, check=None, progress=None):
    from .research_data_tables import write_tables

    _capability()
    plan, items = _rebuild(project, plan_json, check)
    target = _destination(project, destination)
    # Conservative allowance for long-form measurements and exact raw JSON rows.
    estimate = (
        16 * 1024**2
        + plan["selected_count"] * 32768
        + plan["measurement_count"] * 2048
        + plan["membership_count"] * 512
    )
    if estimate > MAX_PACKAGE_BYTES or shutil.disk_usage(target.parent).free < estimate:
        raise ValueError("Insufficient disk space or data package exceeds the 8 GiB export budget")
    parent_fd = os.open(target.parent, _DIRECTORY_FLAGS)
    stage_fd = None
    stage_name = ".loci-data-" + uuid.uuid4().hex
    stage_identity = None
    files = {}
    published = False
    parent_identity = _identity(os.fstat(parent_fd))
    try:
        if parent_identity != _identity(target.parent.lstat()):
            raise ValueError("Data export parent changed before staging")
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        stage_identity = _identity(os.fstat(stage_fd))

        @contextmanager
        def open_text(name):
            _check(check)
            if (
                not isinstance(name, str)
                or not (_SAFE_FILENAME.fullmatch(name) or name in {"read_data.py", "read_data.R"})
                or name in files
                or len(files) >= MAX_FILES
            ):
                raise ValueError("Invalid or duplicate scientific data artifact name")
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=stage_fd,
            )
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
                yield stream
                stream.flush()
                os.fsync(stream.fileno())
            fd = os.open(name, _FILE_FLAGS, dir_fd=stage_fd)
            try:
                digest, size = hashlib.sha256(), 0
                while chunk := os.read(fd, 1024**2):
                    _check(check)
                    size += len(chunk)
                    if (
                        size + sum(record["size_bytes"] for record in files.values())
                        > MAX_PACKAGE_BYTES
                    ):
                        raise ValueError("Data package exceeds its byte budget")
                    digest.update(chunk)
                details = os.fstat(fd)
                if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
                    raise ValueError("Data package artifact is unsafe")
                files[name] = {"sha256": digest.hexdigest(), "size_bytes": size}
            finally:
                os.close(fd)

        def write_json(name, value):
            with open_text(name) as stream:
                stream.write(canonical_json(value) + "\n")

        table_items = [{**item, "review": _review_record(item["review"])} for item in items]

        def table_progress(completed):
            if progress is not None:
                progress(min(0.9, 0.9 * completed / max(1, plan["selected_count"])))

        tables = write_tables(project, table_items, open_text, check=check, progress=table_progress)
        write_json(
            "schema.json",
            {
                "schema": PACKAGE_SCHEMA,
                "encoding": "UTF-8",
                "purpose": plan["purpose"],
                "tables": tables,
                "numeric_policy": "Python round-trip floats and decimal integers; no rounding",
                "independent_n_basis": (
                    "No independent n inferred; declared groups use study, condition and "
                    "biological_replicate; objects/images may be correlated"
                ),
                "replicate_grouping": ["study", "condition", "biological_replicate"],
            },
        )
        write_json("provenance.json", _provenance(project, plan, items))
        with open_text("methods.md") as stream:
            stream.write(
                "# Executed scientific data\n\nThis package preserves stored "
                "object measurements without image resampling or numerical "
                "rounding. Geometry, calibration, selected C/Z/T/level, "
                "executed method and runtime identities are recorded in "
                "provenance.json. Missing sample or biological replicate "
                "assignments remain unassigned. No replicate or condition "
                "summary estimates are computed. Objects and images are "
                "correlated observations. These execution records do not "
                "establish biological or clinical accuracy.\n"
            )
        with open_text("readme.md") as stream:
            stream.write(
                "# Loci scientific data package\n\nPurpose: "
                + plan["purpose"]
                + (
                    ".\n\nRead schema.json before importing UTF-8 tables: it "
                    "declares types, missing-value and reversible text encoding, "
                    "keys, and units. object-records.jsonl preserves exact stored"
                    " object structures. Group membership rows preserve overlaps;"
                    " subset objects are a unique union. Inspect provenance.json "
                    "and review status before interpretation. Source images, "
                    "arrays, local paths, profiles, grants and free-form review "
                    "notes are omitted. Verify every file against manifest.json "
                    "before use.\n\nRun `python read_data.py .` or `Rscript read_data.R .` "
                    "to validate and import this package. The scripts do not run automatically. "
                    "Python uses its standard library; R requires jsonlite. Exact numeric "
                    "lexemes are retained; safe numeric accessors preserve integer precision.\n"
                )
            )
        from .scientific_export_readers import PYTHON_READER, R_READER

        for name, contents in (("read_data.py", PYTHON_READER), ("read_data.R", R_READER)):
            with open_text(name) as stream:
                stream.write(contents)
        manifest = {
            "schema": "loci.data-export-manifest/v1",
            "package_schema": PACKAGE_SCHEMA,
            "export_software": plan["export_software"],
            "purpose": plan["purpose"],
            "plan_sha256": plan["plan_sha256"],
            "counts": {
                key: plan[key]
                for key in (
                    "result_count",
                    "source_count",
                    "total_count",
                    "selected_count",
                    "measurement_count",
                    "group_count",
                    "membership_count",
                    "declared_replicate_count",
                    "unassigned_source_count",
                )
            },
            "files": [{"name": name, **record} for name, record in sorted(files.items())],
        }
        write_json("manifest.json", manifest)
        os.fsync(stage_fd)
        _verify_files(stage_fd, files, check)
        _rebuild(project, plan_json, check)
        _verify_files(stage_fd, files, check)
        _rebuild(project, plan_json, check)
        _check(check)
        if (
            target.parent.resolve(strict=True) != target.parent
            or parent_identity != _identity(target.parent.lstat())
            or stage_identity
            != _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
        ):
            raise ValueError("Data export publication directory changed")
        try:
            _rename_noreplace(stage_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        except OSError as error:
            if error.errno in {errno.ENOTSUP, errno.EOPNOTSUPP, errno.EXDEV, errno.ENOSYS}:
                raise ValueError(
                    "This destination filesystem does not support atomic no-"
                    "replace data package saving; choose an APFS or another "
                    "supported local filesystem"
                ) from error
            raise
        published = True
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise RuntimeError(
                "Data package was published in its granted directory, but its location changed; "
                "inspect the destination before retrying"
            )
        try:
            os.fsync(parent_fd)
        except OSError as error:
            raise RuntimeError(
                "Data package was published, but directory durability could "
                "not be confirmed; inspect the destination before retrying"
            ) from error
        return {
            "schema": "loci.data-export-receipt/v1",
            "basename": target.name,
            "purpose": plan["purpose"],
            "manifest_sha256": files["manifest.json"]["sha256"],
            "result_count": plan["result_count"],
            "source_count": plan["source_count"],
            "selected_count": plan["selected_count"],
        }
    finally:
        if stage_fd is not None:
            if not published:
                original_error = sys.exception()
                try:
                    with suppress(FileNotFoundError):
                        current = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
                        if _identity(current) == stage_identity:
                            shutil.rmtree(stage_name, dir_fd=parent_fd)
                except OSError:
                    if original_error is not None:
                        original_error.add_note("Owned data export staging could not be removed")
                    else:
                        raise
            os.close(stage_fd)
        os.close(parent_fd)


def _task_grant(project, request):
    _exact(request, {"grant_id", "plan_sha256"}, "Data export task")
    grant_id = checked_id(request["grant_id"])
    if not isinstance(request["plan_sha256"], str) or not SHA_PATTERN.fullmatch(
        request["plan_sha256"]
    ):
        raise ValueError("Data export task requires an exact plan checksum")
    document = next(iter(project.documents("data_export_grant", document_id=grant_id)), None)
    if document is None or document["data"].get("plan_sha256") != request["plan_sha256"]:
        raise ValueError("Data export grant is missing or differs from its exact plan")
    grant = document["data"]
    plan = _parse_plan(grant["plan_json"])
    if (
        plan["plan_sha256"] != request["plan_sha256"]
        or grant.get("source_id") != plan["results"][0]["source_id"]
    ):
        raise ValueError("Data export grant bindings changed")
    checked_id(grant["source_id"])
    return document


def export_task_source(project, request):
    """Validate public task identities and return only the pinned source handle."""
    return _task_grant(project, request)["data"]["source_id"]


def execute_export_task(workbench, request, job_id=None, publication_guard=None):
    project = workbench.project
    grant_doc = _task_grant(project, request)
    grant_id = grant_doc["id"]
    grant = grant_doc["data"]

    def check():
        _check(publication_guard)
        current = next(iter(project.documents("data_export_grant", document_id=grant_id)), None)
        if current != grant_doc:
            raise PermissionError("Data export grant changed or was revoked")
        if job_id is not None:
            job = project.job(job_id)
            if job["state"] != "running" or job["cancel_requested"]:
                raise ValueError("Data export cancelled before publication")
        parent = Path(grant["destination"]).parent
        if (
            parent.resolve(strict=True) != parent
            or list(_identity(parent.lstat())) != grant["parent_identity"]
        ):
            raise ValueError("Granted data export parent changed")

    def progress(value):
        check()
        if job_id is not None:
            project.update_job(
                job_id, expected_state="running", progress=min(0.95, max(0.0, float(value)))
            )

    check()
    receipt = export_data_package(
        project, grant["plan_json"], grant["destination"], check=check, progress=progress
    )
    if job_id is not None:
        project.update_job(
            job_id,
            expected_state="running",
            state="succeeded",
            progress=1.0,
            finished_at=timestamp(),
        )
    return receipt
