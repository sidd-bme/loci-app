"""Independent measurements, binding, numerical and publication regression oracles."""

from __future__ import annotations

import hashlib
import io
import math
import sys
import xml.etree.ElementTree as ET

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine import research_statistics_figure as figure
from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_population import intensity_metric_id, population_query, query_population
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench

BINDING = {
    "source_id": "a" * 32,
    "source_sha256": "b" * 64,
    "result_id": "c" * 32,
    "revision_hash": "d" * 64,
}
CHANNEL = 'actual μ/µ²³ & <channel> "raw"'
MEAN = intensity_metric_id(CHANNEL, "mean")


def row(label=1, measure=1, intensity=5):
    return {
        "label": label,
        "voxel_count": 1,
        "measure": measure,
        "measure_kind": "area",
        "measure_unit": "um^2",
        "centroid_index": [0, 0],
        "index_axes": "YX",
        "bbox_start": [0, 0],
        "bbox_stop_exclusive": [1, 1],
        "intensity": {CHANNEL: {"mean": intensity}},
    }


def request_for(population, **patch):
    return {
        "schema_version": "loci.statistics-figure-request/v1",
        **{key: population[key] for key in figure.BINDINGS},
        "query": population["query"],
        "chart": "histogram",
        "domain": {"mode": "full"},
        "width_mm": 85,
        "height_mm": 65,
        "preset": "publication-monochrome",
        **patch,
    }


def rendered(rows, **patch):
    query = patch.pop("query", {})
    population = query_population(rows, query, BINDING)
    request = request_for(population, **patch)
    files, manifest = figure.generate_figure(population, request, "test-application")
    return population, request, files, manifest


def real_project(tmp_path):
    project = ResearchProject.create(tmp_path / "Study.loci-study", "Synthetic")
    image = np.arange(35, dtype=np.uint16).reshape(5, 7)
    labels = np.zeros(image.shape, np.uint32)
    labels[1, 1] = 1
    labels[1, 3:5] = 2
    labels[3, 2:5] = 3
    source_file = tmp_path / "source.tif"
    tifffile.imwrite(
        source_file,
        np.broadcast_to(image, (2, 3, 5, 7)),
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 2,
            "PhysicalSizeZ": 3,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZUnit": "µm",
        },
    )
    source = Workbench(project).import_native(str(source_file))
    geometry = Geometry(
        "YX", ((0.5, 0, 0, 0), (0, 2, 0, 0), (0, 0, 3, 6), (0, 0, 0, 1)), "um", "image"
    )
    rows = measure_objects(labels, geometry, {CHANNEL: image})
    result = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        provenance={
            "geometry": geometry.to_dict(),
            "measurements": rows,
            "selection": {
                "t": 1,
                "c": 0,
                "z": 2,
                "x": 0,
                "y": 0,
                "width": 7,
                "height": 5,
                "level": 0,
            },
        },
    )
    population = population_query(
        project,
        {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "x_metric": MEAN,
            "y_metric": "measure",
            "bins": 2,
        },
    )
    return project, request_for(population), source_file


def test_svg_png_manifest_same_full_canonical_histogram_and_real_physical_dimensions():
    population, request, files, manifest = rendered(
        [row(i + 1, i) for i in range(5)], query={"bins": 2}
    )
    assert population["histogram"]["edges"] == [0, 2, 4]
    assert manifest["histogram"]["counts"] == [
        2,
        3,
    ]  # 2 belongs to second; last endpoint 4 included.
    assert manifest["domains"]["raw"] == {"x": [0, 4], "y": [0, 3]}
    assert manifest["visible_primitives"] == [
        {"bin_index": 0, "canonical_count": 2, "clipped_x": [0, 2]},
        {"bin_index": 1, "canonical_count": 3, "clipped_x": [2, 4]},
    ]
    root = ET.fromstring(files["figure.svg"])
    assert root.attrib["width"] == "85mm" and root.attrib["height"] == "65mm"
    assert root.attrib["viewBox"] == "0 0 2008 1535"
    texts = [element.text for element in root.findall(".//{*}text")]
    assert "Area (µm²)" in texts and "Object count" in texts
    with Image.open(io.BytesIO(files["figure.png"])) as png:
        assert png.size == (2008, 1535)
        assert png.info["dpi"] == pytest.approx((600, 600), abs=0.02)
    assert manifest["query"] == request["query"]
    for name in ("figure.svg", "figure.png"):
        assert hashlib.sha256(files[name]).hexdigest() == manifest["artifacts"][name]["sha256"]
    assert len(files["manifest.json"]) < 1024 * 1024


