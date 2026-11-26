import hashlib
from pathlib import Path

import numpy as np
import pytest

from loci_engine import dynacell


def _phase(depth=15):
    # Asymmetric phase pattern reveals Z/Y/X interchange and coordinate shifts.
    z, y, x = np.ogrid[:depth, :512, :512]
    return (z + y / 1024 + x / 4096).astype(np.float32)


@pytest.mark.parametrize(
    ("shape", "dtype"),
    [
        ((14, 512, 512), np.float32),
        ((41, 512, 512), np.float32),
        ((15, 512, 256), np.float32),
        ((512, 512, 15), np.float32),
        ((1, 15, 512, 512), np.float32),
        ((15, 512, 512), np.uint16),
    ],
)
def test_rejects_unsupported_input_before_loading(shape, dtype):
    arr = np.broadcast_to(np.zeros((), dtype=dtype), shape)
    with pytest.raises(ValueError, match="Phase3D"):
        dynacell.predict_virtual_nuclei(arr, Path("missing"), mean=1, std=2)


@pytest.mark.parametrize(
    ("mean", "std"),
    [(float("nan"), 2), (1, float("inf")), (1, -1), (0, 0), (True, 2), (0, 1e300)],
)
def test_requires_finite_full_field_stats(mean, std):
    with pytest.raises(ValueError, match="Full-field"):
        dynacell.predict_virtual_nuclei(_phase(), Path("missing"), mean=mean, std=std)


def test_nonfinite_input_fails_before_loading():
    pytest.importorskip("torch")
    phase = _phase()
    phase[14, 511, 511] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        dynacell.predict_virtual_nuclei(phase, Path("missing"), mean=1, std=2)


def test_checkpoint_identity_before_deserialization(tmp_path, monkeypatch):
    data = b"fixed test fixture"
    path = tmp_path / "weights.ckpt"
    path.write_bytes(data)
    monkeypatch.setattr(dynacell, "CHECKPOINT_BYTES", len(data))
    monkeypatch.setattr(dynacell, "CHECKPOINT_SHA256", hashlib.sha256(data).hexdigest())
    assert dynacell._read_checkpoint(path) == data
    link = tmp_path / "linked"
    link.symlink_to(path)
    with pytest.raises(ValueError, match="regular"):
        dynacell._read_checkpoint(link)
    path.write_bytes(data[::-1])
    with pytest.raises(ValueError, match="SHA-256"):
        dynacell._read_checkpoint(path)
    path.write_bytes(data[:-1])
    with pytest.raises(ValueError, match="size"):
        dynacell._read_checkpoint(path)


def test_only_verified_bytes_loaded_strictly_on_cpu(tmp_path, monkeypatch):
    torch = pytest.importorskip("torch")
    from loci_engine.dynacell_architecture import NuclearUNeXt2

    path = tmp_path / "weights.ckpt"
    path.write_bytes(b"fixture")
    monkeypatch.setattr(dynacell, "CHECKPOINT_BYTES", 7)
    monkeypatch.setattr(dynacell, "CHECKPOINT_SHA256", hashlib.sha256(b"fixture").hexdigest())

    def load_verified(stream, *, weights_only, map_location):
        assert weights_only is True and map_location == "cpu"
        assert stream.read() == b"fixture"
        return {"state_dict": {"model.unexpected": torch.tensor(0)}}

    monkeypatch.setattr(torch, "load", load_verified)
    with pytest.raises(RuntimeError, match="Missing key"):
        dynacell._load_network(path)
    with torch.device("meta"):
        model = NuclearUNeXt2()
    assert len(model.state_dict()) == 252
    assert sum(p.numel() for p in model.parameters()) == 32_148_528


def test_native_geometry_full_field_normalization_overlap_and_progress(monkeypatch):
    torch = pytest.importorskip("torch")
    phase = _phase(19)[:, ::-1, :]
    original = phase.copy()
    done = []

    def window_model(window):
        assert not torch.is_grad_enabled()
        assert window.shape == (1, 1, 15, 512, 512)
        assert window.device.type == "cpu" and torch.get_num_threads() <= 2
        return window + torch.arange(15).view(1, 1, 15, 1, 1)

    monkeypatch.setattr(dynacell, "_load_network", lambda path: window_model)
    previous_threads = torch.get_num_threads()
    pred = dynacell.predict_virtual_nuclei(
        phase, Path("fixture"), mean=9.0, std=2.0, progress=lambda n, total: done.append((n, total))
    )
    assert torch.get_num_threads() == previous_threads
    assert done == [(i + 1, 5) for i in range(5)]
    assert pred.dtype == np.float32 and pred.shape == phase.shape
    np.testing.assert_array_equal(phase, original)
    for z in range(19):
        starts = [s for s in range(5) if s <= z < s + 15]
        expected = (phase[z] - 9.0) / 2.0 + np.mean([z - s for s in starts])
        np.testing.assert_array_equal(pred[z], expected)


def test_publisher_normalization_rounds_stats_before_epsilon(monkeypatch):
    pytest.importorskip("torch")
    phase = _phase(15)
    std = 0.445869548
    monkeypatch.setattr(dynacell, "_load_network", lambda _: lambda window: window)
    expected = (phase - np.float32(0.1)) / (np.float32(std) + np.float32(1e-8))
    assert np.float32(std + 1e-8) != np.float32(std) + np.float32(1e-8)
    actual = dynacell.predict_virtual_nuclei(phase, Path("fixture"), mean=0.1, std=std)
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("bad_result", ["shape", "dtype", "non-finite", "cancel"])
def test_no_partial_results_and_worker_threads_restored(monkeypatch, bad_result):
    torch = pytest.importorskip("torch")

    def model(window):
        if bad_result == "shape":
            return window[:, :, 0]
        if bad_result == "dtype":
            return window.double()
        if bad_result == "non-finite":
            return torch.full_like(window, torch.nan)
        return window

    def cancel(completed, total):
        assert completed == 1 and total == 2
        raise ValueError("cancelled")

    monkeypatch.setattr(dynacell, "_load_network", lambda path: model)
    previous_threads = torch.get_num_threads()
    with pytest.raises(ValueError, match=bad_result):
        dynacell.predict_virtual_nuclei(_phase(16), Path("fixture"), mean=0, std=1, progress=cancel)
    assert torch.get_num_threads() == previous_threads


def test_each_window_rounds_its_depth_blend_to_float32():
    rng = np.random.default_rng(1234)
    windows = rng.standard_normal((26, 15, 3, 4), dtype=np.float32)
    actual = np.empty((40, 3, 4), dtype=np.float32)
    for start, window in enumerate(windows):
        dynacell._blend_window(actual, window, start)
    # Independent per-plane recurrence in frequency-of-observation order.
    for z, plane in enumerate(actual):
        contributions = [win[z - s] for s, win in enumerate(windows) if 0 <= z - s < 15]
        expected = contributions[0].copy()
        for count, contribution in enumerate(contributions[1:], start=2):
            expected[:] = (
                expected.astype(np.float64) * (count - 1) / count
                + contribution.astype(np.float64) / count
            )
        np.testing.assert_array_equal(plane, expected)
