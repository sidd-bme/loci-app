import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.quantitative import Geometry
from loci_engine.research_project import ResearchProject
from loci_engine.research_surface import MAX_FACES, surface_mesh
from loci_engine.workbench import Workbench


def test_surface_vertices_preserve_anisotropic_reflected_world_coordinates():
    array = np.zeros((14, 18, 16), np.uint8)
    array[3:8, 5:12, 4:9] = 1
    before = array.copy()
    geometry = Geometry(
        "ZYX", ((0, -2, 0, 10), (-0.5, 0, 0, 20), (0, 0, 3, 30), (0, 0, 0, 1)), "mm", "LPS"
    )
    mesh = surface_mesh(array, geometry, isovalue=0.5)
    vertices = np.asarray(mesh["vertices_world_xyz"])
    expected = geometry.world(np.array([[2.5, 4.5, 3.5], [7.5, 11.5, 8.5]]))
    np.testing.assert_allclose(vertices.min(axis=0), expected.min(axis=0), atol=1e-6)
    np.testing.assert_allclose(vertices.max(axis=0), expected.max(axis=0), atol=1e-6)
    assert mesh["geometry"]["frame"] == "LPS"
    assert mesh["strides_zyx"] == [1, 1, 1]
    assert len(mesh["faces"]) <= MAX_FACES
    assert "display-only" in mesh["purpose"]
    np.testing.assert_array_equal(array, before)


def test_complex_surface_coarsening_is_bounded_and_recorded():
    z, y, x = np.ogrid[:96, :96, :96]
    sphere = ((z - 48) ** 2 + (y - 48) ** 2 + (x - 48) ** 2 < 34**2).astype(np.uint8)
    mesh = surface_mesh(sphere, Geometry.diagonal((3, 1, 1), "um"), isovalue=0.5, max_edge=96)
    assert mesh["marching_step"] > 1
    assert 1 <= len(mesh["faces"]) <= MAX_FACES
    assert mesh["source_shape"] == [96, 96, 96]
    assert mesh["display_shape"] == [96, 96, 96]
    with pytest.raises(ValueError, match="budget"):
        surface_mesh(sphere, Geometry.diagonal((1, 1, 1)), isovalue=0.5, working_bytes=1024**2)


def test_shared_surface_view_is_revision_bound_and_never_adopts(tmp_path):
    image = np.zeros((12, 16, 18), np.uint16)
    image[3:9, 4:12, 5:13] = 100
    source_path = tmp_path / "volume.ome.tif"
    tifffile.imwrite(
        source_path,
        image,
        ome=True,
        metadata={"axes": "ZYX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 1, "PhysicalSizeZ": 2},
    )
    workbench = Workbench(ResearchProject.create(tmp_path / "surface.loci-study", "Surface"))
    source = workbench.import_native(str(source_path))
    selection = {"z": 0, "z_stop": 12}
    viewed = workbench.execute("surface_view", {"source_id": source["id"], "selection": selection})
    assert viewed["isovalue"] == 50
    assert viewed["adopted"] is False
    assert workbench.project.list_results() == []
    result = workbench.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": selection,
            "recipe": {"segmentation": {"method": "components", "threshold": 50}},
        },
    )["result"]
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    labels = workbench.execute("surface_view", {**binding, "mode": "labels", "label": 1})
    assert labels["isovalue"] == 0.5
    assert labels["binding"]["revision_hash"] == result["revision_hash"]
    assert len(workbench.project.list_results()) == 1
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == source["sha256"]
    with pytest.raises(ValueError, match="exact"):
        workbench.execute("surface_view", {**binding, "revision_hash": "b" * 64})
    with pytest.raises(ValueError, match="isovalue"):
        workbench.execute("surface_view", {**binding, "isovalue": None})
    with pytest.raises(ValueError, match="absent"):
        workbench.execute("surface_view", {**binding, "mode": "labels", "label": 2})
    with pytest.raises(ValueError, match="volume"):
        workbench.execute("surface_view", {"source_id": source["id"], "selection": {"z": 0}})
