"""Exact spatial-density snapshots and native-granted atomic report packages.

Source/selection authorization belongs to the caller. ``input_result_ids`` exposes
all retained leaf identities for the existing recursive agent grant verifier.
Reports retain declared sample metadata; changes mark status stale, never rewrite
historical donor endpoints. No pixels or private source locators cross this API.
"""

from __future__ import annotations

import copy
import hashlib
import os
import shutil
import sys
import uuid
from contextlib import suppress
from pathlib import Path

from .export import _rename_noreplace
from .quantitative import exact_keys
from .research_data_export import (
    _DIRECTORY_FLAGS,
    _capability,
    _destination,
    _identity,
    _verify_files,
)
from .research_project import (
    SHA_PATTERN,
    canonical_json,
    checked_id,
    checked_text,
    parse_json,
    timestamp,
)
from .spatial_density import MAX_FIELDS, aggregate_spatial_density

DOCUMENT_KIND = "spatial_density_report"
GRANT_KIND = "spatial_density_export_grant"
LEGACY_SCHEMA = "loci.spatial-density-report/v1"
SCHEMA = "loci.spatial-density-report/v2"
PREVIEW_PREFIX = "spatial-density-preview:"
MAX_PREVIEWS = 8
MAX_PREVIEW_BYTES = 8 * 1024**2
PAGE_BYTES = 64 * 1024
MAX_REPORT_BYTES = 12 * 1024**2
MAX_RESULTS = 1024
MAX_GROUPS = 256
MAX_PACKAGE_BYTES = 64 * 1024**2
TABLES = (
    "field_rows",
    "donor_rows",
    "condition_rows",
    "paired_rows",
    "paired_summary",
    "unmatched_donors",
    "exclusion_audit",
)


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _same(left, right):
    return canonical_json(left) == canonical_json(right)


def _sha(value):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Density input requires an exact SHA-256")
    return value


def _exact(value, keys, name):
    exact_keys(value, keys, name)
    if set(value) != keys:
        raise ValueError(f"{name} requires every declared field")


def _sample(project, source_id):
    documents = project.documents("sample", document_id=source_id)
    if len(documents) > 1:
        raise ValueError("Source has ambiguous sample metadata")
    return documents[0] if documents else None


def _source_snapshot(source):
    return {
        "id": source["id"],
        "sha256": source["sha256"],
        **({"derivation": source["derivation"]} if "derivation" in source else {}),
    }


def _bindings(result):
    """Use the same bounded dependency vocabulary as agent_study.authorize_result."""
    p = result["provenance"]
    bindings = list(p.get("temporal_inputs", []))
    bindings.extend(p.get("association_inputs", {}).values())
    bindings.extend(p.get("spatial", {}).get("inputs", {}).values())
    bindings.extend(p.get("compartment_measurement", {}).get("label_inputs", {}).values())
    bindings.extend(
        p[key] for key in ("parent_result", "fixed_result", "moving_result") if key in p
    )
    bindings.extend({"result_id": a["parent_result_id"]} for a in p.get("annotations", []))
    if result.get("parent_id"):
        bindings.append({"result_id": result["parent_id"]})
    if len(bindings) > MAX_RESULTS:
        raise ValueError("Density dependencies exceed the bounded input graph")
    for binding in bindings:
        if not isinstance(binding, dict):
            raise ValueError("Invalid density result dependency")
        if not binding.get("missing_reason"):
            checked_id(binding.get("result_id"))
            yield binding


def _sources_for_result(result):
    p = result["provenance"]
    identities = {result["source_id"]}
    identities.update(value["source_id"] for value in p.get("references", {}).values())
    identities.update(
        value["source_id"] for value in p.get("compartment_measurement", {}).get("channels", [])
    )
    return identities


def _check_binding(binding, result):
    for key in ("revision_hash", "source_id", "source_sha256"):
        if key in binding and binding[key] != result[key]:
            raise ValueError("Density result dependency is stale or mismatched")


def _resolve_results(project, identities, check, *, verify_sources=True):
    results, sources, visiting = {}, {}, set()
    used_bytes = 0

    def visit(identity):
        nonlocal used_bytes
        if check:
            check()
        if identity in visiting or len(visiting) >= 64:
            raise ValueError("Density dependencies are cyclic or too deep")
        if identity in results:
            return results[identity]
        if len(results) + len(visiting) >= MAX_RESULTS:
            raise ValueError("Density dependencies exceed the bounded input graph")
        visiting.add(identity)
        result = project.result(identity)
        used_bytes += len(canonical_json(result).encode())
        if used_bytes > MAX_REPORT_BYTES:
            raise ValueError("Density dependencies exceed the bounded snapshot byte limit")
        if result.get("schema") != "loci.research-result/v1":
            raise ValueError("Spatial density supports bounded v1 results only")
        for source_id in _sources_for_result(result):
            if source_id not in sources:
                sources[source_id] = _source_snapshot(
                    project.source(source_id, verify=verify_sources, check=check)
                )
                used_bytes += len(canonical_json(sources[source_id]).encode())
                if used_bytes > MAX_REPORT_BYTES:
                    raise ValueError("Density dependencies exceed the bounded snapshot byte limit")
        if sources[result["source_id"]]["sha256"] != result["source_sha256"]:
            raise ValueError("Density source fingerprint changed")
        for binding in _bindings(result):
            _check_binding(binding, visit(binding["result_id"]))
        results[identity] = result
        visiting.remove(identity)
        return result

    for identity in identities:
        visit(identity)
    return results, sources


def _groups(project, selected):
    from .research_groups import _record

    retained, visiting = {}, set()
    used_bytes = 0

    def visit(identity):
        nonlocal used_bytes
        if identity in visiting or len(visiting) >= 16:
            raise ValueError("Density phenotype dependencies are cyclic or too deep")
        if identity in retained:
            return retained[identity]
        if len(retained) + len(visiting) >= MAX_GROUPS:
            raise ValueError("Density phenotype dependencies exceed the group limit")
        documents = project.documents("population_group", document_id=checked_id(identity))
        if len(documents) != 1:
            raise ValueError("Choose an exact saved phenotype group")
        document = documents[0]
        data = _record(document)
        used_bytes += len(canonical_json(document).encode())
        if used_bytes > MAX_REPORT_BYTES:
            raise ValueError("Density phenotypes exceed the bounded snapshot byte limit")
        visiting.add(identity)
        for reference in data["definition"].get("groups", []):
            visit(reference["group_id"])
        visiting.remove(identity)
        retained[identity] = document
        return document

    for identity in selected:
        visit(identity)
    return retained


