# Policy-bound agent access

Loci can expose explicitly granted study operations to a local agent over
Model Context Protocol (MCP) stdio. The MCP process opens no HTTP or other
network listener. It uses the same validated project, recipe, job, result, and
export code as the desktop and CLI.

Agent access is disabled until a person creates an explicit access bundle in
Loci or writes a policy file, then connects a client using that exact policy path:

```console
cd engine
uv run python -m loci_engine.research_cli mcp --policy /absolute/path/policy.json
```

The policy is local authorization, not a scientific validation record. Source
names and metadata remain untrusted data and must never be treated as agent
instructions.

## Policy lifecycle

`loci_engine.agent_policy.write_policy(path, project, specification)` is the
human-side helper for creating or updating a policy. The local human CLI calls
it with an explicit JSON object or `@file`:

```console
uv run python -m loci_engine.research_cli policy \
  --project /absolute/path/example.loci-study \
  --destination /absolute/path/policy.json \
  --specification @/absolute/path/grants.json
```

The helper accepts every grant as explicit data, fills in the exact study path
and project identity, validates the document, and atomically writes a private
file. On POSIX the policy must be a current-user-owned, single-link plain file
with mode `0600`. The path passed to the server must be absolute.

At startup, the MCP process pins all of the following:

- policy file device/inode and SHA-256 content hash;
- absolute study path and the study's stored project identity;
- each allowed source ID and registered source SHA-256;
- export-root device/inode, when export is enabled.

The process rereads and verifies the policy and project identity before every
tool call. Source bytes are rehashed before a source, job, or result is used.
Editing, replacing, chmod-ing, unlinking, or redirecting the policy revokes the
running process; restart it explicitly to accept a new policy. Replacing the
export root also fails closed.

The original policy schema is `loci.agent-policy/v1` and has these exact fields:

```json
{
  "schema": "loci.agent-policy/v1",
  "project": {
    "path": "/absolute/path/example.loci-study",
    "id": "32-lowercase-hex-characters"
  },
  "sources": [
    {
      "id": "32-lowercase-hex-characters",
      "sha256": "64-lowercase-hex-characters",
      "crop": {"x": 0, "y": 0, "width": 512, "height": 512},
      "t": [0],
      "c": [0, 1],
      "z": [0, 1, 2],
      "level": [0],
      "measurement_channels": [0, 1]
    }
  ],
  "recipes": [
    {
      "sha256": "sha256-of-the-normalized-recipe",
      "preview": true,
      "run": false
    }
  ],
  "operations": ["validate_recipe", "preview_recipe"],
  "model_packages": [],
  "runtimes": [
    {
      "engine": "0.2.0",
      "numpy": "exact-version",
      "scipy": "exact-version",
      "scikit_image": "exact-version",
      "backend": "numpy-scipy-cpu",
      "resolved_device": "cpu"
    }
  ],
  "export": null,
  "limits": {
    "cpu_seconds": 300,
    "memory_bytes": 4294967296,
    "concurrency": 1
  },
  "disclosures": []
}
```

Crop bounds are inclusive at `x,y` and exclusive at `x + width,y + height`.
Every selected T, C, Z, and pyramid level must be listed. A Z range is allowed
only when every plane in the half-open range is listed. Measurement channels
have their own list because they can differ from the displayed or segmented
channel.

Recipe hashes are calculated after `Workbench.validate_recipe` resolves all
defaults. Validation can normalize a new proposal and return its hash without
reading pixels. Preview and durable execution require that exact normalized
hash and the corresponding boolean grant. This prevents an agent from varying
a threshold or other image-dependent parameter as a covert query.

The manual workbench may bind flat-field or dark-field reference images. Agent
recipes currently reject every non-empty `references` object before validation.
Adding that capability requires a later policy revision that independently
checks each reference source fingerprint and selection scope.

Runtime records are exact identities for the built-in CPU implementation.
Current workbench recipes do not load model packages; `model_packages` is an
explicit dormant scope for a future recipe integration and grants no download,
installation, loading, or execution right by itself. There is no MCP model or
runtime provisioning tool.

For an export grant, use an existing absolute plain `root` and a non-empty list
of exact single-component `filenames`. Export writes one new directory and
never overwrites an existing path:

```json
"export": {
  "root": "/absolute/plain/export-root",
  "filenames": ["experiment-01-reviewed"]
}
```

## Disclosure categories

Every sensitive response category is denied unless separately named in
`disclosures`:

| Category | Data it permits |
| --- | --- |
| `geometry` | resolved crops, shapes, calibration, and coordinate geometry |
| `source_names` | registered display names and source metadata text |
| `previews` | rendered image content |
| `measurements` | object counts and measurement rows |
| `provenance` | recipe, processing, runtime, and execution provenance |
| `agent_metadata` | policy hash, project ID, granted-operation summary, source handles/fingerprints, recipe grants, resource limits, and extra record metadata |

