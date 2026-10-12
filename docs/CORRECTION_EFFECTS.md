# Correction effects on an experiment

This guide describes the implemented correction-effect calculation. See
[release status](RELEASE_STATUS.md) for published artifacts and remaining gates.
Qualification requires checks on the exact source and packaged app being released.

## Compare the effect of a correction

From an immutable corrected-label revision, choose **Show experiment effect**.
Inspect its direct parent versus corrected child, explicitly choose the other
image revisions that supply experiment context, and calculate the effect on the
existing object-size endpoint. Follow the change through image means, declared
biological-replicate means and condition means. Save/reopen the exact comparison
and export a reviewed, independently inspectable report. Metadata changes require
recalculation, never segmentation reruns. No new compartment endpoint, statistical
test, biological accuracy claim or arbitrary rerun matching is part of this step.

## Paired scientific contract

The operation is `study_correction_effect`, separate from existing
`study_compare` v1, whose independent-side semantics remain unchanged. Request:
`{before_result_ids: [...], after_result_ids: [...], value: "measure"}`.
The two unique bounded lists must name the same source set, exactly one ordinary
v1 label result per source on each side. Each after revision must be either the
identical before revision (unchanged context image), or its direct
`corrected-labels` child. Require at least one real correction. Validate the
child's top-level parent, correction parent and parent revision hash, identical
source identity, selection, geometry, measurement basis and method identity.
Reject unrelated reruns, incomplete/forged lineage, mismatched grids, mixed
units/dimensions/methods, duplicate source assignments and unsupported large
result profiles. Child measurement rows are its recomputed rows, not its parent's.

Use existing calibrated `measure` (object area or volume), with units derived
from exact geometry even for an empty population. No silent conversion between
pixel and physical units. Validate finite positive object measures, unique
original IDs and count/array/measurement consistency. Source and immutable result
artifacts are verified, never changed. All array comparison and report work is
bounded by existing memory, object and JSON limits; reject oversized work before
large allocation. Check exact result/array, sample-document and review bindings
again before publishing a report or export.

For each source, retain the before/after object count, image mean, signed
count/mean differences, grouping metadata and explicit eligibility/omission
reasons. A zero-object image has no mean: `null`, never zero. If either side is
excluded or empty, omit the pair from BOTH sides of the paired effect estimate,
while retaining its descriptive row and reason. Unassigned biological replicate
IDs remain descriptive and contribute no independent biological n. Missing source
sample documents must be assigned explicitly; do not invent grouping.

Each eligible image receives equal weight within its declared biological
replicate. Each eligible replicate receives equal weight within its condition.
A replicate is keyed by study, condition and biological-replicate ID. Display
before and after means from the identical eligible pairs, signed differences,
image-pair counts, omitted counts and biological n. Object counts are descriptive,
not independent n; field/image counts are not biological n. Sample names alone
never define independence. No p-values, significance or causal/biological claims.

Explain the actual correction with its audit operations, changed voxel count,
added and removed label IDs, and retained IDs whose voxel membership changed.
Equal object counts must not imply unchanged objects. Retained IDs are edit
identifiers, not evidence of one-to-one biological correspondence; split/merge
operations make that ambiguity explicit. Do not invent cross-label matching.

## Receipt, review and export

Return and persist a canonical hashed `loci.study-correction-effect/v1` receipt
in the existing `comparison` document collection, with a strictly distinct schema
branch. Keep old run-comparison receipt validation intact. Record exact request,
before/after result/source/array identities, sample-document revisions/data,
review snapshots, endpoint/unit, pairing/weighting policy, image/replicate/
condition rows, correction audit, runtime and conservative interpretation.
Validate the complete structure, arithmetic and hash on portable import; importing
must not trust recomputed digests attached to forged values. Historical receipts
retain their captured grouping/reviews. Reproduce them from their exact bound
results and stored metadata, rather than silently substituting today's metadata.

Inspection is allowed before human review and must visibly say when revisions
need review. It does not approve any result. Reviewed export requires all
non-excluded bound revisions to be reviewed and current review/sample bindings
to match the receipt. A stale receipt stays an inspectable historical snapshot,
but export fails closed until the researcher recalculates it. No automatic review
or silent recalculation during export. Metadata-only edits recalculate aggregation
through a new receipt without creating or changing result arrays.

Native export uses a trusted destination picker, not a renderer path. Publish a
new report directory atomically and without overwriting existing destinations:
receipt JSON, image-pair CSV, biological-replicate CSV, condition CSV, methods
text and a hash manifest. Preserve signed numbers, undefined values, omissions,
unit and biological n. Include no private input paths or internal grants. CLI
must expose the same calculation and bounded trusted export path. Existing agent
policy permissions do not expand merely because this operation exists.

## Inspect the comparison

A selected correction child offers **Show experiment effect** in the Study
workflow. It begins with that direct-parent/child pair. Select other source
revisions explicitly; the comparison does not guess the latest segmentation.
The desktop comparison starts with one corrected image and selected unchanged
context images; the engine supports one or more validated direct-child pairs.

Display named before/after revisions, endpoint and weighting, a compact condition
comparison, biological-replicate rows and image contributions. Reveal correction
operations/IDs and hashes in details. Display means and differences to six
significant digits with signed scientific notation for small/large values; native
disclosures retain exact condition, replicate and image values. Object counts
remain exact integers. Receipt and export precision is unchanged. Keep
empty/excluded/unassigned rows legible.
Selection, project, review or metadata changes must invalidate in-flight responses
and stale export readiness. Restored reports must pass schema checks and remain
visibly distinct from generic run comparisons.

The desktop interface `ResearchDesktopApi.exportCorrectionEffect` takes
one receipt SHA-256 and returns the native export result (or cancellation).
Common execute request stays as specified above. Snapshot `comparisons` contains
`{request, receipt}` documents, with a distinct correction-effect receipt schema.

## CLI use

Save the exact `before_result_ids`, `after_result_ids` and `value` request above
in `request.json`, then use the same kernel as the desktop:

```sh
loci execute --project /absolute/study.loci-study study_correction_effect --request @request.json
loci export-correction-effect --project /absolute/study.loci-study --receipt-sha256 SHA256 --destination /absolute/new-report
```

The destination must not exist. Calculation can retain pending review for
inspection; export requires reviewed or excluded revisions and current captured
metadata/reviews. Recalculate explicitly after changing either.

## Required verification

The following checks are required for changes to this workflow. This list is an
acceptance requirement, not a receipt of a passing candidate run.

- Independent arithmetic: a replicate with image means `4,8` before and `10,8`
  after has change `3`; another unchanged replicate has change `0`; the equal-
  replicate condition change is `1.5`, regardless of unequal object/field counts.
- Real correction fixtures for delete, split, merge, boundary change and an
  equal-count/different-membership case; unchanged peers; empty and asymmetric
  exclusion; missing replicate IDs; incompatible units/scope/lineage rejection.
- Source/parent immutability and recomputed child measurements; exact receipt
  restoration; metadata-only recalculation; stale export rejection; forged
  imported receipt rejection; independent CSV/JSON/manifest/methods checking.
- Renderer tests for exact baseline choices, loading/error/no-child states,
  pending review, omissions, navigation and metadata races, restore and export.
- Full relevant source checks, a registered synthetic packaged journey, and
  actual app/capture inspection at ordinary and narrow desktop widths in dark
  and light themes. These are software checks, not biomedical validation.
