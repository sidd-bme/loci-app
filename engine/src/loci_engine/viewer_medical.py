"""Native-like bounded adapter for inspected scalar medical images."""

from __future__ import annotations

import hmac
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from .medical_image import MedicalInspection, inspect_medical, read_medical
from .native_image import (
    NativeCapabilities,
    NativeDimensions,
    NativeImageMetadata,
    NativeLevel,
    NativeRegion,
    NativeRgbColorPolicy,
    NativeSelection,
    PhysicalCalibration,
)
from .quantitative import Geometry


class MedicalViewerSession:
    """Expose medical pixels through the same bounded plane protocol as native images."""

    def __init__(
        self,
        source: str | Path | Sequence[str | Path],
        *,
        expected_source_identity: str | None = None,
    ) -> None:
        self._source = source
        self._inspection = inspect_medical(source)
        if expected_source_identity is not None and not hmac.compare_digest(
            self._inspection.source_identity, expected_source_identity
        ):
            raise ValueError("The medical source identity changed before viewer access.")
        if len(self._inspection.shape) == 3:
            z, y, x = self._inspection.shape
        elif len(self._inspection.shape) == 2:
            y, x = self._inspection.shape
            z = 1
        else:  # inspect_medical owns the dimensionality validation.
            raise ValueError("Medical viewer sources must be two- or three-dimensional.")
        dimensions = NativeDimensions(1, 1, z, y, x)
        spacing_xyz = np.linalg.norm(
            np.asarray(self._inspection.geometry.affine, dtype=np.float64)[:3, :3], axis=0
        )
        calibration_axes = "ZYX" if self._inspection.geometry.axes == "ZYX" else "YX"
        calibration = PhysicalCalibration(
            calibration_axes,
            tuple(float(value) for value in spacing_xyz[: len(calibration_axes)][::-1]),
            self._inspection.geometry.unit,
        )
        fingerprint = self._inspection.source_identity.removeprefix("sha256:")
        self.metadata = NativeImageMetadata(
            format=self._inspection.format,
            axes="TCZYX",
            shape=(1, 1, z, y, x),
            source_axes="ZYX",
            source_shape=(z, y, x),
            dimensions=dimensions,
            levels=(NativeLevel(0, dimensions, calibration),),
            channel_names=("Scalar intensity",),
            channel_dtypes=(self._inspection.dtype,),
            sample_semantics="none",
            physical_calibration=calibration,
            sha256=fingerprint,
            selected_series=0,
            series_count=1,
            capabilities=NativeCapabilities(
                True, False, False, z > 1, False, False, ("bounded-medical-region",)
            ),
            rgb_color_policy=NativeRgbColorPolicy(
                "scalar", "not-applicable", None, None, "not-applicable", "none"
            ),
        )

    @property
    def inspection(self) -> MedicalInspection:
        return self._inspection

    @property
    def source(self) -> Any:
        return self._source

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        dimensions = self.metadata.dimensions
        if (
            selection.series != 0
            or selection.level != 0
            or selection.t != 0
            or selection.c != 0
            or not 0 <= selection.z < dimensions.z
            or not 0 <= selection.x < dimensions.x
            or not 0 <= selection.y < dimensions.y
            or selection.width < 1
            or selection.height < 1
            or selection.x + selection.width > dimensions.x
            or selection.y + selection.height > dimensions.y
        ):
            raise ValueError("The medical viewer selection is outside the scalar source.")
        if selection.expected_sha256 not in {None, self.metadata.sha256}:
            raise ValueError("The medical viewer selection fingerprint differs from its source.")
        region = (
            slice(selection.y, selection.y + selection.height),
            slice(selection.x, selection.x + selection.width),
        )
        if self._inspection.geometry.axes == "ZYX":
            region = (slice(selection.z, selection.z + 1), *region)
        volume = read_medical(
            self._source,
            region=region,
            expected_identity=self._inspection,
            max_decoded_bytes=selection.budget_bytes,
        )
        pixels = np.asarray(volume.array[0] if volume.array.ndim == 3 else volume.array)
        pixels.flags.writeable = False
        return NativeRegion(
            pixels=pixels,
            axes="YX",
            selection=selection,
            sha256=self.metadata.sha256,
            format=self.metadata.format,
            native_dtype=str(pixels.dtype),
            read_mode="bounded-medical-region",
            estimated_peak_bytes=pixels.nbytes,
            integrity_mode="full-sha256",
        )

    def geometry(self, selection: dict[str, Any], volume: bool) -> Geometry:
        if not isinstance(selection, dict) or not isinstance(volume, bool):
            raise ValueError("Medical viewer geometry requires a selection and volume flag.")
        values = []
        for name, limit in (
            ("z", self.metadata.dimensions.z),
            ("y", self.metadata.dimensions.y),
            ("x", self.metadata.dimensions.x),
        ):
            value = selection.get(name, 0)
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < limit:
                raise ValueError(f"Medical viewer {name} index is outside the source.")
            values.append(value)
        start = tuple(values) if self._inspection.geometry.axes == "ZYX" else tuple(values[1:])
        geometry = self._inspection.geometry.cropped(start)
        if volume:
            if geometry.axes != "ZYX":
                raise ValueError("A two-dimensional medical image cannot be used as a volume.")
            return geometry
        return geometry if geometry.axes == "YX" else Geometry(
            "YX", geometry.affine, geometry.unit, geometry.frame
        )

    def verify_strict(self) -> MedicalInspection:
        current = inspect_medical(self._source)
        if not hmac.compare_digest(current.source_identity, self._inspection.source_identity):
            raise ValueError("The medical source identity changed during viewer access.")
        return current

    def close(self) -> None:
        """The adapter holds no open decoder handles."""
