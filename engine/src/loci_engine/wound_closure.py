"""Pure bounded longitudinal filled-wound area arithmetic on exact label artifacts.

Filled-area semantics, specimen/sequence identity and unchanged field of view are
explicit user declarations, never inferred from mask appearance. Boundary and
skeleton inputs are not filled here. Callers authorize sources and verify their
bytes/dependencies before entry; this kernel executes no I/O, models or downloads.
"""

from __future__ import annotations

import copy
import hashlib
import math

import numpy as np

from .quantitative import (
    DEFAULT_WORKING_BYTES,
    MAX_OBJECTS,
    Geometry,
    exact_keys,
    integer,
    validate_array,
)
from .research_project import (
    MAX_ARTIFACT_BYTES,
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
)

SCHEMA = "loci.wound-closure/v1"
MAX_FRAMES = 1000
MAX_SNAPSHOT_BYTES = 12 * 1024**2
FILLED_AREA = "filled-wound-area"
RULES = {
    "area": "Union of explicitly selected positive filled-wound labels times pixel area",
    "semantics": "Explicit filled-area declaration; no boundary filling or anatomical inference",
    "baseline": "First scheduled frame must be observed with strictly positive selected area",
    "area_fraction": "Observed area divided by baseline area",
    "closure_fraction": "1 - area_fraction; negative values retain observed area growth",
    "intervals": (
        "Only adjacent scheduled observed slots; no bridging or interpolation across missing frames"
    ),
    "independence": "One declared longitudinal specimen/sequence, not independent frame replicates",
}
_ALLOWED_KINDS = {
    "segmentation",
    "cell-segmentation",
    "adaptive-segmentation",
    "cellpose-segmentation",
    "model-segmentation",
    "external-labels",
    "corrected-labels",
}
_DERIVED = {"spatial", "perinuclear", "tracking", "association", "derived_measurement_arrays"}
_SELECTION = {"x", "y", "width", "height", "t", "z", "c", "level"}


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _exact(value, keys, name):
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"{name} requires exactly the declared fields")


def _sha(value, name):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError(f"{name} requires an exact SHA-256")


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


class _ArrayDigest:
    """Streaming canonical NPY writer; no second whole-array byte allocation."""

    def __init__(self):
        self.digest = hashlib.sha256()
        self.size = 0

    def write(self, data):
        view = memoryview(data).cast("B")
        self.digest.update(view)
        self.size += view.nbytes
        return view.nbytes

    def tell(self):
        return self.size

    def flush(self):
        pass


def _artifact(array, descriptor, working_bytes):
    _exact(descriptor, {"sha256", "bytes", "shape", "dtype"}, "wound label artifact")
    _sha(descriptor["sha256"], "Wound label artifact")
    integer(descriptor["bytes"], "Wound artifact bytes", 1, MAX_ARTIFACT_BYTES + 4096)
    if (
        not isinstance(descriptor["shape"], list)
        or len(descriptor["shape"]) != 2
        or any(type(n) is not int or n < 1 for n in descriptor["shape"])
        or descriptor["shape"] != list(array.shape)
        or descriptor["dtype"] != str(array.dtype)
    ):
        raise ValueError("Wound label array and retained descriptor grid/dtype disagree")
    validate_array(array, labels=True, working_bytes=working_bytes)
    if array.ndim != 2:
        raise ValueError("Wound closure requires scalar YX label planes")
    if int(array.max()) > 0xFFFFFFFF:
        raise ValueError("Wound labels exceed the bounded positive label identity range")
    writer = _ArrayDigest()
    # Loci's ResearchProject.store_array uses this canonical allow_pickle=False
    # NPY representation. A different encoding fails closed, even for equal data.
    np.save(writer, array, allow_pickle=False)
    if writer.size != descriptor["bytes"] or writer.digest.hexdigest() != descriptor["sha256"]:
        raise ValueError("Wound label bytes do not match the exact retained artifact")


