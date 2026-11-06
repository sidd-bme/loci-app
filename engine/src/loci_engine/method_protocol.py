"""Data-only contracts for bounded, zero-import custom methods.

Registration is not compilation, execution, adoption or scientific approval.
The only supported ABI is a 2D uint32 label plane and CYX raw scalar channels.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from dataclasses import dataclass
from typing import Any

ABI = "loci-method-buffers/v1"
MANIFEST_SCHEMA = "loci.controlled-method/v1"
MAX_MODULE_BYTES = 256 * 1024
MAX_MEMORY_PAGES = 512  # 32 MiB, including all input/output and method scratch.
MAX_PIXELS = 262_144
MAX_CHANNELS = 8
MAX_OBJECTS = 16_384
MAX_METRICS = 16
MAX_METADATA_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 16 + MAX_OBJECTS * (4 + 8 * MAX_METRICS)
MAX_INPUT_BYTES = 24 + MAX_METADATA_BYTES + MAX_PIXELS * (4 + 8 * MAX_CHANNELS)
INPUT_MAGIC = b"LOCIMI01"
OUTPUT_MAGIC = b"LOCIMO01"
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_ID = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")


class MethodContractError(ValueError):
    """An unsupported or unverifiable method artifact; no output is adopted."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False, ensure_ascii=True
        ).encode("ascii")
    except (ValueError, TypeError, OverflowError, RecursionError) as exc:
        raise MethodContractError("Invalid finite JSON record") from exc


def _keys(value: Any, keys: set[str], what: str) -> dict[str, Any]:
    if type(value) is not dict or value.keys() != keys:
        raise MethodContractError(f"Invalid {what} fields")
    return value


def _hash(value: Any, what: str) -> str:
    if type(value) is not str or not _HEX.fullmatch(value):
        raise MethodContractError(f"Invalid {what} hash")
    return value


def _text(value: Any, what: str, maximum: int = 256) -> str:
    if (
        type(value) is not str
        or not value.strip()
        or len(value) > maximum
        or any(ord(char) < 32 for char in value)
    ):
        raise MethodContractError(f"Invalid {what}")
    return value


def _integer(value: Any, minimum: int, maximum: int, what: str) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise MethodContractError(f"Invalid {what}")
    return value


@dataclass(frozen=True)
class WasmSurface:
    memory_min_pages: int
    memory_max_pages: int


class _Reader:
    """Small bounded binary scanner, not a substitute for engine validation."""

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, size: int) -> bytes:
        end = self.pos + size
        if size < 0 or end > len(self.data):
            raise MethodContractError("Truncated Wasm module")
        data = self.data[self.pos : end]
        self.pos = end
        return data

    def u32(self) -> int:
        value = 0
        for index in range(5):
            byte = self.take(1)[0]
            if index == 4 and byte & 0xF0:
                raise MethodContractError("Invalid Wasm integer")
            value |= (byte & 0x7F) << (7 * index)
            if not byte & 0x80:
                # Accept only the shortest representation for this ABI.
                if index and byte == 0:
                    raise MethodContractError("Noncanonical Wasm integer")
                return value
        raise MethodContractError("Invalid Wasm integer")

    def done(self) -> None:
        if self.pos != len(self.data):
            raise MethodContractError("Unexpected Wasm section bytes")


