# Loci from the terminal

The `loci` command uses the same study, recipe, job, review and export operations
as the desktop. It is useful for repeatable analysis, shell pipelines, local
batch orchestration and inspecting saved work without opening Electron.
It does not run arbitrary Python or JavaScript inside a study.

## Start

The local macOS app includes a command at `Loci.app/Contents/Resources/bin/loci`.
In this development checkout, the launcher selects the designated current app:

```sh
./scripts/loci
./scripts/loci --help
./scripts/loci discover
./scripts/loci discover "physical transform"
./scripts/loci operation registration_preview
./scripts/loci doctor
./scripts/loci --version
```

To use the shorter command in a shell session, add the installed app's Resources/bin
directory to that session's `PATH`:

```sh
export PATH="/absolute/path/Loci.app/Contents/Resources/bin:$PATH"
loci
```

The app launcher uses its own packaged worker; it needs no separate Python
installation. Keep it inside the app. The repository launcher accepts
`LOCI_APP=/absolute/path/Loci.app` for an explicitly selected test candidate and
fails if that app has no CLI. It never silently chooses an unrelated worker.

For source development, follow [Building Loci](BUILDING.md) to install the
locked environment, then run `uv run --no-sync loci --help` in `engine/`.
The installed Python entrypoint is cross-platform. A frozen worker also accepts
`loci-engine --loci ...` (or `loci-engine.exe --loci ...` on Windows).
Only the recorded host and package are qualified by a local test receipt.

## Inspect measured objects

In an interactive `loci` session, open an existing study and query its measured
objects without writing analysis or review state:

```text
open cells.loci-study
objects --area 500:1000 --spacing 10:30 --limit 5
locate 102
```

Paths resolve relative to the process's current directory. Existing study,
symlink, source fingerprint and artifact checks still apply. These ranges are
illustrative; choose bounds in the selected result's displayed native units.
`--area` applies only to 2D area measurements; use `--volume` for 3D volumes.
`--spacing` means **nearest centroid distance**, not edge-to-edge distance.
Bounds are inclusive, finite and nonnegative. Missing filter values are excluded
and counted explicitly. Rows remain in ascending label order; `--limit` accepts
1 to 200, defaults to 5, and does not change the full matching object count.

`open` selects a result automatically only when exactly one visible,
label-bearing measurable result qualifies. With several results it shows a list
and leaves selection empty. Use `select NUMBER` or `select RESULT_ID` from that
list. A successful open or selection pins the exact result ID and revision for
later `objects` and `locate` commands. Failed or interrupted commands retain the
previous binding. A mismatched revision fails until explicit rebinding; `refresh`
reopens the same selected result and pins its current verified revision. New
correction children never replace the selected immutable parent automatically;
open and select the child explicitly to inspect it.

The same operations work outside a session:

```sh
loci objects --project cells.loci-study --area 500:1000 --spacing 10:30 --limit 5
loci locate 102 --project cells.loci-study
```

Use `--result RESULT_ID` when several results qualify, and `--revision HASH` to
require an exact binding in a one-shot command. `--json` emits the complete,
unchanged underlying `population_query` or `population_locate` receipt. Human
output shows the study, result, review state, units, missing-value accounting and
actual returned rows. Measurements use six significant digits in text; labels
and counts stay exact. These are descriptive objects in one result, not
independent biological samples. Existing `execute` remains the explicit request
route for automation and advanced population options.

### Interactive startup

Run **`loci` with no arguments** in a macOS/Linux terminal to start a session.
Particles form the three-petal Loci mark above a steady wordmark. A gentle
pulse and orbiting points continue while idle and while commands run. Type commands at `loci>`; for example,
`discover segmentation`, `guide recipe`, or `sources --project /path/to/study`.
They run through the same CLI and preserve its explicit requests and receipts.

- **Ctrl-P** pauses/resumes the logo. Its motion represents the Loci identity,
  not analysis progress; the status line names the running command and exit code.
- **Up/Down** recalls session commands; **Left/Right**, Home/End and Backspace edit.
- **Page Up/Down** reads output; **Ctrl-L** clears the visible transcript.
- **Ctrl-C** interrupts a running command, clears unfinished input, or exits an
  idle empty prompt. **Ctrl-D**, `exit`, or `quit` leaves an idle session.

The transcript retains up to 1,000 lines / 256 KiB of characters, and command
history stays in memory only. Use one-shot commands in your normal shell for redirection, complete
output capture and stdin requests; inside a session use `--request @file.json`.
Shell operators and substitutions are never evaluated. MCP and other transport
processes run outside the interactive session.

