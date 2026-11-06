"""Data-only method boundary tests; no runtime imports or compilation."""

from __future__ import annotations

import copy
import struct
from dataclasses import replace

import numpy as np
import pytest

from loci_engine import method_protocol as m


def _uleb(value: int) -> bytes:
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def _section(kind: int, content: bytes) -> bytes:
    return bytes([kind]) + _uleb(len(content)) + content


def module_bytes(*, body: bytes = b"\x41\0", memory: bytes = b"\x01\x01\x01\x80\x04") -> bytes:
    """Inspectable scalar Core module: (i32,i32,i32,i32)->i32, one memory.

    The default function returns zero. Tests can supply instruction bytes;
    production registration never accepts WAT or invokes this assembler.
    """
    name = b"loci_method_v1"
    exports = b"\x02\x06memory\x02\0" + bytes([len(name)]) + name + b"\0\0"
    code = b"\0" + body + b"\x0b"  # no locals; function instructions; end
    return (
        b"\0asm\x01\0\0\0"
        + _section(1, b"\x01\x60\x04\x7f\x7f\x7f\x7f\x01\x7f")
        + _section(3, b"\x01\0")
        + _section(5, memory)
        + _section(7, exports)
        + _section(10, b"\x01" + _uleb(len(code)) + code)
    )


def manifest(module: bytes | None = None) -> dict:
    module = module_bytes() if module is None else module
    return {
        "schema": m.MANIFEST_SCHEMA,
        "id": "fixture-pixel-count",
        "version": "1.0.0",
        "abi": m.ABI,
        "module": {"sha256": m.sha256(module), "bytes": len(module)},
        "rights": {
            "license": "Apache-2.0",
            "source": "Loci authored fixture",
            "use_basis": "repository test only",
        },
        "metrics": [
            {
                "id": "pixel_count",
                "kind": "measurement",
                "unit": "pixel",
                "description": "Fixture per-label pixel count, not biological validation",
            }
        ],
    }


def method(module: bytes | None = None) -> m.RegisteredMethod:
    module = module_bytes() if module is None else module
    return m.register_method(manifest(module), module)


def approval(registered: m.RegisteredMethod) -> m.MethodExecutionApproval:
    return m.MethodExecutionApproval(registered.manifest_sha256, registered.module_sha256, "a" * 64)


def snapshot() -> m.MethodInput:
    return m.build_method_input(
        np.array([[0, 7, 7], [42, 42, 42]], dtype=np.uint32),
        np.array([[[3, 5, 8], [13, 21, 34]]], dtype=np.uint16),
        source_sha256="b" * 64,
        label_revision_sha256="c" * 64,
        geometry={
            "axes": "YX",
            "level": 0,
            "origin_yx": [10, 20],
            "spacing_yx": [0.5, 0.25],
            "unit": "um",
        },
    )


def output_bytes(
    values: tuple[float, float] = (2.0, 3.0), labels: tuple[int, int] = (7, 42)
) -> bytes:
    return struct.pack("<8sII", m.OUTPUT_MAGIC, 2, 1) + b"".join(
        struct.pack("<Id", label, value) for label, value in zip(labels, values, strict=True)
    )


def test_registration_copies_metadata_without_importing_runtime():
    source = manifest()
    registered = m.register_method(source, module_bytes())
    source["metrics"][0]["unit"] = "changed"
    assert registered.manifest()["metrics"][0]["unit"] == "pixel"
    assert registered.manifest_sha256 == m.sha256(registered.manifest_bytes)
    assert m.inspect_wasm_surface(registered.module_bytes) == m.WasmSurface(1, 512)


def test_code_owned_qualification_fixture_matches_independent_abi_fixture():
    from test_method_runtime import _constant_output_module

    registered, supplied, output = m.qualification_fixture()
    assert supplied == snapshot()
    assert output == output_bytes()
    assert registered == method(_constant_output_module(output_bytes()))
    # A separately written literal section pins both the fourteen-byte export
    # name and total section length; neither fixture assembler supplies this.
    assert b"\x07\x1b\x02\x06memory\x02\x00\x0eloci_method_v1\x00\x00" in registered.module_bytes


@pytest.mark.parametrize("section_id", [2, 4, 8, 9, 12, 13, 255])
def test_registration_refuses_imports_start_tables_and_extensions(section_id):
    payload = b"\0asm\x01\0\0\0" + _section(section_id, b"\0")
    with pytest.raises(m.MethodContractError):
        m.register_method(manifest(payload), payload)


