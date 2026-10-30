"""Real native I/O/persistence with explicitly fake inference; no accuracy claim."""

from __future__ import annotations

import builtins
import copy
from types import MappingProxyType, SimpleNamespace

import numpy as np
import pytest
import tifffile

from loci_engine import puma_backend as backend
from loci_engine import research_tissue_models as tissue
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


def no_op():
    pass


def runtime_record():
    return {
        "numeric_profile": tissue.PUMA_NUMERIC_PROFILE,
        "versions": dict(tissue.PUMA_RUNTIME_VERSIONS),
        "python_version": "3.12.0",
        "platform": "fixture",
        "machine": "fixture",
        "torch_git_version": tissue.PUMA_TORCH_GIT_VERSION,
        "torch_build_configuration_sha256": "b" * 64,
        "device": "cpu",
        "intra_op_threads": 1,
        "inter_op_threads": 1,
        "deterministic_algorithms": True,
        "autocast": False,
        "runtime_import_verified": True,
        "technical_compatibility_verified": False,
        "modeling_prototype_parity": "unverified-distinct-runtime",
        "official_cuda_runtime_parity": "unverified",
        "added_serialization_globals": [],
        "serialization_policy": {
            "load_window": "zero-added-globals-weights-only-cpu",
            "known_torch_defaults": "identity-checked-cleared-for-load-restored-afterward",
            "process_ownership": "exclusive-disposable-worker-required",
        },
    }


def fake_inference(context, request, *, weights, working_bytes, check):
    """Two separated epidermis regions and a different class; no learned model."""
    check()
    plan = backend.plan_puma(context, request, working_bytes=working_bytes, check=check)
    h, w = request["output_roi_yxhw"][2:]
    classes = np.zeros((h, w), np.uint8)
    classes[0, 0] = 4
    classes[1:3, 2:4] = 4
    classes[-1, -1] = 3
    computed = np.zeros((h, w), bool)
    bbox = plan["tiles"]["computed_bbox_output_yx"]
    if bbox is not None:
        (y0, y1), (x0, x1) = bbox
        computed[y0:y1, x0:x1] = True
    classes[~computed] = 0
    probabilities = np.moveaxis(np.eye(6, dtype=np.float32)[classes], -1, 0).copy()
    arrays = {
        "class_labels": classes,
        "probabilities": probabilities,
        "logits": probabilities.astype(np.float16),
        "epidermis_mask": classes == 4,
        "computed_mask": computed,
        "weight_sum": computed.astype(np.float16),
    }
    record = {
        "schema": "loci.puma-inference/v1",
        "status": "executed-not-qualified",
        "adopted": False,
        "profile": tissue.puma_profile(),
        "profile_id": tissue.PUMA_PROFILE_ID,
        **{
            key: plan[key]
            for key in ("request", "decoding", "preprocessing", "tiles", "resource_preflight")
        },
        "runtime": runtime_record(),
        "weights_validation": {
            "tensor_keys": 396,
            "unique_storages": 148,
            "tensor_bytes": tissue.PUMA_TENSOR_BYTES,
            "finite_values_checked": True,
            "aliases_checked": True,
        },
        "execution": {
            "network_calls": plan["tiles"]["planned_network_calls"],
            "model_forward_executed": bool(plan["tiles"]["tiles"]),
            "gaussian_sha256": "c" * 64,
            "class_map": {str(i): name for i, name in enumerate(tissue.PUMA_CLASS_NAMES)},
            "selected_class": 4,
            "scores_are_validated_confidence": False,
        },
        "artifacts": {name: tissue._descriptor(array) for name, array in arrays.items()},
    }
    return backend.PumaInference(MappingProxyType(arrays), MappingProxyType(record))