def _replay(report):
    from .research_groups import _record, validate_group_document
    from .research_interchange import _reject_absolute_strings, _validate_result_crossrefs

    _exact(
        report,
        {
            "schema",
            "created_at",
            "software",
            "aggregation",
            "result_snapshots",
            "source_snapshots",
            "phenotype_groups",
            "report_hash",
        },
        "spatial density report",
    )
    if report["schema"] != LEGACY_SCHEMA:
        raise ValueError("Unsupported spatial density report schema")
    checked_text(report["created_at"], "Density report timestamp", 64)
    _exact(
        report["software"],
        {"engine", "aggregation_sha256", "dispatcher_sha256"},
        "density software",
    )
    checked_text(report["software"]["engine"], "Engine version", 64)
    for key in ("aggregation_sha256", "dispatcher_sha256"):
        _sha(report["software"][key])
    if len(canonical_json(report).encode()) > MAX_REPORT_BYTES:
        raise ValueError("Density report exceeds its bounded snapshot byte limit")
    _reject_absolute_strings(report, "Density report")
    if report["report_hash"] != _hash({k: v for k, v in report.items() if k != "report_hash"}):
        raise ValueError("Density report failed integrity verification")
    results, sources, groups = {}, {}, {}
    for key, limit, target in (
        ("result_snapshots", MAX_RESULTS, results),
        ("source_snapshots", MAX_RESULTS, sources),
        ("phenotype_groups", MAX_GROUPS, groups),
    ):
        records = report[key]
        if not isinstance(records, list) or len(records) > limit:
            raise ValueError("Density retained inputs exceed their bounded snapshot count")
        for record in records:
            identity = checked_id(record.get("id"))
            if identity in target:
                raise ValueError("Density snapshot repeats an input identity")
            target[identity] = record
        if [r["id"] for r in records] != sorted(target):
            raise ValueError("Density snapshots must retain canonical identity order")
    for source in sources.values():
        exact_keys(source, {"id", "sha256", "derivation"}, "density source snapshot")
        _sha(source.get("sha256"))
    for result in results.values():
        if result.get("schema") != "loci.research-result/v1" or result.get(
            "revision_hash"
        ) != _hash({k: v for k, v in result.items() if k != "revision_hash"}):
            raise ValueError("Density result snapshot failed integrity verification")
        source = sources.get(result["source_id"])
        if source is None or source["sha256"] != result["source_sha256"]:
            raise ValueError("Density result source snapshot is missing or mismatched")
        for binding in _bindings(result):
            bound = results.get(binding["result_id"])
            if bound is None:
                raise ValueError("Density retained result dependency is missing")
            _check_binding(binding, bound)
        _validate_result_crossrefs(result, sources, results)
    for document in groups.values():
        _record(document)
        validate_group_document(document, sources, results, list(groups.values()))
    aggregation = report["aggregation"]
    expected = aggregate_spatial_density(
        aggregation["input_snapshots"],
        phenotype_name=aggregation["phenotype_name"],
        stratum=aggregation["stratum"],
        condition_pair=aggregation["condition_pair"],
    )
    if not _same(expected, aggregation):
        raise ValueError("Density report is not reproducible from its retained input snapshots")
    selected = set()
    selected_groups = set()
    for field in aggregation["input_snapshots"]:
        result = field["result"]
        selected.add(result["id"])
        if not _same(results.get(result["id"]), result):
            raise ValueError("Density field differs from its retained result snapshot")
        phenotype = field["phenotype"]
        if phenotype is not None:
            selected_groups.add(phenotype["id"])
            if not _same(groups.get(phenotype["id"]), phenotype):
                raise ValueError("Density phenotype differs from its retained group snapshot")
    # Refuse unrelated records: authorization is exactly the graph retained here.
    reachable, active = set(), set()

    def visit(identity):
        if identity in active or len(active) >= 64:
            raise ValueError("Density retained result graph is cyclic or too deep")
        if identity in reachable:
            return
        active.add(identity)
        for binding in _bindings(results[identity]):
            visit(binding["result_id"])
        active.remove(identity)
        reachable.add(identity)

    for identity in selected:
        visit(identity)
    if reachable != set(results):
        raise ValueError("Density report contains unrelated retained results")
    needed_sources = set().union(*(_sources_for_result(r) for r in results.values()))
    if needed_sources != set(sources):
        raise ValueError("Density report contains missing or unrelated source snapshots")
    needed_groups = set()

    def group_visit(identity):
        if identity in needed_groups:
            return
        needed_groups.add(identity)
        for reference in groups[identity]["data"]["definition"].get("groups", []):
            group_visit(reference["group_id"])

    for identity in selected_groups:
        group_visit(identity)
    if needed_groups != set(groups):
        raise ValueError("Density report contains unrelated phenotype groups")
    return copy.deepcopy(report)


def validate_report(report):
    """Pure replay validator used by project open, interchange, save and getters."""
    try:
        return (
            _replay_compact(report)
            if isinstance(report, dict) and report.get("schema") == SCHEMA
            else _replay(report)
        )
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError("Malformed spatial density report or retained input") from exc


def input_result_ids(report):
    report = validate_report(report)
    key = "result_bindings" if report["schema"] == SCHEMA else "result_snapshots"
    return [result["id"] for result in report[key]]


def _verify_arrays(project, results, check):
    from .research_spatial import validate_arrays
    from .spatial_measurements import estimated_working_bytes

    for result in results:
        if check:
            check()
        if "spatial" in result["provenance"]:
            # Verify descriptor/header/hash bounds before materializing the bundle.
            # The retained masks plus distance workspace share one explicit budget.
            for descriptor in result["arrays"].values():
                project.verify_array(descriptor)
            shape = result["arrays"]["labels"]["shape"]
            retained = sum(d["bytes"] for d in result["arrays"].values())
            workspace = estimated_working_bytes(shape[0] * shape[1])
            budget = result["provenance"]["accepted_request"]["working_bytes"]
            if retained + workspace > budget:
                raise ValueError(
                    "Density retained spatial bundle exceeds its working-memory budget"
                )
            validate_arrays(
                result, {name: project.load_array(d) for name, d in result["arrays"].items()}
            )
        else:
            for descriptor in result["arrays"].values():
                if check:
                    check()
                project.verify_array(descriptor)


def _legacy_validate_references(report, results, sources, documents):
    """Portable validator binding report snapshots to retained study records."""
    report = validate_report(report)
    for snapshot in report["result_snapshots"]:
        if not _same(results.get(snapshot["id"]), snapshot):
            raise ValueError("Density retained result changed or is unavailable")
    for snapshot in report["source_snapshots"]:
        source = sources.get(snapshot["id"])
        if source is None or not _same(_source_snapshot(source), snapshot):
            raise ValueError("Density retained source fingerprint or derivation changed")
    groups = {d["id"]: d for d in documents if d.get("kind") == "population_group"}
    for snapshot in report["phenotype_groups"]:
        if not _same(groups.get(snapshot["id"]), snapshot):
            raise ValueError("Density retained phenotype group changed or is unavailable")
    return report


def _legacy_references(project, report, *, verify_sources=False, verify_arrays=True, check=None):
    """Verify retained scientific records/bytes without requiring current samples."""
    report = validate_report(report)
    for snapshot in report["result_snapshots"]:
        if check:
            check()
        if not _same(project.result(snapshot["id"]), snapshot):
            raise ValueError("Density retained result changed or is unavailable")
    for snapshot in report["source_snapshots"]:
        actual = project.source(snapshot["id"], verify=verify_sources, check=check)
        if not _same(_source_snapshot(actual), snapshot):
            raise ValueError("Density retained source fingerprint or derivation changed")
    for snapshot in report["phenotype_groups"]:
        actual = project.documents("population_group", document_id=snapshot["id"])
        if len(actual) != 1 or not _same(actual[0], snapshot):
            raise ValueError("Density retained phenotype group changed or is unavailable")
    if verify_arrays:
        _verify_arrays(project, report["result_snapshots"], check)
    return report


def current_status(project, report, check=None):
    report = validate_report(report)
    changes = []
    for field in report["aggregation"]["input_snapshots"]:
        if check:
            check()
        result = field["result"]
        if not _same(_sample(project, result["source_id"]), field["sample"]):
            changes.append({"result_id": result["id"], "reason": "sample_metadata_changed"})
    return {"current": not changes, "changes": changes}


def _software():
    from .models import ENGINE_VERSION
    from .working_result import _sha256_file_stable

    if getattr(sys, "frozen", False):
        digest = _sha256_file_stable(Path(sys.executable), reject_symlink=True)[0]
        return {"engine": ENGINE_VERSION, "aggregation_sha256": digest, "dispatcher_sha256": digest}
    return {
        "engine": ENGINE_VERSION,
        "aggregation_sha256": _sha256_file_stable(
            Path(__file__).with_name("spatial_density.py"), reject_symlink=True
        )[0],
        "dispatcher_sha256": _sha256_file_stable(Path(__file__), reject_symlink=True)[0],
    }


