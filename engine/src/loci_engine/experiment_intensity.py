"""Bounded, immutable comparisons of actual stored raw-channel means.

No pixels are read or measured here. Source bytes and immutable artifacts are
verified, then the scientific-table descriptor/accessor supplies exact values.
Validation checks a saved snapshot in isolation; it never updates it from a study.
"""

from __future__ import annotations

import copy
import hashlib
import math
import sys
from collections import defaultdict
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from statistics import mean, stdev
from typing import Any

from .models import ENGINE_VERSION
from .quantitative import Geometry
from .research_channels import channel_metadata, validate_declarations
from .research_data_export import _artifacts, _references, _review_record, _safe
from .research_data_tables import _finite_tree, _metric_value, _raw_rows, inspect_item
from .research_population import intensity_metric_id
from .research_project import SHA_PATTERN, canonical_json, checked_id, checked_text, timestamp
from .research_review import LEGACY_KEYS, REVIEW_SCHEMA, review_sha256, validate_review
from .study_analysis import validate_sample_metadata
from .working_result import _sha256_file_stable

REPORT_SCHEMA = "loci.experiment-intensity-report/v1"
ENDPOINT_SCHEMA = "loci.intensity-endpoint/v1"
MAX_RESULTS = 100
MAX_OBJECTS = 50_000
MAX_REPORT_BYTES = 8 * 1024**2
COMPARTMENTS = {"object", "cell", "nuclear", "cytoplasm"}
AGGREGATION = {
    "object_to_image": "equal weight of finite stored object means",
    "image_to_replicate": (
        "equal weight of valid image means within (condition, biological_replicate)"
    ),
    "replicate_to_condition": "equal weight of valid declared replicate means",
    "sd": "descriptive sample SD of valid replicate means; ddof=1; null below two",
    "missing_replicate": "unassigned; excluded from condition estimates",
    "review": "reviewed contributes; excluded is audit only; pending blocks",
    "interpretation": "raw source-intensity; no calibration or biological independence established",
}
_ACQUISITION_FIELDS = ("exposure_time", "gain", "laser_power", "detector", "bit_depth")
_REPORT_FIELDS = {
    "schema",
    "created_at",
    "software",
    "endpoint",
    "declaration",
    "result_ids",
    "bindings",
    "observations",
    "images",
    "replicates",
    "conditions",
    "audit",
    "aggregation",
    "report_hash",
}


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


@lru_cache(maxsize=1)
def _software() -> dict:
    if getattr(sys, "frozen", False):
        digest, _ = _sha256_file_stable(Path(sys.executable), reject_symlink=True)
        implementation = {"kind": "frozen-executable-sha256", "sha256": digest}
    else:
        modules = {}
        for name in (
            "experiment_intensity.py",
            "research_data_tables.py",
            "research_population.py",
        ):
            digest, _ = _sha256_file_stable(Path(__file__).with_name(name), reject_symlink=True)
            modules[name] = digest
        implementation = {"kind": "source-modules-sha256", "sha256": _hash(modules)}
    return {"engine": ENGINE_VERSION, "implementation": implementation}


def _review_snapshot(value: Any, identity: str, revision_hash: str) -> None:
    if not isinstance(value, dict):
        raise ValueError("Invalid minimized review snapshot")
    keys = set(LEGACY_KEYS)
    if "schema" in value:
        keys |= {"schema", "event_id", "identity_assurance", "previous_review_sha256"}
        if "authority" in value:
            keys.add("authority")
        if value["schema"] != REVIEW_SCHEMA or value.get("identity_assurance") != "declared":
            raise ValueError("Unsupported minimized review snapshot")
        checked_id(value.get("event_id"))
        previous = value.get("previous_review_sha256")
        if previous is not None and (
            not isinstance(previous, str) or not SHA_PATTERN.fullmatch(previous)
        ):
            raise ValueError("Invalid previous review identity")
    _exact(value, keys, "minimized review snapshot")
    if (
        value["result_id"] != identity
        or value["revision_hash"] != revision_hash
        or value["disposition"] not in {"reviewed", "excluded"}
        or value["actor"] not in {"human", "agent"}
    ):
        raise ValueError("Intensity report review binding mismatch")
    checked_text(value["reviewed_at"], "Review time", 128)
    if value["actor"] == "agent":
        authority = value.get("authority")
        _exact(authority, {"kind", "policy_sha256", "delegation_id"}, "review authority")
        if (
            authority["kind"] != "policy-delegation"
            or not isinstance(authority["policy_sha256"], str)
            or not SHA_PATTERN.fullmatch(authority["policy_sha256"])
        ):
            raise ValueError("Invalid review authority")
        checked_id(authority["delegation_id"])
    elif "authority" in value:
        raise ValueError("Human review cannot claim agent delegation")


def report_hash(report: dict) -> str:
    """Bind every field except the content-hash field itself."""
    return _hash({key: value for key, value in report.items() if key != "report_hash"})


def _exact(value: Any, fields: set[str], name: str) -> None:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"Invalid {name}: exactly the declared fields are required")


def _ids(value: Any) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_RESULTS:
        raise ValueError("Choose between 1 and 100 exact v1 result revisions")
    for identity in value:
        checked_id(identity)
    if len(set(value)) != len(value):
        raise ValueError("Duplicate exact result revisions are not allowed")
    return value


def _endpoint(value: Any) -> dict:
    _exact(value, {"schema", "kind", "statistic", "unit", "compartment"}, "intensity endpoint")
    if (
        value["schema"] != ENDPOINT_SCHEMA
        or value["kind"] != "raw-channel-intensity"
        or value["statistic"] != "mean"
        or value["unit"] != "source-intensity"
        or value["compartment"] not in COMPARTMENTS
    ):
        raise ValueError("Only typed raw-channel source-intensity mean endpoints are supported")
    return copy.deepcopy(value)


def _declaration(value: Any) -> dict:
    _exact(value, {"channel", "acquisition_context", "rationale"}, "comparability declaration")
    return {
        key: checked_text(value[key], f"Comparability {key}", 2048 if key != "channel" else 256)
        for key in ("channel", "acquisition_context", "rationale")
    }


def _mean(values: list) -> float | None:
    if not values:
        return None
    try:
        result = float(mean(values))
    except (OverflowError, ValueError) as exc:
        raise ValueError("Intensity aggregation overflow") from exc
    if not math.isfinite(result):
        raise ValueError("Intensity aggregation overflow")
    return result


def _sd(values: list) -> float | None:
    if len(values) < 2:
        return None
    try:
        result = stdev(values)
    except (OverflowError, ValueError) as exc:
        raise ValueError("Intensity SD overflow") from exc
    if not math.isfinite(result):
        raise ValueError("Intensity SD overflow")
    return result


