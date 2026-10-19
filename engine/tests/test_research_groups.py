"""Independent numerical, identity and persistence oracles for complete gates."""

from __future__ import annotations

import copy
import hashlib
import math
import time

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_groups import (
    DOCUMENT_KIND,
    dispatch_group,
    evaluate_gate,
    validate_group_document,
)
from loci_engine.research_population import intensity_metric_id, query_population
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench

BINDING = {
    "result_id": "a" * 32,
    "revision_hash": "b" * 64,
    "source_id": "c" * 32,
    "source_sha256": "d" * 64,
}
X = intensity_metric_id("raw X", "mean")
Y = intensity_metric_id("raw Y", "mean")


def row(label, x, y):
    return {
        "label": label,
        "voxel_count": 1,
        "measure": 1,
        "measure_kind": "area",
        "measure_unit": "pixel^2",
        "index_axes": "YX",
        "centroid_index": [0, 0],
        "bbox_start": [0, 0],
        "bbox_stop_exclusive": [1, 1],
        "intensity": {"raw X": {"mean": x}, "raw Y": {"mean": y}},
    }


def rectangle(bounds=(0, 10, 0, 10), **changes):
    return {
        "kind": "rectangle",
        "x_metric": X,
        "y_metric": Y,
        "x_transform": "linear",
        "y_transform": "linear",
        "bounds": list(bounds),
        **changes,
    }


def polygon(vertices, **changes):
    return {
        "kind": "polygon",
        "x_metric": X,
        "y_metric": Y,
        "x_transform": "linear",
        "y_transform": "linear",
        "vertices": vertices,
        **changes,
    }


def test_rectangle_exact_edges_and_adjacent_floats():
    points = [
        (0, 0),
        (10, 10),
        (0, 5),
        (5, 10),
        (5, 5),
        (math.nextafter(0, -math.inf), 5),
        (math.nextafter(10, math.inf), 5),
        (5, math.nextafter(0, -math.inf)),
        (5, math.nextafter(10, math.inf)),
    ]
    receipt = evaluate_gate(
        [row(i + 1, *point) for i, point in enumerate(points)],
        rectangle(),
        BINDING,
        include_centroids=True,
    )
    assert receipt["labels"] == [1, 2, 3, 4, 5]
    assert receipt["accounting"]["excluded_outside_count"] == 4
    assert receipt["gate"]["edge_policy"] == "include"
    assert receipt["gate"]["x_descriptor"]["channel"] == "raw X"
    assert receipt["centroids"] == [
        {"label": label, "centroid_index": [0, 0], "index_axes": "YX"} for label in [1, 2, 3, 4, 5]
    ]
    expected = {**BINDING, "labels": [1, 2, 3, 4, 5]}
    assert (
        receipt["membership_sha256"]
        == hashlib.sha256(canonical_json(expected).encode()).hexdigest()
    )


@pytest.mark.parametrize("reverse", [False, True])
def test_concave_polygon_independent_grid_oracle_and_inclusive_reentrant_edge(reverse):
    # L shape: union of two closed rectangles. This oracle does not use ray casting.
    vertices = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]
    if reverse:
        vertices.reverse()
    points = [(x / 2, y / 2) for y in range(-1, 10) for x in range(-1, 10)]
    rows = [row(i + 1, x, y) for i, (x, y) in enumerate(points)]
    expected = [
        i + 1
        for i, (x, y) in enumerate(points)
        if (0 <= x <= 4 and 0 <= y <= 1) or (0 <= x <= 1 and 0 <= y <= 4)
    ]
    assert evaluate_gate(rows, polygon(vertices), BINDING)["labels"] == expected


def test_diagonal_polygon_does_not_enlarge_edge_with_tolerance():
    gate = polygon([[0, 0], [2, 0], [0, 2]])
    points = [(1, 1), (1, math.nextafter(1, math.inf)), (1, math.nextafter(1, -math.inf))]
    assert evaluate_gate([row(i + 1, *p) for i, p in enumerate(points)], gate, BINDING)[
        "labels"
    ] == [1, 3]


