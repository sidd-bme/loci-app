"""Focused native fixtures/verifier negatives. Constructed events never qualify a host."""

import copy
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "codex_external_agent_qa", ROOT / "scripts/qa/codex-external-agent.py"
)
QA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QA)


@pytest.fixture
def prepared(tmp_path):
    return QA.prepare(
        output=tmp_path / "exclusive",
        worker=Path(sys.executable),
        case="synthetic",
        allow_test_output=True,
    )


def event_call(tool, arguments, value, *, identity="call-1"):
    item = {
        "id": identity,
        "type": "mcp_tool_call",
        "server": QA.SERVER,
        "tool": tool,
        "arguments": arguments,
    }
    return [
        {"type": "item.started", "item": copy.deepcopy(item)},
        {
            "type": "item.completed",
            "item": {
                **item,
                "status": "completed",
                "result": {"structured_content": value, "content": [], "isError": False},
            },
        },
    ]


def transcript(*calls):
    return [
        {"type": "thread.started", "thread_id": "unit-fixture-not-actual-host"},
        *(event for call in calls for event in call),
        {"type": "turn.completed"},
    ]


def test_prepare_native_fixture_is_inert_exact_and_has_no_session_or_review(prepared):
    assert prepared["case"] == "synthetic"
    project = ResearchProject(prepared["study"])
    assert QA.TISSUE.study_sessions(project.root) == []
    assert len(project.list_results()) == 3 and len(project.list_jobs()) == 1
    assert project.list_jobs()[0]["operation"] == "method_run"
    assert project.list_jobs()[0]["request"]["task_request"]["mode"] == "adopt-external"
    assert all(project.review_state(r["id"]) is None for r in project.list_results())
    reference = project.result(prepared["fixture"]["reference"]["result_id"])
    labels = project.load_array(reference["arrays"]["labels"])
    assert set(np.unique(labels)) == {0, 7, 42}
    assert prepared["provenance"]["physical_calibration"] is None
    assert prepared["method_rows"] == [
        {"label_id": 1, "values": [64.0]},
        {"label_id": 2, "values": [48.0]},
    ]
    assert QA.identity(Path(prepared["output"]), unused=True) == prepared


def test_launcher_pins_actual_model_effort_standard_and_only_one_server(prepared):
    cmd = QA.command("/opt/codex", prepared, Path(prepared["output"]))
    assert "--ephemeral" in cmd and "--ignore-user-config" in cmd
    assert cmd[cmd.index("--model") + 1] == "gpt-6.1-sol"
    settings = [cmd[i + 1] for i, value in enumerate(cmd[:-1]) if value == "-c"]
    assert 'model_reasoning_effort="high"' in settings
    assert 'service_tier="default"' in settings
    assert sum(value.startswith("mcp_servers.") and ".command=" in value for value in settings) == 1
    assert any(
        value.endswith('=["--cli", "mcp", "--policy", ' + json.dumps(prepared["policy_path"]) + "]")
        for value in settings
    )
    assert "--sandbox" in cmd and cmd[cmd.index("--sandbox") + 1] == "read-only"


def test_prepare_is_exclusive_and_freshness_refuses_changed_inputs_or_prior_attempt(prepared):
    output = Path(prepared["output"])
    with pytest.raises(FileExistsError):
        QA.prepare(
            output=output, worker=Path(sys.executable), case="synthetic", allow_test_output=True
        )
    (output / "host-attempt.json").write_text("failed original attempt")
    with pytest.raises(AssertionError, match="already attempted"):
        QA.identity(output, unused=True)
    (output / "inputs/image.tif").write_bytes(b"changed")
    with pytest.raises(AssertionError, match="inputs changed"):
        QA.identity(output)


def test_source_and_policy_hashes_fail_closed_before_launch(prepared, monkeypatch):
    output = Path(prepared["output"])
    original = QA.sources_hashes
    monkeypatch.setattr(QA, "sources_hashes", lambda: {**original(), "unexpected.py": "f" * 64})
    with pytest.raises(AssertionError, match="source changed"):
        QA.identity(output)
    monkeypatch.setattr(QA, "sources_hashes", original)
    Path(prepared["policy_path"]).write_text("{}")
    with pytest.raises(AssertionError, match="policy changed"):
        QA.identity(output)


