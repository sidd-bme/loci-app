from __future__ import annotations

import hashlib
import struct
from pathlib import Path

import h5py
import numpy as np
import pytest
import tifffile
from PIL import Image, ImageCms

import loci_engine.native_image as native_module
from loci_engine.native_image import (
    NativeChannelDisplay,
    NativeDisplayIssue,
    NativeImageError,
    NativeImageSession,
    NativePlanePosition,
    NativePlaneTime,
    NativeReadBudgetError,
    NativeSelection,
    NativeSourceChangedError,
    NativeTimeCalibration,
    PhysicalCalibration,
    inspect_native,
    read_native_region,
)


def _values(shape: tuple[int, ...]) -> np.ndarray:
    return np.arange(np.prod(shape), dtype=np.uint16).reshape(shape)


def _replace_ome_description(path: Path, old: str, new: str) -> None:
    with tifffile.TiffFile(path) as tif:
        xml = tif.ome_metadata
    assert xml is not None and old in xml
    tifffile.tiffcomment(path, xml.replace(old, new, 1))


def _write_ims(path: Path) -> dict[tuple[int, int, int], np.ndarray]:
    stored: dict[tuple[int, int, int], np.ndarray] = {}
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = "ImarisDataSet"
        dataset = ims.create_group("DataSet")
        for level_index, (depth, height, width) in enumerate(((3, 8, 10), (3, 4, 5))):
            level = dataset.create_group(f"ResolutionLevel {level_index}")
            for time_index in range(3):
                timepoint = level.create_group(f"TimePoint {time_index}")
                for channel_index in range(2):
                    z, y, x = np.indices((depth, height, width))
                    values = np.asarray(
                        level_index * 10_000
                        + time_index * 1_000
                        + channel_index * 100
                        + z * 10
                        + y * 2
                        + x,
                        dtype=np.uint16,
                    )
                    stored[level_index, time_index, channel_index] = values
                    channel = timepoint.create_group(f"Channel {channel_index}")
                    channel.attrs["ImageSizeX"] = str(width)
                    channel.attrs["ImageSizeY"] = str(height)
                    channel.attrs["ImageSizeZ"] = str(depth)
                    channel.create_dataset("Data", data=values, chunks=(1, 4, 5))

        info = ims.create_group("DataSetInfo")
        image = info.create_group("Image")
        image.attrs["ExtMin0"] = "0"
        image.attrs["ExtMax0"] = "5"
        image.attrs["ExtMin1"] = "10"
        image.attrs["ExtMax1"] = "18"
        image.attrs["ExtMin2"] = "-1"
        image.attrs["ExtMax2"] = "5"
        image.attrs["Unit"] = "µm"
        time_info = info.create_group("TimeInfo")
        time_info.attrs["DatasetTimePoints"] = "3"
        time_info.attrs["FileTimePoints"] = "3"
        time_info.attrs["TimePoint1"] = "2026-09-07 10:00:00.000"
        time_info.attrs["TimePoint2"] = "2026-09-07 10:00:00.750"
        time_info.attrs["TimePoint3"] = "2026-09-07 10:00:02.000"
        for index, name in enumerate(("DAPI", "Reporter")):
            info.create_group(f"Channel {index}").attrs["Name"] = name
    return stored


def test_tiled_ome_tiff_reads_exact_t_c_z_region_and_calibration(tmp_path: Path) -> None:
    path = tmp_path / "scientific.ome.tif"
    source = _values((2, 3, 4, 32, 48))
    tifffile.imwrite(
        path,
        source,
        tile=(16, 16),
        compression="deflate",
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.75,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 2.0,
            "PhysicalSizeZUnit": "µm",
            "Channel": {"Name": ["A", "B", "C"]},
        },
    )

    metadata = inspect_native(path)

    assert metadata.format == "OME-TIFF"
    assert metadata.axes == "TCZYX"
    assert metadata.shape == source.shape
    assert metadata.source_axes == "TCZYX"
    assert metadata.channel_names == ("A", "B", "C")
    assert metadata.channel_dtypes == ("uint16", "uint16", "uint16")
    assert metadata.physical_calibration == PhysicalCalibration("ZYX", (2.0, 0.75, 0.5), "µm")
    assert metadata.capabilities.tiled
    assert metadata.capabilities.select_t
    assert metadata.capabilities.select_c
    assert metadata.capabilities.select_z
    assert metadata.sha256 == hashlib.sha256(path.read_bytes()).hexdigest()
    assert not hasattr(metadata, "path")

    region = read_native_region(
        path,
        NativeSelection(
            x=13,
            y=9,
            width=19,
            height=17,
            t=1,
            c=2,
            z=3,
            expected_sha256=metadata.sha256,
        ),
    )

    np.testing.assert_array_equal(region.pixels, source[1, 2, 3, 9:26, 13:32])
    assert region.axes == "YX"
    assert region.read_mode == "tiff-segments"
    assert region.native_dtype == "uint16"
    assert region.integrity_mode == "full-sha256"
    assert not region.pixels.flags.writeable


