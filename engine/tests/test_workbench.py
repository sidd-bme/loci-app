import base64
import hashlib
import io

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def workbench(tmp_path):
    project = ResearchProject.create(tmp_path / "native.loci-study", "Native study")
    return Workbench(project)


def import_stack(workbench, tmp_path):
    image = np.zeros((2, 2, 7, 32, 32), np.uint16)
    image[0, 0, 1:3, 5:9, 5:9] = 100
    image[0, 0, 4:6, 5:9, 5:9] = 150
    image[0, 1] = 200
    image[1, 0] = 300
    source = tmp_path / "native.ome.tif"
    tifffile.imwrite(
        source,
        image,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.5,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 2.0,
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["Nuclei", "Marker"]},
        },
    )
    return source, workbench.import_native(str(source))


def test_native_channel_time_view_is_real_and_display_is_separate(workbench, tmp_path):
    file, source = import_stack(workbench, tmp_path)
    original = hashlib.sha256(file.read_bytes()).hexdigest()
    viewed = workbench.execute(
        "view",
        {
            "source_id": source["id"],
            "selection": {"t": 1, "z": 2},
            "channels": [{"channel": 0, "low": 0, "high": 1000, "gamma": 2, "color": "#00ff00"}],
        },
    )
    assert viewed["statistics"][0]["min"] == 300
    assert viewed["statistics"][0]["max"] == 300
    assert viewed["display"][0]["basis"].startswith("display-only")
    assert viewed["image"].startswith("data:image/png;base64,")
    assert viewed["geometry"]["unit"] == "um"
    assert workbench.project.list_results() == []
    assert hashlib.sha256(file.read_bytes()).hexdigest() == original
    assert str(tmp_path) not in str(workbench.snapshot())


@pytest.mark.parametrize("order", [(0, 1), (1, 0)])
def test_composite_preserves_requested_scope_and_explicit_channel_records(
    workbench, tmp_path, order
):
    file, source = import_stack(workbench, tmp_path)
    selected = {"x": 4, "y": 4, "width": 8, "height": 8, "t": 0, "c": 0, "z": 2, "level": 0}
    viewed = workbench.execute(
        "view",
        {
            "source_id": source["id"],
            "selection": selected,
            "channels": [
                {
                    "channel": channel,
                    "low": 0,
                    "high": 200,
                    "color": "#00ff00" if channel == 0 else "#ff0000",
                }
                for channel in order
            ],
        },
    )
    assert viewed["selection"] == selected
    assert [record["channel"] for record in viewed["display"]] == list(order)
    by_channel = {record["channel"]: record for record in viewed["statistics"]}
    assert (by_channel[0]["min"], by_channel[0]["max"], by_channel[0]["mean"]) == (0, 100, 25)
    assert (by_channel[1]["min"], by_channel[1]["max"], by_channel[1]["mean"]) == (200, 200, 200)
    pixels = np.asarray(Image.open(io.BytesIO(base64.b64decode(viewed["image"].split(",")[1]))))
    expected = np.zeros((8, 8, 3), dtype=np.uint8)
    expected[..., 0] = 255
    expected[1:5, 1:5, 1] = 128
    np.testing.assert_array_equal(pixels, expected)
    assert hashlib.sha256(file.read_bytes()).hexdigest() == source["sha256"]
    assert workbench.project.list_results() == []


