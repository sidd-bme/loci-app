"""Ephemeral, inventory-bound 3D display from an explicitly selected local OME-Zarr."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any

import numpy as np

from .native_image import NativeChannelDisplay, NativeDimensions, NativeLevel, NativeSelection
from .ome_zarr import (
    OMEZarrError,
    OMEZarrMetadata,
    OMEZarrPlane,
    OMEZarrPlaneRequest,
    OMEZarrSourceChangedError,
    _opening_plane_reader,
)
from .quantitative import Geometry
from .viewer_display import ViewerDisplayError
from .viewer_volume import ViewerVolumeError, _native_block
from .zarr_adapter import _zarr_geometry, _zarr_native_levels

_OPENING_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_PATH_CONTROL_CHAR = re.compile(r"[\x00-\x1f\x7f]")
_TARGET_LONG_AXIS = 96
_MAX_WORKING_BYTES = 24 * 1024 * 1024
_CONTEXT_FIELDS = (
    "dimensions_xyz",
    "native_level_dimensions_xyz",
    "source_dimensions_xyz",
    "origin_xyz",
    "spacing_xyz",
    "direction_3x3",
    "affine_4x4",
    "unit",
    "frame",
    "scalar_type",
    "source_dtypes",
    "encoding_basis",
    "interleave",
    "components",
    "data_base64",
    "data_sha256",
    "byte_length",
    "level",
    "t",
)


@dataclass(frozen=True, slots=True)
class _OpeningMetadata:
    levels: tuple[NativeLevel, ...]
    dimensions: NativeDimensions
    channel_names: tuple[str, ...]
    channel_dtypes: tuple[str, ...]
    acquisition_display: tuple[NativeChannelDisplay, ...] = ()
    format: str = "OME-Zarr"
    selected_series: int = 0


@dataclass(frozen=True, slots=True)
class _OpeningRegion:
    pixels: np.ndarray
    estimated_peak_bytes: int


class _OpeningVolume:
    def __init__(
        self,
        metadata: OMEZarrMetadata,
        read_plane: Callable[[OMEZarrPlaneRequest], OMEZarrPlane],
    ) -> None:
        self._metadata = metadata
        self._read_plane = read_plane
        levels = _zarr_native_levels(metadata)
        dimensions = levels[0].dimensions
        if len(levels) < 2 or dimensions.z < 2:
            raise ViewerVolumeError("Opening preview is available for multiscale 3D sources.")
        if len({level.dtype for level in metadata.levels}) != 1:
            raise ViewerVolumeError("Opening preview requires a consistent pyramid dtype.")
        # Limit the display resolver to the one channel used for the preview.
        self.metadata = _OpeningMetadata(
            levels=levels,
            dimensions=replace(dimensions, c=1),
            channel_names=("Channel 1",),
            channel_dtypes=(metadata.levels[0].dtype,),
        )

    def geometry(self, selection: dict[str, int], volume: bool) -> Geometry:
        return _zarr_geometry(self._metadata, selection, volume)

    def read_region(self, selection: NativeSelection) -> _OpeningRegion:
        if selection.t != 0 or selection.c != 0 or selection.series != 0:
            raise ViewerVolumeError("Opening preview supports the first time and channel only.")
        plane = self._read_plane(
            OMEZarrPlaneRequest(
                x=selection.x,
                y=selection.y,
                width=selection.width,
                height=selection.height,
                level=selection.level,
                z=selection.z,
                budget_bytes=selection.budget_bytes,
                expected_session_inventory_sha256=self._metadata.session_inventory_sha256,
            )
        )
        return _OpeningRegion(plane.values, plane.estimated_peak_bytes)


def opening_overview(params: dict[str, Any]) -> dict[str, Any]:
    if set(params) != {"path", "opening_id"}:
        raise ValueError("Opening overview requires an explicit path and opening ID.")
    path, opening_id = params["path"], params["opening_id"]
    if not isinstance(opening_id, str) or not _OPENING_ID.fullmatch(opening_id):
        raise ValueError("Opening overview ID is invalid.")
    if not isinstance(path, str) or not path or len(path) > 4096 or _PATH_CONTROL_CHAR.search(path):
        raise ValueError("Opening overview requires an explicit local OME-Zarr path.")
    try:
        with _opening_plane_reader(path) as (metadata, read_plane):
            session = _OpeningVolume(metadata, read_plane)
            block = _native_block(
                session,
                session.read_region,
                source_binding=None,
                t=0,
                channels=(0,),
                focus_extent=None,
                target=_TARGET_LONG_AXIS,
                budget=_MAX_WORKING_BYTES,
                explicit_channel_selection=True,
            )
    except OMEZarrSourceChangedError:
        raise ValueError("The OME-Zarr store changed during the opening overview.") from None
    except (OMEZarrError, ViewerVolumeError, ViewerDisplayError, OSError):
        raise ValueError("Opening overview is unavailable for this OME-Zarr store.") from None
    return {
        "schema_version": "loci.volume-opening-preview/v1",
        "opening_id": opening_id,
        "source_inventory_sha256": metadata.session_inventory_sha256,
        "context": {key: block[key] for key in _CONTEXT_FIELDS},
    }
