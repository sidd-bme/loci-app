# Visual workflows

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
are rejected. The initial version supports one connected sequence, without loops
or branches.

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

## Scope and design basis

This workspace reuses the validated quantitative recipe engine. It does not make
every Loci operation an interchangeable graph node. Reference-image flat-field
recipes, learned-model chaining, temporal loops, arbitrary scripts and general
branching require separate composition contracts. Unsupported steps are refused.
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
