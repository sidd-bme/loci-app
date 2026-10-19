"""Static, shared contracts for discoverable research actions.

The registry describes the native Workbench operations. Domain validators remain
authoritative for numerical, geometry and source-dependent constraints. Merely
listing an action grants no permission to execute it.
"""

from __future__ import annotations

import copy
from typing import Any

from .research_operations import OPERATION_CATALOG
from .research_recipe_guide import recipe_guide

SCHEMA = "loci.action-registry/v1"
ID = {"type": "string", "pattern": "^[a-f0-9]{32}$"}
SHA = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
NUMBER = {"type": "number"}
INDEX = {"type": "integer", "minimum": 0}
LABEL = {"type": "integer", "minimum": 1, "maximum": 2**32 - 1}
MEMORY = {"type": "integer", "minimum": 1024**2, "maximum": 8 * 1024**3}
PLANE = {"enum": ["XY", "XZ", "YZ"]}
TEXT = {"type": "string", "minLength": 1, "maxLength": 2048}


def _object(properties, required=None):
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties if required is None else required),
    }


def _array(items, minimum=0, maximum=1000):
    return {"type": "array", "items": items, "minItems": minimum, "maxItems": maximum}


BOUND = {"result_id": ID, "revision_hash": SHA}
POINT = _object({"u": NUMBER, "v": NUMBER})
POINTS = _array(POINT, 3, 4096)
RECIPE = recipe_guide()["request_schema"]
SELECTION = RECIPE["properties"]["selection"]
SOURCE = {"source_id": ID, "selection": SELECTION}
CORRECTIONS = []
for _operation, _fields in (
    ("delete", {"label": LABEL}),
    ("merge", {"source_labels": _array(LABEL, 2, 32), "target_label": LABEL}),
    (
        "brush",
        {
            "mode": {"enum": ["paint", "erase"]},
            "plane": PLANE,
            "index": INDEX,
            "points": _array(POINT, 1, 1024),
            "radius": {"type": "number", "minimum": 1e-12, "maximum": 1e12},
            "label": LABEL,
        },
    ),
    ("polygon_add", {"plane": PLANE, "index": INDEX, "points": POINTS, "label": LABEL}),
    ("polygon_replace", {"plane": PLANE, "index": INDEX, "points": POINTS, "label": LABEL}),
    (
        "move_boundary_vertex",
        {
            "plane": PLANE,
            "index": INDEX,
            "label": LABEL,
            "source_vertices": _array(POINT, 3, 96),
            "vertices": _array(POINT, 3, 96),
        },
    ),
):
    CORRECTIONS.append(
        _object({"op": {"const": _operation}, "expected_input_sha256": SHA, **_fields})
    )
for _mode, _fields in (
    (
        "2D",
        {"plane": PLANE, "index": INDEX, "seeds": _array(_object({"u": INDEX, "v": INDEX}), 2, 32)},
    ),
    ("3D", {"seeds": _array(_object({"x": INDEX, "y": INDEX, "z": INDEX}), 2, 32)}),
):
    CORRECTIONS.append(
        _object(
            {
                "op": {"const": "watershed_split"},
                "expected_input_sha256": SHA,
                "label": LABEL,
                "mode": {"const": _mode},
                **_fields,
            }
        )
    )

