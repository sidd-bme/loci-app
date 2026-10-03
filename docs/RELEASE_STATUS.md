# Loci beta release status

The published download is **v0.1.0-beta.1** for **macOS Apple Silicon**. Its
internal application version is `0.1.0`. Source and screenshots can include
later development work; they do not establish qualification of a new package.
See the [release page](https://github.com/sidd-bme/loci-app/releases/tag/v0.1.0-beta.1)
for downloads and the evidence shipped with that beta.

## Published artifacts

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

## Scope and limitations

The beta provides image viewing, bounded native source routes, local classical
analysis and explicitly provisioned model routes. The [capability matrix](CAPABILITY_MATRIX.md)
defines supported subsets and refusals. Source tests and packaged fixture journeys
verify software behavior only for their tested source and artifact identities;
they do not establish biological accuracy, clinical suitability or qualification
of every supported source variant.

- The macOS beta uses an ad-hoc integrity signature and is **unnotarized**. Apple
  Developer ID trust and independent clean-Mac attestation remain unresolved.
  Follow the [installation guide](INSTALLATION.md) for Gatekeeper approval.
- First-launch delays of approximately **75–85 seconds** were observed on an
  Apple Silicon M1 with 8 GB RAM. This is an observation on that host, not a
  startup-time guarantee. Cold Cellpose performance also remains an open gate.
- Cellpose checkpoints are supplied explicitly by users and are never bundled
  or downloaded automatically. Technical compatibility does not establish
  biomedical validation or commercial rights to model weights; see
  [Cellpose compatibility](CELLPOSE_COMPATIBILITY.md).
- No Windows, Linux or Intel Mac installer is offered in this beta. Maintained
  build scripts and hosted workflow configuration do not qualify a distributable
  package. Windows signing, clean-host installer/app journeys and applicable
  dependency-source obligations remain release gates; see [building Loci](BUILDING.md).
- Very large images and volumes have finite decoding and rendering limits.
  Inspect source calibration, axes, analysis scope and review state before using
  measurements. Counts of tiles, planes or objects are not independent specimen
  or patient counts.

Loci is research software, not a medical device. It is not FDA/CE cleared and is
not intended for diagnosis, patient management or clinical decision-making.
Source images remain immutable; derived work belongs in project, study or export
artifacts. [Release requirements](RELEASE_CONTRACT.md) remain applicable to future
packages.
