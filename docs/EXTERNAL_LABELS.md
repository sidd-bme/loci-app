# External-label adoption

This guide describes the implemented external-label adoption route. See
[release status](RELEASE_STATUS.md) for published artifacts and remaining gates.
Qualification requires checks on the exact source and packaged app being released.

## Profiles and researcher journey

Adopt one plain single-series, single-level, single-page scalar TIFF label image
onto one explicit full-resolution native YX source plane. The source must have
scalar samples and a native full level-0 grid, with explicit T/C/Z and no crop,
resampling. The `scalar-native-yx/v1` label TIFF must have YX axes, Orientation 1,
one sample per pixel, unsigned uint8/uint16/uint32 values and matching dimensions.
Reject RGB/palette, boolean/float/signed/64-bit labels, undeclared stacks, extra axes and
ambiguous layout. Zero means background; exact conversion to uint32 preserves
all positive IDs, including sparse IDs at the uint32 limit. An ID appearing in
disconnected regions remains one measured object. An empty label population is
valid and remains visibly empty.

The distinct `scalar-native-zyx/v1` profile adopts one scalar native T/C volume
with an explicit half-open level-zero Z range (`z`, `z_stop`, at least two
planes). Every plane must cover the complete source XY grid. The single-series,
single-level TIFF must declare exactly ZYX axes and shape
`[z_stop - z, height, width]`, with one uniform scalar YX page per Z plane.
The same unsigned types, unchanged IDs, Orientation 1 and resource defenses
apply. One label ID spanning or disconnected across planes is one 3D object;
its measurements include physical volume and raw selected-channel intensity.
The source supplies the volume geometry, including anisotropic voxel spacing
and the selected Z offset. Explicit external OME calibration must include all
ZYX spacing and match; partial/conflicting calibration or plane positions fail
closed. Missing external calibration remains unknown.

The native picker binds an input to the captured source fingerprint and plane.
A checked overlay preview shows label count, shape, original dtype, file name,
grid and measurement channel. **Import on this plane** explicitly declares
that label pixels correspond to that source's native grid. Shape agreement
alone does not prove image identity or alignment. There is no implicit
registration, axis transposition, label renumbering or interpolation.

For ZYX the legacy `image`, `preview_width` and `preview_height` describe only
the named middle XY plane, never a projection or proof of volumetric alignment.
The additive `preview` record binds `plane: "XY"`, local `index: depth // 2`,
absolute `source_z`, the complete single-plane source `selection` (without
`z_stop`), and `basis: "single-native-plane-overlay"`. The private grant's
integrity and retained import provenance include this record. The explicit
volume alignment declaration applies to all selected source Z planes.

The registered source supplies geometry and calibration. Missing external
calibration is unknown; supported explicit microscopic calibration must agree,
and unhandled or conflicting spatial metadata fails closed. Print DPI must not
be treated as microscope calibration. The importer records how external
metadata was handled. The initial measurement uses the explicitly selected raw
source channel; changes to display ranges/LUTs do not change measurements.

After adoption, select the unreviewed ordinary result and open Statistics &
objects. Table, chart, image picking and Locate retain original label IDs.
**Edit selected object** transfers the inspected label with its exact result
revision into the ordinary correction tool. No silent fallback to the first
object is allowed for an explicitly requested label. Correction creates a new
unreviewed child and recalculates measurements through the existing engine.
Parent arrays and source pixels remain unchanged. Existing review, export,
save/reopen and portable study interchange preserve the scientific record.

## Trust, publication and provenance

The trusted local RPC `research_labels_import_grant` accepts an explicitly
selected local path plus `source_id`, `source_sha256`, `selection` and
`working_bytes`. Its result is a renderer-safe preview with opaque `grant_id`;
the path stays in an internal `labels_import_grant` record. This record is
excluded from public snapshots and portable study archives. The renderer cannot
supply a file path through ordinary operation requests.

The shared durable task is `labels_import`. Its exact request fields are
`source_id`, `source_sha256`, `grant_id`, `alignment` (the literal
`same-native-yx-grid` for YX or `same-native-zyx-grid` for ZYX) and `producer`
(optional declared name/version). Alignment must match the checked grant profile.
All scientific input choices and budgets come from the checked grant. Unknown
request fields fail. Native-picker cancellation and preview failure publish no
result; editing the captured source/plane invalidates visible adoption state.

Recheck grant integrity, exact source and label input identities, grid and
channel-metadata snapshot before publication, including cancellation. Reopening,
correcting and exporting an adopted result uses its immutable canonical arrays,
so removal of the original external TIFF after successful adoption does not
invalidate those operations. Retry semantics follow ordinary durable jobs.

Record the input file fingerprint/size, original dtype/shape/axes, canonical
label-array fingerprint, value-preserving conversion, declared alignment,
source fingerprint/selection/geometry, measurement channel/basis, memory budget
and import/measurement runtime. An optional producer name/version is explicitly
user-declared. Upstream settings, model, runtime and validation remain unknown
unless the supported contract actually supplies them; Loci's import runtime is
not the external segmentation runtime. Preserve this information through child
corrections, methods text, scientific exports and portable study interchange.

Use existing source verification, TIFF segment bounds, resource limits and
atomic result publication. Bound input bytes, decoded pixels and combined
working arrays before expensive decoding/measurement. Respect the existing
100,000-object limit and result/export artifact limits. Do not infer granted
assistant access from successful import: the existing MCP policy remains intact.

## Required verification

The following checks are required for changes to this workflow. This list does
not record a passing run of the current public candidate.

- Independent expected labels and numerical measurements for sparse IDs,
  calibrated and pixel grids, raw selected-channel intensity, disconnected IDs
  and an empty population; exact input/parent preservation.
- Rejection of mismatched source/grid/calibration, unsupported types/layout,
  unsafe paths, changed inputs/grants, excessive resource claims and unexpected
  fields; no partial result after cancellation or publication failure.
- Preview/adoption identity and job idempotency; no private paths in public
  results, snapshots, jobs, exported methods or portable archives.
- Inspect, select and locate an original sparse ID beyond an initial table page;
  transfer it into correction, verify expected child measurements, undo/select
  parent, save/cold-reopen, review/export and independently read final artifacts.
- Relevant engine/desktop regressions and a registered packaged journey with
  synthetic authorized fixtures. Actual packaged UI inspection at representative
  widths/themes supplements numerical checks. These checks do not establish
  biological accuracy, competitor superiority or cross-platform qualification.
- ZYX numerical checks cover anisotropic spacing, nonzero source Z offsets,
  cross-plane sparse IDs, exact raw means and volumes, bounded strip/tile decoding
  with multiple codecs, and a pixel-exact named middle-plane preview. Negative
  checks cover depth/axes/calibration mismatches, later-page metadata and unsafe
  segment ranges, stale bindings, cancellation and prepublication mutations.
  Reopen, correction, export and portable interchange preserve canonical arrays
  and provenance without retaining the private input grant in public archives.