@pytest.mark.parametrize(
    "attack",
    [
        "sdk",
        "simulated",
        "shell",
        "server",
        "overlap",
        "changed_args",
        "missing_start",
        "tool_error",
        "payload_error",
        "failed_turn",
        "unfinished",
    ],
)
def test_host_transcript_rejects_substitutes_scope_errors_and_tool_failures(attack):
    events = transcript(event_call("action_guide", {}, {"actions": []}))
    if attack == "sdk":
        events[0]["event_origin"] = "python-mcp-sdk"
    elif attack == "simulated":
        events[0]["simulated"] = True
    elif attack == "shell":
        events[1]["item"]["type"] = "command_execution"
    elif attack == "server":
        events[1]["item"]["server"] = "another-service"
    elif attack == "overlap":
        events.insert(2, copy.deepcopy(events[1]))
    elif attack == "changed_args":
        events[2]["item"]["arguments"] = {"changed": True}
    elif attack == "missing_start":
        del events[1]
    elif attack == "tool_error":
        events[2]["item"]["result"]["isError"] = True
    elif attack == "payload_error":
        events[2]["item"]["result"]["structured_content"] = {"error": "failure"}
    elif attack == "failed_turn":
        events[-1]["type"] = "turn.failed"
    else:
        del events[2]
    with pytest.raises(AssertionError):
        QA.host_calls(events)


def test_owned_worker_polling_gate_waits_past_publication_and_replay():
    submitted = event_call(
        "submit_action",
        {"operation": "annotation_reference_run", "request": {}, "request_key": QA.CAPTURE_KEY},
        {"job": {"id": "job-1"}},
        identity="submit",
    )
    published = event_call(
        "job_status",
        {"job_id": "job-1"},
        {"job": {"id": "job-1", "state": "succeeded", "owned_worker_active": True}},
        identity="still-exiting",
    )
    exited = event_call(
        "job_status",
        {"job_id": "job-1"},
        {"job": {"id": "job-1", "state": "succeeded", "owned_worker_active": False}},
        identity="exited",
    )
    following = event_call("action_guide", {}, {"actions": []}, identity="following")
    with pytest.raises(AssertionError, match="before owned worker exit"):
        QA.host_calls(transcript(submitted, published, following))
    assert len(QA.host_calls(transcript(submitted, published, exited, following))) == 4


def test_graph_advance_enforces_same_native_worker_gate():
    graph = event_call(
        "workflow_graph_control",
        {"operation": "workflow_graph_advance", "request": {"run_id": "run-1"}},
        {
            "run": {
                "data": {
                    "nodes": {"morphology": {"state": "running", "intent": {"job_id": "job-2"}}}
                }
            }
        },
        identity="advance",
    )
    following = event_call(
        "workflow_graph_inspect",
        {"operation": "workflow_graph_status", "request": {"run_id": "run-1"}},
        {"state": "succeeded"},
        identity="status",
    )
    with pytest.raises(AssertionError, match="before owned worker exit"):
        QA.host_calls(transcript(graph, following))


def test_only_exact_planned_stale_update_error_is_accepted():
    request = {"task_id": "a" * 32, "expected_revision": 1}
    events = transcript(
        event_call(
            "agent_task_write",
            {"operation": "publish_plan", "request": request},
            {},
            identity="expected-stale",
        )
    )
    item = events[2]["item"]
    item["status"] = "failed"
    item["result"] = {
        "content": [
            {
                "type": "text",
                "text": (
                    "Error executing tool agent_task_write: The task revision changed. "
                    "Read the latest plan before editing."
                ),
            }
        ]
    }
    with pytest.raises(AssertionError):
        QA.host_calls(events)
    assert QA.host_calls(events, expected_stale_request=request)[0]["_expected_error"] is True
    wrong = {**request, "expected_revision": 2}
    with pytest.raises(AssertionError):
        QA.host_calls(events, expected_stale_request=wrong)
    item["result"]["content"][0]["text"] = (
        "Error executing tool agent_task_write: validation failed"
    )
    with pytest.raises(AssertionError):
        QA.host_calls(events, expected_stale_request=request)


