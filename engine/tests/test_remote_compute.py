from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

import loci_engine.remote_compute as remote_module
from loci_engine.cellpose_backend import CELLPOSE_PACKAGE_VERSION, resolve_cellpose_model_spec
from loci_engine.models import CellposeSettings
from loci_engine.remote_compute import (
    CommandResult,
    ConnectionProfile,
    ConnectionReceipt,
    RemoteCellposeTask,
    RemoteComputeClient,
    RemoteComputeError,
    RemoteJobIdentity,
    RemoteRecipeTask,
    RemoteRequest,
    RemoteSource,
    RemoteWorkerRequest,
    ResourceRequest,
    StageEntry,
    StagingManifest,
    SubprocessRunner,
    verify_output_manifest,
)

FINGERPRINT = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
KEY = "a" * 32
PROJECT_ID = "b" * 32
REQUEST_SHA = "c" * 64


class FakeRunner:
    def __init__(
        self,
        results: Sequence[CommandResult] = (),
        callback: Callable[[list[str], bytes | None], CommandResult] | None = None,
    ) -> None:
        self.results = list(results)
        self.callback = callback
        self.calls: list[tuple[list[str], bytes | None, int, int]] = []

    def run(
        self,
        arguments: Sequence[str],
        *,
        input_bytes: bytes | None = None,
        timeout_seconds: int = 30,
        output_limit: int = remote_module.MAX_COMMAND_OUTPUT_BYTES,
    ) -> CommandResult:
        call = (list(arguments), input_bytes, timeout_seconds, output_limit)
        self.calls.append(call)
        if self.callback is not None:
            return self.callback(call[0], input_bytes)
        return self.results.pop(0) if self.results else CommandResult(0, "", "")


def _profile(
    tmp_path: Path,
    scheduler: str = "pbspro",
    **overrides: object,
) -> ConnectionProfile:
    known_hosts = tmp_path / f"known-hosts-{scheduler}"
    known_hosts.write_text("vanda ssh-ed25519 AAAA\n")
    values: dict[str, object] = {
        "alias": "vanda",
        "known_host": "vanda.cluster.example",
        "known_hosts_file": known_hosts,
        "host_key_sha256": FINGERPRINT,
        "runtime_python": "/home/user/miniconda3/bin/python3",
        "remote_project_root": "/home/user/loci-projects",
        "remote_output_root": "/scratch/user/loci-outputs",
        "scheduler": scheduler,
        "scheduler_bin_dir": "/opt/pbs/bin" if scheduler.startswith("pbs") else None,
    }
    values.update(overrides)
    return ConnectionProfile(**values)  # type: ignore[arg-type]


def _request(resources: ResourceRequest | None = None) -> RemoteRequest:
    return RemoteRequest(KEY, REQUEST_SHA, PROJECT_ID, resources or ResourceRequest())


def _ready_client(profile: ConnectionProfile, runner: FakeRunner) -> RemoteComputeClient:
    client = RemoteComputeClient(profile, runner)
    client._connection_receipt = ConnectionReceipt(
        profile.alias,
        profile.host_key_sha256,
        "Linux",
        "Python 3.13.12",
        profile.scheduler,
        "fixture scheduler",
    )
    return client


def _submitted(scheduler: str = "pbspro", job_id: str = "123.server") -> RemoteJobIdentity:
    return RemoteJobIdentity(KEY, REQUEST_SHA, scheduler, job_id, "submitted")


def _remote_arguments(call: tuple[list[str], bytes | None, int, int]) -> list[str]:
    assert call[0][0] == "ssh"
    return shlex.split(call[0][-1])


