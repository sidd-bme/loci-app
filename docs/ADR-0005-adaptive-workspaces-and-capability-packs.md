# ADR 0005: adaptive workspaces and capability packs

- **Status:** accepted direction; staged implementation
- **Date:** 2026-08-30

## Context

Loci began as a focused cell-counting application. The product now also needs a
professional still-image and pathology viewer, multichannel microscopy, modern
Imaris volumes, and later 3D navigation. Shipping every decoder, ML runtime, and
3D rendering dependency in one mandatory bundle would make installation large,
updates fragile, and the interface increasingly difficult to understand.

Conversely, separate applications for each modality would fragment studies and
force users to relearn import, viewing, provenance, export, and remote-compute
workflows. A modality picker shown before every import would also ask users to
classify files that Loci can usually identify itself.

## Decision

Build one coherent Loci application shell with an included core viewer and
optional, independently versioned capability packs. Import stays the primary
entry point. Loci detects the file structure and metadata, opens the safest
available viewing workspace, and recommends relevant capabilities without
silently downloading or running them.

The welcome screen remains general rather than becoming a launcher grid:

1. **Open images** or **Open folder**;
2. inspect content and metadata locally;
3. enter the appropriate viewing workspace automatically; and
4. offer an explicit **Open as…** recovery action only when detection is
   ambiguous.

Settings gains a **Capabilities** page for installing, updating, disabling, or
removing optional packs. Each pack has a signed manifest, exact version,
dependency and licence disclosure, checksum verification, installed-size
estimate, and an offline package-install route. Network access is never implied
by opening a source image.

Initial capability boundaries are:

- **Core viewer:** common single-plane raster images, non-destructive display,
  metadata, export, and the application shell.
- **Cell analysis:** Cellpose runtime integration, managed or user-provided
  checkpoints, Loci Adaptive Watershed, correction tools, counting, and analysis
  export.
- **Pathology and large 2D:** tiled TIFF/BigTIFF, supported whole-slide formats,
  ICC colour management, physical scale, and publication rendering.
- **Scientific volumes:** modern HDF5-based Imaris IMS, OME-TIFF/OME-Zarr
  multichannel and z-stack data, orthogonal planes, and later volume rendering.
- **Remote compute connector:** optional SSH/HPC or service adapters that never
  become prerequisites for local viewing.

## Workspace model

The canvas remains the dominant surface. The inspector adapts without changing
the app's basic spatial grammar:

- **Display** changes only the on-screen mapping and rendered-view export.
- **Processing** creates an explicit derived image and records every parameter.
- **Analyze** produces masks, objects, measurements, or classifications under a
  task-specific validation and provenance contract.
- **Info** shows immutable source metadata and clearly labelled user overrides.

Processing is not shown until at least one real, reversible derived-image
operation is implemented. Analysis is not recommended merely because a model is
available. RGB components are never relabelled as biological channels.

## Size and performance contract

Loci will not advertise a literal "no file-size limit." Any finite computer has
resource limits, and compressed bytes do not predict decoded memory. Instead:

- do not impose one global encoded-file threshold; a decoder that requires a
  contiguous encoded stream may have a disclosed, format-specific input guard;
- inspect dimensions, dtype, chunk/tile layout, and pyramid levels before
  allocating decoded pixels;
- eager-load only bounded still images;
- use lazy tiles or chunks for large 2D, z-stack, time-series, and volume data;
- bound decoded caches and working memory rather than source-file size;
- keep navigation and cancellation responsive under cache pressure; and
- fail with an actionable format/architecture explanation when a non-tiled
  source cannot yet be opened safely.

The current integrity check hashes an accepted source completely before and
after reading it. Large-file import therefore remains linear in encoded file
size even when the decoded plane, tile, or chunk is bounded.

This is size-independent source access, not unlimited RAM or compute.

## Imaris IMS decision

Support modern Imaris 5.5+ files directly from their documented HDF5 structure.
The format already provides multiresolution levels, 3D chunks, channel/timepoint
groups, histograms, physical extents, and a thumbnail. Loci should read only the
resolution, plane, channels, and chunks required for the current view.

Do not embed Bio-Formats in the permissively licensed core merely to maximize
format count. Bio-Formats is GPL with commercial licensing available, while the
modern IMS HDF5 structure is publicly documented and can be read with
permissively licensed HDF5 tooling. Older binary and TIFF-variant IMS files are
separate compatibility targets and must be content-detected rather than assumed
from the `.ims` extension.

