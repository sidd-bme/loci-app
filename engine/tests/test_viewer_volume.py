import base64
from dataclasses import dataclass

import numpy as np
import pytest

from loci_engine.native_image import (
    NativeCapabilities,
    NativeDimensions,
    NativeImageMetadata,
    NativeLevel,
    NativeRegion,
    NativeSelection,
    PhysicalCalibration,
)
from loci_engine.quantitative import Geometry
from loci_engine.viewer_volume import ViewerVolumeError, build_volume_payload


@dataclass
class _FakeSession:
    metadata: NativeImageMetadata

    def __post_init__(self):
        self.reads = []

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        self.reads.append(selection)
        yy, xx = np.mgrid[
            selection.y : selection.y + selection.height,
            selection.x : selection.x + selection.width,
        ]
        pixels = (selection.c * 10_000 + selection.t * 1_000 + selection.z * 100 + yy + xx)
        pixels = pixels.astype(np.uint16)
        pixels.flags.writeable = False
        return NativeRegion(
            pixels=pixels,
            axes="YX",
            selection=selection,
            sha256=self.metadata.sha256,
            format="fake",
            native_dtype="uint16",
            read_mode="fake-bounded-plane",
            estimated_peak_bytes=pixels.nbytes,
            integrity_mode="stat-verified-session",
        )

    def geometry(self, selection, volume):
        assert volume is True
        matrix = np.diag([0.4, 0.8, 2.5, 1.0])
        matrix[:3, 3] = [
            10 + selection["x"] * 0.4,
            20 + selection["y"] * 0.8,
            30 + selection["z"] * 2.5,
        ]
        return Geometry("ZYX", tuple(map(tuple, matrix)), "um")


def _metadata(*, shape=(40, 30, 20), channels=2, times=3):
    x, y, z = shape
    dimensions = NativeDimensions(times, channels, z, y, x)
    return NativeImageMetadata(
        format="fake",
        axes="TCZYX",
        shape=(times, channels, z, y, x),
        source_axes="TCZYX",
        source_shape=(times, channels, z, y, x),
        dimensions=dimensions,
        levels=(
            NativeLevel(0, dimensions, PhysicalCalibration("ZYX", (2.5, 0.8, 0.4), "um")),
        ),
        channel_names=tuple(f"C{channel}" for channel in range(channels)),
        channel_dtypes=("uint16",) * channels,
        sample_semantics="none",
        physical_calibration=PhysicalCalibration("ZYX", (2.5, 0.8, 0.4), "um"),
        sha256="a" * 64,
        selected_series=0,
        series_count=1,
        capabilities=NativeCapabilities(True, True, True, True, False, True, ("fake",)),
    )


def test_whole_extent_context_is_bounded_and_preserves_geometry():
    session = _FakeSession(_metadata())
    result = build_volume_payload(
        session,
        source_id="source-1",
        t=2,
        channel_indices=[1, 0],
        target_long_axis=16,
    )
    context = result["context"]
    assert result["focus"] is None
    assert context["role"] == "whole-volume-context"
    assert context["source_extent_xyzxyz"] == [0, 39, 0, 29, 0, 19]
    assert context["dimensions_xyz"] == [16, 12, 8]
    for indices, last in zip(
        context["sampling"]["source_indices_xyz"], (39, 29, 19), strict=True
    ):
        assert indices[0] == 0
        assert indices[-1] == last
        assert all(right > left for left, right in zip(indices, indices[1:], strict=False))
    assert context["origin_xyz"] == [10.0, 20.0, 30.0]
    assert context["spacing_xyz"] == pytest.approx([1.04, 29 * 0.8 / 11, 19 * 2.5 / 7])
    assert context["direction_3x3"] == pytest.approx([1, 0, 0, 0, 1, 0, 0, 0, 1])
    assert context["scalar_type"] == "uint16"
    assert [component["channel_index"] for component in context["components"]] == [1, 0]
    assert all(component["visible"] is True for component in context["components"])
    assert all(
        component["provenance"]["visibility"]
        == "explicit-volume-channel-selection"
        for component in context["components"]
    )
    assert all(
        component["provenance"]["range"]
        == "bounded-context-histogram-p1-p99-2048bins"
        for component in context["components"]
    )
    assert all(
        component["window"]["high"] < 65_535 for component in context["components"]
    )
    decoded = np.frombuffer(base64.b64decode(context["data_base64"]), dtype="<u2")
    assert decoded.size == 16 * 12 * 8 * 2
    first_voxel = decoded.reshape(8, 12, 16, 2)[0, 0, 0]
    assert first_voxel.tolist() == [12_000, 2_000]
    assert len(session.reads) == 16
    assert all(read.width == 40 and read.height == 30 for read in session.reads)
    assert all(read.t == 2 for read in session.reads)