@pytest.fixture
def make_case(tmp_path, monkeypatch):
    opened = []
    original_import = builtins.__import__

    def no_torch(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            raise AssertionError("Dispatcher fixtures must not import Torch")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_torch)
    monkeypatch.setattr(backend, "infer_puma", fake_inference)
    # Separate trust boundary is covered by backend tests. No 185MB model needed.
    monkeypatch.setattr(tissue, "_weights_identity", lambda weights: (1, 2, 3))
    monkeypatch.setattr(tissue, "_verify_weights", lambda weights, check: check())
    monkeypatch.setattr(
        tissue,
        "runtime_metadata_status",
        lambda: {"fixture": True, "status": "metadata-matches-unverified"},
    )

    def make(*, rgba=False, calibrated=True):
        index = len(opened)
        path = tmp_path / f"rgb-{index}.ome.tif"
        raw = np.arange(8 * 10 * (4 if rgba else 3), dtype=np.uint16)
        raw = (raw % 240 + 1).astype(np.uint8).reshape(8, 10, 4 if rgba else 3)
        metadata = {"axes": "YXS"}
        if calibrated:
            metadata.update(
                PhysicalSizeX=2, PhysicalSizeXUnit="µm", PhysicalSizeY=3, PhysicalSizeYUnit="µm"
            )
        tifffile.imwrite(path, raw, photometric="rgb", ome=True, metadata=metadata)
        project = ResearchProject.create(tmp_path / f"case-{index}.loci-study", "Tissue fixture")
        wb = Workbench(project)
        opened.append(wb)
        source = wb.import_native(str(path))
        profile = tissue.puma_profile()
        context = {"x": 0, "y": 0, "width": 10, "height": 8, "c": 0, "z": 0, "t": 0, "level": 0}
        request = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "series": 0,
            "context_selection": context,
            "output_selection": {**context, "x": 2, "y": 1, "width": 5, "height": 4},
            "profile_id": profile["id"],
            "profile_contract_sha256": profile["contract_sha256"],
            "runtime_contract_sha256": tissue._hash(profile["runtime"]),
            "weights_sha256": tissue.PUMA_WEIGHTS_SHA256,
            "rgb_policy": tissue.PUMA_RGB_POLICY,
            "declared_stain": "hematoxylin-eosin",
            "working_bytes": tissue.PUMA_MIN_WORKING_BYTES,
        }
        return SimpleNamespace(
            wb=wb,
            project=project,
            source=source,
            request=request,
            path=path,
            raw=raw,
            weights=object(),
        )

    yield make
    for wb in opened:
        wb.close()


def preview(case, *, check=no_op):
    return tissue.execute(
        case.wb, "tissue_model_preview", case.request, weights=case.weights, check=check
    )


def token(output):
    return {key: output[key] for key in ("preview_id", "preview_hash")}


def run(case, output, *, check=no_op):
    return tissue.execute(
        case.wb, "tissue_model_run", token(output), weights=case.weights, check=check
    )


def adopted(case):
    output = run(case, preview(case))
    result = case.project.result(output["result"]["id"])
    return result, {
        name: case.project.load_array(value) for name, value in result["arrays"].items()
    }


def cache_rows(case):
    with case.project.connection() as connection:
        return connection.execute(
            "SELECT key,value FROM metadata WHERE key LIKE ?", (tissue.PREVIEW_PREFIX + "%",)
        ).fetchall()


def result_count(case):
    with case.project.connection() as connection:
        return connection.execute("SELECT COUNT(*) FROM results").fetchone()[0]


def corrected(case, parent, arrays, edited=None):
    retained, provenance = tissue.prepare_correction(
        parent, arrays, arrays["labels"] if edited is None else edited, check=no_op
    )
    result = case.project.save_result(
        source_id=parent["source_id"],
        kind="corrected-labels",
        arrays=retained,
        provenance=provenance,
        parent_id=parent["id"],
    )
    return result, retained


