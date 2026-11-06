"""CAS coordinator for exact, bounded workflow/v2 native child jobs.

Each advance persists one node intent before calling the existing native submit
boundary. Lost responses reuse that intent's key; completed jobs are reconciled
from atomic job/result publication. This module never runs an image operation.
Clients supply current authority checks and may supply the existing supervisor's
submit/cancel methods. Native workers must chain guard_node_job into their usual
execution/publication guard, including workers restarted after a lost response.
"""

from __future__ import annotations

import hashlib

from .quantitative import exact_keys, integer
from .research_jobs import cancel_job, submit_job
from .research_project import canonical_json, checked_id, checked_text, parse_json, timestamp
from .workflow_graph import (
    ADAPTER_VERSIONS,
    OUTPUT_TYPES,
    PLAN_SCHEMA,
    _lineage_scopes,
    _preview_wire_equal,
    _record_scope,
    _resolve_node,
    _result,
    _sha,
    build_plan,
    resolve_node,
    validate_bindings,
    validate_definition,
)

SAVED_SCHEMA = "loci.saved-workflow/v2"
RUN_SCHEMA = "loci.workflow-run/v2"
KEY_PREFIX = "graph-v2:"
BINDING_KEYS = {"workflow_id", "workflow_revision", "definition_sha256", "bindings"}
OPERATIONS = frozenset(
    f"workflow_graph_{name}"
    for name in (
        "validate",
        "save",
        "save_from_run",
        "continuation",
        "prepared_previews",
        "continue",
        "get",
        "list",
        "preflight",
        "start",
        "advance",
        "status",
        "cancel",
    )
)
TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
MAX_WORKFLOWS = 1024
MAX_RUN_BYTES = 4 * 1024**2


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _copy(value):
    return parse_json(canonical_json(value))


def _exact(value, fields, name):
    exact_keys(value, fields, name)
    if set(value) != fields:
        raise ValueError(f"{name} requires every declared field")


def _document(project, kind, identity):
    docs = project.documents(kind, document_id=checked_id(identity))
    if len(docs) != 1:
        raise ValueError("Choose an existing graph workflow or run")
    return docs[0]


def _get(workbench, identity):
    doc = _document(workbench.project, "workflow", identity)
    data = doc["data"]
    _exact(data, {"schema", "definition", "definition_sha256"}, "saved graph")
    if data["schema"] != SAVED_SCHEMA:
        raise ValueError("Choose a saved workflow/v2 graph")
    validated = validate_definition(data["definition"])
    if validated["definition_sha256"] != data["definition_sha256"]:
        raise ValueError("Saved graph definition identity changed")
    return doc


def _run(workbench, identity):
    doc = _document(workbench.project, "workflow_run", identity)
    data = doc["data"]
    _exact(
        data,
        {
            "schema",
            "project_id",
            "workflow_id",
            "workflow_revision",
            "definition_sha256",
            "request_key",
            "request_sha256",
            "plan",
            "owner",
            "state",
            "cancel_requested",
            "nodes",
            "outputs",
            "created_at",
            "updated_at",
            "run_sha256",
        }
        | ({"continuation"} if "continuation" in data else set()),
        "graph run",
    )
    if data["schema"] != RUN_SCHEMA or data["project_id"] != workbench.project.meta["project_id"]:
        raise ValueError("Graph run schema or study identity is invalid")
    if (
        _hash({key: value for key, value in data.items() if key != "run_sha256"})
        != data["run_sha256"]
    ):
        raise ValueError("Graph run integrity check failed")
    if (
        data["state"] not in {"prepared", "running", "cancelling", *TERMINAL}
        or type(data["cancel_requested"]) is not bool
    ):
        raise ValueError("Graph run state is invalid")
    expected_id = _hash([RUN_SCHEMA, data["project_id"], data["request_key"]])[:32]
    request = {
        key: data[key]
        for key in ("workflow_id", "workflow_revision", "definition_sha256", "request_key")
    }
    request.update(bindings=data["plan"]["bindings"], plan_sha256=data["plan"]["plan_sha256"])
    if expected_id != doc["id"] or _hash(request) != data["request_sha256"]:
        raise ValueError("Graph run submission identity changed")
    if "continuation" in data:
        receipt = data["continuation"]
        if not isinstance(receipt, dict) or _hash(
            {key: value for key, value in receipt.items() if key != "continuation_sha256"}
        ) != receipt.get("continuation_sha256"):
            raise ValueError("Retained graph continuation proof integrity failed")
        original = _document(workbench.project, "workflow_run", receipt["run_id"])
        original_data = original["data"]
        if (
            original["id"] == doc["id"]
            or original["revision"] != receipt["run_revision"]
            or original_data.get("run_sha256") != receipt["run_sha256"]
            or _hash({k: v for k, v in original_data.items() if k != "run_sha256"})
            != receipt["run_sha256"]
            or not receipt["can_start_fresh"]
            or original_data.get("owner") != receipt["owner"]
            or original_data.get("state") not in {"failed", "cancelled"}
            or data["workflow_id"] == receipt["workflow_id"]
            or data["request_key"] == receipt["request_key"]
            or data["plan"]["definition"] != receipt["proposal"]["definition"]
            or data["plan"]["bindings"] != receipt["proposal"]["bindings"]
        ):
            raise ValueError("Retained graph continuation no longer binds its exact original run")
        verified = _copy(original_data)
        completed = _reconcile(workbench, verified, lambda *_: None, lambda *_: None)
        expected_receipt = _continuation_from_completed(workbench, original, verified, completed)
        if "original_continuation_sha256" in receipt:
            if expected_receipt["continuation_sha256"] != receipt["original_continuation_sha256"]:
                raise ValueError("Continuation original checkpoint proof changed")
            replacements = {
                name: bound
                for name, bound in receipt["proposal"]["bindings"].items()
                if receipt["proposal"]["definition"]["inputs"][name] == "tissue-preview"
            }
            for name, bound in replacements.items():
                prior = expected_receipt["proposal"]["bindings"][name]
                if bound["receipt"]["request"] != prior["receipt"]["request"]:
                    raise ValueError(
                        "Continuation tissue replacement changed its exact source scope"
                    )
            expected_receipt["original_continuation_sha256"] = expected_receipt[
                "continuation_sha256"
            ]
            expected_receipt["proposal"]["bindings"].update(replacements)
            expected_receipt["continuation_sha256"] = _hash(
                {k: v for k, v in expected_receipt.items() if k != "continuation_sha256"}
            )
        if receipt != expected_receipt:
            raise ValueError("Retained continuation does not prove exactly its reused native work")
    for node_id, entry in data["nodes"].items():
        _exact(entry, {"state", "intent", "output"}, "graph node state")
        if entry["state"] not in {
            "pending",
            "intent",
            "queued",
            "running",
            "interrupted",
            *TERMINAL,
        }:
            raise ValueError("Graph node state is invalid")
        if entry["intent"] is None:
            if entry["state"] not in {"pending", "cancelled"} or entry["output"] is not None:
                raise ValueError("Graph node has no durable intent")
        elif entry["intent"].get("request_key") != f"{KEY_PREFIX}{doc['id']}:{node_id}":
            raise ValueError("Graph child key does not belong to its node and run")
        if entry["output"] is not None and entry["state"] != "succeeded":
            raise ValueError("Unfinished graph node claims a published output")
    return doc


