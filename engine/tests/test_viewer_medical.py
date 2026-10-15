import base64
import hashlib
import math
import weakref
from dataclasses import replace

import numpy as np
import pytest
import SimpleITK as sitk

from loci_engine.medical_image import MedicalInspection, MedicalVolume
from loci_engine.native_image import NativeSelection
from loci_engine.quantitative import Geometry
from loci_engine.viewer_medical import MedicalViewerSession
from loci_engine.viewer_volume import ViewerVolumeError, build_medical_volume_payload


def _write_volume(path):
    values = np.arange(20 * 30 * 40, dtype=np.uint16).reshape(20, 30, 40)
    image = sitk.GetImageFromArray(values)
    angle = math.radians(20)
    cosine, sine = math.cos(angle), math.sin(angle)
    image.SetSpacing((0.4, 0.8, 2.5))
    image.SetOrigin((10.0, 20.0, 30.0))
    image.SetDirection((cosine, -sine, 0.0, sine, cosine, 0.0, 0.0, 0.0, 1.0))
    sitk.WriteImage(image, str(path), False)
    return values


def test_medical_viewer_session_matches_bounded_native_plane_protocol(tmp_path):
    path = tmp_path / "volume.nii"
    values = _write_volume(path)
    session = MedicalViewerSession(path)
    assert session.metadata.dimensions.z == 20
    region = session.read_region(
        NativeSelection(x=7, y=5, width=9, height=8, z=4, budget_bytes=1024 * 1024)
    )
    assert np.array_equal(region.pixels, values[4, 5:13, 7:16])
    assert region.pixels.flags.writeable is False
    geometry = session.geometry({"x": 7, "y": 5, "z": 4}, False)
    assert geometry.axes == "YX"
    assert geometry.frame == "LPS"
    assert session.verify_strict().source_identity.startswith("sha256:")


def test_medical_whole_extent_and_native_focus_share_renderer_contract(tmp_path):
    path = tmp_path / "volume.nii"
    _write_volume(path)
    session = MedicalViewerSession(path)
    result = build_medical_volume_payload(
        path,
        source_id="medical-1",
        expected_source_identity=session.inspection.source_identity,
        target_long_axis=16,
        max_decoded_bytes=1024 * 1024,
        focus_region_xyzxyz=[5, 14, 6, 13, 3, 8],
    )
    context = result["context"]
    assert context["role"] == "whole-volume-context"
    assert context["source_extent_xyzxyz"] == [0, 39, 0, 29, 0, 19]
    assert context["dimensions_xyz"] == [16, 12, 8]
    assert context["frame"] == "LPS"
    assert context["scalar_type"] == "uint16"
    assert context["components"][0]["provenance"]["range"] == "native-dtype-range"
    assert result["focus"]["role"] == "native-detail-focus"
    assert result["focus"]["dimensions_xyz"] == [10, 8, 6]
    assert context["sampling"]["estimated_aggregate_bytes"] == 120_000
    assert result["focus"]["sampling"]["estimated_aggregate_bytes"] == 120_000
    expected_geometry = np.asarray(session.geometry({"x": 5, "y": 6, "z": 3}, True).affine)
    assert result["focus"]["origin_xyz"] == pytest.approx(expected_geometry[:3, 3])


def test_medical_viewer_session_handles_a_2d_medical_source_without_inventing_z(tmp_path):
    path = tmp_path / "plane.nii"
    values = np.arange(8 * 9, dtype=np.uint16).reshape(8, 9)
    image = sitk.GetImageFromArray(values)
    image.SetSpacing((0.5, 0.75))
    image.SetOrigin((4.0, 7.0))
    sitk.WriteImage(image, str(path), False)
    session = MedicalViewerSession(path)
    assert session.metadata.dimensions.z == 1
    assert session.metadata.physical_calibration.axes == "YX"
    region = session.read_region(
        NativeSelection(x=2, y=3, width=4, height=3, z=0, budget_bytes=1024 * 1024)
    )
    assert np.array_equal(region.pixels, values[3:6, 2:6])
    assert session.geometry({"x": 2, "y": 3, "z": 0}, False).axes == "YX"
    with pytest.raises(ValueError, match="two-dimensional"):
        session.geometry({"x": 2, "y": 3, "z": 0}, True)


