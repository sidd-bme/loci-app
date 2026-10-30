"""Static, shared contracts for discoverable research actions.

The registry describes the native Workbench operations. Domain validators remain
authoritative for numerical, geometry and source-dependent constraints. Merely
listing an action grants no permission to execute it.
"""

from __future__ import annotations

import copy
from typing import Any

from .profiles import DEFAULT_PROFILE_ID
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
ADAPTIVE_SETTINGS = _object(
    {
        "image_mode": {"enum": ["auto", "brightfield", "fluorescence"]},
        "polarity": {"enum": ["auto", "dark", "bright"]},
        "expected_diameter_px": {"type": "number", "minimum": 4, "maximum": 1000},
        "min_area_px": {"type": "integer", "minimum": 1, "maximum": 10_000_000},
        "sensitivity": {"type": "number", "minimum": -1, "maximum": 1},
        "smoothing_px": {"type": "number", "minimum": 0, "maximum": 20},
        "split_touching": {"type": "boolean"},
        "exclude_border": {"type": "boolean"},
    }
)
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
    "classical_run": _object(
        {
            "source_id": ID,
            "selection": _object(
                {
                    **{name: INDEX for name in ("x", "y", "t", "c", "z", "level")},
                    "width": {"type": "integer", "minimum": 1},
                    "height": {"type": "integer", "minimum": 1},
                }
            ),
            "profile_id": {"const": DEFAULT_PROFILE_ID},
            "settings": ADAPTIVE_SETTINGS,
            "measurement_channels": _array(INDEX, 0, 32),
            "working_bytes": MEMORY,
        }
    ),
    "describe_result": _object(BOUND),
    "spatial_distance_run": _object(
        {
            **BOUND,
            "compartment": _object(BOUND),
            "boundary": _object(BOUND),
            "band_edges": _array(NUMBER, 2, 33),
            "exclude_crop_border": {"type": "boolean"},
            "control": TEXT,
            "boundary_coverage": TEXT,
            "working_bytes": MEMORY,
        }
    ),
    "perinuclear_run": _object(
        {
            **BOUND,
            "signal_channel": {"type": "integer", "minimum": 0, "maximum": 255},
            "radius_px": {"type": "number", "exclusiveMinimum": 0, "maximum": 128},
            "working_bytes": MEMORY,
            "control": TEXT,
        }
    ),
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
# Named native contracts. Preview computation is a durable task even when no
# scientific result is published; mutation flags alone do not describe execution.
WORKFLOW_BINDING = {
    "workflow_id": ID,
    "workflow_revision": {"type": "integer", "minimum": 1, "maximum": 2**31 - 1},
    "definition_sha256": SHA,
    "source_id": ID,
    "source_sha256": SHA,
    "selection": SELECTION,
}
EXPLORATION_SOURCE = {"source_id": ID, "source_sha256": SHA}
CONFIGURATION = _object({"threshold": NUMBER, "min_size": NUMBER}, ["threshold"])
DESCRIPTOR = _object(
    {
        "id": TEXT,
        "label": TEXT,
        "unit": TEXT,
        "kind": TEXT,
        "channel": TEXT,
        "statistic": TEXT,
        "compartment": TEXT,
    },
    ["id", "label", "unit"],
)
GATE = _object(
    {
        "kind": {"enum": ["rectangle", "polygon"]},
        **{f"{axis}_metric": TEXT for axis in ("x", "y")},
        **{f"{axis}_transform": {"enum": ["linear", "log10"]} for axis in ("x", "y")},
        **{f"{axis}_descriptor": DESCRIPTOR for axis in ("x", "y")},
        "edge_policy": {"const": "include"},
        "bounds": _array(NUMBER, 4, 4),
        "vertices": _array(_array(NUMBER, 2, 2), 3, 64),
    },
    ["kind", "x_metric", "y_metric"],
)
REQUESTS.update(
    {
        "workflow_list": _object({}),
        "workflow_get": _object({"workflow_id": ID}),
        "workflow_preflight": _object(WORKFLOW_BINDING),
        "workflow_preview": _object({**WORKFLOW_BINDING, "target_node_id": TEXT}),
        "workflow_run": _object(WORKFLOW_BINDING),
        "workflow_status": _object({"run_id": ID}),
        "exploration_list": _object(EXPLORATION_SOURCE),
        "exploration_get": _object({**EXPLORATION_SOURCE, "comparison_id": ID}),
        "exploration_preview": _object(
            {
                **EXPLORATION_SOURCE,
                "selection": SELECTION,
                **CONFIGURATION["properties"],
            },
            [*EXPLORATION_SOURCE, "selection", "threshold"],
        ),
        "exploration_compare": _object(
            {
                **EXPLORATION_SOURCE,
                "regions": _array(SELECTION, 1, 3),
                "configurations": _array(CONFIGURATION, 1, 3),
            }
        ),
        # The canonical native receipt representation retains exact numeric spelling.
        "exploration_run": _object({"receipt_json": TEXT}),
        "population_gate_evaluate": _object(
            {
                **BOUND,
                "gate": GATE,
                "include_centroids": {"type": "boolean"},
            },
            [*BOUND, "gate"],
        ),
        "population_group_list": _object(BOUND),
        "population_group_get": _object(
            {
                **BOUND,
                "group_id": ID,
                "include_centroids": {"type": "boolean"},
            },
            [*BOUND, "group_id"],
        ),
        "study_summary": _object(
            {"result_ids": _array(ID, 1, 100), "value": {"const": "measure"}}, ["result_ids"]
        ),
        "intensity_catalog": _object({"result_ids": _array(ID, 1, 100)}),
        "intensity_preview": _object(
            {
                "result_ids": _array(ID, 1, 100),
                "endpoint": _object(
                    {
                        "schema": {"const": "loci.intensity-endpoint/v1"},
                        "kind": {"const": "raw-channel-intensity"},
                        "statistic": {"const": "mean"},
                        "unit": {"const": "source-intensity"},
                        "compartment": {"enum": ["object", "cell", "nuclear", "cytoplasm"]},
                    }
                ),
                "metric_ids": {
                    "type": "object",
                    "minProperties": 1,
                    "maxProperties": 100,
                    "propertyNames": ID,
                    "additionalProperties": TEXT,
                },
                "declaration": _object(
                    {name: TEXT for name in ("channel", "acquisition_context", "rationale")}
                ),
            }
        ),
        "spatial_density_preview": _object(
            {
                "fields": _array(
                    {
                        "oneOf": [
                            _object(BOUND),
                            _object(
                                {**BOUND, "phenotype_group_id": ID, "phenotype_record_sha256": SHA}
                            ),
                        ]
                    },
                    1,
                    256,
                ),
                "phenotype_name": TEXT,
                "stratum": _object({"t": INDEX, "z": INDEX}),
                "condition_pair": _array(TEXT, 2, 2),
            },
            ["fields"],
        ),
        "spatial_density_save": _object({"preview_id": ID, "preview_hash": SHA}),
        "spatial_density_query": _object(
            {
                "preview_id": ID,
                "preview_hash": SHA,
                "report_id": ID,
                "table": {
                    "enum": [
                        "input_snapshots",
                        "field_rows",
                        "donor_rows",
                        "condition_rows",
                        "paired_rows",
                        "paired_summary",
                        "unmatched_donors",
                        "exclusion_audit",
                        "cells",
                    ]
                },
                "field_result_id": ID,
                "offset": INDEX,
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            ["table", "offset", "limit"],
        ),
        "spatial_density_get": _object({"report_id": ID}),
        "spatial_density_list": _object({}),
        "intensity_get": _object({"report_id": ID}),
        "intensity_list": _object({}),
        "task_preview_get": _object({"job_id": ID}),
    }
)
REQUESTS["exploration_run"]["properties"]["receipt_json"] = {
    "type": "string",
    "minLength": 1,
    "maxLength": 1024**2,
}
# Explicit execution membership is deliberate: a new native operation gains no
# agent authority by changing its mutates flag or joining a general dispatcher.
READ_ACTIONS = frozenset(
    {
        "describe_result",
        "correction_info",
        "tracking_result",
        "population_locate",
        "population_query",
        "large_components_preflight",
        "large_result_view",
        "large_result_pick",
        "large_result_locate",
        "workflow_list",
        "workflow_get",
        "workflow_preflight",
        "workflow_status",
        "exploration_list",
        "exploration_get",
        "population_gate_evaluate",
        "population_group_list",
        "population_group_get",
        "study_summary",
        "intensity_catalog",
        "intensity_preview",
        "intensity_get",
        "intensity_list",
        "spatial_density_preview",
        "spatial_density_get",
        "spatial_density_list",
        "spatial_density_query",
        "task_preview_get",
    }
)
PREVIEW_ACTIONS = frozenset({"workflow_preview", "exploration_preview", "exploration_compare"})
PUBLICATION_ACTIONS = frozenset(
    {
        "run_recipe",
        "classical_run",
        "perinuclear_run",
        "spatial_distance_run",
        "spatial_density_save",
        "correct_result",
        "roi_add",
        "puncta_run",
        "associate_results",
        "colocalisation_run",
        "track_results",
        "correct_tracks",
        "large_components_run",
        "large_result_delete",
        "workflow_run",
        "exploration_run",
    }
)
TASK_ACTIONS = PREVIEW_ACTIONS | PUBLICATION_ACTIONS
ACTION_NAMES = frozenset(REQUESTS)
EXECUTION_KINDS = {
    **dict.fromkeys(READ_ACTIONS, "inspection"),
    **dict.fromkeys(PREVIEW_ACTIONS, "preview-task"),
    **dict.fromkeys(PUBLICATION_ACTIONS, "publication-task"),
}
assert set(EXECUTION_KINDS) == ACTION_NAMES
assert not READ_ACTIONS & TASK_ACTIONS


def _execution_contract(name):
    return {
        "execution_kind": EXECUTION_KINDS[name],
        "native_operation": name,
        "output_types": [
            "retained-task-preview"
            if name == "task_preview_get"
            else "native-inspection"
            if name in READ_ACTIONS
            else "task-preview"
            if name in PREVIEW_ACTIONS
            else "immutable-density-report"
            if name == "spatial_density_save"
            else "immutable-result-revision"
        ],
        "cancellation": "Cancel only the exact policy/session-owned job"
        if name in TASK_ACTIONS
        else "Disposable worker CPU, memory and response bounds",
        "resource_estimate": "Native preflight; request/recipe memory budget capped by policy"
        if name in TASK_ACTIONS
        else "Policy-bounded document and measurement inspection",
    }


def operation_catalog():
    return {
        name: {
            **value,
            **(
                {
                    "agent_execution": "read" if name in READ_ACTIONS else "task",
                    **_execution_contract(name),
                }
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
                **_execution_contract(name),
                "side_effects": (
                    "bounded-preview-cache"
                    if name == "spatial_density_preview"
                    else "saved-comparison-receipt"
                    if name == "exploration_compare"
                    else "none"
                    if name in READ_ACTIONS or name in PREVIEW_ACTIONS
                    else "saved-density-report"
                    if name == "spatial_density_save"
                    else "new-result-revision"
                ),
                "permissions": [
                    "explicit-action",
                    "all-response-disclosures",
                    "every-input-source-selection",
                ],
                "revision_checks": "Every result input must match its revision hash; "
                "corrections also bind the label-array hash.",
                "retry": "Reuse the exact request key for durable tasks; "
                "use a new key for a changed request.",
                "undo": (
                    "No result adopted; retained preview may expire"
                    if name in PREVIEW_ACTIONS
                    else "Retain the immutable report; preview changed inputs as a new report."
                    if name == "spatial_density_save"
                    else "Select the immutable parent result; a new result starts without review."
                    if name in TASK_ACTIONS
                    else "not-applicable"
                ),
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
