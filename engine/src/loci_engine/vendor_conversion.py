"""Explicit, bounded conversion of selected Bio-Formats vendor image planes.

This module is intentionally outside the engine's automatic import path.  It
executes only an exact, user-provided Bio-Formats 8.5.0 package and converts one
explicitly selected scalar plane into a small derived OME-TIFF artifact.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np
import tifffile

from .native_image import NativeImageSession, NativeSelection

BIOFORMATS_VERSION = "8.5.0"
BIOFORMATS_JAR_SIZE = 53_843_906
BIOFORMATS_JAR_SHA256 = "c6e60665d53a334b66e4d635340151f403dfe57a64704c573dd4c03b873befb9"
BIOFORMATS_JAR_URL = (
    "https://downloads.openmicroscopy.org/bio-formats/8.5.0/artifacts/bioformats_package.jar"
)

SUPPORTED_SUFFIXES = frozenset({".czi", ".lif", ".nd2"})
MIN_HEAP_MIB = 256
MAX_HEAP_MIB = 4096
MAX_TIMEOUT_SECONDS = 1800
MAX_OUTPUT_BYTES = 1 << 30
MAX_DECODED_PLANE_BYTES = 512 << 20
MAX_CAPTURE_BYTES = 16 << 20
MAX_OME_XML_BYTES = 16 << 20
_IMAGE_INFO = "loci.formats.tools.ImageInfo"
_IMAGE_CONVERTER = "loci.formats.tools.ImageConverter"
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_INTEGER_RE = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_FIRST_MIN_RE = re.compile(r"First plane minimum\(s\) = ([^\s(]+)")
_FIRST_MAX_RE = re.compile(r"First plane maximum\(s\) = ([^\s(]+)")
_CHANNEL_BLOCK_RE = re.compile(
    r"(?ms)^\s*Channel ([0-9]+):\s*$\n(.*?)(?=^\s*Channel |^\s*First plane)"
)
_KNOWN_MIN_RE = re.compile(r"Known minimum = ([^\s(]+)")
_KNOWN_MAX_RE = re.compile(r"Known maximum = ([^\s(]+)")
_DTYPE_BYTES = {
    "int8": 1,
    "uint8": 1,
    "int16": 2,
    "uint16": 2,
    "int32": 4,
    "uint32": 4,
    "float": 4,
    "double": 8,
}
_NUMPY_DTYPES = {"float": "float32", "double": "float64"}


class VendorConversionError(RuntimeError):
    """A fail-closed vendor inspection or conversion error."""


@dataclass(frozen=True, slots=True)
class VendorConversionRequest:
    """One bounded scalar plane selection and its resource limits."""

    series: int
    c: int
    z: int
    t: int
    crop: tuple[int, int, int, int] | None = None
    heap_mib: int = 768
    timeout_seconds: int = 300
    max_output_bytes: int = 512 << 20


@dataclass(frozen=True, slots=True)
class _Identity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int
    mode: int


@dataclass(frozen=True, slots=True)
class _Runtime:
    source: Path
    source_identity: _Identity
    jar: Path
    jar_identity: _Identity
    java: Path
    jar_sha256: str
    java_sha256: str
    java_version: str


@dataclass(frozen=True, slots=True)
class _ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes


def _identity(path: Path) -> _Identity:
    try:
        info = path.stat()
    except OSError as exc:
        raise VendorConversionError("A required local file is not accessible.") from exc
    return _Identity(
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
        info.st_mode,
    )


def _regular_file(value: str | Path, label: str) -> tuple[Path, _Identity]:
    path = Path(value).absolute()
    try:
        leaf = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise VendorConversionError(f"The selected {label} is not accessible.") from exc
    if stat.S_ISLNK(leaf.st_mode) or not resolved.is_file():
        raise VendorConversionError(f"The selected {label} must be a regular, non-symlink file.")
    identity = _identity(resolved)
    if not stat.S_ISREG(identity.mode):
        raise VendorConversionError(f"The selected {label} must be a regular file.")
    return resolved, identity


def _stable_sha256(path: Path, expected_identity: _Identity | None = None) -> str:
    before = _identity(path)
    if expected_identity is not None and before != expected_identity:
        raise VendorConversionError("A selected local file changed before it could be read.")
    digest = hashlib.sha256()
    try:
        with path.open("rb", buffering=0) as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise VendorConversionError("A selected local file could not be read completely.") from exc
    if _identity(path) != before:
        raise VendorConversionError("A selected local file changed while it was being read.")
    return digest.hexdigest()


def _trusted_java(value: str | Path) -> tuple[Path, _Identity, str]:
    path, identity = _regular_file(value, "Java executable")
    if not os.access(path, os.X_OK):
        raise VendorConversionError("The selected Java executable is not executable.")
    if identity.mode & 0o022 or path.stat().st_uid not in {0, os.getuid()}:
        raise VendorConversionError(
            "The Java executable must be owned by root or the current user and "
            "not group/world writable."
        )
    return path, identity, _stable_sha256(path, identity)


def _validate_runtime(
    source_value: str | Path,
    jar_value: str | Path,
    java_value: str | Path,
    *,
    heap_mib: int,
    timeout_seconds: int,
) -> _Runtime:
    source, source_identity = _regular_file(source_value, "vendor source")
    if source.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise VendorConversionError("Only explicit .czi, .lif, and .nd2 sources are supported.")
    if source_identity.size <= 0:
        raise VendorConversionError("The selected vendor source is empty.")
    jar, jar_identity = _regular_file(jar_value, "Bio-Formats JAR")
    if jar_identity.size != BIOFORMATS_JAR_SIZE:
        raise VendorConversionError("The Bio-Formats JAR is not the approved 8.5.0 artifact.")
    jar_sha256 = _stable_sha256(jar, jar_identity)
    if jar_sha256 != BIOFORMATS_JAR_SHA256:
        raise VendorConversionError("The Bio-Formats JAR is not the approved 8.5.0 artifact.")
    java, _java_identity, java_sha256 = _trusted_java(java_value)
    with tempfile.TemporaryDirectory(prefix="loci-vendor-java-") as scratch_value:
        scratch = Path(scratch_value)
        result = _run_bounded(
            _java_prefix(java, jar, heap_mib, scratch)[:-2] + ["-version"],
            cwd=scratch,
            timeout_seconds=min(timeout_seconds, 30),
            max_capture_bytes=256 << 10,
        )
    if result.returncode != 0:
        raise VendorConversionError("The selected Java runtime could not report its version.")
    version_output = (result.stderr + b"\n" + result.stdout).decode("utf-8", errors="replace")
    version_line = next((line.strip() for line in version_output.splitlines() if line.strip()), "")
    if not version_line or len(version_line) > 240:
        raise VendorConversionError("The selected Java runtime returned an invalid version.")
    return _Runtime(
        source,
        source_identity,
        jar,
        jar_identity,
        java,
        jar_sha256,
        java_sha256,
        version_line,
    )


def _java_prefix(java: Path, jar: Path, heap_mib: int, scratch: Path) -> list[str]:
    return [
        str(java),
        "-Djava.awt.headless=true",
        "-Dfile.encoding=UTF-8",
        f"-Duser.home={scratch}",
        f"-Djava.io.tmpdir={scratch}",
        f"-Xmx{heap_mib}m",
        "-cp",
        str(jar),
    ]


def _private_jar_copy(runtime: _Runtime, directory: Path) -> _Runtime:
    """Copy the verified JAR so the executed bytes cannot change concurrently."""

    copied = directory / ".bioformats-8.5.0.jar"
    try:
        source_descriptor = os.open(runtime.jar, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            destination_descriptor = os.open(
                copied,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            try:
                with (
                    os.fdopen(source_descriptor, "rb", closefd=False) as source_handle,
                    os.fdopen(destination_descriptor, "wb", closefd=False) as output_handle,
                ):
                    shutil.copyfileobj(source_handle, output_handle, length=1024 * 1024)
                    output_handle.flush()
                    os.fsync(output_handle.fileno())
            finally:
                os.close(destination_descriptor)
        finally:
            os.close(source_descriptor)
    except OSError as exc:
        raise VendorConversionError("The approved Bio-Formats JAR could not be isolated.") from exc
    if (
        _identity(runtime.jar) != runtime.jar_identity
        or _identity(copied).size != BIOFORMATS_JAR_SIZE
        or _stable_sha256(copied) != BIOFORMATS_JAR_SHA256
    ):
        raise VendorConversionError("The Bio-Formats JAR changed while it was being isolated.")
    return replace(runtime, jar=copied, jar_identity=_identity(copied))


def _child_environment() -> dict[str, str]:
    # In particular, do not inherit CLASSPATH, JAVA_TOOL_OPTIONS,
    # _JAVA_OPTIONS, or JDK_JAVA_OPTIONS.
    return {
        "PATH": "/usr/bin:/bin",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "en_US.UTF-8",
        "TZ": "UTC",
    }


def _run_bounded(
    argv: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    max_capture_bytes: int = MAX_CAPTURE_BYTES,
    watched_output: Path | None = None,
    max_output_bytes: int | None = None,
) -> _ProcessResult:
    if not argv or any(not isinstance(value, str) or "\x00" in value for value in argv):
        raise VendorConversionError("The local converter command is invalid.")
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=_child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=True,
        )
    except OSError as exc:
        raise VendorConversionError("The local vendor reader could not be started.") from exc

    captured = {"stdout": bytearray(), "stderr": bytearray()}
    overflow = threading.Event()

    def drain(name: str, stream: Any) -> None:
        try:
            while data := stream.read(64 << 10):
                target = captured[name]
                remaining = max_capture_bytes - len(target)
                if remaining > 0:
                    target.extend(data[:remaining])
                if len(data) > remaining:
                    overflow.set()
                    break
        finally:
            stream.close()

    assert process.stdout is not None and process.stderr is not None
    threads = [
        threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
    ]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout_seconds
    failure: str | None = None
    while process.poll() is None:
        if overflow.is_set():
            failure = "The local vendor reader exceeded its diagnostic-output limit."
            break
        if time.monotonic() >= deadline:
            failure = "The local vendor reader exceeded its time limit."
            break
        if watched_output is not None and max_output_bytes is not None:
            try:
                if watched_output.stat().st_size > max_output_bytes:
                    failure = "The converted artifact exceeded its output-size limit."
                    break
            except FileNotFoundError:
                pass
            except OSError:
                failure = "The converted artifact could not be monitored safely."
                break
        time.sleep(0.025)
    if failure is not None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            process.kill()
    process.wait()
    for thread in threads:
        thread.join(timeout=2)
    if failure is not None:
        raise VendorConversionError(failure)
    if overflow.is_set():
        raise VendorConversionError("The local vendor reader exceeded its diagnostic-output limit.")
    return _ProcessResult(process.returncode, bytes(captured["stdout"]), bytes(captured["stderr"]))


def _positive_integer(raw: str | None, label: str) -> int:
    if raw is None or _INTEGER_RE.fullmatch(raw) is None:
        raise VendorConversionError(f"Bio-Formats returned an invalid {label}.")
    value = int(raw)
    if value <= 0 or value > 2**31 - 1:
        raise VendorConversionError(f"Bio-Formats returned an out-of-range {label}.")
    return value


def _safe_channel_name(raw: str | None, index: int) -> str:
    name = (raw or "").strip()
    if (
        not name
        or len(name) > 160
        or any(ord(character) < 32 for character in name)
        or "/" in name
        or "\\" in name
    ):
        return f"Channel {index + 1}"
    return name


def _parse_calibration(pixels: ET.Element) -> dict[str, dict[str, float | str]] | None:
    present = {axis: f"PhysicalSize{axis}" in pixels.attrib for axis in "XYZ"}
    unit_present = {axis: f"PhysicalSize{axis}Unit" in pixels.attrib for axis in "XYZ"}
    if any(unit_present[axis] and not present[axis] for axis in "XYZ"):
        raise VendorConversionError("Bio-Formats returned incomplete physical calibration.")
    if not any(present.values()):
        return None
    if not present["X"] or not present["Y"]:
        raise VendorConversionError("Bio-Formats returned incomplete X/Y physical calibration.")
    calibration: dict[str, dict[str, float | str]] = {}
    for axis in "XYZ":
        if not present[axis]:
            continue
        try:
            value = float(pixels.attrib[f"PhysicalSize{axis}"])
        except (TypeError, ValueError) as exc:
            raise VendorConversionError(
                "Bio-Formats returned invalid physical calibration."
            ) from exc
        unit = pixels.attrib.get(f"PhysicalSize{axis}Unit", "µm").strip()
        if not math.isfinite(value) or value <= 0 or not unit or len(unit) > 24:
            raise VendorConversionError("Bio-Formats returned invalid physical calibration.")
        calibration[axis.lower()] = {"value": value, "unit": unit}
    return calibration


def _parse_ome_xml(output: bytes) -> list[dict[str, Any]]:
    start = output.find(b"<?xml")
    end = output.rfind(b"</OME>")
    if start < 0 or end < start:
        raise VendorConversionError("Bio-Formats did not return complete OME-XML metadata.")
    xml = output[start : end + len(b"</OME>")]
    if len(xml) > MAX_OME_XML_BYTES or b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
        raise VendorConversionError("Bio-Formats returned unsafe or oversized OME-XML metadata.")
    try:
        root = ET.fromstring(xml.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, ET.ParseError) as exc:
        raise VendorConversionError("Bio-Formats returned malformed OME-XML metadata.") from exc
    images = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "Image"]
    if not images or len(images) > 100_000:
        raise VendorConversionError("Bio-Formats returned an invalid series count.")
    records: list[dict[str, Any]] = []
    for index, image in enumerate(images):
        pixels = next((child for child in image if child.tag.rsplit("}", 1)[-1] == "Pixels"), None)
        if pixels is None:
            raise VendorConversionError("Bio-Formats returned a series without Pixels metadata.")
        dimensions = {
            axis.lower(): _positive_integer(pixels.attrib.get(f"Size{axis}"), f"Size{axis}")
            for axis in "XYZCT"
        }
        dtype = pixels.attrib.get("Type", "").strip()
        if dtype not in _DTYPE_BYTES:
            raise VendorConversionError("Bio-Formats returned an unsupported pixel type.")
        dimension_order = pixels.attrib.get("DimensionOrder", "").strip()
        if len(dimension_order) != 5 or set(dimension_order) != set("XYZCT"):
            raise VendorConversionError("Bio-Formats returned an invalid dimension order.")
        channels = [child for child in pixels if child.tag.rsplit("}", 1)[-1] == "Channel"]
        if not channels:
            raise VendorConversionError("Bio-Formats returned no channel metadata.")
        samples: list[int] = []
        names: list[str] = []
        for channel_index, channel in enumerate(channels):
            samples.append(
                _positive_integer(channel.attrib.get("SamplesPerPixel", "1"), "SamplesPerPixel")
            )
            names.append(_safe_channel_name(channel.attrib.get("Name"), channel_index))
        if sum(samples) != dimensions["c"]:
            raise VendorConversionError("Bio-Formats channel metadata disagrees with SizeC.")
        records.append(
            {
                "index": index,
                "dimensions": {
                    "x": dimensions["x"],
                    "y": dimensions["y"],
                    "z": dimensions["z"],
                    "c": len(channels),
                    "t": dimensions["t"],
                },
                "dimension_order": dimension_order,
                "dtype": _NUMPY_DTYPES.get(dtype, dtype),
                "channel_names": names,
                "samples_per_channel": samples,
                "calibration": _parse_calibration(pixels),
            }
        )
    return records


def _validate_limits(heap_mib: int, timeout_seconds: int) -> None:
    if isinstance(heap_mib, bool) or not isinstance(heap_mib, int):
        raise VendorConversionError("heap_mib must be an integer.")
    if not MIN_HEAP_MIB <= heap_mib <= MAX_HEAP_MIB:
        raise VendorConversionError(f"heap_mib must be within {MIN_HEAP_MIB}..{MAX_HEAP_MIB}.")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int):
        raise VendorConversionError("timeout_seconds must be an integer.")
    if not 1 <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise VendorConversionError(f"timeout_seconds must be within 1..{MAX_TIMEOUT_SECONDS}.")


def _inspect(
    runtime: _Runtime, *, heap_mib: int, timeout_seconds: int
) -> tuple[list[dict[str, Any]], str]:
    with tempfile.TemporaryDirectory(prefix="loci-vendor-inspect-") as scratch_value:
        scratch = Path(scratch_value)
        execution_runtime = _private_jar_copy(runtime, scratch)
        command = _java_prefix(execution_runtime.java, execution_runtime.jar, heap_mib, scratch) + [
            _IMAGE_INFO,
            str(runtime.source),
            "-nopix",
            "-omexml-only",
            "-no-upgrade",
            "-nogroup",
            "-no-sas",
        ]
        result = _run_bounded(
            command,
            cwd=scratch,
            timeout_seconds=timeout_seconds,
            max_capture_bytes=MAX_CAPTURE_BYTES,
        )
    if result.returncode != 0:
        raise VendorConversionError("Bio-Formats could not inspect the selected vendor source.")
    series = _parse_ome_xml(result.stdout)
    source_sha256 = _stable_sha256(runtime.source, runtime.source_identity)
    if _identity(runtime.jar) != runtime.jar_identity:
        raise VendorConversionError("The Bio-Formats JAR changed during inspection.")
    return series, source_sha256


def inspect_vendor(
    source: str | Path,
    jar: str | Path,
    java: str | Path = "/usr/bin/java",
    *,
    heap_mib: int = 768,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    """Inspect an explicit vendor file with the exact approved Bio-Formats JAR.

    The result contains no source, JAR, Java, home, or temporary filesystem path.
    """

    _validate_limits(heap_mib, timeout_seconds)
    runtime = _validate_runtime(
        source, jar, java, heap_mib=heap_mib, timeout_seconds=timeout_seconds
    )
    series, source_sha256 = _inspect(runtime, heap_mib=heap_mib, timeout_seconds=timeout_seconds)
    return {
        "schema_version": "loci.vendor-inspection/v1",
        "format": runtime.source.suffix.lower().removeprefix("."),
        "source_size_bytes": runtime.source_identity.size,
        "source_sha256": source_sha256,
        "series": series,
        "runtime": {
            "bioformats_version": BIOFORMATS_VERSION,
            "bioformats_jar_sha256": runtime.jar_sha256,
            "bioformats_jar_size_bytes": runtime.jar_identity.size,
            "java_sha256": runtime.java_sha256,
            "java_version": runtime.java_version,
        },
    }


def _request(value: VendorConversionRequest | Mapping[str, Any]) -> VendorConversionRequest:
    if isinstance(value, VendorConversionRequest):
        request = value
    elif isinstance(value, Mapping):
        expected = {
            "series",
            "c",
            "z",
            "t",
            "crop",
            "heap_mib",
            "timeout_seconds",
            "max_output_bytes",
        }
        if set(value) - expected or not {"series", "c", "z", "t"}.issubset(value):
            raise VendorConversionError(
                "The conversion request has unknown fields or omits series/c/z/t."
            )
        try:
            request = VendorConversionRequest(**value)
        except TypeError as exc:
            raise VendorConversionError("The conversion request is invalid.") from exc
    else:
        raise VendorConversionError("request must be a VendorConversionRequest or mapping.")
    for label in ("series", "c", "z", "t"):
        selected = getattr(request, label)
        if isinstance(selected, bool) or not isinstance(selected, int) or selected < 0:
            raise VendorConversionError(f"{label} must be a non-negative integer.")
    _validate_limits(request.heap_mib, request.timeout_seconds)
    if (
        isinstance(request.max_output_bytes, bool)
        or not isinstance(request.max_output_bytes, int)
        or not 1 <= request.max_output_bytes <= MAX_OUTPUT_BYTES
    ):
        raise VendorConversionError(
            f"max_output_bytes must be an integer within 1..{MAX_OUTPUT_BYTES}."
        )
    if request.crop is not None:
        if (
            not isinstance(request.crop, (tuple, list))
            or len(request.crop) != 4
            or any(isinstance(item, bool) or not isinstance(item, int) for item in request.crop)
        ):
            raise VendorConversionError("crop must contain integer x, y, width, height values.")
        x, y, width, height = request.crop
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise VendorConversionError("crop must be a positive half-open rectangle.")
        if not isinstance(request.crop, tuple):
            request = VendorConversionRequest(**{**asdict(request), "crop": tuple(request.crop)})
    return request


def _resolve_selection(
    request: VendorConversionRequest, series_records: list[dict[str, Any]]
) -> tuple[dict[str, Any], tuple[int, int, int, int], int]:
    if request.series >= len(series_records):
        raise VendorConversionError("The selected series is outside the inspected source.")
    series = series_records[request.series]
    dimensions = series["dimensions"]
    for label in ("c", "z", "t"):
        if getattr(request, label) >= dimensions[label]:
            raise VendorConversionError(f"The selected {label} index is outside the source series.")
    if series["samples_per_channel"][request.c] != 1:
        raise VendorConversionError(
            "Conversion currently requires a scalar channel; RGB sample components are not "
            "biological channels."
        )
    crop = request.crop or (0, 0, dimensions["x"], dimensions["y"])
    x, y, width, height = crop
    if x + width > dimensions["x"] or y + height > dimensions["y"]:
        raise VendorConversionError("The crop lies outside the selected source series.")
    decoded_bytes = (
        width
        * height
        * _DTYPE_BYTES[
            "float"
            if series["dtype"] == "float32"
            else "double"
            if series["dtype"] == "float64"
            else series["dtype"]
        ]
    )
    if decoded_bytes > MAX_DECODED_PLANE_BYTES or decoded_bytes > request.max_output_bytes:
        raise VendorConversionError("The selected plane exceeds the decoded/output byte budget.")
    return series, crop, decoded_bytes


def _plane_index(series: dict[str, Any], request: VendorConversionRequest) -> int:
    coordinates = {"C": request.c, "Z": request.z, "T": request.t}
    sizes = {
        "C": series["dimensions"]["c"],
        "Z": series["dimensions"]["z"],
        "T": series["dimensions"]["t"],
    }
    index = 0
    multiplier = 1
    for axis in series["dimension_order"][2:]:
        index += coordinates[axis] * multiplier
        multiplier *= sizes[axis]
    return index


def _reader_minmax(
    runtime: _Runtime,
    request: VendorConversionRequest,
    series: dict[str, Any],
    crop: tuple[int, int, int, int],
    scratch: Path,
) -> tuple[float, float]:
    plane = _plane_index(series, request)
    command = _java_prefix(runtime.java, runtime.jar, request.heap_mib, scratch) + [
        _IMAGE_INFO,
        str(runtime.source),
        "-nometa",
        "-nocore",
        "-minmax",
        "-range",
        str(plane),
        str(plane),
        "-series",
        str(request.series),
        "-crop",
        ",".join(str(value) for value in crop),
        "-no-upgrade",
        "-nogroup",
        "-no-sas",
    ]
    result = _run_bounded(
        command,
        cwd=scratch,
        timeout_seconds=request.timeout_seconds,
        max_capture_bytes=MAX_CAPTURE_BYTES,
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    expected_headless_exit = (
        result.returncode == 1 and b"java.awt.HeadlessException" in result.stderr
    )
    if result.returncode != 0 and not expected_headless_exit:
        raise VendorConversionError("Bio-Formats could not calculate source-plane bounds.")
    minimum_match = _FIRST_MIN_RE.search(stdout)
    maximum_match = _FIRST_MAX_RE.search(stdout)
    if (
        minimum_match is None
        or maximum_match is None
        or minimum_match.group(1) == "none"
        or maximum_match.group(1) == "none"
    ):
        selected_block = next(
            (
                block
                for channel, block in _CHANNEL_BLOCK_RE.findall(stdout)
                if int(channel) == request.c
            ),
            "",
        )
        minimum_match = _KNOWN_MIN_RE.search(selected_block)
        maximum_match = _KNOWN_MAX_RE.search(selected_block)
    if minimum_match is None or maximum_match is None or "[done]" not in stdout:
        raise VendorConversionError("Bio-Formats returned incomplete source-plane bounds.")
    try:
        minimum = float(minimum_match.group(1))
        maximum = float(maximum_match.group(1))
    except ValueError as exc:
        raise VendorConversionError("Bio-Formats returned invalid source-plane bounds.") from exc
    if not math.isfinite(minimum) or not math.isfinite(maximum) or minimum > maximum:
        raise VendorConversionError("Bio-Formats returned non-finite source-plane bounds.")
    return minimum, maximum


def _normalize_output_ome(
    path: Path, request: VendorConversionRequest, series: dict[str, Any]
) -> None:
    """Remove stale unselected Plane records emitted by bfconvert 8.5.0.

    Bio-Formats already rewrites SizeC/Z/T and TiffData for the selected plane,
    but retains Plane metadata from the unselected source coordinates for some
    formats.  Keep at most the matching source Plane and rebase its indices.
    """

    try:
        with tifffile.TiffFile(path, mode="r+b") as tif:
            if len(tif.pages) != 1:
                raise VendorConversionError("The converter did not produce exactly one TIFF plane.")
            page = tif.pages[0]
            tag = page.tags.get("ImageDescription")
            if tag is None or not isinstance(page.description, str):
                raise VendorConversionError("The converted TIFF has no OME metadata.")
            raw = page.description.encode("utf-8")
            if len(raw) > MAX_OME_XML_BYTES or b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
                raise VendorConversionError("The converted TIFF has unsafe or oversized metadata.")
            root = ET.fromstring(page.description)
            images = [
                element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "Image"
            ]
            if len(images) != 1:
                raise VendorConversionError("The converter did not produce one OME Image record.")
            pixels = next(
                (child for child in images[0] if child.tag.rsplit("}", 1)[-1] == "Pixels"), None
            )
            if pixels is None:
                raise VendorConversionError("The converted TIFF has no Pixels record.")
            expected = {
                "SizeX": str(
                    (request.crop or (0, 0, series["dimensions"]["x"], series["dimensions"]["y"]))[
                        2
                    ]
                ),
                "SizeY": str(
                    (request.crop or (0, 0, series["dimensions"]["x"], series["dimensions"]["y"]))[
                        3
                    ]
                ),
                "SizeZ": "1",
                "SizeC": "1",
                "SizeT": "1",
            }
            if any(pixels.attrib.get(key) != value for key, value in expected.items()):
                raise VendorConversionError(
                    "The converted TIFF dimensions disagree with the request."
                )
            planes = [child for child in pixels if child.tag.rsplit("}", 1)[-1] == "Plane"]
            matching = [
                plane
                for plane in planes
                if plane.attrib.get("TheC") == str(request.c)
                and plane.attrib.get("TheZ") == str(request.z)
                and plane.attrib.get("TheT") == str(request.t)
            ]
            if len(matching) > 1:
                raise VendorConversionError(
                    "The converted TIFF has duplicate selected Plane metadata."
                )
            retained = matching[0] if matching else None
            if (
                retained is None
                and len(planes) == 1
                and all(planes[0].attrib.get(axis) == "0" for axis in ("TheC", "TheZ", "TheT"))
            ):
                retained = planes[0]
            for plane in planes:
                pixels.remove(plane)
            if retained is not None:
                retained.attrib.update({"TheC": "0", "TheZ": "0", "TheT": "0"})
                pixels.append(retained)
            namespace = root.tag.partition("}")[0].removeprefix("{")
            if namespace:
                ET.register_namespace("", namespace)
            ET.register_namespace("xsi", "http://www.w3.org/2001/XMLSchema-instance")
            normalized = ET.tostring(root, encoding="ascii", xml_declaration=True).decode("ascii")
            if len(normalized.encode("ascii")) > len(raw):
                raise VendorConversionError("The normalized OME metadata does not fit safely.")
            tag.overwrite(normalized)
    except VendorConversionError:
        raise
    except (OSError, ET.ParseError, tifffile.TiffFileError) as exc:
        raise VendorConversionError(
            "The converted OME-TIFF could not be normalized safely."
        ) from exc


def _calibration_snapshot(metadata: Any) -> dict[str, Any] | None:
    calibration = metadata.physical_calibration
    if calibration is None:
        return None
    return {
        "axes": calibration.axes,
        "spacing": list(calibration.spacing),
        "unit": calibration.unit,
    }


def _expected_calibration(series: dict[str, Any]) -> dict[str, Any] | None:
    calibration = series["calibration"]
    if calibration is None:
        return None
    factors = {
        "ym": 1e-18,
        "zm": 1e-15,
        "am": 1e-12,
        "fm": 1e-9,
        "pm": 1e-6,
        "nm": 1e-3,
        "µm": 1.0,
        "um": 1.0,
        "mm": 1e3,
        "cm": 1e4,
        "dm": 1e5,
        "m": 1e6,
        "pixel": 1.0,
    }
    axes = "ZYX" if "z" in calibration else "YX"
    units = [str(calibration[axis.lower()]["unit"]) for axis in axes]
    if any(unit not in factors for unit in units):
        raise VendorConversionError("The source uses an unsupported physical calibration unit.")
    pixel_units = all(unit == "pixel" for unit in units)
    if "pixel" in units and not pixel_units:
        raise VendorConversionError("The source mixes pixel and physical calibration units.")
    return {
        "axes": axes,
        "spacing": [
            float(calibration[axis.lower()]["value"]) * factors[unit]
            for axis, unit in zip(axes, units, strict=True)
        ],
        "unit": "pixel" if pixel_units else "µm",
    }


def _verify_output(
    path: Path,
    request: VendorConversionRequest,
    series: dict[str, Any],
    crop: tuple[int, int, int, int],
    decoded_bytes: int,
    reader_bounds: tuple[float, float],
) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
    width, height = crop[2], crop[3]
    try:
        with NativeImageSession(path) as session:
            metadata = session.metadata
            if (
                metadata.dimensions.x != width
                or metadata.dimensions.y != height
                or metadata.dimensions.z != 1
                or metadata.dimensions.c != 1
                or metadata.dimensions.t != 1
                or metadata.dimensions.s != 1
            ):
                raise VendorConversionError("The converted TIFF axes disagree with the request.")
            if metadata.channel_dtypes != (series["dtype"],):
                raise VendorConversionError(
                    "The converted TIFF dtype differs from the source plane."
                )
            expected_calibration = _expected_calibration(series)
            observed_calibration = _calibration_snapshot(metadata)
            if expected_calibration is None:
                if observed_calibration is not None:
                    raise VendorConversionError("The converted TIFF invented physical calibration.")
            elif observed_calibration is None or (
                observed_calibration["axes"] != expected_calibration["axes"]
                or observed_calibration["unit"] != expected_calibration["unit"]
                or not np.allclose(
                    observed_calibration["spacing"],
                    expected_calibration["spacing"],
                    rtol=1e-12,
                    atol=0.0,
                )
            ):
                raise VendorConversionError("The converted TIFF physical calibration changed.")
            region = session.read_region(
                NativeSelection(
                    x=0,
                    y=0,
                    width=width,
                    height=height,
                    budget_bytes=max(decoded_bytes * 4, 1 << 20),
                )
            )
            pixels = np.asarray(region.pixels)
            if pixels.shape != (height, width) or pixels.dtype.name != series["dtype"]:
                raise VendorConversionError("The converted TIFF decoded shape or dtype changed.")
            if np.issubdtype(pixels.dtype, np.floating) and not np.isfinite(pixels).all():
                raise VendorConversionError("The converted TIFF contains non-finite pixel values.")
            observed_min = float(np.min(pixels))
            observed_max = float(np.max(pixels))
            if observed_min != reader_bounds[0] or observed_max != reader_bounds[1]:
                raise VendorConversionError(
                    "The converted TIFF bounds differ from Bio-Formats' source-plane bounds."
                )
            strict = session.verify_strict()
            pixel_digest = hashlib.sha256()
            pixel_digest.update(pixels.dtype.str.encode("ascii"))
            pixel_digest.update(json.dumps(list(pixels.shape), separators=(",", ":")).encode())
            pixel_digest.update(np.ascontiguousarray(pixels).tobytes(order="C"))
            summary = {
                "minimum": observed_min,
                "maximum": observed_max,
                "all_finite": True,
                "bioformats_reader_reported_minimum": reader_bounds[0],
                "bioformats_reader_reported_maximum": reader_bounds[1],
                "bounds_check_scope": "selected scalar source plane and crop",
            }
            return strict.sha256, pixel_digest.hexdigest(), observed_calibration, summary
    except VendorConversionError:
        raise
    except Exception as exc:
        raise VendorConversionError("Loci could not verify the converted OME-TIFF.") from exc


def _fsync_file(path: Path) -> None:
    # Windows rejects fsync on a read-only CRT descriptor.
    with path.open("rb+") as handle:
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        if os.name == "nt":
            # Windows does not expose directory handles as CRT descriptors.
            return
        raise
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _rename_no_replace(source: Path, destination: Path) -> None:
    if os.name == "nt":
        try:
            # Windows os.rename already fails when the destination exists.
            os.rename(source, destination)
        except FileExistsError as exc:
            raise VendorConversionError("The destination already exists.") from exc
        except OSError as exc:
            raise VendorConversionError(
                "The converted artifact could not be published atomically."
            ) from exc
        return
    libc = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    if sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        result = libc.renamex_np(source_bytes, destination_bytes, 0x00000004)
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        result = libc.renameat2(-100, source_bytes, -100, destination_bytes, 1)
    else:
        raise VendorConversionError(
            "Atomic no-replace publication is unsupported on this platform."
        )
    if result != 0:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise VendorConversionError("The destination already exists.")
        raise VendorConversionError("The converted artifact could not be published atomically.")


def convert_vendor(
    source: str | Path,
    jar: str | Path,
    destination: str | Path,
    request: VendorConversionRequest | Mapping[str, Any],
    java: str | Path = "/usr/bin/java",
    *,
    expected_source_sha256: str | None = None,
) -> dict[str, Any]:
    """Convert one bounded scalar plane into an atomic derived artifact folder."""

    checked_request = _request(request)
    if expected_source_sha256 is not None and (
        not isinstance(expected_source_sha256, str)
        or _SHA256_RE.fullmatch(expected_source_sha256) is None
    ):
        raise VendorConversionError("expected_source_sha256 must be a lowercase SHA-256 digest.")
    runtime = _validate_runtime(
        source,
        jar,
        java,
        heap_mib=checked_request.heap_mib,
        timeout_seconds=checked_request.timeout_seconds,
    )
    destination_path = Path(destination).absolute()
    try:
        destination_leaf = destination_path.lstat()
    except FileNotFoundError:
        destination_leaf = None
    except OSError as exc:
        raise VendorConversionError("The destination cannot be inspected safely.") from exc
    if destination_leaf is not None:
        raise VendorConversionError("The destination already exists.")
    try:
        parent = destination_path.parent.resolve(strict=True)
    except OSError as exc:
        raise VendorConversionError("The destination parent does not exist.") from exc
    if not parent.is_dir():
        raise VendorConversionError("The destination parent is not a directory.")
    destination_path = parent / destination_path.name
    series_records, source_sha256 = _inspect(
        runtime,
        heap_mib=checked_request.heap_mib,
        timeout_seconds=checked_request.timeout_seconds,
    )
    if expected_source_sha256 is not None and source_sha256 != expected_source_sha256:
        raise VendorConversionError("The vendor source differs from the inspected fingerprint.")
    selected, crop, decoded_bytes = _resolve_selection(checked_request, series_records)

    stage = Path(tempfile.mkdtemp(prefix=".loci-vendor-stage-", dir=parent))
    parent_identity = _identity(parent)
    output = stage / "image.ome.tif"
    provenance = stage / "provenance.json"
    published = False
    try:
        execution_runtime = _private_jar_copy(runtime, stage)
        reader_bounds = _reader_minmax(execution_runtime, checked_request, selected, crop, stage)
        command = _java_prefix(
            execution_runtime.java,
            execution_runtime.jar,
            checked_request.heap_mib,
            stage,
        ) + [
            _IMAGE_CONVERTER,
            "-series",
            str(checked_request.series),
            "-channel",
            str(checked_request.c),
            "-z",
            str(checked_request.z),
            "-timepoint",
            str(checked_request.t),
            "-crop",
            ",".join(str(value) for value in crop),
            "-tilex",
            "512",
            "-tiley",
            "512",
            "-no-upgrade",
            "-nogroup",
            "-no-sas",
            "-nolookup",
            "-nooverwrite",
            "-compression",
            "zlib",
            str(runtime.source),
            str(output),
        ]
        result = _run_bounded(
            command,
            cwd=stage,
            timeout_seconds=checked_request.timeout_seconds,
            max_capture_bytes=MAX_CAPTURE_BYTES,
            watched_output=output,
            max_output_bytes=checked_request.max_output_bytes,
        )
        if result.returncode != 0 or not output.is_file():
            raise VendorConversionError("Bio-Formats could not convert the selected source plane.")
        execution_runtime.jar.unlink()
        if output.stat().st_size > checked_request.max_output_bytes:
            raise VendorConversionError("The converted artifact exceeded its output-size limit.")
        unexpected = sorted(path.name for path in stage.iterdir() if path.name != output.name)
        if unexpected:
            raise VendorConversionError("Bio-Formats created unexpected companion artifacts.")
        _normalize_output_ome(output, checked_request, selected)
        output_sha256, pixel_sha256, calibration, numeric_summary = _verify_output(
            output,
            checked_request,
            selected,
            crop,
            decoded_bytes,
            reader_bounds,
        )
        if _stable_sha256(runtime.source, runtime.source_identity) != source_sha256:
            raise VendorConversionError("The vendor source changed during conversion.")
        if (
            _identity(runtime.jar) != runtime.jar_identity
            or _stable_sha256(runtime.jar, runtime.jar_identity) != runtime.jar_sha256
        ):
            raise VendorConversionError("The Bio-Formats JAR changed during conversion.")
        record = {
            "schema_version": "loci.vendor-conversion/v1",
            "source": {
                "format": runtime.source.suffix.lower().removeprefix("."),
                "size_bytes": runtime.source_identity.size,
                "sha256_before": source_sha256,
                "sha256_after": source_sha256,
            },
            "selection": {
                "series": checked_request.series,
                "c": checked_request.c,
                "z": checked_request.z,
                "t": checked_request.t,
                "crop_xywh": list(crop),
            },
            "source_series": selected,
            "runtime": {
                "bioformats_version": BIOFORMATS_VERSION,
                "bioformats_jar_sha256": runtime.jar_sha256,
                "bioformats_jar_size_bytes": runtime.jar_identity.size,
                "java_sha256": runtime.java_sha256,
                "java_version": runtime.java_version,
            },
            "artifact": {
                "filename": output.name,
                "sha256": output_sha256,
                "pixel_sha256": pixel_sha256,
                "axes": "YX",
                "shape": [crop[3], crop[2]],
                "dtype": selected["dtype"],
                "calibration": calibration,
                "numeric_summary": numeric_summary,
            },
            "limits": {
                "heap_mib": checked_request.heap_mib,
                "timeout_seconds": checked_request.timeout_seconds,
                "max_output_bytes": checked_request.max_output_bytes,
                "decoded_plane_bytes": decoded_bytes,
            },
        }
        provenance.write_text(
            json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n",
            encoding="utf-8",
        )
        os.chmod(output, 0o600)
        os.chmod(provenance, 0o600)
        provenance_sha256 = _stable_sha256(provenance)
        _fsync_file(output)
        _fsync_file(provenance)
        _fsync_directory(stage)
        if _identity(parent) != parent_identity:
            raise VendorConversionError("The destination parent changed during conversion.")
        _rename_no_replace(stage, destination_path)
        published = True
        _fsync_directory(parent)
        return {
            "schema_version": "loci.vendor-conversion-receipt/v1",
            "source_sha256": source_sha256,
            "bioformats_jar_sha256": runtime.jar_sha256,
            "selection": record["selection"],
            "runtime": record["runtime"],
            "artifact": {
                "filename": output.name,
                "sha256": output_sha256,
                "pixel_sha256": pixel_sha256,
                "axes": record["artifact"]["axes"],
                "shape": record["artifact"]["shape"],
                "dtype": record["artifact"]["dtype"],
                "calibration": record["artifact"]["calibration"],
                "numeric_summary": record["artifact"]["numeric_summary"],
            },
            "provenance": {
                "filename": provenance.name,
                "sha256": provenance_sha256,
            },
        }
    finally:
        if not published:
            shutil.rmtree(stage, ignore_errors=True)
