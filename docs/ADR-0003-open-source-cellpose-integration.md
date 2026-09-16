# ADR 0003: open-source release and explicit Cellpose integration

- **Status:** accepted
- **Date:** 2026-08-30
- **Supersedes:** the private-source, freemium, and Cellpose-version decisions
  in [ADR 0002](ADR-0002-commercial-model-strategy.md)

## Decision

Loci will proceed as an Apache-2.0 open-source research application. The
current release direction does not include payments, activation, paid cloud
inference, or a claim that Cellpose model weights are cleared for commercial
use. Donations, paid support, hosted compute, or signed convenience builds may
be evaluated later, but none may be introduced as a Cellpose-weight product
without written rights clarification.

The 2D analysis workspace exposes three model profiles behind one versioned
engine contract:

1. **Cellpose-SAM · Website compatible**, the default optional adapter for
   reproducing the audited website behavior only, pinned to
   `cellpose==4.2.1.1` and the original official `cpsam` checkpoint;
2. **Cellpose-SAM v2**, a separate updated, unvalidated adapter using the same
   runtime and the genuine official `cpsam_v2` checkpoint; and
3. **Loci Adaptive Watershed**, Loci's deterministic, locally available
   segmentation baseline. This is an algorithmic profile, not a learned model
   or a claim of Cellpose-equivalent accuracy.

Cellpose is explicitly provisioned. Loci does not bundle or silently download
either of the approximately 1.23 GB checkpoints. A user obtains an official
artifact and selects it through the matching profile. The engine copies it
atomically into profile-specific managed storage only after exact verification:

| Profile | Artifact | Exact size | SHA-256 |
| --- | --- | ---: | --- |
| `cellpose-sam` | `cpsam` | 1,233,587,898 bytes | `e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2` |
| `cellpose-sam-v2` | `cpsam_v2` | 1,233,586,851 bytes | `0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667` |

A valid checkpoint for one profile is rejected by the other. The analysis
record captures the Cellpose package, profile, checkpoint, preprocessing mode,
settings, and resolved compute device.

The original checkpoint is the website-compatible default because an audit of the
official Hugging Face Space at commit
`b97a37a6237a937c862ad6b6a0ab4ca7adf0925e` found that its interface says
`cpsam_v2` while its code actually downloads `cpsam`. On the supplied dense
image, the Space mask contained 4,990 instances; original `cpsam` with the
Space-compatible `uint8` OpenCV path reproduced 4,994, while genuine
`cpsam_v2` with the same defaults and corrected preprocessing produced 5,607.
That default is a compatibility choice, not an accuracy recommendation. Those
observations establish profile identity and close behavioral parity,
not biological accuracy or a claim that either checkpoint is universally
better. V2 remains separately selectable until a locked, researcher-adjudicated
validation set supports any promotion or setting change.

The current macOS packaged profile includes the pinned Cellpose 4.2.1.1 Python
runtime. PyTorch dominates the frozen analysis-engine footprint; the dated QA
checkpoint records the measured size. Loci still never bundles or downloads `cpsam` or `cpsam_v2`; the
matching checkpoint must be imported explicitly and pass verification before a
Cellpose profile becomes ready.

A future explicitly labelled Lite build may omit the Cellpose runtime and must
report that prerequisite as unavailable. A source checkout keeps the smaller
default development environment and installs Cellpose explicitly through the
engine's `cellpose` extra. The checkpoint alone does not make a Lite or source
build ready.

## Rights boundary

The Cellpose source repository declares BSD-3-Clause, and the official
Hugging Face model repository currently declares BSD-3-Clause for its files.
MouseLand also states that official Cellpose models were trained on CC-BY-NC
data. The difference between artifact metadata and training-data lineage leaves
commercial use of both official pretrained weights unresolved.

Accordingly, Loci may provide open-source interoperability and attribution, but
must not bundle, sell access to, commercially fine-tune, or advertise commercial
clearance for either official Cellpose checkpoint without written clarification
from the relevant rights holders. Making a user bring their own checkpoint does
not by itself remove that lineage concern. Loci's Apache-2.0 licence applies
only to Loci-authored code and content; it does not relicense Cellpose or its
model artifacts.

## Product consequences

- The model selector changes the inspector to show only settings supported by
  the selected profile.
- Results remain review-required research outputs. Cellpose's reputation or a
  successful automated run is not biological validation.
- Manual add-boundary, delete-instance, undo, and redo operations are recorded
  in corrected-result provenance and applied before export.
- Export preferences select summary counts, per-instance measurements, overlay,
  label mask, and analysis record. Batch count summaries are consolidated.
- Theme, text-size, and reduced-motion behavior are presentation preferences;
  they do not alter analysis results.
- A future learned Loci model still requires rights-cleared data, locked
  acquisition-group holdouts, model cards, and explicit accuracy gates.

## Reconsideration triggers

Revisit this decision only with documented evidence: written Cellpose weight
clearance, an audited model/data licence chain, a validated Loci-native model,
or a separately approved business and distribution plan. A future monetisation
decision must be recorded in a new ADR rather than inferred from this one.
