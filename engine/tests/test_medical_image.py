from __future__ import annotations

import math
import struct
from pathlib import Path

import numpy as np
import pytest
import SimpleITK as sitk

from loci_engine.medical_image import (
    MedicalImageError,
    enumerate_dicom_series,
    export_medical,
    inspect_medical,
    read_medical,
)
from loci_engine.quantitative import Geometry

CT_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
MR_STORAGE = "1.2.840.10008.5.1.4.1.1.4"
SECONDARY_CAPTURE = "1.2.840.10008.5.1.4.1.1.7"


def _oblique_lps_geometry() -> Geometry:
    angle = math.radians(23)
    cosine, sine = math.cos(angle), math.sin(angle)
    return Geometry(
        "ZYX",
        (
            (cosine * 0.7, -sine * 1.3, 0.0, 10.0),
            (sine * 0.7, cosine * 1.3, 0.0, 20.0),
            (0.0, 0.0, 2.5, 30.0),
            (0.0, 0.0, 0.0, 1.0),
        ),
        unit="mm",
        frame="LPS",
    )


def _write_sitk_volume(path: Path, array: np.ndarray, geometry: Geometry) -> None:
    matrix = np.asarray(geometry.affine)
    spacing = np.linalg.norm(matrix[:3, :3], axis=0)
    direction = matrix[:3, :3] / spacing
    image = sitk.GetImageFromArray(array)
    image.SetSpacing(tuple(spacing))
    image.SetDirection(tuple(direction.ravel()))
    image.SetOrigin(tuple(matrix[:3, 3]))
    sitk.WriteImage(image, str(path), path.name.endswith(".gz"))
    if path.suffix.lower() in {".nrrd", ".nhdr"}:
        content = path.read_bytes()
        units = b'space units: "mm" "mm" "mm"\n'
        if path.suffix.lower() == ".nhdr":
            path.write_bytes(content + units)
        else:
            path.write_bytes(content.replace(b"\n\n", b"\n" + units + b"\n", 1))