def test_tiff_axis_permutation_and_memmap_preserve_coordinate_mapping(tmp_path: Path) -> None:
    path = tmp_path / "permuted.tif"
    source = _values((2, 3, 4, 7, 9))
    tifffile.imwrite(path, source, photometric="minisblack", metadata={"axes": "ZTCYX"})

    metadata = inspect_native(path)
    region = read_native_region(
        path,
        NativeSelection(x=2, y=1, width=5, height=4, z=1, t=2, c=3),
    )

    assert metadata.source_axes == "ZTCYX"
    assert metadata.axes == "TCZYX"
    assert metadata.shape == (3, 4, 2, 7, 9)
    np.testing.assert_array_equal(region.pixels, source[1, 2, 3, 1:5, 2:7])
    assert region.read_mode == "tiff-memmap"


def test_rgb_samples_are_not_reported_as_biological_channels(tmp_path: Path) -> None:
    path = tmp_path / "rgb.tif"
    y, x = np.indices((18, 21))
    source = np.stack((x, y, x + 2 * y), axis=-1).astype(np.uint8)
    tifffile.imwrite(path, source, photometric="rgb", tile=(16, 16), compression="deflate")

    metadata = inspect_native(path)
    region = read_native_region(path, NativeSelection(x=4, y=3, width=11, height=9, c=0))

    assert metadata.axes == "TCZYXS"
    assert metadata.dimensions.c == 1
    assert metadata.dimensions.s == 3
    assert metadata.sample_semantics == "RGB"
    assert not metadata.capabilities.select_c
    assert region.axes == "YXS"
    np.testing.assert_array_equal(region.pixels, source[3:12, 4:15, :])
    with pytest.raises(NativeImageError, match="C index 1"):
        read_native_region(path, NativeSelection(x=0, y=0, width=1, height=1, c=1))


def test_bigtiff_pyramid_reads_declared_level_with_scaled_spacing(tmp_path: Path) -> None:
    path = tmp_path / "pyramid.tf8"
    base = _values((64, 80))
    reduced = np.asarray(base[::2, ::2])
    with tifffile.TiffWriter(path, bigtiff=True) as tif:
        tif.write(
            base,
            subifds=1,
            tile=(16, 16),
            compression="deflate",
            resolution=(20_000, 10_000),
            resolutionunit="CENTIMETER",
            metadata={"axes": "YX"},
        )
        tif.write(
            reduced,
            subfiletype=1,
            tile=(16, 16),
            compression="deflate",
            resolution=(10_000, 5_000),
            resolutionunit="CENTIMETER",
        )

    metadata = inspect_native(path)
    region = read_native_region(path, NativeSelection(x=7, y=5, width=13, height=11, level=1))

    assert metadata.format == "BigTIFF"
    assert len(metadata.levels) == 2
    assert metadata.levels[0].calibration == PhysicalCalibration("YX", (1.0, 0.5), "µm")
    assert metadata.levels[1].calibration == PhysicalCalibration("YX", (2.0, 1.0), "µm")
    np.testing.assert_array_equal(region.pixels, reduced[5:16, 7:20])


def test_ims_inspection_and_hyperslab_read_all_native_dimensions(tmp_path: Path) -> None:
    path = tmp_path / "volume.ims"
    stored = _write_ims(path)

    metadata = inspect_native(path)

    assert metadata.format == "IMS"
    assert metadata.axes == "TCZYX"
    assert metadata.shape == (3, 2, 3, 8, 10)
    assert metadata.channel_names == ("DAPI", "Reporter")
    assert metadata.channel_dtypes == ("uint16", "uint16")
    assert metadata.physical_calibration == PhysicalCalibration("ZYX", (2.0, 1.0, 0.5), "µm")
    assert metadata.levels[1].dimensions.z == 3
    assert metadata.levels[1].dimensions.y == 4
    assert metadata.levels[1].dimensions.x == 5
    assert metadata.levels[1].calibration == PhysicalCalibration("ZYX", (2.0, 2.0, 1.0), "µm")
    assert metadata.levels[0].origin_xyz == (0.25, 10.5, 0.0)
    assert metadata.levels[1].origin_xyz == (0.5, 11.0, 0.0)
    assert metadata.timing == NativeTimeCalibration(
        source="ims-time-info",
        timestamps=(
            "2026-09-07 10:00:00.000",
            "2026-09-07 10:00:00.750",
            "2026-09-07 10:00:02.000",
        ),
        elapsed_times=(0.0, 0.75, 2.0),
        frame_intervals=(0.75, 1.25),
    )
    assert metadata.capabilities.pyramid_levels
    assert metadata.capabilities.select_t
    assert metadata.capabilities.select_c
    assert metadata.capabilities.select_z

    region = read_native_region(
        path,
        NativeSelection(x=1, y=1, width=3, height=2, level=1, t=1, c=1, z=2),
    )

    np.testing.assert_array_equal(region.pixels, stored[1, 1, 1][2, 1:3, 1:4])
    assert region.read_mode == "ims-hyperslab"
    assert region.axes == "YX"


