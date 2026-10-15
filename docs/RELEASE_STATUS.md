# Loci development beta

The current development beta is **0.2.0 for macOS Apple Silicon**.
The release tag is `v0.2.0-beta.1`; the internal desktop and engine version is `0.2.0`.
Its [release page](https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.1)
contains the application archive, checksums, software inventories and dependency licences.

## What's new

This version adds independent image windows, object populations and statistics,
external labels, correction effects, visual workflows and a persistent terminal
interface. It also improves plane navigation, recipe resource controls and local
agent setup. See the [changelog](../CHANGELOG.md) and [user guide](USING_LOCI.md).

## Build and checks

The app was built from clean public source
[`cc24ebc`](https://github.com/sidd-bme/loci-app/commit/cc24ebcbf69e3ce4bdf7bde7edf8ea198731ad48).
The release-preparation commits following that build updated tests,
documentation and media without changing its runtime. Newer source work is
listed under **Unreleased** in the [changelog](../CHANGELOG.md); it does not
replace or requalify the published download.

- [Hosted source checks](https://github.com/sidd-bme/loci-app/actions/runs/38202925977)
  at `90a7dc8`: typecheck, 1,321 desktop tests, 16 packaging tests, 1,672 engine tests
  (12 skips), 72 Python harness tests and 60 modeling tests pass.
- The exact app passes deep strict signature verification and all five packaged
  core journeys: analysis/export/reopen, shared workspace controls, field assays,
  external labels and correction effects.
- The additional volume journey passes shared-display checks, independent engine
  range checks, graphics-context recovery, histogram controls and figure export.
  Measured orbit/pan/zoom p95 and p99 frame intervals remain below the defined
  50/100 ms budgets on the tested M1 Mac.
- The full segmentation, manual-correction, error-recovery, recursive-batch and
  export journey passes, including pixel-exact label comparisons and ordinary
  pointer interactions. Folder import also passes.
- The ZIP reproduces the app tree exactly. Both CycloneDX inventories and the
  complete dependency-licence archive pass validation against that same app.

| Artifact | SHA-256 |
| --- | --- |
| macOS ZIP | `ae6e32327e64ebaecb7c78cff6e4aae5edc52f83794c74b764af4d457fc63e1d` |
| Application archive (`app.asar`) | `e7debc692d298a6a97b6fa0217a8721997b9ca3266af48082b710e7006ff6086` |
| Frozen engine | `4d85857bf74c18cc1f8f8e237054fe70049769d9a80dbc49e8355b311fb4273d` |

The release assets include [checksums](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.1/SHA256SUMS.txt),
[app and archive evidence](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.1/macos-release-evidence.json)
and a [development verification record](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.1/development-verification.json).
The correction-input harness is recorded at `932256e`; the volume harness retains
the shared-display checks from `83718de`. These records distinguish source-suite
checks from checks of the actual downloadable binary.

The passing local run opened in 1.92 seconds and displayed the first fixture in
2.79 seconds. An earlier launch took 11.63 seconds and exceeded the 8-second
budget; the retained verification record includes that failure. First-launch
performance is not guaranteed by the later passing run.

## Platform and model notes

- This is an explicitly published **development beta**, with an ad-hoc integrity
  signature. It is **unnotarized**; Developer ID trust and independent clean-Mac
  verification remain unavailable. The trusted-release `public_ready` gate is
  not claimed. Follow the [installation guide](INSTALLATION.md) for first launch.
- Cellpose checkpoints are supplied by users. They are never bundled or downloaded
  automatically. See [Cellpose compatibility](CELLPOSE_COMPATIBILITY.md) for setup
  and model-specific terms.
- No Windows, Linux or Intel Mac installer is included. See [building Loci](BUILDING.md)
  for source and platform requirements.

The [capability matrix](CAPABILITY_MATRIX.md) describes supported formats and
operations. Software checks use defined fixtures; they do not establish
biological accuracy or clinical suitability. Loci is research software and is
not intended for diagnosis or patient management.

## Previous release: v0.1.0-beta.1

| Archive | SHA-256 |
| --- | --- |
| `Loci-0.1.0-beta.1-darwin-arm64-repack1.zip` (recommended) | `cc0fbf5503cdda76bb1cacd4f050f35fd7af773f8bc430f89b00743029bd0cd0` |
| `Loci-0.1.0-beta.1-darwin-arm64.zip` (original) | `5d1943627605ce40dfba27694a22f03b33884bd42d703a1d49ca054d2f926ece` |

The release record identifies identical application binaries, signatures and
analysis behavior in both archives. `repack1` removes archive-level AppleDouble
metadata. The release also provides `macos-release-evidence-repack1.json`,
`desktop.cdx.json`, `engine.cdx.json` and `dependency-licences.zip`. These recorded
identities refer to the published beta; documentation cleanup does not rebuild
or requalify it. [Release evidence](RELEASE_EVIDENCE.md) describes verification
of the exact app and its dependency inventory.
