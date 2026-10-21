"""Exact-value, relational and bounded-reader oracles for scientific CSV tables."""

from __future__ import annotations

import copy
import csv
import hashlib
import io
import json
from contextlib import contextmanager

import pytest

from loci_engine.research_data_tables import NULL, encode_cell, inspect_item, write_tables
from loci_engine.research_population import intensity_metric_id
from loci_engine.research_project import canonical_json


# Deliberately authored values, without recomputing measurements from an image.
def row(label=1, measure=1.0, channel="raw:µm"):
    return {
        "label": label,
        "voxel_count": 1,
        "measure": measure,
        "measure_kind": "area",
        "measure_unit": "um^2",
        "distance_unit": "um",
        "centroid_index": [0.0, 0.0],
        "index_axes": "YX",
        "centroid_world_xyz": [1e-200, -0.0, 0.0],
        "world_frame": "image",
        "bbox_start": [0, 0],
        "bbox_stop_exclusive": [1, 1],
        "principal_rms_radii": [0.0, 0.0, 0.0],
        "touches_crop_border": True,
        "nearest_centroid_distance": None,
        "intensity": {
            channel: {
                "mean": -0.0,
                "sum": -1e200,
                "min": -1e-200,
                "max": 1.0000000000000002,
                "std_population": 0.0,
            }
        },
    }


def item(rows=None, result_id="a" * 32, unit="um^2"):
    rows = [row()] if rows is None else copy.deepcopy(rows)
    for value in rows:
        value["measure_unit"] = unit
    return {
        "result": {
            "id": result_id,
            "revision_hash": "b" * 64,
            "source_id": "c" * 32,
            "source_sha256": "d" * 64,
            "schema": "loci.research-result/v1",
            "kind": "segmentation",
            "arrays": {"labels": {"shape": [1, 1]}},
            "provenance": {"measurements": rows, "geometry": {"axes": "YX"}, "selection": {"c": 0}},
        },
        "source": {"id": "c" * 32, "sha256": "d" * 64},
        "review": None,
        "sample": None,
        "groups": [],
        "selected_labels": None,
    }


class Streams:
    def __init__(self):
        self.data = {}

    @contextmanager
    def open(self, name):
        stream = io.StringIO(newline="")
        yield stream
        self.data[name] = stream.getvalue()

    def rows(self, name):
        return list(csv.DictReader(io.StringIO(self.data[name], newline="")))


def decode(value):
    if value == NULL:
        return None
    if value.startswith(("'", "\\\\")):
        return value[1:]
    return value


def test_full_precision_numeric_types_signed_zero_and_large_string_labels():
    original = row(0xFFFFFFFF, 1e-200)
    original["voxel_count"] = 1
    original["intensity"]["raw:µm"]["sum"] = -(2**53 + 1)
    value = item([original])
    inspection = inspect_item(None, value)
    assert inspection["preview"] == [
        {"label": "4294967295", "measure": "1e-200", "measure_unit": "um^2", "status": "value"}
    ]
    out = Streams()
    schema = write_tables(None, [value], out.open)
    rows = {r["metric_id"]: r for r in out.rows("measurements.csv")}
    assert rows[intensity_metric_id("raw:µm", "sum")]["value"] == "-9007199254740993"
    assert rows[intensity_metric_id("raw:µm", "sum")]["raw_numeric_type"] == "integer"
    assert rows[intensity_metric_id("raw:µm", "mean")]["value"] == "-0.0"
    assert rows[intensity_metric_id("raw:µm", "max")]["value"] == "1.0000000000000002"
    assert out.rows("objects.csv")[0]["centroid_world_y"] == "-0.0"
    assert (
        next(f for f in schema["objects.csv"]["fields"] if f["name"] == "label")["type"] == "string"
    )
    raw = json.loads(out.data["object-records.jsonl"])
    assert canonical_json(raw["object"]) == canonical_json(original)


def test_explicit_null_zero_and_absent_are_distinct():
    a, b, c = row(1), row(2), row(3)
    a["nearest_centroid_distance"] = None
    b["nearest_centroid_distance"] = 0.0
    del c["nearest_centroid_distance"]
    out = Streams()
    write_tables(None, [item([a, b, c])], out.open)
    rows = [
        r for r in out.rows("measurements.csv") if r["metric_id"] == "nearest_centroid_distance"
    ]
    assert [(r["status"], r["value"], r["raw_numeric_type"]) for r in rows] == [
        ("null", NULL, NULL),
        ("value", "0.0", "float"),
        ("missing", NULL, NULL),
    ]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_is_rejected_even_in_unknown_metadata(bad):
    original = row()
    original["unknown"] = {"nested": [bad]}
    with pytest.raises(ValueError, match="non-finite"):
        inspect_item(None, item([original]))


