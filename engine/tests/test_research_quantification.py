from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest
import tifffile
from scipy import ndimage as ndi

from loci_engine.quantitative import Geometry
from loci_engine.research_export import export_research_result
from loci_engine.research_project import ResearchProject
from loci_engine.research_quantification import (
    _physical_nms,
    _plateau_candidates,
    execute_quantification,
)
from loci_engine.workbench import Workbench


def _ome_source(
    workbench: Workbench,
    path: Path,
    values: np.ndarray,
    axes: str,
    *,
    spacing: tuple[float, ...],
    channel_names: list[str] | None = None,
) -> dict:
    metadata: dict[str, object] = {"axes": axes}
    for axis, step in zip(axes[-len(spacing) :], spacing, strict=True):
        metadata[f"PhysicalSize{axis}"] = step
        metadata[f"PhysicalSize{axis}Unit"] = "µm"
    if channel_names is not None:
        metadata["Channel"] = {"Name": channel_names}
    tifffile.imwrite(path, values, ome=True, metadata=metadata)
    return workbench.import_native(str(path))


def _puncta_request(source_id: str, selection: dict, **overrides: object) -> dict:
    request = {
        "source_id": source_id,
        "selection": selection,
        "sigma": 1.0,
        "response_threshold": 0.0,
        "raw_threshold": 50.0,
        "minimum_distance": 2.1,
        "aperture_radius": 1.0,
        "exclude_border": True,
        "control": "Thresholds fixed from a declared negative-control field.",
        "working_bytes": 32 * 1024**2,
    }
    request.update(overrides)
    return request


def test_puncta_2d_exact_log_response_physical_nms_preview_and_persistence(
    tmp_path: Path,
) -> None:
    project = ResearchProject.create(tmp_path / "puncta-2d.loci-study", "Puncta 2D")
    workbench = Workbench(project)
    raw = np.zeros((18, 22), dtype=np.uint16)
    raw[0, 10] = 120  # excluded because the aperture reaches the crop edge
    raw[5, 5] = 100
    raw[5, 9] = 80  # two micrometres from the stronger peak and suppressed
    raw[12, 16] = 90
    source = _ome_source(
        workbench,
        tmp_path / "puncta-2d.ome.tif",
        raw,
        "YX",
        spacing=(2.0, 0.5),
    )
    request = _puncta_request(source["id"], {"z": 0})

    preview = execute_quantification(workbench, "puncta_preview", request)
    assert preview["preview"] is True
    assert preview["adopted"] is False
    assert preview["overlay"].startswith("data:image/png;base64,")
    assert workbench.project.list_results() == []

    saved = execute_quantification(workbench, "puncta_run", request)
    result = project.result(saved["result"]["id"])
    response = project.load_array(result["arrays"]["response"])
    labels = project.load_array(result["arrays"]["labels"])
    image = project.load_array(result["arrays"]["image"])
    expected = np.zeros(raw.shape, dtype=np.float64)
    sigma_voxels = (0.5, 2.0)
    for axis, sigma_axis in enumerate(sigma_voxels):
        order = [0, 0]
        order[axis] = 2
        expected -= (
            ndi.gaussian_filter(
                raw.astype(np.float64),
                sigma=sigma_voxels,
                order=order,
                mode="reflect",
                truncate=4.0,
            )
            * sigma_axis**2
        )
    np.testing.assert_allclose(response, expected, rtol=0, atol=0)
    np.testing.assert_array_equal(image, raw.astype(np.float64))
    assert response.dtype == np.float64
    assert labels.dtype == np.uint32
    assert [peak["index"] for peak in result["provenance"]["peaks"]] == [[12, 16], [5, 5]]
    assert [row["measure"] for row in result["provenance"]["measurements"]] == [1.0, 1.0]
    assert result["provenance"]["puncta"]["sigma_voxels_array_axes"] == [0.5, 2.0]
    assert result["provenance"]["channel_metadata"]["original_names"] == ["Channel 1"]
    project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "puncta-export"
    receipt = export_research_result(project, result["id"], result["revision_hash"], destination)
    assert "puncta-peaks.csv" in [entry["name"] for entry in receipt["files"]]
    assert (
        len(list(csv.DictReader(io.StringIO((destination / "puncta-peaks.csv").read_text())))) == 2
    )


