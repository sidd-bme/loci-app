"""Private tissue jobs, original predictions, correction and portable integrity.

Inference is explicitly synthetic; these tests do not qualify a learned model.
"""

import base64
import copy
import io
import json

import numpy as np
import pytest
import test_research_tissue_models as fixtures
from PIL import Image
from test_research_interchange import _rewrite

from loci_engine import research_tissue_integration as integration
from loci_engine import research_tissue_models as tissue
from loci_engine import worker
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import export_project, import_project
from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


@pytest.fixture
def make_case(tmp_path, monkeypatch):
    yield from fixtures.make_case.__wrapped__(tmp_path, monkeypatch)


@pytest.fixture
def ready(make_case, monkeypatch, tmp_path):
    case = make_case()
    monkeypatch.setenv("LOCI_MODEL_HOME", str(tmp_path / "models"))
    monkeypatch.setattr(integration.store, "resolve_approved_weights", lambda *a, **k: case.weights)
    case.wb._exclusive_tissue_worker = True
    return case


def task(case, operation, request, key):
    job = submit_job(case.wb, request, key, operation)
    return run_job(case.wb, job["id"])


def produce(case):
    preview = task(case, "tissue_model_preview", case.request, "exact-preview")
    output = task(case, "tissue_model_run", fixtures.token(preview), "exact-run")
    return preview, output, case.project.result(output["result"]["id"])


def exact(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def corrected(case, result):
    info = case.wb.execute("correction_info", exact(result))
    request = {
        **exact(result),
        "working_bytes": tissue.PUMA_MIN_WORKING_BYTES,
        "operations": [{"op": "delete", "label": 1, "expected_input_sha256": info["label_sha256"]}],
    }
    return task(case, "correct_result", request, "exact-correction")["result"]


def test_durable_preview_run_and_authentic_retained_fields(ready):
    case = ready
    preview, output, result = produce(case)
    assert preview["job"]["state"] == "succeeded" and preview["job"]["result_ids"] == []
    assert preview["job"]["request"] == {
        "source_id": case.source["id"],
        "task_request": case.request,
    }
    cached = case.wb.execute("task_preview_get", {"job_id": preview["job"]["id"]})
    assert fixtures.token(cached["preview"]["output"]) == fixtures.token(preview)
    assert output["job"]["result_ids"] == [result["id"]]
    assert output["result"]["tissue_model"] == {
        key: result["provenance"]["tissue_model"][key]
        for key in ("schema", "label_semantics", "preview")
    }
    assert set(result["arrays"]) == {"class_labels", "probabilities", "image", "labels"}
    assert "logits" not in result["arrays"]
    classes = case.wb.result_view({"result_id": result["id"], "label_field": "tissue_classes"})
    compartments = case.wb.result_view({"result_id": result["id"]})
    score = case.wb.result_view({"result_id": result["id"], "labels": False})
    assert classes["field"] == "tissue_classes" and "original" in classes["basis"]
    assert compartments["field"] == "compartments" and "Effective" in compartments["basis"]
    assert score["field"] == "epidermis_score" and score["label_image"] is None
    pixels = np.array(
        Image.open(io.BytesIO(base64.b64decode(classes["label_image"].split(",")[1])))
    )
    expected = np.array([(4 * multiplier % 223 + 32) for multiplier in (67, 97, 137)] + [150])
    np.testing.assert_array_equal(pixels[0, 0], expected)
    assert classes["label_image"] != compartments["label_image"]
    assert (
        submit_job(case.wb, fixtures.token(preview), "exact-run", "tissue_model_run")["id"]
        == output["job"]["id"]
    )
    assert run_job(case.wb, output["job"]["id"])["job"]["result_ids"] == [result["id"]]
    assert len(case.project.list_results()) == 1


def test_correction_cold_reopen_review_export_and_portable_restore(ready, tmp_path, monkeypatch):
    case = ready
    _, _, original = produce(case)
    child = corrected(case, original)
    result = case.project.result(child["id"])
    for name in ("class_labels", "probabilities", "image"):
        assert result["arrays"][name] == original["arrays"][name]
    assert result["arrays"]["labels"] != original["arrays"]["labels"]
    assert child["object_count"] == 1
    assert case.project.review_state(result["id"]) is None
    case.project.review(result["id"], result["revision_hash"], "reviewed")
    export_research_result(case.project, result["id"], result["revision_hash"], tmp_path / "export")
    exported = json.loads((tmp_path / "export/result.json").read_text())
    assert exported["result"]["provenance"]["tissue_model"] == result["provenance"]["tissue_model"]
    assert (tmp_path / "export/class_labels.npy").is_file()
    assert (tmp_path / "export/class_labels.ome.tif").is_file()
    assert "declared_stain" in (tmp_path / "export/methods.md").read_text()
    archive = tmp_path / "portable.zip"
    export_project(case.project, archive)
    monkeypatch.setattr(
        tissue.backend, "infer_puma", lambda *a, **k: pytest.fail("Retained read reran inference")
    )
    monkeypatch.setattr(
        integration.store,
        "resolve_approved_weights",
        lambda *a, **k: pytest.fail("Retained read opened weights"),
    )
    restored = import_project(archive, tmp_path / "restored")
    retained = restored.result(result["id"])
    assert retained["provenance"] == result["provenance"]
    assert restored.review_state(result["id"])["disposition"] == "reviewed"
    case.wb.close()
    case.path.unlink()
    cold = ResearchProject(case.project.root)
    assert cold.result(result["id"]) == result
    assert (
        Workbench(cold).result_view({"result_id": result["id"], "label_field": "tissue_classes"})[
            "field"
        ]
        == "tissue_classes"
    )


@pytest.mark.parametrize("route", ["read", "view", "review", "export"])
def test_original_prediction_tamper_refused_before_consumption(ready, route, tmp_path):
    case = ready
    _, _, result = produce(case)
    altered = case.project.load_array(result["arrays"]["class_labels"]).copy()
    altered[0, 0] = 3
    bad = copy.deepcopy(result)
    bad["arrays"]["class_labels"] = case.project.store_array(altered)
    bad["revision_hash"] = tissue._hash({k: v for k, v in bad.items() if k != "revision_hash"})
    with case.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(bad), bad["id"])
        )
    with pytest.raises(ValueError):
        if route == "read":
            case.project.result(bad["id"])
        elif route == "view":
            case.wb.result_view({"result_id": bad["id"]})
        elif route == "review":
            case.project.review(bad["id"], bad["revision_hash"], "reviewed")
        else:
            export_research_result(
                case.project, bad["id"], bad["revision_hash"], tmp_path / "bad-export"
            )


