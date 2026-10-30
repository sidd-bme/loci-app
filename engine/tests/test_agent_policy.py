import json
import os
import sqlite3

import numpy as np
import pytest
import tifffile

from loci_engine.agent_policy import load_policy, write_policy
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench, runtime_record


def runtime_identity():
    value = runtime_record()
    return {
        key: value[key]
        for key in (
            "engine",
            "numpy",
            "scipy",
            "scikit_image",
            "backend",
            "resolved_device",
        )
    }


def make_study(tmp_path):
    image_path = tmp_path / "synthetic.tif"
    image = np.zeros((2, 2, 4, 32, 32), np.uint16)
    image[0, 0, 1:3, 4:12, 4:12] = 100
    image[0, 1] = 20
    tifffile.imwrite(image_path, image, ome=True, metadata={"axes": "TCZYX"})
    workbench = Workbench(ResearchProject.create(tmp_path / "synthetic-study", "Synthetic"))
    source = workbench.import_native(str(image_path), name="untrusted source name")
    request = {
        "source_id": source["id"],
        "selection": {"x": 0, "y": 0, "width": 32, "height": 32, "z": 0, "z_stop": 4},
        "recipe": {
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0],
        },
    }
    return workbench, source, request


def specification(workbench, source, request, export_root, *, disclosures=None, recipes=True):
    validation = workbench.validate_recipe(request)
    return {
        "sources": [
            {
                "id": source["id"],
                "sha256": source["sha256"],
                "crop": {"x": 0, "y": 0, "width": 32, "height": 32},
                "t": [0],
                "c": [0],
                "z": [0, 1, 2, 3],
                "level": [0],
                "measurement_channels": [0],
            }
        ],
        "recipes": [
            {"sha256": validation["recipe_sha256"], "preview": True, "run": True}
        ]
        if recipes
        else [],
        "operations": [
            "validate_recipe",
            "preview_recipe",
            "submit_recipe",
            "job_status",
            "cancel_job",
            "result",
            "result_view",
            "export_result",
        ],
        "model_packages": [],
        "runtimes": [runtime_identity()],
        "export": {"root": str(export_root), "filenames": ["approved-result"]},
        "limits": {"cpu_seconds": 60, "memory_bytes": 8 * 1024**3, "concurrency": 1},
        "disclosures": [] if disclosures is None else disclosures,
    }


def test_private_policy_pins_content_project_source_and_export_root(tmp_path):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    path = tmp_path / "agent-policy.json"
    receipt = write_policy(
        path, workbench.project, specification(workbench, source, request, export_root)
    )
    policy = load_policy(path)
    if os.name != "nt":
        assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert receipt["policy_sha256"] == policy.content_sha256
    assert receipt["project_id"] == workbench.project.meta["project_id"]
    policy.recheck()

    document = json.loads(path.read_text())
    document["limits"]["concurrency"] = 2
    path.write_text(json.dumps(document), encoding="utf-8")
    os.chmod(path, 0o600)
    with pytest.raises(PermissionError, match="changed or replaced"):
        policy.recheck()


def test_policy_rejects_loose_permissions_unknown_rights_and_wrong_source(tmp_path):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    path = tmp_path / "agent-policy.json"
    spec = specification(workbench, source, request, export_root)
    write_policy(path, workbench.project, spec)
    if os.name != "nt":
        os.chmod(path, 0o644)
        with pytest.raises(ValueError, match="0600"):
            load_policy(path)

    os.chmod(path, 0o600)
    bad = dict(spec)
    bad["operations"] = [*spec["operations"], "shell"]
    with pytest.raises(ValueError, match="unsupported agent operation"):
        write_policy(path, workbench.project, bad)
    wrong = json.loads(json.dumps(spec))
    wrong["sources"][0]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="fingerprint"):
        write_policy(path, workbench.project, wrong)