def test_ims_acquisition_display_metadata_is_strict_and_non_destructive(tmp_path: Path) -> None:
    path = tmp_path / "display.ims"
    _write_ims(path)
    with h5py.File(path, "r+") as ims:
        first = ims["DataSetInfo/Channel 0"]
        first.attrs["ColorMode"] = "BaseColor"
        first.attrs["Color"] = "1.000 0.250 0.000"
        first.attrs["ColorRange"] = "10 60000"
        first.attrs["GammaCorrection"] = "2.2"
        first.attrs["ColorOpacity"] = "0.4"
        first.attrs["Visible"] = "false"
        second = ims["DataSetInfo/Channel 1"]
        second.attrs["ColorMode"] = "TableColor"
        second.attrs["Color"] = "0 1 0"
        second.attrs["ColorRange"] = "-1 70000"
        second.attrs["GammaCorrection"] = "nan"
        second.attrs["ColorOpacity"] = "2"
        second.attrs["Visible"] = "sometimes"

    metadata = inspect_native(path)

    assert metadata.acquisition_display[0] == NativeChannelDisplay(
        channel=0,
        color_mode="base-color",
        color_mode_basis="ims-ColorMode",
        color_rgb=(1.0, 0.25, 0.0),
        color_basis="ims-Color",
        value_range=(10.0, 60000.0),
        range_basis="ims-ColorRange",
        gamma=2.2,
        gamma_basis="ims-GammaCorrection",
        opacity=0.4,
        opacity_basis="ims-ColorOpacity",
        visible=False,
        visibility_basis="ims-Visible",
    )
    second = metadata.acquisition_display[1]
    assert second.color_mode == "table-color"
    assert second.color_rgb is None and second.value_range is None
    assert second.gamma is None and second.opacity is None and second.visible is None
    assert second.ignored == (
        NativeDisplayIssue("ColorMode", "table-colour acquisition LUTs are not supported"),
        NativeDisplayIssue("Color", "ignored for unsupported table-colour mode"),
        NativeDisplayIssue("ColorRange", "outside native channel dtype bounds"),
        NativeDisplayIssue("GammaCorrection", "outside supported range 0.1 to 10"),
        NativeDisplayIssue("ColorOpacity", "expected a finite value from zero to one"),
        NativeDisplayIssue("Visible", "expected true, false, zero, or one"),
    )
    assert metadata.sample_semantics == "none"
    assert metadata.rgb_color_policy is not None
    assert metadata.rgb_color_policy.source_status == "not-applicable"


def test_ims_unrecognized_color_mode_does_not_apply_color(tmp_path: Path) -> None:
    path = tmp_path / "unknown-display.ims"
    _write_ims(path)
    with h5py.File(path, "r+") as ims:
        channel = ims["DataSetInfo/Channel 0"]
        channel.attrs["ColorMode"] = "FutureMode"
        channel.attrs["Color"] = "1 0 0"

    record = inspect_native(path).acquisition_display[0]

    assert record.color_mode is None and record.color_rgb is None
    assert record.ignored == (
        NativeDisplayIssue("ColorMode", "unrecognized acquisition colour mode"),
        NativeDisplayIssue("Color", "ignored for unrecognized acquisition colour mode"),
    )


def test_ims_acquisition_display_resolves_color_table_and_fluorophore_names(
    tmp_path: Path,
) -> None:
    path = tmp_path / "table-display.ims"
    _write_ims(path)
    with h5py.File(path, "r+") as ims:
        first = ims["DataSetInfo/Channel 0"]
        first.attrs["ColorMode"] = "TableColor"
        table_entries = ["0.000 0.000 0.000"] * 255 + ["0.000 0.000 1.000"]
        lut_text = " ".join(table_entries)
        first.create_dataset(
            "ColorTable", data=np.array([c.encode("ascii") for c in lut_text], dtype="|S1")
        )
        first.attrs["Name"] = "DAPI-acq"

        second = ims["DataSetInfo/Channel 1"]
        second.attrs["Name"] = "TRITC-acq"

    metadata = inspect_native(path)
    ch0 = metadata.acquisition_display[0]
    assert ch0.color_rgb == (0.0, 0.0, 1.0)
    assert ch0.color_basis == "ims-ColorTable"

    ch1 = metadata.acquisition_display[1]
    assert ch1.color_rgb == (1.0, 0.2, 0.1)
    assert ch1.color_basis == "fluorophore-name-lookup"


