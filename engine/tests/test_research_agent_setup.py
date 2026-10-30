import asyncio
import json
import os
import sys
import tomllib
from pathlib import Path

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from test_agent_policy import make_study

from loci_engine import research_agent_setup
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


def test_explicit_delegation_creates_named_review_authority_and_plugin(tmp_path):
    workbench, _, request = make_study(tmp_path)
    destination = tmp_path / "delegated"
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            allow_run=False,
            disclosures=["agent_metadata"],
            delegation={
                "client_id": "codex",
                "expires_at": None,
                "result_scope": "granted-sources",
                "allow_review": True,
            },
        ),
        destination,
    )
    assert receipt["schema"] == "loci.agent-policy/v4"
    assert receipt["delegation"]["client_id"] == "codex"
    assert set(receipt["operations"]) == {
        "inspect_source",
        "validate_recipe",
        "analysis_context",
        "result",
        "review_history",
        "review_result",
        "study_results",
    }
    policy = load_policy(destination / "agent-policy.json")
    assert policy.delegation == receipt["delegation"]
    assert (destination / receipt["plugin_filename"]).is_file()
    assert "agent decisions" in (destination / "README.txt").read_text()
    changed = {
        **request,
        "recipe": {**request["recipe"], "segmentation": {"method": "components", "threshold": 70}},
    }
    result = workbench.run_recipe(changed)["result"]
    from test_agent_review import decision

    reviewed = PolicyAgent(policy).review_result(decision(result))["review"]
    assert reviewed["actor"] == "agent" and reviewed["actor_id"] == "codex"


@pytest.mark.parametrize("allow_run", [False, True])
def test_graph_access_is_explicit_and_does_not_add_native_actions(tmp_path, allow_run):
    from loci_engine.agent_policy import DISCLOSURES

    workbench, _, request = make_study(tmp_path)
    destination = tmp_path / "graph-access"
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            allow_run=allow_run,
            allow_workflow_graph=True,
            disclosures=sorted(DISCLOSURES),
            delegation={
                "client_id": "codex",
                "expires_at": None,
                "result_scope": "granted-sources",
                "allow_review": False,
            },
            actions=[],
        ),
        destination,
    )
    assert "workflow_graph_inspect" in receipt["operations"]
    assert ("workflow_graph_control" in receipt["operations"]) is allow_run
    assert not load_policy(destination / "agent-policy.json").actions


@pytest.mark.parametrize(
    "changes",
    [
        {"allow_workflow_graph": "yes"},
        {"allow_workflow_graph": True},
        {
            "allow_workflow_graph": True,
            "delegation": {
                "client_id": "codex",
                "expires_at": None,
                "result_scope": "pinned-recipes",
                "allow_review": False,
            },
            "disclosures": ["agent_metadata"],
        },
    ],
)
def test_incomplete_graph_scope_does_not_publish_access(tmp_path, changes):
    workbench, _, request = make_study(tmp_path)
    destination = tmp_path / "invalid-graph"
    with pytest.raises(ValueError):
        create_agent_access(workbench, access_request(request, **changes), destination)
    assert not destination.exists()


@pytest.mark.parametrize(
    "change",
    [
        {"client_id": ""},
        {"expires_at": "2020-01-01T00:00:00+00:00"},
        {"expires_at": "2099-01-01"},
        {"allow_review": "yes"},
        {"result_scope": "all-files"},
        {"actor": "human"},
    ],
)
def test_invalid_delegation_never_publishes(tmp_path, change):
    workbench, _, request = make_study(tmp_path)
    destination = tmp_path / "invalid"
    with pytest.raises((ValueError, PermissionError)):
        create_agent_access(
            workbench,
            access_request(
                request,
                disclosures=["agent_metadata"],
                delegation={
                    "client_id": "codex",
                    "expires_at": None,
                    "result_scope": "pinned-recipes",
                    "allow_review": True,
                    **change,
                },
            ),
            destination,
        )
    assert not destination.exists()


def test_private_access_bundle_is_exact_usable_and_revocable(tmp_path):
    workbench, source, request = make_study(tmp_path)
    destination = tmp_path / "access"
    receipt = create_agent_access(workbench, access_request(request), destination)
    assert receipt["schema"] == "loci.agent-policy/v1"
    assert set(receipt) == {
        "schema",
        "policy_sha256",
        "project_id",
        "recipe_sha256",
        "policy_filename",
        "config_filename",
        "disclosures",
        "operations",
        "source_id",
        "selection",
    }
    assert {item.name for item in destination.iterdir()} == {
        "agent-policy.json",
        "mcp-config.json",
        "codex-config.toml",
        "approved-request.json",
        "README.txt",
    }
    document = json.loads((destination / "agent-policy.json").read_text())
    assert "remote_grants" not in document and "experimental_recipes" not in document
    assert "analysis_context" not in receipt["operations"]
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


