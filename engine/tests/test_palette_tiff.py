"""Generated palette fixtures: exact samples, bounded access and logical C identity."""

import base64
import copy
import hashlib
import io
import json
import struct

import numpy as np
import pytest
import tifffile
from PIL import Image, ImageCms

from loci_engine.native_image import (
    NativeDimensions,
    NativeImageError,
    NativeImageSession,
    NativeReadBudgetError,
    NativeSelection,
    PhysicalCalibration,
    inspect_native,
)
from loci_engine.research_channels import save_channels
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.source_rendered_export import export_rendered_source
from loci_engine.source_view_state import _default_view_state_for_source
from loci_engine.viewer_image import ViewerImageError
from loci_engine.workbench import Workbench


def palette_fixture(path, *, dtype="uint8", tiled=False, pyramid=True, orientation=1):
    """OME CZYX with actual per-IFD palettes that vary across C, Z and level."""
    bits = np.dtype(dtype).itemsize * 8
    xml = (
        '<?xml version="1.0"?>'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" '
        f'Type="{dtype}" SizeX="48" SizeY="32" SizeZ="2" SizeC="2" SizeT="1" '
        'PhysicalSizeX="0.25" PhysicalSizeY="0.5" PhysicalSizeZ="2">'
        '<Channel ID="Channel:0:0" SamplesPerPixel="1" Color="-16776961"/>'
        '<Channel ID="Channel:0:1" SamplesPerPixel="1" Color="16711935"/>'
        '<TiffData IFD="0" PlaneCount="4"/></Pixels></Image></OME>'
    )
    expected = {}
    with tifffile.TiffWriter(path) as tif:
        for c in range(2):
            for z in range(2):
                indices = (np.indices((32, 48)).sum(axis=0) % 5).astype(dtype)
                indices[0, 0] = (1 << bits) - 1
                for level in range(2 if pyramid else 1):
                    lut = np.zeros((3, 1 << bits), np.uint16)
                    lut[c, :5] = [1, 257, 32768, 65535, 65280]
                    lut[c, -1] = 12345 + z + level
                    selected = indices[:: 2**level, :: 2**level]
                    expected[c, z, level] = np.moveaxis(lut[:, selected], 0, -1)
                    tif.write(
                        selected,
                        photometric="palette",
                        colormap=lut,
                        description=xml if c == z == level == 0 else None,
                        metadata=None,
                        compression="deflate",
                        **({"tile": (16, 16)} if tiled else {"rowsperstrip": 4}),
                        **({"subifds": 1} if pyramid and level == 0 else {}),
                        subfiletype=1 if level else 0,
                        extratags=[(274, "H", 1, orientation if c == 1 else 1, False)],
                    )
    return expected


@pytest.mark.parametrize("dtype", ["uint8", "uint16"])
@pytest.mark.parametrize("tiled", [False, True])
def test_palette_exact_crop_axes_lut_precision_frames_and_pyramid(tmp_path, dtype, tiled):
    path = tmp_path / "palette.ome.tiff"
    expected = palette_fixture(path, dtype=dtype, tiled=tiled)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with tifffile.TiffFile(path) as tif:
        pages = tif.series[0].pages
        assert isinstance(pages[2], tifffile.TiffFrame)
        assert pages[2].keyframe.colormap[0, 2] == 32768  # wrong C if shared!
        assert pages[2].aspage().colormap[1, 2] == 32768
    metadata = inspect_native(path)
    assert metadata.source_axes == "CZYX"
    assert metadata.source_shape == (2, 2, 32, 48)
    assert metadata.axes == "TCZYXS"
    assert metadata.dimensions == NativeDimensions(1, 2, 2, 32, 48, 3)
    assert metadata.channel_dtypes == ("uint16", "uint16")
    assert metadata.sample_semantics == "RGB"
    assert metadata.palette.stored_index_dtype == dtype
    assert metadata.palette.lookup_policy == "actual-IFD-ColorMap"
    assert metadata.physical_calibration == PhysicalCalibration("ZYX", (2, 0.5, 0.25), "µm")
    assert metadata.levels[1].calibration == PhysicalCalibration("ZYX", (2, 1, 0.5), "µm")
    with NativeImageSession(path) as session:
        for (c, z, level), values in expected.items():
            selection = NativeSelection(x=0, y=0, width=17, height=12, c=c, z=z, level=level)
            region = session.read_region(selection)
            np.testing.assert_array_equal(region.pixels, values[:12, :17])
            assert region.native_dtype == "uint16"
            assert not region.pixels.flags.writeable
            assert region.read_mode == "tiff-palette-segments"
            geometry = session.geometry({"x": 3, "y": 4, "z": z, "level": level}, False)
            np.testing.assert_allclose(
                np.array(geometry.affine)[:3, 3], [3 * 0.25 * 2**level, 4 * 0.5 * 2**level, z * 2]
            )
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_palette_budget_includes_lut_indices_rgb_and_scratch_before_decode(tmp_path, monkeypatch):
    path = tmp_path / "palette.ome.tiff"
    palette_fixture(path, dtype="uint16", pyramid=False)
    with NativeImageSession(path) as session:
        original = tifffile.TiffPage.decode
        # cached_property descriptor: preserve real header-only segment layout calls.
        with tifffile.TiffFile(path) as tif:
            real_decode = original.__get__(tif.pages[0])

        def decode(self, data, index, **kwargs):
            if data is not None:
                pytest.fail("Pixel decode occurred before palette budget refusal")
            return real_decode(data, index, **kwargs)

        monkeypatch.setattr(tifffile.TiffPage, "decode", decode)
        with pytest.raises(NativeReadBudgetError) as error:
            session.read_region(
                NativeSelection(x=0, y=0, width=48, height=32, budget_bytes=400_000)
            )
        assert error.value.required_bytes > 400_000


