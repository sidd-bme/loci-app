import io
import json
import sys
import threading

import pytest

from loci_engine import cli


class Tty(io.StringIO):
    def isatty(self):
        return True


def observe_indicator(monkeypatch, stream):
    """Synchronize with the real indicator instead of a 50 ms scheduling margin."""
    rendered = threading.Event()
    original_write = stream.write
    original_indicator = cli.WorkIndicator
    indicators = []

    def write(text):
        count = original_write(text)
        if "\x1b" in text:
            rendered.set()
        return count

    def indicator(*args, **kwargs):
        instance = original_indicator(*args, **kwargs, delay=0)
        indicators.append(instance)
        return instance

    monkeypatch.setattr(stream, "write", write)
    monkeypatch.setattr(cli, "WorkIndicator", indicator)
    return indicators, rendered


@pytest.mark.parametrize(
    "flags,environment,has_motion",
    [
        ([], {"TERM": "xterm"}, True),
        (["--json"], {"TERM": "xterm"}, False),
        (["--plain"], {"TERM": "xterm"}, False),
        (["--no-motion"], {"TERM": "xterm"}, False),
        ([], {"TERM": "dumb"}, False),
        ([], {"TERM": "xterm", "NO_COLOR": ""}, False),
    ],
)
def test_terminal_mode_and_motion_policy(monkeypatch, flags, environment, has_motion):
    stdout, stderr = Tty(), Tty()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    monkeypatch.delenv("NO_COLOR", raising=False)
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    indicators, rendered = observe_indicator(monkeypatch, stderr)

    def execute(_args):
        assert len(indicators) == 1
        assert indicators[0].enabled is has_motion
        if has_motion:
            assert rendered.wait(2), "The enabled indicator did not render"
        return {"valid": True}

    monkeypatch.setattr(cli, "_friendly_execute", execute)
    assert (
        cli.main([*flags, "execute", "--project", "study", "validate_recipe", "--request", "{}"])
        == 0
    )
    assert ("\x1b" in stderr.getvalue()) is has_motion
    assert "\x1b" not in stdout.getvalue()
    if "--json" in flags:
        assert json.loads(stdout.getvalue()) == {"valid": True}
    else:
        assert "Loci" in stdout.getvalue() and "valid: True" in stdout.getvalue()


def test_interrupted_execution_clears_indicator_and_reports_inspect_jobs(monkeypatch):
    stdout, stderr = Tty(), Tty()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    monkeypatch.setenv("TERM", "xterm")
    monkeypatch.delenv("NO_COLOR", raising=False)

    indicators, rendered = observe_indicator(monkeypatch, stderr)

    def interrupted(_args):
        assert len(indicators) == 1 and indicators[0].enabled
        assert rendered.wait(2), "The enabled indicator did not render"
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "_friendly_execute", interrupted)
    assert cli.main(["run", "--project", "study", "--job", "a" * 32]) == 130
    assert stdout.getvalue() == ""
    assert "\r\x1b[2KLoci: Interrupted." in stderr.getvalue()
    assert "Inspect jobs before retrying" in stderr.getvalue()


@pytest.mark.parametrize("state", ["failed", "cancelled", "interrupted"])
@pytest.mark.parametrize("command", ["run", "submit-run", "submit", "job", "jobs"])
def test_failure_exit_status_is_for_requested_execution_only(monkeypatch, state, command):
    stdout, stderr = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    job = {"id": "a" * 32, "state": state, "error": "Execution stopped before publication."}
    monkeypatch.setattr(cli, "_friendly_execute", lambda _args: {"job": job})
    if command.startswith("submit"):
        arguments = ["submit", "--project", "study", "--request", "{}", "--request-key", "stable"]
        if command == "submit-run":
            arguments.append("--run")
    else:
        arguments = [command, "--project", "study"]
        if command != "jobs":
            arguments.extend(["--job", job["id"]])
    assert cli.main(arguments) == (1 if command in {"run", "submit-run"} else 0)
    assert json.loads(stdout.getvalue())["job"]["state"] == state


def test_operation_routes_come_from_task_and_preview_sets_not_mutates():
    from loci_engine.cli_support import operation
    from loci_engine.research_operations import (
        OPERATION_CATALOG,
        PREVIEW_OPERATIONS,
        TASK_OPERATIONS,
    )

    for name in OPERATION_CATALOG:
        detail = operation(name)
        durable = name in TASK_OPERATIONS - PREVIEW_OPERATIONS
        assert detail["route"] == ("submit" if durable else "execute")
        assert detail["preview"] is (name in PREVIEW_OPERATIONS)
        assert detail["mutates"] is OPERATION_CATALOG[name]["mutates"]
        assert ("--request-key" in detail["argv"]) is durable
        if durable:
            assert detail["argv"][detail["argv"].index("--operation") + 1] == name
            assert detail["argv"][-1] == "--run"
        else:
            assert detail["argv"][4] == name
        # Parser acceptance is tied to the actual execution command and its exact flags.
        parsed = cli.parser().parse_args(detail["argv"][1:])
        assert parsed.operation == name
    assert operation("large_result_export")["route"] == "submit"
    assert operation("channels")["route"] == "execute"
    assert operation("model_preview")["route"] == "execute"
    assert operation("workflow_validate")["request_schema"] is None


