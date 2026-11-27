import json

import numpy as np
import pytest
import tifffile

from loci_engine.organoidtracker import decode, import_graph, list_graphs, load
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def experiment(tmp_path):
    image = tmp_path / "stack.ome.tif"
    tifffile.imwrite(
        image,
        np.zeros((2, 2, 4, 8, 10), dtype=np.uint16),
        metadata=dict(
            axes="TCZYX", PhysicalSizeX=0.25, PhysicalSizeY=0.5, PhysicalSizeZ=2, TimeIncrement=30
        ),
        photometric="minisblack",
    )
    project = ResearchProject.create(tmp_path / "test.loci-study", "Lineage inspection")
    source = Workbench(project).import_native(str(image))
    ids = [dict(x=x, y=4, z=1.5, _time_point_number=t) for t, x in [(13, 5), (14, 3), (14, 7)]]
    doc = dict(
        version="v1",
        links=dict(
            directed=False,
            multigraph=False,
            nodes=[{"id": i} for i in ids],
            links=[
                dict(source=ids[1], target=ids[0], link_probability=0.75),
                dict(source=ids[0], target=ids[2], marginal_probability=0.98),
            ],
        ),
        image_resolution=dict(x_um=0.25, y_um=0.5, z_um=2, t_m=0.5),
        image_offsets=[],
    )
    return project, source, doc


def test_reopen_and_portable_round_trip(experiment, tmp_path):
    project, source, doc = experiment
    binding = dict(source_id=source["id"], source_sha256=source["sha256"])
    path = tmp_path / "manual.aut"
    path.write_text(json.dumps(doc))
    record = import_graph(project, path, binding, 13, "manually-annotated")
    assert record["nodes"] == [[13, 5, 4, 1.5], [14, 3, 4, 1.5], [14, 7, 4, 1.5]]
    assert record["edges"] == [[0, 1, 0.75, None], [0, 2, None, 0.98]]
    assert record["spacing_xyz_um"] == [0.25, 0.5, 2]
    assert record["interval_s"] == 30
    assert load(ResearchProject(project.root), binding, record["id"]) == record
    assert import_graph(project, path, binding, 13, "manually-annotated") == record
    assert list_graphs(project, binding) == [record["id"]]
    archive = tmp_path / "portable.zip"
    export_project(project, archive)
    imported = import_project(archive, tmp_path / "portable.loci-study")
    imported.relink(source["id"], tmp_path / "stack.ome.tif")
    assert load(imported, binding, record["id"]) == record
    with pytest.raises(ValueError, match="fingerprint"):
        load(project, {**binding, "source_sha256": "0" * 64}, record["id"])


@pytest.mark.parametrize(
    "change",
    [
        "version",
        "offset",
        "time",
        "scale",
        "duplicate",
        "dangling",
        "merge",
        "gap",
        "nan",
        "bounds",
        "probability",
        "missing",
        "variable",
        "positions",
    ],
)
def test_reject_unsupported(experiment, change):
    _, source, doc = experiment
    graph = doc["links"]
    if change == "version":
        doc["version"] = "v2"
    if change == "offset":
        doc["image_offsets"] = [{"x": 1}]
    if change == "time":
        doc["image_resolution"]["t_m"] = 2
    if change == "scale":
        doc["image_resolution"]["x_um"] = 0.5
    if change == "duplicate":
        graph["nodes"].append(graph["nodes"][0])
    if change == "dangling":
        graph["nodes"].pop()
    if change == "merge":
        graph["links"].append(graph["links"][0])
    if change == "gap":
        graph["nodes"][1]["id"]["_time_point_number"] = 15
    if change == "nan":
        graph["nodes"][1]["id"]["x"] = float("nan")
    if change == "bounds":
        graph["nodes"][1]["id"]["z"] = 4
    if change == "probability":
        graph["links"][0]["link_probability"] = True
    if change == "missing":
        doc.pop("image_resolution")
    if change == "variable":
        doc["image_timings"] = {}
    if change == "positions":
        doc["positions"] = {}
    with pytest.raises(ValueError):
        decode(json.dumps(doc).encode(), source, 13, "synthetic")


def test_reject_stale_study_time_for_native_bytes(experiment, tmp_path):
    project, source, doc = experiment
    binding = dict(source_id=source["id"], source_sha256=source["sha256"])
    altered = project.source(source["id"])
    altered["metadata"]["timing"]["uniform_interval"] = 60
    with project.connection() as db:
        db.execute("UPDATE sources SET record=? WHERE id=?", (json.dumps(altered), source["id"]))
    doc["image_resolution"]["t_m"] = 1
    path = tmp_path / "wrong.aut"
    path.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match="native image"):
        import_graph(project, path, binding, 13, "synthetic")
    assert not list_graphs(project, binding)
