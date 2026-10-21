"""Manual study reports; snapshots are immutable and current status is separate."""

import json

from .quantitative import exact_keys
from .research_project import canonical_json, checked_id


def validate_reviews(report, histories):
    from .research_data_export import _review_record
    from .research_review import review_sha256

    for binding in report["bindings"]:
        if not any(
            review_sha256(event) == binding["review_sha256"]
            and _review_record(event) == binding["review"]
            for event in histories.get(binding["result_id"], [])
        ):
            raise ValueError("Saved intensity report review snapshot has no retained review event")


def references(project, report, *, verify_sources=False, check=None):
    from .experiment_intensity import validate_references, validate_report

    report = validate_report(report)
    results = {}
    sources = {}
    for binding in report["bindings"]:
        if check:
            check()
        inputs = binding.get("label_inputs") or {}
        identities = [binding["result_id"], *(value["result_id"] for value in inputs.values())]
        for identity in identities:
            if identity in results:
                continue
            result = project.result(identity)
            results[result["id"]] = result
            source = project.source(result["source_id"], verify=verify_sources, check=check)
            sources[source["id"]] = source
    validate_references(report, results, sources)
    validate_reviews(
        report,
        {
            identity: project.review_history(identity) or [project.review_state(identity)]
            for identity in report["result_ids"]
        },
    )
    return report


def load(project, report_id, *, verify_sources=False, check=None):
    report_id = checked_id(report_id)
    documents = project.documents("intensity_report", document_id=report_id)
    if len(documents) != 1:
        raise ValueError("Choose an exact saved intensity report")
    document = documents[0]
    report = references(project, document["data"], verify_sources=verify_sources, check=check)
    if document["revision"] != 1 or report["report_hash"][:32] != report_id:
        raise ValueError("Saved intensity report identity is inconsistent")
    return report


def execute(project, operation, request, check=None):
    from .experiment_intensity import MAX_REPORT_BYTES, catalog, current_status, preview

    if operation == "intensity_catalog":
        exact_keys(request, {"result_ids"}, operation)
        return catalog(project, request.get("result_ids"), check=check)
    if operation == "intensity_preview":
        # Keep Python's exact canonical numeric spelling across the JavaScript
        # display boundary (10.0 and -0.0 must not be reserialized as 10 and 0).
        return {"report_json": canonical_json(preview(project, request, check=check))}
    if operation == "intensity_save":
        if "report_json" in request:
            exact_keys(request, {"report_json"}, operation)
            text = request["report_json"]
            if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_REPORT_BYTES:
                raise ValueError("Intensity report exceeds its bounded snapshot byte limit")
            try:
                candidate = json.loads(text)
                if canonical_json(candidate) != text:
                    raise ValueError("Intensity report snapshot must retain exact canonical JSON")
            except (TypeError, ValueError, RecursionError) as exc:
                raise ValueError("Invalid canonical intensity report snapshot") from exc
        else:
            exact_keys(request, {"report"}, operation)
            candidate = request.get("report")
        report = references(project, candidate, verify_sources=True, check=check)
        if not current_status(project, report, check=check)["current"]:
            raise ValueError("Inputs changed; preview again before saving this comparison")
        report_id = report["report_hash"][:32]
        existing = project.documents("intensity_report", document_id=report_id)
        if existing:
            if existing[0]["data"] != report:
                raise ValueError("Saved intensity report content differs")
        else:

            def guard():
                if check:
                    check()
                if not current_status(project, report, check=check)["current"]:
                    raise ValueError("Inputs changed before saving the comparison")

            project.put_document(
                "intensity_report",
                report_id,
                report,
                expected_revision=0,
                publication_guard=guard,
            )
        return {"report": report, "report_id": report_id, "status": current_status(project, report)}
    if operation == "intensity_get":
        exact_keys(request, {"report_id"}, operation)
        report = load(project, request.get("report_id"))
        return {
            "report": report,
            "report_id": report["report_hash"][:32],
            "status": current_status(project, report, check=check),
        }
    if operation == "intensity_list":
        exact_keys(request, set(), operation)
        reports = []
        for document in project.documents("intensity_report"):
            report = load(project, document["id"])
            reports.append(
                {
                    "id": document["id"],
                    "created_at": report["created_at"],
                    "endpoint": report["endpoint"],
                    "declaration": report["declaration"],
                }
            )
        return {"reports": reports}
    raise ValueError("Unknown intensity report operation")
