# Loci native-model pipeline

This directory is an isolated, developer-side pipeline for training Loci-owned
instance-segmentation weights from random initialization. It is not imported by
the shipped desktop application or analysis worker.

The pipeline is deliberately fail-closed:

- input images and masks are resolved only beneath explicit read-only roots;
- manifest paths must be relative and cannot contain traversal components;
- an active acquisition group cannot cross train, validation, and test splits;
- duplicate active image or mask content hashes are rejected across all splits;
- quarantined samples are indexed but never loaded for training or evaluation;
- training refuses a manifest unless its rights block explicitly permits both
  commercial training and redistribution of derived weights;
- the output directory must be outside both source roots;
- every checkpoint, ONNX model, and profile records hashes and dataset lineage;
- all reported scores are named **pseudo-label agreement** unless the manifest
  separately identifies an adjudicated reference set with an explicit
  `adjudication_record_id`.

## Manifest

```json
{
  "schema_version": "1.0",
  "dataset": {
    "provenance_label": "historical-cellpose-pseudo-label-not-ground-truth",
    "rights_id": "rights_0123456789abcdef01234567",
    "rights": {
      "source_images_for_commercial_training": "cleared",
      "segmentation_labels_for_commercial_training": "cleared",
      "derived_weights_for_redistribution": "cleared",
      "commercial_training_eligible": true,
      "redistributable_weights_eligible": true,
      "basis": "reviewed rights record"
    }
  },
  "split_rules": [],
  "summary": {},
  "sources": [
    {
      "source_id": "src_0123456789abcdef01234567",
      "relative_path": "acq-001/frame-001.tif",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "width": 1024,
      "height": 768,
      "channels": 3,
      "dtype": "uint8",
      "format": "TIFF",
      "acquisition_group": "acq-001",
      "rights_id": "rights_0123456789abcdef01234567",
      "split": "train",
      "qc_flags": [],
      "labels": [
        {
          "label_id": "lbl_0123456789abcdef01234567",
          "relative_path": "acq-001/frame-001_mask.tif",
          "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "kind": "mask",
          "variant": "default",
          "width": 1024,
          "height": 768,
          "dtype": "uint16",
          "instance_count": 42,
          "instance_ids_contiguous": true,
          "transform_type": "identity",
          "provenance_label": "historical-cellpose-pseudo-label-not-ground-truth",
          "qc_flags": []
        }
      ]
    }
  ]
}
```

The manifest is the grouped-source artifact produced by the engine-side
training-manifest builder. Supported active splits are `train`, `validation`,
and `test`. Quarantined sources and their label variants are validated as
metadata but never resolved or opened. Active sources must have exactly one
QC-clean label, contiguous positive instance IDs, declared hashes, and the same
rights record as the dataset.

For `identity`, the raw and mask dimensions must match. For a reviewed
`aspect_preserving_resize`, only the decoded raw image is aligned onto the
declared mask grid. The aligned image and instance mask are then downsampled
together in memory, never enlarged, to a maximum edge of 1000 px. Image
resampling is antialiased bilinear; mask resampling is nearest-neighbour and
must preserve every declared instance ID and count or the run fails. Source
files are never rewritten. Exported profiles require predictions to be restored
to the source-resolution output grid.

## Reproducible run

The supported dependency matrix is:

- Python 3.11 with PyTorch 2.1.x (the pinned Vanda/reproducibility profile);
- Python 3.11 or 3.12 with PyTorch 2.2.x (the Python 3.12-compatible path).

PyTorch 2.1 does not publish a Python 3.12 wheel. The package therefore allows
PyTorch `>=2.1,<2.3` while the Vanda launcher should use Python 3.11 when exact
2.1.x reproduction is required. The local/macOS `uv.lock` resolves PyTorch
2.2.2; it is not the Vanda installation recipe.

Create one of those environments, then:

```bash
python -m loci_modeling validate-manifest \
  --manifest MANIFEST.json \
  --raw-root RAW_ROOT \
  --mask-root MASK_ROOT

python -m loci_modeling train \
  --manifest MANIFEST.json \
  --raw-root RAW_ROOT \
  --mask-root MASK_ROOT \
  --output-dir RUN_OUTPUT \
  --profile-id loci-cell-culture-v1 \
  --display-name "Loci cell culture v1" \
  --seed 20260829
```

The test split is locked by default and is not even resolved or hash-read by a
training run. Add `--evaluate-test` only for an explicitly authorized test-set
release after the checkpoint has been selected entirely from validation loss.

The output contains the exact resolved run configuration, a relative-path-only
manifest snapshot, atomic epoch checkpoints, the best checkpoint, split-level
agreement reports, a runtime-verified ONNX model, detailed model metadata, and
an engine-compatible path-free profile containing the model SHA-256 and rights
lineage. The exported profile remains `unavailable` until the shipped engine
implements its separately reviewed ONNX backend and the model clears release
validation.

Held-out reports include overall and per-acquisition-group summaries, instance
AP/F1 at IoU 0.50 and 0.75, and the p90 absolute percentage count error. The
signed count bias is the macro mean of per-image percentage errors; raw mean
cell-count bias is reported separately. Zero-reference images are reported
separately and excluded from percentage metrics. Deterministic validation
sampling covers every validation source at least once before checkpoint
selection.

The initial network is a compact residual U-Net with foreground, boundary, and
two centre-offset heads. Patches are sampled deterministically with a bias
toward labelled cells; augmentation is also indexed deterministically.
Foreground, boundary, and centre-offset targets are created on each complete
preprocessed instance mask before cropping, then cropped and spatially
transformed with correct offset-vector rotation. The native profile retains
border cells. It does not claim to measure biological viability from an
unstained brightfield image.

