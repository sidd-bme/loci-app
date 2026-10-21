"""Hand-calculable hierarchy and adversarial immutable raw-intensity snapshots."""

from __future__ import annotations

import copy
import hashlib
import json
import math

import numpy as np
import pytest
import tifffile

import loci_engine.experiment_intensity as intensity
from loci_engine.quantitative import measure_objects
from loci_engine.research_channels import save_channels
from loci_engine.research_population import intensity_metric_id
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench

CHANNEL = "1: raw.mean:核/β"


def sample(project, result, condition="A", replicate="R1", **changes):
    old = next((d for d in project.documents("sample") if d["id"] == result["source_id"]), None)
    data = {
        "study": "Study",
        "sample": result["source_id"],
        "condition": condition,
        "biological_replicate": replicate,
        "plate": None,
        "well": None,
        **changes,
    }
    return project.put_document(
        "sample", result["source_id"], data, expected_revision=old["revision"] if old else 0
    )


@pytest.fixture
def study(tmp_path):
    project = ResearchProject.create(tmp_path / "study", "Synthetic intensity")
    workbench = Workbench(project)
    created = []

    def add(values, condition="A", replicate="R1", disposition="reviewed", mutator=None):
        image = np.zeros((20, 20), dtype=np.float64)
        labels = np.zeros((20, 20), dtype=np.uint32)
        for index, value in enumerate(values):
            image.flat[index] = 0 if value is None else value
            labels.flat[index] = index + 1
        path = tmp_path / f"image-{len(created)}.ome.tif"
        tifffile.imwrite(
            path, image, ome=True, metadata={"axes": "YX", "Channel": {"Name": ["raw.mean:核/β"]}}
        )
        source = workbench.import_native(str(path))
        _, geometry, selection = workbench.load_scalar(source["id"], {})
        rows = measure_objects(labels, geometry, {CHANNEL: image})
        for row, value in zip(rows, values, strict=True):
            if value is None:
                row["intensity"][CHANNEL]["mean"] = None
        provenance = {
            "geometry": geometry.to_dict(),
            "selection": selection,
            "recipe": {
                "steps": [],
                "segmentation": {"method": "components", "threshold": 0},
                "measurement_channels": [0],
                "gates": [],
            },
            "processing": [],
            "segmentation": {
                "method": "components",
                "dimensions": 2,
                "threshold": 0,
                "count": len(rows),
            },
            "channel_metadata": workbench.channel_metadata(source["id"]),
            "measurement_basis": "raw-selected-channel-values-on-result-grid",
            "measurements": rows,
        }
        if mutator:
            mutator(provenance)
        result = project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": image, "labels": labels},
            provenance=provenance,
        )
        project.review(result["id"], result["revision_hash"], disposition)
        sample(project, result, condition, replicate)
        created.append((result, path))
        return result

    yield project, add, created
    workbench.close()


def actual_compartment_scene(
    tmp_path, *, workbench=None, name="compartments", nuclear_threshold=50, declaration=None
):
    """Actual stored producers: raw C0, cell segmentation C1, nuclear C2.

    Returns (workbench, full_compartment_result, {cells: full_parent,
    nuclei: full_parent}, raw_channels). The second -5 cell has no nuclear
    intersection; the third cell is a measured zero. No bare label arrays stand
    in for a producing analysis. Pass workbench/name to add a paired source.
    """
    tmp_path.mkdir(parents=True, exist_ok=True)
    wb = workbench or Workbench(ResearchProject.create(tmp_path / "study", "Study"))
    raw = np.zeros((3, 12, 12), np.float64)
    for y, x, value in ((1, 1, -5), (1, 6, -5), (6, 1, 0)):
        raw[0, y : y + 2, x : x + 2] = value
        raw[1, y : y + 2, x : x + 2] = 150
    raw[2, 1, 1] = raw[2, 6, 1] = 150
    path = tmp_path / (name + ".ome.tif")
    tifffile.imwrite(
        path,
        raw,
        ome=True,
        metadata={
            "axes": "CYX",
            "Channel": {"Name": ["raw.mean:核/β", "Cell mask", "Nuclear mask"]},
        },
    )
    source = wb.import_native(str(path))
    parents = {}
    for role, index, threshold in (("cells", 1, 50), ("nuclei", 2, nuclear_threshold)):
        produced = wb.run_recipe(
            {
                "source_id": source["id"],
                "selection": {"c": index},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": threshold},
                    "measurement_channels": [0],
                },
            }
        )["result"]
        parents[role] = wb.project.result(produced["id"])
    if declaration:
        channels = copy.deepcopy(wb.channel_metadata(source["id"])["channels"])
        channels[0].update(declaration)
        save_channels(
            wb.project,
            {"source_id": source["id"], "channels": channels, "expected_revision": 0},
        )
    child = wb.execute(
        "associate_results",
        {
            "cells": {
                "result_id": parents["cells"]["id"],
                "revision_hash": parents["cells"]["revision_hash"],
            },
            "nuclei": {
                "result_id": parents["nuclei"]["id"],
                "revision_hash": parents["nuclei"]["revision_hash"],
            },
            "roles": {"cells": "Authored cells", "nuclei": "Authored nuclei"},
            "control": "Authored constant raw signal and explicit segmentation inputs",
            "measurement_channels": [0],
            "working_bytes": 16 * 1024**2,
        },
    )["result"]
    result = wb.project.result(child["id"])
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    sample(wb.project, result)
    return wb, result, parents, raw