def test_selection_grant_is_crop_axis_level_and_measurement_channel_bounded(tmp_path):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    path = tmp_path / "agent-policy.json"
    write_policy(path, workbench.project, specification(workbench, source, request, export_root))
    policy = load_policy(path)
    grant = policy.sources[source["id"]]
    selection = workbench.validate_recipe(request)["selection"]
    assert grant.allows(selection, [0])
    assert not grant.allows({**selection, "x": 1, "width": 32}, [0])
    assert not grant.allows({**selection, "t": 1}, [0])
    assert not grant.allows(selection, [1])


def test_policy_path_and_project_identity_are_explicit(tmp_path):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    with pytest.raises(ValueError, match="absolute"):
        write_policy(
            "relative.json",
            workbench.project,
            specification(workbench, source, request, export_root),
        )
    path = tmp_path / "agent-policy.json"
    spec = specification(workbench, source, request, export_root)
    write_policy(path, workbench.project, spec)
    document = json.loads(path.read_text())
    document["project"]["id"] = "a" * 32
    path.write_text(json.dumps(document), encoding="utf-8")
    os.chmod(path, 0o600)
    with pytest.raises(ValueError, match="identity"):
        load_policy(path)


def test_repeated_policy_identity_guard_does_not_replace_scientific_read_validation(tmp_path):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    path = tmp_path / "agent-policy.json"
    write_policy(path, workbench.project, specification(workbench, source, request, export_root))
    policy = load_policy(path)
    identity = "b" * 32
    malformed = {
        "id": identity,
        "kind": "spatial_density_report",
        "revision": 1,
        "updated_at": "2026-01-01T00:00:00Z",
        "data": {"schema": "loci.spatial-density-report/v2"},
    }
    # Simulated on-disk corruption after the policy was created. Authority
    # rechecks verify identity; neither they nor possession of a policy disclose
    # this malformed scientific document.
    with workbench.project.connection() as connection:
        connection.execute(
            "INSERT INTO documents VALUES(?,?,?,?)",
            (malformed["kind"], identity, 1, canonical_json(malformed)),
        )
    policy.recheck()
    with pytest.raises(ValueError):
        ResearchProject(workbench.project.root)
    with pytest.raises(ValueError):
        workbench.execute("spatial_density_get", {"report_id": identity})
    with pytest.raises(ValueError):
        load_policy(path)


@pytest.mark.parametrize(
    "tamper",
    [
        "project_id",
        "metadata_schema",
        "database_schema",
        "missing_identity",
        "artifact_link",
        "database_link",
        "project_replaced",
        "export_replaced",
    ],
)
def test_policy_identity_only_guard_still_rejects_replaced_or_invalid_authority(tmp_path, tamper):
    workbench, source, request = make_study(tmp_path)
    export_root = tmp_path / "exports"
    export_root.mkdir()
    path = tmp_path / "agent-policy.json"
    write_policy(path, workbench.project, specification(workbench, source, request, export_root))
    policy = load_policy(path)
    project = workbench.project
    workbench.close()
    if tamper in {"project_id", "metadata_schema", "database_schema", "missing_identity"}:
        with sqlite3.connect(project.database) as connection:
            if tamper == "database_schema":
                connection.execute("PRAGMA user_version=999")
            elif tamper == "missing_identity":
                connection.execute("DELETE FROM metadata WHERE key='project'")
            else:
                metadata = dict(project.meta)
                metadata["project_id" if tamper == "project_id" else "schema"] = (
                    "f" * 32 if tamper == "project_id" else "loci.study/v999"
                )
                connection.execute(
                    "UPDATE metadata SET value=? WHERE key='project'", (canonical_json(metadata),)
                )
    elif tamper in {"artifact_link", "database_link"}:
        original = project.arrays if tamper == "artifact_link" else project.database
        preserved = original.with_name(original.name + "-preserved")
        original.rename(preserved)
        original.symlink_to(preserved, target_is_directory=tamper == "artifact_link")
    elif tamper == "project_replaced":
        project.root.rename(project.root.with_name("preserved-study"))
        ResearchProject.create(project.root, "Replacement")
    else:
        export_root.rename(export_root.with_name("preserved-exports"))
        export_root.mkdir()
    with pytest.raises((ValueError, PermissionError)):
        policy.recheck()
