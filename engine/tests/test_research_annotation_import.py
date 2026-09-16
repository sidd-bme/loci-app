import base64
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.research_annotation_import import import_annotations
from loci_engine.research_annotations import create_polygon_roi, roi_to_geojson, roi_to_imagej
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench, geometry_from_dict


def _parent(tmp_path: Path):
    project = ResearchProject.create(tmp_path / "study.loci-study", "Annotations")
    image = tmp_path / "source.tif"
    tifffile.imwrite(image, np.arange(100, dtype=np.uint16).reshape(10, 10))
    workbench = Workbench(project)
    source = workbench.import_native(str(image))
    saved = workbench.execute("run_recipe", {"source_id": source["id"]})
    parent = project.result(saved["result"]["id"])
    geometry = geometry_from_dict(parent["provenance"]["geometry"])
    roi = create_polygon_roi(
        annotation_id="imported-roi",
        image_shape=(10, 10),
        geometry=geometry,
        source_sha256=source["sha256"],
        result_sha256=parent["revision_hash"],
        source_t=0,
        source_c=0,
        plane="XY",
        plane_index=0,
        points=[{"u": 1, "v": 1}, {"u": 7, "v": 1}, {"u": 4, "v": 7}],
        slab_start=0,
        slab_stop_exclusive=1,
    )
    return workbench, parent, roi


def test_imports_geojson_feature_collection_into_unreviewed_child(tmp_path):
    workbench, parent, roi = _parent(tmp_path)
    output = import_annotations(
        workbench,
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "format": "geojson",
            "payload": canonical_json(
                {"type": "FeatureCollection", "features": [roi_to_geojson(roi)]}
            ),
            "measurement_channels": [0],
        },
    )
    child = workbench.project.result(output["result"]["id"])
    assert child["parent_id"] == parent["id"]
    assert workbench.project.review_state(child["id"]) is None
    annotation = child["provenance"]["annotations"][0]
    assert annotation["id"] == "imported-roi"
    assert annotation["interchange"]["format"] == "geojson"
    assert annotation["measurements"]["1: Channel 1"]["raw_intensity"]["mean"] > 0


def test_imports_loci_imagej_roi_and_rejects_wrong_exact_revision(tmp_path):
    workbench, parent, roi = _parent(tmp_path)
    payload = base64.b64encode(roi_to_imagej(roi)).decode("ascii")
    output = import_annotations(
        workbench,
        {
            "result_id": parent["id"],
            "revision_hash": parent["revision_hash"],
            "format": "imagej",
            "payload": payload,
            "measurement_channels": [0],
        },
    )
    child = workbench.project.result(output["result"]["id"])
    assert child["provenance"]["annotations"][0]["interchange"]["format"] == "imagej"
    assert child["provenance"]["annotations"][0]["geojson"] == roi_to_geojson(roi)
    with pytest.raises(ValueError, match="exact selected result revision"):
        import_annotations(
            workbench,
            {
                "result_id": parent["id"],
                "revision_hash": "0" * 64,
                "format": "imagej",
                "payload": payload,
                "measurement_channels": [0],
            },
        )
