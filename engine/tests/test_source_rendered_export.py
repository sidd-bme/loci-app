import base64
import hashlib
import io
import json
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest
import tifffile
from PIL import Image, ImageCms

import loci_engine.source_rendered_export as rendered_export_module
from loci_engine.native_image import NativeImageSession
from loci_engine.research_project import ResearchProject
from loci_engine.source_rendered_export import export_rendered_source
from loci_engine.workbench import Workbench


def fixture(tmp_path):
    path = tmp_path / "source.tif"
    pixels = np.zeros((16, 24, 3), dtype=np.uint8)
    pixels[:, :8] = [201, 32, 81]
    pixels[:, 8:16] = [11, 154, 23]
    pixels[:, 16:] = [43, 82, 215]
    tifffile.imwrite(path, pixels, photometric="rgb")
    workbench = Workbench(ResearchProject.create(tmp_path / "study.loci-study", "Export"))
    source = workbench.import_native(str(path))
    channels = workbench.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "format": "png",
        "view": {
            "source_id": source["id"],
            "overview": True,
            "max_edge": 1024,
            "channels": channels,
        },
    }
    return workbench, source, request, pixels


def test_rendered_export_matches_rgb_pixels_and_embeds_path_free_display_provenance(tmp_path):
    workbench, source, request, pixels = fixture(tmp_path)
    target = tmp_path / "rendered.png"
    receipt = export_rendered_source(workbench, request, target)
    with Image.open(target) as image:
        np.testing.assert_array_equal(np.asarray(image), pixels)
        info = json.loads(image.info["Loci rendering provenance"])
        assert info["source_sha256"] == source["sha256"]
        assert info["annotations_included"] is False
        assert "not original-value" in info["meaning"]
        assert str(tmp_path) not in json.dumps(info)
        assert image.info["icc_profile"]
        assert image.info["dpi"] == pytest.approx((300, 300), rel=1e-3)
        assert info["figure"]["request"] == {
            "dpi": 300,
            "scale_bar": False,
            "channel_legend": False,
            "channel_labels": [],
        }
        assert info["output"]["dpi"] == 300
    assert receipt["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
    assert receipt["width"] == 24 and receipt["height"] == 16
    assert not workbench.project.list_results()


def test_rendered_region_preserves_selected_source_grid(tmp_path):
    workbench, _, request, pixels = fixture(tmp_path)
    request["view"] = {
        "source_id": request["source_id"],
        "channels": request["view"]["channels"],
        "selection": {"x": 4, "y": 3, "width": 12, "height": 8, "level": 0, "c": 0, "z": 0, "t": 0},
    }
    target = tmp_path / "region.png"
    receipt = export_rendered_source(workbench, request, target)
    assert receipt["sampling"] == "selected source grid"
    with Image.open(target) as image:
        np.testing.assert_array_equal(np.asarray(image), pixels[3:11, 4:16])


def test_changed_source_or_existing_destination_never_publishes(tmp_path):
    workbench, _, request, _ = fixture(tmp_path)
    target = tmp_path / "existing.png"
    target.write_bytes(b"keep")
    with pytest.raises(ValueError, match="absent"):
        export_rendered_source(workbench, request, target)
    assert target.read_bytes() == b"keep"
    request["source_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="changed"):
        export_rendered_source(workbench, request, tmp_path / "no.png")
    assert not (tmp_path / "no.png").exists()


def test_invalid_display_does_not_export(tmp_path):
    workbench, _, request, _ = fixture(tmp_path)
    request["view"]["channels"][0]["gamma"] = float("nan")
    with pytest.raises(ValueError):
        export_rendered_source(workbench, request, tmp_path / "no.png")
    assert not (tmp_path / "no.png").exists()


def _tiff_fixture(tmp_path, pixels, *, icc_profile=None):
    path = tmp_path / "source-raster.tiff"
    if icc_profile is None:
        tifffile.imwrite(
            path,
            pixels,
            photometric="rgb" if pixels.ndim == 3 else "minisblack",
        )
    else:
        Image.fromarray(pixels, mode="RGB").save(path, icc_profile=icc_profile)
    workbench = Workbench(ResearchProject.create(tmp_path / "tiff-study.loci-study", "TIFF"))
    source = workbench.import_native(str(path))
    channels = workbench.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
    height, width = pixels.shape[:2]
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "format": "tiff",
        "view": {
            "source_id": source["id"],
            "selection": {
                "x": 0,
                "y": 0,
                "width": width,
                "height": height,
                "level": 0,
                "c": 0,
                "z": 0,
                "t": 0,
            },
            "channels": channels,
        },
    }
    return workbench, source, request, path


def _calibrated_scalar_fixture(tmp_path):
    path = tmp_path / "calibrated.ome.tiff"
    pixels = np.zeros((2, 200, 320), dtype=np.uint16)
    pixels[0, 20:180, 40:280] = 30_000
    pixels[1, 60:140, 100:220] = 50_000
    tifffile.imwrite(
        path,
        pixels,
        ome=True,
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.75,
            "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["DAPI", "Reporter"]},
        },
    )
    workbench = Workbench(ResearchProject.create(tmp_path / "figure.loci-study", "Figure"))
    source = workbench.import_native(str(path))
    channels = workbench.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
    channels[0]["color"] = "#00ffff"
    channels[1]["color"] = "#ff00ff"
    channels[1]["visible"] = True
    request = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "format": "tiff",
        "view": {
            "source_id": source["id"],
            "selection": {
                "x": 0,
                "y": 0,
                "width": 320,
                "height": 200,
                "level": 0,
                "c": 0,
                "z": 0,
                "t": 0,
            },
            "channels": channels,
            "figure": {
                "dpi": 600,
                "scale_bar": True,
                "channel_legend": True,
                "channel_labels": [
                    {"channel": 0, "name": "DAPI", "color": "#00ffff"},
                    {"channel": 1, "name": "Reporter", "color": "#ff00ff"},
                ],
            },
        },
    }
    return workbench, source, request, path, pixels


def test_tiff16_scalar_plane_uses_exact_display_settings_and_embedded_provenance(tmp_path):
    pixels = np.array([[0, 1, 256, 32_768, 65_535]], dtype=np.uint16)
    workbench, source, request, source_path = _tiff_fixture(tmp_path, pixels)
    source_bytes = source_path.read_bytes()
    source_stat = source_path.stat()
    target = tmp_path / "rendered-source.tiff"

    receipt = export_rendered_source(workbench, request, target)

    with tifffile.TiffFile(target) as tif:
        page = tif.pages[0]
        observed = page.asarray()
        provenance = json.loads(page.description)
        assert page.is_tiled
        assert page.tilewidth == 256 and page.tilelength == 256
        assert page.tags[34675].value
        assert page.tags["XResolution"].value == (300, 1)
        assert page.tags["YResolution"].value == (300, 1)
        assert int(page.tags["ResolutionUnit"].value) == 2
    expected = np.repeat(pixels[..., None], 3, axis=-1)
    np.testing.assert_array_equal(observed, expected)
    assert receipt["format"] == "tiff"
    assert receipt["dtype"] == "uint16"
    assert receipt["sampling"] == "full-resolution source plane"
    assert provenance["source_sha256"] == source["sha256"]
    assert provenance["display"] == request["view"]["channels"]
    assert provenance["precision_policy"] == "direct-float64-composite-to-uint16"
    assert "not original-value" in provenance["meaning"]
    assert str(tmp_path) not in json.dumps(provenance)
    assert source_path.read_bytes() == source_bytes
    assert source_path.stat().st_mtime_ns == source_stat.st_mtime_ns


