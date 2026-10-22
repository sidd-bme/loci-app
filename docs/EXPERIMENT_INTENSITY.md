# Experiment raw mean intensity — implementation contract

This bounded extension consumes stored measurements; it never measures pixels.
Its endpoint is a typed raw-channel mean in source-intensity units, for ordinary
objects or the stored cell, nuclear-intersection and cytoplasm compartments.
Only descriptors actually present in each exact result may be selected. Channel
keys remain literal, including punctuation and Unicode. Integrated measurements,
arbitrary expressions, inferred biological identity and automatic corrections are
outside this format.

## Workspace

Open **Results → Study & batch**. **Samples**, **Intensity**, **Batch** and,
when available, **Corrections** have separate sections. Switching sections retains
unapplied CSV, comparison drafts and saved-report views. **Focus study** expands
the data workspace; **Show image** restores the linked image. Comparing intensity
from a result opens Intensity with that exact revision selected.

Routine labels use source and method names; **Technical identity** retains the
complete source/result/revision bindings. Long decimal displays may use six
significant figures with an `≈` marker. Expand the value with a pointer or keyboard
to inspect and select its exact stored spelling. Counts, signed values and null
states remain distinct; calculation, saved reports and exports retain full precision.

## Evidence and estimand

Choose at most 100 exact v1 result revisions, one per source, and at most 50,000
objects in total. Pending review is blocked. Excluded results remain in the audit
and never contribute. Each source needs explicit study/sample/condition metadata;
a missing biological replicate stays unassigned and never enters a condition
estimate. Same replicate text in different conditions identifies different groups.

For eligible reviewed images, average finite per-object raw means with equal
object weights within that image. Average valid image means equally within the
declared (condition, biological_replicate) group, then average valid replicate
means equally within each condition. SD is the descriptive sample SD (ddof=1) of
replicate means, null below two contributors. Null empty compartments, absent
measurements and numerical zero are distinct. All values retain signed full
precision; non-finite values and overflow are rejected. Counts distinguish total
objects, valid objects, images, valid images, declared replicate groups and valid
replicate contributors. This estimand does not establish independent sampling.

Software checks kind/statistic/unit, producer method/settings, acquisition/run
scope and dimensions, literal channel bindings, source fingerprints, review and
metadata revisions and compartment partition definitions. Full segmentation/input
C selection is retained independently of the selected intensity channel. For a
compartment endpoint, the original cell and nuclear label-producing scopes are
resolved and compared, including their methods, input channels and dimensions.
The endpoint uses the exact `compartment_measurement.channel_metadata` snapshot
captured at measurement time, retained as `measurement_channel_metadata` in new
report bindings. Original segmentation declarations remain separate. Source,
literal channel/index, acquisition names and declaration epochs must agree with
the retained result. A v1 binding without this additive field is accepted only
when its original producer snapshot exactly matches the retained measurement
snapshot; inconsistent historical reports are rejected without rewriting them.
Missing producer evidence is rejected; partition formulas alone do not establish
compatible label production. A specific persisted
declaration names the intended shared channel and acquisition context and explains
comparability; it is user evidence, not verified calibration or biological identity.
Unavailable acquisition settings are recorded as unavailable rather than inferred.
Incompatible software-verifiable method/unit/scope facts cannot be overridden.

The independent oracle is A/R1 images (100 objects at 10; one at 30) -> 20;
A/R2 (one at 40) -> condition 30, sample SD sqrt(200), 102 objects/3 images/2
declared replicate groups. Object-pooled and pixel-pooled answers are wrong.

## Samples

The Sources & samples table joins source and sample records by exact source ID.
Search image/sample names, filter exact condition and replicate declarations, or
show sources missing required metadata, without a replicate, with pending results,
or with no results. Missing study/sample/condition values differ from an optional
unassigned replicate; the table makes no analysis-readiness claim.

Counts include every visible result revision, with pending, reviewed and excluded
states separately. Expand Results to inspect one explicit revision and its review
actor; agent review is not researcher approval. Inspection rechecks the source
fingerprint and exact revision, including after a deferred image switch. Edit
metadata selects the source only. Neither route mutates scientific state, and
returning to Samples preserves filters and unapplied CSV. Source lists page at 25
rows and expanded result lists at 10; local table scrolling remains keyboard accessible.

