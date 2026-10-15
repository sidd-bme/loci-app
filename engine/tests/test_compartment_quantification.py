"""Independent pixel oracles for explicit raw-channel cell partitions."""

from __future__ import annotations

import copy
import csv
import json
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.compartment_quantification import compartment_rows, measure_compartment_channel
from loci_engine.quantitative import Geometry
from loci_engine.research_export import export_research_result
from loci_engine.research_population import intensity_metric_id, query_population
from loci_engine.research_project import ResearchProject
from loci_engine.research_quantification import execute_quantification
from loci_engine.workbench import Workbench


def fields(volume=False):
    cells = np.zeros((6, 8), dtype=np.uint32)
    cells[1:4, 1:4] = 70000
    cells[2, 2] = 0  # cell hole must remain background
    cells[1:4, 4:7] = 91
    cells[4, 1:4] = 9  # no nuclear intersection
    cells[4, 5:7] = 88  # no cytoplasm
    nuclei = np.zeros_like(cells)
    nuclei[1, 2:6] = 50000  # crosses both cells; association tie is irrelevant
    nuclei[3, 1:3] = 7  # second nucleus in the same cell
    nuclei[2, 2] = 19  # in the cell hole
    nuclei[4, 5:7] = 23
    nuclei[0, 0] = 24  # unassigned nucleus
    if volume:
        cells = np.stack((cells, cells, cells))
        nuclei = np.stack((nuclei, np.zeros_like(nuclei), nuclei))
    base = np.arange(cells.size, dtype=np.float64).reshape(cells.shape)
    channels = [base * 1.25 - 25, base[::-1] * -0.75 + 4]
    return cells, nuclei, channels


@pytest.mark.parametrize("volume", [False, True])
def test_exact_pixel_partition_oracle_sparse_holes_cross_cell_empty_and_two_channels(volume):
    cells, nuclei, channels = fields(volume)
    originals = [item.copy() for item in (cells, nuclei, *channels)]
    spacing = (3.0, 2.0, 0.5) if volume else (2.0, 0.5)
    geometry = Geometry.diagonal(spacing, "um")
    rows = compartment_rows(cells, nuclei, geometry, working_bytes=16 * 1024**2)
    for index, raw in enumerate(channels):
        measure_compartment_channel(
            rows, cells, nuclei, raw, geometry, f"raw {index}", working_bytes=16 * 1024**2
        )
    assert {row["label"] for row in rows} == {9, 88, 91, 70000}
    for row in rows:
        whole = cells == row["label"]
        masks = {"cell": whole, "nuclear": whole & (nuclei > 0), "cytoplasm": whole & (nuclei == 0)}
        for name, mask in masks.items():
            record = row["compartments"][name]
            count = int(mask.sum())
            assert record["voxel_count"] == count
            assert record["measure"] == pytest.approx(count * np.prod(spacing), rel=1e-12, abs=0)
            assert record["measure_kind"] == ("volume" if volume else "area")
            assert record["measure_unit"] == f"um^{cells.ndim}"
            for index, raw in enumerate(channels):
                actual = record["intensity"][f"raw {index}"]
                pixels = raw[mask]
                assert actual["count"] == count
                assert actual["sum"] == pytest.approx(pixels.sum())
                for statistic, oracle in (
                    ("mean", np.mean),
                    ("min", np.min),
                    ("max", np.max),
                    ("std_population", np.std),
                ):
                    if count:
                        assert actual[statistic] == pytest.approx(oracle(pixels))
                    else:
                        assert actual[statistic] is None
        assert row["compartments"]["cell"]["voxel_count"] == sum(
            row["compartments"][name]["voxel_count"] for name in ("nuclear", "cytoplasm")
        )
    for original, actual in zip(originals, (cells, nuclei, *channels), strict=True):
        np.testing.assert_array_equal(original, actual)


