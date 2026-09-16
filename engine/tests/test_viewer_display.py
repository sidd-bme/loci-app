from __future__ import annotations

import hashlib

import numpy as np
import pytest
from PIL import ImageCms

from loci_engine.native_image import (
    SRGB_OUTPUT_PROFILE_SHA256,
    NativeCapabilities,
    NativeChannelDisplay,
    NativeDimensions,
    NativeImageMetadata,
    NativeLevel,
    NativeRgbColorPolicy,
)
from loci_engine.viewer_display import (
    ViewerDisplayError,
    adjust_source_rgb_components,
    render_adjusted_source_rgb,
    render_channel_composite,
    render_source_rgb,
    resolve_display_defaults,
)


def _metadata(
    dtypes: tuple[str, ...],
    displays: tuple[NativeChannelDisplay, ...] = (),
    *,
    semantics: str = "none",
    samples: int = 1,
    policy: NativeRgbColorPolicy | None = None,
) -> NativeImageMetadata:
    dimensions = NativeDimensions(1, len(dtypes), 1, 8, 12, samples)
    axes = "TCZYXS" if samples > 1 else "TCZYX"
    shape = (1, len(dtypes), 1, 8, 12, samples) if samples > 1 else (1, len(dtypes), 1, 8, 12)
    return NativeImageMetadata(
        format="synthetic",
        axes=axes,  # type: ignore[arg-type]
        shape=shape,
        source_axes="YXS" if samples > 1 else "CYX",
        source_shape=(8, 12, samples) if samples > 1 else (len(dtypes), 8, 12),
        dimensions=dimensions,
        levels=(NativeLevel(0, dimensions, None),),
        channel_names=tuple(f"Channel {index + 1}" for index in range(len(dtypes))),
        channel_dtypes=dtypes,
        sample_semantics=semantics,  # type: ignore[arg-type]
        physical_calibration=None,
        sha256="0" * 64,
        selected_series=0,
        series_count=1,
        capabilities=NativeCapabilities(
            True, False, len(dtypes) > 1, False, False, False, ("test",)
        ),
        acquisition_display=displays,
        rgb_color_policy=policy,
    )


def test_acquisition_defaults_preserve_nondefault_range_gamma_color_and_opacity() -> None:
    metadata = _metadata(
        ("uint16", "uint16"),
        (
            NativeChannelDisplay(
                channel=0,
                color_mode="base-color",
                color_mode_basis="ims-ColorMode",
                color_rgb=(1.0, 0.25, 0.0),
                color_basis="ims-Color",
                value_range=(100.0, 40_000.0),
                range_basis="ims-ColorRange",
                gamma=2.2,
                gamma_basis="ims-GammaCorrection",
                opacity=0.4,
                opacity_basis="ims-ColorOpacity",
            ),
            NativeChannelDisplay(
                channel=1,
                color_rgb=(0.0, 1.0, 0.0),
                color_basis="ims-Color",
                value_range=(200.0, 50_000.0),
                range_basis="ims-ColorRange",
                gamma=0.8,
                gamma_basis="ims-GammaCorrection",
                opacity=0.75,
                opacity_basis="ims-ColorOpacity",
                visible=False,
                visibility_basis="ims-Visible",
            ),
        ),
    )

    resolved = resolve_display_defaults(metadata)

    assert resolved[0].low == 100 and resolved[0].high == 40_000
    assert resolved[0].gamma == 2.2 and resolved[0].opacity == 0.4
    assert resolved[0].color_hex == "#ff4000"
    assert resolved[0].visible
    assert resolved[0].visibility_basis == "acquisition-colour-present"
    assert not resolved[1].visible
    assert resolved[1].visibility_basis == "ims-Visible"
    assert resolved[0].as_view_mapping() == {
        "channel": 0,
        "low": 100.0,
        "high": 40_000.0,
        "gamma": 2.2,
        "color": "#ff4000",
        "opacity": 0.4,
        "visible": True,
    }


def test_missing_acquisition_metadata_is_neutral_and_does_not_infer_rgb() -> None:
    metadata = _metadata(("uint8", "uint8", "uint8"))

    resolved = resolve_display_defaults(metadata)

    assert metadata.sample_semantics == "none"
    assert [item.color_rgb for item in resolved] == [(1.0, 1.0, 1.0)] * 3
    assert [item.visible for item in resolved] == [True, False, False]
    assert [(item.low, item.high) for item in resolved] == [(0.0, 255.0)] * 3
    assert all(item.range_basis == "native-dtype-range" for item in resolved)
    assert all(item.color_basis == "neutral-grayscale-fallback" for item in resolved)