@pytest.mark.parametrize(
    "text",
    [
        "=SUM(A1:A2)",
        " \t+calc",
        "-text",
        "@x",
        "'literal",
        "''two",
        r"\N",
        r"\\foo",
        "",
        'µm,"quotes"\nand lines',
    ],
)
def test_text_encoding_is_reversible_and_csv_quote_safe(text):
    encoded = encode_cell(text)
    assert decode(encoded) == text
    out = io.StringIO(newline="")
    csv.writer(out).writerow([encoded])
    assert decode(next(csv.reader(io.StringIO(out.getvalue(), newline="")))[0]) == text
    assert encode_cell(-2.5) == "-2.5"
    assert decode(encode_cell(None)) is None


def test_compartment_channels_collisions_and_empty_semantics():
    original = row()
    names = ["raw:a:mean", "raw:a", 'DNA µm\n"quoted"']
    original["intensity"] = {name: {"mean": i + 0.5} for i, name in enumerate(names)}

    def compartment(count):
        return {
            "voxel_count": count,
            "measure": float(count),
            "measure_kind": "area",
            "measure_unit": "um^2",
            "intensity": {
                name: {
                    "count": count,
                    "sum": float(count),
                    "mean": 1.0 if count else None,
                    "min": 1.0 if count else None,
                    "max": 1.0 if count else None,
                    "std_population": 0.0 if count else None,
                }
                for name in names
            },
        }

    original["compartments"] = {
        "cell": compartment(1),
        "nuclear": compartment(0),
        "cytoplasm": compartment(1),
    }
    out = Streams()
    write_tables(None, [item([original])], out.open)
    measurements = out.rows("measurements.csv")
    identities = [r["metric_id"] for r in measurements]
    assert len(identities) == len(set(identities))
    nuclear = [r for r in measurements if r["compartment"] == "nuclear"]
    assert len(nuclear) == 20
    assert all(
        r["status"] == "null"
        for r in nuclear
        if r["statistic"] in {"mean", "min", "max", "std_population"}
    )
    assert all(r["value"] in {"0", "0.0"} for r in nuclear if r["statistic"] in {"count", "sum"})
    assert {decode(r["channel"]) for r in measurements if r["channel"] != NULL} == set(names)


def group(group_id, labels, value):
    result = value["result"]
    return {
        "id": group_id,
        "data": {
            "name": '=named µm\n"group"',
            "record_sha256": "e" * 64,
            "definition": {"kind": "gate"},
            "receipt": {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "labels": labels,
                "membership_sha256": "f" * 64,
                "total_count": 350,
                "included_count": len(labels),
            },
        },
    }


def test_all_overlap_memberships_and_subset_beyond_plot_sample():
    value = item([row(label) for label in range(1, 351)])
    value["selected_labels"] = list(range(151, 351))
    value["groups"] = [
        group("g1", list(range(1, 301)), value),
        group("g2", list(range(201, 351)), value),
    ]
    expected = inspect_item(None, value)
    out = Streams()
    tables = write_tables(None, [value], out.open)
    assert expected["total_count"] == 350 and expected["selected_count"] == 200
    assert tables["objects.csv"]["row_count"] == 200
    memberships = out.rows("memberships.csv")
    assert len(memberships) == 300
    assert {r["group_id"] for r in memberships if r["label"] == "250"} == {"g1", "g2"}
    assert all(151 <= int(r["label"]) <= 350 for r in memberships)
    assert len(out.data["object-records.jsonl"].splitlines()) == 200
    assert len(expected["preview"]) == 5
    subset = copy.deepcopy(value)
    subset["selected_labels"] = [350]
    assert inspect_item(None, subset)["row_sha256"] == expected["row_sha256"]
    value["selected_labels"] = [999]
    with pytest.raises(ValueError, match="absent"):
        inspect_item(None, value)


def test_empty_fixed_schemas_and_mixed_unit_results_without_pooling():
    out = Streams()
    tables = write_tables(None, [item([])], out.open)
    assert tables["objects.csv"]["row_count"] == 0
    assert tables["measurements.csv"]["fields"]
    assert out.rows("objects.csv") == []
    mixed = [item([row()], "z" * 32, "pixel^2"), item([row()], "a" * 32, "um^2")]
    out = Streams()
    write_tables(None, mixed, out.open)
    assert [r["measure_unit"] for r in out.rows("objects.csv")] == ["um^2", "pixel^2"]
    corrupt = item([row(), row(2)])
    corrupt["result"]["provenance"]["measurements"][1]["measure_unit"] = "pixel^2"
    with pytest.raises(ValueError, match="incompatible"):
        inspect_item(None, corrupt)