def scene(tmp_path: Path, volume=False):
    cells, nuclei, raw = fields(volume)
    project = ResearchProject.create(tmp_path / "compartments.loci-study", "Compartments")
    wb = Workbench(project)
    source_path = tmp_path / "raw.ome.tif"
    metadata = {
        "axes": "CZYX" if volume else "CYX",
        "PhysicalSizeX": 0.5,
        "PhysicalSizeY": 2.0,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeYUnit": "µm",
        "Channel": {"Name": ["Raw A", "Raw B"]},
    }
    if volume:
        metadata.update(PhysicalSizeZ=3.0, PhysicalSizeZUnit="µm")
    tifffile.imwrite(source_path, np.stack(raw), ome=True, metadata=metadata)
    source = wb.import_native(str(source_path))
    image, geometry, selection = wb.load_scalar(
        source["id"], {"z": 0, "z_stop": 3} if volume else {"z": 0}
    )
    parents = []
    for index, labels in enumerate((nuclei, cells)):
        parents.append(
            project.save_result(
                source_id=source["id"],
                kind="segmentation",
                arrays={"image": image - 1000, "labels": labels},
                provenance={
                    "selection": {**selection, "c": index},
                    "geometry": geometry.to_dict(),
                    "measurements": [],
                    "channel_metadata": wb.channel_metadata(source["id"]),
                },
            )
        )
    request = {
        "nuclei": {"result_id": parents[0]["id"], "revision_hash": parents[0]["revision_hash"]},
        "cells": {"result_id": parents[1]["id"], "revision_hash": parents[1]["revision_hash"]},
        "roles": {"nuclei": "Declared nuclear labels", "cells": "Declared cells"},
        "control": "Synthetic pixel oracle",
        "measurement_channels": [0, 1],
        "working_bytes": 16 * 1024**2,
    }
    return wb, source_path, source, parents, request, raw


@pytest.mark.parametrize("volume", [False, True])
def test_raw_not_processed_parent_atomic_export_reopen_and_statistics(tmp_path, volume):
    wb, _, _, parents, request, raw = scene(tmp_path, volume)
    frozen = [wb.project.result(parent["id"]) for parent in parents]
    output = execute_quantification(wb, "associate_results", request)
    child = wb.project.result(output["result"]["id"])
    assert output["association_inputs"]["nuclei"]["revision_hash"] == parents[0]["revision_hash"]
    rows = child["provenance"]["measurements"]
    cells = wb.project.load_array(parents[1]["arrays"]["labels"])
    for row in rows:
        assert row["compartments"]["cell"]["intensity"]["1: Raw A"]["mean"] == pytest.approx(
            raw[0][cells == row["label"]].mean()
        )
    assert all(wb.project.result(parent["id"]) == parent for parent in frozen)
    metric = f"compartment:nuclear:{intensity_metric_id('1: Raw A', 'mean')}"
    population = query_population(
        rows,
        {"y_metric": metric},
        {
            "result_id": child["id"],
            "revision_hash": child["revision_hash"],
            "source_id": child["source_id"],
            "source_sha256": child["source_sha256"],
        },
    )
    assert (
        next(item for item in population["metrics"] if item["id"] == metric)["unit"]
        == "source-intensity"
    )
    assert population["accounting"]["metric_missing_counts"][metric] == 1
    wb.project.review(child["id"], child["revision_hash"], "reviewed")
    destination = tmp_path / "export"
    export_research_result(wb.project, child["id"], child["revision_hash"], destination)
    exported = json.loads((destination / "result.json").read_text())["result"]
    assert (
        exported["provenance"]["compartment_measurement"]
        == child["provenance"]["compartment_measurement"]
    )
    csv_rows = list(csv.DictReader((destination / "objects.csv").open()))
    assert (
        float(csv_rows[0]["compartments:cell:intensity:1: Raw A:sum"])
        == rows[0]["compartments"]["cell"]["intensity"]["1: Raw A"]["sum"]
    )
    reopened = ResearchProject(wb.project.root)
    assert reopened.result(child["id"])["provenance"]["measurements"] == rows
    wb.close()


@pytest.mark.parametrize("change", ["revision", "source", "metadata", "parent"])
def test_compartment_atomic_publication_rejects_stale_bindings(tmp_path, monkeypatch, change):
    wb, path, _, parents, request, _ = scene(tmp_path)
    before = len(wb.project.list_results())
    original = wb.project.store_array
    calls = 0

    def mutate(array):
        nonlocal calls
        result = original(array)
        calls += 1
        if calls == 1:
            if change == "source":
                path.write_bytes(b"changed")
            elif change == "metadata":
                metadata = wb.channel_metadata(parents[0]["source_id"])
                channels = copy.deepcopy(metadata["channels"])
                channels[0]["name"] = "Changed channel"
                wb.execute(
                    "channels",
                    {
                        "source_id": parents[0]["source_id"],
                        "channels": channels,
                        "expected_revision": metadata["revision"],
                    },
                )
            elif change == "parent":
                descriptor = parents[0]["arrays"]["image"]
                (wb.project.arrays / f"{descriptor['sha256']}.npy").write_bytes(b"tampered")
            else:
                project_result = wb.project.result

                def changed_result(result_id):
                    record = project_result(result_id)
                    if result_id == parents[0]["id"]:
                        record["revision_hash"] = "a" * 64
                    return record

                monkeypatch.setattr(wb.project, "result", changed_result)
        return result

    monkeypatch.setattr(wb.project, "store_array", mutate)
    with pytest.raises(ValueError):
        execute_quantification(wb, "associate_results", request)
    assert len(wb.project.list_results()) == before
    wb.close()