def test_publication_footer_has_exact_calibrated_geometry_legend_and_tiff16_values(tmp_path):
    workbench, source, request, source_path, _ = _calibrated_scalar_fixture(tmp_path)
    source_bytes = source_path.read_bytes()
    source_mtime = source_path.stat().st_mtime_ns
    target = tmp_path / "publication-figure.tiff"

    receipt = export_rendered_source(workbench, request, target)

    with tifffile.TiffFile(target) as tif:
        page = tif.pages[0]
        output = page.asarray()
        page_description = page.description
        provenance = json.loads(page_description)
        assert page.tags["XResolution"].value == (600, 1)
        assert page.tags["YResolution"].value == (600, 1)
        assert int(page.tags["ResolutionUnit"].value) == 2
    figure = provenance["figure"]
    footer = figure["footer"]
    scale = footer["scale_bar"]
    assert provenance["geometry"]["unit"] == "um"
    assert figure["source_raster"] == {"width": 320, "height": 200}
    assert figure["output_raster"] == {"width": 320, "height": output.shape[0]}
    assert footer["placement"] == "below-source-raster"
    assert footer["offset_y"] == 200
    np.testing.assert_array_equal(output[30, 50], [0, 30_000, 30_000])
    np.testing.assert_array_equal(output[70, 110], [50_000, 30_000, 65_535])
    assert scale["micrometres_per_output_pixel"] == pytest.approx(0.5)
    assert scale["represented_length_um"] == pytest.approx(scale["bar_xywh"][2] * 0.5)
    x, y, width, height = scale["bar_xywh"]
    assert np.all(output[y : y + height, x : x + width] == 0)
    first_swatch = footer["channel_legend"][0]
    sx, sy, sw, sh = first_swatch["swatch_xywh"]
    np.testing.assert_array_equal(
        output[sy : sy + sh, sx : sx + sw],
        np.broadcast_to(np.array([0, 65_535, 65_535], dtype=np.uint16), (sh, sw, 3)),
    )
    assert receipt["width"] == 320 and receipt["height"] == output.shape[0]
    assert receipt["image_width"] == 320 and receipt["image_height"] == 200
    assert receipt["dpi"] == 600
    assert receipt["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
    assert receipt["provenance_sha256"] == hashlib.sha256(page_description.encode()).hexdigest()
    assert source_path.read_bytes() == source_bytes
    assert source_path.stat().st_mtime_ns == source_mtime
    assert not workbench.project.list_results()


def test_png_publication_footer_expands_only_derived_raster_and_records_dpi(tmp_path):
    workbench, _, request, source_path, _ = _calibrated_scalar_fixture(tmp_path)
    request["format"] = "png"
    request["view"] = {
        "source_id": request["source_id"],
        "overview": True,
        "max_edge": 1024,
        "channels": request["view"]["channels"],
        "figure": request["view"]["figure"],
    }
    before = source_path.read_bytes()
    target = tmp_path / "publication-figure.png"

    receipt = export_rendered_source(workbench, request, target)

    with Image.open(target) as image:
        image.load()
        provenance = json.loads(image.info["Loci rendering provenance"])
        assert image.width == 320 and image.height > 200
        assert image.info["dpi"] == pytest.approx((600, 600), rel=1e-3)
    assert provenance["figure"]["source_raster"] == {"width": 320, "height": 200}
    assert provenance["figure"]["output_raster"] == {
        "width": receipt["width"],
        "height": receipt["height"],
    }
    assert provenance["figure"]["footer"]["offset_y"] == 200
    assert (
        receipt["provenance_sha256"]
        == hashlib.sha256(
            json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    assert source_path.read_bytes() == before


@pytest.mark.parametrize(
    ("figure", "message"),
    [
        (
            {"dpi": 71, "scale_bar": False, "channel_legend": False, "channel_labels": []},
            "dpi must be an integer between 72 and 1200",
        ),
        (
            {
                "dpi": 300,
                "scale_bar": False,
                "channel_legend": True,
                "channel_labels": [
                    {"channel": 0, "name": "DAPI", "color": "#ffffff"},
                    {"channel": 1, "name": "Reporter", "color": "#ff00ff"},
                ],
            },
            "colors must match",
        ),
    ],
)
def test_invalid_figure_settings_fail_before_publication(tmp_path, figure, message):
    workbench, _, request, _, _ = _calibrated_scalar_fixture(tmp_path)
    request["view"]["figure"] = figure
    target = tmp_path / "invalid.tiff"

    with pytest.raises(ValueError, match=message):
        export_rendered_source(workbench, request, target)

    assert not target.exists()
    assert not list(tmp_path.glob(".loci-rendered-*"))


def test_scale_bar_refuses_pixel_only_geometry_without_publishing(tmp_path):
    workbench, _, request, _ = fixture(tmp_path)
    request["view"]["figure"] = {
        "dpi": 300,
        "scale_bar": True,
        "channel_legend": False,
        "channel_labels": [],
    }
    target = tmp_path / "uncalibrated.png"

    with pytest.raises(ValueError, match="declared physical calibration"):
        export_rendered_source(workbench, request, target)

    assert not target.exists()


def test_rgba_footer_is_refused_without_publishing_or_changing_source(tmp_path):
    pixels = np.zeros((200, 200, 4), dtype=np.uint8)
    pixels[..., 3] = 255
    workbench, _, request, source_path = _tiff_fixture(tmp_path, pixels)
    request["view"]["figure"] = {
        "dpi": 300,
        "scale_bar": True,
        "channel_legend": False,
        "channel_labels": [],
    }
    before = source_path.read_bytes()
    target = tmp_path / "rgba-footer.tiff"

    with pytest.raises(ValueError, match="RGBA rendered figures"):
        export_rendered_source(workbench, request, target)

    assert not target.exists()
    assert source_path.read_bytes() == before


def test_large_plain_plane_is_read_and_written_only_as_bounded_tiles(tmp_path, monkeypatch):
    size = 1536
    pixels = np.arange(size * size, dtype=np.uint16).reshape(size, size)
    workbench, _, request, _ = _tiff_fixture(tmp_path, pixels)
    observed_selections = []
    original = NativeImageSession.read_region

    def guarded(self, selection):
        assert selection.width <= 256 and selection.height <= 256
        observed_selections.append(selection)
        return original(self, selection)

    monkeypatch.setattr(NativeImageSession, "read_region", guarded)
    target = tmp_path / "large-plain-rendered.tiff"

    receipt = export_rendered_source(workbench, request, target)

    assert receipt["width"] == size and receipt["height"] == size
    assert len(observed_selections) == 36
    assert {(item.width, item.height) for item in observed_selections} == {(256, 256)}
    with tifffile.TiffFile(target) as tif:
        assert tif.pages[0].shape == (size, size, 3)
        assert tif.pages[0].dtype == np.dtype(np.uint16)


def test_rgb16_without_icc_preserves_native_display_codes_and_source_bytes(tmp_path):
    pixels = np.array(
        [[[0, 1024, 65_535], [51_200, 17_000, 321]]],
        dtype=np.uint16,
    )
    workbench, source, request, source_path = _tiff_fixture(tmp_path, pixels)
    before = source_path.read_bytes()
    target = tmp_path / "rgb16-rendered.tiff"

    export_rendered_source(workbench, request, target)

    np.testing.assert_array_equal(tifffile.imread(target), pixels)
    with tifffile.TiffFile(target) as tif:
        provenance = json.loads(tif.pages[0].description)
        assert provenance["precision_policy"] == "native-uint16-display-codes"
        assert provenance["rgb_color_policy"]["display_space"] == "uncharacterized-source-RGB"
        assert 34675 not in tif.pages[0].tags
    assert source_path.read_bytes() == before
    assert source["sha256"] == hashlib.sha256(before).hexdigest()


@pytest.mark.parametrize("adjusted", [False, True])
def test_rgba_viewer_and_rendered_png_tiff_preserve_unassociated_alpha(tmp_path, adjusted):
    colors = np.array(
        [[255, 32, 128, alpha] for alpha in (0, 1, 64, 127, 128, 191, 254, 255)], dtype=np.uint8
    )
    pixels = np.tile(colors[None, ...], (24, 4, 1))
    workbench, source, request, source_path = _tiff_fixture(tmp_path, pixels)
    before = source_path.read_bytes()
    if adjusted:
        request["view"]["channels"][0].update(low=32.0, high=224.0, gamma=2.0)
    expected = pixels.copy()
    if adjusted:
        rgb = np.clip((pixels[..., :3].astype(np.float64) - 32) / 192, 0, 1)
        expected[..., :3] = np.rint(np.sqrt(rgb) * 255).astype(np.uint8)
    try:
        view = {
            "source_id": source["id"],
            "overview": True,
            "max_edge": 32,
            "channels": request["view"]["channels"],
        }
        overview = workbench.execute("viewer_tile", view)
        tile = workbench.execute("viewer_tile", request["view"])
        for payload in (overview, tile):
            with Image.open(
                io.BytesIO(base64.b64decode(payload["image"].split(",", 1)[1]))
            ) as image:
                assert image.mode == "RGBA"
                np.testing.assert_array_equal(np.asarray(image), expected)
        target_png = tmp_path / "rgba-rendered.png"
        export_rendered_source(workbench, {**request, "format": "png"}, target_png)
        with Image.open(target_png) as image:
            assert image.mode == "RGBA"
            np.testing.assert_array_equal(np.asarray(image), expected)
        target_tiff = tmp_path / "rgba-rendered.tiff"
        export_rendered_source(workbench, request, target_tiff)
        with tifffile.TiffFile(target_tiff) as tif:
            np.testing.assert_array_equal(tif.asarray(), expected.astype(np.uint16) * 257)
            assert tif.pages[0].extrasamples == (tifffile.EXTRASAMPLE.UNASSALPHA,)
        assert workbench.project.list_results() == []
    finally:
        workbench.close()
    assert source_path.read_bytes() == before
    assert hashlib.sha256(before).hexdigest() == source["sha256"]


def test_rgba16_rendered_tiff_preserves_native_rgb_and_alpha_codes(tmp_path):
    pixels = np.array(
        [[[65535, 1024, 32768, alpha] for alpha in (0, 1, 16384, 32768, 65534, 65535)]],
        dtype=np.uint16,
    )
    workbench, source, request, source_path = _tiff_fixture(tmp_path, pixels)
    before = source_path.read_bytes()
    try:
        target = tmp_path / "native-rgba16.tiff"
        export_rendered_source(workbench, request, target)
        with tifffile.TiffFile(target) as tif:
            np.testing.assert_array_equal(tif.asarray(), pixels)
            assert tif.pages[0].extrasamples == (tifffile.EXTRASAMPLE.UNASSALPHA,)
            assert (
                json.loads(tif.pages[0].description)["precision_policy"]
                == "native-uint16-display-codes"
            )
    finally:
        workbench.close()
    assert source_path.read_bytes() == before
    assert source["sha256"] == hashlib.sha256(before).hexdigest()


def test_rgb16_adjustment_uses_high_precision_display_path_without_mutating_source(tmp_path):
    pixels = np.array(
        [[[0, 1024, 65_535], [32_767, 16_384, 8192]]],
        dtype=np.uint16,
    )
    workbench, _, request, source_path = _tiff_fixture(tmp_path, pixels)
    request["view"]["channels"][0].update(low=0.0, high=32_767.0, gamma=1.0)
    before = source_path.read_bytes()
    target = tmp_path / "adjusted-rgb16.tiff"

    export_rendered_source(workbench, request, target)

    expected = np.asarray(
        np.rint(np.clip(pixels.astype(np.float64) / 32_767.0, 0, 1) * 65_535),
        dtype=np.uint16,
    )
    np.testing.assert_array_equal(tifffile.imread(target), expected)
    with tifffile.TiffFile(target) as tif:
        provenance = json.loads(tif.pages[0].description)
        assert provenance["precision_policy"] == "adjusted-uint16-display-codes"
    assert source_path.read_bytes() == before


def test_profiled_rgb_uses_the_validated_icc_display_and_leaves_raw_source_stable(tmp_path):
    pixels = np.arange(5 * 7 * 3, dtype=np.uint8).reshape(5, 7, 3)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    workbench, source, request, source_path = _tiff_fixture(tmp_path, pixels, icc_profile=profile)
    before = source_path.read_bytes()
    target = tmp_path / "profiled-rendered.tiff"

    export_rendered_source(workbench, request, target)

    np.testing.assert_array_equal(tifffile.imread(target), pixels.astype(np.uint16) * 257)
    with tifffile.TiffFile(target) as tif:
        provenance = json.loads(tif.pages[0].description)
        assert provenance["precision_policy"] == "uint8-display-expanded-to-uint16"
        assert provenance["rgb_color_policy"]["transform"] == "Pillow-ImageCms-source-to-sRGB"
        assert tif.pages[0].tags[34675].value
    assert source_path.read_bytes() == before
    assert source["sha256"] == hashlib.sha256(before).hexdigest()


def test_tiff_size_guard_fails_before_creating_or_decoding_output(tmp_path, monkeypatch):
    pixels = np.zeros((32, 32), dtype=np.uint16)
    workbench, _, request, _ = _tiff_fixture(tmp_path, pixels)
    monkeypatch.setattr(rendered_export_module, "MAX_RENDERED_TIFF_BYTES", 1)
    target = tmp_path / "guarded.tiff"

    with pytest.raises(ValueError, match="64 GiB output guard"):
        export_rendered_source(workbench, request, target)

    assert not target.exists()
    assert not list(tmp_path.glob(".loci-rendered-*"))


def test_footer_memory_is_bounded_before_raster_allocation(monkeypatch):
    def refuse_allocation(*_args, **_kwargs):
        raise AssertionError("A huge footer must be rejected before allocating its raster")

    monkeypatch.setattr(rendered_export_module.np, "full", refuse_allocation)
    with pytest.raises(ValueError, match="bounded footer size"):
        rendered_export_module._plan_footer(
            width=1_000_000,
            image_height=200,
            channels=3,
            bit_depth=16,
            options=rendered_export_module._FigureOptions(300, False, True, ()),
            geometry={},
            legend=({"channel": 0, "name": "Channel 1", "color": "#ffffff"},),
        )


@pytest.mark.parametrize("dtype", [np.uint8, np.uint16])
@pytest.mark.parametrize("rgb", [False, True])
def test_png_quantization_provenance_only_claims_actual_uint16_rgb_conversion(tmp_path, dtype, rgb):
    values = np.array([[0, 1, 127, 255]], dtype=dtype)
    pixels = np.repeat(values[..., None], 3, axis=-1) if rgb else values
    workbench, source, request, _ = _tiff_fixture(tmp_path, pixels)
    try:
        request["format"] = "png"
        target = tmp_path / "precision.png"
        export_rendered_source(workbench, request, target)
        with Image.open(target) as image:
            provenance = json.loads(image.info["Loci rendering provenance"])
        assert provenance["canvas_quantization"] == (
            "uint16-fixed-range-nearest-v1" if rgb and dtype == np.uint16 else None
        )
    finally:
        workbench.close()


def _multichannel_split_fixture(tmp_path):
    path = tmp_path / "split-source.ome.tiff"
    height, width = 128, 192
    yy, xx = np.indices((height, width), dtype=np.uint16)
    planes = np.zeros((3, height, width), dtype=np.uint16)
    planes[0] = ((xx * 500 + yy * 200) % 60_000).astype(np.uint16)
    planes[1] = (((width - 1 - xx) * 400 + yy * 150) % 50_000 + 5_000).astype(np.uint16)
    planes[2] = 42_000
    tifffile.imwrite(
        path,
        planes,
        ome=True,
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.5,
            "PhysicalSizeYUnit": "µm",
            "Channel": {"Name": ["Channel Alpha", "Channel Beta", "Hidden Gamma"]},
        },
    )
    workbench = Workbench(ResearchProject.create(tmp_path / "split.loci-study", "Split"))
    source = workbench.import_native(str(path))
    channels = workbench.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
    channels[0].update(
        low=1_000.0, high=51_000.0, gamma=1.5, color="#ff00ff", opacity=1.0, visible=True
    )
    channels[1].update(
        low=5_000.0, high=55_000.0, gamma=0.8, color="#00ff00", opacity=0.75, visible=True
    )
    channels[2].update(
        low=0.0, high=65_535.0, gamma=1.0, color="#00ffff", opacity=1.0, visible=False
    )
    return workbench, source, path, planes, channels


def _expected_gray_and_merge(planes, channels, *, bit_depth: int, invert: bool):
    maximum = 255 if bit_depth == 8 else 65_535
    dtype = np.uint8 if bit_depth == 8 else np.uint16
    visible = [entry for entry in channels if entry["visible"] and entry["opacity"] > 0]
    composite = np.zeros((*planes.shape[1:], 3), dtype=np.float64)
    grays = {}
    for entry in visible:
        ch = entry["channel"]
        norm = np.clip(
            (planes[ch].astype(np.float64) - entry["low"]) / (entry["high"] - entry["low"]),
            0.0,
            1.0,
        )
        norm = np.power(norm, 1.0 / entry["gamma"]) * entry["opacity"]
        gray = np.rint(np.clip(norm, 0.0, 1.0) * maximum).astype(dtype)
        if invert:
            gray = (maximum - gray.astype(np.int32)).astype(dtype)
        grays[ch] = np.repeat(gray[..., None], 3, axis=-1)
        rgb = np.array(
            [int(entry["color"][i : i + 2], 16) / 255.0 for i in (1, 3, 5)],
            dtype=np.float64,
        )
        composite += norm[..., None] * rgb
    merge = np.rint(np.clip(composite, 0.0, 1.0) * maximum).astype(dtype)
    return grays, merge


@pytest.mark.parametrize("export_format", ["png", "tiff"])
@pytest.mark.parametrize("layout", ["channels-and-merge-row", "channels-and-merge-column"])
@pytest.mark.parametrize("invert", [False, True])
def test_split_channel_figure_exact_pixel_mapping_determinism_and_merge_parity(
    tmp_path, monkeypatch, export_format, layout, invert
):
    workbench, source, source_path, planes, channels = _multichannel_split_fixture(tmp_path)
    before_bytes = source_path.read_bytes()
    before_mtime = source_path.stat().st_mtime_ns
    try:
        selection = {
            "x": 16,
            "y": 12,
            "width": 160,
            "height": 96,
            "level": 0,
            "c": 0,
            "z": 0,
            "t": 0,
        }
        labels = [
            {"channel": 0, "name": "Channel Alpha", "color": "#ff00ff"},
            {"channel": 1, "name": "Channel Beta", "color": "#00ff00"},
        ]
        view = {
            "source_id": source["id"],
            "selection": selection,
            "channels": channels,
            "figure": {
                "dpi": 300,
                "scale_bar": True,
                "channel_legend": True,
                "layout": layout,
                "invert_grayscale": invert,
                "channel_labels": labels,
            },
        }
        suffix = "png" if export_format == "png" else "tiff"
        target_a = tmp_path / f"split-a.{suffix}"
        target_b = tmp_path / f"split-b.{suffix}"
        target_merge = tmp_path / f"merge-only.{suffix}"

        base_req = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "format": export_format,
            "view": view,
        }
        with monkeypatch.context() as patch:
            if export_format == "png":
                original_save = Image.Image.save

                def save_to_disk(image, stream, **options):
                    assert stream.fileno() >= 0
                    return original_save(image, stream, **options)

                patch.setattr(Image.Image, "save", save_to_disk)
            receipt_a = export_rendered_source(workbench, base_req, target_a)
        receipt_b = export_rendered_source(workbench, base_req, target_b)
        merge_view = {
            "source_id": source["id"],
            "selection": selection,
            "channels": channels,
        }
        export_rendered_source(
            workbench,
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "format": export_format,
                "view": merge_view,
            },
            target_merge,
        )

        # Determinism: exact identical bytes and provenance hash.
        assert target_a.read_bytes() == target_b.read_bytes()
        assert receipt_a["sha256"] == receipt_b["sha256"]
        assert receipt_a["provenance_sha256"] == receipt_b["provenance_sha256"]
        assert receipt_a["layout"] == layout

        bit_depth = 8 if export_format == "png" else 16
        crop = planes[:, 12:108, 16:176]
        expected_grays, expected_merge = _expected_gray_and_merge(
            crop, channels, bit_depth=bit_depth, invert=invert
        )
        if export_format == "png":
            with Image.open(target_a) as img:
                raster = np.asarray(img)
                provenance = json.loads(img.info["Loci rendering provenance"])
            with Image.open(target_merge) as merge_img:
                standalone_merge = np.asarray(merge_img)
        else:
            with tifffile.TiffFile(target_a) as tif:
                raster = tif.pages[0].asarray()
                provenance = json.loads(tif.pages[0].description)
            standalone_merge = tifffile.imread(target_merge)

        figure = provenance["figure"]
        panels = figure["panels"]
        assert figure["layout"] == layout
        assert figure["invert_grayscale"] is invert
        assert "universally color-blind-safe" in figure["accessibility_note"]
        assert "not original-value quantitative data" in provenance["meaning"]
        assert str(tmp_path) not in json.dumps(provenance)
        assert [p["kind"] for p in panels] == ["grayscale", "grayscale", "merge"]
        assert [p["name"] for p in panels] == ["Channel Alpha", "Channel Beta", "Merge"]
        assert panels[0]["channel"] == 0 and panels[1]["channel"] == 1
        assert panels[0]["window"] == {
            "low": 1000.0,
            "high": 51000.0,
            "gamma": 1.5,
            "opacity": 1.0,
        }
        assert panels[1]["window"] == {
            "low": 5000.0,
            "high": 55000.0,
            "gamma": 0.8,
            "opacity": 0.75,
        }
        assert "gray" in panels[0]["window_label"] and "1000-51000" in panels[0]["window_label"]

        for idx, panel in enumerate(panels):
            px, py, pw, ph = panel["raster_xywh"]
            assert (pw, ph) == (160, 96)
            panel_pixels = raster[py : py + ph, px : px + pw]
            if panel["kind"] == "grayscale":
                np.testing.assert_array_equal(panel_pixels, expected_grays[panel["channel"]])
                if invert:
                    border_val = 34 if bit_depth == 8 else 34 * 257
                    expected_border = np.array(
                        [border_val, border_val, border_val], dtype=raster.dtype
                    )
                    np.testing.assert_array_equal(raster[py - 1, px], expected_border)
                    np.testing.assert_array_equal(raster[py + ph, px], expected_border)
                    np.testing.assert_array_equal(raster[py, px - 1], expected_border)
                    np.testing.assert_array_equal(raster[py, px + pw], expected_border)
            else:
                assert idx == 2
                np.testing.assert_array_equal(panel_pixels, expected_merge)
                np.testing.assert_array_equal(panel_pixels, standalone_merge)

        if layout == "channels-and-merge-row":
            assert (
                panels[0]["raster_xywh"][1]
                == panels[1]["raster_xywh"][1]
                == panels[2]["raster_xywh"][1]
            )
            assert (
                panels[0]["raster_xywh"][0]
                < panels[1]["raster_xywh"][0]
                < panels[2]["raster_xywh"][0]
            )
        else:
            assert (
                panels[0]["raster_xywh"][0]
                == panels[1]["raster_xywh"][0]
                == panels[2]["raster_xywh"][0]
            )
            assert (
                panels[0]["raster_xywh"][1]
                < panels[1]["raster_xywh"][1]
                < panels[2]["raster_xywh"][1]
            )

        scale = figure["footer"]["scale_bar"]
        assert scale["applies_to"] == "each-panel"
        assert scale["bar_xywh"][2] < 160
        sx, sy, sw, sh = scale["bar_xywh"]
        assert np.all(raster[sy : sy + sh, sx : sx + sw] == 0)
        assert workbench.project.list_results() == []
    finally:
        workbench.close()
    assert source_path.read_bytes() == before_bytes
    assert source_path.stat().st_mtime_ns == before_mtime


