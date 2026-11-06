"""Exact PUMA import for trusted native callers; no model execution.

Native callers supply picker-selected absolute files, a configured model root
and live authority/cancellation guard. Never expose these as renderer/MCP path
authority. Desktop currently sets LOCI_MODEL_HOME to userData/models; this library
requires that trusted caller-root explicitly and supplies no independent default.

A hard-linked small manifest atomically publishes both files without overwrite.
The receipt is opaque exact bytes, never code, permission or scientific approval.
No Torch import, download, public distribution or unrelated cache mutation.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from collections.abc import Callable
from contextlib import ExitStack, contextmanager, suppress
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import TYPE_CHECKING

from .tissue_model_profiles import (
    PUMA_CONVERSION_RECEIPT_SHA256,
    PUMA_PROFILE_ID,
    PUMA_WEIGHTS_BYTES,
    PUMA_WEIGHTS_SHA256,
    puma_profile,
)

if TYPE_CHECKING:
    from .puma_backend import ApprovedPumaWeights

Check = Callable[[], None]
NAMESPACE = "puma-tissue-store-v1"
WEIGHTS_NAME = "network_weights.pth"
RECEIPT_NAME = "conversion-receipt.json"
PUBLICATION_NAME = ".publication.json"
CONVERSION_RECEIPT_BYTES = 150_198
CHUNK_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 4096
_ENTRY = re.compile(r"entry-[0-9a-f]{32}\Z")


class TissueModelStoreError(ValueError):
    """Invalid file/cache identity; never execution authority."""


class _GuardFailure(BaseException):
    def __init__(self, original):
        self.original = original


def _public(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except _GuardFailure as failure:
            raise failure.original from None

    return call


def _check(check):
    if not callable(check):
        raise TissueModelStoreError("A trusted live authority/cancellation guard is required")
    try:
        check()
    except BaseException as exc:
        # PermissionError and other OSError subclasses from a live authority
        # check must propagate, never become an invalid/missing cache status.
        raise _GuardFailure(exc) from exc


def _path(value, *, allow_root=False):
    if not isinstance(value, (str, Path)) or not str(value):
        raise TissueModelStoreError("A trusted absolute local path is required")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or (path == Path("/") and not allow_root):
        raise TissueModelStoreError("An explicit absolute path without traversal is required")
    return path


def _inode(value):
    return value.st_dev, value.st_ino


def _identity(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
        value.st_nlink,
    )


def _private(value):
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid() or value.st_mode & 0o022:
        raise TissueModelStoreError(
            "Managed directory must be owned and privately writable by this user"
        )


def _flags(*, directory=False, write=False):
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise TissueModelStoreError("Host lacks required anchored filesystem operations")
    flags = os.O_CLOEXEC | os.O_NOFOLLOW
    if directory:
        return flags | os.O_RDONLY | os.O_DIRECTORY
    if write:
        return flags | os.O_WRONLY | os.O_CREAT | os.O_EXCL
    return flags | os.O_RDONLY | os.O_NONBLOCK


@dataclass
class _Anchor:
    descriptors: list[int]
    links: list[tuple[int, str, int, tuple[int, int]]]

    @property
    def fd(self):
        return self.descriptors[-1]

    def child(self, name, *, create=False, private=True):
        parent = self.fd
        if create:
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode):
            raise TissueModelStoreError("Path contains a link or non-directory")
        descriptor = os.open(name, _flags(directory=True), dir_fd=parent)
        try:
            current = os.fstat(descriptor)
            if _inode(current) != _inode(before):
                raise TissueModelStoreError("Directory was replaced during open")
            if private:
                _private(current)
        except BaseException:
            os.close(descriptor)
            raise
        self.descriptors.append(descriptor)
        self.links.append((parent, name, descriptor, _inode(current)))
        return descriptor

    def verify(self):
        for parent, name, descriptor, identity in self.links:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (
                not stat.S_ISDIR(current.st_mode)
                or _inode(current) != identity
                or _inode(os.fstat(descriptor)) != identity
            ):
                raise TissueModelStoreError("Directory identity changed during operation")

    def close(self):
        for descriptor in reversed(self.descriptors):
            os.close(descriptor)


@contextmanager
def _directory(path, *, create_leaf=False, private_leaf=False):
    path = _path(path, allow_root=True)
    anchor = _Anchor([os.open("/", _flags(directory=True))], [])
    try:
        parts = path.parts[1:]
        for index, name in enumerate(parts):
            leaf = index == len(parts) - 1
            anchor.child(name, create=create_leaf and leaf, private=private_leaf and leaf)
        anchor.verify()
        yield anchor
    finally:
        anchor.close()


@contextmanager
def _file(parent, name, *, expected_bytes):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or before.st_size != expected_bytes:
        raise TissueModelStoreError("Expected an exact-size regular artifact, not a link")
    descriptor = os.open(name, _flags(), dir_fd=parent)
    try:
        identity = _identity(os.fstat(descriptor))
        if identity != _identity(before):
            raise TissueModelStoreError("Artifact was replaced during open")
        yield descriptor, identity
        if (
            _identity(os.fstat(descriptor)) != identity
            or _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity
        ):
            raise TissueModelStoreError("Artifact identity changed during operation")
    finally:
        os.close(descriptor)


def _write(descriptor, data):
    remaining = memoryview(data)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise TissueModelStoreError("Managed copy did not complete")
        remaining = remaining[written:]


def _stream(descriptor, *, expected_bytes, expected_hash, check, destination=None):
    digest, count = hashlib.sha256(), 0
    while True:
        _check(check)
        chunk = os.read(descriptor, min(CHUNK_BYTES, expected_bytes - count + 1))
        if not chunk:
            break
        count += len(chunk)
        if count > expected_bytes:
            raise TissueModelStoreError("Artifact exceeded exact byte bound")
        digest.update(chunk)
        if destination is not None:
            _write(destination, chunk)
    _check(check)
    if count != expected_bytes or digest.hexdigest() != expected_hash:
        raise TissueModelStoreError("Artifact differs from code-owned exact SHA-256 and size")


def _marker_name():
    return PUMA_WEIGHTS_SHA256 + ".json"


def _manifest(entry):
    return {
        "schema": "loci.puma-managed-files/v1",
        "profile_id": PUMA_PROFILE_ID,
        "entry": entry,
        "weights_sha256": PUMA_WEIGHTS_SHA256,
        "weights_bytes": PUMA_WEIGHTS_BYTES,
        "conversion_receipt_sha256": PUMA_CONVERSION_RECEIPT_SHA256,
        "conversion_receipt_bytes": CONVERSION_RECEIPT_BYTES,
        "verification_scope": "exact-file-identities-only",
        "execution_authority": False,
    }


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def _read_marker(parent):
    name = _marker_name()
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not 1 <= info.st_size <= MAX_MANIFEST_BYTES:
        raise TissueModelStoreError("Managed manifest exceeds bounded size")
    with _file(parent, name, expected_bytes=info.st_size) as (descriptor, identity):
        data = bytearray()
        while chunk := os.read(descriptor, MAX_MANIFEST_BYTES + 1 - len(data)):
            data.extend(chunk)
            if len(data) > MAX_MANIFEST_BYTES:
                raise TissueModelStoreError("Managed manifest exceeds bounded size")
        try:
            value = json.loads(data)
        except (ValueError, UnicodeError) as exc:
            raise TissueModelStoreError("Managed manifest is invalid") from exc
        entry = value.get("entry") if type(value) is dict else None
        if (
            type(entry) is not str
            or not _ENTRY.fullmatch(entry)
            or data != _encoded(_manifest(entry))
        ):
            raise TissueModelStoreError("Managed manifest differs from code-owned contract")
    return entry, identity


def _verified_entry(anchor, *, check, verify):
    parent = anchor.fd
    _check(check)
    entry, marker_identity = _read_marker(parent)
    entry_fd = anchor.child(entry)
    # Keep both descriptors and identities alive until the final pair/marker
    # check, so replacing weights while the receipt is read cannot pass.
    with ExitStack() as stack:
        for name, size, digest in (
            (WEIGHTS_NAME, PUMA_WEIGHTS_BYTES, PUMA_WEIGHTS_SHA256),
            (RECEIPT_NAME, CONVERSION_RECEIPT_BYTES, PUMA_CONVERSION_RECEIPT_SHA256),
        ):
            _check(check)
            descriptor, _ = stack.enter_context(_file(entry_fd, name, expected_bytes=size))
            if verify:
                _stream(descriptor, expected_bytes=size, expected_hash=digest, check=check)
        _check(check)
        anchor.verify()
        if _read_marker(parent) != (entry, marker_identity):
            raise TissueModelStoreError("Managed publication changed during verification")
    return entry


def _status(state):
    return {
        "schema": "loci.puma-store-status/v1",
        "profile_id": PUMA_PROFILE_ID,
        "profile_contract_sha256": puma_profile()["contract_sha256"],
        "weights_sha256": PUMA_WEIGHTS_SHA256,
        "weights_bytes": PUMA_WEIGHTS_BYTES,
        "conversion_receipt_sha256": PUMA_CONVERSION_RECEIPT_SHA256,
        "conversion_receipt_bytes": CONVERSION_RECEIPT_BYTES,
        "state": state,
        "provisioned": state in {"provisioned-unverified", "verified"},
        "files_verified": state == "verified",
        "runtime_compatibility": "not-established",
        "scientific_qualification": "not-established",
        "model_execution_performed": False,
        "execution_authority": False,
    }


def _inspect(cache_root, *, check, verify):
    _check(check)
    if type(verify) is not bool:
        raise TissueModelStoreError("Verification mode must be explicit boolean")
    root = _path(cache_root)
    try:
        with _directory(root, private_leaf=True) as anchor:
            anchor.child(NAMESPACE)
            os.stat(_marker_name(), dir_fd=anchor.fd, follow_symlinks=False)
            try:
                _verified_entry(anchor, check=check, verify=verify)
            except FileNotFoundError:
                return _status("invalid")
        return _status("verified" if verify else "provisioned-unverified")
    except FileNotFoundError:
        return _status("missing")
    except (OSError, TissueModelStoreError):
        return _status("invalid")


@_public
def inspect_store(cache_root, *, check: Check, verify=False):
    """Path-free status; metadata-only status never returns approved weights."""
    return _inspect(cache_root, check=check, verify=verify)


@_public
def resolve_approved_weights(cache_root, *, check: Check) -> ApprovedPumaWeights:
    """Internal path-bearing value after hashing both files. Backend rechecks at use.

    Cache integrity does not supply source grants, runtime rights, inference
    permission or scientific approval. Never serialize this value to a renderer.
    """
    _check(check)
    root = _path(cache_root)
    from .puma_backend import ApprovedPumaWeights

    try:
        with _directory(root, private_leaf=True) as anchor:
            anchor.child(NAMESPACE)
            entry = _verified_entry(anchor, check=check, verify=True)
            anchor.verify()
            return ApprovedPumaWeights(
                root / NAMESPACE / entry / WEIGHTS_NAME, PUMA_WEIGHTS_SHA256, PUMA_WEIGHTS_BYTES
            )
    except OSError:
        raise TissueModelStoreError("Exact managed PUMA files are unavailable") from None


def _cleanup_owned(parent, entry, entry_fd, entry_identity, files):
    """Never sweep caches or delete replacements/foreign names."""
    with suppress(OSError):
        os.fchmod(entry_fd, 0o700)
    for name, identity in files.items():
        with suppress(OSError):
            if _inode(os.stat(name, dir_fd=entry_fd, follow_symlinks=False)) == identity:
                os.unlink(name, dir_fd=entry_fd)
    with suppress(OSError):
        if _inode(os.stat(entry, dir_fd=parent, follow_symlinks=False)) == entry_identity:
            os.rmdir(entry, dir_fd=parent)
    with suppress(OSError):
        os.fsync(parent)


def _copy_selected(source, destination_fd, name, size, digest, check, files):
    with (
        _directory(source.parent) as anchor,
        _file(anchor.fd, source.name, expected_bytes=size) as (input_fd, _),
    ):
        output_fd = os.open(name, _flags(write=True), 0o600, dir_fd=destination_fd)
        files[name] = _inode(os.fstat(output_fd))
        try:
            _stream(
                input_fd,
                expected_bytes=size,
                expected_hash=digest,
                check=check,
                destination=output_fd,
            )
            os.fsync(output_fd)
            os.fchmod(output_fd, 0o400)
        finally:
            os.close(output_fd)
        _check(check)
        anchor.verify()


@_public
def import_puma_weights(source_path, receipt_path, *, cache_root, check: Check):
    """Import exact native-selected files; preserve existing valid or invalid entries.

    Cancellation through the final publication check rolls back our new marker.
    A cancellation after this function returns follows completed import. Existing
    valid content is reused; invalid content is refused without overwrite.
    Only this call's owned temporary identities are cleaned on failure/cancel.
    """
    _check(check)
    source, receipt, root = map(_path, (source_path, receipt_path, cache_root))
    try:
        with _directory(root, create_leaf=True, private_leaf=True) as anchor:
            parent = anchor.child(NAMESPACE, create=True)
            entry = "entry-" + uuid.uuid4().hex
            os.mkdir(entry, mode=0o700, dir_fd=parent)
            before = os.stat(entry, dir_fd=parent, follow_symlinks=False)
            entry_fd = os.open(entry, _flags(directory=True), dir_fd=parent)
            entry_identity = _inode(os.fstat(entry_fd))
            owned_entry = entry_identity == _inode(before)
            files, committed, marker_identity = {}, False, None
            try:
                if not owned_entry:
                    raise TissueModelStoreError("Owned staging directory was replaced")
                _private(os.fstat(entry_fd))
                for path, name, size, digest in (
                    (source, WEIGHTS_NAME, PUMA_WEIGHTS_BYTES, PUMA_WEIGHTS_SHA256),
                    (
                        receipt,
                        RECEIPT_NAME,
                        CONVERSION_RECEIPT_BYTES,
                        PUMA_CONVERSION_RECEIPT_SHA256,
                    ),
                ):
                    _check(check)
                    anchor.verify()
                    _copy_selected(path, entry_fd, name, size, digest, check, files)
                marker_fd = os.open(PUBLICATION_NAME, _flags(write=True), 0o600, dir_fd=entry_fd)
                marker_identity = _inode(os.fstat(marker_fd))
                files[PUBLICATION_NAME] = marker_identity
                try:
                    _write(marker_fd, _encoded(_manifest(entry)))
                    os.fsync(marker_fd)
                    os.fchmod(marker_fd, 0o400)
                finally:
                    os.close(marker_fd)
                os.fsync(entry_fd)
                os.fchmod(entry_fd, 0o500)
                _check(check)
                anchor.verify()
                if _inode(os.stat(entry, dir_fd=parent, follow_symlinks=False)) != entry_identity:
                    raise TissueModelStoreError("Owned staging directory was replaced")
                try:
                    # Atomic creation refuses an existing destination, unlike
                    # rename/replace of an empty directory. No partial pair.
                    os.link(
                        PUBLICATION_NAME,
                        _marker_name(),
                        src_dir_fd=entry_fd,
                        dst_dir_fd=parent,
                        follow_symlinks=False,
                    )
                    committed = True
                    os.fsync(parent)
                    _check(check)
                    anchor.verify()
                except FileExistsError:
                    status = _inspect(root, check=check, verify=True)
                    if not status["files_verified"]:
                        raise TissueModelStoreError(
                            "Existing managed PUMA entry is invalid"
                        ) from None
                    return status
                status = _inspect(root, check=check, verify=True)
                if not status["files_verified"]:
                    raise TissueModelStoreError("Published PUMA entry failed verification")
                anchor.verify()
                # Keep the internal hard link; both marker names remain 0400.
                # No guard runs after this success boundary.
                return status
            except BaseException as original_error:
                if committed and marker_identity is not None:
                    try:
                        current = os.stat(_marker_name(), dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        committed = False
                    except OSError:
                        raise TissueModelStoreError(
                            "Publication rollback could not be verified; owned files retained"
                        ) from original_error
                    else:
                        if _inode(current) != marker_identity:
                            raise TissueModelStoreError(
                                "Publication was replaced; replacement and owned files retained"
                            ) from original_error
                        try:
                            os.unlink(_marker_name(), dir_fd=parent)
                        except OSError:
                            raise TissueModelStoreError(
                                "Publication rollback failed; owned files retained"
                            ) from original_error
                        committed = False
                raise
            finally:
                if not committed and owned_entry:
                    _cleanup_owned(parent, entry, entry_fd, entry_identity, files)
                os.close(entry_fd)
    except OSError:
        raise TissueModelStoreError("PUMA files could not be accessed safely") from None