def _legacy_preview(project, request, check=None):
    exact_keys(
        request, {"fields", "phenotype_name", "stratum", "condition_pair"}, "density preview"
    )
    fields = request.get("fields")
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise ValueError(f"Choose 1-{MAX_FIELDS} exact spatial density fields")
    selections, group_ids = [], []
    for field in fields:
        exact_keys(
            field,
            {"result_id", "revision_hash", "phenotype_group_id", "phenotype_record_sha256"},
            "density field",
        )
        checked_id(field.get("result_id"))
        _sha(field.get("revision_hash"))
        if ("phenotype_group_id" in field) != ("phenotype_record_sha256" in field):
            raise ValueError("Phenotype selection requires exact group and record identities")
        if "phenotype_group_id" in field:
            group_ids.append(checked_id(field["phenotype_group_id"]))
            _sha(field["phenotype_record_sha256"])
        selections.append(field["result_id"])
    groups = _groups(project, group_ids)
    results, sources = _resolve_results(project, selections, check)
    snapshots = []
    for field in fields:
        result = results[field["result_id"]]
        if result["revision_hash"] != field["revision_hash"]:
            raise ValueError("Spatial density field revision is stale")
        phenotype = groups[field["phenotype_group_id"]] if "phenotype_group_id" in field else None
        if phenotype and phenotype["data"]["record_sha256"] != field["phenotype_record_sha256"]:
            raise ValueError("Spatial density phenotype snapshot is stale")
        snapshots.append(
            {
                "result": result,
                "sample": _sample(project, result["source_id"]),
                "phenotype": phenotype,
            }
        )
    aggregation = aggregate_spatial_density(
        snapshots,
        phenotype_name=request.get("phenotype_name"),
        stratum=request.get("stratum"),
        condition_pair=request.get("condition_pair"),
    )
    report = {
        "schema": LEGACY_SCHEMA,
        "created_at": timestamp(),
        "software": _software(),
        "aggregation": aggregation,
        "result_snapshots": [results[k] for k in sorted(results)],
        "source_snapshots": [sources[k] for k in sorted(sources)],
        "phenotype_groups": [groups[k] for k in sorted(groups)],
    }
    report["report_hash"] = _hash(report)
    report = references(project, report, verify_sources=True, check=check)
    if not current_status(project, report, check)["current"]:
        raise ValueError("Density inputs changed during preview; preview again")
    return report


def load(project, report_id, *, verify_sources=False, verify_arrays=True, check=None):
    documents = project.documents(DOCUMENT_KIND, document_id=checked_id(report_id))
    if len(documents) != 1:
        raise ValueError("Choose an exact saved spatial density report")
    document = documents[0]
    _exact(document, {"id", "kind", "revision", "updated_at", "data"}, "density report envelope")
    if document["id"] != report_id or document["kind"] != DOCUMENT_KIND:
        raise ValueError("Saved spatial density report envelope identity is inconsistent")
    checked_text(document["updated_at"], "Density report envelope timestamp", 64)
    report = references(
        project,
        document["data"],
        verify_sources=verify_sources,
        verify_arrays=verify_arrays,
        check=check,
    )
    if (
        type(document["revision"]) is not int
        or document["revision"] != 1
        or report_id != report["report_hash"][:32]
    ):
        raise ValueError("Saved spatial density report identity is inconsistent")
    return report


def _candidate(project, request):
    if isinstance(request, dict) and "report_json" in request:
        raise ValueError(
            "Legacy density preview snapshots cannot be saved; preview again for a retained token"
        )
    return _load_preview(project, request)


def save_task_source(project, request):
    # Routing does not grant access; policy callers authorize every retained input.
    report = _candidate(project, request)
    source_id = report["aggregation"]["input_snapshots"][0]["result"]["source_id"]
    project.source(source_id)
    return source_id


def save_job(project, request, job_id, check=None):
    """Publish the immutable report and its exact child job completion atomically."""
    report = references(project, _candidate(project, request), verify_sources=True, check=check)
    report_id = report["report_hash"][:32]
    checked_id(job_id)

    def guard():
        if check:
            check()
        if not _same(report["software"], _software()):
            raise ValueError("Density software changed; preview again before saving")
        references(project, report, verify_sources=True, check=check)
        if not current_status(project, report, check)["current"]:
            raise ValueError("Density inputs changed; preview again before saving")

    guard()
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT request_hash,record FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        if row is None:
            raise ValueError("Density save requires its exact running job")
        job = parse_json(row[1])
        if (
            job.get("id") != job_id
            or row[0] != job.get("request_hash")
            or row[0] != _hash({"operation": job["operation"], "request": job["request"]})
            or set(job["request"]) != {"source_id", "task_request"}
            or job["request"]["source_id"]
            != report["aggregation"]["input_snapshots"][0]["result"]["source_id"]
            or job["state"] != "running"
            or job["cancel_requested"]
            or job["operation"] != "spatial_density_save"
            or not _same(job["request"].get("task_request"), request)
        ):
            raise ValueError("Density save job changed or was cancelled before publication")
        if job.get("owner") is not None:
            from .agent_sessions import require_session_authority

            require_session_authority(project, **job["owner"], connection=connection)
        guard()
        existing = connection.execute(
            "SELECT revision,record FROM documents WHERE kind=? AND id=?",
            (DOCUMENT_KIND, report_id),
        ).fetchone()
        if existing is None:
            envelope = {
                "id": report_id,
                "kind": DOCUMENT_KIND,
                "revision": 1,
                "updated_at": timestamp(),
                "data": report,
            }
            connection.execute(
                "INSERT INTO documents VALUES(?,?,?,?)",
                (DOCUMENT_KIND, report_id, 1, canonical_json(envelope)),
            )
        else:
            envelope = parse_json(existing[1])
            _exact(
                envelope,
                {"id", "kind", "revision", "updated_at", "data"},
                "density report envelope",
            )
            if (
                envelope["id"] != report_id
                or envelope["kind"] != DOCUMENT_KIND
                or type(envelope["revision"]) is not int
                or existing[0] != 1
                or envelope.get("revision") != 1
                or not _same(envelope.get("data"), report)
            ):
                raise ValueError("Saved density report content differs")
        # Guard inside the same transaction after insertion; any failure rolls
        # back BOTH the new document and completion, including native cancellation.
        guard()
        finished = timestamp()
        job.update(
            state="succeeded",
            progress=1.0,
            result_ids=[],
            report_id=report_id,
            error=None,
            finished_at=finished,
            updated_at=finished,
        )
        connection.execute("UPDATE jobs SET record=? WHERE id=?", (canonical_json(job), job_id))
        if check:
            check()
    return {
        "report": report,
        "report_id": report_id,
        "status": current_status(project, report, check),
        "summary": summary(report),
    }


def execute(project, operation, request, check=None, *, job_id=None):
    if operation == "spatial_density_preview":
        return _cache_preview(project, preview(project, request, check), check=check)
    if operation == "spatial_density_save":
        if job_id is not None:
            return save_job(project, request, job_id, check)
        report = references(project, _candidate(project, request), verify_sources=True, check=check)
        report_id = report["report_hash"][:32]

        def guard():
            if check:
                check()
            if not _same(report["software"], _software()):
                raise ValueError("Density software changed; preview again before saving")
            references(project, report, verify_sources=True, check=check)
            if not current_status(project, report, check)["current"]:
                raise ValueError("Density inputs changed; preview again before saving")

        guard()
        existing = project.documents(DOCUMENT_KIND, document_id=report_id)
        if existing:
            if not _same(load(project, report_id, check=check), report):
                raise ValueError("Saved density report content differs")
        else:
            project.put_document(
                DOCUMENT_KIND, report_id, report, expected_revision=0, publication_guard=guard
            )
        return {
            "report": report,
            "report_id": report_id,
            "status": current_status(project, report, check),
            "summary": summary(report),
        }
    if operation == "spatial_density_query":
        return query(project, request, check=check)
    if operation == "spatial_density_get":
        _exact(request, {"report_id"}, operation)
        report = load(project, request["report_id"], check=check)
        return {
            "report": report,
            "report_id": request["report_id"],
            "status": current_status(project, report, check),
            "summary": summary(report),
        }
    if operation == "spatial_density_list":
        _exact(request, set(), operation)
        reports = []
        for document in project.documents(DOCUMENT_KIND):
            report = load(project, document["id"], check=check)
            reports.append(
                {
                    "id": document["id"],
                    "created_at": report["created_at"],
                    "phenotype_name": report["aggregation"]["phenotype_name"],
                    "stratum": report["aggregation"]["stratum"],
                    "status": current_status(project, report, check),
                }
            )
        return {"reports": reports}
    raise ValueError("Unknown spatial density report operation")


