"""Trusted desktop process boundary; never expose these path grants through MCP."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .export import sanitize_basename
from .quantitative import exact_keys
from .research_jobs import TASK_OPERATIONS, cancel_job, reconcile_jobs, run_job, submit_job
from .research_project import ResearchProject
from .workbench import Workbench

_ACTIVE: Workbench | None = None


def _research_export_basename(filename: str) -> str:
    """Return the exact portable directory name used for one result bundle."""
    name = Path(filename).name
    stem = name[:-7] if name.casefold().endswith(".nii.gz") else Path(name).stem
    normalized = sanitize_basename(stem, fallback="source")
    return sanitize_basename(f"{normalized[:75]}_loci", fallback="source_loci")


def _open(path: str) -> Workbench:
    global _ACTIVE
    project = ResearchProject(path)
    if _ACTIVE is not None and _ACTIVE.project.root != project.root:
        _ACTIVE.close()
        _ACTIVE = None
    if _ACTIVE is None:
        _ACTIVE = Workbench(project)
    return _ACTIVE


def dispatch_research(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method == "research_workspace_visibility":
        from .research_workspace_records import update_visibility

        exact_keys(params, {"project", "request"}, method)
        workbench = _open(params["project"])
        update_visibility(workbench.project, params["request"])
        return workbench.snapshot()
    if method == "research_source_order":
        from .research_workspace_records import reorder_sources

        exact_keys(params, {"project", "request"}, method)
        workbench = _open(params["project"])
        reorder_sources(workbench.project, params["request"])
        return workbench.snapshot()
    if method == "research_source_rendered_export":
        from .source_rendered_export import export_rendered_source

        exact_keys(params, {"project", "request", "destination"}, method)
        return export_rendered_source(
            _open(params["project"]), params["request"], params["destination"]
        )
    if method == "research_source_annotations_export":
        from .source_annotation_interchange import export_source_annotations

        exact_keys(
            params,
            {"project", "source_id", "source_sha256", "expected_revision", "destination"},
            method,
        )
        return export_source_annotations(
            _open(params["project"]),
            params["source_id"],
            params["source_sha256"],
            params["expected_revision"],
            params["destination"],
        )
    if method == "research_source_annotations_import":
        from .source_annotation_interchange import import_source_annotations

        exact_keys(
            params,
            {"project", "source_id", "source_sha256", "expected_revision", "path"},
            method,
        )
        return import_source_annotations(
            _open(params["project"]),
            params["source_id"],
            params["source_sha256"],
            params["expected_revision"],
            params["path"],
        )
    if method == "research_import_legacy_project":
        from .research_legacy_import import import_legacy_project

        exact_keys(params, {"project", "legacy_project", "items"}, method)
        return import_legacy_project(
            _open(params["project"]), params["legacy_project"], params["items"]
        )
    if method == "research_project_clone":
        from .research_session import clone_study

        exact_keys(params, {"project", "destination"}, method)
        project = clone_study(_open(params["project"]).project, params["destination"])
        return _open(str(project.root)).snapshot()
    if method == "research_vendor_inspect":
        from .vendor_conversion import inspect_vendor

        exact_keys(params, {"source", "jar", "java"}, method)
        return inspect_vendor(params["source"], params["jar"], params["java"])
    if method == "research_vendor_convert":
        from .research_vendor import convert_and_import

        values = dict(params)
        workbench = _open(values.pop("project"))
        return convert_and_import(workbench, values)
    if method == "research_project_export":
        from .research_interchange import export_project

        exact_keys(params, {"project", "destination"}, method)
        return export_project(_open(params["project"]).project, params["destination"])
    if method == "research_project_import":
        from .research_interchange import import_project

        exact_keys(params, {"archive", "destination"}, method)
        project = import_project(params["archive"], params["destination"])
        return _open(str(project.root)).snapshot()
    if method == "research_recipe_export":
        from .research_interchange import export_recipe

        exact_keys(params, {"project", "recipe_id", "source_id", "destination"}, method)
        return export_recipe(
            _open(params["project"]),
            params["recipe_id"],
            params["source_id"],
            params["destination"],
        )
    if method == "research_recipe_import":
        from .research_interchange import import_recipe

        exact_keys(
            params,
            {
                "project",
                "path",
                "bindings",
                "recipe_id",
                "expected_revision",
                "require_exact_sources",
            },
            method,
        )
        return import_recipe(
            _open(params["project"]),
            params["path"],
            params["bindings"],
            recipe_id=params.get("recipe_id"),
            expected_revision=params.get("expected_revision", 0),
            require_exact_sources=params.get("require_exact_sources", False),
        )
    if method == "research_agent_access":
        from .research_agent_setup import create_agent_access

        exact_keys(params, {"project", "request", "destination", "export_root"}, method)
        return create_agent_access(
            _open(params["project"]),
            params["request"],
            params["destination"],
            params.get("export_root"),
        )
    if method == "research_import_model":
        from .research_models import import_model

        exact_keys(params, {"project", "path", "working_bytes", "recovery_model_id"}, method)
        return import_model(
            _open(params["project"]),
            params["path"],
            params["working_bytes"],
            params.get("recovery_model_id"),
        )
    if method == "research_create":
        exact_keys(params, {"path", "title"}, method)
        project = ResearchProject.create(params["path"], params["title"])
        return _open(str(project.root)).snapshot()
    if method == "research_snapshot":
        exact_keys(params, {"project"}, method)
        workbench = _open(params["project"])
        reconcile_jobs(workbench.project)
        return workbench.snapshot()
    if method == "research_import":
        if set(params) not in (
            {"project", "paths", "kind"},
            {"project", "paths", "kind", "relative_paths"},
        ):
            raise ValueError("research_import contains invalid fields")
        workbench = _open(params["project"])
        paths = params["paths"]
        relative_paths = params.get("relative_paths")
        if relative_paths is None and isinstance(paths, list):
            relative_paths = [Path(item).name if isinstance(item, str) else "" for item in paths]
        if not isinstance(paths, list) or not 1 <= len(paths) <= 10000:
            raise ValueError("Select 1-10000 source paths")
        if (
            not isinstance(relative_paths, list)
            or len(relative_paths) != len(paths)
            or any(
                not isinstance(item, str)
                or not item
                or len(item.encode("utf-8")) > 4096
                or Path(item).is_absolute()
                or ".." in Path(item).parts
                for item in relative_paths
            )
        ):
            raise ValueError("Source relative paths are invalid")
        imported = []
        if params.get("kind") == "dicom":
            imported.append(workbench.project.register_medical_source(paths))
        elif params.get("kind", "files") in {"files", "ome_zarr"}:
            for source, relative_path in zip(paths, relative_paths, strict=True):
                if not isinstance(source, str) or not Path(source).is_absolute():
                    raise ValueError("Source picker must provide absolute file paths")
                if source.lower().endswith((".nii", ".nii.gz", ".nrrd", ".nhdr")):
                    imported.append(workbench.project.register_medical_source(source))
                else:
                    imported.append(workbench.import_native(source, relative_path=relative_path))
        else:
            raise ValueError("Unknown import kind")
        from .research_workspace_records import read_visibility, update_visibility

        visibility = read_visibility(workbench.project)
        reopened = {
            item["id"]: item for item in imported if item["id"] in visibility["data"]["sources"]
        }
        if reopened:
            update_visibility(
                workbench.project,
                {
                    "expected_revision": visibility["revision"],
                    "sources": [
                        {"id": item["id"], "sha256": item["sha256"], "visible": True}
                        for item in reopened.values()
                    ],
                    "results": [],
                },
            )
        return workbench.snapshot()
    if method == "research_batch_export_plan":
        exact_keys(params, {"project", "bindings"}, method)
        workbench = _open(params["project"])
        bindings = params["bindings"]
        if not isinstance(bindings, list) or not 1 <= len(bindings) <= 10000:
            raise ValueError("Choose 1-10000 reviewed result revisions")
        items = []
        seen_results: set[str] = set()
        seen_paths: set[str] = set()
        seen_export_targets: set[tuple[str, str]] = set()
        for binding in bindings:
            exact_keys(
                binding,
                {"source_id", "source_sha256", "result_id", "revision_hash"},
                "batch export binding",
            )
            result = workbench.project.result(binding["result_id"])
            source = workbench.project.source(binding["source_id"], verify=True)
            if result["id"] in seen_results:
                raise ValueError("Choose each reviewed result revision once")
            if (
                result["source_id"] != source["id"]
                or result["revision_hash"] != binding["revision_hash"]
                or source["sha256"] != binding["source_sha256"]
            ):
                raise ValueError("A selected result no longer matches its exact source revision")
            review = workbench.project.review_state(result["id"])
            if review is None or review["disposition"] != "reviewed":
                raise ValueError("Every batch export result must be explicitly reviewed")
            relative_path = source.get("private_relative_path") or source["name"]
            relative = Path(relative_path)
            if relative.is_absolute() or ".." in relative.parts or not relative.name:
                raise ValueError("A source has an invalid mirrored export path")
            portable = relative.as_posix()
            folded = portable.casefold()
            if folded in seen_paths:
                raise ValueError("Selected sources have conflicting mirrored export paths")
            export_basename = _research_export_basename(relative.name)
            export_target = (relative.parent.as_posix().casefold(), export_basename.casefold())
            if export_target in seen_export_targets:
                raise ValueError("Selected sources have conflicting mirrored export targets")
            seen_paths.add(folded)
            seen_export_targets.add(export_target)
            seen_results.add(result["id"])
            measurements = result.get("provenance", {}).get("measurements", [])
            items.append(
                {
                    "source_id": source["id"],
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "source_relative_path": portable,
                    "export_basename": export_basename,
                    "object_count": len(measurements) if isinstance(measurements, list) else 0,
                }
            )
        return {"items": items}
    fields = {
        "research_execute": {"project", "operation", "request"},
        "research_submit": {"project", "request", "request_key", "operation"},
        "research_run": {"project", "job_id"},
        "research_cancel": {"project", "job_id"},
        "research_review": {"project", "result_id", "revision_hash", "disposition"},
        "research_export": {"project", "result_id", "revision_hash", "destination"},
        "research_relink": {"project", "source_id", "candidate"},
    }
    if method not in fields:
        raise ValueError("Unknown research desktop method")
    exact_keys(params, fields[method], method)
    workbench = _open(params["project"])
    if method == "research_execute":
        if params["operation"] in TASK_OPERATIONS:
            raise ValueError("Submit a durable task before execution")
        return workbench.execute(params["operation"], params["request"])
    if method == "research_submit":
        return submit_job(
            workbench,
            params["request"],
            params["request_key"],
            params.get("operation", "run_recipe"),
        )
    if method == "research_run":
        return run_job(workbench, params["job_id"])
    if method == "research_cancel":
        return cancel_job(workbench.project, params["job_id"])
    if method == "research_review":
        return workbench.project.review(
            params["result_id"], params["revision_hash"], params["disposition"]
        )
    if method == "research_relink":
        if workbench.project.source(params["source_id"]).get("locator_state") == "relink-required":
            from .research_interchange import relink_interchanged_source

            return relink_interchanged_source(
                workbench.project, params["source_id"], params["candidate"]
            )
        return workbench.project.relink(params["source_id"], params["candidate"])
    from .research_export import export_research_result

    return export_research_result(
        workbench.project, params["result_id"], params["revision_hash"], params["destination"]
    )
