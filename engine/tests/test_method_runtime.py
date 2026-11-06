"""Host boundary tests plus optional exact-runtime Linux execution probes."""

from __future__ import annotations

import ctypes
import importlib.metadata
import json
import os
import signal
import struct
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_method_protocol import approval, method, module_bytes, output_bytes, snapshot

from loci_engine import method_protocol as p
from loci_engine import method_runtime as r


def response(registered, input_bytes, output=b"", mode="compile"):
    receipt = {
        "schema": "loci.controlled-method-execution/v1",
        "mode": mode,
        "runtime_profile": r.RUNTIME_PROFILE,
        "wasmtime_version": r.WASMTIME_VERSION,
        "native_sha256": "f" * 64,
        "python_version": list(sys.version_info[:3]),
        "module_sha256": registered.module_sha256,
        "input_sha256": p.sha256(input_bytes),
        "output_sha256": p.sha256(output),
        "limits": r._limits_record(),
    }
    encoded = p.canonical_json(receipt)
    return struct.pack("<8sI", r._RESPONSE_MAGIC, len(encoded)) + encoded + output


def test_macos_refuses_before_loading_or_spawning(monkeypatch):
    monkeypatch.setattr(r.sys, "platform", "darwin")
    monkeypatch.setattr(
        r.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("child launched")
    )
    registered = method()
    assert not r.runtime_availability()["available"]
    with pytest.raises(r.MethodRuntimeUnavailable, match="compiler"):
        r.compile_method(registered, approval=approval(registered))
    with pytest.raises(r.MethodRuntimeUnavailable, match="compiler"):
        r.execute_method(registered, snapshot(), approval=approval(registered))


def test_missing_or_stale_optional_dependency_is_not_installed(monkeypatch):
    monkeypatch.setattr(r.sys, "platform", "linux")
    monkeypatch.setattr(r.sys, "frozen", False, raising=False)
    monkeypatch.setattr(r.importlib.metadata, "version", lambda name: "50.0.0")
    assert not r.runtime_availability()["available"]

    def missing(name):
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(r.importlib.metadata, "version", missing)
    assert "not installed" in r.runtime_availability()["reason"]


def test_compile_and_execute_use_distinct_modes_and_bind_provenance(monkeypatch):
    registered = method()
    supplied = snapshot()
    requests = []

    def exchange(request, **_kwargs):
        requests.append(request)
        _, mode, module_len, input_len = struct.unpack("<8sIII", request[:20])
        assert request[20 : 20 + module_len] == registered.module_bytes
        if mode == 0:
            assert input_len == 0
            return response(registered, b"")
        assert request[20 + module_len :] == supplied.buffer
        return response(registered, supplied.buffer, output_bytes(), "execute")

    monkeypatch.setattr(r, "_exchange", exchange)
    assert r.compile_method(registered, approval=approval(registered))["mode"] == "compile"
    result = r.execute_method(registered, supplied, approval=approval(registered))
    assert len(requests) == 2
    assert result["origin"] == "executed-local-child"
    assert result["runtime"]["native_sha256"] == "f" * 64
    assert result["scientific_review"] == "pending"
    assert result["rights_evidence_sha256"] == "a" * 64


@pytest.mark.parametrize(
    "field,value",
    [
        ("module_sha256", "0" * 64),
        ("input_sha256", "0" * 64),
        ("output_sha256", "0" * 64),
        ("wasmtime_version", "50.0.0"),
        ("mode", "execute"),
        ("native_sha256", "bad"),
    ],
)
def test_tampered_child_receipt_is_not_adopted(field, value):
    registered = method()
    original = response(registered, b"")
    receipt = json.loads(original[12:])
    receipt[field] = value
    encoded = p.canonical_json(receipt)
    with pytest.raises(r.MethodExecutionError):
        r._parse_response(
            struct.pack("<8sI", r._RESPONSE_MAGIC, len(encoded)) + encoded, registered, b"", 0
        )