def _commit(workbench, identity, data, revision, guard=None):
    data = _copy(data)
    data["updated_at"] = timestamp()
    data.pop("run_sha256", None)
    data["run_sha256"] = _hash(data)
    if len(canonical_json(data).encode()) > MAX_RUN_BYTES:
        raise ValueError("Graph run exceeds its bounded coordinator payload")
    return workbench.project.put_document(
        "workflow_run", identity, data, expected_revision=revision, publication_guard=guard
    )


def _owner(data, owner):
    if data["owner"] != owner:
        raise PermissionError("Graph run belongs to a different policy or session")


def _validate_owner(owner):
    if owner is not None:
        _exact(owner, {"policy_sha256", "session_id"}, "graph owner")
        _sha(owner["policy_sha256"], "Graph owner policy")
        if owner["session_id"] is not None:
            checked_id(owner["session_id"])


def _callbacks(authorize, authorize_binding):
    if not callable(authorize) or not callable(authorize_binding):
        raise PermissionError("Graph execution requires current request and binding authority")


def _authorize_inputs(workbench, plan, authorize_binding):
    for name, binding in plan["bindings"].items():
        authorize_binding(workbench, plan["definition"]["inputs"][name], _copy(binding))


def _native_request(workbench, operation, request):
    if operation == "run_recipe":
        normalized = workbench.validate_recipe(request)
        return {key: normalized[key] for key in ("source_id", "selection", "recipe")}
    return _copy(request)


def _authorize(workbench, operation, request, authorize):
    accepted = authorize(workbench, operation, _copy(request))
    if accepted is not None and canonical_json(accepted) != canonical_json(request):
        raise PermissionError("Graph request authority changed the pinned native request")


def _prepare(workbench, request, authorize, authorize_binding):
    _exact(request, BINDING_KEYS, "graph binding")
    doc = _get(workbench, request["workflow_id"])
    if (
        integer(request["workflow_revision"], "workflow revision", 1, 2**31 - 1) != doc["revision"]
        or _sha(request["definition_sha256"], "Definition") != doc["data"]["definition_sha256"]
    ):
        raise ValueError("Saved graph changed; preflight its current revision")
    _callbacks(authorize, authorize_binding)
    # Check the caller's input authority before source readers or result metadata.
    definition = doc["data"]["definition"]
    _exact(request["bindings"], set(definition["inputs"]), "graph bindings")
    for name, binding in request["bindings"].items():
        authorize_binding(workbench, definition["inputs"][name], _copy(binding))
        if definition["inputs"][name] == "tissue-preview":
            from .research_tissue_models import peek_preview

            cached = peek_preview(
                workbench.project, {key: binding[key] for key in ("preview_id", "preview_hash")}
            )
            if cached["receipt"] != binding["receipt"]:
                raise ValueError("Prepared tissue preview differs from its live cached receipt")
    plan = build_plan(workbench, definition, request["bindings"])
    for node in plan["definition"]["nodes"]:
        if all("input" in ref for ref in node["inputs"].values()):
            native = resolve_node(workbench, definition, plan["bindings"], {}, node["id"])
            body = _native_request(workbench, native["operation"], native["request"])
            _authorize(workbench, native["operation"], body, authorize)
    return doc, plan


def _validate_plan(workbench, data, owner, authorize, authorize_binding):
    _owner(data, owner)
    _callbacks(authorize, authorize_binding)
    plan = data["plan"]
    _authorize_inputs(workbench, plan, authorize_binding)
    current_workflow = _get(workbench, data["workflow_id"])
    if (
        current_workflow["revision"] != data["workflow_revision"]
        or current_workflow["data"]["definition_sha256"] != data["definition_sha256"]
    ):
        raise ValueError("Saved workflow changed after this graph run was planned")
    if (
        plan["definition_sha256"] != data["definition_sha256"]
        or plan["definition"] != current_workflow["data"]["definition"]
    ):
        raise ValueError("Graph plan does not bind its saved workflow definition")
    current = build_plan(workbench, plan["definition"], plan["bindings"])
    if canonical_json(current) != canonical_json(plan):
        raise ValueError("Graph plan, source bindings, adapter or runtime identity changed")
    expected = {node["id"] for node in plan["definition"]["nodes"]}
    _exact(data["nodes"], expected, "run nodes")
    return plan


def _by_key(project, key):
    if hasattr(project, "_workflow_jobs_by_key"):
        return project._workflow_jobs_by_key.get(key)
    with project.connection() as connection:
        row = connection.execute("SELECT record FROM jobs WHERE request_key=?", (key,)).fetchone()
    return None if row is None else parse_json(row[0])


def _job_request(workbench, operation, request, *, source_id=None):
    if operation == "run_recipe":
        return request
    if operation == "tissue_model_run":
        if source_id is None:
            raise ValueError("Graph tissue job requires its persisted exact source envelope")
    elif operation == "associate_results":
        source_id = workbench.project.result(request["cells"]["result_id"])["source_id"]
    elif operation in {
        "spatial_distance_run",
        "morphometrics_run",
        "annotation_evaluation_run",
        "method_run",
    }:
        source_id = workbench.project.result(request["result_id"])["source_id"]
    else:
        source_id = request["source_id"]
    return {"source_id": source_id, "task_request": request}


def _check_job(workbench, intent, job, owner):
    normalized = _job_request(
        workbench, intent["operation"], intent["request"], source_id=intent.get("source_id")
    )
    if (
        job["request_key"] != intent["request_key"]
        or job["operation"] != intent["operation"]
        or job.get("owner") != owner
        or job["request"] != normalized
        or job["request_hash"] != _hash({"operation": intent["operation"], "request": normalized})
        or (intent.get("job_id") is not None and job["id"] != intent["job_id"])
    ):
        raise ValueError("Graph child job does not match its persisted exact intent")