def test_prepare_human_sync_does_not_launch_codex(tmp_path, monkeypatch):
    def no_launch(*unused, **kwargs):
        raise AssertionError("Preparation must not launch an external host")

    monkeypatch.setattr(QA.subprocess, "run", no_launch)
    prepared = QA.prepare(
        output=tmp_path / "human-sync",
        worker=Path(sys.executable),
        case="synthetic",
        allow_test_output=True,
        wait_for_human_edit=True,
    )
    fixture = prepared["fixture"]
    assert fixture["human_edit_goal"] == QA.HUMAN_EDIT_GOAL
    assert fixture["wait_for_human_edit"] is True
    prompt = Path(prepared["prompt_path"]).read_text()
    assert QA.HUMAN_EDIT_GOAL in prompt and "expected_revision=3" in prompt
    assert QA.TISSUE.study_sessions(Path(prepared["study"])) == []


def test_public_fixed_plane_preserves_raw_values_original_instance_ids_and_no_calibration(tmp_path):
    import tifffile

    if not all((QA.PUBLIC_ROOT / relative).is_file() for relative, _ in QA.PUBLIC_FILES.values()):
        pytest.skip("Authorized public originals are not present; no download requested")
    raw, reference, provenance = QA.arrays("fluorescence", tmp_path, QA.PUBLIC_ROOT)
    expected_raw = tifffile.imread(QA.PUBLIC_ROOT / QA.PUBLIC_FILES["image"][0])[124]
    expected_labels = tifffile.imread(QA.PUBLIC_ROOT / QA.PUBLIC_FILES["labels"][0])[124]
    np.testing.assert_array_equal(raw, expected_raw)
    np.testing.assert_array_equal(reference, expected_labels)
    assert set(np.unique(reference)) == set(np.unique(expected_labels))
    assert provenance["zero_based_z"] == 124 and provenance["physical_calibration"] is None
    assert provenance["stored_axes"] == "QYX" and provenance["author_declared_axes"] == "ZYX"


def test_session_exit_snapshot_distinguishes_native_reconciliation_without_rewriting(tmp_path):
    saved = {
        "session_id": "a" * 32,
        "state": "connected_idle",
        "private_pid": 2**31 - 1,
        "current_operation": None,
        "active_approval_id": None,
        "last_error": None,
        "updated_at": "2026-11-06T12:00:00+00:00",
        "ended_at": None,
        "disconnect_reason": None,
        "client_id": "codex-mcp-client",
    }
    QA.write_json(tmp_path / "session-at-exit.json", saved)
    metadata = {"session_sha256": QA.value_hash(saved)}
    current = {
        **saved,
        "state": "interrupted",
        "ended_at": "2026-11-06T12:01:00+00:00",
        "updated_at": "2026-11-06T12:01:00+00:00",
        "disconnect_reason": "MCP server process is no longer running",
    }
    snapshot, observed = QA.bind_exit_session(tmp_path, metadata, current)
    assert snapshot == saved and observed["native_reconciliation_observed"] is True
    assert observed["clean_disconnect_recorded"] is False
    assert QA.read_json(tmp_path / "session-at-exit.json") == saved
    QA.write_json(tmp_path / "session-at-exit.json", current)
    already_reconciled = {"session_sha256": QA.value_hash(current)}
    _, observed = QA.bind_exit_session(tmp_path, already_reconciled, current)
    assert observed["persisted_state"] == "interrupted"
    assert observed["clean_disconnect_recorded"] is False
    QA.write_json(tmp_path / "session-at-exit.json", saved)
    current["client_id"] = "different-client"
    with pytest.raises(AssertionError, match="outside native shutdown"):
        QA.bind_exit_session(tmp_path, metadata, current)


