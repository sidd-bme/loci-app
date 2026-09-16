"""Best-effort memory observations used before optional accelerator allocation.

These are instantaneous capacity observations, not memory reservations. CPU
execution keeps its existing image-size guard; an accelerator must additionally
pass this preflight before being selected, including when requested explicitly.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Any


def available_host_memory() -> int | None:
    try:
        if sys.platform == "darwin":
            output = subprocess.run(
                ["/usr/bin/vm_stat"],
                capture_output=True,
                text=True,
                check=True,
                timeout=2,
            ).stdout
            page = re.search(r"page size of (\d+) bytes", output)
            values = dict(
                re.findall(
                    r"^(Pages (?:free|inactive|speculative)):\s+(\d+)\.", output, re.MULTILINE
                )
            )
            if page and len(values) == 3:
                return int(page.group(1)) * sum(int(value) for value in values.values())
        elif sys.platform.startswith("linux"):
            output = Path("/proc/meminfo").read_text()[:65536]
            found = re.search(r"^MemAvailable:\s+(\d+) kB", output, re.MULTILINE)
            if found:
                return int(found.group(1)) * 1024
        elif sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
                    (name, ctypes.c_ulonglong)
                    for name in (
                        "total_physical",
                        "available_physical",
                        "total_page",
                        "available_page",
                        "total_virtual",
                        "available_virtual",
                        "extended",
                    )
                ]

            value = MemoryStatus()
            value.length = ctypes.sizeof(value)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):
                return int(value.available_physical)
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None
    return None


def _nonnegative_integer(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("Memory query returned an invalid value")
    return value


def accelerator_capacity(torch: Any, device: str) -> dict[str, Any]:
    record: dict[str, Any] = {"device": device, "available_bytes": None}
    try:
        if device == "cuda":
            free, total = torch.cuda.mem_get_info()
            free, total = _nonnegative_integer(free), _nonnegative_integer(total)
            if free > total or total == 0:
                raise ValueError("Invalid CUDA memory observation")
            record.update(available_bytes=free, total_bytes=total, basis="cuda-mem-get-info")
        elif device == "mps":
            recommended = _nonnegative_integer(torch.mps.recommended_max_memory())
            allocated = _nonnegative_integer(torch.mps.driver_allocated_memory())
            host_available = available_host_memory()
            if recommended == 0 or host_available is None:
                raise ValueError("Unified memory availability could not be measured")
            host_available = _nonnegative_integer(host_available)
            record.update(
                available_bytes=min(max(0, recommended - allocated), host_available),
                recommended_bytes=recommended,
                driver_allocated_bytes=allocated,
                host_available_bytes=host_available,
                basis="minimum-of-metal-working-set-headroom-and-reclaimable-host-memory",
            )
    except (AttributeError, RuntimeError, OSError, ValueError, TypeError):
        record.update(available_bytes=None, basis="memory-query-unavailable")
    return record


def select_device(
    torch: Any, requested: str, required_bytes: int
) -> tuple[str, str | None, dict[str, Any]]:
    if requested not in {"auto", "cpu", "mps", "cuda"} or required_bytes <= 0:
        raise ValueError("Choose a supported local device and positive memory requirement")
    candidates = ["mps", "cuda"] if requested == "auto" else [requested]
    observations = []
    fallback_reasons = []
    reason = None
    for device in candidates:
        if device == "cpu":
            break
        supported = (
            bool(torch.backends.mps.is_available())
            if device == "mps"
            else bool(torch.cuda.is_available())
        )
        if not supported:
            observations.append({"device": device, "available": False})
            reason = f"{device.upper()} is unavailable; Loci used CPU."
            fallback_reasons.append(reason)
            continue
        capacity = accelerator_capacity(torch, device)
        observations.append({**capacity, "available": True})
        available = capacity["available_bytes"]
        if available is not None and available >= required_bytes:
            return (
                device,
                None,
                {
                    "required_bytes": required_bytes,
                    "observations": observations,
                    "reservation": False,
                },
            )
        reason = (
            f"{device.upper()} memory availability could not be measured; Loci used CPU."
            if available is None
            else (
                f"{device.upper()} available memory ({available} bytes) is below the estimated "
                f"requirement ({required_bytes} bytes); Loci used CPU."
            )
        )
        fallback_reasons.append(reason)
    if requested == "auto" and not any(item.get("available") for item in observations):
        reason = None  # CPU is the ordinary compatible Auto route on this host.
    elif fallback_reasons:
        reason = " ".join(fallback_reasons)
    return (
        "cpu",
        reason,
        {"required_bytes": required_bytes, "observations": observations, "reservation": False},
    )
