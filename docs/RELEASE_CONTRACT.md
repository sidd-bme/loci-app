# Loci 1.0 engineering contract

Adopted 2026-09-07 from the owner's full-product mandate. This is the finite
release acceptance contract, not a statement of implemented capabilities.
The release remains unreleased until the evidence below is complete. The
Apache-2.0 local core, immutable sources, explicit scientific assumptions,
review-bound revisions, and standard export remain essential.

## Image-first acceptance (adopted 2026-09-08)

The owner's image-first mandate supersedes the earlier interface acceptance.
J1–J10 remain regression obligations; their historical passing evidence does
not qualify the new application. Each I journey requires actual packaged UI
actions, build and dataset identities, numerical checks and retained captures.

| ID | Required outcome and executable acceptance |
| --- | --- |
| I1 | Start without saved state; open files, a folder, an explicit series or directory store, or drop images into one shell. Show the source immediately without a study dialog. Cancelled and ambiguous imports preserve the current session; recent sources/studies can reopen. |
| I2 | Managed autosave survives restart; Save as preserves sources, annotations, results, revisions, models and locators without copying originals. Missing/moved/linked studies show recovery actions and redacted details. Discard is reversible; legacy `.loci-project` and `.loci-study` reopen with exact corrections. Regress the reported snapshot and non-finite restore errors. |
| I3 | Verified axes, samples, geometry and available methods determine contextual View/Annotate/Analyze/Results tools. Interpretation overrides are explicit, reversible and persisted. No biological inference or automatic analysis/download; advanced tools remain searchable. |
| I4 | Fit shows the full extent; cursor zoom, mouse/trackpad, keyboard, reset and DPI-correct 1:1 reach native detail across every edge. Camera, decode requests and declared analysis ROI are independent. Test automatic level changes, world/source round trips, overlays and calibrated scale/navigator. |
| I5 | Bounded progressive tiles/bricks and derived preparation cover large sources without pyramids. Preparation is cancellable. Navigation remains responsive during reads/jobs; stale responses and incompatible source/revision frames are rejected; resources and caches remain bounded. |
| I6 | IMS acquisition mappings, stable global Auto/Reset and explicit RGB/composite overrides match numerical fixtures and an independent reference at the same region/settings. RGB, RGBA, ICC, SVS/NDPI and scientific channels preserve raw values; rendered exports and scientific exports are distinct. |
| I7 | Raw whole-volume viewing needs no segmentation/crop entry. Verify orbit/pan/zoom/reset, anisotropy, orientation, channels/transfers, clipping, linked MPR and useful refinement. Test GPU/CPU limits, context loss and graceful unsupported hardware; one-Z data remains 2D. |
| I8 | Raw annotations work before segmentation and stay source/geometry/revision bound. Complete the retained cell, fluorescence, histology, volume, time and medical workflows, including corrections/review/batch/export/reopen, recipes/study metadata, models, CLI/MCP and optional remote compute. Make supported local assistant connection steps explicit. |
| I9 | Inspect empty, populated, loading, error, disabled, recovery and long-label states at laptop/high-DPI sizes and supported themes/text sizes. Per the owner's 8 September follow-up, hover/focus help appears in one tooltip, clears after activation/exit, and leaves the bottom bar for operational status. Consequential prerequisites remain visible. Fullscreen, compact jobs, consistent motion and reduced motion pass real interaction checks. The welcome mark responds to activation and optional opening controls expand downward without moving the controls above. |
| I10 | Realistic novice packaged journeys cover every modality, wrong imports, cancellation, switching while loading, sustained zoom, undo/redo, changed sources, interrupted jobs and reopen. Record startup, integrity, first useful view, sharp detail, frame-time distributions, peak memory and cancellation against numerical budgets on the M1/8-GiB baseline. |
| I11 | Concise README, capability matrix, architecture/user guidance and current evidence match the final build. Genuine authorised/redistributable screenshots show opening, histology, channels, raw 3D and annotation/analysis. Research compares upstream workflows with dated primary/community evidence and bounded specialist decisions. Reviewed changes are merged and main/package identities verified under existing authority; publication/commercial routes remain proposals pending owner decisions. |

No requirement above may be closed by a unit test or layout screenshot alone.
Private benchmark images remain local and outside Git; generated design art is
never scientific or product evidence. No paid capacity, Actions re-enablement,
public release, new data disclosure or installed-app overwrite is implied.

