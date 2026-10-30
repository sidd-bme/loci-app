from __future__ import annotations

import builtins
import hashlib
import importlib.metadata
import json
from types import SimpleNamespace

import pytest

from loci_engine import tissue_model_profiles as profiles


def _runtime_metadata(monkeypatch: pytest.MonkeyPatch, versions: dict[str, str | None]) -> None:
    monkeypatch.setattr(profiles, "sys", SimpleNamespace(version_info=(3, 12, 1)))

    def version(name: str) -> str:
        value = versions[name]
        if value is None:
            raise importlib.metadata.PackageNotFoundError(name)
        return value

    monkeypatch.setattr(profiles.importlib.metadata, "version", version)


def test_exact_profile_preserves_six_classes_and_unqualified_training_scope() -> None:
    profile = profiles.puma_profile()
    assert profile["class_map"] == {
        "0": "background",
        "1": "tissue_stroma",
        "2": "tissue_blood_vessel",
        "3": "tissue_tumor",
        "4": "tissue_epidermis",
        "5": "tissue_necrosis",
    }
    assert profile["selected_compartment"] == {"class_id": 4, "name": "epidermis"}
    assert profile["model"]["sha256"] == profiles.PUMA_WEIGHTS_SHA256
    assert profile["model"]["bytes"] == 185_432_060
    assert profile["input"]["maximum_context_edge"] == 1024
    assert profile["resources"]["minimum_working_bytes"] == 2 * 1024**3
    assert profile["compatibility"]["status"] == "unverified"
    assert profile["scientific_validation"]["independent_accuracy"] == "not-established"
    assert profile["scientific_validation"]["checkpoint_fold_membership"] == "unavailable"
    assert "public-training" in profile["scientific_validation"]["reference_examples"]
    assert profile["sources"]["original_dna_acvl_versions"] == "unpinned-unavailable"


def test_profile_hash_binds_complete_contract_and_each_call_returns_fresh_data() -> None:
    profile = profiles.puma_profile()
    digest = profile.pop("contract_sha256")
    encoded = json.dumps(profile, sort_keys=True, separators=(",", ":"), allow_nan=False)
    assert hashlib.sha256(encoded.encode()).hexdigest() == digest
    profile["class_map"]["4"] = "not-epidermis"
    again = profiles.puma_profile()
    assert again["contract_sha256"] == digest
    assert again["class_map"]["4"] == "tissue_epidermis"


def test_metadata_matching_is_not_runtime_or_model_qualification(monkeypatch: pytest.MonkeyPatch):
    _runtime_metadata(monkeypatch, dict(profiles.PUMA_RUNTIME_VERSIONS))
    status = profiles.runtime_metadata_status()
    assert status["status"] == "metadata-matches-unverified"
    assert status["runtime_import_verified"] is False
    assert status["technical_compatibility_verified"] is False
    assert status["missing"] == status["mismatched"] == []


@pytest.mark.parametrize("name", ["torch", "numpy", "scipy"])
def test_missing_distribution_is_unavailable(monkeypatch: pytest.MonkeyPatch, name: str):
    versions = {**profiles.PUMA_RUNTIME_VERSIONS, name: None}
    _runtime_metadata(monkeypatch, versions)
    status = profiles.runtime_metadata_status()
    assert status["status"] == "missing"
    assert status["missing"] == [name]
    assert status["technical_compatibility_verified"] is False


def test_modeling_environment_is_explicitly_not_the_engine_runtime(monkeypatch: pytest.MonkeyPatch):
    _runtime_metadata(monkeypatch, {"torch": "2.13.0", "numpy": "1.26.4", "scipy": "1.17.1"})
    monkeypatch.setattr(profiles, "sys", SimpleNamespace(version_info=(3, 11, 1)))
    status = profiles.runtime_metadata_status()
    assert status["status"] == "mismatch"
    assert set(status["mismatched"]) == {"numpy", "scipy", "python-major-minor"}


def test_profile_inspection_never_imports_torch(monkeypatch: pytest.MonkeyPatch):
    _runtime_metadata(monkeypatch, dict(profiles.PUMA_RUNTIME_VERSIONS))
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            raise AssertionError("Profile inspection imported Torch")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    assert profiles.puma_profile()["runtime"]["optional"] is True
    assert profiles.runtime_metadata_status()["runtime_import_verified"] is False
