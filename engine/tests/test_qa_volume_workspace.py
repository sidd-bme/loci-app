"""Focused harness/oracle checks never claim packaged or actual-host acceptance."""

import copy
import importlib.util
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench

SPEC = importlib.util.spec_from_file_location(
    "qa_volume_workspace", Path(__file__).resolve().parents[2] / "scripts/qa_volume_workspace.py"
)
QA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QA)


@pytest.fixture
def fixture(tmp_path):
    return QA.prepare(tmp_path / "fixture", allow_test_output=True)


def test_fixture_asymmetric_anisotropic_exact_and_prepare_inert(fixture):
    raw, labels = QA.synthetic_arrays()
    root = Path(fixture["output"])
    assert fixture["phase"] == "prepared-not-executed"
    assert not list(root.rglob("study.sqlite3"))
    assert labels.shape == (12, 48, 64) and fixture["target_label"] == 2**32 - 1
    assert np.unique(labels).tolist() == [0, 17, 65536, 2**32 - 1]
    np.testing.assert_array_equal(tifffile.imread(fixture["source"]["path"]), raw)
    np.testing.assert_array_equal(tifffile.imread(fixture["labels"]["path"]), labels)
    np.testing.assert_array_equal(np.load(root / "expected-image.npy"), raw[1, 1, 2:14])
    assert fixture["affine"] == [[0.5, 0, 0, 0], [0, 1.5, 0, 0], [0, 0, 2.5, 5], [0, 0, 0, 1]]
    assert fixture["rows"][0]["voxel_count"] == 4 * 6 * 6 + 1
    assert fixture["rows"][-1]["voxel_count"] == 7 * 9 * 9
    assert fixture["rows"][-1]["measure"] == pytest.approx(7 * 9 * 9 * 0.5 * 1.5 * 2.5)
    x, y, z = fixture["probe_source_xyz"]
    assert labels[z - 2, y, x] == fixture["target_label"]
    assert QA.identity(root / "fixture.json") == fixture


@pytest.mark.parametrize("changed", ["source", "labels", "oracle"])
def test_changed_inputs_and_oracles_fail_closed(fixture, changed):
    root = Path(fixture["output"])
    file = root / "expected-labels.npy" if changed == "oracle" else Path(fixture[changed]["path"])
    with file.open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(AssertionError, match="changed"):
        QA.identity(root / "fixture.json")


def test_preparation_exclusive_and_confined_to_evidence(fixture, tmp_path):
    with pytest.raises(FileExistsError):
        QA.prepare(Path(fixture["output"]), allow_test_output=True)
    with pytest.raises(AssertionError, match="ignored local evidence"):
        QA.prepare(tmp_path / "outside")


def test_oracle_checks_actual_import_correction_and_raw_measurements(fixture, tmp_path):
    from loci_engine.research_labels_import import create_import_grant

    wb = Workbench(ResearchProject.create(tmp_path / "study", "Harness unit check"))
    try:
        source = wb.import_native(fixture["source"]["path"])
        grant = create_import_grant(
            wb, fixture["labels"]["path"], source["id"], source["sha256"], fixture["selection"]
        )
        parent = wb.execute(
            "labels_import",
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "grant_id": grant["grant_id"],
                "alignment": "same-native-zyx-grid",
            },
        )["result"]
        info = wb.execute(
            "correction_info", {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
        )
        child = wb.execute(
            "correct_result",
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "operations": [
                    {
                        "op": "delete",
                        "label": fixture["target_label"],
                        "expected_input_sha256": info["label_sha256"],
                    }
                ],
            },
        )["result"]
        result = QA.verify(
            Path(fixture["output"]) / "fixture.json", wb.project.root, parent["id"], child["id"]
        )
        assert result["status"] == "passed" and result["scientific_validation"] is False
        wrong = wb.execute(
            "correct_result",
            {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "operations": [
                    {"op": "delete", "label": 17, "expected_input_sha256": info["label_sha256"]}
                ],
            },
        )["result"]
        with pytest.raises(AssertionError):
            QA.verify(
                Path(fixture["output"]) / "fixture.json",
                wb.project.root,
                parent["id"],
                wrong["id"],
            )
        actual = wb.project.result(parent["id"])["provenance"]["measurements"]
        changed = copy.deepcopy(actual)
        changed[-1]["intensity"][next(iter(changed[-1]["intensity"]))]["mean"] += 1
        with pytest.raises(AssertionError):
            QA.compare_rows(changed, fixture["rows"])
    finally:
        wb.close()


def test_biological_preparation_requires_local_rights_and_hashes(tmp_path):
    public = tmp_path / "public"
    public.mkdir()
    QA.write(
        public / "source-rights-and-gaps.json", {"cellseg3d": {"api_license": {"id": "unknown"}}}
    )
    with pytest.raises(AssertionError, match="rights"):
        QA.public_arrays("cellseg3d", public=public)
    altered = tmp_path / "c5image.tif"
    altered.write_bytes(b"Changed or substituted public input")
    with pytest.raises(AssertionError, match="fingerprint"):
        QA.pinned(altered)