def inspect_wasm_surface(module: bytes) -> WasmSurface:
    """Reject authority-bearing sections before the compiler sees any bytes.

    Only MVP scalar functions, one explicitly bounded memory and globals/data
    are allowed. All imports, start functions, tables and element sections are
    refused, even if an import/start would appear unused. Full opcode/type
    validation happens only in the resource-bounded child.
    """
    if type(module) is not bytes or not 8 <= len(module) <= MAX_MODULE_BYTES:
        raise MethodContractError("Invalid Wasm module size or type")
    reader = _Reader(module)
    if reader.take(8) != b"\0asm\x01\0\0\0":
        raise MethodContractError("Only Wasm Core version 1 binaries are accepted")
    seen: set[int] = set()
    last = 0
    memory = None
    exports = None
    while reader.pos < len(module):
        section_id = reader.take(1)[0]
        section = _Reader(reader.take(reader.u32()))
        if section_id == 0:
            continue  # Custom bytes carry no host authority; total bytes are bounded.
        if section_id in seen or section_id < last or section_id not in {1, 3, 5, 6, 7, 10, 11}:
            raise MethodContractError("Unsupported, duplicate or unordered Wasm section")
        seen.add(section_id)
        last = section_id
        if section_id == 5:
            if section.u32() != 1 or section.u32() != 1:
                raise MethodContractError("Exactly one bounded unshared 32-bit memory is required")
            minimum, maximum = section.u32(), section.u32()
            if not 1 <= minimum <= maximum <= MAX_MEMORY_PAGES:
                raise MethodContractError("Wasm memory exceeds ABI bounds")
            section.done()
            memory = WasmSurface(minimum, maximum)
        elif section_id == 7:
            if section.u32() != 2:
                raise MethodContractError("Only memory and loci_method_v1 may be exported")
            exports = {}
            for _ in range(2):
                name_bytes = section.take(section.u32())
                try:
                    name = name_bytes.decode("utf-8")
                except UnicodeError as exc:
                    raise MethodContractError("Invalid Wasm export name") from exc
                if name in exports:
                    raise MethodContractError("Duplicate Wasm export")
                exports[name] = (section.take(1)[0], section.u32())
            section.done()
    if memory is None or exports is None:
        raise MethodContractError("Missing Wasm memory or exports")
    if set(exports) != {"memory", "loci_method_v1"}:
        raise MethodContractError("Incorrect Wasm ABI exports")
    if exports["memory"] != (2, 0) or exports["loci_method_v1"][0] != 0:
        raise MethodContractError("Incorrect Wasm export kinds")
    return memory


@dataclass(frozen=True)
class RegisteredMethod:
    """Immutable copies only; this record carries no execution authority."""

    manifest_bytes: bytes
    module_bytes: bytes
    manifest_sha256: str
    module_sha256: str

    def manifest(self) -> dict[str, Any]:
        return json.loads(self.manifest_bytes)


def register_method(manifest: dict[str, Any], module: bytes) -> RegisteredMethod:
    _keys(
        manifest,
        {"schema", "id", "version", "abi", "module", "rights", "metrics"},
        "method manifest",
    )
    if manifest["schema"] != MANIFEST_SCHEMA or manifest["abi"] != ABI:
        raise MethodContractError("Unsupported manifest or ABI version")
    if not _ID.fullmatch(_text(manifest["id"], "method id", 64)):
        raise MethodContractError("Invalid method id")
    if not re.fullmatch(
        r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)",
        _text(manifest["version"], "method version", 40),
    ):
        raise MethodContractError("A concrete three-part method version is required")
    artifact = _keys(manifest["module"], {"sha256", "bytes"}, "module")
    _hash(artifact["sha256"], "module")
    _integer(artifact["bytes"], 8, MAX_MODULE_BYTES, "module byte count")
    if type(module) is not bytes or len(module) != artifact["bytes"]:
        raise MethodContractError("Module byte count mismatch")
    if sha256(module) != artifact["sha256"]:
        raise MethodContractError("Module hash mismatch")
    rights = _keys(manifest["rights"], {"license", "source", "use_basis"}, "method rights")
    for key in ("license", "source", "use_basis"):
        _text(rights[key], f"rights {key}", 1024)
    metrics = manifest["metrics"]
    if type(metrics) is not list or not 1 <= len(metrics) <= MAX_METRICS:
        raise MethodContractError("Invalid metric count")
    ids = set()
    for metric in metrics:
        _keys(metric, {"id", "kind", "unit", "description"}, "metric")
        name = _text(metric["id"], "metric id", 64)
        if not _ID.fullmatch(name) or name in ids:
            raise MethodContractError("Invalid or duplicate metric identity")
        ids.add(name)
        if type(metric["kind"]) is not str or metric["kind"] not in {"measurement", "prediction"}:
            raise MethodContractError("Metric must declare measurement or prediction")
        _text(metric["unit"], "metric unit", 64)
        _text(metric["description"], "metric description", 1024)
    inspect_wasm_surface(module)
    encoded = canonical_json(manifest)
    if len(encoded) > MAX_METADATA_BYTES:
        raise MethodContractError("Manifest exceeds size bound")
    return RegisteredMethod(encoded, module, sha256(encoded), sha256(module))


def revalidate_method(method: RegisteredMethod) -> RegisteredMethod:
    if not isinstance(method, RegisteredMethod):
        raise MethodContractError("Expected registered method")
    if type(method.manifest_bytes) is not bytes or len(method.manifest_bytes) > MAX_METADATA_BYTES:
        raise MethodContractError("Invalid registered manifest size")
    try:
        result = register_method(method.manifest(), method.module_bytes)
    except (ValueError, TypeError, RecursionError) as exc:
        raise MethodContractError("Invalid registered manifest") from exc
    if result != method:
        raise MethodContractError("Registered method identity was altered")
    return result


