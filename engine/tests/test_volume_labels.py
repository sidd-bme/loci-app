"""Independent exact categorical payload and source-grid refusal oracles."""

import base64
import copy
import hashlib
import json

import numpy as np
import pytest
import SimpleITK as sitk
import tifffile
from test_ome_zarr import _store

from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.volume_labels import volume_labels
from loci_engine.workbench import Workbench


@pytest.fixture(params=["native", "medical", "ome_zarr"])
def scene(tmp_path, request):
    kind = request.param
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Exact label payload"))
    raw = np.arange(2 * 2 * 6 * 9 * 10, dtype=np.uint16).reshape(2, 2, 6, 9, 10)
    if kind == "native":
        path = tmp_path / "raw.ome.tif"
        tifffile.imwrite(
            path,
            raw,
            ome=True,
            photometric="minisblack",
            metadata={
                "axes": "TCZYX",
                "PhysicalSizeX": 0.5,
                "PhysicalSizeY": 1.5,
                "PhysicalSizeZ": 2.5,
            },
        )
        source = wb.import_native(str(path))
        expected = np.array([[0.5, 0, 0, 1], [0, 1.5, 0, 1.5], [0, 0, 2.5, 2.5], [0, 0, 0, 1]])
    elif kind == "medical":
        path = tmp_path / "raw.nii"
        image = sitk.GetImageFromArray(raw[0, 0])
        image.SetOrigin((10, 20, 30))
        image.SetSpacing((0.5, 1.5, 2.5))
        image.SetDirection((0, -1, 0, 1, 0, 0, 0, 0, 1))
        sitk.WriteImage(image, str(path), False)
        source = wb.project.register_medical_source(str(path))
        expected = np.array([[0, -1.5, 0, 8.5], [0.5, 0, 0, 21], [0, 0, 2.5, 32.5], [0, 0, 0, 1]])
    else:
        path, _ = _store(tmp_path / "raw", shapes=((2, 2, 6, 9, 10),))
        source = wb.import_native(str(path))
        expected = np.array([[0.25, 0, 0, 30.5], [0, 0.5, 0, 20.5], [0, 0, 2, 2], [0, 0, 0, 1]])
    selected_t = 0 if kind == "medical" else 1
    selection = {
        "x": 2,
        "y": 1,
        "width": 5,
        "height": 6,
        "z": 1,
        "z_stop": 5,
        "t": selected_t,
        "c": 0 if kind == "medical" else 1,
        "level": 0,
    }
    image, geometry, selection = wb.load_scalar(source["id"], selection)
    labels = np.zeros((4, 6, 5), np.uint32)
    labels[:, 1:3, 1:3] = 65536
    labels[0, 0, 0] = labels[3, 5, 4] = 2**32 - 1
    labels[2, 4, 3] = 17
    result = wb.project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        provenance={"selection": selection, "geometry": geometry.to_dict()},
    )
    query = {
        "source_id": source["id"],
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "t": selected_t,
    }
    yield wb, source, path, result, labels, query, expected
    wb.close()


def replace_record(scene, change):
    wb, _, _, old, _, query, _ = scene
    updated = copy.deepcopy(wb.project.result(old["id"], verify_scientific_arrays=False))
    change(updated)
    updated.pop("revision_hash")
    updated["revision_hash"] = hashlib.sha256(canonical_json(updated).encode()).hexdigest()
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(updated), old["id"])
        )
    query["revision_hash"] = updated["revision_hash"]


