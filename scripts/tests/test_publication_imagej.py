"""Fail-closed evidence checker tests; installed ImageJ is exercised by opt-in runner."""

from __future__ import annotations

import csv
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from scripts import publication_imagej as comparator


def outputs(tmp_path, case):
    measurements, labels = tmp_path / "measurements.csv", tmp_path / "labels.csv"
    with measurements.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=comparator.FIELDS)
        writer.writeheader()
        writer.writerows(case["rows"])
    np.savetxt(labels, case["labels"], fmt="%d", delimiter=",")
    return measurements, labels


def test_authored_cases_preserve_topology_and_independent_uint16_expectations():
    cases = {case["name"]: case for case in comparator.authored_cases()}
    assert len(cases) == 14
    assert sum(len(case["rows"]) * 8 for case in cases.values()) == 200
    assert len(cases["topology"]["rows"]) == 5
    assert cases["ring"]["rows"][0]["area_um2"] == 2
    assert cases["ring-above-minimum"]["rows"] == []
    assert len(cases["nested-island"]["rows"]) == 2
    assert cases["uint16-variable"]["rows"][0]["raw_sum"] == 131069
    np.testing.assert_array_equal(cases["thin-diagonal"]["labels"], [[1, 0], [0, 2]])
    np.testing.assert_array_equal(
        cases["filter-and-label-compaction"]["labels"],
        [[0, 0, 1, 1], [0, 0, 0, 0], [2, 2, 2, 0]],
    )


@pytest.mark.parametrize("case", comparator.authored_cases(), ids=lambda c: c["name"])
def test_checker_accepts_authored_labels_and_both_centroid_conventions(tmp_path, case):
    paths = outputs(tmp_path, case)
    assert comparator.check_outputs(*paths, case) == len(case["rows"]) * 10


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "200.1"])
def test_checker_rejects_nonfinite_or_numeric_mismatch(tmp_path, value):
    case = next(c for c in comparator.authored_cases() if c["name"] == "all-foreground")
    paths = outputs(tmp_path, case)
    text = paths[0].read_text().replace("200.0", value).replace(",200,", f",{value},")
    paths[0].write_text(text)
    with pytest.raises(ValueError):
        comparator.check_outputs(*paths, case)


@pytest.mark.parametrize(
    "matrix",
    [
        "1,0\n0,1\n",
        "1,0\n0,4294967298\n",
        "1,0\n0,-4294967294\n",
        "1,0\n0,2.0\n",
        "1,0,0\n0,2,0\n",
    ],
)
def test_checker_rejects_wrong_labels_overflow_rounding_and_grid(tmp_path, matrix):
    case = next(c for c in comparator.authored_cases() if c["name"] == "thin-diagonal")
    paths = outputs(tmp_path, case)
    paths[1].write_text(matrix)
    with pytest.raises(ValueError):
        comparator.check_outputs(*paths, case)


def test_checker_requires_exact_row_label_and_schema(tmp_path):
    case = next(c for c in comparator.authored_cases() if c["name"] == "single-pixel")
    paths = outputs(tmp_path, case)
    paths[0].write_text(paths[0].read_text().replace("\n1,", "\n1.000000000001,"))
    with pytest.raises(ValueError, match="Inexact row label"):
        comparator.check_outputs(*paths, case)
    outputs(tmp_path, case)
    paths[0].write_text(paths[0].read_text().replace("imagej_x_um", "x_um"))
    with pytest.raises(ValueError, match="schema"):
        comparator.check_outputs(*paths, case)


@pytest.mark.parametrize("missing", ["java", "jar"])
def test_missing_runtime_is_nonzero_and_retains_failed_receipt(tmp_path, missing):
    output = tmp_path / "evidence"
    result = subprocess.run(
        [
            sys.executable,
            str(Path(comparator.__file__)),
            "--output",
            str(output),
            "--java",
            str(tmp_path / "absent-java") if missing == "java" else sys.executable,
            "--ij-jar",
            str(tmp_path / "absent.jar"),
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode != 0
    receipt = json.loads((output / "receipt.json").read_text())
    assert receipt["status"] == "failed"
    assert "FileNotFoundError" in receipt["error"]
    assert (output / "failure.traceback.txt").is_file()


def test_existing_or_symlink_output_is_never_overwritten(tmp_path):
    existing = tmp_path / "existing"
    existing.mkdir()
    (existing / "receipt.json").write_text("preserved")
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "absent")
    for output in (existing, link):
        assert (
            comparator.main(
                ["--output", str(output), "--java", "absent", "--ij-jar", "absent"]
            )
            != 0
        )
    assert (existing / "receipt.json").read_text() == "preserved"
    assert link.is_symlink()


def test_runner_never_turns_mismatch_into_success(tmp_path, monkeypatch):
    def failed_run(args, receipt):
        receipt["cases"] = [{"name": "authored-failure"}]
        raise ValueError("Exact native label mismatch")

    monkeypatch.setattr(comparator, "run", failed_run)
    output = tmp_path / "failure"
    assert (
        comparator.main(
            [
                "--output",
                str(output),
                "--java",
                "operator-java",
                "--ij-jar",
                "operator-jar",
            ]
        )
        != 0
    )
    receipt = json.loads((output / "receipt.json").read_text())
    assert receipt["status"] == "failed"
    assert receipt["cases"][0]["name"] == "authored-failure"
    assert "Exact native label mismatch" in receipt["error"]
