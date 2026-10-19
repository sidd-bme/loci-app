"""Synthetic source-bound description checks; no analysis runs inside description."""

import hashlib
import json

import numpy as np
import pytest
import tifffile

from loci_engine.agent_policy import OPERATIONS
from loci_engine.research_annotations import label_array_sha256
from loci_engine.research_labels_import import ALIGNMENT, create_import_grant
from loci_engine.research_operations import OPERATION_CATALOG
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_result_context import method_label
from loci_engine.workbench import Workbench


@pytest.fixture
def scene(tmp_path):
    image = np.zeros((2, 24, 24), np.uint16)
    image[0, 3:9, 3:9] = 100
    image[0, 13:20, 13:20] = 200
    image[1] = 73
    file = tmp_path / "source.ome.tif"
    tifffile.imwrite(
        file,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1,
            "Channel": {"Name": ["Acquisition A", "Acquisition B"]},
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Context checks"))
    source = wb.import_native(str(file))
    yield wb, source, file
    wb.close()


def recipe_result(scene):
    wb, source, _ = scene
    return wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {
                "steps": [{"op": "subtract_constant", "value": -2}],
                "segmentation": {"threshold": 50},
                "measurement_channels": [1],
            },
        },
    )["result"]


def describe(wb, result):
    return wb.execute(
        "describe_result", {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    )


def rewrite(wb, result, update):
    record = wb.project.result(result["id"])
    update(record)
    record.pop("revision_hash")
    record["revision_hash"] = hashlib.sha256(canonical_json(record).encode()).hexdigest()
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(record), record["id"])
        )
    return record


@pytest.mark.parametrize("generic_method", ["components", "watershed"])
@pytest.mark.parametrize(
    ("kind", "label"),
    [
        ("declared-stain-analysis", "Declared stain analysis"),
        ("tissue-region-mask", "Tissue region mask"),
        ("puncta-quantification", "Puncta detection"),
        ("nucleus-cell-association", "Nucleus-cell association"),
        ("field-assay", "Fluorescence field assay"),
        ("large-components", "Threshold segmentation"),
    ],
)
def test_specific_result_kind_wins_over_generic_segmentation(kind, label, generic_method):
    record = {"kind": kind, "provenance": {"segmentation": {"method": generic_method}}}
    before = canonical_json(record)
    assert method_label(record) == label
    assert canonical_json(record) == before


def test_association_measurement_variant_retains_its_explicit_label():
    record = {
        "kind": "nucleus-cell-association",
        "provenance": {
            "compartment_measurement": {},
            "segmentation": {"method": "components"},
        },
    }
    assert method_label(record) == "Compartment measurements"
    # A compartment record inherited by another method does not rename its kind.
    record["kind"] = "declared-stain-analysis"
    assert method_label(record) == "Declared stain analysis"


def test_generic_segmentation_retains_its_producing_method():
    assert (
        method_label(
            {"kind": "segmentation", "provenance": {"segmentation": {"method": "watershed"}}}
        )
        == "Watershed segmentation"
    )
    assert (
        method_label(
            {"kind": "segmentation", "provenance": {"segmentation": {"method": "components"}}}
        )
        == "Threshold segmentation"
    )
    assert method_label({"kind": "unknown-analysis", "provenance": {}}) == "Analysis result"


