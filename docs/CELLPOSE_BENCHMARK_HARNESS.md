# Cellpose compatibility benchmark harness

## Purpose and claim boundary

`scripts/cellpose_compatibility_benchmark.py` is a developer-side compatibility
and performance harness for Loci's existing analysis worker. It sends the same
`segment` requests used by the desktop application; it does not import Cellpose
directly, reproduce preprocessing, or implement another segmentation path.

The resulting JSON records unadjudicated instance counts and Loci's
`structural_sanity_only` mask checks. It has no reference-annotation input and
does not measure biological performance. A stable count across repeats is a
runtime reproducibility observation, not evidence that the count is correct.
Use the separate locked validation protocol and researcher-reviewed instances
before changing a model's evidence state.

## Safety properties

- Every source is supplied through a repeated, absolute `--image` path. The
  harness never scans a directory or discovers additional data.
- The selected checkpoint must match the profile's exact byte count and
  SHA-256. `cpsam` cannot be run as `cellpose-sam-v2`, and `cpsam_v2` cannot be
  run as `cellpose-sam`.
- Symbolic-link checkpoints, images, and output reports are rejected.
- The checkpoint is copied through the worker's existing verified-import
  method into a temporary isolated model home. Loci's persistent model store is
  not read or changed. Allow at least 1.3 GB of temporary free space.
- The source SHA-256 is passed to every `segment` request and recomputed before
  publication. The checkpoint and optional settings file are also recomputed.
- `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are supplied to the worker.
  No checkpoint is downloaded.
- The report is written and synced as a temporary file, then published in one
  filesystem operation. Existing reports are preserved unless `--overwrite`
  is explicit.
- If any path, hash, profile, model, runtime, settings, source, count receipt,
  or structural-status contract differs from the expected worker response, the
  run stops and no report is published.

The report contains the authorized absolute source, checkpoint, settings, and
engine-interpreter paths for local reproducibility. Review or redact those
paths before sharing a report outside the lab.

## Run

First install the exact optional runtime into the source-development engine:

```bash
cd /absolute/path/to/Loci/engine
uv sync --extra dev --extra cellpose
```

Then run from the repository root with only explicitly authorized inputs:

```bash
cd /absolute/path/to/Loci
engine/.venv/bin/python scripts/cellpose_compatibility_benchmark.py \
  --image /absolute/path/to/authorized-image-01.jpg \
  --image /absolute/path/to/authorized-image-02.tif \
  --profile cellpose-sam \
  --checkpoint /absolute/path/to/official-cpsam \
  --device mps \
  --warm-runs 2 \
  --output /absolute/path/to/cpsam-compatibility.json
```

Use `--profile cellpose-sam-v2` only with the exact official `cpsam_v2`
artifact. The script rejects a cross-profile checkpoint before starting the
worker. The default engine interpreter is
`engine/.venv/bin/python`; an alternate absolute interpreter containing the
installed `loci_engine` worker can be selected with `--engine-python`.

The frozen website-compatible settings are used unless an explicit JSON object
is supplied:

```json
{
  "max_edge_px": 1000,
  "niter": 250,
  "flow_threshold": 0.4,
  "cellprob_threshold": 0.0
}
```

```bash
engine/.venv/bin/python scripts/cellpose_compatibility_benchmark.py \
  --image /absolute/path/to/authorized-image.jpg \
  --profile cellpose-sam \
  --checkpoint /absolute/path/to/official-cpsam \
  --settings-json /absolute/path/to/settings.json \
  --output /absolute/path/to/report.json
```

Overrides are merged onto the complete pinned defaults and validated before
the worker starts. `--device` overrides a `device` field in the JSON when both
are present. The worker validates the complete settings again.

## Cold and warm phases

The harness provisions the verified checkpoint once, then creates a fresh
worker for each image:

1. `health` and `cellpose_status` establish the exact engine, Cellpose runtime,
   checkpoint, profile, and available-device contract.
2. **Cold** is the first end-to-end `segment` request in that fresh worker. The
   Cellpose runtime has been inspected, but its model cache is empty.
3. **Warm** repeats the same source, source hash, profile, checkpoint, settings,
   and requested device in the same worker. `--warm-runs` accepts 1–10 repeats.
4. Every ephemeral result is explicitly discarded after its bounded provenance
   has been recorded.

`worker_round_trip_seconds` includes image loading, inference, source-grid
restoration, metrics, structural checks, preview/overlay rendering, JSON
serialization, and transport. It is an application-path timing, not a
model-kernel-only timing. Device fallback is retained in each run's runtime
record rather than hidden.

## Report contents

The versioned `loci.cellpose-compatibility-benchmark/v1` document records:

- source absolute path, byte size, and SHA-256;
- checkpoint path, profile, artifact ID, byte size, and SHA-256;
- engine version, exact Cellpose version, host platform, and device capability;
- complete resolved settings;
- isolated provisioning status and timing;
- per-image cold and warm end-to-end timings;
- requested/resolved device and fallback reason;
- preprocessing mode and inference scale;
- technical instance count, structural status, and structural flags; and
- exact-repeat count and structural-status consistency.

It intentionally omits masks, previews, measurements, and base64 image data.
Those remain in the transient worker response and are discarded rather than
being copied into the report.

## Deterministic tests

The harness unit tests use tiny temporary byte fixtures and synthetic worker
receipts. They do not import Cellpose, provision a real checkpoint, or open lab
images:

```bash
cd /absolute/path/to/Loci
engine/.venv/bin/python -m pytest -q \
  scripts/tests/test_cellpose_compatibility_benchmark.py
engine/.venv/bin/python -m ruff check \
  scripts/cellpose_compatibility_benchmark.py \
  scripts/tests/test_cellpose_compatibility_benchmark.py
```

No protected or lab source data was used while implementing these tests.