def test_preview_metadata_only_run_repeats_exact_inference(make_case, monkeypatch):
    case = make_case()
    calls = []

    def observed(context, request, **kwargs):
        calls.append(copy.deepcopy(request))
        np.testing.assert_array_equal(context, case.raw)
        return fake_inference(context, request, **kwargs)

    monkeypatch.setattr(backend, "infer_puma", observed)
    output = preview(case)
    assert output["adopted"] is False and output["region_count"] == 2
    assert output["overlay_png"].startswith("data:image/png;base64,")
    assert result_count(case) == 0 and not list(case.project.arrays.iterdir())
    rows = cache_rows(case)
    assert len(rows) == 1 and "base64" not in rows[0][1] and str(case.path) not in rows[0][1]
    assert len(rows[0][1].encode()) < tissue.MAX_PREVIEW_BYTES and len(calls) == 1
    result = run(case, output)
    assert len(calls) == 2 and calls[0] == calls[1]
    assert calls[0]["source_shape_yx"] == [8, 10]
    assert calls[0]["output_roi_yxhw"] == [1, 2, 4, 5]
    assert result["adopted"] is True and result_count(case) == 1
    saved = case.project.result(result["result"]["id"])
    tissue.validate_record(saved)
    assert case.project.review_state(saved["id"]) is None
    assert saved["provenance"]["measurement_channels"] == []
    assert [r["measure"] for r in result["measurements"]] == [6, 24]
    assert all(r["intensity"] == {} and r["measure_unit"] == "um^2" for r in result["measurements"])
    assert result["measurements"][0]["centroid_world_xyz"] == [4, 3, 0]


def test_rgba_explicit_decode_and_uncalibrated_pixel_geometry(make_case):
    case = make_case(rgba=True, calibrated=False)
    output = preview(case)
    receipt = tissue.peek_preview(case.project, token(output))["receipt"]
    assert receipt["inference"]["decoding"]["alpha_discarded"] is True
    assert receipt["inference"]["decoding"]["decoded_array_sha256"] == tissue._array_hash(case.raw)
    result = run(case, output)
    assert result["measurements"][0]["measure_unit"] == "pixel^2"
    assert result["measurements"][0]["measure"] == 1


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.update(series=True),
        lambda r: r.update(profile_contract_sha256="0" * 64),
        lambda r: r.update(runtime_contract_sha256="0" * 64),
        lambda r: r.update(weights_sha256="0" * 64),
        lambda r: r.update(rgb_policy="guess-from-color"),
        lambda r: r.update(path="/untrusted"),
        lambda r: r["context_selection"].update(x=1),
        lambda r: r["context_selection"].update(width=1025),
        lambda r: r["output_selection"].update(level=1),
        lambda r: r["output_selection"].update(t=1),
        lambda r: r["output_selection"].update(width=10),
    ],
)
def test_bad_request_never_decodes_or_caches(make_case, mutation):
    case = make_case()
    mutation(case.request)
    with pytest.raises(ValueError):
        preview(case)
    assert not cache_rows(case) and result_count(case) == 0


@pytest.mark.parametrize(
    "mutation",
    [
        lambda s: s.update(source_kind="whole_slide"),
        lambda s: s["metadata"].update(selected_series=1),
        lambda s: s["metadata"].update(sample_semantics="scalar"),
        lambda s: s["metadata"].update(channel_dtypes=["uint16"]),
        lambda s: s["metadata"]["dimensions"].update(c=3),
        lambda s: s["metadata"]["dimensions"].update(s=1),
        lambda s: s["metadata"]["dimensions"].update(x=11),
    ],
)
def test_source_requires_complete_native_rgb_context(make_case, mutation):
    case = make_case()
    source = copy.deepcopy(case.project.source(case.source["id"]))
    mutation(source)
    with pytest.raises(ValueError):
        tissue._validate_source_request(source, case.request)


def test_guard_required_and_rechecked_after_bounded_decode(make_case, monkeypatch):
    case = make_case()
    with pytest.raises(ValueError, match="guard"):
        preview(case, check=None)
    session = case.wb._session(case.source["id"])
    reader = type(session).read_region
    state = {"decoded": False}

    def read(active, selection):
        value = reader(active, selection)
        state["decoded"] = True
        return value

    def check():
        if state["decoded"]:
            raise PermissionError("revoked during bounded decode")

    monkeypatch.setattr(type(session), "read_region", read)
    with pytest.raises(PermissionError, match="revoked"):
        preview(case, check=check)
    assert result_count(case) == 0 and not cache_rows(case)