def _mean_descriptor(value: Any, endpoint: dict | None = None) -> bool:
    if not isinstance(value, dict):
        return False
    keys = {"id", "label", "kind", "unit", "channel", "statistic"}
    if "compartment" in value:
        keys.add("compartment")
    channel, compartment = value.get("channel"), value.get("compartment", "object")
    if (
        set(value) != keys
        or not isinstance(channel, str)
        or not channel
        or not isinstance(compartment, str)
        or compartment not in COMPARTMENTS
    ):
        return False
    identity = intensity_metric_id(channel, "mean")
    if compartment != "object":
        identity = f"compartment:{compartment}:{identity}"
    return (
        value.get("id") == identity
        and value.get("kind") == "intensity"
        and value.get("statistic") == "mean"
        and value.get("unit") == "source-intensity"
        and isinstance(value.get("label"), str)
        and (endpoint is None or compartment == endpoint["compartment"])
    )


def _method(provenance: dict) -> dict:
    """Separate producing settings from per-image segmentation outcomes/locators."""
    method = {}
    recipe = provenance.get("recipe")
    if isinstance(recipe, dict):
        method["recipe"] = {
            key: value
            for key, value in recipe.items()
            if key not in {"working_bytes", "references", "measurement_channels"}
        }
        if recipe.get("references"):
            # Reference identities are retained in the verified references receipt.
            method["reference_roles"] = sorted(recipe["references"])
    for key in (
        "processing",
        "segmentation",
        "model",
        "resolved_settings",
        "model_settings",
        "settings",
        "puncta",
        "tissue",
        "stain_separation",
        "input_transform",
        "source_scale",
        "preprocessing",
        "tiling",
        "package_postprocessing",
        "channel_mapping",
        "runtime",
    ):
        if key in provenance:
            value = provenance[key]
            if isinstance(value, dict):
                value = {
                    k: v
                    for k, v in value.items()
                    if k
                    not in {
                        "count",
                        "confluence_percent",
                        "summary",
                        "object_count",
                        "candidate_count",
                        "accepted_count",
                        "peaks",
                        "rows",
                        "elapsed_s",
                        "elapsed_time_s",
                    }
                }
            method[key] = value
    if isinstance(provenance.get("compartment_measurement"), dict):
        method["compartment_measurement"] = {
            key: provenance["compartment_measurement"].get(key)
            for key in ("schema_version", "basis", "partition", "empty_policy", "conservation")
        }
    if not method:
        raise ValueError("Intensity comparison requires verified producer method/settings")
    _finite_tree(method)
    return {"sha256": _hash(method), "settings": _safe(method)}


def _producer_input_channel(result: dict, source: dict) -> dict:
    provenance = result["provenance"]
    declared = provenance.get("channel_metadata")
    _validate_source_channels(declared, source)
    index = provenance.get("selection", {}).get("c")
    records = declared["channels"]
    if type(index) is not int or not 0 <= index < len(records):
        raise ValueError("Label producer requires an explicit producing input channel")
    dtypes = source.get("metadata", {}).get("channel_dtypes", [])

    def descriptor(channel):
        if type(channel) is not int or not 0 <= channel < len(records):
            raise ValueError("Label producer input channel is absent from its exact declarations")
        return {
            "index": channel,
            "original_name": declared["original_names"][channel],
            "metadata": records[channel],
            "dtype": dtypes[channel] if channel < len(dtypes) else None,
        }

    output = {**descriptor(index), "model_inputs": None}
    if "channel_mapping" in provenance:
        mapping = provenance.get("channel_mapping")
        if not isinstance(mapping, list) or not 1 <= len(mapping) <= 256:
            raise ValueError(
                "Model label producer requires explicit complete input channel mapping"
            )
        inputs = []
        for position, item in enumerate(mapping):
            _exact(
                item,
                {"model_input_index", "model_channel", "package_source_slot", "source_channel"},
                "model input mapping",
            )
            if (
                item["model_input_index"] != position
                or type(item["package_source_slot"]) is not int
                or item["package_source_slot"] < 0
            ):
                raise ValueError("Invalid model producing input channel order")
            checked_text(item["model_channel"], "Model input channel", 256)
            inputs.append(
                {
                    "model_input_index": position,
                    "model_channel": item["model_channel"],
                    "package_source_slot": item["package_source_slot"],
                    "channel": descriptor(item["source_channel"]),
                }
            )
        output["model_inputs"] = inputs
    return output


def _producer_scope(result: dict, source: dict) -> dict:
    """Normalize verifiable label-production evidence, without per-source IDs."""
    provenance = result["provenance"]
    recipe = provenance.get("recipe")
    executed = provenance.get("segmentation")
    if isinstance(recipe, dict):
        segmentation = recipe.get("segmentation")
        if (
            not isinstance(segmentation, dict)
            or segmentation.get("method") not in {"components", "watershed"}
            or not isinstance(executed, dict)
            or executed.get("method") != segmentation["method"]
        ):
            raise ValueError("Unsupported or missing exact label-producing recipe/method evidence")
    elif isinstance(provenance.get("model"), dict):
        if not provenance["model"] or not all(
            isinstance(provenance.get(key), dict)
            for key in (
                "source_scale",
                "preprocessing",
                "tiling",
                "package_postprocessing",
                "segmentation",
            )
        ):
            raise ValueError("Unsupported or missing model label-producer settings evidence")
    else:
        raise ValueError("Unsupported or missing label-producing method evidence")
    geometry, selection = provenance.get("geometry"), provenance.get("selection")
    if not isinstance(geometry, dict) or not isinstance(selection, dict):
        raise ValueError("Label producer requires explicit geometry and full input selection")
    return {
        "kind": result["kind"],
        "engine_version": result["engine_version"],
        "method": _method(provenance),
        "selection": copy.deepcopy(selection),
        "geometry": copy.deepcopy(geometry),
        "shape": result.get("arrays", {}).get("labels", {}).get("shape"),
        "input_channel": _producer_input_channel(result, source),
    }