def test_log_geometry_uses_transformed_coordinates_and_accounts_missing_nonfinite():
    rows = [
        row(1, 1, 1),
        row(2, 10, 10),
        row(3, 100, 100),
        row(4, 1000, 100),
        row(5, 0, 1),
        row(6, -1, 1),
        row(7, None, 1),
        row(8, math.nan, 1),
        row(9, 1, math.inf),
        row(10, 0, None),
        row(11, 1, -1),
    ]
    # In log coordinates the triangle is x+y <= 2; raw-space linear geometry differs.
    gate = polygon([[0, 0], [2, 0], [0, 2]], x_transform="log10", y_transform="log10")
    receipt = evaluate_gate(rows, gate, BINDING)
    assert receipt["labels"] == [1, 2]
    assert receipt["accounting"] == {
        "excluded_missing_or_nonfinite_count": 4,
        "excluded_nonpositive_log_count": 3,
        "excluded_outside_count": 2,
        "axis_missing_or_nonfinite_counts": {"x": 2, "y": 2},
        "axis_nonpositive_log_counts": {"x": 3, "y": 1},
    }
    assert (
        sum(
            receipt["accounting"][key]
            for key in (
                "excluded_missing_or_nonfinite_count",
                "excluded_nonpositive_log_count",
                "excluded_outside_count",
            )
        )
        + receipt["included_count"]
        == receipt["total_count"]
    )


def test_missing_channel_is_missing_not_zero_and_empty_population_refuses_invented_metrics():
    missing = row(2, 2, 2)
    missing["intensity"].pop("raw X")
    response = evaluate_gate([row(1, 1, 1), missing], rectangle(), BINDING)
    assert response["labels"] == [1]
    assert response["accounting"]["excluded_missing_or_nonfinite_count"] == 1
    with pytest.raises(ValueError, match="actual stored"):
        evaluate_gate([], rectangle(), BINDING)


def test_complete_membership_is_independent_of_display_sampling_and_row_order():
    rows = [row(i, i, i) for i in range(1, 1002)]
    sampled = query_population(rows, {"x_metric": X, "y_metric": Y, "plot_limit": 5}, BINDING)
    assert 501 in {item["label"] for item in sampled["scatter"]["points"]}
    assert 502 not in {item["label"] for item in sampled["scatter"]["points"]}
    gate = rectangle([501, 503, 501, 503])
    first = evaluate_gate(rows, gate, BINDING)
    assert first["labels"] == [501, 502, 503]
    assert first == evaluate_gate(reversed(rows), gate, BINDING)


@pytest.mark.parametrize(
    "gate",
    [
        rectangle(x_transform="log"),
        rectangle(bounds=[1, 0, 0, 1]),
        rectangle(bounds=[0, math.inf, 0, 1]),
        rectangle(bounds=[False, 1, 0, 1]),
        rectangle(edge_policy="exclude"),
        rectangle(extra=1),
        polygon([[0, 0], [2, 2], [0, 2], [2, 0]]),
        polygon([[0, 0], [1, 1], [2, 2]]),
        polygon([[0, 0], [1, 0], [0, 0]]),
        polygon([[0, 0], [4, 0], [1, 0], [1, 1], [0, 1]]),
        polygon([[0, 0], [1, 0], [1, 1], [0, 0]]),
        polygon([[0, 0], [1, 0], [1, 1]] * 22),
    ],
)
def test_malformed_geometry_transforms_and_nonfinite_bounds_fail_closed(gate):
    with pytest.raises(ValueError):
        evaluate_gate([row(1, 1, 1)], gate, BINDING)


