#!/usr/bin/env python3
"""Task-local Linux qualification; synthetic fixtures only, never product data.

Run from an isolated directory containing loci_engine/{method_protocol,
method_runtime}.py and tests/test_method_*.py, under a bounded scheduler job.
Provisioning and transport are intentionally outside this script.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import json
import os
import platform
import resource
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from loci_engine import method_protocol as p
from loci_engine import method_runtime as r


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe(kind):
    r._apply_child_limits()
    if kind == "address-space":
        try:
            bytearray(r.ADDRESS_SPACE_BYTES)
        except MemoryError:
            print(
                json.dumps(
                    {"refused": True, "limits": resource.getrlimit(resource.RLIMIT_AS)}
                )
            )
            return
        raise AssertionError("address-space allocation unexpectedly succeeded")
    if kind == "cpu":
        while True:
            pass
    if kind == "file-size":
        fd = os.open(
            ROOT / "probe-empty-file", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        try:
            os.write(fd, b"x")
        except OSError as exc:
            print(json.dumps({"refused": True, "errno": exc.errno}))
            return
        finally:
            os.close(fd)
        raise AssertionError("file growth unexpectedly succeeded")
    # These bypass the production error redaction only in this trusted test
    # child, to distinguish native trap causes in the private evidence.
    _, snapshot, _ = p.qualification_fixture()
    bodies = {
        "fuel": b"\x03\x40\x0c\x00\x0b\x41\0",
        "stack": b"\x20\0\x20\x01\x20\x02\x20\x03\x10\0",
        "heap": b"\x41\x81\x04\x40\0",  # grow 513 pages; must return -1
    }
    try:
        r._compile_and_run(p.qualification_module(bodies[kind]), snapshot.buffer, 1)
    except Exception as exc:  # noqa: BLE001 - record native trap type in private QA evidence
        print(
            json.dumps(
                {"refused": True, "type": type(exc).__name__, "detail": str(exc)[:2048]}
            )
        )
        return
    raise AssertionError("adversarial module unexpectedly succeeded")


def _run_qualification(receipt, started):
    expected = json.loads((ROOT / "source-hashes.json").read_text())
    actual = {name: digest(ROOT / name) for name in expected}
    receipt["source_sha256"] = actual
    assert actual == expected
    report = json.loads((ROOT / "install-report.json").read_text())
    installed = next(
        item for item in report["install"] if item["metadata"]["name"] == "wasmtime"
    )
    wheel_hash = installed["download_info"]["archive_info"]["hashes"]["sha256"]
    assert (
        wheel_hash == "cc14c3a17654e0394e0225b11813532ef0cd7bd1e222a0c5494cdedaabeddac4"
    )
    receipt.update(
        {
            "schema": "loci.controlled-method-linux-qa/v1",
            "source_sha256": actual,
            "job_id": os.environ.get("PBS_JOBID"),
            "queue": os.environ.get("PBS_QUEUE"),
            "hostname": platform.node(),
            "platform": platform.platform(),
            "python": sys.version,
            "python_executable_sha256": digest(Path(sys.executable).resolve()),
            "packages": {
                name: importlib.metadata.version(name)
                for name in ("wasmtime", "numpy", "pytest")
            },
            "wasmtime_wheel_sha256": wheel_hash,
            "native_sha256": r._native_identity(),
            "limits": r._limits_record(),
        }
    )
    assert receipt["job_id"], "qualification requires a PBS allocation"
    tests = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-rA",
            "--junitxml=pytest-results.xml",
            "tests/test_method_protocol.py",
            "tests/test_method_runtime.py",
        ],
        cwd=ROOT,
        capture_output=True,
        timeout=90,
        check=False,
    )
    (ROOT / "pytest.stdout").write_bytes(tests.stdout)
    (ROOT / "pytest.stderr").write_bytes(tests.stderr)
    receipt["pytest_returncode"] = tests.returncode
    junit = (ROOT / "pytest-results.xml").read_bytes()
    assert len(junit) <= 2 * 1024**2
    receipt["junit_xml_base64"] = base64.b64encode(junit).decode("ascii")
    receipt["junit_xml_sha256"] = p.sha256(junit)
    suites = ET.fromstring(junit)
    testsuites = (
        [suites] if suites.tag == "testsuite" else list(suites.findall("testsuite"))
    )
    receipt["pytest_summary"] = {
        key: sum(int(suite.get(key, "0")) for suite in testsuites)
        for key in ("tests", "failures", "errors", "skipped")
    }
    passed_names = {
        case.get("name")
        for case in suites.iter("testcase")
        if not any(
            case.find(kind) is not None for kind in ("failure", "error", "skipped")
        )
    }
    receipt["pytest_summary"].update(
        nested_cancellation="test_native_outer_sigterm_unwinds_and_reaps_nested_child"
        in passed_names,
        parent_death="test_linux_parent_death_kills_method_child" in passed_names,
    )
    receipt["probes"] = {}
    for kind in ("address-space", "cpu", "file-size", "fuel", "stack", "heap"):
        before = time.monotonic()
        child = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--probe", kind],
            cwd=ROOT,
            capture_output=True,
            timeout=r.WALL_SECONDS,
            check=False,
        )
        item = {
            "returncode": child.returncode,
            "seconds": time.monotonic() - before,
            "stdout": child.stdout.decode("utf-8", "replace")[:8192],
            "stderr": child.stderr.decode("utf-8", "replace")[:8192],
        }
        receipt["probes"][kind] = item
    registered, snapshot, expected_output = p.qualification_fixture()
    # Authored synthetic runtime-QA fixtures only. This is not product rights
    # issuance or accepted runtime qualification for an application host.
    approval = p.MethodExecutionApproval(
        registered.manifest_sha256, registered.module_sha256, "a" * 64
    )
    try:
        receipt["compile"] = r.compile_method(registered, approval=approval)
        result = r.execute_method(registered, snapshot, approval=approval)
        assert result["rows"] == [
            {"label_id": 7, "values": [2.0]},
            {"label_id": 42, "values": [3.0]},
        ]
        assert result["metrics"][0]["unit"] == "pixel"
        assert result["scientific_review"] == "pending"
        assert result["input_sha256"] == snapshot.sha256
        assert result["output_sha256"] == p.sha256(expected_output)
        receipt["execute"] = result
        # A maximal-scale scalar Core compiler workload fits the 256KiB cap.
        _section, _uleb = p._qualification_section, p._qualification_uleb
        count = 37000
        base = registered.module_bytes
        stress = (
            base[:8]
            + _section(1, b"\x01\x60\x04\x7f\x7f\x7f\x7f\x01\x7f")
            + _section(3, _uleb(count) + b"\0" * count)
            + _section(5, b"\x01\x01\x01\x80\x04")
            + _section(
                7,
                b"\x02\x06memory\x02\0"
                + _uleb(len(b"loci_method_v1"))
                + b"loci_method_v1\0\0",
            )
            + _section(10, _uleb(count) + b"\x04\0\x41\0\x0b" * count)
        )
        manifest = registered.manifest()
        manifest["module"] = {"sha256": p.sha256(stress), "bytes": len(stress)}
        stress_method = p.register_method(manifest, stress)
        stress_approval = p.MethodExecutionApproval(
            stress_method.manifest_sha256, stress_method.module_sha256, "a" * 64
        )
        before = time.monotonic()
        children = []
        original_popen = r.subprocess.Popen

        def launch(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            children.append(child)
            return child

        r.subprocess.Popen = launch
        try:
            r.compile_method(stress_method, approval=stress_approval)
            stress_result = "compiled"
        except r.MethodExecutionError:
            stress_result = "refused"
        finally:
            r.subprocess.Popen = original_popen
        receipt["compiler_stress"] = {
            "module_bytes": len(stress),
            "module_sha256": p.sha256(stress),
            "functions": count,
            "outcome": stress_result,
            "seconds": time.monotonic() - before,
            "returncodes": [child.returncode for child in children],
        }
    except Exception as exc:  # noqa: BLE001 - retain failed QA evidence and return nonzero
        receipt["execution_error"] = {
            "type": type(exc).__name__,
            "detail": str(exc)[:2048],
        }
    checks = {
        "tests": tests.returncode == 0,
        "executed": "execute" in receipt and "execution_error" not in receipt,
        "address_space": receipt["probes"]["address-space"]["returncode"] == 0,
        "cpu": receipt["probes"]["cpu"]["returncode"] == -signal.SIGKILL,
        "file_size": receipt["probes"]["file-size"]["returncode"]
        in (0, -signal.SIGXFSZ),
        "fuel": "fuel consumed" in receipt["probes"]["fuel"]["stdout"],
        "stack": "call stack exhausted" in receipt["probes"]["stack"]["stdout"],
        "heap": "Invalid method output length" in receipt["probes"]["heap"]["stdout"],
    }
    receipt["checks"] = checks
    receipt["passed"] = all(checks.values())
    receipt["seconds"] = time.monotonic() - started
    receipt["max_rss_kib"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    _write_receipt(receipt)
    print(
        json.dumps(
            {
                "passed": receipt["passed"],
                "checks": checks,
                "seconds": receipt["seconds"],
            }
        )
    )
    return 0 if receipt["passed"] else 1


def _write_receipt(receipt):
    descriptor, temporary = tempfile.mkstemp(prefix=".receipt-", dir=ROOT)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, ROOT / "receipt.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    started = time.monotonic()
    receipt = {
        "schema": "loci.controlled-method-linux-qa/v1",
        "passed": False,
        "job_id": os.environ.get("PBS_JOBID"),
        "queue": os.environ.get("PBS_QUEUE"),
        "checks": dict.fromkeys(
            (
                "tests",
                "executed",
                "address_space",
                "cpu",
                "file_size",
                "fuel",
                "stack",
                "heap",
            ),
            False,
        ),
    }
    try:
        return _run_qualification(receipt, started)
    except Exception as exc:  # noqa: BLE001 - retain setup, timeout, parse and fixture failures
        receipt["passed"] = False
        receipt["failure"] = {"type": type(exc).__name__, "detail": str(exc)[:2048]}
        receipt["seconds"] = time.monotonic() - started
        # Keep completed data and logs; an interrupted phase never becomes a
        # passing check merely because a preceding subprocess exited zero.
        receipt["checks"]["tests"] = receipt.get("pytest_returncode") == 0
        _write_receipt(receipt)
        print(
            json.dumps(
                {
                    "passed": False,
                    "failure": receipt["failure"],
                    "checks": receipt["checks"],
                }
            )
        )
        return 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--probe":
        probe(sys.argv[2])
    else:
        raise SystemExit(main())