def _check_output(workbench, plan, node_id, intent, job):
    if len(job["result_ids"]) != 1:
        raise ValueError("Graph child job requires exactly one atomically published result")
    result = workbench.project.result(job["result_ids"][0])
    result = _result(
        workbench,
        {"result_id": result["id"], "revision_hash": result["revision_hash"]},
        plan["definition"]["working_bytes"],
        port_type=OUTPUT_TYPES[intent["operation"]],
    )
    if canonical_json(_record_scope(result)) != canonical_json(plan["node_scopes"][node_id]):
        raise ValueError("Graph child result belongs to a different source, selection or grid")
    provenance, operation, request = result["provenance"], intent["operation"], intent["request"]
    if operation != "tissue_model_run" and provenance.get("runtime") != plan["runtime"]:
        raise ValueError("Graph child result runtime does not match its immutable plan")
    if operation != "spatial_distance_run" and provenance.get("job_id") != job["id"]:
        raise ValueError("Graph child result does not name its own durable publication job")
    if operation == "tissue_model_run":
        from .research_tissue_models import validate_record

        validate_record(result)
        if provenance["host_runtime"] != plan["tissue_runtime"]:
            raise ValueError("Graph tissue host runtime differs from its prepared plan")
        prepared = next(
            binding
            for name, binding in plan["bindings"].items()
            if plan["definition"]["inputs"][name] == "tissue-preview"
            and {key: binding[key] for key in ("preview_id", "preview_hash")} == request
        )
        if (
            provenance["tissue_model"]["preview"] != request
            or provenance["tissue_model"]["receipt"] != prepared["receipt"]
        ):
            raise ValueError("Graph tissue result does not match its exact prepared preview")
    elif operation == "run_recipe":
        if provenance.get("recipe") != request["recipe"] or provenance.get(
            "recipe_sha256"
        ) != _hash(request["recipe"]):
            raise ValueError("Graph child result recipe provenance is mismatched")
    elif operation == "classical_run":
        accepted = provenance.get("accepted_request", {})
        if any(accepted.get(key) != value for key, value in request.items()):
            raise ValueError("Graph classical result request provenance is mismatched")
    elif operation == "method_run":
        from .research_methods import validate_parents

        if provenance.get("accepted_request") != request:
            raise ValueError("Graph controlled method result request is mismatched")
        validate_parents(
            result,
            {
                binding["result_id"]: workbench.project.result(binding["result_id"])
                for binding in provenance["controlled_method"]["parent_chain"]
            },
        )
    elif operation == "annotation_evaluation_run":
        from .research_annotation_evaluation import validate_parents

        if provenance.get("accepted_request") != request or provenance.get(
            "annotation_evaluation", {}
        ).get("software") != plan.get("method_identities", {}).get(operation):
            raise ValueError("Graph annotation request or method identity is mismatched")
        validate_parents(
            result,
            {
                binding["result_id"]: workbench.project.result(binding["result_id"])
                for binding in (
                    {k: request[k] for k in ("result_id", "revision_hash")},
                    request["reference"],
                )
            },
        )
    elif operation == "morphometrics_run":
        from .research_morphometrics import validate_parents

        if provenance.get("accepted_request") != request or provenance.get("morphometrics", {}).get(
            "software"
        ) != plan.get("method_identities", {}).get(operation):
            raise ValueError("Graph morphology request or method identity is mismatched")
        validate_parents(
            result,
            {
                binding["result_id"]: workbench.project.result(binding["result_id"])
                for binding in provenance["morphometrics"]["parent_chain"]
            },
        )
    elif operation == "spatial_distance_run":
        if provenance.get("accepted_request") != request:
            raise ValueError("Graph spatial result request provenance is mismatched")
    else:
        for role in ("cells", "nuclei"):
            bound = provenance.get("association_inputs", {}).get(role, {})
            if any(bound.get(key) != value for key, value in request[role].items()):
                raise ValueError("Graph association result input provenance is mismatched")
        association = provenance.get("association", {})
        if (
            association.get("roles") != request["roles"]
            or association.get("control") != request["control"]
        ):
            raise ValueError("Graph association result role provenance is mismatched")
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def _reconcile(
    workbench, data, authorize, authorize_binding, *, job_lookup=None, validated_context=None
):
    """Recover state from the native atomically completed child job/result records."""
    plan, completed = data["plan"], {}
    if validated_context is None:
        bindings, scopes = validate_bindings(
            workbench, plan["definition"], plan["bindings"], _with_scopes=True
        )
    else:
        bindings, scopes = validated_context
    for node in plan["definition"]["nodes"]:
        identity, entry = node["id"], data["nodes"][node["id"]]
        if entry["state"] == "pending" or entry.get("intent") is None:
            continue
        native = _resolve_node(
            workbench,
            plan["definition"],
            bindings,
            scopes,
            completed,
            identity,
            retained_request=entry["intent"]["request"],
        )
        body = _native_request(workbench, native["operation"], native["request"])
        intent = entry["intent"]
        _exact(
            intent,
            {"operation", "request", "request_sha256", "request_key", "job_id"}
            | ({"source_id"} if native["operation"] == "tissue_model_run" else set()),
            "node intent",
        )
        if (
            intent["operation"] != native["operation"]
            or intent["request"] != body
            or intent["request_sha256"] != _hash(body)
        ):
            raise ValueError("Graph node intent differs from the exact planned request")
        if (
            native["operation"] == "tissue_model_run"
            and intent["source_id"] != plan["node_scopes"][identity]["source_id"]
        ):
            raise ValueError("Graph tissue intent source differs from its prepared preview")
        job = (
            _by_key(workbench.project, intent["request_key"])
            if job_lookup is None
            else job_lookup(intent["request_key"])
        )
        if job is None:
            _authorize(workbench, native["operation"], body, authorize)
            if entry["state"] not in {"intent", "cancelled"}:
                raise ValueError("Graph child job is missing")
            continue
        if native["operation"] != "tissue_model_run" or job["state"] != "succeeded":
            _authorize(workbench, native["operation"], body, authorize)
        _check_job(workbench, intent, job, data["owner"])
        intent["job_id"] = job["id"]
        entry["state"] = job["state"]
        if job["state"] == "succeeded":
            binding = _check_output(workbench, plan, identity, intent, job)
            if entry.get("output") not in (None, binding):
                raise ValueError("Graph completed output revision changed")
            entry["output"] = binding
            completed[identity] = binding
            authorize_binding(workbench, "label-result", _copy(binding))
        elif entry.get("output") is not None:
            raise ValueError("Unfinished graph child claims a published output")
    data["outputs"] = {
        name: completed[ref["node"]]
        for name, ref in plan["definition"]["outputs"].items()
        if ref["node"] in completed
    }
    states = [entry["state"] for entry in data["nodes"].values()]
    if data["cancel_requested"]:
        data["state"] = (
            "cancelling"
            if any(state in {"queued", "running", "intent"} for state in states)
            else "cancelled"
        )
    elif any(state in {"failed", "cancelled", "interrupted"} for state in states):
        data["state"] = "failed"
    elif all(state == "succeeded" for state in states):
        data["state"] = "succeeded"
    elif any(state != "pending" for state in states):
        data["state"] = "running"
    return completed


def _status(workbench, doc):
    data = doc["data"]
    results = [
        {"node_id": identity, **entry["output"]}
        for identity, entry in data["nodes"].items()
        if entry.get("output") is not None
    ]
    return {
        "run": doc,
        "partial_results": results,
        "state": data["state"],
        "continuation_policy": {
            "owner": data["owner"],
            "ownership_transfer": False,
            "same_owner_may_advance": data["state"] not in TERMINAL
            and not data["cancel_requested"],
            "different_session_requires_native_approval": True,
            "interrupted_nodes_require_fresh_run": True,
        },
    }


