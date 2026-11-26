"""Handle-relative DynaCell publication on fixed local Windows x64 NTFS volumes.

NtCreateFile creates the stage and its handle in one call. Every subsequent
mutation names either that handle or one component relative to a held parent.
See Microsoft Learn's NtCreateFile, FILE_RENAME_INFORMATION and FILE_DISPOSITION_INFORMATION.
"""

import ctypes as ct
import hashlib
import msvcrt
import os
import platform
import re
import stat
import uuid
from contextlib import suppress
from ctypes import wintypes as w
from pathlib import Path

from .virtual_stain_bundle import validate_windows_path

_kernel = ct.WinDLL("kernel32", use_last_error=True)
_nt = ct.WinDLL("ntdll")
_advapi = ct.WinDLL("advapi32", use_last_error=True)


def _api(dll, name, result, *arguments):
    function = getattr(dll, name)
    function.restype = result
    function.argtypes = arguments
    return function


class _UnicodeString(ct.Structure):
    _fields_ = [("length", w.USHORT), ("maximum", w.USHORT), ("buffer", w.LPWSTR)]


class _Attributes(ct.Structure):
    _fields_ = [
        ("length", w.ULONG),
        ("parent", w.HANDLE),
        ("name", ct.POINTER(_UnicodeString)),
        ("flags", w.ULONG),
        ("security", w.LPVOID),
        ("quality", w.LPVOID),
    ]


class _IoStatus(ct.Structure):
    _fields_ = [("status", w.LPVOID), ("information", ct.c_size_t)]


class _Rename(ct.Structure):
    _fields_ = [
        ("replace", w.DWORD),
        ("parent", w.HANDLE),
        ("length", w.DWORD),
        ("filename", w.WCHAR * 1),
    ]


_create = _api(
    _nt,
    "NtCreateFile",
    w.LONG,
    ct.POINTER(w.HANDLE),
    w.DWORD,
    ct.POINTER(_Attributes),
    ct.POINTER(_IoStatus),
    w.LPVOID,
    w.ULONG,
    w.ULONG,
    w.ULONG,
    w.ULONG,
    w.LPVOID,
    w.ULONG,
)
_dos_error = _api(_nt, "RtlNtStatusToDosError", w.ULONG, w.LONG)
_close = _api(_kernel, "CloseHandle", w.BOOL, w.HANDLE)
_drive_type = _api(_kernel, "GetDriveTypeW", w.UINT, w.LPCWSTR)
_volume = _api(
    _kernel,
    "GetVolumeInformationByHandleW",
    w.BOOL,
    w.HANDLE,
    w.LPWSTR,
    w.DWORD,
    w.LPDWORD,
    w.LPDWORD,
    w.LPDWORD,
    w.LPWSTR,
    w.DWORD,
)
_final_name = _api(
    _kernel,
    "GetFinalPathNameByHandleW",
    w.DWORD,
    w.HANDLE,
    w.LPWSTR,
    w.DWORD,
    w.DWORD,
)
_set_info = _api(
    _nt,
    "NtSetInformationFile",
    w.LONG,
    w.HANDLE,
    ct.POINTER(_IoStatus),
    w.LPVOID,
    w.ULONG,
    ct.c_int,
)
_security = _api(
    _advapi,
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    w.BOOL,
    w.LPCWSTR,
    w.DWORD,
    ct.POINTER(w.LPVOID),
    w.LPDWORD,
)
_free = _api(_kernel, "LocalFree", w.HANDLE, w.HANDLE)

_READ = 0x80000000
_WRITE = 0x40000000
_DELETE = 0x10000
_SYNC = 0x100000
_READ_ATTRIBUTES = 0x80
_TRAVERSE = 0x20
_SHARE_READ = 1
_SHARE_ALL = 7
_OPEN = 1
_CREATE = 2
_DIRECTORY = 1
_WRITE_THROUGH = 2
_NON_DIRECTORY = 0x40
_OPEN_REPARSE_POINT = 0x200000
_SYNCHRONOUS_IO_NONALERT = 0x20


def _checked(ok):
    if not ok:
        raise ct.WinError(ct.get_last_error())


