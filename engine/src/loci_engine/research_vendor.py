"""Trusted native-picker conversion and immutable derived-source receipts."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .quantitative import exact_keys
from .research_project import SHA_PATTERN, canonical_json, parse_json
from .working_result import _sha256_file_stable

if TYPE_CHECKING:
    from .workbench import Workbench


def validate_derivation(
    value: Any, source_sha256: str, metadata: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Validate receipt identities; upstream biological meaning is not inferred."""
    exact_keys(value, {"schema", "receipt", "record"}, "vendor source derivation")
    if value.get("schema") != "loci.vendor-derived-source/v1":
        raise ValueError("Unsupported derived vendor-source receipt")
    receipt, record = value.get("receipt"), value.get("record")
    if not isinstance(receipt, dict) or not isinstance(record, dict):
        raise ValueError("Derived source requires a conversion receipt and executed record")
    exact_keys(
        receipt,
        {
            "schema_version",
            "source_sha256",
            "bioformats_jar_sha256",
            "selection",
            "runtime",
            "artifact",
            "provenance",
        },
        "vendor conversion receipt",
    )
    exact_keys(
        record,
        {"schema_version", "source", "selection", "source_series", "runtime", "artifact", "limits"},
        "vendor executed record",
    )
    versions = (receipt.get("schema_version"), record.get("schema_version"))
    if versions in (
        ("loci.vendor-conversion-receipt/v2", "loci.vendor-conversion/v2"),
        ("loci.vendor-conversion-receipt/v3", "loci.vendor-conversion/v3"),
    ):
        _validate_stack_record(record, metadata)
    elif versions != ("loci.vendor-conversion-receipt/v1", "loci.vendor-conversion/v1"):
        raise ValueError("Vendor conversion schema is unsupported")
    elif "end_exclusive" in record["selection"] or record["artifact"].get("axes") != "YX":
        raise ValueError("Legacy vendor receipts require one plane")
    origin = record.get("source", {})
    digest = receipt.get("source_sha256")
    if (
        not isinstance(digest, str)
        or not SHA_PATTERN.fullmatch(digest)
        or origin.get("sha256_before") != digest
        or origin.get("sha256_after") != digest
    ):
        raise ValueError("Vendor original source fingerprints disagree")
    artifact = receipt.get("artifact", {})
    if (
        artifact.get("sha256") != source_sha256
        or canonical_json(artifact) != canonical_json(record.get("artifact"))
        or canonical_json(receipt.get("selection")) != canonical_json(record.get("selection"))
        or canonical_json(receipt.get("runtime")) != canonical_json(record.get("runtime"))
    ):
        raise ValueError("Vendor conversion receipt differs from its source, grid, or runtime")
    from .vendor_conversion import BIOFORMATS_JAR_SHA256, BIOFORMATS_JAR_SIZE, BIOFORMATS_VERSION

    runtime = receipt["runtime"]
    if (
        receipt.get("bioformats_jar_sha256") != BIOFORMATS_JAR_SHA256
        or runtime.get("bioformats_jar_sha256") != BIOFORMATS_JAR_SHA256
        or runtime.get("bioformats_jar_size_bytes") != BIOFORMATS_JAR_SIZE
        or runtime.get("bioformats_version") != BIOFORMATS_VERSION
    ):
        raise ValueError("Vendor converter identity differs from the supported pinned tool")
    # The converter writes a canonical record with one final newline.
    encoded = (canonical_json(record) + "\n").encode()
    provenance = receipt.get("provenance", {})
    if (
        provenance.get("filename") != "provenance.json"
        or provenance.get("sha256") != hashlib.sha256(encoded).hexdigest()
        or artifact.get("filename") != "image.ome.tif"
    ):
        raise ValueError("Vendor derivation record failed its exact artifact binding")
    return parse_json(canonical_json(value))


