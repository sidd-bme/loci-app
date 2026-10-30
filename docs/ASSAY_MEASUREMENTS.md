# Shape, wound closure and migration measurements

These source workflows retain exact input revisions, arrays, calibration and
measurement definitions. Engineering checks establish reproducible execution;
they do not establish segmentation accuracy or biological validity. Review the
input masks and acquisition declarations before interpreting the endpoints.

## Nuclear and cell shape

**Nuclear & cell shape** adds a `morphometrics` derivative to an exact saved 2D
or 3D object-label result. The shared `morphometrics_run` operation takes
`result_id`, `revision_hash` and `working_bytes`, executes as a durable job and
preserves the original image, labels and raw-intensity measurements. It also
has a typed `objects: label-result` input in composed workflows.

All samples with one positive label form one object; disconnected pieces are
not silently relabeled. Geometry follows the declared affine pixel/voxel grid.
Two-dimensional descriptors include exposed-edge perimeter, circularity
`4*pi*area/perimeter^2`, physical-center covariance eccentricity and major/minor
elongation. Three-dimensional descriptors include exposed-face surface area and
sphericity `(36*pi)^(1/3)*volume^(2/3)/surface`. Holes and contact with another
label contribute to each object's boundary. Objects touching the crop exterior
remain flagged; the algorithm does not reconstruct unseen shape.

Degenerate ratios remain missing with explicit reasons. Pixel units remain
uncalibrated. These digital boundary definitions can differ from a fitted smooth
contour or mesh. The linked Statistics & objects view exposes the descriptors
for distributions and exact-object inspection. Scientific exports retain the
original measurements and the added definitions. Correct or annotate the
underlying mask and rerun; direct edits to the morphology derivative are refused.

## Wound closure

**Wound closure** measures the union of explicitly selected positive labels on
compatible saved YX masks. The researcher declares filled-wound-area semantics,
specimen and sequence identity, actual elapsed seconds, and the shared field of
view/calibration. A boundary or skeleton is not automatically filled or treated
as an area mask. The mask selector reads all bounded population pages to recover
exact positive label IDs, including masks containing more than 1,000 objects.

The first scheduled frame must be observed and have positive selected area.
`area_fraction = observed_area / baseline_area` and
`closure_fraction = 1 - area_fraction`; negative closure retains observed growth.
An empty later wound is a valid observed zero. Missing observations remain
missing. Interval rates use adjacent scheduled observed slots only, without
interpolation or bridging a missing frame. Frames from one sequence are not
independent biological replicates. This report does not implement a comparison
across multiple specimens or groups.

`wound_closure_preview` validates and retains a bounded exact proposal.
`wound_closure_save` takes its preview token, rechecks dependencies and publishes
a saved report through a durable job. The token is not an access capability.
`wound_closure_get`, `wound_closure_list` and `wound_closure_query` inspect saved
reports and bounded tables. All input sources remain subject to their grants;
changing review state is visible separately from the retained measurement.

Native export requires an explicit picker grant. The atomic package includes
exact endpoints, a descriptive editable `closure.svg`, provenance, source-mask
artifacts and their checksums. Original masks and their review histories remain
available. A report is not a human approval of its inputs.

## Migration and observed trajectories

**Track over time** retains actual observation times, original measurements,
association hypotheses and the correction ledger. New tracking results and
corrections add `loci.trajectory-metrics/v1` bound to the exact graph hash.
Reading a legacy graph derives the same metrics without rewriting it.

Interval velocity is the signed XYZ displacement divided by actual elapsed
seconds. Speed is the observed chord length divided by those seconds. Track
mean speed is summed chord length divided by first-to-last elapsed time, not an
unweighted average of interval speeds. Directionality is net endpoint
displacement divided by observed path length; it is not a fitted persistence
time. Single observations and stationary directionality remain undefined.
Gap-spanning chords, uncertain identity links and unresolved hypotheses remain
explicit. Missing positions are never interpolated.

`tracking_result` returns a compact `trajectory_metrics` summary. Add
`table: "tracks"` or `table: "intervals"`, `offset` and `limit` (1–100) for a
page bound to the same result revision and graph; follow `next_offset`. Native
inspection shows paged measurements and an equal-scale world-XY projection of
a selected trajectory. Its observation controls open the exact retained source
frame. The projection does not display Z displacement; XYZ values remain in the
interval table and export.

Scientific export preserves the existing `trajectories.csv` and adds
`track-summaries.csv`, `track-intervals.csv` and the complete metrics in
`tracking.json`. Save, reopen and portable import validate the graph, metrics,
original observation bindings and any correction parent. Registration affects
declared coordinates while original intensity measurements remain unchanged.