def _open(parent, name, access, share, disposition, kind, security=None):
    length = len(name.encode("utf-16-le"))
    if not length or length > 65532:
        raise ValueError("Invalid Windows path component length")
    string = _UnicodeString(length, length + 2, name)
    flags = 0x40  # OBJ_CASE_INSENSITIVE
    if parent is not None:
        flags |= 0x1000  # OBJ_DONT_REPARSE during single-component lookup
    attributes = _Attributes(
        ct.sizeof(_Attributes), parent, ct.pointer(string), flags, security, None
    )
    if kind == _DIRECTORY and disposition == _CREATE:
        # NTFS write-through metadata applies to the eventual directory rename.
        options = _DIRECTORY | _WRITE_THROUGH
    else:
        # Open the reparse point itself, then verify type and attributes by
        # handle. No FILE_DIRECTORY_FILE hint is needed to inspect an ancestor.
        options = _OPEN_REPARSE_POINT
        if kind == _NON_DIRECTORY:
            options |= _NON_DIRECTORY
    handle = w.HANDLE()
    status = _create(
        ct.byref(handle),
        access | _SYNC,
        ct.byref(attributes),
        ct.byref(_IoStatus()),
        None,
        0,
        share,
        disposition,
        options | _SYNCHRONOUS_IO_NONALERT,
        None,
        0,
    )
    if status < 0:
        raise ct.WinError(_dos_error(status))
    # The CRT descriptor takes ownership of the handle and supplies os.fstat
    # and binary streams with the same semantics as the shared TIFF writer.
    writable = bool(access & _WRITE)
    try:
        fd = msvcrt.open_osfhandle(handle.value, os.O_BINARY | (os.O_RDWR if writable else 0))
    except BaseException:
        _close(handle)
        raise
    try:
        info = os.fstat(fd)
        is_kind = stat.S_ISDIR if kind == _DIRECTORY else stat.S_ISREG
        if (
            info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
            or not is_kind(info.st_mode)
            or not info.st_ino
        ):
            raise ValueError("Virtual stain requires ordinary local files and directories")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _keep(stack, fd):
    stack.callback(os.close, fd)
    return fd


