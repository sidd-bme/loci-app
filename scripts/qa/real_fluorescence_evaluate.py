#!/usr/bin/env python3
"""Independent NumPy/SciPy oracle. No Loci imports, segmentation, or model calls.

Reference evaluation is evaluator-only. Do not grant references or reports to an
agent before its recipe, source identity, and predicted label files are frozen.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import zipfile
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from scipy import ndimage
from scipy.optimize import linear_sum_assignment

MAX_PIXELS = 16_000_000
MAX_INSTANCES = 5000
MAX_JSON_BYTES = 4 << 20
PROTOCOL_SHA256 = "c8e574c7beee5108709cd92046b6b2ccde79ac0b9c7827cbe9dccac098c99bfa"
OFFICIAL_ARCHIVES = {
    "BBBC039v1": {
        "039-images": "6f30a5d4fe38c928ded972704f085975f8dc0d65d9aa366df00e5a9d449fddd7",
        "039-masks": "f9e6043d8ca56344a4886f96a700d804d6ee982f31e2b2cd3194af2a053c2710",
    },
    "BBBC013v1": {
        "013-bmp": "c059b569d96f70ad5626fad144867e6ece4353622119c46a8af8f9794f1e7985",
        "013-reproduction": "5ab59bbaddf75fee08436d2d7cfc7460ebfdaa6fdf1b8adb71274c7c27f885f3",
    },
}
PERINUCLEAR_ENDPOINT = "bbbc013-native-perinuclear-v1"
# Evaluator-owned frozen rules. Never import production numerical code or rules.
PERINUCLEAR_RULES = {
    "distance_basis": "Euclidean pixel-center distance on native YX indices; inclusive radius",
    "overlap_policy": "discard every pixel claimed by more than one nucleus",
    "nucleus_policy": "all positive nucleus labels block and compete, including excluded nuclei",
    "boundary_policy": "exclude nuclei touching the full source image boundary",
    "empty_policy": "empty ring count/sum zero and mean null; excluded ratio null",
    "zero_policy": "zero-mean rings excluded; no epsilon, imputation or intensity gate",
    "signal_policy": (
        "nonnegative raw selected-plane samples; reject negatives without clipping or offset"
    ),
    "interpretation": "nuclear-to-perinuclear-ring enrichment proxy; not true cytoplasm",
    "endpoint": "median of eligible per-object nuclear-mean / ring-mean raw signal ratios",
}
PERINUCLEAR_REASONS = ("boundary-touching-nucleus", "empty-ring", "zero-mean-ring")


def canonical_sha256(value) -> str:
    """Snapshot trust pins use UTF-8 sorted compact JSON, with nonfinite rejected."""
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def file_identity(path: Path) -> dict:
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError("Evaluation inputs cannot traverse symlinks")
    if not path.is_file():
        raise ValueError("Evaluation inputs must be regular files")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return {
        "path": str(path.resolve()),
        "sha256": digest.hexdigest(),
        "bytes": path.stat().st_size,
    }


def verified_file(record: dict, expected_sha256: str | None = None) -> Path:
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        raise TypeError("Missing pinned file record")
    digest = record.get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid expected SHA-256")
    if expected_sha256 is not None and digest != expected_sha256:
        raise ValueError("File record differs from independently supplied trust pin")
    path = Path(record["path"])
    actual = file_identity(path)
    if actual["sha256"] != digest or actual["bytes"] != record.get("bytes"):
        raise ValueError("Pinned file identity changed")
    return path


def read_json(path: Path) -> dict:
    if path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("JSON evidence exceeds evaluator bound")

    def reject_nonfinite(value):
        raise ValueError(f"Nonfinite JSON: {value}")

    value = json.loads(path.read_text(), parse_constant=reject_nonfinite)
    if not isinstance(value, dict):
        raise TypeError("Expected a JSON object")
    return value


def _pinned_json(record: dict, expected_sha256: str | None = None) -> dict:
    return read_json(verified_file(record, expected_sha256))


def _verified_archive_member(archive: dict, member: dict) -> None:
    """Link a member's bytes to the pinned official archive, not just a JSON claim."""
    path = verified_file(archive)
    with zipfile.ZipFile(path) as bundle:
        info = bundle.getinfo(member["archive_member"])
        if info.file_size != member["bytes"] or info.file_size > 128 << 20:
            raise ValueError("Official archive member size differs")
        digest = hashlib.sha256()
        with bundle.open(info) as source:
            for block in iter(lambda: source.read(1 << 20), b""):
                digest.update(block)
        if digest.hexdigest() != member["sha256"]:
            raise ValueError("Official archive member bytes differ")
    verified_file(member)


def _native_export(directory: Path, expected_sha256: str) -> tuple[dict, dict, dict]:
    """Verify the concrete Loci export schema, including every original file."""
    manifest_path = directory / "manifest.json"
    identity = file_identity(manifest_path)
    if identity["sha256"] != expected_sha256:
        raise ValueError("Native export manifest differs from trusted run binding")
    manifest = read_json(manifest_path)
    if manifest.get("schema") != "loci.export-manifest/v1":
        raise ValueError("Unsupported native export manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) > 1000:
        raise ValueError("Invalid native export file table")
    names = set()
    for item in files:
        name = item.get("name")
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or name in ("", ".", "..")
            or "\\" in name
            or name.casefold() in names
        ):
            raise ValueError("Unsafe or duplicate native export member")
        names.add(name.casefold())
        verified_file(
            {
                "path": str(directory / name),
                "sha256": item.get("sha256"),
                "bytes": item.get("size_bytes"),
            }
        )
    if not {"result.json", "loci-export.json", "labels.npy", "labels.ome.tif"}.issubset(
        names
    ):
        raise ValueError("Native export lacks required provenance/label files")
    payload, marker = (
        read_json(directory / "result.json"),
        read_json(directory / "loci-export.json"),
    )
    result = payload.get("result", {})
    if (
        marker.get("schema") != "loci.export-marker/v1"
        or marker.get("bundle_kind") != "loci-export"
    ):
        raise ValueError("Invalid native export marker")
    if (
        any(
            manifest.get(key) != marker.get(key)
            for key in ("result_id", "revision_hash")
        )
        or manifest.get("result_id") != result.get("id")
        or manifest.get("revision_hash") != result.get("revision_hash")
    ):
        raise ValueError("Stale native export result/revision binding")
    return manifest, payload, {"manifest": identity, "files_verified": len(files)}


