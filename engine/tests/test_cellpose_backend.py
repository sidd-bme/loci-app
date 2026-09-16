from __future__ import annotations

import hashlib
import json
import os
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import numpy as np
import pytest
from PIL import Image, ImageDraw

import loci_engine.cellpose_backend as backend
from loci_engine.profiles import (
    CELLPOSE_PROFILE_ID,
    CELLPOSE_WEBSITE_PROFILE_ID,
    profile_from_manifest,
)
from loci_engine.results import RESULT_CACHE
from loci_engine.worker import handle_request


@pytest.fixture(autouse=True)
def _isolate_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("loci_engine.compute_resources.available_host_memory", lambda: 16 * 1024**3)
    monkeypatch.setenv(backend.MODEL_HOME_ENV, str(tmp_path / "model-home"))
    backend.clear_model_cache()
    with backend._HASH_CACHE_LOCK:
        backend._HASH_CACHE.clear()
    RESULT_CACHE.clear()
    yield
    backend.clear_model_cache()
    with backend._HASH_CACHE_LOCK:
        backend._HASH_CACHE.clear()
    RESULT_CACHE.clear()


def _fake_spec(
    monkeypatch: pytest.MonkeyPatch,
    *,
    profile_id: str = CELLPOSE_PROFILE_ID,
    content: bytes,
) -> backend.CellposeModelSpec:
    original = backend.resolve_cellpose_model_spec(profile_id)
    spec = replace(
        original,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )
    specs = dict(backend.CELLPOSE_MODEL_SPECS)
    specs[profile_id] = spec
    monkeypatch.setattr(backend, "CELLPOSE_MODEL_SPECS", MappingProxyType(specs))
    return spec


def _fake_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
    *,
    profile_id: str = CELLPOSE_PROFILE_ID,
    content: bytes | None = None,
) -> tuple[bytes, Path]:
    content = content or f"small deterministic {profile_id} test checkpoint".encode()
    spec = _fake_spec(monkeypatch, profile_id=profile_id, content=content)
    path = backend.managed_model_path(spec)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return content, path


def _image() -> np.ndarray:
    image = Image.new("L", (160, 100), color=16)
    draw = ImageDraw.Draw(image)
    draw.ellipse((20, 20, 58, 58), fill=230)
    draw.ellipse((96, 36, 138, 78), fill=210)
    return np.asarray(image)


class _FakeTorch:
    def __init__(self, *, mps: bool, cuda: bool = False) -> None:
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))
        self.cuda = SimpleNamespace(
            is_available=lambda: cuda, mem_get_info=lambda: (8 * 1024**3, 16 * 1024**3)
        )
        self.mps = SimpleNamespace(
            recommended_max_memory=lambda: 16 * 1024**3, driver_allocated_memory=lambda: 0
        )

    @staticmethod
    def device(name: str) -> str:
        return name


class _FakeCellposeModels:
    def __init__(
        self,
        calls: list[dict[str, object]],
        *,
        expected_artifact_id: str = backend.CELLPOSE_MODEL_ID,
        fail_mps: bool = False,
    ) -> None:
        class FakeModel:
            def __init__(
                self,
                *,
                pretrained_model: str,
                device: str,
                use_bfloat16: bool,
            ) -> None:
                assert Path(pretrained_model).is_absolute()
                assert Path(pretrained_model).is_file()
                assert Path(pretrained_model).name == expected_artifact_id
                assert use_bfloat16 is True
                self.device = device

            def eval(self, image: np.ndarray, **kwargs: object) -> tuple[np.ndarray, list, list]:
                calls.append(
                    {
                        "device": self.device,
                        "shape": image.shape,
                        "dtype": str(image.dtype),
                        **kwargs,
                    }
                )
                if fail_mps and self.device == "mps":
                    raise RuntimeError("simulated MPS operator failure")
                labels = np.zeros(image.shape[:2], dtype=np.int32)
                labels[5:15, 5:15] = 1
                labels[20:30, 35:48] = 2
                return labels, [], []

        self.CellposeModel = FakeModel
        self.cache_model_path = lambda _name: pytest.fail(
            "Cellpose download fallback must never be called"
        )


