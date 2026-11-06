"""Reusable-method authority, provenance and cold byte validation.

All execution/qualification fixtures are explicitly simulated. These tests do
not qualify Wasmtime, run imported code, or provide scientific validation.
"""

import base64
import copy
import importlib.util
import json
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import pytest
import test_research_morphometrics as morphology_fixtures
from test_method_protocol import manifest, module_bytes

from loci_engine import method_protocol as protocol
from loci_engine import method_runtime as runtime
from loci_engine import research_methods as methods
from loci_engine.research_project import ResearchProject, canonical_json

make_parent = morphology_fixtures.make_parent
rehash = morphology_fixtures.rehash


def package_file(tmp_path, *, prediction=False):
    module = module_bytes()
    metadata = manifest(module)
    if prediction:
        metadata["metrics"][0]["kind"] = "prediction"
        metadata["metrics"][0]["unit"] = "score"
    package = {
        "schema": methods.PACKAGE_SCHEMA,
        "manifest": metadata,
        "module_base64": base64.b64encode(module).decode(),
    }
    path = tmp_path / ("prediction.json" if prediction else "method.json")
    path.write_text(json.dumps(package))
    return path, package


@pytest.fixture
def setup_method(tmp_path, make_parent):
    wb, parent, geometry, labels, source = make_parent()
    path, package = package_file(tmp_path)
    imported = methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY)
    request = {
        "method_id": imported["method_id"],
        "manifest_sha256": imported["manifest_sha256"],
        "module_sha256": imported["module_sha256"],
        "result_id": parent["id"],
        "revision_hash": parent["revision_hash"],
        "raw_channels": [0],
        "working_bytes": 32 * 1024**2,
    }
    flight = methods.preflight(wb, request)
    return wb, parent, request, flight, source


def external_run(tmp_path, setup_method):
    wb, parent, request, flight, _ = setup_method
    ids = flight["preflight"]["label_ids"]
    output = struct.pack("<8sII", protocol.OUTPUT_MAGIC, len(ids), 1)
    output += b"".join(
        struct.pack("<Id", label, float(index + 1)) for index, label in enumerate(ids)
    )
    path = tmp_path / "output.bin"
    path.write_bytes(output)
    grant = methods.create_output_grant(
        wb,
        path,
        {**request, "preflight_hash": flight["preflight_hash"]},
        authority=methods.NATIVE_AUTHORITY,
    )
    run = {
        **request,
        "preflight_hash": flight["preflight_hash"],
        "mode": "adopt-external",
        "output_grant_id": grant["output_grant_id"],
    }
    return run, output, path


def publish(wb, parent, request, *, check=None):
    job = wb.project.submit(
        "method_run",
        {"source_id": parent["source_id"], "task_request": request},
        f"method-{len(wb.project.list_jobs())}",
    )
    wb.project.update_job(job["id"], expected_state="queued", state="running")
    output = methods.execute_method_run(wb, request, job_id=job["id"], publication_guard=check)
    return wb.project.result(output["result"]["id"]), job


def test_import_is_data_only_owned_and_idempotent(tmp_path, make_parent, monkeypatch):
    wb, *_ = make_parent()
    path, package = package_file(tmp_path)
    monkeypatch.setattr(
        runtime, "execute_method", lambda *a, **k: pytest.fail("execution on import")
    )
    monkeypatch.setattr(
        runtime, "compile_method", lambda *a, **k: pytest.fail("compilation on import")
    )
    result = methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY)
    path.unlink()
    saved = methods.get_method(wb, {"method_id": result["method_id"]})
    assert saved["manifest"] == package["manifest"]
    assert saved["rights_status"] == "not-reviewed"
    assert "module_base64" not in canonical_json(saved)
    assert methods.list_methods(wb, {"offset": 0, "limit": 1})["methods"] == [saved]
    path.write_text(json.dumps(package))
    assert methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY) == saved


@pytest.mark.parametrize("authority", [None, {}, {"approved": True}, "native"])
def test_json_cannot_issue_native_authority(tmp_path, make_parent, authority):
    wb, *_ = make_parent()
    path, _ = package_file(tmp_path)
    with pytest.raises(PermissionError):
        methods.import_package(wb, path, authority=authority)