def test_current_histogram_clips_exact_bins_without_rebinning_or_new_membership():
    population, request, files, manifest = rendered(
        [row(i + 1, i) for i in range(5)],
        query={"bins": 2},
        domain={"mode": "current", "x": [1, 3], "y": [0, 3]},
    )
    assert manifest["histogram"] == population["histogram"]
    assert [item["canonical_count"] for item in manifest["visible_primitives"]] == [2, 3]
    assert [item["clipped_x"] for item in manifest["visible_primitives"]] == [[1, 2], [2, 3]]
    assert manifest["membership_sha256"] == request["membership_sha256"]
    assert manifest["domains"]["effective"] == {"x": [1, 3], "y": [0, 3]}


def test_sampled_scatter_bounds_use_full_filtered_summary_including_unsampled_outlier():
    rows = [row(i + 1, i, -1000 if i == 4 else i * 10) for i in range(10)]
    population, _, files, manifest = rendered(
        rows, query={"y_metric": MEAN, "plot_limit": 2}, chart="scatter"
    )
    assert population["scatter"]["points"] == [
        {"label": 1, "x": 0, "y": 0},
        {"label": 10, "x": 9, "y": 90},
    ]
    assert manifest["domains"]["effective"]["y"] == [-1000, 90]
    assert (
        manifest["scatter"]["sampled"]
        and manifest["scatter"]["sampling"] == "deterministic-evenly-spaced-label-order"
    )
    assert manifest["visible_primitives"] == [1, 10]
    assert len(ET.fromstring(files["figure.svg"]).findall(".//{*}circle")) == 2


def test_current_scatter_clips_sample_and_preserves_missing_counts():
    population, _, _, manifest = rendered(
        [row(1, 0, 0), row(2, 1, 10), row(3, 2, None), row(4, 3, 30)],
        query={"y_metric": MEAN},
        chart="scatter",
        domain={"mode": "current", "x": [0.5, 3], "y": [0, 15]},
    )
    assert manifest["visible_primitives"] == [2]
    assert manifest["accounting"]["scatter_missing_count"] == 1
    assert manifest["scatter"] == population["scatter"]


@pytest.mark.parametrize("value", [0.0, math.ulp(0.0), sys.float_info.max, -sys.float_info.max])
def test_constant_domains_preserve_exact_extremes_and_subnormals(value):
    _, _, files, manifest = rendered(
        [row(i + 1, intensity=value) for i in range(3)],
        query={"x_metric": MEAN, "y_metric": MEAN},
        chart="scatter",
        width_mm=180,
        height_mm=110,
    )
    assert manifest["domains"]["raw"] == {"x": [value, value], "y": [value, value]}
    assert manifest["domains"]["effective"] == manifest["domains"]["raw"]
    assert figure._ratio(value, [value, value]) == 0.5
    circles = ET.fromstring(files["figure.svg"]).findall(".//{*}circle")
    assert len({(element.attrib["cx"], element.attrib["cy"]) for element in circles}) == 1
    assert b"Infinity" not in files["figure.svg"] and b"NaN" not in files["figure.svg"]


def test_extreme_opposite_and_subnormal_mapping_is_finite_and_ordered():
    assert [
        figure._ratio(n, [-sys.float_info.max, sys.float_info.max])
        for n in [-sys.float_info.max, 0, sys.float_info.max]
    ] == [0, 0.5, 1]
    small = math.ulp(0.0)
    assert [figure._ratio(n, [small, 3 * small]) for n in [small, 2 * small, 3 * small]] == [
        0,
        0.5,
        1,
    ]
    _, _, files, _ = rendered(
        [row(1, intensity=-sys.float_info.max), row(2, intensity=sys.float_info.max)],
        query={"x_metric": MEAN, "bins": 2},
        width_mm=180,
        height_mm=110,
    )
    ET.fromstring(files["figure.svg"])