def test_model_construction_disables_cellpose_download_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, path = _fake_checkpoint(monkeypatch)
    spec = backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)

    class DownloadingFallback:
        @staticmethod
        def cache_model_path(_name: str) -> str:
            return "unexpected-download"

        class CellposeModel:
            def __init__(self, *, pretrained_model: str, **_kwargs: object) -> None:
                Path(pretrained_model).unlink()
                DownloadingFallback.cache_model_path("cpsam_v2")

    with pytest.raises(RuntimeError, match="downloads are disabled"):
        backend._model_for_device(
            DownloadingFallback,
            _FakeTorch(mps=False),
            spec,
            path,
            "cpu",
        )

    assert DownloadingFallback.cache_model_path("cpsam_v2") == "unexpected-download"


def test_official_cellpose_pin_and_checkpoint_identity_are_exact() -> None:
    assert backend.CELLPOSE_PACKAGE_VERSION == "4.2.1.1"
    assert backend.CELLPOSE_MODEL_ID == "cpsam_v2"
    assert backend.CELLPOSE_MODEL_SIZE_BYTES == 1_233_586_851
    assert (
        backend.CELLPOSE_MODEL_SHA256
        == "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667"
    )
    website = backend.resolve_cellpose_model_spec(CELLPOSE_WEBSITE_PROFILE_ID)
    assert website.artifact_id == "cpsam"
    assert website.size_bytes == 1_233_587_898
    assert website.sha256 == ("e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2")
    v2 = backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    assert v2.artifact_id == backend.CELLPOSE_MODEL_ID
    assert v2.size_bytes == backend.CELLPOSE_MODEL_SIZE_BYTES
    assert v2.sha256 == backend.CELLPOSE_MODEL_SHA256


def test_status_is_actionable_and_does_not_import_cellpose(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backend, "_installed_cellpose_version", lambda: None)
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: pytest.fail("status must not import an absent Cellpose runtime"),
    )

    response = handle_request({"id": "status", "method": "cellpose_status", "params": {}})

    status = response["result"]
    assert status["ready"] is False
    assert status["code"] == "package-missing"
    assert status["package"] == {
        "required_version": "4.2.1.1",
        "installed_version": None,
        "exact": False,
    }
    assert status["model"]["artifact_id"] == "cpsam_v2"
    assert status["model"]["present"] is False
    assert status["devices"] == {"cpu": None, "mps": None, "cuda": None}


def test_status_endpoint_is_profile_scoped_and_rejects_unknown_profiles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backend, "_installed_cellpose_version", lambda: None)

    website = handle_request(
        {
            "id": "website-status",
            "method": "cellpose_status",
            "params": {"profile_id": CELLPOSE_WEBSITE_PROFILE_ID},
        }
    )["result"]
    unknown = handle_request(
        {
            "id": "unknown-status",
            "method": "cellpose_status",
            "params": {"profile_id": "cellpose-unknown"},
        }
    )

    assert website["profile_id"] == CELLPOSE_WEBSITE_PROFILE_ID
    assert website["model"]["artifact_id"] == "cpsam"
    assert Path(website["model"]["managed_path"]).name == "cpsam"
    assert unknown["error"] == {
        "type": "ValueError",
        "message": "Unknown Cellpose profile: cellpose-unknown",
    }


@pytest.mark.parametrize("inspect_devices", [False, True])
def test_status_never_reports_ready_when_exact_runtime_cannot_be_imported(
    monkeypatch: pytest.MonkeyPatch,
    inspect_devices: bool,
) -> None:
    _fake_checkpoint(monkeypatch)
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )

    def fail_import() -> tuple[object, object]:
        raise ImportError("simulated missing native runtime")

    monkeypatch.setattr(backend, "_import_runtime", fail_import)

    status = backend.get_cellpose_status(inspect_devices=inspect_devices).to_dict()

    assert status["ready"] is False
    assert status["code"] == "runtime-import-failed"
    assert "ImportError" in status["summary"]
    assert status["package"] == {
        "required_version": "4.2.1.1",
        "installed_version": "4.2.1.1",
        "exact": True,
    }
    assert status["model"]["present"] is True
    assert status["model"]["verified"] is True
    assert status["devices"] == {"cpu": None, "mps": None, "cuda": None}