def _write_minimal_nifti(
    path: Path,
    *,
    spatial_units: int,
    qform_code: int = 0,
    sform_code: int = 1,
) -> None:
    angle = math.radians(30)
    cosine, sine = math.cos(angle), math.sin(angle)
    spacing = (0.7, 0.8, 1.2)
    origin = (10.0, 20.0, 30.0)
    header = bytearray(348)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, 2, 3, 4, 1, 1, 1, 1)
    struct.pack_into("<h", header, 70, 16)
    struct.pack_into("<h", header, 72, 32)
    struct.pack_into("<8f", header, 76, 1.0, *spacing, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", header, 108, 352.0)
    header[123] = spatial_units
    struct.pack_into("<h", header, 252, qform_code)
    struct.pack_into("<h", header, 254, sform_code)
    struct.pack_into("<4f", header, 280, cosine * spacing[0], -sine * spacing[1], 0.0, origin[0])
    struct.pack_into("<4f", header, 296, sine * spacing[0], cosine * spacing[1], 0.0, origin[1])
    struct.pack_into("<4f", header, 312, 0.0, 0.0, spacing[2], origin[2])
    header[344:348] = b"n+1\0"
    values = np.arange(24, dtype="<f4")
    path.write_bytes(header + b"\0\0\0\0" + values.tobytes())


def _uid(kind: int, value: int) -> str:
    return f"1.2.826.0.1.3680043.10.543.{kind}.{value}"


def _write_dicom_series(
    root: Path,
    *,
    name: str = "series",
    modality: str = "CT",
    sop_class: str = CT_STORAGE,
    series_number: int = 1,
    same_sop_uid: bool = False,
    duplicate_position: bool = False,
) -> tuple[tuple[Path, ...], np.ndarray, np.ndarray]:
    folder = root / name
    folder.mkdir()
    angle = math.radians(29)
    direction_x = np.array([math.cos(angle), math.sin(angle), 0.0])
    direction_y = np.array([-math.sin(angle), math.cos(angle), 0.0])
    direction_z = np.cross(direction_x, direction_y)
    orientation = "\\".join(str(value) for value in (*direction_x, *direction_y))
    origin = np.array([12.0, -8.0, 30.0])
    volume = np.empty((3, 4, 5), dtype=np.int16)
    paths: list[Path] = []
    for z_index in range(3):
        # Values are aligned to the declared slope/intercept and represent the
        # modality values returned after GDCM applies DICOM rescale.
        pixels = -1024 + 2 * np.arange(20, dtype=np.int16).reshape(4, 5) + np.int16(z_index * 200)
        volume[z_index] = pixels
        image = sitk.GetImageFromArray(pixels)
        image.SetSpacing((0.7, 1.3))
        position_index = 0 if duplicate_position and z_index == 1 else z_index
        position = origin + direction_z * position_index * 2.5
        tags = {
            "0008|0016": sop_class,
            "0008|0018": _uid(1, 1 if same_sop_uid else z_index + 1),
            "0008|0060": modality,
            "0010|0010": "SENSITIVE^SYNTHETIC",
            "0020|000e": _uid(2, series_number),
            "0020|0032": "\\".join(str(value) for value in position),
            "0020|0037": orientation,
            "0020|0052": _uid(3, series_number),
            "0028|0002": "1",
            "0028|0004": "MONOCHROME2",
            "0028|0030": "1.3\\0.7",
            "0028|1052": "-1024",
            "0028|1053": "2",
        }
        for key, value in tags.items():
            image.SetMetaData(key, value)
        path = folder / f"slice-{z_index}.dcm"
        writer = sitk.ImageFileWriter()
        writer.SetFileName(str(path))
        writer.KeepOriginalImageUIDOn()
        writer.Execute(image)
        paths.append(path)
    return tuple(paths), volume, np.column_stack((direction_x, direction_y, direction_z))


@pytest.mark.parametrize("extension", [".nii", ".nii.gz", ".nrrd"])
def test_real_volume_roundtrip_preserves_oblique_anisotropic_geometry_and_region(
    tmp_path: Path, extension: str
) -> None:
    array = np.arange(4 * 5 * 6, dtype=np.float32).reshape(4, 5, 6)
    geometry = _oblique_lps_geometry()
    source = tmp_path / f"volume{extension}"
    _write_sitk_volume(source, array, geometry)

    inspection = inspect_medical(source)
    assert inspection.format == ("nifti" if extension.startswith(".nii") else "nrrd")
    assert inspection.shape == array.shape
    assert inspection.dtype == "float32"
    assert inspection.geometry.axes == "ZYX"
    assert inspection.geometry.frame == "LPS"
    assert inspection.geometry.unit == "mm"
    assert inspection.runtime_identity == (
        f"SimpleITK/{sitk.Version_VersionString()} ITK/{sitk.Version_ITKVersionString()}"
    )
    assert np.allclose(inspection.geometry.affine, geometry.affine, atol=1e-5)
    assert str(source) not in str(inspection.to_dict())

    region = (slice(1, 4), slice(2, 5), slice(1, 5))
    result = read_medical(source, region=region, expected_identity=inspection)
    assert np.array_equal(result.array, array[region])
    expected_origin = geometry.world(np.array([[1, 2, 1]], dtype=np.float64))[0]
    assert np.allclose(np.asarray(result.geometry.affine)[:3, 3], expected_origin, atol=1e-5)


@pytest.mark.parametrize(
    ("spatial_units", "millimetre_factor"),
    [(1, 1000.0), (2, 1.0), (3, 0.001)],
)
def test_nifti_spatial_units_are_explicitly_normalized_to_millimetres(
    tmp_path: Path, spatial_units: int, millimetre_factor: float
) -> None:
    source = tmp_path / f"units-{spatial_units}.nii"
    _write_minimal_nifti(source, spatial_units=spatial_units)

    inspection = inspect_medical(source)

    angle = math.radians(30)
    cosine, sine = math.cos(angle), math.sin(angle)
    expected = millimetre_factor * np.asarray(
        [
            [-cosine * 0.7, sine * 0.8, 0.0, -10.0],
            [-sine * 0.7, -cosine * 0.8, 0.0, -20.0],
            [0.0, 0.0, 1.2, 30.0],
        ]
    )
    assert inspection.geometry.unit == "mm"
    assert inspection.geometry.frame == "LPS"
    # The source affine is stored as float32. Bound the header quantization in
    # its declared unit, then convert that same absolute tolerance to mm.
    np.testing.assert_allclose(
        np.asarray(inspection.geometry.affine)[:3],
        expected,
        atol=1e-7 * millimetre_factor,
        rtol=0,
    )


@pytest.mark.parametrize("spatial_units", [0, 4, 7])
def test_nifti_unknown_or_unsupported_spatial_units_are_rejected(
    tmp_path: Path, spatial_units: int
) -> None:
    source = tmp_path / f"unsupported-units-{spatial_units}.nii"
    _write_minimal_nifti(source, spatial_units=spatial_units)

    with pytest.raises(MedicalImageError, match="spatial units must explicitly"):
        inspect_medical(source)


def test_nifti_without_qform_or_sform_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "unknown-transform.nii"
    _write_minimal_nifti(source, spatial_units=2, qform_code=0, sform_code=0)

    with pytest.raises(MedicalImageError, match="qform or sform anatomical transform"):
        inspect_medical(source)


def test_export_converts_ras_to_lps_without_flipping_landmark_data(tmp_path: Path) -> None:
    array = np.zeros((3, 4, 5), dtype=np.float32)
    array[1, 2, 4] = 17.0
    ras = Geometry(
        "ZYX",
        ((0.8, 0.0, 0.0, 40.0), (0.0, 1.1, 0.0, -20.0), (0.0, 0.0, 2.4, 10.0), (0, 0, 0, 1)),
        unit="mm",
        frame="RAS",
    )
    destination = tmp_path / "ras-landmark.nii.gz"

    written = export_medical(destination, array, ras)
    reopened = read_medical(destination, expected_identity=written)

    assert np.array_equal(reopened.array, array)
    expected_lps = np.diag([-1.0, -1.0, 1.0, 1.0]) @ np.asarray(ras.affine)
    assert np.allclose(reopened.geometry.affine, expected_lps, atol=1e-5)
    ras_world = ras.world(np.array([[1, 2, 4]], dtype=np.float64))[0]
    assert np.allclose(
        reopened.geometry.world(np.array([[1, 2, 4]], dtype=np.float64))[0],
        [-ras_world[0], -ras_world[1], ras_world[2]],
        atol=1e-5,
    )


@pytest.mark.parametrize("extension", [".nii.gz", ".nrrd"])
def test_unsigned_label_export_preserves_ids_and_rejects_signed_labels(
    tmp_path: Path, extension: str
) -> None:
    labels = np.zeros((3, 4, 5), dtype=np.uint16)
    labels[1:, 1:3, 2:4] = 513
    geometry = _oblique_lps_geometry()
    destination = tmp_path / f"labels{extension}"

    inspection = export_medical(destination, labels, geometry, labels=True)
    result = read_medical(destination, expected_identity=inspection)
    assert result.array.dtype == np.uint16
    assert np.array_equal(result.array, labels)
    if extension == ".nrrd":
        assert b'space units: "mm" "mm" "mm"' in destination.read_bytes()[:2048]

    with pytest.raises(MedicalImageError, match="uint8, uint16, or uint32"):
        export_medical(
            tmp_path / f"signed{extension}", labels.astype(np.int16), geometry, labels=True
        )


def test_compressed_read_guards_full_decode_but_uncompressed_can_read_region(
    tmp_path: Path,
) -> None:
    array = np.arange(120, dtype=np.float32).reshape(4, 5, 6)
    geometry = _oblique_lps_geometry()
    compressed = tmp_path / "volume.nii.gz"
    uncompressed = tmp_path / "volume.nii"
    _write_sitk_volume(compressed, array, geometry)
    _write_sitk_volume(uncompressed, array, geometry)
    one_voxel = (slice(0, 1), slice(0, 1), slice(0, 1))

    with pytest.raises(MedicalImageError, match="whole compressed/series source"):
        read_medical(compressed, region=one_voxel, max_decoded_bytes=4)
    result = read_medical(uncompressed, region=one_voxel, max_decoded_bytes=4)
    assert result.array.shape == (1, 1, 1)
    assert result.array.item() == 0


def test_nonfinite_source_and_nrrd_traversal_are_rejected(tmp_path: Path) -> None:
    array = np.ones((2, 3, 4), dtype=np.float32)
    array[0, 0, 0] = np.nan
    nonfinite = tmp_path / "nonfinite.nrrd"
    header = (
        "NRRD0005\n"
        "type: float\n"
        "dimension: 3\n"
        "sizes: 4 3 2\n"
        "space: left-posterior-superior\n"
        'space units: "mm" "mm" "mm"\n'
        "space directions: (1,0,0) (0,1,0) (0,0,1)\n"
        "space origin: (0,0,0)\n"
        "endian: little\n"
        "encoding: raw\n\n"
    ).encode("ascii")
    nonfinite.write_bytes(header + array.astype("<f4").tobytes())
    with pytest.raises(MedicalImageError, match="Non-finite"):
        read_medical(nonfinite)

    outside = tmp_path / "outside.raw"
    outside.write_bytes(bytes(8))
    folder = tmp_path / "selected"
    folder.mkdir()
    traversal = folder / "traversal.nhdr"
    traversal.write_text(
        "NRRD0005\n"
        "type: uint8\n"
        "dimension: 3\n"
        "sizes: 2 2 2\n"
        "encoding: raw\n"
        "data file: ../outside.raw\n\n",
        encoding="ascii",
    )
    with pytest.raises(MedicalImageError, match="parent-traversal"):
        inspect_medical(traversal)

    wrong_units = tmp_path / "micrometres.nrrd"
    wrong_units.write_bytes(
        (
            "NRRD0005\n"
            "type: uint8\n"
            "dimension: 3\n"
            "sizes: 2 2 2\n"
            "space: left-posterior-superior\n"
            'space units: "um" "um" "um"\n'
            "space directions: (1,0,0) (0,1,0) (0,0,1)\n"
            "space origin: (0,0,0)\n"
            "encoding: raw\n\n"
        ).encode("ascii")
        + bytes(8)
    )
    with pytest.raises(MedicalImageError, match="millimetre"):
        inspect_medical(wrong_units)

    missing_units = tmp_path / "missing-units.nrrd"
    missing_units.write_bytes(
        wrong_units.read_bytes().replace(b'space units: "um" "um" "um"\n', b"")
    )
    with pytest.raises(MedicalImageError, match="explicit millimetre"):
        inspect_medical(missing_units)


def test_contained_detached_nrrd_is_read_and_both_files_are_identity_bound(
    tmp_path: Path,
) -> None:
    array = np.arange(24, dtype=np.uint16).reshape(2, 3, 4)
    header = tmp_path / "contained.nhdr"
    _write_sitk_volume(header, array, _oblique_lps_geometry())

    inspection = inspect_medical(header)
    assert inspection.file_count == 2
    result = read_medical(header, expected_identity=inspection)
    assert np.array_equal(result.array, array)


@pytest.mark.parametrize(("modality", "sop_class"), [("CT", CT_STORAGE), ("MR", MR_STORAGE)])
def test_dicom_series_rescale_oblique_geometry_discovery_and_redaction(
    tmp_path: Path, modality: str, sop_class: str
) -> None:
    paths, expected, directions = _write_dicom_series(
        tmp_path, modality=modality, sop_class=sop_class
    )

    discovered = enumerate_dicom_series(paths[0].parent)
    assert len(discovered) == 1
    assert discovered[0].supported
    summary_text = str(discovered[0].to_dict())
    assert "SENSITIVE" not in summary_text
    assert "1.2.826" not in summary_text
    assert str(paths[0]) not in summary_text

    inspection = inspect_medical(tuple(reversed(paths)))
    assert inspection.format == "dicom-series"
    assert inspection.dtype == "float64"
    assert inspection.shape == expected.shape
    assert inspection.series == {
        "modality": modality,
        "slice_count": 3,
        "photometric_interpretation": "MONOCHROME2",
        "rescale_slope": 2.0,
        "rescale_intercept": -1024.0,
        "rescale_applied": True,
        "output_dtype": "float64",
    }
    assert "SENSITIVE" not in str(inspection.to_dict())
    assert "1.2.826" not in str(inspection.to_dict())
    assert np.allclose(np.asarray(inspection.geometry.affine)[:3, :3], directions * [0.7, 1.3, 2.5])

    result = read_medical(tuple(reversed(paths)), expected_identity=inspection)
    assert result.array.dtype == np.float64
    assert np.array_equal(result.array, expected.astype(np.float64))
    assert np.allclose(result.geometry.affine, inspection.geometry.affine, atol=1e-6)


def test_dicom_series_rejects_duplicate_mixed_and_unsupported_inputs(tmp_path: Path) -> None:
    paths, _, _ = _write_dicom_series(tmp_path, name="valid")
    with pytest.raises(MedicalImageError, match="duplicate files"):
        inspect_medical((paths[0], paths[0]))

    duplicate_sop, _, _ = _write_dicom_series(
        tmp_path, name="duplicate-sop", series_number=2, same_sop_uid=True
    )
    with pytest.raises(MedicalImageError, match="duplicate SOP instances"):
        inspect_medical(duplicate_sop)

    second_series, _, _ = _write_dicom_series(tmp_path, name="other", series_number=3)
    with pytest.raises(MedicalImageError, match="mixed Series Instance UIDs"):
        inspect_medical((paths[0], second_series[1]))

    unsupported, _, _ = _write_dicom_series(
        tmp_path,
        name="unsupported",
        sop_class=SECONDARY_CAPTURE,
        series_number=4,
    )
    with pytest.raises(MedicalImageError, match="Only conventional CT Image Storage"):
        inspect_medical(unsupported)

    duplicate_position, _, _ = _write_dicom_series(
        tmp_path, name="duplicate-position", series_number=5, duplicate_position=True
    )
    with pytest.raises(MedicalImageError, match="duplicate slice positions"):
        inspect_medical(duplicate_position)


def test_identity_change_is_refused_before_decode(tmp_path: Path) -> None:
    array = np.arange(24, dtype=np.float32).reshape(2, 3, 4)
    source = tmp_path / "identity.nii"
    _write_sitk_volume(source, array, _oblique_lps_geometry())
    inspection = inspect_medical(source)
    changed = array.copy()
    changed[0, 0, 0] = 99
    _write_sitk_volume(source, changed, _oblique_lps_geometry())

    with pytest.raises(MedicalImageError, match="identity no longer matches"):
        read_medical(source, expected_identity=inspection)