def test_connection_discovery_pins_known_host_and_uses_fixed_pbs_probes(
    tmp_path: Path,
) -> None:
    runner = FakeRunner(
        (
            CommandResult(
                0,
                "hostname vanda.cluster.example\nport 22\nhostkeyalias none\n",
                "",
            ),
            CommandResult(0, f"256 {FINGERPRINT} vanda (ED25519)\n", ""),
            CommandResult(0, "Linux\n", ""),
            CommandResult(0, "Python 3.12.4\n", ""),
            CommandResult(0, "pbs_version = 2024.1.3\n", ""),
            CommandResult(0, "", ""),
            CommandResult(0, "", ""),
        )
    )
    profile = _profile(tmp_path)
    receipt = RemoteComputeClient(profile, runner).discover()

    assert receipt.host_key_sha256 == FINGERPRINT
    assert receipt.operating_system == "Linux"
    assert receipt.scheduler == "pbspro"
    assert runner.calls[0][0] == ["ssh", "-G", "--", "vanda"]
    assert runner.calls[1][0] == [
        "ssh-keygen",
        "-F",
        "vanda.cluster.example",
        "-f",
        str(profile.known_hosts_file),
        "-l",
        "-E",
        "sha256",
    ]
    ssh = runner.calls[2][0]
    assert "BatchMode=yes" in ssh
    assert "StrictHostKeyChecking=yes" in ssh
    assert f"UserKnownHostsFile={profile.known_hosts_file}" in ssh
    assert _remote_arguments(runner.calls[2]) == ["uname", "-s"]
    assert _remote_arguments(runner.calls[4]) == ["/opt/pbs/bin/qstat", "--version"]
    assert _remote_arguments(runner.calls[5]) == [
        "test",
        "-d",
        profile.remote_project_root,
    ]


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("alias", "vanda;touch /tmp/x"),
        ("known_host", "vanda $(id)"),
        ("runtime_python", "/home/user/python;id"),
        ("remote_project_root", "/home/user/../root"),
        ("remote_output_root", "/"),
        ("queue", "gpu;id"),
        ("account", "$(id)"),
    ),
)
def test_connection_profile_rejects_shell_and_path_injection(
    tmp_path: Path, field: str, value: str
) -> None:
    with pytest.raises(ValueError):
        RemoteComputeClient(_profile(tmp_path, **{field: value}))


def test_resource_and_request_contracts_reject_invalid_values(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="cpus"):
        _request(ResourceRequest(cpus=0)).validate()
    with pytest.raises(ValueError, match="gpus"):
        _request(ResourceRequest(gpus=17)).validate()
    with pytest.raises(ValueError, match="request_key"):
        RemoteRequest("bad;key", REQUEST_SHA, PROJECT_ID, ResourceRequest()).validate()
    with pytest.raises(ValueError, match="separate trees"):
        RemoteComputeClient(
            _profile(tmp_path, remote_output_root="/home/user/loci-projects/output")
        )


def _worker_request() -> RemoteWorkerRequest:
    source = RemoteSource("d" * 32, "inputs/image.ome.tif", "e" * 64, 1234)
    task = RemoteRecipeTask(
        "f" * 32,
        source.source_id,
        {
            "x": 2,
            "y": 3,
            "width": 40,
            "height": 30,
            "t": 1,
            "c": 2,
            "z": 4,
            "z_stop": 7,
            "level": 0,
        },
        {
            "steps": [],
            "segmentation": {"method": "components", "threshold": 12.5},
            "measurement_channels": [0, 2],
            "gates": [],
            "working_bytes": 64 * 1024 * 1024,
        },
    )
    return RemoteWorkerRequest(KEY, PROJECT_ID, ResourceRequest(cpus=2), (source,), (task,))


def _cellpose_task(*, device: str = "cuda", allow_fallback: bool = False) -> RemoteCellposeTask:
    spec = resolve_cellpose_model_spec("cellpose-sam-v2")
    settings = CellposeSettings(device=device).to_dict()
    return RemoteCellposeTask(
        "1" * 32,
        "d" * 32,
        {"x": 0, "y": 0, "width": 40, "height": 30, "t": 0, "c": 0, "z": 0, "level": 0},
        {
            "profile_id": spec.profile_id,
            "package_version": CELLPOSE_PACKAGE_VERSION,
            "artifact_id": spec.artifact_id,
            "model_sha256": spec.sha256,
            "model_size_bytes": spec.size_bytes,
            "requested_device": device,
            "allow_cpu_fallback": allow_fallback,
            "rights_basis": "noncommercial-research",
            "settings": settings,
            "measurement_channels": [0],
            "gates": [],
            "working_bytes": 64 * 1024 * 1024,
        },
    )


def test_worker_request_is_canonical_hash_bound_and_uses_only_run_recipe(
    tmp_path: Path,
) -> None:
    request, encoded = _worker_request().encode(_profile(tmp_path))
    document = json.loads(encoded)

    assert request.request_sha256 == hashlib.sha256(encoded).hexdigest()
    assert document["schema"] == "loci.remote-worker-request/v1"
    assert document["request_key"] == KEY
    assert document["output_root"] == f"/scratch/user/loci-outputs/.loci-runs/{KEY}"
    assert document["tasks"][0]["operation"] == "run_recipe"
    assert document["tasks"][0]["selection"]["z_stop"] == 7
    assert (
        json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        == encoded
    )


