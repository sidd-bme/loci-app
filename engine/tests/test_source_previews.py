from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
import pytest
import tifffile
from PIL import Image

import loci_engine.render as render_module
from loci_engine.io import UnsupportedImageError, load_image
from loci_engine.render import render_display_statistics, render_preview
from loci_engine.worker import handle_request


def _decode_preview(data_url: str) -> Image.Image:
    encoded = data_url.partition(",")[2]
    with Image.open(BytesIO(base64.b64decode(encoded))) as preview:
        return preview.copy()


def _inspect(path: Path) -> dict[str, object]:
    _, metadata = load_image(path)
    response = handle_request(
        {
            "id": "inspect-color",
            "method": "inspect",
            "params": {
                "path": str(path),
                "expected_sha256": metadata.sha256,
                "max_edge": 64,
            },
        }
    )
    assert "error" not in response
    return response["result"]


def test_inspect_preview_preserves_uint8_rgb_fidelity(tmp_path: Path) -> None:
    source = np.array(
        [
            [[0, 17, 255], [241, 122, 37]],
            [[18, 93, 207], [255, 255, 255]],
        ],
        dtype=np.uint8,
    )
    path = tmp_path / "color.png"
    Image.fromarray(source, mode="RGB").save(path)

    result = _inspect(path)
    preview = _decode_preview(str(result["preview_data_url"]))

    assert preview.mode == "RGB"
    np.testing.assert_array_equal(np.asarray(preview), source)
    statistics = result["display_statistics"]
    assert statistics["basis"] == "luminance"
    assert statistics["sample_count"] == 4
    assert statistics["display_minimum"] == 0
    assert statistics["display_maximum"] == 255
    assert statistics["source_minimum"] == 0
    assert statistics["source_maximum"] == 255
    assert len(statistics["histogram_bins"]) == 96
    assert sum(statistics["histogram_bins"]) == statistics["sample_count"]
    assert 0 <= statistics["percentile_low"] < statistics["percentile_high"] <= 1


def test_inspect_preview_displays_grayscale_as_neutral_rgb(tmp_path: Path) -> None:
    source = np.array([[0, 31], [128, 255]], dtype=np.uint8)
    path = tmp_path / "grayscale.png"
    Image.fromarray(source, mode="L").save(path)

    result = _inspect(path)
    preview = np.asarray(_decode_preview(str(result["preview_data_url"])))

    assert preview.shape == (2, 2, 3)
    np.testing.assert_array_equal(preview, np.repeat(source[..., np.newaxis], 3, axis=-1))


def test_inspect_preview_normalizes_high_bit_depth_for_display(tmp_path: Path) -> None:
    source = np.array([[0, 16_384, 32_768, 65_535]], dtype=np.uint16)
    path = tmp_path / "high-depth.tiff"
    tifffile.imwrite(path, source, photometric="minisblack")

    result = _inspect(path)
    preview = np.asarray(_decode_preview(str(result["preview_data_url"])))

    assert preview.shape == (1, 4, 3)
    np.testing.assert_array_equal(preview[0, :, 0], [0, 63, 128, 255])
    np.testing.assert_array_equal(preview[..., 0], preview[..., 1])
    np.testing.assert_array_equal(preview[..., 1], preview[..., 2])


def test_float64_tiff_preview_preserves_large_offset_dynamic_range(tmp_path: Path) -> None:
    source = (1e20 + np.linspace(0.0, 2e12, num=101, dtype=np.float64)).reshape(1, 101)
    path = tmp_path / "large-offset.tiff"
    tifffile.imwrite(path, source, photometric="minisblack")

    loaded, _ = load_image(path)
    preview = np.asarray(_decode_preview(render_preview(loaded, max_edge=256)))[0, :, 0]

    assert preview[0] == 0
    assert 120 <= preview[50] <= 136
    assert preview[-1] == 255
    assert np.unique(preview).size > 80


def test_display_normalization_handles_opposite_float64_extremes() -> None:
    maximum = np.finfo(np.float64).max
    source = np.array([-maximum, 0.0, maximum], dtype=np.float64)

    display = render_module._display_float(source, display_bounds=(-maximum, maximum))

    np.testing.assert_allclose(display, [0.0, 0.5, 1.0])
    assert np.isfinite(display).all()


def test_display_bounds_recover_from_skewed_float64_percentile_overflow() -> None:
    maximum = np.finfo(np.float64).max
    for source in (
        np.concatenate((np.full(99, -maximum), np.array([maximum]))),
        np.concatenate((np.array([-maximum]), np.full(99, maximum))),
    ):
        bounds = render_module._display_bounds(source.reshape(1, 100))
        display = render_module._display_float(source, display_bounds=bounds)

        assert bounds == (-maximum, maximum)
        assert np.isfinite(display).all()
        assert display.min() == 0
        assert display.max() == 1


def test_complex_tiff_is_rejected_before_decode(tmp_path: Path) -> None:
    source = np.array([[1 + 2j, 3 + 4j]], dtype=np.complex64)
    path = tmp_path / "complex.tiff"
    tifffile.imwrite(path, source, photometric="minisblack")

    with pytest.raises(UnsupportedImageError, match="unsupported complex64 samples"):
        load_image(path)


@pytest.mark.parametrize("dtype", [np.int64, np.uint64])
def test_64_bit_integer_tiff_is_rejected_before_decode(
    tmp_path: Path,
    dtype: type[np.generic],
) -> None:
    source = np.array([[1, 2]], dtype=dtype)
    path = tmp_path / f"{np.dtype(dtype).name}.tiff"
    tifffile.imwrite(path, source, photometric="minisblack")

    with pytest.raises(UnsupportedImageError, match="unsupported 64-bit integer samples"):
        load_image(path)