def test_deterministic_sample_defaults_are_reused_across_navigation() -> None:
    metadata = _metadata(("float32",))
    global_sample = np.asarray([0.0, 100.0, 200.0], dtype=np.float32)
    resolved = resolve_display_defaults(
        metadata,
        samples={0: global_sample},
        sample_basis="deterministic-coarse-level",
    )

    first_crop = np.asarray([[0.0, 100.0]], dtype=np.float32)
    second_crop = np.asarray([[100.0, 200.0]], dtype=np.float32)
    first = render_channel_composite({0: first_crop}, resolved)
    second = render_channel_composite({0: second_crop}, resolved)

    assert resolved[0].range_basis == "deterministic-coarse-level-min-max"
    np.testing.assert_array_equal(first[0, 1], second[0, 0])
    np.testing.assert_array_equal(first_crop, [[0.0, 100.0]])
    np.testing.assert_array_equal(second_crop, [[100.0, 200.0]])
    with pytest.raises(ViewerDisplayError, match="basis"):
        resolve_display_defaults(metadata, samples={0: global_sample})
    with pytest.raises(ViewerDisplayError, match="whole-source or deterministic"):
        resolve_display_defaults(
            metadata,
            samples={0: global_sample},
            sample_basis="current-crop",  # type: ignore[arg-type]
        )


def test_auto_mode_explicitly_overrides_only_acquisition_ranges() -> None:
    metadata = _metadata(
        ("uint16", "uint16"),
        (
            NativeChannelDisplay(
                channel=0,
                color_rgb=(1.0, 0.0, 0.0),
                color_basis="ims-Color",
                value_range=(0.0, 65535.0),
                range_basis="ims-ColorRange",
                gamma=2.0,
                gamma_basis="ims-GammaCorrection",
            ),
            NativeChannelDisplay(channel=1),
        ),
    )

    resolved = resolve_display_defaults(
        metadata,
        auto=True,
        samples={
            0: np.asarray([100, 200], dtype=np.uint16),
            1: np.asarray([300, 900], dtype=np.uint16),
        },
        sample_basis="deterministic-coarse-level",
    )

    assert [(item.low, item.high) for item in resolved] == [(100.0, 200.0), (300.0, 900.0)]
    assert all(item.range_basis.startswith("auto-") for item in resolved)
    assert resolved[0].gamma == 2.0
    assert resolved[0].color_rgb == (1.0, 0.0, 0.0)
    with pytest.raises(ViewerDisplayError, match="every channel"):
        resolve_display_defaults(
            metadata,
            auto=True,
            samples={0: np.asarray([1, 2], dtype=np.uint16)},
            sample_basis="whole-source",
        )


def test_display_value_and_pixel_bounds_fail_closed() -> None:
    metadata = _metadata(("uint8",))
    with pytest.raises(ViewerDisplayError, match="value-count"):
        resolve_display_defaults(
            metadata,
            auto=True,
            samples={0: np.zeros(4 * 1024**2 + 1, dtype=np.uint8)},
            sample_basis="whole-source",
        )

    settings = resolve_display_defaults(metadata)
    with pytest.raises(ViewerDisplayError, match="pixel bound"):
        render_channel_composite({0: np.zeros((2048, 2049), dtype=np.uint8)}, settings)


def test_explicit_scalar_rgb_lut_composite_matches_independent_stack() -> None:
    red = np.asarray([[0, 64], [128, 255]], dtype=np.uint8)
    green = np.asarray([[255, 128], [64, 0]], dtype=np.uint8)
    blue = np.asarray([[11, 22], [33, 44]], dtype=np.uint8)
    originals = [array.copy() for array in (red, green, blue)]
    metadata = _metadata(
        ("uint8", "uint8", "uint8"),
        tuple(
            NativeChannelDisplay(
                channel=index,
                color_rgb=color,
                color_basis="ims-Color",
                value_range=(0.0, 255.0),
                range_basis="ims-ColorRange",
                gamma=1.0,
                gamma_basis="ims-GammaCorrection",
                opacity=1.0,
                opacity_basis="ims-ColorOpacity",
            )
            for index, color in enumerate(((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))
        ),
    )

    rendered = render_channel_composite(
        {0: red, 1: green, 2: blue}, resolve_display_defaults(metadata)
    )

    np.testing.assert_array_equal(rendered, np.stack((red, green, blue), axis=-1))
    for actual, original in zip((red, green, blue), originals, strict=True):
        np.testing.assert_array_equal(actual, original)


def test_source_rgb_icc_policy_applies_once_and_rejects_wrong_profile() -> None:
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    policy = NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="embedded-usable",
        source_icc_sha256=hashlib.sha256(profile).hexdigest(),
        source_icc_bytes=len(profile),
        display_space="sRGB",
        transform="Pillow-ImageCms-source-to-sRGB",
        rendering_intent=0,
        output_icc_sha256=SRGB_OUTPUT_PROFILE_SHA256,
    )
    pixels = np.arange(6 * 7 * 3, dtype=np.uint8).reshape(6, 7, 3)

    converted = render_source_rgb(pixels, policy, embedded_icc=profile)
    already = render_source_rgb(converted, policy, already_srgb=True)

    np.testing.assert_array_equal(converted, pixels)
    np.testing.assert_array_equal(already, converted)
    with pytest.raises(ViewerDisplayError, match="differs"):
        render_source_rgb(pixels, policy, embedded_icc=profile + b"x")


