/** Packaged donor-report and composed-workflow journey on generated data.
 * Analysis mutations use ordinary visible controls; independent Python checks
 * read the actual study/artifacts after a fresh-process and profile reopen. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { fileMenuAction, selectWorkbenchTool } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '../..');
const bundle = process.env.LOCI_PACKAGED_APP, python = process.env.LOCI_QA_PYTHON;
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
assert.equal(process.platform, 'darwin');
for (const value of [bundle, python, process.env.LOCI_QA_OUTPUT_ROOT]) assert.ok(value && path.isAbsolute(value));
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
const output = await fs.mkdtemp(path.join(process.env.LOCI_QA_OUTPUT_ROOT, 'program-'));
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const helper = path.join(repo, 'scripts/fixtures/research_program_qa.py');
const hash = async file => { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(bundle, 'Contents/Resources/app.asar')), worker: await hash(worker) });
const receipt = { schema: 'loci.research-program-packaged-qa/v1', status: 'running', started_at: new Date().toISOString(), source_commit: sourceCommit, output,
  scope: 'Generated donor-density and native branching engineering QA; no biological qualification or human approval', checks: [], screenshots: [], renderer_errors: [], network_requests: [], dialogs: [] };
let app, page, fixture, exportPath, session = 0, failure;
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
async function wait(read, accept, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read(); if (accept(value)) return value;
    const state = await snapshot(); const failed = state?.jobs?.find(job => ['failed', 'interrupted'].includes(job.state));
    if (failed) throw new Error(`${label}: ${failed.operation} ${failed.state}: ${failed.error}`);
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); receipt.screenshots.push({ name, sha256: await hash(file) }); }
async function launch() {
  const userData = path.join(output, `profile-${++session}`); await fs.mkdir(userData);
  app = await electron.launch({ executablePath, args: ['--user-data-dir=' + userData], cwd: path.join(repo, 'desktop'), timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow, dialog }, values) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 });
    globalThis.__programDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Open research study') throw new Error('Unexpected picker: ' + title);
      globalThis.__programDialogs.push(title); return { canceled: false, filePaths: [values.study] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Export spatial donor density') throw new Error('Unexpected save picker: ' + title);
      globalThis.__programDialogs.push(title); return { canceled: false, filePath: values.exportPath };
    };
  }, { study: fixture.study, exportPath });
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await wait(snapshot, state => state?.sources?.length === 5 && state.results.length >= 16, 'native study open');
}
async function close() {
  if (!app) return;
  receipt.dialogs.push(...await app.evaluate(() => globalThis.__programDialogs));
  const closing = app; const done = closing.waitForEvent('close', { timeout: 30000 });
  await closing.evaluate(({ app }) => app.quit()); await done; app = undefined; page = undefined;
}
async function exportDensity(panel, destination) {
  await panel.getByRole('button', { name: 'Export density report…', exact: true }).click();
  await wait(async () => { try { return await json(path.join(destination, 'manifest.json')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }, Boolean, 'atomic density export');
  await panel.getByText(/Exact report values and provenance were exported/).waitFor();
}
async function graphPanel() {
  await selectWorkbenchTool(page, 'Workflow');
  const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Composed workflows' }) }).last();
  if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator(':scope > summary').click();
  return page.getByRole('region', { name: 'Composed workflows', exact: true });
}
try {
  receipt.build = await identity(); receipt.harness_sha256 = await hash(import.meta.filename); receipt.helper_sha256 = await hash(helper);
  receipt.build_manifest = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(receipt.build_manifest.sourceRevision, sourceCommit); assert.equal(receipt.build_manifest.sourceDirty, false);
  fixture = JSON.parse((await exec(python, [helper, 'create', '--root', path.join(output, 'fixture')], { cwd: repo, timeout: 60000 })).stdout);
  receipt.fixture = fixture; exportPath = path.join(output, 'export-before'); await launch();
  await selectWorkbenchTool(page, 'Density');
  let panel = page.getByRole('region', { name: 'Spatial donor density', exact: true });
  const preview = panel.getByRole('button', { name: 'Preview donor density', exact: true });
  assert.equal(await preview.isEnabled(), false);
  for (const field of fixture.fields) await panel.locator(`[data-density-result-id="${field.result_id}"] input[type="checkbox"]`).check();
  await panel.getByLabel('Density time and plane', { exact: true }).selectOption('0:0');
  await panel.getByLabel('Compare paired conditions', { exact: true }).check();
  assert.equal(await preview.isEnabled(), false);
  await panel.getByLabel('Density left condition', { exact: true }).selectOption('A');
  await panel.getByLabel('Density right condition', { exact: true }).selectOption('B');
  await preview.click();
  await panel.getByRole('region', { name: 'Density preview', exact: true }).waitFor();
  await shot('01-donor-preview');
  await panel.getByRole('button', { name: 'Save density report', exact: true }).click();
  await panel.getByRole('region', { name: 'Saved density report', exact: true }).waitFor();
  const library = await execute('spatial_density_list'); assert.equal(library.reports.length, 1);
  const reportId = library.reports[0].id;
  const before = await execute('spatial_density_get', { report_id: reportId });
  receipt.density = before;
  assert.equal(before.report.schema, 'loci.spatial-density-report/v2');
  assert.equal(before.summary.report_hash, before.report.report_hash);
  assert.ok(Buffer.byteLength(JSON.stringify(before.summary)) <= 64 * 1024);
  for (const table of ['input_snapshots', 'field_rows', 'donor_rows', 'condition_rows', 'paired_rows', 'paired_summary', 'unmatched_donors', 'exclusion_audit']) {
    const rows = []; let offset = 0;
    do {
      const response = await execute('spatial_density_query', { report_id: reportId, table, offset, limit: 1 });
      assert.equal(response.report_hash, before.report.report_hash);
      assert.equal(response.offset, offset);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 64 * 1024);
      rows.push(...response.rows);
      assert.equal(response.returned, response.rows.length);
      if (response.next_offset !== null) assert.ok(response.next_offset > offset);
      offset = response.next_offset;
    } while (offset !== null);
    assert.deepEqual(rows, before.report.aggregation[table]);
  }
  receipt.checks.push('bounded-pages-reconstruct-every-density-table');
  receipt.density_cells = [];
  for (const field of fixture.fields) {
    let offset = 0; const cells = [];
    do {
      const response = await execute('spatial_density_query', { report_id: reportId, table: 'cells', field_result_id: field.result_id, offset, limit: 1 });
      assert.equal(response.report_hash, before.report.report_hash);
      assert.equal(response.total, field.count);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 64 * 1024);
      assert.equal(response.returned, response.rows.length);
      if (response.next_offset !== null) assert.ok(response.next_offset > offset);
      cells.push(...response.rows); offset = response.next_offset;
    } while (offset !== null);
    assert.equal(cells.length, field.count);
    assert.ok(cells.every(cell => cell.result_id === field.result_id && cell.revision_hash === field.revision_hash && cell.biological_replicate === field.donor));
    receipt.density_cells.push(...cells);
  }
  receipt.checks.push('exact-paged-per-cell-measurements-with-donor-context');
  assert.equal(before.report.aggregation.condition_rows.find(r => r.condition === 'A').n, 2);
  assert.equal(before.report.aggregation.paired_rows.length, 1);
  assert.equal(before.report.aggregation.unmatched_donors[0].biological_replicate, 'D2');
  const densityState = await snapshot();
  assert.equal(densityState.jobs.filter(j => j.operation === 'spatial_density_save' && j.state === 'succeeded').length, 1);
  await exportDensity(panel, exportPath); await shot('02-donor-report-export');
  receipt.checks.push('explicit-stratum-pairing-and-durable-report-save', 'native-atomic-donor-report-export');

  let graph = await graphPanel();
  await graph.getByLabel('Saved composed workflow', { exact: true }).selectOption(fixture.graph.workflow.id);
  await graph.getByLabel('Workflow input image', { exact: true }).selectOption(fixture.graph.binding.bindings.image.source_id);
  assert.equal(await graph.getByRole('button', { name: 'Run composed workflow', exact: true }).isEnabled(), false);
  await graph.getByRole('button', { name: 'Check inputs', exact: true }).click();
  await wait(async () => graph.getByRole('button', { name: 'Run composed workflow', exact: true }).isEnabled(), Boolean, 'exact graph preflight');
  await shot('03-composed-preflight');
  await graph.getByRole('button', { name: 'Run composed workflow', exact: true }).click();
  await wait(snapshot, s => s.jobs.some(j => j.operation === 'run_recipe' && j.state === 'succeeded'), 'first native child');
  await wait(async () => graph.getByRole('button', { name: 'Advance workflow', exact: true }).isEnabled(), Boolean, 'next graph step available');
  await fileMenuAction(page, 'Save study');
  receipt.graph_partial_snapshot = await snapshot(); await shot('04-first-child-before-close'); await close();
  exportPath = path.join(output, 'export-after'); await launch();
  graph = await graphPanel();
  const runs = await execute('workflow_graph_runs');
  const graphRuns = runs.runs;
  assert.equal(graphRuns.length, 1); const runId = graphRuns[0].id;
  await graph.getByLabel('Saved composed run', { exact: true }).selectOption(runId);
  await wait(async () => graph.getByRole('button', { name: 'Advance workflow', exact: true }).isEnabled(), Boolean, 'cold graph resume');
  await graph.getByRole('button', { name: 'Advance workflow', exact: true }).click();
  await wait(snapshot, s => s.jobs.filter(j => j.operation === 'run_recipe' && j.state === 'succeeded').length === 2, 'second native child');
  await wait(async () => graph.getByRole('button', { name: 'Advance workflow', exact: true }).isEnabled(), Boolean, 'join available');
  await graph.getByRole('button', { name: 'Advance workflow', exact: true }).click();
  receipt.graph = await wait(() => execute('workflow_graph_status', { run_id: runId }), r => r.state === 'succeeded', 'native join');
  const children = Object.values(receipt.graph.run.data.nodes).map(n => n.intent.job_id);
  assert.equal(new Set(children).size, 3);
  const state = await snapshot(); assert.equal(state.jobs.filter(j => children.includes(j.id) && j.state === 'succeeded').length, 3);
  assert.equal(state.jobs.filter(j => j.operation === 'run_recipe').length, 2, 'cold reopen must not repeat the completed first child');
  await shot('05-completed-native-graph');
  await graph.getByRole('button', { name: 'Open result', exact: true }).last().click();
  await wait(snapshot, s => s.results.some(r => r.id === receipt.graph.run.data.outputs.associated.result_id), 'linked exact joined result');
  receipt.checks.push('mixed-linear-composed-workflow-libraries', 'native-branch-join-three-exact-child-jobs', 'cold-resume-without-duplicate-publication', 'graph-output-navigation');

  await selectWorkbenchTool(page, 'Density'); panel = page.getByRole('region', { name: 'Spatial donor density', exact: true });
  await panel.getByText(/^Saved density reports \(/).click();
  await panel.getByRole('button', { name: `Open density report ${reportId}`, exact: true }).click();
  await panel.getByRole('region', { name: 'Saved density report', exact: true }).waitFor();
  assert.deepEqual((await execute('spatial_density_get', { report_id: reportId })).report, before.report);
  await exportDensity(panel, exportPath); await fileMenuAction(page, 'Save study'); await shot('06-cold-report-reopen'); await close();
  receipt.oracle = JSON.parse((await exec(python, [helper, 'verify', '--root', path.join(output, 'fixture'),
    '--export', path.join(output, 'export-before'), '--export', path.join(output, 'export-after')], { cwd: repo, timeout: 60000 })).stdout);
  assert.equal(receipt.oracle.status, 'passed'); assert.deepEqual(await identity(), receipt.build);
  assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(receipt.network_requests, []);
  receipt.checks.push('independent-donor-arithmetic-native-array-and-export-oracle', 'fresh-profile-report-and-export-agreement');
  receipt.status = 'passed';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.error = { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr };
  if (page) { await shot('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  await close().catch(error => { receipt.cleanup_error = error.message; receipt.status = 'failed'; failure ??= error; });
  receipt.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: receipt.status, output, error: receipt.error?.message }) + '\n');
}
if (failure) throw failure;
