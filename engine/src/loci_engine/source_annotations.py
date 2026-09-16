"""Vector annotations on immutable raw sources, independent of segmentation."""

from __future__ import annotations

import copy
import re
import uuid
from typing import TYPE_CHECKING, Any

import numpy as np

from .quantitative import exact_keys, finite_number, integer
from .research_project import canonical_json, checked_id, checked_text

if TYPE_CHECKING:
    from .workbench import Workbench

SCHEMA = "loci.source-annotations/v1"
MAX_ANNOTATIONS = 1000
MAX_POINTS = 10_000
MAX_HISTORY = 32
COLOR = re.compile(r"^#[a-fA-F0-9]{6}$")
TRANSECT_SCHEMA = "loci.epidermal-transect/v1"
TRANSECT_CLASSES = {"suprapapillary", "ridge-base", "custom"}


def _validate_transect(annotation: dict[str, Any]) -> None:
    if "transect" not in annotation:
        return
    transect = annotation["transect"]
    if annotation.get("kind") != "line" or not isinstance(transect, dict):
        raise ValueError("Epidermal transect metadata requires a line annotation")
    exact_keys(
        transect,
        {
            "schema",
            "class",
            "upper_boundary",
            "lower_boundary",
            "orientation_rule",
            "exclusions",
            "review",
        },
        "epidermal transect metadata",
    )
    if transect.get("schema") != TRANSECT_SCHEMA:
        raise ValueError("Epidermal transect metadata schema is unsupported")
    if transect.get("class") not in TRANSECT_CLASSES:
        raise ValueError("Choose a supported epidermal transect class")
    for key, label in (
        ("upper_boundary", "Transect upper boundary"),
        ("lower_boundary", "Transect lower boundary"),
        ("orientation_rule", "Transect orientation rule"),
        ("exclusions", "Transect exclusions"),
    ):
        checked_text(transect.get(key), label, 240)
    review = transect.get("review")
    if not isinstance(review, dict) or set(review) != {"status", "reviewer"}:
        raise ValueError("Epidermal transect review evidence is invalid")
    status = review.get("status")
    reviewer = review.get("reviewer")
    if status == "approved":
        checked_text(reviewer, "Transect reviewer", 120)
    elif status == "unverified":
        if reviewer is not None:
            raise ValueError("Unverified transects cannot claim a reviewer")
    else:
        raise ValueError("Epidermal transect review status is invalid")


