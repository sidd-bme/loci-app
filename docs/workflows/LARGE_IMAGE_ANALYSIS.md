# Large-image quantitative analysis (M6)

This workflow measures intensity-defined objects in one calibrated microscopy
plane. See [release status](../RELEASE_STATUS.md) for published artifacts and
remaining gates. Source support and synthetic fixtures do not qualify a changed
packaged app or a remote site.
This does not establish biological cell identity or segmentation accuracy. Use a
new study created by this version of Loci.
Existing studies are not upgraded in place.

## Supported input and workflow

Use a tiled OME-TIFF with uint8 or uint16 scalar samples and known physical XY
calibration. A multidimensional acquisition is supported as an input, but each
analysis uses one explicit channel, Z plane, time point and rectangle at native
resolution. RGB, projections, arbitrary preprocessing and quantitative 3D are
outside this route. Source files remain unchanged.

1. Open the image and check dimensions, calibration and channel declarations.
   Choose channel, Z and T, then **Whole image** or draw an analysis region.
   Display colours, contrast and gamma do not alter the analysis pixels.
2. In **Analyze**, select **Large image · threshold components**. Enter a threshold
   in raw source units. Bright foreground means strictly greater than threshold;
   dark means strictly less. Equality is background. Choose a minimum physical
   area and whether to exclude objects touching the outer region.
3. Check scope and disk estimate, then **Segment large image**. This route uses
   a 256 MiB numerical working allowance, independent of decoded label-grid size.
   It does not reserve RAM or include all interpreter/Electron/OS overhead.
   **Jobs → Cancel** cancels segmentation without publishing a partial result.
   Retry is an explicit new submission.
4. **Fit result** shows a bounded, labelled sampled overview. Zoom or locate an
   object to inspect native pixels; drag to pan, or focus the image and use arrow
   keys and +/−. The overview is display-only. Picks query exact label pixels;
   measurements use native raw samples.
5. Page through the table, select a row and inspect pixel count, physical area,
   centroid, raw intensity and nearest-centroid distance. **Inspect object pixels**
   finds a verified member pixel and opens its native region. For a concave object
   this can differ from the measured centroid, which remains unchanged.
6. **Remove object in new revision** removes the entire selected object, including
   portions outside the displayed region. Surviving IDs stay unchanged; dependent
   measurements including nearest-neighbour distance are recomputed. Undo/redo
   selects immutable revisions. Painting/split/merge are unsupported for this kind.
7. Review the chosen revision and **Export revision**. Export contains raw selected
   samples and exact labels as calibrated OME-TIFF/BigTIFF, CSV, the immutable
   object table, method/provenance records and hashes. The source-grid affine in
   `result.json` is authoritative for crop/world placement. TIFF spacing alone
   does not encode the original multidimensional selection.
8. **Save study** retains the full local revision history. Close/reopen the study,
   select the same revision and inspect the same object ID. Keep the unchanged
   source available. Export includes ancestor records but not ancestor numerical
   grids; it does not replace saving the study. Portable ZIP interchange does not
   yet support M6 result grids.

## Execution and recovery

The recorded policy thresholds nonoverlapping 512 × 512 native-pixel cores and
reconciles four-connected components over every shared horizontal/vertical edge.
Diagonal contact alone does not join objects. Global area/border filters follow
reconciliation. Initial IDs follow first retained pixels in row-major order;
corrections preserve gaps. No halo, image resampling or learned model is used.
Scope, calibration, software/runtime and effective label identity are recorded.

Bounds: 100,000 final objects, 1,000,000 provisional components, 16,384 cores,
65,536 pixels per edge and fewer than 2³² pixels. Highly fragmented input can
exceed the provisional bound even if components would later join. A refusal is
not permission to silently change threshold or resolution. Disk admission
includes temporary/result headroom.

After interruption, the last valid study remains and the lost job is marked
interrupted. No partial table is a ready result; retry explicitly. A hard stop can
retain private temporary files. Preserve the study/job identifier for diagnosis;
never treat a hidden export staging folder as a completed bundle.

## Remote adoption and cancellable export

Choose **Import remote result…** in the large-image analysis panel to verify
and adopt one remotely produced, uncorrected M6
`large-components` export bundle directory into an active local v2 study.
Native directory selection occurs via the main-process native picker; private
exchange grants bind the bundle to the verified local source without leaking
local host paths into renderer payloads or public job parameters.
Verification validates the manifest, checksums, no-symlink rules, exact pixel
match against the local raw source, object table invariants, reconstructed
measurements, selected-channel identity, exact TIFF dtype/calibration, consistent
recipe/runtime records, and streaming CSV correspondence before atomic publication
as a new root result. Repeated imports reverify the source and bundle and reuse
the existing root for that local source; identical bytes registered as a different
local source retain that source association. Only uncorrected root results are eligible for adoption;
remote claims are preserved while local review begins unreviewed.

Streamed large export executes as a durable task in the background worker
process, leaving the synchronous control worker responsive to UI and preview
interactions. Cancellation is checked at stage boundaries and immediately prior
to the final absent-destination rename. The final directory rename is the
atomic publication point. After a process interruption, an existing destination
is reported with completeness unverified. Its presence alone does not establish
integrity; do not overwrite it on retry.

### Controlled remote execution

Remote M6 adoption verifies an existing bundle; it does not submit a cluster job.
An administrator must prepare a compatible pinned Loci engine and dependencies,
transfer only an explicitly authorized source, and run the large-components job
with its declared scope/settings. Keep source hashes, code/runtime identities,
scheduler receipts, execution policy and export manifest with the result.
Scheduler host RAM is separate from the declared 256 MiB numerical allowance
and accelerator VRAM; this route does not establish whole-image Cellpose support.

Choose a private working directory on a filesystem supporting atomic no-replace
publication. If the filesystem lacks that operation, Loci must fail closed;
do not disable atomic publication to bypass the limitation. For temporary
compute-node storage, preserve completed studies and exports before storage
expires, and verify transfer hashes before local import.

Register the unchanged source locally, select **Import remote result…**, and choose
the complete export directory. Monitor or cancel verification in **Jobs**. After
adoption, inspect native objects, correct/review, export and save the local study
using the same steps above. Claims in a bundle are checked for consistency and
against source pixels; they are not cryptographic proof of which remote machine
executed the algorithm. Retain the separate scheduler/execution receipts.

Qualification requires numerical, interruption and packaged-workflow checks for
the exact candidate, followed by a formative external researcher pilot. Synthetic
fixtures and agent walkthroughs provide engineering evidence; they do not replace
that human pilot or establish biological or clinical validity.
