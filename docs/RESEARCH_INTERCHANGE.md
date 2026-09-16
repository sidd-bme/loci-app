# Research recipe, study and annotation interchange

This document describes the implemented engine formats. It does not certify a
packaged desktop journey or make the exported methods biologically validated.

## Recipe templates

`loci.recipe-interchange/v1` is a canonical JSON recipe template. Export first
revalidates the saved selection, processing steps, segmentation settings,
measurement channels, gates, memory budget and reference bindings with the
workbench recipe validator. The file contains logical source roles (`primary`,
`flatfield` and `darkfield` where used), original source fingerprints and kinds,
the fully normalized selection and settings, and a canonical template SHA-256.
It contains no source paths.

Import requires an explicit local source ID for every role. Reuse on a new
sample is allowed: the importer records both the original template bindings and
the new local bindings, rebuilds reference bindings, and runs the complete
recipe validator again. It does not assume that a new source is the original
sample. An optional exact-source mode requires the original fingerprints and is
for restoration rather than general recipe reuse.

## Study archives

`loci.study-interchange/v1` is a deterministic-member-order, stored ZIP
archive. It contains:

- path-redacted source records and their exact fingerprints;
- versioned project metadata and document envelopes;
- immutable result records, revision hashes and parent bindings;
- review receipts bound to exact result revisions;
- terminal historical job records with request fingerprints; and
- content-addressed numeric NPY artifacts with hashes, shapes and dtypes.

Raw images and source locators are never copied. Managed model packages are not
included because they require a separate provenance, rights and runtime trust
decision; their documents retain public package identity and explicitly record
that the exact package must be reimported. Remote credentials, private request
bytes, retrieval locations, local process IDs and active execution state are not
portable. A remote scheduler job ID may remain only inside explicit historical
evidence; the active identity is cleared. Queued or running jobs are imported as
interrupted historical records and cannot resume automatically.

The importer does not extract arbitrary ZIP paths and does not ingest an
archived SQLite database. It accepts only canonical, stored, regular-file
members in fixed namespaces, rejects duplicate, linked, traversing, compressed,
oversized, unexpected or hash-mismatched members, and decodes NPY with pickle
disabled. It validates source/result/parent/artifact/review/job cross-references,
rebuilds the schema in a sibling staging directory, verifies the rebuilt study,
and publishes it to an absent destination with an atomic no-replace rename.

Every imported source has `locator_state: relink-required`. The source record
can be inspected without a path, but pixel access must fail until an explicitly
selected local file, OME-Zarr directory or medical series passes the exact
stored fingerprint and byte-size check through `relink_interchanged_source()`.

## Annotation files

The `roi_import` integration calls `research_annotation_import.import_annotations()`
with an exact result ID and revision hash, format (`geojson` or `imagej`), a
bounded payload, and explicit measurement channels. GeoJSON text is parsed with
duplicate-key and non-finite-number rejection and may contain one Loci Feature
or a FeatureCollection of up to 1,000 Loci polygon features. ImageJ bytes are
canonical base64 and must be a Loci-authored polygon ROI with its complete
embedded envelope.

Both formats must match the selected source fingerprint, result revision,
image shape and voxel-to-world geometry. Import recomputes measurements on the
selected result's source or registered-derived channels and publishes one new
unreviewed immutable child. It does not accept an arbitrary external ImageJ ROI
or infer a stain, marker, biological identity, annotation truth or accuracy.

The standalone `ResearchInterchangePanel` reads the selected annotation file in
the renderer, sends only bounded content to the engine, exposes the available
measurement channels, and requires result review after import.
