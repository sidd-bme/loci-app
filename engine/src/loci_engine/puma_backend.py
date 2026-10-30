"""Bounded, optional PUMA CPU execution returning unadopted numeric artifacts.

Only a trusted caller may supply an approved local checkpoint path. There is no
downloader, arbitrary architecture/package loader, upstream nnU-Net import, or
unsafe pickle fallback. Source decoding, source grants and atomic study adoption
remain the shared research layer's responsibility. Full normalization context is
explicit and cannot be replaced by an output ROI.

Preprocessing and tiling formulas are adapted from the pinned MIT PUMA source:
Copyright (c) 2025 Medical Image Analysis Group Eindhoven (IMAG/e)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import hashlib
import os
import platform
import re
import stat
import threading
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, BinaryIO

import numpy as np

from .puma_architecture import make_network, validate_state
from .tissue_model_profiles import (
    PUMA_CLASS_NAMES,
    PUMA_EPIDERMIS_CLASS,
    PUMA_MAX_CONTEXT_EDGE,
    PUMA_MAX_WORKING_BYTES,
    PUMA_MIN_WORKING_BYTES,
    PUMA_NUMERIC_PROFILE,
    PUMA_PATCH_EDGE,
    PUMA_PROFILE_ID,
    PUMA_RGB_POLICY,
    PUMA_RUNTIME_VERSIONS,
    PUMA_TENSOR_BYTES,
    PUMA_TORCH_GIT_VERSION,
    PUMA_WEIGHTS_BYTES,
    PUMA_WEIGHTS_SHA256,
    puma_profile,
    runtime_metadata_status,
)

Check = Callable[[], None]
Progress = Callable[[int, int], None]
_EXECUTION_LOCK = threading.Lock()
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_REQUEST_KEYS = {
    "source_sha256",
    "source_kind",
    "source_shape_yx",
    "series",
    "context_selection",
    "output_roi_yxhw",
    "rgb_policy",
}
_SELECTION_KEYS = {"x", "y", "width", "height", "z", "t", "c", "level"}


class PumaBackendError(ValueError):
    """An unsupported or unverifiable PUMA input, artifact or numerical state."""


@dataclass(frozen=True, slots=True)
class ApprovedPumaWeights:
    """Trusted-boundary input, never a renderer/MCP path-bearing request."""

    path: Path
    sha256: str
    size_bytes: int

    def validate(self) -> None:
        if (
            not isinstance(self.path, Path)
            or not self.path.is_absolute()
            or self.sha256 != PUMA_WEIGHTS_SHA256
            or type(self.size_bytes) is not int
            or self.size_bytes != PUMA_WEIGHTS_BYTES
        ):
            raise PumaBackendError("An approved absolute path and exact PUMA identity are required")


@dataclass(frozen=True, slots=True)
class PumaInference:
    """Original model arrays only; no adopted result or editable instance labels."""

    arrays: Mapping[str, np.ndarray]
    record: Mapping[str, Any]


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PumaBackendError(message)


def _check(check: Check | None) -> None:
    if check is not None:
        check()


def _integer(value: Any, low: int, high: int, message: str) -> int:
    _require(type(value) is int and low <= value <= high, message)
    return value


def _vector(value: Any, length: int, message: str) -> list[int]:
    _require(
        type(value) is list and len(value) == length and all(type(v) is int for v in value),
        message,
    )
    return list(value)


def _array_hash(array: np.ndarray) -> str:
    return hashlib.sha256(array.tobytes(order="C")).hexdigest()


def _validate_input(context_rgb: np.ndarray, request: Any) -> dict[str, Any]:
    _require(type(request) is dict and set(request) == _REQUEST_KEYS, "Invalid PUMA request fields")
    _require(
        type(context_rgb) is np.ndarray
        and context_rgb.dtype == np.uint8
        and context_rgb.ndim == 3
        and context_rgb.shape[-1] in (3, 4),
        "PUMA requires a decoded uint8 YXRGB or YXRGBA context array",
    )
    height, width = context_rgb.shape[:2]
    _require(
        0 < height <= PUMA_MAX_CONTEXT_EDGE and 0 < width <= PUMA_MAX_CONTEXT_EDGE,
        "PUMA CPU context must be at most 1024 pixels on either axis",
    )
    _require(
        request["source_kind"] == "native" and request["rgb_policy"] == PUMA_RGB_POLICY,
        "PUMA requires a native image and its explicit first-three-samples policy",
    )
    _require(
        isinstance(request["source_sha256"], str)
        and _SHA256.fullmatch(request["source_sha256"]) is not None,
        "PUMA requires the exact registered source fingerprint",
    )
    source_shape = _vector(request["source_shape_yx"], 2, "Source shape must be explicit YX")
    _require(source_shape == [height, width], "PUMA context must cover the complete source plane")
    series = _integer(request["series"], 0, 65535, "PUMA source series is invalid")
    selection = request["context_selection"]
    _require(
        type(selection) is dict and set(selection) == _SELECTION_KEYS,
        "PUMA requires an exact context selection with T/Z/channel/level",
    )
    for key in _SELECTION_KEYS:
        _integer(selection[key], 0, 2**31 - 1, "PUMA context selection is invalid")
    _require(
        selection["x"] == selection["y"] == selection["c"] == selection["level"] == 0
        and selection["width"] == width
        and selection["height"] == height,
        "PUMA context must be the full native plane at level zero, not a viewport or channel set",
    )
    roi = _vector(request["output_roi_yxhw"], 4, "PUMA output ROI must be explicit YXHW")
    y, x, rh, rw = roi
    _require(
        0 <= y < height and 0 <= x < width and 0 < rh <= height - y and 0 < rw <= width - x,
        "PUMA output ROI is outside the source grid",
    )
    return {
        "source_sha256": request["source_sha256"],
        "source_kind": "native",
        "source_shape_yx": source_shape,
        "series": series,
        "context_selection": dict(selection),
        "output_roi_yxhw": roi,
        "output_selection": {**selection, "y": y, "x": x, "height": rh, "width": rw},
        "rgb_policy": PUMA_RGB_POLICY,
        "roi_changes_context": False,
        "context_authorization": "caller-must-grant-entire-context-before-decoding",
    }


def resource_preflight(
    context_rgb: np.ndarray, request: dict[str, Any], *, working_bytes: int
) -> dict[str, Any]:
    """Bound before normalization, hashing, native imports or weight loading."""
    accepted = _validate_input(context_rgb, request)
    _integer(
        working_bytes,
        PUMA_MIN_WORKING_BYTES,
        PUMA_MAX_WORKING_BYTES,
        "PUMA CPU requires an explicit working allowance between 2 and 8 GiB",
    )
    context_pixels = int(context_rgb.shape[0] * context_rgb.shape[1])
    _, _, height, width = accepted["output_roi_yxhw"]
    # These reservations deliberately include simultaneous decoded input,
    # source/crop/padding copies, masks, serialization copies and temporary
    # score/softmax arrays. They are conservative accounting, not a hard RSS cap.
    components = {
        "checkpoint_and_parameter_reserve": 3 * PUMA_TENSOR_BYTES,
        "feature_and_native_workspace_reserve": 1024**3,
        "context_workspace_reserve": max(context_pixels, PUMA_PATCH_EDGE**2) * 192,
        "output_workspace_reserve": height * width * 128,
    }
    estimated = sum(components.values())
    required = max(PUMA_MIN_WORKING_BYTES, estimated)
    _require(required <= working_bytes, "PUMA aggregate memory estimate exceeds the allowance")
    return {
        "policy": "puma-cpu-full-context-three-model-slots-and-workspace/v1",
        "working_memory_limit_bytes": working_bytes,
        "estimated_required_bytes": estimated,
        "required_allowance_bytes": required,
        "components": components,
        "context_pixels": context_pixels,
        "output_pixels": height * width,
        "maximum_context_edge": PUMA_MAX_CONTEXT_EDGE,
        "intra_op_threads": 1,
        "simultaneous_tiles": 1,
        "simultaneous_mirrors": 1,
        "hard_process_rss_limit": False,
        "measured_target_runtime_qualification": "pending",
    }


def _steps(shape_yx: list[int]) -> list[list[int]]:
    result = []
    for size in shape_yx:
        _require(size >= PUMA_PATCH_EDGE, "Tile planning requires a padded context")
        count = int(np.ceil((size - PUMA_PATCH_EDGE) / (PUMA_PATCH_EDGE * 0.5))) + 1
        distance = (size - PUMA_PATCH_EDGE) / (count - 1) if count > 1 else 99999999999
        result.append([int(np.round(distance * index)) for index in range(count)])
    return result


def _prepare_rgb(
    context_rgb: np.ndarray, *, check: Check | None = None
) -> tuple[np.ndarray, dict[str, Any], dict[str, Any]]:
    _check(check)
    height, width = context_rgb.shape[:2]
    rgb = np.ascontiguousarray(context_rgb[..., :3])
    decoding: dict[str, Any] = {
        "decoded_shape_yxs": list(context_rgb.shape),
        "decoded_dtype": "uint8",
        "decoded_array_sha256": _array_hash(context_rgb),
        "rgb_array_sha256": _array_hash(rgb),
        "rgb_policy": PUMA_RGB_POLICY,
        "display_transforms_used": False,
        "alpha_discarded": context_rgb.shape[-1] == 4,
    }
    if context_rgb.shape[-1] == 4:
        alpha = context_rgb[..., 3]
        decoding["discarded_sample"] = {
            "minimum": int(alpha.min()),
            "maximum": int(alpha.max()),
            "sha256": _array_hash(alpha),
            "meaning": "upstream-first-three-samples-policy; no compositing",
        }
    source = np.ascontiguousarray(rgb.transpose(2, 0, 1), dtype=np.float32)
    nonzero = np.any(source != 0, axis=0)
    ys = np.flatnonzero(np.any(nonzero, axis=1))
    xs = np.flatnonzero(np.any(nonzero, axis=0))
    # Filling internal holes cannot change these nonzero bounding extrema.
    # The pinned ACVL helper retains the full extent on an all-zero source.
    y0, y1 = (int(ys[0]), int(ys[-1]) + 1) if ys.size else (0, height)
    x0, x1 = (int(xs[0]), int(xs[-1]) + 1) if xs.size else (0, width)
    cropped = source[:, y0:y1, x0:x1].copy()
    statistics = []
    for index, name in enumerate(("R", "G", "B")):
        _check(check)
        mean, std = cropped[index].mean(), cropped[index].std()
        denominator = max(std, 1e-8)
        cropped[index] = (cropped[index] - mean) / denominator
        statistics.append(
            {
                "sample": name,
                "mean": float(mean),
                "std_population": float(std),
                "denominator": float(denominator),
                "count": int(cropped[index].size),
            }
        )
    _require(bool(np.isfinite(cropped).all()), "PUMA normalized context contains nonfinite values")
    below = [max(PUMA_PATCH_EDGE - size, 0) // 2 for size in cropped.shape[1:]]
    above = [
        max(PUMA_PATCH_EDGE - size, 0) - low
        for size, low in zip(cropped.shape[1:], below, strict=True)
    ]
    padded = np.pad(
        cropped,
        ((0, 0), (below[0], above[0]), (below[1], above[1])),
        mode="constant",
        constant_values=0,
    )
    return (
        padded,
        {
            "source_shape_yx": [height, width],
            "crop_bbox_yx": [[y0, y1], [x0, x1]],
            "cropped_shape_yx": list(cropped.shape[1:]),
            "padding_before_yx": below,
            "padding_after_yx": above,
            "padded_shape_yx": list(padded.shape[1:]),
            "normalization_scope": "full-context-nonzero-bounding-box-before-padding",
            "statistics": statistics,
            "normalized_crop_sha256": _array_hash(cropped),
            "padded_input_sha256": _array_hash(padded),
            "axes": "CYX",
            "dtype": "float32",
            "resampling": "none",
            "model_grid_spacing_yx": [1, 1],
            "model_grid_is_physical_calibration": False,
        },
        decoding,
    )


def _plan_tiles(preprocessing: dict[str, Any], roi: list[int]) -> dict[str, Any]:
    y, x, height, width = roi
    (cy0, cy1), (cx0, cx1) = preprocessing["crop_bbox_yx"]
    py, px = preprocessing["padding_before_yx"]
    iy0, iy1 = max(y, cy0), min(y + height, cy1)
    ix0, ix1 = max(x, cx0), min(x + width, cx1)
    grid = _steps(preprocessing["padded_shape_yx"])
    tiles = []
    if iy0 < iy1 and ix0 < ix1:
        target = (iy0 - cy0 + py, iy1 - cy0 + py, ix0 - cx0 + px, ix1 - cx0 + px)
        for ty in grid[0]:
            for tx in grid[1]:
                ay0, ay1 = max(ty, target[0]), min(ty + PUMA_PATCH_EDGE, target[1])
                ax0, ax1 = max(tx, target[2]), min(tx + PUMA_PATCH_EDGE, target[3])
                if ay0 < ay1 and ax0 < ax1:
                    tiles.append(
                        {
                            "origin_padded_yx": [ty, tx],
                            "patch_intersection_yx": [[ay0 - ty, ay1 - ty], [ax0 - tx, ax1 - tx]],
                            "output_intersection_yx": [
                                [ay0 - py + cy0 - y, ay1 - py + cy0 - y],
                                [ax0 - px + cx0 - x, ax1 - px + cx0 - x],
                            ],
                        }
                    )
    return {
        "output_roi_yxhw": list(roi),
        "full_grid_starts_yx": grid,
        "full_tile_count": len(grid[0]) * len(grid[1]),
        "evaluated_tile_count": len(tiles),
        "tiles": tiles,
        "computed_bbox_output_yx": (
            [[iy0 - y, iy1 - y], [ix0 - x, ix1 - x]] if iy0 < iy1 and ix0 < ix1 else None
        ),
        "roi_is_postprocessing_selection": True,
        "roi_changes_normalization_or_tile_grid": False,
        "source_to_output_yx_offset": [-y, -x],
        "class_background_outside_nonzero_bbox": 0,
        "planned_network_calls": len(tiles) * 4,
    }


def _prepare(
    context_rgb: np.ndarray,
    request: dict[str, Any],
    working_bytes: int,
    check: Check | None,
) -> tuple[np.ndarray, dict[str, Any]]:
    _require(check is None or callable(check), "PUMA cancellation guard must be callable")
    _check(check)
    resource = resource_preflight(context_rgb, request, working_bytes=working_bytes)
    accepted = _validate_input(context_rgb, request)
    padded, preprocessing, decoding = _prepare_rgb(context_rgb, check=check)
    plan = _plan_tiles(preprocessing, accepted["output_roi_yxhw"])
    _check(check)
    return padded, {
        "request": accepted,
        "decoding": decoding,
        "preprocessing": preprocessing,
        "tiles": plan,
        "resource_preflight": resource,
    }


def plan_puma(
    context_rgb: np.ndarray,
    request: dict[str, Any],
    *,
    working_bytes: int,
    check: Check | None = None,
) -> dict[str, Any]:
    """Compute a source-bound plan without importing Torch or reading weights."""
    _, record = _prepare(context_rgb, request, working_bytes, check)
    _require(
        _array_hash(context_rgb) == record["decoding"]["decoded_array_sha256"],
        "PUMA context changed while planning",
    )
    return {"status": "planned-not-executed", "profile": puma_profile(), **record}


def _identity(path: Path) -> tuple[int, int, int, int, int]:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError("Approved PUMA model file is missing") from exc
    except OSError as exc:
        raise PumaBackendError("Approved PUMA model file cannot be inspected") from exc
    _require(stat.S_ISREG(info.st_mode), "PUMA weights must be a regular nonsymlink file")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _hash_stream(stream: BinaryIO, *, check: Check | None = None) -> str:
    stream.seek(0)
    digest, total = hashlib.sha256(), 0
    while chunk := stream.read(1024**2):
        _check(check)
        total += len(chunk)
        _require(total <= PUMA_WEIGHTS_BYTES, "PUMA checkpoint exceeds its exact byte bound")
        digest.update(chunk)
    _require(total == PUMA_WEIGHTS_BYTES, "PUMA checkpoint has the wrong byte length")
    stream.seek(0)
    return digest.hexdigest()


@contextmanager
def _verified_weights(weights: ApprovedPumaWeights, check: Check | None = None):
    _require(type(weights) is ApprovedPumaWeights, "Use the trusted approved-weight boundary")
    weights.validate()
    _check(check)
    try:
        resolved = weights.path.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise PumaBackendError("Approved PUMA model path cannot be resolved") from exc
    _require(resolved == weights.path, "PUMA model path contains a link")
    before = _identity(weights.path)
    _require(before[2] == PUMA_WEIGHTS_BYTES, "PUMA checkpoint has the wrong byte length")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(weights.path, flags)
    except OSError as exc:
        raise PumaBackendError("Approved PUMA model file cannot be opened") from exc
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        _require(
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
            == before,
            "PUMA model changed while opening",
        )
        _require(
            _hash_stream(stream, check=check) == PUMA_WEIGHTS_SHA256, "PUMA weight hash mismatch"
        )
        _require(_identity(weights.path) == before, "PUMA weights changed while hashing")
        yield stream
        _require(
            _identity(weights.path) == before
            and _hash_stream(stream, check=check) == PUMA_WEIGHTS_SHA256
            and _identity(weights.path) == before,
            "PUMA weights changed during use",
        )


def inspect_puma_status(
    weights: ApprovedPumaWeights | None = None, *, verify_weights: bool = False
) -> dict[str, Any]:
    """Report actual missing/invalid state, never simulated compatibility success."""
    runtime = runtime_metadata_status()
    weight_status: dict[str, Any] = {"status": "missing", "verified": False}
    if weights is not None:
        try:
            _require(type(weights) is ApprovedPumaWeights, "Use the approved-weight boundary")
            weights.validate()
            if verify_weights:
                with _verified_weights(weights):
                    pass
                weight_status = {"status": "verified", "verified": True}
            else:
                _require(
                    _identity(weights.path)[2] == PUMA_WEIGHTS_BYTES, "Wrong checkpoint length"
                )
                weight_status = {"status": "present-unverified", "verified": False}
        except FileNotFoundError:
            weight_status = {"status": "missing", "verified": False}
        except (OSError, ValueError, RuntimeError):
            weight_status = {"status": "invalid", "verified": False}
    return {
        "profile": puma_profile(),
        "runtime": runtime,
        "weights": weight_status,
        "status": (
            "unavailable"
            if runtime["status"] in {"missing", "mismatch"}
            or weight_status["status"] in {"missing", "invalid"}
            else "compatibility-unverified"
        ),
        "ready": False,
        "model_execution_performed": False,
        "meaning": "metadata/artifact inspection only; exact target compatibility is pending",
    }


def _import_runtime() -> tuple[Any, Any, dict[str, Any]]:
    status = runtime_metadata_status()
    _require(
        status["status"] == "metadata-matches-unverified",
        "The exact optional PUMA engine CPU runtime is missing or mismatched",
    )
    _require(
        "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD" not in os.environ,
        "Unsafe Torch serialization override is present",
    )
    try:
        import scipy
        import torch
        from scipy.ndimage import gaussian_filter
    except (ImportError, OSError) as exc:
        raise PumaBackendError("The exact optional PUMA runtime could not be imported") from exc
    _require(
        str(torch.__version__) == PUMA_RUNTIME_VERSIONS["torch"]
        and torch.version.git_version == PUMA_TORCH_GIT_VERSION
        and np.__version__ == PUMA_RUNTIME_VERSIONS["numpy"]
        and scipy.__version__ == PUMA_RUNTIME_VERSIONS["scipy"],
        "Loaded PUMA runtime differs from the pinned target",
    )
    _checked_serialization_globals(torch)
    return (
        torch,
        gaussian_filter,
        {
            "numeric_profile": PUMA_NUMERIC_PROFILE,
            "versions": dict(PUMA_RUNTIME_VERSIONS),
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "torch_git_version": torch.version.git_version,
            "torch_build_configuration_sha256": hashlib.sha256(
                torch.__config__.show().encode()
            ).hexdigest(),
            "device": "cpu",
            "intra_op_threads": 1,
            "deterministic_algorithms": True,
            "autocast": False,
            "runtime_import_verified": True,
            "technical_compatibility_verified": False,
            "modeling_prototype_parity": "unverified-distinct-runtime",
            "official_cuda_runtime_parity": "unverified",
            "added_serialization_globals": [],
            "serialization_policy": {
                "load_window": "zero-added-globals-weights-only-cpu",
                "known_torch_defaults": "identity-checked-cleared-for-load-restored-afterward",
                "process_ownership": "exclusive-disposable-worker-required",
            },
        },
    )


def _checked_serialization_globals(torch: Any) -> list[Any]:
    """Accept only empty state or this pinned Torch build's own default objects."""
    current = torch.serialization.get_safe_globals()
    if not current:
        return []
    _require(len(current) in (4, 14), "Extra serialization globals are present")
    from torch.distributed._mesh_layout import _FlatLayout, _MeshLayout
    from torch.nested._internal.nested_tensor import NestedTensor, _rebuild_njt

    expected = (NestedTensor, _rebuild_njt, _FlatLayout, _MeshLayout)
    if len(current) == 14:
        # Entering the pinned Torch autocast context lazily registers these
        # ten additional defaults. Resolve actual objects only in that state;
        # eager imports would themselves alter the initial four-object state.
        from torch._dynamo.decorators import _DimRange
        from torch.distributed.device_mesh import DeviceMesh
        from torch.distributed.tensor import DTensor
        from torch.distributed.tensor._dtensor_spec import DTensorSpec, ShardOrderEntry, TensorMeta
        from torch.distributed.tensor.placement_types import (
            Partial,
            Replicate,
            Shard,
            _StridedShard,
        )

        expected += (
            _DimRange,
            DeviceMesh,
            DTensor,
            DTensorSpec,
            ShardOrderEntry,
            TensorMeta,
            Partial,
            Replicate,
            Shard,
            _StridedShard,
        )
    _require(
        len({id(value) for value in current}) == len(expected)
        and {id(value) for value in current} == {id(value) for value in expected},
        "Extra serialization globals are present",
    )
    return list(current)


