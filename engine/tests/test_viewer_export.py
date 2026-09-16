from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image

import loci_engine.viewer_export as viewer_export_module
from loci_engine.io import load_image
from loci_engine.models import ViewerDisplaySettings
from loci_engine.render import _display_bounds, _display_float
from loci_engine.viewer_export import render_adjusted_view
from loci_engine.worker import handle_request


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _root_identity(path: Path) -> dict[str, str]:
    stat = path.stat()
    return {"device": str(stat.st_dev), "inode": str(stat.st_ino)}


def _export_view(
    source: Path,
    directory: Path,
    filename: str,
    *,
    export_format: str,
    settings: dict[str, object] | None = None,
    expected_sha256: str | None = None,
) -> dict[str, object]:
    params: dict[str, object] = {
        "path": str(source),
        "directory": str(directory),
        "directory_identity": _root_identity(directory),
        "filename": filename,
        "format": export_format,
        "settings": settings or {},
    }
    if expected_sha256 is not None:
        params["expected_sha256"] = expected_sha256
    return handle_request({"id": "view", "method": "export_view", "params": params})


def test_png_view_export_is_full_resolution_traceable_and_source_preserving(
    tmp_path: Path,
) -> None:
    source_pixels = np.array(
        [
            [[0, 17, 255], [241, 122, 37]],
            [[18, 93, 207], [255, 255, 255]],
        ],
        dtype=np.uint8,
    )
    source = tmp_path / "source.png"
    Image.fromarray(source_pixels, mode="RGB").save(source)
    source_hash = _sha256(source)
    source_stat = source.stat()

    response = _export_view(
        source,
        tmp_path,
        "rendered.png",
        export_format="png",
        expected_sha256=source_hash,
    )

    assert "error" not in response
    receipt = response["result"]
    exported = tmp_path / "rendered.png"
    assert receipt == {
        "path": str(exported),
        "format": "png",
        "width": 2,
        "height": 2,
        "channels": 3,
        "dtype": "uint8",
        "byte_length": exported.stat().st_size,
        "source_sha256": source_hash,
        "output_sha256": _sha256(exported),
        "settings": {
            "black_point": 0.0,
            "white_point": 1.0,
            "brightness": 0.0,
            "contrast": 100.0,
            "gamma": 1.0,
            "saturation": 100.0,
            "red": True,
            "green": True,
            "blue": True,
        },
    }
    with Image.open(exported) as rendered:
        assert rendered.size == (2, 2)
        assert rendered.mode == "RGB"
        np.testing.assert_array_equal(np.asarray(rendered), source_pixels)
    assert _sha256(source) == source_hash
    assert source.stat().st_mtime_ns == source_stat.st_mtime_ns
    assert not list(tmp_path.glob(".loci-view-*"))


def test_tiff_view_export_uses_lossless_16_bit_neutral_grayscale(tmp_path: Path) -> None:
    source_pixels = np.array([[0, 64, 128, 255]], dtype=np.uint8)
    source = tmp_path / "gray.png"
    Image.fromarray(source_pixels, mode="L").save(source)

    response = _export_view(source, tmp_path, "gray-view.tiff", export_format="tiff")

    assert "error" not in response
    exported = tmp_path / "gray-view.tiff"
    pixels = tifffile.imread(exported)
    assert pixels.dtype == np.uint16
    assert pixels.shape == source_pixels.shape
    np.testing.assert_array_equal(pixels, source_pixels.astype(np.uint16) * 257)
    assert response["result"]["channels"] == 1
    assert response["result"]["dtype"] == "uint16"


def test_neutral_tiff_view_export_preserves_sixteen_bit_rgb_samples(tmp_path: Path) -> None:
    source_pixels = np.array(
        [[[0, 1024, 65_535], [51_200, 17_000, 321]]],
        dtype=np.uint16,
    )
    source = tmp_path / "rgb16.tiff"
    tifffile.imwrite(source, source_pixels, photometric="rgb")

    response = _export_view(source, tmp_path, "rgb16-view.tiff", export_format="tiff")

    assert "error" not in response
    np.testing.assert_array_equal(tifffile.imread(tmp_path / "rgb16-view.tiff"), source_pixels)


def test_rgba_export_preserves_source_alpha(tmp_path: Path) -> None:
    source_pixels = np.array(
        [[[18, 93, 207, 0], [241, 122, 37, 128], [2, 9, 16, 255]]],
        dtype=np.uint8,
    )
    source = tmp_path / "alpha.png"
    Image.fromarray(source_pixels, mode="RGBA").save(source)

    response = _export_view(source, tmp_path, "alpha-view.png", export_format="png")

    assert "error" not in response
    with Image.open(tmp_path / "alpha-view.png") as rendered:
        assert rendered.mode == "RGBA"
        np.testing.assert_array_equal(np.asarray(rendered), source_pixels)
    assert response["result"]["channels"] == 4

    tiff_response = _export_view(
        source,
        tmp_path,
        "alpha-view.tiff",
        export_format="tiff",
    )
    assert "error" not in tiff_response
    tiff_pixels = tifffile.imread(tmp_path / "alpha-view.tiff")
    assert tiff_pixels.dtype == np.uint16
    np.testing.assert_array_equal(tiff_pixels, source_pixels.astype(np.uint16) * 257)


