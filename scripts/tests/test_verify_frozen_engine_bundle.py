from __future__ import annotations

import importlib.util
import json
import os
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).parents[1] / "verify_frozen_engine_bundle.py"
SPEC = importlib.util.spec_from_file_location("verify_frozen_engine_bundle", SCRIPT)
assert SPEC and SPEC.loader
verify_frozen_engine_bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_frozen_engine_bundle)


def _pe(machine: int) -> bytes:
    content = bytearray(128)
    content[:2] = b"MZ"
    struct.pack_into("<I", content, 0x3C, 64)
    content[64:68] = b"PE\0\0"
    struct.pack_into("<H", content, 68, machine)
    return bytes(content)


def test_pe_x64_verification_accepts_amd64_and_rejects_other_machine(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "loci-engine.exe"
    executable.write_bytes(_pe(0x8664))
    verify_frozen_engine_bundle._verify_pe_x64(executable)

    executable.write_bytes(_pe(0xAA64))
    with pytest.raises(
        verify_frozen_engine_bundle.BundleVerificationError, match="expected AMD64"
    ):
        verify_frozen_engine_bundle._verify_pe_x64(executable)


def test_distribution_metadata_rejects_duplicate_normalized_names(
    tmp_path: Path,
) -> None:
    for directory, name in (
        ("mcp-2.1.1.dist-info", "mcp"),
        ("MCP-2.1.1-copy.dist-info", "MCP"),
    ):
        root = tmp_path / directory
        root.mkdir()
        (root / "METADATA").write_text(
            f"Name: {name}\nVersion: 2.1.1\n", encoding="utf-8"
        )

    with pytest.raises(
        verify_frozen_engine_bundle.BundleVerificationError, match="duplicate metadata"
    ):
        verify_frozen_engine_bundle._distribution_metadata(tmp_path)


def test_locked_versions_preserve_platform_alternatives(tmp_path: Path) -> None:
    lock = tmp_path / "uv.lock"
    lock.write_text(
        '[[package]]\nname = "imagecodecs"\nversion = "1.0"\n'
        '[[package]]\nname = "imagecodecs"\nversion = "2.0"\n',
        encoding="utf-8",
    )
    assert verify_frozen_engine_bundle._locked_versions(lock) == {
        "imagecodecs": {"1.0", "2.0"}
    }


def test_mcp_fixture_policy_is_owned_minimal_and_disposable(tmp_path: Path) -> None:
    policy = verify_frozen_engine_bundle._create_mcp_fixture_policy(tmp_path)
    document = json.loads(policy.read_text(encoding="utf-8"))

    assert policy.parent == tmp_path
    assert not policy.is_symlink()
    if os.name == "posix":
        assert policy.stat().st_mode & 0o777 == 0o600
    assert document["project"]["path"] == str((tmp_path / "owned-study").resolve())
    assert document["sources"][0]["sha256"]
    assert document["recipes"] == []
    assert document["operations"] == []
    assert document["model_packages"] == []
    assert document["runtimes"] == []
    assert document["export"] is None
    assert document["disclosures"] == []


def test_owned_mcp_fixture_cleanup_retries_transient_windows_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "fixture"
    root.mkdir()
    calls = 0

    def remove(path: Path) -> None:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise PermissionError("still locked")
        path.rmdir()

    monkeypatch.setattr(verify_frozen_engine_bundle.shutil, "rmtree", remove)
    verify_frozen_engine_bundle._remove_owned_mcp_fixture(root, attempts=3, delay=0)

    assert calls == 3
    assert not root.exists()


def test_owned_mcp_fixture_cleanup_rejects_persistent_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "fixture"
    root.mkdir()

    def remove(_path: Path) -> None:
        raise PermissionError("still locked")

    monkeypatch.setattr(verify_frozen_engine_bundle.shutil, "rmtree", remove)
    with pytest.raises(
        verify_frozen_engine_bundle.BundleVerificationError,
        match="did not release its fixture files",
    ):
        verify_frozen_engine_bundle._remove_owned_mcp_fixture(root, attempts=2, delay=0)


def test_mcp_exchange_requires_exact_tools_and_safe_catalog() -> None:
    names = verify_frozen_engine_bundle.EXPECTED_MCP_TOOLS
    initialized = SimpleNamespace(protocol_version="2025-11-25")
    listed = SimpleNamespace(tools=[SimpleNamespace(name=name) for name in names])
    catalog = SimpleNamespace(
        is_error=False,
        structured_content={
            "schema": "loci.agent-tools/v1",
            "transport": "stdio",
            "tools": [{"name": name} for name in names],
            "dataset_contents_included": False,
        },
    )

    assert verify_frozen_engine_bundle._validate_mcp_exchange(
        initialized, listed, catalog
    ) == {
        "protocol": "2025-11-25",
        "tool_count": 10,
        "catalog": "passed",
    }

    listed.tools.append(listed.tools[0])
    with pytest.raises(
        verify_frozen_engine_bundle.BundleVerificationError,
        match="exact research tool surface",
    ):
        verify_frozen_engine_bundle._validate_mcp_exchange(initialized, listed, catalog)
    listed.tools.pop()

    catalog.structured_content["tools"].append({"name": "catalog"})
    with pytest.raises(
        verify_frozen_engine_bundle.BundleVerificationError,
        match="invalid tool catalog",
    ):
        verify_frozen_engine_bundle._validate_mcp_exchange(initialized, listed, catalog)
    catalog.structured_content["tools"].pop()

    listed.tools.pop()
    with pytest.raises(
        verify_frozen_engine_bundle.BundleVerificationError,
        match="exact research tool surface",
    ):
        verify_frozen_engine_bundle._validate_mcp_exchange(initialized, listed, catalog)
