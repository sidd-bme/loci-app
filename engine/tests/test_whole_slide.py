from __future__ import annotations

import hashlib
import io
import struct
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image, ImageCms
from skimage.color import hed_from_rgb, separate_stains

import loci_engine.viewer_image as viewer_image_module
import loci_engine.whole_slide as whole_slide_module
from loci_engine.slide_adapter import SlideAdapter
from loci_engine.viewer_image import viewer_defaults, viewer_tile
from loci_engine.whole_slide import (
    WholeSlideBudgetError,
    WholeSlideError,
    WholeSlideRegionRequest,
    WholeSlideSession,
    WholeSlideSourceChangedError,
    WholeSlideUnsupportedError,
    analyze_polygon_roi,
    deconvolve_stains,
    tissue_mask,
)

_REAL_LOAD_OPENSLIDE = whole_slide_module._load_openslide


class _FakeSlide:
    detect_vendor = "aperio"
    mpp_x: str | None = "0.25"
    mpp_y: str | None = "0.5"
    downsamples = (1.0, 2.5)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    read_count = 0

    @staticmethod
    def detect_format(_path: str) -> str | None:
        return _FakeSlide.detect_vendor

    def __init__(self, _path: str) -> None:
        self.dimensions = (100, 80)
        self.level_dimensions = ((100, 80), (40, 32))
        self.level_downsamples = self.downsamples
        self.properties = {}
        if self.mpp_x is not None:
            self.properties["openslide.mpp-x"] = self.mpp_x
        if self.mpp_y is not None:
            self.properties["openslide.mpp-y"] = self.mpp_y
        self.color_profile = self.profile
        self.closed = False

    def read_region(
        self, location: tuple[int, int], level: int, size: tuple[int, int]
    ) -> Image.Image:
        type(self).read_count += 1
        width, height = size
        y, x = np.indices((height, width))
        rgba = np.stack(
            (
                (x + location[0]) % 256,
                (y + location[1]) % 256,
                np.full_like(x, level * 40 + 17),
                np.full_like(x, 255),
            ),
            axis=-1,
        ).astype(np.uint8)
        return Image.fromarray(rgba, "RGBA")

    def set_cache(self, cache: object) -> None:
        self.cache = cache

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _fake_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeSlide.detect_vendor = "aperio"
    _FakeSlide.mpp_x = "0.25"
    _FakeSlide.mpp_y = "0.5"
    _FakeSlide.downsamples = (1.0, 2.5)
    _FakeSlide.profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    _FakeSlide.read_count = 0
    fake_module = SimpleNamespace(
        OpenSlide=_FakeSlide,
        OpenSlideCache=lambda capacity: SimpleNamespace(capacity=capacity),
        PROPERTY_NAME_MPP_X="openslide.mpp-x",
        PROPERTY_NAME_MPP_Y="openslide.mpp-y",
        __version__="1.4.6-test",
        __library_version__="4.0.1-test",
    )
    monkeypatch.setattr(whole_slide_module, "_load_openslide", lambda: fake_module)


def _slide(path: Path, suffix: str = ".svs") -> Path:
    source = path / f"source{suffix}"
    source.write_bytes(b"immutable synthetic whole-slide bytes")
    return source