def prepared_tissue_previews(workbench, source_id, *, authorize_binding, budget):
    """Discover only existing unused source-bound previews; no inference or grants."""
    from .research_tissue_models import MAX_PREVIEW_BYTES, PREVIEW_PREFIX, peek_preview
    from .workflow_graph import _tissue_preview

    source = workbench.project.source(checked_id(source_id), verify=True)
    used = set()
    runs = workbench.project.documents("workflow_run")
    if len(runs) > MAX_WORKFLOWS:
        raise ValueError("Study exceeds bounded prepared-preview discovery")
    for run in runs:
        plan = run["data"].get("plan", {})
        for name, binding in plan.get("bindings", {}).items():
            if plan.get("definition", {}).get("inputs", {}).get(name) == "tissue-preview":
                used.add(binding["preview_id"])
    with workbench.project.connection() as connection:
        rows = connection.execute(
            "SELECT value FROM metadata WHERE key LIKE ?", (PREVIEW_PREFIX + "%",)
        ).fetchall()
    if len(rows) > 64:
        raise ValueError("Prepared tissue preview cache exceeds its bounded entry count")
    ready, unavailable = [], 0
    for (encoded,) in rows:
        if len(encoded.encode()) > MAX_PREVIEW_BYTES + 1024:
            raise ValueError("Prepared tissue preview exceeds its bounded metadata size")
        stored = parse_json(encoded)
        request = stored.get("receipt", {}).get("request", {})
        if request.get("source_id") != source["id"]:
            continue
        if stored.get("preview_id") in used:
            unavailable += 1
            continue
        try:
            cached = peek_preview(
                workbench.project, {key: stored[key] for key in ("preview_id", "preview_hash")}
            )
            binding = {key: cached[key] for key in ("preview_id", "preview_hash", "receipt")}
            binding = _tissue_preview(workbench, binding, budget)
        except (KeyError, ValueError):
            unavailable += 1
            continue
        authorize_binding(workbench, "tissue-preview", _copy(binding))
        ready.append(binding)
    return {
        "previews": sorted(ready, key=lambda item: item["preview_id"]),
        "unavailable_count": unavailable,
    }


def continuation_receipt(workbench, doc, *, authorize, authorize_binding):
    """Inspect proven checkpoints without publishing, transferring or granting authority.

    A replacement graph retains only unfinished nodes. Completed output bindings
    become explicit inputs; their native job/request proof remains in this receipt.
    A source run must be stopped before a new owner may execute the replacement.
    """
    data = _copy(doc["data"])
    _validate_plan(workbench, data, data["owner"], authorize, authorize_binding)
    completed = _reconcile(workbench, data, authorize, authorize_binding)
    return _continuation_from_completed(workbench, doc, data, completed)


def _continuation_from_completed(workbench, doc, data, completed):
    """Pure derivation from already verified native job publications."""
    plan = data["plan"]
    definition = _copy(plan["definition"])
    pending = [node for node in definition["nodes"] if node["id"] not in completed]
    replacement_inputs, bindings, reused = {}, {}, {}
    for node in pending:
        for port, ref in node["inputs"].items():
            if "node" in ref and ref["node"] in completed:
                identity = ref["node"]
                if identity not in reused:
                    index = len(reused)
                    name = f"reused_{index}"
                    while name in definition["inputs"] or name in replacement_inputs:
                        index += 1
                        name = f"reused_{index}"
                    reused[identity] = name
                    replacement_inputs[name] = "label-result"
                    bindings[name] = completed[identity]
                node["inputs"][port] = {"input": reused[identity]}
            elif "input" in ref:
                name = ref["input"]
                replacement_inputs[name] = definition["inputs"][name]
                bindings[name] = plan["bindings"][name]
    definition.update(
        inputs=replacement_inputs,
        nodes=pending,
        outputs={
            name: ref for name, ref in definition["outputs"].items() if ref["node"] not in completed
        },
    )
    proposal = None
    if pending:
        validated = validate_definition(definition)
        proposal = {**validated, "bindings": validate_bindings(workbench, definition, bindings)}
    proofs = []
    for identity, binding in completed.items():
        intent = data["nodes"][identity]["intent"]
        job = _by_key(workbench.project, intent["request_key"])
        proofs.append(
            {
                "node_id": identity,
                "operation": intent["operation"],
                "request_key": intent["request_key"],
                "request_sha256": intent["request_sha256"],
                "job_id": job["id"],
                "job_owner": job.get("owner"),
                "output": binding,
            }
        )
    payload = {
        "schema": "loci.workflow-continuation/v1",
        "run_id": doc["id"],
        "run_revision": doc["revision"],
        "run_sha256": doc["data"]["run_sha256"],
        "owner": data["owner"],
        "workflow_id": data["workflow_id"],
        "workflow_revision": data["workflow_revision"],
        "definition_sha256": data["definition_sha256"],
        "plan_sha256": plan["plan_sha256"],
        "request_key": data["request_key"],
        "state": data["state"],
        "completed_nodes": proofs,
        "completed_outputs": {
            name: completed[ref["node"]]
            for name, ref in plan["definition"]["outputs"].items()
            if ref["node"] in completed
        },
        "uncompleted_nodes": [node["id"] for node in pending],
        "proposal": proposal,
        "can_start_fresh": bool(pending) and doc["data"]["state"] in {"failed", "cancelled"},
        "required_fresh_previews": [
            name for name, kind in replacement_inputs.items() if kind == "tissue-preview"
        ],
        "unavailable_reason": (
            "All workflow nodes are already complete"
            if not pending
            else "Refresh run status to retain the terminal state before continuing"
            if data["state"] in {"failed", "cancelled"}
            and doc["data"]["state"] not in {"failed", "cancelled"}
            else "Stop the original run before requesting fresh continuation"
            if doc["data"]["state"] not in {"failed", "cancelled"}
            else None
        ),
        "native_approval_required": True,
        "authority": "Fresh session, source/action grants and native human approval; no transfer",
    }
    return _copy({**payload, "continuation_sha256": _hash(payload)})


