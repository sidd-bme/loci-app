from __future__ import annotations

import base64
from dataclasses import dataclass, replace

import numpy as np
import pytest
from PIL import Image, ImageCms

import loci_engine.viewer_image as viewer_image_module
from loci_engine.native_image import (
    NativeCapabilities,
    NativeChannelDisplay,
    NativeDimensions,
    NativeImageMetadata,
    NativeImageSession,
    NativeLevel,
    NativeRegion,
    NativeRgbColorPolicy,
    NativeSelection,
    PhysicalCalibration,
)
from loci_engine.quantitative import Geometry
from loci_engine.research_project import ResearchProject
from loci_engine.viewer_image import (
    ViewerImageError,
    viewer_defaults,
    viewer_histogram,
    viewer_tile,
)
from loci_engine.workbench import Workbench


@dataclass
class _FakeSession:
    metadata: NativeImageMetadata

    def __post_init__(self) -> None:
        self.reads: list[NativeSelection] = []
        self.validations = 0
        self.source_current = True

    def validate_source(self) -> None:
        self.validations += 1
        if not self.source_current:
            raise RuntimeError("source changed")

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        self.reads.append(selection)
        yy, xx = np.mgrid[
            selection.y : selection.y + selection.height,
            selection.x : selection.x + selection.width,
        ]
        pixels = (selection.c * 50 + selection.t * 20 + selection.z * 10 + yy + xx).astype(np.uint8)
        pixels.flags.writeable = False
        return NativeRegion(
            pixels=pixels,
            axes="YX",
            selection=selection,
            sha256=self.metadata.sha256,
            format="fake",
            native_dtype="uint8",
            read_mode="fake",
            estimated_peak_bytes=pixels.nbytes,
            integrity_mode="stat-verified-session",
        )

    def geometry(self, selection: dict[str, int], volume: bool) -> Geometry:
        assert volume is False
        level = self.metadata.levels[selection["level"]]
        calibration = level.calibration
        sx = calibration.spacing[-1] if calibration else 1.0
        sy = calibration.spacing[-2] if calibration else 1.0
        matrix = np.diag([sx, sy, 1.0, 1.0])
        matrix[:3, 3] = [selection["x"] * sx, selection["y"] * sy, selection["z"]]
        return Geometry(
            "YX", tuple(map(tuple, matrix)), calibration.unit if calibration else "pixel"
        )


class _RgbFakeSession(_FakeSession):
    def read_region(self, selection: NativeSelection) -> NativeRegion:
        self.reads.append(selection)
        yy, xx = np.mgrid[
            selection.y : selection.y + selection.height,
            selection.x : selection.x + selection.width,
        ]
        pixels = np.stack((xx, yy, xx + yy), axis=-1).astype(np.uint8)
        pixels.flags.writeable = False
        return NativeRegion(
            pixels=pixels,
            axes="YXS",
            selection=selection,
            sha256=self.metadata.sha256,
            format="fake",
            native_dtype="uint8",
            read_mode="fake",
            estimated_peak_bytes=pixels.nbytes,
            integrity_mode="stat-verified-session",
        )


class _NonFiniteHistogramSession(_FakeSession):
    def read_region(self, selection: NativeSelection) -> NativeRegion:
        self.reads.append(selection)
        pixels = np.full((selection.height, selection.width), np.nan, dtype=np.float32)
        pixels.flags.writeable = False
        return NativeRegion(
            pixels=pixels,
            axes="YX",
            selection=selection,
            sha256=self.metadata.sha256,
            format="fake",
            native_dtype="float32",
            read_mode="fake",
            estimated_peak_bytes=pixels.nbytes,
            integrity_mode="stat-verified-session",
        )


