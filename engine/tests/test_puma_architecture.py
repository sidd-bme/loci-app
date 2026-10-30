from __future__ import annotations

import os

import pytest

from loci_engine import puma_architecture as architecture
from loci_engine.tissue_model_profiles import PUMA_TENSOR_BYTES


def test_static_tensor_contract_has_exact_keys_storage_groups_shapes_and_bytes() -> None:
    schema = architecture.STATE_SCHEMA
    groups = {spec.canonical_key: spec for spec in schema.values()}
    assert len(schema) == 396
    assert len(groups) == 148
    assert sum(spec.nbytes for spec in groups.values()) == PUMA_TENSOR_BYTES
    first = schema["encoder.stages.0.0.convs.0.conv.weight"]
    assert first.shape == (32, 3, 3, 3)
    assert first.stride == (27, 9, 3, 1)
    assert first.nbytes == 3456
    assert schema["decoder.encoder.stages.0.0.convs.0.all_modules.0.weight"] is first
    assert schema["decoder.seg_layers.6.weight"].shape == (6, 32, 1, 1)
    assert schema["decoder.transpconvs.0.weight"].shape == (512, 512, 2, 2)


def test_no_checkpoint_key_can_escape_its_named_alias_group() -> None:
    for key, spec in architecture.STATE_SCHEMA.items():
        assert spec.canonical_key in architecture.STATE_SCHEMA
        assert architecture.STATE_SCHEMA[spec.canonical_key] is spec
        assert spec.canonical_key.startswith(("encoder.", "decoder."))
        assert all(size > 0 for size in spec.shape)
        assert key.endswith((".weight", ".bias"))


@pytest.fixture
def torch_runtime():
    if os.environ.get("LOCI_PUMA_TORCH_TESTS") != "1":
        pytest.skip("Requires the lead-owned explicit Torch test slot")
    return pytest.importorskip("torch")


def test_module_hierarchy_matches_static_tensor_contract(torch_runtime):
    network = architecture.make_network(torch_runtime)
    record = architecture.validate_state(torch_runtime, network.state_dict())
    assert record == {
        "tensor_keys": 396,
        "unique_storages": 148,
        "tensor_bytes": PUMA_TENSOR_BYTES,
        "finite_values_checked": True,
        "aliases_checked": True,
    }


def test_state_rejects_missing_extra_and_broken_aliases(torch_runtime):
    network = architecture.make_network(torch_runtime)
    state = network.state_dict()
    missing = dict(state)
    missing.pop(next(iter(missing)))
    with pytest.raises(ValueError, match="396"):
        architecture.validate_state(torch_runtime, missing)
    with pytest.raises(ValueError, match="396"):
        architecture.validate_state(
            torch_runtime, {**state, "unexpected": next(iter(state.values()))}
        )
    alias = "encoder.stages.0.0.convs.0.all_modules.0.weight"
    broken = dict(state)
    broken[alias] = broken[alias].clone()
    with pytest.raises(ValueError, match="aliases"):
        architecture.validate_state(torch_runtime, broken)


def test_state_rejects_nonfinite_values_and_wrong_dtype(torch_runtime):
    network = architecture.make_network(torch_runtime)
    state = network.state_dict()
    first = "encoder.stages.0.0.convs.0.conv.weight"
    state[first].reshape(-1)[0] = float("nan")
    with pytest.raises(ValueError, match="nonfinite"):
        architecture.validate_state(torch_runtime, state)
    state[first].reshape(-1)[0] = 0
    state[first] = state[first].double()
    with pytest.raises(ValueError, match="dtype"):
        architecture.validate_state(torch_runtime, state)
