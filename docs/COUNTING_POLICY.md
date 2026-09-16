# Cell counting and annotation policy

- **Version:** draft 0.1
- **Date:** 2026-08-29
- **Scope:** 2D routine brightfield and fluorescence still images

## Target object

Create one instance for each individually distinguishable cell that appears
visibly viable in the image. The objective is an image-based cell-instance
count, not a claim that morphology alone establishes biological viability.

## Inclusion rules

- Include separated cells with a supportable cell boundary.
- Split touching clusters into individual instances when the image supports a
  boundary, centre, or consistent continuation for each cell.
- Include a border cell when enough of its body is visible to identify one
  individual cell. Mark the instance as border-truncated.
- Include mildly out-of-focus cells when an individual cell and approximate
  boundary remain supportable.

## Exclusion and review rules

- Exclude clear debris, imaging artifacts, bubbles, and non-cellular material.
- Exclude cells that are clearly dead by a validated image-based criterion. If
  the acquisition does not validate viability, mark the object uncertain rather
  than inventing a live/dead label.
- Do not invent individual cells inside an unresolved dense cluster. Annotate
  the supportable instances and flag the remaining region as an unresolved
  cluster.
- Mark severely out-of-focus candidate objects as uncertain or uncountable.

## Required annotation attributes

Each reviewed instance should eventually support these flags in addition to its
mask:

- `border_truncated`
- `viability_uncertain`
- `focus_uncertain`
- `cluster_split_uncertain`
- `excluded_debris_or_artifact`

The instance mask remains the geometry used for training and measurement. Flags
preserve biological uncertainty for audit, stratified validation, and future
model heads without forcing unsupported labels into the count.

## Adjudication

Historical Cellpose masks are pseudo-labels. They can seed review, but are not
accepted reference annotations until a researcher has inspected and corrected
them under this policy. Dual tuned/untuned masks should be prioritized because
their disagreement identifies useful split, merge, and sensitivity cases.

Reference-set review must be performed without changing the locked test-set
membership. Disagreements should be resolved by a second reviewer or explicitly
retained as uncertain; never choose the variant that makes a model's score look
better.

## Reporting language

Until viability is validated for a defined acquisition method, use **cell
instances detected** or **reviewed cell count**. Do not market the output as a
live-cell count, viability measurement, diagnostic result, or universal ground
truth.
