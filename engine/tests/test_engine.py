from __future__ import annotations

import base64
import json
import struct
import zlib
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
import pytest
import tifffile
from PIL import Image, ImageDraw, PngImagePlugin

import loci_engine.io as io_module
from loci_engine.io import SourceChangedError, UnsupportedImageError, load_image
from loci_engine.models import ENGINE_VERSION, SegmentationSettings
from loci_engine.segment import _to_gray_float, segment_image
from loci_engine.worker import handle_request


def synthetic_cells(*, bright: bool = True) -> np.ndarray:
    background = 18 if bright else 238
    foreground = 235 if bright else 24
    image = Image.new("L", (420, 300), color=background)
    draw = ImageDraw.Draw(image)
    circles = [
        (42, 42, 88, 88),
        (128, 50, 180, 102),
        (240, 38, 296, 94),
        (70, 174, 120, 224),
        (185, 166, 241, 222),
        (316, 182, 366, 232),
    ]
    for bounds in circles:
        draw.ellipse(bounds, fill=foreground)
    return np.asarray(image)


@pytest.mark.parametrize(
    ("bright", "mode", "expected_polarity"),
    [(True, "fluorescence", "bright"), (False, "brightfield", "dark")],
)
def test_segments_six_separated_cells(bright: bool, mode: str, expected_polarity: str) -> None:
    output = segment_image(
        synthetic_cells(bright=bright),
        SegmentationSettings(
            image_mode=mode,
            expected_diameter_px=48,
            min_area_px=250,
        ),
    )

    assert output.count == 6
    assert output.resolved_polarity == expected_polarity
    assert 5 < output.confluence_percent < 20
    assert [row["cell_id"] for row in output.measurements] == list(range(1, 7))


def test_normalized_display_stays_inside_declared_range_at_float32_endpoint() -> None:
    rng = np.random.default_rng(20260907)
    image = None
    for _ in range(8):
        image = rng.integers(0, 256, size=(73, 91, 3), dtype=np.uint8)
    assert image is not None

    normalized = _to_gray_float(image)

    assert normalized.dtype == np.float32
    assert np.all(np.isfinite(normalized))
    assert float(normalized.min()) >= 0.0
    assert float(normalized.max()) <= 1.0


def test_loads_png_jpeg_and_sixteen_bit_tiff(tmp_path: Path) -> None:
    png_path = tmp_path / "cells.png"
    jpeg_path = tmp_path / "cells.jpg"
    tiff_path = tmp_path / "cells.tiff"
    source = synthetic_cells()
    Image.fromarray(source).save(png_path)
    Image.fromarray(source).save(jpeg_path, quality=95)
    tifffile.imwrite(tiff_path, source.astype(np.uint16) * 257)

    for path, expected_format in (
        (png_path, "PNG"),
        (jpeg_path, "JPEG"),
        (tiff_path, "TIFF"),
    ):
        array, metadata = load_image(path)
        assert array.shape == (300, 420)
        assert metadata.format == expected_format
        assert metadata.sha256


def test_palette_png_is_normalized_to_displayed_rgb_values(tmp_path: Path) -> None:
    path = tmp_path / "palette.png"
    palette_image = Image.new("P", (2, 1))
    palette = [0] * (256 * 3)
    palette[3:6] = [18, 93, 207]
    palette[6:9] = [241, 122, 37]
    palette_image.putpalette(palette)
    palette_image.putdata([1, 2])
    palette_image.save(path)

    array, metadata = load_image(path)

    assert array.shape == (1, 2, 3)
    np.testing.assert_array_equal(array[0], [[18, 93, 207], [241, 122, 37]])
    assert metadata.channels == 3
    assert metadata.dtype == "uint8"


def test_palette_transparency_png_is_normalized_to_displayed_rgba(tmp_path: Path) -> None:
    path = tmp_path / "transparent-palette.png"
    palette_image = Image.new("P", (2, 1))
    palette = [0] * (256 * 3)
    palette[3:6] = [18, 93, 207]
    palette[6:9] = [241, 122, 37]
    palette_image.putpalette(palette)
    palette_image.putdata([1, 2])
    palette_image.save(path, transparency=1)

    array, metadata = load_image(path)

    assert array.shape == (1, 2, 4)
    np.testing.assert_array_equal(
        array[0],
        [[18, 93, 207, 0], [241, 122, 37, 255]],
    )
    assert metadata.channels == 4
    assert metadata.dtype == "uint8"