def _label_producers(result: dict, get_result, get_source) -> tuple[dict | None, dict | None]:
    """Use original compartment label inputs, never later association metadata."""
    compartment = result["provenance"].get("compartment_measurement")
    if compartment is None:
        return None, None
    if not isinstance(compartment, dict):
        raise ValueError("Missing compartment label-producer evidence")
    original = compartment.get("label_inputs")
    _exact(original, {"cells", "nuclei"}, "original compartment label inputs")
    bindings, scopes = {}, {}
    for role in ("cells", "nuclei"):
        reference = original[role]
        _exact(
            reference,
            {
                "result_id",
                "revision_hash",
                "source_id",
                "source_sha256",
                "arrays",
                "geometry",
                "selection",
            },
            "exact compartment label input",
        )
        checked_id(reference["result_id"])
        parent = get_result(reference["result_id"])
        source = get_source(reference["source_id"])
        if not isinstance(parent, dict) or not isinstance(source, dict):
            raise ValueError("Retained exact compartment label producer is unavailable")
        if (
            parent.get("schema") != "loci.research-result/v1"
            or parent.get("id") != reference["result_id"]
            or source.get("id") != reference["source_id"]
            or source.get("sha256") != reference["source_sha256"]
            or any(
                parent.get(key) != reference[key]
                for key in ("revision_hash", "source_id", "source_sha256", "arrays")
            )
            or parent.get("provenance", {}).get("geometry") != reference["geometry"]
            or parent.get("provenance", {}).get("selection") != reference["selection"]
        ):
            raise ValueError(
                "Compartment label-producer exact dependency binding is stale or forged"
            )
        if (
            _hash({key: value for key, value in parent.items() if key != "revision_hash"})
            != parent["revision_hash"]
        ):
            raise ValueError("Compartment label-producer revision checksum mismatch")
        bindings[role] = {
            key: reference[key]
            for key in ("result_id", "revision_hash", "source_id", "source_sha256")
        }
        bindings[role]["provenance_sha256"] = _hash(parent["provenance"])
        scopes[role] = _producer_scope(parent, source)
        measured = compartment.get("channel_metadata")
        _validate_source_channels(measured, source)
        _validate_channel_epochs(
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "producing_channels": parent["provenance"]["channel_metadata"],
                "channels": measured,
            }
        )
    return bindings, scopes


def _scope(result: dict, source: dict, label_producers: dict | None = None) -> dict:
    provenance = result["provenance"]
    geometry, selection = provenance.get("geometry"), provenance.get("selection")
    if not isinstance(geometry, dict) or geometry.get("axes") not in {"YX", "ZYX"}:
        raise ValueError("Intensity comparison requires explicit measurement dimensions")
    if not isinstance(selection, dict):
        raise ValueError("Intensity comparison requires explicit acquisition/run selection")
    basis = provenance.get("measurement_basis")
    if isinstance(provenance.get("compartment_measurement"), dict):
        basis = provenance["compartment_measurement"].get("basis")
    if not isinstance(basis, str) or not basis.startswith("raw"):
        raise ValueError("Only measurements bound to raw source-channel intensity are supported")
    shape = result.get("arrays", {}).get("labels", {}).get("shape")
    if not isinstance(shape, list) or len(shape) != len(geometry["axes"]):
        raise ValueError("Intensity comparison label dimensions disagree with run scope")
    compartment = provenance.get("compartment_measurement")
    partition = None
    if compartment is not None:
        partition = {
            key: compartment.get(key)
            for key in (
                "schema_version",
                "basis",
                "partition",
                "empty_policy",
                "conservation",
                "association_independent",
            )
        }
    metadata = source.get("metadata", {}) if source is not None else {}
    acquisition = {
        key: provenance.get(key, metadata.get(key))
        for key in _ACQUISITION_FIELDS
        if key in provenance or key in metadata
    }
    if "channel_dtypes" in metadata:
        acquisition["channel_dtypes"] = metadata["channel_dtypes"]
    return {
        "method": _method(provenance),
        "producer_engine": result.get("engine_version"),
        "measurement_basis": basis,
        "geometry": geometry,
        "shape": shape,
        "selection": copy.deepcopy(selection),
        "input_channel": _producer_input_channel(result, source),
        "label_producers": label_producers,
        "partition": partition,
        "acquisition": {
            "recorded": acquisition,
            "unavailable": [key for key in _ACQUISITION_FIELDS if key not in acquisition],
        },
    }


def _validate_grid(geometry: dict, shape: list, selection: dict) -> None:
    _exact(geometry, {"axes", "affine", "unit", "frame"}, "measurement geometry")
    Geometry(geometry["axes"], geometry["affine"], geometry["unit"], geometry["frame"])
    if (
        not isinstance(shape, list)
        or len(shape) != len(geometry["axes"])
        or any(type(extent) is not int or not 1 <= extent <= 2**53 for extent in shape)
    ):
        raise ValueError("Invalid saved intensity dimensions")
    if (
        not isinstance(selection, dict)
        or set(selection)
        - {"x", "y", "width", "height", "t", "c", "z", "z_stop", "level", "elapsed_time_s"}
        or not {"x", "y", "width", "height", "t", "c", "z", "level"} <= set(selection)
    ):
        raise ValueError("Invalid saved intensity acquisition/run selection")
    for key, value in selection.items():
        if key == "elapsed_time_s":
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                raise ValueError("Invalid saved run timing")
        elif type(value) is not int or value < 0:
            raise ValueError("Invalid saved run index/dimension")
    if selection["width"] != shape[-1] or selection["height"] != shape[-2]:
        raise ValueError("Intensity run dimensions disagree with label grid")


def _validate_input_channel(record: dict, expected_index: int) -> None:
    def descriptor(value):
        _exact(
            value, {"index", "original_name", "metadata", "dtype"}, "producing channel descriptor"
        )
        if type(value["index"]) is not int or not 0 <= value["index"] < 256:
            raise ValueError("Invalid producing channel index")
        checked_text(value["original_name"], "Original producing channel name", 256)
        if value["dtype"] is not None:
            checked_text(value["dtype"], "Producing channel dtype", 64)
        metadata = value["metadata"]
        _exact(
            metadata,
            {"index", "name", "marker", "fluorophore", "declaration"},
            "producing input metadata",
        )
        if metadata["index"] != value["index"]:
            raise ValueError("Producing channel metadata index mismatch")
        checked_text(metadata["name"], "Producing channel name", 256)
        for key in ("marker", "fluorophore", "declaration"):
            checked_text(metadata[key], "Producing channel " + key, 1024, empty=True)

    _exact(
        record,
        {"index", "original_name", "metadata", "dtype", "model_inputs"},
        "producing input channel",
    )
    descriptor({key: value for key, value in record.items() if key != "model_inputs"})
    if record["index"] != expected_index:
        raise ValueError(
            "Producing input channel disagrees with the full selected acquisition scope"
        )
    inputs = record["model_inputs"]
    if inputs is not None:
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= 256:
            raise ValueError("Invalid bounded model producing inputs")
        for index, entry in enumerate(inputs):
            _exact(
                entry,
                {"model_input_index", "model_channel", "package_source_slot", "channel"},
                "model producing input",
            )
            if (
                entry["model_input_index"] != index
                or type(entry["package_source_slot"]) is not int
                or entry["package_source_slot"] < 0
            ):
                raise ValueError("Invalid model producing channel order")
            checked_text(entry["model_channel"], "Model producing channel", 256)
            descriptor(entry["channel"])


