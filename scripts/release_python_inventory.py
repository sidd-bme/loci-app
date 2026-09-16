"""Inventory the exact installed macOS runtime closure for release tooling.

This helper must run with ``engine/.venv/bin/python``.  Keeping the metadata
walk in that interpreter means marker evaluation and installed distribution
selection match the frozen worker environment rather than the developer's
system Python.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
from importlib import metadata
from pathlib import Path

import tomllib
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT_DISTRIBUTION = "loci-engine"
RUNTIME_EXTRAS = ("cellpose", "onnx")
EMBEDDED_BUILD_DISTRIBUTIONS = ("pyinstaller",)
LICENCE_PREFIXES = ("license", "licence", "copying", "notice")
SUPPLEMENTAL_PREFIXES = ("authors",)
# This exact wheel omits upstream's licence payload. Keep the version and
# upstream bytes pinned: a new version must supply or requalify its evidence.
UPSTREAM_LICENCES = {
    ("flatbuffers", "25.12.19"): (
        "flatbuffers-25.12.19/LICENSE",
        "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    ),
}


class InventoryError(RuntimeError):
    """Raised when installed runtime evidence is incomplete or inconsistent."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True)
    return parser


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _locked_versions(lock_path: Path) -> set[tuple[str, str]]:
    try:
        document = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise InventoryError(f"engine lock is not readable TOML: {lock_path}") from exc
    packages = document.get("package")
    if not isinstance(packages, list):
        raise InventoryError("engine lock has no package inventory")
    result: set[tuple[str, str]] = set()
    for package in packages:
        if not isinstance(package, dict):
            continue
        name = package.get("name")
        version = package.get("version")
        if isinstance(name, str) and isinstance(version, str):
            result.add((canonicalize_name(name), version))
    return result


def _installed_distributions() -> dict[str, metadata.Distribution]:
    result: dict[str, metadata.Distribution] = {}
    for distribution in metadata.distributions():
        raw_name = distribution.metadata.get("Name")
        if not raw_name:
            continue
        name = canonicalize_name(raw_name)
        existing = result.get(name)
        if existing is not None and existing.version != distribution.version:
            raise InventoryError(
                f"multiple installed versions found for {name}: "
                f"{existing.version}, {distribution.version}"
            )
        result[name] = distribution
    return result


def _applies(requirement: Requirement, *, extra: str = "") -> bool:
    if requirement.marker is None:
        return True
    environment = default_environment()
    environment["extra"] = extra
    return requirement.marker.evaluate(environment)


def _runtime_closure(
    distributions: dict[str, metadata.Distribution],
) -> tuple[dict[str, metadata.Distribution], dict[str, set[str]]]:
    root_name = canonicalize_name(ROOT_DISTRIBUTION)
    root = distributions.get(root_name)
    if root is None:
        raise InventoryError(
            f"{ROOT_DISTRIBUTION} is not installed in this Python environment"
        )

    queued: list[Requirement] = []
    for raw_requirement in root.requires or []:
        requirement = Requirement(raw_requirement)
        if _applies(requirement) or any(
            _applies(requirement, extra=extra) for extra in RUNTIME_EXTRAS
        ):
            queued.append(requirement)

    selected: dict[str, metadata.Distribution] = {}
    edges: dict[str, set[str]] = {root_name: set()}
    while queued:
        requirement = queued.pop(0)
        name = canonicalize_name(requirement.name)
        distribution = distributions.get(name)
        if distribution is None:
            raise InventoryError(f"runtime dependency is not installed: {name}")
        if requirement.specifier and not requirement.specifier.contains(
            distribution.version, prereleases=True
        ):
            raise InventoryError(
                f"installed {name} {distribution.version} does not satisfy {requirement.specifier}"
            )
        if name in selected:
            continue
        selected[name] = distribution
        edges.setdefault(name, set())
        for raw_child in distribution.requires or []:
            child = Requirement(raw_child)
            if not _applies(child):
                continue
            child_name = canonicalize_name(child.name)
            edges[name].add(child_name)
            queued.append(child)

    for raw_requirement in root.requires or []:
        requirement = Requirement(raw_requirement)
        if _applies(requirement) or any(
            _applies(requirement, extra=extra) for extra in RUNTIME_EXTRAS
        ):
            edges[root_name].add(canonicalize_name(requirement.name))
    return selected, edges