def test_row_and_standalone_scale_bars_use_the_same_panel_width_at_high_dpi():
    geometry = {"unit": "um", "axes": "YX", "affine": np.diag([0.8, 0.8, 1.0, 1.0]).tolist()}
    options = rendered_export_module._FigureOptions(1200, True, False, ())
    for footer_width in (160, 842):
        footer = rendered_export_module._plan_footer(
            width=footer_width,
            image_height=120,
            channels=3,
            bit_depth=8,
            options=options,
            geometry=geometry,
            legend=(),
            scale_reference_width=160,
        )
        assert footer is not None
        scale = footer.record["scale_bar"]
        assert scale["label"] == "20 µm"
        assert scale["bar_xywh"][2] == 25
        assert scale["represented_length_um"] == 20.0
        x, y, w, h = scale["bar_xywh"]
        offset_y = y - footer.record["offset_y"]
        assert np.all(footer.render()[offset_y : offset_y + h, x : x + w] == 0)


def test_scientific_symbols_are_printed_as_distinct_glyphs(tmp_path):
    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)
    try:
        for channel in channels[:2]:
            channel.update(low=0, high=50_000, gamma=1, opacity=1)
        labels = [
            {"channel": index, "name": name, "color": channels[index]["color"]}
            for index, name in enumerate(["α", "β"])
        ]
        view = {
            "source_id": source["id"],
            "overview": True,
            "channels": channels,
            "figure": {
                "layout": "channels-and-merge-row",
                "scale_bar": True,
                "channel_labels": labels,
            },
        }
        request = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "format": "png",
            "view": view,
        }
        dest = tmp_path / "scientific-symbols.png"
        export_rendered_source(workbench, request, dest)
        with Image.open(dest) as image:
            figure = json.loads(image.info["Loci rendering provenance"])["figure"]
            raster = np.array(image)
        headers = []
        for panel in figure["panels"][:2]:
            x, y, w, h = panel["header_xywh"]
            headers.append(raster[y : y + h, x : x + w])
        # Identical numeric captions leave the Greek letter as the sole difference.
        assert not np.array_equal(*headers)
        assert len(figure["header_font"]["sha256"]) == 64
        assert len(figure["footer"]["font"]["sha256"]) == 64
        assert "µm" in figure["footer"]["scale_bar"]["label"]

        labels[0]["name"] = "\U0010ffff"
        refused = tmp_path / "missing-glyph.png"
        with pytest.raises(ValueError, match="font"):
            export_rendered_source(workbench, request, refused)
        assert not refused.exists()
    finally:
        workbench.close()


