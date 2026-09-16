import copy
import hashlib

import numpy as np
import pytest

from loci_engine.research_project import ResearchProject
from loci_engine.research_session import clone_study
from loci_engine.research_workspace_records import (
    read_visibility,
    reorder_sources,
    update_visibility,
)
from loci_engine.workbench import Workbench


@pytest.fixture
def study(tmp_path):
    path = tmp_path / "source.bin"
    path.write_bytes(b"immutable original")
    project = ResearchProject.create(tmp_path / "original.loci-study", "Workspace")
    source = project.register_source(path, hashlib.sha256(path.read_bytes()).hexdigest(), {})
    job = project.submit("fixture", {"source_id": source["id"]}, "job-one")
    project.update_job(job["id"], expected_state="queued", state="running")
    result = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"labels": np.array([[0, 1], [2, 0]], dtype=np.uint32)},
        provenance={"measurements": [{"id": 1}, {"id": 2}]},
        job_id=job["id"],
    )
    project.review(result["id"], result["revision_hash"], "reviewed")
    return project, source, result, job, path


def request(source=None, result=None, visible=False, revision=0):
    return {
        "expected_revision": revision,
        "sources": []
        if source is None
        else [{"id": source["id"], "sha256": source["sha256"], "visible": visible}],
        "results": []
        if result is None
        else [{"id": result["id"], "revision_hash": result["revision_hash"], "visible": visible}],
    }


def test_clear_results_is_durable_reversible_and_keeps_review_artifacts_jobs(study, tmp_path):
    project, source, result, job, path = study
    before = project.result(result["id"])
    update_visibility(project, request(result=result))
    copied = clone_study(project, tmp_path / "copy.loci-study")
    for current in (ResearchProject(project.root), copied):
        snapshot = Workbench(current).snapshot()
        assert snapshot["results"] == []
        assert snapshot["sources"][0]["id"] == source["id"]
        assert snapshot["workspace"]["hidden_results"][0]["id"] == result["id"]
        assert current.result(result["id"]) == before
        assert current.review_state(result["id"])["disposition"] == "reviewed"
        assert current.list_jobs()[0]["id"] == job["id"]
        np.testing.assert_array_equal(
            current.load_array(result["arrays"]["labels"]), [[0, 1], [2, 0]]
        )
    fresh = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"labels": np.ones((2, 2), dtype=np.uint32)},
        provenance={},
    )
    assert [item["id"] for item in Workbench(project).snapshot()["results"]] == [fresh["id"]]
    update_visibility(project, request(result=result, visible=True, revision=1))
    assert len(Workbench(project).snapshot()["results"]) == 2
    assert path.read_bytes() == b"immutable original"


def test_close_and_reopen_source_retains_exact_scientific_history(study):
    project, source, result, _, _ = study
    update_visibility(project, request(source=source))
    closed = Workbench(ResearchProject(project.root)).snapshot()
    assert closed["sources"] == closed["results"] == []
    assert closed["workspace"]["closed_sources"][0]["id"] == source["id"]
    assert "private_path" not in closed["workspace"]["closed_sources"][0]
    update_visibility(project, request(source=source, visible=True, revision=1))
    opened = Workbench(project).snapshot()
    assert opened["sources"][0]["id"] == source["id"]
    assert opened["results"][0]["revision_hash"] == result["revision_hash"]


