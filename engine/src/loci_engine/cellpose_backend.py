"""Optional, explicitly provisioned adapters for verified Cellpose-SAM checkpoints.

The adapter never passes a model name to Cellpose. It verifies a managed local
checkpoint and passes its absolute filename, which prevents Cellpose's own
first-use download branch from running. Loci does not download or bundle this
checkpoint; a user-selected local file can be imported after exact digest
verification.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import os
import stat
import sys
import tempfile
import threading
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType, ModuleType
from typing import TYPE_CHECKING, BinaryIO, Literal

from .models import CellposeSettings

if TYPE_CHECKING:
    import numpy as np

    from .segment import SegmentationOutput

CELLPOSE_PACKAGE_VERSION = "4.2.1.1"
# These aliases retain the original v2 public constants for callers that have
# not yet opted into the website-compatible profile. Runtime code resolves a
# complete immutable specification instead of consulting these aliases.
CELLPOSE_MODEL_ID = "cpsam_v2"
CELLPOSE_MODEL_SHA256 = "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667"
CELLPOSE_MODEL_SIZE_BYTES = 1_233_586_851
CELLPOSE_PROFILE_ID = "cellpose-sam-v2"
CELLPOSE_WEBSITE_PROFILE_ID = "cellpose-sam"
MODEL_HOME_ENV = "LOCI_MODEL_HOME"

_HASH_CHUNK_SIZE = 8 * 1024 * 1024
_HASH_CACHE_LOCK = threading.Lock()
_HASH_CACHE: dict[tuple[str, int, int, int], str] = {}
_MODEL_CACHE_LOCK = threading.RLock()
_MODEL_CACHE: tuple[tuple[str, int, int, int, str], object] | None = None


@dataclass(frozen=True, slots=True)
class CellposeModelSpec:
    """Verified checkpoint identity for one selectable Cellpose profile."""

    profile_id: str
    artifact_id: str
    sha256: str
    size_bytes: int


CELLPOSE_SAM_V2_SPEC = CellposeModelSpec(
    profile_id=CELLPOSE_PROFILE_ID,
    artifact_id=CELLPOSE_MODEL_ID,
    sha256=CELLPOSE_MODEL_SHA256,
    size_bytes=CELLPOSE_MODEL_SIZE_BYTES,
)
CELLPOSE_SAM_WEBSITE_SPEC = CellposeModelSpec(
    profile_id=CELLPOSE_WEBSITE_PROFILE_ID,
    artifact_id="cpsam",
    sha256="e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2",
    size_bytes=1_233_587_898,
)
CELLPOSE_MODEL_SPECS = MappingProxyType(
    {
        CELLPOSE_SAM_WEBSITE_SPEC.profile_id: CELLPOSE_SAM_WEBSITE_SPEC,
        CELLPOSE_SAM_V2_SPEC.profile_id: CELLPOSE_SAM_V2_SPEC,
    }
)
CellposePreprocessingMode = Literal[
    "huggingface-space-uint8",
    "dynamic-range-preserving",
]


def resolve_cellpose_model_spec(
    value: object = CELLPOSE_PROFILE_ID,
) -> CellposeModelSpec:
    """Resolve only registered profile IDs at process boundaries.

    Internal callers may pass an immutable specification directly, which also
    keeps verification helpers straightforward to test without weakening the
    JSON worker boundary.
    """

    if isinstance(value, CellposeModelSpec):
        return value
    if not isinstance(value, str) or not value:
        raise TypeError("profile_id must be a non-empty string")
    try:
        return CELLPOSE_MODEL_SPECS[value]
    except KeyError as exc:
        raise ValueError(f"Unknown Cellpose profile: {value}") from exc


@dataclass(frozen=True, slots=True)
class CellposeBackendStatus:
    model_spec: CellposeModelSpec
    ready: bool
    code: str
    summary: str
    installed_version: str | None
    model_path: Path
    model_present: bool
    model_verified: bool
    devices: dict[str, bool | None]

    def to_dict(self) -> dict[str, object]:
        return {
            "profile_id": self.model_spec.profile_id,
            "ready": self.ready,
            "code": self.code,
            "summary": self.summary,
            "package": {
                "required_version": CELLPOSE_PACKAGE_VERSION,
                "installed_version": self.installed_version,
                "exact": self.installed_version == CELLPOSE_PACKAGE_VERSION,
            },
            "model": {
                "artifact_id": self.model_spec.artifact_id,
                "expected_sha256": self.model_spec.sha256,
                "expected_size_bytes": self.model_spec.size_bytes,
                "managed_path": os.fspath(self.model_path),
                "present": self.model_present,
                "verified": self.model_verified,
            },
            "devices": self.devices,
        }


@dataclass(frozen=True, slots=True)
class CellposeInference:
    output: SegmentationOutput
    runtime: dict[str, object]


def _default_model_home() -> Path:
    override = os.environ.get(MODEL_HOME_ENV)
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Loci" / "models"
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        root = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return root / "Loci" / "models"
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    root = Path(xdg_data_home) if xdg_data_home else Path.home() / ".local" / "share"
    return root / "loci" / "models"


def managed_model_path(
    model: object = CELLPOSE_PROFILE_ID,
) -> Path:
    spec = resolve_cellpose_model_spec(model)
    return _default_model_home() / "cellpose" / CELLPOSE_PACKAGE_VERSION / spec.artifact_id


def _file_identity(path: Path) -> tuple[str, int, int, int]:
    file_stat = path.stat(follow_symlinks=False)
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise ValueError("The managed Cellpose checkpoint must be a regular file, not a link.")
    return (
        os.fspath(path),
        int(file_stat.st_size),
        int(file_stat.st_mtime_ns),
        int(getattr(file_stat, "st_ino", 0)),
    )


def _hash_stream(stream: BinaryIO, destination: BinaryIO | None = None) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(_HASH_CHUNK_SIZE):
        size += len(chunk)
        digest.update(chunk)
        if destination is not None:
            destination.write(chunk)
    return digest.hexdigest(), size


def _verified_digest(path: Path) -> str:
    identity = _file_identity(path)
    with _HASH_CACHE_LOCK:
        cached = _HASH_CACHE.get(identity)
    if cached is not None:
        return cached
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            digest, _ = _hash_stream(stream)
    finally:
        os.close(descriptor)
    # Do not cache a digest if the file identity changed while it was read.
    if _file_identity(path) != identity:
        raise RuntimeError("The managed Cellpose checkpoint changed during verification.")
    with _HASH_CACHE_LOCK:
        # Both supported checkpoints are inspected while listing profiles. Keep
        # a small identity-keyed cache so alternating between them does not
        # re-hash more than two gigabytes on every profile refresh.
        if len(_HASH_CACHE) >= 8:
            _HASH_CACHE.pop(next(iter(_HASH_CACHE)))
        _HASH_CACHE[identity] = digest
    return digest


def _installed_cellpose_version() -> str | None:
    try:
        return importlib.metadata.version("cellpose")
    except importlib.metadata.PackageNotFoundError:
        return None


def _import_runtime() -> tuple[ModuleType, ModuleType]:
    import torch
    from cellpose import models as cellpose_models

    return cellpose_models, torch


def _runtime_diagnostics(
    installed_version: str | None,
    *,
    inspect_devices: bool,
) -> tuple[dict[str, bool | None], str | None]:
    """Import the exact runtime before advertising Cellpose as usable.

    Distribution metadata can remain present when a native dependency is
    missing or otherwise unloadable.  Treat the import itself as part of the
    readiness contract; device probing is optional because it is only needed
    by the explicit status endpoint.
    """

    devices: dict[str, bool | None] = {"cpu": None, "mps": None, "cuda": None}
    if installed_version != CELLPOSE_PACKAGE_VERSION:
        return devices, None
    try:
        _, torch = _import_runtime()
    except Exception as exc:
        return devices, type(exc).__name__

    if not inspect_devices:
        return devices, None
    try:
        devices = {
            "cpu": True,
            "mps": bool(torch.backends.mps.is_available()),
            "cuda": bool(torch.cuda.is_available()),
        }
    except Exception:
        # A failed optional capability probe must not misrepresent an
        # otherwise importable CPU runtime. Inference still performs its own
        # device selection and fallback checks.
        devices = {"cpu": True, "mps": None, "cuda": None}
    return devices, None


def get_cellpose_status(
    model: object = CELLPOSE_PROFILE_ID,
    *,
    inspect_devices: bool = False,
) -> CellposeBackendStatus:
    spec = resolve_cellpose_model_spec(model)
    installed_version = _installed_cellpose_version()
    path = managed_model_path(spec)
    present = path.exists() or path.is_symlink()
    # A missing checkpoint cannot be ready. The ordinary profile catalog need
    # not load Torch and native decoders just to report that provisioning gap.
    # Explicit device inspection and every present checkpoint still verify the
    # exact runtime before any ready claim.
    devices, runtime_import_error = (
        _runtime_diagnostics(installed_version, inspect_devices=inspect_devices)
        if present or inspect_devices
        else ({"cpu": None, "mps": None, "cuda": None}, None)
    )
    verified = False
    model_error_code: str | None = None
    model_error_summary: str | None = None

    if present:
        try:
            identity = _file_identity(path)
            if identity[1] != spec.size_bytes:
                model_error_code = "model-size-mismatch"
                model_error_summary = (
                    f"The managed {spec.artifact_id} checkpoint has an unexpected size and will "
                    "not be loaded."
                )
            else:
                verified = _verified_digest(path) == spec.sha256
                if not verified:
                    model_error_code = "model-hash-mismatch"
                    model_error_summary = (
                        f"The managed {spec.artifact_id} checkpoint failed SHA-256 verification "
                        "and will not be loaded."
                    )
        except (OSError, RuntimeError, ValueError) as exc:
            model_error_code = "model-invalid"
            model_error_summary = f"The managed {spec.artifact_id} checkpoint is invalid: {exc}"

    if installed_version is None:
        code = "package-missing"
        summary = (
            f"Cellpose {CELLPOSE_PACKAGE_VERSION} is not installed in this Loci engine runtime."
        )
    elif installed_version != CELLPOSE_PACKAGE_VERSION:
        code = "package-version-mismatch"
        summary = (
            f"Cellpose {installed_version} is installed, but Loci requires exactly "
            f"{CELLPOSE_PACKAGE_VERSION}."
        )
    elif runtime_import_error is not None:
        code = "runtime-import-failed"
        summary = (
            f"Cellpose {CELLPOSE_PACKAGE_VERSION} is installed, but its local runtime could "
            f"not be imported ({runtime_import_error}). Reinstall the Loci engine runtime."
        )
    elif not present:
        code = "model-missing"
        summary = (
            f"The {spec.artifact_id} checkpoint is not installed. Import the official checkpoint "
            "before using this Cellpose profile; Loci will not download it silently."
        )
    elif model_error_code is not None:
        code = model_error_code
        summary = model_error_summary or (f"The managed {spec.artifact_id} checkpoint is invalid.")
    elif not verified:
        code = "model-unverified"
        summary = f"The managed {spec.artifact_id} checkpoint has not passed verification."
    else:
        code = "ready"
        summary = (
            f"The {spec.artifact_id} checkpoint is installed, verified, and ready for local "
            "processing."
        )

    return CellposeBackendStatus(
        model_spec=spec,
        ready=code == "ready",
        code=code,
        summary=summary,
        installed_version=installed_version,
        model_path=path,
        model_present=present,
        model_verified=verified,
        devices=devices,
    )


def import_cellpose_model(
    source_path: object,
    model: object = CELLPOSE_PROFILE_ID,
) -> CellposeBackendStatus:
    """Atomically import a user-selected official checkpoint after verification."""

    spec = resolve_cellpose_model_spec(model)
    if not isinstance(source_path, str) or not source_path:
        raise TypeError("path must be a non-empty string")
    source = Path(source_path).expanduser()
    if not source.is_absolute():
        raise ValueError("path must be absolute")
    if source.is_symlink():
        raise ValueError("The Cellpose checkpoint import source must not be a symbolic link.")
    try:
        source_stat = source.stat()
    except OSError as exc:
        raise ValueError("The Cellpose checkpoint import source is not readable.") from exc
    if not stat.S_ISREG(source_stat.st_mode):
        raise ValueError("The Cellpose checkpoint import source must be a regular file.")
    if source_stat.st_size != spec.size_bytes:
        raise ValueError(
            f"The selected file is {source_stat.st_size} bytes; official {spec.artifact_id} must "
            f"be {spec.size_bytes} bytes."
        )

    destination = managed_model_path(spec)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with suppress(OSError):
        destination.parent.chmod(0o700)

    temporary_path: Path | None = None
    try:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        source_descriptor = os.open(source, flags)
        try:
            with (
                os.fdopen(source_descriptor, "rb", closefd=False) as source_stream,
                tempfile.NamedTemporaryFile(
                    mode="w+b",
                    prefix=f".{spec.artifact_id}-import-",
                    dir=destination.parent,
                    delete=False,
                ) as temporary,
            ):
                temporary_path = Path(temporary.name)
                digest, size = _hash_stream(source_stream, temporary)
                temporary.flush()
                os.fsync(temporary.fileno())
        finally:
            os.close(source_descriptor)

        if source.stat().st_size != source_stat.st_size:
            raise RuntimeError("The selected checkpoint changed while Loci was importing it.")
        if size != spec.size_bytes or digest != spec.sha256:
            raise ValueError(
                f"The selected file is not the verified official {spec.artifact_id} checkpoint "
                "for this profile; no model was installed."
            )
        temporary_path.chmod(0o600)
        os.replace(temporary_path, destination)
        temporary_path = None
        try:
            directory_descriptor = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            pass
        with _HASH_CACHE_LOCK:
            _HASH_CACHE.clear()
        clear_model_cache()
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    status = get_cellpose_status(spec, inspect_devices=True)
    if not status.model_verified:
        raise RuntimeError("The imported Cellpose checkpoint could not be verified after publish.")
    return status


def clear_model_cache() -> None:
    global _MODEL_CACHE
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE = None


def _prepare_image(image: np.ndarray, max_edge_px: int) -> tuple[np.ndarray, float]:
    import numpy as np
    from skimage import transform

    array = np.asarray(image)
    if array.ndim == 2:
        prepared = np.repeat(array[..., np.newaxis], 3, axis=2)
    elif array.ndim == 3:
        if array.shape[2] >= 3:
            prepared = array[..., :3]
        elif array.shape[2] == 1:
            prepared = np.repeat(array, 3, axis=2)
        else:
            prepared = np.repeat(array[..., :1], 3, axis=2)
    else:
        raise ValueError("Cellpose 2D segmentation requires one 2D grayscale or color image.")

    height, width = prepared.shape[:2]
    scale = min(1.0, max_edge_px / max(height, width))
    if scale < 1:
        target_height = max(1, int(round(height * scale)))
        target_width = max(1, int(round(width * scale)))
        prepared = transform.resize(
            prepared,
            (target_height, target_width, 3),
            order=1,
            mode="reflect",
            anti_aliasing=True,
            preserve_range=True,
        )
    return np.asarray(prepared, dtype=np.float32), scale


def _prepare_huggingface_space_image(
    image: np.ndarray,
    max_edge_px: int,
) -> tuple[np.ndarray, float]:
    """Reproduce the official Cellpose Space's public ``image_resize`` path.

    The Space uses OpenCV's default linear interpolation, truncates the
    aspect-ratio-derived edge to an integer, and casts the result to uint8.
    Loci selects this path for uint8 inputs in both Cellpose profiles. Higher-
    bit-depth inputs retain Loci's anti-aliased, dynamic-range-preserving path.
    """
    import numpy as np

    array = np.asarray(image)
    if array.ndim not in {2, 3}:
        raise ValueError("Cellpose 2D segmentation requires one 2D grayscale or color image.")

    height, width = array.shape[:2]
    prepared = array
    if int(np.asarray(array.shape).max()) > max_edge_px:
        if height > width:
            target_width = max(1, int(width / height * max_edge_px))
            target_height = max_edge_px
        else:
            target_height = max(1, int(height / width * max_edge_px))
            target_width = max_edge_px
        # OpenCV is an exact dependency of the pinned Cellpose runtime, but it
        # remains a lazy import so the classical engine can run without the
        # optional Cellpose extra installed.
        import cv2

        prepared = cv2.resize(array, (target_width, target_height))
    prepared = np.asarray(prepared).astype(np.uint8)
    # The Space's public resize/cast path is applied unchanged above. Cellpose
    # 4.2.1.1, however, leaves a 2D image as a single channel internally while
    # the pinned SAM backbone requires three input channels. Preserve Loci's
    # existing grayscale contract by replicating only after the exact Space
    # pixel transform; RGB inputs (including the parity fixture) are untouched.
    if prepared.ndim == 2:
        prepared = np.repeat(prepared[..., np.newaxis], 3, axis=2)
    elif prepared.shape[2] == 1:
        prepared = np.repeat(prepared, 3, axis=2)
    scale = min(1.0, max_edge_px / max(height, width))
    return prepared, scale


def _prepare_for_model(
    image: np.ndarray,
    max_edge_px: int,
) -> tuple[np.ndarray, float, CellposePreprocessingMode]:
    import numpy as np

    # The official Space's OpenCV path is the empirically important parity
    # behavior for routine uint8 JPG/PNG lab images. Preserve scientific
    # dynamic range for uint16/float TIFF inputs instead of reproducing the
    # Space's destructive uint8 cast there.
    if np.asarray(image).dtype == np.uint8:
        prepared, scale = _prepare_huggingface_space_image(image, max_edge_px)
        return prepared, scale, "huggingface-space-uint8"
    prepared, scale = _prepare_image(image, max_edge_px)
    return prepared, scale, "dynamic-range-preserving"


def _model_for_device(
    cellpose_models: ModuleType,
    torch: ModuleType,
    spec: CellposeModelSpec,
    path: Path,
    device_name: str,
) -> object:
    global _MODEL_CACHE
    identity = (*_file_identity(path), device_name)
    with _MODEL_CACHE_LOCK:
        if _MODEL_CACHE is not None and _MODEL_CACHE[0] == identity:
            return _MODEL_CACHE[1]
        # Cellpose falls back to its default checkpoint download when a supplied
        # path disappears between its own existence check and model creation.
        # Temporarily replace that fallback inside this single-worker critical
        # section so even that narrow same-user race fails closed and offline.
        cache_model_path = getattr(cellpose_models, "cache_model_path", None)
        if not callable(cache_model_path):
            raise RuntimeError("The Cellpose runtime does not expose its checkpoint loader.")

        def reject_checkpoint_download(*_args: object, **_kwargs: object) -> str:
            raise RuntimeError(
                "Cellpose checkpoint downloads are disabled in Loci; import the verified "
                f"{spec.artifact_id} artifact again."
            )

        cellpose_models.cache_model_path = reject_checkpoint_download
        try:
            # Recheck immediately before construction and confirm that the same
            # regular file remains after Cellpose has loaded it.
            if (*_file_identity(path), device_name) != identity:
                raise RuntimeError("The managed Cellpose checkpoint changed before loading.")
            model = cellpose_models.CellposeModel(
                pretrained_model=os.fspath(path),
                device=torch.device(device_name),
                use_bfloat16=True,
            )
            if (*_file_identity(path), device_name) != identity:
                raise RuntimeError("The managed Cellpose checkpoint changed while loading.")
        finally:
            cellpose_models.cache_model_path = cache_model_path
        _MODEL_CACHE = (identity, model)
        return model


def _evaluate(
    model: object,
    prepared: np.ndarray,
    settings: CellposeSettings,
    scale: float,
) -> np.ndarray:
    import numpy as np

    normalize = {
        "normalize": settings.normalize,
        "percentile": [settings.percentile_low, settings.percentile_high],
        "tile_norm_blocksize": settings.tile_norm_blocksize,
        "sharpen_radius": settings.sharpen_radius,
        "smooth_radius": settings.smooth_radius,
        "invert": settings.invert,
    }
    diameter = settings.diameter_px * scale if settings.diameter_px > 0 else None
    masks, _, _ = model.eval(
        prepared,
        batch_size=settings.batch_size,
        resample=settings.resample,
        channel_axis=-1 if prepared.ndim == 3 else None,
        z_axis=None,
        normalize=normalize,
        diameter=diameter,
        flow_threshold=settings.flow_threshold,
        cellprob_threshold=settings.cellprob_threshold,
        do_3D=False,
        min_size=settings.min_size_px,
        max_size_fraction=settings.max_size_fraction,
        niter=settings.niter,
        augment=settings.augment,
        tile_overlap=settings.tile_overlap,
        bsize=256,
        compute_masks=True,
    )
    labels = np.asarray(masks)
    if labels.ndim != 2 or labels.shape != prepared.shape[:2]:
        raise RuntimeError("Cellpose returned labels on an unexpected image grid.")
    if not np.all(np.isfinite(labels)) or np.any(labels < 0):
        raise RuntimeError("Cellpose returned invalid instance labels.")
    return labels.astype(np.int32, copy=False)


def _restore_labels_to_source_grid(
    labels: np.ndarray,
    source_shape: tuple[int, int],
    preprocessing_mode: CellposePreprocessingMode,
) -> np.ndarray:
    import numpy as np
    from skimage import transform

    if labels.shape == source_shape:
        return labels
    if preprocessing_mode == "huggingface-space-uint8":
        import cv2

        # OpenCV applies the same nearest-neighbour grid mapping for int32 as it
        # does for the Space's published uint16 masks. Keep labels as int32 so
        # a valid analysis with more than 65,535 instances cannot silently wrap
        # label 65,536 to background during source-grid restoration.
        return cv2.resize(
            labels.astype(np.int32, copy=False),
            (source_shape[1], source_shape[0]),
            interpolation=cv2.INTER_NEAREST,
        ).astype(np.int32, copy=False)
    return transform.resize(
        labels,
        source_shape,
        order=0,
        mode="edge",
        anti_aliasing=False,
        preserve_range=True,
    ).astype(np.int32)


def segment_cellpose(
    image: np.ndarray,
    settings: CellposeSettings,
    model: object = CELLPOSE_PROFILE_ID,
) -> CellposeInference:
    import numpy as np

    from .segment import (
        SegmentationOutput,
        _to_gray_float,
        rebuild_output_from_labels,
        validate_analysis_budget,
    )

    settings.validate()
    validate_analysis_budget(
        image,
        "cellpose",
        cellpose_max_edge_px=settings.max_edge_px,
    )
    spec = resolve_cellpose_model_spec(model)
    status = get_cellpose_status(spec)
    if not status.ready:
        raise RuntimeError(status.summary)

    prepared, scale, preprocessing_mode = _prepare_for_model(image, settings.max_edge_px)
    cellpose_models, torch = _import_runtime()
    from .compute_resources import select_device

    # Conservative provisioning estimate: checkpoint plus one loading copy,
    # batch tile workspace and dense prepared-plane intermediates. This does
    # not alter pixels, batch size or settings to force an accelerator fit.
    required_bytes = (
        2 * spec.size_bytes
        + settings.batch_size * 32 * 1024**2
        + int(np.prod(prepared.shape[:2])) * 64
        + 256 * 1024**2
    )
    resolved_device, fallback_reason, memory_preflight = select_device(
        torch,
        settings.device,
        required_bytes,
    )
    memory_preflight["estimate_policy"] = (
        "cellpose-checkpoint-x2-plus-batch-32MiB-plane-64B-reserve-256MiB/v1"
    )

    def run(device_name: str) -> np.ndarray:
        runtime_model = _model_for_device(
            cellpose_models,
            torch,
            spec,
            status.model_path,
            device_name,
        )
        return _evaluate(runtime_model, prepared, settings, scale)

    try:
        labels = run(resolved_device)
    except Exception as accelerator_error:
        if resolved_device == "cpu":
            raise
        clear_model_cache()
        try:
            labels = run("cpu")
        except Exception as cpu_error:
            raise RuntimeError(
                f"Cellpose failed on {resolved_device} and CPU fallback also failed: {cpu_error}"
            ) from accelerator_error
        fallback_reason = (
            f"{resolved_device.upper()} inference failed with "
            f"{type(accelerator_error).__name__}; Loci retried on CPU."
        )
        resolved_device = "cpu"

    source_shape = np.asarray(image).shape[:2]
    labels = _restore_labels_to_source_grid(labels, source_shape, preprocessing_mode)
    normalized = _to_gray_float(image)
    prototype = SegmentationOutput(
        labels=np.zeros(source_shape, dtype=np.int32),
        normalized=normalized,
        count=0,
        confluence_percent=0.0,
        measurements=[],
        resolved_polarity="cellpose-model",
        threshold=float(settings.cellprob_threshold),
    )
    output = rebuild_output_from_labels(prototype, labels)
    runtime: dict[str, object] = {
        "package": {"name": "cellpose", "version": CELLPOSE_PACKAGE_VERSION},
        "model": {"artifact_id": spec.artifact_id, "sha256": spec.sha256},
        "profile_id": spec.profile_id,
        "preprocessing_mode": preprocessing_mode,
        "requested_device": settings.device,
        "resolved_device": resolved_device,
        "fallback_reason": fallback_reason,
        "memory_preflight": memory_preflight,
        "inference_scale": round(scale, 8),
    }
    return CellposeInference(output=output, runtime=runtime)