@contextmanager
def _tensor_only_loading(torch: Any):
    # Torch registers defaults at import/context entry. They are unnecessary for
    # this exact tensor dictionary and are removed for the entire load window. This modifies
    # process-wide state: the caller must own an exclusive disposable model worker.
    previous = _checked_serialization_globals(torch)
    if previous:
        torch.serialization.clear_safe_globals()
    try:
        _require(torch.serialization.get_safe_globals() == [], "Extra serialization globals")
        yield
    finally:
        changed = torch.serialization.get_safe_globals() != []
        if previous:
            # Do not erase unexpected concurrent additions. Restore the known
            # defaults, fail closed, and let the owning worker terminate.
            torch.serialization.add_safe_globals(previous)
        _require(not changed, "Serialization globals changed during tensor-only loading")


@contextmanager
def _torch_cpu_execution(torch: Any):
    threads = torch.get_num_threads()
    deterministic = torch.are_deterministic_algorithms_enabled()
    warn_only = torch.is_deterministic_algorithms_warn_only_enabled()
    try:
        torch.set_num_threads(1)
        torch.use_deterministic_algorithms(True)
        with torch.inference_mode(), torch.autocast(device_type="cpu", enabled=False):
            yield
    finally:
        torch.use_deterministic_algorithms(deterministic, warn_only=warn_only)
        torch.set_num_threads(threads)


