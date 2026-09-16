from __future__ import annotations

import json
import os
from pathlib import Path

import h5py
import numpy as np
import pytest

from loci_engine.io import UnsupportedImageError, load_image
from loci_engine.worker import handle_request


def _chars(value: str) -> np.ndarray:
    return np.asarray(list(value), dtype="S1")


def _utf8_chars(value: str) -> np.ndarray:
    return np.frombuffer(value.encode("utf-8"), dtype="S1")


def _write_channel(
    timepoint: h5py.Group,
    index: int,
    data: np.ndarray | None,
    *,
    shape: tuple[int, int, int],
    declared: tuple[int, int, int],
    dtype: type[np.generic] = np.uint8,
    histogram_max: int = 255,
) -> None:
    channel = timepoint.create_group(f"Channel {index}")
    depth, height, width = declared
    channel.attrs["ImageSizeX"] = _chars(str(width))
    channel.attrs["ImageSizeY"] = _chars(str(height))
    channel.attrs["ImageSizeZ"] = _chars(str(depth))
    channel.attrs["HistogramMin"] = _chars("0.000")
    channel.attrs["HistogramMax"] = _chars(f"{histogram_max}.000")
    if data is None:
        channel.create_dataset(
            "Data",
            shape=shape,
            dtype=dtype,
            chunks=(1, 64, 64),
            compression="gzip",
            fillvalue=0,
        )
    else:
        channel.create_dataset("Data", data=data, compression="gzip")


def _write_modern_ims(path: Path) -> tuple[np.ndarray, np.ndarray]:
    green = np.zeros((2, 6, 8), dtype=np.uint16)
    magenta = np.zeros((2, 6, 8), dtype=np.uint16)
    green[1, 1:5, 1:4] = 65_535
    magenta[1, 2:5, 4:7] = 32_768

    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        ims.attrs["ImarisVersion"] = _chars("5.5.0")
        dataset = ims.create_group("DataSet")

        full = dataset.create_group("ResolutionLevel 0")
        full_time = full.create_group("TimePoint 0")
        for channel in range(2):
            _write_channel(
                full_time,
                channel,
                None,
                shape=(3, 2304, 2304),
                declared=(3, 2304, 2304),
                dtype=np.uint16,
                histogram_max=65_535,
            )
        second_time = full.create_group("TimePoint 1")
        for channel in range(2):
            _write_channel(
                second_time,
                channel,
                None,
                shape=(3, 2304, 2304),
                declared=(3, 2304, 2304),
                dtype=np.uint16,
                histogram_max=65_535,
            )

        overview = dataset.create_group("ResolutionLevel 1")
        overview_time = overview.create_group("TimePoint 0")
        _write_channel(
            overview_time,
            0,
            green,
            shape=green.shape,
            declared=(2, 6, 8),
            histogram_max=65_535,
        )
        _write_channel(
            overview_time,
            1,
            magenta,
            shape=magenta.shape,
            declared=(2, 6, 8),
            histogram_max=65_535,
        )

        info = ims.create_group("DataSetInfo")
        image_info = info.create_group("Image")
        for name, value in {
            "ExtMin0": "10.0",
            "ExtMax0": "240.4",
            "ExtMin1": "20.0",
            "ExtMax1": "135.2",
            "ExtMin2": "-2.0",
            "ExtMax2": "4.0",
            "Unit": "µm",
        }.items():
            image_info.attrs[name] = _utf8_chars(value)
        green_info = info.create_group("Channel 0")
        green_info.attrs["Name"] = _chars("Autofluorescence")
        green_info.attrs["Color"] = _chars("0.000 1.000 0.000")
        magenta_info = info.create_group("Channel 1")
        magenta_info.attrs["Name"] = _utf8_chars("Nuclear counterstain µ")
        magenta_info.attrs["Color"] = _chars("1.000 0.000 1.000")
    return green[1], magenta[1]


