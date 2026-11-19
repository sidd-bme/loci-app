"""Offline, standalone μSAM handoff export and cross-session return binding.

Creates an atomic, no-overwrite directory containing the exact original native
level-0 scalar TIFF (`input.tif`), a path-free `manifest.json`, and `README.md`
with pinned upstream instructions. Never launches external tools, downloads
models, embeds ML runtimes, or grants assistant/MCP access.
"""

from __future__ import annotations

import copy
import hashlib
import io
import math
import os
import sqlite3
import stat
import uuid
from contextlib import ExitStack, suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import tifffile

from .export import _rename_noreplace
from .quantitative import integer
from .research_data_export import _capability
from .research_labels_import import _digest, _identity, _source_binding, _validate_no_path_text
from .research_project import (
    ID_PATTERN,
    MAX_ARTIFACT_BYTES,
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
)
from .research_review_package import review_package_label

if TYPE_CHECKING:
    from .workbench import Workbench

HANDOFF_SCHEMA = "loci.usam-handoff/v1"
HANDOFF_RECEIPT_SCHEMA = "loci.usam-handoff-receipt/v1"
HANDOFF_BINDING_SCHEMA = "loci.usam-handoff-binding/v1"
_LOCAL_PREFIX = "usam-export:"
_NATIVE_DTYPES = {
    "uint8",
    "uint16",
    "uint32",
    "int8",
    "int16",
    "int32",
    "float16",
    "float32",
    "float64",
}
MAX_MANIFEST_BYTES = 64 * 1024

UPSTREAM_REFERENCE = {
    "tool": "micro-sam",
    "version": "2.0.1",
    "commit": "d45ab70ece93a9eb3ca1e237b9067767b0a18263",
}

_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)

_MANIFEST_KEYS = {
    "schema",
    "handoff_id",
    "export_origin",
    "source_id",
    "source_sha256",
    "source_name",
    "selection",
    "measurement_channel",
    "geometry",
    "calibration",
    "input",
    "label_profile",
    "upstream_reference",
    "validation",
    "manifest_sha256",
}


def _file_digest(data: bytes) -> dict[str, Any]:
    return {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}


def _calibration_summary(geometry: dict[str, Any]) -> dict[str, Any]:
    from .workbench import geometry_from_dict

    if (
        not isinstance(geometry, dict)
        or set(geometry) != {"axes", "frame", "unit", "affine"}
        or geometry["axes"] not in ("YX", "ZYX")
        or geometry["frame"] != "image"
        or geometry["unit"] not in ("pixel", "nm", "um", "mm", "m")
        or not isinstance(geometry["affine"], (list, tuple))
        or len(geometry["affine"]) != 4
        or any(
            not isinstance(row, (list, tuple))
            or len(row) != 4
            or any(type(n) not in (int, float) and not isinstance(n, np.floating) for n in row)
            for row in geometry["affine"]
        )
    ):
        raise ValueError("Invalid native handoff geometry")
    try:
        native = geometry_from_dict(geometry)
        spacing = native.spacing
    except OverflowError as exc:
        raise ValueError("Native handoff geometry exceeds numerical bounds") from exc
    if not all(math.isfinite(step) and step > 0 for step in spacing):
        raise ValueError("Invalid native handoff spacing")
    return {
        "axes": native.axes,
        "unit": native.unit,
        "status": "unknown" if native.unit == "pixel" else "known",
        "spacing": None if native.unit == "pixel" else list(spacing),
    }


def _bounded_manifest(value: Any) -> None:
    try:
        if len(canonical_json(value).encode()) > MAX_MANIFEST_BYTES:
            raise ValueError("μSAM handoff manifest exceeds its bounded size limit")
    except (TypeError, RecursionError) as exc:
        raise ValueError("Invalid μSAM manifest JSON") from exc


def _check_measurement_channel(channel: Any, index: int) -> None:
    if (
        not isinstance(channel, dict)
        or set(channel) != {"index", "name", "basis"}
        or type(channel["index"]) is not int
        or channel["index"] != index
        or channel["basis"] != "raw-source-channel-values"
    ):
        raise ValueError("Invalid μSAM measurement channel")
    name = checked_text(channel["name"], "Measurement channel name", 272)
    prefix = f"{index + 1}: "
    if not name.startswith(prefix):
        raise ValueError("Measurement channel name disagrees with the selected index")
    _validate_no_path_text(checked_text(name[len(prefix) :], "Channel name", 256))