def request(results, compartment="object", channel=CHANNEL):
    metric = intensity_metric_id(channel, "mean")
    if compartment != "object":
        metric = f"compartment:{compartment}:{metric}"
    return {
        "result_ids": [r["id"] for r in results],
        "endpoint": {
            "schema": intensity.ENDPOINT_SCHEMA,
            "kind": "raw-channel-intensity",
            "statistic": "mean",
            "unit": "source-intensity",
            "compartment": compartment,
        },
        "metric_ids": {r["id"]: metric for r in results},
        "declaration": {
            "channel": "Declared raw channel",
            "acquisition_context": "Synthetic run 1",
            "rationale": "Same synthetic acquisition settings; no biological inference",
        },
    }


def reseal(report):
    report["report_hash"] = intensity.report_hash(report)
    return report


def references(project, report):
    result_ids = set(report["result_ids"])
    for binding in report["bindings"]:
        for parent in (binding["label_inputs"] or {}).values():
            result_ids.add(parent["result_id"])
    results = {identity: project.result(identity) for identity in result_ids}
    sources = {
        result["source_id"]: project.source(result["source_id"]) for result in results.values()
    }
    return results, sources


def test_independent_102_objects_three_images_two_replicates_oracle_and_b(study):
    project, add, _ = study
    results = [
        add([10] * 100),
        add([30]),
        add([40], replicate="R2"),
        add([-2, 0], condition="B", replicate="R1"),
    ]
    original = [copy.deepcopy(project.result(r["id"])) for r in results]
    report = intensity.preview(project, request(results))
    a, b = report["conditions"]
    assert [row["mean"] for row in report["images"]] == [10, 30, 40, -1]
    assert [
        (r["condition"], r["biological_replicate"], r["mean"]) for r in report["replicates"]
    ] == [("A", "R1", 20), ("A", "R2", 40), ("B", "R1", -1)]
    # These constants are independent of production aggregation helpers.
    assert a["mean"] == 30
    assert a["sd"] == math.sqrt(200)
    assert (
        a["object_count"],
        a["image_count"],
        a["declared_replicate_count"],
        a["valid_replicate_count"],
    ) == (102, 3, 2, 2)
    assert b["mean"] == -1 and b["sd"] is None
    assert a["mean"] != (100 * 10 + 30 + 40) / 102
    encoded = canonical_json(report)
    reopened = intensity.validate_report(json.loads(encoded))
    assert canonical_json(reopened) == encoded
    intensity.validate_references(reopened, *references(project, reopened))
    assert intensity.current_status(project, report) == {"current": True, "changes": []}
    assert [project.result(r["id"]) for r in results] == original
    assert str(project.root) not in encoded
    assert report["bindings"][0]["scope"]["acquisition"]["unavailable"] == [
        "exposure_time",
        "gain",
        "laser_power",
        "detector",
        "bit_depth",
    ]


def test_zero_negative_null_missing_unassigned_and_excluded_are_distinct(study):
    project, add, _ = study

    def missing(p):
        del p["measurements"][3]["intensity"][CHANNEL]["mean"]

    results = [
        add([None, 0, -6, 7], mutator=missing),
        add([999], disposition="excluded"),
        add([100], replicate=None),
    ]
    report = intensity.preview(project, request(results))
    assert [o["status"] for o in report["observations"][:4]] == [
        "null",
        "value",
        "value",
        "missing",
    ]
    image = report["images"][0]
    assert image["mean"] == -3
    assert (
        image["object_count"],
        image["valid_object_count"],
        image["null_object_count"],
        image["missing_object_count"],
    ) == (4, 2, 1, 1)
    assert report["images"][1]["mean"] is None
    assert report["audit"][1]["reason"] == "excluded-by-review"
    assert report["images"][2]["mean"] == 100
    assert report["audit"][2]["reason"] == "missing-biological-replicate"
    condition = report["conditions"][0]
    assert condition["mean"] == -3 and condition["sd"] is None
    assert condition["image_count"] == 2 and condition["unassigned_image_count"] == 1
    assert condition["declared_replicate_count"] == condition["valid_replicate_count"] == 1