@dataclass(frozen=True)
class MethodExecutionApproval:
    """Trusted host decision bound to exact bytes, never accepted from a package.

    Callers must resolve genuine review evidence and authorization before creating
    this internal record. It is not a signature or authentication protocol.
    """

    manifest_sha256: str
    module_sha256: str
    rights_evidence_sha256: str


def validate_execution_approval(
    method: RegisteredMethod, approval: MethodExecutionApproval
) -> None:
    revalidate_method(method)
    if not isinstance(approval, MethodExecutionApproval):
        raise MethodContractError("Separate host execution approval is required")
    _hash(approval.rights_evidence_sha256, "rights evidence")
    if (approval.manifest_sha256, approval.module_sha256) != (
        method.manifest_sha256,
        method.module_sha256,
    ):
        raise MethodContractError("Execution approval is stale or belongs to a different method")


@dataclass(frozen=True)
class MethodInput:
    """A bounded immutable snapshot; paths and patient identifiers are not accepted."""

    buffer: bytes
    sha256: str
    label_ids: tuple[int, ...]


def build_method_input(
    labels: Any,
    raw_channels: Any,
    *,
    source_sha256: str,
    label_revision_sha256: str,
    geometry: dict[str, Any],
) -> MethodInput:
    import numpy as np

    _hash(source_sha256, "source")
    _hash(label_revision_sha256, "label revision")
    if not isinstance(labels, np.ndarray) or labels.dtype != np.dtype("uint32"):
        raise MethodContractError("Labels must be native uint32 YX")
    if labels.ndim != 2 or 0 in labels.shape or labels.size > MAX_PIXELS:
        raise MethodContractError("Only bounded nonempty 2D labels are supported")
    if not isinstance(raw_channels, np.ndarray) or raw_channels.ndim != 3:
        raise MethodContractError("Raw channels must have explicit CYX axes")
    dtypes = {np.dtype(name) for name in ("uint8", "uint16", "float32", "float64")}
    if raw_channels.dtype not in dtypes:
        raise MethodContractError("Unsupported raw channel dtype")
    if not 1 <= raw_channels.shape[0] <= MAX_CHANNELS or raw_channels.shape[1:] != labels.shape:
        raise MethodContractError("Raw channel and label geometry mismatch")
    if not np.isfinite(raw_channels).all():
        raise MethodContractError("Nonfinite raw channel value")
    label_ids = tuple(int(value) for value in np.unique(labels) if value != 0)
    if not 1 <= len(label_ids) <= MAX_OBJECTS:
        raise MethodContractError("Unsupported object count")
    _keys(geometry, {"axes", "level", "origin_yx", "spacing_yx", "unit"}, "geometry")
    if geometry["axes"] != "YX" or type(geometry["level"]) is not int or geometry["level"] != 0:
        raise MethodContractError("Only an explicitly native YX grid is supported")
    for key in ("origin_yx", "spacing_yx"):
        values = geometry[key]
        if type(values) is not list or len(values) != 2:
            raise MethodContractError(f"Invalid {key}")
        if any(type(value) not in {float, int} or not -1e100 <= value <= 1e100 for value in values):
            raise MethodContractError(f"Invalid finite {key}")
    if any(value <= 0 for value in geometry["spacing_yx"]):
        raise MethodContractError("Physical or pixel spacing must be positive")
    if type(geometry["unit"]) is not str or geometry["unit"] not in {"pixel", "um"}:
        raise MethodContractError("Only explicit pixel or um geometry is supported")
    if geometry["unit"] == "pixel" and geometry["spacing_yx"] != [1, 1]:
        raise MethodContractError("Uncalibrated pixel spacing must be one")
    label_bytes = labels.astype("<u4", copy=False).tobytes(order="C")
    raw_bytes = raw_channels.astype(raw_channels.dtype.newbyteorder("<"), copy=False).tobytes(
        order="C"
    )
    metadata = canonical_json(
        {
            "abi": ABI,
            "source_sha256": source_sha256,
            "label_revision_sha256": label_revision_sha256,
            "label_sha256": sha256(label_bytes),
            "raw_sha256": sha256(raw_bytes),
            "labels": {"axes": "YX", "dtype": "uint32-le", "shape": list(labels.shape)},
            "raw": {
                "axes": "CYX",
                "dtype": raw_channels.dtype.name + "-le",
                "shape": list(raw_channels.shape),
            },
            "geometry": geometry,
        }
    )
    if len(metadata) > MAX_METADATA_BYTES:
        raise MethodContractError("Input metadata exceeds bound")
    # 24-byte header: magic, metadata bytes, label bytes, raw bytes, reserved zero.
    packed = struct.pack("<8sIIII", INPUT_MAGIC, len(metadata), len(label_bytes), len(raw_bytes), 0)
    packed += metadata + label_bytes + raw_bytes
    return MethodInput(packed, sha256(packed), label_ids)