def plan(project, report_id, check=None):
    report = load(project, report_id, verify_sources=True, check=check)
    value = {
        "schema": "loci.spatial-density-export-plan/v1",
        "report_id": report_id,
        "report_hash": report["report_hash"],
        "status": current_status(project, report, check),
        "export_software": _software(),
    }
    if check:
        check()
    return {**value, "plan_hash": _hash(value)}


def grant(project, report_id, expected_plan_hash, destination):
    """Trusted native caller only; agents receive the opaque grant, never paths."""
    from .research_data_export import _capability, _destination

    _capability()
    current = plan(project, checked_id(report_id))
    if current["plan_hash"] != _sha(expected_plan_hash):
        raise ValueError("Density inputs changed; prepare a fresh export preview")
    target = _destination(project, destination)
    parent = target.parent.stat()
    grant_id = uuid.uuid4().hex
    report = load(project, report_id)
    project.put_document(
        GRANT_KIND,
        grant_id,
        {
            "schema": "loci.spatial-density-export-grant/v1",
            "plan": current,
            "destination": str(target),
            "parent_identity": [parent.st_dev, parent.st_ino],
            "source_id": report["aggregation"]["input_snapshots"][0]["result"]["source_id"],
            "project_id": project.meta["project_id"],
            "private_project_root": str(project.root),
            "created_at": timestamp(),
        },
        expected_revision=0,
    )
    return {"grant_id": grant_id, "plan_hash": current["plan_hash"], "basename": target.name}


def _grant(project, request):
    _exact(request, {"grant_id", "plan_hash"}, "spatial density export grant")
    _sha(request["plan_hash"])
    documents = project.documents(GRANT_KIND, document_id=checked_id(request["grant_id"]))
    if len(documents) != 1 or documents[0]["revision"] != 1:
        raise ValueError("Density export grant is missing or stale")
    data = documents[0]["data"]
    if (
        data.get("schema") != "loci.spatial-density-export-grant/v1"
        or data["plan"]["plan_hash"] != request["plan_hash"]
        or data["plan"]["plan_hash"]
        != _hash({k: v for k, v in data["plan"].items() if k != "plan_hash"})
        or data.get("project_id") != project.meta["project_id"]
        or data.get("private_project_root") != str(project.root)
    ):
        raise ValueError("Density export grant belongs to another study or has changed")
    return documents[0]


def task_source(project, request):
    return _grant(project, request)["data"]["source_id"]


def export_input_result_ids(project, request):
    return input_result_ids(load(project, _grant(project, request)["data"]["plan"]["report_id"]))


def _contents(report, status):
    from .research_intensity_export import _csv

    aggregation = report["aggregation"]
    contents = {"report.json": canonical_json(report) + "\n"}
    tables = {}
    for name in TABLES:
        rows = aggregation[name]
        filename = name.replace("_", "-") + ".csv"
        contents[filename] = _csv(rows)
        tables[filename] = {
            "rows": len(rows),
            "columns": sorted({key for row in rows for key in row}),
        }
    contents["schema.json"] = (
        canonical_json(
            {
                "schema": "loci.spatial-density-package/v1",
                "report_hash": report["report_hash"],
                "tables": tables,
                "cell_table": {
                    "filename": "cells.csv",
                    "schema": "loci.spatial-density-cell/v1",
                    "columns": list(CELL_COLUMNS),
                    "measurement": (
                        "Original per-cell measurement object, including coordinates, "
                        "axes, intensity statistics and morphometry"
                    ),
                },
                "cell_encoding": (
                    "Every CSV cell is JSON; parse with JSON, not spreadsheet coercion"
                ),
                "numeric_policy": (
                    "Unrounded round-trip floats; exact integer labels/counts; null is undefined"
                ),
                "contract": aggregation["contract"],
                "rules": aggregation["rules"],
                "stratum": aggregation["stratum"],
                "phenotype_name": aggregation["phenotype_name"],
                "condition_pair": aggregation["condition_pair"],
            }
        )
        + "\n"
    )
    contents["provenance.json"] = (
        canonical_json(
            {
                "report_hash": report["report_hash"],
                "created_at": report["created_at"],
                "software": report["software"],
                "current_input_status_at_export": status,
                "input_result_ids": input_result_ids(report),
                "source_locators_included": False,
                "raw_pixels_included": False,
            }
        )
        + "\n"
    )
    contents["readme.md"] = (
        "# Loci spatial density report\n\n"
        "report.json retains the complete immutable report and exact result, sample, "
        "phenotype and dependency records. Masks and raw images remain in the source "
        "study and are represented by verified artifact hashes here. No private source "
        "locators are included. Every CSV cell is JSON; parse each with a JSON reader. "
        "Count eligible phenotype members in each distance band and divide by the "
        "entire sampled compartment band area. Pool numerator counts and denominator "
        "areas within each declared donor and condition; then give each defined donor "
        "density equal weight within a condition. SD is sample SD, undefined below two "
        "donors. Zero sampled area is undefined, never zero density. Only explicitly "
        "requested condition pairs are matched within study by biological_replicate; "
        "differences are right minus left. Exclusions and unmatched donors remain "
        "visible. Declared donors do not establish biological independence. Objects, "
        "fields and correlated crops are not independent biological replicates. "
        "No p-values, biological validation or clinical inference are claimed. "
        "Current metadata status is separate from preserved report endpoints. "
        "cells.csv contains one loci.spatial-density-cell/v1 record per original cell; "
        "every CSV cell is JSON as in the report tables. The measurement JSON column "
        "retains the full original cell record; dedicated centroid_index, "
        "centroid_world_xyz, index_axes, coordinate_unit/frame, intensity and "
        "phenotype_name columns support direct inspection. The measurement also contains bbox, "
        "measure/measure_unit and raw-channel intensity statistics. Other columns include "
        "including original measurements, exact source/result hashes, captured donor/sample "
        "metadata, phenotype membership, distance and inclusion/exclusion provenance. "
        "Full producing result records and retained masks remain in the source study, "
        "bound by result_record_sha256 and array hashes; they are not embedded here. "
        "Verify every manifest checksum before reuse.\n"
    )
    return contents


