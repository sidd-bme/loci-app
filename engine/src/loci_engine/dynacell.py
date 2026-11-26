"""CPU inference for the fixed WTC-11 iPSC Phase3D → Nuclei UNeXt2 checkpoint."""

from __future__ import annotations

import hashlib
import io
import math
import os
import stat
import threading
from collections.abc import Callable
from numbers import Real
from pathlib import Path

import numpy as np

CHECKPOINT_SHA256 = "58b222f92978b50647d547e5fd69edaafa2d2c5854fbc7f7324e9bcf8835051d"
CHECKPOINT_BYTES = 386_093_992
WINDOW_DEPTH = 15
MAX_DEPTH = 40
FIELD_YX = (512, 512)
_RUN_LOCK = threading.Lock()


def _read_checkpoint(path: Path) -> bytes:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size != CHECKPOINT_BYTES:
        raise ValueError("Expected the regular, fixed-size DynaCell checkpoint file")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not os.path.samestat(before, opened) or not stat.S_ISREG(opened.st_mode):
            raise ValueError("DynaCell checkpoint file changed during open")
        # Hash and deserialize the same immutable bytes even if another process edits the file.
        data = stream.read(CHECKPOINT_BYTES + 1)
    if len(data) != CHECKPOINT_BYTES or hashlib.sha256(data).hexdigest() != CHECKPOINT_SHA256:
        raise ValueError("DynaCell checkpoint failed SHA-256 or size verification")
    return data


def _load_network(path: Path):
    import torch

    from .dynacell_architecture import NuclearUNeXt2

    with io.BytesIO(_read_checkpoint(path)) as verified:
        state = torch.load(verified, weights_only=True, map_location="cpu")["state_dict"]
    if any(not key.startswith("model.") for key in state):
        raise ValueError("Unexpected keys in DynaCell checkpoint")
    with torch.device("meta"):
        model = NuclearUNeXt2()
    model.load_state_dict(
        {key.removeprefix("model."): value for key, value in state.items()},
        strict=True,
        assign=True,
    )
    return model.eval()


def _blend_window(result: np.ndarray, window: np.ndarray, start: int) -> None:
    # Publisher's running depth blend. It rounds back to float32 at every write.
    for z, plane in enumerate(window):
        count = min(start + 1, WINDOW_DEPTH - z)
        index = start + z
        if count == 1:
            result[index] = plane
        else:
            old = result[index].astype(np.float64)
            result[index] = old * (count - 1) / count + plane.astype(np.float64) / count


def _valid_stat(value: float) -> bool:
    return (
        isinstance(value, Real)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and abs(value) <= float(np.finfo(np.float32).max)
    )


def predict_virtual_nuclei(
    phase_zyx: np.ndarray,
    checkpoint: Path,
    *,
    mean: float,
    std: float,
    progress: Callable[[int, int], None] | None = None,
) -> np.ndarray:
    """Predict dimensionless, target-IQR-normalized nuclear signal on the native ZYX grid.

    Supply raw float32 Phase3D, shape (15..40, 512, 512), and the source full
    field's mean and population SD. Every adjacent 15-plane window uses the
    same (phase - mean) / (std + 1e-8). Preserve the source origin and spacing
    on the output. There is no resampling, tiling in XY or intensity fitting.

    Call from the inference worker. Runs one window at a time on CPU with at
    most two intra-op threads. progress(completed_windows, total_windows) can
    raise to cancel. No partial result is returned.
    """
    if not isinstance(phase_zyx, np.ndarray) or phase_zyx.dtype != np.float32:
        raise ValueError("Phase3D input must be a native float32 ZYX array")
    if (
        phase_zyx.ndim != 3
        or phase_zyx.shape[1:] != FIELD_YX
        or not WINDOW_DEPTH <= phase_zyx.shape[0] <= MAX_DEPTH
    ):
        raise ValueError("Phase3D shape must be (15..40, 512, 512) in ZYX order")
    if not _valid_stat(mean) or not _valid_stat(std) or std <= 0:
        raise ValueError("Full-field mean and positive SD must be finite float32-range values")

    import torch

    # set_num_threads is process-wide. Serialize kernel invocations in this worker.
    with _RUN_LOCK, torch.inference_mode():
        previous_threads = torch.get_num_threads()
        try:
            torch.set_num_threads(min(previous_threads, 2))
            # Snapshot the bounded input, including read-only and negative-stride arrays.
            phase = torch.from_numpy(phase_zyx.copy(order="C"))
            # The publisher adds epsilon after casting the field statistics to float32.
            divisor = np.float32(std) + np.float32(1e-8)
            phase.sub_(float(np.float32(mean))).div_(float(divisor))
            if not torch.isfinite(phase).all():
                raise ValueError("Normalized Phase3D field contains non-finite values")
            model = _load_network(checkpoint)
            result = np.empty(phase_zyx.shape, dtype=np.float32)
            windows = len(result) - WINDOW_DEPTH + 1
            for start in range(windows):
                window = phase[None, None, start : start + WINDOW_DEPTH]
                pred = model(window)
                if pred.shape != window.shape or pred.dtype != torch.float32:
                    raise ValueError("Unexpected DynaCell output shape or dtype")
                if not torch.isfinite(pred).all():
                    raise ValueError("DynaCell prediction contains non-finite values")
                _blend_window(result, pred[0, 0].numpy(), start)
                if progress is not None:
                    progress(start + 1, windows)
            return result
        finally:
            torch.set_num_threads(previous_threads)
