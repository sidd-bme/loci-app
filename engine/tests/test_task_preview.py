import json

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_task_preview import get_preview
from loci_engine.workbench import Workbench


@pytest.fixture
def preview_task(tmp_path):
    source_file = tmp_path / "scalar.tif"
    pixels = np.zeros((16, 16), dtype=np.uint16)
    pixels[2:6, 3:7] = 100
    tifffile.imwrite(source_file, pixels)
    workbench = Workbench(ResearchProject.create(tmp_path / "study", "Preview fixture"))
    source = workbench.import_native(str(source_file))
    request = {
        "source_id": source["id"],
        "recipe": {
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0],
        },
    }
    yield workbench, request, source_file
    workbench.close()


def test_completed_preview_is_recoverable_without_adoption_or_reexecution(preview_task):
    workbench, request, _ = preview_task
    job = submit_job(workbench, request, "preview-one", operation="preview_recipe")
    output = run_job(workbench, job["id"])
    workbench.close()
    reopened = Workbench(ResearchProject(workbench.project.root))
    try:
        recovered = reopened.execute("task_preview_get", {"job_id": job["id"]})["preview"]
        assert recovered["adopted"] is False
        assert recovered["output"]["object_count"] == 1
        assert recovered["output"]["measurements"][0]["measure"] == 16
        assert (
            next(iter(recovered["output"]["measurements"][0]["intensity"].values()))["mean"] == 100
        )
        assert canonical_json(recovered["output"]) == canonical_json(
            {k: v for k, v in output.items() if k != "job"}
        )
        assert reopened.project.list_results() == []
        assert run_job(reopened, job["id"])["job"]["state"] == "succeeded"
        assert len(reopened.project.list_jobs()) == 1
    finally:
        reopened.close()


def test_preview_cache_rejects_tampering_and_changed_source(preview_task):
    workbench, request, source_file = preview_task
    job = submit_job(workbench, request, "preview-one", operation="preview_recipe")
    run_job(workbench, job["id"])
    with workbench.project.connection() as connection:
        key = "task-preview:" + job["id"]
        original = connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[
            0
        ]
        altered = json.loads(original)
        altered["output"]["object_count"] = 99
        connection.execute(
            "UPDATE metadata SET value=? WHERE key=?", (canonical_json(altered), key)
        )
    with pytest.raises(ValueError, match="exact task"):
        get_preview(workbench.project, job["id"])
    with workbench.project.connection() as connection:
        connection.execute("UPDATE metadata SET value=? WHERE key=?", (original, key))
    source_file.write_bytes(b"changed source")
    with pytest.raises(ValueError):
        get_preview(workbench.project, job["id"])


def test_cancel_at_preview_publication_leaves_no_cache_or_success(preview_task, monkeypatch):
    workbench, request, _ = preview_task
    job = submit_job(workbench, request, "preview-one", operation="preview_recipe")
    native = workbench.run_recipe

    def cancel_after_compute(*args, **kwargs):
        output = native(*args, **kwargs)
        cancel_job(workbench.project, job["id"])
        return output

    monkeypatch.setattr(workbench, "run_recipe", cancel_after_compute)
    with pytest.raises(ValueError, match="cancelled"):
        run_job(workbench, job["id"])
    assert workbench.project.job(job["id"])["state"] == "cancelled"
    with workbench.project.connection() as connection:
        assert not connection.execute(
            "SELECT key FROM metadata WHERE key LIKE 'task-preview:%'"
        ).fetchall()


def test_preview_cache_eviction_is_bounded_and_does_not_replay(preview_task, monkeypatch):
    from loci_engine import research_task_preview

    monkeypatch.setattr(research_task_preview, "MAX_PREVIEWS", 2)
    workbench, request, _ = preview_task
    jobs = []
    for index in range(3):
        job = submit_job(workbench, request, f"preview-{index}", operation="preview_recipe")
        run_job(workbench, job["id"])
        jobs.append(job)
    with pytest.raises(ValueError, match="evicted"):
        get_preview(workbench.project, jobs[0]["id"])
    assert get_preview(workbench.project, jobs[-1]["id"])["preview"]["output"]["object_count"] == 1
    assert len(workbench.project.list_jobs()) == 3
    assert workbench.project.list_results() == []
