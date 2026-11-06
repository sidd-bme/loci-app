from __future__ import annotations

import builtins
import copy
import hashlib
import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from loci_engine import puma_backend as backend
from loci_engine.tissue_model_profiles import PUMA_MIN_WORKING_BYTES, PUMA_RGB_POLICY


def _request(height: int, width: int, roi=None) -> dict:
    return {
        "source_sha256": "a" * 64,
        "source_kind": "native",
        "source_shape_yx": [height, width],
        "series": 0,
        "context_selection": {
            "x": 0,
            "y": 0,
            "width": width,
            "height": height,
            "z": 2,
            "t": 3,
            "c": 0,
            "level": 0,
        },
        "output_roi_yxhw": roi or [0, 0, height, width],
        "rgb_policy": PUMA_RGB_POLICY,
    }


def _weights(tmp_path: Path) -> backend.ApprovedPumaWeights:
    return backend.ApprovedPumaWeights(
        (tmp_path / "weights.pth").resolve(),
        backend.PUMA_WEIGHTS_SHA256,
        backend.PUMA_WEIGHTS_BYTES,
    )


def _small_verified_weights(monkeypatch, tmp_path):
    data = b"Test artifact only; no executable tensor payload."
    monkeypatch.setattr(backend, "PUMA_WEIGHTS_BYTES", len(data))
    monkeypatch.setattr(backend, "PUMA_WEIGHTS_SHA256", hashlib.sha256(data).hexdigest())
    weights = _weights(tmp_path)
    weights.path.write_bytes(data)
    return weights


def _forbid_torch(monkeypatch):
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            raise AssertionError("A static/NumPy check unexpectedly imported Torch")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)


def test_full_context_crop_normalization_and_padding_preserve_input(monkeypatch):
    _forbid_torch(monkeypatch)
    rgb = np.zeros((8, 10, 3), dtype=np.uint8)
    rgb[2:7, 3:9] = np.arange(1, 91, dtype=np.uint8).reshape(5, 6, 3)
    original = rgb.copy()
    padded, record = backend._prepare(rgb, _request(8, 10), PUMA_MIN_WORKING_BYTES, None)
    prep = record["preprocessing"]
    assert prep["crop_bbox_yx"] == [[2, 7], [3, 9]]
    assert prep["padding_before_yx"] == [253, 253]
    assert prep["padding_after_yx"] == [254, 253]
    assert padded.shape == (3, 512, 512)
    assert padded.dtype == np.float32
    for channel in range(3):
        values = rgb[2:7, 3:9, channel].astype(np.float32)
        expected = (values - values.mean()) / values.std()
        np.testing.assert_array_equal(padded[channel, 253:258, 253:259], expected)
    assert np.all(padded[:, :253] == 0)
    np.testing.assert_array_equal(rgb, original)


@pytest.mark.parametrize("value", [0, 127, 255])
def test_zero_and_constant_contexts_remain_finite(value):
    rgb = np.full((5, 7, 3), value, dtype=np.uint8)
    padded, record = backend._prepare(rgb, _request(5, 7), PUMA_MIN_WORKING_BYTES, None)
    assert record["preprocessing"]["crop_bbox_yx"] == [[0, 5], [0, 7]]
    assert np.isfinite(padded).all()
    assert np.all(padded == 0)


def test_rgba_policy_discards_fourth_sample_explicitly_without_compositing():
    rgba = np.full((5, 7, 4), 127, dtype=np.uint8)
    rgba[..., 3] = np.arange(35, dtype=np.uint8).reshape(5, 7)
    rgba_plan = backend.plan_puma(rgba, _request(5, 7), working_bytes=PUMA_MIN_WORKING_BYTES)
    rgb_plan = backend.plan_puma(
        rgba[..., :3], _request(5, 7), working_bytes=PUMA_MIN_WORKING_BYTES
    )
    assert rgba_plan["preprocessing"] == rgb_plan["preprocessing"]
    assert rgba_plan["decoding"]["alpha_discarded"] is True
    assert rgba_plan["decoding"]["discarded_sample"]["minimum"] == 0
    assert rgba_plan["decoding"]["discarded_sample"]["maximum"] == 34
    assert rgba_plan["decoding"]["rgb_array_sha256"] == rgb_plan["decoding"]["rgb_array_sha256"]
    assert rgba_plan["decoding"]["display_transforms_used"] is False


