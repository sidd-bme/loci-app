from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

import loci_engine.working_result as working_result
from loci_engine.models import SegmentationSettings
from loci_engine.research_editing import _derived_prefix
from loci_engine.research_export import export_research_result
from loci_engine.research_legacy_import import _verify_legacy_settings, import_legacy_project
from loci_engine.research_project import ResearchProject
from loci_engine.results import RESULT_CACHE
from loci_engine.workbench import Workbench
from loci_engine.worker import handle_request


def _request(method: str, params: dict[str, object]) -> dict[str, object]:
    response = handle_request({"id": method, "method": method, "params": params})
    assert "error" not in response, response
    return response["result"]


def _fixture(tmp_path: Path) -> tuple[Path, Path, dict[str, object], dict[str, object]]:
    image = Image.new("L", (96, 80), color=10)
    ImageDraw.Draw(image).ellipse((24, 18, 64, 58), fill=240)
    source = tmp_path / "cells.png"
    image.save(source)
    segmented = _request(
        "segment",
        {
            "path": str(source),
            "settings": {
                "image_mode": "fluorescence",
                "expected_diameter_px": 35,
                "min_area_px": 50,
            },
        },
    )
    corrected = _request(
        "delete_instance",
        {"result_id": segmented["result_id"], "x": 44, "y": 38},
    )
    corrected = _request(
        "add_polygon",
        {
            "result_id": segmented["result_id"],
            "points": [
                {"x": 12, "y": 12},
                {"x": 28, "y": 12},
                {"x": 28, "y": 28},
                {"x": 12, "y": 28},
            ],
        },
    )
    working = tmp_path / "working"
    working.mkdir(mode=0o700)
    working.chmod(0o700)
    receipt = _request(
        "publish_working_result",
        {"result_id": segmented["result_id"], "directory": str(working)},
    )
    return source, working / receipt["pack"]["basename"], segmented, corrected


def test_imports_verified_current_layer_and_corrections_without_runtime_resolution(
    tmp_path: Path, monkeypatch
) -> None:
    RESULT_CACHE.clear()
    source, pack, segmented, corrected = _fixture(tmp_path)
    pack_before = pack.read_bytes()
    source_before = source.read_bytes()
    cached = RESULT_CACHE.get(segmented["result_id"])
    expected_labels = cached.output.labels.copy()
    RESULT_CACHE.clear()
    monkeypatch.setattr(
        working_result,
        "resolve_profile",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("runtime resolved")),
    )
    project = ResearchProject.create(tmp_path / "imported.loci-study", "Imported")
    workbench = Workbench(project)
    digest = hashlib.sha256(pack_before).hexdigest()
    artifact = {
        "artifactId": "working-result",
        "filename": pack.name,
        "mediaType": "application/vnd.loci.working-result+zip",
        "byteLength": len(pack_before),
        "sha256": digest,
    }
    operation_ids = [
        operation["operation_id"] for operation in corrected["corrections"]["applied_operations"]
    ]
    legacy_settings = {**segmented["settings"], "sensitivity": 0}
    legacy_settings_json = json.dumps(
        legacy_settings, sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    item = {
        "legacy_source_id": "source_1",
        "source_path": str(source),
        "source_name": "cells.png",
        "expected_sha256": segmented["source"]["sha256"],
        "result": {
            "legacy_result_id": segmented["result_id"],
            "result_manifest_id": "manifest_1",
            "job_id": "job_1",
            "model_id": segmented["profile"]["id"],
            "model_sha256": segmented["profile"]["model"]["sha256"],
            "settings_json": legacy_settings_json,
            "settings_sha256": hashlib.sha256(legacy_settings_json.encode()).hexdigest(),
            "engine_version": segmented["engine"]["version"],
            "correction_revision": corrected["corrections"]["revision"],
            "correction_operation_ids": operation_ids,
            "original_pack": artifact,
            "active_pack": {**artifact, "path": str(pack)},
            "review_disposition": "reviewed",
        },
    }
    legacy_project = {
        "project_id": "project_1",
        "title": "Legacy study",
        "revision": 4,
        "sha256": "a" * 64,
    }

    imported = import_legacy_project(workbench, legacy_project, [item])
    again = import_legacy_project(workbench, legacy_project, [item])

    assert pack.read_bytes() == pack_before
    assert source.read_bytes() == source_before
    assert imported["receipt"]["sources"] == again["receipt"]["sources"]
    assert len(project.list_sources()) == 1
    assert len(project.list_results()) == 1
    result = project.list_results()[0]
    assert np.array_equal(project.load_array(result["arrays"]["labels"]), expected_labels)
    provenance = result["provenance"]
    assert provenance["corrections"]["revision"] == 2
    assert provenance["selection"] == {
        "x": 0,
        "y": 0,
        "width": 96,
        "height": 80,
        "z": 0,
        "t": 0,
        "c": 0,
        "level": 0,
    }
    assert provenance["derived_measurement_prefix"] == "LEGACY-DERIVED"
    assert provenance["legacy_measurements"] == cached.output.measurements
    assert all(
        set(row["intensity"]) == {"LEGACY-DERIVED:image"} for row in provenance["measurements"]
    )
    assert result["provenance"]["legacy_import"]["active_pack"] == artifact
    assert "path" not in json.dumps(result["provenance"])
    assert project.review_state(result["id"])["disposition"] == "reviewed"
    assert workbench.result_view(
        {
            "result_id": result["id"],
            "axis": "z",
            "index": 0,
            "display": {},
            "labels": True,
        }
    )["image"].startswith("data:image/png;base64,")

    workbench.close()
    reopened = Workbench(ResearchProject(project.root))
    reopened_result = reopened.project.result(result["id"])
    binding = {
        "result_id": reopened_result["id"],
        "revision_hash": reopened_result["revision_hash"],
    }
    info = reopened.execute("correction_info", binding)
    assert info["label_ids"]
    assert info["measurement_channels"] == [
        {
            "index": 0,
            "name": "LEGACY-DERIVED:image",
            "basis": "LEGACY-DERIVED scalar values",
        }
    ]
    corrected_child = reopened.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "delete",
                    "label": info["label_ids"][0],
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        },
    )["result"]
    corrected_record = reopened.project.result(corrected_child["id"])
    assert corrected_record["provenance"]["correction"]["parent_id"] == result["id"]
    assert all(
        set(row["intensity"]) == {"LEGACY-DERIVED:image"}
        for row in corrected_record["provenance"]["measurements"]
    )
    annotated = reopened.execute(
        "roi_add",
        {
            **binding,
            "measurement_channels": [0],
            "roi": {
                "annotation_id": "legacy-region-1",
                "plane": "XY",
                "index": 0,
                "points": [
                    {"u": 8.5, "v": 8.5},
                    {"u": 32.5, "v": 8.5},
                    {"u": 32.5, "v": 32.5},
                    {"u": 8.5, "v": 32.5},
                ],
                "slab_start": None,
                "slab_stop_exclusive": None,
            },
        },
    )
    annotation = annotated["annotations"][0]
    assert annotation["basis"] == "LEGACY-DERIVED scalar values"
    measurement = annotation["measurements"]["LEGACY-DERIVED:image"]
    assert "derived_intensity" in measurement and "raw_intensity" not in measurement

    export = export_research_result(
        reopened.project,
        result["id"],
        result["revision_hash"],
        tmp_path / "legacy-export",
    )
    assert export["result_id"] == result["id"]
    assert (tmp_path / "legacy-export" / "result.json").is_file()
    reopened.close()
    RESULT_CACHE.clear()


