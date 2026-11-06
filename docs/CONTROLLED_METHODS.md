# Controlled reusable methods

This contract describes the controlled-method source implementation. Verification
belongs to the exact source and packaged artifact tested. The [release status](RELEASE_STATUS.md)
identifies published artifacts; successful import alone does not qualify a method.
`method_protocol.py` and `method_runtime.py` provide a bounded Core Wasm lane;
`research_methods.py` adds native-owned packages, exact-input preflight, external
output adoption, durable publication and cold validation. No dependency or lock
change is required. macOS and frozen-app execution still refuse before launching
a child. There is no remote transport. Linux execution additionally requires
complete native-accepted qualification of the actual installed runtime and a
current native-issued rights decision.

## Product workflow and authority

The native import picker copies a bounded JSON package containing exactly:

```json
{"schema":"loci.controlled-method-package/v1","manifest":{},"module_base64":"..."}
```

The manifest follows the contract below; base64 is canonical and decodes to the
exact hashed Wasm module. Import never compiles or executes it. Selected files and
all path components must be regular/nonlinked; bounded reads verify the same file
identity before and after copying. The study-owned `controlled_method` document
is immutable, revision one, and identified by the first 32 manifest-hash digits.
The full manifest and module hashes remain authoritative; a short-ID collision
refuses. Method manifests cannot contain absolute local paths.

Shared native/SDK/MCP operations are `method_list`, `method_get`,
`method_runtime`, `method_preflight`, `method_run`, `method_result` and
`method_query`. They use the existing action guide and inspection/task tools;
there is no assay-specific top-level tab or implicit execution permission.
Agent authority must cover the exact parent ancestry, source crop/series/Z/T,
every original measurement channel and every explicitly ordered raw input channel.
Listing a method never issues execution authority.

Preflight takes `method_id`, `manifest_sha256`, `module_sha256`, `result_id`,
`revision_hash`, `raw_channels` and `working_bytes`. It verifies the underlying
immutable native scalar label result, correction ancestry and calibrated grid;
loads exact source channels; and constructs an immutable ABI input. Its hash
binds source fingerprint, series, source crop/Z/T/C/level, ordered raw-channel
indices, parent artifacts/revision, label IDs, calibration and input bytes.
Only one native YX plane, positive axis-aligned image-frame geometry and explicit
pixel or micrometre units are supported. Volumes, pyramid levels, RGB samples,
oblique/reflected/sheared grids and implicit dtype conversion refuse.

The native input-export operation writes an absent selected ZIP atomically. It
contains `input.bin`, `binding.json`, `manifest.json`, `module.wasm` and a hashed
member receipt. The returned receipt binds the whole ZIP hash and safe basename.
Fresh source/input checks precede no-overwrite publication. This is an inert
handoff for an independently controlled executor; it performs no execution or
network transfer and carries no live approval. Native output import copies a
bounded `output.bin` into an immutable, exact-preflight grant after validating all
labels and metric values. Agent requests carry only that opaque grant ID.

`method_run` includes the complete preflight request, `preflight_hash`, and
`mode`: `adopt-external` additionally requires `output_grant_id`; `execute` must
not supply one. Both publish only through their own exact durable native job and
the existing atomic result transaction. Policy/session revocation, cancellation,
stale parents/sources/packages or a changed output grant prevent publication.
Result derivatives retain original `image`, `labels` and original measurement
fields; add `method_raw`, `method_module`, `method_output`; and attach namespaced
per-label values with manifest units and measurement/prediction kinds. They start
without review. Correct or annotate the underlying labels and rerun the method;
generic correction/ROI editing of the derivative refuses.

Cold read/export/restore validates the complete package, exact parent chain,
source selection, retained NPY identities, rebuilt ABI input and byte-exact
output/metric rows without executing code or decoding source pixels. External
adoption always retains `origin: adopted-external` and `runtime: null`.
Historical local execution retains its actual runtime receipt and accepted
qualification/evidence identity. A restored historical result cannot issue new
rights or runtime authority. Renderer/MCP summaries omit executable module bytes,
private grants and rights-evidence text.

Native rights review takes a concrete reviewer, evidence text and explicit
approved/revoked decision bound to the exact package hashes. Its local
`controlled_method_authority` audit preserves evidence hashes and event history;
latest revocation is checked during execution and again at publication. Neither
this local audit nor the non-deserializable code-owned native capability is a
signature or authentication protocol against a compromised application/OS.
`controlled_method_authority` and `controlled_method_output_grant` documents are
local trust state and excluded/refused in portable restoration.

