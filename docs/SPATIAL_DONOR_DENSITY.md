# Spatial donor density

Choose **Results → Spatial donor density** after creating exact
[tissue-distance results](SPATIAL_DISTANCE_BANDS.md). Select the fields, an
explicit time/plane stratum, and optionally an exact phenotype group per field.
Phenotype names and biological-replicate identities are declarations; Loci does
not infer cell identity or donor independence from an image.

## Endpoints

Within each compatible distance band, the numerator is eligible object count,
optionally intersected with the saved phenotype membership. The denominator is
the entire sampled compartment area in that band. A phenotype with no objects
still retains that area. Zero area produces an undefined density, including
when the numerator is zero.

Counts and areas are pooled within each study, condition and declared biological
replicate before calculating donor density. Condition summaries give each donor
with a defined density equal weight. Mean, median, sample standard deviation and
the number of eligible donors are descriptive; standard deviation is undefined
with fewer than two donors. These summaries do not treat fields as independent
biological replicates.

An explicit pair of conditions enables matching within study and biological
replicate. The contrast is right density minus left density. Unmatched donors
remain visible. No hypothesis test, confidence interval or causal conclusion is
implied. Missing metadata and fields outside the explicit stratum remain in the
exclusion audit. Incompatible measurement definitions, overlapping same-source
fields and duplicate result bindings are refused.

## Preview, save and inspect

Preview verifies exact result revisions, dependency records, retained arrays,
source identities, sample metadata and phenotype membership. Version 2 retains
compact endpoint projections and hashes of the exact original records and arrays.
It does not copy every cell's measurements into multiple report fields.

The response contains a bounded summary and an opaque
`{preview_id, preview_hash}` token. Save consumes that token, rechecks authority,
software and current inputs, then atomically publishes the report and successful
native job. An evicted or stale preview requires an explicit new preview. A
preview does not grant permission to its inputs. Passing a historical
`report_json` echo to save is refused.

The study retains at most eight previews with an aggregate eight-MiB limit.
Saved reports are separate immutable documents. The native view and MCP expose
paged input, field, donor, condition, paired and exclusion tables. A page contains
at most 100 rows and 64 KiB; consumers must follow `next_offset`, which can be
smaller than the requested row count. All pages bind the same report hash.
Changing sample metadata marks a historical report stale without rewriting its
saved donor endpoints. Version 1 reports retain their read/export path.

## Export and authority

Export requires an exact plan and a native destination grant. The package binds
the immutable report, complete tables, retained input identities and software
identities with a file manifest. Detailed cell measurements are exported
separately from compact report metadata. Publication is atomic and does not
overwrite an existing destination. Source/result grants cover every dependency;
report possession cannot widen agent access.

Source checks, packaged journeys and annotated-data accuracy are different
evidence categories. The [release status](RELEASE_STATUS.md) identifies published downloads;
this source contract alone is not a qualification record.