def test_compartment_metrics_use_existing_actual_measurements_and_units():
    measurement = row(1, 5, 6)
    measurement["voxel_count"] = 2
    measurement["measure"] = 2
    measurement["bbox_stop_exclusive"] = [1, 2]
    measurement["compartments"] = {}
    for name, count, mean in [("cell", 2, 5), ("nuclear", 1, 8), ("cytoplasm", 1, 2)]:
        measurement["compartments"][name] = {
            "measure_kind": "area",
            "measure_unit": "pixel^2",
            "voxel_count": count,
            "measure": count,
            "intensity": {
                "raw X": {
                    "count": count,
                    "mean": mean,
                    "sum": count * mean,
                    "min": mean,
                    "max": mean,
                    "std_population": 0,
                }
            },
        }
    gate = rectangle(
        [7, 9, 1, 3], x_metric=f"compartment:nuclear:{X}", y_metric=f"compartment:cytoplasm:{X}"
    )
    receipt = evaluate_gate([measurement], gate, BINDING)
    assert receipt["labels"] == [1]
    assert receipt["gate"]["x_descriptor"]["unit"] == "source-intensity"
    assert receipt["gate"]["x_descriptor"]["compartment"] == "nuclear"


@pytest.mark.parametrize("kind", ["rectangle", "polygon"])
def test_full_100000_population_is_bounded_and_evaluates_every_row(capsys, kind):
    gate = (
        rectangle([99998, 100000, 99998, 100000])
        if kind == "rectangle"
        else polygon([[99998, 99998], [100000, 99998], [100000, 100000], [99998, 100000]])
    )
    started = time.perf_counter()
    response = evaluate_gate((row(i, i, i) for i in range(1, 100001)), gate, BINDING)
    elapsed = time.perf_counter() - started
    assert response["total_count"] == 100000
    assert response["labels"] == [99998, 99999, 100000]
    print(f"100000-object complete gate: {elapsed:.3f}s")
    # This is a bounded performance smoke check, not a statistical benchmark.
    assert elapsed < 20
    assert "100000-object complete gate:" in capsys.readouterr().out
    with pytest.raises(ValueError, match="100000"):
        evaluate_gate((row(i, i, i) for i in range(1, 100002)), rectangle(), BINDING)


def published(tmp_path, *, schema=1):
    project = ResearchProject.create(
        tmp_path / "groups.loci-study", "Groups", schema_version=schema
    )
    workbench = Workbench(project)
    labels = np.array([[1, 0, 7], [0, 0, 0], [42, 0, 90000]], dtype=np.uint32)
    image = np.array([[1, 0, 2], [0, 0, 0], [3, 0, 4]], dtype=np.uint16)
    path = tmp_path / "source.tif"
    tifffile.imwrite(path, image, metadata={"axes": "YX"})
    source = workbench.import_native(str(path))
    geometry = Geometry(
        "YX", ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)), "pixel", "image"
    )
    rows = measure_objects(labels, geometry, {"raw X": image, "raw Y": image})
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
        from loci_engine.research_annotations import label_array_sha256
        from loci_engine.research_tiled_store import ObjectTableWriter, TiledArrayWriter

        arrays = {}
        for name, values in [("image", image), ("labels", labels)]:
            writer = TiledArrayWriter(project, values.shape, values.dtype, 32)
            writer.write(0, 0, values)
            arrays[name] = writer.finish()
        with ObjectTableWriter(project) as writer:
            for measurement in rows:
                writer.append(measurement)
            table = writer.finalize()
        result = project.save_tiled_result(
            source_id=source["id"],
            kind="segmentation",
            arrays=arrays,
            provenance=provenance,
            object_table=table,
            label_sha256=label_array_sha256(labels),
        )
    return workbench, result, path


