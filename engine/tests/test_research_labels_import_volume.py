"""Exact ZYX import oracles; technical grid checks, not segmentation validation."""

import base64
import copy
import hashlib
import io
import zipfile

import numpy as np
import pytest
import tifffile
from PIL import Image

from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_labels_import import (
    VOLUME_ALIGNMENT,
    VOLUME_PROFILE,
    create_import_grant,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench, display_scalar


@pytest.fixture
def volume(tmp_path):
    t, c, z, y, x = np.indices((2, 2, 6, 16, 20))
    raw = (10000 * t + 3000 * c + 200 * z + 5 * y + x).astype(np.uint16)
    source_path = tmp_path / "raw-volume.ome.tif"
    tifffile.imwrite(
        source_path,
        raw,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.5,
            "PhysicalSizeZ": 2.5,
            "Channel": {"Name": ["DNA", "Marker"]},
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Exact ZYX labels"))
    source = wb.import_native(str(source_path))
    selection = {"t": 1, "c": 1, "z": 1, "z_stop": 5, "level": 0}
    labels = np.zeros((4, 16, 20), np.uint32)
    labels[:, 2:5, 3:7] = 17
    labels[0, 8, 9] = labels[3, 10, 11] = 65536
    labels[1, 13, 16] = 2**32 - 1
    file = tmp_path / "volume-labels.tif"
    tifffile.imwrite(file, labels, photometric="minisblack", metadata={"axes": "ZYX"})
    yield wb, source, source_path, selection, labels, file, raw[1, 1, 1:5]
    wb.close()


def preview(volume, **kwargs):
    wb, source, _, selection, _, file, _ = volume
    return create_import_grant(wb, str(file), source["id"], source["sha256"], selection, **kwargs)


def request(volume, grant, **kwargs):
    return {
        "source_id": volume[1]["id"],
        "source_sha256": volume[1]["sha256"],
        "grant_id": grant["grant_id"],
        "alignment": VOLUME_ALIGNMENT,
        **kwargs,
    }


def assert_measurements(result, labels, raw):
    rows = result["provenance"]["measurements"]
    assert [row["label"] for row in rows] == [17, 65536, 2**32 - 1]
    for row in rows:
        mask = labels == row["label"]
        count = int(mask.sum())
        assert row["voxel_count"] == count
        assert row["measure_kind"] == "volume"
        assert row["measure_unit"] == "um^3"
        assert row["measure"] == pytest.approx(count * 0.5 * 1.5 * 2.5)
        assert row["index_axes"] == "ZYX"
        center = np.argwhere(mask).mean(axis=0)
        np.testing.assert_allclose(row["centroid_index"], center, rtol=0, atol=1e-12)
        np.testing.assert_allclose(
            row["centroid_world_xyz"],
            [center[2] * 0.5, center[1] * 1.5, (center[0] + 1) * 2.5],
            rtol=0,
            atol=1e-12,
        )
        intensity = row["intensity"]["2: Marker"]
        assert intensity["mean"] == raw[mask].astype(np.float64).mean()
        assert intensity["sum"] == raw[mask].astype(np.float64).sum()


@pytest.mark.parametrize("codec,tiled", [(None, False), ("deflate", False), ("lzw", True)])
def test_exact_volume_sparse_ids_raw_values_anisotropy_offset_and_middle_preview(
    volume, monkeypatch, codec, tiled
):
    wb, _, source_path, selection, labels, file, raw = volume
    tifffile.imwrite(
        file,
        labels,
        photometric="minisblack",
        metadata={"axes": "ZYX"},
        compression=codec,
        **({"tile": (16, 16)} if tiled else {"rowsperstrip": 4}),
    )
    source_bytes, label_bytes = source_path.read_bytes(), file.read_bytes()

    def deny_asarray(*args, **kwargs):
        pytest.fail("TIFF import must use bounded per-plane segments, never unrestricted asarray")

    monkeypatch.setattr(tifffile.TiffPage, "asarray", deny_asarray)
    monkeypatch.setattr(tifffile.TiffPageSeries, "asarray", deny_asarray)
    grant = preview(volume)
    assert grant["profile"] == VOLUME_PROFILE
    assert grant["axes"] == "ZYX" and grant["shape"] == [4, 16, 20]
    assert grant["object_count"] == 3  # ID 17 spanning all four planes is one object
    assert grant["labels_sha256"] == hashlib.sha256(labels.tobytes()).hexdigest()
    preview_selection = {k: v for k, v in grant["selection"].items() if k != "z_stop"}
    preview_selection["z"] = 3
    assert grant["preview"] == {
        "plane": "XY",
        "index": 2,
        "source_z": 3,
        "selection": preview_selection,
        "basis": "single-native-plane-overlay",
    }
    assert grant["selection"]["z_stop"] == selection["z_stop"]
    shown = np.array(Image.open(io.BytesIO(base64.b64decode(grant["image"].split(",")[1]))))
    expected_rgb, _ = display_scalar(raw[2], working_bytes=512 * 1024**2)
    tint = np.stack(
        [(labels[2].astype(np.uint64) * n % 223 + 32) / 255 for n in (67, 97, 137)], axis=-1
    )
    expected_rgb = np.where(
        (labels[2] > 0)[..., None], 0.6 * expected_rgb + 0.4 * tint, expected_rgb
    )
    np.testing.assert_array_equal(
        shown, np.round(np.clip(expected_rgb, 0, 1) * 255).astype(np.uint8)
    )
    output = wb.execute("labels_import", request(volume, grant))
    result = wb.project.result(output["result"]["id"])
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["labels"]), labels)
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["image"]), raw)
    assert_measurements(result, labels, raw)
    external = result["provenance"]["external_labels"]
    assert external["alignment"] == VOLUME_ALIGNMENT and external["preview"] == grant["preview"]
    assert result["provenance"]["geometry"]["axes"] == "ZYX"
    assert str(file) not in canonical_json(wb.snapshot())
    assert str(file) not in canonical_json(output)
    assert source_path.read_bytes() == source_bytes and file.read_bytes() == label_bytes