def test_bindings_include_context_and_roi_but_token_grants_no_authority(make_case):
    case = make_case()
    output = preview(case)
    bindings = tissue.source_bindings(case.project, "tissue_model_run", token(output))
    assert [x["purpose"] for x in bindings] == ["normalization-context", "output-region"]
    assert bindings[0]["selection"] == case.request["context_selection"]
    assert bindings[1]["selection"] == case.request["output_selection"]
    assert tissue.task_source(case.project, token(output)) == case.source["id"]

    def refused():
        raise PermissionError("no grant")

    with pytest.raises(PermissionError):
        run(case, output, check=refused)
    assert result_count(case) == 0


def test_replay_requires_full_receipt_equality(make_case, monkeypatch):
    case = make_case()
    output = preview(case)

    def changed(*args, **kwargs):
        inference = fake_inference(*args, **kwargs)
        record = copy.deepcopy(dict(inference.record))
        record["runtime"]["inter_op_threads"] = 2
        return backend.PumaInference(inference.arrays, MappingProxyType(record))

    monkeypatch.setattr(backend, "infer_puma", changed)
    with pytest.raises(ValueError, match="after the exact preview"):
        run(case, output)
    assert result_count(case) == 0


@pytest.mark.parametrize(
    "field,value",
    [
        ("added_serialization_globals", ["anything"]),
        ("technical_compatibility_verified", True),
        ("modeling_prototype_parity", "verified"),
        ("serialization_policy", {}),
        ("intra_op_threads", True),
        ("unexpected_runtime_claim", "supported"),
    ],
)
def test_runtime_receipt_cannot_promote_candidate_claims(field, value):
    record = runtime_record()
    record[field] = value
    with pytest.raises(ValueError):
        tissue._runtime_record_valid(record)


@pytest.mark.parametrize(
    "name", ["class_labels", "probabilities", "epidermis_mask", "computed_mask"]
)
def test_original_artifact_inconsistency_refused_before_cache(make_case, monkeypatch, name):
    case = make_case()

    def changed(*args, **kwargs):
        inference = fake_inference(*args, **kwargs)
        arrays = {key: value.copy() for key, value in inference.arrays.items()}
        arrays[name].flat[0] = 0 if arrays[name].flat[0] else 1
        record = copy.deepcopy(dict(inference.record))
        record["artifacts"][name] = tissue._descriptor(arrays[name])
        return backend.PumaInference(MappingProxyType(arrays), MappingProxyType(record))

    monkeypatch.setattr(backend, "infer_puma", changed)
    with pytest.raises(ValueError):
        preview(case)
    assert result_count(case) == 0 and not cache_rows(case)


def test_cache_tampering_count_and_byte_caps(make_case, monkeypatch):
    case = make_case()
    output = preview(case)
    stored = tissue.peek_preview(case.project, token(output))
    monkeypatch.setattr(tissue, "MAX_PREVIEWS", 2)
    tissue._cache_preview(case.project, stored["receipt"], no_op)
    newest = tissue._cache_preview(case.project, stored["receipt"], no_op)
    assert len(cache_rows(case)) == 2
    record = tissue.peek_preview(case.project, newest)
    record["receipt"]["labels"]["pixel_count"] += 1
    with case.project.connection() as connection:
        connection.execute(
            "UPDATE metadata SET value=? WHERE key=?",
            (canonical_json(record), tissue.PREVIEW_PREFIX + newest["preview_id"]),
        )
    with pytest.raises(ValueError, match="identity or receipt"):
        tissue.peek_preview(case.project, newest)
    monkeypatch.setattr(tissue, "MAX_CACHE_BYTES", len(canonical_json(stored).encode()) + 100)
    newest = tissue._cache_preview(case.project, stored["receipt"], no_op)
    assert len(cache_rows(case)) == 1
    assert tissue.peek_preview(case.project, newest)["receipt"] == stored["receipt"]
    assert sum(len(value.encode()) for _, value in cache_rows(case)) <= tissue.MAX_CACHE_BYTES