def _validate_producer_scope(scope: dict) -> None:
    _exact(
        scope,
        {"kind", "engine_version", "method", "selection", "geometry", "shape", "input_channel"},
        "label-producer scope",
    )
    checked_text(scope["kind"], "Label producer kind", 64)
    checked_text(scope["engine_version"], "Label producer engine", 64)
    _exact(scope["method"], {"sha256", "settings"}, "label-producer method")
    if (
        not isinstance(scope["method"]["sha256"], str)
        or not SHA_PATTERN.fullmatch(scope["method"]["sha256"])
        or not isinstance(scope["method"]["settings"], dict)
    ):
        raise ValueError("Invalid label-producer method identity")
    _validate_grid(scope["geometry"], scope["shape"], scope["selection"])
    _validate_input_channel(scope["input_channel"], scope["selection"]["c"])


def _validate_scope(scope: dict) -> None:
    _exact(
        scope,
        {
            "method",
            "producer_engine",
            "measurement_basis",
            "geometry",
            "shape",
            "selection",
            "input_channel",
            "label_producers",
            "partition",
            "acquisition",
        },
        "report scope",
    )
    checked_text(scope["producer_engine"], "Producing engine version", 64)
    checked_text(scope["measurement_basis"], "Raw measurement basis", 512)
    if not scope["measurement_basis"].startswith("raw"):
        raise ValueError("Unsupported raw intensity measurement basis")
    _exact(scope["method"], {"sha256", "settings"}, "producer method")
    if (
        not isinstance(scope["method"]["sha256"], str)
        or not SHA_PATTERN.fullmatch(scope["method"]["sha256"])
        or not isinstance(scope["method"]["settings"], dict)
    ):
        raise ValueError("Invalid producer method settings")
    _validate_grid(scope["geometry"], scope["shape"], scope["selection"])
    _validate_input_channel(scope["input_channel"], scope["selection"]["c"])
    labels = scope["label_producers"]
    if scope["partition"] is None:
        if labels is not None:
            raise ValueError("Unexpected label producers without compartment measurements")
    else:
        _exact(labels, {"cells", "nuclei"}, "role-keyed label-producing scopes")
        for producer in labels.values():
            _validate_producer_scope(producer)
    acquisition = scope["acquisition"]
    _exact(acquisition, {"recorded", "unavailable"}, "acquisition evidence")
    if not isinstance(acquisition["recorded"], dict) or set(acquisition["recorded"]) - {
        *_ACQUISITION_FIELDS,
        "channel_dtypes",
    }:
        raise ValueError("Invalid recorded acquisition evidence")
    if acquisition["unavailable"] != [
        key for key in _ACQUISITION_FIELDS if key not in acquisition["recorded"]
    ]:
        raise ValueError("Missing acquisition settings must remain explicitly unavailable")


def _validate_channels(record: dict, source_id: str, source_sha256: str) -> None:
    _exact(
        record,
        {"source_id", "source_sha256", "original_names", "revision", "channels", "basis"},
        "channel snapshot",
    )
    if record["source_id"] != source_id or record["source_sha256"] != source_sha256:
        raise ValueError("Intensity channel/source binding mismatch")
    if (
        type(record["revision"]) is not int
        or record["revision"] < 0
        or not isinstance(record["original_names"], list)
        or any(not isinstance(name, str) or not name for name in record["original_names"])
    ):
        raise ValueError("Invalid channel snapshot revision/names")
    validate_declarations(record["channels"], len(record["original_names"]))
    checked_text(record["basis"], "Channel declaration basis", 256)


def _validate_source_channels(record: dict, source: dict) -> None:
    _validate_channels(record, source["id"], source["sha256"])
    original = list(source.get("metadata", {}).get("channel_names") or ["Intensity"])
    if record["original_names"] != original:
        raise ValueError("Intensity channel snapshot disagrees with acquisition channel names")


def _validate_channel_epochs(binding: dict) -> None:
    """Declarations can change across epochs, never within one exact revision."""
    snapshots = [binding["producing_channels"]]
    if "measurement_channel_metadata" in binding:
        snapshots.append(binding["measurement_channel_metadata"])
    snapshots.append(binding["channels"])
    for snapshot in snapshots:
        _validate_channels(snapshot, binding["source_id"], binding["source_sha256"])
        if snapshot["original_names"] != snapshots[0]["original_names"]:
            raise ValueError("Intensity channel snapshots disagree on acquisition names")
    for earlier, later in zip(snapshots, snapshots[1:], strict=False):
        if earlier["revision"] > later["revision"] or (
            earlier["revision"] == later["revision"] and earlier != later
        ):
            raise ValueError("Intensity channel declaration epochs are inconsistent")


def _binding(project: Any, result: dict, inspection: dict, check=None) -> dict:
    source = project.source(result["source_id"], verify=True, check=check)
    if source["sha256"] != result["source_sha256"]:
        raise ValueError("Intensity result/source binding is stale")
    _artifacts(project, result, check)
    references = _references(project, result, check)
    sample = next((doc for doc in project.documents("sample") if doc["id"] == source["id"]), None)
    metadata = validate_sample_metadata(sample["data"]).to_dict() if sample else None
    review = project.review_state(result["id"], check=check)
    if review is not None:
        validate_review(review, result_id=result["id"], revision_hash=result["revision_hash"])
    channels = channel_metadata(project, source["id"])
    producing_channels = result["provenance"].get("channel_metadata")
    if not isinstance(producing_channels, dict):
        raise ValueError("Intensity comparison requires producing channel bindings")
    if (
        producing_channels.get("source_id") != source["id"]
        or producing_channels.get("source_sha256") != source["sha256"]
    ):
        raise ValueError("Intensity producing channel/source binding is stale")
    public_source = {
        key: source[key]
        for key in ("id", "sha256", "name", "size_bytes", "source_kind")
        if key in source
    }
    # Do not include source.metadata: it may contain private vendor metadata.
    label_inputs, label_scopes = _label_producers(
        result,
        lambda identity: project.result(identity, check=check),
        lambda identity: project.source(identity),
    )
    binding = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "source": public_source,
        "review": _review_record(review),
        "review_sha256": review_sha256(review),
        "sample_document": {"revision": sample["revision"], "data": metadata} if sample else None,
        "channels": channels,
        "producing_channels": producing_channels,
        "scope": _scope(result, source, label_scopes),
        "label_inputs": label_inputs,
        "provenance_sha256": _hash(result["provenance"]),
        "row_sha256": inspection["row_sha256"],
        "object_count": inspection["total_count"],
        "references": references,
    }
    _validate_channel_epochs(binding)
    return binding