def continue_workflow_graph(
    workbench,
    request,
    *,
    owner,
    authorize,
    authorize_binding,
    approve_continuation,
    publication_guard=None,
):
    """Native-only fresh run from an exact, human-approved continuation receipt.

    The approver must validate native approval for this complete receipt, new owner,
    workflow ID and request key and return True. Agents cannot provide this callback.
    Every input and native operation is independently reauthorized for the new owner.
    An interrupted save/start may leave an inert saved definition, never a false run.
    """
    _exact(
        request,
        {
            "run_id",
            "run_revision",
            "run_sha256",
            "continuation_sha256",
            "workflow_id",
            "request_key",
        }
        | ({"preview_replacements"} if "preview_replacements" in request else set()),
        "graph continuation",
    )
    _validate_owner(owner)
    _callbacks(authorize, authorize_binding)
    if not callable(approve_continuation):
        raise PermissionError("Fresh graph continuation requires native human approval")
    doc = _run(workbench, request["run_id"])
    if (
        doc["revision"] != request["run_revision"]
        or doc["data"]["run_sha256"] != request["run_sha256"]
    ):
        raise ValueError("Continuation source run changed; inspect a fresh receipt")
    receipt = continuation_receipt(
        workbench,
        doc,
        authorize=authorize,
        authorize_binding=authorize_binding,
    )
    if receipt["continuation_sha256"] != _sha(request["continuation_sha256"], "Continuation"):
        raise ValueError("Continuation proof or completed work changed")
    if not receipt["can_start_fresh"]:
        raise ValueError("Stop the original run before continuing unfinished work")
    identity = checked_id(request["workflow_id"])
    if identity == doc["data"]["workflow_id"]:
        raise ValueError("Continuation requires a distinct saved workflow identity")
    key = checked_text(request["request_key"], "New continuation request key", 160)
    if key == doc["data"]["request_key"]:
        raise ValueError("Continuation requires a fresh run submission key")
    proposal = receipt["proposal"]
    preview_names = {
        name for name, kind in proposal["definition"]["inputs"].items() if kind == "tissue-preview"
    }
    replacements = request.get("preview_replacements", {})
    _exact(replacements, preview_names, "fresh continuation tissue previews")
    if replacements:
        for name, bound in replacements.items():
            if bound["receipt"]["request"] != proposal["bindings"][name]["receipt"]["request"]:
                raise ValueError(
                    "Fresh continuation preview changed its exact original source scope"
                )
        receipt["original_continuation_sha256"] = receipt["continuation_sha256"]
        proposal["bindings"].update(_copy(replacements))
        receipt["continuation_sha256"] = _hash(
            {key: value for key, value in receipt.items() if key != "continuation_sha256"}
        )
    # Validate fresh source scope and all presently resolvable native requests
    # before any native approval or persistent write.
    for name, binding in proposal["bindings"].items():
        authorize_binding(workbench, proposal["definition"]["inputs"][name], _copy(binding))
    fresh_plan = build_plan(workbench, proposal["definition"], proposal["bindings"])
    for node in fresh_plan["definition"]["nodes"]:
        if all("input" in ref for ref in node["inputs"].values()):
            native = resolve_node(
                workbench, proposal["definition"], proposal["bindings"], {}, node["id"]
            )
            _authorize(
                workbench,
                native["operation"],
                _native_request(workbench, native["operation"], native["request"]),
                authorize,
            )
    approval = {
        "receipt": receipt,
        "new_owner": owner,
        "workflow_id": identity,
        "request_key": key,
        "plan_sha256": fresh_plan["plan_sha256"],
    }
    if approve_continuation(_copy(approval)) is not True:
        raise PermissionError("Native approval does not authorize this exact continuation")

    def guard():
        if publication_guard is not None:
            publication_guard()
        current = _run(workbench, doc["id"])
        if current != doc:
            raise ValueError("Original run changed during continuation approval")
        for proof in receipt["completed_nodes"]:
            intent = doc["data"]["nodes"][proof["node_id"]]["intent"]
            job = _by_key(workbench.project, proof["request_key"])
            if job is None or job["state"] != "succeeded":
                raise ValueError("Completed continuation job changed after approval")
            _check_job(workbench, intent, job, doc["data"]["owner"])
            output = _check_output(workbench, doc["data"]["plan"], proof["node_id"], intent, job)
            if output != proof["output"]:
                raise ValueError("Completed continuation output changed after approval")

    guard()
    existing = workbench.project.documents("workflow", document_id=identity)
    if existing:
        saved = _get(workbench, identity)
        if saved["revision"] != 1 or saved["data"]["definition"] != proposal["definition"]:
            raise ValueError("Continuation workflow identity already contains other work")
    else:
        saved = execute_workflow_graph(
            workbench,
            "workflow_graph_save",
            {
                "workflow_id": identity,
                "expected_revision": 0,
                "definition": proposal["definition"],
            },
            publication_guard=guard,
        )["workflow"]
    response = execute_workflow_graph(
        workbench,
        "workflow_graph_start",
        {
            "workflow_id": identity,
            "workflow_revision": saved["revision"],
            "definition_sha256": saved["data"]["definition_sha256"],
            "bindings": proposal["bindings"],
            "plan_sha256": fresh_plan["plan_sha256"],
            "request_key": key,
        },
        owner=owner,
        authorize=authorize,
        authorize_binding=authorize_binding,
        publication_guard=guard,
        continuation=receipt,
    )
    return {**response, "continuation": receipt}


def guard_node_job(workbench, job):
    """Chain into native worker guards before execution and inside publication.

    Non-graph native jobs are unchanged. Native policy/session authorization stays
    in the normal worker. This additional guard closes the persisted-intent /
    submission cancellation race, without granting any operation authority.
    """
    key = job.get("request_key", "")
    if not key.startswith(KEY_PREFIX):
        return
    parts = key[len(KEY_PREFIX) :].split(":")
    if len(parts) != 2:
        raise ValueError("Malformed graph child submission key")
    run_id, node_id = parts
    doc = _run(workbench, run_id)
    data = doc["data"]
    if data["cancel_requested"] or data["state"] in TERMINAL | {"cancelling"}:
        raise PermissionError("Graph run stopped before native publication")

    # Native worker authorization remains independent. Reconcile every earlier
    # publication locally so invented completed bindings cannot enter a guard.
    def already_authorized(*_args):
        return None

    plan = _validate_plan(workbench, data, data["owner"], already_authorized, already_authorized)
    completed = _reconcile(
        workbench,
        data,
        already_authorized,
        already_authorized,
        validated_context=(plan["bindings"], plan["node_scopes"]),
    )
    entry = data["nodes"].get(node_id, {})
    intent = entry.get("intent")
    if not isinstance(intent, dict):
        raise ValueError("Native graph job has no persisted node intent")
    _check_job(workbench, intent, job, data["owner"])
    completed.pop(node_id, None)
    native = _resolve_node(
        workbench,
        plan["definition"],
        plan["bindings"],
        plan["node_scopes"],
        completed,
        node_id,
        retained_request=intent["request"],
    )
    if (
        native["operation"] != intent["operation"]
        or _native_request(workbench, native["operation"], native["request"]) != intent["request"]
    ):
        raise ValueError("Native graph job no longer resolves to its persisted request")