def test_uncharacterized_source_rgb_is_preserved_without_silent_conversion() -> None:
    policy = NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="missing",
        source_icc_sha256=None,
        source_icc_bytes=None,
        display_space="uncharacterized-source-RGB",
        transform="none",
    )
    pixels = np.arange(4 * 5 * 4, dtype=np.uint8).reshape(4, 5, 4)

    displayed = render_source_rgb(pixels, policy)

    np.testing.assert_array_equal(displayed, pixels)
    assert displayed is not pixels
    with pytest.raises(ViewerDisplayError, match="does not apply"):
        render_source_rgb(pixels, policy, embedded_icc=b"unexpected")


@pytest.mark.parametrize("dtype", [np.uint8, np.uint16])
def test_stored_rgb_adjustment_is_neutral_bit_exact_and_preserves_alpha(
    dtype: type[np.generic],
) -> None:
    maximum = np.iinfo(dtype).max
    source = np.asarray([[[0, maximum // 2, maximum, maximum // 3]]], dtype=dtype)
    source.flags.writeable = False

    neutral = adjust_source_rgb_components(
        source,
        low=0,
        high=maximum,
        gamma=1,
    )
    adjusted = adjust_source_rgb_components(
        source,
        low=maximum / 4,
        high=maximum * 3 / 4,
        gamma=1,
    )

    np.testing.assert_array_equal(neutral, source)
    np.testing.assert_array_equal(source, [[[0, maximum // 2, maximum, maximum // 3]]])
    assert neutral is not source
    np.testing.assert_array_equal(adjusted[..., 0], [[0]])
    np.testing.assert_array_equal(adjusted[..., 2], [[maximum]])
    assert int(adjusted[0, 0, 1]) != maximum // 2
    np.testing.assert_array_equal(adjusted[..., 3], [[maximum // 3]])


def test_stored_rgb_adjustment_applies_icc_once_after_component_mapping() -> None:
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    policy = NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="embedded-usable",
        source_icc_sha256=hashlib.sha256(profile).hexdigest(),
        source_icc_bytes=len(profile),
        display_space="sRGB",
        transform="Pillow-ImageCms-source-to-sRGB",
        rendering_intent=0,
        output_icc_sha256=SRGB_OUTPUT_PROFILE_SHA256,
    )
    source = np.asarray([[[32, 128, 224]]], dtype=np.uint8)

    actual = render_adjusted_source_rgb(
        source,
        policy,
        low=32,
        high=224,
        gamma=1,
        embedded_icc=profile,
    )
    expected = render_source_rgb(
        adjust_source_rgb_components(source, low=32, high=224, gamma=1),
        policy,
        embedded_icc=profile,
    )

    np.testing.assert_array_equal(actual, expected)


def test_uint16_stored_rgb_adjustment_rejects_precision_losing_icc_conversion() -> None:
    policy = NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="missing",
        source_icc_sha256=None,
        source_icc_bytes=None,
        display_space="uncharacterized-source-RGB",
        transform="Pillow-ImageCms-source-to-sRGB",
        rendering_intent=0,
    )
    with pytest.raises(ViewerDisplayError, match="uint16"):
        render_adjusted_source_rgb(
            np.zeros((1, 1, 3), dtype=np.uint16),
            policy,
            low=0,
            high=65535,
            gamma=1,
        )


def test_inconsistent_color_and_already_srgb_policy_fail_closed() -> None:
    metadata = _metadata(
        ("uint8",),
        (NativeChannelDisplay(channel=0, color_rgb=(1.0, 0.0)),),  # type: ignore[arg-type]
    )
    with pytest.raises(ViewerDisplayError, match="color"):
        resolve_display_defaults(metadata)

    pixels = np.zeros((2, 3, 3), dtype=np.uint8)
    policy = NativeRgbColorPolicy(
        source_space="source-device-RGB",
        source_status="missing",
        source_icc_sha256=None,
        source_icc_bytes=None,
        display_space="uncharacterized-source-RGB",
        transform="Pillow-ImageCms-source-to-sRGB",
        rendering_intent=0,
    )
    with pytest.raises(ViewerDisplayError, match="inconsistent"):
        render_source_rgb(pixels, policy, already_srgb=True)