## Display, figure, and help additions (adopted 2026-09-08)

The owner's subsequent requests extend the image-first acceptance; they do not
replace I1–I11 or the retained scientific workflows.

| ID | Required observable result |
| --- | --- |
| I12 | Histograms identify source/hash/T/Z, native component semantics and bounded sampling. Pan/zoom does not change the sample. Constant data and non-finite values are handled explicitly. Low/high, gamma, explicit percentile trimming and medical Window/Level alter display only; RGB uses one shared curve before one ICC conversion. Numerical fixtures verify unchanged source values and matching rendered output. |
| I13 | PNG8/TIFF16 figures record exact display, sampling, software and DPI. Optional calibrated scale bars and declared channel legends sit outside source pixels with bounded memory. A raw-volume PNG records the actual canvas dimensions, camera, context/focus grids, transfers, clipping and MPR state. Changed state or source bindings fail closed. Figure bundles publish atomically without overwriting existing destinations, including concurrent destination creation. |
| I14 | Task menus open without covering their trigger, dismiss on selection/Escape/outside activation, retain keyboard access and meaningful help, and use restrained reduced-motion-aware transitions. Batch action buttons have visible separation. Six themes, both text sizes, useful persistent viewing/export preferences and a searchable offline manual work in the packaged app at laptop dimensions and high DPI. |

Source tests support these additions; final packaged and Windows evidence must
identify the actual artifact. A passing earlier package is not acceptance of a
changed renderer, manual or worker.

## Retained acceptance journeys

| ID | Required end-to-end outcome | Acceptance evidence required |
| --- | --- | --- |
| J1 | Import, recipe preview, calibrated cell/ROI measurements, nucleus/cell association, corrections with undo/redo, revision-bound review, batch, export and reopen; study/sample/condition/biological replicate/plate/well metadata, run comparison and methods output | Existing packaged journey plus new study/measurement journey; exact masks and revisions on reopen; object rows separated from replicate summaries; citations generated from executed records |
| J2 | Biological channel metadata and display, C/Z/T selection and explicit projections; non-destructive background/flat-field/filter/morphology processing; object/ROI intensities, declared marker gates, puncta and colocalisation | Numerical multichannel fixtures and packaged processing journey; raw source hashes unchanged; display independent from input; thresholds/control assumptions/formulae retained |
| J3 | Bounded native slide navigation; physical annotations/tissue masks; declared H&E/IHC separation, region/object measurement and inspectable rule classification; ICC display | Tiled large-image and real SVS/NDPI qualification; native region coordinate parity and annotation/mask/table round trips; ICC golden reference; memory/cancellation measurements |
| J4 | Native microscopy C/Z/T and calibration; linked orthogonal views, bounded volume/surface display; crop/resample/filter; genuine 3D segmentation, label correction, physical measurements and reopenable export | Anisotropic volumes, axis permutations, volume/intensity/distance references; nearest-neighbour label resampling; physical coordinate/export round trips and packaged journey |
| J5 | Source-independent external model package adoption with reference test and selected preview; optional recoverable runtimes; two useful materially different runtime routes, plus an unseen package; portable reviewed annotations | Declared tensor/normalisation/tile/halo/runtime/rights contracts, reference and seam tests, exact identities; separate compatibility/validation/rights; real artifacts with no identity-model substitution; tested GeoJSON/ImageJ ROI export/import |
| J6 | Same validated task semantics through GUI, CLI and MCP: discovery, inspect, recipe validation/preview, submit, job/result inspection, cancellation, export | Numerical/record parity, idempotent repeat submissions; project/source/model/destination/resource/disclosure-bound authority; isolation/injection/cancellation/retry tests; two real compatible clients where available |
| J7 | Installable macOS arm64 and Windows x64 artifacts, portable Linux engine; onboarding, offline use after provisioning, diagnostics; durable jobs, autosave/reopen, relink, interchange, schema safety, atomic export and interruption recovery | Supported packaged critical journeys, build/worker identities, CI and dependency evidence, source-relink verification, cache/restart/cancel/failure fixtures; Windows hardware/signing gaps explicitly separated |
| J8 | Calibrated time-series registration and tracking with inspectable/correctable associations and trajectories | Known translations and time references; missing frames/splits/merges/uncertainty represented; raw versus registered measurement basis explicit; corrected tracks survive export/reopen |
| J9 | Local CPU/compatible accelerator selection and explicit SSH standalone/PBS/Slurm compute; setup/test, identity, runtime, directories, approved staging, resources, submit/progress/cancel/reconnect/retrieve/owned cleanup | Controlled SSH/scheduler integration and recovery harness; requested/resolved device and limits/fallback provenance; durable remote job identity and manifest validation; Vanda discovery and permitted allocated run when available, never heavy login-node work |
| J10 | Genuine bounded research NIfTI/NRRD and defined DICOM image-series import; patient/world geometry, orthogonal/volume views, ROI/labels, processing/registration/compatible segmentation and export | Oblique/anisotropic/LPS/RAS/left-right/rescale tests; explicit unsupported series errors; physical measurements and export/reopen parity; no unvalidated de-identification claim |