@pytest.mark.parametrize("mismatch", [None, "z", "xy-only", "position"])
def test_volume_ome_calibration_must_match_all_axes(volume, mismatch):
    metadata = {"axes": "ZYX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 1.5, "PhysicalSizeZ": 2.5}
    if mismatch == "z":
        metadata["PhysicalSizeZ"] = 2
    elif mismatch == "xy-only":
        metadata.pop("PhysicalSizeZ")
    elif mismatch == "position":
        metadata["Plane"] = {"PositionZ": [2.5, 5, 7.5, 10]}
    tifffile.imwrite(volume[5], volume[4], ome=True, photometric="minisblack", metadata=metadata)
    if mismatch:
        with pytest.raises(ValueError, match="calibration|position"):
            preview(volume)
        assert volume[0].project.documents("labels_import_grant") == []
    else:
        assert (
            preview(volume)["calibration_handling"]["microscopic_calibration"]
            == "verified-OME-spacing"
        )


@pytest.mark.parametrize("bad", ["depth", "axes", "xy", "one-plane", "no-stop", "range", "crop"])
def test_volume_reject_mismatched_or_ambiguous_grid(volume, bad):
    labels, file = volume[4:6]
    if bad == "depth":
        labels = labels[:3]
    elif bad == "xy":
        labels = labels[:, :-1]
    elif bad == "one-plane":
        volume[3]["z_stop"] = volume[3]["z"] + 1
    elif bad == "no-stop":
        volume[3].pop("z_stop")
    elif bad == "range":
        volume[3]["z_stop"] = 7
    elif bad == "crop":
        volume[3]["width"] = 19
    tifffile.imwrite(
        file, labels, photometric="minisblack", metadata={"axes": "QYX" if bad == "axes" else "ZYX"}
    )
    with pytest.raises(ValueError):
        preview(volume)
    assert volume[0].project.documents("labels_import_grant") == []


@pytest.mark.parametrize("bad", ["orientation", "spatial", "description", "segment"])
def test_volume_validates_later_page_metadata_and_segments(volume, bad):
    file = volume[5]
    with tifffile.TiffWriter(file) as writer:
        # The shaped declaration binds all four pages, including differing IFD tags.
        for index, plane in enumerate(volume[4]):
            writer.write(
                plane,
                metadata=None,
                description=canonical_json({"shape": [4, 16, 20], "axes": "ZYX"})
                if index == 0
                else ("unknown mapping" if bad == "description" and index == 3 else None),
                extratags=(
                    [(274, "H", 1, 2, False)]
                    if bad == "orientation" and index == 3
                    else [(286, "2I", 1, (1, 1), False)]
                    if bad == "spatial" and index == 3
                    else []
                ),
                photometric="minisblack",
                compression="deflate",
            )
    if bad == "segment":
        with tifffile.TiffFile(file, mode="r+b") as tif:
            tif.pages[3].tags["StripOffsets"].overwrite(2**30)
    with pytest.raises((ValueError, RuntimeError)):
        preview(volume)
    assert volume[0].project.documents("labels_import_grant") == []


@pytest.mark.parametrize("mutation", ["labels", "source", "grant-preview", "cancel", "guard"])
def test_volume_atomic_publication_revalidates_and_cancels(volume, monkeypatch, mutation):
    wb, _, source_path, _, _, file, _ = volume
    grant = preview(volume)
    with pytest.raises(ValueError, match="alignment"):
        wb.execute("labels_import", request(volume, grant, alignment="same-native-yx-grid"))
    job = submit_job(wb, request(volume, grant), "volume-import", "labels_import")
    original = wb.project.store_array
    called = False

    def stage(array):
        nonlocal called
        descriptor = original(array)
        if not called:
            called = True
            if mutation in {"labels", "source"}:
                with (file if mutation == "labels" else source_path).open("ab") as stream:
                    stream.write(b"changed")
            elif mutation == "grant-preview":
                envelope = wb.project.documents("labels_import_grant")[0]
                changed = copy.deepcopy(envelope)
                changed["data"]["preview"]["source_z"] += 1
                with wb.project.connection() as connection:
                    connection.execute(
                        "UPDATE documents SET record=? WHERE kind=? AND id=?",
                        (canonical_json(changed), "labels_import_grant", envelope["id"]),
                    )
            elif mutation == "cancel":
                cancel_job(wb.project, job["id"])
        return descriptor

    def deny():
        raise PermissionError("Approval revoked")

    monkeypatch.setattr(wb.project, "store_array", stage)
    with pytest.raises((ValueError, RuntimeError, PermissionError)):
        run_job(wb, job["id"], publication_guard=deny if mutation == "guard" else None)
    assert wb.project.list_results() == []
    assert str(file) not in canonical_json(wb.project.job(job["id"]))


def test_volume_import_reopen_export_and_portable_archive_preserve_ids_and_provenance(
    volume, tmp_path
):
    from loci_engine.research_export import export_research_result
    from loci_engine.research_interchange import export_project, import_project

    wb, _, _, _, labels, file, raw = volume
    output = wb.execute("labels_import", request(volume, preview(volume)))
    result = wb.project.result(output["result"]["id"])
    file.unlink()
    reopened = Workbench(ResearchProject(wb.project.root))
    try:
        assert reopened.project.result(result["id"])["provenance"] == result["provenance"]
        # Explicit technical-test review exercises the ordinary export gate.
        reopened.project.review(result["id"], result["revision_hash"], "reviewed")
        destination = tmp_path / "export"
        export_research_result(
            reopened.project, result["id"], result["revision_hash"], str(destination)
        )
        np.testing.assert_array_equal(tifffile.imread(destination / "labels.ome.tif"), labels)
        np.testing.assert_array_equal(
            np.load(destination / "labels.npy", allow_pickle=False), labels
        )
        assert str(2**32 - 1) in (destination / "objects.csv").read_text()
        methods = (destination / "methods.md").read_text()
        assert (
            VOLUME_PROFILE in methods and VOLUME_ALIGNMENT in methods and str(file) not in methods
        )
        archive = tmp_path / "portable.zip"
        export_project(reopened.project, str(archive))
        with zipfile.ZipFile(archive) as zipped:
            assert not any("labels_import_grant" in name for name in zipped.namelist())
            assert str(file).encode() not in b"".join(
                zipped.read(name) for name in zipped.namelist() if name.endswith(".json")
            )
        portable = import_project(str(archive), str(tmp_path / "restored"))
        assert portable.documents("labels_import_grant") == []
        restored = portable.result(result["id"])
        assert restored["provenance"] == result["provenance"]
        np.testing.assert_array_equal(portable.load_array(restored["arrays"]["labels"]), labels)
        np.testing.assert_array_equal(portable.load_array(restored["arrays"]["image"]), raw)
    finally:
        reopened.close()


def test_volume_combined_budget_before_decode(volume, monkeypatch, tmp_path):
    import loci_engine.research_labels_import as imports

    monkeypatch.setattr(
        imports, "_read_tiff_segments", lambda *args: pytest.fail("Decode must not run")
    )
    # Each plane alone fits the 1 MiB working allowance; the selected stack does not.
    source_path, file = tmp_path / "budget-source.tif", tmp_path / "budget-labels.tif"
    for path in (source_path, file):
        tifffile.imwrite(
            path,
            np.zeros((2, 64, 64), np.uint8),
            photometric="minisblack",
            metadata={"axes": "ZYX"},
            compression="deflate",
        )
    wb = volume[0]
    source = wb.import_native(str(source_path))
    with pytest.raises(ValueError, match="Combined.*bounds"):
        create_import_grant(
            wb,
            str(file),
            source["id"],
            source["sha256"],
            {"t": 0, "c": 0, "z": 0, "z_stop": 2, "level": 0},
            working_bytes=1024**2,
        )


@pytest.mark.parametrize("mutation", ["labels", "source", "channels", "grant-preview"])
def test_volume_stale_preview_refuses_before_measurement(volume, monkeypatch, mutation):
    import loci_engine.research_labels_import as imports

    wb, _, source_path, _, _, file, _ = volume
    grant = preview(volume)
    if mutation in {"labels", "source"}:
        with (file if mutation == "labels" else source_path).open("ab") as stream:
            stream.write(b"changed after preview")
    elif mutation == "channels":
        original = wb.channel_metadata
        monkeypatch.setattr(
            wb,
            "channel_metadata",
            lambda source_id: {
                **original(source_id),
                "changed_after_preview": True,
            },
        )
    else:
        envelope = wb.project.documents("labels_import_grant")[0]
        changed = copy.deepcopy(envelope)
        changed["data"]["preview"]["index"] = 0
        with wb.project.connection() as connection:
            connection.execute(
                "UPDATE documents SET record=? WHERE kind=? AND id=?",
                (canonical_json(changed), "labels_import_grant", envelope["id"]),
            )
    monkeypatch.setattr(
        imports,
        "measure_objects",
        lambda *args, **kwargs: pytest.fail("No measurement of stale inputs"),
    )
    with pytest.raises((ValueError, RuntimeError)):
        wb.execute("labels_import", request(volume, grant))
    assert wb.project.list_results() == []


def test_volume_limits_combined_object_allocations_before_source_load(volume, monkeypatch):
    import loci_engine.research_labels_import as imports

    labels = volume[4].copy()
    labels.ravel()[:150] = np.arange(1, 151, dtype=np.uint32)
    tifffile.imwrite(volume[5], labels, photometric="minisblack", metadata={"axes": "ZYX"})
    monkeypatch.setattr(
        volume[0],
        "load_scalar",
        lambda *args, **kwargs: pytest.fail("No source allocation before budget admission"),
    )
    with pytest.raises(ValueError, match="object measurement allocations"):
        preview(volume, working_bytes=1024**2)
    monkeypatch.setattr(imports, "MAX_OBJECTS", 2)
    with pytest.raises(ValueError, match="Too many objects"):
        preview(volume)


@pytest.mark.parametrize("dtype", ["uint8", "uint16", "uint32"])
def test_empty_unsigned_volume_is_valid(volume, dtype):
    empty = np.zeros_like(volume[4], dtype=dtype)
    tifffile.imwrite(volume[5], empty, photometric="minisblack", metadata={"axes": "ZYX"})
    grant = preview(volume)
    output = volume[0].execute("labels_import", request(volume, grant))
    result = volume[0].project.result(output["result"]["id"])
    assert grant["original_dtype"] == dtype and grant["object_count"] == 0
    assert result["provenance"]["measurements"] == []
    np.testing.assert_array_equal(volume[0].project.load_array(result["arrays"]["labels"]), empty)


def test_volume_correction_preserves_parent_and_remeasures_original_ids(volume):
    wb, _, _, _, labels, _, raw = volume
    parent = wb.execute("labels_import", request(volume, preview(volume)))["result"]
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    output = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "brush",
                    "mode": "paint",
                    "plane": "XY",
                    "index": 2,
                    "points": [{"u": 12, "v": 12}],
                    "radius": 0.2,
                    "label": 2**32 - 1,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        },
    )
    child = wb.project.result(output["result"]["id"])
    expected = labels.copy()
    expected[2, 12, 12] = 2**32 - 1
    assert child["parent_id"] == parent["id"]
    np.testing.assert_array_equal(wb.project.load_array(child["arrays"]["labels"]), expected)
    np.testing.assert_array_equal(
        wb.project.load_array(wb.project.result(parent["id"])["arrays"]["labels"]), labels
    )
    assert_measurements(child, expected, raw)
