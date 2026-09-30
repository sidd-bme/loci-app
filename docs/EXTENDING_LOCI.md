# Extending Loci

This guide is for researchers and developers adding a bounded analysis workflow
to the current source tree. The downloadable application remains **v0.1.0-beta.1**;
the repository may contain newer development code. Check the [release record](PROJECT_STATE.md)
before attributing source-tree behavior to that download.

## Put the behavior at the right boundary

For an analysis operation, follow the existing path from engine to user:

1. Add its name and short description to `engine/src/loci_engine/research_operations.py`.
   If it should run as a durable job, register it in `TASK_OPERATIONS`; register
   previews in `PREVIEW_OPERATIONS` when applicable.
2. Implement the validated operation in a focused engine module and route it from
   `Workbench.execute` in `engine/src/loci_engine/workbench.py`. Keep request
   fields explicit and reject unknown or inconsistent values.
3. Confirm the intended caller path in `engine/src/loci_engine/research_rpc.py`.
   The local operator CLI is declared in `engine/src/loci_engine/research_cli.py`;
   its `discover` command reports the shared catalog. CLI access is an explicit
   local-human interface and may accept paths the operator selected.
4. For a desktop workflow, carry the operation through
   `desktop/src/main/research-bridge.ts` and the typed contracts in
   `desktop/src/shared/research-contracts.ts`. Add a researcher-facing control
   in `desktop/src/renderer/ResearchWorkbench.tsx` or its focused panel, with
   states for preview, running, failure, review and empty results as relevant.
5. Add focused engine and desktop tests at the layer where behavior lives. Add a
   packaged journey when the change crosses the desktop/engine boundary or changes
   a researcher workflow.

The local-human CLI and policy-scoped MCP server are separate interfaces. The
MCP server in `engine/src/loci_engine/research_mcp.py` exposes a narrow tool set
under an explicit policy; adding an operation to the catalog does not expose it
to MCP. Any MCP change must preserve policy checks on sources, operations,
disclosures, resources, review and export.

## Example: field assay preview and adoption

The existing field-assay path is a model for a small workflow with separate
preview and publication steps. `field_assay_preview` and `field_assay_run` are
catalog entries in `research_operations.py`; `Workbench.execute` routes both to
`engine/src/loci_engine/research_field_assay.py:execute_field_assay`. Preview
returns an inspectable, non-adopted summary. Run saves a derived `field-assay`
result with its source and analysis provenance. The two-channel synthetic
example in `engine/tests/test_fluorescence_assay.py::test_workbench_field_assay_preview_and_run`
checks both steps and the saved record. The desktop path is exercised by
`desktop/src/renderer/ResearchQuantificationPanel.field-assay.test.tsx` and the
macOS packaged journey `desktop/tests/field-assay-workflow.qa.mjs`.

When adding a similar workflow, first decide which inputs are observations,
operator choices and assumptions. Keep preview non-publishing; make adoption
create an identifiable derived result. Record the exact source identity, selected
axes/region, calibration, settings, software or model identity, and unresolved
assumptions needed to interpret that result. Do not infer a biological meaning
from pixel appearance or describe software checks as biological validation.

## Preserve scientific and review boundaries

- Treat source images and acquisition metadata as read-only. Store corrections,
  annotations, analysis arrays and measurements as explicit derived records.
- Keep array axes, channel meaning, coordinate transforms and units explicit.
  Preserve native sample values. Use physical units only when calibration is
  declared and valid; otherwise retain pixel or voxel units and say so.
- Bind edits and downstream analyses to exact source hashes and result revisions.
  Reject stale, non-finite, mismatched or unverifiable inputs instead of silently
  repairing them.
- Keep preview, adoption, human review and export distinct. A preview is not an
  adopted result; an adopted result is not human-reviewed. Review and export must
  refer to the exact result revision, and export must retain its provenance.
- Never silently download models or runtimes, add arbitrary code execution, or
  pass raw filesystem paths through the renderer. Model use requires explicit
  local provisioning and identity checks.

## Checks by change boundary

- **Engine operation or numerical behavior:** run the focused test module(s),
  then `cd engine && uv run ruff check . && uv run pytest` when the change affects
  engine contracts or shared numerical behavior.
- **Desktop-only UI or typed bridge behavior:** run the focused Vitest file(s),
  then `cd desktop && npm run check` for a desktop contract or integration change.
- **Desktop-to-engine interaction, persistence, or export:** run the applicable
  packaged macOS journey against the exact app candidate and authorized fixture.
  The combined source command
  `node scripts/run-core-regressions.mjs --mode=source` checks desktop and engine
  source suites; it does not replace packaged interaction checks.
- **Documentation-only change:** check local links, anchors, examples and the
  reviewed diff. Do not run unrelated application suites.

For build identity, packaging prerequisites and packaged journey instructions,
see [Building Loci](BUILDING.md). For user-facing image and analysis workflows,
see the [user guide](USING_LOCI.md).
