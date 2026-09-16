from __future__ import annotations

import hashlib
import json
import os
import shutil
from base64 import b64decode
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image
from test_model_packages import _bioimage_package, _native_package, _sha

import loci_engine.research_models as research_models_module
from loci_engine import model_packages
from loci_engine.research_models import execute_model, import_model
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def _source(workbench: Workbench, tmp_path: Path, *, scale: float = 0.5):
    image = np.zeros((1, 2, 1, 11, 13), dtype=np.float32)
    image[0, 0, 0, 2:8, 3:9] = np.float32(0.8)
    image[0, 1, 0] = np.float32(0.25)
    path = tmp_path / f"source-{scale}.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": scale,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": scale,
            "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["untrusted nucleus prompt", "raw marker"]},
        },
    )
    return path, workbench.import_native(str(path), name="untrusted source prompt")


def _workbench(tmp_path: Path):
    return Workbench(ResearchProject.create(tmp_path / "study", "Synthetic model study"))


def _request(model_id: str, source_id: str, *, scale: dict | None = None):
    return {
        "model_id": model_id,
        "source_id": source_id,
        "selection": {
            "x": 0,
            "y": 0,
            "width": 13,
            "height": 11,
            "t": 0,
            "z": 0,
            "level": 0,
        },
        "channel_mapping": [
            {
                "model_input_index": 0,
                "model_channel": "input-0",
                "source_channel": 0,
            }
        ],
        "scale": {"mode": "source"} if scale is None else scale,
        "postprocessing": {
            "probability_channel": 0,
            "threshold": 0.5,
            "method": "components",
            "min_size": 0,
            "exclude_border": False,
        },
        "measurement_channels": [0, 1],
        "display": {
            "source_channel": 0,
            "low": 0.0,
            "high": 1.0,
            "gamma": 1.0,
            "color": "#ffffff",
        },
        "working_bytes": 256 * 1024**2,
    }


def _make_recoverable_model(workbench: Workbench, package: Path) -> tuple[dict, dict, Path]:
    imported = import_model(workbench, package, working_bytes=256 * 1024**2)
    document = workbench.project.documents("model")[0]
    private = Path(document["data"]["private_path"])
    portable = {key: value for key, value in document["data"].items() if key != "private_path"}
    portable.update(
        interchange_state="model-package-not-included",
        recovery="reimport-the-exact-declared-package-before-use",
    )
    recoverable = workbench.project.put_document(
        "model",
        document["id"],
        portable,
        expected_revision=document["revision"],
    )
    shutil.rmtree(private)
    return imported, recoverable, private


def test_import_is_reference_qualified_project_managed_and_path_free(tmp_path):
    workbench = _workbench(tmp_path)
    package, _ = _native_package(tmp_path / "package")

    imported = import_model(workbench, package, working_bytes=256 * 1024**2)
    listed = execute_model(workbench, "model_list", {})

    assert imported == listed["models"][0]
    assert len(imported["model_id"]) == 32
    assert imported["reference_qualification"]["compatible"] is True
    assert imported["technical_compatibility"].startswith("reference-qualified")
    assert imported["scientific_validation"]["status"] == "unvalidated"
    assert imported["usage_rights"] == {
        "supplier_declarations": {
            "license": "CC0-1.0",
            "redistribution": "allowed",
            "commercial_use": "allowed",
            "training_data": "synthetic values only",
        },
        "review_state": "independent-rights-review-required",
    }
    encoded = json.dumps(imported)
    assert str(tmp_path) not in encoded
    models_root = workbench.project.root / "models"
    assert models_root.is_dir() and not models_root.is_symlink()
    if os.name != "nt":
        assert stat_mode(models_root) == 0o700


def test_portable_model_lists_as_recoverable_and_exact_reimport_reruns_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    _, source = _source(workbench, tmp_path)
    historical = workbench.execute(
        "run_recipe",
        {"source_id": source["id"], "recipe": {"segmentation": {"threshold": 0.5}}},
    )["result"]
    historical_record = workbench.project.result(historical["id"])
    package, _ = _native_package(tmp_path / "package")
    imported, recoverable, managed_path = _make_recoverable_model(workbench, package)

    listed = execute_model(workbench, "model_list", {})["models"]
    assert listed[0]["model_id"] == imported["model_id"]
    assert listed[0]["availability"] == {
        "state": "reimport-required",
        "summary": "Re-import the exact declared package to rerun its reference qualification.",
        "recovery": "reimport-the-exact-declared-package-before-use",
    }
    assert listed[0]["technical_compatibility"].startswith("historical qualification")
    assert str(tmp_path) not in json.dumps(listed)
    with pytest.raises(ValueError, match="re-import the exact declared package"):
        execute_model(
            workbench,
            "model_preview",
            _request(imported["model_id"], source["id"]),
        )

    reference_runs = 0
    original_reference_test = model_packages.run_reference_test

    def counted_reference_test(*args, **kwargs):
        nonlocal reference_runs
        reference_runs += 1
        return original_reference_test(*args, **kwargs)

    monkeypatch.setattr(model_packages, "run_reference_test", counted_reference_test)
    restored = import_model(workbench, package, working_bytes=256 * 1024**2)

    assert reference_runs == 2
    assert restored["model_id"] == imported["model_id"]
    assert restored["revision"] == recoverable["revision"] + 1
    assert restored["availability"]["state"] == "ready"
    assert managed_path.is_dir() and not managed_path.is_symlink()
    assert workbench.project.result(historical["id"]) == historical_record
    preview = execute_model(
        workbench,
        "model_preview",
        _request(restored["model_id"], source["id"]),
    )
    assert preview["preview"]["reference_qualification"]["compatible"] is True