@pytest.mark.parametrize(
    ("roi", "tile_count"),
    [([0, 0, 64, 64], 1), ([0, 960, 64, 64], 1), ([300, 300, 64, 64], 4), ([500, 500, 64, 64], 9)],
)
def test_roi_selects_every_overlapping_full_context_tile(roi, tile_count):
    rgb = np.ones((1024, 1024, 3), dtype=np.uint8)
    record = backend.plan_puma(rgb, _request(1024, 1024, roi), working_bytes=PUMA_MIN_WORKING_BYTES)
    plan = record["tiles"]
    assert plan["full_grid_starts_yx"] == [[0, 256, 512], [0, 256, 512]]
    assert plan["full_tile_count"] == 9
    assert plan["evaluated_tile_count"] == tile_count
    assert plan["planned_network_calls"] == tile_count * 4
    full_counts = np.zeros((1024, 1024), dtype=np.uint8)
    for y in (0, 256, 512):
        for x in (0, 256, 512):
            full_counts[y : y + 512, x : x + 512] += 1
    y, x, height, width = roi
    actual = np.zeros((height, width), dtype=np.uint8)
    for tile in plan["tiles"]:
        (y0, y1), (x0, x1) = tile["output_intersection_yx"]
        actual[y0:y1, x0:x1] += 1
    np.testing.assert_array_equal(actual, full_counts[y : y + height, x : x + width])
    assert record["request"]["context_selection"]["t"] == 3
    assert record["request"]["context_selection"]["z"] == 2
    assert record["request"]["output_selection"]["x"] == x


def test_roi_does_not_change_normalization_statistics_or_grid():
    rgb = np.arange(600 * 520 * 3, dtype=np.uint32).reshape(600, 520, 3).astype(np.uint8)
    full = backend.plan_puma(rgb, _request(600, 520), working_bytes=PUMA_MIN_WORKING_BYTES)
    roi = backend.plan_puma(
        rgb, _request(600, 520, [50, 50, 10, 20]), working_bytes=PUMA_MIN_WORKING_BYTES
    )
    assert full["preprocessing"] == roi["preprocessing"]
    assert full["tiles"]["full_grid_starts_yx"] == roi["tiles"]["full_grid_starts_yx"]
    assert roi["request"]["roi_changes_context"] is False
    assert roi["tiles"]["roi_changes_normalization_or_tile_grid"] is False


def test_crop_padding_and_source_to_output_mapping_remain_explicit():
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    rgb[100:200, 300:500] = 1
    outside = backend.plan_puma(
        rgb, _request(512, 512, [0, 0, 64, 64]), working_bytes=PUMA_MIN_WORKING_BYTES
    )
    assert outside["tiles"]["tiles"] == []
    assert outside["tiles"]["computed_bbox_output_yx"] is None
    assert outside["tiles"]["class_background_outside_nonzero_bbox"] == 0
    mixed = backend.plan_puma(
        rgb, _request(512, 512, [90, 290, 30, 30]), working_bytes=PUMA_MIN_WORKING_BYTES
    )
    assert mixed["tiles"]["computed_bbox_output_yx"] == [[10, 30], [10, 30]]
    assert mixed["tiles"]["tiles"][0]["output_intersection_yx"] == [[10, 30], [10, 30]]
    assert mixed["tiles"]["source_to_output_yx_offset"] == [-90, -290]


@pytest.mark.parametrize(
    "change",
    [
        {"source_kind": "whole_slide"},
        {"source_kind": "medical"},
        {"source_sha256": "not-a-sha"},
        {"source_shape_yx": [4, 5]},
        {"rgb_policy": "alpha-composite"},
        {"series": True},
        {"output_roi_yxhw": [-1, 0, 1, 1]},
        {"output_roi_yxhw": [0, 0, 0, 1]},
        {"output_roi_yxhw": [0, 6, 1, 2]},
        {"extra": "ignored"},
    ],
)
def test_unsupported_source_request_refused_before_optional_runtime(monkeypatch, change):
    _forbid_torch(monkeypatch)
    rgb = np.ones((5, 7, 3), dtype=np.uint8)
    with pytest.raises(backend.PumaBackendError):
        backend.plan_puma(rgb, {**_request(5, 7), **change}, working_bytes=PUMA_MIN_WORKING_BYTES)


