from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
import tifffile
from PIL import Image

import loci_engine.cellpose_backend as cellpose_backend
import loci_engine.research_cellpose as research_cellpose
from loci_engine.models import CellposeSettings
from loci_engine.research_export import export_research_result
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject
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
            "artifact_id": "cpsam-v2",
            "sha256": "a" * 64,
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
            "version": "4.2.1.1",
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


def _workbench(tmp_path) -> Workbench:
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
        "measurement_channels": [0, 1]
        if measurement_channels is None
        else measurement_channels,
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
        np.zeros_like(normalized)
        if span == 0
        else (normalized - float(normalized.min())) / span
    )
    return SimpleNamespace(
        output=SimpleNamespace(labels=labels, normalized=normalized, count=2),
        runtime={
            "package": {"name": "cellpose", "version": "4.2.1.1"},
            "model": {"artifact_id": "cpsam-v2", "sha256": "a" * 64},
            "profile_id": "cellpose-sam-v2",
            "requested_device": "cpu",
            "resolved_device": "cpu",
            "fallback_reason": None,
            "memory_preflight": {"required_bytes": 1234, "available_bytes": 5678},
        },
    )


def _patch_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        research_cellpose,
        "resolve_profile",
        lambda profile_id, require_ready: _ReadyCellposeProfile(),
    )
    monkeypatch.setattr(
        cellpose_backend,
        "segment_cellpose",
        lambda image, settings, model: _inference(image),
    )


def test_local_cellpose_uses_registered_selection_and_raw_measurement_channels(
    tmp_path, monkeypatch: pytest.MonkeyPatch
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
    _patch_runtime(monkeypatch)

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
    assert record["provenance"]["runtime"]["cellpose"]["model"]["sha256"] == "a" * 64
    assert record["provenance"]["resource_guard"]["cellpose_memory_preflight"] == {
        "required_bytes": 1234,
        "available_bytes": 5678,
    }
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
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    pixels = np.zeros((12, 14, 3), dtype=np.uint8)
    pixels[..., 1] = 80
    path = tmp_path / "rgb.png"
    Image.fromarray(pixels, mode="RGB").save(path)
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch)
    observed: list[tuple[int, ...]] = []

    def segment(image, settings, model):
        observed.append(image.shape)
        return _inference(image)

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", segment)
    response = workbench.execute(
        "cellpose_run", _request(source["id"], measurement_channels=[])
    )
    assert observed == [(12, 14, 3)]
    assert response["accepted_request"]["input_mapping"] == {
        "mode": "interleaved-rgb-samples"
    }

    with pytest.raises(ValueError, match="RGB samples"):
        workbench.execute("cellpose_run", _request(source["id"], measurement_channels=[0]))


def test_cellpose_request_is_exact_and_invalid_output_is_not_published(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch)

    incomplete = _request(source["id"])
    incomplete["settings"].pop("invert")
    with pytest.raises(ValueError, match="every declared profile setting"):
        workbench.execute("cellpose_run", incomplete)

    def invalid(image, settings, model):
        inference = _inference(image)
        inference.output.normalized = np.asarray(inference.output.normalized, dtype=np.float64)
        inference.output.normalized[0, 0] = np.nan
        return inference

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", invalid)
    with pytest.raises(ValueError, match="selected 2D source grid"):
        workbench.execute("cellpose_run", _request(source["id"], measurement_channels=[0]))
    assert workbench.project.list_results() == []


def test_cellpose_rejects_aggregate_raw_channel_buffers_before_inference(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    image = np.zeros((2, 1, 256, 256), dtype=np.uint16)
    path = tmp_path / "large-channels.ome.tif"
    tifffile.imwrite(path, image, ome=True, metadata={"axes": "CZYX"})
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch)
    request = _request(source["id"])
    request["selection"].update(width=256, height=256)
    request["working_bytes"] = 8 * 1024**2
    called = False

    def segment(image, settings, model):
        nonlocal called
        called = True
        return _inference(image)

    monkeypatch.setattr(cellpose_backend, "segment_cellpose", segment)
    with pytest.raises(ValueError, match="aggregate working-memory budget"):
        workbench.execute("cellpose_run", request)
    assert called is False
    assert workbench.project.list_results() == []


def test_cellpose_is_a_cancellable_durable_job_before_execution(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch)
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
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbench = _workbench(tmp_path)
    path = tmp_path / "plane.tif"
    tifffile.imwrite(path, np.arange(12 * 14, dtype=np.uint16).reshape(12, 14))
    source = workbench.import_native(str(path))
    _patch_runtime(monkeypatch)
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