def test_sample_declarations_preserve_unicode_text_and_null_replicate():
    value = item()
    value["sample"] = {
        "id": value["source"]["id"],
        "kind": "sample",
        "revision": 7,
        "updated_at": "now",
        "data": {
            "study": "Declared",
            "sample": "=sample\nµm",
            "condition": "'condition",
            "biological_replicate": None,
            "plate": r"\N",
            "well": "A1",
        },
    }
    out = Streams()
    write_tables(None, [value], out.open)
    sample = out.rows("samples.csv")[0]
    assert sample["document_revision"] == "7"
    assert decode(sample["sample"]) == "=sample\nµm"
    assert decode(sample["condition"]) == "'condition"
    assert decode(sample["biological_replicate"]) is None
    assert decode(sample["plate"]) == r"\N"


def test_hash_all_original_rows_stable_order_and_detects_unknown_change():
    rows = [row(2), row(1)]
    value = item(rows)
    expected = hashlib.sha256()
    for original in sorted(rows, key=lambda r: r["label"]):
        expected.update(
            (
                canonical_json(
                    {
                        "result_id": value["result"]["id"],
                        "revision_hash": value["result"]["revision_hash"],
                        "object": original,
                    }
                )
                + "\n"
            ).encode()
        )
    assert inspect_item(None, value)["row_sha256"] == expected.hexdigest()
    value["result"]["provenance"]["measurements"][0]["unknown"] = "kept verbatim"
    assert inspect_item(None, value)["row_sha256"] != expected.hexdigest()


def test_v2_uses_full_bounded_iterator_without_array_access(monkeypatch):
    from loci_engine import research_tiled_store

    value = item([])
    result = value["result"]
    result.update(schema="loci.research-result/v2", object_count=1001, object_table={"count": 1001})
    del result["provenance"]["measurements"]
    calls = []

    def iterate(project, descriptor, check=None):
        calls.append(descriptor)
        for label in range(1, 1002):
            yield row(label)

    monkeypatch.setattr(research_tiled_store, "iter_object_rows", iterate)

    class NoArrays:
        def load_array(self, *_args):
            pytest.fail("measurement export decoded an array")

    out = Streams()
    tables = write_tables(NoArrays(), [value], out.open)
    assert tables["objects.csv"]["row_count"] == 1001
    assert len(calls) == 2
    assert out.rows("objects.csv")[-1]["label"] == "1001"


def test_real_sqlite_v2_table_export_preserves_sparse_labels_and_null(tmp_path, monkeypatch):
    from loci_engine.research_project import ResearchProject
    from loci_engine.research_tiled_store import ObjectTableWriter

    project = ResearchProject.create(tmp_path / "exact.loci-study", "Exact", schema_version=2)
    originals = [row(0xFFFFFFFF, 1e-200), row(70000, 2.0000000000000004)]
    with ObjectTableWriter(project) as writer:
        for original in originals:
            writer.append(original)
        descriptor = writer.finalize()
    value = item([])
    value["result"].update(
        schema="loci.research-result/v2", object_count=2, object_table=descriptor
    )
    del value["result"]["provenance"]["measurements"]

    def forbidden(*_args, **_kwargs):
        pytest.fail("existing stored measurements must not decode a result array")

    monkeypatch.setattr(project, "load_array", forbidden)
    monkeypatch.setattr(project, "verify_array", forbidden)
    out = Streams()
    metadata = write_tables(project, [value], out.open)
    assert metadata["objects.csv"]["row_count"] == 2
    assert [r["label"] for r in out.rows("objects.csv")] == ["70000", "4294967295"]
    assert [r["measure"] for r in out.rows("objects.csv")] == ["2.0000000000000004", "1e-200"]
    assert all(
        r["status"] == "null"
        for r in out.rows("measurements.csv")
        if r["metric_id"] == "nearest_centroid_distance"
    )


@pytest.mark.parametrize(
    "extension",
    [
        {"source_path": "anything"},
        {"nested": {"private_path": "anything"}},
        {"api_key": "credential"},
        {"password": "hidden"},
        {"ssh_settings": {}},
        {"metadata": ["/Users/researcher/private/image.tif"]},
        {"metadata": [r"C:\\private\\image.tif"]},
        {"metadata": ["file:///private/image.tif"]},
        {"/private/key": 3},
    ],
)
def test_private_metadata_and_absolute_locators_fail_closed(extension):
    original = row()
    original["extension"] = extension
    with pytest.raises(ValueError, match="private|absolute"):
        inspect_item(None, item([original]))


