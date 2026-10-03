# Contributor and release requirements

These requirements define acceptance evidence for changed behavior and released
artifacts. They do not claim that every capability or platform is qualified.
Use the [capability matrix](CAPABILITY_MATRIX.md) for implemented subsets and
[release status](RELEASE_STATUS.md) for the published beta and remaining gates.
The Apache-2.0 local core must remain usable without commercial services.

## Scientific and trust boundaries

- Preserve immutable source images, source fingerprints, raw values, calibration,
  units, array axes and native/world coordinate transforms. Keep display changes
  separate from analysis inputs, and rendered figures separate from scientific
  array exports. RGB components must not be inferred to be biological channels.
- Reject non-finite, out-of-range, mismatched, stale or unverifiable scientific
  state. Any compatible migration needs an explicit bounded contract and tests;
  silent clamping or substitution is unacceptable. Declared crops, regions and
  resolutions are valid scopes; overview or projection results must be labelled.
- Retain resolved settings, model/runtime identities, software versions,
  corrections, review state and artifact hashes across save, restore and export.
  Reviews bind to exact revisions. Publication is atomic, fail-closed and must
  not overwrite an existing destination, including a concurrent creation.
- Keep protected data and private source paths out of Git and renderer-safe
  payloads. Test with synthetic, public or specifically authorized fixtures;
  private images require explicit authorization and remain outside source Git.
- Preserve renderer isolation, source grants, path containment, checksums,
  symlink defenses, memory limits, cancellation and overview safeguards. Do not
  add unsafe deserialization or arbitrary execution. Models, plugins, runtimes
  and datasets require explicit provisioning and verified identity/provenance;
  builds must never silently download or execute them.
- Separate technical compatibility, biomedical validation and rights. Verify
  code, checkpoint and training-data licences before redistribution or commercial
  claims. Fixture checks and screenshots do not establish biological accuracy,
  clinical suitability or independent patient/specimen samples.

## Regression acceptance

Changes must retain the existing numerical tests and supported packaged journeys.
Run the affected checks in [building Loci](BUILDING.md) and
[contributing](../CONTRIBUTING.md); never weaken assertions or inflate timeouts
merely to obtain a passing run. Existing retained workflows include:

| Boundary | Required evidence for affected behavior |
| --- | --- |
| Import and navigation | File/folder/series/store/drop cancellation and ambiguous imports preserve the session. Verify axes, geometry, native edges, cursor zoom, DPI-correct 1:1, pyramid transitions, world/source round trips and declared ROI independently of the camera. Reject stale responses; bound tiles, bricks and caches. |
| Display and figures | Numerical fixtures cover IMS acquisition mappings, scalar/RGB/RGBA/ICC display, stable Auto/Reset and histograms bound to source/hash/T/Z. Pan/zoom must not alter histogram sampling. Figures retain exact display, sampling, software, DPI, scale bars, legends and volume camera/MPR state; changed bindings fail closed. |
| Persistence and recovery | Autosave/restart, Save as, discard recovery, legacy project/study import, relinking, interrupted jobs and export/reopen preserve exact sources, masks, annotations, corrections, revisions, models and locators without copying originals. Regress non-finite restores and missing/moved sources with redacted recovery details. |
| Cells and fluorescence | Recipe preview, calibrated object/ROI measurements, nucleus/cell association, correction undo/redo, review, batch and reopen retain raw source hashes. Preserve background/flat-field/filter assumptions, thresholds, controls, formulas, channel metadata and resolved settings. Separate object rows from biological replicate summaries. |
| Slides and histology | Tiled native SVS/NDPI navigation, physical annotations, tissue/region masks, declared stain separation, region/object metrics and inspectable rule classification need coordinate parity, ICC references, annotation/mask/table round trips and memory/cancellation checks. |
| Volumes and medical sources | Anisotropic/oblique/permuted axes, LPS/RAS/left-right orientation, rescale and physical measurement fixtures cover native C/Z/T, linked MPR, raw volume rendering, crop/resample/filter, 3D labels and reopenable exports. Label resampling uses nearest-neighbour semantics. One-Z sources remain 2D; unsupported DICOM variants fail explicitly. No unvalidated de-identification claim. |
| Model packages | Retain tensor/normalization/tile/halo/runtime/rights contracts, exact artifact identities, reference and seam tests, managed ONNX and provisioned Cellpose checks, and unseen-package adapter tests. Never substitute identity models for real-artifact qualification. Portable reviewed annotations retain tested GeoJSON/ImageJ ROI round trips. |
| GUI, CLI and MCP | Discovery, inspect, recipe preview/validation, submit, job/result inspection, cancellation and export retain numerical and record parity, idempotent submissions, scoped authority, isolation, injection, retry and recovery checks. Record actual compatible client testing and unavailable-client gaps. |
| Time and remote compute | Registration/tracking fixtures cover known transforms, missing frames, splits/merges and uncertain/corrected associations through export/reopen. Remote SSH/scheduler tests retain runtime/device/resource identities, approved staging, durable job identity, manifest checks, progress/cancel/reconnect/retrieve and owned cleanup; do not run heavy work on login nodes. |
| Interface and onboarding | Inspect actual packaged empty, populated, loading, error, disabled, recovery, focus/keyboard, long-label, laptop/high-DPI, theme/text-size and reduced-motion states. Menus dismiss correctly, prerequisites remain visible, preferences persist and the searchable offline manual works. Test source switching while loading, cancellation, sustained navigation and undo/redo. |

