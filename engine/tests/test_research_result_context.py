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
    assert context["cli_recipe"] == {
        "status": "available",
        "route": "native-2d-level0-cpu-components-run-recipe",
        "operation": "run_recipe",
        "recipe_sha256": persisted["recipe_sha256"],
        "reason": None,
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
            "producer": {"name": "Declared producer", "version": "1.2", "model": "declared model"},
        },
    )["result"]
    before = canonical_json(wb.project.result(result["id"]))
    context = describe(wb, result)
    assert context["method_label"] == "Imported labels"
    assert context["replay"]["status"] == "unsupported"
    assert context["channels"]["measurement"] == [1]
    assert any(item["value"] == "Declared producer" for item in context["importer"])
    assert {
        "name": "model",
        "value": "declared model",
        "source": "provenance.external_labels.producer.model",
    } in context["importer"]
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


def test_cli_recipe_accepts_durable_otsu_crop_and_gates_and_rejects_channel_rename(tmp_path):
    from loci_engine.research_jobs import run_job, submit_job

    image = np.zeros((2, 2, 2, 24, 24), np.uint16)
    image[1, 0, 1, 4:10, 5:11] = 150
    image[1, 0, 1, 14:20, 12:18] = 220
    image[1, 1, 1] = 40
    image[1, 1, 1, 14:20, 12:18] = 95
    file = tmp_path / "tcz.ome.tif"
    tifffile.imwrite(
        file,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.0,
            "Channel": {"Name": ["DAPI", "Marker"]},
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study.loci-study", "CLI eligible"))
    try:
        source = wb.import_native(str(file))
        request = {
            "source_id": source["id"],
            "selection": {
                "x": 2,
                "y": 2,
                "width": 20,
                "height": 20,
                "t": 1,
                "c": 0,
                "z": 1,
                "level": 0,
            },
            "recipe": {
                "steps": [{"op": "gaussian", "sigma": 0.5}],
                "segmentation": {
                    "method": "components",
                    "threshold": "otsu",
                    "polarity": "bright",
                    "min_size": 4,
                    "exclude_border": False,
                },
                "measurement_channels": [0, 1],
                "gates": [
                    {
                        "name": "positive",
                        "channel": "2: Marker",
                        "statistic": "mean",
                        "threshold": 70,
                        "control": "synthetic threshold",
                    }
                ],
            },
        }
        job = submit_job(wb, request, "durable-eligible-1", "run_recipe")
        run_output = run_job(wb, job["id"])
        result = run_output["result"]
        context = describe(wb, result)
        persisted = wb.project.result(result["id"])["provenance"]
        assert context["cli_recipe"] == {
            "status": "available",
            "route": "native-2d-level0-cpu-components-run-recipe",
            "operation": "run_recipe",
            "recipe_sha256": persisted["recipe_sha256"],
            "reason": None,
        }
        assert "measurements" not in json.dumps(context)
        wb.execute(
            "channels",
            {
                "source_id": source["id"],
                "expected_revision": 0,
                "channels": [
                    {
                        "index": 0,
                        "name": "DAPI",
                        "marker": "",
                        "fluorophore": "",
                        "declaration": "",
                    },
                    {
                        "index": 1,
                        "name": "Renamed Marker",
                        "marker": "",
                        "fluorophore": "",
                        "declaration": "",
                    },
                ],
            },
        )
        renamed = describe(wb, result)
        assert renamed["cli_recipe"]["status"] == "unsupported"
        assert "measurements" not in json.dumps(renamed)
    finally:
        wb.close()


def test_cli_recipe_rejects_unsupported_routes(scene, tmp_path):
    from dataclasses import asdict

    from test_ome_zarr import _store
    from test_research_exploration import import_image as import_exploration_image
    from test_research_vendor import _derivation
    from test_research_workflow import definition as workflow_definition

    from loci_engine.native_image import NativeImageSession
    from loci_engine.research_exploration import dispatch_exploration
    from loci_engine.research_jobs import run_job, submit_job

    wb, source, file = scene
    base_result = recipe_result(scene)

    def assert_unsupported(target_wb, result_obj, *, hidden_path=None):
        ctx = describe(target_wb, result_obj)
        assert ctx["cli_recipe"]["status"] == "unsupported"
        assert ctx["cli_recipe"]["route"] is None
        assert ctx["cli_recipe"]["operation"] is None
        assert ctx["cli_recipe"]["recipe_sha256"] is None
        assert isinstance(ctx["cli_recipe"]["reason"], str) and ctx["cli_recipe"]["reason"]
        dumped = json.dumps(ctx)
        assert "measurements" not in json.dumps(ctx["cli_recipe"])
        if ctx["method_label"] != "Compartment measurements":
            assert "measurements" not in dumped
        if hidden_path is not None:
            assert str(hidden_path) not in dumped
        return ctx

    # 1. Corrected child
    labels = wb.project.load_array(base_result["arrays"]["labels"])
    corrected = wb.execute(
        "correct_result",
        {
            "result_id": base_result["id"],
            "revision_hash": base_result["revision_hash"],
            "operations": [
                {"op": "delete", "label": 1, "expected_input_sha256": label_array_sha256(labels)}
            ],
        },
    )["result"]
    assert_unsupported(wb, corrected, hidden_path=file)

    # 2. Processed-only (no segmentation)
    processed_only = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {"steps": [{"op": "gaussian", "sigma": 0.5}], "segmentation": None},
        },
    )["result"]
    assert_unsupported(wb, processed_only, hidden_path=file)

    # 3. Watershed segmentation
    watershed = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {"segmentation": {"method": "watershed", "threshold": 50}},
        },
    )["result"]
    assert_unsupported(wb, watershed, hidden_path=file)

    # 4. Reference-image dependency (flatfield)
    ref_file = tmp_path / "flatfield-ref.tif"
    tifffile.imwrite(
        ref_file,
        np.ones((24, 24), np.uint16),
        ome=True,
        metadata={"axes": "YX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 1},
    )
    ref_src = wb.import_native(str(ref_file))
    flatfield = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {
                "steps": [{"op": "flatfield"}],
                "segmentation": {"method": "components", "threshold": 50},
                "references": {"flatfield": {"source_id": ref_src["id"], "selection": {}}},
            },
        },
    )["result"]
    assert_unsupported(wb, flatfield, hidden_path=file)

    # 5. Classical adaptive segmentation
    from loci_engine.models import SegmentationSettings
    from loci_engine.profiles import DEFAULT_PROFILE_ID

    classical = wb.execute(
        "classical_run",
        {
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
        },
    )["result"]
    assert_unsupported(wb, classical, hidden_path=file)

    # 6. Imported external labels
    ext_labels = np.zeros((24, 24), np.uint32)
    ext_labels[2:5, 2:5] = 1
    ext_file = tmp_path / "external-cli.tif"
    tifffile.imwrite(ext_file, ext_labels, metadata={"axes": "YX"})
    grant = create_import_grant(
        wb, str(ext_file), source["id"], source["sha256"], {"t": 0, "c": 1, "z": 0, "level": 0}
    )
    imported = wb.execute(
        "labels_import",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "grant_id": grant["grant_id"],
            "alignment": ALIGNMENT,
        },
    )["result"]
    assert_unsupported(wb, imported, hidden_path=file)

    # 7. Compartment measurement
    nuclei = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {"segmentation": {"threshold": 150}, "measurement_channels": [1]},
        },
    )["result"]
    compartments = wb.execute(
        "associate_results",
        {
            "nuclei": {"result_id": nuclei["id"], "revision_hash": nuclei["revision_hash"]},
            "cells": {
                "result_id": base_result["id"],
                "revision_hash": base_result["revision_hash"],
            },
            "roles": {"nuclei": "Authored inner regions", "cells": "Authored whole regions"},
            "control": "Synthetic computational context regression",
            "measurement_channels": [0],
        },
    )["result"]
    assert_unsupported(wb, compartments, hidden_path=file)

    # 8. 3D Z-stack result
    stack = np.zeros((3, 24, 24), np.uint16)
    stack[:, 4:10, 4:10] = 180
    stack_file = tmp_path / "stack3d.ome.tif"
    tifffile.imwrite(
        stack_file,
        stack,
        ome=True,
        metadata={
            "axes": "ZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.0,
            "PhysicalSizeZ": 2.0,
        },
    )
    stack_src = wb.import_native(str(stack_file))
    stack_result = wb.execute(
        "run_recipe",
        {
            "source_id": stack_src["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "z_stop": 3, "level": 0},
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        },
    )["result"]
    assert_unsupported(wb, stack_result, hidden_path=stack_file)

    # 9. Pyramid level 1 result
    pyr_file = tmp_path / "pyramid.ome.tif"
    base_img = np.zeros((32, 32), np.uint16)
    base_img[4:16, 4:16] = 200
    reduced_img = base_img[::2, ::2].copy()
    with tifffile.TiffWriter(pyr_file, bigtiff=True, ome=True) as tif:
        tif.write(
            base_img,
            subifds=1,
            tile=(16, 16),
            metadata={"axes": "YX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 1.0},
        )
        tif.write(reduced_img, subfiletype=1, tile=(16, 16))
    pyr_src = wb.import_native(str(pyr_file))
    pyr_result = wb.execute(
        "run_recipe",
        {
            "source_id": pyr_src["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 1},
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        },
    )["result"]
    assert_unsupported(wb, pyr_result, hidden_path=pyr_file)

    # 10. RGB source + rgb_intensity + declared histology
    rgb = np.full((16, 16, 3), 255, np.uint8)
    rgb[3:9, 3:9] = [80, 110, 150]
    rgb_file = tmp_path / "rgb.tif"
    tifffile.imwrite(rgb_file, rgb, photometric="rgb", metadata={"axes": "YXS"})
    rgb_src = wb.import_native(str(rgb_file))
    rgb_intensity = wb.execute(
        "run_recipe",
        {
            "source_id": rgb_src["id"],
            "selection": {"level": 0},
            "recipe": {
                "input_transform": "rgb_intensity",
                "segmentation": {"method": "components", "threshold": 0.9, "polarity": "dark"},
                "measurement_channels": [],
            },
        },
    )["result"]
    assert_unsupported(wb, rgb_intensity, hidden_path=rgb_file)
    histology = wb.execute(
        "histology_run",
        {
            "source_id": rgb_src["id"],
            "selection": {"level": 0},
            "basis": "H-DAB",
            "component": 1,
            "segmentation": {"method": "components", "threshold": 0.0},
        },
    )["result"]
    assert_unsupported(wb, histology, hidden_path=rgb_file)

    # 11. Workflow v1 result
    wf_def = workflow_definition()
    wf_def["nodes"][4]["settings"]["filters"][0]["unit"] = "um^2"
    wf_doc = wb.execute(
        "workflow_save",
        {
            "workflow_id": "a" * 32,
            "expected_revision": 0,
            "definition": wf_def,
        },
    )["workflow"]
    wf_job = submit_job(
        wb,
        {
            "workflow_id": wf_doc["id"],
            "workflow_revision": wf_doc["revision"],
            "definition_sha256": wf_doc["data"]["definition_sha256"],
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
        },
        "workflow-v1-key",
        "workflow_run",
    )
    wf_result = run_job(wb, wf_job["id"])["result"]
    assert_unsupported(wb, wf_result, hidden_path=file)

    # 12. Workflow v2 graph-v2 child job marker
    graph_job = submit_job(
        wb,
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        },
        "graph-child-tmp-key",
        "run_recipe",
    )
    graph_result = run_job(wb, graph_job["id"])["result"]
    with wb.project.connection() as connection:
        row = connection.execute(
            "SELECT record FROM jobs WHERE id=?", (graph_job["id"],)
        ).fetchone()
        job_record = json.loads(row[0])
        job_record["request_key"] = f"graph-v2:{'b' * 32}:seg"
        connection.execute(
            "UPDATE jobs SET request_key=?, record=? WHERE id=?",
            (job_record["request_key"], canonical_json(job_record), graph_job["id"]),
        )
    assert_unsupported(wb, graph_result, hidden_path=file)

    # 13. Exploration-adopted result
    exp_wb = Workbench(ResearchProject.create(tmp_path / "exp.loci-study", "Exploration"))
    try:
        exp_dir = tmp_path / "exp-img"
        exp_dir.mkdir()
        _, _, exp_req = import_exploration_image(exp_wb, exp_dir)
        exp_preview = dispatch_exploration(exp_wb, "exploration_preview", exp_req)
        exp_result = dispatch_exploration(
            exp_wb, "exploration_run", {"receipt": exp_preview["receipt"]}
        )["result"]
        assert_unsupported(exp_wb, exp_result)
    finally:
        exp_wb.close()

    # 14. OME-Zarr non-native source
    zarr_root, _ = _store(tmp_path / "zarr-raw")
    zarr_wb = Workbench(ResearchProject.create(tmp_path / "zarr.loci-study", "Zarr study"))
    try:
        zarr_src = zarr_wb.import_native(str(zarr_root))
        zarr_res = zarr_wb.execute(
            "run_recipe",
            {
                "source_id": zarr_src["id"],
                "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
                "recipe": {"segmentation": {"method": "components", "threshold": 1}},
            },
        )["result"]
        assert_unsupported(zarr_wb, zarr_res, hidden_path=zarr_root)
    finally:
        zarr_wb.close()

    # 15. Vendor-derived source
    derived_img = tmp_path / "derived.ome.tif"
    derived_data = np.zeros((8, 8), dtype=np.uint16)
    derived_data[2:5, 2:5] = 100
    tifffile.imwrite(derived_img, derived_data, ome=True)
    derived_wb = Workbench(ResearchProject.create(tmp_path / "derived.loci-study", "Derived"))
    try:
        with NativeImageSession(derived_img) as session:
            derived_meta = asdict(session.metadata)
        derived_src = derived_wb.project.register_source(
            derived_img,
            derived_meta["sha256"],
            derived_meta,
            derivation=_derivation(derived_meta["sha256"]),
        )
        derived_res = derived_wb.execute(
            "run_recipe",
            {
                "source_id": derived_src["id"],
                "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
                "recipe": {"segmentation": {"method": "components", "threshold": 50}},
            },
        )["result"]
        assert_unsupported(derived_wb, derived_res, hidden_path=derived_img)
    finally:
        derived_wb.close()

    # 16. Remote-attached result
    remote_res = rewrite(
        wb,
        base_result,
        lambda r: r["provenance"].update(
            remote_attachment={"schema": "loci.remote-result-provenance/v1"}
        ),
    )
    assert_unsupported(wb, remote_res, hidden_path=file)


def test_cli_recipe_rejects_incompatible_runtime_and_incomplete_evidence(scene):
    wb, _, file = scene
    base_result = recipe_result(scene)

    for mutation in (
        lambda r: r["provenance"]["runtime"].update(resolved_device="mps"),
        lambda r: r["provenance"]["runtime"].update(backend="onnxruntime"),
        lambda r: r["provenance"]["runtime"].update(fallback_reason="fallback"),
        lambda r: r["provenance"]["runtime"].update(engine="0.1.0"),
        lambda r: r["provenance"].update(runtime={"engine": r["provenance"]["runtime"]["engine"]}),
        lambda r: r["provenance"].pop("geometry"),
        lambda r: r["provenance"]["geometry"]["affine"][0].__setitem__(0, 2.0),
        lambda r: r["arrays"]["labels"].update(shape=[12, 12]),
        lambda r: r["provenance"].update(processing=[]),
        lambda r: r["provenance"]["selection"].update(elapsed_time_s=1.5),
        lambda r: r["provenance"]["segmentation"].update(split_height=1.0),
    ):
        fresh = recipe_result(scene)
        altered = rewrite(wb, fresh, mutation)
        ctx = describe(wb, altered)
        assert ctx["cli_recipe"]["status"] == "unsupported"
        assert str(file) not in json.dumps(ctx)
        assert "measurements" not in json.dumps(ctx)
    assert describe(wb, base_result)["cli_recipe"]["status"] == "available"


def test_cli_recipe_roundtrip_reproduces_saved_2d_analysis_via_real_cli(tmp_path, capsys):
    from loci_engine import cli

    image = np.zeros((2, 24, 24), np.uint16)
    image[0, 4:9, 5:10] = 120
    image[0, 14:20, 13:19] = 240
    image[1, 4:9, 5:10] = 55
    image[1, 14:20, 13:19] = 180
    source_path = tmp_path / "synthetic-scalar.ome.tif"
    tifffile.imwrite(
        source_path,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.0,
            "Channel": {"Name": ["Signal A", "Signal B"]},
        },
    )
    original_source_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
    study_path = tmp_path / "study.loci-study"

    wb = Workbench(ResearchProject.create(study_path, "CLI roundtrip study"))
    try:
        source = wb.import_native(str(source_path))
        orig_out = wb.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "selection": {
                    "x": 2,
                    "y": 2,
                    "width": 20,
                    "height": 20,
                    "t": 0,
                    "c": 0,
                    "z": 0,
                    "level": 0,
                },
                "recipe": {
                    "steps": [{"op": "subtract_constant", "value": 10, "clip_negative": True}],
                    "segmentation": {
                        "method": "components",
                        "threshold": 80,
                        "polarity": "bright",
                        "min_size": 4,
                        "exclude_border": False,
                    },
                    "measurement_channels": [0, 1],
                },
            },
        )
        orig_result = orig_out["result"]
        wb.project.review(orig_result["id"], orig_result["revision_hash"], "reviewed")
        orig_record = wb.project.result(orig_result["id"])
        orig_record_json = canonical_json(orig_record)
        orig_labels = wb.project.load_array(orig_record["arrays"]["labels"]).copy()
        orig_measurements = orig_record["provenance"]["measurements"]
        context = describe(wb, orig_result)
        assert context["cli_recipe"] == {
            "status": "available",
            "route": "native-2d-level0-cpu-components-run-recipe",
            "operation": "run_recipe",
            "recipe_sha256": orig_record["provenance"]["recipe_sha256"],
            "reason": None,
        }
        recipe_file = tmp_path / "recipe.json"
        recipe_file.write_text(json.dumps(context["replay"]["request"], indent=2), encoding="utf-8")
    finally:
        wb.close()

    capsys.readouterr()
    assert (
        cli.main(
            [
                "execute",
                "--project",
                str(study_path),
                "recipe_preflight",
                "--request",
                f"@{recipe_file}",
                "--json",
            ]
        )
        == 0
    )
    preflight = json.loads(capsys.readouterr().out)
    assert preflight["source_id"] == source["id"]
    assert preflight["source_sha256"] == source["sha256"]
    assert preflight["selection"] == orig_record["provenance"]["selection"]
    assert preflight["recipe"] == orig_record["provenance"]["recipe"]
    assert preflight["recipe_sha256"] == orig_record["provenance"]["recipe_sha256"]
    assert preflight["within_budget"] is True
    assert preflight["resolved_device"] == "cpu"

    assert (
        cli.main(
            [
                "submit",
                "--project",
                str(study_path),
                "--operation",
                "run_recipe",
                "--request",
                f"@{recipe_file}",
                "--request-key",
                "replay-key-001",
                "--run",
                "--json",
            ]
        )
        == 0
    )
    submitted = json.loads(capsys.readouterr().out)
    new_result = submitted["result"]
    assert new_result["id"] != orig_result["id"]
    assert submitted["job"]["state"] == "succeeded"

    assert (
        cli.main(
            [
                "submit",
                "--project",
                str(study_path),
                "--operation",
                "run_recipe",
                "--request",
                f"@{recipe_file}",
                "--request-key",
                "replay-key-001",
                "--run",
                "--json",
            ]
        )
        == 0
    )
    retried = json.loads(capsys.readouterr().out)
    assert retried["job"]["id"] == submitted["job"]["id"]
    assert retried["job"]["result_ids"] == [new_result["id"]]

    reopened = ResearchProject(study_path)
    assert len(reopened.list_results()) == 2
    assert reopened.review_state(new_result["id"]) is None
    new_record = reopened.result(new_result["id"])
    new_labels = reopened.load_array(new_record["arrays"]["labels"])
    assert new_labels.shape == orig_labels.shape
    assert new_labels.dtype == orig_labels.dtype
    np.testing.assert_array_equal(new_labels, orig_labels)
    assert new_record["provenance"]["measurements"] == orig_measurements
    assert canonical_json(reopened.result(orig_result["id"])) == orig_record_json
    assert reopened.review_state(orig_result["id"])["disposition"] == "reviewed"
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == original_source_sha256


