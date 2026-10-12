"""Cancellation reaches integrity work before a large result can publish."""

import pytest
from test_research_large import _fixture, _published

from loci_engine.native_image import NativeImageSession
from loci_engine.research_tiled_store import iter_object_rows, validate_grid, validate_object_table


class CancelledProbe(RuntimeError):
    pass


def stop():
    raise CancelledProbe("cancelled at bounded integrity checkpoint")


def test_native_open_and_cold_workbench_session_are_cancellable(tmp_path):
    workbench, path, source, _, _, _ = _fixture(tmp_path)
    with pytest.raises(CancelledProbe):
        NativeImageSession(path, check=stop)
    workbench.sessions.pop(source["id"]).close()
    with pytest.raises(CancelledProbe):
        workbench._session(source["id"], check=stop)
    assert source["id"] not in workbench.sessions


def test_registered_source_hash_is_cancellable(tmp_path):
    workbench, _, source, _, _, _ = _fixture(tmp_path)
    with pytest.raises(CancelledProbe):
        workbench.project.source(source["id"], verify=True, check=stop)


def test_artifact_verification_is_cancellable_even_when_semantically_cached(tmp_path):
    workbench, _, _, request, _, _ = _fixture(tmp_path)
    _, _, result = _published(workbench, request)
    project = workbench.project
    validate_object_table(project, result["object_table"])
    with pytest.raises(CancelledProbe):
        project.result(result["id"], check=stop)
    with pytest.raises(CancelledProbe):
        project.review_state(result["id"], check=stop)
    with pytest.raises(CancelledProbe):
        validate_object_table(project, result["object_table"], check=stop)
    with pytest.raises(CancelledProbe):
        next(iter_object_rows(project, result["object_table"], check=stop))
    with pytest.raises(CancelledProbe):
        validate_grid(project, result["arrays"]["labels"], verify=True, check=stop)


def test_cancelled_publication_does_not_publish_another_result(tmp_path):
    workbench, _, source, request, _, _ = _fixture(tmp_path)
    _, _, result = _published(workbench, request)
    with pytest.raises(CancelledProbe):
        workbench.project.save_tiled_result(
            source_id=source["id"], kind=result["kind"], arrays=result["arrays"],
            provenance=result["provenance"], object_table=result["object_table"],
            label_sha256=result["label_sha256"], publication_guard=stop,
        )
    with workbench.project.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM results").fetchone()[0] == 1