def test_recovery_rejects_a_different_package_without_adopting_it(tmp_path: Path) -> None:
    workbench = _workbench(tmp_path)
    package, _ = _native_package(tmp_path / "declared-package")
    imported, recoverable, _managed_path = _make_recoverable_model(workbench, package)
    different, _ = _native_package(
        tmp_path / "different-package",
        shape=(1, 1, 10, 10),
    )

    with pytest.raises(ValueError, match="exact package declared"):
        import_model(
            workbench,
            different,
            working_bytes=256 * 1024**2,
            recovery_model_id=imported["model_id"],
        )

    assert workbench.project.documents("model") == [recoverable]
    assert list((workbench.project.root / "models").iterdir()) == []
    # An unavailable historical model does not prevent intentionally adding a
    # different model. It remains a separate identity and cannot replace it.
    added = import_model(workbench, different, working_bytes=256 * 1024**2)
    assert added["model_id"] != imported["model_id"]
    assert (
        next(
            item for item in workbench.project.documents("model") if item["id"] == recoverable["id"]
        )
        == recoverable
    )


def test_corrupted_recoverable_model_is_neither_listed_nor_reimported(tmp_path: Path) -> None:
    workbench = _workbench(tmp_path)
    package, _ = _native_package(tmp_path / "package")
    _imported, recoverable, _managed_path = _make_recoverable_model(workbench, package)
    corrupted = json.loads(json.dumps(recoverable["data"]))
    corrupted["package"]["rights"]["license"] = "forged"
    workbench.project.put_document(
        "model",
        recoverable["id"],
        corrupted,
        expected_revision=recoverable["revision"],
    )

    with pytest.raises(ValueError, match="qualification is inconsistent"):
        execute_model(workbench, "model_list", {})
    with pytest.raises(ValueError, match="qualification is inconsistent"):
        import_model(workbench, package, working_bytes=256 * 1024**2)
    assert list((workbench.project.root / "models").iterdir()) == []