def test_legacy_derived_measurement_prefix_requires_import_provenance() -> None:
    with pytest.raises(ValueError, match="verified legacy import"):
        _derived_prefix({"derived_measurement_prefix": "LEGACY-DERIVED"})


def _settings_json(value: dict[str, object], *, allow_nan: bool = False) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=allow_nan,
    )


def _settings_sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def test_legacy_settings_accept_javascript_integral_number_encoding() -> None:
    restored = SegmentationSettings()
    legacy = {**restored.to_dict(), "expected_diameter_px": 34, "sensitivity": 0}
    settings_json = _settings_json(legacy)
    _verify_legacy_settings(
        settings_json,
        _settings_sha256(settings_json),
        restored=restored,
        backend_kind="classical",
    )


@pytest.mark.parametrize(
    ("value", "javascript_number"),
    [(1e-7, "1e-7"), (1e-6, "0.000001")],
)
def test_legacy_settings_hash_exact_javascript_exponent_encoding(
    value: float,
    javascript_number: str,
) -> None:
    restored = SegmentationSettings(sensitivity=value)
    legacy = restored.to_dict()
    settings_json = _settings_json(legacy)
    python_number = json.dumps(value)
    settings_json = settings_json.replace(
        f'"sensitivity":{python_number}',
        f'"sensitivity":{javascript_number}',
    )
    assert f'"sensitivity":{javascript_number}' in settings_json
    _verify_legacy_settings(
        settings_json,
        _settings_sha256(settings_json),
        restored=restored,
        backend_kind="classical",
    )


def test_legacy_settings_reject_digest_and_restored_value_mismatches() -> None:
    restored = SegmentationSettings()
    legacy = {**restored.to_dict(), "sensitivity": 0}
    settings_json = _settings_json(legacy)
    with pytest.raises(ValueError, match="saved digest"):
        _verify_legacy_settings(
            settings_json,
            "f" * 64,
            restored=restored,
            backend_kind="classical",
        )
    changed = {**legacy, "expected_diameter_px": 35}
    changed_json = _settings_json(changed)
    with pytest.raises(ValueError, match="restored settings"):
        _verify_legacy_settings(
            changed_json,
            _settings_sha256(changed_json),
            restored=restored,
            backend_kind="classical",
        )


@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("sensitivity", "0", TypeError),
        ("expected_diameter_px", 3, ValueError),
        ("sensitivity", float("nan"), ValueError),
    ],
)
def test_legacy_settings_reject_invalid_numeric_values(
    field: str,
    value: object,
    error: type[Exception],
) -> None:
    restored = SegmentationSettings()
    legacy = {**restored.to_dict(), field: value}
    settings_json = _settings_json(legacy, allow_nan=True)
    with pytest.raises(error):
        _verify_legacy_settings(
            settings_json,
            _settings_sha256(settings_json),
            restored=restored,
            backend_kind="classical",
        )
