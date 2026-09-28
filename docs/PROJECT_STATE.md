# Loci project and release state

## Public presentation — 2026-09-27

- Scope: concise screenshot-led homepage, documentation index, dedicated installation
  guide and contributor navigation. No application, release or dependency changes.
- Branch: `codex/public-presentation`, based on public `main` at
  `30131ea765b1ee8629b583fcb803b0dd76783d27`. Existing hardening PR #1 and its local
  commits remain separate; no private development history is transferred.
- Featured media: two public-sample screenshots and three unchanged, maintainer-
  authorized captures highlighting 3D, linked slices and channel controls, with
  hashes and separate credits. Existing untracked `docs/media/native-slide_annotation.png`
  is preserved.
- Checks passed: 53 local links/anchors, three new capture hashes and baseline media hashes, release
  asset references and actual GitHub desktop rendering of the opening and gallery.
  Documentation-only scope; no application suite or new build required. Mobile
  viewport was not separately exercised.
- Published download remains v0.1.0-beta.1; no new release or application qualification
  is implied by this documentation refresh.

## Agent setup handoff — 2026-09-19

- **Editor/status:** Codex/Astra; handoff-ready, documentation/configuration only.
- **Task branch/base:** `codex/loci-agent-coordination` -> `main`; setup-only PR.
  This dated entry records setup scope; later product tasks update the current
  handoff using COLLABORATION.md and retain this as history.
- **Outcome:** shared model roles, bounded Gemini tasks, ChatGPT review packets,
  two-worker Codex routing and deliberate repository transfers. Start with
  [COLLABORATION.md](COLLABORATION.md), [MODEL_ROLES.md](MODEL_ROLES.md) and
  [NEW_AGENT_PROMPT.md](NEW_AGENT_PROMPT.md).
- **Scope:** no runtime, data, app bundle, release, CI or scientific changes.
  The existing public-beta-hardening PR remains separate and is not accepted or merged by this setup. Published beta artifacts and their qualification claims are unchanged.
- **Checks:** Markdown references, TOML parsing, reviewed diff and scope checks;
  no application suites or performance/quality benchmarks for this setup.
- **Next owner/action:** Astra chooses the requested milestone after reconciling
  the actual branch, open PRs and dirty files. Gemini takes an explicit work package.
  Preserve the branch-specific runtime handoff and evidence below.

## Runtime/release record (branch-specific)

Current release: **v0.1.0-beta.1** (Public Beta)
*Internal bundle version: `0.1.0` (as identified in `desktop/package.json` and build manifests, mapped to distribution tag `v0.1.0-beta.1`).*

Loci is a local-first desktop imaging workbench for life-science and biomedical research. This document records current release qualifications, supported workflows, scientific boundaries, and known beta limitations.

---

## Current handoff & release status

- **Public distribution:**
  - Recommended download: **`Loci-0.1.0-beta.1-darwin-arm64-repack1.zip`** (SHA-256: `cc0fbf5503cdda76bb1cacd4f050f35fd7af773f8bc430f89b00743029bd0cd0`).
  - Historical provenance archive: **`Loci-0.1.0-beta.1-darwin-arm64.zip`** (SHA-256: `5d1943627605ce40dfba27694a22f03b33884bd42d703a1d49ca054d2f926ece`) retained on the GitHub release for continuity.
  - Both archives contain identical `Loci.app` application binaries, identical code signatures, and identical analysis behavior. The `repack1` package eliminates archive-level AppleDouble metadata to achieve exact correspondence with the inspected application bundle.
  - Verified auxiliary release assets published on GitHub release `v0.1.0-beta.1`:
    - `macos-release-evidence-repack1.json` (`dac4939bd500910b7ffc7b925be84d2aa5d45464977675553e9621ef44121ac1`)
    - `desktop.cdx.json` (`0735b45a3d521bdf88126bc41c0355d824a3e399990df1c1523c84149e4b2c64`)
    - `engine.cdx.json` (`620fcacbe76803f36a09d3e0a956f25f33ed355fb5985f01f7bab8960df0e6f6`)
    - `dependency-licences.zip` (`f975b0dca19e82b22545556e0905103a1dd53f96f4fbb5264fa30954c848c3f1`)
    *(Note: All four auxiliary assets match their byte digests recorded in `macos-release-evidence-repack1.json` and verified via `release_evidence.py verify-assets`.)*
