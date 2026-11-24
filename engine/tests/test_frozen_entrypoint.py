"""Read-only tests of the frozen startup dispatch using local pipes."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "loci_engine_entry.py"
_HEALTH = b'{"id": "check", "method": "health", "params": {}}\n'
_FROZEN_PROXY = (
    "import runpy,sys;"
    "sys.frozen=True;"
    "sys.argv=sys.argv[1:];"
    "runpy.run_path(sys.argv[0],run_name='__main__')"
)


def _frozen(*arguments: str, pass_fds=()):
    return subprocess.run(
        [sys.executable, "-c", _FROZEN_PROXY, str(ENTRYPOINT), *arguments],
        capture_output=True,
        input=_HEALTH,
        timeout=10,
        pass_fds=pass_fds,
    )


@pytest.mark.skipif(os.name != "posix", reason="The tracker uses an inherited POSIX pipe")
def test_frozen_resource_tracker_keeps_rpc_stdio_unused():
    reader, writer = os.pipe()
    os.close(writer)
    try:
        result = _frozen(
            "-B",
            "-S",
            "-I",
            "-c",
            f"from multiprocessing.resource_tracker import main;main({reader})",
            pass_fds=(reader,),
        )
    finally:
        os.close(reader)
    assert result.returncode == 0, result.stderr
    assert result.stdout == b""


@pytest.mark.parametrize(
    ("flags", "command"),
    [
        (["-B", "-S", "-I", "-c"], "unsupported helper"),
        (["-B", "-S", "-I", "-c"], "from multiprocessing.resource_tracker import main;main(0)"),
        (["-B", "-S", "-c"], "from multiprocessing.resource_tracker import main;main(3)"),
    ],
)
def test_other_frozen_helper_invocations_are_refused(flags, command):
    result = _frozen(*flags, command)
    assert result.returncode != 0
    assert result.stdout == b""


@pytest.mark.skipif(os.name != "posix", reason="The tracker uses an inherited POSIX pipe")
def test_frozen_resource_tracker_refuses_an_inherited_regular_file(tmp_path):
    source = tmp_path / "ordinary.txt"
    source.write_text("Ordinary file")
    with source.open("rb") as opened:
        descriptor = opened.fileno()
        result = _frozen(
            "-B",
            "-S",
            "-I",
            "-c",
            f"from multiprocessing.resource_tracker import main;main({descriptor})",
            pass_fds=(descriptor,),
        )
    assert result.returncode != 0 and b"requires an inherited pipe" in result.stderr
    assert result.stdout == b""


def test_normal_frozen_worker_and_cli_routes_are_preserved():
    result = _frozen()
    assert result.returncode == 0, result.stderr
    reply = json.loads(result.stdout)
    assert reply["id"] == "check" and reply["result"]["status"] == "ready"
    cli = _frozen("--cli", "discover")
    assert cli.returncode == 0, cli.stderr
    assert "tissue_run" in json.loads(cli.stdout)["operations"]
