# Loci ONNX model package format

**Status:** executable engine subset, 2026-09-07. Passing these checks proves
technical compatibility with the recorded runtime. It does not prove biological
accuracy, clinical validity, fitness for a new acquisition domain, or permission
to redistribute a model.

Loci accepts a local directory containing plain regular files and exactly one
description: a native `loci-model.json` or a BioImage.IO 0.5 `rdf.yaml`. The
engine never downloads a referenced asset. It hashes every package member,
rejects links and subdirectories, and imports a qualified package with an atomic
local directory rename.

The first executable profile is intentionally small:

- one static `float32` input and one static `float32` output;
- explicit `BCYX` axes with batch size one;
- semantic 2D probability output on the input spatial grid;
- explicit source-channel indices, Y/X scale, and unit;
- CPU-only ONNX Runtime with sequential execution and one intra/inter-op thread;
- standard ONNX domains, no local functions, no control flow, no external data,
  and an audited operator subset;
- bounded files, tensors, graph nodes, inferred graph memory, and run memory;
- embedded, hashed `.npy` test tensors loaded with `allow_pickle=False`; and
- halo-cropped tiling with declared padding.

Packages outside this profile are unsupported rather than silently adapted.
Extending the profile requires review and regression coverage for the new axes,
operators, preprocessing, output semantics, and memory behavior.

## Native manifest

The native description is strict JSON. Unknown fields and non-finite numbers
are rejected. This example shows all fields:

```json
{
  "schema_version": "loci.model-package/1",
  "id": "example-segmentation",
  "version": "1.0.0",
  "task": "semantic-segmentation",
  "model": {
    "source": "model.onnx",
    "sha256": "<lowercase SHA-256>",
    "opset_version": 18
  },
  "input": {
    "id": "raw",
    "axes": "BCYX",
    "dtype": "float32",
    "shape": [1, 2, 256, 256],
    "channels": [
      {"name": "declared-channel-a", "source_index": 1},
      {"name": "declared-channel-b", "source_index": 0}
    ],
    "scale_yx": [0.5, 0.5],
    "scale_unit": "um"
  },
  "output": {
    "id": "probability",
    "axes": "BCYX",
    "dtype": "float32",
    "shape": [1, 1, 256, 256],
    "channels": [{"name": "foreground", "source_index": 0}],
    "scale_yx": [0.5, 0.5],
    "scale_unit": "um",
    "semantics": "probabilities"
  },
  "preprocessing": [
    {"id": "ensure_dtype", "kwargs": {"dtype": "float32"}},
    {
      "id": "zero_mean_unit_variance",
      "kwargs": {"axes": ["channel", "y", "x"], "eps": 0.000001}
    }
  ],
  "tiling": {
    "input_yx": [256, 256],
    "halo_yx": [16, 16],
    "padding": "reflect"
  },
  "postprocessing": [
    {"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}
  ],
  "labels": {"threshold": 0.5, "channel": 0},
  "reference": {
    "input": {"source": "reference-input.npy", "sha256": "<SHA-256>"},
    "output": {"source": "reference-output.npy", "sha256": "<SHA-256>"},
    "rtol": 0.001,
    "atol": 0.001,
    "mismatched_elements_per_million": 0
  },
  "citations": [
    {"text": "Model and method", "doi": "10.example/model"}
  ],
  "rights": {
    "license": "declared licence",
    "redistribution": "separate reviewed conclusion",
    "commercial_use": "separate reviewed conclusion",
    "training_data": "source and lineage statement"
  },
  "validation": {
    "status": "unvalidated",
    "summary": "Exact scope and limits of scientific validation."
  }
}
```

`zero_mean_unit_variance` may use per-sample statistics, as above, or fixed
`mean` and `std` lists. The inference record stores the resolved per-tile values.
`sigmoid` is the only additional postprocessing operation. A package may omit
`labels` when no reviewed probability-to-label rule exists; Loci then returns
raw probabilities and an explicit `None` label result.

Scale is a scientific contract. The current runtime rejects a source whose
declared scale or unit differs from the model. It does not silently resample.

## BioImage.IO 0.5 adapter

The adapter reads RDF format `0.5.x` as local YAML metadata. It rejects YAML
aliases and duplicate keys. Only one ONNX weight entry, one input, one output,
fixed `batch, channel, y, x` axes, embedded hashed test tensors, and matching
input/output spatial grids are executable. Other weight formats, external ONNX
data, URLs in executable file references, optional/chained inputs, parameterized
input sizes, and unknown preprocessing or postprocessing operations are refused.

The adapter maps standard BioImage.IO `ensure_dtype`,
`zero_mean_unit_variance`, `sigmoid`, output-axis halo, test tensors, citations,
licence, training-data ID, and reproducibility tolerance into the same internal
contract. A BioImage.IO licence string remains a supplier declaration. Loci
records redistribution and commercial-use conclusions as requiring independent
review.

BioImage.IO conformance is broader than this Loci execution profile. A package
can be valid BioImage.IO and still be correctly refused by Loci.

## Qualification and use

The engine exposes four separate operations in
`loci_engine.model_packages`:

1. `inspect_model_package` parses, bounds, and hashes local metadata and files
   without importing the optional ONNX runtime.
2. `run_reference_test` checks the ONNX graph with full ONNX checker validation,
   creates the fixed CPU session, applies declared preprocessing/postprocessing,
   crops the halo, and compares the supplied output with its declared tolerance.
