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
[`c041ff2`](https://github.com/sidd-bme/loci-app/commit/c041ff2c0c12176d492d46fc7c4c3e338e160861).
Later commits update tests, documentation and media; application runtime files are unchanged.

- [Hosted source checks](https://github.com/sidd-bme/loci-app/actions/runs/38200055593)
  at `9972d69`: typecheck, 1,319 desktop tests, 16 packaging tests, 1,671 engine tests
  (12 skips), 72 Python harness tests and 60 modeling tests pass.
- The exact app passes deep strict signature verification and all five packaged
  core journeys: analysis/export/reopen, shared workspace controls, field assays,
  external labels and correction effects.
- The additional volume journey passes shared-display checks, independent engine
  range checks, graphics-context recovery, histogram controls and figure export.
  Measured orbit/pan/zoom p95 and p99 frame intervals remain below the defined
  50/100 ms budgets on the tested M1 Mac.
- The ZIP reproduces the app tree exactly. Both CycloneDX inventories and the
  complete dependency-licence archive pass validation against that same app.

| Artifact | SHA-256 |
| --- | --- |
| macOS ZIP | `dc1e8dd9ee265d9ff1b5ae41e55ebea1d04027b57c1bb6641aad7c4005d8151f` |
| Application archive (`app.asar`) | `056f65701b9a83594419cd58da8b92c398c06bb88d3faf8b4fc90b13f4e971c5` |
| Frozen engine | `4d85857bf74c18cc1f8f8e237054fe70049769d9a80dbc49e8355b311fb4273d` |

The release assets include [checksums](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.1/SHA256SUMS.txt),
[app and archive evidence](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.1/macos-release-evidence.json)
and a [development verification record](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.1/development-verification.json).
The updated volume harness is recorded at `83718de`. These records distinguish
source-suite checks from checks of the actual downloadable binary.

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
