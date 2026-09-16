"""Reversible source presentation, bound to its immutable source identity."""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING, Any

from .quantitative import exact_keys, finite_number, integer
from .research_project import checked_id

if TYPE_CHECKING:
    from .workbench import Workbench

SCHEMA = "loci.source-view/v1"


def validate_view_data(data: dict[str, Any], source: dict[str, Any]) -> None:
    exact_keys(data, {"schema", "source_id", "source_sha256", "state"}, "source view")
    if (
        data.get("schema") != SCHEMA
        or data.get("source_id") != source["id"]
        or data.get("source_sha256") != source["sha256"]
    ):
        raise ValueError("Saved view lost its source binding")
    state = data.get("state")
    exact_keys(
        state,
        {"interpretation", "channels", "projection", "selection", "camera", "rgb_mapping"},
        "view state",
    )
    if state.get("interpretation") not in {
        "auto",
        "generic",
        "histology",
        "fluorescence",
        "volume",
        "medical",
    }:
        raise ValueError("Choose a supported presentation")
    if state.get("projection") not in {"plane", "max", "mean"}:
        raise ValueError("Choose a supported projection")
    metadata = source["metadata"]
    shape = metadata.get("shape", [])
    d = metadata.get("dimensions") or {
        "x": shape[-1],
        "y": shape[-2],
        "z": shape[0] if len(shape) == 3 else 1,
        "t": 1,
        "c": 1,
    }
    if state["interpretation"] == "volume" and d["z"] < 2:
        raise ValueError("A one-plane image has no volume depth")
    mapping = state.get("rgb_mapping")
    if mapping is not None:
        if metadata.get("sample_semantics") in {"RGB", "RGBA"}:
            raise ValueError("Interleaved samples do not use scalar plane mapping")
        if not isinstance(mapping, list) or len(mapping) != 3:
            raise ValueError("RGB display mapping requires exactly three scalar planes")
        for index in mapping:
            integer(index, "RGB plane", 0, d["c"] - 1)
        if len(set(mapping)) != 3:
            raise ValueError("RGB display planes must be distinct")
    channels = state.get("channels")
    if not isinstance(channels, list) or not 1 <= len(channels) <= 16:
        raise ValueError("Saved display requires 1-16 bounded channel settings")
    seen: set[int] = set()
    for channel in channels:
        exact_keys(
            channel,
            {"channel", "low", "high", "gamma", "color", "opacity", "visible"},
            "display channel",
        )
        index = integer(channel.get("channel"), "channel", 0, d["c"] - 1)
        if index in seen:
            raise ValueError("Display channels must be unique")
        seen.add(index)
        low = finite_number(
            channel.get("low"), "display low", -1.7976931348623157e308, 1.7976931348623157e308
        )
        high = finite_number(
            channel.get("high"), "display high", -1.7976931348623157e308, 1.7976931348623157e308
        )
        if high <= low:
            raise ValueError("Display high must exceed low")
        finite_number(channel.get("gamma"), "gamma", 0.1, 10)
        finite_number(channel.get("opacity", 1), "opacity", 0, 1)
        from .source_annotations import COLOR

        if not isinstance(channel.get("color"), str) or not COLOR.fullmatch(channel["color"]):
            raise ValueError("Display color must be hexadecimal")
        if not isinstance(channel.get("visible"), bool):
            raise ValueError("Display visibility must be boolean")
        if mapping is not None:
            expected_color = (
                ["#ff0000", "#00ff00", "#0000ff"][mapping.index(index)]
                if index in mapping
                else None
            )
            if (
                channel["visible"] != (index in mapping)
                or expected_color
                and channel["color"].lower() != expected_color
            ):
                raise ValueError("RGB plane mapping disagrees with the displayed composite")
    if mapping is not None and not set(mapping) <= seen:
        raise ValueError("A declared RGB plane is missing from display settings")
    selection = state.get("selection")
    exact_keys(
        selection, {"x", "y", "width", "height", "z", "z_stop", "t", "c", "level"}, "view selection"
    )
    if selection.get("level") != 0:
        raise ValueError("Saved camera and analysis region use source level zero")
    for axis in ("x", "y", "z", "t", "c"):
        integer(selection.get(axis), axis, 0, d[axis] - 1)
    for axis, length in (("x", "width"), ("y", "height")):
        integer(selection.get(length), length, 1, d[axis] - selection[axis])
    if "z_stop" in selection:
        integer(selection["z_stop"], "Z stop", selection["z"] + 1, d["z"])
    if state["projection"] != "plane" and "z_stop" not in selection:
        raise ValueError("Saved projection requires an explicit Z extent")
    camera = state.get("camera")
    if camera is not None:
        exact_keys(camera, {"x", "y", "scale"}, "camera")
        finite_number(camera.get("x"), "camera x", -d["x"], 2 * d["x"])
        finite_number(camera.get("y"), "camera y", -d["y"], 2 * d["y"])
        finite_number(camera.get("scale"), "camera scale", 1e-12, 64)