@pytest.mark.parametrize(
    ("export_format", "overview", "projection"),
    [("png", True, "max"), ("png", False, "mean"), ("tiff", False, "mean")],
)
def test_split_channel_projection_skips_inactive_planes_and_preserves_display(
    tmp_path, monkeypatch, export_format, overview, projection
):
    path = tmp_path / "zstack.ome.tiff"
    data = np.full((6, 3, 72, 96), 65_535, dtype=np.uint16)
    data[1] = np.array([1_000, 20_000, 5_000])[:, None, None]
    data[4] = np.array([6_000, 12_000, 18_000])[:, None, None]
    tifffile.imwrite(path, data, ome=True, metadata={"axes": "CZYX"})
    workbench = Workbench(ResearchProject.create(tmp_path / "proj.loci-study", "Proj"))
    source = workbench.import_native(str(path))
    channels = workbench.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
    for index, display in enumerate(channels):
        display.update(
            low=0.0,
            high=65_535.0,
            gamma=1.3 if index == 1 else 0.8,
            color="#00ffff" if index == 1 else "#ff00ff",
            opacity=0.0 if index in {2, 5} else 0.75,
            visible=index not in {0, 3},
        )
    try:
        view = {
            "source_id": source["id"],
            "channels": channels,
            "projection": projection,
            **(
                {"overview": True, "max_edge": 1024, "z_stop": 3}
                if overview
                else {"selection": {"x": 0, "y": 0, "width": 96, "height": 72, "z_stop": 3}}
            ),
        }
        standalone = workbench.execute("viewer_tile", view)
        reads = []
        original = NativeImageSession.read_region

        def guarded(self, selection):
            assert selection.c in {1, 4}
            reads.append((selection.c, selection.z))
            return original(self, selection)

        monkeypatch.setattr(NativeImageSession, "read_region", guarded)
        request = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "format": export_format,
            "view": {
                **view,
                "figure": {
                    "layout": "channels-and-merge-row",
                    "channel_labels": [
                        {"channel": idx, "name": name, "color": channels[idx]["color"]}
                        for idx, name in ((1, "ChB"), (4, "ChE"))
                    ],
                },
            },
        }
        target = tmp_path / f"z-{projection}.{export_format}"
        receipt = export_rendered_source(workbench, request, target)
        assert set(reads) == {(channel, z) for channel in (1, 4) for z in range(3)}
        assert receipt["display_revision"] == standalone["display_revision"]
        if export_format == "png":
            with Image.open(target) as img:
                raster = np.asarray(img)
                provenance = json.loads(img.info["Loci rendering provenance"])
            rendering = provenance["rendering"]
            assert rendering["selection"]["c"] == 0  # Default remains the first request mapping.
            assert provenance["request"]["channels"] == channels
            bit_depth = 8
        else:
            with tifffile.TiffFile(target) as tif:
                raster = tif.pages[0].asarray()
                provenance = json.loads(tif.pages[0].description)
            rendering = provenance
            bit_depth = 16
        assert rendering["display"] == standalone["display"]
        assert rendering["projection"] == projection
        assert provenance["source_sha256"] == source["sha256"]
        assert provenance["figure"]["footer"] is None
        projected = np.max(data, axis=1) if projection == "max" else np.mean(data, axis=1)
        expected_grays, expected_merge = _expected_gray_and_merge(
            projected, channels, bit_depth=bit_depth, invert=False
        )
        for panel in provenance["figure"]["panels"]:
            px, py, pw, ph = panel["raster_xywh"]
            region = raster[py : py + ph, px : px + pw]
            if panel["kind"] == "grayscale":
                np.testing.assert_array_equal(region, expected_grays[panel["channel"]])
            else:
                assert panel["channels"] == [1, 4]
                np.testing.assert_array_equal(region, expected_merge)
    finally:
        workbench.close()