@pytest.mark.parametrize(
    ("key", "value"), [("x", 1), ("y", 1), ("level", 1), ("c", 1), ("z", True)]
)
def test_viewport_level_or_biological_channel_substitution_is_refused(key, value):
    rgb = np.ones((5, 7, 3), dtype=np.uint8)
    request = _request(5, 7)
    request["context_selection"][key] = value
    with pytest.raises(backend.PumaBackendError):
        backend.plan_puma(rgb, request, working_bytes=PUMA_MIN_WORKING_BYTES)


@pytest.mark.parametrize(
    "array",
    [
        np.zeros((5, 7), dtype=np.uint8),
        np.zeros((5, 7, 2), dtype=np.uint8),
        np.zeros((5, 7, 3), dtype=np.uint16),
        np.zeros((5, 7, 3), dtype=np.float32),
        np.zeros((1025, 1, 3), dtype=np.uint8),
        np.zeros((0, 7, 3), dtype=np.uint8),
    ],
)
def test_invalid_rgb_shape_dtype_or_bound_is_refused(array):
    with pytest.raises(backend.PumaBackendError):
        backend.plan_puma(array, _request(5, 7), working_bytes=PUMA_MIN_WORKING_BYTES)


def test_resource_preflight_uses_full_context_and_exceeds_generic_512mib(monkeypatch, tmp_path):
    rgb = np.ones((1024, 1024, 3), dtype=np.uint8)
    request = _request(1024, 1024, [0, 0, 8, 8])
    record = backend.resource_preflight(rgb, request, working_bytes=PUMA_MIN_WORKING_BYTES)
    assert record["context_pixels"] == 1024**2
    assert record["output_pixels"] == 64
    assert record["required_allowance_bytes"] >= 2 * 1024**3
    assert record["estimated_required_bytes"] > 1024**3
    assert record["hard_process_rss_limit"] is False

    def unexpected(*_args, **_kwargs):
        raise AssertionError("A rejected budget reached optional execution")

    monkeypatch.setattr(backend, "_import_runtime", unexpected)
    monkeypatch.setattr(backend, "_verified_weights", unexpected)
    with pytest.raises(backend.PumaBackendError, match="2 and 8 GiB"):
        backend.infer_puma(rgb, request, weights=_weights(tmp_path), working_bytes=512 * 1024**2)


def test_cancellation_precedes_decode_work_and_native_import(monkeypatch):
    _forbid_torch(monkeypatch)

    def cancel():
        raise InterruptedError("Cancelled by owner")

    with pytest.raises(InterruptedError, match="Cancelled"):
        backend.plan_puma(
            np.ones((5, 7, 3), dtype=np.uint8),
            _request(5, 7),
            working_bytes=PUMA_MIN_WORKING_BYTES,
            check=cancel,
        )


def test_status_does_not_simulate_missing_or_unverified_runtime_success(monkeypatch, tmp_path):
    _forbid_torch(monkeypatch)
    monkeypatch.setattr(backend, "runtime_metadata_status", lambda: {"status": "missing"})
    status = backend.inspect_puma_status(_weights(tmp_path), verify_weights=True)
    assert status["status"] == "unavailable"
    assert status["weights"]["status"] == "missing"
    assert status["ready"] is False
    assert status["model_execution_performed"] is False
    monkeypatch.setattr(
        backend, "runtime_metadata_status", lambda: {"status": "metadata-matches-unverified"}
    )
    weights = _small_verified_weights(monkeypatch, tmp_path)
    status = backend.inspect_puma_status(weights, verify_weights=True)
    assert status["weights"] == {"status": "verified", "verified": True}
    assert status["status"] == "compatibility-unverified"
    assert status["ready"] is False


def test_weight_identity_refuses_relative_path_wrong_hash_size_and_symlink(monkeypatch, tmp_path):
    weights = _small_verified_weights(monkeypatch, tmp_path)
    bad = [
        backend.ApprovedPumaWeights(Path("relative.pth"), weights.sha256, weights.size_bytes),
        backend.ApprovedPumaWeights(weights.path, "0" * 64, weights.size_bytes),
        backend.ApprovedPumaWeights(weights.path, weights.sha256, weights.size_bytes + 1),
    ]
    for candidate in bad:
        with (
            pytest.raises(backend.PumaBackendError, match="exact PUMA identity"),
            backend._verified_weights(candidate),
        ):
            pass
    link = tmp_path / "linked.pth"
    link.symlink_to(weights.path)
    with (
        pytest.raises(backend.PumaBackendError, match="link"),
        backend._verified_weights(
            backend.ApprovedPumaWeights(link, weights.sha256, weights.size_bytes)
        ),
    ):
        pass


