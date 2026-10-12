"""Real friendly-CLI workflows and machine-protocol compatibility."""

import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.models import ENGINE_VERSION


def invoke(*args, frozen=False, legacy=False, check=True):
    module = (
        "loci_engine.worker"
        if frozen
        else ("loci_engine.research_cli" if legacy else "loci_engine.cli")
    )
    command = [sys.executable, "-m", module]
    packaged = os.environ.get("LOCI_TEST_CLI_EXECUTABLE")
    launcher = os.environ.get("LOCI_TEST_CLI_LAUNCHER")
    if launcher and not legacy:
        command = [launcher]
    elif packaged and not legacy:
        command = [packaged, "--loci"]
    elif frozen:
        command.append("--loci")
    result = subprocess.run([*command, *args], capture_output=True, text=True, timeout=30)
    if check:
        assert result.returncode == 0, result.stderr
    return result


def receipt(*args, **options):
    result = invoke(*args, **options)
    assert "\x1b" not in result.stdout + result.stderr
    return json.loads(result.stdout)


def test_true_workflow_validation_run_stable_retry_review_export_reopen(tmp_path):
    study = str(tmp_path / "experiment.loci-study")
    receipt("create", "--project", study, "--title", "Synthetic experiment")
    image = np.zeros((2, 16, 20), np.uint16)
    image[:, 3:6, 8:12] = 123
    source_file = tmp_path / "source.ome.tif"
    tifffile.imwrite(source_file, image, metadata={"axes": "ZYX"}, photometric="minisblack")
    imported = receipt("import", "--project", study, str(source_file))
    source = imported["sources"][0]
    assert receipt("sources", "--project", study)["sources"][0]["id"] == source["id"]
    request = receipt("example", "components-2d", "--source", source["id"])
    request["selection"]["width"] = 20
    encoded = json.dumps(request)
    validation = receipt("execute", "--project", study, "validate_recipe", "--request", encoded)
    assert validation
    preview = receipt("execute", "--project", study, "preview_recipe", "--request", encoded)
    assert preview["object_count"] == 1 and preview["adopted"] is False
    result = receipt(
        "submit", "--project", study, "--request", encoded, "--request-key", "stable-frame", "--run"
    )
    retry = receipt(
        "submit", "--project", study, "--request", encoded, "--request-key", "stable-frame", "--run"
    )
    assert retry["job"]["result_ids"] == [result["result"]["id"]]
    assert preview["measurements"] == result["measurements"]
    assert receipt("jobs", "--project", study)["jobs"][0]["state"] == "succeeded"
    assert len(receipt("results", "--project", study)["results"]) == 1
    receipt(
        "review",
        "--project",
        study,
        "--result",
        result["result"]["id"],
        "--revision",
        result["result"]["revision_hash"],
        "--disposition",
        "reviewed",
    )
    destination = str(tmp_path / "reviewed-output")
    receipt(
        "export",
        "--project",
        study,
        "--result",
        result["result"]["id"],
        "--revision",
        result["result"]["revision_hash"],
        "--destination",
        destination,
    )
    reopened = receipt("snapshot", "--project", study, frozen=True)
    assert reopened["results"][0]["review"]["disposition"] == "reviewed"
    assert np.array_equal(
        tifffile.imread(Path(destination) / "image.ome.tif"), image[request["selection"]["z"]]
    )
    assert receipt("snapshot", "--project", study, legacy=True) == reopened
    assert str(tmp_path) not in json.dumps(result)


def test_machine_mode_legacy_catalog_and_frozen_dispatch_are_equal():
    expected = receipt("discover", legacy=True)
    assert receipt("discover") == receipt("--json", "discover", frozen=True) == expected
    metadata = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
    assert metadata["project"]["scripts"]["loci"] == "loci_engine.cli:main"


