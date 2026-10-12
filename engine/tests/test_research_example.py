import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.native_image import NativeSourceChangedError
from loci_engine.research_example import create_example_study, write_example_source
from loci_engine.research_interchange import (
    export_project,
    import_project,
    relink_interchanged_source,
)
from loci_engine.research_rpc import dispatch_research
from loci_engine.research_session import clone_study
from loci_engine.workbench import Workbench


def test_fixed_source_bytes_and_independent_geometry_oracle(tmp_path):
    first, second = tmp_path / "first.tiff", tmp_path / "second.tiff"
    provenance = write_example_source(first)
    write_example_source(second)
    assert first.read_bytes() == second.read_bytes()
    assert provenance["license"] == "CC0-1.0"
    # Oracle is defined independently of the generator's rectangle list and
    # segmentation implementation. Coordinates are native row/column (Y/X).
    expected = np.zeros((256, 256), dtype=np.uint16)
    expected[32:48, 32:52] = 100
    expected[80:104, 128:160] = 150
    expected[160:192, 64:80] = 200
    np.testing.assert_array_equal(tifffile.imread(first), expected)
    assert provenance["source_sha256"] == hashlib.sha256(first.read_bytes()).hexdigest()
    assert not first.stat().st_mode & 0o222


def _run(project):
    workbench = Workbench(project)
    source = project.list_sources()[0]
    output = workbench.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {
                "x": 0,
                "y": 0,
                "width": 256,
                "height": 256,
                "c": 0,
                "z": 0,
                "t": 0,
                "level": 0,
            },
            "recipe": {
                "steps": [],
                "segmentation": {
                    "method": "components",
                    "threshold": 50,
                    "polarity": "bright",
                    "min_size": 1,
                    "exclude_border": False,
                },
                "measurement_channels": [0],
                "gates": [],
            },
        },
    )
    return workbench, source, output


def test_normal_numerical_workflow_review_clone_and_exact_relink(tmp_path):
    project = create_example_study(tmp_path / "practice.loci-study")
    assert project.summary()["counts"] == {"sources": 1, "results": 0, "jobs": 0}
    source = project.list_sources()[0]
    assert "private_path" not in source
    assert source["metadata"]["dimensions"] == {"x": 256, "y": 256, "z": 1, "c": 1, "t": 1, "s": 1}
    raw_path = Path(project.source(source["id"])["private_path"])
    assert not raw_path.is_relative_to(project.root)
    raw_bytes = raw_path.read_bytes()
    manifest = json.loads((raw_path.parent / "provenance.json").read_text())
    assert manifest["source_sha256"] == source["sha256"]
    wb, source, output = _run(project)
    rows = output["measurements"]
    assert len(rows) == 3
    assert [row["voxel_count"] for row in rows] == [320, 768, 512]
    assert [row["measure"] for row in rows] == [80, 192, 128]
    assert [row["measure_unit"] for row in rows] == ["um^2"] * 3
    assert [row["centroid_index"] for row in rows] == [[39.5, 41.5], [91.5, 143.5], [175.5, 71.5]]
    assert [row["centroid_world_xyz"] for row in rows] == [
        [20.75, 19.75, 0],
        [71.75, 45.75, 0],
        [35.75, 87.75, 0],
    ]
    for row, intensity in zip(rows, [100, 150, 200], strict=True):
        assert list(row["intensity"].values())[0]["mean"] == intensity
        assert list(row["intensity"].values())[0]["sum"] == intensity * row["voxel_count"]
    result = output["result"]
    assert project.review_state(result["id"]) is None
    reviewed = project.review(result["id"], result["revision_hash"], "reviewed")
    clone = clone_study(project, tmp_path / "saved.loci-study")
    assert clone.meta["first_study"] == project.meta["first_study"]
    assert clone.result(result["id"]) == project.result(result["id"])
    assert clone.review_state(result["id"]) == reviewed
    archive = tmp_path / "portable.zip"
    export_project(project, archive)
    imported = import_project(archive, tmp_path / "imported.loci-study")
    restored = Workbench(imported)
    assert restored.snapshot()["sources"][0]["locator_state"] == "relink-required"
    before = restored.snapshot()
    mismatch = tmp_path / "mismatch.tiff"
    mismatch.write_bytes(raw_bytes[:-1] + bytes([raw_bytes[-1] ^ 1]))
    with pytest.raises(NativeSourceChangedError, match="match|fingerprint"):
        relink_interchanged_source(restored.project, source["id"], mismatch)
    assert restored.snapshot() == before
    exact = tmp_path / "exact.tiff"
    exact.write_bytes(raw_bytes)
    relink_interchanged_source(restored.project, source["id"], exact)
    assert restored.project.source(source["id"], verify=True)["sha256"] == source["sha256"]
    assert restored.project.result(result["id"]) == project.result(result["id"])
    assert restored.project.review_state(result["id"]) == reviewed
    assert raw_path.read_bytes() == raw_bytes
    wb.close()
    restored.close()


@pytest.mark.parametrize("failure", [RuntimeError("Import rejected"), KeyboardInterrupt()])
def test_failed_or_interrupted_creation_does_not_publish_or_touch_previous(
    tmp_path, monkeypatch, failure
):
    prior = create_example_study(tmp_path / "prior.loci-study")
    original = prior.database.read_bytes()

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(Workbench, "import_native", fail)
    with pytest.raises(type(failure)):
        create_example_study(tmp_path / "next.loci-study")
    assert prior.database.read_bytes() == original
    assert not (tmp_path / "next.loci-study").exists()
    assert not (tmp_path / "next.loci-study.source").exists()
    assert not list(tmp_path.glob(".loci-example-*"))


def test_creation_never_overwrites_and_rpc_accepts_only_trusted_destination(tmp_path):
    project = create_example_study(tmp_path / "practice.loci-study")
    original = project.database.read_bytes()
    with pytest.raises(ValueError, match="never overwritten"):
        create_example_study(project.root)
    assert project.database.read_bytes() == original
    with pytest.raises(ValueError, match="fields"):
        dispatch_research(
            "research_create_example",
            {"path": str(tmp_path / "next.loci-study"), "source": "/arbitrary"},
        )
    snapshot = dispatch_research(
        "research_create_example", {"path": str(tmp_path / "next.loci-study")}
    )
    assert len(snapshot["sources"]) == 1
    assert snapshot["results"] == []
    assert str(tmp_path) not in json.dumps(snapshot)
