"""Atomic, provenance-rich exports for cached segmentation results."""

from __future__ import annotations

import csv
import ctypes
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import sys
import tempfile
import unicodedata
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
from PIL import Image

from .render import render_overlay_rgb
from .results import CachedAnalysis

MEASUREMENT_FIELDS = (
    "cell_id",
    "area_px",
    "centroid_x_px",
    "centroid_y_px",
    "equivalent_diameter_px",
    "eccentricity",
)
SUMMARY_FIELDS = ("image_name", "cell_count")
EXPORT_OPTION_KEYS = (
    "overlay_png",
    "labels_tiff",
    "measurements_csv",
    "summary_csv",
    "analysis_json",
)
DEFAULT_EXPORT_OPTIONS = {
    "overlay_png": True,
    "labels_tiff": True,
    "measurements_csv": True,
    "summary_csv": False,
    "analysis_json": True,
}
_OPTION_ARTIFACTS = {
    "overlay_png": "overlay",
    "labels_tiff": "labels",
    "measurements_csv": "measurements",
    "summary_csv": "summary",
    "analysis_json": "analysis",
}

_WINDOWS_RESERVED_NAMES = {
    "AUX",
    "CON",
    "NUL",
    "PRN",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}

_SPREADSHEET_FORMULA_PREFIXES = frozenset("=+-@\t\r\n")

_DIRECTORY_OPEN_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_FILE_CREATE_FLAGS = (
    os.O_WRONLY
    | os.O_CREAT
    | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_SECURE_DIR_FD_AVAILABLE = all(
    function in os.supports_dir_fd
    for function in (os.mkdir, os.open, os.rename, os.stat, os.unlink)
)

_AT_FDCWD = -2 if sys.platform == "darwin" else -100
_RENAME_NOREPLACE = 1
_RENAME_EXCL = 0x00000004


def _native_rename_function() -> tuple[Any, int] | None:
    """Return a native POSIX no-replace rename function and its flag."""

    if sys.platform == "darwin":
        name = "renameatx_np"
        flag = _RENAME_EXCL
    elif sys.platform.startswith("linux"):
        name = "renameat2"
        flag = _RENAME_NOREPLACE
    else:
        return None
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, name, None)
    if function is None:
        return None
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    return function, flag


_NATIVE_RENAME = _native_rename_function()


def _rename_noreplace(
    source: str | Path,
    destination: str | Path,
    *,
    src_dir_fd: int | None = None,
    dst_dir_fd: int | None = None,
) -> None:
    """Publish atomically while refusing to replace an intervening destination."""

    if _NATIVE_RENAME is not None:
        function, flag = _NATIVE_RENAME
        result = function(
            _AT_FDCWD if src_dir_fd is None else src_dir_fd,
            os.fsencode(source),
            _AT_FDCWD if dst_dir_fd is None else dst_dir_fd,
            os.fsencode(destination),
            flag,
        )
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number), os.fspath(destination))
        return

    if os.name == "nt" and src_dir_fd is None and dst_dir_fd is None:
        # Windows os.rename already fails when the destination exists.
        os.rename(source, destination)
        return
    raise RuntimeError("Atomic no-replace publication is unavailable on this platform.")


class _NamedBinaryStream:
    """Give a descriptor-backed stream the harmless filename tifffile expects."""

    def __init__(self, stream: Any, name: str) -> None:
        self._stream = stream
        self.name = name

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def sanitize_basename(value: str, *, fallback: str = "loci-analysis") -> str:
    """Return a short filename stem that is safe on macOS and Windows."""

    if not isinstance(value, str):
        raise TypeError("basename must be a string")
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", ascii_value)
    sanitized = re.sub(r"_+", "_", sanitized).strip(" ._-")[:80].rstrip(" ._-")
    if not sanitized:
        sanitized = fallback
    if sanitized.split(".", 1)[0].upper() in _WINDOWS_RESERVED_NAMES:
        sanitized = f"loci-{sanitized}"
    return sanitized


def _spreadsheet_safe_text(value: str) -> str:
    """Neutralize text that spreadsheet programs could interpret as a formula."""

    if value and value[0] in _SPREADSHEET_FORMULA_PREFIXES:
        return f"'{value}"
    return value


