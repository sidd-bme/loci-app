# Loci model data card

Complete this record for every model pack before it can enter the profile
registry. Replace every `TBD`; an unresolved field makes the model unavailable
for public release.

## Identity

| Field | Value |
| --- | --- |
| Profile ID | TBD |
| Model version | TBD |
| Model format and opset | TBD |
| Model SHA-256 | TBD |
| Profile-manifest SHA-256 | TBD |
| Training-code commit | TBD |
| Created at (UTC) | TBD |
| Release status | development / internal validation / public |

## Intended use

- Supported modalities, cell types, magnification, channels, image sizes, and
  acquisition conditions: TBD
- Intended output: 2D cell-instance masks and image-based cell count
- Counting-policy version: TBD
- Explicit non-uses: diagnosis, treatment decisions, universal viability
  measurement, unsupported stacks/time series, and any modality not validated
  below

## Rights and lineage

| Item | Evidence |
| --- | --- |
| Base-weight lineage | Random initialization / cleared base profile: TBD |
| Training-image authorization | TBD |
| Annotation authorization | TBD |
| Commercial and redistribution status | TBD |
| Code and dependency licences | TBD |
| Institutional ownership review | TBD |

Do not place canonical source paths, credentials, participant identifiers, or
confidential filenames in a shareable card. Refer to immutable internal evidence
IDs and manifest hashes.

## Data

| Partition | Acquisition groups | Images | Annotation level | Manifest digest |
| --- | ---: | ---: | --- | --- |
| Train | TBD | TBD | pseudo-label / reviewed | TBD |
| Validation | TBD | TBD | pseudo-label / reviewed | TBD |
| Locked test | TBD | TBD | adjudicated | TBD |
| External beta | TBD | TBD | adjudicated | TBD |

- Duplicate and near-duplicate audit: TBD
- Excluded/quarantined cases and reasons: TBD
- Label-space transforms and physical calibration policy: TBD
- Split leakage checks: TBD

Pseudo-label agreement must never be relabelled as biological accuracy.

## Model and training

- Architecture and parameter count: TBD
- Input normalization and channel policy: TBD
- Spatial preprocessing, maximum edge, interpolation, and source-grid restore
  policy: TBD
- Tile size, overlap, and seam reconciliation: TBD
- Foreground, boundary, and centre-offset targets: TBD
- Losses and weighting: TBD
- Optimizer, schedule, batch size, steps, and random seeds: TBD
- Augmentations: TBD
- Hardware and software environment: TBD
- Checkpoint-selection rule fixed before final test: TBD

## Validation

Report per acquisition group as well as overall:

- instance AP at predefined IoU thresholds;
- count MAE, median absolute error, bias, and relative error;
- false positive and false negative instances;
- split and merge errors;
- border-cell performance;
- performance by density/focus/contrast strata;
- invalid/abstained result rate and runtime/memory envelope.

| Metric | Validation | Locked test | Acceptance threshold | Passed |
| --- | ---: | ---: | ---: | --- |
| TBD | TBD | TBD | TBD | yes / no |

## Known limitations and review triggers

- Known failure modes: TBD
- Conditions that require user review or abstention: TBD
- Unsupported inputs and actionable error behavior: TBD
- Evidence gaps: TBD

## Release checks

- [ ] Model digest verified by the packaged application
- [ ] ONNX reference inference passes two-shape numerical and postprocessed-count parity
- [ ] Accelerated-provider output/count parity passes tolerance
- [ ] Full packaged UI and batch journey passes with this profile
- [ ] Dependency and model SBOM complete
- [ ] Required licences/notices bundled
- [ ] Scientific reviewer approval recorded
- [ ] Ownership/commercial approval recorded
- [ ] Rollback model pack retained
