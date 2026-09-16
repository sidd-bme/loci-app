#!/usr/bin/env python3
"""Fail-closed structural and CLI checks for a frozen Loci engine bundle."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from email.parser import Parser
from pathlib import Path

import tomllib


class BundleVerificationError(RuntimeError):
    """Raised when a frozen worker is incomplete or has the wrong identity."""


REQUIRED_DISTRIBUTION_NOTICES = {
    "simpleitk": ("LICENSE", "NOTICE"),
    "openslide-python": ("licenses/COPYING.LESSER",),
    "openslide-bin": (
        "licenses/COPYING.LESSER",
        "licenses/licenses/OpenSlide/COPYING.LESSER",
    ),
    "zarr": ("licenses/LICENSE.txt",),
    "numcodecs": ("licenses/LICENSE.txt", "licenses/c-blosc/LICENSE.txt"),
    "mcp": ("licenses/LICENSE",),
    "onnx": ("licenses/LICENSE", "licenses/NOTICE"),
    "onnxruntime": (),
    "pyyaml": ("licenses/LICENSE",),
    "roifile": ("licenses/LICENSE",),
}

REQUIRED_PACKAGE_NOTICES = {
    "onnxruntime/LICENSE",
    "onnxruntime/ThirdPartyNotices.txt",
}

REQUIRED_NATIVE_COMPONENTS = {
    "SimpleITK": ("_SimpleITK",),
    "openslide_bin": ("libopenslide",),
    "numcodecs": ("blosc", "zstd"),
    "onnx": ("onnx_cpp2py_export",),
    "onnxruntime": ("onnxruntime_pybind11_state",),
}

EXPECTED_MCP_TOOLS = {
    "catalog",
    "inspect_source",
    "validate_recipe",
    "preview_recipe",
    "submit_recipe",
    "job_status",
    "cancel_job",
    "result",
    "result_view",
    "export_result",
}

WINDOWS_CLEANUP_ATTEMPTS = 40
WINDOWS_CLEANUP_DELAY_SECONDS = 0.05


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--platform", choices=("darwin", "win32"), required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    return parser


def _canonical_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _locked_versions(lock_path: Path) -> dict[str, set[str]]:
    try:
        document = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise BundleVerificationError(
            f"Engine lock is not readable TOML: {lock_path}"
        ) from exc
    result: dict[str, set[str]] = {}
    for item in document.get("package", []):
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        version = item.get("version")
        if isinstance(name, str) and isinstance(version, str):
            result.setdefault(_canonical_name(name), set()).add(version)
    return result


def _distribution_metadata(internal: Path) -> dict[str, tuple[str, Path]]:
    result: dict[str, tuple[str, Path]] = {}
    for metadata_dir in sorted(internal.glob("*.dist-info")):
        metadata_file = metadata_dir / "METADATA"
        if not metadata_file.is_file():
            continue
        try:
            metadata = Parser().parsestr(metadata_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as exc:
            raise BundleVerificationError(
                f"Distribution metadata is unreadable: {metadata_file}"
            ) from exc
        name = metadata.get("Name")
        version = metadata.get("Version")
        if not name or not version:
            raise BundleVerificationError(
                f"Distribution metadata has no Name/Version: {metadata_file}"
            )
        canonical = _canonical_name(name)
        if canonical in result:
            raise BundleVerificationError(
                f"Frozen bundle contains duplicate metadata for {canonical}"
            )
        result[canonical] = (version, metadata_dir)
    return result


def _require_regular_nonempty(path: Path, message: str) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
        raise BundleVerificationError(f"{message}: {path}")


def _verify_pe_x64(executable: Path) -> None:
    content = executable.read_bytes()
    if len(content) < 0x40 or content[:2] != b"MZ":
        raise BundleVerificationError("Windows worker is not a PE executable")
    pe_offset = struct.unpack_from("<I", content, 0x3C)[0]
    if pe_offset + 6 > len(content) or content[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise BundleVerificationError("Windows worker has an invalid PE header")
    machine = struct.unpack_from("<H", content, pe_offset + 4)[0]
    if machine != 0x8664:
        raise BundleVerificationError(
            f"Windows worker machine is 0x{machine:04x}, expected AMD64 (0x8664)"
        )


def _verify_native_components(internal: Path) -> None:
    native_suffixes = {".dll", ".dylib", ".pyd", ".so"}
    for package, stems in REQUIRED_NATIVE_COMPONENTS.items():
        package_root = internal / package
        files = [
            item
            for item in package_root.rglob("*")
            if item.is_file()
            and (item.suffix.lower() in native_suffixes or ".so." in item.name.lower())
        ]
        lowered = [item.name.lower() for item in files]
        for stem in stems:
            if not any(stem.lower() in name for name in lowered):
                raise BundleVerificationError(
                    f"Frozen bundle is missing the {package} native component matching {stem}"
                )


def _create_mcp_fixture_policy(root: Path) -> Path:
    """Create one disposable source, study and least-authority MCP policy."""
    import numpy as np
    import tifffile
    from loci_engine.agent_policy import write_policy
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    source_path = root / "owned-source.tif"
    tifffile.imwrite(source_path, np.arange(64, dtype=np.uint16).reshape(8, 8))
    workbench = Workbench(ResearchProject.create(root / "owned-study", "Frozen MCP QA"))
    try:
        source = workbench.import_native(
            str(source_path), name="owned synthetic source"
        )
        policy_path = root / "agent-policy.json"
        write_policy(
            policy_path,
            workbench.project,
            {
                "sources": [
                    {
                        "id": source["id"],
                        "sha256": source["sha256"],
                        "crop": {"x": 0, "y": 0, "width": 8, "height": 8},
                        "t": [0],
                        "c": [0],
                        "z": [0],
                        "level": [0],
                        "measurement_channels": [0],
                    }
                ],
                "recipes": [],
                "operations": [],
                "model_packages": [],
                "runtimes": [],
                "export": None,
                "limits": {
                    "cpu_seconds": 60,
                    "memory_bytes": 512 * 1024**2,
                    "concurrency": 1,
                },
                "disclosures": [],
            },
        )
        return policy_path
    finally:
        workbench.close()


def _validate_mcp_exchange(
    initialized: object, listed: object, catalog: object
) -> dict[str, object]:
    protocol = getattr(initialized, "protocol_version", None)
    if not isinstance(protocol, str) or not protocol:
        raise BundleVerificationError(
            "Frozen MCP initialize returned no protocol version"
        )
    tools = getattr(listed, "tools", None)
    if not isinstance(tools, list):
        raise BundleVerificationError("Frozen MCP tools/list returned no tools array")
    names = {getattr(tool, "name", None) for tool in tools}
    if names != EXPECTED_MCP_TOOLS or len(tools) != len(EXPECTED_MCP_TOOLS):
        raise BundleVerificationError(
            "Frozen MCP tools/list did not return the exact research tool surface"
        )
    if getattr(catalog, "is_error", None) is True:
        raise BundleVerificationError("Frozen MCP catalog returned a tool error")
    content = getattr(catalog, "structured_content", None)
    if not isinstance(content, dict):
        raise BundleVerificationError(
            "Frozen MCP catalog returned no structured content"
        )
    catalog_tools = content.get("tools")
    catalog_names = (
        {item.get("name") for item in catalog_tools if isinstance(item, dict)}
        if isinstance(catalog_tools, list)
        else set()
    )
    if (
        content.get("schema") != "loci.agent-tools/v1"
        or content.get("transport") != "stdio"
        or content.get("dataset_contents_included") is not False
        or catalog_names != EXPECTED_MCP_TOOLS
        or len(catalog_tools) != len(EXPECTED_MCP_TOOLS)
    ):
        raise BundleVerificationError(
            "Frozen MCP catalog returned an invalid tool catalog"
        )
    return {"protocol": protocol, "tool_count": len(names), "catalog": "passed"}


async def _exercise_frozen_mcp(
    executable: Path, policy_path: Path
) -> dict[str, object]:
    from mcp.client.session import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    parameters = StdioServerParameters(
        command=str(executable),
        args=["--cli", "mcp", "--policy", str(policy_path)],
    )
    with tempfile.TemporaryFile(mode="w+") as diagnostics:
        async with (
            stdio_client(parameters, errlog=diagnostics) as streams,
            ClientSession(*streams) as session,
        ):
            initialized = await asyncio.wait_for(session.initialize(), timeout=120)
            listed = await asyncio.wait_for(session.list_tools(), timeout=60)
            catalog = await asyncio.wait_for(session.call_tool("catalog"), timeout=60)
        diagnostics.seek(0)
        stderr = diagnostics.read()
    if stderr:
        raise BundleVerificationError(
            "Frozen MCP wrote diagnostics during a valid exchange"
        )
    return _validate_mcp_exchange(initialized, listed, catalog)


def _remove_owned_mcp_fixture(root: Path, *, attempts: int, delay: float) -> None:
    """Remove the owned fixture after Windows releases the stopped server's handles."""
    for attempt in range(attempts):
        try:
            shutil.rmtree(root)
            return
        except PermissionError as exc:
            if attempt + 1 == attempts:
                raise BundleVerificationError(
                    "Frozen MCP process did not release its fixture files after shutdown"
                ) from exc
            time.sleep(delay)


