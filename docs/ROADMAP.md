# Product roadmap

## Milestone 0 — implemented product foundation

- Native file and recursive-folder import for TIFF, PNG, and JPEG, with
  read-only source handling and remembered picker locations
- Local single-image analysis with read-only source handling
- Model selector with profile-specific controls for Loci Adaptive Watershed,
  website-compatible Cellpose-SAM, and the separate Cellpose-SAM v2 profile
- Cellpose adapters pinned to `cellpose==4.2.1.1`, original `cpsam`, and genuine
  `cpsam_v2`, with per-profile status and verified user-selected checkpoint
  import
- Export preferences for count summary, per-instance measurements, overlay,
  label mask, and analysis record
- Graphite, midnight, and light visual themes, interface text-size choices, and
  reduced-motion-aware interface animation
- View-first import with colour-preserving source previews, non-destructive
  display controls, explicit black/white levels, a sampled log histogram,
  disclosed sampled 1st–99th-percentile Auto with a full-range fallback for
  effectively flat samples, hold-to-compare Original, and an explicit
  switch into the existing Analyze workspace
- Frozen-runtime LZW TIFF decoding with regression QA; no single global
  compressed-file ceiling, a metadata-derived 512 MiB decoded-memory guard,
  and a dynamic PNG-only contiguous-decoder guard until tiled readers land
- View-only overviews from compatible single-root/SubIFD TIFF pyramid levels
  whose selected decoded level fits the 64 MiB overview guard; single-level or
  incompatible oversized TIFFs still fail before hashing or decoding
- Content-validated `.ims` Imaris 5.5+ HDF5 overview import with native volume,
  channel, pyramid, and timepoint metadata plus physical extent/voxel size only
  when valid declared metadata exists; bounded TimePoint-0 central-Z display
  remains explicitly separate from native planes and 3D
- Full-resolution adjusted-view export for current eager-loaded images that
  pass the separate 768 MiB working-memory estimate, as 8-bit PNG or 16-bit
  TIFF with source revalidation and atomic no-overwrite publication
- Import-first adaptive routing backed by versioned source descriptors:
  ordinary ambiguous images remain Generic 2D, stored TIFF pyramids route to
  Pathology, and declared IMS/C/Z/T data route to Scientific volume, with a
  saved **Open source as** override and no automatic analysis
- Atomic, revisioned `.loci-project` creation, autosave, reopen, conflict
  detection, migration entry point, renderer-safe manifests, and opaque recent
  project entries
- Shared versioned job/result contracts, strict lifecycle validation, atomic
  persistence, conservative restart reconciliation, bounded transient
  fingerprint history, and an active-work Job Center
- Truthful Settings capability overview without silent downloads or premature
  install controls

The current macOS packaged profile includes the pinned Cellpose 4.2.1.1 runtime,
but it never bundles or downloads the `cpsam` or `cpsam_v2` checkpoint.
PyTorch dominates the frozen engine footprint; the dated QA checkpoint records
its measured size. A Cellpose profile remains unavailable until a user explicitly imports its
verified checkpoint. A future explicitly labelled Lite build may omit the
runtime; the smaller default source-development environment already does.

## Milestone 1 — integrated engineering QA passed

- Recursive batches run through a private sharded plan and one atomic item
  record per source, after every source fingerprint has been verified. The plan
  is bound to the exact saved project so restart recovery cannot drift into a
  different project with coincidentally matching source identifiers.
- The shared durable job protocol records parent progress and a verified result
  manifest; cancellation is explicit, interrupted running work becomes
  **Needs attention**, and retry queues only unfinished items. Loci does not
  silently claim that an interrupted local process resumed. If every image was
  already complete when the application stopped, retry performs only the
  missing project/parent finalization and never reruns those images.
- Processing and export are separate. A successful batch enters a review
  contact sheet; export begins only when the researcher chooses **Export
  batch**, preserving relative source hierarchy and configured artifacts.
