# ADR 0004: viewer-first tiled pathology workspace

- **Status:** accepted direction; bounded still/overview foundation implemented,
  tiled pathology workspace and validation pending
- **Date:** 2026-08-30
- **Scope:** the next workspace after the current 2D cell-counting workflow

## Context

H&E slides are not large versions of the current still-image input. A whole
slide may contain tens of billions of pixels, multiple pyramid levels, scanner
metadata, an ICC colour profile, and companion files. Loading the complete
image or label plane into memory would make the current 2D architecture unsafe.

The first pathology release remains a research-use viewing workspace. It must
not imply clinical validation, diagnosis, universal tissue coverage, or
universal cell classification. Image fidelity, responsive navigation, clear
metadata, and reproducible publication export take priority over adding an
unproven analytical model.

## Decision

Build pathology as a separate, file-type-aware 2D workspace with a local tile
worker and non-destructive display layers. The first release is deliberately a
viewer and publication-quality display/export foundation. Its user journey is:

1. import a slide or slide fileset without modifying the source;
2. inspect scanner, resolution, dimensions, channels, and colour metadata;
3. navigate an ICC-aware tiled view;
4. adjust display-only brightness, contrast, gamma, white balance, and
   supported stain or component views without changing source pixels;
5. compare the adjusted view against the declared default source-derived view
   at full resolution;
6. compose a high-resolution export with explicit scale and colour/provenance
   metadata; and
7. save a reopenable viewing state separately from the source image.

H&E, brightfield IHC, and fluorescence remain distinct acquisition profiles.
An H&E colour-deconvolution view is display assistance, not a true fluorescence
channel. Multichannel fluorescence and z-stacks follow in a later workspace.

Thresholding, tissue masks, nuclei segmentation, cell classification, and model
fusion are excluded from the first pathology release. They may be added later
only as optional analysis layers after each exact task, checkpoint,
preprocessing path, licence, and intended tissue scope passes the gates below.
The viewer must remain useful and distributable without those layers.

## Conditional analysis research

The following lanes record possible future evaluations. They are not committed
features and must not appear as recommended controls in the viewer until their
release gates are satisfied.

### Tissue and background

Do not make thresholding a default simply because it is computationally cheap.
Thumbnail-scale Otsu thresholding plus morphology may be evaluated as an
explicit tissue-area aid, but it must demonstrate reliable behaviour on frozen,
representative slides and remain clearly separate from colour display controls.
The BCSS `fcn_resnet50_unet-bcss` checkpoint may be researched as an
experimental **breast tissue regions** profile; it must never be labelled as a
generic tissue model.

### Nuclei instances

Run a frozen bake-off before selecting or shipping a recommended model:

- [StarDist `2D_versatile_he`](https://github.com/stardist/stardist-models) is
  the mature baseline. The model repository declares BSD-3-Clause, but its
  training-data lineage still needs written commercial clarification before a
  paid distribution relies on it.
- [InstanSeg `brightfield_nuclei`](https://github.com/instanseg/instanseg) is
  the engineering challenger. Its official model index currently identifies
  checkpoint version 0.1.1 and Apache-2.0. It remains experimental in Loci
  until the frozen comparison is complete.

Neither model is called universally “SOTA.” No pathology model is the default;
one may become a narrowly labelled optional layer only after locked,
reproducible evaluation on declared datasets and fixed checkpoints.

### Cell classification

A possible research candidate is TIAToolbox `hovernet_original-consep`, whose
current model registry declares Apache-2.0 weights. It operates at 0.25
micrometres per pixel and exposes epithelial, inflammatory, spindle-shaped, and
miscellaneous classes. Because CoNSeP is colorectal adenocarcinoma data, any
future Loci profile would be labelled **Colorectal research classes** and would
not generalise its taxonomy to other tissues.

Do not bundle non-commercial PanNuke-, MoNuSAC-, Kumar-, CoNIC-, internal-TIA-,
Mesmer-, CellViT-, or DeepLIIF-derived model packs in a commercialization-capable
core. Open-source application code does not cancel checkpoint or training-data
restrictions.

## Viewer stack

Use one exact-version-pinned viewport for brightfield and scientific-channel
images rather than maintaining separate navigation engines:

- [Viv 0.22.1](https://github.com/hms-dbmi/viv) with
  [deck.gl 9.3.11](https://deck.gl/) is the build target for the tiled-viewer
  spike. It provides a biological multiscale data model, channel visibility,
  colour/LUT and contrast-window controls, scale bars, and shader extension
  points under the MIT licence.
- [OpenSlide](https://openslide.org/api/python/) is the primary isolated RGB
  whole-slide decoder because it reads pyramid regions without full-slide
  allocation and exposes ICC profiles. LGPL-2.1 distribution compliance remains
  a release gate.
- [tifffile](https://github.com/cgohlke/tifffile) plus imagecodecs is the
  scientific OME-TIFF/BigTIFF/QPTIFF decoder. It does not replace OpenSlide's
  RGB colour-management lane.
- Read OME-Zarr 0.4 first and fixture-gate the newly final
  [0.5 contract](https://ngff.openmicroscopy.org/0.5/index.html) before relying
  on it for exchange. Any app-managed pyramid cache is rebuildable and never
  becomes the only copy of source data.

OpenSeadragon remains a fallback only if the Viv spike fails; adopting both
would duplicate viewport state while offering no scientific-channel advantage.
ITK-Wasm and vtk.js remain deferred to the later 3D volume workspace.

The renderer receives opaque source IDs and cancellable tiles through a narrow
preload or custom-protocol API. Absolute paths stay in the main/worker boundary.
Brightfield tiles are converted from a usable source ICC profile to sRGB once
in the worker. Scientific intensity tiles retain native values for GPU window,
gamma, LUT, visibility, and blend controls. GPU output and CPU publication
rendering require golden-image parity tests before release.

## Format and size contract

Detect formats from file content and metadata, not the filename alone.

- OpenSlide adapter: SVS, NDPI, SCN, MRXS, BIF, VMS/VMU, supported vendor TIFF,
  and generic tiled TIFF/BigTIFF. Each claimed format requires a passing fixture
  because [OpenSlide documents incomplete vendor support](https://openslide.org/formats/).
- tifffile/imagecodecs adapter: OME-TIFF, OME-BigTIFF, QPTIFF, and scientific
  TIFF. Follow the [OME-TIFF specification](https://ome-model.readthedocs.io/en/stable/ome-tiff/specification.html)
  for pyramid and multi-file metadata.
- wsidicom adapter: DICOM whole-slide microscopy series or DICOMDIR. Ordinary
  radiology DICOM must fail with a clear message until the later 3D workspace.
- Existing still-image adapter: PNG, JPEG, and bounded ordinary TIFF, including
  LZW TIFF. Oversized non-pyramidal inputs will receive a cancellable, one-time
  local pyramid conversion.

MRXS, VMS/VMU, DICOM, and multi-file OME-TIFF are imported as atomic filesets.
CZI, ND2, LIF, radiology DICOM, MRI formats, interactive z-stacks, and time
series are deferred to the multichannel/3D phase. Modern HDF5-backed Imaris IMS
now has a bounded central-Z overview foundation, but native planes, channel
controls, and 3D remain in that later phase.

Do not impose a compressed-byte ceiling on tiled WSI. Instead:

- QA slides and filesets through at least 100 GB; larger inputs are best effort
  until tested;
- decode only 256–512 pixel viewport tiles from the nearest pyramid level;
- keep a bounded decoded-tile cache, initially about 512 MiB and reduced under
  memory pressure;
- if a gated optional analysis layer is later added, run it patch-wise with
  overlap and incremental disk-backed labels;
- never allocate a full-resolution WSI or label mask in RAM;
- preserve source ICC metadata while rendering the viewer into sRGB; and
- isolate native decoders in a cancellable worker process.

The former 30-million-pixel View limit and global encoded-file limit have been
removed. The current eager still-image reader instead preflights the declared
decoded layout and enforces a 512 MiB decoded-memory guard until the tiled
reader is ready. PNG additionally has a dynamic format-specific input guard
because its current decoder requires one contiguous encoded stream. Analyze
retains a separate 30-million-source-pixel/estimated-memory guard because its
temporary label and float planes are substantially larger than the source.
A full-access eager source that also passes the separate 768 MiB rendered-export
estimate can be rendered through the display recipe into an 8-bit PNG or 16-bit
TIFF with source revalidation and atomic no-overwrite publication. That is a
useful still-image foundation, not yet an
ICC-certified, chunked, cancellable, or tiled WSI publication pipeline.

## Viewer validation contract

The first-release acceptance suite is product and fidelity validation rather
than model benchmarking. Validate decoders with OpenSlide vendor fixtures,
official OME-TIFF samples, DICOM WSI fixtures, and the public
[IDC/WG-26 2026 corpus](https://github.com/ImagingDataCommons/wg26-2026-connectathon-idc).

For every supported format, verify ICC transforms against a declared reference,
orientation, pyramid-level selection, physical pixel size, channel/component
interpretation, scale-bar calculation, and export round trips. Also measure
first-tile latency, pan/zoom latency, peak memory, cancellation, corrupt-input
behaviour, source immutability, bounded cache behaviour, and visual parity
between the live viewport and high-resolution export. A rendered export records
the source fingerprint, source and working colour spaces, display adjustments,
crop/viewport, resolution, scale-bar settings, application version, and export
format.

Publication export is not a screenshot shortcut. It must render from source or
an appropriate pyramid level at an explicit output size, embed or identify the
output colour profile, avoid silently clipping high-bit-depth inputs, and make
any display-only transform reproducible. Raw scientific data export and a
rendered publication image are distinct choices.

## Conditional model-validation contract

Freeze model versions, hashes, preprocessing, physical resolution, thresholds,
output taxonomy, acceptance thresholds, and licensing evidence before opening
a test partition. Training data or tuned data are integration checks, not
external validation. Failure to pass keeps the model out of the product; it
does not weaken the acceptance gate.

- Reproduce source-domain checks on MoNuSeg for StarDist and CoNSeP for
  HoVer-Net without calling them independent validation.
- Use [CryoNuSeg](https://github.com/masih4/CryoNuSeg) as a frozen-section stress
  test.
- Use [NuInsSeg](https://zenodo.org/records/10518968) as a broad-organ stress
  test only after confirming whether the exact InstanSeg checkpoint used it.
Report AJI/AJI+, PQ with DQ/SQ, Dice, object and boundary F1, count error and
bias, per-class F1 where applicable, and WSI/patient-grouped uncertainty. Also
measure analysis latency, peak memory, cancellation, corrupt-input behaviour,
and source immutability.

Protected local H&E and matched multichannel 3D volumes may be used for internal
format, colour, navigation, and performance compatibility checks. They are not
ground truth and do not support an accuracy claim. No protected path, case name,
image, or derived preview enters the public repository without explicit review.

## Deferred decisions

- No thresholding, segmentation, cell classification, model comparison, or mask
  fusion UI in the first pathology workspace.
- No napari companion.
- No generic tumour/stroma or diagnostic classifier without an organ-specific
  taxonomy, a permissive checkpoint, and an independent test set.
- Remote inference belongs to the later 3D phase. Local remains the default.
  A future generic adapter may use the system SSH configuration and key agent,
  support Slurm or a direct worker, stage encrypted jobs into user-selected
  scratch space, verify versions and checksums, and clean up explicitly. It
  must never store a plaintext password or hard-code a particular cluster.

## Distribution boundary

OpenSlide is LGPL-2.1 and requires notices, source/relinking compliance, and a
distribution review. tifffile/imagecodecs are BSD-3-Clause subject to their
codec inventory; wsidicom is Apache-2.0. Do not bundle Bio-Formats
`formats-gpl`. libvips remains deferred unless profiling demonstrates a need
that justifies another native LGPL dependency graph.