def test_ome_explicit_signed_rgba_colors_are_luts_not_rgb_inference(tmp_path: Path) -> None:
    path = tmp_path / "channel-colors.ome.tif"
    source = np.zeros((3, 8, 12), dtype=np.uint8)
    tifffile.imwrite(
        path,
        source,
        ome=True,
        metadata={
            "axes": "CYX",
            "Channel": {
                "Name": ["First", "Second", "Third"],
                # OME Color is a signed 32-bit RGBA value.
                "Color": [-16776961, 16711935, 65408],
            },
        },
    )

    metadata = inspect_native(path)

    assert metadata.axes == "TCZYX"
    assert metadata.dimensions.c == 3 and metadata.dimensions.s == 1
    assert metadata.sample_semantics == "none"
    assert [record.color_rgb for record in metadata.acquisition_display] == [
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
    ]
    assert [record.opacity for record in metadata.acquisition_display] == [
        1.0,
        1.0,
        128 / 255,
    ]
    assert all(record.color_basis == "ome-Channel-Color" for record in metadata.acquisition_display)


def test_ordinary_rgb_icc_policy_is_bounded_and_does_not_change_native_samples(
    tmp_path: Path,
) -> None:
    path = tmp_path / "profiled.png"
    pixels = np.arange(6 * 7 * 3, dtype=np.uint8).reshape(6, 7, 3)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.fromarray(pixels, mode="RGB").save(path, icc_profile=profile)

    metadata = inspect_native(path)
    policy = metadata.rgb_color_policy

    assert metadata.sample_semantics == "RGB"
    assert policy is not None and policy.source_status == "embedded-usable"
    assert policy.source_icc_bytes == len(profile)
    assert policy.source_icc_sha256 == hashlib.sha256(profile).hexdigest()
    with NativeImageSession(path) as session:
        region = session.read_region(NativeSelection(x=1, y=2, width=4, height=3))
        assert session.display_icc() == profile
    np.testing.assert_array_equal(region.pixels, pixels[2:5, 1:5])

    invalid = tmp_path / "invalid-profile.png"
    Image.fromarray(pixels, mode="RGB").save(invalid, icc_profile=b"not-an-icc-profile")
    invalid_policy = inspect_native(invalid).rgb_color_policy
    assert invalid_policy is not None
    assert invalid_policy.source_status == "embedded-invalid"
    assert invalid_policy.transform == "none"


def test_tiff_icc_policy_and_private_profile_getter_use_tag_34675(tmp_path: Path) -> None:
    path = tmp_path / "profiled.tif"
    pixels = np.arange(6 * 7 * 3, dtype=np.uint8).reshape(6, 7, 3)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.fromarray(pixels, mode="RGB").save(path, icc_profile=profile)

    metadata = inspect_native(path)

    assert metadata.sample_semantics == "RGB"
    assert metadata.rgb_color_policy is not None
    assert metadata.rgb_color_policy.source_status == "embedded-usable"
    assert metadata.rgb_color_policy.source_icc_sha256 == hashlib.sha256(profile).hexdigest()
    with NativeImageSession(path) as session:
        assert session.display_icc() == profile
        region = session.read_region(NativeSelection(x=1, y=1, width=3, height=2))
    np.testing.assert_array_equal(region.pixels, pixels[1:3, 1:4])


def test_ims_selected_level_crop_geometry_uses_voxel_centres(tmp_path: Path) -> None:
    path = tmp_path / "geometry.ims"
    _write_ims(path)

    with NativeImageSession(path) as session:
        plane = session.geometry({"level": 1, "x": 1, "y": 1, "z": 2}, volume=False)
        volume = session.geometry({"level": 1, "x": 1, "y": 1, "z": 2}, volume=True)

    assert plane.axes == "YX"
    assert plane.unit == "um"
    assert plane.spacing == (2.0, 1.0)
    np.testing.assert_allclose(np.asarray(plane.affine)[:3, 3], (1.5, 13.0, 4.0))
    assert volume.axes == "ZYX"
    assert volume.spacing == (2.0, 2.0, 1.0)
    np.testing.assert_allclose(np.asarray(volume.affine)[:3, 3], (1.5, 13.0, 4.0))