def test_workbench_slide_selection_preserves_native_level_centres_and_stain_values(tmp_path):
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    project = ResearchProject.create(tmp_path / "slide.loci-study", "Slide")
    workbench = Workbench(project)
    source = workbench.import_native(str(_slide(tmp_path)))
    selection = {"x": 3, "y": 5, "width": 12, "height": 8, "level": 1}
    viewed = workbench.execute("view", {"source_id": source["id"], "selection": selection})
    # level-0 integer edge origins are round(3*2.5)=8, round(5*2.5)=12.
    # Geometry contains returned pixel centres; coordinates are explicitly XYZ.
    assert np.asarray(viewed["geometry"]["affine"])[0, 3] == 0.25 * (8 + 1.25)
    assert np.asarray(viewed["geometry"]["affine"])[1, 3] == 0.5 * (12 + 1.25)
    assert viewed["display"][0]["icc"]["transform"] == "Pillow-ImageCms-source-to-sRGB"
    assert viewed["display"][0]["level0_extent_xyxy"] == (8.0, 12.0, 38.0, 32.0)
    request = {"source_id": source["id"], "selection": selection, "basis": "H&E", "component": 0}
    preview = workbench.execute("histology_preview", request)
    assert preview["adopted"] is False
    assert not project.list_results()
    saved = workbench.execute("histology_run", request)
    result = project.result(saved["result"]["id"])
    pixels = _FakeSlide("").read_region((8, 12), 1, (12, 8))
    reference = separate_stains(np.asarray(pixels)[..., :3], hed_from_rgb)[..., 0]
    np.testing.assert_array_equal(project.load_array(result["arrays"]["image"]), reference)
    np.testing.assert_array_equal(
        result["provenance"]["geometry"]["affine"], viewed["geometry"]["affine"]
    )
    assert result["provenance"]["geometry"]["unit"] == viewed["geometry"]["unit"]
    assert "display ICC transform excluded" in result["provenance"]["stain_separation"]["input"]
    assert source["source_kind"] == "whole_slide"
    workbench.close()
    reopened = Workbench(ResearchProject(project.root))
    assert reopened.execute("inspect", {"source_id": source["id"]})["metadata"]["format"] == "SVS"
    assert str(tmp_path) not in str(reopened.snapshot())
    reopened.close()