def test_exact_sparse_uint32_data_hashes_crop_offset_and_calibration(scene):
    wb, source, path, result, labels, query, expected = scene
    payload = volume_labels(wb, query)
    assert payload["schema"] == "loci.volume-labels/v1"
    assert payload["source_id"] == source["id"] and payload["source_sha256"] == source["sha256"]
    assert payload["t"] == query["t"]
    assert payload["dimensions_xyz"] == [5, 6, 4]
    assert payload["source_offset_xyz"] == [2, 1, 1]
    assert payload["scalar_type"] == "uint32"
    assert payload["sampling"] == "exact-native-grid" and payload["interpolation"] == "nearest"
    data = base64.b64decode(payload["data_base64"], validate=True)
    assert payload["byte_length"] == 4 * 6 * 5 * 4 == len(data)
    assert payload["data_sha256"] == hashlib.sha256(data).hexdigest()
    np.testing.assert_array_equal(np.frombuffer(data, dtype="<u4").reshape(4, 6, 5), labels)
    metadata = json.dumps(
        {"dtype": "<u4", "shape": [4, 6, 5]}, sort_keys=True, separators=(",", ":")
    )
    identity = hashlib.sha256(
        b"loci-label-array-v1\0" + metadata.encode() + b"\0" + data
    ).hexdigest()
    assert payload["result"] == {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "label_sha256": identity,
    }
    assert identity != payload["data_sha256"] and identity != result["arrays"]["labels"]["sha256"]
    np.testing.assert_allclose(payload["affine_4x4"], expected, rtol=0, atol=1e-9)
    np.testing.assert_allclose(payload["origin_xyz"], expected[:3, 3], rtol=0, atol=1e-9)
    spacing = np.linalg.norm(expected[:3, :3], axis=0)
    np.testing.assert_allclose(payload["spacing_xyz"], spacing, rtol=0, atol=1e-9)
    np.testing.assert_allclose(
        payload["direction_3x3"], (expected[:3, :3] / spacing).T.ravel(), rtol=0, atol=1e-9
    )
    assert payload["unit"] == ("mm" if source["source_kind"] == "medical" else "um")
    assert payload["frame"] == ("LPS" if source["source_kind"] == "medical" else "image")
    assert str(path) not in canonical_json(payload)
    assert len(wb.project.list_results()) == 1
    assert wb.execute("volume_labels", query) == payload


@pytest.mark.parametrize("bad", ["revision", "time", "time-bool", "extra", "missing"])
def test_request_requires_exact_binding_before_label_load(scene, monkeypatch, bad):
    wb, _, _, _, _, query, _ = scene
    query = copy.deepcopy(query)
    if bad == "revision":
        query["revision_hash"] = "0" * 64
    elif bad == "time":
        query["t"] += 1
    elif bad == "time-bool":
        query["t"] = True
    elif bad == "extra":
        query["path"] = "/private/untrusted.tif"
    else:
        query.pop("t")
    monkeypatch.setattr(
        wb.project, "load_array", lambda *args: pytest.fail("No invalid-binding array load")
    )
    with pytest.raises(ValueError):
        volume_labels(wb, query)


@pytest.mark.parametrize(
    "bad",
    [
        "shape",
        "dtype",
        "2d",
        "zero",
        "boolean",
        "oversized",
        "missing-z-stop",
        "missing-t",
        "crop-bounds",
        "z-bounds",
        "z-shape",
        "unit",
        "frame",
        "offset",
        "spacing",
        "axes",
        "source-id",
        "source-sha",
    ],
)
def test_incompatible_result_refuses_before_label_load(scene, monkeypatch, bad):
    wb, _, _, _, _, query, _ = scene

    def change(result):
        descriptor, provenance = result["arrays"]["labels"], result["provenance"]
        selection, geometry = provenance["selection"], provenance["geometry"]
        if bad == "shape":
            descriptor["shape"][2] += 1
        elif bad == "dtype":
            descriptor["dtype"] = "uint16"
        elif bad == "2d":
            descriptor["shape"] = [6, 5]
        elif bad == "zero":
            descriptor["shape"][1] = 0
        elif bad == "boolean":
            descriptor["shape"][1] = True
        elif bad == "oversized":
            descriptor["shape"] = [256, 256, 256]
        elif bad == "missing-z-stop":
            selection.pop("z_stop")
        elif bad == "missing-t":
            selection.pop("t")
        elif bad == "crop-bounds":
            selection["x"] = 9
        elif bad == "z-bounds":
            selection["z_stop"] = 7
        elif bad == "z-shape":
            selection["z_stop"] = 4
        elif bad == "unit":
            geometry["unit"] = "pixel"
        elif bad == "frame":
            geometry["frame"] = "RAS" if geometry["frame"] != "RAS" else "LPS"
        elif bad == "offset":
            geometry["affine"][2][3] += 1
        elif bad == "spacing":
            geometry["affine"][2][2] *= 2
        elif bad == "axes":
            geometry["axes"] = "YX"
        elif bad == "source-id":
            result["source_id"] = "a" * 32
        else:
            result["source_sha256"] = "0" * 64

    replace_record(scene, change)
    monkeypatch.setattr(
        wb.project, "load_array", lambda *args: pytest.fail("No incompatible-grid array load")
    )
    with pytest.raises(ValueError):
        volume_labels(wb, query)