def _verify_frozen_mcp(executable: Path) -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="loci-frozen-mcp-qa-"))
    attempts = WINDOWS_CLEANUP_ATTEMPTS if sys.platform == "win32" else 1
    try:
        policy_path = _create_mcp_fixture_policy(root)
        try:
            return asyncio.run(_exercise_frozen_mcp(executable, policy_path))
        except BundleVerificationError:
            raise
        except Exception as exc:
            raise BundleVerificationError(
                "Frozen MCP initialize, tools/list or catalog exchange failed"
            ) from exc
    finally:
        _remove_owned_mcp_fixture(
            root, attempts=attempts, delay=WINDOWS_CLEANUP_DELAY_SECONDS
        )


def verify_bundle(
    bundle: Path, lock_path: Path, platform_name: str, arch: str
) -> dict[str, object]:
    if bundle.is_symlink() or not bundle.is_dir():
        raise BundleVerificationError(
            f"Frozen bundle is not a plain directory: {bundle}"
        )
    executable_name = "loci-engine.exe" if platform_name == "win32" else "loci-engine"
    executable = bundle / executable_name
    _require_regular_nonempty(executable, "Frozen worker executable is missing")
    if platform_name == "win32":
        if arch != "x64":
            raise BundleVerificationError(
                "The supported Windows frozen worker architecture is x64"
            )
        _verify_pe_x64(executable)

    internal = bundle / "_internal"
    if internal.is_symlink() or not internal.is_dir():
        raise BundleVerificationError(
            f"Frozen worker has no _internal directory: {internal}"
        )
    locked = _locked_versions(lock_path)
    metadata = _distribution_metadata(internal)
    verified_versions: dict[str, str] = {}
    for name, notice_paths in REQUIRED_DISTRIBUTION_NOTICES.items():
        if name not in metadata:
            raise BundleVerificationError(
                f"Frozen bundle is missing {name} distribution metadata"
            )
        version, metadata_dir = metadata[name]
        if version not in locked.get(name, set()):
            raise BundleVerificationError(
                f"Frozen {name} {version} is not represented by engine/uv.lock"
            )
        if name == "roifile" and version != "2026.2.10":
            raise BundleVerificationError("Frozen roifile must be exactly 2026.2.10")
        for relative in notice_paths:
            _require_regular_nonempty(
                metadata_dir / Path(relative), f"Frozen {name} notice is missing"
            )
        verified_versions[name] = version
    for relative in REQUIRED_PACKAGE_NOTICES:
        _require_regular_nonempty(
            internal / Path(relative), "Frozen package notice is missing"
        )
    _verify_native_components(internal)

    completed = subprocess.run(
        [str(executable), "--cli", "discover"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise BundleVerificationError(
            f"Frozen CLI discover exited {completed.returncode}: {completed.stderr.strip()}"
        )
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise BundleVerificationError(
            "Frozen CLI discover did not return one JSON document"
        ) from exc
    if not isinstance(response, dict):
        raise BundleVerificationError(
            "Frozen CLI discover returned a non-object response"
        )
    operations = response.get("operations")
    if (
        response.get("schema") != "loci.operations/v1"
        or not isinstance(operations, dict)
        or not operations
    ):
        raise BundleVerificationError(
            "Frozen CLI discover returned an invalid operation catalog"
        )
    mcp = _verify_frozen_mcp(executable)
    return {
        "status": "passed",
        "platform": platform_name,
        "arch": arch,
        "cli": "discover",
        "operation_count": len(operations),
        "mcp": mcp,
        "distributions": verified_versions,
    }


def main() -> int:
    arguments = _parser().parse_args()
    result = verify_bundle(
        Path(arguments.bundle).absolute(),
        Path(arguments.lock).resolve(),
        arguments.platform,
        arguments.arch,
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BundleVerificationError, OSError, subprocess.SubprocessError) as exc:
        print(f"Frozen bundle verification failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