def publish(project, report_id, expected_plan, destination, check=None):
    _capability()

    def bound():
        if check:
            check()
        if plan(project, report_id, check=check) != expected_plan:
            raise ValueError("Spatial density export inputs changed; prepare a new preview")

    bound()
    report = load(project, report_id, verify_sources=True, check=check)
    contents = _contents(report, expected_plan["status"])
    records = {
        name: {
            "sha256": hashlib.sha256(value.encode()).hexdigest(),
            "size_bytes": len(value.encode()),
        }
        for name, value in contents.items()
    }
    cell_digest = hashlib.sha256()
    cell_size = 0
    for chunk in _cell_chunks(project, report, check):
        cell_size += len(chunk)
        if cell_size + sum(r["size_bytes"] for r in records.values()) > MAX_PACKAGE_BYTES:
            raise ValueError("Density cell export exceeds the bounded package byte limit")
        cell_digest.update(chunk)
    records["cells.csv"] = {"sha256": cell_digest.hexdigest(), "size_bytes": cell_size}
    contents["manifest.json"] = (
        canonical_json(
            {
                "schema": "loci.spatial-density-export-manifest/v1",
                "package_schema": "loci.spatial-density-package/v1",
                "report_hash": report["report_hash"],
                "plan_hash": expected_plan["plan_hash"],
                "export_software": expected_plan["export_software"],
                "files": [{"name": name, **value} for name, value in sorted(records.items())],
            }
        )
        + "\n"
    )
    records["manifest.json"] = {
        "sha256": hashlib.sha256(contents["manifest.json"].encode()).hexdigest(),
        "size_bytes": len(contents["manifest.json"].encode()),
    }
    size = sum(value["size_bytes"] for value in records.values())
    target = _destination(project, destination)
    if (
        len(records) > 16
        or size > MAX_PACKAGE_BYTES
        or shutil.disk_usage(target.parent).free < size
    ):
        raise ValueError("Spatial density package exceeds the file, byte or available disk budget")
    parent_fd = os.open(target.parent, _DIRECTORY_FLAGS)
    stage_name, stage_fd, stage_identity, published = (
        ".loci-spatial-density-" + uuid.uuid4().hex,
        None,
        None,
        False,
    )
    parent_identity = _identity(os.fstat(parent_fd))
    try:
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise ValueError("Spatial density destination parent changed")
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        stage_identity = _identity(os.fstat(stage_fd))
        for name, contents_text in contents.items():
            if check:
                check()
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=stage_fd,
            )
            with os.fdopen(fd, "wb") as stream:
                data = contents_text.encode()
                for offset in range(0, len(data), 65536):
                    if check:
                        check()
                    stream.write(data[offset : offset + 65536])
                stream.flush()
                os.fsync(stream.fileno())
        fd = os.open(
            "cells.csv",
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=stage_fd,
        )
        with os.fdopen(fd, "wb") as stream:
            for chunk in _cell_chunks(project, report, check):
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(stage_fd)
        _verify_files(stage_fd, records, check)
        bound()
        _verify_files(stage_fd, records, check)
        bound()
        if (
            target.parent.resolve(strict=True) != target.parent
            or parent_identity != _identity(target.parent.lstat())
            or stage_identity
            != _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
        ):
            raise ValueError("Spatial density publication directory changed")
        if check:
            check()
        _rename_noreplace(stage_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published = True
        if target.parent.resolve(strict=True) != target.parent or parent_identity != _identity(
            target.parent.lstat()
        ):
            raise RuntimeError(
                "Spatial density package published; destination parent moved. "
                "Inspect before retrying"
            )
        os.fsync(parent_fd)
        return {
            "schema": "loci.spatial-density-export-receipt/v1",
            "basename": target.name,
            "report_hash": report["report_hash"],
            "manifest_sha256": records["manifest.json"]["sha256"],
        }
    finally:
        if stage_fd is not None:
            if not published:
                error = sys.exception()
                try:
                    with suppress(FileNotFoundError):
                        if (
                            _identity(os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False))
                            == stage_identity
                        ):
                            shutil.rmtree(stage_name, dir_fd=parent_fd)
                except OSError:
                    if error:
                        error.add_note("Owned spatial-density staging cleanup failed")
                    else:
                        raise
            os.close(stage_fd)
        os.close(parent_fd)


def execute_export(workbench, request, job_id=None, publication_guard=None):
    project = workbench.project
    document = _grant(project, request)
    data = document["data"]

    def check():
        if publication_guard:
            publication_guard()
        if _grant(project, request) != document:
            raise ValueError("Spatial density export grant changed")
        if job_id:
            job = project.job(job_id)
            if job["state"] != "running" or job["cancel_requested"]:
                raise ValueError("Spatial density export cancelled before publication")
        parent = Path(data["destination"]).parent
        if (
            parent.resolve(strict=True) != parent
            or list(_identity(parent.lstat())) != data["parent_identity"]
        ):
            raise ValueError("Granted spatial-density export parent changed")

    receipt = publish(project, data["plan"]["report_id"], data["plan"], data["destination"], check)
    if job_id:
        project.update_job(
            job_id,
            expected_state="running",
            state="succeeded",
            progress=1.0,
            finished_at=timestamp(),
        )
    return receipt


# Compact v2: immutable originals remain in the normal result/group store.
# These are endpoint projections, never replacement or rehashed result records.
def _result_binding(record):
    return {
        **{k: record[k] for k in ("id", "revision_hash", "source_id", "source_sha256")},
        "record_sha256": _hash(record),
        "arrays": copy.deepcopy(record["arrays"]),
        "dependency_result_ids": sorted({b["result_id"] for b in _bindings(record)}),
        "source_ids": sorted(_sources_for_result(record)),
    }


def _report_request(request):
    exact_keys(
        request, {"fields", "phenotype_name", "stratum", "condition_pair"}, "density preview"
    )
    fields = request.get("fields")
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise ValueError("Choose 1-256 exact density fields")
    seen = set()
    for field in fields:
        if not isinstance(field, dict) or set(field) not in (
            {"result_id", "revision_hash"},
            {"result_id", "revision_hash", "phenotype_group_id", "phenotype_record_sha256"},
        ):
            raise ValueError("Choose exact result and optional phenotype record bindings")
        checked_id(field["result_id"])
        _sha(field["revision_hash"])
        if field["result_id"] in seen:
            raise ValueError("Duplicate density field binding")
        seen.add(field["result_id"])
        if "phenotype_group_id" in field:
            checked_id(field["phenotype_group_id"])
            _sha(field["phenotype_record_sha256"])
    return fields