def test_stale_or_mixed_invalid_changes_are_atomic(study):
    project, source, result, _, _ = study
    changes = request(source=source, result=result)
    changes["results"][0]["revision_hash"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        update_visibility(project, changes)
    assert read_visibility(project)["revision"] == 0
    update_visibility(project, request(result=result))
    with pytest.raises(ValueError, match="Workspace changed"):
        update_visibility(project, request(source=source))
    assert len(Workbench(project).snapshot()["sources"]) == 1


@pytest.mark.parametrize(
    "damage", ["empty", "bool-revision", "duplicate", "unknown", "extra", "numeric-visible"]
)
def test_rejects_unbounded_or_ambiguous_workspace_requests(study, damage):
    project, source, _, _, _ = study
    value = request(source=source)
    if damage == "empty":
        value["sources"] = []
    elif damage == "bool-revision":
        value["expected_revision"] = True
    elif damage == "duplicate":
        value["sources"] *= 2
    elif damage == "unknown":
        value["sources"][0]["id"] = "f" * 32
    elif damage == "extra":
        value["sources"][0]["path"] = "/untrusted"
    else:
        value["sources"][0]["visible"] = 1
    with pytest.raises(ValueError):
        update_visibility(project, value)
    assert read_visibility(project)["revision"] == 0


def test_corrupt_saved_visibility_fails_closed(study):
    project, source, _, _, _ = study
    value = update_visibility(project, request(source=source))
    bad = copy.deepcopy(value["data"])
    bad["sources"][source["id"]] = "a" * 64
    project.put_document("workspace", project.meta["project_id"], bad, expected_revision=1)
    with pytest.raises(ValueError, match="stale"):
        Workbench(project).snapshot()


def test_portable_archive_retains_closed_and_cleared_bindings(tmp_path):
    import tifffile

    from loci_engine.research_interchange import export_project, import_project

    project = ResearchProject.create(tmp_path / "portable.loci-study", "Portable workspace")
    path = tmp_path / "source.tif"
    tifffile.imwrite(path, np.arange(64, dtype=np.uint16).reshape(8, 8))
    workbench = Workbench(project)
    source = workbench.import_native(str(path))
    output = workbench.execute(
        "run_recipe", {"source_id": source["id"], "recipe": {"segmentation": {"threshold": 20}}}
    )
    result = project.result(output["result"]["id"])
    update_visibility(project, request(source=source, result=result))
    archive = tmp_path / "closed.loci-study.zip"
    export_project(project, archive)
    reopened = import_project(archive, tmp_path / "imported.loci-study")
    snapshot = Workbench(reopened).snapshot()
    assert snapshot["sources"] == snapshot["results"] == []
    assert snapshot["workspace"]["closed_sources"][0]["id"] == source["id"]
    assert snapshot["workspace"]["hidden_results"][0]["revision_hash"] == result["revision_hash"]
    assert reopened.result(result["id"]) == result


def test_native_picker_reopens_exact_closed_source_without_restoring_cleared_results(tmp_path):
    import tifffile

    from loci_engine.research_rpc import dispatch_research

    project = ResearchProject.create(tmp_path / "pick.loci-study", "Reopen image")
    path = tmp_path / "source.tif"
    tifffile.imwrite(path, np.arange(64, dtype=np.uint16).reshape(8, 8))
    workbench = Workbench(project)
    source = workbench.import_native(str(path))
    output = workbench.execute(
        "run_recipe", {"source_id": source["id"], "recipe": {"segmentation": {"threshold": 20}}}
    )
    result = project.result(output["result"]["id"])
    update_visibility(project, request(source=source, result=result))
    reopened = dispatch_research(
        "research_import", {"project": str(project.root), "paths": [str(path)], "kind": "files"}
    )
    assert reopened["sources"][0]["id"] == source["id"]
    assert reopened["results"] == []
    assert reopened["workspace"]["hidden_results"][0]["id"] == result["id"]
    assert len(project.list_sources()) == 1


def test_source_order_survives_reopen_clone_and_closed_source_round_trip(tmp_path):
    sources = []
    project = ResearchProject.create(tmp_path / "ordered.loci-study", "Ordered workspace")
    for index in range(3):
        path = tmp_path / f"source-{index}.bin"
        path.write_bytes(f"immutable-{index}".encode())
        sources.append(
            project.register_source(path, hashlib.sha256(path.read_bytes()).hexdigest(), {})
        )
    before = [project.source(item["id"]) for item in sources]

    from loci_engine.research_rpc import dispatch_research

    dispatch_research(
        "research_source_order",
        {
            "project": str(project.root),
            "request": {
                "expected_revision": 0,
                "sources": [
                    {"id": item["id"], "sha256": item["sha256"]}
                    for item in (sources[2], sources[0], sources[1])
                ],
            },
        },
    )
    reopened = Workbench(ResearchProject(project.root)).snapshot()
    assert [item["id"] for item in reopened["sources"]] == [
        sources[2]["id"],
        sources[0]["id"],
        sources[1]["id"],
    ]

    update_visibility(project, request(source=sources[0], revision=1))
    reordered = reorder_sources(
        project,
        {
            "expected_revision": 2,
            "sources": [
                {"id": item["id"], "sha256": item["sha256"]} for item in (sources[1], sources[2])
            ],
        },
    )
    assert reordered["revision"] == 3
    assert [item["id"] for item in Workbench(project).snapshot()["sources"]] == [
        sources[1]["id"],
        sources[2]["id"],
    ]
    update_visibility(project, request(source=sources[0], visible=True, revision=3))
    expected = [sources[1]["id"], sources[0]["id"], sources[2]["id"]]
    assert [item["id"] for item in Workbench(project).snapshot()["sources"]] == expected
    copied = clone_study(project, tmp_path / "ordered-copy.loci-study")
    assert [item["id"] for item in Workbench(copied).snapshot()["sources"]] == expected
    assert [project.source(item["id"]) for item in sources] == before
    assert [(tmp_path / f"source-{index}.bin").read_bytes() for index in range(3)] == [
        f"immutable-{index}".encode() for index in range(3)
    ]


def test_source_order_rejects_stale_duplicate_missing_and_concurrent_addition(tmp_path):
    project = ResearchProject.create(tmp_path / "bounded-order.loci-study", "Bounded order")
    sources = []
    for index in range(2):
        path = tmp_path / f"bounded-{index}.bin"
        path.write_bytes(bytes([index]))
        sources.append(
            project.register_source(path, hashlib.sha256(path.read_bytes()).hexdigest(), {})
        )
    valid = {
        "expected_revision": 0,
        "sources": [{"id": item["id"], "sha256": item["sha256"]} for item in reversed(sources)],
    }
    reorder_sources(project, valid)

    duplicate = copy.deepcopy(valid)
    duplicate["expected_revision"] = 1
    duplicate["sources"] = [duplicate["sources"][0], duplicate["sources"][0]]
    with pytest.raises(ValueError, match="unique"):
        reorder_sources(project, duplicate)
    stale = copy.deepcopy(valid)
    stale["expected_revision"] = 1
    stale["sources"][0]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        reorder_sources(project, stale)
    missing = copy.deepcopy(valid)
    missing["expected_revision"] = 1
    missing["sources"] = missing["sources"][:1]
    with pytest.raises(ValueError, match="every current visible"):
        reorder_sources(project, missing)

    added_path = tmp_path / "bounded-added.bin"
    added_path.write_bytes(b"added")
    added = project.register_source(
        added_path, hashlib.sha256(added_path.read_bytes()).hexdigest(), {}
    )
    assert [item["id"] for item in Workbench(project).snapshot()["sources"]] == [
        sources[1]["id"],
        sources[0]["id"],
        added["id"],
    ]
    with pytest.raises(ValueError, match="every current visible"):
        reorder_sources(project, missing)
    assert read_visibility(project)["revision"] == 1
