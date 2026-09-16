import hashlib
import json

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject
from loci_engine.source_annotation_interchange import (
    export_source_annotations,
    import_source_annotations,
)
from loci_engine.workbench import Workbench


def fixture(tmp_path):
    image = tmp_path / "image.ome.tif"
    tifffile.imwrite(
        image,
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
    workbench = Workbench(ResearchProject.create(tmp_path / "study.loci-study", "Raw annotations"))
    source = workbench.import_native(str(image))
    return workbench, source


def add(workbench, source, points, kind="line", revision=0, transect=None):
    annotation = {
        "kind": kind,
        "points": [{"x": x, "y": y} for x, y in points],
        "label": "Region",
        "color": "#ffcc66",
        "z": 0,
        "t": 0,
    }
    if transect is not None:
        annotation["transect"] = transect
    return workbench.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": revision,
            "action": "add",
            "annotation": annotation,
        },
    )


def test_raw_annotations_need_no_result_and_preserve_physical_edges_and_history(tmp_path):
    workbench, source = fixture(tmp_path)
    line = add(workbench, source, [(0.5, 0.5), (3.5, 4.5)])
    item = line["annotations"][0]
    assert item["world_xyz"][0] == [0, 0, 0]
    assert item["length"] == pytest.approx(np.hypot(6, 12))
    assert not workbench.project.list_results()
    polygon = add(workbench, source, [(0, 0), (4, 0), (4, 5), (0, 5)], "rectangle", 1)
    assert polygon["annotations"][-1]["area"] == pytest.approx(120)
    saved = Workbench(ResearchProject(workbench.project.root))
    restored = saved.execute("source_annotations", {"source_id": source["id"]})
    assert restored == polygon
    undo = saved.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 2,
            "action": "undo",
        },
    )
    assert undo["annotations"] == line["annotations"] and undo["can_redo"]
    redo = saved.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 3,
            "action": "redo",
        },
    )
    assert redo["annotations"] == polygon["annotations"]


@pytest.mark.parametrize("points", [[(0, 0), (float("nan"), 1)], [(0, 0), (100, 1)]])
def test_invalid_raw_coordinates_do_not_publish(tmp_path, points):
    workbench, source = fixture(tmp_path)
    with pytest.raises(ValueError):
        add(workbench, source, points)
    assert not workbench.project.documents("annotations")


def test_stale_revision_and_source_changes_fail_closed(tmp_path):
    workbench, source = fixture(tmp_path)
    add(workbench, source, [(0, 0), (2, 3)])
    with pytest.raises(ValueError, match="changed"):
        add(workbench, source, [(0, 0), (2, 3)])
    (tmp_path / "image.ome.tif").write_bytes(b"changed original")
    with pytest.raises(ValueError, match="changed"):
        add(workbench, source, [(0, 0), (2, 3)], revision=1)
    assert workbench.project.documents("annotations")[0]["revision"] == 1


def _transect(
    transect_class="suprapapillary",
    upper="Granular layer",
    lower="Dermal-epidermal junction",
    orientation="Perpendicular to local basement membrane",
    exclusions="Exclude tears, folds, and appendages",
    status="approved",
    reviewer="Dr Alice",
):
    return {
        "schema": "loci.epidermal-transect/v1",
        "class": transect_class,
        "upper_boundary": upper,
        "lower_boundary": lower,
        "orientation_rule": orientation,
        "exclusions": exclusions,
        "review": {"status": status, "reviewer": reviewer},
    }


def test_transect_protocol_review_and_calibration_survive_history_reopen_and_interchange(
    tmp_path,
):
    workbench, source = fixture(tmp_path)
    source_path = tmp_path / "image.ome.tif"
    original_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
    first_protocol = _transect()
    first = add(
        workbench,
        source,
        [(0.5, 0.5), (3.5, 4.5)],
        transect=first_protocol,
    )
    second_protocol = _transect(
        transect_class="ridge-base",
        upper="Spinous upper edge",
        lower="Rete ridge base",
        orientation="Shortest local normal",
        exclusions="Exclude oblique or torn rete ridges",
        status="unverified",
        reviewer=None,
    )
    second = add(
        workbench,
        source,
        [(2.5, 1.5), (2.5, 8.5)],
        revision=1,
        transect=second_protocol,
    )

    reopened = Workbench(ResearchProject(workbench.project.root))
    restored = reopened.execute("source_annotations", {"source_id": source["id"]})
    assert [item["transect"] for item in restored["annotations"]] == [
        first_protocol,
        second_protocol,
    ]
    assert restored["source_id"] == source["id"]
    assert restored["source_sha256"] == source["sha256"] == original_sha
    assert restored["annotations"][0]["length"] == pytest.approx(np.hypot(6, 12))
    assert restored["annotations"][0]["unit"] == "um"

    undone = reopened.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 2,
            "action": "undo",
        },
    )
    assert undone["annotations"] == first["annotations"]
    redone = reopened.execute(
        "annotate_source",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": 3,
            "action": "redo",
        },
    )
    assert redone["annotations"] == second["annotations"]

    exported_path = tmp_path / "transects.loci-annotations.json"
    export_source_annotations(reopened, source["id"], source["sha256"], 4, exported_path)
    package = json.loads(exported_path.read_text())
    assert [item["transect"] for item in package["annotations"]] == [
        first_protocol,
        second_protocol,
    ]
    assert package["source"]["sha256"] == source["sha256"]
    assert package["source"]["geometry"] == restored["geometry"]

    imported_project = Workbench(
        ResearchProject.create(tmp_path / "imported.loci-study", "Imported transects")
    )
    imported_source = imported_project.import_native(str(source_path))
    imported = import_source_annotations(
        imported_project,
        imported_source["id"],
        imported_source["sha256"],
        0,
        exported_path,
    )
    assert [item["transect"] for item in imported["annotations"]] == [
        first_protocol,
        second_protocol,
    ]
    assert all(item["unit"] == "um" for item in imported["annotations"])
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == original_sha


@pytest.mark.parametrize(
    "kind,metadata,match",
    [
        ("line", _transect(reviewer=""), "reviewer"),
        ("line", _transect(status="unverified", reviewer="Dr Alice"), "cannot claim"),
        ("point", _transect(), "requires a line"),
        ("line", "not metadata", "requires a line"),
        ("line", {**_transect(), "schema": "unsupported"}, "unsupported"),
        ("line", {**_transect(), "upper_boundary": ""}, "upper boundary"),
    ],
)
def test_invalid_transect_evidence_does_not_publish(tmp_path, kind, metadata, match):
    workbench, source = fixture(tmp_path)
    points = [(1, 1)] if kind == "point" else [(1, 1), (2, 2)]
    with pytest.raises(ValueError, match=match):
        add(workbench, source, points, kind=kind, transect=metadata)
    assert workbench.project.documents("annotations") == []