def _metadata(*, shape: tuple[int, int, int] = (1200, 900, 3), pyramid: bool = True):
    x, y, channels = shape
    base = NativeDimensions(2, channels, 4, y, x)
    levels = [NativeLevel(0, base, PhysicalCalibration("ZYX", (2.0, 0.5, 0.25), "um"))]
    if pyramid:
        reduced = NativeDimensions(2, channels, 2, y // 3, x // 3)
        levels.append(NativeLevel(1, reduced, PhysicalCalibration("ZYX", (4.0, 1.5, 0.75), "um")))
    displays = tuple(
        NativeChannelDisplay(
            channel=channel,
            color_mode="base-color",
            color_mode_basis="ims-ColorMode",
            color_rgb=color,
            color_basis="ims-Color",
            value_range=(0.0, 255.0),
            range_basis="ims-ColorRange",
            gamma=1.0,
            gamma_basis="ims-GammaCorrection",
            opacity=1.0,
            opacity_basis="ims-ColorOpacity",
        )
        for channel, color in enumerate(
            ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))[:channels]
        )
    )
    return NativeImageMetadata(
        format="fake",
        axes="TCZYX",
        shape=(2, channels, 4, y, x),
        source_axes="TCZYX",
        source_shape=(2, channels, 4, y, x),
        dimensions=base,
        levels=tuple(levels),
        channel_names=tuple(f"C{channel}" for channel in range(channels)),
        channel_dtypes=("uint8",) * channels,
        sample_semantics="none",
        physical_calibration=levels[0].calibration,
        sha256="a" * 64,
        selected_series=0,
        series_count=1,
        capabilities=NativeCapabilities(True, True, True, True, pyramid, True, ("fake",)),
        acquisition_display=displays,
        rgb_color_policy=NativeRgbColorPolicy(
            "scalar", "not-applicable", None, None, "not-applicable", "none"
        ),
    )


def _channels(count: int = 3) -> list[dict[str, object]]:
    colors = ("#ff0000", "#00ff00", "#0000ff")
    return [
        {
            "channel": channel,
            "low": 0.0,
            "high": 255.0,
            "gamma": 1.0,
            "visible": True,
            "color": colors[channel],
            "opacity": 1.0,
        }
        for channel in range(count)
    ]


def _rgb_metadata() -> NativeImageMetadata:
    dimensions = NativeDimensions(1, 1, 1, 12, 16, 3)
    return NativeImageMetadata(
        format="fake",
        axes="TCZYXS",
        shape=(1, 1, 1, 12, 16, 3),
        source_axes="YXS",
        source_shape=(12, 16, 3),
        dimensions=dimensions,
        levels=(NativeLevel(0, dimensions, PhysicalCalibration("YX", (1.0, 1.0), "pixel")),),
        channel_names=("Source RGB samples",),
        channel_dtypes=("uint8",),
        sample_semantics="RGB",
        physical_calibration=PhysicalCalibration("YX", (1.0, 1.0), "pixel"),
        sha256="b" * 64,
        selected_series=0,
        series_count=1,
        capabilities=NativeCapabilities(True, False, False, False, False, True, ("fake",)),
        rgb_color_policy=NativeRgbColorPolicy(
            "source-device-RGB", "missing", None, None, "uncharacterized-source-RGB", "none"
        ),
    )


def _decode_png(data_url: str) -> np.ndarray:
    prefix = "data:image/png;base64,"
    assert data_url.startswith(prefix)
    with Image.open(__import__("io").BytesIO(base64.b64decode(data_url[len(prefix) :]))) as image:
        return np.asarray(image).copy()


def test_defaults_preserve_acquisition_metadata_without_pixel_reads() -> None:
    session = _FakeSession(_metadata())

    first = viewer_defaults(session, {"source_id": "source-1", "t": 1, "z": 3, "auto": False})
    second = viewer_defaults(session, {"source_id": "source-1", "t": 0, "z": 0, "auto": False})

    assert session.reads == []
    assert [item["color"] for item in first["channels"]] == ["#ff0000", "#00ff00", "#0000ff"]
    assert first["channels"] == second["channels"]
    assert first["display_revision"] == second["display_revision"]
    assert first["basis"]["mode"] == "acquisition"
    assert first["basis"]["viewport_dependent"] is False
    assert first["basis"]["channels"][0]["range"] == "ims-ColorRange"
    assert first["rgb_policy"]["source_space"] == "scalar"


def test_auto_defaults_use_complete_deterministic_native_overview() -> None:
    session = _FakeSession(_metadata())

    result = viewer_defaults(session, {"source_id": "source-1", "t": 1, "z": 3, "auto": True})

    assert {key: value for key, value in result["basis"].items() if key != "channels"} == {
        "mode": "auto",
        "sample": "deterministic-native-pyramid-level",
        "level": 1,
        "t": 1,
        "z": 3,
        "viewport_dependent": False,
    }
    assert len(session.reads) == 3
    assert all(
        read.level == 1 and read.width == 400 and read.height == 300 for read in session.reads
    )
    assert all(item["range"].startswith("auto-") for item in result["basis"]["channels"])


