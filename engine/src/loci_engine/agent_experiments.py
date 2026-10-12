"""Exact source-bound classical experiment templates; never executable code."""

from __future__ import annotations

import copy
from typing import Any

from .quantitative import finite_number
from .research_project import canonical_json

FIELDS = {"key", "source_id", "selection", "recipe", "parameters", "preview", "run"}
TEMPLATE_DISCLOSURES = {"geometry", "provenance", "agent_metadata"}


def normalize_templates(project, templates: Any) -> list[dict[str, Any]]:
    """Human writer resolves defaults once; loaders require this stored form."""
    from .workbench import Workbench

    if not isinstance(templates, list) or len(templates) > 16:
        raise ValueError("Experimental recipes must be a list of at most 16 templates")
    workbench = Workbench(project)
    try:
        output = []
        for item in templates:
            if not isinstance(item, dict) or set(item) != FIELDS:
                raise ValueError("Experimental template fields must be exact")
            if isinstance(item["recipe"], dict) and item["recipe"].get("references"):
                raise PermissionError("Experimental recipes cannot bind reference sources")
            validated = workbench.validate_recipe(
                {key: item[key] for key in ("source_id", "selection", "recipe")}
            )
            output.append(
                {
                    **copy.deepcopy(item),
                    **{key: validated[key] for key in ("source_id", "selection", "recipe")},
                }
            )
        return output
    finally:
        workbench.close()


def validate_templates(project, root, sources) -> None:
    from .agent_policy import _exact_keys, _text

    templates = root["experimental_recipes"]
    normalized = normalize_templates(project, templates)
    if canonical_json(normalized) != canonical_json(templates):
        raise ValueError("Stored experimental templates must be fully normalized")
    if templates and not set(root["disclosures"]) >= TEMPLATE_DISCLOSURES:
        raise PermissionError(
            "Experimental templates require geometry, provenance and agent_metadata"
        )
    seen = set()
    for template in templates:
        key = _text(template["key"], "experimental key", 80)
        if key in seen:
            raise ValueError("Experimental template keys must be unique")
        seen.add(key)
        for purpose in ("preview", "run"):
            if not isinstance(template[purpose], bool):
                raise ValueError("Experimental preview and run must be boolean")
        grant = sources.get(template["source_id"])
        recipe = template["recipe"]
        if grant is None or not grant.allows(template["selection"], recipe["measurement_channels"]):
            raise PermissionError("Experimental template exceeds the source scope")
        if recipe["working_bytes"] > root["limits"]["memory_bytes"]:
            raise PermissionError("Experimental template exceeds the memory scope")
        parameters = template["parameters"]
        segmentation = recipe.get("segmentation")
        if (
            not isinstance(parameters, dict)
            or not parameters
            or not set(parameters) <= {"threshold", "min_size"}
            or not isinstance(segmentation, dict)
        ):
            raise ValueError("Experimental parameters require threshold and/or min_size ranges")
        for name, bounds in parameters.items():
            value = _exact_keys(bounds, {"min", "max"}, "experimental range")
            minimum = 0 if name == "min_size" else -1e30
            maximum = 1e20 if name == "min_size" else 1e30
            low = finite_number(value["min"], "range minimum", minimum, maximum)
            high = finite_number(value["max"], "range maximum", minimum, maximum)
            if low > high:
                raise ValueError("Experimental minimum must not exceed maximum")
            finite_number(segmentation.get(name), "template parameter", low, high)


def matching_templates(policy, validated: dict[str, Any], purpose: str | None = None):
    """Only the named numeric segmentation fields may differ from a template."""
    matches = []
    for template in policy.experimental_recipes.values():
        if (
            template["source_id"] != validated["source_id"]
            or canonical_json(template["selection"]) != canonical_json(validated["selection"])
            or purpose is not None
            and not template[purpose]
        ):
            continue
        recipe = copy.deepcopy(validated["recipe"])
        segmentation = recipe.get("segmentation")
        if not isinstance(segmentation, dict):
            continue
        try:
            for name, bounds in template["parameters"].items():
                finite_number(
                    segmentation.get(name), "experimental parameter", bounds["min"], bounds["max"]
                )
                segmentation[name] = template["recipe"]["segmentation"][name]
        except ValueError:
            continue
        if canonical_json(recipe) == canonical_json(template["recipe"]):
            matches.append(template)
    return matches
