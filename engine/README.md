# Loci engine

The engine is a UI-independent, stdin/stdout JSON-lines worker. Keeping image
analysis outside the desktop renderer prevents long-running work from freezing
the interface and keeps model/runtime choices replaceable.

## Protocol

Each request is one JSON object per line. Import previews may request a bounded
thumbnail and can verify a previously recorded source digest:

```json
{"id":"1","method":"inspect","params":{"path":"/path/to/image.tiff","max_edge":320,"expected_sha256":"<sha256>"}}
```

```json
{"id":"1","method":"health","params":{}}
```

Each response includes the same ID and exactly one of `result` or `error`.
Diagnostic logs go to stderr so stdout remains machine-readable.

The engine exposes its immutable, data-only segmentation profile registry over
the same boundary:

```json
{"id":"profiles","method":"list_profiles","params":{}}
```

```json
{"id":"profile","method":"inspect_profile","params":{"profile_id":"loci-classical"}}
```

Profile manifests are strict path-free JSON. They record backend kind, model
format and digest, current availability, rights and training-data lineage,
recommended settings, a data-only UI settings contract, and validation
limitations. Built-in algorithm, pinned Cellpose-native checkpoint, and ONNX
formats are accepted; manifests never deserialize model objects or arbitrary
import targets.

The built-in profile keeps the stable ID `loci-classical` for compatibility but
is presented as **Loci Adaptive Watershed**, accurately describing its
deterministic morphology and watershed implementation. It has no learned
weights. The two optional Cellpose profiles are dynamic and independently
provisioned:

- `cellpose-sam` is the recommended website-compatible profile and requires the
  original official `cpsam` checkpoint; and
- `cellpose-sam-v2` is the separate updated/experimental profile and requires
  the genuine official `cpsam_v2` checkpoint.

Each becomes ready only when the engine has exactly `cellpose==4.2.1.1` and the
matching managed checkpoint passes its pinned size and SHA-256 verification.

Cellpose runtime status is available without starting an analysis:

```json
{"id":"cellpose","method":"cellpose_status","params":{"profile_id":"cellpose-sam"}}
```

The response reports the exact required and installed package versions, managed
checkpoint location, expected identity, verification state, CPU, MPS, and CUDA
availability, and an actionable status code. Loci never triggers Cellpose's
first-use download behavior. A user-selected checkpoint can be copied into
managed local storage only after exact verification:

```json
{"id":"import","method":"import_cellpose_model","params":{"profile_id":"cellpose-sam","path":"/absolute/path/to/cpsam"}}
```

The import is a local, no-follow, streaming verification and atomic publish; a
failed size or digest check leaves no installed checkpoint. There is
intentionally no network download worker method. Development runtimes can
install the exact optional Python stack with `uv sync --extra cellpose`.

Desktop and documented worker calls always send an explicit Cellpose profile
ID. For compatibility with the pre-dual-profile JSON protocol only,
`cellpose_status` and `import_cellpose_model` calls that omit `profile_id`
continue to address `cellpose-sam-v2`; this legacy fallback is not the desktop
recommendation or segmentation default.

The pinned official checkpoint identities are:

| Profile | Artifact | Exact size | SHA-256 |
| --- | --- | ---: | --- |
| `cellpose-sam` | `cpsam` | 1,233,587,898 bytes | `e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2` |
| `cellpose-sam-v2` | `cpsam_v2` | 1,233,586,851 bytes | `0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667` |

The Cellpose code and checkpoint repository declare BSD-3-Clause, but the
maintainers also state that Cellpose models were trained on CC-BY-NC datasets.
Loci therefore does not bundle either checkpoint and records commercial use as
restricted pending written clearance; this is a lineage caution, not legal
advice.