def validate_export_options(value: object | None) -> dict[str, bool]:
    """Validate an explicit artifact selection while retaining the legacy default."""

    if value is None:
        return dict(DEFAULT_EXPORT_OPTIONS)
    if not isinstance(value, dict):
        raise TypeError("export options must be an object")
    unknown = set(value) - set(EXPORT_OPTION_KEYS)
    if unknown:
        raise ValueError(f"Unknown export options: {', '.join(sorted(unknown))}")
    options: dict[str, bool] = {}
    for key in EXPORT_OPTION_KEYS:
        selected = value.get(key, False)
        if not isinstance(selected, bool):
            raise TypeError(f"export option {key} must be a boolean")
        options[key] = selected
    if not any(options.values()):
        raise ValueError("Select at least one export artifact")
    return options


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_file(path: Path) -> None:
    # Windows rejects fsync on a read-only CRT descriptor.
    with path.open("rb+") as stream:
        os.fsync(stream.fileno())


def _fsync_directory(directory: Path) -> None:
    """Best-effort directory sync; opening directory handles is unsupported on Windows."""

    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        with suppress(OSError):
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _is_path_beneath(root: Path, candidate: Path) -> bool:
    try:
        common = os.path.commonpath((os.path.normcase(root), os.path.normcase(candidate)))
    except ValueError:
        return False
    return common == os.path.normcase(root)


def _validated_root_identity(value: object) -> tuple[int, int]:
    if not isinstance(value, dict) or set(value) != {"device", "inode"}:
        raise TypeError("allowed_root_identity must contain device and inode")
    device = value["device"]
    inode = value["inode"]
    if not isinstance(device, str) or not isinstance(inode, str):
        raise TypeError("allowed_root_identity values must be decimal strings")
    if not device.isdecimal() or not inode.isdecimal():
        raise ValueError("allowed_root_identity values must be decimal strings")
    return int(device), int(inode)


def _assert_root_identity(stat: os.stat_result, expected: tuple[int, int]) -> None:
    if (stat.st_dev, stat.st_ino) != expected:
        raise RuntimeError("The selected batch destination changed before publication.")


def _contained_directory_parts(allowed_root: Path, directory_value: str | Path) -> tuple[str, ...]:
    """Return a lexical path beneath the trusted root without following descendants."""

    directory = Path(directory_value).expanduser()
    if not directory.is_absolute():
        directory = Path.cwd() / directory
    directory = Path(os.path.abspath(directory))
    if not _is_path_beneath(allowed_root, directory):
        raise ValueError("The batch export directory is outside its allowed root.")
    relative = os.path.relpath(directory, allowed_root)
    if relative == ".":
        return ()
    parts = tuple(Path(relative).parts)
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("The batch export directory is invalid.")
    return parts