## Scientific display minimum

Before calling a modality workspace professional, it must provide the controls
that are meaningful for that source type:

- explicit black and white display points with a histogram;
- Auto and Reset with the algorithm disclosed;
- gamma with a real numeric value;
- source dtype, value basis, dimensions, and physical calibration when present;
- per-channel visibility, LUT/colour, window, gamma, opacity, solo, and
  composite/split view for true multichannel data;
- pixel or voxel coordinates and native intensity under the cursor;
- saved display presets that remain separate from raw metadata;
- original/current comparison; and
- full display/export provenance.

Brightfield H&E adds ICC-aware colour, white/background reference, and optional
display-only stain separation only after a reference implementation and
golden-image tests. Fluorescence adds per-channel controls. Neither receives
thresholding or segmentation by default.

## Consequences

- Users experience one product and one project model without paying the startup,
  storage, or interface cost of unused heavy features.
- Core imports remain fast and offline; capability installation is an explicit
  administrative action.
- A decoder or model can be updated independently without changing scientific
  results from other workspaces.
- Distribution requires a pack manifest, compatibility matrix, licence ledger,
  and deterministic fallback UI.
- Current single-plane eager viewing remains a bounded foundation, not evidence
  that tiled pathology or 3D volume viewing is complete.

## Implementation checkpoint

The 2026-08-31 Milestone 0 kernel now implements versioned source descriptors,
structural workspace routing, a saved **Open source as** override, atomic local
projects with recent-project recovery, strict renderer-safe manifests, shared
job/result contracts, restart-aware job persistence, a bottom Job Center, and
an honest Settings capability overview. Ordinary RGB inputs remain Generic 2D;
declared TIFF pyramids route to Pathology; IMS or declared C/Z/T structure route
to Scientific volume. No route starts analysis or infers a stain.

The earlier 2026-08-30 viewing foundation includes explicit black/white levels with a sampled
histogram, a hold-to-compare Original view, frozen LZW TIFF decoding, and two
strictly View-only overview adapters: a compatible single-root/SubIFD TIFF
pyramid level whose selected decoded overview fits 64 MiB
when the native plane exceeds the eager guard, and TimePoint 0/central Z from a
modern HDF5-backed IMS pyramid. Both adapters expose native geometry and the
selected overview provenance while independently rejecting analysis and
full-source rendered export. They validate the adaptive-workspace contract;
they do not yet provide tiled navigation, arbitrary planes, live channel
controls, or 3D rendering.

Settings reports included, foundation-only, and unavailable capabilities, but
capability-pack install/remove controls remain a packaging direction rather
than current functionality. The present macOS artifact remains one
Cellpose-enabled application bundle; modular downloadable packs and a Lite
installer are not yet implemented. Source inspection is the first operation on
the shared job protocol; segmentation, batch export, remote compute, and
training still require executor migration.

## Primary references

- [Imaris Display Adjustment](https://imaris.oxinst.com/learning/view/article/how-to-achieve-optimal-image-characteristics-with-the-display-adjustment-window)
  documents per-channel visibility and colour, min/max range, gamma, opacity,
  histogram, Auto, and Reset as display adjustments that do not change voxel
  values.
- [QuPath image concepts](https://qupath.readthedocs.io/en/0.5/docs/concepts/images.html)
  distinguishes RGB imagery from true multichannel data and documents
  per-channel visibility, colour/LUT, and brightness controls.
- [QuPath multiplex analysis](https://qupath.readthedocs.io/en/stable/docs/tutorials/multiplex_analysis.html)
  documents named channels and persistent brightness/display profiles.
- [Imaris file format](https://imaris.oxinst.com/support/imaris-file-format)
  documents the modern HDF5 structure, resolution levels, 3D chunks,
  channels/timepoints, histograms, thumbnails, and physical extents.
- [OME Bio-Formats Imaris documentation](https://docs.openmicroscopy.org/bio-formats/6.5.1/formats/bitplane-imaris.html)
  distinguishes the legacy binary, TIFF-variant, and modern HDF5 IMS families.
- [OME Bio-Formats source and licence](https://github.com/ome/bioformats)
  establishes the GPL/commercial-licence boundary considered by this decision.
