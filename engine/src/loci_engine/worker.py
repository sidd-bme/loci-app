"""JSON-lines process boundary used by the desktop shell."""

from __future__ import annotations

import json
import sys
import traceback
from dataclasses import fields
from typing import Any

from .models import ENGINE_VERSION, AnalysisSettings, SegmentationSettings, ViewerDisplaySettings
from .profiles import CELLPOSE_PROFILE_ID, DEFAULT_PROFILE_ID, list_profiles, resolve_profile


def _settings_from_params(
    params: dict[str, Any],
    *,
    defaults: AnalysisSettings | None = None,
) -> AnalysisSettings:
    settings_type = type(defaults) if defaults is not None else SegmentationSettings
    accepted = {field.name for field in fields(settings_type)}
    unknown = set(params) - accepted
    if unknown:
        raise ValueError(f"Unknown segmentation settings: {', '.join(sorted(unknown))}")
    values = defaults.to_dict() if defaults is not None else {}
    values.update(params)
    settings = settings_type(**values)
    settings.validate()
    return settings


def _inspect_max_edge(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("max_edge must be an integer")
    if not 64 <= value <= 2200:
        raise ValueError("max_edge must be between 64 and 2200")
    return value


def _viewer_settings_from_params(params: object) -> ViewerDisplaySettings:
    if not isinstance(params, dict):
        raise TypeError("viewer display settings must be an object")
    accepted = {field.name for field in fields(ViewerDisplaySettings)}
    unknown = set(params) - accepted
    if unknown:
        raise ValueError(f"Unknown viewer display settings: {', '.join(sorted(unknown))}")
    settings = ViewerDisplaySettings(**params)
    settings.validate()
    return settings


def _reject_unknown(params: dict[str, Any], accepted: set[str], *, method: str) -> None:
    unknown = set(params) - accepted
    if unknown:
        raise ValueError(f"Unknown {method} parameters: {', '.join(sorted(unknown))}")


def _correction_receipt(result: Any, evicted_result_ids: list[str]) -> dict[str, Any]:
    from .render import render_overlay

    return {
        **result.provenance_dict(include_source_path=True),
        "cell_count": result.output.count,
        "evicted_result_ids": evicted_result_ids,
        "overlay_data_url": render_overlay(result.output.normalized, result.output.labels),
    }


def dispatch(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method.startswith("research_"):
        from .research_rpc import dispatch_research

        return dispatch_research(method, params)
    if method == "health":
        return {"status": "ready", "engine_version": ENGINE_VERSION}
    if method == "publish_volume_figure":
        from .volume_figure_publication import publish_volume_figure

        return publish_volume_figure(params)
    if method == "list_profiles":
        if params:
            raise ValueError("list_profiles does not accept parameters")
        return {"profiles": [profile.to_dict() for profile in list_profiles()]}
    if method == "inspect_profile":
        unknown = set(params) - {"profile_id"}
        if unknown:
            raise ValueError(f"Unknown inspect_profile parameters: {', '.join(sorted(unknown))}")
        return resolve_profile(params.get("profile_id")).to_dict()
    return _dispatch_legacy(method, params)


def _dispatch_legacy(method: str, params: dict[str, Any]) -> dict[str, Any]:
    # Native decoders load only for legacy image operations, after the cheap
    # protocol health path and the independently routed research operations.
    from .cellpose_backend import get_cellpose_status, import_cellpose_model, segment_cellpose
    from .export import export_analysis, publish_batch_metadata
    from .io import load_image
    from .render import render_display_statistics, render_overlay, render_preview
    from .results import RESULT_CACHE
    from .segment import segment_image
    from .viewer_export import export_adjusted_view
    from .working_result import publish_working_result, restore_working_result

    if method == "cellpose_status":
        _reject_unknown(params, {"profile_id"}, method=method)
        return get_cellpose_status(
            params.get("profile_id", CELLPOSE_PROFILE_ID),
            inspect_devices=True,
        ).to_dict()
    if method == "import_cellpose_model":
        _reject_unknown(params, {"path", "profile_id"}, method=method)
        if "path" not in params:
            raise ValueError("import_cellpose_model requires path")
        return import_cellpose_model(
            params["path"],
            params.get("profile_id", CELLPOSE_PROFILE_ID),
        ).to_dict()
    if method == "inspect":
        max_edge = _inspect_max_edge(params.get("max_edge", 2200))
        image, metadata = load_image(
            params["path"],
            expected_sha256=params.get("expected_sha256"),
        )
        return {
            "engine_version": ENGINE_VERSION,
            "source": metadata.to_dict(),
            "preview_data_url": render_preview(image, max_edge=max_edge),
            "display_statistics": render_display_statistics(image),
        }
    if method == "segment":
        profile = resolve_profile(
            params.get("profile_id", DEFAULT_PROFILE_ID),
            require_ready=True,
        )
        image, metadata = load_image(
            params["path"],
            expected_sha256=params.get("expected_sha256"),
        )
        if metadata.access_mode != "full":
            raise ValueError(
                metadata.view_only_reason
                or "This source is view-only and cannot be segmented at its current resolution."
            )
        settings = _settings_from_params(
            params.get("settings", {}),
            defaults=profile.recommended_settings,
        )
        runtime: dict[str, object] | None = None
        if profile.backend_kind == "classical":
            if not isinstance(settings, SegmentationSettings):
                raise TypeError("The classical backend requires classical segmentation settings.")
            output = segment_image(image, settings)
        elif profile.backend_kind == "cellpose":
            from .models import CellposeSettings

            if not isinstance(settings, CellposeSettings):
                raise TypeError("The Cellpose backend requires Cellpose settings.")
            inference = segment_cellpose(image, settings, profile.id)
            output = inference.output
            runtime = inference.runtime
        else:
            raise RuntimeError(
                f"Segmentation backend '{profile.backend_kind}' is not available in this engine."
            )
        cached, evicted_result_ids = RESULT_CACHE.add(
            source=metadata,
            settings=settings,
            output=output,
            profile=profile,
            runtime=runtime,
        )
        return {
            **cached.provenance_dict(include_source_path=True),
            "cell_count": cached.output.count,
            "evicted_result_ids": evicted_result_ids,
            "preview_data_url": render_preview(output.normalized),
            "overlay_data_url": render_overlay(output.normalized, output.labels),
        }
    if method == "delete_instance":
        _reject_unknown(params, {"result_id", "x", "y"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.delete_instance(
            params["result_id"],
            x=params["x"],
            y=params["y"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "add_polygon":
        _reject_unknown(params, {"result_id", "points"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.add_polygon(
            params["result_id"],
            points=params["points"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "split_instance":
        _reject_unknown(params, {"result_id", "x", "y", "points"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.split_instance(
            params["result_id"],
            x=params["x"],
            y=params["y"],
            points=params["points"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "merge_instances":
        _reject_unknown(
            params,
            {"result_id", "x", "y", "other_x", "other_y"},
            method=method,
        )
        result, evicted_result_ids = RESULT_CACHE.merge_instances(
            params["result_id"],
            x=params["x"],
            y=params["y"],
            other_x=params["other_x"],
            other_y=params["other_y"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "replace_instance_boundary":
        _reject_unknown(params, {"result_id", "x", "y", "points"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.replace_instance_boundary(
            params["result_id"],
            x=params["x"],
            y=params["y"],
            points=params["points"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "get_instance_boundary":
        _reject_unknown(params, {"result_id", "x", "y"}, method=method)
        return RESULT_CACHE.instance_boundary(
            params["result_id"],
            x=params["x"],
            y=params["y"],
        )
    if method == "paint_stroke":
        _reject_unknown(params, {"result_id", "points", "radius_px"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.paint_stroke(
            params["result_id"],
            points=params["points"],
            radius_px=params["radius_px"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "erase_stroke":
        _reject_unknown(params, {"result_id", "points", "radius_px"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.erase_stroke(
            params["result_id"],
            points=params["points"],
            radius_px=params["radius_px"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "move_boundary_vertex":
        _reject_unknown(params, {"result_id", "x", "y", "points"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.move_boundary_vertex(
            params["result_id"],
            x=params["x"],
            y=params["y"],
            points=params["points"],
        )
        return _correction_receipt(result, evicted_result_ids)
    if method == "undo_correction":
        _reject_unknown(params, {"result_id"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.undo_correction(params["result_id"])
        return _correction_receipt(result, evicted_result_ids)
    if method == "redo_correction":
        _reject_unknown(params, {"result_id"}, method=method)
        result, evicted_result_ids = RESULT_CACHE.redo_correction(params["result_id"])
        return _correction_receipt(result, evicted_result_ids)
    if method == "discard_result":
        _reject_unknown(params, {"result_id"}, method=method)
        result_id = params["result_id"]
        discarded = RESULT_CACHE.discard(result_id)
        return {"result_id": result_id, "discarded": discarded}
    if method == "publish_working_result":
        _reject_unknown(params, {"result_id", "directory"}, method=method)
        result = RESULT_CACHE.get(params["result_id"])
        return publish_working_result(result, params["directory"])
    if method == "restore_working_result":
        _reject_unknown(
            params,
            {"pack_path", "source_path", "expected_sha256"},
            method=method,
        )
        result, evicted_result_ids, pack = restore_working_result(
            params["pack_path"],
            params["source_path"],
            params["expected_sha256"],
            cache=RESULT_CACHE,
        )
        return {
            **_correction_receipt(result, evicted_result_ids),
            "preview_data_url": render_preview(result.output.normalized),
            "working_result_pack": pack,
        }
    if method == "export":
        _reject_unknown(
            params,
            {
                "result_id",
                "directory",
                "basename",
                "options",
                "allowed_root",
                "allowed_root_identity",
            },
            method=method,
        )
        result = RESULT_CACHE.get(params["result_id"])
        basename = params.get("basename")
        if basename is not None and not isinstance(basename, str):
            raise TypeError("basename must be a string")
        return export_analysis(
            result,
            params["directory"],
            basename=basename,
            options=params.get("options"),
            allowed_root=params.get("allowed_root"),
            allowed_root_identity=params.get("allowed_root_identity"),
        )
    if method == "export_view":
        _reject_unknown(
            params,
            {
                "path",
                "expected_sha256",
                "directory",
                "directory_identity",
                "filename",
                "format",
                "settings",
            },
            method=method,
        )
        image, metadata = load_image(
            params["path"],
            expected_sha256=params.get("expected_sha256"),
        )
        if metadata.access_mode != "full":
            raise ValueError(
                metadata.view_only_reason
                or "Rendered export is unavailable for this overview source."
            )
        return export_adjusted_view(
            image,
            metadata,
            params["directory"],
            params["directory_identity"],
            params["filename"],
            params["format"],
            _viewer_settings_from_params(params.get("settings", {})),
        )
    if method == "publish_batch_metadata":
        _reject_unknown(
            params,
            {"allowed_root", "allowed_root_identity", "files"},
            method=method,
        )
        return publish_batch_metadata(
            params["allowed_root"],
            params["allowed_root_identity"],
            params["files"],
        )
    raise ValueError(f"Unknown method: {method}")


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    try:
        method = request["method"]
        params = request.get("params") or {}
        if not isinstance(params, dict):
            raise TypeError("params must be an object")
        return {"id": request_id, "result": dispatch(method, params)}
    except Exception as exc:  # process boundary: errors must be serializable
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return {
            "id": request_id,
            "error": {"type": type(exc).__name__, "message": str(exc)},
        }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        from .research_cli import main as research_main

        raise SystemExit(research_main(sys.argv[2:]))
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise TypeError("request must be an object")
            response = handle_request(request)
        except Exception as exc:
            response = {
                "id": None,
                "error": {"type": type(exc).__name__, "message": str(exc)},
            }
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
