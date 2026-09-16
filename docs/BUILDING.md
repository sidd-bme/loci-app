# Building Loci

## Build identity and handoff

Use [the shared collaboration protocol](COLLABORATION.md). The current verified
app and its evidence are listed at the top of [project state](PROJECT_STATE.md).
Do not infer freshness from an app's name, modification time or version alone.

Before building, record branch/HEAD, relevant working-tree changes, Node/Python
versions, lockfile identities, selected extras and the intended output directory.
Prefer a reviewed source commit. Serialize builds against the shared `engine/dist`
and desktop build directories; do not overwrite a bundle another process is using.
Use `npm run package:mac:local` from `desktop/`. It uses the existing Forge API,
config, signing hooks and resource checks, with the single candidate directory
`.loci/builds/staging/` inside the repository. It refuses occupied staging and a
concurrent packaging lock; it never replaces the current app. See
[project state](PROJECT_STATE.md) for qualification and promotion.

After building, record in the current handoff:

- Frozen worker source commit/tree, desktop source commit/tree, exact commands,
  platform/architecture and signing mode.
- Absolute app path and SHA-256 of `Contents/MacOS/Loci`,
  `Contents/Resources/app.asar` and `Contents/Resources/loci-engine/loci-engine`.
- Signature verification result, matching frozen-bundle verification and packaged
  journey receipts, fixture identities and every failed or skipped gate.
- Whether the installed/running app was replaced; otherwise say it remains older.

Run supported `desktop/tests/*.qa.mjs` journeys with `LOCI_PACKAGED_APP` pointing
at that exact app and `LOCI_QA_OUTPUT_ROOT` at its evidence folder. Select journeys
appropriate to the changed behavior; inspect each harness's fixture requirements.
Complete signature scans and other heavy work before timing UI interactions.
Reconcile receipt hashes with the app before calling it tested. A successful build
is not a passing workflow or a release. Logs and bundles remain local; keep the
portable identity/results summary and known gaps in project state.

## Development

The desktop shell and analysis worker are separate processes.

```bash
cd engine
uv sync --frozen --extra dev
uv run --frozen --extra dev pytest

# Add the locked ONNX inspection and inference runtime when needed.
uv sync --frozen --extra dev --extra onnx

# Add the exact optional Cellpose development runtime when needed.
uv sync --frozen --extra dev --extra cellpose

cd ../desktop
npm ci
npm start
```

These minimal development profiles can remove other optional extras from a shared
virtual environment. For the qualified full worker profile, consistently use
`uv sync --frozen --extra dev --extra bundle --extra cellpose --extra onnx` and
retain the same extras on subsequent `uv run` commands. Coordinate environment
changes with the other editor. On the shared 8 GB Mac, set `VITEST_MAX_WORKERS=1`
for desktop checks and keep heavy suites and packaged QA sequential.

Node 24 and Python 3.11-3.13 are supported development baselines. The checked-in
`engine/.python-version` pins reproducible engine and bundle work to Python 3.12. Source
images are opened through the native picker and are never copied into the
repository.

## Local macOS package

Build and smoke-test the isolated worker, then bundle the Apple-silicon app.
The current profile freezes the locked core runtime, ONNX runtime, and exact
Cellpose 4.2.1.1 runtime but never bundles or downloads the `cpsam` or
`cpsam_v2` checkpoint:

```bash
./scripts/build-engine.sh
cd desktop
npm run package:mac:local
```

`build-engine.sh` resolves the checked-in lock with Python 3.12, verifies the
required imports, and creates a temporary synthetic modern-IMS fixture. The
frozen checks cover the real `--cli discover` path, health, LZW TIFF, modern IMS
overview, both Cellpose profile imports and isolated missing-checkpoint
behavior, classical segmentation, required native-library presence, exact
locked distribution metadata and notices, and clean EOF shutdown before
packaging can begin.

The output under `.loci/builds/staging/` has a fail-closed ad-hoc signature
for local integrity and packaged-app QA. Verify it with:

```bash
codesign --verify --deep --strict --verbose=2 \
  ../.loci/builds/staging/Loci-darwin-arm64/Loci.app
```

The packaged runtime exposes two independently provisioned profiles. Import the
original official `cpsam` artifact through **Cellpose-SAM · Website compatible**
for the website-compatible default, or import the genuine official `cpsam_v2`
artifact through **Cellpose-SAM v2** for the separate updated, unvalidated
profile. The original default is a compatibility choice, not an accuracy
recommendation. Each
profile verifies its own exact size and SHA-256 identity and rejects the other
checkpoint. Building the application never retrieves either artifact.

Every `package` and `make` command resolves `engine/dist/loci-engine` by
default, verifies that the platform worker executable exists (and is executable
on macOS/Linux), copies it into the bundle, and verifies the copied worker
before signing. Packaging stops with an actionable error if any of those checks
fails; macOS packaging also rejects a worker that lacks the requested binary
architecture. `LOCI_ENGINE_RESOURCE=/absolute/path/to/alternate-worker-directory` may
be used for an intentional alternate worker build; packaging stages it under
the canonical `Resources/loci-engine` name expected by the desktop runtime.

The unsuffixed `package`, `make`, `package:mac`, and `make:mac` commands are not
public-release shortcuts on macOS: they fail closed while Developer ID signing
and notarization are unavailable. Direct Windows packaging also fails closed
unless the explicit `:windows:local` lifecycle or
`LOCI_WINDOWS_PACKAGE_MODE=unsigned-local` is selected. Use only the explicit
local commands for the qualification artifacts described here.