def test_profiled_region_separates_analysis_rgb_from_srgb_display_and_maps_level0(
    tmp_path: Path,
) -> None:
    path = _slide(tmp_path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()

    with WholeSlideSession(path, expected_sha256=digest) as session:
        metadata = session.metadata
        region = session.read_region(
            WholeSlideRegionRequest(
                level0_x=25,
                level0_y=10,
                level=1,
                width=20,
                height=12,
                expected_sha256=digest,
            )
        )
        receipt = session.verify_strict()

    assert metadata.format == "SVS"
    assert metadata.vendor == "aperio"
    assert metadata.level0_dimensions_xy == (100, 80)
    assert metadata.levels[1].dimensions_xy == (40, 32)
    assert metadata.levels[1].downsample == 2.5
    assert metadata.levels[1].micrometres_per_pixel_xy == (0.625, 1.25)
    assert metadata.micrometres_per_pixel_xy == (0.25, 0.5)
    assert metadata.source_size_bytes == len(b"immutable synthetic whole-slide bytes")
    assert metadata.icc.source_status == "embedded-usable"
    assert metadata.icc.transform == "Pillow-ImageCms-source-to-sRGB"
    assert metadata.decoder_version == "1.4.6-test"
    assert metadata.decoder_library_version == "4.0.1-test"
    assert metadata.decoder_cache_bytes == 64 * 1024 * 1024
    assert (
        metadata.icc.source_icc_sha256 == hashlib.sha256(_FakeSlide.profile.tobytes()).hexdigest()
    )
    assert region.level0_extent_xyxy == (25.0, 10.0, 75.0, 40.0)
    assert region.analysis_rgb.shape == (12, 20, 3)
    # The declared source profile is sRGB, so this is a fixed colour-management
    # reference: applying the ICC transform must preserve these known pixels.
    np.testing.assert_array_equal(region.display_rgb, region.analysis_rgb)
    assert tuple(region.analysis_rgb[2, 3]) == (28, 12, 57)
    assert not region.analysis_rgb.flags.writeable
    assert not region.display_rgb.flags.writeable
    assert region.sha256 == digest == receipt.sha256
    assert "path" not in asdict(metadata)


def test_viewer_image_uses_whole_slide_display_rgb_without_second_icc_transform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = SlideAdapter(str(_slide(tmp_path)))
    try:
        policy = session.metadata.rgb_color_policy
        assert policy is not None
        assert policy.source_status == "embedded-usable"
        assert policy.transform == "Pillow-ImageCms-source-to-sRGB"
        defaults = viewer_defaults(session, {"source_id": "a" * 32, "t": 0, "z": 0, "auto": False})

        def fail_second_transform(*_args: object, **_kwargs: object) -> np.ndarray:
            raise AssertionError("whole-slide display RGB reached the generic ICC transform")

        monkeypatch.setattr(viewer_image_module, "render_source_rgb", fail_second_transform)
        normal = viewer_tile(
            session,
            {
                "source_id": "a" * 32,
                "selection": {
                    "x": 3,
                    "y": 4,
                    "width": 10,
                    "height": 8,
                    "level": 1,
                    "z": 0,
                    "t": 0,
                    "c": 0,
                },
                "channels": defaults["channels"],
            },
        )
        overview = viewer_tile(
            session,
            {
                "source_id": "a" * 32,
                "overview": True,
                "t": 0,
                "z": 0,
                "c": 0,
                "channels": defaults["channels"],
                "max_edge": 64,
            },
        )
    finally:
        session.close()

    assert normal["geometry"]["axes"] == "YX"
    assert overview["preparation"] == "native-pyramid"
    assert (overview["width"], overview["height"]) == (40, 32)
    assert _FakeSlide.read_count == 2


def test_nonidentity_icc_display_matches_analytic_linear_to_srgb(tmp_path: Path) -> None:
    # A generated sRGB matrix profile with gamma=1 TRCs describes linear RGB.
    # ICC curveType count=1 stores gamma as u8Fixed8Number (ICC.1 section 10.6).
    # Keep generated primaries/white point; no external or proprietary profile.
    encoded = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    count = struct.unpack_from(">I", encoded, 128)[0]
    curve = b"curv" + b"\0" * 4 + struct.pack(">IH", 1, 256) + b"\0\0"
    offset = len(encoded)
    assert offset % 4 == 0
    encoded.extend(curve)
    changed = set()
    for index in range(count):
        entry = 132 + index * 12
        tag = bytes(encoded[entry : entry + 4])
        if tag in {b"rTRC", b"gTRC", b"bTRC"}:
            struct.pack_into(">II", encoded, entry + 4, offset, 14)
            changed.add(tag)
    assert changed == {b"rTRC", b"gTRC", b"bTRC"}
    struct.pack_into(">I", encoded, 0, len(encoded))
    encoded[84:100] = b"\0" * 16  # Generated test profile has no claimed profile ID.
    _FakeSlide.profile = ImageCms.ImageCmsProfile(io.BytesIO(encoded))
    source = _slide(tmp_path)
    with WholeSlideSession(source) as session:
        region = session.read_region(
            WholeSlideRegionRequest(level0_x=0, level0_y=0, level=0, width=100, height=80)
        )
    linear = region.analysis_rgb.astype(np.float64) / 255
    # Independent IEC sRGB transfer equation, not a second call to ImageCms.
    # https://registry.color.org/rgb-registry/srgb
    srgb = np.where(linear <= 0.0031308, 12.92 * linear, 1.055 * linear ** (1 / 2.4) - 0.055)
    expected = np.rint(srgb * 255).astype(np.uint8)
    # Predeclared one-code-value allowance for ICC matrix/TRC quantization.
    assert np.max(np.abs(region.display_rgb.astype(np.int16) - expected)) <= 1
    assert not np.array_equal(region.display_rgb, region.analysis_rgb)
    np.testing.assert_array_equal(region.analysis_rgb[20, 30], [30, 20, 17])
    assert region.display_color.transform == "Pillow-ImageCms-source-to-sRGB"


def test_missing_profile_is_not_claimed_as_calibrated_display(tmp_path: Path) -> None:
    _FakeSlide.profile = None
    path = _slide(tmp_path)

    with WholeSlideSession(path) as session:
        region = session.read_region(
            WholeSlideRegionRequest(level0_x=0, level0_y=0, level=0, width=8, height=6)
        )

    assert region.display_color.source_status == "missing"
    assert region.display_color.display_space == "uncharacterized-source-RGB"
    assert region.display_color.transform == "none"
    assert region.display_color.source_icc_sha256 is None
    np.testing.assert_array_equal(region.display_rgb, region.analysis_rgb)


def test_display_transform_can_be_explicitly_disabled_without_changing_analysis(
    tmp_path: Path,
) -> None:
    path = _slide(tmp_path)
    with WholeSlideSession(path) as session:
        region = session.read_region(
            WholeSlideRegionRequest(
                level0_x=0,
                level0_y=0,
                level=0,
                width=8,
                height=6,
                color_manage_display=False,
            )
        )

    assert region.display_color.source_status == "embedded-usable"
    assert region.display_color.transform == "none"
    assert region.display_color.display_space == "uncharacterized-source-RGB"
    np.testing.assert_array_equal(region.display_rgb, region.analysis_rgb)


@pytest.mark.parametrize(
    ("mpp_x", "mpp_y", "message"),
    [(None, "0.5", "incomplete"), ("nan", "0.5", "finite positive")],
)
def test_invalid_or_incomplete_calibration_fails_closed(
    tmp_path: Path, mpp_x: str | None, mpp_y: str | None, message: str
) -> None:
    _FakeSlide.mpp_x = mpp_x
    _FakeSlide.mpp_y = mpp_y
    with pytest.raises(WholeSlideError, match=message):
        WholeSlideSession(_slide(tmp_path))


def test_absent_calibration_is_explicit_and_has_no_physical_geometry(tmp_path: Path) -> None:
    _FakeSlide.mpp_x = None
    _FakeSlide.mpp_y = None
    path = _slide(tmp_path)
    with WholeSlideSession(path) as session:
        assert session.metadata.calibration_status == "missing"
        assert session.metadata.micrometres_per_pixel_xy is None
        region = session.read_region(
            WholeSlideRegionRequest(level0_x=0, level0_y=0, level=0, width=12, height=12)
        )
    analysis = analyze_polygon_roi(region, ((1, 1), (8, 1), (8, 8), (1, 8)))
    assert analysis.area_micrometres_squared is None
    with pytest.raises(WholeSlideError, match="calibration"):
        analysis.to_geojson(coordinate_space="physical-micrometre")


def test_region_bounds_and_memory_are_checked_before_decoder_access(tmp_path: Path) -> None:
    path = _slide(tmp_path)
    with WholeSlideSession(path) as session:
        # x=75 plus 10 selected-level pixels at 2.5x ends exactly at 100.
        exact = session.read_region(
            WholeSlideRegionRequest(level0_x=75, level0_y=0, level=1, width=10, height=4)
        )
        assert exact.level0_extent_xyxy == (75.0, 0.0, 100.0, 10.0)
        prior_reads = _FakeSlide.read_count
        with pytest.raises(WholeSlideError, match="outside"):
            session.read_region(
                WholeSlideRegionRequest(level0_x=76, level0_y=0, level=1, width=10, height=4)
            )
        with pytest.raises(WholeSlideBudgetError, match="No pixels were decoded") as error:
            session.read_region(
                WholeSlideRegionRequest(
                    level0_x=0,
                    level0_y=0,
                    level=0,
                    width=40,
                    height=40,
                    budget_bytes=1024,
                )
            )
        assert error.value.required_bytes == 40 * 40 * 32
        assert _FakeSlide.read_count == prior_reads


def test_path_symlink_hash_format_and_session_change_boundaries(tmp_path: Path) -> None:
    path = _slide(tmp_path)
    link = tmp_path / "linked.svs"
    link.symlink_to(path)
    with pytest.raises(WholeSlideSourceChangedError, match="non-symlink"):
        WholeSlideSession(link)
    with pytest.raises(WholeSlideSourceChangedError, match="expected full SHA-256"):
        WholeSlideSession(path, expected_sha256="0" * 64)
    with pytest.raises(WholeSlideError, match="lowercase"):
        WholeSlideSession(path, expected_sha256="A" * 64)

    _FakeSlide.detect_vendor = "generic-tiff"
    with pytest.raises(WholeSlideUnsupportedError, match="Aperio SVS"):
        WholeSlideSession(path)

    _FakeSlide.detect_vendor = "aperio"
    with WholeSlideSession(path) as session:
        path.write_bytes(b"changed")
        with pytest.raises(WholeSlideSourceChangedError, match="changed"):
            session.read_region(
                WholeSlideRegionRequest(level0_x=0, level0_y=0, level=0, width=2, height=2)
            )


def test_malformed_pyramid_or_icc_profile_is_rejected(tmp_path: Path) -> None:
    path = _slide(tmp_path)
    _FakeSlide.downsamples = (1.0, float("inf"))
    with pytest.raises(WholeSlideError, match="finite positive"):
        WholeSlideSession(path)

    _FakeSlide.downsamples = (1.0, 2.5)
    _FakeSlide.profile = object()
    with pytest.raises(WholeSlideError, match="ICC profile"):
        WholeSlideSession(path)


def test_real_openslide_rejects_corrupt_svs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corrupt = tmp_path / "corrupt.svs"
    corrupt.write_bytes(b"not a whole-slide image")
    monkeypatch.setattr(whole_slide_module, "_load_openslide", _REAL_LOAD_OPENSLIDE)
    with pytest.raises(WholeSlideUnsupportedError, match="content-detected"):
        WholeSlideSession(corrupt)


def test_declared_stain_deconvolution_uses_analysis_rgb_and_exact_skimage_basis(
    tmp_path: Path,
) -> None:
    path = _slide(tmp_path)
    with WholeSlideSession(path) as session:
        region = session.read_region(
            WholeSlideRegionRequest(level0_x=5, level0_y=7, level=0, width=16, height=12)
        )
    result = deconvolve_stains(region, declared_basis="H&E")

    np.testing.assert_allclose(result.values, separate_stains(region.analysis_rgb, hed_from_rgb))
    np.testing.assert_allclose(result.rgb_separation_matrix, hed_from_rgb)
    assert result.components == (
        "hematoxylin-basis",
        "eosin-basis",
        "HED-third-DAB-basis",
    )
    assert result.input_color_space == "source-device-RGB"
    assert result.scientific_validation == "unvalidated-research-method"
    assert result.source_sha256 == region.sha256
    assert result.level0_extent_xyxy == region.level0_extent_xyxy
    assert not result.values.flags.writeable
    with pytest.raises(WholeSlideError, match="explicitly"):
        deconvolve_stains(region, declared_basis="inferred")  # type: ignore[arg-type]
    with pytest.raises(WholeSlideBudgetError):
        deconvolve_stains(region, declared_basis="H-DAB", working_bytes=1024)


def test_tissue_mask_and_polygon_roi_have_explicit_calibrated_geometry(tmp_path: Path) -> None:
    path = _slide(tmp_path)
    with WholeSlideSession(path) as session:
        region = session.read_region(
            WholeSlideRegionRequest(level0_x=0, level0_y=0, level=0, width=24, height=20)
        )
    mask = tissue_mask(region, closing_radius_pixels=1, minimum_component_pixels=2)
    roi = analyze_polygon_roi(
        region,
        ((10, 10), (20, 10), (20, 18), (10, 18)),
        tissue=mask,
    )

    assert mask.mask.dtype == np.bool_
    assert not mask.mask.flags.writeable
    assert mask.threshold_method == "otsu-dark-luminance"
    assert mask.source_sha256 == region.sha256
    assert 0 <= mask.threshold <= 1
    assert roi.area_level0_pixels_squared == 80
    assert roi.centroid_level0_xy == pytest.approx((15, 14))
    assert roi.micrometres_per_level0_pixel_xy == (0.25, 0.5)
    assert roi.area_micrometres_squared == pytest.approx(10)
    assert roi.centroid_micrometres_xy == pytest.approx((3.75, 7.0))
    assert roi.sample_level == 0
    assert roi.sample_level_downsample == 1.0
    assert 0 <= (roi.tissue_fraction or 0) <= 1
    feature = roi.to_geojson(coordinate_space="physical-micrometre")
    assert feature["geometry"]["coordinates"][0][0] == [2.5, 5.0]
    assert feature["geometry"]["coordinates"][0][-1] == [2.5, 5.0]
    assert feature["properties"]["area_unit"] == "um^2"
    assert "path" not in feature["properties"]

    with pytest.raises(WholeSlideBudgetError):
        analyze_polygon_roi(
            region,
            ((10, 10), (20, 10), (20, 18), (10, 18)),
            working_bytes=1024,
        )


@pytest.mark.parametrize(
    "points",
    [
        ((1, 1), (8, 8), (1, 8), (8, 1)),
        ((1, 1), (float("nan"), 8), (8, 1)),
        ((1, 1), (8, 1), (200, 8)),
    ],
)
def test_polygon_rejects_self_intersection_nonfinite_and_outside_points(
    tmp_path: Path, points: tuple[tuple[float, float], ...]
) -> None:
    path = _slide(tmp_path)
    with WholeSlideSession(path) as session:
        region = session.read_region(
            WholeSlideRegionRequest(level0_x=0, level0_y=0, level=0, width=20, height=20)
        )
    with pytest.raises(WholeSlideError):
        analyze_polygon_roi(region, points)


@pytest.mark.parametrize(
    (
        "filename",
        "expected_size",
        "expected_hash",
        "expected_region_hash",
        "expected_format",
        "expected_vendor",
    ),
    [
        (
            "CMU-1-Small-Region.svs",
            1_938_955,
            "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7",
            "c51949e04131e1b26ab8f037a16b5efda632291585821ea3b108e7d7b00c29c1",
            "SVS",
            "aperio",
        ),
        (
            "CMU-1.ndpi",
            198_030_965,
            "edf4a1ccf395c7000ae93ad3b44c07d97043810e00be0c1d167dd09bbe436e46",
            "df8942c11889154493bed318ca2e8a435e7f1892f71e703ac6759a54672e78be",
            "NDPI",
            "hamamatsu",
        ),
    ],
)
def test_official_cc0_openslide_fixture_smoke(
    monkeypatch: pytest.MonkeyPatch,
    filename: str,
    expected_size: int,
    expected_hash: str,
    expected_region_hash: str,
    expected_format: str,
    expected_vendor: str,
) -> None:
    source = Path("/tmp/loci-release-run/wsi") / filename
    if not source.is_file() or source.stat().st_size != expected_size:
        pytest.skip("authorized external OpenSlide fixture is not present")
    monkeypatch.setattr(whole_slide_module, "_load_openslide", _REAL_LOAD_OPENSLIDE)
    with WholeSlideSession(source, expected_sha256=expected_hash) as session:
        metadata = session.metadata
        region = session.read_region(
            WholeSlideRegionRequest(
                level0_x=0,
                level0_y=0,
                level=0,
                width=64,
                height=64,
                expected_sha256=expected_hash,
            )
        )

    assert metadata.format == expected_format
    assert metadata.vendor == expected_vendor
    assert metadata.sha256 == expected_hash
    if filename.endswith(".svs"):
        assert metadata.level0_dimensions_xy == (2220, 2967)
        assert tuple(level.downsample for level in metadata.levels) == (1.0,)
        assert metadata.micrometres_per_pixel_xy == pytest.approx((0.499, 0.499))
    else:
        assert metadata.level0_dimensions_xy == (51200, 38144)
        assert tuple(level.downsample for level in metadata.levels) == (
            1.0,
            2.0,
            4.0,
            8.0,
            16.0,
            32.0,
            64.0,
            128.0,
            256.0,
        )
        assert metadata.micrometres_per_pixel_xy == pytest.approx(
            (0.45641259698767683, 0.4550625711035267)
        )
    assert metadata.decoder_version == "1.4.6"
    assert metadata.decoder_library_version == "4.0.1"
    assert region.analysis_rgb.shape == (64, 64, 3)
    assert region.analysis_rgb.dtype == np.uint8
    assert hashlib.sha256(region.analysis_rgb.tobytes()).hexdigest() == expected_region_hash
    assert region.transparent_pixel_count == 0