def test_split_tiff16_reads_only_bounded_tiles_across_multi_tile_layout(tmp_path, monkeypatch):
    path = tmp_path / "tiled-split.ome.tiff"
    data = np.zeros((2, 300, 320), dtype=np.uint16)
    data[0] = np.arange(300 * 320, dtype=np.uint16).reshape(300, 320)
    data[1] = 65_535 - data[0]
    tifffile.imwrite(
        path,
        data,
        ome=True,
        metadata={"axes": "CYX", "Channel": {"Name": ["First", "Second"]}},
    )
    workbench = Workbench(ResearchProject.create(tmp_path / "tile-split.loci-study", "TileSplit"))
    source = workbench.import_native(str(path))
    channels = workbench.execute("viewer_defaults", {"source_id": source["id"]})["channels"]
    channels[0].update(
        low=0.0, high=65_535.0, gamma=1.0, color="#ffffff", opacity=1.0, visible=True
    )
    channels[1].update(
        low=0.0, high=65_535.0, gamma=1.0, color="#ff00ff", opacity=1.0, visible=True
    )
    observed = []
    original = NativeImageSession.read_region

    def guarded(self, sel):
        assert sel.width <= 256 and sel.height <= 256
        observed.append((sel.width, sel.height))
        return original(self, sel)

    monkeypatch.setattr(NativeImageSession, "read_region", guarded)
    try:
        request = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "format": "tiff",
            "view": {
                "source_id": source["id"],
                "selection": {
                    "x": 0,
                    "y": 0,
                    "width": 320,
                    "height": 300,
                    "level": 0,
                    "c": 0,
                    "z": 0,
                    "t": 0,
                },
                "channels": channels,
                "figure": {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": False,
                    "channel_labels": [
                        {"channel": 0, "name": "First", "color": "#ffffff"},
                        {"channel": 1, "name": "Second", "color": "#ff00ff"},
                    ],
                },
            },
        }
        target = tmp_path / "tiled-split.tiff"
        receipt = export_rendered_source(workbench, request, target)
        assert observed
        assert receipt["image_width"] == 320 and receipt["image_height"] == 300
        with tifffile.TiffFile(target) as tif:
            raster = tif.pages[0].asarray()
            prov = json.loads(tif.pages[0].description)
        expected_grays, expected_merge = _expected_gray_and_merge(
            data, channels, bit_depth=16, invert=False
        )
        for panel in prov["figure"]["panels"]:
            px, py, pw, ph = panel["raster_xywh"]
            region = raster[py : py + ph, px : px + pw]
            if panel["kind"] == "grayscale":
                np.testing.assert_array_equal(region, expected_grays[panel["channel"]])
            else:
                np.testing.assert_array_equal(region, expected_merge)
    finally:
        workbench.close()