def test_null_only_declared_replicate_stays_declared_without_contribution(study):
    project, add, _ = study
    report = intensity.preview(project, request([add([None]), add([0], replicate="R2")]))
    row = report["conditions"][0]
    assert row["declared_replicate_count"] == 2 and row["valid_replicate_count"] == 1
    assert row["mean"] == 0 and row["sd"] is None
    assert report["replicates"][0]["mean"] is None


def test_catalog_blocks_pending_only_at_preview_and_requires_metadata(study):
    project, add, _ = study
    result = add([3], disposition="pending")
    listing = intensity.catalog(project, [result["id"]])
    assert listing["results"][0]["review_status"] == "pending"
    assert [d["id"] for d in listing["results"][0]["descriptors"]] == [
        intensity_metric_id(CHANNEL, "mean")
    ]
    with pytest.raises(ValueError, match="pending"):
        intensity.preview(project, request([result]))
    project.review(result["id"], result["revision_hash"], "reviewed")
    with project.connection() as db:
        db.execute("DELETE FROM documents WHERE kind='sample'")
    with pytest.raises(ValueError, match="metadata"):
        intensity.preview(project, request([result]))


def test_input_and_exact_endpoint_limits(study):
    project, add, _ = study
    result = add([1])
    with pytest.raises(ValueError, match="Duplicate"):
        intensity.catalog(project, [result["id"], result["id"]])
    with pytest.raises(ValueError, match="100"):
        intensity.catalog(project, [result["id"]] * 101)
    duplicate = project.save_result(
        source_id=result["source_id"],
        kind="segmentation",
        arrays={"labels": np.ones((20, 20), np.uint32)},
        provenance=result["provenance"],
    )
    with pytest.raises(ValueError, match="one exact result revision per source"):
        intensity.catalog(project, [result["id"], duplicate["id"]])
    req = request([result])
    req["endpoint"]["statistic"] = "sum"
    with pytest.raises(ValueError, match="typed"):
        intensity.preview(project, req)
    req = request([result])
    req["metric_ids"][result["id"]] = CHANNEL + ".mean"
    with pytest.raises(ValueError, match="actual typed"):
        intensity.preview(project, req)
    req = request([result])
    req["declaration"]["rationale"] = ""
    with pytest.raises(ValueError):
        intensity.preview(project, req)
    empty = add([])
    with pytest.raises(ValueError, match="actual typed"):
        intensity.preview(project, request([empty]))


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p["recipe"]["segmentation"].update(threshold=2),
        lambda p: p["selection"].update(t=1),
        lambda p: p["geometry"].update(axes="ZYX"),
        lambda p: p.update(measurement_basis="derived RGB intensity"),
        lambda p: p.update(gain=4),
    ],
)
def test_incompatible_method_scope_dimensions_and_acquisition_are_not_overridden(study, change):
    project, add, _ = study
    first, other = add([1]), add([2], mutator=change)
    with pytest.raises(ValueError):
        intensity.preview(project, request([first, other]))


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf"), 10**400])
def test_nonfinite_and_out_of_float_range_rejected(study, value, monkeypatch):
    project, add, _ = study
    result = add([1])
    bad = copy.deepcopy(result)
    bad["provenance"]["measurements"][0]["intensity"][CHANNEL]["mean"] = value
    monkeypatch.setattr(project, "result", lambda identity, **kw: copy.deepcopy(bad))
    with pytest.raises(ValueError):
        intensity.preview(project, request([result]))


def test_stable_finite_arithmetic_and_true_sd_overflow_rejected(study):
    project, add, _ = study

    def means(value):
        def change(provenance):
            for row in provenance["measurements"]:
                row["intensity"][CHANNEL]["mean"] = value

        return change

    report = intensity.preview(project, request([add([1, 1], mutator=means(1e308))]))
    assert report["conditions"][0]["mean"] == 1e308
    with pytest.raises(ValueError, match="overflow"):
        intensity.preview(
            project,
            request(
                [
                    add([1], mutator=means(-1.7e308)),
                    add([1], replicate="R2", mutator=means(1.7e308)),
                ]
            ),
        )