def test_worker_request_v2_binds_exact_cellpose_identity_and_gpu(tmp_path: Path) -> None:
    source = RemoteSource("d" * 32, "inputs/image.ome.tif", "e" * 64, 1234)
    task = _cellpose_task()
    request, encoded = RemoteWorkerRequest(
        KEY, PROJECT_ID, ResourceRequest(cpus=4, gpus=1), (source,), (task,)
    ).encode(_profile(tmp_path))
    document = json.loads(encoded)

    assert request.request_sha256 == hashlib.sha256(encoded).hexdigest()
    assert document["schema"] == "loci.remote-worker-request/v2"
    assert document["tasks"][0]["operation"] == "run_cellpose"
    assert document["tasks"][0]["cellpose"] == task.cellpose
    assert "recipe" not in document["tasks"][0]


def test_worker_request_rejects_unbound_gpu_and_mismatched_cellpose_device(
    tmp_path: Path,
) -> None:
    source = RemoteSource("d" * 32, "inputs/image.ome.tif", "e" * 64, 1234)
    task = _cellpose_task()
    with pytest.raises(ValueError, match="requires at least one requested GPU"):
        RemoteWorkerRequest(KEY, PROJECT_ID, ResourceRequest(), (source,), (task,)).encode(
            _profile(tmp_path)
        )

    invalid = RemoteCellposeTask(
        task.task_id,
        task.source_id,
        task.selection,
        {**task.cellpose, "settings": CellposeSettings(device="cpu").to_dict()},
    )
    with pytest.raises(ValueError, match="settings.device"):
        invalid.validate()


def test_worker_request_binds_remote_resident_location_and_fingerprint(tmp_path: Path) -> None:
    valid = _worker_request()
    source = RemoteSource(
        valid.sources[0].source_id,
        "cohort/image.ome.tif",
        valid.sources[0].sha256,
        valid.sources[0].size_bytes,
        permitted_root="/data/lab/images",
    )
    _, encoded = RemoteWorkerRequest(
        valid.request_key, valid.project_id, valid.resources, (source,), valid.tasks
    ).encode(_profile(tmp_path, remote_input_roots=("/data/lab/images",)))

    assert json.loads(encoded)["sources"][0] == {
        "source_id": source.source_id,
        "path": "cohort/image.ome.tif",
        "permitted_root": "/data/lab/images",
        "sha256": source.sha256,
        "size_bytes": source.size_bytes,
    }


def test_worker_request_rejects_unknown_operations_sources_and_nonfinite_recipe(
    tmp_path: Path,
) -> None:
    valid = _worker_request()
    task = valid.tasks[0]
    unknown = RemoteRecipeTask(
        task.task_id,
        task.source_id,
        task.selection,
        task.recipe,
        operation="shell",  # type: ignore[arg-type]
    )
    with pytest.raises(ValueError, match="only the run_recipe"):
        RemoteWorkerRequest(KEY, PROJECT_ID, ResourceRequest(), valid.sources, (unknown,)).encode(
            _profile(tmp_path)
        )
    missing = RemoteRecipeTask(task.task_id, "0" * 32, task.selection, task.recipe)
    with pytest.raises(ValueError, match="undeclared source"):
        RemoteWorkerRequest(KEY, PROJECT_ID, ResourceRequest(), valid.sources, (missing,)).encode(
            _profile(tmp_path)
        )
    invalid_recipe = {**task.recipe, "steps": [{"sigma": float("nan")}]}
    with pytest.raises(ValueError, match="non-finite"):
        RemoteWorkerRequest(
            KEY,
            PROJECT_ID,
            ResourceRequest(),
            valid.sources,
            (RemoteRecipeTask(task.task_id, task.source_id, task.selection, invalid_recipe),),
        ).encode(_profile(tmp_path))


@pytest.mark.parametrize("scheduler", ["pbs", "pbspro", "slurm", "direct"])
def test_scheduler_scripts_use_only_fixed_worker_contract(tmp_path: Path, scheduler: str) -> None:
    batch = scheduler != "direct"
    profile = _profile(
        tmp_path,
        scheduler,
        scheduler_bin_dir="/opt/slurm/bin"
        if scheduler == "slurm"
        else ("/opt/pbs/bin" if scheduler.startswith("pbs") else None),
        queue="gpu" if batch else None,
        account="lab" if batch else None,
        pbs_gpu_resource="ngpus" if batch else None,
        allow_direct_compute=scheduler == "direct",
    )
    request = _request(ResourceRequest(cpus=4, memory_mb=8192, wall_minutes=125, gpus=1))
    script = RemoteComputeClient(profile, FakeRunner()).build_script(request).decode()

    assert (
        "exec /home/user/miniconda3/bin/python3 -m loci_engine.research_cli "
        "remote-worker --request "
    ) in script
    assert f"/.loci-runs/{KEY}/request.json" in script
    if scheduler != "direct":
        assert "02:05:00" in script
    if scheduler == "pbspro":
        assert "#PBS -l select=1:ncpus=4:mem=8192mb:ngpus=1" in script
    elif scheduler == "pbs":
        assert "#PBS -l nodes=1:ppn=4" in script
        assert "#PBS -l ngpus=1" in script
    elif scheduler == "slurm":
        assert "#SBATCH --cpus-per-task=4" in script
        assert "#SBATCH --gpus=1" in script
    else:
        assert "#PBS" not in script and "#SBATCH" not in script