def execute_workflow_graph(
    workbench,
    operation,
    request,
    *,
    authorize=None,
    authorize_binding=None,
    submit=None,
    cancel=None,
    owner=None,
    publication_guard=None,
    approve_continuation=None,
    continuation=None,
):
    """Dispatch workflow_graph_* operations without creating a parent native job.

    authorize(wb, operation, native_request) checks current execution authority;
    authorize_binding(wb, kind, exact_binding) recursively checks all input/result
    authority. They are required for preflight/start/advance/status. Trusted local
    UI callers supply explicit local authority callbacks. submit(wb, op, req, key)
    may wrap JobSupervisor.start; its default only queues via submit_job. cancel
    accepts (project, job_id), matching cancel_job and JobSupervisor.cancel.
    """
    if operation not in OPERATIONS:
        raise ValueError("Unsupported workflow graph operation")
    suffix = operation.removeprefix("workflow_graph_")
    if suffix == "prepared_previews":
        _exact(request, {"source_id"}, operation)
        if not callable(authorize_binding):
            raise PermissionError("Prepared preview discovery requires current source authority")
        return prepared_tissue_previews(
            workbench,
            request["source_id"],
            authorize_binding=authorize_binding,
            budget=getattr(workbench, "_graph_memory_bytes", 8 * 1024**3),
        )
    if suffix == "continue":
        return continue_workflow_graph(
            workbench,
            request,
            owner=owner,
            authorize=authorize,
            authorize_binding=authorize_binding,
            approve_continuation=approve_continuation,
            publication_guard=publication_guard,
        )
    if suffix == "validate":
        _exact(request, {"definition"}, operation)
        return validate_definition(request["definition"])
    if suffix == "save":
        _exact(request, {"workflow_id", "expected_revision", "definition"}, operation)
        validated = validate_definition(request["definition"])
        docs = workbench.project.documents("workflow")
        if any(
            doc["id"] == request["workflow_id"] and doc["data"].get("schema") != SAVED_SCHEMA
            for doc in docs
        ):
            raise ValueError("A graph save cannot replace a workflow/v1 document")
        if len(docs) >= MAX_WORKFLOWS and not any(
            doc["id"] == request["workflow_id"] for doc in docs
        ):
            raise ValueError("Study exceeds its saved workflow bound")
        return {
            "workflow": workbench.project.put_document(
                "workflow",
                checked_id(request["workflow_id"]),
                {
                    "schema": SAVED_SCHEMA,
                    "definition": validated["definition"],
                    "definition_sha256": validated["definition_sha256"],
                },
                expected_revision=request["expected_revision"],
                publication_guard=publication_guard,
            )
        }
    if suffix == "save_from_run":
        _exact(
            request,
            {"run_id", "run_revision", "run_sha256", "workflow_id", "expected_revision", "name"},
            operation,
        )
        doc = _run(workbench, request["run_id"])
        _owner(doc["data"], owner)
        if (
            doc["revision"] != request["run_revision"]
            or doc["data"]["run_sha256"] != request["run_sha256"]
        ):
            raise ValueError("Successful run changed before definition capture")
        data = _copy(doc["data"])
        _validate_plan(workbench, data, owner, authorize, authorize_binding)
        _reconcile(workbench, data, authorize, authorize_binding)
        if data["state"] != "succeeded":
            raise ValueError("Capture requires a fully successful native workflow run")
        if request["workflow_id"] == data["workflow_id"]:
            raise ValueError("Capture requires a distinct saved workflow identity")
        definition = _copy(data["plan"]["definition"])
        definition["name"] = checked_text(request["name"], "Workflow name", 256)
        return execute_workflow_graph(
            workbench,
            "workflow_graph_save",
            {
                "workflow_id": request["workflow_id"],
                "expected_revision": request["expected_revision"],
                "definition": definition,
            },
            publication_guard=publication_guard,
        )
    if suffix == "continuation":
        _exact(request, {"run_id"}, operation)
        doc = _run(workbench, request["run_id"])
        _owner(doc["data"], owner)
        return {
            "continuation": continuation_receipt(
                workbench,
                doc,
                authorize=authorize,
                authorize_binding=authorize_binding,
            )
        }
    if suffix == "get":
        _exact(request, {"workflow_id"}, operation)
        return {"workflow": _get(workbench, request["workflow_id"])}
    if suffix == "list":
        _exact(request, set(), operation)
        docs = workbench.project.documents("workflow")
        if len(docs) > MAX_WORKFLOWS:
            raise ValueError("Study exceeds its saved workflow bound")
        return {
            "workflows": [
                _get(workbench, doc["id"])
                for doc in docs
                if doc["data"].get("schema") == SAVED_SCHEMA
            ]
        }
    if suffix == "preflight":
        doc, plan = _prepare(workbench, request, authorize, authorize_binding)
        return {"workflow": doc, "plan": plan}
    if suffix == "start":
        _exact(request, BINDING_KEYS | {"plan_sha256", "request_key"}, operation)
        _validate_owner(owner)
        key = checked_text(request["request_key"], "Graph submission key", 160)
        run_id = _hash([RUN_SCHEMA, workbench.project.meta["project_id"], key])[:32]
        existing = workbench.project.documents("workflow_run", document_id=run_id)
        if existing:
            doc = _run(workbench, run_id)
            _owner(doc["data"], owner)
            normalized_request = _copy(request)
            retained = doc["data"]["plan"]
            _exact(
                normalized_request["bindings"],
                set(retained["definition"]["inputs"]),
                "graph bindings",
            )
            for name, kind in retained["definition"]["inputs"].items():
                if kind == "tissue-preview":
                    # An idempotent retry may outlive the preview cache. Its
                    # retained exact run is already integrity/owner checked;
                    # normalize only a semantically identical wire receipt.
                    if not _preview_wire_equal(
                        normalized_request["bindings"][name], retained["bindings"][name]
                    ):
                        raise ValueError("Graph request changed: tissue preview binding differs")
                    normalized_request["bindings"][name] = retained["bindings"][name]
            if (
                doc["data"]["request_sha256"] != _hash(normalized_request)
                or doc["data"].get("continuation") != continuation
            ):
                raise ValueError(
                    "Graph request changed: submission key already binds different parameters"
                )
            # Idempotent recovery checks the retained exact plan/input authority;
            # completed tissue history does not depend on an evictable token cache.
            _validate_plan(workbench, doc["data"], owner, authorize, authorize_binding)
            return _status(workbench, doc)
        body = {key: request[key] for key in BINDING_KEYS}
        workflow, plan = _prepare(workbench, body, authorize, authorize_binding)
        if plan["plan_sha256"] != _sha(request["plan_sha256"], "Plan"):
            raise ValueError("Graph preflight plan changed before start")
        preview_ids = {
            bound["preview_id"]
            for name, bound in plan["bindings"].items()
            if plan["definition"]["inputs"][name] == "tissue-preview"
        }

        def start_guard():
            if publication_guard is not None:
                publication_guard()
            if not preview_ids:
                return
            # put_document invokes this under BEGIN IMMEDIATE: competing starts
            # serialize before checking all committed run bindings.
            runs = workbench.project.documents("workflow_run")
            if len(runs) >= MAX_WORKFLOWS:
                raise ValueError("Study exceeds bounded preview-use inspection")
            for retained in runs:
                if retained["id"] == run_id:
                    continue
                prior = retained["data"].get("plan", {})
                for name, bound in prior.get("bindings", {}).items():
                    if (
                        prior.get("definition", {}).get("inputs", {}).get(name) == "tissue-preview"
                        and bound["preview_id"] in preview_ids
                    ):
                        raise ValueError("Tissue preview is single-use; prepare a fresh preview")

        now = timestamp()
        data = {
            "schema": RUN_SCHEMA,
            "project_id": workbench.project.meta["project_id"],
            "workflow_id": workflow["id"],
            "workflow_revision": workflow["revision"],
            "definition_sha256": workflow["data"]["definition_sha256"],
            "request_key": key,
            "request_sha256": _hash({**request, "bindings": plan["bindings"]}),
            "plan": plan,
            "owner": owner,
            "state": "prepared",
            "cancel_requested": False,
            "nodes": {
                identity: {"state": "pending", "intent": None, "output": None}
                for identity in plan["node_order"]
            },
            "outputs": {},
            "created_at": now,
            "updated_at": now,
        }
        if continuation is not None:
            data["continuation"] = _copy(continuation)
        return _status(workbench, _commit(workbench, run_id, data, 0, start_guard))
    _exact(request, {"run_id"}, operation)
    doc = _run(workbench, request["run_id"])
    data = _copy(doc["data"])
    _owner(data, owner)
    if suffix == "cancel":
        if publication_guard is not None:
            publication_guard()
        if data["state"] == "succeeded":
            return _status(workbench, doc)
        data["cancel_requested"], data["state"] = True, "cancelling"
        doc = _commit(workbench, doc["id"], data, doc["revision"], publication_guard)
        data = _copy(doc["data"])
        active = False
        for entry in data["nodes"].values():
            intent = entry.get("intent")
            job = _by_key(workbench.project, intent["request_key"]) if intent else None
            if job is not None:
                _check_job(workbench, intent, job, owner)
                job = (cancel or cancel_job)(workbench.project, job["id"])
                entry["state"] = job["state"]
                active |= job["state"] in {"queued", "running"}
            elif entry["state"] != "succeeded":
                entry["state"] = "cancelled"
        data["state"] = "cancelling" if active else "cancelled"
        return _status(
            workbench, _commit(workbench, doc["id"], data, doc["revision"], publication_guard)
        )
    plan = _validate_plan(workbench, data, owner, authorize, authorize_binding)
    completed = _reconcile(workbench, data, authorize, authorize_binding)
    if data != doc["data"]:
        doc = _commit(workbench, doc["id"], data, doc["revision"], publication_guard)
        data = _copy(doc["data"])
    if suffix == "status" or data["state"] in TERMINAL or data["cancel_requested"]:
        return _status(workbench, doc)
    # Schedule at most one ready node per advance. The CAS intent is durable
    # before submission and its deterministic key survives every crash window.
    ready = None
    for node in plan["definition"]["nodes"]:
        entry = data["nodes"][node["id"]]
        if entry["state"] == "intent" or (submit is not None and entry["state"] == "queued"):
            ready = node
            break
        if entry["state"] == "pending" and all(
            "input" in ref or ref["node"] in completed for ref in node["inputs"].values()
        ):
            ready = node
            break
    if ready is None:
        return _status(workbench, doc)
    identity = ready["id"]
    native = resolve_node(workbench, plan["definition"], plan["bindings"], completed, identity)
    body = _native_request(workbench, native["operation"], native["request"])
    _authorize(workbench, native["operation"], body, authorize)
    entry = data["nodes"][identity]
    if entry["intent"] is None:
        entry["intent"] = {
            "operation": native["operation"],
            "request": body,
            "request_sha256": _hash(body),
            "request_key": f"{KEY_PREFIX}{doc['id']}:{identity}",
            "job_id": None,
        }
        if native["operation"] == "tissue_model_run":
            entry["intent"]["source_id"] = plan["node_scopes"][identity]["source_id"]
        entry["state"], data["state"] = "intent", "running"
        doc = _commit(workbench, doc["id"], data, doc["revision"], publication_guard)
    # Re-read cancellation after persisting the intent. The native publication
    # guard additionally covers cancellation racing the following submit call.
    latest = _run(workbench, doc["id"])
    if latest["data"]["cancel_requested"]:
        return _status(workbench, latest)
    intent = latest["data"]["nodes"][identity]["intent"]
    if publication_guard is not None:
        publication_guard()
    if submit is None:
        job = submit_job(
            workbench,
            intent["request"],
            intent["request_key"],
            operation=intent["operation"],
            owner=owner,
        )
    else:
        job = submit(
            workbench, intent["operation"], _copy(intent["request"]), intent["request_key"]
        )
    job = workbench.project.job(job["id"])
    _check_job(workbench, intent, job, owner)
    latest = _run(workbench, doc["id"])
    if latest["data"]["cancel_requested"]:
        (cancel or cancel_job)(workbench.project, job["id"])
        return _status(workbench, latest)
    data = _copy(latest["data"])
    data["nodes"][identity]["intent"]["job_id"] = job["id"]
    data["nodes"][identity]["state"] = job["state"]
    return _status(
        workbench, _commit(workbench, latest["id"], data, latest["revision"], publication_guard)
    )