def test_unicode_font_glyphs_xml_escaping_and_no_external_resources():
    _, _, files, manifest = rendered(
        [row(1, 1, 2), row(2, 2, 3)], query={"x_metric": MEAN}, width_mm=180, height_mm=110
    )
    svg = files["figure.svg"]
    root = ET.fromstring(svg)
    assert any(CHANNEL in element.text for element in root.findall(".//{*}text"))
    assert b"&lt;channel&gt;" in svg and b"&amp;" in svg
    assert not any(
        element.tag.split("}")[-1] in {"script", "image", "foreignObject"}
        for element in root.iter()
    )
    assert not any(key.endswith("href") for element in root.iter() for key in element.attrib)
    assert len(manifest["software"]["font"]["sha256"]) == 64
    font, _ = figure._font(30, ["µμ²³"])
    missing = bytes(font.getmask("\U0010ffff"))
    assert all(bytes(font.getmask(character)) != missing for character in "µμ²³")
    assert "/System/" not in canonical_json(manifest)
    with pytest.raises(ValueError, match="verified font"):
        figure._font(30, ["\U0010ffff"])


@pytest.mark.parametrize(
    "patch",
    [
        {"data": []},
        {"width_mm": True},
        {"width_mm": 300, "height_mm": 300},
        {"query_sha256": "bad"},
        {"domain": {"mode": "current", "x": [1, 0], "y": [0, 2]}},
        {"domain": {"mode": "current", "x": [0, math.inf], "y": [0, 2]}},
    ],
)
def test_exact_bounded_request_rejects_artwork_dimensions_and_nonfinite(patch):
    population = query_population([row()], {}, BINDING)
    with pytest.raises(ValueError):
        figure.checked_request(request_for(population, **patch))


def test_current_domain_outside_data_empty_and_missing_figures_fail_explicitly():
    for rows in ([], [row(1, None, None)]):
        population = query_population(rows, {}, BINDING)
        with pytest.raises(ValueError, match="actual measured|no finite"):
            figure.generate_figure(population, request_for(population), "test")
    with pytest.raises(ValueError, match="within full canonical"):
        rendered([row(1, 1), row(2, 2)], domain={"mode": "current", "x": [0, 2], "y": [0, 1]})


def test_real_source_result_atomic_bundle_receipt_reopen_no_overwrite(tmp_path):
    project, request, source = real_project(tmp_path)
    original = source.read_bytes()
    destination = tmp_path / "Statistics.loci-figure"
    receipt = figure.export_statistics_figure(project, request, str(destination), "test")
    assert sorted(path.name for path in destination.iterdir()) == [
        "figure.png",
        "figure.svg",
        "manifest.json",
    ]
    assert receipt["width_px"] == 2008 and receipt["dpi"] == 600
    assert str(tmp_path) not in canonical_json(receipt)
    assert str(tmp_path) not in (destination / "manifest.json").read_text()
    for name, metadata in receipt["artifacts"].items():
        assert hashlib.sha256((destination / name).read_bytes()).hexdigest() == metadata["sha256"]
    assert (
        figure.canonical_population(ResearchProject(project.root), request)["query_sha256"]
        == request["query_sha256"]
    )
    before = {path.name: path.read_bytes() for path in destination.iterdir()}
    with pytest.raises(FileExistsError):
        figure.export_statistics_figure(project, request, str(destination), "test")
    assert {path.name: path.read_bytes() for path in destination.iterdir()} == before
    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


@pytest.mark.parametrize(
    "key", ["source_sha256", "source_id", "revision_hash", "query_sha256", "membership_sha256"]
)
def test_wrong_or_stale_bindings_fail_before_writing(tmp_path, key):
    project, request, _ = real_project(tmp_path)
    request[key] = "9" * len(request[key])
    with pytest.raises(ValueError):
        figure.export_statistics_figure(project, request, str(tmp_path / "bad.loci-figure"), "test")
    assert not (tmp_path / "bad.loci-figure").exists()
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