The `catalog` response lists static tool names and descriptions. It does not
enumerate study content; its policy and project identity summary appears only
with `agent_metadata`. Listing does not grant access to policy-restricted tools.

`preview_recipe` and `result_view` require `previews`. Measurement and
provenance fields in a preview or result are independently omitted unless their
categories are granted. The current full research export contains derived image
data, source metadata, geometry, measurements, and methods provenance, so
`export_result` requires `previews`, `source_names`, `geometry`, `measurements`,
and `provenance` as well as its destination grant.

## Tools

| Tool | Boundary |
| --- | --- |
| `catalog` | Static catalog only; no study enumeration |
| `recipe_guide` | Static request schema, units and source-independent examples; no study content or execution |
| `analysis_context` | Paginated pinned source/recipe grants and limits; requires both its operation grant and `agent_metadata` |
| `inspect_source` | Verify one supplied permitted source ID; names and geometry require independent disclosures |
| `validate_recipe` | Normalize and validate one policy-scoped proposal; no pixel execution |
| `preview_recipe` | Execute one approved recipe without adopting a result |
| `submit_recipe` | Idempotently submit and asynchronously start an approved durable run |
| `job_status` | Read one supplied, policy-verifiable job ID |
| `cancel_job` | Cancel one supplied, policy-verifiable job ID |
| `result` | Read one supplied, policy-verifiable result ID through disclosure filters; `offset`/`limit` paginate measurements |
| `result_view` | Render one supplied, policy-verifiable result revision |
| `export_result` | Export one exact reviewed revision to one authorized filename |

There is no tool for file browsing, import, relink, policy creation or editing, arbitrary project listing, shell execution or unrestricted network egress. Legacy policies require local human review before export. V4 permits a separately authorized agent assessment as described below; existing policies are never widened automatically.

### Recipe guidance and analysis context

`recipe_guide()` takes no arguments. It returns `loci.recipe-guide/v1`, including
a JSON Schema for the policy-bound recipe request, field/coordinate/unit
guidance, and the `components-2d` and `watershed-3d` examples. These select an
explicit 16 × 16 pixel crop, with Z=0 or the half-open Z=[0,4) range. Replace the
placeholder source ID and choose settings appropriate to the actual source;
the examples are not scientific recommendations. The production Workbench
validator remains authoritative for source-dependent geometry, channels,
resource estimates and recipe normalization. The guide does not authorize
execution, model provisioning or reference-image access. Use `validate_recipe`
to resolve defaults and inspect the normalized hash, memory estimate, and
approved preview/run status before an authorized preview or submission.

`analysis_context(offset=0, limit=50)` requires **both** `analysis_context` in
the policy's `operations` and `agent_metadata` in `disclosures`. Existing
policies lacking either remain denied. Newly created desktop access bundles
include the operation only when the person explicitly selects the
`agent_metadata` disclosure (shown as **Analysis context** in the UI).

The `loci.agent-context/v1` response includes policy identity, permitted
operations/disclosures and CPU/memory/concurrency limits. `source_grants` lists
only pinned source IDs and fingerprints; `recipe_grants` lists only pinned
normalized recipe hashes and their preview/run permissions. It does not
enumerate study sources, results or jobs, reconstruct approved requests, or
read adjacent request/configuration files. Source fingerprints are verified
when their grants are returned, and policy identity is rechecked before and
after reads.

Each grant array contains at most `limit` entries, using the same `offset`;
`offset` must be a nonnegative integer and `limit` an integer from 1 to 50.
Booleans, fractional values and unknown arguments are rejected. `pagination`
reports both grant counts and `next_offset`, based on the longer list. Continue
with that offset until it is `null`; one array may become empty before the
other. Names appear only with `source_names`; permitted crop/axis/channel
scope appears only with `geometry`. Context access does not grant either
disclosure, recipe execution or human review.

Two fixed JSON resources expose the same boundaries:

| Resource URI | Content and authorization |
| --- | --- |
| `loci://guides/recipes` | The same static document as `recipe_guide`; requires an unchanged active policy, with no additional operation grant |
| `loci://context` | The first context page (`offset=0`, `limit=50`), with the same operation/disclosure requirements as `analysis_context` |

Use the context tool for later pages. These URIs are exact resource identifiers,
not filesystem paths or general URL readers; no resource templates, arbitrary
file access or network listener are introduced. Resource failures are sanitized
under the same rules as tool failures. Tool descriptions and behavior hints
aid discovery; they never replace policy authorization.
`preview_recipe` records a durable preview job, and `job_status` can reconcile
job records; neither is described as an entirely read-only operation.

Jobs persist in the study database. Reusing a request key with the same
normalized request returns the same job; reusing it with different parameters
is rejected. Execution uses only this fixed child command:

```text
python -m loci_engine.research_cli run --project PROJECT --job JOB_ID \
  --cpu-seconds CPU_SECONDS --memory-bytes MEMORY_BYTES
```

The server records each child object and signals it only when the durable job
record contains the same PID. Cancellation of an unowned process updates the
durable cancellation flag but never sends a signal to that PID. The result
transaction checks cancellation immediately before publication. A policy
watcher cancels an owned child if its pinned policy is revoked while it runs.

The allowed policy range is 1-86,400 CPU seconds and 64 MiB-8 GiB of memory.
The policy's `working_bytes` ceiling is checked for every recipe. Before opening
the project, the fixed CLI child applies per-process user CPU time and committed
memory limits with a Windows Job Object, `RLIMIT_CPU` and `RLIMIT_AS` on Linux,
and `RLIMIT_CPU` on macOS. macOS exposes but rejects finite `RLIMIT_AS`, so its
memory boundary is the workbench's validated `working_bytes` and bounded array
operations. `concurrency` counts both running durable jobs and live owned child
processes before a new child starts. The Windows CI job exercises CPU
termination and committed-memory denial in real child processes before creating
an installer.

Export first builds and round-trip-checks an exact reviewed package in a private
directory under the authorized root. Loci rechecks the pinned policy, source,
result, recipe, revision, and current authorized review immediately before an atomic
no-replace rename to the authorized filename.

## V4: study actions and delegated review

The desktop offers **Inspect**, **Analyze**, and **Full study** presets alongside
custom permissions. Selecting a preset proposes and validates access; only
**Grant selected access** creates a bundle after the native folder selection.
Inspect permits image, table and review-history reads in the displayed region.
Analyze additionally permits the currently registered native analysis/correction
actions in that region. Full study pins all current source IDs and fingerprints,
all their C/Z/T indices, and their full spatial bounds; later imports are excluded.
Whole-source grants currently support at most 4096 indices per C/Z/T axis.
Full study also delegates result review and exports to new names in the chosen
folder. Every preset explicitly includes disclosure of image content and records
to the connected provider. Loci cannot revoke copies already delivered to a
provider or constrain other tools available in the client's host.

V4 adds `delegation` and `actions` to the v3 policy. A delegation contains a
generated ID, declared `client_id`, optional timezone-aware `expires_at`, and
`result_scope` (`pinned-recipes` or `granted-sources`). Approval independently
requires `review_result` in `operations`. A source-scoped result grant checks the
exact selection, measurement channels, referenced sources, parent and specialist
input revisions. It does not authorize executing an unlisted operation or model.
Expiry and any change to the pinned policy revoke subsequent calls and guarded
publication. Existing policies are never widened automatically.

| Tool | Boundary |
| --- | --- |
| `action_guide` | Static `loci.action-registry/v1` request schemas, coordinates, effects and retry rules |
| `study_results` | Only accessible revisions, paginated at up to 50 rows; optionally narrowed to a granted source |
| `validate_action` | Check named action, input scopes, revisions and resource bounds; native execution still validates numerical settings |
| `inspect_action` | Run an explicitly granted read action in a disposable bounded worker |
| `submit_action` | Start an explicitly granted native task with an idempotency key; follow `job_status` |
| `review_history` | Ordered review events, current digest and pagination; assessment text requires all result disclosures |
| `review_result` | Append an agent decision for an exact revision and observed prior review digest |

`source_image` and `review_result` publish their complete nested `request` JSON
schemas in MCP `list_tools` and `catalog.tools[].request_schema`. The latter is
static documentation, contains no study data, and does not grant execution.
`action_guide` accepts registered analysis/editing action names, not these tool
names. Image requests require explicit selection, display channels, projection
and thumbnail size; a plane forbids `z_stop`, while max/mean require an exclusive
`z_stop`. Review requests require the exact inspected revision, disposition,
nonblank reason and coverage, and `expected_review_sha256` copied from
`review_history.current_review_sha256` (null only without a prior review).
Native validators and all source, disclosure, runtime and delegation guards
remain authoritative.

The registry covers recipes, the built-in adaptive watershed (`classical_run`),
result context, label/ROI correction,
puncta, cell/nucleus association, colocalisation, tracking, population inspection,
and bounded large-result inspection/deletion. The desktop operation catalogue
marks each supported action as read or task. Named actions require all six
response disclosures and a source-scoped delegation. They use the same native
executors as the GUI and CLI. Read and task workers retain CPU, memory and shared
concurrency limits, policy/source checks, and publication guards. There is no
generic operation, shell or model-install escape hatch.

### Shared researcher and agent workflows

The action contract now distinguishes `inspection`, `preview-task` and
`publication-task`, with the native operation, output type, required scope,
resource bounds and cancellation behavior exposed in discovery. Availability
never adds authority to an existing policy.