def test_sixteen_bit_rgb_png_preserves_samples_and_channel_order(tmp_path: Path) -> None:
    path = tmp_path / "high-depth-rgb.png"
    source = np.array(
        [[[0, 1024, 65_535], [51_200, 17_000, 321]]],
        dtype=np.uint16,
    )
    assert cv2.imwrite(str(path), cv2.cvtColor(source, cv2.COLOR_RGB2BGR))

    array, metadata = load_image(path)

    assert array.dtype == np.uint16
    np.testing.assert_array_equal(array, source)
    assert metadata.channels == 3
    assert metadata.dtype == "uint16"


def test_png_decode_uses_a_memory_map_instead_of_np_fromfile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "mapped.png"
    source = np.arange(9 * 13 * 3, dtype=np.uint8).reshape(9, 13, 3)
    Image.fromarray(source, mode="RGB").save(path)

    def fail_fromfile(*_args: object, **_kwargs: object) -> np.ndarray:
        raise AssertionError("PNG decoding must not materialize the encoded file with np.fromfile")

    monkeypatch.setattr(io_module.np, "fromfile", fail_fromfile)

    array, _metadata = load_image(path)

    np.testing.assert_array_equal(array, source)


def _metadata_only_grayscale_png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def test_loci_decoded_budget_replaces_pillows_global_pixel_heuristic(tmp_path: Path) -> None:
    path = tmp_path / "large-metadata-only.png"
    path.write_bytes(_metadata_only_grayscale_png(20_000, 10_000))

    # 190.7 MiB grayscale is under Loci's 512 MiB decoded guard even though it
    # exceeds Pillow's default global decompression-bomb pixel heuristic.
    assert io_module._preflight_decode(path) is None


def test_metadata_only_png_above_loci_budget_rejects_before_hashing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "over-budget-metadata-only.png"
    path.write_bytes(_metadata_only_grayscale_png(30_000, 30_000))

    def fail_if_hashed(_path: object) -> str:
        raise AssertionError("an over-budget PNG was hashed")

    monkeypatch.setattr(io_module, "_fingerprint", fail_if_hashed)

    with pytest.raises(UnsupportedImageError, match=r"requires .* after decoding"):
        load_image(path)


def test_png_decoder_input_guard_runs_before_hashing_or_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "oversized-ancillary.png"
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("note", "must not be parsed before the decoder-input guard")
    Image.fromarray(synthetic_cells()).save(path, pnginfo=png_info)
    with path.open("ab") as stream:
        stream.write(b"oversized trailing payload")
    monkeypatch.setattr(io_module, "MAX_PNG_DECODER_INPUT_BYTES", path.stat().st_size - 1)

    def fail_if_hashed(_path: object) -> str:
        raise AssertionError("PNG hashing ran before the decoder-input guard")

    def fail_if_decoded(*_args: object, **_kwargs: object) -> np.ndarray:
        raise AssertionError("PNG decode ran before the decoder-input guard")

    def fail_if_ancillary_parsed(*_args: object, **_kwargs: object) -> bytes:
        raise AssertionError("PNG ancillary metadata was parsed before the decoder-input guard")

    monkeypatch.setattr(io_module, "_fingerprint", fail_if_hashed)
    monkeypatch.setattr(io_module.cv2, "imdecode", fail_if_decoded)
    monkeypatch.setattr(PngImagePlugin.PngStream, "chunk_tEXt", fail_if_ancillary_parsed)

    with pytest.raises(
        UnsupportedImageError,
        match=r"PNG-decoder input guard.*does not limit TIFF or IMS",
    ):
        load_image(path)


def test_grayscale_alpha_png_is_normalized_to_displayed_rgba(tmp_path: Path) -> None:
    path = tmp_path / "grayscale-alpha.png"
    source = Image.new("LA", (2, 1))
    source.putdata([(40, 0), (190, 128)])
    source.save(path)

    array, metadata = load_image(path)

    assert array.shape == (1, 2, 4)
    np.testing.assert_array_equal(
        array[0],
        [[40, 40, 40, 0], [190, 190, 190, 128]],
    )
    assert metadata.channels == 4
    assert metadata.dtype == "uint8"


