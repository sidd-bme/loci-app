import hashlib
import json

import numpy as np
import pytest
import tifffile
import zarr

from loci_engine import cli, image_conversion
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


@pytest.fixture
def study(tmp_path):
    workbench = Workbench(ResearchProject.create(tmp_path / "measure.loci-study", "Microscopy"))
    t, c, z, y, x = np.ogrid[:2, :2, :2, :41, :277]
    values = np.asarray((16001 * t + 7009 * c + 103 * z + 277 * y + x) - 5000, dtype=np.int16)
    p = tmp_path / "source.ome.tif"
    tifffile.imwrite(
        p,
        values,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.26,
            "PhysicalSizeY": 0.75,
            "PhysicalSizeZ": 2.5,
            "TimeIncrement": 2.75,
            "TimeIncrementUnit": "s",
            "Channel": {"Name": ["DNA", "Tubulin"]},
            "Plane": [
                {
                    "DeltaT": 2.75 * t,
                    "DeltaTUnit": "s",
                    "PositionZ": 30.0 + 2.5 * z,
                    "PositionZUnit": "µm",
                }
                for t, c, z in np.ndindex(values.shape[:3])
            ],
        },
    )
    source = workbench.import_native(str(p))
    yield workbench, p, source, values
    workbench.close()


def convert(workbench, source, fmt, destination):
    return image_conversion.convert_image(
        workbench, source["id"], source["sha256"], fmt, destination
    )


@pytest.mark.parametrize("fmt", ["ome-tiff", "ome-zarr"])
def test_reopen_full_multidimensional_grid(study, tmp_path, fmt):
    wb, original, source, values = study
    output = tmp_path / fmt
    receipt = convert(wb, source, fmt, output)
    manifest = json.loads((output / "conversion.json").read_text())
    assert manifest["source_sha256"] == hashlib.sha256(original.read_bytes()).hexdigest()
    assert manifest["shape"] == list(values.shape)
    assert manifest["channel_names"] == ["DNA", "Tubulin"]
    assert manifest["coordinates"]["scale"] == [2.75, 1, 2.5, 0.75, 0.26]
    assert manifest["coordinates"]["units"] == [
        "second",
        None,
        "micrometer",
        "micrometer",
        "micrometer",
    ]
    assert len(manifest["plane_positions"]) == 8
    assert str(tmp_path) not in json.dumps(manifest)
    image = output / receipt["artifact"]
    if fmt == "ome-tiff":
        with tifffile.TiffFile(image) as tif:
            assert tif.pages[0].is_tiled
            assert tif.is_ome and tif.series[0].axes == "TCZYX"
            decoded = tif.asarray()
            assert 'PhysicalSizeZ="2.5"' in tif.ome_metadata
            assert 'TimeIncrement="2.75"' in tif.ome_metadata
    else:
        group = zarr.open_group(image, mode="r")
        assert group["0"].chunks == (1, 1, 1, 41, 256)
        decoded = group["0"][:]
        assert group.attrs["omero"]["channels"][1]["label"] == "Tubulin"
        assert group.attrs["multiscales"][0]["version"] == "0.4"
        registered = wb.project.register_zarr_source(str(image))
        assert list(registered["metadata"]["channel_names"]) == ["DNA", "Tubulin"]
        # A cross-format round trip also exercises the verified NGFF batch reader.
        second = convert(wb, registered, "ome-tiff", tmp_path / "returned")
        assert receipt["pixel_sha256"] == second["pixel_sha256"]
        assert np.array_equal(tifffile.imread(tmp_path / "returned" / second["artifact"]), values)
    assert decoded.dtype == values.dtype
    np.testing.assert_array_equal(decoded, values)
    with pytest.raises(ValueError, match="absent"):
        convert(wb, source, fmt, output)


def test_float_patterns_and_unknown_calibration(tmp_path):
    p = tmp_path / "float.tif"
    bits = np.array(
        [
            [0x80000000, 0x00000000, 0x00000001, 0xFF7FFFFF],
            [0x7F7FFFFF, 0x3F800000, 0x40000000, 0xC0000000],
        ],
        dtype="uint32",
    )
    tifffile.imwrite(p, bits.view("float32"), photometric="minisblack")
    wb = Workbench(ResearchProject.create(tmp_path / "float.loci-study", "Float values"))
    try:
        source = wb.import_native(str(p))
        for fmt in ("ome-tiff", "ome-zarr"):
            receipt = convert(wb, source, fmt, tmp_path / fmt)
            image = tmp_path / fmt / receipt["artifact"]
            arr = (
                tifffile.imread(image)
                if fmt == "ome-tiff"
                else zarr.open_group(image, mode="r")["0"][0, 0, 0]
            )
            np.testing.assert_array_equal(arr.view("uint32"), bits)
            meta = json.loads((tmp_path / fmt / "conversion.json").read_text())
            assert meta["calibration"] is None
            assert meta["coordinates"]["units"] == [None] * 5
    finally:
        wb.close()