@pytest.mark.parametrize("change", ["hash", "source", "cancel", "nonexclusive", "stain"])
def test_stale_denied_cancelled_or_nonexclusive_never_publishes(ready, change, monkeypatch):
    case = ready
    preview = task(case, "tissue_model_preview", case.request, "preview")
    body = fixtures.token(preview)
    if change == "hash":
        body["preview_hash"] = "f" * 64
        with pytest.raises(ValueError):
            submit_job(case.wb, body, "bad", "tissue_model_run")
        return
    if change == "stain":
        case.request["declared_stain"] = "inferred-from-RGB"
        with pytest.raises(ValueError):
            submit_job(case.wb, case.request, "bad", "tissue_model_preview")
        return
    job = submit_job(case.wb, body, "bad", "tissue_model_run")
    if change == "cancel":
        cancel_job(case.project, job["id"])
        assert run_job(case.wb, job["id"])["job"]["state"] == "cancelled"
    else:
        if change == "source":
            with case.path.open("ab") as stream:
                stream.write(b"source changed")
        else:
            case.wb._exclusive_tissue_worker = False
        with pytest.raises(ValueError):
            run_job(case.wb, job["id"])
    assert case.project.list_results() == []


def test_current_read_budget_rejected_before_array_decode(ready, monkeypatch):
    _, _, result = produce(ready)
    monkeypatch.setattr(ready.project, "load_array", lambda *a: pytest.fail("Over-budget decode"))
    with pytest.raises(ValueError, match="budget before decode"):
        ready.project.validate_result_arrays(result, working_bytes=1)


