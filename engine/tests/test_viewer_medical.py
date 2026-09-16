import math

import numpy as np
import pytest
import SimpleITK as sitk

from loci_engine.native_image import NativeSelection
from loci_engine.viewer_medical import MedicalViewerSession
from loci_engine.viewer_volume import build_medical_volume_payload


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
