from __future__ import annotations

import hashlib
import json

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.source_annotation_interchange import (
    SCHEMA,
    export_source_annotations,
    import_source_annotations,
)
from loci_engine.workbench import Workbench


def _source_file(tmp_path):
    path = tmp_path / "source.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((30, 40), dtype=np.uint16),
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 2.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 3.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    return path


def _workbench(root, source_path):
    workbench = Workbench(ResearchProject.create(root, "Annotation interchange"))
    return workbench, workbench.import_native(str(source_path))


def _add(workbench, source, *, revision, points, kind="line", label="Region"):
    return workbench.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": revision,
            "action": "add",
            "annotation": {
                "kind": kind,
                "points": [{"x": x, "y": y} for x, y in points],
                "label": label,
                "color": "#ffcc66",
                "z": 0,
                "t": 0,
            },
        },
    )


def _undo(workbench, source, revision):
    return workbench.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": revision,
            "action": "undo",
        },
    )


def test_export_contains_only_current_source_bound_annotations_and_is_no_overwrite(tmp_path):
    source_path = _source_file(tmp_path)
    original_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
    workbench, source = _workbench(tmp_path / "study.loci-study", source_path)
    first = _add(workbench, source, revision=0, points=[(0.5, 0.5), (3.5, 4.5)])
    _add(
        workbench,
        source,
        revision=1,
        points=[(0, 0), (4, 0), (4, 5), (0, 5)],
        kind="rectangle",
    )
    current = _undo(workbench, source, 2)
    destination = tmp_path / "current.loci-annotations.json"

    receipt = export_source_annotations(
        workbench, source["id"], source["sha256"], 3, destination
    )
    package = json.loads(destination.read_text())

    assert receipt == {
        "schema": SCHEMA,
        "basename": destination.name,
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "annotation_count": 1,
    }
    assert set(package) == {
        "schema",
        "source",
        "annotations",
        "annotation_count",
        "source_annotations_revision",
    }
    assert "history" not in destination.read_text() and str(tmp_path) not in destination.read_text()
    assert package["annotations"] == first["annotations"] == current["annotations"]
    assert package["annotations"][0]["unit"] == first["annotations"][0]["unit"] == "um"
    assert package["source"] == {
        "sha256": source["sha256"],
        "coordinate_space": "level0-pixel-edges",
        "geometry": current["geometry"],
        "dimensions": {"x": 40, "y": 30, "z": 1, "t": 1},
    }
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == original_sha
    with pytest.raises(ValueError, match="destination must be absent"):
        export_source_annotations(
            workbench, source["id"], source["sha256"], 3, destination
        )


def test_import_merges_once_preserves_ids_and_is_undoable(tmp_path):
    source_path = _source_file(tmp_path)
    source_workbench, source = _workbench(tmp_path / "source-study", source_path)
    exported = _add(
        source_workbench,
        source,
        revision=0,
        points=[(1, 1), (5, 6)],
        label="Imported line",
    )
    package_path = tmp_path / "annotations.json"
    export_source_annotations(
        source_workbench, source["id"], source["sha256"], 1, package_path
    )
    target_workbench, target = _workbench(tmp_path / "target-study", source_path)
    local = _add(
        target_workbench,
        target,
        revision=0,
        points=[(10, 10), (12, 14)],
        label="Local line",
    )

    imported = import_source_annotations(
        target_workbench, target["id"], target["sha256"], 1, package_path
    )

    assert imported["revision"] == 2
    assert imported["annotations"] == local["annotations"] + exported["annotations"]
    assert imported["annotations"][1]["id"] == exported["annotations"][0]["id"]
    undone = _undo(target_workbench, target, 2)
    assert undone["annotations"] == local["annotations"]
    assert undone["can_redo"] is True

    target_workbench.execute(
        "annotate_source",
        {
            "source_id": target["id"],
            "source_sha256": target["sha256"],
            "expected_revision": 3,
            "action": "redo",
        },
    )
    with pytest.raises(ValueError, match="identity already exists"):
        import_source_annotations(
            target_workbench, target["id"], target["sha256"], 4, package_path
        )
    assert target_workbench.project.documents("annotations")[0]["revision"] == 4


@pytest.mark.parametrize("invalid", ["geometry", "sha256", "extra-field"])
def test_import_rejects_changed_source_binding_without_mutation(tmp_path, invalid):
    source_path = _source_file(tmp_path)
    exporter, source = _workbench(tmp_path / "exporter", source_path)
    _add(exporter, source, revision=0, points=[(1, 1), (2, 2)])
    valid_path = tmp_path / "valid.json"
    export_source_annotations(exporter, source["id"], source["sha256"], 1, valid_path)
    package = json.loads(valid_path.read_text())
    if invalid == "geometry":
        package["source"]["geometry"]["affine"][0][0] = 3.0
    elif invalid == "sha256":
        package["source"]["sha256"] = "0" * 64
    else:
        package["unexpected"] = True
    invalid_path = tmp_path / f"invalid-{invalid}.json"
    invalid_path.write_text(canonical_json(package) + "\n")
    target, registered = _workbench(tmp_path / f"target-{invalid}", source_path)

    with pytest.raises(ValueError):
        import_source_annotations(
            target, registered["id"], registered["sha256"], 0, invalid_path
        )
    assert target.project.documents("annotations") == []


@pytest.mark.parametrize(
    "contents",
    [
        '{"schema":"x","schema":"y"}',
        '{"schema":"x","value":NaN}',
    ],
)
def test_import_rejects_duplicate_keys_and_nonfinite_json(tmp_path, contents):
    source_path = _source_file(tmp_path)
    workbench, source = _workbench(tmp_path / "study", source_path)
    package = tmp_path / "invalid.json"
    package.write_text(contents)

    with pytest.raises(ValueError):
        import_source_annotations(
            workbench, source["id"], source["sha256"], 0, package
        )
    assert workbench.project.documents("annotations") == []


def test_import_rejects_links_stale_revision_and_changed_source(tmp_path):
    source_path = _source_file(tmp_path)
    exporter, source = _workbench(tmp_path / "exporter", source_path)
    _add(exporter, source, revision=0, points=[(1, 1), (2, 2)])
    package = tmp_path / "annotations.json"
    export_source_annotations(exporter, source["id"], source["sha256"], 1, package)
    linked = tmp_path / "linked.json"
    linked.symlink_to(package)
    target, registered = _workbench(tmp_path / "target", source_path)

    with pytest.raises(ValueError, match="plain file"):
        import_source_annotations(
            target, registered["id"], registered["sha256"], 0, linked
        )
    _add(target, registered, revision=0, points=[(4, 4), (6, 6)])
    with pytest.raises(ValueError, match="changed; reload"):
        import_source_annotations(
            target, registered["id"], registered["sha256"], 0, package
        )
    source_path.write_bytes(b"changed immutable source")
    with pytest.raises(ValueError, match="changed"):
        import_source_annotations(
            target, registered["id"], registered["sha256"], 1, package
        )
    assert target.project.documents("annotations")[0]["revision"] == 1