def _validate_stack_record(record: dict[str, Any], metadata: dict[str, Any] | None) -> None:
    from .vendor_conversion import (
        VENDOR_READERS,
        VendorConversionError,
        _expected_calibration,
        _request,
        _resolve_series,
    )

    try:
        selection = dict(record["selection"])
        selection["crop"] = selection.pop("crop_xywh")
        limits = dict(record["limits"])
        plane_bytes = limits.pop("decoded_plane_bytes")
        if set(limits) != {"max_output_bytes", "heap_mib", "timeout_seconds"}:
            raise ValueError("Invalid vendor conversion limits")
        if set(selection) != {"series", "t", "c", "z", "end_exclusive", "crop"}:
            raise ValueError("Incomplete stack scope")
        request = _request({**selection, **limits})
        end = request.end_exclusive
        series = record["source_series"]
        dimensions = series["dimensions"]
        order = series["dimension_order"]
        if (
            not isinstance(order, str)
            or len(order) != 5
            or not order.startswith("XY")
            or set(order) != set("XYZCT")
        ):
            raise ValueError("Invalid vendor series dimension order")
        origin = record["source"]
        if (
            origin["format"] not in ("czi", "lif", "nd2")
            or type(origin["size_bytes"]) is not int
            or origin["size_bytes"] <= 0
            or record["runtime"]["reader_class"] != VENDOR_READERS["." + origin["format"]]
        ):
            raise ValueError("Invalid original vendor source")
        calibration = series["calibration"]
        if calibration is not None:
            if set(calibration) not in (set("xy"), set("xyz")):
                raise ValueError("Incomplete vendor spatial calibration")
            for item in calibration.values():
                if (
                    set(item) != {"value", "unit"}
                    or type(item["value"]) not in (int, float)
                    or not math.isfinite(item["value"])
                    or item["value"] <= 0
                ):
                    raise ValueError("Invalid vendor spatial calibration")
        if (
            end is None
            or request.crop is None
            or (
                type(series["index"]) is not int
                or series["index"] != request.series
                or set(dimensions) != set("xyczt")
                or any(type(v) is not int or not 0 < v < 2**31 for v in dimensions.values())
            )
        ):
            raise ValueError("Invalid source series or range")
        for key in ("channel_names", "declared_channel_names", "samples_per_channel"):
            if not isinstance(series[key], list) or len(series[key]) != dimensions["c"]:
                raise ValueError("Incomplete source channels")
        if any(type(n) is not int or n <= 0 for n in series["samples_per_channel"]):
            raise ValueError("Invalid scalar samples")
        for i, (label, declared) in enumerate(
            zip(series["channel_names"], series["declared_channel_names"], strict=True)
        ):
            if (
                not isinstance(label, str)
                or not label
                or len(label) > 160
                or any(ch in "/\\" or ord(ch) < 32 for ch in label)
                or label != (declared if declared is not None else f"Channel {i + 1}")
            ):
                raise ValueError("Invalid source channel label")
        _, crop, decoded = _resolve_series(request, series)
        shape = [end.t - request.t, end.c - request.c, end.z - request.z, crop[3], crop[2]]
        artifact = record["artifact"]
        if record["schema_version"] == "loci.vendor-conversion/v3":
            from .vendor_acquisition import validate_evidence

            if any(n != 1 for n in series["samples_per_channel"]):
                raise ValueError("Vendor acquisition coordinates require a scalar series")
            validate_evidence(artifact["acquisition"], metadata, math.prod(shape[:3]))
        elif "acquisition" in artifact:
            raise ValueError("Unexpected acquisition claim in v2 vendor receipt")
        if metadata is not None:
            names = [
                name or f"Channel {i + 1}"
                for i, name in enumerate(series["declared_channel_names"][request.c : end.c])
            ]
            expected_dims = {**dict(zip("tczyx", shape, strict=True)), "s": 1}
            if (
                canonical_json(metadata["dimensions"]) != canonical_json(expected_dims)
                or list(metadata["channel_names"]) != names
                or list(metadata["channel_dtypes"]) != [series["dtype"]] * shape[1]
                or canonical_json(metadata["physical_calibration"])
                != canonical_json(artifact["calibration"])
            ):
                raise ValueError("Derived source metadata differs from the vendor stack")
        summary = artifact["numeric_summary"]
        if (
            type(plane_bytes) is not int
            or decoded != plane_bytes
            or artifact["axes"] != "TCZYX"
            or canonical_json(shape) != canonical_json(artifact["shape"])
            or artifact["dtype"] != series["dtype"]
            or artifact["calibration"] != _expected_calibration(series)
            or not SHA_PATTERN.fullmatch(artifact["pixel_sha256"])
            or type(summary["planes_verified"]) is not int
            or summary["planes_verified"] != math.prod(shape[:3])
            or summary["pixel_check"] != "exact Bio-Formats openBytes, TCZYX little-endian"
            or summary["all_finite"] is not True
            or not all(
                type(summary[k]) in (float, int) and math.isfinite(summary[k])
                for k in ("minimum", "maximum")
            )
            or summary["minimum"] > summary["maximum"]
            or not SHA_PATTERN.fullmatch(record["runtime"]["java_sha256"])
        ):
            raise ValueError("Vendor stack grid or verification differs from its selection")
    except (
        VendorConversionError,
        KeyError,
        IndexError,
        AttributeError,
        TypeError,
        OverflowError,
    ) as exc:
        raise ValueError("Invalid multidimensional vendor conversion record") from exc


