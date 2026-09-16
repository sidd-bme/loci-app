# ADR 0002: commercial and model strategy

- **Status:** accepted for private development; public launch gates remain open
- **Date:** 2026-08-29

## Decision

Loci will be developed privately toward a directly distributed freemium macOS
application. The intended first public offer is:

- **Loci Community:** a genuinely useful free research edition for importing,
  reviewing, segmenting, counting, and exporting routine images;
- **Loci Lab:** a US$19 one-time licence for reusable lab profiles, code-free
  local adaptation, expanded batch workflows, and model-comparison reports. A
  purchased major version keeps working permanently.

Payments, activation, and public source release are intentionally deferred
until the scientific, ownership, signing, and external-beta gates below are
closed. The repository remains private during that work. Developer ID signed
and notarized direct downloads are the v1 distribution target; the Mac App
Store is not the initial channel.

The commercial default model will be a compact Loci-native instance model
trained from random initialization on data with explicit commercial rights. It
will be exported for inference rather than shipping the training runtime in the
base application. The current classical engine remains a deterministic
fallback and diagnostic baseline.

Official Cellpose weights are not a commercial Loci dependency. Cellpose 4.1.1
with the historical `cpsam` settings may be used as an internal compatibility
benchmark or as a future clearly separated user-supplied backend, but Loci will
not bundle or commercially fine-tune those weights without written clarification
from MouseLand.

## Why

Free local tools already cover generic segmentation and large-scale image
pipelines. Loci's defensible value is the complete product experience: a calm
desktop workflow, reliable recursive batches, provenance-rich outputs, local
lab adaptation, explicit review state, and a model validated for the intended
acquisition workflow. A paid-only launch before that evidence exists would ask
users to pay for an unproven accuracy advantage.

Cellpose source is BSD-3-Clause, and its official weight repository is labelled
BSD-3-Clause. However, MouseLand also states that its models were trained on
CC-BY-NC data. That inconsistent provenance is an avoidable risk for a paid
product. Current Cellpose training also starts from an existing pretrained
model rather than supporting a clean random-initialization commercial path.

The user has confirmed that the authorised lab images and Cellpose-derived masks
in the protected training workspace may be used to train commercial or redistributable
weights. That resolves permission to use this corpus as training data. It does
not turn pseudo-labels into biological ground truth or validate the resulting
model's accuracy.

## Model boundary

The engine will expose versioned profiles behind one segmentation contract:

```text
Segmentation profile
├── Classical backend       deterministic fallback
├── Native ONNX backend     future commercial default
└── Compatibility adapter   internal or user-supplied models only
```

Every profile records its immutable identifier, semantic version, backend and
model format, model digest, rights and base-model lineage, image/channel policy,
normalization and tiling, post-processing/counting policy, validation-set
identity, metrics, and known failure modes. Training uses a separate cancellable
process with atomic checkpoints and publication; it must not destabilize the
serial analysis worker.

## Counting policy

The first annotation target is to count every individually distinguishable,
visibly viable cell in the field. Touching clusters should be split into
individual cells when boundaries can be supported by the image. Clearly dead,
debris-like, or non-cellular objects are excluded. Border cells are included
when enough of the cell is visible to support an individual instance. Uncertain
viability, unresolved clusters, and out-of-focus objects are flagged for review
rather than silently assigned a confident biological class.

Ordinary brightfield morphology does not prove viability. Until a modality and
reference labels validate that distinction, Loci reports detected cell
instances and review flags—not a measured live-cell count.

## Gates before taking payment

1. Confirm software, training-data, and model-weight ownership with the relevant
   institutional technology-transfer office; retain written provenance in each
   released model data card.
2. Create researcher-corrected reference annotations and lock acquisition-group
   holdouts before inspecting final performance.
3. Predefine and pass instance, count-error, split/merge, border, and failure-rate
   acceptance criteria on the untouched holdouts and external beta data.
4. Complete a free external beta with at least five independent labs and ten
   users, including unassisted import-to-export workflows and genuine purchase
   intent.
5. Complete the dependency/model SBOM and notices, EULA and privacy materials,
   Developer ID hardened-runtime signing, notarization, stapling, checksums, and
   clean-Mac Gatekeeper QA.

If ownership or model provenance prevents a paid release, the fallback is an
open-source core with paid signed builds/support and a donation/sponsorship
option. That fallback is not selected while the commercial gates remain
realistically closable.
