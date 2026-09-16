import csv
import io

import pytest

from loci_engine.study_analysis import (
    StudySampleMetadata,
    compare_runs,
    executed_methods_record,
    measurements_csv,
    methods_citation_text,
    summarize_measurements,
    validate_sample_metadata,
)


def record(rep, values, *, revision=1, source=None, result=None, **extra):
    return {
        "metadata": {
            "study": "S",
            "sample": "s1",
            "condition": "drug",
            "biological_replicate": rep,
        },
        "objects": [{"measure": value, "measure_unit": "um^2"} for value in values],
        "revision": revision,
        "source_id": source,
        "result_id": result,
        **extra,
    }


def test_metadata_requires_core_fields_but_missing_replicate_is_unassigned():
    metadata = validate_sample_metadata({"study": "S", "sample": "A", "condition": "control"})
    assert isinstance(metadata, StudySampleMetadata)
    assert metadata.biological_replicate is None
    with pytest.raises(ValueError):
        validate_sample_metadata({"study": "S", "sample": "A"})


def test_unequal_object_counts_use_image_then_replicate_means():
    rows = summarize_measurements(
        [
            record("r1", [2, 4, 6]),  # image mean 4
            record("r1", [8]),  # replicate mean (4 + 8) / 2 = 6
            record("r2", [10, 14]),  # replicate mean 12
        ]
    )
    summary = rows["summaries"][0]
    assert summary["mean"] == 9
    assert summary["n_biological_replicates"] == 2
    assert summary["n_objects"] == 6
    assert summary["n_images"] == 3


def test_missing_replicate_is_not_independent_n_and_revision_audit_survives_exclusion():
    result = summarize_measurements(
        [
            record(
                None, [100], revision=7, source="src0", result="res0", excluded=True, reviewed=True
            ),
            record("r1", [5], revision=8, source="src1", result="res1"),
        ]
    )
    assert result["summaries"][0]["mean"] == 5
    assert result["summaries"][0]["n_biological_replicates"] == 1
    assert result["record_audit"][0] == {
        "source_id": "src0",
        "result_id": "res0",
        "revision": 7,
        "excluded": True,
        "reviewed": True,
    }


def test_duplicate_units_methods_and_scopes_rejected():
    with pytest.raises(ValueError, match="Duplicate source"):
        summarize_measurements([record("r1", [1], source="same"), record("r2", [2], source="same")])
    with pytest.raises(ValueError, match="units"):
        summarize_measurements(
            [
                record("r1", [1]),
                {**record("r2", [2]), "objects": [{"measure": 2, "measure_unit": "um^3"}]},
            ]
        )
    with pytest.raises(ValueError, match="methods"):
        compare_runs([record("r1", [1], method="a")], [record("r1", [2], method="b")])
    with pytest.raises(ValueError, match="scopes"):
        compare_runs([record("r1", [1], run_scope="crop")], [record("r1", [2], run_scope="whole")])


def test_run_comparison_is_descriptive_and_has_no_object_p_values():
    result = compare_runs([record("r1", [1, 3])], [record("r1", [5])])
    assert result["comparisons"][0]["difference"] == 3
    assert result["p_values"] is None


def test_methods_receipt_and_formula_safe_csv():
    receipt = executed_methods_record(
        [{"op": "gaussian", "sigma": 2, "geometry": {"unit": "um"}, "runtime_id": "cpu"}]
    )
    assert "gaussian" in methods_citation_text(receipt)
    output = measurements_csv([{"label": "=SUM(A1:A2)", "note": 'a,"b\nc'}])
    parsed = list(csv.reader(io.StringIO(output)))
    assert parsed[1][0] == "'=SUM(A1:A2)"
    assert parsed[1][1] == 'a,"b\nc'


def test_multiple_samples_from_one_replicate_do_not_inflate_independent_n():
    first = record("animal-1", [2])
    second = record("animal-1", [8])
    second["metadata"]["sample"] = "another tissue from animal-1"
    third = record("animal-2", [11])
    result = summarize_measurements([first, second, third])
    summary = result["summaries"][0]
    assert summary["n_biological_replicates"] == 2
    assert summary["mean"] == 8  # animal 1 mean=5; animal 2 mean=11


def test_same_replicate_name_from_different_studies_is_not_pooled():
    first, second = record("r1", [2]), record("r1", [8])
    second["metadata"]["study"] = "another study"
    with pytest.raises(ValueError, match="Different studies"):
        summarize_measurements([first, second])