def validate_annotation_data(data: dict[str, Any], source: dict[str, Any]) -> None:
    exact_keys(
        data,
        {
            "schema",
            "source_id",
            "source_sha256",
            "coordinate_space",
            "geometry",
            "dimensions",
            "history",
            "cursor",
        },
        "source annotations",
    )
    if (
        data.get("schema") != SCHEMA
        or data.get("source_id") != source["id"]
        or data.get("source_sha256") != source["sha256"]
        or data.get("coordinate_space") != "level0-pixel-edges"
    ):
        raise ValueError("Raw annotations lost their source or coordinate binding")
    dimensions = data["dimensions"]
    if not isinstance(dimensions, dict) or set(dimensions) != {"x", "y", "z", "t"}:
        raise ValueError("Raw annotation dimensions are invalid")
    for number in dimensions.values():
        integer(number, "source dimension", 1, 2**31 - 1)
    from .workbench import geometry_from_dict

    geometry = geometry_from_dict(data["geometry"])
    history = data["history"]
    if not isinstance(history, list) or not 1 <= len(history) <= MAX_HISTORY:
        raise ValueError("Raw annotation history exceeds its bound")
    integer(data["cursor"], "history cursor", 0, len(history) - 1)
    for state_annotations in history:
        if not isinstance(state_annotations, list) or len(state_annotations) > MAX_ANNOTATIONS:
            raise ValueError("Raw annotation count exceeds its bound")
        ids: set[str] = set()
        count = 0
        for annotation in state_annotations:
            base_fields = {
                "id",
                "kind",
                "points",
                "world_xyz",
                "label",
                "color",
                "z",
                "t",
                "length",
                "area",
                "unit",
            }
            exact_keys(annotation, base_fields | {"transect"}, "raw annotation")
            if set(annotation) not in (base_fields, base_fields | {"transect"}):
                raise ValueError("Raw annotation fields are invalid")
            identity = checked_id(annotation["id"])
            if identity in ids:
                raise ValueError("Raw annotation identities must be unique")
            ids.add(identity)
            checked_text(annotation["label"], "Annotation label", 120, empty=True)
            _validate_transect(annotation)
            if not isinstance(annotation["color"], str) or not COLOR.fullmatch(annotation["color"]):
                raise ValueError("Choose a hexadecimal annotation color")
            integer(annotation["z"], "annotation Z", 0, dimensions["z"] - 1)
            integer(annotation["t"], "annotation time", 0, dimensions["t"] - 1)
            points = annotation["points"]
            minimum = {"point": 1, "line": 2, "polygon": 3, "rectangle": 4}.get(annotation["kind"])
            if (
                minimum is None
                or not isinstance(points, list)
                or not minimum <= len(points) <= 2048
            ):
                raise ValueError("Choose valid point, line or polygon coordinates")
            if annotation["kind"] in {"point", "line", "rectangle"} and len(points) != minimum:
                raise ValueError("The annotation has an incompatible number of points")
            count += len(points)
            if count > MAX_POINTS:
                raise ValueError("Raw annotation vertices exceed the source budget")
            for point in points:
                exact_keys(point, {"x", "y"}, "annotation point")
                finite_number(point["x"], "annotation x", 0, dimensions["x"])
                finite_number(point["y"], "annotation y", 0, dimensions["y"])
            expected = _metrics(annotation, geometry.to_dict())
            if any(
                canonical_json(annotation[key]) != canonical_json(value)
                for key, value in expected.items()
            ):
                raise ValueError("Raw annotation geometry or measurements are inconsistent")


def _metrics(annotation: dict[str, Any], geometry: dict[str, Any]) -> dict[str, Any]:
    affine = np.asarray(geometry["affine"], dtype=np.float64)
    points = np.asarray(
        [[p["x"] - 0.5, p["y"] - 0.5, annotation["z"], 1] for p in annotation["points"]]
    )
    world = (points @ affine.T)[:, :3]
    length = float(np.linalg.norm(np.diff(world, axis=0), axis=1).sum()) if len(world) > 1 else None
    area = None
    if annotation["kind"] in {"rectangle", "polygon"}:
        relative = world - world[0]
        area = float(
            np.linalg.norm(np.cross(relative, np.roll(relative, -1, axis=0)).sum(axis=0)) / 2
        )
        length += float(np.linalg.norm(world[-1] - world[0]))
        if area <= 0:
            raise ValueError("Polygon annotations must enclose a nonzero area")
        from .research_annotations import _simple_polygon

        if not _simple_polygon(tuple((p["x"], p["y"]) for p in annotation["points"])):
            raise ValueError("Polygon edges must not cross")
    return {"world_xyz": world.tolist(), "length": length, "area": area, "unit": geometry["unit"]}


def _new_data(workbench: Workbench, source: dict[str, Any]) -> dict[str, Any]:
    if source.get("source_kind") == "medical":
        geometry = source["metadata"]["geometry"]
        shape = source["metadata"]["shape"]
        dimensions = {
            "x": shape[-1],
            "y": shape[-2],
            "z": shape[0] if len(shape) == 3 else 1,
            "t": 1,
        }
    else:
        session = workbench._session(source["id"])
        d = session.metadata.dimensions
        dimensions = {"x": d.x, "y": d.y, "z": d.z, "t": d.t}
        selection = {"x": 0, "y": 0, "width": 1, "height": 1, "z": 0, "c": 0, "t": 0, "level": 0}
        geometry = workbench._native_geometry(session, selection, d.z > 1).to_dict()
    return {
        "schema": SCHEMA,
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "coordinate_space": "level0-pixel-edges",
        "geometry": geometry,
        "dimensions": dimensions,
        "history": [[]],
        "cursor": 0,
    }