`install_runtime_qualification` accepts complete Linux QA evidence only at the
native boundary and writes code-owned local trust state outside studies, under
`~/.local/share/loci/controlled-method-runtime/accepted.json`. It binds the QA
evidence bytes, actual native-library and Python-executable hashes, Python and
NumPy versions, platform, and exact protocol/runtime source hashes. Acceptance
requires the pinned official platform-wheel hash, successful structured test
results with nested cancellation and parent-death coverage, exact scalar ABI
output, hard address-space/CPU/file-size probes and native fuel/stack/heap traps.
The installer independently reconstructs the code-owned fixture's module,
manifest, input and output bytes. It compares the actual current five-file
qualified source layout (protocol, runtime, both tests and harness), and parses
hash-bound, bounded JUnit XML with DTD/entities forbidden. Named testcases and
literal parameter counts are derived from the current test AST without executing
test source. All current cases must be present exactly once and pass; summary
counts must agree. Incomplete/old, modified, unsuccessful or stale evidence
refuses; receipt truth flags alone are insufficient. Every product execution resolves current local
qualification and rights authority, then constructs its internal core approval.
No package, renderer or agent request can supply an approval or qualification.
Real Linux runtime QA has exercised the pinned scalar runtime profile. Product evidence
validation is separate from installing native authority on a matching host;
simulated test receipts never establish runtime acceptance for a real host.

## Authority and reproducibility

`register_method(manifest, module_bytes)` copies and validates a bounded binary
and canonical manifest. It neither compiles nor executes. The module hash and
byte count must match. Manifest schema is `loci.controlled-method/v1`, ABI is
`loci-method-buffers/v1`, method version is a concrete three-part version.
Rights contain declared license, source and use basis. These are declarations,
not verified permission or a signed publisher identity.

Compilation and execution require a separate internal `MethodExecutionApproval`
with the exact manifest/module hashes and the hash of genuine rights-review
evidence. The application must create that record only after resolving real
review evidence and authority. It must never deserialize an approval from a
method package, agent request or renderer. This internal value is not an
authentication or signature protocol. The product adapter supplies persistent
native rights review/revocation and existing source/agent grants; the low-level
core alone does not issue that authority.

`compile_method` compiles/typechecks in a bounded child without instantiating or
executing any Wasm function. `execute_method` freshly compiles and executes in a
new bounded child. No serialized native code or compiled module cache is accepted.
Each execution binds actual module, manifest, input and output hashes; exact
Wasmtime/Python versions; actual installed native-library hash; limits; and
rights-review evidence. The native hash is provenance of a separately trusted
installation, not independent publisher verification.

`adopt_method_output` verifies externally supplied bytes with an expected output
hash and input/label identity. It explicitly records `adopted-external` and no
runtime. It does not imply this host executed the method. Neither adoption nor
execution writes files or publishes a project result. Both return scientific
review `pending`. Metric declarations distinguish `measurement` from
`prediction`; finite values and successful execution do not establish accuracy.

## Version 1 binary ABI

A module exports exactly one memory named `memory` and one function:

```text
loci_method_v1(input_ptr:i32, input_len:i32,
               output_ptr:i32, output_capacity:i32) -> i32
```

The return value is the output byte count. All numeric fields use little endian.
The memory is unshared, 32-bit, explicitly maximum-bounded, with 64 KiB pages.
The first page is module static data/scratch. Host input starts at byte 65536;
output follows at the next 8-byte boundary. The host grows memory only within
the declared maximum. Methods must reserve these ABI regions and return without
modifying the input bytes. Unsupported memory requirements fail, never truncate.

The 24-byte input header is `<8sIIII>`:

| Field | Meaning |
| --- | --- |
| magic | `LOCIMI01` |
| metadata bytes | Length of canonical ASCII JSON |
| labels bytes | Length of row-major uint32 label plane |
| raw bytes | Length of channel-major raw scalar array |
| reserved | Must be zero |