- **CI & automation diagnostics:**
  - *Run 35055420283:* Refused at schedule time due to account billing and spending limits.
  - *Run 35170082289:* Executed on GitHub Actions; engine and pytest suites passed; formatting check failed on `scripts/release_supply_chain.py` and `scripts/tests/test_release_supply_chain.py`.
  - *Run 35418184299:* Executed on GitHub Actions for commit `02c9eeb`. `desktop`, `modeling`, `engine`, and `package-windows` (10m29s) all succeeded. In `package-macos`, smoke test failure in `Exercise packaged folder import` was isolated to direct-child selector assumption in `desktop/tests/folder-import.smoke.mjs`.
  - *Run 35427641684:* Executed on GitHub Actions for commit `1bfe053`. Folder import smoke test passed; `desktop/tests/packaged-app.qa.mjs` timed out on reopen stage. Root cause: Loci intentionally launches idle studies to `main.image-first-empty` without auto-opening saved state (ADR 0007); the harness installed the study open dialog picker but omitted clicking "Open study" on the empty state.
  - *Targeted hardening closure pass (Commit `845f57b`):*

| Finding / Scope Item | Disposition | Repair Commit | Test / Receipt | Tested Source / App | Remaining Gap |
| --- | --- | --- | --- | --- | --- |
| CI failure in Run 35427641684 (`packaged-app.qa.mjs` reopen timeout) | Resolved | `845f57b` | `packaged-app.qa.mjs` passes all 8 stages with zero errors | `845f57b`, App `67a9c425...` | Remote GitHub Actions CI execution |
| Path error sanitization in `ResearchWorkbench.tsx` replaces up to whitespace | Resolved | `845f57b` | `ContextHelp.test.tsx` (15/15 passed) verifying macOS/Volumes paths with spaces | `845f57b`, App `67a9c425...` | None; paths with spaces completely sanitized across all renderer panels |
| Safe diagnostic retention & artifact uploads in CI | Resolved | `845f57b` | Deliberate failure test captured `failure.png` and `failure-page.html`; `engine-ci.yml` allowlist strictly excludes `user-data` | `845f57b` | Remote CI run to publish artifacts |
| Symlink contract in `verify_release_assets` checked after `resolve()` | Resolved | `845f57b` | `test_release_evidence.py` (`test_verify_release_assets_rejects_symlinks_and_directories`) | `845f57b` | None; in-directory and external symlinks rejected |
| Qualify freshly repaired candidate, not historical release | Resolved | `845f57b` | Staged and promoted fresh local build to `.loci/builds/current/Loci.app`; folder import & core packaged QA passed | Commit `845f57b`, App `67a9c425...`, Worker `ecb222b6...`, ASAR `6270e45e...` | Independent clean-Mac attestation |
| Windows packaging CI status accuracy | Resolved | `845f57b` / `docs` | `package-windows` job passed in Run 35418184299 (10m29s); updated documentation | `845f57b` | Physical Windows GUI qualification |

- **Fresh candidate qualification identity (`.loci/builds/current/Loci.app`):**
  - Git commit: `845f57b73fb46ce61596cfec725d0ca12c1dfeac`
  - Desktop source tree: `7695c12b381af6ec193b566d52adc020a135845c`
  - Engine source tree: `c954367605d661b76ba883fd32b79bc22b9402c7`
  - Application executable SHA-256: `67a9c425212f9b598e76f725ca33e5105b7c0214428f40631a4d8e2af8102985`
  - Engine worker SHA-256: `ecb222b6e708c8851ddbb8051b38f85cb51549b27c8b4f79f59c7724605d0d51`
  - ASAR SHA-256: `6270e45e0a35b67569cf1dc5ab34cf5b176178ff32bd006f7ffa7aec7096945e`
  - Packaged QA outcome: All 8 stages passed (`formulaNeutralized: true`, `renderer_errors: []`, `console_errors: []`, `renderer_http_requests: []`).
