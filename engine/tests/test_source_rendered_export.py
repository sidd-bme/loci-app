import hashlib
import json

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
        rendered_export_module._render_footer(
            width=1_000_000,
            image_height=200,
            channels=3,
            bit_depth=16,
            options=rendered_export_module._FigureOptions(300, False, True, ()),
            geometry={},
            legend=({"channel": 0, "name": "Channel 1", "color": "#ffffff"},),
        )