def test_benign_unknown_scientific_extensions_remain_exact():
    original = row()
    original["extension"] = {
        "key": "scientific",
        "signed": -(2**55) - 1,
        "tiny": 1e-200,
        "unknown_null": None,
        "zero": -0.0,
    }
    out = Streams()
    write_tables(None, [item([original])], out.open)
    raw = json.loads(out.data["object-records.jsonl"])
    assert canonical_json(raw["object"]["extension"]) == canonical_json(original["extension"])


def test_zyx_indices_and_xyz_world_coordinates_keep_distinct_axes():
    original = row(70000, 3.5)
    original.update(
        measure_kind="volume",
        measure_unit="um^3",
        index_axes="ZYX",
        centroid_index=[1.25, 2.0, 3.0],
        centroid_world_xyz=[30.0, 20.0, 12.5],
        bbox_start=[1, 2, 3],
        bbox_stop_exclusive=[2, 3, 4],
    )
    value = item([original], unit="um^3")
    value["result"]["arrays"]["labels"]["shape"] = [3, 4, 5]
    out = Streams()
    write_tables(None, [value], out.open)
    exported = out.rows("objects.csv")[0]
    assert (
        exported["centroid_index_z"],
        exported["centroid_index_y"],
        exported["centroid_index_x"],
    ) == ("1.25", "2.0", "3.0")
    assert (
        exported["centroid_world_x"],
        exported["centroid_world_y"],
        exported["centroid_world_z"],
    ) == ("30.0", "20.0", "12.5")
    assert exported["bbox_start_z"] == "1"
    assert exported["bbox_stop_exclusive_x"] == "4"
    summed = next(r for r in out.rows("measurements.csv") if r["statistic"] == "sum")
    assert summed["unit"] == "source-intensity*voxel"


def test_cancel_during_large_table_writing_stops_iteration():
    value = item([row(label) for label in range(1, 401)])
    calls = 0

    def cancel():
        nonlocal calls
        calls += 1
        if calls > 3:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        write_tables(None, [value], Streams().open, check=cancel)


def test_channel_union_is_bounded_across_complete_population():
    value = item([row(label + 1, channel=f"channel-{label}") for label in range(33)])
    with pytest.raises(ValueError, match="32 distinct channels"):
        inspect_item(None, value)


def test_principal_radii_normalized_as_exact_recorded_distance_metrics():
    original = row(70000)
    original["principal_rms_radii"] = [2**53 + 1, 1.0000000000000002, -0.0]
    original["distance_unit"] = "nm"
    value = item([original])
    out = Streams()
    inspection = inspect_item(None, value)
    metadata = write_tables(None, [value], out.open)
    radii = [
        r
        for r in out.rows("measurements.csv")
        if r["metric_id"].startswith("principal_rms_radius:")
    ]
    assert [r["metric_id"] for r in radii] == [
        "principal_rms_radius:1",
        "principal_rms_radius:2",
        "principal_rms_radius:3",
    ]
    assert [r["value"] for r in radii] == ["9007199254740993", "1.0000000000000002", "-0.0"]
    assert [r["raw_numeric_type"] for r in radii] == ["integer", "float", "float"]
    assert all(r["unit"] == "nm" and r["kind"] == "distance" for r in radii)
    assert all(r["status"] == "value" for r in radii)
    assert inspection["measurement_count"] == metadata["measurements.csv"]["row_count"]
    raw = json.loads(out.data["object-records.jsonl"])
    assert canonical_json(raw["object"]["principal_rms_radii"]) == canonical_json(
        original["principal_rms_radii"]
    )


def test_absent_optional_spatial_fields_remain_absent_without_inference():
    absent = row(1)
    del absent["principal_rms_radii"]
    del absent["centroid_world_xyz"]
    value = item([absent])
    assert not any(
        d["id"].startswith("principal_rms_radius:")
        for d in inspect_item(None, value)["descriptors"]
    )
    out = Streams()
    write_tables(None, [value], out.open)
    raw = json.loads(out.data["object-records.jsonl"])["object"]
    assert "principal_rms_radii" not in raw and "centroid_world_xyz" not in raw
    assert out.rows("objects.csv")[0]["centroid_world_x"] == NULL
    present = row(2)
    mixed = item([absent, present])
    out = Streams()
    write_tables(None, [mixed], out.open)
    missing = [
        r
        for r in out.rows("measurements.csv")
        if r["label"] == "1" and r["metric_id"].startswith("principal_rms_radius:")
    ]
    assert len(missing) == 3
    assert all(r["status"] == "missing" and r["value"] == NULL for r in missing)


