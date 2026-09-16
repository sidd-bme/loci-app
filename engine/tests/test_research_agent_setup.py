import json
import os
import sys
import tomllib

import pytest
from test_agent_policy import make_study

from loci_engine.agent_policy import load_policy
from loci_engine.research_agent_setup import create_agent_access
from loci_engine.research_mcp import PolicyAgent


def access_request(request, **changes):
    return {
        **request,
        "allow_preview": False,
        "allow_run": True,
        "allow_export": False,
        "export_names": [],
        "disclosures": [],
        "limits": {"cpu_seconds": 60, "memory_bytes": 8 * 1024**3, "concurrency": 1},
        **changes,
    }


def test_private_access_bundle_is_exact_usable_and_revocable(tmp_path):
    workbench, source, request = make_study(tmp_path)
    destination = tmp_path / "access"
    receipt = create_agent_access(workbench, access_request(request), destination)
    assert str(tmp_path) not in json.dumps(receipt)
    assert receipt["source_id"] == source["id"]
    assert receipt["disclosures"] == []
    assert "export_result" not in receipt["operations"]
    assert "preview_recipe" not in receipt["operations"]
    policy = load_policy(destination / "agent-policy.json")
    agent = PolicyAgent(policy)
    assert agent.inspect_source(source["id"]) == {"source_id": source["id"], "verified": True}
    approved = json.loads((destination / "approved-request.json").read_text())
    assert agent.validate_recipe(approved)["approved"] == {"preview": False, "run": True}
    altered = json.loads(json.dumps(approved))
    altered["recipe"]["segmentation"]["threshold"] += 1
    assert agent.validate_recipe(altered)["approved"]["run"] is False
    with pytest.raises(PermissionError, match="exact approved"):
        agent._validate(workbench, altered, "run")
    outside = {**approved, "selection": {**approved["selection"], "t": 1}}
    with pytest.raises(PermissionError, match="axes"):
        agent.validate_recipe(outside)
    config = json.loads((destination / "mcp-config.json").read_text())["mcpServers"][
        "loci-research"
    ]
    assert config["command"] == sys.executable
    assert config["args"][-1] == str(destination / "agent-policy.json")
    codex = tomllib.loads((destination / "codex-config.toml").read_text())["mcp_servers"][
        "loci-research"
    ]
    assert codex == config
    if os.name == "posix":
        assert destination.stat().st_mode & 0o777 == 0o700
        assert all(item.stat().st_mode & 0o777 == 0o600 for item in destination.iterdir())
    original = (destination / "mcp-config.json").read_bytes()
    with pytest.raises(ValueError, match="absent"):
        create_agent_access(workbench, access_request(request), destination)
    assert (destination / "mcp-config.json").read_bytes() == original
    (destination / "agent-policy.json").unlink()
    with pytest.raises((PermissionError, ValueError)):
        agent.catalog()


@pytest.mark.parametrize(
    "change",
    [
        {"allow_preview": True},
        {"allow_export": True, "export_names": ["approved"]},
        {"export_names": ["covert-export"]},
        {"allow_run": "true"},
        {"limits": {"cpu_seconds": 60, "memory_bytes": 64 * 1024**2, "concurrency": 1}},
        {"disclosures": ["unknown"]},
    ],
)
def test_invalid_authority_never_publishes(tmp_path, change):
    workbench, _, request = make_study(tmp_path)
    with pytest.raises(ValueError):
        create_agent_access(workbench, access_request(request, **change), tmp_path / "access")
    assert not (tmp_path / "access").exists()
    assert not list(tmp_path.glob(".loci-agent-access-*"))


def test_frozen_config_and_named_export_remain_local(tmp_path, monkeypatch):
    workbench, _, request = make_study(tmp_path)
    export = tmp_path / "exports"
    export.mkdir()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            allow_export=True,
            export_names=["approved"],
            disclosures=["geometry", "source_names", "previews", "measurements", "provenance"],
        ),
        tmp_path / "access",
        export,
    )
    policy = load_policy(tmp_path / "access" / "agent-policy.json")
    assert policy.export_filenames == {"approved"}
    config = json.loads((tmp_path / "access" / "mcp-config.json").read_text())["mcpServers"][
        "loci-research"
    ]
    assert config["args"][:2] == ["--cli", "mcp"]
    assert "cwd" not in config
    assert str(export) not in json.dumps(receipt)
    inspected = PolicyAgent(policy).inspect_source(source_id=request["source_id"])
    assert inspected["name"] == "untrusted source name"
    assert [item["index"] for item in inspected["channel_declarations"]] == [0]
    assert inspected["permitted_scope"]["z"] == [0, 1, 2, 3]
    assert str(tmp_path) not in json.dumps(inspected)
    assert "source_sha256" not in inspected
