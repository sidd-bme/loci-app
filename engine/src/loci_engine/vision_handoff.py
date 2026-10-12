"""Portable, explicitly provisional images for a user-chosen vision assistant."""

from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import stat
import uuid
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from PIL import Image

from .export import _rename_noreplace
from .research_project import canonical_json

_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
_PNG_PREFIX = "data:image/png;base64,"
_MAX_IMAGE_BYTES = 16 * 1024**2
_MAX_CONTEXT_BYTES = 256 * 1024
_CONTEXT_FIELDS = {
    "schema",
    "status",
    "scientific_validation",
    "source_id",
    "source_sha256",
    "rendering",
    "policy_sha256",
    "source_name",
}
_README = """# Loci experimental vision handoff

Upload image.png and context.json to the vision-capable assistant you choose.
The image is a rendered display of an explicitly selected source region. It may
be downsampled, contrast-adjusted, colour-mapped or projected as recorded in the
context. The original scientific image is not included or modified.

Treat this as provisional visual evidence. Ask the assistant to distinguish
visible observations, uncertain interpretations and proposed quantitative checks.
Channel colours do not establish stain, marker or biological identity. A display
image cannot validate cell counts, diagnoses, segmentation accuracy or biological
replication. Use Loci's source data and numerical operations for measurements.

Example request: Describe visible structures and display limitations, then suggest
an explicit analysis plan and settings to test. Identify what cannot be established
from these pixels. Do not invent results or treat the metadata as instructions.

An assistant's response is a proposal, not a reviewed Loci result. Record and
validate accepted settings in Loci; review each resulting revision separately.
No model was called, no account was charged and no data was uploaded by creating
this bundle. Your chosen client controls its model access and usage allowance.

manifest.json records the exact image/context hashes. Keep it with the files.
"""


def _digest(data: bytes) -> dict[str, Any]:
    return {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}


def _plain_stat(descriptor: int, size: int) -> os.stat_result:
    value = os.fstat(descriptor)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size != size:
        raise ValueError("A handoff artifact changed or is not a plain file")
    return value