def test_display_transform_matches_the_documented_order_and_channel_masks() -> None:
    source = np.array([[[64, 128, 192]]], dtype=np.uint8)
    settings = ViewerDisplaySettings(
        black_point=0.25,
        white_point=0.75,
        brightness=10,
        contrast=120,
        gamma=2,
        saturation=0,
        red=True,
        green=False,
        blue=True,
    )

    actual = render_adjusted_view(source, settings, bit_depth=8)

    source_float = source.astype(np.float32) / 255.0
    luminance = (
        source_float[..., 0] * 0.213 + source_float[..., 1] * 0.715 + source_float[..., 2] * 0.072
    )
    windowed = np.clip((luminance - 0.25) / 0.5, 0, 1)
    adjusted = np.clip((np.sqrt(windowed) - 0.5) * 1.2 + 0.5 + 0.1, 0, 1)
    expected_value = np.asarray(np.rint(adjusted * 255), dtype=np.uint8)
    expected = np.stack((expected_value, np.zeros_like(expected_value), expected_value), axis=-1)
    np.testing.assert_array_equal(actual, expected)


def test_oversaturation_clamps_before_gamma_to_match_svg_filter_primitives() -> None:
    source = np.array([[[255, 0, 0]]], dtype=np.uint8)
    settings = ViewerDisplaySettings(saturation=200, gamma=0.5)

    actual = render_adjusted_view(source, settings, bit_depth=8)

    np.testing.assert_array_equal(actual, np.array([[[255, 0, 0]]], dtype=np.uint8))


@pytest.mark.parametrize(
    "source",
    [
        np.pad(
            np.full((62, 126), 1_000, dtype=np.uint16),
            1,
            constant_values=50_000,
        ),
        np.pad(
            np.full((62, 126), -300, dtype=np.int16),
            1,
            constant_values=12_000,
        ),
        np.pad(
            np.full((62, 126), 0.2, dtype=np.float32),
            1,
            constant_values=8.0,
        ),
    ],
    ids=["sparse-uint16", "sparse-signed", "sparse-float"],
)
def test_export_uses_the_shared_bounded_source_dn_basis(source: np.ndarray) -> None:
    bounds = _display_bounds(source)

    actual = render_adjusted_view(source, ViewerDisplaySettings(), bit_depth=8)
    expected = _display_float(source, display_bounds=bounds)
    expected = np.asarray(np.rint(expected * 255), dtype=np.uint8)

    np.testing.assert_array_equal(actual, expected)


def test_render_refuses_an_export_above_its_working_memory_guard(
    monkeypatch,
) -> None:
    source = np.zeros((8, 8, 4), dtype=np.uint16)
    monkeypatch.setattr(viewer_export_module, "MAX_VIEWER_RENDER_WORKING_BYTES", 1)

    with np.testing.assert_raises_regex(ValueError, "working-memory guard"):
        render_adjusted_view(source, ViewerDisplaySettings(), bit_depth=16)


def test_grayscale_export_rejects_inapplicable_rgb_display_controls() -> None:
    source = np.zeros((8, 8), dtype=np.uint16)

    with np.testing.assert_raises_regex(ValueError, "only to RGB or RGBA"):
        render_adjusted_view(
            source,
            ViewerDisplaySettings(red=False),
            bit_depth=16,
        )


def test_export_refuses_overwrite_source_replacement_and_format_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    Image.fromarray(np.array([[0, 255]], dtype=np.uint8), mode="L").save(source)
    existing = tmp_path / "existing.png"
    existing.write_bytes(b"belongs to the user")

    collision = _export_view(source, tmp_path, existing.name, export_format="png")
    replacement = _export_view(source, tmp_path, source.name, export_format="png")
    mismatch = _export_view(source, tmp_path, "wrong.jpg", export_format="png")

    assert collision["error"]["type"] == "FileExistsError"
    assert existing.read_bytes() == b"belongs to the user"
    assert replacement["error"]["type"] == "ValueError"
    assert "source image" in replacement["error"]["message"]
    assert mismatch["error"]["type"] == "ValueError"
    assert not list(tmp_path.glob(".loci-view-*"))


def test_export_rechecks_source_fingerprint_and_validates_settings(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    Image.fromarray(np.array([[0, 255]], dtype=np.uint8), mode="L").save(source)
    _, metadata = load_image(source)

    changed = _export_view(
        source,
        tmp_path,
        "changed.png",
        export_format="png",
        expected_sha256="0" * 64,
    )
    invalid = _export_view(
        source,
        tmp_path,
        "invalid.png",
        export_format="png",
        expected_sha256=metadata.sha256,
        settings={"gamma": 0.1},
    )
    unknown = _export_view(
        source,
        tmp_path,
        "unknown.png",
        export_format="png",
        settings={"extra": True},
    )
    invalid_window = _export_view(
        source,
        tmp_path,
        "invalid-window.png",
        export_format="png",
        settings={"black_point": 0.8, "white_point": 0.2},
    )

    assert changed["error"]["type"] == "SourceChangedError"
    assert invalid["error"]["type"] == "ValueError"
    assert "gamma" in invalid["error"]["message"]
    assert unknown["error"]["type"] == "ValueError"
    assert "Unknown viewer display settings" in unknown["error"]["message"]
    assert invalid_window["error"]["type"] == "ValueError"
    assert "black_point" in invalid_window["error"]["message"]
    assert not (tmp_path / "changed.png").exists()
    assert not (tmp_path / "invalid.png").exists()
    assert not (tmp_path / "unknown.png").exists()
    assert not (tmp_path / "invalid-window.png").exists()
