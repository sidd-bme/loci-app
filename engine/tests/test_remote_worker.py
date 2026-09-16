from __future__ import annotations

import hashlib
import io
import json
import sys
import types
import zipfile
from pathlib import Path

import numpy as np
import pytest
import tifffile

import loci_engine.remote_worker as worker_module
from loci_engine.cellpose_backend import CELLPOSE_PACKAGE_VERSION, resolve_cellpose_model_spec
from loci_engine.models import CellposeSettings
from loci_engine.remote_compute import RemoteJobIdentity, verify_output_manifest
from loci_engine.remote_worker import RemoteWorkerError, run_manifest
from loci_engine.research_project import canonical_json

KEY = "a" * 32
PROJECT_ID = "b" * 32
SOURCE_ID = "c" * 32
TASK_ID = "d" * 32


def _canonical(document: dict[str, object]) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _write_marker(root: Path, digest: str) -> None:
    (root / ".loci-owned.json").write_bytes(
        _canonical(
            {
                "schema": "loci.remote-run/v1",
                "request_key": KEY,
                "request_sha256": digest,
            }
        )
    )


def _fixture(tmp_path: Path) -> tuple[Path, Path, Path, dict[str, object]]:
    staging = tmp_path / "project" / ".loci-runs" / KEY
    output = tmp_path / "output" / ".loci-runs" / KEY
    (staging / "inputs").mkdir(parents=True)
    output.mkdir(parents=True)
    image = np.zeros((16, 16), dtype=np.uint16)
    image[2:5, 2:5] = 100
    image[10:13, 10:13] = 200
    source = staging / "inputs" / "synthetic.ome.tif"
    tifffile.imwrite(source, image, ome=True, metadata={"axes": "YX"})
    source_bytes = source.read_bytes()
    document: dict[str, object] = {
        "schema": "loci.remote-worker-request/v1",
        "request_key": KEY,
        "project_id": PROJECT_ID,
        "output_root": str(output),
        "resources": {"cpus": 1, "memory_mb": 256, "wall_minutes": 5, "gpus": 0},
        "sources": [
            {
                "source_id": SOURCE_ID,
                "path": "inputs/synthetic.ome.tif",
                "sha256": hashlib.sha256(source_bytes).hexdigest(),
                "size_bytes": len(source_bytes),
            }
        ],
        "tasks": [
            {
                "task_id": TASK_ID,
                "operation": "run_recipe",
                "source_id": SOURCE_ID,
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
        ],
    }
    request = staging / "request.json"
    encoded = _canonical(document)
    request.write_bytes(encoded)
    digest = hashlib.sha256(encoded).hexdigest()
    _write_marker(staging, digest)
    _write_marker(output, digest)
    return request, source, output, document


def _rewrite_request(
    request: Path, output: Path, document: dict[str, object], *, encoded: bytes | None = None
) -> None:
    payload = encoded if encoded is not None else _canonical(document)
    request.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    _write_marker(request.parent, digest)
    _write_marker(output, digest)


def _as_cellpose_request(document: dict[str, object], *, allow_fallback: bool) -> None:
    spec = resolve_cellpose_model_spec("cellpose-sam-v2")
    document["schema"] = "loci.remote-worker-request/v2"
    document["resources"] = {"cpus": 2, "memory_mb": 256, "wall_minutes": 5, "gpus": 1}
    task = document["tasks"][0]  # type: ignore[index]
    selection = task["selection"]  # type: ignore[index]
    source_id = task["source_id"]  # type: ignore[index]
    document["tasks"] = [
        {
            "task_id": TASK_ID,
            "operation": "run_cellpose",
            "source_id": source_id,
            "selection": selection,
            "cellpose": {
                "profile_id": spec.profile_id,
                "package_version": CELLPOSE_PACKAGE_VERSION,
                "artifact_id": spec.artifact_id,
                "model_sha256": spec.sha256,
                "model_size_bytes": spec.size_bytes,
                "requested_device": "cuda",
                "allow_cpu_fallback": allow_fallback,
                "rights_basis": "noncommercial-research",
                "settings": CellposeSettings(device="cuda").to_dict(),
                "measurement_channels": [0],
                "gates": [],
                "working_bytes": 8 * 1024 * 1024,
            },
        }
    ]


def _fake_cellpose_runtime(monkeypatch: pytest.MonkeyPatch, *, resolved: str) -> None:
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
    fallback = "CUDA unavailable; Loci used CPU." if resolved == "cpu" else None
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
                "resolved_device": resolved,
                "fallback_reason": fallback,
                "memory_preflight": {"device": resolved, "available_bytes": None},
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


def test_run_manifest_publishes_hash_bound_unreviewed_npy_and_json(tmp_path: Path) -> None:
    request, source, output, _ = _fixture(tmp_path)
    source_before = hashlib.sha256(source.read_bytes()).hexdigest()
    scratch_before = set(Path("/tmp").glob("loci-remote-worker-*"))

    manifest = run_manifest(request)

    encoded_manifest = _canonical(manifest)
    assert len(encoded_manifest) <= worker_module.MAX_OUTPUT_MANIFEST_BYTES
    assert (output / "output-manifest.json").read_bytes() == encoded_manifest
    request_sha = hashlib.sha256(request.read_bytes()).hexdigest()
    identity = RemoteJobIdentity(KEY, request_sha, "pbspro", "123.server", "submitted")
    verified = verify_output_manifest(encoded_manifest.decode(), identity)
    assert len(verified.entries) == 1
    assert verified.entries[0].relative_path == "results.zip"
    assert verified.entries[0].media_type == "application/zip"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_before
    assert not (output / ".loci-study").exists()
    assert set(Path("/tmp").glob("loci-remote-worker-*")) == scratch_before

    archive_path = output / "results.zip"
    assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == verified.entries[0].sha256
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = {info.filename for info in infos}
        assert names == {
            "archive.json",
            f"results/{TASK_ID}/arrays/image.npy",
            f"results/{TASK_ID}/arrays/labels.npy",
            f"results/{TASK_ID}/result.json",
        }
        assert all(info.compress_type == zipfile.ZIP_STORED for info in infos)
        archive_record = json.loads(archive.read("archive.json"))
        task_bytes = archive.read(f"results/{TASK_ID}/result.json")
        task_record = json.loads(task_bytes)
        arrays = {
            name: archive.read(descriptor["path"])
            for name, descriptor in task_record["result"]["arrays"].items()
        }
    assert archive_record["schema"] == "loci.remote-results-archive/v1"
    assert archive_record["request_key"] == KEY
    assert archive_record["request_sha256"] == request_sha
    assert archive_record["review_state"] == "unreviewed"
    assert archive_record["task_results"] == [
        {
            "task_id": TASK_ID,
            "path": f"results/{TASK_ID}/result.json",
            "schema": "loci.remote-task-result/v1",
            "review_state": "unreviewed",
        }
    ]
    assert task_record["schema"] == "loci.remote-task-result/v1"
    assert task_record["source"] == {
        "source_id": SOURCE_ID,
        "sha256": source_before,
        "size_bytes": source.stat().st_size,
    }
    assert task_record["review"] == {"state": "unreviewed", "receipt": None}
    assert task_record["result"]["source_id"] != SOURCE_ID
    assert task_record["result"]["source_sha256"] == source_before
    assert task_record["result"]["parent_id"] is None
    assert task_record["result"]["engine_version"]
    assert b"private_path" not in task_bytes
    assert str(source).encode() not in task_bytes
    geometry = task_record["result"]["provenance"]["geometry"]
    geometry_hash = hashlib.sha256(canonical_json(geometry).encode()).hexdigest()
    for name, descriptor in task_record["result"]["arrays"].items():
        array_bytes = arrays[name]
        assert hashlib.sha256(array_bytes).hexdigest() == descriptor["sha256"]
        assert len(array_bytes) == descriptor["size_bytes"]
        assert descriptor["geometry_sha256"] == geometry_hash
        array = np.load(io.BytesIO(array_bytes), allow_pickle=False)
        assert list(array.shape) == descriptor["shape"]
        assert str(array.dtype) == descriptor["dtype"]
        assert name in {"image", "labels"}


def test_run_manifest_publishes_exact_cellpose_runtime_and_rights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, _source, output, document = _fixture(tmp_path)
    _as_cellpose_request(document, allow_fallback=False)
    _rewrite_request(request, output, document)
    _fake_cellpose_runtime(monkeypatch, resolved="cuda")

    run_manifest(request)

    with zipfile.ZipFile(output / "results.zip") as archive:
        record = json.loads(archive.read(f"results/{TASK_ID}/result.json"))
    result = record["result"]
    assert record["operation"] == "run_cellpose"
    assert result["kind"] == "cellpose-segmentation"
    assert result["provenance"]["runtime"]["cellpose"]["resolved_device"] == "cuda"
    assert result["provenance"]["runtime"]["torch_version"] == "2.9.0"
    assert result["provenance"]["rights"]["basis"] == "noncommercial-research"
    assert result["provenance"]["measurements"][0]["label"] == 1


def test_run_manifest_bounds_source_loading_below_cellpose_task_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, _source, output, document = _fixture(tmp_path)
    _as_cellpose_request(document, allow_fallback=False)
    document["resources"] = {
        "cpus": 2,
        "memory_mb": 4096,
        "wall_minutes": 5,
        "gpus": 1,
    }
    document["tasks"][0]["cellpose"]["working_bytes"] = 2 * 1024**3  # type: ignore[index]
    _rewrite_request(request, output, document)
    _fake_cellpose_runtime(monkeypatch, resolved="cuda")

    run_manifest(request)

    assert (output / "output-manifest.json").is_file()
    assert (output / "results.zip").is_file()


def test_run_manifest_rejects_unauthorized_cellpose_cpu_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, _source, output, document = _fixture(tmp_path)
    _as_cellpose_request(document, allow_fallback=False)
    _rewrite_request(request, output, document)
    _fake_cellpose_runtime(monkeypatch, resolved="cpu")

    with pytest.raises(RemoteWorkerError, match="did not authorize"):
        run_manifest(request)

    assert not (output / "results.zip").exists()
    assert not (output / "output-manifest.json").exists()


def test_run_manifest_accepts_exact_source_below_declared_plain_input_root(
    tmp_path: Path,
) -> None:
    request, source, output, document = _fixture(tmp_path)
    input_root = tmp_path / "remote-input"
    target = input_root / "cohort" / "synthetic.ome.tif"
    target.parent.mkdir(parents=True)
    source.rename(target)
    document["sources"][0]["path"] = "cohort/synthetic.ome.tif"  # type: ignore[index]
    document["sources"][0]["permitted_root"] = str(input_root)  # type: ignore[index]
    _rewrite_request(request, output, document)

    manifest = run_manifest(request)

    assert manifest["outputs"][0]["path"] == "results.zip"
    assert target.is_file()


@pytest.mark.parametrize("failure", ["noncanonical", "duplicate", "operation", "budget", "gpu"])
def test_run_manifest_rejects_noncanonical_or_out_of_contract_requests(
    tmp_path: Path, failure: str
) -> None:
    request, _, output, document = _fixture(tmp_path)
    encoded = None
    if failure == "noncanonical":
        encoded = _canonical(document) + b"\n"
    elif failure == "duplicate":
        encoded = _canonical(document)[:-1] + b',"schema":"other"}'
    elif failure == "operation":
        document["tasks"][0]["operation"] = "shell"  # type: ignore[index]
    elif failure == "budget":
        document["tasks"][0]["recipe"]["working_bytes"] = 300 * 1024 * 1024  # type: ignore[index]
    else:
        document["resources"]["gpus"] = 1  # type: ignore[index]
    _rewrite_request(request, output, document, encoded=encoded)

    with pytest.raises(RemoteWorkerError):
        run_manifest(request)

    assert not (output / "output-manifest.json").exists()
    assert not (output / ".loci-study").exists()


@pytest.mark.parametrize("failure", ["symlink", "hash", "size"])
def test_run_manifest_rejects_unverified_staged_sources(tmp_path: Path, failure: str) -> None:
    request, source, output, document = _fixture(tmp_path)
    if failure == "symlink":
        outside = tmp_path / "outside.tif"
        source.rename(outside)
        source.symlink_to(outside)
    elif failure == "hash":
        document["sources"][0]["sha256"] = "e" * 64  # type: ignore[index]
        _rewrite_request(request, output, document)
    else:
        document["sources"][0]["size_bytes"] = source.stat().st_size + 1  # type: ignore[index]
        _rewrite_request(request, output, document)

    with pytest.raises(RemoteWorkerError, match="source"):
        run_manifest(request)

    assert not (output / "output-manifest.json").exists()
    assert not (output / ".loci-study").exists()


def test_run_manifest_refuses_linked_output_marker(tmp_path: Path) -> None:
    request, _, output, _ = _fixture(tmp_path)
    outside = tmp_path / "marker.json"
    marker = output / ".loci-owned.json"
    marker.rename(outside)
    marker.symlink_to(outside)

    with pytest.raises(RemoteWorkerError, match="marker"):
        run_manifest(request)

    assert not (output / ".loci-study").exists()


def test_run_manifest_rechecks_request_before_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, _, output, _ = _fixture(tmp_path)
    original = worker_module.Workbench.execute

    def mutate_request(workbench, operation, payload):
        result = original(workbench, operation, payload)
        request.write_bytes(request.read_bytes() + b"\n")
        return result

    monkeypatch.setattr(worker_module.Workbench, "execute", mutate_request)

    with pytest.raises(RemoteWorkerError):
        run_manifest(request)

    assert not (output / "output-manifest.json").exists()
    assert not (output / "results.zip").exists()


def test_run_manifest_never_overwrites_a_prior_publication(tmp_path: Path) -> None:
    request, _, output, _ = _fixture(tmp_path)
    existing = output / "output-manifest.json"
    existing.write_text("prior")

    with pytest.raises(RemoteWorkerError, match="already exists"):
        run_manifest(request)

    assert existing.read_text() == "prior"
    assert not (output / ".loci-study").exists()


def test_run_manifest_never_overwrites_a_prior_archive(tmp_path: Path) -> None:
    request, _, output, _ = _fixture(tmp_path)
    existing = output / "results.zip"
    existing.write_bytes(b"prior")

    with pytest.raises(RemoteWorkerError, match="already exists"):
        run_manifest(request)

    assert existing.read_bytes() == b"prior"
    assert not (output / "output-manifest.json").exists()


def test_archive_without_manifest_is_not_an_accepted_interrupted_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, _, output, _ = _fixture(tmp_path)
    original = worker_module._publish_file_noreplace
    calls = 0

    def interrupt_manifest(source: Path, destination: Path) -> None:
        nonlocal calls
        calls += 1
        if destination.name == "output-manifest.json":
            raise RemoteWorkerError("simulated interruption")
        original(source, destination)

    monkeypatch.setattr(worker_module, "_publish_file_noreplace", interrupt_manifest)

    with pytest.raises(RemoteWorkerError, match="simulated interruption"):
        run_manifest(request)

    assert calls == 2
    assert (output / "results.zip").is_file()
    assert not (output / "output-manifest.json").exists()
    assert list(output.glob(".results-*.zip")) == []
    assert list(output.glob(".output-manifest-*.json")) == []
