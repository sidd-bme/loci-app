"""User declarations alongside immutable acquisition channel metadata."""

from __future__ import annotations

from typing import Any

from .quantitative import exact_keys, integer
from .research_project import ResearchProject, checked_id, checked_text


def channel_metadata(project: ResearchProject, source_id: str) -> dict[str, Any]:
    source = project.source(checked_id(source_id))
    metadata = source["metadata"]
    original = list(metadata.get("channel_names") or ["Intensity"])
    document = next(
        (item for item in project.documents("channels") if item["id"] == source_id), None
    )
    return {
        "source_id": source_id,
        "source_sha256": source["sha256"],
        "original_names": original,
        "revision": document["revision"] if document else 0,
        "channels": document["data"]["channels"]
        if document
        else [
            {"index": index, "name": name, "marker": "", "fluorophore": "", "declaration": ""}
            for index, name in enumerate(original)
        ],
        "basis": (
            "acquisition metadata and explicit user declarations; "
            "no identity inferred from appearance"
        ),
    }


def save_channels(project: ResearchProject, request: dict[str, Any]) -> dict[str, Any]:
    exact_keys(request, {"source_id", "channels", "expected_revision"}, "channel declarations")
    source_id = checked_id(request.get("source_id"))
    source = project.source(source_id, verify=True)
    metadata = source["metadata"]
    if (
        metadata.get("rgb_samples", False)
        or metadata.get("is_rgb", False)
        or "S" in metadata.get("axes", "")
    ):
        raise ValueError("RGB samples cannot be declared as independent biological channels")
    original = list(metadata.get("channel_names") or ["Intensity"])
    resolved = validate_declarations(request.get("channels"), len(original))
    project.put_document(
        "channels",
        source_id,
        {"source_sha256": source["sha256"], "original_names": original, "channels": resolved},
        expected_revision=request.get("expected_revision", 0),
    )
    return channel_metadata(project, source_id)


def validate_declarations(channels: Any, count: int) -> list[dict[str, Any]]:
    if not isinstance(channels, list) or not 1 <= count <= 256 or len(channels) != count:
        raise ValueError(
            "Declare each acquisition channel once in its original order (at most 256)"
        )
    resolved = []
    for index, item in enumerate(channels):
        exact_keys(
            item, {"index", "name", "marker", "fluorophore", "declaration"}, "channel metadata"
        )
        if integer(item.get("index"), "channel index", 0, 255) != index:
            raise ValueError("Channel declarations must preserve acquisition indices")
        resolved.append(
            {
                "index": index,
                "name": checked_text(item.get("name"), "Channel name", 256),
                **{
                    key: checked_text(item.get(key, ""), key, 1024, empty=True)
                    for key in ("marker", "fluorophore", "declaration")
                },
            }
        )
    return resolved
