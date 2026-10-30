"""Policy scopes for named native shared-workflow actions.

Numerical execution stays in the Workbench. The views below constrain document
queries before native validators run, so unrelated study rows never become a
response or an enumeration/count side channel.
"""

from __future__ import annotations

import copy

from .research_project import canonical_json, checked_id, parse_json

SHARED_ACTIONS = frozenset(
    {
        "workflow_list",
        "workflow_get",
        "workflow_preflight",
        "workflow_preview",
        "workflow_run",
        "workflow_status",
        "exploration_list",
        "exploration_get",
        "exploration_preview",
        "exploration_compare",
        "exploration_run",
        "population_gate_evaluate",
        "population_group_list",
        "population_group_get",
        "study_summary",
        "intensity_catalog",
        "intensity_preview",
        "intensity_get",
        "intensity_list",
        "spatial_density_preview",
        "spatial_density_save",
        "spatial_density_get",
        "spatial_density_list",
        "spatial_density_query",
        "task_preview_get",
    }
)


def _documents(agent, workbench, kind, *, identity=None, filters=()):
    """Bounded, parameterized queries, with only code-owned JSON paths."""
    query = "SELECT record FROM documents WHERE kind=?"
    values = [kind]
    if kind == "intensity_report" and identity is None:
        # Restrict candidate reports before the bounded materialization. Full
        # result/reference/channel authority is still checked independently.
        query += (
            " AND NOT EXISTS (SELECT 1 FROM json_each(record, '$.data.bindings') b "
            "WHERE json_extract(b.value, '$.source_id') NOT IN "
            "(SELECT value FROM json_each(?)))"
        )
        values.append(canonical_json(sorted(agent.policy.sources)))
    if kind == "spatial_density_report":
        # Source filtering is performed in SQL before bounded materialization.
        # The code-owned predicate then checks complete selection/channel/runtime
        # authority before a report can enter enumeration or its byte/count budget.
        query += (
            " AND json_type(record, '$.data.source_snapshots')='array'"
            " AND json_array_length(record, '$.data.source_snapshots')>0"
            " AND NOT EXISTS (SELECT 1 FROM json_each(record, '$.data.source_snapshots') s "
            "WHERE COALESCE(json_extract(s.value, '$.id'), '') NOT IN "
            "(SELECT value FROM json_each(?)))"
        )
        values.append(canonical_json(sorted(agent.policy.sources)))
        if identity is None:
            query += " AND loci_density_scope(record)=1"
    if identity is not None:
        query += " AND id=?"
        values.append(checked_id(identity))
    for path, value in filters:
        query += " AND json_extract(record, ?)=?"
        values.extend([path, value])
    query += " ORDER BY rowid"
    documents, used = [], 0
    with workbench.project.connection() as connection:
        if kind == "spatial_density_report" and identity is None:

            def allowed(encoded):
                agent.policy.recheck()
                try:
                    _density_report_scope(agent, workbench, parse_json(encoded)["data"])
                except (PermissionError, ValueError, KeyError, TypeError):
                    return 0
                return 1

            connection.create_function("loci_density_scope", 1, allowed)
        for row in connection.execute(query, values):
            agent.policy.recheck()
            used += len(row[0].encode())
            if len(documents) >= 1024 or used > min(8 * 1024**2, agent.policy.memory_bytes // 8):
                raise PermissionError("Scoped documents exceed the delegated inspection budget")
            documents.append(parse_json(row[0]))
    return documents


class _ProjectView:
    def __init__(self, project, documents, source_ids=()):
        self._source_ids = frozenset(source_ids)
        self._project = project
        self._documents = documents

    def __getattr__(self, name):
        return getattr(self._project, name)

    def documents(self, kind, *, document_id=None):
        if kind == "channels" and kind not in self._documents:
            return [
                doc
                for identity in sorted(self._source_ids)
                if document_id is None or identity == document_id
                for doc in self._project.documents(kind, document_id=identity)
            ]
        if kind not in self._documents:
            raise PermissionError("This action has no authority to enumerate that document kind")
        return [
            doc for doc in self._documents[kind] if document_id is None or doc["id"] == document_id
        ]


def _view(workbench, documents, source_ids=()):
    view = copy.copy(workbench)
    view.project = _ProjectView(workbench.project, documents, source_ids)
    return view


def _result(agent, workbench, identity, revision=None, *, _seen=None):
    identity = checked_id(identity)
    seen = {} if _seen is None else _seen
    if identity in seen:
        result = workbench.project.result(identity)
        if revision is not None and result["revision_hash"] != revision:
            raise PermissionError("Action result revision changed; inspect it again")
        return result
    if len(seen) >= 1024:
        raise PermissionError("Result runtime dependencies exceed the delegated bound")
    seen[identity] = 0
    result = agent._authorize_result(workbench, identity)
    if revision is not None and result["revision_hash"] != revision:
        raise PermissionError("Action result revision changed; inspect it again")
    runtime = result["provenance"].get("runtime")
    if not isinstance(runtime, dict):
        raise PermissionError("Result runtime identity is unverifiable")
    agent.policy.require_runtime(runtime)
    agent.policy.require_model(result["provenance"].get("model"))
    from .agent_actions import source_scope

    provenance = result["provenance"]
    for reference in provenance.get("references", {}).values():
        if isinstance(reference, dict) and "selection" in reference:
            source_scope(
                agent.policy, workbench, reference["source_id"], reference["selection"], []
            )
    dependencies = [*provenance.get("temporal_inputs", [])]
    dependencies.extend(provenance.get("association_inputs", {}).values())
    dependencies.extend(provenance.get("spatial", {}).get("inputs", {}).values())
    dependencies.extend(
        provenance.get("compartment_measurement", {}).get("label_inputs", {}).values()
    )
    dependencies.extend(
        provenance[key]
        for key in ("parent_result", "fixed_result", "moving_result")
        if key in provenance
    )
    dependencies.extend(
        {"result_id": item.get("parent_result_id")} for item in provenance.get("annotations", [])
    )
    if result.get("parent_id") is not None:
        dependencies.append({"result_id": result["parent_id"]})
    for dependency in dependencies:
        if not dependency.get("missing_reason"):
            _result(
                agent,
                workbench,
                dependency.get("result_id"),
                dependency.get("revision_hash"),
                _seen=seen,
            )
    # Measurements can be embedded in provenance rather than separately loaded
    # arrays. Account for both before a native aggregation builds another copy.
    size = len(canonical_json(result).encode())
    seen[identity] = size
    if sum(seen.values()) > agent.policy.memory_bytes // 8:
        raise PermissionError("Result measurements exceed the delegated inspection budget")
    return result


def _results(agent, workbench, identities):
    if not isinstance(identities, list) or not 1 <= len(identities) <= 100:
        raise ValueError("Choose 1-100 explicit result identities")
    if len(set(identities)) != len(identities):
        raise ValueError("Result identities must be unique")
    seen = {}
    results = [_result(agent, workbench, identity, _seen=seen) for identity in identities]
    if (
        sum(len(canonical_json(result).encode()) for result in results)
        > agent.policy.memory_bytes // 8
    ):
        raise PermissionError("Selected measurements exceed the delegated inspection budget")
    return results


def _report_scope(agent, workbench, document):
    report = document["data"]
    _results(agent, workbench, report.get("result_ids"))
    # Native reference validation includes secondary compartment producers, but
    # permission must be checked before any such native producer read.
    for binding in report.get("bindings", []):
        _result(agent, workbench, binding.get("result_id"), binding.get("revision_hash"))
        for reference in (binding.get("label_inputs") or {}).values():
            _result(agent, workbench, reference.get("result_id"), reference.get("revision_hash"))


def _density_result(agent, workbench, identity, revision, seen):
    from .spatial_measurements import estimated_working_bytes

    result = _result(agent, workbench, identity, revision, _seen=seen)
    if "spatial" in result["provenance"]:
        shape = result["arrays"]["labels"]["shape"]
        retained = sum(d["bytes"] for d in result["arrays"].values())
        workspace = estimated_working_bytes(shape[0] * shape[1])
        if retained + workspace > agent.policy.memory_bytes // 2:
            raise PermissionError("Density masks exceed the delegated working-memory budget")
    return result


def _density_selection_scope(agent, workbench, fields):
    """Authorize exact spatial inputs and every phenotype dependency without widening grants."""
    seen, groups, visiting = {}, {}, set()
    group_bytes = 0

    def group(identity):
        nonlocal group_bytes
        if identity in visiting or len(visiting) >= 16 or len(groups) >= 256:
            raise PermissionError("Density phenotype dependencies exceed the delegated bound")
        if identity in groups:
            return groups[identity]
        documents = _documents(agent, workbench, "population_group", identity=identity)
        if len(documents) != 1:
            raise ValueError("Choose an exact saved density phenotype group")
        document = documents[0]
        from .research_groups import _record

        data = _record(document)
        group_bytes += len(canonical_json(document).encode())
        if group_bytes > agent.policy.memory_bytes // 8:
            raise PermissionError(
                "Density phenotype records exceed the delegated inspection budget"
            )
        binding = data["receipt"]
        _density_result(agent, workbench, binding["result_id"], binding["revision_hash"], seen)
        visiting.add(identity)
        for reference in data["definition"].get("groups", []):
            group(reference["group_id"])
        visiting.remove(identity)
        groups[identity] = document
        return document

    if not isinstance(fields, list) or not 1 <= len(fields) <= 256:
        raise ValueError("Choose 1-256 exact density fields")
    for field in fields:
        _density_result(agent, workbench, field["result_id"], field["revision_hash"], {})
        if "phenotype_group_id" in field:
            document = group(field["phenotype_group_id"])
            if document["data"]["record_sha256"] != field["phenotype_record_sha256"]:
                raise PermissionError("Density phenotype snapshot changed; inspect it again")
    return list(groups.values())


def _density_report_scope(agent, workbench, report):
    from .research_spatial_density import validate_report

    # Authorize each retained result BEFORE pure report reproduction/disclosure.
    # The source SQL filter is only a candidate filter, never the grant itself.
    seen = {}
    snapshots = report.get("result_bindings", report.get("result_snapshots"))
    if not isinstance(snapshots, list) or not 1 <= len(snapshots) <= 1024:
        raise ValueError("Density report requires bounded retained result snapshots")
    for result in snapshots:
        _density_result(
            agent,
            workbench,
            result["id"],
            result["revision_hash"],
            {} if "result_bindings" in report else seen,
        )
    validate_report(report)


def _density_view(agent, workbench, reports=(), fields=None):
    documents = {"spatial_density_report": list(reports), "population_group": [], "sample": []}
    if fields is not None:
        documents["population_group"] = _density_selection_scope(agent, workbench, fields)
        source_ids = {workbench.project.result(f["result_id"])["source_id"] for f in fields}
    else:
        source_ids, groups = set(), {}
        for document in reports:
            report = document["data"]
            _density_report_scope(agent, workbench, report)
            source_ids.update(
                f["result"]["source_id"] for f in report["aggregation"]["input_snapshots"]
            )
            for snapshot in report.get("phenotype_bindings", report.get("phenotype_groups", [])):
                actual = _documents(agent, workbench, "population_group", identity=snapshot["id"])
                if len(actual) != 1:
                    raise ValueError("Density retained phenotype group is unavailable")
                groups[snapshot["id"]] = actual[0]
        documents["population_group"] = list(groups.values())
    documents["sample"] = [
        doc
        for identity in sorted(source_ids)
        for doc in _documents(agent, workbench, "sample", identity=identity)
    ]
    return _ProjectView(workbench.project, documents, source_ids)


def _exploration_scope(agent, workbench, document):
    from .agent_actions import recipe_scope, source_scope
    from .research_exploration import validate_exploration_document

    record = document["data"]
    source = agent.policy.source_grant(workbench.project, record.get("source_id"))
    if record.get("source_sha256") != source.sha256:
        raise PermissionError("Exploration source fingerprint exceeds the grant")
    for selection in record.get("regions", []):
        source_scope(agent.policy, workbench, source.source_id, selection, [selection.get("c")])
    for cell in record.get("cells", []):
        receipt = cell["receipt"]
        agent.policy.require_runtime(receipt["runtime"])
        recipe_scope(
            agent.policy,
            workbench,
            {
                "source_id": receipt["source_id"],
                "selection": receipt["selection"],
                "recipe": receipt["effective_recipe"],
            },
        )
    validate_exploration_document(
        document, {source.source_id: workbench.project.source(source.source_id)}, {}
    )


def authorize_shared_action(agent, workbench, operation, request):
    """Authorize all native inputs without executing preview computation inline."""
    from .agent_actions import recipe_scope, source_scope

    policy = agent.policy
    if operation in {"workflow_preflight", "workflow_preview", "workflow_run"}:
        from .research_workflow import BINDING_KEYS, preflight

        policy.source_grant(workbench.project, request["source_id"])
        documents = _documents(agent, workbench, "workflow", identity=request["workflow_id"])
        resolved = preflight(
            _view(workbench, {"workflow": documents}, [request["source_id"]]),
            {key: request[key] for key in BINDING_KEYS},
        )
        recipe_scope(
            policy, workbench, {key: resolved[key] for key in ("source_id", "selection", "recipe")}
        )
    elif operation == "workflow_get":
        from .research_workflow import _get

        documents = _documents(agent, workbench, "workflow", identity=request["workflow_id"])
        _get(_view(workbench, {"workflow": documents}), request["workflow_id"])
    elif operation == "workflow_status":
        documents = _documents(agent, workbench, "workflow_run", identity=request["run_id"])
        if len(documents) != 1:
            raise ValueError("Workflow run receipt is unavailable; inspect its exact owned job")
        data = documents[0]["data"]
        _result(agent, workbench, data["result_id"], data["revision_hash"])
    elif operation.startswith("exploration_"):
        from .research_exploration import (
            _configuration,
            _matrix,
            _recipe,
            _selection,
            adoption_receipt,
        )

        if operation == "exploration_run":
            receipt = adoption_receipt(request)
            policy.require_runtime(receipt["runtime"])
            source_id, digest = receipt["source_id"], receipt["source_sha256"]
            pairs = [(receipt["selection"], receipt["effective_recipe"])]
        else:
            source_id, digest = request["source_id"], request["source_sha256"]
            if operation == "exploration_compare":
                regions, configurations = _matrix(request["regions"], request["configurations"])
                pairs = [
                    (selection, _recipe(selection, config))
                    for selection in regions
                    for config in configurations
                ]
            elif operation == "exploration_preview":
                selection = _selection(request["selection"])
                configuration = _configuration(
                    {key: request[key] for key in ("threshold", "min_size") if key in request}
                )
                pairs = [(selection, _recipe(selection, configuration))]
            else:
                pairs = []
        grant = policy.source_grant(workbench.project, source_id)
        if digest != grant.sha256:
            raise PermissionError("Exploration source fingerprint exceeds the grant")
        for selection, recipe in pairs:
            source_scope(policy, workbench, source_id, selection, recipe["measurement_channels"])
            recipe_scope(
                policy,
                workbench,
                {"source_id": source_id, "selection": selection, "recipe": recipe},
            )
        if operation == "exploration_get":
            documents = _documents(
                agent,
                workbench,
                "exploration",
                identity=request["comparison_id"],
                filters=(("$.data.source_id", source_id),),
            )
            if len(documents) != 1:
                raise ValueError("Saved comparison is unavailable in this source")
            _exploration_scope(agent, workbench, documents[0])
    elif operation == "spatial_density_preview":
        _density_selection_scope(agent, workbench, request["fields"])
    elif operation == "spatial_density_save":
        from .research_spatial_density import _candidate

        _density_report_scope(agent, workbench, _candidate(workbench.project, request))
    elif operation == "spatial_density_query":
        from .research_spatial_density import _load_preview

        if "report_id" in request:
            if "preview_id" in request or "preview_hash" in request:
                raise ValueError("Choose one exact density query identity")
            documents = _documents(
                agent, workbench, "spatial_density_report", identity=request["report_id"]
            )
            if len(documents) != 1:
                raise PermissionError("Density report is unavailable in the delegated scope")
            report = documents[0]["data"]
        else:
            report = _load_preview(
                workbench.project,
                {k: request[k] for k in ("preview_id", "preview_hash") if k in request},
            )
        _density_report_scope(agent, workbench, report)
    elif operation == "spatial_density_get":
        documents = _documents(
            agent, workbench, "spatial_density_report", identity=request["report_id"]
        )
        if len(documents) != 1:
            raise PermissionError("Density report is unavailable in the delegated scope")
        _density_report_scope(agent, workbench, documents[0]["data"])
    elif operation in {"study_summary", "intensity_catalog", "intensity_preview"}:
        _results(agent, workbench, request["result_ids"])
    elif operation == "intensity_get":
        documents = _documents(agent, workbench, "intensity_report", identity=request["report_id"])
        if len(documents) != 1:
            raise ValueError("Choose an exact saved intensity report")
        _report_scope(agent, workbench, documents[0])
    elif operation.startswith("population_"):
        _result(agent, workbench, request["result_id"], request["revision_hash"])
    elif operation == "task_preview_get":
        from .research_action_registry import PREVIEW_ACTIONS

        job = agent._authorize_job(workbench, request["job_id"])
        if job["state"] != "succeeded" or job["operation"] not in PREVIEW_ACTIONS:
            raise PermissionError("Choose an exact succeeded preview task")
        from .agent_actions import authorize_action

        authorize_action(
            agent, workbench, job["operation"], job["request"]["task_request"], mode="task"
        )
    policy.recheck()


def inspect_shared_action(agent, workbench, operation, request):
    """Execute a scoped native read. Called only inside the disposable worker."""
    if operation not in SHARED_ACTIONS:
        return workbench.execute(operation, request)
    if operation in {"workflow_list", "workflow_get", "workflow_preflight", "workflow_status"}:
        from .research_workflow import execute_workflow

        documents = {}
        if operation == "workflow_status":
            run = _documents(agent, workbench, "workflow_run", identity=request["run_id"])
            documents["workflow_run"] = run
            documents["workflow"] = _documents(
                agent, workbench, "workflow", identity=run[0]["data"]["workflow_id"]
            )
            documents["workflow_export"] = _documents(
                agent, workbench, "workflow_export", filters=(("$.data.run_id", request["run_id"]),)
            )
        else:
            documents["workflow"] = _documents(
                agent, workbench, "workflow", identity=request.get("workflow_id")
            )
        return execute_workflow(
            _view(workbench, documents, [request["source_id"]] if "source_id" in request else []),
            operation,
            request,
        )
    if operation in {"exploration_list", "exploration_get"}:
        from .research_exploration import dispatch_exploration

        documents = _documents(
            agent,
            workbench,
            "exploration",
            identity=request.get("comparison_id"),
            filters=(("$.data.source_id", request["source_id"]),),
        )
        allowed = []
        for document in documents:
            try:
                _exploration_scope(agent, workbench, document)
            except PermissionError:
                if operation == "exploration_get":
                    raise
                continue
            allowed.append(document)
        return dispatch_exploration(_view(workbench, {"exploration": allowed}), operation, request)
    if operation in {"population_group_list", "population_group_get"}:
        from .research_groups import dispatch_group

        documents = _documents(
            agent,
            workbench,
            "population_group",
            filters=(
                ("$.data.receipt.result_id", request["result_id"]),
                ("$.data.receipt.revision_hash", request["revision_hash"]),
            ),
        )
        # Every dependency is bound by the native reproducer to this same exact
        # result revision; the view cannot enumerate another result's groups.
        return dispatch_group(_view(workbench, {"population_group": documents}), operation, request)
    if operation in {
        "spatial_density_preview",
        "spatial_density_get",
        "spatial_density_list",
        "spatial_density_query",
    }:
        from .research_spatial_density import execute

        if operation == "spatial_density_preview":
            project = _density_view(agent, workbench, fields=request["fields"])
        elif operation == "spatial_density_query" and "preview_id" in request:
            from .research_spatial_density import _load_preview

            report = _load_preview(
                workbench.project, {k: request[k] for k in ("preview_id", "preview_hash")}
            )
            project = _density_view(agent, workbench, reports=[{"data": report}])
        else:
            documents = _documents(
                agent, workbench, "spatial_density_report", identity=request.get("report_id")
            )
            project = _density_view(agent, workbench, reports=documents)
        output = execute(project, operation, request, check=agent.policy.recheck)
        if operation == "spatial_density_get":
            output.pop("report", None)
        return output
    if operation in {"study_summary", "intensity_catalog", "intensity_preview"}:
        results = _results(agent, workbench, request["result_ids"])
        samples = [
            doc
            for result in results
            for doc in _documents(agent, workbench, "sample", identity=result["source_id"])
        ]
        view = _view(workbench, {"sample": samples}, [result["source_id"] for result in results])
        if operation == "study_summary":
            # Workbench.execute binds self; invoke the implementation on our view.
            return type(workbench).execute(view, operation, request)
        from .research_intensity_reports import execute

        return execute(view.project, operation, request, check=agent.policy.recheck)
    if operation == "intensity_get":
        from .research_intensity_reports import execute

        documents = _documents(agent, workbench, "intensity_report", identity=request["report_id"])
        results = _results(agent, workbench, documents[0]["data"]["result_ids"])
        samples = [
            doc
            for result in results
            for doc in _documents(agent, workbench, "sample", identity=result["source_id"])
        ]
        return execute(
            _ProjectView(
                workbench.project,
                {"intensity_report": documents, "sample": samples},
                [result["source_id"] for result in results],
            ),
            operation,
            request,
            check=agent.policy.recheck,
        )
    if operation == "intensity_list":
        from .research_intensity_reports import execute

        allowed = []
        for document in _documents(agent, workbench, "intensity_report"):
            try:
                _report_scope(agent, workbench, document)
            except PermissionError:
                continue
            allowed.append(document)
        return execute(
            _ProjectView(workbench.project, {"intensity_report": allowed}),
            operation,
            request,
            check=agent.policy.recheck,
        )
    return workbench.execute(operation, request)