def test_cmyk_jpeg_is_normalized_to_rgb(tmp_path: Path) -> None:
    path = tmp_path / "cmyk.jpg"
    source = Image.new("CMYK", (12, 8), color=(25, 140, 210, 35))
    source.save(path, quality=100, subsampling=0)
    with Image.open(path) as encoded:
        expected = np.asarray(encoded.convert("RGB"))

    array, metadata = load_image(path)

    np.testing.assert_array_equal(array, expected)
    assert array.shape == (8, 12, 3)
    assert metadata.channels == 3
    assert metadata.dtype == "uint8"


def test_jpeg_exif_orientation_is_applied_to_pixels_and_metadata(tmp_path: Path) -> None:
    path = tmp_path / "oriented.jpg"
    source = np.array(
        [
            [[255, 0, 0], [0, 255, 0]],
            [[0, 0, 255], [255, 255, 0]],
            [[255, 0, 255], [0, 255, 255]],
        ],
        dtype=np.uint8,
    )
    exif = Image.Exif()
    exif[274] = 6
    Image.fromarray(source, mode="RGB").save(
        path,
        quality=100,
        subsampling=0,
        exif=exif,
    )
    with Image.open(path) as encoded:
        stored_pixels = np.asarray(encoded.convert("RGB"))

    array, metadata = load_image(path)

    np.testing.assert_array_equal(array, np.rot90(stored_pixels, 3))
    assert array.shape == (2, 3, 3)
    assert metadata.width == 3
    assert metadata.height == 2


def test_rejects_animated_png_instead_of_selecting_first_frame(tmp_path: Path) -> None:
    path = tmp_path / "animated.png"
    first = Image.new("RGB", (12, 8), color=(10, 20, 30))
    second = Image.new("RGB", (12, 8), color=(220, 210, 200))
    first.save(path, save_all=True, append_images=[second], duration=100, loop=0)

    with pytest.raises(UnsupportedImageError, match=r"PNG contains 2 frames.*one still image"):
        load_image(path)


def test_rejects_renamed_multi_page_tiff_instead_of_selecting_first_page(
    tmp_path: Path,
) -> None:
    tiff_path = tmp_path / "stack.tif"
    renamed_path = tmp_path / "stack.png"
    tifffile.imwrite(
        tiff_path,
        np.stack([synthetic_cells(), synthetic_cells()]),
        photometric="minisblack",
    )
    tiff_path.rename(renamed_path)

    with pytest.raises(UnsupportedImageError, match=r"TIFF contains 2 pages.*one still image"):
        load_image(renamed_path)


def test_loads_planar_rgb_tiff_as_interleaved_rgb(tmp_path: Path) -> None:
    path = tmp_path / "planar-rgb.tif"
    planar = np.zeros((3, 7, 11), dtype=np.uint8)
    planar[0] = 17
    planar[1] = 89
    planar[2] = 231
    tifffile.imwrite(path, planar, photometric="rgb", planarconfig="separate")

    array, metadata = load_image(path)

    assert array.shape == (7, 11, 3)
    np.testing.assert_array_equal(array[0, 0], [17, 89, 231])
    assert metadata.width == 11
    assert metadata.height == 7
    assert metadata.channels == 3


def test_loads_lzw_tiff_without_mutating_source(tmp_path: Path) -> None:
    path = tmp_path / "lzw-rgb.tif"
    source = np.arange(37 * 53 * 3, dtype=np.uint8).reshape(37, 53, 3)
    tifffile.imwrite(path, source, photometric="rgb", compression="lzw")
    encoded_before = path.read_bytes()

    array, metadata = load_image(path)

    np.testing.assert_array_equal(array, source)
    assert metadata.width == 53
    assert metadata.height == 37
    assert metadata.channels == 3
    assert path.read_bytes() == encoded_before