@pytest.mark.parametrize("mutation", ["preview", "weights"])
def test_publication_guard_rechecks_inside_transaction(make_case, monkeypatch, mutation):
    case = make_case()
    output = preview(case)
    original_save = case.project.save_result

    def changed(**kwargs):
        if mutation == "preview":
            with case.project.connection() as connection:
                connection.execute(
                    "DELETE FROM metadata WHERE key=?",
                    (tissue.PREVIEW_PREFIX + output["preview_id"],),
                )
        else:
            monkeypatch.setattr(tissue, "_weights_identity", lambda weights: (4, 5, 6))
        return original_save(**kwargs)

    monkeypatch.setattr(case.project, "save_result", changed)
    with pytest.raises(ValueError):
        run(case, output)
    assert result_count(case) == 0


def test_correction_preserves_original_arrays_and_cold_reopen(make_case):
    case = make_case()
    parent, arrays = adopted(case)
    edited = arrays["labels"].copy()
    edited[0, 0] = 0
    edited[-1, 0] = 4_000_000_000
    result, retained = corrected(case, parent, arrays, edited)
    tissue.validate_arrays(result, retained, parent=parent, check=no_op)
    provenance = result["provenance"]
    assert provenance["tissue_model"]["initial_statistics_apply_to_effective_labels"] is False
    assert provenance["tissue_model"]["receipt"] == parent["provenance"]["tissue_model"]["receipt"]
    assert any(row["label"] == 4_000_000_000 for row in provenance["measurements"])
    for name in ("class_labels", "probabilities", "image"):
        assert result["arrays"][name] == parent["arrays"][name]
        np.testing.assert_array_equal(retained[name], arrays[name])
    reopened = ResearchProject(case.project.root)
    records = {r["id"]: reopened.result(r["id"]) for r in (parent, result)}
    tissue.validate_portable_references(
        records[result["id"]],
        records,
        {parent["source_id"]: reopened.source(parent["source_id"])},
        array_loader=reopened.load_array,
        check=no_op,
    )
    assert reopened.review_state(result["id"]) is None


def test_correction_rejects_prediction_mutation_and_false_original_claim(make_case):
    case = make_case()
    parent, arrays = adopted(case)
    altered = dict(arrays)
    altered["image"] = arrays["image"].copy()
    altered["image"][0, 0] = 0
    with pytest.raises(ValueError, match="Original model arrays"):
        tissue.prepare_correction(parent, altered, arrays["labels"], check=no_op)
    result, _ = corrected(case, parent, arrays)
    result["provenance"]["tissue_model"]["initial_statistics_apply_to_effective_labels"] = True
    with pytest.raises(ValueError, match="cannot claim original"):
        tissue.validate_record(result)


def test_portable_references_missing_parent_source_and_revision(make_case):
    case = make_case()
    parent, arrays = adopted(case)
    result, _ = corrected(case, parent, arrays)
    sources = {parent["source_id"]: case.project.source(parent["source_id"])}
    with pytest.raises(ValueError, match="parent is missing"):
        tissue.validate_portable_references(result, {}, sources, check=no_op)
    with pytest.raises(ValueError, match="source is missing"):
        tissue.validate_portable_references(parent, {}, {}, check=no_op)
    tampered = copy.deepcopy(parent)
    tampered["created_at"] = "changed"
    with pytest.raises(ValueError, match="revision hash"):
        tissue.validate_portable_references(tampered, {}, sources, check=no_op)


def test_region_limit_before_publication(make_case, monkeypatch):
    case = make_case()
    monkeypatch.setattr(tissue, "MAX_REGIONS", 1)
    with pytest.raises(ValueError, match="connected-region limit"):
        preview(case)
    assert not cache_rows(case) and result_count(case) == 0


