# Loci project and release state

Current release: **v0.1.0-beta.1** (Public Beta)

Loci is a local-first desktop imaging workbench for life-science and biomedical research. This document records current release qualifications, supported workflows, scientific boundaries, and known beta limitations.

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

---

## 2. Platform qualification & test status

### Verified in this release:

- **macOS (Apple Silicon arm64):**
  - **Desktop test suite:** TypeScript typecheck and Vitest suite (**825 tests / 92 files passed**).
  - **Packaging unit tests:** Node packaging safety and bundle integrity (**10 tests passed**).
  - **Python engine suite:** Ruff linting clean; Pytest suite (**916 passed, 12 skipped** for optional GPU/external dependencies).
  - **Regression runner suite:** Runner unit tests (**10 passed**).
  - **Packaged UI regression journeys:** Verified against staged macOS application bundle:
    - *Journey 1 (research-workbench):* 2D/3D object picking, multichannel puncta, review table, project persistence, and reopen (**passed, 17 checkpoints**).
    - *Journey 2 (workbench-refresh):* Pointer drag reordering, worker refresh, batch palette recoloring, undo restoration, and A/B comparison (**passed, 11 assertions**).
    - *Journey 3 (field-assay-workflow):* Fluorescence field assay quantification, background subtraction, manual override counts, and review gates (**passed**).

### Platform boundaries:

- **macOS:** Tested on Apple Silicon (macOS 14+). Intel x86_64 builds require manual compilation from source.
- **Windows x64:** Local build scripts (`build-engine.ps1`, `package:windows:local`) are maintained. Automated Windows CI is currently paused for release stabilization.
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
   On the very first launch after installation, the bundled Python analysis worker unpacks and verifies its internal components. This initial startup may take **75–85 seconds** before the welcome screen appears. Subsequent launches warm up and start normally.
2. **macOS Gatekeeper warning (ad-hoc signing):**
   The public beta binary is signed with an ad-hoc integrity signature. Because it is not yet signed with an Apple Developer ID certificate or notarized by Apple, macOS will show a security warning ("unidentified developer") on first open. To open:
   ```bash
   xattr -cr /Applications/Loci.app
   ```
   Or right-click (Control-click) `Loci.app` in Finder and select **Open**.
3. **Memory bounds on massive datasets:**
   Whole-slide images and large 3D/4D volumes use progressive pyramid levels and bounded tile decoders. Rendering extremely large volumes at 100% ray-sampling quality on systems with 8 GB unified memory may trigger automatic downsampling to protect system responsiveness.

---

## 5. Next development priorities

- Apple Developer ID signing, hardened runtime, and notarization automation.
- Resumption of automated Windows CI and distribution of Windows installer packages.
- Additional managed ONNX model packages with verified biological provenance.
- Expanded Bio-Formats vendor format support and batch conversion pipelines.