def test_miniswhite_tiff_is_inverted_to_display_intensity(tmp_path: Path) -> None:
    path = tmp_path / "miniswhite.tif"
    encoded = np.array([[0, 64, 255]], dtype=np.uint8)
    tifffile.imwrite(path, encoded, photometric="miniswhite")

    array, metadata = load_image(path)

    np.testing.assert_array_equal(array, [[255, 191, 0]])
    assert metadata.channels == 1
    assert metadata.dtype == "uint8"


def test_palette_tiff_is_expanded_to_declared_rgb_colormap(tmp_path: Path) -> None:
    path = tmp_path / "palette.tif"
    indices = np.array([[0, 1]], dtype=np.uint8)
    colormap = np.zeros((3, 256), dtype=np.uint16)
    colormap[:, 0] = [65_535, 0, 0]
    colormap[:, 1] = [0, 32_768, 65_535]
    tifffile.imwrite(path, indices, photometric="palette", colormap=colormap)

    array, metadata = load_image(path)

    np.testing.assert_array_equal(
        array,
        np.array([[[65_535, 0, 0], [0, 32_768, 65_535]]], dtype=np.uint16),
    )
    assert metadata.channels == 3
    assert metadata.dtype == "uint16"


def test_rejects_cmyk_tiff_instead_of_inferring_rgba(tmp_path: Path) -> None:
    path = tmp_path / "cmyk.tif"
    cmyk = np.zeros((3, 5, 4), dtype=np.uint8)
    tifffile.imwrite(path, cmyk, photometric="separated")

    with pytest.raises(UnsupportedImageError, match="unsupported photometric.*SEPARATED"):
        load_image(path)


@pytest.mark.parametrize(
    ("photometric", "source"),
    [
        ("rgb", np.array([[[4095, 0, 0]]], dtype=np.uint16)),
        ("miniswhite", np.array([[4095]], dtype=np.uint16)),
    ],
)
def test_rejects_packed_subdtype_tiff_samples_with_actionable_message(
    tmp_path: Path,
    photometric: str,
    source: np.ndarray,
) -> None:
    path = tmp_path / f"packed-{photometric}.tif"
    tifffile.imwrite(path, source, photometric=photometric, bitspersample=12)

    with pytest.raises(UnsupportedImageError, match=r"packed 12-bit samples.*unpacked 16-bit TIFF"):
        load_image(path)


def test_rejects_multi_page_tiff_with_actionable_message(tmp_path: Path) -> None:
    path = tmp_path / "stack.tif"
    tifffile.imwrite(
        path,
        np.stack([synthetic_cells(), synthetic_cells()]),
        photometric="minisblack",
    )

    with pytest.raises(UnsupportedImageError, match="contains 2 pages"):
        load_image(path)


def test_rejects_images_above_the_decode_budget_before_processing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "large.png"
    Image.fromarray(synthetic_cells()).save(path)
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", 1_000)

    with pytest.raises(UnsupportedImageError, match=r"requires .* MiB after decoding"):
        load_image(path)


def test_tiff_decode_budget_is_checked_before_codec_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "over-budget-lzw.tif"
    source = np.zeros((32, 48, 3), dtype=np.uint8)
    tifffile.imwrite(path, source, photometric="rgb", compression="lzw")
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", source.nbytes - 1)

    def fail_if_decoded(_page: object) -> np.ndarray:
        raise AssertionError("TIFF codec ran before the metadata-derived memory guard")

    def fail_if_hashed(_path: object) -> str:
        raise AssertionError("source hashing ran before the metadata-derived memory guard")

    monkeypatch.setattr(tifffile.TiffPage, "asarray", fail_if_decoded)
    monkeypatch.setattr(io_module, "_fingerprint", fail_if_hashed)

    with pytest.raises(UnsupportedImageError, match=r"requires .* after decoding"):
        load_image(path)


def test_loads_compressed_tiff_above_the_former_pixel_cap(tmp_path: Path) -> None:
    path = tmp_path / "large-compressed.tif"
    # This uniform image is cheap on disk but contains more than the former
    # arbitrary 30-million-pixel cap. Its decoded plane remains within the
    # explicit memory guard.
    source = np.zeros((5_500, 5_500), dtype=np.uint8)
    source[0, 0] = 17
    source[-1, -1] = 239
    tifffile.imwrite(path, source, photometric="minisblack", compression="lzw")

    array, metadata = load_image(path)

    assert array.shape == source.shape
    assert int(array[0, 0]) == 17
    assert int(array[-1, -1]) == 239
    assert metadata.width == 5_500
    assert metadata.height == 5_500