`loci --plain`, `loci --no-motion`, `NO_COLOR`, a dumb terminal or redirected
output keep the existing one-shot welcome with no terminal control sequences.
Explicit commands such as `loci discover --json` remain one-shot operations.
The persistent screen uses the standard POSIX terminal runtime; Windows retains
the one-shot welcome. This is separate from package/platform qualification.

## Vision assistants and local MCP access

In the app, open **Connect an assistant** to grant a selected source region,
response categories, operations and optional threshold/minimum-size ranges.
Interactive access includes a local Codex plugin and manual MCP configurations.
The agent cannot import files, download models, review its own results or widen
its policy. Source images return as native MCP image blocks in a v3 connection.
See [Agent access](AGENT_ACCESS.md) for exact grants and installation.

Both setup and image handoff also work without Electron:

```sh
loci agent-access --project "$LOCI_STUDY" --request @access-request.json \
  --destination /absolute/path/new-access-bundle \
  --export-root /absolute/path/permitted-exports
loci vision-handoff --project "$LOCI_STUDY" --request @image-request.json \
  --destination /absolute/path/candidate.loci-vision
```

Omit `--export-root` when neither reviewed-result export nor vision handoff export
is granted. The access request uses the same explicit fields as the native form:
`source_id`, `selection`, `recipe`, `allow_preview`, `allow_run`, `allow_export`,
`export_names`, `disclosures`, `limits`, and optionally the `interactive` object
documented in Agent access. Existing exact-recipe access remains v1 when that
object is absent. Each destination must be new; publication never overwrites it.

An image request is an explicit display, for example:

```json
{
  "source_id": "REPLACE_WITH_REGISTERED_32_CHARACTER_SOURCE_ID",
  "selection": {"x": 0, "y": 0, "width": 512, "height": 512,
                "t": 0, "c": 0, "z": 0, "level": 0},
  "channels": [{"channel": 0, "low": 0, "high": 255, "gamma": 1,
                "color": "#ffffff", "opacity": 1, "visible": true}],
  "projection": "plane",
  "max_size": 1536
}
```

Replace the ID, region and display range with values for the actual source.
Indices are zero-based. Crops have at most 2048 pixels per edge; output limits
are 64–2048 pixels. A `max` or `mean` projection requires an explicit exclusive
`z_stop` in the selection. Interleaved RGB retains the current single-plane,
8-bit display restriction. These are display renderings, not raw numerical arrays.

The handoff contains `image.png`, `context.json`, `README.md` and a hash manifest.
In the app, **Display → Export vision handoff** creates the same bundle. Upload
the image and context yourself to ChatGPT or another vision client and choose
an available model there. Creation calls no model and uploads nothing. Model
access and usage belong to that client; no subscription quota is transferred.
Keep assistant interpretations provisional and verify numerical analysis in Loci.

For an assistant connected while the app is open, enable **Display → Follow
assistant display**. Local display writes pause while saved channel revisions
are followed. Turning it off resumes local edits; stale revisions fail instead
of overwriting another writer. Camera, analysis selection and source pixels are
not controlled by the assistant's channel patch.

## Find an operation and its invocation

`loci --help` groups study, analysis, connection and terminal commands. Internal
stdio transports and resource-limited children remain callable for the app, but
are omitted from human command help.

```sh
loci discover "physical transform"
loci operation registration_preview
loci operation large_result_export --json
loci examples
```

Search matches all query words against operation names and purposes, ignoring
case. No matches returns an empty catalog. `loci discover --json` with no query
preserves the shared `loci.operations/v1` catalog exactly.

`operation NAME` describes an operation; it never executes it. Its invocation
uses `execute` for direct operations and permitted previews, or
`submit --operation NAME --request-key KEY --run` for a durable task. This route
comes from the engine's task and preview sets. The catalog's `mutates` field
alone does not determine it: `large_result_export` is a durable task, while
`channels` is a direct metadata update. Replace the invocation's `STUDY` with an
absolute study path, provide the operation's exact request, and choose a new key
for an intentional new durable run.

`examples` lists only authored editable recipe requests. `operation` includes
the recipe guide schema for documented recipe routes and the checked-grant
request schema for `labels_import`; other operations explicitly report that
no authored CLI schema/example is available.
It does not manufacture generic requests for catalog entries. Their documented
contracts and source-dependent validators remain authoritative.

## Diagnose and complete