def test_true_volume_recipe_preview_run_review_and_reopen(workbench, tmp_path):
    file, source = import_stack(workbench, tmp_path)
    request = {
        "source_id": source["id"],
        "selection": {"z": 0, "z_stop": 7, "level": 0},
        "recipe": {
            "steps": [],
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0, 1],
        },
    }
    validation = workbench.execute("validate_recipe", request)
    assert validation["selection"]["z_stop"] == 7
    preview = workbench.execute("preview_recipe", request)
    assert preview["object_count"] == 2
    assert preview["adopted"] is False
    assert workbench.project.list_results() == []
    saved = workbench.execute("run_recipe", request)
    assert saved["result"]["object_count"] == 2
    assert [r["measure"] for r in saved["measurements"]] == [16, 16]
    assert [r["intensity"]["2: Marker"]["mean"] for r in saved["measurements"]] == [200, 200]
    workbench.project.review(saved["result"]["id"], saved["result"]["revision_hash"], "reviewed")
    reopened = Workbench(ResearchProject(workbench.project.root))
    restored = reopened.execute("result", {"result_id": saved["result"]["id"]})
    assert restored["total_rows"] == 2
    assert restored["result"]["review"]["disposition"] == "reviewed"
    assert restored["provenance"]["measurement_basis"].startswith("raw-selected")
    labels = reopened.project.load_array(
        reopened.project.result(saved["result"]["id"])["arrays"]["labels"]
    )
    assert labels.shape == (7, 32, 32)
    assert labels.dtype == np.uint32
    assert hashlib.sha256(file.read_bytes()).hexdigest() == source["sha256"]


def test_orthogonal_crosshair_values_and_projection_scope(workbench, tmp_path):
    _, source = import_stack(workbench, tmp_path)
    volume = workbench.execute(
        "volume_view",
        {
            "source_id": source["id"],
            "selection": {"z": 0, "z_stop": 7},
            "crosshair": [1, 5, 5],
            "include_volume": True,
        },
    )
    assert set(volume["planes"]) == {"xy", "xz", "yz"}
    assert volume["value"] == 100
    assert volume["world_xyz"] == [2.5, 2.5, 2.0]
    assert volume["volume"]["purpose"] == "display-only-nearest-subsample"
    with pytest.raises(ValueError, match="explicit projection"):
        workbench.execute("view", {"source_id": source["id"], "selection": {"z": 0, "z_stop": 7}})
    projection = workbench.execute(
        "view", {"source_id": source["id"], "selection": {"z": 0, "z_stop": 7}, "projection": "max"}
    )
    assert projection["statistics"][0]["max"] == 150
    assert projection["projection"] == "max"


def test_invalid_processing_and_unknown_requests_are_rejected(workbench, tmp_path):
    _, source = import_stack(workbench, tmp_path)
    with pytest.raises(ValueError, match="unknown"):
        workbench.execute("run_recipe", {"source_id": source["id"], "shell": "uname"})
    with pytest.raises(ValueError, match="unknown|Unknown"):
        workbench.execute("shell", {"source_id": source["id"]})
    with pytest.raises(ValueError, match="working-memory"):
        workbench.execute(
            "validate_recipe", {"source_id": source["id"], "recipe": {"working_bytes": 1024}}
        )
    with pytest.raises(ValueError):
        workbench.execute("view", {"source_id": source["id"], "selection": {"c": 99}})


def test_rgb_is_not_a_biological_channel(workbench, tmp_path):
    image = tmp_path / "rgb.tif"
    tifffile.imwrite(image, np.full((16, 16, 3), 100, np.uint8), photometric="rgb")
    source = workbench.import_native(str(image))
    viewed = workbench.execute("view", {"source_id": source["id"]})
    assert viewed["display"][0]["basis"].startswith("RGB samples")
    with pytest.raises(ValueError, match="not biological channels"):
        workbench.execute(
            "run_recipe", {"source_id": source["id"], "recipe": {"segmentation": {"threshold": 50}}}
        )


def test_sample_and_saved_recipe_survive_reopen(workbench, tmp_path):
    _, source = import_stack(workbench, tmp_path)
    sample = workbench.execute(
        "sample",
        {
            "id": source["id"],
            "data": {
                "study": "Native study",
                "sample": "sample A",
                "condition": "untreated",
                "biological_replicate": "animal 1",
            },
        },
    )
    assert sample["revision"] == 1
    saved = workbench.execute(
        "recipe",
        {
            "id": "a" * 32,
            "source_id": source["id"],
            "data": {
                "name": "nuclei",
                "recipe": {"segmentation": {"threshold": 50}},
            },
        },
    )
    reopened = Workbench(ResearchProject(workbench.project.root))
    assert reopened.snapshot()["recipes"] == [saved]
    assert reopened.snapshot()["samples"] == [sample]