def test_filtered_discovery_preserves_shared_catalog_and_no_query_protocol():
    from loci_engine.cli_support import discover
    from loci_engine.research_operations import OPERATION_CATALOG

    assert discover(None) == {"schema": "loci.operations/v1", "operations": OPERATION_CATALOG}
    assert discover("PHYSICAL transform")["operations"] == {
        "registration_preview": OPERATION_CATALOG["registration_preview"]
    }
    assert discover("not-an-operation")["operations"] == {}
    assert len(discover("")["operations"]) == len(OPERATION_CATALOG)


def test_grouped_help_hides_internal_commands_without_removing_dispatch():
    root = cli.parser()
    help_text = root.format_help()
    for group in ("Explore", "Study", "Analysis", "Connections", "Terminal"):
        assert group in help_text
    for command in cli._INTERNAL:
        assert command not in help_text
    # The internal parser remains available to the transport bypass.
    assert root.parse_args(["remote-worker", "--request", "{}"]).command == "remote-worker"


@pytest.mark.parametrize("flags", [["--plain"], ["--json"], ["--no-motion"]])
def test_logo_and_welcome_disabled_modes_never_start_animation(monkeypatch, flags):
    stdout, stderr = Tty(), Tty()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setenv("TERM", "xterm")
    monkeypatch.setattr(cli, "animate_logo", lambda *_args: pytest.fail("Unexpected animation"))
    assert cli.main(flags) == 0
    assert cli.main([*flags, "logo", "--animate"]) == 0
    assert "\x1b" not in stdout.getvalue() + stderr.getvalue()


def test_real_terminal_startup_opens_persistent_session(monkeypatch):
    stdout, stderr = Tty(), Tty()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setenv("TERM", "xterm")
    monkeypatch.delenv("NO_COLOR", raising=False)
    calls = []
    monkeypatch.setattr(cli.os, "name", "posix")
    monkeypatch.setattr(cli, "run_session", lambda: calls.append("session") or 0)
    assert cli.main([]) == 0
    assert calls == ["session"]


@pytest.mark.parametrize("duration", ["nan", "inf", "-1", "9", "invalid"])
def test_logo_duration_rejected_even_in_machine_mode(capsys, duration):
    assert cli.main(["--json", "logo", "--animate", "--duration", duration]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err)["error"]["type"] == "ArgumentError"


def test_doctor_reports_required_missing_packages_as_failure(monkeypatch, capsys):
    from loci_engine import cli_support

    monkeypatch.setattr(cli_support.importlib.util, "find_spec", lambda _name: None)
    assert cli.main(["doctor", "--json"]) == 1
    captured = capsys.readouterr()
    receipt = json.loads(captured.out)
    assert {item["name"] for item in receipt["checks"] if item["status"] == "not-found"} == {
        "numpy",
        "scipy",
        "tifffile",
        "cellpose",
    }
    assert json.loads(captured.err)["error"]["type"] == "DiagnosticError"


def test_doctor_optional_package_absence_does_not_fail_core(monkeypatch, capsys):
    from loci_engine import cli_support

    monkeypatch.setattr(
        cli_support.importlib.util,
        "find_spec",
        lambda name: None if name == "cellpose" else object(),
    )
    assert cli.main(["doctor", "--json"]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    cellpose = next(
        item for item in json.loads(captured.out)["checks"] if item["name"] == "cellpose"
    )
    assert cellpose == {"name": "cellpose", "required": False, "status": "not-found"}


@pytest.mark.parametrize("command", sorted(cli._INTERNAL))
def test_internal_protocols_bypass_all_friendly_presentation(monkeypatch, command):
    stdout, stderr = Tty(), Tty()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    monkeypatch.setenv("TERM", "xterm")
    calls = []
    monkeypatch.setattr(cli.research_cli, "main", lambda values: calls.append(values) or 7)
    monkeypatch.setattr(cli, "parser", lambda: pytest.fail("Friendly parser in child"))
    monkeypatch.setattr(cli, "animate_logo", lambda *_args: pytest.fail("Brand in child"))
    assert cli.main(["--no-motion", "--plain", command, "--help"]) == 7
    assert calls == [[command, "--help"]]
    assert stdout.getvalue() + stderr.getvalue() == ""