def test_loads_bounded_modern_ims_overview_with_truthful_volume_metadata(
    tmp_path: Path,
) -> None:
    path = tmp_path / "synthetic.ims"
    green, magenta = _write_modern_ims(path)
    original = path.read_bytes()

    image, metadata = load_image(path)

    assert path.read_bytes() == original
    assert image.shape == (6, 8, 3)
    assert image.dtype == np.uint8
    expected_green = np.asarray(np.rint(green / 65_535 * 255), dtype=np.uint8)
    expected_magenta = np.asarray(np.rint(magenta / 65_535 * 255), dtype=np.uint8)
    np.testing.assert_array_equal(image[..., 0], expected_magenta)
    np.testing.assert_array_equal(image[..., 1], expected_green)
    np.testing.assert_array_equal(image[..., 2], expected_magenta)
    assert metadata.format == "IMS"
    assert metadata.width == 2304
    assert metadata.height == 2304
    assert metadata.channels == 2
    assert metadata.dtype == "uint16"
    assert metadata.color_model == "channel-composite"
    assert metadata.access_mode == "overview"
    assert metadata.view_only_reason is not None
    assert metadata.source_details is not None
    details = metadata.source_details
    assert details["kind"] == "ims-volume"
    assert (details["width"], details["height"], details["depth"]) == (
        2304,
        2304,
        3,
    )
    assert details["timepoints"] == 2
    assert details["resolution_levels"] == 2
    assert details["selected_resolution_level"] == 1
    assert details["selected_level_depth"] == 2
    assert details["selected_z"] == 1
    assert details["sampling_stride"] == 1
    assert details["channel_names"] == ("Autofluorescence", "Nuclear counterstain µ")
    assert details["channel_dtypes"] == ("uint16", "uint16")
    assert details["channel_color_sources"] == (
        "declared-base-colour",
        "declared-base-colour",
    )
    assert details["channel_range_sources"] == (
        "stored-histogram-range",
        "stored-histogram-range",
    )
    assert details["composite_mode"] == "loci-overview-composite"
    assert details["rendered_dtype"] == "uint8"
    assert details["physical_extents"] == ((10.0, 240.4), (20.0, 135.2), (-2.0, 4.0))
    np.testing.assert_allclose(details["voxel_size"], (0.1, 0.05, 2.0))
    assert details["physical_unit"] == "µm"


def test_inspect_exposes_ims_overview_capability_without_enabling_analysis(
    tmp_path: Path,
) -> None:
    path = tmp_path / "synthetic.ims"
    _write_modern_ims(path)

    inspected = handle_request(
        {"id": "inspect", "method": "inspect", "params": {"path": str(path), "max_edge": 64}}
    )

    assert "error" not in inspected
    result = inspected["result"]
    assert result["source"]["access_mode"] == "overview"
    assert result["source"]["source_details"]["selected_resolution_level"] == 1
    assert str(result["preview_data_url"]).startswith("data:image/png;base64,")
    assert sum(result["display_statistics"]["histogram_bins"]) > 0

    segmented = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {
                "path": str(path),
                "profile_id": "loci-classical",
                "settings": {},
            },
        }
    )
    assert segmented["error"]["type"] == "ValueError"
    assert "pyramid overview" in segmented["error"]["message"]
    assert "analysis" in segmented["error"]["message"]

    directory_stat = os.stat(tmp_path)
    exported = handle_request(
        {
            "id": "export",
            "method": "export_view",
            "params": {
                "path": str(path),
                "directory": str(tmp_path),
                "directory_identity": {
                    "device": str(directory_stat.st_dev),
                    "inode": str(directory_stat.st_ino),
                },
                "filename": "overview.png",
                "format": "png",
                "settings": {},
            },
        }
    )
    assert exported["error"]["type"] == "ValueError"
    assert "rendered export" in exported["error"]["message"]
    assert not (tmp_path / "overview.png").exists()