The three blocks follow immediately, without padding. Metadata records ABI,
source fingerprint, exact label revision, both buffer hashes, explicit YX/CYX
shapes and dtypes, and geometry. Labels are native-input uint32, serialized as
`uint32-le`; background is zero; nonzero IDs are preserved. Raw channels support
native-input uint8/uint16/float32/float64, serialized little endian without
normalization or channel inference. Only finite raw values are accepted.
Geometry is native level zero, axes YX, explicit origin and positive spacing in
pixels or micrometres (`um`). Uncalibrated pixel spacing must be `[1,1]`. Source
identities are opaque hashes, never paths or patient metadata. The caller still
must bind those hashes to its authorized source; this core cannot verify a path
it never receives. V1 has no arbitrary settings payload or implicit resampling.

The 16-byte output header is `<8sII>`: magic `LOCIMO01`, row count, metric count.
Each row is `<I` followed by one `<d` per manifest metric: an original uint32
label ID and finite float64 values. Rows must contain every nonzero input label
exactly once, in ascending ID order. No background row, dropping, reordering,
new labels, NaN, infinity, trailing bytes or metric-count mismatch is accepted.
Units, semantic descriptions and measurement/prediction kind remain attached to
the manifest. Prediction outputs are not relabeled as measured observations.

## Admission and resource bounds

Static binary scanning rejects non-Core/versioned binaries, all imports (including
WASI), start functions, tables/elements, extension sections, duplicate/unordered
sections, unbounded/shared/64-bit memory, unknown exports and oversized bytes.
This scanner is intentionally not an opcode validator. The child compiler then
validates the entire module and checks exact function and memory export types.
Only scalar MVP features are configured; available proposal flags are explicitly
disabled and missing configuration properties fail closed.

