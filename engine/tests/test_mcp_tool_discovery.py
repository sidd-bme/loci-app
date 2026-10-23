"""A real stdio client can discover exact image/review requests without repository access."""

import asyncio
import copy
import json
import tempfile

import pytest
from jsonschema import Draft202012Validator, ValidationError
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client
from test_agent_review import setup
from test_agent_vision import channel
from test_research_mcp import stdio_parameters

from loci_engine.agent_policy import write_policy
from loci_engine.agent_vision import CHANNEL_FIELDS, REQUEST_FIELDS, render_source_image
from loci_engine.research_tool_schemas import (
    REVIEW_RESULT_REQUEST_SCHEMA,
    SOURCE_IMAGE_REQUEST_SCHEMA,
    tool_request_schema,
)


def image_values(source_id):
    return {
        "source_id": source_id,
        "selection": {
            "x": 0,
            "y": 0,
            "width": 32,
            "height": 32,
            "t": 0,
            "c": 0,
            "z": 1,
            "level": 0,
        },
        "channels": [channel()],
        "projection": "plane",
        "max_size": 64,
    }


def discovered_request(schema, values):
    """Build the required dictionary from the discovered contract, then validate it."""
    assert set(values) == set(schema["required"])
    request = {key: values[key] for key in schema["required"]}
    Draft202012Validator(schema).validate(request)
    return request


def test_static_schemas_cover_native_fields_and_catalog_copies_are_detached():
    for name in ("source_image", "review_result"):
        schema = tool_request_schema(name)
        Draft202012Validator.check_schema(schema)
        assert set(schema["required"]) == set(schema["properties"])
        assert schema["additionalProperties"] is False
        schema["properties"].clear()
        assert tool_request_schema(name)["properties"]
    assert set(SOURCE_IMAGE_REQUEST_SCHEMA["required"]) == REQUEST_FIELDS
    assert (
        set(SOURCE_IMAGE_REQUEST_SCHEMA["properties"]["channels"]["items"]["required"])
        == CHANNEL_FIELDS
    )
    assert tool_request_schema("classical_run") is None


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.pop("channels"),
        lambda r: r.update(extra=True),
        lambda r: r["selection"].pop("t"),
        lambda r: r["selection"].update(z_stop=2),
        lambda r: r.update(projection="max"),
        lambda r: r.update(max_size=63),
        lambda r: r["selection"].update(width=2049),
        lambda r: r["channels"][0].update(visible=1),
        lambda r: r["channels"][0].update(color="#ffffff\n"),
        lambda r: r["channels"][0].update(gamma=0),
    ],
)
def test_image_schema_exposes_structural_rejections(mutation):
    request = image_values("0" * 32)
    mutation(request)
    with pytest.raises(ValidationError):
        Draft202012Validator(SOURCE_IMAGE_REQUEST_SCHEMA).validate(request)


@pytest.mark.parametrize(
    "changes",
    [
        {"result_id": "0" * 32 + "\n"},
        {"revision_hash": "a" * 63},
        {"disposition": "approved"},
        {"reason": " \n\t"},
        {"coverage": "\x00hidden"},
        {"coverage": "a" * 4097},
        {"expected_review_sha256": ""},
        {"expected_review_sha256": "A" * 64},
        {"actor": "human"},
    ],
)
def test_review_schema_exposes_identity_assessment_and_prior_digest_constraints(changes):
    request = {
        "result_id": "0" * 32,
        "revision_hash": "a" * 64,
        "disposition": "pending",
        "reason": "Inspection incomplete.",
        "coverage": "First plane only.",
        "expected_review_sha256": None,
        **changes,
    }
    with pytest.raises(ValidationError):
        Draft202012Validator(REVIEW_RESULT_REQUEST_SCHEMA).validate(request)


