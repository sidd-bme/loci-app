"""Actual OS lifecycle fixtures; no model/runtime inference or external data."""

import json
import os
import signal
import subprocess
import sys
import time
from contextlib import suppress

import pytest

from loci_engine.research_jobs import submit_job

pytest_plugins = ["test_tissue_model_integration"]
pytestmark = pytest.mark.skipif(os.name != "posix", reason="Native POSIX supervisor contract")


def wait_until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    assert predicate(), "OS fixture did not reach its bounded lifecycle state"


def pid_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def live(pid):
    if not pid_exists(pid):
        return False
    status = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False
    ).stdout.strip()
    # An exited orphan may await OS reaping (especially under container PID 1).
    # A zombie cannot hold a pipe or continue model work; it is not called reaped.
    return bool(status) and not status.startswith("Z")


def cleanup(parent, leader=None):
    if leader is not None:
        with suppress(ProcessLookupError):
            os.killpg(leader, signal.SIGKILL)
    if parent.poll() is None:
        parent.kill()
    parent.wait(timeout=3)
    for stream in (parent.stdin, parent.stdout, parent.stderr):
        if stream is not None:
            stream.close()


@pytest.mark.parametrize(
    ("loss", "mode"),
    [
        ("SIGTERM", "leader"),
        ("SIGTERM", "descendant"),
        ("SIGINT", "leader"),
        ("stdin", "leader"),
        ("stdout", "leader"),
    ],
)
def test_parent_termination_or_disconnect_kills_group_and_reaps_leader(tmp_path, loss, mode):
    child_script = tmp_path / "pipe-holder.py"
    child_script.write_text(
        """import json, os, sys, time
from pathlib import Path
leader = os.getpid()
descendant = os.fork() if sys.argv[1] == 'descendant' else None
if descendant != 0:
    Path(sys.argv[2]).write_text(json.dumps({'leader': leader, 'descendant': descendant}))
    if descendant is not None:
        os._exit(0)
time.sleep(30)
"""
    )
    parent_script = tmp_path / "native-supervisor.py"
    parent_script.write_text(
        """import sys
from pathlib import Path
from loci_engine import research_tissue_integration as integration, research_process
class Project:
    root = Path(sys.argv[1])
    def job(self, identity):
        return {'operation': 'tissue_model_preview', 'state': 'queued',
                'cancel_requested': False, 'request': {'task_request': {}}}
    def update_job(self, *args, **kwargs):
        (self.root / 'cleanup-completed').write_text(kwargs['state'])
integration.accepted = lambda *args: {'working_bytes': 2 * 1024**3}
research_process.research_command = lambda args: [
    sys.executable, sys.argv[2], sys.argv[3], str(Project.root / 'pids.json')]
integration.run_disposable(Project(), 'fixture-job')
"""
    )
    parent = subprocess.Popen(
        [sys.executable, str(parent_script), str(tmp_path), str(child_script), mode],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    leader = None
    try:
        marker = tmp_path / "pids.json"
        wait_until(lambda: marker.exists() and marker.stat().st_size > 0)
        pids = json.loads(marker.read_text())
        leader = pids["leader"]
        assert live(pids["descendant"] or leader)
        if mode == "descendant":
            wait_until(lambda: not live(leader))
            assert live(pids["descendant"])
        if loss in {"SIGTERM", "SIGINT"}:
            parent.send_signal(getattr(signal, loss))
        else:
            getattr(parent, loss).close()
        parent.wait(timeout=3)
        assert parent.returncode != 0
        assert (tmp_path / "cleanup-completed").read_text() == "failed"
        # The supervisor directly owns and reaps this process even when its
        # leader exited earlier and only a descendant held the output pipes.
        assert not pid_exists(leader)
        if pids["descendant"]:
            wait_until(lambda: not live(pids["descendant"]), timeout=2)
    finally:
        cleanup(parent, leader)


def test_uncatchable_parent_loss_refuses_publication_at_next_guard(ready, tmp_path):
    job = submit_job(ready.wb, ready.request, "hard-parent-loss", "tissue_model_preview")
    child_script = tmp_path / "guarded-cli.py"
    child_script.write_text(
        """import os, sys, time
from pathlib import Path
from loci_engine import research_cli, research_tissue_integration as integration
from loci_engine import research_tissue_models as tissue
root = Path(__file__).parent
integration.store.resolve_approved_weights = lambda *args, **kwargs: object()
def compute(workbench, request, weights, check):
    (root / 'child.pid').write_text(str(os.getpid()))
    while not (root / 'release-kernel').exists():
        time.sleep(0.01)
    check()
    (root / 'forbidden-publication').write_text('parent guard was bypassed')
    raise RuntimeError('fixture must never reach publication')
tissue._compute = compute
raise SystemExit(research_cli.main(sys.argv[1:]))
"""
    )
    parent_script = tmp_path / "native-supervisor.py"
    parent_script.write_text(
        """import sys
from loci_engine import research_process
from loci_engine.research_project import ResearchProject
from loci_engine.research_tissue_integration import run_disposable
research_process.research_command = lambda args: [sys.executable, sys.argv[3], *args]
run_disposable(ResearchProject(sys.argv[1]), sys.argv[2])
"""
    )
    parent = subprocess.Popen(
        [sys.executable, str(parent_script), str(ready.project.root), job["id"], str(child_script)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    leader = None
    try:
        marker = tmp_path / "child.pid"
        wait_until(lambda: marker.exists() and marker.stat().st_size > 0)
        leader = int(marker.read_text())
        assert live(leader)
        parent.kill()  # SIGKILL deliberately cannot run supervisor finally.
        parent.wait(timeout=3)
        assert parent.returncode == -signal.SIGKILL
        assert live(leader)  # An in-progress kernel has a real residual resource tail.
        (tmp_path / "release-kernel").touch()
        wait_until(lambda: ready.project.job(job["id"])["state"] == "failed")
        wait_until(lambda: not live(leader))
        assert not (tmp_path / "forbidden-publication").exists()
        assert ready.project.job(job["id"])["result_ids"] == []
        assert ready.project.list_results() == []
    finally:
        (tmp_path / "release-kernel").touch()
        cleanup(parent, leader)