def test_unapproved_execution_refuses_before_child(monkeypatch):
    monkeypatch.setattr(r, "_exchange", lambda *args: pytest.fail("child ran"))
    with pytest.raises(p.MethodContractError):
        r.compile_method(method(), approval=None)


@pytest.mark.skipif(os.name != "posix", reason="owned process-group supervisor requires POSIX")
@pytest.mark.parametrize(
    "program,message",
    [
        ("import time; time.sleep(5)", "wall-time"),
        ("import os; os.write(1, b'x' * 100000)", "output limit"),
        ("import sys; sys.stderr.write('private-path'); sys.exit(1)", "failed"),
    ],
)
def test_real_child_supervision_bounds_stalls_streams_and_diagnostics(
    monkeypatch, program, message
):
    original_popen = subprocess.Popen
    launched = []

    def launch(command, **kwargs):
        assert command[1:3] == ["-I", "-B"]
        assert kwargs["close_fds"] and kwargs["start_new_session"]
        assert kwargs["env"] == {"LANG": "C", "LC_ALL": "C"}
        child = original_popen([sys.executable, "-I", "-c", program], **kwargs)
        launched.append(child)
        return child

    monkeypatch.setattr(r, "_require_runtime", lambda: None)
    monkeypatch.setattr(r.subprocess, "Popen", launch)
    monkeypatch.setattr(r, "WALL_SECONDS", 0.2)
    monkeypatch.setattr(r, "_MAX_RESPONSE", 64)
    with pytest.raises(r.MethodExecutionError, match=message):
        r._exchange(b"small request")
    assert len(launched) == 1 and launched[0].poll() is not None


def test_child_limits_are_set_and_read_back_before_runtime(monkeypatch):
    import resource

    monkeypatch.setattr(r.sys, "platform", "linux")
    monkeypatch.setattr(r.sys, "frozen", False, raising=False)
    limits = {}
    monkeypatch.setattr(resource, "setrlimit", lambda name, value: limits.update({name: value}))
    monkeypatch.setattr(resource, "getrlimit", lambda name: limits[name])
    r._apply_child_limits()
    assert limits[resource.RLIMIT_AS] == (r.ADDRESS_SPACE_BYTES,) * 2
    assert limits[resource.RLIMIT_CPU] == (r.CPU_SECONDS,) * 2
    assert limits[resource.RLIMIT_CORE] == (0, 0)
    monkeypatch.setattr(resource, "getrlimit", lambda name: (-1, -1))
    with pytest.raises(r.MethodRuntimeUnavailable):
        r._apply_child_limits()


@pytest.mark.skipif(os.name != "posix", reason="owned process groups require POSIX")
@pytest.mark.parametrize("interrupt", [False, True])
def test_supervisor_cleans_descendant_after_leader_exit_or_caller_interrupt(monkeypatch, interrupt):
    original_popen = subprocess.Popen
    launched = []
    # The leader exits immediately; its child retains stdout/stderr and sleeps.
    program = (
        "import os,time; child=os.fork(); "
        "os.write(1, str(child).encode()) if child else time.sleep(5)"
    )

    def launch(command, **kwargs):
        child = original_popen([sys.executable, "-I", "-c", program], **kwargs)
        launched.append(child)
        return child

    monkeypatch.setattr(r, "_require_runtime", lambda: None)
    monkeypatch.setattr(r.subprocess, "Popen", launch)
    monkeypatch.setattr(r, "WALL_SECONDS", 0.3)
    if interrupt:
        original_select = r.selectors.DefaultSelector.select

        def cancel(selector, timeout=None):
            ready = original_select(selector, timeout)
            if launched[0].poll() is not None:
                raise KeyboardInterrupt
            return ready

        monkeypatch.setattr(r.selectors.DefaultSelector, "select", cancel)
    with pytest.raises(KeyboardInterrupt if interrupt else r.MethodExecutionError):
        r._exchange(b"small request")
    assert len(launched) == 1 and launched[0].poll() is not None
    # SIGKILL delivery is asynchronous. Zombies may briefly retain the group on
    # Linux until PID1 reaps them; none may remain running or retain a pipe.
    if sys.platform == "linux":
        deadline = time.monotonic() + 1
        while True:
            alive = []
            for entry in Path("/proc").glob("[0-9]*/stat"):
                try:
                    fields = entry.read_text().rsplit(")", 1)[1].split()
                    if int(fields[2]) == launched[0].pid and fields[0] != "Z":
                        alive.append(entry)
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if not alive or time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        assert not alive