def test_failed_job_rerun_and_idempotent_submission_have_nonzero_execution_status(tmp_path):
    study = str(tmp_path / "study")
    receipt("create", "--project", study, "--title", "Failed execution fixture")
    source_file = tmp_path / "source.tif"
    tifffile.imwrite(source_file, np.ones((8, 8), np.uint16))
    source_id = receipt("import", "--project", study, str(source_file))["sources"][0]["id"]
    # Durable submission verifies the source; operation validation fails during execution.
    request = json.dumps({"source_id": source_id})
    submit = (
        "submit",
        "--project",
        study,
        "--operation",
        "puncta_run",
        "--request",
        request,
        "--request-key",
        "failed-puncta",
        "--run",
    )
    assert invoke(*submit, check=False).returncode == 1
    jobs = receipt("jobs", "--project", study)["jobs"]
    assert len(jobs) == 1 and jobs[0]["state"] == "failed"
    job_id = jobs[0]["id"]
    for arguments in (("run", "--project", study, "--job", job_id), submit):
        result = invoke(*arguments, check=False)
        assert result.returncode == 1
        assert json.loads(result.stdout)["job"]["state"] == "failed"
        assert json.loads(result.stderr)["error"]["type"] == "JobExecutionError"
    assert receipt("job", "--project", study, "--job", job_id)["state"] == "failed"
    legacy = invoke("run", "--project", study, "--job", job_id, legacy=True)
    assert legacy.returncode == 0 and json.loads(legacy.stdout)["job"]["state"] == "failed"
    assert receipt("results", "--project", study)["results"] == []


def test_help_and_guide_start_without_importing_numerical_backends():
    script = """import sys
from loci_engine.cli import main
assert main(sys.argv[1:]) == 0
assert not any(name in sys.modules for name in ('numpy', 'scipy', 'loci_engine.workbench'))
"""
    for arguments in ([], ["--help"], ["--json", "guide", "recipe"]):
        result = subprocess.run(
            [sys.executable, "-c", script, *arguments], capture_output=True, text=True, timeout=10
        )
        assert result.returncode == 0, result.stderr
        assert "\x1b" not in result.stdout + result.stderr
    help_output = invoke("submit", "--help").stdout
    assert "usage: loci submit" in help_output and "--request-key" in help_output


def test_no_args_pipes_structured_help_and_conflicting_format_flags():
    welcome = receipt()
    assert welcome["schema"] == "loci.cli-help/v1"
    assert any('LOCI_STUDY="$PWD/' in line for line in welcome["examples"])
    help_receipt = receipt("--json", "--help")
    assert help_receipt["schema"] == "loci.cli-help/v1"
    assert "usage: loci COMMAND [options]" in help_receipt["help"]
    plain = invoke("--plain")
    assert "(o) (o)  Loci" in plain.stdout
    conflicting = invoke("--json", "--plain", check=False)
    assert conflicting.returncode == 2 and conflicting.stdout == ""
    assert json.loads(conflicting.stderr)["error"]["type"] == "ArgumentError"


def test_guide_and_authored_examples_do_not_read_a_project():
    guide = receipt("guide", "recipe")
    assert guide["schema"] == "loci.recipe-guide/v1"
    assert {item["name"] for item in guide["examples"]} == {"components-2d", "watershed-3d"}
    request = receipt("example", "watershed-3d", "--source", "a" * 32)
    assert request["source_id"] == "a" * 32
    assert request["selection"]["z_stop"] == 4
    assert request["recipe"]["segmentation"]["method"] == "watershed"
    invalid = invoke("example", "missing", "--source", "a" * 32, check=False)
    assert invalid.returncode == 1 and invalid.stdout == ""
    assert "components-2d" in json.loads(invalid.stderr)["error"]["message"]
    invalid_source = invoke("example", "components-2d", "--source", "invented", check=False)
    assert invalid_source.returncode == 1
    assert "32 lowercase hex" in json.loads(invalid_source.stderr)["error"]["message"]


@pytest.mark.parametrize(
    "arguments",
    [["execute"], ["--json", "sources"], ["--json", "sources", "--plain", "--project", "study"]],
)
def test_argument_errors_have_no_traceback_or_stdout(arguments):
    result = invoke(*arguments, check=False)
    assert result.returncode == 2 and result.stdout == ""
    assert "Traceback" not in result.stderr
    assert "error" in json.loads(result.stderr)