def _catalog(project: Any, result_ids: Any, check=None) -> tuple[dict, list[dict]]:
    identities = _ids(result_ids)
    entries, results, sources = [], [], set()
    total = 0
    for identity in identities:
        if check:
            check()
        result = project.result(identity, check=check)
        if result.get("schema") != "loci.research-result/v1":
            raise ValueError(
                "Experiment intensity supports bounded v1 results only; v2 is unsupported"
            )
        if result["source_id"] in sources:
            raise ValueError("Choose only one exact result revision per source")
        sources.add(result["source_id"])
        rows = result.get("provenance", {}).get("measurements")
        if not isinstance(rows, list):
            raise ValueError("Intensity comparison requires actual stored object measurements")
        total += len(rows)
        if total > MAX_OBJECTS:
            raise ValueError("Experiment intensity supports at most 50000 total objects")
        inspection = inspect_item(project, {"result": result}, check=check)
        binding = _binding(project, result, inspection, check)
        entries.append(
            {
                "result_id": identity,
                "revision_hash": result["revision_hash"],
                "source_id": result["source_id"],
                "name": binding["source"].get("name", identity),
                "review_status": binding["review"]["disposition"]
                if binding["review"]
                else "pending",
                "descriptors": [d for d in inspection["descriptors"] if _mean_descriptor(d)],
                "binding": binding,
            }
        )
        results.append(result)
    return {"schema": "loci.experiment-intensity-catalog/v1", "results": entries}, results


def catalog(project: Any, result_ids: Any, check=None) -> dict:
    """Offer only actual raw mean descriptors for exact, byte-verified results."""
    output, _ = _catalog(project, result_ids, check)
    _finite_tree(output)
    if len(canonical_json(output).encode()) > MAX_REPORT_BYTES:
        raise ValueError("Intensity catalog exceeds 8 MiB")
    return copy.deepcopy(output)


def _object_channel(provenance: dict, descriptor: dict, producing_channels: dict) -> dict:
    recorded = producing_channels.get("channels", [])
    measured = provenance.get("recipe", {}).get("measurement_channels")
    if measured is None:
        measured = provenance.get("measurement_channels")
    if not isinstance(measured, list):
        raise ValueError("Raw object channel lacks explicit measured acquisition indices")
    candidates = []
    for index in measured:
        if type(index) is not int or not 0 <= index < len(recorded):
            raise ValueError("Raw object channel lacks a producing acquisition index")
        name = (
            f"source_channel_{index}"
            if "model" in provenance
            else f"{index + 1}: {recorded[index]['name']}"
        )
        if name == descriptor["channel"]:
            candidates.append({"index": index, "name": name})
    if len(candidates) != 1:
        raise ValueError("Raw object channel has no unique actual producer binding")
    return candidates[0]


def _channel_binding(binding: dict, descriptor: dict, endpoint: dict) -> dict:
    """Resolve a literal recorded key; no dotted strings or display-name guesses."""
    scope = binding["scope"]
    if endpoint["compartment"] != "object":
        partition = scope["partition"]
        expected = {
            "cell": "cells == cell_id",
            "nuclear": "(cells == cell_id) & (nuclei > 0)",
            "cytoplasm": "(cells == cell_id) & (nuclei == 0)",
        }
        if (
            not isinstance(partition, dict)
            or partition.get("schema_version") != 1
            or partition.get("partition") != expected
        ):
            raise ValueError(
                "Intensity comparison requires the explicit supported compartment partition"
            )
        candidates = binding.get("compartment_channels", [])
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 256:
            raise ValueError("Missing or ambiguous raw compartment channel binding")
        producing = binding.get("measurement_channel_metadata", binding["producing_channels"])
        _validate_channels(producing, binding["source_id"], binding["source_sha256"])
        indices = set()
        for item in candidates:
            _exact(
                item,
                {"index", "name", "source_id", "source_sha256", "selection", "geometry"},
                "compartment channel binding",
            )
            index = item["index"]
            if (
                type(index) is not int
                or not 0 <= index < len(producing["channels"])
                or index in indices
                or item["source_id"] != binding["source_id"]
                or item["source_sha256"] != binding["source_sha256"]
                or item["name"] != f"{index + 1}: {producing['channels'][index]['name']}"
            ):
                raise ValueError("Compartment literal channel/measurement metadata mismatch")
            indices.add(index)
            if item["geometry"] != scope["geometry"] or item["selection"] != {
                **scope["selection"],
                "c": index,
            }:
                raise ValueError("Compartment channel measurement grid/selection mismatch")
        candidates = [item for item in candidates if item.get("name") == descriptor["channel"]]
        if len(candidates) != 1:
            raise ValueError("Missing or ambiguous raw compartment channel binding")
        chosen = candidates[0]
        if (
            chosen.get("source_id") != binding["source_id"]
            or chosen.get("source_sha256") != binding["source_sha256"]
        ):
            raise ValueError("Compartment channel/source binding is stale")
        index = chosen.get("index")
    else:
        producing = binding["producing_channels"]
        chosen = binding.get("object_channel")
        if not isinstance(chosen, dict) or chosen.get("name") != descriptor["channel"]:
            raise ValueError("Missing actual raw object channel binding")
        index = chosen.get("index")
    recorded = producing.get("channels")
    if (
        type(index) is not int
        or not isinstance(recorded, list)
        or not 0 <= index < len(recorded)
        or recorded[index].get("index") != index
    ):
        raise ValueError("Raw channel index is absent from producing channel metadata")
    return {"key": descriptor["channel"], "index": index, "metadata": recorded[index]}