def test_config_rejects_silently_missing_native_options():
    class Unsupported:
        class Config:
            pass

    with pytest.raises(r.MethodRuntimeUnavailable, match="option is absent"):
        r._engine_config(Unsupported)


def test_pinned_native_component_flags_disable_without_enabling_reference_types():
    class ConfigType(ctypes.Structure):
        pass

    pointer = ctypes.pointer(ConfigType())
    config = SimpleNamespace(ptr=lambda: pointer)
    calls = []

    def setter(ptr, value):
        assert ptr is pointer
        calls.append(value)

    dll = SimpleNamespace(wasmtime_config_concurrency_support_set=setter)
    ffi = SimpleNamespace(dll=dll, wasm_config_t=ConfigType)
    r._disable_native_component_features(config, ffi)
    assert calls == [False]
    delattr(dll, "wasmtime_config_concurrency_support_set")
    with pytest.raises(r.MethodRuntimeUnavailable, match="native concurrency option"):
        r._disable_native_component_features(config, ffi)


@pytest.mark.skipif(os.name != "posix", reason="owned process groups require POSIX")
def test_cooperative_policy_cancellation_reaps_exact_child(monkeypatch):
    original_popen = subprocess.Popen
    launched = []

    def launch(command, **kwargs):
        child = original_popen([sys.executable, "-I", "-c", "import time; time.sleep(5)"], **kwargs)
        launched.append(child)
        return child

    def cancelled():
        raise PermissionError("policy revoked")

    monkeypatch.setattr(r, "_require_runtime", lambda: None)
    monkeypatch.setattr(r.subprocess, "Popen", launch)
    with pytest.raises(PermissionError, match="revoked"):
        r._exchange(b"request", check=cancelled)
    assert launched[0].poll() is not None