Named actions cover saved workflow list/get/preflight/preview/run/status;
exploration list/get/preview/compare/run; population gate evaluation and saved
group reads; study summaries; intensity catalog/preview and saved report reads.
They reuse native validators and numerical execution. Document lists are scoped
before inspection; result ancestry, source selections, measured channels, runtime
and model identities remain subject to grants. These new summary and comparison
reads currently accept the flat native runtime/model identity profile; learned
Cellpose/ONNX producer provenance is rejected rather than reduced to a partial
identity. The existing `granted-sources` adopted-data delegation remains
method-independent for result inspection/review/export; that data access does
not grant model execution or prove a pinned learned runtime. Workflow authoring
and runtime or model provisioning remain researcher-controlled.

Preview tasks use ordinary durable job ownership and cancellation. A succeeded
preview can be read with `task_preview_get` by its owning session, after the
original action is authorized again. The local display cache retains at most
eight previews, each with at most 8 MiB of output. Each record binds the task,
request, source fingerprint and output digest. It is not an adopted result or a
portable study artifact. An evicted or mismatched preview fails explicitly and
is never recomputed by inspection. `exploration_compare` additionally saves the
native comparison receipt; discovery declares that side effect.

MCP preview inspection returns actual PNG image blocks with explicit JSON-pointer
mappings in `image_transport`. Metadata omits the mapped data URLs; the retained
`output_sha256` still covers the original canonical output including those URLs.
To verify it, reconstruct the declared image paths from their mapped blocks.
Each block also carries a PNG-byte hash. Image count, bytes and metadata are
bounded before disclosure; invalid image content fails the whole response.

The desktop activity timeline records inspected, proposed, submitted and
completed operations, including exact source/result/job references. Pending
approvals show their targets and become stale when a bound source, result or
workflow changes. Byte verification occurs at approval and consumption; routine
status polling uses recorded identity. Opening a timeline target rechecks its
identity. Source, result and job links support navigation; other target kinds
currently expose identity details without direct navigation. Preview inspection
supports a pinned comparison within one source;
different recorded selections are labelled without claiming pixel alignment.

The workflow panel uses the source rail's selected images for preflight and
batch execution. Explicit **Follow agent views and results** can follow inspected
source planes/regions and newly produced results. Regions affect the display
camera, not the analysis ROI. For scalar data, Follow shows the reported channel
using the researcher's existing colors and contrast; RGB sample component mixes
stay unchanged. Editing,
pointer activity and later human input suppress automatic navigation, including
late asynchronous responses. Disabling Follow does not cancel computations.
Exact job controls retain policy/session ownership, and reconnecting does not
transfer jobs or retry publication automatically. Verified workflow exports
made through the agent also update the native workflow export receipt.

`classical_run` requires the `loci-classical` profile, all native segmentation
settings, one fully resolved 2D source selection (`x,y,width,height,t,c,z,level`),
explicit raw measurement channels and a working-memory allowance. Its source,
measurement and runtime grants are checked before submission; the existing
policy revocation and publication guards remain active during execution.
The native adaptive executor supplies the same labels, raw measurements and
provenance as desktop execution. It does not grant Cellpose execution or model
installation. New results require their own review before reviewed export.

`perinuclear_run` measures **Perinuclear enrichment**, a geometric ring proxy,
through the same native operation used by the desktop. Its exact request contains
`result_id`, `revision_hash`, `signal_channel`, `radius_px`, `working_bytes` and
`control`. The bound nucleus result must occupy the full native scalar level-zero
2D source plane; the raw signal must share its exact grid. The radius is explicit,
finite, greater than zero and at most 128 pixels. Qualification protocols can pin
a narrower choice, such as five pixels, without changing that general contract.

Every nucleus blocks and competes for ring pixels, including excluded nuclei.
Rings use inclusive Euclidean pixel-center distance outside every nucleus;
pixels claimed by multiple nuclei are discarded from every ring. Nuclei touching
the image boundary, empty rings and zero-mean rings are excluded explicitly.
No epsilon, imputation or intensity gate is applied. The per-object endpoint is
raw nuclear mean divided by raw ring mean. The saved source-plane summary records
the median and mean eligible ratios, counts and every exclusion; for a one-field
well, the median is its well endpoint. With no eligible objects, the endpoint is
explicitly undefined (`null`), never a successful qualification claim.
This fluorescence endpoint requires nonnegative raw values across the selected
signal plane. Negative samples fail execution and restore/export validation with
an actionable error; they are never clipped, offset or silently excluded.
General signed raw-intensity workflows retain their existing behavior.

The result preserves the original nucleus revision, raw signal, unique ring
ownership and discarded-pixel masks, raw counts/sums/means, ratios and exclusions.
Reviewed export includes these arrays, TIFF masks, `objects.csv` and
`perinuclear-summary.json`; restore/export verify their arithmetic and bindings.
`result_view` optionally accepts `label_field: nuclei`, `rings` or `ambiguous`
only for this result kind. Its default remains nuclei. The selected field and its
basis accompany every QC view; a ring proxy must never be called true cytoplasm.