def _summaries(bindings: list[dict], observations: list[dict]) -> tuple[list, list, list, list]:
    by_result = defaultdict(list)
    for observation in observations:
        by_result[observation["result_id"]].append(observation)
    images, audit = [], []
    groups = defaultdict(list)
    condition_images = defaultdict(list)
    for binding in bindings:
        metadata = binding["sample_document"]["data"]
        rows = by_result[binding["result_id"]]
        values = [row["value"] for row in rows if row["status"] == "value"]
        excluded = binding["review"]["disposition"] == "excluded"
        reason = (
            "excluded-by-review"
            if excluded
            else "no-valid-object-means"
            if not values
            else "missing-biological-replicate"
            if metadata["biological_replicate"] is None
            else "included"
        )
        image = {
            "result_id": binding["result_id"],
            "revision_hash": binding["revision_hash"],
            "source_id": binding["source_id"],
            **metadata,
            "object_count": len(rows),
            "valid_object_count": len(values),
            "missing_object_count": sum(row["status"] == "missing" for row in rows),
            "null_object_count": sum(row["status"] == "null" for row in rows),
            "mean": None if excluded else _mean(values),
            "included": not excluded,
            "reason": reason,
        }
        images.append(image)
        audit.append(
            {
                "result_id": binding["result_id"],
                "source_id": binding["source_id"],
                "review_disposition": binding["review"]["disposition"],
                "reason": reason,
                "contributes_to_condition": reason == "included",
            }
        )
        if not excluded:
            condition_images[metadata["condition"]].append(image)
            if metadata["biological_replicate"] is not None:
                groups[(metadata["condition"], metadata["biological_replicate"])].append(image)
    replicates = []
    for (condition, replicate), rows in sorted(groups.items()):
        values = [row["mean"] for row in rows if row["mean"] is not None]
        replicates.append(
            {
                "condition": condition,
                "biological_replicate": replicate,
                "result_ids": [row["result_id"] for row in rows],
                "image_count": len(rows),
                "valid_image_count": len(values),
                "object_count": sum(row["object_count"] for row in rows),
                "valid_object_count": sum(row["valid_object_count"] for row in rows),
                "mean": _mean(values),
            }
        )
    conditions = []
    # Retain conditions with only excluded images as zero-contributor audit rows.
    for condition in sorted(
        {binding["sample_document"]["data"]["condition"] for binding in bindings}
    ):
        rows = condition_images[condition]
        declared = [row for row in replicates if row["condition"] == condition]
        values = [row["mean"] for row in declared if row["mean"] is not None]
        conditions.append(
            {
                "condition": condition,
                "image_count": len(rows),
                "valid_image_count": sum(row["mean"] is not None for row in rows),
                "unassigned_image_count": sum(row["biological_replicate"] is None for row in rows),
                "object_count": sum(row["object_count"] for row in rows),
                "valid_object_count": sum(row["valid_object_count"] for row in rows),
                "declared_replicate_count": len(declared),
                "valid_replicate_count": len(values),
                "mean": _mean(values),
                "sd": _sd(values),
            }
        )
    return images, replicates, conditions, audit


def _preview(project: Any, request: Any, check=None) -> dict:
    """Create a complete candidate immutable report from exact stored observations."""
    _exact(
        request,
        {"result_ids", "endpoint", "metric_ids", "declaration"},
        "intensity preview request",
    )
    endpoint, declaration = _endpoint(request["endpoint"]), _declaration(request["declaration"])
    identities = _ids(request["result_ids"])
    metric_ids = request["metric_ids"]
    _exact(metric_ids, set(identities), "per-result literal metric mapping")
    listing, results = _catalog(project, identities, check)
    bindings, observations = [], []
    for entry, result in zip(listing["results"], results, strict=True):
        binding = entry["binding"]
        if entry["review_status"] not in {"reviewed", "excluded"}:
            raise ValueError("Review each exact selected result; pending review blocks comparison")
        if binding["sample_document"] is None:
            raise ValueError("Assign study/sample/condition metadata to every selected source")
        descriptor = next(
            (d for d in entry["descriptors"] if d["id"] == metric_ids[result["id"]]), None
        )
        if not _mean_descriptor(descriptor, endpoint):
            raise ValueError(
                "Selected endpoint is not an actual typed mean descriptor in this result"
            )
        provenance = result["provenance"]
        if endpoint["compartment"] == "object":
            binding["object_channel"] = _object_channel(
                provenance, descriptor, binding["producing_channels"]
            )
        else:
            compartment = provenance.get("compartment_measurement", {})
            binding["compartment_channels"] = compartment.get("channels", [])
            binding["measurement_channel_metadata"] = compartment.get("channel_metadata")
            _validate_channel_epochs(binding)
        binding["descriptor"] = descriptor
        binding["channel"] = _channel_binding(binding, descriptor, endpoint)
        for row in _raw_rows(project, {"result": result}, check):
            value, status = _metric_value(row, descriptor)
            observations.append(
                {"result_id": result["id"], "label": row["label"], "value": value, "status": status}
            )
        bindings.append(binding)
    report = {
        "schema": REPORT_SCHEMA,
        "created_at": timestamp(),
        "software": _software(),
        "endpoint": endpoint,
        "declaration": declaration,
        "result_ids": list(identities),
        "bindings": bindings,
        "observations": observations,
        "aggregation": copy.deepcopy(AGGREGATION),
    }
    report["images"], report["replicates"], report["conditions"], report["audit"] = _summaries(
        bindings, observations
    )
    report["report_hash"] = report_hash(report)
    return validate_report(report)