def test_histogram_uses_stable_native_overview_and_has_complete_receipt() -> None:
    session = _FakeSession(_metadata())

    result = viewer_histogram(session, {"source_id": "source-1", "t": 1, "z": 3, "bins": 32})
    session.reads.clear()
    repeat = viewer_histogram(session, {"source_id": "source-1", "t": 1, "z": 3, "bins": 32})

    assert result["source_sha256"] == "a" * 64
    assert result["sample"] == {
        "kind": "deterministic-native-pyramid-level",
        "level": 1,
        "t": 1,
        "z": 3,
        "shape": [300, 400],
        "sample_count_per_component": 120_000,
        "viewport_dependent": False,
    }
    assert len(result["histograms"]) == 3
    assert [record["label"] for record in result["histograms"]] == ["C0", "C1", "C2"]
    for record in result["histograms"]:
        assert len(record["counts"]) == 32
        assert sum(record["counts"]) == record["sample_count"] == 120_000
        assert record["units"] == "native scalar sample values"
        assert record["min"] <= record["percentile_1"] <= record["percentile_99"] <= record["max"]
    assert all(read.level == 1 and read.x == 0 and read.y == 0 for read in session.reads)
    assert repeat == result


def test_histogram_has_no_viewport_input_and_rejects_before_reads_on_memory_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _FakeSession(_metadata(pyramid=False))
    with pytest.raises(ViewerImageError, match="unsupported fields"):
        viewer_histogram(session, {"source_id": "source-1", "x": 10})
    assert session.reads == []

    monkeypatch.setattr(viewer_image_module, "MAX_VIEWER_WORKING_BYTES", 1)
    with pytest.raises(ViewerImageError, match="working-memory"):
        viewer_histogram(session, {"source_id": "source-1"})
    assert session.reads == []


def test_histogram_rejects_nonfinite_source_samples() -> None:
    metadata = replace(_metadata(shape=(16, 12, 1)), channel_dtypes=("float32",))
    session = _NonFiniteHistogramSession(metadata)

    with pytest.raises(ViewerImageError, match="non-finite"):
        viewer_histogram(session, {"source_id": "source-1"})


@pytest.mark.parametrize(
    "value,dtype", [(0, "uint8"), (100, "uint16"), (65535, "uint16"), (3.25, "float32")]
)
def test_constant_histogram_preserves_exact_percentiles(value: float, dtype: str) -> None:
    result = viewer_image_module._histogram_record(
        np.full((4, 8), value, dtype=dtype),
        component=0,
        label="Channel 1",
        units="native scalar sample values",
        bins=256,
    )
    assert sum(result["counts"]) == result["sample_count"] == 32
    assert result["percentile_1"] == result["percentile_99"] == value
    assert result["min"] == result["max"] == value
    assert result["bin_range"][0] <= value <= result["bin_range"][1]


def test_stored_rgb_histogram_and_view_adjustment_keep_source_identity() -> None:
    session = _RgbFakeSession(_rgb_metadata())
    histogram = viewer_histogram(session, {"source_id": "rgb-source", "bins": 16})

    assert histogram["sample_semantics"] == "RGB"
    assert [record["label"] for record in histogram["histograms"]] == [
        "stored RGB red",
        "stored RGB green",
        "stored RGB blue",
    ]
    assert all(
        record["units"] == "stored source-device component values"
        for record in histogram["histograms"]
    )
    assert histogram["source_sha256"] == "b" * 64

    neutral = viewer_tile(
        session,
        {
            "source_id": "rgb-source",
            "selection": {"x": 0, "y": 0, "width": 4, "height": 3, "level": 0, "c": 0},
            "channels": [
                {
                    "channel": 0,
                    "low": 0.0,
                    "high": 255.0,
                    "gamma": 1.0,
                    "visible": True,
                    "color": "#ffffff",
                    "opacity": 1.0,
                }
            ],
        },
    )
    adjusted = viewer_tile(
        session,
        {
            "source_id": "rgb-source",
            "selection": {"x": 0, "y": 0, "width": 4, "height": 3, "level": 0, "c": 0},
            "channels": [
                {
                    "channel": 0,
                    "low": 2.0,
                    "high": 6.0,
                    "gamma": 1.0,
                    "visible": True,
                    "color": "#ffffff",
                    "opacity": 1.0,
                }
            ],
        },
    )

    expected = np.stack(np.mgrid[0:3, 0:4][::-1], axis=-1)
    expected = np.concatenate((expected, expected.sum(axis=-1, keepdims=True)), axis=-1).astype(
        np.uint8
    )
    np.testing.assert_array_equal(_decode_png(neutral["image"]), expected)
    assert not np.array_equal(_decode_png(adjusted["image"]), expected)
    assert neutral["source_sha256"] == adjusted["source_sha256"] == "b" * 64