def _native_grid(selection: Any) -> tuple[str, list[int]]:
    required_sel = {"x", "y", "width", "height", "t", "c", "z", "level"}
    if not isinstance(selection, dict) or set(selection) not in (
        required_sel,
        required_sel | {"z_stop"},
    ):
        raise ValueError("μSAM handoff selection is invalid or incomplete")
    if any(type(v) is not int or not 0 <= v <= 2**53 - 1 for v in selection.values()):
        raise ValueError("μSAM handoff selection coordinates must be non-negative integers")
    if (
        selection["x"] != 0
        or selection["y"] != 0
        or selection["level"] != 0
        or selection["width"] < 1
        or selection["height"] < 1
    ):
        raise ValueError("μSAM handoff selection requires a full level-zero native plane")
    volume = "z_stop" in selection
    axes = "ZYX" if volume else "YX"
    depth = selection["z_stop"] - selection["z"] if volume else 1
    if volume and depth < 2:
        raise ValueError("ZYX μSAM handoff selection requires at least two Z planes")
    shape = [selection["height"], selection["width"]]
    if volume:
        shape.insert(0, depth)
    return axes, shape


def _label_profile(axes: str, shape: list[int]) -> dict[str, Any]:
    return {
        "profile": f"scalar-native-{axes.lower()}/v1",
        "alignment": f"same-native-{axes.lower()}-grid",
        "axes": axes,
        "shape": shape,
        "allowed_dtypes": ["uint8", "uint16", "uint32"],
        "background_value": 0,
        "format": "TIFF",
    }


def validate_usam_handoff_manifest(value: Any) -> dict[str, Any]:
    """Verify the structure, bounds, and integrity hash of a μSAM handoff manifest."""
    if not isinstance(value, dict):
        raise ValueError("μSAM handoff manifest must be a JSON object")
    _bounded_manifest(value)
    if set(value) != _MANIFEST_KEYS:
        raise ValueError("μSAM handoff manifest is incomplete")
    if value["schema"] != HANDOFF_SCHEMA:
        raise ValueError("Unsupported μSAM handoff manifest schema")
    if value["export_origin"] != "verified-loci-native-export":
        raise ValueError("μSAM handoff manifest must declare verified Loci native export origin")
    if value["validation"] != "not-established":
        raise ValueError("μSAM handoff manifest cannot assert established validation")
    checked_id(value["handoff_id"])
    checked_id(value["source_id"])
    for key in ("source_sha256", "manifest_sha256"):
        if not isinstance(value[key], str) or not SHA_PATTERN.fullmatch(value[key]):
            raise ValueError(f"μSAM handoff {key} is invalid")
    source_name = checked_text(value["source_name"], "μSAM source name", 256)
    _validate_no_path_text(source_name)

    selection = value["selection"]
    axes, expected_shape = _native_grid(selection)
    _check_measurement_channel(value["measurement_channel"], selection["c"])
    geometry = value["geometry"]
    if canonical_json(value["calibration"]) != canonical_json(_calibration_summary(geometry)):
        raise ValueError("μSAM handoff calibration disagrees with its geometry")
    if geometry["axes"] != axes:
        raise ValueError("Native handoff geometry axes disagree with its selection")

    input_meta = value["input"]
    if not isinstance(input_meta, dict):
        raise ValueError("μSAM handoff input metadata must be an object")
    if (
        set(input_meta)
        != {
            "file_name",
            "file_sha256",
            "file_size_bytes",
            "array_sha256",
            "dtype",
            "shape",
            "axes",
            "compression",
            "value_preservation",
        }
        or input_meta["file_name"] != "input.tif"
        or input_meta["axes"] != axes
        or canonical_json(input_meta["shape"]) != canonical_json(expected_shape)
        or not isinstance(input_meta["dtype"], str)
        or input_meta["dtype"] not in _NATIVE_DTYPES
        or input_meta["compression"] != "deflate"
        or math.prod(expected_shape) * np.dtype(input_meta["dtype"]).itemsize > MAX_ARTIFACT_BYTES
        or input_meta["value_preservation"] != "exact-original-native-scalar-samples"
        or not isinstance(input_meta["file_sha256"], str)
        or not SHA_PATTERN.fullmatch(input_meta["file_sha256"])
        or not isinstance(input_meta["array_sha256"], str)
        or not SHA_PATTERN.fullmatch(input_meta["array_sha256"])
        or isinstance(input_meta["file_size_bytes"], bool)
        or not isinstance(input_meta["file_size_bytes"], int)
        or not 1 <= input_meta["file_size_bytes"] <= MAX_ARTIFACT_BYTES
    ):
        raise ValueError("μSAM handoff input record is invalid")

    if canonical_json(value["label_profile"]) != canonical_json(
        _label_profile(axes, expected_shape)
    ):
        raise ValueError("μSAM handoff label profile is invalid")

    if value["upstream_reference"] != UPSTREAM_REFERENCE:
        raise ValueError("μSAM handoff upstream reference is unsupported")

    expected_hash = _digest({k: v for k, v in value.items() if k != "manifest_sha256"})
    if value["manifest_sha256"] != expected_hash:
        raise ValueError("μSAM handoff manifest integrity hash mismatch")
    return value


