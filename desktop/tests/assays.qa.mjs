/** Packaged wound + 2D/3D shape journeys on generated prerequisites only.
 * Assay publication, simulated result review and export use visible controls.
 * Read-only getters and deliberately invalid requests supplement the UI checks.
 */
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
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT, root = process.env.LOCI_QA_OUTPUT_ROOT;
assert.equal(process.platform, 'darwin');
for (const value of [bundle, python, root]) assert.ok(value && path.isAbsolute(value), 'Explicit absolute app, Python and evidence paths are required');
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
const output = await fs.mkdtemp(path.join(root, 'assays-'));
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const helper = path.join(repo, 'scripts/qa/assay_fixture.py');
const sha = async file => { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable: await sha(executablePath), asar: await sha(path.join(bundle, 'Contents/Resources/app.asar')),
  worker: await sha(path.join(bundle, 'Contents/Resources/loci-engine/loci-engine')) });
const receipt = { schema: 'loci.assays-packaged-qa/v1', status: 'running', source_commit: sourceCommit, output, started_at: new Date().toISOString(),
  scope: 'Generated engineering QA; simulated GUI review is not human approval or biological validation',
  checks: [], screenshots: [], dialogs: [], renderer_errors: [], network_requests: [], refusals: [], morphology: [] };
let app, page, fixture, session = 0, failure;
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
const inspect = result_id => execute('result', { result_id, offset: 0, limit: 1000 });
async function wait(read, accept, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read(); if (accept(value)) return value;
    const state = await snapshot();
    const failed = state?.jobs.find(j => ['failed', 'interrupted', 'cancelled'].includes(j.state));
    if (failed) throw new Error(`${label}: ${failed.operation} ${failed.state}: ${failed.error}`);
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); receipt.screenshots.push({ name, sha256: await sha(file) }); }
async function launch() {
  const profile = path.join(output, `profile-${++session}`); await fs.mkdir(profile);
  app = await electron.launch({ executablePath, args: ['--user-data-dir=' + profile], cwd: path.join(repo, 'desktop'), timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow, dialog }, values) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 });
    globalThis.__assayDialogs = []; globalThis.__assayDestination = null;
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Open research study') throw new Error('Unexpected native open picker: ' + title);
      globalThis.__assayDialogs.push({ title }); return { canceled: false, filePaths: [values.study] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (!['Export wound closure report', 'Export reviewed result bundle'].includes(title) || !globalThis.__assayDestination) throw new Error('Unexpected native export picker: ' + title);
      const filePath = globalThis.__assayDestination; globalThis.__assayDestination = null;
      globalThis.__assayDialogs.push({ title, basename: filePath.split('/').at(-1) }); return { canceled: false, filePath };
    };
  }, { study: fixture.study });
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await wait(snapshot, value => value?.sources.length === fixture.source_count && value.results.length >= fixture.initial_result_count, 'generated study open');
}
async function closeApp() {
  if (!app) return;
  receipt.dialogs.push(...await app.evaluate(() => globalThis.__assayDialogs));
  const closing = app, closed = closing.waitForEvent('close', { timeout: 30000 });
  await closing.evaluate(({ app }) => app.quit()); await closed; app = undefined; page = undefined;
}
async function assayTool(label) {
  const focused = page.locator('input:focus, textarea:focus, select:focus'); if (await focused.count()) await focused.press('Tab');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Search all tools', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search all tools', exact: true }).fill(label);
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function chooseSource(sourceId) {
  await page.locator(`button[data-source-id="${sourceId}"]`).click();
  await wait(async () => page.locator(`button[data-source-id="${sourceId}"]`).getAttribute('aria-current'), value => value === 'true', 'exact source activation');
}
async function chooseResult(result) {
  await chooseSource(result.source_id);
  await page.locator(`button[data-result-id="${result.id}"]`).click();
  await wait(async () => page.locator(`button[data-result-id="${result.id}"]`).getAttribute('aria-pressed'), value => value === 'true', 'exact result activation');
}
async function destination(value) { await app.evaluate((_electron, value) => { globalThis.__assayDestination = value; }, value); }
async function packageManifest(value) {
  return wait(async () => { try { return await json(path.join(value, 'manifest.json')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, Boolean, 'atomic export package');
}
async function exportWound(panel, target) {
  await destination(target); await panel.getByRole('button', { name: 'Export wound report…', exact: true }).click();
  await packageManifest(target); await page.getByText(`Exported ${path.basename(target)}. Exact endpoints, provenance and original masks were saved.`, { exact: true }).waitFor();
}
async function exportShape(result, target, review) {
  await chooseResult(result); await selectWorkbenchTool(page, 'Info'); await selectResultSection(page, 'Review');
  if (review) {
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await wait(snapshot, value => value.results.find(r => r.id === result.id)?.review?.disposition === 'reviewed', 'simulated GUI shape review');
  }
  await selectResultSection(page, 'Export'); await destination(target);
  const button = page.getByRole('button', { name: 'Export result', exact: true }); await button.click();
  await packageManifest(target); await wait(() => button.isEnabled(), Boolean, 'result export worker completion');
}
async function refused(operation, request, label) {
  const before = await snapshot();
  let reason = null;
  try { await execute(operation, request); } catch (error) { reason = error.message; }
  assert.ok(reason, `${label} was unexpectedly accepted`);
  const after = await snapshot(); assert.equal(after.results.length, before.results.length); assert.equal(after.jobs.length, before.jobs.length);
  receipt.refusals.push({ label, operation, reason });
}
async function woundJourney() {
  await assayTool('Wound closure');
  const choices = page.getByRole('region', { name: 'Wound mask choices', exact: true });
  for (const [index, field] of [...fixture.wound, fixture.wrong_grid].entries()) {
    await choices.getByLabel('Saved label mask', { exact: true }).selectOption(`${field.result_id}:${field.revision_hash}`);
    await choices.getByRole('button', { name: 'Load complete mask labels', exact: true }).click();
    await wait(() => choices.locator('li').count(), count => count === index + 1, 'complete exact mask membership');
    await choices.locator('li').nth(index).getByText(`${field.object_count} measured positive label IDs`, { exact: true }).waitFor();
  }
  assert.equal(fixture.wound[0].object_count, 1001);
  let panel = page.getByRole('region', { name: 'Wound closure', exact: true });
  for (const [label, key] of [['Specimen identity', 'specimen_id'], ['Sequence identity', 'sequence_id'], ['Acquisition time basis', 'time_declaration'], ['Filled-area definition', 'area_declaration'], ['Shared field of view and calibration', 'grid_declaration']])
    await panel.getByLabel(label, { exact: true }).fill(fixture.wound_request[key]);
  await panel.getByLabel('Selected labels represent filled wound area', { exact: true }).check();
  for (let index = 2; index < 5; index++) await panel.getByRole('button', { name: 'Add frame slot', exact: true }).click();
  const frame = index => panel.getByRole('group', { name: `Frame slot ${index + 1}${index === 0 ? ' · baseline' : ''}`, exact: true });
  for (const [index, slot] of fixture.wound_request.frames.entries()) {
    await frame(index).getByLabel('Frame identity', { exact: true }).fill(slot.frame_id);
    await frame(index).getByLabel('Actual time (s)', { exact: true }).fill(String(fixture.wound_request.time_s[index]));
    if (slot.missing_reason) {
      await frame(index).getByLabel('Missing acquisition', { exact: true }).check();
      await frame(index).getByLabel('Missing frame reason', { exact: true }).fill(slot.missing_reason);
    } else {
      await frame(index).getByLabel('Exact filled-area mask', { exact: true }).selectOption(`${slot.result_id}:${slot.revision_hash}`);
      if (slot.selected_labels.length) await frame(index).getByLabel('Filled-region label IDs', { exact: true }).fill(slot.selected_labels.join(', '));
      else await frame(index).getByLabel('Observed zero area (no selected labels)', { exact: true }).check();
    }
  }
  const preview = panel.getByRole('button', { name: 'Preview wound closure', exact: true });
  assert.equal(await preview.isEnabled(), true); await shot('01-wound-explicit-sequence');
  await preview.click(); await panel.getByRole('heading', { name: 'Verified preview', exact: true }).waitFor();
  const endpoints = panel.getByRole('region', { name: 'Wound frame endpoints', exact: true });
  await endpoints.getByRole('cell', { name: '-0.5', exact: true }).waitFor();
  await endpoints.getByRole('cell', { name: /Observed zero area/u }).waitFor();
  assert.equal(await panel.locator('.wound-plot circle').count(), 4); assert.equal(await panel.locator('[data-wound-interval]').count(), 2);
  // A changed real time immediately invalidates the retained preview identity.
  await frame(2).getByLabel('Actual time (s)', { exact: true }).fill('40');
  assert.equal(await preview.isEnabled(), false); assert.equal(await panel.getByRole('button', { name: 'Save immutable report', exact: true }).count(), 0);
  await frame(2).getByLabel('Actual time (s)', { exact: true }).fill('90');
  await preview.click(); await panel.getByRole('heading', { name: 'Verified preview', exact: true }).waitFor();
  await frame(2).getByLabel('Exact filled-area mask', { exact: true }).selectOption(`${fixture.wrong_grid.result_id}:${fixture.wrong_grid.revision_hash}`);
  assert.equal(await panel.getByRole('button', { name: 'Save immutable report', exact: true }).count(), 0);
  await frame(2).getByLabel('Filled-region label IDs', { exact: true }).fill('4000000000');
  await preview.click(); await panel.getByRole('alert').filter({ hasText: /field of view|grid|calibration/iu }).waitFor();
  const proper = fixture.wound.find(value => value.t === 2);
  await frame(2).getByLabel('Exact filled-area mask', { exact: true }).selectOption(`${proper.result_id}:${proper.revision_hash}`);
  await frame(2).getByLabel('Filled-region label IDs', { exact: true }).fill('4000000000');
  await preview.click(); await panel.getByRole('heading', { name: 'Verified preview', exact: true }).waitFor();
  await shot('02-wound-missing-growth-zero');
  await panel.getByRole('button', { name: 'Save immutable report', exact: true }).click();
  await panel.getByRole('heading', { name: 'Saved wound report', exact: true }).waitFor();
  const library = await execute('wound_closure_list'); assert.equal(library.reports.length, 1);
  const reportId = library.reports[0].id, saved = await execute('wound_closure_get', { report_id: reportId });
  assert.deepEqual(saved.report.request, fixture.wound_request);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.summary)) <= 64 * 1024);
  assert.deepEqual(saved.report.measurement.frames.map(row => row.area), [72, null, 36, 108, 0]);
  assert.deepEqual(saved.report.measurement.frames.map(row => row.closure_fraction), [0, null, 0.5, -0.5, 1]);
  const state = await snapshot(); assert.equal(state.jobs.filter(j => j.operation === 'wound_closure_save' && j.state === 'succeeded').length, 1);
  await panel.getByRole('button', { name: 'Inspect input reviews', exact: true }).click();
  const histories = page.getByRole('region', { name: 'Wound input review histories', exact: true });
  await histories.getByRole('button', { name: 'Read input review history', exact: true }).first().click();
  await histories.getByText('0 recorded review decisions for this input.', { exact: true }).waitFor();
  await shot('03-existing-input-review-history');
  await exportWound(panel, path.join(output, 'wound-before'));
  const stale = structuredClone(fixture.wound_request); stale.frames[0].revision_hash = '0'.repeat(64);
  await refused('wound_closure_preview', stale, 'stale exact wound revision');
  receipt.checks.push('complete-1001-label-membership-selects-last-label', 'native-explicit-wound-sequence-and-missing-slots', 'negative-growth-and-zero-area-remain-distinct',
    'time-edit-invalidates-preview-and-duplicate-time-blocked', 'changed-source-grid-refused-without-publication', 'read-only-existing-input-reviews', 'durable-native-wound-report-and-export');
  return saved;
}
async function shapeJourney(item) {
  await chooseSource(item.source_id); await assayTool('Nuclear & cell shape');
  const panel = page.getByRole('region', { name: 'Nuclear and cell shape', exact: true });
  assert.equal(await panel.getByRole('button', { name: 'Measure object shape', exact: true }).isEnabled(), false);
  await panel.getByLabel('Shape label result', { exact: true }).selectOption(`${item.result_id}:${item.revision_hash}`);
  await panel.getByRole('button', { name: 'Measure object shape', exact: true }).click();
  const state = await wait(snapshot, value => value.results.some(r => r.kind === 'morphometrics' && r.parent_id === item.result_id), 'exact native morphology derivative');
  const result = state.results.find(r => r.kind === 'morphometrics' && r.parent_id === item.result_id);
  await panel.getByRole('region', { name: 'Saved object shape measurements', exact: true }).waitFor();
  assert.equal(state.jobs.filter(j => j.operation === 'morphometrics_run' && j.result_ids.includes(result.id) && j.state === 'succeeded').length, 1);
  const full = await inspect(result.id), parent = await inspect(item.result_id);
  assert.equal(full.provenance.morphometrics.input.result_id, item.result_id); assert.equal(full.provenance.morphometrics.input.revision_hash, item.revision_hash);
  assert.deepEqual(result.arrays, parent.result.arrays);
  const population = await execute('population_query', { result_id: result.id, revision_hash: result.revision_hash, x_metric: item.metric, y_metric: 'voxel_count', selected_label: 4000000000, offset: 0, limit: 200 });
  const descriptor = population.metrics.find(value => value.id === item.metric); assert.ok(descriptor);
  assert.equal(descriptor.unit, item.axes === 'YX' ? item.unit : `${item.unit}^2`);
  assert.equal(population.selected.row.label, 4000000000);
  assert.equal(population.selected.row.values[item.metric], full.measurements.find(row => row.label === 4000000000).morphometrics[item.metric.split(':')[1]]);
  await panel.getByRole('button', { name: 'Plot and inspect objects', exact: true }).click();
  await page.getByLabel('Population X metric', { exact: true }).selectOption(item.metric);
  await page.getByRole('table', { name: 'Population object table', exact: true }).getByRole('button', { name: '#4000000000', exact: true }).click();
  await page.getByRole('heading', { name: 'Object #4000000000', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Locate selected object', exact: true }).click();
  await shot('shape-' + item.name + '-linked-object');
  await exportShape(result, path.join(output, item.name + '-before'), true);
  receipt.morphology.push({ name: item.name, result, inspect: await inspect(result.id), population });
  return result;
}
try {
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 60000 });
  receipt.signature_verified = true;
  receipt.build = await identity(); receipt.harness_sha256 = await sha(import.meta.filename); receipt.helper_sha256 = await sha(helper);
  receipt.build_manifest = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(receipt.build_manifest.sourceRevision, sourceCommit); assert.equal(receipt.build_manifest.sourceDirty, false);
  fixture = JSON.parse((await exec(python, [helper, 'create', '--root', path.join(output, 'fixture')], { cwd: repo, timeout: 60000 })).stdout);
  receipt.fixture = fixture; await launch();
  receipt.wound = await woundJourney();
  for (const item of fixture.morphology) await shapeJourney(item);
  const badShape = { result_id: fixture.morphology[0].result_id, revision_hash: fixture.morphology[1].revision_hash, working_bytes: 256 * 1024 ** 2 };
  await refused('morphometrics_run', badShape, 'cross-source morphology revision binding');
  receipt.before = await snapshot(); await fileMenuAction(page, 'Save study'); await shot('04-first-session-complete'); await closeApp();
  await launch();
  const cold = await snapshot(); assert.equal(cold.jobs.filter(j => j.operation === 'morphometrics_run' && j.state === 'succeeded').length, 4);
  assert.equal(cold.jobs.filter(j => j.operation === 'wound_closure_save' && j.state === 'succeeded').length, 1);
  for (const original of receipt.before.results) assert.deepEqual(cold.results.find(r => r.id === original.id), original);
  await assayTool('Wound closure'); let woundPanel = page.getByRole('region', { name: 'Wound closure', exact: true });
  await woundPanel.getByText(/^Saved wound reports \(/u).click();
  await woundPanel.getByRole('button', { name: 'Open saved report', exact: true }).click();
  await woundPanel.getByRole('heading', { name: 'Saved wound report', exact: true }).waitFor();
  assert.deepEqual((await execute('wound_closure_get', { report_id: receipt.wound.report_id })).report, receipt.wound.report);
  await exportWound(woundPanel, path.join(output, 'wound-after')); await shot('05-cold-wound-reopen');
  for (const entry of receipt.morphology) {
    await exportShape(entry.result, path.join(output, entry.name + '-after'), false);
    assert.deepEqual(await inspect(entry.result.id), entry.inspect);
  }
  await fileMenuAction(page, 'Save study'); await closeApp();
  const verify = [helper, 'verify', '--root', path.join(output, 'fixture'), '--wound-export', path.join(output, 'wound-before'), '--wound-export', path.join(output, 'wound-after')];
  for (const item of fixture.morphology) for (const phase of ['before', 'after']) verify.push('--morph-export', `${item.name}=${path.join(output, item.name + '-' + phase)}`);
  receipt.oracle = JSON.parse((await exec(python, verify, { cwd: repo, timeout: 60000 })).stdout); assert.equal(receipt.oracle.status, 'passed');
  assert.deepEqual(await identity(), receipt.build); assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(receipt.network_requests, []);
  receipt.checks.push('pixel-and-anisotropic-physical-2d-and-3d-shape-descriptors', 'linked-population-metric-and-selected-object', 'simulated-gui-review-and-native-result-export',
    'fresh-profile-cold-reopen-without-duplicate-jobs', 'independent-sqlite-array-csv-and-curve-coordinate-oracles', 'stable-export-csv-mask-and-curve-hashes');
  receipt.status = 'passed';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.error = { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr };
  if (page) { await shot('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  await closeApp().catch(error => { receipt.cleanup_error = error.message; receipt.status = 'failed'; failure ??= error; });
  receipt.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: receipt.status, output, error: receipt.error?.message }) + '\n');
}
if (failure) throw failure;
