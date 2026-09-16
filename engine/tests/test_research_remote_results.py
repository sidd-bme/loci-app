from __future__ import annotations

import hashlib
import io
import json
import stat
import sys
import types
import zipfile
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine.cellpose_backend import CELLPOSE_PACKAGE_VERSION, resolve_cellpose_model_spec
from loci_engine.models import CellposeSettings
from loci_engine.remote_compute import (
    OutputEntry,
    RemoteJobIdentity,
    RemoteRecipeTask,
    RemoteSource,
    RemoteWorkerRequest,
    ResourceRequest,
    VerifiedOutputManifest,
    verify_output_manifest,
)
from loci_engine.remote_worker import run_manifest
from loci_engine.research_project import ResearchProject
from loci_engine.research_remote_results import RemoteResultsError, attach_remote_results
from loci_engine.workbench import Workbench

KEY = "a" * 32
REMOTE_PROJECT = "b" * 32
REMOTE_SOURCE = "c" * 32
TASK = "d" * 32


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _marker(root: Path, request_sha256: str) -> None:
    (root / ".loci-owned.json").write_bytes(
        _canonical(
            {
                "schema": "loci.remote-run/v1",
                "request_key": KEY,
                "request_sha256": request_sha256,
            }
        )
    )


def _publication(
    tmp_path: Path,
    *,
    tasks: int = 1,
    cellpose: bool = False,
    cellpose_working_bytes: int = 8 * 1024 * 1024,
) -> tuple[bytes, Path, VerifiedOutputManifest, Path]:
    staging = tmp_path / "remote" / ".loci-runs" / KEY
    output = tmp_path / "published" / ".loci-runs" / KEY
    (staging / "inputs").mkdir(parents=True)
    output.mkdir(parents=True)
    source = tmp_path / "same-source.ome.tif"
    image = np.zeros((16, 16), dtype=np.uint16)
    image[2:5, 2:5] = 100
    image[10:13, 10:13] = 200
    tifffile.imwrite(source, image, ome=True, metadata={"axes": "YX"})
    staged = staging / "inputs" / source.name
    staged.write_bytes(source.read_bytes())
    digest = hashlib.sha256(staged.read_bytes()).hexdigest()
    task = {
        "task_id": TASK,
        "operation": "run_recipe",
        "source_id": REMOTE_SOURCE,
        "selection": {
            "x": 0,
            "y": 0,
            "width": 16,
            "height": 16,
            "t": 0,
            "c": 0,
            "z": 0,
            "level": 0,
        },
        "recipe": {
            "steps": [],
            "segmentation": {"method": "components", "threshold": 50},
            "measurement_channels": [0],
            "gates": [],
            "working_bytes": 8 * 1024 * 1024,
        },
    }
    task_records = [{**task, "task_id": f"{index + 13:032x}"} for index in range(tasks)]
    if tasks == 1:
        task_records[0]["task_id"] = TASK
    resources = {"cpus": 1, "memory_mb": 256, "wall_minutes": 5, "gpus": 0}
    schema = "loci.remote-worker-request/v1"
    if cellpose:
        if tasks != 1:
            raise ValueError("Cellpose publication fixture supports exactly one task")
        spec = resolve_cellpose_model_spec("cellpose-sam-v2")
        schema = "loci.remote-worker-request/v2"
        resources["gpus"] = 1
        resources["memory_mb"] = max(256, cellpose_working_bytes // 1024**2)
        task_records = [
            {
                "task_id": TASK,
                "operation": "run_cellpose",
                "source_id": REMOTE_SOURCE,
                "selection": task["selection"],
                "cellpose": {
                    "profile_id": spec.profile_id,
                    "package_version": CELLPOSE_PACKAGE_VERSION,
                    "artifact_id": spec.artifact_id,
                    "model_sha256": spec.sha256,
                    "model_size_bytes": spec.size_bytes,
                    "requested_device": "cuda",
                    "allow_cpu_fallback": False,
                    "rights_basis": "noncommercial-research",
                    "settings": CellposeSettings(device="cuda").to_dict(),
                    "measurement_channels": [0],
                    "gates": [],
                    "working_bytes": cellpose_working_bytes,
                },
            }
        ]
    request = {
        "schema": schema,
        "request_key": KEY,
        "project_id": REMOTE_PROJECT,
        "output_root": str(output),
        "resources": resources,
        "sources": [
            {
                "source_id": REMOTE_SOURCE,
                "path": f"inputs/{source.name}",
                "sha256": digest,
                "size_bytes": staged.stat().st_size,
            }
        ],
        "tasks": task_records,
    }
    encoded = _canonical(request)
    request_path = staging / "request.json"
    request_path.write_bytes(encoded)
    request_sha = hashlib.sha256(encoded).hexdigest()
    _marker(staging, request_sha)
    _marker(output, request_sha)
    manifest_record = run_manifest(request_path)
    identity = RemoteJobIdentity(KEY, request_sha, "direct", None, "succeeded")
    manifest = verify_output_manifest(_canonical(manifest_record).decode(), identity)
    return encoded, output / "results.zip", manifest, source


def _install_fake_cellpose(monkeypatch: pytest.MonkeyPatch) -> None:
    from loci_engine import cellpose_backend

    spec = resolve_cellpose_model_spec("cellpose-sam-v2")
    monkeypatch.setattr(
        cellpose_backend,
        "get_cellpose_status",
        lambda _profile: types.SimpleNamespace(
            ready=True,
            installed_version=CELLPOSE_PACKAGE_VERSION,
            model_verified=True,
            model_spec=spec,
        ),
    )
    labels = np.zeros((16, 16), dtype=np.int32)
    labels[2:5, 2:5] = 1
    monkeypatch.setattr(
        cellpose_backend,
        "segment_cellpose",
        lambda _image, _settings, _profile: types.SimpleNamespace(
            output=types.SimpleNamespace(
                labels=labels,
                normalized=np.zeros((16, 16), dtype=np.float64),
                count=1,
            ),
            runtime={
                "package": {"name": "cellpose", "version": CELLPOSE_PACKAGE_VERSION},
                "model": {"artifact_id": spec.artifact_id, "sha256": spec.sha256},
                "profile_id": spec.profile_id,
                "preprocessing_mode": "dynamic-range-preserving",
                "requested_device": "cuda",
                "resolved_device": "cuda",
                "fallback_reason": None,
                "memory_preflight": {"device": "cuda", "available_bytes": 8 * 1024**3},
                "inference_scale": 1.0,
            },
        ),
    )
    fake_torch = types.ModuleType("torch")
    fake_torch.__version__ = "2.9.0"  # type: ignore[attr-defined]
    fake_torch.version = types.SimpleNamespace(cuda="12.8")  # type: ignore[attr-defined]
    fake_torch.backends = types.SimpleNamespace(  # type: ignore[attr-defined]
        cudnn=types.SimpleNamespace(version=lambda: 91002)
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


def _local_project(tmp_path: Path, source: Path) -> tuple[ResearchProject, str]:
    project = ResearchProject.create(tmp_path / "local.loci-study", "Local")
    workbench = Workbench(project)
    try:
        local = workbench.import_native(str(source), name="Local exact source")
    finally:
        workbench.close()
    return project, local["id"]


def _manifest_for(path: Path, request_sha256: str) -> VerifiedOutputManifest:
    encoded = path.read_bytes()
    return VerifiedOutputManifest(
        KEY,
        request_sha256,
        (
            OutputEntry(
                "results.zip", hashlib.sha256(encoded).hexdigest(), len(encoded), "application/zip"
            ),
        ),
    )


def _copy_with_extra_member(source: Path, destination: Path, name: str, data: bytes) -> None:
    with (
        zipfile.ZipFile(source, "r") as incoming,
        zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as outgoing,
    ):
        for info in incoming.infolist()[:-1]:
            outgoing.writestr(info, incoming.read(info.filename))
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.create_system = 3
        info.external_attr = (0o100600) << 16
        outgoing.writestr(info, data)
        archive_info = incoming.infolist()[-1]
        outgoing.writestr(archive_info, incoming.read("archive.json"))


def _write_archive(destination: Path, members: dict[str, bytes], archive_record: dict) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            archive.writestr(info, members[name])
        info = zipfile.ZipInfo("archive.json", date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o600) << 16
        archive.writestr(info, _canonical(archive_record))


def _mutate_task_archive(source: Path, destination: Path, mutate, *, task_id: str = TASK) -> None:
    with zipfile.ZipFile(source, "r") as archive:
        archive_record = json.loads(archive.read("archive.json"))
        members = {
            info.filename: archive.read(info.filename)
            for info in archive.infolist()
            if info.filename != "archive.json"
        }
    path = f"results/{task_id}/result.json"
    record = json.loads(members[path])
    mutate(record, members)
    members[path] = _canonical(record)
    for entry in archive_record["members"]:
        if entry["path"] in members:
            encoded = members[entry["path"]]
            entry["sha256"] = hashlib.sha256(encoded).hexdigest()
            entry["size_bytes"] = len(encoded)
    _write_archive(destination, members, archive_record)


def _rehash_result(record: dict) -> None:
    result = record["result"]
    original = {
        "id": result["id"],
        "schema": result["schema"],
        "source_id": result["source_id"],
        "source_sha256": result["source_sha256"],
        "kind": result["kind"],
        "parent_id": result["parent_id"],
        "created_at": result["created_at"],
        "engine_version": result["engine_version"],
        "arrays": {
            name: {
                "sha256": value["sha256"],
                "bytes": value["size_bytes"],
                "shape": value["shape"],
                "dtype": value["dtype"],
            }
            for name, value in result["arrays"].items()
        },
        "provenance": result["provenance"],
    }
    result["revision_hash"] = hashlib.sha256(_canonical(original)).hexdigest()
    original["revision_hash"] = result["revision_hash"]
    result["record_sha256"] = hashlib.sha256(_canonical(original)).hexdigest()


def test_attach_rebases_ids_preserves_remote_provenance_and_deduplicates(tmp_path: Path) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)

    receipt = attach_remote_results(
        project,
        request,
        archive,
        expected_archive_sha256=manifest.entries[0].sha256,
        outer_manifest=manifest,
        local_source_mapping={REMOTE_SOURCE: local_source_id},
    )

    assert receipt["remote_review_state"] == "unreviewed"
    assert receipt["local_review_receipts_created"] is False
    result = project.result(receipt["task_results"][0]["local_result_id"])
    remote = result["provenance"]["remote_attachment"]
    assert result["source_id"] == local_source_id
    assert result["id"] != remote["remote_result_id"]
    assert result["revision_hash"] != remote["remote_result_revision_hash"]
    assert project.review_state(result["id"]) is None
    assert set(result["arrays"]) == {"image", "labels"}
    assert (
        attach_remote_results(
            project,
            request,
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )
        == receipt
    )
    assert project.summary()["counts"]["results"] == 1


def test_attach_cellpose_preserves_runtime_rights_and_remeasures_locally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_cellpose(monkeypatch)
    request, archive, manifest, source = _publication(tmp_path, cellpose=True)
    project, local_source_id = _local_project(tmp_path, source)

    receipt = attach_remote_results(
        project,
        request,
        archive,
        expected_archive_sha256=manifest.entries[0].sha256,
        outer_manifest=manifest,
        local_source_mapping={REMOTE_SOURCE: local_source_id},
    )

    result = project.result(receipt["task_results"][0]["local_result_id"])
    assert result["kind"] == "cellpose-segmentation"
    assert result["provenance"]["runtime"]["cellpose"]["resolved_device"] == "cuda"
    assert result["provenance"]["runtime"]["cuda_runtime"] == "12.8"
    assert result["provenance"]["rights"]["basis"] == "noncommercial-research"
    assert result["provenance"]["measurements"][0]["label"] == 1
    assert project.review_state(result["id"]) is None


def test_attach_bounds_source_loading_below_cellpose_task_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_cellpose(monkeypatch)
    request, archive, manifest, source = _publication(
        tmp_path,
        cellpose=True,
        cellpose_working_bytes=2 * 1024**3,
    )
    project, local_source_id = _local_project(tmp_path, source)

    receipt = attach_remote_results(
        project,
        request,
        archive,
        expected_archive_sha256=manifest.entries[0].sha256,
        outer_manifest=manifest,
        local_source_mapping={REMOTE_SOURCE: local_source_id},
    )

    assert receipt["task_results"][0]["local_result_id"]
    assert project.summary()["counts"]["results"] == 1


def test_attach_requires_original_bytes_and_atomically_completes_running_job(
    tmp_path: Path,
) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    document = json.loads(request)
    source_value = document["sources"][0]
    task_value = document["tasks"][0]
    typed = RemoteWorkerRequest(
        document["request_key"],
        document["project_id"],
        ResourceRequest(**document["resources"]),
        (
            RemoteSource(
                source_value["source_id"],
                source_value["path"],
                source_value["sha256"],
                source_value["size_bytes"],
            ),
        ),
        (
            RemoteRecipeTask(
                task_value["task_id"],
                task_value["source_id"],
                task_value["selection"],
                task_value["recipe"],
            ),
        ),
    )
    project, local_source_id = _local_project(tmp_path, source)
    job = project.submit("remote-results", {"source_id": local_source_id}, "typed-remote-test")
    project.update_job(job["id"], expected_state="queued", state="running", max_running=1)

    with pytest.raises(RemoteResultsError, match="exact original canonical request bytes"):
        attach_remote_results(
            project,
            typed,  # type: ignore[arg-type]
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
            local_job_id=job["id"],
        )
    assert project.summary()["counts"]["results"] == 0
    assert project.job(job["id"])["state"] == "running"

    receipt = attach_remote_results(
        project,
        request,
        archive,
        expected_archive_sha256=manifest.entries[0].sha256,
        outer_manifest=manifest,
        local_source_mapping={REMOTE_SOURCE: local_source_id},
        local_job_id=job["id"],
    )

    updated = project.job(job["id"])
    assert updated["state"] == "succeeded"
    assert updated["result_ids"] == [receipt["task_results"][0]["local_result_id"]]

    with pytest.raises(RemoteResultsError, match="other inputs"):
        attach_remote_results(
            project,
            request,
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
            local_job_id=None,
        )


@pytest.mark.parametrize("name", ["../escape.npy", "/absolute.npy", "results//bad.npy"])
def test_attach_rejects_unsafe_or_unexpected_archive_members(tmp_path: Path, name: str) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    malicious = tmp_path / "malicious.zip"
    _copy_with_extra_member(archive, malicious, name, b"payload")
    changed = _manifest_for(malicious, manifest.request_sha256)

    with pytest.raises(RemoteResultsError):
        attach_remote_results(
            project,
            request,
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


@pytest.mark.parametrize("failure", ["duplicate", "symlink", "compressed"])
def test_attach_rejects_duplicate_link_or_compressed_members(tmp_path: Path, failure: str) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    malicious = tmp_path / f"{failure}.zip"
    with (
        zipfile.ZipFile(archive, "r") as incoming,
        zipfile.ZipFile(malicious, "w", compression=zipfile.ZIP_STORED) as outgoing,
    ):
        infos = incoming.infolist()
        for index, original in enumerate(infos):
            info = zipfile.ZipInfo(original.filename, date_time=original.date_time)
            info.compress_type = (
                zipfile.ZIP_DEFLATED
                if failure == "compressed" and index == 0
                else zipfile.ZIP_STORED
            )
            info.create_system = 3
            info.external_attr = (
                (stat.S_IFLNK | 0o777) << 16
                if failure == "symlink" and index == 0
                else (stat.S_IFREG | 0o600) << 16
            )
            outgoing.writestr(info, incoming.read(original.filename))
            if failure == "duplicate" and index == 0:
                outgoing.writestr(info, incoming.read(original.filename))
    changed = _manifest_for(malicious, manifest.request_sha256)

    with pytest.raises(RemoteResultsError):
        attach_remote_results(
            project,
            request,
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


@pytest.mark.parametrize("failure", ["grid", "review", "revision"])
def test_attach_rejects_task_contract_tampering(tmp_path: Path, failure: str) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    malicious = tmp_path / f"task-{failure}.zip"

    def mutate(record: dict, _members: dict[str, bytes]) -> None:
        if failure == "grid":
            record["result"]["provenance"]["selection"]["x"] = 1
        elif failure == "review":
            record["review"] = {"state": "reviewed", "receipt": {"actor": "remote"}}
        else:
            record["result"]["revision_hash"] = "0" * 64

    _mutate_task_archive(archive, malicious, mutate)
    changed = _manifest_for(malicious, manifest.request_sha256)

    with pytest.raises(RemoteResultsError):
        attach_remote_results(
            project,
            request,
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


def test_attach_rejects_hash_consistent_nonfinite_array(tmp_path: Path) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    malicious = tmp_path / "nan.zip"

    def mutate(record: dict, members: dict[str, bytes]) -> None:
        result = record["result"]
        descriptor = result["arrays"]["image"]
        array = np.load(io.BytesIO(members[descriptor["path"]]), allow_pickle=False)
        array = array.astype(np.float64)
        array.flat[0] = np.nan
        stream = io.BytesIO()
        np.save(stream, array, allow_pickle=False)
        encoded = stream.getvalue()
        members[descriptor["path"]] = encoded
        descriptor["sha256"] = hashlib.sha256(encoded).hexdigest()
        descriptor["size_bytes"] = len(encoded)
        _rehash_result(record)

    _mutate_task_archive(archive, malicious, mutate)
    changed = _manifest_for(malicious, manifest.request_sha256)

    with pytest.raises(RemoteResultsError, match="numeric"):
        attach_remote_results(
            project,
            request,
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


def test_attach_rejects_hash_consistent_forged_measurements(tmp_path: Path) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    malicious = tmp_path / "forged-measurement.zip"

    def mutate(record: dict, _members: dict[str, bytes]) -> None:
        record["result"]["provenance"]["measurements"][0]["label"] = 999
        _rehash_result(record)

    _mutate_task_archive(archive, malicious, mutate)
    changed = _manifest_for(malicious, manifest.request_sha256)

    with pytest.raises(RemoteResultsError, match="measurements disagree"):
        attach_remote_results(
            project,
            request,
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


def test_attach_rejects_tiny_npy_with_huge_declared_header_before_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    malicious = tmp_path / "huge-header.zip"

    def mutate(record: dict, members: dict[str, bytes]) -> None:
        descriptor = record["result"]["arrays"]["image"]
        stream = io.BytesIO()
        stream.write(np.lib.format.magic(1, 0))
        np.lib.format.write_array_header_1_0(
            stream,
            {"descr": "<f8", "fortran_order": False, "shape": (10**9, 10**9)},
        )
        encoded = stream.getvalue()
        members[descriptor["path"]] = encoded
        descriptor["sha256"] = hashlib.sha256(encoded).hexdigest()
        descriptor["size_bytes"] = len(encoded)
        _rehash_result(record)

    _mutate_task_archive(archive, malicious, mutate)
    changed = _manifest_for(malicious, manifest.request_sha256)

    def forbidden_load(*_args, **_kwargs):
        raise AssertionError("np.load must not run before the bounded header check")

    monkeypatch.setattr(np, "load", forbidden_load)

    with pytest.raises(RemoteResultsError, match="NPY header"):
        attach_remote_results(
            project,
            request,
            malicious,
            expected_archive_sha256=changed.entries[0].sha256,
            outer_manifest=changed,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


def test_attach_retry_revalidates_referenced_array_bytes(tmp_path: Path) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    receipt = attach_remote_results(
        project,
        request,
        archive,
        expected_archive_sha256=manifest.entries[0].sha256,
        outer_manifest=manifest,
        local_source_mapping={REMOTE_SOURCE: local_source_id},
    )
    result = project.result(receipt["task_results"][0]["local_result_id"])
    artifact = project.arrays / f"{result['arrays']['image']['sha256']}.npy"
    artifact.write_bytes(artifact.read_bytes() + b"corrupt")

    with pytest.raises(RemoteResultsError, match="array failed verification"):
        attach_remote_results(
            project,
            request,
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )


def test_attach_rechecks_staged_artifact_inside_publication_transaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    original = project.store_array
    staged: list[dict] = []

    def corrupt_after_staging(array: np.ndarray) -> dict:
        descriptor = original(array)
        staged.append(descriptor)
        if len(staged) == 2:
            path = project.arrays / f"{staged[0]['sha256']}.npy"
            path.write_bytes(path.read_bytes() + b"changed-after-staging")
        return descriptor

    monkeypatch.setattr(project, "store_array", corrupt_after_staging)

    with pytest.raises(RemoteResultsError, match="staged local array changed"):
        attach_remote_results(
            project,
            request,
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


def test_attach_rejects_source_changed_after_remote_execution(tmp_path: Path) -> None:
    request, archive, manifest, source = _publication(tmp_path)
    project, local_source_id = _local_project(tmp_path, source)
    source.write_bytes(source.read_bytes() + b"changed")

    with pytest.raises(RemoteResultsError, match="source"):
        attach_remote_results(
            project,
            request,
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
        )

    assert project.summary()["counts"]["results"] == 0


def test_attach_rejects_cancelled_local_job_without_partial_results(tmp_path: Path) -> None:
    request, archive, manifest, source = _publication(tmp_path, tasks=2)
    project, local_source_id = _local_project(tmp_path, source)
    job = project.submit("remote-results", {"source_id": local_source_id}, "remote-test")
    project.update_job(job["id"], expected_state="queued", state="cancelled")

    with pytest.raises(RemoteResultsError, match="cancelled|stopped"):
        attach_remote_results(
            project,
            request,
            archive,
            expected_archive_sha256=manifest.entries[0].sha256,
            outer_manifest=manifest,
            local_source_mapping={REMOTE_SOURCE: local_source_id},
            local_job_id=job["id"],
        )

    assert project.summary()["counts"]["results"] == 0
