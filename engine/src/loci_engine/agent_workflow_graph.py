"""Explicit policy/session adapter for bounded graph coordination.

Control authority never grants native operations, sources, results, runtimes or
review. Native children retain the existing supervisor and their own job owner.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from .agent_actions import authorize_action, source_scope
from .agent_policy import DISCLOSURES
from .agent_sessions import check_or_await_approval, heartbeat_session
from .research_action_registry import REQUESTS
from .research_project import canonical_json, checked_id, parse_json
from .research_workflow_graph import (
    OPERATIONS,
    SAVED_SCHEMA,
    _exact,
    _get,
    _run,
    execute_workflow_graph,
)
from .workbench import runtime_record
from .workflow_graph import ADAPTERS, NAME, validate_definition

CONTROL_TOOL = "workflow_graph_control"
INSPECT_TOOL = "workflow_graph_inspect"
CONTROL_OPERATIONS = frozenset(
    f"workflow_graph_{name}" for name in ("save", "start", "advance", "cancel")
)
INSPECT_OPERATIONS = OPERATIONS - CONTROL_OPERATIONS
MAX_PAYLOAD_BYTES = 1024**2

GraphControlOperation = Literal[
    "workflow_graph_save", "workflow_graph_start", "workflow_graph_advance", "workflow_graph_cancel"
]
GraphInspectOperation = Literal[
    "workflow_graph_validate",
    "workflow_graph_get",
    "workflow_graph_list",
    "workflow_graph_preflight",
    "workflow_graph_status",
]


def _object(properties, required=None):
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties if required is None else required),
    }


def _definition_schema():
    identity = {"type": "string", "pattern": NAME.pattern}
    ref = {
        "oneOf": [
            _object({"input": identity}),
            _object({"node": identity, "port": {"const": "result"}}),
        ]
    }
    nodes = []
    for operation, ports in ADAPTERS.items():
        if operation == "run_recipe":
            settings = _object({"recipe": REQUESTS[operation]["properties"]["recipe"]})
        else:
            fields = set(REQUESTS[operation]["properties"]) - {
                "source_id",
                "selection",
                "result_id",
                "revision_hash",
                *ports,
            }
            settings = _object(
                {key: REQUESTS[operation]["properties"][key] for key in sorted(fields)},
                sorted(set(REQUESTS[operation]["required"]) & fields - {"working_bytes"}),
            )
        nodes.append(
            _object(
                {
                    "id": identity,
                    "operation": {"const": operation},
                    "contract_version": {"const": 1},
                    "inputs": _object({port: ref for port in ports}),
                    "settings": settings,
                }
            )
        )
    return _object(
        {
            "schema": {"const": "loci.workflow/v2"},
            "name": {"type": "string", "minLength": 1, "maxLength": 256},
            "inputs": {
                "type": "object",
                "minProperties": 1,
                "maxProperties": 64,
                "propertyNames": identity,
                "additionalProperties": {"enum": ["source-selection", "label-result"]},
            },
            "nodes": {"type": "array", "minItems": 1, "maxItems": 32, "items": {"oneOf": nodes}},
            "outputs": {
                "type": "object",
                "minProperties": 1,
                "maxProperties": 64,
                "propertyNames": identity,
                "additionalProperties": _object({"node": identity, "port": {"const": "result"}}),
            },
            "working_bytes": {"type": "integer", "minimum": 1024**2, "maximum": 8 * 1024**3},
        }
    )


ID = {"type": "string", "pattern": "^[a-f0-9]{32}$"}
SHA = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
BINDINGS = {
    "type": "object",
    "minProperties": 1,
    "maxProperties": 64,
    "additionalProperties": {
        "oneOf": [
            _object({"result_id": ID, "revision_hash": SHA}),
            _object(
                {
                    "source_id": ID,
                    "source_sha256": SHA,
                    "selection": REQUESTS["run_recipe"]["properties"]["selection"],
                }
            ),
        ]
    },
}
BINDING_PROPERTIES = {
    "workflow_id": ID,
    "workflow_revision": {"type": "integer", "minimum": 1},
    "definition_sha256": SHA,
    "bindings": BINDINGS,
}
REQUEST_SCHEMAS = {
    "workflow_graph_validate": _object({"definition": _definition_schema()}),
    "workflow_graph_save": _object(
        {
            "workflow_id": ID,
            "expected_revision": {"type": "integer", "minimum": 0},
            "definition": _definition_schema(),
        }
    ),
    "workflow_graph_get": _object({"workflow_id": ID}),
    "workflow_graph_list": _object({}),
    "workflow_graph_preflight": _object(BINDING_PROPERTIES),
    "workflow_graph_start": _object(
        {
            **BINDING_PROPERTIES,
            "plan_sha256": SHA,
            "request_key": {"type": "string", "minLength": 1, "maxLength": 160},
        }
    ),
    **{
        name: _object({"run_id": ID})
        for name in ("workflow_graph_advance", "workflow_graph_status", "workflow_graph_cancel")
    },
}
# The operation-specific exact request check remains in the native coordinator.
# anyOf permits shared request shapes, such as advance/status/cancel.
GRAPH_CONTROL_REQUEST_SCHEMA = {
    "anyOf": [REQUEST_SCHEMAS[name] for name in sorted(CONTROL_OPERATIONS)]
}
GRAPH_INSPECT_REQUEST_SCHEMA = {
    "anyOf": [REQUEST_SCHEMAS[name] for name in sorted(INSPECT_OPERATIONS)]
}
GraphControlRequest = Annotated[
    dict[str, Any], Field(json_schema_extra=GRAPH_CONTROL_REQUEST_SCHEMA)
]
GraphInspectRequest = Annotated[
    dict[str, Any], Field(json_schema_extra=GRAPH_INSPECT_REQUEST_SCHEMA)
]


def _recheck(agent):
    agent._recheck_session()
    for disclosure in DISCLOSURES:
        agent.policy.require_disclosure(disclosure)


def _definition_scope(agent, definition):
    validated = validate_definition(definition)
    normalized = validated["definition"]
    if normalized["working_bytes"] > agent.policy.memory_bytes:
        raise PermissionError("Graph working-memory budget exceeds the delegated policy")
    for node in normalized["nodes"]:
        if node["operation"] not in agent.policy.actions:
            raise PermissionError("Graph control does not grant a native node operation")
    return validated


def _authorize_binding(agent, workbench, kind, binding):
    _recheck(agent)
    if kind == "source-selection":
        _exact(binding, {"source_id", "source_sha256", "selection"}, "graph source binding")
        grant = agent.policy.source_grant(workbench.project, binding.get("source_id"))
        if grant.sha256 != binding.get("source_sha256"):
            raise PermissionError("Graph source fingerprint exceeds the exact grant")
        # Biological measurement grants are checked independently by the actual
        # native leaf; selecting a source plane does not grant raw measurements.
        selected = source_scope(
            agent.policy, workbench, binding["source_id"], binding.get("selection"), []
        )
        if selected != binding.get("selection"):
            raise ValueError("Graph source binding requires a complete exact selection")
    elif kind == "label-result":
        _exact(binding, {"result_id", "revision_hash"}, "graph result binding")
        result = agent._authorize_result(workbench, binding.get("result_id"))
        if result["revision_hash"] != binding.get("revision_hash"):
            raise PermissionError("Graph result revision changed after inspection")
    else:
        raise ValueError("Unknown graph binding type")


def _authorize_leaf(agent, workbench, operation, request):
    _recheck(agent)
    agent.policy.require_operation(
        "submit_recipe"
        if operation == "run_recipe" and "submit_recipe" in agent.policy.operations
        else "submit_action"
    )
    agent.policy.require_runtime(runtime_record())
    normalized = authorize_action(agent, workbench, operation, request, mode="task")
    if canonical_json(normalized) != canonical_json(request):
        raise PermissionError("Native graph leaf authorization changed its planned request")
    return normalized


def _invoke(agent, tool, operation, request):
    allowed = CONTROL_OPERATIONS if tool == CONTROL_TOOL else INSPECT_OPERATIONS
    if not isinstance(operation, str) or operation not in allowed:
        raise ValueError("Choose the declared graph inspection or control operation")
    encoded = canonical_json(request)
    if len(encoded.encode()) > min(MAX_PAYLOAD_BYTES, agent.policy.memory_bytes // 8):
        raise PermissionError("Graph control request exceeds its delegated payload budget")
    request = parse_json(encoded)
    # Validate operation-specific fields before resolving any study identity.
    from .agent_actions import _schema_check

    _schema_check(request, REQUEST_SCHEMAS[operation])
    workbench = agent._workbench(tool)
    try:
        _recheck(agent)
        if operation in {"workflow_graph_save", "workflow_graph_validate"}:
            _definition_scope(agent, request.get("definition"))
        elif operation in {
            "workflow_graph_preflight",
            "workflow_graph_start",
            "workflow_graph_get",
        }:
            doc = _get(workbench, request.get("workflow_id"))
            _definition_scope(agent, doc["data"]["definition"])
        elif operation in {
            "workflow_graph_advance",
            "workflow_graph_status",
            "workflow_graph_cancel",
        }:
            run = _run(workbench, request.get("run_id"))
            if run["data"]["owner"] != agent.job_owner:
                raise PermissionError("Graph run belongs to another policy or session")
            if operation != "workflow_graph_cancel":
                _definition_scope(agent, run["data"]["plan"]["definition"])
        if operation == "workflow_graph_list":
            docs = workbench.project.documents("workflow")
            if len(docs) > 1024:
                raise PermissionError("Graph listing exceeds the bounded study document count")
            visible = []
            for doc in docs:
                if doc["data"].get("schema") != SAVED_SCHEMA:
                    continue
                try:
                    _definition_scope(agent, doc["data"]["definition"])
                except PermissionError:
                    continue
                visible.append(_get(workbench, doc["id"]))
            output = {"workflows": visible}
        else:
            check_or_await_approval(
                agent, workbench, tool, {"operation": operation, "request": request}
            )

            def submit(native_workbench, native_operation, body, key):
                _authorize_leaf(agent, native_workbench, native_operation, body)
                check_or_await_approval(
                    agent,
                    native_workbench,
                    "submit_action",
                    {"operation": native_operation, "request": body},
                )
                _recheck(agent)
                job = agent.supervisor.start(
                    native_workbench, body, key, operation=native_operation
                )
                if native_workbench.project.job(job["id"]).get("owner") != agent.job_owner:
                    raise PermissionError("Graph supervisor returned a different job owner")
                if agent.session_id is not None:
                    heartbeat_session(
                        native_workbench.project, agent.session_id, active_job_id=job["id"]
                    )
                return job

            def cancel(project, job_id):
                _recheck(agent)
                if project.job(checked_id(job_id)).get("owner") != agent.job_owner:
                    raise PermissionError("Graph cancellation cannot target another job owner")
                return agent.supervisor.cancel(project, job_id)

            output = execute_workflow_graph(
                workbench,
                operation,
                request,
                authorize=lambda wb, op, body: _authorize_leaf(agent, wb, op, body),
                authorize_binding=lambda wb, kind, bound: _authorize_binding(
                    agent, wb, kind, bound
                ),
                submit=submit,
                cancel=cancel,
                owner=agent.job_owner,
                publication_guard=lambda: _recheck(agent),
            )
        _recheck(agent)
        if len(canonical_json(output).encode()) > min(8 * 1024**2, agent.policy.memory_bytes // 8):
            raise PermissionError("Graph response exceeds its delegated metadata budget")
        return output
    finally:
        workbench.close()


def workflow_graph_control(agent, operation: GraphControlOperation, request: GraphControlRequest):
    return _invoke(agent, CONTROL_TOOL, operation, request)


def workflow_graph_inspect(agent, operation: GraphInspectOperation, request: GraphInspectRequest):
    return _invoke(agent, INSPECT_TOOL, operation, request)