def test_runtime_import_failure_preserves_missing_model_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (_ for _ in ()).throw(OSError("simulated loader failure")),
    )

    status = backend.get_cellpose_status(inspect_devices=True).to_dict()

    assert status["ready"] is False
    assert status["code"] == "runtime-import-failed"
    assert status["package"]["exact"] is True
    assert status["model"]["present"] is False
    assert status["model"]["verified"] is False
    assert status["devices"] == {"cpu": None, "mps": None, "cuda": None}


def test_import_copies_only_a_verified_checkpoint_atomically(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    content = b"user selected cpsam_v2 checkpoint"
    spec = _fake_spec(monkeypatch, content=content)
    monkeypatch.setattr(backend, "_installed_cellpose_version", lambda: None)
    source = tmp_path / "downloaded-cpsam_v2"
    source.write_bytes(content)

    response = handle_request(
        {
            "id": "import",
            "method": "import_cellpose_model",
            "params": {"path": str(source.resolve())},
        }
    )

    assert "error" not in response
    status = response["result"]
    destination = backend.managed_model_path(spec)
    assert destination.read_bytes() == content
    assert source.read_bytes() == content
    assert status["model"]["verified"] is True
    assert status["ready"] is False
    assert status["code"] == "package-missing"
    if os.name != "nt":
        assert destination.stat().st_mode & 0o777 == 0o600


def test_import_rejects_wrong_digest_without_publishing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    content = b"not the expected checkpoint"
    original = backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    spec = replace(original, size_bytes=len(content), sha256="a" * 64)
    specs = dict(backend.CELLPOSE_MODEL_SPECS)
    specs[CELLPOSE_PROFILE_ID] = spec
    monkeypatch.setattr(backend, "CELLPOSE_MODEL_SPECS", MappingProxyType(specs))
    source = tmp_path / "wrong-cpsam_v2"
    source.write_bytes(content)

    response = handle_request(
        {
            "id": "import",
            "method": "import_cellpose_model",
            "params": {"path": str(source.resolve())},
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert "not the verified official" in response["error"]["message"]
    assert not backend.managed_model_path(spec).exists()


def test_import_rejects_other_supported_profiles_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    website_content = b"w" * 32
    v2_content = b"v" * 32
    website_spec = replace(
        backend.resolve_cellpose_model_spec(CELLPOSE_WEBSITE_PROFILE_ID),
        size_bytes=len(website_content),
        sha256=hashlib.sha256(website_content).hexdigest(),
    )
    v2_spec = replace(
        backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID),
        size_bytes=len(v2_content),
        sha256=hashlib.sha256(v2_content).hexdigest(),
    )
    monkeypatch.setattr(
        backend,
        "CELLPOSE_MODEL_SPECS",
        MappingProxyType(
            {
                CELLPOSE_WEBSITE_PROFILE_ID: website_spec,
                CELLPOSE_PROFILE_ID: v2_spec,
            }
        ),
    )
    monkeypatch.setattr(backend, "_installed_cellpose_version", lambda: None)
    source = tmp_path / "valid-cpsam"
    source.write_bytes(website_content)

    rejected = handle_request(
        {
            "id": "wrong-profile",
            "method": "import_cellpose_model",
            "params": {"path": str(source), "profile_id": CELLPOSE_PROFILE_ID},
        }
    )

    assert rejected["error"]["type"] == "ValueError"
    assert "for this profile" in rejected["error"]["message"]
    assert not backend.managed_model_path(v2_spec).exists()

    accepted = handle_request(
        {
            "id": "website-profile",
            "method": "import_cellpose_model",
            "params": {"path": str(source), "profile_id": CELLPOSE_WEBSITE_PROFILE_ID},
        }
    )
    assert "error" not in accepted
    assert accepted["result"]["profile_id"] == CELLPOSE_WEBSITE_PROFILE_ID
    assert accepted["result"]["model"]["artifact_id"] == "cpsam"
    assert backend.managed_model_path(website_spec).read_bytes() == website_content


def test_dynamic_profile_reports_exact_runtime_and_model_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_checkpoint(monkeypatch)
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (SimpleNamespace(), _FakeTorch(mps=False)),
    )

    spec = backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    response = handle_request(
        {
            "id": "profile",
            "method": "inspect_profile",
            "params": {"profile_id": CELLPOSE_PROFILE_ID},
        }
    )

    profile = response["result"]
    assert profile["status"] == "ready"
    assert profile["availability"]["code"] == "ready"
    assert profile["version"] == "4.2.1.1"
    assert profile["model"] == {
        "format": "cellpose-native",
        "artifact_id": "cpsam_v2",
        "sha256": spec.sha256,
    }
    assert profile["recommended_settings"]["max_edge_px"] == 1000
    assert profile["recommended_settings"]["niter"] == 250
    assert profile["recommended_settings"]["flow_threshold"] == 0.4
    assert profile["recommended_settings"]["cellprob_threshold"] == 0.0
    assert {control["key"] for control in profile["settings_contract"]} == set(
        profile["recommended_settings"]
    )
    assert profile["rights"]["commercial_use"] == "restricted"
    assert "CC-BY-NC" in profile["rights"]["training_data_lineage"]
    assert profile_from_manifest(profile).to_dict() == profile


def test_website_profile_is_explicitly_recommended_and_uses_distinct_model_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_checkpoint(monkeypatch, profile_id=CELLPOSE_WEBSITE_PROFILE_ID)
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (SimpleNamespace(), _FakeTorch(mps=False)),
    )

    profile = handle_request(
        {
            "id": "website-profile",
            "method": "inspect_profile",
            "params": {"profile_id": CELLPOSE_WEBSITE_PROFILE_ID},
        }
    )["result"]

    spec = backend.resolve_cellpose_model_spec(CELLPOSE_WEBSITE_PROFILE_ID)
    assert profile["status"] == "ready"
    assert profile["name"] == "Cellpose-SAM · Website compatible"
    assert profile["model"] == {
        "format": "cellpose-native",
        "artifact_id": "cpsam",
        "sha256": spec.sha256,
    }
    assert "Recommended for parity" in profile["validation"]["summary"]
    assert profile["recommended_settings"]["max_edge_px"] == 1000
    assert profile["recommended_settings"]["niter"] == 250
    assert profile["recommended_settings"]["flow_threshold"] == 0.4
    assert profile["recommended_settings"]["cellprob_threshold"] == 0.0
    assert profile_from_manifest(profile).to_dict() == profile