def test_puncta_rejects_undersampled_physical_scale(tmp_path: Path) -> None:
    project = ResearchProject.create(tmp_path / "undersampled.loci-study", "Scale")
    wb = Workbench(project)
    source = _ome_source(
        wb, tmp_path / "scale.ome.tif", np.zeros((8, 8), dtype=np.uint16), "YX", spacing=(3.0, 0.5)
    )
    with pytest.raises(ValueError, match="at least 0.5 voxel"):
        wb.execute("puncta_run", _puncta_request(source["id"], {"z": 0}, sigma=1.0))
    assert not project.list_results()


def test_plateau_and_equal_response_ties_are_c_order_deterministic() -> None:
    raw = np.full((10, 10), 10.0)
    response = np.zeros((10, 10), dtype=np.float64)
    response[2:4, 2:4] = 5
    response[2, 5] = 5
    candidates = _plateau_candidates(response, raw, response_threshold=1, raw_threshold=1)
    assert [item[1] for item in candidates] == [(2, 2), (2, 5)]
    accepted = _physical_nms(
        candidates,
        Geometry.diagonal((1, 1), "um"),
        raw.shape,
        minimum_distance=4,
        aperture_radius=1,
        exclude_border=False,
    )
    assert [item["index"] for item in accepted] == [[2, 2]]


