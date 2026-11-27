from __future__ import annotations

import hashlib
import json
from base64 import b64decode
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import tifffile
from PIL import Image

import loci_engine.cellpose_backend as cellpose_backend
import loci_engine.research_cellpose as research_cellpose
from loci_engine.cellpose_backend import (
    CELLPOSE_MODEL_ID,
    CELLPOSE_MODEL_SHA256,
    CELLPOSE_PACKAGE_VERSION,
    CELLPOSE_SAM_V2_SPEC,
    CellposeBackendStatus,
)
from loci_engine.models import CellposeSettings
from loci_engine.research_cellpose import (
    CELLPOSE_MODEL_STATUS_SCHEMA,
    CELLPOSE_PREVIEW_SCHEMA,
    CELLPOSE_PROVENANCE_PREVIEW_KEY,
    _prune_unadopted_cellpose_previews,
    cellpose_preview_request,
    cellpose_result_pins,
    estimate_cellpose_memory_bytes,
    inspect_cellpose_model_status,
    installed_cellpose_pins,
    verify_cellpose_review_installation,
)
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_models import PREVIEW_SCHEMA, _prune_unadopted_model_previews
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_task_preview import get_preview
from loci_engine.workbench import Workbench


class _Record:
    def __init__(self, value: dict):
        self.value = value

    def to_dict(self) -> dict:
        return dict(self.value)


class _ReadyCellposeProfile:
    id = "cellpose-sam-v2"
    backend_kind = "cellpose"
    recommended_settings = CellposeSettings()
    model = _Record(
        {
            "format": "cellpose-native",
            "artifact_id": CELLPOSE_MODEL_ID,
            "sha256": CELLPOSE_MODEL_SHA256,
        }
    )
    rights = _Record(
        {
            "code_license": "BSD-3-Clause",
            "model_license": "declared-with-lineage-caveat",
            "redistribution": "unknown",
            "commercial_use": "restricted",
            "training_data_lineage": "declared upstream; independently unverified",
        }
    )
    validation = _Record(
        {
            "status": "limited",
            "summary": "Technical fixture only.",
            "failure_modes": [],
        }
    )

    def provenance_dict(self) -> dict:
        return {
            "id": self.id,
            "name": "Cellpose-SAM v2",
            "version": CELLPOSE_PACKAGE_VERSION,
            "backend_kind": self.backend_kind,
            "model": self.model.to_dict(),
            "preprocessing": {
                "channel_conversion": "rgb-or-replicated-grayscale",
                "intensity_normalization": "cellpose-configurable-percentile",
                "resize_policy": "downsample-only",
                "max_edge_px": 1000,
                "output_grid": "source-resolution",
            },
        }

    def to_dict(self) -> dict:
        return {
            **self.provenance_dict(),
            "recommended_settings": self.recommended_settings.to_dict(),
            "settings_contract": [],
            "rights": self.rights.to_dict(),
            "validation": self.validation.to_dict(),
            "status": "ready",
            "availability": {"code": "ready", "summary": "Ready."},
            "schema_version": "1.2",
        }


def _workbench(tmp_path: Path) -> Workbench:
    return Workbench(ResearchProject.create(tmp_path / "study", "Cellpose study"))


def _request(source_id: str, *, measurement_channels: list[int] | None = None) -> dict:
    return {
        "source_id": source_id,
        "selection": {
            "x": 0,
            "y": 0,
            "width": 14,
            "height": 12,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "profile_id": "cellpose-sam-v2",
        "settings": CellposeSettings(device="cpu").to_dict(),
        "measurement_channels": [0, 1] if measurement_channels is None else measurement_channels,
        "working_bytes": 32 * 1024**2,
    }


def _inference(image: np.ndarray) -> SimpleNamespace:
    labels = np.zeros(image.shape[:2], dtype=np.int32)
    labels[1:4, 2:5] = 1
    labels[7:10, 9:12] = 2
    normalized = np.mean(image[..., :3], axis=-1) if image.ndim == 3 else image
    normalized = np.asarray(normalized, dtype=np.float64)
    span = float(np.ptp(normalized))
    normalized = (
        np.zeros_like(normalized) if span == 0 else (normalized - float(normalized.min())) / span
    )
    return SimpleNamespace(
        output=SimpleNamespace(labels=labels, normalized=normalized, count=2),
        runtime={
            "package": {"name": "cellpose", "version": CELLPOSE_PACKAGE_VERSION},
            "model": {"artifact_id": CELLPOSE_MODEL_ID, "sha256": CELLPOSE_MODEL_SHA256},
            "profile_id": "cellpose-sam-v2",
            "preprocessing_mode": "dynamic-range-preserving",
            "requested_device": "cpu",
            "resolved_device": "cpu",
            "fallback_reason": None,
            "memory_preflight": {
                "required_bytes": 1234,
                "observations": [],
                "reservation": False,
                "estimate_policy": (
                    "cellpose-checkpoint-x2-plus-batch-32MiB-plane-64B-reserve-256MiB/v1"
                ),
            },
            "inference_scale": 1.0,
        },
    )


def _ready_backend_status(tmp_path: Path) -> CellposeBackendStatus:
    return CellposeBackendStatus(
        model_spec=CELLPOSE_SAM_V2_SPEC,
        ready=True,
        code="ready",
        summary="Ready.",
        installed_version=CELLPOSE_PACKAGE_VERSION,
        model_path=tmp_path / "private-models" / "cpsam_v2",
        model_present=True,
        model_verified=True,
        devices={"cpu": True, "mps": False, "cuda": False},
    )


def _patch_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    torch_version: str = "2.6.0+cpu",
) -> None:
    status = _ready_backend_status(tmp_path)
    monkeypatch.setattr(
        research_cellpose,
        "resolve_profile",
        lambda profile_id, require_ready=False: _ReadyCellposeProfile(),
    )
    monkeypatch.setattr(
        research_cellpose,
        "get_cellpose_status",
        lambda model=CELLPOSE_SAM_V2_SPEC, *, inspect_devices=False: status,
    )
    monkeypatch.setattr(
        research_cellpose,
        "_import_runtime",
        lambda: (SimpleNamespace(), SimpleNamespace(__version__=torch_version)),
    )
    monkeypatch.setattr(
        cellpose_backend,
        "segment_cellpose",
        lambda image, settings, model, *, working_bytes=None: _inference(image),
    )


