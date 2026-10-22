# Statistics & objects

Choose a saved segmentation result, then **Results → Statistics & objects**. The image
stays visible beside a wider workspace with measurements, labelled charts and a
paged object table. **Focus statistics** makes room for both charts; **Show image**
returns to the linked image. A raw source without a selected result points to
**Image & channels → Histogram & levels** for its pixel-value distribution. This is descriptive exploration within one exact result;
objects are not biological replicates and the explorer does not test hypotheses.

Choose X and Y metrics from measurements actually stored in that result. Area or
volume retains its recorded unit. Pixel/voxel counts and raw intensity statistics
are distinct quantities; intensity does not imply marker identity or concentration.
Missing or non-finite measurements remain missing, never zero. Physical units
require trustworthy source calibration; a TIFF resolution tag alone can be
ambiguous and must not be treated as microscopic calibration without evidence.

Add numeric ranges and apply them together. Bounds are inclusive; missing values
for a filter metric are excluded and counted. Histogram bins use left-closed,
right-open intervals except the final closed bin; clicking a bin narrows the
current ranges to its exact membership. Sorting uses label IDs to break metric
ties and puts missing values last. The table contains 25 objects per page.
**Go to object label** selects an exact positive integer label and reveals its
page in the current filtered order. An absent label or a label outside the current
ranges leaves selection and filters unchanged and explains the issue. **Previous
object**, **Next object** and table arrow keys traverse that order across pages;
Home and End select the current page's first and last objects. Selection does not
move the image; use **Locate selected object** to move to the selected object.
Histogram counts and summaries use the full filtered population. Scatterplots
show at most 500 points, deterministically spaced in label order; any sampling is
explicit and is not a representative statistical sample.

**Zoom**, **Pan** and **Reset view** change only the chart display domain. They
do not change filters, counts, summaries, membership or histogram bin edges.
Use **Enlarge** for a chart in an in-window dialog; Escape closes it and restores
focus. With the chart focused, +/− zoom, arrows pan and Home resets. With a scatter
point focused, arrows move between displayed points and Enter selects. Histogram
bins can be set to 8, 16, 32 or 64; this recomputes the histogram without changing
population membership. Tool switches and focus/enlargement preserve query, page,
selection and chart view. New metrics or filters reset display domains, and a new
result/revision resets the workspace query.

Select an object from the table, plot or image. Selection is bound to the source
hash, result and immutable revision. An object can remain selected outside the
current ranges; the inspector says so. **Locate selected object** finds an actual
pixel/voxel owned by that label, since a concave object's centroid may lie outside
it. A new result/revision resets the query and selection. Correction remains a
separate workflow that creates a new revision.

Under **Source & query details**, the downloadable query receipt preserves the normalized query, exact population
membership hash, result/source identities and counts. It is a reproducibility
receipt, not a full measurement-table export. Use **Review & export** for the
existing result-export workflow.

## Publication figures

**Export a publication figure** saves a new `.loci-figure` directory containing
`figure.svg`, a physically sized **600-DPI** `figure.png`, and `manifest.json`.
Choose the distribution or relationship chart, full data range or current chart
view, and single-column (85 × 65 mm), double-column (180 × 110 mm), or custom size.
Dimensions are bounded to 40–300 mm with a 16-million-pixel raster limit; some
large combinations exceed that allocation. The monochrome figure has labelled
axes and recorded units, without an invented title or caption.

A current view clips the canonical bins or scatter sample; it does not rebin or
recalculate population membership. Scatter sampling remains the same disclosed
500-point display sample, with its complete accounting in provenance. Constant
measurements stay centred at their measured value, without fabricated ranges.

The trusted engine requeries the exact source, result revision and normalized
query before and after the destination picker, and again before publication.
The manifest preserves query/membership hashes, counts, missing values, sampling,
metric descriptors, stored T/C/Z and region scope, result geometry/calibration,
physical and raster dimensions, font/runtime identities and artifact hashes.
Missing legacy scope is marked as not recorded. A changed source/query, unsupported
font glyph, existing destination, or unsafe output path fails without silently
substituting data or overwriting another export. The complete bundle publishes
atomically.

SVG uses editable text and needs a compatible font when opened elsewhere; the
font identity and portability limit are recorded. PNG fixes the rendered glyphs.
The current native publisher requires directory-descriptor staging available on
macOS/Linux. Windows figure export is unavailable until a supported publisher is
implemented and qualified. Local artifact checks do not establish scientific,
biological or clinical validity.

## Engine and CLI contract

`population_query` and `population_locate` are read-only engine operations. Both
require `result_id` and exact `revision_hash`; source identity is verified. The
query reads ordinary and tiled result measurements without decoding source images
or label arrays. It supports up to 100,000 objects, 32 measurement channels,
eight filters, 200 table rows per response, 2,000 plot points and 64 bins.
Unsupported measurements, incompatible units, duplicate labels, invalid bounds
and stale identities fail closed.

A query request can be saved as JSON and passed through the existing CLI:

```json
{
  "result_id": "REPLACE_WITH_RESULT_ID",
  "revision_hash": "REPLACE_WITH_EXACT_REVISION_SHA256",
  "x_metric": "measure",
  "y_metric": "voxel_count",
  "filters": [{"metric": "measure", "min": 100, "max": 1000}],
  "sort": {"metric": "measure", "direction": "desc"},
  "offset": 0,
  "limit": 25
}
```

Use the [CLI guide](CLI.md) for invocation. Intensity metric IDs encode the actual
stored channel name as UTF-8 hex followed by the statistic; use the metric
descriptors returned by the query rather than constructing biological identities.
The `loci.population/v1` response includes normalized query, full/filtered counts,
missing-value accounting, page rows, the selected row even outside the filter,
scatter sampling details, histogram endpoints, descriptive summaries and SHA-256
query/membership receipts. Membership is independent of display sampling and
pagination. Locate reads bounded label blocks to return `point_index` in YX/ZYX.

## Evidence boundaries

Regression checks for this workflow cover ordinary/tiled results, paging beyond 200
objects, sparse IDs, histogram endpoints, missing values, units, immutable source
bindings and owned-pixel location. The
[real-image check harness](../scripts/qa/population-real-images.py) requires
separately supplied, appropriately licensed images and annotation masks. Its
direct-pixel arithmetic checks and annotation agreement are separate endpoints;
neither validates general biological accuracy, diagnoses, whole-cell boundaries
or other imaging domains. Datasets and prior local results are not bundled here.
Record actual outcomes against the exact candidate source/app identities. See
[release status](RELEASE_STATUS.md) for published artifacts and remaining gates.
