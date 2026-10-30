"""Immutable, exact-mask wound-area reports and native-granted atomic packages.

Specimen/sequence, filled-area meaning and elapsed seconds are declarations.
Sources, masks and transforms are never edited. The caller authorizes every
``input_result_ids`` dependency before scientific disclosure. Preview tokens are
bounded local cache receipts, never permission or portable execution authority.
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
import platform
import shutil
import stat
import sys
import uuid
from contextlib import suppress
from pathlib import Path

from .export import _rename_noreplace
from .quantitative import MAX_OBJECTS, Geometry, exact_keys, integer
from .research_data_export import (
    _DIRECTORY_FLAGS,
    _FILE_FLAGS,
    _capability,
    _destination,
    _identity,
    _verify_files,
)
from .research_project import (
    MAX_ARTIFACT_BYTES,
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
    timestamp,
    validate_source_calibration,
)
from .research_spatial_density import (
    _bindings,
    _check_binding,
    _resolve_results,
    _result_binding,
    _sample,
    _source_snapshot,
    _verify_arrays,
)
from .wound_closure import (
    FILLED_AREA,
    MAX_FRAMES,
    RULES,
    _record,
    measure_wound_closure,
)
from .wound_closure import (
    SCHEMA as KERNEL_SCHEMA,
)

SCHEMA = "loci.wound-closure-report/v1"
DOCUMENT_KIND = "wound_closure_report"
GRANT_KIND = "wound_closure_export_grant"
PREVIEW_PREFIX = "wound-closure-preview:"
MAX_REQUEST_BYTES = 1024**2
MAX_REPORT_BYTES = 12 * 1024**2
MAX_PREVIEW_BYTES = 8 * 1024**2
MAX_PREVIEWS = 8
MAX_RESULTS = 1024
MAX_PACKAGE_BYTES = 512 * 1024**2
MAX_METADATA_BYTES = 16 * 1024**2
MAX_FILES = 1024
PAGE_BYTES = 64 * 1024
TABLES = ("frames", "intervals", "inputs")
REQUEST_KEYS = {
    "frames",
    "time_s",
    "time_unit",
    "time_declaration",
    "specimen_id",
    "sequence_id",
    "area_declaration",
    "grid_declaration",
    "working_bytes",
}


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _same(a, b):
    return canonical_json(a) == canonical_json(b)


def _exact(value, keys, name):
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"{name} requires exactly the declared fields")


def _sha(value):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Wound identity requires an exact SHA-256")
    return value


def _finite(value, name):
    if type(value) not in (int, float):
        raise ValueError(f"{name} must be finite")
    try:
        result = float(value)
    except OverflowError as exc:
        raise ValueError(f"{name} must be finite") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def validate_request(request):
    """Validate explicit selectors/declarations without opening sources or masks."""
    _exact(request, REQUEST_KEYS, "wound closure request")
    if len(canonical_json(request).encode()) > MAX_REQUEST_BYTES:
        raise ValueError("Wound request exceeds its bounded byte limit")
    for name in ("specimen_id", "sequence_id"):
        checked_text(request[name], name)
    for name in ("time_declaration", "area_declaration", "grid_declaration"):
        checked_text(request[name], name, 2048)
    if request["time_unit"] != "s":
        raise ValueError("Wound times must be explicitly supplied in actual seconds (s)")
    integer(request["working_bytes"], "wound working bytes", 1024**2, 8 * 1024**3)
    frames = request["frames"]
    times = request["time_s"]
    if not isinstance(frames, list) or not 2 <= len(frames) <= MAX_FRAMES:
        raise ValueError("Choose 2-1000 explicit wound frame slots")
    if not isinstance(times, list) or len(times) != len(frames):
        raise ValueError("Wound seconds must cover every frame slot")
    seconds = [_finite(value, "wound time_s") for value in times]
    if any(abs(v) > 1e15 for v in seconds) or any(
        a >= b for a, b in zip(seconds, seconds[1:], strict=False)
    ):
        raise ValueError("Wound seconds must be finite and strictly increasing")
    identities = set()
    results = set()
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError("Wound frame must be an observed or explicit missing object")
        observed = "result_id" in frame
        _exact(
            frame,
            {"frame_id", "result_id", "revision_hash", "selected_labels", "mask_semantics"}
            if observed
            else {"frame_id", "missing_reason"},
            "wound frame",
        )
        checked_text(frame["frame_id"], "Wound frame identity", 128)
        if frame["frame_id"] in identities:
            raise ValueError("Wound frame identities must be unique")
        identities.add(frame["frame_id"])
        if observed:
            checked_id(frame["result_id"])
            _sha(frame["revision_hash"])
            if frame["result_id"] in results:
                raise ValueError("An exact wound result cannot represent two time observations")
            results.add(frame["result_id"])
            if frame["mask_semantics"] != FILLED_AREA:
                raise ValueError(
                    "Explicit filled-wound-area labels are required; "
                    "boundary/skeleton inputs are refused"
                )
            labels = frame["selected_labels"]
            if not isinstance(labels, list) or len(labels) > MAX_OBJECTS:
                raise ValueError("Choose a bounded explicit selected wound label union")
            for label in labels:
                integer(label, "selected wound label", 1, 0xFFFFFFFF)
            if labels != sorted(set(labels)):
                raise ValueError("Selected wound labels must be unique and sorted")
        else:
            checked_text(frame["missing_reason"], "Missing wound frame reason", 512)
    if "result_id" not in frames[0]:
        raise ValueError("Wound baseline must be the first scheduled observed frame")
    return copy.deepcopy(request)


def request_result_bindings(request):
    request = validate_request(request)
    return [
        {k: frame[k] for k in ("result_id", "revision_hash")}
        for frame in request["frames"]
        if "result_id" in frame
    ]


def _sample_identity(inputs):
    from .study_analysis import validate_sample_metadata

    studies = set()
    replicates = set()
    missing = 0
    unassigned = 0
    sources = {}
    for frame in inputs:
        if "result_id" not in frame:
            continue
        source_id = checked_id(frame["source_id"])
        document = frame["sample"]
        if source_id in sources and not _same(sources[source_id], document):
            raise ValueError("Wound frames of one source have conflicting sample snapshots")
        sources[source_id] = document
        if document is None:
            missing += 1
            continue
        _exact(document, {"id", "kind", "revision", "updated_at", "data"}, "wound sample snapshot")
        if document["id"] != source_id or document["kind"] != "sample":
            raise ValueError("Wound sample must bind its exact source")
        integer(document["revision"], "sample revision", 1, 2**63 - 1)
        checked_text(document["updated_at"], "Sample timestamp", 64)
        data = validate_sample_metadata(document["data"]).to_dict()
        studies.add(data["study"])
        if data["biological_replicate"] is None:
            unassigned += 1
        else:
            replicates.add(data["biological_replicate"])
    if len(studies) > 1 or len(replicates) > 1:
        raise ValueError(
            "Wound frames contain conflicting declared study or biological specimen identities"
        )
    return {
        "study": next(iter(studies), None),
        "biological_replicate": next(iter(replicates), None),
        "missing_sample_frames": missing,
        "unassigned_biological_replicate_frames": unassigned,
        "basis": (
            "Captured sample metadata plus explicit specimen/sequence declarations; "
            "physical identity is not inferred"
        ),
    }


def _descriptor(value):
    import numpy as np

    _exact(value, {"sha256", "bytes", "shape", "dtype"}, "wound label descriptor")
    _sha(value["sha256"])
    integer(value["bytes"], "label artifact bytes", 1, MAX_ARTIFACT_BYTES + 4096)
    shape = value["shape"]
    if (
        not isinstance(shape, list)
        or len(shape) != 2
        or any(type(n) is not int or n < 1 for n in shape)
    ):
        raise ValueError("Wound labels require a positive scalar YX shape")
    checked_text(value["dtype"], "Wound label dtype", 128)
    try:
        dtype = np.dtype(value["dtype"])
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid wound label dtype") from exc
    if dtype.kind not in "ui" or dtype.itemsize > 8:
        raise ValueError("Wound labels must be nonnegative integer identifiers")
    return math.prod(shape) * dtype.itemsize


def _frame_projection(frame, time_s, request, result, sample):
    base = {
        "frame_id": frame["frame_id"],
        "time_s": float(time_s),
        "specimen_id": request["specimen_id"],
        "sequence_id": request["sequence_id"],
    }
    if result is None:
        return {**base, "missing_reason": frame["missing_reason"]}
    return {
        **base,
        **{k: result[k] for k in ("source_id", "source_sha256", "revision_hash")},
        "result_id": result["id"],
        "result_record_sha256": _hash(result),
        "geometry": copy.deepcopy(result["provenance"]["geometry"]),
        "selection": copy.deepcopy(result["provenance"]["selection"]),
        "labels": copy.deepcopy(result["arrays"]["labels"]),
        "selected_labels": list(frame["selected_labels"]),
        "mask_semantics": FILLED_AREA,
        "sample": copy.deepcopy(sample),
    }


def _kernel_frames(report, results, array_loader):
    frames = []
    retained = 0
    workspace = 0
    metadata = 0
    for entry in report["request"]["frames"]:
        if "result_id" not in entry:
            continue
        result = results[entry["result_id"]]
        _record(result)
        descriptor = result["arrays"]["labels"]
        retained += _descriptor(descriptor)
        workspace = max(workspace, math.prod(descriptor["shape"]) * 64)
        metadata += len(canonical_json(result).encode()) + len(
            canonical_json(entry["selected_labels"]).encode()
        )
        if metadata > MAX_REPORT_BYTES:
            raise ValueError("Wound producing records exceed the bounded replay snapshot budget")
    if retained + workspace + metadata * 4 > report["request"]["working_bytes"]:
        raise ValueError("Wound sequence exceeds its aggregate working-memory budget before decode")
    for frame in report["request"]["frames"]:
        base = {
            "frame_id": frame["frame_id"],
            "specimen_id": report["request"]["specimen_id"],
            "sequence_id": report["request"]["sequence_id"],
        }
        if "result_id" not in frame:
            frames.append({**base, "missing_reason": frame["missing_reason"]})
        else:
            result = results[frame["result_id"]]
            frames.append(
                {
                    **base,
                    "result": result,
                    "labels": array_loader(result["arrays"]["labels"]),
                    "selected_labels": frame["selected_labels"],
                    "mask_semantics": frame["mask_semantics"],
                }
            )
    return frames


def _measure(report, results, array_loader):
    request = report["request"]
    return measure_wound_closure(
        _kernel_frames(report, results, array_loader),
        request["time_s"],
        **{
            k: request[k]
            for k in (
                "specimen_id",
                "sequence_id",
                "area_declaration",
                "grid_declaration",
                "working_bytes",
            )
        },
    )


def _measurement_only(kernel):
    return {
        k: copy.deepcopy(v)
        for k, v in kernel.items()
        if k not in {"input_snapshots", "record_sha256"}
    }


def _software():
    from .models import ENGINE_VERSION
    from .workbench import runtime_record
    from .working_result import _sha256_file_stable

    files = {
        "kernel_sha256": "wound_closure.py",
        "dispatcher_sha256": "research_wound_closure.py",
        "dependency_resolver_sha256": "research_spatial_density.py",
        "geometry_sha256": "quantitative.py",
    }
    if getattr(sys, "frozen", False):
        digest = _sha256_file_stable(Path(sys.executable), reject_symlink=True)[0]
        return {
            "engine": ENGINE_VERSION,
            "python": platform.python_version(),
            "runtime": runtime_record(),
            **{key: digest for key in files},
        }
    return {
        "engine": ENGINE_VERSION,
        "python": platform.python_version(),
        "runtime": runtime_record(),
        **{
            key: _sha256_file_stable(Path(__file__).with_name(name), reject_symlink=True)[0]
            for key, name in files.items()
        },
    }


def preview(project, request, check=None):
    """Resolve exact masks and produce a compact report; no publication or cache."""
    from .research_interchange import _validate_result_crossrefs

    request = validate_request(request)
    roots = {}
    bindings = {}
    sources = {}
    samples = {}
    inputs = []
    metadata = 0
    resolved_metadata = 0
    for frame, time_s in zip(request["frames"], request["time_s"], strict=True):
        if check:
            check()
        if "result_id" not in frame:
            inputs.append(_frame_projection(frame, time_s, request, None, None))
            continue
        resolved, source_records = _resolve_results(project, [frame["result_id"]], check)
        result = resolved[frame["result_id"]]
        if result["revision_hash"] != frame["revision_hash"]:
            raise ValueError("Wound mask result revision is stale")
        _record(result)
        for record in resolved.values():
            _validate_result_crossrefs(record, source_records, resolved)
            binding = _result_binding(record)
            if record["id"] in bindings and not _same(bindings[record["id"]], binding):
                raise ValueError("Wound dependencies changed during preview")
            if record["id"] not in bindings:
                resolved_metadata += len(canonical_json(record).encode())
                if resolved_metadata > MAX_REPORT_BYTES:
                    raise ValueError(
                        "Wound producing dependency records exceed the replay metadata bound"
                    )
                if resolved_metadata * 4 > request["working_bytes"]:
                    raise ValueError(
                        "Wound sequence exceeds its aggregate working-memory budget before decode"
                    )
            bindings[record["id"]] = binding
        if len(bindings) > MAX_RESULTS:
            raise ValueError("Wound dependency graph exceeds its bounded result count")
        for identity, source in source_records.items():
            if identity in sources and not _same(sources[identity], source):
                raise ValueError("Wound source identity changed during preview")
            sources[identity] = source
        _verify_arrays(project, list(resolved.values()), check)
        roots[result["id"]] = result
        metadata += len(canonical_json(result).encode())
        if metadata > MAX_REPORT_BYTES:
            raise ValueError("Wound producing records exceed the bounded replay snapshot budget")
        source_id = result["source_id"]
        if source_id not in samples:
            samples[source_id] = _sample(project, source_id)
        inputs.append(_frame_projection(frame, time_s, request, result, samples[source_id]))
    provisional = {"request": request}
    kernel = _measure(provisional, roots, project.load_array)
    report = {
        "schema": SCHEMA,
        "created_at": timestamp(),
        "software": _software(),
        "request": request,
        "inputs": inputs,
        "sample_identity": _sample_identity(inputs),
        "measurement": _measurement_only(kernel),
        "kernel_record_sha256": kernel["record_sha256"],
        "result_bindings": [bindings[k] for k in sorted(bindings)],
        "source_snapshots": [sources[k] for k in sorted(sources)],
    }
    report["report_hash"] = _hash(report)
    report = validate_report(report)
    if not current_status(project, report, check)["current"]:
        raise ValueError("Wound sample metadata changed during preview")
    return report


def _validate(report):
    from .research_interchange import _reject_absolute_strings

    _exact(
        report,
        {
            "schema",
            "created_at",
            "software",
            "request",
            "inputs",
            "sample_identity",
            "measurement",
            "kernel_record_sha256",
            "result_bindings",
            "source_snapshots",
            "report_hash",
        },
        "wound report",
    )
    if report["schema"] != SCHEMA:
        raise ValueError("Unsupported wound report schema")
    checked_text(report["created_at"], "Wound report timestamp", 64)
    _exact(
        report["software"],
        {
            "engine",
            "python",
            "runtime",
            "kernel_sha256",
            "dispatcher_sha256",
            "dependency_resolver_sha256",
            "geometry_sha256",
        },
        "wound software",
    )
    checked_text(report["software"]["engine"], "Engine version", 64)
    checked_text(report["software"]["python"], "Python runtime", 64)
    runtime = report["software"]["runtime"]
    _exact(
        runtime,
        {
            "engine",
            "numpy",
            "scipy",
            "scikit_image",
            "requested_device",
            "resolved_device",
            "backend",
            "fallback_reason",
            "scientific_validation",
        },
        "Wound numeric runtime",
    )
    for key, value in runtime.items():
        if value is not None:
            checked_text(value, "Wound numeric runtime " + key, 256)
    if (
        runtime["engine"] != report["software"]["engine"]
        or runtime["resolved_device"] != "cpu"
        or runtime["backend"] != "numpy-scipy-cpu"
    ):
        raise ValueError("Wound runtime disagrees with its producing numerical method")
    for key in (
        "kernel_sha256",
        "dispatcher_sha256",
        "dependency_resolver_sha256",
        "geometry_sha256",
    ):
        _sha(report["software"][key])
    _sha(report["kernel_record_sha256"])
    _reject_absolute_strings(report, "Wound report")
    if len(canonical_json(report).encode()) > MAX_REPORT_BYTES:
        raise ValueError("Wound report exceeds its bounded snapshot byte limit")
    if report["report_hash"] != _hash({k: v for k, v in report.items() if k != "report_hash"}):
        raise ValueError("Wound report failed integrity verification")
    request = validate_request(report["request"])
    inputs = report["inputs"]
    if not isinstance(inputs, list) or len(inputs) != len(request["frames"]):
        raise ValueError("Wound report lost scheduled frame identities")
    result_bindings = report["result_bindings"]
    source_snapshots = report["source_snapshots"]
    for rows, maximum in ((result_bindings, MAX_RESULTS), (source_snapshots, MAX_RESULTS)):
        if not isinstance(rows, list) or len(rows) > maximum:
            raise ValueError("Wound retained inputs exceed their bounded count")
        ids = [checked_id(row["id"]) for row in rows]
        if ids != sorted(set(ids)):
            raise ValueError("Wound retained inputs must have unique canonical order")
    bindings = {b["id"]: b for b in result_bindings}
    sources = {s["id"]: s for s in source_snapshots}
    for binding in result_bindings:
        _exact(
            binding,
            {
                "id",
                "revision_hash",
                "source_id",
                "source_sha256",
                "record_sha256",
                "arrays",
                "dependency_result_ids",
                "source_ids",
            },
            "wound result binding",
        )
        checked_id(binding["source_id"])
        for key in ("revision_hash", "source_sha256", "record_sha256"):
            _sha(binding[key])
        if not isinstance(binding["arrays"], dict) or "labels" not in binding["arrays"]:
            raise ValueError("Wound retained dependencies require label arrays")
        for descriptor in binding["arrays"].values():
            _exact(descriptor, {"sha256", "bytes", "shape", "dtype"}, "retained array descriptor")
            _sha(descriptor["sha256"])
            integer(descriptor["bytes"], "array artifact bytes", 1, MAX_ARTIFACT_BYTES + 4096)
            if (
                not isinstance(descriptor["shape"], list)
                or not 1 <= len(descriptor["shape"]) <= 5
                or any(type(v) is not int or v < 0 for v in descriptor["shape"])
            ):
                raise ValueError("Invalid retained array shape")
            checked_text(descriptor["dtype"], "Array dtype", 128)
        for key in ("dependency_result_ids", "source_ids"):
            values = binding[key]
            if not isinstance(values, list) or values != sorted(set(values)):
                raise ValueError("Wound dependencies must have unique canonical identities")
            for value in values:
                checked_id(value)
    for source in source_snapshots:
        exact_keys(source, {"id", "sha256", "derivation"}, "wound source snapshot")
        _sha(source.get("sha256"))
    contract = None
    rows = []
    baseline = None
    acquisitions = set()
    source_hashes = {}
    root_ids = set()
    for index, (frame, time_s, snapshot) in enumerate(
        zip(request["frames"], request["time_s"], inputs, strict=True)
    ):
        time_s = float(time_s)
        base = {
            "frame_id": frame["frame_id"],
            "time_s": time_s,
            "specimen_id": request["specimen_id"],
            "sequence_id": request["sequence_id"],
        }
        if "result_id" not in frame:
            if not _same(snapshot, {**base, "missing_reason": frame["missing_reason"]}):
                raise ValueError("Wound missing frame snapshot differs from its declaration")
            rows.append(
                {
                    "frame_id": frame["frame_id"],
                    "time_s": time_s,
                    "status": "missing",
                    "missing_reason": frame["missing_reason"],
                    "selected_pixel_count": None,
                    "excluded_positive_pixel_count": None,
                    "area": None,
                    "area_fraction": None,
                    "closure_fraction": None,
                }
            )
            continue
        _exact(
            snapshot,
            {
                *base,
                "result_id",
                "revision_hash",
                "source_id",
                "source_sha256",
                "result_record_sha256",
                "geometry",
                "selection",
                "labels",
                "selected_labels",
                "mask_semantics",
                "sample",
            },
            "wound input projection",
        )
        if (
            any(not _same(snapshot[k], v) for k, v in base.items())
            or snapshot["result_id"] != frame["result_id"]
            or snapshot["revision_hash"] != frame["revision_hash"]
            or snapshot["selected_labels"] != frame["selected_labels"]
            or snapshot["mask_semantics"] != FILLED_AREA
        ):
            raise ValueError("Wound input projection differs from its exact request")
        binding = bindings.get(frame["result_id"])
        if (
            binding is None
            or any(
                binding[k] != snapshot[k] for k in ("revision_hash", "source_id", "source_sha256")
            )
            or binding["record_sha256"] != snapshot["result_record_sha256"]
            or not _same(binding["arrays"]["labels"], snapshot["labels"])
        ):
            raise ValueError("Wound input lost its exact original mask/result binding")
        if (
            snapshot["source_id"] not in sources
            or sources[snapshot["source_id"]]["sha256"] != snapshot["source_sha256"]
        ):
            raise ValueError("Wound source snapshot is missing or mismatched")
        if (
            source_hashes.setdefault(snapshot["source_id"], snapshot["source_sha256"])
            != snapshot["source_sha256"]
        ):
            raise ValueError("Wound input source fingerprints conflict")
        _descriptor(snapshot["labels"])
        g = snapshot["geometry"]
        _exact(g, {"axes", "affine", "unit", "frame"}, "wound geometry")
        geometry = Geometry(
            g["axes"], tuple(tuple(row) for row in g["affine"]), g["unit"], g["frame"]
        )
        if geometry.axes != "YX":
            raise ValueError("Wound report requires scalar YX geometry")
        pixel_area = _finite(math.prod(geometry.orthogonal_spacing()), "Wound pixel area")
        selection = snapshot["selection"]
        _exact(selection, {"x", "y", "width", "height", "t", "z", "c", "level"}, "wound selection")
        for key, value in selection.items():
            integer(value, "wound selection", 1 if key in {"width", "height"} else 0, 2**63 - 1)
        if snapshot["labels"]["shape"] != [selection["height"], selection["width"]]:
            raise ValueError("Wound selection and mask shape disagree")
        current = {
            "geometry": geometry.to_dict(),
            "field_of_view": {k: v for k, v in selection.items() if k != "t"},
            "shape": snapshot["labels"]["shape"],
        }
        if contract is None:
            contract = current
        elif not _same(contract, current):
            raise ValueError(
                "Wound frames changed field of view, plane/channel, grid or calibration"
            )
        acquisition = snapshot["source_id"], _hash(selection)
        if acquisition in acquisitions:
            raise ValueError("Repeated wound acquisitions are not separate time observations")
        acquisitions.add(acquisition)
        root_ids.add(frame["result_id"])
        stored = report["measurement"]["frames"][index]
        pixels = integer(
            stored["selected_pixel_count"],
            "Selected wound pixels",
            0,
            selection["width"] * selection["height"],
        )
        excluded = integer(
            stored["excluded_positive_pixel_count"],
            "Excluded positive pixels",
            0,
            selection["width"] * selection["height"],
        )
        if (
            pixels + excluded > selection["width"] * selection["height"]
            or pixels < len(frame["selected_labels"])
            or (not frame["selected_labels"] and pixels)
        ):
            raise ValueError("Wound pixel accounting contradicts the selected label union")
        area = _finite(pixels * pixel_area, "Wound area")
        if index == 0:
            if area <= 0:
                raise ValueError("Wound baseline area must be strictly positive")
            baseline = area
        fraction = _finite(area / baseline, "Wound area fraction")
        rows.append(
            {
                "frame_id": frame["frame_id"],
                "time_s": time_s,
                "status": "observed",
                "selected_pixel_count": pixels,
                "excluded_positive_pixel_count": excluded,
                "area": area,
                "area_fraction": fraction,
                "closure_fraction": _finite(1 - fraction, "Wound closure fraction"),
            }
        )
    reached = set()
    active = set()

    def visit(identity):
        if identity in active or len(active) >= 64:
            raise ValueError("Wound dependencies are cyclic or too deep")
        if identity in reached:
            return
        binding = bindings.get(identity)
        if binding is None:
            raise ValueError("Wound retained dependency is missing")
        active.add(identity)
        for child in binding["dependency_result_ids"]:
            visit(child)
        active.remove(identity)
        reached.add(identity)

    for identity in root_ids:
        visit(identity)
    if reached != set(bindings) or set().union(
        *(set(b["source_ids"]) for b in bindings.values())
    ) != set(sources):
        raise ValueError("Wound retained inputs include missing or unrelated records")
    intervals = []
    for left, right in zip(rows, rows[1:], strict=False):
        dt = right["time_s"] - left["time_s"]
        observed = left["status"] == right["status"] == "observed"
        intervals.append(
            {
                "from_frame_id": left["frame_id"],
                "to_frame_id": right["frame_id"],
                "delta_time_s": dt,
                "status": "defined" if observed else "missing_endpoint",
                "area_change_rate": _finite(
                    (right["area"] - left["area"]) / dt, "Wound area change rate"
                )
                if observed
                else None,
                "closure_change_rate": _finite(
                    (right["closure_fraction"] - left["closure_fraction"]) / dt,
                    "Wound closure change rate",
                )
                if observed
                else None,
            }
        )
    expected = {
        "schema": KERNEL_SCHEMA,
        "rules": RULES,
        **{
            k: request[k]
            for k in ("specimen_id", "sequence_id", "area_declaration", "grid_declaration")
        },
        "contract": contract,
        "time_unit": "s",
        "area_unit": f"{contract['geometry']['unit']}^2",
        "calibration_status": "uncalibrated-pixel-area"
        if contract["geometry"]["unit"] == "pixel"
        else "declared-physical-calibration",
        "baseline_frame_id": rows[0]["frame_id"],
        "baseline_area": baseline,
        "frames": rows,
        "intervals": intervals,
    }
    if not _same(expected, report["measurement"]):
        raise ValueError("Wound area/time arithmetic is not reproducible from its exact projection")
    if not _same(_sample_identity(inputs), report["sample_identity"]):
        raise ValueError("Wound sample identity audit is inconsistent")
    return copy.deepcopy(report)


def validate_report(report):
    """Pure compact identity/arithmetic check; actual reads also replay original masks."""
    try:
        return _validate(report)
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError("Malformed wound report or retained scientific input") from exc


def input_result_ids(report):
    return [b["id"] for b in validate_report(report)["result_bindings"]]


def _kernel_receipt(report, results):
    snapshots = []
    for frame, time_s in zip(report["request"]["frames"], report["request"]["time_s"], strict=True):
        base = {
            "frame_id": frame["frame_id"],
            "time_s": float(time_s),
            "specimen_id": report["request"]["specimen_id"],
            "sequence_id": report["request"]["sequence_id"],
        }
        snapshots.append(
            {
                **base,
                "result": results[frame["result_id"]],
                "selected_labels": frame["selected_labels"],
                "mask_semantics": FILLED_AREA,
            }
            if "result_id" in frame
            else {**base, "missing_reason": frame["missing_reason"]}
        )
    kernel = {**report["measurement"], "input_snapshots": snapshots}
    if _hash(kernel) != report["kernel_record_sha256"]:
        raise ValueError("Wound kernel receipt differs from the original result snapshots")


def preflight_portable_references(report, results_by_id, sources_by_id, documents=()):
    """Metadata-only portable preflight, never acceptance of mask measurements."""
    from .research_interchange import _validate_result_crossrefs

    report = validate_report(report)
    resolved_metadata = 0
    for binding in report["result_bindings"]:
        result = results_by_id.get(binding["id"])
        if result is None:
            raise ValueError("Wound retained result changed or is unavailable")
        resolved_metadata += len(canonical_json(result).encode())
        if (
            resolved_metadata > MAX_REPORT_BYTES
            or resolved_metadata * 4 > report["request"]["working_bytes"]
        ):
            raise ValueError(
                "Wound sequence exceeds its aggregate working-memory budget before decode"
            )
        if not _same(_result_binding(result), binding):
            raise ValueError("Wound retained result changed or is unavailable")
        for dependency in _bindings(result):
            bound = results_by_id.get(dependency["result_id"])
            if bound is None:
                raise ValueError("Wound retained result dependency is missing")
            _check_binding(dependency, bound)
        _validate_result_crossrefs(result, sources_by_id, results_by_id)
    for source in report["source_snapshots"]:
        actual = sources_by_id.get(source["id"])
        if actual is not None:
            validate_source_calibration(actual)
        if actual is None or not _same(_source_snapshot(actual), source):
            raise ValueError("Wound source fingerprint or derivation changed")
    for frame, declared in zip(report["inputs"], report["request"]["frames"], strict=True):
        if "result_id" not in frame:
            continue
        result = results_by_id[frame["result_id"]]
        _record(result)
        expected = _frame_projection(
            declared, frame["time_s"], report["request"], result, frame["sample"]
        )
        if not _same(expected, frame):
            raise ValueError("Wound input projection differs from its exact original record")
    _kernel_receipt(report, results_by_id)
    return report


def validate_portable_references(
    report, results_by_id, sources_by_id, documents=(), *, array_loader=None
):
    """Require exact staged mask replay before accepting a portable wound report.

    Importers can call ``preflight_portable_references`` before artifact extraction;
    scientific publication must call this function with a verified staged loader.
    """
    report = preflight_portable_references(report, results_by_id, sources_by_id, documents)
    if array_loader is None:
        raise ValueError("Wound portable acceptance requires a verified staged mask array_loader")
    kernel = _measure(report, results_by_id, array_loader)
    if kernel["record_sha256"] != report["kernel_record_sha256"] or not _same(
        _measurement_only(kernel), report["measurement"]
    ):
        raise ValueError("Wound measurements disagree with retained original masks")
    return report


validate_references = validate_portable_references


def references(project, report, *, verify_sources=False, verify_arrays=True, check=None):
    report = validate_report(report)
    if check:
        check()
    if not verify_arrays:
        with project.connection() as connection:
            for binding in report["result_bindings"]:
                row = connection.execute(
                    "SELECT record FROM results WHERE id=?", (binding["id"],)
                ).fetchone()
                if (
                    row is None
                    or hashlib.sha256(row[0].encode()).hexdigest() != binding["record_sha256"]
                ):
                    raise ValueError("Wound retained canonical result record hash changed")
        for snapshot in report["source_snapshots"]:
            actual_source = project.source(snapshot["id"], verify=verify_sources, check=check)
            validate_source_calibration(actual_source)
            if not _same(_source_snapshot(actual_source), snapshot):
                raise ValueError("Wound retained source changed")
        if check:
            check()
        return report
    results = {}
    sources = {}
    resolved_metadata = 0
    for binding in report["result_bindings"]:
        if check:
            check()
        result = project.result(binding["id"])
        resolved_metadata += len(canonical_json(result).encode())
        if (
            resolved_metadata > MAX_REPORT_BYTES
            or resolved_metadata * 4 > report["request"]["working_bytes"]
        ):
            raise ValueError(
                "Wound sequence exceeds its aggregate working-memory budget before decode"
            )
        if not _same(_result_binding(result), binding):
            raise ValueError("Wound retained result changed or is unavailable")
        results[result["id"]] = result
    for snapshot in report["source_snapshots"]:
        if check:
            check()
        sources[snapshot["id"]] = project.source(snapshot["id"], verify=verify_sources, check=check)
    _verify_arrays(project, list(results.values()), check)
    return validate_portable_references(report, results, sources, array_loader=project.load_array)


def current_status(project, report, check=None):
    report = validate_report(report)
    changes = []
    seen = set()
    for frame in report["inputs"]:
        if "source_id" not in frame or frame["source_id"] in seen:
            continue
        seen.add(frame["source_id"])
        if check:
            check()
        if not _same(_sample(project, frame["source_id"]), frame["sample"]):
            changes.append({"source_id": frame["source_id"], "reason": "sample_metadata_changed"})
    return {"current": not changes, "changes": changes}


def _input_view(frame):
    if "result_id" not in frame:
        return copy.deepcopy(frame)
    result = {k: copy.deepcopy(v) for k, v in frame.items() if k != "selected_labels"}
    result["selected_label_count"] = len(frame["selected_labels"])
    result["selected_labels_sha256"] = _hash(frame["selected_labels"])
    return result


def summary(report):
    report = validate_report(report)
    measurement = report["measurement"]
    result = {
        "schema": "loci.wound-closure-summary/v1",
        "report_schema": SCHEMA,
        "report_hash": report["report_hash"],
        "created_at": report["created_at"],
        "software": report["software"],
        "request_sha256": _hash(report["request"]),
        "measurement": {
            k: copy.deepcopy(v) for k, v in measurement.items() if k not in {"frames", "intervals"}
        },
        "sample_identity": report["sample_identity"],
        "tables": {},
        "totals": {
            "scheduled_frames": len(report["inputs"]),
            "observed_frames": sum("result_id" in f for f in report["inputs"]),
            "missing_frames": sum("result_id" not in f for f in report["inputs"]),
        },
    }
    for limit in range(5, -1, -1):
        for table in TABLES:
            rows = (
                [_input_view(f) for f in report["inputs"]]
                if table == "inputs"
                else measurement[table]
            )
            part = copy.deepcopy(rows[:limit])
            result[table] = part
            result["tables"][table] = {
                "total": len(rows),
                "returned": len(part),
                "has_more": len(part) < len(rows),
                "next_offset": len(part) if len(part) < len(rows) else None,
            }
        if len(canonical_json(result).encode()) <= PAGE_BYTES:
            return result
    raise ValueError("Wound summary metadata exceeds its bounded response size")


def _token(request):
    _exact(request, {"preview_id", "preview_hash"}, "wound preview token")
    checked_id(request["preview_id"])
    _sha(request["preview_hash"])


def _cache_preview(project, report, check=None):
    record = {
        "schema": "loci.wound-closure-preview/v1",
        "preview_id": report["report_hash"][:32],
        "preview_hash": report["report_hash"],
        "created_at": report["created_at"],
        "report": report,
    }
    encoded = canonical_json(record)
    if len(encoded.encode()) > MAX_PREVIEW_BYTES:
        raise ValueError("Wound preview exceeds its bounded cache byte limit")
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if check:
            check()
        if not current_status(project, report, check)["current"]:
            raise ValueError("Wound metadata changed before preview retention")
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (PREVIEW_PREFIX + record["preview_id"], encoded),
        )
        cached = connection.execute(
            "SELECT key,value FROM metadata WHERE key LIKE ?", (PREVIEW_PREFIX + "%",)
        ).fetchall()
        cached.sort(
            key=lambda row: (
                parse_json(row[1])["created_at"],
                row[0] == PREVIEW_PREFIX + record["preview_id"],
                row[0],
            ),
            reverse=True,
        )
        used = 0
        kept = 0
        for key, value in cached:
            size = len(value.encode())
            if kept >= MAX_PREVIEWS or used + size > MAX_PREVIEW_BYTES:
                connection.execute("DELETE FROM metadata WHERE key=?", (key,))
            else:
                used += size
                kept += 1
        if check:
            check()
    return {
        "preview_id": record["preview_id"],
        "preview_hash": record["preview_hash"],
        "summary": summary(report),
    }


def peek_preview(project, request):
    """Internal metadata lookup; token possession does not authorize its inputs."""
    _token(request)
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", (PREVIEW_PREFIX + request["preview_id"],)
        ).fetchone()
    if row is None:
        raise ValueError("Wound preview is unavailable or evicted; preview again explicitly")
    record = parse_json(row[0])
    if (
        record.get("schema") != "loci.wound-closure-preview/v1"
        or record.get("preview_id") != request["preview_id"]
        or record.get("preview_hash") != request["preview_hash"]
    ):
        raise ValueError("Wound preview identity changed")
    report = validate_report(record["report"])
    if (
        report["report_hash"] != request["preview_hash"]
        or report["report_hash"][:32] != request["preview_id"]
    ):
        raise ValueError("Wound preview content failed integrity verification")
    return report


def save_task_source(project, request):
    report = peek_preview(project, request)
    return next(frame["source_id"] for frame in report["inputs"] if "source_id" in frame)


def _save(project, request, check=None, job_id=None):
    report = references(project, peek_preview(project, request), verify_sources=True, check=check)
    report_id = report["report_hash"][:32]

    def guard():
        if check:
            check()
        if not _same(report["software"], _software()):
            raise ValueError("Wound runtime changed; preview again before saving")
        references(project, report, verify_sources=True, check=check)
        if not current_status(project, report, check)["current"]:
            raise ValueError("Wound sample metadata changed; preview again before saving")

    guard()
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        job = None
        if job_id is not None:
            row = connection.execute(
                "SELECT request_hash,record FROM jobs WHERE id=?", (checked_id(job_id),)
            ).fetchone()
            if row is None:
                raise ValueError("Wound save requires its exact running job")
            job = parse_json(row[1])
            if (
                job.get("id") != job_id
                or job["operation"] != "wound_closure_save"
                or job["state"] != "running"
                or job["cancel_requested"]
                or row[0] != job.get("request_hash")
                or row[0] != _hash({"operation": job["operation"], "request": job["request"]})
                or set(job["request"]) != {"source_id", "task_request"}
                or job["request"]["source_id"] != save_task_source(project, request)
                or not _same(job["request"]["task_request"], request)
            ):
                raise ValueError("Wound save job changed or was cancelled before publication")
            if job.get("owner") is not None:
                from .agent_sessions import require_session_authority

                require_session_authority(project, **job["owner"], connection=connection)
        guard()
        existing = connection.execute(
            "SELECT revision,record FROM documents WHERE kind=? AND id=?",
            (DOCUMENT_KIND, report_id),
        ).fetchone()
        if existing is None:
            document = {
                "id": report_id,
                "kind": DOCUMENT_KIND,
                "revision": 1,
                "updated_at": timestamp(),
                "data": report,
            }
            connection.execute(
                "INSERT INTO documents VALUES(?,?,?,?)",
                (DOCUMENT_KIND, report_id, 1, canonical_json(document)),
            )
        else:
            document = parse_json(existing[1])
            checked_text(document.get("updated_at"), "Wound envelope timestamp", 64)
            _exact(
                document, {"id", "kind", "revision", "updated_at", "data"}, "wound report envelope"
            )
            if (
                existing[0] != 1
                or type(document["revision"]) is not int
                or document["revision"] != 1
                or document["id"] != report_id
                or document["kind"] != DOCUMENT_KIND
                or not _same(document["data"], report)
            ):
                raise ValueError("Immutable wound report content differs")
        guard()
        if job is not None:
            if job.get("owner") is not None:
                from .agent_sessions import require_session_authority

                require_session_authority(project, **job["owner"], connection=connection)
            now = timestamp()
            job.update(
                state="succeeded",
                progress=1.0,
                result_ids=[],
                report_id=report_id,
                error=None,
                finished_at=now,
                updated_at=now,
            )
            connection.execute("UPDATE jobs SET record=? WHERE id=?", (canonical_json(job), job_id))
        if check:
            check()
    return {
        "report": report,
        "report_id": report_id,
        "status": current_status(project, report, check),
        "summary": summary(report),
    }


def save_job(project, request, job_id, check=None):
    return _save(project, request, check, job_id)


def load(project, report_id, *, verify_sources=False, verify_arrays=True, check=None):
    records = project.documents(DOCUMENT_KIND, document_id=checked_id(report_id))
    if len(records) != 1:
        raise ValueError("Choose an exact saved wound report")
    record = records[0]
    _exact(record, {"id", "kind", "revision", "updated_at", "data"}, "wound report envelope")
    if (
        record["id"] != report_id
        or record["kind"] != DOCUMENT_KIND
        or type(record["revision"]) is not int
        or record["revision"] != 1
    ):
        raise ValueError("Wound report envelope identity is inconsistent")
    checked_text(record["updated_at"], "Wound report timestamp", 64)
    report = references(
        project,
        record["data"],
        verify_sources=verify_sources,
        verify_arrays=verify_arrays,
        check=check,
    )
    if report["report_hash"][:32] != report_id:
        raise ValueError("Wound report identity is inconsistent")
    return report


def query(project, request, check=None):
    identity = {k: request[k] for k in ("preview_id", "preview_hash", "report_id") if k in request}
    exact_keys(request, {*identity, "table", "offset", "limit", "frame_id"}, "wound query")
    if set(identity) == {"report_id"}:
        report = load(project, identity["report_id"], check=check)
    elif set(identity) == {"preview_id", "preview_hash"}:
        report = references(project, peek_preview(project, identity), check=check)
    else:
        raise ValueError("Choose one exact wound report or preview identity")
    table = request.get("table")
    if table not in (*TABLES, "selected_labels"):
        raise ValueError("Choose a declared wound report table")
    if (table == "selected_labels") != ("frame_id" in request):
        raise ValueError("Selected-label pages require one exact observed wound frame")
    offset = integer(request.get("offset", 0), "wound row offset", 0, 2**63 - 1)
    limit = integer(request.get("limit", 50), "wound page rows", 1, 100)
    if table == "selected_labels":
        frames = [
            f for f in report["inputs"] if f["frame_id"] == request["frame_id"] and "result_id" in f
        ]
        if len(frames) != 1:
            raise ValueError("Choose one exact observed wound frame")
        rows = frames[0]["selected_labels"]
    elif table == "inputs":
        rows = [_input_view(f) for f in report["inputs"]]
    else:
        rows = report["measurement"][table]
    result = {
        "schema": "loci.wound-closure-page/v1",
        "report_hash": report["report_hash"],
        "table": table,
        "offset": offset,
        "limit": limit,
        "total": len(rows),
        "returned": 0,
        "rows": [],
        "next_offset": None,
    }
    if table == "selected_labels":
        result["frame_id"] = request["frame_id"]
    for row in rows[offset : offset + limit]:
        result["rows"].append(copy.deepcopy(row))
        result["returned"] = len(result["rows"])
        end = offset + result["returned"]
        result["next_offset"] = end if end < len(rows) else None
        if len(canonical_json(result).encode()) > PAGE_BYTES:
            result["rows"].pop()
            result["returned"] -= 1
            end = offset + result["returned"]
            result["next_offset"] = end if end < len(rows) else None
            if not result["returned"]:
                raise ValueError("Wound row exceeds its bounded page byte limit")
            break
    return result


def execute(project, operation, request, check=None, *, job_id=None):
    if operation == "wound_closure_preview":
        return _cache_preview(project, preview(project, request, check), check)
    if operation == "wound_closure_save":
        return _save(project, request, check, job_id)
    if operation == "wound_closure_query":
        return query(project, request, check)
    if operation == "wound_closure_get":
        _exact(request, {"report_id"}, operation)
        report = load(project, request["report_id"], check=check)
        return {
            "report": report,
            "report_id": request["report_id"],
            "status": current_status(project, report, check),
            "summary": summary(report),
        }
    if operation == "wound_closure_list":
        _exact(request, set(), operation)
        reports = []
        for document in project.documents(DOCUMENT_KIND):
            report = load(project, document["id"], check=check)
            reports.append(
                {
                    "id": document["id"],
                    "created_at": report["created_at"],
                    "specimen_id": report["request"]["specimen_id"],
                    "sequence_id": report["request"]["sequence_id"],
                    "status": current_status(project, report, check),
                }
            )
        return {"reports": reports}
    raise ValueError("Unknown wound closure operation")


def _mask_files(report):
    files = {}
    for frame in report["inputs"]:
        if "labels" not in frame:
            continue
        descriptor = frame["labels"]
        name = "labels-" + descriptor["sha256"] + ".npy"
        entry = {
            "name": name,
            "sha256": descriptor["sha256"],
            "size_bytes": descriptor["bytes"],
            "descriptor": descriptor,
        }
        if name in files and not _same(files[name], entry):
            raise ValueError("Wound mask descriptors disagree for one artifact hash")
        files[name] = entry
    return [files[name] for name in sorted(files)]


def plan(project, report_id, check=None):
    report = load(project, report_id, verify_sources=True, check=check)
    value = {
        "schema": "loci.wound-closure-export-plan/v1",
        "report_id": report_id,
        "report_hash": report["report_hash"],
        "source_id": next(f["source_id"] for f in report["inputs"] if "source_id" in f),
        "status": current_status(project, report, check),
        "export_software": _software(),
        "mask_files": [
            {k: v for k, v in entry.items() if k != "descriptor"} for entry in _mask_files(report)
        ],
    }
    if check:
        check()
    return {**value, "plan_hash": _hash(value)}


def grant(project, report_id, expected_plan_hash, destination):
    """Trusted native destination selection only; renderer/agent receives no path."""
    _capability()
    current = plan(project, checked_id(report_id))
    if current["plan_hash"] != _sha(expected_plan_hash):
        raise ValueError("Wound report inputs changed; prepare a fresh export preview")
    target = _destination(project, destination)
    parent = target.parent.stat()
    grant_id = uuid.uuid4().hex
    report = load(project, report_id)
    data = {
        "schema": "loci.wound-closure-export-grant/v1",
        "plan": current,
        "destination": str(target),
        "parent_identity": [parent.st_dev, parent.st_ino],
        "source_id": next(f["source_id"] for f in report["inputs"] if "source_id" in f),
        "project_id": project.meta["project_id"],
        "private_project_root": str(project.root),
        "created_at": timestamp(),
    }
    document = {
        "id": grant_id,
        "kind": GRANT_KIND,
        "revision": 1,
        "updated_at": data["created_at"],
        "data": data,
    }
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO documents VALUES(?,?,?,?)",
            (GRANT_KIND, grant_id, 1, canonical_json(document)),
        )
    return {"grant_id": grant_id, "plan_hash": current["plan_hash"], "basename": target.name}


def _grant(project, request):
    _exact(request, {"grant_id", "plan_hash"}, "wound export grant")
    checked_id(request["grant_id"])
    _sha(request["plan_hash"])
    documents = project.documents(GRANT_KIND, document_id=request["grant_id"])
    if len(documents) != 1:
        raise ValueError("Wound export grant is missing or stale")
    document = documents[0]
    _exact(
        document, {"id", "kind", "revision", "updated_at", "data"}, "wound export grant envelope"
    )
    if (
        document["id"] != request["grant_id"]
        or document["kind"] != GRANT_KIND
        or type(document["revision"]) is not int
        or document["revision"] != 1
    ):
        raise ValueError("Wound export grant identity changed")
    checked_text(document["updated_at"], "Wound export grant timestamp", 64)
    data = document["data"]
    _exact(
        data,
        {
            "schema",
            "plan",
            "destination",
            "parent_identity",
            "source_id",
            "project_id",
            "private_project_root",
            "created_at",
        },
        "wound export grant",
    )
    if (
        data["schema"] != "loci.wound-closure-export-grant/v1"
        or data["plan"]["plan_hash"] != request["plan_hash"]
        or data["plan"]["plan_hash"]
        != _hash({k: v for k, v in data["plan"].items() if k != "plan_hash"})
        or data["project_id"] != project.meta["project_id"]
        or data["private_project_root"] != str(project.root)
    ):
        raise ValueError("Wound export grant changed or belongs to another study location")
    checked_id(data["source_id"])
    checked_id(data["plan"]["report_id"])
    checked_text(data["created_at"], "Wound export grant timestamp", 64)
    if data["source_id"] != data["plan"].get("source_id"):
        raise ValueError("Wound export grant source routing changed")
    return document


def task_source(project, request):
    return _grant(project, request)["data"]["source_id"]


def export_input_result_ids(project, request):
    return input_result_ids(load(project, _grant(project, request)["data"]["plan"]["report_id"]))


def _closure_svg(report):
    """Deterministic single-sequence figure; missing observations never connect."""
    import html

    rows = report["measurement"]["frames"]
    observed = [row for row in rows if row["status"] == "observed"]
    xmin, xmax = rows[0]["time_s"], rows[-1]["time_s"]
    ymin = min(0.0, min(row["closure_fraction"] for row in observed))
    ymax = max(1.0, max(row["closure_fraction"] for row in observed))

    def point(row):
        return 88 + 620 * ((row["time_s"] - xmin) / (xmax - xmin)), 44 + 300 * (
            1 - (row["closure_fraction"] - ymin) / (ymax - ymin)
        )

    elements = [
        (
            '<svg xmlns="http://www.w3.org/2000/svg" width="780" height="450" '
            'viewBox="0 0 780 450" role="img" aria-labelledby="title desc">'
        ),
        '<title id="title">Declared wound-area closure over elapsed seconds</title>',
        (
            '<desc id="desc">Closure is one minus area divided by baseline area. '
            "Negative values mean area growth. Missing slots are unconnected.</desc>"
        ),
        '<rect width="780" height="450" fill="white"/>',
        '<g font-family="sans-serif" fill="#263344" font-size="12">',
        '<path d="M88 44V344H708" fill="none" stroke="#263344"/>',
    ]
    for fraction in (0.0, 0.5, 1.0):
        y = 44 + 300 * (1 - fraction)
        value = ymin + fraction * (ymax - ymin)
        elements.append(
            f'<path d="M88 {y}H708" stroke="#e1e5ea"/>'
            f'<text x="78" y="{y + 4}" text-anchor="end">'
            f"{html.escape(format(value, '.4g'))}</text>"
        )
    for fraction in (0.0, 0.5, 1.0):
        x = 88 + 620 * fraction
        value = xmin + fraction * (xmax - xmin)
        elements.append(
            f'<text x="{x}" y="366" text-anchor="middle">{html.escape(format(value, ".5g"))}</text>'
        )
    for left, right in zip(rows, rows[1:], strict=False):
        if left["status"] == right["status"] == "observed":
            x1, y1 = point(left)
            x2, y2 = point(right)
            elements.append(
                f'<path d="M{x1:.6f} {y1:.6f}L{x2:.6f} {y2:.6f}" '
                'stroke="#285c8d" stroke-width="2" fill="none"/>'
            )
    for row in observed:
        x, y = point(row)
        elements.append(f'<circle cx="{x:.6f}" cy="{y:.6f}" r="3.5" fill="#285c8d"/>')
    elements.extend(
        [
            '<text x="398" y="398" text-anchor="middle">Elapsed time (s)</text>',
            (
                '<text x="23" y="194" text-anchor="middle" transform="rotate(-90 23 194)">'
                "Closure fraction (1 − A/A₀)</text>"
            ),
            (
                f'<text x="88" y="423">{html.escape(report["request"]["specimen_id"])} · '
                f"{html.escape(report['request']['sequence_id'])}</text>"
            ),
            "</g>",
            f"<metadata>{html.escape(report['report_hash'])}</metadata>",
            "</svg>",
        ]
    )
    return "\n".join(elements) + "\n"


def _contents(report, status):
    from .research_intensity_export import _csv

    measurement = report["measurement"]
    frames = []
    for row, input_frame in zip(measurement["frames"], report["inputs"], strict=True):
        frames.append(
            {
                **row,
                "result_id": input_frame.get("result_id"),
                "revision_hash": input_frame.get("revision_hash"),
                "source_id": input_frame.get("source_id"),
                "source_sha256": input_frame.get("source_sha256"),
                "result_record_sha256": input_frame.get("result_record_sha256"),
                "labels_sha256": input_frame.get("labels", {}).get("sha256"),
                "selected_labels": input_frame.get("selected_labels"),
                "selection": input_frame.get("selection"),
                "geometry": input_frame.get("geometry"),
                "sample": input_frame.get("sample"),
                "specimen_id": report["request"]["specimen_id"],
                "sequence_id": report["request"]["sequence_id"],
                "area_unit": measurement["area_unit"],
                "time_unit": "s",
            }
        )
    files = {
        "report.json": canonical_json(report) + "\n",
        "frames.csv": _csv(frames),
        "intervals.csv": _csv(measurement["intervals"]),
        "closure.svg": _closure_svg(report),
    }
    files["schema.json"] = (
        canonical_json(
            {
                "schema": "loci.wound-closure-package/v1",
                "report_hash": report["report_hash"],
                "csv_cell_encoding": (
                    "Every CSV cell is JSON; parse each cell with JSON, not spreadsheet coercion"
                ),
                "area_unit": measurement["area_unit"],
                "time_unit": "s",
                "closure_unit": "dimensionless fraction",
                "area_change_rate_unit": measurement["area_unit"] + "/s",
                "closure_change_rate_unit": "1/s",
                "geometry": (
                    "Scalar YX arrays; affine maps XYZ voxel-center indices into "
                    "the stated coordinate frame; selection origins retained"
                ),
                "mask_encoding": (
                    "Exact original content-addressed NPY label artifacts; "
                    "no relabeling, thresholding, filling or resampling"
                ),
                "mask_selection": (
                    "Selected positive labels are unioned; "
                    "all other mask labels remain in exported originals"
                ),
                "rules": measurement["rules"],
                "time_declaration": report["request"]["time_declaration"],
                "mask_files": [
                    {k: v for k, v in entry.items() if k != "descriptor"}
                    for entry in _mask_files(report)
                ],
            }
        )
        + "\n"
    )
    files["provenance.json"] = (
        canonical_json(
            {
                "report_hash": report["report_hash"],
                "kernel_record_sha256": report["kernel_record_sha256"],
                "software": report["software"],
                "current_input_status_at_export": status,
                "source_snapshots": report["source_snapshots"],
                "result_bindings": report["result_bindings"],
                "raw_source_images_included": False,
                "source_locators_included": False,
            }
        )
        + "\n"
    )
    files["readme.md"] = (
        "# Loci wound-closure report\n\n"
        "This package describes one explicitly declared specimen and longitudinal sequence. "
        "Filled-wound-area meaning, same field of view and actual elapsed "
        "seconds are user declarations; "
        "they are not inferred from appearance or frame numbers. "
        "Boundary/skeleton masks are not filled. "
        "frames.csv retains missing slots and unrounded area, area/baseline and 1-area/baseline. "
        "Negative closure means measured area growth. intervals.csv contains "
        "slopes only between adjacent "
        "scheduled observed slots; missing frames never create a bridged "
        "slope. All CSV cells are JSON. "
        "Original labels-<sha256>.npy masks are copied byte-for-byte, including unselected labels. "
        "Source images remain immutable in the study and are not included. Raw "
        "source identity, original "
        "result revision/full-record hash, full sample snapshots, array "
        "hashes, selections and affine "
        "transforms remain in report.json/provenance.json. Current metadata "
        "changes do not rewrite the report. "
        "closure.svg is an editable descriptive plot; its axis tick labels are "
        "rounded for display, "
        "while CSV values retain round-trip numerical precision. Missing gaps are unconnected. "
        "Frames are repeated observations, not independent biological "
        "replicates. No biological/clinical "
        "validation or calibrated truth is claimed. Verify every manifest checksum before reuse.\n"
    )
    return files


def publish(project, report_id, expected_plan, destination, check=None):
    """Stage metadata + exact retained masks, verify twice, then atomic no-replace."""
    _capability()

    def bound():
        if check:
            check()
        if not _same(plan(project, report_id, check), expected_plan):
            raise ValueError("Wound export inputs changed; prepare a fresh preview")

    bound()
    report = load(project, report_id, verify_sources=True, check=check)
    contents = _contents(report, expected_plan["status"])
    records = {
        name: {
            "sha256": hashlib.sha256(value.encode()).hexdigest(),
            "size_bytes": len(value.encode()),
        }
        for name, value in contents.items()
    }
    if sum(record["size_bytes"] for record in records.values()) > MAX_METADATA_BYTES:
        raise ValueError("Wound metadata export exceeds its bounded byte limit")
    masks = _mask_files(report)
    for entry in masks:
        records[entry["name"]] = {"sha256": entry["sha256"], "size_bytes": entry["size_bytes"]}
    contents["manifest.json"] = (
        canonical_json(
            {
                "schema": "loci.wound-closure-export-manifest/v1",
                "package_schema": "loci.wound-closure-package/v1",
                "report_hash": report["report_hash"],
                "plan_hash": expected_plan["plan_hash"],
                "export_software": expected_plan["export_software"],
                "files": [{"name": name, **value} for name, value in sorted(records.items())],
            }
        )
        + "\n"
    )
    records["manifest.json"] = {
        "sha256": hashlib.sha256(contents["manifest.json"].encode()).hexdigest(),
        "size_bytes": len(contents["manifest.json"].encode()),
    }
    target = _destination(project, destination)
    size = sum(record["size_bytes"] for record in records.values())
    if (
        len(records) > MAX_FILES
        or size > MAX_PACKAGE_BYTES
        or shutil.disk_usage(target.parent).free < size
    ):
        raise ValueError("Wound package exceeds its file, byte or available-disk budget")
    parent_fd = os.open(target.parent, _DIRECTORY_FLAGS)
    stage_name = ".loci-wound-" + uuid.uuid4().hex
    stage_fd = None
    stage_identity = None
    published = False
    parent_identity = _identity(os.fstat(parent_fd))
    try:
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise ValueError("Wound export destination parent changed")
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        stage_identity = _identity(os.fstat(stage_fd))
        for name, text in contents.items():
            if check:
                check()
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=stage_fd,
            )
            with os.fdopen(fd, "wb") as stream:
                encoded = text.encode()
                for offset in range(0, len(encoded), 65536):
                    if check:
                        check()
                    stream.write(encoded[offset : offset + 65536])
                stream.flush()
                os.fsync(stream.fileno())
        for entry in masks:
            if check:
                check()
            source_fd = os.open(
                project.arrays / (entry["sha256"] + ".npy"),
                _FILE_FLAGS | getattr(os, "O_NONBLOCK", 0),
            )
            destination_fd = None
            try:
                source_stat = os.fstat(source_fd)
                if (
                    not stat.S_ISREG(source_stat.st_mode)
                    or source_stat.st_size != entry["size_bytes"]
                ):
                    raise ValueError("Wound source mask type or byte size changed")
                destination_fd = os.open(
                    entry["name"],
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                    dir_fd=stage_fd,
                )
                with os.fdopen(destination_fd, "wb") as stream:
                    destination_fd = None
                    copied = 0
                    digest = hashlib.sha256()
                    while True:
                        if check:
                            check()
                        chunk = os.read(source_fd, min(65536, entry["size_bytes"] - copied + 1))
                        if not chunk:
                            break
                        copied += len(chunk)
                        if copied > entry["size_bytes"]:
                            raise ValueError("Wound source mask grew during export")
                        digest.update(chunk)
                        stream.write(chunk)
                    if copied != entry["size_bytes"] or digest.hexdigest() != entry["sha256"]:
                        raise ValueError("Wound source mask changed during export")
                    stream.flush()
                    os.fsync(stream.fileno())
            finally:
                if destination_fd is not None:
                    os.close(destination_fd)
                os.close(source_fd)
        os.fsync(stage_fd)
        _verify_files(stage_fd, records, check)
        bound()
        _verify_files(stage_fd, records, check)
        bound()
        if (
            target.parent.resolve(strict=True) != target.parent
            or parent_identity != _identity(target.parent.lstat())
            or stage_identity
            != _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
        ):
            raise ValueError("Wound publication directory changed")
        if check:
            check()
        _rename_noreplace(stage_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published = True
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise RuntimeError(
                "Wound package published; destination parent moved. Inspect before retrying"
            )
        os.fsync(parent_fd)
        return {
            "schema": "loci.wound-closure-export-receipt/v1",
            "basename": target.name,
            "report_hash": report["report_hash"],
            "manifest_sha256": records["manifest.json"]["sha256"],
        }
    finally:
        if stage_fd is not None:
            if not published:
                error = sys.exception()
                try:
                    with suppress(FileNotFoundError):
                        if (
                            _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
                            == stage_identity
                        ):
                            shutil.rmtree(stage_name, dir_fd=parent_fd)
                except OSError:
                    if error:
                        error.add_note("Owned wound export staging cleanup failed")
                    else:
                        raise
            os.close(stage_fd)
        os.close(parent_fd)


def execute_export(workbench, request, job_id=None, publication_guard=None):
    project = workbench.project
    document = _grant(project, request)
    data = document["data"]

    def check():
        if publication_guard:
            publication_guard()
        if _grant(project, request) != document:
            raise ValueError("Wound export grant changed")
        if job_id:
            job = project.job(job_id)
            if job["state"] != "running" or job["cancel_requested"]:
                raise ValueError("Wound export cancelled before publication")
        parent = Path(data["destination"]).parent
        if (
            parent.resolve(strict=True) != parent
            or list(_identity(parent.lstat())) != data["parent_identity"]
        ):
            raise ValueError("Granted wound export parent changed")

    receipt = publish(project, data["plan"]["report_id"], data["plan"], data["destination"], check)
    if job_id:
        project.update_job(
            job_id,
            expected_state="running",
            state="succeeded",
            progress=1.0,
            finished_at=timestamp(),
        )
    return receipt
