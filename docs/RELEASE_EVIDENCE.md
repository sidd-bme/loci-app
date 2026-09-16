# macOS release evidence

`scripts/release_evidence.py` inspects an already-built Loci `.app` and writes a
stable, reviewable JSON record. It is preparation for Milestone 2, not a public
release system: the tool never signs, notarizes, uploads, publishes, creates
credentials, or grants release approval.

The report contains:

- the Git commit, clean/dirty state, and SHA-256 identities of the desktop,
  engine, and modeling lock files;
- a canonical app-tree SHA-256 over relative paths, entry types, POSIX modes,
  symlink targets, and regular-file contents;
- bundle identifier, versions, minimum macOS version, and executable
  architectures;
- deep/strict signature verification, signing mode, team, Hardened Runtime, and
  signing timestamp;
- Gatekeeper notarization and stapled-ticket states;
- the required bundled notice inventory;
- an optional distribution ZIP identity and structural check;
- optional CycloneDX SBOMs, a manifest-bound dependency-licence archive,
  clean-Mac evidence, and explicit human release authorization.

The JSON has no collection timestamp or local absolute paths. Repeated
collection from unchanged inputs and unchanged macOS verification results is
byte-for-byte deterministic. The app tree is rehashed after the macOS checks,
the declared repository is re-inspected, and every supplied evidence file is
re-fingerprinted, so concurrent replacement stops collection instead of
publishing mixed evidence. A report is not a cryptographic signature or a
substitute for a future source-to-binary build attestation. Run `collect` again
after any bundle, staple, ZIP, source, lock, or evidence change.

## Local QA report

Use an absolute output path outside the repository:

```bash
python3 scripts/release_evidence.py collect \
  --app /absolute/path/to/Loci.app \
  --output /absolute/path/to/loci-macos-evidence.json
```

This succeeds for the ad-hoc local QA package and records why it is not ready
for public distribution. It does not turn that package into a release build.

Inspect a previously generated report and verify that its recorded readiness
result and bounded subfields are internally consistent:

```bash
python3 scripts/release_evidence.py check \
  --report /absolute/path/to/loci-macos-evidence.json
```

Stored JSON is unsigned and can be copied or edited, so `check --public-ready`
always fails closed even when the recorded evidence says READY. Establish
current readiness only by rerunning `collect --public-ready` against the live
app and evidence inputs. A future signed build-attestation format may permit
offline public-readiness verification.

The output must be outside both the repository and app bundle, and it must not
alias or replace the ZIP, SBOM, licence archive, or attestation inputs. Parent
directory symlinks and existing hard-link aliases are resolved before
collection. Use `--overwrite` only when intentionally replacing an unrelated
existing regular report; a symbolic-link report is always refused.

## Generate the SBOMs and licence archive

Run the supply-chain generator against the final packaged app after signing,
notarization, and stapling. Its output directory must be outside both the
repository and app bundle:

```bash
cd /absolute/path/to/Loci
cd desktop && npm ci && cd ..
./scripts/build-engine.sh

python3 scripts/release_supply_chain.py generate \
  --app /absolute/path/to/Loci.app \
  --repository /absolute/path/to/Loci \
  --output-dir /absolute/path/to/release-supply-chain
```

The first developer invocation may install the exactly locked validator into
the isolated, ignored `scripts/release-tools/.venv`; this is explicit release
tooling, never application runtime behavior. The generator uses:

- `@cyclonedx/cyclonedx-npm` 6.0.1 from `desktop/package-lock.json`;
- `cyclonedx-bom` 7.3.1 and `cyclonedx-python-lib` 11.12.0 from
  `scripts/release-tools/uv.lock`;
- the exact macOS/Python 3.12 runtime closure installed for `loci-engine`, with
  the `cellpose` extra, while excluding tests, Linux CUDA, Windows, and
  non-embedded PyInstaller build-only dependencies;
- the locked PyInstaller version and full upstream copying text for the
  bootloader embedded in the frozen worker;
- Electron and Chromium versions read from the packaged framework; and
- every non-empty licence, notice, copying, and authorship file owned by each
  shipped npm/Python distribution, including package-level native-codec and
  third-party evidence supplied by wheels.

It writes `desktop.cdx.json`, `engine.cdx.json`, and
`dependency-licences.zip`. Both SBOMs are strict CycloneDX 1.6 documents. The
archive has fixed timestamps and ordering, an exact payload manifest, a
SHA-256 for every evidence file, and bindings to the app tree, both source
locks, and both generated SBOMs. Generation fails if a runtime dependency has
no non-empty licence evidence or if an installed version differs from its
lock. Existing outputs are not replaced without `--overwrite`.