def _root(stack, path):
    if _drive_type(path.anchor) != 3:  # DRIVE_FIXED
        raise ValueError("Virtual stain requires a fixed local NTFS drive")
    root = _keep(
        stack,
        _open(
            None,
            "\\??\\" + path.anchor,
            _TRAVERSE | _READ_ATTRIBUTES,
            _SHARE_ALL,
            _OPEN,
            _DIRECTORY,
        ),
    )
    handle = msvcrt.get_osfhandle(root)
    filesystem = ct.create_unicode_buffer(32)
    _checked(_volume(handle, None, 0, None, None, None, filesystem, len(filesystem)))
    # VOLUME_NAME_GUID identifies local volumes. Require the drive letter to
    # denote the volume root itself (no network redirects or SUBST aliases).
    final = ct.create_unicode_buffer(128)
    count = _final_name(handle, final, len(final), 1)
    if (
        filesystem.value != "NTFS"
        or not 0 < count < len(final)
        or not re.fullmatch(r"\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\", final.value)
    ):
        raise ValueError("Virtual stain requires a direct drive letter on local NTFS")
    return root


def _pin_parent(stack, path, bindings):
    parent = _root(stack, path)
    directory = Path(path.anchor)
    bindings.append((directory, os.fstat(parent)))
    for part in path.parts[1:-1]:
        # Excluding write and delete sharing keeps each ordinary ancestor in
        # place. Children can still be created independently in the directory.
        parent = _keep(
            stack,
            _open(
                msvcrt.get_osfhandle(parent),
                part,
                _TRAVERSE | _READ_ATTRIBUTES,
                _SHARE_READ,
                _OPEN,
                _DIRECTORY,
            ),
        )
        directory = directory / part
        bindings.append((directory, os.fstat(parent)))
    return parent


def _set_file_info(fd, info, info_class):
    status = _set_info(
        msvcrt.get_osfhandle(fd), ct.byref(_IoStatus()), ct.byref(info), ct.sizeof(info), info_class
    )
    if status < 0:
        raise ct.WinError(_dos_error(status))


def _delete_on_close(fd):
    delete = ct.c_ubyte(1)
    _set_file_info(fd, delete, 13)  # FileDispositionInformation


class WindowsBundle:
    def __init__(self, target, inputs, stack):
        if ct.sizeof(w.HANDLE) != 8 or platform.machine().lower() not in {"amd64", "x86_64"}:
            raise ValueError("Virtual stain requires Windows x64")
        self.target = target
        self.stack = stack
        self.stage = None
        self.registered = False
        self.location = target.with_name(".loci-virtual-stain-" + uuid.uuid4().hex)
        self.owned = {}
        for path in (target, *inputs):
            validate_windows_path(path)
        self.bindings = []
        self.parent = _pin_parent(stack, target, self.bindings)
        for path in inputs:
            parent = _pin_parent(stack, path, self.bindings)
            fd = _open(
                msvcrt.get_osfhandle(parent), path.name, _READ, _SHARE_READ, _OPEN, _NON_DIRECTORY
            )
            _keep(stack, fd)
            self.bindings.append((path, os.fstat(fd)))

    def guard(self):
        for path, pinned in self.bindings:
            current = path.lstat()
            if (
                current.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                or not os.path.samestat(pinned, current)
            ):
                raise ValueError("Virtual stain input or destination location changed")
        if self.stage is not None:
            current = self.location.lstat()
            if (
                current.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                or not os.path.samestat(os.fstat(self.stage), current)
            ):
                raise ValueError("Virtual stain bundle directory changed")

    def start(self):
        self.guard()
        # Protected ACL, inherited by the TIFF and sidecar. OW is OWNER RIGHTS.
        descriptor = w.LPVOID()
        _checked(_security("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)", 1, ct.byref(descriptor), None))
        try:
            self.stage = _open(
                msvcrt.get_osfhandle(self.parent),
                self.location.name,
                _READ | _DELETE,
                _SHARE_READ,
                _CREATE,
                _DIRECTORY,
                descriptor,
            )
        finally:
            _free(descriptor)
        self.stack.callback(os.close, self.stage)
        self.stack.callback(self.rollback)
        self.guard()

    def _child(self, name, access, disposition):
        return _open(
            msvcrt.get_osfhandle(self.stage), name, access, _SHARE_READ, disposition, _NON_DIRECTORY
        )

    def file(self, name):
        fd = self._child(name, _READ | _WRITE, _CREATE)
        self.owned[name] = os.fstat(fd)
        return os.fdopen(fd, "w+b")

    def verify(self, files):
        self.guard()
        if set(os.listdir(self.location)) != set(files):
            raise ValueError("Virtual stain contains missing or unexpected files")
        for name, record in files.items():
            fd = self._child(name, _READ, _OPEN)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(fd)
                if (
                    not os.path.samestat(self.owned[name], info)
                    or info.st_nlink != 1
                    or info.st_size != record["size_bytes"]
                    or hashlib.file_digest(stream, "sha256").hexdigest() != record["sha256"]
                ):
                    raise ValueError("Virtual stain artifact identity or checksum changed")

    def publish(self):
        self.guard()
        name = self.target.name.encode("utf-16-le")
        buffer = ct.create_string_buffer(ct.sizeof(_Rename) + len(name))
        rename = _Rename.from_buffer(buffer)
        rename.replace = 0
        rename.parent = None  # Simple filename, same parent as the open stage.
        rename.length = len(name)
        ct.memmove(ct.addressof(buffer) + _Rename.filename.offset, name, len(name))
        _set_file_info(self.stage, buffer, 10)  # FileRenameInformation
        self.location = self.target
        self.guard()
        # NTFS directory rename requires closed child handles. Reacquire both
        # read locks before the path-based native reader and hold through commit.
        for name in self.owned:
            fd = self._child(name, _READ, _OPEN)
            _keep(self.stack, fd)
            if not os.path.samestat(self.owned[name], os.fstat(fd)):
                raise ValueError("Virtual stain artifact changed during publication")

    def rollback(self):
        if self.registered:
            return
        for name, created in self.owned.items():
            with suppress(FileNotFoundError):
                # A replacement may be a directory or reparse point which
                # cannot be opened as a regular file. Leave it in place.
                if not os.path.samestat(created, (self.location / name).lstat()):
                    continue
                fd = self._child(name, _READ_ATTRIBUTES | _DELETE, _OPEN)
                try:
                    if os.path.samestat(created, os.fstat(fd)):
                        _delete_on_close(fd)
                finally:
                    os.close(fd)
        # NTFS refuses disposition of nonempty directories. An unrelated file
        # introduced concurrently is never recursively removed.
        try:
            _delete_on_close(self.stage)
        except OSError as error:
            if error.winerror != 145:  # ERROR_DIR_NOT_EMPTY
                raise