def _array_sha256(array: np.ndarray) -> str:
    value = np.ascontiguousarray(array)
    digest = hashlib.sha256()
    digest.update(canonical_json({"shape": list(value.shape), "dtype": str(value.dtype)}).encode())
    digest.update(value.tobytes(order="C"))
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Legacy direct cellpose_run caller regression tests (preserved intact)
# ---------------------------------------------------------------------------


def test_local_cellpose_uses_registered_selection_and_raw_measurement_channels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    image = np.zeros((1, 2, 1, 12, 14), dtype=np.uint16)
    image[0, 0, 0, 1:4, 2:5] = 100
    image[0, 1, 0] = 200
    path = tmp_path / "channels.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={"axes": "TCZYX", "Channel": {"Name": ["Raw A", "Raw B"]}},
    )
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)

    response = workbench.execute("cellpose_run", _request(source["id"]))
    record = workbench.project.result(response["result"]["id"])

    assert response["result"]["object_count"] == 2
    assert response["accepted_request"]["input_mapping"] == {
        "mode": "source-channel",
        "channel": 0,
    }
    assert response["accepted_request"]["settings"] == CellposeSettings(device="cpu").to_dict()
    assert [row["intensity"]["source_channel_1"]["mean"] for row in response["measurements"]] == [
        200,
        200,
    ]
    assert record["provenance"]["measurement_basis"] == (
        "raw-selected-channel-values-on-result-grid"
    )
    assert record["provenance"]["runtime"]["cellpose"]["model"]["sha256"] == CELLPOSE_MODEL_SHA256
    assert (
        record["provenance"]["resource_guard"]["cellpose_memory_preflight"]["required_bytes"]
        == 1234
    )
    labels = workbench.project.load_array(record["arrays"]["labels"])
    assert labels.dtype == np.uint32

    binding = {
        "result_id": response["result"]["id"],
        "revision_hash": response["result"]["revision_hash"],
    }
    info = workbench.execute("correction_info", binding)
    corrected = workbench.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "delete",
                    "label": 1,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
            "working_bytes": 32 * 1024**2,
        },
    )
    assert set(corrected["measurements"][0]["intensity"]) == {
        "source_channel_0",
        "source_channel_1",
    }
    workbench.project.review(
        corrected["result"]["id"], corrected["result"]["revision_hash"], "reviewed"
    )
    exported = export_research_result(
        workbench.project,
        corrected["result"]["id"],
        corrected["result"]["revision_hash"],
        tmp_path / "cellpose-export",
    )
    assert exported["result_id"] == corrected["result"]["id"]
    reopened = Workbench(ResearchProject(workbench.project.root))
    restored = reopened.execute("result", {"result_id": corrected["result"]["id"]})
    assert restored["result"]["review"]["disposition"] == "reviewed"
    assert set(restored["measurements"][0]["intensity"]) == {
        "source_channel_0",
        "source_channel_1",
    }


def test_rgb_samples_are_passed_interleaved_and_never_measured_as_channels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    pixels = np.zeros((12, 14, 3), dtype=np.uint8)
    pixels[..., 1] = 80
    path = tmp_path / "rgb.png"
    Image.fromarray(pixels, mode="RGB").save(path)
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)
    observed: list[tuple[int, ...]] = []

    def segment(image, settings, model, *, working_bytes=None):
        observed.append(image.shape)
        return _inference(image)

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", segment)
    response = workbench.execute("cellpose_run", _request(source["id"], measurement_channels=[]))
    assert observed == [(12, 14, 3)]
    assert response["accepted_request"]["input_mapping"] == {"mode": "interleaved-rgb-samples"}

    with pytest.raises(ValueError, match="RGB samples"):
        workbench.execute("cellpose_run", _request(source["id"], measurement_channels=[0]))


def test_cellpose_request_is_exact_and_invalid_output_is_not_published(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)

    incomplete = _request(source["id"])
    incomplete["settings"].pop("invert")
    with pytest.raises(ValueError, match="every declared profile setting"):
        workbench.execute("cellpose_run", incomplete)

    def invalid(image, settings, model, *, working_bytes=None):
        inference = _inference(image)
        inference.output.normalized = np.asarray(inference.output.normalized, dtype=np.float64)
        inference.output.normalized[0, 0] = np.nan
        return inference

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", invalid)
    with pytest.raises(ValueError, match="selected 2D source grid"):
        workbench.execute("cellpose_run", _request(source["id"], measurement_channels=[0]))
    assert workbench.project.list_results() == []


