# Scientific data packages

In **Results → Review & export → Export scientific data**, select the current result
or explicitly choose study result revisions. **Reviewed data** requires every
requested revision to be reviewed. **Provisional data for review** preserves
pending and excluded statuses; it does not approve results. Existing result,
image, figure and study exports remain available in their existing workflows.

This workflow supports stored label-object measurements, including paged large
results. Other result types retain their existing exporters.

Choose all objects or named groups for each selected revision. A subset requires
at least one group per result. Its objects are the unique union of those groups;
membership rows retain overlaps. Preview validates the complete requested scope,
shows its counts and a few exact stored values, then **Export data package…**
opens the native destination picker. Changes to scope, revisions, source binding,
review or sample metadata invalidate an existing preview with an explicit caution
and require a new preview before exporting. When a selected revision is still
pending review or has no saved groups, inline recovery actions let you inspect
that revision in **Review & export**, open **Statistics & objects** to create a
group, or switch explicitly to **Provisional data for review** or **All objects**.
A stale package request fails instead of silently exporting newer scientific state.

## Files and values

The package is a directory of UTF-8 CSV tables, JSON metadata, exact object JSONL,
reader scripts and short methods/readme documents. It contains no source image
arrays. The Loci schema uses [Table Schema](https://specs.frictionlessdata.io/table-schema/) concepts such as fields, primary keys
and foreign keys; this is not a claim of full external specification conformance.

| File | Meaning |
| --- | --- |
| `results.csv` | Exact result/revision/source identities, counts and recorded review/geometry/selection context |
| `objects.csv` | One row per selected object; stored label, coordinates, dimensions and units |
| `measurements.csv` | One row per object/metric, with unit, status and original numeric type |
| `samples.csv` | Declared study, sample, condition and biological replicate metadata, when assigned |
| `groups.csv` | Exact saved group identity/definition and original/exported counts |
| `memberships.csv` | Group membership links; an object may occur in several groups |
| `object-records.jsonl` | Original selected object structures, one JSON object per line |
| `schema.json` | Column types, text/null codec, keys, relations and table row counts |
| `manifest.json` | Counts, SHA-256 and byte sizes for every other package file |
| `provenance.json` | Pinned scientific execution, correction, source, review, group and exporter software identity |
| `read_data.py`, `read_data.R` | Explicitly invoked standalone import/validation helpers |

Provenance retains typed executed tissue morphology, declared stain separation,
RGB intensity conversion and puncta settings. Free-form controls/notes, private
paths and unknown metadata trees are omitted.

Result identities always include `revision_hash`. Object keys include result ID,
revision hash and original label; a label alone is not unique across results.
Spatial index axes are YX or ZYX, while world centroids are XYZ. Use the declared
coordinate frame, calibration and units; readers do not infer or convert them.

CSV numbers use decimal integer text or round-trip float text without display
rounding. Signed zero is retained. `measurements.csv` distinguishes an actual
numeric `value`, explicit `null` and absent `missing`; null/missing rows do not
become zeros. Non-finite or corrupt stored measurements fail validation. Mixed metrics or measurement units must be selected and converted
explicitly before comparison or pooling.

The raw null sentinel is `\N`. Literal text beginning with a backslash has its
initial backslash doubled. Formula-like text and text beginning with an apostrophe
have one protective apostrophe prefixed. Decode null first, then remove exactly
one protective prefix from text columns. The helpers do this automatically.
Empty text stays empty, and a literal text `\N` remains distinct from null.
Do not apply spreadsheet type guessing or remove prefixes manually before import.

## Python

The Python helper uses only the standard library. It validates the exact file set,
SHA-256, byte sizes, table headers/row counts, primary/foreign keys, source/revision
bindings and count relationships before returning data. The manifest does not hash
itself; its SHA-256 is recorded in Loci's export receipt. Every listed file must
have valid SHA-256 and byte-size metadata; removing that metadata is an error.
Internal checks establish consistency, not package authorship or biological accuracy.

Run `python -B /path/to/package/read_data.py` for a validation/count report.
For interactive analysis, use `runpy` so importing does not create an extra
`__pycache__` directory inside the sealed package:

```python
import runpy

reader = runpy.run_path("/path/to/package/read_data.py")
read_package = reader["read_package"]
numeric_value = reader["numeric_value"]
data = read_package("/path/to/package")
tables = data["tables"]
objects = tables["objects.csv"]
measurements = tables["measurements.csv"]

# Original columns remain str or None. Request an exact int/Decimal explicitly.
row = next(row for row in measurements if row["status"] == "value")
exact_value = numeric_value(row, "value")
```

`numeric_value` returns arbitrary-precision Python integers or `Decimal`, retaining
the original column. `double_value` is an explicit binary64 convenience accessor:
it rejects integers outside ±2^53, decimals with more than 17 significant digits,
overflow and nonzero underflow. A binary64 value is an approximation to decimal
notation; retain the original text for exact comparison or serialization.
Raw JSON numbers use a `NumberText` string subtype to preserve their lexemes.

Join group links to objects without counting overlapping links as new objects:

```python
key = lambda row: (row["result_id"], row["revision_hash"], row["label"])
objects_by_key = {key(row): row for row in objects}
links = tables["memberships.csv"]
group_objects = [objects_by_key[key(link)] for link in links if link["group_id"] == "GROUP_ID"]
unique_group_union = {key(link) for link in links}  # keys, not membership-row totals
```

Group by declared replicate metadata without inventing independent observations:

```python
from collections import defaultdict

samples = {row["source_id"]: row for row in tables["samples.csv"]}
results = {(row["result_id"], row["revision_hash"]): row for row in tables["results.csv"]}
by_replicate = defaultdict(list)
unassigned = []
for obj in objects:
    result = results[(obj["result_id"], obj["revision_hash"])]
    sample = samples.get(result["source_id"])
    if sample is None or not sample["biological_replicate"]:
        unassigned.append(obj)
        continue
    group = (sample["study"], sample["condition"], sample["biological_replicate"])
    by_replicate[group].append(obj)
```

This creates declared groups only; it does not compute estimates, biological n or
statistical independence. Several revisions may describe the same source or cells;
choose the intended revision before any scientific aggregation. The preview count
uses unique `(study, condition, biological_replicate)` tuples; it is a count of
declared condition/replicate groups, not an estimate of independent biological n.

## R

The R helper requires an already installed `jsonlite`. It installs nothing.
CSV import explicitly uses character columns, original column names, UTF-8,
double-quote escaping and no automatic NA strings. Decoded nulls are
`NA_character_`; empty strings and original numeric lexemes remain distinct.

```r
source("/path/to/package/read_data.R")
data <- read_loci_data("/path/to/package")
objects <- data$tables[["objects.csv"]]
measurements <- data$tables[["measurements.csv"]]
row <- measurements[which(measurements$status == "value")[1], , drop = FALSE]
value <- numeric_value(row, "value")  # explicit conversion; original column retained
```

`Rscript /path/to/package/read_data.R /path/to/package` validates the package and
prints table row counts; `source()` only defines the reader functions.

R's accessor returns a checked round-trip binary64 double. It rejects integers
outside ±2^53, decimals with more than 17 significant digits, overflow and nonzero
underflow. It is not an arbitrary-precision decimal implementation. Keep the
original character column whenever conversion is rejected or exact decimal text
matters. The raw JSONL table exposes `raw_json` text plus identity/label columns;
it deliberately does not expose jsonlite-coerced measurement numbers.
The tested R 4.5.1 installation also rejected conversion of `1e+308` because its
decimal parser/formatter failed the round-trip check; the character cell remained
unchanged. Other platform conversion failures are rejected by the same check.

The default R validation also checks file sizes and SHA-256 using an available
`sha256sum` or `shasum` command. If neither is available it fails with instructions:
validate the unchanged package using Python first, then explicitly call
`read_loci_data(path, verify_hashes = FALSE)`. That R result records
`hashes_verified = FALSE`; key/count/text validation still runs.

```r
keys <- c("result_id", "revision_hash", "label")
links <- data$tables[["memberships.csv"]]
one_group <- links[links$group_id == "GROUP_ID", , drop = FALSE]
group_objects <- merge(one_group, objects, by = keys, sort = FALSE)
union_keys <- unique(links[keys])  # avoid duplicate totals from overlapping groups

results <- data$tables[["results.csv"]]
samples <- data$tables[["samples.csv"]]
bound <- merge(objects, results[c("result_id", "revision_hash", "source_id")],
               by = c("result_id", "revision_hash"), all.x = TRUE, sort = FALSE)
bound <- merge(bound, samples, by = "source_id", all.x = TRUE, sort = FALSE)
assigned <- !is.na(bound$biological_replicate) & nzchar(bound$biological_replicate)
replicate_fields <- c("study", "condition", "biological_replicate")
declared_groups <- unique(bound[assigned, replicate_fields, drop = FALSE])
# Each row is a declared grouping; selecting matching rows does not establish n.
```

## Bounds and practical limits

The exporter accepts 1–100 exact result revisions, at most 100,000 objects per
result and at most 256 groups per result. Its conservative disk preflight estimates
16 MiB + 32,768 bytes per selected object + 2,048 bytes per metric row + 512 bytes
per group-membership row, with an 8 GiB ceiling and an additional actual-byte cap.
A large or very wide request can be rejected instead of truncated; reduce the
explicit scope and prepare another preview.

The helpers stream checksum reads but hold imported tables in memory. Large
packages may need a separate chunked reader guided by the schema, with identity
and numeric columns kept as text. They read an unchanged local package, not a
concurrently edited or hostile filesystem. Keep analysis outputs, notebook caches
and Finder-generated files outside the package: strict file-set validation rejects
extra files and directories. No helper executes automatically in Loci, loads an
image/model or sends data to a service.

## Local CLI

The existing local research CLI accepts the same explicit bindings as the UI.
The request contains `purpose` (`reviewed` or `provisional`) and a `bindings` list;
each binding requires `source_id`, `source_sha256`, `result_id`, `revision_hash`,
`subset` (`all` or `groups`) and `group_ids` (empty for all objects).

```sh
python -m loci_engine.research_cli plan-data-export --project STUDY --request @request.json > plan.json
python -m loci_engine.research_cli export-data --project STUDY --plan @plan.json --destination NEW_DIRECTORY
```

Use the configured engine environment. Keep the complete plan response unchanged;
the CLI consumes its opaque `plan_json` without reconstructing numeric values.
The destination must be absent. The trusted desktop RPC uses the same planner and
publisher through a private destination grant; no new agent permission is added.