def validate_input_snapshot(snapshot: MethodInput) -> dict[str, Any]:
    """Rebuild from copied bytes to reject forged identities or stale ABI metadata."""
    import numpy as np

    if not isinstance(snapshot, MethodInput) or type(snapshot.buffer) is not bytes:
        raise MethodContractError("Expected immutable method input")
    if (
        not 24 <= len(snapshot.buffer) <= MAX_INPUT_BYTES
        or sha256(snapshot.buffer) != snapshot.sha256
    ):
        raise MethodContractError("Input snapshot size or hash mismatch")
    magic, metadata_len, labels_len, raw_len, reserved = struct.unpack(
        "<8sIIII", snapshot.buffer[:24]
    )
    if magic != INPUT_MAGIC or reserved != 0 or metadata_len > MAX_METADATA_BYTES:
        raise MethodContractError("Invalid input header")
    if 24 + metadata_len + labels_len + raw_len != len(snapshot.buffer):
        raise MethodContractError("Invalid input byte lengths")
    try:
        metadata = json.loads(snapshot.buffer[24 : 24 + metadata_len])
        _keys(
            metadata,
            {
                "abi",
                "source_sha256",
                "label_revision_sha256",
                "label_sha256",
                "raw_sha256",
                "labels",
                "raw",
                "geometry",
            },
            "input metadata",
        )
        if metadata["abi"] != ABI:
            raise MethodContractError("Stale input ABI")
        label_spec = _keys(metadata["labels"], {"axes", "dtype", "shape"}, "labels")
        raw_spec = _keys(metadata["raw"], {"axes", "dtype", "shape"}, "raw channels")
        if label_spec["axes"] != "YX" or label_spec["dtype"] != "uint32-le":
            raise MethodContractError("Invalid label encoding")
        dtypes = {"uint8-le": "u1", "uint16-le": "<u2", "float32-le": "<f4", "float64-le": "<f8"}
        if raw_spec["axes"] != "CYX" or raw_spec["dtype"] not in dtypes:
            raise MethodContractError("Invalid raw encoding")
        for shape, dimensions in ((label_spec["shape"], 2), (raw_spec["shape"], 3)):
            if type(shape) is not list or len(shape) != dimensions:
                raise MethodContractError("Invalid snapshot dimensions")
            for value in shape:
                _integer(value, 1, MAX_PIXELS, "snapshot dimension")
        start = 24 + metadata_len
        labels = np.frombuffer(snapshot.buffer[start : start + labels_len], dtype="<u4").reshape(
            label_spec["shape"]
        )
        raw = np.frombuffer(
            snapshot.buffer[start + labels_len :], dtype=dtypes[raw_spec["dtype"]]
        ).reshape(raw_spec["shape"])
        rebuilt = build_method_input(
            labels,
            raw,
            source_sha256=metadata["source_sha256"],
            label_revision_sha256=metadata["label_revision_sha256"],
            geometry=metadata["geometry"],
        )
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise MethodContractError("Invalid input snapshot") from exc
    if rebuilt != snapshot:
        raise MethodContractError("Input bytes, metadata or label identities do not agree")
    return metadata


def validate_method_output(
    method: RegisteredMethod, snapshot: MethodInput, output: bytes
) -> tuple[tuple[int, tuple[float, ...]], ...]:
    revalidate_method(method)
    validate_input_snapshot(snapshot)
    count = len(method.manifest()["metrics"])
    row_size = 4 + 8 * count
    expected_size = 16 + len(snapshot.label_ids) * row_size
    if type(output) is not bytes or len(output) != expected_size or len(output) > MAX_OUTPUT_BYTES:
        raise MethodContractError("Output byte count mismatch")
    magic, rows, metrics = struct.unpack("<8sII", output[:16])
    if magic != OUTPUT_MAGIC or rows != len(snapshot.label_ids) or metrics != count:
        raise MethodContractError("Output ABI or shape mismatch")
    values = []
    for index, expected_label in enumerate(snapshot.label_ids):
        row = struct.unpack_from("<I" + "d" * count, output, 16 + index * row_size)
        if row[0] != expected_label:
            raise MethodContractError("Output label identity or order mismatch")
        if any(not math.isfinite(value) for value in row[1:]):
            raise MethodContractError("Nonfinite method output")
        values.append((row[0], tuple(row[1:])))
    return tuple(values)


