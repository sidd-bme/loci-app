"""Validated contracts shared across training, inference, and export."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Literal

ReferenceKind = Literal["pseudo_label", "adjudicated"]
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_RECORD_ID = re.compile(r"^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$")


def _require_relative_path(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty relative path")
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ValueError(f"{field_name} must not be absolute or contain traversal components")
    return path.as_posix()


def _require_identifier(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    candidate = value.strip()
    if len(candidate) > 200:
        raise ValueError(f"{field_name} must be at most 200 characters")
    return candidate


def _require_sha256(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value.lower()):
        raise ValueError(f"{field_name} must be a 64-character SHA-256")
    return value.lower()


def _require_positive_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{field_name} must be a positive integer")
    return value


def _require_nonnegative_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return value


def _require_flags(value: object, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{field_name} must be an array of non-empty strings")
    return tuple(value)


@dataclass(frozen=True, slots=True)
class RightsRecord:
    record_id: str
    source_images_for_commercial_training: str
    segmentation_labels_for_commercial_training: str
    derived_weights_for_redistribution: str
    commercial_training_eligible: bool
    redistributable_weights_eligible: bool
    basis: str

    @classmethod
    def from_dataset(cls, dataset: object) -> RightsRecord:
        if not isinstance(dataset, dict):
            raise ValueError("dataset must be an object")
        rights_id = _require_identifier(dataset.get("rights_id"), "dataset.rights_id")
        value = dataset.get("rights")
        if not isinstance(value, dict):
            raise ValueError("dataset.rights must be an object")
        statuses: dict[str, str] = {}
        for name in (
            "source_images_for_commercial_training",
            "segmentation_labels_for_commercial_training",
            "derived_weights_for_redistribution",
        ):
            status = _require_identifier(value.get(name), f"dataset.rights.{name}")
            if status != "cleared":
                raise ValueError(f"dataset.rights.{name} must be 'cleared'")
            statuses[name] = status
        if value.get("commercial_training_eligible") is not True:
            raise ValueError("dataset.rights.commercial_training_eligible must explicitly be true")
        if value.get("redistributable_weights_eligible") is not True:
            raise ValueError(
                "dataset.rights.redistributable_weights_eligible must explicitly be true"
            )
        return cls(
            record_id=rights_id,
            source_images_for_commercial_training=statuses["source_images_for_commercial_training"],
            segmentation_labels_for_commercial_training=statuses[
                "segmentation_labels_for_commercial_training"
            ],
            derived_weights_for_redistribution=statuses["derived_weights_for_redistribution"],
            commercial_training_eligible=True,
            redistributable_weights_eligible=True,
            basis=_require_identifier(value.get("basis"), "dataset.rights.basis"),
        )


@dataclass(frozen=True, slots=True)
class SampleRecord:
    sample_id: str
    raw: str
    mask: str
    split: Literal["train", "validation", "test"]
    group: str
    raw_sha256: str
    mask_sha256: str
    raw_width: int
    raw_height: int
    raw_channels: int
    raw_dtype: str
    raw_format: str
    mask_width: int
    mask_height: int
    mask_dtype: str
    instance_count: int
    instance_ids_contiguous: bool
    label_id: str
    label_kind: Literal["mask", "cp_masks"]
    label_variant: Literal["default", "tuned"]
    transform_type: Literal["identity", "aspect_preserving_resize"]
    provenance_label: str
    rights_id: str
    weight: float = 1.0

    @classmethod
    def from_source(cls, value: object, rights: RightsRecord) -> SampleRecord | None:
        if not isinstance(value, dict):
            raise ValueError("each source must be an object")
        source_id = _require_identifier(value.get("source_id"), "source.source_id")
        split = value.get("split")
        if split not in {"train", "validation", "test", "quarantine"}:
            raise ValueError(f"unsupported source split for {source_id}: {split!r}")
        source_flags = _require_flags(value.get("qc_flags"), f"source[{source_id}].qc_flags")
        source_rights_id = _require_identifier(
            value.get("rights_id"), f"source[{source_id}].rights_id"
        )
        if source_rights_id != rights.record_id:
            raise ValueError(f"source rights_id mismatch for {source_id}")
        raw_path = _require_relative_path(
            value.get("relative_path"), f"source[{source_id}].relative_path"
        )
        raw_sha256 = _require_sha256(value.get("sha256"), f"source[{source_id}].sha256")
        raw_width = _require_positive_int(value.get("width"), f"source[{source_id}].width")
        raw_height = _require_positive_int(value.get("height"), f"source[{source_id}].height")
        raw_channels = _require_positive_int(value.get("channels"), f"source[{source_id}].channels")
        raw_dtype = _require_identifier(value.get("dtype"), f"source[{source_id}].dtype")
        raw_format = _require_identifier(value.get("format"), f"source[{source_id}].format")
        acquisition_group = _require_identifier(
            value.get("acquisition_group"), f"source[{source_id}].acquisition_group"
        )
        labels = value.get("labels")
        if not isinstance(labels, list) or not labels:
            raise ValueError(f"source[{source_id}].labels must be a non-empty array")

        # Quarantined sources are indexed, but no label is selected or opened.
        if split == "quarantine":
            for index, label in enumerate(labels):
                prefix = f"source[{source_id}].labels[{index}]"
                if not isinstance(label, dict):
                    raise ValueError(f"{prefix} must be an object")
                label_id = _require_identifier(label.get("label_id"), f"{prefix}.label_id")
                _require_relative_path(
                    label.get("relative_path"), f"label[{label_id}].relative_path"
                )
                _require_sha256(label.get("sha256"), f"label[{label_id}].sha256")
                if label.get("kind") not in {"mask", "cp_masks"}:
                    raise ValueError(f"unsupported label kind for {label_id}")
                if label.get("variant") not in {"default", "tuned"}:
                    raise ValueError(f"unsupported label variant for {label_id}")
                _require_positive_int(label.get("width"), f"label[{label_id}].width")
                _require_positive_int(label.get("height"), f"label[{label_id}].height")
                _require_identifier(label.get("dtype"), f"label[{label_id}].dtype")
                _require_nonnegative_int(
                    label.get("instance_count"), f"label[{label_id}].instance_count"
                )
                if not isinstance(label.get("instance_ids_contiguous"), bool):
                    raise ValueError(f"label[{label_id}].instance_ids_contiguous must be a boolean")
                if label.get("transform_type") not in {
                    "identity",
                    "aspect_preserving_resize",
                }:
                    raise ValueError(f"unsupported label transform for {label_id}")
                _require_identifier(
                    label.get("provenance_label"), f"label[{label_id}].provenance_label"
                )
                _require_flags(label.get("qc_flags"), f"label[{label_id}].qc_flags")
            return None
        if source_flags:
            raise ValueError(f"active source {source_id} has QC flags: {', '.join(source_flags)}")
        if len(labels) != 1:
            raise ValueError(f"active source {source_id} must have exactly one selected label")
        label = labels[0]
        if not isinstance(label, dict):
            raise ValueError(f"source[{source_id}].labels[0] must be an object")
        label_id = _require_identifier(label.get("label_id"), f"label[{source_id}].label_id")
        label_flags = _require_flags(label.get("qc_flags"), f"label[{label_id}].qc_flags")
        if label_flags:
            raise ValueError(f"active label {label_id} has QC flags: {', '.join(label_flags)}")
        kind = label.get("kind")
        if kind not in {"mask", "cp_masks"}:
            raise ValueError(f"unsupported label kind for {label_id}: {kind!r}")
        variant = label.get("variant")
        if variant not in {"default", "tuned"}:
            raise ValueError(f"unsupported label variant for {label_id}: {variant!r}")
        transform_type = label.get("transform_type")
        if transform_type not in {"identity", "aspect_preserving_resize"}:
            raise ValueError(f"unsupported label transform for {label_id}: {transform_type!r}")
        mask_width = _require_positive_int(label.get("width"), f"label[{label_id}].width")
        mask_height = _require_positive_int(label.get("height"), f"label[{label_id}].height")
        if transform_type == "identity" and (raw_width, raw_height) != (mask_width, mask_height):
            raise ValueError(f"identity label dimensions differ for {label_id}")
        raw_aspect = raw_width / raw_height
        mask_aspect = mask_width / mask_height
        if transform_type == "aspect_preserving_resize" and abs(raw_aspect - mask_aspect) > 0.02:
            raise ValueError(f"aspect-preserving label has incompatible dimensions for {label_id}")
        if label.get("instance_ids_contiguous") is not True:
            raise ValueError(f"active label {label_id} must have contiguous instance IDs")
        instance_count = _require_positive_int(
            label.get("instance_count"), f"label[{label_id}].instance_count"
        )
        provenance = _require_identifier(
            label.get("provenance_label"), f"label[{label_id}].provenance_label"
        )
        return cls(
            sample_id=source_id,
            raw=raw_path,
            mask=_require_relative_path(
                label.get("relative_path"), f"label[{label_id}].relative_path"
            ),
            split=split,
            group=acquisition_group,
            raw_sha256=raw_sha256,
            mask_sha256=_require_sha256(label.get("sha256"), f"label[{label_id}].sha256"),
            raw_width=raw_width,
            raw_height=raw_height,
            raw_channels=raw_channels,
            raw_dtype=raw_dtype,
            raw_format=raw_format,
            mask_width=mask_width,
            mask_height=mask_height,
            mask_dtype=_require_identifier(label.get("dtype"), f"label[{label_id}].dtype"),
            instance_count=instance_count,
            instance_ids_contiguous=True,
            label_id=label_id,
            label_kind=kind,
            label_variant=variant,
            transform_type=transform_type,
            provenance_label=provenance,
            rights_id=source_rights_id,
        )


@dataclass(frozen=True, slots=True)
class DatasetManifest:
    schema_version: str
    dataset_id: str
    reference_kind: ReferenceKind
    adjudication_record_id: str | None
    provenance_label: str
    rights: RightsRecord
    samples: tuple[SampleRecord, ...]
    source_count: int
    quarantine_count: int
    manifest_sha256: str
    source_path: Path = field(repr=False, compare=False)
    _snapshot: dict[str, Any] = field(repr=False, compare=False)

    @classmethod
    def load(cls, path: str | Path) -> DatasetManifest:
        source_path = Path(path).expanduser().resolve(strict=True)
        payload_bytes = source_path.read_bytes()
        try:
            payload = json.loads(payload_bytes)
        except json.JSONDecodeError as exc:
            raise ValueError(f"manifest is not valid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("manifest root must be an object")
        if payload.get("schema_version") != "1.0":
            raise ValueError("manifest.schema_version must be '1.0'")
        dataset = payload.get("dataset")
        if not isinstance(dataset, dict):
            raise ValueError("manifest.dataset must be an object")
        for top_level_name, expected_type in {
            "split_rules": list,
            "summary": dict,
        }.items():
            if not isinstance(payload.get(top_level_name), expected_type):
                raise ValueError(f"manifest.{top_level_name} must be a {expected_type.__name__}")
        manifest_sha256 = hashlib.sha256(payload_bytes).hexdigest()
        declared_dataset_id = dataset.get("dataset_id", dataset.get("id"))
        dataset_id = (
            _require_identifier(declared_dataset_id, "dataset.dataset_id")
            if declared_dataset_id is not None
            else f"dataset_{manifest_sha256[:24]}"
        )
        provenance_label = _require_identifier(
            dataset.get("provenance_label"), "dataset.provenance_label"
        )
        declared_reference = dataset.get("reference_kind")
        if declared_reference is not None and declared_reference not in {
            "pseudo_label",
            "adjudicated",
        }:
            raise ValueError("dataset.reference_kind must be pseudo_label or adjudicated")
        reference_kind: ReferenceKind = (
            declared_reference
            if declared_reference is not None
            else ("adjudicated" if "adjudicat" in provenance_label.lower() else "pseudo_label")
        )
        has_adjudication_record = "adjudication_record_id" in dataset
        if reference_kind == "adjudicated":
            adjudication_record_id = _require_identifier(
                dataset.get("adjudication_record_id"),
                "dataset.adjudication_record_id",
            )
            if not _RECORD_ID.fullmatch(adjudication_record_id):
                raise ValueError(
                    "dataset.adjudication_record_id must be a path-free record identifier"
                )
        else:
            if has_adjudication_record:
                raise ValueError(
                    "dataset.adjudication_record_id must be absent unless "
                    "dataset.reference_kind is adjudicated"
                )
            adjudication_record_id = None
        rights = RightsRecord.from_dataset(dataset)
        raw_sources = payload.get("sources")
        if not isinstance(raw_sources, list) or not raw_sources:
            raise ValueError("manifest.sources must be a non-empty array")
        samples: list[SampleRecord] = []
        quarantine_count = 0
        all_source_ids: set[str] = set()
        all_raw_paths: set[str] = set()
        for source in raw_sources:
            if not isinstance(source, dict):
                raise ValueError("each source must be an object")
            source_id = _require_identifier(source.get("source_id"), "source.source_id")
            raw_path = _require_relative_path(
                source.get("relative_path"), f"source[{source_id}].relative_path"
            )
            if source_id in all_source_ids:
                raise ValueError(f"duplicate source_id: {source_id}")
            if raw_path in all_raw_paths:
                raise ValueError(f"duplicate source relative_path: {raw_path}")
            all_source_ids.add(source_id)
            all_raw_paths.add(raw_path)
            sample = SampleRecord.from_source(source, rights)
            if sample is None:
                quarantine_count += 1
            else:
                samples.append(sample)
        manifest = cls(
            schema_version="1.0",
            dataset_id=dataset_id,
            reference_kind=reference_kind,
            adjudication_record_id=adjudication_record_id,
            provenance_label=provenance_label,
            rights=rights,
            samples=tuple(samples),
            source_count=len(raw_sources),
            quarantine_count=quarantine_count,
            manifest_sha256=manifest_sha256,
            source_path=source_path,
            _snapshot=payload,
        )
        manifest.validate()
        return manifest

    def validate(self) -> None:
        sample_ids: set[str] = set()
        raw_paths: set[str] = set()
        mask_paths: set[str] = set()
        raw_hashes: dict[str, str] = {}
        mask_hashes: dict[str, str] = {}
        group_splits: dict[str, set[str]] = {}
        active_train = 0
        for sample in self.samples:
            if sample.sample_id in sample_ids:
                raise ValueError(f"duplicate source_id: {sample.sample_id}")
            sample_ids.add(sample.sample_id)
            if sample.raw in raw_paths:
                raise ValueError(f"duplicate active raw path: {sample.raw}")
            if sample.mask in mask_paths:
                raise ValueError(f"duplicate active mask path: {sample.mask}")
            if previous_source := raw_hashes.get(sample.raw_sha256):
                raise ValueError(
                    f"duplicate active raw SHA-256: {sample.sample_id} duplicates {previous_source}"
                )
            if previous_label := mask_hashes.get(sample.mask_sha256):
                raise ValueError(
                    f"duplicate active mask SHA-256: {sample.label_id} duplicates {previous_label}"
                )
            raw_paths.add(sample.raw)
            mask_paths.add(sample.mask)
            raw_hashes[sample.raw_sha256] = sample.sample_id
            mask_hashes[sample.mask_sha256] = sample.label_id
            group_splits.setdefault(sample.group, set()).add(sample.split)
            if sample.split == "train":
                active_train += 1
        leaking = {
            group: sorted(splits) for group, splits in group_splits.items() if len(splits) > 1
        }
        if leaking:
            details = "; ".join(f"{group}: {','.join(splits)}" for group, splits in leaking.items())
            raise ValueError(f"acquisition groups cross active splits: {details}")
        if active_train == 0:
            raise ValueError("manifest must contain at least one active training source")

    def split(self, name: Literal["train", "validation", "test"]) -> tuple[SampleRecord, ...]:
        return tuple(sample for sample in self.samples if sample.split == name)

    def relative_snapshot(self) -> dict[str, Any]:
        snapshot = json.loads(json.dumps(self._snapshot))
        snapshot["source_manifest_sha256"] = self.manifest_sha256
        return snapshot

    def reference_lineage(self) -> dict[str, str]:
        """Return path-free reference provenance suitable for exported lineage."""

        lineage = {
            "dataset_id": self.dataset_id,
            "manifest_sha256": self.manifest_sha256,
            "dataset_provenance_label": self.provenance_label,
            "reference_kind": self.reference_kind,
            "rights_id": self.rights.record_id,
        }
        if self.adjudication_record_id is not None:
            lineage["adjudication_record_id"] = self.adjudication_record_id
        return lineage


@dataclass(frozen=True, slots=True)
class ModelConfig:
    in_channels: int = 1
    base_channels: int = 24
    depth: int = 4
    group_norm_groups: int = 8
    dropout: float = 0.05

    def validate(self) -> None:
        if self.in_channels != 1:
            raise ValueError(
                "the current Loci native model requires one normalized intensity channel"
            )
        if not 8 <= self.base_channels <= 128:
            raise ValueError("base_channels must be between 8 and 128")
        if not 2 <= self.depth <= 5:
            raise ValueError("depth must be between 2 and 5")
        if self.group_norm_groups < 1:
            raise ValueError("group_norm_groups must be positive")
        if not 0 <= self.dropout < 0.6:
            raise ValueError("dropout must be in [0, 0.6)")


@dataclass(frozen=True, slots=True)
class PostprocessConfig:
    foreground_threshold: float = 0.5
    boundary_threshold: float = 0.55
    min_area_px: int = 40
    offset_scale_px: float = 128.0
    vote_smoothing_px: float = 2.0
    seed_min_distance_px: int = 8
    minimum_seed_votes: int = 4
    exclude_border: bool = False

    def validate(self) -> None:
        for name, value in {
            "foreground_threshold": self.foreground_threshold,
            "boundary_threshold": self.boundary_threshold,
        }.items():
            if not 0 < value < 1:
                raise ValueError(f"{name} must be in (0, 1)")
        if self.min_area_px < 1:
            raise ValueError("min_area_px must be positive")
        if self.offset_scale_px <= 0:
            raise ValueError("offset_scale_px must be positive")
        if self.vote_smoothing_px < 0:
            raise ValueError("vote_smoothing_px must be non-negative")
        if self.seed_min_distance_px < 1 or self.minimum_seed_votes < 1:
            raise ValueError("seed controls must be positive")


@dataclass(frozen=True, slots=True)
class TrainingConfig:
    seed: int = 20260829
    epochs: int = 100
    steps_per_epoch: int = 200
    validation_steps: int = 40
    batch_size: int = 4
    patch_size: int = 256
    cell_patch_probability: float = 0.8
    learning_rate: float = 3e-4
    weight_decay: float = 1e-4
    gradient_clip_norm: float = 5.0
    num_workers: int = 0
    checkpoint_every: int = 10
    patches_per_source_block: int = 8
    use_amp: bool = True

    def validate(self, model: ModelConfig | None = None) -> None:
        if self.seed < 0:
            raise ValueError("seed must be non-negative")
        for name, value in {
            "epochs": self.epochs,
            "steps_per_epoch": self.steps_per_epoch,
            "validation_steps": self.validation_steps,
            "batch_size": self.batch_size,
            "patch_size": self.patch_size,
            "checkpoint_every": self.checkpoint_every,
            "patches_per_source_block": self.patches_per_source_block,
        }.items():
            if value < 1:
                raise ValueError(f"{name} must be positive")
        if model is not None and self.patch_size % (2**model.depth):
            raise ValueError("patch_size must be divisible by 2**model.depth")
        if not 0 <= self.cell_patch_probability <= 1:
            raise ValueError("cell_patch_probability must be in [0, 1]")
        if self.learning_rate <= 0 or self.weight_decay < 0:
            raise ValueError("optimizer settings are invalid")
        if self.gradient_clip_norm <= 0:
            raise ValueError("gradient_clip_norm must be positive")
        if self.num_workers < 0:
            raise ValueError("num_workers must be non-negative")