def test_saved_values_do_not_follow_current_metadata_review_or_channels(study):
    project, add, _ = study
    result = add([2.123456789012345])
    report = intensity.preview(project, request([result]))
    frozen = canonical_json(report)
    sample(project, result, condition="Changed")
    project.review(result["id"], result["revision_hash"], "excluded")
    status = intensity.current_status(project, report)
    assert status["current"] is False
    assert "sample_document" in status["changes"][0]["reason"]
    assert "review" in status["changes"][0]["reason"]
    assert canonical_json(intensity.validate_report(report)) == frozen
    intensity.validate_references(report, *references(project, report))
    assert report["conditions"][0]["mean"] == 2.123456789012345
    assert intensity.preview(project, request([result]))["conditions"][0]["mean"] is None


def test_source_and_artifact_bytes_are_verified_without_mutation(study):
    project, add, created = study
    result = add([2])
    report = intensity.preview(project, request([result]))
    created[0][1].write_bytes(b"changed source")
    with pytest.raises(ValueError):
        intensity.preview(project, request([result]))
    assert intensity.current_status(project, report)["current"] is False
    # A saved snapshot remains internally valid while current bytes are unavailable.
    assert intensity.validate_report(report) == report


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["conditions"][0].update(mean=100),
        lambda r: r["images"][0].update(valid_object_count=99),
        lambda r: r["bindings"][0]["review"].update(revision_hash="0" * 64),
        lambda r: r["bindings"][0]["review"].update(unknown="bad"),
        lambda r: r["bindings"][0]["sample_document"].update(revision=0),
        lambda r: r["bindings"][0]["descriptor"].update(unit="um^2"),
        lambda r: r["observations"].append(copy.deepcopy(r["observations"][0])),
        lambda r: r["observations"][0].update(status="null"),
        lambda r: r.update(created_at="yesterday"),
        lambda r: r.update(aggregation={}),
        lambda r: r.update(schema="loci.experiment-intensity-report/v2"),
        lambda r: r.update(unknown=True),
    ],
)
def test_saved_report_corruption_rejected_even_with_recomputed_hash(study, mutate):
    project, add, _ = study
    report = intensity.preview(project, request([add([1])]))
    mutate(report)
    with pytest.raises(ValueError):
        intensity.validate_report(reseal(report))


def test_content_hash_binds_every_field_and_reference_check_catches_coherent_forgery(study):
    project, add, _ = study
    report = intensity.preview(project, request([add([1])]))
    report["declaration"]["rationale"] += " changed"
    with pytest.raises(ValueError, match="hash"):
        intensity.validate_report(report)
    report = reseal(report)
    report["observations"][0]["value"] = 500
    report["images"][0]["mean"] = report["replicates"][0]["mean"] = report["conditions"][0][
        "mean"
    ] = 500.0
    reseal(report)
    intensity.validate_report(report)  # Internally coherent, but not bound to actual evidence.
    with pytest.raises(ValueError, match="observations"):
        intensity.validate_references(report, *references(project, report))


def test_cancellation_propagates_and_report_size_is_bounded(study, monkeypatch):
    project, add, _ = study
    result = add([1])

    def cancel():
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        intensity.preview(project, request([result]), check=cancel)
    report = intensity.preview(project, request([result]))
    monkeypatch.setattr(intensity, "MAX_REPORT_BYTES", len(canonical_json(report).encode()) - 1)
    with pytest.raises(ValueError, match="8 MiB"):
        intensity.validate_report(report)


def test_actual_compartment_producer_all_three_partitions_and_null_empty(tmp_path):
    wb, result, parents, _ = actual_compartment_scene(tmp_path)
    catalog = intensity.catalog(wb.project, [result["id"]])
    assert {d.get("compartment") for d in catalog["results"][0]["descriptors"]} == {
        None,
        "cell",
        "nuclear",
        "cytoplasm",
    }
    for compartment in ("object", "cell", "nuclear", "cytoplasm"):
        report = intensity.preview(wb.project, request([result], compartment))
        stored = {
            row["label"]: (row if compartment == "object" else row["compartments"][compartment])[
                "intensity"
            ][CHANNEL]["mean"]
            for row in result["provenance"]["measurements"]
        }
        assert {row["label"]: row["value"] for row in report["observations"]} == stored
        assert report["endpoint"]["unit"] == "source-intensity"
        binding = report["bindings"][0]
        assert binding["label_inputs"]["cells"]["result_id"] == parents["cells"]["id"]
        assert binding["scope"]["selection"]["c"] == 1
        assert binding["scope"]["label_producers"]["nuclei"]["selection"]["c"] == 2
        intensity.validate_references(report, *references(wb.project, report))
        if compartment == "nuclear":
            empty = next(o for o in report["observations"] if o["label"] == 2)
            assert empty["value"] is None and empty["status"] == "null"
        if compartment in {"object", "cell", "cytoplasm"}:
            assert [o["value"] for o in report["observations"]] == [-5, -5, 0]
    wb.close()