@pytest.mark.parametrize("damage", ["missing", "short", "type"])
def test_palette_bad_map_on_non_keyframe_fails_inspection(tmp_path, damage):
    path = tmp_path / "palette.ome.tiff"
    palette_fixture(path, pyramid=False)
    with tifffile.TiffFile(path) as tif:
        page = tif.pages[2]
        tag = page.tags["ColorMap"]
        offset = tag.offset
        byteorder = tif.byteorder
    with path.open("r+b") as stream:
        if damage == "missing":
            stream.seek(offset)
            stream.write(struct.pack(byteorder + "H", 65000))
        elif damage == "short":
            stream.seek(offset + 4)
            stream.write(struct.pack(byteorder + "I", 767))
        else:
            stream.seek(offset + 2)
            stream.write(struct.pack(byteorder + "H", 4))
    with pytest.raises(NativeImageError, match="ColorMap"):
        inspect_native(path)


def test_palette_non_keyframe_orientation_fails_closed(tmp_path):
    path = tmp_path / "palette.ome.tiff"
    palette_fixture(path, orientation=2)
    with pytest.raises(NativeImageError, match="Orientation 1"):
        inspect_native(path)


def png_pixels(payload):
    with Image.open(io.BytesIO(base64.b64decode(payload["image"].split(",", 1)[1]))) as image:
        return np.asarray(image)


