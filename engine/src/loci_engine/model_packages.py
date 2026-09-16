"""Strict, local-only ONNX model packages for bounded 2D segmentation.

This module intentionally implements a small execution profile.  It accepts a
native ``loci-model.json`` manifest or adapts the declarative ONNX subset of a
BioImage.IO 0.5 ``rdf.yaml``.  Package descriptions never select Python code,
custom operators, remote resources, or pickle/state-dictionary loaders.

Compatibility, usage rights, and scientific validation are separate records:
passing the ONNX/reference checks establishes technical compatibility only.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, BinaryIO, Literal

import numpy as np

PACKAGE_SCHEMA = "loci.model-package/1"
ONNX_DISTRIBUTION = "onnx"
ORT_DISTRIBUTION = "onnxruntime"
YAML_DISTRIBUTION = "PyYAML"

MAX_FILES = 64
MAX_METADATA_BYTES = 2 * 1024**2
MAX_MODEL_BYTES = 512 * 1024**2
MAX_REFERENCE_BYTES = 256 * 1024**2
MAX_PACKAGE_BYTES = 1024**3
DEFAULT_WORKING_BYTES = 512 * 1024**2
MAX_TENSOR_ELEMENTS = 64 * 1024**2
MAX_GRAPH_NODES = 20_000
MAX_UNRESOLVED_GRAPH_VALUES = 256
MAX_METADATA_NODES = 20_000
MAX_METADATA_DEPTH = 32
MAX_STRING_LENGTH = 16_384

_ID = re.compile(r"[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?\Z")
_VERSION = re.compile(r"[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,78}[0-9A-Za-z])?\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_ANCILLARY_SUFFIXES = {
    ".json",
    ".md",
    ".npy",
    ".onnx",
    ".png",
    ".tif",
    ".tiff",
    ".txt",
    ".yaml",
    ".yml",
}
_SAFE_ONNX_OPERATORS = {
    "Add",
    "Cast",
    "Concat",
    "Constant",
    "Conv",
    "Div",
    "Gather",
    "Identity",
    "InstanceNormalization",
    "MaxPool",
    "Mul",
    "Relu",
    "Resize",
    "Shape",
    "Sigmoid",
    "Slice",
    "Sub",
    "Unsqueeze",
}


class ModelPackageError(ValueError):
    """A package is unsafe, unsupported, inconsistent, or unverifiable."""


@dataclass(frozen=True, slots=True)
class TensorContract:
    id: str
    axes: Literal["BCYX"]
    dtype: Literal["float32"]
    shape: tuple[int, int, int, int]
    channels: tuple[tuple[str, int], ...]
    scale_yx: tuple[float, float]
    scale_unit: str
    semantics: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "axes": self.axes,
            "dtype": self.dtype,
            "shape": list(self.shape),
            "channels": [
                {"name": name, "source_index": source_index} for name, source_index in self.channels
            ],
            "scale_yx": list(self.scale_yx),
            "scale_unit": self.scale_unit,
            "semantics": self.semantics,
        }


@dataclass(frozen=True, slots=True)
class FileReference:
    source: str
    sha256: str

    def to_dict(self) -> dict[str, str]:
        return {"source": self.source, "sha256": self.sha256}


@dataclass(frozen=True, slots=True)
class ModelPackage:
    root: Path
    source_format: Literal["loci", "bioimage.io-0.5"]
    id: str
    version: str
    task: Literal["semantic-segmentation"]
    model: FileReference
    opset_version: int
    input: TensorContract
    output: TensorContract
    preprocessing: tuple[Mapping[str, Any], ...]
    input_yx: tuple[int, int]
    halo_yx: tuple[int, int]
    padding: Literal["reflect", "symmetric", "edge"]
    postprocessing: tuple[Mapping[str, Any], ...]
    label_threshold: float | None
    label_channel: int | None
    reference_input: FileReference
    reference_output: FileReference
    rtol: float
    atol: float
    mismatched_elements_per_million: int
    citations: tuple[Mapping[str, str], ...]
    rights: Mapping[str, str]
    validation: Mapping[str, str]
    metadata_sha256: str
    package_sha256: str
    files: tuple[FileReference, ...]

    def public_record(self) -> dict[str, Any]:
        """Return immutable, path-free metadata suitable for provenance."""

        return {
            "schema_version": PACKAGE_SCHEMA,
            "source_format": self.source_format,
            "id": self.id,
            "version": self.version,
            "task": self.task,
            "model": {**self.model.to_dict(), "opset_version": self.opset_version},
            "input": self.input.to_dict(),
            "output": self.output.to_dict(),
            "preprocessing": [_operation_record(op) for op in self.preprocessing],
            "tiling": {
                "input_yx": list(self.input_yx),
                "halo_yx": list(self.halo_yx),
                "padding": self.padding,
            },
            "postprocessing": [_operation_record(op) for op in self.postprocessing],
            "labels": None
            if self.label_threshold is None
            else {"threshold": self.label_threshold, "channel": self.label_channel},
            "reference": {
                "input": self.reference_input.to_dict(),
                "output": self.reference_output.to_dict(),
                "rtol": self.rtol,
                "atol": self.atol,
                "mismatched_elements_per_million": self.mismatched_elements_per_million,
            },
            "citations": [dict(citation) for citation in self.citations],
            "rights": dict(self.rights),
            "validation": dict(self.validation),
            "metadata_sha256": self.metadata_sha256,
            "package_sha256": self.package_sha256,
            "files": [entry.to_dict() for entry in self.files],
        }


@dataclass(frozen=True, slots=True)
class ReferenceResult:
    compatible: bool
    package: Mapping[str, Any]
    runtime: Mapping[str, Any]
    comparison: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "compatible": self.compatible,
            "package": dict(self.package),
            "runtime": dict(self.runtime),
            "comparison": dict(self.comparison),
            "meaning": "technical compatibility; not scientific or clinical validation",
        }


@dataclass(frozen=True, slots=True)
class InferenceResult:
    probabilities: np.ndarray
    labels: np.ndarray | None
    record: Mapping[str, Any]


def runtime_status() -> dict[str, Any]:
    """Report the optional runtime without importing native ONNX libraries."""

    versions: dict[str, str | None] = {}
    for key, distribution in (
        ("onnx", ONNX_DISTRIBUTION),
        ("onnxruntime", ORT_DISTRIBUTION),
        ("yaml", YAML_DISTRIBUTION),
    ):
        try:
            versions[key] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            versions[key] = None
    ready = all(versions.values())
    return {
        "ready": ready,
        "code": "ready" if ready else "optional-runtime-missing",
        "versions": versions,
        "supported_providers": ["CPUExecutionProvider"],
        "summary": (
            "The bounded ONNX package runtime is installed."
            if ready
            else (
                "Install the engine's optional 'onnx' dependency group to inspect graphs "
                "or run models."
            )
        ),
    }


def _runtime() -> tuple[Any, Any]:
    try:
        import onnx
        import onnxruntime
    except ImportError as exc:
        raise RuntimeError(
            "The optional ONNX runtime is unavailable; install the engine 'onnx' dependency group"
        ) from exc
    return onnx, onnxruntime


def _checked_text(value: object, name: str, *, limit: int = 1024) -> str:
    if not isinstance(value, str) or not value or len(value) > limit or "\x00" in value:
        raise ModelPackageError(f"{name} must be a non-empty bounded string")
    return value


def _exact(value: object, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ModelPackageError(f"{name} must be an object")
    unknown = set(value) - keys
    if unknown:
        raise ModelPackageError(f"Unsupported {name} fields: {', '.join(sorted(unknown))}")
    return value


def _finite(value: object, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ModelPackageError(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or not low <= result <= high:
        raise ModelPackageError(f"{name} must be between {low} and {high}")
    return result


def _integer(value: object, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ModelPackageError(f"{name} must be an integer between {low} and {high}")
    return value


def _filename(value: object, name: str, suffix: str | None = None) -> str:
    result = _checked_text(value, name, limit=240)
    path = Path(result)
    if path.name != result or path.is_absolute() or result in {".", ".."}:
        raise ModelPackageError(f"{name} must name one plain package file")
    if suffix is not None and path.suffix.lower() != suffix:
        raise ModelPackageError(f"{name} must use the {suffix} suffix")
    return result


def _digest(value: object, name: str) -> str:
    result = _checked_text(value, name, limit=64)
    if not _SHA256.fullmatch(result):
        raise ModelPackageError(f"{name} must be a lowercase SHA-256 digest")
    return result


def _open_regular(path: Path) -> tuple[BinaryIO, tuple[int, int, int]]:
    before = path.stat(follow_symlinks=False)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ModelPackageError(f"Package member must be a regular file: {path.name}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    identity = (before.st_size, before.st_mtime_ns, getattr(before, "st_ino", 0))
    return os.fdopen(descriptor, "rb"), identity


def _verify_unchanged(path: Path, identity: tuple[int, int, int]) -> None:
    after = path.stat(follow_symlinks=False)
    current = (after.st_size, after.st_mtime_ns, getattr(after, "st_ino", 0))
    if current != identity or stat.S_ISLNK(after.st_mode):
        raise ModelPackageError(f"Package member changed while it was read: {path.name}")


def _hash_file(path: Path, *, max_bytes: int) -> tuple[str, int]:
    stream, identity = _open_regular(path)
    digest = hashlib.sha256()
    size = 0
    with stream:
        while chunk := stream.read(8 * 1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise ModelPackageError(f"Package member exceeds its size limit: {path.name}")
            digest.update(chunk)
    _verify_unchanged(path, identity)
    return digest.hexdigest(), size


def _read_bounded(path: Path, *, max_bytes: int) -> tuple[bytes, str]:
    stream, identity = _open_regular(path)
    digest = hashlib.sha256()
    chunks = []
    size = 0
    with stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise ModelPackageError(f"Package member exceeds its size limit: {path.name}")
            digest.update(chunk)
            chunks.append(chunk)
    _verify_unchanged(path, identity)
    return b"".join(chunks), digest.hexdigest()


def _inventory(root: Path) -> tuple[FileReference, ...]:
    root_stat = root.stat(follow_symlinks=False)
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise ModelPackageError("A model package must be a real local directory, not a link")
    entries = sorted(root.iterdir(), key=lambda path: path.name)
    if not 1 <= len(entries) <= MAX_FILES:
        raise ModelPackageError(f"A package must contain 1-{MAX_FILES} plain files")
    inventory = []
    total = 0
    for path in entries:
        if path.name.startswith(".") or path.suffix.lower() not in _SAFE_ANCILLARY_SUFFIXES:
            raise ModelPackageError(f"Unsupported package member: {path.name}")
        limit = MAX_MODEL_BYTES if path.suffix.lower() == ".onnx" else MAX_REFERENCE_BYTES
        sha256, size = _hash_file(path, max_bytes=limit)
        total += size
        if total > MAX_PACKAGE_BYTES:
            raise ModelPackageError("Model package exceeds its total size limit")
        inventory.append(FileReference(path.name, sha256))
    return tuple(inventory)


def _metadata_shape(value: object, *, depth: int = 0, count: list[int] | None = None) -> None:
    if count is None:
        count = [0]
    count[0] += 1
    if count[0] > MAX_METADATA_NODES or depth > MAX_METADATA_DEPTH:
        raise ModelPackageError("Package metadata is too large or deeply nested")
    if isinstance(value, str):
        if len(value) > MAX_STRING_LENGTH:
            raise ModelPackageError("Package metadata contains an oversized string")
    elif value is None or isinstance(value, (bool, int)):
        return
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ModelPackageError("Package metadata contains a non-finite number")
    elif isinstance(value, list):
        for item in value:
            _metadata_shape(item, depth=depth + 1, count=count)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ModelPackageError("Package metadata keys must be strings")
            _metadata_shape(key, depth=depth + 1, count=count)
            _metadata_shape(item, depth=depth + 1, count=count)
    else:
        raise ModelPackageError("Package metadata must contain JSON-compatible values only")


def _load_json(path: Path) -> tuple[dict[str, Any], str]:
    raw, digest = _read_bounded(path, max_bytes=MAX_METADATA_BYTES)
    if not raw:
        raise ModelPackageError("The model manifest is empty")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ModelPackageError("The model manifest is not valid UTF-8 JSON") from exc
    _metadata_shape(value)
    if not isinstance(value, dict):
        raise ModelPackageError("The model manifest must be an object")
    return value, digest


def _load_yaml(path: Path) -> tuple[dict[str, Any], str]:
    raw, digest = _read_bounded(path, max_bytes=MAX_METADATA_BYTES)
    if not raw:
        raise ModelPackageError("The BioImage.IO description is empty")
    try:
        import yaml
        from yaml.events import AliasEvent

        class StrictSafeLoader(yaml.SafeLoader):
            def compose_node(self, parent: Any, index: Any) -> Any:
                if self.check_event(AliasEvent):
                    raise ModelPackageError("YAML aliases are not accepted in model packages")
                return super().compose_node(parent, index)

            def construct_mapping(self, node: Any, deep: bool = False) -> Any:
                keys: set[Any] = set()
                for key_node, _ in node.value:
                    key = self.construct_object(key_node, deep=deep)
                    if key in keys:
                        raise ModelPackageError(f"Duplicate YAML key: {key}")
                    keys.add(key)
                return super().construct_mapping(node, deep=deep)

        value = yaml.load(raw.decode("utf-8"), Loader=StrictSafeLoader)
    except ModelPackageError:
        raise
    except Exception as exc:
        raise ModelPackageError("The BioImage.IO description is not safe, valid YAML") from exc
    _metadata_shape(value)
    if not isinstance(value, dict):
        raise ModelPackageError("The BioImage.IO description must be an object")
    return value, digest


def _member(root: Path, reference: FileReference, suffix: str | None = None) -> Path:
    filename = _filename(reference.source, "package file", suffix)
    path = root / filename
    actual, _ = _hash_file(
        path,
        max_bytes=MAX_MODEL_BYTES if suffix == ".onnx" else MAX_REFERENCE_BYTES,
    )
    if actual != reference.sha256:
        raise ModelPackageError(f"SHA-256 mismatch for package member: {filename}")
    return path


def _file_reference(value: object, name: str, *, suffix: str) -> FileReference:
    data = _exact(value, {"source", "sha256"}, name)
    return FileReference(
        _filename(data.get("source"), f"{name}.source", suffix),
        _digest(data.get("sha256"), f"{name}.sha256"),
    )


def _shape(value: object, name: str) -> tuple[int, int, int, int]:
    if not isinstance(value, list) or len(value) != 4:
        raise ModelPackageError(f"{name} must be a four-element BCYX shape")
    shape = tuple(_integer(item, name, 1, MAX_TENSOR_ELEMENTS) for item in value)
    if math.prod(shape) > MAX_TENSOR_ELEMENTS:
        raise ModelPackageError(f"{name} exceeds the tensor element limit")
    return shape  # type: ignore[return-value]


def _tensor_native(value: object, name: str, *, output: bool) -> TensorContract:
    keys = {"id", "axes", "dtype", "shape", "channels", "scale_yx", "scale_unit"}
    if output:
        keys.add("semantics")
    data = _exact(value, keys, name)
    tensor_id = _checked_text(data.get("id"), f"{name}.id", limit=120)
    if data.get("axes") != "BCYX" or data.get("dtype") != "float32":
        raise ModelPackageError(f"{name} must declare float32 BCYX")
    shape = _shape(data.get("shape"), f"{name}.shape")
    channels_value = data.get("channels")
    if not isinstance(channels_value, list) or len(channels_value) != shape[1]:
        raise ModelPackageError(f"{name}.channels must describe every channel")
    channels = []
    for index, channel_value in enumerate(channels_value):
        channel = _exact(channel_value, {"name", "source_index"}, f"{name}.channels[{index}]")
        source_index = _integer(channel.get("source_index"), "source_index", 0, 255)
        channels.append(
            (_checked_text(channel.get("name"), "channel name", limit=120), source_index)
        )
    if len({source for _, source in channels}) != len(channels):
        raise ModelPackageError(f"{name} channel mappings must be unique")
    scale = data.get("scale_yx")
    if not isinstance(scale, list) or len(scale) != 2:
        raise ModelPackageError(f"{name}.scale_yx must contain Y and X scales")
    scale_yx = tuple(_finite(item, "axis scale", 1e-12, 1e12) for item in scale)
    semantics = data.get("semantics", "intensity")
    if output and semantics != "probabilities":
        raise ModelPackageError("The executable output must have probabilities semantics")
    return TensorContract(
        id=tensor_id,
        axes="BCYX",
        dtype="float32",
        shape=shape,
        channels=tuple(channels),
        scale_yx=scale_yx,  # type: ignore[arg-type]
        scale_unit=_checked_text(data.get("scale_unit"), f"{name}.scale_unit", limit=40),
        semantics=semantics,
    )


def _operations(value: object, name: str, *, post: bool = False) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, list) or len(value) > 8:
        raise ModelPackageError(f"{name} must be a list of at most eight operations")
    result: list[Mapping[str, Any]] = []
    for index, raw in enumerate(value):
        operation = _exact(raw, {"id", "kwargs"}, f"{name}[{index}]")
        op_id = operation.get("id")
        kwargs = operation.get("kwargs", {})
        if not isinstance(kwargs, dict):
            raise ModelPackageError(f"{name}[{index}].kwargs must be an object")
        if op_id == "ensure_dtype":
            _exact(kwargs, {"dtype"}, "ensure_dtype kwargs")
            if kwargs.get("dtype") != "float32":
                raise ModelPackageError("Only ensure_dtype float32 is supported")
            normalized = {"id": op_id, "kwargs": {"dtype": "float32"}}
        elif not post and op_id == "zero_mean_unit_variance":
            _exact(kwargs, {"axes", "eps", "mean", "std"}, "normalization kwargs")
            axes = kwargs.get("axes", ["channel", "y", "x"])
            if not isinstance(axes, list) or set(axes) - {"channel", "y", "x"} or not axes:
                raise ModelPackageError("Normalization axes must be a non-empty channel/Y/X subset")
            eps = _finite(kwargs.get("eps", 1e-6), "normalization eps", 1e-12, 1.0)
            mean, std = kwargs.get("mean"), kwargs.get("std")
            if (mean is None) != (std is None):
                raise ModelPackageError("Fixed normalization requires both mean and std")
            normalized_kwargs: dict[str, Any] = {"axes": axes, "eps": eps}
            if mean is not None:
                for key, array in (("mean", mean), ("std", std)):
                    if not isinstance(array, list) or not array:
                        raise ModelPackageError(f"Normalization {key} must be a non-empty list")
                    normalized_kwargs[key] = [
                        _finite(item, f"normalization {key}", -1e30, 1e30) for item in array
                    ]
                if any(item <= eps for item in normalized_kwargs["std"]):
                    raise ModelPackageError("Normalization std must exceed eps")
            normalized = {"id": op_id, "kwargs": normalized_kwargs}
        elif post and op_id == "sigmoid":
            _exact(kwargs, set(), "sigmoid kwargs")
            normalized = {"id": op_id, "kwargs": {}}
        else:
            raise ModelPackageError(f"Unsupported declarative operation: {op_id}")
        frozen_kwargs = MappingProxyType(
            {
                key: tuple(item) if isinstance(item, list) else item
                for key, item in normalized["kwargs"].items()
            }
        )
        result.append(MappingProxyType({"id": normalized["id"], "kwargs": frozen_kwargs}))
    return tuple(result)


def _operation_record(operation: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": operation["id"],
        "kwargs": {
            key: list(value) if isinstance(value, tuple) else value
            for key, value in operation["kwargs"].items()
        },
    }


def _citations(value: object) -> tuple[Mapping[str, str], ...]:
    if not isinstance(value, list) or not value or len(value) > 32:
        raise ModelPackageError("At least one and no more than 32 citations are required")
    result = []
    for index, raw in enumerate(value):
        citation = _exact(raw, {"text", "doi", "url"}, f"citation[{index}]")
        normalized = {
            key: _checked_text(item, f"citation {key}", limit=2048)
            for key, item in citation.items()
            if item is not None
        }
        if "text" not in normalized or not ({"doi", "url"} & normalized.keys()):
            raise ModelPackageError("Each citation needs text and a DOI or URL")
        result.append(MappingProxyType(normalized))
    return tuple(result)


def _rights(value: object) -> Mapping[str, str]:
    data = _exact(
        value,
        {"license", "redistribution", "commercial_use", "training_data"},
        "rights",
    )
    return MappingProxyType(
        {
            key: _checked_text(data.get(key), f"rights.{key}", limit=4096)
            for key in ("license", "redistribution", "commercial_use", "training_data")
        }
    )


def _validation(value: object) -> Mapping[str, str]:
    data = _exact(value, {"status", "summary"}, "validation")
    status = data.get("status")
    if status not in {"unvalidated", "externally-validated", "locally-validated"}:
        raise ModelPackageError("Unsupported scientific validation status")
    return MappingProxyType(
        {
            "status": status,
            "summary": _checked_text(data.get("summary"), "validation.summary", limit=4096),
        }
    )


def _native_manifest(
    root: Path,
    data: dict[str, Any],
    metadata_sha256: str,
    inventory: tuple[FileReference, ...],
) -> ModelPackage:
    _exact(
        data,
        {
            "schema_version",
            "id",
            "version",
            "task",
            "model",
            "input",
            "output",
            "preprocessing",
            "tiling",
            "postprocessing",
            "labels",
            "reference",
            "citations",
            "rights",
            "validation",
        },
        "manifest",
    )
    if data.get("schema_version") != PACKAGE_SCHEMA or data.get("task") != "semantic-segmentation":
        raise ModelPackageError("Unsupported package schema or task")
    package_id = _checked_text(data.get("id"), "id", limit=80)
    version = _checked_text(data.get("version"), "version", limit=80)
    if not _ID.fullmatch(package_id) or not _VERSION.fullmatch(version):
        raise ModelPackageError("Package id or version is not a path-free identifier")
    model_data = _exact(data.get("model"), {"source", "sha256", "opset_version"}, "model")
    model = FileReference(
        _filename(model_data.get("source"), "model.source", ".onnx"),
        _digest(model_data.get("sha256"), "model.sha256"),
    )
    opset = _integer(model_data.get("opset_version"), "model.opset_version", 7, 10_000)
    input_spec = _tensor_native(data.get("input"), "input", output=False)
    output_spec = _tensor_native(data.get("output"), "output", output=True)
    tiling = _exact(data.get("tiling"), {"input_yx", "halo_yx", "padding"}, "tiling")
    input_yx = _yx(tiling.get("input_yx"), "tiling.input_yx", low=1)
    halo_yx = _yx(tiling.get("halo_yx"), "tiling.halo_yx", low=0)
    padding = tiling.get("padding")
    if padding not in {"reflect", "symmetric", "edge"}:
        raise ModelPackageError("Unsupported tile padding")
    if input_yx != input_spec.shape[-2:] or any(
        2 * h >= n for h, n in zip(halo_yx, input_yx, strict=True)
    ):
        raise ModelPackageError(
            "Tile input must match the model and leave a positive halo-cropped core"
        )
    if output_spec.shape[-2:] != input_yx:
        raise ModelPackageError(
            "The small profile requires equal model input/output spatial shapes"
        )
    labels_value = data.get("labels")
    if labels_value is None:
        threshold = channel = None
    else:
        labels = _exact(labels_value, {"threshold", "channel"}, "labels")
        threshold = _finite(labels.get("threshold"), "labels.threshold", 0, 1)
        channel = _integer(labels.get("channel"), "labels.channel", 0, output_spec.shape[1] - 1)
    reference = _exact(
        data.get("reference"),
        {"input", "output", "rtol", "atol", "mismatched_elements_per_million"},
        "reference",
    )
    return _build_package(
        root=root,
        source_format="loci",
        package_id=package_id,
        version=version,
        model=model,
        opset=opset,
        input_spec=input_spec,
        output_spec=output_spec,
        preprocessing=_operations(data.get("preprocessing"), "preprocessing"),
        input_yx=input_yx,
        halo_yx=halo_yx,
        padding=padding,
        postprocessing=_operations(data.get("postprocessing"), "postprocessing", post=True),
        threshold=threshold,
        channel=channel,
        reference_input=_file_reference(reference.get("input"), "reference.input", suffix=".npy"),
        reference_output=_file_reference(
            reference.get("output"), "reference.output", suffix=".npy"
        ),
        rtol=_finite(reference.get("rtol"), "reference.rtol", 0, 1),
        atol=_finite(reference.get("atol"), "reference.atol", 0, 1e6),
        mismatch=_integer(
            reference.get("mismatched_elements_per_million", 0),
            "reference.mismatched_elements_per_million",
            0,
            1_000_000,
        ),
        citations=_citations(data.get("citations")),
        rights=_rights(data.get("rights")),
        validation=_validation(data.get("validation")),
        metadata_sha256=metadata_sha256,
        inventory=inventory,
    )


def _yx(value: object, name: str, *, low: int) -> tuple[int, int]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ModelPackageError(f"{name} must contain Y and X")
    return (
        _integer(value[0], name, low, 65_536),
        _integer(value[1], name, low, 65_536),
    )


def _bio_file(value: object, name: str, suffix: str) -> FileReference:
    data = _exact(value, {"source", "sha256"}, name)
    source = data.get("source")
    if not isinstance(source, str) or "://" in source:
        raise ModelPackageError(f"{name} must reference an embedded local file")
    return FileReference(
        _filename(source, f"{name}.source", suffix),
        _digest(data.get("sha256"), f"{name}.sha256"),
    )


def _bio_axes(
    value: object,
    name: str,
    *,
    input_spec: TensorContract | None = None,
) -> tuple[
    tuple[int, int, int, int],
    tuple[tuple[str, int], ...],
    tuple[float, float],
    str,
    tuple[int, int],
]:
    if not isinstance(value, list) or len(value) != 4:
        raise ModelPackageError(f"{name} must contain exactly batch, channel, y, x axes")
    expected = (("batch", "batch"), ("channel", "channel"), ("space", "y"), ("space", "x"))
    sizes: list[int] = []
    channels: tuple[tuple[str, int], ...] = ()
    scales: list[float] = []
    units: list[str] = []
    halos: list[int] = []
    for index, (raw, (axis_type, default_id)) in enumerate(zip(value, expected, strict=True)):
        axis = _exact(
            raw,
            {"type", "id", "size", "channel_names", "scale", "unit", "halo", "description"},
            f"{name}[{index}]",
        )
        axis_id = axis.get("id", default_id)
        if axis.get("type") != axis_type or axis_id != default_id:
            raise ModelPackageError(f"{name} order must be batch, channel, y, x")
        if axis_type == "batch":
            if axis.get("size", 1) not in {None, 1}:
                raise ModelPackageError("Only batch size one is supported")
            sizes.append(1)
        elif axis_type == "channel":
            names = axis.get("channel_names")
            if not isinstance(names, list) or not 1 <= len(names) <= 64:
                raise ModelPackageError("A channel axis needs 1-64 channel_names")
            channels = tuple(
                (_checked_text(channel_name, "channel name", limit=120), channel_index)
                for channel_index, channel_name in enumerate(names)
            )
            sizes.append(len(channels))
        else:
            size_value = axis.get("size")
            if isinstance(size_value, dict):
                if input_spec is None:
                    raise ModelPackageError(
                        "Parameterized BioImage.IO input sizes are not supported"
                    )
                size_ref = _exact(size_value, {"tensor_id", "axis_id", "offset"}, "output size")
                if size_ref.get("tensor_id") != input_spec.id or size_ref.get("axis_id") != axis_id:
                    raise ModelPackageError(
                        "Output spatial sizes must reference the matching input axis"
                    )
                offset = _integer(size_ref.get("offset", 0), "output size offset", -65_536, 65_536)
                base = input_spec.shape[2 if axis_id == "y" else 3]
                size = base + offset
                if size < 1:
                    raise ModelPackageError("Output size reference resolves below one")
            else:
                size = _integer(size_value, "axis size", 1, 65_536)
            sizes.append(size)
            scales.append(_finite(axis.get("scale", 1), "axis scale", 1e-12, 1e12))
            unit = axis.get("unit")
            units.append("pixel" if unit is None else _checked_text(unit, "axis unit", limit=40))
            halos.append(_integer(axis.get("halo", 0), "axis halo", 0, 32_768))
    if units[0] != units[1]:
        raise ModelPackageError("Y and X axes must use the same unit")
    shape = tuple(sizes)
    if math.prod(shape) > MAX_TENSOR_ELEMENTS:
        raise ModelPackageError("BioImage.IO tensor exceeds the element limit")
    return shape, channels, (scales[0], scales[1]), units[0], (halos[0], halos[1])  # type: ignore[return-value]


def _bio_tensor_data(value: object) -> str:
    if value is None:
        return "float32"
    if isinstance(value, dict):
        allowed = {"type", "range", "unit", "scale", "offset"}
        _exact(value, allowed, "tensor data")
        return value.get("type", "float32")
    if isinstance(value, list) and value:
        dtypes = {_bio_tensor_data(item) for item in value}
        if len(dtypes) == 1:
            return dtypes.pop()
    raise ModelPackageError("Unsupported BioImage.IO tensor data description")


def _bio_probability_data(value: object) -> None:
    if not isinstance(value, dict):
        raise ModelPackageError("BioImage.IO probability output must declare data range [0, 1]")
    _exact(value, {"type", "range", "unit", "scale", "offset"}, "tensor data")
    if value.get("type", "float32") != "float32" or value.get("range") != [0.0, 1.0]:
        raise ModelPackageError("BioImage.IO probability output must declare float32 range [0, 1]")


def _bio_operations(
    value: object, name: str, *, post: bool = False
) -> tuple[Mapping[str, Any], ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ModelPackageError(f"{name} must be a list")
    adapted = []
    for raw in value:
        operation = _exact(raw, {"id", "kwargs"}, name)
        kwargs = operation.get("kwargs", {}) or {}
        adapted.append({"id": operation.get("id"), "kwargs": kwargs})
    return _operations(adapted, name, post=post)


def _bio_manifest(
    root: Path,
    data: dict[str, Any],
    metadata_sha256: str,
    inventory: tuple[FileReference, ...],
) -> ModelPackage:
    version_format = data.get("format_version")
    if not isinstance(version_format, str) or not version_format.startswith("0.5."):
        raise ModelPackageError("Only BioImage.IO model format 0.5.x is supported")
    if data.get("type") != "model":
        raise ModelPackageError("The BioImage.IO resource must be a model")
    package_id = data.get("id")
    if not isinstance(package_id, str) or not _ID.fullmatch(package_id):
        raise ModelPackageError("BioImage.IO model id must be a path-free lowercase identifier")
    version = data.get("version")
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise ModelPackageError("BioImage.IO model version is required")
    inputs, outputs = data.get("inputs"), data.get("outputs")
    if (
        not isinstance(inputs, list)
        or len(inputs) != 1
        or not isinstance(outputs, list)
        or len(outputs) != 1
    ):
        raise ModelPackageError("The small BioImage.IO profile requires one input and one output")
    input_data = _exact(
        inputs[0],
        {
            "id",
            "description",
            "axes",
            "test_tensor",
            "sample_tensor",
            "preprocessing",
            "data",
            "optional",
            "output_of",
        },
        "BioImage.IO input",
    )
    if input_data.get("optional", False) or input_data.get("output_of") is not None:
        raise ModelPackageError("Optional or chained BioImage.IO inputs are not supported")
    input_id = _checked_text(input_data.get("id", "input"), "input id", limit=120)
    input_shape, input_channels, input_scale, unit, input_halo = _bio_axes(
        input_data.get("axes"), "BioImage.IO input axes"
    )
    if input_halo != (0, 0) or _bio_tensor_data(input_data.get("data")) != "float32":
        raise ModelPackageError(
            "The BioImage.IO input must describe float32 data without input halos"
        )
    input_spec = TensorContract(
        input_id,
        "BCYX",
        "float32",
        input_shape,
        input_channels,
        input_scale,
        unit,
        "intensity",
    )
    output_data = _exact(
        outputs[0],
        {"id", "description", "axes", "test_tensor", "sample_tensor", "postprocessing", "data"},
        "BioImage.IO output",
    )
    output_id = _checked_text(output_data.get("id", "output"), "output id", limit=120)
    output_shape, output_channels, output_scale, output_unit, halo = _bio_axes(
        output_data.get("axes"), "BioImage.IO output axes", input_spec=input_spec
    )
    _bio_probability_data(output_data.get("data"))
    output_spec = TensorContract(
        output_id,
        "BCYX",
        "float32",
        output_shape,
        output_channels,
        output_scale,
        output_unit,
        "probabilities",
    )
    if input_scale != output_scale or unit != output_unit or input_shape[-2:] != output_shape[-2:]:
        raise ModelPackageError("The small profile requires matching input/output spatial grids")
    weights = data.get("weights")
    if not isinstance(weights, dict) or not isinstance(weights.get("onnx"), dict):
        raise ModelPackageError("BioImage.IO package has no ONNX weights")
    unsupported_weights = sorted(
        key for key, value in weights.items() if key != "onnx" and value is not None
    )
    if unsupported_weights:
        raise ModelPackageError(
            "The executable BioImage.IO subset is ONNX-only; remove other weight entries: "
            + ", ".join(unsupported_weights)
        )
    onnx_weights = _exact(
        weights["onnx"],
        {"source", "sha256", "opset_version", "parent", "authors", "external_data"},
        "BioImage.IO ONNX weights",
    )
    if onnx_weights.get("external_data") is not None:
        raise ModelPackageError("ONNX external data is not accepted")
    model = FileReference(
        _filename(onnx_weights.get("source"), "BioImage.IO ONNX weights.source", ".onnx"),
        _digest(onnx_weights.get("sha256"), "BioImage.IO ONNX weights.sha256"),
    )
    reference_input = _bio_file(input_data.get("test_tensor"), "input.test_tensor", ".npy")
    reference_output = _bio_file(output_data.get("test_tensor"), "output.test_tensor", ".npy")
    tolerance = _bio_tolerance(data.get("config"), output_id)
    cite = data.get("cite")
    citations = _citations(cite)
    license_name = _checked_text(data.get("license"), "license", limit=160)
    training = data.get("training_data")
    if isinstance(training, dict):
        training_text = _checked_text(training.get("id"), "training_data.id", limit=1024)
    elif training is None:
        training_text = "not documented in the package"
    else:
        raise ModelPackageError("Unsupported training_data record")
    rights = MappingProxyType(
        {
            "license": license_name,
            "redistribution": "per declared model license; independent review required",
            "commercial_use": "per declared model license; independent review required",
            "training_data": training_text,
        }
    )
    return _build_package(
        root=root,
        source_format="bioimage.io-0.5",
        package_id=package_id,
        version=version,
        model=model,
        opset=_integer(onnx_weights.get("opset_version"), "opset_version", 7, 10_000),
        input_spec=input_spec,
        output_spec=output_spec,
        preprocessing=_bio_operations(input_data.get("preprocessing"), "preprocessing"),
        input_yx=input_shape[-2:],
        halo_yx=halo,
        padding="reflect",
        postprocessing=_bio_operations(
            output_data.get("postprocessing"), "postprocessing", post=True
        ),
        threshold=None,
        channel=None,
        reference_input=reference_input,
        reference_output=reference_output,
        rtol=tolerance[0],
        atol=tolerance[1],
        mismatch=tolerance[2],
        citations=citations,
        rights=rights,
        validation=MappingProxyType(
            {
                "status": "unvalidated",
                "summary": (
                    "Supplier reference tensors describe compatibility, not domain performance."
                ),
            }
        ),
        metadata_sha256=metadata_sha256,
        inventory=inventory,
    )


def _bio_tolerance(config: object, output_id: str) -> tuple[float, float, int]:
    # BioImage.IO 0.5 tolerances are optional metadata and may be scoped.  The
    # adapter accepts only a single applicable entry; defaults follow v0.5.
    default = (1e-3, 1e-3, 100)
    if config is None:
        return default
    if not isinstance(config, dict):
        raise ModelPackageError("BioImage.IO config must be an object")
    bio = config.get("bioimageio")
    if not isinstance(bio, dict):
        return default
    values = bio.get("reproducibility_tolerance")
    if values is None:
        return default
    if isinstance(values, dict):
        values = [values]
    if not isinstance(values, list) or len(values) != 1:
        raise ModelPackageError("The small profile supports one reproducibility tolerance")
    item = _exact(
        values[0],
        {
            "relative_tolerance",
            "absolute_tolerance",
            "mismatched_elements_per_million",
            "output_ids",
            "weights_formats",
        },
        "reproducibility tolerance",
    )
    if item.get("output_ids", []) not in ([], [output_id]) or item.get(
        "weights_formats", []
    ) not in (
        [],
        ["onnx"],
    ):
        raise ModelPackageError(
            "Reproducibility tolerance does not apply exactly to this ONNX output"
        )
    return (
        _finite(item.get("relative_tolerance", 1e-3), "relative_tolerance", 0, 1),
        _finite(item.get("absolute_tolerance", 1e-3), "absolute_tolerance", 0, 1e6),
        _integer(
            item.get("mismatched_elements_per_million", 100),
            "mismatched_elements_per_million",
            0,
            1_000_000,
        ),
    )


def _build_package(**values: Any) -> ModelPackage:
    root: Path = values["root"]
    model: FileReference = values["model"]
    reference_input: FileReference = values["reference_input"]
    reference_output: FileReference = values["reference_output"]
    _member(root, model, ".onnx")
    _member(root, reference_input, ".npy")
    _member(root, reference_output, ".npy")
    if len({model.source, reference_input.source, reference_output.source}) != 3:
        raise ModelPackageError("Model and reference tensors must use distinct files")
    digest = hashlib.sha256()
    for entry in values["inventory"]:
        digest.update(entry.source.encode())
        digest.update(b"\0")
        digest.update(entry.sha256.encode())
        digest.update(b"\n")
    return ModelPackage(
        root=root,
        source_format=values["source_format"],
        id=values["package_id"],
        version=values["version"],
        task="semantic-segmentation",
        model=model,
        opset_version=values["opset"],
        input=values["input_spec"],
        output=values["output_spec"],
        preprocessing=values["preprocessing"],
        input_yx=values["input_yx"],
        halo_yx=values["halo_yx"],
        padding=values["padding"],
        postprocessing=values["postprocessing"],
        label_threshold=values["threshold"],
        label_channel=values["channel"],
        reference_input=reference_input,
        reference_output=reference_output,
        rtol=values["rtol"],
        atol=values["atol"],
        mismatched_elements_per_million=values["mismatch"],
        citations=values["citations"],
        rights=values["rights"],
        validation=values["validation"],
        metadata_sha256=values["metadata_sha256"],
        package_sha256=digest.hexdigest(),
        files=values["inventory"],
    )


def inspect_model_package(path: str | os.PathLike[str]) -> ModelPackage:
    """Parse and hash one local package without importing the ONNX runtime."""

    root = Path(path)
    inventory = _inventory(root)
    names = {entry.source for entry in inventory}
    has_native = "loci-model.json" in names
    has_bio = "rdf.yaml" in names
    if has_native == has_bio:
        raise ModelPackageError("A package must contain exactly one loci-model.json or rdf.yaml")
    if has_native:
        data, digest = _load_json(root / "loci-model.json")
        return _native_manifest(root, data, digest, inventory)
    data, digest = _load_yaml(root / "rdf.yaml")
    return _bio_manifest(root, data, digest, inventory)


def _reverify_package(package: ModelPackage) -> ModelPackage:
    current = inspect_model_package(package.root)
    if current.package_sha256 != package.package_sha256:
        raise ModelPackageError("The model package changed after inspection")
    return current


def _load_array(package: ModelPackage, reference: FileReference) -> np.ndarray:
    path = package.root / _filename(reference.source, "reference tensor", ".npy")
    stream, identity = _open_regular(path)
    try:
        digest = hashlib.sha256()
        size = 0
        while chunk := stream.read(8 * 1024 * 1024):
            size += len(chunk)
            if size > MAX_REFERENCE_BYTES:
                raise ModelPackageError("Reference tensor exceeds its size limit")
            digest.update(chunk)
        if digest.hexdigest() != reference.sha256:
            raise ModelPackageError(f"SHA-256 mismatch for package member: {reference.source}")
        stream.seek(0)
        version = np.lib.format.read_magic(stream)
        if version == (1, 0):
            shape, _, dtype = np.lib.format.read_array_header_1_0(stream, max_header_size=16384)
        elif version in {(2, 0), (3, 0)}:
            shape, _, dtype = np.lib.format.read_array_header_2_0(stream, max_header_size=16384)
        else:
            raise ModelPackageError("Unsupported NumPy reference header version")
        if (
            dtype != np.float32
            or len(shape) != 4
            or any(n < 1 for n in shape)
            or math.prod(shape) > MAX_TENSOR_ELEMENTS
            or math.prod(shape) * dtype.itemsize != size - stream.tell()
        ):
            raise ModelPackageError("Reference header exceeds its tensor or exact payload bounds")
        stream.seek(0)
        array = np.load(stream, allow_pickle=False)
    except (OSError, ValueError) as exc:
        raise ModelPackageError(f"Invalid NumPy reference tensor: {reference.source}") from exc
    finally:
        stream.close()
    _verify_unchanged(path, identity)
    if not isinstance(array, np.ndarray) or array.dtype != np.float32:
        raise ModelPackageError("Reference tensors must be NumPy float32 arrays")
    if array.size > MAX_TENSOR_ELEMENTS or not np.isfinite(array).all():
        raise ModelPackageError("Reference tensor is oversized or contains NaN/Inf")
    return np.ascontiguousarray(array)


def _onnx_session(package: ModelPackage, *, working_bytes: int) -> tuple[Any, dict[str, Any]]:
    onnx, ort = _runtime()
    if working_bytes < 1024**2 or working_bytes > 8 * 1024**3:
        raise ModelPackageError("working_bytes must be between 1 MiB and 8 GiB")
    model_path = _member(package.root, package.model, ".onnx")
    try:
        model = onnx.load_model(os.fspath(model_path), load_external_data=False)
    except Exception as exc:
        raise ModelPackageError("The embedded ONNX model could not be parsed") from exc
    if len(model.graph.node) > MAX_GRAPH_NODES or model.functions:
        raise ModelPackageError("ONNX local functions or oversized graphs are not accepted")
    if any(node.domain not in {"", "ai.onnx"} for node in model.graph.node):
        raise ModelPackageError("ONNX custom operator domains are not accepted")
    if any(node.op_type in {"If", "Loop", "Scan"} for node in model.graph.node):
        raise ModelPackageError("ONNX control-flow operators are not accepted")
    unsupported_operators = sorted(
        {node.op_type for node in model.graph.node} - _SAFE_ONNX_OPERATORS
    )
    if unsupported_operators:
        raise ModelPackageError(
            "ONNX graph contains operators outside the bounded segmentation subset: "
            + ", ".join(unsupported_operators)
        )
    if any(
        attribute.type in {attribute.GRAPH, attribute.GRAPHS}
        for node in model.graph.node
        for attribute in node.attribute
    ):
        raise ModelPackageError("Nested ONNX graphs are not accepted")
    tensors = list(model.graph.initializer) + [
        sparse.values for sparse in model.graph.sparse_initializer
    ]
    for tensor in tensors:
        if getattr(tensor, "data_location", 0) == onnx.TensorProto.EXTERNAL or getattr(
            tensor, "external_data", ()
        ):
            raise ModelPackageError("ONNX external data is not accepted")
        if math.prod(tensor.dims) > MAX_TENSOR_ELEMENTS:
            raise ModelPackageError("An ONNX initializer exceeds the tensor element limit")
    _check_control_constants(model, onnx)
    imports = {entry.domain or "ai.onnx": entry.version for entry in model.opset_import}
    if set(imports) != {"ai.onnx"} or imports["ai.onnx"] != package.opset_version:
        raise ModelPackageError("Manifest and graph ONNX opset identities differ")
    try:
        onnx.checker.check_model(model, full_check=True)
        inferred = onnx.shape_inference.infer_shapes(model, strict_mode=True, data_prop=True)
    except Exception as exc:
        raise ModelPackageError(
            "ONNX checker or static shape inference rejected the graph"
        ) from exc
    _check_graph_contract(inferred, package, onnx, working_bytes)
    _bounded_graph_shapes(model, onnx, working_bytes)
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.add_session_config_entry("session.use_env_allocators", "0")
    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("This ONNX Runtime build has no CPUExecutionProvider")
    before_hash, _ = _hash_file(model_path, max_bytes=MAX_MODEL_BYTES)
    try:
        session = ort.InferenceSession(
            os.fspath(model_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
    except Exception as exc:
        raise ModelPackageError("ONNX Runtime rejected the verified graph") from exc
    after_hash, _ = _hash_file(model_path, max_bytes=MAX_MODEL_BYTES)
    if before_hash != package.model.sha256 or after_hash != package.model.sha256:
        raise ModelPackageError("The ONNX model changed during session construction")
    session_inputs, session_outputs = session.get_inputs(), session.get_outputs()
    if len(session_inputs) != 1 or len(session_outputs) != 1:
        raise ModelPackageError("ONNX Runtime exposed an unexpected input/output contract")
    if session_inputs[0].name != package.input.id or session_outputs[0].name != package.output.id:
        raise ModelPackageError("ONNX tensor names differ from the package contract")
    runtime = {
        "backend": "onnxruntime",
        "onnx_version": onnx.__version__,
        "onnxruntime_version": ort.__version__,
        "requested_providers": ["CPUExecutionProvider"],
        "session_providers": session.get_providers(),
        "execution_mode": "sequential",
        "intra_op_threads": 1,
        "inter_op_threads": 1,
        "graph_optimization": "basic",
        "model_sha256": package.model.sha256,
        "metadata_sha256": package.metadata_sha256,
        "package_sha256": package.package_sha256,
    }
    return session, runtime


def _bounded_graph_shapes(model: Any, onnx: Any, working_bytes: int) -> None:
    """Prove allocation shapes from fixed inputs and declared constants.

    ONNX shape annotations alone are not an allocation bound: an input-derived
    Resize size can contradict an annotated output. Evaluate only tiny shape
    expressions from constants or already proven shapes, never image values.
    """
    shapes: dict[str, tuple[int, ...]] = {}
    constants: dict[str, np.ndarray] = {}
    estimated = sum(tensor.ByteSize() for tensor in model.graph.initializer) * 3

    def tensor(name: str, value: Any) -> None:
        shape = tuple(value.dims)
        if math.prod(shape) > MAX_TENSOR_ELEMENTS:
            raise ModelPackageError("ONNX tensor exceeds its allocation bound")
        shapes[name] = shape
        if math.prod(shape) <= 64:
            array = onnx.numpy_helper.to_array(value)
            if array.dtype.kind not in "biuf" or not np.isfinite(array).all():
                raise ModelPackageError("Shape constants must be finite real values")
            constants[name] = array

    def fixed(name: str) -> np.ndarray:
        if name not in constants:
            raise ModelPackageError("Image-dependent or unresolved ONNX allocation is forbidden")
        return constants[name]

    for value in model.graph.input:
        shapes[value.name] = _value_shape(value)
    for value in model.graph.initializer:
        tensor(value.name, value)
    if model.graph.sparse_initializer:
        raise ModelPackageError("Sparse ONNX initializers are outside the bounded profile")
    for node in model.graph.node:
        if len(node.output) != 1:
            raise ModelPackageError("This ONNX profile requires one output per operator")
        output = node.output[0]
        attrs = {a.name: onnx.helper.get_attribute_value(a) for a in node.attribute}
        op = node.op_type
        if op == "Constant":
            if set(attrs) != {"value"}:
                raise ModelPackageError("Only tensor-form ONNX constants are supported")
            tensor(output, attrs["value"])
            shape = shapes[output]
        else:
            if any(name and name not in shapes for name in node.input):
                raise ModelPackageError("ONNX graph is not a proven topological allocation graph")
            first = shapes[node.input[0]]
            shape = first
            if op == "Shape":
                array = np.asarray(first, dtype=np.int64)[
                    slice(attrs.get("start"), attrs.get("end"))
                ]
                constants[output], shape = array, array.shape
            elif op in {"Identity", "Relu", "Sigmoid", "InstanceNormalization", "Cast"}:
                if node.input[0] in constants and op in {"Identity", "Cast"}:
                    constants[output] = fixed(node.input[0])
                    if op == "Cast":
                        constants[output] = constants[output].astype(
                            onnx.helper.tensor_dtype_to_np_dtype(attrs["to"])
                        )
            elif op in {"Add", "Sub", "Mul", "Div"}:
                shape = np.broadcast_shapes(first, shapes[node.input[1]])
                if all(name in constants for name in node.input) and math.prod(shape) <= 64:
                    a, b = [fixed(name) for name in node.input]
                    function = {
                        "Add": np.add,
                        "Sub": np.subtract,
                        "Mul": np.multiply,
                        "Div": np.divide,
                    }[op]
                    with np.errstate(all="ignore"):
                        constants[output] = function(a, b)
            elif op == "Concat":
                axis = int(attrs["axis"]) % len(first)
                sizes = [shapes[name] for name in node.input]
                if any(
                    len(s) != len(first) or any(v != first[i] for i, v in enumerate(s) if i != axis)
                    for s in sizes
                ):
                    raise ModelPackageError("ONNX concatenation shapes disagree")
                shape = tuple(
                    sum(s[i] for s in sizes) if i == axis else n for i, n in enumerate(first)
                )
                if all(name in constants for name in node.input) and math.prod(shape) <= 64:
                    constants[output] = np.concatenate(
                        [fixed(name) for name in node.input], axis=axis
                    )
            elif op == "Gather":
                axis = int(attrs.get("axis", 0)) % len(first)
                shape = first[:axis] + shapes[node.input[1]] + first[axis + 1 :]
                if all(name in constants for name in node.input) and math.prod(shape) <= 64:
                    constants[output] = np.take(
                        fixed(node.input[0]), fixed(node.input[1]).astype(np.int64), axis=axis
                    )
            elif op == "Unsqueeze":
                axes = (
                    fixed(node.input[1]).astype(np.int64).ravel()
                    if len(node.input) > 1
                    else np.asarray(attrs["axes"])
                )
                output_rank = len(first) + len(axes)
                normalized = sorted(int(axis) % output_rank for axis in axes)
                if len(set(normalized)) != len(normalized):
                    raise ModelPackageError("Repeated ONNX unsqueeze axes")
                sizes = list(first)
                for axis in normalized:
                    sizes.insert(axis, 1)
                shape = tuple(sizes)
                if node.input[0] in constants:
                    constants[output] = fixed(node.input[0]).reshape(shape)
            elif op == "Slice":
                starts, ends = (fixed(name).astype(np.int64).ravel() for name in node.input[1:3])
                axes = (
                    fixed(node.input[3]).astype(np.int64).ravel()
                    if len(node.input) > 3 and node.input[3]
                    else np.arange(len(starts))
                )
                steps = (
                    fixed(node.input[4]).astype(np.int64).ravel()
                    if len(node.input) > 4 and node.input[4]
                    else np.ones(len(starts), dtype=np.int64)
                )
                slices = [slice(None)] * len(first)
                for start, end, axis, step in zip(starts, ends, axes, steps, strict=True):
                    axis = int(axis) % len(first)
                    if step == 0:
                        raise ModelPackageError("Zero ONNX slice step")
                    slices[axis] = slice(int(start), int(end), int(step))
                shape = tuple(len(range(*s.indices(n))) for s, n in zip(slices, first, strict=True))
                if node.input[0] in constants:
                    constants[output] = fixed(node.input[0])[tuple(slices)]
            elif op == "Resize":
                axes = [int(i) % len(first) for i in attrs.get("axes", range(len(first)))]
                sizes = list(first)
                if len(node.input) > 3 and node.input[3]:
                    resolved = fixed(node.input[3]).ravel()
                    if resolved.dtype.kind not in "iu":
                        raise ModelPackageError("ONNX resize sizes must be integer constants")
                    changed = [int(n) for n in resolved]
                elif len(node.input) > 2 and node.input[2]:
                    scales = fixed(node.input[2]).ravel()
                    if not np.isfinite(scales).all():
                        raise ModelPackageError("Non-finite ONNX resize scale")
                    changed = [
                        math.floor(first[axis] * float(scale))
                        for axis, scale in zip(axes, scales, strict=True)
                    ]
                else:
                    raise ModelPackageError("ONNX Resize requires proven sizes or scales")
                for axis, size in zip(axes, changed, strict=True):
                    sizes[axis] = size
                shape = tuple(sizes)
            elif op in {"Conv", "MaxPool"}:
                if len(first) != 4 or attrs.get("auto_pad", b"NOTSET") not in {b"NOTSET", b"VALID"}:
                    raise ModelPackageError(
                        "Only explicit-padded 2D ONNX convolutions/pools are supported"
                    )
                kernel = shapes[node.input[1]][2:] if op == "Conv" else tuple(attrs["kernel_shape"])
                strides, dilation, pads = (
                    attrs.get("strides", [1, 1]),
                    attrs.get("dilations", [1, 1]),
                    attrs.get("pads", [0, 0, 0, 0]),
                )
                if (
                    len(kernel) != 2
                    or len(strides) != 2
                    or len(dilation) != 2
                    or len(pads) != 4
                    or any(n < 1 for n in (*kernel, *strides, *dilation))
                    or any(n < 0 for n in pads)
                ):
                    raise ModelPackageError("Invalid ONNX kernel geometry")
                if attrs.get("ceil_mode", 0):
                    raise ModelPackageError("Ceiling-mode ONNX pooling is outside this profile")
                spatial = tuple(
                    (first[i + 2] + pads[i] + pads[i + 2] - dilation[i] * (kernel[i] - 1) - 1)
                    // strides[i]
                    + 1
                    for i in range(2)
                )
                shape = (first[0], shapes[node.input[1]][0] if op == "Conv" else first[1], *spatial)
            else:
                raise ModelPackageError("Operator has no bounded allocation proof")
        if any(n < 0 for n in shape) or math.prod(shape) > MAX_TENSOR_ELEMENTS:
            raise ModelPackageError("ONNX allocation shape exceeds its tensor bound")
        shapes[output] = tuple(shape)
        if output in constants and (
            constants[output].size > 64 or not np.isfinite(constants[output]).all()
        ):
            raise ModelPackageError("ONNX shape expression exceeds its constant bound")
        estimated += math.prod(shape) * 8
        if estimated > working_bytes:
            raise ModelPackageError("Proven ONNX tensor allocations exceed working-memory budget")


def _value_shape(value: Any) -> tuple[int, ...]:
    tensor = value.type.tensor_type
    if tensor.elem_type == 0 or not tensor.HasField("shape"):
        raise ModelPackageError("Every ONNX tensor must have a statically inferred tensor type")
    dims = []
    for dimension in tensor.shape.dim:
        if not dimension.HasField("dim_value") or dimension.dim_value < 1:
            raise ModelPackageError("Every ONNX tensor dimension must be a fixed positive integer")
        dims.append(dimension.dim_value)
    return tuple(dims)


def _maybe_value_shape(value: Any) -> tuple[int, ...] | None:
    tensor = value.type.tensor_type
    if tensor.elem_type == 0 or not tensor.HasField("shape"):
        return None
    dims = []
    for dimension in tensor.shape.dim:
        if not dimension.HasField("dim_value") or dimension.dim_value < 0:
            return None
        dims.append(dimension.dim_value)
    return tuple(dims)


def _check_control_constants(model: Any, onnx: Any) -> None:
    """Bound declarative shape/control constants without decoding learned weights."""

    initializer_index = {tensor.name: tensor for tensor in model.graph.initializer}
    constant_index = {}
    for node in model.graph.node:
        if node.op_type != "Constant" or len(node.output) != 1:
            continue
        tensor_attributes = [
            attribute.t for attribute in node.attribute if attribute.type == attribute.TENSOR
        ]
        if len(tensor_attributes) == 1:
            constant_index[node.output[0]] = tensor_attributes[0]

    control_names: set[str] = set()
    for node in model.graph.node:
        if node.op_type in {"Resize", "Gather", "Slice", "Unsqueeze"}:
            control_names.update(name for name in node.input[1:] if name)
    for name in control_names:
        tensor = initializer_index.get(name)
        if tensor is None:
            tensor = constant_index.get(name)
        if tensor is None:
            continue
        if math.prod(tensor.dims) > 64:
            raise ModelPackageError("ONNX shape/control constant exceeds the bounded subset")
        try:
            values = onnx.numpy_helper.to_array(tensor)
        except Exception as exc:
            raise ModelPackageError("ONNX shape/control constant could not be decoded") from exc
        if values.dtype.kind in "fc":
            if not np.isfinite(values).all() or np.any(np.abs(values) > 64):
                raise ModelPackageError("ONNX floating shape/control constant is unsafe")
        elif values.dtype.kind in "iu":
            if values.size and np.any(np.abs(values.astype(np.float64)) > MAX_TENSOR_ELEMENTS):
                raise ModelPackageError("ONNX integer shape/control constant is unsafe")
        else:
            raise ModelPackageError("ONNX shape/control constants must be numeric")


def _check_graph_contract(model: Any, package: ModelPackage, onnx: Any, working_bytes: int) -> None:
    initializers = {value.name for value in model.graph.initializer}
    inputs = [value for value in model.graph.input if value.name not in initializers]
    outputs = list(model.graph.output)
    if len(inputs) != 1 or len(outputs) != 1:
        raise ModelPackageError("The small profile requires one tensor input and one tensor output")
    if inputs[0].name != package.input.id or outputs[0].name != package.output.id:
        raise ModelPackageError("ONNX input/output names differ from the package contract")
    if (
        _value_shape(inputs[0]) != package.input.shape
        or _value_shape(outputs[0]) != package.output.shape
    ):
        raise ModelPackageError("ONNX input/output shapes differ from the package contract")
    float_type = onnx.TensorProto.FLOAT
    if (
        inputs[0].type.tensor_type.elem_type != float_type
        or outputs[0].type.tensor_type.elem_type != float_type
    ):
        raise ModelPackageError("The ONNX input and output must be float32")
    values = list(model.graph.value_info) + inputs + outputs
    estimated = 0
    unresolved = 0
    for value in values:
        shape = _maybe_value_shape(value)
        if shape is None:
            unresolved += 1
            continue
        if math.prod(shape) > MAX_TENSOR_ELEMENTS:
            raise ModelPackageError("An inferred ONNX tensor exceeds the element limit")
        try:
            element_size = onnx.helper.tensor_dtype_to_np_dtype(
                value.type.tensor_type.elem_type
            ).itemsize
        except Exception as exc:
            raise ModelPackageError(
                "ONNX graph contains an unsupported tensor element type"
            ) from exc
        estimated += math.prod(shape) * element_size
    if unresolved > MAX_UNRESOLVED_GRAPH_VALUES:
        raise ModelPackageError("Too many ONNX intermediate shapes remain unresolved")
    estimated += sum(tensor.ByteSize() for tensor in model.graph.initializer)
    if estimated > working_bytes:
        raise ModelPackageError("Static ONNX tensor memory exceeds the working-memory budget")


def _preprocess(
    array: np.ndarray, operations: Sequence[Mapping[str, Any]]
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    result = np.asarray(array, dtype=np.float32)
    records = []
    for operation in operations:
        op_id = operation["id"]
        kwargs = dict(operation["kwargs"])
        if op_id == "ensure_dtype":
            result = np.asarray(result, dtype=np.float32)
            records.append({"id": op_id, "dtype": "float32"})
        elif op_id == "zero_mean_unit_variance":
            axes_map = {"channel": 1, "y": 2, "x": 3}
            axes = tuple(axes_map[axis] for axis in kwargs["axes"])
            eps = kwargs["eps"]
            if "mean" in kwargs:
                mean = np.asarray(kwargs["mean"], dtype=np.float32).reshape(1, -1, 1, 1)
                std = np.asarray(kwargs["std"], dtype=np.float32).reshape(1, -1, 1, 1)
                if mean.shape[1] not in {1, result.shape[1]} or std.shape[1] not in {
                    1,
                    result.shape[1],
                }:
                    raise ModelPackageError("Fixed normalization does not match the input channels")
                mode = "fixed"
            else:
                mean = result.mean(axis=axes, keepdims=True, dtype=np.float64).astype(np.float32)
                std = result.std(axis=axes, keepdims=True, dtype=np.float64).astype(np.float32)
                mode = "per-sample"
            result = (result - mean) / np.maximum(std, eps)
            records.append(
                {
                    "id": op_id,
                    "mode": mode,
                    "axes": list(kwargs["axes"]),
                    "eps": eps,
                    "resolved_mean": np.asarray(mean).reshape(-1).astype(float).tolist(),
                    "resolved_std": np.asarray(std).reshape(-1).astype(float).tolist(),
                }
            )
        else:  # parser guarantees this, retain a fail-closed runtime check
            raise ModelPackageError(f"Unsupported preprocessing operation: {op_id}")
    if not np.isfinite(result).all():
        raise ModelPackageError("Preprocessing produced NaN or Inf")
    return np.ascontiguousarray(result, dtype=np.float32), records


def _postprocess(array: np.ndarray, operations: Sequence[Mapping[str, Any]]) -> np.ndarray:
    result = np.asarray(array, dtype=np.float32)
    for operation in operations:
        if operation["id"] == "ensure_dtype":
            result = np.asarray(result, dtype=np.float32)
        elif operation["id"] == "sigmoid":
            result = 1.0 / (1.0 + np.exp(-np.clip(result, -88.0, 88.0)))
        else:
            raise ModelPackageError(f"Unsupported postprocessing operation: {operation['id']}")
    if not np.isfinite(result).all():
        raise ModelPackageError("Model postprocessing produced NaN or Inf")
    return np.ascontiguousarray(result, dtype=np.float32)


def _validate_probabilities(array: np.ndarray) -> None:
    if not np.isfinite(array).all() or np.any(array < 0) or np.any(array > 1):
        raise ModelPackageError(
            "Declared probability output contains non-finite or out-of-range values"
        )


def run_reference_test(
    package: ModelPackage | str | os.PathLike[str],
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> ReferenceResult:
    """Validate the graph and reproduce its supplier/package reference output."""

    if not isinstance(package, ModelPackage):
        package = inspect_model_package(package)
    else:
        package = _reverify_package(package)
    reference_input = _load_array(package, package.reference_input)
    expected = _load_array(package, package.reference_output)
    if reference_input.shape != package.input.shape or expected.shape not in {
        package.output.shape,
        (
            package.output.shape[0],
            package.output.shape[1],
            package.output.shape[2] - 2 * package.halo_yx[0],
            package.output.shape[3] - 2 * package.halo_yx[1],
        ),
    }:
        raise ModelPackageError("Reference tensor shapes do not match the package contract")
    session, runtime = _onnx_session(package, working_bytes=working_bytes)
    prepared, preprocessing = _preprocess(reference_input, package.preprocessing)
    actual = _postprocess(
        session.run([package.output.id], {package.input.id: prepared})[0], package.postprocessing
    )
    _validate_probabilities(actual)
    _validate_probabilities(expected)
    actual = _crop_halo(actual, package.halo_yx)
    expected = _crop_expected(expected, package)
    if actual.shape != expected.shape:
        raise ModelPackageError("Reference output shape differs after halo cropping")
    difference = np.abs(actual.astype(np.float64) - expected.astype(np.float64))
    allowed = package.atol + package.rtol * np.abs(expected.astype(np.float64))
    mismatches = int(np.count_nonzero(difference > allowed))
    mismatch_ppm = int(math.ceil(mismatches * 1_000_000 / max(1, expected.size)))
    if mismatch_ppm > package.mismatched_elements_per_million:
        raise ModelPackageError(
            f"ONNX reference test failed: {mismatch_ppm} mismatched elements per million"
        )
    return ReferenceResult(
        compatible=True,
        package=MappingProxyType(package.public_record()),
        runtime=MappingProxyType({**runtime, "preprocessing": preprocessing}),
        comparison=MappingProxyType(
            {
                "shape": list(actual.shape),
                "dtype": "float32",
                "rtol": package.rtol,
                "atol": package.atol,
                "mismatched_elements": mismatches,
                "mismatched_elements_per_million": mismatch_ppm,
                "maximum_absolute_error": float(difference.max(initial=0)),
            }
        ),
    )


def _crop_halo(array: np.ndarray, halo: tuple[int, int]) -> np.ndarray:
    hy, hx = halo
    ys = slice(hy, -hy if hy else None)
    xs = slice(hx, -hx if hx else None)
    return np.ascontiguousarray(array[:, :, ys, xs])


def _crop_expected(array: np.ndarray, package: ModelPackage) -> np.ndarray:
    return _crop_halo(array, package.halo_yx) if array.shape == package.output.shape else array


def _source_tensor(package: ModelPackage, array: np.ndarray, source_axes: str) -> np.ndarray:
    source = np.asarray(array)
    if source_axes == "YX":
        if source.ndim != 2:
            raise ModelPackageError("source_axes YX requires a two-dimensional array")
        source = source[None, ...]
    elif source_axes == "CYX":
        if source.ndim != 3:
            raise ModelPackageError("source_axes CYX requires a three-dimensional array")
    else:
        raise ModelPackageError("source_axes must be explicitly YX or CYX")
    if source.dtype.kind not in "uif" or source.dtype == np.float16:
        raise ModelPackageError("Source values must use a supported real numeric dtype")
    if source.size > MAX_TENSOR_ELEMENTS or not np.isfinite(source).all():
        raise ModelPackageError("Source tensor is oversized or contains NaN/Inf")
    indices = [index for _, index in package.input.channels]
    if max(indices) >= source.shape[0]:
        raise ModelPackageError("Declared model channel mapping exceeds the source channels")
    return np.ascontiguousarray(source[indices][None, ...], dtype=np.float32)


def run_inference(
    package: ModelPackage | str | os.PathLike[str],
    array: np.ndarray,
    *,
    source_axes: Literal["YX", "CYX"],
    source_scale_yx: tuple[float, float],
    source_scale_unit: str,
    purpose: Literal["preview", "run"] = "run",
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> InferenceResult:
    """Run bounded tiled inference after an independent reference qualification.

    Callers must retain the returned record with adopted results.  ``preview``
    is explicitly marked non-adopted; the numerical route is otherwise the same.
    """

    if not isinstance(package, ModelPackage):
        package = inspect_model_package(package)
    else:
        package = _reverify_package(package)
    if purpose not in {"preview", "run"}:
        raise ModelPackageError("purpose must be preview or run")
    qualification = run_reference_test(package, working_bytes=working_bytes)
    scale = tuple(_finite(item, "source scale", 1e-12, 1e12) for item in source_scale_yx)
    if scale != package.input.scale_yx or source_scale_unit != package.input.scale_unit:
        raise ModelPackageError(
            "Source and model physical scales differ; implicit resampling is forbidden"
        )
    source = _source_tensor(package, array, source_axes)
    output_elements = package.output.shape[1] * source.shape[2] * source.shape[3]
    core_y = package.input_yx[0] - 2 * package.halo_yx[0]
    core_x = package.input_yx[1] - 2 * package.halo_yx[1]
    padded_y = math.ceil(source.shape[2] / core_y) * core_y + 2 * package.halo_yx[0]
    padded_x = math.ceil(source.shape[3] / core_x) * core_x + 2 * package.halo_yx[1]
    padded_elements = source.shape[1] * padded_y * padded_x
    estimated = (
        source.nbytes
        + padded_elements * 4
        + output_elements * 4 * 2
        + math.prod(package.input.shape) * 8
    )
    if estimated > working_bytes:
        raise ModelPackageError("Inference exceeds the working-memory budget")
    session, runtime = _onnx_session(package, working_bytes=working_bytes)
    probabilities, preprocessing = _tiled_inference(package, session, source)
    labels = None
    if package.label_threshold is not None:
        assert package.label_channel is not None
        labels = np.ascontiguousarray(
            probabilities[package.label_channel] >= package.label_threshold,
            dtype=np.uint8,
        )
    record = {
        "purpose": purpose,
        "adopted": purpose == "run",
        "reference_qualification": {
            "compatible": qualification.compatible,
            "comparison": dict(qualification.comparison),
            "runtime": dict(qualification.runtime),
        },
        "package": package.public_record(),
        "runtime": runtime,
        "source": {
            "axes": source_axes,
            "shape": list(np.asarray(array).shape),
            "dtype": str(np.asarray(array).dtype),
            "channel_mapping": [
                {"model_channel": name, "source_index": index}
                for name, index in package.input.channels
            ],
            "scale_yx": list(scale),
            "scale_unit": source_scale_unit,
        },
        "preprocessing": preprocessing,
        "tiling": {
            "input_yx": list(package.input_yx),
            "halo_yx": list(package.halo_yx),
            "core_yx": [
                package.input_yx[0] - 2 * package.halo_yx[0],
                package.input_yx[1] - 2 * package.halo_yx[1],
            ],
            "padding": package.padding,
            "stitching": "halo-crop",
        },
        "postprocessing": [_operation_record(operation) for operation in package.postprocessing],
        "output": {
            "probabilities_axes": "CYX",
            "probabilities_dtype": "float32",
            "probabilities_shape": list(probabilities.shape),
            "labels_axes": "YX" if labels is not None else None,
            "labels_dtype": "uint8" if labels is not None else None,
        },
        "meaning": "technical model output; no biological or clinical validity claim",
    }
    return InferenceResult(probabilities, labels, MappingProxyType(record))


def preview_inference(
    package: ModelPackage | str | os.PathLike[str],
    array: np.ndarray,
    *,
    source_axes: Literal["YX", "CYX"],
    source_scale_yx: tuple[float, float],
    source_scale_unit: str,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> InferenceResult:
    return run_inference(
        package,
        array,
        source_axes=source_axes,
        source_scale_yx=source_scale_yx,
        source_scale_unit=source_scale_unit,
        purpose="preview",
        working_bytes=working_bytes,
    )


def _tiled_inference(
    package: ModelPackage, session: Any, source: np.ndarray
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    _, _, height, width = source.shape
    tile_y, tile_x = package.input_yx
    halo_y, halo_x = package.halo_yx
    core_y, core_x = tile_y - 2 * halo_y, tile_x - 2 * halo_x
    pad_bottom = math.ceil(height / core_y) * core_y - height
    pad_right = math.ceil(width / core_x) * core_x - width
    padded = np.pad(
        source,
        ((0, 0), (0, 0), (halo_y, halo_y + pad_bottom), (halo_x, halo_x + pad_right)),
        mode=package.padding,
    )
    output = np.empty(
        (package.output.shape[1], height + pad_bottom, width + pad_right), dtype=np.float32
    )
    preprocessing_records: list[dict[str, Any]] = []
    tile_count = 0
    for y in range(0, height + pad_bottom, core_y):
        for x in range(0, width + pad_right, core_x):
            tile = np.ascontiguousarray(padded[:, :, y : y + tile_y, x : x + tile_x])
            prepared, records = _preprocess(tile, package.preprocessing)
            predicted = _postprocess(
                session.run([package.output.id], {package.input.id: prepared})[0],
                package.postprocessing,
            )
            _validate_probabilities(predicted)
            if predicted.shape != package.output.shape:
                raise ModelPackageError("ONNX Runtime returned an unexpected output shape")
            core = _crop_halo(predicted, package.halo_yx)[0]
            output[:, y : y + core_y, x : x + core_x] = core
            if tile_count < 16:
                preprocessing_records.append({"tile": tile_count, "operations": records})
            tile_count += 1
    return np.ascontiguousarray(output[:, :height, :width]), [
        {
            "scope": "per-tile",
            "tile_count": tile_count,
            "recorded_tiles": preprocessing_records,
            "record_limit": 16,
        }
    ]


def import_model_package(
    source: str | os.PathLike[str],
    managed_root: str | os.PathLike[str],
    *,
    working_bytes: int = DEFAULT_WORKING_BYTES,
) -> tuple[ModelPackage, ReferenceResult]:
    """Qualify and atomically copy a local package into an existing model root."""

    package = inspect_model_package(source)
    run_reference_test(package, working_bytes=working_bytes)
    destination_root = Path(managed_root)
    root_stat = destination_root.stat(follow_symlinks=False)
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise ModelPackageError("Managed model root must be an existing real directory")
    target = destination_root / f"{package.id}-{package.version}"
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"Managed model package already exists: {target.name}")
    temporary = Path(tempfile.mkdtemp(prefix=".loci-model-import-", dir=destination_root))
    try:
        for entry in package.files:
            source_path = package.root / entry.source
            destination_path = temporary / entry.source
            stream, identity = _open_regular(source_path)
            with stream, destination_path.open("xb") as output:
                shutil.copyfileobj(stream, output, length=8 * 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            _verify_unchanged(source_path, identity)
        copied = inspect_model_package(temporary)
        copied_qualification = run_reference_test(copied, working_bytes=working_bytes)
        if copied.package_sha256 != package.package_sha256:
            raise ModelPackageError("Copied package identity differs from the qualified source")
        from .export import _fsync_directory, _rename_noreplace

        _rename_noreplace(temporary, target)
        _fsync_directory(destination_root)
        adopted = inspect_model_package(target)
        return adopted, copied_qualification
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
