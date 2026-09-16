"""Trusted native-picker conversion and immutable derived-source receipts."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .quantitative import exact_keys
from .research_project import SHA_PATTERN, canonical_json, parse_json
from .working_result import _sha256_file_stable

if TYPE_CHECKING:
    from .workbench import Workbench


def validate_derivation(value: Any, source_sha256: str) -> dict[str, Any]:
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
    if (
        receipt.get("schema_version") != "loci.vendor-conversion-receipt/v1"
        or record.get("schema_version") != "loci.vendor-conversion/v1"
    ):
        raise ValueError("Vendor conversion schema is unsupported")
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
        or artifact != record.get("artifact")
        or receipt.get("selection") != record.get("selection")
        or receipt.get("runtime") != record.get("runtime")
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


def convert_and_import(workbench: Workbench, params: dict[str, Any]) -> dict[str, Any]:
    from dataclasses import asdict

    from .native_image import NativeImageSession
    from .vendor_conversion import VendorConversionRequest, convert_vendor

    exact_keys(
        params,
        {"source", "jar", "java", "destination", "request", "expected_source_sha256"},
        "trusted vendor conversion",
    )
    request = dict(params["request"])
    if request.get("crop") is not None:
        exact_keys(request["crop"], {"x", "y", "width", "height"}, "vendor crop")
        request["crop"] = tuple(request["crop"][key] for key in ("x", "y", "width", "height"))
    receipt = convert_vendor(
        params["source"],
        params["jar"],
        params["destination"],
        VendorConversionRequest(**request),
        params["java"],
        expected_source_sha256=params["expected_source_sha256"],
    )
    directory = Path(params["destination"])
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
    with NativeImageSession(image, expected_sha256=receipt["artifact"]["sha256"]) as session:
        source = workbench.project.register_source(
            image,
            session.metadata.sha256,
            asdict(session.metadata),
            name=(
                f"{Path(params['source']).name} · converted S{request['series']} "
                f"C{request['c']} Z{request['z']} T{request['t']}"
            ),
            derivation=derivation,
        )
    return {"snapshot": workbench.snapshot(), "source": source, "conversion": receipt}


def verify_result_derivation(source: dict[str, Any], provenance: dict[str, Any]) -> None:
    """A portable or exported result must retain its exact converted-source origin."""
    declared = source.get("derivation")
    if declared is not None:
        declared = validate_derivation(declared, source["sha256"])
        if provenance.get("source_derivation") != declared:
            raise ValueError("Result lost its exact source conversion derivation")
    elif "source_derivation" in provenance:
        raise ValueError("Result claims a conversion derivation absent from its source")