def _replay_compact(report):
    from .research_interchange import _reject_absolute_strings
    from .spatial_density import aggregate_spatial_density_projections

    _exact(
        report,
        {
            "schema",
            "created_at",
            "software",
            "request",
            "aggregation",
            "result_bindings",
            "source_snapshots",
            "phenotype_bindings",
            "report_hash",
        },
        "compact density report",
    )
    if report["schema"] != SCHEMA:
        raise ValueError("Unsupported compact density schema")
    checked_text(report["created_at"], "Density report timestamp", 64)
    _exact(
        report["software"],
        {"engine", "aggregation_sha256", "dispatcher_sha256"},
        "density software",
    )
    checked_text(report["software"]["engine"], "Engine version", 64)
    _sha(report["software"]["aggregation_sha256"])
    _sha(report["software"]["dispatcher_sha256"])
    _reject_absolute_strings(report, "Density report")
    if len(canonical_json(report).encode()) > MAX_REPORT_BYTES:
        raise ValueError("Density report exceeds its bounded snapshot byte limit")
    if report["report_hash"] != _hash({k: v for k, v in report.items() if k != "report_hash"}):
        raise ValueError("Density report failed integrity verification")
    request_fields = _report_request(report["request"])
    a = report["aggregation"]
    expected = aggregate_spatial_density_projections(
        a["input_snapshots"],
        phenotype_name=a["phenotype_name"],
        stratum=a["stratum"],
        condition_pair=a["condition_pair"],
    )
    if not _same(expected, a):
        raise ValueError("Compact density report arithmetic is not reproducible")
    fields = {f["result"]["id"]: f for f in a["input_snapshots"]}
    if set(fields) != {f["result_id"] for f in request_fields}:
        raise ValueError("Density request and projected fields differ")
    for requested in request_fields:
        field = fields[requested["result_id"]]
        if field["result"]["revision_hash"] != requested["revision_hash"]:
            raise ValueError("Density requested revision is stale")
        phenotype = field["phenotype"]
        if "phenotype_group_id" in requested:
            if (
                phenotype is None
                or phenotype["id"] != requested["phenotype_group_id"]
                or phenotype["record_sha256"] != requested["phenotype_record_sha256"]
            ):
                raise ValueError("Density phenotype request differs from its projection")
        elif phenotype is not None:
            raise ValueError("Unrequested phenotype projection")
    if (
        report["request"].get("phenotype_name") != a["phenotype_name"]
        or report["request"].get("condition_pair") != a["condition_pair"]
        or (
            report["request"].get("stratum") is not None
            and report["request"]["stratum"] != a["stratum"]
        )
    ):
        raise ValueError("Density endpoint request differs from its aggregation")
    bindings = {}
    for key, limit in (
        ("result_bindings", MAX_RESULTS),
        ("source_snapshots", MAX_RESULTS),
        ("phenotype_bindings", MAX_GROUPS),
    ):
        rows = report[key]
        if not isinstance(rows, list) or len(rows) > limit:
            raise ValueError("Compact density binding count exceeds its bound")
        ids = [checked_id(row["id"]) for row in rows]
        if ids != sorted(set(ids)):
            raise ValueError("Compact density bindings must have unique canonical order")
        if key == "result_bindings":
            bindings = {row["id"]: row for row in rows}
            for row in rows:
                _exact(
                    row,
                    {
                        "id",
                        "revision_hash",
                        "source_id",
                        "source_sha256",
                        "record_sha256",
                        "arrays",
                        "dependency_result_ids",
                        "source_ids",
                    },
                    "density result binding",
                )
                checked_id(row["source_id"])
                for name in ("revision_hash", "source_sha256", "record_sha256"):
                    _sha(row[name])
                if not isinstance(row["arrays"], dict) or not row["arrays"]:
                    raise ValueError("Density result binding requires retained arrays")
                for descriptor in row["arrays"].values():
                    _exact(
                        descriptor, {"sha256", "bytes", "shape", "dtype"}, "density array binding"
                    )
                    _sha(descriptor["sha256"])
                    from .quantitative import integer

                    integer(descriptor["bytes"], "array bytes", 1, 512 * 1024**2 + 4096)
                    if (
                        not isinstance(descriptor["shape"], list)
                        or not 1 <= len(descriptor["shape"]) <= 5
                        or any(type(v) is not int or v < 0 for v in descriptor["shape"])
                    ):
                        raise ValueError("Invalid density array shape")
                    checked_text(descriptor["dtype"], "Array dtype", 128)
        elif key == "source_snapshots":
            for row in rows:
                exact_keys(row, {"id", "sha256", "derivation"}, "density source binding")
                _sha(row.get("sha256"))
        else:
            for row in rows:
                if not isinstance(row, dict) or set(row) != {
                    "id",
                    "name",
                    "record_sha256",
                    "snapshot_sha256",
                    "result_id",
                    "revision_hash",
                    "source_id",
                    "source_sha256",
                    "membership_sha256",
                    "population_sha256",
                }:
                    raise ValueError("Invalid retained phenotype binding")
                checked_id(row["result_id"])
                checked_id(row["source_id"])
                checked_text(row["name"], "Phenotype name", 128)
                for name in (
                    "record_sha256",
                    "snapshot_sha256",
                    "revision_hash",
                    "source_sha256",
                    "membership_sha256",
                    "population_sha256",
                ):
                    _sha(row[name])
    source_ids = {s["id"] for s in report["source_snapshots"]}
    group_map = {g["id"]: g for g in report["phenotype_bindings"]}
    reached = set()
    active = set()

    def visit(identity):
        if identity in active or len(active) >= 64:
            raise ValueError("Density retained dependency graph is cyclic or too deep")
        if identity in reached:
            return
        binding = bindings.get(identity)
        if binding is None:
            raise ValueError("Density retained result dependency is missing")
        for name in ("dependency_result_ids", "source_ids"):
            values = binding[name]
            if not isinstance(values, list) or values != sorted(set(values)):
                raise ValueError("Density dependency identities must be canonical")
            for value in values:
                checked_id(value)
        active.add(identity)
        for child in binding["dependency_result_ids"]:
            visit(child)
        active.remove(identity)
        reached.add(identity)

    for identity in fields:
        visit(identity)
    if reached != set(bindings):
        raise ValueError("Density retained result bindings include unrelated records")
    if set().union(*(set(b["source_ids"]) for b in bindings.values())) != source_ids:
        raise ValueError("Density source bindings are missing or unrelated")
    for field in fields.values():
        result = field["result"]
        binding = bindings.get(result["id"])
        if binding is None or any(
            binding[k] != result[k]
            for k in ("revision_hash", "source_id", "source_sha256", "record_sha256")
        ):
            raise ValueError("Density field lost its exact original result binding")
        if result["source_id"] not in source_ids:
            raise ValueError("Density field source binding is missing")
        if field["phenotype"] is not None and not _same(
            group_map.get(field["phenotype"]["id"]), field["phenotype"]
        ):
            raise ValueError("Density phenotype binding is missing")
    return copy.deepcopy(report)


def preview(project, request, check=None):
    from .research_groups import validate_group_document
    from .research_interchange import _validate_result_crossrefs
    from .spatial_density import (
        aggregate_spatial_density_projections,
        phenotype_binding,
        project_spatial_density_field,
    )

    requested = _report_request(request)
    projections = []
    bindings = {}
    sources = {}
    groups = {}
    for field in requested:
        results, actual_sources = _resolve_results(project, [field["result_id"]], check)
        result = results[field["result_id"]]
        if result["revision_hash"] != field["revision_hash"]:
            raise ValueError("Spatial density field revision is stale")
        actual_groups = (
            _groups(project, [field["phenotype_group_id"]]) if "phenotype_group_id" in field else {}
        )
        for record in results.values():
            _validate_result_crossrefs(record, actual_sources, results)
        for document in actual_groups.values():
            validate_group_document(document, actual_sources, results, list(actual_groups.values()))
            groups[document["id"]] = phenotype_binding(document)
        phenotype = actual_groups[field["phenotype_group_id"]] if actual_groups else None
        if (
            phenotype is not None
            and phenotype["data"]["record_sha256"] != field["phenotype_record_sha256"]
        ):
            raise ValueError("Spatial density phenotype snapshot is stale")
        _verify_arrays(project, list(results.values()), check)
        projections.append(
            project_spatial_density_field(
                {
                    "result": result,
                    "sample": _sample(project, result["source_id"]),
                    "phenotype": phenotype,
                }
            )
        )
        for record in results.values():
            binding = _result_binding(record)
            if record["id"] in bindings and not _same(bindings[record["id"]], binding):
                raise ValueError("Density dependencies changed during preview")
            bindings[record["id"]] = binding
        sources.update(actual_sources)
    report = {
        "schema": SCHEMA,
        "created_at": timestamp(),
        "software": _software(),
        "request": copy.deepcopy(request),
        "aggregation": aggregate_spatial_density_projections(
            projections,
            phenotype_name=request.get("phenotype_name"),
            stratum=request.get("stratum"),
            condition_pair=request.get("condition_pair"),
        ),
        "result_bindings": [bindings[k] for k in sorted(bindings)],
        "source_snapshots": [sources[k] for k in sorted(sources)],
        "phenotype_bindings": [groups[k] for k in sorted(groups)],
    }
    report["report_hash"] = _hash(report)
    report = validate_report(report)
    if not current_status(project, report, check)["current"]:
        raise ValueError("Density inputs changed during preview")
    return report