def execute_view_state(
    workbench: Workbench, operation: str, request: dict[str, Any]
) -> dict[str, Any]:
    exact_keys(
        request,
        {"source_id"}
        if operation == "source_view"
        else {"source_id", "source_sha256", "expected_revision", "state"},
        operation,
    )
    source_id = checked_id(request.get("source_id"))
    # Display preferences do not read or transform source pixels. Bind them to
    # the registered identity; pixel readers verify the source when displaying.
    source = workbench.project.source(source_id)
    document = next(
        (item for item in workbench.project.documents("display") if item["id"] == source_id), None
    )
    revision = document["revision"] if document else 0
    if operation == "save_source_view":
        if (
            request.get("source_sha256") != source["sha256"]
            or request.get("expected_revision") != revision
        ):
            raise ValueError("Saved view changed; reload before editing")
        data = {
            "schema": SCHEMA,
            "source_id": source_id,
            "source_sha256": source["sha256"],
            "state": request.get("state"),
        }
        validate_view_data(data, source)
        document = workbench.project.put_document(
            "display", source_id, data, expected_revision=revision
        )
    data = document["data"] if document else None
    # Older display documents remain available as provenance; the new schema
    # never guesses camera coordinates or changes their scientific settings.
    state = None
    if data and data.get("schema") == SCHEMA:
        validate_view_data(data, source)
        state = data["state"]
    return {
        "source_id": source_id,
        "source_sha256": source["sha256"],
        "revision": document["revision"] if document else 0,
        "state": state,
    }


def _default_view_state_for_source(source: dict[str, Any]) -> dict[str, Any]:
    default_palette = ["#0000ff", "#00ff00", "#ff0000", "#ffff00", "#00ffff", "#ff00ff", "#ffffff"]
    metadata = source.get("metadata", {})
    shape = metadata.get("shape", [])
    d = metadata.get("dimensions") or {
        "x": shape[-1] if len(shape) >= 2 else 1,
        "y": shape[-2] if len(shape) >= 2 else 1,
        "z": shape[0] if len(shape) == 3 else 1,
        "t": 1,
        "c": 1,
    }
    c_count = max(1, d.get("c", 1))
    max_val = 65535.0 if metadata.get("channel_dtypes", ["uint16"])[0] == "uint16" else 255.0
    channels = [
        {
            "channel": i,
            "low": 0.0,
            "high": max_val,
            "gamma": 1.0,
            "color": default_palette[i % len(default_palette)],
            "opacity": 1.0,
            "visible": True,
        }
        for i in range(c_count)
    ]
    return {
        "interpretation": "fluorescence" if c_count > 1 else "generic",
        "channels": channels,
        "projection": "plane",
        "selection": {
            "x": 0,
            "y": 0,
            "width": max(1, d.get("x", 1)),
            "height": max(1, d.get("y", 1)),
            "z": 0,
            "t": 0,
            "c": 0,
            "level": 0,
        },
        "camera": None,
        "rgb_mapping": None,
    }


