# Loci development beta

The 0.2 development candidate is being prepared for **macOS Apple Silicon**.
The release tag is `v0.2.0-beta.1`; the internal desktop and engine version is `0.2.0`.
Its [release page](https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.1)
will contain the application archive, checksums, software inventories and dependency licences.

## What's new

This version adds independent image windows, object populations and statistics,
external labels, correction effects, visual workflows and a persistent terminal
interface. It also improves plane navigation, recipe resource controls and local
agent setup. See the [changelog](../CHANGELOG.md) and [user guide](USING_LOCI.md).

## Build and checks

Candidate source and package checks are in progress. The final release record
will identify the exact source, application and worker, with results from the
packaged journeys. A source test result does not qualify an application binary.

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