def test_source_mutation_at_publication_fails_closed_and_cleans_staging(tmp_path, monkeypatch):
    project, request, source = real_project(tmp_path)
    original = figure.publish_statistics_figure

    def mutate(params, reverify):
        source.write_bytes(b"source changed during figure generation")
        return original(params, reverify)

    monkeypatch.setattr(figure, "publish_statistics_figure", mutate)
    with pytest.raises(ValueError, match="source changed|Registered source changed"):
        figure.export_statistics_figure(project, request, str(tmp_path / "bad.loci-figure"), "test")
    assert not (tmp_path / "bad.loci-figure").exists()
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


def test_result_integrity_mutation_at_publication_fails_closed(tmp_path, monkeypatch):
    project, request, _ = real_project(tmp_path)
    original = figure.publish_statistics_figure

    def mutate(params, reverify):
        with project.connection() as connection:
            connection.execute(
                "UPDATE results SET record=? WHERE id=?",
                (canonical_json({"revision_hash": request["revision_hash"]}), request["result_id"]),
            )
        return original(params, reverify)

    monkeypatch.setattr(figure, "publish_statistics_figure", mutate)
    with pytest.raises(ValueError, match="integrity"):
        figure.export_statistics_figure(project, request, str(tmp_path / "bad.loci-figure"), "test")
    assert not (tmp_path / "bad.loci-figure").exists()
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


def test_dispatch_is_dedicated_and_absent_from_public_operation_catalog(tmp_path):
    from loci_engine.research_operations import OPERATION_CATALOG
    from loci_engine.research_rpc import dispatch_research

    project, request, _ = real_project(tmp_path)
    assert "statistics_figure_export" not in OPERATION_CATALOG
    receipt = dispatch_research(
        "research_statistics_figure_export",
        {
            "project": str(project.root),
            "request": request,
            "destination": str(tmp_path / "dispatch.loci-figure"),
            "application_version": "test",
        },
    )
    assert receipt["basename"] == "dispatch.loci-figure"
    with pytest.raises(ValueError):
        dispatch_research(
            "research_statistics_figure_export",
            {
                "project": str(project.root),
                "request": request,
                "destination": str(tmp_path / "missing.loci-figure"),
            },
        )


def test_single_point_current_histogram_domain_uses_canonical_half_open_bin():
    _, _, _, manifest = rendered(
        [row(i + 1, i) for i in range(5)],
        query={"bins": 2},
        domain={"mode": "current", "x": [2, 2], "y": [0, 3]},
    )
    assert manifest["visible_primitives"] == [
        {"bin_index": 1, "canonical_count": 3, "clipped_x": [2, 2]}
    ]


def test_fsync_failure_after_rename_reports_error_and_preserves_all_published_artifacts(
    tmp_path,
    monkeypatch,
):
    from loci_engine import statistics_figure_publication as publication

    project, request, _ = real_project(tmp_path)
    destination = tmp_path / "durability.loci-figure"

    def refused(_path):
        raise OSError("durability flush failed")

    monkeypatch.setattr(publication, "_fsync_directory", refused)
    with pytest.raises(OSError, match="durability flush failed"):
        figure.export_statistics_figure(project, request, str(destination), "test")
    assert sorted(path.name for path in destination.iterdir()) == [
        "figure.png",
        "figure.svg",
        "manifest.json",
    ]
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


def test_actual_project_figure_records_selection_dimension_roi_and_source_calibration(tmp_path):
    import json

    project, request, _ = real_project(tmp_path)
    destination = tmp_path / "scope.loci-figure"
    figure.export_statistics_figure(project, request, str(destination), "test")
    manifest = json.loads((destination / "manifest.json").read_text())
    scope = manifest["scientific_scope"]
    assert scope["selection"] == {
        "t": 1,
        "c": 0,
        "z": 2,
        "x": 0,
        "y": 0,
        "width": 7,
        "height": 5,
        "level": 0,
    }
    assert scope["selection_status"] == "recorded"
    assert scope["spatial_dimension"] == 2
    assert scope["index_axes"] == "YX" and scope["result_shape"] == [5, 7]
    assert scope["measure_kind"] == "area" and scope["measurement_geometry"]["unit"] == "um"
    assert scope["source"]["axes"] == "TCZYX"
    assert scope["source"]["dimensions"] == {"t": 2, "c": 1, "z": 3, "y": 5, "x": 7, "s": 1}
    assert scope["source"]["physical_calibration"] == {
        "axes": "ZYX",
        "spacing": [3.0, 2.0, 0.5],
        "unit": "µm",
    }
    assert scope["source"]["selected_level"]["index"] == 0
    assert str(tmp_path) not in canonical_json(scope)