Format additions require a verified maintained reader or an explicitly labelled
conversion route with fixtures and rights evidence. An extension or installed
library alone is insufficient. Classical methods remain usable without ML
runtimes. Record algorithm references, numerical tolerances and statistical
assumptions; biological channel or tissue interpretations are explicit choices.

## Performance evidence

Measure the actual foreground packaged app on declared hardware without competing
build/test workloads. Separate cold reads from cached interaction. Retain these
engineering budgets and investigate misses as remaining issues:

| Measurement | Budget and workload |
| --- | --- |
| Empty shell | At most 8 seconds including automated launch overhead |
| First useful 2D view | At most 5 seconds for the 1536-square scalar phantom; at most 8 seconds for a declared 219-MB five-level IMS fixture |
| Sharp native detail | At most 3 seconds after 1:1 on the pyramidal RGB phantom; record actual decode completion |
| Cached 2D navigation | Frame intervals p95 at most 33.4 ms and p99 at most 50 ms during sustained pan/zoom |
| Raw-volume navigation | Frame intervals p95 at most 50 ms and p99 at most 100 ms for the 128-edge whole-context phantom; finer-focus sampling is recorded separately |
| Memory and cancellation | Preserve request/cache limits; sample the app process tree and aggregate worker RSS. Record cancellation-to-terminal time and unchanged result history. GPU-process RSS and texture estimates do not measure dedicated VRAM. |

Frame distributions include sample count, duration and maximum. Idle frame
intervals, scripted gesture duration and decoded-array estimates do not replace
interaction or peak-memory measurements. One host cannot qualify other hardware.

## Package and release evidence

Bind every result to the exact source commit/tree, package and worker hashes,
commands, fixture identities, hardware, numerical tolerances and failed/skipped
gates. Historical successes do not qualify changed code. Source tests alone do
not qualify cross-process, scientific-state, persistence/export or packaged UI
changes; run their matching actual packaged journeys. A failing scientific,
security, data-loss or core-workflow test remains a blocker.

Before binary distribution, verify final worker architecture, bundle integrity,
notices, dependency metadata, SBOMs and manifest-bound licence artifacts. macOS
public trust requires Developer ID signing, hardened runtime, notarization and
stapling. Windows distribution needs signing, clean-host installer/uninstaller
and app journeys, plus applicable corresponding-source/relinking obligations.
Platform configuration alone does not establish a successful or qualified build.

State external gaps explicitly: unavailable hardware or scheduler allocations,
independent biological validation, institutional/model rights decisions, signing
or distribution authorization. Completion of code and checks does not itself
authorize publication, paid resources, data disclosure or clinical use.