def test_direct_submit_requires_explicit_non_login_compute_approval(tmp_path: Path) -> None:
    client = _ready_client(_profile(tmp_path, "direct"), FakeRunner())
    with pytest.raises(RemoteComputeError, match="non-login-node"):
        client.submit(_request())


def test_direct_submit_uses_separate_owned_log_root(tmp_path: Path) -> None:
    submitted = json.dumps(
        {
            "schema": "loci.remote-submit/v1",
            "request_key": KEY,
            "request_sha256": REQUEST_SHA,
            "scheduler": "direct",
            "state": "submitted",
            "remote_job_id": "123",
        }
    )
    runner = FakeRunner((CommandResult(0, submitted, ""),))
    profile = _profile(tmp_path, "direct", allow_direct_compute=True)
    client = _ready_client(profile, runner)

    identity = client.submit(_request())

    assert identity.remote_job_id == "123"
    command = _remote_arguments(runner.calls[0])
    script_index = command.index(remote_module._SUBMIT_SCRIPT)
    assert command[script_index + 1 : script_index + 3] == [
        profile.run_root(KEY),
        profile.output_root(KEY),
    ]


def test_direct_status_accepts_only_a_verified_manifest_after_process_exit(
    tmp_path: Path,
) -> None:
    manifest = json.dumps(
        {
            "schema": "loci.remote-output/v1",
            "request_key": KEY,
            "request_sha256": REQUEST_SHA,
            "outputs": [],
        }
    )
    runner = FakeRunner(
        (
            CommandResult(0, "BOUND\n", ""),
            CommandResult(1, "", ""),
            CommandResult(0, manifest, ""),
        )
    )
    client = _ready_client(
        _profile(tmp_path, "direct", allow_direct_compute=True), runner
    )

    status = client.status(_submitted("direct", "123"))

    assert status.state == "finished"
    assert "verified" in status.detail


def test_remote_mutation_requires_successful_connection_test(tmp_path: Path) -> None:
    runner = FakeRunner()
    client = RemoteComputeClient(_profile(tmp_path), runner)
    with pytest.raises(RemoteComputeError, match="test_connection"):
        client.reserve(_request())
    assert runner.calls == []


def test_setup_and_reservation_are_idempotent_and_refuse_unowned_runs(tmp_path: Path) -> None:
    project_root = tmp_path / "projects"
    output_root = tmp_path / "outputs"
    project_root.mkdir()
    output_root.mkdir()
    setup = [
        sys.executable,
        "-c",
        remote_module._SETUP_SCRIPT,
        str(project_root),
        str(output_root),
    ]
    reserve = [
        sys.executable,
        "-c",
        remote_module._RESERVE_SCRIPT,
        KEY,
        REQUEST_SHA,
        str(project_root),
        str(output_root),
    ]

    subprocess.run(setup, check=True)
    subprocess.run(setup, check=True)
    subprocess.run(reserve, check=True)
    subprocess.run(reserve, check=True)

    expected = {
        "schema": "loci.remote-run/v1",
        "request_key": KEY,
        "request_sha256": REQUEST_SHA,
    }
    for root in (project_root, output_root):
        marker = root / ".loci-runs" / KEY / ".loci-owned.json"
        assert json.loads(marker.read_text()) == expected

    other_key = "d" * 32
    unowned = project_root / ".loci-runs" / other_key
    unowned.mkdir()
    refused = subprocess.run(
        [
            sys.executable,
            "-c",
            remote_module._RESERVE_SCRIPT,
            other_key,
            REQUEST_SHA,
            str(project_root),
            str(output_root),
        ],
        check=False,
    )
    assert refused.returncode != 0
    assert not (unowned / ".loci-owned.json").exists()
    assert not (output_root / ".loci-runs" / other_key).exists()