def test_single_channel_ims_is_identified_as_native_intensity(
    tmp_path: Path,
) -> None:
    path = tmp_path / "single-channel.ims"
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        _write_channel(
            timepoint,
            0,
            np.arange(6, dtype=np.uint16).reshape(1, 2, 3),
            shape=(1, 2, 3),
            declared=(1, 2, 3),
            histogram_max=5,
        )

    image, metadata = load_image(path)

    assert image.shape == (2, 3)
    assert metadata.channels == 1
    assert metadata.color_model == "intensity"
    assert metadata.source_details is not None
    assert metadata.source_details["composite_mode"] == "single-channel"


def test_rejects_non_hdf5_or_unmarked_ims_containers(tmp_path: Path) -> None:
    plain = tmp_path / "plain.ims"
    plain.write_bytes(b"not an HDF5 file")
    try:
        load_image(plain)
    except UnsupportedImageError as exc:
        assert "not a modern HDF5-backed Imaris 5.5+ dataset" in str(exc)
    else:
        raise AssertionError("A non-HDF5 .ims file was accepted")

    unmarked = tmp_path / "unmarked.ims"
    with h5py.File(unmarked, "w") as hdf5:
        hdf5.create_group("DataSet")
    try:
        load_image(unmarked)
    except UnsupportedImageError as exc:
        assert "does not declare the modern Imaris dataset layout" in str(exc)
    else:
        raise AssertionError("An unmarked HDF5 file was accepted as IMS")


def test_does_not_infer_interleaved_rgb_from_three_channel_lut_colours(
    tmp_path: Path,
) -> None:
    path = tmp_path / "rgb.ims"
    components = [
        np.asarray([[[0, 50, 100], [150, 200, 250]]], dtype=np.uint8),
        np.asarray([[[10, 60, 110], [160, 210, 255]]], dtype=np.uint8),
        np.asarray([[[20, 70, 120], [170, 220, 240]]], dtype=np.uint8),
    ]
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        dataset = ims.create_group("DataSet")
        timepoint = dataset.create_group("ResolutionLevel 0").create_group("TimePoint 0")
        info = ims.create_group("DataSetInfo")
        for index, (component, color) in enumerate(
            zip(components, ("1 0 0", "0 1 0", "0 0 1"), strict=True)
        ):
            _write_channel(
                timepoint,
                index,
                component,
                shape=component.shape,
                declared=(1, 2, 3),
            )
            channel_info = info.create_group(f"Channel {index}")
            channel_info.attrs["Color"] = _chars(color)

    image, metadata = load_image(path)

    np.testing.assert_array_equal(
        image,
        np.stack([component[0] for component in components], axis=-1),
    )
    assert metadata.source_details is not None
    assert metadata.source_details["composite_mode"] == "loci-overview-composite"
    assert metadata.color_model == "channel-composite"


def test_multichannel_float64_ims_preserves_large_offset_dynamic_range(
    tmp_path: Path,
) -> None:
    path = tmp_path / "float64-offset.ims"
    base = 1e20
    plane = (base + np.linspace(0.0, 2e12, num=101, dtype=np.float64)).reshape(1, 1, 101)
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        for index in range(2):
            channel = timepoint.create_group(f"Channel {index}")
            channel.attrs["ImageSizeX"] = _chars("101")
            channel.attrs["ImageSizeY"] = _chars("1")
            channel.attrs["ImageSizeZ"] = _chars("1")
            channel.attrs["HistogramMin"] = _chars(str(base))
            channel.attrs["HistogramMax"] = _chars(str(base + 2e12))
            channel.create_dataset("Data", data=plane)

    image, _metadata = load_image(path)

    assert image[0, 0].max() == 0
    assert 150 <= image[0, 50].max() <= 170
    assert image[0, -1].max() == 255
    assert np.unique(image.max(axis=-1)).size > 80