def test_new_access_bundle_grants_context_only_with_explicit_metadata_disclosure(tmp_path):
    workbench, source, request = make_study(tmp_path)
    destination = tmp_path / "context-access"
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            disclosures=["agent_metadata"],
        ),
        destination,
    )
    assert "analysis_context" in receipt["operations"]
    agent = PolicyAgent(load_policy(destination / "agent-policy.json"))
    context = agent.analysis_context()
    assert context["source_grants"] == [
        {"source_id": source["id"], "source_sha256": source["sha256"]}
    ]
    assert context["recipe_grants"][0]["run"] is True
    assert context["recipe_grants"][0]["preview"] is False
    assert "name" not in context["source_grants"][0]
    assert "permitted_scope" not in context["source_grants"][0]
    assert str(tmp_path) not in json.dumps(context)


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


def interactive_request(**changes):
    return {
        "allow_image": False,
        "allow_display": False,
        "allow_handoff": False,
        "channels": [],
        "handoff_names": [],
        "parameters": {},
        **changes,
    }


METADATA = ["geometry", "provenance", "agent_metadata"]


def test_interactive_bundle_scopes_images_ranges_and_portable_plugin(tmp_path):
    workbench, source, request = make_study(tmp_path)
    destination = tmp_path / "interactive"
    request["recipe"]["segmentation"]["min_size"] = 0
    value = access_request(
        request,
        allow_preview=True,
        disclosures=[*METADATA, "previews"],
        interactive=interactive_request(
            allow_image=True,
            allow_display=True,
            channels=[1],
            parameters={"threshold": {"min": 40, "max": 80}, "min_size": {"min": 0, "max": 100}},
        ),
    )
    receipt = create_agent_access(workbench, value, destination)
    assert receipt["schema"] == "loci.agent-policy/v3"
    assert receipt["plugin_filename"] == "plugin/plugin.json"
    assert {"source_image", "source_display", "set_source_display"} <= set(receipt["operations"])
    assert "export_vision_handoff" not in receipt["operations"]
    assert str(tmp_path) not in json.dumps(receipt)
    document = json.loads((destination / "agent-policy.json").read_text())
    assert document["remote_grants"] == []
    assert document["sources"][0]["c"] == [0, 1]
    assert document["sources"][0]["measurement_channels"] == [0]
    approved = json.loads((destination / "approved-request.json").read_text())
    assert document["experimental_recipes"] == [
        {
            "key": "interactive-recipe",
            **approved,
            "parameters": value["interactive"]["parameters"],
            "preview": True,
            "run": True,
        }
    ]
    assert document["recipes"] == [
        {"sha256": receipt["recipe_sha256"], "preview": True, "run": True}
    ]
    agent = PolicyAgent(load_policy(destination / "agent-policy.json"))
    changed = json.loads(json.dumps(approved))
    changed["recipe"]["segmentation"].update(threshold=80, min_size=100)
    assert agent.validate_recipe(changed)["approved"]["run"] is True
    changed["recipe"]["segmentation"]["threshold"] = 80.01
    assert agent.validate_recipe(changed)["approved"]["run"] is False
    with pytest.raises(PermissionError):
        agent._validate(workbench, changed, "run")
    changed = json.loads(json.dumps(approved))
    changed["recipe"]["measurement_channels"] = [1]
    with pytest.raises(PermissionError):
        agent.validate_recipe(changed)
    plugin = json.loads((destination / "plugin/plugin.json").read_text())
    assert plugin["name"] == "loci-analysis"
    assert plugin["$schema"].endswith("/plugin.schema.json")
    assert "hooks" not in plugin["extensions"]["com.openai"]
    mcp = json.loads((destination / "plugin/mcp.json").read_text())
    manual = json.loads((destination / "mcp-config.json").read_text())
    stdio = manual["mcpServers"]["loci-research"]
    assert mcp["mcpServers"]["loci-research"] == {
        "type": "stdio",
        **{key: value for key, value in stdio.items() if key != "cwd"},
        "cwd": "${PLUGIN_ROOT}",
        "env": {"PYTHONPATH": str(Path(stdio["cwd"]) / "src")},
    }
    assert mcp["mcpServers"]["loci-research"]["args"][-1] == str(destination / "agent-policy.json")
    marketplace = json.loads((destination / ".agents/plugins/marketplace.json").read_text())
    assert marketplace["plugins"][0]["source"] == {"source": "local", "path": "./plugin"}
    assert marketplace["plugins"][0]["policy"]["installation"] == "AVAILABLE"
    assert (destination / "plugin/skills/loci-analysis/SKILL.md").is_file()
    if os.name == "posix":
        for item in destination.rglob("*"):
            assert item.stat().st_mode & 0o777 == (0o700 if item.is_dir() else 0o600)
    assert source["id"] == approved["source_id"]