- Review and exclusion decisions bind to the exact result identifier and
  correction revision. A rerun or correction invalidates the older decision.
  Unreviewed results may still be exported for research use with a visible
  boundary-review warning.
- Manual correction supports add, delete, split, merge, reshape, source-pixel
  brush painting, stroke erasure, explicit boundary-vertex movement, undo, and
  redo through the isolated engine. Each corrected revision is checkpointed as
  a verified immutable working-result pack and bound into the project before
  it can be recovered after restart.
- Clearing a result or changing its model/settings atomically retires the exact
  active project binding before renderer state changes. Historical jobs remain
  as provenance, while retired pixel-bearing packs become eligible for private
  cache collection and cannot reappear after reopen.
- Confirmed quit performs a correlated renderer save, including changes still
  inside the autosave debounce, and defaults to keeping Loci open if the save
  fails or times out.
- The model registry exposes **Unvalidated**, **Experimental**, **Validated for
  a declared domain**, and **Not recommended** evidence states. Original
  `cpsam` remains the website-compatible default only; genuine `cpsam_v2`
  remains unvalidated in Loci.
- The developer Cellpose benchmark harness locks checkpoint and source hashes,
  preprocessing, settings, device resolution, cold/warm timing, structural
  status, and exact-repeat behavior without presenting compatibility counts as
  biological accuracy.

The settled engineering checkpoint passed 409 desktop tests, 219 engine tests,
60 native-model developer tests, 14 compatibility-harness tests, 23
release-evidence tests, 11 release supply-chain tests, and the local ad-hoc
packaged macOS journey. That
journey exercised explicit review-before-export, exact project result/review
recovery after relaunch, conservative cancellation handling, an 11-result
batch beyond the eight-result engine cache, a separate recursive-folder smoke,
durable result retirement followed by a fresh-rerun restore, two-display
placement on the one tested Mac, and zero renderer HTTP(S) requests observed by
the Playwright page instrumentation. A separate
dated packaged run covered actual isolated-worker restart.
The detailed evidence and boundary are in
Milestone 1: complete 2D cell workflow.

This is engineering qualification for the recorded local configuration, not
Developer ID/notarized release qualification, broad hardware validation,
independent-lab validation, or biological model validation.

Still deferred rather than implied by Milestone 1: a user-visible pause
control, portable path-redacted project packages, source relinking, and pane
resizing.

## Milestone 2 — public macOS beta and distribution quality

Engineering work may proceed, but release depends on explicit external gates:
Apple Developer ID credentials and notarization access, clean-Mac testing,
authorization to make the repository and binaries public, and independent-lab
workflow validation. None of those gates is satisfied merely by passing local
tests.

- Reproducible Apple-silicon packaging for the current Cellpose-enabled profile,
  plus a future explicitly labelled Lite profile that omits that runtime
- Developer ID signing, hardened runtime, notarization, stapling, checksums, and
  clean-Mac Gatekeeper testing
- Deterministic strict CycloneDX 1.6 SBOMs and the checksum-manifested
  third-party licence bundle are implemented for the packaged macOS runtime;
  final-app generation and human licence review remain release gates
- Deterministic app/lock/signature/notarization evidence collection and a
  fail-closed public-readiness checker are implemented; see
  [macOS release evidence](RELEASE_EVIDENCE.md). It records gates and the
  companion generator creates SBOM/licence artifacts, but neither creates
  credentials, legal clearance, clean-Mac evidence, or approval.
- Installer, Retina, external-display, fullscreen, restore, low-memory, and
  corrupt-input QA
- Windows x64 packaging and 100-200 percent display-scaling QA after macOS

## Model personalization

- Representative-image selection and assisted pre-segmentation
- Acquisition-group-aware train/validation/test splits
- Code-free local training queue with resource estimate and cancellation
- Side-by-side comparison on untouched validation images
- Versioned model registry, model cards, rollback, import, and export
- Locked held-out instance and count validation with failure-mode reporting

