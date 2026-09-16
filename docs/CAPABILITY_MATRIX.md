# Loci capability matrix

**Current source update:** 8 September 2026, image-first implementation.

This matrix describes implemented subsets, not biological validation or public
release clearance. Current verification and exact source/package identities are
recorded in [PROJECT_STATE.md](PROJECT_STATE.md) and
[project state](PROJECT_STATE.md). The prior packaged baseline
`9e9dc6cf31ce128990e6d065e793dee51e8d077f` verifies its historical tree only;
it does not qualify the image-first changes.

`Implemented` identifies a code route and interface. `Bounded` identifies finite
reads, memory, grids or supported variants. Source tests, actual packaged GUI
journeys and external qualifications remain separate evidence categories.

## Source and pixel contracts

| Source route | Concrete accepted subset | Axes, samples and dtype | Codec and resource boundary | Explicit refusals or limits |
| --- | --- | --- | --- | --- |
| PNG and JPEG | One local regular, non-symlink file; one frame | Scalar `YX` or interleaved `YXS`; Pillow modes `1`, `L`, `I`, `F`, `I;16*`, `RGB`, or `RGBA`, resolving to bool, uint8, int32, float32, uint16, or uint8 RGB(A) | Pillow decode; the ordinary-image route budgets the complete decode plus the selected output. Native read default 64 MiB, maximum 512 MiB; viewer requests use bounded tiles up to 2,048 pixels per edge, not a navigation boundary | Animated or multiframe files and palette/CMYK or other modes without a lossless native layout are refused. RGB samples are display samples, not biological channels |
| TIFF, BigTIFF and OME-TIFF | One explicitly selected series; stripped or tiled planes; declared pyramid levels | Unique axes drawn from `T,C,Z,Y,X,S`, with X and Y required. `S` is allowed only for 3- or 4-sample RGB(A); scalar operations use canonical `YX` or `ZYX`. Boolean, signed/unsigned integer through 32 bits, and float through 64 bits | Memory-mapped reads where safe, otherwise bounded segment decode. Uncompressed and Deflate/GZIP are covered by native-reader tests; LZW is covered by the accepted frozen-worker baseline. A decoded tile/strip is capped at 64 MiB; a native request is capped at 512 MiB | TIFF orientation other than 1, companion-file pixels, missing or ambiguous planes, non-real values, unsupported photometric modes, inconsistent pyramid T/C/S, and non-finite float selections are refused. Other codecs are not claimed merely because the installed decoder may recognize them |
| Imaris IMS, HDF5 5.5+ layout | One content-detected file with the documented `DataSet/ResolutionLevel N/TimePoint N/Channel N/Data` hierarchy | Native `TCZYX`; arbitrary explicit T, C, Z and pyramid-level selection in the research workbench; scalar channel dtypes follow the native real-number limits above | HDF5 hyperslab reads with no raw chunk cache; a decoded chunk is capped at 64 MiB and the selected native request at 512 MiB | External/virtual HDF5 storage, links, malformed or discontinuous groups, legacy non-HDF5 IMS, and inconsistent per-level/channel layouts are refused. The unified shell uses native planes and full-extent overviews; the legacy adapter is a compatibility path |
| OME-Zarr | Local, non-symlink directory; OME-NGFF 0.4 on Zarr v2; explicit image group and multiscale index when ambiguous | Accepted source layouts: `YX`, `ZYX`, `CYX`, `CZYX`, `TYX`, `TZYX`, `TCYX`, `TCZYX`; canonical `TCZYX`. Numeric scalar boolean, integer, or float through 64 bits | Zarr v2 C/F chunk order, `.` or `/` chunk keys, and compressors `null`, Blosc, zlib 0-9, or gzip 0-9. Default plane budget 64 MiB, maximum 512 MiB; decoded chunk 256 MiB; encoded file 512 MiB; JSON 1 MiB; 250,000 entries; 32 levels; 16 TiB encoded store | OME-NGFF 0.5/Zarr v3, filters, sharding, remote/zip/object stores, custom axes, affine/nonlinear transforms, label images, OMERO rendering, interleaved RGB, and an uninitialized chunk with null fill are refused |
| Aperio SVS and Hamamatsu NDPI | Content-detected, single-file OpenSlide sources with suffix/vendor agreement | Read-only `YXS` uint8 source-device RGB; selected pyramid level and level-0 XY region coordinates | OpenSlide 4.0.1 through `openslide-python` 1.4.6 in the recorded source contract; decoded cache configurable from 1 KiB to 512 MiB; selected request maximum 512 MiB | Other OpenSlide vendors, multi-file slides, DICOM WSI, fluorescence channels, malformed pyramids/calibration/ICC, and regions outside the level-0 extent are refused |
| CZI, ND2 and LIF conversion | One standalone local vendor file plus exact official Bio-Formats 8.5.0 JAR and an explicit Java executable; one explicit series/C/Z/T and optional crop | One scalar `YX` plane. Accepted reported values are int8/uint8/int16/uint16/int32/uint32/float32/float64. Multi-sample RGB channels are refused | Produces a tiled Zlib OME-TIFF plus a hash-bound provenance receipt, then imports that derived file. Decode cap 512 MiB; output cap 1 GiB; Java heap 256-4,096 MiB; timeout 1-1,800 s; captured stdout/stderr 16 MiB each | No bundled/downloaded Java, Bio-Formats, reader, or model; no whole vendor volume, projection, channel merge, normalization, or silent first-series choice. Pixel comparison is relative to the exact pinned Bio-Formats reader, not independent vendor truth |
| NIfTI | Contained `.nii` or `.nii.gz`; one real scalar 2D or 3D image; declared spatial units and at least one coded qform/sform | `YX` or `ZYX`; explicit LPS/RAS affine with metre, millimetre or micron header units normalized to millimetres; uint/int through 64 bits and float32/64, finite values only | SimpleITK. Default decoded budget 512 MiB, explicit maximum 8 GiB. A compressed source is budgeted as an eager whole-source decode; an uncompressed source can use a bounded region | Unknown/reserved spatial units, uncoded or invalid anatomical transforms, paired Analyze/NIfTI sidecars, vector/RGB/multicomponent data, dimensions outside 2D/3D, singular/non-finite geometry, and non-real values are refused |
| NRRD | `.nrrd`, or `.nhdr` with one contained relative data file; import requires a 3D volume, explicit LPS/RAS space and millimetre units | Scalar `ZYX`; real integer through 64 bits or float32/64 | SimpleITK; 1 MiB header cap; the same 512 MiB default and 8 GiB maximum decode budget. Compressed encodings are budgeted as eager whole-source decodes | LIST/pattern data, absolute or parent-traversing sidecars, missing spatial units, vector data, and non-3D medical imports are refused |
| DICOM image series | Explicit selection of 2-4,096 conventional single-frame CT Image Storage or MR Image Storage files from one series | Scalar `ZYX` float64 after one consistent rescale; `MONOCHROME1` or `MONOCHROME2`; LPS millimetre geometry | SimpleITK/GDCM; the complete series is decoded and budgeted before a crop, with the same 512 MiB default and 8 GiB maximum | Enhanced/multiframe, SEG/RT, diffusion, ultrasound, RGB/vector, mixed series/frame/modality/SOP/shape/orientation/spacing/rescale, irregular spacing, tilted/laterally shifted stacks, and recursive discovery are refused. Loci makes no de-identification claim |