def test_cellpose_rejects_aggregate_raw_channel_buffers_before_inference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    image = np.zeros((2, 1, 256, 256), dtype=np.uint16)
    path = tmp_path / "large-channels.ome.tif"
    tifffile.imwrite(path, image, ome=True, metadata={"axes": "CZYX"})
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)
    request = _request(source["id"])
    request["selection"].update(width=256, height=256)
    request["working_bytes"] = 8 * 1024**2
    called = False

    def segment(image, settings, model, *, working_bytes=None):
        nonlocal called
        called = True
        return _inference(image)

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", segment)
    with pytest.raises(ValueError, match="aggregate working-memory budget"):
        workbench.execute("cellpose_run", request)
    assert called is False
    assert workbench.project.list_results() == []


def test_cellpose_is_a_cancellable_durable_job_before_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)
    job = submit_job(
        workbench,
        _request(source["id"], measurement_channels=[0]),
        "cellpose-job-key",
        "cellpose_run",
    )

    cancelled = cancel_job(workbench.project, job["id"])
    response = run_job(workbench, job["id"])

    assert cancelled["state"] == "cancelled"
    assert response["job"]["state"] == "cancelled"
    assert workbench.project.list_results() == []


def test_cellpose_durable_job_publishes_only_while_its_job_is_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)
    job = submit_job(
        workbench,
        _request(source["id"], measurement_channels=[0]),
        "cellpose-success-key",
        "cellpose_run",
    )

    response = run_job(workbench, job["id"])
    record = workbench.project.result(response["result"]["id"])

    assert response["job"]["state"] == "succeeded"
    assert response["job"]["result_ids"] == [record["id"]]
    assert record["provenance"]["job_id"] == job["id"]


def test_cellpose_honors_working_memory_allowance_and_rejects_insufficient_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loci_engine.workbench import result_summary

    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)

    observed_working_bytes: list[int | None] = []

    def mock_segment(image, settings, model, *, working_bytes=None):
        observed_working_bytes.append(working_bytes)
        return _inference(image)

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", mock_segment)

    with pytest.raises(ValueError, match="working_bytes"):
        workbench.execute(
            "cellpose_run",
            {**_request(source["id"], measurement_channels=[0]), "working_bytes": 1000},
        )
    assert workbench.project.list_results() == []
    assert observed_working_bytes == []

    req = _request(source["id"], measurement_channels=[0])
    req["working_bytes"] = 2 * 1024**3
    response = workbench.execute("cellpose_run", req)

    assert observed_working_bytes == [2 * 1024**3]
    result = workbench.project.result(response["result"]["id"])
    assert result["provenance"]["resource_guard"]["working_memory_limit_bytes"] == 2 * 1024**3
    assert result["provenance"]["accepted_request"]["working_bytes"] == 2 * 1024**3
    summary = result_summary(result)
    assert summary["working_bytes"] == 2 * 1024**3


# ---------------------------------------------------------------------------
# New native Cellpose status, preview, exact adoption, and refusal tests
# ---------------------------------------------------------------------------


