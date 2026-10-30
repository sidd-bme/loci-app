"""Pure graph planning: native requests and exact identities, never scientific execution."""

import copy
import hashlib

import numpy as np
import pytest
import tifffile

from loci_engine.models import SegmentationSettings
from loci_engine.profiles import DEFAULT_PROFILE_ID
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench
from loci_engine.workflow_graph import (
    build_plan,
    definition_hash,
    resolve_node,
    validate_bindings,
    validate_definition,
)

BUDGET = 16 * 1024**2


def recipe_node(identity, source="image", threshold=20):
    return {
        "id": identity,
        "operation": "run_recipe",
        "contract_version": 1,
        "inputs": {"source": {"input": source}},
        "settings": {
            "recipe": {
                "segmentation": {"method": "components", "threshold": threshold},
                "measurement_channels": [0],
            }
        },
    }


def association_node():
    return {
        "id": "join",
        "operation": "associate_results",
        "contract_version": 1,
        "inputs": {
            "cells": {"node": "cells", "port": "result"},
            "nuclei": {"node": "nuclei", "port": "result"},
        },
        "settings": {
            "roles": {"cells": "cell masks", "nuclei": "nucleus masks"},
            "control": "Technical fixture",
        },
    }


def graph():
    return {
        "schema": "loci.workflow/v2",
        "name": "Two branches and explicit join",
        "inputs": {"image": "source-selection"},
        "nodes": [association_node(), recipe_node("nuclei", threshold=50), recipe_node("cells")],
        "outputs": {"associated": {"node": "join", "port": "result"}},
        "working_bytes": BUDGET,
    }


@pytest.fixture
def study(tmp_path):
    path = tmp_path / "technical.ome.tif"
    image = np.arange(120, dtype=np.uint16).reshape(10, 12)
    tifffile.imwrite(
        path,
        image,
        ome=True,
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 1.0,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 2.0,
            "PhysicalSizeYUnit": "µm",
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "graph.loci-study", "Graph"))
    source = wb.import_native(str(path))
    raw, geometry, selection = wb.load_scalar(source["id"], {"level": 0})
    masks = [
        np.zeros(raw.shape, np.uint32),
        np.ones(raw.shape, np.uint32),
        np.zeros(raw.shape, np.uint32),
    ]
    masks[0][3:5, 3:5] = 1
    masks[2][:, 0] = 1
    results = [
        wb.project.save_result(
            source_id=source["id"],
            kind="external-labels",
            arrays={"image": raw, "labels": mask},
            provenance={"geometry": geometry.to_dict(), "selection": selection, "measurements": []},
        )
        for mask in masks
    ]
    bindings = {
        "image": {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "selection": selection,
        }
    }
    return wb, bindings, results, path