def test_import_rejects_symlink_duplicate_keys_and_package_authority(tmp_path, make_parent):
    wb, *_ = make_parent()
    path, package = package_file(tmp_path)
    link = tmp_path / "linked.json"
    link.symlink_to(path)
    with pytest.raises(ValueError, match="symlink"):
        methods.import_package(wb, link, authority=methods.NATIVE_AUTHORITY)
    path.write_text('{"schema":1,"schema":2}')
    with pytest.raises(ValueError, match="JSON"):
        methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY)
    package["approval"] = {"accepted": True}
    path.write_text(json.dumps(package))
    with pytest.raises(ValueError, match="package"):
        methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY)


def test_preflight_exact_binding_and_native_input_export(tmp_path, setup_method):
    wb, parent, request, flight, _ = setup_method
    accepted = methods.validate_request(wb, request)
    binding = flight["preflight"]["input_binding"]
    assert binding["selection"] == parent["provenance"]["selection"]
    assert binding["series"] == 0 and binding["raw_channels"] == [0]
    destination = tmp_path / "method-input.zip"
    receipt = methods.export_input(
        wb,
        destination,
        {**request, "preflight_hash": flight["preflight_hash"]},
        authority=methods.NATIVE_AUTHORITY,
    )
    with zipfile.ZipFile(destination) as archive:
        assert set(archive.namelist()) == {
            "input.bin",
            "binding.json",
            "manifest.json",
            "module.wasm",
            "receipt.json",
        }
        assert archive.read("input.bin") == accepted["snapshot"].buffer
        assert json.loads(archive.read("binding.json")) == flight["preflight"]
        assert receipt["input_sha256"] == protocol.sha256(archive.read("input.bin"))
        assert "authority" not in " ".join(archive.namelist())
    assert receipt["execution"] == "not-performed"
    before = destination.read_bytes()
    with pytest.raises(ValueError):
        methods.export_input(
            wb,
            destination,
            {**request, "preflight_hash": flight["preflight_hash"]},
            authority=methods.NATIVE_AUTHORITY,
        )
    assert destination.read_bytes() == before


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r.update(revision_hash="0" * 64),
        lambda r: r.update(module_sha256="0" * 64),
        lambda r: r.update(raw_channels=[0, 0]),
        lambda r: r.update(raw_channels=[1]),
        lambda r: r.update(working_bytes=1024**2),
    ],
)
def test_preflight_refuses_stale_or_unscoped_inputs(setup_method, change):
    wb, _, request, *_ = setup_method
    request = copy.deepcopy(request)
    change(request)
    with pytest.raises(ValueError):
        methods.preflight(wb, request)


def test_adoption_retains_exact_bytes_rows_and_cold_reopen_without_source_decode(
    tmp_path, setup_method, monkeypatch
):
    wb, parent, request, flight, source = setup_method
    run, output, path = external_run(tmp_path, setup_method)
    path.unlink()  # Native grant owns copied output bytes, never a stale external path.
    result, job = publish(wb, parent, run)
    assert result["kind"] == methods.KIND
    assert wb.project.job(job["id"])["state"] == "succeeded"
    assert wb.project.review_state(result["id"]) is None
    for original, row in zip(
        parent["provenance"]["measurements"], result["provenance"]["measurements"], strict=True
    ):
        assert {k: v for k, v in row.items() if k != "controlled_method"} == original
    record = result["provenance"]["controlled_method"]
    assert record["result"]["origin"] == "adopted-external"
    assert record["result"]["runtime"] is None
    arrays = {k: wb.project.load_array(d) for k, d in result["arrays"].items()}
    assert arrays["method_output"].tobytes() == output
    methods.validate_arrays(result, arrays, parents={parent["id"]: parent})
    safe = methods.public_summary(result)
    assert "module_base64" not in canonical_json(safe) and str(source) not in canonical_json(safe)
    monkeypatch.setattr(
        wb, "load_scalar", lambda *a, **k: pytest.fail("source pixels decoded on cold query")
    )
    monkeypatch.setattr(
        runtime, "execute_method", lambda *a, **k: pytest.fail("code executed on cold query")
    )
    reopened = ResearchProject(wb.project.root).result(result["id"])
    assert reopened == result
    query = methods.query_result(
        wb,
        {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "offset": 0,
            "limit": 1,
        },
    )
    assert len(query["rows"]) == 1 and query["next_offset"] == 1
    assert query["metrics"][0]["unit"] == "pixel"
    assert methods.metric_values(result["provenance"]["measurements"][0])


