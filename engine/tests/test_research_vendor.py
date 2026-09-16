from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest
import tifffile

import loci_engine.research_interchange as interchange_module
from loci_engine.native_image import NativeImageSession
from loci_engine.quantitative import Geometry
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import (
    export_project,
    import_project,
    relink_interchanged_source,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_vendor import convert_and_import, validate_derivation
from loci_engine.vendor_conversion import (
    BIOFORMATS_JAR_SHA256,
    BIOFORMATS_JAR_SIZE,
    BIOFORMATS_VERSION,
    inspect_vendor,
)
from loci_engine.workbench import Workbench

ND2_SHA256 = "77c921fa2d3ebce182c261d28790de97d119062e550029b5e501d6200720eb0d"


def _fixture_root() -> Path:
    root = Path(os.environ.get("LOCI_VENDOR_FIXTURE_DIR", "/tmp/loci-release-run/vendor-reader"))
    if not (root / "sample.nd2").is_file() or not (root / "bioformats_package.jar").is_file():
        pytest.skip("authorized Bio-Formats qualification fixtures are not available")
    return root


def _derivation(output_sha256: str) -> dict[str, object]:
    source_sha256 = "a" * 64
    selection = {"series": 0, "c": 0, "z": 0, "t": 0, "crop_xywh": [0, 0, 8, 8]}
    runtime = {
        "bioformats_version": BIOFORMATS_VERSION,
        "bioformats_jar_sha256": BIOFORMATS_JAR_SHA256,
        "bioformats_jar_size_bytes": BIOFORMATS_JAR_SIZE,
        "java_sha256": "b" * 64,
        "java_version": "fixture-java",
    }
    artifact = {
        "filename": "image.ome.tif",
        "sha256": output_sha256,
        "pixel_sha256": "c" * 64,
        "axes": "YX",
        "shape": [8, 8],
        "dtype": "uint16",
        "calibration": None,
        "numeric_summary": {
            "minimum": 0,
            "maximum": 63,
            "all_finite": True,
        },
    }
    record = {
        "schema_version": "loci.vendor-conversion/v1",
        "source": {
            "format": "nd2",
            "size_bytes": 123,
            "sha256_before": source_sha256,
            "sha256_after": source_sha256,
        },
        "selection": selection,
        "source_series": {"index": 0},
        "runtime": runtime,
        "artifact": artifact,
        "limits": {"decoded_plane_bytes": 128},
    }
    provenance_sha256 = hashlib.sha256((canonical_json(record) + "\n").encode()).hexdigest()
    receipt = {
        "schema_version": "loci.vendor-conversion-receipt/v1",
        "source_sha256": source_sha256,
        "bioformats_jar_sha256": BIOFORMATS_JAR_SHA256,
        "selection": selection,
        "runtime": runtime,
        "artifact": artifact,
        "provenance": {"filename": "provenance.json", "sha256": provenance_sha256},
    }
    return {"schema": "loci.vendor-derived-source/v1", "receipt": receipt, "record": record}


def test_derivation_tampering_and_result_origin_mismatch_fail_closed(tmp_path: Path) -> None:
    image = tmp_path / "image.ome.tif"
    tifffile.imwrite(image, np.arange(64, dtype=np.uint16).reshape(8, 8), ome=True)
    output_sha256 = hashlib.sha256(image.read_bytes()).hexdigest()
    derivation = _derivation(output_sha256)
    assert validate_derivation(derivation, output_sha256) == derivation

    changed_receipt = copy.deepcopy(derivation)
    changed_receipt["receipt"]["artifact"]["sha256"] = "d" * 64
    with pytest.raises(ValueError, match="receipt differs"):
        validate_derivation(changed_receipt, output_sha256)

    changed_record = copy.deepcopy(derivation)
    changed_record["record"]["limits"]["decoded_plane_bytes"] = 129
    with pytest.raises(ValueError, match="artifact binding"):
        validate_derivation(changed_record, output_sha256)

    project = ResearchProject.create(tmp_path / "derived.loci-study", "Derived")
    with NativeImageSession(image) as session:
        source = project.register_source(
            image,
            session.metadata.sha256,
            {"sha256": session.metadata.sha256},
            derivation=derivation,
        )
    valid_result = project.save_result(
        source_id=source["id"],
        kind="fixture",
        arrays={"image": np.zeros((8, 8), dtype=np.float64)},
        provenance={"geometry": Geometry.diagonal((1, 1)).to_dict()},
    )
    assert valid_result["provenance"]["source_derivation"] == derivation

    forged = copy.deepcopy(derivation)
    forged["record"]["limits"]["decoded_plane_bytes"] = 129
    forged["receipt"]["provenance"]["sha256"] = hashlib.sha256(
        (canonical_json(forged["record"]) + "\n").encode()
    ).hexdigest()
    assert validate_derivation(forged, output_sha256) == forged
    with pytest.raises(ValueError, match="Result origin differs"):
        project.save_result(
            source_id=source["id"],
            kind="fixture",
            arrays={"image": np.zeros((8, 8), dtype=np.float64)},
            provenance={
                "geometry": Geometry.diagonal((1, 1)).to_dict(),
                "source_derivation": forged,
            },
        )

    portable_source = project.public_source(project.source(source["id"]))
    missing = copy.deepcopy(valid_result)
    missing["provenance"].pop("source_derivation")
    with pytest.raises(ValueError, match="lost its exact source conversion derivation"):
        interchange_module._validate_result_crossrefs(
            missing, {source["id"]: portable_source}, {missing["id"]: missing}
        )
    replaced = copy.deepcopy(valid_result)
    replaced["provenance"]["source_derivation"] = forged
    with pytest.raises(ValueError, match="lost its exact source conversion derivation"):
        interchange_module._validate_result_crossrefs(
            replaced, {source["id"]: portable_source}, {replaced["id"]: replaced}
        )


def test_real_nd2_conversion_remains_bound_through_result_export_and_portable_relink(
    tmp_path: Path,
) -> None:
    fixture = _fixture_root()
    original = fixture / "sample.nd2"
    jar = fixture / "bioformats_package.jar"
    original_before = hashlib.sha256(original.read_bytes()).hexdigest()
    assert original_before == ND2_SHA256

    inspection = inspect_vendor(original, jar)
    project = ResearchProject.create(tmp_path / "vendor.loci-study", "Vendor derivation")
    workbench = Workbench(project)
    converted = tmp_path / "converted-nd2"
    adopted = convert_and_import(
        workbench,
        {
            "source": str(original),
            "jar": str(jar),
            "java": "/usr/bin/java",
            "destination": str(converted),
            "expected_source_sha256": inspection["source_sha256"],
            "request": {
                "series": 0,
                "c": 0,
                "z": 0,
                "t": 0,
                "crop": {"x": 50, "y": 60, "width": 32, "height": 24},
            },
        },
    )
    source = adopted["source"]
    derivation = source["derivation"]
    assert source["sha256"] == adopted["conversion"]["artifact"]["sha256"]
    assert validate_derivation(derivation, source["sha256"]) == derivation
    public_receipt = json.dumps(adopted, sort_keys=True)
    assert str(fixture) not in public_receipt
    assert str(tmp_path) not in public_receipt

    saved = workbench.execute(
        "run_recipe", {"source_id": source["id"], "recipe": {"steps": []}}
    )["result"]
    result = project.result(saved["id"])
    assert result["source_sha256"] == source["sha256"]
    assert result["provenance"]["source_derivation"] == derivation
    project.review(result["id"], result["revision_hash"], "reviewed")

    result_export = tmp_path / "result-export"
    export_research_result(project, result["id"], result["revision_hash"], result_export)
    exported = json.loads((result_export / "result.json").read_text(encoding="utf-8"))
    assert exported["raw_source_included"] is False
    assert exported["source"]["derivation"] == derivation
    assert exported["result"]["provenance"]["source_derivation"] == derivation
    assert canonical_json(derivation) in (result_export / "methods.md").read_text(encoding="utf-8")

    archive = tmp_path / "vendor-portable.loci-study.zip"
    archive_receipt = export_project(project, archive)
    archive_bytes = archive.read_bytes()
    assert str(fixture).encode() not in archive_bytes
    assert str(tmp_path).encode() not in archive_bytes
    restored = import_project(
        archive,
        tmp_path / "restored.loci-study",
        expected_archive_sha256=archive_receipt["archive_sha256"],
    )
    portable_source = restored.source(source["id"])
    assert portable_source["locator_state"] == "relink-required"
    assert portable_source["derivation"] == derivation
    with pytest.raises(ValueError, match="relink"):
        restored.source(source["id"], verify=True)
    relinked = relink_interchanged_source(
        restored, source["id"], converted / "image.ome.tif"
    )
    assert relinked["derivation"] == derivation
    assert restored.source(source["id"], verify=True)["sha256"] == source["sha256"]
    restored_result = restored.result(result["id"])
    assert restored_result["provenance"]["source_derivation"] == derivation
    assert restored.review_state(result["id"])["revision_hash"] == result["revision_hash"]
    assert hashlib.sha256(original.read_bytes()).hexdigest() == original_before
    workbench.close()
