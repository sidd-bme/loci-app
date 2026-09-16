"""Resource limits for an owned, disposable analysis process.

These are resource controls, not a sandbox for arbitrary code. Windows Job
Objects enforce user CPU time and committed memory; Linux uses rlimits. macOS
enforces CPU time and relies on operation preflight for decoded working memory.
"""

from __future__ import annotations

import ctypes
import os
import sys
from typing import Any


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint64)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


# Retain the handle until process teardown. Never close an active job as part of
# a reusable worker's request lifecycle: this function is for dedicated CLI jobs.
_WINDOWS_JOBS: list[tuple[Any, Any]] = []


def _windows_process_alive(pid: int, kernel: Any = None) -> bool:
    if kernel is None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    kernel.GetExitCodeProcess.restype = ctypes.c_int
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int
    handle = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION only.
    if not handle:
        # Access denied cannot establish that a process has gone away.
        error = ctypes.get_last_error()
        if error == 5:
            return True
        if error == 87:  # invalid parameter: no such PID
            return False
        raise OSError("Cannot inspect the execution process identity")
    try:
        code = ctypes.c_uint32()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise OSError("Cannot inspect the execution process status")
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel.CloseHandle(handle)


def process_alive(pid: int) -> bool:
    """Read-only liveness; os.kill(pid, 0) is unsafe on Windows."""
    if os.name == "nt":
        return _windows_process_alive(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _windows_limits(cpu: int | None, memory: int | None, kernel: Any = None) -> None:
    if kernel is None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateJobObjectW": ([ctypes.c_void_p, ctypes.c_wchar_p], ctypes.c_void_p),
        "SetInformationJobObject": (
            [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32],
            ctypes.c_int,
        ),
        "GetCurrentProcess": ([], ctypes.c_void_p),
        "AssignProcessToJobObject": ([ctypes.c_void_p, ctypes.c_void_p], ctypes.c_int),
        "CloseHandle": ([ctypes.c_void_p], ctypes.c_int),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise OSError("Cannot create the Windows analysis resource limit job")
    limits = _ExtendedLimits()
    if cpu is not None:
        limits.BasicLimitInformation.LimitFlags |= 0x00000002
        limits.BasicLimitInformation.PerProcessUserTimeLimit = cpu * 10_000_000
    if memory is not None:
        limits.BasicLimitInformation.LimitFlags |= 0x00000100
        limits.ProcessMemoryLimit = memory
    try:
        if not kernel.SetInformationJobObject(
            handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            raise OSError("Cannot enforce the Windows analysis resource limits")
        if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
            raise OSError("Cannot attach analysis to its Windows resource limit job")
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    _WINDOWS_JOBS.append((kernel, handle))


def apply_process_limits(cpu: int | None, memory: int | None) -> dict[str, Any]:
    """Apply limits once in a disposable process; inability to enforce fails."""
    if cpu is not None and (type(cpu) is not int or not 1 <= cpu <= 86400):
        raise ValueError("CPU limit must be 1-86400 seconds")
    if memory is not None and (
        type(memory) is not int or not 64 * 1024**2 <= memory <= 8 * 1024**3
    ):
        raise ValueError("Memory limit must be 64 MiB through 8 GiB")
    if cpu is None and memory is None:
        return {"cpu": "none", "memory": "operation-preflight"}
    if os.name == "nt":
        _windows_limits(cpu, memory)
        return {"cpu": "windows-job-user-time", "memory": "windows-job-commit"}
    if os.name == "posix":
        import resource

        if cpu is not None:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        if memory is not None and sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        return {
            "cpu": "posix-rlimit-cpu" if cpu else "none",
            "memory": "linux-rlimit-as"
            if memory and sys.platform.startswith("linux")
            else "operation-preflight",
        }
    raise ValueError("This host has no implemented process resource limits")
