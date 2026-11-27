import asyncio
import json
import tempfile

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_policy import specification
from test_organoidtracker import experiment  # noqa: F401
from test_research_mcp import stdio_parameters

from loci_engine.agent_actions import inspect_action
from loci_engine.agent_policy import DISCLOSURES, load_policy, write_policy
from loci_engine.organoidtracker import import_graph
from loci_engine.research_mcp import PolicyAgent
from loci_engine.workbench import Workbench


@pytest.fixture
def authorized(tmp_path, experiment):  # noqa: F811
    project, source, doc = experiment
    wb = Workbench(project)
    binding = dict(source_id=source["id"], source_sha256=source["sha256"])
    aut = tmp_path / "manual.aut"
    aut.write_text(json.dumps(doc))
    graph = import_graph(project, aut, binding, 13, "manually-annotated")
    request = dict(
        **binding,
        graph_id=graph["id"],
        graph_sha256=graph["graph_sha256"],
        filter="branch",
        offset=0,
        limit=1,
    )
    root = tmp_path / "exports"
    root.mkdir()
    spec = specification(
        wb,
        source,
        dict(
            source_id=source["id"],
            selection={},
            recipe={
                "segmentation": {"method": "components", "threshold": 5},
                "measurement_channels": [0],
            },
        ),
        root,
        disclosures=sorted(DISCLOSURES),
        recipes=False,
    )
    spec["sources"][0].update(
        crop={"x": 0, "y": 0, "width": 10, "height": 8},
        t=[0, 1],
        c=[0, 1],
        measurement_channels=[0, 1],
    )
    spec.update(
        actions=["organoidtracker_links"],
        remote_grants=[],
        experimental_recipes=[],
        delegation=dict(
            id="d" * 32, client_id="lineage-reader", expires_at=None, result_scope="granted-sources"
        ),
    )
    spec["operations"] += ["validate_action", "inspect_action"]
    path = tmp_path / "policy.json"
    write_policy(path, project, spec)
    yield wb, request, path, spec
    wb.close()


def test_stdio_link_evidence_and_page(authorized):
    wb, request, path, _ = authorized

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as client,
        ):
            await client.initialize()

            async def query(**changes):
                result = await client.call_tool(
                    "inspect_action",
                    {"operation": "organoidtracker_links", "request": {**request, **changes}},
                )
                assert not result.is_error, result
                return result.structured_content

            first = await query()
            assert first["matching_link_count"] == 2 and first["next_offset"] == 1
            a = first["rows"][0]
            assert a["earlier"] == dict(
                node_index=0,
                upstream_time_point=13,
                source_t=0,
                elapsed_s=0,
                xyz_px=[5, 4, 1.5],
                xyz_um=[1.25, 2, 3],
            )
            assert a["link_probability"] == 0.75 and a["marginal_probability"] is None
            last = await query(offset=1)
            assert last["next_offset"] is None
            assert last["rows"][0]["later"]["elapsed_s"] == 30
            low = await query(filter="low-marginal", marginal_below=0.99)
            assert low["rows"] == last["rows"] and low["matching_link_count"] == 1
            assert low["origin_declaration"] == "manually-annotated"
            assert (await query(source_t=1))["matching_link_count"] == 0

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
    assert wb.project.list_jobs() == []


@pytest.mark.parametrize(
    "invalid",
    [
        "crop",
        "channel",
        "z",
        "time",
        "source",
        "foreign_graph",
        "forged_hash",
        "result_scope",
        "action",
        "disclosure",
        "path",
        "page",
    ],
)
def test_query_fails_closed(authorized, invalid):
    wb, request, path, spec = authorized
    grant = spec["sources"][0]
    if invalid == "channel":
        grant.update(c=[0], measurement_channels=[0])
    if invalid == "crop":
        grant["crop"]["width"] -= 1
    if invalid == "z":
        grant["z"] = [1, 2]
    if invalid == "time":
        grant["t"] = [0]
    if invalid == "action":
        spec["actions"] = []
    if invalid == "disclosure":
        spec["disclosures"] = []
    if invalid == "result_scope":
        spec["delegation"]["result_scope"] = "pinned-recipes"
    if invalid == "source":
        request["source_sha256"] = "f" * 64
    if invalid == "foreign_graph":
        request.update(graph_id="1" * 32, graph_sha256="1" * 64)
    if invalid == "forged_hash":
        request["graph_sha256"] = request["graph_id"] + "f" * 32
    if invalid == "path":
        request["path"] = "/tmp/x.aut"
    if invalid == "page":
        request["limit"] = 101
    with pytest.raises((PermissionError, ValueError)):
        write_policy(path, wb.project, spec)
        agent = PolicyAgent(load_policy(path))
        inspect_action(agent, wb, "organoidtracker_links", request)