def test_declared_hdab_summary_and_context_do_not_rename_or_mutate_saved_result(
    scene, tmp_path, monkeypatch
):
    wb, _, _ = scene
    rgb = np.full((12, 16, 3), 255, np.uint8)
    rgb[2:8, 3:9] = [90, 120, 160]
    file = tmp_path / "authored-rgb.tif"
    tifffile.imwrite(file, rgb, photometric="rgb", metadata={"axes": "YXS"})
    source = wb.import_native(str(file))
    result = wb.execute(
        "histology_run",
        {
            "source_id": source["id"],
            "selection": {"level": 0},
            "basis": "H-DAB",
            "component": 1,
            "segmentation": {"method": "components", "threshold": 0.0},
        },
    )["result"]
    saved = wb.project.result(result["id"])
    assert saved["kind"] == "declared-stain-analysis"
    assert saved["provenance"]["segmentation"]["method"] == "components"
    assert saved["provenance"]["stain_separation"]["declared_basis"] == "H-DAB"
    frozen = canonical_json(saved)
    original = hashlib.sha256(file.read_bytes()).hexdigest()
    arrays = {
        name: wb.project.load_array(descriptor).copy()
        for name, descriptor in saved["arrays"].items()
    }
    monkeypatch.setattr(wb, "load_scalar", lambda *a, **k: pytest.fail("description read pixels"))
    context = describe(wb, result)
    summary = next(row for row in wb.snapshot()["results"] if row["id"] == saved["id"])
    assert result["method_label"] == summary["method_label"] == "Declared stain analysis"
    assert context["method_label"] == context["producing_method_label"] == "Declared stain analysis"
    assert context["result_id"] == saved["id"]
    assert context["revision_hash"] == summary["revision_hash"] == saved["revision_hash"]
    assert context["kind"] == summary["kind"] == saved["kind"]
    assert canonical_json(wb.project.result(saved["id"])) == frozen
    assert hashlib.sha256(file.read_bytes()).hexdigest() == original
    for name, descriptor in saved["arrays"].items():
        np.testing.assert_array_equal(wb.project.load_array(descriptor), arrays[name])


def test_recipe_description_preserves_bytes_settings_and_original_replay(scene, monkeypatch):
    wb, source, file = scene
    result = recipe_result(scene)
    before = canonical_json(wb.project.result(result["id"]))
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    monkeypatch.setattr(wb, "load_scalar", lambda *a, **k: pytest.fail("description read pixels"))
    monkeypatch.setattr(
        wb, "validate_recipe", lambda *a, **k: pytest.fail("description ran analysis")
    )
    context = describe(wb, result)
    assert context["method_label"] == result["method_label"] == "Threshold segmentation"
    assert context["kind"] == "segmentation"
    assert context["source_sha256"] == source["sha256"]
    assert context["calibration"]["unit"] == "um"
    assert context["calibration"]["affine"][0][0] == 0.5
    assert context["channels"]["measurement"] == [1]
    assert [item["name"] for item in context["channels"]["names"]] == [
        "Acquisition A",
        "Acquisition B",
    ]
    fields = {item["source"]: item["value"] for item in context["settings"]}
    assert fields["provenance.segmentation.threshold"] == 50
    assert fields["provenance.processing[0].value"] == -2
    assert context["replay"]["operation"] == "run_recipe"
    persisted = wb.project.result(result["id"])["provenance"]
    assert context["replay"]["request"] == {
        "source_id": source["id"],
        "selection": persisted["selection"],
        "recipe": persisted["recipe"],
    }
    assert "measurements" not in json.dumps(context)
    assert before == canonical_json(wb.project.result(result["id"]))
    assert digest == hashlib.sha256(file.read_bytes()).hexdigest()


def test_stale_revision_missing_result_and_changed_source_fail_closed(scene):
    wb, _, file = scene
    result = recipe_result(scene)
    with pytest.raises(ValueError, match="revision mismatch"):
        wb.execute("describe_result", {"result_id": result["id"], "revision_hash": "0" * 64})
    with pytest.raises(ValueError, match="not part of this study"):
        wb.execute("describe_result", {"result_id": "0" * 32, "revision_hash": "0" * 64})
    with pytest.raises(ValueError, match="exact revision"):
        wb.execute("describe_result", {"result_id": result["id"]})
    file.write_bytes(file.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="source is unavailable or changed"):
        describe(wb, result)