def _record(result):
    if (
        not isinstance(result, dict)
        or result.get("schema") != "loci.research-result/v1"
        or result.get("kind") not in _ALLOWED_KINDS
        or not isinstance(result.get("provenance"), dict)
        or not isinstance(result.get("arrays"), dict)
        or "labels" not in result["arrays"]
    ):
        raise ValueError("Wound area requires an underlying bounded label result record")
    checked_id(result.get("id"))
    checked_id(result.get("source_id"))
    _sha(result.get("source_sha256"), "Wound source")
    if result.get("revision_hash") != _hash(
        {k: v for k, v in result.items() if k != "revision_hash"}
    ):
        raise ValueError("Wound result revision failed integrity verification")
    p = result["provenance"]
    if _DERIVED & set(p):
        raise ValueError("Derived object/measurement results are not filled-wound area masks")
    # Known upstream declarations can never be overridden by the caller's claim.
    for key in ("mask_semantics", "label_semantics", "region_semantics"):
        if key in p and p[key] != FILLED_AREA:
            raise ValueError(
                "Boundary/skeleton or other mask semantics cannot represent filled wound area"
            )
    geometry = p.get("geometry")
    _exact(geometry, {"axes", "affine", "unit", "frame"}, "wound geometry")
    grid = Geometry(
        geometry["axes"],
        tuple(tuple(row) for row in geometry["affine"]),
        geometry["unit"],
        geometry["frame"],
    )
    if grid.axes != "YX":
        raise ValueError("Wound closure requires scalar YX geometry")
    spacing = grid.orthogonal_spacing()
    pixel_area = _finite(math.prod(spacing), "Wound pixel area")
    if pixel_area <= 0:
        raise ValueError("Wound pixel area must be strictly positive")
    selection = p.get("selection")
    _exact(selection, _SELECTION, "wound source selection")
    for key, value in selection.items():
        integer(value, f"wound selection {key}", 1 if key in {"width", "height"} else 0, 2**63 - 1)
    if result["arrays"]["labels"].get("shape") != [selection["height"], selection["width"]]:
        raise ValueError("Wound field of view and retained label shape disagree")
    return grid, selection, pixel_area