@pytest.mark.skipif(os.name != "posix", reason="native SIGTERM supervisor requires POSIX")
def test_native_outer_sigterm_unwinds_and_reaps_nested_child(tmp_path):
    pid_file = tmp_path / "nested.pid"
    program = (
        "import os,sys,subprocess; from pathlib import Path; "
        f"sys.path.insert(0, {str(Path(r.__file__).resolve().parent.parent)!r}); "
        "from loci_engine import method_runtime as r; original=subprocess.Popen; "
        "r._require_runtime=lambda:None; "
        "\ndef launch(command,**kwargs):\n"
        " child=original([sys.executable,'-I','-c','import time; time.sleep(20)'],**kwargs)\n"
        f" Path({str(pid_file)!r}).write_text(str(child.pid))\n"
        " return child\n"
        "r.subprocess.Popen=launch\n"
        "r._exchange(b'request')\n"
    )
    outer = subprocess.Popen(
        [sys.executable, "-I", "-c", program], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    nested_pid = None
    try:
        deadline = time.monotonic() + 3
        while not pid_file.exists() and outer.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert pid_file.exists()
        nested_pid = int(pid_file.read_text())
        # The signal handler is installed before the first cancellation check.
        time.sleep(0.05)
        outer.terminate()
        outer.wait(timeout=3)
        with pytest.raises(ProcessLookupError):
            os.kill(nested_pid, 0)
    finally:
        if outer.poll() is None:
            outer.kill()
            outer.wait(timeout=3)
        if nested_pid is not None:
            with suppress(ProcessLookupError):
                os.kill(nested_pid, signal.SIGKILL)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux kernel parent-death confinement")
def test_linux_parent_death_kills_method_child(tmp_path):
    ready = tmp_path / "parent-death-ready"
    pid_file = tmp_path / "parent-death.pid"
    inner = (
        "import sys,time; from pathlib import Path; "
        f"sys.path.insert(0,{str(Path(r.__file__).resolve().parent.parent)!r}); "
        "from loci_engine import method_runtime as r; "
        "r._parent_death_signal(int(sys.argv[1])); "
        f"Path({str(ready)!r}).write_text('ready'); time.sleep(20)"
    )
    program = (
        "import os,sys,subprocess,time; from pathlib import Path; "
        f"child=subprocess.Popen([sys.executable,'-I','-c',{inner!r},str(os.getpid())]); "
        f"Path({str(pid_file)!r}).write_text(str(child.pid)); time.sleep(20)"
    )
    outer = subprocess.Popen([sys.executable, "-I", "-c", program])
    nested_pid = None
    try:
        deadline = time.monotonic() + 3
        while not ready.exists() and outer.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists() and pid_file.exists()
        nested_pid = int(pid_file.read_text())
        outer.kill()  # No Python finally handler can run in the owning executor.
        outer.wait(timeout=3)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = Path(f"/proc/{nested_pid}/stat")
            if not status.exists() or status.read_text().rsplit(")", 1)[1].split()[0] == "Z":
                break
            time.sleep(0.01)
        else:
            pytest.fail("Method child survived its exact owning parent's death")
    finally:
        if outer.poll() is None:
            outer.kill()
            outer.wait(timeout=3)
        if nested_pid is not None:
            with suppress(ProcessLookupError):
                os.kill(nested_pid, signal.SIGKILL)


def _signed_leb(value: int) -> bytes:
    encoded = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        done = (value == 0 and byte & 64 == 0) or (value == -1 and byte & 64 != 0)
        encoded.append(byte if done else byte | 128)
        if done:
            return bytes(encoded)


def _constant_output_module(output: bytes) -> bytes:
    # (local.get 2) (i32.const offset) i32.add (i32.const word) i32.store
    # This is an inspectable constant-output ABI fixture, not an assay oracle.
    instructions = bytearray()
    for offset in range(0, len(output), 4):
        word = int.from_bytes(output[offset : offset + 4], "little", signed=True)
        instructions += b"\x20\x02\x41" + _signed_leb(offset) + b"\x6a\x41"
        instructions += _signed_leb(word) + b"\x36\x02\0"
    instructions += b"\x41" + _signed_leb(len(output))
    return module_bytes(body=bytes(instructions))


@pytest.mark.skipif(
    not r.runtime_availability()["available"], reason="exact optional Linux runtime absent"
)
def test_real_optional_runtime_compiles_and_executes_exact_output():
    registered = method(_constant_output_module(output_bytes()))
    compiled = r.compile_method(registered, approval=approval(registered))
    assert compiled["mode"] == "compile"
    result = r.execute_method(registered, snapshot(), approval=approval(registered))
    assert result["rows"] == [{"label_id": 7, "values": [2.0]}, {"label_id": 42, "values": [3.0]}]
    assert result["runtime"]["limits"]["address_space_bytes"] == r.ADDRESS_SPACE_BYTES


@pytest.mark.skipif(
    not r.runtime_availability()["available"], reason="exact optional Linux runtime absent"
)
@pytest.mark.parametrize(
    "body",
    [
        b"\x03\x40\x0c\x00\x0b\x41\0",  # infinite loop: fuel or CPU/wall trap
        b"\x41\x7f",  # invalid negative output length
        b"\x20\0\x41\x00\x36\x02\0\x41\x10",  # overwrite input magic
    ],
)
def test_real_optional_runtime_refuses_loops_and_bad_outputs(body):
    registered = method(module_bytes(body=body))
    with pytest.raises((r.MethodExecutionError, p.MethodContractError)):
        r.execute_method(registered, snapshot(), approval=approval(registered))