def bound(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def forbid_execution(wb, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Planner called a scientific/persistence boundary")

    for name in ("run_recipe", "validate_recipe", "execute", "load_scalar"):
        monkeypatch.setattr(wb, name, forbidden)
    for name in ("load_array", "save_result", "save_document", "create_job"):
        if hasattr(wb.project, name):
            monkeypatch.setattr(wb.project, name, forbidden)
    monkeypatch.setattr("loci_engine.quantitative.segment_scalar", forbidden)


def test_branch_join_requests_are_exact_and_do_not_execute(study, monkeypatch):
    wb, bindings, results, _ = study
    before = copy.deepcopy(
        (graph(), bindings, wb.project.list_results(), wb.project.documents("workflow"))
    )
    forbid_execution(wb, monkeypatch)
    definition = graph()
    validated = validate_definition(definition)
    assert validated["node_order"] == ["cells", "nuclei", "join"]
    assert definition_hash(definition) == definition_hash(validated["definition"])
    first = resolve_node(wb, definition, bindings, {}, "cells")
    assert first["operation"] == "run_recipe"
    assert first["request"]["source_id"] == bindings["image"]["source_id"]
    assert first["request"]["recipe"]["working_bytes"] == BUDGET
    completed = {"cells": bound(results[1]), "nuclei": bound(results[0])}
    joined = resolve_node(wb, definition, bindings, completed, "join")
    assert joined["operation"] == "associate_results"
    assert joined["request"]["cells"] == completed["cells"]
    assert joined["request"]["nuclei"] == completed["nuclei"]
    assert (
        definition,
        bindings,
        wb.project.list_results(),
        wb.project.documents("workflow"),
    ) == before


def test_plan_identity_is_detached_deterministic_and_covers_runtime(study, monkeypatch):
    wb, bindings, _, _ = study
    forbid_execution(wb, monkeypatch)
    definition = graph()
    plan = build_plan(wb, definition, bindings)
    assert plan == build_plan(wb, definition, bindings)
    payload = {k: v for k, v in plan.items() if k != "plan_sha256"}
    assert plan["plan_sha256"] == hashlib.sha256(canonical_json(payload).encode()).hexdigest()
    assert plan["adapter_versions"] == {"run_recipe": 1, "associate_results": 1}
    assert plan["runtime"]["resolved_device"] == "cpu"
    original = plan["definition"]["name"]
    definition["name"] = "Changed externally"
    bindings["image"]["selection"]["width"] = 1
    assert plan["definition"]["name"] == original
    assert plan["bindings"]["image"]["selection"]["width"] == 12


def spatial_graph():
    return {
        "schema": "loci.workflow/v2",
        "name": "Exact external masks",
        "inputs": dict.fromkeys(("objects", "compartment", "boundary"), "label-result"),
        "nodes": [
            {
                "id": "distance",
                "operation": "spatial_distance_run",
                "contract_version": 1,
                "inputs": {key: {"input": key} for key in ("objects", "compartment", "boundary")},
                "settings": {
                    "band_edges": [0, 4, 8],
                    "exclude_crop_border": True,
                    "control": "Technical masks",
                    "boundary_coverage": "Supplied first column only",
                },
            }
        ],
        "outputs": {"measured": {"node": "distance", "port": "result"}},
        "working_bytes": BUDGET,
    }


def test_external_spatial_masks_use_native_metadata_validator(study, monkeypatch):
    wb, _, results, _ = study
    forbid_execution(wb, monkeypatch)
    bindings = {
        role: bound(result)
        for role, result in zip(("objects", "compartment", "boundary"), results, strict=True)
    }
    plan = build_plan(wb, spatial_graph(), bindings)
    resolved = resolve_node(wb, spatial_graph(), bindings, {}, "distance")
    assert resolved["request"]["result_id"] == results[0]["id"]
    assert resolved["request"]["boundary"] == bound(results[2])
    assert plan["bindings"] == bindings


def test_classical_adapter_uses_exact_builtin_profile_and_settings(study, monkeypatch):
    wb, bindings, _, _ = study
    definition = graph()
    definition["nodes"] = [recipe_node("cells")]
    definition["outputs"] = {"labels": {"node": "cells", "port": "result"}}
    definition["nodes"][0].update(
        operation="classical_run",
        settings={
            "profile_id": DEFAULT_PROFILE_ID,
            "settings": SegmentationSettings().to_dict(),
            "measurement_channels": [0],
        },
    )
    forbid_execution(wb, monkeypatch)
    resolved = resolve_node(wb, definition, bindings, {}, "cells")
    assert resolved["request"]["profile_id"] == DEFAULT_PROFILE_ID
    assert resolved["request"]["working_bytes"] == BUDGET


@pytest.mark.parametrize(
    "mutation",
    [
        "cycle",
        "duplicate",
        "type",
        "port",
        "unknown",
        "operation",
        "model",
        "version",
        "unused",
        "unreachable",
        "no_segmentation",
        "code",
        "reference",
        "memory",
        "nonfinite",
        "channels",
        "threshold",
        "empty",
        "too_many_nodes",
        "deep",
        "output_input",
        "huge_integer",
    ],
)
def test_invalid_definitions_are_rejected(mutation):
    definition = graph()
    if mutation == "cycle":
        definition["nodes"] = [association_node()]
        definition["nodes"][0]["inputs"] = {
            "cells": {"node": "join", "port": "result"},
            "nuclei": {"input": "mask"},
        }
        definition["inputs"] = {"mask": "label-result"}
    elif mutation == "duplicate":
        definition["nodes"].append(copy.deepcopy(definition["nodes"][1]))
    elif mutation == "type":
        definition["nodes"][0]["inputs"]["cells"] = {"input": "image"}
    elif mutation == "port":
        definition["outputs"]["associated"]["port"] = "measurements[0]"
    elif mutation == "unknown":
        definition["latest"] = True
    elif mutation == "operation":
        definition["nodes"][1]["operation"] = "model_run"
    elif mutation == "model":
        definition["nodes"][1].update(
            operation="classical_run",
            settings={
                "profile_id": "user-model",
                "settings": SegmentationSettings().to_dict(),
                "measurement_channels": [],
            },
        )
    elif mutation == "version":
        definition["nodes"][1]["contract_version"] = True
    elif mutation == "unused":
        definition["inputs"]["unused"] = "label-result"
    elif mutation == "unreachable":
        definition["nodes"].append(recipe_node("orphan"))
    elif mutation == "no_segmentation":
        definition["nodes"][1]["settings"]["recipe"]["segmentation"] = None
    elif mutation == "code":
        definition["nodes"][1]["settings"]["recipe"]["code"] = "eval('x')"
    elif mutation == "reference":
        definition["nodes"][1]["settings"]["recipe"]["references"] = {
            "flatfield": {"source_id": "0" * 32}
        }
    elif mutation == "memory":
        definition["nodes"][1]["settings"]["recipe"]["working_bytes"] = BUDGET + 1
    elif mutation == "nonfinite":
        definition["nodes"][1]["settings"]["recipe"]["segmentation"]["threshold"] = float("nan")
    elif mutation == "channels":
        definition["nodes"][1]["settings"]["recipe"]["measurement_channels"] = [0, 0]
    elif mutation == "threshold":
        definition["nodes"][1]["settings"]["recipe"]["segmentation"]["threshold"] = True
    elif mutation == "empty":
        definition["nodes"] = []
    elif mutation == "too_many_nodes":
        definition["nodes"] += [recipe_node(f"extra{i}") for i in range(30)]
    elif mutation == "deep":
        nested = {}
        for _ in range(20):
            nested = {"nested": nested}
        definition["extra"] = nested
    elif mutation == "huge_integer":
        definition["working_bytes"] = 10**1000
    elif mutation == "output_input":
        definition["inputs"]["mask"] = "label-result"
        definition["outputs"]["external"] = {"input": "mask"}
    with pytest.raises(ValueError):
        validate_definition(definition)


def test_reference_limit_is_total_including_outputs():
    definition = graph()
    definition["outputs"] = {f"out{i}": {"node": "join", "port": "result"} for i in range(61)}
    with pytest.raises(ValueError, match="64 references"):
        validate_definition(definition)


@pytest.mark.parametrize("mutation", ["hash", "source", "selection", "extra", "partial"])
def test_source_binding_rejects_stale_or_implicit_identity(study, mutation):
    wb, bindings, _, _ = study
    if mutation == "hash":
        bindings["image"]["source_sha256"] = "0" * 64
    elif mutation == "source":
        bindings["image"]["source_id"] = "0" * 32
    elif mutation == "selection":
        bindings["image"]["selection"]["width"] = 100
    elif mutation == "extra":
        bindings["latest"] = bindings["image"]
    else:
        del bindings["image"]["selection"]["z"]
    with pytest.raises(ValueError):
        validate_bindings(wb, graph(), bindings)


def test_changed_source_bytes_are_rejected(study):
    wb, bindings, _, path = study
    with path.open("ab") as stream:
        stream.write(b"source changed")
    with pytest.raises(ValueError):
        validate_bindings(wb, graph(), bindings)


def test_stale_completed_output_is_revalidated(study):
    wb, bindings, results, _ = study
    completed = {"cells": bound(results[1]), "nuclei": bound(results[0])}
    completed["cells"]["revision_hash"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        resolve_node(wb, graph(), bindings, completed, "join")
    with pytest.raises(ValueError, match="dependencies"):
        resolve_node(wb, graph(), bindings, {}, "join")
    with pytest.raises(ValueError, match="completed"):
        resolve_node(wb, graph(), bindings, {"cells": bound(results[1])}, "cells")


def test_external_result_binding_requires_exact_current_revision(study):
    wb, _, results, _ = study
    bindings = {
        role: bound(result)
        for role, result in zip(("objects", "compartment", "boundary"), results, strict=True)
    }
    bindings["boundary"]["revision_hash"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        build_plan(wb, spatial_graph(), bindings)


def test_spatial_numeric_limits_and_memory_are_checked_without_pixels(study, monkeypatch):
    wb, _, results, _ = study
    bindings = {
        role: bound(result)
        for role, result in zip(("objects", "compartment", "boundary"), results, strict=True)
    }
    forbid_execution(wb, monkeypatch)
    definition = spatial_graph()
    definition["nodes"][0]["settings"]["band_edges"] = [0, 4, 4]
    with pytest.raises(ValueError, match="increasing"):
        validate_definition(definition)
    definition = graph()
    definition["working_bytes"] = 1024**2
    monkeypatch.setattr(wb, "selection", lambda source_id, selection: selection)
    bindings = {
        "image": {
            "source_id": results[0]["source_id"],
            "source_sha256": results[0]["source_sha256"],
            "selection": {
                "x": 0,
                "y": 0,
                "width": 10000,
                "height": 10000,
                "z": 0,
                "t": 0,
                "c": 0,
                "level": 0,
            },
        }
    }
    with pytest.raises(ValueError, match="memory"):
        build_plan(wb, definition, bindings)


def test_medical_plan_geometry_uses_exact_cropped_voxel_centers():
    from types import SimpleNamespace

    from loci_engine.quantitative import Geometry
    from loci_engine.workflow_graph import _geometry

    original = Geometry.diagonal((2, 3, 4), "mm")
    workbench = SimpleNamespace(
        project=SimpleNamespace(
            source=lambda identity: {
                "source_kind": "medical",
                "metadata": {"geometry": original.to_dict()},
            }
        )
    )
    selection = {"x": 5, "y": 7, "z": 3, "width": 10, "height": 8, "c": 0, "t": 0, "level": 0}
    plane = _geometry(workbench, "0" * 32, selection)
    assert plane.axes == "YX" and plane.unit == "mm"
    assert [plane.affine[index][3] for index in range(3)] == [20, 21, 6]
    volume = _geometry(workbench, "0" * 32, {**selection, "z_stop": 5})
    assert volume.axes == "ZYX" and volume.affine == plane.affine
    original2d = Geometry.diagonal((3, 4), "mm")
    workbench.project.source = lambda identity: {
        "source_kind": "medical",
        "metadata": {"geometry": original2d.to_dict()},
    }
    with pytest.raises(ValueError, match="ZYX"):
        _geometry(workbench, "0" * 32, {**selection, "z_stop": 5})


def test_rgb_graph_preflight_requires_explicit_transform(tmp_path):
    path = tmp_path / "rgb.tif"
    tifffile.imwrite(path, np.full((8, 10, 3), 128, np.uint8), photometric="rgb")
    wb = Workbench(ResearchProject.create(tmp_path / "rgb.loci-study", "RGB"))
    source = wb.import_native(str(path))
    selection = wb.selection(source["id"], {"level": 0})
    definition = graph()
    definition["nodes"] = [recipe_node("cells")]
    definition["outputs"] = {"labels": {"node": "cells", "port": "result"}}
    bindings = {
        "image": {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "selection": selection,
        }
    }
    with pytest.raises(ValueError, match="RGB source"):
        build_plan(wb, definition, bindings)
    recipe = definition["nodes"][0]["settings"]["recipe"]
    recipe.update(input_transform="rgb_intensity", measurement_channels=[])
    assert build_plan(wb, definition, bindings)["node_scopes"]["cells"]["shape"] == [8, 10]