def test_larger_current_allowance_cannot_replace_retained_budget(ready, monkeypatch):
    _, _, result = produce(ready)
    # Metadata-only reconstruction must refuse before trusting any oversized
    # descriptor enough to ask the array loader to allocate it.
    oversized = copy.deepcopy(result)
    oversized["arrays"]["probabilities"]["bytes"] = tissue.PUMA_MIN_WORKING_BYTES // 4
    monkeypatch.setattr(ready.project, "load_array", lambda *a: pytest.fail("Over-budget decode"))
    with pytest.raises(ValueError, match="budget before decode"):
        integration.project_records(
            ready.project, oversized, arrays=True, working_bytes=tissue.PUMA_MAX_WORKING_BYTES
        )


@pytest.mark.parametrize("route", ["read", "view", "review", "export", "portable"])
def test_consistent_calibration_forgery_cannot_redefine_source(ready, tmp_path, monkeypatch, route):
    _, _, original = produce(ready)
    arrays = {key: ready.project.load_array(value) for key, value in original["arrays"].items()}
    forged = copy.deepcopy(original)
    provenance = forged["provenance"]
    receipt = provenance["tissue_model"]["receipt"]
    receipt["context_geometry"]["affine"][0][0] *= 2
    receipt["context_geometry"]["affine"][1][1] *= 2
    context = tissue._geometry(receipt["context_geometry"])
    output = receipt["request"]["output_selection"]
    geometry = context.cropped((output["y"], output["x"]))
    receipt["geometry"] = tissue._clone(geometry.to_dict())
    provenance["geometry"] = copy.deepcopy(receipt["geometry"])
    rows = tissue._regions(arrays["labels"], geometry, provenance["working_bytes"], lambda: None)
    provenance["measurements"] = rows
    receipt["measurements_sha256"] = tissue._hash(rows)
    provenance["tissue_model"]["preview"]["preview_hash"] = tissue._hash(receipt)
    forged["revision_hash"] = tissue._hash(
        {key: value for key, value in forged.items() if key != "revision_hash"}
    )
    np.testing.assert_allclose(
        rows[0]["measure"], 4 * original["provenance"]["measurements"][0]["measure"],
        rtol=1e-14, atol=0,
    )
    assert forged["arrays"] == original["arrays"]
    assert receipt["source"] == original["provenance"]["tissue_model"]["receipt"]["source"]
    # Every result-internal hash, numerical row and cropped affine agrees. Only
    # the unchanged registered source proves this fourfold area claim is false.
    tissue.validate_arrays(forged, arrays, check=lambda: None)

    if route == "portable":
        archive, malicious = tmp_path / "original.zip", tmp_path / "forged.zip"
        export_project(ready.project, archive)

        def transform(entries):
            import hashlib

            target = f"results/{original['id']}.json"
            changed = canonical_json(forged).encode()
            for index, (info, payload) in enumerate(entries):
                if info.filename == target:
                    entries[index] = (info, changed)
                elif info.filename == "manifest.json":
                    manifest = json.loads(payload)
                    member = next(m for m in manifest["members"] if m["path"] == target)
                    member.update(
                        sha256=hashlib.sha256(changed).hexdigest(), size_bytes=len(changed)
                    )
                    entries[index] = (info, canonical_json(manifest).encode())
            return entries

        _rewrite(archive, malicious, transform)
        destination = tmp_path / "must-not-publish.loci-study"
        with pytest.raises(ValueError, match="registered native source calibration"):
            import_project(malicious, destination)
        assert not destination.exists()
        return

    with ready.project.connection() as connection:
        connection.execute(
            "UPDATE results SET record=? WHERE id=?", (canonical_json(forged), forged["id"])
        )
    monkeypatch.setattr(
        ready.project, "load_array", lambda *a: pytest.fail("Forged pixels decoded")
    )
    with pytest.raises(ValueError, match="registered native source calibration"):
        if route == "read":
            ready.project.result(forged["id"])
        elif route == "view":
            ready.wb.result_view({"result_id": forged["id"]})
        elif route == "review":
            ready.project.review(forged["id"], forged["revision_hash"], "reviewed")
        else:
            export_research_result(
                ready.project, forged["id"], forged["revision_hash"], tmp_path / "bad-export"
            )


