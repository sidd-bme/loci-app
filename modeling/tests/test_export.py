from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import torch
from torch import nn

import loci_modeling.export as export_module
from loci_modeling.contracts import (
    DatasetManifest,
    ModelConfig,
    PostprocessConfig,
    TrainingConfig,
)
from loci_modeling.data import sha256_file
from loci_modeling.export import (
    build_engine_profile,
    export_bundle,
    export_onnx,
    validate_profile_identity,
)
from loci_modeling.model import LociResidualUNet


def test_profile_identity_can_be_validated_before_training() -> None:
    assert validate_profile_identity("loci-native-v1", "1.2.3-rc.1+cuda", "Loci Native V1") is None


@pytest.mark.parametrize(
    ("profile_id", "version", "display_name", "message"),
    [
        ("Loci Native", "1.0.0", "Loci Native", "profile_id"),
        ("../loci-native", "1.0.0", "Loci Native", "profile_id"),
        ("loci-native", "v1", "Loci Native", "semantic versioning"),
        ("loci-native", "1.0.0-..", "Loci Native", "semantic versioning"),
        ("loci-native", "1.0.0", " Loci Native", "display_name"),
    ],
)
def test_profile_identity_preflight_rejects_invalid_values(
    profile_id: str,
    version: str,
    display_name: str,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        validate_profile_identity(profile_id, version, display_name)


def test_adjudication_record_is_carried_into_profile_lineage(dataset_builder) -> None:
    dataset_builder.add_active("train-001")
    dataset = dataset_builder.payload["dataset"]
    dataset["reference_kind"] = "adjudicated"
    dataset["adjudication_record_id"] = "adjudication-001"
    manifest = DatasetManifest.load(dataset_builder.write())

    profile = build_engine_profile(
        profile_id="loci-native-adjudicated",
        profile_version="0.1.0",
        display_name="Loci Native Adjudicated",
        model_sha256="a" * 64,
        artifact_id="loci-native-adjudicated-weights",
        manifest=manifest,
        postprocess=PostprocessConfig(),
        validation_available=True,
    )

    assert "adjudication-001" in profile["rights"]["training_data_lineage"]
    assert profile["validation"]["failure_modes"][0]["code"] == ("adjudicated-reference-scope")


@pytest.mark.filterwarnings("ignore:Converting a tensor to a Python boolean.*")
def test_onnx_bundle_has_verified_hash_and_path_free_lineage(
    dataset_builder, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("onnx")
    onnxruntime = pytest.importorskip("onnxruntime")
    runtime_shapes: list[tuple[int, ...]] = []
    postprocess_shapes: list[tuple[int, ...]] = []
    runtime_session = onnxruntime.InferenceSession
    runtime_postprocess = export_module.logits_to_instances

    class RecordingSession:
        def __init__(self, *args, **kwargs) -> None:
            self._session = runtime_session(*args, **kwargs)

        def run(self, output_names, input_feed, *args, **kwargs):
            runtime_shapes.append(tuple(input_feed["image"].shape))
            return self._session.run(output_names, input_feed, *args, **kwargs)

    monkeypatch.setattr(onnxruntime, "InferenceSession", RecordingSession)

    def recording_postprocess(logits, config):
        postprocess_shapes.append(tuple(logits.shape))
        return runtime_postprocess(logits, config)

    monkeypatch.setattr(export_module, "logits_to_instances", recording_postprocess)
    dataset_builder.add_active("train-001")
    manifest = DatasetManifest.load(dataset_builder.write())
    model_config = ModelConfig(
        base_channels=8,
        depth=2,
        group_norm_groups=4,
        dropout=0.0,
    )
    training_config = TrainingConfig(
        epochs=1,
        steps_per_epoch=1,
        validation_steps=1,
        batch_size=1,
        patch_size=16,
        checkpoint_every=1,
        use_amp=False,
    )
    postprocess_config = PostprocessConfig(min_area_px=4, offset_scale_px=16.0)
    output_dir = tmp_path / "export"

    result = export_bundle(
        model=LociResidualUNet(model_config),
        output_dir=output_dir,
        manifest=manifest,
        model_config=model_config,
        training_config=training_config,
        postprocess_config=postprocess_config,
        profile_id="loci-native-synthetic",
        profile_version="0.1.0",
        display_name="Loci Native Synthetic",
        run_id="synthetic-run-001",
        checkpoint_sha256="c" * 64,
        code_revision="synthetic-test-revision",
        agreement_summary={
            "scope": "pseudo_label_agreement",
            "image_count": 1,
            "metrics": {"mean_instance_ap": 1.0},
        },
        verify_runtime=True,
    )

    model_path = Path(result["model"])
    profile_path = Path(result["profile"])
    profile_text = profile_path.read_text(encoding="utf-8")
    profile = json.loads(profile_text)
    metadata_path = Path(result["metadata"])
    metadata_text = metadata_path.read_text(encoding="utf-8")
    metadata = json.loads(metadata_text)

    assert model_path.is_file()
    assert result["model_sha256"] == sha256_file(model_path)
    assert profile["model"]["sha256"] == result["model_sha256"]
    assert profile["rights"]["redistribution"] == "permitted"
    assert profile["schema_version"] == "1.1"
    assert profile["preprocessing"] == {
        "channel_conversion": "grayscale-luminance",
        "intensity_normalization": "per-image-percentile-1-99",
        "resize_policy": "downsample-only",
        "max_edge_px": 1000,
        "output_grid": "source-resolution",
    }
    assert metadata["artifact"]["sha256"] == result["model_sha256"]
    assert metadata["architecture"]["initialization"] == "random-kaiming-normal"
    assert metadata["architecture"]["pretrained_weights"] is False
    assert metadata["lineage"]["manifest_sha256"] == manifest.manifest_sha256
    assert metadata["lineage"]["rights_id"] == manifest.rights.record_id
    assert metadata["agreement"]["scope"] == "pseudo_label_agreement"
    assert metadata["preprocessing"]["max_edge_px"] == 1000
    assert metadata["preprocessing"]["resize_policy"] == "downsample-only"
    assert metadata["preprocessing"]["image_interpolation"] == "bilinear-antialias"
    assert metadata["preprocessing"]["instance_mask_interpolation"] == "nearest"
    assert metadata["preprocessing"]["preserve_instance_ids"] is True
    assert "image-and-instance-mask-together" in metadata["preprocessing"]["coordinate_policy"]
    assert str(tmp_path) not in metadata_text
    assert str(tmp_path) not in profile_text

    # Internal export verification must exercise height and width independently
    # on two non-square dynamic shapes, rather than replaying the trace input.
    assert runtime_shapes[:2] == [(1, 1, 16, 17), (1, 1, 17, 16)]
    assert postprocess_shapes == [
        (1, 4, 16, 17),
        (1, 4, 16, 17),
        (1, 4, 17, 16),
        (1, 4, 17, 16),
    ]

    session = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    dynamic_result = session.run(
        None,
        {"image": np.zeros((1, 1, 32, 48), dtype=np.float32)},
    )[0]
    assert dynamic_result.shape == (1, 4, 32, 48)


@pytest.mark.filterwarnings("ignore:Converting a tensor to a Python boolean.*")
def test_onnx_export_rejects_a_numerically_divergent_graph(tmp_path: Path) -> None:
    pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")

    class DivergentDuringExport(nn.Module):
        def forward(self, inputs: torch.Tensor) -> torch.Tensor:
            if torch.onnx.is_in_onnx_export():
                channel = torch.zeros_like(inputs)
            else:
                channel = torch.ones_like(inputs)
            return channel.repeat(1, 4, 1, 1)

    destination = tmp_path / "divergent.onnx"
    with pytest.raises(RuntimeError, match="ONNX numerical parity failed"):
        export_onnx(
            DivergentDuringExport(),
            destination,
            example_size=16,
            postprocess_config=PostprocessConfig(min_area_px=4, offset_scale_px=16.0),
            verify_runtime=True,
        )
    assert not destination.exists()


@pytest.mark.filterwarnings("ignore:Converting a tensor to a Python boolean.*")
def test_onnx_export_rejects_instance_count_drift_within_logit_tolerance(
    tmp_path: Path,
) -> None:
    pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")

    class ThresholdDriftDuringExport(nn.Module):
        def forward(self, inputs: torch.Tensor) -> torch.Tensor:
            foreground_value = -5e-6 if torch.onnx.is_in_onnx_export() else 5e-6
            foreground = torch.full_like(inputs, foreground_value)
            remaining_heads = torch.zeros_like(inputs).repeat(1, 3, 1, 1)
            return torch.cat((foreground, remaining_heads), dim=1)

    destination = tmp_path / "count-drift.onnx"
    with pytest.raises(RuntimeError, match="ONNX instance-count parity failed"):
        export_onnx(
            ThresholdDriftDuringExport(),
            destination,
            example_size=16,
            postprocess_config=PostprocessConfig(min_area_px=4, offset_scale_px=16.0),
            verify_runtime=True,
        )
    assert not destination.exists()
