/** Packaged spatial journey. Generated input study; all analysis/review/export
 * mutations use visible controls. GUI review is simulated, never human approval. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { fileMenuAction, selectResultSection, selectWorkbenchTool } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '../..');
const bundle = process.env.LOCI_PACKAGED_APP, python = process.env.LOCI_QA_PYTHON;
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
assert.equal(process.platform, 'darwin');
for (const value of [bundle, python, process.env.LOCI_QA_OUTPUT_ROOT]) assert.ok(value && path.isAbsolute(value));
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
const output = await fs.mkdtemp(path.join(process.env.LOCI_QA_OUTPUT_ROOT, 'spatial-'));
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const helper = path.join(repo, 'scripts/fixtures/spatial_qa.py');
const hash = async file => { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(bundle, 'Contents/Resources/app.asar')), worker: await hash(worker) });
const receipt = { schema: 'loci.spatial-packaged-qa/v1', status: 'running', started_at: new Date().toISOString(), source_commit: sourceCommit, output,
  scope: 'Generated exact-grid engineering QA; simulated GUI review, no human approval or biological qualification', checks: [], screenshots: [], renderer_errors: [], network_requests: [], dialogs: [] };
let app, page, fixture, exportPath, session = 0, failure;
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const inspect = result_id => page.evaluate(result_id => window.lociResearch.execute('result', { result_id, offset: 0, limit: 1000 }), result_id);
async function wait(read, accept, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read(); if (accept(value)) return value;
    const state = await snapshot(); const failed = state?.jobs?.find(job => ['failed', 'interrupted', 'cancelled'].includes(job.state));
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
    globalThis.__spatialDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Open research study') throw new Error('Unexpected picker: ' + title);
      globalThis.__spatialDialogs.push(title); return { canceled: false, filePaths: [values.study] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Export reviewed result bundle') throw new Error('Unexpected save picker: ' + title);
      globalThis.__spatialDialogs.push(title); return { canceled: false, filePath: values.exportPath };
    };
  }, { study: fixture.study, exportPath });
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await wait(snapshot, state => state?.sources?.length === 1 && state.results.length >= 3, 'native study open');
}
async function close() {
  if (!app) return;
  receipt.dialogs.push(...await app.evaluate(() => globalThis.__spatialDialogs));
  const closing = app; const done = closing.waitForEvent('close', { timeout: 30000 });
  await closing.evaluate(({ app }) => app.quit()); await done; app = undefined; page = undefined;
}
async function selectResult(result) {
  await page.locator(`button[data-result-id="${result.id}"]`).click();
  await selectWorkbenchTool(page, 'Info'); await selectResultSection(page, 'Review');
  await page.getByRole('region', { name: 'Saved tissue distance bands', exact: true }).waitFor();
}
async function exportResult(destination) {
  await selectResultSection(page, 'Export');
  await page.getByRole('button', { name: 'Export result', exact: true }).click();
  await wait(async () => { try { return await json(path.join(destination, 'manifest.json')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }, Boolean, 'atomic export');
}
try {
  receipt.build = await identity(); receipt.harness_sha256 = await hash(import.meta.filename); receipt.helper_sha256 = await hash(helper);
  receipt.build_manifest = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(receipt.build_manifest.sourceRevision, sourceCommit); assert.equal(receipt.build_manifest.sourceDirty, false);
  fixture = JSON.parse((await exec(python, [helper, 'create', '--root', path.join(output, 'fixture')], { cwd: repo, timeout: 60000 })).stdout);
  receipt.fixture = fixture; exportPath = path.join(output, 'export-before'); await launch();
  await selectWorkbenchTool(page, 'Quantify'); await page.getByRole('button', { name: 'Tissue distances', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Tissue distance measurement', exact: true });
  const run = panel.getByRole('button', { name: 'Measure tissue distances', exact: true });
  assert.equal(await run.isEnabled(), false);
  for (const role of ['objects', 'compartment', 'boundary']) {
    const result = fixture.inputs[role];
    await panel.getByLabel(`Spatial ${role}`, { exact: true }).selectOption(`${result.id}:${result.revision_hash}`);
  }
  await panel.getByLabel('Spatial band edges', { exact: true }).fill('0, 10,'); assert.equal(await run.isEnabled(), false);
  await panel.getByLabel('Spatial band edges', { exact: true }).fill(fixture.request.band_edges.join(', '));
  await panel.getByLabel('Spatial controls', { exact: true }).fill(fixture.request.control);
  await panel.getByLabel('Spatial boundary coverage', { exact: true }).fill(fixture.request.boundary_coverage);
  assert.equal(await run.isEnabled(), true); await shot('01-explicit-spatial-inputs'); await run.click();
  const state = await wait(snapshot, state => state.results.some(r => r.kind === 'spatial-distance-bands'), 'durable GUI spatial result');
  const result = state.results.find(r => r.kind === 'spatial-distance-bands'); receipt.result = result;
  assert.equal(state.jobs.filter(j => j.operation === 'spatial_distance_run' && j.state === 'succeeded').length, 1);
  const before = await inspect(result.id); await selectResult(result);
  assert.deepEqual(before.provenance.spatial.bands, fixture.expected.bands);
  await shot('02-saved-spatial-table');
  await page.getByRole('button', { name: 'Explore in Statistics & objects', exact: true }).click();
  await page.getByLabel('Population X metric', { exact: true }).selectOption('spatial:distance');
  await page.getByRole('table', { name: 'Population object table', exact: true }).getByRole('button', { name: '#3', exact: true }).click();
  await page.getByRole('heading', { name: 'Object #3', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Locate selected object', exact: true }).click();
  await shot('03-distance-linked-object'); receipt.checks.push('distance-metric-and-object-navigation');
  await selectResult(result); await selectResultSection(page, 'Export');
  assert.equal(await page.getByRole('button', { name: 'Export result', exact: true }).isEnabled(), false);
  await selectResultSection(page, 'Review'); await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await wait(snapshot, s => s.results.find(r => r.id === result.id)?.review?.disposition === 'reviewed', 'simulated GUI review');
  await exportResult(exportPath); await fileMenuAction(page, 'Save study');
  receipt.before = await inspect(result.id); receipt.snapshot = await snapshot(); await close();
  exportPath = path.join(output, 'export-after'); await launch(); await selectResult(result);
  assert.deepEqual(await inspect(result.id), receipt.before, 'complete result survives fresh process/profile reopen');
  for (const prior of receipt.snapshot.results) assert.deepEqual((await snapshot()).results.find(r => r.id === prior.id), prior);
  await exportResult(exportPath); await shot('04-cold-reopen-export'); await close();
  for (const name of ['spatial-distance-bands.json', 'objects.csv', 'methods.md'])
    assert.equal(await hash(path.join(output, 'export-before', name)), await hash(path.join(output, 'export-after', name)), name);
  receipt.oracle = JSON.parse((await exec(python, [helper, 'verify', '--study', fixture.study, '--result', result.id], { cwd: repo, timeout: 60000 })).stdout);
  assert.equal(receipt.oracle.status, 'passed'); assert.deepEqual(await identity(), receipt.build);
  assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(receipt.network_requests, []);
  receipt.checks.push('explicit-input-and-numeric-draft-guards', 'durable-job-and-independent-distance-area-count-oracle', 'simulated-review-export-gate', 'fresh-profile-cold-reopen-and-export-agreement');
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