def test_imported_labels_retains_upstream_unknown_and_sparse_identity(scene, tmp_path):
    wb, source, _ = scene
    labels = np.zeros((24, 24), np.uint32)
    labels[2:5, 2:5] = 4000000000
    file = tmp_path / "external.tif"
    tifffile.imwrite(file, labels, metadata={"axes": "YX"})
    grant = create_import_grant(
        wb, str(file), source["id"], source["sha256"], {"t": 0, "c": 1, "z": 0, "level": 0}
    )
    result = wb.execute(
        "labels_import",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "grant_id": grant["grant_id"],
            "alignment": ALIGNMENT,
            "producer": {"name": "Declared producer", "version": "1.2"},
        },
    )["result"]
    before = canonical_json(wb.project.result(result["id"]))
    context = describe(wb, result)
    assert context["method_label"] == "Imported labels"
    assert context["replay"]["status"] == "unsupported"
    assert context["channels"]["measurement"] == [1]
    assert any(item["value"] == "Declared producer" for item in context["importer"])
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["labels"]), labels)
    assert before == canonical_json(wb.project.result(result["id"]))


def test_corrected_child_has_bound_parent_original_method_and_audit(scene):
    wb, _, _ = scene
    parent = recipe_result(scene)
    labels = wb.project.load_array(parent["arrays"]["labels"])
    child = wb.execute(
        "correct_result",
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "operations": [
                {"op": "delete", "label": 1, "expected_input_sha256": label_array_sha256(labels)}
            ],
        },
    )["result"]
    context = describe(wb, child)
    assert context["method_label"] == "Corrected segmentation"
    assert context["producing_method_label"] == "Threshold segmentation"
    assert context["parents"] == [
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "kind": parent["kind"],
            "method_label": "Threshold segmentation",
            "revision_bound": True,
        }
    ]
    assert any(item["value"] == "delete" for item in context["correction"])
    assert context["replay"]["status"] == "unsupported"
    changed = rewrite(
        wb, child, lambda r: r["provenance"]["correction"].update(parent_revision_hash="0" * 64)
    )
    with pytest.raises(ValueError, match="parent revision mismatch"):
        describe(wb, changed)


def test_classical_description_reconstructs_exact_accepted_request(scene):
    from loci_engine.models import SegmentationSettings
    from loci_engine.profiles import DEFAULT_PROFILE_ID

    wb, source, _ = scene
    request = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 24,
            "height": 24,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "profile_id": DEFAULT_PROFILE_ID,
        "settings": SegmentationSettings(min_area_px=4, expected_diameter_px=8).to_dict(),
        "measurement_channels": [1],
        "working_bytes": 64 * 1024**2,
    }
    result = wb.execute("classical_run", request)["result"]
    context = describe(wb, result)
    assert context["method_label"] == "Adaptive watershed segmentation"
    assert context["replay"]["request"] == request
    assert context["replay"]["operation"] == "classical_run"
    assert {item["name"] for item in context["settings"]} >= set(request["settings"])


def test_compartment_description_uses_own_raw_channels_basis_and_exact_inputs(scene, monkeypatch):
    wb, source, _ = scene
    cells = recipe_result(scene)
    nuclei = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {
                "steps": [],
                "segmentation": {"threshold": 150},
                "measurement_channels": [1],
            },
        },
    )["result"]
    result = wb.execute(
        "associate_results",
        {
            "nuclei": {"result_id": nuclei["id"], "revision_hash": nuclei["revision_hash"]},
            "cells": {"result_id": cells["id"], "revision_hash": cells["revision_hash"]},
            "roles": {"nuclei": "Authored inner regions", "cells": "Authored whole regions"},
            "control": "Synthetic computational context regression",
            "measurement_channels": [0],
        },
    )["result"]
    monkeypatch.setattr(wb, "load_scalar", lambda *a, **k: pytest.fail("description read pixels"))
    context = describe(wb, result)
    assert (
        context["method_label"] == context["producing_method_label"] == "Compartment measurements"
    )
    assert context["channels"]["measurement"] == [0]
    assert context["channels"]["names"] == [
        {
            "index": 0,
            "name": "Acquisition A",
            "source": "provenance.compartment_measurement.channel_metadata.channels[0].name",
        }
    ]
    assert (
        context["measurement_basis"]
        == "raw source-channel bytes on the exact selected native label grid"
    )
    assert context["parents"][0]["revision_bound"] is True
    assert context["replay"]["status"] == "unsupported"
    recorded = {field["source"]: field["value"] for field in context["settings"]}
    assert (
        recorded["provenance.compartment_measurement.label_inputs.nuclei.revision_hash"]
        == nuclei["revision_hash"]
    )
    assert (
        recorded["provenance.compartment_measurement.partition.cytoplasm"]
        == "(cells == cell_id) & (nuclei == 0)"
    )
    changed = rewrite(
        wb,
        result,
        lambda r: r["provenance"]["compartment_measurement"]["label_inputs"]["nuclei"].update(
            revision_hash="0" * 64
        ),
    )
    with pytest.raises(ValueError, match="label input identity mismatch"):
        describe(wb, changed)