Check unchanged artifacts without regenerating them:

```bash
python3 scripts/release_supply_chain.py check \
  --app /absolute/path/to/Loci.app \
  --repository /absolute/path/to/Loci \
  --output-dir /absolute/path/to/release-supply-chain
```

This is mechanical completeness and provenance evidence, not legal advice or
licence clearance. Upstream wheels remain responsible for the accuracy of the
third-party texts they ship; human review is still required before release.

## Fail-closed public gate

After the final Developer ID-signed, notarized, and stapled app exists, collect
all release evidence and request the gate:

```bash
python3 scripts/release_evidence.py collect \
  --app /absolute/path/to/Loci.app \
  --zip /absolute/path/to/Loci-darwin-arm64.zip \
  --sbom desktop=/absolute/path/to/desktop.cdx.json \
  --sbom engine=/absolute/path/to/engine.cdx.json \
  --license-archive /absolute/path/to/dependency-licences.zip \
  --clean-mac-evidence /absolute/path/to/clean-mac.json \
  --public-authorization /absolute/path/to/public-authorization.json \
  --output /absolute/path/to/loci-macos-evidence.json \
  --public-ready
```

The report is written for diagnosis, then the command exits with status `2` if
any gate is unmet. Public readiness requires all of the following:

- a clean Git commit and all three lock-file identities;
- `science.loci.desktop`, version/minimum-OS metadata, and at least one
  `lipo`-verified executable architecture;
- a valid Developer ID Application signature, team identifier, Hardened
  Runtime, and trusted timestamp—ad-hoc signing is rejected;
- Gatekeeper recognition as a notarized Developer ID app and a valid stapled
  ticket;
- every required bundled notice, present and non-empty;
- schema-valid CycloneDX 1.6 `desktop` and `engine` SBOMs;
- a complete checksummed dependency-licence archive whose manifest matches
  the exact app, desktop/engine locks, and supplied SBOM bytes;
- passing clean-Mac evidence bound to the exact canonical app-tree SHA-256;
- explicit human public-release authorization bound to that same app and its
  exact short version.

The distribution ZIP is optional. If supplied, it must contain exactly one
top-level app with the expected name. Loci streams its members, validates their
CRC and paths, reconstructs the same canonical tree contract used for the
on-disk app, and requires an exact digest, mode, symlink, count, and size match.
The ZIP's own bytes are fingerprinted before and after inspection; the tool
never extracts it.

## External evidence formats

Generate a preliminary report first to obtain
`application.tree.sha256`. Clean-Mac evidence is a separately owned test
attestation:

```json
{
  "schema": "loci.clean-mac-evidence/v1",
  "passed": true,
  "environment_is_clean": true,
  "app_tree_sha256": "<64 lowercase hexadecimal characters>",
  "test_run_id": "<durable clean-Mac run identifier>"
}
```

Public authorization is an explicit human decision and must not be generated
automatically by CI or by this tool:

```json
{
  "schema": "loci.public-release-authorization/v1",
  "authorized": true,
  "app_tree_sha256": "<same exact canonical app-tree SHA-256>",
  "release_version": "<CFBundleShortVersionString>",
  "authorization_id": "<durable human decision reference>"
}
```

The tool fingerprints both attestations and copies only their bounded contract
fields into the report. Mismatched app hashes or versions fail closed.

Externally supplied CycloneDX documents must still use a supported 1.4, 1.5,
or 1.6 schema and named, typed components. The standard Loci generator emits
and strictly schema-validates 1.6. The evidence collector performs its own
bounded structural check and additionally requires the licence manifest's
exact app, lock, SBOM, payload-set, per-file checksum, and ecosystem-coverage
bindings. A generic non-empty ZIP no longer passes the public gate.

## Remaining Milestone 2 gates

This tooling does not supply the Developer ID certificate or Apple notary
credentials, perform notarization, create a signed update channel, authorize a
public repository or binary release, or replace testing on a genuinely clean
Mac. It also does not provide legal approval of upstream licences. The
repository fields describe the checkout declared at collection time; the
packaged app does not yet embed a signed build attestation that
cryptographically binds it to that commit and those lock hashes. Those remain
explicit external, architectural, legal-review, and human-controlled gates.
