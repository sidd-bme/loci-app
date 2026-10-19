"""Study-wide result access through explicit source/selection grants.

This authorizes inspection, correction and review of already adopted results.
It grants no model installation or execution authority by itself.
"""

from __future__ import annotations

from typing import Any

from .agent_policy import AgentPolicy
from .research_project import checked_id
from .workbench import Workbench


def authorize_result(policy: AgentPolicy, workbench: Workbench, result_id: str) -> dict[str, Any]:
    from .research_interchange import _validate_result_crossrefs

    results: dict[str, dict[str, Any]] = {}
    sources: dict[str, dict[str, Any]] = {}
    visiting: set[str] = set()

    def source_scope(source_id, selection, channels):
        grant = policy.source_grant(workbench.project, source_id)
        if (
            not isinstance(selection, dict)
            or not isinstance(channels, list)
            or any(type(channel) is not int for channel in channels)
            or not grant.allows(selection, channels)
        ):
            raise PermissionError(
                "Result source selection or measurement channels exceed the grant"
            )
        sources[source_id] = workbench.project.source(source_id)
        return grant

    def visit(identity: str):
        checked_id(identity)
        if identity in visiting:
            raise PermissionError("Result dependencies contain a cycle")
        if identity in results:
            return results[identity]
        if len(results) >= 1024 or len(visiting) >= 64:
            raise PermissionError("Result dependencies exceed the bounded study grant")
        visiting.add(identity)
        record = workbench.project.result(identity)
        provenance = record["provenance"]
        recipe = provenance.get("recipe", {})
        if not isinstance(recipe, dict):
            raise PermissionError("Result recipe is invalid")
        channels = provenance.get("measurement_channels", recipe.get("measurement_channels", []))
        if provenance.get("stain_separation") or provenance.get("derived_measurement_arrays"):
            channels = []  # These are declared derived coordinates, not raw source channels.
        grant = source_scope(record["source_id"], provenance.get("selection"), channels)
        if record["source_sha256"] != grant.sha256:
            raise PermissionError("Result source fingerprint exceeds the grant")
        if "paired_selection" in provenance:
            source_scope(record["source_id"], provenance["paired_selection"], [])
        for mapping in provenance.get("channel_mapping", []):
            if not isinstance(mapping, dict) or mapping.get("source_channel") not in grant.c:
                raise PermissionError("A model input channel is outside the source grant")
        bindings = [*provenance.get("temporal_inputs", [])]
        bindings.extend(provenance.get("association_inputs", {}).values())
        compartment = provenance.get("compartment_measurement", {})
        bindings.extend(compartment.get("label_inputs", {}).values())
        bindings.extend(
            provenance[key]
            for key in ("parent_result", "fixed_result", "moving_result")
            if key in provenance
        )
        covered_sources = {record["source_id"]}
        for binding in bindings:
            if not isinstance(binding, dict):
                raise PermissionError("Result dependency is invalid")
            if not binding.get("missing_reason"):
                bound = visit(binding.get("result_id"))
                if (
                    binding.get("revision_hash") != bound["revision_hash"]
                    or binding.get("source_id") not in {None, bound["source_id"]}
                    or binding.get("source_sha256") not in {None, bound["source_sha256"]}
                ):
                    raise PermissionError("Result dependency is stale or mismatched")
                covered_sources.add(bound["source_id"])
        for reference in provenance.get("references", {}).values():
            if not isinstance(reference, dict):
                raise PermissionError("Result source reference is invalid")
            source_id = reference.get("source_id")
            if "selection" in reference:
                source_scope(source_id, reference["selection"], [])
            elif source_id not in covered_sources:
                raise PermissionError("Result source reference has no granted input selection")
        for channel in compartment.get("channels", []):
            if not isinstance(channel, dict):
                raise PermissionError("Compartment measurement channel is invalid")
            source_scope(channel.get("source_id"), channel.get("selection"), [channel.get("index")])
        for annotation in provenance.get("annotations", []):
            visit(annotation.get("parent_result_id"))
        if record.get("parent_id") is not None:
            visit(record["parent_id"])
        results[identity] = record
        _validate_result_crossrefs(record, sources, results)
        visiting.remove(identity)
        return record

    return visit(result_id)