def test_ome_defaults_mixed_units_plane_positions_and_timing(tmp_path: Path) -> None:
    default_path = tmp_path / "default-units.ome.tif"
    tifffile.imwrite(
        default_path,
        np.zeros((4, 5), dtype=np.uint8),
        metadata={"axes": "YX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.75},
    )
    assert inspect_native(default_path).physical_calibration == PhysicalCalibration(
        "YX", (0.75, 0.5), "µm"
    )

    path = tmp_path / "mixed-units.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((2, 1, 2, 4, 5), dtype=np.uint8),
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 500,
            "PhysicalSizeXUnit": "nm",
            "PhysicalSizeY": 0.75,
            "PhysicalSizeYUnit": "µm",
            "PhysicalSizeZ": 0.002,
            "PhysicalSizeZUnit": "mm",
            "TimeIncrement": 500,
            "TimeIncrementUnit": "ms",
            "Plane": {
                "DeltaT": [0, 0, 0.7, 0.7],
                "DeltaTUnit": ["s"] * 4,
                "PositionX": [1, 1, 2, 2],
                "PositionXUnit": ["mm"] * 4,
                "PositionY": [5, 5, 6, 6],
                "PositionYUnit": ["µm"] * 4,
            },
        },
    )

    metadata = inspect_native(path)

    assert metadata.physical_calibration == PhysicalCalibration("ZYX", (2.0, 0.75, 0.5), "µm")
    assert metadata.levels[0].origin_xyz is None
    assert metadata.timing == NativeTimeCalibration(
        source="ome-plane-delta-t",
        elapsed_times=(0.0, 0.7),
        frame_intervals=(0.7,),
        uniform_interval=0.5,
    )
    assert metadata.plane_positions[0] == NativePlanePosition(
        t=0,
        c=0,
        z=0,
        position_xyz=(1.0, 5.0, None),
        units_xyz=("mm", "µm", None),
        position_micrometres_xyz=(1000.0, 5.0, None),
    )
    assert metadata.plane_times[2] == NativePlaneTime(
        t=1,
        c=0,
        z=0,
        delta_t=0.7,
        delta_t_unit="s",
        delta_t_seconds=0.7,
    )


def test_ome_default_plane_position_unit_stays_nonphysical(tmp_path: Path) -> None:
    path = tmp_path / "reference-frame.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((4, 5), dtype=np.uint8),
        metadata={
            "axes": "YX",
            "Plane": {"PositionX": [12.5]},
        },
    )

    metadata = inspect_native(path)

    assert metadata.plane_positions == (
        NativePlanePosition(
            t=0,
            c=0,
            z=0,
            position_xyz=(12.5, None, None),
            units_xyz=("reference frame", None, None),
            position_micrometres_xyz=(None, None, None),
        ),
    )
    with NativeImageSession(path) as session:
        geometry = session.geometry({"level": 0, "x": 2, "y": 1, "z": 0}, volume=False)
    assert geometry.unit == "pixel"
    np.testing.assert_allclose(np.asarray(geometry.affine)[:3, 3], (2.0, 1.0, 0.0))


@pytest.mark.parametrize("samples", [3, 4])
def test_ome_rgb_component_plane_records_remain_samples_and_pixel_units_remain_uncalibrated(
    tmp_path: Path, samples: int
) -> None:
    path = tmp_path / "color-samples.ome.tif"
    image = np.arange(8 * 12 * samples, dtype=np.uint8).reshape(8, 12, samples)
    tifffile.imwrite(
        path,
        image,
        photometric="rgb",
        metadata={
            "axes": "YXS",
            "PhysicalSizeX": 1.0,
            "PhysicalSizeXUnit": "pixel",
            "PhysicalSizeY": 1.0,
            "PhysicalSizeYUnit": "pixel",
        },
    )
    # Real producers may write one Plane metadata record per RGB(A) sample.
    records = "".join(
        f'<Plane TheT="0" TheZ="0" TheC="{i}" DeltaT="0.25" PositionX="{i}" PositionXUnit="pixel"/>'
        for i in range(samples)
    )
    _replace_ome_description(path, "</Pixels>", records + "</Pixels>")
    metadata = inspect_native(path)
    assert metadata.dimensions.c == 1 and metadata.dimensions.s == samples
    assert metadata.physical_calibration == PhysicalCalibration("YX", (1.0, 1.0), "pixel")
    assert [record.c for record in metadata.plane_times] == [0] * samples
    assert [record.sample for record in metadata.plane_times] == list(range(samples))
    assert [record.sample for record in metadata.plane_positions] == list(range(samples))
    assert metadata.timing.elapsed_times == (0.25,)
    with NativeImageSession(path) as session:
        plane = session.read_region(NativeSelection(x=2, y=1, width=5, height=4))
        np.testing.assert_array_equal(plane.pixels, image[1:5, 2:7])
        geometry = session.geometry({"x": 2, "y": 1}, volume=False)
        assert geometry.unit == "pixel"
        np.testing.assert_array_equal(np.asarray(geometry.affine)[:3, 3], [2, 1, 0])
    _replace_ome_description(path, 'TheC="0" DeltaT', f'TheC="{samples}" DeltaT')
    with pytest.raises(NativeImageError, match="outside"):
        inspect_native(path)