Upstream records: [Cellpose 4.2.1.1 on PyPI](https://pypi.org/project/cellpose/),
[version-pinned inference API](https://github.com/MouseLand/cellpose/blob/v4.2.1.1/cellpose/models.py),
[Cellpose code license](https://github.com/MouseLand/cellpose/blob/main/LICENSE), and
[official checkpoint repository](https://huggingface.co/mouseland/cellpose-sam).

Segmentation returns an opaque `result_id` alongside the preview and metrics.
The worker keeps the full-resolution arrays in a bounded in-process cache so an
export request does not need to send a label image through JSON:

```json
{"id":"analysis","method":"segment","params":{"path":"/path/to/image.tiff","profile_id":"loci-classical","settings":{}}}
```

Omitting `profile_id` remains backward compatible and selects
`loci-classical`. Unknown or non-ready profiles fail before the image is read.

Both Cellpose profiles seed the public Space's 2D defaults:
`max_edge_px=1000`, `niter=250`, `flow_threshold=0.4`, and
`cellprob_threshold=0`. Additional
supported controls are declared by the profile's `settings_contract`, including
diameter, mask-size filters, dynamics, tiling, normalization, and compute
device. For `uint8` inputs, both profiles use the official Space's OpenCV linear
resize, integer edge truncation, `uint8` cast, and OpenCV nearest-neighbour label
restoration. Higher-bit-depth and floating-point inputs deliberately use a
dynamic-range-preserving path instead of the Space's destructive cast. The
analysis record reports which preprocessing mode ran.

Loci passes a verified absolute checkpoint path to Cellpose, keeps one warm
model per process, prefers MPS then CUDA in automatic mode, and retries a failed
accelerator inference once on CPU. Labels are relabeled sequentially on the
full source-resolution grid before entering the same bounded result cache,
manual-correction, review, and export pipeline as the built-in profile.

The profile distinction was established by a source and output audit, not by a
name assumption. Official Space commit
`b97a37a6237a937c862ad6b6a0ab4ca7adf0925e` displays `cpsam_v2` but downloads
the artifact named `cpsam`. On the supplied dense-cell image, its exported mask
contained 4,990 instances. Loci produced 4,994 with `cpsam` and the exact 8-bit
Space preprocessing path, and 5,607 with genuine `cpsam_v2` using the same
settings and corrected preprocessing. This is reproducibility evidence only;
the image has no researcher-adjudicated ground truth. The full interpretation
is in [`docs/CELLPOSE_COMPATIBILITY.md`](../docs/CELLPOSE_COMPATIBILITY.md).

Manual corrections use zero-based coordinates on the full source-resolution
grid. Deleting an instance selects the label under one pixel; adding a polygon
creates one new instance and rejects overlap with an existing instance. The
engine recalculates sequential labels, measurements, count, confluence,
structural quality, and the overlay after every apply, undo, or redo:

```json
{"id":"delete","method":"delete_instance","params":{"result_id":"<opaque>","x":65,"y":65}}
```

```json
{"id":"draw","method":"add_polygon","params":{"result_id":"<opaque>","points":[{"x":10,"y":10},{"x":30,"y":10},{"x":20,"y":30}]}}
```

`undo_correction` and `redo_correction` accept only `result_id`. Correction
operations, points, and event history are bounded, and every response/export
contains the applied operations and audit events. `discard_result` accepts a
`result_id` and idempotently releases its cached arrays when a source is removed.

```json
{"id":"2","method":"export","params":{"result_id":"<opaque>","directory":"/chosen/folder","basename":"sample-01","options":{"summary_csv":true}}}
```

The selected existing directory receives one atomically published `_loci`
bundle directory. Explicit options can independently select an overlay PNG, an
integer label-mask TIFF, a per-cell measurements CSV, a simple image/count CSV,
and an analysis JSON. Omitting `options` retains the original overlay, labels,
measurements, and analysis selection. Every bundle also contains the independent
non-image `loci-export.json` marker so recursive import can exclude generated
output reliably. Analysis JSON contains the source fingerprint (without its
absolute path), settings, engine version, timestamps, selected profile and
backend provenance, metrics, corrections, and selected artifact hashes. Source
images are never modified. Existing exports are not overwritten; a numeric
suffix is selected for the complete bundle when needed.

For predictable desktop memory use, Loci 0.1 rejects a source above 30 million
pixels or 512 MiB after decoding. The export-result cache is bounded by both
entry count and an estimated 384 MiB of full-resolution arrays; evicted result
IDs are reported to the renderer instead of remaining as stale export actions.