def _licence_files(distribution: metadata.Distribution) -> list[dict[str, object]]:
    evidence: list[dict[str, object]] = []
    has_primary = False
    for package_path in sorted(distribution.files or [], key=os.fspath):
        basename = Path(os.fspath(package_path)).name.lower()
        primary = basename.startswith(LICENCE_PREFIXES)
        supplemental = basename.startswith(SUPPLEMENTAL_PREFIXES)
        if not primary and not supplemental:
            continue
        located = Path(distribution.locate_file(package_path))
        try:
            resolved = located.resolve(strict=True)
        except OSError as exc:
            raise InventoryError(
                f"declared licence evidence is missing: {located}"
            ) from exc
        if located.is_symlink() or not resolved.is_file():
            raise InventoryError(f"licence evidence must be a regular file: {resolved}")
        size = resolved.stat().st_size
        if size <= 0:
            # Some wheels retain zero-byte placeholders for optional codecs that
            # were not compiled into that wheel. They are not evidence and are
            # deliberately excluded; the distribution must still have at least
            # one non-empty primary licence below.
            continue
        has_primary = has_primary or primary
        evidence.append(
            {
                "source": os.fspath(resolved),
                "source_relative": os.fspath(package_path).replace(os.sep, "/"),
                "sha256": _sha256(resolved),
                "size_bytes": size,
            }
        )
    if not has_primary:
        name = distribution.metadata.get("Name") or "unknown"
        upstream = UPSTREAM_LICENCES.get(
            (canonicalize_name(name), distribution.version)
        )
        if upstream:
            relative, expected = upstream
            path = Path(__file__).parent / "upstream_licences" / relative
            if path.is_symlink() or not path.is_file() or _sha256(path) != expected:
                raise InventoryError(
                    f"pinned upstream licence evidence is invalid: {name}"
                )
            evidence.append(
                {
                    "source": os.fspath(path.resolve(strict=True)),
                    "source_relative": "upstream/" + relative,
                    "sha256": expected,
                    "size_bytes": path.stat().st_size,
                }
            )
            return evidence
        raise InventoryError(f"runtime dependency has no licence evidence: {name}")
    return evidence


def _declared_license(distribution: metadata.Distribution) -> str | None:
    expression = distribution.metadata.get("License-Expression")
    legacy = distribution.metadata.get("License")
    declared = expression.strip() if expression and expression.strip() else None
    if declared is None and legacy:
        compact = " ".join(legacy.split())
        if compact and len(compact) <= 160:
            declared = compact
    return declared


def build_inventory(lock_path: Path) -> dict[str, object]:
    locked = _locked_versions(lock_path)
    distributions = _installed_distributions()
    selected, edges = _runtime_closure(distributions)
    root_name = canonicalize_name(ROOT_DISTRIBUTION)
    root = distributions[root_name]
    if (root_name, root.version) not in locked:
        raise InventoryError(
            f"installed runtime is not represented by engine/uv.lock: "
            f"{root_name}=={root.version}"
        )
    components: list[dict[str, object]] = []
    for name, distribution in sorted(selected.items()):
        if (name, distribution.version) not in locked:
            raise InventoryError(
                f"installed runtime is not represented by engine/uv.lock: "
                f"{name}=={distribution.version}"
            )
        components.append(
            {
                "name": name,
                "version": distribution.version,
                "purl": f"pkg:pypi/{name}@{distribution.version}",
                "declared_license": _declared_license(distribution),
                "dependencies": sorted(
                    child for child in edges.get(name, set()) if child in selected
                ),
                "evidence": _licence_files(distribution),
            }
        )
    embedded_components: list[dict[str, object]] = []
    for raw_name in EMBEDDED_BUILD_DISTRIBUTIONS:
        name = canonicalize_name(raw_name)
        distribution = distributions.get(name)
        if distribution is None:
            raise InventoryError(f"embedded build component is not installed: {name}")
        if (name, distribution.version) not in locked:
            raise InventoryError(
                f"embedded build component is not represented by engine/uv.lock: "
                f"{name}=={distribution.version}"
            )
        embedded_components.append(
            {
                "name": name,
                "display_name": "PyInstaller bootloader",
                "version": distribution.version,
                "purl": f"pkg:pypi/{name}@{distribution.version}",
                "declared_license": _declared_license(distribution),
                "role": "embedded-bootloader",
                "evidence": _licence_files(distribution),
            }
        )
    return {
        "schema": "loci.python-runtime-inventory/v1",
        "python": platform.python_version(),
        "platform": sys.platform,
        "machine": platform.machine(),
        "root": {
            "name": ROOT_DISTRIBUTION,
            "version": root.version,
            "dependencies": sorted(edges[canonicalize_name(ROOT_DISTRIBUTION)]),
        },
        "components": components,
        "embedded_components": embedded_components,
    }


def main() -> int:
    arguments = _parser().parse_args()
    lock_path = Path(arguments.lock).expanduser().resolve()
    try:
        inventory = build_inventory(lock_path)
    except InventoryError as exc:
        print(f"release Python inventory failed: {exc}", file=sys.stderr)
        return 2
    json.dump(inventory, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