REQUESTS = {
    "run_recipe": RECIPE,
    "describe_result": _object(BOUND),
    "correction_info": _object({**BOUND, "label": LABEL, "plane": PLANE, "index": INDEX}, BOUND),
    "correct_result": _object(
        {**BOUND, "operations": _array({"oneOf": CORRECTIONS}, 1, 64), "working_bytes": MEMORY},
        [*BOUND, "operations"],
    ),
    "roi_add": _object(
        {
            **BOUND,
            "working_bytes": MEMORY,
            "measurement_channels": _array(INDEX, 0, 256),
            "roi": _object(
                {
                    "annotation_id": TEXT,
                    "plane": PLANE,
                    "index": INDEX,
                    "points": POINTS,
                    "slab_start": INDEX,
                    "slab_stop_exclusive": INDEX,
                },
                ["annotation_id", "plane", "index", "points"],
            ),
        },
        [*BOUND, "roi", "measurement_channels"],
    ),
    "puncta_run": _object(
        {
            **SOURCE,
            "sigma": NUMBER,
            "response_threshold": NUMBER,
            "raw_threshold": NUMBER,
            "minimum_distance": NUMBER,
            "aperture_radius": NUMBER,
            "exclude_border": {"type": "boolean"},
            "control": TEXT,
            "working_bytes": MEMORY,
        },
        [
            "source_id",
            "sigma",
            "response_threshold",
            "raw_threshold",
            "minimum_distance",
            "aperture_radius",
            "exclude_border",
            "control",
        ],
    ),
    "associate_results": _object(
        {
            "nuclei": _object(BOUND),
            "cells": _object(BOUND),
            "roles": _object({"nuclei": TEXT, "cells": TEXT}),
            "control": TEXT,
            "measurement_channels": _array(INDEX, 0, 256),
            "working_bytes": MEMORY,
        },
        ["nuclei", "cells", "roles", "control"],
    ),
    "colocalisation_run": _object(
        {
            **SOURCE,
            "first_channel": INDEX,
            "second_channel": INDEX,
            "threshold_first": NUMBER,
            "threshold_second": NUMBER,
            "control": TEXT,
            "working_bytes": MEMORY,
        },
        [
            "source_id",
            "first_channel",
            "second_channel",
            "threshold_first",
            "threshold_second",
            "control",
        ],
    ),
    "track_results": _object(
        {
            "frames": _array(
                {
                    "oneOf": [
                        _object({**BOUND, "time_s": NUMBER}),
                        _object({"frame_id": TEXT, "time_s": NUMBER, "missing_reason": TEXT}),
                    ]
                },
                2,
                1000,
            ),
            "time_declaration": TEXT,
            "max_distance": NUMBER,
            "max_gap_frames": INDEX,
            "ambiguity_distance": NUMBER,
            "registration": _object(
                {
                    "method": {"enum": ["none", "translation"]},
                    "upsample_factor": INDEX,
                    "min_normalized_correlation": NUMBER,
                },
                ["method"],
            ),
            "working_bytes": MEMORY,
        },
        ["frames", "time_declaration", "max_distance"],
    ),
    "tracking_result": _object(BOUND),
    "correct_tracks": _object(
        {
            **BOUND,
            "changes": _array(
                _object(
                    {
                        "op": {"enum": ["add", "remove"]},
                        "source_frame_id": TEXT,
                        "source_label": TEXT,
                        "target_frame_id": TEXT,
                        "target_label": TEXT,
                        "identity_uncertain": {"type": "boolean"},
                    },
                    ["op", "source_frame_id", "source_label", "target_frame_id", "target_label"],
                ),
                1,
                64,
            ),
        }
    ),
    "population_query": _object(
        {
            **BOUND,
            "x_metric": TEXT,
            "y_metric": TEXT,
            "filters": _array(
                _object({"metric": TEXT, "min": NUMBER, "max": NUMBER}, ["metric"]), 0, 32
            ),
            "sort": _object({"metric": TEXT, "direction": {"enum": ["asc", "desc"]}}),
            "offset": INDEX,
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            "plot_limit": {"type": "integer", "minimum": 1, "maximum": 2000},
            "bins": {"type": "integer", "minimum": 1, "maximum": 64},
            "selected_label": LABEL,
        },
        BOUND,
    ),
    "population_locate": _object({**BOUND, "label": LABEL}),
    "large_components_preflight": _object(
        {
            **SOURCE,
            "segmentation": {
                "type": "object",
                "additionalProperties": False,
                "required": ["threshold"],
                "properties": {
                    "method": {"const": "components"},
                    "threshold": NUMBER,
                    "polarity": {"enum": ["bright", "dark"]},
                    "min_size": NUMBER,
                    "exclude_border": {"type": "boolean"},
                },
            },
            "working_bytes": MEMORY,
        },
        ["source_id", "segmentation"],
    ),
    "large_result_view": _object(
        {
            **BOUND,
            "region": _object({"x": INDEX, "y": INDEX, "width": INDEX, "height": INDEX}),
            "max_edge": {"type": "integer", "minimum": 64, "maximum": 1024},
            "labels": {"type": "boolean"},
        },
        BOUND,
    ),
    "large_result_pick": _object(
        {**BOUND, "u": INDEX, "v": INDEX, "axis": {"const": "z"}, "index": {"const": 0}},
        [*BOUND, "u", "v"],
    ),
    "large_result_locate": _object({**BOUND, "label": LABEL}),
    "large_result_delete": _object({**BOUND, "label": LABEL}),
}
REQUESTS["large_components_run"] = copy.deepcopy(REQUESTS["large_components_preflight"])
ACTION_NAMES = frozenset(REQUESTS)
READ_ACTIONS = frozenset(name for name in REQUESTS if not OPERATION_CATALOG[name]["mutates"])
TASK_ACTIONS = ACTION_NAMES - READ_ACTIONS


def operation_catalog():
    return {
        name: {
            **value,
            **(
                {"agent_execution": "read" if name in READ_ACTIONS else "task"}
                if name in ACTION_NAMES
                else {}
            ),
        }
        for name, value in OPERATION_CATALOG.items()
    }


def action_guide(operation: str | None = None) -> dict[str, Any]:
    if operation is not None and operation not in REQUESTS:
        raise ValueError("Unknown discoverable research action")
    actions = []
    for name in sorted(REQUESTS if operation is None else [operation]):
        actions.append(
            {
                "operation": name,
                "summary": OPERATION_CATALOG[name]["summary"],
                "request_schema": copy.deepcopy(REQUESTS[name]),
                "execution": "bounded-read" if name in READ_ACTIONS else "durable-task",
                "side_effects": "none" if name in READ_ACTIONS else "new-result-revision",
                "permissions": [
                    "explicit-action",
                    "all-response-disclosures",
                    "every-input-source-selection",
                ],
                "revision_checks": "Every result input must match its revision hash; "
                "corrections also bind the label-array hash.",
                "retry": "Reuse the exact request key for durable tasks; "
                "use a new key for a changed request.",
                "undo": "Select the immutable parent result; a new result starts without review."
                if name in TASK_ACTIONS
                else "not-applicable",
                "resource_limit": "Policy CPU, memory and concurrency limits "
                "apply in a disposable process.",
            }
        )
    return {
        "schema": SCHEMA,
        "actions": actions,
        "coordinates": "Source selection uses zero-based x/y/c/z/t and exclusive crop ends. "
        "Editing points use local result-plane u/v voxel centres; plane indices are local. "
        "Geometry supplies physical units, including brush radius. Geometry-dependent bounds "
        "still apply, including a maximum brush radius of 512 voxels on either plane axis.",
        "correction_hash": "Read correction_info.label_sha256 before an edit. Each operation's "
        "expected_input_sha256 binds the preceding label state; one edit per request avoids "
        "guessing an intermediate hash.",
        "validation": "Structural schemas describe requests; the shared Workbench validator "
        "checks numerical, geometry and source-dependent constraints. A grant permits execution, "
        "not a scientific claim.",
    }
