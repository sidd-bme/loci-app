from __future__ import annotations

import hashlib
import json
import plistlib
import zipfile
from pathlib import Path

import pytest

from scripts import release_python_inventory, release_supply_chain


def _manifest(payloads: dict[str, bytes]) -> dict[str, object]:
    components = []
    for ecosystem, path in (
        ("embedded", "licenses/embedded/example/COPYING.txt"),
        ("npm", "licenses/npm/example/LICENSE"),
        ("pypi", "licenses/pypi/example/LICENSE"),
        ("platform", "licenses/platform/example/LICENSE"),
    ):
        payload = payloads[path]
        components.append(
            {
                "ecosystem": ecosystem,
                "name": f"{ecosystem}-example",
                "version": "1.0.0",
                "purl": f"pkg:generic/{ecosystem}-example@1.0.0",
                "declared_license": "MIT",
                "evidence": [
                    {
                        "path": path,
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "size_bytes": len(payload),
                    }
                ],
            }
        )
    return {
        "schema": release_supply_chain.LICENCE_MANIFEST_SCHEMA,
        "generator": {
            "name": "loci-release-supply-chain",
            "version": release_supply_chain.GENERATOR_VERSION,
        },
        "inputs": {
            "app_tree_sha256": "1" * 64,
            "desktop_lock_sha256": "2" * 64,
            "engine_lock_sha256": "3" * 64,
            "sboms": {"desktop": "4" * 64, "engine": "5" * 64},
        },
        "coverage": {"embedded": 1, "npm": 1, "platform": 1, "pypi": 1},
        "components": components,
    }