These limits are safety and working-memory bounds, not performance
recommendations. The common quantitative layer accepts finite real scalar
`YX` or `ZYX` arrays, uses float64 processing, limits one recipe to 32 steps,
and defaults to a 512 MiB operation budget. Some lower-level APIs allow an
explicit budget up to 8 GiB; the desktop recipe route remains capped at
512 MiB on the current development profile.

## Unified viewing and document contract

- Direct opening creates an owned, recoverable local study only after a source
  selection. Save as snapshots derived state without copying originals. Legacy
  `.loci-project` import verifies immutable working-result packs. Missing or
  unsafe locations remain recoverable; discard affects only an owned managed
  session and supports undo.
- Fit covers the full source extent. Pan/zoom uses automatic pyramid selection,
  a full-extent overview (up to 1,024 pixels per edge) and bounded native tiles.
  A tile is at most 2,048 pixels per edge; 256 MiB bounds aggregate viewer
  working estimates and the derived overview disk cache. The source remains
  accessible beyond any one displayed tile. A dedicated worker/queue coalesces
  reads and rejects stale source/display responses.
- Image-list order is saved as source identities in study workspace state and
  survives refresh and Save as/reopen. Batch channel colors support selected or
  all loaded images, an explicit name/index mapping, non-mutating preview and
  revision-checked apply/undo. They change display state only.