`spatial_distance_run` measures **Tissue distance bands** from exact object,
compartment and declared-boundary result revisions on one calibrated YX plane.
It requires explicit `band_edges`, crop-border policy, controls, boundary
coverage and a working-memory budget. Counts use eligible object centroids;
area uses sampled compartment pixels within each half-open band. Zero area has
undefined density. All three input masks remain permission-bound dependencies.
Correct the inputs and rerun; direct correction of the derivative is refused.
See [the endpoint and persistence contract](SPATIAL_DISTANCE_BANDS.md). This
operation does not infer epidermis or establish tissue thickness.

For every durable job, wait until `job_status` reports a terminal state and
`owned_worker_active=false` before issuing another operation under concurrency 1.
A result may publish before its worker exits; that interval still consumes the
owned worker slot. A capacity refusal is retryable after the worker exits.

`spatial_density_preview` aggregates exact distance results into donor-level
endpoints and returns a bounded summary plus a retained preview token.
`spatial_density_save` takes that token; it does not accept an echoed report.
Use `spatial_density_get` for saved summaries and `spatial_density_query` for
bounded pages bound to one report hash. Follow the returned `next_offset`.
Source/result authorization is checked recursively across all inputs, including
phenotype groups. See [the donor-density contract](SPATIAL_DONOR_DENSITY.md).