def test_normal_tile_reads_exact_requested_region_and_composites_channels() -> None:
    session = _FakeSession(_metadata(shape=(80, 60, 3), pyramid=False))

    result = viewer_tile(
        session,
        {
            "source_id": "source-1",
            "selection": {
                "x": 7,
                "y": 5,
                "width": 11,
                "height": 9,
                "level": 0,
                "z": 2,
                "t": 1,
                "c": 0,
            },
            "channels": _channels(),
        },
    )

    assert len(session.reads) == 3
    assert all((read.x, read.y, read.width, read.height) == (7, 5, 11, 9) for read in session.reads)
    assert result["selection"]["c"] == 0
    assert result["source_sha256"] == "a" * 64
    assert result["geometry"]["axes"] == "YX"
    assert _decode_png(result["image"]).shape == (9, 11, 3)


def test_native_pyramid_overview_covers_full_extent_without_level_zero_read() -> None:
    session = _FakeSession(_metadata())

    result = viewer_tile(
        session,
        {
            "source_id": "source-1",
            "overview": True,
            "t": 0,
            "z": 3,
            "c": 0,
            "channels": _channels(),
            "max_edge": 1024,
        },
    )

    assert result["preparation"] == "native-pyramid"
    assert result["source_extent"] == [1200, 900]
    assert (result["width"], result["height"]) == (400, 300)
    assert len(session.reads) == 3
    assert all(read.level == 1 and read.x == 0 and read.y == 0 for read in session.reads)


def test_no_pyramid_overview_uses_bounded_tiles_and_project_cache(tmp_path) -> None:
    metadata = _metadata(shape=(1100, 700, 1), pyramid=False)
    session = _FakeSession(metadata)
    request = {
        "source_id": "source-1",
        "overview": True,
        "t": 0,
        "z": 0,
        "c": 0,
        "channels": _channels(1),
        "max_edge": 256,
    }

    first = viewer_tile(session, request, cache_root=tmp_path)

    assert first["preparation"] == "derived-cache"
    assert first["source_extent"] == [1100, 700]
    assert max(first["width"], first["height"]) == 256
    assert session.reads
    assert all(read.width <= 512 and read.height <= 512 for read in session.reads)
    cached = list((tmp_path / "viewer-overviews").glob("*.png"))
    assert len(cached) == 1

    session.reads.clear()
    second = viewer_tile(session, request, cache_root=tmp_path)
    assert second["image"] == first["image"]
    assert session.reads == []
    assert session.validations == 1


def test_derived_cache_rejects_content_tampering(tmp_path) -> None:
    session = _FakeSession(_metadata(shape=(1100, 700, 1), pyramid=False))
    request = {
        "source_id": "source-1",
        "overview": True,
        "t": 0,
        "z": 0,
        "c": 0,
        "channels": _channels(1),
        "max_edge": 64,
    }
    viewer_tile(session, request, cache_root=tmp_path)
    cached = next((tmp_path / "viewer-overviews").glob("*.png"))
    encoded = bytearray(cached.read_bytes())
    encoded[-1] ^= 1
    cached.write_bytes(encoded)

    with pytest.raises(ViewerImageError, match="content hash"):
        viewer_tile(session, request, cache_root=tmp_path)


def test_cache_hit_revalidates_original_source_before_return(tmp_path) -> None:
    session = _FakeSession(_metadata(shape=(1100, 700, 1), pyramid=False))
    request = {
        "source_id": "source-1",
        "overview": True,
        "t": 0,
        "z": 0,
        "c": 0,
        "channels": _channels(1),
        "max_edge": 64,
    }
    viewer_tile(session, request, cache_root=tmp_path)
    session.reads.clear()
    session.source_current = False

    with pytest.raises(RuntimeError, match="source changed"):
        viewer_tile(session, request, cache_root=tmp_path)
    assert session.reads == []