def _readme_text(manifest: dict[str, Any]) -> str:
    axes = manifest["input"]["axes"]
    shape = tuple(manifest["input"]["shape"])
    ndim = len(shape)
    return f"""# Return instance labels from standalone μSAM

Handoff `{manifest["handoff_id"]}`. The raw scalar image in `input.tif` has
axes {axes}, shape {shape} and dtype {manifest["input"]["dtype"]}. Keep its
native grid, orientation and instance IDs throughout annotation.

Use a separately managed Python ≥3.11 micro-sam v2.0.1 environment (commit
`{UPSTREAM_REFERENCE["commit"]}`) and a checkpoint you have already verified
and provisioned locally. Upstream uses pooch/xxh128 and loads Python pickle
checkpoints (`micro_sam/util.py:477`). Choose a model appropriate for your image.

```sh
micro_sam annotator segmentation -i input.tif --ndim {ndim} -m "$MODEL"
```

For headless work, use `micro_sam inference segmentation` in that environment.
The v2.0.1 imageio writer (`micro_sam/v2/automatic_segmentation.py:351`) can
encode 3 or 4 planes as RGB(A) SYX and longer stacks as QYX. Keep the original
native label array (e.g. Python API with `output_path=None` or the committed
napari labels layer). Confirm its axis order before writing. With that array
in `labels`, run in your external environment:

```python
import numpy as np
import tifffile

labels = np.asarray(labels)
if labels.shape != {shape} or labels.dtype.kind not in ("i", "u"):
    raise ValueError("Expected integer instance IDs on the exported {axes} grid")
if int(labels.min()) < 0 or int(labels.max()) > np.iinfo(np.uint32).max:
    raise ValueError("IDs must fit uint32 with zero as background")
tifffile.imwrite("labels.tif", labels.astype(np.uint32, copy=False),
                 photometric="minisblack", metadata={{"axes": "{axes}"}}, compression="zlib")
```

In the exporting study, select the original T/C/Z grid, choose the handoff or
its manifest under **Import existing labels → μSAM (standalone)**, then select
`labels.tif`. Inspect the overlay before accepting. Record the producer, model
and checkpoint you used. Loci verifies the export binding. Mask provenance
remains user-declared and model validation is unknown.
"""


def _validate_destination(target: Path, project_root: Path) -> tuple[Path, str]:
    if not target.is_absolute():
        raise ValueError("Choose an absent absolute destination folder for the μSAM handoff")
    review_package_label(target.name)
    parent = target.parent
    if not parent.exists() or parent.is_symlink() or any(p.is_symlink() for p in parent.parents):
        raise ValueError("μSAM handoff destination parent must be a canonical plain directory")
    if parent.resolve(strict=True) != parent:
        raise ValueError("μSAM handoff destination parent must be a canonical plain directory")
    canonical_root = project_root.resolve(strict=True)
    if parent == canonical_root or canonical_root in parent.parents or target == canonical_root:
        raise ValueError("Choose a μSAM handoff destination outside the active study folder")
    return parent, target.name


def export_usam_handoff(
    workbench: Workbench,
    source_id: str,
    source_sha256: str,
    selection: dict[str, Any],
    destination: str | Path,
    working_bytes: int = 512 * 1024**2,
) -> dict[str, Any]:
    """Atomically publish a native YX/ZYX raw TIFF handoff bundle and immutable study record."""
    try:
        return _export_usam_handoff(
            workbench, source_id, source_sha256, selection, destination, working_bytes
        )
    except FileExistsError:
        raise
    except sqlite3.Error as exc:
        raise ValueError("Could not record the μSAM export in the local study") from exc
    except OSError as exc:
        raise ValueError(
            "The selected μSAM handoff destination or source is unavailable for export"
        ) from exc