def test_ome_rejects_mixed_pixel_and_physical_spacing(tmp_path: Path):
    path = tmp_path / "incompatible-units.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((8, 12), dtype=np.uint8),
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 1,
            "PhysicalSizeXUnit": "pixel",
            "PhysicalSizeY": 1,
            "PhysicalSizeYUnit": "µm",
        },
    )
    with pytest.raises(NativeImageError, match="cannot be mixed"):
        inspect_native(path)


def test_ome_uniform_increment_is_not_expanded_into_frame_times(tmp_path: Path) -> None:
    path = tmp_path / "uniform-only.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((3, 4, 5), dtype=np.uint8),
        metadata={
            "axes": "TYX",
            "TimeIncrement": 250,
            "TimeIncrementUnit": "ms",
        },
    )

    assert inspect_native(path).timing == NativeTimeCalibration(
        source="ome-time-increment", uniform_interval=0.25
    )


@pytest.mark.parametrize(
    ("metadata", "message"),
    [
        ({"PhysicalSizeX": 0.5}, "requires both X and Y"),
        (
            {"PhysicalSizeX": float("nan"), "PhysicalSizeY": 0.5},
            "PhysicalSizeX must be a positive finite number",
        ),
        (
            {
                "PhysicalSizeX": 0.5,
                "PhysicalSizeY": 0.5,
                "PhysicalSizeXUnit": "furlong",
            },
            "unsupported length unit",
        ),
        (
            {"Plane": {"PositionX": [float("nan")]}},
            "PositionX must be finite",
        ),
        (
            {"Plane": {"PositionXUnit": ["mm"]}},
            "PositionXUnit is present without PositionX",
        ),
    ],
)
def test_invalid_or_ambiguous_ome_coordinates_fail_closed(
    tmp_path: Path, metadata: dict[str, object], message: str
) -> None:
    path = tmp_path / "invalid-coordinate.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((4, 5), dtype=np.uint8),
        metadata={"axes": "YX", **metadata},
    )

    with pytest.raises(NativeImageError, match=message):
        inspect_native(path)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ('TheZ="1"', 'TheZ="0"', "indices are duplicated"),
        ('TheZ="0"', 'TheZ="9"', "outside 0..1"),
    ],
)
def test_duplicate_or_out_of_range_ome_plane_indices_fail_closed(
    tmp_path: Path, old: str, new: str, message: str
) -> None:
    path = tmp_path / "invalid-plane-index.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((2, 4, 5), dtype=np.uint8),
        metadata={"axes": "ZYX", "Plane": {"PositionX": [1, 2]}},
    )
    _replace_ome_description(path, old, new)

    with pytest.raises(NativeImageError, match=message):
        inspect_native(path)


def test_per_plane_time_variation_stays_explicit_and_nonincreasing_t_fails_closed(
    tmp_path: Path,
) -> None:
    conflict = tmp_path / "conflicting-time.ome.tif"
    tifffile.imwrite(
        conflict,
        np.zeros((2, 1, 2, 4, 5), dtype=np.uint8),
        metadata={
            "axes": "TCZYX",
            "Plane": {"DeltaT": [0, 0.1, 1, 1], "DeltaTUnit": ["s"] * 4},
        },
    )
    metadata = inspect_native(conflict)
    assert metadata.timing == NativeTimeCalibration(source="ome-plane-delta-t")
    assert tuple(value.delta_t_seconds for value in metadata.plane_times) == (
        0.0,
        0.1,
        1.0,
        1.0,
    )

    nonincreasing = tmp_path / "nonincreasing-time.ome.tif"
    tifffile.imwrite(
        nonincreasing,
        np.zeros((2, 4, 5), dtype=np.uint8),
        metadata={"axes": "TYX", "Plane": {"DeltaT": [0, 0]}},
    )
    with pytest.raises(NativeImageError, match="increase strictly"):
        inspect_native(nonincreasing)


def test_partial_ims_extents_and_nonincreasing_times_fail_closed(tmp_path: Path) -> None:
    partial_extents = tmp_path / "partial-extents.ims"
    _write_ims(partial_extents)
    with h5py.File(partial_extents, "r+") as ims:
        del ims["DataSetInfo/Image"].attrs["ExtMax2"]
    with pytest.raises(NativeImageError, match="physical extents are incomplete"):
        inspect_native(partial_extents)

    nonincreasing = tmp_path / "nonincreasing.ims"
    _write_ims(nonincreasing)
    with h5py.File(nonincreasing, "r+") as ims:
        ims["DataSetInfo/TimeInfo"].attrs["TimePoint2"] = "2026-09-07 10:00:00.000"
    with pytest.raises(NativeImageError, match="strictly increasing"):
        inspect_native(nonincreasing)


