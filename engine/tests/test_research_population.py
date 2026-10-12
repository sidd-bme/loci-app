"""Independent numerical and immutable Workbench population regression oracles."""

from __future__ import annotations

import copy
import hashlib
import itertools
import math
import sys

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_annotations import label_array_sha256
from loci_engine.research_operations import OPERATION_CATALOG
from loci_engine.research_population import intensity_metric_id, query_population
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_tiled_store import ObjectTableWriter, TiledArrayWriter
from loci_engine.workbench import Workbench

BINDING = {
    "result_id": "a" * 32,
    "revision_hash": "b" * 64,
    "source_id": "c" * 32,
    "source_sha256": "d" * 64,
}
MEAN = intensity_metric_id("raw:µm", "mean")


def row(label=1, measure=1, intensity=5):
    return {
        "label": label,
        "voxel_count": 1,
        "measure": measure,
        "measure_kind": "area",
        "measure_unit": "um^2",
        "distance_unit": "um",
        "centroid_index": [0, 0],
        "index_axes": "YX",
        "bbox_start": [0, 0],
        "bbox_stop_exclusive": [1, 1],
        "nearest_centroid_distance": None,
        "intensity": {"raw:µm": {"mean": intensity}},
    }


def query(rows, **request):
    return query_population(rows, request, BINDING)


def test_numeric_oracle_full_population_filter_sort_pagination_histogram_sampling():
    rows = [row(label=1000 + i * 7, measure=i, intensity=1000 - i) for i in range(301)]
    response = query(
        rows,
        filters=[{"metric": "measure", "min": 50, "max": 250}],
        sort={"metric": "measure", "direction": "desc"},
        offset=190,
        limit=11,
        plot_limit=13,
        bins=8,
        selected_label=1000 + 70 * 7,
    )
    assert response["total_count"] == 301
    assert response["filtered_count"] == 201
    assert response["accounting"]["filter_excluded_count"] == 100
    assert [item["values"]["measure"] for item in response["rows"]] == list(range(60, 49, -1))
    assert response["selected"]["filtered_index"] == 180
    histogram = response["histogram"]
    expected, edges = np.histogram(np.arange(50, 251), bins=8)
    assert histogram["edges"] == edges.tolist()
    assert histogram["counts"] == expected.tolist()
    assert sum(histogram["counts"]) == 201
    assert response["summaries"]["x"]["mean"] == 150
    assert response["summaries"]["x"]["median"] == 150
    scatter = response["scatter"]
    assert scatter["sampled"] and scatter["displayed_count"] == 13
    assert scatter["total_count"] == 201
    assert scatter["points"][0]["label"] == rows[50]["label"]
    assert scatter["points"][-1]["label"] == rows[250]["label"]
    assert (
        scatter
        == query(list(reversed(rows)), filters=response["query"]["filters"], plot_limit=13)[
            "scatter"
        ]
    )


def test_missing_nonfinite_values_never_become_zero_and_sort_missing_last_both_ways():
    rows = [row(10, 4), row(8, None), row(3, float("nan")), row(7, 4, float("inf")), row(5, 0)]
    for direction, expected in [("asc", [5, 7, 10, 3, 8]), ("desc", [7, 10, 5, 3, 8])]:
        response = query(rows, sort={"metric": "measure", "direction": direction})
        assert [item["label"] for item in response["rows"]] == expected
        assert response["accounting"]["metric_missing_counts"]["measure"] == 2
        assert response["histogram"]["finite_count"] == 3
        assert response["accounting"]["scatter_missing_count"] == 3
        assert response["summaries"]["x"]["mean"] == pytest.approx(8 / 3)
    filtered = query(rows, filters=[{"metric": "measure", "min": 0, "max": 4}], selected_label=8)
    assert filtered["filtered_count"] == 3
    assert filtered["accounting"]["filter_missing_count"] == 2
    assert filtered["selected"]["row"]["values"]["measure"] is None
    assert filtered["selected"]["filtered_index"] is None
    assert query(rows, selected_label=100)["selected"] is None


def test_empty_constant_endpoint_and_unmeasured_channel_cases():
    empty = query([])
    assert empty["metrics"] == [] and empty["query"]["x_metric"] is None
    assert empty["histogram"]["edges"] == empty["histogram"]["counts"] == []
    assert empty["summaries"]["x"]["mean"] is None
    constant = query([row(i, 0) for i in range(1, 8)], bins=64)
    assert constant["histogram"]["edges"] == [0, 0]
    assert constant["histogram"]["counts"] == [7]
    ends = query([row(1, 0), row(2, 1), row(3, 2)], bins=2)
    assert ends["histogram"]["counts"] == [1, 2]
    partial = row()
    partial["intensity"] = {}
    response = query([partial])
    assert all(not metric["id"].startswith("intensity:") for metric in response["metrics"])
    assert response["query"]["y_metric"] == "voxel_count"
    assert intensity_metric_id("x:y", "mean") != intensity_metric_id("x", "y:mean")


