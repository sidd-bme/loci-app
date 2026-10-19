"""Independent support/orientation checks for the separate label-only image."""

import base64
import hashlib
import io

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


@pytest.fixture
def workbench(tmp_path):
    active = Workbench(ResearchProject.create(tmp_path / "overlay.loci-study", "Overlay"))
    yield active
    active.close()


def save_fixture(workbench, tmp_path, axes="YX", *, include_labels=True):
    shape = (5, 7) if axes == "YX" else (3, 5, 7)
    raw = np.arange(np.prod(shape), dtype=np.uint16).reshape(shape)
    labels = np.zeros(shape, dtype=np.uint32)
    if axes == "YX":
        labels[0:2, 5] = 7
        labels[3, 1:3] = 70000
        labels[4, 1] = 70000
        geometry = Geometry.diagonal((2.0, 0.5), "um")
    else:
        # Asymmetric Z/Y/X coordinates distinguish every orthogonal plane.
        labels[:, 1, 5] = 7
        labels[1:3, 3, 1:3] = 70000
        geometry = Geometry.diagonal((4.0, 2.0, 0.5), "um")
    path = tmp_path / f"{axes}.ome.tif"
    metadata = {
        "axes": axes,
        "PhysicalSizeX": 0.5,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeY": 2.0,
        "PhysicalSizeYUnit": "µm",
    }
    if axes == "ZYX":
        metadata.update(PhysicalSizeZ=4.0, PhysicalSizeZUnit="µm")
    tifffile.imwrite(path, raw, ome=True, photometric="minisblack", metadata=metadata)
    source = workbench.import_native(str(path))
    rows = measure_objects(labels, geometry, {"raw": raw}) if include_labels else []
    result = workbench.project.save_result(
        source_id=source["id"],
        kind="segmentation" if include_labels else "processed",
        arrays={"image": raw, **({"labels": labels} if include_labels else {})},
        provenance={
            "geometry": geometry.to_dict(),
            "measurements": rows,
            "measurement_basis": "raw-selected-channel-values-on-result-grid",
        },
    )
    return result, raw, labels, path


def decode(uri, expected_mode):
    assert uri.startswith("data:image/png;base64,")
    with Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))) as image:
        assert image.mode == expected_mode
        return np.array(image)


def assert_alpha_support(rgba, expected_labels):
    assert rgba.shape == (*expected_labels.shape, 4)
    expected_alpha = np.zeros(expected_labels.shape, dtype=np.uint8)
    expected_alpha[expected_labels > 0] = 150
    np.testing.assert_array_equal(rgba[..., 3], expected_alpha)


def test_2d_overlay_has_exact_transparent_background_and_identity_colors(workbench, tmp_path):
    result, _, labels, _ = save_fixture(workbench, tmp_path)
    response = workbench.result_view({"result_id": result["id"]})
    rgba = decode(response["label_image"], "RGBA")
    assert_alpha_support(rgba, labels)
    assert response["axis"] == "z"
    assert response["index"] == 0
    assert response["shape"] == [5, 7]
    # The color represents the instance ID, consistently across all its pixels.
    colors = {}
    for label in (7, 70000):
        object_colors = np.unique(rgba[labels == label, :3], axis=0)
        assert object_colors.shape == (1, 3)
        colors[label] = object_colors[0]
    assert not np.array_equal(colors[7], colors[70000])
    assert (
        workbench.result_view({"result_id": result["id"]})["label_image"] == response["label_image"]
    )


@pytest.mark.parametrize("axis,index", [("z", 1), ("y", 3), ("x", 5)])
def test_anisotropic_zyx_overlay_uses_asymmetric_plane_coordinates(
    workbench, tmp_path, axis, index
):
    result, _, _, _ = save_fixture(workbench, tmp_path, "ZYX")
    response = workbench.result_view({"result_id": result["id"], "axis": axis, "index": index})
    rgba = decode(response["label_image"], "RGBA")
    # These explicit 2D maps are independent of the implementation's np.take.
    if axis == "z":
        expected = np.zeros((5, 7), dtype=np.uint32)  # Y rows, X columns.
        expected[1, 5] = 7
        expected[3, 1:3] = 70000
    elif axis == "y":
        expected = np.zeros((3, 7), dtype=np.uint32)  # Z rows, X columns.
        expected[1:3, 1:3] = 70000
    else:
        expected = np.zeros((3, 5), dtype=np.uint32)  # Z rows, Y columns.
        expected[:, 1] = 7
    assert_alpha_support(rgba, expected)
    assert response["axis"] == axis
    assert response["index"] == index
    assert response["shape"] == [3, 5, 7]
    assert response["geometry"]["axes"] == "ZYX"
    assert response["geometry"]["unit"] == "um"
    np.testing.assert_array_equal(np.diag(response["geometry"]["affine"]), [0.5, 2, 4, 1])
    for label in (7, 70000):
        if np.any(expected == label):
            assert np.unique(rgba[expected == label, :3], axis=0).shape == (1, 3)