def _verify_pinned_files(directory_fd, streams, artifacts):
    if set(os.listdir(directory_fd)) != set(artifacts):
        raise ValueError("Handoff bundle contains unexpected or missing files")
    for name, stream in streams.items():
        expected = artifacts[name]
        before = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size != expected["size_bytes"]
        ):
            raise ValueError("Handoff artifact size or link count changed")
        stream.seek(0)
        remaining = before.st_size
        digest = hashlib.sha256()
        while remaining:
            chunk = stream.read(min(remaining, 1024**2))
            if not chunk:
                raise ValueError("Handoff artifact was truncated")
            remaining -= len(chunk)
            digest.update(chunk)
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            not os.path.samestat(current, before)
            or current.st_ctime_ns != before.st_ctime_ns
            or digest.hexdigest() != expected["sha256"]
        ):
            raise ValueError("Handoff artifact identity or checksum changed")


def _export_usam_handoff(
    workbench: Workbench,
    source_id: str,
    source_sha256: str,
    selection: dict[str, Any],
    destination: str | Path,
    working_bytes: int = 512 * 1024**2,
) -> dict[str, Any]:
    _capability()
    working_bytes = integer(working_bytes, "working-memory budget", 1024**2, 8 * 1024**3)
    if not isinstance(destination, (str, Path)) or not str(destination).strip():
        raise ValueError("Choose an absent absolute destination folder for the μSAM handoff")
    target = Path(destination)
    parent, basename = _validate_destination(target, workbench.project.root)

    parent_fd = os.open(parent, _DIR_FLAGS)
    stage = ".loci-usam-" + uuid.uuid4().hex
    stage_fd: int | None = None
    cleanup_name = stage
    streams = {}
    handles = ExitStack()
    handles.callback(os.close, parent_fd)
    stage_identity = None
    accepted = False
    try:
        try:
            os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("The μSAM handoff destination already exists")

        binding = _source_binding(
            workbench, source_id, source_sha256, selection, require_original=True
        )
        resolved = binding["selection"]
        session = workbench._session(source_id)
        channel_dtype = np.dtype(session.metadata.channel_dtypes[resolved["c"]])
        if channel_dtype.name not in _NATIVE_DTYPES:
            raise ValueError(
                f"μSAM handoff requires scalar integer or float samples, got {channel_dtype}"
            )

        axes, expected_shape = _native_grid(resolved)
        depth = expected_shape[0] if axes == "ZYX" else 1
        voxels = math.prod(expected_shape)
        raw_bytes = voxels * channel_dtype.itemsize
        # Include page bookkeeping for thin, deep stacks before constructing a TIFF.
        if (
            voxels * 96 + raw_bytes * 2 + depth * 4096 > working_bytes
            or raw_bytes + depth * 512 + 65536 > MAX_ARTIFACT_BYTES
        ):
            raise ValueError(
                "Selected native region exceeds the bounded μSAM handoff memory or artifact limit"
            )

        calibration = _calibration_summary(binding["geometry"])
        array, geometry, loaded_selection = workbench.load_scalar(
            source_id, resolved, strict=True, working_bytes=working_bytes
        )
        if (
            loaded_selection != resolved
            or geometry.to_dict() != binding["geometry"]
            or list(array.shape) != expected_shape
            or array.dtype.kind != channel_dtype.kind
            or array.dtype.itemsize != channel_dtype.itemsize
        ):
            raise ValueError(
                "Loaded native scalar pixels disagree with the verified source binding"
            )
        if array.dtype.kind == "f" and not bool(np.all(np.isfinite(array))):
            raise ValueError("Native source contains non-finite floating-point values")

        contiguous = np.ascontiguousarray(array, dtype=channel_dtype.newbyteorder("="))
        array_sha256 = hashlib.sha256(memoryview(contiguous).cast("B")).hexdigest()

        buffer = io.BytesIO()
        tifffile.imwrite(
            buffer,
            contiguous,
            photometric="minisblack",
            metadata={"axes": axes},
            compression="deflate",
        )
        tiff_bytes = buffer.getvalue()
        if not 1 <= len(tiff_bytes) <= min(MAX_ARTIFACT_BYTES, working_bytes):
            raise ValueError("Encoded μSAM input TIFF exceeds bounded artifact limits")

        with tifffile.TiffFile(io.BytesIO(tiff_bytes)) as tif:
            if (
                len(tif.series) != 1
                or tif.series[0].axes != axes
                or list(tif.series[0].shape) != expected_shape
                or np.dtype(tif.series[0].dtype) != contiguous.dtype
                or len(tif.pages) != depth
                or any(page.samplesperpixel != 1 for page in tif.pages)
            ):
                raise ValueError("Encoded μSAM input TIFF failed lossless structure verification")

        source_record = workbench.project.source(source_id, verify=True)
        source_name = source_record["name"]
        handoff_id = uuid.uuid4().hex
        manifest: dict[str, Any] = {
            "schema": HANDOFF_SCHEMA,
            "handoff_id": handoff_id,
            "export_origin": "verified-loci-native-export",
            "source_id": source_id,
            "source_sha256": source_sha256,
            "source_name": source_name,
            "selection": resolved,
            "measurement_channel": binding["measurement_channel"],
            "geometry": binding["geometry"],
            "calibration": calibration,
            "input": {
                "file_name": "input.tif",
                "file_sha256": hashlib.sha256(tiff_bytes).hexdigest(),
                "file_size_bytes": len(tiff_bytes),
                "array_sha256": array_sha256,
                "dtype": str(contiguous.dtype),
                "shape": expected_shape,
                "axes": axes,
                "compression": "deflate",
                "value_preservation": "exact-original-native-scalar-samples",
            },
            "label_profile": _label_profile(axes, expected_shape),
            "upstream_reference": copy.deepcopy(UPSTREAM_REFERENCE),
            "validation": "not-established",
        }
        manifest["manifest_sha256"] = _digest(manifest)
        validate_usam_handoff_manifest(manifest)
        manifest_bytes = (canonical_json(manifest) + "\n").encode("utf-8")
        if len(manifest_bytes) > MAX_MANIFEST_BYTES:
            raise ValueError("μSAM handoff manifest exceeds its bounded size limit")
        readme_bytes = _readme_text(manifest).encode("utf-8")
        files = {
            "input.tif": tiff_bytes,
            "manifest.json": manifest_bytes,
            "README.md": readme_bytes,
        }

        parent_identity = os.fstat(parent_fd)
        os.mkdir(stage, mode=0o700, dir_fd=parent_fd)
        stage_identity = os.stat(stage, dir_fd=parent_fd, follow_symlinks=False)
        stage_fd = os.open(stage, _DIR_FLAGS, dir_fd=parent_fd)
        handles.callback(os.close, stage_fd)
        if not os.path.samestat(stage_identity, os.fstat(stage_fd)):
            raise ValueError("Handoff staging directory changed before writing")

        for name, data in files.items():
            fd = os.open(
                name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=stage_fd,
            )
            output = handles.enter_context(os.fdopen(fd, "w+b"))
            streams[name] = output
            output.write(data)
            output.flush()
            os.fsync(fd)
        os.fsync(stage_fd)

        artifacts = {name: _file_digest(data) for name, data in files.items()}

        def check_directory(name: str) -> None:
            if (
                parent.resolve(strict=True) != parent
                or not os.path.samestat(parent_identity, parent.lstat())
                or not os.path.samestat(
                    stage_identity, os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                )
            ):
                raise ValueError("μSAM handoff publication directory identity changed")

        # The local record becomes visible only after the directory is published and synced.
        with workbench.project.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = _source_binding(
                workbench, source_id, source_sha256, resolved, require_original=True
            )
            if canonical_json(current) != canonical_json(binding):
                raise ValueError("Source grid or channel declaration changed during μSAM export")
            local_id = workbench.project.meta["project_id"]
            project_meta = connection.execute(
                "SELECT value FROM metadata WHERE key='project'"
            ).fetchone()
            if parse_json(project_meta[0])["project_id"] != local_id:
                raise ValueError("Local study identity changed during μSAM export")
            selected = binding["channel_metadata"]["channels"][resolved["c"]]
            check_directory(stage)
            _verify_pinned_files(stage_fd, streams, artifacts)
            _rename_noreplace(stage, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            cleanup_name = basename
            os.fsync(parent_fd)
            check_directory(basename)
            _verify_pinned_files(stage_fd, streams, artifacts)
            workbench._session(source_id).verify_strict()
            check_directory(basename)
            connection.execute(
                "INSERT INTO metadata(key,value) VALUES(?,?)",
                (
                    _LOCAL_PREFIX + handoff_id,
                    canonical_json(
                        {
                            "project_id": local_id,
                            "manifest": manifest,
                            "channel_sha256": _digest(selected),
                        }
                    ),
                ),
            )
        accepted = True
    finally:
        try:
            if stage_identity is not None and not accepted:
                with suppress(FileNotFoundError):
                    current = os.stat(cleanup_name, dir_fd=parent_fd, follow_symlinks=False)
                    if os.path.samestat(stage_identity, current):
                        for name, stream in streams.items():
                            with suppress(FileNotFoundError):
                                entry = os.stat(name, dir_fd=stage_fd, follow_symlinks=False)
                                if os.path.samestat(os.fstat(stream.fileno()), entry):
                                    os.unlink(name, dir_fd=stage_fd)
                        if (stage_fd is None or not os.listdir(stage_fd)) and os.path.samestat(
                            current, os.stat(cleanup_name, dir_fd=parent_fd, follow_symlinks=False)
                        ):
                            os.rmdir(cleanup_name, dir_fd=parent_fd)
                        os.fsync(parent_fd)
        finally:
            handles.close()
    return {
        "schema": HANDOFF_RECEIPT_SCHEMA,
        "basename": basename,
        "handoff_id": handoff_id,
        "manifest_sha256": manifest["manifest_sha256"],
        "export_origin": manifest["export_origin"],
        "source_id": source_id,
        "source_sha256": source_sha256,
        "selection": resolved,
        "measurement_channel": binding["measurement_channel"],
        "geometry": binding["geometry"],
        "calibration": calibration,
        "input": manifest["input"],
        "label_profile": manifest["label_profile"],
        "validation": "not-established",
        "artifacts": artifacts,
    }


def list_usam_handoffs(workbench: Workbench) -> list[dict[str, Any]]:
    """Return immutable path-free μSAM handoffs recorded in this study, newest first."""
    with workbench.project.connection() as connection:
        return [
            _local_record(workbench, key, raw)["manifest"]
            for key, raw in connection.execute(
                "SELECT key,value FROM metadata WHERE key GLOB ? ORDER BY rowid DESC",
                (_LOCAL_PREFIX + "*",),
            )
        ]


def _local_record(workbench, key, raw):
    if not isinstance(raw, str) or len(raw) > MAX_MANIFEST_BYTES + 512:
        raise ValueError("Stored μSAM handoff exceeds the local record limit")
    try:
        record = parse_json(raw)
    except RecursionError as exc:
        raise ValueError("Invalid nested local handoff record") from exc
    if (
        not isinstance(record, dict)
        or set(record) != {"manifest", "project_id", "channel_sha256"}
        or record["project_id"] != workbench.project.meta["project_id"]
        or not isinstance(record["channel_sha256"], str)
        or not SHA_PATTERN.fullmatch(record["channel_sha256"])
    ):
        raise ValueError("Stored μSAM handoff identity is invalid")
    manifest = validate_usam_handoff_manifest(record["manifest"])
    if key != _LOCAL_PREFIX + manifest["handoff_id"]:
        raise ValueError("Stored μSAM handoff ID disagrees with its manifest")
    return record


def _study_handoff_document(workbench, handoff_id, binding):
    key = _LOCAL_PREFIX + checked_id(handoff_id)
    with workbench.project.connection() as connection:
        row = connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    record = _local_record(workbench, key, row[0])
    manifest = record["manifest"]
    _assert_matches_live_binding(manifest, binding)
    selected = binding["channel_metadata"]["channels"][binding["selection"]["c"]]
    if record["channel_sha256"] != _digest(selected):
        raise ValueError("Selected channel declaration no longer matches the exported μSAM handoff")
    return manifest


def _handoff_binding_record(manifest: dict[str, Any], binding_source: str) -> dict[str, Any]:
    return {
        "schema": HANDOFF_BINDING_SCHEMA,
        "handoff_id": manifest["handoff_id"],
        "manifest_sha256": manifest["manifest_sha256"],
        "export_identity_basis": "verified-loci-study-handoff",
        "binding_source": binding_source,
        "exported_input_file_sha256": manifest["input"]["file_sha256"],
        "exported_input_array_sha256": manifest["input"]["array_sha256"],
        "exported_input_dtype": manifest["input"]["dtype"],
        "exported_input_shape": copy.deepcopy(manifest["input"]["shape"]),
        "exported_input_axes": manifest["input"]["axes"],
        "mask_origin_verified_by_loci": False,
        "model_validation": "unknown",
    }


def validate_historical_return(result: dict[str, Any], external: dict[str, Any]) -> None:
    """Check portable evidence without consulting or creating local authority."""
    from .research_labels_import import validate_producer

    record = external["handoff"]
    if not isinstance(record, dict):
        raise ValueError("Invalid historical μSAM handoff binding")
    _bounded_manifest(external)
    checked_id(record.get("handoff_id"))
    for key in ("manifest_sha256", "exported_input_file_sha256", "exported_input_array_sha256"):
        if not isinstance(record.get(key), str) or not SHA_PATTERN.fullmatch(record[key]):
            raise ValueError("Invalid historical μSAM handoff digest")
    dtype = record.get("exported_input_dtype")
    if not isinstance(dtype, str) or dtype not in _NATIVE_DTYPES:
        raise ValueError("Invalid historical μSAM input dtype")
    selection = external.get("source_selection")
    axes, shape = _native_grid(selection)
    geometry = external.get("source_geometry")
    _calibration_summary(geometry)
    _check_measurement_channel(external.get("measurement_channel"), selection["c"])
    profile = _label_profile(axes, shape)
    if (
        external.get("schema") != "loci.external-labels/v1"
        or external.get("profile") != profile["profile"]
        or external.get("alignment") != profile["alignment"]
        or external.get("format") != "TIFF"
        or external.get("original_dtype") not in profile["allowed_dtypes"]
        or external.get("canonical_dtype") != "uint32"
        or axes != external.get("axes")
        or geometry["axes"] != axes
        or canonical_json(shape) != canonical_json(external.get("shape"))
        or external.get("source_sha256") != result["source_sha256"]
        or record.get("binding_source") not in ("manifest-and-study-handoff", "study-handoff-id")
    ):
        raise ValueError("Invalid historical μSAM handoff grid or origin")
    if (
        set(record)
        != {
            "schema",
            "handoff_id",
            "manifest_sha256",
            "export_identity_basis",
            "binding_source",
            "exported_input_file_sha256",
            "exported_input_array_sha256",
            "exported_input_dtype",
            "exported_input_shape",
            "exported_input_axes",
            "mask_origin_verified_by_loci",
            "model_validation",
        }
        or record["schema"] != HANDOFF_BINDING_SCHEMA
        or record["export_identity_basis"] != "verified-loci-study-handoff"
        or record["exported_input_axes"] != axes
        or canonical_json(record["exported_input_shape"]) != canonical_json(shape)
        or record["mask_origin_verified_by_loci"] is not False
        or record["model_validation"] != "unknown"
    ):
        raise ValueError("Historical μSAM handoff binding is inconsistent")
    if result["kind"] == "external-labels":
        image = result["arrays"].get("image", {})
        if (
            image.get("shape") != shape
            or image.get("dtype") != dtype
            or canonical_json(geometry) != canonical_json(result["provenance"].get("geometry"))
            or canonical_json(selection) != canonical_json(result["provenance"].get("selection"))
        ):
            raise ValueError("Historical μSAM return disagrees with the measured input")
    _validate_no_path_text(checked_text(external.get("file_name"), "External label filename"))
    validate_producer(external.get("producer"))
    basis = "user-declared" if external.get("producer") else "unknown"
    if (
        external.get("mask_origin_basis") != basis
        or external.get("producer_identity_basis") != basis
        or external.get("upstream_validation") != "unknown"
        or any(
            external.get(key) is not None
            for key in ("upstream_model", "upstream_runtime", "upstream_settings")
        )
    ):
        raise ValueError("Invalid historical μSAM mask origin or validation")

    # Historical provenance may be supplied by a portable archive. Only the
    # fixed schema/profile identifiers may contain a slash in this record.
    identifiers = {
        HANDOFF_BINDING_SCHEMA,
        "loci.external-labels/v1",
        profile["profile"],
    }
    pending = [external]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if any(
                key.startswith("private_")
                or key.endswith(("_locator", "_path"))
                or key in ("path", "locator")
                for key in item
            ):
                raise ValueError("Historical μSAM provenance contains a private locator")
            for key in item:
                _validate_no_path_text(key)
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, str) and item not in identifiers:
            _validate_no_path_text(item)