def test_independent_instance_oracle_preserves_original_ids_and_intersections():
    reference = np.array([[7, 7, 0, 42], [7, 0, 0, 42]], np.uint32)
    prediction = np.array([[1, 1, 0, 2], [0, 0, 0, 2]], np.uint32)
    oracle = QA.independent_agreement(prediction, reference)
    assert oracle["intersection_pixels"] == 4 and oracle["union_pixels"] == 5
    assert oracle["reference_count"] == oracle["prediction_count"] == 2
    assert oracle["scores"]["0.5"] == {
        "true_positive": 2,
        "false_positive": 0,
        "false_negative": 0,
    }
    assert oracle["scores"]["0.75"] == {
        "true_positive": 1,
        "false_positive": 1,
        "false_negative": 1,
    }


def test_public_fixture_refuses_hash_mismatch_without_download(tmp_path):
    output = tmp_path / "derived"
    output.mkdir()
    for relative, _ in QA.PUBLIC_FILES.values():
        path = tmp_path / "originals" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"unverified input")
    with pytest.raises(AssertionError, match="original hash mismatch"):
        QA.arrays("fluorescence", output, tmp_path / "originals")
    assert list(output.iterdir()) == []


@pytest.mark.parametrize("case", ["synthetic", "fluorescence"])
def test_native_composed_workflow_terminal_labels_agree_with_independent_oracle(tmp_path, case):
    from loci_engine.research_jobs import run_job, submit_job
    from loci_engine.research_workflow_graph import execute_workflow_graph

    if case == "fluorescence" and not all(
        (QA.PUBLIC_ROOT / relative).is_file() for relative, _ in QA.PUBLIC_FILES.values()
    ):
        pytest.skip("Authorized public originals unavailable; no download requested")
    prepared = QA.prepare(
        output=tmp_path / "native-composition",
        worker=Path(sys.executable),
        case=case,
        allow_test_output=True,
    )

    project = ResearchProject(prepared["study"])
    wb = Workbench(project)

    def native(operation, request):
        return execute_workflow_graph(
            wb,
            operation,
            request,
            authorize=lambda *unused: None,
            authorize_binding=lambda *unused: None,
        )

    try:
        capture = submit_job(
            wb,
            prepared["fixture"]["capture_request"],
            "native-unit-reference",
            operation="annotation_reference_run",
        )
        run_job(wb, capture["id"])
        capture = project.job(capture["id"])
        assert capture["state"] == "succeeded"
        captured = project.result(capture["result_ids"][0])
        rectangle = project.load_array(captured["arrays"]["labels"])
        expected = np.zeros_like(rectangle)
        expected[4:12, 4:12] = 1
        np.testing.assert_array_equal(rectangle, expected)
        request = prepared["fixture"]["graph_binding"]
        plan = native("workflow_graph_preflight", request)["plan"]
        run = native(
            "workflow_graph_start",
            {**request, "plan_sha256": plan["plan_sha256"], "request_key": "unit-native-graph"},
        )["run"]
        for _ in range(2):
            run = native("workflow_graph_advance", {"run_id": run["id"]})["run"]
            pending = [
                node["intent"]["job_id"]
                for node in run["data"]["nodes"].values()
                if node.get("state") in {"queued", "running"}
            ]
            assert len(pending) == 1
            run_job(wb, pending[0])
        run = native("workflow_graph_advance", {"run_id": run["id"]})["run"]
        assert run["data"]["state"] == "succeeded"
        terminal = project.result(run["data"]["outputs"]["agreement"]["result_id"])
        prediction = project.load_array(terminal["arrays"]["labels"])
        reference = project.load_array(terminal["arrays"]["reference_labels"])
        report = wb.execute(
            "annotation_evaluation_get", {**QA.binding(terminal), "table": "summary"}
        )
        metrics = report["annotation_evaluation"]["metrics"]
        oracle = QA.verify_metrics(metrics, prediction, reference)
        if case == "synthetic":
            assert oracle["intersection_pixels"] == 112
        corrupt = copy.deepcopy(metrics)
        corrupt["region"]["iou"] = -1
        with pytest.raises(AssertionError, match="ratio oracle"):
            QA.verify_metrics(corrupt, prediction, reference)
        corrupt = copy.deepcopy(metrics)
        corrupt["instances"]["scores"][0]["true_positive"] += 1
        with pytest.raises(AssertionError, match="instance assignment"):
            QA.verify_metrics(corrupt, prediction, reference)
        assert project.review_state(terminal["id"]) is None
    finally:
        wb.close()