def _compact_external(report, results, sources, documents):
    from .research_groups import validate_group_document
    from .research_interchange import _validate_result_crossrefs
    from .spatial_density import phenotype_binding, project_spatial_density_field

    groups = {d["id"]: d for d in documents if d.get("kind") == "population_group"}
    needed = set()
    visiting = set()

    def visit(identity):
        if identity in visiting or len(visiting) >= 64:
            raise ValueError("Density dependencies are cyclic or too deep")
        if identity in needed:
            return
        record = results.get(identity)
        if record is None:
            raise ValueError("Density retained result is missing")
        visiting.add(identity)
        for b in _bindings(record):
            visit(b["result_id"])
            _check_binding(b, results[b["result_id"]])
        visiting.remove(identity)
        needed.add(identity)

    for f in report["aggregation"]["input_snapshots"]:
        visit(f["result"]["id"])
    if needed != {b["id"] for b in report["result_bindings"]}:
        raise ValueError("Density retained result bindings are missing or unrelated")
    for binding in report["result_bindings"]:
        record = results[binding["id"]]
        if not _same(_result_binding(record), binding):
            raise ValueError("Density retained result changed or is unavailable")
        _validate_result_crossrefs(record, sources, results)
    for source in report["source_snapshots"]:
        actual = sources.get(source["id"])
        if actual is None or not _same(_source_snapshot(actual), source):
            raise ValueError("Density source fingerprint or derivation changed")
    for binding in report["phenotype_bindings"]:
        document = groups.get(binding["id"])
        if document is None or not _same(phenotype_binding(document), binding):
            raise ValueError("Density retained phenotype changed or is unavailable")
        validate_group_document(document, sources, results, list(groups.values()))
    for field in report["aggregation"]["input_snapshots"]:
        phenotype = groups[field["phenotype"]["id"]] if field["phenotype"] is not None else None
        expected = project_spatial_density_field(
            {
                "result": results[field["result"]["id"]],
                "sample": field["sample"],
                "phenotype": phenotype,
            }
        )
        if not _same(expected, field):
            raise ValueError("Density endpoint projection differs from exact original records")
    return report


def validate_portable_references(report, results_by_id, sources_by_id, documents=()):
    report = validate_report(report)
    if report["schema"] == LEGACY_SCHEMA:
        return _legacy_validate_references(report, results_by_id, sources_by_id, documents)
    return _compact_external(report, results_by_id, sources_by_id, documents)


validate_references = validate_portable_references


def references(project, report, *, verify_sources=False, verify_arrays=True, check=None):
    report = validate_report(report)
    if report["schema"] == LEGACY_SCHEMA:
        return _legacy_references(
            project, report, verify_sources=verify_sources, verify_arrays=verify_arrays, check=check
        )
    from .research_groups import validate_group_document
    from .research_interchange import _validate_result_crossrefs
    from .spatial_density import phenotype_binding, project_spatial_density_field

    if not verify_arrays:
        # Project-open/policy identity checks bind exact canonical stored bytes,
        # not another full cell replay. All scientific getters, pages, saves and
        # exports use verify_arrays=True and rederive projections from originals.
        if check:
            check()
        with project.connection() as connection:
            for binding in report["result_bindings"]:
                row = connection.execute(
                    "SELECT record FROM results WHERE id=?", (binding["id"],)
                ).fetchone()
                if (
                    row is None
                    or hashlib.sha256(row[0].encode()).hexdigest() != binding["record_sha256"]
                ):
                    raise ValueError("Density retained result canonical record hash changed")
            for binding in report["phenotype_bindings"]:
                row = connection.execute(
                    "SELECT record FROM documents WHERE kind='population_group' AND id=?",
                    (binding["id"],),
                ).fetchone()
                if (
                    row is None
                    or hashlib.sha256(row[0].encode()).hexdigest() != binding["snapshot_sha256"]
                ):
                    raise ValueError("Density retained phenotype canonical record hash changed")
        for source in report["source_snapshots"]:
            actual = project.source(source["id"], verify=verify_sources, check=check)
            if not _same(_source_snapshot(actual), source):
                raise ValueError("Density retained source fingerprint or derivation changed")
        if check:
            check()
        return report
    actual_bindings = {}
    actual_sources = {}
    actual_groups = {}
    for field in report["aggregation"]["input_snapshots"]:
        results, sources = _resolve_results(
            project, [field["result"]["id"]], check, verify_sources=verify_sources
        )
        groups = (
            _groups(project, [field["phenotype"]["id"]]) if field["phenotype"] is not None else {}
        )
        for r in results.values():
            _validate_result_crossrefs(r, sources, results)
        for d in groups.values():
            validate_group_document(d, sources, results, list(groups.values()))
            actual_groups[d["id"]] = phenotype_binding(d)
        phenotype = groups[field["phenotype"]["id"]] if field["phenotype"] is not None else None
        expected = project_spatial_density_field(
            {
                "result": results[field["result"]["id"]],
                "sample": field["sample"],
                "phenotype": phenotype,
            }
        )
        if not _same(expected, field):
            raise ValueError("Density endpoint projection differs from exact original records")
        if verify_arrays:
            _verify_arrays(project, list(results.values()), check)
        actual_bindings.update({r["id"]: _result_binding(r) for r in results.values()})
        actual_sources.update(sources)
    if not _same([actual_bindings[k] for k in sorted(actual_bindings)], report["result_bindings"]):
        raise ValueError("Density retained result bindings changed or are unavailable")
    if not _same([actual_sources[k] for k in sorted(actual_sources)], report["source_snapshots"]):
        raise ValueError("Density retained source bindings changed")
    if not _same([actual_groups[k] for k in sorted(actual_groups)], report["phenotype_bindings"]):
        raise ValueError("Density retained phenotype bindings changed")
    return report


def summary(report):
    report = validate_report(report)
    a = report["aggregation"]
    if report["schema"] == LEGACY_SCHEMA:
        from .spatial_density import project_spatial_density_field

        inputs = [project_spatial_density_field(f) for f in a["input_snapshots"]]
    else:
        inputs = a["input_snapshots"]
    tables = {**{name: a[name] for name in TABLES}, "input_snapshots": inputs}
    result = {
        "schema": "loci.spatial-density-summary/v1",
        "report_schema": report["schema"],
        "report_hash": report["report_hash"],
        "created_at": report["created_at"],
        "software": report["software"],
        "request_sha256": _hash(report.get("request")),
        "aggregation": {
            k: copy.deepcopy(a[k])
            for k in ("schema", "rules", "contract", "stratum", "phenotype_name", "condition_pair")
        },
        "tables": {},
        "totals": {
            "selected_fields": len(inputs),
            "excluded_fields": sum(bool(row["reasons"]) for row in a["exclusion_audit"]),
            "donor_rows": len(a["donor_rows"]),
            "condition_rows": len(a["condition_rows"]),
            "paired_rows": len(a["paired_rows"]),
        },
    }
    count = 5
    while True:
        for name, rows in tables.items():
            part = copy.deepcopy(rows[:count])
            result["aggregation"][name] = part
            result["tables"][name] = {
                "total": len(rows),
                "returned": len(part),
                "has_more": len(part) < len(rows),
                "next_offset": len(part) if len(part) < len(rows) else None,
            }
        if len(canonical_json(result).encode()) <= PAGE_BYTES:
            return result
        if count == 0:
            raise ValueError("Density summary metadata exceeds its bounded response limit")
        count -= 1


def _cache_preview(project, report, *, check=None):
    if len(canonical_json(report).encode()) > MAX_PREVIEW_BYTES:
        raise ValueError("Compact density preview exceeds its bounded cache byte limit")
    record = {
        "schema": "loci.spatial-density-preview/v1",
        "preview_id": report["report_hash"][:32],
        "preview_hash": report["report_hash"],
        "report": report,
        "created_at": report["created_at"],
    }
    encoded = canonical_json(record)
    if len(encoded.encode()) > MAX_PREVIEW_BYTES:
        raise ValueError("Compact density preview exceeds its bounded cache byte limit")
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if check:
            check()
        if not current_status(project, report, check)["current"]:
            raise ValueError("Density inputs changed before preview retention")
        connection.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            (PREVIEW_PREFIX + record["preview_id"], encoded),
        )
        rows = connection.execute(
            "SELECT key,value FROM metadata WHERE key LIKE ?", (PREVIEW_PREFIX + "%",)
        ).fetchall()
        rows.sort(
            key=lambda row: (
                parse_json(row[1])["created_at"],
                row[0] == PREVIEW_PREFIX + record["preview_id"],
                row[0],
            ),
            reverse=True,
        )
        used = 0
        for index, (key, value) in enumerate(rows):
            used += len(value.encode())
            if index >= MAX_PREVIEWS or used > MAX_PREVIEW_BYTES:
                connection.execute("DELETE FROM metadata WHERE key=?", (key,))
        if check:
            check()
    return {
        "preview_id": record["preview_id"],
        "preview_hash": record["preview_hash"],
        "summary": summary(report),
    }


