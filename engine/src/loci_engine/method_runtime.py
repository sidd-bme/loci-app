"""Bounded child compiler/executor for controlled Wasm Core methods.

No runtime is imported in the host. No downloads, cache, WASI, host functions,
serialized native modules, shell commands or arbitrary executable paths exist.
macOS/frozen execution fails closed: this first implementation has no qualified
hard compiler-memory confinement there. See docs/CONTROLLED_METHODS.md.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import selectors
import signal
import struct
import subprocess
import sys
import threading
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

# Keep child imports light. The protocol's NumPy import is lazy and used only by
# host validation; no scientific stack is loaded by the compiler child.
if __name__ == "__main__" and __package__ is None:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from loci_engine import method_protocol as protocol
else:
    from . import method_protocol as protocol

WASMTIME_VERSION = "50.0.1"
RUNTIME_PROFILE = "loci-wasmtime50-scalar-linux/v1"
ADDRESS_SPACE_BYTES = 768 * 1024**2
CPU_SECONDS = 8
WALL_SECONDS = 12.0
FUEL = 10_000_000
WASM_STACK_BYTES = 256 * 1024
MAX_DIAGNOSTIC_BYTES = 8192
MAX_RECEIPT_BYTES = 4096
_REQUEST_MAGIC = b"LOCMRQ01"
_RESPONSE_MAGIC = b"LOCMRS01"
_MAX_REQUEST = 20 + protocol.MAX_MODULE_BYTES + protocol.MAX_INPUT_BYTES
_MAX_RESPONSE = 12 + MAX_RECEIPT_BYTES + protocol.MAX_OUTPUT_BYTES


class MethodRuntimeUnavailable(RuntimeError):
    """No suitable installed runtime or supported confinement boundary."""


class MethodExecutionError(RuntimeError):
    """The child failed or returned invalid output; no result is published."""


def runtime_availability() -> dict[str, Any]:
    """Data-only availability, never a compatibility or qualification claim."""
    reason = None
    if sys.platform != "linux":
        reason = "Hard compiler address-space confinement is implemented only on Linux"
    elif getattr(sys, "frozen", False):
        reason = "Packaged child launcher is not implemented"
    else:
        try:
            installed = importlib.metadata.version("wasmtime")
        except importlib.metadata.PackageNotFoundError:
            reason = f"Optional wasmtime=={WASMTIME_VERSION} is not installed"
        else:
            if installed != WASMTIME_VERSION:
                reason = f"Expected exact wasmtime=={WASMTIME_VERSION}"
    return {
        "available": reason is None,
        "reason": reason,
        "runtime_profile": RUNTIME_PROFILE,
        "wasmtime_version": WASMTIME_VERSION,
        "qualification": "not-established",
    }


def _require_runtime() -> None:
    availability = runtime_availability()
    if not availability["available"]:
        raise MethodRuntimeUnavailable(availability["reason"])


def _stop_child(process: subprocess.Popen) -> None:
    # This process group was created by this launcher. Never act on caller PIDs.
    # The leader can exit while a descendant retains the pipes. Still terminate
    # that owned group on overflow/deadline/caller interruption before reaping.
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=2)


def _exchange(request: bytes, *, check=None) -> bytes:
    """Bound both streams while writing stdin; no unbounded communicate()."""
    _require_runtime()
    script = Path(__file__).resolve(strict=True)
    process = subprocess.Popen(
        [sys.executable, "-I", "-B", str(script), "--bounded-child", str(os.getpid())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        close_fds=True,
        start_new_session=True,
        cwd="/",
        env={"LANG": "C", "LC_ALL": "C"},
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    streams = (process.stdin, process.stdout, process.stderr)
    selector = selectors.DefaultSelector()
    out = bytearray()
    err = bytearray()
    sent = 0
    deadline = time.monotonic() + WALL_SECONDS
    previous_sigterm = None
    # Native/MCP supervisors terminate the outer executor with SIGTERM. Turn
    # that signal into normal unwinding so our independently owned child group
    # is cleaned up. A Linux parent-death signal also covers SIGKILL/crashes.
    if (
        threading.current_thread() is threading.main_thread()
        and signal.getsignal(signal.SIGTERM) == signal.SIG_DFL
    ):
        previous_sigterm = signal.SIG_DFL

        def interrupted(_signum, _frame):
            raise MethodExecutionError("Method caller was terminated before publication")

        signal.signal(signal.SIGTERM, interrupted)
    try:
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
        selector.register(process.stdin, selectors.EVENT_WRITE, "input")
        selector.register(process.stdout, selectors.EVENT_READ, "output")
        selector.register(process.stderr, selectors.EVENT_READ, "error")
        while selector.get_map():
            if check:
                check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MethodExecutionError("Method child exceeded wall-time limit")
            for key, _ in selector.select(min(remaining, 0.05)):
                stream = key.fileobj
                if key.data == "input":
                    try:
                        written = os.write(stream.fileno(), request[sent : sent + 65536])
                    except BrokenPipeError:
                        written = 0
                    sent += written
                    if sent == len(request) or written == 0:
                        selector.unregister(stream)
                        stream.close()
                else:
                    chunk = os.read(stream.fileno(), 65536)
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    target = out if key.data == "output" else err
                    limit = _MAX_RESPONSE if key.data == "output" else MAX_DIAGNOSTIC_BYTES
                    if len(target) + len(chunk) > limit:
                        raise MethodExecutionError("Method child exceeded output limit")
                    target.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MethodExecutionError("Method child exceeded wall-time limit")
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            raise MethodExecutionError("Method child exceeded wall-time limit") from exc
        if returncode != 0 or err or sent != len(request):
            # Never forward third-party diagnostics/paths into renderer-safe data.
            raise MethodExecutionError("Method child failed; no output was adopted")
        if check:
            check()
        return bytes(out)
    finally:
        selector.close()
        _stop_child(process)
        for stream in streams:
            stream.close()
        if previous_sigterm is not None:
            signal.signal(signal.SIGTERM, previous_sigterm)


def _parse_response(
    response: bytes, method: protocol.RegisteredMethod, input_bytes: bytes, mode: int
) -> tuple[dict[str, Any], bytes]:
    if not 12 <= len(response) <= _MAX_RESPONSE:
        raise MethodExecutionError("Invalid child response size")
    magic, receipt_len = struct.unpack("<8sI", response[:12])
    if magic != _RESPONSE_MAGIC or not 1 <= receipt_len <= MAX_RECEIPT_BYTES:
        raise MethodExecutionError("Invalid child response header")
    if 12 + receipt_len > len(response):
        raise MethodExecutionError("Truncated child receipt")
    try:
        receipt = json.loads(response[12 : 12 + receipt_len])
        if type(receipt) is not dict or set(receipt) != {
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
        }:
            raise ValueError("receipt shape")
        output = response[12 + receipt_len :]
        expected = {
            "schema": "loci.controlled-method-execution/v1",
            "mode": "compile" if mode == 0 else "execute",
            "runtime_profile": RUNTIME_PROFILE,
            "wasmtime_version": WASMTIME_VERSION,
            "module_sha256": method.module_sha256,
            "input_sha256": protocol.sha256(input_bytes),
            "output_sha256": protocol.sha256(output),
            "limits": _limits_record(),
        }
        if any(receipt[key] != value for key, value in expected.items()):
            raise ValueError("receipt binding")
        protocol._hash(receipt["native_sha256"], "runtime native library")
        if receipt["python_version"] != list(sys.version_info[:3]):
            raise ValueError("child Python version")
        if mode == 0 and output:
            raise ValueError("compile-only output")
        if protocol.canonical_json(receipt) != response[12 : 12 + receipt_len]:
            raise ValueError("noncanonical receipt")
    except (TypeError, ValueError, KeyError, RecursionError) as exc:
        raise MethodExecutionError("Child response identity mismatch") from exc
    return receipt, output


def _request(method: protocol.RegisteredMethod, input_bytes: bytes, mode: int) -> bytes:
    return (
        struct.pack(
            _REQUEST_FORMAT, _REQUEST_MAGIC, mode, len(method.module_bytes), len(input_bytes)
        )
        + method.module_bytes
        + input_bytes
    )


_REQUEST_FORMAT = "<8sIII"


def compile_method(
    method: protocol.RegisteredMethod, *, approval: protocol.MethodExecutionApproval, check=None
) -> dict[str, Any]:
    """Compile/typecheck in a bounded child without instantiation or execution."""
    protocol.validate_execution_approval(method, approval)
    receipt, _ = _parse_response(_exchange(_request(method, b"", 0), check=check), method, b"", 0)
    return receipt


def execute_method(
    method: protocol.RegisteredMethod,
    snapshot: protocol.MethodInput,
    *,
    approval: protocol.MethodExecutionApproval,
    check=None,
) -> dict[str, Any]:
    """Execute one immutable buffer snapshot, returning unreviewed finite data.

    This core has no persistence, source grant, job or graph authority. The caller
    must obtain those through normal application boundaries before invoking it.
    """
    protocol.validate_execution_approval(method, approval)
    protocol.validate_input_snapshot(snapshot)
    response = _exchange(_request(method, snapshot.buffer, 1), check=check)
    receipt, output = _parse_response(response, method, snapshot.buffer, 1)
    result = protocol.adopt_method_output(
        method, snapshot, output, expected_output_sha256=receipt["output_sha256"]
    )
    result["origin"] = "executed-local-child"
    result["runtime"] = receipt
    result["rights_evidence_sha256"] = approval.rights_evidence_sha256
    return result


def _limits_record() -> dict[str, Any]:
    return {
        "address_space_bytes": ADDRESS_SPACE_BYTES,
        "cpu_seconds": CPU_SECONDS,
        "wall_seconds": WALL_SECONDS,
        "fuel": FUEL,
        "linear_memory_bytes": protocol.MAX_MEMORY_PAGES * 65536,
        "wasm_stack_bytes": WASM_STACK_BYTES,
        "output_bytes": protocol.MAX_OUTPUT_BYTES,
    }


def _apply_child_limits() -> None:
    if sys.platform != "linux" or getattr(sys, "frozen", False):
        raise MethodRuntimeUnavailable("No supported hard compiler-memory boundary")
    import resource

    for name, maximum in (
        (resource.RLIMIT_AS, ADDRESS_SPACE_BYTES),
        (resource.RLIMIT_CPU, CPU_SECONDS),
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_FSIZE, 0),
    ):
        resource.setrlimit(name, (maximum, maximum))
        if resource.getrlimit(name) != (maximum, maximum):
            raise MethodRuntimeUnavailable("Child resource limit could not be established")


def _native_identity() -> str:
    dist = importlib.metadata.distribution("wasmtime")
    if dist.version != WASMTIME_VERSION:
        raise MethodRuntimeUnavailable("Incorrect Wasmtime version")
    files = [file for file in dist.files or [] if str(file).endswith("/_libwasmtime.so")]
    if len(files) != 1:
        raise MethodRuntimeUnavailable("Cannot identify exact installed Wasmtime native library")
    path = dist.locate_file(files[0])
    with open(path, "rb") as handle:
        content = handle.read(64 * 1024**2 + 1)
    if not 1 <= len(content) <= 64 * 1024**2:
        raise MethodRuntimeUnavailable("Invalid Wasmtime native library size")
    # The installed distribution is a trusted, separately provisioned dependency;
    # this actual content hash is provenance, not a publisher/signature assertion.
    return hashlib.sha256(content).hexdigest()


def _engine_config(wasmtime: Any) -> Any:
    config = wasmtime.Config()
    disabled = (
        "wasm_threads",
        "wasm_tail_call",
        "wasm_reference_types",
        "wasm_simd",
        "wasm_relaxed_simd",
        "wasm_bulk_memory",
        "wasm_multi_value",
        "wasm_multi_memory",
        "wasm_memory64",
        "wasm_component_model",
        "wasm_component_model_map",
        "wasm_component_model_implements",
        "wasm_exceptions",
        "wasm_function_references",
        "wasm_gc",
        "wasm_wide_arithmetic",
        "wasm_custom_page_sizes",
        "wasm_stack_switching",
        "parallel_compilation",
        "shared_memory",
        "memory_init_cow",
        "debug_info",
    )
    for name in disabled:
        # Python otherwise accepts a misspelled dynamic attribute without setting
        # the native option. Refuse API drift instead of silently omitting a cap.
        if not isinstance(getattr(type(config), name, None), property):
            raise MethodRuntimeUnavailable(f"Required Wasmtime option is absent: {name}")
        setattr(config, name, False)
    from wasmtime import _ffi

    _disable_native_component_features(config, _ffi)
    config.consume_fuel = True
    config.max_wasm_stack = WASM_STACK_BYTES
    config.strategy = "cranelift"
    config.cranelift_opt_level = "none"
    # Wasmtime's default multi-GiB virtual reservations conflict with RLIMIT_AS.
    # Limit fixed reservation to our hard 32MiB linear-memory maximum, keep a
    # small guard, disallow movement and reserve no additional growth space.
    config.memory_reservation = protocol.MAX_MEMORY_PAGES * 65536
    config.memory_guard_size = 65536
    config.memory_reservation_for_growth = 0
    config.memory_may_move = False
    return config


def _disable_native_component_features(config: Any, ffi: Any) -> None:
    """Pinned official C API flags omitted from Wasmtime 50's Python Config.

    The exact trusted distribution is checked before this import. Hard-coded
    symbols and documented signatures configure only that already loaded native
    library; no user library, code, option names or pointers are accepted.
    """
    import ctypes

    # Wasmtime 50 derives its default CM_ASYNC feature from concurrency_support.
    # This setter is implemented by its pinned C API. Component modules and
    # reference types remain disabled; neither is enabled to bypass a panic.
    setter = getattr(ffi.dll, "wasmtime_config_concurrency_support_set", None)
    if setter is None:
        raise MethodRuntimeUnavailable("Required Wasmtime native concurrency option is absent")
    setter.argtypes = [ctypes.POINTER(ffi.wasm_config_t), ctypes.c_bool]
    setter.restype = None
    setter(config.ptr(), False)


def _compile_and_run(module_bytes: bytes, input_bytes: bytes, mode: int) -> tuple[bytes, str]:
    surface = protocol.inspect_wasm_surface(module_bytes)
    native_hash = _native_identity()
    import wasmtime

    engine = wasmtime.Engine(_engine_config(wasmtime))
    module = wasmtime.Module(engine, module_bytes)
    if list(module.imports):
        raise protocol.MethodContractError("Wasm imports are forbidden")
    exported = {item.name: item.type for item in module.exports}
    if set(exported) != {"memory", "loci_method_v1"}:
        raise protocol.MethodContractError("Incorrect compiled ABI exports")
    memory_type = exported["memory"]
    function_type = exported["loci_method_v1"]
    if not isinstance(memory_type, wasmtime.MemoryType) or not isinstance(
        function_type, wasmtime.FuncType
    ):
        raise protocol.MethodContractError("Incorrect compiled ABI export types")
    if (
        memory_type.is_64
        or memory_type.is_shared
        or memory_type.page_size != 65536
        or memory_type.limits.min != surface.memory_min_pages
        or memory_type.limits.max != surface.memory_max_pages
        or [str(value) for value in function_type.params] != ["i32"] * 4
        or [str(value) for value in function_type.results] != ["i32"]
    ):
        raise protocol.MethodContractError("Incorrect compiled ABI signature or memory")
    if mode == 0:
        return b"", native_hash
    store = wasmtime.Store(engine)
    store.set_limits(
        memory_size=protocol.MAX_MEMORY_PAGES * 65536,
        table_elements=0,
        instances=1,
        tables=0,
        memories=1,
    )
    store.set_fuel(FUEL)
    instance = wasmtime.Instance(store, module, [])
    exports = instance.exports(store)
    memory = exports["memory"]
    entry = exports["loci_method_v1"]
    # The first page belongs to the method's static data/scratch. ABI buffers
    # start at page 1, and every byte is accounted for before any memory growth.
    input_pointer = 65536
    output_pointer = (input_pointer + len(input_bytes) + 7) & ~7
    required = output_pointer + protocol.MAX_OUTPUT_BYTES
    pages = (required + 65535) // 65536
    if pages > surface.memory_max_pages:
        raise protocol.MethodContractError("Module memory cannot hold bounded ABI buffers")
    if memory.size(store) < pages:
        memory.grow(store, pages - memory.size(store))
    memory.write(store, input_bytes, input_pointer)
    written = entry(
        store, input_pointer, len(input_bytes), output_pointer, protocol.MAX_OUTPUT_BYTES
    )
    if type(written) is not int or not 16 <= written <= protocol.MAX_OUTPUT_BYTES:
        raise protocol.MethodContractError("Invalid method output length")
    if bytes(memory.read(store, input_pointer, input_pointer + len(input_bytes))) != input_bytes:
        raise protocol.MethodContractError("Method modified its input buffer")
    output = bytes(memory.read(store, output_pointer, output_pointer + written))
    if len(output) != written:
        raise protocol.MethodContractError("Truncated method output")
    return output, native_hash


def _parent_death_signal(expected_parent_pid: int) -> None:
    """Fail closed when the owning executor dies, including a SIGKILL race."""
    if sys.platform != "linux" or type(expected_parent_pid) is not int or expected_parent_pid <= 1:
        raise MethodRuntimeUnavailable("Cannot establish exact Linux parent ownership")
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    # PR_SET_PDEATHSIG is Linux-specific. No downloaded helper/native code exists.
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != expected_parent_pid:
        raise MethodRuntimeUnavailable("Method parent changed before confinement")


def _child_main(expected_parent_pid: int) -> int:
    try:
        _apply_child_limits()  # Before bytes, native runtime import or compilation.
        _parent_death_signal(expected_parent_pid)
        request = sys.stdin.buffer.read(_MAX_REQUEST + 1)
        if not 20 <= len(request) <= _MAX_REQUEST:
            raise protocol.MethodContractError("Invalid child request size")
        magic, mode, module_len, input_len = struct.unpack(_REQUEST_FORMAT, request[:20])
        if (
            magic != _REQUEST_MAGIC
            or mode not in {0, 1}
            or not 8 <= module_len <= protocol.MAX_MODULE_BYTES
            or input_len > protocol.MAX_INPUT_BYTES
            or len(request) != 20 + module_len + input_len
            or (mode == 0 and input_len != 0)
            or (mode == 1 and input_len < 24)
        ):
            raise protocol.MethodContractError("Invalid child request")
        module_bytes = request[20 : 20 + module_len]
        input_bytes = request[20 + module_len :]
        output, native_hash = _compile_and_run(module_bytes, input_bytes, mode)
        receipt = protocol.canonical_json(
            {
                "schema": "loci.controlled-method-execution/v1",
                "mode": "compile" if mode == 0 else "execute",
                "runtime_profile": RUNTIME_PROFILE,
                "wasmtime_version": WASMTIME_VERSION,
                "native_sha256": native_hash,
                "python_version": list(sys.version_info[:3]),
                "module_sha256": protocol.sha256(module_bytes),
                "input_sha256": protocol.sha256(input_bytes),
                "output_sha256": protocol.sha256(output),
                "limits": _limits_record(),
            }
        )
        if len(receipt) > MAX_RECEIPT_BYTES:
            raise protocol.MethodContractError("Receipt exceeds bound")
        sys.stdout.buffer.write(
            struct.pack("<8sI", _RESPONSE_MAGIC, len(receipt)) + receipt + output
        )
        sys.stdout.buffer.flush()
        return 0
    except Exception:
        # Exception text can contain paths, raw metadata or native diagnostics.
        sys.stderr.buffer.write(b"controlled-method-child-failed\n")
        sys.stderr.buffer.flush()
        return 1


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--bounded-child" or not sys.argv[2].isdigit():
        raise SystemExit(2)
    raise SystemExit(_child_main(int(sys.argv[2])))