def test_cli_recipe_tracks_channel_declarations_across_all_measured_channels_including_ungated(
    tmp_path, capsys
):
    from loci_engine import cli

    image = np.zeros((3, 24, 24), np.uint16)
    image[0, 4:10, 4:10] = 180
    image[0, 14:20, 14:20] = 240
    image[1, 4:10, 4:10] = 90
    image[1, 14:20, 14:20] = 160
    image[2] = 25
    file = tmp_path / "three-channel.ome.tif"
    tifffile.imwrite(
        file,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.5,
            "Channel": {"Name": ["DAPI", "Marker A", "Unused C"]},
        },
    )
    study_path = tmp_path / "ungated-channels.loci-study"
    wb = Workbench(ResearchProject.create(study_path, "Ungated channel declarations"))
    try:
        source = wb.import_native(str(file))
        result = wb.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 100},
                    "measurement_channels": [1],
                },
            },
        )["result"]
        orig_record = wb.project.result(result["id"])
        orig_labels = wb.project.load_array(orig_record["arrays"]["labels"]).copy()
        orig_measurements = orig_record["provenance"]["measurements"]
        assert describe(wb, result)["cli_recipe"]["status"] == "available"

        def save_ch(rev, ch0, ch1, ch2):
            wb.execute(
                "channels",
                {
                    "source_id": source["id"],
                    "expected_revision": rev,
                    "channels": [
                        {"index": 0, **ch0},
                        {"index": 1, **ch1},
                        {"index": 2, **ch2},
                    ],
                },
            )

        base0 = {"name": "DAPI", "marker": "", "fluorophore": "", "declaration": ""}
        base1 = {"name": "Marker A", "marker": "", "fluorophore": "", "declaration": ""}
        base2 = {"name": "Unused C", "marker": "", "fluorophore": "", "declaration": ""}

        # Unrelated channel edit does not alter used channels or measurements.
        save_ch(0, base0, base1, {**base2, "name": "Renamed Unused", "marker": "Other"})
        ctx_unused = describe(wb, result)
        assert ctx_unused["cli_recipe"]["status"] == "available"
        recipe_file = tmp_path / "ungated-recipe.json"
        recipe_file.write_text(
            json.dumps(ctx_unused["replay"]["request"], indent=2), encoding="utf-8"
        )

        # Ungated measured channel declaration change (even keeping name identical) is rejected.
        save_ch(1, base0, {**base1, "marker": "Ki67"}, base2)
        ctx_decl = describe(wb, result)
        assert ctx_decl["cli_recipe"]["status"] == "unsupported"
        assert ctx_decl["replay"]["status"] == "available"

        # Ungated measured channel rename is rejected.
        save_ch(2, base0, {**base1, "name": "Marker Renamed"}, base2)
        ctx_rename = describe(wb, result)
        assert ctx_rename["cli_recipe"]["status"] == "unsupported"
        assert ctx_rename["replay"]["status"] == "available"

        # Segmentation channel declaration change is rejected even when not in measurement_channels.
        save_ch(3, {**base0, "fluorophore": "Hoechst"}, base1, base2)
        ctx_seg = describe(wb, result)
        assert ctx_seg["cli_recipe"]["status"] == "unsupported"
        assert ctx_seg["replay"]["status"] == "available"

        # Restoring used channels restores eligibility.
        save_ch(4, base0, base1, {**base2, "name": "Renamed Unused", "marker": "Other"})
        assert describe(wb, result)["cli_recipe"]["status"] == "available"

        # Older unverifiable records missing channel_metadata or with mismatched
        # intensity keys must be rejected.
        no_cm = rewrite(wb, result, lambda r: r["provenance"].pop("channel_metadata"))
        ctx_no_cm = describe(wb, no_cm)
        assert ctx_no_cm["cli_recipe"]["status"] == "unsupported"
        assert ctx_no_cm["replay"]["status"] == "available"

        fresh = wb.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 100},
                    "measurement_channels": [1],
                },
            },
        )["result"]
        bad_row = rewrite(
            wb,
            fresh,
            lambda r: r["provenance"]["measurements"][0].update(
                intensity={
                    "2: Stale Name": r["provenance"]["measurements"][0]["intensity"]["2: Marker A"]
                }
            ),
        )
        ctx_bad_row = describe(wb, bad_row)
        assert ctx_bad_row["cli_recipe"]["status"] == "unsupported"
        assert ctx_bad_row["replay"]["status"] == "available"
    finally:
        wb.close()

    # Verify CLI execution with unrelated channel edited still matches labels and measurements.
    capsys.readouterr()
    assert (
        cli.main(
            [
                "submit",
                "--project",
                str(study_path),
                "--operation",
                "run_recipe",
                "--request",
                f"@{recipe_file}",
                "--request-key",
                "ungated-unused-channel-1",
                "--run",
                "--json",
            ]
        )
        == 0
    )
    out = json.loads(capsys.readouterr().out)
    reopened = ResearchProject(study_path)
    replay_rec = reopened.result(out["result"]["id"])
    np.testing.assert_array_equal(reopened.load_array(replay_rec["arrays"]["labels"]), orig_labels)
    assert replay_rec["provenance"]["measurements"] == orig_measurements