@pytest.mark.parametrize("tamper", ["artifact", "revision", "source"])
def test_stale_or_tampered_files_never_return_payload(scene, tamper):
    wb, _, path, result, _, query, _ = scene
    if tamper == "artifact":
        file = wb.project.arrays / (result["arrays"]["labels"]["sha256"] + ".npy")
        data = file.read_bytes()
        file.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
    elif tamper == "revision":
        changed = copy.deepcopy(result)
        changed["provenance"]["selection"]["z"] = 0
        with wb.project.connection() as connection:
            connection.execute(
                "UPDATE results SET record=? WHERE id=?", (canonical_json(changed), result["id"])
            )
    elif path.is_file():
        with path.open("ab") as stream:
            stream.write(b"changed")
    else:
        (path / "unexpected.txt").write_text("changed")
    with pytest.raises((ValueError, RuntimeError)):
        volume_labels(wb, query)


@pytest.mark.parametrize("mutation", ["source", "result"])
def test_binding_mutation_during_payload_preparation_refuses(scene, monkeypatch, mutation):
    wb, _, path, _, _, query, _ = scene
    original = wb.project.load_array

    def load(descriptor):
        labels = original(descriptor)
        if mutation == "source":
            if path.is_file():
                with path.open("ab") as stream:
                    stream.write(b"changed")
            else:
                (path / "unexpected.txt").write_text("changed")
        else:
            replace_record(scene, lambda result: result["provenance"]["selection"].update(z=0))
        return labels

    monkeypatch.setattr(wb.project, "load_array", load)
    with pytest.raises((ValueError, RuntimeError)):
        volume_labels(wb, query)


def test_artifact_mutation_between_initial_hash_and_copy_refuses(scene, monkeypatch):
    wb, _, _, _, _, query, _ = scene
    original = wb.project._open_array_artifact

    def open_changed(descriptor):
        file, digest, size, labels = original(descriptor)
        with file.open("r+b") as stream:
            stream.seek(-1, 2)
            last = stream.read(1)
            stream.seek(-1, 2)
            stream.write(bytes([last[0] ^ 1]))
        return file, digest, size, labels

    monkeypatch.setattr(wb.project, "_open_array_artifact", open_changed)
    with pytest.raises(ValueError, match="changed"):
        volume_labels(wb, query)


@pytest.mark.parametrize("bad", ["provenance", "geometry", "arrays", "labels", "level", "one-z"])
def test_missing_or_nonvolumetric_result_state_fails_closed(scene, monkeypatch, bad):
    wb, _, _, _, _, query, _ = scene

    def change(result):
        if bad in {"provenance", "arrays"}:
            result[bad] = None
        elif bad == "geometry":
            result["provenance"]["geometry"] = None
        elif bad == "labels":
            result["arrays"].pop("labels")
        elif bad == "level":
            result["provenance"]["selection"]["level"] = 1
        else:
            result["arrays"]["labels"]["shape"][0] = 1
            result["provenance"]["selection"]["z_stop"] = 2

    replace_record(scene, change)
    monkeypatch.setattr(
        wb.project, "load_array", lambda *args: pytest.fail("No incompatible label load")
    )
    with pytest.raises(ValueError):
        volume_labels(wb, query)


def test_grid_helper_verifies_available_source_without_loading_labels(scene, monkeypatch):
    from loci_engine.volume_labels import validate_volume_label_grid

    wb, source, path, result, _, _, expected = scene
    monkeypatch.setattr(
        wb.project, "load_array", lambda *args: pytest.fail("Grid metadata must not decode labels")
    )
    resolved, geometry = validate_volume_label_grid(wb, source, result)
    assert resolved == result["provenance"]["selection"]
    np.testing.assert_allclose(geometry.affine, expected, rtol=0, atol=1e-9)
    # Scene reads can use retained bindings elsewhere; this write oracle needs raw source access.
    hidden = path.with_name("temporarily-unavailable" + path.suffix)
    path.rename(hidden)
    try:
        with pytest.raises((ValueError, RuntimeError)) as error:
            validate_volume_label_grid(wb, source, result)
        assert str(path) not in str(error.value)
    finally:
        hidden.rename(path)


def test_missing_label_artifact_error_is_path_redacted(scene):
    wb, _, _, result, _, query, _ = scene
    file = wb.project.arrays / (result["arrays"]["labels"]["sha256"] + ".npy")
    file.unlink()
    with pytest.raises(ValueError, match="unavailable") as error:
        volume_labels(wb, query)
    assert str(file) not in str(error.value)