def _validate_report(value: Any) -> dict:
    """Fail closed on malformed/hash/numerical state; return original saved values.

    Internal hierarchy arithmetic is checked solely against the saved object
    observations. No project, new review, current masks or metadata are consulted.
    """
    _exact(value, _REPORT_FIELDS, "experiment intensity report")
    _finite_tree(value)
    try:
        encoded = canonical_json(value).encode()
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("Invalid intensity report JSON") from exc
    if len(encoded) > MAX_REPORT_BYTES:
        raise ValueError("Intensity report exceeds 8 MiB")
    if value["schema"] != REPORT_SCHEMA:
        raise ValueError("Unsupported experiment intensity report schema")
    if (
        not isinstance(value["report_hash"], str)
        or not SHA_PATTERN.fullmatch(value["report_hash"])
        or report_hash(value) != value["report_hash"]
    ):
        raise ValueError("Experiment intensity report content hash mismatch")
    checked_text(value["created_at"], "Report timestamp", 64)
    try:
        created = datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Invalid report timestamp") from exc
    if created.tzinfo is None:
        raise ValueError("Report timestamp requires a timezone")
    _exact(value["software"], {"engine", "implementation"}, "report software identity")
    implementation = value["software"]["implementation"]
    _exact(implementation, {"kind", "sha256"}, "implementation identity")
    if (
        implementation["kind"] not in {"source-modules-sha256", "frozen-executable-sha256"}
        or not isinstance(implementation["sha256"], str)
        or not SHA_PATTERN.fullmatch(implementation["sha256"])
    ):
        raise ValueError("Invalid report implementation identity")
    checked_text(value["software"]["engine"], "Engine version", 64)
    endpoint = _endpoint(value["endpoint"])
    _declaration(value["declaration"])
    identities = _ids(value["result_ids"])
    bindings = value["bindings"]
    if not isinstance(bindings, list) or len(bindings) != len(identities):
        raise ValueError("Intensity report requires each exact selected binding")
    seen_sources, scopes, studies = set(), set(), set()
    expected_count = {}
    for identity, binding in zip(identities, bindings, strict=True):
        required = {
            "result_id",
            "revision_hash",
            "source_id",
            "source_sha256",
            "source",
            "review",
            "review_sha256",
            "sample_document",
            "channels",
            "producing_channels",
            "scope",
            "provenance_sha256",
            "row_sha256",
            "object_count",
            "references",
            "label_inputs",
            "descriptor",
            "channel",
        }
        extras = (
            {"object_channel"} if endpoint["compartment"] == "object" else {"compartment_channels"}
        )
        # Existing v1 snapshots are accepted unchanged only when their retained
        # producing snapshot also describes the exact compartment measurement.
        if endpoint["compartment"] != "object" and "measurement_channel_metadata" in binding:
            extras.add("measurement_channel_metadata")
        _exact(binding, required | extras, "report result binding")
        if binding["result_id"] != identity:
            raise ValueError("Intensity report result binding/order mismatch")
        checked_id(binding["source_id"])
        if binding["source_id"] in seen_sources:
            raise ValueError("Duplicate source in intensity report")
        seen_sources.add(binding["source_id"])
        for field in (
            "revision_hash",
            "source_sha256",
            "provenance_sha256",
            "row_sha256",
            "review_sha256",
        ):
            if not isinstance(binding[field], str) or not SHA_PATTERN.fullmatch(binding[field]):
                raise ValueError("Invalid intensity report binding hash")
        source = binding["source"]
        if (
            not isinstance(source, dict)
            or source.get("id") != binding["source_id"]
            or source.get("sha256") != binding["source_sha256"]
            or set(source) - {"id", "sha256", "name", "size_bytes", "source_kind"}
        ):
            raise ValueError("Intensity report source binding mismatch")
        review = binding["review"]
        if (
            not isinstance(review, dict)
            or review.get("disposition") not in {"reviewed", "excluded"}
            or review.get("result_id") != identity
            or review.get("revision_hash") != binding["revision_hash"]
        ):
            raise ValueError("Intensity report review binding mismatch")
        _review_snapshot(review, identity, binding["revision_hash"])
        sample = binding["sample_document"]
        _exact(sample, {"revision", "data"}, "sample binding")
        if type(sample["revision"]) is not int or sample["revision"] < 1:
            raise ValueError("Invalid sample document revision")
        metadata = validate_sample_metadata(sample["data"]).to_dict()
        if metadata != sample["data"]:
            raise ValueError("Report sample metadata is not complete")
        studies.add(metadata["study"])
        _validate_channel_epochs(binding)
        if not _mean_descriptor(binding["descriptor"], endpoint):
            raise ValueError("Invalid saved report mean descriptor")
        if _channel_binding(binding, binding["descriptor"], endpoint) != binding["channel"]:
            raise ValueError("Intensity report literal channel mapping mismatch")
        if (
            type(binding["object_count"]) is not int
            or not 0 <= binding["object_count"] <= MAX_OBJECTS
        ):
            raise ValueError("Invalid bounded intensity object count")
        expected_count[identity] = binding["object_count"]
        refs = binding["references"]
        if not isinstance(refs, list) or len(refs) > 10016:
            raise ValueError("Invalid bounded intensity references")
        for ref in refs:
            if not isinstance(ref, dict) or set(ref) not in (
                {"source_id", "source_sha256"},
                {"result_id", "revision_hash", "source_sha256"},
            ):
                raise ValueError("Invalid intensity reference fields")
            checked_id(ref.get("source_id", ref.get("result_id")))
            for field in ("source_sha256", "revision_hash"):
                if field in ref and (
                    not isinstance(ref[field], str) or not SHA_PATTERN.fullmatch(ref[field])
                ):
                    raise ValueError("Invalid intensity reference fingerprint")
        scope = binding["scope"]
        _validate_scope(scope)
        inputs = binding["label_inputs"]
        if scope["partition"] is None:
            if inputs is not None:
                raise ValueError("Unexpected compartment label-input bindings")
        else:
            _exact(inputs, {"cells", "nuclei"}, "role-keyed exact label-input bindings")
            for parent in inputs.values():
                _exact(
                    parent,
                    {
                        "result_id",
                        "revision_hash",
                        "source_id",
                        "source_sha256",
                        "provenance_sha256",
                    },
                    "exact label-input binding",
                )
                checked_id(parent["result_id"])
                checked_id(parent["source_id"])
                for field in ("revision_hash", "source_sha256", "provenance_sha256"):
                    if not isinstance(parent[field], str) or not SHA_PATTERN.fullmatch(
                        parent[field]
                    ):
                        raise ValueError("Invalid exact label-input fingerprint")
        # A declaration cannot override software-verifiable unit/method/run facts.
        scopes.add(canonical_json(scope))
    if len(studies) != 1:
        raise ValueError("Intensity comparison requires one explicit study")
    if len(scopes) != 1:
        raise ValueError(
            "Incompatible producer method, dimensions, partition or acquisition/run scope"
        )
    observations = value["observations"]
    if not isinstance(observations, list) or len(observations) > MAX_OBJECTS:
        raise ValueError("Intensity report exceeds 50000 observations")
    counts = defaultdict(int)
    seen = set()
    for row in observations:
        _exact(row, {"result_id", "label", "value", "status"}, "saved object observation")
        if (
            row["result_id"] not in expected_count
            or type(row["label"]) is not int
            or not 1 <= row["label"] <= 0xFFFFFFFF
        ):
            raise ValueError("Invalid intensity observation result/label binding")
        key = (row["result_id"], row["label"])
        if key in seen:
            raise ValueError("Duplicate intensity object observation")
        seen.add(key)
        counts[row["result_id"]] += 1
        if row["status"] not in {"value", "null", "missing"}:
            raise ValueError("Invalid intensity observation status")
        if row["status"] == "value":
            try:
                valid = type(row["value"]) in (int, float) and math.isfinite(row["value"])
            except OverflowError:
                valid = False
            if not valid:
                raise ValueError("Intensity observation must be a finite signed number")
        elif row["value"] is not None:
            raise ValueError("Missing/null intensity observations must preserve null")
    if any(counts[identity] != count for identity, count in expected_count.items()):
        raise ValueError("Intensity report object counts disagree with exact bindings")
    if value["aggregation"] != AGGREGATION:
        raise ValueError("Unsupported experiment intensity aggregation definition")
    for name, expected in zip(
        ("images", "replicates", "conditions", "audit"),
        _summaries(bindings, observations),
        strict=True,
    ):
        if canonical_json(value[name]) != canonical_json(expected):
            raise ValueError(f"Intensity report {name} contradict saved observations/bindings")
    return copy.deepcopy(value)