## Supported scope and method selection

The capability matrix must distinguish inspect, view, process, model analysis,
correction/measurement and export for concrete variants of ordinary raster,
OME-TIFF, tiled TIFF/BigTIFF, OME-Zarr, modern HDF5 IMS, SVS/NDPI and medical
volumes. CZI/ND2/LIF require a verified maintained native reader or a clearly
labelled conversion route with fixture/rights evidence. An extension or library
installation alone is insufficient.

Bounded crops, regions and declared resolutions are valid processing scopes;
silently substituting an overview or projected count is not. Classical methods
must be usable without ML runtimes. Finite algorithm choices will be recorded
with primary references and numerical tests before optimization. Specialised
lineage, filament tracing, stitching, deconvolution and adaptation/training
receive an evidence-based inclusion/exclusion decision; they do not expand this
contract automatically. Study organisation, useful spatial measurements and
annotation portability are included, not optional follow-up work.

## Interface and performance acceptance

The canvas is central, with linked image/objects/study data, discoverable
modality-specific controls, keyboard/focus/contrast support, responsive panes,
long-label/error/recovery states and reduced motion. Inspect the actual packaged
interface at representative sizes and high DPI. Scientific pixels, labels and
plots are data-driven. Record first view, integrity time, startup, peak memory,
throughput, cancellation and remote overhead on declared hardware. The current
development Mac has 8 GiB RAM; it is useful stress evidence but cannot establish
the requested 16-GB-class cross-hardware qualification by itself.

The following engineering budgets are fixed before the packaged image-first
measurement runs on the Apple M1/8-GiB development Mac. Use a foreground app
with no concurrent test/build workload; report cold reads separately from
cached interaction. A missed budget requires investigation and an explicit
remaining performance issue, not an increased timeout or a smoothness claim.

| Measurement | Budget and declared workload |
| --- | --- |
| Empty shell after launch | At most 8 s, including automated launch overhead |
| First useful 2D view | At most 5 s for the 1536-square scalar phantom; at most 8 s for the owner's 219-MB five-level IMS |
| Sharp native detail | At most 3 s after 1:1 on the pyramidal RGB phantom; report actual decode completion, not merely the selected level |
| Cached 2D navigation | Frame intervals p95 at most 33.4 ms and p99 at most 50 ms during sustained actual pan/zoom input |
| Raw-volume navigation | Frame intervals p95 at most 50 ms and p99 at most 100 ms for the 128-edge whole-context phantom; record finer-focus sampling separately |
| Memory and cancellation | Retain all existing request/cache limits; sample the complete app process tree and aggregate worker RSS. Record cancellation-to-terminal time and unchanged result history. GPU-process RSS and texture estimates do not measure dedicated VRAM |

Frame distributions include sample count/duration and the maximum. Idle frame
intervals, total scripted gesture duration and decoded-array estimates are
reported separately; none substitutes for measured interaction or peak RSS.

## Integration and completion

Use coherent reviewed checkpoints and PRs, merge verified candidates into main,
then verify accepted main and reconcile the primary checkout. Evidence records
must distinguish source commit, tested tree, package hash, CI checkout/merge
identity, hardware, commands, numerical tolerances and unresolved gaps.
Historical successes do not verify changed code. A failing scientific,
security, data-loss or core workflow test remains a blocker.

Only genuine external qualifications may remain after all independent
engineering: unavailable Windows/other hardware, unavailable scheduler
allocation, independently adjudicated biological validation, institutional and
model rights decisions, signing/notarization and authorized public distribution.
Missing code, incomplete UI, untested claims and routine Git operations remain
engineering work. No paid resource, public release, customer contact, visibility
change or compulsory cloud service is authorized by this contract.
