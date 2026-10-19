import copy
import hashlib
import json
import shutil
import zipfile

import numpy as np
import pytest
import tifffile

from loci_engine.research_interchange import (
    export_project,
    import_project,
    relink_interchanged_source,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_rpc import dispatch_research
from loci_engine.research_session import clone_study
from loci_engine.source_browser_location import (
    browser_location_for_source,
    prepare_import_root,
    validate_browser_location,
    validate_browser_roots,
)
from loci_engine.workbench import Workbench


def _source(folder, relative="FBS/Preview_12.tif", offset=0):
    path = folder / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    tifffile.imwrite(path, np.arange(48, dtype=np.uint8).reshape(6, 8) + offset)
    return path


def _import(project, folder, paths):
    return dispatch_research(
        "research_import",
        {
            "project": str(project.root),
            "paths": [str(path) for path in paths],
            "kind": "files",
            "relative_paths": [path.relative_to(folder).as_posix() for path in paths],
            "import_root": str(folder),
        },
    )


def test_legacy_projection_retains_nested_names_without_stored_or_numerical_mutation(tmp_path):
    project = ResearchProject.create(tmp_path / "legacy.loci-study", "Legacy")
    path = _source(tmp_path / "private-parent" / "not-a-proven-root")
    workbench = Workbench(project)
    source = workbench.import_native(str(path), relative_path="FBS/Preview_12.tif")
    result = project.save_result(
        source_id=source["id"],
        kind="synthetic",
        arrays={"labels": np.ones((6, 8), dtype=np.uint32)},
        provenance={"synthetic": True},
    )
    stored = copy.deepcopy(project.source(source["id"]))
    snapshot = workbench.snapshot()
    assert snapshot["sources"][0]["browser_location"] == {
        "relative_path": "FBS/Preview_12.tif",
        "root": None,
    }
    assert project.source(source["id"]) == stored
    assert project.result(result["id"]) == result
    assert "private-parent" not in json.dumps(snapshot)
    assert "not-a-proven-root" not in json.dumps(snapshot)
    assert "browser_location" not in stored
    archive = tmp_path / "legacy-portable.zip"
    export_project(project, archive)
    restored = import_project(archive, tmp_path / "legacy-restored.loci-study")
    assert (
        restored.list_sources()[0]["browser_location"] == snapshot["sources"][0]["browser_location"]
    )
    assert restored.result(result["id"]) == result
    assert project.source(source["id"]) == stored


def test_folder_identity_is_stable_and_same_named_roots_remain_separate(tmp_path):
    project = ResearchProject.create(tmp_path / "folders.loci-study", "Folders")
    first = tmp_path / "first" / "collection"
    second = tmp_path / "second" / "collection"
    first_path, second_path = _source(first), _source(second, offset=10)
    initial = _import(project, first, [first_path])["sources"][0]
    repeated = _import(project, first, [first_path])["sources"][0]
    assert repeated == initial
    later_path = _source(first, "SFM/Preview_12.tif")
    added = _import(project, first, [later_path])["sources"]
    assert added[0]["browser_location"]["root"] == added[1]["browser_location"]["root"]
    all_sources = _import(project, second, [second_path])["sources"]
    roots = [source["browser_location"]["root"] for source in all_sources]
    assert roots[0]["name"] == roots[2]["name"] == "collection"
    assert roots[0]["id"] != roots[2]["id"]
    assert len({source["id"] for source in all_sources}) == 3
    assert str(tmp_path) not in json.dumps(all_sources)
    assert project.source(initial["id"])["private_import_root"] == str(first.resolve())


def test_changed_registered_file_keeps_existing_import_failure_and_grouping(tmp_path):
    project = ResearchProject.create(tmp_path / "changed.loci-study", "Changed")
    folder = tmp_path / "collection"
    path = _source(folder)
    source = _import(project, folder, [path])["sources"][0]
    before = project.source(source["id"])
    _source(folder, offset=20)
    with pytest.raises(ValueError, match="changed"):
        _import(project, folder, [path])
    assert project.source(source["id"]) == before
    assert project.list_sources() == [source]


def test_relinked_historical_path_collision_does_not_fail_new_import(tmp_path):
    project = ResearchProject.create(tmp_path / "history.loci-study", "History")
    folder = tmp_path / "collection"
    path = _source(folder)
    original = _import(project, folder, [path])["sources"][0]
    archived = tmp_path / "archived.tif"
    shutil.copyfile(path, archived)
    project.relink(original["id"], archived)
    previous = project.source(original["id"])
    _source(folder, offset=20)
    sources = _import(project, folder, [path])["sources"]
    assert len(sources) == 2
    assert project.source(original["id"]) == previous
    assert sources[0]["browser_location"] == original["browser_location"]
    assert (
        sources[1]["browser_location"]["root"]["id"] != original["browser_location"]["root"]["id"]
    )
    assert sources[1]["browser_location"]["relative_path"] == "FBS/Preview_12.tif"


def test_overlapping_parent_import_preserves_previous_child_grouping(tmp_path):
    project = ResearchProject.create(tmp_path / "overlap.loci-study", "Overlap")
    parent = tmp_path / "Dataset"
    child = parent / "Control"
    first = _source(child, "field.tif")
    original = _import(project, child, [first])["sources"][0]
    previous = project.source(original["id"])
    second = _source(parent, "Treatment/other.tif")
    sources = _import(project, parent, [first, second])["sources"]
    assert len(sources) == 2
    assert sources[0] == original
    assert project.source(original["id"]) == previous
    assert sources[1]["browser_location"]["root"]["name"] == "Dataset"
    assert (
        sources[1]["browser_location"]["root"]["id"] != original["browser_location"]["root"]["id"]
    )


def test_portable_roots_converging_on_one_directory_preserve_old_groups(tmp_path):
    project = ResearchProject.create(tmp_path / "roots.loci-study", "Roots")
    locations = [tmp_path / name / "Dataset" for name in ("first", "second")]
    paths = [_source(locations[0], "Control/a.tif"), _source(locations[1], "Treatment/b.tif")]
    for folder, path in zip(locations, paths, strict=True):
        _import(project, folder, [path])
    archive = tmp_path / "roots.zip"
    export_project(project, archive)
    restored = import_project(archive, tmp_path / "restored-roots.loci-study")
    old = restored.list_sources()
    current = tmp_path / "converged" / "Dataset"
    selected = []
    for source in old:
        original = project.source(source["id"])["private_path"]
        destination = current / source["browser_location"]["relative_path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, destination)
        relink_interchanged_source(restored, source["id"], destination)
        selected.append(destination)
    new = _source(current, "New/c.tif")
    sources = _import(restored, current, [*selected, new])["sources"]
    for original in old:
        after = next(source for source in sources if source["id"] == original["id"])
        assert after["browser_location"] == original["browser_location"]
        assert after["sha256"] == original["sha256"]
    assert len({source["browser_location"]["root"]["id"] for source in sources}) == 3


def test_import_containment_and_relative_consistency_fail_before_registration(tmp_path):
    project = ResearchProject.create(tmp_path / "study.loci-study", "Boundaries")
    folder = tmp_path / "collection"
    path = _source(folder)
    outside = _source(tmp_path / "outside")
    for selected, relative in ((outside, "FBS/Preview_12.tif"), (path, "wrong/file.tif")):
        with pytest.raises(ValueError, match="outside|disagrees"):
            dispatch_research(
                "research_import",
                {
                    "project": str(project.root),
                    "paths": [str(selected)],
                    "relative_paths": [relative],
                    "kind": "files",
                    "import_root": str(folder),
                },
            )
        assert project.list_sources() == []
    linked = tmp_path / "linked"
    linked.symlink_to(folder, target_is_directory=True)
    with pytest.raises(ValueError, match="plain directory"):
        prepare_import_root(str(linked), [str(path)], ["FBS/Preview_12.tif"])


def test_root_canonicalization_matches_private_locators_and_rejects_descendant_escape(tmp_path):
    real_parent = tmp_path / "real"
    folder = real_parent / "collection"
    _source(folder)
    alias = tmp_path / "alias"
    alias.symlink_to(real_parent, target_is_directory=True)
    selected_root = alias / "collection"
    plan = prepare_import_root(
        str(selected_root), [str(selected_root / "FBS/Preview_12.tif")], ["FBS/Preview_12.tif"]
    )
    assert plan["path"] == str(folder.resolve())
    outside = tmp_path / "outside"
    _source(outside, "file.tif")
    (folder / "escape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="outside"):
        prepare_import_root(str(folder), [str(folder / "escape/file.tif")], ["escape/file.tif"])


@pytest.mark.parametrize(
    "relative",
    [
        "/private/source.tif",
        "C:/private/source.tif",
        "C:\\private\\source.tif",
        "//server/share/source.tif",
        "../source.tif",
        "a/../source.tif",
        "a//source.tif",
        "./source.tif",
        "a\\source.tif",
        "a/\nfile",
        "a/" + "x" * 256,
        "/".join(["folder"] * 65),
    ],
)
def test_display_path_rejects_private_prefixes_and_unsafe_components(relative):
    with pytest.raises(ValueError):
        validate_browser_location({"relative_path": relative, "root": None})
    # The invalid private path never leaks through the public fallback.
    assert browser_location_for_source({"private_relative_path": relative, "name": "safe.tif"}) == {
        "relative_path": "safe.tif",
        "root": None,
    }


@pytest.mark.parametrize(
    "root",
    [
        {"id": "a" * 32, "name": "/private/root"},
        {"id": "bad", "name": "Root"},
        {"id": "a" * 32, "name": "Root", "private_path": "/private/root"},
        {"id": "a" * 32, "name": "../Root"},
    ],
)
def test_explicit_root_metadata_has_exact_safe_fields(root):
    with pytest.raises(ValueError):
        validate_browser_location({"relative_path": "FBS/file.tif", "root": root})


def test_unproven_duplicate_legacy_paths_remain_separate_but_explicit_roots_are_consistent():
    legacy = [
        {"id": key, "browser_location": {"relative_path": "FBS/file.tif", "root": None}}
        for key in ("a" * 32, "b" * 32)
    ]
    validate_browser_roots(legacy)
    root = {"id": "c" * 32, "name": "Root"}
    for item in legacy:
        item["browser_location"]["root"] = root.copy()
    with pytest.raises(ValueError, match="duplicate source paths"):
        validate_browser_roots(legacy)
    legacy[1]["browser_location"]["relative_path"] = "SFM/other.tif"
    legacy[1]["browser_location"]["root"]["name"] = "Changed"
    with pytest.raises(ValueError, match="conflicting names"):
        validate_browser_roots(legacy)


def test_save_as_portable_relink_and_reimport_preserve_root_and_fingerprints(tmp_path):
    project = ResearchProject.create(tmp_path / "original.loci-study", "Original")
    folder = tmp_path / "collection"
    path = _source(folder)
    source = _import(project, folder, [path])["sources"][0]
    saved = clone_study(project, tmp_path / "saved.loci-study")
    assert saved.list_sources() == project.list_sources()
    archive = tmp_path / "portable.zip"
    export_project(project, archive)
    with zipfile.ZipFile(archive) as zipped:
        record = json.loads(zipped.read(f"sources/{source['id']}.json"))
    assert record["browser_location"] == source["browser_location"]
    assert not any(key.startswith("private_") for key in record)
    restored = import_project(archive, tmp_path / "restored.loci-study")
    assert restored.list_sources()[0]["browser_location"] == source["browser_location"]
    relink_interchanged_source(restored, source["id"], path)
    assert restored.list_sources()[0]["browser_location"] == source["browser_location"]
    repeated = _import(restored, folder, [path])["sources"][0]
    assert repeated["browser_location"] == source["browser_location"]
    assert repeated["id"] == source["id"] and repeated["sha256"] == source["sha256"]


def test_source_name_fallback_does_not_invent_directories_for_medical_or_zarr_sources():
    for name in ("DICOM series", "volume.ome.zarr", "brain.nii.gz"):
        assert browser_location_for_source({"name": name}) == {"relative_path": name, "root": None}
    assert browser_location_for_source({"name": "display alias / not a folder"}) is None


def test_folder_display_scope_does_not_expand_agent_disclosures(tmp_path):
    from test_research_mcp import make_context_agent

    from loci_engine.agent_policy import load_policy, write_policy
    from loci_engine.research_mcp import PolicyAgent

    agent, workbench, _ = make_context_agent(
        tmp_path, disclosures=["agent_metadata", "source_names"]
    )
    document = json.loads(agent.policy.path.read_text())
    specification = {
        key: value for key, value in document.items() if key not in {"schema", "project"}
    }
    specification["operations"].append("inspect_source")
    policy_path = tmp_path / "with-inspection-policy.json"
    write_policy(policy_path, workbench.project, specification)
    agent = PolicyAgent(load_policy(policy_path))
    identity = next(iter(agent.policy.sources))
    record = workbench.project.source(identity)
    record["browser_location"] = {
        "relative_path": "Private-group/synthetic.tif",
        "root": {"id": "f" * 32, "name": "Display-only root"},
    }
    with workbench.project.connection() as connection:
        connection.execute(
            "UPDATE sources SET record=? WHERE id=?", (canonical_json(record), identity)
        )
    assert "Display-only root" in json.dumps(workbench.snapshot())
    disclosed = json.dumps([agent.analysis_context(), agent.inspect_source(identity)])
    assert "Display-only root" not in disclosed
    assert "Private-group" not in disclosed
    assert "browser_location" not in disclosed


def test_closed_source_and_restore_keep_folder_identity(tmp_path):
    from loci_engine.research_workspace_records import update_visibility

    project = ResearchProject.create(tmp_path / "visibility.loci-study", "Visibility")
    folder = tmp_path / "collection"
    source = _import(project, folder, [_source(folder)])["sources"][0]
    changed = update_visibility(
        project,
        {
            "expected_revision": 0,
            "results": [],
            "sources": [
                {
                    "id": source["id"],
                    "sha256": source["sha256"],
                    "visible": False,
                }
            ],
        },
    )
    snapshot = Workbench(project).snapshot()
    assert snapshot["sources"] == []
    assert (
        snapshot["workspace"]["closed_sources"][0]["browser_location"] == source["browser_location"]
    )
    update_visibility(
        project,
        {
            "expected_revision": changed["revision"],
            "results": [],
            "sources": [
                {
                    "id": source["id"],
                    "sha256": source["sha256"],
                    "visible": True,
                }
            ],
        },
    )
    assert Workbench(project).snapshot()["sources"][0] == source


def test_archive_import_rejects_invalid_browser_metadata_even_with_matching_manifest(tmp_path):
    project = ResearchProject.create(tmp_path / "original.loci-study", "Original")
    folder = tmp_path / "collection"
    source = _import(project, folder, [_source(folder)])["sources"][0]
    original = tmp_path / "original.zip"
    forged = tmp_path / "forged.zip"
    export_project(project, original)
    with zipfile.ZipFile(original) as incoming:
        entries = [(info, incoming.read(info)) for info in incoming.infolist()]
    source_name = f"sources/{source['id']}.json"
    index = next(i for i, (info, _) in enumerate(entries) if info.filename == source_name)
    record = json.loads(entries[index][1])
    record["browser_location"]["relative_path"] = "/private/hidden/absolute.tif"
    payload = canonical_json(record).encode()
    entries[index] = (entries[index][0], payload)
    manifest = json.loads(entries[-1][1])
    member = next(item for item in manifest["members"] if item["path"] == source_name)
    member.update(sha256=hashlib.sha256(payload).hexdigest(), size_bytes=len(payload))
    entries[-1] = (entries[-1][0], canonical_json(manifest).encode())
    with zipfile.ZipFile(forged, "w") as outgoing:
        for info, data in entries:
            outgoing.writestr(info, data)
    with pytest.raises(ValueError, match="Browser"):
        import_project(forged, tmp_path / "rejected.loci-study")
    assert not (tmp_path / "rejected.loci-study").exists()
