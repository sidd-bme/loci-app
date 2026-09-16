# Cellpose compatibility and provenance

## Status

Loci pins `cellpose==4.2.1.1` and exposes two independently provisioned
Cellpose profiles:

| Loci profile | Role | Official artifact | Exact size | SHA-256 |
| --- | --- | --- | ---: | --- |
| `cellpose-sam` | Website-compatible default; compatibility evidence only | `cpsam` | 1,233,587,898 bytes | `e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2` |
| `cellpose-sam-v2` | Separate updated, unvalidated option | `cpsam_v2` | 1,233,586,851 bytes | `0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667` |

The macOS packaged profile includes the pinned Python runtime, but Loci never
bundles or downloads either checkpoint. A user must select the matching
official artifact explicitly. Loci verifies its pinned byte size and SHA-256
digest before atomically installing it in profile-specific managed storage; a
valid checkpoint for one profile is rejected by the other.

These adapters are interoperability profiles, not Loci-native models. Their
outputs remain review-required research results and are not biological
validation.

## Official Space checkpoint audit

The audited official MouseLand Hugging Face Space contains a checkpoint-label
mismatch at the model identity boundary. At source commit
[`b97a37a6237a937c862ad6b6a0ab4ca7adf0925e`](https://huggingface.co/spaces/mouseland/cellpose/commit/b97a37a6237a937c862ad6b6a0ab4ca7adf0925e),
the interface describes the model as `cpsam_v2`, but
[`app.py`](https://huggingface.co/spaces/mouseland/cellpose/blob/b97a37a6237a937c862ad6b6a0ab4ca7adf0925e/app.py)
calls `hf_hub_download` with `filename="cpsam"` and constructs the model from
that downloaded path. Its
[`requirements.txt`](https://huggingface.co/spaces/mouseland/cellpose/blob/b97a37a6237a937c862ad6b6a0ab4ca7adf0925e/requirements.txt)
pins Cellpose source commit
`ead065e1fee666ef74846752526d5882f7c0ad67` rather than the Loci package pin.

The website label alone is therefore not sufficient checkpoint provenance.
The current website-compatible Loci profile intentionally uses original
`cpsam`; the genuine `cpsam_v2` artifact remains a separate profile.

## Public defaults and image path

Both Loci Cellpose profiles seed the Space's public still-image defaults:

| Web control | Loci value | Behavior |
| --- | ---: | --- |
| Max resize | 1,000 px | Downsample the longer edge to 1,000 px with aspect ratio preserved, infer at that size, then restore integer labels to the source grid. |
| Max iterations | 250 | Pass `niter=250` to inference mask dynamics. This is not a training-iteration count. |
| Flow threshold | 0.4 | Pass `flow_threshold=0.4`. |
| Cell probability threshold | 0.0 | Pass `cellprob_threshold=0.0`. |

For routine `uint8` JPEG, PNG, and TIFF inputs, Loci reproduces the Space's
empirically important pixel path: OpenCV linear resize, truncation of the
aspect-ratio-derived edge to an integer, a `uint8` cast, and OpenCV
nearest-neighbour restoration of the label mask. The analysis record reports
this as `huggingface-space-uint8`.

Loci deliberately does not cast higher-bit-depth or floating-point microscopy
data to eight bits. Those inputs use an anti-aliased,
dynamic-range-preserving path, reported as `dynamic-range-preserving`. They are
therefore not claimed to be pixel-equivalent to the Space.

## Supplied-output reproduction

A controlled four-way run used the same supplied 3,088 x 2,076 dense-cell JPEG,
the public defaults above, and each checkpoint with both the corrected Space
path and Loci's previous anti-aliased resize path:

| Checkpoint and preprocessing | Instance count |
| --- | ---: |
| Supplied Hugging Face Space mask | 4,990 |
| Original `cpsam` + corrected Space `uint8` path | 4,994 |
| Original `cpsam` + previous Loci resize path | 4,632 |
| Genuine `cpsam_v2` + corrected Space `uint8` path | 5,607 |
| Genuine `cpsam_v2` + previous Loci resize path | 4,213 |

The final row reproduces the earlier Loci result exactly. The comparison shows
that two independent differences caused the apparent regression: Loci had
loaded genuine `cpsam_v2` while the website actually loaded original `cpsam`,
and Loci's previous anti-aliased floating-point resize materially changed the
model input. Restoring only the website's visible numeric settings could not
resolve either difference because those numeric defaults already matched.

The four-instance difference between the supplied 4,990 mask and the 4,994
local reproduction, together with 0.986 foreground intersection-over-union,
means this is close behavioral parity, not a bitwise identity claim. The Space
and Loci also pin different Cellpose code revisions.

Most importantly, none of these masks is researcher-adjudicated ground truth.
The higher 5,607 `cpsam_v2` count does not establish that v2 is better, and the
closer `cpsam` count does not establish biological accuracy. Loci therefore
defaults to original `cpsam` for website compatibility and exposes genuine
`cpsam_v2` separately. V2 settings must not be promoted as “perfect” or tuned
to one pseudo-reference; any change requires a predefined, diverse, locked
validation set with researcher-reviewed instances and failure modes.

## Historical lab evidence

The lab previously reported the same 1,000 / 250 / 0.4 / 0.0 settings in the
MouseLand Cellpose Hugging Face interface. A read-only audit also found them in
an access-controlled historical BioSegmenter session, which records
BioSegmenter 1.4.0, runtime requirement `cellpose==4.1.1`, model `cpsam`, and
first-to-99th-percentile normalization. The protected source location is
intentionally omitted from this public repository.

That saved session remains useful compatibility evidence, not ground truth.
Every compatibility run should record:

- the model artifact name, exact byte size, and SHA-256;
- the Cellpose release or source commit;
- source and working image dimensions;
- preprocessing mode and label-restoration method;
- every inference setting; and
- requested and resolved CPU, MPS, or CUDA device.

The developer-side [Cellpose compatibility benchmark
harness](CELLPOSE_BENCHMARK_HARNESS.md) now records that contract through the
same JSON-lines worker used by the desktop application. Its counts and
structural-sanity flags are technical compatibility outputs, not biological
validation evidence.

## Packaging and rights boundary

PyTorch dominates the frozen macOS analysis-engine footprint; the dated QA
checkpoint records the measured size. The runtime includes neither of the
approximately 1.23 GB Cellpose checkpoints. A future explicitly labelled Lite build may omit the Cellpose
runtime; the smaller default source-development environment already installs it
only through the `cellpose` extra.

The [Cellpose source licence](https://github.com/MouseLand/cellpose/blob/main/LICENSE)
is BSD-3-Clause, and the official Hugging Face model repository currently
labels the weight files BSD-3-Clause. However, the
[official Cellpose repository](https://github.com/MouseLand/cellpose#readme)
also states that all Cellpose models were trained on CC-BY-NC data. Those facts
leave unresolved provenance risk for a monetised product, including a
fine-tuned derivative that starts from either checkpoint.

Loci must not bundle, market, or rely on these weights for commercial use until
MouseLand provides written clarification covering pretrained-weight commercial
use. Requiring users to supply a checkpoint does not remove that training
lineage concern. Any future commercial model path must use a Loci-native model
trained from random initialization and validated only on images and annotations
with explicit commercial rights. The active decision is
[ADR 0003](ADR-0003-open-source-cellpose-integration.md); ADR 0002 remains
historical context.