def test_split_channel_invalid_inputs_refuse_cleanly_without_publishing(tmp_path):
    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)
    try:
        base_selection = {
            "x": 0,
            "y": 0,
            "width": 96,
            "height": 72,
            "level": 0,
            "c": 0,
            "z": 0,
            "t": 0,
        }
        labels = [
            {"channel": 0, "name": "Channel Alpha", "color": "#ff00ff"},
            {"channel": 1, "name": "Channel Beta", "color": "#00ff00"},
        ]

        bad_cases = [
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "merge",
                    "invert_grayscale": True,
                    "channel_labels": [],
                },
                channels,
                "Inverted grayscale applies only to separate grayscale channel panels",
            ),
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "grid",
                    "invert_grayscale": False,
                    "channel_labels": labels,
                },
                channels,
                "Rendered figure layout must be",
            ),
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": "yes",
                    "channel_labels": labels,
                },
                channels,
                "Inverted grayscale option must be boolean",
            ),
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": False,
                    "channel_labels": [],
                },
                channels,
                "Channel labels must be present",
            ),
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": False,
                    "channel_labels": [{"channel": 0, "name": "Only One", "color": "#ff00ff"}],
                },
                [channels[0], {**channels[1], "visible": False}, channels[2]],
                "at least two visible scalar channels",
            ),
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": False,
                    "channel_labels": [{"channel": 0, "name": "Only One", "color": "#ff00ff"}],
                },
                [channels[0], {**channels[1], "opacity": 0.0}, channels[2]],
                "at least two visible scalar channels",
            ),
            (
                {
                    "dpi": 300,
                    "scale_bar": False,
                    "channel_legend": False,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": False,
                    "channel_labels": [
                        {"channel": 0, "name": "Wrong Color", "color": "#00ffff"},
                        labels[1],
                    ],
                },
                channels,
                "colors must match",
            ),
        ]
        for idx, (fig, chs, pattern) in enumerate(bad_cases):
            target = tmp_path / f"bad-{idx}.png"
            with pytest.raises(ValueError, match=pattern):
                export_rendered_source(
                    workbench,
                    {
                        "source_id": source["id"],
                        "source_sha256": source["sha256"],
                        "format": "png",
                        "view": {
                            "source_id": source["id"],
                            "selection": base_selection,
                            "channels": chs,
                            "figure": fig,
                        },
                    },
                    target,
                )
            assert not target.exists()

        # Too-narrow panel (< 64 px) is refused cleanly.
        narrow_target = tmp_path / "narrow.png"
        with pytest.raises(ValueError, match="at least 64 pixels wide"):
            export_rendered_source(
                workbench,
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "format": "png",
                    "view": {
                        "source_id": source["id"],
                        "selection": {**base_selection, "width": 48},
                        "channels": channels,
                        "figure": {
                            "dpi": 300,
                            "scale_bar": False,
                            "channel_legend": False,
                            "layout": "channels-and-merge-row",
                            "invert_grayscale": False,
                            "channel_labels": labels,
                        },
                    },
                },
                narrow_target,
            )
        assert not narrow_target.exists()

        # Column layout narrower than MIN_FOOTER_WIDTH with footer enabled fails cleanly.
        narrow_col_target = tmp_path / "narrow-col-footer.png"
        with pytest.raises(ValueError, match="at least 160 pixels wide"):
            export_rendered_source(
                workbench,
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "format": "png",
                    "view": {
                        "source_id": source["id"],
                        "selection": base_selection,
                        "channels": channels,
                        "figure": {
                            "dpi": 300,
                            "scale_bar": True,
                            "channel_legend": False,
                            "layout": "channels-and-merge-column",
                            "invert_grayscale": False,
                            "channel_labels": labels,
                        },
                    },
                },
                narrow_col_target,
            )
        assert not narrow_col_target.exists()
    finally:
        workbench.close()

    # RGB source is refused cleanly.
    rgb_wb, rgb_source, rgb_req, _ = fixture(tmp_path)
    try:
        rgb_req["view"]["figure"] = {
            "dpi": 300,
            "scale_bar": False,
            "channel_legend": False,
            "layout": "channels-and-merge-row",
            "invert_grayscale": False,
            "channel_labels": [
                {"channel": 0, "name": "Red?", "color": "#ffffff"},
                {"channel": 1, "name": "Green?", "color": "#ffffff"},
            ],
        }
        rgb_target = tmp_path / "rgb-split.png"
        with pytest.raises(ValueError, match="scalar source channels"):
            export_rendered_source(rgb_wb, rgb_req, rgb_target)
        assert not rgb_target.exists()
    finally:
        rgb_wb.close()