def test_failed_operation_is_explicit_and_never_emits_a_success_receipt(tmp_path):
    result = invoke("sources", "--project", str(tmp_path / "missing-study"), check=False)
    assert result.returncode == 1 and result.stdout == ""
    assert json.loads(result.stderr)["error"]["message"]
    plain = invoke("--plain", "sources", "--project", str(tmp_path / "missing-study"), check=False)
    assert plain.returncode == 1 and "Loci:" in plain.stderr
    assert "Traceback" not in plain.stderr and "\x1b" not in plain.stderr


def test_mcp_startup_remains_protocol_safe_and_redacted(tmp_path):
    missing = str(tmp_path / "private-policy-name.json")
    result = invoke("--plain", "mcp", "--policy", missing, check=False)
    assert result.returncode == 1 and result.stdout == ""
    assert json.loads(result.stderr)["error"]["type"] == "MCPStartupError"
    assert missing not in result.stderr and "\x1b" not in result.stderr


def test_plain_receipt_names_are_sanitized_but_json_values_are_not(tmp_path):
    study = str(tmp_path / "study")
    receipt("create", "--project", study, "--title", "Experiment")
    machine = receipt("snapshot", "--project", study)
    assert machine["project"]["title"] == "Experiment"
    plain = invoke("snapshot", "--project", study, "--plain", check=True)
    assert "Study: Experiment" in plain.stdout and "\x1b" not in plain.stdout + plain.stderr
    assert os.path.isdir(study)


def test_forward_discovery_operation_examples_version_and_doctor_are_lightweight():
    script = """import sys
from loci_engine.cli import main
assert main(sys.argv[1:]) == 0
assert not any(name in sys.modules for name in ('numpy', 'scipy', 'tifffile', 'cellpose',
    'loci_engine.workbench', 'loci_engine.research_project'))
"""
    for arguments in (
        ["discover", "calibrated"],
        ["operation", "large_result_export"],
        ["examples"],
        ["doctor"],
        ["--version"],
        ["completion", "bash"],
        ["logo", "--animate"],
    ):
        result = subprocess.run(
            [sys.executable, "-c", script, *arguments], capture_output=True, text=True, timeout=10
        )
        assert result.returncode == 0, result.stderr
        assert "\x1b" not in result.stdout + result.stderr
    assert receipt("operation", "large_result_export")["route"] == "submit"
    assert receipt("operation", "channels")["route"] == "execute"
    assert receipt("operation", "model_preview")["preview"] is True
    assert receipt("operation", "workflow_validate")["request_schema"] is None
    assert (
        receipt("operation", "validate_recipe")["request_schema"]
        == receipt("guide", "recipe")["request_schema"]
    )
    assert receipt("discover", "not-a-matching-operation")["operations"] == {}
    assert receipt("--version")["version"] == ENGINE_VERSION
    assert len(receipt("examples")["examples"]) == 2
    doctor = receipt("doctor")
    assert "model" in doctor["scope"] and "not-found" not in {
        item["status"] for item in doctor["checks"] if item["name"] == "python"
    }


@pytest.mark.parametrize("shell", ["bash", "zsh", "fish"])
def test_completions_are_static_and_contain_exact_operations_without_transports(shell):
    script = invoke("completion", shell).stdout
    assert script == receipt("completion", shell, "--json")["script"]
    assert "large_result_export" in script and "components-2d" in script
    assert "bounded-transfer" not in script and "remote-worker" not in script
    assert "loci_engine" not in script and "$(loci" not in script
    if shell != "fish":
        syntax = subprocess.run([shell, "-n"], input=script, text=True, capture_output=True)
        assert syntax.returncode == 0, syntax.stderr


@pytest.mark.parametrize(
    "words,current",
    [
        ("loci operation large_result_e", 2),
        ("loci execute --project STUDY large_result_e", 4),
    ],
)
def test_bash_completion_returns_catalog_names(tmp_path, words, current):
    script = tmp_path / "loci.bash"
    script.write_text(invoke("completion", "bash").stdout)
    process = subprocess.run(
        [
            "bash",
            "-c",
            """source "$1"
COMP_WORDS=($2)
COMP_CWORD=$3
_loci_complete
printf '%s\\n' "${COMPREPLY[@]}"
""",
            "bash",
            str(script),
            words,
            str(current),
        ],
        capture_output=True,
        text=True,
    )
    assert process.returncode == 0 and process.stdout == "large_result_export\n"