The local signature uses repository-owned, per-process entitlements. Loci has
no camera, microphone, Bluetooth, location, USB, or printing entitlement; the
main and Chromium helper processes receive only the JIT permission required by
V8, the standard plugin helper receives its two executable-memory permissions,
and other binaries—including the Python worker—receive an empty entitlement
profile. The packaging hook also removes Electron's inherited device-use text
and arbitrary-network-load exception from the final `Info.plist` before it is
signed.

Inspect those guarantees after packaging with:

```bash
APP=../.loci/builds/staging/Loci-darwin-arm64/Loci.app
plutil -p "$APP/Contents/Info.plist"
codesign -d --entitlements :- "$APP" 2>/dev/null
codesign -d --entitlements :- \
  "$APP/Contents/Resources/loci-engine/loci-engine" 2>/dev/null
```

This is not a distributable trust signature: it has no Apple Developer team,
trusted timestamp, notarization ticket, or Gatekeeper assurance on another
Mac. Public distribution requires a separate release configuration with an
Apple Developer ID, hardened runtime, secure timestamping, notarization,
stapling, installer QA, and an explicit product licence.

The packaged app contains Loci's Apache-2.0 `LICENSE` and `NOTICE`, the
third-party notice summary, and Electron and Chromium licence texts under
`Contents/Resources/notices/`. Before any public binary release, run the
deterministic [release supply-chain workflow](RELEASE_EVIDENCE.md#generate-the-sboms-and-licence-archive)
against the final app. It generates strict CycloneDX 1.6 SBOMs and the
manifest-bound licence archive for the exact packaged runtime. The notice
summary is not a substitute for those artifacts, and mechanical evidence is
not a substitute for human licence review.

## Local Windows x64 qualification package

Use a Windows x64 host with PowerShell, Node 24, and `uv` 0.11.7 or a compatible
version. The builder resolves the checked-in lock with CPython 3.12, rejects a
non-x64 interpreter, freezes the same runtime as macOS, and runs the same
structural, CLI, and synthetic-fixture worker checks:

```powershell
./scripts/build-engine.ps1
Set-Location desktop
npm ci
npm run make:windows:local
```

The explicit local command creates an unpacked app under
`desktop/out/local-unsigned/Loci-win32-x64/`, a Squirrel.Windows Setup executable,
full NuGet package, and `RELEASES` file under
`desktop/out/local-unsigned/make/squirrel.windows/x64/`, and a portable archive under
`desktop/out/local-unsigned/make/zip/win32/x64/`. [Squirrel.Windows](https://www.electronforge.io/config/makers/squirrel.windows)
is the maintained Electron Forge installer route and does not require
administrator installation. The
portable ZIP is a qualification and troubleshooting companion, not a separate
update protocol.

The packager checks that both the source and copied worker are AMD64 PE files.
The unpacked Windows app carries the same five top-level notice files under
`resources/notices/` as the macOS app. Its frozen worker also retains the exact
locked distribution metadata and licence payloads for SimpleITK, OpenSlide
Python and binaries, Zarr, numcodecs, MCP, ONNX, ONNX Runtime, PyYAML, and
`roifile==2026.2.10`, plus the required native libraries. Cellpose code is
present, but both official checkpoints remain separately provisioned and are
never retrieved by the build.

These Windows artifacts are unsigned qualification builds. SmartScreen and
publisher trust are therefore unresolved, and the workflow does not publish a
GitHub Release. Public Windows distribution requires code signing, clean-host
installer/uninstaller and application journey testing, and release evidence
for the exact artifact.

OpenSlide 4.0.1.2 and its Python binding are LGPL-2.1. Their exact wheel licence
files are included, but [OpenSlide's official Windows guidance](https://openslide.org/docs/windows/)
also requires a binary distributor to provide corresponding source for OpenSlide and applicable
dependencies. The matching 4.0.1.2 `-winbuild` source bundle and relinking
review are therefore mandatory public-release inputs; the current unsigned
qualification output is not approved for public distribution.

The `package-windows` GitHub Actions job performs the Windows build and worker
checks on `windows-2025`. Before installer packaging, it also exercises Windows
Job Object CPU termination and committed-memory denial in real child processes.
It then retains the Setup/NuGet/RELEASES and ZIP outputs as a private seven-day
workflow artifact. An actual successful native build with recorded artifact
identity is required before claiming that the Windows package builds. A local
build can supply that evidence while hosted Actions are excluded by the owner;
configuration alone is insufficient.

## Verification

```bash
cd engine && uv run ruff check . && uv run pytest
cd ../desktop && npm audit && npm run check
```

Always test the packaged artifact as well as development mode. In particular,
verify worker startup, file pickers, export permissions, Retina rendering,
minimum window size, fullscreen restore, and offline behavior.

With explicitly authorized fixtures:

```bash
cd desktop
LOCI_QA_IMAGE=/absolute/path/to/image.tif npm run qa:packaged:mac
LOCI_QA_FOLDER=/absolute/path/to/image-folder npm run qa:folder-import:mac
```

An optional Cellpose packaged journey can provision one official checkpoint
through the real UI and assert both profile provenance and a locked expected
count. Replace the illustrative fixture, checkpoint, and count with authorized
QA values:

```bash
LOCI_QA_IMAGE=/absolute/path/to/authorized-fixture.png \
LOCI_QA_CELLPOSE_CHECKPOINT=/absolute/path/to/official-cpsam \
LOCI_QA_EXPECTED_PROFILE=cellpose-sam \
LOCI_QA_EXPECTED_COUNT=1234 \
npm run qa:packaged:mac
```

The expected count is fixture- and profile-specific; it is a regression
assertion, not biological ground truth. Cellpose packaged QA currently allows
up to 420 seconds for an analysis, but observed cold MPS runs can vary widely
and have sometimes exceeded that limit. Treat a passing run as functional
evidence, not resolution of the open performance gate documented in
[project state](PROJECT_STATE.md).