def adopt_method_output(
    method: RegisteredMethod,
    snapshot: MethodInput,
    output: bytes,
    *,
    expected_output_sha256: str,
) -> dict[str, Any]:
    """Validate externally supplied output without implying local method execution.

    No files, project results or review records are written here. A caller must
    separately authorize persistence through the existing publication boundary.
    """
    _hash(expected_output_sha256, "output")
    if type(output) is not bytes or sha256(output) != expected_output_sha256:
        raise MethodContractError("Output hash mismatch")
    rows = validate_method_output(method, snapshot, output)
    return {
        "schema": "loci.controlled-method-result/v1",
        "origin": "adopted-external",
        "abi": ABI,
        "manifest_sha256": method.manifest_sha256,
        "module_sha256": method.module_sha256,
        "input_sha256": snapshot.sha256,
        "output_sha256": expected_output_sha256,
        "metrics": method.manifest()["metrics"],
        "rows": [{"label_id": label, "values": list(values)} for label, values in rows],
        "scientific_review": "pending",
        "runtime": None,
    }


def _qualification_uleb(value: int) -> bytes:
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def _qualification_section(kind: int, content: bytes) -> bytes:
    return bytes([kind]) + _qualification_uleb(len(content)) + content


def qualification_module(body: bytes) -> bytes:
    """Authored scalar ABI fixture builder, no compiler or runtime involved."""
    code = b"\0" + body + b"\x0b"
    name = b"loci_method_v1"
    exports = b"\x02\x06memory\x02\0" + _qualification_uleb(len(name)) + name + b"\0\0"
    return (
        b"\0asm\x01\0\0\0"
        + _qualification_section(1, b"\x01\x60\x04\x7f\x7f\x7f\x7f\x01\x7f")
        + _qualification_section(3, b"\x01\0")
        + _qualification_section(5, b"\x01\x01\x01\x80\x04")
        + _qualification_section(7, exports)
        + _qualification_section(10, b"\x01" + _qualification_uleb(len(code)) + code)
    )


def qualification_fixture() -> tuple[RegisteredMethod, MethodInput, bytes]:
    """Exact independent constant-output fixture for native runtime qualification.

    This constructs inert data only. Installation can verify its expected bytes
    without importing or executing qualification test files or any Wasm module.
    The constant values test ABI fidelity, never a scientific computation.
    """
    import numpy as np

    output = struct.pack("<8sIIIdId", OUTPUT_MAGIC, 2, 1, 7, 2.0, 42, 3.0)

    def signed(value):
        encoded = bytearray()
        while True:
            byte = value & 127
            value >>= 7
            done = (value == 0 and byte & 64 == 0) or (value == -1 and byte & 64 != 0)
            encoded.append(byte if done else byte | 128)
            if done:
                return bytes(encoded)

    instructions = bytearray()
    for offset in range(0, len(output), 4):
        word = int.from_bytes(output[offset : offset + 4], "little", signed=True)
        instructions += b"\x20\x02\x41" + signed(offset) + b"\x6a\x41"
        instructions += signed(word) + b"\x36\x02\0"
    instructions += b"\x41" + signed(len(output))
    module = qualification_module(bytes(instructions))
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "id": "fixture-pixel-count",
        "version": "1.0.0",
        "abi": ABI,
        "module": {"sha256": sha256(module), "bytes": len(module)},
        "rights": {
            "license": "Apache-2.0",
            "source": "Loci authored fixture",
            "use_basis": "repository test only",
        },
        "metrics": [
            {
                "id": "pixel_count",
                "kind": "measurement",
                "unit": "pixel",
                "description": "Fixture per-label pixel count, not biological validation",
            }
        ],
    }
    snapshot = build_method_input(
        np.array([[0, 7, 7], [42, 42, 42]], dtype=np.uint32),
        np.array([[[3, 5, 8], [13, 21, 34]]], dtype=np.uint16),
        source_sha256="b" * 64,
        label_revision_sha256="c" * 64,
        geometry={
            "axes": "YX",
            "level": 0,
            "origin_yx": [10, 20],
            "spacing_yx": [0.5, 0.25],
            "unit": "um",
        },
    )
    return register_method(manifest, module), snapshot, output