`loci doctor` reports engine version, Python/platform facts and whether a few
backend packages are discoverable. It imports no numerical backend, opens no
study, contacts no network and downloads nothing. Package discovery does not
establish model availability, compatible execution, or scientific readiness.
A missing required core package or unsupported Python version exits 1 and
retains the diagnostic receipt; a missing optional Cellpose package is reported
without claiming that it is required for the core.
`loci --version` reports the engine version; use `--json` for a structured receipt.

Generate a static completion script for the shell you use:

```sh
loci completion bash > loci.bash
source ./loci.bash

loci completion zsh > _loci
# Place _loci in a directory on zsh's fpath, then initialize compinit.

loci completion fish > loci.fish
source ./loci.fish
```

These scripts complete command, flag, operation and authored example names
without starting Loci, opening a study or reading scientific state. Completion
prints script text even when redirected; `completion SHELL --json` returns the
same script in a structured receipt.

## Create a study and inspect its sources

```sh
LOCI_STUDY="$PWD/experiment.loci-study"
loci create --project "$LOCI_STUDY" --title "Experiment"
loci import --project "$LOCI_STUDY" ./image.ome.tiff
loci sources --project "$LOCI_STUDY"
loci snapshot --project "$LOCI_STUDY" --json > snapshot.json
```

Project and export destination paths must be absolute. The shell variable above
creates an absolute path from the current directory; import image paths may be
relative. Request files use `@file.json` or `--request -` for stdin.

Import registers explicitly selected immutable sources. It does not move or
edit them. `sources` displays the full source ID needed by subsequent commands;
the JSON receipt contains exact fingerprints and complete metadata.

## Prepare, validate and run

Read the recipe guide and create an editable starter request:

```sh
loci guide recipe
loci example components-2d --source SOURCE_ID > recipe.json
```

Replace `SOURCE_ID` with the registered 32-character ID. The examples declare
their crop, plane/range and demonstration settings. Inspect and edit those
values for your intended analysis; they are not recommended thresholds or a
claim of biological validity. `loci guide recipe --json` includes the request
schema, examples and parameter-unit guidance. Source-dependent validation
remains authoritative.

```sh
loci execute --project "$LOCI_STUDY" validate_recipe --request @recipe.json
loci execute --project "$LOCI_STUDY" preview_recipe --request @recipe.json --json > preview.json
loci submit --project "$LOCI_STUDY" --request @recipe.json --request-key analysis-001 --run
loci jobs --project "$LOCI_STUDY"
loci results --project "$LOCI_STUDY"
```

Validation resolves defaults and checks source/geometry/resource compatibility.
A preview is not adopted as a result. Submission publishes a durable job and,
with `--run`, executes it. Reusing a request key with the same normalized request
returns the same job; changing that request under the same key is rejected.
Use a new key for an intentional new run. Omitting `--run` leaves a queued job;
`loci run --project "$LOCI_STUDY" --job JOB_ID` executes that exact job.

For operations beyond the recipe route, `loci discover` lists the shared
catalog. `execute` handles supported inspection/validation operations;
`submit --operation NAME --request @request.json --request-key KEY --run`
handles durable tasks. The operation catalog is broader than the starter
recipe guide and does not imply every operation accepts a recipe request.

## Adopt external labels

In the desktop, select one full native source plane, then use **Analyze →
External labels → Import labels**. Inspect the overlay and measurement channel
before **Import on this plane**. The adopted result opens in **Statistics &
objects**; select an object, locate it, then use **Edit selected object** to
correct that exact ID in a new child revision.

The CLI uses the same checked grant and durable operation:

```sh
loci import-labels --project "$LOCI_STUDY" --path /absolute/path/labels.tif \
  --source SOURCE_ID --source-sha256 SOURCE_SHA256 \
  --selection '{"t":0,"c":0,"z":0,"level":0}' --json > labels-preview.json
```

This creates a preview grant, not an adopted result. Use the exact source ID,
fingerprint and selected zero-based plane from the study. Review the returned
overlay and input metadata, then put the returned `grant_id` and source bindings
in `labels-request.json`:

```json
{
  "source_id": "SOURCE_ID",
  "source_sha256": "SOURCE_SHA256",
  "grant_id": "GRANT_ID_FROM_PREVIEW",
  "alignment": "same-native-yx-grid"
}
```

```sh
loci submit --project "$LOCI_STUDY" --operation labels_import \
  --request @labels-request.json --request-key labels-001 --run
```