def _load_labels(path: Path) -> np.ndarray:
    if path.stat().st_size > MAX_PIXELS * 8 + (1 << 16):
        raise ValueError("Label file exceeds evaluator bound")
    with path.open("rb") as source:
        version = np.lib.format.read_magic(source)
        if version == (1, 0):
            shape, _, dtype = np.lib.format.read_array_header_1_0(source)
        elif version == (2, 0):
            shape, _, dtype = np.lib.format.read_array_header_2_0(source)
        else:
            raise ValueError("Unsupported NPY label header")
    if (
        len(shape) != 2
        or min(shape) < 1
        or np.prod(shape, dtype=object) > MAX_PIXELS
        or dtype.kind not in "ui"
        or dtype.itemsize > 4
    ):
        raise ValueError("Unsupported NPY label axes/dtype/shape")
    return labels_2d(np.load(path, allow_pickle=False))


def validate_qualification_packet(
    packet: dict, *, settings_sha256: str, run_binding_sha256: str
) -> dict:
    """Validate source/run bindings and, for endpoint packets, raw arithmetic.

    The two SHA arguments are independently supplied evaluator trust pins, NOT
    read from the packet itself. Settings are frozen before predictions. The
    separate lead-owned run binding pins the native export and actual execution
    identity before reference outcomes are opened. App execution identity still
    relies on that trusted GUI/MCP launch receipt: native exports do not attest
    app/worker hashes. This validator is not a substitute for that receipt.

    settings schema v1 fields: protocol, prepared_manifest, source_manifest,
    reference_manifest (pinned file records), dataset, raw_variant (original or
    prepared), recipe/runtime (pinned JSON records), app/worker (pinned actual
    files). recipe is native accepted_request without source_id.

    run-binding v1 fields: settings_sha256, source_key, source_sha256, result_id,
    revision_hash, export_manifest_sha256, recipe/runtime/app/worker_sha256,
    labels_npy_sha256, labels_uint32le_sha256; created by an explicit trusted
    native-export adapter, never inferred from an untrusted packet.

    packet v1 fields: settings_freeze/run_binding/raw/reference (file records),
    source_key, export_directory. A BBBC013 reference is the official corrected
    reproduction metadata CSV, not a nonexistent segmentation ground truth.

    Native BBBC013 children require endpoint=bbbc013-native-perinuclear-v1 in
    settings AND run. Replace recipe/runtime with nucleus_recipe/nucleus_runtime,
    ring_request/ring_rules/ring_runtime pinned JSON records (same-named SHA fields
    in run). nucleus_recipe is the parent's accepted_request without source_id;
    ring_request has exactly signal_channel,radius_px,control,working_bytes (target
    ID/revision varies by well). ring_rules equals PERINUCLEAR_RULES. Trusted run
    additionally pins nucleus_result {result_id,revision_hash}, plus canonical
    nucleus_analysis_sha256 and parent_result_sha256 of the retained child
    provenance snapshots. The lead receipt must attest these against the actual
    parent before export. A standalone parent export is unnecessary. No value
    supplied only by this untrusted packet can establish those pins.
    To check parent DNA measurements too, packet.parent_export_directory and
    run.parent_export_manifest_sha256 supply an independently pinned native parent
    export. Without both, parent_numeric_status explicitly reports the gap.
    """
    if packet.get("schema") != "loci.real-fluorescence.qualification-packet/v1":
        raise ValueError("Unsupported qualification packet")
    settings = _pinned_json(packet.get("settings_freeze"), settings_sha256)
    run = _pinned_json(packet.get("run_binding"), run_binding_sha256)
    if (
        settings.get("schema") != "loci.real-fluorescence.settings-freeze/v1"
        or run.get("schema") != "loci.real-fluorescence.run-binding/v1"
        or run.get("settings_sha256") != settings_sha256
    ):
        raise ValueError("Settings/run binding is missing, stale or unsupported")
    dataset, key = settings.get("dataset"), packet.get("source_key")
    if dataset not in OFFICIAL_ARCHIVES or run.get("source_key") != key:
        raise ValueError("Dataset/source key differs from frozen run")
    endpoint = settings.get("endpoint")
    perinuclear = endpoint == PERINUCLEAR_ENDPOINT
    if (endpoint is not None and not perinuclear) or run.get("endpoint") != endpoint:
        raise ValueError("Unsupported or mismatched endpoint variant")
    if perinuclear and dataset != "BBBC013v1":
        raise ValueError("Perinuclear endpoint requires BBBC013")
    verified_file(settings.get("protocol"), PROTOCOL_SHA256)
    prepared = _pinned_json(settings.get("prepared_manifest"))
    sources = _pinned_json(settings.get("source_manifest"))
    references = _pinned_json(settings.get("reference_manifest"))
    archives = {
        item["key"]: item
        for group in (sources, references)
        for item in group.get("sources", [])
    }
    for name, expected in OFFICIAL_ARCHIVES[dataset].items():
        verified_file(archives.get(name), expected)
    entries = [
        item
        for item in prepared.get("images", [])
        if item.get("reference_filename" if dataset == "BBBC039v1" else "well") == key
    ]
    if len(entries) != 1:
        raise ValueError("Source key is not unique in pinned preparation manifest")
    entry = entries[0]
    if dataset == "BBBC039v1" and Path(entry["source"]["path"]).stem != Path(key).stem:
        raise ValueError(
            "Official image/reference filenames do not identify the same field"
        )
    variant = settings.get("raw_variant")
    if variant not in ("original", "prepared") or (
        dataset == "BBBC013v1" and variant != "prepared"
    ):
        raise ValueError("Unsupported frozen raw variant")
    expected_raw = entry["source" if variant == "original" else "derived"]
    if (
        Path(packet.get("raw", {}).get("path", "")).absolute()
        != Path(expected_raw["path"]).absolute()
    ):
        raise ValueError("Raw path differs from the pinned preparation input")
    raw_path = verified_file(packet.get("raw"), expected_raw["sha256"])
    if packet["raw"]["bytes"] != expected_raw["bytes"]:
        raise ValueError("Raw size differs from pinned preparation")
    image_archive = archives["039-images" if dataset == "BBBC039v1" else "013-bmp"]
    original_records = [entry["source"]] if dataset == "BBBC039v1" else entry["sources"]
    for original in original_records:
        matches = [
            member
            for member in image_archive.get("members", [])
            if Path(member["path"]).name == Path(original["path"]).name
            and member["sha256"] == original["sha256"]
        ]
        if len(matches) != 1:
            raise ValueError("Prepared source is not an official archive member")
        _verified_archive_member(image_archive, matches[0])
    ref_path = verified_file(packet.get("reference"))
    reference_archive = archives[
        "039-masks" if dataset == "BBBC039v1" else "013-reproduction"
    ]
    reference_name = (
        key
        if dataset == "BBBC039v1"
        else (
            "Bioimage_CP2_Dose_WellMetadata_wortmannin.csv"
            if key[0] in "ABCD"
            else "Bioimage_CP2_Dose_WellMetadata_LY294002_Corrected_EFGH01_Controls.csv"
        )
    )
    matching_refs = [
        member
        for member in reference_archive.get("members", [])
        if Path(member["path"]).name == reference_name
        and member["sha256"] == packet["reference"]["sha256"]
    ]
    if ref_path.name != reference_name or len(matching_refs) != 1:
        raise ValueError("Reference name/identity does not match the official source")
    _verified_archive_member(reference_archive, matching_refs[0])
    if dataset == "BBBC013v1":
        rows = [
            row
            for row in csv.DictReader(ref_path.open())
            if row["Metadata_Well"] == key
        ]
        if len(rows) != 1 or [
            rows[0]["Image_FileName_rawGFP"],
            rows[0]["Image_FileName_rawDNA"],
        ] != [Path(record["path"]).name for record in entry["sources"]]:
            raise ValueError("Official well/channel metadata differs from preparation")
    with tifffile.TiffFile(raw_path) as image:
        series = image.series[0]
        if (
            series.axes != entry["axes"]
            or list(series.shape) != entry["shape"]
            or str(series.dtype) != entry["dtype"]
        ):
            raise ValueError("Raw axes/shape/dtype differs from pinned preparation")
        raw_pixels = series.asarray()
    if variant == "prepared":
        if dataset == "BBBC039v1":
            originals = tifffile.imread(entry["source"]["path"])
        else:
            channels = []
            for record in entry["sources"]:
                with Image.open(record["path"]) as image:
                    channels.append(np.asarray(image.convert("L")))
            originals = np.stack(channels)
        if not np.array_equal(raw_pixels, originals):
            raise ValueError("Prepared input pixels differ from official raw samples")
    directory = Path(packet.get("export_directory", ""))
    manifest, payload, bundle = _native_export(
        directory, run.get("export_manifest_sha256")
    )
    result, source = payload["result"], payload["source"]
    provenance = result["provenance"]
    if (
        run.get("result_id") != result["id"]
        or run.get("revision_hash") != result["revision_hash"]
    ):
        raise ValueError("Native export is stale relative to trusted run revision")
    source_hash = packet["raw"]["sha256"]
    if any(
        value != source_hash
        for value in (
            run.get("source_sha256"),
            result.get("source_sha256"),
            source.get("sha256"),
            source.get("metadata", {}).get("sha256"),
            provenance.get("channel_metadata", {}).get("source_sha256"),
        )
    ):
        raise ValueError(
            "Native export source fingerprint differs from actual raw input"
        )
    analysis = provenance.get("nucleus_analysis", {}) if perinuclear else {}
    recipe_provenance = analysis.get("provenance", {}) if perinuclear else provenance
    accepted = recipe_provenance.get("accepted_request", {})
    if any(
        value != source.get("id")
        for value in (
            result.get("source_id"),
            accepted.get("source_id"),
            provenance.get("channel_metadata", {}).get("source_id"),
        )
    ):
        raise ValueError("Native export source IDs disagree")
    if (
        source.get("identity_kind") != "full-file-sha256"
        or source.get("size_bytes") != packet["raw"]["bytes"]
        or source.get("metadata", {}).get("source_axes") != entry["axes"]
        or source.get("metadata", {}).get("source_shape") != entry["shape"]
    ):
        raise ValueError("Native export source identity/axes is unsupported")
    frozen_names = (
        (
            "nucleus_recipe",
            "nucleus_runtime",
            "ring_request",
            "ring_rules",
            "ring_runtime",
        )
        if perinuclear
        else ("recipe", "runtime")
    )
    for name in (*frozen_names, "app", "worker"):
        verified_file(settings.get(name))
        if run.get(name + "_sha256") != settings[name]["sha256"]:
            raise ValueError("Run execution identity differs from frozen " + name)
    recipe = _pinned_json(settings["nucleus_recipe" if perinuclear else "recipe"])
    native_recipe = {k: value for k, value in accepted.items() if k != "source_id"}
    if native_recipe != recipe or recipe_provenance.get("runtime") != _pinned_json(
        settings["nucleus_runtime" if perinuclear else "runtime"]
    ):
        raise ValueError(
            "Native recipe/runtime differs from independently frozen settings"
        )
    if (
        accepted.get("measurement_channels") != ([1] if perinuclear else [0])
        or provenance.get("measurement_channels") != [0]
        or provenance.get("measurement_basis")
        != "raw-selected-channel-values-on-result-grid"
    ):
        raise ValueError("Raw measurement channel/basis differs from protocol")
    selection = accepted.get("selection", {})
    width, height = entry["shape"][-1], entry["shape"][-2]
    if any(
        selection.get(k) != value
        for k, value in {
            "x": 0,
            "y": 0,
            "width": width,
            "height": height,
            "level": 0,
            "z": 0,
            "t": 0,
        }.items()
    ):
        raise ValueError("Native prediction is not the full original result grid")
    if accepted.get("input_mapping") != {
        "mode": "source-channel",
        "channel": 0 if dataset == "BBBC039v1" else 1,
    }:
        raise ValueError("Segmentation source channel differs from protocol")
    if perinuclear and (
        selection.get("c") != 1
        or recipe_provenance.get("measurement_channels") != [1]
        or recipe_provenance.get("measurement_basis")
        != "raw-selected-channel-values-on-result-grid"
        or recipe_provenance.get("channel_metadata")
        != provenance.get("channel_metadata")
    ):
        raise ValueError(
            "Nucleus analysis DNA channel/source metadata differs from protocol"
        )
    labels_record = result.get("arrays", {}).get("labels", {})
    npy_path = directory / "labels.npy"
    npy_identity = file_identity(npy_path)
    if (
        npy_identity["sha256"] != run.get("labels_npy_sha256")
        or npy_identity["sha256"] != labels_record.get("sha256")
        or npy_identity["bytes"] != labels_record.get("bytes")
    ):
        raise ValueError("Prediction label artifact differs from native/frozen export")
    labels = _load_labels(npy_path)
    if (
        list(labels.shape) != [height, width]
        or list(labels.shape) != labels_record.get("shape")
        or str(labels.dtype) != labels_record.get("dtype")
    ):
        raise ValueError("Prediction label axes/dtype/shape differs from native export")
    label_hash = hashlib.sha256(
        labels.astype("<u4", copy=False).tobytes(order="C")
    ).hexdigest()
    if label_hash != run.get("labels_uint32le_sha256"):
        raise ValueError("Prediction label pixels differ from trusted run")
    with tifffile.TiffFile(directory / "labels.ome.tif") as image:
        if image.series[0].shape != labels.shape or not np.array_equal(
            image.asarray(), labels
        ):
            raise ValueError("Native NPY and TIFF predictions differ")
    parent_numeric_status = None
    if perinuclear:
        parent_numeric_status = _validate_native_perinuclear(
            settings, run, result, raw_pixels, labels, directory, manifest
        )
        parent_directory = packet.get("parent_export_directory")
        parent_pin = run.get("parent_export_manifest_sha256")
        if (parent_directory is None) != (parent_pin is None):
            raise ValueError(
                "Parent export requires its independently trusted manifest pin"
            )
        if parent_directory is not None:
            _validate_native_parent(
                Path(parent_directory),
                parent_pin,
                result,
                source,
                raw_pixels[1],
                labels,
            )
            parent_numeric_status = "verified-DNA1-parent-rows-and-labels"
    return {
        "binding_status": "verified-inputs-only; no accuracy or biological qualification",
        "dataset": dataset,
        "source_key": key,
        "raw": file_identity(raw_path),
        "reference": file_identity(ref_path),
        "prediction": npy_identity,
        "settings_sha256": settings_sha256,
        "run_binding_sha256": run_binding_sha256,
        "native_export": bundle,
        "result_id": manifest["result_id"],
        "revision_hash": manifest["revision_hash"],
        "execution_identity_authority": "independently trusted lead GUI/MCP run binding; not native attestation",
        **(
            {
                "endpoint": endpoint,
                "arithmetic_status": "verified-all-native-endpoint-rows-and-masks",
                "parent_numeric_status": parent_numeric_status,
            }
            if perinuclear
            else {}
        ),
    }


