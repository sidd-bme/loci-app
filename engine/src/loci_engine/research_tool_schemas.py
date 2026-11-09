"""Static discovery schemas for tools whose native boundary accepts exact dictionaries.

These describe requests, not authority. Annotated dictionary metadata enriches MCP
discovery without coercing values or replacing the native validators/policy checks.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Annotated, Any

from pydantic import Field

_ID = {"type": "string", "pattern": "^[a-f0-9]{32}$", "minLength": 32, "maxLength": 32}
_SHA = {"type": "string", "pattern": "^[a-f0-9]{64}$", "minLength": 64, "maxLength": 64}
_INDEX = {"type": "integer", "minimum": 0}
_DISPLAY_VALUE = {"type": "number", "minimum": -1e30, "maximum": 1e30}
_ASSESSMENT = {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096,
    "allOf": [
        {"pattern": r"\S"},
        {"not": {"pattern": r"[\u0000-\u0008\u000b-\u001f]"}},
    ],
}

SOURCE_IMAGE_REQUEST_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "description": (
        "Explicit display-only rendering. Obtain a permitted source handle, geometry and axis "
        "grants from analysis_context/inspect_source; obtain display settings from source_display "
        "when granted. Every selection and channel, including invisible channels, must be within "
        "the active source grant and native bounds. Crop dimensions are pixels at the selected "
        "pyramid level. CPU runtime, preview disclosure and memory limits remain mandatory. "
        "Interleaved RGB/RGBA requires one channel entry and projection=plane."
    ),
    "required": ["source_id", "selection", "channels", "projection", "max_size"],
    "properties": {
        "source_id": {**_ID, "description": "Exact permitted source handle; never a file path."},
        "selection": {
            "type": "object",
            "additionalProperties": False,
            "required": ["x", "y", "width", "height", "t", "c", "z", "level"],
            "properties": {
                "x": {**_INDEX, "description": "Zero-based crop column at the chosen level."},
                "y": {**_INDEX, "description": "Zero-based crop row at the chosen level."},
                "width": {"type": "integer", "minimum": 1, "maximum": 2048},
                "height": {"type": "integer", "minimum": 1, "maximum": 2048},
                "t": {**_INDEX, "description": "Explicit zero-based time index."},
                "c": {**_INDEX, "description": "Explicit zero-based selection channel."},
                "z": {**_INDEX, "description": "Zero-based plane or inclusive projection start."},
                "level": {**_INDEX, "description": "Explicit zero-based pyramid level."},
                "z_stop": {
                    "type": "integer",
                    "minimum": 1,
                    "description": (
                        "Exclusive projection end, strictly greater than z and within native "
                        "and granted Z bounds. Required for max/mean; forbidden for plane."
                    ),
                },
            },
        },
        "channels": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "description": (
                "Explicit display channels with unique channel indices. Display transforms "
                "do not alter scientific samples; high must strictly exceed low."
            ),
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["channel", "low", "high", "gamma", "color", "opacity", "visible"],
                "properties": {
                    "channel": {"type": "integer", "minimum": 0, "maximum": 1_000_000},
                    "low": {**_DISPLAY_VALUE, "description": "Finite display lower bound."},
                    "high": {
                        **_DISPLAY_VALUE,
                        "description": "Finite display upper bound, strictly greater than low.",
                    },
                    "gamma": {"type": "number", "minimum": 0.1, "maximum": 10},
                    "color": {
                        "type": "string",
                        "pattern": "^#[a-fA-F0-9]{6}$",
                        "minLength": 7,
                        "maxLength": 7,
                    },
                    "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                    "visible": {"type": "boolean"},
                },
            },
        },
        "projection": {"type": "string", "enum": ["plane", "max", "mean"]},
        "max_size": {
            "type": "integer",
            "minimum": 64,
            "maximum": 2048,
            "description": "Maximum output thumbnail edge in pixels; aspect ratio is preserved.",
        },
    },
    "allOf": [
        {
            "if": {"properties": {"projection": {"const": "plane"}}},
            "then": {"properties": {"selection": {"not": {"required": ["z_stop"]}}}},
            "else": {"properties": {"selection": {"required": ["z_stop"]}}},
        }
    ],
}

REVIEW_RESULT_REQUEST_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "description": (
        "Append a declared agent decision for an inspected, policy-accessible result revision. "
        "Requires explicit review_result permission, agent_metadata disclosure and delegation. "
        "Read review_history immediately before deciding and copy current_review_sha256 exactly. "
        "Never supply actor/authority fields: identity comes from the policy delegation. "
        "A decision is not biological validation; export separately requires a reviewed exact "
        "revision and its own grants."
    ),
    "required": [
        "result_id",
        "revision_hash",
        "disposition",
        "reason",
        "coverage",
        "expected_review_sha256",
    ],
    "properties": {
        "result_id": {**_ID, "description": "Exact result handle from study_results/result."},
        "revision_hash": {**_SHA, "description": "Exact inspected current result revision."},
        "disposition": {"type": "string", "enum": ["reviewed", "excluded", "pending"]},
        "reason": {
            **_ASSESSMENT,
            "description": "Explicit assessment reason; nonblank text, newline/tab permitted.",
        },
        "coverage": {
            **_ASSESSMENT,
            "description": (
                "Explicit inspected coverage and limits; nonblank text, newline/tab permitted. "
                "Do not claim inspection of unobserved planes or regions."
            ),
        },
        "expected_review_sha256": {
            "anyOf": [_SHA, {"type": "null"}],
            "description": (
                "Copy review_history.current_review_sha256: null only when no prior review "
                "exists, otherwise its exact lowercase SHA-256. A stale digest is rejected."
            ),
        },
    },
}

SourceImageRequest = Annotated[dict[str, Any], Field(json_schema_extra=SOURCE_IMAGE_REQUEST_SCHEMA)]
ReviewResultRequest = Annotated[
    dict[str, Any], Field(json_schema_extra=REVIEW_RESULT_REQUEST_SCHEMA)
]


def _closed(properties, required=None):
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(properties) if required is None else required,
        "properties": properties,
    }


_LIVE = _closed(
    {
        "view_id": {"type": "string", "minLength": 1, "maxLength": 128},
        **{
            key: {"type": "integer", "minimum": 0, "maximum": 2**53 - 1}
            for key in ("renderer_generation", "live_epoch", "revision", "display_revision")
        },
    }
)
_VECTOR = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}
_RESULT = _closed({"result_id": _ID, "revision_hash": _SHA, "label_sha256": _SHA})
_CAMERA = _closed(
    {
        "projection": {"enum": ["parallel", "perspective"]},
        **{key: _VECTOR for key in ("position_xyz", "focal_point_xyz", "view_up_xyz")},
        "clipping_range": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 2,
            "maxItems": 2,
        },
        "view_angle_degrees": {"type": "number", "minimum": 0.01, "maximum": 179},
        "parallel_scale": {"type": ["number", "null"]},
        "frame": {"enum": ["image", "LPS", "RAS"]},
        "unit": {"type": "string", "maxLength": 32},
    }
)
VOLUME_STATE_PROPERTIES = {
    "t": _INDEX,
    "channels": {
        "type": "array",
        "items": _INDEX,
        "minItems": 1,
        "maxItems": 4,
        "uniqueItems": True,
    },
    "result": {"anyOf": [_RESULT, {"type": "null"}]},
    "selected_object": {
        "anyOf": [
            _closed(
                {
                    **_RESULT["properties"],
                    "label_id": {"type": "integer", "minimum": 1, "maximum": 2**32 - 1},
                }
            ),
            {"type": "null"},
        ]
    },
    "representation": _closed(
        {
            "mode": {"enum": ["volume", "mpr"]},
            "extent": {"enum": ["context", "focus"]},
            "render_mode": {"enum": ["blend", "normal_shading", "mip", "average", "minip"]},
            "quality": {"type": "integer", "minimum": 1, "maximum": 100},
        }
    ),
    "camera": {"anyOf": [_CAMERA, {"type": "null"}]},
    "crosshair_source_xyz": {
        "type": "array",
        "items": _INDEX,
        "minItems": 3,
        "maxItems": 3,
        "description": "Level-zero source XYZ indices, never display-grid/local ZYX coordinates.",
    },
    "clipping": _closed(
        {
            "enabled": {"type": "boolean"},
            "axis": {"enum": ["x", "y", "z"]},
            "position_percent": {"type": "number", "minimum": 0, "maximum": 100},
        }
    ),
    "refinement": _closed(
        {
            "target_long_axis": {"type": "integer", "minimum": 16, "maximum": 256},
            "focus_region_xyzxyz": {
                "anyOf": [
                    {
                        "type": "array",
                        "items": _INDEX,
                        "minItems": 6,
                        "maxItems": 6,
                        "description": "Inclusive level-zero [x0,x1,y0,y1,z0,z1] source extent.",
                    },
                    {"type": "null"},
                ]
            },
        }
    ),
    "layout": _closed(
        {
            "mode": {"enum": ["four", "single"]},
            "expanded_pane": {"enum": ["axial", "coronal", "sagittal", "volume", None]},
            "pane_order": {
                "type": "array",
                "items": {"enum": ["axial", "coronal", "sagittal", "volume"]},
                "minItems": 4,
                "maxItems": 4,
                "uniqueItems": True,
            },
            "col_split": {"type": "number", "minimum": 10, "maximum": 90},
            "row_split": {"type": "number", "minimum": 10, "maximum": 90},
        }
    ),
    "labels": _closed(
        {
            "visible": {"type": "boolean"},
            "opacity": {"type": "number", "minimum": 0, "maximum": 1},
            "selected_only": {"type": "boolean"},
        }
    ),
}
SET_VOLUME_VIEW_REQUEST_SCHEMA = _closed(
    {
        "source_id": _ID,
        "source_sha256": _SHA,
        "expected_live": _LIVE,
        "patch": {**_closed(VOLUME_STATE_PROPERTIES, []), "minProperties": 1},
    }
)
VOLUME_VIEW_IMAGE_REQUEST_SCHEMA = _closed(
    {
        "source_id": _ID,
        "source_sha256": _SHA,
        "expected_live": _LIVE,
        "panes": {
            "type": "array",
            "items": {"enum": ["volume", "axial", "coronal", "sagittal"]},
            "minItems": 1,
            "maxItems": 4,
            "uniqueItems": True,
        },
        "max_size": {"type": "integer", "minimum": 64, "maximum": 2048},
    }
)
SetVolumeViewRequest = Annotated[
    dict[str, Any], Field(json_schema_extra=SET_VOLUME_VIEW_REQUEST_SCHEMA)
]
VolumeViewImageRequest = Annotated[
    dict[str, Any], Field(json_schema_extra=VOLUME_VIEW_IMAGE_REQUEST_SCHEMA)
]


def tool_request_schema(name: str) -> dict[str, Any] | None:
    """Return detached, source-independent request documentation for the catalog."""
    schemas = {
        "source_image": SOURCE_IMAGE_REQUEST_SCHEMA,
        "review_result": REVIEW_RESULT_REQUEST_SCHEMA,
        "set_volume_view": SET_VOLUME_VIEW_REQUEST_SCHEMA,
        "volume_view_image": VOLUME_VIEW_IMAGE_REQUEST_SCHEMA,
    }
    return deepcopy(schemas[name]) if name in schemas else None