def test_ordinary_summary_arithmetic_preserves_existing_exact_receipts():
    # Exact accumulation rounds this mean one bit differently. Existing saved
    # workflow receipts must retain their normal-range summary arithmetic.
    values = [-81.80440218828333, 97.42679808111393, 89.34260374865411]
    response = query(
        [row(index + 1, intensity=value) for index, value in enumerate(values)], x_metric=MEAN
    )
    assert response["summaries"]["x"]["mean"] == 34.98833321382824
    assert response["summaries"]["x"]["median"] == 89.34260374865411


@pytest.mark.parametrize("sign", [-1, 1])
def test_finite_extreme_helper_mean_remains_finite(sign):
    value = sign * sys.float_info.max
    response = query([row(index + 1, intensity=value) for index in range(3)], x_metric=MEAN)
    assert response["summaries"]["x"]["mean"] == value
    assert response["summaries"]["x"]["median"] == value


def test_histogram_bins_match_exact_inclusive_filter_membership():
    values = [-2.0, 2.0]
    for edge in (-1.0, 0.0, 1.0):
        values.extend([math.nextafter(edge, -math.inf), edge, math.nextafter(edge, math.inf)])
    rows = [row(index + 1, intensity=value) for index, value in enumerate(values)]
    response = query(rows, x_metric=MEAN, bins=4)
    edges, counts = response["histogram"]["edges"], response["histogram"]["counts"]
    for index, count in enumerate(counts):
        low, high = edges[index : index + 2]
        last = index == len(counts) - 1
        expected = [
            item["label"]
            for item, value in zip(rows, values, strict=True)
            if low <= value and (value <= high if last else value < high)
        ]
        selected = query(
            rows,
            x_metric=MEAN,
            filters=[
                {
                    "metric": MEAN,
                    "min": low,
                    "max": high if last else math.nextafter(high, -math.inf),
                }
            ],
        )
        assert sorted(item["label"] for item in selected["rows"]) == sorted(expected)
        assert selected["filtered_count"] == count == len(expected)


def test_membership_receipt_binds_revision_filters_and_all_matching_labels():
    rows = [row(i, i) for i in range(1, 10)]
    first = query(rows, filters=[{"metric": "measure", "min": 3}])
    page = query(
        rows,
        filters=[{"metric": "measure", "min": 3}],
        offset=5,
        sort={"metric": "measure", "direction": "desc"},
    )
    assert first["membership_sha256"] == page["membership_sha256"]
    assert first["query_sha256"] != page["query_sha256"]
    assert (
        first["membership_sha256"]
        == query(list(reversed(rows)), filters=[{"metric": "measure", "min": 3}])[
            "membership_sha256"
        ]
    )
    receipt = {
        **BINDING,
        "filters": [{"metric": "measure", "min": 3.0}],
        "labels": list(range(3, 10)),
    }
    assert (
        first["membership_sha256"] == hashlib.sha256(canonical_json(receipt).encode()).hexdigest()
    )
    other = query_population(
        rows, {"filters": first["query"]["filters"]}, {**BINDING, "revision_hash": "e" * 64}
    )
    assert first["membership_sha256"] != other["membership_sha256"]
    assert (
        first["membership_sha256"]
        != query(rows, filters=[{"metric": "measure", "min": 4}])["membership_sha256"]
    )


@pytest.mark.parametrize(
    "population_request",
    [
        {"limit": 201},
        {"limit": True},
        {"offset": -1},
        {"offset": 100001},
        {"plot_limit": 2001},
        {"plot_limit": 0},
        {"bins": 65},
        {"bins": 0},
        {"x_metric": "missing"},
        {"y_metric": None},
        {"selected_label": True},
        {"filters": [{"metric": "measure"}]},
        {"filters": [{"metric": "measure", "min": None}]},
        {"filters": [{"metric": "measure", "min": float("inf")}]},
        {"filters": [{"metric": "measure", "min": True}]},
        {"filters": [{"metric": "measure", "min": 2, "max": 1}]},
        {"filters": [{"metric": "measure", "min": 1}] * 9},
        {"filters": [{"metric": "measure", "min": 1, "extra": 1}]},
        {"sort": {"metric": "measure", "direction": "descending"}},
        {"sort": {"metric": "measure", "direction": "asc", "extra": 1}},
        {"unexpected": 1},
    ],
)
def test_request_validation_is_typed_bounded_and_fail_closed(population_request):
    with pytest.raises(ValueError):
        query([row()], **population_request)


