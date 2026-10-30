"""Read-only, bounded desktop projection of immutable producing-analysis records.

Never project arbitrary provenance: each output field has an explicit persisted
source. This service is intentionally absent from the public operation catalog.
It reads no image arrays, executes no analysis and consults no current controls.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import TYPE_CHECKING, Any

from .quantitative import exact_keys
from .research_project import ResearchProject, canonical_json, checked_id

if TYPE_CHECKING:
    from .workbench import Workbench

MAX_ANCESTRY = 32
MAX_FIELDS = 256
MAX_RESPONSE_BYTES = 64 * 1024
_SELECTION = ("x", "y", "width", "height", "t", "c", "z", "z_stop", "level", "elapsed_time_s")
_SEGMENTATION = (
    "method",
    "dimensions",
    "threshold",
    "threshold_method",
    "polarity",
    "resolved_polarity",
    "connectivity",
    "min_size",
    "size_unit",
    "split_height",
    "distance_unit",
    "exclude_border",
    "probability_channel",
    "count",
    "confluence_percent",
)
_SETTINGS = (
    "image_mode",
    "polarity",
    "expected_diameter_px",
    "min_area_px",
    "sensitivity",
    "smoothing_px",
    "split_touching",
    "exclude_border",
    "max_edge_px",
    "diameter_px",
    "flow_threshold",
    "cellprob_threshold",
    "min_size_px",
    "max_size_fraction",
    "niter",
    "batch_size",
    "resample",
    "augment",
    "tile_overlap",
    "normalize",
    "percentile_low",
    "percentile_high",
    "tile_norm_blocksize",
    "sharpen_radius",
    "smooth_radius",
    "invert",
    "device",
)
_PROCESSING = (
    "id",
    "dtype",
    "eps",
    "resolved_mean",
    "resolved_std",
    "scope",
    "tile_count",
    "record_limit",
    "op",
    "sigma",
    "sigma_voxels",
    "radius",
    "value",
    "clip_negative",
    "unit",
    "boundary",
    "scale",
    "mean",
    "std",
    "min",
    "max",
    "percentiles",
    "axes",
    "mode",
)
_RUNTIME = (
    "engine",
    "numpy",
    "scipy",
    "scikit_image",
    "backend",
    "requested_device",
    "resolved_device",
    "fallback_reason",
    "onnx_version",
    "onnxruntime_version",
    "requested_providers",
    "session_providers",
    "execution_mode",
    "intra_op_threads",
    "inter_op_threads",
    "graph_optimization",
    "python_version",
    "torch_version",
    "cuda_runtime",
    "cudnn_version",
    "cellpose_version",
    "model_sha256",
    "metadata_sha256",
    "package_sha256",
)
_KIND_LABELS = {
    "external-labels": "Imported labels",
    "corrected-labels": "Corrected segmentation",
    "large-corrected-labels": "Corrected segmentation",
    "large-segmentation": "Threshold segmentation",
    "large-components": "Threshold segmentation",
    "adaptive-segmentation": "Adaptive watershed segmentation",
    "cellpose-segmentation": "Cellpose segmentation",
    "model-segmentation": "Model segmentation",
    "cell-segmentation": "Cell segmentation",
    "processed": "Image processing",
    "declared-stain-analysis": "Declared stain analysis",
    "tissue-region-mask": "Tissue region mask",
    "annotated-result": "Annotated result",
    "puncta": "Puncta detection",
    "puncta-quantification": "Puncta detection",
    "nucleus-cell-association": "Nucleus-cell association",
    "perinuclear-enrichment": "Perinuclear enrichment",
    "spatial-distance-bands": "Tissue distance bands",
    "field-assay": "Fluorescence field assay",
    "tracking": "Object tracking",
    "temporal-tracking": "Object tracking",
    "registration": "Image registration",
    "registered-derived": "Registered image",
    "resampled-derived": "Resampled image",
    "colocalisation": "Colocalisation measurement",
}


def method_label(result: dict[str, Any]) -> str:
    """Fixed vocabulary only; never embed source names, settings or identifiers."""
    kind = result.get("kind")
    if kind in _KIND_LABELS:
        if kind == "nucleus-cell-association" and "compartment_measurement" in result.get(
            "provenance", {}
        ):
            return "Compartment measurements"
        return _KIND_LABELS[kind]
    provenance = result.get("provenance", {})
    if "compartment_measurement" in provenance:
        return "Compartment measurements"
    if "model_preview" in provenance:
        return "Model segmentation"
    segmentation = provenance.get("segmentation")
    if isinstance(segmentation, dict):
        method = segmentation.get("method")
        return (
            {
                "components": "Threshold segmentation",
                "watershed": "Watershed segmentation",
                "loci-adaptive-watershed": "Adaptive watershed segmentation",
            }.get(method, "Segmentation")
            if isinstance(method, str)
            else "Segmentation"
        )
    return "Segmentation" if kind == "segmentation" else "Analysis result"


def _verified_source(project: ResearchProject, source_id: str) -> dict[str, Any]:
    try:
        return project.source(source_id, verify=True)
    except (OSError, ValueError):
        # File-system failures may contain canonical paths. Fail without disclosing them.
        raise ValueError("Result description source is unavailable or changed") from None


def _value(value: Any) -> Any:
    """A small scalar/vector, with paths and non-finite values never disclosed."""
    if value is None or type(value) in (bool, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Persisted result context contains a non-finite value")
        return value
    if isinstance(value, str):
        # Names/versions are untrusted text. Do not turn them into path disclosures.
        if len(value) > 256 or "/" in value or "\\" in value or any(ord(c) < 32 for c in value):
            return None
        return value
    if (
        isinstance(value, list)
        and len(value) <= 32
        and all(item is None or type(item) in (bool, int, float, str) for item in value)
    ):
        values = [_value(item) for item in value]
        return (
            values
            if all(v is not None or old is None for v, old in zip(values, value, strict=True))
            else None
        )
    return None


def _fields(record: Any, keys: tuple[str, ...], path: str, output: list[dict[str, Any]]) -> None:
    if not isinstance(record, dict):
        return
    for key in keys:
        if key in record:
            output.append({"name": key, "value": _value(record[key]), "source": f"{path}.{key}"})
    if len(output) > MAX_FIELDS:
        raise ValueError("Result context exceeds the bounded settings field limit")


def _selection(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - set(_SELECTION):
        raise ValueError("Persisted result selection is invalid")
    output = {}
    for key, item in value.items():
        if key == "elapsed_time_s":
            if type(item) not in (int, float) or not math.isfinite(item):
                raise ValueError("Persisted elapsed time is invalid")
        elif type(item) is not int or item < 0:
            raise ValueError("Persisted result selection is invalid")
        elif key in {"width", "height"} and item == 0:
            raise ValueError("Persisted result selection must have positive extent")
        output[key] = item
    if "z_stop" in output and output["z_stop"] <= output.get("z", 0):
        raise ValueError("Persisted Z selection must be a non-empty half-open interval")
    return output


def _processing_fields(records: Any, path: str, output: list[dict[str, Any]]) -> None:
    if not isinstance(records, list):
        return
    if len(records) > 32:
        raise ValueError("Too many producing processing steps")
    for index, record in enumerate(records):
        location = f"{path}[{index}]"
        _fields(record, _PROCESSING, location, output)
        if isinstance(record, dict):
            _fields(
                record.get("kwargs"),
                ("axes", "eps", "mean", "std", "dtype"),
                f"{location}.kwargs",
                output,
            )
            tiles = record.get("recorded_tiles")
            if isinstance(tiles, list):
                if len(tiles) > 16:
                    raise ValueError("Too many recorded model preprocessing tiles")
                for tile_index, tile in enumerate(tiles):
                    tile_location = f"{location}.recorded_tiles[{tile_index}]"
                    _fields(tile, ("tile",), tile_location, output)
                    if isinstance(tile, dict):
                        # One supported recorded tile layer; never recurse arbitrary provenance.
                        operations = tile.get("operations")
                        if not isinstance(operations, list) or len(operations) > 32:
                            raise ValueError("Invalid recorded tile preprocessing operations")
                        for op_index, op in enumerate(operations):
                            _fields(
                                op, _PROCESSING, f"{tile_location}.operations[{op_index}]", output
                            )


def _channels(provenance: dict[str, Any]) -> dict[str, Any]:
    selection = provenance.get("selection") or {}
    recipe = provenance.get("recipe") or {}
    indices = provenance.get("measurement_channels", recipe.get("measurement_channels"))
    metadata = provenance.get("channel_metadata")
    metadata_path = "provenance.channel_metadata"
    compartment = provenance.get("compartment_measurement")
    if compartment is not None:
        if not isinstance(compartment, dict) or compartment.get("schema_version") != 1:
            raise ValueError("Persisted compartment measurement context is invalid")
        bindings = compartment.get("channels")
        if not isinstance(bindings, list) or not 1 <= len(bindings) <= 32:
            raise ValueError("Persisted compartment measurement channels are invalid")
        if any(not isinstance(item, dict) for item in bindings):
            raise ValueError("Persisted compartment channel binding is invalid")
        indices = [item.get("index") for item in bindings]
        metadata = compartment.get("channel_metadata")
        metadata_path = "provenance.compartment_measurement.channel_metadata"
    if indices is not None and (
        not isinstance(indices, list)
        or len(indices) > 32
        or any(type(i) is not int or i < 0 for i in indices)
        or len(set(indices)) != len(indices)
    ):
        raise ValueError("Persisted measurement channels are invalid")
    names = None
    if isinstance(metadata, dict) and isinstance(metadata.get("channels"), list):
        selected = set(indices or []) | ({selection["c"]} if "c" in selection else set())
        mapping = provenance.get("channel_mapping", [])
        if isinstance(mapping, list) and len(mapping) <= 32:
            selected.update(
                item["source_channel"]
                for item in mapping
                if isinstance(item, dict) and type(item.get("source_channel")) is int
            )
        if len(selected) > 64:
            raise ValueError("Too many context channels")
        names = [
            {
                "index": index,
                "name": _value(metadata["channels"][index].get("name")),
                "source": f"{metadata_path}.channels[{index}].name",
            }
            for index in sorted(selected)
            if 0 <= index < len(metadata["channels"])
            and isinstance(metadata["channels"][index], dict)
        ]
    return {"segmentation": selection.get("c"), "measurement": indices, "names": names}


def _safe_recipe(recipe: Any) -> bool:
    """Whitelist the original request grammar; never copy an arbitrary JSON tree."""
    if not isinstance(recipe, dict) or not {
        "steps",
        "segmentation",
        "measurement_channels",
        "gates",
        "working_bytes",
    } <= set(recipe) <= {
        "steps",
        "segmentation",
        "measurement_channels",
        "gates",
        "working_bytes",
        "references",
        "input_transform",
    }:
        return False
    specs = (
        (recipe["steps"], {"op", "sigma", "radius", "value", "clip_negative"}),
        (recipe["gates"], {"name", "channel", "statistic", "threshold", "control"}),
    )
    for records, keys in specs:
        if not isinstance(records, list) or len(records) > 32:
            return False
        for record in records:
            if not isinstance(record, dict) or set(record) - keys:
                return False
            if any(_value(value) != value for value in record.values()):
                return False
    segment = recipe["segmentation"]
    if segment is not None and (
        not isinstance(segment, dict)
        or set(segment)
        - {"method", "threshold", "polarity", "min_size", "split_height", "exclude_border"}
        or any(_value(value) != value for value in segment.values())
    ):
        return False
    if recipe.get("input_transform") not in (None, "rgb_intensity"):
        return False
    return type(recipe["working_bytes"]) is int and isinstance(recipe["measurement_channels"], list)


def _replay(workbench: Workbench, result: dict[str, Any]) -> dict[str, Any]:
    unsupported = {
        "status": "unsupported",
        "operation": None,
        "request": None,
        "reason": "The complete original execution request is unavailable.",
    }
    provenance = result["provenance"]
    if result.get("parent_id") or provenance.get("workflow"):
        return {
            **unsupported,
            "reason": "This revision requires its original correction or workflow context.",
        }
    selection = _selection(provenance.get("selection"))
    runtime = provenance.get("runtime")
    if selection is None or not isinstance(runtime, dict) or not runtime:
        return unsupported
    if result["kind"] in {"segmentation", "processed"} and _safe_recipe(provenance.get("recipe")):
        recipe = provenance["recipe"]
        if hashlib.sha256(canonical_json(recipe).encode()).hexdigest() != provenance.get(
            "recipe_sha256"
        ):
            raise ValueError("Persisted producing recipe hash mismatch")
        references = recipe.get("references", {})
        stored = provenance.get("references", {})
        if not isinstance(references, dict) or set(references) - {"flatfield", "darkfield"}:
            return unsupported
        if set(references) != set(stored):
            return unsupported
        for key, binding in references.items():
            if not isinstance(binding, dict) or set(binding) != {"source_id", "selection"}:
                return unsupported
            _selection(binding["selection"])
            reference = _verified_source(workbench.project, binding["source_id"])
            if reference["sha256"] != stored[key].get("source_sha256") or any(
                stored[key].get(field) != binding[field] for field in ("source_id", "selection")
            ):
                raise ValueError("Persisted producing reference identity mismatch")
        return {
            "status": "available",
            "operation": "run_recipe",
            "request": {"source_id": result["source_id"], "selection": selection, "recipe": recipe},
            "reason": None,
        }
    if result["kind"] == "adaptive-segmentation":
        from .profiles import DEFAULT_PROFILE_ID
        from .working_result import _settings_from_record

        accepted = provenance.get("accepted_request")
        keys = {
            "source_id",
            "selection",
            "profile_id",
            "settings",
            "measurement_channels",
            "working_bytes",
        }
        if not isinstance(accepted, dict) or set(accepted) != keys | {"input_mapping"}:
            return unsupported
        if (
            accepted["source_id"] != result["source_id"]
            or accepted["selection"] != selection
            or accepted["settings"] != provenance.get("settings")
            or accepted["measurement_channels"] != provenance.get("measurement_channels")
        ):
            raise ValueError("Persisted adaptive execution binding mismatch")
        settings = accepted["settings"]
        if not isinstance(settings, dict) or set(settings) != set(_SETTINGS[:8]):
            return unsupported
        if (
            any(_value(v) != v for v in settings.values())
            or accepted["profile_id"] != DEFAULT_PROFILE_ID
            or type(accepted["working_bytes"]) is not int
            or not 1024**2 <= accepted["working_bytes"] <= 8 * 1024**3
        ):
            return unsupported
        _settings_from_record(
            {"kind": "SegmentationSettings", "values": settings}, backend_kind="classical"
        )
        return {
            "status": "available",
            "operation": "classical_run",
            "request": {key: accepted[key] for key in sorted(keys)},
            "reason": None,
        }
    return unsupported


def describe_result(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    exact_keys(request, {"result_id", "revision_hash"}, "result description")
    result_id = checked_id(request.get("result_id"))
    revision = request.get("revision_hash")
    if not isinstance(revision, str) or not re.fullmatch("[0-9a-f]{64}", revision):
        raise ValueError("Result description requires an exact revision hash")
    result = workbench.project.result(result_id)
    if result["revision_hash"] != revision:
        raise ValueError("Result description revision mismatch")
    source = _verified_source(workbench.project, result["source_id"])
    if source["sha256"] != result["source_sha256"]:
        raise ValueError("Result description source identity mismatch")
    lineage = []
    seen = {result_id}
    current = result
    producing = result
    while current.get("parent_id"):
        if len(lineage) >= MAX_ANCESTRY or current["parent_id"] in seen:
            raise ValueError("Result ancestry is cyclic or exceeds the bounded limit")
        parent = workbench.project.result(current["parent_id"])
        seen.add(parent["id"])
        if (
            parent["source_id"] != result["source_id"]
            or parent["source_sha256"] != result["source_sha256"]
        ):
            raise ValueError("Result ancestry source identity mismatch")
        correction = current["provenance"].get("correction")
        bound = False
        if current["kind"] == "corrected-labels":
            if not isinstance(correction, dict) or correction.get("parent_id") != parent["id"]:
                raise ValueError("Correction parent binding is missing or mismatched")
            if correction.get("parent_revision_hash") != parent["revision_hash"]:
                raise ValueError("Correction parent revision mismatch")
            bound = True
        elif current["kind"] == "nucleus-cell-association":
            binding = current["provenance"].get("association_inputs", {}).get("cells", {})
            if (
                binding.get("result_id") != parent["id"]
                or binding.get("revision_hash") != parent["revision_hash"]
            ):
                raise ValueError("Association parent revision binding is missing or mismatched")
            bound = True
        elif current["kind"] == "perinuclear-enrichment":
            from .research_perinuclear import validate_parent

            validate_parent(current, parent)
            bound = True
        if producing["id"] == current["id"] and current["kind"] == "corrected-labels":
            producing = parent
        lineage.append(
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "kind": parent["kind"],
                "method_label": method_label(parent),
                "revision_bound": bound,
            }
        )
        current = parent
    provenance = result["provenance"]
    settings: list[dict[str, Any]] = []
    compartment = provenance.get("compartment_measurement")
    compartment_inputs = []
    if compartment is not None:
        if not isinstance(compartment, dict) or compartment.get("schema_version") != 1:
            raise ValueError("Persisted compartment measurement context is invalid")
        bindings = compartment.get("label_inputs")
        if not isinstance(bindings, dict) or set(bindings) != {"nuclei", "cells"}:
            raise ValueError("Compartment context requires exact label input bindings")
        for role, binding in bindings.items():
            if not isinstance(binding, dict):
                raise ValueError("Compartment context label binding is invalid")
            parent = workbench.project.result(checked_id(binding.get("result_id")))
            if (
                parent["revision_hash"] != binding.get("revision_hash")
                or parent["source_id"] != result["source_id"]
                or parent["source_sha256"] != result["source_sha256"]
                or binding.get("source_sha256") != result["source_sha256"]
            ):
                raise ValueError("Compartment context label input identity mismatch")
            compartment_inputs.append(parent)
            _fields(
                binding,
                ("result_id", "revision_hash"),
                f"provenance.compartment_measurement.label_inputs.{role}",
                settings,
            )
        _fields(
            compartment,
            ("basis", "empty_policy", "association_independent"),
            "provenance.compartment_measurement",
            settings,
        )
        _fields(
            compartment.get("partition"),
            ("cell", "nuclear", "cytoplasm"),
            "provenance.compartment_measurement.partition",
            settings,
        )
    _fields(provenance.get("settings"), _SETTINGS, "provenance.settings", settings)
    _fields(
        provenance.get("perinuclear"),
        (
            "radius_px",
            "signal_channel",
            "control",
            "distance_basis",
            "overlap_policy",
            "nucleus_policy",
            "boundary_policy",
            "empty_policy",
            "zero_policy",
            "signal_policy",
            "interpretation",
            "endpoint",
        ),
        "provenance.perinuclear",
        settings,
    )
    _fields(provenance.get("segmentation"), _SEGMENTATION, "provenance.segmentation", settings)
    _fields(provenance, ("working_bytes", "estimated_working_bytes"), "provenance", settings)
    _fields(
        provenance.get("recipe"),
        ("working_bytes", "input_transform"),
        "provenance.recipe",
        settings,
    )
    for key in ("processing", "preprocessing", "package_postprocessing"):
        _processing_fields(provenance.get(key), f"provenance.{key}", settings)
    _fields(
        provenance.get("tiling"),
        ("input_yx", "halo_yx", "core_yx", "padding", "tile_count", "stitching"),
        "provenance.tiling",
        settings,
    )
    _fields(
        provenance.get("source_scale"),
        ("mode", "resampled", "override_scope", "scientific_output_geometry"),
        "provenance.source_scale",
        settings,
    )
    scale = provenance.get("source_scale")
    if isinstance(scale, dict):
        _fields(
            scale.get("model_input"),
            ("scale_yx", "scale_unit"),
            "provenance.source_scale.model_input",
            settings,
        )
    recipe = provenance.get("recipe")
    if isinstance(recipe, dict) and isinstance(recipe.get("gates"), list):
        if len(recipe["gates"]) > 64:
            raise ValueError("Too many producing marker gates")
        for index, gate in enumerate(recipe["gates"]):
            _fields(
                gate,
                ("name", "channel", "statistic", "threshold", "control"),
                f"provenance.recipe.gates[{index}]",
                settings,
            )
    mapping = provenance.get("channel_mapping")
    if isinstance(mapping, list):
        if len(mapping) > 32:
            raise ValueError("Too many model channel mappings")
        for index, record in enumerate(mapping):
            _fields(
                record,
                ("model_input_index", "model_channel", "source_channel"),
                f"provenance.channel_mapping[{index}]",
                settings,
            )
    runtime: list[dict[str, Any]] = []
    _fields(result, ("engine_version",), "result", runtime)
    runtime_record = provenance.get("runtime")
    runtime_keys = (
        tuple(key for key in _RUNTIME if key != "engine")
        if (isinstance(runtime_record, dict) and isinstance(runtime_record.get("engine"), dict))
        else _RUNTIME
    )
    _fields(runtime_record, runtime_keys, "provenance.runtime", runtime)
    for key in ("engine", "cellpose"):
        record = provenance.get("runtime", {})
        if isinstance(record, dict):
            _fields(record.get(key), _RUNTIME, f"provenance.runtime.{key}", runtime)
            nested = record.get(key)
            if isinstance(nested, dict):
                _fields(
                    nested.get("package"),
                    ("name", "version"),
                    f"provenance.runtime.{key}.package",
                    runtime,
                )
                _fields(
                    nested.get("model"),
                    ("artifact_id", "sha256"),
                    f"provenance.runtime.{key}.model",
                    runtime,
                )
    model: list[dict[str, Any]] = []
    _fields(
        provenance.get("model"),
        ("id", "version", "task", "model_sha256", "metadata_sha256", "package_sha256"),
        "provenance.model",
        model,
    )
    if isinstance(provenance.get("model"), dict):
        _processing_fields(
            provenance["model"].get("preprocessing"), "provenance.model.preprocessing", settings
        )
        _fields(
            provenance["model"].get("model"),
            ("sha256", "opset_version"),
            "provenance.model.model",
            model,
        )
        _fields(
            provenance["model"].get("profile"),
            ("id", "name", "version", "backend_kind"),
            "provenance.model.profile",
            model,
        )
    importer: list[dict[str, Any]] = []
    external = provenance.get("external_labels")
    if isinstance(external, dict):
        _fields(
            external.get("producer"),
            ("name", "version"),
            "provenance.external_labels.producer",
            importer,
        )
        _fields(
            external,
            (
                "producer_identity_basis",
                "original_dtype",
                "shape",
                "alignment",
                "upstream_settings",
                "upstream_model",
                "upstream_runtime",
            ),
            "provenance.external_labels",
            importer,
        )
    correction_fields: list[dict[str, Any]] = []
    _fields(
        provenance.get("correction"),
        (
            "working_memory_limit_bytes",
            "input_sha256",
            "output_sha256",
            "changed_voxels",
            "input_labels_sha256",
            "output_labels_sha256",
        ),
        "provenance.correction",
        correction_fields,
    )
    correction = provenance.get("correction")
    if isinstance(correction, dict) and isinstance(correction.get("operations"), list):
        if len(correction["operations"]) > 64:
            raise ValueError("Too many correction operations for the bounded description")
        for index, record in enumerate(correction["operations"]):
            _fields(
                record,
                ("op", "changed_voxels", "input_labels_sha256", "output_labels_sha256"),
                f"provenance.correction.operations[{index}]",
                correction_fields,
            )
    geometry = provenance.get("geometry")
    if geometry is not None:
        from .workbench import geometry_from_dict

        geometry_from_dict(
            geometry
        )  # Validate explicit axes, affine, units and frame; no resampling.
        geometry = {
            key: geometry[key] for key in ("axes", "affine", "unit", "frame") if key in geometry
        }
    selection = _selection(provenance.get("selection"))
    basis = _value(
        compartment.get("basis") if compartment is not None else provenance.get("measurement_basis")
    )
    channels = _channels(provenance)
    unavailable = [
        name
        for name, value in (
            ("settings", settings),
            ("runtime", provenance.get("runtime")),
            ("selection", selection),
            ("calibration", geometry),
            ("measurement_basis", basis),
        )
        if not value
    ]
    if channels["measurement"] is None:
        unavailable.append("measurement_channels")
    for group in (settings, runtime, model, importer, correction_fields):
        unavailable.extend(field["source"] for field in group if field["value"] is None)
    unavailable.extend(
        f"parents[{index}].revision_binding"
        for index, parent in enumerate(lineage)
        if not parent["revision_bound"]
    )
    output = {
        "schema": "loci.result-context/v1",
        "result_id": result_id,
        "revision_hash": revision,
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "kind": result["kind"],
        "method_label": method_label(result),
        "producing_method_label": method_label(producing),
        "engine_version": _value(result.get("engine_version")),
        "settings": settings,
        "runtime": runtime,
        "model": model,
        "importer": importer,
        "selection": selection,
        "calibration": geometry,
        "channels": channels,
        "measurement_basis": basis,
        "parents": lineage,
        "correction": correction_fields,
        "unavailable": unavailable,
        "replay": _replay(workbench, result),
    }
    if len(canonical_json(output).encode()) > MAX_RESPONSE_BYTES:
        raise ValueError("Result context exceeds its bounded response limit")
    # Do not return a description after a concurrent source/result identity change.
    if (
        workbench.project.result(result_id)["revision_hash"] != revision
        or _verified_source(workbench.project, result["source_id"])["sha256"]
        != result["source_sha256"]
    ):
        raise ValueError("Result description identity changed during inspection")
    for parent in compartment_inputs:
        if workbench.project.result(parent["id"])["revision_hash"] != parent["revision_hash"]:
            raise ValueError("Compartment description label input changed during inspection")
    for parent in lineage:
        if (
            workbench.project.result(parent["result_id"])["revision_hash"]
            != parent["revision_hash"]
        ):
            raise ValueError("Result description parent identity changed during inspection")
    return output
