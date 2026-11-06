"""Shared integrity hooks for method and annotation-derived results.

Dispatch is code-owned. A kind or provenance marker activates validation, so
renaming only one cannot bypass the scientific contract at a storage boundary.
"""

from __future__ import annotations


def validator(record):
    provenance = record.get("provenance", {})
    annotation = record.get("kind") in {"annotation-agreement", "annotation-reference"} or any(
        key in provenance for key in ("annotation_evaluation", "annotation_reference")
    )
    method = record.get("kind") == "controlled-method" or "controlled_method" in provenance
    if annotation and method:
        raise ValueError("A result cannot combine incompatible derived scientific contracts")
    if annotation:
        from . import research_annotation_evaluation

        return research_annotation_evaluation
    if method:
        from . import research_methods

        return research_methods
    return None


def validate_project(project, record, *, arrays=False, check=None, working_bytes=None):
    module = validator(record)
    if module is None:
        return
    module.project_parents(project, record, check=check)
    module.validate_source(record, project.source(record["source_id"]))
    if arrays is not False:
        module.validate_project_arrays(
            project,
            record,
            arrays=None if arrays is True else arrays,
            check=check,
            working_bytes=working_bytes,
        )


def validate_crossrefs(record, sources, results):
    module = validator(record)
    if module is not None:
        module.validate_parents(record, results)
        module.validate_source(record, sources[record["source_id"]])


def validate_arrays(record, arrays, *, parents=None, check=None):
    module = validator(record)
    if module is not None:
        module.validate_arrays(record, arrays, parents=parents, check=check)


def refuse_edit(record):
    if validator(record) is not None:
        raise ValueError(
            "This saved method or annotation report is immutable. "
            "Edit its input labels or annotations and create a new result."
        )