def test_native_rights_evidence_and_revocation_are_separate_from_packages(setup_method):
    wb, _, request, *_ = setup_method
    review = {k: request[k] for k in ("method_id", "manifest_sha256", "module_sha256")}
    review.update(
        decision="approved", reviewer="Fixture reviewer", evidence="Fixture license review only"
    )
    approved = methods.review_rights(wb, review, authority=methods.NATIVE_AUTHORITY)
    assert approved["rights_status"] == "approved"
    assert approved["rights_evidence_sha256"] == protocol.sha256(review["evidence"].encode())
    assert "Fixture license review" not in canonical_json(approved)
    methods.review_rights(
        wb,
        {**review, "decision": "revoked", "evidence": "Fixture revoked"},
        authority=methods.NATIVE_AUTHORITY,
    )
    assert methods.get_method(wb, {"method_id": request["method_id"]})["rights_status"] == "revoked"


def test_stale_preflight_wrong_job_and_cancellation_never_publish(tmp_path, setup_method):
    wb, parent, *_ = setup_method
    run, _, _ = external_run(tmp_path, setup_method)
    with pytest.raises(ValueError, match="preflight"):
        publish(wb, parent, {**run, "preflight_hash": "0" * 64})
    with pytest.raises(ValueError, match="durable"):
        methods.execute_method_run(wb, run)
    before = len(wb.project.list_results())

    def cancel():
        raise PermissionError("policy revoked")

    with pytest.raises(PermissionError, match="revoked"):
        publish(wb, parent, run, check=cancel)
    assert len(wb.project.list_results()) == before


@pytest.mark.parametrize("artifact", ["labels", "method_raw", "method_module", "method_output"])
def test_cold_integrity_refuses_changed_retained_bytes(tmp_path, setup_method, artifact):
    wb, parent, *_ = setup_method
    run, _, _ = external_run(tmp_path, setup_method)
    result, _ = publish(wb, parent, run)
    arrays = {k: np.array(wb.project.load_array(d)) for k, d in result["arrays"].items()}
    arrays[artifact].flat[0] += 1
    with pytest.raises(ValueError, match="bytes"):
        methods.validate_arrays(result, arrays, parents={parent["id"]: parent})


def test_rehashed_output_and_parent_tampering_are_refused(tmp_path, setup_method):
    wb, parent, *_ = setup_method
    run, _, _ = external_run(tmp_path, setup_method)
    result, _ = publish(wb, parent, run)
    tampered = copy.deepcopy(result)
    tampered["provenance"]["measurements"][0]["controlled_method"]["pixel_count"] = 99
    rehash(tampered)
    with pytest.raises(ValueError, match="values"):
        methods.validate_record(tampered)
    changed_parent = copy.deepcopy(parent)
    changed_parent["provenance"]["measurements"][0]["measure"] = 99
    rehash(changed_parent)
    with pytest.raises(ValueError, match="parent"):
        methods.validate_parents(result, {parent["id"]: changed_parent})


def test_prediction_declaration_stays_prediction(tmp_path, setup_method):
    wb, parent, request, _, source = setup_method
    path, _ = package_file(tmp_path, prediction=True)
    imported = methods.import_package(wb, path, authority=methods.NATIVE_AUTHORITY)
    request.update({k: imported[k] for k in ("method_id", "manifest_sha256", "module_sha256")})
    flight = methods.preflight(wb, request)
    run, _, _ = external_run(tmp_path, (wb, parent, request, flight, source))
    result, _ = publish(wb, parent, run)
    assert methods.metric_descriptors(result)[0]["kind"] == "prediction"
    assert result["provenance"]["controlled_method"]["result"]["scientific_review"] == "pending"


def identity():
    sources = methods._qualification_sources()
    return {
        "runtime_profile": runtime.RUNTIME_PROFILE,
        "wasmtime_version": runtime.WASMTIME_VERSION,
        "native_sha256": "a" * 64,
        "python_version": [3, 13, 12],
        "python_executable_sha256": "b" * 64,
        "platform": "linux",
        "machine": "x86_64",
        "numpy_version": np.__version__,
        "protocol_sha256": sources["loci_engine/method_protocol.py"],
        "runtime_sha256": sources["loci_engine/method_runtime.py"],
    }