def convert_and_import(workbench: Workbench, params: dict[str, Any]) -> dict[str, Any]:
    from dataclasses import asdict

    from .native_image import NativeImageSession
    from .vendor_conversion import convert_vendor

    exact_keys(
        params,
        {
            "source",
            "jar",
            "java",
            "destination",
            "request",
            "expected_source_sha256",
            "expected_java_sha256",
        },
        "trusted vendor conversion",
    )
    request = dict(params["request"])
    if request.get("crop") is not None:
        exact_keys(request["crop"], {"x", "y", "width", "height"}, "vendor crop")
        request["crop"] = tuple(request["crop"][key] for key in ("x", "y", "width", "height"))
    directory = Path(params["destination"])
    if directory.resolve().is_relative_to(workbench.project.root):
        raise ValueError("Choose a conversion folder outside this study.")
    receipt = convert_vendor(
        params["source"],
        params["jar"],
        params["destination"],
        request,
        params["java"],
        expected_source_sha256=params["expected_source_sha256"],
        expected_java_sha256=params.get("expected_java_sha256"),
    )
    image = directory / "image.ome.tif"
    provenance = directory / "provenance.json"
    if (
        directory.is_symlink()
        or provenance.is_symlink()
        or not provenance.is_file()
        or provenance.stat().st_size > 16 * 1024**2
    ):
        raise ValueError("Published vendor conversion is not a plain bounded artifact")
    before, _ = _sha256_file_stable(provenance, reject_symlink=True)
    record = json.loads(provenance.read_text(encoding="utf-8"))
    after, _ = _sha256_file_stable(provenance, reject_symlink=True)
    if before != after or after != receipt["provenance"]["sha256"]:
        raise ValueError("Vendor provenance changed before source adoption")
    derivation = validate_derivation(
        {"schema": "loci.vendor-derived-source/v1", "receipt": receipt, "record": record},
        receipt["artifact"]["sha256"],
    )
    selection = receipt["selection"]
    ends = selection.get("end_exclusive")
    grid = " ".join(
        f"{axis.upper()}{selection[axis]}"
        + (f"–{ends[axis] - 1}" if ends and ends[axis] - 1 != selection[axis] else "")
        for axis in "czt"
    )
    suffix = f" · converted S{selection['series']} {grid}"
    with NativeImageSession(image, expected_sha256=receipt["artifact"]["sha256"]) as session:
        source = workbench.project.register_source(
            image,
            session.metadata.sha256,
            asdict(session.metadata),
            name=Path(params["source"]).name[: 256 - len(suffix)] + suffix,
            derivation=derivation,
        )
    return {"snapshot": workbench.snapshot(), "source": source, "conversion": receipt}


def verify_result_derivation(source: dict[str, Any], provenance: dict[str, Any]) -> None:
    """A portable or exported result must retain its exact converted-source origin."""
    declared = source.get("derivation")
    if declared is not None:
        declared = validate_derivation(declared, source["sha256"], source.get("metadata"))
        if provenance.get("source_derivation") != declared:
            raise ValueError("Result lost its exact source conversion derivation")
    elif "source_derivation" in provenance:
        raise ValueError("Result claims a conversion derivation absent from its source")