- A/B viewing keeps source-bound T/Z, channels and cameras separate. Display
  matching is temporary; camera linking requires the same source identity and
  pixel grid. Each pane has an independent bounded request-scheduling lane.
- Scalar display uses trustworthy acquisition settings or disclosed defaults.
  Explicit Auto samples a stable full-source basis; navigation never changes
  its range. Interleaved RGB uses an explicit sRGB display policy, applying a
  valid embedded ICC profile once to a display copy. IMS RGB-plane mapping is
  an explicit reversible declaration; three channels alone do not imply RGB.
- Raw volume/MPR uses vtk.js with one to four selected scalar channels, a
  whole-volume context and explicit finer focus, physical geometry,
  orbit/pan/zoom/reset, transfers and clipping. Four-pane mode adds linked
  physical-coordinate slices and per-pane expand/restore. Patient-coordinate
  sources use axial/sagittal/coronal labels; acquisition-only sources use
  XY/XZ/YZ. These resliced display samples are not native measurements. The
  fourth pane switches between volume and intersecting planes; PNG export
  captures the 3D pane and records shading/display state. It requires at least two Z
  planes and orthogonal, unsheared voxel geometry. Interleaved RGB(A) and
  unsupported graphics fail visibly. Each request is capped at a 256-voxel
  target edge and 128 MiB aggregate memory estimate including rendering copies.
  Context/focus allocations share that budget. These are algorithmic bounds;
  measured process/GPU memory is recorded separately in qualification evidence.
- Surface is a separate display-only isosurface from an explicit source Z range
  or exact three-dimensional result; label surfaces require an exact segmented
  result. Its scalar grid needs at least two samples on every axis. The display
  edge is 8-96, the declared working budget is 1-512 MiB, and the mesh is
  capped at 20,000 faces after bounded coarsening. Constant data, an out-of-range
  display level and a still-too-complex mesh are refused. A surface is not an adopted
  result, quantitative surface measurement or new segmentation.
- Raw source annotations store pixel-edge coordinates with source hash,
  geometry and T/Z binding. They can be imported/exported independently of a
  segmentation. Current-display PNG export embeds rendering provenance: a
  full-extent sampled overview or a bounded region at its declared pixel grid.
  TIFF16 additionally streams the full level-zero plane or an explicit region
  through 256-pixel tiles with fixed display settings, source re-verification and
  atomic no-overwrite publication. Its 64 GiB output guard and free-space
  preflight do not imply that such a file is fast to produce. Both rendered
  formats exclude annotations and differ from original-value scientific export.
- The existing 2D adaptive watershed remains available with its original eight
  settings. Its normalized algorithm measurements and raw/physical result
  measurements retain their different meanings. Genuine 3D analysis uses the
  separately declared volumetric recipe; it is never a projected cell count.
- A batch freezes all selected source/settings requests before execution.
  Stop leaves pending items durable; Resume continues them and Retry requires
  an explicit action for failed/cancelled items. Selected reviewed results can
  export per-image bundles, a formula-safe image/count summary, or both, with
  identity checks, mirrored relative folders and a final aggregate manifest.

## What each source can do in the unified workspace