def qualification_receipt():
    ident = identity()
    fixture_method, fixture_input, fixture_output = protocol.qualification_fixture()
    compiled = {
        k: ident[k]
        for k in ("runtime_profile", "wasmtime_version", "native_sha256", "python_version")
    }
    compiled.update(mode="compile", limits=runtime._limits_record())
    compiled.update(
        schema="loci.controlled-method-execution/v1",
        module_sha256=fixture_method.module_sha256,
        input_sha256=protocol.sha256(b""),
        output_sha256=protocol.sha256(b""),
    )
    executed = protocol.adopt_method_output(
        fixture_method,
        fixture_input,
        fixture_output,
        expected_output_sha256=protocol.sha256(fixture_output),
    )
    executed.update(
        origin="executed-local-child",
        rights_evidence_sha256="a" * 64,
        runtime={
            **compiled,
            "mode": "execute",
            "input_sha256": fixture_input.sha256,
            "output_sha256": protocol.sha256(fixture_output),
        },
    )
    expected_suite = methods._qualification_suite()
    total = sum(expected_suite.values())
    junit = ET.Element("testsuites")
    suite = ET.SubElement(
        junit, "testsuite", name="pytest", tests=str(total), failures="0", errors="0", skipped="0"
    )
    for (module, name), count in expected_suite.items():
        for index in range(count):
            ET.SubElement(
                suite,
                "testcase",
                classname=module,
                name=name if count == 1 else f"{name}[fixture{index}]",
            )
    junit_bytes = ET.tostring(junit)
    return {
        "schema": "loci.controlled-method-linux-qa/v1",
        "passed": True,
        "pytest_returncode": 0,
        "checks": dict.fromkeys(
            ("tests", "executed", "address_space", "cpu", "file_size", "fuel", "stack", "heap"),
            True,
        ),
        "pytest_summary": {
            "tests": total,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
            "nested_cancellation": True,
            "parent_death": True,
        },
        "packages": {"wasmtime": runtime.WASMTIME_VERSION, "numpy": np.__version__},
        "native_sha256": ident["native_sha256"],
        "python_executable_sha256": ident["python_executable_sha256"],
        "source_sha256": methods._qualification_sources(),
        "junit_xml_base64": base64.b64encode(junit_bytes).decode(),
        "junit_xml_sha256": protocol.sha256(junit_bytes),
        "limits": runtime._limits_record(),
        "job_id": "fixture-pbs",
        "platform": "Linux-fixture",
        "compile": compiled,
        "execute": executed,
        "probes": {
            "address-space": {
                "returncode": 0,
                "seconds": 0.1,
                "stdout": json.dumps(
                    {"refused": True, "limits": [runtime.ADDRESS_SPACE_BYTES] * 2}
                ),
                "stderr": "",
            },
            "cpu": {"returncode": -9, "seconds": 0.1, "stdout": "", "stderr": ""},
            "file-size": {
                "returncode": 0,
                "seconds": 0.1,
                "stdout": '{"refused":true}',
                "stderr": "",
            },
            "fuel": {"returncode": 0, "seconds": 0.1, "stdout": "fuel consumed", "stderr": ""},
            "stack": {
                "returncode": 0,
                "seconds": 0.1,
                "stdout": "call stack exhausted",
                "stderr": "",
            },
            "heap": {
                "returncode": 0,
                "seconds": 0.1,
                "stdout": "Invalid method output length",
                "stderr": "",
            },
        },
        "wasmtime_wheel_sha256": "cc14c3a17654e0394e0225b11813532ef0cd7bd1e222a0c5494cdedaabeddac4",
    }