def test_job_guard_refuses_wrong_cancelled_or_stopped_job():
    request = {"preview_id": "a" * 32, "preview_hash": "b" * 64}
    normalized = {"source_id": "c" * 32, "task_request": request}
    job = {
        "operation": "tissue_model_run",
        "state": "running",
        "cancel_requested": False,
        "request": normalized,
        "request_hash": tissue._hash({"operation": "tissue_model_run", "request": normalized}),
    }
    project = SimpleNamespace(job=lambda job_id: job)
    tissue._job_guard(project, "d" * 32, request, "c" * 32)
    for field, value in (
        ("cancel_requested", True),
        ("state", "succeeded"),
        ("operation", "other"),
        ("request_hash", "e" * 64),
    ):
        original = job[field]
        job[field] = value
        with pytest.raises(ValueError, match="exact running job"):
            tissue._job_guard(project, "d" * 32, request, "c" * 32)
        job[field] = original


def test_historical_validation_needs_no_source_or_weights(make_case, monkeypatch):
    case = make_case()
    parent, arrays = adopted(case)
    case.wb.close()
    case.path.unlink()

    def forbidden(*args, **kwargs):
        raise AssertionError("Historical validation must not load model/source")

    monkeypatch.setattr(backend, "infer_puma", forbidden)
    monkeypatch.setattr(tissue, "_verify_weights", forbidden)
    tissue.validate_arrays(parent, arrays, check=no_op)
    tissue.validate_record(copy.deepcopy(parent))


def test_status_only_uses_registered_metadata_and_no_decode(make_case, monkeypatch):
    case = make_case()

    def no_decode(*args, **kwargs):
        raise AssertionError("Status may not open or decode a source")

    monkeypatch.setattr(case.wb, "_session", no_decode)
    monkeypatch.setattr(
        backend,
        "inspect_puma_status",
        lambda weights, verify_weights: {
            "model_execution_performed": False,
            "weights_verified": verify_weights,
        },
    )
    result = tissue.execute(case.wb, "tissue_model_status", case.request, weights=None, check=no_op)
    assert result["source_verification"] == "registered-metadata-only"
    assert result["status"]["weights_verified"] is False
    assert result["adopted"] is False and not cache_rows(case)


def test_source_file_change_after_preview_refuses_run(make_case):
    case = make_case()
    output = preview(case)
    with case.path.open("ab") as stream:
        stream.write(b"Changed source identity")
    with pytest.raises(ValueError):
        run(case, output)
    assert result_count(case) == 0


def test_source_metadata_change_at_publication_is_refused(make_case, monkeypatch):
    case = make_case()
    output = preview(case)
    original_save = case.project.save_result

    def changed(**kwargs):
        with case.project.connection() as connection:
            import json

            row = connection.execute(
                "SELECT record FROM sources WHERE id=?", (case.source["id"],)
            ).fetchone()
            source = json.loads(row[0])
            source["metadata"]["task_test_extra"] = "changed"
            connection.execute(
                "UPDATE sources SET record=? WHERE id=?",
                (canonical_json(source), case.source["id"]),
            )
        return original_save(**kwargs)

    monkeypatch.setattr(case.project, "save_result", changed)
    with pytest.raises(ValueError, match="metadata changed"):
        run(case, output)
    assert result_count(case) == 0


def test_portable_correction_requires_exact_parent_revision(make_case):
    case = make_case()
    parent, arrays = adopted(case)
    result, retained = corrected(case, parent, arrays)
    changed_parent = copy.deepcopy(parent)
    changed_parent["revision_hash"] = "f" * 64
    with pytest.raises(ValueError, match="parent revision"):
        tissue.validate_arrays(result, retained, parent=changed_parent, check=no_op)
    with pytest.raises(ValueError, match="exact original parent"):
        tissue.validate_arrays(result, retained, check=no_op)


@pytest.mark.parametrize("status", ["missing", "mismatch"])
def test_unavailable_runtime_refuses_before_decoder(make_case, monkeypatch, status):
    case = make_case()
    monkeypatch.setattr(tissue, "runtime_metadata_status", lambda: {"status": status})
    monkeypatch.setattr(
        case.wb, "_session", lambda *a, **k: pytest.fail("Runtime denial decoded source")
    )
    with pytest.raises(
        ValueError, match="runtime is unavailable or mismatched before source decode"
    ):
        preview(case)
    assert case.project.list_results() == []