def test_source_edit_after_import_blocks_analysis(workbench, tmp_path):
    file, source = import_stack(workbench, tmp_path)
    with file.open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(RuntimeError, match="changed"):
        workbench.execute("run_recipe", {"source_id": source["id"]})
    assert workbench.project.list_results() == []


def test_declared_histology_tiff_exact_stain_basis_and_rejects_inference(workbench, tmp_path):
    from skimage.color import hdx_from_rgb, separate_stains

    image = tmp_path / "brightfield.tif"
    rgb = np.full((16, 16, 3), 240, np.uint8)
    rgb[4:12, 5:10] = [65, 42, 120]
    tifffile.imwrite(image, rgb, photometric="rgb")
    source = workbench.import_native(str(image))
    request = {"source_id": source["id"], "basis": "H-DAB", "component": 1}
    saved = workbench.execute("histology_run", request)
    result = workbench.project.result(saved["result"]["id"])
    np.testing.assert_array_equal(
        workbench.project.load_array(result["arrays"]["image"]),
        separate_stains(rgb, hdx_from_rgb)[..., 1],
    )
    with pytest.raises(ValueError, match="does not infer"):
        workbench.execute("histology_preview", {"source_id": source["id"]})
    _, scalar = import_stack(workbench, tmp_path)
    with pytest.raises(ValueError, match="RGB brightfield"):
        workbench.execute("histology_preview", {**request, "source_id": scalar["id"]})


def test_bound_flatfield_uses_declared_formula_and_rechecks_reference(workbench, tmp_path):
    raw = np.arange(1, 65, dtype=np.uint16).reshape(8, 8)
    flat = np.tile(np.arange(1, 9, dtype=np.uint16), (8, 1))
    ids = []
    for name, array in [("raw", raw), ("flat", flat)]:
        file = tmp_path / f"{name}.tif"
        tifffile.imwrite(file, array)
        ids.append(workbench.import_native(str(file))["id"])
    request = {
        "source_id": ids[0],
        "recipe": {
            "steps": [{"op": "flatfield"}],
            "references": {"flatfield": {"source_id": ids[1]}},
        },
    }
    saved = workbench.execute("run_recipe", request)
    result = workbench.project.result(saved["result"]["id"])
    np.testing.assert_allclose(
        workbench.project.load_array(result["arrays"]["image"]),
        raw / flat * np.mean(flat),
        rtol=0,
        atol=1e-14,
    )
    assert (
        result["provenance"]["references"]["flatfield"]["source_sha256"]
        == workbench.project.source(ids[1])["sha256"]
    )
    assert (
        hashlib.sha256((tmp_path / "raw.tif").read_bytes()).hexdigest()
        == workbench.project.source(ids[0])["sha256"]
    )
    with (tmp_path / "flat.tif").open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises((RuntimeError, ValueError), match="changed"):
        workbench.execute("preview_recipe", request)


def test_study_summary_is_review_bound_and_does_not_count_images_as_replicates(workbench, tmp_path):
    results = []
    for index in range(2):
        path = tmp_path / f"sample{index}.tif"
        values = np.zeros((8, 8), dtype=np.uint8)
        values[2:4, 2:4] = 100
        tifffile.imwrite(path, values)
        source = workbench.import_native(str(path))
        workbench.execute(
            "sample",
            {
                "id": source["id"],
                "data": {
                    "study": "Native study",
                    "sample": f"section{index}",
                    "condition": "control",
                    "biological_replicate": "animal1",
                },
            },
        )
        result = workbench.execute(
            "run_recipe",
            {
                "source_id": source["id"],
                "recipe": {"segmentation": {"method": "components", "threshold": 50}},
            },
        )["result"]
        results.append(result)
    with pytest.raises(ValueError, match="reviewed"):
        workbench.execute("study_summary", {"result_ids": [r["id"] for r in results]})
    for result in results:
        workbench.project.review(result["id"], result["revision_hash"], "reviewed")
    summary = workbench.execute("study_summary", {"result_ids": [r["id"] for r in results]})
    assert summary["summaries"][0]["n_biological_replicates"] == 1
    assert summary["summaries"][0]["n_images"] == 2
    assert summary["summaries"][0]["mean"] == 4
    assert summary["record_audit"][0]["revision_hash"] == results[0]["revision_hash"]


