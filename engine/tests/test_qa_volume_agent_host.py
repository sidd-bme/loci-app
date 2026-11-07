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


def test_policy_denial_accepts_only_the_exact_public_boundary_message():
    message = "Error executing tool volume_view: " + QA.POLICY_DENIAL
    assert QA.is_policy_denial("volume_view", message)
    assert not QA.is_policy_denial("set_volume_view", message)
    assert not QA.is_policy_denial("volume_view", message + " /private/source.tif")
    assert not QA.is_policy_denial(
        "volume_view", "Error executing tool volume_view: exceeds policy"
    )
    assert not QA.is_policy_denial(
        "volume_view", "Error executing tool volume_view: The research operation failed validation."
    )


def test_human_cas_token_preserves_all_five_fields_without_presence_metadata():
    token = {
        "view_id": "gui-view",
        "renderer_generation": 2,
        "live_epoch": 25,
        "revision": 19,
        "display_revision": 3,
    }
    view = {
        "live": {
            **token,
            "source_id": "source",
            "source_sha256": "hash",
            "busy": False,
            "available": True,
        }
    }
    assert QA.scene_live_token(view) == token
    for key in token:
        missing = copy.deepcopy(view)
        missing["live"].pop(key)
        with pytest.raises(KeyError):
            QA.scene_live_token(missing)


def denial_policy_fixture():
    prepared = {
        "source_id": "a" * 32,
        "source_sha256": "b" * 64,
        "expected_t": 1,
        "expected_channels": [0, 1],
    }
    dimensions = {"x": 64, "y": 48, "z": 3, "c": 2, "t": 2}
    main = {
        "sources": [
            {
                "id": prepared["source_id"],
                "sha256": prepared["source_sha256"],
                "crop": {"x": 0, "y": 0, "width": 64, "height": 48},
                "t": [1],
                "c": [0, 1],
                "z": [0, 1, 2],
                "level": [0],
                "measurement_channels": [0, 1],
            }
        ],
        "operations": ["volume_view", "set_volume_view", "volume_view_image"],
        "disclosures": ["geometry", "provenance", "agent_metadata", "previews"],
        "volume_views": {"read": True, "write": True, "image": True, "fields": ["clipping"]},
    }
    policies = {QA.MAIN: main, QA.CROP: copy.deepcopy(main), QA.CHANNEL: copy.deepcopy(main)}
    for server in (QA.CROP, QA.CHANNEL):
        policies[server]["operations"] = ["volume_view"]
        policies[server]["volume_views"] = {
            "read": True,
            "write": False,
            "image": False,
            "fields": [],
        }
    policies[QA.CROP]["sources"][0]["crop"]["width"] = 63
    policies[QA.CHANNEL]["sources"][0]["c"] = [1]
    return prepared, policies, dimensions


def test_generic_policy_refusals_require_independently_pinned_scope_restrictions():
    QA.verify_denial_policies(*denial_policy_fixture())


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p[QA.MAIN]["volume_views"]["fields"].append("t"),
        lambda p: p[QA.CROP]["sources"][0]["crop"].update(width=64),
        lambda p: p[QA.CHANNEL]["sources"][0].update(c=[0, 1]),
        lambda p: p[QA.CHANNEL]["sources"][0].update(id="c" * 32),
        lambda p: p[QA.CROP]["operations"].clear(),
        lambda p: p[QA.CROP]["disclosures"].clear(),
    ],
)
def test_scope_denial_cannot_be_inferred_from_wrong_or_unrelated_policy(mutation):
    prepared, policies, dimensions = denial_policy_fixture()
    mutation(policies)
    with pytest.raises(AssertionError):
        QA.verify_denial_policies(prepared, policies, dimensions)


def correction_evidence_fixture():
    from types import SimpleNamespace

    parent = {"result_id": "a" * 32, "revision_hash": "b" * 64, "label_sha256": "c" * 64}
    child = {
        "id": "d" * 32,
        "revision_hash": "e" * 64,
        "source_id": "f" * 32,
        "source_sha256": "1" * 64,
        "parent_id": parent["result_id"],
    }
    prepared = {
        "allow_correction": True,
        "result_binding": parent,
        "target_label": 4294967295,
        "source_id": child["source_id"],
        "source_sha256": child["source_sha256"],
        "correction_request": {
            "result_id": parent["result_id"],
            "revision_hash": parent["revision_hash"],
            "operations": [
                {
                    "op": "delete",
                    "label": 4294967295,
                    "expected_input_sha256": parent["label_sha256"],
                }
            ],
            "working_bytes": QA.MEMORY,
        },
        "policies": {QA.MAIN: {"sha256": "2" * 64}},
    }
    submitted = {"id": "3" * 32, "request_hash": "4" * 64, "state": "queued", "result_ids": []}
    job = {
        **submitted,
        "state": "succeeded",
        "result_ids": [child["id"]],
        "owned_worker_active": False,
    }
    persisted = {
        **job,
        "operation": "correct_result",
        "request": {"task_request": prepared["correction_request"]},
        "owner": {"policy_sha256": "2" * 64, "session_id": "session"},
    }
    parent_info = {**parent, "shape": [12, 48, 64], "label_ids": [17, 65536, 4294967295]}
    child_info = {
        "result_id": child["id"],
        "revision_hash": child["revision_hash"],
        "parent_id": parent["result_id"],
        "label_sha256": "5" * 64,
        "shape": parent_info["shape"],
        "label_ids": [17, 65536],
    }

    def call(tool, arguments, response):
        return {
            "tool": tool,
            "server": QA.MAIN,
            "arguments": copy.deepcopy(arguments),
            "result": {"structured_content": copy.deepcopy(response)},
        }

    request = {"operation": "correct_result", "request": prepared["correction_request"]}
    calls = [
        call(
            "inspect_action",
            {
                "operation": "correction_info",
                "request": {
                    "result_id": parent["result_id"],
                    "revision_hash": parent["revision_hash"],
                },
            },
            parent_info,
        ),
        call("validate_action", request, {**request, "authorized": True}),
        call(
            "submit_action", {**request, "request_key": "volume-host-delete-v1"}, {"job": submitted}
        ),
        call("job_status", {"job_id": submitted["id"]}, {"job": job}),
        call(
            "result",
            {"result_id": child["id"], "offset": 0, "limit": 1},
            {"result": {**child, "review": None}},
        ),
        call(
            "inspect_action",
            {
                "operation": "correction_info",
                "request": {"result_id": child["id"], "revision_hash": child["revision_hash"]},
            },
            child_info,
        ),
    ]
    project = SimpleNamespace(
        result=lambda *_a, **_kw: child,
        job=lambda _identity: persisted,
        review_state=lambda _identity: None,
    )
    return prepared, calls, project, child_info