def test_volume_geometry_rejects_partial_physical_calibration(tmp_path: Path) -> None:
    path = tmp_path / "xy-only-volume.ome.tif"
    tifffile.imwrite(
        path,
        np.zeros((2, 4, 5), dtype=np.uint8),
        metadata={"axes": "ZYX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.75},
    )

    with (
        NativeImageSession(path) as session,
        pytest.raises(NativeImageError, match="requires declared Z spacing"),
    ):
        session.geometry({"level": 0, "x": 0, "y": 0, "z": 0}, volume=True)


def test_png_region_is_exact_and_full_decode_is_budgeted(tmp_path: Path) -> None:
    path = tmp_path / "ordinary.png"
    source = np.arange(30 * 40, dtype=np.uint8).reshape(30, 40)
    Image.fromarray(source).save(path, dpi=(254, 127))

    metadata = inspect_native(path)
    assert metadata.format == "PNG"
    assert metadata.axes == "TCZYX"
    assert metadata.physical_calibration is not None
    assert metadata.physical_calibration.axes == "YX"
    assert metadata.physical_calibration.spacing == pytest.approx((200.0, 100.0), rel=0.01)

    region = read_native_region(
        path, NativeSelection(x=11, y=7, width=9, height=8, budget_bytes=2_000)
    )
    np.testing.assert_array_equal(region.pixels, source[7:15, 11:20])
    assert region.read_mode == "ordinary-bounded-decode"

    with pytest.raises(NativeReadBudgetError, match="No pixel data was read"):
        read_native_region(path, NativeSelection(x=11, y=7, width=9, height=8, budget_bytes=1_300))


def test_tiled_tiff_budget_accounts_for_decoded_segment_before_read(tmp_path: Path) -> None:
    path = tmp_path / "budgeted.tif"
    source = _values((64, 64))
    tifffile.imwrite(path, source, tile=(32, 32), compression="deflate")

    with pytest.raises(NativeReadBudgetError, match="decoded-memory budget") as error:
        read_native_region(path, NativeSelection(x=3, y=4, width=2, height=2, budget_bytes=1_000))

    assert error.value.required_bytes > 32 * 32 * source.dtype.itemsize


def test_tiff_segment_byte_range_outside_file_fails_before_decode(tmp_path: Path) -> None:
    path = tmp_path / "bad-byte-count.tif"
    tifffile.imwrite(
        path,
        np.zeros((64, 64), dtype=np.uint8),
        tile=(16, 16),
        compression="deflate",
    )
    with tifffile.TiffFile(path) as tif:
        tag = tif.pages[0].tags["TileByteCounts"]
        assert tag.dtype == 3  # classic-TIFF SHORT values for this compact fixture
        value_offset = int(tag.valueoffset)
        byte_order = tif.byteorder
    with path.open("r+b") as stream:
        stream.seek(value_offset)
        stream.write(struct.pack(f"{byte_order}H", path.stat().st_size))

    with pytest.raises(NativeImageError, match="byte range extends outside"):
        read_native_region(path, NativeSelection(x=0, y=0, width=2, height=2))


@pytest.mark.parametrize("failure", ["missing-channel-zero", "oversized-chunk"])
def test_malformed_ims_fails_during_inspection_without_reading_plane(
    tmp_path: Path, failure: str
) -> None:
    path = tmp_path / f"{failure}.ims"
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = "ImarisDataSet"
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        channel_index = 1 if failure == "missing-channel-zero" else 0
        channel = timepoint.create_group(f"Channel {channel_index}")
        if failure == "oversized-chunk":
            channel.create_dataset(
                "Data",
                shape=(1, 8193, 8193),
                dtype=np.uint8,
                chunks=(1, 8193, 8193),
                compression="gzip",
                fillvalue=0,
            )
        else:
            channel.create_dataset("Data", data=np.zeros((1, 2, 2), dtype=np.uint8))

    expected = "indices are not contiguous" if failure == "missing-channel-zero" else "64 MiB"
    with pytest.raises(NativeImageError, match=expected):
        inspect_native(path)


@pytest.mark.parametrize("external_kind", ["storage", "link"])
def test_ims_external_pixels_are_rejected(tmp_path: Path, external_kind: str) -> None:
    path = tmp_path / f"external-{external_kind}.ims"
    dependency = tmp_path / f"external-{external_kind}.h5"
    if external_kind == "link":
        with h5py.File(dependency, "w") as backing:
            channel = backing.create_group("channel")
            channel.create_dataset("Data", data=np.zeros((1, 2, 2), dtype=np.uint8))
        with h5py.File(path, "w") as ims:
            ims.attrs["ImarisDataSet"] = "ImarisDataSet"
            timepoint = (
                ims.create_group("DataSet")
                .create_group("ResolutionLevel 0")
                .create_group("TimePoint 0")
            )
            timepoint["Channel 0"] = h5py.ExternalLink(dependency.name, "/channel")
    else:
        dependency.write_bytes(b"\x00\x01\x02\x03")
        with h5py.File(path, "w") as ims:
            ims.attrs["ImarisDataSet"] = "ImarisDataSet"
            channel = (
                ims.create_group("DataSet")
                .create_group("ResolutionLevel 0")
                .create_group("TimePoint 0")
                .create_group("Channel 0")
            )
            channel.create_dataset(
                "Data",
                shape=(1, 2, 2),
                dtype=np.uint8,
                external=[(dependency.name, 0, 4)],
            )

    with pytest.raises(NativeImageError, match="outside the source fingerprint"):
        inspect_native(path)


def test_unsupported_axes_and_nonfinite_native_values_fail_closed(tmp_path: Path) -> None:
    unsupported = tmp_path / "unknown-axis.tif"
    tifffile.imwrite(
        unsupported,
        np.zeros((2, 4, 5), dtype=np.uint8),
        photometric="minisblack",
        metadata={"axes": "QYX"},
    )
    with pytest.raises(NativeImageError, match="unsupported axis labels Q"):
        inspect_native(unsupported)

    nonfinite = tmp_path / "nonfinite.tif"
    values = np.ones((16, 16), dtype=np.float32)
    values[5, 7] = np.nan
    tifffile.imwrite(nonfinite, values, tile=(16, 16), compression="deflate")
    with pytest.raises(NativeImageError, match="non-finite"):
        read_native_region(nonfinite, NativeSelection(x=6, y=4, width=3, height=3))


def test_expected_fingerprint_rejects_changed_source(tmp_path: Path) -> None:
    path = tmp_path / "fingerprint.png"
    Image.fromarray(np.zeros((4, 4), dtype=np.uint8)).save(path)
    fingerprint = inspect_native(path).sha256
    Image.fromarray(np.ones((4, 4), dtype=np.uint8)).save(path)

    with pytest.raises(NativeSourceChangedError, match="expected full SHA-256"):
        read_native_region(
            path,
            NativeSelection(
                x=0,
                y=0,
                width=2,
                height=2,
                expected_sha256=fingerprint,
            ),
        )


def test_session_hashes_once_and_reuses_inspection_for_repeated_planes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "session.ims"
    stored = _write_ims(path)
    real_sha256 = native_module._sha256
    calls = 0

    def counted_sha256(source: Path) -> str:
        nonlocal calls
        calls += 1
        return real_sha256(source)

    monkeypatch.setattr(native_module, "_sha256", counted_sha256)
    with NativeImageSession(path) as session:
        assert calls == 1
        first = session.read_region(NativeSelection(x=1, y=1, width=3, height=2, t=0, c=0, z=0))
        second = session.read_region(NativeSelection(x=2, y=2, width=4, height=3, t=1, c=1, z=2))
        assert calls == 1
        receipt = session.verify_strict()
        assert calls == 2

    np.testing.assert_array_equal(first.pixels, stored[0, 0, 0][0, 1:3, 1:4])
    np.testing.assert_array_equal(second.pixels, stored[0, 1, 1][2, 2:5, 2:6])
    assert first.integrity_mode == "stat-verified-session"
    assert second.integrity_mode == "stat-verified-session"
    assert receipt.integrity_mode == "full-sha256"
    assert receipt.sha256 == first.sha256


@pytest.mark.parametrize("mutation", ["edit", "replacement", "symlink-retarget"])
def test_session_rejects_source_identity_changes(tmp_path: Path, mutation: str) -> None:
    first_path = tmp_path / "first.png"
    second_path = tmp_path / "second.png"
    Image.fromarray(np.zeros((8, 8), dtype=np.uint8)).save(first_path)
    Image.fromarray(np.ones((8, 8), dtype=np.uint8)).save(second_path)
    selected = first_path
    if mutation == "symlink-retarget":
        selected = tmp_path / "selected.png"
        selected.symlink_to(first_path)
    session = NativeImageSession(selected)

    if mutation == "edit":
        Image.fromarray(np.full((8, 8), 2, dtype=np.uint8)).save(first_path)
    elif mutation == "replacement":
        second_path.replace(first_path)
    else:
        selected.unlink()
        selected.symlink_to(second_path)

    with pytest.raises(NativeSourceChangedError, match="source|symlink"):
        session.read_region(NativeSelection(x=0, y=0, width=2, height=2))


def test_session_strict_verification_detects_bytes_even_if_stat_identity_is_rebased(
    tmp_path: Path,
) -> None:
    path = tmp_path / "strict.png"
    Image.fromarray(np.zeros((8, 8), dtype=np.uint8)).save(path)
    session = NativeImageSession(path)
    Image.fromarray(np.ones((8, 8), dtype=np.uint8)).save(path)

    # Model a filesystem whose stat metadata was accepted by a later caller.
    # The explicit strict boundary still compares the actual bytes with the
    # full SHA-256 captured when this session opened.
    session._identity = native_module._file_identity(path)

    with pytest.raises(NativeSourceChangedError, match="bytes differ"):
        session.verify_strict()
