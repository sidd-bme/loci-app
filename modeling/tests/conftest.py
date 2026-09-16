from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _default_mask(shape: tuple[int, int]) -> np.ndarray:
    height, width = shape
    mask = np.zeros(shape, dtype=np.uint16)
    first_top = max(1, height // 6)
    first_left = max(1, width // 7)
    first_height = max(3, height // 5)
    first_width = max(3, width // 6)
    mask[
        first_top : min(height, first_top + first_height),
        first_left : min(width, first_left + first_width),
    ] = 1
    second_bottom = max(1, height - height // 7)
    second_right = max(1, width - width // 8)
    second_height = max(3, height // 4)
    second_width = max(3, width // 5)
    mask[
        max(0, second_bottom - second_height) : second_bottom,
        max(0, second_right - second_width) : second_right,
    ] = 2
    return mask


def _default_image(shape: tuple[int, int]) -> np.ndarray:
    height, width = shape
    y, x = np.mgrid[:height, :width]
    image = 0.15 + 0.55 * x / max(1, width - 1) + 0.25 * y / max(1, height - 1)
    return np.rint(np.clip(image, 0.0, 1.0) * 65535).astype(np.uint16)


class SyntheticDatasetBuilder:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.raw_root = root / "raw"
        self.mask_root = root / "masks"
        self.raw_root.mkdir()
        self.mask_root.mkdir()
        self.payload: dict[str, Any] = {
            "schema_version": "1.0",
            "dataset": {
                "dataset_id": "synthetic-loci-cells",
                "provenance_label": "synthetic Cellpose-derived pseudo-labels",
                "reference_kind": "pseudo_label",
                "rights_id": "rights-synthetic-cleared-v1",
                "rights": {
                    "source_images_for_commercial_training": "cleared",
                    "segmentation_labels_for_commercial_training": "cleared",
                    "derived_weights_for_redistribution": "cleared",
                    "commercial_training_eligible": True,
                    "redistributable_weights_eligible": True,
                    "basis": "Synthetic fixture generated during the test run.",
                },
            },
            "split_rules": [
                "Acquisition groups do not cross active splits.",
                "Quarantined sources are excluded from training and evaluation.",
            ],
            "summary": {},
            "sources": [],
        }

    @property
    def sources(self) -> list[dict[str, Any]]:
        return self.payload["sources"]

    def add_active(
        self,
        source_id: str,
        *,
        split: str = "train",
        group: str | None = None,
        raw: np.ndarray | None = None,
        mask: np.ndarray | None = None,
        transform_type: str = "identity",
    ) -> dict[str, Any]:
        source_digest = hashlib.sha256(source_id.encode()).digest()
        source_marker = int.from_bytes(source_digest[:2], "big")
        if mask is None:
            mask_array = np.roll(
                _default_mask((64, 64)),
                shift=(source_digest[0] % 16 - 8, source_digest[1] % 16 - 8),
                axis=(0, 1),
            )
        else:
            mask_array = np.asarray(mask)
        if raw is None:
            raw_array = _default_image(mask_array.shape)
            raw_array = raw_array.copy()
            raw_array[0, 0] = np.uint16(source_marker)
        else:
            raw_array = np.asarray(raw)
        raw_relative = Path("images") / f"{source_id}.npy"
        mask_relative = Path("labels") / f"{source_id}_mask.npy"
        raw_path = self.raw_root / raw_relative
        mask_path = self.mask_root / mask_relative
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        np.save(raw_path, raw_array, allow_pickle=False)
        np.save(mask_path, mask_array, allow_pickle=False)
        instance_ids = np.unique(mask_array)
        instance_ids = instance_ids[instance_ids > 0]
        source = {
            "source_id": source_id,
            "relative_path": raw_relative.as_posix(),
            "sha256": _sha256(raw_path),
            "width": int(raw_array.shape[1]),
            "height": int(raw_array.shape[0]),
            "channels": 1,
            "dtype": str(raw_array.dtype),
            "format": "npy",
            "acquisition_group": group or f"group-{source_id}",
            "rights_id": "rights-synthetic-cleared-v1",
            "split": split,
            "qc_flags": [],
            "labels": [
                {
                    "label_id": f"label-{source_id}",
                    "relative_path": mask_relative.as_posix(),
                    "sha256": _sha256(mask_path),
                    "kind": "mask",
                    "variant": "default",
                    "width": int(mask_array.shape[1]),
                    "height": int(mask_array.shape[0]),
                    "dtype": str(mask_array.dtype),
                    "instance_count": int(len(instance_ids)),
                    "instance_ids_contiguous": bool(
                        np.array_equal(instance_ids, np.arange(1, len(instance_ids) + 1))
                    ),
                    "transform_type": transform_type,
                    "provenance_label": "synthetic pseudo-label",
                    "qc_flags": [],
                }
            ],
        }
        self.sources.append(source)
        return source

    def add_quarantine(self, source_id: str = "quarantine-missing") -> dict[str, Any]:
        source = {
            "source_id": source_id,
            "relative_path": f"quarantine/{source_id}.npy",
            "sha256": "a" * 64,
            "width": 64,
            "height": 64,
            "channels": 1,
            "dtype": "uint16",
            "format": "npy",
            "acquisition_group": f"group-{source_id}",
            "rights_id": "rights-synthetic-cleared-v1",
            "split": "quarantine",
            "qc_flags": ["zero_instance_mask"],
            # Metadata remains auditable, but the deliberately absent files must never be opened.
            "labels": [
                {
                    "label_id": f"label-{source_id}",
                    "relative_path": f"quarantine/{source_id}_mask.npy",
                    "sha256": "b" * 64,
                    "kind": "mask",
                    "variant": "default",
                    "width": 64,
                    "height": 64,
                    "dtype": "uint16",
                    "instance_count": 0,
                    "instance_ids_contiguous": True,
                    "transform_type": "identity",
                    "provenance_label": "synthetic quarantined pseudo-label",
                    "qc_flags": ["zero_instance_mask"],
                }
            ],
        }
        self.sources.append(source)
        return source

    def write(self, name: str = "manifest.json") -> Path:
        manifest_path = self.root / name
        manifest_path.write_text(
            json.dumps(self.payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return manifest_path


@pytest.fixture
def dataset_builder(tmp_path: Path) -> SyntheticDatasetBuilder:
    return SyntheticDatasetBuilder(tmp_path)