def test_correction_child_metadata_is_bound_to_submitted_inactive_successful_job():
    prepared, calls, project, child_info = correction_evidence_fixture()
    assert "result" in QA.TOOLS
    assert "review" not in project.result("unused")  # Raw immutable records keep review separately.
    assert QA.verify_correction_calls(prepared, calls, project, "session") == {
        key: child_info[key] for key in ("result_id", "revision_hash", "label_sha256")
    }


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p, c, _: p.update(allow_correction=False),
        lambda _, c, _p: c[4].update(server=QA.CROP),
        lambda _, c, _p: c[4]["arguments"].update(limit=100),
        lambda p, c, _: c[4]["arguments"].update(result_id=p["result_binding"]["result_id"]),
        lambda _, c, _p: c[3]["arguments"].update(job_id="6" * 32),
        lambda _, c, _p: c[3]["result"]["structured_content"]["job"].update(
            owned_worker_active=True
        ),
        lambda _, c, _p: c[3]["result"]["structured_content"]["job"].update(request_hash="6" * 64),
        lambda _, c, _p: c[4]["result"]["structured_content"]["result"].update(source_id="6" * 32),
        lambda _, c, _p: c[4]["result"]["structured_content"]["result"].update(parent_id="6" * 32),
        lambda _, c, _p: c[4]["result"]["structured_content"]["result"].update(
            revision_hash="6" * 64
        ),
        lambda _, c, _p: c[5]["result"]["structured_content"].update(
            label_ids=[17, 65536, 4294967295]
        ),
        lambda _, c, _p: c[5]["result"]["structured_content"].update(label_ids=[17]),
        lambda _, c, _p: c[5]["arguments"]["request"].update(revision_hash="6" * 64),
        lambda _, c, _p: c.append(copy.deepcopy(c[4])),
        lambda _, c, _p: c.__setitem__(slice(3, 5), [c[4], c[3]]),
        lambda _, _c, p: p.job("")["owner"].update(session_id="other-session"),
    ],
)
def test_correction_verifier_refuses_unrelated_or_incomplete_child_evidence(mutation):
    prepared, calls, project, _ = correction_evidence_fixture()
    mutation(prepared, calls, project)
    with pytest.raises(AssertionError):
        QA.verify_correction_calls(prepared, calls, project, "session")


def test_correction_prompt_requires_exact_bounded_child_read_before_inspection():
    prepared, _, _, _ = correction_evidence_fixture()
    prepared.update(
        {
            key: None
            for key in (
                "case",
                "probe_source_xyz",
                "expected_t",
                "expected_channels",
                "positive_patch",
                "limits",
            )
        }
    )
    text = QA.prompt(prepared, "correction")
    assert "offset=0,limit=1" in text
    assert "use the returned revision_hash" in text
    assert "job_status supplies IDs, never child revisions" in text


def test_corrected_scene_requires_child_capture_and_exact_rendered_scene_patch():
    prepared, calls, project, _ = correction_evidence_fixture()
    binding = QA.verify_correction_calls(prepared, calls, project, "session")
    state = {"result": binding, "selected_object": None}
    final = {"state": state}
    writes = [{"status": "complete", "proposed_state": state}]
    scene_call = {"tool": "set_volume_view", "arguments": {"request": {"patch": state}}}
    images = [{"rendering": {"manifest": {"state": state}}}]
    QA.verify_corrected_scene(binding, final, writes, calls + [scene_call], images)
    parent_capture = copy.deepcopy(images)
    parent_capture[0]["rendering"]["manifest"]["state"]["result"] = prepared["result_binding"]
    with pytest.raises(AssertionError, match="corrected-child GUI capture"):
        QA.verify_corrected_scene(binding, final, writes, calls + [scene_call], parent_capture)
    wrong_patch = copy.deepcopy(scene_call)
    wrong_patch["arguments"]["request"]["patch"]["clipping"] = {"enabled": False}
    with pytest.raises(AssertionError, match="unrelated scene fields"):
        QA.verify_corrected_scene(binding, final, writes, calls + [wrong_patch], images)