def test_corrupt_managed_checkpoint_is_a_profile_validation_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = backend.managed_model_path()
    path.parent.mkdir(parents=True)
    path.write_bytes(b"truncated")
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (SimpleNamespace(), _FakeTorch(mps=False)),
    )

    response = handle_request(
        {
            "id": "profile",
            "method": "inspect_profile",
            "params": {"profile_id": CELLPOSE_PROFILE_ID},
        }
    )

    profile = response["result"]
    assert profile["status"] == "validation_failed"
    assert profile["availability"]["code"] == "model-size-mismatch"


def test_cellpose_segmentation_uses_verified_path_current_api_and_source_grid(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _fake_checkpoint(monkeypatch)
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    calls: list[dict[str, object]] = []
    fake_models = _FakeCellposeModels(calls)
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (fake_models, _FakeTorch(mps=True)),
    )
    path = tmp_path / "cells.png"
    Image.fromarray(_image()).save(path)

    response = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {
                "path": str(path),
                "profile_id": CELLPOSE_PROFILE_ID,
                "settings": {"max_edge_px": 64},
            },
        }
    )

    assert "error" not in response
    result = response["result"]
    assert result["cell_count"] == 2
    assert result["profile"]["id"] == CELLPOSE_PROFILE_ID
    assert result["engine"] == {"id": CELLPOSE_PROFILE_ID, "version": "0.1.0"}
    assert result["runtime"]["requested_device"] == "auto"
    assert result["runtime"]["resolved_device"] == "mps"
    assert result["runtime"]["fallback_reason"] is None
    assert result["runtime"]["profile_id"] == CELLPOSE_PROFILE_ID
    assert result["runtime"]["model"]["artifact_id"] == "cpsam_v2"
    assert result["runtime"]["preprocessing_mode"] == "huggingface-space-uint8"
    assert result["settings"]["niter"] == 250
    cached = RESULT_CACHE.get(result["result_id"])
    assert cached.output.labels.shape == (100, 160)
    assert cached.output.normalized.shape == (100, 160)

    assert len(calls) == 1
    call = calls[0]
    assert call["device"] == "mps"
    assert call["shape"] == (40, 64, 3)
    assert call["dtype"] == "uint8"
    assert call["channel_axis"] == -1
    assert call["niter"] == 250
    assert call["flow_threshold"] == 0.4
    assert call["cellprob_threshold"] == 0.0
    assert call["bsize"] == 256
    assert call["do_3D"] is False
    assert "channels" not in call
    assert "model_type" not in call
    assert "rescale" not in call
    assert "interp" not in call

    exported = handle_request(
        {
            "id": "export",
            "method": "export",
            "params": {
                "result_id": result["result_id"],
                "directory": str(tmp_path),
                "basename": "cellpose-result",
                "options": {"analysis_json": True},
            },
        }
    )["result"]
    analysis = json.loads(Path(exported["files"]["analysis"]).read_text(encoding="utf-8"))
    assert analysis["profile"]["id"] == CELLPOSE_PROFILE_ID
    assert analysis["runtime"] == result["runtime"]
    assert analysis["settings"]["niter"] == 250