@pytest.mark.parametrize("compartment", ["cell", "nuclear", "cytoplasm"])
def test_compartment_endpoint_uses_measurement_epoch_and_keeps_label_producers(
    tmp_path, compartment
):
    declaration = {
        "name": "Corrected raw marker:核/β",
        "marker": "IL4R",
        "fluorophore": "AF647",
        "declaration": "Explicit measurement-time declaration",
    }
    wb, result, parents, _ = actual_compartment_scene(tmp_path, declaration=declaration)
    req = request([result], compartment, "1: Corrected raw marker:核/β")
    report = intensity.preview(wb.project, req)
    binding = report["bindings"][0]
    measured = result["provenance"]["compartment_measurement"]["channel_metadata"]
    assert binding["measurement_channel_metadata"] == measured
    assert measured["revision"] == 1
    assert binding["channel"] == {
        "key": "1: Corrected raw marker:核/β",
        "index": 0,
        "metadata": {"index": 0, **declaration},
    }
    assert binding["producing_channels"] == parents["cells"]["provenance"]["channel_metadata"]
    assert binding["producing_channels"]["revision"] == 0
    assert binding["producing_channels"]["channels"][0]["name"] == "raw.mean:核/β"
    for role, index in (("cells", 1), ("nuclei", 2)):
        assert (
            binding["scope"]["label_producers"][role]["input_channel"]["metadata"]
            == parents[role]["provenance"]["channel_metadata"]["channels"][index]
        )
    assert [row["value"] for row in report["observations"]] == (
        [-5, None, 0] if compartment == "nuclear" else [-5, -5, 0]
    )
    assert intensity.current_status(wb.project, report) == {"current": True, "changes": []}
    frozen = canonical_json(report)
    later_channels = copy.deepcopy(measured["channels"])
    later_channels[0].update(name="Later label", marker="Later marker", fluorophore="Later dye")
    save_channels(
        wb.project,
        {"source_id": result["source_id"], "channels": later_channels, "expected_revision": 1},
    )
    assert intensity.current_status(wb.project, report)["current"] is False
    assert canonical_json(intensity.validate_report(report)) == frozen
    intensity.validate_references(report, *references(wb.project, report))
    fresh = intensity.preview(wb.project, req)
    assert fresh["bindings"][0]["channels"]["revision"] == 2
    assert fresh["bindings"][0]["measurement_channel_metadata"] == measured
    assert fresh["bindings"][0]["channel"] == binding["channel"]
    assert fresh["observations"] == report["observations"]
    intensity.validate_references(fresh, *references(wb.project, fresh))
    # Object means were retained from the original cell producer, independently.
    original = intensity.preview(wb.project, request([result]))
    assert "measurement_channel_metadata" not in original["bindings"][0]
    assert original["bindings"][0]["channel"]["metadata"]["name"] == "raw.mean:核/β"
    wb.close()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b["measurement_channel_metadata"].update(source_id="0" * 32),
        lambda b: b["measurement_channel_metadata"].update(source_sha256="0" * 64),
        lambda b: b["measurement_channel_metadata"].update(revision=True),
        lambda b: b["measurement_channel_metadata"].update(revision=2),
        lambda b: b["measurement_channel_metadata"]["channels"][0].update(index=1),
        lambda b: b["measurement_channel_metadata"]["channels"][0].update(name="Forged"),
        lambda b: b["measurement_channel_metadata"]["original_names"].__setitem__(0, "Forged"),
        lambda b: b["compartment_channels"][0].update(index=1),
        lambda b: b["compartment_channels"][0].update(name="1: Forged"),
        lambda b: b["compartment_channels"][0].update(source_id="0" * 32),
        lambda b: b["compartment_channels"][0]["selection"].update(c=1),
    ],
)
def test_compartment_measurement_snapshot_and_literal_binding_reject_forgery(tmp_path, mutate):
    wb, result, _, _ = actual_compartment_scene(tmp_path, declaration={"marker": "IL4R"})
    report = intensity.preview(wb.project, request([result], "cell"))
    mutate(report["bindings"][0])
    with pytest.raises(ValueError):
        intensity.validate_report(reseal(report))
    wb.close()