def test_native_qualification_missing_complete_tampered_and_stale(tmp_path, monkeypatch):
    monkeypatch.setattr(methods, "_qualification_directory", lambda: tmp_path / "trust")
    monkeypatch.setattr(
        runtime, "runtime_availability", lambda: {"available": True, "reason": None}
    )
    monkeypatch.setattr(methods, "_runtime_identity", identity)
    assert methods.qualified_runtime() is None
    path = tmp_path / "linux-qa.json"
    receipt = qualification_receipt()
    receipt["pytest_summary"]["parent_death"] = False
    path.write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="summary"):
        methods.install_runtime_qualification(path, authority=methods.NATIVE_AUTHORITY)
    path.write_text(json.dumps(qualification_receipt()))
    methods.install_runtime_qualification(path, authority=methods.NATIVE_AUTHORITY)
    accepted = methods.qualified_runtime()
    assert accepted["evidence_sha256"] == protocol.sha256(path.read_bytes())
    monkeypatch.setattr(
        methods, "_runtime_identity", lambda: {**identity(), "native_sha256": "0" * 64}
    )
    with pytest.raises(ValueError, match="identity changed"):
        methods.qualified_runtime()
    monkeypatch.setattr(methods, "_runtime_identity", identity)
    target = tmp_path / "trust" / "accepted.json"
    record = json.loads(target.read_text())
    record["evidence_sha256"] = "0" * 64
    target.write_text(json.dumps(record))
    with pytest.raises(ValueError, match="bytes"):
        methods.qualified_runtime()


@pytest.mark.parametrize("phase", ["setup", "fixture"])
def test_linux_harness_retains_failed_receipt_for_setup_and_fixture_errors(
    tmp_path, monkeypatch, phase
):
    # Import only the authored harness definitions; main never runs on import.
    monkeypatch.setattr(sys, "path", list(sys.path))
    script = methods._qualification_source_paths()["controlled_method_linux.py"]
    spec = importlib.util.spec_from_file_location("controlled_method_qa_fixture", script)
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    monkeypatch.setattr(harness, "ROOT", tmp_path)
    if phase == "fixture":

        def fail_after_tests(receipt, started):
            receipt["pytest_returncode"] = 0
            receipt["source_sha256"] = {"fixture": "a" * 64}
            raise protocol.MethodContractError("Fixture failed before runtime execution")

        monkeypatch.setattr(harness, "_run_qualification", fail_after_tests)
    assert harness.main() == 1
    failed = json.loads((tmp_path / "receipt.json").read_text())
    assert failed["passed"] is False and failed["checks"]["executed"] is False
    assert failed["failure"]["type"] == (
        "FileNotFoundError" if phase == "setup" else "MethodContractError"
    )
    if phase == "fixture":
        assert failed["pytest_returncode"] == 0 and failed["source_sha256"]["fixture"] == "a" * 64


@pytest.mark.parametrize(
    "attack",
    [
        "empty-input",
        "wrong-module",
        "stale-harness",
        "stale-tests",
        "missing-junit",
        "missing-testcase",
        "missing-parent-death",
        "failed-testcase",
        "one-test",
        "junit-dtd",
        "foreign-test-module",
    ],
)
def test_qualification_rehashed_false_fixture_and_incomplete_suite_refuse(attack):
    receipt = qualification_receipt()
    if attack == "empty-input":
        receipt["execute"]["input_sha256"] = protocol.sha256(b"")
        receipt["execute"]["runtime"]["input_sha256"] = protocol.sha256(b"")
    elif attack == "wrong-module":
        receipt["compile"]["module_sha256"] = "1" * 64
        receipt["execute"]["module_sha256"] = "1" * 64
        receipt["execute"]["runtime"]["module_sha256"] = "1" * 64
    elif attack in {"stale-harness", "stale-tests"}:
        key = (
            "controlled_method_linux.py"
            if attack == "stale-harness"
            else "tests/test_method_runtime.py"
        )
        receipt["source_sha256"][key] = "0" * 64
    elif attack == "missing-junit":
        del receipt["junit_xml_base64"]
    else:
        root = ET.fromstring(base64.b64decode(receipt["junit_xml_base64"]))
        suite = root.find("testsuite")
        if attack == "missing-testcase":
            suite.remove(suite.find("testcase"))
        elif attack == "missing-parent-death":
            suite.remove(
                next(
                    case
                    for case in suite.findall("testcase")
                    if case.get("name") == "test_linux_parent_death_kills_method_child"
                )
            )
        elif attack == "failed-testcase":
            ET.SubElement(suite.find("testcase"), "failure", message="Fixture failure")
            suite.set("failures", "1")
        elif attack == "foreign-test-module":
            suite.find("testcase").set("classname", "foreign.test_method_protocol")
        elif attack == "one-test":
            for case in suite.findall("testcase")[1:]:
                suite.remove(case)
        suite.set("tests", str(len(suite.findall("testcase"))))
        receipt["pytest_summary"]["tests"] = len(suite.findall("testcase"))
        junit = ET.tostring(root)
        if attack == "junit-dtd":
            junit = (
                b'<!DOCTYPE testsuites [<!ENTITY private SYSTEM "file:///private/test">]>' + junit
            )
        receipt["junit_xml_base64"] = base64.b64encode(junit).decode()
        receipt["junit_xml_sha256"] = protocol.sha256(junit)
    with pytest.raises(ValueError):
        methods._validate_qualification_evidence(receipt, identity())