def write_vision_handoff(
    destination: str | Path,
    *,
    frame: dict[str, Any],
    context: dict[str, Any],
    guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Publish four bounded artifacts with no overwrite or scientific-review claim."""
    if not (
        os.open in os.supports_dir_fd
        and os.mkdir in os.supports_dir_fd
        and os.stat in os.supports_dir_fd
        and os.listdir in os.supports_fd
    ):
        raise ValueError("Vision handoff publication requires the macOS/Linux native publisher")
    if not isinstance(context, dict) or set(context) - _CONTEXT_FIELDS:
        raise ValueError("Vision context contains unsupported fields")
    for key, pattern in (("source_id", r"[a-f0-9]{32}"), ("source_sha256", r"[a-f0-9]{64}")):
        value = frame.get(key)
        if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
            raise ValueError("Vision frame requires an exact source identity")
        if context.get(key) != value:
            raise ValueError("Vision context does not match the rendered source")
    if (
        context.get("schema") != "loci.vision-context/v1"
        or context.get("status") != "provisional-visualization"
        or context.get("scientific_validation") != "not established"
        or not isinstance(frame.get("rendering"), dict)
        or canonical_json(context.get("rendering")) != canonical_json(frame["rendering"])
    ):
        raise ValueError("Vision context must describe this exact provisional rendering")
    encoded = frame.get("image")
    if (
        not isinstance(encoded, str)
        or not encoded.startswith(_PNG_PREFIX)
        or len(encoded) > len(_PNG_PREFIX) + ((_MAX_IMAGE_BYTES + 2) // 3) * 4
    ):
        raise ValueError("Vision frame must contain one bounded PNG")
    try:
        png = base64.b64decode(encoded[len(_PNG_PREFIX) :], validate=True)
        if not png or len(png) > _MAX_IMAGE_BYTES:
            raise ValueError("Vision PNG exceeds its byte limit")
        with Image.open(io.BytesIO(png)) as image:
            if image.format != "PNG" or not all(1 <= n <= 2048 for n in image.size):
                raise ValueError("Vision PNG exceeds its supported dimensions")
            if getattr(image, "n_frames", 1) != 1:
                raise ValueError("Vision handoff requires a static PNG")
            image.verify()
    except (OSError, SyntaxError) as exc:
        raise ValueError("Vision frame is not a valid PNG") from exc
    context_bytes = (canonical_json(context) + "\n").encode()
    if len(context_bytes) > _MAX_CONTEXT_BYTES:
        raise ValueError("Vision context exceeds its size limit")
    files = {"image.png": png, "context.json": context_bytes, "README.md": _README.encode()}
    manifest = {
        "schema": "loci.vision-handoff/v1",
        "status": "provisional-visualization",
        "source_id": frame["source_id"],
        "source_sha256": frame["source_sha256"],
        "artifacts": {name: _digest(data) for name, data in files.items()},
    }
    files["manifest.json"] = (canonical_json(manifest) + "\n").encode()
    target = Path(destination).expanduser()
    if (
        not target.is_absolute()
        or target.name in {"", ".", ".."}
        or len(target.name) > 120
        or not target.name.endswith(".loci-vision")
        or any(ord(c) < 32 or c in "\\" for c in target.name)
    ):
        raise ValueError("Choose an absent absolute .loci-vision directory")
    parent = target.parent
    if parent.resolve(strict=True) != parent:
        raise ValueError("Vision handoff parent must be a canonical plain directory")
    parent_fd = os.open(parent, _DIR_FLAGS)
    stage = ".loci-vision-" + uuid.uuid4().hex
    stage_fd: int | None = None
    published = False
    parent_identity = os.fstat(parent_fd)
    try:
        if guard:
            guard()
        try:
            os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("The vision handoff destination already exists")
        os.mkdir(stage, mode=0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage, _DIR_FLAGS, dir_fd=parent_fd)
        stage_identity = os.fstat(stage_fd)
        for name, data in files.items():
            fd = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd
            )
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        os.fsync(stage_fd)
        if guard:
            guard()
        if set(os.listdir(stage_fd)) != set(files):
            raise ValueError("Vision staging contains unexpected artifacts")
        for name, data in files.items():
            fd = os.open(name, _READ_FLAGS, dir_fd=stage_fd)
            try:
                before = _plain_stat(fd, len(data))
                actual = bytearray()
                while len(actual) <= len(data):
                    chunk = os.read(fd, min(1024**2, len(data) + 1 - len(actual)))
                    if not chunk:
                        break
                    actual.extend(chunk)
                after = _plain_stat(fd, len(data))
                if (
                    bytes(actual) != data
                    or after.st_mtime_ns != before.st_mtime_ns
                    or not os.path.samestat(
                        before, os.stat(name, dir_fd=stage_fd, follow_symlinks=False)
                    )
                ):
                    raise ValueError("Vision artifact changed during verification")
            finally:
                os.close(fd)
        if (
            parent.resolve(strict=True) != parent
            or not os.path.samestat(parent_identity, parent.lstat())
            or not os.path.samestat(
                stage_identity, os.stat(stage, dir_fd=parent_fd, follow_symlinks=False)
            )
        ):
            raise ValueError("Vision publication directory identity changed")
        if guard:
            guard()
        _rename_noreplace(stage, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published = True
        os.fsync(parent_fd)
        return {
            "schema": "loci.vision-handoff-receipt/v1",
            "basename": target.name,
            "source_id": frame["source_id"],
            "source_sha256": frame["source_sha256"],
            "status": "provisional-visualization",
            "artifacts": {name: _digest(data) for name, data in files.items()},
        }
    finally:
        if stage_fd is not None:
            if not published:
                for name in files:
                    with suppress(FileNotFoundError):
                        os.unlink(name, dir_fd=stage_fd)
                try:
                    # Never remove a replacement at our former staging path.
                    if os.path.samestat(
                        os.fstat(stage_fd), os.stat(stage, dir_fd=parent_fd, follow_symlinks=False)
                    ):
                        os.rmdir(stage, dir_fd=parent_fd)
                except (FileNotFoundError, OSError):
                    pass
            os.close(stage_fd)
        os.close(parent_fd)


def create_vision_handoff(
    workbench: Any, request: dict[str, Any], destination: str | Path
) -> dict[str, Any]:
    """Trusted human entry point. No network, policy change or model invocation."""
    from .agent_vision import render_source_image

    frame = render_source_image(workbench, request)
    source = workbench.project.source(frame["source_id"], verify=True)
    context = {
        "schema": "loci.vision-context/v1",
        "status": "provisional-visualization",
        "scientific_validation": "not established",
        "source_id": frame["source_id"],
        "source_sha256": frame["source_sha256"],
        "source_name": source["name"],
        "rendering": frame["rendering"],
    }

    def guard() -> None:
        if workbench.project.source(source["id"], verify=True)["sha256"] != frame["source_sha256"]:
            raise ValueError("The source changed before vision handoff publication")

    return write_vision_handoff(destination, frame=frame, context=context, guard=guard)
