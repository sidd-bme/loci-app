# Real fluorescence qualification protocol

Protocol version: `real-fluorescence-v1`, 23 October 2026. This is a prospective
protocol, not a status report or a claim that a workflow passed. The integration
lead must review this file and record its SHA-256 before viewing outcome reports.
Any later change requires a new version, a reason, and a visible distinction
between exploratory and previously sealed evaluation.

## Scope and source authority

The first milestone tests real public images through ordinary packaged GUI use
and the actual policy-bound agent MCP. It covers 2D nuclei instances, counts,
raw-channel intensity, persistence, export and a nuclear-enrichment proxy. It
does not establish biomedical accuracy beyond these datasets, true cytoplasmic
boundaries, native FRM decoding, physical area calibration, clinical utility,
3D analysis, tracking or generalization to independent acquisition batches.

| Source | Permitted use and source-defined facts |
| --- | --- |
| [BBBC039v1](https://bbbc.broadinstitute.org/BBBC039) | CC0; 200 U2OS Hoechst DNA fields, 520×696 uint16 TIFF; manual colour PNG instances and official training/validation/test partitions. |
| [Official BBBC039 decoder](https://gist.github.com/jccaicedo/15e811722fca51e3ae90e8b43057f075) | First PNG colour component; label connected regions of equal nonzero value with full 2D connectivity. Repeated colours in disconnected regions are distinct instances. |
| [BBBC013v1](https://bbbc.broadinstitute.org/BBBC013) | Ilya Ravkin images, CC BY 3.0; U2OS FKHR-GFP translocation, channel 1 GFP and channel 2 DNA/DRAQ, 640×640, native FRM and separately published 8-bit BMP. Retain attribution with derivative exports. |
| [Logan and Carpenter, 2010](https://doi.org/10.1177/1087057110370895) | *Screening cellular feature measurements for image-based assay development*, J Biomol Screen 15:840–846; [author-hosted primary paper](https://carpenter-singh-lab.broadinstitute.org/files/anne/files/43-Logan_JBiomolScreen_2010.pdf). Inspect the official BBBC013 reproduction archive as text; do not execute its pipelines or deserialize its MAT files. |

The paper uses channel illumination correction and several compartment/feature
definitions. The downloaded `BioImage_wortmannin.cp` specifies corrected DNA
primary objects, a one-pixel nuclear shrink, six-pixel distance expansion,
tertiary subtraction, and additional propagation and thresholded ratio features.
Its metadata identifies A–D column 01 as negative (flag 0), column 12 as 150 nM
Wortmannin positive (flag 1); column 02 has flag 0.5 and is not a primary control.
The raw five-pixel nuclear/ring endpoint below is a different estimand. Published
Z-prime values must not be claimed as replicated or used as numerical targets.
The paper also cautions against feature selection and testing on the same
controls; this protocol fixes the endpoint before revealing test outcomes.

The official visual plate map labels Wortmannin doses in nM and LY294002 doses
in µM. Its corrected LY reproduction metadata assigns E–H column 01 the shared
positive control dose 150, whereas the generic all-sample text platemap contains
80 in that location. Preserve that source discrepancy and use the corrected
control flags; do not interpret those wells as 150 µM LY294002. Column 02 is
excluded regardless of its displayed annotation. This discrepancy does not
change the primary A–D Wortmannin control contrast.

Only official dataset URLs in `real_fluorescence_prepare.py` may be acquired.
The native FRM, BMP, platemaps and reproduction archive remain separate originals.
The CC BY statement explicitly covers the BBBC013 images; no additional licence
for the historical reproduction code is inferred. None of that code is executed
or incorporated into Loci. No model, runtime, protected data or external dataset
is provisioned by this harness.

## Preparation and boundaries

Use the existing locked engine Python environment. Provision new evidence roots:

```sh
engine/.venv/bin/python scripts/qa/real_fluorescence_prepare.py provision \
  --data .loci/evidence/2026-10-23/real-fluorescence/data \
  --evaluator .loci/evidence/2026-10-23/real-fluorescence/evaluator \
  --reuse-039 .loci/evidence/2026-10-03/object-population/real-images/originals
```

The optional reuse path is checked against the exact previously authorized
archive sizes and SHA-256 identities. A fresh download's SHA-256 is a local byte
identity, not a publisher-supplied checksum. Preserve archives, members, source
URLs and attribution. Reject archive traversal, symlinks/special files, duplicate
paths, overwrite attempts, encrypted entries and resource-limit violations.
An interrupted download is incomplete evidence and never an image input.
The `verify --manifest <source-manifest.json>` command rechecks all archive and
member identities; preparation invokes this check before reading original data.

Preparation is a reproducible format adapter available to ordinary users:

```sh
engine/.venv/bin/python scripts/qa/real_fluorescence_prepare.py prepare-039 \
  --data .loci/evidence/2026-10-23/real-fluorescence/data \
  --prior-selection .loci/evidence/2026-10-03/object-population/real-images/source-manifest.json
engine/.venv/bin/python scripts/qa/real_fluorescence_prepare.py prepare-013 \
  --data .loci/evidence/2026-10-23/real-fluorescence/data
```

BBBC039 adapters retain every uint16 sample and YX orientation, removing generic
72 dpi physical-resolution interpretation. BBBC013 adapters pair filenames by
well and channel, preserve every grayscale BMP sample as uint8, and write OME-TIFF
with axes CYX, C0=FKHR-GFP and C1=DNA (DRAQ). Read back and compare every sample.
There is no interpolation, normalization, denoising, clipping, intensity scaling
or channel inference from appearance. BMP is never described as native high-bit
FRM. The existing authorized vendor reader does not accept FRM. No verified
microscopy physical calibration is available: spatial units are pixels.

References, decoded labels and outcome reports belong under `evaluator/`, which
must remain outside the task agent's grants. Split metadata contains filenames,
not segmentation answers. The evaluator receives frozen task output labels and
settings only after recipe completion. Preserve source, script/protocol, recipe,
runtime, app/worker, raw pixel and prediction identities in each evaluation packet.
Do not grant the evaluator's originals or results to the task-performing agent.

## Development, sealing and sampling

BBBC039 uses official training (100), validation (50) and test (50) files. All
training/validation images may support development. Six fields selected in the
older authorized run are marked historically exposed; its three test fields are
excluded from sealed testing. The remaining 47 official test fields are evaluated
once after settings freeze. Report excluded filenames and reasons in the split
manifest. Old outputs are development evidence only. Do not inspect historical
outcomes to select a candidate or alter thresholds.

BBBC013 rows A/B and E/F are development; rows C/D and G/H are sealed. The primary
control contrast uses Wortmannin C01,D01 (0 nM) versus C12,D12 (150 nM). A/B uses
the analogous controls for development. Column 02 is excluded from primary
controls. Dose curves use columns 03–11 and are described separately for
Wortmannin and LY294002; do not pool their dose scales or fit a V-factor in this
milestone. Corrected LY294002 reproduction metadata, rather than assumptions
about the generic platemap, determines any LY control labels.

A field is the unit for BBBC039 accuracy summaries. Nuclei are dependent objects,
not independent experimental replicates. BBBC013 has one field per well and
uses wells as the population unit. Report all wells and cell exclusions. With
only two sealed wells per primary control, Z-prime is a small pilot statistic,
not evidence of batch-to-batch biological reproducibility.

## Independent numerical and instance oracles

`real_fluorescence_evaluate.py` imports NumPy/SciPy and image decoders, never Loci
measurement or segmentation implementation. For fixed raw samples and supplied
labels, object count, pixel area and uint64 intensity sum must match exactly.
Means use float64 division: `abs(actual-expected) <= 1e-9 + 1e-12*abs(expected)`.
Reject shape/axis, source/channel, nonfinite, negative, stale and unsupported
states. Empty/undefined quantities are explicit, never substituted with success.
Check save/restore and all relevant exports against the same raw/label oracles.

For BBBC039, compute the full pairwise instance IoU matrix. At each threshold
0.50 and 0.75 (inclusive), match one-to-one by maximum number of eligible pairs,
then maximum summed IoU. Report TP, FP, FN, precision, recall, F1, object Jaccard,
foreground IoU, signed/absolute/relative count error, and split/merge diagnostics.
Split/merge diagnostics count reference/prediction objects overlapping more than
one opposing object by any positive number of pixels; tiny boundary overlaps
therefore remain visible and are not an independent acceptance criterion.
Do not substitute binary foreground overlap for instance agreement. Report the
entire field distribution and all failures; never filter difficult phenotypes.

## BBBC013 fixed raw enrichment endpoint

Obtain predicted nuclei from DNA only, with settings fixed on development wells.
Measure the source GFP samples independently of display settings or segmentation
preprocessing. For each nucleus N, candidate ring pixels satisfy Euclidean
distance to N <= 5 pixels and lie outside every nucleus. Exclude pixels claimed
by more than one nucleus's candidate ring. Exclude nuclei touching the image
boundary. Report empty rings and zero-mean rings as excluded with reasons; do not
add an epsilon, impute values, or discard low responses by an intensity gate.

Per-object endpoint = mean raw GFP in N / mean raw GFP in its ring. It is a
nuclear-to-perinuclear-ring enrichment proxy, not a true cytoplasm measurement.
The well endpoint is the median of eligible per-object ratios; also report the
mean, counts and every exclusion. Require at least one eligible object and a
finite endpoint in every prespecified control well; otherwise fail that gate.
No illumination function or data-driven normalizer is fitted in this milestone.

For primary controls, calculate `Z' = 1 - 3*(s_positive+s_negative) /
abs(mean_positive-mean_negative)` using the sample SD (`ddof=1`) of well endpoints.
Equal means make Z-prime undefined and fail. Preserve direction separately.
Do not turn a two-well estimate into a p-value or independent-cell confidence
interval. Any uncertainty resampling must resample whole wells or fields.

## Prospective acceptance and reporting

All engineering invariants above must pass through both normal GUI and actual
agent MCP, including source/channel identity, numerical agreement, review state,
persistence and export. Simulated automated review is labelled as such and never
treated as a human scientific approval. Bind final packaged journeys to the exact
candidate source/app/worker identities. Existing source suites alone do not
qualify changed runtime behavior.

The integration lead selected these product targets before seeing outcomes:

- BBBC039 automatic sealed-test median field F1 at IoU 0.50 >= 0.85, and median
  absolute relative count error <= 0.10, across all 47 eligible fields.
- BBBC013 all four primary held-out wells produce defined finite endpoints;
  positive mean exceeds negative mean and pilot Z-prime > 0.
- Every raw-pixel arithmetic/persistence/export invariant meets the strict
  integer and floating tolerances above.

These are milestone product targets, not published universal standards or
clinical thresholds. Report automatic and manually corrected results separately.
Failure of automatic accuracy requires repair or a separately authorized model
path; corrected success must not relabel automatic failure as qualified. Retain
failed runs, exceptions, all selected fields/wells and protocol deviations.
Do not change targets, ring radius, exclusions, endpoint, partitions or settings
after sealed outcomes are viewed. A later exploratory repair must be explicitly
labelled and cannot restore the original prospective claim on reused held-out data.
