"""Developer-side training pipeline for Loci-native segmentation models."""

from .contracts import DatasetManifest, ModelConfig, PostprocessConfig, TrainingConfig
from .preprocessing import PreprocessingConfig
from .validation_metrics import (
    FROZEN_CULTURED_CELL_GATES,
    GateDefinition,
    aggregate_validation_metrics,
    gate_configuration_sha256,
    instance_validation_metrics,
)

__all__ = [
    "DatasetManifest",
    "FROZEN_CULTURED_CELL_GATES",
    "GateDefinition",
    "ModelConfig",
    "PostprocessConfig",
    "PreprocessingConfig",
    "TrainingConfig",
    "aggregate_validation_metrics",
    "gate_configuration_sha256",
    "instance_validation_metrics",
]

__version__ = "0.1.0"
