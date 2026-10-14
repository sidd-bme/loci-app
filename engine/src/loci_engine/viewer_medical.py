"""Native-like bounded adapter for inspected scalar medical images."""

from __future__ import annotations

import hmac
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from .medical_image import MedicalInspection, _file_plan, _safe_file, inspect_medical, read_medical
from .native_image import (
    MAX_NATIVE_READ_BUDGET_BYTES,
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

MAX_MEDICAL_PROJECTION_BLOCK_PLANES = 32


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

    def _validate_selection(self, selection: NativeSelection) -> None:
        dimensions = self.metadata.dimensions
        for name in ("series", "level", "t", "c", "z", "x", "y", "width", "height"):
            value = getattr(selection, name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("Medical viewer coordinates must be integer indexes.")
        budget = selection.budget_bytes
        if (
            isinstance(budget, bool)
            or not isinstance(budget, int)
            or not 1 <= budget <= MAX_NATIVE_READ_BUDGET_BYTES
        ):
            raise ValueError("The medical viewer read budget is outside the bounded allowance.")
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

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        self._validate_selection(selection)
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

    def _projection_memory(self, selection: NativeSelection) -> tuple[int, int]:
        """Fixed eager footprint and incremental plane footprint, before decode.

        Estimate known SimpleITK/NumPy arrays and finite masks, not total RSS.
        Eager sources retain the full decoder image/copy before extracting a
        bounded block. A streamed source retains an image/copy of only the block.
        """
        itemsize = np.dtype(self._inspection.dtype).itemsize
        plane_voxels = selection.width * selection.height
        eager = self._inspection.format == "dicom-series"
        if not eager:
            _, _, eager = _file_plan(_safe_file(self._source))
        if eager:
            return (2 * self._inspection.estimated_decoded_bytes, plane_voxels * (itemsize + 1))
        return 0, plane_voxels * (2 * itemsize + 1)

    def projection_block_depth(self, selection: NativeSelection, z_stop: int) -> int:
        """Fit a consecutive block to its already-reserved source-read budget."""
        self._validate_selection(selection)
        if (
            isinstance(z_stop, bool)
            or not isinstance(z_stop, int)
            or not selection.z < z_stop <= self.metadata.dimensions.z
        ):
            raise ValueError("The medical projection Z range is outside the source.")
        fixed, per_plane = self._projection_memory(selection)
        depth = (selection.budget_bytes - fixed) // per_plane
        if depth < 1:
            raise ValueError("A medical projection block exceeds its memory budget before decode.")
        return min(depth, z_stop - selection.z, MAX_MEDICAL_PROJECTION_BLOCK_PLANES)

    def read_z_block(
        self,
        selection: NativeSelection,
        z_stop: int,
        *,
        cancellation_check: Callable[[], None] | None = None,
    ) -> np.ndarray:
        """Read one immutable consecutive ZYX block with full identity checks.

        read_medical verifies source identity before and after every block. The
        caller releases the previous block before decoding the next, reserves
        its reduction accumulator separately, and reduces planes in Z order.
        """
        if cancellation_check is not None:
            cancellation_check()
        allowed = self.projection_block_depth(selection, z_stop)
        depth = z_stop - selection.z
        if depth != allowed:
            raise ValueError("The requested medical Z block exceeds its bounded depth.")
        region = (
            slice(selection.y, selection.y + selection.height),
            slice(selection.x, selection.x + selection.width),
        )
        if self._inspection.geometry.axes == "ZYX":
            region = (slice(selection.z, z_stop), *region)
        volume = read_medical(
            self._source,
            region=region,
            expected_identity=self._inspection,
            max_decoded_bytes=selection.budget_bytes,
        )
        if cancellation_check is not None:
            cancellation_check()
        values = np.asarray(volume.array)
        if values.ndim == 2:
            values = values[None]
        if (
            values.shape != (depth, selection.height, selection.width)
            or values.dtype != np.dtype(self._inspection.dtype)
            or volume.source_identity != self._inspection.source_identity
        ):
            raise ValueError("The medical reader returned an inconsistent projection block.")
        values.flags.writeable = False
        return values

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
        return (
            geometry
            if geometry.axes == "YX"
            else Geometry("YX", geometry.affine, geometry.unit, geometry.frame)
        )

    def verify_strict(self) -> MedicalInspection:
        current = inspect_medical(self._source)
        if not hmac.compare_digest(current.source_identity, self._inspection.source_identity):
            raise ValueError("The medical source identity changed during viewer access.")
        return current

    def close(self) -> None:
        """The adapter holds no open decoder handles."""
