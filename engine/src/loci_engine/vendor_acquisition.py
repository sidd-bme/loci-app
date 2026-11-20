"""Selected numeric acquisition coordinates from the bounded Bio-Formats OME projection."""

from __future__ import annotations

import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from itertools import product
from pathlib import Path
from typing import Any

import tifffile

from .native_image import (
    _NONPHYSICAL_LENGTH_UNITS,
    MAX_OME_XML_BYTES,
    NativeImageMetadata,
    _length_in_micrometres,
    _time_in_seconds,
)
from .vendor_conversion import VendorConversionError, VendorConversionRequest


def _quantity(attrs: dict, field: str) -> dict:
    """Read a declared quantity with the OME default unit for that field."""
    unit_field = field + "Unit"
    if field not in attrs:
        if unit_field in attrs:
            raise VendorConversionError(f"Missing OME {field} value for its declared unit.")
        return {}
    time = field in ("TimeIncrement", "DeltaT")
    unit = attrs.get(unit_field, "s" if time else "reference frame")
    try:
        raw = str(attrs[field])
        if len(raw) > 128 or not re.fullmatch(
            r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?", raw
        ):
            raise ValueError
        value = float(raw)
        if not math.isfinite(value) or (value == 0 and not Decimal(raw).is_zero()):
            raise ValueError
        if time:
            seconds = _time_in_seconds(value, unit, context=field)
            if seconds < 0 or (field == "TimeIncrement" and seconds == 0):
                raise ValueError
        elif unit not in _NONPHYSICAL_LENGTH_UNITS:
            if unit in ("um", "μm"):  # Native read aliases outside the OME UnitsLength enumeration.
                raise ValueError
            _length_in_micrometres(value, unit, context=field)
    except (ValueError, TypeError, OverflowError, InvalidOperation) as exc:
        raise VendorConversionError(f"Invalid or unsupported OME {field} value or unit.") from exc
    return {field: value, unit_field: unit}


@dataclass(frozen=True)
class Acquisition:
    increment: dict
    planes: dict[tuple[int, int, int], dict]

    def writer_metadata(self, shape: list[int]) -> dict:
        metadata = dict(self.increment)
        if self.planes:
            # tifffile computes TheT/C/Z from the TCZYX data's page order.
            indices = product(*(range(n) for n in shape[:3]))
            metadata["Plane"] = [self.planes.get(key, {}) for key in indices]
        return metadata


def select_acquisition(
    pixels: ET.Element, request: VendorConversionRequest, dimensions: dict
) -> Acquisition:
    end = request.end_exclusive
    assert end is not None
    selected: dict[tuple[int, int, int], dict] = {}
    seen = set()
    starts = (request.t, request.c, request.z)
    stops = (end.t, end.c, end.z)
    for plane in pixels.iterfind("{*}Plane"):
        indices = []
        for axis in "TCZ":
            raw = plane.get("The" + axis, "")
            if not re.fullmatch(r"\+?[0-9]{1,10}", raw) or int(raw) >= dimensions[axis.lower()]:
                raise VendorConversionError("Invalid OME Plane index in the selected series.")
            indices.append(int(raw))
        if not all(a <= i < b for a, i, b in zip(starts, indices, stops, strict=True)):
            continue
        key = tuple(i - start for i, start in zip(indices, starts, strict=True))
        if key in seen:
            raise VendorConversionError("Duplicate selected OME Plane coordinates.")
        seen.add(key)
        fields = {}
        for name in ("DeltaT", "PositionX", "PositionY", "PositionZ"):
            fields.update(_quantity(plane.attrib, name))
        if fields:
            selected[key] = fields
    return Acquisition(_quantity(pixels.attrib, "TimeIncrement"), selected)