def _streamed_source(monkeypatch, shape_xyz):
    from loci_engine import medical_image

    shape = tuple(reversed(shape_xyz))
    inspection = MedicalInspection(
        format="nifti",
        shape=shape,
        dtype="float32",
        geometry=Geometry(
            "ZYX", ((0, -0.5, 0, 12), (0.5, 0, 0, -8), (0, 0, -2, 30), (0, 0, 0, 1)), "mm", "LPS"
        ),
        source_identity="sha256:" + "a" * 64,
        runtime_identity="synthetic-reader",
        file_count=1,
        encoded_bytes=math.prod(shape) * 4,
        estimated_decoded_bytes=math.prod(shape) * 4,
    )
    reads = []
    previous_allocation = []
    monkeypatch.setattr(medical_image, "inspect_medical", lambda source: inspection)
    monkeypatch.setattr(medical_image, "_safe_file", lambda source: source)
    monkeypatch.setattr(medical_image, "_file_plan", lambda source: ("nifti", (), False))

    def read(source, *, region=None, expected_identity=None, max_decoded_bytes):
        assert region is not None, "The whole source must never be decoded."
        assert expected_identity == inspection
        assert not previous_allocation or previous_allocation[-1]() is None
        z, y, x = region
        assert z.stop == z.start + 1
        yy, xx = np.mgrid[y.start : y.stop, x.start : x.stop]
        values = (z.start * 100 + yy * 2 - xx - 500).astype(np.float32)[None]
        previous_allocation.append(weakref.ref(values.base))
        assert values.nbytes <= max_decoded_bytes
        reads.append(region)
        return MedicalVolume(
            values,
            inspection.geometry,
            inspection.format,
            inspection.source_identity,
            inspection.runtime_identity,
        )

    monkeypatch.setattr(medical_image, "read_medical", read)
    return inspection, reads


@pytest.mark.parametrize("target", [128, 256])
def test_streamed_medical_fit_reserves_plane_and_preserves_signed_voxels(monkeypatch, target):
    inspection, reads = _streamed_source(monkeypatch, (70, 80, 90))
    original = inspection.to_dict()
    source_peak = 70 * 80 * (2 * 4 + 1)
    # The 48-axis grid alone fits; adding its mandatory source plane exceeds
    # this boundary by one byte. The next bounded grid is 40-axis.
    budget = math.ceil(37 * 43 * 48 * 4 * 13 / 3) + source_peak - 1
    context = build_medical_volume_payload(
        "synthetic",
        source_id="medical",
        target_long_axis=target,
        expected_source_identity=inspection.source_identity,
        max_decoded_bytes=budget,
    )["context"]
    assert context["dimensions_xyz"] == [31, 36, 40]
    assert context["refinement"]["available"] is False
    assert context["refinement"]["maximum_target_long_axis"] == 256
    assert context["sampling"]["estimated_aggregate_bytes"] == 773760 + source_peak
    assert context["sampling"]["estimated_aggregate_bytes"] <= budget
    xx, yy, zz = [np.asarray(axis) for axis in context["sampling"]["source_indices_xyz"]]
    raw = base64.b64decode(context["data_base64"])
    values = np.frombuffer(raw, dtype="<f4").reshape(40, 36, 31)
    expected = zz[:, None, None] * 100 + yy[None, :, None] * 2 - xx[None, None, :] - 500
    np.testing.assert_array_equal(values, expected.astype(np.float32))
    assert values.min() < 0
    assert context["data_sha256"] == hashlib.sha256(raw).hexdigest()
    assert context["source_sha256"] == "a" * 64
    assert context["frame"] == "LPS" and context["unit"] == "mm"
    assert context["source_dimensions_xyz"] == [70, 80, 90]
    affine = np.asarray(context["affine_4x4"])
    np.testing.assert_allclose(
        affine @ [30, 35, 39, 1], np.asarray(inspection.geometry.affine) @ [69, 79, 89, 1]
    )
    assert len(reads) == 40
    assert inspection.to_dict() == original