Wasmtime 50's Python `Config` omits the concurrency control used to derive its
default component-model async feature. The child calls the pinned, documented
C API `wasmtime_config_concurrency_support_set(config, false)` through that exact
already-loaded trusted runtime. The `wasm_config_t*`/`bool` signature and symbol
are fixed in application code; a missing symbol refuses before constructing an
engine. Reference types remain disabled. This avoids the actual component-async
dependency panic without enabling another proposal. Primary sources:
[C implementation](https://github.com/bytecodealliance/wasmtime/blob/v50.0.1/crates/c-api/src/config.rs)
and [feature derivation](https://github.com/bytecodealliance/wasmtime/blob/v50.0.1/crates/wasmtime/src/config.rs).

Qualification uses an exact five-file layout. In a source checkout these are
`engine/src/loci_engine/method_protocol.py`, `method_runtime.py` alongside it,
`engine/tests/test_method_protocol.py`, `test_method_runtime.py` alongside it,
and `scripts/qa/controlled_method_linux.py`. A task-isolated worker uses
`ROOT/loci_engine/{method_protocol,method_runtime}.py`,
`ROOT/tests/{test_method_protocol,test_method_runtime}.py`, and
`ROOT/controlled_method_linux.py`. The source-hash manifest keys are respectively
`loci_engine/method_protocol.py`, `loci_engine/method_runtime.py`,
`tests/test_method_protocol.py`, `tests/test_method_runtime.py`, and
`controlled_method_linux.py`. Regenerate that manifest for the exact frozen
files; changing runtime, fixture, tests or harness requires new evidence.
`install-report.json` binds the separately provisioned pinned wheel. The harness
produces `receipt.json`, `pytest-results.xml`, stdout/stderr and structured probe
outcomes under a bounded allocation. Native acceptance checks source/layout
and actual installed interpreter/native identities; copying a successful report
to another runtime does not qualify it.

| Bound | V1 value |
| --- | --- |
| Module bytes | 256 KiB |
| Manifest or input metadata | 16 KiB each |
| Label grid | At most 262,144 YX pixels |
| Raw channels | 1–8, same YX shape |
| Nonzero labels | 1–16,384 |
| Metrics per object | 1–16 |
| Wasm linear memory | At most 32 MiB / 512 pages |
| Wasm stack | 256 KiB |
| Invocation fuel | 10,000,000 |
| Child address space | 768 MiB, Linux `RLIMIT_AS` |
| Child CPU | 8 seconds, Linux `RLIMIT_CPU` |
| Whole-child wall deadline | 12 seconds |
| Output | Exact ABI size, at most 2,162,704 bytes |
| Child stderr | 8 KiB; never forwarded as product data |

Both compilation and execution occur after the child applies and reads back its
hard address-space/CPU limits. Core dumps and regular-file growth are disabled.
The parent launches only its installed Python and code-owned helper, with isolated
mode, closed inherited descriptors, a fresh process group and a minimal
environment. It bounds stdout/stderr while concurrently sending bounded input,
kills/reaps its own child on deadline, overflow or cooperative cancellation, and rejects nonzero exit,
diagnostics, malformed receipts and identity mismatches. No `communicate()`
accumulation of unbounded output is used.

Native outer-executor SIGTERM unwinds through the owned-child cleanup boundary.
Linux child launch also establishes and verifies `PR_SET_PDEATHSIG(SIGKILL)`
against the exact parent PID, covering parent crashes/SIGKILL without relying on
Python finally handlers. This adds no filesystem/network host capability.

Wasmtime's virtual memory reservation is explicitly 32 MiB with a 64 KiB guard,
no extra growth reservation and no relocation, avoiding its default large
reservation under `RLIMIT_AS`. Parallel compilation and memory initialization
copy-on-write are off. Store heap/table/instance caps and fuel are additional
bounds; they are not described as a compiler or process-memory cap.

There is no WASI context, linker, host callback, filesystem/network/process/clock
import, shared memory or native-code deserialization. This is a Wasm capability
boundary using a trusted native compiler/runtime, not an OS sandbox against a
compromised Python installation or a Wasmtime native vulnerability. No seccomp,
network namespace, container or signed-runtime claim is made.

macOS has no established hard process address-space cap in this implementation.
A sampled RSS watchdog would not prove that cap. Therefore local compilation and
execution there refuse; fuel and linear-memory caps do not bypass that refusal.
Frozen-app helper packaging is also unavailable. A separately qualified Linux
worker (potentially the owner's authorized HPC lane) is a possible next stage,
not an implemented remote execution/transport feature.

## Proposed optional dependency and primary sources

Production dependency proposal only: `wasmtime==50.0.1`. No engine dependency or
lock edit accompanies this package. An isolated Linux qualification environment
has been provisioned as recorded below. The official release lists Python 3.9+
and macOS ARM64 wheels,
with Apache-2.0 WITH LLVM-exception licensing. Availability of a wheel does not
resolve the macOS confinement gap. Release metadata says uploads were not made
through Trusted Publishing. [Official release and hashes](https://pypi.org/project/wasmtime/50.0.1/).

| Candidate wheel | Published SHA-256 |
| --- | --- |
| `wasmtime-50.0.1-py3-none-macosx_11_0_arm64.whl` | `ff4fc58ed3cbdb919d056accd4d280be13962a542754aaefd8a9b4654efa9bd9` |
| `wasmtime-50.0.1-py3-none-manylinux2014_aarch64.whl` | `675484e525c028dc02762b777f1db4477ea70caa3fec6775426daff4d64edfb1` |
| `wasmtime-50.0.1-py3-none-manylinux1_x86_64.whl` | `cc14c3a17654e0394e0225b11813532ef0cd7bd1e222a0c5494cdedaabeddac4` |

Version-pinned primary API sources inspected on 30 October 2026:

- [Config flags, fuel, memory reservation and stack](https://github.com/bytecodealliance/wasmtime-py/blob/50.0.1/wasmtime/_config.py)
- [Store limits and fuel](https://github.com/bytecodealliance/wasmtime-py/blob/50.0.1/wasmtime/_store.py)
- [Core compilation and imports/exports](https://github.com/bytecodealliance/wasmtime-py/blob/50.0.1/wasmtime/_module.py)
- [Memory read/write/grow](https://github.com/bytecodealliance/wasmtime-py/blob/50.0.1/wasmtime/_memory.py)
- [Memory and function type checks](https://github.com/bytecodealliance/wasmtime-py/blob/50.0.1/wasmtime/_types.py)
- [Native library selection](https://github.com/bytecodealliance/wasmtime-py/blob/50.0.1/wasmtime/_ffi.py)

## Qualification and scientific review

The source includes `scripts/qa/controlled_method_linux.py` for an explicitly
allocated Linux CPU qualification run. It requires the exact current protocol,
runtime and test files, pinned installation evidence and a native worker profile.
It records structured JUnit outcomes, exact ABI fixture outputs, hard process
limits, native Wasm traps and compiler stress. Failed setup and probes retain a
failed receipt. Successful evidence must pass native acceptance against the
actual installed runtime before new execution is available.

The macOS packaged route supports registration, inspection, exact-input export
and explicitly external-output adoption. It does not execute imported Wasm or
send data to a remote service. The small scalar fixtures exercise engineering
contracts only. Each scientific method still needs its own rights assessment,
independent evaluation and researcher review; prediction values are never
relabeled as measured observations.