def _guard_figure_rasters(monkeypatch):
    original_new = Image.new

    def small_measurement_only(mode, size, *args, **kwargs):
        assert size == (1, 1), f"Allocated Pillow raster {size} before preflight"
        return original_new(mode, size, *args, **kwargs)

    def unexpected_array(*_args, **_kwargs):
        pytest.fail("Allocated NumPy raster before preflight")

    monkeypatch.setattr(Image, "new", small_measurement_only)
    monkeypatch.setattr(rendered_export_module.np, "full", unexpected_array)


def _split_export_request(source, channels, *, overview=False, export_format="png"):
    return {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "format": export_format,
        "view": {
            "source_id": source["id"],
            **(
                {"overview": True}
                if overview
                else {"selection": {"x": 0, "y": 0, "width": 96, "height": 72}}
            ),
            "channels": channels,
            "figure": {
                "layout": "channels-and-merge-row",
                "channel_labels": [
                    {
                        "channel": display["channel"],
                        "name": f"Ch {display['channel']}",
                        "color": display["color"],
                    }
                    for display in channels
                    if display["visible"] and display["opacity"] > 0
                ],
            },
        },
    }


@pytest.mark.parametrize("overview", [False, True])
def test_split_png_limit_includes_footer_before_raster_allocation(tmp_path, monkeypatch, overview):
    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)
    try:
        request = _split_export_request(source, channels, overview=overview)
        baseline = export_rendered_source(workbench, request, tmp_path / "no-footer.png")
        monkeypatch.setattr(
            rendered_export_module, "MAX_SPLIT_PNG_PIXELS", baseline["width"] * baseline["height"]
        )
        request["view"]["figure"]["channel_legend"] = True
        _guard_figure_rasters(monkeypatch)
        monkeypatch.setattr(
            NativeImageSession, "read_region", lambda *_: pytest.fail("Decoded before preflight")
        )
        target = tmp_path / "guarded-split.png"
        with pytest.raises(ValueError, match="bounded raster limit"):
            export_rendered_source(workbench, request, target)
        assert not target.exists()
    finally:
        workbench.close()


@pytest.mark.parametrize(
    ("height", "visible_count", "channel_count", "error"),
    [
        (1_700, 4, 4, "aggregate working-memory budget"),
        (2_048, 8, 8, "bounded raster limit"),
        (1_200, 2, 6, None),
        (1_200, 6, 6, "aggregate working-memory budget"),
    ],
)
def test_split_mean_png_preflight_at_real_limits(
    tmp_path, monkeypatch, height, visible_count, channel_count, error
):
    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)

    class DecodeReached(Exception):
        pass

    try:
        metadata = workbench._session(source["id"]).metadata
        dimensions = replace(metadata.dimensions, x=2_048, y=height, c=channel_count, z=2)
        metadata = replace(
            metadata,
            dimensions=dimensions,
            levels=(replace(metadata.levels[0], dimensions=dimensions),),
            channel_dtypes=(metadata.channel_dtypes[0],) * channel_count,
        )

        def read_region(selection):
            if error is not None:
                pytest.fail("Decoded before preflight")
            assert selection.c < visible_count
            raise DecodeReached

        session = SimpleNamespace(
            metadata=metadata,
            geometry=lambda *_: SimpleNamespace(to_dict=dict),
            read_region=read_region,
        )
        monkeypatch.setattr(workbench, "_session", lambda *_: session)
        channels = [
            {**channels[0], "channel": index, "visible": index < visible_count}
            for index in range(channel_count)
        ]
        request = _split_export_request(source, channels)
        request["view"]["selection"].update(width=2_048, height=height, z_stop=2)
        request["view"]["projection"] = "mean"
        target = tmp_path / "guarded-mean.png"
        if error is None:
            with pytest.raises(DecodeReached):
                export_rendered_source(workbench, request, target)
        else:
            _guard_figure_rasters(monkeypatch)
            with pytest.raises(ValueError, match=error):
                export_rendered_source(workbench, request, target)
        assert not target.exists()
    finally:
        workbench.close()


@pytest.mark.parametrize("storage_guard", [False, True])
def test_split_tiff_guards_precede_header_and_footer_rasters(tmp_path, monkeypatch, storage_guard):
    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)
    try:
        request = _split_export_request(source, channels, export_format="tiff")
        request["view"]["figure"]["channel_legend"] = True
        if storage_guard:
            monkeypatch.setattr(
                rendered_export_module.shutil, "disk_usage", lambda _: SimpleNamespace(free=0)
            )
            error = "free destination storage"
        else:
            monkeypatch.setattr(rendered_export_module, "MAX_RENDERED_TIFF_BYTES", 1)
            error = "64 GiB output guard"
        _guard_figure_rasters(monkeypatch)
        monkeypatch.setattr(
            NativeImageSession, "read_region", lambda *_: pytest.fail("Decoded before preflight")
        )
        target = tmp_path / "guarded-split.tiff"
        with pytest.raises(ValueError, match=error):
            export_rendered_source(workbench, request, target)
        assert not target.exists()
        assert not list(tmp_path.glob(".loci-rendered-*"))
    finally:
        workbench.close()


