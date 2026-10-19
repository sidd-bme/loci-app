"""Provisional counts and native RGB outlines without changing result review state."""

from __future__ import annotations

import csv
import errno
import io
import os
import re
import shutil
import stat
import tempfile
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
from PIL import Image, PngImagePlugin
from skimage.segmentation import find_boundaries

from .export import _fsync_directory, _rename_noreplace
from .quantitative import exact_keys
from .research_export import _verify_references
from .research_interchange import _reject_absolute_strings
from .research_project import canonical_json
from .research_session import _cleanup_missing_entry
from .working_result import _sha256_file_stable

MAX_REVIEW_PIXELS = 16 * 1024**2
OUTLINE_RGB = (41, 245, 201)
_BINDING_KEYS = {"source_id", "source_sha256", "result_id", "revision_hash"}
_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", re.I)


def review_package_label(value: Any) -> str:
    """Accept a portable, explicit directory label while preserving spaces and case."""
    if (
        not isinstance(value, str)
        or not value.strip()
        or value != value.strip()
        or len(value.encode("utf-8")) > 120
        or value.startswith(".")
        or value.endswith(".")
        or any(ord(c) < 32 or ord(c) == 127 or c in '/\\:<>"|?*' for c in value)
        or _RESERVED.fullmatch(value)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ValueError("Choose a portable review package name of 1-120 UTF-8 bytes")
    return value


def _relative(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Source has an invalid relative image path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value:
        raise ValueError("Source has an invalid relative image path")
    for part in path.parts:
        review_package_label(part)
    return path.as_posix()


def _snapshot(workbench: Any, bindings: Any) -> list[dict[str, Any]]:
    if not isinstance(bindings, list) or not 1 <= len(bindings) <= 1000:
        raise ValueError("Choose 1-1000 exact segmentation revisions for a review package")
    items = []
    seen_sources: set[str] = set()
    seen_paths: set[str] = set()
    for binding in bindings:
        exact_keys(binding, _BINDING_KEYS, "review package binding")
        if set(binding) != _BINDING_KEYS:
            raise ValueError("Review package binding requires every exact identity")
        result = workbench.project.result(binding["result_id"])
        source = workbench.project.source(binding["source_id"], verify=True)
        if (
            result["revision_hash"] != binding["revision_hash"]
            or result["source_id"] != source["id"]
            or result["source_sha256"] != source["sha256"]
            or source["sha256"] != binding["source_sha256"]
        ):
            raise ValueError("Review package source or result revision is stale")
        if result["schema"] != "loci.research-result/v1" or "labels" not in result["arrays"]:
            raise ValueError("Review packages currently require a bounded 2D label result")
        relative = _relative(source.get("private_relative_path") or source["name"])
        key = unicodedata.normalize("NFC", relative).casefold()
        if source["id"] in seen_sources or key in seen_paths:
            raise ValueError("Review package sources have conflicting or duplicate image paths")
        seen_sources.add(source["id"])
        seen_paths.add(key)
        _verify_references(workbench.project, result)
        items.append(
            {
                "source": source,
                "result": result,
                "relative": relative,
                "review": workbench.project.review_state(result["id"]),
            }
        )
    # A file path must not also be used as another image's directory.
    paths = sorted(seen_paths)
    for left, right in zip(paths, paths[1:], strict=False):
        if right.startswith(left + "/"):
            raise ValueError("Review package image paths have a directory collision")
    return items


def _csv_text(value: str) -> str:
    return "'" + value if value[:1] in {"=", "+", "-", "@", "\t", "\r", "\n"} else value


def _write(path: Path, data: bytes) -> dict[str, Any]:
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    digest, size = _sha256_file_stable(path, reject_symlink=True)
    return {"sha256": digest, "size_bytes": size}


def _verify_stage(stage: Path, expected: dict[str, dict[str, Any]]) -> None:
    actual = set()
    for directory, directories, files in os.walk(stage, followlinks=False):
        for name in directories:
            if not stat.S_ISDIR((Path(directory) / name).lstat().st_mode):
                raise ValueError("Review package staging contains a linked directory")
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(stage).as_posix()
            if relative not in expected:
                raise ValueError("Review package staging contains unexpected artifacts")
            digest, size = _sha256_file_stable(path, reject_symlink=True)
            if {"sha256": digest, "size_bytes": size} != expected[relative]:
                raise ValueError("Review package artifact changed before publication")
            actual.add(relative)
    if actual != set(expected):
        raise ValueError("Review package staging artifacts are incomplete")


def export_review_package(
    workbench: Any, request: dict[str, Any], destination: str | Path
) -> dict[str, Any]:
    """Atomically publish review material, retaining exact pending/reviewed/excluded state."""
    exact_keys(request, {"bindings", "root_label"}, "review package")
    if set(request) != {"bindings", "root_label"}:
        raise ValueError("Review package requires exact bindings and a root label")
    root_label = review_package_label(request["root_label"])
    items = _snapshot(workbench, request["bindings"])
    target = Path(destination)
    if not target.is_absolute() or target.name != root_label:
        raise ValueError("Review package destination must be absolute and match its root label")
    parent = target.parent
    if parent.resolve(strict=True) != parent or not stat.S_ISDIR(parent.lstat().st_mode):
        raise ValueError("Review package parent must be a canonical plain directory")
    if target.exists() or target.is_symlink():
        raise ValueError("Review package destination must be absent")
    if target == workbench.project.root or target.is_relative_to(workbench.project.root):
        raise ValueError("Review packages must be outside the source study")
    parent_identity = parent.stat()
    stage = Path(tempfile.mkdtemp(prefix=".loci-review-", dir=parent))
    stage_identity = stage.stat()
    published = False
    try:
        output = []
        csv_stream = io.StringIO(newline="")
        writer = csv.writer(csv_stream, lineterminator="\n")
        writer.writerow(["image_name", "cell_count", "review_status"])
        for item in items:
            source, result = item["source"], item["result"]
            selection = result["provenance"]["selection"]
            dimensions = source["metadata"]["dimensions"]
            if (
                set(selection) != {"x", "y", "width", "height", "t", "c", "z", "level"}
                or any(selection[k] != 0 for k in ("x", "y", "level", "c"))
                or selection["width"] != dimensions["x"]
                or selection["height"] != dimensions["y"]
                or selection["width"] * selection["height"] > MAX_REVIEW_PIXELS
            ):
                raise ValueError(
                    "Review outlines require a whole native 2D plane up to 16 megapixels"
                )
            labels = workbench.project.load_array(result["arrays"]["labels"])
            raw, geometry, resolved = workbench.load_scalar(
                source["id"], selection, allow_rgb=True, working_bytes=2 * 1024**3
            )
            if (
                raw.dtype != np.uint8
                or raw.shape != (selection["height"], selection["width"], 3)
                or labels.shape != raw.shape[:2]
                or labels.dtype.kind not in "ui"
                or np.any(labels < 0)
                or resolved != selection
                or canonical_json(geometry.to_dict())
                != canonical_json(result["provenance"]["geometry"])
            ):
                raise ValueError("Review outlines require matching native uint8 RGB and 2D labels")
            ids = np.unique(labels)
            ids = ids[ids != 0]
            measurements = result["provenance"].get("measurements")
            if (
                not isinstance(measurements, list)
                or [r.get("label") for r in measurements] != ids.tolist()
            ):
                raise ValueError("Review count disagrees with the exact saved label measurements")
            review = item["review"]
            disposition = review["disposition"] if review else "pending"
            # A root-labelled logical image name, never the source's filesystem locator.
            image_name = f"/{root_label}/{item['relative']}"
            outline_name = "outlines/" + item["relative"] + ".outlines.png"
            png_path = stage / outline_name
            png_path.parent.mkdir(parents=True, exist_ok=True)
            boundary = find_boundaries(labels, mode="outer")
            pixels = raw.copy()
            pixels[boundary] = OUTLINE_RGB
            context = {
                "status": "provisional-review-material",
                "scientific_validation": "not established",
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "labels_sha256": result["arrays"]["labels"]["sha256"],
                "review_status": disposition,
                "selection": selection,
                "geometry": geometry.to_dict(),
                "rendering": {
                    "base": "unchanged native uint8 RGB source samples",
                    "resampling": "none",
                    "boundary": "skimage.find_boundaries(mode=outer)",
                    "boundary_rgb": list(OUTLINE_RGB),
                    "color_transform": "none",
                },
            }
            scientific_context = {
                key: result["provenance"][key]
                for key in ("profile", "model", "accepted_request", "runtime")
                if key in result["provenance"]
            }
            _reject_absolute_strings(scientific_context, "Review scientific provenance")
            context.update(scientific_context)
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("Loci review provenance", canonical_json(context))
            with png_path.open("xb") as stream:
                Image.fromarray(pixels).save(stream, format="PNG", pnginfo=metadata)
                stream.flush()
                os.fsync(stream.fileno())
            with Image.open(png_path) as image:
                if image.size != (raw.shape[1], raw.shape[0]) or not np.array_equal(
                    np.asarray(image), pixels
                ):
                    raise ValueError("Review PNG failed exact pixel round-trip verification")
            digest, size = _sha256_file_stable(png_path, reject_symlink=True)
            writer.writerow([_csv_text(image_name), len(ids), disposition])
            output.append(
                {
                    **context,
                    "image_name": image_name,
                    "cell_count": len(ids),
                    "outline": {"path": outline_name, "sha256": digest, "size_bytes": size},
                    "review": review,
                }
            )
        csv_record = _write(stage / "counts.csv", csv_stream.getvalue().encode("utf-8"))
        manifest = {
            "schema": "loci.review-package/v1",
            "status": "provisional-review-material",
            "scientific_validation": "not established",
            "root_label": root_label,
            "count_summary": {"path": "counts.csv", **csv_record},
            "images": output,
        }
        manifest_record = _write(
            stage / "manifest.json", (canonical_json(manifest) + "\n").encode("utf-8")
        )
        # Reopen every scientific identity and label artifact immediately before publication.
        if canonical_json(_snapshot(workbench, request["bindings"])) != canonical_json(items):
            raise ValueError("Review package source, result or review state changed during export")
        for item in items:
            workbench.project.load_array(item["result"]["arrays"]["labels"])
        expected_files = {"counts.csv": csv_record, "manifest.json": manifest_record}
        for item in output:
            outline = item["outline"]
            expected_files[outline["path"]] = {
                "sha256": outline["sha256"],
                "size_bytes": outline["size_bytes"],
            }
        _verify_stage(stage, expected_files)
        for directory, _, _ in os.walk(stage, topdown=False):
            _fsync_directory(Path(directory))
        if (
            parent.resolve(strict=True) != parent
            or not os.path.samestat(parent_identity, parent.lstat())
            or not os.path.samestat(stage_identity, stage.lstat())
            or not stat.S_ISDIR(stage.lstat().st_mode)
        ):
            raise ValueError("Review package publication directory changed")
        try:
            _rename_noreplace(stage, target)
        except OSError as error:
            if error.errno in {errno.ENOTSUP, errno.EOPNOTSUPP}:
                raise ValueError(
                    "This destination drive does not support atomic review package saving. "
                    "Choose a folder on an APFS drive or another filesystem that "
                    "supports atomic no-replace renaming."
                ) from error
            raise
        published = True
        _fsync_directory(parent)
        return {
            "schema": "loci.review-package-receipt/v1",
            "status": "provisional-review-material",
            "basename": target.name,
            "image_count": len(output),
            "manifest_sha256": manifest_record["sha256"],
            "summary_name": "counts.csv",
        }
    except BaseException as error:
        try:
            if (
                not published
                and stage.exists()
                and not stage.is_symlink()
                and os.path.samestat(stage_identity, stage.lstat())
            ):
                shutil.rmtree(stage, onerror=_cleanup_missing_entry)
        except (OSError, ValueError) as cleanup_error:
            error.add_note(f"Review package staging cleanup failed: {cleanup_error}")
        raise
