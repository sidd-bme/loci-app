from __future__ import annotations

import argparse
import json
import os
import plistlib
import stat
import zipfile
from pathlib import Path

import pytest

from scripts import release_evidence, release_supply_chain


def _make_app(tmp_path: Path) -> Path:
    app = tmp_path / "Loci.app"
    executable = app / "Contents" / "MacOS" / "Loci"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"mach-o fixture")
    executable.chmod(0o755)
    info = {
        "CFBundleDisplayName": "Loci",
        "CFBundleExecutable": "Loci",
        "CFBundleIdentifier": release_evidence.EXPECTED_BUNDLE_ID,
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "100",
        "LSMinimumSystemVersion": "13.0",
    }
    info_path = app / "Contents" / "Info.plist"
    with info_path.open("wb") as stream:
        plistlib.dump(info, stream)
    notices = app / "Contents" / "Resources" / "notices"
    notices.mkdir(parents=True)
    for filename in release_evidence.REQUIRED_NOTICES:
        (notices / filename).write_text(f"notice: {filename}\n", encoding="utf-8")
    framework = app / "Contents" / "Frameworks"
    framework.mkdir()
    (framework / "Current").symlink_to("Versions/A")
    return app


def _make_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "repository"
    for relative in release_evidence.EXPECTED_LOCKS:
        path = repository / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"locked: {relative}\n", encoding="utf-8")
    return repository


def _write_app_zip(
    app: Path, destination: Path, *, root_name: str | None = None
) -> Path:
    root_name = root_name or app.name
    with zipfile.ZipFile(destination, "w") as archive:

        def add(path: Path, relative: Path) -> None:
            path_stat = path.lstat()
            archive_name = (Path(root_name) / relative).as_posix()
            if stat.S_ISDIR(path_stat.st_mode):
                info = zipfile.ZipInfo(archive_name.rstrip("/") + "/")
                info.create_system = 3
                info.external_attr = (path_stat.st_mode & 0xFFFF) << 16
                archive.writestr(info, b"")
                for child in sorted(path.iterdir(), key=lambda item: item.name):
                    add(child, relative / child.name)
            elif stat.S_ISLNK(path_stat.st_mode):
                info = zipfile.ZipInfo(archive_name)
                info.create_system = 3
                info.external_attr = (path_stat.st_mode & 0xFFFF) << 16
                archive.writestr(info, os.readlink(path).encode())
            else:
                info = zipfile.ZipInfo(archive_name)
                info.create_system = 3
                info.external_attr = (path_stat.st_mode & 0xFFFF) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())

        add(app, Path())
    return destination


def _runner(*, developer_id: bool = True, dirty: bool = False):
    def run(arguments: list[str] | tuple[str, ...], cwd: Path | None = None):
        del cwd
        executable = Path(arguments[0]).name
        if executable == "git" and arguments[1:3] == ("rev-parse", "--verify"):
            return release_evidence.CommandResult(0, "1" * 40 + "\n")
        if executable == "git" and arguments[1:3] == ("status", "--porcelain=v1"):
            return release_evidence.CommandResult(0, " M README.md\0" if dirty else "")
        if executable == "lipo":
            return release_evidence.CommandResult(0, "arm64 x86_64\n")
        if executable == "codesign" and "--verify" in arguments:
            return release_evidence.CommandResult(0, "")
        if executable == "codesign" and "-dv" in arguments:
            if developer_id:
                return release_evidence.CommandResult(
                    0,
                    "CodeDirectory v=20500 flags=0x10000(runtime) hashes=4+7\n"
                    "Authority=Developer ID Application: Loci Project (TEAM123456)\n"
                    "TeamIdentifier=TEAM123456\n"
                    "Timestamp=Sep 1, 2026 at 01:02:03",
                )
            return release_evidence.CommandResult(
                0,
                "CodeDirectory v=20400 flags=0x2(adhoc) hashes=4+7\n"
                "Signature=adhoc\n"
                "TeamIdentifier=not set",
            )
        if executable == "spctl":
            if developer_id:
                return release_evidence.CommandResult(
                    0, "Loci.app: accepted\nsource=Notarized Developer ID\n"
                )
            return release_evidence.CommandResult(3, "Loci.app: rejected\n")
        if executable == "xcrun":
            return release_evidence.CommandResult(0 if developer_id else 65, "")
        raise AssertionError(f"unexpected command: {arguments}")

    return run


