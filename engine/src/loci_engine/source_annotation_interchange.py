"""Strict path-free interchange for current raw-source vector annotations."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .quantitative import integer
from .research_interchange import _atomic_write, _read_json_file
from .research_project import MAX_JSON_BYTES, canonical_json, checked_id
from .source_annotations import (
    MAX_HISTORY,
    _new_data,
    execute_annotations,
    validate_annotation_data,
)
from .source_annotations import (
    SCHEMA as SOURCE_ANNOTATION_SCHEMA,
)

if TYPE_CHECKING:
    from .workbench import Workbench


SCHEMA = "loci.source-annotation-interchange/v1"
_PACKAGE_KEYS = {
    "schema",
    "source",
    "annotations",
    "annotation_count",
    "source_annotations_revision",
}
_SOURCE_KEYS = {"sha256", "coordinate_space", "geometry", "dimensions"}


def _current_data(
    workbench: Workbench, source_id: str, source_sha256: str
) -> tuple[dict[str, Any], dict[str, Any], int]:
    source_id = checked_id(source_id)
    source = workbench.project.source(source_id, verify=True)
    if source_sha256 != source["sha256"]:
        raise ValueError("Raw annotations changed source binding; reload before interchange")
    documents = [
        item
        for item in workbench.project.documents("annotations")
        if item["id"] == source_id
    ]
    if len(documents) > 1:
        raise ValueError("Raw annotation storage contains duplicate source records")
    document = documents[0] if documents else None
    data = copy.deepcopy(document["data"]) if document else _new_data(workbench, source)
    validate_annotation_data(data, source)
    expected = _new_data(workbench, source)
    if any(
        canonical_json(data[key]) != canonical_json(expected[key])
        for key in ("coordinate_space", "geometry", "dimensions")
    ):
        raise ValueError("Raw annotation geometry no longer matches its source")
    return source, data, document["revision"] if document else 0


def export_source_annotations(
    workbench: Workbench,
    source_id: str,
    source_sha256: str,
    expected_revision: int,
    destination: str | Path,
) -> dict[str, Any]:
    """Atomically export only the current annotation state, without edit history."""

    source, data, revision = _current_data(workbench, source_id, source_sha256)
    expected_revision = integer(
        expected_revision, "source annotation revision", 0, 2**31 - 1
    )
    if expected_revision != revision:
        raise ValueError("Raw annotations changed; reload before export")
    annotations = copy.deepcopy(data["history"][data["cursor"]])
    package = {
        "schema": SCHEMA,
        "source": {
            "sha256": source["sha256"],
            "coordinate_space": data["coordinate_space"],
            "geometry": data["geometry"],
            "dimensions": data["dimensions"],
        },
        "annotations": annotations,
        "annotation_count": len(annotations),
        "source_annotations_revision": revision,
    }
    encoded = (canonical_json(package) + "\n").encode("utf-8")
    target, digest = _atomic_write(destination, encoded)
    return {
        "schema": SCHEMA,
        "basename": target.name,
        "sha256": digest,
        "annotation_count": len(annotations),
    }


def import_source_annotations(
    workbench: Workbench,
    source_id: str,
    source_sha256: str,
    expected_revision: int,
    package_path: str | Path,
) -> dict[str, Any]:
    """Merge imported current annotations as one optimistic, undoable history event."""

    source, data, revision = _current_data(workbench, source_id, source_sha256)
    expected_revision = integer(
        expected_revision, "source annotation revision", 0, 2**31 - 1
    )
    if expected_revision != revision:
        raise ValueError("Raw annotations changed; reload before import")
    package = _read_json_file(package_path, MAX_JSON_BYTES, None)
    if (
        not isinstance(package, dict)
        or set(package) != _PACKAGE_KEYS
        or package.get("schema") != SCHEMA
    ):
        raise ValueError("Source annotation interchange schema or fields are unsupported")
    package_source = package.get("source")
    if not isinstance(package_source, dict) or set(package_source) != _SOURCE_KEYS:
        raise ValueError("Source annotation interchange binding is invalid")
    expected_binding = {
        "sha256": source["sha256"],
        "coordinate_space": data["coordinate_space"],
        "geometry": data["geometry"],
        "dimensions": data["dimensions"],
    }
    if canonical_json(package_source) != canonical_json(expected_binding):
        raise ValueError("Imported annotations do not match this exact source geometry")
    annotations = package.get("annotations")
    count = integer(package.get("annotation_count"), "annotation count", 0, 1000)
    integer(
        package.get("source_annotations_revision"),
        "exported source annotation revision",
        0,
        2**31 - 1,
    )
    if not isinstance(annotations, list) or len(annotations) != count:
        raise ValueError("Imported annotation count is inconsistent")
    imported_data = {
        "schema": SOURCE_ANNOTATION_SCHEMA,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "coordinate_space": package_source["coordinate_space"],
        "geometry": package_source["geometry"],
        "dimensions": package_source["dimensions"],
        "history": [annotations],
        "cursor": 0,
    }
    validate_annotation_data(imported_data, source)

    current = copy.deepcopy(data["history"][data["cursor"]])
    current_ids = {annotation["id"] for annotation in current}
    imported_ids = {annotation["id"] for annotation in annotations}
    if current_ids & imported_ids:
        raise ValueError("An imported annotation identity already exists in this source")
    merged = current + copy.deepcopy(annotations)
    data["history"] = (data["history"][: data["cursor"] + 1] + [merged])[-MAX_HISTORY:]
    data["cursor"] = len(data["history"]) - 1
    validate_annotation_data(data, source)
    # Reverify immutable source bytes immediately before the one-document commit.
    if workbench.project.source(source["id"], verify=True)["sha256"] != source["sha256"]:
        raise ValueError("Raw source changed before annotation import")
    workbench.project.put_document(
        "annotations", source["id"], data, expected_revision=revision
    )
    return execute_annotations(
        workbench, "source_annotations", {"source_id": source["id"]}
    )
