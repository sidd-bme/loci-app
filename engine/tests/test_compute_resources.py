from types import SimpleNamespace

import pytest

from loci_engine import compute_resources as resources


def runtime(*, mps=True, cuda=True, mps_used=4, mps_total=10, cuda_free=8):
    return SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
        mps=SimpleNamespace(
            recommended_max_memory=lambda: mps_total, driver_allocated_memory=lambda: mps_used
        ),
        cuda=SimpleNamespace(is_available=lambda: cuda, mem_get_info=lambda: (cuda_free, 10)),
    )


def test_auto_uses_actual_mps_and_unified_host_headroom_then_cuda(monkeypatch):
    monkeypatch.setattr(resources, "available_host_memory", lambda: 3)
    torch = runtime()
    device, reason, record = resources.select_device(torch, "auto", 4)
    assert device == "cuda" and reason is None
    assert record["observations"][0]["available_bytes"] == 3
    assert record["observations"][1]["available_bytes"] == 8
    assert record["required_bytes"] == 4 and record["reservation"] is False
    monkeypatch.setattr(resources, "available_host_memory", lambda: 7)
    device, _, record = resources.select_device(torch, "auto", 6)
    assert device == "mps"
    assert record["observations"][0]["available_bytes"] == 6


def test_explicit_low_memory_accelerator_reports_cpu_fallback(monkeypatch):
    monkeypatch.setattr(resources, "available_host_memory", lambda: 3)
    device, reason, _ = resources.select_device(runtime(), "mps", 4)
    assert device == "cpu" and "below the estimated" in reason
    device, reason, _ = resources.select_device(runtime(mps=False), "mps", 1)
    assert device == "cpu" and "unavailable" in reason


@pytest.mark.parametrize("free", [None, -1, True, 11])
def test_missing_or_invalid_gpu_memory_never_grants_accelerator(free):
    device, reason, record = resources.select_device(runtime(mps=False, cuda_free=free), "cuda", 1)
    assert device == "cpu" and "could not be measured" in reason
    assert record["observations"][0]["available_bytes"] is None


def test_vm_stat_counts_disjoint_reclaimable_pages(monkeypatch):
    monkeypatch.setattr(resources.sys, "platform", "darwin")
    monkeypatch.setattr(
        resources.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(
            stdout=(
                "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
                "Pages free: 3.\nPages inactive: 5.\nPages speculative: 7.\nPages purgeable: 9.\n"
            )
        ),
    )
    assert resources.available_host_memory() == 15 * 16384