def _measure(
    frames, time_s, *, specimen_id, sequence_id, area_declaration, grid_declaration, working_bytes
):
    checked_text(specimen_id, "Explicit specimen identity")
    checked_text(sequence_id, "Explicit longitudinal sequence identity")
    checked_text(area_declaration, "Filled-wound area declaration", 2048)
    checked_text(grid_declaration, "Unchanged field-of-view/grid declaration", 2048)
    integer(working_bytes, "Wound working-memory budget", 1024**2, 8 * 1024**3)
    if not isinstance(frames, list) or not 2 <= len(frames) <= MAX_FRAMES:
        raise ValueError("Wound closure needs 2-1000 explicit observed/missing frame slots")
    if not isinstance(time_s, list) or len(time_s) != len(frames):
        raise ValueError("Explicit time_s must match every scheduled frame slot")
    times = [_finite(t, "Frame time_s") for t in time_s]
    if any(abs(t) > 1e15 for t in times) or any(
        a >= b for a, b in zip(times, times[1:], strict=False)
    ):
        raise ValueError("Frame times must be strictly increasing actual seconds within range")
    retained, metadata, frame_ids = 0, 0, set()
    workspace = 0
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError("Each wound frame must be an explicit observed/missing object")
        observed = "result" in frame
        keys = {"frame_id", "specimen_id", "sequence_id"} | (
            {"result", "labels", "selected_labels", "mask_semantics"}
            if observed
            else {"missing_reason"}
        )
        _exact(frame, keys, "wound frame")
        checked_text(frame["frame_id"], "Wound frame identity", 128)
        if frame["frame_id"] in frame_ids:
            raise ValueError("Wound frame identities must be unique")
        frame_ids.add(frame["frame_id"])
        if frame["specimen_id"] != specimen_id or frame["sequence_id"] != sequence_id:
            raise ValueError("All wound frames must declare the same specimen and sequence")
        if observed:
            array = frame["labels"]
            if not isinstance(array, np.ndarray):
                raise ValueError("Wound labels must be an explicit numeric ndarray")
            if array.ndim != 2 or array.dtype.kind not in "ui" or array.dtype.itemsize > 8:
                raise ValueError("Wound labels must be a scalar YX nonnegative integer array")
            retained += array.nbytes
            workspace = max(workspace, array.size * 64)
            selected = frame["selected_labels"]
            if not isinstance(selected, list) or len(selected) > MAX_OBJECTS:
                raise ValueError("Select a bounded explicit wound label union")
            metadata += len(canonical_json(frame["result"]).encode())
            metadata += len(canonical_json(selected).encode())
            if metadata > MAX_SNAPSHOT_BYTES:
                raise ValueError("Wound inputs exceed the bounded snapshot byte limit")
        else:
            checked_text(frame["missing_reason"], "Explicit missing wound frame reason", 512)
    if retained + workspace + metadata * 4 > working_bytes:
        raise ValueError("Wound series exceeds the aggregate working-memory budget")
    if "result" not in frames[0]:
        raise ValueError("Wound baseline must be the first scheduled observed frame")
    snapshots, rows, contract, acquisitions, results, sources = [], [], None, set(), set(), {}
    baseline = None
    for index, (frame, time) in enumerate(zip(frames, times, strict=True)):
        snapshot = {
            "frame_id": frame["frame_id"],
            "time_s": time,
            "specimen_id": specimen_id,
            "sequence_id": sequence_id,
        }
        row = {"frame_id": frame["frame_id"], "time_s": time}
        if "result" not in frame:
            snapshot["missing_reason"] = frame["missing_reason"]
            rows.append(
                {
                    **row,
                    "status": "missing",
                    "missing_reason": frame["missing_reason"],
                    "selected_pixel_count": None,
                    "excluded_positive_pixel_count": None,
                    "area": None,
                    "area_fraction": None,
                    "closure_fraction": None,
                }
            )
            snapshots.append(snapshot)
            continue
        if frame["mask_semantics"] != FILLED_AREA:
            raise ValueError(
                "Explicit filled-wound-area semantics are required; "
                "boundary/skeleton inputs are refused"
            )
        result, array = frame["result"], frame["labels"]
        grid, selection, pixel_area = _record(result)
        _artifact(array, result["arrays"]["labels"], working_bytes)
        current = {
            "geometry": grid.to_dict(),
            "field_of_view": {k: selection[k] for k in _SELECTION - {"t"}},
            "shape": list(array.shape),
        }
        if contract is None:
            contract = current
        elif canonical_json(current) != canonical_json(contract):
            raise ValueError(
                "Wound frames changed field of view, plane/channel, grid or calibration"
            )
        previous_source = sources.setdefault(result["source_id"], result["source_sha256"])
        if previous_source != result["source_sha256"]:
            raise ValueError("Wound frames contain conflicting source fingerprints")
        acquisition = result["source_id"], _hash(selection)
        if result["id"] in results or acquisition in acquisitions:
            raise ValueError(
                "Repeated revisions/acquisitions cannot become separate time observations"
            )
        results.add(result["id"])
        acquisitions.add(acquisition)
        selected = frame["selected_labels"]
        if not isinstance(selected, list) or len(selected) > MAX_OBJECTS:
            raise ValueError("Select a bounded explicit wound label union")
        for label in selected:
            integer(label, "Selected wound label", 1, 0xFFFFFFFF)
        if selected != sorted(set(selected)):
            raise ValueError("Selected wound labels must be unique and sorted")
        unique = np.unique(array)
        positive_count = len(unique) - int(len(unique) > 0 and unique[0] == 0)
        if positive_count > MAX_OBJECTS:
            raise ValueError("Wound masks exceed the bounded label population")
        available = {int(label) for label in unique if label != 0}
        if not set(selected) <= available:
            raise ValueError(
                "Selected wound labels are unknown or exceed the bounded label population"
            )
        pixels = int(np.count_nonzero(np.isin(array, selected)))
        excluded = int(np.count_nonzero(array)) - pixels
        area = _finite(pixels * pixel_area, "Selected wound area")
        if index == 0:
            if area <= 0:
                raise ValueError("Wound baseline selected area must be strictly positive")
            baseline = area
        fraction = _finite(area / baseline, "Wound area fraction")
        closure = _finite(1 - fraction, "Wound closure fraction")
        snapshot.update(
            result=copy.deepcopy(result), selected_labels=list(selected), mask_semantics=FILLED_AREA
        )
        snapshots.append(snapshot)
        rows.append(
            {
                **row,
                "status": "observed",
                "selected_pixel_count": pixels,
                "excluded_positive_pixel_count": excluded,
                "area": area,
                "area_fraction": fraction,
                "closure_fraction": closure,
            }
        )
    intervals = []
    for left, right in zip(rows, rows[1:], strict=False):
        dt = _finite(right["time_s"] - left["time_s"], "Interval seconds")
        observed = left["status"] == right["status"] == "observed"
        intervals.append(
            {
                "from_frame_id": left["frame_id"],
                "to_frame_id": right["frame_id"],
                "delta_time_s": dt,
                "status": "defined" if observed else "missing_endpoint",
                "area_change_rate": _finite((right["area"] - left["area"]) / dt, "Area change rate")
                if observed
                else None,
                "closure_change_rate": _finite(
                    (right["closure_fraction"] - left["closure_fraction"]) / dt,
                    "Closure change rate",
                )
                if observed
                else None,
            }
        )
    from .research_interchange import _reject_absolute_strings

    report = {
        "schema": SCHEMA,
        "rules": dict(RULES),
        "specimen_id": specimen_id,
        "sequence_id": sequence_id,
        "area_declaration": area_declaration,
        "grid_declaration": grid_declaration,
        "contract": contract,
        "time_unit": "s",
        "area_unit": f"{contract['geometry']['unit']}^2",
        "calibration_status": "uncalibrated-pixel-area"
        if contract["geometry"]["unit"] == "pixel"
        else "declared-physical-calibration",
        "baseline_frame_id": rows[0]["frame_id"],
        "baseline_area": baseline,
        "input_snapshots": snapshots,
        "frames": rows,
        "intervals": intervals,
    }
    _reject_absolute_strings(report, "Wound closure report")
    if len(canonical_json(report).encode()) > MAX_SNAPSHOT_BYTES:
        raise ValueError("Wound report exceeds the bounded snapshot byte limit")
    report["record_sha256"] = _hash(report)
    return report


def measure_wound_closure(
    frames,
    time_s,
    *,
    specimen_id,
    sequence_id,
    area_declaration,
    grid_declaration,
    working_bytes=DEFAULT_WORKING_BYTES,
):
    """Measure declared filled-area unions; missing slots never create gap slopes.

    Observed frames require exactly frame_id, specimen_id, sequence_id, result,
    labels (ndarray), selected_labels (sorted positive IDs), mask_semantics
    ('filled-wound-area'). Missing frames replace the last four keys with
    missing_reason. ``time_s`` explicitly covers every slot, including missing.
    Input arrays and source records are never mutated. Returned snapshots exclude
    arrays and private locators; artifact hashes bind the exact verified labels.
    """
    try:
        return _measure(
            frames,
            time_s,
            specimen_id=specimen_id,
            sequence_id=sequence_id,
            area_declaration=area_declaration,
            grid_declaration=grid_declaration,
            working_bytes=working_bytes,
        )
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError("Malformed wound closure input or retained result") from exc