@pytest.mark.parametrize(
    "field,value",
    [
        ("label", 0),
        ("label", True),
        ("label", 2**32),
        ("measure_kind", "slab-volume"),
        ("measure_unit", ""),
        ("measure", "1"),
        ("measure", -1),
        ("index_axes", "XY"),
        ("centroid_index", [float("nan"), 0]),
        ("bbox_stop_exclusive", [0, 1]),
        ("voxel_count", 2),
    ],
)
def test_invalid_measurement_schema_is_refused(field, value):
    invalid = row()
    invalid[field] = value
    with pytest.raises(ValueError):
        query([invalid])


def test_duplicates_mixed_units_and_object_limit_fail_closed():
    with pytest.raises(ValueError, match="Duplicate"):
        query([row(), row()])
    mixed = row(2)
    mixed["measure_unit"] = "pixel^2"
    with pytest.raises(ValueError, match="incompatible"):
        query([row(), mixed])
    mixed = row(2)
    mixed["distance_unit"] = "pixel"
    with pytest.raises(ValueError, match="incompatible"):
        query([row(), mixed])
    # Lower the limit for a real streaming boundary test without a heavy 100k run.
    import loci_engine.research_population as population

    original = population.MAX_OBJECTS
    try:
        population.MAX_OBJECTS = 3
        with pytest.raises(ValueError, match="100000"):
            query(row(i) for i in range(1, 5))
    finally:
        population.MAX_OBJECTS = original


def _grid(project, values):
    writer = TiledArrayWriter(project, values.shape, values.dtype, 32)
    for y, x in itertools.product(range(0, values.shape[0], 32), range(0, values.shape[1], 32)):
        writer.write(y, x, values[y : y + 32, x : x + 32])
    return writer.finish()


@pytest.mark.parametrize("intensity", [math.ulp(0.0), 3 * math.ulp(0.0)])
def test_saved_subnormal_raw_intensity_summary_preserves_nonzero_values(tmp_path, intensity):
    project = ResearchProject.create(tmp_path / "tiny.loci-study", "Tiny")
    workbench = Workbench(project)
    image = np.full((3, 5), intensity, np.float64)
    labels = np.zeros(image.shape, np.uint32)
    labels[1, 1], labels[1, 3] = 1, 2
    path = tmp_path / "tiny.tif"
    tifffile.imwrite(path, image, metadata={"axes": "YX"})
    source = workbench.import_native(str(path))
    geometry = Geometry(
        "YX", ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)), "pixel", "image"
    )
    rows = measure_objects(labels, geometry, {"raw:µm": image})
    assert [item["intensity"]["raw:µm"]["mean"] for item in rows] == [intensity, intensity]
    result = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        provenance={"geometry": geometry.to_dict(), "measurements": rows},
    )
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "x_metric": MEAN,
    }
    for current in (workbench, Workbench(ResearchProject(project.root))):
        response = current.execute("population_query", request)
        assert response["summaries"]["x"]["mean"] == intensity
        assert response["summaries"]["x"]["median"] == intensity
        assert response["histogram"]["counts"] == [2]


def _published(tmp_path, schema):
    project = ResearchProject.create(
        tmp_path / "population.loci-study", "Population", schema_version=schema
    )
    workbench = Workbench(project)
    labels = np.zeros((64, 64), np.uint32)
    for index in range(260):
        labels[(index // 20) * 2, (index % 20) * 2] = index * 19 + 1
    # Hollow/concave object with centroid in background, sparse ID above uint16.
    labels[40:49, 40] = labels[40:49, 48] = labels[48, 40:49] = 70000
    image = (np.indices(labels.shape)[0] * 64 + np.indices(labels.shape)[1]).astype(np.uint16)
    path = tmp_path / "source.tif"
    tifffile.imwrite(path, image, metadata={"axes": "YX"})
    source = workbench.import_native(str(path))
    geometry = Geometry(
        "YX", ((0.5, 0, 0, 0), (0, 2, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)), "um", "image"
    )
    rows = measure_objects(labels, geometry, {"raw:µm": image})
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": {"t": 0, "c": 0, "z": 0},
        "recipe": {"threshold": 1},
        "runtime": {"engine": "test"},
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
    }
    if schema == 1:
        result = project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": image, "labels": labels},
            provenance={**provenance, "measurements": rows},
        )
    else:
        with ObjectTableWriter(project) as writer:
            for measurement in rows:
                writer.append(measurement)
            table = writer.finalize()
        result = project.save_tiled_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": _grid(project, image), "labels": _grid(project, labels)},
            provenance=provenance,
            object_table=table,
            label_sha256=label_array_sha256(labels),
        )
    return workbench, result, path, image, labels, rows


