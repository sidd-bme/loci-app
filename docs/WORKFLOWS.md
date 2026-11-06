# Visual workflows

Workflows compose Loci's general life-science imaging operations. Fluorescence,
histology and other assay examples do not define the platform's scope. Existing
scalar-recipe and morphology contracts retain explicit YX/ZYX support; adapters
limited to one plane continue to refuse volumes. This milestone does not add a
3D renderer or extend tissue inference beyond its declared 2D context/output grid.

Choose **Analyze → Workflow builder**. The workspace gives the connected analysis
plan and its settings more room while keeping the actual image visible. Choose
**View** to return to ordinary image inspection. Existing image detachment remains
available when a second display is useful.

## Build and inspect

Create a workflow from the current quantitative recipe or open a saved workflow
from this study. A workflow connects source selection, optional image processing,
segmentation, raw-channel measurement, an optional population filter, human review
and export. Select a node to inspect its parameters and input/output meaning.
Processing nodes can be added, removed and reconnected in their execution order.
Connections that would put labels or measurements into an image-processing input
are rejected. The linear editor supports one connected sequence. The separate
composed workflow panel below supports a bounded set of branches and joins.

Name and save the workflow before executing it. Saving checks the expected
revision, so another edit cannot be silently overwritten. Workflows are stored in
the study with their definitions and hashes. A saved definition is reusable across
compatible images; each execution separately records the exact source hash,
channel/plane/crop selection and resolved recipe.

Preview through a selected processing, segmentation, measurement or population
node. A preview does not publish a result. Processing changes derived pixels;
object intensity measurements continue to use the declared raw measurement
channels. Size parameters use the source's recorded geometry units. Pixel units
remain pixel units when trustworthy physical calibration is absent. RGB intensity
conversion is explicit and does not create biological channels.

Changing a definition, input scope or source makes earlier preview/run context
outdated. Historical results remain immutable. Save the edited definition and run
it to obtain a result for the new configuration; no change silently relabels an
old result as current.

## Execute, review and export

Run the current image or select compatible sources for a batch. Every selected
workflow target is preflighted before any batch job is submitted. The same explicit
selection is applied to each source; dimensions, channels and units must fit.
There is no implicit resizing, channel matching or biological interpretation.

Jobs are durable and visible in the existing job tray. Cancellation, interruption
and failure retain exact requests. Resume continues untouched queued work and
explicitly retries interrupted work; retry handles failed or cancelled requests.
The analysis sequence is one execution unit. Processing nodes do not claim
independent persistent checkpoints or cached intermediate outputs. Result
publication and successful job state are atomic, and a missing workflow receipt
can be reconstructed from that exact published result without rerunning it.

Inspect the result on its source image, then deliberately mark that exact revision
reviewed. Execution never grants review automatically. Export uses the native
destination picker and the existing atomic reviewed-result exporter. A workflow
bundle preserves the full result and adds the workflow definition and population
selection receipt. Its selected-measurement table contains the full matching
population, independent of plot sampling or table paging. Filtering does not
renumber labels or erase the full segmentation. File hashes bind the receipt to
the published bundle.

## Composed workflows

The **Composed workflows** panel opens saved version 2 definitions, checks exact
input bindings, starts native runs and advances them one native job at a time.
Definitions can be created through the scoped MCP interface. The panel does not
yet provide a graphical editor for authoring every connection.

Version 2 supports acyclic graphs of at most 32 nodes. Its typed adapters are
`run_recipe`, `classical_run`, `associate_results`, `spatial_distance_run` and
`morphometrics_run`, `annotation_evaluation_run`, `method_run` and
`tissue_model_run`. The morphology adapter consumes one exact `objects`
label-result and retains its raw measurements; see [the assay definitions](ASSAY_MEASUREMENTS.md).
Nodes accept declared source selections, exact label-result revisions, or an
explicit prepared tissue preview. A join
can consume outputs from separate upstream nodes; arbitrary operation names,
scripts, loops and JSON-path wiring are refused. The saved definition, its
revision/hash, resolved plan and exact input identities remain bound to each run.

Each executing node owns a distinct durable native job. The coordinator persists
the submission intent before dispatch and reconciles exact job ownership,
request identity and published output during recovery. Reopening a study does
not rerun completed nodes. Advance executes the next eligible native job;
cancellation prevents further dispatch and cooperatively cancels active work.
An interrupted or failed run remains inspectable rather than becoming a new
successful result through implicit retry.

Agent workflow control requires its own explicit grant in addition to permission
for every native operation and source dependency. Inspect permission does not
authorize execution. Native UI inspection of an agent-owned run does not transfer
its ownership or execute its pending jobs. Completion does not review results.
Linear version 1 definitions and their execution semantics remain supported.

### References, methods and prepared tissue