def test_recovery_cas_change_cleans_newly_adopted_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    package, _ = _native_package(tmp_path / "package")
    imported, recoverable, managed_path = _make_recoverable_model(workbench, package)
    original_import = research_models_module.import_model_package

    def import_then_change_document(*args, **kwargs):
        adopted = original_import(*args, **kwargs)
        workbench.project.put_document(
            "model",
            recoverable["id"],
            recoverable["data"],
            expected_revision=recoverable["revision"],
        )
        return adopted

    monkeypatch.setattr(
        research_models_module,
        "import_model_package",
        import_then_change_document,
    )
    with pytest.raises(ValueError, match="Study document changed"):
        import_model(workbench, package, working_bytes=256 * 1024**2)

    current = workbench.project.documents("model")[0]
    assert current["id"] == imported["model_id"]
    assert current["revision"] == recoverable["revision"] + 1
    assert current["data"]["recovery"] == "reimport-the-exact-declared-package-before-use"
    assert not managed_path.exists()


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def test_preview_then_exact_adoption_persists_probabilities_labels_and_raw_measurements(
    tmp_path,
):
    workbench = _workbench(tmp_path)
    source_path, source = _source(workbench, tmp_path)
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    package, _ = _native_package(tmp_path / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)

    preview = execute_model(workbench, "model_preview", _request(model["model_id"], source["id"]))
    assert preview["adopted"] is False
    assert preview["preview"]["source"]["sha256"] == source["sha256"]
    assert preview["preview"]["source"]["channel_mapping"] == [
        {
            "model_input_index": 0,
            "model_channel": "input-0",
            "package_source_slot": 0,
            "source_channel": 0,
        }
    ]
    assert preview["preview"]["runtime"]["backend"] == "onnxruntime"
    assert preview["preview"]["segmentation_postprocessing"]["threshold"] == 0.5
    assert preview["preview"]["segmentation_postprocessing"]["method"] == "components"
    assert preview["preview"]["output"]["probabilities_axes"] == "CYX"
    assert preview["preview"]["output"]["object_count"] == 1
    assert preview["overlay_png"].startswith("data:image/png;base64,")
    png = b64decode(preview["overlay_png"].partition(",")[2], validate=True)
    with Image.open(BytesIO(png)) as image:
        assert image.format == "PNG"
        assert image.mode == "RGB"
        assert image.size == (13, 11)
    assert preview["preview"]["source"]["display"]["purpose"].startswith("display-only")
    assert preview["preview"]["source"]["display"]["png_sha256"] == hashlib.sha256(png).hexdigest()
    assert preview["measurements"][0]["intensity"]["source_channel_0"]["mean"] == pytest.approx(0.8)
    assert workbench.project.list_results() == []
    with pytest.raises(ValueError, match="exact persisted preview"):
        execute_model(
            workbench,
            "model_run",
            {"preview_id": preview["preview"]["id"], "preview_sha256": "0" * 64},
        )

    adopted = execute_model(
        workbench,
        "model_run",
        {
            "preview_id": preview["preview"]["id"],
            "preview_sha256": preview["preview"]["preview_sha256"],
        },
    )
    result = workbench.project.result(adopted["result"]["id"])
    assert adopted["adopted"] is True
    assert set(result["arrays"]) == {"image", "probabilities", "labels"}
    assert workbench.project.load_array(result["arrays"]["probabilities"]).shape == (1, 11, 13)
    assert workbench.project.load_array(result["arrays"]["labels"]).dtype == np.uint32
    assert result["provenance"]["model_preview"]["sha256"] == preview["preview"]["preview_sha256"]
    assert result["provenance"]["measurement_basis"].startswith("raw-selected")
    assert (
        result["provenance"]["probabilities"][0]["sha256"]
        == preview["preview"]["output"]["probability_channels"][0]["sha256"]
    )
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == source_hash


def test_scale_mismatch_requires_and_records_an_explicit_no_resample_override(tmp_path):
    workbench = _workbench(tmp_path)
    _, source = _source(workbench, tmp_path, scale=1.0)
    package, _ = _native_package(tmp_path / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)
    request = _request(model["model_id"], source["id"])
    with pytest.raises(ValueError, match="exactly equal|implicit resampling"):
        execute_model(workbench, "model_preview", request)

    request["scale"] = {
        "mode": "override",
        "scale_yx": [0.5, 0.5],
        "scale_unit": "um",
        "declaration": "Calibration unavailable; analyst explicitly declares 0.5 um/pixel.",
    }
    request["selection"].update({"x": 2, "y": 1, "width": 10, "height": 9})
    _plane, expected_geometry, _resolved = workbench.load_scalar(
        source["id"], {**request["selection"], "c": 0}
    )
    preview = execute_model(workbench, "model_preview", request)["preview"]
    assert preview["source"]["scale"] == {
        "mode": "override",
        "source_geometry": {"scale_yx": [1.0, 1.0], "scale_unit": "um"},
        "model_input": {"scale_yx": [0.5, 0.5], "scale_unit": "um"},
        "override_declaration": (
            "Calibration unavailable; analyst explicitly declares 0.5 um/pixel."
        ),
        "override_scope": "model-input-compatibility-only",
        "scientific_output_geometry": "registered-source-geometry-unchanged",
        "resampled": False,
    }
    expected_geometry_record = expected_geometry.to_dict()
    expected_geometry_record["affine"] = [list(row) for row in expected_geometry.affine]
    assert preview["source"]["geometry"] == expected_geometry_record
    adopted = execute_model(
        workbench,
        "model_run",
        {"preview_id": preview["id"], "preview_sha256": preview["preview_sha256"]},
    )
    result = workbench.project.result(adopted["result"]["id"])
    assert result["provenance"]["geometry"] == preview["source"]["geometry"]
    assert adopted["measurements"][0]["measure"] == pytest.approx(36.0)
    assert adopted["measurements"][0]["measure_unit"] == "um^2"