def test_encoded_file_length_is_not_an_eager_decode_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "sparse-trailer-lzw.tif"
    source = np.arange(16 * 24, dtype=np.uint8).reshape(16, 24)
    tifffile.imwrite(path, source, photometric="minisblack", compression="lzw")
    with path.open("r+b") as stream:
        stream.truncate(512 * 1024 * 1024 + 1)
    logical_size = path.stat().st_size
    monkeypatch.setattr(io_module, "_fingerprint", lambda _path: "a" * 64)

    array, metadata = load_image(path)

    np.testing.assert_array_equal(array, source)
    assert metadata.sha256 == "a" * 64
    assert path.stat().st_size == logical_size


def test_rejects_a_source_that_changed_after_import(tmp_path: Path) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(synthetic_cells()).save(path)
    _, metadata = load_image(path)
    changed = synthetic_cells().copy()
    changed[0, 0] = 99
    Image.fromarray(changed).save(path)

    with pytest.raises(SourceChangedError, match="changed after it was imported"):
        load_image(path, expected_sha256=metadata.sha256)


def test_rejects_a_source_that_mutates_during_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(synthetic_cells()).save(path)
    fingerprints = iter(["a" * 64, "b" * 64])
    monkeypatch.setattr(io_module, "_fingerprint", lambda _path: next(fingerprints))

    with pytest.raises(SourceChangedError, match="changed while Loci was reading"):
        load_image(path)


def test_worker_inspect_supports_bounded_and_hash_checked_previews(tmp_path: Path) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(synthetic_cells()).save(path)
    _, metadata = load_image(path)

    response = handle_request(
        {
            "id": "inspect-1",
            "method": "inspect",
            "params": {
                "path": str(path),
                "expected_sha256": metadata.sha256.upper(),
                "max_edge": 100,
            },
        }
    )

    assert "error" not in response
    assert response["result"]["engine_version"] == ENGINE_VERSION
    encoded = response["result"]["preview_data_url"].partition(",")[2]
    with Image.open(BytesIO(base64.b64decode(encoded))) as preview:
        assert preview.size == (100, 71)
    assert response["result"]["source"]["sha256"] == metadata.sha256


@pytest.mark.parametrize(
    ("max_edge", "error_type"),
    [(63, "ValueError"), (2201, "ValueError"), (100.5, "TypeError"), (True, "TypeError")],
)
def test_worker_inspect_rejects_invalid_preview_bounds(
    tmp_path: Path, max_edge: object, error_type: str
) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(synthetic_cells()).save(path)

    response = handle_request(
        {
            "id": "inspect-invalid",
            "method": "inspect",
            "params": {"path": str(path), "max_edge": max_edge},
        }
    )

    assert response["error"]["type"] == error_type


def test_worker_inspect_rejects_a_stale_expected_hash(tmp_path: Path) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(synthetic_cells()).save(path)

    response = handle_request(
        {
            "id": "inspect-stale",
            "method": "inspect",
            "params": {"path": str(path), "expected_sha256": "0" * 64},
        }
    )

    assert response["error"]["type"] == "SourceChangedError"
    assert "changed after it was imported" in response["error"]["message"]


def test_worker_response_is_serializable(tmp_path: Path) -> None:
    path = tmp_path / "cells.png"
    Image.fromarray(synthetic_cells()).save(path)

    response = handle_request(
        {
            "id": "analysis-1",
            "method": "segment",
            "params": {
                "path": str(path),
                "settings": {
                    "image_mode": "fluorescence",
                    "expected_diameter_px": 48,
                    "min_area_px": 250,
                },
            },
        }
    )

    encoded = json.dumps(response)
    assert '"count": 6' in encoded
    assert response["result"]["overlay_data_url"].startswith("data:image/png;base64,")


def test_settings_validation_rejects_unsafe_values() -> None:
    with pytest.raises(ValueError, match="expected_diameter_px"):
        SegmentationSettings(expected_diameter_px=0).validate()