def test_split_channel_normal_rpc_entry_point_exports_png_and_tiff16(tmp_path):
    import loci_engine.research_rpc as research_rpc_module

    workbench, source, _, planes, channels = _multichannel_split_fixture(tmp_path)
    project_root = str(workbench.project.root)
    workbench.close()
    try:
        request = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "format": "png",
            "view": {
                "source_id": source["id"],
                "selection": {
                    "x": 0,
                    "y": 0,
                    "width": 192,
                    "height": 128,
                    "level": 0,
                    "c": 0,
                    "z": 0,
                    "t": 0,
                },
                "channels": channels,
                "figure": {
                    "dpi": 300,
                    "scale_bar": True,
                    "channel_legend": True,
                    "layout": "channels-and-merge-row",
                    "invert_grayscale": True,
                    "channel_labels": [
                        {"channel": 0, "name": "Channel Alpha", "color": "#ff00ff"},
                        {"channel": 1, "name": "Channel Beta", "color": "#00ff00"},
                    ],
                },
            },
        }
        png_dest = tmp_path / "rpc-split.png"
        png_receipt = research_rpc_module.dispatch_research(
            "research_source_rendered_export",
            {"project": project_root, "request": request, "destination": str(png_dest)},
        )
        assert png_receipt["format"] == "png"
        assert png_receipt["layout"] == "channels-and-merge-row"
        with Image.open(png_dest) as img:
            prov = json.loads(img.info["Loci rendering provenance"])
            assert prov["figure"]["invert_grayscale"] is True
            assert [p["name"] for p in prov["figure"]["panels"]] == [
                "Channel Alpha",
                "Channel Beta",
                "Merge",
            ]

        tiff_dest = tmp_path / "rpc-split.tiff"
        tiff_receipt = research_rpc_module.dispatch_research(
            "research_source_rendered_export",
            {
                "project": project_root,
                "request": {**request, "format": "tiff"},
                "destination": str(tiff_dest),
            },
        )
        assert tiff_receipt["format"] == "tiff"
        assert tiff_receipt["layout"] == "channels-and-merge-row"
        with tifffile.TiffFile(tiff_dest) as tif:
            raster = tif.pages[0].asarray()
            tiff_prov = json.loads(tif.pages[0].description)
        expected_grays, _ = _expected_gray_and_merge(planes, channels, bit_depth=16, invert=True)
        p0 = tiff_prov["figure"]["panels"][0]["raster_xywh"]
        np.testing.assert_array_equal(
            raster[p0[1] : p0[1] + p0[3], p0[0] : p0[0] + p0[2]],
            expected_grays[0],
        )
    finally:
        if research_rpc_module._ACTIVE is not None:
            research_rpc_module._ACTIVE.close()
            research_rpc_module._ACTIVE = None


def test_split_channel_preserves_saved_measurements_and_refuses_single_and_palette_sources(
    tmp_path,
):
    from loci_engine.research_jobs import run_job, submit_job

    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)
    try:
        job = submit_job(
            workbench,
            {
                "source_id": source["id"],
                "recipe": {
                    "segmentation": {"method": "components", "threshold": 15_000, "min_size": 10},
                    "measurement_channels": [0, 1],
                },
            },
            "split-preserve-check",
        )
        measured = run_job(workbench, job["id"])["result"]
        rows_before = workbench.execute(
            "result",
            {"result_id": measured["id"], "offset": 0, "limit": 100},
        )
        assert rows_before["total_rows"] > 0
        target = tmp_path / "preserve-measure.png"
        export_rendered_source(
            workbench,
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "format": "png",
                "view": {
                    "source_id": source["id"],
                    "overview": True,
                    "max_edge": 1024,
                    "channels": channels,
                    "figure": {
                        "dpi": 300,
                        "scale_bar": False,
                        "channel_legend": False,
                        "layout": "channels-and-merge-row",
                        "invert_grayscale": False,
                        "channel_labels": [
                            {"channel": 0, "name": "Channel Alpha", "color": "#ff00ff"},
                            {"channel": 1, "name": "Channel Beta", "color": "#00ff00"},
                        ],
                    },
                },
            },
            target,
        )
        rows_after = workbench.execute(
            "result",
            {"result_id": measured["id"], "offset": 0, "limit": 100},
        )
        assert rows_after == rows_before
        assert len(workbench.project.list_results()) == 1
    finally:
        workbench.close()

    single = np.full((64, 64), 100, dtype=np.uint16)
    single_wb, single_src, single_req, _ = _tiff_fixture(tmp_path, single)
    try:
        single_req["format"] = "png"
        single_req["view"]["figure"] = {
            "dpi": 300,
            "scale_bar": False,
            "channel_legend": False,
            "layout": "channels-and-merge-row",
            "invert_grayscale": False,
            "channel_labels": [{"channel": 0, "name": "Single", "color": "#ffffff"}],
        }
        with pytest.raises(ValueError, match="at least two visible scalar channels"):
            export_rendered_source(single_wb, single_req, tmp_path / "single-split.png")
        assert not (tmp_path / "single-split.png").exists()
    finally:
        single_wb.close()

    palette_path = tmp_path / "palette-split.tiff"
    indices = np.zeros((64, 64), dtype=np.uint8)
    indices[:, 32:] = 1
    lut = np.zeros((3, 256), dtype=np.uint16)
    lut[0, 1] = 65_535
    lut[1, 0] = 32_768
    tifffile.imwrite(palette_path, indices, photometric="palette", colormap=lut)
    pal_wb = Workbench(ResearchProject.create(tmp_path / "pal-study.loci-study", "Palette"))
    try:
        pal_source = pal_wb.import_native(str(palette_path))
        pal_channels = pal_wb.execute("viewer_defaults", {"source_id": pal_source["id"]})[
            "channels"
        ]
        with pytest.raises(ValueError, match="scalar source channels"):
            export_rendered_source(
                pal_wb,
                {
                    "source_id": pal_source["id"],
                    "source_sha256": pal_source["sha256"],
                    "format": "png",
                    "view": {
                        "source_id": pal_source["id"],
                        "overview": True,
                        "max_edge": 1024,
                        "channels": pal_channels,
                        "figure": {
                            "dpi": 300,
                            "scale_bar": False,
                            "channel_legend": False,
                            "layout": "channels-and-merge-row",
                            "invert_grayscale": False,
                            "channel_labels": [
                                {"channel": 0, "name": "C1", "color": "#ffffff"},
                                {"channel": 1, "name": "C2", "color": "#ff00ff"},
                            ],
                        },
                    },
                },
                tmp_path / "palette-split.png",
            )
        assert not (tmp_path / "palette-split.png").exists()
    finally:
        pal_wb.close()


def test_split_channel_header_pixel_guard_rejects_before_allocation(tmp_path, monkeypatch):
    workbench, source, _, _, channels = _multichannel_split_fixture(tmp_path)
    monkeypatch.setattr(rendered_export_module, "MAX_HEADER_PIXELS", 1)
    try:
        target = tmp_path / "guarded-header.png"
        with pytest.raises(ValueError, match="headers exceed the bounded size"):
            export_rendered_source(
                workbench,
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "format": "png",
                    "view": {
                        "source_id": source["id"],
                        "overview": True,
                        "max_edge": 1024,
                        "channels": channels,
                        "figure": {
                            "dpi": 300,
                            "scale_bar": False,
                            "channel_legend": False,
                            "layout": "channels-and-merge-row",
                            "invert_grayscale": False,
                            "channel_labels": [
                                {"channel": 0, "name": "Channel Alpha", "color": "#ff00ff"},
                                {"channel": 1, "name": "Channel Beta", "color": "#00ff00"},
                            ],
                        },
                    },
                },
                target,
            )
        assert not target.exists()
    finally:
        workbench.close()
