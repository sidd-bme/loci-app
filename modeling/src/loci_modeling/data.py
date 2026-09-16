"""Read-only manifest resolution and deterministic cell-aware patch generation."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
import tifffile
import torch
from PIL import Image
from skimage.segmentation import find_boundaries
from skimage.transform import resize
from torch.utils.data import Dataset

from .contracts import DatasetManifest, SampleRecord
from .preprocessing import DEFAULT_PREPROCESSING_CONFIG, PreprocessingConfig

SUPPORTED_IMAGE_SUFFIXES = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".npy"}
SUPPORTED_MASK_SUFFIXES = {".tif", ".tiff", ".png", ".npy"}


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _resolve_source(root: Path, relative_path: str, suffixes: set[str]) -> Path:
    candidate = (root / relative_path).resolve(strict=True)
    if not _is_within(candidate, root):
        raise ValueError(f"resolved source escapes its declared root: {relative_path}")
    if not candidate.is_file():
        raise ValueError(f"source is not a regular file: {relative_path}")
    if candidate.suffix.lower() not in suffixes:
        raise ValueError(f"unsupported source suffix: {candidate.suffix}")
    return candidate


@dataclass(frozen=True, slots=True)
class ResolvedSample:
    record: SampleRecord
    raw_path: Path
    mask_path: Path


def resolve_samples(
    manifest: DatasetManifest,
    raw_root: str | Path,
    mask_root: str | Path,
    split: Literal["train", "validation", "test"],
    *,
    verify_integrity: bool = True,
) -> tuple[ResolvedSample, ...]:
    raw_root_path = Path(raw_root).expanduser().resolve(strict=True)
    mask_root_path = Path(mask_root).expanduser().resolve(strict=True)
    if not raw_root_path.is_dir() or not mask_root_path.is_dir():
        raise ValueError("raw_root and mask_root must be existing directories")
    resolved: list[ResolvedSample] = []
    for record in manifest.split(split):
        raw_path = _resolve_source(raw_root_path, record.raw, SUPPORTED_IMAGE_SUFFIXES)
        mask_path = _resolve_source(mask_root_path, record.mask, SUPPORTED_MASK_SUFFIXES)
        if verify_integrity:
            expected_raw_hash = getattr(record, "raw_sha256", None)
            expected_mask_hash = getattr(record, "mask_sha256", None)
            if expected_raw_hash and sha256_file(raw_path) != expected_raw_hash:
                raise ValueError(f"raw SHA-256 mismatch for sample {record.sample_id}")
            if expected_mask_hash and sha256_file(mask_path) != expected_mask_hash:
                raise ValueError(f"mask SHA-256 mismatch for sample {record.sample_id}")
        resolved.append(ResolvedSample(record=record, raw_path=raw_path, mask_path=mask_path))
    return tuple(resolved)


def ensure_output_isolated(
    output_dir: str | Path, raw_root: str | Path, mask_root: str | Path
) -> Path:
    """Reject output locations that could write into either source tree."""

    output = Path(output_dir).expanduser().resolve(strict=False)
    raw = Path(raw_root).expanduser().resolve(strict=True)
    mask = Path(mask_root).expanduser().resolve(strict=True)
    if _is_within(output, raw) or _is_within(output, mask):
        raise ValueError("output_dir must be outside raw_root and mask_root")
    if _is_within(raw, output) or _is_within(mask, output):
        raise ValueError("output_dir must not contain a source root")
    return output


def _read_array(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()
    if suffix == ".npy":
        return np.load(path, allow_pickle=False)
    if suffix in {".tif", ".tiff"}:
        return tifffile.imread(path)
    with Image.open(path) as image:
        return np.asarray(image)


def _first_plane(array: np.ndarray) -> np.ndarray:
    squeezed = np.squeeze(array)
    if squeezed.ndim <= 3:
        return squeezed
    raise ValueError(f"only 2D still images are supported, received shape {array.shape}")


def _to_gray(array: np.ndarray) -> np.ndarray:
    array = _first_plane(np.asarray(array))
    if array.ndim == 2:
        return array
    if array.ndim != 3:
        raise ValueError(f"cannot interpret image shape {array.shape}")
    if array.shape[-1] in {1, 2, 3, 4}:
        channels_last = array
    elif array.shape[0] in {1, 2, 3, 4}:
        channels_last = np.moveaxis(array, 0, -1)
    else:
        raise ValueError(f"cannot identify a channel axis in image shape {array.shape}")
    if channels_last.shape[-1] == 1:
        return channels_last[..., 0]
    rgb = channels_last[..., :3].astype(np.float32, copy=False)
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def normalize_image(array: np.ndarray) -> np.ndarray:
    gray = np.asarray(_to_gray(array), dtype=np.float32)
    finite = np.isfinite(gray)
    if not finite.any():
        raise ValueError("image has no finite intensity values")
    fill = float(np.median(gray[finite]))
    gray = np.where(finite, gray, fill)
    low, high = np.percentile(gray, (1.0, 99.0))
    if high <= low:
        low, high = float(gray.min()), float(gray.max())
    if high <= low:
        raise ValueError("image has no usable intensity contrast")
    return np.clip((gray - low) / (high - low), 0.0, 1.0).astype(np.float32, copy=False)


def validate_mask(array: np.ndarray) -> np.ndarray:
    mask = _first_plane(np.asarray(array))
    if mask.ndim == 3 and 1 in mask.shape:
        mask = np.squeeze(mask)
    if mask.ndim != 2:
        raise ValueError(f"instance mask must be 2D, received shape {mask.shape}")
    if not np.issubdtype(mask.dtype, np.integer) and (
        not np.isfinite(mask).all() or not np.array_equal(mask, np.rint(mask))
    ):
        raise ValueError("instance mask must contain finite integer labels")
    if np.min(mask) < 0:
        raise ValueError("instance mask labels must be non-negative")
    return np.asarray(mask, dtype=np.int32)


def _expected_instance_ids(instance_count: int, dtype: np.dtype) -> np.ndarray:
    return np.arange(1, instance_count + 1, dtype=dtype)


def _validate_instance_identity(
    mask: np.ndarray,
    instance_count: int,
    *,
    context: str,
) -> None:
    positive_ids = np.unique(mask[mask > 0])
    expected_ids = _expected_instance_ids(instance_count, positive_ids.dtype)
    if not np.array_equal(positive_ids, expected_ids):
        raise ValueError(
            f"instance IDs/count changed during {context}: expected 1..{instance_count}"
        )


def _downsample_shape(shape: tuple[int, int], max_edge_px: int) -> tuple[int, int]:
    height, width = shape
    if max(height, width) <= max_edge_px:
        return shape
    scale = max_edge_px / max(height, width)
    return max(1, round(height * scale)), max(1, round(width * scale))


def preprocess_image_and_mask(
    image: np.ndarray,
    mask: np.ndarray,
    *,
    instance_count: int,
    config: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
) -> tuple[np.ndarray, np.ndarray]:
    """Apply the release preprocessing contract entirely in memory."""

    config.validate()
    grayscale = np.asarray(_to_gray(image))
    instances = validate_mask(mask)
    if grayscale.shape != instances.shape:
        raise ValueError("preprocessing requires image and mask on the same spatial grid")
    _validate_instance_identity(instances, instance_count, context="input validation")
    output_shape = _downsample_shape(instances.shape, config.max_edge_px)
    if output_shape != instances.shape:
        grayscale = resize(
            grayscale,
            output_shape,
            order=1,
            mode="reflect",
            preserve_range=True,
            anti_aliasing=True,
        )
        instances = resize(
            instances,
            output_shape,
            order=0,
            mode="edge",
            preserve_range=True,
            anti_aliasing=False,
        ).astype(np.int32, copy=False)
        _validate_instance_identity(instances, instance_count, context="max-edge downsampling")
    normalized = normalize_image(grayscale)
    normalized.setflags(write=False)
    instances.setflags(write=False)
    return normalized, instances


@lru_cache(maxsize=6)
def _load_pair(
    raw_path: Path,
    mask_path: Path,
    transform_type: str,
    raw_width: int,
    raw_height: int,
    mask_width: int,
    mask_height: int,
    instance_count: int,
    preprocessing: PreprocessingConfig,
) -> tuple[np.ndarray, np.ndarray]:
    image = np.asarray(_to_gray(_read_array(raw_path)))
    mask = validate_mask(_read_array(mask_path))
    if image.shape != (raw_height, raw_width):
        raise ValueError(
            f"raw dimensions changed for {raw_path.name}: "
            f"{image.shape} vs {(raw_height, raw_width)}"
        )
    if mask.shape != (mask_height, mask_width):
        raise ValueError(
            f"mask dimensions changed for {mask_path.name}: "
            f"{mask.shape} vs {(mask_height, mask_width)}"
        )
    _validate_instance_identity(mask, instance_count, context=f"loading {mask_path.name}")
    if transform_type == "identity":
        if image.shape != mask.shape:
            raise ValueError(
                f"identity raw/mask shape mismatch for {raw_path.name}: "
                f"{image.shape} vs {mask.shape}"
            )
    elif transform_type == "aspect_preserving_resize":
        # The manifest reference mask remains untouched. Only the decoded input is
        # interpolated onto the label grid declared by the reviewed manifest.
        image = resize(
            image,
            mask.shape,
            order=1,
            mode="reflect",
            preserve_range=True,
            anti_aliasing=True,
        )
    else:
        raise ValueError(f"unsupported transform_type: {transform_type}")
    return preprocess_image_and_mask(
        image,
        mask,
        instance_count=instance_count,
        config=preprocessing,
    )


def load_pair(
    sample: ResolvedSample,
    preprocessing: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
) -> tuple[np.ndarray, np.ndarray]:
    record = sample.record
    return _load_pair(
        sample.raw_path,
        sample.mask_path,
        record.transform_type,
        record.raw_width,
        record.raw_height,
        record.mask_width,
        record.mask_height,
        record.instance_count,
        preprocessing,
    )


def _crop_with_padding(
    image: np.ndarray,
    mask: np.ndarray,
    center_y: int,
    center_x: int,
    size: int,
) -> tuple[np.ndarray, np.ndarray]:
    top = int(center_y - size // 2)
    left = int(center_x - size // 2)
    bottom = top + size
    right = left + size
    source_top = max(0, top)
    source_left = max(0, left)
    source_bottom = min(image.shape[0], bottom)
    source_right = min(image.shape[1], right)
    image_crop = image[source_top:source_bottom, source_left:source_right]
    mask_crop = mask[source_top:source_bottom, source_left:source_right]
    padding = (
        (max(0, -top), max(0, bottom - image.shape[0])),
        (max(0, -left), max(0, right - image.shape[1])),
    )
    if any(before or after for before, after in padding):
        mode = "reflect" if min(image_crop.shape) > 1 else "edge"
        image_crop = np.pad(image_crop, padding, mode=mode)
        mask_crop = np.pad(mask_crop, padding, mode="constant")
    return image_crop.copy(), mask_crop.copy()


def _crop_targets_with_padding(
    targets: np.ndarray,
    center_y: int,
    center_x: int,
    size: int,
) -> np.ndarray:
    if targets.ndim != 3 or targets.shape[0] != 4:
        raise ValueError("targets must have shape [4,height,width]")
    top = int(center_y - size // 2)
    left = int(center_x - size // 2)
    bottom = top + size
    right = left + size
    height, width = targets.shape[1:]
    source_top = max(0, top)
    source_left = max(0, left)
    source_bottom = min(height, bottom)
    source_right = min(width, right)
    cropped = targets[:, source_top:source_bottom, source_left:source_right]
    padding = (
        (0, 0),
        (max(0, -top), max(0, bottom - height)),
        (max(0, -left), max(0, right - width)),
    )
    if any(before or after for before, after in padding[1:]):
        cropped = np.pad(cropped, padding, mode="constant")
    return cropped.copy()


def _apply_spatial_transform(
    image: np.ndarray,
    mask: np.ndarray,
    targets: np.ndarray,
    *,
    rotations: int,
    flip_y: bool,
    flip_x: bool,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rotations %= 4
    image = np.rot90(image, rotations)
    mask = np.rot90(mask, rotations)
    targets = np.rot90(targets, rotations, axes=(1, 2)).copy()
    offset_x = targets[2].copy()
    offset_y = targets[3].copy()
    if rotations == 1:
        targets[2], targets[3] = offset_y, -offset_x
    elif rotations == 2:
        targets[2], targets[3] = -offset_x, -offset_y
    elif rotations == 3:
        targets[2], targets[3] = -offset_y, offset_x
    if flip_y:
        image = np.flip(image, axis=0)
        mask = np.flip(mask, axis=0)
        targets = np.flip(targets, axis=1).copy()
        targets[3] *= -1.0
    if flip_x:
        image = np.flip(image, axis=1)
        mask = np.flip(mask, axis=1)
        targets = np.flip(targets, axis=2).copy()
        targets[2] *= -1.0
    return (
        np.ascontiguousarray(image),
        np.ascontiguousarray(mask),
        np.ascontiguousarray(targets),
    )


def _spatial_augment(
    image: np.ndarray,
    mask: np.ndarray,
    targets: np.ndarray,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return _apply_spatial_transform(
        image,
        mask,
        targets,
        rotations=int(rng.integers(0, 4)),
        flip_y=bool(rng.random() < 0.5),
        flip_x=bool(rng.random() < 0.5),
    )


def _intensity_augment(image: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    gamma = float(rng.uniform(0.8, 1.25))
    scale = float(rng.uniform(0.88, 1.12))
    offset = float(rng.uniform(-0.06, 0.06))
    noise_std = float(rng.uniform(0.0, 0.025))
    result = np.power(np.clip(image, 0.0, 1.0), gamma) * scale + offset
    if noise_std:
        result = result + rng.normal(0.0, noise_std, size=result.shape)
    return np.clip(result, 0.0, 1.0).astype(np.float32, copy=False)


def make_targets(mask: np.ndarray, offset_scale_px: float) -> np.ndarray:
    if offset_scale_px <= 0:
        raise ValueError("offset_scale_px must be positive")
    mask = validate_mask(mask)
    foreground = mask > 0
    boundary = find_boundaries(mask, connectivity=2, mode="thick").astype(np.float32)
    offset_x = np.zeros(mask.shape, dtype=np.float32)
    offset_y = np.zeros(mask.shape, dtype=np.float32)
    ys, xs = np.nonzero(foreground)
    if len(xs):
        label_ids = mask[ys, xs]
        max_label = int(label_ids.max())
        counts = np.bincount(label_ids, minlength=max_label + 1)
        center_x = np.divide(
            np.bincount(label_ids, weights=xs, minlength=max_label + 1),
            counts,
            out=np.zeros(max_label + 1, dtype=np.float64),
            where=counts > 0,
        )
        center_y = np.divide(
            np.bincount(label_ids, weights=ys, minlength=max_label + 1),
            counts,
            out=np.zeros(max_label + 1, dtype=np.float64),
            where=counts > 0,
        )
        offset_x[ys, xs] = np.clip((center_x[label_ids] - xs) / offset_scale_px, -1.0, 1.0)
        offset_y[ys, xs] = np.clip((center_y[label_ids] - ys) / offset_scale_px, -1.0, 1.0)
    return np.stack(
        [foreground.astype(np.float32), boundary, offset_x, offset_y],
        axis=0,
    )


@lru_cache(maxsize=6)
def load_pair_and_targets(
    sample: ResolvedSample,
    offset_scale_px: float,
    preprocessing: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    image, mask = load_pair(sample, preprocessing)
    targets = make_targets(mask, offset_scale_px)
    targets.setflags(write=False)
    return image, mask, targets


class CellAwarePatchDataset(Dataset[tuple[torch.Tensor, torch.Tensor]]):
    """Index-deterministic patches; no global RNG or source writes."""

    def __init__(
        self,
        samples: Sequence[ResolvedSample],
        *,
        patch_size: int,
        length: int,
        seed: int,
        offset_scale_px: float,
        cell_patch_probability: float = 0.8,
        patches_per_source_block: int = 8,
        augment: bool = True,
        sampling_strategy: Literal["weighted_random", "complete_coverage"] = "weighted_random",
        preprocessing: PreprocessingConfig = DEFAULT_PREPROCESSING_CONFIG,
    ) -> None:
        if not samples:
            raise ValueError("at least one resolved sample is required")
        if patch_size < 16 or length < 1 or offset_scale_px <= 0:
            raise ValueError("invalid patch dataset dimensions")
        if not 0 <= cell_patch_probability <= 1:
            raise ValueError("cell_patch_probability must be in [0, 1]")
        if patches_per_source_block < 1:
            raise ValueError("patches_per_source_block must be positive")
        if sampling_strategy not in {"weighted_random", "complete_coverage"}:
            raise ValueError("unsupported sampling_strategy")
        if sampling_strategy == "complete_coverage" and length < len(samples):
            raise ValueError("complete_coverage length must cover every source")
        preprocessing.validate()
        self.samples = tuple(samples)
        self.patch_size = patch_size
        self.length = length
        self.seed = seed
        self.offset_scale_px = offset_scale_px
        self.cell_patch_probability = cell_patch_probability
        self.patches_per_source_block = patches_per_source_block
        self.augment = augment
        self.sampling_strategy = sampling_strategy
        self.preprocessing = preprocessing
        weights = np.asarray([sample.record.weight for sample in self.samples], dtype=np.float64)
        if not np.isfinite(weights).all() or np.any(weights <= 0):
            raise ValueError("sample weights must be finite and positive")
        self.sample_probabilities = weights / weights.sum()
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        if epoch < 0:
            raise ValueError("epoch must be non-negative")
        self.epoch = epoch

    def __len__(self) -> int:
        return self.length

    def _rng(self, index: int) -> np.random.Generator:
        sequence = np.random.SeedSequence([self.seed, self.epoch, index])
        return np.random.default_rng(sequence)

    def _sample_index(self, index: int) -> int:
        if self.sampling_strategy == "complete_coverage":
            order_rng = np.random.default_rng(
                np.random.SeedSequence([self.seed, self.epoch, 0xC0FE])
            )
            order = order_rng.permutation(len(self.samples))
            base, extra = divmod(self.length, len(self.samples))
            counts = np.full(len(self.samples), base, dtype=np.int64)
            counts[:extra] += 1
            boundaries = np.cumsum(counts)
            position = int(np.searchsorted(boundaries, index, side="right"))
            return int(order[position])
        selection_rng = np.random.default_rng(
            np.random.SeedSequence(
                [self.seed, self.epoch, index // self.patches_per_source_block, 0x10C1]
            )
        )
        return int(selection_rng.choice(len(self.samples), p=self.sample_probabilities))

    def selected_sample_ids(self) -> tuple[str, ...]:
        return tuple(
            self.samples[self._sample_index(index)].record.sample_id for index in range(self.length)
        )

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        if not 0 <= index < self.length:
            raise IndexError(index)
        rng = self._rng(index)
        sample_index = self._sample_index(index)
        sample = self.samples[sample_index]
        image, mask, full_targets = load_pair_and_targets(
            sample,
            self.offset_scale_px,
            self.preprocessing,
        )
        labels = np.unique(mask)
        labels = labels[labels > 0]
        choose_cell = bool(len(labels) and rng.random() < self.cell_patch_probability)
        if choose_cell:
            label_id = int(rng.choice(labels))
            ys, xs = np.nonzero(mask == label_id)
            point = int(rng.integers(0, len(xs)))
            jitter = max(1, self.patch_size // 5)
            center_y = int(ys[point] + rng.integers(-jitter, jitter + 1))
            center_x = int(xs[point] + rng.integers(-jitter, jitter + 1))
        else:
            center_y = int(rng.integers(0, image.shape[0]))
            center_x = int(rng.integers(0, image.shape[1]))
        image_patch, mask_patch = _crop_with_padding(
            image,
            mask,
            center_y,
            center_x,
            self.patch_size,
        )
        targets = _crop_targets_with_padding(
            full_targets,
            center_y,
            center_x,
            self.patch_size,
        )
        if self.augment:
            image_patch, mask_patch, targets = _spatial_augment(
                image_patch,
                mask_patch,
                targets,
                rng,
            )
            image_patch = _intensity_augment(image_patch, rng)
        image_tensor = torch.from_numpy(image_patch[None].astype(np.float32, copy=False))
        target_tensor = torch.from_numpy(targets)
        return image_tensor, target_tensor


def count_instances(mask: np.ndarray) -> int:
    labels = np.unique(validate_mask(mask))
    return int(np.count_nonzero(labels > 0))


def remove_small_instances(labels: np.ndarray, min_area_px: int) -> np.ndarray:
    if min_area_px < 1:
        raise ValueError("min_area_px must be positive")
    source = validate_mask(labels)
    result = np.zeros(source.shape, dtype=np.int32)
    next_id = 1
    for label_id in np.unique(source[source > 0]):
        region = source == label_id
        if int(region.sum()) >= min_area_px:
            result[region] = next_id
            next_id += 1
    return result