def test_cellpose_model_status_missing_and_ready_are_path_free(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    monkeypatch.setenv("LOCI_MODEL_HOME", str(tmp_path / "isolated-model-home"))

    # Live unprovisioned environment: no model install or network needed
    unready = workbench.execute("cellpose_model_status", {})
    assert unready == inspect_cellpose_model_status()
    assert unready["schema"] == CELLPOSE_MODEL_STATUS_SCHEMA
    assert unready["profile_id"] == "cellpose-sam-v2"
    assert unready["ready"] is False
    assert unready["runtime"] is None
    assert unready["package"]["id"] == CELLPOSE_MODEL_ID
    assert unready["package"]["version"] == CELLPOSE_PACKAGE_VERSION
    assert unready["package"]["package_sha256"] == CELLPOSE_MODEL_SHA256
    assert unready["model"] == {"id": CELLPOSE_MODEL_ID, "sha256": CELLPOSE_MODEL_SHA256}
    assert unready["recommended_settings"]["device"] == "cpu"
    device_entry = next(item for item in unready["settings_contract"] if item["key"] == "device")
    assert device_entry["choices"] == ["cpu"]
    encoded_unready = json.dumps(unready)
    assert str(tmp_path) not in encoded_unready
    assert "isolated-model-home" not in encoded_unready

    with pytest.raises(PermissionError, match="unavailable"):
        installed_cellpose_pins()

    # Even if low-level OSError summary mentions a secret path, status redacts it
    leaking_status = CellposeBackendStatus(
        model_spec=CELLPOSE_SAM_V2_SPEC,
        ready=False,
        code="model-invalid",
        summary=f"Invalid file at {tmp_path / 'secret-lab-folder' / 'cpsam_v2'}",
        installed_version=CELLPOSE_PACKAGE_VERSION,
        model_path=tmp_path / "secret-lab-folder" / "cpsam_v2",
        model_present=True,
        model_verified=False,
        devices={"cpu": True, "mps": False, "cuda": False},
    )
    monkeypatch.setattr(
        research_cellpose,
        "get_cellpose_status",
        lambda model=CELLPOSE_SAM_V2_SPEC, *, inspect_devices=False: leaking_status,
    )
    redacted = inspect_cellpose_model_status()
    assert redacted["ready"] is False
    assert redacted["availability"]["code"] == "model-invalid"
    assert "secret-lab-folder" not in json.dumps(redacted)

    # Ready state returns exact model + CPU runtime pins
    monkeypatch.setattr(
        research_cellpose,
        "get_cellpose_status",
        lambda model=CELLPOSE_SAM_V2_SPEC, *, inspect_devices=False: _ready_backend_status(
            tmp_path
        ),
    )
    monkeypatch.setattr(
        research_cellpose,
        "_import_runtime",
        lambda: (SimpleNamespace(), SimpleNamespace(__version__="2.6.0+cpu")),
    )
    ready = workbench.execute("cellpose_model_status", {})
    model_pin, runtime_pin = installed_cellpose_pins()
    assert ready["ready"] is True
    assert ready["model"] == model_pin
    assert ready["runtime"] == runtime_pin
    assert set(runtime_pin) == {
        "engine",
        "numpy",
        "scipy",
        "scikit_image",
        "backend",
        "resolved_device",
    }
    assert runtime_pin["backend"].startswith("cellpose-cpu:")
    assert runtime_pin["resolved_device"] == "cpu"
    assert str(tmp_path) not in json.dumps(ready)

    estimates = estimate_cellpose_memory_bytes(
        256, 256, 2, 2, CellposeSettings(device="cpu", batch_size=8)
    )
    assert estimates["selected_pixels"] == 65536
    assert estimates["aggregate_required_bytes"] == 65536 * 2 + 65536 * (160 + 16)
    assert estimates["required_working_bytes"] >= estimates["aggregate_required_bytes"]
    assert estimates["runtime_required_bytes"] > 2 * CELLPOSE_SAM_V2_SPEC.size_bytes


def test_cellpose_preview_then_adopt_preserves_multichannel_provenance_without_hidden_leakage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    image = np.zeros((1, 3, 1, 12, 14), dtype=np.uint16)
    image[0, 0, 0, 1:4, 2:5] = 120
    image[0, 0, 0, 7:10, 9:12] = 240
    image[0, 1, 0] = 999  # ungranted/unselected middle channel
    image[0, 2, 0, 1:4, 2:5] = 310
    image[0, 2, 0, 7:10, 9:12] = 620
    path = tmp_path / "multichannel.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.5,
            "PhysicalSizeYUnit": "µm",
            "Channel": {
                "Name": [
                    "GFP/DAPI",
                    "SECRET_UNGRANTED_CHANNEL_PROMPT",
                    "Marker_Ch2",
                ]
            },
        },
    )
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    source = workbench.import_native(str(path), name="SECRET_SOURCE_PROMPT")
    _patch_runtime(monkeypatch, tmp_path)

    req = _request(source["id"], measurement_channels=[0, 2])
    preview_job = submit_job(workbench, req, "cp-preview-job-1", "cellpose_preview")
    preview_run = run_job(workbench, preview_job["id"])

    # 1. Preview publishes NO scientific result
    assert preview_run["job"]["state"] == "succeeded"
    assert workbench.project.list_results() == []
    assert preview_run["adopted"] is False

    # 2. Preview ID binds to durable preview job ID and survives task-preview eviction
    preview_doc = preview_run["preview"]
    assert preview_doc["id"] == preview_job["id"]
    assert preview_doc["preview_job_id"] == preview_job["id"]
    assert preview_doc["schema"] == CELLPOSE_PREVIEW_SCHEMA
    assert preview_doc["package"] == {
        "id": CELLPOSE_MODEL_ID,
        "name": "Cellpose-SAM v2 checkpoint (cpsam_v2)",
        "profile_id": "cellpose-sam-v2",
        "format": "cellpose-native",
        "version": CELLPOSE_PACKAGE_VERSION,
        "artifact_sha256": CELLPOSE_MODEL_SHA256,
        "package_sha256": CELLPOSE_MODEL_SHA256,
    }
    assert preview_doc["source"]["id"] == source["id"]
    assert preview_doc["source"]["sha256"] == source_hash
    assert preview_doc["source"]["selection"] == req["selection"]
    assert preview_doc["source"]["measurement_channels"] == [0, 2]
    assert preview_doc["source"]["display"]["boundary_color"] == "#29f5c9"
    assert preview_doc["output"]["object_count"] == 2

    expected_labels = np.zeros((12, 14), dtype=np.uint32)
    expected_labels[1:4, 2:5] = 1
    expected_labels[7:10, 9:12] = 2
    assert preview_doc["output"]["labels_sha256"] == _array_sha256(expected_labels)

    # Verify overlay PNG integrity and dimensions
    assert preview_run["overlay_png"].startswith("data:image/png;base64,")
    png_bytes = b64decode(preview_run["overlay_png"].partition(",")[2], validate=True)
    assert preview_doc["source"]["display"]["png_sha256"] == hashlib.sha256(png_bytes).hexdigest()
    with Image.open(BytesIO(png_bytes)) as rendered_img:
        assert rendered_img.format == "PNG"
        assert rendered_img.mode == "RGB"
        assert rendered_img.size == (14, 12)

    # Task preview cache matches and zero source/channel names or paths leak in preview DTO
    cached = get_preview(workbench.project, preview_job["id"])["preview"]
    assert cached["output"]["preview"]["id"] == preview_doc["id"]
    preview_json = json.dumps(preview_run)
    assert str(tmp_path) not in preview_json
    assert "SECRET_SOURCE_PROMPT" not in preview_json
    assert "SECRET_UNGRANTED_CHANNEL_PROMPT" not in preview_json
    assert "GFP/DAPI" not in preview_json

    verify_cellpose_review_installation(workbench, preview_doc)
    assert (
        cellpose_preview_request(workbench, preview_doc["id"], preview_doc["preview_sha256"]) == req
    )

    # 3. Adopt exact preview through durable job
    adopt_req = {
        "preview_id": preview_doc["id"],
        "preview_sha256": preview_doc["preview_sha256"],
    }
    adopt_job = submit_job(workbench, adopt_req, "cp-adopt-job-1", "cellpose_adopt")
    adopted = run_job(workbench, adopt_job["id"])
    assert adopted["job"]["state"] == "succeeded"
    assert adopted["adopted"] is True
    assert adopted["result"]["preview_id"] == preview_doc["id"]
    assert adopted["result"]["preview_sha256"] == preview_doc["preview_sha256"]

    record = workbench.project.result(adopted["result"]["id"])
    assert record["kind"] == "cellpose-segmentation"
    assert "model_preview" not in record["provenance"]
    assert record["provenance"][CELLPOSE_PROVENANCE_PREVIEW_KEY] == {
        "id": preview_doc["id"],
        "revision": 1,
        "sha256": preview_doc["preview_sha256"],
        "source_kind": "native",
        "selected_series": 0,
        "multiscale_index": None,
        "input_mapping": {"mode": "source-channel", "channel": 0},
        "input_sha256": preview_doc["source"]["input_sha256"],
        "raw_channel_sha256s": preview_doc["source"]["raw_channel_sha256s"],
        "channel_metadata_sha256": preview_doc["source"]["channel_metadata_sha256"],
        "labels_sha256": preview_doc["output"]["labels_sha256"],
        "normalized_sha256": preview_doc["output"]["normalized_sha256"],
        "measurements_sha256": preview_doc["output"]["measurements_sha256"],
    }
    assert cellpose_result_pins(record) == installed_cellpose_pins()

    # Adopted channel_metadata contains ONLY selected channels [0, 2] with original indices
    ch_meta = record["provenance"]["channel_metadata"]
    assert ch_meta["scope"] == "selected-channels"
    assert [item["index"] for item in ch_meta["channels"]] == [0, 2]
    assert [item["name"] for item in ch_meta["channels"]] == ["GFP/DAPI", "Marker_Ch2"]
    assert "SECRET_UNGRANTED_CHANNEL_PROMPT" not in json.dumps(record)

    # Measurements carry calibrated um^2 areas and exact raw values for channels 0 and 2
    assert [row["measure"] for row in adopted["measurements"]] == [
        pytest.approx(2.25),
        pytest.approx(2.25),
    ]
    assert [row["intensity"]["source_channel_2"]["mean"] for row in adopted["measurements"]] == [
        pytest.approx(310.0),
        pytest.approx(620.0),
    ]

    # 4. Correction, describe_result, export, reopen, and portable study interchange
    binding = {
        "result_id": adopted["result"]["id"],
        "revision_hash": adopted["result"]["revision_hash"],
    }
    info = workbench.execute("correction_info", binding)
    assert info["measurement_channels"] == [
        {"index": 0, "name": "GFP/DAPI", "basis": "raw-source-channel-values"},
        {"index": 2, "name": "Marker_Ch2", "basis": "raw-source-channel-values"},
    ]

    described = workbench.execute("describe_result", binding)
    assert described["channels"] == {
        "segmentation": 0,
        "measurement": [0, 2],
        "names": [
            {
                "index": 0,
                "name": None,
                "source": "provenance.channel_metadata.channels[0].name",
            },
            {
                "index": 2,
                "name": "Marker_Ch2",
                "source": "provenance.channel_metadata.channels[1].name",
            },
        ],
    }
    assert [u for u in described["unavailable"] if u.startswith("provenance.runtime")] == [
        "provenance.runtime.cellpose.fallback_reason"
    ]
    assert "SECRET_UNGRANTED_CHANNEL_PROMPT" not in json.dumps(described)

    corrected = workbench.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "delete",
                    "label": 1,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
            "working_bytes": 32 * 1024**2,
        },
    )
    corrected_record = workbench.project.result(corrected["result"]["id"])
    assert cellpose_result_pins(corrected_record) == installed_cellpose_pins()
    assert len(corrected["measurements"]) == 1
    assert set(corrected["measurements"][0]["intensity"]) == {
        "source_channel_0",
        "source_channel_2",
    }
    assert corrected["measurements"][0]["intensity"]["source_channel_2"]["mean"] == pytest.approx(
        620.0
    )

    workbench.project.review(
        corrected["result"]["id"], corrected["result"]["revision_hash"], "reviewed"
    )
    export_dir = tmp_path / "adopted-export"
    exported = export_research_result(
        workbench.project,
        corrected["result"]["id"],
        corrected["result"]["revision_hash"],
        export_dir,
    )
    assert exported["result_id"] == corrected["result"]["id"]
    methods_md = (export_dir / "methods.md").read_text(encoding="utf-8")
    assert "SECRET_UNGRANTED_CHANNEL_PROMPT" not in methods_md

    reopened = Workbench(ResearchProject(workbench.project.root))
    restored = reopened.execute("result", {"result_id": corrected["result"]["id"]})
    assert restored["result"]["review"]["disposition"] == "reviewed"
    assert restored["measurements"][0]["intensity"]["source_channel_2"]["mean"] == pytest.approx(
        620.0
    )

    archive_path = tmp_path / "portable-study.loci.zip"
    export_project(workbench.project, archive_path)
    imported_project = import_project(archive_path, tmp_path / "imported-study")
    imported_result = imported_project.result(corrected["result"]["id"])
    assert cellpose_result_pins(imported_result) == installed_cellpose_pins()
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source_hash