def _arguments(
    tmp_path: Path,
    app: Path,
    repository: Path,
    *,
    sboms: list[str] | None = None,
    license_archive: Path | None = None,
    clean_mac: Path | None = None,
    authorization: Path | None = None,
    distribution_zip: Path | None = None,
    output: Path | None = None,
) -> argparse.Namespace:
    return argparse.Namespace(
        app=os.fspath(app),
        repository=os.fspath(repository),
        distribution_zip=os.fspath(distribution_zip) if distribution_zip else None,
        sbom=sboms or [],
        license_archive=os.fspath(license_archive) if license_archive else None,
        clean_mac_evidence=os.fspath(clean_mac) if clean_mac else None,
        public_authorization=os.fspath(authorization) if authorization else None,
        output=os.fspath(output or tmp_path / "evidence.json"),
        overwrite=False,
        public_ready=False,
        command="collect",
    )


def _write_public_evidence(
    tmp_path: Path, app: Path, repository: Path | None = None
) -> tuple[list[str], Path, Path, Path]:
    app_sha256 = release_evidence.fingerprint_tree(app)["sha256"]
    sbom_arguments = []
    for label in release_evidence.REQUIRED_SBOMS:
        path = tmp_path / f"{label}.cdx.json"
        path.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "components": [{"name": f"loci-{label}", "type": "application"}],
                }
            ),
            encoding="utf-8",
        )
        sbom_arguments.append(f"{label}={path}")
    sbom_hashes = {
        label: release_evidence.fingerprint_file(
            tmp_path / f"{label}.cdx.json", label=f"{label} SBOM"
        )["sha256"]
        for label in release_evidence.REQUIRED_SBOMS
    }
    lock_hashes = {
        "desktop": "1" * 64,
        "engine": "2" * 64,
    }
    if repository is not None:
        lock_hashes = {
            "desktop": release_evidence.fingerprint_file(
                repository / "desktop" / "package-lock.json", label="desktop lock"
            )["sha256"],
            "engine": release_evidence.fingerprint_file(
                repository / "engine" / "uv.lock", label="engine lock"
            )["sha256"],
        }

    archive = tmp_path / "licences.zip"
    payloads = {
        "licenses/embedded/pyinstaller-1/COPYING.txt": b"GPL-2.0 with exception\n",
        "licenses/npm/example-1/LICENSE": b"MIT\n",
        "licenses/pypi/example-1/LICENSE": b"BSD-3-Clause\n",
        "licenses/platform/electron-1/LICENSE": b"MIT\n",
    }
    components = []
    for ecosystem, path in (
        ("embedded", "licenses/embedded/pyinstaller-1/COPYING.txt"),
        ("npm", "licenses/npm/example-1/LICENSE"),
        ("pypi", "licenses/pypi/example-1/LICENSE"),
        ("platform", "licenses/platform/electron-1/LICENSE"),
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
                        "sha256": release_supply_chain._sha256_bytes(payload),
                        "size_bytes": len(payload),
                    }
                ],
            }
        )
    manifest = {
        "schema": release_supply_chain.LICENCE_MANIFEST_SCHEMA,
        "generator": {
            "name": "loci-release-supply-chain",
            "version": release_supply_chain.GENERATOR_VERSION,
        },
        "inputs": {
            "app_tree_sha256": app_sha256,
            "desktop_lock_sha256": lock_hashes["desktop"],
            "engine_lock_sha256": lock_hashes["engine"],
            "sboms": sbom_hashes,
        },
        "coverage": {"embedded": 1, "npm": 1, "platform": 1, "pypi": 1},
        "components": components,
    }
    release_supply_chain._write_licence_archive(archive, manifest, payloads)

    clean_mac = tmp_path / "clean-mac.json"
    clean_mac.write_text(
        json.dumps(
            {
                "schema": "loci.clean-mac-evidence/v1",
                "passed": True,
                "environment_is_clean": True,
                "app_tree_sha256": app_sha256,
                "test_run_id": "clean-mac-run-001",
            }
        ),
        encoding="utf-8",
    )
    authorization = tmp_path / "public-authorization.json"
    authorization.write_text(
        json.dumps(
            {
                "schema": "loci.public-release-authorization/v1",
                "authorized": True,
                "app_tree_sha256": app_sha256,
                "release_version": "1.0.0",
                "authorization_id": "human-decision-001",
            }
        ),
        encoding="utf-8",
    )
    return sbom_arguments, archive, clean_mac, authorization