def current_status(project: Any, report: Any, check=None) -> dict:
    """Report current input changes separately; never mutate/recompute the report."""
    saved = validate_report(report)
    changes = []
    for binding in saved["bindings"]:
        if check:
            check()
        try:
            listing = catalog(project, [binding["result_id"]], check=check)
            current = listing["results"][0]["binding"]
            keys = (
                "revision_hash",
                "source_sha256",
                "source",
                "review",
                "review_sha256",
                "sample_document",
                "channels",
                "producing_channels",
                "scope",
                "provenance_sha256",
                "row_sha256",
                "object_count",
                "references",
                "label_inputs",
            )
            reasons = [
                key for key in keys if canonical_json(current[key]) != canonical_json(binding[key])
            ]
            if saved["endpoint"]["compartment"] != "object":
                result = project.result(binding["result_id"], check=check)
                if result["provenance"].get("compartment_measurement", {}).get(
                    "channel_metadata"
                ) != binding.get("measurement_channel_metadata", binding["producing_channels"]):
                    reasons.append("measurement_channel_metadata")
            if reasons:
                changes.append(
                    {"result_id": binding["result_id"], "reason": "changed: " + ", ".join(reasons)}
                )
        except (ValueError, OSError):
            changes.append(
                {
                    "result_id": binding["result_id"],
                    "reason": "unavailable: exact input verification failed",
                }
            )
    return {"current": not changes, "changes": changes}


def _validate_reference_snapshots(result: dict, snapshots: list) -> None:
    provenance = result["provenance"]
    expected = [
        {"source_id": value["source_id"], "source_sha256": value["source_sha256"]}
        for value in provenance.get("references", {}).values()
    ]
    parents = list(provenance.get("temporal_inputs", []))
    parents.extend(provenance.get("association_inputs", {}).values())
    parents.extend(provenance.get("compartment_measurement", {}).get("label_inputs", {}).values())
    parents.extend(
        provenance[key]
        for key in ("parent_result", "fixed_result", "moving_result")
        if key in provenance
    )
    if result.get("parent_id"):
        parents.append({"result_id": result["parent_id"]})
    for parent in parents:
        if not parent.get("missing_reason"):
            expected.append(
                {
                    key: parent[key]
                    for key in ("result_id", "revision_hash", "source_sha256")
                    if key in parent
                }
            )
    if len(expected) != len(snapshots):
        raise ValueError("Saved intensity reference count disagrees with producing provenance")
    for required, snapshot in zip(expected, snapshots, strict=True):
        if any(snapshot.get(key) != value for key, value in required.items()):
            raise ValueError("Saved intensity references disagree with producing provenance")


def validate_references(report: Any, results: dict, sources: dict) -> None:
    """Bind a saved report to retained immutable results, without current metadata.

    Native/portable readers pass already validated result/source dictionaries.
    Pixel payloads and current mutable declarations are unnecessary. Sample,
    review and channel snapshots legitimately differ from current declarations.
    """
    saved = validate_report(report)
    if not isinstance(results, dict) or not isinstance(sources, dict):
        raise ValueError("Report references require result/source identity dictionaries")
    observed = defaultdict(list)
    for observation in saved["observations"]:
        observed[observation["result_id"]].append(observation)
    for binding in saved["bindings"]:
        result, source = results.get(binding["result_id"]), sources.get(binding["source_id"])
        if not isinstance(result, dict) or not isinstance(source, dict):
            raise ValueError("Saved intensity report exact result/source reference is unavailable")
        if result.get("schema") != "loci.research-result/v1":
            raise ValueError("Saved intensity report references an unsupported result")
        for key in ("source_id", "source_sha256", "revision_hash"):
            if result.get(key) != binding[key]:
                raise ValueError("Saved intensity report exact result/source binding mismatch")
        if (
            result.get("id") != binding["result_id"]
            or source.get("id") != binding["source_id"]
            or source.get("sha256") != binding["source_sha256"]
        ):
            raise ValueError("Saved intensity report source fingerprint mismatch")
        provenance = result.get("provenance")
        if not isinstance(provenance, dict) or _hash(provenance) != binding["provenance_sha256"]:
            raise ValueError("Saved intensity report producing provenance changed")
        label_inputs, label_scopes = _label_producers(result, results.get, sources.get)
        if canonical_json(label_inputs) != canonical_json(binding["label_inputs"]):
            raise ValueError("Saved intensity report exact label-input bindings mismatch")
        if canonical_json(_scope(result, source, label_scopes)) != canonical_json(binding["scope"]):
            raise ValueError("Saved intensity report method/run scope mismatch")
        if provenance.get("channel_metadata") != binding["producing_channels"]:
            raise ValueError("Saved intensity report producing channel binding mismatch")
        _validate_source_channels(binding["producing_channels"], source)
        _validate_source_channels(binding["channels"], source)
        if saved["endpoint"]["compartment"] != "object":
            measured = binding.get("measurement_channel_metadata", binding["producing_channels"])
            _validate_source_channels(measured, source)
            if provenance.get("compartment_measurement", {}).get("channel_metadata") != measured:
                raise ValueError("Saved intensity report measurement channel binding mismatch")
        _validate_reference_snapshots(result, binding["references"])
        item = {"result": result}
        inspection = inspect_item(None, item)
        if (
            inspection["row_sha256"] != binding["row_sha256"]
            or inspection["total_count"] != binding["object_count"]
        ):
            raise ValueError("Saved intensity report stored measurement hash/count mismatch")
        if binding["descriptor"] not in inspection["descriptors"]:
            raise ValueError("Saved intensity endpoint descriptor is absent from the exact result")
        if (
            saved["endpoint"]["compartment"] == "object"
            and _object_channel(provenance, binding["descriptor"], binding["producing_channels"])
            != binding["object_channel"]
        ):
            raise ValueError("Saved intensity object channel binding changed")
        if (
            saved["endpoint"]["compartment"] != "object"
            and provenance.get("compartment_measurement", {}).get("channels")
            != binding["compartment_channels"]
        ):
            raise ValueError("Saved intensity compartment channel bindings changed")
        expected = []
        for row in _raw_rows(None, item, None):
            value, status = _metric_value(row, binding["descriptor"])
            expected.append(
                {"result_id": result["id"], "label": row["label"], "value": value, "status": status}
            )
        if canonical_json(expected) != canonical_json(observed[binding["result_id"]]):
            raise ValueError("Saved intensity observations disagree with exact stored measurements")


def validate_report(value: Any) -> dict:
    """Validate a saved snapshot and preserve its exact stored values."""
    try:
        return _validate_report(value)
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError("Malformed experiment intensity report") from exc


def preview(project: Any, request: Any, check=None) -> dict:
    """Create a bounded immutable report candidate from current exact bindings."""
    try:
        return _preview(project, request, check)
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError("Malformed experiment intensity request or stored measurement") from exc