def _pty_action_marker_seen(captured, offset, marker):
    """Require fresh, ordered acknowledgements for a scripted terminal action."""
    markers = (marker,) if isinstance(marker, bytes) else marker
    for part in markers:
        position = captured.find(part, offset)
        if position < 0:
            return False
        offset = position + len(part)
    return True


def test_pty_action_markers_reject_a_previous_command_completion():
    marker = (b"Running locate 102", b"Exit 0")
    previous = b"Exit 0\nY=11, X=21\n"
    running = previous + b"Running locate 102\nY=11, X=21\n"
    assert not _pty_action_marker_seen(running, len(previous), marker)
    completed = running + b"Exit 0\n"
    assert _pty_action_marker_seen(completed, len(previous), marker)
    assert not _pty_action_marker_seen(completed, len(completed), marker)
    assert _pty_action_marker_seen(completed, len(previous), b"Y=11, X=21")


def pty_cli(
    arguments,
    *,
    interrupt=None,
    environment=None,
    session_script=(),
    resize=None,
    command_override=None,
    interrupt_marker=None,
):
    """Actual terminal process: collect its bytes and optionally interrupt mid-reveal."""
    import errno
    import fcntl
    import pty
    import select
    import signal
    import struct
    import termios
    import time

    master, slave = pty.openpty()
    settings_fd = os.dup(slave)
    original_settings = termios.tcgetattr(settings_fd)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = dict(os.environ, TERM="xterm-256color")
    env.pop("NO_COLOR", None)
    env.update(environment or {})
    command = [sys.executable, "-m", "loci_engine.cli"]
    if command_override:
        command = command_override
    elif os.environ.get("LOCI_TEST_CLI_LAUNCHER"):
        command = [os.environ["LOCI_TEST_CLI_LAUNCHER"]]
    elif os.environ.get("LOCI_TEST_CLI_EXECUTABLE"):
        command = [os.environ["LOCI_TEST_CLI_EXECUTABLE"], "--loci"]
    process = subprocess.Popen(
        [*command, *arguments],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
    )
    os.close(slave)
    captured = bytearray()
    deadline = time.monotonic() + 10
    signalled = False
    actions = iter(session_script)
    action = next(actions, None)
    action_ready_at = None
    action_offset = 0
    resized = False
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            if action:
                marker, delay, keys = action
                if action_ready_at is None and _pty_action_marker_seen(
                    captured, action_offset, marker
                ):
                    action_ready_at = time.monotonic() + delay
                if action_ready_at is not None and time.monotonic() >= action_ready_at:
                    os.write(master, keys)
                    action_offset = len(captured)
                    action, action_ready_at = next(actions, None), None
            if resize and not resized and b"loci> " in captured:
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", *resize, 0, 0))
                process.send_signal(signal.SIGWINCH)
                resized = True
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                captured.extend(data)
                if (
                    interrupt
                    and not signalled
                    and (
                        interrupt_marker in captured
                        if interrupt_marker is not None
                        else b"\x1b[?25l" in captured or b"loci> " in captured
                    )
                ):
                    process.send_signal(getattr(signal, interrupt))
                    signalled = True
        status = process.wait(timeout=2)
        restored = termios.tcgetattr(settings_fd)
        # macOS marks PENDIN when returning to canonical mode; it is transient
        # retype-pending-input state (termios(4)), not a user terminal setting.
        pending = getattr(termios, "PENDIN", 0)
        restored[3] &= ~pending
        original_settings[3] &= ~pending
        assert restored == original_settings
        return status, captured.decode()
    finally:
        os.close(settings_fd)
        os.close(master)
        if process.poll() is None:
            process.kill()
            process.wait()


@pytest.mark.parametrize("interrupt,expected", [(None, 0), ("SIGINT", 130), ("SIGTERM", 143)])
def test_real_pty_logo_finishes_or_interrupts_with_cursor_restored(interrupt, expected):
    status, text = pty_cli(["logo", "--animate", "--duration", "0.5"], interrupt=interrupt)
    assert status == expected
    assert "\x1b[?25l" in text and "\x1b[?25h" in text
    assert text.index("\x1b[?25h") > text.index("\x1b[?25l")
    if interrupt is None:
        assert "LLLLL   OOO    CCC   III" in text
    else:
        assert "published results" not in text


