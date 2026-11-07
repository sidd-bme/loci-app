"""Static harness checks only; synthetic event objects never qualify an actual host."""

import copy
import importlib.util
import json
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "qa_volume_host", ROOT / "scripts/qa_volume_agent_host.py"
)
QA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QA)


def call_events():
    item = {
        "id": "unit-call",
        "type": "mcp_tool_call",
        "server": QA.MAIN,
        "tool": "volume_view",
        "arguments": {"source_id": "a" * 32},
        "status": "completed",
    }
    return [
        {"type": "thread.started", "thread_id": "unit-parser-fixture"},
        {"type": "item.started", "item": copy.deepcopy(item)},
        {"type": "item.completed", "item": copy.deepcopy(item)},
        {"type": "turn.completed"},
    ]


def test_codex_toml_invocation_is_explicit_scoped_and_read_only(tmp_path):
    prepared = {
        "worker": {"worker_path": "/signed app/worker"},
        "model_home": "/isolated/models",
        "policies": {QA.MAIN: {"path": '/private/policy"quoted.json'}},
    }
    command = QA.command("/installed/codex", prepared, tmp_path)
    assert "--ignore-user-config" in command and "--ephemeral" in command
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert command[command.index("--model") + 1] == "gpt-6.1-sol"
    settings = [command[index + 1] for index, value in enumerate(command) if value == "-c"]
    parsed = tomllib.loads("\n".join(settings))
    assert parsed["model_reasoning_effort"] == "high"
    assert parsed["service_tier"] == "default"
    server = parsed["mcp_servers"][QA.MAIN]
    assert server["command"] == "/signed app/worker"
    assert server["args"] == ["--cli", "mcp", "--policy", '/private/policy"quoted.json']
    assert server["default_tools_approval_mode"] == "auto"


def test_parser_matches_actual_event_envelope_without_claiming_host_run():
    thread, calls = QA.host_calls(call_events(), {QA.MAIN: {}})
    assert thread == "unit-parser-fixture" and len(calls) == 1


@pytest.mark.parametrize(
    "change",
    [
        lambda events: events[1].update(simulated=True),
        lambda events: events[1].update(event_origin="sdk"),
        lambda events: events[1]["item"].update(type="command_execution"),
        lambda events: events[2]["item"].update(server="ungranted"),
        lambda events: events[2]["item"].update(arguments={"source_id": "b" * 32}),
        lambda events: events.pop(2),
        lambda events: events.insert(2, copy.deepcopy(events[1])),
    ],
)
def test_parser_rejects_simulation_bypass_overlap_or_unmatched_events(change):
    events = call_events()
    change(events)
    with pytest.raises(AssertionError):
        QA.host_calls(events, {QA.MAIN: {}})


def test_metadata_packet_has_no_source_paths_or_native_dispatch():
    prepared = {
        key: key
        for key in (
            "case",
            "source_id",
            "source_sha256",
            "result_binding",
            "target_label",
            "probe_source_xyz",
            "expected_t",
            "expected_channels",
            "positive_patch",
            "correction_request",
            "limits",
        )
    }
    prepared.update(
        study="/private/native/study",
        policies={"policy": {"path": "/secret"}},
        worker={"worker_path": "/signed/worker"},
    )
    text = json.dumps(QA.packet_data(prepared))
    assert "/private" not in text and "/secret" not in text and "/signed" not in text


def test_correction_prompt_requires_explicit_prepared_authority():
    with pytest.raises(AssertionError, match="not explicitly prepared"):
        QA.prompt({"allow_correction": False}, "correction")
