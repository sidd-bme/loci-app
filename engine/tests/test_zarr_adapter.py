import shutil

import numpy as np
import pytest
from test_ome_zarr import _store

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def test_zarr_study_preserves_selected_tcz_values_affine_and_relinks_exact_tree(tmp_path):
    root, arrays = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    workbench = Workbench(project)
    source = workbench.import_native(str(root))
    policy = workbench._session(source["id"]).metadata.rgb_color_policy
    assert policy is not None and policy.source_status == "not-applicable"
    selection = {
        "x": 4,
        "y": 3,
        "width": 7,
        "height": 6,
        "t": 1,
        "c": 2,
        "z": 1,
        "z_stop": 4,
        "level": 0,
    }
    values, geometry, selected = workbench.load_scalar(source["id"], selection)
    np.testing.assert_array_equal(values, arrays[0][1, 2, 1:4, 3:9, 4:11])
    assert geometry.axes == "ZYX" and geometry.unit == "um"
    np.testing.assert_array_equal(geometry.world(np.array([[0, 0, 0]])), [[31, 21.5, 2]])
    saved = workbench.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": selected,
            "recipe": {"steps": [{"op": "subtract_constant", "value": 1}]},
        },
    )
    result = project.result(saved["result"]["id"])
    np.testing.assert_array_equal(
        project.load_array(result["arrays"]["image"]), values.astype(np.float64) - 1
    )
    workbench.close()
    destination = tmp_path / "relocated.ome.zarr"
    shutil.copytree(root, destination)
    shutil.rmtree(root)
    project.relink(source["id"], destination)
    reopened = Workbench(ResearchProject(project.root))
    restored, restored_geometry, _ = reopened.load_scalar(source["id"], selection)
    np.testing.assert_array_equal(restored, values)
    assert restored_geometry == geometry
    assert str(tmp_path) not in str(reopened.snapshot())
    reopened.close()


def test_zarr_modified_chunk_blocks_adoption_and_bad_relink(tmp_path):
    root, _ = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    workbench = Workbench(project)
    source = workbench.import_native(str(root))
    changed = tmp_path / "changed.ome.zarr"
    shutil.copytree(root, changed)
    chunk = next(path for path in (changed / "0").iterdir() if not path.name.startswith("."))
    chunk.write_bytes(bytes(chunk.stat().st_size))
    with pytest.raises(ValueError, match="do not exactly match"):
        project.relink(source["id"], changed)
    original = root / chunk.relative_to(changed)
    original.write_bytes(chunk.read_bytes())
    with pytest.raises((ValueError, RuntimeError), match="match|changed"):
        workbench.execute("run_recipe", {"source_id": source["id"]})
    assert not project.list_results()


def test_zarr_xy_plane_keeps_physical_z_translation(tmp_path):
    root, arrays = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    workbench = Workbench(project)
    source = workbench.import_native(str(root))
    plane, geometry, _ = workbench.load_scalar(source["id"], {"t": 1, "c": 2, "z": 3})
    np.testing.assert_array_equal(plane, arrays[0][1, 2, 3])
    np.testing.assert_array_equal(geometry.world(np.array([[0, 0]])), [[30, 20, 6]])


def test_desktop_collection_picker_imports_real_ome_zarr(tmp_path):
    from loci_engine.research_rpc import dispatch_research

    root, _ = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "collection.loci-study", "Collection")
    snapshot = dispatch_research(
        "research_import", {"project": str(project.root), "paths": [str(root)], "kind": "ome_zarr"}
    )
    assert len(snapshot["sources"]) == 1
    assert snapshot["sources"][0]["source_kind"] == "ome_zarr"