@pytest.mark.parametrize("schema", [1, 2])
def test_workbench_exact_revision_source_array_free_query_and_full_numeric_oracle(
    tmp_path, monkeypatch, schema
):
    workbench, result, path, image, labels, _ = _published(tmp_path, schema)
    original = path.read_bytes()
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "x_metric": MEAN,
        "y_metric": "measure",
        "bins": 16,
        "plot_limit": 17,
        "offset": 200,
        "limit": 100,
        "selected_label": 70000,
    }
    with monkeypatch.context() as patch:

        def refused(*args, **kwargs):
            raise AssertionError("population_query must not open image arrays")

        patch.setattr(workbench.project, "load_array", refused)
        patch.setattr(workbench.project, "_open_array_artifact", refused)
        response = workbench.execute("population_query", request)
    assert response["total_count"] == response["filtered_count"] == 261
    assert len(response["rows"]) == 61
    assert response["source_sha256"] == hashlib.sha256(original).hexdigest()
    assert response["selected"]["row"]["label"] == 70000
    # Independent pixel masks, not reused measurement implementation.
    means = [float(image[labels == label].mean()) for label in np.unique(labels) if label]
    counts, edges = np.histogram(means, bins=16)
    assert response["histogram"]["counts"] == counts.tolist()
    assert response["histogram"]["edges"] == edges.tolist()
    assert response["summaries"]["x"]["mean"] == pytest.approx(np.mean(means), abs=1e-12)
    assert response["summaries"]["x"]["median"] == float(np.median(means))
    assert response["scatter"]["sampled"]
    assert str(tmp_path) not in canonical_json(response)
    assert path.read_bytes() == original
    with pytest.raises(ValueError, match="exact result revision"):
        workbench.execute("population_query", {**request, "revision_hash": "0" * 64})
    with pytest.raises(ValueError, match="revision hash"):
        workbench.execute("population_query", {"result_id": result["id"]})
    path.write_bytes(b"changed source")
    with pytest.raises(ValueError, match="source changed|Registered source changed"):
        workbench.execute("population_query", request)


@pytest.mark.parametrize("schema", [1, 2])
def test_locate_concave_sparse_object_nearest_member_and_stale_rejection(tmp_path, schema):
    workbench, result, _, _, labels, measurements = _published(tmp_path, schema)
    selected = next(row for row in measurements if row["label"] == 70000)
    centroid = np.array(selected["centroid_index"])
    assert labels[tuple(np.floor(centroid).astype(int))] == 0
    request = {"result_id": result["id"], "revision_hash": result["revision_hash"], "label": 70000}
    located = workbench.execute("population_locate", request)
    coordinates = np.argwhere(labels == 70000)
    distances = np.square(coordinates - centroid).sum(axis=1)
    expected = coordinates[int(np.argmin(distances))].tolist()
    assert located == {**request, "point_index": expected}
    assert labels[tuple(located["point_index"])] == 70000
    with pytest.raises(ValueError, match="exact result revision"):
        workbench.execute("population_locate", {**request, "revision_hash": "0" * 64})
    with pytest.raises(ValueError, match="does not belong"):
        workbench.execute("population_locate", {**request, "label": 2})


def test_processed_unmeasured_and_forged_revision_results_are_refused(tmp_path):
    workbench, result, _, _, _, _ = _published(tmp_path, 1)
    original = workbench.project.result(result["id"])
    request = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    for modify in [
        lambda item: item["arrays"].pop("labels"),
        lambda item: item["provenance"].pop("measurements"),
    ]:
        changed = copy.deepcopy(original)
        modify(changed)
        changed["revision_hash"] = hashlib.sha256(
            canonical_json(
                {key: value for key, value in changed.items() if key != "revision_hash"}
            ).encode()
        ).hexdigest()
        with workbench.project.connection() as connection:
            connection.execute(
                "UPDATE results SET record=? WHERE id=?", (canonical_json(changed), result["id"])
            )
        with pytest.raises(ValueError, match="label-bearing|actual object"):
            workbench.execute(
                "population_query", {**request, "revision_hash": changed["revision_hash"]}
            )
    with workbench.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?",
            (canonical_json({**original, "kind": "forged"}), result["id"]),
        )
    with pytest.raises(ValueError, match="integrity"):
        workbench.execute("population_query", request)
    assert not OPERATION_CATALOG["population_query"]["mutates"]
    assert not OPERATION_CATALOG["population_locate"]["mutates"]


