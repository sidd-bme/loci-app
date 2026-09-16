"""Deterministic, rights-aware manifests for local segmentation training data.

The scanner never writes to the source or label roots. Paths recorded in a
manifest are relative to those roots so the result can be reviewed or shared
without disclosing workstation-specific locations.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import defaultdict
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Literal

import numpy as np
import tifffile
from PIL import Image, UnidentifiedImageError

from .io import SUPPORTED_STILL_SUFFIXES

MANIFEST_SCHEMA_VERSION = "1.0"
RightsStatus = Literal["cleared", "restricted", "unknown"]
DevelopmentSplit = Literal["train", "validation", "test", "quarantine", "unassigned"]


class TrainingManifestError(ValueError):
    """Base class for actionable training-manifest failures."""


class PairingError(TrainingManifestError):
    """Raised when a label cannot be paired with exactly one source."""


@dataclass(frozen=True, slots=True)
class RightsDeclaration:
    """Caller-supplied rights status; the scanner never infers legal clearance."""

    source_images_for_commercial_training: RightsStatus
    segmentation_labels_for_commercial_training: RightsStatus
    derived_weights_for_redistribution: RightsStatus
    basis: str

    def validate(self) -> None:
        allowed = {"cleared", "restricted", "unknown"}
        values = {
            self.source_images_for_commercial_training,
            self.segmentation_labels_for_commercial_training,
            self.derived_weights_for_redistribution,
        }
        if not values <= allowed:
            raise TrainingManifestError(
                "Rights fields must be 'cleared', 'restricted', or 'unknown'."
            )
        if not self.basis.strip():
            raise TrainingManifestError("The rights declaration requires a non-empty basis.")
        if _looks_absolute(self.basis):
            raise TrainingManifestError("The rights basis must not contain an absolute path.")

    def to_dict(self) -> dict[str, object]:
        training_cleared = (
            self.source_images_for_commercial_training == "cleared"
            and self.segmentation_labels_for_commercial_training == "cleared"
        )
        return {
            **asdict(self),
            "commercial_training_eligible": training_cleared,
            "redistributable_weights_eligible": (
                training_cleared and self.derived_weights_for_redistribution == "cleared"
            ),
        }


@dataclass(frozen=True, slots=True)
class SplitRule:
    """Assign a split when a source lies beneath one of the relative prefixes."""

    name: str
    split: DevelopmentSplit
    source_prefixes: tuple[str, ...]

    def validate(self) -> None:
        if not self.name.strip():
            raise TrainingManifestError("Split-rule names must not be empty.")
        if self.split not in {"train", "validation", "test", "quarantine"}:
            raise TrainingManifestError(f"Unsupported split in rule '{self.name}': {self.split}")
        if not self.source_prefixes:
            raise TrainingManifestError(f"Split rule '{self.name}' has no source prefixes.")
        for prefix in self.source_prefixes:
            normalized = _normalize_relative_path(prefix)
            if normalized in {"", "."}:
                raise TrainingManifestError(
                    f"Split rule '{self.name}' must not match the entire source root."
                )

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "split": self.split,
            "source_prefixes": [
                _normalize_relative_path(prefix) for prefix in self.source_prefixes
            ],
        }


@dataclass(frozen=True, slots=True)
class _ImageMetadata:
    width: int
    height: int
    channels: int
    dtype: str
    format: str


@dataclass(frozen=True, slots=True)
class _LabelCandidate:
    path: Path
    relative_path: str
    kind: Literal["mask", "cp_masks"]
    variant: str
    expected_source_stem: str


def _looks_absolute(value: str) -> bool:
    return (
        Path(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or value.casefold().startswith("file://")
    )


def _normalize_relative_path(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("Relative paths must be strings.")
    replaced = value.replace("\\", "/")
    if _looks_absolute(replaced):
        raise TrainingManifestError("Manifest paths must be relative.")
    parts = [part for part in PurePosixPath(replaced).parts if part not in {"", "."}]
    if any(part == ".." for part in parts):
        raise TrainingManifestError("Manifest paths must not traverse above their root.")
    return PurePosixPath(*parts).as_posix() if parts else "."


def _iter_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for directory, child_directories, filenames in os.walk(root, followlinks=False):
        current = Path(directory)
        child_directories[:] = sorted(
            (
                name
                for name in child_directories
                if not (current / name).is_symlink()
            ),
            key=str.casefold,
        )
        for filename in sorted(filenames, key=str.casefold):
            path = current / filename
            if not path.is_symlink():
                files.append(path)
    return files


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _is_raw_diagnostic(path: Path) -> bool:
    return path.stem.casefold().endswith("_flows")


def _map_segmented_top_level(value: str) -> tuple[str, str]:
    folded = value.casefold()
    if folded.endswith("_segmented_tuned"):
        return value[: -len("_segmented_tuned")], "tuned"
    if folded.endswith("_segmented_2"):
        return f"{value[: -len('_segmented_2')]}_2", "default"
    if folded.endswith("_segmented"):
        return value[: -len("_segmented")], "default"
    return value, "default"


def _label_candidate(path: Path, segmented_root: Path) -> _LabelCandidate | None:
    name = path.name
    folded = name.casefold()
    if folded.endswith(("_flows_cp_masks.tif", "_dp_cp_masks.tif")):
        return None
    if folded.endswith("_cp_masks.tif"):
        kind: Literal["mask", "cp_masks"] = "cp_masks"
        basename = name[: -len("_cp_masks.tif")]
    elif folded.endswith("_mask.tif"):
        kind = "mask"
        basename = name[: -len("_mask.tif")]
    else:
        return None

    relative = path.relative_to(segmented_root)
    parts = list(relative.parts)
    variant = "default"
    parent_parts: list[str]
    if len(parts) == 1:
        parent_parts = []
    else:
        raw_top, variant = _map_segmented_top_level(parts[0])
        parent_parts = [raw_top, *parts[1:-1]]
    if kind == "cp_masks" and parent_parts and parent_parts[-1].casefold() == "masks":
        parent_parts.pop()
    expected_source_stem = PurePosixPath(*parent_parts, basename).as_posix()
    return _LabelCandidate(
        path=path,
        relative_path=relative.as_posix(),
        kind=kind,
        variant=variant,
        expected_source_stem=expected_source_stem,
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def _read_source(path: Path, relative_path: str) -> tuple[_ImageMetadata, str]:
    before = _snapshot(path)
    try:
        if path.suffix.casefold() in {".tif", ".tiff"}:
            with tifffile.TiffFile(path) as tif:
                if len(tif.pages) != 1:
                    raise TrainingManifestError(
                        f"Source '{relative_path}' is not a single-plane TIFF."
                    )
                page = tif.pages[0]
                shape = tuple(int(value) for value in page.shape)
                dtype = str(page.dtype)
            image_format = "TIFF"
            if len(shape) == 2:
                height, width = shape
                channels = 1
            elif len(shape) == 3 and shape[-1] in {1, 3, 4}:
                height, width, channels = shape
            else:
                raise TrainingManifestError(
                    f"Source '{relative_path}' has an unsupported image layout {shape}."
                )
        else:
            with Image.open(path) as image:
                width, height = int(image.width), int(image.height)
                channels = len(image.getbands())
                dtype = "uint8"
                image_format = image.format or path.suffix.lstrip(".").upper()
    except (UnidentifiedImageError, tifffile.TiffFileError) as exc:
        raise TrainingManifestError(f"Could not decode source '{relative_path}'.") from exc
    digest = _sha256(path)
    if before != _snapshot(path):
        raise TrainingManifestError(f"Source '{relative_path}' changed during manifest creation.")
    return (
        _ImageMetadata(
            width=width,
            height=height,
            channels=channels,
            dtype=dtype,
            format=image_format,
        ),
        digest,
    )


def _read_label(
    path: Path,
    relative_path: str,
) -> tuple[_ImageMetadata, str, int, bool, list[str]]:
    before = _snapshot(path)
    try:
        with tifffile.TiffFile(path) as tif:
            if len(tif.pages) != 1:
                raise TrainingManifestError(
                    f"Label '{relative_path}' is not a single-plane TIFF."
                )
            page = tif.pages[0]
            if len(page.shape) != 2:
                raise TrainingManifestError(f"Label '{relative_path}' is not a 2D array.")
            labels = page.asarray()
    except tifffile.TiffFileError as exc:
        raise TrainingManifestError(f"Could not decode label '{relative_path}'.") from exc
    if not np.issubdtype(labels.dtype, np.integer):
        raise TrainingManifestError(f"Label '{relative_path}' must contain integer IDs.")
    if np.issubdtype(labels.dtype, np.signedinteger) and bool(np.any(labels < 0)):
        raise TrainingManifestError(f"Label '{relative_path}' contains negative IDs.")

    unique_ids = np.unique(labels)
    positive_ids = unique_ids[unique_ids > 0]
    instance_count = int(positive_ids.size)
    contiguous = bool(
        instance_count == 0
        or (int(positive_ids[0]) == 1 and int(positive_ids[-1]) == instance_count)
    )
    flags: list[str] = []
    if instance_count == 0:
        flags.append("zero_instance_mask")
    if not contiguous:
        flags.append("non_contiguous_instance_ids")

    digest = _sha256(path)
    if before != _snapshot(path):
        raise TrainingManifestError(f"Label '{relative_path}' changed during manifest creation.")
    height, width = (int(value) for value in labels.shape)
    return (
        _ImageMetadata(
            width=width,
            height=height,
            channels=1,
            dtype=str(labels.dtype),
            format="TIFF",
        ),
        digest,
        instance_count,
        contiguous,
        flags,
    )


def _label_transform(source: _ImageMetadata, label: _ImageMetadata, relative_path: str) -> str:
    if (source.width, source.height) == (label.width, label.height):
        return "identity"
    scale = min(label.width / source.width, label.height / source.height)
    expected_width = round(source.width * scale)
    expected_height = round(source.height * scale)
    if abs(expected_width - label.width) <= 1 and abs(expected_height - label.height) <= 1:
        return "aspect_preserving_resize"
    raise TrainingManifestError(
        f"Label '{relative_path}' is not spatially compatible with its source."
    )


def _stable_id(prefix: str, relative_path: str, digest: str) -> str:
    payload = f"loci-{prefix}-v1\0{relative_path}\0{digest}".encode()
    return f"{prefix}_{hashlib.sha256(payload).hexdigest()[:24]}"


def _acquisition_group(source_relative_path: str) -> str:
    parts = PurePosixPath(source_relative_path).parts
    if len(parts) <= 1:
        return "."
    if len(parts) == 2:
        return parts[0]
    return PurePosixPath(*parts[:2]).as_posix()


def _path_is_within(source_path: str, prefix: str) -> bool:
    normalized_source = _normalize_relative_path(source_path).casefold()
    normalized_prefix = _normalize_relative_path(prefix).casefold()
    return normalized_source == normalized_prefix or normalized_source.startswith(
        f"{normalized_prefix}/"
    )


def _assigned_split(source_path: str, rules: Sequence[SplitRule]) -> DevelopmentSplit:
    matches = {
        rule.split
        for rule in rules
        if any(_path_is_within(source_path, prefix) for prefix in rule.source_prefixes)
    }
    if len(matches) > 1:
        raise TrainingManifestError(
            f"Source '{source_path}' matches conflicting development split rules."
        )
    return next(iter(matches), "unassigned")


def _manifest_summary(
    *,
    raw_supported_count: int,
    raw_diagnostics_excluded: int,
    labels_discovered: int,
    sources: list[dict[str, Any]],
) -> dict[str, object]:
    split_counts: dict[str, int] = defaultdict(int)
    flagged_sources = 0
    for source in sources:
        split_counts[str(source["split"])] += 1
        if source["qc_flags"]:
            flagged_sources += 1
    label_count = sum(len(source["labels"]) for source in sources)
    raw_eligible_count = raw_supported_count - raw_diagnostics_excluded
    return {
        "raw_supported_files": raw_supported_count,
        "raw_diagnostics_excluded": raw_diagnostics_excluded,
        "raw_eligible_sources": raw_eligible_count,
        "paired_sources": len(sources),
        "unpaired_eligible_sources": raw_eligible_count - len(sources),
        "labels": label_count,
        "labels_discovered": labels_discovered,
        "sources_with_multiple_labels": sum(len(source["labels"]) > 1 for source in sources),
        "flagged_sources": flagged_sources,
        "split_source_counts": dict(sorted(split_counts.items())),
    }


def _assert_no_absolute_paths(value: object) -> None:
    if isinstance(value, dict):
        for child in value.values():
            _assert_no_absolute_paths(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _assert_no_absolute_paths(child)
    elif isinstance(value, str) and _looks_absolute(value):
        raise TrainingManifestError("Manifest content contains an absolute path.")


def build_training_manifest(
    raw_root_value: str | Path,
    segmented_root_value: str | Path,
    *,
    rights: RightsDeclaration,
    provenance_label: str,
    split_rules: Sequence[SplitRule] = (),
) -> dict[str, Any]:
    """Scan read-only roots and return a deterministic, path-relative manifest."""

    raw_root = Path(raw_root_value).expanduser().resolve()
    segmented_root = Path(segmented_root_value).expanduser().resolve()
    if not raw_root.is_dir():
        raise NotADirectoryError(f"Raw root does not exist: {raw_root}")
    if not segmented_root.is_dir():
        raise NotADirectoryError(f"Segmented root does not exist: {segmented_root}")
    rights.validate()
    if not isinstance(provenance_label, str) or not provenance_label.strip():
        raise TrainingManifestError("provenance_label must be a non-empty string.")
    if _looks_absolute(provenance_label):
        raise TrainingManifestError("provenance_label must not contain an absolute path.")
    for rule in split_rules:
        rule.validate()

    raw_files_all = [
        path
        for path in _iter_files(raw_root)
        if path.suffix.casefold() in SUPPORTED_STILL_SUFFIXES
    ]
    raw_diagnostics = [path for path in raw_files_all if _is_raw_diagnostic(path)]
    raw_files = [path for path in raw_files_all if not _is_raw_diagnostic(path)]
    raw_by_stem: dict[str, list[Path]] = defaultdict(list)
    for path in raw_files:
        stem = PurePosixPath(_relative(path, raw_root)).with_suffix("").as_posix().casefold()
        raw_by_stem[stem].append(path)

    label_candidates = [
        candidate
        for path in _iter_files(segmented_root)
        if (candidate := _label_candidate(path, segmented_root)) is not None
    ]
    grouped: dict[Path, list[_LabelCandidate]] = defaultdict(list)
    for candidate in label_candidates:
        matches = raw_by_stem.get(candidate.expected_source_stem.casefold(), [])
        if not matches:
            raise PairingError(
                f"No contextual raw source matches label '{candidate.relative_path}'."
            )
        if len(matches) > 1:
            match_paths = ", ".join(sorted(_relative(path, raw_root) for path in matches))
            raise PairingError(
                f"Label '{candidate.relative_path}' has ambiguous raw sources: {match_paths}"
            )
        grouped[matches[0]].append(candidate)

    rights_record = rights.to_dict()
    rights_id = _stable_id(
        "rights",
        provenance_label.strip(),
        hashlib.sha256(
            json.dumps(rights_record, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    )
    sources: list[dict[str, Any]] = []
    for source_path in sorted(grouped, key=lambda path: _relative(path, raw_root).casefold()):
        source_relative_path = _relative(source_path, raw_root)
        source_metadata, source_sha256 = _read_source(source_path, source_relative_path)
        labels: list[dict[str, Any]] = []
        source_flags: set[str] = set()
        candidates = sorted(
            grouped[source_path],
            key=lambda item: item.relative_path.casefold(),
        )
        for candidate in candidates:
            label_metadata, label_sha256, instance_count, contiguous, flags = _read_label(
                candidate.path,
                candidate.relative_path,
            )
            transform = _label_transform(
                source_metadata,
                label_metadata,
                candidate.relative_path,
            )
            source_flags.update(flags)
            labels.append(
                {
                    "label_id": _stable_id(
                        "lbl",
                        candidate.relative_path,
                        label_sha256,
                    ),
                    "relative_path": candidate.relative_path,
                    "sha256": label_sha256,
                    "kind": candidate.kind,
                    "variant": candidate.variant,
                    "width": label_metadata.width,
                    "height": label_metadata.height,
                    "dtype": label_metadata.dtype,
                    "instance_count": instance_count,
                    "instance_ids_contiguous": contiguous,
                    "transform_type": transform,
                    "provenance_label": provenance_label.strip(),
                    "qc_flags": flags,
                }
            )
        if len(labels) > 1:
            source_flags.add("competing_label_variants")

        split = _assigned_split(source_relative_path, split_rules)
        if source_flags & {"zero_instance_mask", "competing_label_variants"}:
            split = "quarantine"
        sources.append(
            {
                "source_id": _stable_id("src", source_relative_path, source_sha256),
                "relative_path": source_relative_path,
                "sha256": source_sha256,
                "width": source_metadata.width,
                "height": source_metadata.height,
                "channels": source_metadata.channels,
                "dtype": source_metadata.dtype,
                "format": source_metadata.format,
                "acquisition_group": _acquisition_group(source_relative_path),
                "rights_id": rights_id,
                "split": split,
                "qc_flags": sorted(source_flags),
                "labels": labels,
            }
        )

    summary = _manifest_summary(
        raw_supported_count=len(raw_files_all),
        raw_diagnostics_excluded=len(raw_diagnostics),
        labels_discovered=len(label_candidates),
        sources=sources,
    )
    manifest: dict[str, Any] = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "dataset": {
            "provenance_label": provenance_label.strip(),
            "rights_id": rights_id,
            "rights": rights_record,
        },
        "split_rules": [rule.to_dict() for rule in split_rules],
        "summary": summary,
        "sources": sources,
    }
    _assert_no_absolute_paths(manifest)
    return manifest


def dry_run_summary(
    raw_root_value: str | Path,
    segmented_root_value: str | Path,
    *,
    rights: RightsDeclaration,
    provenance_label: str,
    split_rules: Sequence[SplitRule] = (),
) -> dict[str, object]:
    """Return scan counts and split assignments without writing an output file."""

    manifest = build_training_manifest(
        raw_root_value,
        segmented_root_value,
        rights=rights,
        provenance_label=provenance_label,
        split_rules=split_rules,
    )
    return dict(manifest["summary"])


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        with suppress(OSError):
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_training_manifest(manifest: dict[str, Any], destination_value: str | Path) -> Path:
    """Atomically publish a validated manifest to a caller-selected destination."""

    _assert_no_absolute_paths(manifest)
    destination = Path(destination_value).expanduser().resolve()
    if not destination.parent.is_dir():
        raise NotADirectoryError(
            f"Manifest destination directory does not exist: {destination.parent}"
        )
    payload = json.dumps(
        manifest,
        indent=2,
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8") + b"\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
    finally:
        temporary.unlink(missing_ok=True)
    return destination