Install the export dependencies for release runs. `--skip-onnx-export` exists
only to make small developer smoke tests possible; it must not be used for a
candidate release. Training reproducibility covers the recorded software,
seed, configuration, and deterministic operators. Exact floating-point
identity across different GPU architectures is not promised. Release export
compares PyTorch and ONNX Runtime numerically on two dynamic shapes and also
requires identical postprocessed counts.

Before a real cluster run, submit
[`scripts/vanda_gpu_smoke.pbs`](scripts/vanda_gpu_smoke.pbs) to prove that the
allocated GPU can complete a strict-determinism forward/backward/optimizer
step. Next run the fixed, test-locked
[`scripts/vanda_real_data_smoke.pbs`](scripts/vanda_real_data_smoke.pbs) to
exercise manifest verification, a tiny train/validation pass, and release ONNX
export against the staged corpus. Only after both smokes pass should
[`scripts/vanda_train.pbs`](scripts/vanda_train.pbs) be used for a versioned
training run. All launchers expect the pinned PyTorch module in
`LOCI_PYTORCH_MODULE` and an isolated, prebuilt environment in
`LOCI_MODEL_ENV`.

Build a wheel from the exact reviewed checkout on the workstation, record its
SHA-256 digest, and transfer that immutable artifact to Vanda. This keeps the
cluster install independent of package-index access for build backends:

```bash
uv build --wheel --out-dir .loci/modeling-dist modeling
export LOCI_MODEL_WHEEL=.loci/modeling-dist/loci_modeling-0.1.0-py3-none-any.whl
shasum -a 256 "${LOCI_MODEL_WHEEL}"
scp "${LOCI_MODEL_WHEEL}" \
  vanda:VANDASCRATCH/repo/modeling/dist/loci_modeling-0.1.0-py3-none-any.whl
```

On Vanda, build `LOCI_MODEL_ENV` with the non-Torch pins in
[`constraints-vanda.txt`](constraints-vanda.txt), independently verify that the
transferred wheel digest matches the workstation value, then install without
dependency resolution so `pip` cannot replace the cluster CUDA stack:

```bash
unset PYTHONHOME PYTHONPATH
module purge
module load PyTorch/2.1.2-foss-2023a-CUDA-12.1.1
export LOCI_MODEL_ENV=VANDASCRATCH/venv
export LOCI_MODEL_WHEEL=VANDASCRATCH/repo/modeling/dist/loci_modeling-0.1.0-py3-none-any.whl
python -m venv "${LOCI_MODEL_ENV}"
source "${LOCI_MODEL_ENV}/bin/activate"
unset PYTHONPATH
python -m pip install -c modeling/constraints-vanda.txt \
  numpy onnx onnxruntime pillow scikit-image scipy tifffile
sha256sum "${LOCI_MODEL_WHEEL}"
python -m pip install --no-deps "${LOCI_MODEL_WHEEL}"
```

Both PBS launchers fail before any data access unless the loaded module exposes
CUDA-enabled `torch==2.1.2` and the exact reviewed non-Torch runtime versions.
They clear inherited Python paths and disable the user site before importing
the stack. `LOCI_EVALUATE_TEST=1` is the only Vanda launcher switch that releases
the test split; omission keeps it locked.

Submit with an explicit environment-variable allowlist. Do not use broad
`qsub -V`, and do not place credentials in these variables:

```bash
cd VANDASCRATCH/repo/modeling
export LOCI_PYTORCH_MODULE=PyTorch/2.1.2-foss-2023a-CUDA-12.1.1
export LOCI_MODEL_ENV=VANDASCRATCH/venv
qsub -v LOCI_PYTORCH_MODULE,LOCI_MODEL_ENV scripts/vanda_gpu_smoke.pbs

export LOCI_MODEL_MANIFEST=VANDASCRATCH/manifest.json
export LOCI_RAW_ROOT=VANDASCRATCH/data/raw
export LOCI_MASK_ROOT=VANDASCRATCH/data/segmented
export LOCI_MODEL_OUTPUT=VANDASCRATCH/runs/native-v1
export LOCI_PROFILE_ID=loci-lab-native-v1
export LOCI_PROFILE_VERSION=0.1.0
export LOCI_PROFILE_DISPLAY_NAME="Loci Lab Native v1"
export LOCI_CODE_REVISION=GIT_COMMIT_SHA
qsub -v LOCI_PYTORCH_MODULE,LOCI_MODEL_ENV,LOCI_MODEL_MANIFEST,LOCI_RAW_ROOT,LOCI_MASK_ROOT,LOCI_MODEL_OUTPUT,LOCI_PROFILE_ID,LOCI_PROFILE_VERSION,LOCI_PROFILE_DISPLAY_NAME,LOCI_CODE_REVISION scripts/vanda_real_data_smoke.pbs

# Use a new, absent LOCI_MODEL_OUTPUT before the full run.
export LOCI_MODEL_OUTPUT=VANDASCRATCH/runs/native-v1-full
export LOCI_EVALUATE_TEST=0
qsub -v LOCI_PYTORCH_MODULE,LOCI_MODEL_ENV,LOCI_MODEL_MANIFEST,LOCI_RAW_ROOT,LOCI_MASK_ROOT,LOCI_MODEL_OUTPUT,LOCI_PROFILE_ID,LOCI_PROFILE_VERSION,LOCI_PROFILE_DISPLAY_NAME,LOCI_CODE_REVISION,LOCI_EVALUATE_TEST scripts/vanda_train.pbs
```