def test_actual_stdio_discovery_drives_images_agent_review_and_guarded_export(tmp_path):
    _, wb, result, path, _, spec, root = setup(tmp_path)
    spec["operations"] += ["analysis_context", "source_image"]
    write_policy(path, wb.project, spec)

    async def exercise(errlog):
        async with (
            stdio_client(stdio_parameters(path), errlog=errlog) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            response = await session.call_tool("catalog", {})
            assert not response.is_error
            catalog = response.structured_content
            entries = {item["name"]: item for item in catalog["tools"]}
            schemas = {}
            for name in ("source_image", "review_result"):
                outer = tools[name].input_schema
                assert outer["required"] == ["request"]
                schema = copy.deepcopy(outer["properties"]["request"])
                schema.pop("title", None)
                assert schema == entries[name]["request_schema"]
                assert "list_tools" in tools[name].description
                schemas[name] = schema
            assert "registered action names only" in tools["action_guide"].description
            assert catalog["dataset_contents_included"] is False
            assert str(tmp_path) not in json.dumps(entries)

            context = await session.call_tool("analysis_context", {})
            assert not context.is_error
            source_id = context.structured_content["source_grants"][0]["source_id"]
            values = image_values(source_id)
            image_request = discovered_request(schemas["source_image"], values)

            # Schema annotations must not strip invalid fields, supply defaults or
            # coerce booleans; existing exact native checks remain authoritative.
            bad_requests = []
            missing = copy.deepcopy(image_request)
            missing.pop("channels")
            bad_requests.append(missing)
            for channel_changes in ({"high": 0}, {"gamma": True}, {"channel": 1}):
                bad = copy.deepcopy(image_request)
                bad["channels"][0].update(channel_changes)
                bad_requests.append(bad)
            bad = copy.deepcopy(image_request)
            bad["selection"]["t"] = 1  # Native-valid axis outside this source grant.
            bad_requests.append(bad)
            bad_requests.append({**image_request, "extra": "must not be discarded"})
            for bad in bad_requests:
                refused = await session.call_tool("source_image", {"request": bad})
                assert refused.is_error
                assert not any(item.type == "image" for item in refused.content)
                assert str(tmp_path) not in refused.model_dump_json()

            for projection in ("plane", "max", "mean"):
                selected = copy.deepcopy(image_request)
                selected["projection"] = projection
                if projection != "plane":
                    selected["selection"].update(z=0, z_stop=4)
                Draft202012Validator(schemas["source_image"]).validate(selected)
                response = await session.call_tool("source_image", {"request": selected})
                assert not response.is_error
                images = [item for item in response.content if item.type == "image"]
                assert len(images) == 1 and images[0].mime_type == "image/png"
                native = render_source_image(wb, selected)
                assert images[0].data == native["image"].split(",", 1)[1]
                assert response.structured_content["display_only"] is True
                assert "image" not in response.structured_content

            view = await session.call_tool(
                "result_view", {"result_id": result["id"], "axis": "z", "index": 1}
            )
            assert not view.is_error
            assert any(item.type == "image" for item in view.content)
            prior = await session.call_tool("review_history", {"result_id": result["id"]})
            assert not prior.is_error
            values = {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "disposition": "pending",
                "reason": "Synthetic fixture inspection; partial coverage is explicit.",
                "coverage": "Result Z=1, source Z=1 and max/mean projections; not every Z plane.",
                "expected_review_sha256": prior.structured_content["current_review_sha256"],
            }
            review = discovered_request(schemas["review_result"], values)
            assert review["expected_review_sha256"] is None
            for changes in (
                {"actor": "human"},
                {"revision_hash": "0" * 64},
                {"expected_review_sha256": "0" * 64},
                {"reason": " "},
            ):
                refused = await session.call_tool(
                    "review_result", {"request": {**review, **changes}}
                )
                assert refused.is_error
            response = await session.call_tool("review_result", {"request": review})
            assert not response.is_error
            assert response.structured_content["review"]["actor"] == "agent"
            assert response.structured_content["review"]["actor_id"] == "declared-test-client"
            refused = await session.call_tool(
                "export_result",
                {
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "filename": "approved-result",
                },
            )
            assert refused.is_error  # Pending is not reviewed.
            stale = await session.call_tool("review_result", {"request": review})
            assert stale.is_error
            current = await session.call_tool("review_history", {"result_id": result["id"]})
            values.update(
                disposition="reviewed",
                expected_review_sha256=current.structured_content["current_review_sha256"],
            )
            assert len(values["expected_review_sha256"]) == 64
            reviewed = discovered_request(schemas["review_result"], values)
            response = await session.call_tool("review_result", {"request": reviewed})
            assert not response.is_error
            for filename, allowed in (("outside-grant", False), ("approved-result", True)):
                response = await session.call_tool(
                    "export_result",
                    {
                        "result_id": result["id"],
                        "revision_hash": result["revision_hash"],
                        "filename": filename,
                    },
                )
                assert not response.is_error if allowed else response.is_error

    with tempfile.TemporaryFile(mode="w+") as errlog:
        asyncio.run(exercise(errlog))
        errlog.seek(0)
        assert str(tmp_path) not in errlog.read()
    exported = json.loads((root / "approved-result" / "result.json").read_text())
    assert exported["review"]["actor"] == "agent"
    assert exported["review"]["revision_hash"] == result["revision_hash"]
    assert len(wb.project.review_history(result["id"])) == 2
    assert not (root / "outside-grant").exists()