def test_medical_refinement_stops_at_budget_grid_instead_of_full_source(monkeypatch):
    _streamed_source(monkeypatch, (96, 96, 96))
    coarse = build_medical_volume_payload(
        "synthetic",
        source_id="medical",
        target_long_axis=16,
        max_decoded_bytes=1024**2,
    )["context"]
    finest = build_medical_volume_payload(
        "synthetic",
        source_id="medical",
        target_long_axis=256,
        max_decoded_bytes=1024**2,
    )["context"]
    assert coarse["dimensions_xyz"] == [16, 16, 16]
    assert coarse["refinement"]["available"] is True
    assert finest["dimensions_xyz"] == [32, 32, 32]
    assert finest["refinement"]["available"] is False


def test_medical_unfittable_source_plane_is_rejected_before_decode(monkeypatch):
    _, reads = _streamed_source(monkeypatch, (1024, 1024, 2))
    with pytest.raises(ViewerVolumeError, match="memory budget"):
        build_medical_volume_payload(
            "synthetic",
            source_id="medical",
            max_decoded_bytes=1024**2,
        )
    assert reads == []


def _eager_dicom_source(monkeypatch, shape_xyz):
    from loci_engine import medical_image

    native, _ = _streamed_source(monkeypatch, shape_xyz)
    inspection = replace(
        native,
        format="dicom-series",
        dtype="float64",
        estimated_decoded_bytes=math.prod(shape_xyz) * 8,
    )
    # A read-only broadcast keeps the default-budget regression lightweight
    # while exposing the exact full decoded allocation and signed source values.
    source_values = np.broadcast_to(
        (np.arange(inspection.shape[0], dtype=np.float64) - 20.25)[:, None, None],
        inspection.shape,
    )
    reads = []
    monkeypatch.setattr(medical_image, "inspect_medical", lambda source: inspection)

    def read(source, *, region=None, expected_identity=None, max_decoded_bytes):
        assert region is None, "DICOM must never be assigned a streaming read."
        assert expected_identity == inspection
        assert source_values.nbytes == max_decoded_bytes
        reads.append(region)
        return MedicalVolume(
            source_values,
            inspection.geometry,
            inspection.format,
            inspection.source_identity,
            inspection.runtime_identity,
        )

    monkeypatch.setattr(medical_image, "read_medical", read)
    return inspection, source_values, reads


@pytest.mark.parametrize(
    "source_long_axis,budget,coarse_target,maximum_axis",
    [(40, 1_150_000, 16, 32), (196, 128 * 1024**2, 128, 160)],
)
def test_dicom_refinement_fits_full_decode_instead_of_requesting_streaming(
    monkeypatch, source_long_axis, budget, coarse_target, maximum_axis
):
    inspection, source_values, reads = _eager_dicom_source(monkeypatch, (source_long_axis,) * 3)
    coarse = build_medical_volume_payload(
        "synthetic-dicom",
        source_id="medical",
        target_long_axis=coarse_target,
        max_decoded_bytes=budget,
    )["context"]
    assert coarse["dimensions_xyz"] == [coarse_target] * 3
    assert coarse["refinement"]["available"] is True
    finest = build_medical_volume_payload(
        "synthetic-dicom",
        source_id="medical",
        target_long_axis=256,
        max_decoded_bytes=budget,
    )["context"]
    assert finest["dimensions_xyz"] == [maximum_axis] * 3
    assert finest["refinement"]["available"] is False
    assert finest["refinement"]["maximum_target_long_axis"] == 256
    assert finest["sampling"]["estimated_aggregate_bytes"] == max(
        inspection.estimated_decoded_bytes + math.ceil(maximum_axis**3 * 4 * 13 / 3),
        2 * inspection.estimated_decoded_bytes + math.prod(inspection.shape),
    )
    assert finest["sampling"]["estimated_aggregate_bytes"] <= budget
    raw = base64.b64decode(finest["data_base64"])
    sampled = np.frombuffer(raw, dtype="<f4").reshape((maximum_axis,) * 3)
    xx, yy, zz = [np.asarray(axis) for axis in finest["sampling"]["source_indices_xyz"]]
    np.testing.assert_array_equal(sampled, source_values[np.ix_(zz, yy, xx)].astype(np.float32))
    assert finest["source_identity"] == inspection.source_identity
    assert source_values.flags.writeable is False
    assert reads == [None, None]