@pytest.mark.parametrize(
    "arguments,environment",
    [
        (["logo", "--animate", "--plain"], {}),
        (["logo", "--animate", "--no-motion"], {}),
        (["logo", "--animate", "--json"], {}),
        (["logo", "--animate"], {"NO_COLOR": ""}),
        (["logo", "--animate"], {"TERM": "dumb"}),
        (["--no-motion"], {}),
    ],
)
def test_real_pty_no_motion_modes_are_control_free(arguments, environment):
    status, text = pty_cli(arguments, environment=environment)
    assert status == 0 and "\x1b" not in text


def test_real_pty_startup_stays_open_animates_and_executes_commands():
    status, text = pty_cli(
        [], session_script=[(b"loci> ", 1.2, b"--version\r"), (b"Exit 0", 0.3, b"\x04")]
    )
    assert status == 0 and text.endswith("\x1b[0m\x1b[?25h")
    assert "Local image research" in text and f"Loci {ENGINE_VERSION}" in text
    assert text.count("\x1b[") > 40  # Updated frames continue after the old bounded reveal.


@pytest.mark.parametrize("keys", [b"exit\r", b"quit\r", b"\x04", b"\x03"])
def test_real_pty_session_exit_restores_cursor(keys):
    status, text = pty_cli([], session_script=[(b"loci> ", 0.2, keys)])
    assert status == (130 if keys == b"\x03" else 0)
    assert text.endswith("\x1b[0m\x1b[?25h")


def test_real_pty_session_pause_resize_and_bad_command_recover():
    status, text = pty_cli(
        [],
        resize=(18, 46),
        session_script=[
            (b"loci> ", 0.1, b"\x10"),
            (b"motion paused", 0.2, b"not-a-command\r"),
            (b"Exit 2", 0.1, b"\x1b[5~"),  # Read the start of the wrapped error.
            (b"invalid choice", 0.1, b"exit\r"),
        ],
    )
    assert status == 0 and "motion paused" in text
    assert "ArgumentError" in text or "invalid choice" in text
    assert text.endswith("\x1b[0m\x1b[?25h")


@pytest.mark.parametrize("interrupt,expected", [("SIGINT", 130), ("SIGTERM", 143), ("SIGHUP", 129)])
def test_real_pty_session_external_signals_restore_terminal(interrupt, expected):
    status, text = pty_cli([], interrupt=interrupt)
    assert status == expected
    assert text.endswith("\x1b[0m\x1b[?25h")


@pytest.mark.skipif(
    bool(os.environ.get("LOCI_TEST_CLI_LAUNCHER") or os.environ.get("LOCI_TEST_CLI_EXECUTABLE")),
    reason="Source controller fixture injects a bounded child, not a packaged command",
)
def test_real_pty_hangup_reaps_active_child_and_restores_terminal(tmp_path):
    pid_file = tmp_path / "child.pid"
    child = (
        "import os,time; from pathlib import Path; "
        f"Path({str(pid_file)!r}).write_text(str(os.getpid())); "
        "print('CHILD_READY', flush=True); time.sleep(30)"
    )
    entry = (
        "from loci_engine import cli, terminal_session; import sys; "
        f"terminal_session._executable=lambda: [sys.executable, '-c', {child!r}]; "
        "raise SystemExit(cli.main())"
    )
    status, text = pty_cli(
        [],
        command_override=[sys.executable, "-c", entry],
        session_script=[(b"loci> ", 0.1, b"doctor\r")],
        interrupt="SIGHUP",
        interrupt_marker=b"CHILD_READY",
    )
    assert status == 129 and text.endswith("\x1b[0m\x1b[?25h")
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_redirected_logo_has_no_animation_delay_even_with_long_requested_duration():
    process = subprocess.run(
        [sys.executable, "-m", "loci_engine.cli", "logo", "--animate", "--duration", "8"],
        capture_output=True,
        text=True,
        timeout=2,
    )
    assert process.returncode == 0 and "\x1b" not in process.stdout + process.stderr
    assert json.loads(process.stdout)["schema"] == "loci.cli-logo/v1"