def test_runtime_provisioning_uses_pinned_transport_and_offline_pip(tmp_path: Path) -> None:
    wheel = (tmp_path / "loci_engine-1.0.0-py3-none-any.whl").resolve()
    wheel.write_bytes(b"fixture wheel")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    runner = FakeRunner()
    client = _ready_client(_profile(tmp_path), runner)

    runtime = client.provision_runtime(wheel, digest)

    assert runtime == f"/home/user/loci-projects/.loci-runtime/{digest}/bin/python"
    setup = _remote_arguments(runner.calls[0])
    assert setup[:3] == [
        "/home/user/miniconda3/bin/python3",
        "-c",
        remote_module._RUNTIME_SETUP_SCRIPT,
    ]
    assert setup[-2:] == ["/home/user/loci-projects", digest]
    scp = runner.calls[1][0]
    assert scp[0] == "scp"
    assert "BatchMode=yes" in scp
    assert "StrictHostKeyChecking=yes" in scp
    assert f"UserKnownHostsFile={_profile(tmp_path).known_hosts_file}" in scp
    pip = _remote_arguments(runner.calls[4])
    assert pip == [
        runtime,
        "-m",
        "pip",
        "install",
        "--no-index",
        "--no-deps",
        f"/home/user/loci-projects/.loci-runtime/{digest}.whl",
    ]


def test_staging_verifies_local_identity_and_uses_fixed_remote_receiver(tmp_path: Path) -> None:
    source = tmp_path / "input.bin"
    source.write_bytes(b"scientific input")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    entry = StageEntry(source, "inputs/source.bin", digest, source.stat().st_size)
    manifest = StagingManifest(KEY, REQUEST_SHA, (entry,))
    runner = FakeRunner()
    client = _ready_client(_profile(tmp_path), runner)

    manifest_sha = client.stage(manifest)

    assert manifest_sha == hashlib.sha256(manifest.encoded()).hexdigest()
    scp = runner.calls[0][0]
    assert scp[0] == "scp" and "StrictHostKeyChecking=yes" in scp
    assert scp[-2] == str(source)
    assert scp[-1].startswith(f"vanda:/home/user/loci-projects/.loci-runs/{KEY}/")
    receiver = _remote_arguments(runner.calls[1])
    profile_python = _profile(tmp_path).runtime_python
    assert receiver[:3] == [profile_python, "-c", remote_module._RECEIVE_SCRIPT]
    assert receiver[-2:] == [KEY, REQUEST_SHA]
    assert runner.calls[-1][1] == manifest.encoded()
    assert profile_python == "/home/user/miniconda3/bin/python3"