def _open_directory_beneath(
    root_descriptor: int,
    parts: tuple[str, ...],
    *,
    create: bool = False,
) -> int:
    """Open a descendant one component at a time without traversing symlinks."""

    descriptor = os.dup(root_descriptor)
    try:
        for part in parts:
            try:
                next_descriptor = os.open(
                    part,
                    _DIRECTORY_OPEN_FLAGS,
                    dir_fd=descriptor,
                )
            except FileNotFoundError:
                if not create:
                    raise
                with suppress(FileExistsError):
                    os.mkdir(part, 0o755, dir_fd=descriptor)
                next_descriptor = os.open(
                    part,
                    _DIRECTORY_OPEN_FLAGS,
                    dir_fd=descriptor,
                )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _assert_same_directory_beneath(
    root_descriptor: int,
    parts: tuple[str, ...],
    expected_descriptor: int,
) -> None:
    """Fail if a destination component was swapped after it was first opened."""

    current_descriptor = _open_directory_beneath(root_descriptor, parts)
    try:
        expected = os.fstat(expected_descriptor)
        current = os.fstat(current_descriptor)
        if (expected.st_dev, expected.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError("The batch export directory changed during publication.")
    finally:
        os.close(current_descriptor)


def _secure_stage_name() -> str:
    return f".loci-export-{secrets.token_hex(16)}"


def _secure_lock_name(parts: tuple[str, ...], candidate: str) -> str:
    location = "/".join((*parts, f"{candidate}_loci"))
    location_hash = hashlib.sha256(location.encode("utf-8")).hexdigest()[:24]
    return f".loci-export-{location_hash}.lock"


def _open_staged_file(staging_descriptor: int, filename: str, *, binary: bool):
    descriptor = os.open(
        filename,
        _FILE_CREATE_FLAGS,
        0o600,
        dir_fd=staging_descriptor,
    )
    if binary:
        return os.fdopen(descriptor, "w+b")
    return os.fdopen(descriptor, "w", encoding="utf-8", newline="\n")


def _sync_stream(stream: Any) -> None:
    stream.flush()
    os.fsync(stream.fileno())


def _sha256_at(directory_descriptor: int, filename: str) -> str:
    descriptor = os.open(
        filename,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=directory_descriptor,
    )
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_overlay_at(filename: str, staging_descriptor: int, result: CachedAnalysis) -> None:
    overlay = render_overlay_rgb(
        result.output.normalized,
        result.output.labels,
        max_edge=None,
    )
    with _open_staged_file(staging_descriptor, filename, binary=True) as stream:
        Image.fromarray(overlay).save(stream, format="PNG", optimize=True)
        _sync_stream(stream)


def _write_labels_at(filename: str, staging_descriptor: int, result: CachedAnalysis) -> None:
    maximum = int(result.output.labels.max(initial=0))
    dtype = np.uint16 if maximum <= np.iinfo(np.uint16).max else np.uint32
    labels = result.output.labels.astype(dtype, copy=False)
    with _open_staged_file(staging_descriptor, filename, binary=True) as stream:
        tifffile.imwrite(
            _NamedBinaryStream(stream, filename),
            labels,
            photometric="minisblack",
            metadata={"axes": "YX"},
        )
        _sync_stream(stream)


def _write_measurements_at(
    filename: str,
    staging_descriptor: int,
    result: CachedAnalysis,
) -> None:
    with _open_staged_file(staging_descriptor, filename, binary=False) as stream:
        writer = csv.DictWriter(stream, fieldnames=MEASUREMENT_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(result.output.measurements)
        _sync_stream(stream)


def _write_summary_at(filename: str, staging_descriptor: int, result: CachedAnalysis) -> None:
    with _open_staged_file(staging_descriptor, filename, binary=False) as stream:
        writer = csv.DictWriter(stream, fieldnames=SUMMARY_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerow(
            {
                "image_name": _spreadsheet_safe_text(result.source.name),
                "cell_count": result.output.count,
            }
        )
        _sync_stream(stream)


def _write_json_at(filename: str, staging_descriptor: int, value: object) -> None:
    with _open_staged_file(staging_descriptor, filename, binary=False) as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
        _sync_stream(stream)


def _reserve_bundle(
    directory: Path,
    basename: str,
    artifact_keys: tuple[str, ...],
) -> tuple[str, Path, Path, int, dict[str, Path]]:
    """Reserve a bundle name and create a hidden same-filesystem staging directory."""

    suffixes = {
        "overlay": "_overlay.png",
        "labels": "_labels.tiff",
        "measurements": "_measurements.csv",
        "summary": "_summary.csv",
        "analysis": "_analysis.json",
    }
    candidate = basename
    index = 1
    while True:
        bundle = directory / f"{candidate}_loci"
        lock = directory / f".{candidate}_loci.lock"
        try:
            lock_descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pass
        else:
            if bundle.exists():
                os.close(lock_descriptor)
                lock.unlink(missing_ok=True)
            else:
                try:
                    staging = Path(
                        tempfile.mkdtemp(prefix=f".{candidate}_loci.staging-", dir=directory)
                    )
                except Exception:
                    os.close(lock_descriptor)
                    lock.unlink(missing_ok=True)
                    raise
                targets = {key: staging / f"{candidate}{suffixes[key]}" for key in artifact_keys}
                targets["marker"] = staging / "loci-export.json"
                return candidate, bundle, lock, lock_descriptor, targets
        index += 1
        candidate = f"{basename}_{index}"


def _write_overlay(path: Path, result: CachedAnalysis) -> None:
    overlay = render_overlay_rgb(
        result.output.normalized,
        result.output.labels,
        max_edge=None,
    )
    Image.fromarray(overlay).save(path, format="PNG", optimize=True)
    _fsync_file(path)


def _write_labels(path: Path, result: CachedAnalysis) -> None:
    maximum = int(result.output.labels.max(initial=0))
    dtype = np.uint16 if maximum <= np.iinfo(np.uint16).max else np.uint32
    labels = result.output.labels.astype(dtype, copy=False)
    tifffile.imwrite(
        path,
        labels,
        photometric="minisblack",
        metadata={"axes": "YX"},
    )
    _fsync_file(path)


def _write_measurements(path: Path, result: CachedAnalysis) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=MEASUREMENT_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(result.output.measurements)
        stream.flush()
        os.fsync(stream.fileno())


def _write_summary(path: Path, result: CachedAnalysis) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=SUMMARY_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerow(
            {
                "image_name": _spreadsheet_safe_text(result.source.name),
                "cell_count": result.output.count,
            }
        )
        stream.flush()
        os.fsync(stream.fileno())


def _write_analysis(
    path: Path,
    result: CachedAnalysis,
    *,
    artifact_paths: dict[str, Path],
    options: dict[str, bool],
) -> None:
    record = result.provenance_dict()
    record["export"] = {
        "exported_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
        "options": options,
        "artifacts": {
            key: {
                "filename": artifact_path.name,
                "sha256": _sha256(artifact_path),
            }
            for key, artifact_path in artifact_paths.items()
        },
    }
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _write_marker(
    path: Path,
    result: CachedAnalysis,
    *,
    bundle_name: str,
    artifact_paths: dict[str, Path],
) -> None:
    marker = {
        "bundle_kind": "loci-export",
        "schema_version": "1.0",
        "bundle_name": bundle_name,
        "result_id": result.result_id,
        "source_sha256": result.source.sha256,
        "cell_count": result.output.count,
        "artifacts": {
            key: {
                "filename": artifact_path.name,
                "sha256": _sha256(artifact_path),
            }
            for key, artifact_path in artifact_paths.items()
        },
    }
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(marker, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _artifact_filenames(candidate: str, artifact_keys: tuple[str, ...]) -> dict[str, str]:
    suffixes = {
        "overlay": "_overlay.png",
        "labels": "_labels.tiff",
        "measurements": "_measurements.csv",
        "summary": "_summary.csv",
        "analysis": "_analysis.json",
    }
    filenames = {key: f"{candidate}{suffixes[key]}" for key in artifact_keys}
    filenames["marker"] = "loci-export.json"
    return filenames


def _write_secure_staging(
    staging_descriptor: int,
    filenames: dict[str, str],
    artifact_keys: tuple[str, ...],
    result: CachedAnalysis,
    *,
    bundle_name: str,
    options: dict[str, bool],
) -> None:
    if "overlay" in filenames:
        _write_overlay_at(filenames["overlay"], staging_descriptor, result)
    if "labels" in filenames:
        _write_labels_at(filenames["labels"], staging_descriptor, result)
    if "measurements" in filenames:
        _write_measurements_at(filenames["measurements"], staging_descriptor, result)
    if "summary" in filenames:
        _write_summary_at(filenames["summary"], staging_descriptor, result)
    if "analysis" in filenames:
        record = result.provenance_dict()
        record["export"] = {
            "exported_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "options": options,
            "artifacts": {
                key: {
                    "filename": filenames[key],
                    "sha256": _sha256_at(staging_descriptor, filenames[key]),
                }
                for key in artifact_keys
                if key != "analysis"
            },
        }
        _write_json_at(filenames["analysis"], staging_descriptor, record)

    marker = {
        "bundle_kind": "loci-export",
        "schema_version": "1.0",
        "bundle_name": bundle_name,
        "result_id": result.result_id,
        "source_sha256": result.source.sha256,
        "cell_count": result.output.count,
        "artifacts": {
            key: {
                "filename": filenames[key],
                "sha256": _sha256_at(staging_descriptor, filenames[key]),
            }
            for key in artifact_keys
        },
    }
    _write_json_at(filenames["marker"], staging_descriptor, marker)
    os.fsync(staging_descriptor)


def _reserve_secure_bundle(
    root_descriptor: int,
    destination_descriptor: int,
    destination_parts: tuple[str, ...],
    basename: str,
) -> tuple[str, str, int, str, int]:
    """Reserve under the trusted root and stage without touching the descendant."""

    candidate = basename
    index = 1
    while True:
        bundle_name = f"{candidate}_loci"
        lock_name = _secure_lock_name(destination_parts, candidate)
        try:
            lock_descriptor = os.open(
                lock_name,
                _FILE_CREATE_FLAGS,
                0o600,
                dir_fd=root_descriptor,
            )
        except FileExistsError:
            pass
        else:
            try:
                os.stat(bundle_name, dir_fd=destination_descriptor, follow_symlinks=False)
            except FileNotFoundError:
                while True:
                    staging_name = _secure_stage_name()
                    try:
                        os.mkdir(staging_name, 0o700, dir_fd=root_descriptor)
                    except FileExistsError:
                        continue
                    try:
                        staging_descriptor = os.open(
                            staging_name,
                            _DIRECTORY_OPEN_FLAGS,
                            dir_fd=root_descriptor,
                        )
                    except Exception:
                        shutil.rmtree(staging_name, dir_fd=root_descriptor)
                        raise
                    return (
                        candidate,
                        lock_name,
                        lock_descriptor,
                        staging_name,
                        staging_descriptor,
                    )
            os.close(lock_descriptor)
            os.unlink(lock_name, dir_fd=root_descriptor)
        index += 1
        candidate = f"{basename}_{index}"


def _export_analysis_with_dir_fds(
    result: CachedAnalysis,
    directory_value: str | Path,
    allowed_root: Path,
    *,
    allowed_root_identity: tuple[int, int],
    safe_basename: str,
    artifact_keys: tuple[str, ...],
    options: dict[str, bool],
) -> dict[str, Any]:
    destination_parts = _contained_directory_parts(allowed_root, directory_value)
    root_descriptor = os.open(allowed_root, _DIRECTORY_OPEN_FLAGS)
    try:
        _assert_root_identity(os.fstat(root_descriptor), allowed_root_identity)
        destination_descriptor = _open_directory_beneath(
            root_descriptor,
            destination_parts,
            create=True,
        )
    except Exception:
        os.close(root_descriptor)
        raise
    candidate = ""
    lock_name = ""
    lock_descriptor = -1
    staging_name = ""
    staging_descriptor = -1
    published = False
    try:
        (
            candidate,
            lock_name,
            lock_descriptor,
            staging_name,
            staging_descriptor,
        ) = _reserve_secure_bundle(
            root_descriptor,
            destination_descriptor,
            destination_parts,
            safe_basename,
        )
        bundle_name = f"{candidate}_loci"
        filenames = _artifact_filenames(candidate, artifact_keys)
        _write_secure_staging(
            staging_descriptor,
            filenames,
            artifact_keys,
            result,
            bundle_name=bundle_name,
            options=options,
        )

        # Reopen the destination through the root immediately before publish.
        # If a parent was replaced by a symlink or another directory while the
        # artifacts were being staged, no bundle is made visible there.
        _assert_same_directory_beneath(
            root_descriptor,
            destination_parts,
            destination_descriptor,
        )
        _rename_noreplace(
            staging_name,
            bundle_name,
            src_dir_fd=root_descriptor,
            dst_dir_fd=destination_descriptor,
        )
        published = True
        os.fsync(destination_descriptor)
        os.fsync(root_descriptor)

        directory = allowed_root.joinpath(*destination_parts, bundle_name)
        return {
            "directory": str(directory),
            "bundle_name": bundle_name,
            "files": {key: str(directory / filename) for key, filename in filenames.items()},
            "options": options,
            "cell_count": result.output.count,
        }
    finally:
        if staging_descriptor >= 0:
            os.close(staging_descriptor)
        if staging_name and not published:
            with suppress(FileNotFoundError):
                shutil.rmtree(staging_name, dir_fd=root_descriptor)
        if lock_descriptor >= 0:
            os.close(lock_descriptor)
        if lock_name:
            with suppress(FileNotFoundError):
                os.unlink(lock_name, dir_fd=root_descriptor)
        os.close(destination_descriptor)
        os.close(root_descriptor)


def _validate_portable_destination(
    allowed_root: Path,
    parts: tuple[str, ...],
    *,
    create: bool = False,
) -> Path:
    """Windows-compatible reparse-point guard used where dir-fd APIs are absent."""

    current = allowed_root
    for part in parts:
        current = current / part
        if create:
            with suppress(FileExistsError):
                current.mkdir()
        stat_result = current.lstat()
        file_attributes = int(getattr(stat_result, "st_file_attributes", 0))
        reparse_flag = int(getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
        if stat.S_ISLNK(stat_result.st_mode) or file_attributes & reparse_flag:
            raise RuntimeError("A symbolic link inside the batch destination is not allowed.")
        if not current.is_dir():
            raise NotADirectoryError(f"Batch export destination is not a directory: {current}")
    canonical = current.resolve(strict=True)
    if not _is_path_beneath(allowed_root, canonical):
        raise RuntimeError("The batch export directory escaped its allowed root.")
    return canonical


def _export_analysis_portable_guarded(
    result: CachedAnalysis,
    directory_value: str | Path,
    allowed_root: Path,
    *,
    allowed_root_identity: tuple[int, int],
    safe_basename: str,
    artifact_keys: tuple[str, ...],
    options: dict[str, bool],
) -> dict[str, Any]:
    """Conservative fallback for platforms without Python dir-fd support."""

    destination_parts = _contained_directory_parts(allowed_root, directory_value)
    _assert_root_identity(allowed_root.stat(), allowed_root_identity)
    destination = _validate_portable_destination(allowed_root, destination_parts, create=True)
    candidate = safe_basename
    index = 1
    lock: Path | None = None
    lock_descriptor = -1
    staging: Path | None = None
    published = False
    try:
        while True:
            bundle = destination / f"{candidate}_loci"
            lock = allowed_root / _secure_lock_name(destination_parts, candidate)
            try:
                lock_descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                pass
            else:
                if not bundle.exists():
                    break
                os.close(lock_descriptor)
                lock_descriptor = -1
                lock.unlink(missing_ok=True)
            index += 1
            candidate = f"{safe_basename}_{index}"

        bundle_name = f"{candidate}_loci"
        bundle = destination / bundle_name
        staging = Path(tempfile.mkdtemp(prefix=".loci-export-", dir=allowed_root))
        filenames = _artifact_filenames(candidate, artifact_keys)
        staged = {key: staging / filename for key, filename in filenames.items()}
        if "overlay" in staged:
            _write_overlay(staged["overlay"], result)
        if "labels" in staged:
            _write_labels(staged["labels"], result)
        if "measurements" in staged:
            _write_measurements(staged["measurements"], result)
        if "summary" in staged:
            _write_summary(staged["summary"], result)
        if "analysis" in staged:
            _write_analysis(
                staged["analysis"],
                result,
                artifact_paths={
                    key: path for key, path in staged.items() if key not in {"analysis", "marker"}
                },
                options=options,
            )
        _write_marker(
            staged["marker"],
            result,
            bundle_name=bundle_name,
            artifact_paths={key: staged[key] for key in artifact_keys},
        )
        _fsync_directory(staging)

        current_destination = _validate_portable_destination(allowed_root, destination_parts)
        if current_destination != destination:
            raise RuntimeError("The batch export directory changed during publication.")
        _rename_noreplace(staging, bundle)
        published = True
        _fsync_directory(destination)
        return {
            "directory": str(bundle),
            "bundle_name": bundle_name,
            "files": {key: str(bundle / filename) for key, filename in filenames.items()},
            "options": options,
            "cell_count": result.output.count,
        }
    finally:
        if staging is not None and not published:
            shutil.rmtree(staging, ignore_errors=True)
        if lock_descriptor >= 0:
            os.close(lock_descriptor)
        if lock is not None:
            lock.unlink(missing_ok=True)


def _validated_batch_metadata_files(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or not value:
        raise TypeError("batch metadata files must be a non-empty object")
    if len(value) > 2:
        raise ValueError("At most two batch metadata files can be published")
    validated: dict[str, str] = {}
    for filename, content in value.items():
        if (
            not isinstance(filename, str)
            or not filename
            or filename in {".", ".."}
            or "/" in filename
            or "\\" in filename
            or Path(filename).name != filename
        ):
            raise ValueError("Batch metadata filenames must be plain filenames")
        if not isinstance(content, str):
            raise TypeError("Batch metadata content must be text")
        if len(content.encode("utf-8")) > 32 * 1024 * 1024:
            raise ValueError("A batch metadata file is too large")
        validated[filename] = content
    return validated


def _ordered_batch_metadata_names(files: dict[str, str]) -> tuple[list[str], str]:
    """Return payload names followed by the single manifest commit marker."""

    manifest_names = [
        filename
        for filename in files
        if filename.startswith("loci_batch_manifest_") and filename.endswith(".json")
    ]
    if len(manifest_names) != 1:
        raise ValueError("Batch metadata must contain exactly one Loci batch manifest")
    manifest_name = manifest_names[0]
    payload_names = [filename for filename in files if filename != manifest_name]
    return payload_names, manifest_name


def publish_batch_metadata(
    allowed_root_value: str | Path,
    allowed_root_identity: object,
    files_value: object,
) -> dict[str, Any]:
    """Atomically publish root-level batch summary/manifest files."""

    expected_identity = _validated_root_identity(allowed_root_identity)
    allowed_root = Path(allowed_root_value).expanduser().resolve(strict=True)
    if not allowed_root.is_dir():
        raise NotADirectoryError(f"Allowed batch root is not a directory: {allowed_root}")
    files = _validated_batch_metadata_files(files_value)
    payload_names, manifest_name = _ordered_batch_metadata_names(files)
    publication_names = [*payload_names, manifest_name]

    if _SECURE_DIR_FD_AVAILABLE:
        root_descriptor = os.open(allowed_root, _DIRECTORY_OPEN_FLAGS)
        temporary_names: dict[str, str] = {}
        try:
            _assert_root_identity(os.fstat(root_descriptor), expected_identity)
            for filename in publication_names:
                content = files[filename]
                try:
                    os.stat(filename, dir_fd=root_descriptor, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise FileExistsError(f"Batch metadata already exists: {filename}")
                temporary_name = f".{filename}.{secrets.token_hex(16)}.tmp"
                temporary_names[filename] = temporary_name
                with _open_staged_file(root_descriptor, temporary_name, binary=False) as stream:
                    stream.write(content)
                    _sync_stream(stream)

            _assert_root_identity(os.fstat(root_descriptor), expected_identity)
            for filename in payload_names:
                _rename_noreplace(
                    temporary_names[filename],
                    filename,
                    src_dir_fd=root_descriptor,
                    dst_dir_fd=root_descriptor,
                )
            if payload_names:
                os.fsync(root_descriptor)
            _rename_noreplace(
                temporary_names[manifest_name],
                manifest_name,
                src_dir_fd=root_descriptor,
                dst_dir_fd=root_descriptor,
            )
            os.fsync(root_descriptor)
        finally:
            for temporary_name in temporary_names.values():
                with suppress(FileNotFoundError):
                    os.unlink(temporary_name, dir_fd=root_descriptor)
            os.close(root_descriptor)
    else:
        _assert_root_identity(allowed_root.stat(), expected_identity)
        temporary_paths: dict[str, Path] = {}
        try:
            for filename in publication_names:
                content = files[filename]
                final_path = allowed_root / filename
                if final_path.exists() or final_path.is_symlink():
                    raise FileExistsError(f"Batch metadata already exists: {filename}")
                descriptor, temporary_value = tempfile.mkstemp(
                    prefix=f".{filename}.",
                    suffix=".tmp",
                    dir=allowed_root,
                    text=True,
                )
                temporary = Path(temporary_value)
                temporary_paths[filename] = temporary
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                    stream.write(content)
                    _sync_stream(stream)
            _assert_root_identity(allowed_root.stat(), expected_identity)
            for filename in payload_names:
                final_path = allowed_root / filename
                _rename_noreplace(temporary_paths[filename], final_path)
            if payload_names:
                _fsync_directory(allowed_root)
            _rename_noreplace(
                temporary_paths[manifest_name],
                allowed_root / manifest_name,
            )
            _fsync_directory(allowed_root)
        finally:
            for temporary in temporary_paths.values():
                temporary.unlink(missing_ok=True)

    return {"files": {filename: str(allowed_root / filename) for filename in files}}


def export_analysis(
    result: CachedAnalysis,
    directory_value: str | Path,
    *,
    basename: str | None = None,
    options: object | None = None,
    allowed_root: str | Path | None = None,
    allowed_root_identity: object | None = None,
) -> dict[str, Any]:
    """Export one cached result without reading from or writing to its source image."""

    requested_basename = result.source.name.rsplit(".", 1)[0] if basename is None else basename
    safe_basename = sanitize_basename(requested_basename)
    validated_options = validate_export_options(options)
    artifact_keys = tuple(
        _OPTION_ARTIFACTS[key] for key in EXPORT_OPTION_KEYS if validated_options[key]
    )
    if allowed_root is not None:
        expected_root_identity = _validated_root_identity(allowed_root_identity)
        canonical_root = Path(allowed_root).expanduser().resolve(strict=True)
        if not canonical_root.is_dir():
            raise NotADirectoryError(f"Allowed batch root is not a directory: {canonical_root}")
        if _SECURE_DIR_FD_AVAILABLE:
            return _export_analysis_with_dir_fds(
                result,
                directory_value,
                canonical_root,
                allowed_root_identity=expected_root_identity,
                safe_basename=safe_basename,
                artifact_keys=artifact_keys,
                options=validated_options,
            )
        return _export_analysis_portable_guarded(
            result,
            directory_value,
            canonical_root,
            allowed_root_identity=expected_root_identity,
            safe_basename=safe_basename,
            artifact_keys=artifact_keys,
            options=validated_options,
        )

    directory = Path(directory_value).expanduser().resolve()
    if not directory.is_dir():
        raise NotADirectoryError(f"Export directory does not exist: {directory}")
    candidate, bundle, lock, lock_descriptor, staged = _reserve_bundle(
        directory,
        safe_basename,
        artifact_keys,
    )
    published = False

    try:
        if "overlay" in staged:
            _write_overlay(staged["overlay"], result)
        if "labels" in staged:
            _write_labels(staged["labels"], result)
        if "measurements" in staged:
            _write_measurements(staged["measurements"], result)
        if "summary" in staged:
            _write_summary(staged["summary"], result)
        if "analysis" in staged:
            _write_analysis(
                staged["analysis"],
                result,
                artifact_paths={
                    key: path for key, path in staged.items() if key not in {"analysis", "marker"}
                },
                options=validated_options,
            )
        selected_artifacts = {key: staged[key] for key in artifact_keys}
        _write_marker(
            staged["marker"],
            result,
            bundle_name=f"{candidate}_loci",
            artifact_paths=selected_artifacts,
        )
        _fsync_directory(next(iter(staged.values())).parent)
        _rename_noreplace(next(iter(staged.values())).parent, bundle)
        published = True
        _fsync_directory(directory)
    finally:
        try:
            staging_directory = next(iter(staged.values())).parent
            if not published and staging_directory.exists():
                shutil.rmtree(staging_directory)
        finally:
            try:
                os.close(lock_descriptor)
            finally:
                lock.unlink(missing_ok=True)

    files = {key: str(bundle / path.name) for key, path in staged.items()}

    return {
        "directory": str(bundle),
        "bundle_name": f"{candidate}_loci",
        "files": files,
        "options": validated_options,
        "cell_count": result.output.count,
    }