def test_native_ims_selected_level_centre_origin_reaches_workbench_and_saved_results(
    workbench, tmp_path
):
    from test_native_image import _write_ims

    path = tmp_path / "translated.ims"
    _write_ims(path)
    source = workbench.import_native(str(path))
    selection = {"level": 1, "x": 1, "y": 1, "width": 3, "height": 2, "z": 1, "z_stop": 3}
    array, geometry, _ = workbench.load_scalar(source["id"], selection)
    np.testing.assert_array_equal(geometry.world(np.array([[0, 0, 0]])), [[1.5, 13, 2]])
    assert geometry.spacing == (2, 2, 1)
    assert list(source["metadata"]["timing"]["elapsed_times"]) == [0.0, 0.75, 2.0]
    result = workbench.run_recipe({"source_id": source["id"], "selection": selection})["result"]
    restored = workbench.project.result(result["id"])
    np.testing.assert_array_equal(restored["provenance"]["geometry"]["affine"], geometry.affine)
    np.testing.assert_array_equal(workbench.project.load_array(restored["arrays"]["image"]), array)


def test_declared_channel_metadata_preserves_acquisition_and_executed_names(workbench, tmp_path):
    file, source = import_stack(workbench, tmp_path)
    declaration = [
        {
            "index": 0,
            "name": "Declared DNA",
            "marker": "DNA",
            "fluorophore": "user supplied",
            "declaration": "Acquisition notebook",
        },
        {
            "index": 1,
            "name": "Declared marker",
            "marker": "",
            "fluorophore": "",
            "declaration": "Control panel",
        },
    ]
    saved = workbench.execute("channels", {"source_id": source["id"], "channels": declaration})
    assert saved["original_names"] == ["Nuclei", "Marker"]
    request = {
        "source_id": source["id"],
        "selection": {"z": 0, "z_stop": 7},
        "recipe": {
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0, 1],
        },
    }
    result = workbench.execute("run_recipe", request)["result"]
    frozen = workbench.project.result(result["id"])
    assert frozen["provenance"]["measurements"][0]["intensity"]["2: Declared marker"]["mean"] == 200
    declaration[1]["name"] = "Later interpretation"
    workbench.execute(
        "channels", {"source_id": source["id"], "channels": declaration, "expected_revision": 1}
    )
    binding = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    info = workbench.execute("correction_info", binding)
    child = workbench.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "merge",
                    "expected_input_sha256": info["label_sha256"],
                    "source_labels": [1, 2],
                    "target_label": 2,
                }
            ],
        },
    )
    assert child["measurements"][0]["intensity"]["2: Declared marker"]["mean"] == 200
    assert workbench.project.result(result["id"]) == frozen
    reopened = Workbench(ResearchProject(workbench.project.root))
    assert (
        reopened.execute("channel_metadata", {"source_id": source["id"]})["channels"][1]["name"]
        == "Later interpretation"
    )
    assert reopened.project.source(source["id"])["metadata"]["channel_names"] == [
        "Nuclei",
        "Marker",
    ]
    assert hashlib.sha256(file.read_bytes()).hexdigest() == source["sha256"]
    with pytest.raises(ValueError, match="changed"):
        workbench.execute(
            "channels", {"source_id": source["id"], "channels": declaration, "expected_revision": 0}
        )


def test_rgb_samples_cannot_be_relabelled_as_biological_channels(workbench, tmp_path):
    from PIL import Image

    file = tmp_path / "rgb.png"
    Image.fromarray(np.zeros((10, 12, 3), np.uint8)).save(file)
    source = workbench.import_native(str(file))
    with pytest.raises(ValueError, match="RGB"):
        workbench.execute(
            "channels", {"source_id": source["id"], "channels": [{"index": 0, "name": "DNA"}]}
        )
