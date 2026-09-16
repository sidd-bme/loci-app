"""Fail-closed, bounded reads of local OME-NGFF 0.4 / Zarr v2 images.

This module deliberately implements a narrow, auditable subset.  It accepts a
local directory store, numeric scalar arrays, canonical microscopy axes, and
unfiltered chunks compressed with no codec, Blosc, zlib, or gzip.  It does not
use a generic Zarr store or codec registry while reading untrusted sources.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import stat
import zlib
from dataclasses import dataclass, replace
from itertools import product
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import numcodecs
import numpy as np
import zarr
from numcodecs import Blosc

DEFAULT_PLANE_BUDGET_BYTES = 64 * 1024 * 1024
MAX_PLANE_BUDGET_BYTES = 512 * 1024 * 1024
MAX_DECODED_CHUNK_BYTES = 256 * 1024 * 1024
MAX_ENCODED_FILE_BYTES = 512 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_STORE_BYTES = 16 * 1024**4
MAX_STORE_ENTRIES = 250_000
MAX_STORE_DEPTH = 32
MAX_PATH_BYTES = 1024
MAX_LEVELS = 32

_SHA256 = re.compile(r"[0-9a-f]{64}")
_AXES = ("t", "c", "z", "y", "x")
_SPATIAL_UNITS_TO_MICROMETRES = {
    "angstrom": 1e-4,
    "nanometer": 1e-3,
    "micrometer": 1.0,
    "millimeter": 1e3,
    "centimeter": 1e4,
    "meter": 1e6,
}


class OMEZarrError(ValueError):
    """Raised when a source or request is outside the supported safe subset."""


class OMEZarrUnsupportedError(OMEZarrError):
    """Raised when valid-looking metadata uses an unsupported NGFF/Zarr feature."""


class OMEZarrSourceChangedError(RuntimeError):
    """Raised when the directory store differs from its opened-session inventory."""


class OMEZarrBudgetError(OMEZarrError):
    """Raised before decoding when a plane request exceeds its memory budget."""

    def __init__(self, required_bytes: int, budget_bytes: int) -> None:
        self.required_bytes = required_bytes
        self.budget_bytes = budget_bytes
        super().__init__(
            f"The requested plane can require {required_bytes / (1024 * 1024):,.1f} MiB, "
            f"above its {budget_bytes / (1024 * 1024):,.1f} MiB memory budget. "
            "No chunks were decoded."
        )


@dataclass(frozen=True, slots=True)
class OMEZarrAxis:
    name: Literal["t", "c", "z", "y", "x"]
    type: Literal["time", "channel", "space"]
    unit: str | None


@dataclass(frozen=True, slots=True)
class OMEZarrCodec:
    id: Literal["none", "blosc", "zlib", "gzip"]
    configuration: tuple[tuple[str, str | int], ...]


@dataclass(frozen=True, slots=True)
class OMEZarrLevel:
    index: int
    source_shape: tuple[int, ...]
    canonical_shape_tczyx: tuple[int, int, int, int, int]
    source_chunks: tuple[int, ...]
    canonical_chunks_tczyx: tuple[int, int, int, int, int]
    dtype: str
    codec: OMEZarrCodec
    scale_tczyx: tuple[float, float, float, float, float]
    translation_tczyx: tuple[float, float, float, float, float]
    units_tczyx: tuple[str | None, str | None, str | None, str | None, str | None]
    micrometres_per_pixel_xy: tuple[float, float] | None
    origin_micrometres_xy: tuple[float, float] | None
    calibration_status: Literal["declared-physical-units", "relative-or-missing"]
    decoded_chunk_bytes: int


@dataclass(frozen=True, slots=True)
class OMEZarrMetadata:
    ngff_version: Literal["0.4"]
    zarr_format: Literal[2]
    source_axes: tuple[OMEZarrAxis, ...]
    canonical_axes: Literal["TCZYX"]
    levels: tuple[OMEZarrLevel, ...]
    session_inventory_sha256: str
    source_size_bytes: int
    file_count: int
    directory_count: int
    integrity_mode: Literal["stat-manifest-session"]
    decoder: Literal["loci-bounded-zarr-v2"]
    zarr_version: str
    numcodecs_version: str
    strict_content_manifest_sha256: str | None


@dataclass(frozen=True, slots=True)
class OMEZarrPlaneRequest:
    level: int = 0
    t: int = 0
    c: int = 0
    z: int = 0
    x: int = 0
    y: int = 0
    width: int | None = None
    height: int | None = None
    budget_bytes: int = DEFAULT_PLANE_BUDGET_BYTES
    expected_session_inventory_sha256: str | None = None


@dataclass(frozen=True, slots=True)
class OMEZarrPlane:
    values: np.ndarray
    request: OMEZarrPlaneRequest
    canonical_indices_tcz: tuple[int, int, int]
    pixel_extent_xyxy: tuple[int, int, int, int]
    physical_extent_xyxy: tuple[float, float, float, float] | None
    physical_unit_xy: tuple[str, str] | None
    micrometre_extent_xyxy: tuple[float, float, float, float] | None
    source_session_inventory_sha256: str
    integrity_mode: Literal["stat-verified-session"]
    estimated_peak_bytes: int


@dataclass(frozen=True, slots=True)
class OMEZarrIntegrityReceipt:
    content_manifest_sha256: str
    session_inventory_sha256: str
    file_count: int
    source_size_bytes: int
    integrity_mode: Literal["full-content-manifest-sha256"] = "full-content-manifest-sha256"


@dataclass(frozen=True, slots=True)
class _EntryIdentity:
    kind: Literal["file", "directory"]
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True, slots=True)
class _ArraySpec:
    relative_path: str
    shape: tuple[int, ...]
    chunks: tuple[int, ...]
    dtype: np.dtype[Any]
    fill_value: bool | int | float | None
    order: Literal["C", "F"]
    dimension_separator: Literal[".", "/"]
    compressor: dict[str, Any] | None
    codec: OMEZarrCodec
    decoded_chunk_bytes: int


def _safe_relative_path(value: object, name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise OMEZarrError(f"{name} must be a relative POSIX path string.")
    if value == "" and allow_empty:
        return value
    if not value or "\\" in value or value.startswith("/") or value.endswith("/"):
        raise OMEZarrError(f"{name} must be a normalized relative POSIX path.")
    path = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in path.parts) or str(path) != value:
        raise OMEZarrError(f"{name} must be a normalized contained relative POSIX path.")
    if len(path.parts) > MAX_STORE_DEPTH:
        raise OMEZarrError(f"{name} exceeds the supported directory depth.")
    return value


def _root_path(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise OMEZarrError("OME-Zarr access requires an absolute local directory path.")
    try:
        status = path.stat(follow_symlinks=False)
    except OSError as exc:
        raise OMEZarrError("The OME-Zarr directory is not accessible.") from exc
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISDIR(status.st_mode):
        raise OMEZarrError("The OME-Zarr source must be a non-symlink directory.")
    try:
        return path.resolve(strict=True)
    except OSError as exc:
        raise OMEZarrError("The OME-Zarr directory cannot be resolved locally.") from exc


def _entry_identity(status: os.stat_result, kind: Literal["file", "directory"]) -> _EntryIdentity:
    return _EntryIdentity(
        kind=kind,
        device=int(status.st_dev),
        inode=int(status.st_ino),
        size=int(status.st_size) if kind == "file" else 0,
        mtime_ns=int(status.st_mtime_ns),
        # NTFS may apply ctime updates lazily between lstat() and fstat() even
        # when content, size, mtime and file identity are unchanged.
        ctime_ns=0 if os.name == "nt" else int(status.st_ctime_ns),
    )


def _inventory(root: Path) -> dict[str, _EntryIdentity]:
    entries: dict[str, _EntryIdentity] = {}
    total_bytes = 0

    def walk(directory: Path, parts: tuple[str, ...]) -> None:
        nonlocal total_bytes
        if len(parts) > MAX_STORE_DEPTH:
            raise OMEZarrError("The OME-Zarr store exceeds the supported directory depth.")
        try:
            children = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as exc:
            raise OMEZarrSourceChangedError(
                "The OME-Zarr store changed or became unreadable during inventory."
            ) from exc
        for child in children:
            child_parts = (*parts, child.name)
            if len(child_parts) > MAX_STORE_DEPTH:
                raise OMEZarrError("The OME-Zarr store exceeds the supported directory depth.")
            relative = PurePosixPath(*child_parts).as_posix()
            try:
                encoded_path = relative.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise OMEZarrError("The OME-Zarr store contains a non-UTF-8 path.") from exc
            if (
                not relative
                or len(encoded_path) > MAX_PATH_BYTES
                or "\\" in relative
                or any(ord(character) < 32 for character in relative)
            ):
                raise OMEZarrError("The OME-Zarr store contains an unsupported path.")
            try:
                # DirEntry.stat() reports zero device/inode values on Windows,
                # while fstat() returns the real file identity. Path.lstat()
                # keeps the no-follow guarantee and produces comparable values.
                status = Path(child.path).lstat()
            except OSError as exc:
                raise OMEZarrSourceChangedError(
                    "An OME-Zarr entry changed during inventory."
                ) from exc
            if stat.S_ISLNK(status.st_mode):
                raise OMEZarrUnsupportedError(
                    "OME-Zarr symlinks and external references are not supported."
                )
            if stat.S_ISDIR(status.st_mode):
                entries[relative] = _entry_identity(status, "directory")
                walk(Path(child.path), child_parts)
            elif stat.S_ISREG(status.st_mode):
                if status.st_nlink != 1:
                    raise OMEZarrUnsupportedError(
                        "OME-Zarr linked files and external references are not supported."
                    )
                identity = _entry_identity(status, "file")
                if identity.size > MAX_ENCODED_FILE_BYTES:
                    raise OMEZarrUnsupportedError(
                        "An OME-Zarr file exceeds the supported encoded-file size."
                    )
                total_bytes += identity.size
                if total_bytes > MAX_STORE_BYTES:
                    raise OMEZarrUnsupportedError(
                        "The OME-Zarr store exceeds the supported total encoded size."
                    )
                entries[relative] = identity
            else:
                raise OMEZarrUnsupportedError(
                    "OME-Zarr stores may contain only regular files and directories."
                )
            if len(entries) > MAX_STORE_ENTRIES:
                raise OMEZarrUnsupportedError(
                    "The OME-Zarr store exceeds the supported entry count."
                )

    walk(root, ())
    return entries


def _inventory_digest(entries: dict[str, _EntryIdentity]) -> str:
    digest = hashlib.sha256()
    for relative, identity in sorted(entries.items()):
        record = {
            "ctime_ns": identity.ctime_ns,
            "device": identity.device,
            "inode": identity.inode,
            "kind": identity.kind,
            "mtime_ns": identity.mtime_ns,
            "path": relative,
            "size": identity.size,
        }
        digest.update(json.dumps(record, sort_keys=True, separators=(",", ":")).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _open_verified_file(
    root: Path, relative: str, entries: dict[str, _EntryIdentity], *, maximum: int
) -> bytes:
    expected = entries.get(relative)
    if expected is None or expected.kind != "file":
        raise OMEZarrSourceChangedError(f"Required OME-Zarr file '{relative}' is missing.")
    if expected.size > maximum:
        raise OMEZarrUnsupportedError(f"OME-Zarr file '{relative}' exceeds its size limit.")
    # Binary mode avoids Windows CRT newline and Ctrl-Z translation while
    # reading exact chunk bytes through os.read().
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(root / PurePosixPath(relative), flags)
        try:
            before = os.fstat(descriptor)
            identity = _entry_identity(before, "file")
            if (
                identity != expected
                or not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
            ):
                raise OMEZarrSourceChangedError(
                    f"OME-Zarr file '{relative}' changed before it was read."
                )
            chunks: list[bytes] = []
            remaining = expected.size
            while remaining:
                chunk = os.read(descriptor, min(remaining, 1024 * 1024))
                if not chunk:
                    raise OMEZarrSourceChangedError(
                        f"OME-Zarr file '{relative}' was truncated while it was read."
                    )
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                raise OMEZarrSourceChangedError(
                    f"OME-Zarr file '{relative}' grew while it was read."
                )
            after = os.fstat(descriptor)
            if _entry_identity(after, "file") != expected:
                raise OMEZarrSourceChangedError(
                    f"OME-Zarr file '{relative}' changed while it was read."
                )
            return b"".join(chunks)
        finally:
            os.close(descriptor)
    except OMEZarrError:
        raise
    except OSError as exc:
        raise OMEZarrSourceChangedError(
            f"OME-Zarr file '{relative}' changed or became unreadable."
        ) from exc


def _json_file(root: Path, relative: str, entries: dict[str, _EntryIdentity]) -> dict[str, Any]:
    raw = _open_verified_file(root, relative, entries, maximum=MAX_METADATA_BYTES)

    def object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise OMEZarrError(f"OME-Zarr metadata '{relative}' contains a duplicate JSON key.")
            value[key] = item
        return value

    def reject_constant(value: str) -> Any:
        raise OMEZarrError(
            f"OME-Zarr metadata '{relative}' contains non-standard constant {value}."
        )

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=object_without_duplicates,
            parse_constant=reject_constant,
        )
    except OMEZarrError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise OMEZarrError(f"OME-Zarr metadata '{relative}' is not valid UTF-8 JSON.") from exc
    if not isinstance(value, dict):
        raise OMEZarrError(f"OME-Zarr metadata '{relative}' must be a JSON object.")
    return value


def _validate_group(root: Path, relative_group: str, entries: dict[str, _EntryIdentity]) -> None:
    metadata_path = f"{relative_group}/.zgroup" if relative_group else ".zgroup"
    metadata = _json_file(root, metadata_path, entries)
    if metadata != {"zarr_format": 2}:
        raise OMEZarrUnsupportedError("Only exact Zarr v2 group metadata is supported.")


def _finite_vector(value: object, length: int, name: str, *, positive: bool) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != length:
        raise OMEZarrError(f"{name} must contain one value per source axis.")
    output: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise OMEZarrError(f"{name} must contain only finite numbers.")
        number = float(item)
        if not math.isfinite(number) or (positive and number <= 0):
            qualifier = "positive " if positive else ""
            raise OMEZarrError(f"{name} must contain only finite {qualifier}numbers.")
        output.append(number)
    return tuple(output)


def _transform_sequence(
    value: object, length: int, name: str, *, required: bool
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    if value is None and not required:
        return (1.0,) * length, (0.0,) * length
    if not isinstance(value, list) or not value:
        raise OMEZarrError(f"{name} must be a non-empty transformation list.")
    if len(value) not in {1, 2}:
        raise OMEZarrUnsupportedError(
            f"{name} supports exactly one scale and optional translation."
        )
    scale: tuple[float, ...] | None = None
    translation = (0.0,) * length
    for index, transform in enumerate(value):
        if not isinstance(transform, dict) or not isinstance(transform.get("type"), str):
            raise OMEZarrError(f"{name}[{index}] is malformed.")
        transform_type = transform["type"]
        if transform_type == "scale":
            if index != 0 or scale is not None or set(transform) != {"type", "scale"}:
                raise OMEZarrUnsupportedError(
                    f"{name} must contain one inline scale followed by optional translation."
                )
            scale = _finite_vector(transform["scale"], length, f"{name} scale", positive=True)
        elif transform_type == "translation":
            if index != 1 or scale is None or set(transform) != {"type", "translation"}:
                raise OMEZarrUnsupportedError(
                    f"{name} translation must be inline and follow its scale."
                )
            translation = _finite_vector(
                transform["translation"], length, f"{name} translation", positive=False
            )
        else:
            raise OMEZarrUnsupportedError(
                f"{name} transformation type '{transform_type}' is unsupported."
            )
    if scale is None:
        raise OMEZarrError(f"{name} must contain exactly one scale transformation.")
    return scale, translation


def _axes(value: object) -> tuple[OMEZarrAxis, ...]:
    if not isinstance(value, list) or not 2 <= len(value) <= 5:
        raise OMEZarrError("OME-NGFF axes must be a list with two through five entries.")
    axes: list[OMEZarrAxis] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or not {"name"} <= set(item) <= {"name", "type", "unit"}:
            raise OMEZarrError(f"OME-NGFF axis {index} is malformed or has unsupported fields.")
        name = item["name"]
        if name not in _AXES:
            raise OMEZarrUnsupportedError(
                "This reader maps only explicitly named t, c, z, y, and x axes."
            )
        expected_type = "time" if name == "t" else "channel" if name == "c" else "space"
        axis_type = item.get("type", expected_type)
        if axis_type != expected_type:
            raise OMEZarrError(f"OME-NGFF axis '{name}' has an incompatible type.")
        unit = item.get("unit")
        if unit is not None and (not isinstance(unit, str) or not unit):
            raise OMEZarrError(f"OME-NGFF axis '{name}' has an invalid unit.")
        if name == "c" and unit is not None:
            raise OMEZarrError("The channel axis cannot declare a physical unit.")
        axes.append(OMEZarrAxis(name=name, type=expected_type, unit=unit))  # type: ignore[arg-type]
    names = tuple(axis.name for axis in axes)
    if len(set(names)) != len(names) or names not in {
        ("y", "x"),
        ("z", "y", "x"),
        ("c", "y", "x"),
        ("c", "z", "y", "x"),
        ("t", "y", "x"),
        ("t", "z", "y", "x"),
        ("t", "c", "y", "x"),
        ("t", "c", "z", "y", "x"),
    }:
        raise OMEZarrUnsupportedError(
            "Axes must be an ordered TCZYX subset containing terminal Y and X spatial axes."
        )
    return tuple(axes)


def _positive_int_tuple(value: object, length: int, name: str) -> tuple[int, ...]:
    if not isinstance(value, list) or len(value) != length:
        raise OMEZarrError(f"{name} must contain one integer per source axis.")
    if any(isinstance(item, bool) or not isinstance(item, int) or item <= 0 for item in value):
        raise OMEZarrError(f"{name} must contain positive integers.")
    return tuple(value)


def _fill_value(value: object, dtype: np.dtype[Any]) -> bool | int | float | None:
    if value is None:
        return None
    if isinstance(value, str):
        raise OMEZarrUnsupportedError("Non-finite or encoded string fill values are unsupported.")
    if dtype.kind == "b":
        if not isinstance(value, bool):
            raise OMEZarrError("The Zarr fill value is incompatible with its boolean dtype.")
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OMEZarrError("The Zarr fill value is incompatible with its numeric dtype.")
    if isinstance(value, float) and not math.isfinite(value):
        raise OMEZarrError("The Zarr fill value must be finite.")
    if dtype.kind in {"i", "u"}:
        limits = np.iinfo(dtype)
        if not isinstance(value, int) or not limits.min <= value <= limits.max:
            raise OMEZarrError("The Zarr integer fill value is outside its dtype range.")
    try:
        converted = np.asarray(value, dtype=dtype).item()
    except (TypeError, ValueError, OverflowError) as exc:
        raise OMEZarrError("The Zarr fill value is incompatible with its dtype.") from exc
    if dtype.kind == "f" and not math.isfinite(float(converted)):
        raise OMEZarrError("The Zarr fill value overflows its floating dtype.")
    return converted


def _codec(value: object) -> tuple[dict[str, Any] | None, OMEZarrCodec]:
    if value is None:
        return None, OMEZarrCodec("none", ())
    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        raise OMEZarrError("The Zarr compressor configuration is malformed.")
    codec_id = value["id"]
    if codec_id == "blosc":
        if (
            not {"id", "cname", "clevel", "shuffle"}
            <= set(value)
            <= {"id", "cname", "clevel", "shuffle", "blocksize"}
        ):
            raise OMEZarrUnsupportedError("The Blosc compressor configuration is unsupported.")
        cname, clevel, shuffle = value["cname"], value["clevel"], value["shuffle"]
        blocksize = value.get("blocksize", 0)
        if (
            cname not in {"blosclz", "lz4", "lz4hc", "snappy", "zlib", "zstd"}
            or isinstance(clevel, bool)
            or not isinstance(clevel, int)
            or not 0 <= clevel <= 9
            or isinstance(shuffle, bool)
            or not isinstance(shuffle, int)
            or shuffle not in {0, 1, 2}
            or isinstance(blocksize, bool)
            or not isinstance(blocksize, int)
            or blocksize < 0
        ):
            raise OMEZarrError("The Blosc compressor parameters are invalid.")
    elif codec_id in {"zlib", "gzip"}:
        if set(value) != {"id", "level"}:
            raise OMEZarrUnsupportedError(
                f"The {codec_id} compressor configuration is unsupported."
            )
        level = value["level"]
        if isinstance(level, bool) or not isinstance(level, int) or not 0 <= level <= 9:
            raise OMEZarrError(f"The {codec_id} compression level is invalid.")
    else:
        raise OMEZarrUnsupportedError(
            f"Zarr compressor '{codec_id}' is outside the allowlisted reader subset."
        )
    configuration = tuple((key, item) for key, item in sorted(value.items()) if key != "id")
    return dict(value), OMEZarrCodec(codec_id, configuration)  # type: ignore[arg-type]


def _array_spec(
    root: Path, relative_path: str, ndim: int, entries: dict[str, _EntryIdentity]
) -> _ArraySpec:
    metadata = _json_file(root, f"{relative_path}/.zarray", entries)
    required = {
        "zarr_format",
        "shape",
        "chunks",
        "dtype",
        "compressor",
        "fill_value",
        "order",
        "filters",
    }
    if not required <= set(metadata) <= required | {"dimension_separator"}:
        raise OMEZarrUnsupportedError("The Zarr array metadata has missing or unsupported fields.")
    if metadata["zarr_format"] != 2:
        raise OMEZarrUnsupportedError("Only Zarr storage format 2 arrays are supported.")
    shape = _positive_int_tuple(metadata["shape"], ndim, "Zarr shape")
    chunks = _positive_int_tuple(metadata["chunks"], ndim, "Zarr chunk shape")
    dtype_value = metadata["dtype"]
    if not isinstance(dtype_value, str) or not dtype_value.startswith(("<", ">", "|")):
        raise OMEZarrUnsupportedError(
            "Only simple Zarr dtypes with explicit byte order are supported."
        )
    try:
        dtype = np.dtype(dtype_value)
    except TypeError as exc:
        raise OMEZarrError("The Zarr dtype is invalid.") from exc
    if dtype.kind not in {"b", "i", "u", "f"} or dtype.itemsize not in {1, 2, 4, 8}:
        raise OMEZarrUnsupportedError(
            "Only boolean, integer, and floating scalar dtypes up to 64 bits are supported."
        )
    if metadata["filters"] is not None:
        raise OMEZarrUnsupportedError("Zarr filters are outside the reader's audited subset.")
    order = metadata["order"]
    if order not in {"C", "F"}:
        raise OMEZarrError("Zarr chunk order must be C or F.")
    separator = metadata.get("dimension_separator", ".")
    if separator not in {".", "/"}:
        raise OMEZarrError("Zarr dimension_separator must be '.' or '/'.")
    compressor, codec = _codec(metadata["compressor"])
    decoded_chunk_bytes = math.prod(chunks) * dtype.itemsize
    if decoded_chunk_bytes > MAX_DECODED_CHUNK_BYTES:
        raise OMEZarrUnsupportedError(
            "A declared Zarr chunk exceeds the 256 MiB decoded-chunk limit."
        )
    fill = _fill_value(metadata["fill_value"], dtype)
    return _ArraySpec(
        relative_path=relative_path,
        shape=shape,
        chunks=chunks,
        dtype=dtype,
        fill_value=fill,
        order=order,
        dimension_separator=separator,
        compressor=compressor,
        codec=codec,
        decoded_chunk_bytes=decoded_chunk_bytes,
    )


def _canonical(
    values: tuple[Any, ...], axis_names: tuple[str, ...], default: Any
) -> tuple[Any, ...]:
    mapping = dict(zip(axis_names, values, strict=True))
    return tuple(mapping.get(name, default) for name in _AXES)


def _compose_transforms(
    first_scale: tuple[float, ...],
    first_translation: tuple[float, ...],
    second_scale: tuple[float, ...],
    second_translation: tuple[float, ...],
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    scale = tuple(a * b for a, b in zip(first_scale, second_scale, strict=True))
    translation = tuple(
        b * first + second
        for first, b, second in zip(
            first_translation, second_scale, second_translation, strict=True
        )
    )
    return scale, translation


def _micrometre_xy(
    axes: tuple[OMEZarrAxis, ...], scale: tuple[float, ...], translation: tuple[float, ...]
) -> tuple[tuple[float, float] | None, tuple[float, float] | None]:
    by_name = {axis.name: index for index, axis in enumerate(axes)}
    y_axis, x_axis = axes[by_name["y"]], axes[by_name["x"]]
    if (
        y_axis.unit not in _SPATIAL_UNITS_TO_MICROMETRES
        or x_axis.unit not in _SPATIAL_UNITS_TO_MICROMETRES
    ):
        return None, None
    fy = _SPATIAL_UNITS_TO_MICROMETRES[y_axis.unit]
    fx = _SPATIAL_UNITS_TO_MICROMETRES[x_axis.unit]
    return (
        (scale[by_name["x"]] * fx, scale[by_name["y"]] * fy),
        (translation[by_name["x"]] * fx, translation[by_name["y"]] * fy),
    )


def _content_manifest(root: Path, entries: dict[str, _EntryIdentity]) -> tuple[str, int, int]:
    digest = hashlib.sha256()
    count = 0
    total = 0
    for relative, identity in sorted(entries.items()):
        if identity.kind != "file":
            continue
        file_digest = _verified_file_sha256(root, relative, entries)
        record = {
            "bytes": identity.size,
            "path": relative,
            "sha256": file_digest,
        }
        digest.update(json.dumps(record, sort_keys=True, separators=(",", ":")).encode())
        digest.update(b"\n")
        count += 1
        total += identity.size
    return digest.hexdigest(), count, total


def _verified_file_sha256(root: Path, relative: str, entries: dict[str, _EntryIdentity]) -> str:
    expected = entries.get(relative)
    if expected is None or expected.kind != "file":
        raise OMEZarrSourceChangedError(f"OME-Zarr file '{relative}' is missing.")
    # Binary mode avoids Windows CRT newline and Ctrl-Z translation while
    # hashing exact chunk bytes through os.read().
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(root / PurePosixPath(relative), flags)
        try:
            before = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or _entry_identity(before, "file") != expected
            ):
                raise OMEZarrSourceChangedError(
                    f"OME-Zarr file '{relative}' changed before strict verification."
                )
            digest = hashlib.sha256()
            total = 0
            while total < expected.size:
                chunk = os.read(descriptor, min(1024 * 1024, expected.size - total))
                if not chunk:
                    raise OMEZarrSourceChangedError(
                        f"OME-Zarr file '{relative}' was truncated during strict verification."
                    )
                digest.update(chunk)
                total += len(chunk)
            if os.read(descriptor, 1):
                raise OMEZarrSourceChangedError(
                    f"OME-Zarr file '{relative}' grew during strict verification."
                )
            if _entry_identity(os.fstat(descriptor), "file") != expected:
                raise OMEZarrSourceChangedError(
                    f"OME-Zarr file '{relative}' changed during strict verification."
                )
            return digest.hexdigest()
        finally:
            os.close(descriptor)
    except OMEZarrError:
        raise
    except OSError as exc:
        raise OMEZarrSourceChangedError(
            f"OME-Zarr file '{relative}' changed or became unreadable."
        ) from exc


def _working_budget(value: object) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1024 <= value <= MAX_PLANE_BUDGET_BYTES
    ):
        raise OMEZarrError("budget_bytes must be an integer from 1024 bytes through 512 MiB.")
    return value


def _bounded_zlib_decode(encoded: bytes, expected_bytes: int, *, gzip: bool) -> bytes:
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS if gzip else zlib.MAX_WBITS)
    try:
        decoded = decoder.decompress(encoded, expected_bytes + 1)
        if len(decoded) > expected_bytes or decoder.unconsumed_tail:
            raise OMEZarrError("Compressed Zarr chunk expands beyond its declared byte count.")
        decoded += decoder.flush(expected_bytes - len(decoded) + 1)
    except zlib.error as exc:
        raise OMEZarrError("A requested Zarr chunk could not be decoded safely.") from exc
    if (
        len(decoded) != expected_bytes
        or not decoder.eof
        or decoder.unused_data
        or decoder.unconsumed_tail
    ):
        raise OMEZarrError("A compressed Zarr chunk has an invalid decoded length or stream.")
    return decoded


class OMEZarrSession:
    """Read-only session for one explicitly selected local OME-NGFF image group."""

    def __init__(
        self,
        root: str | Path,
        *,
        image_group: str = "",
        multiscale_index: int | None = None,
        expected_content_manifest_sha256: str | None = None,
    ) -> None:
        if expected_content_manifest_sha256 is not None and (
            not isinstance(expected_content_manifest_sha256, str)
            or not _SHA256.fullmatch(expected_content_manifest_sha256)
        ):
            raise OMEZarrError(
                "expected_content_manifest_sha256 must be 64 lowercase hexadecimal characters."
            )
        self._root = _root_path(root)
        self._image_group = _safe_relative_path(image_group, "image_group", allow_empty=True)
        before = _inventory(self._root)
        _validate_group(self._root, "", before)
        if self._image_group:
            parts = PurePosixPath(self._image_group).parts
            for index in range(1, len(parts) + 1):
                _validate_group(self._root, "/".join(parts[:index]), before)
        attrs_path = f"{self._image_group}/.zattrs" if self._image_group else ".zattrs"
        attributes = _json_file(self._root, attrs_path, before)
        multiscales = attributes.get("multiscales")
        if not isinstance(multiscales, list) or not multiscales:
            if not self._image_group and (
                "bioformats2raw.layout" in attributes or "plate" in attributes
            ):
                raise OMEZarrUnsupportedError(
                    "This is a collection or plate root; select one image_group explicitly."
                )
            raise OMEZarrError("The selected group has no OME-NGFF multiscales metadata.")
        if multiscale_index is None:
            if len(multiscales) != 1:
                raise OMEZarrUnsupportedError(
                    "The image group declares multiple multiscales; select "
                    "multiscale_index explicitly."
                )
            selected_index = 0
        elif (
            isinstance(multiscale_index, bool)
            or not isinstance(multiscale_index, int)
            or not 0 <= multiscale_index < len(multiscales)
        ):
            raise OMEZarrError("multiscale_index is outside the declared multiscales list.")
        else:
            selected_index = multiscale_index
        multiscale = multiscales[selected_index]
        if not isinstance(multiscale, dict):
            raise OMEZarrError("The selected OME-NGFF multiscales entry is malformed.")
        if multiscale.get("version") != "0.4":
            raise OMEZarrUnsupportedError("Only OME-NGFF version 0.4 is supported.")
        axes = _axes(multiscale.get("axes"))
        axis_names = tuple(axis.name for axis in axes)
        datasets = multiscale.get("datasets")
        if not isinstance(datasets, list) or not 1 <= len(datasets) <= MAX_LEVELS:
            raise OMEZarrError("OME-NGFF datasets must contain one through 32 levels.")
        shared_scale, shared_translation = _transform_sequence(
            multiscale.get("coordinateTransformations"),
            len(axes),
            "multiscales coordinateTransformations",
            required=False,
        )
        specs: list[_ArraySpec] = []
        levels: list[OMEZarrLevel] = []
        seen_paths: set[str] = set()
        previous_shape: tuple[int, ...] | None = None
        for level_index, dataset in enumerate(datasets):
            if not isinstance(dataset, dict) or set(dataset) != {
                "path",
                "coordinateTransformations",
            }:
                raise OMEZarrUnsupportedError(
                    "Each OME-NGFF dataset must contain only path and coordinateTransformations."
                )
            dataset_path = _safe_relative_path(dataset["path"], "dataset path")
            if dataset_path in seen_paths:
                raise OMEZarrError("OME-NGFF dataset paths must be unique.")
            seen_paths.add(dataset_path)
            relative_path = (
                f"{self._image_group}/{dataset_path}" if self._image_group else dataset_path
            )
            expected_directory = before.get(relative_path)
            if expected_directory is None or expected_directory.kind != "directory":
                raise OMEZarrError("An OME-NGFF dataset path is not a contained array directory.")
            spec = _array_spec(self._root, relative_path, len(axes), before)
            level_scale, level_translation = _transform_sequence(
                dataset["coordinateTransformations"],
                len(axes),
                f"datasets[{level_index}] coordinateTransformations",
                required=True,
            )
            scale, translation = _compose_transforms(
                level_scale, level_translation, shared_scale, shared_translation
            )
            if previous_shape is not None:
                y_index, x_index = axis_names.index("y"), axis_names.index("x")
                for index, (prior, current) in enumerate(
                    zip(previous_shape, spec.shape, strict=True)
                ):
                    if index in {y_index, x_index}:
                        if current > prior:
                            raise OMEZarrError(
                                "OME-NGFF datasets are not ordered from largest to smallest."
                            )
                    elif current != prior:
                        raise OMEZarrUnsupportedError(
                            "This reader requires non-spatial dimensions to remain fixed "
                            "across levels."
                        )
            previous_shape = spec.shape
            micrometres_per_pixel, origin_micrometres = _micrometre_xy(axes, scale, translation)
            canonical_units = _canonical(tuple(axis.unit for axis in axes), axis_names, None)
            levels.append(
                OMEZarrLevel(
                    index=level_index,
                    source_shape=spec.shape,
                    canonical_shape_tczyx=_canonical(spec.shape, axis_names, 1),
                    source_chunks=spec.chunks,
                    canonical_chunks_tczyx=_canonical(spec.chunks, axis_names, 1),
                    dtype=spec.dtype.str,
                    codec=spec.codec,
                    scale_tczyx=_canonical(scale, axis_names, 1.0),
                    translation_tczyx=_canonical(translation, axis_names, 0.0),
                    units_tczyx=canonical_units,
                    micrometres_per_pixel_xy=micrometres_per_pixel,
                    origin_micrometres_xy=origin_micrometres,
                    calibration_status=(
                        "declared-physical-units"
                        if micrometres_per_pixel is not None
                        else "relative-or-missing"
                    ),
                    decoded_chunk_bytes=spec.decoded_chunk_bytes,
                )
            )
            specs.append(spec)
        after = _inventory(self._root)
        if before != after:
            raise OMEZarrSourceChangedError(
                "The OME-Zarr store changed while its metadata was opened."
            )
        self._entries = after
        self._specs = tuple(specs)
        self._axis_names = axis_names
        self._inventory_sha256 = _inventory_digest(after)
        file_count = sum(item.kind == "file" for item in after.values())
        directory_count = sum(item.kind == "directory" for item in after.values())
        source_size = sum(item.size for item in after.values() if item.kind == "file")
        self.metadata = OMEZarrMetadata(
            ngff_version="0.4",
            zarr_format=2,
            source_axes=axes,
            canonical_axes="TCZYX",
            levels=tuple(levels),
            session_inventory_sha256=self._inventory_sha256,
            source_size_bytes=source_size,
            file_count=file_count,
            directory_count=directory_count,
            integrity_mode="stat-manifest-session",
            decoder="loci-bounded-zarr-v2",
            zarr_version=zarr.__version__,
            numcodecs_version=numcodecs.__version__,
            strict_content_manifest_sha256=None,
        )
        if expected_content_manifest_sha256 is not None:
            receipt = self.verify_strict()
            if not hmac.compare_digest(
                receipt.content_manifest_sha256, expected_content_manifest_sha256
            ):
                raise OMEZarrSourceChangedError(
                    "The OME-Zarr store does not match the expected content-manifest SHA-256."
                )

    def _verify_inventory(self) -> None:
        if _inventory(self._root) != self._entries:
            raise OMEZarrSourceChangedError(
                "The OME-Zarr store changed after this session was opened."
            )

    def verify_strict(self) -> OMEZarrIntegrityReceipt:
        """Hash every regular file into a deterministic, path-relative manifest."""

        self._verify_inventory()
        digest, count, size = _content_manifest(self._root, self._entries)
        self._verify_inventory()
        receipt = OMEZarrIntegrityReceipt(
            content_manifest_sha256=digest,
            session_inventory_sha256=self._inventory_sha256,
            file_count=count,
            source_size_bytes=size,
        )
        self.metadata = replace(self.metadata, strict_content_manifest_sha256=digest)
        return receipt

    def _chunk_relative(self, spec: _ArraySpec, coordinate: tuple[int, ...]) -> str:
        key = spec.dimension_separator.join(str(item) for item in coordinate)
        return f"{spec.relative_path}/{key}"

    def _decode_chunk(self, spec: _ArraySpec, coordinate: tuple[int, ...]) -> np.ndarray:
        relative = self._chunk_relative(spec, coordinate)
        identity = self._entries.get(relative)
        if identity is None:
            if spec.fill_value is None:
                raise OMEZarrUnsupportedError(
                    "A requested chunk is uninitialized and its fill value is undefined."
                )
            return np.full(spec.chunks, spec.fill_value, dtype=spec.dtype, order=spec.order)
        if identity.kind != "file":
            raise OMEZarrSourceChangedError("A requested Zarr chunk is no longer a regular file.")
        encoded = _open_verified_file(
            self._root, relative, self._entries, maximum=MAX_ENCODED_FILE_BYTES
        )
        try:
            if spec.compressor is None:
                decoded: Any = encoded
            elif spec.compressor["id"] in {"zlib", "gzip"}:
                decoded = _bounded_zlib_decode(
                    encoded,
                    spec.decoded_chunk_bytes,
                    gzip=spec.compressor["id"] == "gzip",
                )
            else:
                configuration = {
                    key: value for key, value in spec.compressor.items() if key != "id"
                }
                decoder = Blosc.from_config(configuration)
                output_buffer = bytearray(spec.decoded_chunk_bytes)
                decoded = decoder.decode(encoded, out=output_buffer)
            buffer = memoryview(decoded)
        except Exception as exc:
            raise OMEZarrError("A requested Zarr chunk could not be decoded safely.") from exc
        if buffer.nbytes != spec.decoded_chunk_bytes:
            raise OMEZarrError("A decoded Zarr chunk has an unexpected byte count.")
        try:
            return np.frombuffer(buffer, dtype=spec.dtype).reshape(spec.chunks, order=spec.order)
        except (TypeError, ValueError) as exc:
            raise OMEZarrError("A decoded Zarr chunk has an invalid numeric layout.") from exc

    def read_plane(self, request: OMEZarrPlaneRequest) -> OMEZarrPlane:
        """Read one bounded scalar YX rectangle at explicit T, C, and Z indices."""

        if not isinstance(request, OMEZarrPlaneRequest):
            raise OMEZarrError("read_plane requires an OMEZarrPlaneRequest.")
        budget = _working_budget(request.budget_bytes)
        for name in ("level", "t", "c", "z", "x", "y"):
            value = getattr(request, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise OMEZarrError(f"{name} must be a non-negative integer.")
        if request.level >= len(self._specs):
            raise OMEZarrError("The requested OME-Zarr level is outside the pyramid.")
        if request.expected_session_inventory_sha256 is not None:
            expected = request.expected_session_inventory_sha256
            if not isinstance(expected, str) or not _SHA256.fullmatch(expected):
                raise OMEZarrError(
                    "expected_session_inventory_sha256 must be 64 lowercase hexadecimal characters."
                )
            if not hmac.compare_digest(expected, self._inventory_sha256):
                raise OMEZarrSourceChangedError(
                    "The request is bound to a different OME-Zarr session inventory."
                )
        spec = self._specs[request.level]
        level = self.metadata.levels[request.level]
        t_size, c_size, z_size, y_size, x_size = level.canonical_shape_tczyx
        if request.t >= t_size or request.c >= c_size or request.z >= z_size:
            raise OMEZarrError("A requested T, C, or Z index is outside the selected level.")
        width = x_size - request.x if request.width is None else request.width
        height = y_size - request.y if request.height is None else request.height
        if (
            isinstance(width, bool)
            or not isinstance(width, int)
            or isinstance(height, bool)
            or not isinstance(height, int)
            or width <= 0
            or height <= 0
        ):
            raise OMEZarrError("width and height must be positive integers when supplied.")
        if request.x + width > x_size or request.y + height > y_size:
            raise OMEZarrError("The requested YX rectangle is outside the selected level.")

        canonical_indices = {"t": request.t, "c": request.c, "z": request.z}
        source_fixed = {
            index: canonical_indices[name]
            for index, name in enumerate(self._axis_names)
            if name in canonical_indices
        }
        y_axis, x_axis = self._axis_names.index("y"), self._axis_names.index("x")
        y_chunks = range(
            request.y // spec.chunks[y_axis], (request.y + height - 1) // spec.chunks[y_axis] + 1
        )
        x_chunks = range(
            request.x // spec.chunks[x_axis], (request.x + width - 1) // spec.chunks[x_axis] + 1
        )
        fixed_chunk_coordinates = {
            axis: index // spec.chunks[axis] for axis, index in source_fixed.items()
        }
        existing_encoded_max = 0
        coordinates: list[tuple[int, ...]] = []
        for y_chunk, x_chunk in product(y_chunks, x_chunks):
            coordinate = []
            for axis in range(len(spec.shape)):
                if axis == y_axis:
                    coordinate.append(y_chunk)
                elif axis == x_axis:
                    coordinate.append(x_chunk)
                else:
                    coordinate.append(fixed_chunk_coordinates[axis])
            value = tuple(coordinate)
            coordinates.append(value)
            identity = self._entries.get(self._chunk_relative(spec, value))
            if identity is not None and identity.kind == "file":
                existing_encoded_max = max(existing_encoded_max, identity.size)
        output_bytes = width * height * spec.dtype.itemsize
        estimated_peak = output_bytes + 2 * existing_encoded_max + 2 * spec.decoded_chunk_bytes
        if estimated_peak > budget:
            raise OMEZarrBudgetError(estimated_peak, budget)

        self._verify_inventory()
        output = np.empty((height, width), dtype=spec.dtype)
        for coordinate in coordinates:
            decoded = self._decode_chunk(spec, coordinate)
            chunk_origin_y = coordinate[y_axis] * spec.chunks[y_axis]
            chunk_origin_x = coordinate[x_axis] * spec.chunks[x_axis]
            global_y0 = max(request.y, chunk_origin_y)
            global_y1 = min(request.y + height, chunk_origin_y + spec.chunks[y_axis])
            global_x0 = max(request.x, chunk_origin_x)
            global_x1 = min(request.x + width, chunk_origin_x + spec.chunks[x_axis])
            selection: list[int | slice] = []
            for axis, _axis_name in enumerate(self._axis_names):
                if axis == y_axis:
                    selection.append(slice(global_y0 - chunk_origin_y, global_y1 - chunk_origin_y))
                elif axis == x_axis:
                    selection.append(slice(global_x0 - chunk_origin_x, global_x1 - chunk_origin_x))
                else:
                    selection.append(source_fixed[axis] % spec.chunks[axis])
            block = decoded[tuple(selection)]
            output[
                global_y0 - request.y : global_y1 - request.y,
                global_x0 - request.x : global_x1 - request.x,
            ] = block
        self._verify_inventory()
        if output.dtype.kind == "f" and not np.isfinite(output).all():
            raise OMEZarrError("The requested scientific plane contains non-finite values.")
        output = np.ascontiguousarray(output)
        output.setflags(write=False)
        scale_x, scale_y = level.scale_tczyx[4], level.scale_tczyx[3]
        origin_x, origin_y = level.translation_tczyx[4], level.translation_tczyx[3]
        unit_x, unit_y = level.units_tczyx[4], level.units_tczyx[3]
        physical_extent = None
        physical_units = None
        if unit_x is not None and unit_y is not None:
            physical_extent = (
                origin_x + request.x * scale_x,
                origin_y + request.y * scale_y,
                origin_x + (request.x + width) * scale_x,
                origin_y + (request.y + height) * scale_y,
            )
            physical_units = (unit_x, unit_y)
        micrometre_extent = None
        if level.micrometres_per_pixel_xy is not None and level.origin_micrometres_xy is not None:
            mpp_x, mpp_y = level.micrometres_per_pixel_xy
            micrometre_origin_x, micrometre_origin_y = level.origin_micrometres_xy
            micrometre_extent = (
                micrometre_origin_x + request.x * mpp_x,
                micrometre_origin_y + request.y * mpp_y,
                micrometre_origin_x + (request.x + width) * mpp_x,
                micrometre_origin_y + (request.y + height) * mpp_y,
            )
        return OMEZarrPlane(
            values=output,
            request=request,
            canonical_indices_tcz=(request.t, request.c, request.z),
            pixel_extent_xyxy=(request.x, request.y, request.x + width, request.y + height),
            physical_extent_xyxy=physical_extent,
            physical_unit_xy=physical_units,
            micrometre_extent_xyxy=micrometre_extent,
            source_session_inventory_sha256=self._inventory_sha256,
            integrity_mode="stat-verified-session",
            estimated_peak_bytes=estimated_peak,
        )

    def close(self) -> None:
        """Retained for symmetry with native reader sessions; no handle remains open."""

    def __enter__(self) -> OMEZarrSession:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