def test_staging_rejects_symlinks_hash_changes_and_destination_traversal(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(b"a")
    link = tmp_path / "link"
    link.symlink_to(source)
    digest = hashlib.sha256(b"a").hexdigest()
    with pytest.raises(ValueError, match="plain local"):
        StageEntry(link, "input.bin", digest, 1).validate()
    with pytest.raises(ValueError, match="relative path|parent components"):
        StageEntry(source, "../escape", digest, 1).validate()
    bad = StagingManifest(KEY, REQUEST_SHA, (StageEntry(source, "input.bin", "d" * 64, 1),))
    with pytest.raises(RemoteComputeError, match="manifest identity"):
        _ready_client(_profile(tmp_path), FakeRunner()).stage(bad)


def test_atomic_remote_submit_reservation_runs_scheduler_once_after_retry(tmp_path: Path) -> None:
    root = tmp_path / "run"
    log_root = tmp_path / "output"
    root.mkdir()
    log_root.mkdir()
    for owned_root in (root, log_root):
        (owned_root / ".loci-owned.json").write_text(
            json.dumps(
                {
                    "schema": "loci.remote-run/v1",
                    "request_key": KEY,
                    "request_sha256": REQUEST_SHA,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    counter = tmp_path / "counter"
    fake_qsub = tmp_path / "qsub.py"
    fake_qsub.write_text(
        "from pathlib import Path\n"
        "import sys\n"
        "p=Path(sys.argv[1]); p.write_text(p.read_text()+'x' if p.exists() else 'x')\n"
        "print('123.server')\n"
    )
    command = [
        sys.executable,
        "-c",
        remote_module._SUBMIT_SCRIPT,
        str(root),
        str(log_root),
        KEY,
        REQUEST_SHA,
        "pbspro",
        sys.executable,
        str(fake_qsub),
        str(counter),
    ]

    first = subprocess.run(command, check=True, capture_output=True, text=True)
    second = subprocess.run(command, check=True, capture_output=True, text=True)

    assert json.loads(first.stdout)["remote_job_id"] == "123.server"
    assert json.loads(second.stdout)["remote_job_id"] == "123.server"
    assert counter.read_text() == "x"


def test_submit_reconnect_unknown_state_never_constructs_second_qsub(tmp_path: Path) -> None:
    submitting = json.dumps(
        {
            "schema": "loci.remote-submit/v1",
            "request_key": KEY,
            "request_sha256": REQUEST_SHA,
            "scheduler": "pbspro",
            "state": "submitting",
            "remote_job_id": None,
        }
    )
    runner = FakeRunner((CommandResult(0, submitting, ""), CommandResult(0, submitting, "")))
    client = _ready_client(_profile(tmp_path), runner)

    submitted = client.submit(_request())
    reconnected = client.reconnect(_request())

    assert submitted.state == "unknown" and reconnected.state == "unknown"
    reconnect_command = _remote_arguments(runner.calls[1])
    assert reconnect_command[:3] == [
        "/home/user/miniconda3/bin/python3",
        "-c",
        remote_module._READ_OWNED_FILE_SCRIPT,
    ]
    assert reconnect_command[3:5] == [
        f"/home/user/loci-projects/.loci-runs/{KEY}",
        "submit.json",
    ]


def test_pbs_and_slurm_status_and_cancel_use_exact_job_identity(tmp_path: Path) -> None:
    pbs_runner = FakeRunner(
        (
            CommandResult(0, "BOUND\n", ""),
            CommandResult(0, "job_state = R\n", ""),
            CommandResult(0, "BOUND\n", ""),
            CommandResult(0, "", ""),
        )
    )
    pbs = _ready_client(_profile(tmp_path, "pbspro"), pbs_runner)
    pbs_identity = _submitted()
    assert pbs.status(pbs_identity).state == "running"
    pbs.cancel(pbs_identity)
    assert remote_module._ASSERT_JOB_SCRIPT in _remote_arguments(pbs_runner.calls[0])
    assert _remote_arguments(pbs_runner.calls[1]) == [
        "/opt/pbs/bin/qstat",
        "-fx",
        "123.server",
    ]
    assert remote_module._ASSERT_JOB_SCRIPT in _remote_arguments(pbs_runner.calls[2])
    assert _remote_arguments(pbs_runner.calls[3]) == [
        "/opt/pbs/bin/qdel",
        "123.server",
    ]

    slurm_runner = FakeRunner(
        (
            CommandResult(0, "BOUND\n", ""),
            CommandResult(0, "", ""),
            CommandResult(0, "COMPLETED|\n", ""),
            CommandResult(0, "BOUND\n", ""),
            CommandResult(0, "", ""),
        )
    )
    slurm = _ready_client(
        _profile(tmp_path, "slurm", scheduler_bin_dir="/opt/slurm/bin"), slurm_runner
    )
    slurm_identity = _submitted("slurm", "456")
    assert slurm.status(slurm_identity).state == "finished"
    slurm.cancel(slurm_identity)
    assert _remote_arguments(slurm_runner.calls[2])[-1] == "--format=State"
    assert _remote_arguments(slurm_runner.calls[4]) == ["/opt/slurm/bin/scancel", "456"]


def test_cancel_rejects_job_id_not_bound_to_persisted_request(tmp_path: Path) -> None:
    runner = FakeRunner((CommandResult(56, "", "not bound"),))
    client = _ready_client(_profile(tmp_path), runner)

    with pytest.raises(RemoteComputeError, match="Remote command failed"):
        client.cancel(_submitted(job_id="999.other"))

    assert len(runner.calls) == 1
    assert remote_module._ASSERT_JOB_SCRIPT in _remote_arguments(runner.calls[0])


def test_direct_job_binding_rejects_a_reused_live_pid(tmp_path: Path) -> None:
    root = tmp_path / "run"
    root.mkdir()
    marker = {
        "schema": "loci.remote-run/v1",
        "request_key": KEY,
        "request_sha256": REQUEST_SHA,
    }
    (root / ".loci-owned.json").write_text(json.dumps(marker))
    (root / "submit.json").write_text(
        json.dumps(
            {
                "schema": "loci.remote-submit/v1",
                "request_key": KEY,
                "request_sha256": REQUEST_SHA,
                "scheduler": "direct",
                "state": "submitted",
                "remote_job_id": str(os.getpid()),
            }
        )
    )

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            remote_module._ASSERT_JOB_SCRIPT,
            str(root),
            KEY,
            REQUEST_SHA,
            "direct",
            str(os.getpid()),
            "1",
        ],
        check=False,
    )

    assert result.returncode != 0


def _output_manifest(path: str = "tables/results.csv") -> str:
    return json.dumps(
        {
            "schema": "loci.remote-output/v1",
            "request_key": KEY,
            "request_sha256": REQUEST_SHA,
            "outputs": [
                {
                    "path": path,
                    "sha256": hashlib.sha256(b"result").hexdigest(),
                    "size_bytes": 6,
                    "media_type": "text/csv",
                }
            ],
        }
    )


@pytest.mark.parametrize("path", ["../escape", "/absolute", "x;touch", "a//b"])
def test_output_manifest_rejects_unsafe_paths(path: str) -> None:
    with pytest.raises(RemoteComputeError, match="entry is invalid"):
        verify_output_manifest(_output_manifest(path), _submitted())


def test_output_manifest_is_request_bound_and_rejects_duplicate_json_keys() -> None:
    wrong = _output_manifest().replace(REQUEST_SHA, "d" * 64)
    with pytest.raises(RemoteComputeError, match="not bound"):
        verify_output_manifest(wrong, _submitted())
    duplicate = _output_manifest()[:-1] + ',"schema":"other"}'
    with pytest.raises(RemoteComputeError, match="duplicate keys"):
        verify_output_manifest(duplicate, _submitted())


def test_retrieve_verifies_remote_before_and_after_and_local_hash(tmp_path: Path) -> None:
    remote_bytes = b"result"
    manifest = _output_manifest()

    def callback(arguments: list[str], _input: bytes | None) -> CommandResult:
        if arguments[0] == "scp":
            Path(arguments[-1]).write_bytes(remote_bytes)
            return CommandResult(0, "", "")
        remote = shlex.split(arguments[-1])
        if remote_module._READ_OWNED_FILE_SCRIPT in remote:
            return CommandResult(0, manifest, "")
        return CommandResult(0, "VERIFIED\n", "")

    runner = FakeRunner(callback=callback)
    destination = tmp_path / "retrieved"
    paths = _ready_client(_profile(tmp_path), runner).retrieve_outputs(_submitted(), destination)

    assert paths == (destination / "tables/results.csv",)
    assert paths[0].read_bytes() == remote_bytes
    verifies = [
        call
        for call in runner.calls
        if call[0][0] == "ssh" and remote_module._VERIFY_OUTPUT_SCRIPT in _remote_arguments(call)
    ]
    assert len(verifies) == 2


def test_remote_output_symlink_fails_fixed_verifier(tmp_path: Path) -> None:
    root = tmp_path / "outputs"
    root.mkdir()
    marker = {
        "schema": "loci.remote-run/v1",
        "request_key": KEY,
        "request_sha256": REQUEST_SHA,
    }
    (root / ".loci-owned.json").write_text(json.dumps(marker))
    outside = tmp_path / "outside"
    outside.write_bytes(b"result")
    (root / "linked").symlink_to(outside)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            remote_module._VERIFY_OUTPUT_SCRIPT,
            str(root),
            "linked",
            hashlib.sha256(b"result").hexdigest(),
            "6",
            KEY,
            REQUEST_SHA,
        ],
        check=False,
    )
    assert result.returncode != 0