| Source route | Inspect | View | Process or segment | Learned route | Correct and measure | Reviewed export |
| --- | --- | --- | --- | --- | --- | --- |
| PNG/JPEG scalar | Exact file hash, shape, dtype, calibration when declared | Full-extent fit and bounded native tiles; saved display independent of analysis | 2D classical recipe, puncta and descriptive colocalisation | Managed ONNX 2D when the exact channel/scale contract matches; explicitly provisioned Cellpose on a selected 2D plane | On adopted labels: immutable 2D correction and calibrated-or-pixel object/ROI measurement | OME-TIFF/NPY arrays, CSV, methods and manifest; annotations when present |
| PNG/JPEG RGB | Exact file hash and RGB(A) sample semantics | Full-extent RGB display and native tiles; no biological-channel inference | Explicit RGB-derived intensity conversion for classical analysis on uint8/uint16 opaque RGB(A); separate declared H&E/H-DAB separation on uint8 RGB | ONNX rejects RGB components as biological channels. Provisioned Cellpose accepts supported interleaved RGB on an explicit 2D plane | Raw annotations before analysis; derived label correction and RGB-derived or declared stain measurements after analysis | Same research-result package after exact-revision review |
| TIFF/BigTIFF/OME-TIFF scalar | Series, axes, T/C/Z, levels, channel names/dtypes, timing and calibration where present | Full extent and automatic levels; explicit T/C/Z; 1-16 display mappings; max/mean projection; raw volume/MPR and separate bounded display surface | 2D or true 3D classical processing/segmentation; puncta, association, colocalisation, crop/resample and registration | Managed ONNX or provisioned Cellpose on one explicit 2D selection under its own contract | 2D/3D label correction, raw-channel object/ROI measurements and temporal tracking from exact result revisions | OME-TIFF/BigTIFF as required, NPY, CSV, methods, annotations and trajectories |
| IMS scalar | Native research inspection of T/C/Z, levels, names, dtype, timing and physical extents when valid | Same full-extent plane, projection and raw-volume/MPR routes as scalar TIFF; explicit RGB-plane display mapping when declared | Same bounded scalar 2D/3D operations | Same 2D scalar model restrictions | Same result-bound correction and measurement restrictions | Derived outputs only; no write-back to IMS |
| OME-Zarr scalar | Strict tree-content receipt, axes, levels, transforms, channels and codec metadata | Explicit group/multiscale; automatic display level and T/C/Z navigation; projection and raw volume/MPR | Same bounded scalar 2D/3D operations | Same 2D scalar model restrictions | Same result-bound correction and measurement restrictions | Derived outputs only; no OME-Zarr writer in this release |
| SVS/NDPI | Full source hash, vendor, pyramid, MPP and ICC state | Full-extent fit, automatic pyramid transitions and native tiles in level-0 coordinates; stale responses rejected; ICC-transformed copy is display-only | Declared H&E/H-DAB separation, tissue mask and polygon-region analysis on decoded source RGB | No research ONNX mapping from RGB samples; no slide-wide learned inference | Region/object measurements retain source level, downsample and level-0 extent; project correction applies only to an adopted bounded label result | Bounded derived result package and pixel- or calibrated-physical GeoJSON; no whole-slide rewrite |
| Converted CZI/ND2/LIF plane | Vendor source, exact reader/JAR/Java identities and series metadata before conversion; derived OME-TIFF inspected again | The imported scalar OME-TIFF behaves as one YX source | Same 2D scalar operations on the derived plane | Eligible only under a separate exact model/domain/scale decision | Same result-bound 2D correction and measurement | Derived-result package records the source-conversion receipt; raw vendor bytes are not copied |
| NIfTI/NRRD scalar | Exact ordered source identity, dtype, finite geometry and runtime | Full-extent XY fit, bounded native pixels, max/mean Z projection, raw volume/MPR and separate display surface | 2D selection or 3D classical operations, registration and physical-grid resampling | Managed ONNX only on an explicit 2D scalar selection with a compatible or explicitly overridden scale contract | 2D/3D label correction and mm-based measurements on adopted results | 3D LPS/RAS image and labels as `.nii.gz`, plus NPY/CSV/methods/manifest; embedded `.nrrd` is available through the engine export API |
| Conventional CT/MR DICOM series | Path-redacted series facts, ordered manifest identity and LPS geometry | Full-extent plane/projection and raw volume/MPR after the budgeted full-series decode | Same scalar processing, segmentation, registration and resampling; no clinical preset or diagnosis | Same explicit 2D ONNX restriction; no DICOM-specific model claim | Result-bound correction and mm-based measurement | Derived NIfTI package; no DICOM export and no de-identification claim |

The research workbench does not silently promote a raw source into a result.
Processing, segmentation, registration, model adoption, correction, annotation
import, tracking, and remote attachment create immutable derived revisions.
Raw annotation records are independent source-bound derived state. Label
corrections and result ROI measurements operate on an exact adopted revision.
Scientific result export requires an exact-revision human review receipt and
rechecks source, reference, result and artifact identities before atomic
publication.

## Learned analysis routes