def test_stale_source_or_managed_package_invalidates_preview_before_adoption(tmp_path):
    first_root = tmp_path / "first"
    first_root.mkdir()
    workbench = _workbench(first_root)
    source_path, source = _source(workbench, first_root)
    package, _ = _native_package(first_root / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)
    preview = execute_model(workbench, "model_preview", _request(model["model_id"], source["id"]))[
        "preview"
    ]
    source_path.write_bytes(source_path.read_bytes() + b"changed")
    with pytest.raises((ValueError, RuntimeError), match="fingerprint|changed"):
        execute_model(
            workbench,
            "model_run",
            {"preview_id": preview["id"], "preview_sha256": preview["preview_sha256"]},
        )
    assert workbench.project.list_results() == []

    second_root = tmp_path / "second"
    second_root.mkdir()
    workbench = _workbench(second_root)
    _, source = _source(workbench, second_root)
    package, _ = _native_package(second_root / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)
    preview = execute_model(workbench, "model_preview", _request(model["model_id"], source["id"]))[
        "preview"
    ]
    private = workbench.project.documents("model")[0]["data"]["private_path"]
    manifest = Path(private) / "loci-model.json"
    manifest.write_text(manifest.read_text() + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="identity changed"):
        execute_model(
            workbench,
            "model_run",
            {"preview_id": preview["id"], "preview_sha256": preview["preview_sha256"]},
        )
    assert workbench.project.list_results() == []


def test_publication_guard_rechecks_exact_model_revision_after_array_staging(tmp_path, monkeypatch):
    workbench = _workbench(tmp_path)
    _, source = _source(workbench, tmp_path)
    package, _ = _native_package(tmp_path / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)
    preview = execute_model(workbench, "model_preview", _request(model["model_id"], source["id"]))[
        "preview"
    ]
    original_save = workbench.project.save_result

    def mutate_model_then_stage(**kwargs):
        document = workbench.project.documents("model")[0]
        workbench.project.put_document(
            "model",
            document["id"],
            document["data"],
            expected_revision=document["revision"],
        )
        return original_save(**kwargs)

    monkeypatch.setattr(workbench.project, "save_result", mutate_model_then_stage)
    with pytest.raises(ValueError, match="Managed model changed before result publication"):
        execute_model(
            workbench,
            "model_run",
            {"preview_id": preview["id"], "preview_sha256": preview["preview_sha256"]},
        )
    assert workbench.project.list_results() == []


def test_reference_mismatch_never_imports_or_creates_model_record(tmp_path):
    workbench = _workbench(tmp_path)
    package, _ = _native_package(tmp_path / "package")
    expected = np.load(package / "reference-output.npy", allow_pickle=False)
    np.save(package / "reference-output.npy", expected + np.float32(0.1))
    manifest_path = package / "loci-model.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["reference"]["output"]["sha256"] = _sha(package / "reference-output.npy")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(model_packages.ModelPackageError, match="reference test failed"):
        import_model(workbench, package, working_bytes=256 * 1024**2)
    assert workbench.project.documents("model") == []
    assert not list((workbench.project.root / "models").iterdir())


def test_unseen_conforming_bioimageio_package_uses_same_managed_workflow(tmp_path):
    workbench = _workbench(tmp_path)
    package = _bioimage_package(tmp_path / "unseen-package")
    imported = import_model(workbench, package, working_bytes=256 * 1024**2)
    assert imported["package"]["source_format"] == "bioimage.io-0.5"
    assert imported["package"]["id"] == "unseen-conforming-model"
    assert imported["reference_qualification"]["comparison"]["mismatched_elements"] == 0
    assert imported["usage_rights"]["review_state"] == "independent-rights-review-required"


def test_rgb_source_is_never_treated_as_a_biological_channel(tmp_path):
    workbench = _workbench(tmp_path)
    rgb_path = tmp_path / "rgb.tif"
    tifffile.imwrite(rgb_path, np.full((11, 13, 3), 1, np.uint8), photometric="rgb")
    source = workbench.import_native(str(rgb_path))
    package, _ = _native_package(tmp_path / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)
    request = _request(
        model["model_id"],
        source["id"],
        scale={
            "mode": "override",
            "scale_yx": [0.5, 0.5],
            "scale_unit": "um",
            "declaration": "Synthetic RGB rejection test scale declaration.",
        },
    )
    with pytest.raises(ValueError, match="not biological channels"):
        execute_model(workbench, "model_preview", request)
    assert workbench.project.list_results() == []


def test_model_dtos_never_expose_managed_paths_or_source_names(tmp_path):
    workbench = _workbench(tmp_path)
    _, source = _source(workbench, tmp_path)
    package, _ = _native_package(tmp_path / "package")
    model = import_model(workbench, package, working_bytes=256 * 1024**2)
    preview = execute_model(workbench, "model_preview", _request(model["model_id"], source["id"]))
    encoded = json.dumps({"model": model, "preview": preview})
    assert str(tmp_path) not in encoded
    assert "untrusted source prompt" not in encoded
    assert "untrusted nucleus prompt" not in encoded
    assert "private_path" not in encoded
    assert os.fspath(workbench.project.root / "models") not in encoded