def binding(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def save(project, result, gate, name="Named"):
    receipt = dispatch_group(project, "population_gate_evaluate", {**binding(result), "gate": gate})
    return dispatch_group(
        project,
        "population_group_save",
        {
            **binding(result),
            "gate": receipt["gate"],
            "name": name,
            "membership_sha256": receipt["membership_sha256"],
        },
    )


@pytest.mark.parametrize("schema", [1, 2])
def test_real_document_cold_reopen_preserves_exact_sparse_labels_centroids_and_receipt(
    tmp_path, schema
):
    workbench, result, _ = published(tmp_path, schema=schema)
    group = save(workbench, result, rectangle([2, 3, 2, 3]))
    assert group["data"]["receipt"]["labels"] == [7, 42]
    assert group["revision"] == 1
    reopened = ResearchProject(workbench.project.root)
    response = dispatch_group(
        reopened,
        "population_group_get",
        {
            "group_id": group["id"],
            **binding(result),
            "include_centroids": True,
        },
    )
    assert response["group"] == group
    assert response["membership"]["centroids"] == [
        {"label": 7, "centroid_index": [0, 2], "index_axes": "YX"},
        {"label": 42, "centroid_index": [2, 0], "index_axes": "YX"},
    ]
    listed = dispatch_group(reopened, "population_group_list", binding(result))["groups"]
    assert [item["id"] for item in listed] == [group["id"]]


def test_save_stale_receipt_revision_source_and_descriptor_fail_closed(tmp_path):
    workbench, result, path = published(tmp_path)
    request = {**binding(result), "gate": rectangle()}
    with pytest.raises(ValueError, match="exact result revision"):
        dispatch_group(
            workbench, "population_gate_evaluate", {**request, "revision_hash": "f" * 64}
        )
    with pytest.raises(ValueError, match="membership changed"):
        dispatch_group(
            workbench,
            "population_group_save",
            {
                **request,
                "name": "bad",
                "membership_sha256": "0" * 64,
            },
        )
    group = save(workbench, result, rectangle())
    with pytest.raises(ValueError, match="another exact result revision"):
        dispatch_group(
            workbench,
            "population_group_get",
            {
                "group_id": group["id"],
                "revision_hash": "f" * 64,
            },
        )
    with pytest.raises(ValueError, match="exact result revision"):
        dispatch_group(
            workbench,
            "population_group_list",
            {
                **binding(result),
                "revision_hash": "f" * 64,
            },
        )
    gate = copy.deepcopy(group["data"]["definition"]["gate"])
    gate["x_descriptor"]["unit"] = "invented"
    with pytest.raises(ValueError, match="units are incompatible"):
        dispatch_group(workbench, "population_gate_evaluate", {**binding(result), "gate": gate})
    path.write_bytes(path.read_bytes() + b"changed")
    with pytest.raises(ValueError):
        dispatch_group(workbench, "population_group_get", {"group_id": group["id"]})


def rewrite_document(project, group, mutate, *, rehash=False):
    group = copy.deepcopy(group)
    mutate(group)
    if rehash:
        data = group["data"]
        data["record_sha256"] = hashlib.sha256(
            canonical_json(
                {key: value for key, value in data.items() if key != "record_sha256"}
            ).encode()
        ).hexdigest()
    with project.connection() as connection:
        connection.execute(
            "UPDATE documents SET record=? WHERE kind=? AND id=?",
            (canonical_json(group), DOCUMENT_KIND, group["id"]),
        )
    return group


@pytest.mark.parametrize("rehash", [False, True])
def test_tampered_membership_rejected_even_with_recomputed_membership_and_record_hash(
    tmp_path, rehash
):
    workbench, result, _ = published(tmp_path)
    group = save(workbench, result, rectangle([1, 2, 1, 2]))

    def tamper(document):
        receipt = document["data"]["receipt"]
        receipt["labels"] = [42, 90000]
        receipt["membership_sha256"] = hashlib.sha256(
            canonical_json(
                {
                    **{key: receipt[key] for key in BINDING},
                    "labels": receipt["labels"],
                }
            ).encode()
        ).hexdigest()

    rewrite_document(workbench.project, group, tamper, rehash=rehash)
    for operation, request in [
        ("population_group_get", {"group_id": group["id"]}),
        ("population_group_list", {}),
    ]:
        with pytest.raises(ValueError, match="integrity|not reproducible"):
            dispatch_group(ResearchProject(workbench.project.root), operation, request)


def test_fixed_group_cannot_migrate_labels_but_gate_application_creates_new_membership(tmp_path):
    workbench, result, _ = published(tmp_path)
    group = save(workbench, result, rectangle([1, 2, 1, 2]))
    parent = workbench.project.result(result["id"])
    labels = workbench.project.load_array(parent["arrays"]["labels"]).copy()
    image = workbench.project.load_array(parent["arrays"]["image"])
    labels[labels == 1], labels[labels == 7] = 19, 81
    geometry = Geometry(**parent["provenance"]["geometry"])
    rows = measure_objects(labels, geometry, {"raw X": image, "raw Y": image})
    child = workbench.project.save_result(
        source_id=result["source_id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        parent_id=result["id"],
        provenance={**parent["provenance"], "measurements": rows},
    )
    assert dispatch_group(workbench, "population_group_list", binding(child))["groups"] == []
    with pytest.raises(ValueError, match="another exact result"):
        dispatch_group(
            workbench, "population_group_get", {"group_id": group["id"], **binding(child)}
        )
    applied = dispatch_group(
        workbench,
        "population_gate_apply",
        {
            "group_id": group["id"],
            **binding(child),
            "name": "New revision",
        },
    )
    assert applied["id"] != group["id"]
    assert applied["data"]["receipt"]["labels"] == [19, 81]
    original = dispatch_group(workbench, "population_group_get", {"group_id": group["id"]})
    assert original["membership"]["labels"] == [1, 7]
    assert (
        original["membership"]["membership_sha256"]
        != applied["data"]["receipt"]["membership_sha256"]
    )


def test_overlapping_union_intersection_and_unclassified_are_exact_and_persisted(tmp_path):
    workbench, result, _ = published(tmp_path)
    left = save(workbench, result, rectangle([1, 3, 1, 3]), "Left")
    right = save(workbench, result, rectangle([2, 4, 2, 4]), "Right")
    for mode, expected in [
        ("union", [1, 7, 42, 90000]),
        ("intersection", [7, 42]),
        ("unclassified", []),
    ]:
        group = dispatch_group(
            workbench,
            "population_group_combine",
            {
                **binding(result),
                "group_ids": [left["id"], right["id"]],
                "mode": mode,
                "name": mode,
            },
        )
        assert group["data"]["receipt"]["labels"] == expected
        assert (
            dispatch_group(
                ResearchProject(workbench.project.root),
                "population_group_get",
                {"group_id": group["id"]},
            )["membership"]["labels"]
            == expected
        )
    rest = dispatch_group(
        workbench,
        "population_group_combine",
        {
            **binding(result),
            "group_ids": [left["id"]],
            "mode": "unclassified",
            "name": "Rest",
        },
    )
    assert rest["data"]["receipt"]["labels"] == [90000]
    all_objects = dispatch_group(
        workbench,
        "population_group_combine",
        {
            **binding(result),
            "group_ids": [],
            "mode": "unclassified",
            "name": "All",
        },
    )
    assert all_objects["data"]["receipt"]["labels"] == [1, 7, 42, 90000]
    with pytest.raises(ValueError, match="1-32"):
        dispatch_group(
            workbench,
            "population_group_combine",
            {
                **binding(result),
                "group_ids": [left["id"]] * 33,
                "mode": "union",
                "name": "bad",
            },
        )


def test_save_publication_guard_failure_is_atomic(tmp_path):
    workbench, result, _ = published(tmp_path)
    receipt = dispatch_group(
        workbench, "population_gate_evaluate", {**binding(result), "gate": rectangle()}
    )
    calls = 0

    def guard():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ValueError("Publication denied")

    with pytest.raises(ValueError, match="Publication denied"):
        dispatch_group(
            workbench,
            "population_group_save",
            {
                **binding(result),
                "gate": rectangle(),
                "name": "Atomic",
                "membership_sha256": receipt["membership_sha256"],
            },
            publication_guard=guard,
        )
    assert calls == 2
    assert workbench.project.documents(DOCUMENT_KIND) == []


def test_portable_validator_recomputes_membership_and_requires_exact_crossrefs(tmp_path):
    workbench, result, _ = published(tmp_path)
    group = save(workbench, result, rectangle([1, 2, 1, 2]))
    project = workbench.project
    sources = {item["id"]: item for item in project.list_sources()}
    results = {item["id"]: item for item in project.list_results()}
    validate_group_document(group, sources, results, [group])
    wrong = copy.deepcopy(group)
    wrong["data"]["receipt"]["gate"]["bounds"] = [0, 99, 0, 99]
    wrong["data"]["record_sha256"] = hashlib.sha256(
        canonical_json(
            {key: value for key, value in wrong["data"].items() if key != "record_sha256"}
        ).encode()
    ).hexdigest()
    with pytest.raises(ValueError, match="not reproducible"):
        validate_group_document(wrong, sources, results, [wrong])
    with pytest.raises(ValueError, match="stale source"):
        validate_group_document(group, {}, results, [group])


def test_actual_portable_export_import_relink_and_cold_reopen_preserve_group_records(tmp_path):
    from loci_engine.research_interchange import (
        export_project,
        import_project,
        relink_interchanged_source,
    )

    workbench, result, source_path = published(tmp_path)
    left = save(workbench, result, rectangle([1, 2, 1, 2]), "Left")
    right = save(workbench, result, rectangle([2, 3, 2, 3]), "Right")
    combined = dispatch_group(
        workbench,
        "population_group_combine",
        {
            **binding(result),
            "name": "Combined",
            "mode": "union",
            "group_ids": [left["id"], right["id"]],
        },
    )
    archive = tmp_path / "groups.loci-study.zip"
    export_project(workbench.project, archive)
    restored = import_project(archive, tmp_path / "restored.loci-study")
    assert restored.documents(DOCUMENT_KIND) == sorted(
        [left, right, combined], key=lambda document: document["id"]
    )
    relink_interchanged_source(restored, result["source_id"], source_path)
    reopened = ResearchProject(restored.root)
    response = dispatch_group(
        reopened,
        "population_group_get",
        {
            "group_id": combined["id"],
            **binding(result),
        },
    )
    assert response["group"] == combined
    assert response["membership"]["labels"] == [1, 7, 42]


def test_group_combination_depth_is_bounded_before_document_publication(tmp_path, monkeypatch):
    import loci_engine.research_groups as groups_module

    workbench, result, _ = published(tmp_path)
    group = save(workbench, result, rectangle())
    monkeypatch.setattr(groups_module, "MAX_GROUP_DEPTH", 3)
    for depth in (2, 3):
        group = dispatch_group(
            workbench,
            "population_group_combine",
            {
                **binding(result),
                "mode": "union",
                "group_ids": [group["id"]],
                "name": f"Depth {depth}",
            },
        )
        assert dispatch_group(workbench, "population_group_get", {"group_id": group["id"]})[
            "membership"
        ]["labels"] == [1, 7, 42, 90000]
    with pytest.raises(ValueError, match="exceed 16 levels"):
        dispatch_group(
            workbench,
            "population_group_combine",
            {
                **binding(result),
                "mode": "union",
                "group_ids": [group["id"]],
                "name": "Too deep",
            },
        )
    assert len(workbench.project.documents(DOCUMENT_KIND)) == 3


def test_reusable_gate_refuses_changed_units_on_another_exact_result(tmp_path):
    workbench, result, _ = published(tmp_path)
    gate = rectangle([1, 1, 1, 4], x_metric="measure")
    group = save(workbench, result, gate)
    parent = workbench.project.result(result["id"])
    provenance = copy.deepcopy(parent["provenance"])
    for measurement in provenance["measurements"]:
        measurement["measure_unit"] = "um^2"
    target = workbench.project.save_result(
        source_id=result["source_id"],
        kind="segmentation",
        parent_id=result["id"],
        arrays={
            key: workbench.project.load_array(descriptor)
            for key, descriptor in parent["arrays"].items()
        },
        provenance=provenance,
    )
    with pytest.raises(ValueError, match="units are incompatible"):
        dispatch_group(
            workbench,
            "population_gate_apply",
            {
                **binding(target),
                "group_id": group["id"],
                "name": "Incompatible",
            },
        )
    assert len(workbench.project.documents(DOCUMENT_KIND)) == 1


def test_workbench_dispatch_is_bound_to_existing_population_operations(tmp_path):
    workbench, result, _ = published(tmp_path)
    receipt = workbench.execute(
        "population_gate_evaluate",
        {
            **binding(result),
            "gate": rectangle([1, 2, 1, 2]),
        },
    )
    group = workbench.execute(
        "population_group_save",
        {
            **binding(result),
            "gate": receipt["gate"],
            "membership_sha256": receipt["membership_sha256"],
            "name": "Workbench",
        },
    )
    assert workbench.execute("population_group_get", {"group_id": group["id"]})["membership"][
        "labels"
    ] == [1, 7]


def test_three_dimensional_centroids_preserve_zyx_index_order():
    measurement = row(42, 2, 3)
    measurement.update(
        {
            "measure_kind": "volume",
            "measure_unit": "voxel^3",
            "index_axes": "ZYX",
            "centroid_index": [2, 3, 4],
            "bbox_start": [2, 3, 4],
            "bbox_stop_exclusive": [3, 4, 5],
        }
    )
    response = evaluate_gate(
        [measurement], rectangle(), BINDING, shape=[3, 4, 5], include_centroids=True
    )
    assert response["centroids"] == [
        {"label": 42, "centroid_index": [2, 3, 4], "index_axes": "ZYX"},
    ]


def test_source_change_during_saved_membership_reproduction_is_rejected(tmp_path, monkeypatch):
    import loci_engine.research_groups as groups_module

    workbench, result, path = published(tmp_path)
    group = save(workbench, result, rectangle())
    evaluate = groups_module._evaluate

    def change_source_after_evaluation(*args, **kwargs):
        receipt = evaluate(*args, **kwargs)
        path.write_bytes(path.read_bytes() + b"changed during gate")
        return receipt

    monkeypatch.setattr(groups_module, "_evaluate", change_source_after_evaluation)
    with pytest.raises(ValueError):
        dispatch_group(workbench, "population_group_get", {"group_id": group["id"]})


def test_exact_group_and_gate_json_exports_keep_canonical_float_identity(tmp_path):
    import json

    workbench, result, _ = published(tmp_path)
    group = save(workbench, result, rectangle([2, 3, 2, 3]))
    exported = workbench.execute(
        "population_group_export", {**binding(result), "group_id": group["id"]}
    )
    assert exported["json"] == canonical_json(group)
    parsed = json.loads(exported["json"])
    data = parsed["data"]
    assert (
        data["record_sha256"]
        == hashlib.sha256(
            canonical_json(
                {key: value for key, value in data.items() if key != "record_sha256"}
            ).encode()
        ).hexdigest()
    )
    validate_group_document(
        parsed,
        {result["source_id"]: workbench.project.source(result["source_id"])},
        {result["id"]: workbench.project.result(result["id"])},
        [parsed],
    )
    receipt = group["data"]["receipt"]
    gate_export = workbench.execute(
        "population_gate_export",
        {
            **binding(result),
            "gate": receipt["gate"],
            "membership_sha256": receipt["membership_sha256"],
        },
    )
    assert json.loads(gate_export["json"]) == receipt
    with pytest.raises(ValueError, match="changed before exact export"):
        workbench.execute(
            "population_gate_export",
            {**binding(result), "gate": receipt["gate"], "membership_sha256": "0" * 64},
        )
    workbench.close()


def test_two_source_study_with_moved_source_preserves_intact_group_operations(tmp_path):
    project = ResearchProject.create(tmp_path / "groups.loci-study", "Two source groups")
    wb = Workbench(project)
    labels = np.array([[1, 0, 7], [0, 0, 0], [42, 0, 90000]], dtype=np.uint32)
    raw = np.array([[1, 0, 2], [0, 0, 0], [3, 0, 4]], dtype=np.uint16)
    geometry = Geometry.diagonal((1, 1), "pixel")
    metric = intensity_metric_id("raw", "mean")
    gate = {"kind": "rectangle", "x_metric": metric, "y_metric": metric, "bounds": [0, 10, 0, 10]}
    gate_small = {
        "kind": "rectangle",
        "x_metric": metric,
        "y_metric": metric,
        "bounds": [1, 2, 1, 2],
    }
    results, groups, paths = [], [], []
    for index in (1, 2):
        image = raw.copy()
        image[1, 1] = index
        path = tmp_path / f"source-{index}.tif"
        tifffile.imwrite(path, image, metadata={"axes": "YX"})
        source = wb.import_native(str(path))
        result = project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": image, "labels": labels},
            provenance={
                "geometry": geometry.to_dict(),
                "selection": {"t": 0, "c": 0, "z": 0},
                "recipe": {"threshold": 1},
                "runtime": {"engine": "synthetic-test"},
                "measurement_basis": "raw-selected-channel-values-on-result-grid",
                "measurements": measure_objects(labels, geometry, {"raw": image}),
            },
        )
        receipt = dispatch_group(wb, "population_gate_evaluate", {**binding(result), "gate": gate})
        group = dispatch_group(
            wb,
            "population_group_save",
            {
                **binding(result),
                "gate": receipt["gate"],
                "membership_sha256": receipt["membership_sha256"],
                "name": f"Source {index} All",
            },
        )
        if index == 2:
            receipt2 = dispatch_group(
                wb, "population_gate_evaluate", {**binding(result), "gate": gate_small}
            )
            group2 = dispatch_group(
                wb,
                "population_group_save",
                {
                    **binding(result),
                    "gate": receipt2["gate"],
                    "membership_sha256": receipt2["membership_sha256"],
                    "name": "Source 2 Small",
                },
            )
            groups.append(group2)
        results.append(result)
        groups.append(group)
        paths.append(path)

    paths[0].rename(tmp_path / "moved-source-1.tif")

    all_groups = dispatch_group(wb, "population_group_list", {})["groups"]
    assert len(all_groups) == 3
    source1_groups = [g for g in all_groups if g["name"] == "Source 1 All"]
    source2_groups = [g for g in all_groups if g["name"].startswith("Source 2")]
    assert len(source1_groups) == 1
    assert source1_groups[0]["source_available"] is False
    assert len(source2_groups) == 2
    assert all(g["source_available"] is True for g in source2_groups)

    s2_group = next(g for g in source2_groups if g["name"] == "Source 2 All")
    direct = dispatch_group(
        wb, "population_group_get", {"group_id": s2_group["id"], "include_centroids": True}
    )
    assert direct["membership"]["labels"] == [1, 7, 42, 90000]
    assert len(direct["membership"]["centroids"]) == 4

    s2_small = next(g for g in source2_groups if g["name"] == "Source 2 Small")
    combined = dispatch_group(
        wb,
        "population_group_combine",
        {
            **binding(results[1]),
            "name": "Combined S2",
            "mode": "intersection",
            "group_ids": [s2_group["id"], s2_small["id"]],
        },
    )
    assert combined["data"]["name"] == "Combined S2"
    assert combined["data"]["receipt"]["labels"] == [1, 7]

    exported = dispatch_group(
        wb, "population_group_export", {**binding(results[1]), "group_id": s2_group["id"]}
    )
    assert "json" in exported

    applied = dispatch_group(
        wb,
        "population_gate_apply",
        {
            **binding(results[1]),
            "group_id": source1_groups[0]["id"],
            "name": "Reused S1 Gate on S2",
        },
    )
    assert applied["data"]["name"] == "Reused S1 Gate on S2"
    assert applied["data"]["receipt"]["result_id"] == results[1]["id"]
    assert applied["data"]["receipt"]["labels"] == [1, 7, 42, 90000]

    with pytest.raises(FileNotFoundError):
        dispatch_group(wb, "population_group_get", {"group_id": source1_groups[0]["id"]})

    with pytest.raises(FileNotFoundError):
        dispatch_group(
            wb,
            "population_group_combine",
            {
                **binding(results[1]),
                "name": "Invalid combination",
                "mode": "union",
                "group_ids": [source1_groups[0]["id"], s2_group["id"]],
            },
        )
    wb.close()