def execute_batch_channel_colors(
    workbench: Workbench, request: dict[str, Any]
) -> dict[str, Any]:
    from .source_annotations import COLOR

    exact_keys(
        request,
        {
            "source_ids",
            "preview_only",
            "mapping_mode",
            "color_map",
            "restore_palettes",
            "expected_revisions",
        },
        "batch_channel_colors",
    )
    source_ids = request.get("source_ids")
    if not isinstance(source_ids, list) or not source_ids:
        raise ValueError("batch_channel_colors requires a non-empty list of source_ids")

    preview_only = bool(request.get("preview_only", False))
    mapping_mode = request.get("mapping_mode", "index")
    if mapping_mode not in {"index", "name", "auto", "restore"}:
        raise ValueError("mapping_mode must be 'index', 'name', 'auto', or 'restore'")

    color_map: dict[Any, str] = {}
    restore_palettes: dict[str, list[dict[str, Any]]] = {}

    if mapping_mode == "restore" or "restore_palettes" in request:
        raw_restores = request.get("restore_palettes")
        if not isinstance(raw_restores, dict):
            raise ValueError(
                "restore_palettes must be a dictionary mapping source_id to channel palette lists"
            )
        for s_id, palette in raw_restores.items():
            if not isinstance(palette, list):
                raise ValueError(
                    f"Palette for source {s_id} must be a list of channel color objects"
                )
            for item in palette:
                if not isinstance(item, dict) or "channel" not in item or "color" not in item:
                    raise ValueError("Each palette item must contain 'channel' and 'color'")
                if not isinstance(item["color"], str) or not COLOR.fullmatch(item["color"]):
                    raise ValueError(f"Invalid color {item['color']} in restore palette")
        restore_palettes = raw_restores
    else:
        raw_map = request.get("color_map")
        if not isinstance(raw_map, dict) or not raw_map:
            raise ValueError("batch_channel_colors requires a non-empty color_map")
        for key, color in raw_map.items():
            if not isinstance(color, str) or not COLOR.fullmatch(color):
                raise ValueError(f"Color for '{key}' must be a 6-digit hex color like '#ff0000'")
            if mapping_mode == "index":
                try:
                    idx = int(key)
                    if idx < 0:
                        raise ValueError()
                    color_map[idx] = color
                    color_map[str(idx)] = color
                except (ValueError, TypeError) as exc:
                    raise ValueError(
                        f"Channel index must be non-negative integer, got {key}"
                    ) from exc
            elif mapping_mode == "auto":
                color_map[str(key)] = color
                try:
                    idx = int(key)
                    if idx >= 0:
                        color_map[idx] = color
                except (ValueError, TypeError):
                    pass
            else:
                color_map[str(key)] = color

    expected_revisions = request.get("expected_revisions")
    if expected_revisions is not None and not isinstance(expected_revisions, dict):
        raise ValueError("expected_revisions must be a dict of source_id to revision number")

    sources_report: list[dict[str, Any]] = []
    skipped_items: list[dict[str, Any]] = []
    updated_source_ids: list[str] = []
    previous_palettes: dict[str, list[dict[str, Any]]] = {}
    new_revisions: dict[str, int] = {}

    # Resolve every source and revision before the first display document write.
    # This prevents a later stale binding from leaving earlier sources recolored
    # without a response receipt. Other storage failures are still reported as
    # failures rather than claimed as a transactional multi-document update.
    display_documents = {
        item["id"]: item for item in workbench.project.documents("display")
    }
    source_contexts: list[tuple[str, dict[str, Any], dict[str, Any] | None, int]] = []
    seen_source_ids: set[str] = set()
    for s_id in source_ids:
        source_id = checked_id(s_id)
        if source_id in seen_source_ids:
            raise ValueError("batch_channel_colors source_ids must be unique")
        seen_source_ids.add(source_id)
        source = workbench.project.source(source_id)
        document = display_documents.get(source_id)
        current_rev = document["revision"] if document else 0
        if expected_revisions and source_id in expected_revisions and (
            expected_revisions[source_id] != current_rev
        ):
            raise ValueError(
                f"Saved view changed for source {source_id}; reload before applying batch colors"
            )
        source_contexts.append((source_id, source, document, current_rev))

    for source_id, source, document, current_rev in source_contexts:
        source_name = source.get("name") or source_id
        metadata = source.get("metadata", {})
        if metadata.get("sample_semantics") in {"RGB", "RGBA"}:
            reason = (
                "Interleaved histology RGB/RGBA sources do not support "
                "independent channel recoloring"
            )
            skipped_items.append({
                "source_id": source_id,
                "source_name": source_name,
                "reason": reason,
            })
            sources_report.append({
                "source_id": source_id,
                "source_name": source_name,
                "revision": current_rev,
                "status": "skipped",
                "reason": reason,
                "changes": [],
            })
            new_revisions[source_id] = current_rev
            continue

        # Load or create state
        state: dict[str, Any]
        if document and document.get("data", {}).get("schema") == SCHEMA:
            state = copy.deepcopy(document["data"]["state"])
        else:
            state = _default_view_state_for_source(source)

        old_channels = state.get("channels", [])
        prev_palette = [{"channel": ch["channel"], "color": ch["color"]} for ch in old_channels]
        previous_palettes[source_id] = prev_palette

        changes: list[dict[str, Any]] = []

        if mapping_mode == "restore" or source_id in restore_palettes:
            if source_id in restore_palettes:
                target_palette = restore_palettes[source_id]
                target_by_chan = {p["channel"]: p["color"] for p in target_palette}
                for ch in state["channels"]:
                    c_idx = ch["channel"]
                    if c_idx in target_by_chan and target_by_chan[c_idx] != ch["color"]:
                        changes.append({
                            "channel": c_idx,
                            "channel_name": (
                                metadata.get("channel_names", [""])[c_idx]
                                if c_idx < len(metadata.get("channel_names", []))
                                else f"Channel {c_idx + 1}"
                            ),
                            "old_color": ch["color"],
                            "new_color": target_by_chan[c_idx],
                        })
                        ch["color"] = target_by_chan[c_idx]
        elif mapping_mode == "index":
            for ch in state["channels"]:
                c_idx = ch["channel"]
                if c_idx in color_map:
                    target_color = color_map[c_idx]
                    if target_color != ch["color"]:
                        changes.append({
                            "channel": c_idx,
                            "channel_name": (
                                metadata.get("channel_names", [""])[c_idx]
                                if c_idx < len(metadata.get("channel_names", []))
                                else f"Channel {c_idx + 1}"
                            ),
                            "old_color": ch["color"],
                            "new_color": target_color,
                        })
                        ch["color"] = target_color
        elif mapping_mode == "name":
            raw_names = metadata.get("channel_names", [])
            # Check for duplicate names in source
            if len(raw_names) != len(set(raw_names)):
                reason = (
                    "Duplicate channel names in source metadata prevent unambiguous name mapping"
                )
                skipped_items.append({
                    "source_id": source_id,
                    "source_name": source_name,
                    "reason": reason,
                })
                sources_report.append({
                    "source_id": source_id,
                    "source_name": source_name,
                    "revision": current_rev,
                    "status": "skipped",
                    "reason": reason,
                    "changes": [],
                })
                new_revisions[source_id] = current_rev
                continue

            for ch in state["channels"]:
                c_idx = ch["channel"]
                c_name = raw_names[c_idx] if c_idx < len(raw_names) else ""
                if c_name and c_name in color_map:
                    target_color = color_map[c_name]
                    if target_color != ch["color"]:
                        changes.append({
                            "channel": c_idx,
                            "channel_name": c_name,
                            "old_color": ch["color"],
                            "new_color": target_color,
                        })
                        ch["color"] = target_color
        elif mapping_mode == "auto":
            raw_names = metadata.get("channel_names", [])
            for ch in state["channels"]:
                c_idx = ch["channel"]
                c_name = raw_names[c_idx] if c_idx < len(raw_names) else ""
                target_color = None
                if c_name and c_name in color_map:
                    target_color = color_map[c_name]
                elif c_idx in color_map:
                    target_color = color_map[c_idx]
                elif str(c_idx) in color_map:
                    target_color = color_map[str(c_idx)]

                if target_color and target_color != ch["color"]:
                    changes.append({
                        "channel": c_idx,
                        "channel_name": c_name or f"Channel {c_idx + 1}",
                        "old_color": ch["color"],
                        "new_color": target_color,
                    })
                    ch["color"] = target_color

        if not changes:
            sources_report.append({
                "source_id": source_id,
                "source_name": source_name,
                "revision": current_rev,
                "status": "unchanged",
                "reason": None,
                "changes": [],
            })
            new_revisions[source_id] = current_rev
            continue

        if not preview_only:
            state["rgb_mapping"] = None
            data = {
                "schema": SCHEMA,
                "source_id": source_id,
                "source_sha256": source["sha256"],
                "state": state,
            }
            validate_view_data(data, source)
            new_doc = workbench.project.put_document(
                "display", source_id, data, expected_revision=current_rev
            )
            updated_source_ids.append(source_id)
            new_revisions[source_id] = new_doc["revision"]
        else:
            new_revisions[source_id] = current_rev

        sources_report.append({
            "source_id": source_id,
            "source_name": source_name,
            "revision": new_revisions[source_id],
            "status": "ready" if preview_only else "applied",
            "reason": None,
            "changes": changes,
        })

    return {
        "preview_only": preview_only,
        "total_sources": len(source_ids),
        "applicable_count": sum(
            1 for source_report in sources_report
            if source_report["status"] in {"ready", "applied"}
        ),
        "applied_count": len(updated_source_ids),
        "skipped_count": len(skipped_items),
        "affected_sources": sources_report,
        "previous_palettes": previous_palettes,
        "new_revisions": new_revisions,
    }