def test_instance_colors_are_stable_across_orthogonal_plane_views(workbench, tmp_path):
    result, _, _, _ = save_fixture(workbench, tmp_path, "ZYX")
    xy = decode(
        workbench.result_view({"result_id": result["id"], "axis": "z", "index": 1})["label_image"],
        "RGBA",
    )
    xz = decode(
        workbench.result_view({"result_id": result["id"], "axis": "y", "index": 3})["label_image"],
        "RGBA",
    )
    yz = decode(
        workbench.result_view({"result_id": result["id"], "axis": "x", "index": 5})["label_image"],
        "RGBA",
    )
    np.testing.assert_array_equal(xy[1, 5], yz[2, 1])
    np.testing.assert_array_equal(xy[3, 1], xz[2, 2])
    assert not np.array_equal(xy[1, 5, :3], xy[3, 1, :3])


@pytest.mark.parametrize("axes", ["YX", "ZYX"])
def test_display_and_label_settings_preserve_arrays_measurements_and_source(
    workbench, tmp_path, axes
):
    result, raw, labels, path = save_fixture(workbench, tmp_path, axes)
    stored_before = workbench.project.result(result["id"])
    record_before = canonical_json(stored_before)
    array_hashes = {
        name: hashlib.sha256(
            (workbench.project.arrays / (artifact["sha256"] + ".npy")).read_bytes()
        ).hexdigest()
        for name, artifact in stored_before["arrays"].items()
    }
    source_before = path.read_bytes()
    request = {"result_id": result["id"], **({"axis": "z", "index": 1} if axes == "ZYX" else {})}
    original = workbench.result_view(request)
    modified = workbench.result_view(
        {
            **request,
            "display": {
                "low": 0,
                "high": 1000,
                "gamma": 2.0,
                "color": "#ff0000",
                "visible": True,
            },
        }
    )
    hidden = workbench.result_view({**request, "labels": False})
    assert modified["label_image"] == original["label_image"]
    assert modified["image"] != original["image"]
    assert hidden["label_image"] is None
    original_image = decode(original["image"], "RGB")
    hidden_image = decode(hidden["image"], "RGB")
    support = labels > 0 if axes == "YX" else labels[1] > 0
    np.testing.assert_array_equal(original_image[~support], hidden_image[~support])
    assert np.any(original_image[support] != hidden_image[support])
    assert canonical_json(workbench.project.result(result["id"])) == record_before
    np.testing.assert_array_equal(workbench.project.load_array(result["arrays"]["image"]), raw)
    np.testing.assert_array_equal(workbench.project.load_array(result["arrays"]["labels"]), labels)
    assert path.read_bytes() == source_before
    assert {
        name: hashlib.sha256(
            (workbench.project.arrays / (artifact["sha256"] + ".npy")).read_bytes()
        ).hexdigest()
        for name, artifact in stored_before["arrays"].items()
    } == array_hashes
    # Independent geometry and membership checks make the immutable measurements inspectable.
    rows = workbench.project.result(result["id"])["provenance"]["measurements"]
    assert [row["label"] for row in rows] == [7, 70000]
    expected_counts = [2, 3] if axes == "YX" else [3, 4]
    assert [row["voxel_count"] for row in rows] == expected_counts
    assert [row["measure"] for row in rows] == pytest.approx(
        [count * (1 if axes == "YX" else 4) for count in expected_counts], rel=1e-12
    )


@pytest.mark.parametrize("axes", ["YX", "ZYX"])
def test_result_without_labels_has_no_label_image(workbench, tmp_path, axes):
    result, _, _, _ = save_fixture(workbench, tmp_path, axes, include_labels=False)
    for show_labels in (True, False):
        response = workbench.result_view({"result_id": result["id"], "labels": show_labels})
        assert response["label_image"] is None
        decode(response["image"], "RGB")
