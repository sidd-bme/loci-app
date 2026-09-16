"""Generate deterministic SBOM and dependency-licence release artifacts.

The command is developer-only release tooling.  It never runs from Loci, never
downloads at application runtime, and never signs, notarizes, or publishes a
build.  Generation is fail-closed when the locked runtime, package inventory,
or upstream licence evidence is incomplete.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA_VERSION = "loci.release-supply-chain/v1"
LICENCE_MANIFEST_SCHEMA = "loci.dependency-licences/v1"
GENERATOR_VERSION = "2"
CYCLONEDX_SPEC_VERSION = "1.6"
CYCLONEDX_NPM_VERSION = "6.0.1"
CYCLONEDX_BOM_VERSION = "7.3.1"
CYCLONEDX_LIBRARY_VERSION = "11.12.0"
EXPECTED_PYTHON = "3.12"
ROOT = Path(__file__).resolve().parents[1]
RELEASE_TOOLS = ROOT / "scripts" / "release-tools"
PYTHON_INVENTORY = ROOT / "scripts" / "release_python_inventory.py"
CYCLONEDX_VALIDATOR = ROOT / "scripts" / "release_validate_cyclonedx.py"
OUTPUT_FILENAMES = {
    "desktop_sbom": "desktop.cdx.json",
    "engine_sbom": "engine.cdx.json",
    "licence_archive": "dependency-licences.zip",
}
LICENCE_BASENAME = re.compile(
    r"^(?:licen[cs]e|copying|notice|authors)(?:[._-].*)?$", re.IGNORECASE
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
CHROME_VERSION_PATTERN = re.compile(
    rb"Chrome/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+) Electron/"
)
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
NPM_UPSTREAM_LICENCES: dict[tuple[str, str], tuple[str, str]] = {
    ("seedrandom", "3.0.5"): (
        "seedrandom-3.0.5/LICENSE",
        "54624bc262234371635aacf512f779e523fc06412869108d0758b71569f7c41a",
    ),
}


class SupplyChainError(RuntimeError):
    """An actionable release-artifact failure."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate or check deterministic CycloneDX SBOMs and the complete "
            "dependency-licence evidence archive for a packaged macOS Loci app."
        )
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("generate", "check"):
        subparser = commands.add_parser(command)
        subparser.add_argument("--app", required=True)
        subparser.add_argument("--repository", default=os.fspath(ROOT))
        subparser.add_argument("--output-dir", required=True)
        if command == "generate":
            subparser.add_argument(
                "--python",
                default=os.fspath(ROOT / "engine" / ".venv" / "bin" / "python"),
                help="Exact Python interpreter used to freeze the worker.",
            )
            subparser.add_argument("--overwrite", action="store_true")
    return parser