3. `preview_inference` runs the same bounded numerical route with
   `adopted: false` in the returned record. It first repeats the package
   reference qualification and records that result.
4. `run_inference` returns `CYX` float32 probabilities, optional `YX` uint8
   labels, and the exact package, runtime, provider, source mapping,
   preprocessing, tiling, and output record. It also requires a passing
   reference qualification in the same call.

`import_model_package` qualifies both the source and copied bytes before atomic
adoption into an existing managed-model root. Existing package IDs/versions are
never overwritten.

Install the optional runtime with `uv sync --extra onnx`. Core imports and
`runtime_status()` remain usable when that optional dependency group is absent.

Before a model is offered for research use, retain three separate decisions:

- **Technical compatibility:** exact package/model/metadata hashes, ONNX and
  ONNX Runtime versions, CPU provider, reference comparison, memory budget, and
  selected-preview result.
- **Scientific validation:** intended biology and acquisition domain, independent
  data hierarchy, metrics, failure modes, thresholds, and review state.
- **Usage rights:** model licence, code/dependency licences, training-data
  lineage, redistribution, commercial-use conclusion, attribution, and reviewer.

Supplier reference tensors and a visually plausible preview cannot substitute
for the latter two decisions.

Lead integration review added a pre-allocation NumPy header check and a static
allocation proof for every allowed ONNX operator. Resize/Slice/Unsqueeze shape
expressions must resolve entirely from fixed shapes or bounded constants;
image-dependent allocation and misleading output shape annotations are rejected.
The package total is capped at 1 GiB. The conservative allocation accounting
for the real Zenodo reference now requires a 2 GiB requested budget; rerunning
that reference on the hardened tree retained zero mismatches and maximum
absolute error 3.445148468017578e-05. The earlier 1 GiB run above belongs to the
pre-hardening implementation and is not its current memory-budget qualification.

## Shared research-workflow evidence

The shared research layer adds three path-free operations around the package
runtime: `model_list`, `model_preview`, and `model_run`. A separate trusted
`import_model(workbench, path, working_bytes)` call is the only operation that
accepts a filesystem path. It creates private `0700` model storage inside the
study, runs the embedded reference test before and after the atomic copy, and
stores the managed path only in the local project database.

A preview uses `Workbench.load_scalar` for every explicitly mapped model input
and raw measurement channel, plus one explicitly chosen source channel for its
display. The response includes a bounded PNG that overlays clipped model
probability and label boundaries on that display channel. Its chosen channel,
resolved display mapping, PNG hash, and display-only status are recorded; the
PNG and its normalization never become quantitative model inputs. The persisted
preview receipt binds the source ID
and SHA-256, resolved crop/T/Z/level, package/model/metadata hashes, exact model
input-to-source channel mapping, source and used physical scale, runtime,
preprocessing, tiling, package postprocessing, selected probability channel,
probability threshold, components or watershed settings, output hashes, and
raw-channel measurement hash. It records the complete registered source affine
geometry. An explicit scale override is limited to the model-input compatibility
declaration. Since no pixels are resampled, segmentation settings, measurements,
and result provenance retain the registered source geometry. RGB components are rejected as biological
channels. A source/model scale mismatch is rejected unless the request records
an explicit scale override declaration; the workflow never silently resamples.

`model_run` accepts only the preview ID and SHA-256. It reloads the managed
package, rehashes the source, repeats reference qualification and inference,
and requires the complete receipt and output hashes to reproduce before
publishing probabilities, the selected probability plane, labels, and raw
selected-channel measurements through `ResearchProject.save_result`. A preview
does not create a result or imply adoption. Immediately before staging and again
inside the final result transaction, publication rechecks the exact preview
revision, managed-model revision and package hashes, and source fingerprint.

The 2026-09-07 workflow tests use generated synthetic source images and both a
native ONNX package and an independently constructed, previously unseen
BioImage.IO 0.5 package. They cover managed-path containment, path-free DTOs,
reference mismatch, preview/run numerical parity, source and model invalidation,
exact preview binding, explicit physical-scale override, raw channel
measurements, RGB rejection, and separation of technical compatibility,
scientific validation, and usage rights.

The pre-downloaded Zenodo package at
`/tmp/loci-release-run/models/nuclei-segmentation-boundary-v7-loci` was also
requalified on 2026-09-07 with the current static graph-allocation proof and a
2 GiB working budget. Package
`nuclei-segmentation-boundary-model` version `0.1.0-zenodo-v7` had package
SHA-256 `94259d554d02f43c4d5fa116f0e9e647be4be5c7ed00fb7555b141a9e9f2937b`
and model SHA-256
`df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44`.
ONNX 1.22.0 and ONNX Runtime 1.29.0 on `CPUExecutionProvider` reproduced the
`[1, 2, 224, 224]` float32 reference with zero mismatched elements and maximum
absolute error `3.445148468017578e-05` at `rtol=0.001, atol=0.001`.

That run establishes current technical compatibility for the exact package and
runtime only. Its manifest remains `unvalidated`: it supplies no Loci
biological, acquisition-domain, cross-hardware, or clinical validation. The
declared CC-BY-4.0 terms, attribution, training-data lineage, redistribution,
and commercial-use conclusions still require independent human review.