def test_tree_hash_is_deterministic_and_excludes_mtime(tmp_path: Path) -> None:
    app = _make_app(tmp_path)

    first = release_evidence.fingerprint_tree(app)
    executable = app / "Contents" / "MacOS" / "Loci"
    stat_before = executable.stat()
    os.utime(
        executable, ns=(stat_before.st_atime_ns, stat_before.st_mtime_ns + 1_000_000)
    )
    second = release_evidence.fingerprint_tree(app)

    assert first == second

    executable.chmod(0o700)
    assert release_evidence.fingerprint_tree(app)["sha256"] != first["sha256"]


def test_tree_hash_changes_with_content_and_link_target(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    original = release_evidence.fingerprint_tree(app)["sha256"]

    executable = app / "Contents" / "MacOS" / "Loci"
    executable.write_bytes(b"changed fixture")
    after_content = release_evidence.fingerprint_tree(app)["sha256"]
    assert after_content != original

    link = app / "Contents" / "Frameworks" / "Current"
    link.unlink()
    link.symlink_to("Versions/B")
    assert release_evidence.fingerprint_tree(app)["sha256"] != after_content


def test_collect_local_adhoc_is_deterministic_but_not_public_ready(
    tmp_path: Path,
) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    arguments = _arguments(tmp_path, app, repository)

    first = release_evidence.collect_report(
        arguments, runner=_runner(developer_id=False)
    )
    second = release_evidence.collect_report(
        arguments, runner=_runner(developer_id=False)
    )

    assert first == second
    assert first["application"]["signature"]["mode"] == "ad-hoc"
    assert first["application"]["bundle"]["architectures"] == ["arm64", "x86_64"]
    assert first["public_readiness"]["ready"] is False
    failures = first["public_readiness"]["failures"]
    assert any("ad-hoc" in failure for failure in failures)
    assert any("notarized" in failure for failure in failures)
    assert any("clean-Mac" in failure for failure in failures)
    assert any("authorization" in failure for failure in failures)


def test_public_gate_passes_only_complete_exact_evidence(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    sboms, archive, clean_mac, authorization = _write_public_evidence(
        tmp_path, app, repository
    )
    arguments = _arguments(
        tmp_path,
        app,
        repository,
        sboms=sboms,
        license_archive=archive,
        clean_mac=clean_mac,
        authorization=authorization,
    )

    report = release_evidence.collect_report(arguments, runner=_runner())

    assert report["public_readiness"] == {"ready": True, "failures": []}
    assert report["application"]["signature"]["mode"] == "developer-id"
    assert report["application"]["notarization"]["gatekeeper"]["notarized"] is True
    assert report["application"]["notarization"]["staple"]["valid"] is True
    assert set(report["sboms"]) == set(release_evidence.REQUIRED_SBOMS)
    assert report["license_archive"]["coverage_complete"] is True


def test_public_evidence_is_bound_to_exact_app_hash_and_version(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    _, _, clean_mac, authorization = _write_public_evidence(tmp_path, app)

    clean = release_evidence.inspect_clean_mac_evidence(clean_mac, app_sha256="0" * 64)
    approval = release_evidence.inspect_public_authorization(
        authorization,
        app_sha256="0" * 64,
        release_version="2.0.0",
    )

    assert clean["valid"] is False
    assert "does not match" in " ".join(clean["reasons"])
    assert approval["valid"] is False
    assert "release_version does not match this app" in approval["reasons"]


def test_invalid_sbom_and_unsafe_zip_are_recorded_fail_closed(tmp_path: Path) -> None:
    invalid_sbom = tmp_path / "invalid.json"
    invalid_sbom.write_text('{"bomFormat":"SPDX","components":[]}', encoding="utf-8")
    sbom = release_evidence.inspect_sbom(invalid_sbom, label="desktop")

    unsafe_zip = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(unsafe_zip, "w") as output:
        output.writestr("../escape", "not extracted")
    archive = release_evidence.inspect_zip(
        unsafe_zip,
        label="Distribution ZIP",
        require_app=True,
    )

    assert sbom["valid"] is False
    assert archive["valid"] is False
    assert any("unsafe" in reason for reason in archive["reasons"])


def test_distribution_zip_must_match_exact_single_app_tree(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    expected_tree = release_evidence.fingerprint_tree(app)
    matching_path = _write_app_zip(app, tmp_path / "matching.zip")

    matching = release_evidence.inspect_zip(
        matching_path,
        label="Distribution ZIP",
        require_app=True,
        expected_app_name=app.name,
        expected_tree=expected_tree,
    )

    assert matching["valid"] is True
    assert matching["matches_app_tree"] is True
    assert matching["app_tree"] == expected_tree

    other_root_path = _write_app_zip(
        app, tmp_path / "other-root.zip", root_name="DefinitelyNotLoci.app"
    )
    other_root = release_evidence.inspect_zip(
        other_root_path,
        label="Distribution ZIP",
        require_app=True,
        expected_app_name=app.name,
        expected_tree=expected_tree,
    )
    assert other_root["valid"] is False

    changed_path = tmp_path / "changed.zip"
    app.joinpath("Contents", "MacOS", "Loci").write_bytes(b"different app")
    _write_app_zip(app, changed_path)
    changed = release_evidence.inspect_zip(
        changed_path,
        label="Distribution ZIP",
        require_app=True,
        expected_app_name=app.name,
        expected_tree=expected_tree,
    )
    assert changed["valid"] is False
    assert any("does not match" in reason for reason in changed["reasons"])


def test_distribution_zip_rejects_multiple_apps_and_license_requires_payload(
    tmp_path: Path,
) -> None:
    multiple = tmp_path / "multiple.zip"
    with zipfile.ZipFile(multiple, "w") as archive:
        archive.writestr("Loci.app/readme", "one")
        archive.writestr("Other.app/readme", "two")
    result = release_evidence.inspect_zip(
        multiple,
        label="Distribution ZIP",
        require_app=True,
        expected_app_name="Loci.app",
        expected_tree={"sha256": "0" * 64},
    )
    assert result["valid"] is False
    assert any("exactly one" in reason for reason in result["reasons"])

    empty_license = tmp_path / "empty-license.zip"
    with zipfile.ZipFile(empty_license, "w") as archive:
        archive.writestr("licenses/", b"")
    license_result = release_evidence.inspect_zip(
        empty_license,
        label="Licence archive",
        require_app=False,
    )
    assert license_result["valid"] is False
    assert license_result["payload_files"] == 0


def test_zip_fingerprint_drift_fails_collection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive_path = tmp_path / "licences.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("license.txt", "Apache-2.0")
    original = release_evidence.fingerprint_file
    calls = 0

    def drifting_fingerprint(path: Path, *, label: str) -> dict[str, object]:
        nonlocal calls
        identity = original(path, label=label)
        if label == "Licence archive":
            calls += 1
            if calls == 2:
                return {**identity, "sha256": "0" * 64}
        return identity

    monkeypatch.setattr(release_evidence, "fingerprint_file", drifting_fingerprint)
    with pytest.raises(release_evidence.EvidenceError, match="changed while"):
        release_evidence.inspect_zip(
            archive_path,
            label="Licence archive",
            require_app=False,
        )


def test_missing_or_dirty_repository_evidence_fails_public_gate(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    arguments = _arguments(tmp_path, app, repository)
    report = release_evidence.collect_report(arguments, runner=_runner(dirty=True))

    failures = release_evidence.public_readiness_failures(report)

    assert any("checkout is dirty" in failure for failure in failures)


def test_collection_rejects_app_changed_during_verification(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    arguments = _arguments(tmp_path, app, repository)
    base_runner = _runner()
    changed = False

    def mutating_runner(
        command: list[str] | tuple[str, ...], cwd: Path | None = None
    ) -> release_evidence.CommandResult:
        nonlocal changed
        result = base_runner(command, cwd)
        if Path(command[0]).name == "codesign" and "-dv" in command and not changed:
            (app / "Contents" / "MacOS" / "Loci").write_bytes(b"mutated during checks")
            changed = True
        return result

    with pytest.raises(release_evidence.EvidenceError, match="changed during"):
        release_evidence.collect_report(arguments, runner=mutating_runner)


def test_collection_rejects_repository_changed_during_verification(
    tmp_path: Path,
) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    arguments = _arguments(tmp_path, app, repository)
    base_runner = _runner()
    status_calls = 0

    def drifting_runner(
        command: list[str] | tuple[str, ...], cwd: Path | None = None
    ) -> release_evidence.CommandResult:
        nonlocal status_calls
        if Path(command[0]).name == "git" and command[1:3] == (
            "status",
            "--porcelain=v1",
        ):
            status_calls += 1
            return release_evidence.CommandResult(
                0, " M engine/uv.lock\0" if status_calls > 1 else ""
            )
        return base_runner(command, cwd)

    with pytest.raises(release_evidence.EvidenceError, match="repository changed"):
        release_evidence.collect_report(arguments, runner=drifting_runner)


def test_output_must_not_alias_or_reside_in_verified_inputs(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)

    inside_app = _arguments(
        tmp_path,
        app,
        repository,
        output=app / "Contents" / "release-evidence.json",
    )
    with pytest.raises(release_evidence.EvidenceError, match="outside the app bundle"):
        release_evidence.validate_collect_output(inside_app, Path(inside_app.output))

    inside_repository = _arguments(
        tmp_path,
        app,
        repository,
        output=repository / "release-evidence.json",
    )
    with pytest.raises(
        release_evidence.EvidenceError, match="outside the release repository"
    ):
        release_evidence.validate_collect_output(
            inside_repository, Path(inside_repository.output)
        )

    alias_root = tmp_path / "app-alias"
    alias_root.symlink_to(app / "Contents", target_is_directory=True)
    through_parent_link = _arguments(
        tmp_path,
        app,
        repository,
        output=alias_root / "release-evidence.json",
    )
    with pytest.raises(release_evidence.EvidenceError, match="outside the app bundle"):
        release_evidence.validate_collect_output(
            through_parent_link, Path(through_parent_link.output)
        )

    license_archive = tmp_path / "licenses.zip"
    with zipfile.ZipFile(license_archive, "w") as archive:
        archive.writestr("license.txt", "Apache-2.0")
    aliases_input = _arguments(
        tmp_path,
        app,
        repository,
        license_archive=license_archive,
        output=license_archive,
    )
    with pytest.raises(
        release_evidence.EvidenceError, match="must not replace or alias"
    ):
        release_evidence.validate_collect_output(
            aliases_input, Path(aliases_input.output)
        )

    hardlink_output = tmp_path / "license-evidence-alias.json"
    os.link(license_archive, hardlink_output)
    hardlink_aliases_input = _arguments(
        tmp_path,
        app,
        repository,
        license_archive=license_archive,
        output=hardlink_output,
    )
    with pytest.raises(
        release_evidence.EvidenceError, match="must not replace or alias"
    ):
        release_evidence.validate_collect_output(
            hardlink_aliases_input, Path(hardlink_aliases_input.output)
        )


def test_atomic_writer_requires_explicit_overwrite_and_rejects_symlink(
    tmp_path: Path,
) -> None:
    report_path = tmp_path / "report.json"
    report = {"schema": release_evidence.REPORT_SCHEMA}
    release_evidence.atomic_write_json(report_path, report, overwrite=False)

    with pytest.raises(release_evidence.EvidenceError, match="already exists"):
        release_evidence.atomic_write_json(report_path, report, overwrite=False)
    release_evidence.atomic_write_json(report_path, {"changed": True}, overwrite=True)
    assert json.loads(report_path.read_text()) == {"changed": True}

    target = tmp_path / "target.json"
    target.write_text("{}", encoding="utf-8")
    link = tmp_path / "link.json"
    link.symlink_to(target)
    with pytest.raises(release_evidence.EvidenceError, match="symbolic-link"):
        release_evidence.atomic_write_json(link, report, overwrite=True)


def test_atomic_writer_translates_filesystem_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report_path = tmp_path / "report.json"

    def denied(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise PermissionError("denied by fixture")

    monkeypatch.setattr(release_evidence.tempfile, "NamedTemporaryFile", denied)
    with pytest.raises(release_evidence.EvidenceError, match="publish evidence report"):
        release_evidence.atomic_write_json(
            report_path,
            {"schema": release_evidence.REPORT_SCHEMA},
            overwrite=False,
        )


def test_checker_rejects_stale_public_readiness(tmp_path: Path) -> None:
    report_path = tmp_path / "report.json"
    report_path.write_text(
        json.dumps(
            {
                "schema": release_evidence.REPORT_SCHEMA,
                "repository": {},
                "application": {},
                "public_readiness": {"ready": True, "failures": []},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(release_evidence.EvidenceError, match="does not match"):
        release_evidence.read_report(report_path)


def test_public_gate_rejects_malformed_recorded_subfields(tmp_path: Path) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    sboms, archive, clean_mac, authorization = _write_public_evidence(
        tmp_path, app, repository
    )
    report = release_evidence.collect_report(
        _arguments(
            tmp_path,
            app,
            repository,
            sboms=sboms,
            license_archive=archive,
            clean_mac=clean_mac,
            authorization=authorization,
        ),
        runner=_runner(),
    )
    assert report["public_readiness"]["ready"] is True

    report["repository"]["commit"] = "not-a-git-object-id"
    report["sboms"]["desktop"]["component_count"] = 0
    report["license_archive"]["inputs"]["sboms"]["desktop"] = "0" * 64
    report["clean_mac_evidence"]["test_run_id"] = ""
    failures = release_evidence.public_readiness_failures(report)

    assert any("Git commit evidence" in failure for failure in failures)
    assert any("desktop SBOM" in failure for failure in failures)
    assert any("licence archive" in failure for failure in failures)
    assert any("clean-Mac" in failure for failure in failures)


def test_stored_unsigned_ready_report_cannot_establish_live_public_readiness(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    app = _make_app(tmp_path)
    repository = _make_repository(tmp_path)
    sboms, archive, clean_mac, authorization = _write_public_evidence(
        tmp_path, app, repository
    )
    report = release_evidence.collect_report(
        _arguments(
            tmp_path,
            app,
            repository,
            sboms=sboms,
            license_archive=archive,
            clean_mac=clean_mac,
            authorization=authorization,
        ),
        runner=_runner(),
    )
    report_path = tmp_path / "ready-report.json"
    release_evidence.atomic_write_json(report_path, report, overwrite=False)

    return_code = release_evidence.main(
        ["check", "--report", os.fspath(report_path), "--public-ready"]
    )

    captured = capsys.readouterr()
    assert return_code == 2
    assert "not live-verified" in captured.out
    assert "stored unsigned JSON cannot establish" in captured.err


@pytest.mark.parametrize(
    "document",
    [
        {
            "bomFormat": "CycloneDX",
            "specVersion": "garbage",
            "components": [{"name": "component", "type": "library"}],
        },
        {
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "components": [None],
        },
        {
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "components": [{"name": "", "type": "made-up"}],
        },
    ],
)
def test_sbom_requires_supported_spec_and_named_typed_components(
    tmp_path: Path, document: dict[str, object]
) -> None:
    path = tmp_path / "invalid-sbom.json"
    path.write_text(json.dumps(document), encoding="utf-8")

    result = release_evidence.inspect_sbom(path, label="desktop")

    assert result["valid"] is False


def test_public_ready_cli_returns_two_and_lists_actions(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    report_path = tmp_path / "report.json"
    report = {
        "schema": release_evidence.REPORT_SCHEMA,
        "repository": {},
        "application": {},
    }
    failures = release_evidence.public_readiness_failures(report)
    report["public_readiness"] = {"ready": False, "failures": failures}
    release_evidence.atomic_write_json(report_path, report, overwrite=False)

    return_code = release_evidence.main(
        ["check", "--report", os.fspath(report_path), "--public-ready"]
    )

    captured = capsys.readouterr()
    assert return_code == 2
    assert "NOT READY" in captured.out
    assert "Git commit evidence" in captured.err


def test_paths_and_sbom_labels_are_unambiguous(tmp_path: Path) -> None:
    with pytest.raises(release_evidence.EvidenceError, match="absolute path"):
        release_evidence._absolute_path("relative/Loci.app", label="App")
    with pytest.raises(release_evidence.EvidenceError, match="lowercase"):
        release_evidence._parse_sbom_arguments([f"Desktop={tmp_path / 'bom.json'}"])
    with pytest.raises(release_evidence.EvidenceError, match="Duplicate"):
        release_evidence._parse_sbom_arguments(
            [f"desktop={tmp_path / 'one.json'}", f"desktop={tmp_path / 'two.json'}"]
        )


def test_verify_release_assets_success_and_mismatch(tmp_path: Path) -> None:
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    file_a = assets_dir / "desktop.cdx.json"
    file_a.write_text("desktop-sbom-content", encoding="utf-8")
    hash_a = release_evidence.fingerprint_file(file_a, label="file_a")["sha256"]

    file_b = assets_dir / "engine.cdx.json"
    file_b.write_text("engine-sbom-content", encoding="utf-8")
    hash_b = release_evidence.fingerprint_file(file_b, label="file_b")["sha256"]

    # Successful verification
    result = release_evidence.verify_release_assets(
        assets_dir,
        {"desktop.cdx.json": str(hash_a), "engine.cdx.json": str(hash_b)},
    )
    assert result["valid"] is True
    assert len(result["failures"]) == 0
    assert len(result["verified"]) == 2
    assert all(item["status"] == "matched" for item in result["verified"])

    # Checksum mismatch
    result_mismatch = release_evidence.verify_release_assets(
        assets_dir,
        {"desktop.cdx.json": "0" * 64, "engine.cdx.json": str(hash_b)},
    )
    assert result_mismatch["valid"] is False
    assert any(
        "Checksum mismatch for 'desktop.cdx.json'" in msg
        for msg in result_mismatch["failures"]
    )


def test_verify_release_assets_missing_and_invalid(tmp_path: Path) -> None:
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()

    # Missing file
    result_missing = release_evidence.verify_release_assets(
        assets_dir,
        {"nonexistent.zip": "a" * 64},
    )
    assert result_missing["valid"] is False
    assert any(
        "Missing required release asset" in msg for msg in result_missing["failures"]
    )

    # Invalid sha256 pattern
    result_invalid = release_evidence.verify_release_assets(
        assets_dir,
        {"invalid.json": "not-a-sha256"},
    )
    assert result_invalid["valid"] is False
    assert any("Invalid expected SHA-256" in msg for msg in result_invalid["failures"])

    # Non-existent assets directory
    with pytest.raises(release_evidence.EvidenceError, match="not a directory"):
        release_evidence.verify_release_assets(
            tmp_path / "nowhere", {"file.zip": "a" * 64}
        )

    # Empty expected checksums
    with pytest.raises(
        release_evidence.EvidenceError, match="No expected asset checksums"
    ):
        release_evidence.verify_release_assets(assets_dir, {})


def test_extract_expected_checksums_from_report() -> None:
    report = {
        "sboms": {
            "desktop": {"sha256": "1" * 64},
            "engine": {"sha256": "2" * 64},
        },
        "license_archive": {"sha256": "3" * 64},
    }
    extracted = release_evidence.extract_expected_checksums_from_report(report)
    assert extracted == {
        "desktop.cdx.json": "1" * 64,
        "engine.cdx.json": "2" * 64,
        "dependency-licences.zip": "3" * 64,
    }


def test_verify_assets_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    asset = assets_dir / "test.zip"
    asset.write_bytes(b"content")
    digest = release_evidence.fingerprint_file(asset, label="asset")["sha256"]

    checksums_file = tmp_path / "checksums.json"
    checksums_file.write_text(
        json.dumps({"test.zip": digest}),
        encoding="utf-8",
    )

    # CLI success
    code = release_evidence.main(
        [
            "verify-assets",
            "--directory",
            os.fspath(assets_dir),
            "--checksums",
            os.fspath(checksums_file),
        ]
    )
    captured = capsys.readouterr()
    assert code == 0
    assert "[OK] test.zip" in captured.out
    assert "All 1 release assets verified successfully" in captured.out

    # CLI failure: missing required argument
    code_no_manifest = release_evidence.main(
        ["verify-assets", "--directory", os.fspath(assets_dir)]
    )
    captured_err = capsys.readouterr()
    assert code_no_manifest == 2
    assert "Specify either --checksums or --report" in captured_err.err
