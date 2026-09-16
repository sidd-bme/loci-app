"""Map an explicitly selected local NGFF image to shared task coordinates."""

from __future__ import annotations

from dataclasses import asdict

import numpy as np

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
from .ome_zarr import OMEZarrPlaneRequest, OMEZarrSession
from .quantitative import Geometry

_TO_UM = {"nanometer": 0.001, "micrometer": 1.0, "millimeter": 1000.0, "meter": 1e6}


class ZarrAdapter:
    def __init__(
        self,
        path: str,
        *,
        image_group: str = "",
        multiscale_index: int | None = None,
        expected_sha256: str | None = None,
    ):
        self.store = OMEZarrSession(
            path,
            image_group=image_group,
            multiscale_index=multiscale_index,
            expected_content_manifest_sha256=expected_sha256,
        )
        receipt = self.store.verify_strict()
        levels = []
        for level in self.store.metadata.levels:
            dimensions = NativeDimensions(*level.canonical_shape_tczyx)
            calibration = None
            units = level.units_tczyx[-3:]
            if all(unit in _TO_UM for unit in units):
                spacing = tuple(
                    s * _TO_UM[u] for s, u in zip(level.scale_tczyx[-3:], units, strict=True)
                )
                calibration = PhysicalCalibration("ZYX", spacing, "um")
            elif all(unit in _TO_UM for unit in units[-2:]):
                spacing = tuple(
                    s * _TO_UM[u] for s, u in zip(level.scale_tczyx[-2:], units[-2:], strict=True)
                )
                calibration = PhysicalCalibration("YX", spacing, "um")
            levels.append(NativeLevel(level.index, dimensions, calibration))
        dimensions = levels[0].dimensions
        self.metadata = NativeImageMetadata(
            format="OME-Zarr",
            axes="TCZYX",
            shape=tuple(asdict(dimensions)[k] for k in "tczyx"),
            source_axes="".join(axis.name.upper() for axis in self.store.metadata.source_axes),
            source_shape=self.store.metadata.levels[0].source_shape,
            dimensions=dimensions,
            levels=tuple(levels),
            channel_names=tuple(f"Channel {c + 1}" for c in range(dimensions.c)),
            channel_dtypes=(self.store.metadata.levels[0].dtype,) * dimensions.c,
            sample_semantics="none",
            physical_calibration=levels[0].calibration,
            sha256=receipt.content_manifest_sha256,
            selected_series=0,
            series_count=1,
            capabilities=NativeCapabilities(
                True,
                dimensions.t > 1,
                dimensions.c > 1,
                dimensions.z > 1,
                len(levels) > 1,
                True,
                ("bounded-zarr-chunks",),
            ),
            rgb_color_policy=NativeRgbColorPolicy(
                "scalar", "not-applicable", None, None, "not-applicable", "none"
            ),
        )

    def public_metadata(self) -> dict:
        return {**asdict(self.metadata), "ome_zarr": asdict(self.store.metadata)}

    def read_region(self, selection: NativeSelection) -> NativeRegion:
        if selection.series != 0:
            raise ValueError("Choose the OME-Zarr image group during source import")
        if selection.expected_sha256 not in {None, self.metadata.sha256}:
            raise ValueError("OME-Zarr selection fingerprint differs from its source")
        region = self.store.read_plane(
            OMEZarrPlaneRequest(
                level=selection.level,
                t=selection.t,
                c=selection.c,
                z=selection.z,
                x=selection.x,
                y=selection.y,
                width=selection.width,
                height=selection.height,
                budget_bytes=selection.budget_bytes,
            )
        )
        return NativeRegion(
            pixels=region.values,
            axes="YX",
            selection=selection,
            sha256=self.metadata.sha256,
            format="OME-Zarr",
            native_dtype=str(region.values.dtype),
            read_mode="bounded-zarr-chunks",
            estimated_peak_bytes=region.estimated_peak_bytes,
            integrity_mode="stat-verified-session",
        )

    def geometry(self, selection: dict, volume: bool) -> Geometry:
        level = self.store.metadata.levels[selection["level"]]
        ndim = 3 if volume else 2
        units = level.units_tczyx[-ndim:]
        if all(unit in _TO_UM for unit in units):
            factors, unit = [_TO_UM[u] for u in units], "um"
        elif all(unit is None for unit in units):
            factors, unit = [1.0] * ndim, "pixel"
        else:
            raise ValueError(
                "Analysis requires complete supported spatial units on the selected axes"
            )
        scale = level.scale_tczyx[-ndim:]
        translation = level.translation_tczyx[-ndim:]
        indices = [selection[key] for key in ("z", "y", "x")[-ndim:]]
        affine = np.eye(4)
        for index, (spacing, origin, factor, offset) in enumerate(
            zip(scale, translation, factors, indices, strict=True)
        ):
            xyz = ndim - index - 1
            affine[xyz, xyz] = spacing * factor
            affine[xyz, 3] = (origin + spacing * offset) * factor
        # A selected XY plane retains its declared physical Z location.
        if not volume and unit == "um" and level.units_tczyx[2] in _TO_UM:
            affine[2, 3] = (
                level.translation_tczyx[2] + level.scale_tczyx[2] * selection["z"]
            ) * _TO_UM[level.units_tczyx[2]]
        return Geometry("ZYX" if volume else "YX", tuple(tuple(row) for row in affine), unit)

    def verify_strict(self):
        receipt = self.store.verify_strict()
        if receipt.content_manifest_sha256 != self.metadata.sha256:
            raise ValueError("OME-Zarr source content changed")
        return receipt

    def close(self) -> None:
        self.store.close()