- **Verification boundaries:**
  - *Software & supply-chain qualification:* Automated desktop test suite (837 tests across 93 files passed), engine test suite (916 tests passed, 12 skipped), harness & supply-chain script tests (74 tests passed), local packaged UI regression journeys (Journeys 1, 2, 3 passed), folder import smoke test passed, and fresh packaged candidate core QA passed.
  - *Disclosed operational limitations:* Ad-hoc local code signature (no Apple Developer ID), unnotarized status (requires macOS Gatekeeper approval via System Settings), first-launch startup delay (~75–85 s), and absence of independent clean-Mac attestation.
  - *Scientific integrity:* Automated test passes verify software build integrity, API contracts, and deterministic algorithm execution on specific test fixtures; they do **not** constitute biological or clinical validation.

---

## 1. Release status & supported scope

### Implemented & verified capabilities

- **Image-first viewing:**
  - Multi-dimensional C/Z/T navigation, stable channel display, composite and single-channel false-coloring.
  - Pan and cursor-anchored zoom with bounded tile reading.
  - Native whole-slide navigation for Aperio SVS and Hamamatsu NDPI without image flattening.
  - Orthogonal multi-planar reformatting (MPR) and 3D ray-cast volume rendering via vtk.js.
  - Supported medical image scalar geometry (DICOM, NIfTI, NRRD) with orientation preservation.
- **Interactive research workbench:**
  - Exact 2D and 3D discrete object picking and canvas selection (`result_label_at`), with active layer prioritization and camera scale preservation.
  - Quantitative review table with metric kind awareness (areas, volumes, counts, intensities, fractions), rejection of non-finite/NaN values, and unit consistency.
  - Reusable recipe presets with channel-compatibility validation and preview guards.
  - Calibrated user annotations (points, rectangles, polygons, freehand regions, transects) bound to native coordinates.
- **Offline analysis engine:**
  - Classical segmentation (adaptive watershed, Otsu, Yen, Li, local thresholds) with zero external network access.
  - Optional provisioned Cellpose-SAM integration (`cpsam` and `cpsam_v2` profiles) requiring explicit user-provided checkpoints verified against exact SHA-256 identities.
  - Managed ONNX model package support with scale, dtype, and provenance contracts.
- **Traceable scientific exports:**
  - Export packages with original-value arrays, spatial calibration, source hashes, and resolved parameter manifests.
  - Rendered figures and full-resolution 16-bit TIFF exports recording exact display settings.
  - Session preservation via portable `.loci-study` bundles.

---

## 2. Platform qualification & test status

### Verified in this release:

- **macOS (Apple Silicon arm64):**
  - **Desktop test suite:** TypeScript typecheck and Vitest suite (**837 tests / 93 files passed**).
  - **Packaging unit tests:** Node packaging safety and bundle integrity (**10 tests passed**).
  - **Python engine suite:** Ruff linting clean; Pytest suite (**916 passed, 12 skipped** for optional GPU/external dependencies).
  - **Harness & supply-chain script tests:** Pytest suite for release supply chain and packaging tools (**73 passed**).
  - **Regression runner suite:** Runner unit tests (**10 passed**).
  - **Packaged UI regression journeys:** Verified against verified release bundle (`Loci.app`, repack1 SHA-256: `cc0fbf5503cdda76bb1cacd4f050f35fd7af773f8bc430f89b00743029bd0cd0`):
    - *Folder import smoke test:* Staged macOS application bundle imports and renders supported folder images without analysis execution (**passed, 2 sources**); failure diagnostics verified via synthetic corrupt fixture.
    - *Journey 1 (research-workbench):* 2D/3D object picking, multichannel puncta, review table, project persistence, and reopen (**passed, 17 checkpoints**).
    - *Journey 2 (workbench-refresh):* Pointer drag reordering, worker refresh, batch palette recoloring, undo restoration, and A/B comparison (**passed, 11 assertions**).
    - *Journey 3 (field-assay-workflow):* Fluorescence field assay quantification, background subtraction, manual override counts, and review gates (**passed**).