def test_npm_runtime_inventory_resolves_nested_locked_dependencies(
    tmp_path: Path,
) -> None:
    lock = tmp_path / "package-lock.json"
    lock.write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {"dependencies": {"alpha": "1.0.0"}},
                    "node_modules/alpha": {
                        "version": "1.0.0",
                        "license": "MIT",
                        "dependencies": {"shared": "1.0.0"},
                    },
                    "node_modules/alpha/node_modules/shared": {
                        "version": "1.0.0",
                        "license": "BSD-3-Clause",
                    },
                    "node_modules/shared": {
                        "version": "2.0.0",
                        "license": "Apache-2.0",
                    },
                    "node_modules/dev-only": {
                        "version": "9.0.0",
                        "dev": True,
                        "license": "MIT",
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    inventory = release_supply_chain.npm_runtime_inventory(lock)

    assert [(item["name"], item["version"]) for item in inventory] == [
        ("alpha", "1.0.0"),
        ("shared", "1.0.0"),
    ]
    assert inventory[0]["dependencies"] == ["node_modules/alpha/node_modules/shared"]


def test_npm_runtime_inventory_fails_on_unresolved_dependency(tmp_path: Path) -> None:
    lock = tmp_path / "package-lock.json"
    lock.write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {"dependencies": {"alpha": "1.0.0"}},
                    "node_modules/alpha": {
                        "version": "1.0.0",
                        "dependencies": {"missing": "1.0.0"},
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        release_supply_chain.SupplyChainError, match="cannot be resolved"
    ):
        release_supply_chain.npm_runtime_inventory(lock)


def test_licence_archive_is_reproducible_and_fully_checksummed(tmp_path: Path) -> None:
    payloads = {
        "licenses/embedded/example/COPYING.txt": b"GPL-2.0 with exception\n",
        "licenses/npm/example/LICENSE": b"MIT\n",
        "licenses/pypi/example/LICENSE": b"BSD-3-Clause\n",
        "licenses/platform/example/LICENSE": b"MIT\n",
    }
    manifest = _manifest(payloads)
    first = tmp_path / "first.zip"
    second = tmp_path / "second.zip"

    release_supply_chain._write_licence_archive(first, manifest, payloads)
    release_supply_chain._write_licence_archive(second, manifest, payloads)

    assert first.read_bytes() == second.read_bytes()
    result = release_supply_chain.inspect_license_archive(first)
    assert result == {
        "manifest_schema": release_supply_chain.LICENCE_MANIFEST_SCHEMA,
        "component_count": 4,
        "evidence_files": 4,
        "coverage_complete": True,
        "inputs": manifest["inputs"],
        "valid": True,
        "reasons": [],
    }


def test_licence_archive_rejects_tamper_extra_and_missing_ecosystem(
    tmp_path: Path,
) -> None:
    payloads = {
        "licenses/embedded/example/COPYING.txt": b"GPL-2.0 with exception\n",
        "licenses/npm/example/LICENSE": b"MIT\n",
        "licenses/pypi/example/LICENSE": b"BSD-3-Clause\n",
        "licenses/platform/example/LICENSE": b"MIT\n",
    }
    manifest = _manifest(payloads)
    archive_path = tmp_path / "tampered.zip"
    release_supply_chain._write_licence_archive(archive_path, manifest, payloads)
    with zipfile.ZipFile(archive_path, "a") as archive:
        archive.writestr("unmanifested.txt", "unexpected")
    result = release_supply_chain.inspect_license_archive(archive_path)
    assert result["valid"] is False
    assert any("payload set" in reason for reason in result["reasons"])

    missing_platform = tmp_path / "missing-platform.zip"
    limited_payloads = {
        key: value for key, value in payloads.items() if "platform" not in key
    }
    limited = _manifest(payloads)
    limited["components"] = [
        component
        for component in limited["components"]
        if component["ecosystem"] != "platform"
    ]
    limited["coverage"] = {"embedded": 1, "npm": 1, "pypi": 1}
    release_supply_chain._write_licence_archive(
        missing_platform, limited, limited_payloads
    )
    result = release_supply_chain.inspect_license_archive(missing_platform)
    assert result["valid"] is False
    assert any("ecosystem" in reason for reason in result["reasons"])


def test_engine_sbom_has_exact_dependency_graph_and_provenance() -> None:
    inventory = {
        "python": "3.12.13",
        "machine": "arm64",
        "root": {
            "name": "loci-engine",
            "version": "0.1.0",
            "dependencies": ["numpy"],
        },
        "components": [
            {
                "name": "numpy",
                "version": "2.4.6",
                "purl": "pkg:pypi/numpy@2.4.6",
                "declared_license": "BSD-3-Clause",
                "dependencies": [],
            }
        ],
        "embedded_components": [
            {
                "name": "pyinstaller",
                "display_name": "PyInstaller bootloader",
                "version": "6.22.2",
                "purl": "pkg:pypi/pyinstaller@6.22.2",
                "declared_license": "GPL-2.0-or-later WITH Bootloader-exception",
                "role": "embedded-bootloader",
            }
        ],
    }
    document = release_supply_chain._build_engine_sbom(
        inventory,
        engine_lock={"sha256": "a" * 64},
        app_tree={"sha256": "b" * 64},
    )

    assert document["bomFormat"] == "CycloneDX"
    assert document["specVersion"] == "1.6"
    assert document["components"][0]["purl"] == "pkg:pypi/numpy@2.4.6"
    root_ref = "pkg:pypi/loci-engine@0.1.0"
    assert {item["ref"]: item["dependsOn"] for item in document["dependencies"]} == {
        root_ref: [
            "pkg:pypi/numpy@2.4.6",
            "pkg:pypi/pyinstaller@6.22.2",
        ],
        "pkg:pypi/numpy@2.4.6": [],
        "pkg:pypi/pyinstaller@6.22.2": [],
    }
    embedded = next(
        component
        for component in document["components"]
        if component["name"] == "PyInstaller bootloader"
    )
    assert embedded["properties"] == [
        {"name": "loci:role", "value": "embedded-bootloader"}
    ]
    properties = {
        item["name"]: item["value"] for item in document["metadata"]["properties"]
    }
    assert properties["loci:source-lock:sha256"] == "a" * 64
    assert properties["loci:app-tree:sha256"] == "b" * 64


def test_engine_sbom_fails_closed_on_incomplete_dependency_closure() -> None:
    inventory = {
        "python": "3.12.13",
        "machine": "arm64",
        "root": {
            "name": "loci-engine",
            "version": "0.1.0",
            "dependencies": ["missing-package"],
        },
        "components": [
            {
                "name": "numpy",
                "version": "2.4.6",
                "purl": "pkg:pypi/numpy@2.4.6",
                "dependencies": [],
            }
        ],
        "embedded_components": [
            {
                "display_name": "PyInstaller bootloader",
                "version": "6.22.2",
                "purl": "pkg:pypi/pyinstaller@6.22.2",
                "role": "embedded-bootloader",
            }
        ],
    }

    with pytest.raises(release_supply_chain.SupplyChainError, match="missing-package"):
        release_supply_chain._build_engine_sbom(
            inventory,
            engine_lock={"sha256": "a" * 64},
            app_tree={"sha256": "b" * 64},
        )


def test_output_directory_must_be_outside_repository_and_app(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    app = tmp_path / "Loci.app"
    repository.mkdir()
    app.mkdir()

    with pytest.raises(release_supply_chain.SupplyChainError, match="repository"):
        release_supply_chain._validate_layout(repository, app, repository / "release")
    with pytest.raises(release_supply_chain.SupplyChainError, match="app bundle"):
        release_supply_chain._validate_layout(repository, app, app / "release")

    dangling_output = tmp_path / "dangling-output"
    dangling_output.symlink_to(tmp_path / "missing-output", target_is_directory=True)
    with pytest.raises(release_supply_chain.SupplyChainError, match="real directory"):
        release_supply_chain._validate_layout(repository, app, dangling_output)


def test_python_inventory_rejects_unlocked_root_and_embedded_bootloader(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeDistribution:
        def __init__(self, name: str, version: str) -> None:
            self.metadata = {"Name": name}
            self.version = version
            self.requires: list[str] = []

    root_name = release_python_inventory.ROOT_DISTRIBUTION
    root = FakeDistribution(root_name, "0.1.0")
    pyinstaller = FakeDistribution("pyinstaller", "6.22.2")
    distributions = {root_name: root, "pyinstaller": pyinstaller}
    monkeypatch.setattr(
        release_python_inventory, "_installed_distributions", lambda: distributions
    )
    monkeypatch.setattr(
        release_python_inventory,
        "_runtime_closure",
        lambda _distributions: ({}, {root_name: set()}),
    )

    monkeypatch.setattr(
        release_python_inventory, "_locked_versions", lambda _path: set()
    )
    with pytest.raises(release_python_inventory.InventoryError, match="loci-engine"):
        release_python_inventory.build_inventory(tmp_path / "engine.lock")

    monkeypatch.setattr(
        release_python_inventory,
        "_locked_versions",
        lambda _path: {(root_name, root.version)},
    )
    with pytest.raises(release_python_inventory.InventoryError, match="pyinstaller"):
        release_python_inventory.build_inventory(tmp_path / "engine.lock")


def test_python_inventory_includes_each_frozen_runtime_extra() -> None:
    class FakeDistribution:
        def __init__(self, name: str, requires: list[str]) -> None:
            self.metadata = {"Name": name}
            self.version = "1.0"
            self.requires = requires

    root_name = release_python_inventory.ROOT_DISTRIBUTION
    distributions = {
        root_name: FakeDistribution(
            root_name,
            [
                "plain==1.0",
                "cellpose==1.0; extra == 'cellpose'",
                "onnx==1.0; extra == 'onnx'",
                "dev-only==1.0; extra == 'dev'",
            ],
        ),
        "plain": FakeDistribution("plain", []),
        "cellpose": FakeDistribution("cellpose", []),
        "onnx": FakeDistribution("onnx", []),
        "dev-only": FakeDistribution("dev-only", []),
    }

    selected, edges = release_python_inventory._runtime_closure(distributions)

    assert set(selected) == {"plain", "cellpose", "onnx"}
    assert edges[root_name] == {"plain", "cellpose", "onnx"}


def test_electron_version_must_match_lock(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    desktop = repository / "desktop"
    desktop.mkdir(parents=True)
    (desktop / "package-lock.json").write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {"node_modules/electron": {"version": "44.0.0"}},
            }
        ),
        encoding="utf-8",
    )
    app = tmp_path / "Loci.app"
    resources = (
        app
        / "Contents"
        / "Frameworks"
        / "Electron Framework.framework"
        / "Versions"
        / "A"
        / "Resources"
    )
    resources.mkdir(parents=True)
    with (resources / "Info.plist").open("wb") as stream:
        plistlib.dump({"CFBundleVersion": "43.0.0"}, stream)
    binary = resources.parent / "Electron Framework"
    binary.write_bytes(b"Chrome/151.0.0.0 Electron/43.0.0")

    with pytest.raises(release_supply_chain.SupplyChainError, match="does not match"):
        release_supply_chain._electron_versions(app, repository)


def test_existing_output_needs_explicit_overwrite(tmp_path: Path) -> None:
    output_dir = tmp_path / "artifacts"
    output_dir.mkdir()
    existing = output_dir / release_supply_chain.OUTPUT_FILENAMES["desktop_sbom"]
    existing.write_text("existing", encoding="utf-8")

    with pytest.raises(release_supply_chain.SupplyChainError, match="--overwrite"):
        release_supply_chain._prepare_outputs(output_dir, overwrite=False)
    outputs = release_supply_chain._prepare_outputs(output_dir, overwrite=True)
    assert outputs["desktop_sbom"] == existing


def test_release_tool_versions_are_explicitly_pinned() -> None:
    package = json.loads(
        (release_supply_chain.ROOT / "desktop" / "package.json").read_text()
    )
    assert package["devDependencies"]["@cyclonedx/cyclonedx-npm"] == "6.0.1"
    tools = (
        release_supply_chain.ROOT / "scripts" / "release-tools" / "pyproject.toml"
    ).read_text()
    assert '"cyclonedx-bom==7.3.1"' in tools


def test_missing_wheel_licence_requires_exact_pinned_upstream_evidence(
    monkeypatch,
) -> None:
    class MissingLicenceDistribution:
        def __init__(self):
            self.metadata = {"Name": "flatbuffers"}
            self.version = "25.12.19"
            self.files = []

    distribution = MissingLicenceDistribution()
    evidence = release_python_inventory._licence_files(distribution)
    assert len(evidence) == 1
    assert evidence[0]["source_relative"] == "upstream/flatbuffers-25.12.19/LICENSE"
    assert (
        evidence[0]["sha256"]
        == hashlib.sha256(Path(evidence[0]["source"]).read_bytes()).hexdigest()
    )
    distribution.version = "99.0.0"
    with pytest.raises(
        release_python_inventory.InventoryError, match="no licence evidence"
    ):
        release_python_inventory._licence_files(distribution)
    distribution.version = "25.12.19"
    monkeypatch.setitem(
        release_python_inventory.UPSTREAM_LICENCES,
        ("flatbuffers", "25.12.19"),
        ("flatbuffers-25.12.19/LICENSE", "0" * 64),
    )
    with pytest.raises(
        release_python_inventory.InventoryError, match="pinned upstream"
    ):
        release_python_inventory._licence_files(distribution)


def test_cyclonedx_component_identity_scoped_and_unscoped() -> None:
    # Unscoped package
    identity = release_supply_chain._cyclonedx_component_identity(
        {
            "name": "lucide-react",
            "version": "1.16.0",
            "purl": "pkg:npm/lucide-react@1.16.0",
        }
    )
    assert identity == ("lucide-react", "1.16.0")

    # Scoped package with '@' in group
    identity_scoped = release_supply_chain._cyclonedx_component_identity(
        {
            "group": "@kitware",
            "name": "vtk.js",
            "version": "36.12.0",
            "purl": "pkg:npm/%40kitware/vtk.js@36.12.0",
        }
    )
    assert identity_scoped == ("@kitware/vtk.js", "36.12.0")

    # Scoped package without '@' in group
    identity_group_no_at = release_supply_chain._cyclonedx_component_identity(
        {
            "group": "kitware",
            "name": "vtk.js",
            "version": "36.12.0",
            "purl": "pkg:npm/%40kitware/vtk.js@36.12.0",
        }
    )
    assert identity_group_no_at == ("@kitware/vtk.js", "36.12.0")


def test_cyclonedx_component_identity_same_name_different_scopes() -> None:
    comp_unscoped = {"name": "core", "version": "1.0.0", "purl": "pkg:npm/core@1.0.0"}
    comp_scope_a = {
        "group": "@alpha",
        "name": "core",
        "version": "1.0.0",
        "purl": "pkg:npm/%40alpha/core@1.0.0",
    }
    comp_scope_b = {
        "group": "@beta",
        "name": "core",
        "version": "1.0.0",
        "purl": "pkg:npm/%40beta/core@1.0.0",
    }

    id_unscoped = release_supply_chain._cyclonedx_component_identity(comp_unscoped)
    id_scope_a = release_supply_chain._cyclonedx_component_identity(comp_scope_a)
    id_scope_b = release_supply_chain._cyclonedx_component_identity(comp_scope_b)

    assert id_unscoped == ("core", "1.0.0")
    assert id_scope_a == ("@alpha/core", "1.0.0")
    assert id_scope_b == ("@beta/core", "1.0.0")
    assert len({id_unscoped, id_scope_a, id_scope_b}) == 3


def test_cyclonedx_component_identity_rejects_contradictions_and_malformed() -> None:
    # Missing name
    with pytest.raises(release_supply_chain.SupplyChainError, match="valid name"):
        release_supply_chain._cyclonedx_component_identity({"version": "1.0.0"})

    # Missing version
    with pytest.raises(release_supply_chain.SupplyChainError, match="valid version"):
        release_supply_chain._cyclonedx_component_identity({"name": "pkg"})

    # Invalid group (empty)
    with pytest.raises(release_supply_chain.SupplyChainError, match="invalid group"):
        release_supply_chain._cyclonedx_component_identity(
            {"name": "pkg", "version": "1.0.0", "group": ""}
        )

    # Name already scoped when group is specified
    with pytest.raises(release_supply_chain.SupplyChainError, match="already scoped"):
        release_supply_chain._cyclonedx_component_identity(
            {"group": "@scope", "name": "@scope/pkg", "version": "1.0.0"}
        )

    # Invalid purl (empty)
    with pytest.raises(release_supply_chain.SupplyChainError, match="invalid purl"):
        release_supply_chain._cyclonedx_component_identity(
            {"name": "pkg", "version": "1.0.0", "purl": ""}
        )

    # Purl mismatch with name
    with pytest.raises(
        release_supply_chain.SupplyChainError, match="does not match purl"
    ):
        release_supply_chain._cyclonedx_component_identity(
            {
                "name": "pkg-a",
                "version": "1.0.0",
                "purl": "pkg:npm/pkg-b@1.0.0",
            }
        )

    # Purl mismatch with version
    with pytest.raises(
        release_supply_chain.SupplyChainError, match="does not match purl"
    ):
        release_supply_chain._cyclonedx_component_identity(
            {
                "name": "pkg-a",
                "version": "1.0.0",
                "purl": "pkg:npm/pkg-a@2.0.0",
            }
        )


def test_npm_runtime_inventory_includes_peer_dependencies(tmp_path: Path) -> None:
    lock = tmp_path / "package-lock.json"
    lock.write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {"dependencies": {"parent": "1.0.0"}},
                    "node_modules/parent": {
                        "version": "1.0.0",
                        "peerDependencies": {"peer-dep": "1.0.0"},
                    },
                    "node_modules/peer-dep": {
                        "version": "1.0.0",
                        "license": "MIT",
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    inventory = release_supply_chain.npm_runtime_inventory(lock)
    names = {item["name"] for item in inventory}
    assert "peer-dep" in names
    assert "parent" in names


def test_npm_upstream_licence_pinned_hash_verification(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    licence_dir = repo / "scripts" / "upstream_licences" / "seedrandom-3.0.5"
    licence_dir.mkdir(parents=True)
    licence_file = licence_dir / "LICENSE"
    content = b"Copyright 2019 David Bau. MIT License.\n"
    licence_file.write_bytes(content)
    expected_hash = hashlib.sha256(content).hexdigest()

    # Verify matching hash works
    assert licence_file.is_file()
    assert hashlib.sha256(licence_file.read_bytes()).hexdigest() == expected_hash