def test_nonfinite_input_refused_without_partial_image(tmp_path):
    p = tmp_path / "missing.tif"
    tifffile.imwrite(p, np.array([[1.0, np.nan], [np.inf, -2.5]], dtype=np.float32))
    wb = Workbench(ResearchProject.create(tmp_path / "missing.loci-study", "Missing values"))
    try:
        source = wb.import_native(str(p))
        for fmt in ("ome-tiff", "ome-zarr"):
            with pytest.raises(ValueError, match="non-finite"):
                convert(wb, source, fmt, tmp_path / fmt)
            assert not (tmp_path / fmt).exists()
    finally:
        wb.close()


def test_reject_stale_unsafe_and_failed_readback(study, tmp_path, monkeypatch):
    wb, p, s, _ = study
    with pytest.raises(ValueError, match="current registered"):
        convert(wb, {**s, "sha256": "0" * 64}, "ome-tiff", tmp_path / "stale")
    for bad in [wb.project.root / "copy", p]:
        with pytest.raises(ValueError):
            convert(wb, s, "ome-zarr", bad)
    link = tmp_path / "alias"
    link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical"):
        convert(wb, s, "ome-tiff", link / "bad")

    def fail(*_):
        raise ValueError("Independent read-back detected a difference")

    monkeypatch.setattr(image_conversion, "_verify_image", fail)
    with pytest.raises(ValueError, match="Independent"):
        convert(wb, s, "ome-tiff", tmp_path / "failed")
    assert not (tmp_path / "failed").exists() and not list(tmp_path.glob(".loci-convert-*"))
    assert hashlib.sha256(p.read_bytes()).hexdigest() == s["sha256"]


def test_cli_uses_bound_source(study, tmp_path, capsys):
    wb, p, s, _ = study
    target = tmp_path / "command"
    assert (
        cli.main(
            [
                "convert-image",
                "--project",
                str(wb.project.root),
                "--source",
                s["id"],
                "--source-sha256",
                s["sha256"],
                "--format",
                "ome-tiff",
                "--destination",
                str(target),
                "--json",
            ]
        )
        == 0
    )
    result = json.loads(capsys.readouterr().out)
    assert (target / result["artifact"]).is_file()


def test_bigtiff_and_output_integrity_gate(study, tmp_path, monkeypatch):
    wb, _, source, values = study
    # Exercise the same BigTIFF selection and verification code on a small exact fixture.
    monkeypatch.setattr(image_conversion, "BIGTIFF_THRESHOLD", 1024)
    dest = tmp_path / "large-container"
    result = convert(wb, source, "ome-tiff", dest)
    with tifffile.TiffFile(dest / result["artifact"]) as tif:
        assert tif.is_bigtiff
        np.testing.assert_array_equal(tif.asarray(), values)
    sync = image_conversion._sync_directory_tree

    def changed(stage):
        sync(stage)
        with (stage / "image.ome.tif").open("ab") as output:
            output.write(b"unexpected")

    monkeypatch.setattr(image_conversion, "_sync_directory_tree", changed)
    with pytest.raises(ValueError, match="changed"):
        convert(wb, source, "ome-tiff", tmp_path / "tampered")
    assert not (tmp_path / "tampered").exists()


def test_ngff_transforms_and_registered_store_are_protected(study, tmp_path):
    wb, _, s, _ = study
    first = tmp_path / "source-store"
    result = convert(wb, s, "ome-zarr", first)
    store_path = first / result["artifact"]
    group = zarr.open_group(store_path, mode="r+")
    scales = group.attrs["multiscales"]
    scales[0]["axes"][0]["unit"] = "millisecond"
    transform = scales[0]["datasets"][0]["coordinateTransformations"]
    transform[0]["scale"][0] = 2750.0
    translation = [500.0, 0.0, 4.0, 9.0, 5.0]
    transform.append({"type": "translation", "translation": translation})
    group.attrs["multiscales"] = scales
    registered = wb.project.register_zarr_source(str(store_path))
    with pytest.raises(ValueError, match="outside"):
        convert(wb, s, "ome-tiff", store_path / "nested")
    second = tmp_path / "copy"
    convert(wb, registered, "ome-zarr", second)
    saved = json.loads((second / "conversion.json").read_text())
    assert saved["coordinates"]["translation"] == translation
    np.testing.assert_array_equal(
        zarr.open_group(second / "image.ome.zarr", mode="r").attrs["multiscales"][0]["datasets"][0][
            "coordinateTransformations"
        ][1]["translation"],
        translation,
    )
    third = tmp_path / "times"
    convert(wb, registered, "ome-tiff", third)
    with tifffile.TiffFile(third / "image.ome.tif") as tif:
        assert 'TimeIncrement="2.75"' in tif.ome_metadata
    assert (
        json.loads((third / "conversion.json").read_text())["coordinates"]["translation"]
        == translation
    )
