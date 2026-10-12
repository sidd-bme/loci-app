"""Synthetic statistics oracle; no biological or clinical validation claims."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import tifffile
from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_annotations import label_array_sha256
from loci_engine.research_project import ResearchProject
from loci_engine.research_tiled_store import ObjectTableWriter, TiledArrayWriter
from loci_engine.workbench import Workbench

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=Path)
args = parser.parse_args()
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=True)
project = ResearchProject.create(
    root / "statistics.loci-study", "Statistics synthetic oracle", schema_version=2
)
wb = Workbench(project)
image = np.zeros((520, 520), np.uint16)
labels = np.zeros(image.shape, np.uint32)
expected = []
for label in range(1, 626):
    y, x = divmod(label - 1, 25)
    y, x = y * 20 + 8, x * 20 + 8
    width = label % 4 + 1
    image[y : y + 2, x : x + width] = label + 100
    labels[y : y + 2, x : x + width] = label
    expected.append(
        {
            "label": label,
            "voxels": 2 * width,
            "measure": 0.4 * 2 * width,
            "mean": label + 100,
        }
    )
geometry = Geometry(
    "YX", ((0.5, 0, 0, 0), (0, 0.8, 0, 0), (0, 0, 2, 0), (0, 0, 0, 1)), "um", "image"
)
path = root / "objects-625.ome.tif"
tifffile.imwrite(
    path,
    image,
    ome=True,
    metadata={
        "axes": "YX",
        "PhysicalSizeX": 0.5,
        "PhysicalSizeY": 0.8,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeYUnit": "µm",
    },
)
source = wb.import_native(str(path))
rows = measure_objects(labels, geometry, {"raw": image})
for row, oracle in zip(rows, expected, strict=True):
    assert row["label"] == oracle["label"] and row["voxel_count"] == oracle["voxels"]
    assert abs(row["measure"] - oracle["measure"]) < 1e-12
    assert row["intensity"]["raw"]["mean"] == oracle["mean"]
provenance = {
    "geometry": geometry.to_dict(),
    "selection": {"t": 0, "z": 0, "c": 0, "level": 0},
    "measurement_basis": "raw-selected-channel-values-on-result-grid",
    "recipe": {"fixture": True},
    "runtime": {"engine": "synthetic-qa"},
}
first = project.save_result(
    source_id=source["id"],
    kind="segmentation",
    arrays={"image": image, "labels": labels},
    provenance={**provenance, "measurements": rows},
)


def tiled(array):
    writer = TiledArrayWriter(project, array.shape, array.dtype, 128)
    for y in range(0, array.shape[0], 128):
        for x in range(0, array.shape[1], 128):
            writer.write(y, x, array[y : y + 128, x : x + 128])
    return writer.finish()


with ObjectTableWriter(project) as writer:
    for row in rows:
        writer.append(row)
    table = writer.finalize()
second = project.save_tiled_result(
    source_id=source["id"],
    kind="segmentation",
    arrays={"image": tiled(image), "labels": tiled(labels)},
    provenance=provenance,
    object_table=table,
    label_sha256=label_array_sha256(labels),
)
volume = np.zeros((8, 32, 32), np.uint16)
volume[1:3, 3:5, 3:6] = 150
volume[4:7, 16:20, 16:21] = 300
path3d = root / "objects-3d.ome.tif"
tifffile.imwrite(
    path3d,
    volume,
    ome=True,
    photometric="minisblack",
    metadata={
        "axes": "ZYX",
        "PhysicalSizeX": 0.5,
        "PhysicalSizeY": 0.8,
        "PhysicalSizeZ": 2,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeYUnit": "µm",
        "PhysicalSizeZUnit": "µm",
    },
)
source3d = wb.import_native(str(path3d))
answer = wb.execute(
    "run_recipe",
    {
        "source_id": source3d["id"],
        "selection": {"t": 0, "z": 0, "z_stop": 8, "c": 0, "level": 0},
        "recipe": {
            "steps": [],
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0],
        },
    },
)
third = project.result(answer["result"]["id"])
volume_rows = third["provenance"]["measurements"]
assert [row["voxel_count"] for row in volume_rows] == [12, 60]
assert all(
    abs(row["measure"] - n * 0.8) < 1e-12
    for row, n in zip(volume_rows, [12, 60], strict=True)
)
report = {
    "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "study": str(project.root),
    "source_id": source["id"],
    "source3d_id": source3d["id"],
    "dense": first["id"],
    "tiled": second["id"],
    "volume": third["id"],
    "expected": expected,
    "sources": {
        str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [path, path3d]
    },
    "scope": "Deterministic numerical and UI fixture only; no biological or clinical claims",
}
(root / "oracle.json").write_text(json.dumps(report, indent=2))
print(root / "oracle.json")