## Rights-cleared Loci-native model

- Rights-cleared, acquisition-group-aware training manifest
- Researcher correction of a representative pseudo-label subset
- Compact instance model trained from random initialization
- Inference-only ONNX model pack with hash and rights verification
- CPU reference inference and parity-tested Apple acceleration
- Domain-specific validation before any accuracy or suitability claim

The predefined evidence levels and proposed acceptance thresholds are in the
[native model evaluation protocol](NATIVE_MODEL_EVALUATION_PROTOCOL.md).

## Cellpose profile validation

- Lock a diverse, researcher-adjudicated rights-cleared lab image set before comparing
  `cpsam` and `cpsam_v2` for accuracy
- Predefine instance matching, count error, dense-cluster, low-contrast, debris,
  and empty-field metrics before any threshold tuning
- Retain original `cpsam` as the website-compatible default—not an accuracy
  recommendation—until genuine `cpsam_v2` demonstrates a reproducible
  advantage on that locked set
- Record checkpoint digest, preprocessing mode, settings, source dimensions,
  and compute device for every comparison

## Next workspace: viewer-first H&E pathology

- Tiled, ICC-aware whole-slide viewer with bounded cache, cancellation, and
  read-only source handling
- Content-detected OpenSlide, OME-TIFF/BigTIFF, scientific TIFF, common raster,
  and DICOM WSI adapters with fixture-tested claims
- Faithful colour-managed display, metadata inspection, full-resolution
  navigation, scale bars, and non-destructive brightness, contrast, gamma, and
  supported stain/component views
- High-resolution publication rendering with explicit output dimensions, colour
  profile, scale, crop, and complete display-transform provenance
- Reopenable viewing states that remain separate from immutable source images
- Decoder, ICC, orientation, physical-scale, viewport/export-parity,
  latency/memory/cancellation, and corrupt-input QA

The first H&E release does not include thresholding, segmentation, cell
classification, or model fusion. The viewer must be complete and valuable on
its own.

## Conditional later pathology research

- Freeze task-specific datasets, checkpoints, preprocessing, metrics,
  acceptance thresholds, and licensing evidence before testing any model for
  inclusion
- Evaluate tissue-area aids only if they are demonstrably reliable and remain
  distinct from display controls; do not make Otsu a default by convenience
- Run a frozen StarDist-versus-InstanSeg nuclei study only after the viewer
  foundation is stable
- Consider a HoVer-Net CoNSeP layer only under the narrow label **Colorectal
  research classes**, never as generic cell classification
- Add interoperable mask, polygon, measurement, and provenance exports only
  when a corresponding analysis layer passes its release gate

The architecture, format contract, colour/export fidelity requirements, model
rights, and validation boundary are recorded in
[ADR 0004](ADR-0004-pathology-workspace.md). The current application does not
yet claim WSI, true scientific-channel, or pathology-model support.

## Later file-type-specific workspaces

Full multichannel microscopy, z-stacks, 3D pathology, and medical volumes require
separate viewer, data-model, memory, licensing, and validation designs. They
are not minor extensions of the 2D cell-counting workspace. After the H&E
workspace is validated, the next phase will cover multichannel/3D microscopy,
then radiology volumes. Local inference remains the default; a generic
SSH/Slurm adapter may be evaluated for opt-in remote compute without embedding
cluster credentials or coupling Loci to one institution. The implemented
modern-IMS central-plane overview validates content detection, bounded HDF5
reads, and metadata plumbing; it is not yet the full scientific-volume
workspace.

The active distribution and Cellpose decision is recorded in
[ADR 0003](ADR-0003-open-source-cellpose-integration.md). Loci uses the
Apache-2.0 licence and is being prepared for a public open-source release; it is
non-monetised at this stage. Commercial Cellpose inference, checkpoint bundling,
or commercial fine-tuning remains out of scope pending written rights
clarification.