def _evidence(increment: dict, times: list, positions: list) -> dict:
    # Native records bind raw quantities, units, normalized values and indices.
    payload = json.dumps([times, positions], sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {
        "time_increment": increment,
        "planes_with_delta_t": len(times),
        "planes_with_stage_position": len(positions),
        "stage_position_anchor": "unspecified",
        "native_plane_metadata_sha256": hashlib.sha256(payload.encode()).hexdigest(),
    }


def _increment_seconds(increment: dict) -> float | None:
    return (
        _time_in_seconds(
            increment["TimeIncrement"], increment["TimeIncrementUnit"], context="TimeIncrement"
        )
        if increment
        else None
    )


def verify_acquisition(output: Path, metadata: NativeImageMetadata, expected: Acquisition) -> dict:
    # NativeImageSession normalizes the uniform increment to seconds. Read back
    # the actual OME declaration too, including original units and absence.
    with tifffile.TiffFile(output) as tif:
        xml = tif.ome_metadata
        if (
            not xml
            or len(xml.encode()) > MAX_OME_XML_BYTES
            or "<!DOCTYPE" in xml
            or "<!ENTITY" in xml
        ):
            raise VendorConversionError("Missing or oversized converted OME metadata.")
        pixels = ET.fromstring(xml).find("{*}Image/{*}Pixels")
        interval = metadata.timing.uniform_interval if metadata.timing else None
        if (
            pixels is None
            or _quantity(pixels.attrib, "TimeIncrement") != expected.increment
            or interval != _increment_seconds(expected.increment)
        ):
            raise VendorConversionError("Reopened OME time increment differs from the source.")

    observed: dict[tuple[int, int, int], dict] = {}
    for time in metadata.plane_times:
        observed[(time.t, time.c, time.z)] = {
            "DeltaT": time.delta_t,
            "DeltaTUnit": time.delta_t_unit,
        }
    for pos in metadata.plane_positions:
        fields = observed.setdefault((pos.t, pos.c, pos.z), {})
        for axis, value, unit in zip("XYZ", pos.position_xyz, pos.units_xyz, strict=True):
            if value is not None:
                fields["Position" + axis] = value
                fields["Position" + axis + "Unit"] = unit
    if observed != expected.planes:
        raise VendorConversionError(
            "Reopened plane times or stage positions differ from the source."
        )
    return _evidence(
        expected.increment,
        [asdict(v) for v in metadata.plane_times],
        [asdict(v) for v in metadata.plane_positions],
    )


def validate_evidence(proof: Any, metadata: dict | None, plane_count: int) -> None:
    keys = {
        "time_increment",
        "planes_with_delta_t",
        "planes_with_stage_position",
        "stage_position_anchor",
        "native_plane_metadata_sha256",
    }
    if (
        not isinstance(proof, dict)
        or set(proof) != keys
        or (
            proof["stage_position_anchor"] != "unspecified"
            or not isinstance(proof["native_plane_metadata_sha256"], str)
            or not re.fullmatch("[a-f0-9]{64}", proof["native_plane_metadata_sha256"])
        )
    ):
        raise ValueError("Invalid vendor acquisition evidence")
    for key in ("planes_with_delta_t", "planes_with_stage_position"):
        if type(proof[key]) is not int or not 0 <= proof[key] <= plane_count:
            raise ValueError("Invalid vendor acquisition plane count")
    increment = proof["time_increment"]
    if not isinstance(increment, dict) or (
        increment
        and (
            set(increment) != {"TimeIncrement", "TimeIncrementUnit"}
            or type(increment["TimeIncrement"]) not in (int, float)
            or _quantity(increment, "TimeIncrement") != increment
        )
    ):
        raise ValueError("Invalid vendor acquisition time increment")
    if metadata is not None:
        timing = metadata["timing"] or {}
        times, positions = metadata["plane_times"], metadata["plane_positions"]
        if (
            timing.get("uniform_interval") != _increment_seconds(increment)
            or len(times) != proof["planes_with_delta_t"]
            or len(positions) != proof["planes_with_stage_position"]
            or _evidence(increment, times, positions) != proof
        ):
            raise ValueError("Derived source acquisition metadata differs from its vendor receipt")