def test_rejects_multichannel_ims_with_64_bit_integer_samples_before_read(
    tmp_path: Path,
) -> None:
    path = tmp_path / "uint64.ims"
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        for index in range(2):
            _write_channel(
                timepoint,
                index,
                np.array([[[9_000_000_000_000_000_000]]], dtype=np.uint64),
                shape=(1, 1, 1),
                declared=(1, 1, 1),
            )

    with pytest.raises(UnsupportedImageError, match="unsupported 64-bit integer samples"):
        load_image(path)


@pytest.mark.parametrize("gap_kind", ["resolution-level", "timepoint"])
def test_rejects_noncontiguous_ims_numbered_groups(
    tmp_path: Path,
    gap_kind: str,
) -> None:
    path = tmp_path / f"noncontiguous-{gap_kind}.ims"
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        dataset = ims.create_group("DataSet")
        level_indices = (0, 2) if gap_kind == "resolution-level" else (0,)
        for level_index in level_indices:
            level = dataset.create_group(f"ResolutionLevel {level_index}")
            timepoint_indices = (0, 2) if gap_kind == "timepoint" else (0,)
            for timepoint_index in timepoint_indices:
                timepoint = level.create_group(f"TimePoint {timepoint_index}")
                _write_channel(
                    timepoint,
                    0,
                    np.zeros((1, 1, 1), dtype=np.uint8),
                    shape=(1, 1, 1),
                    declared=(1, 1, 1),
                )

    expected = (
        "resolution-level indices are not contiguous"
        if gap_kind == "resolution-level"
        else "timepoint indices are not contiguous"
    )
    with pytest.raises(UnsupportedImageError, match=expected):
        load_image(path)


def test_extreme_ims_physical_metadata_is_omitted_without_invalid_json(
    tmp_path: Path,
) -> None:
    path = tmp_path / "extreme-physical-metadata.ims"
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        _write_channel(
            timepoint,
            0,
            np.zeros((1, 1, 1), dtype=np.uint8),
            shape=(1, 1, 1),
            declared=(1, 1, 1),
        )
        image_info = ims.create_group("DataSetInfo").create_group("Image")
        for axis in range(3):
            image_info.attrs[f"ExtMin{axis}"] = _chars("-1e308")
            image_info.attrs[f"ExtMax{axis}"] = _chars("1e308")
        image_info.attrs["Unit"] = _chars("um")

    inspected = handle_request(
        {"id": "inspect", "method": "inspect", "params": {"path": str(path), "max_edge": 64}}
    )

    assert "error" not in inspected
    details = inspected["result"]["source"]["source_details"]
    assert details["physical_extents"] is None
    assert details["voxel_size"] is None
    assert details["physical_unit"] is None
    json.dumps(inspected, allow_nan=False)


def _write_external_storage_ims(path: Path, raw_path: Path) -> None:
    raw_path.write_bytes(bytes((0, 64, 128, 255)))
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        channel = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
            .create_group("Channel 0")
        )
        channel.attrs["ImageSizeX"] = _chars("2")
        channel.attrs["ImageSizeY"] = _chars("2")
        channel.attrs["ImageSizeZ"] = _chars("1")
        channel.attrs["HistogramMin"] = _chars("0")
        channel.attrs["HistogramMax"] = _chars("255")
        channel.create_dataset(
            "Data",
            shape=(1, 2, 2),
            dtype=np.uint8,
            external=[(raw_path.name, 0, 4)],
        )


def _write_virtual_storage_ims(path: Path, backing_path: Path) -> None:
    with h5py.File(backing_path, "w") as backing:
        backing.create_dataset("pixels", data=np.arange(4, dtype=np.uint8).reshape(1, 2, 2))
    with h5py.File(path, "w", libver="latest") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        channel = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
            .create_group("Channel 0")
        )
        channel.attrs["ImageSizeX"] = _chars("2")
        channel.attrs["ImageSizeY"] = _chars("2")
        channel.attrs["ImageSizeZ"] = _chars("1")
        channel.attrs["HistogramMin"] = _chars("0")
        channel.attrs["HistogramMax"] = _chars("255")
        layout = h5py.VirtualLayout(shape=(1, 2, 2), dtype=np.uint8)
        layout[...] = h5py.VirtualSource(str(backing_path), "pixels", shape=(1, 2, 2))
        channel.create_virtual_dataset("Data", layout)