@pytest.mark.parametrize("source_axis,budget", [(40, 1024**2), (200, 128 * 1024**2)])
def test_dicom_decode_copy_peak_above_budget_is_rejected_before_read(
    monkeypatch, source_axis, budget
):
    _, _, reads = _eager_dicom_source(monkeypatch, (source_axis,) * 3)
    with pytest.raises(ViewerVolumeError, match="memory budget"):
        build_medical_volume_payload(
            "synthetic-dicom",
            source_id="medical",
            target_long_axis=16,
            max_decoded_bytes=budget,
        )
    assert reads == []


def test_streamed_read_copy_peak_is_reserved_without_retaining_previous_planes(monkeypatch):
    _streamed_source(monkeypatch, (380, 380, 1000))
    with pytest.raises(ViewerVolumeError, match="memory budget"):
        build_medical_volume_payload(
            "synthetic",
            source_id="medical",
            target_long_axis=256,
            max_decoded_bytes=1024**2,
        )


@pytest.mark.parametrize("suffix", ["nii.gz", "nrrd"])
def test_compressed_medical_copy_peak_is_refused_before_decode(tmp_path, monkeypatch, suffix):
    from loci_engine import medical_image

    source = tmp_path / ("compressed." + suffix)
    values = np.zeros((40, 40, 40), dtype=np.float64)
    sitk.WriteImage(sitk.GetImageFromArray(values), str(source), True)
    if suffix == "nrrd":
        content = source.read_bytes()
        source.write_bytes(content.replace(b"\n\n", b'\nspace units: "mm" "mm" "mm"\n\n', 1))
    reads = []

    def unexpected_decode(*args, **kwargs):
        reads.append(args)
        raise AssertionError("Unsafe compressed medical pixels must not be decoded.")

    monkeypatch.setattr(medical_image, "read_medical", unexpected_decode)
    with pytest.raises(ViewerVolumeError, match="memory budget"):
        build_medical_volume_payload(
            source,
            source_id="medical",
            target_long_axis=16,
            max_decoded_bytes=1024**2,
        )
    assert reads == []


@pytest.mark.parametrize("suffix", ["nii.gz", "nrrd"])
def test_compressed_medical_uses_one_bounded_eager_decode_and_preserves_values(
    tmp_path, monkeypatch, suffix
):
    from loci_engine import medical_image

    source = tmp_path / ("compressed." + suffix)
    values = np.arange(40**3, dtype=np.float64).reshape((40,) * 3) - 20.25
    sitk.WriteImage(sitk.GetImageFromArray(values), str(source), True)
    if suffix == "nrrd":
        content = source.read_bytes()
        source.write_bytes(content.replace(b"\n\n", b'\nspace units: "mm" "mm" "mm"\n\n', 1))
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    native_read = medical_image.read_medical
    reads = []

    def bounded_eager_read(*args, **kwargs):
        assert kwargs.get("region") is None
        reads.append(kwargs)
        return native_read(*args, **kwargs)

    monkeypatch.setattr(medical_image, "read_medical", bounded_eager_read)
    context = build_medical_volume_payload(
        source,
        source_id="medical",
        target_long_axis=256,
        max_decoded_bytes=2 * 1024**2,
    )["context"]
    assert context["dimensions_xyz"] == [40] * 3
    assert context["refinement"]["available"] is False
    decoded = np.frombuffer(base64.b64decode(context["data_base64"]), dtype="<f4")
    np.testing.assert_array_equal(decoded.reshape((40,) * 3), values.astype(np.float32))
    assert context["sampling"]["estimated_aggregate_bytes"] <= 2 * 1024**2
    assert len(reads) == 1
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash


def test_medical_projection_block_is_exact_readonly_and_bounded_before_decode(
    tmp_path, monkeypatch
):
    import loci_engine.viewer_medical as adapter

    path = tmp_path / "signed.nrrd"
    values = np.arange(9 * 7 * 6, dtype=np.float64).reshape(9, 7, 6) - 250.25
    header = (
        "NRRD0005\ntype: double\ndimension: 3\nspace: left-posterior-superior\n"
        "sizes: 6 7 9\nspace directions: (0.4,0,0) (0,0.8,0) (0,0,2.5)\n"
        'space units: "mm" "mm" "mm"\nspace origin: (10,20,-30)\nendian: little\nencoding: raw\n\n'
    )
    path.write_bytes(header.encode("ascii") + values.astype("<f8").tobytes())
    session = MedicalViewerSession(path)
    per_plane = 4 * 3 * (2 * 8 + 1)
    selection = NativeSelection(x=1, y=2, width=4, height=3, z=2, budget_bytes=per_plane * 3)
    assert session.projection_block_depth(selection, 9) == 3
    calls = []
    real = adapter.read_medical

    def read(*args, **kwargs):
        calls.append(kwargs["region"])
        return real(*args, **kwargs)

    monkeypatch.setattr(adapter, "read_medical", read)
    with pytest.raises(ValueError, match="bounded depth"):
        session.read_z_block(selection, 6)
    assert calls == []
    block = session.read_z_block(selection, 5)
    np.testing.assert_array_equal(block, values[2:5, 2:5, 1:5])
    assert block.dtype == np.float64 and block.flags.writeable is False
    assert block.min() < 0
    with pytest.raises(ValueError):
        block[0, 0, 0] = 0
    assert calls == [(slice(2, 5), slice(2, 5), slice(1, 5))]
    with pytest.raises(ValueError, match="memory budget"):
        session.projection_block_depth(replace(selection, budget_bytes=per_plane - 1), 5)
    assert len(calls) == 1
    np.testing.assert_array_equal(
        session.geometry({"x": 1, "y": 2, "z": 2}, True).world(np.array([[0, 0, 0]])),
        [[10.4, 21.6, -25.0]],
    )


def test_compressed_projection_reserves_full_decode_before_any_pixel_read(tmp_path, monkeypatch):
    import loci_engine.viewer_medical as adapter

    path = tmp_path / "volume.nii.gz"
    _write_volume(path)
    session = MedicalViewerSession(path)
    calls = []
    monkeypatch.setattr(adapter, "read_medical", lambda *a, **kw: calls.append(kw))
    fixed = 2 * session.inspection.estimated_decoded_bytes
    per_plane = 4 * 3 * (np.dtype(session.inspection.dtype).itemsize + 1)
    selection = NativeSelection(
        x=1, y=2, width=4, height=3, z=2, budget_bytes=fixed + per_plane * 2 - 1
    )
    assert session.projection_block_depth(selection, 20) == 1
    with pytest.raises(ValueError, match="bounded depth"):
        session.read_z_block(selection, 4)
    with pytest.raises(ValueError, match="memory budget"):
        session.projection_block_depth(replace(selection, budget_bytes=fixed), 20)
    assert calls == []


def test_projection_block_cancels_before_and_after_verified_decode(tmp_path, monkeypatch):
    import loci_engine.viewer_medical as adapter

    path = tmp_path / "volume.nii"
    _write_volume(path)
    session = MedicalViewerSession(path)
    selection = NativeSelection(x=1, y=2, width=4, height=3, z=2)
    real = adapter.read_medical
    calls = []

    def read(*a, **kw):
        calls.append(kw)
        return real(*a, **kw)

    monkeypatch.setattr(adapter, "read_medical", read)

    def cancel():
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        session.read_z_block(selection, 4, cancellation_check=cancel)
    assert calls == []

    def after_read():
        if calls:
            cancel()

    with pytest.raises(RuntimeError, match="cancelled"):
        session.read_z_block(selection, 4, cancellation_check=after_read)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("z_stop", True),
        ("z_stop", 21),
        ("z_stop", 2),
        ("budget_bytes", True),
        ("z", True),
        ("c", 1),
        ("level", 1),
        ("expected_sha256", "b" * 64),
    ],
)
def test_medical_projection_block_rejects_invalid_bindings_before_decode(
    tmp_path, monkeypatch, field, value
):
    import loci_engine.viewer_medical as adapter

    path = tmp_path / "volume.nii"
    _write_volume(path)
    session = MedicalViewerSession(path)
    selection = NativeSelection(x=1, y=2, width=4, height=3, z=2)
    calls = []
    monkeypatch.setattr(adapter, "read_medical", lambda *a, **kw: calls.append(kw))
    stop = value if field == "z_stop" else 4
    if field != "z_stop":
        selection = replace(selection, **{field: value})
    with pytest.raises(ValueError):
        session.read_z_block(selection, stop)
    assert calls == []
