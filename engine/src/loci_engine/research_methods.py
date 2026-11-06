"""Native-owned reusable methods and exact-parent external output adoption.

Import is data-only. Packages, rights authority and output grants are separate
records. Only the trusted native caller holds NATIVE_AUTHORITY; a JSON request
cannot supply it. Imported studies never restore live authority or grants.
"""

from __future__ import annotations

import ast
import base64
import binascii
import copy
import hashlib
import os
import platform
import signal
import stat
import struct
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np

from . import method_protocol as protocol
from . import method_runtime as runtime
from . import research_morphometrics as morphology
from .quantitative import MAX_WORKING_BYTES, integer
from .research_project import canonical_json, checked_id, checked_text, parse_json, timestamp

KIND = "controlled-method"
SCHEMA = "loci.controlled-method-derivative/v1"
PACKAGE_SCHEMA = "loci.controlled-method-package/v1"
PACKAGE_KIND = "controlled_method"
AUTHORITY_KIND = "controlled_method_authority"
OUTPUT_KIND = "controlled_method_output_grant"
LOCAL_DOCUMENT_KINDS = frozenset({AUTHORITY_KIND, OUTPUT_KIND})
REQUEST_KEYS = {
    "method_id",
    "manifest_sha256",
    "module_sha256",
    "result_id",
    "revision_hash",
    "raw_channels",
    "working_bytes",
}
RUN_KEYS = REQUEST_KEYS | {"preflight_hash", "mode", "output_grant_id"}
ARRAY_NAMES = {"image", "labels", "method_raw", "method_module", "method_output"}
NATIVE_AUTHORITY = object()
MAX_PACKAGE_BYTES = 2 * protocol.MAX_MODULE_BYTES + protocol.MAX_METADATA_BYTES
CORRECTION_REFUSAL = "Correct or annotate the underlying label result and rerun the method"


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _exact(value, keys, name):
    if type(value) is not dict or set(value) != keys:
        raise ValueError(f"Invalid {name} fields")


def _native(authority):
    if authority is not NATIVE_AUTHORITY:
        raise PermissionError("This operation requires explicit trusted native authority")


def _same(a, b):
    return canonical_json(a) == canonical_json(b)


def _binding(result):
    return {"result_id": result["id"], "revision_hash": result["revision_hash"]}


def _read_file(path, maximum):
    """Copy bounded regular bytes; reject component links and replacement races."""
    try:
        path = Path(path)
        if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError("Selected method input must be an absolute file without symlinks")
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= maximum:
            raise ValueError("Selected method input exceeds its bounded regular-file contract")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as handle:
            opened = os.fstat(handle.fileno())
            value = handle.read(maximum + 1)
            after = os.fstat(handle.fileno())

        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

        if (
            identity(before) != identity(opened)
            or identity(opened) != identity(after)
            or identity(path.lstat()) != identity(before)
            or len(value) != before.st_size
        ):
            raise ValueError("Selected method input changed during bounded import")
        return value
    except OSError as exc:
        raise ValueError("Selected method input is unavailable for verification") from exc