The version 2 `workflow_graph_*` actions inspect and control typed native
composition. `workflow_graph_inspect` and `workflow_graph_control` are explicit
policy capabilities, and neither substitutes for the underlying action/source
grants. Every child executes under its own durable job and original owner.
See [composed workflows](WORKFLOWS.md#composed-workflows) for adapters and recovery.

Read `correction_info` before editing: `expected_input_sha256` is the label-array
hash, not `revision_hash`. Corrections preserve the parent, remeasure the changed
labels and start without review. Read `review_history` before `review_result`;
pass its `current_review_sha256` as `expected_review_sha256`, together with
`result_id`, `revision_hash`, disposition (`reviewed`, `excluded`, `pending`),
reason and coverage. The server supplies actor and delegation fields. A stale
decision cannot replace a newer one. The UI distinguishes agent and researcher
reviews and lets the researcher supersede an agent decision without erasing it.
Identity assurance is declared, not authenticated model/person identity.

## V5: live MCP session presence, permission modes, and single-use approval

Loci records access bundles, initialized MCP clients, approvals and activity as
namespaced records in the `metadata` table of `study.sqlite3`, and surfaces them in
`Workbench.snapshot()["agent_sessions"]` (`loci.agent-sessions/v1`).

- **Truthful session states**: Generating a bundle records `configuration_ready`
  and never presents a connected client. Only a successful MCP `initialize` handshake after policy and project
  validation transitions a
  session to `connected_idle`, `executing`, `awaiting_approval`, or `paused`.
  Clean exit transitions to `disconnected`; uncaught errors transition to
  `failed`; dead PIDs or expired heartbeats reconcile to `interrupted` and
  cancel pending approvals for that session.
- **Permission modes (`loci.agent-policy/v5`)**: Users can select
  `ask_approval`, `full_access`, or `inspect_only` at bundle creation and switch
  modes live from the lower-right session drawer (`research_agent_session_control`):
  - `inspect_only`: read-only inspection within disclosed scope; mutating,
    task-submitting, review, and export tools fail closed.
  - `ask_approval`: read-only inspection proceeds within disclosed scope;
    mutating or consequential calls (`preview_recipe`, `submit_recipe`,
    `submit_action`, `set_source_display`, `review_result`, `export_result`,
    `export_vision_handoff`, `remote_submit`, `remote_retrieve`,
    `remote_attach`) create a durable pending approval record bound to the exact
    `operation`, `request_hash`, `source_id`/`source_sha256`,
    `result_id`/`revision_hash`, `display_revision`, and `destination_name`, and
    wait for a researcher decision in Loci before executing.
  - `full_access`: permitted actions within the policy's scope and resource
    limits execute without per-call prompts.
- **Single-use atomic approvals and stale-target protection**: Approving a
  pending request in Loci transitions it from `pending` to `approved`, and the
  waiting (or retried) MCP tool call atomically consumes it (`approved` ->
  `consumed`) for that single invocation. If the bound source fingerprint,
  result revision, or display revision changes before execution, the approval is
  marked `stale` and rejected. Approval decision RPCs exist only on the desktop
  control channel (`research_agent_session_control`), never as MCP tools, so an
  agent cannot approve its own request. Execution approval never creates a
  human scientific review record.
- **Interactive controls and non-destructive updates**: The lower-right session
  drawer provides policy-wide **Pause access**, **Resume access**, **Stop active job**,
  **Disconnect client**, **Revoke access**, and a **Follow agent** toggle. While
  **Follow agent** is off (or while the user is editing), agent updates merge
  into study history without overwriting the user's selected source, result,
  viewport camera, or unsaved drafts. Follow opens inspected source views and newly completed results
  attributed to that session while the researcher is idle in Display, Results
  or Agent. Results received during editing are not queued to interrupt later.
  Stop targets an exact session-owned job. Disconnect revokes that session
  immediately; revoke ends access for the policy. Both preserve unrelated human
  and other-policy jobs. Reconnection creates a distinct session.
  Expired approvals cannot be consumed, even before the next desktop refresh.
- **Capability map (`loci.agent-capability-map/v1`)**: Derived from
  `OPERATION_CATALOG` and `ACTION_NAMES`, reporting each operation as
  `supported_via_mcp`, `supported_with_grant`, or `gui_only_gap`.

New reviews use `loci.result-review/v2` and append-only events. Existing legacy
human receipts retain their original bytes and semantics. Exports contain hashed
`review-history.json`; portable studies with new histories use
`loci.study-interchange/v2`. Readers retain support for legacy bundles and reject
missing or inconsistent new histories. Source/result revisions, chain digests
and the exact current decision must agree. A review is an assessment record,
not independent biological or clinical validation.

V4 export policy chooses `filename_mode: listed` or `directory`. Directory mode
permits a new single-component name (at most 80 characters) below the pinned
export root; traversal, replacement and overwrite remain forbidden. An
agent-reviewed export requires both review and export authority. `analysis_context`
reports the mode and permitted names without disclosing the private root path.

## SDK clients

The client contract is handshake-based MCP stdio. The source protocol tests
exercise version `2025-11-25` with the locked Python MCP SDK `2.2.0`.
The guide/context additions retain that client flow; they do not claim support
for every newer specification revision. Packaging receipts record the actual
negotiated protocol and tested worker identity. Use the generated access-bundle
command for the packaged worker, or the source command below. The
[researcher CLI guide](CLI.md) distinguishes the human command surface from
this policy-bound server and the machine JSON-lines worker.

The Python SDK connects over stdio without a listener:

```python
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

params = StdioServerParameters(
    command="/absolute/path/to/python",
    args=[
        "-m", "loci_engine.research_cli", "mcp",
        "--policy", "/absolute/path/policy.json",
    ],
)
async with stdio_client(params) as streams, ClientSession(*streams) as session:
    await session.initialize()
    tools = await session.list_tools()
    catalog = await session.call_tool("catalog")
```

The TypeScript SDK uses the same transport and command:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "loci-client", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/absolute/path/to/python",
  args: [
    "-m", "loci_engine.research_cli", "mcp",
    "--policy", "/absolute/path/policy.json",
  ],
});
await client.connect(transport);
const tools = await client.listTools();
const catalog = await client.callTool({ name: "catalog", arguments: {} });
await client.close();
```

Contract exercises use generated synthetic TIFF data only. The Python SDK
tests cover initialization, tool/resource discovery, recipe guidance and
validation, context pagination, independent disclosure filtering and
revocation over subprocess stdio. The frozen-worker test route uses
`LOCI_TEST_ENGINE_EXECUTABLE` to select the packaged executable explicitly.
Source tests do not qualify an untested packaged worker or establish independent
researcher usability or scientific accuracy.

## Experimental v3: local vision, display and bounded recipe exploration

An access request with the original exact fields still creates a v1 policy and
the original five bundle files. The optional `interactive` object opts into v3
and must contain exactly these fields:

```json
{
  "allow_image": true,
  "allow_display": true,
  "allow_handoff": false,
  "channels": [0],
  "handoff_names": [],
  "parameters": {"threshold": {"min": 40, "max": 80}}
}
```

Every operation grant is a boolean. `channels` is a sorted, unique list of at
most 16 valid source indices; it is empty when all three operation grants are
false, and must be nonempty when one is enabled. Source access includes the
union of these channels and the selected recipe channel. Measurement channels retain their separately validated scope.
Crop, time, z range and pyramid level remain pinned to the approved selection.

`allow_image` enables bounded `source_image` image content and requires
`previews` disclosure. `allow_display` enables `source_display` and
`set_source_display`, requiring `geometry`, `provenance` and `agent_metadata`.
Display updates use the current revision for compare-and-swap; stale changes
must be reread and reconsidered. Display settings apply to those channels across the source; the crop limit
bounds image reads. Display settings change rendering, not source pixels or
numerical analysis. Display permission alone does not disclose pixels.

`allow_handoff` independently enables `export_vision_handoff`, requiring
`previews`, `geometry`, `provenance`, `agent_metadata`, a chosen existing local
export directory and explicit filenames ending in `.loci-vision`. When it is
false, `handoff_names` is empty. Reviewed-result filenames and handoff filenames
are combined without duplicates. Handoff access does not require run or
reviewed-result export permission and does not certify human review or upload
anything. Reviewed result exports retain their existing run, disclosure and
human review requirements.

`parameters` is empty or contains finite, ordered `min`/`max` ranges for
`threshold` and/or nonnegative `min_size`. Each ranged parameter must already
be explicit and numeric in the validated base segmentation recipe, and its
value must lie within the range. Automatic `"otsu"` cannot be ranged. No default
is silently added to the base recipe. Experimental ranges require `geometry`,
`provenance`, `agent_metadata` and at least preview or run permission. Preview
also requires its existing `previews` disclosure. Only these named parameter
values may change; source selection, preprocessing, measurement channels,
gates, working memory and CPU runtime remain fixed. Numerical validation and
human review are still required before scientific claims or reviewed exports.

The v3 document retains v2's `remote_grants` (empty for interactive setup), the
original exact recipe hash grants, and adds `experimental_recipes`. The latter
is empty or contains the normalized `interactive-recipe` template with its
source, selection, base recipe, parameter ranges and preview/run permissions.
It grants no remote transfer, model import, provisioning or human review.

Interactive bundles also contain `plugin/plugin.json`, `plugin/mcp.json`,
`plugin/skills/loci-analysis/SKILL.md` and
a generated local marketplace manifest. Resources are embedded in the engine for
frozen packaging. All bundle directories use `0700` and files `0600` on POSIX.
The portable plugin's stdio command points to the exact worker command and the
original bundle's policy; a cached plugin copy still depends on that policy.
For source workers, the plugin uses the original engine import directory as
`PYTHONPATH` and keeps its working directory inside the installed plugin.
The marketplace identity includes the policy hash to distinguish grants.

Register the bundle as a local marketplace with
`codex plugin marketplace add /absolute/path/to/access-bundle`, then install
Loci analysis with `codex plugin add loci-analysis@loci-local-POLICY_HASH_PREFIX`
using the exact command in the generated README, or use the desktop plugin
directory. Start a new session and verify the connected catalog and context.
Creation of the bundle does not install or enable the plugin. Use either its
MCP connection or the manual `codex-config.toml` configuration to avoid
duplicate server sessions. Preserve other client configuration. Disconnect
old access when replacing it; remove the original `agent-policy.json` to revoke
access even when the plugin has been copied into a client cache.
The format and installation surface follow
[OpenAI's plugin packaging guide](https://developers.openai.com/plugins/build/plugins)
and [MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp).

Local Codex hosts can use stdio. ChatGPT web does not read this local policy or
configuration. For a web vision discussion, explicitly upload only selected
exported image/context artifacts and choose an available model in that client.
Never upload the private access configuration as a dataset. This plugin does
not grant a model entitlement or create a subscription-to-API bridge. Its
workflow treats an MCP rejection as a boundary; unrestricted shell, CLI or UI
tools must not bypass it. Broader human CLI work needs separate explicit
authorization. Source and packaged regression evidence establish software
behavior only; they do not establish biological accuracy or researcher usability.

## Experimental v2: one human-prestaged classical remote run

Existing `loci.agent-policy/v1` files and tool catalogs retain their local
capabilities. An opt-in `loci.agent-policy/v2` adds the exact `remote_grants`
field; an absent or empty grant confers no remote operation. This remains a narrow
experimental capability. Qualification must identify the exact public source,
packaged worker, client and scheduler environment tested. See
[release status](RELEASE_STATUS.md) for published artifacts and remaining gates;
source support does not qualify another site, scheduler or scientific method.

A person first saves and tests a batch profile and stages one `run_recipe`
task and one registered immutable source through the normal remote workflow.
The policy writer accepts a new remote grant only while that run is `staged`.
Profiles, source staging, runtime/model provisioning, logs, cleanup, arbitrary
paths or commands, Cellpose, tiled M6 results and human review are unavailable
through the remote MCP tools.

The human CLI can read the exact grant identity without submitting or transferring:

```console
uv run python -m loci_engine.research_cli remote-grant \
  --project /absolute/path/example.loci-study \
  --request-key 0123456789abcdef0123456789abcdef --key approved-classical-run \
  --operations submit status cancel retrieve attach \
  --max-output-bytes 1048576 --cancel-on-revocation