def test_managed_model_reports_persisted_runtime_and_mapping_without_execution(
    tmp_path, monkeypatch
):
    from test_model_packages import _native_package
    from test_research_models import _request, _source, _workbench

    from loci_engine.research_models import import_model

    wb = _workbench(tmp_path)
    try:
        _, source = _source(wb, tmp_path)
        package, _ = _native_package(tmp_path / "package")
        model = import_model(wb, package, working_bytes=256 * 1024**2)
        preview = wb.execute("model_preview", _request(model["model_id"], source["id"]))
        result = wb.execute(
            "model_run",
            {
                "preview_id": preview["preview"]["id"],
                "preview_sha256": preview["preview"]["preview_sha256"],
            },
        )["result"]
        monkeypatch.setattr(wb, "load_scalar", lambda *a, **k: pytest.fail("model executed"))
        context = describe(wb, result)
        assert context["method_label"] == "Model segmentation"
        assert any(item["value"] == "onnxruntime" for item in context["runtime"])
        assert any(
            item["source"] == "provenance.channel_mapping[0].source_channel"
            for item in context["settings"]
        )
        assert context["model"]
        assert context["replay"]["status"] == "unsupported"
        assert str(tmp_path) not in json.dumps(context)
    finally:
        wb.close()


def test_legacy_missing_provenance_is_explicit_and_arbitrary_paths_are_omitted(scene):
    wb, source, file = scene
    result = wb.project.save_result(
        source_id=source["id"],
        kind="processed",
        arrays={"image": np.zeros((24, 24))},
        provenance={"private_path": str(file), "measurements": [{"private": str(file)}]},
    )
    context = describe(wb, result)
    assert set(context["unavailable"]) >= {
        "settings",
        "selection",
        "runtime",
        "calibration",
        "measurement_basis",
    }
    assert context["replay"]["status"] == "unsupported"
    assert str(file) not in json.dumps(context)
    result = rewrite(
        wb,
        result,
        lambda r: r["provenance"].update(
            runtime={"backend": str(file)}, settings={"image_mode": str(file)}
        ),
    )
    context = describe(wb, result)
    assert str(file) not in json.dumps(context)
    assert "provenance.runtime.backend" in context["unavailable"]


def test_new_desktop_context_does_not_widen_mcp_operations_or_disclosures(tmp_path):
    from test_research_mcp import make_agent

    agent, wb, _, request, _, _ = make_agent(tmp_path)
    try:
        result = wb.run_recipe(request)["result"]
        assert result["method_label"]
        assert OPERATION_CATALOG["describe_result"]["mutates"] is False
        assert "describe_result" not in OPERATIONS
        with pytest.raises(PermissionError, match="operation"):
            agent.inspect_action(
                "describe_result",
                {"result_id": result["id"], "revision_hash": result["revision_hash"]},
            )
        assert set(agent.result(result["id"])["result"]) == {
            "id",
            "revision_hash",
            "kind",
            "review",
        }
    finally:
        wb.close()


def test_original_recipe_reference_mismatch_is_rejected(scene, tmp_path):
    wb, source, _ = scene
    ref_file = tmp_path / "reference.tif"
    tifffile.imwrite(
        ref_file,
        np.ones((24, 24), np.uint16),
        ome=True,
        metadata={"axes": "YX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 1},
    )
    reference = wb.import_native(str(ref_file))
    result = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "recipe": {
                "steps": [{"op": "flatfield"}],
                "references": {"flatfield": {"source_id": reference["id"], "selection": {}}},
            },
        },
    )["result"]
    assert describe(wb, result)["replay"]["status"] == "available"
    changed = rewrite(
        wb,
        result,
        lambda r: r["provenance"]["references"]["flatfield"].update(source_sha256="0" * 64),
    )
    with pytest.raises(ValueError, match="reference identity mismatch"):
        describe(wb, changed)