| Route | Current contract | Restrictions and qualification state |
| --- | --- | --- |
| Managed ONNX research package | Native `loci-model.json` or a narrow BioImage.IO 0.5 adapter; one static float32 `BCYX` input and output, batch 1, semantic 2D probability on the same grid, declared channels/scale, halo-cropped tiling, embedded hashed reference tensors; CPU ONNX Runtime only | Local plain-file package, no URLs, external ONNX data, Python/pickle, control flow, dynamic spatial shapes, arbitrary preprocessing, implicit resampling or silent scale substitution. Package maximum 1 GiB, model 512 MiB, reference file 256 MiB, 64 files, 64M tensor elements, 20,000 graph nodes, working budget 1 MiB-8 GiB. Technical compatibility, scientific validation and usage rights remain separate. The public Zenodo package evidence is exact-artifact compatibility, not biological validation |
| Cellpose-SAM interoperability | Cellpose 4.2.1.1 with one exact, separately provisioned `cpsam` or `cpsam_v2` checkpoint; explicit 2D selection in the unified workspace and an explicit CPU/CUDA task in the remote workflow | No bundled or silent checkpoint download. The remote route accepts one selected 2D plane from a registered plain file and requires the exact managed checkpoint on the remote runtime. MPS is local only; remote is CPU/CUDA. Fallback must be authorized and recorded. Commercial use remains on hold pending written training-lineage clarification. Output is review-required and unvalidated |

The native-manifest and BioImage.IO descriptions share the same ONNX runtime
route; they are two package-description paths, not two independent inference
engines. The materially different learned runtime routes are managed ONNX and
Cellpose. The unseen-package test exercises technical adapter generality. Historical
package checks of public ONNX and Cellpose artifacts retain their identified
build scope; current reruns belong in the qualification record. None establishes
biological accuracy or supplies missing model/training-data rights.

## Correction, measurement and interchange limits

- Label arrays are non-negative integers and persisted as `uint32`; zero is
  background. Correction supports brush paint/erase, polygon add/replace,
  merge, delete and 2D/3D watershed split. One call accepts 1-64 operations,
  polygons up to 4,096 points, strokes up to 1,024 points and up to 32 seeds.
- Measurements use the exact source or registered-derived scalar values on the
  result grid. Physical units are reported only from a declared calibration;
  otherwise results remain in pixels. No stain, fluorophore, phenotype,
  interaction, viability, diagnosis or accuracy is inferred.
- Manual epidermal thickness stores two-endpoint transects on one native T/Z
  plane, physical calibration when available, per-transect boundary/orientation/
  exclusion rules and reviewer state. CSV preserves that saved protocol. Ridge-base
  and suprapapillary classes remain distinct; there is no automatic epidermis
  segmentation or claim that a drawn transect is a validated minimum/maximum.
- The fluorescence field assay measures unthresholded target-channel signal in
  a reviewed native-plane ROI, explicit background and reviewed nuclei counts.
  Preview/QC and an explicit reviewed result route retain source/plane/settings
  provenance. The IL4R use case is a field-level signal-per-nucleus proxy; it
  does not delineate individual cell membranes, establish specificity, assign
  biological replicates or compute a validated knockdown percentage.
- GeoJSON uses Loci's explicitly non-geographical voxel/world profile. ImageJ
  import accepts only a Loci-authored, identity-bound single-plane XY polygon.
  Annotation import accepts at most 1,000 polygons and creates a new unreviewed
  result revision.
- Study interchange copies project records and content-addressed derived NPY
  arrays, but never raw images, source locators, managed model packages, remote
  credentials or active execution state. Imported sources are `relink-required`
  until an exact local file, store or series matches the recorded identity.
- Saved study comparisons bind exact result/source/review/metadata identities,
  preserve exclusions and use biological-replicate means. The current UI
  compares area/volume (`measure`) only, within compatible source selections,
  geometry, methods, units and study scope; it supplies no p-values. Immutable
  comparison receipts survive portable import and can be inspected before raw
  sources are relinked. Object counts and intensities are not silently reported
  under an area unit.
- A research export contains exact NPY arrays; derived OME-TIFF or NIfTI when
  applicable; object, puncta, association, ROI or trajectory records; executed
  methods; result/review receipts; and an integrity manifest. It never includes
  the raw source.

## Known unsupported variants

The current contract does not include arbitrary vendor-reader installation,
OME-NGFF 0.5/Zarr v3, DICOM WSI or enhanced/multiframe/SEG/RT/diffusion series,
whole-slide learned inference, slide-wide publication rendering, full vendor
volumes, arbitrary external ImageJ ROIs, RGB components as biological channels,
model-provided executable code, nonlinear/deformable registration, stitching,
deconvolution, filament tracing, biological lineage inference, or in-product
model training/adaptation. See the format-specific documents for narrower
refusals, the [release contract](RELEASE_CONTRACT.md) for the adopted method set,
and [project state](PROJECT_STATE.md) for acceptance evidence and remaining
independent qualifications.