def test_compartment_budget_rejects_before_decoding_or_raw_channel_read(tmp_path, monkeypatch):
    wb, _, _, _, request, _ = scene(tmp_path)

    def forbidden(*args, **kwargs):
        pytest.fail("Allocation/IO occurred before combined budget rejection")

    monkeypatch.setattr(wb.project, "load_array", forbidden)
    monkeypatch.setattr(wb, "load_scalar", forbidden)
    with pytest.raises(ValueError, match="memory"):
        execute_quantification(wb, "associate_results", {**request, "working_bytes": 1024})
    wb.close()


@pytest.mark.parametrize("channels", [[], [0, 0], [True], [256], None])
def test_compartment_explicit_channels_fail_closed(tmp_path, channels):
    wb, _, _, _, request, _ = scene(tmp_path)
    with pytest.raises(ValueError):
        execute_quantification(
            wb, "associate_results", {**request, "measurement_channels": channels}
        )
    wb.close()


def test_association_omitted_compartments_preserves_legacy_measurements(tmp_path):
    wb, _, _, _, request, _ = scene(tmp_path)
    del request["measurement_channels"]
    output = execute_quantification(wb, "associate_results", request)
    child = wb.project.result(output["result"]["id"])
    assert "compartment_measurement" not in child["provenance"]
    assert all("compartments" not in row for row in child["provenance"]["measurements"])
    wb.close()


def test_raw_grid_mismatch_rejected_before_publication(tmp_path, monkeypatch):
    wb, _, _, _, request, _ = scene(tmp_path)
    original = wb.load_scalar

    def changed(*args, **kwargs):
        raw, geometry, selection = original(*args, **kwargs)
        return raw, geometry.cropped((0, 1)), selection

    monkeypatch.setattr(wb, "load_scalar", changed)
    before = len(wb.project.list_results())
    with pytest.raises(ValueError, match="exact selected native grid"):
        execute_quantification(wb, "associate_results", request)
    assert len(wb.project.list_results()) == before
    wb.close()


def test_exact_correction_child_compartments_do_not_retarget_later_corrections(tmp_path):
    wb, _, _, parents, request, raw = scene(tmp_path)
    binding = request["cells"]
    info = wb.execute("correction_info", binding)
    corrected = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "merge",
                    "expected_input_sha256": info["label_sha256"],
                    "source_labels": [9, 88],
                    "target_label": 9,
                }
            ],
        },
    )["result"]
    corrected_request = {
        **request,
        "cells": {"result_id": corrected["id"], "revision_hash": corrected["revision_hash"]},
    }
    result = execute_quantification(wb, "associate_results", corrected_request)["result"]
    frozen = wb.project.result(result["id"])
    assert frozen["parent_id"] == corrected["id"]
    assert frozen["provenance"]["correction"]["parent_id"] == parents[1]["id"]
    labels = wb.project.load_array(wb.project.result(corrected["id"])["arrays"]["labels"])
    merged = next(row for row in frozen["provenance"]["measurements"] if row["label"] == 9)
    assert merged["compartments"]["cell"]["intensity"]["1: Raw A"]["sum"] == pytest.approx(
        raw[0][labels == 9].sum()
    )
    next_binding = corrected_request["cells"]
    next_info = wb.execute("correction_info", next_binding)
    wb.execute(
        "correct_result",
        {
            **next_binding,
            "operations": [
                {
                    "op": "merge",
                    "expected_input_sha256": next_info["label_sha256"],
                    "source_labels": [9, 91],
                    "target_label": 9,
                }
            ],
        },
    )
    assert wb.project.result(result["id"]) == frozen
    wb.close()