`annotation_evaluation_run` takes exact `prediction` and `reference` label results
on the same source, C/Z/T selection and calibrated grid. Settings declare instance
or foreground-region semantics, thresholds and the reference's intended coverage.
Its `agreement-report` output is terminal: it cannot feed a segmentation/measurement
port. Annotation agreement is not biological ground truth, accuracy validation or
human review. Freeze source annotations explicitly with the existing annotation
reference operation before binding that immutable result into a graph.

`method_run` takes `objects` and pins the method package ID, manifest/module hashes,
ordered raw channel indices, working-memory limit and `mode: execute`. Every live
run resolves its native ABI input/preflight hash from those exact source bytes.
This adapter's bounded native preflight prepares raw arrays; the other graph
adapters retain their metadata-only planning boundary. No compilation or method
execution occurs during graph preflight. Native rights review and current qualified
runtime gates remain mandatory during execution. macOS method execution remains
unavailable under the current confinement contract; a graph cannot grant or fake
that qualification. External output adoption stays an explicit native operation
with a fresh output grant, rather than a reusable node setting.

`tissue_model_run` takes a `preview` port bound to a `tissue-preview` input with
exact `preview_id`, `preview_hash` and the complete validated native `receipt`.
Its settings are empty. Prepare the preview explicitly with the existing native
preview operation; the graph never creates or approves it. The source context,
output grid, model/weights/runtime and declared stain remain bound to that receipt.
`workflow_graph_prepared_previews` lists currently cached unused previews for one
explicit `source_id`, with an `unavailable_count` for retained unusable entries.
Discovery performs no inference or source-pixel decoding. A preview may feed only
one tissue node and one graph run; preparing another run requires a fresh preview.
The existing exclusive disposable worker, model provisioning, runtime and grants
remain mandatory. A completed tissue node is recovered from its exact durable job,
retained preview receipt and published result even if the preview cache was evicted.
A tissue output can feed annotation agreement on an explicitly supplied reference;
the native morphology operation still refuses tissue-region parents.

### Capture and interruption

`workflow_graph_save_from_run` captures a successful graph's **definition**, under
a new workflow ID and chosen name. It requires the exact run document revision/hash
and destination CAS revision. It does not infer a workflow from arbitrary activity,
copy results, approve review or copy execution grants. Changed sources, stale
revisions and incomplete/failed runs are refused.

`workflow_graph_continuation` returns an inspectable receipt without dispatch or
ownership transfer. It binds the exact run revision/hash, original owner, plan,
completed node job/request/output proofs and unfinished nodes. Original-owner
inspection remains scoped to that session; possession of a run ID never grants
another session its metadata. Native application inspection is a separate trusted
boundary. Same-owner ordinary advance remains possible only with current grants.

A stopped failed/cancelled run can be continued through `workflow_graph_continue`
with explicit native human approval. The operation saves a new graph and prepares
a new run under the caller's current owner. Only proven successful nodes are
removed; their exact immutable outputs become explicit inputs to unfinished nodes.
Failed/interrupted/cancelled nodes are executed afresh. Existing jobs, ownership,
requests and results remain unchanged, and the new run durably retains its original
continuation receipt. Completed named outputs remain inspectable in that receipt.
The operation never advances the prepared run or grants scientific review.

Approval binds the original run revision/hash, continuation proof, new workflow ID,
fresh request key, new owner and newly preflighted plan. It is required even for
external sessions in Full access mode; Inspect-only cannot continue. Fresh source,
result, native-action, model and runtime grants are checked independently. Any
unfinished tissue node requires a fresh exact prepared preview, supplied by input
name in `preview_replacements`. Source/job/output drift after approval refuses
publication. An interrupted save/start can leave an inert saved definition;
retrying the exact approved identities reuses that definition/run rather than
silently creating another submission. Saving and starting are separate durable
transactions; an incomplete transition does not claim successful execution.

## Scope and design basis

This workspace reuses the validated quantitative recipe engine. It does not make
every Loci operation an interchangeable graph node. Reference-image flat-field
recipes, learned-model chaining, temporal loops, arbitrary scripts and adapters
outside the declared version 2 set require separate contracts. Unsupported steps
are refused.
Existing specialist tools remain available in their usual locations.

The integrated editor follows Loci's established image-first visual system.
[ANSYS Workbench's component model](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/wb2_js/wb2js_wbprojectconcepts.html)
informed explicit upstream/downstream data relationships.
[KNIME's editor and node monitor](https://docs.knime.com/ap/latest/analytics_platform_user_guide/)
informed selecting a node to inspect settings/output and making execution state
visible. [CellProfiler's pipeline workflow](https://cellprofiler-manual.s3.amazonaws.com/CellProfiler-4.2.5/help/pipelines_building.html)
informed testing an analysis on one image before a batch. These are design
references, accessed 3 October 2026, not claims of feature or performance parity.

Qualification requires declared analysis settings, authorized fixtures and
independent numerical checks on the exact candidate source and packaged app.
Numerical and workflow correctness are separate from segmentation agreement with
manual annotations, biological validity and usability validation. See
[release status](RELEASE_STATUS.md) for published artifacts and remaining gates.
