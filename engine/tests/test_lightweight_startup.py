import json
import os
import subprocess
import sys

import pytest


@pytest.mark.parametrize("route", ["discover", "health", "list_profiles"])
def test_unprovisioned_catalog_and_health_do_not_load_numerical_or_decoder_libraries(
    route, tmp_path
):
    program = """
import contextlib
import io
import json
import sys
route = sys.argv[1]
if route == 'discover':
    from loci_engine.research_cli import main
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        assert main(['discover']) == 0
    assert 'tissue_run' in json.loads(stream.getvalue())['operations']
else:
    from loci_engine.worker import dispatch
    output = dispatch(route, {})
    assert output.get('status') == 'ready' if route == 'health' else len(output['profiles']) > 0
heavy = {'numpy', 'scipy', 'skimage', 'cv2', 'torch', 'SimpleITK', 'onnxruntime'}
assert not heavy.intersection(sys.modules), sorted(heavy.intersection(sys.modules))
print(json.dumps({'route': route, 'heavy_imports': []}))
"""
    process = subprocess.run(
        [sys.executable, "-c", program, route],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
        env={**os.environ, "LOCI_MODEL_HOME": str(tmp_path / "unprovisioned-models")},
    )
    assert json.loads(process.stdout) == {"route": route, "heavy_imports": []}


def test_lightweight_catalog_is_shared_by_workbench_and_job_parser():
    from loci_engine.research_jobs import TASK_OPERATIONS
    from loci_engine.research_operations import OPERATION_CATALOG
    from loci_engine.workbench import OPERATION_CATALOG as WORKBENCH_CATALOG

    assert WORKBENCH_CATALOG is OPERATION_CATALOG
    assert OPERATION_CATALOG.keys() >= TASK_OPERATIONS


@pytest.mark.parametrize("route", ["create", "native-volume", "opening-preview"])
def test_study_and_viewer_startup_defer_unrelated_analysis_libraries(route, tmp_path):
    source = None
    if route == "native-volume":
        import numpy as np
        import tifffile

        source = tmp_path / "native.tiff"
        values = np.arange(4 * 12 * 16, dtype=np.uint16).reshape(4, 12, 16)
        tifffile.imwrite(source, values, photometric="minisblack", metadata={"axes": "ZYX"})
    elif route == "opening-preview":
        from test_ome_zarr import _store

        source, _ = _store(
            tmp_path,
            shapes=((1, 1, 4, 200, 208), (1, 1, 4, 100, 104)),
            chunks=(1, 1, 1, 64, 64),
        )

    program = """
import sys
from loci_engine.worker import dispatch

route, project, source = sys.argv[1:]
if route == 'opening-preview':
    output = dispatch('research_zarr_opening_overview', {'path': source, 'opening_id': 'startup'})
    assert output['context']['level'] == 1
    assert 'source_sha256' not in output['context']
    assert 'zarr' not in sys.modules
else:
    snapshot = dispatch('research_create', {'path': project, 'title': 'Lightweight startup'})
    assert snapshot['sources'] == []
    if route == 'native-volume':
        snapshot = dispatch('research_import', {
            'project': project, 'kind': 'files', 'paths': [source],
        })
        record = snapshot['sources'][0]
        request = {'project': project, 'request': {'source_id': record['id']}}
        defaults = dispatch('research_execute', {**request, 'operation': 'viewer_defaults'})
        assert defaults['source_sha256'] == record['sha256']
        volume = dispatch('research_execute', {**request, 'operation': 'viewer_volume'})
        assert volume['context']['source_sha256'] == record['sha256']
        assert volume['context']['dimensions_xyz'] == [16, 12, 4]
heavy = {'scipy', 'skimage', 'cv2', 'SimpleITK', 'loci_engine.ims', 'loci_engine.render',
         'loci_engine.results', 'loci_engine.working_result'}
assert not heavy.intersection(sys.modules), sorted(heavy.intersection(sys.modules))
"""
    process = subprocess.run(
        [
            sys.executable,
            "-c",
            program,
            route,
            str(tmp_path / "startup.loci-study"),
            str(source or ""),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert process.returncode == 0, process.stderr


@pytest.mark.parametrize("enabled", [False, True])
def test_volume_worker_timing_uses_only_stderr_and_fixed_operation_names(
    monkeypatch, capsys, enabled
):
    import io

    from loci_engine import worker

    monkeypatch.setattr(sys, "argv", ["loci-engine"])
    monkeypatch.setenv("LOCI_QA_VOLUME_TIMING", "1" if enabled else "0")
    requests = [
        {
            "id": "private-request",
            "method": "research_execute",
            "params": {"operation": "viewer_volume", "project": "/private/study"},
        },
        {"id": 2, "method": "health"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(r) + "\n" for r in requests)))
    monkeypatch.setattr(worker, "handle_request", lambda r: {"id": r["id"], "result": {"ok": True}})
    worker.main()
    output = capsys.readouterr()
    assert [json.loads(line)["id"] for line in output.out.splitlines()] == ["private-request", 2]
    if enabled:
        assert output.err.startswith("LOCI_VOLUME_TIMING ")
        log = json.loads(output.err.removeprefix("LOCI_VOLUME_TIMING "))
        assert set(log) == {"operation", "received_unix_ns", "handle_ns", "encode_ns", "write_ns"}
        assert log.pop("operation") == "viewer_volume"
        assert all(isinstance(value, int) and value >= 0 for value in log.values())
    else:
        assert not output.err