@pytest.mark.parametrize(
    "field,bad",
    [
        ("centroid_world_xyz", None),
        ("centroid_world_xyz", [1, 2]),
        ("centroid_world_xyz", [1, 2, 3, 4]),
        ("centroid_world_xyz", [True, 0, 0]),
        ("centroid_world_xyz", ["1", 0, 0]),
        ("centroid_world_xyz", [float("nan"), 0, 0]),
        ("principal_rms_radii", None),
        ("principal_rms_radii", [1, 2]),
        ("principal_rms_radii", [1, 2, 3, 4]),
        ("principal_rms_radii", [False, 0, 0]),
        ("principal_rms_radii", [None, 0, 0]),
        ("principal_rms_radii", [-1e-200, 0, 0]),
        ("principal_rms_radii", [float("inf"), 0, 0]),
    ],
)
def test_malformed_optional_spatial_fields_fail_during_inspect(field, bad):
    original = row()
    original[field] = bad
    with pytest.raises(ValueError, match="numeric|three|nonnegative|finite"):
        inspect_item(None, item([original]))


def test_principal_radii_require_their_recorded_unit_and_allow_signed_centroids():
    original = row()
    original["centroid_world_xyz"] = [-1e200, -0.0, 1e-200]
    assert inspect_item(None, item([original]))["total_count"] == 1
    # Nearest-distance validation otherwise requires this same unit, so remove it
    # to isolate the optional-radius validation oracle.
    del original["nearest_centroid_distance"]
    del original["distance_unit"]
    with pytest.raises(ValueError, match="recorded distance unit"):
        inspect_item(None, item([original]))


def test_compact_v1_snapshot_rereads_one_authoritative_result_per_pass():
    full = item([row(70000, 1e-200), row(0xFFFFFFFF, 1.0000000000000002)])
    full["selected_labels"] = [0xFFFFFFFF]
    compact = copy.deepcopy(full)
    del compact["result"]["provenance"]["measurements"]
    calls = []

    class Authority:
        def result(self, result_id, *, check=None):
            calls.append(result_id)
            if check is not None:
                check()
            return copy.deepcopy(full["result"])

        def load_array(self, *_args, **_kwargs):
            pytest.fail("compact measurement export must not decode arrays")

    checks = []

    def check():
        checks.append(True)

    project = Authority()
    assert inspect_item(project, compact, check) == inspect_item(None, full, check)
    # The snapshot remains compact after each pass; no raw rows are cached on it.
    assert "measurements" not in compact["result"]["provenance"]
    expected, actual = Streams(), Streams()
    expected_metadata = write_tables(None, [full], expected.open)
    actual_metadata = write_tables(project, [compact], actual.open, check=check)
    assert actual_metadata == expected_metadata
    assert actual.data == expected.data
    assert calls == [full["result"]["id"]] * 3  # inspect plus two write passes
    assert checks
    assert "measurements" not in compact["result"]["provenance"]


@pytest.mark.parametrize(
    "field,replacement",
    [
        ("revision_hash", "0" * 64),
        ("source_id", "0" * 32),
        ("source_sha256", "0" * 64),
        ("schema", "loci.research-result/v2"),
    ],
)
def test_compact_v1_snapshot_rejects_changed_authoritative_binding(field, replacement):
    full = item()
    compact = copy.deepcopy(full)
    del compact["result"]["provenance"]["measurements"]
    actual = copy.deepcopy(full["result"])
    actual[field] = replacement

    class Authority:
        def result(self, result_id, *, check=None):
            return actual

    with pytest.raises(ValueError, match="stale result/source binding"):
        inspect_item(Authority(), compact)


def test_compact_v1_snapshot_rejects_missing_authoritative_measurements():
    compact = item([])
    del compact["result"]["provenance"]["measurements"]

    class Authority:
        def result(self, result_id, *, check=None):
            return compact["result"]

    with pytest.raises(ValueError, match="stored measurements"):
        inspect_item(Authority(), compact)


def test_explicitly_invalid_v1_measurements_are_not_replaced_by_authority():
    invalid = item()
    invalid["result"]["provenance"]["measurements"] = None

    class Authority:
        def result(self, *_args, **_kwargs):
            pytest.fail("present invalid data must fail rather than be replaced")

    with pytest.raises(ValueError, match="stored measurements"):
        inspect_item(Authority(), invalid)
