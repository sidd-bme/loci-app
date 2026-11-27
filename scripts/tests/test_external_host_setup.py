import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "qa" / "external-host-setup.py"
SPEC = importlib.util.spec_from_file_location("external_host_setup", SCRIPT)
assert SPEC and SPEC.loader
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


def test_antigravity_executes_with_scoped_discovery_and_no_credit_overage(
    tmp_path, monkeypatch
):
    server = "loci-research-123456789abc"
    workspace = tmp_path / "bundle/antigravity-workspace"
    config = workspace / ".agents/mcp_config.json"
    config.parent.mkdir(parents=True)
    config.write_text(
        json.dumps({"mcpServers": {server: {"command": "/fixture/worker"}}})
    )
    manifest = workspace / ".agents/plugins/loci-study/plugin.json"
    home = tmp_path / "host home"
    monkeypatch.setattr(host, "run_command", lambda *args: 0)

    cwd, connection, command, readable = host.antigravity_command(
        "agy",
        "claude-sonnet-4-6",
        tmp_path,
        {
            "antigravity_workspace": str(workspace.relative_to(tmp_path)),
            "antigravity_config_filename": str(config.relative_to(tmp_path)),
            "antigravity_plugin_filename": str(manifest.relative_to(tmp_path)),
        },
        "Execute the synthetic check",
        tmp_path,
        {"HOME": str(home)},
    )
    settings = json.loads(command[command.index("--settings") + 1])
    discovery = home / ".gemini/antigravity-cli/mcp" / server
    assert cwd == workspace and connection == server
    assert command[command.index("--mode") + 1] == "accept-edits"
    assert settings["useG1Credits"] is False
    assert readable == {
        manifest.parent / "skills/loci-analysis/SKILL.md",
        discovery / "instructions.md",
        *(discovery / f"{tool}.json" for tool in host.TOOLS),
    }
    assert set(settings["permissions"]["allow"]) == {
        *(f"read_file({path})" for path in readable),
        *(f"mcp({server}/{tool})" for tool in host.TOOLS),
    }
    assert "write_file(*)" in settings["permissions"]["deny"]


def test_antigravity_audits_mcp_calls_separately_from_allowed_context_reads(tmp_path):
    skill = tmp_path / "SKILL.md"
    transcript = tmp_path / "host.ndjson"

    def event(name, parameters, output):
        return {
            "event": "step_update",
            "step_update": {
                "tool_name": name,
                "step_type": "tool",
                "state": "DONE",
                "tool_info": {"parameters": parameters, "output": output},
            },
        }

    def write(path):
        transcript.write_text(
            "\n".join(
                json.dumps(item)
                for item in [
                    event("read_file", {"Path": str(path)}, "generated skill"),
                    event("update_steps", {"steps": []}, ""),
                    event(
                        "call_mcp_tool",
                        {"ServerName": "fixture", "ToolName": "inspect_source"},
                        '{"verified":true}',
                    ),
                ]
            )
        )

    write(skill)
    assert host.host_calls(transcript, "antigravity", "fixture", readable={skill}) == [
        ("inspect_source", {"verified": True})
    ]
    write(tmp_path / "agent-policy.json")
    with pytest.raises(RuntimeError, match="outside the generated skill"):
        host.host_calls(transcript, "antigravity", "fixture", readable={skill})