@pytest.mark.parametrize(
    "memory",
    [
        b"\x01\0\x01",  # no maximum
        b"\x02\x01\x01\x02\x01\x01\x02",  # multiple memories
        b"\x01\x03\x01\x02",  # shared memory
        b"\x01\x05\x01\x02",  # memory64
        b"\x01\x01\x01\x81\x04",  # maximum > 512
        b"\x01\x01\x02\x01",  # minimum > maximum
    ],
)
def test_memory_contract_refuses_unsupported_limits(memory):
    with pytest.raises(m.MethodContractError):
        method(module_bytes(memory=memory))


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value.update(abi="loci-method-buffers/v0"),
        lambda value: value.update(version="latest"),
        lambda value: value["module"].update(sha256="0" * 64),
        lambda value: value["module"].update(bytes=True),
        lambda value: value["rights"].update(review_status="accepted"),
        lambda value: value["rights"].update(license=""),
        lambda value: value["metrics"][0].update(kind="diagnosis"),
        lambda value: value["metrics"].append(copy.deepcopy(value["metrics"][0])),
    ],
)
def test_manifest_identity_and_declarations_are_strict(change):
    source = manifest()
    change(source)
    with pytest.raises(m.MethodContractError):
        m.register_method(source, module_bytes())


@pytest.mark.parametrize(
    "payload",
    [
        b"(module)",
        b"\0asm\x0d\0\x01\0",
        b"\0asm\x01\0\0\0\x01\xff",
        b"\0asm\x01\0\0\0\x01\x80\x00",
        b"\0asm\x01\0\0\0\x01\xff\xff\xff\xff\x10",
    ],
)
def test_module_binary_refusals(payload):
    with pytest.raises(m.MethodContractError):
        m.inspect_wasm_surface(payload)


def test_export_identity_and_duplicate_section_refused():
    original = module_bytes()
    # A duplicate memory section after the code violates both identity and order.
    with pytest.raises(m.MethodContractError):
        m.inspect_wasm_surface(original + _section(5, b"\x01\x01\x01\x02"))
    with pytest.raises(m.MethodContractError):
        m.inspect_wasm_surface(original.replace(b"loci_method_v1", b"loci_method_v2"))


def test_separate_host_approval_cannot_authorize_different_method():
    registered = method()
    m.validate_execution_approval(registered, approval(registered))
    with pytest.raises(m.MethodContractError):
        m.validate_execution_approval(registered, None)
    with pytest.raises(m.MethodContractError):
        m.validate_execution_approval(
            registered, replace(approval(registered), manifest_sha256="0" * 64)
        )
    with pytest.raises(m.MethodContractError):
        m.revalidate_method(replace(registered, module_sha256="0" * 64))


def test_input_buffers_preserve_exact_axes_bytes_and_noncontiguous_views():
    labels = np.array([[0, 7, 42], [7, 0, 42]], dtype=np.uint32)[:, ::-1]
    raw = np.arange(12, dtype=np.float64).reshape(2, 2, 3)[:, :, ::-1]
    packed = m.build_method_input(
        labels,
        raw,
        source_sha256="b" * 64,
        label_revision_sha256="c" * 64,
        geometry={
            "axes": "YX",
            "level": 0,
            "origin_yx": [0, 0],
            "spacing_yx": [1, 1],
            "unit": "pixel",
        },
    )
    metadata = m.validate_input_snapshot(packed)
    assert metadata["raw"]["axes"] == "CYX"
    assert metadata["raw"]["shape"] == [2, 2, 3]
    assert metadata["raw_sha256"] == m.sha256(raw.astype("<f8").tobytes())
    original = packed.buffer
    labels[:] = 0
    raw[:] = 0
    assert packed.buffer == original
    assert packed.label_ids == (7, 42)