UTF-8 CSV columns are source_id, study, sample, condition,
biological_replicate, plate and well. IDs match exactly; no filename inference.
Maximum 1 MiB, 1,000 data rows and 1,000 registered study sources. Duplicate IDs, unknown IDs, malformed fields
and missing required values block apply. Preview shows every before/after row and
issues. Apply explicitly validates the exact preview and its current source/sample
bindings within one transaction; all updates commit together or none do.

## Reports and interchange

A saved loci.experiment-intensity-report/v1 snapshot is immutable and bounded.
It captures endpoint, exact selected revisions, source/review/sample/channel
bindings, full precision object observations, all three aggregate levels, audit,
specific declarations, aggregation definition and software identity. Its canonical
content hash binds every field. Reopen validates the snapshot without recomputation;
current input status is separate. Recompute explicitly creates a new report.
The preview carries an opaque canonical JSON snapshot (maximum 8 MiB). The UI
parses a separate display view and sends the original snapshot text back on save,
preserving integral float spelling, negative zero and full precision across the
JavaScript boundary. Save still validates its hash, arithmetic, retained inputs
and current state. The escaped transport envelope has a separate 16 MiB bound.
Native/portable study persistence preserves the exact referenced revisions and
rejects corrupt or unsupported records. Existing studies and comparison documents
keep their current semantics.

A separate loci.experiment-intensity-package/v1 exports the exact saved snapshot,
objects/image/replicate/condition/audit tables, settings/provenance, manifest and
data dictionary. Maximum 16 files / 64 MiB. Native destination authority, bounded
cooperative cancellation, immutable bindings and atomic no-replace publication
are required. No private source locators or profile/accepted-request payloads enter
the package.
Cancellation is checked throughout final report/source/status/software verification
and immediately before atomic rename. A cancellation observed before rename leaves
no destination and removes owned staging; after successful rename, a late cancel
retains the published package, success state and receipt.
Existing scientific-data-package/v1 is unchanged. Independent stdlib Python and
existing R/jsonlite readers check the hierarchy without production aggregation.

## Researcher route and explicit limits

Open **Study & batch**, load or download the sample-sheet template, fill exact
source IDs and declared metadata, inspect the before/after preview, then apply.
The manual sample editor remains in **Review & export**. From a current result,
**Compare intensity in Study & batch** seeds its exact revision. Select one revision
per source, the measured compartment and each literal stored channel. Enter the
shared channel, acquisition context and comparability rationale, then preview.
Image rows can open their exact revision without discarding the comparison.

Save the preview to create an immutable report. Saved reports reopen from the
same surface. Their captured values are displayed directly; current input status
is checked separately. **Recompute as new preview** prepares a new snapshot;
saving it preserves the older report. Export always prepares a fresh plan before
the native destination picker. Choose an absent directory name. Cancellation
requests cooperative cleanup; inspect the Jobs state if publication has already
completed. Existing destinations are never replaced.

This first format requires matching producing methods, dimensional shape,
geometry, selected spatial/time scope, partition definitions and recorded
acquisition facts, including the label-input producers of a compartment result.
Different segmentation/input C selections are blocked in this slice; only the
intensity measurement channel has an explicit per-result mapping. Unknown label
producers cannot be inferred from stored arrays. The declaration cannot override
a mismatch. Source IDs and
channel indices remain source-specific bindings; matching display names do not
prove biological identity. Missing exposure/gain and other acquisition facts are
listed explicitly in the captured scope. Empty compartment means are null; empty
object results with no stored endpoint descriptor cannot be selected. Indexed v2
results remain unsupported here and retain their existing scientific CSV export.

CSV report cells use reversible JSON encoding, including strings and nulls. Parse
each cell as JSON; the package's schema dictionary names every field and count.
`read_report.py` uses only the standard library. `read_report.R` uses an existing
R/jsonlite runtime and macOS/Linux `shasum`; neither installs dependencies. Both
verify file hashes, exact table/snapshot agreement and the hierarchy independently.

## Acceptance

Focused adversarial numerical/CSV/persistence/publication tests, combined desktop
and engine checks, the source regression runner, a freshly signed isolated app,
all five core packaged journeys, the scientific export journey and a dedicated
actual-control experiment journey are required for qualification. Graphite/Paper,
1024x720/1440x940, large text, keyboard/focus and reduced motion receive one batched
visual inspection and a repair confirmation. Historical receipts do not qualify
this tree. Until those checks pass this feature remains a draft candidate.
