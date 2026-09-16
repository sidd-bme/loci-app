"""Convert native-model logits into integer instance labels."""

from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi
from skimage.segmentation import clear_border, watershed

from .contracts import PostprocessConfig


def _sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, -40.0, 40.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _sequential_relabel(labels: np.ndarray, min_area_px: int) -> np.ndarray:
    result = np.zeros(labels.shape, dtype=np.int32)
    next_label = 1
    for label_id in np.unique(labels):
        if label_id <= 0:
            continue
        region = labels == label_id
        if int(region.sum()) < min_area_px:
            continue
        result[region] = next_label
        next_label += 1
    return result


def _vote_markers(
    foreground: np.ndarray,
    offset_x: np.ndarray,
    offset_y: np.ndarray,
    config: PostprocessConfig,
) -> tuple[np.ndarray, np.ndarray]:
    height, width = foreground.shape
    ys, xs = np.nonzero(foreground)
    votes = np.zeros((height, width), dtype=np.float32)
    if not len(xs):
        return np.zeros_like(foreground, dtype=np.int32), votes
    center_x = np.rint(xs + offset_x[ys, xs] * config.offset_scale_px).astype(np.int64)
    center_y = np.rint(ys + offset_y[ys, xs] * config.offset_scale_px).astype(np.int64)
    center_x = np.clip(center_x, 0, width - 1)
    center_y = np.clip(center_y, 0, height - 1)
    np.add.at(votes, (center_y, center_x), 1.0)
    if config.vote_smoothing_px:
        vote_response = ndi.gaussian_filter(votes, config.vote_smoothing_px)
    else:
        vote_response = votes
    window = config.seed_min_distance_px * 2 + 1
    local_maximum = vote_response == ndi.maximum_filter(vote_response, size=window, mode="nearest")
    if config.vote_smoothing_px:
        minimum_response = config.minimum_seed_votes / (2.0 * np.pi * config.vote_smoothing_px**2)
    else:
        minimum_response = float(config.minimum_seed_votes)
    candidates = local_maximum & (vote_response >= minimum_response) & foreground
    candidate_components, candidate_count = ndi.label(candidates)
    markers = np.zeros(foreground.shape, dtype=np.int32)
    marker_id = 0
    for component_id in range(1, candidate_count + 1):
        points = np.argwhere(candidate_components == component_id)
        if not len(points):
            continue
        scores = vote_response[points[:, 0], points[:, 1]]
        y, x = points[int(np.argmax(scores))]
        marker_id += 1
        markers[y, x] = marker_id
    return markers, vote_response


def logits_to_instances(
    logits: np.ndarray,
    config: PostprocessConfig | None = None,
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    config = config or PostprocessConfig()
    config.validate()
    array = np.asarray(logits, dtype=np.float32)
    if array.ndim == 4:
        if array.shape[0] != 1:
            raise ValueError("post-processing accepts one image at a time")
        array = array[0]
    if array.ndim != 3 or array.shape[0] != 4:
        raise ValueError("logits must have shape [4,height,width] or [1,4,height,width]")
    foreground_probability = _sigmoid(array[0])
    boundary_probability = _sigmoid(array[1])
    offset_x = np.tanh(array[2])
    offset_y = np.tanh(array[3])
    foreground = foreground_probability >= config.foreground_threshold
    foreground = ndi.binary_fill_holes(foreground)
    markers, votes = _vote_markers(foreground, offset_x, offset_y, config)
    if markers.max() == 0:
        cores = foreground & (boundary_probability < config.boundary_threshold)
        markers, _ = ndi.label(cores)
    if markers.max() == 0:
        markers, _ = ndi.label(foreground)
    elevation = boundary_probability + 0.35 * (1.0 - foreground_probability)
    labels = watershed(elevation, markers=markers, mask=foreground)
    if config.exclude_border:
        labels = clear_border(labels)
    labels = _sequential_relabel(labels, config.min_area_px)
    diagnostics = {
        "foreground_probability": foreground_probability.astype(np.float32, copy=False),
        "boundary_probability": boundary_probability.astype(np.float32, copy=False),
        "offset_x": offset_x.astype(np.float32, copy=False),
        "offset_y": offset_y.astype(np.float32, copy=False),
        "center_votes": votes,
    }
    return labels, diagnostics