@pytest.mark.parametrize("dependency_kind", ["external-link", "external-storage", "virtual"])
def test_rejects_ims_pixels_outside_the_selected_source_fingerprint(
    tmp_path: Path,
    dependency_kind: str,
) -> None:
    path = tmp_path / f"{dependency_kind}.ims"
    dependency = tmp_path / f"{dependency_kind}.bin"

    if dependency_kind == "external-storage":
        _write_external_storage_ims(path, dependency)
    elif dependency_kind == "virtual":
        dependency = dependency.with_suffix(".h5")
        _write_virtual_storage_ims(path, dependency)
    else:
        dependency = dependency.with_suffix(".h5")
        with h5py.File(dependency, "w") as backing:
            channel = backing.create_group("channel")
            channel.attrs["ImageSizeX"] = _chars("2")
            channel.attrs["ImageSizeY"] = _chars("2")
            channel.attrs["ImageSizeZ"] = _chars("1")
            channel.attrs["HistogramMin"] = _chars("0")
            channel.attrs["HistogramMax"] = _chars("255")
            channel.create_dataset("Data", data=np.arange(4, dtype=np.uint8).reshape(1, 2, 2))
        with h5py.File(path, "w") as ims:
            ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
            timepoint = (
                ims.create_group("DataSet")
                .create_group("ResolutionLevel 0")
                .create_group("TimePoint 0")
            )
            timepoint["Channel 0"] = h5py.ExternalLink(dependency.name, "/channel")

    with pytest.raises(UnsupportedImageError, match="integrity fingerprint"):
        load_image(path)


def test_missing_ims_histograms_use_non_aliasing_bounded_ranges_and_record_fallbacks(
    tmp_path: Path,
) -> None:
    path = tmp_path / "missing-display-metadata.ims"
    rows, columns = np.indices((512, 2048))
    checkerboard = np.asarray((rows + columns) % 2 * 65_535, dtype=np.uint16)
    empty = np.zeros_like(checkerboard)

    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        for index, plane in enumerate((checkerboard, empty)):
            channel = timepoint.create_group(f"Channel {index}")
            channel.attrs["ImageSizeX"] = _chars("2048")
            channel.attrs["ImageSizeY"] = _chars("512")
            channel.attrs["ImageSizeZ"] = _chars("1")
            channel.create_dataset("Data", data=plane[np.newaxis, ...], compression="gzip")

    image, metadata = load_image(path)

    assert image.shape == (512, 2048, 3)
    assert np.any(image == 0)
    assert np.any(image > 0)
    assert metadata.source_details is not None
    assert metadata.source_details["channel_color_sources"] == (
        "loci-fallback-colour",
        "loci-fallback-colour",
    )
    assert metadata.source_details["channel_range_sources"] == (
        "bounded-sampled-display-range",
        "bounded-sampled-display-range",
    )


def test_rejects_ims_chunk_that_can_expand_beyond_the_pre_read_guard(tmp_path: Path) -> None:
    path = tmp_path / "oversized-chunk.ims"
    with h5py.File(path, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        channel = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
            .create_group("Channel 0")
        )
        channel.attrs["ImageSizeX"] = _chars("1")
        channel.attrs["ImageSizeY"] = _chars("1")
        channel.attrs["ImageSizeZ"] = _chars("1")
        channel.create_dataset(
            "Data",
            shape=(1, 8193, 8193),
            dtype=np.uint8,
            chunks=(1, 8193, 8193),
            compression="gzip",
            fillvalue=0,
        )

    with pytest.raises(UnsupportedImageError, match=r"decoded-chunk guard.*plane was not read"):
        load_image(path)
