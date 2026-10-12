"""The packaged launcher must preserve exact arguments without shell expansion."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(os.name != "posix", reason="macOS POSIX launcher")
def test_packaged_and_repository_launchers_preserve_arguments(tmp_path):
    app = tmp_path / "App with spaces.app"
    macos = app / "Contents" / "MacOS"
    worker_dir = app / "Contents" / "Resources" / "loci-engine"
    macos.mkdir(parents=True)
    worker_dir.mkdir(parents=True)
    desktop = macos / "Loci"
    desktop.write_bytes(b"preserved desktop executable")
    cli_directory = app / "Contents" / "Resources" / "bin"
    cli_directory.mkdir()
    launcher = cli_directory / "loci"
    shutil.copyfile(ROOT / "desktop/assets/loci-cli", launcher)
    launcher.chmod(0o755)
    worker = worker_dir / "loci-engine"
    worker.write_text(
        f"#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n"
    )
    worker.chmod(0o755)
    arguments = [
        "--json",
        "example",
        "components",
        "--source",
        "literal $(false) `false`",
    ]
    environment = {**os.environ, "LOCI_APP": str(app)}
    for command in ([str(launcher)], ["sh", str(ROOT / "scripts/loci")]):
        run = subprocess.run(
            [*command, *arguments],
            env=environment,
            capture_output=True,
            text=True,
            check=True,
        )
        assert json.loads(run.stdout) == ["--loci", *arguments]
        assert run.stderr == ""
        assert desktop.read_bytes() == b"preserved desktop executable"


@pytest.mark.skipif(os.name != "posix", reason="macOS POSIX launcher")
def test_repository_launcher_does_not_fall_back_to_an_unqualified_worker(tmp_path):
    run = subprocess.run(
        ["sh", str(ROOT / "scripts/loci"), "discover"],
        check=False,
        env={**os.environ, "LOCI_APP": str(tmp_path / "absent.app")},
        capture_output=True,
        text=True,
    )
    assert run.returncode == 1
    assert run.stdout == ""
    assert "CLI is unavailable" in run.stderr
