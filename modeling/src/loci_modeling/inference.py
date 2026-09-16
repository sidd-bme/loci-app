"""Deterministic tiled inference for full-resolution developer evaluation."""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import torch
from torch import nn


def _positions(length: int, tile_size: int, stride: int) -> list[int]:
    if length <= tile_size:
        return [0]
    positions = list(range(0, length - tile_size + 1, stride))
    last = length - tile_size
    if positions[-1] != last:
        positions.append(last)
    return positions


def _chunks(values: list[tuple[int, int]], size: int) -> Iterator[list[tuple[int, int]]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def _blend_window(tile_size: int) -> np.ndarray:
    axis = np.hanning(tile_size).astype(np.float32)
    axis = np.maximum(axis, 0.05)
    return np.outer(axis, axis).astype(np.float32)


@torch.inference_mode()
def predict_logits_tiled(
    model: nn.Module,
    normalized_image: np.ndarray,
    *,
    device: torch.device,
    tile_size: int = 256,
    overlap: int = 64,
    batch_size: int = 4,
) -> np.ndarray:
    image = np.asarray(normalized_image, dtype=np.float32)
    if image.ndim != 2:
        raise ValueError("normalized_image must be a 2D array")
    if not np.isfinite(image).all():
        raise ValueError("normalized_image must contain only finite values")
    if tile_size < 16 or not 0 <= overlap < tile_size or batch_size < 1:
        raise ValueError("invalid tiling configuration")
    original_height, original_width = image.shape
    padding = ((0, max(0, tile_size - original_height)), (0, max(0, tile_size - original_width)))
    if any(after for _, after in padding):
        mode = "reflect" if min(image.shape) > 1 else "edge"
        image = np.pad(image, padding, mode=mode)
    height, width = image.shape
    stride = tile_size - overlap
    coordinates = [
        (top, left)
        for top in _positions(height, tile_size, stride)
        for left in _positions(width, tile_size, stride)
    ]
    blend = _blend_window(tile_size)
    accumulated = np.zeros((4, height, width), dtype=np.float32)
    weights = np.zeros((height, width), dtype=np.float32)
    model_was_training = model.training
    model.eval()
    try:
        for coordinate_batch in _chunks(coordinates, batch_size):
            patches = np.stack(
                [
                    image[top : top + tile_size, left : left + tile_size]
                    for top, left in coordinate_batch
                ],
                axis=0,
            )[:, None]
            tensor = torch.from_numpy(patches).to(device=device, dtype=torch.float32)
            output = model(tensor).detach().to(device="cpu", dtype=torch.float32).numpy()
            if output.shape != (len(coordinate_batch), 4, tile_size, tile_size):
                raise ValueError(f"model returned unexpected tiled output shape {output.shape}")
            for logits, (top, left) in zip(output, coordinate_batch, strict=True):
                accumulated[:, top : top + tile_size, left : left + tile_size] += logits * blend
                weights[top : top + tile_size, left : left + tile_size] += blend
    finally:
        model.train(model_was_training)
    accumulated /= np.maximum(weights[None], 1e-6)
    return accumulated[:, :original_height, :original_width]
