/** Packaged tissue engineering QA. Existing public fixture/model only.
 * Required absolute env paths are listed in requiredPaths below. No downloads.
 * Native pickers are explicitly simulated; their real main/preload/worker routing
 * remains intact. Reviews are automated QA, never human/scientific approval.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { createEmptyStudy, fileMenuAction, selectWorkbenchTool, selectResultSection, setSelectionField } from './workbench-qa-helpers.mjs';

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
const output = await fs.mkdtemp(path.join(env.LOCI_QA_OUTPUT_ROOT, 'tissue-model-'));
const study = path.join(output, 'TRAINING004.loci-study'), source = path.join(output, 'TRAINING004.tif');
const exported = path.join(output, 'exported'), oracle = path.join(repo, 'scripts/qa/tissue_model_journey.py');
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const sha = async file => { assert.equal((await fs.lstat(file)).isFile(), true, `Expected plain file: ${file}`); const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable: await sha(executablePath), asar: await sha(path.join(bundle, 'Contents/Resources/app.asar')), worker: await sha(path.join(bundle, 'Contents/Resources/loci-engine/loci-engine')) });
const receipt = { schema: 'loci.tissue-model-packaged-qa/v1', status: 'running', output, source_commit: sourceCommit,
  started_at: new Date().toISOString(), scientific_qualification: 'not-established', human_review: false,
  scope: 'Packaged engineering QA; existing public TRAINING004 is not holdout; no accuracy or official CUDA parity claim.',
  limits: ['Class-4 epidermis does not establish a basal boundary; stroma is not automatically dermis.',
    'Softmax scores are uncalibrated; model grid spacing is not physical source calibration.',
    'Native picker selections are harness simulations; ordinary native CUA remains separate.',
    'Compartment correction and portable restore are covered by the separate source journey, not this harness.',
    'Cold reopen verifies retained routing with an empty model cache; it does not instrument source decoder imports.',
    'Working-memory policy is not a hard macOS RSS guarantee.'], checks: [], dialogs: [], screenshots: [], renderer_errors: [], network_requests: [], processes: [] };
let app, page, failure, processTimer, processScan = Promise.resolve();
const owned = new Map(), expectedCancelledJobs = new Set();
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
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
    const failed = state?.jobs.find(job => ['failed', 'cancelled', 'interrupted'].includes(job.state) &&
      !(job.state === 'cancelled' && expectedCancelledJobs.has(job.id)));
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
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const selected = { 'Open research study': values.study, 'Add microscopy or medical images': values.source,
        'Import exact PUMA network weights': values.weights, 'Select the exact PUMA conversion receipt': values.conversion }[title];
      if (!selected) throw new Error('Unexpected harness-simulated native open picker: ' + title);
      globalThis.__tissueQAPickerSimulation.push({ title, simulation: true });
      return { canceled: false, filePaths: [selected] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const filePath = { 'Create research study': values.study, 'Export reviewed result bundle': values.exported }[title];
      if (!filePath) throw new Error('Unexpected harness-simulated native save picker: ' + title);
      globalThis.__tissueQAPickerSimulation.push({ title, simulation: true });
      return { canceled: false, filePath };
    };
  }, { study, source, exported, weights: env.LOCI_QA_TISSUE_WEIGHTS, conversion: env.LOCI_QA_TISSUE_CONVERSION_RECEIPT });
  await page.waitForFunction(() => Boolean(window.lociResearch));
}
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
  // Worker EOF and process reaping can trail the Electron close event briefly.
  for (let attempt = 0; attempt < 15 && [...owned].some(([pid, start]) => rows.get(pid)?.start === start); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200)); rows = await table();
  }
  let remaining = [...owned].filter(([pid, start]) => rows.get(pid)?.start === start);
  const cleanup = { observed: [...owned].map(([pid, start]) => ({ pid, start })), survivors_after_quit: remaining.map(([pid]) => pid) };
  // Escalate only processes observed as descendants with matching start identity.
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
async function chooseResult(result) {
  await page.locator(`button[data-source-id="${result.source_id}"]`).click();
  await page.locator(`button[data-result-id="${result.id}"]`).click();
}
async function cancelActualPreview(panel) {
  assert.equal((await snapshot()).jobs.length, 0, 'Cancellation begins with no historical or competing jobs');
  await panel.getByRole('button', { name: 'Preview candidate mask', exact: true }).click();
  const observed = await wait(async () => {
    const state = await snapshot();
    assert.equal(state.results.length, 0);
    if (state.jobs.length === 0) return null; // Native submission is asynchronous.
    assert.equal(state.jobs.length, 1, 'Exactly one isolated preview job must identify the visible cancellation target');
    const job = state.jobs[0]; assert.equal(job.operation, 'tissue_model_preview');
    assert.ok(['queued', 'running'].includes(job.state), 'Preview completed before actual in-flight cancellation could be observed');
    await remember();
    const rows = await table();
    const candidates = [...rows].filter(([pid, row]) => pid === row.group &&
      owned.get(pid) === row.start && owned.has(row.parent) && owned.get(row.parent) === rows.get(row.parent)?.start);
    for (const [pid, row] of candidates) {
      let command;
      try { command = (await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 3000 })).stdout.trim(); }
      catch { continue; } // The next durable snapshot detects a completed task.
      if (!command.includes(`--job ${job.id} `) || !command.includes(`--project ${study} `) ||
          !new RegExp(`--supervisor-pid ${row.parent}(?:\\s|$)`, 'u').test(command)) continue;
      const current = await table();
      if (current.get(pid)?.start !== row.start || current.get(pid)?.parent !== row.parent) continue;
      const parent = current.get(row.parent);
      assert.equal(parent?.start, owned.get(row.parent), 'Supervised child parent identity changed');
      return { job_id: job.id, child: { pid, start: row.start, parent: row.parent, group: row.group, command },
        supervisor: { pid: row.parent, start: parent.start },
        observed_group: [...current].filter(([, value]) => value.group === row.group).map(([member, value]) => ({ pid: member, start: value.start })) };
    }
    return null;
  }, Boolean, 'actual supervised disposable preview child', 30000);
  receipt.cancellation = observed;
  await page.locator('button.workbench-jobs__trigger').click();
  const center = page.getByRole('region', { name: 'Job center', exact: true });
  const row = center.locator('li.workbench-jobs__row').filter({ has: page.getByText('tissue model preview', { exact: true }) });
  await row.waitFor({ state: 'visible' });
  assert.equal(await row.count(), 1, 'Visible native Job Center must expose exactly one tissue preview row');
  const live = await snapshot();
  assert.deepEqual(live.jobs.filter(job => ['queued', 'running'].includes(job.state)).map(job => job.id), [observed.job_id]);
  assert.equal(live.jobs.length, 1); assert.equal(live.results.length, 0);
  // Only this exact intentionally cancelled job is exempt from later failure scans.
  expectedCancelledJobs.add(observed.job_id);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  const cancelled = await wait(snapshot, state => state?.jobs.find(job => job.id === observed.job_id)?.state === 'cancelled', 'native in-flight preview cancellation', 30000);
  const job = cancelled.jobs.find(job => job.id === observed.job_id);
  assert.equal(job.cancel_requested, true); assert.deepEqual(job.result_ids, []); assert.equal(cancelled.results.length, 0);
  await wait(async () => {
    const rows = await table();
    return observed.observed_group.filter(member => rows.get(member.pid)?.start === member.start);
  }, survivors => survivors.length === 0, 'cancelled supervised child process exit', 30000);
  observed.cancelled_job = job; observed.surviving_observed_inference_processes = [];
  await shot('02-native-inflight-cancelled');
  await center.getByRole('button', { name: 'Close Job Center', exact: true }).click();
  await wait(() => panel.getByRole('button', { name: 'Preview candidate mask', exact: true }).isEnabled(), Boolean, 'preview UI recovered after native cancellation', 30000);
  assert.equal(await panel.getByRole('img', { name: 'Exact source-region preview with candidate epidermis overlay', exact: true }).count(), 0);
  receipt.checks.push('actual-supervised-child-observed-before-visible-native-job-cancel-no-result-no-child-survivors');
}
async function verifyResult(result, name) {
  const record = await execute('result', { result_id: result.id });
  assert.equal(record.result.id, result.id); assert.equal(record.result.revision_hash, result.revision_hash);
  assert.deepEqual(result.selection, region); assert.equal(result.source_sha256, SOURCE);
  assert.equal(result.geometry.axes, 'YX'); assert.equal(result.geometry.unit, 'pixel');
  assert.deepEqual(result.geometry.affine, [[1, 0, 0, 960], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  assert.ok(record.measurements.every(row => JSON.stringify(row.intensity) === '{}'));
  const inference = record.provenance.tissue_model.receipt.inference;
  const reference = (await json(env.LOCI_QA_TISSUE_REFERENCE_RECEIPT)).backend;
  for (const key of ['request', 'decoding', 'preprocessing', 'tiles']) assert.deepEqual(inference[key], reference[key], `Reference applicability: ${key}`);
  const views = [];
  for (const field of ['tissue_classes', 'compartments', 'epidermis_score']) {
    const request = { result_id: result.id, display: { low: 0, high: 1, gamma: 1, color: '#ffffff' } };
    if (field === 'epidermis_score') request.labels = false;
    else if (field === 'tissue_classes') request.label_field = field;
    const view = await execute('result_view', request);
    assert.equal(view.result_id, result.id); assert.equal(view.revision_hash, result.revision_hash);
    assert.equal(view.field, field); assert.ok(view.basis); assert.deepEqual(view.shape, [64, 64]);
    views.push({ request, view });
  }
  const config = path.join(output, name + '-oracle.json');
  await fs.writeFile(config, JSON.stringify({ oracle, study, result, reference, views,
    references: { class_labels: env.LOCI_QA_TISSUE_REFERENCE_CLASSES, probabilities: env.LOCI_QA_TISSUE_REFERENCE_PROBABILITIES },
    views_output: path.join(output, name + '-views') }));
  const verifier = String.raw`
import hashlib, importlib.util, json, pathlib, sys
import numpy as np
c=json.loads(pathlib.Path(sys.argv[1]).read_text())
spec=importlib.util.spec_from_file_location('frozen_tissue_oracle', c['oracle'])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
arrays={}
assert set(c['result']['arrays']) == {'labels','image','class_labels','probabilities'}
for key,d in c['result']['arrays'].items():
 p=pathlib.Path(c['study'])/'artifacts'/(d['sha256']+'.npy')
 assert m.digest(p)==d['sha256']
 arrays[key]=m.load_array(p)
 assert list(arrays[key].shape)==d['shape'] and str(arrays[key].dtype)==d['dtype']
checks={}
for key,p in c['references'].items():
 expected=m.load_array(pathlib.Path(p),c['reference']['artifacts'][key])
 assert hashlib.sha256(expected.tobytes()).hexdigest()==m.REFERENCE_ARRAYS[key]
 actual=arrays[key]
 assert actual.dtype==expected.dtype and actual.shape==expected.shape and actual.tobytes()==expected.tobytes()
 checks[key]={'bitwise_equal':True,'raw_sha256':hashlib.sha256(actual.tobytes()).hexdigest(),'reference_file_sha256':m.digest(pathlib.Path(p))}
assert arrays['image'].tobytes()==arrays['probabilities'][4].tobytes()
np.testing.assert_array_equal(arrays['labels']>0,arrays['class_labels']==4)
out=pathlib.Path(c['views_output']);out.mkdir()
def call(operation,request):
 assert operation=='result_view'
 matches=[item['view'] for item in c['views'] if item['request']==request]
 assert len(matches)==1
 return matches[0]
m.check_views(call,c['result'],arrays,out,'retained')
print(json.dumps({'arrays':checks,'native_png_pixels_equal':True}))
`;
  const verified = await exec(python, ['-I', '-c', verifier, config], { timeout: 30000, maxBuffer: 1024 * 1024 });
  return { record, numerical: JSON.parse(verified.stdout), views: views.map(({ view }) => ({ field: view.field, basis: view.basis, revision_hash: view.revision_hash })) };
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
  const reference = (await json(env.LOCI_QA_TISSUE_REFERENCE_RECEIPT)).backend;
  assert.deepEqual(reference.request.context_selection, context); assert.deepEqual(reference.request.output_selection, region);
  assert.equal(reference.request.source_sha256, SOURCE);
  await fs.copyFile(env.LOCI_QA_TISSUE_SOURCE, source); assert.equal(await sha(source), SOURCE);
  await launch(1); await createEmptyStudy(page);
  // Study creation is asynchronous: wait for the header action instead of racing into the File menu.
  await page.getByRole('button', { name: 'Add images…', exact: true }).filter({ visible: true }).first().waitFor();
  await fileMenuAction(page, 'Add images…');
  const imported = await wait(snapshot, value => value?.sources.length === 1, 'native public source import');
  const sourceRecord = imported.sources[0]; assert.equal(sourceRecord.sha256, SOURCE);
  assert.equal(sourceRecord.source_kind, 'native'); assert.equal(sourceRecord.metadata.sample_semantics, 'RGBA');
  assert.deepEqual(sourceRecord.metadata.channel_dtypes, ['uint8']);
  assert.equal(sourceRecord.metadata.dimensions.x, 1024); assert.equal(sourceRecord.metadata.dimensions.y, 1024);
  await page.locator(`button[data-source-id="${sourceRecord.id}"]`).click();
  await selectWorkbenchTool(page, 'Display');
  for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['C', 'c']]) await setSelectionField(page, label, region[key]);
  await tissueTool();
  let panel = page.getByRole('region', { name: 'Epidermis tissue model', exact: true });
  await panel.getByText('Exact model files not imported', { exact: true }).waitFor();
  const initial = await execute('tissue_model_profiles'); receipt.profiles_before_import = initial;
  assert.equal(initial.profiles.length, 1); assert.equal(initial.profiles[0].store.state, 'missing');
  assert.equal(await panel.getByRole('button', { name: 'Preview candidate mask', exact: true }).isEnabled(), false);
  await panel.getByLabel('Tissue preparation', { exact: true }).selectOption('hematoxylin-eosin');
  assert.equal(await panel.getByRole('button', { name: 'Preview candidate mask', exact: true }).isEnabled(), false);
  const profile = initial.profiles[0].profile;
  assert.equal(profile.contract_sha256, reference.profile.contract_sha256);
  assert.equal(await sha(env.LOCI_QA_TISSUE_WEIGHTS), profile.model.sha256);
  assert.equal(await sha(env.LOCI_QA_TISSUE_CONVERSION_RECEIPT), profile.model.conversion_receipt_sha256);
  await shot('01-unavailable-explicit-preparation');
  await panel.getByRole('button', { name: 'Import weights & receipt…', exact: true }).click();
  await wait(() => execute('tissue_model_profiles'), value => value.profiles[0].store.provisioned, 'native exact two-file import');
  await wait(() => panel.getByRole('button', { name: 'Import weights & receipt…', exact: true }).isEnabled(), Boolean, 'native import UI settled');
  const ready = await execute('tissue_model_profiles'); receipt.profiles_after_import = ready;
  assert.ok(['verified', 'provisioned-unverified'].includes(ready.profiles[0].store.state));
  assert.equal(ready.profiles[0].runtime.status, 'metadata-matches-unverified', 'Packaged exact optional runtime unavailable; inference must remain disabled');
  await panel.getByText('Full native image · 1024 × 1024 pixels', { exact: true }).waitFor();
  await panel.getByText('64 × 64 pixels at x 960, y 0', { exact: true }).waitFor();
  assert.equal((await snapshot()).results.length, 0);
  await cancelActualPreview(panel);
  await panel.getByRole('button', { name: 'Preview candidate mask', exact: true }).click();
  await panel.getByRole('img', { name: 'Exact source-region preview with candidate epidermis overlay', exact: true }).waitFor({ timeout: 180000 });
  const previewState = await snapshot(); assert.equal(previewState.results.length, 0);
  const preview = previewState.jobs.find(job => job.operation === 'tissue_model_preview' && job.state === 'succeeded');
  assert.equal(preview.state, 'succeeded'); assert.deepEqual(preview.result_ids, []);
  assert.deepEqual(preview.request.task_request.context_selection, context); assert.deepEqual(preview.request.task_request.output_selection, region);
  assert.equal(preview.request.task_request.declared_stain, 'hematoxylin-eosin');
  await shot('02-disposable-preview');
  await panel.getByRole('button', { name: 'Create result from preview', exact: true }).click();
  const adopted = await wait(snapshot, value => value?.results.length === 1, 'durable exact preview adoption');
  const result = adopted.results[0]; receipt.result = result;
  assert.equal(result.kind, 'tissue-model-regions'); assert.equal(result.tissue_model.label_semantics, 'original_selected_compartment');
  const run = adopted.jobs.find(job => job.operation === 'tissue_model_run'); assert.equal(run.state, 'succeeded'); assert.deepEqual(run.result_ids, [result.id]);
  assert.deepEqual(run.request.task_request, result.tissue_model.preview);
  receipt.original = await verifyResult(result, 'original');
  await chooseResult(result); await tissueTool();
  for (const [mode, title] of [['compartments', 'Original epidermis regions'], ['tissue_classes', 'Original tissue classes'], ['score', 'Original epidermis score']]) {
    await panel.getByLabel('Tissue result field', { exact: true }).selectOption(mode);
    await panel.getByRole('button', { name: 'Inspect saved field', exact: true }).click();
    await panel.getByRole('img', { name: title, exact: true }).waitFor(); await shot('03-field-' + mode);
  }
  receipt.checks.push('native-source-import-and-exact-RGBA-fingerprint', 'empty-isolated-model-store-and-explicit-two-file-native-import',
    'declared-HE-and-full1024-context-exact64-output-ROI', 'disposable-preview-and-durable-adoption-native-jobs', 'bitwise-same-engine-arrays-and-independent-native-PNG-pixels', 'visible-retained-fields-and-exact-view-identity');
  await panel.getByRole('button', { name: 'Review & export', exact: true }).click();
  await selectWorkbenchTool(page, 'Info'); await selectResultSection(page, 'Review');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await wait(snapshot, value => value.results.find(item => item.id === result.id)?.review?.disposition === 'reviewed', 'automated QA review transition');
  await selectResultSection(page, 'Export'); await page.getByRole('button', { name: 'Export result', exact: true }).click();
  await wait(async () => { try { return await json(path.join(exported, 'manifest.json')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, Boolean, 'atomic native export');
  const exportRecord = await json(path.join(exported, 'result.json'));
  assert.equal(exportRecord.result.id, result.id); assert.equal(exportRecord.result.revision_hash, result.revision_hash);
  for (const [key, descriptor] of Object.entries(result.arrays)) assert.equal(await sha(path.join(exported, key + '.npy')), descriptor.sha256);
  receipt.export_manifest_sha256 = await sha(path.join(exported, 'manifest.json'));
  await shot('04-automated-review-export'); await close();
  await launch(2); await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await wait(snapshot, value => value?.results.some(item => item.id === result.id), 'fresh-profile retained study');
  assert.equal((await execute('tissue_model_profiles')).profiles[0].store.state, 'missing');
  const cold = (await snapshot()).results.find(item => item.id === result.id);
  assert.deepEqual(cold.arrays, result.arrays); assert.equal(cold.revision_hash, result.revision_hash);
  await chooseResult(cold); await tissueTool();
  panel = page.getByRole('region', { name: 'Epidermis tissue model', exact: true });
  await panel.getByLabel('Tissue result field', { exact: true }).selectOption('score');
  await panel.getByRole('button', { name: 'Inspect saved field', exact: true }).click();
  await panel.getByRole('img', { name: 'Original epidermis score', exact: true }).waitFor();
  receipt.cold = await verifyResult(cold, 'cold');
  assert.equal((await snapshot()).jobs.length, adopted.jobs.length);
  await shot('05-fresh-profile-retained-without-model'); await close();
  receipt.checks.push('automated-review-native-export-exact-retained-NPY-hashes', 'fresh-profile-cold-reopen-empty-model-cache-no-new-jobs');
  assert.deepEqual(await identity(), receipt.build); assert.equal(await sha(env.LOCI_QA_TISSUE_SOURCE), SOURCE);
  for (const [key, value] of Object.entries(receipt.inputs)) assert.equal(await sha(await fs.realpath(env[key])), value.sha256, `Input changed: ${key}`);
  assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(receipt.network_requests, []); assert.ok(!receipt.process_tracking_error);
  assert.deepEqual(receipt.dialogs.filter(item => item.title.includes('PUMA')).map(item => item.title), ['Import exact PUMA network weights', 'Select the exact PUMA conversion receipt']);
  receipt.status = 'passed-packaged-engineering-qa-only';
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
