"""Read-only, revision-bound study commands over the existing population API."""

from __future__ import annotations

import argparse
import math
import os
from typing import Any


def measurement_range(value: str) -> tuple[float, float]:
    try:
        low, high = (float(part) for part in value.split(":"))
    except (ValueError, OverflowError) as exc:
        raise argparse.ArgumentTypeError("Use a finite nonnegative range MIN:MAX.") from exc
    if not all(math.isfinite(v) and v >= 0 for v in (low, high)) or low > high:
        raise argparse.ArgumentTypeError("Range must be finite, nonnegative and MIN <= MAX.")
    return low, high


def add_commands(sub: Any) -> None:
    opened = sub.add_parser("open", help="Inspect a study and select its sole measurable result")
    opened.add_argument("path", help="Existing study directory; relative to the current directory")
    for name, help_text in (
        ("objects", "Query measured objects in label order with native-unit ranges"),
        ("locate", "Locate an exact object label in result-grid coordinates"),
    ):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--project", help="Existing study path; session uses its opened study")
        if name == "objects":
            size = command.add_mutually_exclusive_group()
            size.add_argument(
                "--area", type=measurement_range, help="Inclusive MIN:MAX in native area units"
            )
            size.add_argument(
                "--volume", type=measurement_range, help="Inclusive MIN:MAX in native volume units"
            )
            command.add_argument(
                "--spacing",
                type=measurement_range,
                help="Inclusive nearest-centroid distance MIN:MAX in native units",
            )
            command.add_argument(
                "--limit", type=int, default=5, help="Rows to return, 1 to 200 (default 5)"
            )
        else:
            command.add_argument("label", type=int, help="Exact positive object label")
    for name in ("open", "objects", "locate"):
        command = sub.choices[name]
        command.add_argument(
            "--result", help="Exact result ID; required when several results qualify"
        )
        command.add_argument("--revision", help="Exact result revision; stale bindings fail closed")


def _candidates(project: Any) -> list[dict[str, Any]]:
    from .quantitative import MAX_OBJECTS
    from .research_workspace_records import read_visibility

    hidden = read_visibility(project)["data"]
    results = []
    for result in project.list_results():
        if result["id"] in hidden["results"] or result["source_id"] in hidden["sources"]:
            continue
        if "labels" not in result.get("arrays", {}):
            continue
        rows = result["provenance"].get("measurements")
        eligible = (
            result["schema"] == "loci.research-result/v1"
            and isinstance(rows, list)
            and len(rows) <= MAX_OBJECTS
        ) or (
            result["schema"] == "loci.research-result/v2" and result["object_count"] <= MAX_OBJECTS
        )
        if eligible:
            results.append(result)
    return results


def _context(project: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "study": project.meta["title"],
        "source": project.source(result["source_id"])["name"],
        "kind": result["kind"],
        "result_id": result["id"],
        "review": project.review_state(result["id"]),
        "warnings": result["provenance"].get("warnings", []),
    }


def execute(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any] | None]:
    from .research_population import population_locate, population_query
    from .research_project import ResearchProject, checked_id

    # Lexical absolute conversion deliberately does not resolve a symlink before
    # ResearchProject applies its existing directory/layout/identity checks.
    location = args.path if args.command == "open" else args.project
    if location is None:
        raise ValueError("Choose --project PATH, or open a study in the interactive session.")
    project = ResearchProject(os.path.abspath(os.path.expanduser(location)))
    candidates = _candidates(project)
    explicit = getattr(args, "result", None)
    result = None
    if explicit is not None:
        checked_id(explicit)
        result = next((item for item in candidates if item["id"] == explicit), None)
        if result is None:
            raise ValueError("Choose a visible label-bearing measurable result from this study.")
    elif len(candidates) == 1:
        result = candidates[0]
    if result is None and args.command != "open":
        choices = ", ".join(item["id"] for item in candidates) or "none"
        raise ValueError(
            f"Choose --result ID explicitly; eligible results: {choices}. Use open to inspect."
        )
    revision = getattr(args, "revision", None)
    if revision is not None and result is None:
        raise ValueError("Choose a result before binding an exact revision.")
    request = None
    validation = None
    context = None
    if result is not None:
        request = {
            "result_id": result["id"],
            "revision_hash": revision if revision is not None else result["revision_hash"],
        }
        # Validate the full measured population and immutable source with the
        # same operation before selecting a result or interpreting its metrics.
        validation = population_query(project, {**request, "limit": 1, "plot_limit": 1})
        context = _context(project, result)
    if args.command == "open":
        choices = []
        for index, item in enumerate(candidates, 1):
            choices.append(
                {"number": index, **_context(project, item), "revision_hash": item["revision_hash"]}
            )
        return {
            "schema": "loci.cli-study/v1",
            "project_path": str(project.root),
            "study": project.meta["title"],
            "choices": choices,
            "selected": {
                **context,
                "revision_hash": validation["revision_hash"],
                "object_count": validation["total_count"],
            }
            if context
            else None,
        }, None
    assert request is not None and validation is not None
    if args.command == "locate":
        return population_locate(project, {**request, "label": args.label}), context
    metrics = {item["id"]: item for item in validation["metrics"]}
    request["limit"] = args.limit
    filters = []
    for flag in ("area", "volume", "spacing"):
        bounds = getattr(args, flag)
        if bounds is None:
            continue
        metric = "nearest_centroid_distance" if flag == "spacing" else "measure"
        descriptor = metrics.get(metric)
        if descriptor is None or (flag != "spacing" and descriptor["kind"] != flag):
            raise ValueError(
                f"--{flag} requires actual {flag} measurements; inspect the result's native units."
            )
        filters.append({"metric": metric, "min": bounds[0], "max": bounds[1]})
    if filters:
        request["filters"] = filters
    if "measure" in metrics:
        request["x_metric"] = "measure"
    if "nearest_centroid_distance" in metrics:
        request["y_metric"] = "nearest_centroid_distance"
    return population_query(project, request), context