@pytest.mark.parametrize("epoch", [0, 1])
def test_compartment_coherent_hash_rebinding_to_other_epoch_is_rejected(tmp_path, epoch):
    wb, result, _, _ = actual_compartment_scene(tmp_path, declaration={"marker": "IL4R"})
    report = intensity.preview(wb.project, request([result], "cell"))
    binding = report["bindings"][0]
    # The literal key and numbers remain identical across these declaration epochs.
    binding["measurement_channel_metadata"] = copy.deepcopy(binding["producing_channels"])
    binding["measurement_channel_metadata"]["revision"] = epoch
    if epoch == 1:
        binding["measurement_channel_metadata"]["channels"][0]["marker"] = "Forged marker"
        binding["channels"] = copy.deepcopy(binding["measurement_channel_metadata"])
    binding["channel"]["metadata"] = copy.deepcopy(
        binding["measurement_channel_metadata"]["channels"][0]
    )
    reseal(report)
    intensity.validate_report(report)
    with pytest.raises(ValueError, match="measurement channel binding"):
        intensity.validate_references(report, *references(wb.project, report))
    wb.close()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda m: m.update(source_id="0" * 32),
        lambda m: m.update(source_sha256="0" * 64),
        lambda m: m.update(revision=-1),
        lambda m: m.update(revision=0),
        lambda m: m.update(revision=2),
        lambda m: m["channels"][0].update(index=1),
        lambda m: m["channels"][0].update(name="Forged name"),
        lambda m: m["original_names"].__setitem__(0, "Forged acquisition name"),
    ],
)
def test_actual_compartment_provenance_rejects_invalid_measurement_snapshot(tmp_path, mutate):
    wb, result, _, _ = actual_compartment_scene(tmp_path, declaration={"marker": "IL4R"})
    provenance = copy.deepcopy(result["provenance"])
    mutate(provenance["compartment_measurement"]["channel_metadata"])
    # Save a new, correctly hashed immutable result: report validation must not
    # mistake a coherent result revision hash for consistent measurement evidence.
    forged = wb.project.save_result(
        source_id=result["source_id"],
        kind=result["kind"],
        arrays={name: wb.project.load_array(value) for name, value in result["arrays"].items()},
        provenance=provenance,
    )
    wb.project.review(forged["id"], forged["revision_hash"], "reviewed")
    with pytest.raises(ValueError):
        intensity.preview(wb.project, request([forged], "cell"))
    wb.close()


def test_legacy_compartment_snapshot_requires_exact_measurement_epoch_facts(tmp_path):
    wb, result, _, _ = actual_compartment_scene(tmp_path)
    report = intensity.preview(wb.project, request([result], "cell"))
    report["bindings"][0].pop("measurement_channel_metadata")
    reseal(report)
    frozen = canonical_json(report)
    intensity.validate_references(report, *references(wb.project, report))
    assert canonical_json(intensity.validate_report(report)) == frozen
    assert intensity.current_status(wb.project, report) == {"current": True, "changes": []}
    wb.close()
    wb, result, _, _ = actual_compartment_scene(
        tmp_path / "later-epoch", declaration={"marker": "IL4R"}
    )
    old = intensity.preview(wb.project, request([result], "cell"))
    binding = old["bindings"][0]
    binding.pop("measurement_channel_metadata")
    binding["channel"]["metadata"] = copy.deepcopy(binding["producing_channels"]["channels"][0])
    reseal(old)
    intensity.validate_report(old)
    with pytest.raises(ValueError, match="measurement channel binding"):
        intensity.validate_references(old, *references(wb.project, old))
    status = intensity.current_status(wb.project, old)
    assert status["current"] is False
    assert "measurement_channel_metadata" in status["changes"][0]["reason"]
    wb.close()


def test_actual_recipe_nonsegmentation_channel_with_literal_unicode_punctuation(tmp_path):
    image = np.zeros((2, 16, 16), np.float32)
    image[0, 2:6, 2:6] = 100
    image[1] = -7.1234564781188965
    path = tmp_path / "two.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={"axes": "CYX", "Channel": {"Name": ["labels", "raw.mean:核/β"]}},
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Two channels"))
    source = wb.import_native(str(path))
    result = wb.project.result(
        wb.run_recipe(
            {
                "source_id": source["id"],
                "selection": {"c": 0},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 50},
                    "measurement_channels": [1],
                },
            }
        )["result"]["id"]
    )
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    sample(wb.project, result)
    report = intensity.preview(wb.project, request([result], channel="2: raw.mean:核/β"))
    assert report["bindings"][0]["channel"]["index"] == 1
    assert report["images"][0]["mean"] == float(image[1, 0, 0])
    assert report["bindings"][0]["scope"]["selection"]["c"] == 0
    assert report["bindings"][0]["scope"]["input_channel"]["metadata"]["name"] == "labels"
    intensity.validate_references(report, *references(wb.project, report))
    wb.close()