def test_cellpose_adopt_refuses_mutations_wrong_schema_duplicate_and_non_cpu(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    image = np.zeros((1, 2, 1, 12, 14), dtype=np.uint16)
    image[0, 0, 0, 1:4, 2:5] = 100
    image[0, 1, 0] = 200
    path = tmp_path / "guard.ome.tif"
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={"axes": "TCZYX", "Channel": {"Name": ["Ch0", "Ch1"]}},
    )
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)

    # 1. Non-CPU or non-v2 requests are rejected by cellpose_preview
    auto_req = _request(source["id"])
    auto_req["settings"]["device"] = "auto"
    with pytest.raises(ValueError, match="CPU"):
        workbench.execute("cellpose_preview", auto_req)

    website_req = _request(source["id"])
    website_req["profile_id"] = "cellpose-sam"
    with pytest.raises(ValueError, match="cellpose-sam-v2"):
        workbench.execute("cellpose_preview", website_req)

    preview = workbench.execute("cellpose_preview", _request(source["id"]))["preview"]
    token = {"preview_id": preview["id"], "preview_sha256": preview["preview_sha256"]}

    # 2. Digest mismatch & cross-schema isolation between ONNX model_preview and Cellpose
    with pytest.raises(ValueError, match="exact persisted preview"):
        workbench.execute(
            "cellpose_adopt",
            {"preview_id": preview["id"], "preview_sha256": "0" * 64},
        )
    with pytest.raises(ValueError, match="Stored model preview is invalid"):
        workbench.execute("model_run", token)

    fake_onnx_doc = workbench.project.put_document(
        "model_preview",
        "b" * 32,
        {"schema": PREVIEW_SCHEMA, "preview_sha256": "c" * 64},
        expected_revision=0,
    )
    with pytest.raises(ValueError, match="Stored Cellpose preview is invalid"):
        workbench.execute(
            "cellpose_adopt",
            {"preview_id": fake_onnx_doc["id"], "preview_sha256": "c" * 64},
        )

    # Pruning isolation: ONNX pruner leaves Cellpose previews untouched & vice versa
    extra_cp = workbench.execute("cellpose_preview", _request(source["id"]))["preview"]
    _prune_unadopted_model_previews(workbench.project, max_unadopted=1)
    assert workbench.project.documents("model_preview", document_id=preview["id"])
    assert workbench.project.documents("model_preview", document_id=extra_cp["id"])
    _prune_unadopted_cellpose_previews(workbench.project, max_unadopted=1)
    assert workbench.project.documents("model_preview", document_id=fake_onnx_doc["id"])
    assert workbench.project.documents("model_preview", document_id=extra_cp["id"])
    assert workbench.project.documents("model_preview", document_id=preview["id"]) == []

    # Use extra_cp as our active preview for mutation refusal checks
    token = {"preview_id": extra_cp["id"], "preview_sha256": extra_cp["preview_sha256"]}

    # 3. Output non-determinism (different labels on recompute) -> refused, nothing saved
    def drifted_inference(arr):
        inf = _inference(arr)
        inf.output.labels[1, 2] = 0
        return inf

    monkeypatch.setattr(
        cellpose_backend,
        "segment_cellpose",
        lambda arr, settings, model, *, working_bytes=None: drifted_inference(arr),
    )
    with pytest.raises(ValueError, match="changed after Cellpose preview"):
        workbench.execute("cellpose_adopt", token)
    assert workbench.project.list_results() == []

    # Restore exact deterministic inference
    monkeypatch.setattr(
        cellpose_backend,
        "segment_cellpose",
        lambda arr, settings, model, *, working_bytes=None: _inference(arr),
    )

    # 4. Runtime version drift after preview -> refused
    _patch_runtime(monkeypatch, tmp_path, torch_version="2.7.0+cpu")
    with pytest.raises(ValueError, match="changed after Cellpose preview"):
        workbench.execute("cellpose_adopt", token)
    with pytest.raises(ValueError, match="CPU runtime changed"):
        verify_cellpose_review_installation(workbench, extra_cp)
    assert workbench.project.list_results() == []

    # Restore runtime, mutate channel declarations -> refused
    _patch_runtime(monkeypatch, tmp_path, torch_version="2.6.0+cpu")
    workbench.execute(
        "channels",
        {
            "source_id": source["id"],
            "expected_revision": 0,
            "channels": [
                {
                    "index": 0,
                    "name": "RenamedCh0",
                    "marker": "Actin",
                    "fluorophore": "",
                    "declaration": "",
                },
                {
                    "index": 1,
                    "name": "Ch1",
                    "marker": "",
                    "fluorophore": "",
                    "declaration": "",
                },
            ],
        },
    )
    with pytest.raises(ValueError, match="changed after.*Cellpose preview"):
        workbench.execute("cellpose_adopt", token)
    assert workbench.project.list_results() == []

    # Create fresh preview on updated channel declarations, adopt once, refuse duplicate adoption
    fresh = workbench.execute("cellpose_preview", _request(source["id"]))["preview"]
    fresh_token = {"preview_id": fresh["id"], "preview_sha256": fresh["preview_sha256"]}
    adopted = workbench.execute("cellpose_adopt", fresh_token)
    assert adopted["adopted"] is True
    with pytest.raises(ValueError, match="already been adopted"):
        workbench.execute("cellpose_adopt", fresh_token)
    assert len(workbench.project.list_results()) == 1

    # 5. Source file mutation on disk refuses subsequent preview adoption
    third = workbench.execute("cellpose_preview", _request(source["id"]))["preview"]
    path.write_bytes(path.read_bytes() + b"corrupted")
    with pytest.raises((ValueError, RuntimeError), match="fingerprint|changed"):
        workbench.execute(
            "cellpose_adopt",
            {"preview_id": third["id"], "preview_sha256": third["preview_sha256"]},
        )
    assert len(workbench.project.list_results()) == 1


