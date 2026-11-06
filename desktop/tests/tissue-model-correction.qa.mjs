/** Packaged tissue correction + portable-restore QA extension (engineering only).
 * Complements tissue-model.qa.mjs without altering its frozen oracle. Same pinned public
 * fixture, exact converted weights and env contract; no downloads, no mocked inference.
 * Native pickers are explicitly simulated (main/preload/worker routing stays real); they
 * are never evidence for ordinary native UI QA. Reviews are automated, never human approval.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { createEmptyStudy, fileMenuAction, selectWorkbenchTool, setSelectionField } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '../..');
const requiredPaths = ['LOCI_PACKAGED_APP', 'LOCI_QA_PYTHON', 'LOCI_QA_OUTPUT_ROOT',
  'LOCI_QA_TISSUE_SOURCE', 'LOCI_QA_TISSUE_WEIGHTS', 'LOCI_QA_TISSUE_CONVERSION_RECEIPT',
  'LOCI_QA_TISSUE_REFERENCE_RECEIPT', 'LOCI_QA_TISSUE_REFERENCE_CLASSES', 'LOCI_QA_TISSUE_REFERENCE_PROBABILITIES',
  'LOCI_QA_TISSUE_FREEZE', 'LOCI_QA_TISSUE_DESKTOP_PACKET'];
assert.equal(process.platform, 'darwin');
assert.equal(process.versions.node.split('.')[0], '24', 'Run with supported Node 24');
for (const name of requiredPaths) assert.ok(path.isAbsolute(process.env[name] ?? ''), `${name} must be an explicit absolute path`);
const env = process.env, bundle = env.LOCI_PACKAGED_APP, python = env.LOCI_QA_PYTHON;
const sourceCommit = env.LOCI_QA_SOURCE_COMMIT;
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
const SOURCE = '34d13bdc3b05a9ab580f3edc63e826f38f1e1c10bafeacacb0d7573096226166';
const ORACLE = '1b97c2b1ab9291d52f0c2bf1963fc61e59a12e6a6d9df508a7bea81c5b67a7d7';
const context = { x: 0, y: 0, width: 1024, height: 1024, z: 0, t: 0, c: 0, level: 0 };
const region = { ...context, x: 960, width: 64, height: 64 };
const output = await fs.mkdtemp(path.join(env.LOCI_QA_OUTPUT_ROOT, 'tissue-correction-'));
const study = path.join(output, 'TRAINING004.loci-study'), source = path.join(output, 'TRAINING004.tif');
const offlineSource = path.join(output, 'TRAINING004.offline.tif');
const restored = path.join(output, 'restored.loci-study'), archive = path.join(output, 'portable.loci-study.zip');
const exports = { refused: path.join(output, 'exported-unreviewed'), sourceOffline: path.join(output, 'exported-source-offline'),
  corrected: path.join(output, 'exported-corrected'), original: path.join(output, 'exported-original') };
const oracle = path.join(repo, 'scripts/qa/tissue_model_journey.py');
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const sha = async file => { assert.equal((await fs.lstat(file)).isFile(), true, `Expected plain file: ${file}`); const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => Boolean(await fs.lstat(file).catch(() => null));
const identity = async () => ({ executable: await sha(executablePath), asar: await sha(path.join(bundle, 'Contents/Resources/app.asar')), worker: await sha(path.join(bundle, 'Contents/Resources/loci-engine/loci-engine')) });
const receipt = { schema: 'loci.tissue-correction-portable-packaged-qa/v1', status: 'running', output, source_commit: sourceCommit,
  started_at: new Date().toISOString(), scientific_qualification: 'not-established', human_review: false,
  scope: 'Packaged engineering QA of correction, review/export gating and portable restore; TRAINING004 is not holdout; no accuracy claim.',
  limits: ['Class-4 epidermis does not establish a basal boundary; stroma is not automatically dermis.',
    'Softmax scores are uncalibrated; model grid spacing is not physical source calibration.',
    'Native picker selections are harness simulations; ordinary native UI QA is separate.',
    'Correction is submitted through the real packaged IPC bridge, not by pointer drawing; interactive drawing is covered by existing correction journeys.',
    'Automated review is not human scientific approval.'],
  checks: [], dialogs: [], screenshots: [], renderer_errors: [], network_requests: [], processes: [] };
let app, page, failure, processTimer, processScan = Promise.resolve();
const owned = new Map();
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
const attempt = (fn, args) => page.evaluate(async ({ fn, args }) => { try { return { ok: true, value: await window.lociResearch[fn](...args) }; } catch (error) { return { ok: false, message: String(error?.message ?? error) }; } }, { fn, args });
async function table() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { timeout: 3000 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => { const f = line.trim().split(/\s+/u); return [Number(f[0]), { parent: Number(f[1]), group: Number(f[2]), state: f[3], start: f.slice(4).join(' ') }]; }));
}
async function remember() {
  if (!app) return;
  const rows = await table(), roots = new Set([app.process().pid]);
  for (const [pid, start] of owned) if (rows.get(pid)?.start === start) roots.add(pid);
  for (;;) { const before = roots.size; for (const [pid, row] of rows) if (roots.has(row.parent)) roots.add(pid); if (roots.size === before) break; }
  for (const pid of roots) if (rows.has(pid)) owned.set(pid, rows.get(pid).start);
}
async function wait(read, accept, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (accept(value)) return value;
    const state = await snapshot();
    const failed = state?.jobs.find(job => ['failed', 'cancelled', 'interrupted'].includes(job.state));
    assert.ok(!failed, `${label}: ${JSON.stringify(failed)}`);
    if (page) {
      const alert = page.locator('.research-alert.recoverable-error').filter({ visible: true }).first();
      if (await alert.count() > 0) {
        const summary = alert.locator('summary');
        if (await summary.count() > 0) await summary.click().catch(() => {});
        const alertText = await alert.innerText().catch(() => 'alert text unavailable');
        throw new Error(`Encountered research alert while waiting for ${label}: ${alertText}`);
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); receipt.screenshots.push({ name, sha256: await sha(file) }); }
async function launch(session) {
  const profile = path.join(output, 'profile-' + session);
  app = await electron.launch({ executablePath, args: ['--user-data-dir=' + profile], cwd: path.join(repo, 'desktop'), timeout: 120000,
    env: { ...env, LOCI_MODEL_HOME: path.join(profile, 'models') } });
  if (app.process().stdout) app.process().stdout.pipe(process.stdout);
  if (app.process().stderr) app.process().stderr.pipe(process.stderr);
  await remember();
  processTimer = setInterval(() => { processScan = processScan.then(remember).catch(error => { receipt.process_tracking_error = error.message; }); }, 500);
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow, dialog }, values) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 });
    globalThis.__tissueQAPickerSimulation = [];
    globalThis.__tissueQANextExport = values.nextExport;
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const selected = { 'Open research study': values.openStudy, 'Add microscopy or medical images': values.source,
        'Import exact PUMA network weights': values.weights, 'Select the exact PUMA conversion receipt': values.conversion,
        'Import portable Loci study': values.archive }[title];
      if (!selected) throw new Error('Unexpected harness-simulated native open picker: ' + title);
      globalThis.__tissueQAPickerSimulation.push({ title, simulation: true });
      return { canceled: false, filePaths: [selected] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const filePath = { 'Create research study': values.study, 'Export reviewed result bundle': globalThis.__tissueQANextExport,
        'Export portable study with derived results': values.archive, 'Choose a new study directory': values.restored }[title];
      if (!filePath) throw new Error('Unexpected harness-simulated native save picker: ' + title);
      globalThis.__tissueQAPickerSimulation.push({ title, simulation: true, filePath });
      return { canceled: false, filePath };
    };
  }, { study, openStudy: session === 1 ? study : restored, source, archive, restored,
    weights: env.LOCI_QA_TISSUE_WEIGHTS, conversion: env.LOCI_QA_TISSUE_CONVERSION_RECEIPT, nextExport: exports.refused });
  await page.waitForFunction(() => Boolean(window.lociResearch));
}
/** Re-point the simulated export destination without changing which dialog is simulated. */
const exportTo = destination => app.evaluate((_, filePath) => {
  globalThis.__tissueQANextExport = filePath;
}, destination);
async function close() {
  clearInterval(processTimer); await processScan;
  let quitError;
  if (app) {
    await remember();
    receipt.dialogs.push(...await app.evaluate(() => globalThis.__tissueQAPickerSimulation ?? []).catch(() => []));
    const closing = app, closed = closing.waitForEvent('close', { timeout: 30000 });
    try { await closing.evaluate(({ app }) => app.quit()); await closed; }
    catch (error) { quitError = error; await closing.close().catch(() => {}); }
    finally { app = undefined; page = undefined; }
  }
  let rows = await table();
  for (let tries = 0; tries < 15 && [...owned].some(([pid, start]) => rows.get(pid)?.start === start); tries++) {
    await new Promise(resolve => setTimeout(resolve, 200)); rows = await table();
  }
  let remaining = [...owned].filter(([pid, start]) => rows.get(pid)?.start === start);
  const cleanup = { observed: [...owned].map(([pid, start]) => ({ pid, start })), survivors_after_quit: remaining.map(([pid]) => pid) };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const [pid, start] of remaining) if ((await table()).get(pid)?.start === start) { try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (remaining.length) await new Promise(resolve => setTimeout(resolve, 1500));
    rows = await table(); remaining = [...owned].filter(([pid, start]) => rows.get(pid)?.start === start);
  }
  cleanup.final_survivors = remaining.map(([pid]) => pid); receipt.processes.push(cleanup); owned.clear();
  assert.deepEqual(cleanup.final_survivors, [], 'Owned process survived cleanup');
  assert.deepEqual(cleanup.survivors_after_quit, [], 'Ordinary quit left owned processes; forced cleanup was required');
  if (quitError) throw quitError;
}
async function tissueTool() {
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Search all tools', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search all tools', exact: true }).fill('Epidermis model');
  await page.getByRole('option', { name: 'Epidermis model', exact: true }).click();
}
/** Run one frozen-oracle Python verification in an isolated interpreter (no repo imports other than the oracle file). */
let configCount = 0;
async function pythonCheck(body, config) {
  const file = path.join(output, `config-${config.name}-${++configCount}.json`); await fs.writeFile(file, JSON.stringify({ oracle, ...config }));
  const prelude = String.raw`
import hashlib, importlib.util, json, pathlib, sys
import numpy as np
c=json.loads(pathlib.Path(sys.argv[1]).read_text())
spec=importlib.util.spec_from_file_location('frozen_tissue_oracle', c['oracle'])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def arrays_of(project, result):
  out={}
  for key,d in result['arrays'].items():
    p=pathlib.Path(project)/'artifacts'/(d['sha256']+'.npy')
    assert m.digest(p)==d['sha256'], key
    a=m.load_array(p); assert list(a.shape)==d['shape'] and str(a.dtype)==d['dtype'], key
    out[key]=a
  return out
`;
  const { stdout } = await exec(python, ['-I', '-c', prelude + body, file], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
const viewChecks = (project, result, name) => pythonCheck(String.raw`
arrays=arrays_of(c['project'], c['result'])
out=pathlib.Path(c['views_output']); out.mkdir()
def call(operation, request):
  assert operation=='result_view'
  matches=[item['view'] for item in c['views'] if item['request']==request]
  assert len(matches)==1
  return matches[0]
m.check_views(call, c['result'], arrays, out, c['name'])
print(json.dumps({'native_png_pixels_equal': True, 'arrays': {k: hashlib.sha256(v.tobytes()).hexdigest() for k,v in arrays.items()}}))
`, { name, project, result, views: c_views.get(name), views_output: path.join(output, name + '-views') });
const c_views = new Map();
async function collectViews(result, name) {
  const views = [];
  for (const field of ['tissue_classes', 'compartments', 'epidermis_score']) {
    const request = { result_id: result.id, display: { low: 0, high: 1, gamma: 1, color: '#ffffff' } };
    if (field === 'epidermis_score') request.labels = false; else if (field === 'tissue_classes') request.label_field = field;
    const view = await execute('result_view', request);
    assert.equal(view.result_id, result.id); assert.equal(view.revision_hash, result.revision_hash);
    assert.equal(view.field, field); assert.ok(view.basis); assert.deepEqual(view.shape, [64, 64]);
    views.push({ request, view });
  }
  c_views.set(name, views);
}
async function verifyViews(project, result, name) { await collectViews(result, name); return viewChecks(project, result, name); }
async function openRestoredStudy() {
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  return wait(snapshot, value => value?.results.length === 2, 'fresh-profile restored study');
}
try {
  receipt.harness_sha256 = await sha(import.meta.filename); receipt.oracle_sha256 = await sha(oracle); assert.equal(receipt.oracle_sha256, ORACLE);
  receipt.build = await identity(); receipt.build_manifest = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(receipt.build_manifest.sourceRevision, sourceCommit); assert.equal(receipt.build_manifest.sourceDirty, false);
  receipt.git_head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo, timeout: 5000 })).stdout.trim();
  assert.equal(receipt.git_head, sourceCommit, 'QA checkout and packaged source revision must agree');
  receipt.source_packets = [];
  for (const filename of [env.LOCI_QA_TISSUE_FREEZE, env.LOCI_QA_TISSUE_DESKTOP_PACKET]) {
    const packet = await json(filename);
    for (const [relative, expected] of Object.entries(packet.files)) {
      assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
      assert.equal(await sha(path.join(repo, relative)), expected, `Frozen source changed: ${relative}`);
    }
    const paths = Object.keys(packet.files); assert.ok(paths.length > 0, 'Empty frozen source packet');
    await exec('git', ['ls-files', '--error-unmatch', '--', ...paths], { cwd: repo, timeout: 5000 });
    await exec('git', ['diff', '--quiet', sourceCommit, '--', ...paths], { cwd: repo, timeout: 5000 });
    receipt.source_packets.push({ path: filename, sha256: await sha(filename), files: packet.files });
  }
  receipt.inputs = {};
  for (const key of requiredPaths.filter(key => !['LOCI_PACKAGED_APP', 'LOCI_QA_OUTPUT_ROOT'].includes(key))) receipt.inputs[key] = { path: env[key], sha256: await sha(await fs.realpath(env[key])) };
  assert.equal(await sha(env.LOCI_QA_TISSUE_SOURCE), SOURCE);
  await fs.copyFile(env.LOCI_QA_TISSUE_SOURCE, source); assert.equal(await sha(source), SOURCE);

  // 1. Real packaged inference and adoption (the same declared-H&E, full-context, 64x64 ROI request).
  await launch(1); await createEmptyStudy(page);
  // Study creation is asynchronous: wait for the header action instead of racing into the File menu.
  await page.getByRole('button', { name: 'Add images…', exact: true }).filter({ visible: true }).first().waitFor();
  await fileMenuAction(page, 'Add images…');
  const imported = await wait(snapshot, value => value?.sources.length === 1, 'native public source import');
  const sourceRecord = imported.sources[0]; assert.equal(sourceRecord.sha256, SOURCE);
  await page.locator(`button[data-source-id="${sourceRecord.id}"]`).click();
  await selectWorkbenchTool(page, 'Display');
  for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['C', 'c']]) await setSelectionField(page, label, region[key]);
  await tissueTool();
  const panel = page.getByRole('region', { name: 'Epidermis tissue model', exact: true });
  await panel.getByLabel('Tissue preparation', { exact: true }).selectOption('hematoxylin-eosin');
  await panel.getByRole('button', { name: 'Import weights & receipt…', exact: true }).click();
  await wait(() => execute('tissue_model_profiles'), value => value.profiles[0].store.provisioned, 'native exact two-file import');
  await wait(() => panel.getByRole('button', { name: 'Import weights & receipt…', exact: true }).isEnabled(), Boolean, 'native import UI settled');
  await panel.getByRole('button', { name: 'Preview candidate mask', exact: true }).click();
  await panel.getByRole('img', { name: 'Exact source-region preview with candidate epidermis overlay', exact: true }).waitFor({ timeout: 180000 });
  await panel.getByRole('button', { name: 'Create result from preview', exact: true }).click();
  const adopted = await wait(snapshot, value => value?.results.length === 1, 'durable exact preview adoption');
  const original = adopted.results[0]; receipt.original = original;
  assert.equal(original.kind, 'tissue-model-regions'); assert.equal(original.review ?? null, null);
  const originalRecord = await execute('result', { result_id: original.id });
  const workingBytes = originalRecord.provenance.working_bytes;
  receipt.original_numerical = await pythonCheck(String.raw`
arrays=arrays_of(c['project'], c['result'])
assert set(arrays)=={'labels','image','class_labels','probabilities'}
checks={}
for key,p in c['references'].items():
  expected=m.load_array(pathlib.Path(p))
  assert hashlib.sha256(expected.tobytes()).hexdigest()==m.REFERENCE_ARRAYS[key]
  assert arrays[key].dtype==expected.dtype and arrays[key].shape==expected.shape and arrays[key].tobytes()==expected.tobytes()
  checks[key]={'bitwise_equal':True,'raw_sha256':hashlib.sha256(arrays[key].tobytes()).hexdigest()}
print(json.dumps({'arrays':checks}))
`, { name: 'original', project: study, result: original, references: { class_labels: env.LOCI_QA_TISSUE_REFERENCE_CLASSES, probabilities: env.LOCI_QA_TISSUE_REFERENCE_PROBABILITIES } });
  receipt.original_views = await verifyViews(study, original, 'original');
  receipt.checks.push('packaged-real-inference-adoption-bitwise-reference');

  // 2. Correction through the packaged bridge: immutable derived revision, unreviewed, original unchanged.
  const info = await execute('correction_info', { result_id: original.id, revision_hash: original.revision_hash });
  assert.ok(info.label_ids.length >= 1); assert.deepEqual(info.measurement_channels, []);
  const label = info.label_ids[0];
  const boundary = await execute('correction_info', { result_id: original.id, revision_hash: original.revision_hash, label, plane: 'XY', index: 0 });
  const vertex = boundary.boundary.vertices_uv[0]; receipt.correction_vertex = vertex;
  const correction = { result_id: original.id, revision_hash: original.revision_hash, working_bytes: workingBytes,
    operations: [{ op: 'brush', mode: 'erase', plane: 'XY', index: 0, points: [{ u: vertex.u, v: vertex.v }], radius: 3, label, expected_input_sha256: info.label_sha256 }] };
  const correctionRun = await execute('correct_result', correction);
  assert.equal(correctionRun.job.state, 'succeeded');
  const corrected = correctionRun.result; receipt.corrected = corrected;
  assert.equal(corrected.kind, 'corrected-labels'); assert.equal(corrected.parent_id, original.id);
  assert.equal(corrected.review ?? null, null, 'Correction silently inherited a review');
  assert.notEqual(corrected.revision_hash, original.revision_hash);
  assert.equal(corrected.tissue_model.label_semantics, 'edited_selected_compartment');
  assert.deepEqual(corrected.selection, region); assert.equal(corrected.source_sha256, SOURCE);
  assert.deepEqual(corrected.geometry, original.geometry);
  for (const key of ['class_labels', 'probabilities', 'image']) assert.deepEqual(corrected.arrays[key], original.arrays[key], `Correction changed immutable ${key}`);
  assert.notDeepEqual(corrected.arrays.labels, original.arrays.labels);
  const correctedRecord = await execute('result', { result_id: corrected.id });
  assert.equal(correctedRecord.result.parent_id, original.id);
  assert.deepEqual(correctedRecord.provenance.tissue_model?.receipt?.inference, originalRecord.provenance.tissue_model.receipt.inference, 'Correction lost model/runtime provenance');
  receipt.correction_provenance = { keys: Object.keys(correctedRecord.provenance), correction: correctedRecord.provenance.correction ?? correctedRecord.provenance.edit ?? null };
  assert.ok(correctedRecord.provenance.correction ?? correctedRecord.provenance.corrections ?? correctedRecord.provenance.edit ?? correctedRecord.provenance.edits, 'Correction ancestry/history missing from retained provenance');
  const postOriginal = await execute('result', { result_id: original.id });
  assert.deepEqual(postOriginal.result, originalRecord.result, 'Original result revision changed after correction');
  assert.equal(postOriginal.result.review ?? null, null);
  receipt.measurements = { original: originalRecord.measurements, corrected: correctedRecord.measurements };
  receipt.correction_numerical = await pythonCheck(String.raw`
a=arrays_of(c['project'], c['original']); b=arrays_of(c['project'], c['corrected'])
for key in ('class_labels','probabilities','image'):
  assert a[key].tobytes()==b[key].tobytes(), key
old, new = a['labels'], b['labels']
assert old.shape==new.shape and old.dtype==new.dtype
changed = old!=new
assert changed.any(), 'Correction changed no pixel'
assert np.all(new[changed]==0) and np.all(old[changed]==c['label']), 'Erase must only remove the target label'
assert np.count_nonzero(new==c['label'])==np.count_nonzero(old==c['label'])-np.count_nonzero(changed)
assert np.count_nonzero(new==c['label'])>0, 'Correction removed the entire region; measurements would not be retained'
np.testing.assert_array_equal(new>0, (new==c['label'])|((old>0)&~changed))
print(json.dumps({'changed_pixels': int(changed.sum()), 'original_region_pixels': int((old==c['label']).sum()), 'corrected_region_pixels': int((new==c['label']).sum()), 'immutable_prediction_arrays_identical': True}))
`, { name: 'correction', project: study, original, corrected, label });
  receipt.corrected_views = await verifyViews(study, corrected, 'corrected');
  assert.equal(correctedRecord.measurements.length, originalRecord.measurements.length);
  assert.notDeepEqual(correctedRecord.measurements, originalRecord.measurements, 'Revised measurements were not retained');
  receipt.checks.push('packaged-correction-immutable-prediction-arrays-ancestry-unreviewed-original-unchanged-revised-measurements');

  // 3. Scientific export enforces exact-revision review and source identity.
  await exportTo(exports.refused);
  const unreviewed = await attempt('exportResult', [corrected.id, corrected.revision_hash]);
  receipt.export_unreviewed = unreviewed; assert.equal(unreviewed.ok, false, 'Unreviewed corrected revision exported');
  assert.equal(await exists(exports.refused), false, 'Refused export left a destination');
  const wrongRevision = await attempt('reviewResult', [corrected.id, original.revision_hash, 'reviewed']);
  assert.equal(wrongRevision.ok, false, 'Review accepted a mismatched revision'); receipt.review_wrong_revision = wrongRevision;
  await page.evaluate(([id, revision]) => window.lociResearch.reviewResult(id, revision, 'reviewed'), [corrected.id, corrected.revision_hash]);
  await wait(snapshot, value => value.results.find(item => item.id === corrected.id)?.review?.disposition === 'reviewed', 'automated QA review of exact corrected revision');
  assert.equal((await snapshot()).results.find(item => item.id === original.id).review ?? null, null, 'Correction review leaked to the original');
  await fs.rename(source, offlineSource);
  await exportTo(exports.sourceOffline);
  const offline = await attempt('exportResult', [corrected.id, corrected.revision_hash]);
  receipt.export_source_offline = offline; assert.equal(offline.ok, false, 'Export succeeded without the verifiable source');
  assert.equal(await exists(exports.sourceOffline), false, 'Source-identity failure left a destination');
  await fs.rename(offlineSource, source); assert.equal(await sha(source), SOURCE);
  await exportTo(exports.corrected);
  const exportedCorrected = await attempt('exportResult', [corrected.id, corrected.revision_hash]);
  assert.equal(exportedCorrected.ok, true, JSON.stringify(exportedCorrected));
  const exportRecord = await json(path.join(exports.corrected, 'result.json'));
  assert.equal(exportRecord.result.id, corrected.id); assert.equal(exportRecord.result.revision_hash, corrected.revision_hash);
  for (const [key, descriptor] of Object.entries(corrected.arrays)) assert.equal(await sha(path.join(exports.corrected, key + '.npy')), descriptor.sha256);
  receipt.export_manifest_sha256 = await sha(path.join(exports.corrected, 'manifest.json'));
  receipt.checks.push('exact-revision-review-gates-export-source-identity-enforced-atomic-no-partial-destination');
  await page.evaluate(([id, revision]) => window.lociResearch.reviewResult(id, revision, 'reviewed'), [original.id, original.revision_hash]);
  await wait(snapshot, value => value.results.find(item => item.id === original.id)?.review?.disposition === 'reviewed', 'automated QA review of original');
  const finalSnapshot = await snapshot(); receipt.snapshot_before_portable = finalSnapshot;

  // 4. Portable export and import through the real archive handlers (picker simulated).
  const portable = await attempt('exportStudy', []); assert.equal(portable.ok, true, JSON.stringify(portable));
  assert.ok((await fs.stat(archive)).size > 0); receipt.portable_sha256 = await sha(archive);
  const listing = (await exec('/usr/bin/unzip', ['-Z1', archive], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
  receipt.portable_entries = listing.length; assert.ok(!listing.some(name => /\.tiff?$/iu.test(name)), 'Portable archive embedded the raw source');
  const restoredSnapshot = await attempt('importStudy', []); assert.equal(restoredSnapshot.ok, true, JSON.stringify(restoredSnapshot));
  assert.ok(await exists(path.join(restored, 'artifacts')), 'Portable import did not create the requested study directory');
  await shot('01-portable-export-import'); await close();

  // 5. Cold restored reads: fresh profile, empty model store, raw source offline, no new jobs.
  await fs.rename(source, offlineSource);
  await launch(2);
  const cold = await openRestoredStudy();
  assert.equal(await exists(path.join(output, 'profile-2/models')), false, 'Fresh profile unexpectedly has a model store');
  assert.equal((await execute('tissue_model_profiles')).profiles[0].store.state, 'missing');
  const coldOriginal = cold.results.find(item => item.id === original.id), coldCorrected = cold.results.find(item => item.id === corrected.id);
  assert.ok(coldOriginal && coldCorrected, 'Restored study lost an original or corrected result');
  assert.equal(cold.results.length, 2); assert.equal(cold.jobs.length, finalSnapshot.jobs.length, 'Restore silently created or rerun a job');
  assert.deepEqual(coldOriginal.arrays, original.arrays); assert.deepEqual(coldCorrected.arrays, corrected.arrays);
  assert.equal(coldOriginal.revision_hash, original.revision_hash); assert.equal(coldCorrected.revision_hash, corrected.revision_hash);
  assert.equal(coldCorrected.parent_id, original.id);
  assert.equal(coldOriginal.review?.disposition, 'reviewed'); assert.equal(coldCorrected.review?.disposition, 'reviewed');
  assert.equal(coldCorrected.review.revision_hash ?? corrected.revision_hash, corrected.revision_hash);
  const coldOriginalRecord = await execute('result', { result_id: original.id }), coldCorrectedRecord = await execute('result', { result_id: corrected.id });
  assert.deepEqual(coldOriginalRecord.measurements, originalRecord.measurements); assert.deepEqual(coldCorrectedRecord.measurements, correctedRecord.measurements);
  assert.deepEqual(coldCorrectedRecord.provenance, correctedRecord.provenance); assert.deepEqual(coldOriginalRecord.provenance, originalRecord.provenance);
  assert.deepEqual(coldCorrected.geometry, corrected.geometry); assert.deepEqual(coldOriginal.geometry, original.geometry);
  receipt.cold_original = await verifyViews(restored, coldOriginal, 'restored-original');
  receipt.cold_corrected = await verifyViews(restored, coldCorrected, 'restored-corrected');
  assert.deepEqual(receipt.cold_original.arrays, receipt.original_views.arrays); assert.deepEqual(receipt.cold_corrected.arrays, receipt.corrected_views.arrays);
  await shot('02-restored-cold-without-model-or-source');
  assert.equal((await snapshot()).jobs.length, finalSnapshot.jobs.length); await close();
  await fs.rename(offlineSource, source);
  receipt.checks.push('portable-export-import-restored-arrays-revisions-measurements-provenance-review-match', 'cold-restored-reads-without-model-source-or-new-jobs-native-png-pixels');
  assert.deepEqual(await identity(), receipt.build); assert.equal(await sha(env.LOCI_QA_TISSUE_SOURCE), SOURCE); assert.equal(await sha(source), SOURCE);
  for (const [key, value] of Object.entries(receipt.inputs)) assert.equal(await sha(await fs.realpath(env[key])), value.sha256, `Input changed: ${key}`);
  assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(receipt.network_requests, []); assert.ok(!receipt.process_tracking_error);
  receipt.status = 'passed-packaged-correction-portable-engineering-qa-only';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.error = { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr };
  if (page) {
    await shot('failure').catch(() => {});
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach(d => { d.open = true; });
    }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
  }
} finally {
  await close().catch(error => { receipt.cleanup_error = error.message; receipt.status = 'failed'; failure ??= error; });
  receipt.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: receipt.status, output, error: receipt.error?.message }) + '\n');
}
if (failure) throw failure;