def test_handoff_is_independent_of_run_and_reviewed_export(tmp_path):
    workbench, _, request = make_study(tmp_path)
    export = tmp_path / "exports"
    export.mkdir()
    destination = tmp_path / "handoff"
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            allow_run=False,
            disclosures=[*METADATA, "previews"],
            interactive=interactive_request(
                allow_handoff=True, channels=[1], handoff_names=["sample.loci-vision"]
            ),
        ),
        destination,
        export,
    )
    assert "export_vision_handoff" in receipt["operations"]
    assert {"submit_recipe", "export_result", "source_image"}.isdisjoint(receipt["operations"])
    policy = load_policy(destination / "agent-policy.json")
    assert policy.export_filenames == {"sample.loci-vision"}
    document = json.loads((destination / "agent-policy.json").read_text())
    assert document["experimental_recipes"] == []


def test_display_grant_needs_metadata_but_not_image_disclosure(tmp_path):
    workbench, _, request = make_study(tmp_path)
    receipt = create_agent_access(
        workbench,
        access_request(
            request,
            disclosures=METADATA,
            interactive=interactive_request(allow_display=True, channels=[0]),
        ),
        tmp_path / "display",
    )
    assert {"source_display", "set_source_display"} <= set(receipt["operations"])
    assert "source_image" not in receipt["operations"]
    assert "previews" not in receipt["disclosures"]


@pytest.mark.parametrize(
    "change",
    [
        {"allow_image": 1},
        {"allow_display": "true"},
        {"allow_handoff": None},
        {"channels": [0]},
        {"allow_image": True, "channels": []},
        {"allow_image": True, "channels": [True]},
        {"allow_image": True, "channels": [0.0]},
        {"allow_image": True, "channels": [0, 0]},
        {"allow_image": True, "channels": [1, 0]},
        {"allow_image": True, "channels": [-1]},
        {"allow_image": True, "channels": [2]},
        {"allow_image": True, "channels": list(range(17))},
        {"channels": "0"},
        {"handoff_names": ["sample.loci-vision"]},
        {"allow_handoff": True, "channels": [0], "handoff_names": []},
        {"allow_handoff": True, "channels": [0], "handoff_names": ["sample.zip"]},
        {"allow_handoff": True, "channels": [0], "handoff_names": ["../sample.loci-vision"]},
        {
            "allow_handoff": True,
            "channels": [0],
            "handoff_names": ["sample.loci-vision", "sample.loci-vision"],
        },
        {"parameters": []},
        {"parameters": {"working_bytes": {"min": 1, "max": 2}}},
        {"parameters": {"threshold": {"min": 0}}},
        {"parameters": {"threshold": {"min": 0, "max": 100, "step": 1}}},
        {"parameters": {"threshold": {"min": 80, "max": 40}}},
        {"parameters": {"threshold": {"min": 51, "max": 80}}},
        {"parameters": {"threshold": {"min": False, "max": 80}}},
        {"parameters": {"threshold": {"min": float("nan"), "max": 80}}},
        {"parameters": {"threshold": {"min": 0, "max": float("inf")}}},
        {"parameters": {"min_size": {"min": -1, "max": 100}}},
        {"parameters": {"min_size": {"min": 0, "max": 100}}},
        {"unknown": True},
    ],
)
def test_invalid_interactive_grants_never_publish(tmp_path, change):
    workbench, _, request = make_study(tmp_path)
    export = tmp_path / "exports"
    export.mkdir()
    with pytest.raises(ValueError):
        create_agent_access(
            workbench,
            access_request(
                request,
                disclosures=[*METADATA, "previews"],
                interactive=interactive_request(**change),
            ),
            tmp_path / "access",
            export if change.get("allow_handoff") is True else None,
        )
    assert not (tmp_path / "access").exists()
    assert not list(tmp_path.glob(".loci-agent-access-*"))


@pytest.mark.parametrize(
    "operation,required",
    [
        ("allow_image", ["previews"]),
        ("allow_display", METADATA),
        ("allow_handoff", [*METADATA, "previews"]),
        ("parameters", METADATA),
    ],
)
def test_each_interactive_disclosure_is_required(tmp_path, operation, required):
    workbench, _, request = make_study(tmp_path)
    export = tmp_path / "exports"
    export.mkdir()
    for missing in required:
        interactive = interactive_request(
            **(
                {"parameters": {"threshold": {"min": 40, "max": 80}}}
                if operation == "parameters"
                else {operation: True, "channels": [0]}
            )
        )
        if operation == "allow_handoff":
            interactive["handoff_names"] = ["sample.loci-vision"]
        with pytest.raises(ValueError):
            create_agent_access(
                workbench,
                access_request(
                    request,
                    disclosures=[item for item in required if item != missing],
                    interactive=interactive,
                ),
                tmp_path / "access",
                export if operation == "allow_handoff" else None,
            )
        assert not (tmp_path / "access").exists()