def _assert_matches_live_binding(manifest: dict[str, Any], binding: dict[str, Any]) -> None:
    if (
        manifest["source_id"] != binding["source_id"]
        or manifest["source_sha256"] != binding["source_sha256"]
    ):
        raise ValueError(
            "This μSAM handoff belongs to a different source; switch to the original exported "
            "source or use unbound external label import"
        )
    if canonical_json(manifest["selection"]) != canonical_json(binding["selection"]):
        raise ValueError(
            "This μSAM handoff belongs to a different native plane or Z range; select the exact "
            "exported T/C/Z range or use unbound external label import"
        )
    if canonical_json(manifest["measurement_channel"]) != canonical_json(
        binding["measurement_channel"]
    ):
        raise ValueError("Selected measurement channel no longer matches the exported μSAM handoff")
    if canonical_json(manifest["geometry"]) != canonical_json(binding["geometry"]):
        raise ValueError(
            "Source geometry or calibration no longer matches the exported μSAM handoff"
        )


def resolve_verified_handoff(
    workbench: Workbench,
    binding: dict[str, Any],
    *,
    handoff_id: str | None = None,
    manifest_path: str | None = None,
) -> dict[str, Any]:
    """Verify a μSAM handoff reference against the study and live native source selection."""
    if handoff_id is None and manifest_path is None:
        raise ValueError("Provide a μSAM handoff ID or manifest path")
    if handoff_id is not None and (
        not isinstance(handoff_id, str) or not ID_PATTERN.fullmatch(handoff_id)
    ):
        raise ValueError("μSAM handoff ID must be a 32-character hexadecimal identifier")

    if manifest_path is not None:
        if not isinstance(manifest_path, str):
            raise ValueError("Select a plain handoff manifest file")
        manifest_file = Path(manifest_path)
        identity = _identity(manifest_file)
        if not 1 <= identity[2] <= MAX_MANIFEST_BYTES:
            raise ValueError("μSAM handoff manifest size is out of bounds")
        with os.fdopen(os.open(manifest_file, _READ_FLAGS | os.O_NONBLOCK), "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
                != identity
            ):
                raise ValueError("μSAM handoff manifest changed during verification")
            raw = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(raw) != identity[2]:
            raise ValueError("μSAM handoff manifest changed during verification")
        if _identity(manifest_file) != identity:
            raise ValueError("μSAM handoff manifest changed during verification")
        try:
            manifest = validate_usam_handoff_manifest(parse_json(raw.decode("utf-8")))
        except RecursionError as exc:
            raise ValueError("Invalid nested μSAM handoff manifest") from exc
        if handoff_id is not None and handoff_id != manifest["handoff_id"]:
            raise ValueError("μSAM handoff ID disagrees with the selected manifest")
        stored = _study_handoff_document(workbench, manifest["handoff_id"], binding)
        if stored is None or canonical_json(stored) != canonical_json(manifest):
            raise ValueError(
                "Selected μSAM handoff manifest does not match an immutable handoff "
                "exported from this study"
            )
        binding_source = "manifest-and-study-handoff"
    else:
        assert handoff_id is not None
        stored = _study_handoff_document(workbench, handoff_id, binding)
        if stored is None:
            raise ValueError("Selected μSAM handoff reference was not found in this study")
        manifest = stored
        binding_source = "study-handoff-id"

    return _handoff_binding_record(manifest, binding_source)


def verify_bound_handoff_current(
    workbench: Workbench,
    binding: dict[str, Any],
    handoff_binding: Any,
) -> None:
    """Re-verify an already resolved handoff binding before measurement or publication."""
    if (
        not isinstance(handoff_binding, dict)
        or handoff_binding.get("schema") != HANDOFF_BINDING_SCHEMA
    ):
        raise ValueError("Bound μSAM handoff provenance is invalid")
    stored = _study_handoff_document(workbench, handoff_binding.get("handoff_id", ""), binding)
    if stored is None:
        raise ValueError("Bound μSAM handoff reference is missing from the study")
    binding_source = handoff_binding.get("binding_source")
    if binding_source not in ("manifest-and-study-handoff", "study-handoff-id"):
        raise ValueError("Bound μSAM handoff source is invalid")
    expected = _handoff_binding_record(stored, binding_source)
    if canonical_json(handoff_binding) != canonical_json(expected):
        raise ValueError("Bound μSAM handoff identity changed after preview")