@pytest.mark.parametrize(
    "labels,raw",
    [
        (np.ones((2, 2), dtype=np.int32), np.zeros((1, 2, 2), dtype=np.uint8)),
        (np.ones((1, 2, 2), dtype=np.uint32), np.zeros((1, 2, 2), dtype=np.uint8)),
        (np.ones((2, 2), dtype=np.uint32), np.zeros((2, 2), dtype=np.uint8)),
        (np.ones((2, 2), dtype=np.uint32), np.zeros((1, 2, 3), dtype=np.uint8)),
        (np.ones((2, 2), dtype=np.uint32), np.zeros((1, 2, 2), dtype=np.int16)),
        (np.ones((2, 2), dtype=np.uint32), np.full((1, 2, 2), np.nan, dtype=np.float32)),
        (np.zeros((2, 2), dtype=np.uint32), np.zeros((1, 2, 2), dtype=np.uint8)),
    ],
)
def test_unsupported_scientific_inputs_are_not_coerced(labels, raw):
    with pytest.raises(m.MethodContractError):
        m.build_method_input(
            labels,
            raw,
            source_sha256="b" * 64,
            label_revision_sha256="c" * 64,
            geometry={
                "axes": "YX",
                "level": 0,
                "origin_yx": [0, 0],
                "spacing_yx": [1, 1],
                "unit": "pixel",
            },
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("axes", "XY"),
        ("level", 1),
        ("level", False),
        ("spacing_yx", [0, 1]),
        ("origin_yx", [0, float("inf")]),
        ("spacing_yx", [1, 10**400]),
        ("unit", "mm"),
        ("unit", ["um"]),
    ],
)
def test_geometry_is_explicit_and_finite(field, value):
    geometry = {
        "axes": "YX",
        "level": 0,
        "origin_yx": [0, 0],
        "spacing_yx": [1, 1],
        "unit": "pixel",
    }
    geometry[field] = value
    with pytest.raises(m.MethodContractError):
        m.build_method_input(
            np.ones((2, 2), dtype=np.uint32),
            np.zeros((1, 2, 2), dtype=np.uint8),
            source_sha256="b" * 64,
            label_revision_sha256="c" * 64,
            geometry=geometry,
        )


def test_snapshot_hash_and_label_id_tampering_refused():
    original = snapshot()
    with pytest.raises(m.MethodContractError):
        m.validate_input_snapshot(replace(original, label_ids=(7, 43)))
    altered = original.buffer[:-1] + bytes([original.buffer[-1] ^ 1])
    with pytest.raises(m.MethodContractError):
        m.validate_input_snapshot(replace(original, buffer=altered))
    # Rehashing the outer buffer cannot conceal disagreement with inner raw hash.
    with pytest.raises(m.MethodContractError):
        m.validate_input_snapshot(replace(original, buffer=altered, sha256=m.sha256(altered)))


@pytest.mark.parametrize(
    "output",
    [
        output_bytes((float("nan"), 3)),
        output_bytes((float("inf"), 3)),
        output_bytes(labels=(42, 7)),
        output_bytes(labels=(7, 7)),
        output_bytes(labels=(7, 43)),
        output_bytes()[:-1],
        output_bytes() + b"x",
        b"BADMAGIC" + output_bytes()[8:],
    ],
)
def test_output_nonfinite_identity_and_length_refusals(output):
    with pytest.raises(m.MethodContractError):
        m.validate_method_output(method(), snapshot(), output)


def test_adoption_is_exact_unreviewed_and_does_not_claim_execution():
    output = output_bytes()
    result = m.adopt_method_output(
        method(), snapshot(), output, expected_output_sha256=m.sha256(output)
    )
    assert result["rows"] == [{"label_id": 7, "values": [2.0]}, {"label_id": 42, "values": [3.0]}]
    assert result["origin"] == "adopted-external"
    assert result["scientific_review"] == "pending"
    assert result["runtime"] is None
    with pytest.raises(m.MethodContractError):
        m.adopt_method_output(method(), snapshot(), output, expected_output_sha256="0" * 64)


def test_prediction_kind_survives_adoption_without_accuracy_claim():
    metadata = manifest()
    metadata["metrics"][0]["kind"] = "prediction"
    registered = m.register_method(metadata, module_bytes())
    result = m.adopt_method_output(
        registered, snapshot(), output_bytes(), expected_output_sha256=m.sha256(output_bytes())
    )
    assert result["metrics"][0]["kind"] == "prediction"
    assert result["scientific_review"] == "pending"


def test_oversized_module_is_refused_before_scanning():
    with pytest.raises(m.MethodContractError, match="size"):
        m.inspect_wasm_surface(b"x" * (m.MAX_MODULE_BYTES + 1))


@pytest.mark.parametrize(
    "shape,channels,unique_labels",
    [
        ((513, 512), 1, False),
        ((2, 2), 9, False),
        ((1, 16385), 1, True),
    ],
)
def test_input_pixel_channel_and_object_bounds(shape, channels, unique_labels):
    labels = np.ones(shape, dtype=np.uint32)
    if unique_labels:
        labels[:] = np.arange(1, labels.size + 1, dtype=np.uint32).reshape(shape)
    raw = np.zeros((channels, *shape), dtype=np.uint8)
    with pytest.raises(m.MethodContractError):
        m.build_method_input(
            labels,
            raw,
            source_sha256="b" * 64,
            label_revision_sha256="c" * 64,
            geometry={
                "axes": "YX",
                "level": 0,
                "origin_yx": [0, 0],
                "spacing_yx": [1, 1],
                "unit": "pixel",
            },
        )