def execute_annotations(
    workbench: Workbench, operation: str, request: dict[str, Any]
) -> dict[str, Any]:
    fields = (
        {"source_id"}
        if operation == "source_annotations"
        else {
            "source_id",
            "source_sha256",
            "expected_revision",
            "action",
            "annotation",
            "annotation_id",
        }
    )
    exact_keys(request, fields, operation)
    source_id = checked_id(request.get("source_id"))
    source = workbench.project.source(source_id, verify=operation != "source_annotations")
    document = next(
        (item for item in workbench.project.documents("annotations") if item["id"] == source_id),
        None,
    )
    data = copy.deepcopy(document["data"]) if document else _new_data(workbench, source)
    validate_annotation_data(data, source)
    expected = _new_data(workbench, source)
    if any(
        canonical_json(data[key]) != canonical_json(expected[key])
        for key in ("dimensions", "geometry")
    ):
        raise ValueError("Raw annotation geometry no longer matches its source")
    revision = document["revision"] if document else 0
    if operation != "source_annotations":
        if (
            request.get("source_sha256") != source["sha256"]
            or request.get("expected_revision") != revision
        ):
            raise ValueError("Annotations changed; reload before editing")
        action = request.get("action")
        if action in {"undo", "redo"}:
            data["cursor"] = integer(
                data["cursor"] + (-1 if action == "undo" else 1),
                "history cursor",
                0,
                len(data["history"]) - 1,
            )
        elif action in {"add", "remove"}:
            annotations = copy.deepcopy(data["history"][data["cursor"]])
            if action == "remove":
                identity = checked_id(request.get("annotation_id"))
                if not any(item["id"] == identity for item in annotations):
                    raise ValueError("Select an existing annotation")
                annotations = [item for item in annotations if item["id"] != identity]
            else:
                annotation = request.get("annotation")
                if not isinstance(annotation, dict):
                    raise ValueError("Choose an annotation")
                fields = {"kind", "points", "label", "color", "z", "t"}
                exact_keys(annotation, fields | {"transect"}, "new annotation")
                if set(annotation) not in (fields, fields | {"transect"}):
                    raise ValueError("New annotation fields are invalid")
                annotation = {**annotation, "id": uuid.uuid4().hex}
                # Validate coordinates before geometry arithmetic.
                points = annotation.get("points")
                if not isinstance(points, list) or not 1 <= len(points) <= 2048:
                    raise ValueError("Choose bounded annotation points")
                for point in points:
                    exact_keys(point, {"x", "y"}, "annotation point")
                    for axis in ("x", "y"):
                        finite_number(
                            point[axis], "annotation coordinate", 0, data["dimensions"][axis]
                        )
                integer(annotation["z"], "annotation Z", 0, data["dimensions"]["z"] - 1)
                annotation.update(_metrics(annotation, data["geometry"]))
                annotations.append(annotation)
            data["history"] = (data["history"][: data["cursor"] + 1] + [annotations])[-MAX_HISTORY:]
            data["cursor"] = len(data["history"]) - 1
        else:
            raise ValueError("Choose add, remove, undo or redo")
        validate_annotation_data(data, source)
        document = workbench.project.put_document(
            "annotations", source_id, data, expected_revision=revision
        )
        revision = document["revision"]
    return {
        "source_id": source_id,
        "source_sha256": source["sha256"],
        "revision": revision,
        "annotations": data["history"][data["cursor"]],
        "geometry": data["geometry"],
        "coordinate_space": data["coordinate_space"],
        "can_undo": data["cursor"] > 0,
        "can_redo": data["cursor"] < len(data["history"]) - 1,
    }