def test_website_profile_dispatches_cpsam_identity_and_provenance(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _fake_checkpoint(monkeypatch, profile_id=CELLPOSE_WEBSITE_PROFILE_ID)
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    calls: list[dict[str, object]] = []
    fake_models = _FakeCellposeModels(calls, expected_artifact_id="cpsam")
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (fake_models, _FakeTorch(mps=True)),
    )
    path = tmp_path / "cells.png"
    Image.fromarray(_image()).save(path)

    response = handle_request(
        {
            "id": "segment-website",
            "method": "segment",
            "params": {
                "path": str(path),
                "profile_id": CELLPOSE_WEBSITE_PROFILE_ID,
                "settings": {"max_edge_px": 64},
            },
        }
    )

    assert "error" not in response
    result = response["result"]
    spec = backend.resolve_cellpose_model_spec(CELLPOSE_WEBSITE_PROFILE_ID)
    assert result["profile"]["id"] == CELLPOSE_WEBSITE_PROFILE_ID
    assert result["profile"]["model"] == {
        "format": "cellpose-native",
        "artifact_id": "cpsam",
        "sha256": spec.sha256,
    }
    assert result["runtime"]["profile_id"] == CELLPOSE_WEBSITE_PROFILE_ID
    assert result["runtime"]["model"] == {
        "artifact_id": "cpsam",
        "sha256": spec.sha256,
    }
    assert result["runtime"]["preprocessing_mode"] == "huggingface-space-uint8"
    assert calls[0]["shape"] == (40, 64, 3)
    assert calls[0]["dtype"] == "uint8"
    assert calls[0]["channel_axis"] == -1


def test_dtype_conditional_preprocessing_matches_space_and_preserves_high_bit_depth() -> None:
    import cv2

    rng = np.random.default_rng(42)
    uint8_image = rng.integers(0, 256, size=(73, 131, 3), dtype=np.uint8)
    prepared_uint8, scale_uint8, mode_uint8 = backend._prepare_for_model(uint8_image, 64)
    expected_uint8 = cv2.resize(uint8_image, (64, int(73 / 131 * 64))).astype(np.uint8)

    assert mode_uint8 == "huggingface-space-uint8"
    assert scale_uint8 == pytest.approx(64 / 131)
    assert prepared_uint8.dtype == np.uint8
    assert np.array_equal(prepared_uint8, expected_uint8)

    uint16_image = uint8_image.astype(np.uint16) * 257
    prepared_uint16, scale_uint16, mode_uint16 = backend._prepare_for_model(uint16_image, 64)
    expected_uint16, expected_scale = backend._prepare_image(uint16_image, 64)

    assert mode_uint16 == "dynamic-range-preserving"
    assert scale_uint16 == expected_scale
    assert prepared_uint16.dtype == np.float32
    assert np.array_equal(prepared_uint16, expected_uint16)
    assert float(prepared_uint16.max()) > np.iinfo(np.uint8).max


