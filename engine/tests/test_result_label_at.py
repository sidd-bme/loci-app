from __future__ import annotations

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def workbench_2d(tmp_path):
    file = tmp_path / "raw_2d.ome.tif"
    image = np.zeros((1, 50, 60), np.uint16)
    # Object 1: at y: 10..20, x: 10..25
    image[0, 10:20, 10:25] = 100
    # Object 2: at y: 30..40, x: 35..50
    image[0, 30:40, 35:50] = 150
    tifffile.imwrite(
        file,
        image,
        ome=True,
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["DAPI"]},
        },
        photometric="minisblack",
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study_2d.loci-study", "Study2D"))
    source = wb.import_native(str(file))
    output = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"z": 0},
            "recipe": {
                "segmentation": {"method": "components", "threshold": 50},
                "measurement_channels": [0],
            },
        },
    )
    result = wb.project.result(output["result"]["id"])
    yield wb, source, result
    wb.close()


@pytest.fixture
def workbench_3d(tmp_path):
    file = tmp_path / "raw_3d.ome.tif"
    image = np.zeros((1, 8, 30, 40), np.uint16)
    # Object in 3D: z: 2..5, y: 10..18, x: 15..25
    image[0, 2:5, 10:18, 15:25] = 120
    tifffile.imwrite(
        file,
        image,
        ome=True,
        metadata={
            "axes": "CZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 0.5,
            "PhysicalSizeZ": 1.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["GFP"]},
        },
        photometric="minisblack",
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study_3d.loci-study", "Study3D"))
    source = wb.import_native(str(file))
    output = wb.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": {"z": 0, "z_stop": 8},
            "recipe": {
                "segmentation": {"method": "components", "threshold": 50},
                "measurement_channels": [0],
            },
        },
    )
    result = wb.project.result(output["result"]["id"])
    yield wb, source, result
    wb.close()


def test_result_label_at_2d_object_and_background(workbench_2d):
    wb, source, result = workbench_2d
    res_id = result["id"]
    rev = result["revision_hash"]

    # Inside object 1 (y: 15, x: 15) -> label > 0
    hit1 = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "u": 15, "v": 15},
    )
    assert hit1["result_id"] == res_id
    assert hit1["revision_hash"] == rev
    assert hit1["label"] == 1
    assert hit1["axis"] == "z"
    assert hit1["index"] == 0
    assert hit1["u"] == 15
    assert hit1["v"] == 15

    # Inside object 2 (y: 35, x: 40) -> label == 2
    hit2 = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "u": 40, "v": 35},
    )
    assert hit2["label"] == 2

    # Background pixel (y: 2, x: 2) -> label == 0
    bg = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "u": 2, "v": 2},
    )
    assert bg["label"] == 0

    # Out of bounds coordinates -> label == 0
    oob_neg = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "u": -5, "v": 10},
    )
    assert oob_neg["label"] == 0

    oob_far = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "u": 200, "v": 500},
    )
    assert oob_far["label"] == 0


def test_result_label_at_2d_validation(workbench_2d):
    wb, source, result = workbench_2d
    res_id = result["id"]

    # Revision mismatch raises ValueError
    with pytest.raises(ValueError, match="revision"):
        wb.execute(
            "result_label_at",
            {"result_id": res_id, "revision_hash": "deadbeef", "u": 10, "v": 10},
        )

    # 2D has only XY plane (axis must be 'z')
    with pytest.raises(ValueError, match="XY plane"):
        wb.execute(
            "result_label_at",
            {"result_id": res_id, "axis": "x", "u": 10, "v": 10},
        )

    # Invalid coordinates
    with pytest.raises(ValueError, match="numeric"):
        wb.execute(
            "result_label_at",
            {"result_id": res_id, "u": "not_a_number", "v": 10},
        )


def test_result_label_at_3d_axes(workbench_3d):
    wb, source, result = workbench_3d
    res_id = result["id"]
    rev = result["revision_hash"]
    # Object is at z: 2..4, y: 10..17, x: 15..24

    # Axis 'z', index 3: plane shape is (Y=30, X=40). v=12, u=20 is inside object
    hit_z = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "axis": "z", "index": 3, "u": 20, "v": 12},
    )
    assert hit_z["label"] == 1
    assert hit_z["axis"] == "z"
    assert hit_z["index"] == 3

    # Axis 'z', index 0 (outside z range of object) -> label == 0
    miss_z = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "axis": "z", "index": 0, "u": 20, "v": 12},
    )
    assert miss_z["label"] == 0

    # Axis 'y', index 14: plane shape is (Z=8, X=40). row is Z, col is X.
    # Inside object: z=3 (v=3), x=20 (u=20)
    hit_y = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "axis": "y", "index": 14, "u": 20, "v": 3},
    )
    assert hit_y["label"] == 1
    assert hit_y["axis"] == "y"
    assert hit_y["index"] == 14

    # Axis 'x', index 18: plane shape is (Z=8, Y=30). row is Z, col is Y.
    # Inside object: z=3 (v=3), y=12 (u=12)
    hit_x = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "axis": "x", "index": 18, "u": 12, "v": 3},
    )
    assert hit_x["label"] == 1
    assert hit_x["axis"] == "x"
    assert hit_x["index"] == 18

    # 3D out of bounds
    oob_3d = wb.execute(
        "result_label_at",
        {"result_id": res_id, "revision_hash": rev, "axis": "z", "index": 3, "u": -1, "v": 12},
    )
    assert oob_3d["label"] == 0