def _load_network(torch: Any, stream: BinaryIO, check: Check | None) -> tuple[Any, dict[str, Any]]:
    _check(check)
    with _tensor_only_loading(torch):
        state = torch.load(stream, map_location="cpu", weights_only=True)
    _require(
        type(state) is dict and set(state) == {"network_weights"},
        "PUMA converted checkpoint has an unexpected root",
    )
    weights = state["network_weights"]
    tensor_record = validate_state(torch, weights, check=check)
    _require(
        tensor_record["tensor_keys"] == 396
        and tensor_record["unique_storages"] == 148
        and tensor_record["tensor_bytes"] == PUMA_TENSOR_BYTES,
        "PUMA checkpoint schema or total storage differs from the fixed architecture",
    )
    network = make_network(torch)
    architecture_record = validate_state(torch, network.state_dict(), check=check)
    _require(architecture_record == tensor_record, "PUMA module hierarchy has a different schema")
    loaded = network.load_state_dict(weights, strict=True)
    _require(
        not loaded.missing_keys and not loaded.unexpected_keys,
        "PUMA strict weight loading failed",
    )
    _checked_serialization_globals(torch)
    network.eval()
    network.requires_grad_(False)
    _check(check)
    return network, tensor_record


def _gaussian(torch: Any, gaussian_filter: Any) -> Any:
    impulse = np.zeros((PUMA_PATCH_EDGE, PUMA_PATCH_EDGE), dtype=np.float64)
    impulse[PUMA_PATCH_EDGE // 2, PUMA_PATCH_EDGE // 2] = 1
    data = gaussian_filter(impulse, [64.0, 64.0], order=0, mode="constant", cval=0)
    importance = torch.from_numpy(data)
    importance = (importance / torch.max(importance) * 10).to(dtype=torch.float16, device="cpu")
    importance[importance == 0] = torch.min(importance[importance != 0])
    _require(
        bool(torch.isfinite(importance).all().item()) and bool((importance > 0).all().item()),
        "PUMA Gaussian contains nonfinite or nonpositive values",
    )
    return importance


def _prediction(torch: Any, network: Any, patch: Any, check: Check | None) -> Any:
    prediction = None
    for axes in ((), (2,), (3,), (2, 3)):
        _check(check)
        value = network(torch.flip(patch, axes) if axes else patch)
        _check(check)
        _require(
            type(value) is torch.Tensor
            and value.dtype is torch.float32
            and value.device.type == "cpu"
            and tuple(value.shape) == (1, 6, PUMA_PATCH_EDGE, PUMA_PATCH_EDGE)
            and bool(torch.isfinite(value).all().item()),
            "PUMA network returned an invalid or nonfinite logit tensor",
        )
        value = torch.flip(value, axes) if axes else value
        if prediction is None:
            prediction = value
        else:
            prediction += value
    prediction /= 4
    _require(bool(torch.isfinite(prediction).all().item()), "PUMA mirror average is nonfinite")
    return prediction[0]


def _infer_tiles(
    torch: Any,
    network: Any,
    padded: np.ndarray,
    plan: dict[str, Any],
    importance: Any,
    *,
    check: Check | None,
    progress: Progress | None,
) -> dict[str, np.ndarray]:
    _, _, height, width = plan["output_roi_yxhw"]
    logits = torch.zeros((6, height, width), dtype=torch.float16, device="cpu")
    counts = torch.zeros((height, width), dtype=torch.float16, device="cpu")
    for index, tile in enumerate(plan["tiles"]):
        _check(check)
        ty, tx = tile["origin_padded_yx"]
        patch = torch.from_numpy(
            np.ascontiguousarray(padded[:, ty : ty + PUMA_PATCH_EDGE, tx : tx + PUMA_PATCH_EDGE])
        )[None]
        prediction = _prediction(torch, network, patch, check)
        (ay0, ay1), (ax0, ax1) = tile["patch_intersection_yx"]
        (oy0, oy1), (ox0, ox1) = tile["output_intersection_yx"]
        weighted = prediction[:, ay0:ay1, ax0:ax1] * importance[ay0:ay1, ax0:ax1]
        # Match the reference's contribution order and half in-place addition.
        logits[:, oy0:oy1, ox0:ox1] += weighted
        counts[oy0:oy1, ox0:ox1] += importance[ay0:ay1, ax0:ax1]
        _check(check)
        if progress is not None:
            progress(index + 1, len(plan["tiles"]))
    computed = counts > 0
    expected = torch.zeros_like(computed)
    if plan["computed_bbox_output_yx"] is not None:
        (y0, y1), (x0, x1) = plan["computed_bbox_output_yx"]
        expected[y0:y1, x0:x1] = True
    _require(torch.equal(computed, expected), "PUMA tile coverage differs from the exact context")
    logits[:, computed] /= counts[computed]
    _require(
        bool(torch.isfinite(logits).all().item()) and bool(torch.isfinite(counts).all().item()),
        "PUMA half accumulation overflowed; numerical profile will not be changed silently",
    )
    probabilities = torch.softmax(logits.float(), dim=0)
    probabilities[:, ~computed] = 0
    probabilities[0, ~computed] = 1
    _require(
        bool(torch.isfinite(probabilities).all().item())
        and bool(((probabilities >= 0) & (probabilities <= 1)).all().item()),
        "PUMA class scores are invalid",
    )
    labels = probabilities.argmax(dim=0).to(dtype=torch.uint8)
    _check(check)
    return {
        "logits": logits.numpy(),
        "probabilities": probabilities.numpy(),
        "class_labels": labels.numpy(),
        "epidermis_mask": (labels == PUMA_EPIDERMIS_CLASS).numpy(),
        "computed_mask": computed.numpy(),
        "weight_sum": counts.numpy(),
    }


def infer_puma(
    context_rgb: np.ndarray,
    request: dict[str, Any],
    *,
    weights: ApprovedPumaWeights,
    working_bytes: int,
    check: Check | None = None,
    progress: Progress | None = None,
) -> PumaInference:
    """Execute one explicitly approved candidate profile; never adopt a result.

    ``check`` must raise to cancel or revoke authority. It is called during
    checkpoint verification, between every mirror/tile, and before returning.
    Native kernels are not interruptible here; the owning disposable worker
    remains responsible for hard cancellation and process resource supervision.
    """
    _require(progress is None or callable(progress), "PUMA progress callback must be callable")
    padded, record = _prepare(context_rgb, request, working_bytes, check)
    # Metadata and artifact gates precede all optional native imports.
    _require(
        runtime_metadata_status()["status"] == "metadata-matches-unverified",
        "The exact optional PUMA engine CPU runtime is missing or mismatched",
    )
    _require(_EXECUTION_LOCK.acquire(blocking=False), "PUMA is already executing in this worker")
    try:
        with _verified_weights(weights, check) as stream:
            _check(check)
            torch, gaussian_filter, runtime = _import_runtime()
            with _torch_cpu_execution(torch):
                network, tensor_record = _load_network(torch, stream, check)
                importance = _gaussian(torch, gaussian_filter)
                arrays = _infer_tiles(
                    torch,
                    network,
                    padded,
                    record["tiles"],
                    importance,
                    check=check,
                    progress=progress,
                )
                gaussian_hash = _array_hash(importance.numpy())
                runtime["inter_op_threads"] = torch.get_num_interop_threads()
        _check(check)
        _require(
            _array_hash(context_rgb) == record["decoding"]["decoded_array_sha256"],
            "PUMA source context changed during inference",
        )
        descriptors = {}
        for name, array in arrays.items():
            _require(bool(np.isfinite(array).all()), "PUMA returned a nonfinite artifact")
            array.flags.writeable = False
            descriptors[name] = {
                "axes": "CYX" if array.ndim == 3 else "YX",
                "shape": list(array.shape),
                "dtype": str(array.dtype),
                "sha256": _array_hash(array),
            }
        _check(check)
        output = {
            "schema": "loci.puma-inference/v1",
            "status": "executed-not-qualified",
            "adopted": False,
            "profile": puma_profile(),
            "profile_id": PUMA_PROFILE_ID,
            **record,
            "runtime": runtime,
            "weights_validation": tensor_record,
            "execution": {
                "network_calls": record["tiles"]["planned_network_calls"],
                "model_forward_executed": bool(record["tiles"]["tiles"]),
                "gaussian_sha256": gaussian_hash,
                "class_map": {str(i): name for i, name in enumerate(PUMA_CLASS_NAMES)},
                "selected_class": PUMA_EPIDERMIS_CLASS,
                "scores_are_validated_confidence": False,
            },
            "artifacts": descriptors,
        }
        return PumaInference(MappingProxyType(arrays), MappingProxyType(output))
    finally:
        _EXECUTION_LOCK.release()