def test_palette_selected_channel_display_histogram_save_reopen_and_export(tmp_path):
    path = tmp_path / "palette.ome.tiff"
    expected = palette_fixture(path)
    before = path.read_bytes()
    project = ResearchProject.create(tmp_path / "palette.loci-study", "Palette")
    wb = Workbench(project)
    try:
        source = wb.import_native(str(path))
        source_id = source["id"]
        assert source["metadata"]["palette"]["stored_index_dtype"] == "uint8"
        default_state = _default_view_state_for_source(source)
        assert default_state["interpretation"] == "generic"
        assert [item["channel"] for item in default_state["channels"]] == [0]
        views = {}
        for c in (0, 1):
            defaults = wb.execute("viewer_defaults", {"source_id": source_id, "c": c})
            channels = defaults["channels"]
            assert len(channels) == 1 and channels[0]["channel"] == c
            assert channels[0]["high"] == 65535 and channels[0]["visible"]
            selection = {
                "x": 0,
                "y": 0,
                "width": 48,
                "height": 32,
                "c": c,
                "z": 1,
                "t": 0,
                "level": 0,
            }
            view = {"source_id": source_id, "channels": channels, "selection": selection}
            views[c] = view
            expected8 = ((expected[c, 1, 0].astype(np.uint32) + 128) // 257).astype(np.uint8)
            np.testing.assert_array_equal(png_pixels(wb.execute("viewer_tile", view)), expected8)
            # Native pyramid overview still selects the requested C and Z.
            overview = {
                "source_id": source_id,
                "channels": channels,
                "c": c,
                "z": 1,
                "overview": True,
                "max_edge": 32,
            }
            result = wb.execute("viewer_tile", overview)
            assert result["preparation"] == "native-pyramid"
            np.testing.assert_array_equal(
                png_pixels(result),
                ((expected[c, 1, 1].astype(np.uint32) + 128) // 257).astype(np.uint8),
            )
            histogram = wb.execute("viewer_histogram", {"source_id": source_id, "c": c, "z": 1})
            assert histogram["sample"]["c"] == c
            for component, record in enumerate(histogram["histograms"]):
                assert record["min"] == (1 if component == c else 0)
                assert record["max"] == (65535 if component == c else 0)
            target = tmp_path / f"channel-{c}.tiff"
            export_rendered_source(
                wb,
                {
                    "source_id": source_id,
                    "source_sha256": source["sha256"],
                    "format": "tiff",
                    "view": view,
                },
                target,
            )
            np.testing.assert_array_equal(tifffile.imread(target), expected[c, 1, 0])
            with tifffile.TiffFile(target) as tif:
                provenance = json.loads(tif.pages[0].description)
                assert provenance["selection"]["c"] == c
                assert provenance["precision_policy"] == "native-uint16-display-codes"
        state = {
            **default_state,
            "channels": views[1]["channels"],
            "selection": views[1]["selection"],
        }
        saved = wb.execute(
            "save_source_view",
            {
                "source_id": source_id,
                "source_sha256": source["sha256"],
                "expected_revision": 0,
                "state": state,
            },
        )
        with pytest.raises(ValueError, match="RGB samples"):
            wb.load_scalar(source_id, views[1]["selection"])
        with pytest.raises(ValueError, match="biological channels"):
            save_channels(project, {"source_id": source_id, "channels": []})
        wrong = copy.deepcopy(views[1])
        wrong["selection"]["c"] = 0
        with pytest.raises(ViewerImageError, match="selected logical channel"):
            wb.execute("viewer_tile", wrong)
        invalid = copy.deepcopy(state)
        invalid["selection"]["c"] = 0
        with pytest.raises(ValueError, match="selected logical channel"):
            wb.execute(
                "save_source_view",
                {
                    "source_id": source_id,
                    "source_sha256": source["sha256"],
                    "expected_revision": 1,
                    "state": invalid,
                },
            )
    finally:
        wb.close()
    reopened = Workbench(ResearchProject(project.root))
    try:
        assert reopened.execute("source_view", {"source_id": source_id}) == saved
        np.testing.assert_array_equal(
            png_pixels(reopened.execute("viewer_tile", views[1])),
            ((expected[1, 1, 0].astype(np.uint32) + 128) // 257).astype(np.uint8),
        )
    finally:
        reopened.close()
    assert path.read_bytes() == before


@pytest.mark.parametrize("tag_name,value", [("BitsPerSample", 4), ("SamplesPerPixel", 2)])
def test_palette_invalid_index_layout_is_not_inherited_from_keyframe(tmp_path, tag_name, value):
    path = tmp_path / "palette.ome.tiff"
    palette_fixture(path, pyramid=False)
    with tifffile.TiffFile(path) as tif:
        tag = tif.pages[2].tags[tag_name]
        offset, byteorder = tag.valueoffset, tif.byteorder
    with path.open("r+b") as stream:
        stream.seek(offset)
        stream.write(struct.pack(byteorder + "H", value))
    with pytest.raises(NativeImageError):
        inspect_native(path)


def test_palette_uncompressed_tczyx_preserves_time_and_never_exposes_indices(tmp_path):
    path = tmp_path / "time.ome.tiff"
    indices = np.arange(8, dtype=np.uint8).reshape(2, 2, 2, 1, 1)
    indices = np.broadcast_to(indices, (2, 2, 2, 8, 9)).copy()
    lut = np.zeros((3, 256), np.uint16)
    lut[2] = np.arange(256, dtype=np.uint16) * 257
    tifffile.imwrite(path, indices, photometric="palette", colormap=lut, metadata={"axes": "TCZYX"})
    with NativeImageSession(path) as session:
        assert session.metadata.dimensions == NativeDimensions(2, 2, 2, 8, 9, 3)
        assert session.metadata.capabilities.read_modes == ("tiff-palette-segments",)
        for t in range(2):
            region = session.read_region(
                NativeSelection(x=2, y=3, width=4, height=5, t=t, c=1, z=1)
            )
            assert region.pixels.shape == (5, 4, 3)
            assert np.all(region.pixels[..., :2] == 0)
            assert np.all(region.pixels[..., 2] == (t * 4 + 3) * 257)


def test_palette_derived_cache_auto_and_png_keep_selected_channel(tmp_path):
    path = tmp_path / "palette.ome.tiff"
    expected = palette_fixture(path, pyramid=False)
    wb = Workbench(ResearchProject.create(tmp_path / "cache.loci-study", "Palette cache"))
    try:
        source = wb.import_native(str(path))
        revisions = []
        for c in (0, 1):
            for auto in (False, True):
                defaults = wb.execute(
                    "viewer_defaults", {"source_id": source["id"], "c": c, "z": 1, "auto": auto}
                )
                assert [setting["channel"] for setting in defaults["channels"]] == [c]
            defaults = wb.execute("viewer_defaults", {"source_id": source["id"], "c": c})
            view = {
                "source_id": source["id"],
                "c": c,
                "z": 1,
                "overview": True,
                "max_edge": 16,
                "channels": defaults["channels"],
            }
            first = wb.execute("viewer_tile", view)
            assert first["preparation"] == "derived-cache"
            assert wb.execute("viewer_tile", view)["image"] == first["image"]
            values = png_pixels(first)
            assert not values[..., 1 - c].any()
            assert values[..., c].max() == 255
            assert 254 in values[..., c]  # 65280 is not stretched to 65535
            revisions.append(first["display_revision"])
            histogram = wb.execute("viewer_histogram", {"source_id": source["id"], "c": c, "z": 1})
            assert histogram["sample"]["c"] == c
            assert histogram["histograms"][1 - c]["max"] == 0
            assert histogram["histograms"][c]["max"] == 65535
            target = tmp_path / f"channel-{c}.png"
            export_rendered_source(
                wb,
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "format": "png",
                    "view": view,
                },
                target,
            )
            with Image.open(target) as png:
                np.testing.assert_array_equal(np.asarray(png), values)
                provenance = json.loads(png.info["Loci rendering provenance"])
                assert provenance["palette"]["lookup_dtype"] == "uint16"
                assert provenance["canvas_quantization"] == "uint16-fixed-range-nearest-v1"
                assert provenance["request"]["c"] == c
            np.testing.assert_array_equal(
                wb._session(source["id"])
                .read_region(NativeSelection(x=0, y=0, width=48, height=32, c=c, z=1))
                .pixels,
                expected[c, 1, 0],
            )
        assert revisions[0] != revisions[1]
        assert len(list((wb.project.root / "viewer-overviews").glob("*.png"))) == 2
    finally:
        wb.close()


@pytest.mark.parametrize(
    "source_palette,saved_palette", [(False, "absent"), (False, "forged"), (True, "absent")]
)
def test_relink_only_allows_absent_none_palette_on_legacy_nonpalette_sources(
    tmp_path, source_palette, saved_palette
):
    from loci_engine.research_interchange import (
        export_project,
        import_project,
        relink_interchanged_source,
    )

    path = tmp_path / "source.tiff"
    if source_palette:
        palette_fixture(path, pyramid=False)
    else:
        tifffile.imwrite(path, np.zeros((8, 8), np.uint16))
    wb = Workbench(ResearchProject.create(tmp_path / "source.loci-study", "Legacy"))
    try:
        source = wb.import_native(str(path))
        archive = tmp_path / "legacy.zip"
        export_project(wb.project, archive)
    finally:
        wb.close()
    restored = import_project(archive, tmp_path / "restored.loci-study")
    # Model the exact old record: only the new optional metadata key is absent.
    with restored.connection() as connection:
        row = connection.execute(
            "SELECT record FROM sources WHERE id=?", (source["id"],)
        ).fetchone()
        record = json.loads(row[0])
        if saved_palette == "absent":
            record["metadata"].pop("palette")
        else:
            record["metadata"]["palette"] = {"stored_index_dtype": "uint8"}
        connection.execute(
            "UPDATE sources SET record=? WHERE id=?", (canonical_json(record), source["id"])
        )
    if source_palette or saved_palette == "forged":
        with pytest.raises(ValueError, match="shape, calibration, or metadata"):
            relink_interchanged_source(restored, source["id"], path)
        assert restored.source(source["id"])["locator_state"] == "relink-required"
    else:
        relink_interchanged_source(restored, source["id"], path)
        reopened = restored.source(source["id"], verify=True)
        assert "palette" not in reopened["metadata"]  # no silent record migration
        assert reopened["sha256"] == source["sha256"]


def test_palette_uint16_icc_display_and_export_refuse_precision_loss(tmp_path):
    path = tmp_path / "profiled-palette.tiff"
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    lut = np.zeros((3, 256), np.uint16)
    lut[:, 0] = [1, 257, 32768]
    tifffile.imwrite(
        path,
        np.zeros((8, 9), np.uint8),
        photometric="palette",
        colormap=lut,
        extratags=[(34675, "B", len(profile), profile, False)],
    )
    before = path.read_bytes()
    wb = Workbench(ResearchProject.create(tmp_path / "profile.loci-study", "ICC precision"))
    try:
        source = wb.import_native(str(path))
        channels = wb.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
        view = {
            "source_id": source["id"],
            "channels": channels,
            "selection": {"x": 0, "y": 0, "width": 9, "height": 8},
        }
        with pytest.raises(ValueError, match="uint16.*stored RGB"):
            wb.execute("viewer_tile", view)
        target = tmp_path / "refused.tiff"
        with pytest.raises(ValueError, match="uint16.*stored RGB"):
            export_rendered_source(
                wb,
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "format": "tiff",
                    "view": view,
                },
                target,
            )
        assert not target.exists()
        raw = wb._session(source["id"]).read_region(NativeSelection(x=0, y=0, width=1, height=1))
        np.testing.assert_array_equal(raw.pixels, [[[1, 257, 32768]]])
    finally:
        wb.close()
    assert path.read_bytes() == before


@pytest.mark.parametrize("palette", [False, True])
@pytest.mark.parametrize("profiled", [False, True])
def test_large_no_pyramid_auto_preserves_uint16_component_percentiles(
    tmp_path, monkeypatch, palette, profiled
):
    import loci_engine.viewer_image as viewer

    path = tmp_path / "large-source.tiff"
    indices = np.broadcast_to(np.arange(1280, dtype=np.uint16) // 320, (65, 1280))
    levels = np.array([1024, 8193, 32768, 60000], dtype=np.uint16)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    tags = [(34675, "B", len(profile), profile, False)] if profiled else []
    if palette:
        lut = np.zeros((3, 256), dtype=np.uint16)
        lut[:, :4] = levels
        tifffile.imwrite(
            path,
            indices.astype(np.uint8),
            photometric="palette",
            colormap=lut,
            compression="deflate",
            rowsperstrip=8,
            extratags=tags,
        )
    else:
        pixels = np.repeat(levels[indices][..., None], 3, axis=-1)
        tifffile.imwrite(
            path, pixels, photometric="rgb", compression="deflate", rowsperstrip=8, extratags=tags
        )
    before = path.read_bytes()
    with NativeImageSession(path) as session:
        assert session.metadata.dimensions.x > viewer.MAX_OVERVIEW_EDGE
        assert (
            viewer._select_native_overview_level(session.metadata, viewer.MAX_OVERVIEW_EDGE) is None
        )
        with monkeypatch.context() as patch:
            patch.setattr(
                viewer,
                "_canvas_rgb",
                lambda *_: pytest.fail(
                    "Auto must measure native uint16 components before canvas quantization"
                ),
            )
            defaults = viewer.viewer_defaults(session, {"source_id": "a" * 32, "auto": True})
        assert defaults["basis"]["sample"] == "deterministic-nearest-whole-source"
        # Each of four source stripes occupies 25% of the image. Their constant
        # values survive nearest sampling, so the exact p1/p99 are independent
        # of interpolation details and cannot accidentally pass in 8-bit units.
        assert defaults["channels"][0]["low"] == 1024
        assert defaults["channels"][0]["high"] == 60000
        view = {
            "source_id": "a" * 32,
            "channels": defaults["channels"],
            "selection": {"x": 0, "y": 0, "width": 1, "height": 1},
        }
        if profiled:
            with pytest.raises(ViewerImageError, match="uint16.*stored RGB"):
                viewer.viewer_tile(session, view)
        else:
            np.testing.assert_array_equal(
                png_pixels(viewer.viewer_tile(session, view)), [[[0, 0, 0]]]
            )
        region = session.read_region(NativeSelection(x=1279, y=64, width=1, height=1))
        assert region.pixels.dtype == np.uint16
        np.testing.assert_array_equal(region.pixels, [[[60000, 60000, 60000]]])
    assert path.read_bytes() == before