def test_derived_cache_evicts_oldest_entries_at_file_bound(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(viewer_image_module, "MAX_OVERVIEW_CACHE_FILES", 2)
    session = _FakeSession(_metadata(shape=(1100, 700, 1), pyramid=False))
    for max_edge in (64, 63, 62):
        viewer_tile(
            session,
            {
                "source_id": "source-1",
                "overview": True,
                "t": 0,
                "z": 0,
                "c": 0,
                "channels": _channels(1),
                "max_edge": max_edge,
            },
            cache_root=tmp_path,
        )

    assert len(list((tmp_path / "viewer-overviews").glob("*.png"))) == 2


def test_aggregate_render_budget_rejects_before_source_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(viewer_image_module, "MAX_VIEWER_WORKING_BYTES", 1024)
    session = _FakeSession(_metadata(shape=(80, 60, 3), pyramid=False))

    with pytest.raises(ViewerImageError, match="working-memory"):
        viewer_tile(
            session,
            {
                "source_id": "source-1",
                "selection": {"x": 0, "y": 0, "width": 20, "height": 20},
                "channels": _channels(),
            },
        )
    assert session.reads == []


def test_projection_and_cancellation_are_bounded(tmp_path) -> None:
    session = _FakeSession(_metadata(shape=(600, 600, 1), pyramid=False))
    checks = 0

    def cancel() -> None:
        nonlocal checks
        checks += 1
        if checks == 2:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        viewer_tile(
            session,
            {
                "source_id": "source-1",
                "overview": True,
                "t": 0,
                "z": 0,
                "z_stop": 3,
                "projection": "mean",
                "c": 0,
                "channels": _channels(1),
                "max_edge": 128,
            },
            cache_root=tmp_path,
            cancellation_check=cancel,
        )
    assert not list(tmp_path.rglob("*.png"))


def test_requests_fail_closed_on_crop_derived_defaults_and_invalid_display() -> None:
    session = _FakeSession(_metadata(shape=(80, 60, 1), pyramid=False))
    bad = _channels(1)
    bad[0]["visible"] = "yes"
    with pytest.raises(ViewerImageError, match="visibility"):
        viewer_tile(
            session,
            {
                "source_id": "source-1",
                "selection": {"x": 0, "y": 0, "width": 20, "height": 20},
                "channels": bad,
            },
        )
    with pytest.raises(ViewerImageError, match="unsupported fields"):
        viewer_defaults(
            session,
            {"source_id": "source-1", "t": 0, "z": 0, "auto": True, "crop": {}},
        )


def test_native_rgb_tile_and_derived_overview_apply_validated_icc(tmp_path) -> None:
    path = tmp_path / "profiled.png"
    yy, xx = np.mgrid[:40, :60]
    pixels = np.stack((xx, yy, xx + yy), axis=-1).astype(np.uint8)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.fromarray(pixels, mode="RGB").save(path, icc_profile=profile)

    with NativeImageSession(path) as session:
        defaults = viewer_defaults(session, {"source_id": "a" * 32, "t": 0, "z": 0, "auto": False})
        icc = session.display_icc()
        tile = viewer_tile(
            session,
            {
                "source_id": "a" * 32,
                "selection": {"x": 5, "y": 7, "width": 12, "height": 9},
                "channels": defaults["channels"],
            },
            embedded_icc=icc,
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
                "max_edge": 32,
            },
            cache_root=tmp_path,
            embedded_icc=icc,
        )
        auto_defaults = viewer_defaults(
            session, {"source_id": "a" * 32, "t": 0, "z": 0, "auto": True}
        )
        assert auto_defaults["channels"][0]["channel"] == 0
        assert auto_defaults["channels"][0]["low"] >= 0.0
        assert auto_defaults["channels"][0]["high"] > auto_defaults["channels"][0]["low"]

    np.testing.assert_array_equal(_decode_png(tile["image"]), pixels[7:16, 5:17])
    assert overview["preparation"] == "derived-cache"
    assert _decode_png(overview["image"]).shape == (21, 32, 3)


def test_workbench_private_dispatch_supplies_icc_and_project_cache(tmp_path) -> None:
    source_path = tmp_path / "source.png"
    pixels = np.arange(24 * 32 * 3, dtype=np.uint32).reshape(24, 32, 3).astype(np.uint8)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.fromarray(pixels, mode="RGB").save(source_path, icc_profile=profile)
    project = ResearchProject.create(tmp_path / "viewer.loci-study", "Viewer")
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(source_path))
        defaults = workbench.execute(
            "viewer_defaults",
            {"source_id": source["id"], "t": 0, "z": 0, "auto": False},
        )
        result = workbench.execute(
            "viewer_tile",
            {
                "source_id": source["id"],
                "overview": True,
                "t": 0,
                "z": 0,
                "c": 0,
                "channels": defaults["channels"],
                "max_edge": 16,
            },
        )
    finally:
        workbench.close()

    assert result["source_sha256"] == source["sha256"]
    assert result["source_extent"] == [32, 24]
    assert (project.root / "viewer-overviews").is_dir()
    assert len(list((project.root / "viewer-overviews").glob("*.png"))) == 1