def test_cleanup_targets_only_exact_owned_run_roots(tmp_path: Path) -> None:
    def callback(arguments, _input):
        command = shlex.split(arguments[-1])
        if remote_module._CLEANUP_SCRIPT in command:
            return CommandResult(
                0,
                json.dumps(
                    {
                        "schema": "loci.remote-cleanup/v1",
                        "request_key": KEY,
                        "request_sha256": REQUEST_SHA,
                        "scheduler": "pbspro",
                        "remote_job_id": "123.server",
                        "owned_run_roots": 2,
                        "state": "cleaned",
                    }
                ),
                "",
            )
        return CommandResult(0, "BOUND\n", "")

    runner = FakeRunner(callback=callback)
    client = _ready_client(_profile(tmp_path), runner)
    receipt = client.cleanup(_submitted())
    command = _remote_arguments(runner.calls[0])
    assert receipt.state == "cleaned"
    assert command[-2:] == [
        f"/home/user/loci-projects/.loci-runs/{KEY}",
        f"/scratch/user/loci-outputs/.loci-runs/{KEY}",
    ]
    assert remote_module._CLEANUP_SCRIPT in command
    assert command[-3] == f"/home/user/loci-projects/.loci-cleanups/{KEY}.json"


def test_cleanup_script_persists_exact_idempotent_tombstone(tmp_path: Path) -> None:
    base = tmp_path / "project"
    receipts = base / ".loci-cleanups"
    receipts.mkdir(parents=True)
    roots = (base / ".loci-runs" / KEY, tmp_path / "output" / ".loci-runs" / KEY)
    marker = {
        "schema": "loci.remote-run/v1",
        "request_key": KEY,
        "request_sha256": REQUEST_SHA,
    }
    for root in roots:
        root.mkdir(parents=True)
        (root / ".loci-owned.json").write_text(json.dumps(marker))
        (root / "owned.txt").write_text("owned")
    (roots[0] / "submit.json").write_text(
        json.dumps(
            {
                "schema": "loci.remote-submit/v1",
                "request_key": KEY,
                "request_sha256": REQUEST_SHA,
                "scheduler": "pbspro",
                "state": "submitted",
                "remote_job_id": "123.server",
            }
        )
    )
    command = [
        sys.executable,
        "-c",
        remote_module._CLEANUP_SCRIPT,
        KEY,
        REQUEST_SHA,
        "pbspro",
        "123.server",
        str(receipts / f"{KEY}.json"),
        *(str(root) for root in roots),
    ]

    first = subprocess.run(command, check=False, capture_output=True, text=True)
    second = subprocess.run(command, check=False, capture_output=True, text=True)

    assert first.returncode == second.returncode == 0
    assert json.loads(first.stdout) == json.loads(second.stdout)
    assert json.loads(first.stdout)["state"] == "cleaned"
    assert not any(root.exists() for root in roots)


