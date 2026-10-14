"""Independent oracle and fail-closed reproduction harness checks."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys

import numpy as np
import pytest
import tifffile
from PIL import Image

from scripts import publication_workflow as workflow


def test_oracle_known_components_threshold_axes_area_centroid_and_raw_values():
    image = np.array([[121, 120, 0, 130], [123, 0, 130, 0], [0, 140, 150, 0]], np.uint8)
    labels, rows = workflow.oracle(image, (2.0, 3.0), 120, 0)
    np.testing.assert_array_equal(labels, [[1, 0, 0, 2], [1, 0, 3, 0], [0, 3, 3, 0]])
    assert len(rows) == 3
    first = rows[0]
    assert first["voxel_count"] == 2
    assert first["measure"] == 12
    assert first["centroid_index"] == [0.5, 0]
    assert first["centroid_world_xyz"] == [0, 1, 0]
    assert first["bbox_start"] == [0, 0]
    assert first["bbox_stop_exclusive"] == [2, 1]
    assert first["raw_intensity"] == {
        "mean": 122,
        "sum": 244,
        "min": 121,
        "max": 123,
        "std_population": 1,
    }
    assert first["measure_unit"] == "um^2"
    assert first["index_axes"] == "YX"
    assert rows[2]["measure"] == 18


def test_oracle_hole_diagonal_minimum_area_and_border_are_independent():
    ring = np.full((5, 5), 200, np.uint8)
    ring[1:4, 1:4] = 0
    labels, rows = workflow.oracle(ring, (0.5, 0.25), 120, 2.0)
    assert len(rows) == 1 and rows[0]["voxel_count"] == 16
    assert rows[0]["measure"] == 2
    assert rows[0]["centroid_index"] == [2, 2]
    assert labels[2, 2] == 0
    assert workflow.oracle(ring, (0.5, 0.25), 120, 2.001)[1] == []
    assert workflow.oracle(ring, (0.5, 0.25), 120, 0, exclude_border=True)[1] == []
    diagonal = np.array([[200, 0], [0, 200]], np.uint8)
    np.testing.assert_array_equal(
        workflow.oracle(diagonal, (1.0, 1.0), 120, 0)[0], [[1, 0], [0, 2]]
    )
    interior = np.zeros((4, 4), np.uint8)
    interior[1:3, 1:3] = 200
    assert (
        len(workflow.oracle(interior, (1.0, 1.0), 120, 0, exclude_border=True)[1]) == 1
    )


def test_oracle_filters_then_compacts_row_major_survivor_ids():
    image = np.array([[200, 0, 200, 200], [0, 0, 0, 0], [200, 200, 200, 0]], np.uint8)
    labels, rows = workflow.oracle(image, (1.0, 1.0), 120, 2)
    np.testing.assert_array_equal(labels, [[0, 0, 1, 1], [0, 0, 0, 0], [2, 2, 2, 0]])
    assert [row["label"] for row in rows] == [1, 2]


def test_fixture_bytes_are_deterministic_and_preserve_samples_and_explicit_calibration(
    tmp_path,
):
    first, second = tmp_path / "first.ome.tif", tmp_path / "different-name.ome.tif"
    image = workflow.synthetic()
    workflow.write_fixture(first, image, (0.75, 0.5))
    workflow.write_fixture(second, image, (0.75, 0.5))
    assert first.read_bytes() == second.read_bytes()
    with tifffile.TiffFile(first) as decoded:
        np.testing.assert_array_equal(decoded.asarray(), image)
        assert decoded.asarray().dtype == np.uint8
        assert 'PhysicalSizeX="0.5"' in decoded.ome_metadata
        assert 'PhysicalSizeY="0.75"' in decoded.ome_metadata
        assert (
            "UUID" not in decoded.ome_metadata
            and "AcquisitionDate" not in decoded.ome_metadata
        )


def test_public_input_rejects_wrong_hash_before_decode(tmp_path):
    path = tmp_path / "wrong.png"
    path.write_bytes(b"x" * workflow.PUBLIC_BYTES)
    with pytest.raises(ValueError, match="SHA256 mismatch"):
        workflow.public_image(path)


@pytest.mark.parametrize("shape", [(550, 660), (660, 550, 3)])
def test_public_input_rejects_wrong_shape_after_verified_bytes(
    tmp_path, monkeypatch, shape
):
    # Isolate decoder admission: only this test pins its generated wrong-shape bytes.
    path = tmp_path / "wrong-shape.png"
    Image.fromarray(np.zeros(shape, np.uint8)).save(path)
    monkeypatch.setattr(workflow, "PUBLIC_BYTES", path.stat().st_size)
    monkeypatch.setattr(
        workflow, "PUBLIC_SHA256", hashlib.sha256(path.read_bytes()).hexdigest()
    )
    with pytest.raises(ValueError, match="660Y x 550X uint8"):
        workflow.public_image(path)


def test_comparison_rejects_nonfinite_values_and_inexact_integer_identity():
    for value in (float("inf"), float("nan"), 1.01):
        with pytest.raises(ValueError):
            workflow.compare_value(value, 1.0, "measurement")
    with pytest.raises(ValueError):
        workflow.compare_value(2, 1, "label")
    workflow.compare_value(1.0 + 1e-10, 1.0, "measurement")


def test_existing_output_is_never_overwritten(tmp_path):
    output = tmp_path / "existing"
    output.mkdir()
    receipt = output / "receipt.json"
    receipt.write_text("preserve original")
    assert workflow.main(["--output", str(output)]) == 1
    assert receipt.read_text() == "preserve original"


def test_failure_receipt_is_retained_and_exit_is_nonzero(tmp_path, monkeypatch):
    def fail(_args, _receipt):
        raise RuntimeError("deliberate harness failure")

    monkeypatch.setattr(workflow, "run", fail)
    output = tmp_path / "failed"
    assert workflow.main(["--output", str(output)]) == 1
    receipt = json.loads((output / "receipt.json").read_text())
    assert receipt["status"] == "failed"
    assert receipt["failures"] == [
        {"type": "RuntimeError", "message": "deliberate harness failure"}
    ]
    assert (
        "deliberate harness failure" in (output / "failure.traceback.txt").read_text()
    )


def test_real_process_missing_public_input_exits_nonzero_with_failure_receipt(tmp_path):
    output = tmp_path / "missing-public"
    process = subprocess.run(
        [
            sys.executable,
            str(workflow.ROOT / "scripts/publication_workflow.py"),
            "--output",
            str(output),
            "--public-cell",
            str(tmp_path / "absent.png"),
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert process.returncode == 1
    assert json.loads(process.stdout)["status"] == "failed"
    assert json.loads((output / "receipt.json").read_text())["status"] == "failed"


def test_real_process_missing_output_argument_exits_nonzero(tmp_path):
    process = subprocess.run(
        [sys.executable, str(workflow.ROOT / "scripts/publication_workflow.py")],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert process.returncode != 0
    assert "--output is required" in process.stderr


def test_negative_process_check_rejects_unexpected_success(tmp_path):
    runner = workflow.Runner(tmp_path)
    with pytest.raises(ValueError, match="Expected process denial, got success"):
        runner.process(["-c", "print('{}')"], deny=True)
    assert runner.calls[0]["exit_code"] == 0


def test_failed_process_is_never_reported_as_success(tmp_path):
    runner = workflow.Runner(tmp_path)
    with pytest.raises(ValueError, match="Process failed"):
        runner.process(["-c", "raise SystemExit(7)"])
    assert runner.calls[0]["exit_code"] == 7