def test_recipe_hash_mismatch_and_nonfinite_persisted_values_fail_closed(scene):
    wb, _, _ = scene
    result = recipe_result(scene)
    altered = rewrite(wb, result, lambda r: r["provenance"].update(recipe_sha256="0" * 64))
    with pytest.raises(ValueError, match="recipe hash mismatch"):
        describe(wb, altered)
    from loci_engine.research_result_context import _value

    with pytest.raises(ValueError, match="non-finite"):
        _value(float("inf"))


def test_missing_source_errors_do_not_disclose_canonical_path(scene):
    wb, _, file = scene
    result = recipe_result(scene)
    file.unlink()
    with pytest.raises(ValueError, match="source is unavailable") as caught:
        describe(wb, result)
    assert str(file) not in str(caught.value)


def test_source_binding_corrupt_record_and_parent_bounds_are_checked(scene, monkeypatch):
    import loci_engine.research_result_context as context_module

    wb, source, _ = scene
    original = recipe_result(scene)
    mismatched = rewrite(wb, original, lambda r: r.update(source_sha256="0" * 64))
    with pytest.raises(ValueError, match="source identity mismatch"):
        describe(wb, mismatched)
    # Repair the synthetic identity deliberately; description never repairs it.
    parent = rewrite(wb, mismatched, lambda r: r.update(source_sha256=source["sha256"]))
    child = wb.project.save_result(
        source_id=source["id"],
        kind="processed",
        parent_id=parent["id"],
        arrays={"image": np.zeros((24, 24))},
        provenance={},
    )
    grandchild = wb.project.save_result(
        source_id=source["id"],
        kind="processed",
        parent_id=child["id"],
        arrays={"image": np.zeros((24, 24))},
        provenance={},
    )
    monkeypatch.setattr(context_module, "MAX_ANCESTRY", 1)
    with pytest.raises(ValueError, match="bounded limit"):
        describe(wb, grandchild)
    monkeypatch.setattr(context_module, "MAX_ANCESTRY", 32)
    rewrite(wb, parent, lambda r: r.update(parent_id=grandchild["id"]))
    with pytest.raises(ValueError, match="cyclic"):
        describe(wb, grandchild)
    with wb.project.connection() as connection:
        connection.execute("UPDATE results SET record=? WHERE id=?", ("{}", child["id"]))
    with pytest.raises(ValueError, match="integrity verification"):
        describe(wb, child)


def test_unknown_or_redacted_recipe_cannot_become_a_replay_request(scene):
    wb, _, file = scene
    result = recipe_result(scene)

    def redact(record):
        recipe = record["provenance"]["recipe"]
        recipe["gates"] = [
            {"name": "gate", "channel": str(file), "threshold": 1, "control": "source"}
        ]
        record["provenance"]["recipe_sha256"] = hashlib.sha256(
            canonical_json(recipe).encode()
        ).hexdigest()
        record["provenance"]["arbitrary_tree"] = {"path": str(file), "values": [1] * 10000}

    revised = rewrite(wb, result, redact)
    context = describe(wb, revised)
    assert context["replay"]["status"] == "unsupported"
    assert str(file) not in json.dumps(context)
    assert "arbitrary_tree" not in json.dumps(context)
    assert "provenance.recipe.gates[0].channel" in context["unavailable"]


def test_bounded_response_and_settings_fail_explicitly(scene, monkeypatch):
    import loci_engine.research_result_context as context_module

    wb, _, _ = scene
    result = recipe_result(scene)
    monkeypatch.setattr(context_module, "MAX_RESPONSE_BYTES", 100)
    with pytest.raises(ValueError, match="bounded response"):
        describe(wb, result)
    monkeypatch.setattr(context_module, "MAX_RESPONSE_BYTES", 65536)
    monkeypatch.setattr(context_module, "MAX_FIELDS", 1)
    with pytest.raises(ValueError, match="field limit"):
        describe(wb, result)
