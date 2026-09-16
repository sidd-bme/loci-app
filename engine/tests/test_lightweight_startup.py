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