```

Add the returned object as the single member of `remote_grants` in the existing
human policy **specification**, then run the `policy` command above. The helper
selects v2 when this field is present. Every existing source, normalized recipe,
runtime, disclosure, export and local resource grant remains explicit. The grant
has exactly these fields:

```json
{
  "key": "approved-classical-run",
  "request_key": "0123456789abcdef0123456789abcdef",
  "request_sha256": "exact canonical request SHA-256",
  "profile_sha256": "exact saved profile SHA-256",
  "source_id": "exact registered source ID",
  "source_sha256": "exact source SHA-256",
  "source_size_bytes": 1464,
  "task_id": "exact staged task ID",
  "resources": {"cpus": 1, "memory_mb": 1024, "wall_minutes": 5, "gpus": 0},
  "operations": ["submit", "status", "cancel", "retrieve", "attach"],
  "max_output_bytes": 1048576,
  "cancel_on_revocation": true
}
```

The hashes/IDs above are illustrative placeholders; use the actual helper
output. Operations are independent grants: `submit` never implies permission to
retrieve. `submit` requires explicit `cancel_on_revocation`. Each action rechecks
policy and filesystem identities, source bytes, crop/axes/channels, live channel
declarations, exact normalized run recipe, approved current runtime, canonical
request, saved profile and exact resource reservation. Resources require PBS,
PBS Pro or Slurm, 1–8 CPUs, 256–8192 MiB RAM, 1–60 minutes and zero GPUs. Source
and compressed-output bytes each cannot exceed the smaller of 512 MiB and one
quarter of local policy RAM; decoded ZIP member bytes also fit that quarter.
These bounds intentionally keep the initial bridge within the small-result path.

All five MCP tools accept **only** `{"grant_key": "approved-classical-run"}`:
`remote_submit`, `remote_status`, `remote_cancel`, `remote_retrieve`, and
`remote_attach`. Submission resumes the exact scheduler retry identity.
Retrieval and attachment start a fixed disposable CLI child and return a bounded
work state immediately; poll `remote_status` until that operation succeeds.
Calls share local concurrency capacity with recipe jobs and active scheduler
reservations, including children that have spawned but have not claimed a durable
job. A cancellation request retains the scheduler reservation and status polling
until a confirmed terminal scheduler state. Repeated completed operations reverify through at most eight
bounded child attempts, then require human reconciliation. A restart reconciles
lost child processes and resumes using the same run and immutable policy.

The child's independently loaded policy must match the original file hash,
file inode, study directory and export directory identities. CPU limits apply
in that disposable process. Linux/Windows also apply their existing process
memory controls; macOS uses operation admission plus periodic observed child
RSS enforcement, **not** an address-space limit or an instantaneous hard RAM
bound. Fixed SSH descendants belong to the owned child session and are terminated
with it on revocation or wall/memory excess. Output uses no child diagnostic
stream on MCP. Scheduler reservation bounds remote resources separately from
these local transfer/verification limits.

Before transfer, the production client refetches and exactly matches the admitted
manifest, whose aggregate artifact bytes must fit `max_output_bytes`. Each SCP
runs through a fixed helper that applies POSIX `RLIMIT_FSIZE` at that entry's
exact admitted size before any artifact write. A growing remote file fails within
that artifact size bound, and hash verification still follows. This bounds bytes
written to incoming artifacts; it does not count SSH protocol overhead or network
buffers. Hosts without the required POSIX file-size limit refuse bounded transfer.
The helper and SCP inherit the supervised child process group for revocation.

Retrieval stages privately and publishes its durable receipt only inside guarded
SQLite writes. Interrupted private staging is never adopted as a publication;
a person must reconcile it before retry. Attachment checks guards during bounded
verification, on idempotent return, and inside the result transaction before
writes and immediately before commit. Policy/source/profile mutation stops owned
local work and blocks further result disclosure/export. External file mutation
has the same final-check/commit time-of-check limitation as existing publication
guards; it is not a filesystem-wide atomic lock.

For a job submitted by this service, revocation can request cancellation only
against its captured original validated profile and exact submitted scheduler
identity. It never reconnects a changed profile or cancels a human-owned job.
The private snapshot records `cancel_requested` or `unconfirmed`; an SSH outage
or lost submission response can prevent confirmation. This is a cancellation
request, not proof of scheduler completion or deletion. No cleanup authority is
introduced. Revocation while the service is stopped cannot actively contact a
scheduler; local publication still requires an unchanged pinned policy.

Default responses expose the opaque grant, state and local result handles needed
for continuation. Raw scheduler text, remote IDs, paths and connection details
are omitted. `agent_metadata` independently permits stable request/profile hashes
and resources. Existing geometry, source-name, preview, measurement and provenance
disclosures remain independent. Nested remote provenance uses an explicit schema
allowlist; remote project/source/task/result IDs require `agent_metadata`.
Scientific archive/request/revision hashes remain provenance. Data-derived object
count requires `measurements`; resolved segmentation method and threshold
(including Otsu's resolved threshold) remain method provenance.

Attached results start unreviewed. A person reviews the exact local revision in
Loci or the human CLI; the agent can then export that exact reviewed revision
only to its existing authorized filename. Synthetic SDK/worker composition tests
exercise the bounded contract. A scheduler qualification additionally needs an
explicitly authorized run, returned native arrays/measurements and unreviewed
export denial on the exact candidate worker. These checks do not establish
biological accuracy, natural-language agent planning performance, independent
researcher usability or publication readiness.
