# Adopted research and product decisions

Adopted 7 September 2026; image-first update 8 September 2026. The acceptance outcomes are in
[RELEASE_CONTRACT.md](RELEASE_CONTRACT.md); implementation and qualification
status belong to [PROJECT_STATE.md](PROJECT_STATE.md) and
[project state](PROJECT_STATE.md). This document explains choices,
not biological accuracy, clinical suitability or public-release readiness.

## Image-first workflow comparison (8 September 2026)

This update informed the I1–I11 implementation. Sources were checked on
8 September 2026. A documentation feature is an upstream claim; a linked issue
is scoped feedback, not a performance ranking or evidence of biological accuracy.
The implementation reuses Loci's validated readers and operations. It does not
embed these applications or install their plugins.

| Workflow and expected outcome | Upstream evidence and friction | Loci decision and implementation/reuse | Executable acceptance |
| --- | --- | --- | --- |
| Ordinary microscopy: open, annotate, measure, then batch | [CellProfiler manuals](https://cellprofiler.org/manuals) list 4.2.8; repeatable pipelines associate images, metadata and measurements. No firsthand CellProfiler defect was established in this review. | Direct images/folder entry into recoverable sessions; raw vector annotation before segmentation; existing recipes, corrections, review and study batch. Keep metadata optional for viewing and consequential for grouped summaries. | `image-first-viewer.qa.mjs`: empty start, cancelled picker, raw rectangle, undo/redo, result, Save as/reopen. `research-workbench.qa.mjs`: metadata, batch and review/export. |
| Fluorescence: retain channels, C/Z/T and quantitative meaning | [ilastik pixel classification](https://www.ilastik.org/documentation/pixelclassification/pixelclassification) produces semantic class probabilities, not instance identities. [napari rendering](https://napari.org/stable/guides/rendering.html) separates slicing and screen-dependent multiscale rendering. | Acquisition display metadata first, stable explicit Auto and reversible composite settings; no RGB inference from three channels. Reuse native scalar readers and quantitative operations. Class/probability output is never relabelled as cell counts. | `test_viewer_display.py`, `test_viewer_image.py`: numerical channel/gamma/colour fixtures, stable pan/zoom display and source identity. Multichannel/time packaged journey checks C/Z/T and projection scope. |
| Histology/whole slides: faithful colour, full extent, native detail and calibrated regions | [QuPath 0.7 format guidance](https://qupath.readthedocs.io/en/latest/docs/intro/formats.html) describes pyramids and concrete reader/platform limits. [Issue 1446](https://github.com/qupath/qupath/issues/1446), opened January 2024 against 0.5.0, relays large-project thumbnail lag; closed for 0.5.1. The reporter explicitly had not reproduced it. | Automatic tiles over the complete image; camera independent from analysis ROI. Retain OpenSlide and exact ICC/source-device separation. Bound caches and retain only source-matching frames. An import gate or manual overview selector is not the ordinary entry flow. | `viewer-camera.test.ts`, `test_viewer_image.py`, `whole-slide-workbench.qa.mjs`: native edge access, level-zero ROI parity, ICC reference, bounded requests and cancellation. Same-region IMS independent renderer comparison remains separately identified. |
| Large raw volumes: orbit, MPR and inspect finer detail without segmentation | [Fiji BigDataViewer](https://imagej.net/plugins/bdv/) and its [paper](https://arxiv.org/abs/1412.0488) use chunked multiresolution data and global transforms. [napari progressive-loading issue 5561](https://github.com/napari/napari/issues/5561), opened February 2023, remained open when checked; it describes ongoing tiled-loading work, not a universal failure. | Keep existing readers; add vtk.js 36.12.0 (BSD-3-Clause) for GPU raw volume/MPR, bounded whole context and explicit focus. Display sampling does not modify analysis grids. Camera/geometry/context-loss acceptance controls adoption. | `image-first-volume.qa.mjs`, `test_viewer_volume.py`, `RawVolumeViewport*.test.tsx`: anisotropy, oblique/reflected geometry, orbit/reset, transfers, clipping, focus bounds, memory, context loss and stale sources. |
| Time series: inspect/correct tracks and export uncertainty | [TrackMate documentation](https://imagej.net/plugins/trackmate/) describes improved track and segmentation editing since v8. A [microscopy researcher/developer post](https://www.reddit.com/r/microscopy/comments/1u2d40n/i_built_a_napari_tool_for_curating_automated/) describes identity swaps and false divisions after transient merges; this is one workflow report. | Playback waits for a decoded frame. Existing assignment/registration and association corrections keep missing observations and ambiguity explicit. Reuse SciPy; do not infer biological division from image proximity. | `research-workbench.qa.mjs` and temporal engine tests: declared times, gaps/merges, edited association, exact graph/export/reopen and unchanged raw intensities. |
| Medical/neuroimaging: inspect a supported series in physical coordinates | [3D Slicer coordinates](https://slicer.readthedocs.io/en/latest/user_guide/coordinate_systems.html) distinguishes voxel and RAS/LPS world frames. [BrainSuite quickstart](https://brainsuite.org/quickstart/) separates cortical extraction, registration and diffusion workflows. No direct medical-app defect was established. | Reuse SimpleITK for the declared scalar CT/MR/NIfTI/NRRD subset; explicit series and physical transforms. Generic research viewing and segmentation do not imply cortical extraction, diffusion or clinical interpretation. | Medical import/export tests plus packaged oblique phantom: LPS/RAS landmarks, physical measurements, nearest-neighbour labels, explicit refusal of unsupported series. |
| Electron microscopy: inspect/annotate very large scalar data | [ilastik workflow overview](https://www.ilastik.org/documentation/index.html) distinguishes EM-oriented multicut from general pixel/object tasks. Reader compatibility alone says nothing about membrane segmentation. | Generic supported scalar volume/annotation routes only. No EM-specific inference, connectomics or quality claim. A future module needs an authorised EM reference and its own ground truth/topology contract. | Current generic volume and label round trips; a future EM method must add task-specific labelled fixtures before becoming available. |
| Stitching, deconvolution, filaments and atlas work: produce a separately justified derived result | [Imaris release notes](https://imaris.oxinst.com/support/imaris-release-notes/) list 11.0 (13 November 2025) and separate Stitcher, deconvolution and filament features. [BigStitcher registration](https://imagej.net/plugins/bigstitcher/registration) and [BrainSuite pipelines](https://brainsuite.org/BIDSrtd/pipelines.html) expose distinct acquisition/reference requirements. | Additional specialist methods remain outside this finite release: no PSF estimation, mosaic fusion, filament topology, atlas package or deformable transform is implied by import. Preserve existing rigid/affine registration and geometry-bearing export. | Future gates: known overlap/landmark transforms and seam error; explicit PSF/noise references; known graph branches/lengths; atlas identity and label interpolation. No specialist completion claim from current fixtures. |

## Consequences for the interface

Open the canvas immediately; structural information and reversible **Open as**
choices belong in Image info. Keep source, displayed result and analysis region
linked. Four task groups expose the relevant tools; assistant connections,
remote compute, conversion and portability remain searchable. Following the
owner's 8 September refinement, short hover and keyboard-focus help appears
once; clicking, leaving or pressing Escape dismisses it. The bottom bar retains
operational status. Consequential calibration, review, model-rights and
data-transfer choices stay visible.

The [WAI-ARIA tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)
(a work in progress) and [NN/g tooltip guidance](https://www.nngroup.com/articles/tooltip-guidelines/)
support brief supplementary explanations with keyboard access and dismissal.
[NN/g's button-state guidance](https://www.nngroup.com/articles/button-states-communicate-interaction/)
(25 April 2025) informs distinct hover, focus, pressed and disabled states.
The welcome mark uses the existing Loci identity with bounded optical pulses;
opening options reveal below a stable anchor. Recent sessions and manually
navigated research tips make the starting screen useful. Reduced motion removes these
effects. [A practitioner essay on generic AI interface styling](https://smoothui.dev/blog/ai-design-slop)
(24 June 2026) informed restraint and iteration; it is not usability evidence.

Acquisition colours are display metadata. They never establish stains,
fluorophores or clinical identity. A source RGB export and a quantitative result
export are different artifacts. Raw annotations carry exact source/geometry
bindings. Managed sessions are recoverable local studies; saving a named copy
must not copy originals or change result history.

Community feedback motivates bounded tests. This review did not establish
recurring cross-product prevalence, a human usability result, or that Loci is
faster/more accurate than any reference application. The owner's local Imaris
comparison and Loci runtime timings have their own dataset/build evidence.

## Finite adopted methods

**Quantitative images.** Use established NumPy/SciPy/scikit-image operations on
explicit YX/ZYX grids: float64 processing, calibrated components/watershed,
raw-channel object/ROI measurements, declared marker gates and descriptive
colocalisation. Physical neighbourhoods use axis spacing. Flat-field references
and correction formulae are recorded. An RGB sample axis is not a biological
channel axis; stain separation requires a human declaration and retained matrix.
Generic RGB classical segmentation separately requires explicit conversion to
normalized display-value intensity, using scikit-image's recorded channel
weights. Its measurements are labelled RGB-derived, never raw biological-channel
intensities. Neither RGB analysis route runs automatically on opening.

**Time and tracking.** Translation uses
[phase cross-correlation](https://scikit-image.org/docs/stable/api/skimage.registration.html)
with an explicit reference image and quality/ambiguity checks. Tracking uses
[SciPy linear-sum assignment](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.linear_sum_assignment.html)
with a physical distance gate, explicit gaps and competing-association records.
SciPy documents a modified Jonker–Volgenant implementation. LapTrack was
considered as a maintained broader tracker; the existing SciPy dependency is
sufficient for this release's bounded, inspectable one-to-one contract.
Corrections add/remove observed associations in a new revision. Missing frames
never create synthetic observations, and branch-like hypotheses never establish
biological division or identity. Drift-adjusted tracking coordinates remain
separate from the original object sizes and intensities.

**Registration and medical grids.** [SimpleITK](https://simpleitk.org/)
provides the physical-space I/O and selected rigid/affine registration route.
Transforms need explicit fixed/moving direction, metric, interpolation,
initialization, optimizer and output-grid records. Scalar resampling is a new
derived image; labels use nearest neighbour and retain integer IDs. Geometry
and quantitative fixture tests are required before an operation counts as
complete. Conventional scalar MR/CT DICOM series are the bounded starting
contract; enhanced/multiframe, diffusion, RT/SEG, ultrasound and ambiguous
series remain explicitly unsupported.

**Models.** Keep permitted Cellpose support as an optional runtime, alongside
ONNX Runtime and a BioImage.IO 0.5 ONNX description adapter. A description does
not authorize executable Python, pickle or arbitrary preprocessing. Require
identity, axes/dtype, normalization, channel/scale mapping, tile/halo rules,
reference tensors, runtime compatibility and rights/citation evidence.
[BioImage.IO's tolerance guidance](https://bioimage-io.github.io/spec-bioimage-io/v0.5.12.0/api/bioimageio/spec/model/v0_5/)
recognizes hardware variance; an acceptance record must say what tolerance and
runtime were actually tested. Provider support such as
[CoreML](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
or [CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
requires a compatible installed runtime and operation, not merely a device name.

**Remote compute.** OpenSSH aliases and strict host verification feed bounded
direct/PBS/Slurm adapters. Persist the original request and server job identity
before reporting submission, and verify retrieved output as untrusted input.
A laptop disconnect must not resubmit an accepted job. Vanda qualification
uses discovered queues/resources and allocated jobs; SSH login is not an
allocation. Results remain unreviewed on attachment. See
[REMOTE_RESULTS.md](REMOTE_RESULTS.md) and the run evidence for exact limits.

## Assessed specialised outcomes

Stitching, deformable registration, filament tracing, lineage inference and
deconvolution are outside the adopted 1.0 method set. This is a finite method
choice, not a claim that researchers do not need them. Each introduces a
separate acquisition/PSF/topology or biological-reference problem that the
current fixture contract cannot establish.
[BigStitcher registration](https://imagej.net/plugins/bigstitcher/registration)
is a useful interest-point/global-optimization reference for future stitching;
it is not a bundled or verified Loci capability. Portable reviewed annotations
are included now. Training a new model is not a prerequisite for this release;
a later bounded adaptation workflow must bind training examples, splits,
rights, runtime and held-out validation before model adoption.

## Evidence standards

Known anisotropic/oblique transforms, axis permutations, sparse large labels,
raw intensity references, missing/ambiguous tracks and exact export round trips
control numerical acceptance. Remote malformed manifests and interrupted jobs
control recovery acceptance. Real datasets, accelerators, schedulers and
packaged UI journeys add qualification; a synthetic reference or installed
library alone cannot establish an end-to-end capability. Performance reports
must name hardware, source/build identity, first-view and integrity time,
memory, throughput and cancellation scope. Missing code or UI remains
engineering work under the release contract.

## Interface refinement constraint (owner addition, 2026-09-07)

The instruction-only `make-interfaces-feel-better` skill from
`jakubkrehel/make-interfaces-feel-better` is installed at revision
`35545ea1512ad59fa463e6b1f95ca9c052981fe6` in this checkout's
`.agents/skills/make-interfaces-feel-better/`, with its MIT licence and
source identity retained. Its guidance was applied to the image-first interface.
No upstream root instructions, global settings, other skills, hooks or services
are part of this installation.

Use quick reviews for normal UI slices and a bounded full review for the
populated workspace and final consistency pass. Preserve Loci's palette
families, supported themes, font, Lucide icons, plain CSS architecture and
shared tokens. Prioritize readability, hierarchy, clear state, consistent
controls and useful canvas space. Exact aesthetic values in the skill are
contextual guidance. Scientific pixels, masks, overlays and exports receive no
decorative outlines, blur, clipping, colour or animation; coordinate mapping,
physical scale, hit testing and numerical meaning remain authoritative.
Precision interactions stay immediate, reduced motion is respected, and larger
targets must not overlap or crowd the workspace. Add no motion, font or styling
dependency for polish. Inspect actual populated software across window sizes,
themes, text sizes, keyboard and relevant loading/error/recovery states; record
before/after evidence and applicable packaged checks. This constraint extends
the existing release goal and does not replace feature completion.