def test_review_private_identity_and_notes_are_hash_bound_not_disclosed(study):
    project, add, _ = study
    result = add([1])
    project.review(
        result["id"],
        result["revision_hash"],
        "reviewed",
        actor_id="private-reviewer",
        reason="private reason",
        coverage="private coverage",
    )
    report = intensity.preview(project, request([result]))
    encoded = canonical_json(report)
    assert all(
        text not in encoded for text in ("private-reviewer", "private reason", "private coverage")
    )
    binding = report["bindings"][0]
    assert (
        binding["review_sha256"]
        == hashlib.sha256(canonical_json(project.review_state(result["id"])).encode()).hexdigest()
    )
    assert len(report["software"]["implementation"]["sha256"]) == 64
    project.review(result["id"], result["revision_hash"], "reviewed", actor_id="second-reviewer")
    assert "review_sha256" in intensity.current_status(project, report)["changes"][0]["reason"]


def test_source_artifact_checksum_and_large_v2_rejected(study, monkeypatch):
    project, add, _ = study
    result = add([1])
    artifact = project.arrays / (result["arrays"]["labels"]["sha256"] + ".npy")
    original = artifact.read_bytes()
    artifact.write_bytes(original[:-1] + bytes([original[-1] ^ 255]))
    with pytest.raises(ValueError, match="checksum"):
        intensity.preview(project, request([result]))
    artifact.write_bytes(original)
    v2 = copy.deepcopy(result)
    v2["schema"] = "loci.research-result/v2"
    monkeypatch.setattr(project, "result", lambda identity, **kwargs: v2)
    with pytest.raises(ValueError, match="v2"):
        intensity.catalog(project, [result["id"]])


def test_total_object_bound_and_malformed_request_rejected(study, monkeypatch):
    project, add, _ = study
    result = add([1, 2])
    monkeypatch.setattr(intensity, "MAX_OBJECTS", 1)
    with pytest.raises(ValueError, match="50000"):
        intensity.preview(project, request([result]))
    req = request([result])
    req["endpoint"]["compartment"] = []
    with pytest.raises(ValueError):
        intensity.preview(project, req)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["bindings"][0]["channels"].update(revision=True),
        lambda r: r["bindings"][0]["producing_channels"].update(private_path="hidden"),
        lambda r: r["bindings"][0]["scope"]["geometry"].update(affine=[]),
        lambda r: r["bindings"][0]["scope"]["selection"].pop("c"),
        lambda r: r["bindings"][0]["scope"]["input_channel"].update(index=1),
        lambda r: r["bindings"][0]["scope"]["shape"].__setitem__(0, 1),
        lambda r: r["bindings"][0]["scope"]["acquisition"].update(unavailable=[]),
        lambda r: r["bindings"][0].update(references=[{"result_id": "bad"}]),
        lambda r: r["software"]["implementation"].update(sha256=None),
        lambda r: r["observations"][0].update(value=True),
    ],
)
def test_saved_binding_structures_fail_closed(study, mutate):
    project, add, _ = study
    report = intensity.preview(project, request([add([1])]))
    mutate(report)
    with pytest.raises(ValueError):
        intensity.validate_report(reseal(report))


def test_different_actual_segmentation_input_channels_cannot_share_raw_mean_scope(tmp_path):
    wb, _, first, _ = actual_compartment_scene(tmp_path, name="first")
    _, second, second_parents, _ = actual_compartment_scene(tmp_path, workbench=wb, name="second")
    other = wb.project.result(
        wb.run_recipe(
            {
                "source_id": second["source_id"],
                "selection": {"c": 2},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 50},
                    "measurement_channels": [0],
                },
            }
        )["result"]["id"]
    )
    original = first["cells"]
    assert original["provenance"]["recipe"] == other["provenance"]["recipe"]
    assert original["provenance"]["selection"]["c"] == 1
    assert other["provenance"]["selection"]["c"] == 2
    assert second_parents["cells"]["source_id"] != original["source_id"]
    for result in (original, other):
        wb.project.review(result["id"], result["revision_hash"], "reviewed")
    with pytest.raises(ValueError, match="Incompatible"):
        intensity.preview(wb.project, request([original, other]))
    wb.close()


def test_actual_nuclear_threshold_difference_is_not_hidden_by_identical_cell_recipe(tmp_path):
    wb, first, _, _ = actual_compartment_scene(tmp_path, name="first", nuclear_threshold=50)
    _, second, _, _ = actual_compartment_scene(
        tmp_path, workbench=wb, name="second", nuclear_threshold=100
    )
    assert first["provenance"]["recipe"] == second["provenance"]["recipe"]
    assert first["provenance"]["measurements"] == second["provenance"]["measurements"]
    # Before the repair these identical copied cell recipes hid the different
    # actual nuclear label producer; declarations cannot override that fact.
    with pytest.raises(ValueError, match="Incompatible"):
        intensity.preview(wb.project, request([first, second], "nuclear"))
    wb.close()


