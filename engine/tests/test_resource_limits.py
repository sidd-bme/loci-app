import ctypes
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from loci_engine import resource_limits as limits


def test_windows_structures_match_documented_x64_abi():
    if ctypes.sizeof(ctypes.c_void_p) != 8:
        pytest.skip("Windows x64 is the supported desktop target")
    assert ctypes.sizeof(limits._BasicLimits) == 64
    assert ctypes.sizeof(limits._IoCounters) == 48
    assert ctypes.sizeof(limits._ExtendedLimits) == 144


def test_windows_uses_real_cpu_and_committed_memory_flags():
    observed = {}

    def capture(handle, kind, pointer, size):
        value = ctypes.cast(pointer, ctypes.POINTER(limits._ExtendedLimits)).contents
        observed.update(
            flags=value.BasicLimitInformation.LimitFlags,
            cpu=value.BasicLimitInformation.PerProcessUserTimeLimit,
            memory=value.ProcessMemoryLimit,
            size=size,
            kind=kind,
        )
        return 1

    kernel = SimpleNamespace(
        CreateJobObjectW=Mock(return_value=123),
        SetInformationJobObject=Mock(side_effect=capture),
        GetCurrentProcess=Mock(return_value=456),
        AssignProcessToJobObject=Mock(return_value=1),
        CloseHandle=Mock(),
    )
    limits._windows_limits(12, 256 * 1024**2, kernel)
    assert observed == {
        "flags": 0x102,
        "cpu": 120_000_000,
        "memory": 256 * 1024**2,
        "size": 144,
        "kind": 9,
    }
    kernel.AssignProcessToJobObject.assert_called_once_with(123, 456)
    kernel.CloseHandle.assert_not_called()
    kernel.AssignProcessToJobObject.return_value = 0
    with pytest.raises(OSError, match="attach"):
        limits._windows_limits(12, None, kernel)
    kernel.CloseHandle.assert_called_once_with(123)


def test_windows_process_reconciliation_only_queries_status():
    def query(handle, pointer):
        ctypes.cast(pointer, ctypes.POINTER(ctypes.c_uint32)).contents.value = 259
        return 1

    kernel = SimpleNamespace(
        OpenProcess=Mock(return_value=123),
        GetExitCodeProcess=Mock(side_effect=query),
        CloseHandle=Mock(),
    )
    assert limits._windows_process_alive(100, kernel)
    kernel.OpenProcess.assert_called_once_with(0x1000, False, 100)
    kernel.CloseHandle.assert_called_once_with(123)


@pytest.mark.parametrize("cpu,memory", [(True, None), (0, None), (None, True), (None, 1)])
def test_invalid_limit_never_changes_process(cpu, memory):
    with pytest.raises(ValueError):
        limits.apply_process_limits(cpu, memory)


@pytest.mark.skipif(os.name != "nt", reason="Requires a real Windows Job Object")
def test_windows_child_cannot_commit_beyond_memory_limit():
    script = """
from loci_engine.resource_limits import apply_process_limits
apply_process_limits(30, 128 * 1024**2)
try:
    data = bytearray(256 * 1024**2)
except MemoryError:
    print('memory-blocked')
else:
    raise SystemExit('memory-limit-not-enforced')
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=40
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "memory-blocked"


@pytest.mark.skipif(os.name != "nt", reason="Requires a real Windows Job Object")
def test_windows_cpu_exhaustion_terminates_owned_child():
    script = """
from loci_engine.resource_limits import apply_process_limits
apply_process_limits(1, None)
print('limited', flush=True)
while True:
    pass
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=20
    )
    assert result.returncode != 0
    assert result.stdout.strip() == "limited"