def test_range_requires_execution_and_handoff_requires_chosen_root(tmp_path):
    workbench, _, request = make_study(tmp_path)
    with pytest.raises(ValueError, match="preview or run"):
        create_agent_access(
            workbench,
            access_request(
                request,
                allow_run=False,
                disclosures=METADATA,
                interactive=interactive_request(parameters={"threshold": {"min": 40, "max": 80}}),
            ),
            tmp_path / "access",
        )
    with pytest.raises(ValueError, match="chosen local export"):
        create_agent_access(
            workbench,
            access_request(
                request,
                disclosures=[*METADATA, "previews"],
                interactive=interactive_request(
                    allow_handoff=True, channels=[0], handoff_names=["sample.loci-vision"]
                ),
            ),
            tmp_path / "access",
        )


def test_export_and_handoff_names_are_unioned_without_duplicate_authority(tmp_path):
    workbench, _, request = make_study(tmp_path)
    export = tmp_path / "exports"
    export.mkdir()
    value = access_request(
        request,
        allow_export=True,
        export_names=["reviewed-result"],
        disclosures=[*METADATA, "previews", "source_names", "measurements"],
        interactive=interactive_request(
            allow_handoff=True, channels=[0], handoff_names=["sample.loci-vision"]
        ),
    )
    create_agent_access(workbench, value, tmp_path / "access", export)
    policy = load_policy(tmp_path / "access/agent-policy.json")
    assert policy.export_filenames == {"reviewed-result", "sample.loci-vision"}
    value["export_names"] = ["sample.loci-vision"]
    with pytest.raises(ValueError, match="unique"):
        create_agent_access(workbench, value, tmp_path / "duplicate", export)


def test_interactive_plugin_stdio_imports_pinned_checkout_and_policy(tmp_path):
    workbench, _, request = make_study(tmp_path)
    destination = tmp_path / "access"
    create_agent_access(
        workbench,
        access_request(
            request,
            disclosures=[*METADATA, "previews"],
            interactive=interactive_request(
                allow_image=True,
                channels=[0],
                parameters={"threshold": {"min": 40, "max": 80}},
            ),
        ),
        destination,
    )
    server = json.loads((destination / "plugin/mcp.json").read_text())["mcpServers"][
        "loci-research"
    ]

    async def check():
        parameters = StdioServerParameters(
            command=server["command"],
            args=server["args"],
            env={**os.environ, **server["env"]},
            cwd=str(destination / "plugin"),
        )
        async with stdio_client(parameters) as streams, ClientSession(*streams) as session:
            await session.initialize()
            catalog = await session.call_tool("catalog")
            assert not catalog.is_error
            document = json.loads(catalog.content[0].text)
            assert "source_image" in document["policy"]["operations"]
            context = await session.call_tool("analysis_context")
            assert not context.is_error
            document = json.loads(context.content[0].text)
            assert document["experimental_recipes"][0]["key"] == "interactive-recipe"
            assert (
                document["policy"]["sha256"]
                == load_policy(destination / "agent-policy.json").content_sha256
            )

    asyncio.run(check())


def test_interactive_frozen_plugin_preserves_exact_worker_command(tmp_path, monkeypatch):
    workbench, _, request = make_study(tmp_path)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    destination = tmp_path / "access"
    create_agent_access(
        workbench, access_request(request, interactive=interactive_request()), destination
    )
    manual = json.loads((destination / "mcp-config.json").read_text())["mcpServers"][
        "loci-research"
    ]
    server = json.loads((destination / "plugin/mcp.json").read_text())["mcpServers"][
        "loci-research"
    ]
    assert server == {"type": "stdio", **manual}
    assert server["args"][:2] == ["--cli", "mcp"]
    assert "cwd" not in server and "env" not in server


def test_replaced_staging_directory_is_not_published_or_deleted(tmp_path, monkeypatch):
    workbench, _, request = make_study(tmp_path)
    fsync = research_agent_setup._fsync_directory
    replaced = []

    def swap(path):
        fsync(path)
        if path.name.startswith(".loci-agent-access-") and not replaced:
            path.rename(tmp_path / "displaced-stage")
            path.mkdir(mode=0o700)
            (path / "unrelated.txt").write_text("Keep this replacement")
            replaced.append(path)

    monkeypatch.setattr(research_agent_setup, "_fsync_directory", swap)
    with pytest.raises(ValueError, match="staging directory changed"):
        create_agent_access(workbench, access_request(request), tmp_path / "access")
    assert not (tmp_path / "access").exists()
    assert (replaced[0] / "unrelated.txt").read_text() == "Keep this replacement"
    assert (tmp_path / "displaced-stage/agent-policy.json").is_file()