@pytest.mark.parametrize("invalid_marker", ["wrong", "symlink"])
def test_cleanup_refuses_invalid_marker_before_deleting_any_root(
    tmp_path: Path, invalid_marker: str
) -> None:
    roots = (tmp_path / "project-run", tmp_path / "output-run")
    receipts = tmp_path / ".loci-cleanups"
    receipts.mkdir()
    expected = {
        "schema": "loci.remote-run/v1",
        "request_key": KEY,
        "request_sha256": REQUEST_SHA,
    }
    for root in roots:
        root.mkdir()
        (root / ".loci-owned.json").write_text(json.dumps(expected))
        (root / "keep.txt").write_text("keep")
    invalid = roots[1] / ".loci-owned.json"
    invalid.unlink()
    if invalid_marker == "wrong":
        invalid.write_text(json.dumps({**expected, "request_sha256": "d" * 64}))
    else:
        outside = tmp_path / "outside-marker.json"
        outside.write_text(json.dumps(expected))
        invalid.symlink_to(outside)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            remote_module._CLEANUP_SCRIPT,
            KEY,
            REQUEST_SHA,
            "pbspro",
            "123.server",
            str(receipts / f"{KEY}.json"),
            *(str(root) for root in roots),
        ],
        check=False,
    )

    assert result.returncode != 0
    assert all(root.is_dir() and (root / "keep.txt").is_file() for root in roots)


def test_subprocess_runner_bounds_output() -> None:
    runner = SubprocessRunner()
    with pytest.raises(RemoteComputeError, match="more output"):
        runner.run(
            [sys.executable, "-c", "print('x'*100)"],
            output_limit=10,
        )


def test_output_manifest_fetch_uses_real_bounded_subprocess_capture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = json.dumps(
        {
            "schema": "loci.remote-output/v1",
            "request_key": KEY,
            "request_sha256": REQUEST_SHA,
            "outputs": [],
        }
    )
    transport = tmp_path / "transport.py"
    transport.write_text(f"print({manifest!r})\n")
    client = RemoteComputeClient(_profile(tmp_path), SubprocessRunner())
    client._connection_receipt = ConnectionReceipt(
        client.profile.alias,
        client.profile.host_key_sha256,
        "Linux",
        "Python 3.13.12",
        client.profile.scheduler,
        "fixture scheduler",
    )
    monkeypatch.setattr(
        client,
        "_ssh_prefix",
        lambda: [sys.executable, str(transport)],
    )

    assert client.fetch_output_manifest(_submitted()).entries == ()

    transport.write_text(
        "import sys\n"
        f"sys.stdout.write('x' * {remote_module.MAX_OUTPUT_MANIFEST_BYTES + 1})\n"
    )
    with pytest.raises(RemoteComputeError, match="more output than its bounded limit"):
        client.fetch_output_manifest(_submitted())


def test_output_manifest_verifier_enforces_transport_aligned_size_limit() -> None:
    oversized = json.dumps(
        {
            "schema": "loci.remote-output/v1",
            "request_key": KEY,
            "request_sha256": REQUEST_SHA,
            "outputs": [],
            "padding": "x" * remote_module.MAX_OUTPUT_MANIFEST_BYTES,
        }
    )

    with pytest.raises(RemoteComputeError, match="Output manifest exceeds the supported size"):
        verify_output_manifest(oversized, _submitted())