def test_bare_label_arrays_without_producing_method_are_explicitly_unsupported(tmp_path):
    from test_compartment_quantification import scene

    from loci_engine.research_quantification import execute_quantification

    wb, _, _, _, association, _ = scene(tmp_path)
    result = wb.project.result(
        execute_quantification(wb, "associate_results", association)["result"]["id"]
    )
    wb.project.review(result["id"], result["revision_hash"], "reviewed")
    sample(wb.project, result)
    with pytest.raises(ValueError, match="label-producing method"):
        intensity.preview(wb.project, request([result], "nuclear", "1: Raw A"))
    wb.close()


def test_original_compartment_label_inputs_survive_later_association_parents(tmp_path):
    wb, first, parents, _ = actual_compartment_scene(tmp_path)
    later_nuclei = wb.project.result(
        wb.run_recipe(
            {
                "source_id": first["source_id"],
                "selection": {"c": 2},
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 100},
                    "measurement_channels": [0],
                },
            }
        )["result"]["id"]
    )
    later = wb.project.result(
        wb.execute(
            "associate_results",
            {
                "cells": {"result_id": first["id"], "revision_hash": first["revision_hash"]},
                "nuclei": {
                    "result_id": later_nuclei["id"],
                    "revision_hash": later_nuclei["revision_hash"],
                },
                "roles": {"cells": "Authored cells", "nuclei": "Later nuclei"},
                "control": "Later association; retain original compartment measurements",
            },
        )["result"]["id"]
    )
    wb.project.review(later["id"], later["revision_hash"], "reviewed")
    assert later["provenance"]["association_inputs"]["nuclei"]["result_id"] == later_nuclei["id"]
    assert (
        later["provenance"]["compartment_measurement"]["label_inputs"]["nuclei"]["result_id"]
        == parents["nuclei"]["id"]
    )
    report = intensity.preview(wb.project, request([later], "nuclear"))
    binding = report["bindings"][0]
    assert binding["label_inputs"]["nuclei"]["result_id"] == parents["nuclei"]["id"]
    recorded = binding["scope"]["label_producers"]["nuclei"]["method"]["settings"]["recipe"][
        "segmentation"
    ]
    assert recorded["threshold"] == 50
    intensity.validate_references(report, *references(wb.project, report))
    wb.close()


def test_retained_label_dependencies_missing_forged_and_checksum_stale_reject(tmp_path):
    wb, result, parents, _ = actual_compartment_scene(tmp_path)
    report = intensity.preview(wb.project, request([result], "nuclear"))
    results, sources = references(wb.project, report)
    missing = dict(results)
    missing.pop(parents["nuclei"]["id"])
    with pytest.raises(ValueError, match="unavailable"):
        intensity.validate_references(report, missing, sources)
    forged = copy.deepcopy(results)
    forged[parents["nuclei"]["id"]]["provenance"]["recipe"]["segmentation"]["threshold"] = 100
    with pytest.raises(ValueError, match="checksum"):
        intensity.validate_references(report, forged, sources)
    misleading = copy.deepcopy(report)
    binding = misleading["bindings"][0]
    binding["label_inputs"]["nuclei"] = copy.deepcopy(binding["label_inputs"]["cells"])
    binding["scope"]["label_producers"]["nuclei"] = copy.deepcopy(
        binding["scope"]["label_producers"]["cells"]
    )
    reseal(misleading)
    intensity.validate_report(misleading)
    with pytest.raises(ValueError, match="label-input"):
        intensity.validate_references(misleading, results, sources)
    wb.close()


def test_original_parent_input_binding_must_match_retained_exact_selection(tmp_path):
    wb, result, _, _ = actual_compartment_scene(tmp_path)
    provenance = copy.deepcopy(result["provenance"])
    provenance["compartment_measurement"]["label_inputs"]["nuclei"]["selection"]["c"] = 1
    changed = wb.project.save_result(
        source_id=result["source_id"],
        kind=result["kind"],
        arrays={name: wb.project.load_array(value) for name, value in result["arrays"].items()},
        provenance=provenance,
    )
    wb.project.review(changed["id"], changed["revision_hash"], "reviewed")
    with pytest.raises(ValueError, match="stale or forged"):
        intensity.preview(wb.project, request([changed], "nuclear"))
    wb.close()