def _compare_scientific(actual, expected, context="measurement") -> None:
    """Exact counts/sums and schema; protocol tolerance for derived floats only."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or set(actual) != set(expected):
            raise ValueError(f"Native {context} fields differ from independent oracle")
        for key, value in expected.items():
            _compare_scientific(actual[key], value, f"{context}.{key}")
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            raise ValueError(f"Native {context} length differs from independent oracle")
        for index, value in enumerate(expected):
            _compare_scientific(actual[index], value, f"{context}[{index}]")
    elif type(expected) is float:
        if (
            type(actual) not in (float, int)
            or not np.isfinite(actual)
            or abs(actual - expected) > 1e-9 + 1e-12 * abs(expected)
        ):
            raise ValueError(f"Native {context} differs from independent float oracle")
    elif type(expected) is int:
        if type(actual) not in (int, float) or actual != expected:
            raise ValueError(f"Native {context} differs from exact integer oracle")
    elif type(actual) is not type(expected) or actual != expected:
        raise ValueError(f"Native {context} differs from independent oracle")


def _native_endpoint_oracle(
    raw, labels, *, compute_rings=True
) -> tuple[dict, list[dict], np.ndarray, np.ndarray]:
    """All native row fields, retaining edge rings for their excluded QC rows.

    The reporting-only enrichment() omits edge rings; native persisted masks
    retain them. Both obey all-nuclei competition and exclude edge ratios.
    """
    nuclear = masked_measurements(raw, labels)
    claims = np.zeros(labels.shape, dtype=np.uint16)
    owners = np.zeros(labels.shape, dtype=np.uint32)
    for item in nuclear if compute_rings else []:
        candidate = (ndimage.distance_transform_edt(labels != item["label"]) <= 5) & (
            labels == 0
        )
        claims[candidate] += 1
        owners[candidate] = item["label"]
    owners[claims != 1] = 0
    rings = {item["label"]: item for item in masked_measurements(raw, owners)}
    rows, centers = [], []
    for item in nuclear:
        label = item["label"]
        coordinates = np.argwhere(labels == label)
        start, stop = coordinates.min(axis=0), coordinates.max(axis=0) + 1
        # Frozen native uncalibrated geometry: world is x,y,0; index is y,x.
        world = np.column_stack((coordinates[:, ::-1], np.zeros(len(coordinates))))
        center = world.mean(axis=0)
        covariance = (
            np.cov(world, rowvar=False, bias=True)
            if len(world) > 1
            else np.zeros((3, 3))
        )
        boundary = bool(np.any(start == 0) or np.any(stop == labels.shape))
        ring = rings.get(label, {"area_pixels": 0, "sum": 0, "mean": None})
        reasons = [PERINUCLEAR_REASONS[0]] if boundary else []
        if not ring["area_pixels"]:
            reasons.append(PERINUCLEAR_REASONS[1])
        elif ring["sum"] == 0:
            reasons.append(PERINUCLEAR_REASONS[2])
        values = raw[labels == label].astype(np.float64)
        rows.append(
            {
                "label": label,
                "voxel_count": item["area_pixels"],
                "measure": float(item["area_pixels"]),
                "measure_kind": "area",
                "measure_unit": "pixel^2",
                "centroid_index": coordinates.mean(axis=0).tolist(),
                "index_axes": "YX",
                "centroid_world_xyz": center.tolist(),
                "world_frame": "image",
                "distance_unit": "pixel",
                "bbox_start": start.tolist(),
                "bbox_stop_exclusive": stop.tolist(),
                "principal_rms_radii": np.sqrt(
                    np.maximum(np.linalg.eigvalsh(covariance), 0)[::-1]
                ).tolist(),
                "touches_crop_border": boundary,
                "intensity": {
                    "source_channel_0": {
                        "sum": item["sum"],
                        "mean": item["mean"],
                        "min": int(values.min()),
                        "max": int(values.max()),
                        "std_population": float(values.std(ddof=0)),
                    }
                },
                "perinuclear_ring": {
                    "count": ring["area_pixels"],
                    "sum": ring["sum"],
                    "mean": ring["mean"],
                    "exclusions": reasons,
                    "nuclear_to_ring_mean_ratio": None
                    if reasons
                    else item["mean"] / ring["mean"],
                },
            }
        )
        centers.append(center)
    for index, row in enumerate(rows):
        row["nearest_centroid_distance"] = (
            float(
                min(
                    np.linalg.norm(centers[index] - other)
                    for j, other in enumerate(centers)
                    if j != index
                )
            )
            if len(rows) > 1
            else None
        )
    ratios = [
        row["perinuclear_ring"]["nuclear_to_ring_mean_ratio"]
        for row in rows
        if not row["perinuclear_ring"]["exclusions"]
    ]
    summary = {
        "object_count": len(rows),
        "eligible_count": len(ratios),
        "excluded_count": len(rows) - len(ratios),
        "excluded_by_reason": {
            reason: sum(reason in row["perinuclear_ring"]["exclusions"] for row in rows)
            for reason in PERINUCLEAR_REASONS
        },
        "endpoint_defined": bool(ratios),
        "median_ratio": float(np.median(ratios)) if ratios else None,
        "mean_ratio": float(np.mean(ratios, dtype=np.float64)) if ratios else None,
    }
    return summary, rows, owners, (claims > 1).astype(np.uint8)


def _validate_native_perinuclear(
    settings, run, result, raw, labels, directory, manifest
):
    provenance = result["provenance"]
    analysis, parent = (
        provenance.get("nucleus_analysis"),
        provenance.get("parent_result"),
    )
    if (
        not isinstance(analysis, dict)
        or not isinstance(parent, dict)
        or (
            set(analysis) != {"kind", "engine_version", "provenance"}
            or not isinstance(analysis.get("engine_version"), str)
            or not analysis["engine_version"]
            or analysis.get("kind") not in {"segmentation", "adaptive-segmentation"}
            or canonical_sha256(analysis) != run.get("nucleus_analysis_sha256")
            or canonical_sha256(parent) != run.get("parent_result_sha256")
        )
    ):
        raise ValueError(
            "Retained nucleus analysis/parent snapshot differs from trusted run"
        )
    nucleus = run.get("nucleus_result", {})
    if (
        set(nucleus) != {"result_id", "revision_hash"}
        or not isinstance(nucleus["result_id"], str)
        or not nucleus["result_id"]
        or not isinstance(nucleus["revision_hash"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", nucleus["revision_hash"])
        or any(parent.get(key) != nucleus[key] for key in nucleus)
        or result.get("parent_id") != nucleus["result_id"]
        or parent.get("source_id") != result["source_id"]
        or parent.get("source_sha256") != result["source_sha256"]
        or parent.get("arrays", {}).get("labels") != result["arrays"]["labels"]
        or parent.get("selection")
        != analysis["provenance"]["accepted_request"]["selection"]
    ):
        raise ValueError("Child labels/source differ from bound nucleus result")
    geometry = {
        "axes": "YX",
        "unit": "pixel",
        "frame": "image",
        "affine": np.eye(4).tolist(),
    }
    if parent.get("geometry") != geometry or provenance.get("geometry") != geometry:
        raise ValueError("Perinuclear geometry is not the native uncalibrated grid")
    expected_selection = {**parent["selection"], "c": 0}
    if provenance.get("selection") != expected_selection:
        raise ValueError("Perinuclear GFP channel/grid differs from nucleus input")
    record = provenance.get("perinuclear", {})
    request = _pinned_json(settings["ring_request"])
    rules = _pinned_json(settings["ring_rules"])
    native_request = {
        "signal_channel": record.get("signal_channel"),
        "radius_px": record.get("radius_px"),
        "control": record.get("control"),
        "working_bytes": provenance.get("resource_guard", {}).get(
            "working_memory_limit_bytes"
        ),
    }
    if (
        result.get("kind") != "perinuclear-enrichment"
        or set(record)
        != {
            "schema",
            "radius_px",
            "control",
            "signal_channel",
            "nucleus_result",
            "summary",
            *PERINUCLEAR_RULES,
        }
        or record.get("schema") != "loci.perinuclear-enrichment/v1"
        or record.get("nucleus_result") != nucleus
        or rules != PERINUCLEAR_RULES
        or any(record.get(key) != value for key, value in PERINUCLEAR_RULES.items())
        or request != native_request
        or type(request.get("radius_px")) not in (int, float)
        or request["radius_px"] != 5
        or type(request.get("signal_channel")) is not int
        or request["signal_channel"] != 0
        or type(request.get("working_bytes")) is not int
        or not 1024**2 <= request["working_bytes"] <= 8 * 1024**3
        or not isinstance(request.get("control"), str)
        or not request["control"].strip()
        or provenance.get("runtime") != _pinned_json(settings["ring_runtime"])
    ):
        raise ValueError(
            "Native ring request/rules/runtime differs from frozen endpoint"
        )
    if (
        raw.ndim != 3
        or raw.shape[0] != 2
        or raw.dtype != np.uint8
        or labels.dtype != np.uint32
    ):
        raise ValueError("BBBC013 endpoint requires exact prepared uint8 CYX GFP0/DNA1")
    with tifffile.TiffFile(directory / "labels.ome.tif") as image:
        if image.series[0].axes != "YX" or image.series[0].dtype != labels.dtype:
            raise ValueError("Native endpoint TIFF labels have wrong axes/dtype")
    files = {item["name"] for item in manifest["files"]}
    arrays = result["arrays"]
    if set(arrays) != {"image", "labels", "ring_labels", "ring_ambiguous"}:
        raise ValueError("Native endpoint array set differs")
    summary, expected_rows, rings, ambiguous = _native_endpoint_oracle(raw[0], labels)
    for name, expected in {
        "image": raw[0],
        "ring_labels": rings,
        "ring_ambiguous": ambiguous,
    }.items():
        if not {name + ".npy", name + ".ome.tif"} <= files:
            raise ValueError("Native endpoint export lacks pinned array formats")
        path = directory / (name + ".npy")
        identity = file_identity(path)
        descriptor = arrays[name]
        if any(identity[key] != descriptor.get(key) for key in ("sha256", "bytes")):
            raise ValueError("Native endpoint array descriptor differs")
        actual = _load_labels(path)
        if (
            actual.dtype != expected.dtype
            or actual.shape != expected.shape
            or descriptor.get("shape") != list(expected.shape)
            or descriptor.get("dtype") != str(expected.dtype)
            or not np.array_equal(actual, expected)
        ):
            raise ValueError("Native endpoint raw image/ring mask differs from oracle")
        with tifffile.TiffFile(directory / (name + ".ome.tif")) as image:
            series = image.series[0]
            if (
                series.axes != "YX"
                or series.dtype != actual.dtype
                or not np.array_equal(series.asarray(), actual)
            ):
                raise ValueError("Native endpoint NPY/TIFF arrays differ")
    _compare_scientific(provenance.get("measurements"), expected_rows)
    _compare_scientific(record["summary"], summary, "summary")
    _check_object_csv(directory, files, provenance["measurements"])
    return "not_checked_without_parent_export"


def _validate_native_parent(
    directory, manifest_pin, child, child_source, raw_dna, labels
):
    manifest, payload, _ = _native_export(directory, manifest_pin)
    parent = payload["result"]
    binding = child["provenance"]["parent_result"]
    if binding != {
        "result_id": parent.get("id"),
        "revision_hash": parent.get("revision_hash"),
        "source_id": parent.get("source_id"),
        "source_sha256": parent.get("source_sha256"),
        "arrays": parent.get("arrays"),
        "geometry": parent.get("provenance", {}).get("geometry"),
        "selection": parent.get("provenance", {}).get("selection"),
    }:
        raise ValueError(
            "Standalone parent export disagrees with bound parent snapshot"
        )
    analysis = child["provenance"]["nucleus_analysis"]
    parent_provenance = parent["provenance"]
    source = payload.get("source", {})
    if (
        analysis["kind"] != parent.get("kind")
        or analysis["engine_version"] != parent.get("engine_version")
        or any(
            parent_provenance.get(key) != value
            for key, value in analysis["provenance"].items()
        )
        or source.get("sha256") != child["source_sha256"]
        or source.get("metadata", {}).get("sha256") != child["source_sha256"]
        or source.get("id") != child["source_id"]
        or source.get("identity_kind") != "full-file-sha256"
        or source.get("size_bytes") != child_source["size_bytes"]
        or source.get("metadata", {}).get("source_axes") != "CYX"
        or source.get("metadata", {}).get("source_shape") != [2, *labels.shape]
    ):
        raise ValueError(
            "Standalone parent analysis/source differs from child snapshot"
        )
    actual_labels = _load_labels(directory / "labels.npy")
    if (
        file_identity(directory / "labels.npy")["sha256"]
        != binding["arrays"]["labels"]["sha256"]
        or actual_labels.dtype != labels.dtype
        or not np.array_equal(actual_labels, labels)
    ):
        raise ValueError("Standalone parent label pixels differ from child")
    with tifffile.TiffFile(directory / "labels.ome.tif") as image:
        if (
            image.series[0].axes != "YX"
            or image.series[0].dtype != labels.dtype
            or not np.array_equal(image.asarray(), labels)
        ):
            raise ValueError("Standalone parent TIFF labels differ from child")
    _, expected_rows, _, _ = _native_endpoint_oracle(
        raw_dna, labels, compute_rings=False
    )
    for row in expected_rows:
        del row["perinuclear_ring"]
        row["intensity"] = {"source_channel_1": row["intensity"]["source_channel_0"]}
    _compare_scientific(
        parent_provenance.get("measurements"), expected_rows, "parent-DNA1"
    )
    _check_object_csv(
        directory,
        {item["name"] for item in manifest["files"]},
        parent_provenance["measurements"],
    )


def _check_object_csv(directory, files, rows):
    # CSV is another scientific export: compare every flattened value to the
    # independently checked native rows, preserving null/list/bool serialization.
    if "objects.csv" not in files:
        raise ValueError("Native endpoint export lacks pinned object CSV")
    expected_csv = []
    for row in rows:
        flat = {}
        for key, value in row.items():
            if isinstance(value, dict):
                for field, item in value.items():
                    if isinstance(item, dict):
                        flat.update(
                            {
                                f"{key}:{field}:{stat}": number
                                for stat, number in item.items()
                            }
                        )
                    else:
                        flat[f"{key}:{field}"] = item
            elif isinstance(value, list):
                flat.update({f"{key}:{i}": item for i, item in enumerate(value)})
            else:
                flat[key] = value
        expected_csv.append(
            {key: "" if value is None else str(value) for key, value in flat.items()}
        )
    with (directory / "objects.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        columns = sorted({key for row in expected_csv for key in row})
        if reader.fieldnames != columns or list(reader) != expected_csv:
            raise ValueError("Native endpoint CSV disagrees with checked measurements")


def labels_2d(values) -> np.ndarray:
    array = np.asarray(values)
    if (
        array.ndim != 2
        or array.size == 0
        or array.size > MAX_PIXELS
        or array.dtype.kind not in "ui"
        or int(array.min()) < 0
        or int(array.max()) > np.iinfo(np.uint32).max
    ):
        raise ValueError("Expected bounded nonnegative integer YX labels")
    if np.unique(array[array != 0]).size > MAX_INSTANCES:
        raise ValueError("Instance count exceeds evaluator bound")
    return array


def decode_039_rgb(rgb) -> np.ndarray:
    """Official semantics: first colour component, equal-value 8-connected regions.

    The same colour can be reused in disconnected regions. Conversely, touching
    different colours must remain separate. This is not binary foreground label.
    """
    rgb = np.asarray(rgb)
    if (
        rgb.ndim != 3
        or rgb.shape[2] not in (3, 4)
        or rgb.dtype != np.uint8
        or rgb.shape[0] * rgb.shape[1] > MAX_PIXELS
    ):
        raise ValueError("Expected 8-bit colour PNG array")
    channel = rgb[..., 0]
    output = np.zeros(channel.shape, dtype=np.uint32)
    count = 0
    for colour in np.unique(channel):
        if colour == 0:
            continue
        regions, n = ndimage.label(
            channel == colour, structure=np.ones((3, 3), dtype=bool)
        )
        active = regions != 0
        output[active] = regions[active] + count
        count += n
    return labels_2d(output)


def instance_metrics(truth, prediction, thresholds=(0.5, 0.75)) -> dict:
    truth, prediction = labels_2d(truth), labels_2d(prediction)
    if truth.shape != prediction.shape:
        raise ValueError("Reference and prediction axes/shapes differ")
    gt_ids, gt = np.unique(truth, return_inverse=True)
    pd_ids, pd = np.unique(prediction, return_inverse=True)
    if len(gt_ids) * len(pd_ids) > 4_000_000:
        raise ValueError("Pairwise instance matrix exceeds evaluator memory bound")
    intersections = np.bincount(
        gt.ravel() * len(pd_ids) + pd.ravel(), minlength=len(gt_ids) * len(pd_ids)
    ).reshape(len(gt_ids), len(pd_ids))
    gt_area = intersections.sum(axis=1)
    pd_area = intersections.sum(axis=0)
    keep_g, keep_p = gt_ids != 0, pd_ids != 0
    overlaps = intersections[np.ix_(keep_g, keep_p)]
    area_g, area_p = gt_area[keep_g], pd_area[keep_p]
    unions = area_g[:, None] + area_p[None, :] - overlaps
    iou = np.divide(
        overlaps,
        unions,
        out=np.zeros_like(overlaps, dtype=np.float64),
        where=unions > 0,
    )
    ng, npred = len(area_g), len(area_p)
    matches = []
    for threshold in thresholds:
        if not np.isfinite(threshold) or not 0 < threshold <= 1:
            raise ValueError("IoU threshold must be in (0,1]")
        eligible = iou >= threshold
        # Cardinality dominates all possible summed IoU differences. Matching on
        # raw summed IoU first can discard feasible true positives at threshold.
        weight = eligible * (min(ng, npred) + 1 + iou)
        rows, cols = linear_sum_assignment(weight, maximize=True)
        accepted = eligible[rows, cols]
        tp = int(accepted.sum())
        fp, fn = npred - tp, ng - tp
        matches.append(
            {
                "iou_threshold": threshold,
                "true_positive": tp,
                "false_positive": fp,
                "false_negative": fn,
                "precision": tp / (tp + fp) if tp + fp else None,
                "recall": tp / (tp + fn) if tp + fn else None,
                "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
                "jaccard_object_score": tp / (tp + fp + fn) if tp + fp + fn else None,
                "matched_iou_sum": float(iou[rows[accepted], cols[accepted]].sum()),
            }
        )
    return {
        "truth_count": ng,
        "predicted_count": npred,
        "count_error_signed": npred - ng,
        "count_error_absolute": abs(npred - ng),
        "count_error_relative": abs(npred - ng) / ng if ng else None,
        "foreground_iou": float(
            np.logical_and(truth > 0, prediction > 0).sum()
            / np.logical_or(truth > 0, prediction > 0).sum()
        )
        if np.logical_or(truth > 0, prediction > 0).any()
        else None,
        "split_reference_any_overlap": int(((overlaps > 0).sum(axis=1) > 1).sum()),
        "merge_prediction_any_overlap": int(((overlaps > 0).sum(axis=0) > 1).sum()),
        "matching": "maximum cardinality then maximum summed IoU, threshold-inclusive",
        "scores": matches,
    }


def masked_measurements(raw, labels) -> list[dict]:
    """Exact integer count/area/sum, with one float64 division for the mean."""
    raw, labels = np.asarray(raw), labels_2d(labels)
    if (
        raw.shape != labels.shape
        or raw.dtype.kind not in "ui"
        or raw.dtype.itemsize > 2
    ):
        raise ValueError("Expected matching uint8/uint16 raw YX samples")
    if raw.dtype.kind == "i" and int(raw.min()) < 0:
        raise ValueError("Negative raw fluorescence samples")
    result = []
    for label in np.unique(labels):
        if label == 0:
            continue
        values = raw[labels == label]
        total = int(values.sum(dtype=np.uint64))
        result.append(
            {
                "label": int(label),
                "area_pixels": int(values.size),
                "sum": total,
                "mean": total / int(values.size),
            }
        )
    return result


def perinuclear_rings(labels, radius=5) -> tuple[np.ndarray, list[dict]]:
    """Euclidean dilation radius r in pixels; remove nuclei and ring collisions.

    A pixel belongs only if exactly one nucleus has distance <=r. This avoids
    arbitrary nearest-object tie ownership. Image-edge nuclei are excluded.
    """
    labels = labels_2d(labels)
    if isinstance(radius, bool) or not isinstance(radius, int) or not 1 <= radius <= 32:
        raise ValueError("Ring radius must be integer pixels in [1,32]")
    candidate_count = np.zeros(labels.shape, dtype=np.uint16)
    owner = np.zeros(labels.shape, dtype=np.uint32)
    excluded = []
    edge_ids = set(
        np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]).tolist()
    )
    for label in np.unique(labels):
        if label == 0:
            continue
        if int(label) in edge_ids:
            excluded.append(
                {"label": int(label), "reason": "nucleus touches image boundary"}
            )
        # Exclusion from endpoint reporting does not remove a nucleus from the
        # all-nuclei competition rule. Its candidate pixels still block nearby
        # interior rings before its own owned pixels are discarded.
        nucleus = labels == label
        ring = (ndimage.distance_transform_edt(~nucleus) <= radius) & (labels == 0)
        candidate_count[ring] += 1
        owner[ring] = label
    owner[candidate_count != 1] = 0
    owner[np.isin(owner, list(edge_ids))] = 0
    return owner, excluded


def enrichment(raw_gfp, labels, radius=5) -> dict:
    nuclei = masked_measurements(raw_gfp, labels)
    rings, excluded = perinuclear_rings(labels, radius)
    ring_rows = {row["label"]: row for row in masked_measurements(raw_gfp, rings)}
    excluded_ids = {row["label"] for row in excluded}
    accepted = []
    for nucleus in nuclei:
        label = nucleus["label"]
        if label in excluded_ids:
            continue
        ring = ring_rows.get(label)
        if ring is None or ring["sum"] == 0:
            excluded.append(
                {"label": label, "reason": "empty or zero-mean perinuclear ring"}
            )
            continue
        accepted.append(
            {
                "label": label,
                "nucleus": nucleus,
                "perinuclear_ring": ring,
                "nuclear_to_ring_mean_ratio": nucleus["mean"] / ring["mean"],
            }
        )
    ratios = [row["nuclear_to_ring_mean_ratio"] for row in accepted]
    return {
        "radius_pixels": radius,
        "objects": accepted,
        "excluded": excluded,
        "well_median_ratio": float(np.median(ratios)) if ratios else None,
        "well_mean_ratio": float(np.mean(ratios, dtype=np.float64)) if ratios else None,
        "sampling_unit": "well",
        "endpoint": "nuclear/perinuclear-ring GFP mean; not true cytoplasm",
    }


def control_summary(negative, positive) -> dict:
    negative, positive = (
        np.asarray(negative, dtype=np.float64),
        np.asarray(positive, dtype=np.float64),
    )
    if (
        negative.ndim != 1
        or positive.ndim != 1
        or min(len(negative), len(positive)) < 2
        or not np.isfinite(negative).all()
        or not np.isfinite(positive).all()
    ):
        raise ValueError("Need at least two finite well endpoints per control")
    difference = float(positive.mean() - negative.mean())
    if difference == 0:
        raise ValueError("Control means equal; Z-prime denominator is zero")
    # ddof=1 is fixed in the protocol; never use cells as control replicates.
    return {
        "negative_wells": len(negative),
        "positive_wells": len(positive),
        "negative_mean": float(negative.mean()),
        "positive_mean": float(positive.mean()),
        "positive_minus_negative": difference,
        "z_prime_sample_sd": float(
            1 - 3 * (negative.std(ddof=1) + positive.std(ddof=1)) / abs(difference)
        ),
        "positive_expected_direction": difference > 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--packet",
        type=Path,
        help="Verify native qualification bindings only; no outcomes",
    )
    parser.add_argument(
        "--settings-sha256", help="Independent evaluator settings-freeze trust pin"
    )
    parser.add_argument(
        "--run-binding-sha256", help="Independent evaluator native-run trust pin"
    )
    parser.add_argument(
        "--exploratory",
        action="store_true",
        help="Explicitly unqualified low-level development metrics",
    )
    parser.add_argument("--truth-png", type=Path)
    parser.add_argument("--prediction-labels", type=Path)
    parser.add_argument("--raw-tiff", type=Path)
    parser.add_argument("--protocol", type=Path)
    parser.add_argument("--protocol-sha256")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if args.packet is not None:
        if args.exploratory or not args.settings_sha256 or not args.run_binding_sha256:
            parser.error(
                "Packet validation requires both independent trust pins and cannot be exploratory"
            )
        result = validate_qualification_packet(
            read_json(args.packet),
            settings_sha256=args.settings_sha256,
            run_binding_sha256=args.run_binding_sha256,
        )
        with args.output.open("x") as stream:
            json.dump(result, stream, indent=2, allow_nan=False)
            stream.write("\n")
        return
    if not args.exploratory or any(
        value is None
        for value in (
            args.truth_png,
            args.prediction_labels,
            args.raw_tiff,
            args.protocol,
            args.protocol_sha256,
        )
    ):
        parser.error(
            "Use --packet with independent trust pins, or explicitly --exploratory with all raw/reference/prediction/protocol inputs"
        )
    protocol_identity = file_identity(args.protocol)
    if protocol_identity["sha256"] != args.protocol_sha256:
        raise ValueError("Protocol differs from the frozen approved identity")
    sources = {
        "reference": file_identity(args.truth_png),
        "prediction": file_identity(args.prediction_labels),
        "raw": file_identity(args.raw_tiff),
        "protocol": protocol_identity,
        "oracle": file_identity(Path(__file__)),
    }
    with Image.open(args.truth_png) as image:
        reference = decode_039_rgb(np.asarray(image))
    prediction = tifffile.imread(args.prediction_labels)
    raw = tifffile.imread(args.raw_tiff)
    result = {
        "qualification": "unqualified-exploratory; arbitrary-file metrics do not establish source/run binding",
        "identities": sources,
        "instance_metrics": instance_metrics(reference, prediction),
        "fixed_prediction_raw_measurements": masked_measurements(raw, prediction),
        "reference_raw_measurements": masked_measurements(raw, reference),
    }
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")


if __name__ == "__main__":
    main()