def test_cli_recipe_verifies_exact_numerical_runtime_and_processing_parameter_evidence(
    scene, tmp_path, capsys
):
    from loci_engine import cli

    wb, source, file = scene
    steps = [
        {"op": "gaussian", "sigma": 0.5},
        {"op": "subtract_background", "sigma": 2.0, "clip_negative": True},
        {"op": "median", "radius": 0.5},
        {"op": "opening", "radius": 0.5},
        {"op": "closing", "radius": 0.5},
        {"op": "subtract_constant", "value": 1.0, "clip_negative": False},
    ]

    def run_multi():
        return wb.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
                "recipe": {
                    "steps": steps,
                    "segmentation": {"method": "components", "threshold": 20},
                    "measurement_channels": [0, 1],
                },
            },
        )["result"]

    base = run_multi()
    ctx = describe(wb, base)
    assert ctx["cli_recipe"]["status"] == "available"

    # Exact numerical runtime: numpy, scipy, scikit_image mismatches must be rejected.
    for lib in ("numpy", "scipy", "scikit_image"):
        altered = rewrite(
            wb, run_multi(), lambda r, k=lib: r["provenance"]["runtime"].update({k: "0.0.1"})
        )
        res_ctx = describe(wb, altered)
        assert res_ctx["cli_recipe"]["status"] == "unsupported"
        assert res_ctx["replay"]["status"] == "available"
        assert str(file) not in json.dumps(res_ctx)

    # Processing parameter evidence mutations across every supported op must be rejected.
    proc_mutations = (
        lambda r: r["provenance"]["processing"][0].update(sigma=1.0),
        lambda r: r["provenance"]["processing"][0].update(sigma_voxels=[9.0, 9.0]),
        lambda r: r["provenance"]["processing"][0].update(unit="mm"),
        lambda r: r["provenance"]["processing"][0].update(boundary="nearest"),
        lambda r: r["provenance"]["processing"][0].update(input_basis="raw"),
        lambda r: r["provenance"]["processing"][0].pop("sigma"),
        lambda r: r["provenance"]["processing"][0].update(extra_param=1),
        lambda r: r["provenance"]["processing"][1].update(clip_negative=False),
        lambda r: r["provenance"]["processing"][1].update(clip_negative=1),
        lambda r: r["provenance"]["processing"][2].update(radius=1.0),
        lambda r: r["provenance"]["processing"][3].pop("radius"),
        lambda r: r["provenance"]["processing"][4].update(boundary="constant"),
        lambda r: r["provenance"]["processing"][5].update(value=2.0),
        lambda r: r["provenance"]["processing"][5].pop("clip_negative"),
    )
    for mutation in proc_mutations:
        altered = rewrite(wb, run_multi(), mutation)
        res_ctx = describe(wb, altered)
        assert res_ctx["cli_recipe"]["status"] == "unsupported"
        assert res_ctx["replay"]["status"] == "available"
        assert str(file) not in json.dumps(res_ctx)

    # Confirm the genuine multi-step recipe round-trips cleanly through the CLI.
    recipe_file = tmp_path / "multistep.json"
    recipe_file.write_text(json.dumps(ctx["replay"]["request"], indent=2), encoding="utf-8")
    orig_rec = wb.project.result(base["id"])
    orig_labels = wb.project.load_array(orig_rec["arrays"]["labels"]).copy()
    capsys.readouterr()
    assert (
        cli.main(
            [
                "submit",
                "--project",
                str(wb.project.root),
                "--operation",
                "run_recipe",
                "--request",
                f"@{recipe_file}",
                "--request-key",
                "multistep-1",
                "--run",
                "--json",
            ]
        )
        == 0
    )
    submitted = json.loads(capsys.readouterr().out)
    new_rec = wb.project.result(submitted["result"]["id"])
    np.testing.assert_array_equal(wb.project.load_array(new_rec["arrays"]["labels"]), orig_labels)
    assert new_rec["provenance"]["measurements"] == orig_rec["provenance"]["measurements"]