class _SnapshotProject:
    """Read-only in-memory snapshot access; never opens source or artifact paths."""

    def __init__(self, sources, results, documents, project_id):
        self.sources = sources
        self.results = results
        self.records = documents
        self.meta = {"project_id": project_id}

    def source(self, identity, **_kwargs):
        source = self.sources.get(checked_id(identity))
        if source is None or source.get("id") != identity:
            raise ValueError("Graph snapshot source is unavailable")
        _sha(source.get("sha256"), "Snapshot source")
        if source.get("metadata", {}).get("sha256", source["sha256"]) != source["sha256"]:
            raise ValueError("Graph snapshot source metadata identity differs")
        return source

    def result(self, identity, **_kwargs):
        result = self.results.get(checked_id(identity))
        if result is None or result.get("id") != identity:
            raise ValueError("Graph snapshot result is unavailable")
        if _hash(
            {key: value for key, value in result.items() if key != "revision_hash"}
        ) != result.get("revision_hash"):
            raise ValueError("Graph snapshot result revision integrity failed")
        if self.source(result["source_id"])["sha256"] != result["source_sha256"]:
            raise ValueError("Graph snapshot result source fingerprint differs")
        return result

    def documents(self, kind, *, document_id=None):
        return [
            doc
            for doc in self.records
            if doc["kind"] == kind and (document_id is None or doc["id"] == document_id)
        ]