def _load_preview(project, request):
    _exact(request, {"preview_id", "preview_hash"}, "retained density preview identity")
    checked_id(request["preview_id"])
    _sha(request["preview_hash"])
    with project.connection() as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key=?", (PREVIEW_PREFIX + request["preview_id"],)
        ).fetchone()
    if row is None:
        raise ValueError("Density preview is unavailable or evicted; preview again explicitly")
    record = parse_json(row[0])
    if (
        record.get("schema") != "loci.spatial-density-preview/v1"
        or record.get("preview_id") != request["preview_id"]
        or record.get("preview_hash") != request["preview_hash"]
    ):
        raise ValueError("Density preview identity changed")
    report = validate_report(record["report"])
    if (
        report["schema"] != SCHEMA
        or report["report_hash"] != request["preview_hash"]
        or report["report_hash"][:32] != request["preview_id"]
    ):
        raise ValueError("Density preview content failed integrity verification")
    return report


def query(project, request, check=None):
    from .quantitative import integer

    identity = {k: request[k] for k in ("preview_id", "preview_hash", "report_id") if k in request}
    exact_keys(request, {*identity, "table", "offset", "limit", "field_result_id"}, "density query")
    if set(identity) == {"report_id"}:
        report = load(project, identity["report_id"], check=check)
    elif set(identity) == {"preview_id", "preview_hash"}:
        report = references(project, _load_preview(project, identity), check=check)
    else:
        raise ValueError("Choose one exact saved report or retained preview identity")
    table = request.get("table")
    if table not in (*TABLES, "input_snapshots", "cells"):
        raise ValueError("Choose a declared density table")
    if (table == "cells") != ("field_result_id" in request):
        raise ValueError("Per-cell density pages require one exact selected field identity")
    offset = integer(request.get("offset", 0), "density row offset", 0, 2**63 - 1)
    limit = integer(request.get("limit", 50), "density page rows", 1, 100)
    if table == "cells":
        field_id = checked_id(request["field_result_id"])
        selected = [
            f for f in report["aggregation"]["input_snapshots"] if f["result"]["id"] == field_id
        ]
        if len(selected) != 1:
            raise ValueError("Choose an exact field from this density report")
        total = len(project.result(field_id)["provenance"]["measurements"])
        import itertools

        candidates = itertools.islice(
            _iter_cells(project, report, field_id, check), offset, offset + limit
        )
        rows = None
    else:
        rows = report["aggregation"][table]
        total = len(rows)
        candidates = rows[offset : offset + limit]
    if table == "input_snapshots" and report["schema"] == LEGACY_SCHEMA:
        from .spatial_density import project_spatial_density_field

        rows = [project_spatial_density_field(f) for f in rows]
        candidates = rows[offset : offset + limit]
    result = {
        "schema": "loci.spatial-density-page/v1",
        "report_hash": report["report_hash"],
        "table": table,
        "offset": offset,
        "limit": limit,
        "total": total,
        "returned": 0,
        "rows": [],
        "next_offset": None,
    }
    for row in candidates:
        candidate = copy.deepcopy(row)
        result["rows"].append(candidate)
        result["returned"] = len(result["rows"])
        next_offset = offset + result["returned"]
        result["next_offset"] = next_offset if next_offset < total else None
        if len(canonical_json(result).encode()) > PAGE_BYTES:
            result["rows"].pop()
            result["returned"] -= 1
            result["next_offset"] = (
                offset + result["returned"] if offset + result["returned"] < total else None
            )
            if not result["returned"]:
                raise ValueError("Density row exceeds its bounded page byte limit")
            break
    return result


def _iter_cells(project, report, field_result_id=None, check=None):
    """Yield exact saved per-cell measurements with captured donor/phenotype context."""
    fields = report["aggregation"]["input_snapshots"]
    audit = {r["result_id"]: r["reasons"] for r in report["aggregation"]["exclusion_audit"]}
    if field_result_id is not None and field_result_id not in {f["result"]["id"] for f in fields}:
        raise ValueError("Choose an exact field from this density report")
    for field in fields:
        binding = field["result"]
        if field_result_id is not None and binding["id"] != field_result_id:
            continue
        if check:
            check()
        result = project.result(binding["id"])
        if result["revision_hash"] != binding["revision_hash"]:
            raise ValueError("Density cell result revision changed")
        expected = binding.get("record_sha256", _hash(binding))
        if _hash(result) != expected:
            raise ValueError("Density cell original record hash changed")
        phenotype = field["phenotype"]
        if phenotype is not None:
            group_id = phenotype["id"]
            groups = _groups(project, [group_id])
            document = groups[group_id]
            if report["schema"] == SCHEMA:
                from .spatial_density import phenotype_binding

                if not _same(phenotype_binding(document), phenotype):
                    raise ValueError("Density cell phenotype changed")
            elif not _same(document, phenotype):
                raise ValueError("Density cell phenotype changed")
            members = set(document["data"]["receipt"]["labels"])
            phenotype_id = group_id
            phenotype_hash = document["data"]["record_sha256"]
        else:
            members = None
            phenotype_id = None
            phenotype_hash = None
        sample = field["sample"]["data"] if field["sample"] is not None else {}
        unit = (
            binding["contract"]["distance_unit"]
            if report["schema"] == SCHEMA
            else result["provenance"]["spatial"]["distance_unit"]
        )
        for index, row in enumerate(result["provenance"]["measurements"]):
            if check and index % 256 == 0:
                check()
            spatial = row["spatial"]
            member = members is None or row["label"] in members
            yield {
                "schema": "loci.spatial-density-cell/v1",
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "result_record_sha256": expected,
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "selection": result["provenance"]["selection"],
                "study": sample.get("study"),
                "sample": sample.get("sample"),
                "condition": sample.get("condition"),
                "biological_replicate": sample.get("biological_replicate"),
                "phenotype_id": phenotype_id,
                "phenotype_record_sha256": phenotype_hash,
                "phenotype_member": member,
                "label": row["label"],
                "centroid_index": row["centroid_index"],
                "centroid_world_xyz": row["centroid_world_xyz"],
                "index_axes": row["index_axes"],
                "coordinate_unit": result["provenance"]["geometry"]["unit"],
                "coordinate_frame": result["provenance"]["geometry"]["frame"],
                "intensity": row["intensity"],
                "phenotype_name": report["aggregation"]["phenotype_name"],
                "distance": spatial["distance"],
                "distance_unit": unit,
                "band_index": spatial["band_index"],
                "object_exclusions": spatial["exclusions"],
                "field_exclusions": audit[result["id"]],
                "contributes_to_donor_density": member
                and not spatial["exclusions"]
                and not audit[result["id"]],
                "measurement": row,
            }


CELL_COLUMNS = tuple(
    sorted(
        {
            "schema",
            "result_id",
            "revision_hash",
            "result_record_sha256",
            "source_id",
            "source_sha256",
            "selection",
            "study",
            "sample",
            "condition",
            "biological_replicate",
            "phenotype_id",
            "phenotype_record_sha256",
            "phenotype_member",
            "label",
            "centroid_index",
            "centroid_world_xyz",
            "index_axes",
            "coordinate_unit",
            "coordinate_frame",
            "intensity",
            "phenotype_name",
            "distance",
            "distance_unit",
            "band_index",
            "object_exclusions",
            "field_exclusions",
            "contributes_to_donor_density",
            "measurement",
        }
    )
)


def _cell_chunks(project, report, check=None):
    import csv
    import io

    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CELL_COLUMNS)
    yield buffer.getvalue().encode()
    for row in _iter_cells(project, report, check=check):
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow(canonical_json(row[column]) for column in CELL_COLUMNS)
        yield buffer.getvalue().encode()