def test_explicit_label_sort_and_dimensional_count_units():
    response = query([row(19), row(3), row(500)], sort={"metric": "label", "direction": "desc"})
    assert [item["label"] for item in response["rows"]] == [500, 19, 3]
    assert response["metrics"][1]["id"] == "voxel_count"
    assert response["metrics"][1]["label"] == "Pixel count"
    assert response["metrics"][1]["unit"] == "pixel"
    volume = row(70000)
    volume.update(
        measure_kind="volume",
        measure_unit="um^3",
        index_axes="ZYX",
        centroid_index=[0, 0, 0],
        bbox_start=[0, 0, 0],
        bbox_stop_exclusive=[1, 1, 1],
    )
    volume["intensity"]["raw:µm"]["sum"] = 5
    result = query([volume])
    assert result["metrics"][1]["label"] == "Voxel count"
    assert result["metrics"][1]["unit"] == "voxel"
    assert (
        next(metric for metric in result["metrics"] if metric.get("statistic") == "sum")["unit"]
        == "source-intensity*voxel"
    )
    with pytest.raises(ValueError, match="incompatible"):
        query([row(), volume])
    with pytest.raises(ValueError):
        query([], filters=[{"metric": None, "min": 0}])


@pytest.mark.parametrize("mutation", ["count", "bounds", "dtype", "limit"])
def test_workbench_measurement_count_bounds_dtype_and_true_100000_bound(tmp_path, mutation):
    workbench, result, _, _, _, _ = _published(tmp_path, 1)
    changed = copy.deepcopy(result)
    if mutation == "count":
        changed["object_count"] = 260
    elif mutation == "bounds":
        changed["provenance"]["measurements"][0]["bbox_stop_exclusive"][0] = 10000
    elif mutation == "dtype":
        changed["arrays"]["labels"]["dtype"] = "float32"
    else:
        # Exercise the actual v1 100000 bound before row processing, without storing a giant record.
        measurements = changed["provenance"]["measurements"]
        changed["provenance"]["measurements"] = [measurements[0]] * 100001
        workbench.project.result = lambda result_id: changed
        with pytest.raises(ValueError, match="100000"):
            workbench.execute(
                "population_query",
                {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                },
            )
        return
    changed["revision_hash"] = hashlib.sha256(
        canonical_json(
            {key: value for key, value in changed.items() if key != "revision_hash"}
        ).encode()
    ).hexdigest()
    with workbench.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(changed), result["id"])
        )
    with pytest.raises(ValueError, match="count|bounds|integer label"):
        workbench.execute(
            "population_query",
            {
                "result_id": result["id"],
                "revision_hash": changed["revision_hash"],
            },
        )


def test_v1_volume_query_and_nearest_owned_voxel_use_zyx(tmp_path):
    project = ResearchProject.create(tmp_path / "volume.loci-study", "Volume")
    workbench = Workbench(project)
    image = np.arange(3 * 7 * 7, dtype=np.uint16).reshape(3, 7, 7)
    labels = np.zeros(image.shape, np.uint32)
    labels[:, 1:6, 1] = labels[:, 1:6, 5] = labels[:, 5, 1:6] = 90000
    source_path = tmp_path / "volume.tif"
    tifffile.imwrite(source_path, image, photometric="minisblack", metadata={"axes": "ZYX"})
    source = workbench.import_native(str(source_path))
    geometry = Geometry(
        "ZYX", ((0.5, 0, 0, 0), (0, 2, 0, 0), (0, 0, 3, 0), (0, 0, 0, 1)), "um", "image"
    )
    measurements = measure_objects(labels, geometry, {"raw": image})
    result = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        provenance={"geometry": geometry.to_dict(), "measurements": measurements},
    )
    request = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    population = workbench.execute("population_query", request)
    selected = population["rows"][0]
    assert selected["index_axes"] == "ZYX"
    assert selected["values"]["voxel_count"] == int(np.count_nonzero(labels))
    assert selected["values"]["measure"] == pytest.approx(3 * np.count_nonzero(labels))
    assert population["metrics"][0]["unit"] == "um^3"
    located = workbench.execute("population_locate", {**request, "label": 90000})
    coordinates = np.argwhere(labels == 90000)
    centroid = coordinates.mean(axis=0)
    distances = np.square(coordinates - centroid).sum(axis=1)
    assert located["point_index"] == coordinates[int(np.argmin(distances))].tolist()
    assert labels[tuple(located["point_index"])] == 90000