def _decode(value, maximum):
    if type(value) is not str or len(value) > 4 * ((maximum + 2) // 3):
        raise ValueError("Invalid bounded method artifact encoding")
    try:
        result = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid method artifact encoding") from exc
    if len(result) > maximum or base64.b64encode(result).decode("ascii") != value:
        raise ValueError("Noncanonical or oversized method artifact encoding")
    return result


def _package(package):
    from .research_interchange import _reject_absolute_strings

    _exact(package, {"schema", "manifest", "module_base64"}, "method package")
    if package["schema"] != PACKAGE_SCHEMA:
        raise ValueError("Unsupported method package schema")
    _reject_absolute_strings(package["manifest"], "Controlled method manifest")
    module = _decode(package["module_base64"], protocol.MAX_MODULE_BYTES)
    return protocol.register_method(package["manifest"], module)


def validate_package_document(document):
    """Pure portable package validation; grants and approvals are never packages."""
    _exact(document, {"schema", "package", "manifest_sha256", "module_sha256"}, "saved method")
    if document["schema"] != "loci.saved-controlled-method/v1":
        raise ValueError("Unsupported saved method schema")
    method = _package(document["package"])
    if (
        method.manifest_sha256 != document["manifest_sha256"]
        or method.module_sha256 != document["module_sha256"]
    ):
        raise ValueError("Saved method identity changed")
    return method


def _document(project, kind, identity):
    documents = project.documents(kind, document_id=checked_id(identity))
    if len(documents) != 1:
        raise ValueError("Exact method document is unavailable")
    return documents[0]


def _method(project, identity):
    envelope = _document(project, PACKAGE_KIND, identity)
    method = validate_package_document(envelope["data"])
    if envelope["revision"] != 1 or envelope["id"] != method.manifest_sha256[:32]:
        raise ValueError("Saved methods are immutable and bound to their manifest")
    return method, envelope["data"]


def import_package(workbench, path, *, authority):
    _native(authority)
    content = _read_file(path, MAX_PACKAGE_BYTES)
    try:
        package = parse_json(content.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("Selected method package is not valid bounded JSON") from exc
    method = _package(package)
    data = {
        "schema": "loci.saved-controlled-method/v1",
        "package": package,
        "manifest_sha256": method.manifest_sha256,
        "module_sha256": method.module_sha256,
    }
    identity = method.manifest_sha256[:32]
    existing = workbench.project.documents(PACKAGE_KIND, document_id=identity)
    if existing:
        if len(existing) != 1 or not _same(existing[0]["data"], data):
            raise ValueError("Method identity is already occupied by different bytes")
    else:
        workbench.project.put_document(PACKAGE_KIND, identity, data, expected_revision=0)
    return get_method(workbench, {"method_id": identity})


def _authority(project, method_id, method):
    envelopes = project.documents(AUTHORITY_KIND, document_id=method_id)
    if not envelopes:
        return None
    if len(envelopes) != 1:
        raise ValueError("Ambiguous method rights authority")
    envelope = envelopes[0]
    record = envelope["data"]
    _exact(record, {"schema", "manifest_sha256", "module_sha256", "events"}, "rights authority")
    events = record["events"]
    if (
        record["schema"] != "loci.controlled-method-authority/v1"
        or record["manifest_sha256"] != method.manifest_sha256
        or record["module_sha256"] != method.module_sha256
        or type(events) is not list
        or not 1 <= len(events) <= 256
        or envelope["revision"] != len(events)
    ):
        raise ValueError("Method rights authority identity or history is invalid")
    previous = None
    for event in events:
        _exact(
            event,
            {
                "decision",
                "reviewer",
                "evidence",
                "evidence_sha256",
                "created_at",
                "previous_sha256",
                "event_sha256",
            },
            "rights event",
        )
        if event["decision"] not in {"approved", "revoked"}:
            raise ValueError("Unsupported rights authority decision")
        checked_text(event["reviewer"], "Rights reviewer", 256)
        checked_text(event["evidence"], "Rights evidence", 8192)
        checked_text(event["created_at"], "Rights review timestamp", 128)
        if (
            event["evidence_sha256"] != protocol.sha256(event["evidence"].encode())
            or event["previous_sha256"] != previous
            or event["event_sha256"]
            != _hash({k: v for k, v in event.items() if k != "event_sha256"})
        ):
            raise ValueError("Method rights evidence or audit integrity changed")
        previous = event["event_sha256"]
    return record


def review_rights(workbench, request, *, authority):
    """Native user decision with retained evidence; never an agent/package field."""
    _native(authority)
    _exact(
        request,
        {"method_id", "manifest_sha256", "module_sha256", "decision", "reviewer", "evidence"},
        "native method rights review",
    )
    method, _ = _method(workbench.project, request["method_id"])
    if (
        request["manifest_sha256"] != method.manifest_sha256
        or request["module_sha256"] != method.module_sha256
    ):
        raise ValueError("Rights decision belongs to a different method")
    if request["decision"] not in {"approved", "revoked"}:
        raise ValueError("Choose an explicit approved or revoked rights decision")
    checked_text(request["reviewer"], "Rights reviewer", 256)
    checked_text(request["evidence"], "Rights evidence", 8192)
    current = _authority(workbench.project, request["method_id"], method)
    events = copy.deepcopy(current["events"] if current else [])
    if len(events) >= 256:
        raise ValueError("Method rights audit reached its bounded event limit")
    event = {k: request[k] for k in ("decision", "reviewer", "evidence")}
    event.update(
        evidence_sha256=protocol.sha256(event["evidence"].encode()),
        created_at=timestamp(),
        previous_sha256=events[-1]["event_sha256"] if events else None,
    )
    event["event_sha256"] = _hash(event)
    events.append(event)
    data = {
        "schema": "loci.controlled-method-authority/v1",
        "manifest_sha256": method.manifest_sha256,
        "module_sha256": method.module_sha256,
        "events": events,
    }
    workbench.project.put_document(
        AUTHORITY_KIND, request["method_id"], data, expected_revision=len(events) - 1
    )
    return get_method(workbench, {"method_id": request["method_id"]})


def get_method(workbench, request):
    _exact(request, {"method_id"}, "method inspection")
    method, _ = _method(workbench.project, request["method_id"])
    record = _authority(workbench.project, request["method_id"], method)
    latest = record["events"][-1] if record else None
    return {
        "method_id": request["method_id"],
        "manifest": method.manifest(),
        "manifest_sha256": method.manifest_sha256,
        "module_sha256": method.module_sha256,
        "rights_status": latest["decision"] if latest else "not-reviewed",
        "rights_evidence_sha256": latest["evidence_sha256"] if latest else None,
        "scientific_review": "pending",
        "runtime": runtime_status(),
    }


def list_methods(workbench, request):
    _exact(request, {"offset", "limit"}, "method listing")
    offset = integer(request["offset"], "method offset", 0, 10000)
    limit = integer(request["limit"], "method limit", 1, 50)
    # Query only the requested bounded page, never materialize all module bytes.
    with workbench.project.connection() as connection:
        rows = connection.execute(
            "SELECT id FROM documents WHERE kind=? ORDER BY id LIMIT ? OFFSET ?",
            (PACKAGE_KIND, limit + 1, offset),
        ).fetchall()
    return {
        "methods": [get_method(workbench, {"method_id": row[0]}) for row in rows[:limit]],
        "next_offset": offset + limit if len(rows) > limit else None,
    }


def runtime_status():
    availability = runtime.runtime_availability()
    try:
        qualification = qualified_runtime()
    except (ValueError, OSError, runtime.MethodRuntimeUnavailable):
        qualification = None
    return {
        **availability,
        "execution_available": qualification is not None,
        "qualification": "accepted-native-evidence" if qualification else "not-established",
        "qualification_evidence_sha256": qualification["evidence_sha256"]
        if qualification
        else None,
        "execution_reason": None
        if qualification
        else availability["reason"]
        or "No current accepted native runtime qualification is installed",
    }


def _qualification_directory():
    # Code-owned local trust state, never part of a study or portable archive.
    return Path.home() / ".local" / "share" / "loci" / "controlled-method-runtime"


def _runtime_identity():
    availability = runtime.runtime_availability()
    if not availability["available"]:
        raise runtime.MethodRuntimeUnavailable(availability["reason"])
    from .working_result import _sha256_file_stable

    return {
        "runtime_profile": runtime.RUNTIME_PROFILE,
        "wasmtime_version": runtime.WASMTIME_VERSION,
        "native_sha256": runtime._native_identity(),
        "python_version": list(sys.version_info[:3]),
        "python_executable_sha256": _sha256_file_stable(
            Path(sys.executable).resolve(), reject_symlink=True
        )[0],
        "platform": sys.platform,
        "machine": platform.machine(),
        "numpy_version": np.__version__,
        "protocol_sha256": _sha256_file_stable(Path(protocol.__file__), reject_symlink=True)[0],
        "runtime_sha256": _sha256_file_stable(Path(runtime.__file__), reject_symlink=True)[0],
    }


def _qualification_source_paths():
    """Only code-owned source-tree or isolated qualification layouts are accepted."""
    package = Path(protocol.__file__).resolve().parent
    if package.parent.name == "src":
        engine = package.parent.parent
        tests = engine / "tests"
        harness = engine.parent / "scripts" / "qa" / "controlled_method_linux.py"
    else:
        tests = package.parent / "tests"
        harness = package.parent / "controlled_method_linux.py"
    return {
        "loci_engine/method_protocol.py": Path(protocol.__file__),
        "loci_engine/method_runtime.py": Path(runtime.__file__),
        "tests/test_method_protocol.py": tests / "test_method_protocol.py",
        "tests/test_method_runtime.py": tests / "test_method_runtime.py",
        "controlled_method_linux.py": harness,
    }


def _qualification_sources():
    return {
        name: protocol.sha256(_read_file(path, 512 * 1024))
        for name, path in _qualification_source_paths().items()
    }


def _qualification_suite():
    """Read current literal parameter counts from AST, never execute test source."""
    expected = {}
    paths = _qualification_source_paths()
    for filename in ("tests/test_method_protocol.py", "tests/test_method_runtime.py"):
        module = "tests." + Path(filename).stem
        tree = ast.parse(_read_file(paths[filename], 512 * 1024).decode("utf-8"))
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                raise ValueError("Qualified suite layout changed; review its named test contract")
            if not isinstance(node, ast.FunctionDef) or not node.name.startswith("test_"):
                continue
            count = 1
            for decorator in node.decorator_list:
                if not (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and decorator.func.attr == "parametrize"
                ):
                    continue
                if len(decorator.args) < 2 or not isinstance(
                    decorator.args[1], (ast.List, ast.Tuple)
                ):
                    raise ValueError(
                        "Qualification requires reviewed literal parameterized test cases"
                    )
                count *= len(decorator.args[1].elts)
            if count < 1 or (module, node.name) in expected:
                raise ValueError("Invalid or duplicate named qualification test")
            expected[module, node.name] = count
    return expected


def _validate_junit(receipt):
    xml = _decode(receipt.get("junit_xml_base64"), 2 * 1024**2)
    if protocol.sha256(xml) != receipt.get("junit_xml_sha256"):
        raise ValueError("Qualification JUnit bytes or hash changed")
    try:
        text = xml.decode("utf-8-sig")
        if "\0" in text or "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            raise ValueError("Qualification JUnit DTD/entities are forbidden")
        root = ET.fromstring(text)
    except (UnicodeError, ET.ParseError, RecursionError) as exc:
        raise ValueError("Invalid bounded qualification JUnit XML") from exc
    if sum(1 for _ in root.iter()) > 20000:
        raise ValueError("Qualification JUnit exceeds its node budget")
    if any(node.tag in {"failure", "error", "skipped"} for node in root.iter()):
        raise ValueError("Qualification JUnit contains failing or skipped outcomes")
    if root.tag == "testsuites":
        if any(child.tag != "testsuite" for child in root):
            raise ValueError("Unsupported qualification JUnit root content")
        suites = list(root)
    elif root.tag == "testsuite":
        suites = [root]
    else:
        raise ValueError("Unsupported qualification JUnit root")
    expected = _qualification_suite()
    actual, names = Counter(), set()
    for suite in suites:
        cases = suite.findall("testcase")
        if any(child.tag not in {"properties", "testcase"} for child in suite):
            raise ValueError("Unsupported qualification JUnit suite content")
        try:
            counts = {
                key: int(suite.attrib[key]) for key in ("tests", "failures", "errors", "skipped")
            }
        except (KeyError, ValueError) as exc:
            raise ValueError("Incomplete qualification JUnit counts") from exc
        if counts != {"tests": len(cases), "failures": 0, "errors": 0, "skipped": 0}:
            raise ValueError("Qualification JUnit counts or outcomes failed")
        for case in cases:
            module, name = case.get("classname"), case.get("name")
            if not isinstance(name, str) or any(
                child.tag not in {"system-out", "system-err", "properties"} for child in case
            ):
                raise ValueError(
                    "Qualification contains failing, skipped or unsupported testcase outcomes"
                )
            key = (module, name.split("[", 1)[0])
            if key not in expected or (module, name) in names:
                raise ValueError("Qualification contains unknown or duplicate named testcases")
            names.add((module, name))
            actual[key] += 1
    if dict(actual) != expected:
        raise ValueError("Qualification JUnit omits or duplicates current suite testcases")
    required = {
        ("tests.test_method_runtime", name)
        for name in (
            "test_native_outer_sigterm_unwinds_and_reaps_nested_child",
            "test_linux_parent_death_kills_method_child",
            "test_cooperative_policy_cancellation_reaps_exact_child",
        )
    }
    if not required <= set(actual):
        raise ValueError("Qualification lacks required actual cancellation/parent-death tests")
    summary = {
        "tests": sum(actual.values()),
        "failures": 0,
        "errors": 0,
        "skipped": 0,
        "nested_cancellation": True,
        "parent_death": True,
    }
    if receipt.get("pytest_summary") != summary:
        raise ValueError("Qualification summary disagrees with actual complete JUnit suite")


def _validate_qualification_evidence(receipt, identity):
    """Accept only complete source-bound Linux QA; old pending reports refuse."""
    if type(receipt) is not dict:
        raise ValueError("Invalid runtime qualification receipt")
    if receipt.get("source_sha256") != _qualification_sources():
        raise ValueError(
            "Qualification source/test/harness hashes differ from current qualified layout"
        )
    _validate_junit(receipt)
    checks = {"tests", "executed", "address_space", "cpu", "file_size", "fuel", "stack", "heap"}
    summary = receipt.get("pytest_summary", {})
    sources = receipt.get("source_sha256", {})
    compile_receipt = receipt.get("compile", {})
    executed = receipt.get("execute", {})
    if any(
        type(value) is not dict
        for value in (
            summary,
            sources,
            compile_receipt,
            executed,
            receipt.get("packages"),
            receipt.get("probes"),
        )
    ):
        raise ValueError("Incomplete structured runtime qualification evidence")
    if (
        receipt.get("schema") != "loci.controlled-method-linux-qa/v1"
        or receipt.get("passed") is not True
        or receipt.get("pytest_returncode") != 0
        or type(receipt.get("checks")) is not dict
        or set(receipt["checks"]) != checks
        or any(value is not True for value in receipt["checks"].values())
        or type(summary.get("tests")) is not int
        or summary["tests"] < 1
        or any(summary.get(key) != 0 for key in ("failures", "errors", "skipped"))
        or receipt.get("packages", {}).get("wasmtime") != runtime.WASMTIME_VERSION
        or receipt.get("packages", {}).get("numpy") != identity["numpy_version"]
        or receipt.get("native_sha256") != identity["native_sha256"]
        or receipt.get("python_executable_sha256") != identity["python_executable_sha256"]
        or sources.get("loci_engine/method_protocol.py") != identity["protocol_sha256"]
        or sources.get("loci_engine/method_runtime.py") != identity["runtime_sha256"]
        or receipt.get("limits") != runtime._limits_record()
        or not receipt.get("job_id")
        or not str(receipt.get("platform", "")).startswith("Linux")
        or identity["platform"] != "linux"
        or compile_receipt.get("mode") != "compile"
        or executed.get("origin") != "executed-local-child"
        or executed.get("scientific_review") != "pending"
    ):
        raise ValueError(
            "Linux runtime qualification evidence is incomplete, stale or unsuccessful"
        )
    for actual in (compile_receipt, executed.get("runtime", {})):
        _exact(
            actual,
            {
                "schema",
                "mode",
                "runtime_profile",
                "wasmtime_version",
                "native_sha256",
                "python_version",
                "module_sha256",
                "input_sha256",
                "output_sha256",
                "limits",
            },
            "qualified execution receipt",
        )
        if (
            actual["schema"] != "loci.controlled-method-execution/v1"
            or actual.get("runtime_profile") != identity["runtime_profile"]
            or actual.get("wasmtime_version") != identity["wasmtime_version"]
            or actual.get("native_sha256") != identity["native_sha256"]
            or actual.get("python_version") != identity["python_version"]
            or actual.get("limits") != runtime._limits_record()
        ):
            raise ValueError("Qualification runtime identity differs from this installed runtime")
        for key in ("module_sha256", "input_sha256", "output_sha256"):
            protocol._hash(actual[key], key)
    native_execution = executed["runtime"]
    fixture_method, fixture_input, expected_output = protocol.qualification_fixture()
    expected_result = protocol.adopt_method_output(
        fixture_method,
        fixture_input,
        expected_output,
        expected_output_sha256=protocol.sha256(expected_output),
    )
    if (
        compile_receipt["input_sha256"] != protocol.sha256(b"")
        or compile_receipt["output_sha256"] != protocol.sha256(b"")
        or native_execution["mode"] != "execute"
        or executed.get("output_sha256") != protocol.sha256(expected_output)
        or compile_receipt["module_sha256"] != fixture_method.module_sha256
        or executed.get("manifest_sha256") != fixture_method.manifest_sha256
        or executed.get("input_sha256") != fixture_input.sha256
        or executed.get("abi") != protocol.ABI
        or executed.get("schema") != "loci.controlled-method-result/v1"
        or executed.get("metrics") != fixture_method.manifest()["metrics"]
        or compile_receipt["module_sha256"] != executed.get("module_sha256")
        or any(
            native_execution[k] != executed.get(k)
            for k in ("module_sha256", "input_sha256", "output_sha256")
        )
        or executed.get("rows")
        != [{"label_id": 7, "values": [2.0]}, {"label_id": 42, "values": [3.0]}]
        or len(executed.get("metrics", [])) != 1
        or executed["metrics"][0].get("kind") != "measurement"
        or executed["metrics"][0].get("unit") != "pixel"
    ):
        raise ValueError("Qualification did not retain the exact scalar ABI fixture outputs")
    if any(
        executed.get(key) != expected_result[key]
        for key in expected_result
        if key not in {"origin", "runtime"}
    ):
        raise ValueError("Qualification fixture manifest/input/output identity or values disagree")
    protocol._hash(executed.get("rights_evidence_sha256"), "qualification fixture review evidence")
    probes = receipt["probes"]
    _exact(
        probes,
        {"address-space", "cpu", "file-size", "fuel", "stack", "heap"},
        "qualification probes",
    )
    for probe in probes.values():
        _exact(probe, {"returncode", "seconds", "stdout", "stderr"}, "qualification probe outcome")
        if type(probe["returncode"]) is not int or probe["stderr"]:
            raise ValueError("Qualification probe failed unexpectedly")
    if (
        probes["address-space"]["returncode"] != 0
        or probes["cpu"]["returncode"] != -signal.SIGKILL
        or probes["file-size"]["returncode"] not in {0, -signal.SIGXFSZ}
        or any(probes[name]["returncode"] != 0 for name in ("fuel", "stack", "heap"))
        or "fuel consumed" not in probes["fuel"]["stdout"]
        or "call stack exhausted" not in probes["stack"]["stdout"]
        or "Invalid method output length" not in probes["heap"]["stdout"]
    ):
        raise ValueError("Qualification hard-limit or native trap evidence failed")
    address_probe = parse_json(probes["address-space"]["stdout"])
    if (
        address_probe.get("refused") is not True
        or address_probe.get("limits") != [runtime.ADDRESS_SPACE_BYTES] * 2
    ):
        raise ValueError("Qualification did not establish its actual hard address-space cap")
    if (
        probes["file-size"]["returncode"] == 0
        and parse_json(probes["file-size"]["stdout"]).get("refused") is not True
    ):
        raise ValueError("Qualification did not establish its actual hard file-size cap")
    expected_wheels = {
        "x86_64": "cc14c3a17654e0394e0225b11813532ef0cd7bd1e222a0c5494cdedaabeddac4",
        "aarch64": "675484e525c028dc02762b777f1db4477ea70caa3fec6775426daff4d64edfb1",
    }
    if receipt.get("wasmtime_wheel_sha256") != expected_wheels.get(identity["machine"]):
        raise ValueError("Qualification lacks the pinned official platform wheel identity")
    for name in (
        "tests/test_method_protocol.py",
        "tests/test_method_runtime.py",
        "controlled_method_linux.py",
    ):
        protocol._hash(sources.get(name), "qualified test source")
    if summary.get("nested_cancellation") is not True or summary.get("parent_death") is not True:
        raise ValueError(
            "Qualification lacks successful nested cancellation and parent-death coverage"
        )


def install_runtime_qualification(path, *, authority):
    """Native acceptance of complete QA on the actual installed Linux runtime."""
    _native(authority)
    evidence = _read_file(path, 8 * 1024**2)
    try:
        receipt = parse_json(evidence.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("Invalid bounded runtime qualification receipt") from exc
    identity = _runtime_identity()
    _validate_qualification_evidence(receipt, identity)
    record = {
        "schema": "loci.controlled-method-runtime-qualification/v1",
        "identity": identity,
        "evidence_sha256": protocol.sha256(evidence),
        "accepted_at": timestamp(),
        "evidence_base64": base64.b64encode(evidence).decode("ascii"),
    }
    directory = _qualification_directory()
    if any(p.is_symlink() for p in (directory, *directory.parents)):
        raise ValueError("Runtime qualification trust directory must not contain links")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / "accepted.json"
    if target.is_symlink():
        raise ValueError("Runtime qualification record must not be a link")
    encoded = canonical_json(record).encode()
    fd, temporary = tempfile.mkstemp(prefix=".qualification-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        from .export import _fsync_directory

        _fsync_directory(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"accepted": True, "identity": identity, "evidence_sha256": record["evidence_sha256"]}


def qualified_runtime():
    """Read-only local authority lookup; no request or study can provide it."""
    if not runtime.runtime_availability()["available"]:
        return None
    path = _qualification_directory() / "accepted.json"
    if not path.exists():
        return None
    record = parse_json(_read_file(path, 12 * 1024**2).decode("utf-8"))
    _exact(
        record,
        {"schema", "identity", "evidence_sha256", "accepted_at", "evidence_base64"},
        "runtime qualification",
    )
    evidence = _decode(record["evidence_base64"], 8 * 1024**2)
    if (
        record["schema"] != "loci.controlled-method-runtime-qualification/v1"
        or protocol.sha256(evidence) != record["evidence_sha256"]
        or not _same(record["identity"], _runtime_identity())
    ):
        raise ValueError("Accepted runtime qualification bytes or installed identity changed")
    _validate_qualification_evidence(parse_json(evidence.decode("utf-8")), record["identity"])
    return {k: record[k] for k in ("schema", "identity", "evidence_sha256", "accepted_at")}


def validate_settings(request):
    _exact(request, REQUEST_KEYS, "controlled method binding")
    for key in ("method_id", "result_id"):
        checked_id(request[key])
    for key in ("manifest_sha256", "module_sha256", "revision_hash"):
        protocol._hash(request[key], key)
    channels = request["raw_channels"]
    if type(channels) is not list or not 1 <= len(channels) <= protocol.MAX_CHANNELS:
        raise ValueError("Methods require 1-8 explicitly ordered raw channels")
    for channel in channels:
        integer(channel, "raw channel", 0, 255)
    if len(set(channels)) != len(channels):
        raise ValueError("Method raw channel indices must be unique")
    integer(request["working_bytes"], "method working bytes", 1024**2, MAX_WORKING_BYTES)


def _geometry(value):
    geometry = morphology._geometry(value)
    matrix = np.asarray(geometry.affine)
    if (
        geometry.axes != "YX"
        or geometry.unit not in {"pixel", "um"}
        or geometry.frame != "image"
        or not np.array_equal(matrix[:3, :3], np.diag(np.diag(matrix[:3, :3])))
        or np.any(np.diag(matrix[:3, :3]) <= 0)
    ):
        raise ValueError("Method ABI requires native axis-aligned positive YX pixel or um geometry")
    return {
        "axes": "YX",
        "level": 0,
        "origin_yx": [float(matrix[1, 3]), float(matrix[0, 3])],
        "spacing_yx": [float(matrix[1, 1]), float(matrix[0, 0])],
        "unit": geometry.unit,
    }


def _estimated_working_bytes(parent, chain, request, method):
    selection = parent["provenance"]["selection"]
    pixels = selection["width"] * selection["height"]
    required = pixels * (192 + 48 * len(request["raw_channels"]))
    required += 16 * sum(len(canonical_json(r).encode()) for r in chain)
    required += len(parent["provenance"]["measurements"]) * len(method.manifest()["metrics"]) * 192
    return required + 4 * (protocol.MAX_MODULE_BYTES + protocol.MAX_OUTPUT_BYTES)


def validate_request(workbench, request, *, check=None):
    """Resolve exact authorized native arrays; no compilation or code execution."""
    validate_settings(request)
    if check:
        check()
    method, package = _method(workbench.project, request["method_id"])
    if (
        method.manifest_sha256 != request["manifest_sha256"]
        or method.module_sha256 != request["module_sha256"]
    ):
        raise ValueError("Method binding is stale")
    accepted = morphology.validate_request(
        workbench,
        {k: request[k] for k in ("result_id", "revision_hash", "working_bytes")},
        check=check,
    )
    parent = accepted["parent"]
    source = accepted["sources"][parent["source_id"]]
    if source.get("source_kind") != "native":
        raise ValueError("Controlled methods initially require scalar native sources")
    selection = parent["provenance"]["selection"]
    if (
        set(selection) != {"x", "y", "width", "height", "z", "t", "c", "level"}
        or selection["level"] != 0
    ):
        raise ValueError("Controlled methods require one native level-zero YX plane")
    pixels = selection["width"] * selection["height"]
    if pixels > protocol.MAX_PIXELS:
        raise ValueError("Method input exceeds its bounded YX grid")
    geometry = _geometry(parent["provenance"]["geometry"])
    # Input copies, parsing/rebuilding, output rows and source decoder coexist.
    required = _estimated_working_bytes(parent, accepted["chain"], request, method)
    if required > request["working_bytes"]:
        raise ValueError("Method aggregate working-memory budget is insufficient before decode")
    arrays = {k: workbench.project.load_array(parent["arrays"][k]) for k in ("image", "labels")}
    raw = []
    for channel in request["raw_channels"]:
        if check:
            check()
        image, actual_geometry, actual_selection = workbench.load_scalar(
            parent["source_id"], {**selection, "c": channel}, working_bytes=request["working_bytes"]
        )
        if not _same(
            actual_geometry.to_dict(), parent["provenance"]["geometry"]
        ) or actual_selection != {**selection, "c": channel}:
            raise ValueError("Method raw channel source geometry or selection changed")
        if raw and image.dtype != raw[0].dtype:
            raise ValueError("Method channels require one common raw scalar dtype")
        raw.append(image)
    arrays["method_raw"] = np.stack(raw)
    snapshot = protocol.build_method_input(
        arrays["labels"],
        arrays["method_raw"],
        source_sha256=source["sha256"],
        label_revision_sha256=parent["revision_hash"],
        geometry=geometry,
    )
    source_binding = {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "series": source["metadata"]["selected_series"],
        "selection": selection,
        "raw_channels": request["raw_channels"],
        "geometry": parent["provenance"]["geometry"],
    }
    preflight = {
        "schema": "loci.controlled-method-preflight/v1",
        "request": request,
        "input_sha256": snapshot.sha256,
        "input_binding": source_binding,
        "parent_arrays": parent["arrays"],
        "label_ids": list(snapshot.label_ids),
        "estimated_working_bytes": required,
    }
    return {
        **accepted,
        "method": method,
        "package": package,
        "arrays": arrays,
        "snapshot": snapshot,
        "preflight": preflight,
        "preflight_hash": _hash(preflight),
    }


def preflight(workbench, request, *, check=None):
    accepted = validate_request(workbench, request, check=check)
    return {
        "preflight": accepted["preflight"],
        "preflight_hash": accepted["preflight_hash"],
        "runtime": runtime_status(),
        "scientific_review": "pending",
    }


def create_output_grant(workbench, path, request, *, authority):
    _native(authority)
    _exact(request, REQUEST_KEYS | {"preflight_hash"}, "native external-output grant")
    accepted = validate_request(workbench, {k: request[k] for k in REQUEST_KEYS})
    if request["preflight_hash"] != accepted["preflight_hash"]:
        raise ValueError("Method output grant preflight is stale")
    output = _read_file(path, protocol.MAX_OUTPUT_BYTES)
    protocol.validate_method_output(accepted["method"], accepted["snapshot"], output)
    grant = {
        "schema": "loci.controlled-method-output-grant/v1",
        "preflight_hash": request["preflight_hash"],
        "request": {k: request[k] for k in REQUEST_KEYS},
        "output_base64": base64.b64encode(output).decode("ascii"),
        "output_sha256": protocol.sha256(output),
        "created_at": timestamp(),
    }
    grant["grant_sha256"] = _hash(grant)
    identity = uuid.uuid4().hex
    workbench.project.put_document(OUTPUT_KIND, identity, grant, expected_revision=0)
    return {
        "output_grant_id": identity,
        "preflight_hash": request["preflight_hash"],
        "output_sha256": grant["output_sha256"],
        "origin": "adopted-external",
    }


def export_input(workbench, destination, request, *, authority):
    """Publish exact inert ABI inputs for an independently controlled executor."""
    _native(authority)
    _exact(request, REQUEST_KEYS | {"preflight_hash"}, "native method input export")
    base = {k: request[k] for k in REQUEST_KEYS}
    accepted = validate_request(workbench, base)
    if request["preflight_hash"] != accepted["preflight_hash"]:
        raise ValueError("Method input export preflight is stale")
    target = Path(destination)
    if (
        not target.is_absolute()
        or any(p.is_symlink() for p in (target, *target.parents))
        or not target.parent.is_dir()
        or target.exists()
    ):
        raise ValueError(
            "Method input export requires an absent absolute destination without links"
        )
    parent_identity = target.parent.stat()
    members = {
        "input.bin": accepted["snapshot"].buffer,
        "binding.json": canonical_json(accepted["preflight"]).encode(),
        "manifest.json": protocol.canonical_json(accepted["method"].manifest()),
        "module.wasm": accepted["method"].module_bytes,
    }
    receipt = {
        "schema": "loci.controlled-method-input-export/v1",
        "preflight_hash": accepted["preflight_hash"],
        "input_sha256": accepted["snapshot"].sha256,
        "members": {
            name: {"sha256": protocol.sha256(value), "bytes": len(value)}
            for name, value in members.items()
        },
        "execution": "not-performed",
    }
    members["receipt.json"] = canonical_json(receipt).encode()
    fd, temporary = tempfile.mkstemp(prefix=".method-input-", dir=target.parent)
    try:
        with os.fdopen(fd, "w+b") as handle:
            with zipfile.ZipFile(handle, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, value in members.items():
                    archive.writestr(name, value)
            handle.flush()
            os.fsync(handle.fileno())
        from .working_result import _sha256_file_stable

        archive_sha256, _ = _sha256_file_stable(Path(temporary), reject_symlink=True)
        current = validate_request(workbench, base)
        if current["preflight_hash"] != accepted["preflight_hash"]:
            raise ValueError("Method inputs changed before export publication")
        after = target.parent.stat()
        if (after.st_dev, after.st_ino) != (parent_identity.st_dev, parent_identity.st_ino) or any(
            p.is_symlink() for p in (target, *target.parents)
        ):
            raise ValueError("Method export directory changed before publication")
        from .export import _fsync_directory, _rename_noreplace

        _rename_noreplace(Path(temporary), target)
        _fsync_directory(target.parent)
    except OSError as exc:
        raise ValueError("Method input export could not publish its absent destination") from exc
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {**receipt, "basename": target.name, "sha256": archive_sha256}


def _output_grant(project, identity, request, preflight_hash):
    envelope = _document(project, OUTPUT_KIND, identity)
    grant = envelope["data"]
    _exact(
        grant,
        {
            "schema",
            "preflight_hash",
            "request",
            "output_base64",
            "output_sha256",
            "created_at",
            "grant_sha256",
        },
        "method output grant",
    )
    if (
        envelope["revision"] != 1
        or grant["schema"] != "loci.controlled-method-output-grant/v1"
        or grant["preflight_hash"] != preflight_hash
        or not _same(grant["request"], request)
        or grant["grant_sha256"] != _hash({k: v for k, v in grant.items() if k != "grant_sha256"})
    ):
        raise ValueError("Method output grant is stale or its authority changed")
    output = _decode(grant["output_base64"], protocol.MAX_OUTPUT_BYTES)
    if protocol.sha256(output) != grant["output_sha256"]:
        raise ValueError("Method output grant bytes changed")
    return output, grant


def _run_request(request):
    if type(request) is not dict or set(request) - RUN_KEYS:
        raise ValueError("Invalid method run request")
    required = REQUEST_KEYS | {"preflight_hash", "mode"}
    if not required <= set(request):
        raise ValueError("Method run requires exact preflight and input bindings")
    if request["mode"] not in {"adopt-external", "execute"}:
        raise ValueError("Choose explicit external adoption or controlled execution")
    if ("output_grant_id" in request) != (request["mode"] == "adopt-external"):
        raise ValueError("Only external adoption requires a native output grant")
    if "output_grant_id" in request:
        checked_id(request["output_grant_id"])
    protocol._hash(request["preflight_hash"], "preflight")
    validate_settings({k: request[k] for k in REQUEST_KEYS})


def execute_method_run(workbench, request, *, job_id=None, publication_guard=None):
    from .workbench import result_summary, runtime_record

    _run_request(request)
    if job_id is None:
        raise ValueError("Publish controlled method results through an exact durable native job")
    base_request = {k: request[k] for k in REQUEST_KEYS}
    accepted = validate_request(workbench, base_request, check=publication_guard)
    if request["preflight_hash"] != accepted["preflight_hash"]:
        raise ValueError("Controlled method preflight changed before execution")
    parent, method = accepted["parent"], accepted["method"]
    execution_authority = None
    qualification = None
    expected_grant_sha256 = None

    if request["mode"] == "execute":
        rights = _authority(workbench.project, request["method_id"], method)
        if not rights or rights["events"][-1]["decision"] != "approved":
            raise PermissionError("Controlled execution requires a current native rights review")
        execution_authority = rights["events"][-1]
        qualification = qualified_runtime()
        if qualification is None:
            raise runtime.MethodRuntimeUnavailable(runtime_status()["execution_reason"])

    def check_controls():
        if publication_guard:
            publication_guard()
        job = workbench.project.job(job_id)
        normalized = {"source_id": parent["source_id"], "task_request": request}
        if (
            job["state"] != "running"
            or job["cancel_requested"]
            or job["operation"] != "method_run"
            or job["request"] != normalized
            or job["request_hash"] != _hash({"operation": "method_run", "request": normalized})
        ):
            raise ValueError("Method publication requires its exact current native job")
        if request["mode"] == "execute":
            rights = _authority(workbench.project, request["method_id"], method)
            if not rights or rights["events"][-1] != execution_authority:
                raise PermissionError("Method rights changed during execution")

    def guard():
        check_controls()
        for record in accepted["chain"]:
            if not _same(workbench.project.result(record["id"]), record):
                raise ValueError("Method exact parent changed before publication")
        for source in accepted["sources"].values():
            if not _same(workbench.project.source(source["id"], verify=True), source):
                raise ValueError("Method source changed before publication")
        current, _ = _method(workbench.project, request["method_id"])
        if current != method:
            raise ValueError("Method package changed before publication")
        for descriptor in parent["arrays"].values():
            workbench.project.verify_array(descriptor)
        if request["mode"] == "adopt-external":
            _, current_grant = _output_grant(
                workbench.project,
                request["output_grant_id"],
                base_request,
                request["preflight_hash"],
            )
            if (
                expected_grant_sha256 is not None
                and current_grant["grant_sha256"] != expected_grant_sha256
            ):
                raise ValueError("Native method output grant changed before publication")
        else:
            rights = _authority(workbench.project, request["method_id"], method)
            if (
                not rights
                or rights["events"][-1] != execution_authority
                or not _same(qualified_runtime(), qualification)
            ):
                raise PermissionError(
                    "Method rights or qualified runtime changed before publication"
                )

    guard()
    if request["mode"] == "execute":
        approval = protocol.MethodExecutionApproval(
            method.manifest_sha256, method.module_sha256, execution_authority["evidence_sha256"]
        )
        adopted = runtime.execute_method(
            method, accepted["snapshot"], approval=approval, check=check_controls
        )
        output = struct.pack(
            "<8sII", protocol.OUTPUT_MAGIC, len(adopted["rows"]), len(adopted["metrics"])
        )
        output += b"".join(
            struct.pack("<I" + "d" * len(row["values"]), row["label_id"], *row["values"])
            for row in adopted["rows"]
        )
        protocol.validate_method_output(method, accepted["snapshot"], output)
        if protocol.sha256(output) != adopted["output_sha256"]:
            raise ValueError("Executed method output cannot be retained with its exact byte hash")
    else:
        output, grant = _output_grant(
            workbench.project, request["output_grant_id"], base_request, request["preflight_hash"]
        )
        expected_grant_sha256 = grant["grant_sha256"]
        adopted = protocol.adopt_method_output(
            method, accepted["snapshot"], output, expected_output_sha256=grant["output_sha256"]
        )
    arrays = {
        **accepted["arrays"],
        "method_module": np.frombuffer(method.module_bytes, dtype=np.uint8),
        "method_output": np.frombuffer(output, dtype=np.uint8),
    }
    rows = copy.deepcopy(parent["provenance"]["measurements"])
    by_label = {row["label_id"]: row["values"] for row in adopted["rows"]}
    if set(by_label) != {row["label"] for row in rows}:
        raise ValueError("Method output labels disagree with original parent measurement rows")
    for row in rows:
        row["controlled_method"] = dict(
            zip((m["id"] for m in adopted["metrics"]), by_label[row["label"]], strict=True)
        )
    p = parent["provenance"]
    provenance = {
        k: copy.deepcopy(p[k])
        for k in ("geometry", "selection", "measurement_channels", "channel_metadata", "references")
        if k in p
    }
    provenance.update(
        parent_result=_binding(parent),
        accepted_request=copy.deepcopy(request),
        measurements=rows,
        runtime=runtime_record(),
        job_id=job_id,
        measurement_basis=(
            "Original parent measurements retained; custom metrics retain exact output origin"
        ),
        scientific_validation="unvalidated-controlled-method-output",
    )
    provenance["controlled_method"] = {
        "schema": SCHEMA,
        "package": accepted["package"],
        "result": adopted,
        "preflight": accepted["preflight"],
        "preflight_hash": accepted["preflight_hash"],
        "parent_chain": [_binding(r) for r in accepted["chain"]],
        "qualification": qualification,
    }
    guard()
    result = workbench.project.save_result(
        source_id=parent["source_id"],
        kind=KIND,
        arrays=arrays,
        provenance=provenance,
        parent_id=parent["id"],
        job_id=job_id,
        publication_guard=guard,
    )
    return {
        "adopted": True,
        "result": result_summary(result),
        "controlled_method": adopted,
        "measurements": rows[:1000],
        "total_measurements": len(rows),
    }


def validate_record(result):
    """Pure metadata validation, including a not-yet-hashed publication record."""
    if result.get("kind") != KIND and "controlled_method" not in result.get("provenance", {}):
        return
    if result.get("schema") != "loci.research-result/v1" or result.get("kind") != KIND:
        raise ValueError("Invalid controlled-method result kind")
    for key in ("id", "source_id", "parent_id"):
        checked_id(result.get(key))
    protocol._hash(result.get("source_sha256"), "source")
    if "revision_hash" in result and result["revision_hash"] != _hash(
        {k: v for k, v in result.items() if k != "revision_hash"}
    ):
        raise ValueError("Controlled-method result revision integrity changed")
    p = result["provenance"]
    record = p.get("controlled_method")
    _exact(
        record,
        {
            "schema",
            "package",
            "result",
            "preflight",
            "preflight_hash",
            "parent_chain",
            "qualification",
        },
        "controlled-method record",
    )
    if record["schema"] != SCHEMA:
        raise ValueError("Unsupported controlled-method result schema")
    method = validate_package_document(record["package"])
    _run_request(p.get("accepted_request"))
    request = p["accepted_request"]
    flight = record["preflight"]
    _exact(
        flight,
        {
            "schema",
            "request",
            "input_sha256",
            "input_binding",
            "parent_arrays",
            "label_ids",
            "estimated_working_bytes",
        },
        "method preflight",
    )
    if (
        flight["schema"] != "loci.controlled-method-preflight/v1"
        or not _same(flight["request"], {k: request[k] for k in REQUEST_KEYS})
        or record["preflight_hash"] != _hash(flight)
        or request["preflight_hash"] != record["preflight_hash"]
        or method.manifest_sha256 != request["manifest_sha256"]
        or method.module_sha256 != request["module_sha256"]
        or request["method_id"] != method.manifest_sha256[:32]
    ):
        raise ValueError("Controlled-method preflight or package binding disagrees")
    parent_binding = {k: request[k] for k in ("result_id", "revision_hash")}
    if p.get("parent_result") != parent_binding or result["parent_id"] != request["result_id"]:
        raise ValueError("Controlled-method exact parent binding disagrees")
    chain = record["parent_chain"]
    if (
        type(chain) is not list
        or not 1 <= len(chain) <= morphology.MAX_ANCESTORS
        or chain[0] != parent_binding
    ):
        raise ValueError("Controlled-method exact ancestry is missing")
    seen = {result["id"]}
    for ancestor in chain:
        _exact(ancestor, {"result_id", "revision_hash"}, "method ancestor")
        checked_id(ancestor["result_id"])
        protocol._hash(ancestor["revision_hash"], "ancestor")
        if ancestor["result_id"] in seen:
            raise ValueError("Controlled-method ancestor identity repeats")
        seen.add(ancestor["result_id"])
    binding = flight["input_binding"]
    _exact(
        binding,
        {"source_id", "source_sha256", "series", "selection", "raw_channels", "geometry"},
        "method source binding",
    )
    integer(binding["series"], "method series", 0, 2**31 - 1)
    if (
        binding["source_id"] != result["source_id"]
        or binding["source_sha256"] != result["source_sha256"]
        or binding["raw_channels"] != request["raw_channels"]
        or not _same(binding["selection"], p.get("selection"))
        or not _same(binding["geometry"], p.get("geometry"))
    ):
        raise ValueError("Method source selection, channel order or calibration disagrees")
    _geometry(p["geometry"])
    selection = binding["selection"]
    _exact(
        selection, {"x", "y", "width", "height", "z", "t", "c", "level"}, "method native selection"
    )
    for key, value in selection.items():
        integer(value, key, 1 if key in {"width", "height"} else 0, 2**31 - 1)
    if selection["level"] != 0 or selection["width"] * selection["height"] > protocol.MAX_PIXELS:
        raise ValueError("Method grid is unsupported")
    if set(result.get("arrays", {})) != ARRAY_NAMES:
        raise ValueError("Method retained artifacts are incomplete")
    _exact(flight["parent_arrays"], {"image", "labels"}, "method parent artifacts")
    for name in ("image", "labels"):
        if result["arrays"][name] != flight["parent_arrays"][name]:
            raise ValueError("Method parent artifact identity changed")
    shape = [selection["height"], selection["width"]]
    for name, descriptor in result["arrays"].items():
        _exact(descriptor, {"sha256", "bytes", "dtype", "shape"}, "method artifact")
        protocol._hash(descriptor["sha256"], "artifact")
        integer(descriptor["bytes"], "artifact bytes", 1, protocol.MAX_INPUT_BYTES + 16384)
        if name in {"image", "labels"} and descriptor["shape"] != shape:
            raise ValueError("Method parent artifact shape changed")
        if name == "labels" and descriptor["dtype"] != "uint32":
            raise ValueError("Method labels must retain uint32 IDs")
        if name == "method_raw" and (
            descriptor["shape"] != [len(request["raw_channels"]), *shape]
            or descriptor["dtype"] not in {"uint8", "uint16", "float32", "float64"}
        ):
            raise ValueError("Method raw scalar channels disagree")
        if name in {"method_module", "method_output"} and (
            descriptor["dtype"] != "uint8"
            or type(descriptor["shape"]) is not list
            or len(descriptor["shape"]) != 1
        ):
            raise ValueError("Method byte artifacts must be one-dimensional uint8")
    adopted = record["result"]
    adopted_keys = {
        "schema",
        "origin",
        "abi",
        "manifest_sha256",
        "module_sha256",
        "input_sha256",
        "output_sha256",
        "metrics",
        "rows",
        "scientific_review",
        "runtime",
    }
    _exact(
        adopted,
        adopted_keys | ({"rights_evidence_sha256"} if request["mode"] == "execute" else set()),
        "method output",
    )
    if (
        adopted["scientific_review"] != "pending"
        or adopted["schema"] != "loci.controlled-method-result/v1"
        or adopted["abi"] != protocol.ABI
        or adopted["manifest_sha256"] != method.manifest_sha256
        or adopted["module_sha256"] != method.module_sha256
        or adopted["input_sha256"] != flight["input_sha256"]
        or adopted["metrics"] != method.manifest()["metrics"]
    ):
        raise ValueError("Method origin, runtime or metric declarations disagree")
    if request["mode"] == "adopt-external":
        if (
            adopted["origin"] != "adopted-external"
            or adopted["runtime"] is not None
            or record["qualification"] is not None
        ):
            raise ValueError(
                "External method adoption must not claim runtime execution or qualification"
            )
    else:
        _validate_execution_provenance(adopted, record["qualification"])
    for key in ("input_sha256", "output_sha256"):
        protocol._hash(adopted[key], key)
    ids = flight["label_ids"]
    if (
        type(ids) is not list
        or not 1 <= len(ids) <= protocol.MAX_OBJECTS
        or ids != sorted(set(ids))
    ):
        raise ValueError("Invalid method label identities")
    for label in ids:
        integer(label, "method label", 1, 2**32 - 1)
    if result["arrays"]["method_module"]["shape"] != [len(method.module_bytes)] or result["arrays"][
        "method_output"
    ]["shape"] != [16 + len(ids) * (4 + 8 * len(adopted["metrics"]))]:
        raise ValueError("Method byte artifact shapes exceed their exact bounded ABI lengths")
    rows = adopted["rows"]
    if type(rows) is not list or len(rows) != len(ids):
        raise ValueError("Method output rows disagree")
    for label, row in zip(ids, rows, strict=True):
        _exact(row, {"label_id", "values"}, "method output row")
        if (
            row["label_id"] != label
            or type(row["values"]) is not list
            or len(row["values"]) != len(adopted["metrics"])
            or any(type(v) not in {int, float} or not np.isfinite(v) for v in row["values"])
        ):
            raise ValueError("Method output values or labels disagree")
    measurements = p.get("measurements")
    if type(measurements) is not list or len(measurements) != len(rows):
        raise ValueError("Method original measurements are incomplete")
    expected = {
        r["label_id"]: dict(zip((m["id"] for m in adopted["metrics"]), r["values"], strict=True))
        for r in rows
    }
    if {r.get("label") for r in measurements} != set(ids) or any(
        not _same(r.get("controlled_method"), expected[r["label"]]) for r in measurements
    ):
        raise ValueError("Method measurement values disagree with adopted output")
    integer(
        flight["estimated_working_bytes"],
        "method aggregate resource estimate",
        1,
        request["working_bytes"],
    )
    canonical_json(result)


def validate_parents(result, results):
    validate_record(result)
    p = result["provenance"]
    parent = results.get(p["parent_result"]["result_id"])
    if parent is None or _binding(parent) != p["parent_result"]:
        raise ValueError("Controlled-method exact parent is missing or stale")
    chain = morphology._chain(parent, results.get, p["accepted_request"]["working_bytes"])
    if [_binding(r) for r in chain] != p["controlled_method"]["parent_chain"]:
        raise ValueError("Controlled-method ancestry disagrees")
    method = validate_package_document(p["controlled_method"]["package"])
    if p["controlled_method"]["preflight"]["estimated_working_bytes"] != _estimated_working_bytes(
        parent, chain, p["accepted_request"], method
    ):
        raise ValueError("Controlled-method aggregate memory estimate disagrees with exact parents")
    if any(result[k] != parent[k] for k in ("source_id", "source_sha256")):
        raise ValueError("Controlled-method parent source changed")
    for name in ("image", "labels"):
        if result["arrays"][name] != parent["arrays"][name]:
            raise ValueError("Controlled-method parent arrays changed")
    for name in ("geometry", "selection", "measurement_channels", "channel_metadata", "references"):
        if not _same(p.get(name), parent["provenance"].get(name)):
            raise ValueError("Controlled-method parent source declarations changed")
    originals = [
        {k: v for k, v in r.items() if k != "controlled_method"} for r in p["measurements"]
    ]
    if not _same(originals, parent["provenance"]["measurements"]):
        raise ValueError("Controlled-method changed original parent measurements")


def project_parents(project, result, *, check=None):
    validate_record(result)
    parents = {}
    total = 0
    for binding in result["provenance"]["controlled_method"]["parent_chain"]:
        if check:
            check()
        with project.connection() as connection:
            row = connection.execute(
                "SELECT record FROM results WHERE id=?", (binding["result_id"],)
            ).fetchone()
        if row is None:
            raise ValueError("Controlled-method parent is missing")
        total += len(row[0].encode()) * 16
        if total > result["provenance"]["accepted_request"]["working_bytes"]:
            raise ValueError("Method ancestry exceeds working-memory budget")
        parent = parse_json(row[0])
        morphology._parent(parent)
        parents[parent["id"]] = parent
    validate_parents(result, parents)
    return parents


def validate_source(result, source):
    morphology.validate_source(result, source)
    binding = result["provenance"]["controlled_method"]["preflight"]["input_binding"]
    if (
        source.get("source_kind") != "native"
        or source["metadata"].get("selected_series") != binding["series"]
        or any(c >= source["metadata"]["dimensions"]["c"] for c in binding["raw_channels"])
    ):
        raise ValueError("Method raw channels or series exceed the bound native source")


def validate_arrays(result, arrays, *, parents=None, check=None, working_bytes=None):
    """Cold validation uses retained bytes only; never executes imported code."""
    validate_record(result)
    if parents is not None:
        validate_parents(result, parents)
    if set(arrays) != ARRAY_NAMES:
        raise ValueError("Method retained byte artifacts are incomplete")
    budget = result["provenance"]["accepted_request"]["working_bytes"]
    if working_bytes is not None:
        budget = min(
            budget, integer(working_bytes, "method validation budget", 1024**2, MAX_WORKING_BYTES)
        )
    if result["provenance"]["controlled_method"]["preflight"]["estimated_working_bytes"] > budget:
        raise ValueError("Method cold validation exceeds aggregate working-memory budget")
    for name, descriptor in result["arrays"].items():
        if check:
            check()
        array = arrays[name]
        if (
            not isinstance(array, np.ndarray)
            or list(array.shape) != descriptor["shape"]
            or str(array.dtype) != descriptor["dtype"]
        ):
            raise ValueError("Method artifact shape or dtype changed")
        digest = morphology._ArrayDigest(check)
        np.save(digest, array, allow_pickle=False)
        if digest.size != descriptor["bytes"] or digest.hash.hexdigest() != descriptor["sha256"]:
            raise ValueError("Method artifact bytes changed")
    p = result["provenance"]
    record = p["controlled_method"]
    method = validate_package_document(record["package"])
    if arrays["method_module"].tobytes() != method.module_bytes:
        raise ValueError("Retained method module differs from registered bytes")
    snapshot = protocol.build_method_input(
        arrays["labels"],
        arrays["method_raw"],
        source_sha256=result["source_sha256"],
        label_revision_sha256=p["parent_result"]["revision_hash"],
        geometry=_geometry(p["geometry"]),
    )
    adopted = protocol.adopt_method_output(
        method,
        snapshot,
        arrays["method_output"].tobytes(),
        expected_output_sha256=record["result"]["output_sha256"],
    )
    if p["accepted_request"]["mode"] == "execute":
        adopted.update(
            origin="executed-local-child",
            runtime=record["result"]["runtime"],
            rights_evidence_sha256=record["result"]["rights_evidence_sha256"],
        )
    if not _same(adopted, record["result"]):
        raise ValueError("Retained method input/output bytes disagree with scientific rows")


def validate_project_arrays(project, result, *, arrays=None, check=None, working_bytes=None):
    validate_record(result)
    budget = result["provenance"]["accepted_request"]["working_bytes"]
    if working_bytes is not None:
        budget = min(
            budget, integer(working_bytes, "method validation budget", 1024**2, MAX_WORKING_BYTES)
        )
    if result["provenance"]["controlled_method"]["preflight"]["estimated_working_bytes"] > budget:
        raise ValueError("Method cold validation exceeds aggregate budget before decode")
    if arrays is None:
        arrays = {}
        for name, descriptor in result["arrays"].items():
            if check:
                check()
            arrays[name] = project.load_array(descriptor)
    validate_arrays(result, arrays, check=check, working_bytes=working_bytes)


def metric_descriptors(result):
    validate_record(result)
    return [
        {
            "id": f"controlled_method:{m['id']}",
            "label": m["description"],
            "unit": m["unit"],
            "kind": m["kind"],
            "statistic": "controlled-method-output",
        }
        for m in result["provenance"]["controlled_method"]["result"]["metrics"]
    ]


def metric_values(row):
    return {
        f"controlled_method:{name}": value
        for name, value in row.get("controlled_method", {}).items()
    }


def public_summary(result):
    """Renderer/MCP metadata: never module bytes, rights evidence or local grants."""
    validate_record(result)
    if result.get("kind") != KIND:
        return {}
    record = result["provenance"]["controlled_method"]
    adopted = record["result"]
    return {
        "controlled_method": {
            "schema": SCHEMA,
            "method_id": record["preflight"]["request"]["method_id"],
            "manifest_sha256": adopted["manifest_sha256"],
            "module_sha256": adopted["module_sha256"],
            "input_sha256": adopted["input_sha256"],
            "output_sha256": adopted["output_sha256"],
            "origin": adopted["origin"],
            "scientific_review": "pending",
            "runtime": adopted["runtime"],
            "metrics": adopted["metrics"],
            "raw_channels": record["preflight"]["input_binding"]["raw_channels"],
            "total_rows": len(adopted["rows"]),
            "preflight_hash": record["preflight_hash"],
        }
    }


def _validate_execution_provenance(adopted, qualification):
    protocol._hash(adopted["rights_evidence_sha256"], "rights evidence")
    _exact(
        qualification,
        {"schema", "identity", "evidence_sha256", "accepted_at"},
        "historical qualification",
    )
    protocol._hash(qualification["evidence_sha256"], "qualification evidence")
    identity = qualification["identity"]
    _exact(
        identity,
        {
            "runtime_profile",
            "wasmtime_version",
            "native_sha256",
            "python_version",
            "python_executable_sha256",
            "platform",
            "machine",
            "numpy_version",
            "protocol_sha256",
            "runtime_sha256",
        },
        "qualified runtime identity",
    )
    for name in ("native_sha256", "python_executable_sha256", "protocol_sha256", "runtime_sha256"):
        protocol._hash(identity[name], name)
    receipt = adopted["runtime"]
    _exact(
        receipt,
        {
            "schema",
            "mode",
            "runtime_profile",
            "wasmtime_version",
            "native_sha256",
            "python_version",
            "module_sha256",
            "input_sha256",
            "output_sha256",
            "limits",
        },
        "execution receipt",
    )
    if (
        adopted["origin"] != "executed-local-child"
        or qualification["schema"] != "loci.controlled-method-runtime-qualification/v1"
        or identity["platform"] != "linux"
        or identity["runtime_profile"] != runtime.RUNTIME_PROFILE
        or identity["wasmtime_version"] != runtime.WASMTIME_VERSION
        or receipt["schema"] != "loci.controlled-method-execution/v1"
        or receipt["mode"] != "execute"
        or receipt["limits"] != runtime._limits_record()
        or any(
            receipt[key] != identity[key]
            for key in ("runtime_profile", "wasmtime_version", "native_sha256", "python_version")
        )
        or any(
            receipt[key] != adopted[key]
            for key in ("module_sha256", "input_sha256", "output_sha256")
        )
    ):
        raise ValueError("Method historical execution or qualification identity disagrees")


def inspect_result(workbench, request, *, check=None):
    _exact(request, {"result_id", "revision_hash"}, "controlled method result")
    result = workbench.project.result(checked_id(request["result_id"]))
    if result["revision_hash"] != request["revision_hash"] or result["kind"] != KIND:
        raise ValueError("Choose an exact controlled-method result revision")
    if check:
        check()
    # ResearchProject.result is the shared parent/array validation boundary.
    return _result_info(result)


def _result_info(result):
    record = result["provenance"]["controlled_method"]
    return {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "method": record["package"]["package"]["manifest"],
        "input_binding": record["preflight"]["input_binding"],
        "origin": record["result"]["origin"],
        "runtime": record["result"]["runtime"],
        "scientific_review": "pending",
        "total_rows": len(record["result"]["rows"]),
        "metrics": metric_descriptors(result),
        "input_sha256": record["result"]["input_sha256"],
        "output_sha256": record["result"]["output_sha256"],
    }


def query_result(workbench, request, *, check=None):
    _exact(request, {"result_id", "revision_hash", "offset", "limit"}, "method result query")
    offset = integer(request["offset"], "method row offset", 0, protocol.MAX_OBJECTS)
    limit = integer(request["limit"], "method row limit", 1, 100)
    result = workbench.project.result(request["result_id"])
    if result["revision_hash"] != request["revision_hash"] or result["kind"] != KIND:
        raise ValueError("Choose an exact controlled-method result revision")
    if check:
        check()
    info = _result_info(result)
    rows = result["provenance"]["controlled_method"]["result"]["rows"]
    return {
        **info,
        "rows": rows[offset : offset + limit],
        "next_offset": offset + limit if offset + limit < len(rows) else None,
    }


def execute(workbench, operation, request, *, job_id=None, publication_guard=None):
    if operation == "method_list":
        return list_methods(workbench, request)
    if operation == "method_get":
        return get_method(workbench, request)
    if operation == "method_runtime":
        _exact(request, set(), operation)
        return runtime_status()
    if operation == "method_preflight":
        return preflight(workbench, request, check=publication_guard)
    if operation == "method_run":
        return execute_method_run(
            workbench, request, job_id=job_id, publication_guard=publication_guard
        )
    if operation == "method_result":
        return inspect_result(workbench, request, check=publication_guard)
    if operation == "method_query":
        return query_result(workbench, request, check=publication_guard)
    raise ValueError("Unknown controlled-method operation")