def test_weight_tampering_during_use_and_same_size_wrong_content_are_refused(monkeypatch, tmp_path):
    weights = _small_verified_weights(monkeypatch, tmp_path)
    with (
        pytest.raises(backend.PumaBackendError, match="changed during use"),
        backend._verified_weights(weights),
    ):
        weights.path.write_bytes(b"X" * weights.size_bytes)
    with (
        pytest.raises(backend.PumaBackendError, match="hash mismatch"),
        backend._verified_weights(weights),
    ):
        pass


def test_missing_target_runtime_never_imports_torch_or_reads_weights(monkeypatch, tmp_path):
    _forbid_torch(monkeypatch)
    monkeypatch.setattr(backend, "runtime_metadata_status", lambda: {"status": "mismatch"})
    with pytest.raises(backend.PumaBackendError, match="missing or mismatched"):
        backend.infer_puma(
            np.ones((5, 7, 3), dtype=np.uint8),
            _request(5, 7),
            weights=_weights(tmp_path),
            working_bytes=PUMA_MIN_WORKING_BYTES,
        )


def test_unsafe_serialization_environment_refused_before_runtime_import(monkeypatch):
    _forbid_torch(monkeypatch)
    monkeypatch.setattr(
        backend, "runtime_metadata_status", lambda: {"status": "metadata-matches-unverified"}
    )
    monkeypatch.setenv("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
    with pytest.raises(backend.PumaBackendError, match="Unsafe Torch serialization"):
        backend._import_runtime()


def test_loader_never_adds_globals_and_always_requests_weights_only_cpu():
    calls = []

    def load(stream, **kwargs):
        calls.append(kwargs)
        return {"unsafe_extra": "not-a-network"}

    fake = SimpleNamespace(serialization=SimpleNamespace(get_safe_globals=lambda: []), load=load)
    with pytest.raises(backend.PumaBackendError, match="unexpected root"):
        backend._load_network(fake, None, None)
    assert calls == [{"map_location": "cpu", "weights_only": True}]
    fake.serialization.get_safe_globals = lambda: [object]
    with pytest.raises(backend.PumaBackendError, match="Extra serialization globals"):
        backend._load_network(fake, None, None)
    assert len(calls) == 1


@pytest.fixture
def torch_runtime():
    if os.environ.get("LOCI_PUMA_TORCH_TESTS") != "1":
        pytest.skip("Requires the lead-owned explicit Torch test slot")
    torch = pytest.importorskip("torch")
    gaussian_filter = pytest.importorskip("scipy.ndimage").gaussian_filter
    with backend._torch_cpu_execution(torch):
        yield torch, gaussian_filter


def test_pinned_torch_defaults_are_removed_only_for_the_load_window(torch_runtime):
    torch, _ = torch_runtime
    before = torch.serialization.get_safe_globals()
    assert len(before) == 14  # Four at import, ten on entering Torch autocast.
    with backend._tensor_only_loading(torch):
        assert torch.serialization.get_safe_globals() == []
    assert {id(x) for x in torch.serialization.get_safe_globals()} == {id(x) for x in before}
    with pytest.raises(RuntimeError, match="load failed"), backend._tensor_only_loading(torch):
        assert torch.serialization.get_safe_globals() == []
        raise RuntimeError("load failed")
    assert {id(x) for x in torch.serialization.get_safe_globals()} == {id(x) for x in before}


def test_unexpected_globals_are_never_permitted_or_silently_discarded(torch_runtime):
    torch, _ = torch_runtime
    before = torch.serialization.get_safe_globals()
    try:
        torch.serialization.add_safe_globals([object])
        with (
            pytest.raises(backend.PumaBackendError, match="Extra serialization globals"),
            backend._tensor_only_loading(torch),
        ):
            pytest.fail("Untrusted safe globals reached the load window")
        assert object in torch.serialization.get_safe_globals()
        torch.serialization.clear_safe_globals()
        torch.serialization.add_safe_globals(before)
        with (
            pytest.raises(backend.PumaBackendError, match="changed during tensor-only"),
            backend._tensor_only_loading(torch),
        ):
            torch.serialization.add_safe_globals([object])
        after = torch.serialization.get_safe_globals()
        assert object in after
        assert all(value in after for value in before)
    finally:
        torch.serialization.clear_safe_globals()
        torch.serialization.add_safe_globals(before)


def _stub_network(torch, *, value=3.0):
    calls = []

    def network(patch):
        calls.append(tuple(patch.shape))
        result = torch.zeros((1, 6, 512, 512), dtype=torch.float32, device="cpu")
        result[:, 4] = value + patch[:, 0]
        return result

    return network, calls


def test_mirror_order_and_unflip_use_all_four_exact_variants(torch_runtime):
    torch, _ = torch_runtime
    patch = torch.zeros((1, 3, 512, 512), dtype=torch.float32)
    patch[:, 0] = torch.arange(512, dtype=torch.float32)[None, :] / 512
    positions = (torch.arange(512)[:, None] + torch.arange(512)[None, :]).float() / 512
    calls = []

    def network(value):
        calls.append(value.clone())
        output = torch.zeros((1, 6, 512, 512), dtype=torch.float32)
        output[:, 4] = value[:, 0] + positions
        return output

    actual = backend._prediction(torch, network, patch, None)
    assert len(calls) == 4
    for index, axes in enumerate(((), (2,), (3,), (2, 3))):
        assert torch.equal(calls[index], torch.flip(patch, axes) if axes else patch)
    assert torch.equal(actual[4], patch[0, 0] + 511 / 512)


def test_gaussian_dtype_scale_and_zero_replacement(torch_runtime):
    torch, gaussian_filter = torch_runtime
    importance = backend._gaussian(torch, gaussian_filter)
    assert importance.dtype is torch.float16
    assert tuple(importance.shape) == (512, 512)
    assert importance.max().item() == 10
    assert bool((importance > 0).all().item())
    assert importance[256, 255] == importance[256, 257]
    assert bool(torch.isfinite(importance).all().item())


def test_roi_stitch_matches_full_context_crop_with_stub_network(torch_runtime):
    torch, gaussian_filter = torch_runtime
    rgb = np.arange(520 * 520 * 3, dtype=np.uint32).reshape(520, 520, 3).astype(np.uint8)
    importance = backend._gaussian(torch, gaussian_filter)
    padded, full_record = backend._prepare(rgb, _request(520, 520), PUMA_MIN_WORKING_BYTES, None)
    _, roi_record = backend._prepare(
        rgb, _request(520, 520, [300, 300, 16, 32]), PUMA_MIN_WORKING_BYTES, None
    )
    network, calls = _stub_network(torch)
    full = backend._infer_tiles(
        torch, network, padded, full_record["tiles"], importance, check=None, progress=None
    )
    roi = backend._infer_tiles(
        torch, network, padded, roi_record["tiles"], importance, check=None, progress=None
    )
    assert len(calls) == 4 * (
        full_record["tiles"]["evaluated_tile_count"] + roi_record["tiles"]["evaluated_tile_count"]
    )
    for name in full:
        expected = full[name][..., 300:316, 300:332]
        np.testing.assert_array_equal(roi[name], expected)
    assert roi["probabilities"].shape == (6, 16, 32)
    assert roi["logits"].dtype == np.float16
    assert roi["probabilities"].dtype == np.float32
    assert np.all(roi["class_labels"] == 4)


def test_outside_crop_is_background_without_calling_network(torch_runtime):
    torch, gaussian_filter = torch_runtime
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    rgb[100:200, 100:200] = 127
    padded, record = backend._prepare(
        rgb, _request(512, 512, [0, 0, 8, 8]), PUMA_MIN_WORKING_BYTES, None
    )

    def unexpected(_patch):
        raise AssertionError("Output outside the crop should require no model tile")

    arrays = backend._infer_tiles(
        torch,
        unexpected,
        padded,
        record["tiles"],
        backend._gaussian(torch, gaussian_filter),
        check=None,
        progress=None,
    )
    assert np.all(arrays["class_labels"] == 0)
    assert not arrays["computed_mask"].any()
    assert np.all(arrays["probabilities"][0] == 1)
    assert np.all(arrays["probabilities"][1:] == 0)


def test_cancellation_between_mirrors_prevents_additional_network_calls(torch_runtime):
    torch, _ = torch_runtime
    network, calls = _stub_network(torch)

    def cancel_after_first():
        if calls:
            raise InterruptedError("revoked")

    with pytest.raises(InterruptedError, match="revoked"):
        backend._prediction(torch, network, torch.zeros((1, 3, 512, 512)), cancel_after_first)
    assert len(calls) == 1


@pytest.mark.parametrize("mode", ["float64", "nan", "wrong-shape"])
def test_invalid_network_output_is_refused(torch_runtime, mode):
    torch, _ = torch_runtime

    def network(_patch):
        value = torch.zeros((1, 6, 512, 512), dtype=torch.float32)
        if mode == "float64":
            return value.double()
        if mode == "nan":
            value[0, 0, 0, 0] = float("nan")
        return value[..., :1] if mode == "wrong-shape" else value

    with pytest.raises(backend.PumaBackendError, match="invalid or nonfinite"):
        backend._prediction(torch, network, torch.zeros((1, 3, 512, 512)), None)


def test_half_overflow_refuses_instead_of_promoting_precision(torch_runtime):
    torch, gaussian_filter = torch_runtime
    rgb = np.ones((64, 64, 3), dtype=np.uint8)
    padded, record = backend._prepare(rgb, _request(64, 64), PUMA_MIN_WORKING_BYTES, None)
    network, _ = _stub_network(torch, value=1e6)
    with pytest.raises(backend.PumaBackendError, match="half accumulation overflowed"):
        backend._infer_tiles(
            torch,
            network,
            padded,
            record["tiles"],
            backend._gaussian(torch, gaussian_filter),
            check=None,
            progress=None,
        )


def _fake_full_backend(monkeypatch, tmp_path, torch_runtime):
    torch, gaussian_filter = torch_runtime
    weights = _small_verified_weights(monkeypatch, tmp_path)
    network, calls = _stub_network(torch)
    monkeypatch.setattr(
        backend, "runtime_metadata_status", lambda: {"status": "metadata-matches-unverified"}
    )
    monkeypatch.setattr(
        backend, "_import_runtime", lambda: (torch, gaussian_filter, {"test_stub": True})
    )
    monkeypatch.setattr(backend, "_load_network", lambda *_args: (network, {"test_stub": True}))
    return weights, calls


def test_full_entry_returns_only_unadopted_readonly_arrays_with_no_paths(
    monkeypatch, tmp_path, torch_runtime
):
    weights, calls = _fake_full_backend(monkeypatch, tmp_path, torch_runtime)
    result = backend.infer_puma(
        np.ones((64, 64, 3), dtype=np.uint8),
        _request(64, 64),
        weights=weights,
        working_bytes=PUMA_MIN_WORKING_BYTES,
    )
    assert len(calls) == 4
    assert result.record["adopted"] is False
    assert result.record["status"] == "executed-not-qualified"
    assert result.record["execution"]["selected_class"] == 4
    assert result.record["execution"]["scores_are_validated_confidence"] is False
    assert all(not array.flags.writeable for array in result.arrays.values())
    assert str(tmp_path) not in repr(result.record)
    assert not backend._EXECUTION_LOCK.locked()


@pytest.mark.parametrize("mutation", ["source", "weights"])
def test_final_source_and_weights_rechecks_prevent_return_on_mutation(
    monkeypatch, tmp_path, torch_runtime, mutation
):
    weights, _ = _fake_full_backend(monkeypatch, tmp_path, torch_runtime)
    rgb = np.ones((64, 64, 3), dtype=np.uint8)

    def mutate(_completed, _total):
        if mutation == "source":
            rgb[0, 0, 0] = 2
        else:
            weights.path.write_bytes(b"X" * weights.size_bytes)

    with pytest.raises(backend.PumaBackendError, match="changed"):
        backend.infer_puma(
            rgb,
            _request(64, 64),
            weights=weights,
            working_bytes=PUMA_MIN_WORKING_BYTES,
            progress=mutate,
        )
    assert not backend._EXECUTION_LOCK.locked()


def test_tampered_plan_coverage_is_refused(torch_runtime):
    torch, gaussian_filter = torch_runtime
    rgb = np.ones((64, 64, 3), dtype=np.uint8)
    padded, record = backend._prepare(rgb, _request(64, 64), PUMA_MIN_WORKING_BYTES, None)
    plan = copy.deepcopy(record["tiles"])
    plan["tiles"] = []
    network, _ = _stub_network(torch)
    with pytest.raises(backend.PumaBackendError, match="tile coverage"):
        backend._infer_tiles(
            torch,
            network,
            padded,
            plan,
            backend._gaussian(torch, gaussian_filter),
            check=None,
            progress=None,
        )