def _namespace(value):
    from types import SimpleNamespace

    if isinstance(value, dict):
        return SimpleNamespace(**{key: _namespace(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return [_namespace(item) for item in value]
    return value


class _SnapshotWorkbench:
    """Metadata-only adapter to the same code-owned graph and geometry contracts."""

    def __init__(self, project):
        self.project = project

    def _session(self, source_id):
        from types import SimpleNamespace

        from .native_image import NativeDimensions, NativeImageSession

        source = self.project.source(source_id)
        metadata = _namespace(source["metadata"])
        metadata.dimensions = NativeDimensions(**source["metadata"]["dimensions"])
        for level, value in zip(metadata.levels, source["metadata"]["levels"], strict=True):
            level.dimensions = NativeDimensions(**value["dimensions"])
        session = SimpleNamespace(metadata=metadata, _ensure_open=lambda: None)
        if source["source_kind"] == "whole_slide":
            from .slide_adapter import SlideAdapter

            session.slide = SimpleNamespace(metadata=metadata.whole_slide)
            session.geometry = lambda selection, volume: SlideAdapter.geometry(
                session, selection, volume
            )
        elif source["source_kind"] == "ome_zarr":
            from .zarr_adapter import ZarrAdapter

            session.store = SimpleNamespace(metadata=metadata.ome_zarr)
            session.geometry = lambda selection, volume: ZarrAdapter.geometry(
                session, selection, volume
            )
        else:
            session.geometry = lambda selection, volume: NativeImageSession.geometry(
                session, selection, volume
            )
        return session

    def _native_geometry(self, session, selection, volume):
        return session.geometry(selection, volume)

    def selection(self, source_id, value):
        from .workbench import Workbench

        return Workbench.selection(self, source_id, value)

    def validate_recipe(self, request):
        # The definition's strict native recipe schema has already been checked.
        # Resolve native defaults without a synthetic segmentation probe.
        body = _copy(request)
        recipe = body["recipe"]
        rgb = recipe.get("input_transform") == "rgb_intensity"
        normalized = {
            "steps": recipe.get("steps", []),
            "segmentation": recipe.get("segmentation"),
            "measurement_channels": recipe.get(
                "measurement_channels", [] if rgb else [body["selection"]["c"]]
            ),
            "gates": recipe.get("gates", []),
            "working_bytes": recipe["working_bytes"],
        }
        if rgb:
            normalized["input_transform"] = "rgb_intensity"
        return {**body, "recipe": normalized}


def validate_workflow_graph_document(document, sources, results, documents=(), jobs=()):
    """Validate a portable v2 definition/run against exact in-memory snapshots.

    sources/results/jobs accept ID-keyed mappings or record lists. Pass the whole
    document set and native jobs (including historical job envelopes on import).
    No source file, pixel artifact, current runtime, policy or session is opened;
    this validates retained identities/provenance and grants no resume authority.
    Live resume still rechecks files, runtime, owner/session and native grants.
    """

    def mapping(records):
        values = list(records.values()) if isinstance(records, dict) else list(records)
        output = {record["id"]: record for record in values}
        if len(output) != len(values):
            raise ValueError("Duplicate graph snapshot record identities")
        return output

    checked_id(document.get("id"))
    integer(document.get("revision"), "graph document revision", 1, 2**31 - 1)
    if document.get("kind") not in {"workflow", "workflow_run"}:
        raise ValueError("Choose a saved graph or graph run document")
    all_documents = list(documents.values()) if isinstance(documents, dict) else list(documents)
    if not any(
        doc["kind"] == document["kind"] and doc["id"] == document["id"] for doc in all_documents
    ):
        all_documents.append(document)
    data = document["data"]
    project = _SnapshotProject(
        mapping(sources), mapping(results), all_documents, data.get("project_id")
    )
    workbench = _SnapshotWorkbench(project)
    project._workflow_jobs_by_key = {job["request_key"]: job for job in mapping(jobs).values()}
    if document["kind"] == "workflow":
        _get(workbench, document["id"])
        return
    checked_id(data.get("project_id"))
    doc = _run(workbench, document["id"])
    data = _copy(doc["data"])
    _validate_owner(data["owner"])
    plan = data["plan"]
    if not isinstance(plan, dict):
        raise ValueError("Portable graph plan must be an object")
    validated = validate_definition(plan.get("definition"))
    method_operations = {node["operation"] for node in validated["definition"]["nodes"]} & {
        "morphometrics_run",
        "annotation_evaluation_run",
    }
    _exact(
        plan,
        {
            "schema",
            "definition",
            "definition_sha256",
            "bindings",
            "bindings_sha256",
            "node_order",
            "adapter_versions",
            "node_scopes",
            "runtime",
            "plan_sha256",
        }
        | ({"method_identities"} if method_operations else set())
        | (
            {"tissue_runtime"}
            if any(
                node["operation"] == "tissue_model_run" for node in validated["definition"]["nodes"]
            )
            else set()
        ),
        "portable graph plan",
    )
    if (
        plan["schema"] != PLAN_SCHEMA
        or _hash({key: value for key, value in plan.items() if key != "plan_sha256"})
        != plan["plan_sha256"]
    ):
        raise ValueError("Graph snapshot plan integrity failed")
    if "tissue_runtime" in plan:
        from .research_tissue_integration import validate_host_runtime

        validate_host_runtime(plan["tissue_runtime"], engine_version=plan["runtime"]["engine"])
    if "method_identities" in plan:
        _exact(plan["method_identities"], method_operations, "portable graph methods")
        for method in plan["method_identities"].values():
            _exact(
                method, {"engine", "kernel_sha256", "dispatcher_sha256"}, "portable graph method"
            )
            checked_text(method["engine"], "Graph method engine identity", 64)
            for key in ("kernel_sha256", "dispatcher_sha256"):
                _sha(method[key], "Graph method")
    bindings = validate_bindings(workbench, validated["definition"], plan["bindings"])
    if (
        validated["definition"] != plan["definition"]
        or validated["definition_sha256"] != plan["definition_sha256"]
        or plan["definition_sha256"] != data["definition_sha256"]
        or validated["node_order"] != plan["node_order"]
        or _hash(bindings) != plan["bindings_sha256"]
        or _lineage_scopes(workbench, plan["definition"], bindings) != plan["node_scopes"]
        or {
            node["operation"]: ADAPTER_VERSIONS[node["operation"]]
            for node in plan["definition"]["nodes"]
        }
        != plan["adapter_versions"]
    ):
        raise ValueError("Graph snapshot plan contracts or scientific input scopes differ")
    _exact(data["nodes"], set(plan["node_order"]), "snapshot graph nodes")
    saved = _get(workbench, data["workflow_id"])
    if saved["revision"] < data["workflow_revision"] or (
        saved["revision"] == data["workflow_revision"]
        and saved["data"]["definition_sha256"] != data["definition_sha256"]
    ):
        raise ValueError("Graph snapshot saved workflow reference is inconsistent")
    jobs_by_id = mapping(jobs)
    jobs_by_key = {job["request_key"]: job for job in jobs_by_id.values()}
    if len(jobs_by_key) != len(jobs_by_id):
        raise ValueError("Graph snapshot jobs have duplicate submission keys")
    declared = _copy(data)

    def snapshot_authority(*_args):
        return None

    _reconcile(workbench, data, snapshot_authority, snapshot_authority, job_lookup=jobs_by_key.get)
    for identity, entry in declared["nodes"].items():
        if entry.get("output") is not None and entry["output"] != data["nodes"][identity].get(
            "output"
        ):
            raise ValueError("Graph snapshot completed output has no exact native publication")
        if entry["state"] == "succeeded" and data["nodes"][identity]["state"] != "succeeded":
            raise ValueError("Graph snapshot completed node has no successful native job")
    for name, binding in declared["outputs"].items():
        if data["outputs"].get(name) != binding:
            raise ValueError("Graph snapshot named output has no exact completed result")
    if declared["state"] == "succeeded" and (
        data["state"] != "succeeded" or declared["outputs"] != data["outputs"]
    ):
        raise ValueError("Graph snapshot success lacks its complete native output receipts")
