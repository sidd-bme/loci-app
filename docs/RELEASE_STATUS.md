# Loci development beta

The current development beta is **v0.2.0-beta.2 for macOS Apple Silicon**.
The internal desktop and engine version remains `0.2.0`.
The [release page](https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.2)
contains the application, checksums, software inventories and dependency licences.

## What's new

Try classical segmentation settings on explicit image regions, compare up to three
regions and three settings, and adopt the exact inspected preview. Persistent
channel controls stay above the image. Reproducible gates and named groups retain
complete membership, exact result revisions and export/reopen provenance.

Folder trees, relative-path search, breadcrumbs and folder batch selection make
larger studies easier to navigate. This beta also includes saved compute targets,
recoverable execution, explicit researcher/agent review history, and provisional
RGB review packages that preserve pending review state. See the
[changelog](../CHANGELOG.md), [user guide](USING_LOCI.md), and
[exploration and groups guide](EXPLORATION_AND_GROUPS.md).

## Build and checks

The app was built from clean public source
[`a04d83f`](https://github.com/sidd-bme/loci-app/commit/a04d83f217e67d772ace268c5cbcce70c4879423).
Subsequent release-preparation changes update the agent journey harness and release
documentation; the packaged runtime is unchanged. Local verification used
Node 24.15.0 and Python 3.12.13. Hosted CI was intentionally skipped.

- Typecheck, 16 packaging checks, 1,543 desktop tests and 2,094 engine tests pass
  (13 skips; one expected duplicate-ZIP-member warning). Ruff passes.
- All five packaged core journeys pass on the exact downloadable app: analysis,
  export and reopen; shared workspace controls; field assays; external labels;
  and correction effects with replicate weighting.
- Four additional packaged journeys pass: exploration/groups, folder browsing,
  provisional review packages and agent workbench. Checks include 10,000-member
  groups independent of the plot sample, calibrated mean validation, reusable
  gates with an unavailable unrelated source, unchanged sources and review history,
  unsupported-filesystem rejection, and actual MCP correction/review/export.
- Selected real app captures were visually inspected in dark and Paper themes,
  including narrow layouts and large text. This is engineering inspection, not
  an independent usability study.
- Strict deep ad-hoc signature verification passes. The ZIP reproduces the app
  tree exactly; CRC, both CycloneDX inventories and dependency licences pass.

The first agent journey stopped because a test selector matched both the new
compact channel control and the existing detailed control. The revised harness
checks both controls and the rerun passes on the unchanged app. The verification
record retains the failed attempt and the corrected harness identity.

| Artifact | SHA-256 |
| --- | --- |
| macOS ZIP | `a9c303fca8e804459062bb8be4024c2bd566c18757235f8430400a781c08c01c` |
| Application archive (`app.asar`) | `d68b3bafc9ee9277433521809c88683db525b7191e13c4ecf6659bc3d180b9d5` |
| Frozen engine | `ba8deeef2187ce7a71824bae53be93d818e28b990f35cdf47c9846a6578bf7ae` |

Release assets include [checksums](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.2/SHA256SUMS.txt),
[app and archive evidence](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.2/macos-release-evidence.json)
and a [development verification record](https://github.com/sidd-bme/loci-app/releases/download/v0.2.0-beta.2/development-verification.json).

## Platform and model notes

- This is an explicitly published **development beta** with an ad-hoc integrity
  signature. It is **unnotarized**. Developer ID trust, a notarization staple and
  independent clean-Mac verification remain unavailable. The trusted-release
  `public_ready` gate remains false. Follow the [installation guide](INSTALLATION.md).
- Cellpose checkpoints are user supplied and never bundled or downloaded
  automatically. See [Cellpose compatibility](CELLPOSE_COMPATIBILITY.md).
- No Windows, Linux or Intel Mac installer is included. See [building Loci](BUILDING.md).

The [capability matrix](CAPABILITY_MATRIX.md) describes supported operations.
Defined fixtures establish engineering checks, not biological accuracy or clinical
suitability. Loci is research software, not intended for diagnosis or patient management.

## Previous release: v0.2.0-beta.1

The [previous beta](https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.1)
and its evidence remain available. Its ZIP SHA-256 is
`ae6e32327e64ebaecb7c78cff6e4aae5edc52f83794c74b764af4d457fc63e1d`;
its clean build source was `cc24ebcbf69e3ce4bdf7bde7edf8ea198731ad48`.
Those historical checks do not qualify the new beta.

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
