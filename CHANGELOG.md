# Changelog

All notable changes to Loci will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Local packages identify themselves as numbered unreleased development builds with their own source revision; the compatibility version and published beta.2 download remain unchanged.

### Added

- Scientific data packages with exact stored measurements, review and sample metadata, complete group memberships, provenance, and standalone Python/R readers.
- Transactional sample-sheet import and raw mean intensity reports that preserve image, declared replicate and condition aggregation, exact saved revisions, and atomic package export.
- Study and export navigation that retains explicit result scope and provides recovery actions for missing review or groups.
- Study tabs for Samples, Intensity, Batch and available Corrections, with a searchable Sources & samples table and exact result inspection.
- Direct object-label navigation across filtered pages, expandable exact intensity values, and saved annotation measurements and coordinates.

### Changed

- Focus panel / Show image for analysis and ordinary result review, retaining drafts and prepared export previews while giving smaller screens more task space.

- Ordinary results open in Review; Export contains result and scientific data exports. Editable data-export choices survive navigation; reopening requires a fresh preview.
- Classical scalar analysis names the segmentation input separately from raw measurement and display channels, with one-based T/Z scope labels.

These are source changes. The published download remains **v0.2.0-beta.2**; no new release assets are included.

## [v0.2.0-beta.2] - 2026-10-19

### Added

- Folder-aware image browsing, relative-path search, breadcrumbs and folder selection for batches.
- Bounded classical previews and ROI parameter comparisons with exact-result adoption.
- Persistent compact channel controls, reproducible population gates and named groups.
- Saved compute targets, recoverable remote execution and explicit review history.
- Provisional RGB review packages with counts, native outlines and retained provenance.

### Improved

- Robust group discovery when an unrelated source is unavailable.
- Calibrated-preview mean validation preserves floating-point precision across area scales.
- Remote read budgets, target refresh and recovery on unsupported export filesystems.


### Added

- Inspectable analysis context across result selection, correction, review, export and reopening.
- Explicit raw-channel measurements for cell, nuclear and remaining compartments, with retained label dependencies.
- Portable four-interface and ImageJ numerical reproduction harnesses.

### Improved

- Readable source and result choices, concise analysis controls and clearer Workflow and Statistics layouts.
- Source-channel overlays after model adoption and reopening, and coordination between source viewing and result export.
- ROI acquisition binding, bounded medical projections, RGBA display and vendor codec diagnostics.
- PNG/JPEG measurements use pixel units; print density is no longer interpreted as specimen calibration.

The [release record](docs/RELEASE_STATUS.md) identifies the exact tested source and downloadable artifacts. This remains an unnotarized macOS Apple Silicon development beta; no model checkpoints are bundled.

## [v0.2.0-beta.1] - 2026-10-12

### Added

- Independent image windows with a shared control panel, synchronized display settings and source annotations.
- Object population queries, linked selection, enlarged statistics views and figure export.
- External label adoption, correction-effect reports and large-result exchange.
- Visual workflow editing, reusable recipes and explicit resource controls.
- A persistent terminal interface, readable command output, local agent setup and expanded MCP guidance.
- A first-study walkthrough and updated workflow guides.

### Improved

- Responsive plane navigation, per-view cancellation and session annotation drafts.
- Multichannel volume display, calibrated measurements and source recovery.
- Renderer error privacy, release-asset checksum verification and packaged regression coverage.

### Development beta

The macOS Apple Silicon download uses an ad-hoc integrity signature and is
unnotarized. Model checkpoints are not bundled. See the [release record](docs/RELEASE_STATUS.md)
for the candidate's checks and [installation guide](docs/INSTALLATION.md) for first launch.

## [v0.1.0-beta.1] - 2026-09-16

### Initial Public Beta Release

#### Added
- **Image-First Viewing:**
  - Multi-dimensional C/Z/T navigation with independent false-color and window/level transfer functions.
  - Native whole-slide imaging support for Aperio SVS and Hamamatsu NDPI multiscale pyramids.
  - Direct 3D volume ray-casting and linked orthogonal Multi-Planar Reformatting (MPR) via vtk.js.
  - Supported medical scalar volume series (DICOM, NIfTI, NRRD) with orientation preservation.
- **Research Workbench:**
  - Discrete object selection and canvas picking (`result_label_at`) with active layer prioritization and camera scale preservation.
  - Quantitative measurement review table with metric kind awareness (areas, volumes, counts, intensities, fractions) and unit consistency.
  - Reusable recipe preset loader with active channel-compatibility verification.
  - Native coordinate annotations: points, bounding boxes, polygons, freehand boundaries, and calibrated transects.
- **Analysis Engine:**
  - Fully offline classical segmentation (adaptive watershed, Otsu, Yen, Li, local thresholding).
  - Provisioned Cellpose-SAM integration (`cpsam` and `cpsam_v2` profiles) with strict SHA-256 checkpoint verification.
  - Managed ONNX model package runner with scale and coordinate contracts.
- **Scientific Evidence & Persistence:**
  - Non-destructive workspace autosave and portable `.loci-study` persistence.
  - Publication-quality rendered figures, 16-bit TIFF array exports, and tabular CSV summaries with cryptographic SHA-256 manifests.

#### Known Beta Limitations
- First launch on macOS may exhibit an initial startup delay of approximately 75–85 seconds (observed on Apple Silicon M1 with 8 GB RAM) during initial component verification and runtime initialization; subsequent launches open faster once cached by macOS.
- macOS beta binary uses an ad-hoc local integrity signature and is unnotarized; macOS Gatekeeper blocks direct opening. On macOS 15 (Sequoia) and modern macOS releases, user approval requires going to **System Settings → Privacy & Security → Open Anyway** (the previous Finder Control-click shortcut is restricted on Sequoia).
- Deep learning checkpoints (Cellpose-SAM) are not bundled; users supply official checkpoints directly. Commercial rights to third-party model weights remain subject to upstream licenses.
