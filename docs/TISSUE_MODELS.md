# Epidermis tissue model

**Analyze → Epidermis model** provides an optional, bounded PUMA research
candidate for explicitly declared H&E images. It produces tissue regions, not
cell counts. A predicted epidermis class does not identify the basal boundary,
define the dermis, or establish a tissue-thickness measurement. The recorded
model scores are not calibrated confidence estimates.

## Provision and preview

The native setup imports two explicitly selected files: the exact converted
network weights and their matching conversion receipt. Both identities are
pinned by the code-owned `puma-tissue-cpu` profile. Arbitrary checkpoints,
architecture packages and conversion scripts cannot be supplied through this
interface. Import copies the verified pair into a separate managed tissue-model
namespace without overwriting an existing installation. It does not install a
runtime or establish technical or scientific qualification. Pending file pickers
can be cancelled; the atomic import phase is not cancellable.

The optional execution profile requires Python 3.12, PyTorch 2.13.0, NumPy 2.4.6
and SciPy 1.18.1, plus the exact Torch build and numerical contract recorded by
the profile. Catalogue discovery inspects distribution metadata without loading
Torch or weights. Metadata agreement alone does not establish compatibility;
execution verifies the runtime, tensor schema and file identities again.

Inputs must be native level-zero uint8 RGB or RGBA planes, no larger than
1024 × 1024 pixels. For RGBA, the first three samples are used directly; alpha
is discarded without compositing. RGB components never identify biological
channels or a stain. The user declares H&E preparation from acquisition records.

Normalization uses the complete native image context. An output ROI restricts
the retained prediction while preserving that context and its original tile
grid. It is not a replacement input image. There is no implicit resampling.
Physical calibration comes from registered source metadata, never from model
grid spacing. Uncalibrated sources retain pixel units.

Preview creates a durable job and retains an exact proposal token. Creating a
result reruns inference and requires the same prediction identity before atomic
publication. Changing source, region, declaration, profile or runtime state
invalidates the UI preview. CPU execution is serial within a disposable process;
the 2/4/8 GiB allowance is a bounded working-memory contract, not a hard macOS RSS
limit. Cancellation and ordinary supervisor termination clean up the child
process group. A hard SIGKILL cannot run cleanup; the child retains resource
limits and refuses publication when its exact-parent guard is next reached.

## Inspect, correct and export

The result retains the six-class label image, original epidermis scores,
selected class-4 connected regions, source/context/output geometry, runtime and
model contracts, array identities and measured region rows. Loci does not retain
original logits. Inspection distinguishes **Original tissue classes**,
**Original epidermis score**, and the current compartment-region labels.

Compartment corrections create immutable derived revisions and require a new
review. They preserve the original class predictions and scores, with ancestry
and correction history. Source-derived geometry and retained-array checks run
across inspection, review, export and portable import; a consistently rehashed
but false calibration is refused. Retained reads can use verified saved arrays
without the original image or model present. Scientific export still verifies
the source and requires exact-revision review and an explicit destination grant.

## Agent authority and evidence

`tissue_model_profiles` discovers the fixed catalogue. `tissue_model_status` and
`tissue_model_preview` take the exact source, full normalization context, output
selection, declared preparation, model/runtime hashes and working-memory budget.
`tissue_model_run` takes the retained `{preview_id, preview_hash}` token. Preview
and run are durable jobs, with the normal job ownership and replay rules.
Model import is native-only; an agent cannot supply arbitrary model paths.
Agent grants must cover both the full normalization context and output region,
plus the exact model/runtime and the requested operation. A small output ROI
does not narrow the pixels read for normalization.

An opt-in version 6 agent policy can further pin exact tissue output selections
with `tissue_outputs`. Each entry binds a source ID and fingerprint to the full
output selection, including channel, time, depth and pyramid level. The existing
source grant still authorizes the normalization context. Preview, token adoption
and access to retained tissue results must satisfy both grants. Earlier policy
versions retain their documented source-region authority; they do not promise
this additional exact-output restriction.

The source profile records pinned upstream code, checkpoint and dataset
identities and their declared licences. Model weights are not bundled or
downloaded by this feature; redistribution review remains incomplete. The
public training examples used for engineering checks are not independent
holdout data. Numerical reproducibility, packaged UI behavior, independent
accuracy, researcher review and biological validity are separate evidence
categories. See the [capability matrix](CAPABILITY_MATRIX.md) for source scope;
published downloads retain their own exact release identities.