### Hosted CI status & history:
- **Run 35055420283:** Jobs were refused at schedule time due to account billing and spending limits (`The job was not started because recent account payments have failed or your spending limit needs to be increased`). Retained as historical record.
- **Run 35170082289:** Engine and script unit tests executed and passed; formatting check failed on `scripts/release_supply_chain.py` and `scripts/tests/test_release_supply_chain.py`. Packaging workflow staging path (`LOCI_PACKAGED_APP`) was also identified as misaligned with packager output. Both issues resolved in commit `02c9eeb`.
- **Run 35418184299:** Confirmed resolution of Ruff formatting failures in remote CI: `desktop`, `modeling`, `engine`, and `package-windows` all succeeded. In `package-macos`, staging and supply chain verification passed cleanly against `LOCI_PACKAGED_APP`; smoke test failure in `Exercise packaged folder import` isolated to direct-child selector assumption in `desktop/tests/folder-import.smoke.mjs`.
- **Run 35427641684:** Folder import smoke test passed; `desktop/tests/packaged-app.qa.mjs` timed out on reopen stage. Diagnosed as missing "Open study" click on empty state after launch when starting without auto-opened idle study (ADR 0007). Resolved in commit `845f57b`.
- **Qualification authority:** Local qualification scripts (`node scripts/run-core-regressions.mjs --mode=packaged` and `node scripts/run-core-regressions.mjs --mode=source`) serve as the local qualification authority. Remote CI verifies repository workflow syntax, automated linting, and continuous regression suites.

### Platform boundaries:
- **macOS:** Tested on Apple Silicon (macOS 14+). Intel x86_64 builds require manual compilation from source.
- **Windows x64:** Automated Windows CI (`package-windows`) passed in Run 35418184299 (verifying frozen engine, worker health, CLI discover, resource limits, notices, Squirrel installer, and ZIP package). Local build scripts (`build-engine.ps1`, `package:windows:local`) are maintained. Physical Windows GUI interaction qualification remains separate.
- **Linux x64:** Python engine runs under Python 3.11–3.13; desktop packaging is planned for upcoming releases.

---

## 3. Scientific and research-use limitations

> [!WARNING]
> **Research Use Notice**
> Loci is research software developed for scientific image analysis. It is **NOT** a medical device, is **NOT** FDA/CE cleared, and is **NOT** intended for clinical diagnosis, patient management, or clinical decision-making.

- **No biological or clinical claims:** Algorithmic segmentations, object counts, and intensity calculations do not establish biological viability, tissue pathology, or clinical diagnosis.
- **Model checkpoints are not bundled:** Official Cellpose checkpoints (`cpsam`, `cpsam_v2`) are not bundled or downloaded by Loci. Users must supply official checkpoints obtained directly from upstream sources. Loci does not claim commercial rights clearance for third-party trained weights.
- **Data immutability:** Source files are treated as strictly immutable. All annotations, segmentations, and measurements are stored in separate project and export artifacts.

---

## 4. Known beta limitations

1. **First-launch initialization (cold start):**
   On the very first launch after installation, an initial startup delay of approximately **75–85 seconds** has been observed (tested on Apple Silicon M1 with 8 GB RAM) while macOS verifies application components and the analysis environment initializes. Profiling of the exact breakdown between system verification and engine initialization remains ongoing; subsequent launches warm up and open faster once cached by macOS.
2. **macOS Gatekeeper warning (ad-hoc signing & unnotarized status):**
   The public beta binary is signed with an ad-hoc integrity signature and is **not notarized** by Apple. Because it is not signed with an Apple Developer ID certificate, macOS Gatekeeper blocks direct double-click launching on downloaded files.
   - On macOS 15 (Sequoia) and modern macOS releases, approve the application via **System Settings → Privacy & Security → Open Anyway** after the initial blocked launch attempt.
   - On earlier macOS versions, right-click (Control-click) → **Open** in Finder may provide a direct open prompt, though this shortcut is restricted on Sequoia.
   *Note: Centrally managed Macs with strict MDM configuration profiles may block unnotarized binaries without administrative approval.*
3. **Memory bounds on massive datasets:**
   Whole-slide images and large 3D/4D volumes use progressive pyramid levels and bounded tile decoders. Rendering extremely large volumes at 100% ray-sampling quality on systems with 8 GB unified memory may trigger automatic downsampling to protect system responsiveness.

---

## 5. Next development priorities

- Apple Developer ID signing, hardened runtime, and notarization automation.
- Resumption of automated Windows CI and distribution of Windows installer packages.
- Additional managed ONNX model packages with verified biological provenance.
- Expanded Bio-Formats vendor format support and batch conversion pipelines.
