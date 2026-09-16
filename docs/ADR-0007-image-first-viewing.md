# ADR 0007: image-first documents and bounded rendering

Accepted for implementation, 8 September 2026. Supersedes ADR 0006's temporary
separate cell/research entrances. Qualification is recorded in
[PROJECT_STATE.md](PROJECT_STATE.md), against [I1–I11](RELEASE_CONTRACT.md).

One shell opens images before asking for a study name or location. The native
process creates an owned `.loci-study` session only after a non-cancelled source
selection. Its private registry retains recovery and saved locations. Save as
uses a SQLite snapshot and verified derived-artifact/model copies; originals
remain external. Missing or unsafe locations produce recoverable states.
Discard moves only an owned managed session aside and retains an undo receipt.
Legacy `.loci-project` imports verify working-result packs and preserve exact
labels, corrections and original provenance through an explicit adapter.
The drop boundary classifies one fully checked plain local item as an image,
ordinary image folder, OME-Zarr store, `.loci-study` directory or legacy
project. Multi-item drops accept supported image files only and validate the
whole set before study creation or import. Ordinary folders retain the bounded
recursive collector and require the explicit DICOM route when DICOM is found.
Document switching drains source-display writes and view work before adopting
the new study. Source decoding pauses with its last valid frame and camera
retained, invalidates pending responses, and resumes after a cancelled switch.
Cancelling or rejecting a drop preserves the current document.
The pause is committed before entering a native dialog. Working-list changes,
batch preparation/export and vendor import use the same pause and display-write
drain while retaining the current camera and local undo state. Running analysis
jobs keep the independent view worker available.

Separate three concepts: camera in level-zero pixel-edge coordinates; bounded
decode tiles or volume payloads; declared analysis selection. Fit covers the
whole image. Automatic levels follow source spacing and physical display-pixel
density. The 1:1 readout means one source X pixel per physical display pixel;
calibrated Y spacing preserves aspect. Pan/zoom cannot redefine an analysis ROI.
Unpyramided sources use bounded deterministic overviews and native tiles.

The renderer keeps source/hash/C/Z/T/projection/display-scoped caches and drops
stale responses. PNG responses, disk caches, decode intermediates and worker
transport have independent bounds. A dedicated view worker serializes native
reads, with one pending request for each of five known view operations. New
requests replace only their own operation's pending request, so source tiles
cannot starve an exact result plane. Cancelling a view never terminates a durable
analysis or publication. Source display writes use optimistic revisions and a
serial drain before document switching; a study copy restores even identical
source IDs from its own records.

Respect validated acquisition colours, ranges, opacity and gamma. Unknown scalar
display falls back explicitly; three scientific channels do not imply RGB.
Interleaved RGB follows the declared colour policy, with embedded ICC applied
once to an sRGB display copy. Raw quantitative values remain unchanged. Explicit
Auto samples a documented full-source basis, independent of the viewport.
Reversible RGB plane mapping is a display declaration only.
Classical analysis of interleaved RGB requires an explicit, recorded conversion
to normalized display-value intensity. Derived intensities retain their own
array and measurement identity; raw-channel marker gates are unavailable for
this route. Declared stain separation remains a separate analysis choice.

vtk.js 36.12.0 supplies hardware volume and MPR rendering under BSD-3-Clause.
The worker sends identity-bound, hash-checked voxels with explicit sampling,
source extent, affine, units and aggregate memory estimates. Whole context and
focus are separate views to avoid double opacity in overlapping actors. Finer
display must retain exact geometry and source binding. Oversized requests,
unsupported graphics and context loss are visible failures, never invented
depth. Surface previews remain separate from raw-volume rendering.

Raw vector annotations use level-zero pixel edges plus exact source hash,
geometry and T/Z binding. Changes and interchange are revision checked and
undoable. Workspace close and clear operations are optimistic-revision changes
to visibility records: they retain the source and result records, expose exact
reopen/restore controls, and offer a one-step inverse only while no later
visibility revision has intervened.

Rendered export has two explicit display-data formats. PNG is bounded to a
sampled whole-image overview or a source-grid region. TIFF16 streams bounded
full-resolution tiles for a whole selected plane or region, enforces a 64 GiB
output estimate and disk headroom, and publishes by no-replace rename after the
source identity and staged TIFF provenance are rechecked. Both carry display and
sampling provenance, exclude annotations, and remain distinct from
original-value result export. Portable study archives retain derived state
while withholding private source locators.

The established adaptive 2D route resolves the built-in `loci-classical`
profile and its recommended `SegmentationSettings`: auto image mode and
polarity, 34 px expected diameter, 80 px minimum area, zero sensitivity,
1.2 px smoothing, split-touching enabled and border exclusion disabled. The
engine records any edits to those defaults, its 1st/99th-percentile
normalization, input mapping, measurement basis, source grid, runtime and
unvalidated-research status. It rejects 3D selections and does not infer a cell
type or assay-appropriate parameters.

Study batches freeze each selected source ID and SHA-256 with the exact recipe,
profile settings, measurement channels and selection. Every job is durably
submitted before the first execution. Stop cancels the active item and leaves
later jobs queued; resume continues queued work and explicitly resubmits
interrupted work; failed or cancelled work requires explicit retry. Successful
requests are not duplicated. Selected batch export rechecks every exact result
revision as reviewed, preflights all normalized mirrored target names, and then
uses the ordinary reviewed-result exporter for each bundle. An optional
formula-safe count CSV precedes the aggregate manifest commit marker.
The engine batch plan is authoritative for each portable ASCII bundle basename:
it removes the source extension (including `.nii.gz` as one extension), bounds
the name to 80 characters while retaining `_loci`, and rejects collisions after
normalization within a mirrored parent. Publication uses that exact planned name
and requires the reviewed-result receipt to confirm it.
Summary-only mode publishes only that CSV and manifest, with no per-image
artifacts. Published `_loci` markers prevent later folder discovery from
re-importing result bundles as raw sources.

No model, runtime, remote service or data download is triggered by opening an
image. Existing model trust, source grants, memory limits, review-bound export
and atomic publication remain authoritative. The I journeys must verify these
boundaries in the actual packaged application.


## Native histograms, rendered figures, and offline guidance

Display histograms use deterministic bounded native samples tied to source
identity and selected T/Z, independently of the camera and analysis region.
RGB distributions describe stored components before display ICC conversion;
scalar distributions retain native units. Volume distributions use the verified
whole-context payload and retain that basis during focus changes. Explicit
percentile trimming changes the transfer range only; constant samples do not
create an artificial percentile window. Window/Level is an alternate expression
of scalar low/high display limits, without inferred diagnostic presets.

Rendered PNG8 and tiled TIFF16 exports record display, crop/sampling, source hash,
software and output DPI. Optional channel legends and geometry-gated physical
scale bars occupy a bounded footer outside the source raster. DPI does not add
source detail. Raw-volume figures capture the native canvas, with an exact
camera/transfer/clipping/MPR/payload manifest; source state and capture state are
rechecked before publication. The two figure artifacts form one atomically
published `.loci-figure` directory with no-overwrite semantics.

Settings persist interface theme, text size, motion, viewer aids and figure DPI.
The six palettes never tint scientific pixels. `docs/USING_LOCI.md` is also the
bundled, searchable offline manual, so manual edits affect the packaged renderer
and require a new package identity. Its renderer emits text and JSX, never raw
HTML; external navigation is limited to the repository documentation links.