def test_cellpose_preview_and_adopt_through_real_backend_pipeline_and_checkpoint_hash_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise real get_cellpose_status, segment_cellpose, downsample/restore, and hash guards."""
    from dataclasses import replace
    from types import MappingProxyType

    workbench = _workbench(tmp_path)
    model_home = tmp_path / "real-model-home"
    monkeypatch.setenv(cellpose_backend.MODEL_HOME_ENV, str(model_home))
    cellpose_backend.clear_model_cache()
    with cellpose_backend._HASH_CACHE_LOCK:
        cellpose_backend._HASH_CACHE.clear()

    checkpoint_bytes = b"verified-local-cpsam-v2-checkpoint-fixture-bytes"
    test_spec = replace(
        CELLPOSE_SAM_V2_SPEC,
        size_bytes=len(checkpoint_bytes),
        sha256=hashlib.sha256(checkpoint_bytes).hexdigest(),
    )
    monkeypatch.setattr(
        cellpose_backend,
        "CELLPOSE_MODEL_SPECS",
        MappingProxyType({**cellpose_backend.CELLPOSE_MODEL_SPECS, "cellpose-sam-v2": test_spec}),
    )
    monkeypatch.setattr(research_cellpose, "CELLPOSE_SAM_V2_SPEC", test_spec)

    ckpt_path = cellpose_backend.managed_model_path(test_spec)
    ckpt_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ckpt_path.write_bytes(checkpoint_bytes)
    ckpt_path.chmod(0o600)

    eval_calls: list[dict[str, object]] = []

    class _StubCellposeModels:
        @staticmethod
        def cache_model_path(_name: str) -> str:
            raise AssertionError("Cellpose download fallback must never be called")

        class CellposeModel:
            def __init__(
                self, *, pretrained_model: str, device: object, use_bfloat16: bool
            ) -> None:
                assert Path(pretrained_model) == ckpt_path
                assert Path(pretrained_model).read_bytes() == checkpoint_bytes
                assert str(device) == "cpu"
                assert use_bfloat16 is True

            def eval(self, prepared: np.ndarray, **kwargs: object):
                eval_calls.append({"shape": prepared.shape, "dtype": str(prepared.dtype), **kwargs})
                masks = np.zeros(prepared.shape[:2], dtype=np.int32)
                masks[4:12, 6:16] = 1
                masks[20:30, 32:44] = 2
                return masks, [], []

    try:
        import torch as real_torch
    except ImportError:
        real_torch = SimpleNamespace(
            __version__="2.6.0+cpu",
            device=lambda name: name,
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
            cuda=SimpleNamespace(is_available=lambda: False),
        )

    monkeypatch.setattr(cellpose_backend, "_installed_cellpose_version", lambda: "4.2.1.1")
    monkeypatch.setattr(
        cellpose_backend, "_import_runtime", lambda: (_StubCellposeModels, real_torch)
    )
    monkeypatch.setattr(
        research_cellpose, "_import_runtime", lambda: (_StubCellposeModels, real_torch)
    )

    status = workbench.execute("cellpose_model_status", {})
    assert status["ready"] is True
    assert status["package"]["package_sha256"] == test_spec.sha256

    # 96 x 128 16-bit 2-channel OME-TIFF with max_edge_px=64 exercises real downsample + restore
    pixels = np.zeros((1, 2, 1, 96, 128), dtype=np.uint16)
    pixels[0, 0, 0, 8:24, 12:32] = 1200
    pixels[0, 0, 0, 40:60, 64:88] = 2400
    pixels[0, 1, 0] = 500
    tif_path = tmp_path / "real-pipeline.ome.tif"
    tifffile.imwrite(
        tif_path,
        pixels,
        ome=True,
        metadata={"axes": "TCZYX", "Channel": {"Name": ["Signal", "Reporter"]}},
    )
    source = workbench.import_native(str(tif_path))
    req = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 128,
            "height": 96,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "profile_id": "cellpose-sam-v2",
        "settings": CellposeSettings(device="cpu", max_edge_px=64).to_dict(),
        "measurement_channels": [0, 1],
        "working_bytes": 64 * 1024**2,
    }

    preview_out = workbench.execute("cellpose_preview", req)
    preview_doc = preview_out["preview"]
    assert len(eval_calls) == 1
    assert eval_calls[0]["shape"] == (48, 64, 3)  # downsampled to max_edge_px=64
    assert preview_doc["output"]["labels_shape"] == [96, 128]  # restored to native source grid
    assert preview_doc["output"]["object_count"] == 2
    assert workbench.project.list_results() == []

    # Corrupting 1 byte of the managed checkpoint on disk must fail closed before adoption
    corrupted = bytearray(checkpoint_bytes)
    corrupted[0] ^= 0xFF
    ckpt_path.write_bytes(bytes(corrupted))
    with cellpose_backend._HASH_CACHE_LOCK:
        cellpose_backend._HASH_CACHE.clear()
    with pytest.raises(PermissionError, match="unavailable"):
        workbench.execute(
            "cellpose_adopt",
            {"preview_id": preview_doc["id"], "preview_sha256": preview_doc["preview_sha256"]},
        )
    assert workbench.project.list_results() == []

    # Restore exact verified checkpoint bytes -> recomputation & adoption succeed bit-for-bit
    ckpt_path.write_bytes(checkpoint_bytes)
    with cellpose_backend._HASH_CACHE_LOCK:
        cellpose_backend._HASH_CACHE.clear()
    adopted = workbench.execute(
        "cellpose_adopt",
        {"preview_id": preview_doc["id"], "preview_sha256": preview_doc["preview_sha256"]},
    )
    assert adopted["adopted"] is True
    saved = workbench.project.result(adopted["result"]["id"])
    saved_labels = workbench.project.load_array(saved["arrays"]["labels"])
    assert saved_labels.shape == (96, 128)
    assert _array_sha256(saved_labels) == preview_doc["output"]["labels_sha256"]
    assert cellpose_result_pins(saved) == installed_cellpose_pins()


def test_cellpose_adopt_and_correct_result_support_up_to_32_channels_with_aggregate_preflight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    # 20-channel (>16, <=32) OME-TIFF; grant/measure 18 channels while keeping ch 1 excluded
    pixels = np.zeros((1, 20, 1, 12, 14), dtype=np.uint16)
    for ch in range(20):
        pixels[0, ch, 0] = (ch + 1) * 10
    pixels[0, 0, 0, 1:4, 2:5] = 500
    path = tmp_path / "twenty-channels.ome.tif"
    tifffile.imwrite(
        path,
        pixels,
        ome=True,
        metadata={
            "axes": "TCZYX",
            "Channel": {"Name": [f"Ch_{ch}" for ch in range(20)]},
        },
    )
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch, tmp_path)

    selected_meas = [0, *range(2, 19)]  # 18 channels (>16, <=32), excluding Ch_1 and Ch_19
    assert len(selected_meas) == 18
    preview = workbench.execute(
        "cellpose_preview",
        _request(source["id"], measurement_channels=selected_meas),
    )["preview"]
    adopted = workbench.execute(
        "cellpose_adopt",
        {"preview_id": preview["id"], "preview_sha256": preview["preview_sha256"]},
    )
    binding = {
        "result_id": adopted["result"]["id"],
        "revision_hash": adopted["result"]["revision_hash"],
    }
    info = workbench.execute("correction_info", binding)
    assert [item["index"] for item in info["measurement_channels"]] == selected_meas

    # Verify on an 80x80 grid that the 18-channel aggregate preflight fires before decode
    large_pixels = np.zeros((1, 20, 1, 80, 80), dtype=np.uint16)
    large_pixels[0, 0, 0, 4:12, 4:12] = 500
    large_path = tmp_path / "twenty-channels-large.ome.tif"
    tifffile.imwrite(
        large_path,
        large_pixels,
        ome=True,
        metadata={"axes": "TCZYX", "Channel": {"Name": [f"Ch_{ch}" for ch in range(20)]}},
    )
    large_source = workbench.import_native(str(large_path))
    large_req = _request(large_source["id"], measurement_channels=selected_meas)
    large_req["selection"].update(width=80, height=80)
    large_preview = workbench.execute("cellpose_preview", large_req)["preview"]
    large_adopted = workbench.execute(
        "cellpose_adopt",
        {"preview_id": large_preview["id"], "preview_sha256": large_preview["preview_sha256"]},
    )
    large_binding = {
        "result_id": large_adopted["result"]["id"],
        "revision_hash": large_adopted["result"]["revision_hash"],
    }
    large_info = workbench.execute("correction_info", large_binding)
    with pytest.raises(ValueError, match="aggregate working-memory budget"):
        workbench.execute(
            "correct_result",
            {
                **large_binding,
                "operations": [
                    {
                        "op": "delete",
                        "label": 1,
                        "expected_input_sha256": large_info["label_sha256"],
                    }
                ],
                "working_bytes": 1024**2,
            },
        )

    corrected = workbench.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "delete",
                    "label": 1,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
            "working_bytes": 32 * 1024**2,
        },
    )
    assert len(corrected["measurements"]) == 1
    assert set(corrected["measurements"][0]["intensity"]) == {
        f"source_channel_{ch}" for ch in selected_meas
    }
    assert corrected["measurements"][0]["intensity"]["source_channel_18"]["mean"] == pytest.approx(
        190.0
    )
    # Non-Cellpose ROI editing keeps its existing <=16 channel bound
    with pytest.raises(ValueError, match="at most 16"):
        workbench.execute(
            "roi_add",
            {
                **binding,
                "roi": {
                    "annotation_id": "roi-over-16",
                    "plane": "XY",
                    "index": 0,
                    "points": [
                        {"u": 1.0, "v": 1.0},
                        {"u": 5.0, "v": 1.0},
                        {"u": 5.0, "v": 5.0},
                    ],
                    "slab_start": None,
                    "slab_stop_exclusive": None,
                },
                "measurement_channels": selected_meas,
                "working_bytes": 32 * 1024**2,
            },
        )