def test_retained_record_budget_rejects_before_raw_io(tmp_path, monkeypatch):
    wb, _, _, _, request, _ = scene(tmp_path)

    def forbidden(*args, **kwargs):
        pytest.fail("Raw channel read occurred before retained-record budget rejection")

    monkeypatch.setattr(wb, "load_scalar", forbidden)
    with pytest.raises(ValueError, match="memory"):
        execute_quantification(wb, "associate_results", {**request, "working_bytes": 64 * 1024})
    wb.close()


@pytest.mark.parametrize("change", ["unit", "count", "empty", "nonfinite", "channels"])
def test_population_rejects_invalid_compartment_records(change):
    cells, nuclei, raw = fields()
    geometry = Geometry.diagonal((2.0, 0.5), "um")
    rows = compartment_rows(cells, nuclei, geometry, working_bytes=16 * 1024**2)
    measure_compartment_channel(
        rows, cells, nuclei, raw[0], geometry, "raw", working_bytes=16 * 1024**2
    )
    row = next(item for item in rows if item["label"] == 9)
    nuclear = row["compartments"]["nuclear"]
    if change == "unit":
        nuclear["measure_unit"] = "mm^2"
    elif change == "count":
        nuclear["voxel_count"] = 2
    elif change == "empty":
        nuclear["intensity"]["raw"]["mean"] = 0
    elif change == "nonfinite":
        row["compartments"]["cell"]["intensity"]["raw"]["sum"] = float("nan")
    else:
        nuclear["intensity"]["other"] = nuclear["intensity"].pop("raw")
    with pytest.raises(ValueError):
        query_population(
            rows,
            {},
            {
                "result_id": "a" * 32,
                "revision_hash": "b" * 64,
                "source_id": "c" * 32,
                "source_sha256": "d" * 64,
            },
        )


def test_association_only_child_keeps_original_compartment_label_bindings(tmp_path):
    wb, _, _, parents, request, _ = scene(tmp_path)
    measured = execute_quantification(wb, "associate_results", request)["result"]
    frozen = wb.project.result(measured["id"])
    # A corrected nuclear parent supplies a distinct later partition declaration.
    info = wb.execute("correction_info", request["nuclei"])
    later = wb.execute(
        "correct_result",
        {
            **request["nuclei"],
            "operations": [
                {
                    "op": "merge",
                    "expected_input_sha256": info["label_sha256"],
                    "source_labels": [7, 19],
                    "target_label": 7,
                }
            ],
        },
    )["result"]
    association_only = {
        **request,
        "nuclei": {"result_id": later["id"], "revision_hash": later["revision_hash"]},
        "cells": {"result_id": measured["id"], "revision_hash": measured["revision_hash"]},
    }
    del association_only["measurement_channels"]
    retained = execute_quantification(wb, "associate_results", association_only)["result"]
    record = wb.project.result(retained["id"])
    assert record["provenance"]["association_inputs"]["nuclei"]["result_id"] == later["id"]
    assert (
        record["provenance"]["compartment_measurement"]
        == frozen["provenance"]["compartment_measurement"]
    )
    assert (
        record["provenance"]["compartment_measurement"]["label_inputs"]["nuclei"]["result_id"]
        == parents[0]["id"]
    )
    wb.project.review(retained["id"], retained["revision_hash"], "reviewed")
    descriptor = parents[0]["arrays"]["image"]
    (wb.project.arrays / f"{descriptor['sha256']}.npy").write_bytes(
        b"tampered original compartment dependency"
    )
    with pytest.raises(ValueError, match="hash/size"):
        export_research_result(
            wb.project, retained["id"], retained["revision_hash"], tmp_path / "rejected-export"
        )
    assert not (tmp_path / "rejected-export").exists()
    wb.close()


def test_signed_cancellation_retains_stable_sum_mean_and_explicit_conservation_tolerance():
    cells = np.array([[1, 1, 1]], dtype=np.uint32)
    nuclei = np.array([[1, 1, 0]], dtype=np.uint32)
    raw = np.array([[-1e30, 1, 1e30]], dtype=np.float64)
    geometry = Geometry.diagonal((1, 1))
    rows = compartment_rows(cells, nuclei, geometry, working_bytes=1024 * 1024)
    measure_compartment_channel(
        rows, cells, nuclei, raw, geometry, "raw", working_bytes=1024 * 1024
    )
    statistics = rows[0]["compartments"]["cell"]["intensity"]["raw"]
    assert statistics["sum"] == 1
    assert statistics["mean"] == 1 / 3
    assert statistics["std_population"] == pytest.approx(np.sqrt(2 / 3) * 1e30)
