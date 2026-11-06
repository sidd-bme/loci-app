# Saved annotation agreement

Annotation agreement compares two explicitly selected immutable label results on
one exact level-zero YX grid. It describes agreement with a user-declared
reference. It does not establish biological ground truth, segmentation accuracy
against an independent holdout, clinical validity, or human approval.

## Exact inputs and semantics

Both inputs bind their saved result ID and revision hash, registered source
ID/SHA-256, complete C/Z/T and crop selection, array shape, axes, voxel-to-world
affine, world frame and unit. Equal dimensions alone do not establish alignment.
The operation never registers, resizes, resamples, clips or repairs an input.
Pixel units remain explicitly uncalibrated. Agreement scores are
dimensionless; pixel counts are sampled counts, not continuous polygon areas.

Labels are canonical `uint32`, zero denotes background, and original IDs remain
unchanged. The caller chooses one interpretation:

- `instances`: every unique positive ID is one instance, including disconnected
  pixels sharing that ID. Matching maximizes the number of pairs meeting the
  inclusive IoU threshold, then maximizes summed IoU. Equal optimal assignments
  carry no scientific distinction. Sorted input IDs provide stable solver input.
  Reports include counts, signed/absolute/relative count differences, TP/FP/FN,
  precision, recall, F1, summed/mean matched IoU, original-ID matches and unmatched
  IDs. Any-overlap split/merge counts are descriptive, separate from matching.
- `foreground-region`: every positive value belongs to the foreground union.
  Instance identities are discarded deliberately. Reports contain sampled
  foreground/intersection/union counts, IoU and Dice; there are no instance scores.

Instances additionally report foreground agreement. Undefined denominators yield
`null` with a specific reason; two empty masks are not reported as perfect
agreement. Instance thresholds must be 1-8 strictly increasing finite values in
`(0,1]`; region mode requires `[]`. Tissue model compartments may be compared as
regions; their connected regions cannot implicitly become biological instances.

The pure kernel bounds pixels, instance populations, dense pair matrices and
Python report allocations before matching. The project operation additionally
bounds retained arrays and metadata before decoding. It checks cancellation
between scans/thresholds, during hash/staging work and at atomic publication.

## Freezing drawn references

The shared candidate operation exposes only IDs and supported shape metadata
inside the selected result's exact crop and Z/T plane. It omits annotation labels,
vertices, other planes/crops and file paths. Pages contain at most 100 candidates.

Saving a drawn reference requires explicit selected annotation IDs, the current
source-annotation document revision, instance/region interpretation and a coverage
declaration. Only closed polygons and rectangles are supported. Every vertex must
lie inside the selected crop; a shape crossing its edge is refused. Source
coordinates are level-zero pixel edges; rasterization subtracts crop origin and
`0.5` before sampling pixel centers inside/on the polygon. This is an explicit
coordinate conversion, not a source-image transform. Polygons containing no
sampled center are refused. Instance polygons cannot overlap on sampled pixels;
region polygons form a union. Instance IDs follow sorted selected annotation IDs.

The immutable reference retains the selected vector snapshot, original source
geometry/dimensions, document revision, snapshot hash, sampled labels and exact
image/grid parent. Later source-annotation edits do not replace that historical
reference. Saving another reference requires the new current document revision.
Neither drawing nor declaring a reference creates a human review event.

The raw annotation frame and exact planar source frame are retained separately.
Native uncalibrated plane geometry intentionally does not translate world Z by a
selected slice index; raw multiz annotation history retains its Z index. Freezing
preserves both frames and the explicit slice identity. Cold validation reconstructs
native mappings from registered level metadata using the native reader's pure
geometry rules, without decoding the source or inventing physical Z spacing.

## Shared engine and agent interface

The native/shared operation names and request bodies are:

```text
annotation_reference_candidates({result_id, revision_hash, offset?, limit?})
annotation_reference_run({
  result_id, revision_hash, source_annotations_revision, annotation_ids,
  semantics, coverage_declaration, working_bytes
})
annotation_evaluation_run({
  result_id, revision_hash,
  reference: {result_id, revision_hash},
  semantics, iou_thresholds, reference_declaration, working_bytes
})
annotation_evaluation_get({
  result_id, revision_hash,
  table?, threshold_index?, offset?, limit?
})
```

`table` defaults to `summary`. Instance table names are `matches`,
`unmatched_reference` and `unmatched_prediction`; their pages contain at most 100
rows. `threshold_index` is zero-based. Match rows retain original reference and
prediction IDs, intersection/union counts and IoU. Summary queries omit large
match tables, replacing each table with its row count.

Agents use the existing action guide/validation, durable submit, job status,
inspection and result/review/export tools. A granted source alone does not grant
new task operations, private file import or another session's jobs. Both input
results and all dependencies need source/selection/channel authority. Reference
candidate inspection and freezing also require authority over the selected raw
annotation snapshot. Already adopted imported labels can serve as references
under the existing explicit granted-source result scope; original private import
grants are not disclosed or replayed.

## Persistence, recovery and integration hooks

Agreement results have kind `annotation-agreement`, provenance key
`annotation_evaluation`, exact `parent_result`/`reference_result` dependencies and
retained `image`, `labels`, `reference_labels`. Frozen references have kind
`annotation-reference`, provenance key `annotation_reference`, an exact
`parent_result`, and retained `image`/`labels`. Generic label correction or ROI
editing of either derivative must be refused; edit underlying inputs and create a
new saved reference/comparison.

`research_annotation_evaluation.py` provides:

```text
validate_request(workbench, request, *, check=None)
execute_annotation_evaluation(workbench, request, *, job_id=None, publication_guard=None)
validate_reference_request(workbench, request, *, check=None)
execute_annotation_reference(workbench, request, *, job_id=None, publication_guard=None)
reference_candidates(workbench, request, *, check=None)
report_get(workbench, request, *, check=None)
public_summary(result)
validate_record(result)
validate_source(result, source)
validate_parents(result, results_by_id)
project_parents(project, result, *, check=None)
validate_arrays(result, arrays, parents=None, *, check=None, working_bytes=None)
validate_project_arrays(project, result, *, arrays=None, check=None, working_bytes=None)
```

Metadata validation is pure. `validate_arrays` verifies canonical NPY hashes and
recomputes agreement or frozen polygon rasterization. It can validate portable
arrays before a destination project exists. `project_parents` reads bounded,
hash-checked parent records directly to avoid recursive forged derivative cycles.
Cold result validation does not decode source images or consult mutable annotation
history. New execution verifies current source bytes, calibration and selection,
then rechecks inputs, runtime, source identity, policy/cancellation and any current
annotation revision at publication. Export retains exact input dependencies,
arrays and explicit scientific report, and remains subject to the existing exact
revision review requirement. Agent review is not human scientific approval.

Focused fixtures cover sparse/high IDs, disconnected identity, cardinality-first
matching, inclusive thresholds, empty denominators, instance/region semantics,
source/plane/grid mismatches, rehashed metric tampering, retained-array tampering,
cancellation, source-edge conversion, frozen history and overlap rejection. These
are engineering checks. No frozen scientific evaluation is reopened.
