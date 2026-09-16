from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import tifffile

import loci_engine.io as io_module
from loci_engine.io import DecodedImageTooLargeError, UnsupportedImageError, load_image
from loci_engine.worker import handle_request


def _rgb_source() -> np.ndarray:
    values = np.arange(96 * 128 * 3, dtype=np.uint32).reshape(96, 128, 3)
    return (values % 251).astype(np.uint8)


def _write_pyramid(path: Path, source: np.ndarray) -> None:
    with tifffile.TiffWriter(path, bigtiff=True) as writer:
        writer.write(
            source,
            photometric="rgb",
            tile=(16, 16),
            subifds=2,
        )
        writer.write(
            source[::2, ::2],
            photometric="rgb",
            tile=(16, 16),
            subfiletype=1,
        )
        writer.write(
            source[::4, ::4],
            photometric="rgb",
            tile=(16, 16),
            subfiletype=1,
        )


def test_oversized_pyramid_decodes_only_a_real_bounded_overview(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "pyramid.tif"
    source = _rgb_source()
    _write_pyramid(path, source)
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", 10_000)
    monkeypatch.setattr(io_module, "MAX_TIFF_OVERVIEW_DECODED_BYTES", 3_000)

    decoded_shapes: list[tuple[int, ...]] = []
    original_asarray = tifffile.TiffPage.asarray

    def guarded_asarray(
        page: tifffile.TiffPage,
        *args: object,
        **kwargs: object,
    ) -> np.ndarray:
        shape = tuple(int(value) for value in page.shape)
        if shape == source.shape:
            raise AssertionError("the full-resolution pyramid root was decoded")
        decoded_shapes.append(shape)
        return original_asarray(page, *args, **kwargs)

    monkeypatch.setattr(tifffile.TiffPage, "asarray", guarded_asarray)

    image, metadata = load_image(path)

    np.testing.assert_array_equal(image, source[::4, ::4])
    assert decoded_shapes == [(24, 32, 3)]
    assert (metadata.width, metadata.height) == (128, 96)
    assert metadata.channels == 3
    assert metadata.dtype == "uint8"
    assert metadata.access_mode == "overview"
    assert metadata.view_only_reason is not None
    assert "Segmentation" in metadata.view_only_reason
    assert metadata.source_details == {
        "kind": "tiff-pyramid",
        "width": 128,
        "height": 96,
        "channels": 3,
        "dtype": "uint8",
        "resolution_levels": 3,
        "selected_resolution_level": 2,
        "selected_level_width": 32,
        "selected_level_height": 24,
        "full_decoded_bytes": source.nbytes,
        "selected_decoded_bytes": source[::4, ::4].nbytes,
        "tiled": True,
        "selected_level_tiled": True,
    }


def test_overview_source_cannot_be_segmented_or_exported_as_full_resolution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "view-only-pyramid.tif"
    source = _rgb_source()
    _write_pyramid(path, source)
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", 10_000)
    monkeypatch.setattr(io_module, "MAX_TIFF_OVERVIEW_DECODED_BYTES", 3_000)
    _, metadata = load_image(path)

    segment_response = handle_request(
        {
            "id": "segment-overview",
            "method": "segment",
            "params": {
                "path": str(path),
                "expected_sha256": metadata.sha256,
            },
        }
    )
    export_response = handle_request(
        {
            "id": "export-overview",
            "method": "export_view",
            "params": {
                "path": str(path),
                "expected_sha256": metadata.sha256,
                "directory": str(tmp_path),
                "directory_identity": {},
                "filename": "must-not-exist.tiff",
                "format": "tiff",
                "settings": {},
            },
        }
    )

    assert segment_response["error"]["type"] == "ValueError"
    assert "pyramidal TIFF" in segment_response["error"]["message"]
    assert export_response["error"]["type"] == "ValueError"
    assert "pyramidal TIFF" in export_response["error"]["message"]
    assert not (tmp_path / "must-not-exist.tiff").exists()


def test_single_level_tiled_tiff_does_not_masquerade_as_an_overview(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "single-level-tiled.tif"
    source = _rgb_source()
    tifffile.imwrite(path, source, photometric="rgb", tile=(16, 16))
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", 10_000)

    def fail_if_decoded(_page: object) -> np.ndarray:
        raise AssertionError("an oversized single-level TIFF was decoded")

    def fail_if_hashed(_path: object) -> str:
        raise AssertionError("an oversized single-level TIFF was hashed")

    monkeypatch.setattr(tifffile.TiffPage, "asarray", fail_if_decoded)
    monkeypatch.setattr(io_module, "_fingerprint", fail_if_hashed)

    with pytest.raises(DecodedImageTooLargeError, match=r"requires .* after decoding"):
        load_image(path)


def test_pyramid_without_a_bounded_compatible_level_is_rejected_before_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "unusable-pyramid.tif"
    source = _rgb_source()
    _write_pyramid(path, source)
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", 10_000)
    monkeypatch.setattr(io_module, "MAX_TIFF_OVERVIEW_DECODED_BYTES", 1)

    def fail_if_decoded(_page: object) -> np.ndarray:
        raise AssertionError("a pyramid without a bounded overview was decoded")

    def fail_if_hashed(_path: object) -> str:
        raise AssertionError("a rejected pyramid was hashed")

    monkeypatch.setattr(tifffile.TiffPage, "asarray", fail_if_decoded)
    monkeypatch.setattr(io_module, "_fingerprint", fail_if_hashed)

    with pytest.raises(UnsupportedImageError, match=r"none of its compatible.*overview guard"):
        load_image(path)


def test_pyramid_with_a_safe_root_keeps_complete_full_resolution_access(
    tmp_path: Path,
) -> None:
    path = tmp_path / "safe-pyramid.tif"
    source = _rgb_source()
    _write_pyramid(path, source)

    image, metadata = load_image(path)

    np.testing.assert_array_equal(image, source)
    assert (metadata.width, metadata.height) == (128, 96)
    assert metadata.access_mode == "full"
    assert metadata.view_only_reason is None
    assert metadata.source_details is None


def test_palette_pyramid_rejects_reduced_level_with_a_different_colour_map(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "palette-mismatch.tif"
    source = np.arange(96 * 128, dtype=np.uint8).reshape(96, 128)
    root_map = np.zeros((3, 256), dtype=np.uint16)
    root_map[0] = np.arange(256, dtype=np.uint16) * 257
    overview_map = root_map.copy()
    overview_map[[0, 1]] = overview_map[[1, 0]]
    with tifffile.TiffWriter(path) as writer:
        writer.write(source, photometric="palette", colormap=root_map, subifds=1)
        writer.write(
            source[::4, ::4],
            photometric="palette",
            colormap=overview_map,
            subfiletype=1,
        )
    monkeypatch.setattr(io_module, "MAX_DECODED_SOURCE_BYTES", 10_000)
    monkeypatch.setattr(io_module, "MAX_TIFF_OVERVIEW_DECODED_BYTES", 10_000)

    def fail_if_decoded(_page: object) -> np.ndarray:
        raise AssertionError("a palette-incompatible pyramid level was decoded")

    monkeypatch.setattr(tifffile.TiffPage, "asarray", fail_if_decoded)

    with pytest.raises(UnsupportedImageError, match=r"none of its compatible.*overview guard"):
        load_image(path)


def test_invalid_tiff_orientation_is_rejected_before_codec_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "invalid-orientation.tif"
    tifffile.imwrite(
        path,
        np.zeros((8, 9), dtype=np.uint8),
        photometric="minisblack",
        extratags=[(274, "H", 1, 9, False)],
    )

    def fail_if_decoded(_page: object) -> np.ndarray:
        raise AssertionError("an invalid orientation reached the TIFF codec")

    monkeypatch.setattr(tifffile.TiffPage, "asarray", fail_if_decoded)

    with pytest.raises(UnsupportedImageError, match="invalid EXIF orientation 9"):
        load_image(path)
