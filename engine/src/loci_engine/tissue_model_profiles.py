"""Code-owned tissue model contracts, separate from scalar model-package/v1.

Inspection is data-only: it never imports Torch, loads a checkpoint, downloads
anything, or claims an installed runtime has passed compatibility validation.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import sys
from types import MappingProxyType
from typing import Any

PUMA_PROFILE_ID = "puma-tissue-cpu"
PUMA_PROFILE_VERSION = "0.1.0"
PUMA_NUMERIC_PROFILE = "puma-engine312-cpu-fp32-network-fp16-stitch/v1"
PUMA_ARCHITECTURE_ID = "loci-puma-plainconvunet/v1"
PUMA_WEIGHTS_SHA256 = "f32a81e49ff3fc60e0831fcb4e6c1bce311586151ef2257c0f1ddcf7792804ad"
PUMA_WEIGHTS_BYTES = 185_432_060
PUMA_TENSOR_BYTES = 185_332_904
PUMA_ORIGINAL_CHECKPOINT_SHA256 = "938fea9f4c41a798cf0d92a6a98cb4de1fcee9342cd3bbf7d56bb5c036505faa"
PUMA_CONVERSION_RECEIPT_SHA256 = "9383634f6840b382e343a9bdc8b73fa92e606ce05e251508ddb904aebe31c486"
PUMA_TORCH_GIT_VERSION = "cf30153c4c131c8164ee7798e5022d810682e2cb"
PUMA_MAX_CONTEXT_EDGE = 1024
PUMA_PATCH_EDGE = 512
PUMA_MIN_WORKING_BYTES = 2 * 1024**3
PUMA_MAX_WORKING_BYTES = 8 * 1024**3
PUMA_RGB_POLICY = "puma-first-three-samples"
PUMA_CLASS_NAMES = (
    "background",
    "tissue_stroma",
    "tissue_blood_vessel",
    "tissue_tumor",
    "tissue_epidermis",
    "tissue_necrosis",
)
PUMA_EPIDERMIS_CLASS = 4
# The target engine profile intentionally differs from the Python 3.11 / NumPy
# 1.26 prototype. Matching Torch alone does not establish numerical equivalence.
PUMA_RUNTIME_VERSIONS = MappingProxyType({"torch": "2.13.0", "numpy": "2.4.6", "scipy": "1.18.1"})
PUMA_PYTHON_VERSION = (3, 12)


def puma_profile() -> dict[str, Any]:
    """Return a fresh, path-free profile; it grants no execution authority."""
    record: dict[str, Any] = {
        "schema": "loci.tissue-model-profile/v1",
        "id": PUMA_PROFILE_ID,
        "version": PUMA_PROFILE_VERSION,
        "task": "rgb-tissue-classes",
        "architecture": PUMA_ARCHITECTURE_ID,
        "numeric_profile": PUMA_NUMERIC_PROFILE,
        "model": {
            "artifact_id": "puma-fold4-network-weights",
            "format": "exact-torch-tensor-dictionary",
            "sha256": PUMA_WEIGHTS_SHA256,
            "bytes": PUMA_WEIGHTS_BYTES,
            "tensor_bytes": PUMA_TENSOR_BYTES,
            "original_checkpoint_sha256": PUMA_ORIGINAL_CHECKPOINT_SHA256,
            "conversion_receipt_sha256": PUMA_CONVERSION_RECEIPT_SHA256,
            "tensor_keys": 396,
            "unique_storages": 148,
        },
        "input": {
            "axes": "YXRGB",
            "dtype": "uint8",
            "sample_counts": [3, 4],
            "rgb_policy": PUMA_RGB_POLICY,
            "context": "complete-native-single-2d-plane",
            "maximum_context_edge": PUMA_MAX_CONTEXT_EDGE,
            "level": 0,
            "resampling": "none",
            "output_roi": "postprocessing-selection-with-full-context",
            "physical_calibration": "not-supplied-by-model-grid-spacing",
        },
        "preprocessing": {
            "crop": "full-context-nonzero-bounding-box",
            "normalization": "per-channel-float32-population-zscore-before-padding",
            "normalization_epsilon": 1e-8,
            "padding": "symmetric-extent-constant-zero",
            "patch_yx": [PUMA_PATCH_EDGE, PUMA_PATCH_EDGE],
        },
        "inference": {
            "step_fraction": 0.5,
            "mirror_axes_yx": [0, 1],
            "mirror_combinations": [[], [0], [1], [0, 1]],
            "gaussian_sigma_scale": 0.125,
            "gaussian_scale": 10.0,
            "network_dtype": "float32",
            "mirror_average_dtype": "float32",
            "gaussian_dtype": "float16",
            "accumulator_dtype": "float16",
            "weight_accumulator_dtype": "float16",
            "softmax_dtype": "float32",
            "decision": "six-class-softmax-argmax-first-class-on-tie",
            "outside_nonzero_crop": "background",
        },
        "class_map": {str(index): name for index, name in enumerate(PUMA_CLASS_NAMES)},
        "selected_compartment": {"class_id": PUMA_EPIDERMIS_CLASS, "name": "epidermis"},
        "runtime": {
            "device": "cpu",
            "python_major_minor": list(PUMA_PYTHON_VERSION),
            "versions": dict(PUMA_RUNTIME_VERSIONS),
            "torch_git_version": PUMA_TORCH_GIT_VERSION,
            "intra_op_threads": 1,
            "deterministic_algorithms": True,
            "autocast": False,
            "optional": True,
        },
        "resources": {
            "minimum_working_bytes": PUMA_MIN_WORKING_BYTES,
            "maximum_working_bytes": PUMA_MAX_WORKING_BYTES,
            "execution": "one-tile-one-mirror-at-a-time",
            "memory_qualification": "conservative-estimate-awaiting-measured-target-runtime",
        },
        "sources": {
            "puma_commit": "211782054387f0d28e170ed565cdfb6e8b53d1a7",
            "architecture_reference_commit": "19f56442581461ca428b7ea5d79e81d672c8d5a1",
            "padding_reference_commit": "4c5a468dbca3c2e9b91533519da3eba5293657a4",
            "weights_doi": "10.5281/zenodo.14651631",
            "reference_dataset_doi": "10.5281/zenodo.15050523",
            "original_dna_acvl_versions": "unpinned-unavailable",
        },
        "rights": {
            "upstream_puma_code_license": "MIT",
            "upstream_architecture_reference_license": "Apache-2.0",
            "upstream_weights_license_declaration": "MIT",
            "reference_dataset_license_declaration": "CC0",
            "derivative_distribution_review": "not-completed",
        },
        "compatibility": {
            "status": "unverified",
            "modeling_prototype_parity": "unverified-distinct-runtime",
            "official_cuda_runtime_parity": "unverified",
        },
        "scientific_validation": {
            "status": "unvalidated-research-method",
            "reference_examples": "public-training-primary-004-007-010",
            "checkpoint_fold_membership": "unavailable",
            "independent_accuracy": "not-established",
            "scope": "epidermis-class-mask-is-not-a-basal-boundary-or-dermis-definition",
        },
    }
    encoded = json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False)
    record["contract_sha256"] = hashlib.sha256(encoded.encode()).hexdigest()
    return record


def runtime_metadata_status() -> dict[str, Any]:
    """Inspect installed distribution metadata, never native runtime imports."""
    observed: dict[str, str | None] = {}
    for name in PUMA_RUNTIME_VERSIONS:
        try:
            observed[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            observed[name] = None
    python = list(sys.version_info[:2])
    missing = [name for name, value in observed.items() if value is None]
    mismatched = [
        name
        for name, expected in PUMA_RUNTIME_VERSIONS.items()
        if observed[name] is not None and observed[name] != expected
    ]
    if tuple(python) != PUMA_PYTHON_VERSION:
        mismatched.append("python-major-minor")
    return {
        "status": (
            "missing" if missing else "mismatch" if mismatched else "metadata-matches-unverified"
        ),
        "expected": dict(PUMA_RUNTIME_VERSIONS),
        "observed": observed,
        "expected_python_major_minor": list(PUMA_PYTHON_VERSION),
        "observed_python_major_minor": python,
        "missing": missing,
        "mismatched": mismatched,
        "runtime_import_verified": False,
        "technical_compatibility_verified": False,
    }