def test_space_preprocessing_preserves_grayscale_support_after_exact_pixel_transform() -> None:
    import cv2

    grayscale = np.arange(73 * 131, dtype=np.uint8).reshape(73, 131)
    prepared, scale, mode = backend._prepare_for_model(grayscale, 64)
    expected_plane = cv2.resize(grayscale, (64, int(73 / 131 * 64))).astype(np.uint8)

    assert mode == "huggingface-space-uint8"
    assert scale == pytest.approx(64 / 131)
    assert prepared.shape == (*expected_plane.shape, 3)
    assert prepared.dtype == np.uint8
    assert np.array_equal(prepared[..., 0], expected_plane)
    assert np.array_equal(prepared[..., 1], expected_plane)
    assert np.array_equal(prepared[..., 2], expected_plane)


def test_space_grid_restore_preserves_labels_above_uint16() -> None:
    labels = np.array([[0, 1], [65_536, 70_000]], dtype=np.int32)

    restored = backend._restore_labels_to_source_grid(
        labels,
        (4, 4),
        "huggingface-space-uint8",
    )

    assert restored.dtype == np.int32
    assert set(np.unique(restored)) == {0, 1, 65_536, 70_000}


def test_model_cache_never_reuses_a_checkpoint_across_profiles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, website_path = _fake_checkpoint(
        monkeypatch,
        profile_id=CELLPOSE_WEBSITE_PROFILE_ID,
    )
    _, v2_path = _fake_checkpoint(monkeypatch, profile_id=CELLPOSE_PROFILE_ID)
    website_spec = backend.resolve_cellpose_model_spec(CELLPOSE_WEBSITE_PROFILE_ID)
    v2_spec = backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    constructions: list[str] = []

    class FakeModels:
        cache_model_path = staticmethod(lambda _name: "unused")

        class CellposeModel:
            def __init__(self, *, pretrained_model: str, **_kwargs: object) -> None:
                constructions.append(Path(pretrained_model).name)

    torch = _FakeTorch(mps=False)
    website_model = backend._model_for_device(
        FakeModels,
        torch,
        website_spec,
        website_path,
        "cpu",
    )
    v2_model = backend._model_for_device(
        FakeModels,
        torch,
        v2_spec,
        v2_path,
        "cpu",
    )
    cached_v2_model = backend._model_for_device(
        FakeModels,
        torch,
        v2_spec,
        v2_path,
        "cpu",
    )

    assert constructions == ["cpsam", "cpsam_v2"]
    assert website_model is not v2_model
    assert cached_v2_model is v2_model


def test_mps_runtime_failure_retries_once_on_cpu(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _fake_checkpoint(monkeypatch)
    monkeypatch.setattr(
        backend,
        "_installed_cellpose_version",
        lambda: backend.CELLPOSE_PACKAGE_VERSION,
    )
    calls: list[dict[str, object]] = []
    fake_models = _FakeCellposeModels(calls, fail_mps=True)
    monkeypatch.setattr(
        backend,
        "_import_runtime",
        lambda: (fake_models, _FakeTorch(mps=True)),
    )
    path = tmp_path / "cells.png"
    Image.fromarray(_image()).save(path)

    response = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {"path": str(path), "profile_id": CELLPOSE_PROFILE_ID},
        }
    )

    runtime = response["result"]["runtime"]
    assert [call["device"] for call in calls] == ["mps", "cpu"]
    assert runtime["resolved_device"] == "cpu"
    assert "retried on CPU" in runtime["fallback_reason"]


def test_non_ready_cellpose_profile_fails_before_reading_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backend, "_installed_cellpose_version", lambda: None)

    response = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {
                "path": "/source-must-not-be-read.png",
                "profile_id": CELLPOSE_PROFILE_ID,
            },
        }
    )

    assert response["error"]["type"] == "RuntimeError"
    assert "is not ready" in response["error"]["message"]