def test_unsupported_staging_capability_fails_before_query_generation_or_writing(
    tmp_path,
    monkeypatch,
):
    project, request, _ = real_project(tmp_path)
    monkeypatch.setattr(figure.os, "supports_dir_fd", set())

    def forbidden(*args, **kwargs):
        raise AssertionError("Unsupported platform must fail before source/query/generation")

    monkeypatch.setattr(figure, "canonical_population", forbidden)
    monkeypatch.setattr(figure, "generate_figure", forbidden)
    with pytest.raises(ValueError, match="directory-descriptor staging.*Windows"):
        figure.export_statistics_figure(
            project, request, str(tmp_path / "unsupported.loci-figure"), "test"
        )
    assert not (tmp_path / "unsupported.loci-figure").exists()
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


@pytest.mark.parametrize(
    "unit,display",
    [
        ("um^2", "µm²"),
        ("um^3", "µm³"),
        ("pixel^2", "pixel²"),
        ("pixel^3", "pixel³"),
        ("um", "µm"),
        ("source-intensity*pixel", "source-intensity*pixel"),
    ],
)
def test_known_unit_display_only_preserves_actual_metric_and_channel_labels(unit, display):
    metric = {"label": "actual um^2 <channel>", "unit": unit}
    assert figure._label(metric) == f"actual um^2 <channel> ({display})"
    assert metric["unit"] == unit


def test_histogram_count_ticks_are_integers_and_manifest_units_stay_canonical():
    _, _, files, manifest = rendered([row(i + 1, i) for i in range(13)], query={"bins": 2})
    assert manifest["metrics"]["x"]["unit"] == "um^2"
    assert manifest["figure"]["axis_labels"]["x"] == "Area (µm²)"
    texts = ET.fromstring(files["figure.svg"]).findall(".//{*}text")
    y_ticks = [element.text for element in texts if element.attrib.get("text-anchor") == "end"]
    assert y_ticks and all(float(label).is_integer() for label in y_ticks)


def test_source_scope_metadata_change_at_publication_fails_closed(tmp_path, monkeypatch):
    import json

    project, request, _ = real_project(tmp_path)
    original = figure.publish_statistics_figure

    def mutate(params, reverify):
        with project.connection() as connection:
            record = json.loads(
                connection.execute(
                    "SELECT record FROM sources WHERE id=?",
                    (request["source_id"],),
                ).fetchone()[0]
            )
            record["metadata"]["physical_calibration"]["spacing"][1] = 4.0
            connection.execute(
                "UPDATE sources SET record=? WHERE id=?",
                (canonical_json(record), request["source_id"]),
            )
        return original(params, reverify)

    monkeypatch.setattr(figure, "publish_statistics_figure", mutate)
    with pytest.raises(ValueError, match="changed before publication"):
        figure.export_statistics_figure(
            project, request, str(tmp_path / "stale-scope.loci-figure"), "test"
        )
    assert not (tmp_path / "stale-scope.loci-figure").exists()
    assert not list(tmp_path.glob(".loci-statistics-figure-*"))


def test_legacy_missing_selection_and_geometry_remain_explicitly_unknown(tmp_path):
    project, request, _ = real_project(tmp_path)
    result = project.result(request["result_id"])
    legacy = project.save_result(
        source_id=request["source_id"],
        kind="segmentation",
        arrays={
            "image": project.load_array(result["arrays"]["image"]),
            "labels": project.load_array(result["arrays"]["labels"]),
        },
        provenance={"measurements": result["provenance"]["measurements"]},
    )
    population = population_query(
        project, {"result_id": legacy["id"], "revision_hash": legacy["revision_hash"]}
    )
    scope = figure._scientific_scope(project, request_for(population))
    assert scope["selection"] is None and scope["selection_status"] == "not-recorded"
    assert scope["measurement_geometry"] is None
    assert scope["index_axes"] == "YX" and scope["spatial_dimension"] == 2
