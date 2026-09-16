# Changelog

All notable changes to Loci will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Multi-Agent Infrastructure:**
  - Model-neutral collaboration guidelines in `AGENTS.md` and `docs/COLLABORATION.md`.
  - Pinned interface design skills (`impeccable`, `make-interfaces-feel-better`).

#### Known Beta Limitations
- First launch on macOS may exhibit an initial startup delay of approximately 75–85 seconds (observed on Apple Silicon M1 with 8 GB RAM) during initial component verification and runtime initialization; subsequent launches open faster once cached by macOS.
- macOS beta binary uses an ad-hoc local integrity signature and is unnotarized; macOS Gatekeeper blocks direct opening. On macOS 15 (Sequoia) and modern macOS releases, user approval requires going to **System Settings → Privacy & Security → Open Anyway** (the previous Finder Control-click shortcut is restricted on Sequoia).
- Deep learning checkpoints (Cellpose-SAM) are not bundled; users supply official checkpoints directly. Commercial rights to third-party model weights remain subject to upstream licenses.