Alignment is an explicit declaration by the researcher. Matching dimensions
alone do not establish alignment. This initial profile accepts a single scalar
YX TIFF plane with uint8/uint16/uint32 labels on the complete level-0 source
grid. It preserves sparse IDs and uses the selected raw source channel for
measurement. Background is zero. Optional `producer` fields `name` and `version`
are user-declared; upstream settings and validation remain unknown. See the
[external-label contract](EXTERNAL_LABELS.md) for calibration, memory and input
restrictions. Review/export gates and assistant policy still apply.

## Review, export and cancellation

Use the desktop to inspect the image and result before setting review state.
The human CLI can record that deliberate review of an exact revision:

```sh
loci review --project "$LOCI_STUDY" --result RESULT_ID --revision REVISION_SHA256 --disposition reviewed
loci export --project "$LOCI_STUDY" --result RESULT_ID --revision REVISION_SHA256 --destination "$PWD/reviewed-output"
```

Export remains revision-bound, atomic and non-overwriting. The CLI cannot make
an unreviewed revision satisfy the export contract by omitting review fields.
MCP cannot perform human review at all.

`loci cancel --project "$LOCI_STUDY" --job JOB_ID` requests cancellation of a durable
job. Ctrl-C interrupts a foreground command; it is not evidence that an already
published result was undone. Inspect the job afterward. Interrupted execution
retains the engine's failure/cancellation and atomic-publication behavior.

## Output and terminal behavior

- A terminal gets readable summaries; redirected output, including a no-argument
  invocation, gets JSON. Completion script output is the explicit exception above.
  Ordinary `--help` is text; `--json --help` returns a structured help receipt.
- `example` always prints request JSON, ready to save and edit.
- `--json` explicitly selects machine receipts. `--plain` selects readable text
  without terminal control sequences, including when redirected.
- `--no-motion`, `NO_COLOR`, and `TERM=dumb` disable terminal motion and colour.
  The live work indicator means actual work is running; it invents no percentage.
- `loci logo` prints a procedural three-node ASCII identity. `loci logo --animate`
  plays a three-second orbital reveal; `--duration 0.2` through `--duration 8`
  selects a bounded duration. Ctrl-C and SIGTERM restore the cursor. A no-argument
  invocation in a real input/output terminal gets a short 1.05-second welcome
  reveal before the starter workflow. Narrow or short terminals get a static mark.
  Brand motion represents identity, not analysis progress. JSON, plain, redirected,
  no-motion, `NO_COLOR`, dumb-terminal and internal transport modes remain free of
  terminal controls and animation delay.
- Human text escapes control characters in untrusted names. JSON preserves the
  original values and should be parsed as data.
- Use the JSON receipt for complete numerical rows and full provenance. A
  concise terminal summary is not a new analysis or a replacement data export.
  Default text keeps actionable study/source/result/job IDs and states; revision,
  source, membership and query hashes remain in the exact `--json` receipt.
  `population_query` shows metric units, filters, finite/missing counts, sampling
  accounting and up to five returned objects. Statistics and object values use
  six significant digits for display; JSON retains their full precision.
  `population_locate` shows exact zero-based result-grid YX or ZYX indices.
  The interactive mark yields screen space to longer output; Page Up/Down reads
  earlier lines.
- Errors go to stderr. Input errors exit 2; execution failures exit 1; Ctrl-C
  exits 130. `run` and `submit --run` also exit 1 when an existing job is failed,
  cancelled or interrupted, while retaining its receipt on stdout. `job` and
  `jobs` queries exit 0 when they successfully inspect those same states. A
  queued submission is successful submission, not completed analysis.

The existing `loci-research`, `python -m loci_engine.research_cli` and
`loci-engine --cli` interfaces retain their JSON behavior. MCP stdio and bounded
internal child commands bypass all terminal presentation.

The terminal design follows [Command Line Interface Guidelines](https://clig.dev/):
clear help, composable output, purposeful motion and useful errors. The procedural
three-node mark refers to Loci's existing identity and settles into an ASCII
wordmark. The CLI remains composable and does not become an interactive shell.

## Connect an assistant

Use the workbench's **Connect an assistant** panel to create exact local grants.
The static `recipe_guide` tool and `loci://guides/recipes` resource explain the
request format. When explicitly granted, `analysis_context` and `loci://context`
provide paged source/recipe handles and resource limits. They do not browse
ungranted study contents. See [Agent access](AGENT_ACCESS.md) for independent
disclosure categories, revocation and client setup.
