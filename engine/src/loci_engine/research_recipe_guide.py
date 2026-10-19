"""Static recipe guidance shared by the human CLI and policy-bound MCP.

This module reads no project or filesystem and imports no numerical backend.
The production Workbench validators remain authoritative for source-dependent
geometry, units, resource estimates, channel declarations and execution grants.
"""

from __future__ import annotations

from typing import Any


def recipe_guide(*, experimental: bool = False) -> dict[str, Any]:
    """Return fresh, source-independent documentation; never normalize or run."""
    nonnegative = {"type": "integer", "minimum": 0}
    positive = {"type": "integer", "minimum": 1}
    selection = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            **{name: dict(nonnegative) for name in ("x", "y", "t", "c", "z", "level")},
            **{name: dict(positive) for name in ("width", "height", "z_stop")},
        },
    }
    steps = []
    for operation, fields in (
        ("gaussian", {"sigma": {"type": "number", "minimum": 0, "maximum": 1e6}}),
        (
            "subtract_background",
            {
                "sigma": {"type": "number", "minimum": 0, "maximum": 1e6},
                "clip_negative": {"type": "boolean"},
            },
        ),
        (
            "subtract_constant",
            {
                "value": {"type": "number", "minimum": -1e15, "maximum": 1e15},
                "clip_negative": {"type": "boolean"},
            },
        ),
        *[
            (name, {"radius": {"type": "number", "minimum": 0, "maximum": 1e6}})
            for name in ("median", "opening", "closing")
        ],
    ):
        steps.append(
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["op", next(iter(fields))],
                "properties": {"op": {"const": operation}, **fields},
            }
        )
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Loci policy-bound recipe request",
        "type": "object",
        "additionalProperties": False,
        "required": ["source_id"],
        "properties": {
            "source_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
            "selection": selection,
            "recipe": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "steps": {"type": "array", "maxItems": 32, "items": {"oneOf": steps}},
                    "segmentation": {
                        "anyOf": [
                            {"type": "null"},
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "method": {"enum": ["components", "watershed"]},
                                    "threshold": {
                                        "anyOf": [
                                            {"const": "otsu"},
                                            {"type": "number", "minimum": -1e30, "maximum": 1e30},
                                        ]
                                    },
                                    "polarity": {"enum": ["bright", "dark"]},
                                    "min_size": {"type": "number", "minimum": 0, "maximum": 1e20},
                                    "split_height": {
                                        "type": "number",
                                        "minimum": 1e-9,
                                        "maximum": 1e9,
                                    },
                                    "exclude_border": {"type": "boolean"},
                                },
                            },
                        ]
                    },
                    "measurement_channels": {
                        "type": "array",
                        "maxItems": 32,
                        "uniqueItems": True,
                        "items": dict(nonnegative),
                    },
                    "gates": {
                        "type": "array",
                        "maxItems": 64,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["name", "channel", "threshold", "control"],
                            "properties": {
                                **{
                                    name: {"type": "string", "minLength": 1}
                                    for name in ("name", "channel", "control")
                                },
                                "statistic": {"enum": ["mean", "sum", "max"]},
                                "threshold": {"type": "number", "minimum": -1e30, "maximum": 1e30},
                            },
                        },
                    },
                    "working_bytes": {"type": "integer", "minimum": 1024, "maximum": 8 * 1024**3},
                    "input_transform": {"const": "rgb_intensity"},
                    "references": {"type": "object", "maxProperties": 0},
                },
            },
        },
    }
    examples = []
    for name, description, selected, recipe in (
        (
            "components-2d",
            "A 16 x 16 pixel crop on scalar plane Z=0; authored threshold.",
            {"t": 0, "c": 0, "z": 0, "level": 0, "x": 0, "y": 0, "width": 16, "height": 16},
            {
                "segmentation": {"method": "components", "threshold": 50, "polarity": "bright"},
                "measurement_channels": [0],
                "working_bytes": 64 * 1024**2,
            },
        ),
        (
            "watershed-3d",
            "A 16 x 16 pixel crop across Z=[0,4); physical watershed split height.",
            {
                "t": 0,
                "c": 0,
                "z": 0,
                "z_stop": 4,
                "level": 0,
                "x": 0,
                "y": 0,
                "width": 16,
                "height": 16,
            },
            {
                "steps": [{"op": "gaussian", "sigma": 0.5}],
                "segmentation": {"method": "watershed", "threshold": 50, "split_height": 1},
                "measurement_channels": [0],
                "working_bytes": 64 * 1024**2,
            },
        ),
    ):
        examples.append(
            {
                "name": name,
                "description": description,
                "request": {
                    "source_id": "0" * 32,
                    "selection": selected,
                    "recipe": recipe,
                },
            }
        )
    document = {
        "schema": "loci.recipe-guide/v1",
        "validator": "Workbench.validate_recipe is authoritative; this schema documents "
        "request structure, not source compatibility or permission.",
        "request_schema": schema,
        "guidance": [
            "Replace the example source_id with an explicitly selected registered source; "
            "examples are not scientific recommendations.",
            "Coordinates are zero-based x/y pixels at the selected pyramid level; "
            "crop ends and z_stop are exclusive.",
            "sigma, radius and split_height use the source geometry length unit; min_size uses "
            "area in 2D or volume in 3D. Uncalibrated units remain pixels.",
            "Declare biological channels explicitly; RGB samples are not biological channels. "
            "rgb_intensity is an explicit conversion and forbids references and marker gates.",
            "Use validate_recipe to resolve defaults, calculate memory estimates and read "
            "approved preview/run status. Validation grants no execution right.",
            "Preview and submit require the exact approved normalized recipe hash and "
            "independently authorized source scope, runtime and operation.",
            "MCP rejects non-empty references; flat-field and dark-field references require "
            "the human workbench, not this agent guide.",
            "MCP cannot import, browse files, change policy, provision models or create human "
            "review. Export requires a review of the exact result revision. A v4 policy "
            "may explicitly delegate agent approval, recorded separately from human review.",
        ],
        "examples": examples,
    }

    if experimental:
        document["experimental_guidance"] = {
            "policy_schema": "loci.agent-policy/v3",
            "templates": "analysis_context lists only human-approved normalized templates.",
            "parameters": ["threshold", "min_size"],
            "bounds": "Only finite values inside each approved inclusive min/max range may vary. "
            "min_size is nonnegative and uses the selected geometry's area/volume unit.",
            "fixed": "Source, selection, method, preprocessing, gates, channels, units, memory "
            "and every other recipe field remain fixed. References, models and code are "
            "unavailable.",
            "authorization": "Use validate_recipe approved.preview/run before execution. Exact "
            "legacy recipe grants remain independent. A template grants no human review "
            "or policy editing.",
        }
    return document