def test_inspect_preview_preserves_high_bit_rgb_native_range(tmp_path: Path) -> None:
    source = np.array(
        [[[0, 16_448, 65_535], [51_200, 32_896, 257]]],
        dtype=np.uint16,
    )
    path = tmp_path / "high-depth-rgb.tiff"
    tifffile.imwrite(path, source, photometric="rgb")

    result = _inspect(path)
    preview = np.asarray(_decode_preview(str(result["preview_data_url"])))

    np.testing.assert_array_equal(
        preview,
        np.asarray(np.rint(source.astype(np.float32) / 257), dtype=np.uint8),
    )


def test_rgba_preview_preserves_alpha_without_mutating_array_or_source(tmp_path: Path) -> None:
    source = np.array(
        [
            [[18, 93, 207, 0], [241, 122, 37, 128]],
            [[2, 9, 16, 255], [255, 255, 255, 64]],
        ],
        dtype=np.uint8,
    )
    original_array = source.copy()
    direct_preview = _decode_preview(render_preview(source, max_edge=64))

    assert direct_preview.mode == "RGBA"
    np.testing.assert_array_equal(np.asarray(direct_preview), source)
    np.testing.assert_array_equal(source, original_array)

    path = tmp_path / "alpha.png"
    Image.fromarray(source, mode="RGBA").save(path)
    original_bytes = path.read_bytes()
    _, metadata_before = load_image(path)

    result = _inspect(path)

    assert path.read_bytes() == original_bytes
    assert result["source"]["sha256"] == metadata_before.sha256
    np.testing.assert_array_equal(
        np.asarray(_decode_preview(str(result["preview_data_url"]))),
        source,
    )


def test_display_statistics_sampling_is_memory_bounded() -> None:
    source = np.arange(900_000, dtype=np.uint32).reshape(900, 1_000)

    statistics = render_display_statistics(source)

    assert 1 <= statistics["sample_count"] <= 262_144
    assert sum(statistics["histogram_bins"]) == statistics["sample_count"]
    assert statistics["basis"] == "intensity"


def test_display_statistics_do_not_alias_a_periodic_checkerboard() -> None:
    height, width = 239, 6_581
    # A flattened arithmetic stride would be exactly six here and could sample
    # only one phase of this alternating pattern.
    source = np.asarray(
        np.arange(height * width, dtype=np.uint32).reshape(height, width) % 2 * 255,
        dtype=np.uint8,
    )

    statistics = render_display_statistics(source)

    assert statistics["source_minimum"] == 0
    assert statistics["source_maximum"] == 255
    assert statistics["histogram_bins"][0] > 0
    assert statistics["histogram_bins"][-1] > 0
    assert statistics["percentile_low"] == 0
    assert statistics["percentile_high"] == 1


def test_large_preview_downsamples_native_pixels_before_float_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = np.zeros((1_024, 2_048, 3), dtype=np.uint16)
    converted_shapes: list[tuple[int, ...]] = []
    original = render_module._display_float

    def observed(
        values: np.ndarray,
        *,
        display_bounds: tuple[float, float] | None = None,
    ) -> np.ndarray:
        converted_shapes.append(values.shape)
        return original(values, display_bounds=display_bounds)

    monkeypatch.setattr(render_module, "_display_float", observed)

    preview = _decode_preview(render_module.render_preview(source, max_edge=64))

    assert preview.size == (64, 32)
    assert converted_shapes == [(32, 64, 3)]


def test_uncommon_long_thin_preview_decimates_each_axis_before_fallback_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = np.arange(50_000, dtype=np.uint32).reshape(1, 50_000)
    resized_inputs: list[tuple[int, ...]] = []
    original = render_module.transform.resize

    def observed(values: np.ndarray, *args: object, **kwargs: object) -> np.ndarray:
        resized_inputs.append(values.shape)
        return original(values, *args, **kwargs)

    monkeypatch.setattr(render_module.transform, "resize", observed)

    preview = _decode_preview(render_module.render_preview(source, max_edge=64))

    assert preview.size == (64, 1)
    assert resized_inputs
    assert resized_inputs[0][0] == 1
    assert resized_inputs[0][1] <= 65


def test_uncommon_near_two_x_preview_bounds_fallback_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = np.arange(127 * 127 * 3, dtype=np.uint32).reshape(127, 127, 3)
    resized_inputs: list[tuple[int, ...]] = []
    original = render_module.transform.resize

    def observed(values: np.ndarray, *args: object, **kwargs: object) -> np.ndarray:
        resized_inputs.append(values.shape)
        return original(values, *args, **kwargs)

    monkeypatch.setattr(render_module.transform, "resize", observed)

    preview = _decode_preview(render_module.render_preview(source, max_edge=64))

    assert preview.size == (64, 64)
    assert resized_inputs == [(64, 64, 3)]


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
def test_preview_and_histogram_share_one_bounded_source_dn_basis(source: np.ndarray) -> None:
    statistics = render_display_statistics(source)
    bounds = (
        float(statistics["display_minimum"]),
        float(statistics["display_maximum"]),
    )
    preview = np.asarray(_decode_preview(render_preview(source, max_edge=64)))[..., 0]
    resized_native = cv2.resize(source, (64, 32), interpolation=cv2.INTER_AREA)
    expected = render_module._display_float(
        resized_native,
        display_bounds=bounds,
    )
    expected = np.asarray(np.rint(expected * 255), dtype=np.uint8)

    np.testing.assert_array_equal(preview, expected)
    assert bounds == render_module._display_bounds(source)