def test_native_disposable_missing_store_fails_and_reaps_child(ready, monkeypatch):
    job = submit_job(ready.wb, ready.request, "native-child", "tissue_model_preview")
    children = []
    popen = integration.subprocess.Popen

    def launch(command, **kwargs):
        assert command[-6:-2] == [
            "--cpu-seconds",
            "600",
            "--memory-bytes",
            str(ready.request["working_bytes"]),
        ]
        assert command[-2:] == ["--supervisor-pid", str(integration.os.getpid())]
        assert kwargs["start_new_session"] is True
        child = popen(command, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(integration.subprocess, "Popen", launch)
    with pytest.raises(ValueError, match="durable job state is failed"):
        integration.run_disposable(ready.project, job["id"])
    assert len(children) == 1 and children[0].poll() is not None
    assert ready.project.job(job["id"])["state"] == "failed"
    assert ready.project.job(job["id"])["result_ids"] == []
    assert ready.project.list_results() == []


def test_native_cancelled_job_does_not_spawn(ready, monkeypatch):
    job = submit_job(ready.wb, ready.request, "cancel-native", "tissue_model_preview")
    cancel_job(ready.project, job["id"])
    monkeypatch.setattr(integration.subprocess, "Popen", lambda *a, **k: pytest.fail("Spawned"))
    assert integration.run_disposable(ready.project, job["id"])["job"]["state"] == "cancelled"


def test_cancellation_during_inference_prevents_preview_publication(ready, monkeypatch):
    job = submit_job(ready.wb, ready.request, "cancel-during-model", "tissue_model_preview")

    def cancelled_inference(*args, **kwargs):
        cancel_job(ready.project, job["id"])
        return fixtures.fake_inference(*args, **kwargs)

    monkeypatch.setattr(tissue.backend, "infer_puma", cancelled_inference)
    with pytest.raises(ValueError, match="exact running job"):
        run_job(ready.wb, job["id"])
    assert ready.project.job(job["id"])["state"] == "cancelled"
    with ready.project.connection() as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM metadata WHERE key LIKE ?", (tissue.PREVIEW_PREFIX + "%",)
            ).fetchone()[0]
            == 0
        )
    assert ready.project.list_results() == []


def test_global_native_status_and_import_are_path_free_no_inference(ready, monkeypatch):
    assert (
        worker.dispatch("tissue_model_profiles", {})["profiles"][0]["store"]["state"] == "missing"
    )
    calls = []
    monkeypatch.setattr(
        integration.store, "import_puma_weights", lambda *a, **k: calls.append((a, k))
    )
    output = worker.dispatch(
        "tissue_model_import",
        {
            "profile_id": tissue.PUMA_PROFILE_ID,
            "weights_path": "/native/weights",
            "receipt_path": "/native/receipt",
        },
    )
    assert len(calls) == 1 and calls[0][0] == ("/native/weights", "/native/receipt")
    assert "/native" not in canonical_json(output)
    from loci_engine.research_rpc import dispatch_research

    bridged = dispatch_research(
        "research_execute",
        {
            "project": str(ready.project.root),
            "operation": "tissue_model_import",
            "request": {
                "profile_id": tissue.PUMA_PROFILE_ID,
                "weights_path": "/native/weights",
                "receipt_path": "/native/receipt",
            },
        },
    )
    assert len(calls) == 2 and calls[1][0] == ("/native/weights", "/native/receipt")
    assert "/native" not in canonical_json(bridged)
    with pytest.raises(ValueError):
        ready.wb.execute("tissue_model_import", {})


@pytest.mark.parametrize("state", ["missing", "invalid", "provisioned-unverified"])
def test_source_status_reports_managed_metadata_without_verifying_weights(
    ready, monkeypatch, state
):
    calls = []

    def inspect(root, *, check, verify):
        calls.append(verify)
        check()
        return integration.store._status(state)

    monkeypatch.setattr(integration.store, "inspect_store", inspect)
    monkeypatch.setattr(
        integration.store, "resolve_approved_weights", lambda *a, **k: pytest.fail("Weight resolve")
    )
    monkeypatch.setattr(
        integration.store, "_stream", lambda *a, **k: pytest.fail("Weight file hash")
    )
    monkeypatch.setattr(ready.wb, "_session", lambda *a: pytest.fail("Source decode"))
    output = ready.wb.execute("tissue_model_status", ready.request)
    assert calls == [False]
    assert output["store"]["state"] == state
    assert output["status"]["weights"] == {"status": state, "verified": False}
    assert output["status"]["ready"] is False
    assert output["status"]["model_execution_performed"] is False
