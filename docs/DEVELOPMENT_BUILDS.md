# Development build numbering

Development packages are unreleased working builds. They do not create a beta or
release. Desktop and engine compatibility remain `0.2.0`; the latest published
beta remains `v0.2.0-beta.2` until a separately authorized release changes it.

`desktop/development-build.json` records the development channel and a numeric
counter, initially **Development build 1**. Increment it once for each future
accepted development integration, before qualification. Rebuilding that integration
does not increment it. Private and public source packages for the same accepted
integration use the same counter and retain their own exact source revisions.
Numbers are integers from 1 through 9999. Reaching the limit requires a reviewed
numbering change; numbers must never wrap or silently reset.

The explicit local packaging commands select development identity:

```sh
cd desktop
npm run package:mac:local
# Existing local make/Windows lifecycles also select development identity.
```

Forge sets numeric `buildVersion` (macOS `CFBundleVersion`) to `1.0.0` for build 1.
The package version and macOS `CFBundleShortVersionString` remain `0.2.0`. Native
**About Loci** displays the unreleased development number, 12-character source
revision, and whether the source checkout was modified. Renderer and scientific
payload version contracts are unchanged. Unpackaged runs identify themselves as
unpackaged development without claiming a recorded source revision.

At packaging configuration time, local Git supplies the full source commit,
that commit's tree, and a working-tree dirty flag (tracked and non-ignored
untracked files). Git is required for a development package; there is no invented
fallback revision. A dirty flag is not a digest of modified bytes. Keep the source
stable throughout the build and prefer reviewed, committed source.

The inspectable `Contents/Resources/loci-build-identity.json` (or Windows/Linux
`resources/loci-build-identity.json`) contains only the schema, channel, counter,
bundle and compatibility versions, source commit/tree and dirty flag. It contains
no branch, remote, host, path, timestamp, or laboratory metadata. A matching marker
inside packaged `app.asar/package.json` requires this identity; startup refuses
missing or malformed identity, incompatible versions and unexpected resources.
The resource is written exclusively before signing; existing files are rejected.

Unsigned or ad-hoc signing alone is not release qualification. Existing release
commands retain their signing/distribution gates and default release identity;
they never acquire a development label automatically. `LOCI_BUILD_CHANNEL=release`
explicitly retains the previous identity behavior for a local qualification build;
it does not authorize a release. `LOCI_BUILD_CHANNEL=development` is accepted only
with an explicit local signing/packaging mode. Unsupported channels fail closed.

The display label and source record help identify a build. They do not replace
executable, `app.asar`, worker and receipt hashes, frozen-worker checks, signing
verification, or packaged journeys in [the build procedure](BUILDING.md). A source
test does not qualify a packaged application.