def test_cli_recipe_rejects_geometry_segmentation_budget_job_and_source_drift(scene):
    from loci_engine.research_jobs import run_job, submit_job

    wb, source, file = scene

    mutations = (
        lambda r: r["provenance"]["geometry"].pop("frame"),
        lambda r: r["provenance"]["geometry"]["affine"][3].__setitem__(3, True),
        lambda r: r["provenance"]["segmentation"].pop("size_unit"),
        lambda r: r["provenance"]["segmentation"].update(size_unit="pixel^2"),
        lambda r: r["provenance"]["segmentation"].update(distance_unit="mm"),
        lambda r: r["provenance"]["segmentation"].update(scientific_validation="validated"),
        lambda r: r["provenance"]["segmentation"].update(exclude_border=0),
        lambda r: r["provenance"]["segmentation"].update(count=99),
        lambda r: r["provenance"].pop("estimated_working_bytes"),
        lambda r: r["provenance"].update(estimated_working_bytes=1),
        lambda r: r["provenance"].update(future_context={"opaque": True}),
        lambda r: r["arrays"]["image"].update(dtype="uint16"),
    )
    for mutation in mutations:
        altered = rewrite(wb, recipe_result(scene), mutation)
        ctx = describe(wb, altered)
        assert ctx["cli_recipe"]["status"] == "unsupported"
        assert str(file) not in json.dumps(ctx)

    # Durable job that did not succeed must not be accepted.
    job = submit_job(
        wb,
        {
            "source_id": source["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        },
        "failed-state-job-key",
        "run_recipe",
    )
    job_res = run_job(wb, job["id"])["result"]
    assert describe(wb, job_res)["cli_recipe"]["status"] == "available"
    with wb.project.connection() as connection:
        row = connection.execute("SELECT record FROM jobs WHERE id=?", (job["id"],)).fetchone()
        rec = json.loads(row[0])
        rec["state"] = "failed"
        connection.execute(
            "UPDATE jobs SET record=? WHERE id=?",
            (canonical_json(rec), job["id"]),
        )
    assert describe(wb, job_res)["cli_recipe"]["status"] == "unsupported"

    # Source metadata top-level dimensions disagreeing with level 0 must be rejected.
    clean_res = recipe_result(scene)
    with wb.project.connection() as connection:
        row = connection.execute(
            "SELECT record FROM sources WHERE id=?", (source["id"],)
        ).fetchone()
        src_rec = json.loads(row[0])
        original_src_json = row[0]
        src_rec["metadata"]["dimensions"]["x"] = 999
        connection.execute(
            "UPDATE sources SET record=? WHERE id=?", (canonical_json(src_rec), source["id"])
        )
    try:
        assert describe(wb, clean_res)["cli_recipe"]["status"] == "unsupported"
    finally:
        with wb.project.connection() as connection:
            connection.execute(
                "UPDATE sources SET record=? WHERE id=?", (original_src_json, source["id"])
            )