def test_puncta_budget_preflight_and_candidate_limit_precede_expensive_followup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = ResearchProject.create(tmp_path / "puncta-bounds.loci-study", "Puncta bounds")
    workbench = Workbench(project)
    raw = np.zeros((100, 100), dtype=np.uint16)
    source = _ome_source(
        workbench,
        tmp_path / "puncta-bounds.ome.tif",
        raw,
        "YX",
        spacing=(1.0, 1.0),
    )

    def must_not_load(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("pixel loading must follow the 192-byte preflight")

    monkeypatch.setattr(workbench, "load_scalar", must_not_load)
    with pytest.raises(ValueError, match="192-bytes-per-voxel"):
        execute_quantification(
            workbench,
            "puncta_run",
            _puncta_request(source["id"], {"z": 0}, working_bytes=1024),
        )

    response = np.zeros((201, 201), dtype=np.float64)
    response[::2, ::2] = 2
    with pytest.raises(ValueError, match="candidate limit"):
        _plateau_candidates(
            response,
            np.ones_like(response),
            response_threshold=1,
            raw_threshold=0,
        )


def test_puncta_3d_anisotropic_distance_and_measurement(tmp_path: Path) -> None:
    project = ResearchProject.create(tmp_path / "puncta-3d.loci-study", "Puncta 3D")
    workbench = Workbench(project)
    raw = np.zeros((8, 18, 20), dtype=np.uint16)
    raw[2, 6, 6] = 120
    raw[4, 6, 6] = 100  # four micrometres away; suppressed by 4.1 um minimum
    raw[5, 13, 15] = 110
    source = _ome_source(
        workbench,
        tmp_path / "puncta-3d.ome.tif",
        raw,
        "ZYX",
        spacing=(2.0, 1.0, 1.0),
    )
    output = execute_quantification(
        workbench,
        "puncta_run",
        _puncta_request(
            source["id"],
            {"z": 0, "z_stop": 8},
            sigma=2.0,
            minimum_distance=4.1,
            aperture_radius=1.0,
            exclude_border=False,
        ),
    )
    result = project.result(output["result"]["id"])
    labels = project.load_array(result["arrays"]["labels"])
    assert labels.shape == raw.shape
    assert [item["index"] for item in result["provenance"]["peaks"]] == [
        [2, 6, 6],
        [5, 13, 15],
    ]
    assert result["provenance"]["puncta"]["sigma_voxels_array_axes"] == [1.0, 2.0, 2.0]
    assert [row["measure"] for row in result["provenance"]["measurements"]] == [2.0, 2.0]
    assert result["provenance"]["measurements"][0]["nearest_centroid_distance"] == pytest.approx(
        np.sqrt(7**2 + 9**2 + 6**2)
    )


def _registered_source(project: ResearchProject, path: Path) -> dict:
    path.write_bytes(b"immutable two-channel acquisition")
    return project.register_source(
        path.resolve(),
        hashlib.sha256(path.read_bytes()).hexdigest(),
        {"channel_names": ["Acquired nuclei", "Acquired cell boundary"]},
    )


def _label_result(
    project: ResearchProject,
    source: dict,
    geometry: Geometry,
    labels: np.ndarray,
    *,
    channel: int,
    time: int = 0,
) -> dict:
    image = np.arange(labels.size, dtype=np.float64).reshape(labels.shape) + channel
    return project.save_result(
        source_id=source["id"],
        kind="fixture-labels",
        arrays={"image": image, "labels": labels},
        provenance={
            "geometry": geometry.to_dict(),
            "selection": {
                "x": 0,
                "y": 0,
                "width": labels.shape[-1],
                "height": labels.shape[-2],
                "z": 0,
                "t": time,
                "c": channel,
                "level": 0,
            },
            "measurements": [],
        },
    )


def _association_scene(tmp_path: Path):
    project = ResearchProject.create(tmp_path / "association.loci-study", "Association")
    workbench = Workbench(project)
    source_path = tmp_path / "association-source.bin"
    source = _registered_source(project, source_path)
    geometry = Geometry.diagonal((2.0, 0.5), "um")
    nuclei_labels = np.array([[0, 0, 0, 0, 0], [0, 1, 1, 1, 0], [0, 2, 2, 0, 0]], dtype=np.uint32)
    cell_labels = np.array([[0, 0, 0, 0, 0], [0, 9, 8, 0, 0], [0, 0, 0, 0, 0]], dtype=np.uint32)
    nuclei = _label_result(project, source, geometry, nuclei_labels, channel=0)
    cells = _label_result(project, source, geometry, cell_labels, channel=1)
    request = {
        "nuclei": {"result_id": nuclei["id"], "revision_hash": nuclei["revision_hash"]},
        "cells": {"result_id": cells["id"], "revision_hash": cells["revision_hash"]},
        "roles": {
            "nuclei": "User-declared segmented nuclear regions",
            "cells": "User-declared segmented cell regions",
        },
        "control": "Association rule fixed before inspecting this field.",
        "working_bytes": 16 * 1024**2,
    }
    return workbench, source_path, source, geometry, nuclei, cells, request


def test_exact_cross_channel_association_persists_both_fields_and_ambiguity(
    tmp_path: Path,
) -> None:
    workbench, _, _, _, nuclei, cells, request = _association_scene(tmp_path)
    output = execute_quantification(workbench, "associate_results", request)
    child = workbench.project.result(output["result"]["id"])
    assert child["parent_id"] == cells["id"]
    assert child["provenance"]["association_inputs"]["nuclei"]["result_id"] == nuclei["id"]
    assert child["provenance"]["association_inputs"]["cells"]["result_id"] == cells["id"]
    rows = child["provenance"]["association"]["rows"]
    assert rows[0]["cell_label"] == 8
    assert rows[0]["overlap_fraction"] == 1 / 3
    assert rows[0]["outside_fraction"] == 1 / 3
    assert rows[0]["ambiguous"] is True
    assert rows[0]["candidate_cells"] == [8, 9]
    assert rows[1]["cell_label"] is None
    assert rows[1]["outside_fraction"] == 1
    assert set(child["arrays"]) == {"image", "labels", "nuclei_labels"}
    measurements = {row["label"]: row for row in child["provenance"]["measurements"]}
    assert measurements[8]["association"]["nucleus_count"] == 1
    assert measurements[8]["association"]["ambiguous_nucleus_labels"] == [1]
    assert measurements[9]["association"]["nucleus_count"] == 0
    assert child["provenance"]["channel_metadata"]["original_names"] == [
        "Acquired nuclei",
        "Acquired cell boundary",
    ]


def test_association_rejects_revision_time_source_and_artifact_staleness(tmp_path: Path) -> None:
    workbench, source_path, source, geometry, nuclei, cells, request = _association_scene(tmp_path)
    stale = {**request, "nuclei": {**request["nuclei"], "revision_hash": "a" * 64}}
    with pytest.raises(ValueError, match="stale"):
        execute_quantification(workbench, "associate_results", stale)

    mismatched = _label_result(
        workbench.project,
        source,
        geometry,
        workbench.project.load_array(cells["arrays"]["labels"]),
        channel=1,
        time=1,
    )
    with pytest.raises(ValueError, match="time and crop"):
        execute_quantification(
            workbench,
            "associate_results",
            {
                **request,
                "cells": {
                    "result_id": mismatched["id"],
                    "revision_hash": mismatched["revision_hash"],
                },
            },
        )

    artifact = nuclei["arrays"]["labels"]
    artifact_path = workbench.project.arrays / f"{artifact['sha256']}.npy"
    artifact_path.write_bytes(b"changed")
    with pytest.raises(ValueError, match="hash/size"):
        execute_quantification(workbench, "associate_results", request)

    # Source validation is independently fail-closed on a fresh study.
    other_root = tmp_path / "source-stale"
    other_root.mkdir()
    other = _association_scene(other_root)
    other_workbench, other_path, _, _, _, _, other_request = other
    other_path.write_bytes(b"changed source")
    with pytest.raises(ValueError, match="changed"):
        execute_quantification(other_workbench, "associate_results", other_request)
    assert workbench.project.result(cells["id"])["id"] == cells["id"]


def test_association_preserves_parent_raw_measurements_gates_and_export_dependencies(
    tmp_path: Path,
):
    project = ResearchProject.create(tmp_path / "raw-association.loci-study", "Raw association")
    wb = Workbench(project)
    values = np.zeros((2, 10, 12), dtype=np.uint16)
    values[0, 3:5, 4:6] = 100
    values[1, 2:7, 3:8] = 300
    source = _ome_source(
        wb,
        tmp_path / "raw.ome.tif",
        values,
        "CYX",
        spacing=(1.0, 0.5),
        channel_names=["Nuclear declaration", "Cell declaration"],
    )
    gate = {
        "name": "Above control",
        "channel": "2: Cell declaration",
        "statistic": "mean",
        "threshold": 250,
        "control": "Fixed synthetic reference",
    }

    def run(channel):
        return wb.run_recipe(
            {
                "source_id": source["id"],
                "selection": {"c": channel},
                "recipe": {
                    "steps": [{"op": "subtract_constant", "value": 100}] if channel else [],
                    "segmentation": {
                        "method": "components",
                        "threshold": 50,
                        "min_size": 0,
                        "polarity": "bright",
                        "exclude_border": False,
                    },
                    "measurement_channels": [channel],
                    "gates": [gate] if channel else [],
                },
            }
        )["result"]

    nuclei, cells = run(0), run(1)
    parent = project.result(cells["id"])
    assert project.load_array(parent["arrays"]["image"]).max() == 200
    child_summary = wb.execute(
        "associate_results",
        {
            "nuclei": {"result_id": nuclei["id"], "revision_hash": nuclei["revision_hash"]},
            "cells": {"result_id": cells["id"], "revision_hash": cells["revision_hash"]},
            "roles": {"nuclei": "Declared nuclei", "cells": "Declared cells"},
            "control": "Synthetic geometry",
        },
    )["result"]
    child = project.result(child_summary["id"])
    row = child["provenance"]["measurements"][0]
    assert row["intensity"]["2: Cell declaration"]["mean"] == 300
    assert row["marker_gates"]["Above control"] is True
    assert child["provenance"]["recipe"] == parent["provenance"]["recipe"]
    project.review(child["id"], child["revision_hash"], "reviewed")
    destination = tmp_path / "association-export"
    receipt = export_research_result(project, child["id"], child["revision_hash"], destination)
    assert "nucleus-cell-associations.csv" in [entry["name"] for entry in receipt["files"]]
    exported = json.loads((destination / "result.json").read_text())
    assert (
        exported["result"]["provenance"]["measurements"][0]["intensity"]["2: Cell declaration"][
            "mean"
        ]
        == 300
    )
    # The nuclear image is not copied into this child, but remains a bound dependency.
    nuclear_image = project.result(nuclei["id"])["arrays"]["image"]
    (project.arrays / f"{nuclear_image['sha256']}.npy").write_bytes(b"tampered parent")
    with pytest.raises(ValueError, match="hash/size"):
        export_research_result(
            project, child["id"], child["revision_hash"], tmp_path / "stale-export"
        )
    assert not (tmp_path / "stale-export").exists()


def test_association_publication_guard_reloads_every_bound_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench, _, _, _, nuclei, _, request = _association_scene(tmp_path)
    target = workbench.project.arrays / f"{nuclei['arrays']['labels']['sha256']}.npy"
    original = workbench.project.store_array
    calls = 0

    def mutate_after_staging(array: np.ndarray) -> dict:
        nonlocal calls
        descriptor = original(array)
        calls += 1
        if calls == 3:
            target.write_bytes(b"tampered after staging")
        return descriptor

    monkeypatch.setattr(workbench.project, "store_array", mutate_after_staging)
    before = len(workbench.project.list_results())
    with pytest.raises(ValueError, match="hash/size"):
        execute_quantification(workbench, "associate_results", request)
    assert len(workbench.project.list_results()) == before


def _colocalisation_scene(tmp_path: Path):
    project = ResearchProject.create(tmp_path / "coloc.loci-study", "Colocalisation")
    workbench = Workbench(project)
    values = np.zeros((2, 2, 2, 2, 6), dtype=np.uint16)
    first = np.arange(24, dtype=np.uint16).reshape(2, 2, 6)
    second = first * 2
    second.ravel()[::5] = 0
    values[:, 0] = first
    values[:, 1] = second
    path = tmp_path / "coloc.ome.tif"
    source = _ome_source(
        workbench,
        path,
        values,
        "TCZYX",
        spacing=(2.0, 1.0, 0.5),
        channel_names=["Acquired A", "Acquired B"],
    )
    request = {
        "source_id": source["id"],
        "selection": {"t": 0, "z": 0, "z_stop": 2},
        "first_channel": 0,
        "second_channel": 1,
        "threshold_first": 3,
        "threshold_second": 5,
        "control": "Thresholds fixed using declared single-channel controls.",
        "working_bytes": 16 * 1024**2,
    }
    return workbench, path, values, request


def test_colocalisation_persists_exact_float64_pair_metrics_and_reviewed_export(
    tmp_path: Path,
) -> None:
    workbench, _, values, request = _colocalisation_scene(tmp_path)
    output = execute_quantification(workbench, "colocalisation_run", request)
    result = workbench.project.result(output["result"]["id"])
    first = workbench.project.load_array(result["arrays"]["image"])
    second = workbench.project.load_array(result["arrays"]["paired_image"])
    np.testing.assert_array_equal(first, values[0, 0].astype(np.float64))
    np.testing.assert_array_equal(second, values[0, 1].astype(np.float64))
    expected_r = np.corrcoef(values[0, 0].ravel(), values[0, 1].ravel())[0, 1]
    assert output["metrics"]["pearson_r"] == pytest.approx(expected_r, abs=1e-14)
    first_mask = values[0, 0] > request["threshold_first"]
    second_mask = values[0, 1] > request["threshold_second"]
    joint = first_mask & second_mask
    assert output["metrics"]["manders_first"] == float(
        values[0, 0][joint].sum() / values[0, 0][first_mask].sum()
    )
    assert output["metrics"]["manders_second"] == float(
        values[0, 1][joint].sum() / values[0, 1][second_mask].sum()
    )
    assert output["metrics"]["voxel_pairs"] == 24
    assert result["provenance"]["measurements"] == []
    assert result["provenance"]["colocalisation"]["pixel_p_value"] == "not-calculated"
    assert result["provenance"]["channel_metadata"]["original_names"] == [
        "Acquired A",
        "Acquired B",
    ]

    workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    destination = tmp_path / "reviewed-colocalisation"
    receipt = export_research_result(
        workbench.project, result["id"], result["revision_hash"], destination
    )
    assert receipt["result_id"] == result["id"]
    exported = json.loads((destination / "result.json").read_text())
    assert exported["result"]["revision_hash"] == result["revision_hash"]
    assert (destination / "paired_image.npy").is_file()
    assert "colocalisation.csv" in [entry["name"] for entry in receipt["files"]]
    exported_metrics = list(
        csv.DictReader(io.StringIO((destination / "colocalisation.csv").read_text()))
    )
    assert len(exported_metrics) == 1


def test_colocalisation_rejects_same_channel_and_source_change_during_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench, path, _, request = _colocalisation_scene(tmp_path)
    with pytest.raises(ValueError, match="distinct"):
        execute_quantification(
            workbench,
            "colocalisation_run",
            {**request, "second_channel": request["first_channel"]},
        )
    original_save = workbench.project.save_result

    def mutate_source_then_save(**kwargs: object) -> dict:
        with path.open("ab") as stream:
            stream.write(b"changed")
        return original_save(**kwargs)

    monkeypatch.setattr(workbench.project, "save_result", mutate_source_then_save)
    with pytest.raises((RuntimeError, ValueError), match="changed"):
        execute_quantification(workbench, "colocalisation_run", request)
    assert workbench.project.list_results() == []