def test_focus_brick_is_level_zero_and_context_remains_present():
    session = _FakeSession(_metadata())
    result = build_volume_payload(
        session,
        source_id="source-1",
        channel_indices=[0],
        target_long_axis=16,
        focus_region_xyzxyz=[5, 14, 6, 13, 3, 8],
    )
    assert result["context"]["role"] == "whole-volume-context"
    assert result["focus"]["role"] == "level-zero-focus"
    assert result["focus"]["source_extent_xyzxyz"] == [5, 14, 6, 13, 3, 8]
    assert result["focus"]["dimensions_xyz"] == [10, 8, 6]
    assert result["focus"]["origin_xyz"] == [12.0, 24.8, 37.5]


def test_refuses_non_volume_rgb_and_sheared_geometry():
    metadata = _metadata(shape=(10, 10, 1))
    with pytest.raises(ViewerVolumeError, match="two source Z"):
        build_volume_payload(_FakeSession(metadata), source_id="x")

    rgb = _metadata()
    object.__setattr__(rgb, "sample_semantics", "RGB")
    with pytest.raises(ViewerVolumeError, match="RGB"):
        build_volume_payload(_FakeSession(rgb), source_id="x")

    class _Sheared(_FakeSession):
        def geometry(self, selection, volume):
            return Geometry(
                "ZYX",
                ((1.0, 0.2, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0, 0, 0, 1)),
            )

    with pytest.raises(ViewerVolumeError, match="sheared"):
        build_volume_payload(_Sheared(_metadata()), source_id="x", target_long_axis=16)


def test_request_bounds_and_focus_extent_are_strict():
    session = _FakeSession(_metadata())
    with pytest.raises(ViewerVolumeError, match="one to four"):
        build_volume_payload(session, source_id="x", channel_indices=[])
    with pytest.raises(ViewerVolumeError, match="unique"):
        build_volume_payload(session, source_id="x", channel_indices=[0, 0])
    with pytest.raises(ViewerVolumeError, match="focus region"):
        build_volume_payload(session, source_id="x", focus_region_xyzxyz=[0, 9, 0, 9, 2, 2])


def test_oblique_reflected_direction_is_vtk_column_major_and_matches_affine():
    class _Oblique(_FakeSession):
        def geometry(self, selection, volume):
            return Geometry(
                "ZYX",
                (
                    (0.0, -0.8, 0.0, 10.0),
                    (0.4, 0.0, 0.0, 20.0),
                    (0.0, 0.0, -2.5, 30.0),
                    (0.0, 0.0, 0.0, 1.0),
                ),
                "mm",
                "LPS",
            )

    result = build_volume_payload(
        _Oblique(_metadata(shape=(10, 8, 6), channels=1, times=1)),
        source_id="x",
        target_long_axis=16,
    )["context"]
    assert result["direction_3x3"] == pytest.approx([0, 1, 0, -1, 0, 0, 0, 0, -1])
    affine = np.asarray(result["affine_4x4"])
    index = np.array([3.0, 2.0, 1.0, 1.0])
    assert affine @ index == pytest.approx([8.4, 21.2, 27.5, 1.0])


def test_large_unpyramided_source_reads_bounded_tiles_and_keeps_a_3d_context():
    session = _FakeSession(_metadata(shape=(100_000_000, 8, 4), channels=1, times=1))
    context = build_volume_payload(
        session,
        source_id="large",
        target_long_axis=16,
        max_decoded_bytes=1024 * 1024,
    )["context"]
    assert context["dimensions_xyz"] == [16, 2, 2]
    assert context["source_extent_xyzxyz"] == [0, 99_999_999, 0, 7, 0, 3]
    assert context["sampling"]["source_indices_xyz"][0][0] == 0
    assert context["sampling"]["source_indices_xyz"][0][-1] == 99_999_999
    assert max(read.width * read.height * 2 for read in session.reads) <= 128 * 1024
    assert all(read.height == 8 for read in session.reads)


def test_focus_uses_its_whole_context_transfer_defaults():
    session = _FakeSession(_metadata())
    coarse = build_volume_payload(
        session, source_id="stable", channel_indices=[1], target_long_axis=16
    )
    finer = build_volume_payload(
        session,
        source_id="stable",
        channel_indices=[1],
        target_long_axis=32,
        focus_region_xyzxyz=[2, 9, 3, 10, 1, 5],
    )
    assert coarse["context"]["components"][0]["provenance"]["range"].startswith(
        "bounded-context-"
    )
    assert finer["focus"]["components"] == finer["context"]["components"]