def test_product_execution_requires_rights_and_current_qualification(setup_method, monkeypatch):
    wb, parent, request, flight, _ = setup_method
    run = {**request, "preflight_hash": flight["preflight_hash"], "mode": "execute"}
    monkeypatch.setattr(
        runtime, "execute_method", lambda *a, **k: pytest.fail("unqualified execution")
    )
    with pytest.raises(PermissionError, match="rights"):
        publish(wb, parent, run)
    review = {k: request[k] for k in ("method_id", "manifest_sha256", "module_sha256")}
    methods.review_rights(
        wb,
        {**review, "decision": "approved", "reviewer": "Fixture", "evidence": "Fixture approval"},
        authority=methods.NATIVE_AUTHORITY,
    )
    monkeypatch.setattr(methods, "qualified_runtime", lambda: None)
    with pytest.raises(runtime.MethodRuntimeUnavailable):
        publish(wb, parent, run)


def test_simulated_qualified_execution_and_revocation_guard(setup_method, monkeypatch):
    wb, parent, request, flight, _ = setup_method
    review = {k: request[k] for k in ("method_id", "manifest_sha256", "module_sha256")}
    methods.review_rights(
        wb,
        {**review, "decision": "approved", "reviewer": "Fixture", "evidence": "Fixture approval"},
        authority=methods.NATIVE_AUTHORITY,
    )
    qualified = {
        "schema": "loci.controlled-method-runtime-qualification/v1",
        "identity": identity(),
        "evidence_sha256": "a" * 64,
        "accepted_at": "fixture",
    }
    monkeypatch.setattr(methods, "qualified_runtime", lambda: qualified)

    def simulated(method, snapshot, *, approval, check):
        check()
        output = struct.pack("<8sII", protocol.OUTPUT_MAGIC, len(snapshot.label_ids), 1)
        output += b"".join(struct.pack("<Id", label, 1.0) for label in snapshot.label_ids)
        result = protocol.adopt_method_output(
            method, snapshot, output, expected_output_sha256=protocol.sha256(output)
        )
        ident = identity()
        receipt = {
            k: ident[k]
            for k in ("runtime_profile", "wasmtime_version", "native_sha256", "python_version")
        }
        receipt.update(
            schema="loci.controlled-method-execution/v1",
            mode="execute",
            module_sha256=method.module_sha256,
            input_sha256=snapshot.sha256,
            output_sha256=protocol.sha256(output),
            limits=runtime._limits_record(),
        )
        result.update(
            origin="executed-local-child",
            runtime=receipt,
            rights_evidence_sha256=approval.rights_evidence_sha256,
        )
        return result

    monkeypatch.setattr(runtime, "execute_method", simulated)
    run = {**request, "preflight_hash": flight["preflight_hash"], "mode": "execute"}
    result, _ = publish(wb, parent, run)
    assert result["provenance"]["controlled_method"]["result"]["origin"] == "executed-local-child"

    def revoked(method, snapshot, *, approval, check):
        methods.review_rights(
            wb,
            {
                **review,
                "decision": "revoked",
                "reviewer": "Fixture",
                "evidence": "Revoked during simulated call",
            },
            authority=methods.NATIVE_AUTHORITY,
        )
        return simulated(method, snapshot, approval=approval, check=check)

    monkeypatch.setattr(runtime, "execute_method", revoked)
    before = len(wb.project.list_results())
    with pytest.raises(PermissionError, match="rights"):
        publish(wb, parent, run)
    assert len(wb.project.list_results()) == before