def _absolute(value: str, *, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise SupplyChainError(f"{label} must be an absolute path: {value}")
    return path


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _fingerprint(path: Path) -> dict[str, object]:
    try:
        before = path.lstat()
    except OSError as exc:
        raise SupplyChainError(f"file is not readable: {path}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise SupplyChainError(f"expected a no-follow regular file: {path}")
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise SupplyChainError(f"file could not be opened safely: {path}") from exc
    try:
        opened_before = os.fstat(descriptor)
        while chunk := os.read(descriptor, 8 * 1024 * 1024):
            digest.update(chunk)
        opened_after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    after = path.lstat()
    identities = {
        (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
        for item in (before, opened_before, opened_after, after)
    }
    if len(identities) != 1:
        raise SupplyChainError(f"file changed while it was being read: {path}")
    return {"sha256": digest.hexdigest(), "size_bytes": int(after.st_size)}


def _canonical_json(document: object) -> bytes:
    return (
        json.dumps(
            document,
            sort_keys=True,
            indent=2,
            ensure_ascii=True,
            separators=(",", ": "),
        )
        + "\n"
    ).encode("utf-8")


def _read_json(path: Path, *, label: str) -> dict[str, Any]:
    identity = _fingerprint(path)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SupplyChainError(f"{label} is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(document, dict):
        raise SupplyChainError(f"{label} must contain one JSON object")
    if _fingerprint(path) != identity:
        raise SupplyChainError(f"{label} changed while it was being read")
    return document


def _run(
    arguments: Sequence[str], *, cwd: Path, timeout: int = 180
) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.update({"LANG": "C", "LC_ALL": "C"})
    try:
        completed = subprocess.run(
            list(arguments),
            cwd=cwd,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SupplyChainError(
            f"release tool could not run: {Path(arguments[0]).name}"
        ) from exc
    if completed.returncode != 0:
        detail = completed.stdout.strip()[-2000:]
        raise SupplyChainError(
            f"release tool failed ({Path(arguments[0]).name}): {detail}"
        )
    return completed


def _release_evidence_module():
    try:
        from scripts import release_evidence
    except ImportError:
        import release_evidence  # type: ignore[no-redef]

    return release_evidence


def _validate_layout(repository: Path, app: Path, output_dir: Path) -> None:
    if repository.is_symlink() or not repository.is_dir():
        raise SupplyChainError(f"repository must be a real directory: {repository}")
    if app.is_symlink() or not app.is_dir() or app.suffix != ".app":
        raise SupplyChainError(f"app must be a real .app directory: {app}")
    resolved_repository = repository.resolve()
    resolved_app = app.resolve()
    resolved_output = output_dir.resolve(strict=False)
    if (
        resolved_output == resolved_repository
        or resolved_repository in resolved_output.parents
    ):
        raise SupplyChainError("output directory must be outside the repository")
    if resolved_output == resolved_app or resolved_app in resolved_output.parents:
        raise SupplyChainError("output directory must be outside the app bundle")
    if output_dir.is_symlink() or (output_dir.exists() and not output_dir.is_dir()):
        raise SupplyChainError("output directory must be a real directory")


def _prepare_outputs(output_dir: Path, *, overwrite: bool) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {label: output_dir / name for label, name in OUTPUT_FILENAMES.items()}
    for path in paths.values():
        if not path.exists() and not path.is_symlink():
            continue
        if path.is_symlink() or not path.is_file():
            raise SupplyChainError(f"output must be a regular file: {path}")
        if not overwrite:
            raise SupplyChainError(f"output already exists; use --overwrite: {path}")
    return paths


def _npm_dependency_path(
    requester: str, dependency: str, packages: Mapping[str, object]
) -> str:
    current = requester
    while True:
        candidate = (
            f"{current}/node_modules/{dependency}"
            if current
            else f"node_modules/{dependency}"
        )
        if candidate in packages:
            return candidate
        marker = current.rfind("/node_modules/")
        if marker < 0:
            current = ""
        else:
            current = current[:marker]
        if not current:
            candidate = f"node_modules/{dependency}"
            if candidate in packages:
                return candidate
            break
    raise SupplyChainError(
        f"package-lock runtime dependency cannot be resolved: {requester} -> {dependency}"
    )


def npm_runtime_inventory(lock_path: Path) -> list[dict[str, object]]:
    lock = _read_json(lock_path, label="desktop package lock")
    packages = lock.get("packages")
    if lock.get("lockfileVersion") != 3 or not isinstance(packages, dict):
        raise SupplyChainError("desktop package-lock.json must use lockfileVersion 3")
    root = packages.get("")
    if not isinstance(root, dict) or not isinstance(root.get("dependencies"), dict):
        raise SupplyChainError("desktop package lock has no root runtime dependencies")
    queue = [f"node_modules/{name}" for name in sorted(root["dependencies"])]
    selected: dict[str, dict[str, object]] = {}
    while queue:
        package_path = queue.pop(0)
        if package_path in selected:
            continue
        raw = packages.get(package_path)
        if not isinstance(raw, dict):
            raise SupplyChainError(f"locked runtime package is missing: {package_path}")
        name = package_path.rsplit("node_modules/", 1)[-1]
        version = raw.get("version")
        if not isinstance(version, str) or not version:
            raise SupplyChainError(
                f"runtime package has no locked version: {package_path}"
            )
        dependencies: list[str] = []
        raw_dependencies: dict[str, object] = {}
        for key in ("dependencies", "optionalDependencies", "peerDependencies"):
            value = raw.get(key)
            if isinstance(value, dict):
                raw_dependencies.update(value)
        for dependency in sorted(raw_dependencies):
            resolved = _npm_dependency_path(package_path, dependency, packages)
            dependencies.append(resolved)
            queue.append(resolved)
        selected[package_path] = {
            "package_path": package_path,
            "name": name,
            "version": version,
            "declared_license": raw.get("license"),
            "dependencies": dependencies,
        }
    return [selected[path] for path in sorted(selected)]


def _all_cyclonedx_components(components: object) -> list[dict[str, Any]]:
    if not isinstance(components, list):
        return []
    result: list[dict[str, Any]] = []
    for raw in components:
        if not isinstance(raw, dict):
            continue
        result.append(raw)
        result.extend(_all_cyclonedx_components(raw.get("components")))
    return result


def _electron_versions(app: Path, repository: Path) -> tuple[str, str]:
    info_path = (
        app
        / "Contents"
        / "Frameworks"
        / "Electron Framework.framework"
        / "Versions"
        / "A"
        / "Resources"
        / "Info.plist"
    )
    binary_path = info_path.parent.parent / "Electron Framework"
    info_identity = _fingerprint(info_path)
    try:
        with info_path.open("rb") as stream:
            electron_version = plistlib.load(stream).get("CFBundleVersion")
    except (OSError, plistlib.InvalidFileException, AttributeError) as exc:
        raise SupplyChainError(
            "packaged Electron framework metadata is invalid"
        ) from exc
    if _fingerprint(info_path) != info_identity:
        raise SupplyChainError(
            "packaged Electron framework metadata changed while read"
        )
    if not isinstance(electron_version, str) or not electron_version:
        raise SupplyChainError("packaged Electron framework has no version")
    package_lock = _read_json(
        repository / "desktop" / "package-lock.json", label="desktop package lock"
    )
    electron_lock = package_lock.get("packages", {}).get("node_modules/electron", {})
    if electron_lock.get("version") != electron_version:
        raise SupplyChainError(
            "packaged Electron version does not match desktop/package-lock.json"
        )
    identity = _fingerprint(binary_path)
    if identity["size_bytes"] > 300 * 1024 * 1024:
        raise SupplyChainError("Electron framework binary exceeds the inspection bound")
    content = binary_path.read_bytes()
    if _fingerprint(binary_path) != identity:
        raise SupplyChainError("Electron framework binary changed while read")
    match = CHROME_VERSION_PATTERN.search(content)
    if match is None:
        raise SupplyChainError("could not determine packaged Chromium version")
    return electron_version, match.group(1).decode("ascii")


def _cyclonedx_component_identity(component: Mapping[str, Any]) -> tuple[str, str]:
    name = component.get("name")
    version = component.get("version")
    if not isinstance(name, str) or not name:
        raise SupplyChainError("CycloneDX component is missing a valid name")
    if not isinstance(version, str) or not version:
        raise SupplyChainError(f"CycloneDX component {name} is missing a valid version")

    group = component.get("group")
    if group is not None:
        if not isinstance(group, str) or not group:
            raise SupplyChainError(f"CycloneDX component {name} has an invalid group")
        if name.startswith("@"):
            raise SupplyChainError(
                f"contradictory CycloneDX identity: name {name} already scoped when group {group} is specified"
            )
        scope = group if group.startswith("@") else f"@{group}"
        full_name = f"{scope}/{name}"
    else:
        full_name = name

    purl = component.get("purl")
    if purl is not None:
        if not isinstance(purl, str) or not purl:
            raise SupplyChainError(f"CycloneDX component {full_name} has an invalid purl")
        unquoted = urllib.parse.unquote(purl).split("?")[0].split("#")[0]
        expected_purl = f"pkg:npm/{full_name}@{version}"
        if unquoted != expected_purl:
            raise SupplyChainError(
                f"contradictory CycloneDX identity: {full_name}@{version} does not match purl {purl}"
            )

    return full_name, version


def _build_desktop_sbom(
    repository: Path,
    app: Path,
    destination: Path,
    *,
    desktop_lock: Mapping[str, object],
    app_tree: Mapping[str, object],
) -> tuple[dict[str, Any], list[dict[str, object]]]:
    desktop = repository / "desktop"
    version = _run(
        ("npx", "--no-install", "@cyclonedx/cyclonedx-npm", "--version"),
        cwd=desktop,
    ).stdout.strip()
    if version != CYCLONEDX_NPM_VERSION:
        raise SupplyChainError(
            f"expected cyclonedx-npm {CYCLONEDX_NPM_VERSION}, found {version or 'none'}"
        )
    _run(
        (
            "npx",
            "--no-install",
            "@cyclonedx/cyclonedx-npm",
            "--package-lock-only",
            "--omit",
            "dev",
            "--spec-version",
            CYCLONEDX_SPEC_VERSION,
            "--output-reproducible",
            "--output-format",
            "JSON",
            "--output-file",
            os.fspath(destination),
            "--validate",
            "package.json",
        ),
        cwd=desktop,
    )
    document = _read_json(destination, label="generated desktop SBOM")
    inventory = npm_runtime_inventory(desktop / "package-lock.json")
    sbom_components = {
        _cyclonedx_component_identity(component)
        for component in _all_cyclonedx_components(document.get("components"))
    }
    expected_components = {(item["name"], item["version"]) for item in inventory}
    if sbom_components != expected_components:
        missing = sorted(expected_components - sbom_components)
        unexpected = sorted(sbom_components - expected_components)
        details = []
        if missing:
            details.append(f"missing from CycloneDX: {missing}")
        if unexpected:
            details.append(f"unexpected in CycloneDX: {unexpected}")
        raise SupplyChainError(
            f"CycloneDX desktop inventory does not exactly match the locked runtime closure: {'; '.join(details)}"
        )

    electron_version, chromium_version = _electron_versions(app, repository)
    electron_ref = f"pkg:npm/electron@{electron_version}"
    chromium_ref = f"pkg:generic/chromium@{chromium_version}"
    document.setdefault("components", []).extend(
        [
            {
                "type": "framework",
                "bom-ref": electron_ref,
                "name": "electron",
                "version": electron_version,
                "purl": electron_ref,
                "licenses": [{"license": {"id": "MIT"}}],
                "scope": "required",
            },
            {
                "type": "framework",
                "bom-ref": chromium_ref,
                "name": "Chromium",
                "version": chromium_version,
                "purl": chromium_ref,
                "licenses": [{"license": {"id": "BSD-3-Clause"}}],
                "scope": "required",
            },
        ]
    )
    metadata = document.setdefault("metadata", {})
    properties = metadata.setdefault("properties", [])
    properties.extend(
        [
            {"name": "loci:source-lock:sha256", "value": desktop_lock["sha256"]},
            {"name": "loci:app-tree:sha256", "value": app_tree["sha256"]},
            {"name": "loci:scope", "value": "packaged-macos-runtime"},
        ]
    )
    root = metadata.get("component")
    if not isinstance(root, dict) or not isinstance(root.get("bom-ref"), str):
        raise SupplyChainError("desktop SBOM has no root component reference")
    dependencies = document.setdefault("dependencies", [])
    root_dependency = next(
        (item for item in dependencies if item.get("ref") == root["bom-ref"]), None
    )
    if root_dependency is None:
        root_dependency = {"ref": root["bom-ref"], "dependsOn": []}
        dependencies.append(root_dependency)
    root_dependency.setdefault("dependsOn", []).append(electron_ref)
    root_dependency["dependsOn"] = sorted(set(root_dependency["dependsOn"]))
    dependencies.extend(
        [
            {"ref": electron_ref, "dependsOn": [chromium_ref]},
            {"ref": chromium_ref, "dependsOn": []},
        ]
    )
    destination.write_bytes(_canonical_json(document))
    return document, inventory


def _python_inventory(repository: Path, python: Path) -> dict[str, Any]:
    # A standards-compliant venv launcher is normally a symlink to its base
    # interpreter. Resolve it for type checking while invoking the venv path so
    # Python still discovers the matching pyvenv.cfg and site-packages.
    try:
        resolved_python = python.resolve(strict=True)
    except OSError as exc:
        raise SupplyChainError(f"engine Python is not readable: {python}") from exc
    if not resolved_python.is_file() or not os.access(resolved_python, os.X_OK):
        raise SupplyChainError(f"engine Python is not executable: {python}")
    completed = _run(
        (
            os.fspath(python),
            os.fspath(PYTHON_INVENTORY),
            "--lock",
            os.fspath(repository / "engine" / "uv.lock"),
        ),
        cwd=repository,
    )
    try:
        document = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SupplyChainError(
            "Python runtime inventory returned invalid JSON"
        ) from exc
    if (
        not isinstance(document, dict)
        or document.get("schema") != "loci.python-runtime-inventory/v1"
        or document.get("platform") != "darwin"
        or not str(document.get("python", "")).startswith(f"{EXPECTED_PYTHON}.")
    ):
        raise SupplyChainError(
            "Python runtime inventory is not the macOS Python 3.12 worker"
        )
    return document


def _build_engine_sbom(
    inventory: Mapping[str, Any],
    *,
    engine_lock: Mapping[str, object],
    app_tree: Mapping[str, object],
) -> dict[str, Any]:
    raw_root = inventory.get("root")
    raw_components = inventory.get("components")
    raw_embedded = inventory.get("embedded_components")
    if (
        not isinstance(raw_root, dict)
        or not isinstance(raw_components, list)
        or not raw_components
        or not isinstance(raw_embedded, list)
        or not raw_embedded
    ):
        raise SupplyChainError("Python runtime inventory is incomplete")
    root_name = raw_root.get("name")
    root_version = raw_root.get("version")
    root_dependencies = raw_root.get("dependencies")
    if (
        not all(isinstance(value, str) and value for value in (root_name, root_version))
        or not isinstance(root_dependencies, list)
        or any(not isinstance(value, str) or not value for value in root_dependencies)
    ):
        raise SupplyChainError("Python runtime root identity is incomplete")
    root_ref = f"pkg:pypi/{root_name}@{root_version}"
    refs: dict[str, str] = {}
    components: list[dict[str, object]] = []
    for raw in raw_components:
        if not isinstance(raw, dict):
            raise SupplyChainError("Python runtime component is invalid")
        name = raw.get("name")
        version = raw.get("version")
        purl = raw.get("purl")
        if not all(isinstance(value, str) and value for value in (name, version, purl)):
            raise SupplyChainError("Python runtime component has incomplete identity")
        if name in refs or purl in refs.values():
            raise SupplyChainError("Python runtime component identity is duplicated")
        refs[name] = purl
        component: dict[str, object] = {
            "type": "library",
            "bom-ref": purl,
            "name": name,
            "version": version,
            "purl": purl,
            "scope": "required",
        }
        declared = raw.get("declared_license")
        if isinstance(declared, str) and declared:
            component["licenses"] = [{"license": {"name": declared}}]
        components.append(component)
    embedded_refs: list[str] = []
    for raw in raw_embedded:
        if not isinstance(raw, dict):
            raise SupplyChainError("embedded Python component is invalid")
        name = raw.get("display_name")
        version = raw.get("version")
        purl = raw.get("purl")
        role = raw.get("role")
        if (
            not all(isinstance(value, str) and value for value in (name, version, purl))
            or role != "embedded-bootloader"
        ):
            raise SupplyChainError("embedded Python component has incomplete identity")
        if purl in refs.values() or purl in embedded_refs:
            raise SupplyChainError("embedded Python component identity is duplicated")
        embedded_refs.append(purl)
        component = {
            "type": "application",
            "bom-ref": purl,
            "name": name,
            "version": version,
            "purl": purl,
            "scope": "required",
            "properties": [{"name": "loci:role", "value": role}],
        }
        declared = raw.get("declared_license")
        if isinstance(declared, str) and declared:
            component["licenses"] = [{"license": {"name": declared}}]
        components.append(component)
    missing_root_dependencies = sorted(set(root_dependencies).difference(refs))
    if missing_root_dependencies:
        raise SupplyChainError(
            "Python runtime root dependency is missing from the inventory: "
            + ", ".join(missing_root_dependencies)
        )
    dependencies: list[dict[str, object]] = [
        {
            "ref": root_ref,
            "dependsOn": sorted(refs[name] for name in root_dependencies)
            + sorted(embedded_refs),
        }
    ]
    for raw in raw_components:
        raw_dependencies = raw.get("dependencies")
        if not isinstance(raw_dependencies, list) or any(
            not isinstance(value, str) or not value for value in raw_dependencies
        ):
            raise SupplyChainError("Python runtime dependency list is invalid")
        missing_dependencies = sorted(set(raw_dependencies).difference(refs))
        if missing_dependencies:
            raise SupplyChainError(
                f"Python runtime dependency is missing for {raw['name']}: "
                + ", ".join(missing_dependencies)
            )
        dependencies.append(
            {
                "ref": refs[raw["name"]],
                "dependsOn": sorted(refs[name] for name in raw_dependencies),
            }
        )
    dependencies.extend(
        {"ref": reference, "dependsOn": []} for reference in embedded_refs
    )
    return {
        "$schema": "https://cyclonedx.org/schema/bom-1.6.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": CYCLONEDX_SPEC_VERSION,
        "version": 1,
        "metadata": {
            "tools": {
                "components": [
                    {
                        "type": "application",
                        "name": "loci-release-supply-chain",
                        "version": GENERATOR_VERSION,
                    },
                    {
                        "type": "application",
                        "name": "cyclonedx-bom",
                        "version": CYCLONEDX_BOM_VERSION,
                    },
                    {
                        "type": "library",
                        "name": "cyclonedx-python-lib",
                        "version": CYCLONEDX_LIBRARY_VERSION,
                    },
                ]
            },
            "component": {
                "type": "application",
                "bom-ref": root_ref,
                "name": root_name,
                "version": root_version,
                "purl": root_ref,
            },
            "properties": [
                {"name": "loci:source-lock:sha256", "value": engine_lock["sha256"]},
                {"name": "loci:app-tree:sha256", "value": app_tree["sha256"]},
                {"name": "loci:scope", "value": "packaged-macos-runtime"},
                {"name": "loci:python", "value": inventory["python"]},
                {"name": "loci:machine", "value": inventory["machine"]},
            ],
        },
        "components": sorted(components, key=lambda item: str(item["bom-ref"])),
        "dependencies": sorted(dependencies, key=lambda item: str(item["ref"])),
    }


def _strict_validate_cyclonedx(paths: Sequence[Path], repository: Path) -> None:
    _run(
        (
            "uv",
            "run",
            "--directory",
            os.fspath(RELEASE_TOOLS),
            "--frozen",
            "python",
            os.fspath(CYCLONEDX_VALIDATOR),
            *(os.fspath(path) for path in paths),
        ),
        cwd=repository,
    )


def _safe_archive_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._+-]+", "-", value).strip("-.") or "component"


def _source_payload(
    source: Path, archive_path: str, *, expected: Mapping[str, object] | None = None
) -> tuple[dict[str, object], bytes]:
    identity = _fingerprint(source)
    if expected is not None and any(
        expected.get(key) != identity[key] for key in ("sha256", "size_bytes")
    ):
        raise SupplyChainError(f"licence evidence changed since inventory: {source}")
    payload = source.read_bytes()
    if (
        _sha256_bytes(payload) != identity["sha256"]
        or len(payload) != identity["size_bytes"]
    ):
        raise SupplyChainError(f"licence evidence changed while copying: {source}")
    return {
        "path": archive_path,
        "sha256": identity["sha256"],
        "size_bytes": identity["size_bytes"],
    }, payload


def _node_licence_files(package_root: Path) -> list[Path]:
    evidence: list[Path] = []
    for root, directories, files in os.walk(package_root):
        directories[:] = sorted(name for name in directories if name != "node_modules")
        for filename in sorted(files):
            if LICENCE_BASENAME.match(filename):
                evidence.append(Path(root) / filename)
    return evidence


def _build_licence_payloads(
    repository: Path,
    app: Path,
    npm_inventory: Sequence[Mapping[str, object]],
    python_inventory: Mapping[str, Any],
) -> tuple[list[dict[str, object]], dict[str, bytes]]:
    components: list[dict[str, object]] = []
    payloads: dict[str, bytes] = {}

    for raw in npm_inventory:
        package_root = repository / "desktop" / str(raw["package_path"])
        package_json = _read_json(package_root / "package.json", label="npm package")
        if (
            package_json.get("name") != raw["name"]
            or package_json.get("version") != raw["version"]
        ):
            raise SupplyChainError(
                f"installed npm package does not match lock: {raw['package_path']}"
            )
        sources = _node_licence_files(package_root)
        upstream_info = NPM_UPSTREAM_LICENCES.get((str(raw["name"]), str(raw["version"])))
        upstream_source: Path | None = None
        if not sources:
            if upstream_info is not None:
                relative_path, expected_hash = upstream_info
                upstream_source = repository / "scripts" / "upstream_licences" / relative_path
                if not upstream_source.is_file():
                    raise SupplyChainError(
                        f"pinned upstream licence file is missing: {upstream_source}"
                    )
                actual_hash = hashlib.sha256(upstream_source.read_bytes()).hexdigest()
                if actual_hash != expected_hash:
                    raise SupplyChainError(
                        f"pinned upstream licence hash mismatch for {raw['name']}@{raw['version']}: "
                        f"expected {expected_hash}, got {actual_hash}"
                    )
                sources = [upstream_source]
            else:
                raise SupplyChainError(
                    f"npm runtime dependency has no licence evidence: {raw['name']}"
                )
        component_root = (
            f"licenses/npm/{_safe_archive_segment(str(raw['name']))}-"
            f"{_safe_archive_segment(str(raw['version']))}"
        )
        evidence: list[dict[str, object]] = []
        for source in sources:
            if upstream_source is not None and source == upstream_source:
                relative = source.name
            else:
                relative = source.relative_to(package_root).as_posix()
            archive_path = f"{component_root}/{relative}"
            record, payload = _source_payload(source, archive_path)
            if archive_path in payloads:
                raise SupplyChainError(
                    f"duplicate licence archive path: {archive_path}"
                )
            payloads[archive_path] = payload
            evidence.append(record)
        components.append(
            {
                "ecosystem": "npm",
                "name": raw["name"],
                "version": raw["version"],
                "purl": f"pkg:npm/{raw['name']}@{raw['version']}",
                "declared_license": raw.get("declared_license"),
                "evidence": evidence,
            }
        )

    raw_python = python_inventory.get("components")
    if not isinstance(raw_python, list):
        raise SupplyChainError("Python runtime inventory has no components")
    for raw in raw_python:
        component_root = (
            f"licenses/pypi/{_safe_archive_segment(raw['name'])}-"
            f"{_safe_archive_segment(raw['version'])}"
        )
        evidence: list[dict[str, object]] = []
        raw_evidence = raw.get("evidence")
        if not isinstance(raw_evidence, list) or not raw_evidence:
            raise SupplyChainError(
                f"Python runtime dependency has no licence evidence: {raw['name']}"
            )
        for index, item in enumerate(raw_evidence):
            source = Path(item["source"])
            source_name = PurePosixPath(item["source_relative"])
            safe_parts = [
                part for part in source_name.parts if part not in ("", ".", "..")
            ]
            relative = "/".join(safe_parts) or f"evidence-{index}.txt"
            archive_path = f"{component_root}/{relative}"
            if archive_path in payloads:
                archive_path = f"{component_root}/{index:03d}-{Path(relative).name}"
            record, payload = _source_payload(source, archive_path, expected=item)
            payloads[archive_path] = payload
            evidence.append(record)
        components.append(
            {
                "ecosystem": "pypi",
                "name": raw["name"],
                "version": raw["version"],
                "purl": raw["purl"],
                "declared_license": raw.get("declared_license"),
                "evidence": evidence,
            }
        )

    raw_embedded = python_inventory.get("embedded_components")
    if not isinstance(raw_embedded, list) or not raw_embedded:
        raise SupplyChainError("Python inventory has no embedded-component evidence")
    for raw in raw_embedded:
        if raw.get("role") != "embedded-bootloader":
            raise SupplyChainError("Python embedded-component role is unsupported")
        component_root = (
            f"licenses/embedded/{_safe_archive_segment(raw['name'])}-"
            f"{_safe_archive_segment(raw['version'])}"
        )
        evidence: list[dict[str, object]] = []
        raw_evidence = raw.get("evidence")
        if not isinstance(raw_evidence, list) or not raw_evidence:
            raise SupplyChainError(
                f"embedded component has no licence evidence: {raw['name']}"
            )
        for index, item in enumerate(raw_evidence):
            source = Path(item["source"])
            source_name = PurePosixPath(item["source_relative"])
            safe_parts = [
                part for part in source_name.parts if part not in ("", ".", "..")
            ]
            relative = "/".join(safe_parts) or f"evidence-{index}.txt"
            archive_path = f"{component_root}/{relative}"
            if archive_path in payloads:
                archive_path = f"{component_root}/{index:03d}-{Path(relative).name}"
            record, payload = _source_payload(source, archive_path, expected=item)
            payloads[archive_path] = payload
            evidence.append(record)
        components.append(
            {
                "ecosystem": "embedded",
                "name": raw.get("display_name") or raw["name"],
                "version": raw["version"],
                "purl": raw["purl"],
                "declared_license": raw.get("declared_license"),
                "evidence": evidence,
            }
        )

    electron_version, chromium_version = _electron_versions(app, repository)
    platform_sources = (
        (
            "electron",
            electron_version,
            f"pkg:npm/electron@{electron_version}",
            "MIT",
            app / "Contents" / "Resources" / "notices" / "ELECTRON_LICENSE",
        ),
        (
            "Chromium and bundled components",
            chromium_version,
            f"pkg:generic/chromium@{chromium_version}",
            "See LICENSES.chromium.html",
            app / "Contents" / "Resources" / "notices" / "LICENSES.chromium.html",
        ),
    )
    for name, version, purl, declared, source in platform_sources:
        archive_path = (
            f"licenses/platform/{_safe_archive_segment(name)}-"
            f"{_safe_archive_segment(version)}/{source.name}"
        )
        record, payload = _source_payload(source, archive_path)
        payloads[archive_path] = payload
        components.append(
            {
                "ecosystem": "platform",
                "name": name,
                "version": version,
                "purl": purl,
                "declared_license": declared,
                "evidence": [record],
            }
        )
    return sorted(
        components,
        key=lambda item: (
            str(item["ecosystem"]),
            str(item["name"]),
            str(item["version"]),
        ),
    ), payloads


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, ZIP_TIMESTAMP)
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def _write_licence_archive(
    destination: Path, manifest: Mapping[str, object], payloads: Mapping[str, bytes]
) -> None:
    with zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        archive.writestr(_zip_info("manifest.json"), _canonical_json(manifest))
        for path in sorted(payloads):
            archive.writestr(_zip_info(path), payloads[path])


def _safe_zip_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    return (
        bool(normalized)
        and normalized == path.as_posix()
        and not path.is_absolute()
        and ".." not in path.parts
        and not re.match(r"^[A-Za-z]:", normalized)
    )


def inspect_license_archive(path: Path) -> dict[str, object]:
    """Validate the archive manifest, exact payload set, and every checksum."""

    result: dict[str, object] = {
        "manifest_schema": None,
        "component_count": 0,
        "evidence_files": 0,
        "coverage_complete": False,
        "inputs": None,
        "valid": False,
        "reasons": [],
    }
    reasons: list[str] = result["reasons"]  # type: ignore[assignment]
    try:
        before = _fingerprint(path)
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if sum(member.file_size for member in members) > MAX_ARCHIVE_BYTES:
                raise SupplyChainError(
                    "licence archive exceeds the uncompressed-size bound"
                )
            names = [member.filename for member in members]
            if len(names) != len(set(names)):
                raise SupplyChainError(
                    "licence archive contains duplicate member names"
                )
            if any(not _safe_zip_name(name) for name in names):
                raise SupplyChainError("licence archive contains an unsafe member name")
            for member in members:
                mode = (member.external_attr >> 16) & 0xFFFF
                if member.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                    raise SupplyChainError(
                        "licence archive must contain regular files only"
                    )
            if "manifest.json" not in names:
                raise SupplyChainError("licence archive is missing manifest.json")
            try:
                manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise SupplyChainError(
                    "licence archive manifest is invalid JSON"
                ) from exc
            if not isinstance(manifest, dict):
                raise SupplyChainError("licence archive manifest must be an object")
            result["manifest_schema"] = manifest.get("schema")
            if manifest.get("schema") != LICENCE_MANIFEST_SCHEMA:
                raise SupplyChainError("licence archive manifest schema is unsupported")
            generator = manifest.get("generator")
            if (
                not isinstance(generator, dict)
                or generator.get("version") != GENERATOR_VERSION
            ):
                raise SupplyChainError(
                    "licence archive generator version is unsupported"
                )
            inputs = manifest.get("inputs")
            if not isinstance(inputs, dict):
                raise SupplyChainError("licence archive has no bound inputs")
            result["inputs"] = inputs
            for field in (
                "app_tree_sha256",
                "desktop_lock_sha256",
                "engine_lock_sha256",
            ):
                if not isinstance(
                    inputs.get(field), str
                ) or not SHA256_PATTERN.fullmatch(inputs[field]):
                    raise SupplyChainError(
                        f"licence archive input hash is invalid: {field}"
                    )
            sboms = inputs.get("sboms")
            if not isinstance(sboms, dict) or set(sboms) != {"desktop", "engine"}:
                raise SupplyChainError("licence archive must bind both SBOMs")
            if any(
                not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value)
                for value in sboms.values()
            ):
                raise SupplyChainError("licence archive SBOM hash is invalid")
            components = manifest.get("components")
            if not isinstance(components, list) or not components:
                raise SupplyChainError("licence archive has no component coverage")
            result["component_count"] = len(components)
            expected_files: set[str] = {"manifest.json"}
            ecosystem_counts: dict[str, int] = {}
            for component in components:
                if not isinstance(component, dict):
                    raise SupplyChainError("licence component is invalid")
                if not all(
                    isinstance(component.get(field), str) and component[field]
                    for field in ("ecosystem", "name", "version", "purl")
                ):
                    raise SupplyChainError("licence component identity is incomplete")
                ecosystem = component["ecosystem"]
                ecosystem_counts[ecosystem] = ecosystem_counts.get(ecosystem, 0) + 1
                evidence = component.get("evidence")
                if not isinstance(evidence, list) or not evidence:
                    raise SupplyChainError(
                        f"component has no licence evidence: {component['purl']}"
                    )
                for record in evidence:
                    if not isinstance(record, dict):
                        raise SupplyChainError("licence evidence record is invalid")
                    member_path = record.get("path")
                    expected_sha = record.get("sha256")
                    expected_size = record.get("size_bytes")
                    if (
                        not isinstance(member_path, str)
                        or member_path == "manifest.json"
                        or not _safe_zip_name(member_path)
                        or not isinstance(expected_sha, str)
                        or not SHA256_PATTERN.fullmatch(expected_sha)
                        or not isinstance(expected_size, int)
                        or expected_size <= 0
                    ):
                        raise SupplyChainError("licence evidence identity is invalid")
                    if member_path in expected_files:
                        raise SupplyChainError("licence evidence path is duplicated")
                    expected_files.add(member_path)
                    payload = archive.read(member_path)
                    if (
                        len(payload) != expected_size
                        or _sha256_bytes(payload) != expected_sha
                    ):
                        raise SupplyChainError(
                            f"licence evidence checksum does not match: {member_path}"
                        )
            if set(names) != expected_files:
                raise SupplyChainError(
                    "licence archive payload set does not exactly match its manifest"
                )
            coverage = manifest.get("coverage")
            if not isinstance(coverage, dict) or coverage != ecosystem_counts:
                raise SupplyChainError(
                    "licence archive coverage counts are inconsistent"
                )
            if not {"embedded", "npm", "pypi", "platform"}.issubset(ecosystem_counts):
                raise SupplyChainError(
                    "licence archive omits a required runtime ecosystem"
                )
            result["evidence_files"] = len(expected_files) - 1
            result["coverage_complete"] = True
        if _fingerprint(path) != before:
            raise SupplyChainError(
                "licence archive changed while it was being inspected"
            )
        result["valid"] = True
    except (
        SupplyChainError,
        OSError,
        KeyError,
        RuntimeError,
        zipfile.BadZipFile,
    ) as exc:
        reasons.append(str(exc) or "licence archive is invalid")
    return result


def _manifest(
    *,
    app_tree: Mapping[str, object],
    desktop_lock: Mapping[str, object],
    engine_lock: Mapping[str, object],
    desktop_sbom: Mapping[str, object],
    engine_sbom: Mapping[str, object],
    components: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    coverage: dict[str, int] = {}
    for component in components:
        ecosystem = str(component["ecosystem"])
        coverage[ecosystem] = coverage.get(ecosystem, 0) + 1
    return {
        "schema": LICENCE_MANIFEST_SCHEMA,
        "generator": {
            "name": "loci-release-supply-chain",
            "version": GENERATOR_VERSION,
            "cyclonedx_npm": CYCLONEDX_NPM_VERSION,
            "cyclonedx_bom": CYCLONEDX_BOM_VERSION,
            "cyclonedx_python_lib": CYCLONEDX_LIBRARY_VERSION,
        },
        "inputs": {
            "app_tree_sha256": app_tree["sha256"],
            "desktop_lock_sha256": desktop_lock["sha256"],
            "engine_lock_sha256": engine_lock["sha256"],
            "sboms": {
                "desktop": desktop_sbom["sha256"],
                "engine": engine_sbom["sha256"],
            },
        },
        "coverage": dict(sorted(coverage.items())),
        "components": list(components),
    }


def _publish(source: Path, destination: Path) -> None:
    if destination.is_symlink() or (destination.exists() and not destination.is_file()):
        raise SupplyChainError(f"refusing unsafe output replacement: {destination}")
    temporary = destination.with_name(f".{destination.name}.publish-{os.getpid()}")
    if temporary.exists() or temporary.is_symlink():
        raise SupplyChainError(f"temporary output collision: {temporary}")
    try:
        shutil.copyfile(source, temporary)
        temporary.chmod(0o644)
        os.replace(temporary, destination)
    except OSError as exc:
        raise SupplyChainError(
            f"could not publish release artifact: {destination}"
        ) from exc
    finally:
        if temporary.exists() and temporary.is_file():
            temporary.unlink()


def generate(arguments: argparse.Namespace) -> dict[str, object]:
    repository = _absolute(arguments.repository, label="Repository")
    app = _absolute(arguments.app, label="App")
    output_dir = _absolute(arguments.output_dir, label="Output directory")
    python = _absolute(arguments.python, label="Engine Python")
    _validate_layout(repository, app, output_dir)
    outputs = _prepare_outputs(output_dir, overwrite=arguments.overwrite)
    release_evidence = _release_evidence_module()
    app_tree = release_evidence.fingerprint_tree(app)
    desktop_lock_path = repository / "desktop" / "package-lock.json"
    engine_lock_path = repository / "engine" / "uv.lock"
    desktop_lock = _fingerprint(desktop_lock_path)
    engine_lock = _fingerprint(engine_lock_path)

    with tempfile.TemporaryDirectory(prefix="loci-supply-chain-") as raw_temp:
        temporary = Path(raw_temp)
        desktop_path = temporary / OUTPUT_FILENAMES["desktop_sbom"]
        engine_path = temporary / OUTPUT_FILENAMES["engine_sbom"]
        archive_path = temporary / OUTPUT_FILENAMES["licence_archive"]
        _, npm_inventory = _build_desktop_sbom(
            repository,
            app,
            desktop_path,
            desktop_lock=desktop_lock,
            app_tree=app_tree,
        )
        python_inventory = _python_inventory(repository, python)
        engine_document = _build_engine_sbom(
            python_inventory, engine_lock=engine_lock, app_tree=app_tree
        )
        engine_path.write_bytes(_canonical_json(engine_document))
        _strict_validate_cyclonedx((desktop_path, engine_path), repository)
        desktop_sbom = _fingerprint(desktop_path)
        engine_sbom = _fingerprint(engine_path)
        components, payloads = _build_licence_payloads(
            repository, app, npm_inventory, python_inventory
        )
        manifest = _manifest(
            app_tree=app_tree,
            desktop_lock=desktop_lock,
            engine_lock=engine_lock,
            desktop_sbom=desktop_sbom,
            engine_sbom=engine_sbom,
            components=components,
        )
        _write_licence_archive(archive_path, manifest, payloads)
        archive_result = inspect_license_archive(archive_path)
        if not archive_result["valid"]:
            raise SupplyChainError(
                "generated licence archive failed validation: "
                + "; ".join(archive_result["reasons"])
            )
        if desktop_lock != _fingerprint(
            desktop_lock_path
        ) or engine_lock != _fingerprint(engine_lock_path):
            raise SupplyChainError("dependency locks changed during generation")
        if app_tree != release_evidence.fingerprint_tree(app):
            raise SupplyChainError("app bundle changed during generation")
        for label, source in (
            ("desktop_sbom", desktop_path),
            ("engine_sbom", engine_path),
            ("licence_archive", archive_path),
        ):
            _publish(source, outputs[label])

    return check_artifacts(repository, app, output_dir)


def check_artifacts(repository: Path, app: Path, output_dir: Path) -> dict[str, object]:
    _validate_layout(repository, app, output_dir)
    outputs = {label: output_dir / name for label, name in OUTPUT_FILENAMES.items()}
    for path in outputs.values():
        _fingerprint(path)
    _strict_validate_cyclonedx(
        (outputs["desktop_sbom"], outputs["engine_sbom"]), repository
    )
    archive_result = inspect_license_archive(outputs["licence_archive"])
    if not archive_result["valid"]:
        raise SupplyChainError(
            "dependency licence archive is invalid: "
            + "; ".join(archive_result["reasons"])
        )
    with zipfile.ZipFile(outputs["licence_archive"]) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    release_evidence = _release_evidence_module()
    expected = {
        "app_tree_sha256": release_evidence.fingerprint_tree(app)["sha256"],
        "desktop_lock_sha256": _fingerprint(
            repository / "desktop" / "package-lock.json"
        )["sha256"],
        "engine_lock_sha256": _fingerprint(repository / "engine" / "uv.lock")["sha256"],
        "sboms": {
            "desktop": _fingerprint(outputs["desktop_sbom"])["sha256"],
            "engine": _fingerprint(outputs["engine_sbom"])["sha256"],
        },
    }
    if manifest.get("inputs") != expected:
        raise SupplyChainError(
            "release artifacts do not match the current app bundle and dependency locks"
        )
    for label in ("desktop", "engine"):
        sbom = _read_json(outputs[f"{label}_sbom"], label=f"{label} SBOM")
        properties = sbom.get("metadata", {}).get("properties", [])
        property_map = {
            item.get("name"): item.get("value")
            for item in properties
            if isinstance(item, dict)
        }
        if (
            property_map.get("loci:source-lock:sha256")
            != expected[f"{label}_lock_sha256"]
            or property_map.get("loci:app-tree:sha256") != expected["app_tree_sha256"]
        ):
            raise SupplyChainError(f"{label} SBOM provenance binding is invalid")
    return {
        "schema": SCHEMA_VERSION,
        "status": "complete",
        "artifacts": {
            label: {"path": os.fspath(path), **_fingerprint(path)}
            for label, path in outputs.items()
        },
        "licence_archive": archive_result,
    }


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "generate":
            result = generate(arguments)
        else:
            repository = _absolute(arguments.repository, label="Repository")
            app = _absolute(arguments.app, label="App")
            output_dir = _absolute(arguments.output_dir, label="Output directory")
            result = check_artifacts(repository, app, output_dir)
    except SupplyChainError as exc:
        print(f"release supply-chain check failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
